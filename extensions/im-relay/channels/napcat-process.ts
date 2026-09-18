/**
 * NapCat 进程、自动启动与账号切换。
 *
 * 两件事放一起，是因为它们操作的是同一批东西（QQ.exe / NapCatWinBootMain.exe / 启动脚本）：
 *   1. **自动启动**：NapCat 经常是关着的（重启机器之后尤其如此）。以前这种时候用户
 *      拿到的是 `fetch failed`，还得自己想起来去双击启动脚本。现在说一句「QQ登录」
 *      就把它拉起来（`ensureNapcatRunning()`）。
 *   2. **换号**：发出「QQ登录」就默认把之前那个 QQ 踢下来，换新的登录。
 *
 * 背景：用户要求「发出『QQ登录』就默认把之前那个 QQ 踢下来，换新的登录」。
 *
 * 这件事**绕不开直接操作 NapCat 进程**，原因是实测出来的：
 *   - NapCat 只提供 `send_qzone_msg` / `delete_qzone_msg` 那类业务接口，
 *     WebUI 里也**没有任何「退出登录」接口**（只有 `RestartNapCat`）
 *   - 更关键的是：QQ 客户端把登录票据存在 `%APPDATA%\QQ\auth\login.enc` 里。
 *     只重启 NapCat 而不清票据，客户端会带着旧会话起来，NapCat 会报
 *     「当前账号(xxx)已登录,无法重复登录」，然后永远卡在等二维码 —— 这正是
 *     用户第一次遇到的那个坑。
 * 所以要换号，必须：杀进程 → 备份并清掉票据与旧账号的分区目录 → 重新拉起 NapCat → 等 WebUI 就绪。
 *
 * 安全约束（都是刻意的）：
 *   - **清任何东西之前先备份**（用户明确要求过「动既有资料前先备份」）
 *   - 只清与指定 QQ 号相关的东西；`qqnt_9210` / `qqnt_9211` 这类共享分区绝不动
 *   - 用户可以用 `switchAccount.enabled: false` 完全关掉这个行为
 *   - 只在 `qqDataDir` 里操作，不碰其它目录
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { createLogger, errorText } from "../log.ts";

const log = createLogger("napcat-proc");

export interface SwitchAccountConfig {
  /** 关掉之后就恢复成「已登录就直接复用旧账号」的老行为 */
  enabled: boolean;
  /** NapCat.Shell 目录（含 launcher.bat / NapCatWinBootMain.exe） */
  shellDir: string;
  /** QQ 客户端数据目录；留空用 %APPDATA%\QQ */
  qqDataDir: string;
  /** 备份目录；留空用 shellDir 的上一级 */
  backupDir: string;
  /** 杀掉进程后等多久再拉起（毫秒） */
  restartDelayMs: number;
  /** 等 WebUI 起来的超时（毫秒） */
  bootTimeoutMs: number;
}

export const DEFAULT_SWITCH_ACCOUNT: SwitchAccountConfig = {
  enabled: true,
  shellDir: "D:/NapCat/NapCat.Shell",
  qqDataDir: "",
  backupDir: "",
  restartDelayMs: 4000,
  bootTimeoutMs: 60_000,
};

/**
 * 「说一句 QQ登录 就把 NapCat 拉起来」的配置。
 *
 * 为什么要独立于 switchAccount：换号是「踢掉旧账号」，自动启动是「把没跑的程序跑起来」，
 * 两件事的开关必须分开 —— 想换号但不想被自动启动打扰（或者反过来）都是合理需求。
 */
export interface AutoStartConfig {
  /** 关掉之后恢复老行为：WebUI 不可达就直接报错，让用户自己开 NapCat */
  enabled: boolean;
  /** NapCat.Shell 目录；留空则跟随 switchAccount.shellDir */
  shellDir: string;
  /** 启动脚本；留空用 <shellDir>/launcher.bat。可指向自己的包装脚本（如 D:/NapCat/start-napcat.bat） */
  launchScript: string;
  /** 启动前是否清掉残留的 NapCat 宿主进程（只杀 NapCat 拉起来的 QQ.exe，不动你自己开的 QQ） */
  killStale: boolean;
  /** 启动后等 WebUI 就绪的超时（毫秒） */
  bootTimeoutMs: number;
}

export const DEFAULT_AUTO_START: AutoStartConfig = {
  enabled: true,
  shellDir: "",
  launchScript: "",
  killStale: true,
  bootTimeoutMs: 90_000,
};

export interface EnsureOutcome {
  /** 是否真的尝试过启动 NapCat（已经在跑 / 功能关着时为 false） */
  attempted: boolean;
  /** ok=true 表示「WebUI 现在应该可用」，调用方可以继续往下走（哪怕什么都没做） */
  ok: boolean;
  /** 本次是否是新启动起来的 */
  started: boolean;
  /** 给人看的结论（成功、超时原因、或为什么没启动） */
  detail: string;
  /** 实际使用的启动脚本 */
  script?: string;
}

export interface SwitchOutcome {
  ok: boolean;
  detail: string;
  backupDir?: string;
  /** 被清掉的路径（相对 qqDataDir 的展示形式） */
  cleared: string[];
  /** 被 taskkill 干掉的进程数 */
  killed: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resolveQqDataDir(config: SwitchAccountConfig): string {
  if (config.qqDataDir?.trim()) return config.qqDataDir.trim();
  const appData = process.env.APPDATA?.trim();
  return appData ? path.join(appData, "QQ") : "";
}

function resolveBackupDir(config: SwitchAccountConfig): string {
  if (config.backupDir?.trim()) return config.backupDir.trim();
  // 默认放到 shellDir 的上一级（NapCat 安装目录），跟前面手工换号时用的位置一致
  return path.dirname(config.shellDir.replace(/[\\/]+$/, ""));
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 测试/干跑开关：设了 PI_IM_RELAY_NO_PROCESS_CONTROL=1 之后，
 * 一切「杀进程 / 拉进程」都只记录不执行。
 *
 * 存在的理由很实际：这个模块会真的 `taskkill QQ.exe`。单测里只要有人不小心
 * 用默认配置跑一遍，开发者本地正在用的 NapCat 就没了。
 */
function processControlDisabled(): boolean {
  return process.env.PI_IM_RELAY_NO_PROCESS_CONTROL === "1";
}

/** 结束 NapCat 与它拉起来的 QQ 客户端。找不到进程不算失败。 */
function killNapcat(): number {
  if (processControlDisabled()) {
    log.warn("PI_IM_RELAY_NO_PROCESS_CONTROL=1：跳过 taskkill（干跑）");
    return 0;
  }
  let killed = 0;
  for (const image of ["QQ.exe", "NapCatWinBootMain.exe"]) {
    const r = spawnSync("taskkill", ["/f", "/im", image], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // 中英文输出都数一下：成功时每行带一个 PID，找不到进程时输出里没有 PID
    killed += (out.match(/PID/gi) ?? []).length;
    log.debug(`taskkill ${image}: ${out.trim().split("\n")[0] ?? "(无输出)"}`);
  }
  return killed;
}

/** 把一批路径挪进备份目录。返回实际清掉的展示名。 */
export function backupAndRemove(targets: Array<{ abs: string; label: string }>, backupRoot: string): { cleared: string[]; backupDir?: string } {
  const existing = targets.filter((t) => fs.existsSync(t.abs));
  if (existing.length === 0) return { cleared: [] };

  const backupDir = path.join(backupRoot, `_backup_switch_${stamp()}`);
  const cleared: string[] = [];
  for (const t of existing) {
    try {
      const dest = path.join(backupDir, t.label.replace(/[\\/]/g, "__"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(t.abs, dest, { recursive: true, force: true });
      fs.rmSync(t.abs, { recursive: true, force: true });
      cleared.push(t.label);
    } catch (error) {
      // 备份/删除失败就别删了，宁可这次换号失败也不要把用户的登录状态弄丢
      log.warn(`备份并清除 ${t.label} 失败，已跳过：${errorText(error)}`);
    }
  }
  return { cleared, backupDir: cleared.length ? backupDir : undefined };
}

/** 探测 TCP 端口是否有人监听。 */
export function probePort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/** 解析「自动启动」配置：shellDir 留空时跟随换号配置，再兜底到默认安装目录。 */
export function resolveAutoStart(config: AutoStartConfig | undefined, fallbackShellDir?: string): AutoStartConfig {
  const merged = { ...DEFAULT_AUTO_START, ...(config ?? {}) };
  return {
    ...merged,
    shellDir: merged.shellDir?.trim() || fallbackShellDir?.trim() || DEFAULT_SWITCH_ACCOUNT.shellDir,
  };
}

/** 算出要执行的启动脚本（可被 launchScript 覆盖成带日志/清进程的包装脚本）。 */
export function resolveLaunchScript(config: Pick<AutoStartConfig, "shellDir" | "launchScript">): string {
  const override = config.launchScript?.trim();
  if (override) return override;
  return path.join(config.shellDir, process.platform === "win32" ? "launcher.bat" : "launcher.sh");
}

/**
 * 查一遍 QQ.exe 的命令行，只找出「被 NapCat 拉起来的」那些。
 *
 * 为什么不能像换号那样无脑 `taskkill /f /im QQ.exe`：QQ.exe 同时是你日常聊天用的
 * 客户端。用户只是想扫码登录机器人，结果聊天窗口被脚本干掉，这个代价没人愿意付。
 * NapCat 的启动方式是 `NapCatWinBootMain.exe QQ.exe NapCatWinBootHook.dll …`，
 * 命令行里带着 napcat 关键字，据此就能区分开。
 *
 * 读不到命令行时（权限不足 / powershell 不可用）**宁可不杀**：返回 unknown 让调用方
 * 决定要不要提示用户。
 */
function findNapcatHostedQq(): { pids: number[]; unknown: number } {
  const out: { pids: number[]; unknown: number } = { pids: [], unknown: 0 };
  try {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20_000 },
    );
    if (r.status !== 0 || !r.stdout) return out;
    for (const line of r.stdout.split(/\r?\n/)) {
      const [pidText, ...rest] = line.trim().split("|");
      const pid = Number(pidText);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const cmdline = rest.join("|");
      if (!cmdline.trim()) out.unknown += 1;
      else if (/napcat/i.test(cmdline)) out.pids.push(pid);
    }
    return out;
  } catch (error) {
    log.debug(`枚举 QQ.exe 命令行失败：${errorText(error)}`);
    return out;
  }
}

/**
 * 清掉残留的 NapCat 宿主进程。
 *
 * 为什么需要：QQ 客户端把登录票据存在本地，残留的 QQ.exe 会带着旧会话起来，
 * NapCat 报「当前账号已登录，无法重复登录」然后永远卡在等二维码（README 里的坑一）。
 * 只杀 NapCat 自己拉起来的那一份，用户日常用的 QQ 不动。
 */
export function killStaleNapcatHosts(): { killed: number; skipped: number } {
  if (processControlDisabled()) {
    log.warn("PI_IM_RELAY_NO_PROCESS_CONTROL=1：跳过清理残留进程（干跑）");
    return { killed: 0, skipped: 0 };
  }

  // NapCatWinBootMain 一定是 NapCat 的，直接杀
  const boot = spawnSync("taskkill", ["/f", "/im", "NapCatWinBootMain.exe"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  let killed = (`${boot.stdout ?? ""}${boot.stderr ?? ""}`.match(/PID/gi) ?? []).length;

  const hosted = findNapcatHostedQq();
  for (const pid of hosted.pids) {
    const r = spawnSync("taskkill", ["/f", "/pid", String(pid)], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    });
    if (r.status === 0) killed += 1;
    else log.debug(`taskkill /pid ${pid} 失败：${(r.stderr ?? "").trim()}`);
  }
  if (hosted.unknown > 0) {
    log.warn(`有 ${hosted.unknown} 个 QQ.exe 读不到命令行，保守起见没有杀（可能是你自己开的 QQ）`);
  }
  log.info(`残留进程清理：杀掉 ${killed} 个（NapCat 宿主的 QQ.exe ${hosted.pids.length} 个）`);
  return { killed, skipped: hosted.unknown };
}

/** 重新拉起 NapCat（不带 UIN，走二维码登录）。 */
function relaunch(config: SwitchAccountConfig, launchScript?: string): { ok: boolean; detail: string } {
  return launchNapcat({ shellDir: config.shellDir, launchScript: launchScript ?? "" });
}

/** 执行启动脚本。干跑开关打开时只记录不执行（单测用）。 */
export function launchNapcat(config: Pick<AutoStartConfig, "shellDir" | "launchScript">): {
  ok: boolean;
  detail: string;
  script: string;
} {
  const shellDir = config.shellDir;
  const script = resolveLaunchScript(config);
  if (!shellDir || !fs.existsSync(shellDir)) {
    return { ok: false, detail: `NapCat 目录不存在：${shellDir || "(未配置)"}`, script };
  }
  if (!fs.existsSync(script)) return { ok: false, detail: `启动脚本不存在：${script}`, script };

  if (processControlDisabled()) {
    log.warn("PI_IM_RELAY_NO_PROCESS_CONTROL=1：跳过拉起 NapCat（干跑）");
    return { ok: true, detail: `干跑：本应拉起 ${script}`, script };
  }

  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", script], {
        cwd: shellDir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } else {
      const child = spawn("bash", [script], { cwd: shellDir, detached: true, stdio: "ignore" });
      child.unref();
    }
    return { ok: true, detail: `已拉起 ${script}`, script };
  } catch (error) {
    return { ok: false, detail: `拉起 NapCat 失败：${errorText(error)}`, script };
  }
}

/** 轮询等 WebUI 端口就绪。 */
export async function waitWebuiReady(
  host: string,
  port: number,
  timeoutMs: number,
  intervalMs = 1500,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (await probePort(host, port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * 「确保 NapCat 在跑」—— 登录链路的前置步骤。
 *
 * 返回语义（调用方只需要看两个字段）：
 *   - `ok=false` → 我们确实试着启动了但失败了，把 detail 直接当结论报给用户；
 *   - `attempted=true && ok=true` → 刚刚启动成功，NapCat 是新进程，旧凭证/旧二维码都失效了；
 *   - `attempted=false` → 本来就跑着（或功能关着），按老路走。
 */
export async function ensureNapcatRunning(
  config: AutoStartConfig,
  options: { host: string; port: number; reason?: string },
): Promise<EnsureOutcome> {
  const why = options.reason ?? "登录";
  log.info(`检查 NapCat 是否在运行（原因：${why}，WebUI ${options.host}:${options.port}）`);

  if (await probePort(options.host, options.port)) {
    const detail = "NapCat WebUI 已在运行，无需启动";
    log.info(detail);
    return { attempted: false, ok: true, started: false, detail };
  }

  if (!config.enabled) {
    const detail = "NapCat 没在运行，且自动启动已关闭（qq.autoStart.enabled = false）";
    log.info(detail);
    return { attempted: false, ok: true, started: false, detail };
  }

  const resolved = resolveAutoStart(config);
  const script = resolveLaunchScript(resolved);
  if (!fs.existsSync(resolved.shellDir)) {
    const detail = `NapCat 没在运行，也找不到它的安装目录：${resolved.shellDir}。请检查 qq.autoStart.shellDir（或 qq.switchAccount.shellDir）配置。`;
    log.warn(detail);
    return { attempted: true, ok: false, started: false, detail, script };
  }
  if (!fs.existsSync(script)) {
    const detail = `NapCat 没在运行，启动脚本也不存在：${script}。请检查 qq.autoStart.launchScript 配置。`;
    log.warn(detail);
    return { attempted: true, ok: false, started: false, detail, script };
  }

  if (resolved.killStale) killStaleNapcatHosts();

  const launched = launchNapcat(resolved);
  if (!launched.ok) {
    log.warn(launched.detail);
    return { attempted: true, ok: false, started: false, detail: launched.detail, script };
  }

  const ready = await waitWebuiReady(options.host, options.port, resolved.bootTimeoutMs);
  if (!ready) {
    const detail =
      `已尝试启动 NapCat（${script}），但 ${Math.round(resolved.bootTimeoutMs / 1000)}s 内 WebUI ` +
      `（${options.host}:${options.port}）仍未就绪。请手动启动一次看它报什么错` +
      "（常见原因：启动脚本需要管理员权限，或 NapCat 的 WebUI 端口被改过）。";
    log.warn(detail);
    return { attempted: true, ok: false, started: false, detail, script };
  }

  const detail = `NapCat 启动成功（${script}），WebUI 已就绪（${options.host}:${options.port}）`;
  log.info(detail);
  return { attempted: true, ok: true, started: true, detail, script };
}

/**
 * 换号：踢掉当前登录的 QQ，清掉它的登录票据与分区目录，重启 NapCat。
 * 调用方在成功之后应去 WebUI 取新二维码。
 */
export async function switchQqAccount(
  config: SwitchAccountConfig,
  options: { selfUin?: string; webuiHost: string; webuiPort: number },
): Promise<SwitchOutcome> {
  if (!config.enabled) {
    return { ok: false, detail: "换号功能已关闭（qq.switchAccount.enabled = false）", cleared: [], killed: 0 };
  }

  const qqDataDir = resolveQqDataDir(config);
  const backupRoot = resolveBackupDir(config);
  const uin = (options.selfUin ?? "").trim();

  log.info(`准备换号：踢掉 ${uin || "（未知账号）"} 并清理登录票据`);
  const killed = killNapcat();
  await sleep(Math.max(0, config.restartDelayMs));

  const targets: Array<{ abs: string; label: string }> = [];
  if (qqDataDir && fs.existsSync(qqDataDir)) {
    targets.push({ abs: path.join(qqDataDir, "auth", "login.enc"), label: "QQ/auth/login.enc" });
    if (uin) {
      for (const prefix of ["qqnt_", "qq-browser-"]) {
        targets.push({
          abs: path.join(qqDataDir, "Partitions", `${prefix}${uin}`),
          label: `QQ/Partitions/${prefix}${uin}`,
        });
      }
    } else {
      log.warn("不知道当前登录的 QQ 号，跳过分区目录清理（只清 login.enc）");
    }
  } else if (qqDataDir) {
    log.warn(`QQ 数据目录不存在，跳过票据清理：${qqDataDir}`);
  }

  const { cleared, backupDir } = backupAndRemove(targets, backupRoot || os.tmpdir());
  log.info(`换号清理完成：${cleared.length} 项${backupDir ? `，备份在 ${backupDir}` : "（没有需要清理的）"}`);

  const relaunched = relaunch(config);
  if (!relaunched.ok) {
    return { ok: false, detail: relaunched.detail, cleared, killed, backupDir };
  }

  // 等 WebUI 起来 —— 它起来才说明 NapCat 真的在跑，才能取二维码
  if (await waitWebuiReady(options.webuiHost, options.webuiPort, config.bootTimeoutMs)) {
    log.info(`NapCat WebUI 已就绪（${options.webuiHost}:${options.webuiPort}）`);
    return {
      ok: true,
      detail: `已踢掉旧账号并重启 NapCat（清理 ${cleared.length} 项，备份于 ${backupDir ?? "无"}）`,
      cleared,
      killed,
      backupDir,
    };
  }

  return {
    ok: false,
    detail: `NapCat 重启后 ${config.bootTimeoutMs / 1000}s 内 WebUI 仍未就绪，请检查 ${config.shellDir} 下的启动脚本`,
    cleared,
    killed,
    backupDir,
  };
}
