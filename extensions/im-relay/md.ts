/**
 * 一个够用的 Markdown → HTML 渲染器 + 一套适合中文长文的打印样式。
 *
 * 为什么要自己写而不引依赖：只需要一个很小的子集（标题/段落/表格/代码块/列表/
 * 引用/行内格式），引一个完整的 markdown 库反而要处理语法扩展与安全配置。
 * 这里先把内容转义、再按白名单加标签，不存在注入面。
 *
 * 样式是照着「中文长文 + 表格 + 代码块」这个场景调的：A4、微软雅黑、
 * 行高放大到 1.78（中文比英文更需要行距）、表格禁止跨页断行。
 */

const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 行内格式。代码要先占位，否则里面的 `*` `_` 会被当成强调。 */
export function inline(text: string): string {
  const codes: string[] = [];
  let s = String(text).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const safe = /^(https?:|mailto:)/i.test(href) ? href : "#";
    return `<a href="${esc(safe)}">${label}</a>`;
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${esc(codes[Number(i)] ?? "")}</code>`);
  return s;
}

function renderTable(rows: string[]): string {
  const cells = (line: string): string[] =>
    line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const head = cells(rows[0] ?? "");
  const body = rows.slice(2).map(cells);
  const align = cells(rows[1] ?? "")
    .map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
  const th = head.map((c, i) => `<th style="text-align:${align[i] ?? "left"}">${inline(c)}</th>`).join("");
  const tb = body
    .map(
      (r) =>
        `<tr>${head
          .map((_c, i) => `<td style="text-align:${align[i] ?? "left"}">${inline(r[i] ?? "")}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

/** 渲染正文（不含 <html>/<style> 外壳）。 */
export function mdToHtml(md: string): string {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const isBullet = (l: string) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? "")) buf.push(lines[i++] ?? "");
      i += 1;
      out.push(`<pre class="code"><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (isRow(line) && isSep(lines[i + 1] ?? "")) {
      const rows: string[] = [];
      while (i < lines.length && isRow(lines[i] ?? "")) rows.push(lines[i++] ?? "");
      out.push(renderTable(rows));
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = (h[1] ?? "#").length;
      out.push(`<h${level}>${inline(h[2] ?? "")}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr/>");
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${mdToHtml(buf.join("\n"))}</blockquote>`);
      continue;
    }

    if (isBullet(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && isBullet(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        i += 1;
        // 缩进续行并入上一项
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i] ?? "") &&
          !isBullet(lines[i] ?? "")
        ) {
          items[items.length - 1] = `${items[items.length - 1]} ${(lines[i] ?? "").trim()}`;
          i += 1;
        }
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^\s*(#{1,6}\s|>|```|\|)/.test(lines[i] ?? "") &&
      !isBullet(lines[i] ?? "") &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    out.push(`<p>${inline(para.join("<br/>"))}</p>`);
  }
  return out.join("\n");
}

export const PRINT_CSS = `
:root{
  --ink:#16222b; --muted:#5f7280; --line:#dfe6ec; --soft:#f5f8fa;
  --accent:#0d6e73; --accent-soft:#e6f4f4;
}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact; print-color-adjust:exact}
body{
  margin:0; padding:0;
  font-family:"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;
  font-size:10.5pt; line-height:1.78; color:var(--ink); background:#fff;
}
.doc-head{border-bottom:2.5px solid var(--accent); padding-bottom:10px; margin-bottom:20px}
.doc-head h1{border:0; margin:0 0 6px; padding:0; font-size:20pt; line-height:1.35}
.doc-meta{font-size:8.5pt; color:var(--muted)}
.doc-meta b{color:var(--accent)}
h1{font-size:17pt; margin:22px 0 10px; padding-bottom:6px; border-bottom:1.5px solid var(--line)}
h2{font-size:13.5pt; margin:20px 0 8px; padding-left:9px; border-left:4px solid var(--accent); line-height:1.4}
h3{font-size:11.5pt; margin:15px 0 6px; color:var(--accent)}
h4{font-size:10.5pt; margin:12px 0 5px; color:var(--muted)}
p{margin:7px 0}
a{color:var(--accent); text-decoration:none; border-bottom:1px dotted var(--accent)}
ul,ol{margin:7px 0; padding-left:22px}
li{margin:3px 0}
li::marker{color:var(--accent)}
hr{border:0; border-top:1px dashed var(--line); margin:18px 0}
blockquote{margin:10px 0; padding:9px 13px; background:var(--soft);
  border-left:3px solid var(--accent); color:#31424e; border-radius:0 4px 4px 0}
blockquote p{margin:3px 0}
code{font-family:"Cascadia Mono",Consolas,"Courier New",monospace; font-size:9pt;
  background:var(--accent-soft); color:#0b4f53; padding:1px 4px; border-radius:3px; border:1px solid #cfe6e6}
pre.code{background:#0f2b2e; color:#e8f5f5; border-radius:6px; padding:10px 13px; margin:10px 0;
  font-size:8.6pt; line-height:1.6; white-space:pre-wrap; word-break:break-all; page-break-inside:avoid}
pre.code code{background:none; border:0; color:inherit; padding:0; font-size:inherit}
table{border-collapse:collapse; width:100%; margin:10px 0; font-size:9.5pt; page-break-inside:avoid}
th,td{border:1px solid var(--line); padding:5px 9px; vertical-align:top; line-height:1.6}
th{background:var(--accent-soft); color:#0b4f53; font-weight:600; white-space:nowrap}
tbody tr:nth-child(even){background:#fafcfd}
@media print{
  @page{size:A4; margin:16mm 15mm 15mm 15mm}
  h1,h2,h3{page-break-after:avoid}
  table,pre.code,blockquote,tr{page-break-inside:avoid}
}
`;

export function buildHtml(bodyHtml: string, title = ""): string {
  const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
  const head = title
    ? `<div class="doc-head"><h1>${esc(title)}</h1><div class="doc-meta">生成时间 <b>${stamp}</b></div></div>`
    : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>${esc(title || "report")}</title>
<style>${PRINT_CSS}</style></head><body>${head}${bodyHtml}</body></html>`;
}
