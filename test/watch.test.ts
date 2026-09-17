/**
 * config.json 热加载的回归测试。
 *
 * 锁死这几个真实行为：
 *   - 改了配置就自动 reload（不用手敲 /im reload）
 *   - 内容没变（重复保存 / touch）**不该**重载
 *   - 半截 JSON **不该**重载（否则 loadConfig 会把文件改名备份 + 回退默认值）
 *   - 我们自己写配置（saveHostConfig）**不该**触发自己
 *   - stop 之后不再触发
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-watch-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

const CONFIG_DIR = path.join(tempAgentDir, "im-relay");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const { startConfigWatch, stopConfigWatch, syncConfigWatch } = await import("../extensions/im-relay/watch.ts");
const { saveConfig } = await import("../extensions/im-relay/config.ts");

/** 等事件 + 去抖窗口过去 */
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));

/** 模仿 saveConfig 的原子写：临时文件 + rename */
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

interface FakeHost {
  configWatcher?: fs.FSWatcher;
  configWatchTimer?: NodeJS.Timeout;
  configWatchHash?: string;
}

function makeHost(): { host: FakeHost; calls: () => number; reset: () => void } {
  let count = 0;
  const host: FakeHost = {};
  (host as unknown as { reload: unknown }).reload = () => {};
  return { host, calls: () => count, reset: () => { count = 0; } };
}

test("改了配置会自动 reload 一次（不用手敲 /im reload）", async () => {
  atomicWrite(CONFIG_FILE, JSON.stringify({ enabled: true, maxReplyChars: 1000 }));
  const { host } = makeHost();
  let calls = 0;
  startConfigWatch(host, async () => {
    calls += 1;
  });
  try {
    atomicWrite(CONFIG_FILE, JSON.stringify({ enabled: true, maxReplyChars: 1500 }));
    await settle();
    assert.equal(calls, 1, "应当恰好触发一次热加载");
  } finally {
    stopConfigWatch(host);
  }
});

test("内容没变（重复保存）不会触发 reload", async () => {
  const same = JSON.stringify({ enabled: true, quiet: true });
  atomicWrite(CONFIG_FILE, same);
  const { host } = makeHost();
  let calls = 0;
  startConfigWatch(host, async () => {
    calls += 1;
  });
  try {
    atomicWrite(CONFIG_FILE, same);
    atomicWrite(CONFIG_FILE, same);
    await settle();
    assert.equal(calls, 0, "内容相同不应重载");
  } finally {
    stopConfigWatch(host);
  }
});

test("半截 JSON 不会被热加载（避免 loadConfig 把文件备份+回退默认值）", async () => {
  atomicWrite(CONFIG_FILE, JSON.stringify({ enabled: true, step: 1 }));
  const { host } = makeHost();
  let calls = 0;
  startConfigWatch(host, async () => {
    calls += 1;
  });
  try {
    atomicWrite(CONFIG_FILE, '{ "enabled": true, "maxRep');
    await settle();
    assert.equal(calls, 0, "非法 JSON 不应重载");
    assert.ok(fs.existsSync(CONFIG_FILE), "配置文件不应被改名备份");
    assert.ok(
      !fs.readdirSync(CONFIG_DIR).some((f) => f.includes(".broken-")),
      "不应产生 .broken- 备份",
    );
  } finally {
    stopConfigWatch(host);
  }
});

test("syncConfigWatch 之后，自己写的配置不会触发自己", async () => {
  atomicWrite(CONFIG_FILE, JSON.stringify({ enabled: true, self: 1 }));
  const { host } = makeHost();
  let calls = 0;
  startConfigWatch(host, async () => {
    calls += 1;
  });
  try {
    // 模拟 saveHostConfig：先写盘，再对齐基线
    saveConfig({ enabled: true, self: 2 } as never);
    syncConfigWatch(host);
    await settle();
    assert.equal(calls, 0, "自己写的配置不应触发热加载");
  } finally {
    stopConfigWatch(host);
  }
});

test("stopConfigWatch 之后不再触发", async () => {
  atomicWrite(CONFIG_FILE, JSON.stringify({ enabled: true, alive: 1 }));
  const { host } = makeHost();
  let calls = 0;
  startConfigWatch(host, async () => {
    calls += 1;
  });
  stopConfigWatch(host);
  atomicWrite(CONFIG_FILE, JSON.stringify({ enabled: true, alive: 2 }));
  await settle();
  assert.equal(calls, 0, "停掉之后不应再重载");
  assert.equal(host.configWatcher, undefined);
});

test("连续快速保存只重载一次（去抖）", async () => {
  atomicWrite(CONFIG_FILE, JSON.stringify({ enabled: true, burst: 1 }));
  const { host } = makeHost();
  let calls = 0;
  startConfigWatch(host, async () => {
    calls += 1;
  });
  try {
    atomicWrite(CONFIG_FILE, JSON.stringify({ enabled: true, burst: 2 }));
    atomicWrite(CONFIG_FILE, JSON.stringify({ enabled: true, burst: 3 }));
    atomicWrite(CONFIG_FILE, JSON.stringify({ enabled: true, burst: 4 }));
    await settle();
    assert.equal(calls, 1, "一串连续写入应合并成一次重载");
  } finally {
    stopConfigWatch(host);
  }
});
