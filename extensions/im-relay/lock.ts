/**
 * 单实例进程锁。
 *
 * 为什么必须有：通道是「全局唯一资源」。
 *  - QQ：每个 WebSocket 客户端都会收到同一条 QQ 消息 —— 两个进程连着 NapCat
 *    就会把一条消息回复两遍。
 *  - 微信：iLink 长轮询游标（sync_buf）是单份的，两个进程轮流用它收发会互相覆盖，
 *    轻则重复回复，重则丢消息；而且 24h 内 10 条主动消息的额度会被成倍消耗。
 *
 * 现实中很容易踩到：pi 终端 TUI 开着，同时又开了 pi-web 桌面端 —— 两个进程、
 * 同一个 agentDir。所以启动通道前先抢这把锁，抢不到就只读不写、明确提示。
 */
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./log.ts";

const log = createLogger("lock");

export interface LockInfo {
  pid: number;
  startedAt: string;
  /** 便于用户定位是谁占着锁 */
  hint?: string;
}

export type LockResult =
  | { ok: true; file: string }
  | { ok: false; file: string; holder: LockInfo };

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 只做存在性检查，不会真的发信号
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但不属于当前用户；ESRCH = 不存在
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(file: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
    if (typeof parsed?.pid === "number") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 尝试独占锁定。自己已经持有（同一进程重复调用）时也算成功。
 */
export function acquireProcessLock(file: string, hint?: string): LockResult {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  const existing = readLock(file);
  if (existing) {
    if (existing.pid === process.pid) return { ok: true, file };
    if (isPidAlive(existing.pid)) return { ok: false, file, holder: existing };
    // 持有者已经死了（崩溃 / 强杀），接管
    log.warn(`发现残留锁（pid=${existing.pid} 已不存在），接管`);
  }

  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), hint };
  try {
    const fd = fs.openSync(file, "w", 0o600);
    fs.writeSync(fd, JSON.stringify(info));
    fs.closeSync(fd);
    return { ok: true, file };
  } catch (error) {
    // 极小概率的竞争：别人刚好在这几毫秒里写进去了
    const holder = readLock(file);
    if (holder && holder.pid !== process.pid && isPidAlive(holder.pid)) {
      return { ok: false, file, holder };
    }
    log.warn(`写锁失败: ${String(error)}`);
    return { ok: true, file };
  }
}

/** 释放锁；只有自己持有时才删。 */
export function releaseProcessLock(file: string): void {
  const holder = readLock(file);
  if (holder && holder.pid !== process.pid) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* 已经没了就算了 */
  }
}

/** 进程退出时兜底清理，避免留下需要人工处理的残留锁。 */
export function releaseProcessLockOnExit(file: string): void {
  const cleanup = () => releaseProcessLock(file);
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

export function describeHolder(holder: LockInfo): string {
  const since = holder.startedAt ? new Date(holder.startedAt).toLocaleString() : "未知时间";
  const hint = holder.hint ? `（${holder.hint}）` : "";
  return `另一个 pi 进程（pid=${holder.pid}${hint}，启动于 ${since}）`;
}
