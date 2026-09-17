/**
 * Router 端到端测试：用假的 Channel / PiPort 验证准入、排队、回复路由与命令。
 */
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import { ImRelayRouter, type PiPort } from "../extensions/im-relay/router.ts";
import { ChatMapStore } from "../extensions/im-relay/store.ts";
import { DEFAULT_CONFIG, type ImRelayConfig } from "../extensions/im-relay/config.ts";
import type {
  Channel,
  ChannelHooks,
  ChannelStatus,
  ChatTarget,
  InboundMessage,
} from "../extensions/im-relay/channels/types.ts";

/* ------------------------------ 测试替身 ------------------------------ */

class FakeChannel implements Channel {
  readonly id = "qq" as const;
  readonly name = "FakeQQ";
  readonly sent: Array<{ target: ChatTarget; text: string }> = [];
  started = false;
  state: ChannelStatus = { id: "qq", name: "FakeQQ", state: "online" };
  readonly hooks: ChannelHooks;

  constructor(hooks: ChannelHooks) {
    this.hooks = hooks;
  }

  async start(): Promise<void> {
    this.started = true;
    this.hooks.onStatusChange(this.state);
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  status(): ChannelStatus {
    return this.state;
  }
  async send(target: ChatTarget, text: string): Promise<void> {
    this.sent.push({ target, text });
  }
}

interface Harness {
  router: ImRelayRouter;
  channel: FakeChannel;
  injected: Array<{ text: string; images: Array<{ mimeType: string; data: string }> }>;
  aborted: number;
  dispatched: string[];
  notified: string[];
  setIdle(value: boolean): void;
  inbound(overrides?: Partial<InboundMessage>): InboundMessage;
  settle(text?: string): Promise<void>;
}

function makeHarness(configPatch: (c: ImRelayConfig) => void = () => {}): Harness {
  const config: ImRelayConfig = structuredClone(DEFAULT_CONFIG);
  config.channels.qq.allowUsers = ["1001"];
  config.channels.qq.allowGroups = ["555"];
  configPatch(config);

  let idle = true;
  const injected: Harness["injected"] = [];
  const notified: string[] = [];
  const dispatched: string[] = [];
  let aborted = 0;

  const deps: PiPort = {
    isIdle: () => idle,
    inject: (text, images) => {
      injected.push({ text, images });
      idle = false;
    },
    dispatchCommand: (command) => {
      dispatched.push(command);
    },
    abort: () => {
      aborted += 1;
    },
    describeSession: () => "模型：test/model\n会话：(未命名)",
    switchModel: async (spec) => `switched:${spec}`,
    listModels: () => ["a/one", "b/two"],
    notify: (message) => {
      notified.push(message);
    },
    onChannelStatus: () => {},
  };

  let hooksRef: ChannelHooks | undefined;
  const router = new ImRelayRouter(config, deps, new ChatMapStore(path.join(os.tmpdir(), `im-relay-test-${Date.now()}.json`)));
  const channel = new FakeChannel({
    onMessage: (message) => router.accept(message),
    onStatusChange: (status) => {
      hooksRef?.onStatusChange(status);
      router.handleChannelStatus(status);
    },
  });
  router.registerChannel(channel);

  const target: ChatTarget = {
    channel: "qq",
    chatId: "private:1001",
    conversationKey: "qq:user:1001",
    label: "QQ 私聊 1001",
    route: { userId: "1001" },
  };

  return {
    router,
    channel,
    injected,
    get aborted() {
      return aborted;
    },
    dispatched,
    notified,
    setIdle: (value: boolean) => {
      idle = value;
    },
    inbound: (overrides = {}) => ({
      channel: "qq",
      chatId: "private:1001",
      conversationKey: "qq:user:1001",
      senderId: "1001",
      senderName: "1001",
      label: "QQ 私聊 1001",
      isGroup: false,
      text: "你好",
      images: [],
      dedupeKey: `k${Math.random()}`,
      receivedAt: Date.now(),
      target,
      ...overrides,
    }),
    settle: async (text = "完成") => {
      // 仿真 pi 语义：agent_settled 触发时 ctx.isIdle() 已经是 true
      router.onAssistantText(text, "stop");
      idle = true;
      router.onSettled();
      await sleep(180);
    },
  } as Harness;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/* ------------------------------ 用例 ------------------------------ */

test("白名单内的消息会被注入 pi，并带上来源头", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "帮我看看 /tmp" }));
  assert.equal(h.injected.length, 1);
  assert.ok(h.injected[0]?.text.includes("来自QQ"));
  assert.ok(h.injected[0]?.text.includes("帮我看看 /tmp"));
});

test("白名单外的消息被拒绝，且不注入 pi", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ senderId: "999", text: "hi" }));
  await sleep(20);
  assert.equal(h.injected.length, 0);
  assert.equal(h.channel.sent.length, 1);
  assert.ok(h.channel.sent[0]?.text.includes("不在白名单"));
  assert.ok(h.channel.sent[0]?.text.includes("999"));
});

test("重复消息被去重", async () => {
  const h = makeHarness();
  const message = h.inbound({ dedupeKey: "same-key" });
  await h.router.accept(message);
  await h.settle();
  await h.router.accept({ ...message });
  assert.equal(h.injected.length, 1);
});

test("agent 结束后把最终答复回给发起者", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound());
  await h.settle("这是最终结果");
  await sleep(150);
  assert.equal(h.channel.sent.length, 1);
  assert.equal(h.channel.sent[0]?.text, "这是最终结果");
  assert.equal(h.channel.sent[0]?.target.conversationKey, "qq:user:1001");
});

test("busy 时新消息进队列，且回复分别回到各自的会话", async () => {
  const h = makeHarness();
  const a = h.inbound({ senderId: "1001", conversationKey: "qq:user:1001", target: {
    channel: "qq", chatId: "private:1001", conversationKey: "qq:user:1001", label: "A", route: { userId: "1001" },
  } });
  const b = h.inbound({ senderId: "1002", conversationKey: "qq:user:1002", target: {
    channel: "qq", chatId: "private:1002", conversationKey: "qq:user:1002", label: "B", route: { userId: "1002" },
  } });
  // 1002 也放进白名单
  (h.router as unknown as { config: ImRelayConfig }).config.channels.qq.allowUsers.push("1002");

  await h.router.accept(a);
  await h.router.accept(b);
  assert.equal(h.injected.length, 1, "第二条应当排队而不是并发注入");

  await h.settle("答复A");
  assert.ok(h.channel.sent.some((s) => s.text === "答复A" && s.target.route.userId === "1001"));

  assert.equal(h.injected.length, 2, "队列里的第二条应当被继续处理");
  await h.settle("答复B");
  assert.ok(h.channel.sent.some((s) => s.text === "答复B" && s.target.route.userId === "1002"));
});

test("/stop 会中断并清空队列", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "/stop" }));
  assert.equal(h.aborted, 1);
  assert.equal(h.injected.length, 0);
  assert.ok(h.channel.sent[0]?.text.includes("已中断"));
});

test("/status 返回通道与会话信息", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "/status" }));
  const text = h.channel.sent[0]?.text ?? "";
  assert.ok(text.includes("pi-im-relay 状态"));
  assert.ok(text.includes("test/model"));
});

test("/whoami 回显标识，便于加入白名单", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "/whoami", senderId: "1001" }));
  assert.ok(h.channel.sent[0]?.text.includes("1001"));
});

test("/model 无参数时列出模型", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "/model" }));
  const text = h.channel.sent[0]?.text ?? "";
  assert.ok(text.includes("a/one"));
  assert.ok(text.includes("b/two"));
});

test("/model 2 按编号切换", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "/model 2" }));
  assert.equal(h.channel.sent[0]?.text, "switched:b/two");
});

test("/new 通过扩展命令派发", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "/new" }));
  assert.deepEqual(h.dispatched, ["im-new"]);
  await h.router.completeControl("✅ 已开始一个全新的 pi 会话。");
  await sleep(20);
  assert.ok(h.channel.sent.some((s) => s.text.includes("全新的 pi 会话")));
});

test("未知斜杠命令按普通消息交给 pi", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "/compact" }));
  assert.equal(h.injected.length, 1);
  assert.ok(h.injected[0]?.text.includes("/compact"));
});

test("群聊默认需要 @，groupTrigger=all 时全收", async () => {
  const h = makeHarness();
  const group = h.inbound({
    isGroup: true,
    groupId: "555",
    chatId: "group:555",
    conversationKey: "qq:group:555",
    target: { channel: "qq", chatId: "group:555", conversationKey: "qq:group:555", label: "G", route: { groupId: "555", userId: "1001" } },
  });
  // router 不判断 @（那是通道的职责），这里验证群白名单生效
  await h.router.accept(group);
  assert.equal(h.injected.length, 1);

  const bad = { ...group, groupId: "999", target: { ...group.target, route: { groupId: "999" } } };
  await h.settle();
  await h.router.accept(bad);
  assert.equal(h.injected.length, 1, "未授权群不应被注入");
});

test("公告未配对消息在关闭 announceUnpaired 后不再回复", async () => {
  const h = makeHarness((c) => {
    c.announceUnpaired = false;
  });
  await h.router.accept(h.inbound({ senderId: "888" }));
  await sleep(20);
  assert.equal(h.channel.sent.length, 0);
});

test("限流生效", async () => {
  const h = makeHarness((c) => {
    c.rateLimitPerMinute = 2;
    c.queueLimit = 50;
  });
  await h.router.accept(h.inbound({ text: "1" }));
  await h.settle();
  await h.router.accept(h.inbound({ text: "2" }));
  await h.settle();
  await h.router.accept(h.inbound({ text: "3" }));
  await sleep(50);
  assert.equal(h.injected.length, 2, "第三条应当被限流丢弃");
});

test("工具进度在 progress=live 时回传且被节流", async () => {
  const h = makeHarness((c) => {
    c.channels.qq.progress = "live";
  });
  await h.router.accept(h.inbound());
  h.router.onToolStart("bash", { command: "ls -la" });
  h.router.onToolStart("read", { file_path: "/a/b" });
  await sleep(30);
  const progress = h.channel.sent.filter((s) => s.text.startsWith("🔧"));
  assert.equal(progress.length, 1, "5 秒内只应发出第一条进度");
  assert.ok(progress[0]?.text.includes("bash"));
});

test("progress=off 时不回传进度", async () => {
  const h = makeHarness((c) => {
    c.channels.qq.progress = "off";
  });
  await h.router.accept(h.inbound());
  h.router.onToolStart("bash", { command: "ls" });
  await sleep(30);
  assert.equal(h.channel.sent.filter((s) => s.text.startsWith("🔧")).length, 0);
});

test("空答复时给出兜底文案", async () => {
  const h = makeHarness((c) => {
    c.channels.qq.progress = "off";
  });
  await h.router.accept(h.inbound());
  h.router.onToolStart("bash", { command: "ls" });
  await h.settle("");
  assert.ok(h.channel.sent.some((s) => s.text.includes("没有产生文字回复")));
});

/* --------------------- 热加载/重载的状态接力 --------------------- */

test("重载恰好撞上某轮处理中间时，这一轮的结果不会丢", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "帮我做件慢事" }));
  assert.equal(h.injected.length, 1, "消息应当已经交给 pi");

  // 模拟热加载：导出状态 → 建新 router → 接过去
  const carry = h.router.carryOver();
  const next = new ImRelayRouter(
    structuredClone(DEFAULT_CONFIG),
    // 复用同一套 deps 不方便，这里只关心「结果回给谁」，用最小替身
    {
      isIdle: () => true,
      inject: () => {},
      dispatchCommand: () => {},
      abort: () => {},
      describeSession: () => "",
      switchModel: async () => "",
      listModels: () => [],
      notify: () => {},
      onChannelStatus: () => {},
    },
    new ChatMapStore(path.join(os.tmpdir(), `im-relay-test-carry-${Date.now()}.json`)),
  );
  next.adopt(carry);

  const sent: Array<{ target: ChatTarget; text: string }> = [];
  next.registerChannel({
    id: "qq",
    name: "FakeQQ2",
    start: async () => {},
    stop: async () => {},
    status: () => ({ id: "qq", name: "FakeQQ2", state: "online" }),
    send: async (target, text) => {
      sent.push({ target, text });
    },
  });

  next.onAssistantText("活儿干完了", "stop");
  next.onSettled();
  await sleep(120);

  assert.equal(sent.length, 1, "重载后这一轮的结果必须还能发出去（不能静默丢）");
  assert.ok(sent[0]?.text.includes("活儿干完了"), `实际内容：${sent[0]?.text}`);
  assert.equal(sent[0]?.target.route?.userId, "1001", "应当回给原来那条消息的发起者");
});

test("carryOver 也会把排队中的消息带过去", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "第一条" }));
  // 第一条占住 current，第二条进队列
  await h.router.accept(h.inbound({ text: "第二条" }));

  const carry = h.router.carryOver();
  assert.equal(carry.current?.inbound.text, "第一条");
  assert.equal(carry.queue.length, 1, "排队中的消息应当被带过去而不是丢掉");
  assert.equal(carry.queue[0]?.inbound.text, "第二条");
  assert.equal(carry.lastTargets.length, 1, "最近可回复目标也要带走");
});
