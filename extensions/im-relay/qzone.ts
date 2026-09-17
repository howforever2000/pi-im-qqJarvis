/**
 * QQ 空间读取 —— 让 agent「工作前先看一眼自己的主页」。
 *
 * 为什么不用 NapCat 的 OneBot 接口：NapCat 只提供了 `send_qzone_msg` /
 * `delete_qzone_msg`，**没有任何读的接口**。所以这里走的是 QQ 空间自己的网页接口：
 * 先用 NapCat 的 `get_cookies` 拿到 `h5.qzone.qq.com` 的 skey/bkn，再调
 * `emotion_cgi_msglist_v6` 拉说说列表。实测可用（本文件的所有端点都是实测过的）。
 *
 * 关于「置顶」：方案里原本想读置顶说说当身份 prompt，但
 *   - `emotion_cgi_settop_v6` 实测返回 HTTP 500（当前账号不可用）
 *   - 列表接口也不返回任何「是否置顶」字段，就算置顶了也认不出来
 * 所以改成**标记法**：正文以 `memory.identityMarker`（默认 `[身份]`）开头的那条
 * 说说被当作身份定位 prompt。这样不依赖 VIP 权限，也不会因为接口变动而失效。
 *
 * 读取量按用户要求控制：**最近 N 条 + 历史抽样 M 条**，不做全量拉取。
 */
import fs from "node:fs";
import { QZONE_CACHE_FILE, type MemoryConfig } from "./config.ts";
import { createLogger, errorText } from "./log.ts";

const log = createLogger("qzone");

const QZONE_DOMAIN = "h5.qzone.qq.com";
const LIST_API =
  "https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6";

export interface QzonePost {
  tid: string;
  content: string;
  createdAt: number;
  ugcRight: number;
  pics: number;
}

export interface QzoneFeed {
  uin: string;
  /** 说说总数（接口给的 total） */
  total: number;
  nickname: string;
  posts: QzonePost[];
  /** 以 identityMarker 开头的那条，作为身份定位 prompt */
  identity?: QzonePost;
  /** 从缓存里拿到的（没走网络） */
  fromCache: boolean;
  /** 读失败时的原因；此时 posts 可能来自缓存或为空 */
  error?: string;
  readAt: number;
}

/** 调用 OneBot action 的最小接口（由 QqChannel 注入）。 */
export type OneBotCaller = <T>(action: string, params: Record<string, unknown>) => Promise<T>;

function parseJsonp(body: string): unknown {
  const start = body.indexOf("(");
  const end = body.lastIndexOf(")");
  const raw = start >= 0 && end > start ? body.slice(start + 1, end) : body;
  return JSON.parse(raw);
}

/** 说说正文可能带 QQ 的富文本标记，粗清理一下，避免把控制符喂给模型。 */
function cleanContent(input: unknown): string {
  return String(input ?? "")
    .replace(/\u2028|\u2029/g, "\n")
    .replace(/\[\/?em\d*\]/g, "")
    .replace(/\[qq\]|\[\/qq\]/g, "")
    .trim();
}

interface RawMsg {
  tid?: string;
  content?: unknown;
  created_time?: number;
  ugc_right?: number;
  pic?: unknown[];
}

/** 拉一页说说。pos 是从最新往前的偏移。 */
async function fetchPage(
  call: OneBotCaller,
  uin: string,
  cookies: string,
  bkn: string,
  pos: number,
  num: number,
): Promise<{ posts: QzonePost[]; total: number; nickname: string }> {
  const url =
    `${LIST_API}?uin=${uin}&ftype=0&sort=0&pos=${pos}&num=${num}&replynum=0` +
    `&g_tk=${bkn}&callback=_cb&code_version=1&format=jsonp&need_private_comment=1`;
  const res = await fetch(url, {
    headers: {
      Cookie: cookies,
      Referer: `https://user.qzone.qq.com/${uin}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`说说列表 HTTP ${res.status}`);
  const json = parseJsonp(await res.text()) as {
    code?: number;
    message?: string;
    total?: number;
    logininfo?: { name?: string };
    msglist?: RawMsg[];
  };
  if (json.code !== 0) throw new Error(`说说列表返回 code=${json.code} ${json.message ?? ""}`);

  const posts = (json.msglist ?? [])
    .map((m) => ({
      tid: String(m.tid ?? ""),
      content: cleanContent(m.content),
      createdAt: Number(m.created_time ?? 0) * 1000,
      ugcRight: Number(m.ugc_right ?? 0),
      pics: Array.isArray(m.pic) ? m.pic.length : 0,
    }))
    .filter((p) => p.tid && p.content);
  return { posts, total: Number(json.total ?? posts.length), nickname: json.logininfo?.name ?? "" };
}

interface CacheFile {
  uin: string;
  readAt: number;
  feed: Omit<QzoneFeed, "fromCache">;
}

function readCache(uin: string, maxAgeSeconds: number): QzoneFeed | undefined {
  if (maxAgeSeconds <= 0) return undefined;
  try {
    const c = JSON.parse(fs.readFileSync(QZONE_CACHE_FILE, "utf8")) as CacheFile;
    if (c.uin !== uin) return undefined;
    if (Date.now() - c.readAt > maxAgeSeconds * 1000) return undefined;
    return { ...c.feed, fromCache: true };
  } catch {
    return undefined;
  }
}

function writeCache(uin: string, feed: QzoneFeed): void {
  try {
    const payload: CacheFile = { uin, readAt: feed.readAt, feed: { ...feed, fromCache: false } };
    const tmp = `${QZONE_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, QZONE_CACHE_FILE);
  } catch (error) {
    log.debug(`空间缓存写入失败：${errorText(error)}`);
  }
}

/** 测试用：清掉缓存文件。 */
export function clearQzoneCache(): void {
  try {
    fs.rmSync(QZONE_CACHE_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 读主页。缓存命中就直接返回；否则拉「最近 recent 条 + 最旧 sample 条」。
 *
 * 注意：读失败**不抛错**，而是返回一个带 error 的空/缓存结果 ——
 * 读记忆失败不能把「处理用户消息」也一起带崩。
 */
export async function readQzone(
  call: OneBotCaller,
  config: MemoryConfig,
): Promise<QzoneFeed> {
  const readAt = Date.now();
  let uin = "";
  try {
    const me = await call<{ user_id?: number }>("get_login_info", {});
    uin = String(me?.user_id ?? "");
  } catch (error) {
    return { uin: "", total: 0, nickname: "", posts: [], fromCache: false, error: `取登录信息失败：${errorText(error)}`, readAt };
  }
  if (!uin) {
    return { uin, total: 0, nickname: "", posts: [], fromCache: false, error: "拿不到登录 QQ 号", readAt };
  }

  const cached = readCache(uin, config.cacheSeconds);
  if (cached) return cached;

  try {
    const ck = await call<{ cookies?: string; bkn?: string }>("get_cookies", { domain: QZONE_DOMAIN });
    const cookies = ck?.cookies ?? "";
    const bkn = ck?.bkn ?? "";
    if (!cookies) throw new Error("拿不到 h5.qzone.qq.com 的 cookies");

    // 第一页：最近 recent 条
    const first = await fetchPage(call, uin, cookies, bkn, 0, Math.max(1, config.recent));
    const posts = [...first.posts];

    // 历史抽样：从**最旧**的地方取 sample 条（用户要的是"最近五条 + 五条历史抽样"）
    if (config.sample > 0 && first.total > config.recent) {
      const pos = Math.max(config.recent, first.total - config.sample);
      const old = await fetchPage(call, uin, cookies, bkn, pos, config.sample);
      for (const p of old.posts) if (!posts.some((x) => x.tid === p.tid)) posts.push(p);
    }

    const identity = posts.find((p) => p.content.startsWith(config.identityMarker));
    const feed: QzoneFeed = {
      uin,
      total: first.total,
      nickname: first.nickname,
      posts,
      identity,
      fromCache: false,
      readAt,
    };
    writeCache(uin, feed);
    log.info(
      `已读主页：共 ${feed.total} 条，取回 ${posts.length} 条` +
        (identity ? `，身份说说 ${identity.tid}` : "，未找到身份说说"),
    );
    return feed;
  } catch (error) {
    const stale = readCache(uin, Number.MAX_SAFE_INTEGER); // 过期缓存兜底
    const message = errorText(error);
    log.warn(`读主页失败：${message}${stale ? "（已退回缓存）" : ""}`);
    return {
      uin,
      total: stale?.total ?? 0,
      nickname: stale?.nickname ?? "",
      posts: stale?.posts ?? [],
      identity: stale?.identity,
      fromCache: Boolean(stale),
      error: message,
      readAt,
    };
  }
}
