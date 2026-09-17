/**
 * 微信登录流程测试（对着一个假的 iLink 服务器跑）。
 *
 * 锁死的核心行为是用户真实踩到的问题：
 *   他一边敲了 `/im login wechat`，一边又说「登录微信」——两条路各向腾讯申请了一张二维码，
 *   界面上出现两张码，不知道该扫哪一张。
 *   现在第二次触发只会**复用**同一张码（重新发一次），不会再申请新的。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// 必须在 import config.ts 之前指向临时目录，否则会写到真实的微信凭据文件
const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-wechat-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

const { WechatChannel } = await import("../extensions/im-relay/channels/wechat.ts");
const { DEFAULT_CONFIG } = await import("../extensions/im-relay/config.ts");

interface FakeIlink {
  baseUrl: string;
  qrRequests: number;
  statusRequests: number;
  /** 下一次状态查询返回什么 */
  nextStatus: string;
  close(): Promise<void>;
}

async function startFakeIlink(): Promise<FakeIlink> {
  const state: FakeIlink = {
    baseUrl: "",
    qrRequests: 0,
    statusRequests: 0,
    nextStatus: "wait",
    close: async () => {},
  };
  let qrSeq = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/ilink/bot/get_bot_qrcode") {
      state.qrRequests += 1;
      qrSeq += 1;
      json({
        qrcode: `qr-${qrSeq}`,
        qrcode_img_content: `https://liteapp.weixin.qq.com/q/test?qrcode=qr-${qrSeq}&bot_type=3`,
      });
      return;
    }

    if (url.pathname === "/ilink/bot/get_qrcode_status") {
      state.statusRequests += 1;
      const status = state.nextStatus;
      if (status === "confirmed") {
        json({
          status: "confirmed",
          bot_token: "test-bot-token",
          ilink_bot_id: "bot-abc",
          ilink_user_id: "user-xyz@im.wechat",
          baseurl: state.baseUrl,
        });
        return;
      }
      json({ status });
      return;
    }

    if (url.pathname === "/ilink/bot/getupdates") {
      // 故意延迟一下：真实 iLink 是长轮询，立即返回会让客户端热循环
      setTimeout(() => json({ ret: 0, msgs: [], get_updates_buf: "cursor-1" }), 400);
      return;
    }

    if (url.pathname.startsWith("/ilink/bot/msg/notify")) {
      json({ ret: 0 });
      return;
    }

    json({ ret: 0 });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  state.baseUrl = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      // 必须主动掉 keep-alive 连接：server.close() 只停监听，已建立的 socket 会一直
      // 把测试进程挂在事件循环上（表现为整个测试文件超时）。
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return state;
}

function makeChannel(ilink: FakeIlink) {
  const config = structuredClone(DEFAULT_CONFIG.channels.wechat);
  config.enabled = true;
  config.baseUrl = ilink.baseUrl;
  const delivered: Array<{ text: string; size: number }> = [];
  const statuses: string[] = [];
  const channel = new WechatChannel(
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
  return { channel, delivered, statuses };
}

test("beginLogin 拿到二维码后会立刻投递给界面", async (t) => {
  const ilink = await startFakeIlink();
  t.after(() => ilink.close());
  const { channel, delivered } = makeChannel(ilink);
  t.after(() => channel.stop());

  await channel.beginLogin();

  assert.equal(ilink.qrRequests, 1, "应当只申请一次二维码");
  assert.equal(delivered.length, 1, "返回时二维码必须已经投递出去");
  assert.ok(delivered[0]!.text.includes("liteapp.weixin.qq.com"));
  assert.ok(delivered[0]!.size > 100, "投递的应当是渲染好的二维码图片");
});

test("重复触发登录只会复用同一张二维码，不会重复申请（用户实际踩到的 bug）", async (t) => {
  const ilink = await startFakeIlink();
  t.after(() => ilink.close());
  const { channel, delivered } = makeChannel(ilink);
  t.after(() => channel.stop());

  // 第一次：用户敲了 /im login wechat
  await channel.beginLogin();
  // 第二次：用户又说了一句「登录微信」触发工具
  assert.equal(channel.loginActive(), true, "第一张码还在等扫码，应当是可复用的");
  await channel.beginLogin();
  // 第三次：再点一次 /im qr
  await channel.beginLogin();

  assert.equal(ilink.qrRequests, 1, "只应该向 iLink 申请一张二维码");
  assert.equal(delivered.length, 3, "每次触发都应该把码重发给用户看");
  assert.equal(new Set(delivered.map((d) => d.text)).size, 1, "三次投递的必须是同一张码");

  // 让后台的确认轮询结束，避免测试残留
  channel.loginControllerFree?.();
});

test("扫码确认后写入凭据并进入在线状态", async (t) => {
  const ilink = await startFakeIlink();
  t.after(() => ilink.close());
  const { channel, statuses } = makeChannel(ilink);
  t.after(() => channel.stop());

  await channel.beginLogin();
  ilink.nextStatus = "confirmed";

  // 等后台轮询发现 confirmed
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && channel.status().state !== "online") {
    await new Promise((r) => setTimeout(r, 200));
  }

  assert.equal(channel.status().state, "online", `实际状态：${channel.status().state}`);
  const state = JSON.parse(
    fs.readFileSync(path.join(tempAgentDir, "im-relay", "state", "wechat-session.json"), "utf8"),
  ) as { credential?: { accountId?: string; token?: string; userId?: string } };
  assert.equal(state.credential?.accountId, "bot-abc");
  assert.equal(state.credential?.token, "test-bot-token");
  assert.equal(state.credential?.userId, "user-xyz@im.wechat");
  assert.ok(statuses.includes("online"));
});

test("二维码过期后才申请新的一张", async (t) => {
  const ilink = await startFakeIlink();
  t.after(() => ilink.close());
  const { channel, delivered } = makeChannel(ilink);
  t.after(() => channel.stop());

  await channel.beginLogin();
  ilink.nextStatus = "expired";

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && ilink.qrRequests < 2) {
    await new Promise((r) => setTimeout(r, 200));
  }

  assert.equal(ilink.qrRequests, 2, "二维码失效后应当换一张");
  assert.equal(delivered.length, 2);
  assert.notEqual(delivered[0]!.text, delivered[1]!.text);

  // 换码之后仍然可以被复用，不会继续膨胀
  const before = ilink.qrRequests;
  await channel.beginLogin();
  assert.equal(ilink.qrRequests, before, "刷新后的新码同样应当被复用");
});

test("通道被禁用时 beginLogin 直接报错，不产生任何请求", async (t) => {
  const ilink = await startFakeIlink();
  t.after(() => ilink.close());
  const config = structuredClone(DEFAULT_CONFIG.channels.wechat);
  config.enabled = false;
  config.baseUrl = ilink.baseUrl;
  const channel = new WechatChannel(config, { onMessage: () => {}, onStatusChange: () => {} }, 1500);
  t.after(() => channel.stop());

  await assert.rejects(() => channel.beginLogin(), /禁用/);
  assert.equal(ilink.qrRequests, 0);
});
