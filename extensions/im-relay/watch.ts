/**
 * config.json 热加载：文件一变就自动 reload，不用再手敲 `/im reload`。
 *
 * 几个必须处理的现实细节（都是踩过的）：
 *
 * 1. **不能 watch 文件本身**。`saveConfig()` 是「写临时文件 + rename」的原子写，
 *    rename 之后原来的 inode 就没了 —— 监听文件的话只会在第一次改名后失联。
 *    所以监听**目录**，再按文件名过滤。
 *
 * 2. **一次保存会来好几个事件**（编辑器的 write + rename、Windows 的重复通知），
 *    所以要做去抖，并且**用内容哈希判断是否真的变了**，避免自己写自己触发。
 *
 * 3. **半截 JSON 不能热加载**。写到一半被读到时，宁可跳过这一次，也不能拿
 *    损坏的配置去拆通道（`loadConfig()` 会把损坏文件改名备份并回退默认值，
 *    那个副作用在热加载路径上太狠了）。
 *
 * 4. **热加载 = 重建通道**（和 `/im reload` 完全同一条路），不是只改几个字段。
 *    好处是行为一致、不会出现「配置变了但通道还是旧的」；代价是编辑一次配置
 *    QQ/微信 会有一个很短的断连重连。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { CONFIG_FILE } from "./config.ts";
import { createLogger, errorText } from "./log.ts";

const log = createLogger("watch");

/** 去抖窗口：编辑器一次保存通常会产生 2~4 个事件。 */
const DEBOUNCE_MS = 400;

/** 需要 host 提供的两个槽位（在这里声明，避免 watch.ts 反向依赖 host.ts 造成循环引用）。 */
export interface WatchHost {
  configWatcher?: fs.FSWatcher;
  configWatchTimer?: NodeJS.Timeout;
  /** 上一次「已知」的 config.json 内容哈希 */
  configWatchHash?: string;
}

function fileHash(file: string): string | undefined {
  try {
    return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

/** 只做语法校验：不要把半截 JSON 交给 loadConfig()，那会把文件改名备份并回退默认值。 */
function plausibleJson(file: string): boolean {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * 开始监听配置变化。`reload` 由 host.ts 注入（通常就是 `reloadHost`），
 * 用注入而不是 import 是为了不让 watch.ts ↔ host.ts 互相引用。
 */
export function startConfigWatch<H extends WatchHost>(
  host: H,
  reload: (host: H) => Promise<void>,
): void {
  stopConfigWatch(host);

  const dir = path.dirname(CONFIG_FILE);
  const name = path.basename(CONFIG_FILE);
  host.configWatchHash = fileHash(CONFIG_FILE);

  const fire = (): void => {
    if (host.configWatchTimer) clearTimeout(host.configWatchTimer);
    const timer = setTimeout(() => {
      host.configWatchTimer = undefined;
      void checkAndReload(host, reload);
    }, DEBOUNCE_MS);
    timer.unref?.();
    host.configWatchTimer = timer;
  };

  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      // filename 在某些平台/场景是 null（信息不足），这时只能保守地走一遍检查
      if (filename && String(filename) !== name) return;
      fire();
    });
    watcher.on("error", (error) => log.warn(`配置监听出错：${errorText(error)}`));
    host.configWatcher = watcher;
  } catch (error) {
    // 监听失败不算致命：退化成「只能靠 /im reload」
    log.warn(`无法监听配置文件，热加载不可用（仍然可以用 /im reload）：${errorText(error)}`);
  }
}

async function checkAndReload<H extends WatchHost>(
  host: H,
  reload: (host: H) => Promise<void>,
): Promise<void> {
  const next = fileHash(CONFIG_FILE);
  // 文件不见了 / 内容没变 —— 都不该重载
  if (!next || next === host.configWatchHash) return;

  if (!plausibleJson(CONFIG_FILE)) {
    log.warn("config.json 当前不是合法 JSON，跳过本次热加载（等下次写入）");
    return;
  }

  // 先记基线再重载：重载过程中若再收到事件，不会重复触发
  host.configWatchHash = next;
  log.info("检测到 config.json 变化，自动热加载（等价于 /im reload）");
  try {
    await reload(host);
    log.info("热加载完成");
  } catch (error) {
    log.warn(`热加载失败：${errorText(error)}`);
  }
}

/** 我们自己写了配置之后调用：把基线对齐到当前文件，避免自己触发自己。 */
export function syncConfigWatch(host: WatchHost): void {
  host.configWatchHash = fileHash(CONFIG_FILE);
}

export function stopConfigWatch(host: WatchHost): void {
  if (host.configWatchTimer) {
    clearTimeout(host.configWatchTimer);
    host.configWatchTimer = undefined;
  }
  if (host.configWatcher) {
    try {
      host.configWatcher.close();
    } catch {
      /* ignore */
    }
    host.configWatcher = undefined;
  }
}
