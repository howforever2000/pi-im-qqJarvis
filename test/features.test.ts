/**
 * 相册 / 空间读取 / 记忆组装 / PDF 判定的回归测试。
 *
 * 这些是「用户明确要求写进扩展、避免记忆丢失」的那批能力，所以必须有测试兜着 ——
 * 尤其「最近 N 条 + 历史抽样 M 条」这种规则，很容易在改动中悄悄走样。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-relay-feat-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

const {
  saveInboundImages,
  sniffImageExt,
  expandPattern,
  resetAlbumIndex,
} = await import("../extensions/im-relay/album.ts");
const { readQzone, clearQzoneCache } = await import("../extensions/im-relay/qzone.ts");
const { buildMemory, resetMemoryCache } = await import("../extensions/im-relay/memory.ts");
const { shouldUsePdf } = await import("../extensions/im-relay/pdf.ts");
const { DEFAULT_CONFIG, AGENT_MD_FILE } = await import("../extensions/im-relay/config.ts");

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));

/* ------------------------------- 相册 ------------------------------- */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);

test("按文件头判断图片格式，不信任扩展名/mimeType", () => {
  assert.equal(sniffImageExt(PNG, "image/jpeg"), ".png", "PNG 字节必须判成 png，哪怕 mime 说是 jpeg");
  assert.equal(sniffImageExt(JPEG, ""), ".jpg");
  assert.equal(sniffImageExt(Buffer.from("not an image"), "image/webp"), ".webp", "认不出来才退回 mime");
});

test("文件名模板展开", () => {
  const at = new Date(2026, 8, 17, 12, 50, 35);
  assert.equal(expandPattern("QQ_{yyyy}{MM}{dd}_{HH}{mm}{ss}", at), "QQ_20260917_125035");
});

test("存图：落盘、按内容去重、可关闭", () => {
  const dir = tmp("im-relay-album-");
  resetAlbumIndex();
  const config = { ...DEFAULT_CONFIG.album, dir, dedupe: true };
  const img = [{ mimeType: "image/png", data: PNG.toString("base64") }];

  const first = saveInboundImages(img, config, new Date(2026, 8, 17, 12, 50, 35));
  assert.equal(first.length, 1);
  assert.equal(first[0]?.duplicate, false);
  assert.ok(fs.existsSync(first[0]!.file), "文件应当真的写出来了");
  assert.ok(first[0]!.file.endsWith("QQ_20260917_125035.png"), `实际：${first[0]!.file}`);

  // 同一张图再发一次 —— 只复用，不新建（用户实测会连发同一张）
  const second = saveInboundImages(img, { ...config, dir: tmp("im-relay-album-") }, new Date());
  assert.equal(second[0]?.duplicate, true, "内容相同应当命中已有副本");
  assert.equal(second[0]?.file, first[0]?.file);

  // 关掉之后不该产生任何文件
  const offDir = tmp("im-relay-album-off-");
  assert.deepEqual(saveInboundImages(img, { ...config, enabled: false, dir: offDir }, new Date()), []);
  assert.equal(fs.readdirSync(offDir).length, 0);
});

test("存图失败不影响调用方（目录非法时不抛错）", () => {
  resetAlbumIndex();
  // 用一张没存过的图：否则会命中内容去重，根本不会去碰那个非法目录
  const fresh = Buffer.concat([PNG, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
  const img = [{ mimeType: "image/png", data: fresh.toString("base64") }];
  const saved = saveInboundImages(img, { ...DEFAULT_CONFIG.album, dir: "\u0000bad/\u0000dir" }, new Date());
  assert.deepEqual(saved, [], "拿不到目录就跳过，而不是抛出去把消息处理带崩");
});

/* ------------------------------ 空间读取 ------------------------------ */

interface FetchCall {
  url: string;
}

/** 造一页 JSONP 响应，模仿 emotion_cgi_msglist_v6 的真实结构。 */
function page(offset: number, count: number, total: number, nick = "阿派的新家"): string {
  const msglist = Array.from({ length: count }, (_v, i) => {
    const n = offset + i;
    return {
      tid: `tid${n}`,
      content: `第 ${n} 条说说`,
      created_time: 1_789_000_000 - n * 3600,
      ugc_right: 16,
    };
  });
  return `_cb(${JSON.stringify({ code: 0, total, name: nick, logininfo: { name: nick, uin: 12345 }, msglist })});`;
}

function stubFetch(handler: (url: string) => string, calls: FetchCall[] = []) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    return new Response(handler(url), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const callerFor = (uin = 12345) => async (action: string): Promise<never> => {
  if (action === "get_login_info") return { user_id: uin } as never;
  if (action === "get_cookies") return { cookies: "skey=abc; p_skey=def", bkn: "123" } as never;
  throw new Error(`未预期的 action: ${action}`);
};

test("读主页：最近 N 条 + 最旧 M 条抽样，且带出身份说说", async () => {
  clearQzoneCache();
  resetMemoryCache();
  const config = { ...DEFAULT_CONFIG.memory, recent: 5, sample: 5, cacheSeconds: 0, identityMarker: "[身份]" };
  const calls: FetchCall[] = [];
  const restore = stubFetch((url) => {
    const pos = Number(new URL(url).searchParams.get("pos"));
    const num = Number(new URL(url).searchParams.get("num"));
    if (pos === 0) {
      // 最近 5 条，其中最新那条是身份说说
      const body = page(0, num, 12);
      return body.replace("第 0 条说说", "[身份] 我是阿派 π，跑在用户本机的 agent。");
    }
    return page(pos, num, 12);
  }, calls);
  try {
    const feed = await readQzone(callerFor(), config);
    assert.equal(feed.error, undefined, `不该有错误：${feed.error}`);
    assert.equal(feed.total, 12);
    assert.equal(feed.posts.length, 10, `最近 5 条 + 抽样 5 条 = 10 条，实际 ${feed.posts.length}`);

    const tids = feed.posts.map((p) => p.tid);
    assert.deepEqual(tids.slice(0, 5), ["tid0", "tid1", "tid2", "tid3", "tid4"]);
    assert.deepEqual(tids.slice(5), ["tid7", "tid8", "tid9", "tid10", "tid11"], "抽样应当取最旧的那一段");

    assert.ok(feed.identity, "应当认出身份说说");
    assert.equal(feed.identity?.tid, "tid0");

    // 两次请求：pos=0 与 pos=total-sample
    assert.equal(calls.length, 2, `应当只打两次网络，实际 ${calls.length}`);
  } finally {
    restore();
  }
});

test("读主页失败时退回缓存，而不是抛错", async () => {
  clearQzoneCache();
  resetMemoryCache();
  const config = { ...DEFAULT_CONFIG.memory, recent: 3, sample: 0, cacheSeconds: 0 };

  // 第一次成功，写入缓存
  let restore = stubFetch(() => page(0, 3, 3));
  await readQzone(callerFor(), config);
  restore();

  // 第二次网络炸掉：cacheSeconds=0 表示不用缓存，但兜底路径应当读「过期缓存」
  restore = stubFetch(() => {
    throw new Error("network down");
  });
  try {
    const feed = await readQzone(callerFor(), config);
    assert.ok(feed.error, "应当带上错误原因");
    assert.equal(feed.posts.length, 3, "兜底应当返回上次的内容");
    assert.equal(feed.fromCache, true);
  } finally {
    restore();
  }
});

test("拿不到 cookies 时给出明确错误，不静默", async () => {
  clearQzoneCache();
  const config = { ...DEFAULT_CONFIG.memory, cacheSeconds: 0 };
  const feed = await readQzone(async (action: string) => {
    if (action === "get_login_info") return { user_id: 999 } as never;
    return { cookies: "", bkn: "" } as never;
  }, config);
  assert.match(feed.error ?? "", /cookies/);
});

/* ------------------------------ 记忆组装 ------------------------------ */

test("记忆里包含工作约定、身份定位与说说摘要", async () => {
  clearQzoneCache();
  resetMemoryCache();
  fs.rmSync(AGENT_MD_FILE, { force: true });
  const config = { ...DEFAULT_CONFIG.memory, recent: 5, sample: 0, cacheSeconds: 0, identityMarker: "[身份]" };
  const restore = stubFetch(() => page(0, 2, 2).replace("第 0 条说说", "[身份] 我是阿派 π。"));
  try {
    const memory = await buildMemory(callerFor(), config);
    assert.ok(fs.existsSync(AGENT_MD_FILE), "首次运行应当落地默认 AGENT.md");
    assert.match(memory.text, /## 工作约定/);
    assert.match(memory.text, /## 我的身份定位\n我是阿派 π。/);
    assert.match(memory.text, /## 我主页的说说/);
    assert.match(memory.text, /身份/, "摘要里应当标出哪条是身份说说");
  } finally {
    restore();
  }
});

test("记忆超长会被截断，且不抛错", async () => {
  clearQzoneCache();
  resetMemoryCache();
  fs.writeFileSync(AGENT_MD_FILE, "x".repeat(5000));
  const config = { ...DEFAULT_CONFIG.memory, maxChars: 300, cacheSeconds: 0 };
  const restore = stubFetch(() => page(0, 1, 1));
  try {
    const memory = await buildMemory(callerFor(), config);
    assert.ok(memory.truncated);
    assert.ok(memory.text.length <= 320, `实际长度 ${memory.text.length}`);
    assert.match(memory.text, /记忆已截断/);
  } finally {
    restore();
  }
});

test("memory.enabled=false 时完全不注入", async () => {
  resetMemoryCache();
  const memory = await buildMemory(callerFor(), { ...DEFAULT_CONFIG.memory, enabled: false });
  assert.equal(memory.text, "");
});

/* ------------------------------- PDF ------------------------------- */

test("超过阈值或含表格的建议走 PDF；短句不走", () => {
  assert.equal(shouldUsePdf("短句", 300), false);
  assert.equal(shouldUsePdf("x".repeat(500), 300), true);
  assert.equal(shouldUsePdf("| a | b |\n|---|---|\n| 1 | 2 |", 300), true, "表格在手机上没法看，即使很短也应走 PDF");
  assert.equal(shouldUsePdf("x".repeat(500), 0), false, "阈值 0 表示关闭自动判定");
});
