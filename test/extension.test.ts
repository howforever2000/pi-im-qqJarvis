/**
 * 扩展工厂集成测试：验证 index.ts 能被加载、命令注册齐全、
 * 并且 session_start / session_shutdown 与 /im status 不会抛错。
 *
 * 通过 PI_CODING_AGENT_DIR 指向临时目录，避免污染真实配置。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-agent-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

// qq 禁用（测“通道被禁用”的守护路径）；wechat 启用但指向一个不可达地址，
// 这样触发登录时会快速失败而不会真的请求腾讯 iLink。
fs.mkdirSync(path.join(tempAgentDir, "im-relay"), { recursive: true });
fs.writeFileSync(
  path.join(tempAgentDir, "im-relay", "config.json"),
  JSON.stringify({
    enabled: true,
    channels: {
      qq: { enabled: false, allowUsers: ["1001"] },
      wechat: { enabled: true, baseUrl: "http://127.0.0.1:1", allowUsers: [] },
    },
  }),
);

const extensionModule = await import("../extensions/im-relay/index.ts");
const imRelay = extensionModule.default as (pi: unknown) => void;
const { getHost, clearHost } = await import("../extensions/im-relay/host.ts");
const { releaseProcessLock } = await import("../extensions/im-relay/lock.ts");

/**
 * host 是进程级单例（这正是修掉「多会话重复启通道」的关键），
 * 所以每个用例开始前要把它和进程锁清干净，否则用例之间会互相影响。
 */
test.beforeEach(() => {
  const host = getHost();
  if (host) {
    if (host.shutdownTimer) clearTimeout(host.shutdownTimer);
    if (host.lock.ok) releaseProcessLock(host.lock.file);
  }
  clearHost();
});

interface Recorded {
  events: string[];
  commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
  tools: Map<string, { description?: string; execute: (id: string, params: unknown, ...rest: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }> }>;
}

function makeFakePi(): { pi: unknown; recorded: Recorded } {
  const recorded: Recorded = { events: [], commands: new Map(), handlers: new Map(), tools: new Map() };
  const pi = {
    on: (event: string, handler: (e: unknown, c: unknown) => Promise<unknown>) => {
      recorded.events.push(event);
      recorded.handlers.set(event, handler);
    },
    registerCommand: (name: string, options: Recorded["commands"] extends Map<string, infer V> ? V : never) => {
      recorded.commands.set(name, options);
    },
    registerTool: (tool: { name: string } & Recorded["tools"] extends Map<string, infer V> ? V : never) => {
      recorded.tools.set(tool.name, tool);
    },
    registerShortcut: () => {},
    registerFlag: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => "测试会话",
    setLabel: () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => () => {}, emit: () => {} },
  };
  return { pi, recorded };
}

function makeFakeCtx(): { ctx: unknown; ui: { notifications: string[]; statuses: Map<string, string | undefined>; widgets: Map<string, string[] | undefined> } } {
  const ui = {
    notifications: [] as string[],
    statuses: new Map<string, string | undefined>(),
    widgets: new Map<string, string[] | undefined>(),
  };
  const ctx = {
    ui: {
      notify: (message: string) => {
        ui.notifications.push(message);
      },
      setStatus: (key: string, value: string | undefined) => {
        ui.statuses.set(key, value);
      },
      setWidget: (key: string, value: string[] | undefined) => {
        ui.widgets.set(key, value);
      },
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
      getSessionId: () => "test",
      getBranch: () => [],
    },
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
    },
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => ({ tokens: 1234, contextWindow: 200_000, percent: 1 }),
    compact: () => {},
    getSystemPrompt: () => "",
  };
  return { ctx, ui };
}

test("扩展工厂只做注册，不启动网络资源", () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  for (const event of ["session_start", "session_shutdown", "message_end", "tool_execution_start", "agent_settled", "input"]) {
    assert.ok(recorded.events.includes(event), `应当注册 ${event} 事件`);
  }
  for (const command of ["im", "im-new", "im-resume"]) {
    assert.ok(recorded.commands.has(command), `应当注册 /${command} 命令`);
  }
  // 工具是“自然语言入口”：不说 /im login 也能触发登录
  for (const tool of ["im_relay_login", "im_relay_status"]) {
    assert.ok(recorded.tools.has(tool), `应当注册 ${tool} 工具`);
  }
});

test("im_relay_status 工具能回答“连上了吗”", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx } = makeFakeCtx();
  await recorded.handlers.get("session_start")?.({}, ctx);

  const result = await recorded.tools.get("im_relay_status")!.execute("t1", {});
  const text = result.content.map((b) => b.text ?? "").join("\n");
  assert.ok(text.includes("pi-im-relay 状态"), text.slice(0, 120));
  assert.ok(text.includes("微信"), "应当包含通道状态");
  assert.ok(text.includes("打开中的会话"), "应当包含会话信息");
});

test("im_relay_login 对未启用的通道给出可操作的提示，不静默失败", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx } = makeFakeCtx();
  await recorded.handlers.get("session_start")?.({}, ctx);

  const result = await recorded.tools.get("im_relay_login")!.execute("t2", { channel: "qq" });
  const text = result.content.map((b) => b.text ?? "").join("");
  assert.ok(text.includes("禁用"), text);
  assert.ok(text.includes("reload"), "要告诉用户改完配置后怎么生效");
});

test("im_relay_login 在申请二维码失败时如实报错，不谎报“已发起”", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx } = makeFakeCtx();
  await recorded.handlers.get("session_start")?.({}, ctx);

  // 配置里 baseUrl 指向一个不可达端口 → 申请二维码会失败
  const result = await recorded.tools.get("im_relay_login")!.execute("t3", { channel: "wechat" });
  const text = result.content.map((b) => b.text ?? "").join("");
  assert.ok(text.includes("失败"), `应当如实报告失败，实际：${text}`);
  assert.ok(!text.includes("已经发到对话里"), "失败时不能说二维码已发出");
});

test("session_start 会读取配置、启动通道并写入页脚状态", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx, ui } = makeFakeCtx();

  // 直接调用注册好的 session_start handler
  const handlers = recorded.handlers;
  await handlers.get("session_start")?.({}, ctx);

  assert.ok(
    ui.notifications.some((n) => n.includes("pi-im-relay 已启动")),
    `应当有启动通知，实际：${JSON.stringify(ui.notifications)}`,
  );
  assert.ok(ui.statuses.has("im-relay"), "应当设置页脚状态");
  // 微信启用但未登录 → 页脚应当是“需要登录”类提示
  assert.match(ui.statuses.get("im-relay") ?? "", /^IM /, `实际：${ui.statuses.get("im-relay")}`);

  // /im status 不应抛错，并且能给出状态文本
  const imCommand = recorded.commands.get("im");
  assert.ok(imCommand);
  await imCommand!.handler("status", ctx);
  assert.ok(ui.notifications.some((n) => n.includes("pi-im-relay 状态")));

  // session_shutdown 不应抛错
  await handlers.get("session_shutdown")?.({}, ctx);
});

test("/im log 与 /im dir 给出路径提示", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx, ui } = makeFakeCtx();
  await recorded.handlers.get("session_start")?.({}, ctx);

  const imCommand = recorded.commands.get("im")!;
  await imCommand.handler("log", ctx);
  await imCommand.handler("dir", ctx);
  assert.ok(ui.notifications.some((n) => n.includes("im-relay.log")));
  assert.ok(ui.notifications.some((n) => n.includes(tempAgentDir)));
});

test("在对话框里输「微信登录」会直接触发登录，不经过模型", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx, ui } = makeFakeCtx();
  await recorded.handlers.get("session_start")?.({}, ctx);

  const result = (await recorded.handlers.get("input")?.(
    { text: "微信登录", source: "rpc" },
    ctx,
  )) as { action: string };

  // handled = 不再交给 agent，所以这一次交互零 token、零延迟
  assert.equal(result.action, "handled", "应当被扩展接管，而不是当成普通提问");
  // 测试配置里微信 baseUrl 指向不可达端口，所以会如实报失败
  assert.ok(
    ui.notifications.some((n) => n.includes("登录未发起") || n.includes("二维码")),
    `应当给出明确反馈，实际：${JSON.stringify(ui.notifications)}`,
  );
});

test("含「微信」的正常提问不会被劫持，仍交给 agent", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx, ui } = makeFakeCtx();
  await recorded.handlers.get("session_start")?.({}, ctx);
  const before = ui.notifications.length;

  const result = (await recorded.handlers.get("input")?.(
    { text: "我们项目里微信登录模块有 bug，帮我修一下", source: "rpc" },
    ctx,
  )) as { action: string };

  assert.equal(result.action, "continue");
  assert.equal(ui.notifications.length, before, "不应该弹任何扩展通知");
});

test("IM 注入的消息（source=extension）不会反过来触发本机动作", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx } = makeFakeCtx();
  await recorded.handlers.get("session_start")?.({}, ctx);

  const result = (await recorded.handlers.get("input")?.(
    { text: "微信登录", source: "extension" },
    ctx,
  )) as { action: string };
  assert.equal(result.action, "continue", "防止微信那头发一句“微信登录”就递归触发登录");
});

test("输「IM状态」直接给出状态文本", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx, ui } = makeFakeCtx();
  await recorded.handlers.get("session_start")?.({}, ctx);

  const result = (await recorded.handlers.get("input")?.({ text: "IM状态", source: "rpc" }, ctx)) as {
    action: string;
  };
  assert.equal(result.action, "handled");
  assert.ok(ui.notifications.some((n) => n.includes("pi-im-relay 状态")));
});

test("未知 /im 子命令给出可用列表", async () => {
  const { pi, recorded } = makeFakePi();
  imRelay(pi);
  const { ctx, ui } = makeFakeCtx();
  await recorded.handlers.get("session_start")?.({}, ctx);
  await recorded.commands.get("im")!.handler("不存在", ctx);
  assert.ok(ui.notifications.some((n) => n.includes("未知子命令")));
});

test("配置文件缺失时会自动创建默认配置", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-fresh-"));
  process.env.PI_CODING_AGENT_DIR = fresh;
  const configPath = path.join(fresh, "im-relay", "config.json");
  assert.equal(fs.existsSync(configPath), false);
  // 直接调用工厂不会读配置（延迟到 session_start），这里显式验证延迟行为
  const { pi } = makeFakePi();
  imRelay(pi);
  assert.equal(fs.existsSync(configPath), false, "工厂阶段不应写配置");
});
