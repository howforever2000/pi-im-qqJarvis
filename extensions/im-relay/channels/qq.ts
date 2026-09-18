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
import { ensureNapcatRunning, resolveAutoStart, switchQqAccount, type EnsureOutcome } from "./napcat-process.ts";
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
/**
 * 二维码复用窗口：这段时间内重复触发只重发，不重新申请。
 *
 * 硬约束：**必须明显短于二维码本身的有效期**（腾讯侧约 120s）。
 * 这里原来是 120s —— 等于「复用窗口 == 码的寿命」。后果是用户在第 110 秒说一句
 * 「QQ登录」，扩展会很贴心地把他 110 秒前那张码原样再发一遍，而他扫到的就是
 * 「二维码已过期」。这正是「再次扫码依然过期」的直接成因。
 * 取 60s 保证：任何投给用户的码，至少还剩一半寿命。
 */
const QR_REUSE_WINDOW_MS = 60_000;
/**
 * 二维码硬过期线：超过这个年龄，不管 NapCat 说什么都换新码。
 *
 * 比复用窗口宽松，是专门留给「用户已经扫码、正在手机上按确认」的宽限期 ——
 * 那种时候把码作废会直接打断他的确认。但真到了硬过期线，留着一张已经死掉的码
 * 只会让 NapCat 卡死（见 refreshStaleQr），所以照样换。
 */
const QR_HARD_EXPIRY_MS = 115_000;
/** 强制换码的最小重试间隔，避免 WebUI 被高频调用（它自带登录限流） */
const QR_STALE_RETRY_MS = 15_000;
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
  /** 上次为「码太旧」而强制刷新 NapCat 二维码的时间，用于节流重试 */
  private qrStaleProbeAt = 0;
  /**
   * 当前这张码已被判定为陈旧（换码请求发出去了，但 NapCat 还没真正吐出新的）。
   *
   * 这个标志存在的唯一理由是：一旦确认码废了，就不能再让下面 switch 里基于 loginPhase
   * 的文案（比如「二维码已扫描，请在手机上确认登录」）把它覆盖掉 —— 那是 NapCat 在撒谎。
   */
  private qrStale = false;
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

  /** 直接透到 OneBot11 —— 读 QQ 空间要用的 `get_cookies` 就走这里。 */
  api<T = unknown>(action: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (!this.client) return Promise.reject(new Error("QQ 通道尚未连接 NapCat"));
    return this.client.api<T>(action, params, timeoutMs);
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
    this.qrStaleProbeAt = 0;
    this.qrStale = false;
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
    // 记下上一轮展示过的码：NapCat 会把它再吐回来（见下面 refresh 分支的说明）
    const previousUrl = this.qrUrl;
    this.loginController?.abort();
    const controller = new AbortController();
    this.loginController = controller;
    this.qr = undefined;
    this.qrUrl = undefined;
    this.qrStaleProbeAt = 0;
    this.qrStale = false;
    this.setState("connecting", "正在确认 NapCat 是否在运行 …");

    // 用户要求：说一句「QQ登录」就该把 NapCat 拉起来，而不是甩一句 fetch failed
    const ensured = await this.ensureNapcat(webui);
    if (!ensured.ok) {
      this.setState("error", ensured.detail);
      throw new ChannelError(ensured.detail);
    }
    if (ensured.started) {
      // NapCat 是新起的：上一轮的 WebUI 凭证与二维码都失效了
      webui.reset();
      this.setState("connecting", "NapCat 已启动，正在申请登录二维码 …");
    }

    this.setState("connecting", "正在向 NapCat 申请登录二维码 …");

    let status: NapcatLoginStatus;
    try {
      status = await webui.status();
    } catch (error) {
      const message = describeWebuiFailure(error);
      this.setState("error", message);
      throw new ChannelError(message);
    }

    // 已经在 NapCat 里登录过了。
    // 默认行为是「换号」：踢掉旧账号、清票据、重启 NapCat，然后照常出二维码。
    // 用户的要求就是「发出『QQ登录』就默认把之前那个踢下来」。
    if (status.coreReady) {
      if (this.config.switchAccount?.enabled) {
        this.setState("connecting", "正在踢掉当前登录的 QQ 并重启 NapCat …");
        const outcome = await switchQqAccount(this.config.switchAccount, {
          selfUin: this.selfId,
          // 用解析过后的地址（webui.host/port）：配置里留空、真值来自 webui.json 时也得对
          webuiHost: webui.host,
          webuiPort: webui.port,
        });
        log.info(`换号结果：${outcome.detail}`);
        if (!outcome.ok) {
          this.setState("error", outcome.detail);
          throw new ChannelError(outcome.detail);
        }
        // NapCat 刚重启，WebUI 凭证与登录状态都要重新取一遍
        this.loginController?.abort();
        this.qr = undefined;
        this.qrUrl = undefined;
        this.qrStaleProbeAt = 0;
        this.qrStale = false;
        this.selfId = "";
        webui.reset();
        this.setState("connecting", "NapCat 已重启，正在申请新的登录二维码 …");
        await this.start();
        try {
          status = await webui.status();
        } catch (error) {
          const message = describeWebuiFailure(error);
          this.setState("error", message);
          throw new ChannelError(message);
        }
        if (status.coreReady) {
          // 极少见：账号又被自动登回去了（票据没清干净）。如实说明，不假装成功。
          throw new ChannelError(
            "NapCat 重启后旧账号仍然处于登录状态 —— 可能是登录票据没清干净。" +
              "可先把 qq.switchAccount.enabled 关掉，或手动清一次 %APPDATA%\\QQ\\auth\\login.enc",
          );
        }
      } else {
        log.info("NapCat 已处于登录状态，跳过扫码直接连接 OneBot11（换号功能已关闭）");
        await this.start();
        return;
      }
    }

    let url = status.qrcodeurl;
    // 两种情况必须强制要一张新码：
    //  1. NapCat 没给出码；
    //  2. 给回来的还是上一轮已经展示过的那张 —— NapCat 会卡在 qrcode_scanned（它以为码被扫了、
    //     在等手机确认），而那张码在腾讯侧其实早已失效。此时它既不换码、也不会被别的分支刷新，
    //     用户反复说「QQ登录」拿到的永远是同一张废码，只能手工敲 WebUI 才解得开。
    if (!url || url === previousUrl) {
      if (url === previousUrl) {
        log.info("NapCat 返回的二维码与上一次相同，判定为陈旧码（疑似卡在 qrcode_scanned），强制刷新");
      }
      const refreshed = await webui.refreshQrcode().catch(() => ({ url: "", restarting: false }));
      if (!refreshed.url && refreshed.restarting) {
        throw new ChannelError("NapCat 正在重启登录服务，请等十几秒后再发一次「QQ登录」");
      }
      if (refreshed.url) url = refreshed.url;
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
   * 登录前的「确保 NapCat 在跑」。
   *
   * 存在的理由很实际：二维码只存在于 NapCat WebUI 上，而 NapCat 经常是关着的
   * （重启机器之后尤其如此）。以前这种时候用户拿到的是 `fetch failed`，
   * 还得自己想起来去双击启动脚本。现在直接把道打通：启动 → 等 WebUI 就绪 → 出码。
   */
  private async ensureNapcat(webui: NapcatWebuiClient): Promise<EnsureOutcome> {
    const config = resolveAutoStart(this.config.autoStart, this.config.switchAccount?.shellDir);
    const outcome = await ensureNapcatRunning(config, {
      host: webui.host,
      port: webui.port,
      reason: "QQ 扫码登录",
    });
    log.info(`NapCat 启动检查：${outcome.detail}`);
    return outcome;
  }

  /**
   * 轮询期间 NapCat 突然退出时的自救。
   *
   * 只在「连续多次问不到状态」且还没试过的情况下拉起一次 ——
   * 单次失败很可能只是 WebUI 正在重启，不值得动手。
   */
  private async recoverNapcat(webui: NapcatWebuiClient): Promise<boolean> {
    const config = resolveAutoStart(this.config.autoStart, this.config.switchAccount?.shellDir);
    if (!config.enabled) return false;

    this.setState("connecting", "NapCat 好像退出了，正在重新拉起 …");
    const outcome = await ensureNapcatRunning(config, {
      host: webui.host,
      port: webui.port,
      reason: "QQ 登录轮询中掉线",
    });
    log.info(`NapCat 掉线恢复：${outcome.detail}`);
    if (outcome.ok) {
      webui.reset();
      this.setState("connecting", "NapCat 已恢复，继续等待扫码 …");
      return true;
    }
    this.setState("error", outcome.detail);
    return false;
  }

  /**
   * 轮询 NapCat 的登录状态直到扫码确认 + 核心就绪。
   *
   * 换码有两条路：NapCat 自己刷新时 `qrcodeurl` 会变，跟着投新码即可；但它也可能
   * 卡死在 `qrcode_scanned` 上永远不换（见 refreshStaleQr），所以再加一道按
   * 「码的年龄」触发的兜底。
   */
  private async pollLogin(controller: AbortController, webui: NapcatWebuiClient): Promise<void> {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    /** 连续问不到状态的次数；够多就说明 NapCat 真的不在了，而不是它自己重启了一下 */
    let unreachable = 0;
    let recovered = false;

    while (!controller.signal.aborted && Date.now() < deadline) {
      let status: NapcatLoginStatus;
      try {
        status = await webui.status();
        // 状态请求往返期间登录流程可能已经被换掉（用户重新发起 / 通道重启）。
        // 不在这里拦一下，这个已经作废的循环会在新流程清空 qrUrl 之后把旧码再 publish 一遍，
        // 把新一轮刚换出来的新码盖回去。
        if (controller.signal.aborted) break;
        unreachable = 0;
      } catch (error) {
        if (controller.signal.aborted) break;
        // 凭证/token 这类错误重试也没用，直接报给用户
        if (error instanceof NapcatWebuiError && error.kind === "auth") {
          this.setState("error", describeWebuiFailure(error));
          return;
        }
        unreachable += 1;
        log.debug(`QQ 登录状态查询失败（第 ${unreachable} 次），稍后重试: ${errorText(error)}`);
        if (unreachable >= 3 && !recovered) {
          recovered = true;
          if (!(await this.recoverNapcat(webui))) return;
          unreachable = 0;
        }
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

      // 二维码过期兜底。这里刻意不看 loginPhase —— 正是因为 NapCat 会误报 qrcode_scanned，
      // 才需要一个不信它的判据。请见 refreshStaleQr 的注释。
      if (await this.refreshStaleQr(webui, status.loginPhase)) {
        await sleep(LOGIN_POLL_MS);
        continue;
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
   * 二维码过期兜底：码太旧就强制向 NapCat 要一张新的。
   *
   * 触发线分两档（见 QR_REUSE_WINDOW_MS / QR_HARD_EXPIRY_MS）：无人扫就按复用窗口早换，
   * 已扫码待确认则宽限到硬过期线。判定依据只看「这张码发出多久了」，不看 loginPhase。
   *
   * 为什么必须自己算而不信 NapCat —— 两个上游缺陷：
   *
   *  1. `onQRCodeSessionFailed` 里只有 `ErrType 1 / ErrCode 3`（二维码过期）会触发
   *     「重新出码」。其他错误码（真机上实测到 Code 10、Code 1）只打一行日志，
   *     不改 `loginPhase`、不设 `loginError`、也不换码。
   *  2. NapCat 有已知 bug：刷新二维码接口返回成功但码根本没换
   *     （NapNeko/NapCatQQ#1962，真机上复现过：连调两次 RefreshQRcode 拿到同一个 URL）。
   *
   * 叠加起来就是 NapCat 的登录状态机会卡在 `loginPhase: "qrcode_scanned"`
   * （`qrLoginAccepted: false`）——它以为「码已被扫、正在等手机确认」，但那张码在腾讯侧
   * 早已过期。后果是：
   *
   *  - 用户手机上一直提示「二维码已过期」；
   *  - NapCat 自认为不在 waiting_qrcode，所以永远不会自己换码；
   *  - 下面 switch 里「url 变了就投递新码」的分支也不会触发；
   *  - 用户反复说「QQ登录」，拿到的永远是同一张废码，只能人工敲 WebUI API 才解得开。
   *
   * 所以这里不信 loginPhase，只问「这张码发出多久了」。返回 true 表示已经换了新码
   * （调用方应跳过本轮 switch，否则会拿着旧 status 把状态又写回去）。
   */
  private async refreshStaleQr(
    webui: NapcatWebuiClient,
    phase: NapcatLoginPhase,
  ): Promise<boolean> {
    if (!this.qr || !this.qrUrl) return false;

    // 已经扫码待确认的，宽限到硬过期线再换 —— 此刻换码等于把用户手上的确认打断。
    // 其余情况（码摆在那儿没人扫）早点换掉更划算：用户可能随时去扫它。
    const limit = phase === "qrcode_scanned" ? QR_HARD_EXPIRY_MS : QR_REUSE_WINDOW_MS;
    if (Date.now() - this.qrIssuedAt < limit) return false;

    // 节流期内：不再骚扰 NapCat，但仍要遮住 loginPhase 的文案（它可能正在撒谎）。
    // 返回 this.qrStale 而不是 false，否则提示会在重试间隔里来回跳。
    if (Date.now() - this.qrStaleProbeAt < QR_STALE_RETRY_MS) return this.qrStale;
    this.qrStaleProbeAt = Date.now();

    log.info("当前二维码已超过有效期，强制向 NapCat 申请新码");
    let refreshed: { url: string; restarting: boolean };
    try {
      refreshed = await webui.refreshQrcode();
    } catch (error) {
      // 请求本身失败：保持上一次的结论，不影响接下来的轮询重试
      log.debug(`强制刷新二维码失败: ${errorText(error)}`);
      return this.qrStale;
    }

    if (!refreshed.url) {
      if (refreshed.restarting) {
        this.qrStale = true;
        this.setState("connecting", "NapCat 正在重启登录服务，稍候会自动重新出码 …");
        return true;
      }
      log.warn("NapCat 没返回新二维码，可能仍在生成");
      return this.qrStale;
    }

    if (refreshed.url === this.qrUrl) {
      // NapCat 声称刷新成功，但给的还是同一张。如实告诉用户，等下次重试。
      log.warn("NapCat 刷新二维码后返回的仍是同一张码，可能仍卡在旧状态");
      this.qrStale = true;
      this.setState("needs-login", "二维码已过期，正在重新申请 …");
      return true;
    }

    this.publishQr(refreshed.url, "waiting_qrcode");
    return true;
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
    this.qrStaleProbeAt = 0;
    this.qrStale = false;

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
  if (error instanceof NapcatWebuiError) {
    // 走到这里说明前面那次自动启动没把 WebUI 拉起来（或功能被关了），把开关提示补上
    if (error.kind === "unreachable") {
      return `${error.message}（若希望发「QQ登录」时自动启动 NapCat，确认 qq.autoStart.enabled = true）`;
    }
    return error.message;
  }
  return errorText(error);
}
