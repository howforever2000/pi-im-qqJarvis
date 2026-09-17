/**
 * 对话框里的「自然语言入口」。
 *
 * 为什么不用「让 LLM 决定调工具」：
 *  - 走 LLM 要花 token、有延迟，还可能被拒（模型不一定每次配合）；
 *  - 而「登录微信」这种意图是**确定性**的，本机直接识别即可，零成本零延迟。
 * 所以这里用精确短语匹配，命中后由扩展直接执行（pi 的 input 事件返回 handled）。
 *
 * 关键设计：**必须整句等于某个短语**才触发，不做「包含」匹配。
 * 否则「微信支付怎么对接」「QQ音乐 API」这类正常提问会被劫持，那就成了 bug。
 */

export type LocalTrigger =
  | { kind: "login"; channel: "wechat" | "qq" }
  | { kind: "status" };

/** 整句命中才触发的短语（忽略大小写、空白与中英文标点）。 */
const LOGIN_PHRASES: Array<{ channel: "wechat" | "qq"; phrases: string[] }> = [
  {
    channel: "wechat",
    phrases: [
      "微信登录",
      "微信登陆",
      "登录微信",
      "登陆微信",
      "绑定微信",
      "连接微信",
      "连上微信",
      "接入微信",
      "微信扫码",
      "微信登录绑定",
      "登录绑定微信",
      "loginwechat",
      "wechatlogin",
    ],
  },
  {
    channel: "qq",
    phrases: [
      "qq登录",
      "qq登陆",
      "登录qq",
      "登陆qq",
      "绑定qq",
      "连接qq",
      "连上qq",
      "接入qq",
      "qq扫码",
      "登录绑定qq",
      "loginqq",
      "qqlogin",
    ],
  },
];

const STATUS_PHRASES = [
  "im状态",
  "im连接状态",
  "机器人状态",
  "im连上了吗",
  "机器人连上了吗",
  "im在线吗",
  "机器人在线吗",
  "im状态怎么样",
];

/** 归一化：去首尾空白、去掉命令式前导斜杠、转小写、剔除空白与标点。 */
export function normalizeTrigger(text: string): string {
  return text
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    // 空白（含全角空格）
    .replace(/[\s\u3000]+/g, "")
    // 中英文标点：，。！？、；：·…—,.!?;:'"()（）[]【】《》<>~`|
    .replace(/[，。！？、；：·…—,.!?;:'"()（）[\]【】《》<>~`|]/g, "");
}

/** 归一化后的长度上限：超过就不可能是「一句纯指令」。 */
const MAX_TRIGGER_LENGTH = 16;

/**
 * 判断一句话是不是本机可处理的指令。
 * 只有「整句就是一个已知短语」才返回结果，否则返回 undefined（交给正常的 agent 流程）。
 */
export function matchLocalTrigger(text: string): LocalTrigger | undefined {
  if (typeof text !== "string") return undefined;
  const normalized = normalizeTrigger(text);
  if (!normalized || normalized.length > MAX_TRIGGER_LENGTH) return undefined;

  for (const group of LOGIN_PHRASES) {
    if (group.phrases.includes(normalized)) return { kind: "login", channel: group.channel };
  }
  if (STATUS_PHRASES.includes(normalized)) return { kind: "status" };

  return undefined;
}

/** 给用户看的提示文案，保持与匹配器同步（widget 提示与帮助都用它）。 */
export const TRIGGER_HINTS = {
  wechatLogin: "微信登录",
  qqLogin: "QQ登录",
  status: "IM状态",
} as const;

/** 「一句话触发」的完整说明，供 help 与 widget 复用。 */
export function describeTriggers(): string {
  return [
    `· 输入「${TRIGGER_HINTS.wechatLogin}」或「${TRIGGER_HINTS.qqLogin}」→ 直接出登录二维码（不经过模型）`,
    `· 输入「${TRIGGER_HINTS.status}」→ 查看通道状态`,
    "· 或者用 /im login wechat、说「帮我登录微信」",
  ].join("\n");
}
