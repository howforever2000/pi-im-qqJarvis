/**
 * NapCat 进程与账号切换。
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

/** 重新拉起 NapCat（不带 UIN，走二维码登录）。 */
function relaunch(config: SwitchAccountConfig): { ok: boolean; detail: string } {
  const shellDir = config.shellDir;
  const launcher = path.join(shellDir, process.platform === "win32" ? "launcher.bat" : "launcher.sh");
  if (!fs.existsSync(shellDir)) return { ok: false, detail: `NapCat 目录不存在：${shellDir}` };
  if (!fs.existsSync(launcher)) return { ok: false, detail: `启动脚本不存在：${launcher}` };

  try {
    if (process.platform === "win32" && !processControlDisabled()) {
      const child = spawn("cmd.exe", ["/c", launcher], {
        cwd: shellDir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } else if (!processControlDisabled()) {
      const child = spawn("bash", [launcher], { cwd: shellDir, detached: true, stdio: "ignore" });
      child.unref();
    } else {
      log.warn("PI_IM_RELAY_NO_PROCESS_CONTROL=1：跳过拉起 NapCat（干跑）");
    }
    return { ok: true, detail: `已重新拉起 ${launcher}${processControlDisabled() ? "（干跑，未真的拉起）" : ""}` };
  } catch (error) {
    return { ok: false, detail: `拉起 NapCat 失败：${errorText(error)}` };
  }
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
  const deadline = Date.now() + config.bootTimeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(options.webuiHost, options.webuiPort)) {
      log.info(`NapCat WebUI 已就绪（${options.webuiHost}:${options.webuiPort}）`);
      return {
        ok: true,
        detail: `已踢掉旧账号并重启 NapCat（清理 ${cleared.length} 项，备份于 ${backupDir ?? "无"}）`,
        cleared,
        killed,
        backupDir,
      };
    }
    await sleep(1500);
  }

  return {
    ok: false,
    detail: `NapCat 重启后 ${config.bootTimeoutMs / 1000}s 内 WebUI 仍未就绪，请检查 ${config.shellDir} 下的启动脚本`,
    cleared,
    killed,
    backupDir,
  };
}
