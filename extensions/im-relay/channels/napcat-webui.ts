/**
 * NapCat WebUI 客户端 —— 让 QQ 的扫码登录和微信走同一条路。
 *
 * 背景：QQ 通道本身只连 NapCat 的 OneBot11 WebSocket，那里没有任何登录能力。
 * 二维码只存在于 NapCat 自己的 WebUI（默认 127.0.0.1:6099）上。以前的做法是让用户
 * 自己开 NapCat 扫码、或者去扒 console.log / cache/qrcode.png —— 又脆又难用。
 *
 * WebUI 提供了一组结构化的登录 API（本文件封装的就是这几个）：
 *
 *   POST /api/auth/login                  { hash }            → { Credential }
 *   POST /api/QQLogin/GetQQLoginQrcode    空                   → { qrcode: "https://txz.qq.com/p?k=..." }
 *   POST /api/QQLogin/CheckLoginStatus    空                   → { isLogin, loginPhase, qrcodeurl, loginError, ... }
 *   POST /api/QQLogin/RefreshQRcode       空                   → { qrcodeurl } | { restarting: true }
 *
 * 两个必须处理的现实细节：
 *  1. **token 要过一层哈希**：WebUI 不收明文 token，收的是 `sha256(token + ".napcat")`。
 *  2. **登录接口有限流**（webui.json 的 loginRate，默认 3 次/分钟），所以凭证要缓存复用
 *     （凭证本身 1 小时内有效），只在真的 Unauthorized 时才重新登录一次。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createLogger, errorText } from "../log.ts";
import type { QqWebuiConfig } from "../config.ts";

const log = createLogger("napcat-webui");

export const DEFAULT_NAPCAT_WEBUI_FILE = "D:\\NapCat\\NapCat.Shell\\config\\webui.json";
export const DEFAULT_WEBUI_HOST = "127.0.0.1";
export const DEFAULT_WEBUI_PORT = 6099;

/** NapCat 登录流程阶段（来自 NapCat 源码里的 phase 取值）。 */
export type NapcatLoginPhase =
  | "none"
  | "waiting_qrcode"
  | "generating_qrcode"
  | "qrcode_scanned"
  | "initializing"
  | "ready"
  | "offline"
  | "reconnecting"
  | string;

export interface NapcatLoginStatus {
  isLogin: boolean;
  isOffline: boolean;
  loginPhase: NapcatLoginPhase;
  qrLoginAccepted: boolean;
  /** 账号已登录且 OneBot 核心真的在线（可以收发消息） */
  coreReady: boolean;
  qrcodeurl: string;
  loginError: string;
}

export interface NapcatWebuiOptions {
  host: string;
  port: number;
  token: string;
  /** token 从哪里读到的，仅用于诊断提示 */
  source?: string;
  /** 注入以便测试 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type NapcatWebuiErrorKind = "unreachable" | "auth" | "api";

export class NapcatWebuiError extends Error {
  readonly kind: NapcatWebuiErrorKind;

  constructor(message: string, kind: NapcatWebuiErrorKind) {
    super(message);
    this.name = "NapcatWebuiError";
    this.kind = kind;
  }
}

/**
 * NapCat 自定义的密码哈希：`sha256(token + ".napcat")` 的十六进制。
 * 与 WebUI 里 `generatePasswordHash()` 的实现保持一致。
 */
export function webuiPasswordHash(token: string): string {
  return createHash("sha256").update(`${token}.napcat`).digest("hex");
}

/**
 * 解析 WebUI 连接参数。优先级：显式配置 > configFile > 环境变量 > 内置默认路径。
 *
 * 之所以要自动读文件：token 是 NapCat 自己生成的一串随机值，让用户手动同步到
 * 两份配置里既多余又容易写错。指向 `webui.json` 一个路径就够了。
 */
export function resolveWebuiOptions(config: QqWebuiConfig | undefined): NapcatWebuiOptions {
  let host = config?.host?.trim() ?? "";
  let port = Number(config?.port ?? 0);
  let token = config?.token?.trim() ?? "";
  let source = token ? "config.json" : "";

  const candidates = [
    config?.configFile?.trim(),
    process.env.NAPCAT_WEBUI_CONFIG?.trim(),
    process.env.NAPCAT_DIR
      ? path.join(process.env.NAPCAT_DIR, "NapCat.Shell", "config", "webui.json")
      : "",
    DEFAULT_NAPCAT_WEBUI_FILE,
  ].filter((value): value is string => Boolean(value));

  for (const file of candidates) {
    if (token && host && port) break;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        host?: string;
        port?: number;
        token?: string;
      };
      if (!host && parsed.host?.trim()) host = parsed.host.trim();
      if (!port && parsed.port) port = Number(parsed.port);
      if (!token && parsed.token?.trim()) {
        token = parsed.token.trim();
        source = file;
      }
    } catch {
      // 文件不存在/不可解析：试下一个候选
    }
  }

  return {
    host: host || DEFAULT_WEBUI_HOST,
    port: port || DEFAULT_WEBUI_PORT,
    token,
    source,
  };
}

interface WebuiEnvelope {
  code?: number;
  message?: string;
  data?: unknown;
}

/** 已经是登录状态（NapCat 在已登录时会对取码接口返回这个）。 */
export function isAlreadyLoggedIn(error: unknown): boolean {
  return error instanceof Error && /is\s*logined|already\s*login/i.test(error.message);
}

function normalizeStatus(data: unknown): NapcatLoginStatus {
  const raw = (data ?? {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const bool = (key: string): boolean => raw[key] === true;
  return {
    isLogin: bool("isLogin"),
    isOffline: bool("isOffline"),
    loginPhase: str("loginPhase") || "none",
    qrLoginAccepted: bool("qrLoginAccepted"),
    coreReady: bool("coreReady"),
    qrcodeurl: str("qrcodeurl"),
    loginError: str("loginError"),
  };
}

export class NapcatWebuiClient {
  private readonly options: NapcatWebuiOptions;
  private credential: string | undefined;

  constructor(options: NapcatWebuiOptions) {
    this.options = options;
  }

  get baseUrl(): string {
    return `http://${this.options.host}:${this.options.port}`;
  }

  get hasToken(): boolean {
    return Boolean(this.options.token);
  }

  get tokenSource(): string | undefined {
    return this.options.source;
  }

  /** 丢弃缓存的凭证（凭证失效或用户改了 token 时调用）。 */
  reset(): void {
    this.credential = undefined;
  }

  /**
   * WebUI 是否在线。**故意不带凭证** —— 只要能拿到一个合法 JSON 响应
   * （哪怕是 `{"code":-1,"message":"Unauthorized"}`），就说明 WebUI 在监听。
   */
  async isReachable(timeoutMs = 1800): Promise<boolean> {
    try {
      const response = await this.rawFetch("/api/QQLogin/CheckLoginStatus", {}, undefined, timeoutMs);
      await response.text();
      return true;
    } catch {
      return false;
    }
  }

  /** 当前登录状态（顺带完成鉴权）。 */
  async status(): Promise<NapcatLoginStatus> {
    return normalizeStatus(await this.request("/api/QQLogin/CheckLoginStatus", {}));
  }

  /** 取当前二维码链接。已登录时 NapCat 会报错，调用方用 isAlreadyLoggedIn() 区分。 */
  async fetchQrcodeUrl(): Promise<string> {
    const data = (await this.request("/api/QQLogin/GetQQLoginQrcode", {})) as { qrcode?: string } | undefined;
    const url = data?.qrcode?.trim();
    if (!url) {
      throw new NapcatWebuiError("NapCat 没有返回二维码链接（可能仍在生成中，请稍后重试）", "api");
    }
    return url;
  }

  /** 强制换一张新码。NapCat 正在重启登录服务时返回 restarting=true。 */
  async refreshQrcode(): Promise<{ url: string; restarting: boolean }> {
    const data = (await this.request("/api/QQLogin/RefreshQRcode", {})) as
      | { qrcodeurl?: string; restarting?: boolean }
      | undefined;
    return { url: data?.qrcodeurl?.trim() ?? "", restarting: data?.restarting === true };
  }

  /* ------------------------------------------------------------------ */

  /** 执行一次 WebUI 调用，必要时先登录；凭证失效时只重登一次（接口有限流）。 */
  private async request(endpoint: string, body: unknown, retry = true): Promise<unknown> {
    if (!this.credential) await this.login();

    let response: Response;
    try {
      response = await this.rawFetch(endpoint, body, this.credential);
    } catch (error) {
      throw new NapcatWebuiError(
        `无法连接 NapCat WebUI（${this.baseUrl}）：${errorText(error)}`,
        "unreachable",
      );
    }

    let payload: WebuiEnvelope;
    try {
      payload = JSON.parse(await response.text()) as WebuiEnvelope;
    } catch {
      throw new NapcatWebuiError(
        `NapCat WebUI 返回了非 JSON 响应（HTTP ${response.status}，地址 ${this.baseUrl}）`,
        "api",
      );
    }

    if (payload.code === 0) return payload.data;

    const message = String(payload.message ?? "未知错误");
    if (/unauthorized/i.test(message) && retry) {
      log.info("NapCat WebUI 凭证已失效，重新登录一次");
      this.credential = undefined;
      return this.request(endpoint, body, false);
    }
    throw new NapcatWebuiError(message, "api");
  }

  private async rawFetch(
    endpoint: string,
    body: unknown,
    credential?: string,
    timeoutMs = this.options.timeoutMs ?? 8000,
  ): Promise<Response> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (credential) headers.authorization = `Bearer ${credential}`;
    return doFetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** 用 token 换凭证并缓存（凭证 1 小时内有效，避免撞上 WebUI 的登录限流）。 */
  private async login(): Promise<void> {
    if (!this.options.token) {
      throw new NapcatWebuiError(
        "没有拿到 NapCat WebUI 的 token。请在 config.json 里填 channels.qq.webui.token，" +
          `或把 channels.qq.webui.configFile 指向 NapCat 的 ${DEFAULT_NAPCAT_WEBUI_FILE}`,
        "auth",
      );
    }

    let response: Response;
    try {
      response = await this.rawFetch("/api/auth/login", { hash: webuiPasswordHash(this.options.token) });
    } catch (error) {
      throw new NapcatWebuiError(
        `无法连接 NapCat WebUI（${this.baseUrl}）：${errorText(error)}。` +
          "请确认 NapCat 已启动，且 WebUI 开在配置的地址/端口上。",
        "unreachable",
      );
    }

    let payload: WebuiEnvelope;
    try {
      payload = JSON.parse(await response.text()) as WebuiEnvelope;
    } catch {
      throw new NapcatWebuiError(`NapCat WebUI 返回了非 JSON 响应（HTTP ${response.status}）`, "api");
    }

    const credential = (payload.data as { Credential?: string } | undefined)?.Credential;
    if (payload.code !== 0 || !credential) {
      const message = String(payload.message ?? "未知错误");
      const where = this.options.source ? `（token 读自 ${this.options.source}）` : "";
      throw new NapcatWebuiError(
        `NapCat WebUI 登录失败：${message}${where}。请核对 token 是否为 NapCat 当前 WebUI 的密码。`,
        "auth",
      );
    }
    this.credential = credential;
    log.debug(`已获取 NapCat WebUI 凭证（token 来源：${this.options.source ?? "配置"}）`);
  }
}
