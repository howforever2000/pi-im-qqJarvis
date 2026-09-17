/**
 * 结构化日志：写 <agentDir>/im-relay/logs/im-relay.log，1MB 轮转，保留 3 份。
 *
 * 扩展运行在 pi 进程内，直接 console.log 会打乱 TUI 渲染，
 * 所以一律走文件；需要提示用户时用 ctx.ui.notify。
 */
import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, LOG_FILE } from "./config.ts";

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;

export type LogLevel = "debug" | "info" | "warn" | "error";

let stream: fs.WriteStream | undefined;
let streamBytes = 0;
let verbose = process.env.PI_IM_RELAY_DEBUG === "1";

function open(): fs.WriteStream | undefined {
  try {
    if (stream) return stream;
    // 日志目录可能还不存在（例如扩展被单独加载时），先确保目录存在，
    // 否则 createWriteStream 会在下一个 tick 抛 ENOENT 变成未捕获异常。
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : undefined;
    streamBytes = stat?.size ?? 0;
    if (streamBytes > MAX_BYTES) rotate();
    const next = fs.createWriteStream(LOG_FILE, { flags: "a", mode: 0o600 });
    next.on("error", () => {
      // 磁盘满 / 权限问题都不应该影响 pi 主流程
      stream = undefined;
    });
    stream = next;
    return stream;
  } catch {
    return undefined;
  }
}

function rotate(): void {
  try {
    stream?.end();
    stream = undefined;
    for (let i = KEEP - 1; i >= 1; i -= 1) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    streamBytes = 0;
  } catch {
    /* ignore */
  }
}

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function log(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (level === "debug" && !verbose) return;
  const time = new Date().toISOString();
  let line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (extra !== undefined) {
    try {
      line += ` ${JSON.stringify(extra)}`;
    } catch {
      line += " [unserializable]";
    }
  }
  const out = open();
  if (!out) return;
  if (streamBytes + line.length + 1 > MAX_BYTES) {
    rotate();
    open();
  }
  streamBytes += line.length + 1;
  stream?.write(`${line}\n`);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => log("debug", scope, message, extra),
    info: (message: string, extra?: unknown) => log("info", scope, message, extra),
    warn: (message: string, extra?: unknown) => log("warn", scope, message, extra),
    error: (message: string, extra?: unknown) => log("error", scope, message, extra),
  };
}

export function closeLog(): void {
  try {
    stream?.end();
  } catch {
    /* ignore */
  }
  stream = undefined;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
