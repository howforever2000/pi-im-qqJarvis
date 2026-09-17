/**
 * QQ 通道（NapCat / OneBot11）。
 *
 * 网络模型：本进程 → ws://127.0.0.1:3001 → NapCat → 腾讯。全程出站，无公网需求。
 * 本模块只负责「收消息 → 标准化」和「标准化回复 → 发消息」，
 * 白名单/去重/限流由 router 统一处理。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger, errorText } from "../log.ts";
import { QQ_QR_FILE, type QqConfig } from "../config.ts";
import { renderQr, type QrRender } from "../qr.ts";
import {
  NapcatWebuiClient,
  NapcatWebuiError,
  isAlreadyLoggedIn,
  resolveWebuiOptions,
  type NapcatLoginPhase,
  type NapcatLoginStatus,
} from "./napcat-webui.ts";
import {
  OneBotClient,
  asSegments,
  extractImages,
  isMentioned,
  segmentsToText,
  stripSelfMentions,
  type OneBotEvent,
  type Segment,
} from "./onebot11.ts";
import { segmentText } from "../text.ts";
import {
  ChannelError,
  type Channel,
  type ChannelHooks,
  type ChannelStatus,
  type ChatTarget,
  type InboundMessage,
} from "./types.ts";

const log = createLogger("qq");
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** 二维码复用窗口：这段时间内重复触发只重发，不重新申请 */
const QR_REUSE_WINDOW_MS = 120_000;
/** 等扫码的上限 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** 登录状态轮询间隔 */
const LOGIN_POLL_MS = 1500;

interface QqRoute {
  userId?: string;
  groupId?: string;
}

export class QqChannel implements Channel {
  readonly id = "qq" as const;
  readonly name = "QQ";

  private client: OneBotClient | undefined;
  private state: ChannelStatus["state"] = "off";
  private detail: string | undefined;
  private lastInboundAt: number | undefined;
  private selfId = "";
  private stopping = false;

  /** NapCat WebUI 客户端（扫码登录用），惰性创建 */
  private webui: NapcatWebuiClient | undefined;
  private qr: QrRender | undefined;
  private qrUrl: string | undefined;
  private qrIssuedAt = 0;
  private loginController: AbortController | undefined;
  /** 正在进行的扫码确认流程（beginLogin 启动、waitForLogin 等待） */
  private loginLoop: Promise<void> | undefined;

  private readonly config: QqConfig;
  private readonly hooks: ChannelHooks;
  private readonly maxReplyChars: number;

  constructor(config: QqConfig, hooks: ChannelHooks, maxReplyChars: number) {
    this.config = config;
    this.hooks = hooks;
    this.maxReplyChars = maxReplyChars;
  }

  status(): ChannelStatus {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      detail: this.detail,
      qrAscii: this.qr?.ascii,
      qrImage: this.qr
        ? { mimeType: this.qr.image.mimeType, base64: this.qr.image.base64, size: this.qr.image.size }
        : undefined,
      qrText: this.qr?.text,
      lastInboundAt: this.lastInboundAt,
    };
  }

  /** 当前登录二维码（供 /im qr 按界面能力重新投递）。 */
  loginQr(): QrRender | undefined {
    return this.qr;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.setState("off", "配置中已禁用");
      return;
    }
    this.stopping = false;
    // 登录成功后重新 start() 时，要先收掉旧连接（连同它的重连定时器），否则会留下两条
    this.client?.close();
    this.client = undefined;
    this.setState("connecting", `连接 ${this.config.host}:${this.config.port} …`);

    const client = new OneBotClient({
      host: this.config.host,
      port: this.config.port,
      token: this.config.token,
    });
    this.client = client;

    client.on("event", (event: OneBotEvent) => {
      void this.handleEvent(event);
    });
    client.on("connected", () => {
      void this.afterConnect();
    });
    client.on("disconnected", () => {
      if (this.stopping) return;
      // 只有“曾经在线”才值得提示断开；连接从未建立时保留 error 详情
      if (this.state === "online") this.setState("connecting", "连接断开，正在自动重连 …");
    });
    client.on("connect_failed", (message: string) => {
      if (this.stopping) return;
      const base = `${message}｜请确认 NapCat 已启动、OneBot11 服务已开启（${this.config.host}:${this.config.port}）`;
      this.setState("error", base);
      // 把模糊的 “WebSocket error” 变成可操作的结论
      void this.diagnose(base, () => client.probePort());
    });

    try {
      await client.connect();
      await this.afterConnect();
    } catch (error) {
      // 状态已由 connect_failed 处理器设置；重连由 OneBotClient 的退避循环负责
      log.warn(`QQ 通道启动失败: ${errorText(error)}`);
    }
  }

  private async afterConnect(): Promise<void> {
    // 已经连上 OneBot 就说明登录流程结束了，把扫码轮询收掉
    this.loginController?.abort();
    this.qr = undefined;
    this.qrUrl = undefined;
    try {
      this.selfId = await (this.client?.fetchSelfId() ?? Promise.resolve(""));
    } catch (error) {
      log.debug(`获取登录信息失败: ${errorText(error)}`);
    }
    const who = this.selfId ? `机器人 ${this.selfId}` : "机器人";
    this.setState("online", `已连接 NapCat（${who}）`);
  }

  /**
   * OneBot11 连不上时的诊断。
   *
   * 最要紧的一种情况是「NapCat 活着，只是 QQ 没登录」—— 这时只报
   * “WebSocket error” 是误导的，正确的结论是「去扫码」。WebUI 能回答这个问题，
   * 所以只要它可达就优先问它。
   */
  private async diagnose(base: string, probe: () => Promise<string>): Promise<void> {
    const verdict = await probe().catch(() => undefined);
    if (this.stopping) return;

    if (this.config.webui?.enabled) {
      try {
        const status = await this.webuiOrThrow().status();
        if (this.stopping) return;
        if (!status.isLogin) {
          this.setState(
            "needs-login",
            "NapCat 已启动，但 QQ 还没登录 → 执行 /im login qq 扫码（在对话里说「QQ登录」也行）" +
              (verdict ? `\n诊断：${verdict}` : ""),
          );
          return;
        }
        this.setState(
          "error",
          `${base}\n诊断：${verdict ?? "未知"}\nNapCat 显示 QQ 已登录，请检查 OneBot11 服务是否已开启（端口 ${this.config.port}）。`,
        );
        return;
      } catch (error) {
        log.debug(`WebUI 诊断失败: ${errorText(error)}`);
      }
    }

    this.setState("error", `${base}\n诊断：${verdict ?? "未知"}`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.loginController?.abort();
    this.client?.close();
    this.client = undefined;
    this.setState("off", "已停止");
  }

  private setState(state: ChannelStatus["state"], detail?: string): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.hooks.onStatusChange(this.status());
  }

  /* ---------------------------- 入站 ---------------------------- */

  private async handleEvent(event: OneBotEvent): Promise<void> {
    if (event.post_type !== "message") return;
    const segments = asSegments(event.message);
    const senderId = String(event.user_id ?? "");
    const groupId = event.group_id !== undefined ? String(event.group_id) : undefined;
    const isGroup = event.message_type === "group";
    if (!senderId) return;

    // 忽略自己发的消息，避免自问自答循环
    if (this.selfId && senderId === this.selfId) return;

    const mentioned = this.selfId ? isMentioned(segments, this.selfId) : false;
    const bodySegments = this.selfId ? stripSelfMentions(segments, this.selfId) : segments;

    if (isGroup) {
      if (!groupId) return;
      if (this.config.groupTrigger === "mention" && !mentioned) return;
    }

    const text = segmentsToText(bodySegments, this.selfId);
    const images = await this.collectImages(extractImages(bodySegments));
    if (!text && images.length === 0) return;

    const senderName = String(event.sender?.card || event.sender?.nickname || senderId);
    const chatId = isGroup ? `group:${groupId}` : `private:${senderId}`;
    const label = isGroup ? `QQ 群 ${groupId} · ${senderName}` : `QQ 私聊 ${senderName}`;

    const target: ChatTarget = {
      channel: this.id,
      chatId,
      conversationKey: isGroup ? `qq:group:${groupId}` : `qq:user:${senderId}`,
      label,
      route: { userId: senderId, groupId } satisfies QqRoute,
    };

    const message: InboundMessage = {
      channel: this.id,
      chatId,
      conversationKey: target.conversationKey,
      senderId,
      senderName,
      label,
      isGroup,
      groupId,
      text,
      images,
      dedupeKey: `qq:${event.message_id ?? `${senderId}:${event.time ?? ""}:${text.slice(0, 40)}`}`,
      receivedAt: Date.now(),
      target,
    };

    this.lastInboundAt = message.receivedAt;
    log.info(`收到 ${label}: ${text.slice(0, 80) || `[${images.length} 张图片]`}`);
    await this.hooks.onMessage(message);
  }

  private async collectImages(
    refs: Array<Record<string, unknown>>,
  ): Promise<Array<{ mimeType: string; data: string }>> {
    const out: Array<{ mimeType: string; data: string }> = [];
    for (const ref of refs.slice(0, 4)) {
      try {
        const bytes = await this.resolveImage(ref);
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) continue;
        out.push({ mimeType: detectImageMime(bytes), data: bytes.toString("base64") });
      } catch (error) {
        log.debug(`图片获取失败: ${errorText(error)}`);
      }
    }
    return out;
  }

  /** 尽量把 NapCat 给的图片引用变成字节：http url → file url → 本地路径 → get_image API。 */
  private async resolveImage(ref: Record<string, unknown>): Promise<Buffer> {
    const url = typeof ref.url === "string" ? ref.url : "";
    const file = typeof ref.file === "string" ? ref.file : "";

    if (/^https?:\/\//i.test(url)) {
      return this.fetchBytes(url);
    }
    const fromUrl = fileUrlToPath(url);
    if (fromUrl) return fs.readFile(fromUrl);

    if (/^https?:\/\//i.test(file)) return this.fetchBytes(file);
    const fromFile = fileUrlToPath(file);
    if (fromFile) return fs.readFile(fromFile);
    if (file && path.isAbsolute(file)) return fs.readFile(file);

    // NapCat 的 file 常是缓存目录里的裸文件名，用 get_image 换回绝对路径
    const resolved = await this.client?.api<{ file?: string }>("get_image", { file: file || url });
    const resolvedPath = resolved?.file ? fileUrlToPath(resolved.file) ?? resolved.file : undefined;
    if (resolvedPath) return fs.readFile(resolvedPath);
    throw new Error("无法解析图片引用");
  }

  private async fetchBytes(url: string): Promise<Buffer> {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error("图片过大");
    return buffer;
  }

  /* ---------------------------- 出站 ---------------------------- */

  async send(target: ChatTarget, text: string): Promise<void> {
    const client = this.client;
    if (!client?.isConnected) throw new ChannelError("QQ 未连接（NapCat 不可达）", true);
    const route = target.route as QqRoute;
    const chunks = segmentText(text, this.maxReplyChars);
    if (chunks.length === 0) return;

    for (const chunk of chunks) {
      const message: Segment[] = [{ type: "text", data: { text: chunk } }];
      if (route.groupId) {
        await client.api("send_group_msg", { group_id: route.groupId, message });
      } else if (route.userId) {
        await client.api("send_private_msg", { user_id: route.userId, message });
      } else {
        throw new ChannelError("QQ 回复缺少目标（既无 group_id 也无 user_id）");
      }
      // 分段之间稍作间隔，避免被风控判定为刷屏
      if (chunks.length > 1) await sleep(350);
    }
  }

  /** 上传本地文件（agent 产出的产物可以直接丢回 QQ）。 */
  async sendFile(target: ChatTarget, filePath: string): Promise<void> {
    const client = this.client;
    if (!client?.isConnected) throw new ChannelError("QQ 未连接（NapCat 不可达）", true);
    const route = target.route as QqRoute;
    const name = path.basename(filePath);
    if (route.groupId) {
      await client.api("upload_group_file", { group_id: route.groupId, file: filePath, name });
    } else if (route.userId) {
      await client.api("upload_private_file", { user_id: route.userId, file: filePath, name });
    }
  }

  /* ---------------------------- 扫码登录 ---------------------------- */

  private webuiOrThrow(): NapcatWebuiClient {
    if (!this.config.webui?.enabled) {
      throw new ChannelError(
        "QQ 的扫码登录需要 NapCat WebUI（config.json 里 channels.qq.webui.enabled 目前是 false）",
      );
    }
    if (!this.webui) this.webui = new NapcatWebuiClient(resolveWebuiOptions(this.config.webui));
    return this.webui;
  }

  /**
   * 申请登录二维码并开始轮询，**返回时二维码一定已经投递出去**。
   *
   * 与微信通道同一套语义：已有新鲜二维码时只重发、不重新申请。
   * 这是被真实踩过的坑 —— 用户一边敲 `/im login qq` 一边又说「QQ登录」，
   * 两条路各申请一张码，对话里出现两张，不知道该扫哪一张。
   */
  async beginLogin(): Promise<void> {
    if (!this.config.enabled) throw new ChannelError("QQ 通道在配置中被禁用");
    if (this.loginActive()) {
      log.info("已有进行中的 QQ 登录二维码，直接复用（不重复申请）");
      this.reissueQr();
      return;
    }

    const webui = this.webuiOrThrow();
    this.loginController?.abort();
    const controller = new AbortController();
    this.loginController = controller;
    this.qr = undefined;
    this.qrUrl = undefined;
    this.setState("connecting", "正在向 NapCat 申请登录二维码 …");

    let status: NapcatLoginStatus;
    try {
      status = await webui.status();
    } catch (error) {
      const message = describeWebuiFailure(error);
      this.setState("error", message);
      throw new ChannelError(message);
    }

    // 已经在 NapCat 里登录过了：不用扫码，直接恢复通道
    if (status.coreReady) {
      log.info("NapCat 已处于登录状态，跳过扫码直接连接 OneBot11");
      await this.start();
      return;
    }

    let url = status.qrcodeurl;
    if (!url) {
      const refreshed = await webui.refreshQrcode().catch(() => ({ url: "", restarting: false }));
      if (!refreshed.url && refreshed.restarting) {
        throw new ChannelError("NapCat 正在重启登录服务，请等十几秒后再发一次「QQ登录」");
      }
      url = refreshed.url;
    }
    if (!url) {
      try {
        url = await webui.fetchQrcodeUrl();
      } catch (error) {
        const message = describeWebuiFailure(error);
        this.setState("error", message);
        throw new ChannelError(message);
      }
    }

    this.publishQr(url, status.loginPhase);

    const loop = this.pollLogin(controller, webui);
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

  /** 把当前二维码重发一次（不向 NapCat 申请新的）。 */
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

  /**
   * 轮询 NapCat 的登录状态直到扫码确认 + 核心就绪。
   *
   * 二维码过期换码不用自己算时间：NapCat 会自己刷新，换码后 `qrcodeurl` 就变了，
   * 这里跟着把新码投给用户即可。
   */
  private async pollLogin(controller: AbortController, webui: NapcatWebuiClient): Promise<void> {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;

    while (!controller.signal.aborted && Date.now() < deadline) {
      let status: NapcatLoginStatus;
      try {
        status = await webui.status();
      } catch (error) {
        if (controller.signal.aborted) break;
        // 凭证/token 这类错误重试也没用，直接报给用户
        if (error instanceof NapcatWebuiError && error.kind === "auth") {
          this.setState("error", describeWebuiFailure(error));
          return;
        }
        log.debug(`QQ 登录状态查询失败，稍后重试: ${errorText(error)}`);
        await sleep(2000);
        continue;
      }

      if (status.coreReady) {
        this.setState("connecting", "QQ 登录成功，正在连接 OneBot11 …");
        await this.start();
        return;
      }

      if (status.loginError) {
        this.setState("error", `NapCat 登录出错：${status.loginError}`);
        return;
      }

      switch (status.loginPhase) {
        case "qrcode_scanned":
          this.setState("needs-login", "二维码已扫描，请在手机上确认登录");
          break;
        case "initializing":
          this.setState("connecting", "QQ 已登录，正在初始化 OneBot 服务 …");
          break;
        case "reconnecting":
          this.setState("connecting", "NapCat 正在重启登录服务，请稍候 …");
          break;
        case "offline":
          this.setState("connecting", "NapCat 登录服务已断开，等待恢复 …");
          break;
        case "generating_qrcode":
          this.setState("needs-login", "NapCat 正在生成二维码 …");
          break;
        case "waiting_qrcode":
        default:
          if (status.qrcodeurl && status.qrcodeurl !== this.qrUrl) {
            this.publishQr(status.qrcodeurl, status.loginPhase);
          } else if (!status.qrcodeurl && !this.qr) {
            // 还没出码（比如刚重启完），主动催一张
            try {
              const refreshed = await webui.refreshQrcode();
              if (refreshed.url) this.publishQr(refreshed.url, "waiting_qrcode");
            } catch (error) {
              log.debug(`刷新 QQ 二维码失败: ${errorText(error)}`);
            }
          } else {
            this.setState("needs-login", loginPhaseText(status.loginPhase));
          }
          break;
      }

      await sleep(LOGIN_POLL_MS);
    }

    if (!controller.signal.aborted) {
      throw new ChannelError("扫码登录超时（5 分钟），请重新发起「QQ登录」");
    }
  }

  /**
   * 新的二维码就绪：交给上层按界面能力投递（图片 / 终端 ASCII）。
   * 同时落一份文本到磁盘，方便在图片不可用的环境下拷贝链接。
   */
  private publishQr(url: string, phase: NapcatLoginPhase): void {
    let rendered: QrRender | undefined;
    try {
      rendered = renderQr(url, 8, 3);
    } catch (error) {
      log.warn(`二维码生成失败: ${errorText(error)}`);
    }
    this.qr = rendered;
    this.qrUrl = url;
    this.qrIssuedAt = Date.now();

    void fs
      .writeFile(
        QQ_QR_FILE,
        [
          "QQ 登录二维码链接（请勿转发）：",
          url,
          "",
          rendered?.ascii ?? "(二维码渲染失败，请直接使用上面的链接)",
          "",
        ].join("\n"),
        { mode: 0o600 },
      )
      .catch(() => undefined);

    // 先投递给界面，再改状态，避免界面还没拿到码就先看到「等待扫码」
    if (rendered) this.hooks.onLoginQr?.({ channel: this.id, qr: rendered });
    else this.hooks.onLoginQrFallback?.(url);
    this.setState("needs-login", loginPhaseText(phase));
  }
}

/* ------------------------------------------------------------------ */

function fileUrlToPath(value: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(value).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function detectImageMime(bytes: Buffer): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF") return "image/webp";
  if (bytes.length > 6 && bytes.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (bytes.length > 12 && bytes.toString("ascii", 4, 8) === "ftyp") return "image/heic";
  return "image/png";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 登录阶段 → 给用户看的一句话。 */
function loginPhaseText(phase: NapcatLoginPhase): string {
  switch (phase) {
    case "qrcode_scanned":
      return "二维码已扫描，请在手机上确认登录";
    case "generating_qrcode":
      return "NapCat 正在生成二维码 …";
    case "initializing":
      return "QQ 已登录，正在初始化 …";
    default:
      return "等待手机 QQ 扫码确认";
  }
}

/** 把 WebUI 的各类失败翻译成用户能照做的结论。 */
function describeWebuiFailure(error: unknown): string {
  if (isAlreadyLoggedIn(error)) {
    return "NapCat 显示 QQ 已经登录，不需要扫码。若通道仍未在线，请检查 OneBot11 服务是否已开启（或执行 /im reload）。";
  }
  if (error instanceof NapcatWebuiError) return error.message;
  return errorText(error);
}
