# pi-im-relay

用 **QQ** 和 **微信** 驱动你本机正在运行的 **pi** agent。

手机发一句话，本机的 pi 读你的文件、跑你的命令，结果回到聊天窗口。

```
QQ 用户 ──► 腾讯 ──► NapCat(本机登录) ──ws://127.0.0.1:3001──┐
                         ▲                                    │
                         └──http://127.0.0.1:6099 (WebUI 取二维码)
                                                              ├─► pi-im-relay ─► pi agent ─► 你的项目
微信用户 ──► 腾讯 iLink 云 ──HTTPS 长轮询(出站)──────────────┘         ▲                │
                                                                       └── 最终答复 ◄───┘
```

**已实现的能力**（全部写在扩展里，不依赖模型记忆）：

| 能力 | 说明 |
| --- | --- |
| 🔐 扫码登录 | QQ / 微信 的二维码**直接出现在 pi 对话里**，用手机扫即可 |
| 🔥 配置热加载 | 改 `config.json` 自动生效，不用重启、不用敲 `/im reload` |
| 📄 长文转 PDF | `im_relay_send_pdf`：Markdown → 排版好的 PDF，作为附件发回聊天 |
| 🖼 收图入相册 | 用户发来的图片自动落盘、按内容去重，回执里带上完整路径 |
| 🧠 主页作记忆 | 每条消息前注入 `AGENT.md` 工作约定 + QQ 空间说说（最近 5 + 历史抽样 5） |
| 📎 文件出站 | `im_relay_send_file`：把本机任意文件发回聊天 |
| ⚡ 进度可关 | `progress: "off"` 只回最终结果，手机不刷屏 |

---

## 🚀 五分钟上手（第一次用）

### 第 0 步：确认前提

- 一台**常开的** Windows / macOS / Linux 机器（家里电脑就行，不需要公网 IP、不需要服务器）
- 装好了 pi，并且**至少能用一次**（`pi` 命令能进去）
- 手机上有 QQ 或微信

### 第 1 步：装扩展

```bash
# 从本地路径装
pi install /path/to/pi-im-relay
# 或者从 git 装
pi install git+https://github.com/<your-account>/pi-im-relay.git
```

或者在 `<agentDir>/settings.json` 里手动加一行（`<agentDir>` 默认是 `~/.pi/agent`）：

```json
{ "packages": ["..\\pi-im-relay"] }
```

装完**重启一次 pi**（或敲 `/reload`），这是唯一一次需要手动重载。

### 第 2 步：看到通道状态

在 pi 里敲：

```
/im status
```

应当看到类似：

```
🟡 QQ：off — 未启用
🟡 微信：off — 未启用
```

首次启动会自动生成配置：`<agentDir>/im-relay/config.json`。

### 第 3 步：接一个通道（二选一，建议先 QQ）

#### 路线 A：QQ（功能最全，支持发文件）

1. 下载并启动 [NapCat](https://github.com/NapNeko/NapCatQQ/releases)（**不要在这里扫码**，下一步在 pi 里扫）
2. 在 pi 对话里直接说：**「QQ登录」**（或敲 `/im login qq`）
3. **二维码会出现在 pi 窗口里** → 用手机 QQ 扫它并确认
4. NapCat WebUI（`127.0.0.1:6099`）→ 网络配置 → 新建 **WebSocket 服务器**：

   | 配置项 | 值 |
   | --- | --- |
   | 主机 | `127.0.0.1`（**不要填 `0.0.0.0`**） |
   | 端口 | `3001` |
   | 消息格式 | `array`（必须） |

5. 装完后 `/im status` 应显示 `🟢 QQ：online — 已连接 NapCat（机器人 <你的QQ号>）`

> **两个容易碎的坑**：
> - 启动 NapCat 时**不要给 launcher 传 UIN**。账号已在本地登录时传 UIN 会报
>   「当前账号已登录，无法重复登录」，然后永远卡在等二维码。
> - 换号时要先杀掉 `QQ.exe` / `NapCatWinBootMain.exe`，并删掉 `%APPDATA%\QQ\auth\login.enc`
>   与 `Partitions\qqnt_<旧号>\`，否则旧登录态会“复活”。

#### 路线 B：微信（只能纯文本，有额度限制）

1. 在 pi 对话里说：**「微信登录」**（或敲 `/im login wechat`）
2. 二维码会出现在 pi 窗口里 → 用微信扫它
3. 扫完后你微信里会多一个 `@im.bot` 会话 —— 那就是机器人
4. 记下它给你的用户标识（形如 `xxx@im.wechat`），填进白名单

> 微信侧腾讯官方限制：凭据约 24h 过期、24h 内最多 10 条主动消息、一个 bot 只能绑一个后台。

### 第 4 步：把自己加进白名单（关键的一步）

**默认谁都不理**。在聊天里先随便发一句，bot 会回：

```
你不在白名单里，无法调用本机 agent。
你的标识：123456789
请把这一行发给管理员，加入 <agentDir>/im-relay/config.json 后即可使用。
```

把那个标识填进 `config.json`（路径：`<agentDir>/im-relay/config.json`）：

```jsonc
{
  "channels": {
    "qq": {
      "allowUsers": ["123456789"],   // 私聊白名单（就是上面那个标识）
      "allowGroups": ["987654321"]   // 群白名单；群里需要真 @ 才会响应
    }
  }
}
```

**改完即生效** —— 配置已支持热加载，不用 reload。

### 第 5 步：发一句话试试

在手机上发：

```
帮我看看 D 盘还剩多少空间
```

本机的 pi 会真的去跑 `dir`，然后把结果回到你的聊天窗口。

### 第 6 步（可选）：把约定与记忆写下来

首次运行会生成 `<agentDir>/im-relay/AGENT.md`。它是**给 agent 看的工作约定**，
每条 IM 消息前都会被垫进上下文 —— 改它就能改行为，而且不会因为上下文压缩而丢失。

里面默认已经写了：长结论走 PDF 的阈值、相册目录、隐私红线、安全红线，
以及一份**本机环境备忘**（NapCat 路径、浏览器路径、踩过的坑）。

---

## 网络模型：不需要内网穿透，也不需要租服务器

这是设计上最要紧的一点。IM 接入只有两种模式：

| 模式 | 谁发起连接 | 需要公网 IP？ |
| --- | --- | --- |
| Webhook 回调 | 平台 POST 到你的地址 | ✅ 需要内网穿透或服务器 |
| **出站长连接** | **你的机器主动连平台云** | ❌ **不需要** |

本项目的两条通道**都是出站长连接**：

- **QQ**：NapCat 以 QQNT 客户端身份出站连腾讯服务器；它对本机暴露的 OneBot11 WebSocket 是
  `127.0.0.1:3001`、WebUI 是 `127.0.0.1:6099`，都是回环地址，数据包不出网卡。
  你的机器全程没有监听任何公网端口。
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
**QQ 也是同一套体验**：把上面换成「QQ登录」即可（详见第二节）。
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

QQ 侧需要 **NapCat** —— 一个基于官方 QQNT 内核的 OneBot11 实现。本项目**不管理 NapCat 的进程生命周期**
（不替你启动/重启它），但**接管它的扫码登录**：二维码会像微信那样直接出现在 pi 的对话里。

这样职责仍然清晰（NapCat 的版本、升级、账号归它管），但你不必再切到 NapCat 的界面去扫码。

### 1. 安装并启动 NapCat

到 <https://github.com/NapNeko/NapCatQQ/releases> 下载 Windows 版（或用官方文档
<https://napneko.github.io/> 里的其它安装方式），启动它。**不要在这里扫码登录** —— 下一步在 pi 里扫。

> NapCat 会开一个本机 WebUI（默认 `127.0.0.1:6099`），它的密码存在
> `<NapCat>/NapCat.Shell/config/webui.json` 里。本项目就是通过这个 WebUI 拿二维码的，
> 默认会自动去读这个文件，所以 token 一般不用手填。

### 2. 在 pi 里扫码登录 QQ

和微信**完全一样**：在对话框里直接说：

```
QQ登录
```

或者敲命令 `/im login qq`、让 agent 调 `im_relay_login(channel: "qq")` —— 三条路都通向
同一个入口（`startLogin()`），所以不会出现「两条路各出一张码」。

二维码会直接出现在你的界面上，投递方式按界面能力自动选择：

| 界面 | 二维码怎么显示 |
| --- | --- |
| **pi-web / Web UI** | 作为一张 **PNG 图片**出现在对话流里，手机直接扫 |
| **终端 TUI** | 用半块字符 `▀▄█` 画在编辑器上方，屏幕可扫 |
| **文本模型**（不支持读图） | 自动改用代码块里的 ASCII 二维码 |

用**手机 QQ** 扫码并在手机上确认。两分钟内的重复触发只会把**同一张码**重发给你，
不会向 NapCat 再要一张。扫码确认后通道会自动连上 OneBot11 并转成 `online`，不需要重启 pi。

> 二维码约 2 分钟过期。NapCat 会自己换码，扩展检测到链接变化就会把**新码**投给你；
> 也可以再发一次「QQ登录」手动换码。`/im qr` 随时重新推一次当前二维码。

### 3. 开启 OneBot11 服务

NapCat WebUI → 网络配置 → 新建 **WebSocket 服务器**：

| 配置项 | 值 |
| --- | --- |
| 主机 | `127.0.0.1`（**不要填 0.0.0.0**，避免暴露到局域网） |
| 端口 | `3001` |
| Token | 建议设置一个，填到下面的配置里 |
| 消息格式 | `array`（必须，否则收不到结构化消息段） |

### 4. 填写 pi-im-relay 配置

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
      "progress": "live",              // live = 实时回传工具调用进度
      "webui": {                       // 扫码登录用；token 一般不用填，自动读 NapCat 的 webui.json
        "enabled": true,
        "host": "127.0.0.1",
        "port": 6099,
        "token": "",
        "configFile": "D:\\NapCat\\NapCat.Shell\\config\\webui.json"
      }
    }
  }
}
```

> NapCat 装在别处就把 `configFile` 改掉（或用环境变量 `NAPCAT_DIR` / `NAPCAT_WEBUI_CONFIG`）。
> `webui.enabled: false` 表示不要从 pi 里扫码，回到「自己去 NapCat 界面扫」的老方式。
> QQ 已经登录时，扫码流程会直接跳过，不会多要一张码。

然后在 pi 里执行 `/im reload`。

> **不知道自己的 QQ 号？** 先随便发一句，bot 会回复「你不在白名单里」并带上你的标识，复制进白名单即可
> （`announceUnpaired: false` 可关掉这个提示）。

---

## 三、接入微信（iLink / ClawBot）

微信走腾讯官方 ClawBot（iLink）通道，**扫码绑定**，不需要服务器或回调地址。

> 登录交互与 QQ 完全一致（第二节第 2 步）：二维码直接进对话。区别在服务端 ——
> 微信用腾讯 iLink，QQ 用本机 NapCat 的 WebUI。

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
| `/login [qq\|wechat]` | 重新扫码登录（默认 wechat；二维码直接进界面） |
| `/qr` | 重新展示登录二维码 |
| `/ping` | 连通性测试 |

**其它任何内容**都会作为 prompt 交给本机 pi agent 处理。

### 给 agent 用的工具

除了命令，还注册了两个工具，让「用自然语言说话」也能驱动：

| 工具 | 作用 |
| --- | --- |
| `im_relay_login` | 发起 QQ / 微信登录；用户说「登录微信」「QQ登录」时 agent 会调用它（二维码由扩展自动投递） |
| `im_relay_status` | 返回通道状态、活跃会话、队列、进程锁情况 |
| `im_relay_send_file` | 把本机任意文件作为附件发回当前 IM 会话（微信侧不支持） |
| `im_relay_send_pdf` | 把长文/Markdown 渲染成 PDF 再发回 —— 结论不刷屏的关键 |

> **为什么要有 `im_relay_send_pdf`**：手机上读长文和表格都很痛苦。
> 约定是：结论超过 300 字、或者含表格 → 渲染成 PDF 发附件，聊天里只留一段简短说明。
> 这个阈值写在 `AGENT.md` 里，而不是指望模型自己记得。

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

### 相册 `album`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `album.enabled` | `true` | 是否把收到的图片存进本机 |
| `album.dir` | `D:/YUAN HAO/Pictures/手机上传` | 相册目录（建议用正斜杠，Windows 下同样有效） |
| `album.namePattern` | `QQ_{yyyy}{MM}{dd}_{HH}{mm}{ss}` | 文件名模板 |
| `album.announce` | `true` | 是否把「已保存：<路径>」写进给模型的上下文 |
| `album.dedupe` | `true` | 按内容 SHA-256 去重，同一张图连发只存一份 |

### 记忆 `memory`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `memory.enabled` | `true` | 是否注入工作约定与主页内容 |
| `memory.maxChars` | `3000` | 注入总长度上限；**每个块另有独立预算**，不会互相挤掉 |
| `memory.recent` | `5` | 读空间：最近 N 条 |
| `memory.sample` | `5` | 读空间：历史抽样 M 条（从最旧的开始取） |
| `memory.cacheSeconds` | `300` | 空间内容缓存时间，避免每条消息都打网络 |
| `memory.identityMarker` | `"[身份]"` | 正文以它开头的说说被当作身份定位 prompt |
| `memory.chatLog` | `true` | 是否读取最近的 IM 聊天记录作为长会话记忆 |
| `memory.chatLogCount` | `10` | 拉多少条聊天记录（含双向，自己说的标为「我」） |
| `memory.refreshEveryMessages` | `15` | 每隔多少条入站消息补发一次完整记忆；`0` = 只在真正需要时注入 |

> **记忆注入的时机**：新会话开始（含新建 / 恢复 / fork / 重载）、通道刚登录成功、
> 以及每 15 条消息。避免「每条都塞一遍」浪费 token，同时避免长会话被压缩后失忆。
> 想要更实时，把 `refreshEveryMessages` 调小；想省钱就调到 `0`。
>
> 聊天记录的读取方法是 `get_friend_msg_history` / `get_group_msg_history`（主动拉），
> 而不是监听事件 —— 因为 NapCat 的事件只推给一条连接。

### PDF `pdf`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `pdf.enabled` | `true` | 是否允许 PDF 出站 |
| `pdf.threshold` | `300` | 正文超过多少字建议改走 PDF |
| `pdf.browser` | `""` | Chrome/Edge 路径；留空自动探测（也可用 `CHROME_PATH`） |

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
channels/napcat-webui.ts  NapCat WebUI 客户端：QQ 扫码登录（凭证哈希、取码、状态轮询）
channels/wechat.ts   iLink：扫码登录 + getupdates 长轮询 + sendmessage + CDN 媒体
channels/ilink-*.ts  iLink 协议层（类型、HTTP、AES-128-ECB 媒体解密）
router.ts            准入（白名单/去重/限流）→ 排队 → 垫上下文 → 注入 pi → 回传
album.ts             收图落盘、按内容去重、命名模板
qzone.ts             读 QQ 空间（走空间网页接口，NapCat 没有读接口）
chatlog.ts           读最近 IM 聊天记录（长会话记忆）
memory.ts            记忆组装与注入策略：约定 + 身份 + 聊天记录 + 说说
md.ts / pdf.ts       Markdown → HTML → Chrome 无头打印
watch.ts             config.json 热加载（目录监听 + 去抖 + 内容哈希）
store.ts             会话备注持久化
index.ts             pi 扩展入口：事件订阅、命令与工具注册、TUI 状态
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
| QQ `needs-login`（提示去 `/im login qq`） | NapCat 活着但 QQ 没登录 —— 此时 WebUI 可达、3001 端口不可达，扩展会自动区分这两种情况。在对话里发「QQ登录」扫码即可。 |
| 页脚提示 `QQ 未登录` | 同上；直接说「QQ登录」。 |
| QQ 收到消息但 bot 不回复 | 白名单没配。先发一句，看是否回「你不在白名单里」。 |
| 群里怎么 @ 都不理 | `groupTrigger` 是 `mention` 时需要真 @；另外群号要在 `allowGroups` 里。 |
| 微信 `needs-login` | 凭据过期（约 24h）。执行 `/im login wechat` 重新扫码 —— 二维码会直接出现在界面上。 |
| QQ 二维码过期了 | 约 2 分钟失效。NapCat 自己换码，扩展会把新码重新投给你；没收到就再说一次「QQ登录」。 |
| `/im login qq` 报 token 不对 | NapCat 的 WebUI 密码与 `channels.qq.webui.configFile` 指向的 `webui.json` 不一致。改配置或用 `webui.token` 显式覆盖。 |
| 微信回复被拒 / 收不到 | 24h 内超过 10 条主动消息额度，或 `context_token` 已失效 —— 让对方先发一条消息即可恢复。 |
| 二维码显示不全 | `/im qr` 重新推一次；扫描仍失败就用二维码消息里附带的链接。 |
| 回复里出现 `**加粗**` 符号 | 不会 —— 回传前会做 markdown → 纯文本转换（代码块内容保持原样）。 |
| 想让白名单立刻生效 | `/im reload`。 |

---

## 十一、开发

```bash
npm install
npm test          # 114 个用例
```

测试里包含这些**不依赖真实账号**的仿真：

- **假的 NapCat OneBot11 WebSocket 服务器** —— 完整验证 QQ 收发链路
- **假的 NapCat WebUI** —— 验证 QQ 扫码登录：token 哈希是否正确、凭证复用（不撞 WebUI 的
  3 次/分钟登录限流）、重复触发只复用同一张码、NapCat 自行换码时投新码、扫码确认后自动上线
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
- 真实 NapCat WebUI 接口：`/api/auth/login`（`sha256(token + ".napcat")`）/ `GetQQLoginQrcode` /
  `CheckLoginStatus` / `RefreshQRcode`
- 假 iLink 服务器：二维码复用、过期换码、确认写凭据、拒绝重复申请
- 假 NapCat WebUI：同上，另加 token 错误与 WebUI 不可达两条错误路径

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

---

## 十三、用聊天驱动这个扩展自己的演进

这套东西有个很实用的副作用：**你可以直接拿手机聊天来改它自己**。

因为扩展就装在你自己机器上，IM 通道又已经通了，所以改代码→生效→验证可以全在聊天里闭环。

### 闭环长什么样

```
你在 QQ 里说：「以后长结论发 PDF」
        ↓
本机 pi agent：读代码 → 改 md.ts / pdf.ts → 注册新工具 → 跑 npm test
        ↓
改 config.json → watch.ts 检测到变化 → 自动 reload（不用你动手）
        ↓
在聊天里回你一句短说明 + 一个 PDF 附件 ← 你当场就能验证
```

### 让它跑得顺的几个前提（本项目已经具备）

| 前提 | 对应实现 |
| --- | --- |
| 改完立即生效 | `watch.ts` 配置热加载 |
| 改代码能生效 | pi 的 `/reload`（重载扩展代码 —— **只有这一种改动需要手动 reload**） |
| 能安全地反复改 | `npm test`（当前 134 个用例），改坏了立刻发现 |
| 重载不会吐掉正在做的事 | `router.carryOver()/adopt()` 状态接力 |
| 结论不刷屏 | `im_relay_send_pdf` + `AGENT.md` 里的阈值约定 |
| 约定不会丢 | `AGENT.md` 每条消息前注入 |

### 今天真实跑过的一轮

作为参考，以下都是一个下午内、通过聊天往来完成的：

1. 「QQ 登录以后为什么没有像微信那样的机器人」→ 查清 NapCat 与 iLink 的身份模型差异
2. 「换一个小号」→ 停 NapCat、清登录票据与分区目录、重扫码
3. 「以后再发结论不要这么一大堆文字」→ 改 `progress: "off"`
4. 「改成热加载」→ 新增 `watch.ts` + 6 个用例
5. 「发成 PDF」→ 写 `md2pdf`，后来直接移植进扩展成为 `pdf.ts`
6. 「这些写到扩展里去」→ 新增 `album.ts` / `qzone.ts` / `memory.ts` / `AGENT.md`

### 两个必须知道的代价

- **热加载 = 重建通道**：改一次配置，QQ/微信 会有一次很短的断连重连。
  好处是行为与 `/im reload` 完全一致，不会出现「配置变了但通道还是旧的」。
- **改代码必须 `/reload`**：热加载只重读配置，不会重新导入模块。

---

## 十四、迁移到其它 AI Agent

**这一节是给别的 agent 实现的参考。** 本项目的分层与坑都是实测出来的，
换一个运行时（Claude Code / Cursor / Codex / 自研 agent loop / 其它 CLI agent）
基本可以照搬，不需要重新踩一遍。

### 可移植的四个构件

```
1. Channel 抽象（通道）
   start() / stop() / status() / send(target, text)
   sendFile?(target, path)     —— 可选能力，没有就明确报「不支持」
   login?() / api?()           —— 扫码登录、透传底层协议
   ⇒ 换 IM 平台只换这一层

2. Router（准入与排队）
   白名单 → 去重 → 限流 → 队列（FIFO）→ 单并发 → 回复只回给发起者
   ⇒ 这是「能安全对外」的核心，不建议省

3. 上下文垫层（记忆）
   每条消息前注入：本机约定文件 + 外部记忆源（本项目用 QQ 空间说说）
   必须有长度上限，必须能降级（读不到就跳过）
   ⇒ 对抗上下文压缩的唯一实用手段

4. 出站能力（文件与长文）
   send_file / send_pdf + 进度开关
   ⇒ 手机上看长文和表格是痛苦的，PDF 是刚需
```

### 换平台时的对照

| 构件 | pi（本项目） | Claude Code | Cursor / 其它 IDE agent | 自研 loop |
| --- | --- | --- | --- | --- |
| 接入点 | pi 扩展（`pi.on(...)` + `registerTool`） | hooks + MCP server | 自定义命令 / MCP | 自己的事件循环 |
| 收到消息后怎么交给模型 | `ctx.inject(text, images)` | hook 返回额外上下文 | 拼进 prompt | 直接进 message 列表 |
| 把结果发回去 | 监听 `agent_settled` | hook 的结束事件 | 包装调用层 | 自己的结束回调 |
| 配置热加载 | `fs.watch` + 内容哈希 | 同 | 同 | 同 |

> 关键不在“用哪个框架”，而在**把 IM 细节压在 Channel 层、把安全策略压在 Router 层**。
> 只要这两层是干净的，上面的 agent 运行时换什么都没关系。

### 迁移时请务必照搬的坑

这几条都是真实撞过、而且很难从表象看出来的：

1. **重载会吞掉当前那轮结果**
   发消息处理到一半时重载配置，新建的 router 里没有 `current`，
   `onSettled()` 就直接什么都不做 —— 用户看到的是「agent 跑了半天，一个字都没回」。
   ⇒ 重载前先 `carryOver()`，把 `current` / 队列 / 回复目标一起搬过去。

2. **不能 watch 配置文件本身**
   原子写是「临时文件 + rename」，rename 之后原 inode 没了，监听器第一次就失联。
   ⇒ 监听**目录**并按文件名过滤。

3. **半截 JSON 不能热加载**
   有些实现遇到损坏配置会把文件改名备份并回退默认值 —— 在热加载路径上这个副作用很致命。
   ⇒ 先做语法校验，不合法就跳过这一次。

4. **QQ(NapCat) 的 OneBot11 事件只推给一条连接**
   第二个客户端收不到 message 事件，但 **action 调用是通的**。
   ⇒ 旁路读消息时用「拉历史」，不要指望监听事件。

5. **QQ 空间只能写、不能读**
   NapCat 只暴露了 `send_qzone_msg` / `delete_qzone_msg`。
   ⇒ 要读就得用 `get_cookies` 拿 skey/bkn 再调空间自己的网页接口。
   另：`emotion_cgi_settop_v6`（置顶）实测 HTTP 500，且列表不返回「是否置顶」，
   所以“用置顶说说当身份 prompt”这条路走不通 —— 改用正文标记（本项目用 `[身份]`）。

6. **发文件也要按「最近说过话」路由**
   不要做成能向任意账号推送 —— 那等于给你的机器开了一个公网发信器。

### 如果你只想做三件事

1. 写一个干净的 **Channel 接口**（`send` / `sendFile` / `login` / `api`），IM 细节全关在里面
2. 写一个**默认拒绝**的 Router，并保证「回复只回给发起者」
3. 把约定写成一个**每轮注入的本地文件**，不要把行为约定寄托在模型的记忆上

---

## License

本项目采用 **PolyForm Noncommercial License 1.0.0**。

- ✅ **可以免费用于非商业用途**：个人学习、研究、兴趣项目，以及教学、公益组织、
  公共研究机构、政府部门内部使用
- ✅ 可以复制、修改、二次创作并分发（需随附协议原文并保留版权声明）
- ❌ **商业用途需另行取得书面授权**：请在商业产品/服务中集成、或用于经营活动前联系作者

```
Required Notice: Copyright (c) 2026 hao <howforever2000@163.com>
```

商业授权与其他事宜：**howforever2000@163.com**

完整条款见 [LICENSE](./LICENSE)（上半部分为官方英文原文，下半部分为便于理解的中文说明）。

### 第三方组件的许可

本项目自身适用上述许可，但它**依赖**若干第三方组件，它们的许可各自独立，
商用前需一并确认：

| 组件 | 用途 | 说明 |
| --- | --- | --- |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | QQ 接入 | 独立项目，有自己的一份许可，请自行确认 |
| 腾讯 QQ / 微信 官方协议与客户端 | 通信 | 受腾讯服务条款约束，**请遵守平台规则** |
| `ws` / `qrcode-generator` | 运行时依赖 | 各自为宽松许可（MIT 系） |
| pi / `@earendil-works/pi-coding-agent` | 宿主运行时 | 其自身为 peerDependency，不随本项目分发 |

> 提醒：使用本项目接入 QQ / 微信，需自行确保符合对应平台的服务条款。
> 本项目不对因账号被限制、封禁等产生的后果负责。
