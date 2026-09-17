/**
 * QQ 账号经营 · 每日空间总结。
 *
 * 用户的要求：**每天晚上 10 点如果还在线，就根据当天的会话内容，整理发一条
 * 有趣的 QQ 空间总结，配上图文。**
 *
 * 为什么做成「定时注入任务给 agent」而不是「扩展自己拼一段模板」：
 *   「有趣」这件事拼模板拼不出来 —— 需要真的读过对话、理解发生了什么、再挑出值得说的。
 *   所以这里只负责**到点叫人干活**，写作交给 agent 本身。
 *
 * 为什么注入时走的是「排一个 job」而不是直接 sendUserMessage：
 *   消息进队列才能带上「垫话」（工作约定 + 记忆），而且跑完之后结果能回到号主手里。
 *   直接注入的话，agent 的产出会因为「没有触发者」而没地方回，用户看不到任何反馈。
 *
 * 几个刻意的设计：
 *   - 到点但通道不在线 / 今天没人说话 → 跳过，不硬发（避免刷出一堆“今日无事”）
 *   - 时间用本地时区，且**每天都重新计算**下一次的触发时刻（应对夏令时/改配置）
 *   - 定时器 unref，不阻止进程退出
 *   - 只注册一个定时器，重复调用 start 会先停掉旧的（热加载时不会叠加）
 */
import { createLogger, errorText } from "./log.ts";
import type { QzoneDigestConfig } from "./config.ts";
import type { ChannelId } from "./channels/types.ts";

const log = createLogger("qzone-digest");

export interface DigestDeps {
  config: () => QzoneDigestConfig;
  /** QQ 通道是否在线 */
  isOnline: (channel: ChannelId) => boolean;
  /** 取今天的聊天记录素材（已格式化好的纯文本），读不到返回空串 */
  material: () => Promise<string>;
  /** 把任务排进队列；返回是否成功入队 */
  enqueue: (text: string) => boolean;
}

/** 解析 `HH:MM`；非法值回退到 22:00，并在日志里说一声。 */
export function parseAt(at: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((at ?? "").trim());
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) return { hour, minute };
  }
  log.warn(`qzone.digest.at 配置非法（${JSON.stringify(at)}），回退到 22:00`);
  return { hour: 22, minute: 0 };
}

/** 从 `from` 起算，下一次触发时刻。 */
export function nextRunAt(at: string, from = new Date()): Date {
  const { hour, minute } = parseAt(at);
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** 交给 agent 的任务描述。素材由 agent 自己按需拉，不在这里塞一大堆。 */
export function buildDigestPrompt(at: string, ugcRight: number, targetUins: string[]): string {
  const vis =
    ugcRight === 16 && targetUins.length
      ? `部分好友可见（只给 ${targetUins.join("、")}）`
      : ugcRight === 64
        ? "仅自己可见"
        : ugcRight === 4
          ? "好友可见"
          : "所有人可见";
  return [
    `[定时任务 · 每日空间总结]`,
    `现在是 ${at}，该给今天写一条 QQ 空间总结了。`,
    ``,
    `做法：`,
    `1. 先用 im_relay_recent_chat 读一遍今天的聊天记录（这是唯一的素材来源，不要凭空编）`,
    `2. 从中挑出真正值得说的几件事 —— 做了什么的、踩了什么坑、有什么想说的`,
    `3. 用 im_relay_render_card 做 1~2 张排版卡片图（深色底 + 亮色重点，字要大，图上文字别太多）`,
    `4. 用 im_relay_qzone_post 发布，可见范围：${vis}`,
    ``,
    `要求：`,
    `- **写得有趣**，像一个有性格的人在记日记，不要写成工作报告或流水账`,
    `- 可以自嘲、可以感慨，但不要编造没发生的事`,
    `- 正文别太长（150~400 字），卡片图承担“好看”，文字承担“有意思”`,
    `- 如果今天确实没什么可写的，就直接回一句“今天没什么值得发的”并结束，不要硬凑`,
    `- 做完用一两句话回报结果（发了什么、tid 是多少）`,
  ].join("\n");
}

let timer: NodeJS.Timeout | undefined;

export function stopQzoneDigest(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}

/**
 * 启动每日总结。重复调用是安全的（会先把旧的定时器停掉）。
 */
export function startQzoneDigest(deps: DigestDeps): void {
  stopQzoneDigest();

  const schedule = (): void => {
    const cfg = deps.config();
    if (!cfg.enabled) {
      log.info("每日空间总结未启用");
      return;
    }
    const at = nextRunAt(cfg.at);
    const waitMs = at.getTime() - Date.now();
    const t = setTimeout(() => void fire(deps, schedule), waitMs);
    t.unref?.();
    timer = t;
    log.info(
      `每日空间总结已排程：${at.toLocaleString("zh-CN", { hour12: false })}（${Math.round(waitMs / 60000)} 分钟后）`,
    );
  };

  schedule();
}

async function fire(deps: DigestDeps, schedule: () => void): Promise<void> {
  timer = undefined;
  try {
    await runDigestOnce(deps);
  } finally {
    // 不管这次成没成，都要排下一天 —— 否则一次失败就永久停了
    schedule();
  }
}

export type DigestOutcome =
  | "disabled"
  | "skipped-offline"
  | "skipped-idle"
  | "no-target"
  | "sent";

/**
 * 跑一次总结。定时器调它，`/im digest` 也调它（方便验证，不用等到晚上）。
 * 永不抛错；返回结果供调用方展示。
 */
export async function runDigestOnce(deps: DigestDeps): Promise<DigestOutcome> {
  const cfg = deps.config();
  if (!cfg.enabled) return "disabled";

  if (cfg.skipWhenOffline && !deps.isOnline("qq")) {
    log.info("每日空间总结：QQ 通道不在线，本次跳过");
    return "skipped-offline";
  }

  // 先看看今天有没有人说话 —— 用户要的是「总结当天的内容」，没内容就没得总结
  let material = "";
  try {
    material = await deps.material();
  } catch (error) {
    log.warn(`读今日素材失败：${errorText(error)}`);
  }
  if (cfg.skipWhenIdle && !material.trim()) {
    log.info("每日空间总结：今天没有任何对话，本次跳过");
    return "skipped-idle";
  }

  const prompt = buildDigestPrompt(cfg.at, cfg.ugcRight, cfg.targetUins);
  const ok = deps.enqueue(prompt);
  log.info(ok ? "每日空间总结：任务已交给 agent" : "每日空间总结：没有可用会话目标，任务未投递");
  return ok ? "sent" : "no-target";
}
