/**
 * QQ 扫码登录端到端测试（对着一个假的 NapCat WebUI + 假的 OneBot11 服务器跑）。
 *
 * 锁死的核心行为与微信通道一致：
 *   1. 说一句「QQ登录」就该把二维码送进对话，而不是让用户自己去 NapCat 界面扫；
 *   2. 重复触发只**复用**同一张码（用户在 `beginLogin` 阶段真实踩到过两端各出一张码）；
 *   3. NapCat 自己换码（二维码过期）时要跟着投新码，而不是让用户扫到废码；
 *   4. NapCat 卡死在 `qrcode_scanned` 、拒不换码时（真机踩过的死锁），也得自己按
 *      二维码年龄兜底换码 —— 否则用户反复说「QQ登录」拿到的永远是同一张废码；
 *   5. token / WebUI 不可达这类问题要给出能照做的结论，不能只甩一句报错。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
const { DEFAULT_AUTO_START, resolveAutoStart, resolveLaunchScript, ensureNapcatRunning } = await import(
  "../extensions/im-relay/channels/napcat-process.ts"
);
type AutoStartConfig = typeof DEFAULT_AUTO_START;

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
  /** RefreshQRcode 的调用次数 */
  refreshRequests: number;
  /** 当前二维码链接 */
  qrcodeurl(): string;
  /** 模拟 NapCat 自己刷新了二维码（过期换码） */
  rotateQrcode(): string;
  /**
   * 让 RefreshQRcode 返回当前这张、不挪新码。
   * 模拟真机上 NapCat 卡在 `qrcode_scanned` 时「声称刷新成功、其实换了个寂寞」。
   */
  freezeRefresh: boolean;
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
    refreshRequests: 0,
    freezeRefresh: false,
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
          fake.refreshRequests += 1;
          json({
            code: 0,
            data: { qrcodeurl: fake.freezeRefresh ? url : fake.rotateQrcode() },
            message: "success",
          });
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

function makeChannel(
  webui: FakeWebui,
  onebotPort = 59997,
  tokenOverride?: string,
  autoStart: Partial<AutoStartConfig> = {},
) {
  const config = structuredClone(DEFAULT_CONFIG.channels.qq);
  // 关掉「登录即换号」——它真的会 taskkill QQ.exe 并删登录票据。
  // 单测绝不能真的去杀进程（会直接干掉开发者本地正在跑的 NapCat）。
  // 换号逻辑自己的用例在 test/features.test.ts 里单独测，且不碰真进程。
  config.switchAccount.enabled = false;
  // 同理：开发机上的 D:/NapCat/NapCat.Shell 是真存在的，默认开着自动启动
  // 会让「WebUI 不可达」那个用例真的把开发者的 NapCat 拉起来。要用的人显式传参。
  config.autoStart = { ...DEFAULT_AUTO_START, enabled: false, ...autoStart };
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

/* ------------------------------------------------------------------ */
/* 二维码过期兜底（NapCat 卡在 qrcode_scanned 的死锁）                  */
/* ------------------------------------------------------------------ */

/** 把二维码的「发出时间」往前拨，等价于干等它过期（不想真的 sleep 两分钟）。 */
function ageQr(channel: QqChannel, ms: number): void {
  (channel as unknown as { qrIssuedAt: number }).qrIssuedAt = Date.now() - ms;
}

/**
 * 让当前的登录轮询退场，只留下那张已经展示过的码。
 * 用来单独验证 beginLogin 的复用判断 —— 否则兜底逻辑会先替我们换掉码，测不到目标分支。
 */
async function retireLoginLoop(channel: QqChannel): Promise<void> {
  (channel as unknown as { loginLoop: Promise<void> | undefined }).loginLoop = undefined;
  (channel as unknown as { loginController: AbortController | undefined }).loginController?.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// 对应 qq.ts 里的 QR_REUSE_WINDOW_MS(60s) / QR_HARD_EXPIRY_MS(115s)，各留一点余量
const PAST_REUSE_WINDOW_MS = 61_000;
const PAST_HARD_EXPIRY_MS = 116_000;

test("NapCat 卡在 qrcode_scanned 不换码时，按二维码年龄兜底换新码", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const { channel, delivered } = makeChannel(webui);
  t.after(() => channel.stop());

  await channel.beginLogin();
  const stale = delivered[0]!.text;

  // 真机现场：NapCat 认为「码已被扫、在等手机确认」，于是既不换码也不会被 url 变化的分支刷新。
  // 而那张码在腾讯侧其实已经死了，用户在手机上只会反复看到「二维码已过期」。
  webui.setLoginPhase("qrcode_scanned");
  assert.equal(webui.qrcodeurl(), stale, "前提：NapCat 仍在把那张废码吐回来");
  // 已扫码待确认有宽限期，所以这里要越过硬过期线而不是复用窗口
  ageQr(channel, PAST_HARD_EXPIRY_MS);

  await waitFor(() => delivered.length >= 2);
  assert.notEqual(delivered[1]!.text, stale, "不能把已经作废的那张码再投一次");
  assert.equal(delivered[1]!.text, webui.qrcodeurl(), "投出去的必须是刚从 NapCat 拿到的新码");
  assert.equal(webui.refreshRequests >= 1, true, "应当真的向 NapCat 申请了新码");
  assert.equal(channel.status().state, "needs-login");
  assert.equal(channel.status().qrText, delivered[1]!.text);
});

test("NapCat 声称刷新成功却仍返回同一张码时，如实提示而不是假装换了码", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const { channel, delivered } = makeChannel(webui);
  t.after(() => channel.stop());

  await channel.beginLogin();
  webui.freezeRefresh = true;
  webui.setLoginPhase("qrcode_scanned");
  ageQr(channel, PAST_HARD_EXPIRY_MS);

  await waitFor(() => (channel.status().detail ?? "").includes("正在重新申请"));
  assert.equal(delivered.length, 1, "拿不到新码就不该把同一张码重复投出去");
  assert.ok(webui.refreshRequests >= 1, "必须真的去问过 NapCat 要新码");
  assert.equal(channel.status().qrText, webui.qrcodeurl(), "状态里保留的是当前那张码");
});

test("重新发起登录时，绝不把上一轮已经展示过的废码再投一次", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const { channel, delivered } = makeChannel(webui);
  t.after(() => channel.stop());

  await channel.beginLogin();
  const stale = delivered[0]!.text;

  // 模拟上一轮登录流程已经结束（超时/失败），但 NapCat 那边还停在旧状态、
  // status.qrcodeurl 仍然等于我们刚刚展示过的那一张。
  await retireLoginLoop(channel);
  ageQr(channel, PAST_REUSE_WINDOW_MS);
  await channel.beginLogin();

  assert.equal(delivered.length, 2, "重新发起时应当把码投出来");
  assert.notEqual(delivered[1]!.text, stale, "这是用户在手机上看到「已过期」的直接原因，必须换掉");
  assert.equal(delivered[1]!.text, webui.qrcodeurl());
  assert.equal(webui.refreshRequests, 1, "正是这次强制刷新把废码换掉了");
});

test("码已过半寿命时重新说「QQ登录」，必须给新码而不是重发那张残码", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const { channel, delivered } = makeChannel(webui);
  t.after(() => channel.stop());

  await channel.beginLogin();
  const first = delivered[0]!.text;
  await retireLoginLoop(channel);

  // 复用窗口以前是 120s，等于码本身的寿命：用户在第 110 秒再喊一句「QQ登录」，
  // 扩展会把他 110 秒前那张码原样再发一遍 —— 他扫到的就是「二维码已过期」。
  ageQr(channel, PAST_REUSE_WINDOW_MS);
  assert.equal(channel.loginActive(), false, "过半寿命的码不该再被判定为可复用");

  await channel.beginLogin();

  assert.equal(delivered.length, 2, "应当把码重新投出来");
  assert.notEqual(delivered[1]!.text, first, "给用户的码必须至少还剩一半寿命");
  assert.equal(delivered[1]!.text, webui.qrcodeurl());
});

test("已扫码待确认时，码还没到硬过期线就不换（不打断用户的确认）", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const { channel, delivered } = makeChannel(webui);
  t.after(() => channel.stop());

  await channel.beginLogin();
  webui.setLoginPhase("qrcode_scanned");
  // 已越过复用窗口（60s）但还没到硬过期线（115s）
  ageQr(channel, PAST_REUSE_WINDOW_MS);

  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(delivered.length, 1, "用户正在手机上确认，不该把码换掉");
  assert.equal(webui.refreshRequests, 0, "宽限期内不该去骚扰 NapCat");
  assert.equal(channel.status().state, "needs-login");
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

/* ------------------------------------------------------------------ */
/* 自动启动 NapCat（说一句「QQ登录」就把没跑的程序拉起来）              */
/* ------------------------------------------------------------------ */

/** 拿一个当前空闲的端口（先占住再放掉，尽量不撞别的服务）。 */
async function freePort(): Promise<number> {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * 造一个真的能当 NapCat WebUI 用的独立脚本。
 *
 * 为什么要起子进程而不是用上面的假 WebUI：这一条测的就是「启动脚本被执行 →
 * WebUI 起来了 → 出码」，如果 WebUI 由测试进程自己提供，就等于把要验的东西
 * 短路掉了（这正是真机上 NapCat 没开时最典型的失败方式）。
 */
function writeFakeNapcat(dir: string, port: number, token: string, pidFile: string): string {
  const server = `
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const port = Number(process.argv[2]);
const token = process.argv[3];
const pidFile = process.argv[4];
const hash = createHash("sha256").update(token + ".napcat").digest("hex");
const url = "https://txz.qq.com/p?k=from-autostart";
const credentials = new Set();

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      const json = (payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === "/api/auth/login") {
        if (parsed.hash !== hash) return json({ code: -1, message: "token is invalid" });
        const credential = "child-cred-1";
        credentials.add(credential);
        return json({ code: 0, data: { Credential: credential }, message: "success" });
      }
      const auth = String(req.headers.authorization ?? "");
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!credentials.has(bearer)) return json({ code: -1, message: "Unauthorized" });
      switch (req.url) {
        case "/api/QQLogin/CheckLoginStatus":
          return json({
            code: 0,
            data: { isLogin: false, loginPhase: "waiting_qrcode", qrcodeurl: url },
            message: "success",
          });
        case "/api/QQLogin/GetQQLoginQrcode":
          return json({ code: 0, data: { qrcode: url }, message: "success" });
        case "/api/QQLogin/RefreshQRcode":
          return json({ code: 0, data: { qrcodeurl: url }, message: "success" });
        default:
          return json({ code: -1, message: "unknown endpoint" });
      }
    });
  })
  .listen(port, "127.0.0.1", () => fs.writeFileSync(pidFile, String(process.pid)));
`;
  fs.writeFileSync(path.join(dir, "fake-webui.mjs"), server);

  // 启动脚本写成 .cmd：与 NapCat 的 launcher.bat 同一种调用方式
  const script = path.join(dir, "fake-launcher.cmd");
  fs.writeFileSync(
    script,
    [
      "@echo off",
      `echo %date% %time% > "${path.join(dir, "launched.marker")}"`,
      `start "" /b node "${path.join(dir, "fake-webui.mjs")}" ${port} ${token} "${pidFile}"`,
      "",
    ].join("\r\n"),
  );
  return script;
}

test("NapCat 没跑时自动把它启动起来，启动完照常把二维码投进对话", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-autostart-"));
  const port = await freePort();
  const token = "autostart-token";
  const pidFile = path.join(dir, "child.pid");
  const script = writeFakeNapcat(dir, port, token, pidFile);
  t.after(() => {
    // 收掉子进程，别给后面留下一个占着端口的 node
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (pid > 0) spawnSync("taskkill", ["/f", "/pid", String(pid)], { windowsHide: true });
    } catch {
      /* 没起来就算了 */
    }
  });

  const fake = { port, token } as FakeWebui;
  const { channel, delivered, statuses } = makeChannel(fake, 59995, token, {
    enabled: true,
    shellDir: dir,
    launchScript: script,
    killStale: false,
    bootTimeoutMs: 20_000,
  });
  t.after(() => channel.stop());

  await channel.beginLogin();

  assert.ok(fs.existsSync(path.join(dir, "launched.marker")), "应当真的执行了启动脚本");
  assert.equal(delivered.length, 1, "启动完应当把二维码投出来，而不是只报个错");
  assert.equal(delivered[0]!.text, "https://txz.qq.com/p?k=from-autostart");
  assert.equal(channel.status().state, "needs-login");
  assert.ok(statuses.includes("needs-login"));
});

test("启动脚本不存在时，报出可照做的原因，而不是 fetch failed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-missing-"));
  const webui = await startFakeWebui();
  const deadPort = webui.port;
  await webui.close();

  const { channel } = makeChannel({ ...webui, port: deadPort }, deadPort, undefined, {
    enabled: true,
    shellDir: dir,
    launchScript: path.join(dir, "nope.cmd"),
    killStale: false,
    bootTimeoutMs: 1000,
  });
  t.after(() => channel.stop());

  await assert.rejects(() => channel.beginLogin(), /启动脚本也不存在/);
  assert.equal(channel.status().state, "error");
});

test("NapCat 已经在跑时，不去执行启动脚本（不做多余动作）", async (t) => {
  const webui = await startFakeWebui();
  t.after(() => webui.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-alive-"));
  const script = path.join(dir, "should-not-run.cmd");
  fs.writeFileSync(script, ["@echo off", `echo ran > "${path.join(dir, "ran.marker")}"`, ""].join("\r\n"));

  const { channel, delivered } = makeChannel(webui, 59994, undefined, {
    enabled: true,
    shellDir: dir,
    launchScript: script,
    killStale: false,
    bootTimeoutMs: 1000,
  });
  t.after(() => channel.stop());

  await channel.beginLogin();

  assert.ok(!fs.existsSync(path.join(dir, "ran.marker")), "WebUI 活着就不该启动脚本");
  assert.equal(delivered.length, 1);
});

test("自动启动关掉时，行为完全回退到老样子（只报错不启动）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-off-"));
  const script = path.join(dir, "should-not-run.cmd");
  fs.writeFileSync(script, ["@echo off", `echo ran > "${path.join(dir, "ran.marker")}"`, ""].join("\r\n"));
  const webui = await startFakeWebui();
  const deadPort = webui.port;
  await webui.close();

  const { channel } = makeChannel({ ...webui, port: deadPort }, deadPort, undefined, {
    enabled: false,
    shellDir: dir,
    launchScript: script,
    killStale: false,
  });
  t.after(() => channel.stop());

  await assert.rejects(() => channel.beginLogin(), /无法连接 NapCat WebUI/);
  assert.ok(!fs.existsSync(path.join(dir, "ran.marker")), "关掉之后一次都不该执行脚本");
});

test("resolveAutoStart：shellDir 留空时跟随换号配置，再兜底到默认安装目录", () => {
  const followed = resolveAutoStart({ ...DEFAULT_AUTO_START, shellDir: "" }, "D:/Custom/NapCat.Shell");
  assert.equal(followed.shellDir, "D:/Custom/NapCat.Shell");

  const fallback = resolveAutoStart({ ...DEFAULT_AUTO_START, shellDir: "" });
  assert.match(fallback.shellDir, /NapCat/i);

  const pinned = resolveAutoStart(
    { ...DEFAULT_AUTO_START, shellDir: "E:/Own" },
    "D:/Custom/NapCat.Shell",
  );
  assert.equal(pinned.shellDir, "E:/Own", "显式配置优先");
});

test("resolveLaunchScript：默认用 shellDir 下的 launcher，可被 launchScript 覆盖", () => {
  assert.match(resolveLaunchScript({ shellDir: "D:/NapCat/NapCat.Shell", launchScript: "" }), /launcher\.(bat|sh)$/);
  assert.equal(
    resolveLaunchScript({ shellDir: "D:/NapCat/NapCat.Shell", launchScript: "D:/NapCat/start-napcat.bat" }),
    "D:/NapCat/start-napcat.bat",
  );
});

test("ensureNapcatRunning：端口已经在听时直接返回「无需启动」", async () => {
  const webui = await startFakeWebui();
  try {
    const out = await ensureNapcatRunning(
      { ...DEFAULT_AUTO_START, enabled: true },
      { host: "127.0.0.1", port: webui.port, reason: "单测" },
    );
    assert.equal(out.attempted, false, "已经在跑就不该尝试启动");
    assert.equal(out.ok, true);
    assert.equal(out.started, false);
  } finally {
    await webui.close();
  }
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
