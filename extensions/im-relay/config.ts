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
/** QQ 登录二维码的文本兜底（图片投递不可用时用链接） */
export const QQ_QR_FILE = join(STATE_DIR, "qq-login-qrcode.txt");
/** 人可读的“工作约定”，每条消息前注入给模型；用户可直接编辑 */
export const AGENT_MD_FILE = join(DATA_DIR, "AGENT.md");
/** 空间内容缓存（避免每条消息都打一次网络） */
export const QZONE_CACHE_FILE = join(STATE_DIR, "qzone-cache.json");

/**
 * NapCat WebUI 的连接参数。
 *
 * 为什么需要它：QQ 的扫码登录要和微信走同一条路（二维码进对话，而不是让用户
 * 自己去 NapCat 界面扫），而 NapCat 只在 WebUI 上暴露了登录 API。
 * token 一般不用手填 —— 指向 NapCat 自己的 webui.json 自动读即可。
 */
export interface QqWebuiConfig {
  enabled: boolean;
  /** NapCat WebUI 地址（本机回环） */
  host: string;
  /** NapCat WebUI 端口，默认 6099 */
  port: number;
  /** 显式 token；留空则从 configFile / 环境变量里读 */
  token: string;
  /** NapCat 的 webui.json 路径；留空则用默认路径与环境变量探测 */
  configFile: string;
}

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
  /** NapCat WebUI：用于「在 pi 里扫码登录 QQ」 */
  webui: QqWebuiConfig;
  /**
   * 「发『QQ登录』就默认换号」：踢掉当前登录的 QQ、清票据、重启 NapCat。
   * 关掉它就恢复成老行为（已登录则直接复用）。
   */
  switchAccount: import("./channels/napcat-process.ts").SwitchAccountConfig;
}

export interface WechatConfig {
  enabled: boolean;
  /** iLink 服务地址，正常无需修改 */
  baseUrl: string;
  /** 白名单：iLink 用户 id（形如 xxx@im.wechat）。空 = 不响应任何人 */
  allowUsers: string[];
  /**
   * 「发『微信登录』= 换号」：先注销当前凭据（备份后清状态文件）再取新码。
   *
   * 为什么需要：微信侧的机器人身份是扫码时在腾讯云端新建的，凭据存在
   * `wechat-session.json` 里。不清掉就只会重发同一张码，换不了号。
   * 关掉它就恢复成老行为（仅重发当前二维码）。
   */
  switchAccount: boolean;
  /**
   * 微信官方条款：用户发消息后 24h 内最多 10 条主动消息（含回复）。
   * 因此默认关闭实时进度，只回最终结果。
   */
  progress: ProgressMode;
}

/**
 * 相册：收到的图片落到本机目录。
 *
 * 为什么放在扩展里而不是靠 agent 临场处理：agent 的"记住这个约定"会随着上下文
 * 压缩而丢失，而"用户发的图去哪了"是不能丢的事。
 */
export interface AlbumConfig {
  enabled: boolean;
  /** 目标目录（相册） */
  dir: string;
  /** 文件名模板，支持 {yyyy} {MM} {dd} {HH} {mm} {ss} 与 {n}（同秒序号） */
  namePattern: string;
  /** 回执：存好后在注入给模型的消息头部加一行已存路径 */
  announce: boolean;
  /** 同一张图（按内容哈希）反复发时是否只存一份 */
  dedupe: boolean;
}

/**
 * 记忆：工作前先读一份"我是谁 / 我们约好了什么"，避免 agent 失忆。
 *
 * 两个来源：
 *   1. 本机 AGENT.md —— 用户可手改的硬约定
 *   2. QQ空间的说说 —— 最近 N 条 + 历史抽样 M 条；其中以 identityMarker 开头的那条
 *      视为"身份定位 prompt"。
 * 不用置顶是因为 QQ 空间的 settop 接口在本项目实测不可用（HTTP 500），而且
 * 列表接口也不返回任何"是否置顶"字段，读了也认不出来。
 */
export interface MemoryConfig {
  enabled: boolean;
  /** 注入给模型的总长度上限（字符），超出截断 */
  maxChars: number;
  /** 读空间的最近条数 */
  recent: number;
  /** 读空间的历史抽样条数（从最旧的开始取） */
  sample: number;
  /** 空间内容缓存秒数，避免每条消息都打一次网络 */
  cacheSeconds: number;
  /** 身份定位说说的开头标记 */
  identityMarker: string;
  /**
   * 新会话 / 刚登录时，先拉最近的 IM 聊天记录垫进上下文。
   *
   * 为什么需要：pi 的上下文会被压缩，早期对话会从窗口里消失；而 IM 侧的
   * 聊天记录是一份独立且完整的副本，把它们捞回来就能给长会话保持记忆。
   */
  chatLog: boolean;
  /** 拉多少条（含双向） */
  chatLogCount: number;
  /**
   * 每隔多少条入站消息重新完整注入一次记忆。
   *
   * 为什么要这个：完整记忆（约定 + 身份 + 聊天记录 + 说说）体积不小，
   * 每条消息都塞一遍很贵；而完全不重塞又会在上下文被压缩后失忆。
   * 所以策略是「新会话/刚登录时必发一次，之后每隔 N 条补发一次」。
   * 设为 0 表示只在真正需要（新会话/刚登录）时注入。
   */
  refreshEveryMessages: number;
}

/** 长文转 PDF 出站。 */
export interface PdfConfig {
  enabled: boolean;
  /** 正文超过这个字数就建议改走 PDF（写进工具说明，由 agent 判断） */
  threshold: number;
  /** Chrome/Edge 可执行文件；留空则按内置候选列表自动探测 */
  browser: string;
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
  album: AlbumConfig;
  memory: MemoryConfig;
  pdf: PdfConfig;
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
  album: {
    enabled: true,
    dir: "D:\\YUAN HAO\\Pictures\\手机上传",
    namePattern: "QQ_{yyyy}{MM}{dd}_{HH}{mm}{ss}",
    announce: true,
    dedupe: true,
  },
  memory: {
    enabled: true,
    maxChars: 3000,
    recent: 5,
    sample: 5,
    cacheSeconds: 300,
    identityMarker: "[身份]",
    chatLog: true,
    chatLogCount: 10,
    refreshEveryMessages: 15,
  },
  pdf: {
    enabled: true,
    threshold: 300,
    browser: "",
  },
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
      webui: {
        enabled: true,
        host: "127.0.0.1",
        port: 6099,
        token: "",
        // NapCat 默认安装位置；存在就自动读取里面的 host/port/token
        configFile: "D:\\NapCat\\NapCat.Shell\\config\\webui.json",
      },
      switchAccount: {
        enabled: true,
        shellDir: "D:/NapCat/NapCat.Shell",
        qqDataDir: "",
        backupDir: "",
        restartDelayMs: 4000,
        bootTimeoutMs: 60_000,
      },
    },
    wechat: {
      enabled: false,
      baseUrl: "https://ilinkai.weixin.qq.com",
      allowUsers: [],
      switchAccount: true,
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
