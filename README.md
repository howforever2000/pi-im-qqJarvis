# pi-im-relay

用 **QQ** 和 **微信** 驱动你本机正在运行的 **pi** agent。

手机发一句话，本机的 pi 读你的文件、跑你的命令，结果回到聊天窗口。

```
QQ 用户 ──► 腾讯 ──► NapCat(本机登录) ──ws://127.0.0.1:3001──┐
                                                              ├─► pi-im-relay ─► pi agent ─► 你的项目
微信用户 ──► 腾讯 iLink 云 ──HTTPS 长轮询(出站)──────────────┘         ▲                │
                                                                       └── 最终答复 ◄───┘
```

---

## 网络模型：不需要内网穿透，也不需要租服务器

这是设计上最要紧的一点。IM 接入只有两种模式：

| 模式 | 谁发起连接 | 需要公网 IP？ |
| --- | --- | --- |
| Webhook 回调 | 平台 POST 到你的地址 | ✅ 需要内网穿透或服务器 |
| **出站长连接** | **你的机器主动连平台云** | ❌ **不需要** |

本项目的两条通道**都是出站长连接**：

- **QQ**：NapCat 以 QQNT 客户端身份出站连腾讯服务器；它对本机暴露的 OneBot11 WebSocket 是
  `127.0.0.1:3001` 的回环地址，数据包不出网卡。你的机器全程没有监听任何公网端口。
- **微信**：iLink 是腾讯官方 ClawBot 通道，你的进程**主动发起** HTTPS `getupdates` 长轮询与
  `sendmessage`，没有任何一行代码需要被外部访问。

所以：**家里或公司的 Windows 常开就能跑，0 成本，公网零暴露。** 攻击面只剩「谁能给 bot 发消息」，
用白名单锁死即可。

> 唯一可能需要花钱的情况：想 7×24 不停机而又不愿让本机常开，那就需要一台常开的机器。
> 但注意两个坑 —— **QQ 的 NapCat 不建议放 VPS**（登录 IP 突变 + 机房 IP 段极易触发腾讯风控），
> 而 **pi agent 必须和你的项目文件在同一台机器**上，否则它就失去了意义。

---

## 入口在哪：三个「点击」路径

**没有设置页按钮** —— pi-web 的设置/插件页是它自己的界面，扩展无权往里塞卡片。
这是实测结论，不是偷懒。所以入口都在**聊天输入框**里，三条路都行：

### 路径 A：直接说话（推荐，最像「点击」）

在 pi-web 的聊天框里输入一句话就行：

```
登录微信
```

agent 会自己调用 `im_relay_login` 工具，二维码随后作为**图片**出现在对话里。
同样可以问「IM 连上了吗」，agent 会调 `im_relay_status` 把状态拿给你。

### 把本机文件发回聊天（QQ 专属，微信暂不支持）

说一句就行：

```
把 D:\work\报告.pdf 发给我
```

agent 会调 `im_relay_send_file`（参数 `filePath`，可选 `channel`）。几个约束是故意的：

- **只能发给刚跟本机说过话的那个会话** —— 通道不提供向任意账号推送的入口，
  所以对方得先发一条消息过来，之后你才能把文件回过去。
- **目标是按通道记录的**：QQ 和微信交替来消息时不会串台，`channel` 可以显式指定。
- **只有 QQ 通道实现了上传**（OneBot11 的 `upload_private_file` / `upload_group_file`）。
  微信 iLink 侧只做了媒体的下载解密，没有上传发送，所以那边会明确返回「不支持」——
  文件仍留在本机，不会静默失败。

### 路径 B：斜杠菜单（真·点击）

1. 在输入框里敲一个 `/` → 弹出命令菜单（这个界面里有 47 条，含 `/im`）
2. 点 `im`（描述：IM relay：status / login / qr / attach / on / off / reload / test）
3. 补完参数回车：`/im login wechat`

### 路径 C：直接敲命令

```
/im login wechat
```

### 扫完码之后

- 微信：手机上确认（若要求数字配对码，界面会弹输入框）→ 凭据落到
  `<agentDir>/im-relay/state/wechat-session.json`，页脚从 `IM 🔑 微信` 变成 `IM ● 微信`
- **把回显的 `xxx@im.wechat` 填进 `config.json` 的 `channels.wechat.allowUsers`**，再 `/im reload`
  —— 不填白名单就谁都不理

### 重复触发不会重复出码

二维码有 2 分钟复用窗口：这期间不管是再敲一次 `/im login wechat`、还是又说一句
「登录微信」，都只会把**同一张码**重新发给你，不会向腾讯再申请一张。

> 这条是真实踩出来的：用户一边敲命令一边又跟 agent 说「登录微信」，两条路各申请一张码，
> 对话里出现两张二维码，不知道该扫哪一张。现在只会在二维码**真的过期**时才换新的。

---

## 原理：扫码到底发生了什么

你的猜测**方向对了，但准确说法不一样**。不是「注册一个微信用户」，而是：

> **扫码在你的微信里注册/绑定一个「机器人身份」（`@im.bot`），并把你这台机器上的程序授权成它的后台。**

依据是腾讯官方 npm 包 `@tencent-weixin/openclaw-weixin`（微信团队的 OpenClaw 微信通道插件）里的账号命名规则：

```js
// b0f5860fdecb-im-bot    ↔ b0f5860fdecb@im.bot     ← 机器人身份
// b0f5860fdecb-im-wechat ↔ b0f5860fdecb@im.wechat  ← 你的微信身份
```

扫码成功后服务端返回两个 id，就是这两者：

| 返回字段 | 是什么 | 用途 |
| --- | --- | --- |
| `ilink_bot_id` | 新建的**机器人账号** | 这就是「注册」出来的东西 |
| `ilink_user_id` | **扫码的你** | 白名单里填的就是它（`xxx@im.wechat`） |
| `bot_token` | 后台调用凭据 | 放在 `Authorization: Bearer …` 里 |
| `baseurl` | 分配的接入节点 | 后续请求打这里 |

### 所以它不是

| 常见误解 | 实际 |
| --- | --- |
| 注册了一个新的个人微信号 | ❌ 没有新手机号，不是你的小号 |
| 机器人变成你的微信好友 | ❌ 它是微信里的一个 AI/bot 会话 |
| 机器人代表你的微信号发言 | ❌ 它只说自己的话，不会用你的身份发消息 |
| 能读到你的聊天记录 | ❌ 只能收到「你对它说的话」 |
| 能给任何人发消息 | ❌ 只能回给已经跟它说过话的人，而且要带 `context_token` |

### 你那句话的后半段完全对

> 「登录后我跟机器人沟通，机器人拿到消息执行到 agent」

✅ 就是这个流程，也是本项目的全部工作：

```
你在微信里发一句
  → 腾讯 iLink 云把它放进 getupdates 的长轮询响应
  → 本机 pi-im-relay 收到（from_user_id / context_token）
  → 拼上来源头，交给 pi agent 执行（读文件、跑命令…）
  → agent 跑完 → sendmessage(to_user_id, context_token) 把结果发回你
```

### 几个硬性限制（腾讯侧的，绕不过）

| 限制 | 影响 |
| --- | --- |
| 凭据约 24h 过期（`errcode: -14`） | 过期后要重新扫码；通道会明确告诉你「登录已过期」，不会假装在重连 |
| 24h 内最多 10 条主动消息 | 所以微信默认只回最终结果，不刷进度；要实时进度用 QQ |
| 一个 bot 只能绑一个后台实例 | 绑到第二台机器会报 `binded_redirect`，需先在微信里解除 |
| 额外微信账号 | 每次扫码会新建一个账号条目，支持多个同时在线（官方插件的行为） |

---

## 一、安装

```bash
# 1) 安装 pi 包（本地路径或后续发布到 npm 后直接用包名）
pi install /d/YUAN\ HAO/Documents/.pi/pi-im-relay

# 2) 重启 pi，然后查看状态
#    在 pi 里执行： /im status
```

首次启动会自动生成配置：

```
<agentDir>/im-relay/config.json      # 用户配置（白名单、触发方式等）
<agentDir>/im-relay/logs/im-relay.log
<agentDir>/im-relay/state/           # 微信凭据、会话备注
```

`agentDir` 默认是 `~/.pi/agent`（Windows：`D:\YUAN HAO\Documents\.pi\agent`），可用环境变量
`PI_CODING_AGENT_DIR` 覆盖。

---

## 二、接入 QQ（NapCat）

QQ 侧需要 **NapCat** —— 一个基于官方 QQNT 内核的 OneBot11 实现。本项目**不管理 NapCat 的生命周期**，
只连接它的 OneBot11 服务，这样职责最清晰、升级互不影响。

### 1. 安装并登录 NapCat

到 <https://github.com/NapNeko/NapCatQQ/releases> 下载 Windows 版（或用官方文档
<https://napneko.github.io/> 里的其它安装方式），启动后**用你要当机器人的那个 QQ 号扫码登录**。

### 2. 开启 OneBot11 服务

NapCat WebUI → 网络配置 → 新建 **WebSocket 服务器**：

| 配置项 | 值 |
| --- | --- |
| 主机 | `127.0.0.1`（**不要填 0.0.0.0**，避免暴露到局域网） |
| 端口 | `3001` |
| Token | 建议设置一个，填到下面的配置里 |
| 消息格式 | `array`（必须，否则收不到结构化消息段） |

### 3. 填写 pi-im-relay 配置

编辑 `<agentDir>/im-relay/config.json`：

```jsonc
{
  "channels": {
    "qq": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 3001,
      "token": "你设置的token",
      "allowUsers": ["你的QQ号"],      // 私聊白名单
      "allowGroups": ["允许的群号"],    // 群白名单；空 = 所有群都不响应
      "groupTrigger": "mention",        // mention = 只在 @bot 时响应；all = 全响应
      "progress": "live"                // live = 实时回传工具调用进度
    }
  }
}
```

然后在 pi 里执行 `/im reload`。

> **不知道自己的 QQ 号？** 先随便发一句，bot 会回复「你不在白名单里」并带上你的标识，复制进白名单即可
> （`announceUnpaired: false` 可关掉这个提示）。

---

## 三、接入微信（iLink / ClawBot）

微信走腾讯官方 ClawBot（iLink）通道，**扫码绑定**，不需要服务器或回调地址。

```jsonc
{
  "channels": {
    "wechat": {
      "enabled": true,
      "baseUrl": "https://ilinkai.weixin.qq.com",
      "allowUsers": ["你的微信标识（形如 xxxx@im.wechat）"],
      "progress": "off"                 // 见下方额度说明，默认只回最终结果
    }
  }
}
```

在 pi 里执行：

```
/im login wechat
```

**二维码会直接出现在你的界面上**，不需要去翻文件或看终端：

| 界面 | 二维码怎么显示 |
| --- | --- |
| **pi-web / Web UI** | 作为一张 **PNG 图片**出现在对话流里，手机直接扫。图片只有 ~600 字节（1bit 灰度 + zlib），上下文开销可忽略 |
| **终端 TUI** | 用半块字符 `▀▄█` 画在编辑器上方，字符高宽比正好补偿，屏幕可扫 |
| **文本模型**（不支持读图） | 自动改用代码块里的 ASCII 二维码，仍然可扫；不会白发一张注定被丢掉的图 |

配套命令：

```
/im qr          # 重新把二维码推出来（比如消息被刷上去了）
/im qr-hide     # 收起 TUI 的二维码挂件
```

用手机微信扫码确认。如果微信要求输入数字配对码，pi 会弹出输入框让你填。
登录成功后，凭据保存在 `<agentDir>/im-relay/state/wechat-session.json`（权限 0600）。

> 兜底：二维码消息里始终附带原始链接；也可以从
> `<agentDir>/im-relay/state/wechat-session.json.qrcode.txt` 里取。

### 🔴 必须先知道的三个平台约束

| 约束 | 说明 |
| --- | --- |
| **凭据约 24h 过期** | 过期后需要重新 `/im login wechat` 扫码。这是腾讯侧限制，无法绕过。 |
| **24h 内最多 10 条主动消息** | 用户发消息后 24h 内，包括回复在内最多 10 条。因此微信通道默认 `progress: "off"`，只在最终结果回一次。超限会被拒。 |
| **扫码后不要把同一微信绑到两台机器** | 会报 `binded_redirect`，需先在微信里解除旧连接。 |

> 所以微信适合「应答式助手」，不适合「agent 干活的实时直播」。**要实时进度就用 QQ。**
> 想要微信侧也稳定长期在线且可主动推送，那是企业微信智能机器人的场景（本项目按你的要求未实现）。

---

## 四、在聊天窗口里能用的命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/status` | 通道状态、当前模型、会话、上下文占用、队列 |
| `/whoami` | 回显你的标识（用来加白名单） |
| `/queue` | 查看排队中的消息 |
| `/stop` | 中断当前任务并清空队列 |
| `/new` | 开一个全新的 pi 会话 |
| `/resume` | 列出最近的 pi 会话 |
| `/resume <编号>` | 切换到指定会话（编号 5 分钟内有效） |
| `/model` | 列出可用模型 |
| `/model <编号>` | 切换模型 |
| `/login wechat` | 重新扫码登录微信 |
| `/qr` | 重新展示登录二维码 |
| `/ping` | 连通性测试 |

**其它任何内容**都会作为 prompt 交给本机 pi agent 处理。

### 给 agent 用的工具

除了命令，还注册了两个工具，让「用自然语言说话」也能驱动：

| 工具 | 作用 |
| --- | --- |
| `im_relay_login` | 发起 QQ / 微信登录；用户说「登录微信」时 agent 会调用它 |
| `im_relay_status` | 返回通道状态、活跃会话、队列、进程锁情况 |

在 pi 终端里可用的管理命令：

| 命令 | 作用 |
| --- | --- |
| `/im status` | 同 `/status` |
| `/im sessions` | 列出当前打开的所有 pi 会话，标出 IM 消息会进哪个 |
| `/im attach` | **把 IM 消息固定到当前会话**（多会话时很有用） |
| `/im detach` | 取消固定，恢复「消息跟着最近活动的会话」 |
| `/im login [qq\|wechat]` | 发起登录（**二维码直接进界面**） |
| `/im qr` / `/im qr-hide` | 重新展示 / 收起二维码 |
| `/im on` / `/im off` | 总开关 |
| `/im reload` | 重新加载 config.json（白名单等改动即时生效） |
| `/im test` | 检查通道在线情况 |
| `/im log` / `/im dir` | 打印日志路径 / 数据目录 |

---

## 五、界面适配（实测结论）

### 为什么没有「设置页里的登录按钮」

做不到，有代码依据。pi-web 给扩展的 UI 通道只有两种，都不支持往它自己的
设置页里插卡片：

```js
// pi-web 服务端：自定义 UI 只能给出一组文本行
emitCustomUiRender(a, b) {
  let c = b.component.render(b.width);
  let d = { type: "extension_ui_request", method: "custom", lines: c };  // ← 只有 lines
  this.emit(d);
}
// 输入也是纯字符串：handleExtensionUiInput(a, b) 里 if (typeof b === "string")
```

设置页本身也没有任何扩展插槽 —— 它的分区是写死的：`general / appearance /
language / theme / shellTool / usePowerShell`（外加一个只做安装/启停的「插件」页）。

而且用 `custom()` 就算画出来，也只能是**字符画**二维码，扫起来比对话里的图片差。
所以入口選擇放在聊天里：说话、斜杠菜单、或直接敲命令（见开头「入口在哪」）。

### 各界面能力实测表

| 能力 | 终端 TUI | pi-web（`@agegr/pi-web`） |
| --- | --- | --- |
| `ctx.mode` | `"tui"` | `"rpc"` |
| 渲染图片 | ❌ | ✅ custom message 里的 image 会渲染成 `<img>`（最大 240px，可点开放大） |
| `setWidget` | ✅ | ✅（`widgetLines` + placement） |
| `setStatus` / `notify` / `input` / `select` | ✅ | ✅ |
| `ui.custom()` TUI 组件 | ✅ | ✅ 但**只渲染成文本行** |
| **`ctx.newSession()` / `ctx.switchSession()`** | ✅ | ❌ **固定返回 `cancelled`** |

表格在 `@agegr/pi-web` **0.8.11 与 0.9.1** 上分别核对过，行为一致。

最后一行很重要：**pi-web 不支持从扩展里新建/切换会话**。所以在 Web 界面里，
`/new` 和 `/resume <编号>` 会给出明确提示，让你改用界面自带的会话列表 ——
通道本身不受影响，不需要重新登录。

扫码登录正是按这张表分流的（实现见 `extensions/im-relay/login-ui.ts`）：
终端画 ASCII，Web 界面发图片，文本模型发代码块 ASCII。

---

## 六、pi-web 桌面端（多会话与多实例）

pi-web 一个进程里可以同时打开很多会话，而且你可能同时开着「终端里的 pi」和
「pi-web 桌面端」。这两件事都会弄坏一套天真实现的 IM 集成，所以这里做了两层隔离。

### 1. 一个进程内：通道全局唯一，会话只是参与者

每个会话都会走一遍 `session_start`。如果每个会话各建一套通道，结果是：

| 后果 | 原因 |
| --- | --- |
| 一条 QQ 消息被回复 N 次 | N 条 WebSocket 连着同一个 NapCat，每条都收到同一事件 |
| 微信重复回复 / 丢消息 | N 个 iLink 长轮询抢同一份 `sync_updates` 游标 |
| 微信额度被 N 倍消耗 | 24h 内 10 条主动消息的额度是账号级的 |
| 状态文件互相覆盖 | N 个写者并发写 `wechat-session.json` / `chat-map.json` |

所以**通道由进程级 host 持有（`host.ts`）**，会话只负责登记。

**那 IM 消息进哪个会话？** 默认进「最近有交互的那一个」，也就是你在哪个窗口敲字，手机消息就进哪个。
想钉死就执行 `/im attach`，想放开就 `/im detach`，`/im sessions` 可以看当前情况。

### 2. 跨进程：单实例锁

通道是全局唯一资源（同一套 QQ 登录、同一份 iLink 游标、同一个微信额度），
所以两个 pi 进程（比如终端 TUI + pi-web 桌面端，它们共用同一个 `agentDir`）
只应该有一个连通道。

启动时会在 `<agentDir>/im-relay/relay.lock` 抢锁：

- 抢到 → 正常连接，进程退出时自动释放
- 抢不到 → **不重复连接**，只在页脚显示 `IM ⏸ 已被其它 pi 进程占用`，`/im status` 能看到是哪个 pid
- 锁里的进程已经死了（崩溃 / 强杀）→ 自动接管，不会把你锁在外面

想在桌面端使用，就关掉那个占着锁的进程（或反过来，在那边用）。

### 3. 插件页里的可见性

pi-web 的「插件」页会把它列为已安装：

```json
{ "packageName": "pi-im-relay", "version": "0.1.0",
  "counts": { "extensions": 1 }, "status": "loaded" }
```

同一页可以直接安装 / 禁用 / 卸载。桌面端与 CLI 共用 `agentDir`（`PI_CODING_AGENT_DIR`），
所以 `pi install` 装一次，两边都能用。

---

## 七、配置项全表

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `maxReplyChars` | `1500` | 单条回复上限，超出自动分段 |
| `queueLimit` | `20` | 待处理队列上限，超出丢最旧的 |
| `rateLimitPerMinute` | `20` | 每用户每分钟入站上限（防刷） |
| `announceUnpaired` | `true` | 未在白名单时是否回复「你的标识是 …」 |
| `mirrorLocalInput` | `false` | 是否把本机终端里敲的 prompt 也同步到 IM |
| `channels.qq.progress` | `"live"` | `live` 实时回传工具调用；`off` 只回最终结果 |
| `channels.wechat.progress` | `"off"` | 同上（受 10 条额度限制，不建议开） |

---

## 八、安全模型

IM 驱动的是**你本机真实权限的 agent**：它能读写你的文件、执行你的命令。所以：

1. **默认拒绝**：白名单为空时，任何人发消息都不会被处理。
2. **白名单**：QQ 支持「私聊用户白名单 + 群白名单」；群里同时配了用户白名单时，发言人也要在白名单内。
3. **NapCat 只监听 127.0.0.1**：不要配 `0.0.0.0`，否则局域网内任何人都能伪装成 QQ 消息。
4. **去重 + 限流**：`channel:eventId` 去重（LRU 5 万）+ 滑动窗口限流。
5. **凭据落盘权限 0600**，日志不打印 token。
6. **无需公网暴露**：没有任何入站监听端口。

> 对外提供服务前请自行评估合规要求。本项目不提供法律建议。

---

## 九、工作原理

```
channels/qq.ts       OneBot11 WS 客户端：事件 → InboundMessage；send() → send_private_msg
channels/wechat.ts   iLink：扫码登录 + getupdates 长轮询 + sendmessage + CDN 媒体
channels/ilink-*.ts  iLink 协议层（类型、HTTP、AES-128-ECB 媒体解密）
router.ts            准入（白名单/去重/限流）→ 排队 → 注入 pi → 回传
store.ts             会话备注持久化
index.ts             pi 扩展入口：事件订阅、命令注册、TUI 状态
```

**会话模型**：pi 只有一个会话，所以多个 IM 会话**共享同一段上下文**。为了让「谁问的谁收到答案」，
router 维护一个 current job：一个 turn 的产出只回给触发它的那个 IM 会话，期间其它人的消息进队列，
按 FIFO 依次处理。这样既保留了「接管原生会话」的体验，又不会串台。

**回复路由**：`agent_settled`（pi 彻底跑完，含重试与压缩重试）时才回传最终答复，
而不是在流式过程中反复发 —— 这也是为了适配微信的额度限制。

---

## 十、故障排查

日志在 `<agentDir>/im-relay/logs/im-relay.log`（1MB 轮转，保留 3 份），
或直接在 pi 里 `/im log` 拿路径。

| 现象 | 原因与处理 |
| --- | --- |
| 页脚显示 `IM ⏸ 已被其它 pi 进程占用` | 你同时开了两个 pi（比如终端 + 桌面端）。`/im status` 会告诉你是哪个 pid 占着；关掉那个即可，或直接在那边用。 |
| 多个会话，手机消息进错了窗口 | 执行 `/im attach` 把它钉在当前会话；`/im sessions` 查看当前活跃会话。 |
| QQ 状态 `error`，提示 NapCat 不可达 | NapCat 没启动，或 OneBot11 服务没开，或端口/Token 不匹配。`/im status` 里有基于 TCP 探测的具体诊断。 |
| QQ 收到消息但 bot 不回复 | 白名单没配。先发一句，看是否回「你不在白名单里」。 |
| 群里怎么 @ 都不理 | `groupTrigger` 是 `mention` 时需要真 @；另外群号要在 `allowGroups` 里。 |
| 微信 `needs-login` | 凭据过期（约 24h）。执行 `/im login wechat` 重新扫码 —— 二维码会直接出现在界面上。 |
| 微信回复被拒 / 收不到 | 24h 内超过 10 条主动消息额度，或 `context_token` 已失效 —— 让对方先发一条消息即可恢复。 |
| 二维码显示不全 | `/im qr` 重新推一次；扫描仍失败就用二维码消息里附带的链接。 |
| 回复里出现 `**加粗**` 符号 | 不会 —— 回传前会做 markdown → 纯文本转换（代码块内容保持原样）。 |
| 想让白名单立刻生效 | `/im reload`。 |

---

## 十一、开发

```bash
npm install
npm test          # 84 个用例
```

测试里包含这些**不依赖真实账号**的仿真：

- **假的 NapCat OneBot11 WebSocket 服务器** —— 完整验证 QQ 收发链路
- **二维码编解码往返** —— 生成 PNG 后用 `pngjs` 解回像素、`jsqr` 识别内容，
  断言解出来的就是原文；这同时验证了 `qr.ts` 里手写的 1bit PNG 编码器是正确的
- **假的 UI 端口** —— 把 pi-web / TUI / 文本模型三种投递策略钉死
- **多会话与进程锁** —— 锁死「一个进程只起一套通道」「活跃会话跟随」「残留锁自动接管」
- **假的 pi ExtensionAPI** —— 验证扩展加载、命令注册、session 生命周期

扩展加载测试通过 `PI_CODING_AGENT_DIR` 指向临时目录，不会污染你的真实配置。

### 已经实测过的环境

- `pi` 0.84.3 与 0.85.1 终端（print 模式与 TUI）
- `@agegr/pi-web` 0.8.11 与 0.9.1：headless 服务与 **真实 Electron 桌面端**（`--smoke` 与正常运行）
- 真实腾讯 iLink 接口：`get_bot_qrcode` / `get_qrcode_status`（返回 `wait`）/ 长轮询行为
- 假 iLink 服务器：二维码复用、过期换码、确认写凭据、拒绝重复申请

---

## 十二、与其它方案的取舍

| 方案 | 形态 | 何时选它 |
| --- | --- | --- |
| **本项目** | pi 扩展，接管当前 pi 会话 | 想用手机操作**正在用的这个** pi，且只要 QQ + 微信 |
| [PI2X](https://github.com/pi2x-nyan/pi2x) | 独立 Node 进程 + pi SDK | 想要每个 IM 会话独立上下文、独立工作区 |
| [cli-wechat-bridge](https://github.com/UNLINEARITY/CLI-WeChat-Bridge) | 独立 CLI 桥（支持 Pi/Codex/Claude/OpenCode） | 微信/企业微信 + 多 CLI 切换，AGPL-3.0 |
| [nekoclaw](https://github.com/oines/nekoclaw) | 多 agent 运行时 + Docker | 要多个 bot 人格、人物记忆、容器隔离 |
| [AniaBot](https://github.com/jeanhua/AniaBot) | Go 框架，IM 平台最全 | 平台覆盖优先于 agent 能力（它自带 AI 插件） |

本项目的定位很简单：**不改动你的 pi 使用习惯，只是给它加一个手机入口。**

## License

MIT
