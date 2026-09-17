/**
 * 登录二维码投递测试。
 *
 * 这是整套集成里最依赖界面能力的一环，用假的 UI 端口把三种场景钉死：
 *  - pi-web（"rpc" + 能渲染图片）→ 必须发一条带 image 的 custom message
 *  - 终端 TUI（"tui"）→ 必须用 ASCII 画在 widget 上
 *  - 二维码渲染失败 → 必须退化成链接，而不是静默失败
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deliverLoginQr, deliverLoginQrFallback, LOGIN_MESSAGE_TYPE, type LoginUiPort } from "../extensions/im-relay/login-ui.ts";
import { renderQr } from "../extensions/im-relay/qr.ts";
import { PNG } from "pngjs";

interface Harness {
  port: LoginUiPort;
  widgets: Array<string[] | undefined>;
  statuses: Array<string | undefined>;
  notices: Array<{ message: string; level: string }>;
  messages: Array<{ customType: string; content: unknown; display: boolean; details?: unknown }>;
  errors: string[];
}

function makeHarness(mode: string | undefined, supportsImages = true): Harness {
  const h: Harness = {
    widgets: [],
    statuses: [],
    notices: [],
    messages: [],
    errors: [],
    port: {
      mode: () => mode,
      hasUi: () => true,
      supportsImages: () => supportsImages,
      setWidget: (lines) => h.widgets.push(lines),
      setStatus: (text) => h.statuses.push(text),
      notify: (message, level) => h.notices.push({ message, level }),
      sendCustomMessage: (message) => h.messages.push(message),
      onError: (message) => h.errors.push(message),
    },
  };
  return h;
}

const LOGIN_URL = "https://liteapp.weixin.qq.com/q/7GiRk2?token=pimrelay-demo";

test("pi-web（rpc 模式）把二维码作为图片 custom message 发进对话", () => {
  const h = makeHarness("rpc");
  const qr = renderQr(LOGIN_URL, 8, 3);
  const via = deliverLoginQr(h.port, { channel: "wechat", qr });

  assert.equal(via, "image");
  assert.equal(h.messages.length, 1);
  const message = h.messages[0]!;
  assert.equal(message.customType, LOGIN_MESSAGE_TYPE);
  assert.equal(message.display, true, "display 必须为 true，否则 pi-web 会折叠成一行按钮");

  const content = message.content as Array<Record<string, unknown>>;
  const image = content.find((block) => block.type === "image");
  assert.ok(image, "content 里必须有一块 image");

  // pi-web 读的是扁平字段 data / mimeType（见其 custom message 渲染器）
  assert.equal(image.mimeType, "image/png");
  assert.equal(typeof image.data, "string");
  assert.ok((image.data as string).length > 100);

  // base64 必须真的是合法 PNG，否则界面里会出现破图
  const bytes = Buffer.from(image.data as string, "base64");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const png = PNG.sync.read(bytes);
  assert.equal(png.width, qr.image.size);

  const text = content.find((block) => block.type === "text") as { text?: string } | undefined;
  assert.ok(text?.text?.includes(LOGIN_URL), "文字里要带链接，作为扫码失败的兜底");
  assert.ok(text?.text?.includes("24 小时"), "微信场景要提示凭据有效期");

  assert.ok(h.statuses.some((s) => s?.includes("扫码")), "页脚状态要提示等待扫码");
});

test("终端 TUI 用半块字符 ASCII 画在 widget 上，不发图片消息", () => {
  const h = makeHarness("tui");
  const qr = renderQr(LOGIN_URL, 8, 3);
  const via = deliverLoginQr(h.port, { channel: "wechat", qr });

  assert.equal(via, "widget");
  assert.equal(h.messages.length, 0, "TUI 渲染不了图片，不该白发一条消息进上下文");
  assert.equal(h.widgets.length, 1);
  const lines = h.widgets[0]!;
  assert.ok(lines.length > 15, `二维码应当是多行，实际 ${lines.length} 行`);
  assert.equal(lines.join("\n"), qr.ascii, "widget 内容必须等于 ASCII 二维码");
  assert.ok(lines.join("").includes("\u2588"), "应当包含全块字符");
  assert.ok(h.notices.some((n) => n.message.includes("编辑器上方")));
});

test("没有 UI 上下文时不抛错，退化成文字链接", () => {
  const h = makeHarness(undefined);
  const qr = renderQr(LOGIN_URL, 8, 3);
  const via = deliverLoginQr(h.port, { channel: "wechat", qr });
  // mode 为 undefined 时按“支持图片”处理，发 custom message 是安全的
  assert.equal(via, "image");
  assert.equal(h.messages.length, 1);
});

test("文本模型时改用代码块里的 ASCII 二维码（不发注定被丢掉的图）", () => {
  const h = makeHarness("rpc", false);
  const qr = renderQr(LOGIN_URL, 8, 3);
  const via = deliverLoginQr(h.port, { channel: "wechat", qr });

  assert.equal(via, "text-ascii");
  assert.equal(h.messages.length, 1);
  const content = h.messages[0]!.content as string;
  assert.equal(typeof content, "string");
  assert.ok(content.includes("```"), "ASCII 二维码必须放进代码块，借用等宽字体渲染");
  assert.ok(content.includes(qr.ascii), "代码块里必须是完整的 ASCII 二维码");
  assert.ok(content.includes(LOGIN_URL), "仍要带链接兜底");
  assert.ok(h.statuses.some((s) => s?.includes("扫码")));
});

test("custom message 发送失败时退化成链接而不是静默丢失", () => {
  const h = makeHarness("rpc");
  let calls = 0;
  h.port.sendCustomMessage = (message) => {
    calls += 1;
    if (calls === 1) throw new Error("sendMessage 不可用");
    h.messages.push(message);
  };
  const qr = renderQr(LOGIN_URL, 8, 3);
  const via = deliverLoginQr(h.port, { channel: "wechat", qr });

  assert.equal(via, "none");
  assert.equal(h.errors.length, 1);
  assert.equal(h.messages.length, 1);
  assert.ok(String(h.messages[0]!.content).includes(LOGIN_URL), "兜底消息里必须带链接");
});

test("文本模型且发送失败时也要退化成链接", () => {
  const h = makeHarness("rpc", false);
  let calls = 0;
  h.port.sendCustomMessage = (message) => {
    calls += 1;
    if (calls === 1) throw new Error("不可用");
    h.messages.push(message);
  };
  const via = deliverLoginQr(h.port, { channel: "wechat", qr: renderQr(LOGIN_URL, 8, 3) });
  assert.equal(via, "none");
  assert.ok(String(h.messages[0]!.content).includes(LOGIN_URL));
});

test("二维码渲染失败时给出链接与告警", () => {
  const h = makeHarness("rpc");
  deliverLoginQrFallback(h.port, LOGIN_URL, "微信登录");
  assert.ok(h.notices.some((n) => n.level === "warning" && n.message.includes(LOGIN_URL)));
  assert.equal(h.messages.length, 1);
  assert.ok(String(h.messages[0]!.content).includes(LOGIN_URL));
});

test("widget 内容可以被清空（扫码成功后收起二维码）", () => {
  const h = makeHarness("tui");
  h.port.setWidget(["line"]);
  h.port.setWidget(undefined);
  assert.deepEqual(h.widgets, [["line"], undefined]);
});
