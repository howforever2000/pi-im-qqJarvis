#!/usr/bin/env node
/**
 * cbc.mjs —— 把任务派给本机的 CodeBuddy（WorkBuddy）引擎，并把结果结构化拿回来。
 *
 * 为什么要有它：WorkBuddy / CodeBuddy 桌面版的「远程控制」是给手机用的，走
 * `http://127.0.0.1:<port>/api/v1/...`，但那一层要 `authEnabled` 的访问密码，
 * 而用户是微信扫码登进去的、根本没有密码。抠 localStorage 里的
 * `codebuddy.auth.token` 也能绕过去，但那是从别的应用里掏凭据，脏。
 *
 * 正道是这个 CLI —— 桌面版自带 `resources/app.asar.unpacked/cli/bin/codebuddy`，
 * 它和桌面版**共用同一个 `.workbuddy` 目录**，所以登录态是现成的，不需要任何密码。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 默认非阻塞（这是被教训出来的）
 * ───────────────────────────────────────────────────────────────────────
 * 最初这个脚本是**前台阻塞**的：`-p` 一直跑到干完才返回。后果是派一个 20 分钟的
 * 活，调用方（IM 里的 agent）就被钉住 20 分钟 —— 期间用户发消息没人理，感觉
 * 是「机器人失联」。
 *
 * 现在默认走 `--bg`（CodeBuddy 的后台会话）：**2 秒返回一个 id**，调用方立刻
 * 恢复自由，靠 `--status` 按需查进度、`--result` 取结果、`--watch` 让脚本干完
 * 主动通知。前台阻塞改成显式的 `--fg`。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 用法
 * ───────────────────────────────────────────────────────────────────────
 *   node cbc.mjs "把 xxx 修了"                  # 后台派活，立刻返回 id
 *   node cbc.mjs --fg "..."                     # 前台等它干完（老行为，会阻塞）
 *   node cbc.mjs --status                       # 看所有派出去的活现在什么状态
 *   node cbc.mjs --result <id>                  # 取某个活的结论（干完才有）
 *   node cbc.mjs --stop <id>                    # 终止某条活（记中断状态，不再挂守护）
 *   node cbc.mjs --notify "..."                 # 派活 + 挂守护：干完主动推 QQ 通知
 *   node cbc.mjs --watch <id>                   # 给已派出去的活补挂守护
 *   node cbc.mjs --write "..."                  # acceptEdits（默认是 plan，只读）
 *   node cbc.mjs --mode bypassPermissions "..." # 完全不问权限（干真活要这个）
 *   node cbc.mjs -C <目录> "..."                 # 指定工作目录
 *   node cbc.mjs -w "..."                       # 在独立 git worktree 里干
 *   node cbc.mjs -r <sessionId> "接着说"         # 续上一个会话
 *
 * 关于 --stop：派活有入口、收活也得有。它会去 `~/.codebuddy/jobs/<id>/broker.json`
 * 读 pid、杀掉整棵进程树，并把记录标成 `stopped`（不再显示成永远 working）。
 * 只动**我们自己**的记录，不写 WorkBuddy 的 job 目录 —— 那是它的地盘，改坏了得不偿失。
 *
 * 关于权限模式（实测）：plan 会把 Bash 一起挡掉 —— 只适合纯读代码的场景，
 * 连 `git status` 都跑不了。要它能跑命令就得 acceptEdits 起步，要它真的改代码
 * 得 bypassPermissions。
 *
 * 退出码：0 = 成功；1 = 失败（stderr 里有原因）；2 = 用法错误。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_DIR = "C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli";
const CLI_ENTRY = path.join(CLI_DIR, "bin", "codebuddy");

/** 派活记录落在哪 —— 放在 relay 的 tmp 下，跟着它的生命周期走。 */
const STATE_DIR = "D:\\YUAN HAO\\Documents\\.pi\\agent\\im-relay\\tmp\\cbc-tasks";

/** WorkBuddy CLI 自己的 job 目录（只读，用来找 pid）。 */
const JOBS_DIR = path.join(os.homedir(), ".codebuddy", "jobs");

/** 通知发到哪个 QQ（从 relay 配置的号主白名单里取，取不到就退回这个）。 */
const FALLBACK_UIN = "1279717885";
const ONEBOT_WS = "ws://127.0.0.1:3001";

/* ------------------------------- 公共 ------------------------------- */

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

const recordPath = (id) => path.join(STATE_DIR, `${id}.json`);

function readRecord(id) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(id), "utf8"));
  } catch {
    return undefined;
  }
}

function writeRecord(record) {
  ensureStateDir();
  fs.writeFileSync(recordPath(record.id), JSON.stringify(record, null, 2), "utf8");
}

/** 用桌面版自带的 node（版本更贴近它自己），拿不到就用当前 node。 */
function pickNode() {
  try {
    const base = path.join(os.homedir(), ".workbuddy", "binaries", "node", "versions");
    const versions = fs.readdirSync(base).filter((d) => d.startsWith("22."));
    if (versions.length) return path.join(base, versions.sort().pop(), "node.exe");
  } catch {
    /* 忽略：用系统 node */
  }
  return process.execPath;
}

/**
 * 问 CodeBuddy 要所有后台会话的状态（JSON）。
 *
 * 注意：**不能带 CODEBUDDY_FORCE_HEADLESS_BUNDLE**。`agents` 命令在 headless
 * bundle 里没实现 —— 带了它只会得到一句 `No mapping found: POST /internal/agents`
 * 和空 stdout，而且退出码还是 0（静默失败）。派活（-p）才需要 headless，
 * 而那个由 launcher 自己识别 `--print` 即可，不用我们插手。
 */
function listJobs() {
  const r = spawnSync(pickNode(), [CLI_ENTRY, "agents", "--jobs", "--all"], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  if (r.error) throw new Error(`查询会话失败：${r.error.message}`);
  const out = r.stdout ?? "";
  try {
    return JSON.parse(out);
  } catch {
    // 不静默吞掉：拿不到状态就让调用方看见原因，否则会误报成 "running"
    throw new Error(`解析会话列表失败（stdout ${out.length} 字节）：${(r.stderr ?? "").trim().slice(0, 160) || out.slice(0, 160)}`);
  }
}

/**
 * 从会话转录里取结论。
 *
 * 传进来的可以是完整 sessionId，也可以只是短 id —— 因为派活后立刻去问 `agents`
 * 常常还没登记，只能退回短 id 存下来。所以这里做前缀匹配兑底。
 *
 * 为什么不读 `--bg` 打印的那个 bg-*.log：实测它是**空的**（0 字节）。
 * 真正的输出落在 `~/.codebuddy/projects/<项目>/<sessionId>.jsonl`。
 */
function readResult(sessionIdOrId) {
  const root = path.join(os.homedir(), ".codebuddy", "projects");
  let file;
  try {
    for (const project of fs.readdirSync(root)) {
      const dir = path.join(root, project);
      const exact = path.join(dir, `${sessionIdOrId}.jsonl`);
      if (fs.existsSync(exact)) {
        file = exact;
        break;
      }
      // 前缀兑底：短 id 也能找到
      if (!file) {
        const hit = fs.readdirSync(dir).find((f) => f.startsWith(sessionIdOrId) && f.endsWith(".jsonl"));
        if (hit) file = path.join(dir, hit);
      }
    }
  } catch {
    return undefined;
  }
  if (!file) return undefined;

  let lines;
  try {
    lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return undefined;
  }

  const pieces = [];
  for (const line of lines) {
    if (line.type === "result" && typeof line.result === "string") pieces.push({ kind: "result", text: line.result });
    if (line.type === "message" && line.role === "assistant" && Array.isArray(line.content)) {
      for (const block of line.content) {
        if (block?.type === "output_text" && typeof block.text === "string") pieces.push({ kind: "text", text: block.text });
      }
    }
  }
  // 优先 result 事件；没有就退回最后一段 assistant 文本
  const result = pieces.filter((p) => p.kind === "result").pop();
  if (result) return result.text;
  const text = pieces.filter((p) => p.kind === "text").pop();
  return text?.text;
}

/** 取号主 QQ 号：从 relay 配置的白名单读，读不到用兜底值。 */
function ownerUin() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync("D:\\YUAN HAO\\Documents\\.pi\\agent\\im-relay\\config.json", "utf8"),
    );
    const list = cfg?.channels?.qq?.allowUsers;
    if (Array.isArray(list) && list.length) return String(list[0]);
  } catch {
    /* 忽略 */
  }
  return FALLBACK_UIN;
}

/** 经 OneBot11 直连给号主发一条 QQ 私聊（不经过 agent，零 token）。 */
async function notifyQq(text) {
  const { default: WebSocket } = await import("ws");
  const uin = ownerUin();
  return new Promise((resolve) => {
    const ws = new WebSocket(ONEBOT_WS);
    const done = (ok, why) => {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      resolve({ ok, why });
    };
    const timer = setTimeout(() => done(false, "超时"), 15_000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ action: "send_private_msg", params: { user_id: Number(uin), message: text }, echo: "n" })),
    );
    ws.on("message", (buf) => {
      clearTimeout(timer);
      try {
        const m = JSON.parse(String(buf));
        if (m.echo === "n") done(m.status === "ok", m.message || m.wording || "");
      } catch {
        done(false, "响应解析失败");
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      done(false, e.message);
    });
  });
}

/* ------------------------------- 子命令 ------------------------------- */

async function cmdStatus() {
  ensureStateDir();
  const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
  if (!files.length) {
    console.log("还没有派出去过活。");
    return;
  }
  let live = [];
  try {
    live = listJobs();
  } catch (error) {
    console.log(`（查不到实时状态：${error.message}）`);
  }
  const rows = files
    .map((f) => readRecord(f.replace(/\.json$/, "")))
    .filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt);

  console.log(`${"id".padEnd(10)}${"状态".padEnd(10)}${"已耗时".padEnd(10)}任务`);
  console.log("-".repeat(90));
  for (const rec of rows) {
    const job = live.find((j) => j.id === rec.id);
    // 我们自己标过 stopped 的活，就不再信实时列表 —— 进程被杀后
    // WorkBuddy 的 job 目录可能还挂着 working，那样会永远显示成在跑。
    const state = rec.state === "stopped" ? "stopped" : (job?.state ?? rec.state ?? "?");
    const secs = Math.round((Date.now() - rec.startedAt) / 1000);
    const ended = state === "done" || state === "failed" || state === "stopped";
    const took = ended
      ? `${Math.round((rec.finishedAt ?? Date.now()) / 1000 - rec.startedAt / 1000)}s`
      : `${secs}s`;
    const brief = rec.prompt.replace(/\s+/g, " ").slice(0, 46);
    console.log(`${rec.id.padEnd(10)}${String(state).padEnd(10)}${took.padEnd(10)}${brief}`);
  }
  console.log();
  console.log("取结论：node cbc.mjs --result <id>");
}

function cmdResult(id) {
  if (!id) {
    console.error("用法：node cbc.mjs --result <id>");
    process.exit(2);
  }
  const rec = readRecord(id);
  if (!rec) {
    console.error(`找不到记录：${id}`);
    process.exit(1);
  }
  let jobs = [];
  try {
    jobs = listJobs();
  } catch (error) {
    console.log(`（查不到实时状态：${error.message}）`);
  }
  const job = jobs.find((j) => j.id === id);
  const state = job?.state ?? rec.state ?? "?";
  if (state !== "done" && state !== "failed") {
    console.log(`还没干完（当前状态：${state}，已 ${Math.round((Date.now() - rec.startedAt) / 1000)} 秒）`);
    process.exit(0);
  }
  const text = readResult(job?.sessionId ?? rec.sessionId);
  console.log(`【${id} · ${state} · 耗时 ${Math.round(((rec.finishedAt ?? Date.now()) - rec.startedAt) / 1000)} 秒】`);
  console.log();
  console.log(text ?? "(转录里没找到结论)");
}

/** 从 WorkBuddy 的 job 目录里读 broker 进程号（只读）。 */
function brokerPid(id) {
  try {
    const raw = fs.readFileSync(path.join(JOBS_DIR, id, "broker.json"), "utf8");
    const pid = JSON.parse(raw)?.pid;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 杀整棵进程树。Windows 用 taskkill /T（不走 shell，否则会撞上 Git Bash 的路径改写）。 */
function killTree(pid) {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        encoding: "utf8",
        windowsHide: true,
      });
      return {
        ok: r.status === 0 || !isAlive(pid),
        why: (r.stderr || r.stdout || `taskkill 退出码 ${r.status}`).trim(),
      };
    }
    process.kill(pid, "SIGTERM");
    return { ok: true, why: "" };
  } catch (error) {
    return { ok: !isAlive(pid), why: error.message };
  }
}

/**
 * 终止一条后台活。
 *
 * 派活有入口，收活也得有 —— 否则用户说「结束它」时只剩手动杀进程，
 * 而且杀完记录还挂着 running，`--status` 会永远显示成在跑。
 *
 * 只动**我们自己**的记录，**不写 WorkBuddy 的 job 目录**：那是它的地盘，
 * 改坏了会影响它自己的一致性，而且 CLI 的活本来就进不了桌面版 GUI。
 */
function cmdStop(id) {
  if (!id) {
    console.error("用法：node cbc.mjs --stop <id>");
    process.exit(2);
  }
  const rec = readRecord(id);
  if (!rec) {
    console.error(`找不到记录：${id}`);
    process.exit(1);
  }

  const pid = brokerPid(id);
  let verdict = "进程已不在（可能早就自己结束了）";
  if (pid && isAlive(pid)) {
    const r = killTree(pid);
    verdict = r.ok ? `已终止进程树（pid ${pid}）` : `终止失败：${r.why}`;
  }

  const partial = readResult(rec.sessionId);
  rec.state = "stopped";
  rec.finishedAt = rec.finishedAt ?? Date.now();
  rec.stoppedAt = Date.now();
  rec.stopReason = "调用方主动终止（cbc.mjs --stop）";
  if (partial) rec.partialResult = String(partial).slice(0, 4000);
  writeRecord(rec);

  const secs = Math.round((rec.stoppedAt - rec.startedAt) / 1000);
  console.log(`已结束 ${id}（共跑了 ${Math.round(secs / 60)} 分 ${secs % 60} 秒）`);
  console.log(`  ${verdict}`);
  console.log(`  记录已标成 stopped —— --status 不会再显示成在跑`);
  if (partial) console.log(`  中断前的最后一个动作：${String(partial).replace(/\s+/g, " ").trim().slice(0, 140)}`);
  console.log(`  全过程转录（没丢）：~/.codebuddy/projects/<项目>/${rec.sessionId}.jsonl`);
}

/**
 * 守护模式：脱离当前进程，定期轮询；干完就推一条 QQ 通知，然后退出。
 *
 * 为什么要脱离：调用方（IM 里的 agent）要立刻恢复自由 —— 不能为了等结果而阻塞。
 * 用 `spawn(..., {detached:true, stdio:'ignore'}).unref()` 起一个独立进程。
 */
function spawnWatcher(id) {
  if (!fs.existsSync(recordPath(id))) {
    console.error(`找不到记录，无法挂守护：${id}`);
    process.exit(1);
  }
  // 注意：import.meta.url 的 pathname 是 **URL 编码**的（空格会变成 %20），
  // 不解码就拼出一个不存在的路径；而 detached + stdio:'ignore' 会把报错吞干净，
  // 表面上「挂上了」实际守护从没启动。
  const self = decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
  const child = spawn(pickNode(), [self, "--watch-loop", id], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function watchLoop(id) {
  const rec = readRecord(id);
  if (!rec) return;

  // 守护是 detached + stdio:'ignore' 跑的，它醒了/报错了调用方看不到。
  // 前面已经因为「静默失败」踩过两次坑（headless env 使 agents 命令失效、
  // URL 编码路径使守护根本没启动），所以这里强制留一份自己的日志。
  const logFile = path.join(STATE_DIR, `${id}.watch.log`);
  const say = (msg) => {
    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
    } catch {
      /* 日志写不了也不能拖垮守护 */
    }
  };
  say(`守护启动 | pid=${process.pid} | cwd=${rec.cwd}`);

  const started = Date.now();
  const MAX_MS = 4 * 60 * 60 * 1000; // 最多守 4 小时
  for (;;) {
    if (Date.now() - started > MAX_MS) {
      say("超时 4 小时，退出");
      const r = await notifyQq(`⏰ ${id} 超过 4 小时还没结束，我不再守了。`);
      say(`超时通知：${r.ok ? "已发" : `失败 ${r.why}`}`);
      return;
    }
    let state = "?";
    try {
      state = listJobs().find((j) => j.id === id)?.state ?? "unknown";
    } catch (error) {
      say(`查询失败（下轮重试）：${error.message}`);
    }
    // 被 --stop 终止过：守护没必要再守，安静退出
    if (readRecord(id)?.state === "stopped" || state === "stopped") {
      say("检测到该活已被 --stop 终止，守护退出");
      return;
    }
    if (state === "done" || state === "failed") {
      const secs = Math.round((Date.now() - rec.startedAt) / 1000);
      rec.state = state;
      rec.finishedAt = Date.now();
      const text = readResult(rec.sessionId);
      rec.result = text ?? "";
      writeRecord(rec);
      say(`检测到 ${state}，已写回记录 | 结果 ${rec.result.length} 字`);

      const head = state === "done" ? "✅ workbubby 干完了" : "❌ workbubby 这活失败了";
      const body = (text ?? "").replace(/\s+/g, " ").trim();
      const brief = body ? body.slice(0, 220) + (body.length > 220 ? "…" : "") : "(没拿到文字结论)";
      const r = await notifyQq(
        `${head}\n\nid：${id}\n耗时：${Math.round(secs / 60)} 分 ${secs % 60} 秒\n工作目录：${rec.cwd}\n\n${brief}\n\n要我独立验收就回一句「验收 ${id}」。`,
      );
      say(`QQ 通知：${r.ok ? "已发" : `失败 ${r.why}`}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  const argv = process.argv.slice(2);

  // 守护进程内部入口（不对用户暴露）
  if (argv[0] === "--watch-loop") return watchLoop(argv[1]);

  const opts = {
    cwd: process.cwd(),
    mode: "plan",
    json: false,
    worktree: false,
    resume: "",
    model: "",
    foreground: false,
    timeoutMs: 600_000,
    watch: false,
  };
  const rest = [];
  const need = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined) {
      console.error(`参数 ${name} 后面缺值`);
      process.exit(2);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--status") return cmdStatus();
    if (a === "--result") return cmdResult(need(i++, a));
    if (a === "--stop" || a === "--kill") return cmdStop(need(i++, a));
    if (a === "--notify") {
      opts.watch = true;
      continue; // 必须 continue：下面是一条 else-if 链，漏下去会被当成未知参数
    }
    if (a === "--watch") {
      // 只给已存在的活补挂守护；派新活时用 --notify
      const id = need(i++, a);
      spawnWatcher(id);
      console.log(`已挂上守护（脱离进程）：干完会主动推 QQ 通知。id：${id}`);
      return;
    }
    if (a === "--write" || a === "-y") opts.mode = "acceptEdits";
    else if (a === "--fg") opts.foreground = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-C" || a === "--cwd") opts.cwd = need(i++, a);
    else if (a === "--mode") opts.mode = need(i++, a);
    else if (a === "-w" || a === "--worktree") opts.worktree = true;
    else if (a === "-r" || a === "--resume") opts.resume = need(i++, a);
    else if (a === "--model") opts.model = need(i++, a);
    else if (a === "--timeout-ms") opts.timeoutMs = Number(need(i++, a));
    else if (a === "-h" || a === "--help") {
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, "").trim());
      return;
    } else if (a.startsWith("-") && a !== "-") {
      console.error(`未知参数：${a}（用 --help 看用法）`);
      process.exit(2);
    } else rest.push(a);
  }

  const prompt = rest.join(" ").trim();
  if (!prompt) {
    console.error('缺少任务内容。用法：node cbc.mjs [--write] [-C 目录] "任务"');
    process.exit(2);
  }
  if (!fs.existsSync(CLI_ENTRY)) {
    console.error(`找不到 CodeBuddy CLI：${CLI_ENTRY}\n（WorkBuddy 桌面版是否还装在默认位置？）`);
    process.exit(1);
  }

  const args = [CLI_ENTRY, "-p", prompt, "--output-format", "json", "--permission-mode", opts.mode];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.worktree) args.push("-w");

  if (!opts.foreground) args.push("--bg");

  const startedAt = Date.now();
  const r = spawnSync(pickNode(), args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

  if (r.error) {
    console.error(`派活失败：${r.error.message}`);
    process.exit(1);
  }

  /* -------- 前台模式：保持老行为，直接把结论打出来 -------- */
  if (opts.foreground) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const stdout = r.stdout ?? "";
    if (opts.json) {
      process.stdout.write(stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.status === 0 ? 0 : 1);
    }
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      if (stdout.trim()) console.log(stdout.trim());
      if (r.stderr.trim()) console.error(r.stderr.trim());
      process.exit(r.status === 0 ? 0 : 1);
    }
    const events = Array.isArray(payload) ? payload : [payload];
    const result = events.filter((e) => e?.type === "result").pop();
    if (!result) {
      console.error("CLI 没有返回 result 事件。原始输出：");
      console.error(stdout.slice(0, 4000));
      process.exit(1);
    }
    if (result.is_error) {
      console.error(`任务失败：${result.result ?? "(无说明)"}`);
      process.exit(1);
    }
    const bits = [`${elapsed}s`];
    if (result.num_turns) bits.push(`${result.num_turns} 轮`);
    if (result.session_id) bits.push(`会话 ${result.session_id}`);
    if (result.permission_denials?.length) bits.push(`被拒权限 ${result.permission_denials.length} 次`);
    console.log(String(result.result ?? "").trim());
    console.log();
    console.log(`── ${bits.join(" · ")}`);
    if (result.permission_denials?.length) {
      console.error(`\n注意：有 ${result.permission_denials.length} 次工具调用被权限挡下了（当前 --mode ${opts.mode}）。要它真的动手，改用 --write。`);
    }
    return;
  }

  /* -------- 后台模式：解析 id 并落一条记录 -------- */
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/backgrounded\s*·\s*([0-9a-f]{8})/);
  if (!m) {
    console.error("没能拿到后台会话 id。原始输出：");
    console.error(out.slice(0, 2000));
    process.exit(1);
  }
  const id = m[1];

  // 从 ps 里补齐完整 sessionId（写结果的转录按完整 id 命名）
  let sessionId = id;
  try {
    const job = listJobs().find((j) => j.id === id);
    if (job?.sessionId) sessionId = job.sessionId;
  } catch {
    /* 拿不到就用短 id 兜底 */
  }

  const rec = {
    id,
    sessionId,
    cwd: opts.cwd,
    prompt,
    mode: opts.mode,
    worktree: opts.worktree,
    startedAt,
    state: "running",
  };
  writeRecord(rec);

  if (opts.watch) spawnWatcher(id);

  console.log(`已派给 workbubby（后台执行，我这边不阻塞）`);
  console.log(`  id      ：${id}`);
  console.log(`  工作目录：${opts.cwd}`);
  console.log(`  权限模式：${opts.mode}`);
  console.log(opts.watch ? `  守护    ：已挂上，干完会主动推 QQ 通知` : `  查进度  ：node cbc.mjs --status`);
  console.log(`  取结论  ：node cbc.mjs --result ${id}`);
}

main().catch((error) => {
  console.error(`未预期的错误：${error?.stack ?? error}`);
  process.exit(1);
});
