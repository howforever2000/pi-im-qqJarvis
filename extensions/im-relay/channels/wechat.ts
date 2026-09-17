/**
 * 微信通道（iLink / ClawBot，个人微信号扫码登录）。
 *
 * 网络模型：本进程出站 HTTPS 长轮询 → 腾讯 iLink 云。不监听端口、不需要公网。
 * 平台约束（腾讯官方条款）：
 *   - 凭据约 24h 过期，需要重新扫码；
 *   - 用户发消息后 24h 内最多主动发 10 条（含回复），因此默认只回最终结果；
 *   - 回复必须携带最近一条入站消息的 context_token。
 */
import fs from "node:fs";
import { createLogger, errorText } from "../log.ts";
import { WECHAT_SESSION_FILE, readJsonFile, writeJsonFile, type WechatConfig } from "../config.ts";
import { segmentText } from "../text.ts";
import { renderQr, type QrRender } from "../qr.ts";
import {
  fetchQrChallenge,
  getUpdates,
  isSessionExpired,
  parseInbound,
  messageKey as ilinkMessageKey,
  notifyLifecycle,
  pollQrStatus,
  redirectBaseUrl,
  sendTextMessage,
  downloadImage,
  isAbort,
} from "./ilink-client.ts";
import {
  ILINK_DEFAULT_BASE,
  type WechatCredential,
  type WeixinMessage,
} from "./ilink-types.ts";
import {
  ChannelError,
  type Channel,
  type ChannelHooks,
  type ChannelStatus,
  type ChatTarget,
  type InboundMessage,
} from "./types.ts";

const log = createLogger("wechat");

/** 提前 1 小时判过期，留出重扫缓冲。 */
const SESSION_TTL_MS = 23 * 60 * 60 * 1000;
/** 首次长轮询超时；服务端会在响应里给 longpolling_timeout_ms，之后以它为准。 */
const DEFAULT_LONGPOLL_TIMEOUT_MS = 45_000;
/** 服务端建议值也做个夹紧，避免拿到异常值时卡死或空转。 */
const MIN_LONGPOLL_TIMEOUT_MS = 5_000;
const MAX_LONGPOLL_TIMEOUT_MS = 70_000;
/** 轮询迭代的最小间隔，避免服务端立即返回时变成空转热循环。 */
const MIN_LOOP_INTERVAL_MS = 250;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DAILY_PROACTIVE_LIMIT = 10;
/**
 * 二维码可复用的时间窗。
 * 这期间再次触发登录只会重发同一个码，不会向腾讯申请新的 ——
 * 否则用户重复触发会得到两张码，不知道扫哪张。
 */
const QR_REUSE_WINDOW_MS = 120_000;

interface WechatState {
  version: 1;
  credential: WechatCredential | null;
  contextTokens: Record<string, string>;
  /** 每个用户最近 24h 已发出的消息数（腾讯风控额度） */
  outboundCounts: Record<string, { count: number; since: number }>;
}

interface WechatRoute {
  userId: string;
}

export class WechatChannel implements Channel {
  readonly id = "wechat" as const;
  readonly name = "微信";

  private state: WechatState = { version: 1, credential: null, contextTokens: {}, outboundCounts: {} };
  private channelState: ChannelStatus["state"] = "off";
  private detail: string | undefined;
  private qr: QrRender | undefined;
  private lastInboundAt: number | undefined;
  private lastInboundMessage: WeixinMessage | undefined;

  private running = false;
  private loopPromise: Promise<void> | undefined;
  private loginController: AbortController | undefined;
  /** 正在进行的扫码确认流程（beginLogin 启动、waitForLogin 等待） */
  private loginLoop: Promise<void> | undefined;
  /** 当前二维码的签发时间，用于判断能不能复用 */
  private qrIssuedAt = 0;
  private pendingVerifyCode: string | undefined;
  private readonly dedupe = new Set<string>();

  private readonly config: WechatConfig;
  private readonly hooks: ChannelHooks;
  private readonly maxReplyChars: number;

  constructor(config: WechatConfig, hooks: ChannelHooks, maxReplyChars: number) {
    this.config = config;
    this.hooks = hooks;
    this.maxReplyChars = maxReplyChars;
  }

  status(): ChannelStatus {
    return {
      id: this.id,
      name: this.name,
      state: this.channelState,
      detail: this.detail,
      qrAscii: this.qr?.ascii,
      qrImage: this.qr ? { mimeType: this.qr.image.mimeType, base64: this.qr.image.base64, size: this.qr.image.size } : undefined,
      qrText: this.qr?.text,
      lastInboundAt: this.lastInboundAt,
    };
  }

  /** 登录二维码（供 UI 按自己的渲染能力选择图片或 ASCII）。 */
  loginQr(): QrRender | undefined {
    return this.qr;
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.setState("off", "配置中已禁用");
      return;
    }
    this.loadState();
    const credential = this.state.credential;
    if (!credential) {
      this.setState("needs-login", "尚未登录，在 pi 里执行 /im login 扫码绑定微信");
      return;
    }
    if (this.isExpired(credential)) {
      this.setState("needs-login", "登录凭据已过期（约 24h），执行 /im login 重新扫码");
      return;
    }
    this.running = true;
    this.setState("connecting", "正在建立微信长轮询 …");
    try {
      await notifyLifecycle(credential, "start");
    } catch (error) {
      log.debug(`notifystart 失败（忽略）: ${errorText(error)}`);
    }
    this.loopPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.loginController?.abort();
    const credential = this.state.credential;
    if (credential) {
      notifyLifecycle(credential, "stop").catch(() => undefined);
    }
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = undefined;
    this.setState("off", "已停止");
  }

  private setState(state: ChannelStatus["state"], detail?: string): void {
    if (this.channelState === state && this.detail === detail) return;
    this.channelState = state;
    this.detail = detail;
    this.hooks.onStatusChange(this.status());
  }

  private isExpired(credential: WechatCredential): boolean {
    return Date.now() - credential.savedAt > SESSION_TTL_MS;
  }

  /* ---------------------------- 状态持久化 ---------------------------- */

  private loadState(): void {
    const parsed = readJsonFile<WechatState>(WECHAT_SESSION_FILE);
    if (parsed && parsed.version === 1) {
      this.state = {
        version: 1,
        credential: parsed.credential ?? null,
        contextTokens: parsed.contextTokens ?? {},
        outboundCounts: parsed.outboundCounts ?? {},
      };
    }
  }

  private saveState(): void {
    try {
      writeJsonFile(WECHAT_SESSION_FILE, this.state);
    } catch (error) {
      log.warn(`保存微信状态失败: ${errorText(error)}`);
    }
  }

  /* ---------------------------- 扫码登录 ---------------------------- */

  /**
   * 申请二维码并开始等待用户确认。
   *
   * 返回时不保证已经出码 —— 调用方若要在回复里说“二维码已发给你”，
   * 应该用 awaitLoginQr()；这个方法是“发起”，等待确认由 waitForLogin() 负责。
   *
   * 拆成两段的原因：真的被重复触发坑过 —— 用户一边敲 `/im login wechat`
   * 一边说“登录微信”，两次调用各自向腾讯申请一张码，界面上就出现两张二维码，
   * 用户不知道该扫哪一张。所以：已有新鲜二维码时只重发，不再申请。
   */
  async beginLogin(): Promise<void> {
    if (!this.config.enabled) throw new ChannelError("微信通道在配置中被禁用");

    if (this.loginActive()) {
      log.info("已有进行中的登录二维码，直接复用（不重复申请）");
      this.reissueQr();
      return;
    }

    this.loginController?.abort();
    const controller = new AbortController();
    this.loginController = controller;

    const currentBase = (this.config.baseUrl || ILINK_DEFAULT_BASE).replace(/\/+$/, "");
    const existingTokens = this.state.credential?.token ? [this.state.credential.token] : [];
    this.qr = undefined;
    this.setState("connecting", "正在向微信申请登录二维码 …");

    // 先把码拿到手再返回：这样调用方回复“二维码已发给你”时它真的已经发出去了
    const challenge = await fetchQrChallenge(currentBase, existingTokens, controller.signal);
    this.publishQr(challenge.url);

    const loop = this.pollForConfirmation(controller, currentBase, challenge, existingTokens);
    this.loginLoop = loop;
    // 挂一个空 catch，避免没人 await 时变成 unhandled rejection
    loop.catch(() => undefined).finally(() => {
      if (this.loginLoop === loop) this.loginLoop = undefined;
    });
  }

  /** 等待当前登录流程结束（扫码确认 / 超时 / 失败）。 */
  async waitForLogin(): Promise<void> {
    await this.loginLoop?.catch(() => undefined);
  }

  /** 是否已有可复用的登录二维码。 */
  loginActive(maxAgeMs = QR_REUSE_WINDOW_MS): boolean {
    return Boolean(this.loginLoop && this.qr && Date.now() - this.qrIssuedAt < maxAgeMs);
  }

  /** 把当前二维码重发一次（不向腾讯申请新的）。 */
  reissueQr(): boolean {
    if (!this.qr) return false;
    this.hooks.onLoginQr?.({ channel: this.id, qr: this.qr });
    return true;
  }

  /** Channel 接口要求的 login()：发起 + 等待。 */
  async login(): Promise<void> {
    await this.beginLogin();
    await this.waitForLogin();
  }

  /** 二维码状态轮询：wait → scaned → (need_verifycode) → confirmed / expired。 */
  private async pollForConfirmation(
    controller: AbortController,
    initialBase: string,
    initialChallenge: { id: string; url: string },
    existingTokens: string[],
  ): Promise<void> {
    let currentBase = initialBase;
    let challenge = initialChallenge;
    const deadline = Date.now() + 5 * 60 * 1000;
    let scanned = false;
    let refreshes = 0;

    while (!controller.signal.aborted && Date.now() < deadline) {
      let response;
      try {
        response = await pollQrStatus(
          currentBase,
          challenge.id,
          this.pendingVerifyCode,
          35_000,
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) break;
        if (isAbort(error)) continue;
        log.debug(`二维码状态查询失败，重试: ${errorText(error)}`);
        await sleep(1500);
        continue;
      }

      const status = response.status ?? "wait";
      switch (status) {
        case "wait":
          this.setState("connecting", "等待用手机微信扫描二维码 …");
          break;
        case "scaned":
          this.pendingVerifyCode = undefined;
          if (!scanned) {
            scanned = true;
            this.setState("connecting", "二维码已扫描，请在手机上确认登录");
          }
          break;
        case "need_verifycode": {
          const code = await this.hooks.onPrompt?.(
            this.pendingVerifyCode ? "配对码不正确，请重新输入手机微信显示的数字：" : "请输入手机微信显示的数字配对码：",
          );
          if (!code?.trim()) {
            this.setState("error", "未提供配对码，登录中止");
            return;
          }
          this.pendingVerifyCode = code.trim();
          continue;
        }
        case "scaned_but_redirect":
          currentBase = redirectBaseUrl(response.redirect_host);
          log.info(`已切换到微信分配的节点 ${currentBase}`);
          break;
        case "expired":
        case "verify_code_blocked": {
          refreshes += 1;
          if (refreshes >= 3) throw new ChannelError("二维码多次失效或配对码多次错误，请稍后重试");
          this.pendingVerifyCode = undefined;
          scanned = false;
          // 旧码已废，这才是真正需要新码的情况
          challenge = await fetchQrChallenge(currentBase, existingTokens, controller.signal);
          this.publishQr(challenge.url);
          break;
        }
        case "binded_redirect":
          throw new ChannelError(
            "这个微信已绑定其它本地实例。请先在微信里解除旧连接（或停掉另一台机器上的 pi），再重新扫码。",
          );
        case "confirmed": {
          const token = response.bot_token?.trim();
          const accountId = response.ilink_bot_id?.trim();
          if (!token || !accountId) throw new ChannelError("微信已确认，但服务端没有返回完整凭据");
          const credential: WechatCredential = {
            token,
            accountId,
            baseUrl: (response.baseurl?.trim() || currentBase).replace(/\/+$/, ""),
            userId: response.ilink_user_id?.trim(),
            savedAt: Date.now(),
            cursor: "",
          };
          this.state.credential = credential;
          this.state.contextTokens = {};
          this.saveState();
          this.qr = undefined;
          log.info(`微信登录成功 accountId=${accountId} userId=${credential.userId ?? "(未知)"}`);
          await this.start();
          return;
        }
        default:
          this.setState("error", `二维码服务返回未知状态：${status}`);
          return;
      }
      await sleep(1200);
    }

    if (!controller.signal.aborted) {
      throw new ChannelError("扫码登录超时（5 分钟），请重新发起登录");
    }
  }

  /**
   * 新的二维码就绪：交给上层按界面能力投递（图片 / 终端 ASCII）。
   * 同时落一份文本到磁盘，方便在图片不可用的环境下拷贝链接。
   */
  private publishQr(url: string): void {
    let rendered: QrRender | undefined;
    try {
      rendered = renderQr(url, 8, 3);
    } catch (error) {
      log.warn(`二维码生成失败: ${errorText(error)}`);
    }
    this.qr = rendered;
    this.qrIssuedAt = Date.now();

    const file = `${WECHAT_SESSION_FILE}.qrcode.txt`;
    try {
      fs.writeFileSync(
        file,
        [`微信登录二维码链接（请勿转发）：`, url, "", rendered?.ascii ?? "(二维码渲染失败，请直接使用上面的链接)", ""].join("\n"),
        { mode: 0o600 },
      );
    } catch {
      /* 写盘失败不影响主流程 */
    }

    // 先投递给界面，再改状态：
    // 否则 onStatusChange 里可能因为 lastQr 还没设置而重复投递同一张二维码。
    if (rendered) {
      this.hooks.onLoginQr?.({ channel: this.id, qr: rendered });
    } else {
      this.hooks.onLoginQrFallback?.(url);
    }
    this.setState("needs-login", "等待手机微信扫码确认");
  }

  /* ---------------------------- 长轮询 ---------------------------- */

  private async pollLoop(): Promise<void> {
    let failures = 0;
    // 服务端建议的长轮询超时（官方协议：响应里的 longpolling_timeout_ms）
    let longpollTimeoutMs = DEFAULT_LONGPOLL_TIMEOUT_MS;
    while (this.running) {
      const credential = this.state.credential;
      if (!credential) break;
      if (this.isExpired(credential)) {
        this.running = false;
        this.setState("needs-login", "登录凭据已过期（约 24h），执行 /im login 重新扫码");
        break;
      }

      const iterationStartedAt = Date.now();
      let response;
      try {
        response = await getUpdates(credential, credential.cursor ?? "", longpollTimeoutMs);
        failures = 0;
      } catch (error) {
        if (!this.running) break;
        // 凭据真的废了：不能当普通错误重试，否则会永远重连却永远收不到消息
        if (isSessionExpired(error)) {
          this.running = false;
          this.setState(
            "needs-login",
            `微信登录已过期（iLink errcode ${error.errcode}），执行 /im login 重新扫码`,
          );
          log.info(`微信会话已过期（errcode=${error.errcode}），需要重新扫码`);
          break;
        }
        failures += 1;
        if (isAbort(error)) continue;
        const message = errorText(error);
        log.warn(`getupdates 失败（第 ${failures} 次）: ${message}`);
        this.setState(
          failures >= 3 ? "error" : "connecting",
          `收消息失败，正在重试：${message.slice(0, 120)}`,
        );
        await sleep(Math.min(1000 * failures, 8000));
        continue;
      }

      if (this.channelState !== "online") this.setState("online", `已连接 iLink（${credential.accountId}）`);

      const suggested = response.longpolling_timeout_ms;
      if (typeof suggested === "number" && Number.isFinite(suggested) && suggested > 0) {
        longpollTimeoutMs = Math.min(Math.max(suggested + 5_000, MIN_LONGPOLL_TIMEOUT_MS), MAX_LONGPOLL_TIMEOUT_MS);
      }

      const nextCursor = response.get_updates_buf;
      if (nextCursor && nextCursor !== credential.cursor) {
        credential.cursor = nextCursor;
        this.saveState();
      }

      for (const message of response.msgs ?? []) {
        await this.handleMessage(message).catch((error) => {
          log.warn(`处理微信消息失败: ${errorText(error)}`);
        });
      }

      // 下限节流：正常情况服务端会 hold 十几到几十秒，但万一它立即返回
      // （比如异常响应），没有这个下限就会变成空转热循环。
      const elapsed = Date.now() - iterationStartedAt;
      if (elapsed < MIN_LOOP_INTERVAL_MS) await sleep(MIN_LOOP_INTERVAL_MS - elapsed);
    }
  }

  private async handleMessage(message: WeixinMessage): Promise<void> {
    // 只处理用户发来的消息（1=用户，2=机器人）
    if (message.message_type !== undefined && message.message_type !== 1) return;
    const fromUserId = message.from_user_id?.trim();
    if (!fromUserId) return;

    const key = ilinkMessageKey(message);
    if (this.dedupe.has(key)) return;
    this.dedupe.add(key);
    if (this.dedupe.size > 20_000) {
      const first = this.dedupe.values().next().value;
      if (first !== undefined) this.dedupe.delete(first);
    }

    // 记录 context_token：回复必须带上它
    if (message.context_token?.trim()) {
      this.state.contextTokens[fromUserId] = message.context_token.trim();
      this.saveState();
    }
    this.lastInboundMessage = message;

    const parsed = parseInbound(message);
    const images = await this.collectImages(parsed.images);
    const texts = [parsed.text.trim(), ...parsed.voiceTexts.map((t) => `[语音] ${t}`), ...parsed.unsupported];
    const text = texts.filter(Boolean).join("\n").trim();
    if (!text && images.length === 0) return;

    const target: ChatTarget = {
      channel: this.id,
      chatId: `user:${fromUserId}`,
      conversationKey: `wechat:user:${fromUserId}`,
      label: `微信 ${fromUserId}`,
      route: { userId: fromUserId } satisfies WechatRoute,
    };

    const inbound: InboundMessage = {
      channel: this.id,
      chatId: target.chatId,
      conversationKey: target.conversationKey,
      senderId: fromUserId,
      senderName: fromUserId,
      label: target.label,
      isGroup: false,
      text,
      images,
      dedupeKey: `wechat:${key}`,
      receivedAt: Date.now(),
      target,
    };

    this.lastInboundAt = inbound.receivedAt;
    log.info(`收到微信消息 ${fromUserId}: ${text.slice(0, 80) || `[${images.length} 张图片]`}`);
    await this.hooks.onMessage(inbound);
  }

  private async collectImages(refs: Array<{ media?: unknown; aeskey?: string; url?: string }>): Promise<
    Array<{ mimeType: string; data: string }>
  > {
    const out: Array<{ mimeType: string; data: string }> = [];
    for (const image of refs.slice(0, 4)) {
      try {
        const bytes = await downloadImage(image as never, 20_000);
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) continue;
        out.push({ mimeType: detectImageMime(bytes), data: bytes.toString("base64") });
      } catch (error) {
        log.debug(`微信图片下载失败: ${errorText(error)}`);
      }
    }
    return out;
  }

  /* ---------------------------- 发送 ---------------------------- */

  async send(target: ChatTarget, text: string): Promise<void> {
    const credential = this.state.credential;
    if (!credential) throw new ChannelError("微信未登录，无法发送", true);
    const route = target.route as WechatRoute;
    const contextToken = this.state.contextTokens[route.userId];
    const chunks = segmentText(text, this.maxReplyChars);

    for (const chunk of chunks) {
      const usage = this.recordOutbound(route.userId);
      if (usage.count > DAILY_PROACTIVE_LIMIT) {
        log.warn(
          `微信主动消息额度可能已用尽（24h 内第 ${usage.count} 条）。腾讯限制为 ${DAILY_PROACTIVE_LIMIT} 条/24h，后续消息可能被拒。`,
        );
      }
      await sendTextMessage(credential, route.userId, chunk, contextToken);
      if (chunks.length > 1) await sleep(600);
    }
  }

  private recordOutbound(userId: string): { count: number } {
    const now = Date.now();
    const entry = this.state.outboundCounts[userId];
    if (!entry || now - entry.since > 24 * 60 * 60 * 1000) {
      this.state.outboundCounts[userId] = { count: 1, since: now };
    } else {
      entry.count += 1;
    }
    this.saveState();
    return { count: this.state.outboundCounts[userId].count };
  }

  /** 供 /status 展示额度使用情况。 */
  outboundUsage(userId: string): number {
    const entry = this.state.outboundCounts[userId];
    if (!entry || Date.now() - entry.since > 24 * 60 * 60 * 1000) return 0;
    return entry.count;
  }
}

/* ------------------------------------------------------------------ */

function detectImageMime(bytes: Buffer): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF") return "image/webp";
  if (bytes.length > 6 && bytes.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return "image/png";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
