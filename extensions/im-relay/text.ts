/**
 * 文本处理：分段、markdown 清理、聊天键、消息去重键。
 *
 * 微信不渲染 markdown，直接发 `**粗体**` 会看到星号；
 * QQ 客户端同样不渲染。所以在回传前统一转成纯文本。
 */

/** 按最大长度切分文本，优先在换行/句末断开，避免把代码块切坏得太难看。 */
export function segmentText(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (maxChars <= 0) return [normalized];
  if (normalized.length <= maxChars) return [normalized];

  const out: string[] = [];
  let rest = normalized;
  while (rest.length > maxChars) {
    let cut = -1;
    // 优先在空行处断开
    const blank = rest.lastIndexOf("\n\n", maxChars);
    if (blank > maxChars * 0.4) cut = blank + 1;
    if (cut < 0) {
      const line = rest.lastIndexOf("\n", maxChars);
      if (line > maxChars * 0.4) cut = line + 1;
    }
    if (cut < 0) {
      const sentence = Math.max(
        rest.lastIndexOf("。", maxChars),
        rest.lastIndexOf("！", maxChars),
        rest.lastIndexOf("？", maxChars),
        rest.lastIndexOf(". ", maxChars),
      );
      if (sentence > maxChars * 0.5) cut = sentence + 1;
    }
    if (cut < 0) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * Markdown → 纯文本。
 * 保守处理：只去掉明显会"露出符号"的标记，不动代码块内容。
 */
export function stripMarkdown(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      const lang = line.replace(/^\s*```/, "").trim();
      if (!inFence && lang) out.push("");
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    let text = line;
    // 标题
    text = text.replace(/^\s{0,3}#{1,6}\s+/, "");
    // 引用
    text = text.replace(/^\s{0,3}>\s?/, "");
    // 无序列表
    text = text.replace(/^(\s*)[-*+]\s+/, "$1• ");
    // 行内代码
    text = text.replace(/`([^`]+)`/g, "$1");
    // 粗体 / 斜体 / 删除线
    text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
    text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
    text = text.replace(/___([^_]+)___/g, "$1");
    text = text.replace(/__([^_]+)__/g, "$1");
    text = text.replace(/~~([^~]+)~~/g, "$1");
    // 链接 [text](url) → text (url)；图片 ![alt](url) → [图片]
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string) => (alt ? `[图片:${alt}]` : "[图片]"));
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
    // 分隔线
    text = text.replace(/^\s*([-*_])\1{2,}\s*$/, "———");
    out.push(text);
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 去掉会在 IM 里显得突兀的控制字符（保留换行与制表符）。 */
export function sanitize(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** 统一 IM 回复的最终形态。 */
export function formatReply(input: string, maxChars: number): string[] {
  return segmentText(stripMarkdown(sanitize(input)), maxChars);
}

/** 稳定消息去重键。 */
export function dedupeKey(channel: string, parts: Array<string | number | undefined>): string {
  const tail = parts.filter((p) => p !== undefined && p !== "").join(":");
  return tail ? `${channel}:${tail}` : `${channel}:${Date.now()}:${Math.random()}`;
}

/** LRU 去重集合。 */
export class DedupeSet {
  private readonly seen = new Map<string, number>();
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(capacity = 50_000, ttlMs = 30 * 60 * 1000) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  /** 返回 true 表示这是新键（应当处理）。 */
  add(key: string): boolean {
    const now = Date.now();
    const existing = this.seen.get(key);
    if (existing !== undefined && now - existing < this.ttlMs) {
      this.seen.set(key, now);
      return false;
    }
    this.seen.set(key, now);
    if (this.seen.size > this.capacity) this.evict(now);
    return true;
  }

  private evict(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at >= this.ttlMs || this.seen.size > this.capacity) this.seen.delete(key);
      if (this.seen.size <= this.capacity * 0.8) break;
    }
  }
}

/** 滑动窗口限流：同一 key 每分钟最多 n 次。 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  /** 返回 true 表示允许。 */
  allow(key: string): boolean {
    if (this.perMinute <= 0) return true;
    const now = Date.now();
    const windowStart = now - 60_000;
    const list = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (list.length >= this.perMinute) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5_000) {
      for (const [k, v] of this.hits) {
        if (!v.some((t) => t > windowStart)) this.hits.delete(k);
      }
    }
    return true;
  }
}

/** 相对时间，用于日志与 /status。 */
export function humanAge(from: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/** 人类可读的文件大小，用于回执与日志。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}
