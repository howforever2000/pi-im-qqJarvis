/**
 * QQ 扫码登录端到端测试（对着一个假的 NapCat WebUI + 假的 OneBot11 服务器跑）。
 *
 * 锁死的核心行为与微信通道一致：
 *   1. 说一句「QQ登录」就该把二维码送进对话，而不是让用户自己去 NapCat 界面扫；
 *   2. 重复触发只**复用**同一张码（用户在 `beginLogin` 阶段真实踩到过两端各出一张码）；
 *   3. NapCat 自己换码（二维码过期）时要跟着投新码，而不是让用户扫到废码；
 *   4. token / WebUI 不可达这类问题要给出能照做的结论，不能只甩一句报错。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

// 必须在 import config.ts 之前指向临时目录，否则会写到真实的状态文件
const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-qq-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

const { QqChannel } = await import("../extensions/im-relay/channels/qq.ts");
const { resolveWebuiOptions, webuiPasswordHash } = await import(
  "../extensions/im-relay/channels/napcat-webui.ts"
);
const { DEFAULT_CONFIG } = await import("../extensions/im-relay/config.ts");

/* ------------------------------------------------------------------ */
/* 假 NapCat WebUI                                                     */
/* ------------------------------------------------------------------ */

interface FakeWebui {
  port: number;
  /** WebUI 真正期望的密码 */
  token: string;
  /** GetQQLoginQrcode + RefreshQRcode 的调用次数 */
  qrcodeRequests: number;
  /** /api/auth/login 的调用次数（应当被凭证缓存压到 1） */
  loginRequests: number;
  /** 当前二维码链接 */
  qrcodeurl(): string;
  /** 模拟 NapCat 自己刷新了二维码（过期换码） */
  rotateQrcode(): string;
  setLoginPhase(phase: string): void;
  /** 模拟用户扫码确认 */
  completeLogin(): void;
  close(): Promise<void>;
}

async function startFakeWebui(token = "test-token"): Promise<FakeWebui> {
  let credentialSeq = 0;
  let qrSeq = 0;
  let url = "https://txz.qq.com/p?k=first-code";
  const state = {
    isLogin: false,
    isOffline: false,
    loginPhase: "waiting_qrcode",
    qrLoginAccepted: false,
    coreReady: false,
    qrcodeurl: url,
    loginError: "",
  };

  const fake: FakeWebui = {
    port: 0,
    token,
    qrcodeRequests: 0,
    loginRequests: 0,
    qrcodeurl: () => url,
    rotateQrcode: () => {
      qrSeq += 1;
      url = `https://txz.qq.com/p?k=rotated-${qrSeq}`;
      state.qrcodeurl = url;
      state.loginPhase = "waiting_qrcode";
      return url;
    },
    setLoginPhase: (phase) => {
      state.loginPhase = phase;
      if (phase === "qrcode_scanned") state.qrLoginAccepted = true;
    },
    completeLogin: () => {
      state.isLogin = true;
      state.coreReady = true;
      state.loginPhase = "ready";
      state.qrcodeurl = "";
    },
    close: async () => {},
  };

  const credentials = new Set<string>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const json = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const endpoint = req.url ?? "/";
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};

      if (endpoint === "/api/auth/login") {
        fake.loginRequests += 1;
        if (parsed.hash !== webuiPasswordHash(token)) {
          json({ code: -1, message: "token is invalid" });
          return;
        }
        credentialSeq += 1;
        const credential = `cred-${credentialSeq}`;
        credentials.add(credential);
        json({ code: 0, data: { Credential: credential }, message: "success" });
        return;
      }

      const auth = String(req.headers.authorization ?? "");
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!credentials.has(bearer)) {
        json({ code: -1, message: "Unauthorized" });
        return;
      }

      switch (endpoint) {
        case "/api/QQLogin/CheckLoginStatus":
          json({ code: 0, data: { ...state, qrcodeurl: state.coreReady ? "" : url }, message: "success" });
          return;
        case "/api/QQLogin/GetQQLoginQrcode":
          if (state.coreReady) {
            json({ code: -1, message: "QQ Is Logined" });
            return;
          }
          fake.qrcodeRequests += 1;
          json({ code: 0, data: { qrcode: url }, message: "success" });
          return;
        case "/api/QQLogin/RefreshQRcode":
          fake.qrcodeRequests += 1;
          json({ code: 0, data: { qrcodeurl: fake.rotateQrcode() }, message: "success" });
          return;
        default:
          json({ code: -1, message: `unknown endpoint ${endpoint}` });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  fake.port = typeof address === "object" && address ? address.port : 0;
  fake.close = () =>
    new Promise<void>((resolve) => {
      // 同 wechat-login.test.ts：不掐掉 keep-alive 连接，测试进程不会退出
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return fake;
}

/* ------------------------------------------------------------------ */
/* 假 OneBot11                                                         */
/* ------------------------------------------------------------------ */

async function startFakeOneBot(): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets = new Set<WsSocket>();
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", (raw) => {
      const payload = JSON.parse(String(raw)) as { action?: string; echo?: string };
      socket.send(
        JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 1279717885 }, echo: payload.echo }),
      );
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/* ------------------------------------------------------------------ */

function makeChannel(webui: FakeWebui, onebotPort = 59997, tokenOverride?: string) {
  const config = structuredClone(DEFAULT_CONFIG.channels.qq);
  config.host = "127.0.0.1";
  config.port = onebotPort;
  config.webui.enabled = true;
  config.webui.host = "127.0.0.1";
  config.webui.port = webui.port;
  config.webui.token = tokenOverride ?? webui.token;
  // 空字符串 → 不去读本机真实 NapCat 的 webui.json
  config.webui.configFile = "";

  const delivered: Array<{ text: string; size: number }> = [];
  const statuses: string[] = [];
  const channel = new QqChannel(
    config,
    {
      onMessage: () => {},
      onStatusChange: (s) => {
        statuses.push(s.state);
      },
      onLoginQr: ({ qr }) => {
        delivered.push({ text: qr.text, size: qr.image.size });
      },
    },
    1500,
  );
  return { channel, delivered, statuses, config };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待条件超时");
}

test("beginLogin 会把 NapCat 的二维码投进对话", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const { channel, delivered } = makeChannel(webui);
  t.after(() => channel.stop());

  await channel.beginLogin();

  assert.equal(delivered.length, 1, "返回时二维码必须已经投递出去");
  assert.equal(delivered[0]!.text, webui.qrcodeurl());
  assert.ok(delivered[0]!.size > 100, "投递的应当是渲染好的二维码图片");
  assert.equal(channel.status().state, "needs-login");
  assert.equal(channel.status().qrText, webui.qrcodeurl(), "状态里也要带着二维码，供 /im qr 重发");
});

test("重复触发只复用同一张码，且凭证被缓存（不撞 WebUI 登录限流）", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const { channel, delivered } = makeChannel(webui);
  t.after(() => channel.stop());

  // 第一次：用户敲了 /im login qq
  await channel.beginLogin();
  // 第二次：用户又说了一句「QQ登录」
  assert.equal(channel.loginActive(), true, "第一张码还在等扫码，应当是可复用的");
  await channel.beginLogin();
  // 第三次：/im qr
  await channel.beginLogin();
  // 让后台轮询至少跑一轮（它会再问一次 status）
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(webui.qrcodeRequests, 0, "已有可用二维码时不该再向 NapCat 取/换码");
  assert.equal(delivered.length, 3, "每次触发都应该把码重发给用户看");
  assert.equal(new Set(delivered.map((d) => d.text)).size, 1, "三次投递的必须是同一张码");
  assert.equal(webui.loginRequests, 1, "/api/auth/login 应当只调用一次（凭证 1 小时内复用）");
});

test("扫码确认后通道自动上线并连上 OneBot11", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const onebot = await startFakeOneBot();
  t.after(() => onebot.close());
  const { channel, statuses } = makeChannel(webui, onebot.port);
  t.after(() => channel.stop());

  await channel.beginLogin();
  webui.setLoginPhase("qrcode_scanned");
  await waitFor(() => channel.status().detail?.includes("确认") ?? false);

  webui.completeLogin();
  await waitFor(() => channel.status().state === "online");

  assert.equal(channel.status().state, "online");
  assert.ok(statuses.includes("needs-login"));
  assert.ok(statuses.includes("online"));
});

test("NapCat 自己换码时会跟着投出新码（二维码过期场景）", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const { channel, delivered } = makeChannel(webui);
  t.after(() => channel.stop());

  await channel.beginLogin();
  const rotated = webui.rotateQrcode();

  await waitFor(() => delivered.length >= 2);
  assert.equal(delivered[1]!.text, rotated, "换码后必须把新码投给用户");
  assert.notEqual(delivered[0]!.text, delivered[1]!.text);
  assert.equal(channel.status().qrText, rotated);
});

test("token 不对时报出可操作的错误，而不是静默失败", async (t) => {
  const webui = await startFakeWebui("real-token");
  t.after(() => webui.close());
  const { channel } = makeChannel(webui, 59997, "wrong-token");
  t.after(() => channel.stop());

  await assert.rejects(
    () => channel.beginLogin(),
    /NapCat WebUI 登录失败.*token/s,
    "应当明确指出是 token 的问题",
  );
  assert.equal(channel.status().state, "error");
});

test("NapCat WebUI 不可达时报错，并提示 NapCat 可能没启动", async (t) => {
  const webui = await startFakeWebui();
  const deadPort = webui.port;
  await webui.close();

  const { channel } = makeChannel(webui, deadPort);
  t.after(() => channel.stop());

  await assert.rejects(() => channel.beginLogin(), /无法连接 NapCat WebUI|请确认 NapCat 已启动/);
});

test("WebUI 可达但 QQ 未登录时，OneBot11 连不上会给出「去扫码」而不是 WebSocket 报错", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const { channel } = makeChannel(webui, 59996);
  t.after(() => channel.stop());

  await channel.start();
  await waitFor(() => channel.status().state === "needs-login", 15_000);

  assert.equal(channel.status().state, "needs-login");
  assert.ok(channel.status().detail?.includes("/im login qq"), channel.status().detail);
});

test("resolveWebuiOptions 会从 NapCat 的 webui.json 里读出 host/port/token", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-webui-"));
  const file = path.join(dir, "webui.json");
  fs.writeFileSync(file, JSON.stringify({ host: "127.0.0.1", port: 7001, token: "from-file" }));

  const options = resolveWebuiOptions({ enabled: true, host: "", port: 0, token: "", configFile: file });
  assert.equal(options.port, 7001);
  assert.equal(options.token, "from-file");
  assert.equal(options.source, file);

  // 显式配置优先于文件
  const explicit = resolveWebuiOptions({
    enabled: true,
    host: "10.0.0.1",
    port: 1234,
    token: "explicit",
    configFile: file,
  });
  assert.equal(explicit.host, "10.0.0.1");
  assert.equal(explicit.port, 1234);
  assert.equal(explicit.token, "explicit");
});

test("webuiPasswordHash 与 NapCat 的算法一致（sha256(token + \".napcat\")）", () => {
  const expected = createHash("sha256").update("napcatpi2026.napcat").digest("hex");
  assert.equal(webuiPasswordHash("napcatpi2026"), expected);
});
