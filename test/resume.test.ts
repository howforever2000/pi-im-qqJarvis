/**
 * /resume 会话列表测试：验证从会话目录读取元信息的行为，
 * 包括超大文件只读开头（不阻塞 TUI）这条约束。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-resume-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

const { listRecentSessions } = await import("../extensions/im-relay/index.ts");

function writeSession(dir: string, name: string, lines: unknown[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return file;
}

test("按修改时间倒序列出会话，并读出命名与条数", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-sessions-"));
  writeSession(dir, "2026-01-01T10-00-00-000Z_aaa.jsonl", [
    { type: "session", version: 3, id: "aaa", timestamp: "2026-01-01T10:00:00.000Z" },
    { type: "message", message: { role: "user", content: "第一个会话在干什么" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "在做 A" }] } },
  ]);
  await new Promise((r) => setTimeout(r, 20));
  writeSession(dir, "2026-02-02T10-00-00-000Z_bbb.jsonl", [
    { type: "session", version: 3, id: "bbb", name: "重构鉴权模块" },
    { type: "message", message: { role: "user", content: "帮我重构" } },
  ]);

  const entries = await listRecentSessions(dir, 10);
  assert.equal(entries.length, 2);
  // 最新的排第一（bbb 后写入）
  assert.equal(entries[0]!.name, "重构鉴权模块");
  assert.equal(entries[0]!.messageCount, 1);
  assert.equal(entries[0]!.partial, false);
  assert.equal(entries[1]!.name, "第一个会话在干什么");
  assert.equal(entries[1]!.messageCount, 2);
  assert.equal(entries[0]!.index, 1);
  assert.equal(entries[1]!.index, 2);
});

test("没有可用名字时回退到时间标签", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-sessions-"));
  writeSession(dir, "2026-03-04T05-06-07-000Z_ccc.jsonl", [
    { type: "session", version: 3, id: "ccc" },
  ]);
  const entries = await listRecentSessions(dir, 10);
  assert.equal(entries[0]!.name, "03-04 05:06");
});

test("会话目录不存在时返回空数组而不是抛错", async () => {
  const entries = await listRecentSessions(path.join(os.tmpdir(), "definitely-not-here-12345"), 10);
  assert.deepEqual(entries, []);
});

test("超大 session 只读开头，条数为下界并标记 partial", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-sessions-"));
  const lines: unknown[] = [{ type: "session", version: 3, id: "big" }];
  // 造一个明显超过 512KB 的会话
  const filler = "x".repeat(2000);
  for (let i = 0; i < 400; i += 1) {
    lines.push({ type: "message", message: { role: "user", content: `${i}:${filler}` } });
  }
  const file = writeSession(dir, "2026-04-05T06-07-08-000Z_big.jsonl", lines);
  const size = fs.statSync(file).size;
  assert.ok(size > 512 * 1024, `测试文件应当超过 512KB，实际 ${size}`);

  const started = Date.now();
  const entries = await listRecentSessions(dir, 10);
  const elapsed = Date.now() - started;
  assert.equal(entries[0]!.partial, true);
  assert.ok(entries[0]!.messageCount > 0);
  assert.ok(entries[0]!.messageCount < 400, "不应当扫描完整个大文件");
  assert.ok(elapsed < 2000, `读取不应阻塞过久，实际 ${elapsed}ms`);
});

test("limit 只取最近的若干个", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-sessions-"));
  for (let i = 0; i < 15; i += 1) {
    writeSession(dir, `2026-05-01T00-00-${String(i).padStart(2, "0")}-000Z_s${i}.jsonl`, [
      { type: "session", version: 3, id: `s${i}` },
    ]);
  }
  const entries = await listRecentSessions(dir, 5);
  assert.equal(entries.length, 10, "内部下限为 10 条");
  assert.deepEqual(
    entries.map((e) => e.index),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});
