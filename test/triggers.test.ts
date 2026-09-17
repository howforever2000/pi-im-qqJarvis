/**
 * 「对话框里直接输一句话就触发」的匹配器测试。
 *
 * 这里的关键风险是**误触发**：如果把匹配写成「包含」，那么
 * 「微信支付怎么对接」「QQ音乐的 API 是什么」这类正常提问都会被劫持，
 * agent 永远收不到 —— 那就成了 bug。所以必须整句相等才触发。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { matchLocalTrigger, normalizeTrigger, describeTriggers } from "../extensions/im-relay/triggers.ts";

test("微信登录的各种说法都能触发", () => {
  for (const phrase of ["微信登录", "微信登陆", "登录微信", "登录微信。", " 绑定微信 ", "连接微信", "微信扫码"]) {
    assert.deepEqual(matchLocalTrigger(phrase), { kind: "login", channel: "wechat" }, `未识别：${phrase}`);
  }
});

test("QQ 登录的各种说法都能触发（含大小写）", () => {
  for (const phrase of ["QQ登录", "qq登录", "QQ登陆", "登录QQ", "登录qq", "绑定 Q Q", "连接QQ"]) {
    assert.deepEqual(matchLocalTrigger(phrase), { kind: "login", channel: "qq" }, `未识别：${phrase}`);
  }
});

test("带前导斜杠也能触发（用户习惯性敲 /）", () => {
  assert.deepEqual(matchLocalTrigger("/微信登录"), { kind: "login", channel: "wechat" });
  assert.deepEqual(matchLocalTrigger("/QQ登录"), { kind: "login", channel: "qq" });
});

test("状态查询短语能触发", () => {
  for (const phrase of ["IM状态", "im状态", "机器人状态", "IM连上了吗", "机器人在线吗"]) {
    assert.deepEqual(matchLocalTrigger(phrase), { kind: "status" }, `未识别：${phrase}`);
  }
});

test("含「微信/QQ」的正常提问不会被劫持（这是最重要的用例）", () => {
  const shouldNotTrigger = [
    "微信支付怎么对接",
    "帮我看下 QQ音乐 的 API 文档",
    "我们项目里微信登录模块有 bug，修一下",
    "把微信登录的代码抽出来",
    "登录微信小程序的后台地址是什么",
    "写一个 QQ 机器人",
    "微信登录和 QQ 登录哪个体验更好？帮我分析",
    "在 src/wechat-login.ts 里加上错误处理",
    "QQ",
    "微信",
  ];
  for (const text of shouldNotTrigger) {
    assert.equal(matchLocalTrigger(text), undefined, `不应触发：${text}`);
  }
});

test("空文本与超长文本不触发", () => {
  assert.equal(matchLocalTrigger(""), undefined);
  assert.equal(matchLocalTrigger("   "), undefined);
  assert.equal(matchLocalTrigger("微信登录" + "很".repeat(30)), undefined);
});

test("非字符串输入不抛错", () => {
  // @ts-expect-error 故意传错类型，验证健壮性
  assert.equal(matchLocalTrigger(undefined), undefined);
  // @ts-expect-error 同上
  assert.equal(matchLocalTrigger(null), undefined);
});

test("normalizeTrigger 去掉标点与空白", () => {
  assert.equal(normalizeTrigger(" /微信 登录 。 "), "微信登录");
  assert.equal(normalizeTrigger("QQ，登录！"), "qq登录");
  assert.equal(normalizeTrigger("微信\t登录"), "微信登录");
});

test("提示文案与匹配器保持一致", () => {
  const hints = describeTriggers();
  // 文案里提到的短语必须真的能触发，否则用户按提示做了却没反应
  assert.ok(matchLocalTrigger("微信登录"), "文案提到「微信登录」就必须真能触发");
  assert.ok(matchLocalTrigger("QQ登录"));
  assert.ok(matchLocalTrigger("IM状态"));
  assert.ok(hints.includes("微信登录"));
  assert.ok(hints.includes("QQ登录"));
});
