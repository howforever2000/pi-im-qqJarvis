/**
 * 记忆组装：每次收到 IM 消息时，先给模型垫一段「我是谁 / 我们约好了什么 / 刚才聊了什么」。
 *
 * 三个来源：
 *   1. `<agentDir>/im-relay/AGENT.md` —— 人可读的工作约定，用户可以直接编辑
 *   2. QQ 空间的说说 —— 最近 N 条 + 历史抽样 M 条；带身份标记的那条优先当身份 prompt
 *   3. 最近的 IM 聊天记录 —— 长会话记忆的关键：pi 的上下文会被压缩，早期对话会从
 *      窗口里消失，而 IM 侧的聊天记录是一份独立且完整的副本
 *
 * 为什么要有这东西：agent 的上下文会被压缩、会话会换新，光靠「模型自己记得」
 * 是不可靠的。用户的原话是「这些操作细节写到扩展中去，避免记忆丢失」。
 *
 * 硬约束：**读记忆失败绝不能把消息处理带崩**，所以这里所有路径都退化成
 * 「能拿到多少算多少」，最坏情况返回空串。
 */
import fs from "node:fs";
import { AGENT_MD_FILE, DATA_DIR, type MemoryConfig } from "./config.ts";
import { createLogger, errorText } from "./log.ts";
import { readQzone, type OneBotCaller, type QzoneFeed } from "./qzone.ts";
import { formatChatLines, readRecentChat, type ChatLine } from "./chatlog.ts";

const log = createLogger("memory");

const DEFAULT_AGENT_MD = `# 工作约定

这份文件是给 agent 看的，扩展会在每条 IM 消息前把它垫进上下文。
你可以直接改它，改完自动生效（配置热加载）。

## 输出
- 结论超过 300 字、或者含表格 → 渲染成 PDF 发回，聊天里只留一段简短说明
- 一两句话能说清的，直接发文字，不要过度包装

## 图片
- 用户发来的图片自动存入相册目录，回执里会带上文件名
- 需要再次取回原图时，去相册目录找，不要重新问用户要

## 隐私
- QQ 空间的内容一律「部分好友可见 → 仅号主本人」
- 不要把聊天内容、文件路径、账号信息发到任何公开位置

## 安全
- 覆盖用户任何既有资料之前，先备份
- 不确定的操作先说明再执行
`;

/** 首次运行时落地一份默认约定。 */
export function ensureAgentMd(): string {
  try {
    if (!fs.existsSync(AGENT_MD_FILE)) {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(AGENT_MD_FILE, DEFAULT_AGENT_MD, { mode: 0o600 });
      log.info(`已生成默认工作约定：${AGENT_MD_FILE}`);
    }
    return fs.readFileSync(AGENT_MD_FILE, "utf8").trim();
  } catch (error) {
    log.warn(`读工作约定失败：${errorText(error)}`);
    return "";
  }
}

function fmtTime(ms: number): string {
  if (!ms) return "??-?? ??:??";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把一条说说压成一行摘要，控制体积。 */
function summarize(content: string, limit = 90): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 按预算裁剪一段文本，保留开头（开头是最重要的部分）。 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（此处按预算截断）`;
}

export interface MemorySnapshot {
  text: string;
  feed: QzoneFeed;
  chatLines: ChatLine[];
  agentMdBytes: number;
  truncated: boolean;
}

/**
 * 内存缓存，按 key 分槽。
 *
 * 之所以不是一个单变量：加上聊天记录后 key 里含了对端标识，
 * QQ 和微信交替来消息会互相把对方踹掉，导致每次都重新打网络。
 */
const MEMO_MAX = 4;
const memo = new Map<string, { at: number; snapshot: MemorySnapshot }>();

/**
 * 丢掉内存缓存。
 *
 * 两处会用到：测试；以及「新会话 / 通道刚登录」时主动失效 ——
 * 那正是用户要求「先把聊天记录读一遍」的时刻，不能让旧缓存顶掉。
 */
export function resetMemoryCache(): void {
  memo.clear();
}

export interface MemoryOptions {
  /** 缓存键；建议含通道与对端标识 */
  cacheKey?: string;
  /** 拉聊天记录的对端；不传就不拉 */
  peer?: { kind: "private" | "group"; id: string };
}

/**
 * 组装要垫进上下文的记忆文本。`cacheSeconds` 内直接复用上次结果。
 * 永不抛错。返回空字符串表示「什么记忆都没拿到」。
 */
export async function buildMemory(
  call: OneBotCaller,
  config: MemoryConfig,
  options: MemoryOptions = {},
): Promise<MemorySnapshot> {
  const cacheKey = options.cacheKey ?? "";
  const empty: MemorySnapshot = {
    text: "",
    feed: { uin: "", total: 0, nickname: "", posts: [], fromCache: false, readAt: Date.now() },
    chatLines: [],
    agentMdBytes: 0,
    truncated: false,
  };
  if (!config.enabled) return empty;

  const hit = memo.get(cacheKey);
  if (hit && Date.now() - hit.at < config.cacheSeconds * 1000) return hit.snapshot;

  const blocks: string[] = [];
  /**
   * 每个块各自分到一份预算。
   *
   * 为什么不能只靠末尾的全局截断：AGENT.md 是用户自己维护的，写长一点很正常
   * （实测就写到了 3KB），一份全局截断会让它把预算吃光，排在后面的
   * 「聊天记录」整段消失 —— 而那恰恰是长会话记忆的命门。
   */
  const budget = (kind: "agent" | "identity" | "chat" | "feed"): number => {
    const share = { agent: 0.35, identity: 0.1, chat: 0.4, feed: 0.15 }[kind];
    return Math.max(200, Math.floor(config.maxChars * share));
  };
  let agentMd = "";
  let feed = empty.feed;
  let chatLines: ChatLine[] = [];
  let chatError: string | undefined;

  try {
    agentMd = ensureAgentMd();
  } catch (error) {
    log.warn(`读工作约定失败：${errorText(error)}`);
  }
  try {
    feed = await readQzone(call, config);
  } catch (error) {
    log.warn(`读主页失败：${errorText(error)}`);
  }
  if (config.chatLog && options.peer?.id) {
    try {
      const chat = await readRecentChat(call, {
        kind: options.peer.kind,
        id: options.peer.id,
        count: config.chatLogCount,
      });
      chatLines = chat.lines;
      chatError = chat.error;
    } catch (error) {
      chatError = errorText(error);
      log.warn(`读聊天记录失败：${chatError}`);
    }
  }

  if (agentMd) {
    // AGENT.md 自己顶上有 `# 工作约定`，再套一层就会连出两个标题，去一个
    const body = agentMd.replace(/^#\s+.*\n?/, "").trim();
    // 带上完整版路径：文献一般比预算长，被截掉的部分让 agent 自己按需去读
    blocks.push(
      `## 工作约定（完整版：${AGENT_MD_FILE}；下面是开头，需要更多就直接读文件）\n` +
        clip(body || agentMd, budget("agent")),
    );
  }

  if (feed.identity?.content) {
    // 身份说说的标记去掉，正文本身就是 prompt
    const body = feed.identity.content.slice(config.identityMarker.length).trim();
    if (body) blocks.push(`## 我的身份定位\n${clip(body, budget("identity"))}`);
  }

  // 聊天记录排在主页说说**前面**：截断是从后往前砍的，而「接上前文」
  // 是长会话记忆的命门，不能被一堆说说摘要把位置挤掉。
  if (chatLines.length) {
    // 这里把预算交给 formatChatLines：它超长时是**从最旧的开始丢**，
    // 而 clip() 是保留开头 —— 对聊天记录来说方向正好相反，不能用 clip。
    blocks.push(
      `## 最近的聊天记录（最近 ${chatLines.length} 条，用来接上前文；「我」指本机器人）\n` +
        formatChatLines(chatLines, budget("chat")),
    );
  } else if (chatError) {
    blocks.push(`## 最近的聊天记录\n（本次读取失败：${chatError}）`);
  }

  if (feed.posts.length) {
    const lines = feed.posts.map((p, i) => {
      const tags = [fmtTime(p.createdAt)];
      if (p.pics) tags.push(`${p.pics}图`);
      if (feed.identity && p.tid === feed.identity.tid) tags.push("身份");
      return `${i + 1}. [${tags.join(" ")}] ${summarize(p.content)}`;
    });
    blocks.push(
      `## 我主页的说说（共 ${feed.total} 条，本次取回 ${feed.posts.length} 条${
        feed.fromCache ? "，来自缓存" : ""
      }）\n${clip(lines.join("\n"), budget("feed"))}`,
    );
  } else if (feed.error) {
    blocks.push(`## 我主页的说说\n（本次读取失败：${feed.error}）`);
  }

  let text = blocks.join("\n\n").trim();
  let truncated = false;
  if (text.length > config.maxChars) {
    text = `${text.slice(0, config.maxChars)}\n…（记忆已截断）`;
    truncated = true;
  }

  const snapshot: MemorySnapshot = { text, feed, chatLines, agentMdBytes: agentMd.length, truncated };
  memo.set(cacheKey, { at: Date.now(), snapshot });
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
  return snapshot;
}
