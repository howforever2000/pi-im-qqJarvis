/**
 * 通道抽象：所有 IM 平台实现同一套接口，router 不关心底层协议。
 *
 * 加新平台 = 实现一个 Channel 并注册，其余代码零改动。
 */

export type ChannelId = "qq" | "wechat";

/** 一条出站消息要发给谁。 */
export interface ChatTarget {
  channel: ChannelId;
  /** 平台内的会话标识（私聊 = 对方 id；群聊 = 群 id） */
  chatId: string;
  /** 逻辑会话键，用于「同一会话共享上下文」的判断与日志 */
  conversationKey: string;
  /** 人类可读标签，如 "QQ 私聊 12345" / "QQ 群 678 张三" / "微信 张三" */
  label: string;
  /**
   * 平台专属回复凭据，由通道自己解释。
   *  - QQ(OneBot11)：{ userId?, groupId? }
   *  - 微信(iLink)：{ userId, contextToken? }
   */
  route: unknown;
}

/** 一条入站消息。 */
export interface InboundMessage {
  channel: ChannelId;
  chatId: string;
  conversationKey: string;
  senderId: string;
  senderName: string;
  /** 人类可读标签，如 "QQ 私聊 12345" */
  label: string;
  isGroup: boolean;
  groupId?: string;
  text: string;
  /** base64 图片，交给 pi 的多模态能力 */
  images: Array<{ mimeType: string; data: string }>;
  dedupeKey: string;
  receivedAt: number;
  target: ChatTarget;
}

export type ChannelState = "off" | "connecting" | "online" | "needs-login" | "error";

/** 二维码图片负载（不含 data URI 前缀的 base64）。 */
export interface QrImagePayload {
  mimeType: string;
  base64: string;
  /** 像素边长 */
  size: number;
}

/** 一个可供不同界面投递的二维码。 */
export interface QrPayload {
  /** 二维码承载的原始内容（一般是登录链接） */
  text: string;
  image: QrImagePayload;
  /** 终端 ASCII（半块字符） */
  ascii: string;
}

export interface ChannelStatus {
  id: ChannelId;
  name: string;
  state: ChannelState;
  detail?: string;
  /** 终端 ASCII 二维码，仅 TUI 使用 */
  qrAscii?: string;
  /** 图片二维码，支持 <img> 的界面使用 */
  qrImage?: QrImagePayload;
  qrText?: string;
  /** 上次收到消息的时间戳 */
  lastInboundAt?: number;
}

export interface ChannelHooks {
  onMessage(message: InboundMessage): void | Promise<void>;
  onStatusChange(status: ChannelStatus): void;
  /** 需要用户交互（如输入微信配对码）时回调 */
  onPrompt?(question: string): Promise<string | undefined>;
  /**
   * 登录二维码就绪。上层按当前界面的渲染能力选择投递方式：
   *  - 支持图片的界面（pi-web / RPC） → 发一张图片进对话
   *  - 终端 TUI → 用 ascii 画在编辑器上方
   */
  onLoginQr?(payload: { channel: ChannelId; qr: QrPayload }): void;
  /** 二维码渲染失败时的兜底：只给链接 */
  onLoginQrFallback?(url: string): void;
}

export interface Channel {
  readonly id: ChannelId;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ChannelStatus;
  send(target: ChatTarget, text: string): Promise<void>;
  /**
   * 上传本地文件作为附件（可选能力，通道可以没有）。
   * 目前只有 QQ(OneBot11) 实现了上传；微信 iLink 侧只做了媒体的下载解密，
   * 没有上传发送，所以那边会直接返回「不支持」。
   */
  sendFile?(target: ChatTarget, filePath: string): Promise<void>;
  /** 发起登录（微信 iLink 或 QQ 的 NapCat WebUI 扫码）；两者语义一致 */
  login?(): Promise<void>;
  /**
   * 只发起登录并投递二维码，不等用户确认；**返回时二维码一定已经发出去**。
   * 已有新鲜二维码时会只重发、不重复申请。
   */
  beginLogin?(): Promise<void>;
  /** 等待当前登录流程结束（扫码确认 / 超时 / 失败）。 */
  waitForLogin?(): Promise<void>;
  /** 重发当前二维码（不申请新的）；返回是否成功。 */
  reissueQr?(): boolean;
  /**
   * 直接调底层协议接口（QQ 就是 OneBot11 action）。
   *
   * 存在的意义：有些能力在 OneBot 层有，但通道自己没有包装成方法 ——
   * 典型就是「读 QQ 空间」要用的 `get_cookies`。放着不用就得把协议细节
   * 搬到 router 里，那才是真的脏。
   */
  api?<T = unknown>(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export class ChannelError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "ChannelError";
    this.retryable = retryable;
  }
}
