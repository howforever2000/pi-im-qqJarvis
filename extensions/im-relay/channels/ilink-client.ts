/**
 * 微信 iLink HTTP 客户端：扫码登录、长轮询收消息、发消息、CDN 媒体。
 *
 * 全部为出站 HTTPS 请求，不需要公网 IP / 回调地址 / 内网穿透。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createLogger, errorText } from "../log.ts";
import {
  BOT_TYPE,
  CHANNEL_VERSION,
  CLIENT_VERSION,
  ILINK_APP_ID,
  ILINK_CDN_BASE,
  ILINK_DEFAULT_BASE,
  ItemType,
  MessageState,
  MessageType,
} from "./ilink-types.ts";
import type {
  GetUpdatesResponse,
  MessageItem,
  QrStatusResponse,
  WeixinMessage,
  CdnMedia,
  ImageItem,
  ParsedInbound,
  WechatCredential,
} from "./ilink-types.ts";

const log = createLogger("ilink");
const BOT_AGENT = `pi-im-relay/0.1.0 (${CHANNEL_VERSION})`;

/* ------------------------------------------------------------------ */
/* 请求基础设施                                                        */
/* ------------------------------------------------------------------ */

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

function commonHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
}

function authHeaders(token: string): Record<string, string> {
  const uin = randomBytes(4).readUInt32BE(0);
  const headers: Record<string, string> = {
    ...commonHeaders(),
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(uin)).toString("base64"),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** 服务端会包一层 {ret, data:{...}}，也可能直接给裸字段，这里统一拆开。 */
function unwrap(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object") {
    const data = (payload as Record<string, unknown>).data;
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
    return payload as Record<string, unknown>;
  }
  return {};
}

function bizError(payload: Record<string, unknown>, label: string): string | undefined {
  const code = payload.errcode ?? payload.ret;
  if (code === undefined || code === null) return undefined;
  if (Number(code) === 0) return undefined;
  const message = typeof payload.errmsg === "string" && payload.errmsg ? payload.errmsg : "(无错误信息)";
  return `${label} 失败：iLink code ${String(code)} ${message}`;
}

async function requestJson(
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown; timeoutMs: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`响应不是合法 JSON: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/* ------------------------------------------------------------------ */
/* 扫码登录                                                            */
/* ------------------------------------------------------------------ */

export interface QrChallenge {
  id: string;
  url: string;
}

export async function fetchQrChallenge(
  baseUrl: string,
  existingTokens: string[],
  signal?: AbortSignal,
): Promise<QrChallenge> {
  const payload = await requestJson(
    `${trimSlash(baseUrl)}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    {
      method: "POST",
      headers: commonHeaders(),
      body: { local_token_list: existingTokens.slice(-10).reverse() },
      timeoutMs: 15_000,
      signal,
    },
  );
  const data = unwrap(payload);
  const id = String(data.qrcode ?? "").trim();
  const url = String(data.qrcode_img_content ?? data.qrcode_url ?? "").trim();
  if (!id || !url) throw new Error("微信二维码服务没有返回有效二维码");
  return { id, url };
}

export async function pollQrStatus(
  baseUrl: string,
  qrcode: string,
  verifyCode: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<QrStatusResponse> {
  const query = new URLSearchParams({ qrcode });
  if (verifyCode) query.set("verify_code", verifyCode);
  const payload = await requestJson(
    `${trimSlash(baseUrl)}/ilink/bot/get_qrcode_status?${query.toString()}`,
    { method: "GET", headers: commonHeaders(), timeoutMs, signal },
  );
  return unwrap(payload) as QrStatusResponse;
}

export function redirectBaseUrl(host: string | undefined): string {
  const value = String(host ?? "").trim();
  if (!value) throw new Error("微信要求切换节点但没有返回 redirect_host");
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(value)) throw new Error("微信返回的 redirect_host 格式无效");
  return trimSlash(`https://${value}`);
}

/* ------------------------------------------------------------------ */
/* 长轮询 / 发送 / 通知                                                */
/* ------------------------------------------------------------------ */

/**
 * iLink 会话过期（官方协议：errcode -14 = session timeout）。
 *
 * 单独建模是为了区分「网络抖一下重试就好」和「凭据废了必须重新扫码」：
 * 后者如果当成普通错误无限重试，用户会看到通道永远在重连、却永远收不到消息。
 */
export class IlinkSessionExpiredError extends Error {
  readonly errcode: number;

  constructor(errcode: number, message: string) {
    super(message);
    this.name = "IlinkSessionExpiredError";
    this.errcode = errcode;
  }
}

export function isSessionExpired(error: unknown): error is IlinkSessionExpiredError {
  return error instanceof IlinkSessionExpiredError;
}

export async function getUpdates(
  credential: WechatCredential,
  cursor: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GetUpdatesResponse> {
  const payload = await requestJson(`${trimSlash(credential.baseUrl)}/ilink/bot/getupdates`, {
    method: "POST",
    headers: authHeaders(credential.token),
    body: { get_updates_buf: cursor, base_info: baseInfo() },
    timeoutMs,
    signal,
  });
  const data = unwrap(payload);
  const code = Number(data.errcode ?? data.ret ?? 0);
  // -14 = session timeout（官方协议文档）
  if (code === -14) {
    throw new IlinkSessionExpiredError(code, data.errmsg ? String(data.errmsg) : "登录已过期");
  }
  const error = bizError(data, "getupdates");
  if (error) throw new Error(error);
  return data as GetUpdatesResponse;
}

export async function notifyLifecycle(
  credential: WechatCredential,
  action: "start" | "stop",
): Promise<void> {
  const endpoint = action === "start" ? "notifystart" : "notifystop";
  const payload = await requestJson(`${trimSlash(credential.baseUrl)}/ilink/bot/msg/${endpoint}`, {
    method: "POST",
    headers: authHeaders(credential.token),
    body: { base_info: baseInfo() },
    timeoutMs: 10_000,
  });
  const error = bizError(unwrap(payload), endpoint);
  if (error) throw new Error(error);
}

export async function sendTextMessage(
  credential: WechatCredential,
  toUserId: string,
  text: string,
  contextToken: string | undefined,
): Promise<void> {
  const msg: WeixinMessage = {
    from_user_id: "",
    to_user_id: toUserId,
    client_id: randomUUID(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: [{ type: ItemType.TEXT, text_item: { text } }],
    run_id: randomUUID(),
    ...(contextToken ? { context_token: contextToken } : {}),
  };
  const payload = await requestJson(`${trimSlash(credential.baseUrl)}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: authHeaders(credential.token),
    body: { msg, base_info: baseInfo() },
    timeoutMs: 20_000,
  });
  const error = bizError(unwrap(payload), "sendmessage");
  if (error) throw new Error(error);
}

/* ------------------------------------------------------------------ */
/* 媒体（CDN + AES-128-ECB）                                           */
/* ------------------------------------------------------------------ */

export async function downloadMedia(media: CdnMedia, timeoutMs: number): Promise<Buffer> {
  const encryptedQuery = media.encrypt_query_param ?? "";
  const url =
    media.full_url?.trim() ||
    (encryptedQuery
      ? `${ILINK_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(encryptedQuery)}`
      : "");
  if (!url) throw new Error("媒体没有 CDN 下载地址");
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`CDN 下载失败 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const key = media.aes_key?.trim() ? parseBase64Key(media.aes_key) : undefined;
  return key ? decryptAesEcb(bytes, key) : bytes;
}

export async function downloadImage(image: ImageItem, timeoutMs: number): Promise<Buffer> {
  if (!image.media && !image.url) throw new Error("图片没有 CDN 引用");
  const bytes = image.media
    ? await downloadMedia(image.media, timeoutMs)
    : Buffer.from(await (await fetch(image.url as string, { signal: AbortSignal.timeout(timeoutMs) })).arrayBuffer());
  const hexKey = image.aeskey?.trim();
  return hexKey ? decryptAesEcb(bytes, parseHexKey(hexKey)) : bytes;
}

/* ------------------------------------------------------------------ */
/* 消息解析                                                            */
/* ------------------------------------------------------------------ */

/** 抽取一条 iLink 消息里的文本 / 图片 / 语音转写 / 不支持项（含被引用消息）。 */
export function parseInbound(message: WeixinMessage): ParsedInbound {
  const result: ParsedInbound = { text: "", images: [], voiceTexts: [], unsupported: [] };
  collect(message.item_list ?? [], result, 0);
  return result;
}

function collect(items: MessageItem[], into: ParsedInbound, depth: number): void {
  for (const item of items) {
    switch (item.type) {
      case ItemType.TEXT: {
        const text = item.text_item?.text;
        if (text?.trim()) into.text += text;
        break;
      }
      case ItemType.IMAGE:
        if (item.image_item) into.images.push(item.image_item);
        break;
      case ItemType.VOICE: {
        const spoken = item.voice_item?.text;
        if (spoken?.trim()) into.voiceTexts.push(spoken.trim());
        else if (item.voice_item?.media) into.unsupported.push("[语音]（服务端未提供转写）");
        break;
      }
      case ItemType.FILE:
        into.unsupported.push(`[文件 ${item.file_item?.file_name ?? ""}]`.trim());
        break;
      case ItemType.VIDEO:
        into.unsupported.push("[视频]");
        break;
      default:
        break;
    }

    const reference = item.ref_msg;
    if (reference?.title?.trim()) into.text += `\n[引用] ${reference.title.trim().slice(0, 200)}\n`;
    if (reference?.message_item && depth < 4) collect([reference.message_item], into, depth + 1);
  }
}

/** 稳定去重键：优先 message_id，其次 client_id，最后内容哈希。 */
export function messageKey(message: WeixinMessage): string {
  if (message.message_id !== undefined && message.message_id !== null) return String(message.message_id);
  if (message.client_id?.trim()) return message.client_id.trim();
  return createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return ciphertext;
  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // 有些媒体其实是明文，解不开就原样返回
    return ciphertext;
  }
}

function parseHexKey(value: string): Buffer {
  if (!/^[0-9a-fA-F]{32}$/.test(value)) throw new Error("图片 AES hex key 非法");
  return Buffer.from(value, "hex");
}

function parseBase64Key(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, "hex");
  throw new Error("图片 AES key 长度非法");
}

export { isAbort, errorText, log as ilinkLog, ILINK_DEFAULT_BASE };
