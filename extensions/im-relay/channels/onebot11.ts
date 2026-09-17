/**
 * OneBot11 / NapCat WebSocket 客户端。
 *
 * 纯出站：本进程作为 WS 客户端连接本机 NapCat 的 OneBot11 服务（默认 127.0.0.1:3001），
 * 不监听任何端口，不需要公网 IP / 端口映射 / 内网穿透。
 * NapCat 自己以 QQNT 客户端身份出站长连腾讯服务器，与你的网络环境无关。
 */
import { EventEmitter } from "node:events";
import { createLogger, errorText } from "../log.ts";

const log = createLogger("onebot11");

export interface OneBotApiResponse {
  status?: string;
  retcode?: number;
  message?: string;
  data?: unknown;
  echo?: string;
}

export interface OneBotEvent {
  post_type?: string;
  message_type?: string;
  sub_type?: string;
  self_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  message_id?: number | string;
  raw_message?: string;
  message?: unknown;
  sender?: { user_id?: number | string; nickname?: string; card?: string; role?: string };
  [key: string]: unknown;
}

export interface Segment {
  type: string;
  data?: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface OneBotOptions {
  host: string;
  port: number;
  token: string;
  /** 注入以便测试；默认用全局 WebSocket */
  webSocketCtor?: typeof WebSocket;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | undefined;
  private connected = false;
  private closing = false;
  private reconnectDelay = 1000;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private selfId = "";
  private lastConnectError: string | undefined;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;

  private readonly options: OneBotOptions;

  constructor(options: OneBotOptions) {
    super();
    this.options = options;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get botId(): string {
    return this.selfId;
  }

  get lastError(): string | undefined {
    return this.lastConnectError;
  }

  private url(): string {
    const base = `ws://${this.options.host}:${this.options.port}/`;
    return this.options.token ? `${base}?access_token=${encodeURIComponent(this.options.token)}` : base;
  }

  private get address(): string {
    return `${this.options.host}:${this.options.port}`;
  }

  /** 连接并等待 open；失败即抛错，并由内部调度重连。 */
  async connect(timeoutMs = 8000): Promise<void> {
    const Ctor = this.options.webSocketCtor ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Ctor) throw new Error("当前 Node 运行时不提供 WebSocket，请升级 Node 或安装 ws 包");

    this.attempts += 1;
    log.info(`正在连接 OneBot11 @ ${this.address}（第 ${this.attempts} 次）`);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = this.options.token
          ? new Ctor(this.url(), { headers: { Authorization: `Bearer ${this.options.token}` } } as never)
          : new Ctor(this.url());
      } catch (error) {
        const message = `创建 WebSocket 失败: ${errorText(error)}`;
        this.emit("connect_failed", message);
        this.scheduleReconnect();
        reject(new Error(message));
        return;
      }
      this.ws = ws;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        const message = `连接 NapCat 超时（${this.address}，${timeoutMs}ms 无响应）`;
        this.emit("connect_failed", message);
        reject(new Error(message));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        this.reconnectDelay = 1000;
        this.attempts = 0;
        this.lastConnectError = undefined;
        log.info(`已连接 OneBot11 @ ${this.address}`);
        this.emit("connected");
        resolve();
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        const text = typeof event.data === "string" ? event.data : String(event.data);
        this.handleRaw(text);
      });

      ws.addEventListener("error", (event: Event) => {
        const message = describeSocketError(event);
        this.lastConnectError = message;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const failure = describeConnectFailure(this.address, message);
          this.emit("connect_failed", failure);
          reject(new Error(failure));
          return;
        }
        log.warn(`WebSocket 错误: ${message}`);
      });

      ws.addEventListener("close", (event: CloseEvent) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.rejectAll(`连接已关闭 (${event?.code ?? "?"})`);
        if (wasConnected) log.warn(`与 NapCat 的连接断开 (code=${event?.code ?? "?"})`);
        this.emit("disconnected");
        if (!this.closing) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    log.info(`${Math.round(delay / 1000)} 秒后重试连接 ${this.address}`);
    this.emit("reconnect_scheduled", delay);
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closing) return;
      this.connect().catch((error) => {
        log.debug(`重连失败: ${errorText(error)}`);
      });
    }, delay);
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  private handleRaw(text: string): void {
    let payload: OneBotApiResponse & OneBotEvent;
    try {
      payload = JSON.parse(text) as OneBotApiResponse & OneBotEvent;
    } catch {
      return;
    }
    const echo = payload.echo;
    if (typeof echo === "string" && this.pending.has(echo)) {
      const entry = this.pending.get(echo);
      this.pending.delete(echo);
      if (entry) {
        clearTimeout(entry.timer);
        const ok = payload.status === "ok" || payload.retcode === 0;
        if (ok) entry.resolve(payload.data ?? {});
        else entry.reject(new Error(`OneBot API 失败: retcode=${payload.retcode} ${payload.message ?? ""}`));
      }
      return;
    }
    if (payload.post_type === "meta_event") {
      if (payload.meta_event_type === "lifecycle" && payload.self_id) {
        this.selfId = String(payload.self_id);
      }
      this.emit("meta", payload);
      return;
    }
    this.emit("event", payload);
  }

  /** 调用 OneBot11 API，失败/超时抛错。 */
  api<T = unknown>(action: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error("尚未连接 NapCat OneBot11 服务"));
        return;
      }
      const echo = `imrelay_${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot API ${action} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(echo, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ action, params: params ?? {}, echo }));
      } catch (error) {
        this.pending.delete(echo);
        clearTimeout(timer);
        reject(new Error(`发送 ${action} 失败: ${errorText(error)}`));
      }
    });
  }

  private rejectAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  close(): void {
    this.closing = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectAll("客户端已关闭");
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }

  /** 探测自身账号信息（也用于确认登录是否有效）。 */
  async fetchSelfId(): Promise<string> {
    if (this.selfId) return this.selfId;
    const info = await this.api<{ user_id?: number | string }>("get_login_info");
    this.selfId = info?.user_id !== undefined ? String(info.user_id) : "";
    return this.selfId;
  }

  /**
   * 对目标端口做一次裸 TCP 探测，把“WebSocket error”这种模糊报错
   * 翻译成可操作的结论。连接失败时由调用方触发。
   */
  async probePort(timeoutMs = 1500): Promise<string> {
    const net = await import("node:net");
    return new Promise<string>((resolve) => {
      const socket = net.connect({ host: this.options.host, port: this.options.port });
      let settled = false;
      const finish = (verdict: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(verdict);
      };
      const timer = setTimeout(
        () => finish("端口无响应（可能被防火墙拦截，或地址/端口写错了）"),
        timeoutMs,
      );
      timer.unref?.();
      socket.once("connect", () =>
        finish("端口可以连接，但 WebSocket 握手被拒绝 —— 通常是 Access Token 不匹配，或服务端没开在 127.0.0.1"),
      );
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") {
          finish("端口没有服务在监听 —— NapCat 大概率没启动，或 OneBot11 服务没开启");
          return;
        }
        if (error.code === "ENOTFOUND" || error.code === "EADDRNOTAVAIL") {
          finish(`主机地址无效（${error.code}）`);
          return;
        }
        finish(`网络错误 ${error.code ?? error.message}`);
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* 消息段工具                                                          */
/* ------------------------------------------------------------------ */

/** undici 的 ErrorEvent 把原始错误放在 .error 上，.message 常常是空的。 */
function describeSocketError(event: Event): string {
  const carrier = event as unknown as { message?: string; error?: unknown; type?: string };
  if (carrier.message?.trim()) return carrier.message.trim();
  if (carrier.error instanceof Error && carrier.error.message.trim()) return carrier.error.message.trim();
  if (typeof carrier.error === "string" && carrier.error.trim()) return carrier.error.trim();
  return carrier.type ? `WebSocket ${carrier.type}` : "WebSocket 连接错误";
}

function describeConnectFailure(address: string, detail: string): string {
  const hint = /ECONNREFUSED|refused|connect/i.test(detail)
    ? "（目标端口没有服务在监听）"
    : /401|403|Unauthorized|Forbidden/i.test(detail)
      ? "（Access Token 不匹配）"
      : "";
  return `连接 NapCat 失败 ${address}${hint}：${detail}`;
}

export function asSegments(message: unknown): Segment[] {
  if (Array.isArray(message)) return message as Segment[];
  if (typeof message === "string") return [{ type: "text", data: { text: message } }];
  return [];
}

/** 把 OneBot11 消息段渲染成给模型看的纯文本。 */
export function segmentsToText(segments: Segment[], selfId: string): string {
  const parts: string[] = [];
  for (const segment of segments) {
    const data = (segment.data ?? {}) as Record<string, unknown>;
    switch (segment.type) {
      case "text":
        parts.push(String(data.text ?? ""));
        break;
      case "at": {
        const qq = String(data.qq ?? "");
        if (qq && qq !== selfId) parts.push(`@${data.name ?? qq}`);
        break;
      }
      case "image":
        parts.push("[图片]");
        break;
      case "face":
        parts.push("[表情]");
        break;
      case "record":
        parts.push("[语音]");
        break;
      case "video":
        parts.push("[视频]");
        break;
      case "file":
        parts.push(`[文件 ${String(data.name ?? data.file ?? "")}]`);
        break;
      case "reply": {
        const quoted = typeof data.text === "string" ? data.text.slice(0, 100) : "";
        parts.push(quoted ? `\n[引用] ${quoted}\n` : "\n[引用消息]\n");
        break;
      }
      case "forward":
        parts.push("[合并转发消息]");
        break;
      case "json":
      case "xml":
        parts.push(`[${segment.type}卡片]`);
        break;
      default:
        break;
    }
  }
  return parts.join("").trim();
}

export function isMentioned(segments: Segment[], selfId: string): boolean {
  return segments.some(
    (segment) =>
      segment.type === "at" &&
      (String(segment.data?.qq ?? "") === selfId || String(segment.data?.qq ?? "") === "all"),
  );
}

export function extractImages(segments: Segment[]): Array<Record<string, unknown>> {
  return segments.filter((s) => s.type === "image").map((s) => (s.data ?? {}) as Record<string, unknown>);
}

/** 把 @bot 的段落去掉，避免把 "CQ at" 送给模型当正文。 */
export function stripSelfMentions(segments: Segment[], selfId: string): Segment[] {
  return segments.filter(
    (segment) => !(segment.type === "at" && String(segment.data?.qq ?? "") === selfId),
  );
}
