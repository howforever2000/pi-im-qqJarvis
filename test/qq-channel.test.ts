/**
 * QQ 通道端到端测试：起一个假的 NapCat OneBot11 WebSocket 服务，
 * 验证「事件 → InboundMessage」和「send() → send_private_msg」两条链路。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

import { QqChannel } from "../extensions/im-relay/channels/qq.ts";
import { OneBotClient } from "../extensions/im-relay/channels/onebot11.ts";
import type { InboundMessage } from "../extensions/im-relay/channels/types.ts";
import { DEFAULT_CONFIG } from "../extensions/im-relay/config.ts";

interface FakeNapCat {
  port: number;
  close(): Promise<void>;
  /** 已收到的 API 调用 */
  calls: Array<{ action: string; params: Record<string, unknown> }>;
  /** 广播一条事件给所有已连接客户端 */
  push(event: unknown): void;
  waitForConnection(): Promise<void>;
}

async function startFakeNapCat(): Promise<FakeNapCat> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const calls: FakeNapCat["calls"] = [];
  const sockets = new Set<WsSocket>();
  let connectedResolve: (() => void) | undefined;
  const connected = new Promise<void>((resolve) => {
    connectedResolve = resolve;
  });

  wss.on("connection", (socket) => {
    sockets.add(socket);
    connectedResolve?.();
    socket.on("message", (raw) => {
      const payload = JSON.parse(String(raw)) as { action?: string; params?: Record<string, unknown>; echo?: string };
      calls.push({ action: String(payload.action), params: payload.params ?? {} });
      if (payload.action === "get_login_info") {
        socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 999 }, echo: payload.echo }));
        return;
      }
      socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 }, echo: payload.echo }));
    });
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    calls,
    push: (event) => {
      const text = JSON.stringify(event);
      for (const socket of sockets) socket.send(text);
    },
    waitForConnection: () => connected,
    close: async () => {
      for (const socket of sockets) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待条件超时");
}

function makeConfig(port: number, patch: (c: typeof DEFAULT_CONFIG.channels.qq) => void = () => {}) {
  const config = structuredClone(DEFAULT_CONFIG.channels.qq);
  config.host = "127.0.0.1";
  config.port = port;
  config.allowUsers = ["1001"];
  config.allowGroups = ["555"];
  patch(config);
  return config;
}

test("QQ 通道：私聊消息被标准化并交给 router", async (t) => {
  const server = await startFakeNapCat();
  t.after(() => server.close());

  const received: InboundMessage[] = [];
  const channel = new QqChannel(
    makeConfig(server.port),
    { onMessage: (m) => { received.push(m); }, onStatusChange: () => {} },
    1500,
  );
  t.after(() => channel.stop());

  await channel.start();
  await waitFor(() => channel.status().state === "online");
  assert.equal(channel.status().state, "online");

  server.push({
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    self_id: 999,
    user_id: 1001,
    message_id: 42,
    sender: { user_id: 1001, nickname: "小明" },
    message: [
      { type: "text", data: { text: "帮我" } },
      { type: "image", data: { file: "x.jpg" } },
      { type: "text", data: { text: "看看日志" } },
    ],
  });

  await waitFor(() => received.length > 0);
  const message = received[0]!;
  assert.equal(message.channel, "qq");
  assert.equal(message.senderId, "1001");
  assert.equal(message.senderName, "小明");
  assert.equal(message.isGroup, false);
  assert.equal(message.conversationKey, "qq:user:1001");
  assert.equal(message.label, "QQ 私聊 小明");
  assert.ok(message.text.includes("帮我"));
  assert.ok(message.text.includes("看看日志"));
  assert.ok(message.text.includes("[图片]"));
  assert.equal(message.dedupeKey, "qq:42");
  assert.deepEqual(message.target.route, { userId: "1001", groupId: undefined });
});

test("QQ 通道：群聊默认只在 @bot 时响应", async (t) => {
  const server = await startFakeNapCat();
  t.after(() => server.close());

  const received: InboundMessage[] = [];
  const channel = new QqChannel(
    makeConfig(server.port, (c) => {
      c.groupTrigger = "mention";
    }),
    { onMessage: (m) => { received.push(m); }, onStatusChange: () => {} },
    1500,
  );
  t.after(() => channel.stop());

  await channel.start();
  await waitFor(() => channel.status().state === "online");

  const groupEvent = (message: unknown) => ({
    post_type: "message",
    message_type: "group",
    self_id: 999,
    user_id: 1001,
    group_id: 555,
    message_id: Math.floor(Math.random() * 100000),
    sender: { user_id: 1001, nickname: "小明", card: "小明" },
    message,
  });

  // 没有被 @ → 不应触发
  server.push(groupEvent([{ type: "text", data: { text: "大家早上好" } }]));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(received.length, 0, "未 @ 的群消息不应触发");

  // @bot → 应触发，且正文里不应残留 @bot
  server.push(groupEvent([
    { type: "at", data: { qq: "999" } },
    { type: "text", data: { text: " 看下这个报错" } },
  ]));
  await waitFor(() => received.length > 0);
  const message = received[0]!;
  assert.equal(message.isGroup, true);
  assert.equal(message.groupId, "555");
  assert.equal(message.conversationKey, "qq:group:555");
  assert.ok(message.text.includes("看下这个报错"));
  assert.ok(!message.text.includes("@999"), "@bot 不应出现在正文");
  assert.deepEqual(message.target.route, { userId: "1001", groupId: "555" });
});

test("QQ 通道：自己发的消息被忽略", async (t) => {
  const server = await startFakeNapCat();
  t.after(() => server.close());

  const received: InboundMessage[] = [];
  const channel = new QqChannel(
    makeConfig(server.port),
    { onMessage: (m) => { received.push(m); }, onStatusChange: () => {} },
    1500,
  );
  t.after(() => channel.stop());

  await channel.start();
  await waitFor(() => channel.status().state === "online");

  server.push({
    post_type: "message",
    message_type: "private",
    self_id: 999,
    user_id: 999,
    message_id: 7,
    sender: { user_id: 999, nickname: "bot" },
    message: [{ type: "text", data: { text: "我自己说的话" } }],
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(received.length, 0);
});

test("QQ 通道：send() 调用 send_private_msg 并按上限分段", async (t) => {
  const server = await startFakeNapCat();
  t.after(() => server.close());

  const channel = new QqChannel(
    makeConfig(server.port),
    { onMessage: () => {}, onStatusChange: () => {} },
    20,
  );
  t.after(() => channel.stop());

  await channel.start();
  await waitFor(() => channel.status().state === "online");

  const target = {
    channel: "qq" as const,
    chatId: "private:1001",
    conversationKey: "qq:user:1001",
    label: "QQ 私聊 1001",
    route: { userId: "1001" },
  };
  await channel.send(target, "第一段内容比较长需要被切开。\n\n第二段内容。");

  const sends = server.calls.filter((c) => c.action === "send_private_msg");
  assert.ok(sends.length >= 2, `应当分段发送，实际 ${sends.length} 次`);
  for (const call of sends) {
    const message = call.params.message as Array<{ data: { text: string } }>;
    assert.ok(message[0]!.data.text.length <= 20);
    assert.equal(call.params.user_id, "1001");
  }
});

test("QQ 通道：群回复走 send_group_msg", async (t) => {
  const server = await startFakeNapCat();
  t.after(() => server.close());

  const channel = new QqChannel(
    makeConfig(server.port),
    { onMessage: () => {}, onStatusChange: () => {} },
    1500,
  );
  t.after(() => channel.stop());

  await channel.start();
  await waitFor(() => channel.status().state === "online");

  await channel.send(
    {
      channel: "qq",
      chatId: "group:555",
      conversationKey: "qq:group:555",
      label: "QQ 群 555",
      route: { userId: "1001", groupId: "555" },
    },
    "收到",
  );
  const sends = server.calls.filter((c) => c.action === "send_group_msg");
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.params.group_id, "555");
});

test("QQ 通道：NapCat 不可达时进入 error 状态而不是崩溃", async (t) => {
  // 挑一个几乎肯定没人监听的端口
  const channel = new QqChannel(
    makeConfig(59999),
    { onMessage: () => {}, onStatusChange: () => {} },
    1500,
  );
  t.after(() => channel.stop());
  await channel.start();
  assert.equal(channel.status().state, "error");
  assert.ok(channel.status().detail?.includes("NapCat"));
});

test("端口探测：无服务监听时给出可操作结论", async () => {
  const client = new OneBotClient({ host: "127.0.0.1", port: 59998, token: "" });
  const verdict = await client.probePort(2000);
  assert.ok(verdict.includes("没有服务在监听"), `实际：${verdict}`);
});

test("端口探测：TCP 可连但握手被拒时提示 Token 问题", async (t) => {
  // 起一个只监听 TCP、不说 WebSocket 的服务
  const net = await import("node:net");
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const client = new OneBotClient({ host: "127.0.0.1", port, token: "" });
  const verdict = await client.probePort(2000);
  assert.ok(verdict.includes("Token"), `实际：${verdict}`);
});
