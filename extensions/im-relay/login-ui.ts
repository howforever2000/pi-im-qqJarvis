/**
 * 登录二维码的界面投递。
 *
 * 抽成独立模块的原因：投递策略依赖界面的渲染能力，是这套集成里最容易出错的一环，
 * 必须能脱离 pi 运行时单测。不同界面的能力差异（从 pi-web 与 pi-coding-agent 的实现里确认）：
 *
 *  | 界面            | ctx.mode | 能渲染图片 | setWidget | 说明                                            |
 *  | --------------- | -------- | ---------- | --------- | ----------------------------------------------- |
 *  | 终端 TUI        | "tui"    | 否         | 是        | 只能用半块字符 ASCII 画在编辑器上方             |
 *  | pi-web (Electron)| "rpc"   | 是         | 是        | custom message 的 image 会渲染成可点开放大的图   |
 *  | 纯 RPC 客户端    | "rpc"    | 视客户端   | 视客户端  | 仍发图片消息，客户端不行也只能看到文字描述       |
 *
 * 图片走 `pi.sendMessage()` 的 custom message（不是 sendUserMessage），
 * 因此不会伪造一条“用户说的话”，也不会触发新的 turn。
 */
import type { QrPayload } from "./channels/types.ts";

export interface LoginUiPort {
  /** 当前运行模式：tui / rpc / json / print */
  mode(): string | undefined;
  hasUi(): boolean;
  /**
   * 当前模型能不能看图。
   *   - 不能时不要发图片：SDK 虽会自动丢图换成占位文字，但那样用户就看不到二维码了，
   *     改用代码块里的 ASCII 二维码反而仍然可扫。
   */
  supportsImages(): boolean;
  /** 在编辑器上方显示多行文本（TUI 与 pi-web 都支持） */
  setWidget(lines: string[] | undefined): void;
  setStatus(text: string | undefined): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
  /** 注入一条 custom message（participates in context，但不触发 turn） */
  sendCustomMessage(message: {
    customType: string;
    content: string | Array<Record<string, unknown>>;
    display: boolean;
    details?: unknown;
  }): void;
  onError(message: string, error: unknown): void;
}

export const LOGIN_MESSAGE_TYPE = "im-relay-login";

export function channelDisplayName(channel: string): string {
  if (channel === "wechat") return "微信";
  if (channel === "qq") return "QQ";
  return channel;
}

/**
 * 投递二维码。返回实际使用的投递方式，便于测试与日志。
 */
export function deliverLoginQr(
  port: LoginUiPort,
  payload: { channel: string; qr: QrPayload },
): "widget" | "image" | "text-ascii" | "none" {
  const name = channelDisplayName(payload.channel);
  const mode = port.mode();

  // 终端放不下图片：用半块字符直接画出来（终端字符高约为宽的两倍，半块字符正好抵掉）
  if (mode === "tui") {
    try {
      port.setWidget(payload.qr.ascii.split("\n"));
    } catch (error) {
      port.onError("展示二维码失败", error);
    }
    port.notify(`${name}登录二维码已显示在编辑器上方（/im qr-hide 收起）`, "info");
    return "widget";
  }

  const link = `扫码失败时可直接使用这个链接：${payload.qr.text}`;
  const expiry =
    payload.channel === "wechat" ? "凭据约 24 小时后过期，届时需要重新登录。" : "确认后即可收发消息。";

  // 模型看不了图 → 不要浪费一次图片投递，改用等宽代码块里的 ASCII 二维码
  if (!port.supportsImages()) {
    const rendered = [
      "这是发给**你**扫的，模型不需要解读它。",
      "用手机扫下面的二维码并在手机上确认。",
      expiry,
      "",
      "```",
      payload.qr.ascii,
      "```",
      "",
      link,
    ].join("\n");
    try {
      port.sendCustomMessage({
        customType: LOGIN_MESSAGE_TYPE,
        content: rendered,
        display: true,
        details: { channel: payload.channel, pixels: payload.qr.image.size, ascii: true },
      });
      port.setStatus(loginQrStatusText(payload.channel));
      return "text-ascii";
    } catch (error) {
      port.onError("发送二维码文本失败", error);
    }
    return deliverLoginQrFallback(port, payload.qr.text, `${name}登录`);
  }

  // 支持图片的界面：把 PNG 作为 custom message 发进对话，可以直接用手机扫
  const caption = [
    "这是发给**你**扫的，模型不需要解读它。",
    "用手机扫上面的二维码并在手机上确认。",
    payload.channel === "wechat"
      ? "凭据约 24 小时后过期，届时需要重新登录。"
      : "确认后即可收发消息。",
    "",
    `扫码失败时可直接使用这个链接：${payload.qr.text}`,
  ].join("\n");

  try {
    port.sendCustomMessage({
      customType: LOGIN_MESSAGE_TYPE,
      content: [
        { type: "image", data: payload.qr.image.base64, mimeType: payload.qr.image.mimeType },
        { type: "text", text: caption },
      ],
      display: true,
      details: {
        channel: payload.channel,
        pixels: payload.qr.image.size,
        generatedAt: new Date().toISOString(),
      },
    });
    port.setStatus(loginQrStatusText(payload.channel));
    return "image";
  } catch (error) {
    port.onError("发送二维码图片失败", error);
  }

  // 连 custom message 都发不出去：退回文字 + 链接
  return deliverLoginQrFallback(port, payload.qr.text, `${name}登录`);
}

/** 二维码渲染不出来，或图片消息发不出去时的兜底。 */
export function deliverLoginQrFallback(port: LoginUiPort, url: string, name = "登录"): "none" {
  port.notify(`${name}二维码不可用，请手动打开链接完成绑定：${url}`, "warning");  try {
    port.sendCustomMessage({
      customType: LOGIN_MESSAGE_TYPE,
      content: `登录二维码生成失败。请手动打开下面的链接完成绑定：\n${url}`,
      display: true,
    });
  } catch (error) {
    port.onError("发送登录链接失败", error);
  }
  return "none";
}

/** 二维码就绪时给用户的一句状态提示（不含二维码本身）。 */
export function loginQrStatusText(channel: string): string {
  return `IM 🔑 等待${channelDisplayName(channel)}扫码`;
}
