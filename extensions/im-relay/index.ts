/**
 * pi-im-relay —— 用 QQ / 微信驱动你本机的 pi agent。
 *
 * 架构：
 *
 *   QQ(NapCat/OneBot11, 本机 WS) ─┐
 *                                 ├─► Channel ─► Router ─► pi.sendUserMessage()
 *   微信(iLink, 出站长轮询)      ─┘                  ▲              │
 *                                                    └─ agent_settled ┘ 回传
 *
 * 网络：两条通道都是**出站**连接，不监听端口、不需要公网 IP / 内网穿透 / 服务器。
 *
 * 本文件的职责边界（重要）：
 *   - 这里只做「每会话」的事：登记会话、把事件转给 host、注册命令。
 *   - **通道是进程级唯一的**，由 host.ts 持有。pi-web 桌面端一个进程里可以开很多会话，
 *     如果每个会话各建一套通道，就会出现 N 条 QQ 连接 / N 个 iLink 长轮询，
 *     导致同一条消息被回复 N 次、游标互相覆盖、状态文件并发覆盖。
 *   - factory 阶段只注册，不碰网络：factory 也可能在根本不启动会话的调用里被执行
 *     （例如 pi --list-models）。
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, DATA_DIR, LOG_FILE } from "./config.ts";
import { closeLog, createLogger, errorText } from "./log.ts";
import { renderPdf, renderScreenshot } from "./pdf.ts";
import { formatChatLines, readRecentChat } from "./chatlog.ts";
import { resetMemoryCache } from "./memory.ts";
import {
  ensureHost,
  getHost,
  registerSession,
  unregisterSession,
  touchSession,
  setActive,
  activeBinding,
  pushStatus,
  reloadHost,
  runDigestNow,
  saveHostConfig,
  scheduleHostShutdown,
  cancelHostShutdown,
  shutdownHost,
  showQrAgain,
  STATUS_KEY,
  QR_WIDGET_KEY,
  type RelayHost,
} from "./host.ts";
import { matchLocalTrigger } from "./triggers.ts";

const log = createLogger("relay");

/**
 * pi-web 的扩展命令上下文里 newSession / switchSession 固定返回 cancelled，
 * 所以这两个命令在 Web 界面下必须给出可操作的替代方案，而不是一句“被取消”。
 */
const UNSUPPORTED_SESSION_HINT = [
  "当前界面不支持从扩展里新建/切换会话。",
  "",
  "如果你在用 pi-web：请直接用界面上的会话列表切换，或点「新建会话」按钮，",
  "然后回到聊天窗口继续发消息即可（通道不需要重新登录）。",
].join("\n");

interface ResumeEntry {
  index: number;
  path: string;
  name: string;
  mtime: number;
  messageCount: number;
  /** 是否只扫了文件开头（超大会话的条数为下界） */
  partial: boolean;
}

export default function imRelay(pi: ExtensionAPI): void {
  let sessionId: string | undefined;
  let latestCtx: ExtensionContext | undefined;
  let resumeSnapshot: { at: number; entries: ResumeEntry[] } | undefined;

  /** host 是进程级的；本会话只是它的一个参与者。 */
  const host = (): RelayHost | undefined => getHost();

  function touch(): void {
    const h = host();
    if (h && sessionId) touchSession(h, sessionId);
  }

  /* ------------------------- 生命周期 ------------------------- */

  /**
   * 任何 pi 事件都顺便确认「当前会话已经登记在 host 上」。
   *
   * 为什么必须要有这个：`session_start` 不是每次都会来 ——
   * pi-web 浏览器端重连 / 扩展是在会话已经存在时才加载的 / 热重载的边界情况下，
   * 都可能出现「会话活着但从未登记」，而 `session_shutdown` 又可能已经把旧登记注销了。
   * 结果是 host.sessions 为空，IM 消息注入时报「没有活跃会话，无法接收 IM 消息」，
   * 用户手机上只会收到一句失败提示。（这是实测撞到的真 bug，不是假想。）
   */
  const ensureSession = (ctx: ExtensionContext): RelayHost | undefined => {
    const h = host();
    if (!h) return undefined;
    latestCtx = ctx;
    let id: string;
    try {
      id = ctx.sessionManager.getSessionId();
    } catch {
      return h;
    }
    sessionId = id;
    if (h.sessions.has(id)) return h;

    cancelHostShutdown(h);
    registerSession(h, { id, pi, ctx, updatedAt: Date.now(), label: describeLabel(ctx, pi) });
    log.info(`补登记会话 ${id.slice(0, 8)}（它没在 host 里，多半是 UI 重连没触发 session_start）`);
    return h;
  };

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    sessionId = ctx.sessionManager.getSessionId();

    let h: RelayHost;
    try {
      h = await ensureHost(pi, ctx);
    } catch (error) {
      log.error(`初始化失败: ${errorText(error)}`);
      ctx.ui?.notify(`pi-im-relay 初始化失败：${errorText(error)}（/im log 查看日志）`, "error");
      return;
    }

    const isFirstSession = h.sessions.size === 0;
    cancelHostShutdown(h);
    // 新会话（含新建 / 恢复 / fork / 重载）：让下一条消息重新读一遍聊天记录，
    // 这样长会话被压缩之后也能接上前文。
    resetMemoryCache();
    h.router.markMemoryStale();
    registerSession(h, {
      id: sessionId,
      pi,
      ctx,
      updatedAt: Date.now(),
      label: describeLabel(ctx, pi),
    });

    // 只有第一个会话负责「吵」用户，避免多会话时通知刷屏
    if (isFirstSession) {
      if (!h.lock.ok) {
        ctx.ui?.notify(
          [
            "pi-im-relay：另一个 pi 进程正在使用 IM 通道，本进程不重复连接。",
            `${h.lock.holder.pid} 号进程（启动于 ${h.lock.holder.startedAt}）可能是 pi-web 桌面端或另一个终端。`,
            "通道是全局唯一资源，重复连接会导致消息被回复多次。想看状态用 /im status。",
          ].join("\n"),
          "warning",
        );
      } else {
        const summary = h.router
          .statusesSnapshot()
          .map((s) => `${s.name}=${s.state}`)
          .join(" ");
        const created = !fs.existsSync(CONFIG_FILE);
        if (created) {
          ctx.ui?.notify(`pi-im-relay 已创建默认配置：${CONFIG_FILE}\n填好白名单后执行 /im reload。`, "info");
        }
        ctx.ui?.notify(`pi-im-relay 已启动：${summary}（/im status 查看详情）`, "info");
        if (!h.config.channels.qq.enabled && !h.config.channels.wechat.enabled) {
          ctx.ui?.notify("IM 通道都未启用，编辑 config.json 后执行 /im reload。", "warning");
        }
      }
    }
    log.info(`会话启动 ${sessionId.slice(0, 8)}（进程内会话数 ${h.sessions.size}）`);
  });

  pi.on("session_shutdown", async () => {
    const h = host();
    if (!h || !sessionId) return;
    const id = sessionId;
    unregisterSession(h, id);
    if (h.sessions.size === 0) {
      // 桌面端会回收空闲会话，所以不要立刻拆通道 —— 给一段时间等新会话接上，
      // 否则每次切会话都要重连 NapCat、重开 iLink 长轮询。
      scheduleHostShutdown(h, 30_000, () => {
        log.info("最后一次会话已关闭超过宽限期，关闭 IM 通道");
        void h.router.stop().catch(() => undefined);
        shutdownHost(h);
        closeLog();
      });
    }
  });

  /* ------------------------- pi → IM 回传 ------------------------- */

  pi.on("message_end", async (event, ctx) => {
    ensureSession(ctx);
    if (event.message.role !== "assistant") return;
    const text = extractText(event.message.content);
    const stopReason = (event.message as { stopReason?: string }).stopReason;
    host()?.router.onAssistantText(text, stopReason);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    ensureSession(ctx);
    host()?.router.onToolStart(event.toolName, event.args);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    ensureSession(ctx);
    host()?.router.onSettled();
  });

  /**
   * 端里敲的 prompt 也算「这个会话在用」——IM 消息应该跟着走。
   * 这正好实现了「我在哪个窗口干活，手机消息就进哪个」。
   */
  /**
   * 对话框里的确定性入口：输「微信登录」直接出码，不经过模型。
   *
   * 用 handled 而不是让模型调工具 —— 这样零 token、零延迟，也不会因为模型
   * 不配合而失败。二维码会以 custom message 的形式直接出现在对话里。
   */
  pi.on("input", async (event, ctx) => {
    ensureSession(ctx);
    touch();
    if (event.source === "interactive") host()?.router.mirrorLocalInput(event.text);
    // extension 来源是本扩展自己注入的 IM 消息，不能让它反过来触发本机动作
    if (event.source === "extension") return { action: "continue" };
    if (event.images && event.images.length > 0) return { action: "continue" };

    const trigger = matchLocalTrigger(event.text);
    if (!trigger) return { action: "continue" };
    const h = host();
    if (!h) return { action: "continue" };

    if (trigger.kind === "status") {
      ctx.ui?.notify(buildStatusText(h), "info");
      return { action: "handled" };
    }

    const result = await startLogin(h, trigger.channel, (message, level) => ctx.ui?.notify(message, level));
    if (!result.ok) ctx.ui?.notify(`登录未发起：${result.error}`, "warning");
    return { action: "handled" };
  });

  /* ------------------- 登录发起（命令 / 工具 / 一句话 共用） ------------------- */

  /**
   * 统一的登录发起入口。
   *
   * `/im login`、`im_relay_login` 工具、以及对话框里直接输「微信登录」都走这里，
   * 避免三处逻辑漂移 —— “重复出码”那个 bug 就是分散实现导致的。
   */
  async function startLogin(
    h: RelayHost,
    which: "qq" | "wechat",
    notify: (message: string, level: "info" | "warning" | "error") => void,
  ): Promise<{ ok: true; reused: boolean } | { ok: false; error: string }> {
    const channel = h.router.channel(which);
    if (!channel) return { ok: false, error: `未知通道：${which}` };
    if (!h.config.channels[which]?.enabled) {
      return {
        ok: false,
        error: `${channel.name} 通道在配置里被禁用了（把 config.json 里 channels.${which}.enabled 改成 true，再执行 /im reload）`,
      };
    }
    if (!channel.login) {
      return { ok: false, error: `${channel.name} 通道不支持从这里发起登录` };
    }
    if (channel.status().state === "online") {
      return { ok: false, error: `${channel.name} 已经是登录状态，不需要重新登录` };
    }

    const reused = (channel as { loginActive?: () => boolean }).loginActive?.() ?? false;
    try {
      // beginLogin 返回时二维码一定已经投递出去，所以紧接着的提示是准确的
      if (channel.beginLogin) await channel.beginLogin();
      else void channel.login().catch(() => undefined);
    } catch (error) {
      log.warn(`${channel.name} 登录失败: ${errorText(error)}`);
      return { ok: false, error: errorText(error) };
    }

    notify(
      reused
        ? `${channel.name} 已有一张二维码在等扫码，已重新发给你（没有重复出码）。`
        : `${channel.name} 登录二维码已发送，请用手机扫码确认。`,
      "info",
    );

    // 扫码确认可能要等几分钟，不能阻塞当前这一轮
    void channel
      .waitForLogin?.()
      .then(() => {
        const state = channel.status().state;
        notify(
          state === "online" ? `${channel.name} 登录成功 ✅` : `${channel.name} 登录流程结束（当前：${state}）`,
          state === "online" ? "info" : "warning",
        );
      })
      .catch((error) => notify(`${channel.name} 登录失败：${errorText(error)}`, "error"));

    return { ok: true, reused };
  }

  /* ------------------------- 给 agent 用的工具 ------------------------- */

  /**
   * 把「登录」做成工具，是为了让入口不只存在于命令里：
   * 用户直接说「登录微信」比记住 `/im login wechat` 自然得多。
   * 这两个工具同时给了 agent 自查能力（“IM 连上了吗”）。
   */
  pi.registerTool({
    name: "im_relay_login",
    label: "登录 IM 通道",
    description:
      "发起 QQ 或 微信 的登录绑定流程。两个通道都会生成一张二维码图片并自动发到当前对话里，用户用手机扫码确认即可（QQ 二维码由 NapCat WebUI 提供，扩展自动投递）。当用户说「登录微信/绑定微信/连上微信/登录QQ/QQ登录」，或 IM 通道处于 needs-login 状态时调用。",
    promptSnippet: "发起 QQ / 微信登录绑定（二维码会自动发到对话里）",
    promptGuidelines: [
      "调用 im_relay_login 后，不要再重复把二维码链接或说明贴一遍：二维码图片已经由扩展自动发到对话里了。",
    ],
    parameters: Type.Object({
      channel: Type.Union([Type.Literal("wechat"), Type.Literal("qq")], {
        description: "要登录哪个通道：wechat = 微信（扫码绑定），qq = QQ（扫码登录 NapCat）",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
      const h = host();
      if (!h) return text("pi-im-relay 未启动（本会话里扩展没有加载）。");
      // 用调用方的 ctx 通知，而不是“当前活跃会话”——会话多开时可能不是同一个
      const notify = (message: string, level: "info" | "warning" | "error") => ctx?.ui?.notify(message, level);
      const result = await startLogin(h, params.channel, notify);
      if (!result.ok) return text(`发起登录失败：${result.error}`);
      return text(
        params.channel === "wechat"
          ? "微信登录二维码已经发到对话里了。请用手机微信扫它并在手机上确认；若要求输入数字配对码，界面会弹输入框。凭据约 24 小时后过期。"
          : "QQ 登录二维码已经发到对话里了。请用手机 QQ 扫它并在手机上确认，随后扩展会自动连上 NapCat 的 OneBot11 服务。二维码约 2 分钟过期，过期后重新说一次「QQ登录」就会重新出码。",
      );
    },
  });

  pi.registerTool({
    name: "im_relay_status",
    label: "查询 IM 通道状态",
    description:
      "查看 QQ / 微信 通道的连接状态、当前活跃会话、待处理队列与进程锁情况。当用户问「IM 连上了吗/机器人状态怎么样/为什么手机没反应」时调用。",
    promptSnippet: "查询 QQ / 微信 通道的连接状态与队列情况",
    parameters: Type.Object({}),
    async execute() {
      const h = host();
      if (!h) {
        return { content: [{ type: "text" as const, text: "pi-im-relay 未启动（本会话里扩展没有加载）。" }], details: {} };
      }
      return { content: [{ type: "text" as const, text: buildStatusText(h) }], details: {} };
    },
  });

  /**
   * 把本机文件传回 IM —— 「agent 产出的产物直接丢回聊天窗口」的入口。
   * 目前只有 QQ(OneBot11) 实现了上传（upload_private_file / upload_group_file）；
   * 微信 iLink 侧只做了媒体下载，所以那边会明确报「不支持」，而不是静默失败。
   */
  pi.registerTool({
    name: "im_relay_send_file",
    label: "把本机文件发回 IM",
    description:
      "把本机上的一个文件作为附件发回当前正在对话的 IM 会话（QQ 私聊或群聊）。只能发给刚刚给本机发过消息的那个会话，无法发给任意第三方。QQ 通道需要 NapCat 已连接；微信通道目前不支持发送文件（只做了纯文本出站），会返回明确错误。当用户说「把文件发给我」「发到我手机」「把这个 pdf 发过来」时调用。",
    promptSnippet: "把本机文件作为附件发回当前 IM 会话",
    promptGuidelines: [
      "im_relay_send_file 只能发回最近跟本机说过话的那个 IM 会话；失败时把错误原文告诉用户，不要反复重试。",
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: "要发送的本机文件绝对路径" }),
      channel: Type.Optional(
        Type.Union([Type.Literal("qq"), Type.Literal("wechat")], {
          description: "发到哪个通道，默认回给刚跟你说话的那个会话",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
      const h = host();
      if (!h) return text("pi-im-relay 未启动（本会话里扩展没有加载）。");

      const filePath = path.resolve(params.filePath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return text(`文件不存在或无法访问：${filePath}`);
      }
      if (!stat.isFile()) return text(`不是普通文件：${filePath}`);

      const target = h.router.replyTarget(params.channel);
      if (!target) {
        return text(
          "没有可回复的 IM 会话：请先让接收方从 QQ / 微信 发一条消息过来，我才能把文件回过去。" +
            "（通道只允许回复最近说过话的会话，没有主动向任意账号推送的入口）",
        );
      }

      const channel = h.router.channel(target.channel);
      if (!channel) return text(`通道 ${target.channel} 未注册。`);
      if (!channel.sendFile) {
        return text(
          `${channel.name} 通道不支持发送文件 —— 目前只有 QQ(OneBot11) 实现了上传，` +
            `微信 iLink 侧只做了媒体的下载解密。文件在本机：${filePath}`,
        );
      }

      try {
        await channel.sendFile(target, filePath);
      } catch (error) {
        return text(`发送失败：${errorText(error)}（文件：${filePath}）`);
      }
      log.info(`已发送文件 ${filePath}（${formatBytes(stat.size)}）→ ${target.label}`);
      return text(`已把 ${path.basename(filePath)}（${formatBytes(stat.size)}）发到 ${target.label}。`);
    },
  });

  pi.registerTool({
    name: "im_relay_send_pdf",
    label: "把长文渲染成 PDF 并发回 IM",
    description:
      "把一段 Markdown（或一个已有的 .md/.txt 文件）渲染成排版好的 PDF，作为附件发回当前 IM 会话。" +
      "用在「结论很长、或者含表格，在手机聊天窗口里没法看」的场合：聊天里只留一段简短说明，正文走 PDF。" +
      "支持标题、段落、粗斜体、行内代码、围栏代码块、表格、有序/无序列表、引用块。" +
      "只能发回最近跟本机说过话的那个 IM 会话；微信通道不支持发文件会明确报错。",
    promptSnippet: "把长文/Markdown 渲染成 PDF 并作为附件发回当前 IM 会话",
    promptGuidelines: [
      "多段的结构化结论（改造报告、排查结论、方案对比）优先用 im_relay_send_pdf 发 PDF，不要在聊天里堆长文；一两句话能说清的直接回文字。",
      "渲染失败时把错误原文告诉用户，并说明正文已在本机哪个文件里，不要静默吞掉。",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "文档标题，会显示在 PDF 首页" }),
      markdown: Type.Optional(Type.String({ description: "Markdown 正文；与 filePath 二选一" })),
      filePath: Type.Optional(
        Type.String({ description: "已有的 .md / .txt 文件绝对路径；与 markdown 二选一" }),
      ),
      fileName: Type.Optional(Type.String({ description: "PDF 文件名（不含扩展名），默认用标题" })),
      channel: Type.Optional(
        Type.Union([Type.Literal("qq"), Type.Literal("wechat")], {
          description: "发到哪个通道，默认回给刚跟你说话的那个会话",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
      const h = host();
      if (!h) return text("pi-im-relay 未启动（本会话里扩展没有加载）。");
      if (!h.config.pdf.enabled) return text("PDF 出站在配置里被关闭了（config.json 的 pdf.enabled）。");

      let markdown = params.markdown ?? "";
      if (!markdown && params.filePath) {
        try {
          markdown = fs.readFileSync(path.resolve(params.filePath), "utf8");
        } catch (error) {
          return text(`读不到源文件：${errorText(error)}`);
        }
      }
      if (!markdown.trim()) return text("正文是空的：markdown 与 filePath 至少要给一个。");

      const target = h.router.replyTarget(params.channel);
      if (!target) {
        return text(
          "没有可回复的 IM 会话：先让对方从 QQ / 微信 发一条消息过来，我才能把文件回过去。",
        );
      }
      const channel = h.router.channel(target.channel);
      if (!channel) return text(`通道 ${target.channel} 未注册。`);
      if (!channel.sendFile) {
        return text(`${channel.name} 通道不支持发文件（微信侧只做了出站文本）。`);
      }

      const safeName = (params.fileName ?? params.title ?? "report").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
      const workDir = path.join(DATA_DIR, "tmp", "pdf");
      const output = path.join(workDir, `${safeName}.pdf`);

      try {
        renderPdf(markdown, { title: params.title, output, workDir, browser: h.config.pdf.browser });
      } catch (error) {
        return text(`PDF 渲染失败：${errorText(error)}`);
      }

      try {
        await channel.sendFile(target, output);
      } catch (error) {
        return text(`PDF 已生成（${output}），但发送失败：${errorText(error)}`);
      }
      const size = fs.statSync(output).size;
      log.info(`已发送 PDF ${output}（${formatBytes(size)}）→ ${target.label}`);
      return text(`已把《${params.title}》（${formatBytes(size)}）作为 PDF 发到 ${target.label}。本机路径：${output}`);
    },
  });

  /* ------------------------- QQ 账号经营 ------------------------- */

  pi.registerTool({
    name: "im_relay_qzone_post",
    label: "发 QQ 空间说说",
    description:
      "在机器人自己的 QQ 空间发布一条说说，可选配图。可见范围默认取配置里的 qzone.digest.ugcRight" +
      "（默认 16 + 号主，即「部分好友可见 → 仅号主」）。图文类说说请先用 im_relay_render_card 做图。",
    promptSnippet: "在自己的 QQ 空间发一条说说",
    promptGuidelines: [
      "发空间内容前先确认可见范围符合隐私约定；默认只对号主可见，不要未经允许改成公开。",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "说说正文" }),
      images: Type.Optional(
        Type.Array(Type.String(), { description: "图片路径数组（本机绝对路径），最多 9 张" }),
      ),
      ugcRight: Type.Optional(
        Type.Number({ description: "可见范围：1 所有人 / 4 好友 / 16 部分好友 / 64 仅自己；默认取配置" }),
      ),
      targetUins: Type.Optional(
        Type.Array(Type.String(), { description: "ugcRight 为 16 时可见的好友号；留空用配置里的号主" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
      const h = host();
      if (!h) return text("pi-im-relay 未启动。");
      // api 是 QqChannel 的方法，内部要用 this.client —— 必须先绑回 channel 再调用。
      // 直接摘下来裸调用会得到 "Cannot read properties of undefined (reading 'client')"。
      const channel = h.router.channel("qq");
      const call = channel?.api?.bind(channel);
      if (!call) return text("QQ 通道没有协议接口（NapCat 未连接），发不了空间。");

      const digest = h.config.qzone.digest;
      const ugcRight = params.ugcRight ?? digest.ugcRight;
      const targets =
        params.targetUins ?? (digest.targetUins.length ? digest.targetUins : h.config.channels.qq.allowUsers);

      const images: string[] = [];
      for (const p of (params.images ?? []).slice(0, 9)) {
        const abs = path.resolve(p);
        if (!fs.existsSync(abs)) return text(`图片不存在：${abs}`);
        images.push(`file:///${abs.replace(/\\/g, "/").replace(/^\/+/, "")}`);
      }

      try {
        const res = await call<{ tid?: string }>("send_qzone_msg", {
          content: params.content,
          ...(images.length ? { images } : {}),
          ugc_right: ugcRight,
          ...(ugcRight === 16 || ugcRight === 128 ? { target_uins: targets } : {}),
        });
        const vis = ugcRight === 16 ? `部分好友可见（${targets.join("、")}）` : `ugc_right=${ugcRight}`;
        log.info(`已发布空间说说 tid=${res?.tid ?? "?"}（${vis}）`);
        return text(`已发布到 QQ 空间。tid：${res?.tid ?? "(未返回)"}，可见范围：${vis}`);
      } catch (error) {
        return text(`发说说失败：${errorText(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "im_relay_render_card",
    label: "把 HTML 渲染成卡片图",
    description:
      "把一段 HTML/CSS 渲染成 PNG 图片（用浏览器无头截图）。用于给空间说说配图：" +
      "自己写 HTML 排版比描述给文生图模型更可控 —— 颜色、字号、间距都是精确值。" +
      "建议尺寸：竖向卡片 1080×1350，方图 1080×1080。",
    promptSnippet: "用 HTML+CSS 渲染一张排版卡片图（用于空间配图）",
    promptGuidelines: [
      "做卡片图时把文字写大、信息量压少 —— 缩到手机上看要一眼能读。",
      "配色建议用深色底 + 一个亮色重点，避免大面积浅色。",
    ],
    parameters: Type.Object({
      html: Type.String({ description: "完整 HTML（内联样式）" }),
      width: Type.Number({ description: "像素宽，如 1080" }),
      height: Type.Number({ description: "像素高，如 1350" }),
      fileName: Type.Optional(Type.String({ description: "输出文件名（不含路径与扩展名）" })),
    }),
    async execute(_toolCallId, params) {
      const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
      const h = host();
      const safe = (params.fileName ?? `card-${Date.now()}`).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
      const workDir = path.join(DATA_DIR, "tmp", "cards");
      fs.mkdirSync(workDir, { recursive: true });
      const htmlPath = path.join(workDir, `${safe}.html`);
      const pngPath = path.join(workDir, `${safe}.png`);
      fs.writeFileSync(htmlPath, params.html, "utf8");
      try {
        renderScreenshot(htmlPath, pngPath, params.width, params.height, h?.config.pdf.browser ?? "");
      } catch (error) {
        return text(`渲染卡片失败：${errorText(error)}`);
      }
      const size = fs.statSync(pngPath).size;
      log.info(`已渲染卡片 ${pngPath}（${params.width}×${params.height}, ${formatBytes(size)}）`);
      return text(`卡片已生成：${pngPath}（${params.width}×${params.height}）`);
    },
  });

  pi.registerTool({
    name: "im_relay_recent_chat",
    label: "读最近的 IM 聊天记录",
    description:
      "读回最近的 QQ 聊天记录（含双向，「我」指机器人）。用于写日志/总结时回看发生了什么 —— " +
      "这是唯一可靠的素材来源，不要凭记忆编造。默认读号主私聊。",
    promptSnippet: "读最近的 QQ 聊天记录作为素材",
    parameters: Type.Object({
      count: Type.Optional(Type.Number({ description: "条数，默认 60" })),
      peer: Type.Optional(Type.String({ description: "对方 QQ 号；留空用白名单里的号主" })),
      todayOnly: Type.Optional(Type.Boolean({ description: "只保留今天的内容，默认 false" })),
    }),
    async execute(_toolCallId, params) {
      const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
      const h = host();
      if (!h) return text("pi-im-relay 未启动。");
      const channel = h.router.channel("qq");
      const call = channel?.api;
      if (!call) return text("QQ 通道没有协议接口，读不了记录。");
      const peer = params.peer?.trim() || h.config.channels.qq.allowUsers[0];
      if (!peer) return text("不知道读谁的：白名单为空，也没指定 peer。");

      const res = await readRecentChat(
        (action, p) => call.call(channel, action, p),
        { kind: "private", id: peer, count: params.count ?? 60 },
      );
      if (res.error) return text(`读聊天记录失败：${res.error}`);

      let lines = res.lines;
      if (params.todayOnly) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        lines = lines.filter((l) => l.at >= start.getTime());
      }
      if (!lines.length) return text("没有记录（或今天还没有对话）。");
      return text(`共 ${lines.length} 条（对端 ${peer}）：\n\n${formatChatLines(lines, 8000)}`);
    },
  });

  /* ------------------------- 控制命令 ------------------------- */

  /* ------------------------- 控制命令 ------------------------- */

  pi.registerCommand("im", {
    description: "IM relay：status / login / qr / attach / on / off / reload / test",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const h = host();
      const [sub = "status", ...rest] = args.trim().split(/\s+/);
      switch (sub) {
        case "status":
        case "":
          ctx.ui?.notify(h ? buildStatusText(h) : "IM relay 未启动", "info");
          return;
        case "attach": {
          if (!h || !sessionId) {
            ctx.ui?.notify("IM relay 未启动", "warning");
            return;
          }
          setActive(h, sessionId, true);
          ctx.ui?.notify("已把 IM 消息固定到当前会话。此后手机消息都进这里（/im detach 取消）。", "info");
          return;
        }
        case "detach": {
          if (!h) return;
          h.pinned = false;
          const next = [...h.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
          if (next) setActive(h, next.id);
          ctx.ui?.notify("已取消固定，IM 消息回到「最近活动的会话」。", "info");
          return;
        }
        case "sessions": {
          if (!h) return;
          const active = activeBinding(h)?.id;
          const lines = [`打开中的会话 ${h.sessions.size} 个：`, ""];
          for (const s of [...h.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
            const mark = s.id === active ? " ← IM 消息进这里" : "";
            lines.push(`${s.id.slice(0, 8)}  ${s.label}${mark}`);
          }
          lines.push("");
          lines.push("用 /im attach 把 IM 消息固定到当前会话。");
          ctx.ui?.notify(lines.join("\n"), "info");
          return;
        }
        case "qr": {
          if (h && showQrAgain(h)) {
            ctx.ui?.notify("已重新展示登录二维码。", "info");
            return;
          }
          ctx.ui?.notify("当前没有待扫描的二维码。先执行 /im login qq 或 /im login wechat。", "warning");
          return;
        }
        case "qr-hide":
          ctx.ui?.setWidget(QR_WIDGET_KEY, undefined);
          return;
        case "login": {
          const which = (rest[0] ?? "wechat") as "qq" | "wechat";
          if (!h) {
            ctx.ui?.notify("IM relay 未启动", "warning");
            return;
          }
          const channel = h.router.channel(which);
          if (!channel?.login) {
            ctx.ui?.notify(`${which} 不需要在这里登录`, "warning");
            return;
          }
          const result = await startLogin(h, which, (message, level) => ctx.ui?.notify(message, level));
          if (!result.ok) ctx.ui?.notify(`登录未发起：${result.error}`, "warning");
          return;
        }
        case "on":
        case "off": {
          if (!h) return;
          h.config.enabled = sub === "on";
          saveHostConfig(h);
          ctx.ui?.notify(`IM relay 已${sub === "on" ? "启用" : "停用"}（重启 pi 后通道才会真正启停）`, "info");
          return;
        }
        case "reload": {
          if (!h) return;
          await reloadHost(h);
          ctx.ui?.notify("配置已重新加载。", "info");
          return;
        }
        case "test": {
          const online = h?.router.statusesSnapshot().filter((s) => s.state === "online") ?? [];
          ctx.ui?.notify(
            online.length ? `${online.map((s) => s.name).join("、")} 在线` : "没有在线通道",
            online.length ? "info" : "warning",
          );
          return;
        }
        case "log":
          ctx.ui?.notify(`日志：${LOG_FILE}`, "info");
          return;
        case "digest": {
          if (!h) {
            ctx.ui?.notify("IM relay 未启动", "warning");
            return;
          }
          ctx.ui?.notify("正在跑一次每日空间总结 …", "info");
          const result = await runDigestNow(h);
          ctx.ui?.notify(result, "info");
          return;
        }
        case "dir":
          ctx.ui?.notify(`数据目录：${DATA_DIR}`, "info");
          return;
        default:
          ctx.ui?.notify(
            `未知子命令：${sub}。可用：status / sessions / attach / detach / login / qr / qr-hide / on / off / reload / digest / test / log / dir`,
            "warning",
          );
      }
    },
  });

  /** 供 router 的 /new 调用：真正的新建会话。 */
  pi.registerCommand("im-new", {
    description: "IM relay 内部命令：新建会话",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      const h = host();
      try {
        await ctx.waitForIdle();
        const result = await ctx.newSession();
        if (result.cancelled) {
          await h?.router.completeControl(UNSUPPORTED_SESSION_HINT);
          return;
        }
        await h?.router.completeControl("✅ 已开始一个全新的 pi 会话。");
      } catch (error) {
        await h?.router.completeControl(`新建会话失败：${errorText(error)}`);
      }
    },
  });

  pi.registerCommand("im-resume", {
    description: "IM relay 内部命令：列出或切换会话",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      try {
        await handleResume(args.trim(), ctx, host());
      } catch (error) {
        await host()?.router.completeControl(`切换会话失败：${errorText(error)}`);
      }
    },
  });

  /* ------------------------- /resume 实现 ------------------------- */

  async function handleResume(args: string, ctx: ExtensionCommandContext, h: RelayHost | undefined): Promise<void> {
    const sessionDir = ctx.sessionManager.getSessionDir();
    const currentFile = ctx.sessionManager.getSessionFile();

    if (!args) {
      const entries = await listRecentSessions(sessionDir, 10);
      resumeSnapshot = { at: Date.now(), entries };
      if (entries.length === 0) {
        await h?.router.completeControl(`没有找到历史会话（目录：${sessionDir}）。`);
        return;
      }
      const lines = ["最近的 pi 会话：", ""];
      for (const entry of entries) {
        const mark = entry.path === currentFile ? " ← 当前" : "";
        lines.push(`${entry.index}. ${entry.name}${mark}`);
        const count = entry.partial ? `${entry.messageCount}+` : String(entry.messageCount);
        lines.push(`   ${count} 条消息 · ${new Date(entry.mtime).toLocaleString()} · ${path.basename(entry.path)}`);
      }
      lines.push("");
      lines.push("回复 /resume <编号> 切换。编号 5 分钟内有效。");
      await h?.router.completeControl(lines.join("\n"));
      return;
    }

    const index = Number.parseInt(args, 10);
    if (!Number.isFinite(index)) {
      await h?.router.completeControl("用法：/resume 或 /resume <编号>");
      return;
    }
    let entries = resumeSnapshot?.entries;
    if (!entries || Date.now() - (resumeSnapshot?.at ?? 0) > 5 * 60 * 1000) {
      entries = await listRecentSessions(sessionDir, 10);
      resumeSnapshot = { at: Date.now(), entries };
    }
    const picked = entries.find((e) => e.index === index);
    if (!picked) {
      await h?.router.completeControl(`编号 ${index} 不在当前列表中，请重新发送 /resume 获取列表。`);
      return;
    }
    await ctx.waitForIdle();
    const result = await ctx.switchSession(picked.path);
    if (result.cancelled) {
      await h?.router.completeControl(UNSUPPORTED_SESSION_HINT);
      return;
    }
    await h?.router.completeControl(`✅ 已切换到会话：${picked.name}`);
  }

  /* ------------------------- 状态文本 ------------------------- */

  function buildStatusText(h: RelayHost): string {
    const lines: string[] = ["📡 pi-im-relay 状态", ""];
    if (!h.lock.ok) {
      // 抢不到锁时通道根本没启动，再显示“🔴 off”会让人以为坏了
      lines.push(`🔒 通道已被另一个 pi 进程占用（pid=${h.lock.holder.pid}，启动于 ${h.lock.holder.startedAt}）`);
      lines.push("   本进程不重复连接，避免同一条消息被回复多次。");
      lines.push("   要在这里用，请关掉那个进程后重启；（/im log 看日志）");
      lines.push("");
      lines.push("通道状态（未启动，不是故障）：");
      for (const status of h.router.statusesSnapshot()) lines.push(`⏸ ${status.name}：未启动`);
      lines.push("");
    } else {
      for (const status of h.router.statusesSnapshot()) {
        const mark =
          status.state === "online"
            ? "🟢"
            : status.state === "needs-login"
              ? "🟡"
              : status.state === "connecting"
                ? "🔵"
                : status.state === "off"
                  ? "⚪"
                  : "🔴";
        lines.push(`${mark} ${status.name}：${status.state}${status.detail ? ` — ${status.detail}` : ""}`);
        if (status.lastInboundAt) lines.push(`   最近收到消息：${new Date(status.lastInboundAt).toLocaleString()}`);
      }
      lines.push("");
    }
    lines.push(h.router.port().describeSession());
    lines.push("");
    lines.push(`队列：${h.router.queueLength()} 条排队，${h.router.isBusy() ? "正在处理 1 条" : "空闲"}`);
    lines.push("");
    lines.push(
      `配置：${h.config.enabled ? "已启用" : "已停用"}｜单条上限 ${h.config.maxReplyChars} 字｜限流 ${h.config.rateLimitPerMinute} 条/分钟`,
    );
    return lines.join("\n");
  }
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

function describeLabel(ctx: ExtensionContext, pi: ExtensionAPI): string {
  const name = pi.getSessionName();
  if (name) return name;
  const file = ctx.sessionManager.getSessionFile();
  const cwd = path.basename(ctx.cwd || "") || "?";
  if (file) return `${path.basename(file).slice(0, 20)} · ${cwd}`;
  return `${ctx.sessionManager.getSessionId().slice(0, 8)} · ${cwd}`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.join("\n");
}

/** 人类可读的文件大小，只用于工具回执。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

/**
 * 列出会话目录里最近的 jsonl 会话。
 *
 * 完全异步，且每个文件最多只读开头 512KB —— 超大会话不会把界面卡住，
 * 代价是条数可能只是个下界（用 partial 标记）。
 */
export async function listRecentSessions(sessionDir: string, limit: number): Promise<ResumeEntry[]> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const candidates = (
    await Promise.all(
      names.map(async (name) => {
        const full = path.join(sessionDir, name);
        try {
          const stat = await fs.promises.stat(full);
          return { path: full, name, mtime: stat.mtimeMs, size: stat.size };
        } catch {
          return undefined;
        }
      }),
    )
  )
    .filter((v): v is { path: string; name: string; mtime: number; size: number } => v !== undefined)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(limit, 10));

  return Promise.all(
    candidates.map(async (candidate, i) => {
      const head = await readSessionHead(candidate.path, candidate.size);
      const stamp = candidate.name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
      const timeLabel = stamp ? `${stamp[2]}-${stamp[3]} ${stamp[4]}:${stamp[5]}` : candidate.name.slice(0, 16);
      return {
        index: i + 1,
        path: candidate.path,
        name: head.sessionName || head.firstUserText || timeLabel,
        mtime: candidate.mtime,
        messageCount: head.messageCount,
        partial: head.partial,
      };
    }),
  );
}

interface SessionHead {
  sessionName: string;
  firstUserText: string;
  messageCount: number;
  partial: boolean;
}

const HEAD_BYTES = 512 * 1024;

async function readSessionHead(file: string, size: number): Promise<SessionHead> {
  const result: SessionHead = { sessionName: "", firstUserText: "", messageCount: 0, partial: false };
  let handle: fs.promises.FileHandle | undefined;
  try {
    const length = Math.min(size, HEAD_BYTES);
    result.partial = size > length;
    const buffer = Buffer.alloc(length);
    handle = await fs.promises.open(file, "r");
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    // 最后一行可能被截断，丢弃避免 JSON 解析报错
    if (result.partial) lines.pop();
    for (const line of lines) {
      if (!line.includes('"type":"message"')) {
        if (!result.sessionName && line.includes('"name"')) {
          try {
            const parsed = JSON.parse(line) as { name?: string };
            if (typeof parsed.name === "string" && parsed.name.trim()) result.sessionName = parsed.name.trim();
          } catch {
            /* ignore */
          }
        }
        continue;
      }
      result.messageCount += 1;
      if (!result.firstUserText) {
        try {
          const parsed = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
          if (parsed.message?.role === "user") {
            result.firstUserText = extractText(parsed.message.content).replace(/\s+/g, " ").slice(0, 60);
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* 读取失败就退化成文件名 */
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return result;
}
