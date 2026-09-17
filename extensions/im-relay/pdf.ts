/**
 * 文字 → PDF。给「长结论别在聊天里刷屏」这条约定提供实现。
 *
 * 路线：Markdown → HTML → Chrome/Edge 无头 `--print-to-pdf`。
 * 为什么不用 reportlab / weasyprint：本机 Python 不在 PATH，而 Chrome 和 Edge
 * 都是现成的；CSS 排版能力也更强，中文、表格、代码块开箱即用。
 *
 * 踩过的坑（都写进代码里了）：
 *   - Chrome 的退出码有时不为 0（即使 PDF 已经写好），所以**以文件是否真的生成为准**
 *   - 必须用独立的 `--user-data-dir`，否则会和用户正在开的 Chrome 抢 profile 而卡住
 *   - `--no-pdf-header-footer` 去掉页眉页脚里那串 file:// 路径
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildHtml, mdToHtml } from "./md.ts";
import { createLogger, errorText } from "./log.ts";

const log = createLogger("pdf");

/** 候选浏览器路径：配置优先，然后是常见安装位置。 */
export function candidateBrowsers(configured = ""): string[] {
  return [
    configured,
    process.env.CHROME_PATH ?? "",
    process.env.PI_IM_RELAY_BROWSER ?? "",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
}

export function findBrowser(configured = ""): string | undefined {
  for (const c of candidateBrowsers(configured)) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* 继续找 */
    }
  }
  return undefined;
}

export interface RenderOptions {
  title?: string;
  /** Chrome/Edge 路径；留空自动探测 */
  browser?: string;
  /** 输出 PDF 路径 */
  output: string;
  workDir?: string;
}

/** 把一段 Markdown 渲染成 PDF，返回生成的文件路径。失败时抛错。 */
export function renderPdf(markdown: string, options: RenderOptions): string {
  const browser = findBrowser(options.browser ?? "");
  if (!browser) {
    throw new Error("找不到 Chrome / Edge（可用 pdf.browser 配置或 CHROME_PATH 环境变量指定）");
  }

  const dir = options.workDir ?? path.dirname(options.output);
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, `${path.basename(options.output, ".pdf")}.html`);
  fs.writeFileSync(htmlPath, buildHtml(mdToHtml(markdown), options.title ?? ""), "utf8");

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pi-im-relay-pdf-"));
  const url = `file:///${htmlPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--user-data-dir=${profile}`,
    "--no-pdf-header-footer",
    `--print-to-pdf=${options.output}`,
    url,
  ];
  const r = spawnSync(browser, args, { encoding: "utf8", timeout: 120_000 });
  if (r.error) throw new Error(`调用浏览器失败：${errorText(r.error)}`);

  // 退出码不可靠 —— 以文件为准
  let size = 0;
  try {
    size = fs.statSync(options.output).size;
  } catch {
    size = 0;
  }
  try {
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(htmlPath, { force: true });
  } catch {
    /* ignore */
  }
  if (size < 1000) {
    throw new Error(
      `PDF 生成失败（${size} 字节）。stdout=${(r.stdout ?? "").slice(0, 200)} stderr=${(r.stderr ?? "").slice(0, 200)}`,
    );
  }
  log.info(`已渲染 PDF ${options.output}（${(size / 1024).toFixed(1)} KB）`);
  return options.output;
}

/**
 * 把 HTML 渲染成 PNG 卡片图（空间说说配图用）。
 *
 * 为什么不用文生图模型：排版卡片需要的是**精确的**颜色、字号、间距，
 * 自己写 HTML/CSS 反复调比用自然语言描述给模型可靠得多，而且改一个色号只要两秒。
 * 这条路线在浏览器无头模式下顺手就能做，不需要额外依赖。
 */
export function renderScreenshot(
  htmlPath: string,
  output: string,
  width: number,
  height: number,
  configuredBrowser = "",
): string {
  const browser = findBrowser(configuredBrowser);
  if (!browser) throw new Error("找不到 Chrome / Edge（可用 pdf.browser 配置或 CHROME_PATH 环境变量指定）");

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pi-im-relay-shot-"));
  const url = `file:///${htmlPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--user-data-dir=${profile}`,
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    `--screenshot=${output}`,
    url,
  ];
  const r = spawnSync(browser, args, { encoding: "utf8", timeout: 120_000 });
  if (r.error) throw new Error(`调用浏览器失败：${errorText(r.error)}`);

  let size = 0;
  try {
    size = fs.statSync(output).size;
  } catch {
    size = 0;
  }
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // 同样不信任退出码，以文件为准
  if (size < 500) {
    throw new Error(`截图失败（${size} 字节）。stderr=${(r.stderr ?? "").slice(0, 200)}`);
  }
  return output;
}

/** 正文是否「长到该走 PDF」。 */
export function shouldUsePdf(text: string, threshold: number): boolean {
  if (threshold <= 0) return false;
  if (text.length > threshold) return true;
  // 表格在手机上基本没法看，即使不长也建议走 PDF
  return /^\s*\|.*\|\s*$/m.test(text);
}
