/**
 * im_relay_send_file 的回归测试。
 *
 * 锁死三件在真实使用里踩得到的事：
 *   1. 只能发给「刚跟本机说过话」的那个会话 —— 不给任意第三方推送留入口；
 *   2. 通道没有上传能力时要如实说「不支持」，而不是静默失败或假装成功；
 *   3. 指定通道时各回各的 —— QQ 和微信交替来消息时不能串台
 *      （lastTarget 只有一个，所以 router 里按通道各存了一份）。
 *
 * 通过 PI_CODING_AGENT_DIR 指向临时目录；两个通道都不产生真实网络请求。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-sendfile-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

// qq 通道禁用（不起 OneBot11 连接，QQ 侧用测试替身手动注册）；
// wechat 启用但 baseUrl 指向不可达端口，任何请求都会快速失败。
fs.mkdirSync(path.join(tempAgentDir, "im-relay"), { recursive: true });
fs.writeFileSync(
  path.join(tempAgentDir, "im-relay", "config.json"),
  JSON.stringify({
    enabled: true,
    channels: {
      qq: { enabled: false, allowUsers: ["1001"] },
      wechat: { enabled: true, baseUrl: "http://127.0.0.1:1", allowUsers: ["u1@im.wechat"] },
    },
  }),
);

const extensionModule = await import("../extensions/im-relay/index.ts");
const imRelay = extensionModule.default as (pi: unknown) => void;
const { getHost, clearHost } = await import("../extensions/im-relay/host.ts");
const { releaseProcessLock } = await import("../extensions/im-relay/lock.ts");
import type {
  Channel,
  ChannelHooks,
  ChannelStatus,
  ChatTarget,
  InboundMessage,
} from "../extensions/im-relay/channels/types.ts";

/* ------------------------------ 测试替身 ------------------------------ */

/**
 * 会记录上传的假 QQ 通道。supportsFile=false 时**根本没有 sendFile 方法**，
 * 用来模拟「这个通道没有上传能力」（微信就是这种情况）。
 *（不用 class + 参数属性：node 的 strip-only 模式不支持。）
 */
function makeFakeQq(hooks: ChannelHooks, supportsFile: boolean) {
  const uploaded: Array<{ target: ChatTarget; filePath: string }> = [];
  const channel = {
    id: "qq" as const,
    name: "FakeQQ",
    state: { id: "qq", name: "FakeQQ", state: "online" } as ChannelStatus,
    async start() {
      hooks.onStatusChange(channel.state);
    },
    async stop() {},
    status() {
      return channel.state;
    },
    async send() {},
  };
  if (supportsFile) {
    (channel as { sendFile?: unknown }).sendFile = async (target: ChatTarget, filePath: string) => {
      uploaded.push({ target, filePath });
    };
  }
  return { channel: channel as unknown as Channel, uploaded };
}

interface Recorded {
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
  tools: Map<string, { execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }>;
  commands: Map<string, unknown>;
}

function makeFakePi(): { pi: unknown; recorded: Recorded } {
  const recorded: Recorded = { handlers: new Map(), tools: new Map(), commands: new Map() };
  const pi = {
    on: (event: string, handler: (e: unknown, c: unknown) => Promise<unknown>) => {
      recorded.handlers.set(event, handler);
    },
    registerCommand: (name: string, options: unknown) => {
      recorded.commands.set(name, options);
    },
    registerTool: (tool: { name: string } & Recorded["tools"] extends Map<string, infer V> ? V : never) => {
      recorded.tools.set(tool.name, tool);
    },
    sendUserMessage: () => {},
    sendMessage: () => {},
    getSessionName: () => "测试会话",
    getCommands: () => [],
    events: { on: () => () => {}, emit: () => {} },
  };
  return { pi, recorded };
}

function makeFakeCtx() {
  const ctx = {
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      input: async () => undefined,
      select: async () => undefined,
      confirm: async () => false,
    },
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: {
      getSessionDir: () => path.join(tempAgentDir, "sessions"),
      getSessionFile: () => undefined,
      getEntries: () => [],
      getSessionId: () => "test-sendfile",
      getBranch: () => [],
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    hasPendingMessages: () => false,
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: true }),
    switchSession: async () => ({ cancelled: true }),
    reload: async () => {},
  };
  return { ctx };
}

/** 起一个真实的扩展（含 host 单例），并把 QQ 侧换成测试替身。 */
async function boot(options: { qqSupportsFile?: boolean } = {}) {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx } = makeFakeCtx();
  await recorded.handlers.get("session_start")?.({}, ctx);

  const host = getHost();
  assert.ok(host, "session_start 之后应当有 host");

  let qq: Array<{ target: ChatTarget; filePath: string }> | undefined;
  if (options.qqSupportsFile !== undefined) {
    const fake = makeFakeQq(
      {
        onMessage: (message) => void host.router.accept(message),
        onStatusChange: () => {},
      },
      options.qqSupportsFile,
    );
    host.router.registerChannel(fake.channel);
    qq = fake.uploaded;
  }

  const callSendFile = async (params: Record<string, unknown>) => {
    const result = await recorded.tools.get("im_relay_send_file")!.execute("t", params);
    return result.content.map((b) => b.text ?? "").join("\n");
  };

  return { host, qq, callSendFile };
}

/** 造一条已通过白名单的入站消息（accept 会记录「谁在跟我说话」）。 */
function inbound(channel: "qq" | "wechat", target: ChatTarget): InboundMessage {
  return {
    channel,
    chatId: target.chatId,
    conversationKey: target.conversationKey,
    senderId: channel === "qq" ? "1001" : "u1@im.wechat",
    senderName: channel === "qq" ? "1001" : "用户",
    label: target.label,
    isGroup: false,
    text: "你好",
    images: [],
    dedupeKey: `${channel}-${Math.random()}`,
    receivedAt: Date.now(),
    target,
  };
}

const qqTarget: ChatTarget = {
  channel: "qq",
  chatId: "private:1001",
  conversationKey: "qq:user:1001",
  label: "QQ 私聊 1001",
  route: { userId: "1001" },
};

const wechatTarget: ChatTarget = {
  channel: "wechat",
  chatId: "u1@im.wechat",
  conversationKey: "wechat:u1@im.wechat",
  label: "微信 用户",
  route: { userId: "u1@im.wechat" },
};

const sampleFile = path.join(tempAgentDir, "毕业学位扫描.pdf");
fs.writeFileSync(sampleFile, "fake pdf bytes");

test.beforeEach(() => {
  const host = getHost();
  if (host) {
    if (host.shutdownTimer) clearTimeout(host.shutdownTimer);
    if (host.lock.ok) releaseProcessLock(host.lock.file);
  }
  clearHost();
});

test("扩展注册了 im_relay_send_file 工具", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  assert.ok(recorded.tools.has("im_relay_send_file"), "应当注册 im_relay_send_file");
});

test("没有会话说过话时，明确拒绝并给出可操作提示（不静默失败）", async () => {
  const { callSendFile } = await boot({ qqSupportsFile: true });
  const text = await callSendFile({ filePath: sampleFile });
  assert.ok(text.includes("没有可回复的 IM 会话"), text);
  assert.ok(text.includes("发一条消息"), "要告诉用户怎么才能发：" + text);
});

test("文件不存在时如实报错", async () => {
  const { callSendFile } = await boot({ qqSupportsFile: true });
  const text = await callSendFile({ filePath: path.join(tempAgentDir, "根本没有这个文件.pdf") });
  assert.ok(text.includes("文件不存在"), text);
});

test("通道没有上传能力时说不支持，而不是假装成功", async () => {
  const { host, callSendFile } = await boot({ qqSupportsFile: true });
  await host.router.accept(inbound("wechat", wechatTarget));

  const text = await callSendFile({ filePath: sampleFile });
  assert.ok(text.includes("不支持发送文件"), text);
  assert.ok(/只有 QQ/.test(text), "要说明哪个通道支持：" + text);
});

test("QQ 侧能把文件回给刚说话的私聊会话", async () => {
  const { host, qq, callSendFile } = await boot({ qqSupportsFile: true });
  await host.router.accept(inbound("qq", qqTarget));

  const text = await callSendFile({ filePath: sampleFile });
  assert.equal(qq!.length, 1, text);
  assert.equal(qq![0]!.filePath, sampleFile);
  assert.equal(qq![0]!.target.chatId, "private:1001");
  assert.ok(text.includes("毕业学位扫描.pdf"), text);
  assert.ok(text.includes("QQ 私聊 1001"), text);
});

test("QQ 和微信交替来消息时，指定通道各回各的（不串台）", async () => {
  const { host, qq, callSendFile } = await boot({ qqSupportsFile: true });
  // 微信后说话：如果不按通道各存一份，QQ 目标就被顶掉了
  await host.router.accept(inbound("qq", qqTarget));
  await host.router.accept(inbound("wechat", wechatTarget));

  const toQq = await callSendFile({ filePath: sampleFile, channel: "qq" });
  assert.equal(qq!.length, 1, toQq);
  assert.equal(qq![0]!.target.chatId, "private:1001");

  const toWechat = await callSendFile({ filePath: sampleFile, channel: "wechat" });
  assert.ok(toWechat.includes("不支持发送文件"), toWechat);
});

test("白名单外的人说话不会成为「可回复目标」", async () => {
  const { host, callSendFile } = await boot({ qqSupportsFile: true });
  // 唯一变量是 senderId：白名单里只有 1001
  await host.router.accept({
    ...inbound("qq", qqTarget),
    senderId: "999",
    chatId: "private:999",
    conversationKey: "qq:user:999",
    target: { ...qqTarget, chatId: "private:999", conversationKey: "qq:user:999", route: { userId: "999" } },
  });
  const text = await callSendFile({ filePath: sampleFile });
  assert.ok(text.includes("没有可回复的 IM 会话"), text);
});

test("router.replyTarget 在没有任何入站时返回 undefined", async () => {
  const { host } = await boot({ qqSupportsFile: true });
  assert.equal(host.router.replyTarget(), undefined);
  assert.equal(host.router.replyTarget("qq"), undefined);
});
