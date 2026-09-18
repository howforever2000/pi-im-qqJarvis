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
  // 默认关掉记忆注入：开了之后每条消息都会去读 QQ 空间与聊天记录，
  // 单测不该打真实网络（而且会被腾讯返回 403，测试变慢又不稳）。
  // 需要测记忆的用例在自己的 configPatch 里重新打开。
  config.memory.enabled = false;
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

/* ------------------------------------------------------------------ */
/* IM 侧裸短语状态入口                                                  */
/*                                                                     */
/* 背景（真实踩到）：IM 消息只有 `/` 开头的才走命令快通道，裸短语一律排队 */
/* 等 agent。而 agent 一旦卡在长任务里（派活、跑构建、验收），一句       */
/* 「是否在线」要等好几分钟 —— 用户体感就是「机器人失联」。           */
/* ------------------------------------------------------------------ */

test("忙时发「是否在线」这类裸短语也能秒回，不排进队列", async () => {
  for (const phrase of ["是否在线", "im状态", "机器人状态", "在线吗", "是否在线？"]) {
    const h = makeHarness();
    h.setIdle(false); // agent 正忙
    await h.router.accept(h.inbound({ text: phrase }));

    assert.equal(h.injected.length, 0, `「${phrase}」不该被注入给 agent`);
    assert.equal(h.channel.sent.length, 1, `「${phrase}」应当立刻回一条`);
    assert.ok(h.channel.sent[0]?.text.includes("pi-im-relay 状态"), `「${phrase}」回的应当是状态`);
  }
});

test("空闲时发状态裸短语，同样就地回、不耗 agent", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "机器人状态" }));
  assert.equal(h.injected.length, 0);
  assert.equal(h.channel.sent.length, 1);
});

test("空闲时问「进度」应当放行给 agent（它能去查真实进展）", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "进度" }));
  assert.equal(h.injected.length, 1, "空闲时这类问题该由 agent 答，不该用兜底文案顶掉");
  assert.equal(h.channel.sent.length, 0);
});

test("忙时问「在干什么」就地回一句进展，不让用户干等", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "你好" }));
  assert.equal(h.injected.length, 1);

  await h.router.accept(h.inbound({ text: "在干什么" }));
  assert.equal(h.injected.length, 1, "第二条不该被注入");
  const text = h.channel.sent[0]?.text ?? "";
  assert.ok(text.includes("我正忙"), `实际：${text}`);
  assert.ok(text.includes("/stop"), "应当告诉用户怎么打断");
});

test("正常提问不会被裸短语劫持（这是最要紧的一条）", async () => {
  const cases = [
    "机器人状态怎么同步到云端",
    "进度条组件怎么调样式",
    "帮我看看 im状态 这个字段在哪定义的",
    "在线吗，帮我把那个 bug 修了",
  ];
  for (const text of cases) {
    const h = makeHarness();
    await h.router.accept(h.inbound({ text }));
    assert.equal(h.channel.sent.length, 0, `「${text}」被误当成状态指令劫持了`);
    assert.equal(h.injected.length, 1, `「${text}」应当正常交给 agent`);
  }
});

test("带斜杠的命令仍然优先于裸短语识别", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "/status" }));
  assert.equal(h.injected.length, 0);
  assert.equal(h.channel.sent.length, 1);
});

/* ------------------------------------------------------------------ */
/* 忙时自动回执                                                        */
/*                                                                     */
/* 用户的抱怨是「回答消息不及时」—— 发出去后一片寂静，根本不知道是没   */
/* 收到、在排队、还是坏了。这一层保证：只要这条真的要等，立刻给个回音。 */
/* ------------------------------------------------------------------ */

test("忙时发普通消息会立刻收到回执，而且消息不丢（仍然进队列）", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "第一条" }));

  await h.router.accept(h.inbound({ text: "帮我改个东西" }));
  await sleep(30); // 回执是 fire-and-forget，给它一点时间落库

  assert.equal(h.injected.length, 1, "第二条不该被立刻注入（agent 还在忙）");
  assert.equal(h.router.queueLength(), 1, "第二条必须留在队列里，不能被回执顶掉");
  const ack = h.channel.sent[0]?.text ?? "";
  assert.ok(ack.includes("收到"), `实际回执：${ack}`);
  assert.ok(ack.includes("/stop"), "应当告诉用户怎么打断");
});

test("空闲时不发忙时回执（那是纯噪音，而且会误导）", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "你好" }));
  await sleep(30);
  assert.equal(h.injected.length, 1);
  assert.equal(h.channel.sent.length, 0, "空闲时应当招呼都不打就直接干活");
});

test("忙时连发多条只回一次执（不刷屏）", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "第一条" }));

  for (const text of ["追问一", "追问二", "追问三"]) {
    await h.router.accept(h.inbound({ text }));
  }
  await sleep(30);

  assert.equal(h.channel.sent.length, 1, `应当只回一条回执，实际 ${h.channel.sent.length} 条`);
  assert.equal(h.router.queueLength(), 3, "三条追问都要在队列里");
});

test("回执说过的话要兑现：前一条处理完后，排队的那条会被处理并答复", async () => {
  const h = makeHarness();
  await h.router.accept(h.inbound({ text: "第一条" }));
  await h.router.accept(h.inbound({ text: "第二条" }));
  await sleep(30);

  await h.settle("答复A");
  await h.settle("答复B");

  assert.equal(h.injected.length, 2, "排队的第二条最终必须被送给 agent");
  assert.ok(h.channel.sent.some((s) => s.text === "答复A"));
  assert.ok(h.channel.sent.some((s) => s.text === "答复B"));
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

/* ------------------- 记忆注入的节流策略 ------------------- */

test("记忆只在「该发」的时候注入：新会话必发，之后每隔 N 条补发", async () => {
  const h = makeHarness((c) => {
    c.memory.enabled = true;
    c.memory.refreshEveryMessages = 3;
    c.memory.cacheSeconds = 3600;
  });
  // 给通道挂一个假的 OneBot 接口，让 buildNotes 能读到「记忆」
  let reads = 0;
  const channel = h.router.channel("qq") as unknown as {
    api: (action: string) => Promise<unknown>;
  };
  channel.api = async (action: string) => {
    if (action === "get_login_info") return { user_id: 1001 };
    if (action === "get_friends_with_category") return {};
    if (action === "get_cookies") return { cookies: "skey=x", bkn: "1" };
    if (action === "get_friend_msg_history") {
      reads += 1;
      return { messages: [] };
    }
    return {};
  };

  await h.router.accept(h.inbound({ text: "第一条" }));
  await h.settle();
  assert.match(h.injected.at(-1)?.text ?? "", /## 工作约定/, "新会话/首次必须注入完整记忆");

  await h.router.accept(h.inbound({ text: "第二条" }));
  await h.settle();
  assert.doesNotMatch(h.injected.at(-1)?.text ?? "", /## 工作约定/, "紧接着的第二条不该再塞一遍（省 token）");

  // refreshEveryMessages=3：第 3 条时 count 正好到 3，应当补发
  await h.router.accept(h.inbound({ text: "第三条" }));
  await h.settle();
  assert.match(h.injected.at(-1)?.text ?? "", /## 工作约定/, "每 N 条应当补发一次，防止上下文压缩后失忆");

  await h.router.accept(h.inbound({ text: "第四条" }));
  await h.settle();
  assert.doesNotMatch(h.injected.at(-1)?.text ?? "", /## 工作约定/, "补发之后要重新计时");
  assert.ok(reads >= 1, "应当真的去读了聊天记录");
});

test("markMemoryStale 之后下一条会重新完整注入（新会话/刚登录的语义）", async () => {
  const h = makeHarness((c) => {
    c.memory.enabled = true;
    c.memory.refreshEveryMessages = 0; // 关掉周期性补发，只验证 dirty 这条路径
    c.memory.cacheSeconds = 3600;
  });
  const channel = h.router.channel("qq") as unknown as { api: (action: string) => Promise<unknown> };
  channel.api = async (action: string) => {
    if (action === "get_login_info") return { user_id: 1001 };
    if (action === "get_cookies") return { cookies: "skey=x", bkn: "1" };
    return {};
  };

  await h.router.accept(h.inbound({ text: "第一条" }));
  await h.settle();
  assert.match(h.injected.at(-1)?.text ?? "", /## 工作约定/);

  await h.router.accept(h.inbound({ text: "第二条" }));
  await h.settle();
  assert.doesNotMatch(h.injected.at(-1)?.text ?? "", /## 工作约定/, "refreshEveryMessages=0 时不该周期补发");

  h.router.markMemoryStale();
  await h.router.accept(h.inbound({ text: "第三条" }));
  await h.settle();
  assert.match(h.injected.at(-1)?.text ?? "", /## 工作约定/, "标记之后必须重新注入");
});

test("重载会接住记忆节流状态，不因为 reload 就白刷一次", async () => {
  const h = makeHarness((c) => {
    c.memory.enabled = true;
    c.memory.refreshEveryMessages = 100;
  });
  const carry = h.router.carryOver();
  assert.equal(typeof carry.memoryCount, "number");
  assert.equal(carry.memoryDirty, true, "全新 router 初始应当是「需要注入」");
  h.router.markMemoryStale();
  const carry2 = h.router.carryOver();
  assert.equal(carry2.memoryDirty, true);
});

/* ------------------- 注入失败不丢消息 ------------------- */

test("暂时没有活跃会话时，消息会被保留并重试，而不是直接丢掉", async () => {
  const h = makeHarness();
  // 先让 pi 报「没有活跃会话」，再恢复正常 —— 模拟 UI 重连的空窗
  let failing = true;
  const realInject = (h as unknown as { injected: unknown[] });
  // makeHarness 的 deps 是闭包，这里直接换掉 router 用的 deps 不方便，
  // 改用「注入时抛错」的方式：临时把 deps.inject 换成会抛的
  const routerAny = h.router as unknown as { deps: { inject: (t: string, i: unknown[]) => void } };
  const original = routerAny.deps.inject;
  routerAny.deps.inject = () => {
    if (failing) throw new Error("没有活跃会话，无法接收 IM 消息");
    original("恢复了", []);
  };

  await h.router.accept(h.inbound({ text: "这条不能丢" }));
  assert.equal(h.injected.length, 0, "第一次注入应当失败，且不报错回复");
  assert.equal(h.notified.filter((n) => n.includes("把消息交给 pi 失败")).length, 0, "不该立刻发失败提示");

  failing = false;
  // 等重试窗口（5 秒）—— 这里直接触发一次 pump 更快
  (h.router as unknown as { pump: () => void }).pump();
  await sleep(120);
  assert.equal(h.injected.length, 1, "重试成功之后消息必须真的被送进去");
  assert.equal(realInject.injected.length, 1);
});
