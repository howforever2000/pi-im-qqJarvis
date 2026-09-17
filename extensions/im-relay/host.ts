/**
 * 进程级 host：**所有会话共享同一套通道**。
 *
 * 为什么需要它：pi-web 桌面端一个进程里可以同时开很多会话，而每个会话都会
 * 走一遍 extension factory + session_start。如果每个会话各建一套通道，就会出现：
 *
 *   - N 条 QQ WebSocket 连着同一个 NapCat → 一条 QQ 消息被回复 N 次
 *   - N 个 iLink 长轮询抢同一个 sync_buf 游标 → 重复回复 / 丢消息
 *   - 微信 24h 内 10 条主动消息的额度被 N 倍消耗
 *   - N 个写者并发覆盖 wechat-session.json / chat-map.json
 *
 * 所以：会话是多个，**通道只有一个**。会话只做两件事：
 *   1. 在启动时把自己登记进 host.sessions
 *   2. 竞争「活跃会话」——IM 消息只进活跃会话，回复也只回到 IM
 *
 * 活跃会话的选择规则：
 *   - 用户用 `/im attach` 手动固定后，固定不变（pinned）
 *   - 否则取「最近有过交互」的会话，符合「我正在哪个窗口干活，消息就进哪个」的直觉
 */
import { createLogger, errorText } from "./log.ts";
import { acquireProcessLock, describeHolder, releaseProcessLock, releaseProcessLockOnExit, type LockResult } from "./lock.ts";
import { ChatMapStore } from "./store.ts";
import { ImRelayRouter } from "./router.ts";
import { QqChannel } from "./channels/qq.ts";
import { WechatChannel } from "./channels/wechat.ts";
import { DATA_DIR, loadConfig, saveConfig, type ImRelayConfig } from "./config.ts";
import { startConfigWatch, stopConfigWatch, syncConfigWatch } from "./watch.ts";
import type { ChannelStatus, QrPayload } from "./channels/types.ts";
import { deliverLoginQr as deliverLoginQrTo, deliverLoginQrFallback as deliverLoginQrFallbackTo, type LoginUiPort } from "./login-ui.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";

const log = createLogger("host");

export const STATUS_KEY = "im-relay";
export const QR_WIDGET_KEY = "im-relay-qr";
/** 编辑器上方的常驻提醒（pi-web 里唯一能“一直在界面上”的地方） */
export const STATUS_WIDGET_KEY = "im-relay-status";
const LOCK_FILE = path.join(DATA_DIR, "relay.lock");

/** 一个已登记到 host 的 pi 会话。 */
export interface SessionBinding {
  id: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  updatedAt: number;
  label: string;
}

export interface RelayHost {
  config: ImRelayConfig;
  chatMap: ChatMapStore;
  router: ImRelayRouter;
  sessions: Map<string, SessionBinding>;
  /** 是否由 /im attach 手动固定 */
  pinned: boolean;
  lock: LockResult;
  /** 通道是否真的启动了（抢不到锁时为 false） */
  channelsRunning: boolean;
  /** 当前活跃会话 id。请用 activeBinding() 读取，它会处理兜底逻辑 */
  activeSessionIdValue?: string;
  /** 最近一次投递过的登录二维码 */
  lastQr?: { channel: string; qr: QrPayload };
  /** 最后一个会话关闭后的延迟拆机定时器 */
  shutdownTimer?: NodeJS.Timeout;
  /** config.json 热加载：目录监听句柄 */
  configWatcher?: import("node:fs").FSWatcher;
  /** config.json 热加载：去抖定时器 */
  configWatchTimer?: NodeJS.Timeout;
  /** config.json 热加载：上一次已知内容的哈希 */
  configWatchHash?: string;
}

const HOST_SLOT = "__piImRelayHost";

function slot(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

export function getHost(): RelayHost | undefined {
  return slot()[HOST_SLOT] as RelayHost | undefined;
}

export function clearHost(): void {
  delete slot()[HOST_SLOT];
}

/**
 * 创建（或返回已存在的）host。只有第一次调用会真正抢锁并启动通道。
 */
export async function ensureHost(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RelayHost> {
  const existing = getHost();
  if (existing) {
    ensureConfigWatch(existing);
    return existing;
  }

  const { config } = loadConfig();
  const chatMap = new ChatMapStore();
  chatMap.load();

  const lock = acquireProcessLock(LOCK_FILE, `agentDir=${DATA_DIR}`);
  if (!lock.ok) {
    log.warn(`未能取得单实例锁：${describeHolder(lock.holder)} 正在运行`);
  } else {
    releaseProcessLockOnExit(lock.file);
  }

  // router 需要一个 pi 端口，但端口要指向「活跃会话」，而活跃会话此时还没定。
  // 所以先建一个转发壳，等会话登记进来后再解析。
  const router = new ImRelayRouter(config, makePort(), chatMap);

  const host: RelayHost = {
    config,
    chatMap,
    router,
    sessions: new Map(),
    pinned: false,
    lock,
    channelsRunning: false,
  };
  slot()[HOST_SLOT] = host;

  router.promptUser = async (question: string) => {
    const binding = activeBinding(host);
    if (!binding?.ctx.hasUI) return undefined;
    return binding.ctx.ui.input(question, "请输入…");
  };
  registerChannels(host);

  if (lock.ok) {
    await router.start();
    host.channelsRunning = true;
    log.info(`通道已启动（会话数将随界面变化，通道始终只有一套）`);
  } else {
    log.warn(`通道未启动：${describeHolder(lock.holder)} 已占用。请在那边操作，或关掉那个 pi 再重启本进程。`);
  }

  // 配置热加载：改了 config.json 就自动 reload，不用再手敲 /im reload
  ensureConfigWatch(host);

  return host;
}

/**
 * 只在还没监听时才装上配置监听。
 *
 * 为什么不是无条件调用：`/reload` 会换掉扩展代码，但**故意保留**同一个 host
 * （不然通道会白抖一下）。所以新代码里的 `ensureHost()` 会拿到一个由**旧代码**
 * 建立、身上没有任何监听器的 host —— 这里补上，热加载才能对「已经跑着的 host」生效。
 */
function ensureConfigWatch(host: RelayHost): void {
  if (host.configWatcher || host.configWatchTimer) return;
  startConfigWatch(host, reloadHost);
}

/** 会话登记。返回 host，方便调用方继续用。 */
export function registerSession(host: RelayHost, binding: SessionBinding): void {
  host.sessions.set(binding.id, binding);
  if (!activeBinding(host) || !host.pinned) {
    setActive(host, binding.id);
  } else {
    pushStatus(host);
  }
  log.info(`会话已登记 ${binding.id.slice(0, 8)}（当前共 ${host.sessions.size} 个）`);
}

export function unregisterSession(host: RelayHost, sessionId: string): void {
  host.sessions.delete(sessionId);
  log.info(`会话已注销 ${sessionId.slice(0, 8)}（剩余 ${host.sessions.size} 个）`);
  if (host.activeSessionIdValue === sessionId) {
    // 活跃会话没了：优先切到最近有交互的那个
    const next = [...host.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    host.activeSessionIdValue = next?.id;
  }
  pushStatus(host);
}

/** 把某个会话标记为「最近有交互」，未固定时它会成为活跃会话。 */
export function touchSession(host: RelayHost, sessionId: string): void {
  const binding = host.sessions.get(sessionId);
  if (!binding) return;
  binding.updatedAt = Date.now();
  if (!host.pinned) setActive(host, sessionId);
}

export function setActive(host: RelayHost, sessionId: string, pin = false): void {
  host.activeSessionIdValue = sessionId;
  if (pin) {
    host.pinned = true;
    log.info(`已固定活跃会话 ${sessionId.slice(0, 8)}`);
  }
  pushStatus(host);
}

export function activeBinding(host: RelayHost): SessionBinding | undefined {
  const id = host.activeSessionIdValue;
  if (id) {
    const binding = host.sessions.get(id);
    if (binding) return binding;
  }
  return [...host.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/* ------------------------------------------------------------------ */
/* 通道与 UI 的接线                                                    */
/* ------------------------------------------------------------------ */

function registerChannels(host: RelayHost): void {
  const { config, router } = host;
  router.registerChannel(
    new QqChannel(
      config.channels.qq,
      {
        onMessage: (message) => router.accept(message),
        onStatusChange: (status) => router.handleChannelStatus(status),
        onLoginQr: (payload) => deliverLoginQr(host, payload),
        onLoginQrFallback: (url) => deliverLoginQrFallback(host, url, "QQ登录"),
      },
      config.maxReplyChars,
    ),
  );
  router.registerChannel(
    new WechatChannel(
      config.channels.wechat,
      {
        onMessage: (message) => router.accept(message),
        onStatusChange: (status) => router.handleChannelStatus(status),
        onPrompt: (question) => router.handleChannelPrompt(question),
        onLoginQr: (payload) => deliverLoginQr(host, payload),
        onLoginQrFallback: (url) => deliverLoginQrFallback(host, url, "微信登录"),
      },
      config.maxReplyChars,
    ),
  );
}

/** 登录二维码：按活跃会话所在界面的渲染能力投递。 */
function loginUiPort(host: RelayHost): LoginUiPort {
  const get = () => activeBinding(host);
  return {
    mode: () => get()?.ctx.mode,
    hasUi: () => get()?.ctx.hasUI ?? false,
    supportsImages: () => {
      const input = get()?.ctx.model?.input;
      return Array.isArray(input) ? input.includes("image") : false;
    },
    setWidget: (lines) => get()?.ctx.ui?.setWidget(QR_WIDGET_KEY, lines, { placement: "aboveEditor" }),
    setStatus: (text) => get()?.ctx.ui?.setStatus(STATUS_KEY, text),
    notify: (message, level) => get()?.ctx.ui?.notify(message, level),
    sendCustomMessage: (message) => {
      const binding = get();
      if (!binding) throw new Error("没有活跃会话");
      binding.pi.sendMessage(message as Parameters<ExtensionAPI["sendMessage"]>[0]);
    },
    onError: (message, error) => log.warn(`${message}: ${errorText(error)}`),
  };
}

export function deliverLoginQr(host: RelayHost, payload: { channel: string; qr: QrPayload }): void {
  host.lastQr = payload;
  const via = deliverLoginQrTo(loginUiPort(host), payload);
  log.info(`已投递 ${payload.channel} 登录二维码（方式：${via}）`);
}

export function deliverLoginQrFallback(host: RelayHost, url: string, name = "登录"): void {
  deliverLoginQrFallbackTo(loginUiPort(host), url, name);
}

/**
 * 重新投递当前二维码（/im qr）。
 *
 * 遍历所有通道 —— QQ 现在也是扫码登录，不能只看微信。都没码时
 * 退回到最近一次投递过的码（例如刚扫码成功、渠道已清空的情况）。
 */
export function showQrAgain(host: RelayHost): boolean {
  for (const id of ["qq", "wechat"] as const) {
    const channel = host.router.channel(id) as { loginQr?: () => QrPayload | undefined } | undefined;
    const qr = channel?.loginQr?.();
    if (qr) {
      deliverLoginQr(host, { channel: id, qr });
      return true;
    }
  }
  if (host.lastQr) {
    deliverLoginQr(host, host.lastQr);
    return true;
  }
  return false;
}

/**
 * 把通道状态写进活跃会话的页脚，并在“需要你动手”时于编辑器上方加一条常驻提示。
 *
 * 为什么需要 widget：pi-web 的设置页没有扩展插槽（它的分区是写死的），
 * 所以扩展能提供的最接近“界面上的入口”就是编辑器上方这块地方。
 * 页脚 setStatus 只能放一行短文本，没地方写“接下来该说什么”。
 */
export function pushStatus(host: RelayHost): void {
  const binding = activeBinding(host);
  if (!binding?.ctx.ui) return;
  const all = host.router.statusesSnapshot();
  const online = all.filter((s) => s.state === "online").map((s) => s.name);
  const pending = all.filter((s) => s.state === "needs-login");
  const errored = all.filter((s) => s.state === "error");

  let text: string | undefined;
  if (!host.channelsRunning) text = "IM ⏸ 已被其它 pi 进程占用";
  else if (errored.length > 0) text = `IM ⚠ ${errored.map((s) => s.name).join(",")}`;
  else if (pending.length > 0) text = `IM 🔑 ${pending.map((s) => s.name).join(",")}`;
  else if (online.length > 0) text = `IM ● ${online.join(",")}`;
  try {
    binding.ctx.ui.setStatus(STATUS_KEY, text);
  } catch (error) {
    log.debug(`写页脚状态失败: ${errorText(error)}`);
  }

  // 只在“需要用户动手”时才占地方；一切正常就收起，别挡着编辑器
  const lines = buildActionHint(host, all, online, pending, errored);
  const serialized = lines?.join("\n");
  if (serialized === lastWidgetText) return;
  lastWidgetText = serialized;
  try {
    binding.ctx.ui.setWidget(STATUS_WIDGET_KEY, lines, { placement: "aboveEditor" });
  } catch (error) {
    log.debug(`写状态挂件失败: ${errorText(error)}`);
  }
}

/** 上一次写过的挂件内容，避免每次状态变化都重复推送。 */
let lastWidgetText: string | undefined;

/** 生成“你现在该做什么”的提示；不需要动手时返回 undefined。 */
function buildActionHint(
  host: RelayHost,
  all: ChannelStatus[],
  online: string[],
  pending: ChannelStatus[],
  errored: ChannelStatus[],
): string[] | undefined {
  const lines: string[] = [];

  if (!host.channelsRunning && host.lock && !host.lock.ok) {
    lines.push(`IM · 通道已被另一个 pi 进程占用（pid=${host.lock.holder.pid}），本进程不重复连接`);
    return lines;
  }

  for (const status of pending) {
    lines.push(
      status.id === "wechat"
        ? "IM · 微信未登录 → 在下面输入框直接发「微信登录」就能出二维码"
        : `IM · ${status.name} 未登录 → 输入「${status.id.toUpperCase()}登录」或 /im login ${status.id}`,
    );
  }

  for (const status of errored) {
    lines.push(`IM · ${status.name} 连接失败 → /im status 看诊断`);
  }

  // 启用了但状态是 off 的通道也提一句（例如配置里没打开）
  for (const status of all) {
    if (status.state === "off") lines.push(`IM · ${status.name} 未启用 → /im status`);
  }

  if (lines.length === 0) {
    // 全部就绪就不占地方；只接了一半时提醒一下
    const missing = all.filter((s) => !online.includes(s.name));
    return online.length > 0 && missing.length > 0 ? [`IM · 已连接：${online.join("、")}`] : undefined;
  }
  return lines.slice(0, 3);
}

/* ------------------------------------------------------------------ */
/* 端口：所有 pi 交互都打到「活跃会话」                                 */
/* ------------------------------------------------------------------ */

export function makePort(): import("./router.ts").PiPort {
  /** 解析活跃会话；没有 host 或没有会话时返回 undefined，由各方法各自保底 */
  const binding = (): SessionBinding | undefined => {
    const h = getHost();
    return h ? activeBinding(h) : undefined;
  };

  return {
    isIdle: () => {
      try {
        return binding()?.ctx.isIdle() ?? true;
      } catch {
        return true;
      }
    },
    inject: (text, images) => {
      const target = binding();
      if (!target) throw new Error("没有活跃会话，无法接收 IM 消息");
      if (images.length === 0) {
        target.pi.sendUserMessage(text);
        return;
      }
      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text }];
      for (const image of images) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
      target.pi.sendUserMessage(content);
    },
    dispatchCommand: (command) => {
      const target = binding();
      if (!target) throw new Error("没有活跃会话");
      target.pi.sendUserMessage(`/${command}`, { expandPromptTemplates: true });
    },
    abort: () => {
      try {
        binding()?.ctx.abort();
      } catch (error) {
        log.debug(`中断失败: ${errorText(error)}`);
      }
    },
    describeSession: () => {
      const target = binding();
      const h = getHost();
      if (!target) return "会话：（尚未就绪）";
      const lines: string[] = [];
      try {
        const model = target.ctx.model;
        lines.push(`模型：${model ? `${model.provider}/${model.id}` : "(未设置)"}`);
      } catch {
        lines.push("模型：(读取失败)");
      }
      lines.push(`会话：${target.label}`);
      try {
        const usage = target.ctx.getContextUsage();
        if (usage) {
          const win = `${Math.round(usage.contextWindow / 1000)}k`;
          const used = usage.tokens === null ? "?" : `${Math.round(usage.tokens / 1000)}k`;
          const pct = usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
          lines.push(`上下文：${used} / ${win}（${pct}）`);
        }
      } catch {
        /* ignore */
      }
      if (h) {
        lines.push(`打开中的会话：${h.sessions.size} 个${h.pinned ? "（已由 /im attach 固定）" : ""}`);
      }
      return lines.join("\n");
    },
    switchModel: async (spec) => {
      const target = binding();
      if (!target) return "会话尚未就绪，无法切换模型。";
      const models = target.ctx.modelRegistry.getAvailable();
      let found = models.find((m) => `${m.provider}/${m.id}` === spec);
      if (!found) {
        const [provider, ...rest] = spec.split("/");
        if (rest.length > 0 && provider) found = target.ctx.modelRegistry.find(provider, rest.join("/"));
      }
      if (!found) found = models.find((m) => m.id === spec);
      if (!found) return `找不到模型：${spec}`;
      const ok = await target.pi.setModel(found);
      if (!ok) return `切换到 ${found.provider}/${found.id} 失败：没有可用的 API Key。`;
      return `已切换到模型：${found.provider}/${found.id}`;
    },
    listModels: () => {
      const target = binding();
      if (!target) return [];
      return target.ctx.modelRegistry
        .getAvailable()
        .map((m) => `${m.provider}/${m.id}`)
        .sort();
    },
    notify: (message, level) => {
      try {
        binding()?.ctx.ui?.notify(message, level);
      } catch (error) {
        log.debug(`通知失败: ${errorText(error)}`);
      }
    },
    onChannelStatus: () => {
      const h = getHost();
      if (h) pushStatus(h);
    },
  };
}

/**
 * 最后一个会话关闭后，延迟一会儿再真正拆通道。
 *
 * pi-web 会回收空闲会话，如果一关会话就断 NapCat / 停 iLink 长轮询，
 * 用户每次切会话都会看到通道抖一下。给一段宽限期，新会话接上就取消。
 */
export function scheduleHostShutdown(host: RelayHost, delayMs: number, onShutdown: () => void): void {
  cancelHostShutdown(host);
  const timer = setTimeout(onShutdown, delayMs);
  timer.unref?.();
  host.shutdownTimer = timer;
  log.info(`所有会话已关闭，${Math.round(delayMs / 1000)}s 后关闭 IM 通道（新会话启动则取消）`);
}

export function cancelHostShutdown(host: RelayHost): void {
  if (!host.shutdownTimer) return;
  clearTimeout(host.shutdownTimer);
  host.shutdownTimer = undefined;
}

/** 供 /im reload 和热加载使用：换掉配置并重建通道。 */
export async function reloadHost(host: RelayHost): Promise<void> {
  // 先把「正在处理的那条消息」和最近的可回复目标接过来。
  // 不接的话，重载恰好撞上某轮处理中间时会静默吞掉那一轮的结果。
  const carry = host.router.carryOver();
  await host.router.stop().catch(() => undefined);
  const { config } = loadConfig();
  host.config = config;
  host.chatMap.dispose();
  const chatMap = new ChatMapStore();
  chatMap.load();
  host.chatMap = chatMap;
  const router = new ImRelayRouter(config, makePort(), chatMap);
  router.adopt(carry);
  router.promptUser = async (question: string) => {
    const binding = activeBinding(host);
    if (!binding?.ctx.hasUI) return undefined;
    return binding.ctx.ui.input(question, "请输入…");
  };
  host.router = router;
  registerChannels(host);
  if (host.lock.ok) {
    await router.start();
    host.channelsRunning = true;
  }
  // 重载完成后对齐基线，避免刚重载完又被自己的写入触发一次循环
  syncConfigWatch(host);
  pushStatus(host);
}

export function shutdownHost(host: RelayHost): void {
  stopConfigWatch(host);
  host.chatMap.dispose();
  if (host.lock.ok) releaseProcessLock(host.lock.file);
  clearHost();
}

export function saveHostConfig(host: RelayHost): void {
  saveConfig(host.config);
  // 自己写的配置，对齐基线：不该触发一次热加载
  syncConfigWatch(host);
}

export type { ChannelStatus, LockResult };
