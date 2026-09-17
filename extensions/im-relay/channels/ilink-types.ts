/**
 * 微信 iLink（ClawBot）协议类型与常量。
 *
 * 依据腾讯官方 npm 包 @tencent-weixin/openclaw-weixin 公开的 Backend API Protocol：
 * 域名 ilinkai.weixin.qq.com，HTTP/JSON 长轮询。纯出站客户端 —— 不监听任何端口，
 * 手机与 PC 都只出站连腾讯云，无需公网 IP / 端口映射 / 内网穿透。
 */

export const ILINK_DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
export const ILINK_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
export const ILINK_APP_ID = "bot";
export const BOT_TYPE = "3";

/** 与官方实现对齐的通道版本；改动可能影响服务端行为。 */
export const CHANNEL_VERSION = "2.4.6";
export const CLIENT_VERSION = packVersion(CHANNEL_VERSION);

export function packVersion(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

/** 消息项类型。 */
export const ItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/** 发送方类型：1 = 用户，2 = 机器人。 */
export const MessageType = { USER: 1, BOT: 2 } as const;

/** 生成状态：0 = 新建，1 = 生成中，2 = 完成。 */
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

export interface BaseInfo {
  channel_version: string;
  bot_agent: string;
}

export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface ImageItem {
  media?: CdnMedia;
  thumb_media?: CdnMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  ref_msg?: { message_item?: MessageItem; title?: string };
  text_item?: { text?: string };
  image_item?: ImageItem;
  voice_item?: { media?: CdnMedia; text?: string };
  file_item?: { media?: CdnMedia; file_name?: string; md5?: string; len?: string };
  video_item?: { media?: CdnMedia; video_size?: number; thumb_media?: CdnMedia };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WechatCredential {
  token: string;
  accountId: string;
  baseUrl: string;
  userId?: string;
  /** 保存时间，用于判断是否超过 24h 有效期 */
  savedAt: number;
  /** iLink 长轮询游标，必须持久化，否则重启后会重复收到历史消息 */
  cursor?: string;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrStatusResponse {
  status?: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

/** 一块从 iLink 消息里抽出来的内容。 */
export interface ParsedInbound {
  text: string;
  images: ImageItem[];
  /** 服务端已转写好的语音文本 */
  voiceTexts: string[];
  unsupported: string[];
}
