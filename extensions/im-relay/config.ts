/**
 * pi-im-relay 配置与路径
 *
 * 所有运行期数据集中在 <agentDir>/im-relay/ 下，不污染 pi 的 sessions / settings：
 *   im-relay/config.json                  用户配置
 *   im-relay/state/wechat-session.json    微信 iLink 凭据 + 长轮询游标
 *   im-relay/state/chat-map.json          会话备注（哪个 IM 会话最近说过什么）
 *   im-relay/logs/im-relay.log            运行日志
 */
import { homedir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import path from "node:path";

export function agentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".pi", "agent");
}

export const DATA_DIR = join(agentDir(), "im-relay");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const STATE_DIR = join(DATA_DIR, "state");
export const LOG_DIR = join(DATA_DIR, "logs");
export const LOG_FILE = join(LOG_DIR, "im-relay.log");
export const WECHAT_SESSION_FILE = join(STATE_DIR, "wechat-session.json");
export const CHAT_MAP_FILE = join(STATE_DIR, "chat-map.json");

export type ProgressMode = "off" | "live";

export interface QqConfig {
  enabled: boolean;
  /** NapCat OneBot11 WebSocket 服务地址（本机回环，无需公网） */
  host: string;
  port: number;
  /** OneBot11 access token；留空表示 NapCat 未设置 token */
  token: string;
  /** 私聊白名单：QQ 号字符串 */
  allowUsers: string[];
  /** 群白名单：群号字符串。空 = 所有群都不响应 */
  allowGroups: string[];
  /** 群聊触发方式：mention = 只有 @bot 才响应；all = 群里所有消息都响应 */
  groupTrigger: "mention" | "all";
  /** 是否把 agent 的中间工具调用进度实时发到 QQ */
  progress: ProgressMode;
}

export interface WechatConfig {
  enabled: boolean;
  /** iLink 服务地址，正常无需修改 */
  baseUrl: string;
  /** 白名单：iLink 用户 id（形如 xxx@im.wechat）。空 = 不响应任何人 */
  allowUsers: string[];
  /**
   * 微信官方条款：用户发消息后 24h 内最多 10 条主动消息（含回复）。
   * 因此默认关闭实时进度，只回最终结果。
   */
  progress: ProgressMode;
}

export interface ImRelayConfig {
  /** 总开关；可用 /im-relay off 临时关闭 */
  enabled: boolean;
  /** 单条回复最大字符，超出自动分段 */
  maxReplyChars: number;
  /** 待处理消息队列上限，超出丢弃最旧的 */
  queueLimit: number;
  /** 每用户每分钟入站消息上限（防刷） */
  rateLimitPerMinute: number;
  /** 未在白名单里的用户发消息时，是否回复一条"你的 ID 是 xxx" */
  announceUnpaired: boolean;
  /** 是否把本体终端里输入的 prompt 也同步到 IM（镜像模式） */
  mirrorLocalInput: boolean;
  channels: {
    qq: QqConfig;
    wechat: WechatConfig;
  };
}

export const DEFAULT_CONFIG: ImRelayConfig = {
  enabled: true,
  maxReplyChars: 1500,
  queueLimit: 20,
  rateLimitPerMinute: 20,
  announceUnpaired: true,
  mirrorLocalInput: false,
  channels: {
    qq: {
      enabled: true,
      host: "127.0.0.1",
      port: 3001,
      token: "",
      allowUsers: [],
      allowGroups: [],
      groupTrigger: "mention",
      progress: "live",
    },
    wechat: {
      enabled: false,
      baseUrl: "https://ilinkai.weixin.qq.com",
      allowUsers: [],
      progress: "off",
    },
  },
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== "object") return patch as T;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = key in out ? deepMerge((base as Record<string, unknown>)[key], value) : value;
  }
  return out as T;
}

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, STATE_DIR, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(): { config: ImRelayConfig; created: boolean } {
  ensureDirs();
  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return { config: DEFAULT_CONFIG, created: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as unknown;
    return { config: deepMerge(DEFAULT_CONFIG, raw), created: false };
  } catch {
    // 配置损坏时备份后回退默认值，避免直接让扩展崩掉
    try {
      fs.renameSync(CONFIG_FILE, `${CONFIG_FILE}.broken-${Date.now()}`);
    } catch {
      /* ignore */
    }
    saveConfig(DEFAULT_CONFIG);
    return { config: DEFAULT_CONFIG, created: true };
  }
}

/** 原子写配置（先写临时文件再 rename），避免半截 JSON。 */
export function saveConfig(config: ImRelayConfig): void {
  ensureDirs();
  const tmp = path.join(DATA_DIR, `.config.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

export function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  ensureDirs();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
