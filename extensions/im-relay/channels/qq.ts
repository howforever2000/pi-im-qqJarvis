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
import type { QqConfig } from "../config.ts";
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
      lastInboundAt: this.lastInboundAt,
    };
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.setState("off", "配置中已禁用");
      return;
    }
    this.stopping = false;
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
      void client.probePort().then((verdict) => {
        if (this.stopping) return;
        this.setState("error", `${base}\n诊断：${verdict}`);
      });
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
    try {
      this.selfId = await (this.client?.fetchSelfId() ?? Promise.resolve(""));
    } catch (error) {
      log.debug(`获取登录信息失败: ${errorText(error)}`);
    }
    const who = this.selfId ? `机器人 ${this.selfId}` : "机器人";
    this.setState("online", `已连接 NapCat（${who}）`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
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

  async login(): Promise<void> {
    throw new ChannelError("QQ 的登录由 NapCat 负责，请扫码登录 NapCat 后本通道会自动恢复。");
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
