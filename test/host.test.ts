/**
 * 进程内单例 host 的回归测试。
 *
 * 这些用例锁死的是我在 pi-web 桌面端实测到的真 bug：
 * 一个进程里开 2 个会话时，通道被启动了 2 次 ——
 * 表现为 NapCat 收到 2 条 WebSocket 连接、同一条 QQ 消息被回复 2 次、
 * iLink 长轮询互相抢 sync_buf 游标、状态文件被并发覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-host-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

// 两个通道都禁用 → 测试不产生任何网络请求
fs.mkdirSync(path.join(tempAgentDir, "im-relay"), { recursive: true });
fs.writeFileSync(
  path.join(tempAgentDir, "im-relay", "config.json"),
  JSON.stringify({ enabled: true, channels: { qq: { enabled: false }, wechat: { enabled: false } } }),
);

const hostModule = await import("../extensions/im-relay/host.ts");
const { ensureHost, getHost, clearHost, registerSession, unregisterSession, touchSession, setActive, activeBinding, scheduleHostShutdown, cancelHostShutdown } = hostModule;
const { acquireProcessLock, releaseProcessLock, readLock, describeHolder } = await import("../extensions/im-relay/lock.ts");
const { stopConfigWatch } = await import("../extensions/im-relay/watch.ts");

function makeFakePi() {
  return {
    on: () => {},
    registerCommand: () => {},
    registerTool: () => {},
    sendUserMessage: () => {},
    sendMessage: () => {},
    setModel: async () => true,
    getSessionName: () => undefined,
  } as never;
}

function makeFakeCtx(id: string, cwd = "C:/work") {
  const notifications: string[] = [];
  return {
    notifications,
    ctx: {
      ui: {
        notify: (m: string) => notifications.push(m),
        setStatus: () => {},
        setWidget: () => {},
        input: async () => undefined,
      },
      mode: "rpc",
      hasUI: true,
      cwd,
      sessionManager: {
        getSessionId: () => id,
        getSessionFile: () => undefined,
        getSessionDir: () => path.join(tempAgentDir, "sessions"),
        getEntries: () => [],
      },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      model: { provider: "test", id: "m", input: ["text", "image"] },
      isIdle: () => true,
      abort: () => {},
      getContextUsage: () => undefined,
    } as never,
  };
}

function resetHost(): void {
  const h = getHost();
  if (h) {
    if (h.shutdownTimer) clearTimeout(h.shutdownTimer);
    // host 上的配置热加载监听要一并关掉，否则跨用例漏一个 watcher
    stopConfigWatch(h);
    if (h.lock.ok) releaseProcessLock(h.lock.file);
  }
  clearHost();
}

test("ensureHost 会装上配置监听；复用时不会重复装", async () => {
  resetHost();
  const pi = makeFakePi();
  const a = makeFakeCtx("session-a");
  const b = makeFakeCtx("session-b");

  const hostA = await ensureHost(pi, a.ctx);
  const watcher = hostA.configWatcher;
  assert.ok(watcher, "首次启动应当装上 config.json 监听（热加载的前提）");

  // 模拟 /reload：新代码拿到的是同一个 host，应当补装而不是重装
  const hostB = await ensureHost(pi, b.ctx);
  assert.equal(hostB, hostA);
  assert.equal(hostB.configWatcher, watcher, "复用 host 时不应重新创建监听器");
  resetHost();
});

test("同一进程内多个会话共享同一个 host，通道只启动一次", async () => {
  resetHost();
  const pi = makeFakePi();
  const a = makeFakeCtx("session-a");
  const b = makeFakeCtx("session-b");

  const hostA = await ensureHost(pi, a.ctx);
  const channelsAfterFirst = hostA.router.statusesSnapshot().length;
  const routerAfterFirst = hostA.router;

  const hostB = await ensureHost(pi, b.ctx);

  assert.equal(hostB, hostA, "必须返回同一个 host 对象");
  assert.equal(hostB.router, routerAfterFirst, "router 必须是同一个实例（否则就是两套通道）");
  assert.equal(hostB.router.statusesSnapshot().length, channelsAfterFirst);

  resetHost();
});

test("会话登记后可切换活跃会话；IM 消息跟随最近活动的会话", async () => {
  resetHost();
  const pi = makeFakePi();
  const a = makeFakeCtx("session-a");
  const b = makeFakeCtx("session-b");
  const host = await ensureHost(pi, a.ctx);

  registerSession(host, { id: "a", pi, ctx: a.ctx, updatedAt: Date.now(), label: "会话A" });
  assert.equal(activeBinding(host)?.id, "a", "只有 a 时活跃会话是 a");

  registerSession(host, { id: "b", pi, ctx: b.ctx, updatedAt: Date.now(), label: "会话B" });
  assert.equal(activeBinding(host)?.id, "b", "未固定时，后登记的会话成为活跃会话");

  // 模拟「用户在 a 窗口里敲了字」
  touchSession(host, "a");
  assert.equal(activeBinding(host)?.id, "a", "最近有交互的会话应当接管");

  resetHost();
});

test("/im attach 固定活跃会话后，其它会话的活动不再抢占", async () => {
  resetHost();
  const pi = makeFakePi();
  const a = makeFakeCtx("session-a");
  const b = makeFakeCtx("session-b");
  const host = await ensureHost(pi, a.ctx);
  registerSession(host, { id: "a", pi, ctx: a.ctx, updatedAt: Date.now(), label: "会话A" });
  registerSession(host, { id: "b", pi, ctx: b.ctx, updatedAt: Date.now(), label: "会话B" });

  setActive(host, "a", true);
  assert.equal(host.pinned, true);
  assert.equal(activeBinding(host)?.id, "a");

  touchSession(host, "b");
  assert.equal(activeBinding(host)?.id, "a", "固定后不应被 b 抢走");

  // 取消固定后回到「最近活动的会话」
  host.pinned = false;
  touchSession(host, "b");
  assert.equal(activeBinding(host)?.id, "b");

  resetHost();
});

test("活跃会话关闭后自动切到最近活动的剩余会话", async () => {
  resetHost();
  const pi = makeFakePi();
  const a = makeFakeCtx("session-a");
  const b = makeFakeCtx("session-b");
  const host = await ensureHost(pi, a.ctx);
  registerSession(host, { id: "a", pi, ctx: a.ctx, updatedAt: Date.now() - 5000, label: "会话A" });
  registerSession(host, { id: "b", pi, ctx: b.ctx, updatedAt: Date.now(), label: "会话B" });
  assert.equal(activeBinding(host)?.id, "b");

  unregisterSession(host, "b");
  assert.equal(activeBinding(host)?.id, "a", "应当回落到剩下的会话");

  unregisterSession(host, "a");
  assert.equal(activeBinding(host), undefined);

  resetHost();
});

test("最后一个会话关闭后延迟拆机，新会话能取消", async () => {
  resetHost();
  const pi = makeFakePi();
  const a = makeFakeCtx("session-a");
  const host = await ensureHost(pi, a.ctx);
  registerSession(host, { id: "a", pi, ctx: a.ctx, updatedAt: Date.now(), label: "会话A" });

  let fired = false;
  scheduleHostShutdown(host, 60_000, () => {
    fired = true;
  });
  assert.ok(host.shutdownTimer, "应当排定延迟拆机");

  cancelHostShutdown(host);
  assert.equal(host.shutdownTimer, undefined);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fired, false, "取消后不应触发拆机");

  resetHost();
});

/* ------------------------------ 进程锁 ------------------------------ */

test("同一进程重复抢锁幂等成功", () => {
  const file = path.join(tempAgentDir, "lock-idempotent.lock");
  assert.equal(acquireProcessLock(file).ok, true);
  assert.equal(acquireProcessLock(file).ok, true);
  releaseProcessLock(file);
  assert.equal(readLock(file), undefined);
});

test("锁被活着的其它进程持有时抢锁失败", async () => {
  const file = path.join(tempAgentDir, "lock-live.lock");
  // 起一个真实存活但什么都不做的子进程，用它的 pid 冒充持有者
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    fs.writeFileSync(file, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));

    const result = acquireProcessLock(file);
    assert.equal(result.ok, false, "活进程持锁时不应抢到");
    if (!result.ok) {
      assert.equal(result.holder.pid, child.pid);
      assert.ok(describeHolder(result.holder).includes(String(child.pid)));
    }
  } finally {
    child.kill();
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
});

test("锁文件里的进程已死时自动接管（崩溃残留不会锁死用户）", () => {
  const file = path.join(tempAgentDir, "lock-stale.lock");
  // 999999 几乎不可能存在
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
  const result = acquireProcessLock(file);
  assert.equal(result.ok, true, "残留锁应当被接管");
  assert.equal(readLock(file)?.pid, process.pid);
  releaseProcessLock(file);
});

test("锁文件内容损坏时不阻塞启动", () => {
  const file = path.join(tempAgentDir, "lock-broken.lock");
  fs.writeFileSync(file, "{ 这不是 JSON");
  assert.equal(acquireProcessLock(file).ok, true);
  releaseProcessLock(file);
});
