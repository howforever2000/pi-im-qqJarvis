/**
 * QQ 聊天记录读取 —— 给「长会话记忆」用。
 *
 * 解决的具体问题：pi 的上下文会被压缩，早期对话会从窗口里消失；而 IM 侧的聊天记录
 * 是一份**独立且完整**的副本。所以在新会话 / 刚登录时把最近 N 条捞回来垫进上下文，
 * agent 就不至于「忘了刚才聊过什么」。
 *
 * 为什么不用事件监听：实测 NapCat 的 OneBot11 **事件只推给一条连接**（先连上的那条，
 * 也就是 pi-im-relay 自己），第二个客户端收不到 message 事件。
 * 但 **action 调用是通的** —— 所以这里走 `get_friend_msg_history` 主动拉。
 *
 * 注意：这个方法读到的是**两个方向的全部消息**（对方发的 + 自己发的），
 * 所以能用 sender.user_id 判断哪条是自己说的，避免把「我自己说过的话」当成用户的话。
 */
import type { OneBotCaller } from "./qzone.ts";
import { createLogger, errorText } from "./log.ts";

const log = createLogger("chatlog");

export interface ChatLine {
  at: number;
  /** true = 机器人（本机登录的那个号）说的 */
  fromSelf: boolean;
  who: string;
  text: string;
}

/** 非文本消息段 → 占位符。宁可给个占位，也别让记录里出现空洞。 */
function segmentText(seg: { type?: string; data?: Record<string, unknown> }): string {
  const d = (seg.data ?? {}) as Record<string, unknown>;
  switch (seg.type) {
    case "text":
      return String(d.text ?? "");
    case "image":
      return "[图片]";
    case "file":
      return `[文件：${String(d.file ?? "未知")}]`;
    case "face":
      return "[表情]";
    case "record":
      return "[语音]";
    case "video":
      return "[视频]";
    case "at":
      return `@${String(d.qq ?? "")}`;
    case "reply":
      return "";
    case "forward":
      return "[合并转发]";
    case "json":
    case "xml":
      return "[卡片消息]";
    case "mface":
      return "[表情]";
    default:
      return seg.type ? `[${seg.type}]` : "";
  }
}

function lineText(message: unknown): string {
  if (!Array.isArray(message)) return "";
  return message
    .map((s) => segmentText(s as { type?: string; data?: Record<string, unknown> }))
    .filter(Boolean)
    .join("")
    .trim();
}

interface RawHistoryMessage {
  time?: number;
  user_id?: number | string;
  sender?: { user_id?: number | string; nickname?: string; card?: string };
  message?: unknown;
  raw_message?: string;
}

/**
 * 拉最近 `count` 条私聊记录（含双向）。
 *
 * 永不抛错：读不到就返回空数组 + error，由调用方决定是否降级。
 */
export interface RecentChatOptions {
  /** private = 好友私聊（get_friend_msg_history）；group = 群聊（get_group_msg_history） */
  kind?: "private" | "group";
  id: string;
  count: number;
}

/**
 * 拉最近 `count` 条聊天记录（含双向）。
 *
 * 永不抛错：读不到就返回空数组 + error，由调用方决定是否降级。
 */
export async function readRecentChat(
  call: OneBotCaller,
  options: RecentChatOptions,
): Promise<{ lines: ChatLine[]; error?: string }> {
  const { kind = "private", id, count } = options;
  if (!id || count <= 0) return { lines: [] };
  try {
    let selfUin = "";
    try {
      const me = await call<{ user_id?: number | string }>("get_login_info", {});
      selfUin = String(me?.user_id ?? "");
    } catch {
      /* 拿不到 self 也还能继续，只是判断方向会退化成按 sender 名字 */
    }

    const res =
      kind === "group"
        ? await call<{ messages?: RawHistoryMessage[] }>("get_group_msg_history", {
            group_id: String(id),
            count,
          })
        : await call<{ messages?: RawHistoryMessage[] }>("get_friend_msg_history", {
            user_id: String(id),
            count,
          });
    const list = res?.messages ?? [];

    const lines: ChatLine[] = [];
    for (const m of list) {
      const text = lineText(m.message) || String(m.raw_message ?? "").trim();
      if (!text) continue;
      const senderId = String(m.sender?.user_id ?? m.user_id ?? "");
      lines.push({
        at: Number(m.time ?? 0) * 1000,
        fromSelf: Boolean(selfUin) && senderId === selfUin,
        who: String(m.sender?.card || m.sender?.nickname || senderId || "?"),
        text,
      });
    }
    // 接口给的是时间正序，保险起见再排一次
    lines.sort((a, b) => a.at - b.at);
    log.info(`已读聊天记录 ${lines.length} 条（${kind} ${id}）`);
    return { lines };
  } catch (error) {
    const message = errorText(error);
    log.warn(`读聊天记录失败：${message}`);
    return { lines: [], error: message };
  }
}

/** 压成注入用的一行行文本。 */
export function formatChatLines(lines: ChatLine[], maxChars = 1200): string {
  const fmt = (ms: number) => {
    if (!ms) return "??:??";
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const out: string[] = [];
  let used = 0;
  // 从最新往回取，保证超长时保留的是最靠近当下的内容
  for (const l of [...lines].reverse()) {
    const row = `[${fmt(l.at)}] ${l.fromSelf ? "我" : l.who}: ${l.text.replace(/\s+/g, " ").slice(0, 160)}`;
    if (used + row.length > maxChars && out.length > 0) break;
    out.unshift(row);
    used += row.length;
  }
  return out.join("\n");
}
