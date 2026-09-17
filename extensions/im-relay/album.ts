/**
 * 相册：把收到的图片落到本机目录。
 *
 * 为什么这件事必须写在扩展里，而不能指望 agent"记住"：
 * agent 的上下文会被压缩、会话会换新，而「用户发的图存哪了」是不能丢的信息。
 * 用户明确提过这个诉求（"避免记忆丢失"）。
 *
 * 几个刻意的设计：
 *   - **按内容哈希去重**：同一张图连发几次只存一份（实测用户会因为没看到回执而连发）
 *   - **按文件头判格式**，不信扩展名 —— QQ 转存过来的文件名经常没有真实后缀
 *   - **绝不覆盖**：重名自动加序号
 *   - 失败不影响消息处理：存图是附带动作，不能让它把主流程带崩
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR, STATE_DIR, type AlbumConfig } from "./config.ts";
import { createLogger, errorText } from "./log.ts";

const log = createLogger("album");

const INDEX_FILE = path.join(STATE_DIR, "album-index.json");

export interface SavedImage {
  /** 绝对路径 */
  file: string;
  bytes: number;
  mimeType: string;
  /** true = 这张图之前就存过，本次没有新建文件 */
  duplicate: boolean;
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
};

/** 用文件头判断真实格式；认不出来才退回 mimeType 或 .jpg。 */
export function sniffImageExt(buf: Buffer, mimeType = ""): string {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length > 3 && buf.toString("ascii", 0, 3) === "GIF") return ".gif";
  if (buf.length > 12 && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
  return MIME_EXT[mimeType.toLowerCase()] ?? ".jpg";
}

/** 展开 `QQ_{yyyy}{MM}{dd}_{HH}{mm}{ss}` 这类模板。 */
export function expandPattern(pattern: string, at = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (pattern || "QQ_{yyyy}{MM}{dd}_{HH}{mm}{ss}")
    .replace(/\{yyyy\}/g, String(at.getFullYear()))
    .replace(/\{MM\}/g, p(at.getMonth() + 1))
    .replace(/\{dd\}/g, p(at.getDate()))
    .replace(/\{HH\}/g, p(at.getHours()))
    .replace(/\{mm\}/g, p(at.getMinutes()))
    .replace(/\{ss\}/g, p(at.getSeconds()));
}

/* --------------------------- 内容哈希索引 --------------------------- */

let index: Record<string, string> | undefined;

function loadIndex(): Record<string, string> {
  if (index) return index;
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")) as Record<string, string>;
  } catch {
    index = {};
  }
  return index;
}

function persistIndex(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(index ?? {}, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, INDEX_FILE);
  } catch (error) {
    log.debug(`相册索引写入失败：${errorText(error)}`);
  }
}

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** 测试用：丢掉内存里的索引缓存。 */
export function resetAlbumIndex(): void {
  index = undefined;
}

/* ------------------------------- 主流程 ------------------------------- */

/**
 * 把入站图片写进相册。**永不抛错** —— 失败只记日志并跳过。
 * 返回成功落盘（或命中已有副本）的那些。
 */
export function saveInboundImages(
  images: Array<{ mimeType: string; data: string }>,
  config: AlbumConfig,
  at = new Date(),
): SavedImage[] {
  if (!config.enabled || images.length === 0) return [];

  const out: SavedImage[] = [];
  const idx = loadIndex();
  let dirty = false;

  for (const [i, img] of images.entries()) {
    try {
      const buf = Buffer.from(img.data, "base64");
      if (buf.length === 0) continue;

      const hash = sha(buf);
      if (config.dedupe) {
        const known = idx[hash];
        if (known && fs.existsSync(known)) {
          out.push({ file: known, bytes: buf.length, mimeType: img.mimeType, duplicate: true });
          log.info(`图片与已有副本相同，跳过保存：${known}`);
          continue;
        }
      }

      fs.mkdirSync(config.dir, { recursive: true });
      const ext = sniffImageExt(buf, img.mimeType);
      const base = expandPattern(config.namePattern, at);
      const suffix = images.length > 1 ? `_${i + 1}` : "";
      let file = path.join(config.dir, `${base}${suffix}${ext}`);
      let n = 1;
      while (fs.existsSync(file)) file = path.join(config.dir, `${base}${suffix}_${++n}${ext}`);

      fs.writeFileSync(file, buf);
      if (config.dedupe) {
        idx[hash] = file;
        dirty = true;
      }
      out.push({ file, bytes: buf.length, mimeType: img.mimeType, duplicate: false });
      log.info(`已存入相册 ${file}（${(buf.length / 1024).toFixed(1)} KB）`);
    } catch (error) {
      log.warn(`相册保存失败（忽略，不影响消息处理）：${errorText(error)}`);
    }
  }

  if (dirty) persistIndex();
  return out;
}
