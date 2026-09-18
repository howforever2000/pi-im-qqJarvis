/**
 * IM ↔ pi 路由核心。
 *
 * 职责：
 *  1. 入站准入（白名单 / 去重 / 限流）
 *  2. 会话排队：同一时刻只让 pi 处理一个 IM 请求，回复回到发起者
 *  3. 出站回传：agent 最终答复 +（可选）工具进度
 *  4. IM 侧控制命令
 *
 * 设计要点：pi 只有一个会话，所以多个 IM 会话共享同一段上下文。
 * 为了让「谁问的谁收到答案」，这里维护 current job：一个 turn 的产出只回给
 * 触发这个 turn 的那个 IM 会话；期间其它人的消息进队列。
 */
import { createLogger, errorText } from "./log.ts";
import { ChatMapStore } from "./store.ts";
import { DedupeSet, RateLimiter, humanAge } from "./text.ts";
import { normalizeTrigger } from "./triggers.ts";
import { saveInboundImages } from "./album.ts";
import { buildMemory } from "./memory.ts";
import type { ImRelayConfig } from "./config.ts";
import type { Channel, ChannelId, ChannelStatus, ChatTarget, InboundMessage } from "./channels/types.ts";

const log = createLogger("router");
const PROGRESS_THROTTLE_MS = 5000;
/** 注入失败（通常是暂时没有活跃会话）时最多重试几次，每 5 秒一次 */
const MAX_INJECT_RETRIES = 6;

export interface PiPort {
  /** pi 当前是否空闲（可以接受新的 prompt） */
  isIdle(): boolean;
  /** 注入一条用户消息；images 为 base64 */
  inject(text: string, images: Array<{ mimeType: string; data: string }>): void;
  /** 触发一次扩展命令（内部用于 /new、/resume 这类需要命令上下文的操作） */
  dispatchCommand(command: string): void;
  /** 中断当前 turn */
  abort(): void;
  /** 供 /status 使用的多行会话描述 */
  describeSession(): string;
  /** 切换模型，返回给用户的结果文本 */
  switchModel(spec: string): Promise<string>;
  /** 可用模型列表（形如 provider/modelId） */
  listModels(): string[];
  /** TUI 通知 */
  notify(message: string, level: "info" | "warning" | "error"): void;
  /** 通道状态变化时同步到 TUI 页脚 */
  onChannelStatus(all: ChannelStatus[]): void;
}

export interface Job {
  inbound: InboundMessage;
  queuedAt: number;
  /**
   * 垫在用户消息前面的附加信息（相册回执、工作约定、主页记忆…）。
   * 在**入队时**就组装好：一是避免重复做同样的活，二是让「重载时队列接力」
   * 能把这份上下文一起带过去。
   */
  notes?: string[];
  /** 注入失败重试次数；超过上限才告诉用户失败 */
  retries?: number;
}

/**
 * 重建通道时要带过去的状态。
 *
 * 不带不行：热加载（和 `/im reload`）会 new 一个 router，而「正在处理的那条消息」
 * 是挂在 router 实例上的。如果重载恰好发生在某一轮处理中间，新的 router 里
 * `current` 是空的，`onSettled()` 就什么也不做 —— 用户看到的现象是
 * 「发了消息，agent 跑了半天，一个字都没回」。
 *
 * 队列同理：重载时排队中的消息不能直接丢掉。
 */
export interface RouterCarry {
  current?: Job;
  queue: Job[];
  lastTarget?: ChatTarget;
  lastTargets: Array<[ChannelId, ChatTarget]>;
  lastAssistantText?: string;
  lastStopReason?: string;
  toolCount: number;
  /** 记忆注入的节流状态，重载时要接着算 */
  memoryCount?: number;
  memoryDirty?: boolean;
}

export class ImRelayRouter {
  private readonly channels = new Map<ChannelId, Channel>();
  private readonly statuses = new Map<ChannelId, ChannelStatus>();
  private readonly dedupe = new DedupeSet();
  private rateLimiter: RateLimiter;
  private readonly queue: Job[] = [];
  private current: Job | undefined;
  private lastAssistantText: string | undefined;
  private lastStopReason: string | undefined;
  private toolCount = 0;
  private lastProgressAt = 0;
  private pendingControl: { target: ChatTarget; label: string } | undefined;
  /** 最近一次发起 turn 的目标，用于本地输入镜像 */
  private lastTarget: ChatTarget | undefined;
  /**
   * 最近一次入站的可回复目标，按通道索引。
   * 发文件时要知道「刚才跟我说话的是哪个会话」—— lastTarget 只有一个，
   * QQ 和微信交替来消息时会被覆盖，所以这里按通道各存一份。
   */
  private readonly lastTargets = new Map<ChannelId, ChatTarget>();
  private controlSeq = 0;
  private stopping = false;
  /**
   * 记忆注入的节流状态。
   *
   * 完整记忆（工作约定 + 身份 + 聊天记录 + 说说）体积不小，每条消息都塞一遍
   * 很浪费 token；但完全不重塞又会在上下文被压缩后失忆。
   * 所以：新会话/刚登录时必发一次（dirty=true），之后每隔 N 条补发一次。
   */
  private memoryCount = 0;
  private memoryDirty = true;

  private config: ImRelayConfig;
  private readonly deps: PiPort;
  private readonly chatMap: ChatMapStore;

  constructor(config: ImRelayConfig, deps: PiPort, chatMap: ChatMapStore) {
    this.config = config;
    this.deps = deps;
    this.chatMap = chatMap;
    this.rateLimiter = new RateLimiter(config.rateLimitPerMinute);
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
    this.statuses.set(channel.id, channel.status());
  }

  async start(): Promise<void> {
    this.stopping = false;
    for (const channel of this.channels.values()) {
      try {
        await channel.start();
      } catch (error) {
        log.error(`${channel.name} 通道启动失败: ${errorText(error)}`);
        this.deps.notify(`${channel.name} 通道启动失败：${errorText(error)}`, "error");
      }
      this.statuses.set(channel.id, channel.status());
    }
    this.deps.onChannelStatus([...this.statuses.values()]);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const channel of this.channels.values()) {
      await channel.stop().catch((error) => log.warn(`${channel.name} 停止失败: ${errorText(error)}`));
    }
    this.deps.onChannelStatus([...this.statuses.values()]);
  }

  channel(id: ChannelId): Channel | undefined {
    return this.channels.get(id);
  }

  statusesSnapshot(): ChannelStatus[] {
    return [...this.statuses.values()];
  }

  /**
   * 「这个文件该回给谁」：优先当前正在处理的那个会话（tool 调用发生在 turn 内），
   * 其次最近一次入站的会话。
   * 指定 channel 时，若当前目标不属于该通道，就退回该通道最近一次的入站目标。
   * 只认「最近跟我说话的人」，不存在向任意第三方推送的入口。
   */
  replyTarget(channel?: ChannelId): ChatTarget | undefined {
    const active = this.current?.inbound.target ?? this.lastTarget;
    if (!channel) return active;
    if (active?.channel === channel) return active;
    return this.lastTargets.get(channel);
  }

  /**
   * 导出可跨越重载保留的状态。见 `RouterCarry` 的说明：
   * 不搬这一份，「重载恰好发生在某轮处理中间」就会把结果静默丢掉。
   */
  carryOver(): RouterCarry {
    return {
      current: this.current,
      queue: [...this.queue],
      lastTarget: this.lastTarget,
      lastTargets: [...this.lastTargets.entries()],
      lastAssistantText: this.lastAssistantText,
      lastStopReason: this.lastStopReason,
      toolCount: this.toolCount,
      memoryCount: this.memoryCount,
      memoryDirty: this.memoryDirty,
    };
  }

  /** 把上一个 router 的状态接过来（重建通道 / 热加载时用）。 */
  adopt(carry: RouterCarry): void {
    this.current = carry.current;
    this.queue.push(...carry.queue);
    this.lastTarget = carry.lastTarget;
    this.lastTargets.clear();
    for (const [id, target] of carry.lastTargets) this.lastTargets.set(id, target);
    this.lastAssistantText = carry.lastAssistantText;
    this.lastStopReason = carry.lastStopReason;
    this.toolCount = carry.toolCount;
    if (carry.memoryCount !== undefined) this.memoryCount = carry.memoryCount;
    if (carry.memoryDirty !== undefined) this.memoryDirty = carry.memoryDirty;
  }

  /**
   * 标记「下次必须完整注入记忆」。
   *
   * 两处会调：新会话开始（含新建/恢复/fork/重载）、以及通道刚登录成功。
   * 这两个时刻正是用户要求「先读一遍聊天记录」的时机。
   */
  markMemoryStale(): void {
    this.memoryDirty = true;
  }

  /** 这一条消息该不该注入记忆。 */
  private shouldInjectMemory(): boolean {
    if (!this.config.memory.enabled) return false;
    if (this.memoryDirty) return true;
    const every = this.config.memory.refreshEveryMessages;
    return every > 0 && this.memoryCount > 0 && this.memoryCount % every === 0;
  }

  /**
   * 由定时任务触发的注入。
   *
   * 为什么走「排一个 job」而不是直接注入：
   *   - 走 job 才能带上垫话（工作约定 + 记忆 + 相册回执）
   *   - 而且 agent 跑完的结果有地方回 —— 直接注入的话 current 为空，
   *     onSettled() 会直接跳过，用户看不到任何反馈
   *
   * 目标优先用「最近跟我说过话的那个 QQ 会话」，没有就回退到白名单里的第一个号。
   */
  enqueueScheduled(text: string, notes: string[] = []): boolean {
    if (this.stopping || !this.config.enabled) return false;
    const target = this.lastTargets.get("qq") ?? this.ownerTarget();
    if (!target) {
      log.warn("定时任务没有可用的 QQ 目标（白名单为空且从未收到过 QQ 消息）");
      return false;
    }

    const senderId = String((target.route as { userId?: string } | undefined)?.userId ?? "scheduler");
    const inbound: InboundMessage = {
      channel: target.channel,
      chatId: target.chatId,
      conversationKey: target.conversationKey,
      senderId,
      senderName: "计划任务",
      label: `${target.label}（定时任务）`,
      isGroup: false,
      text,
      images: [],
      dedupeKey: `scheduled:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      receivedAt: Date.now(),
      target,
    };

    this.lastTargets.set(inbound.channel, target);
    if (this.queue.length >= this.config.queueLimit) {
      const dropped = this.queue.shift();
      if (dropped) log.warn(`队列已满，丢弃最旧消息（${dropped.inbound.label}）`);
    }
    this.queue.push({ inbound, queuedAt: Date.now(), notes });
    log.info(`定时任务已入队：${target.label}`);
    this.pump();
    return true;
  }

  /** 从白名单推一个号主私聊目标（用于定时任务，哪怕对方还没发过消息）。 */
  private ownerTarget(): ChatTarget | undefined {
    const uin = this.config.channels.qq.allowUsers[0];
    if (!uin) return undefined;
    return {
      channel: "qq",
      chatId: `private:${uin}`,
      conversationKey: `qq:user:${uin}`,
      label: `QQ 私聊 ${uin}`,
      route: { userId: uin },
    };
  }

  /** 由通道回调：状态变化。 */
  handleChannelStatus(status: ChannelStatus): void {
    this.statuses.set(status.id, status);
    this.deps.onChannelStatus([...this.statuses.values()]);
  }

  /** 由通道回调：需要用户输入（如微信配对码）。 */
  handleChannelPrompt = async (question: string): Promise<string | undefined> => {
    return this.promptUser?.(question);
  };

  /** 由 index.ts 注入：在 TUI 里向用户提问。 */
  promptUser: ((question: string) => Promise<string | undefined>) | undefined;

  /* ---------------------------- 入站 ---------------------------- */

  async accept(inbound: InboundMessage): Promise<void> {
    if (this.stopping || !this.config.enabled) return;

    if (!this.isWhitelisted(inbound)) {
      log.info(`拒绝未授权消息 ${inbound.label}（sender=${inbound.senderId}）`);
      if (this.config.announceUnpaired) {
        await this.replyRaw(
          inbound.target,
          `你不在白名单里，无法调用本机 agent。\n你的标识：${inbound.senderId}` +
            (inbound.isGroup ? `\n群标识：${inbound.groupId}` : "") +
            `\n请把这一行发给管理员，加入 <agentDir>/im-relay/config.json 后即可使用。`,
        ).catch(() => undefined);
      }
      return;
    }

    // 记录可回复目标：只有过了白名单的消息才算「跟我说话的人」
    this.lastTargets.set(inbound.channel, inbound.target);

    if (!this.rateLimiter.allow(`${inbound.channel}:${inbound.senderId}`)) {
      log.warn(`限流丢弃 ${inbound.label}`);
      return;
    }

    if (!this.dedupe.add(inbound.dedupeKey)) {
      log.debug(`重复消息丢弃 ${inbound.dedupeKey}`);
      return;
    }

    this.chatMap.record({
      conversationKey: inbound.conversationKey,
      channel: inbound.channel,
      label: inbound.label,
      senderId: inbound.senderId,
      text: inbound.text || `[${inbound.images.length} 张图片]`,
    });

    const command = parseCommand(inbound.text);
    if (command) {
      await this.handleInboundCommand(inbound, command.name, command.args);
      return;
    }

    // IM 侧的自然语言状态入口。
    //
    // 为什么需要：IM 消息只有 `/` 开头的才走命令快通道（parseCommand 要求
    // startsWith("/")），【裸短语一律排队等 agent】。而 agent 一旦卡在长任务里
    // （派活、跑构建、独立验收），一句「是否在线」就要等几分钟 —— 用户体感就是
    // 机器人失联。实测就是：三分钟里连问三次状态，三次全在排队。
    //
    // 注意别跟 triggers.ts 搞混：那个 matchLocalTrigger 只挂在 pi 的本地 input
    // 事件上，而且开头的 `event.source === "extension"` 就把 IM 注入的消息排除了；
    // 它命中后也只是 ctx.ui.notify 弹本地通知，根本不是 IM 回复。
    //
    // 这里把「整句就是一个状态短语」的话就地答掉：零 token、零延迟。
    // 必须整句精确匹配（沿用 normalizeTrigger 的归一化）—— 用包含匹配的话，
    // 「机器人状态怎么同步到云端」这种正常提问会被劫持。
    const quick = matchImQuickQuery(inbound.text);
    // status 类永远就地答（答案纯机械）；progress 类只在 agent 忙时拦截 ——
    // 空闲时放它过去，那种问题该由 agent 去查真实进展（比如 workbubby 干到哪了），
    // 只有「本来要等很久」的时候才值得用兜底文案顶一下。
    if (quick === "status" || (quick === "progress" && !this.deps.isIdle())) {
      await this.replyRaw(inbound.target, quick === "status" ? this.buildStatusText() : this.buildProgressText());
      return;
    }

    if (this.queue.length >= this.config.queueLimit) {
      const dropped = this.queue.shift();
      if (dropped) log.warn(`队列已满，丢弃最旧消息（${dropped.inbound.label}）`);
    }

    // 组装要垫在消息前面的上下文：相册回执（同步）+ 工作约定与主页记忆（异步、带缓存）
    const notes = await this.buildNotes(inbound);
    this.queue.push({ inbound, queuedAt: Date.now(), notes });
    this.pump();
  }

  /**
   * 拼「消息之前的垫话」。任何一步失败都只跳过那一步 ——
   * 存相册、读记忆都是附赠能力，不能因为它们把用户消息本身弄丢。
   */
  private async buildNotes(inbound: InboundMessage): Promise<string[]> {
    const notes: string[] = [];

    if (inbound.images.length > 0 && this.config.album.enabled) {
      try {
        const saved = saveInboundImages(inbound.images, this.config.album, new Date(inbound.receivedAt));
        for (const s of saved) {
          if (!this.config.album.announce) continue;
          notes.push(
            s.duplicate
              ? `[相册] 这张图之前已存过，直接复用：${s.file}`
              : `[相册] 已保存：${s.file}（${(s.bytes / 1024).toFixed(1)} KB）`,
          );
        }
      } catch (error) {
        log.warn(`相册处理失败（已跳过）：${errorText(error)}`);
      }
    }

    if (this.config.memory.enabled) {
      this.memoryCount += 1;
    }
    if (this.shouldInjectMemory()) {
      const channel = this.channels.get(inbound.channel);
      const raw = channel?.api;
      if (raw) {
        // 对端：私聊就是对方，群聊就是群。聊天记录按对端分开读
        const peer =
          inbound.isGroup && inbound.groupId
            ? ({ kind: "group", id: inbound.groupId } as const)
            : ({ kind: "private", id: inbound.senderId } as const);
        try {
          const memory = await buildMemory(
            (action, params) => raw.call(channel, action, params),
            this.config.memory,
            { cacheKey: `${inbound.channel}:${peer.id}`, peer },
          );
          // 只有真的拿到内容才算「发过了」，否则留 dirty 下次再试
          if (memory.text) {
            notes.push(memory.text);
            this.memoryDirty = false;
          }
        } catch (error) {
          log.warn(`记忆组装失败（已跳过）：${errorText(error)}`);
        }
      } else {
        // 该通道没有协议接口（比如微信），读不了记忆；不要卡在 dirty 上反复重试
        this.memoryDirty = false;
      }
    }

    return notes;
  }

  private isWhitelisted(inbound: InboundMessage): boolean {
    if (inbound.channel === "qq") {
      const cfg = this.config.channels.qq;
      if (!inbound.isGroup) return cfg.allowUsers.includes(inbound.senderId);
      // 群聊：群必须在白名单里；若同时配置了用户白名单，则发言人也需在内
      const groupOk = inbound.groupId ? cfg.allowGroups.includes(inbound.groupId) : false;
      if (!groupOk) return false;
      if (cfg.allowUsers.length === 0) return true;
      return cfg.allowUsers.includes(inbound.senderId);
    }
    return this.config.channels.wechat.allowUsers.includes(inbound.senderId);
  }

  /* ---------------------------- 出站队列 ---------------------------- */

  private pump(): void {
    if (this.stopping) return;
    if (this.current) return;
    if (this.queue.length === 0) return;
    if (!this.deps.isIdle()) return;

    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    this.lastTarget = job.inbound.target;
    this.lastAssistantText = undefined;
    this.lastStopReason = undefined;
    this.toolCount = 0;
    this.lastProgressAt = 0;

    const { inbound } = job;
    const header = this.buildHeader(job);
    log.info(`提交给 pi：${inbound.label}`);
    try {
      this.deps.inject(`${header}${inbound.text}`, inbound.images);
    } catch (error) {
      // 「没有活跃会话」往往是暂时的（UI 重连、扩展刚加载、会话登记丢了）。
      // 直接报错会把用户的话弄丢 —— 实测就是这样：手机上发了一条需求，
      // 只收到一句「把消息交给 pi 失败」，话本身没了。所以先重试几轮。
      const retries = (job.retries ?? 0) + 1;
      const message = errorText(error);
      if (retries <= MAX_INJECT_RETRIES && !this.stopping) {
        this.current = undefined;
        this.queue.unshift({ ...job, retries });
        log.warn(`注入 pi 失败，${retries}/${MAX_INJECT_RETRIES} 次，5 秒后重试：${message}`);
        const timer = setTimeout(() => this.pump(), 5000);
        timer.unref?.();
        return;
      }
      this.current = undefined;
      log.error(`注入 pi 失败: ${message}`);
      void this.replyRaw(inbound.target, `把消息交给 pi 失败：${message}`).catch(() => undefined);
      return;
    }
  }

  /** 让模型知道消息来自哪个 IM 会话，多来源时不会串味；垫话放在最前面。 */
  private buildHeader(job: Job): string {
    const inbound = job.inbound;
    const who = inbound.isGroup ? `群 ${inbound.groupId} 里的 ${inbound.senderName}` : inbound.senderName;
    const lines: string[] = [];

    if (job.notes?.length) lines.push(...job.notes, "");

    lines.push(`[来自${inbound.channel === "qq" ? "QQ" : "微信"} · ${who} · ${formatClock(inbound.receivedAt)}]`);
    if (this.config.mirrorLocalInput === false && this.currentJobCount() > 1) {
      lines.push("[注意：当前还有其它 IM 会话在排队，请只回应本条消息]");
    }
    lines.push("");
    return `${lines.join("\n")}`;
  }

  private currentJobCount(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  /* ---------------------------- pi 事件回调 ---------------------------- */

  onAssistantText(text: string, stopReason?: string): void {
    const trimmed = text.trim();
    if (trimmed) this.lastAssistantText = trimmed;
    if (stopReason) this.lastStopReason = stopReason;
  }

  onToolStart(toolName: string, args: unknown): void {
    this.toolCount += 1;
    const job = this.current;
    if (!job) return;
    if (!this.progressEnabled(job.inbound.channel)) return;
    const now = Date.now();
    if (now - this.lastProgressAt < PROGRESS_THROTTLE_MS) return;
    this.lastProgressAt = now;
    const summary = summarizeTool(toolName, args);
    void this.replyRaw(job.inbound.target, `🔧 ${summary}`).catch((error) => {
      log.debug(`进度回传失败: ${errorText(error)}`);
    });
  }

  private progressEnabled(channel: ChannelId): boolean {
    return channel === "qq" ? this.config.channels.qq.progress === "live" : this.config.channels.wechat.progress === "live";
  }

  /** agent_settled：本轮彻底结束，把结果回给发起者，然后处理下一条。 */
  onSettled(): void {
    const job = this.current;
    if (job) {
      const text = this.buildFinalReply(job.inbound);
      this.current = undefined;
      void this.replyRaw(job.inbound.target, text).catch((error) => {
        log.warn(`回复 ${job.inbound.label} 失败: ${errorText(error)}`);
        this.deps.notify(`回复 ${job.inbound.label} 失败：${errorText(error)}`, "warning");
      });
    }
    // 让 pi 先完全回到空闲，再提交下一条
    const timer = setTimeout(() => this.pump(), 50);
    timer.unref?.();
  }

  private buildFinalReply(inbound: InboundMessage): string {
    const body = this.lastAssistantText?.trim();
    if (body) return body;
    if (this.lastStopReason === "aborted") return "（本轮已被中断，没有产生回复）";
    if (this.toolCount > 0) return `（agent 执行了 ${this.toolCount} 个工具调用，但没有产生文字回复）`;
    return "（agent 没有产生回复）";
  }

  /** 本地终端输入镜像到 IM（可选，默认关）。 */
  mirrorLocalInput(text: string): void {
    if (!this.config.mirrorLocalInput) return;
    const target = this.current?.target ?? this.lastTarget;
    if (!target) return;
    void this.replyRaw(target, `💻 本地终端输入：${text.slice(0, 500)}`).catch(() => undefined);
  }

  /* ---------------------------- 发送 ---------------------------- */

  private async replyRaw(target: ChatTarget, text: string): Promise<void> {
    const channel = this.channels.get(target.channel);
    if (!channel) throw new Error(`通道 ${target.channel} 未注册`);
    await channel.send(target, text);
  }

  /** 控制命令的统一回复出口。 */
  async completeControl(text: string): Promise<void> {
    const pending = this.pendingControl;
    this.pendingControl = undefined;
    if (!pending) return;
    await this.replyRaw(pending.target, text).catch((error) => {
      log.warn(`控制命令回复失败: ${errorText(error)}`);
    });
  }

  /* ---------------------------- IM 命令 ---------------------------- */

  private async handleInboundCommand(inbound: InboundMessage, name: string, args: string): Promise<void> {
    const target = inbound.target;
    try {
      switch (name) {
        case "help":
        case "h":
          await this.replyRaw(target, HELP_TEXT);
          return;
        case "ping":
          await this.replyRaw(target, "pong 🏓");
          return;
        case "whoami":
        case "id":
          await this.replyRaw(
            target,
            [
              `通道：${inbound.channel}`,
              `你的标识：${inbound.senderId}`,
              inbound.groupId ? `群标识：${inbound.groupId}` : undefined,
              `会话键：${inbound.conversationKey}`,
            ]
              .filter(Boolean)
              .join("\n"),
          );
          return;
        case "status":
        case "s":
          await this.replyRaw(target, this.buildStatusText());
          return;
        case "stop":
        case "abort":
          this.deps.abort();
          this.queue.length = 0;
          await this.replyRaw(target, "已中断当前任务，并清空排队消息。");
          return;
        case "queue":
          await this.replyRaw(
            target,
            this.queue.length === 0
              ? "队列为空。"
              : `排队中 ${this.queue.length} 条：\n${this.queue
                  .map((q, i) => `${i + 1}. ${q.inbound.label} · ${humanAge(q.queuedAt)}`)
                  .join("\n")}`,
          );
          return;
        case "model":
          await this.replyRaw(target, await this.handleModelCommand(args));
          return;
        case "login":
          await this.handleLoginCommand(target, args);
          return;
        case "qr":
          this.handleQrCommand(target);
          return;
        case "new":
        case "resume":
          await this.dispatchControl(target, `im-${name}${args ? ` ${args}` : ""}`);
          return;
        default:
          // 不是 relay 的命令，按普通消息送给 pi
          this.queue.push({ inbound: { ...inbound, text: inbound.text }, queuedAt: Date.now() });
          this.pump();
          return;
      }
    } catch (error) {
      log.warn(`处理命令 /${name} 失败: ${errorText(error)}`);
      await this.replyRaw(target, `命令执行失败：${errorText(error)}`).catch(() => undefined);
    }
  }

  /** 需要 ExtensionCommandContext 的操作（新建/切换会话）走这里。 */
  private async dispatchControl(target: ChatTarget, command: string): Promise<void> {
    if (this.pendingControl) {
      await this.replyRaw(target, "上一个会话操作还没结束，请稍后再试。");
      return;
    }
    this.controlSeq += 1;
    this.pendingControl = { target, label: command };
    try {
      this.deps.dispatchCommand(command);
    } catch (error) {
      this.pendingControl = undefined;
      throw error;
    }
    // 命令没能在合理时间内回话时兜底，避免 pendingControl 永久占位
    const seq = this.controlSeq;
    const timer = setTimeout(() => {
      if (this.controlSeq !== seq || !this.pendingControl) return;
      this.pendingControl = undefined;
      log.warn(`控制命令 ${command} 超时未返回结果`);
    }, 60_000);
    timer.unref?.();
  }

  private async handleModelCommand(args: string): Promise<string> {
    const spec = args.trim();
    if (!spec) {
      const models = this.deps.listModels();
      const lines = [`当前模型：${this.deps.describeSession().split("\n").find((l) => l.startsWith("模型")) ?? "(未知)"}`];
      lines.push("");
      lines.push("用法：/model <编号|provider/modelId>");
      lines.push(...models.slice(0, 30).map((m, i) => `${i + 1}. ${m}`));
      if (models.length > 30) lines.push(`… 共 ${models.length} 个`);
      return lines.join("\n");
    }
    if (/^\d+$/.test(spec)) {
      const models = this.deps.listModels();
      const index = Number.parseInt(spec, 10);
      if (index < 1 || index > models.length) return `编号超出范围（1-${models.length}）`;
      return this.deps.switchModel(models[index - 1] as string);
    }
    return this.deps.switchModel(spec);
  }

  private async handleLoginCommand(target: ChatTarget, args: string): Promise<void> {
    const which = (args.trim() || target.channel) as ChannelId;
    const channel = this.channels.get(which);
    if (!channel) {
      await this.replyRaw(target, `未知通道：${which}（可选 qq / wechat）`);
      return;
    }
    if (!channel.login) {
      await this.replyRaw(target, `${channel.name} 不需要在这里登录。`);
      return;
    }
    await this.replyRaw(target, `开始 ${channel.name} 登录流程，请在本机 pi 终端查看二维码。`);
    void channel.login().catch((error) => {
      log.warn(`${channel.name} 登录失败: ${errorText(error)}`);
      void this.replyRaw(target, `${channel.name} 登录失败：${errorText(error)}`).catch(() => undefined);
    });
  }

  private handleQrCommand(target: ChatTarget): void {
    const pending = ["qq", "wechat"]
      .map((id) => this.statuses.get(id as ChannelId))
      .find((status) => status?.qrAscii);
    if (!pending) {
      // 请用户在本机终端执行 /im qr 查看
      void this.replyRaw(
        target,
        "当前没有待扫描的二维码。若需要登录，请先说「QQ登录」或「微信登录」。",
      ).catch(() => undefined);
      return;
    }
    void this.replyRaw(target, "二维码已在本机 pi 终端显示，请在本机执行 /im qr 查看完整图形。").catch(() => undefined);
  }

  /** 暴露端口，便于 /status 输出与其他诊断代码复用同一套描述逻辑。 */
  port(): PiPort {
    return this.deps;
  }

  queueLength(): number {
    return this.queue.length;
  }

  isBusy(): boolean {
    return this.current !== undefined;
  }

  buildStatusText(): string {
    const lines: string[] = ["📡 pi-im-relay 状态", ""];
    for (const status of this.statuses.values()) {
      const mark =
        status.state === "online" ? "🟢" : status.state === "needs-login" ? "🟡" : status.state === "connecting" ? "🔵" : "🔴";
      lines.push(`${mark} ${status.name}：${status.state}${status.detail ? ` — ${status.detail}` : ""}`);
      if (status.lastInboundAt) lines.push(`   最近收到消息：${humanAge(status.lastInboundAt)}`);
    }
    lines.push("");
    lines.push(this.deps.describeSession());
    lines.push("");
    lines.push(`队列：${this.queue.length} 条排队，${this.current ? "正在处理 1 条" : "空闲"}`);
    if (this.pendingControl) lines.push(`控制操作进行中：${this.pendingControl.label}`);
    lines.push("");
    lines.push(`配置：${this.config.enabled ? "已启用" : "已停用"}｜单条上限 ${this.config.maxReplyChars} 字｜限流 ${this.config.rateLimitPerMinute} 条/分钟`);
    return lines.join("\n");
  }

  /**
   * 忙时的「你在干什么」。
   *
   * 全部用 router 手里**已经有**的数据拼出来（当前 job、工具计数、队列），
   * 不调模型、不查外部状态 —— 所以可以在一瞬间回出去。
   *
   * 它存在的意义仅仅是【别让用户干等】：agent 一旦腾出手来，真正的进展
   * （比如派出去的活干到哪了）还是要 agent 去查才说得清楚。
   */
  buildProgressText(): string {
    const job = this.current;
    if (!job) {
      return `我现在空闲，队列 ${this.queue.length} 条。有活直接说。`;
    }
    const secs = Math.round((Date.now() - job.queuedAt) / 1000);
    const mins = Math.floor(secs / 60);
    const took = mins > 0 ? `${mins} 分 ${secs % 60} 秒` : `${secs} 秒`;
    const brief = job.inbound.text.replace(/\s+/g, " ").trim().slice(0, 60);

    const lines = [
      `⏳ 我正忙：${job.inbound.label}`,
      `任务：${brief}${job.inbound.text.length > 60 ? "…" : ""}`,
      `已跑：${took}，${this.toolCount} 个工具调用`,
    ];
    if (this.queue.length > 0) {
      const who = this.queue.map((q) => q.inbound.label).slice(0, 3).join("、");
      lines.push(`队列：还有 ${this.queue.length} 条在等（${who}${this.queue.length > 3 ? "…" : ""}）`);
    }
    lines.push("");
    lines.push("处理完就回你。要我停下就说 /stop。");
    return lines.join("\n");
  }
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/**
 * IM 侧「整句就是一句状态问话」的识别。
 *
 * 与 triggers.ts 的区别（容易搞混，特意写清楚）：
 *  - triggers.ts 管的是 **pi 本地对话框** 里的输入，命中了也只弹本地通知；
 *  - 这里管的是 **IM 消息**，命中后把回复直接发回聊天窗口。
 *
 * 两边都坚持「整句精确匹配」，理由是同一个：用包含匹配会把
 * 「机器人状态怎么同步到云端」「进度条怎么调」这类正常提问也劫持掉。
 */
export type ImQuickQuery = "status" | "progress";

/** 纯机械的状态询问：任何时刻都能就地答。 */
const QUICK_STATUS_WORDS = new Set([
  "状态",
  "im状态",
  "im连接状态",
  "机器人状态",
  "连接状态",
  "是否在线",
  "在线吗",
  "在不在",
  "im在线吗",
  "机器人在线吗",
  "机器人在不在",
  "活着吗",
  "还活着吗",
  "掉线了吗",
]);

/** 问进展：只在 agent 忙时拦截（空闲时放行，让 agent 去查真实进展）。 */
const QUICK_PROGRESS_WORDS = new Set([
  "进度",
  "在干什么",
  "在干什么呢",
  "在忙什么",
  "在忙什么呀",
  "忙完了吗",
  "忙完了没",
  "干完了吗",
  "干完了没",
  "做完了吗",
  "工作到哪一步了",
  "进行到哪一步了",
]);

/** 归一化后的长度上限：超过这个长度就不可能是「一句纯指令」。 */
const MAX_QUICK_QUERY_LENGTH = 16;

export function matchImQuickQuery(text: string): ImQuickQuery | undefined {
  if (typeof text !== "string") return undefined;
  const normalized = normalizeTrigger(text);
  if (!normalized || normalized.length > MAX_QUICK_QUERY_LENGTH) return undefined;
  if (QUICK_STATUS_WORDS.has(normalized)) return "status";
  if (QUICK_PROGRESS_WORDS.has(normalized)) return "progress";
  return undefined;
}

export function parseCommand(text: string): { name: string; args: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const match = /^\/([A-Za-z][\w-]*)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return undefined;
  return { name: (match[1] as string).toLowerCase(), args: match[2] ?? "" };
}

function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function summarizeTool(toolName: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const detail =
    (typeof record.command === "string" && record.command) ||
    (typeof record.file_path === "string" && record.file_path) ||
    (typeof record.path === "string" && record.path) ||
    (typeof record.pattern === "string" && record.pattern) ||
    "";
  const short = String(detail).replace(/\s+/g, " ").slice(0, 80);
  return short ? `${toolName} · ${short}` : toolName;
}

const HELP_TEXT = `🤖 pi-im-relay 指令

★ 在输入框里直接发这几个词就能触发（不经过模型）：
  微信登录     出微信登录二维码
  QQ登录       出 QQ 登录二维码（扫完自动连上 NapCat）
  IM状态       查看通道状态

/help            显示这份帮助
/status          查看通道、会话、队列状态
/whoami          查看你的标识（用于加白名单）
/queue           查看排队中的消息
/stop            中断当前任务并清空队列
/new             开一个全新的 pi 会话
/resume          列出最近的会话
/resume <编号>   切换到指定会话
/model           列出可用模型
/model <编号>    切换模型
/login wechat    重新扫码登录微信
/qr              查看待扫描的二维码提示
/ping            连通性测试

其它任何内容都会作为 prompt 交给本机 pi agent 处理。`;

export { PROGRESS_THROTTLE_MS };
