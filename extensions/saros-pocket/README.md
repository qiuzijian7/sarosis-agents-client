# Saros Agents Pocket

把 **VsSaros** 装进你的口袋：VsSaros 原生扩展，手机扫码即远程同步访问电脑上的 VsSaros（局域网 + 公网，实时同屏）。

本项目基于 [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（GPL-2.0）二次开发，将「改头反向代理 + 访问密码 + cloudflared 隧道 + 移动端适配」这套机制从 DSH 移植到 VsSaros，并把 cordis 插件入口换成 VsSaros 扩展的 `activate()`。

---

## 工作原理

VsSaros 的 **server/web 模式**（`src/server-main.ts`）会把完整工作台通过 HTTP + WebSocket 提供出来，默认监听 `127.0.0.1:8000`。但它的浏览器信任栅栏只认 loopback 权威，且 web 客户端必须携带连接令牌（`?tkn=<token>`，cookie `vscode-tkn`）。

Saros Pocket 扩展在激活时启动一个反向代理，监听 **`0.0.0.0:3081`**：

1. 把入站请求的 `Host` / `Origin` 统一改写成 `127.0.0.1:8000`（loopback 权威），于是上游信任栅栏认它是本机；
2. 根路径首次访问时自动注入连接令牌（`?tkn=`），上游换发 `vscode-tkn` cookie 后后续请求自动携带；
3. HTTP 与 WebSocket 原样透传 → 手机看到的界面与电脑完全一致、实时；
4. 注入非安全上下文必需的 polyfill（`crypto.randomUUID` / `AbortSignal.any`），并支持 gzip/br 压缩。

于是：

- **局域网**：手机连同一 WiFi，扫面板里的二维码（或访问 `http://<电脑IP>:3081`）即可；
- **公网**：开启 cloudflared 隧道，得到 `https://….trycloudflare.com`（或你自己的固定域名），任意网络可进。

两种方式都默认要求 **8 位访问密码**（公网强制、局域网可按开关关闭）。

---

## Pocket App：与 VsSaros 通信

除了「把整个工作台同屏到手机」，本扩展还自带一个**手机优先的轻量 App**，地址为：

```
http://<电脑IP>:<代理端口>/pocket/      # 局域网
https://<隧道域名>/pocket/              # 公网
```

（电脑上直接访问 `http://127.0.0.1:3081/pocket/`，或命令面板执行 **`Saros Pocket: 打开随身 App`**；
面板首页也有「打开 App」按钮。）

> **完整图文说明（含全套界面 mockup）：[`docs/usage.html`](docs/usage.html)**
> —— 两种用法对比、扫码三步、面板/App/插件页 mockup、23 个配置项对照、安全默认、常见问题与排障命令。

App 不加载整个工作台，只通过两条通道与 VsSaros 通信：

| 通道 | 路径 | 用途 |
| --- | --- | --- |
| RPC | `POST /saros-pocket/rpc/<endpoint>` | 请求-响应：聊天、文件、命令、状态 |
| SSE | `GET /saros-pocket/events` | 服务端推送：聊天流式增量、VsSaros 侧事件 |

### 手机怎么连（三步）

1. **电脑**：确认 VsSaros 以 server/web 模式在跑（默认 `:8000`，被占用时扩展会自动探测），
   然后 `Ctrl/Cmd+Shift+P` → **`Saros Pocket: 打开访问面板`**。
2. **面板**：确认「局域网访问」开关已开（**默认开**）；面板顶部第一张卡片就是
   **「Pocket App · 手机连接」**，直接给出 **局域网 / 公网两个二维码**，
   扫码即进 App（不用手动改地址；`127.0.0.1` 只在本机有效）。
   首次打开会要求输入 **8 位访问密码** —— 局域网密码就在下方「局域网访问」卡片里
   （默认自动生成；也可设成自己的 8 位字母数字）。
  **本机想在浏览器里看？**「局域网访问」卡片里有 **「在浏览器打开（自动填密码）」**：
  地址带一次 `?token=<密码>`，代理据此种下 HttpOnly cookie ⇒ 不用手输；App 载入后会把该参数
  从地址栏摘掉（不留在历史 / 截图里）。地址用的是 `127.0.0.1`，密码只在本机流转。
3. **手机**：与电脑连同一 WiFi → 扫码 → 输密码 → 进入 App
   （`对话 / 会话列表 / 变更 / 状态` 四个页签；「远程看桌面」在面板里也有一键入口）。

   **会话列表**（原「收件箱」）= 会话总览：**默认同步 VsSaros 里的全部 Agent 会话**
   （含你在电脑上开的那些，上限 200），按**最近更新**排序，带状态徽标与
   `运行中 / 待授权 / 已完成 / 失败` 筛选。卡片上的「**结束**」= **归档**（可逆）——
   归档后的会话从列表收起，点「**已归档**」芯片可以再看（真没有归档会话时该芯片不出现）。

   **当前会话**（聊天框）= 与 VsSaros 聊天框同构的头部：**聊天模式**（Craft / Ask / Plan）、
   **Agent**、**工作区**、**Worktree**、**模型** 五个选择器 + 一行上下文摘要。
   这些列表来自 VsSaros（命令 `sarosPocket.getChatContext`），**改选会写回 VsSaros**
   （切活动工作区 / 写 `AgentBinding.worktreePath` / 写模型选择）——不是只改手机上的显示。
   所选**模式**随每条消息下发（`sessions.send` 的 `chatMode`）：在「会话列表」点进某个会话后，
   消息会**直接写进那个 Agent 会话** ⇒ 桌面端聊天框与 sideview 实时同步，回复也实时流回手机。

外出（不在同一 WiFi）时：面板 → 「公网访问」→ **开启公网** → 用 **App 的公网二维码**。
公网入口**强制**密码，且 `https` 域名对 iOS Safari 更友好（纯 `http://IP` 的局域网入口 Safari 不存 cookie，会卡在登录握手——面板会给出明确提示与重试链接）。

| 想改的东西 | 在哪改 |
| --- | --- |
| VsSaros 端口 / 连接令牌 / 代理端口 | 插件页 `Configuration`（或设置里搜 `sarosPocket`） |
| 局域网开关、局域网密码 | 面板「局域网访问」卡片 |
| 公网开关、隧道模式（快速/命名）、公网密码 | 面板「公网访问」卡片 |
| 多网卡时局域网地址不对 | 面板「设置」→ 局域网地址覆盖（填正确 IPv4） |
| App 里能不能写文件 / 发终端 / 远程键鼠 | 插件页 `Configuration`（`allowFileWrite` / `allowTerminal` **默认关**；`allowDesktopInput` **默认开**） |

### App 能做什么

| 能力 | endpoint | 说明 |
| --- | --- | --- |
| 对话（模型直连） | `chat.send` / `chat.models` | 用 **VsSaros 里配置好的模型**（`vscode.lm`）聊天，流式增量经 SSE 实时回显 |
| 看信息 | `vsaros.info` / `pocket.status` | VsSaros 版本、工作区、当前编辑器、代理/隧道状态、能力开关 |
| 看文件 | `files.list` / `files.read` | 浏览工作区、读文本（默认 256 KB 上限，二进制拒绝） |
| 改文件 | `files.write` | **默认关闭**（`sarosPocket.allowFileWrite`） |
| 开文件 | `editor.open` | 在 VsSaros 里打开该文件 |
| 跑命令 | `commands.run` / `commands.list` | **仅白名单**（`sarosPocket.allowedCommands`，精确匹配；`sarosPocket.*` 始终允许） |
| 发终端 | `terminal.send` | **默认关闭**（`sarosPocket.allowTerminal`） |
| 通知 | `notify` | 在电脑上弹一条 VsSaros 通知 |

### 在「插件页」里出现（Agent 插件 / Installed 页签）

VsSaros 的 Plugins 视图有三个页签，语义不同：

| 页签 | 数据源 | pocket 在哪 |
| --- | --- | --- |
| **Installed** | **Agent 插件**（prompt / skill / agents / hooks / MCP 包） | 需要 `contributes.chatPlugins` + `plugin/plugin.json`（本仓库已有 ⇒ 会显示在这里） |
| **Extensions** | VS Code 扩展（`IExtensionsWorkbenchService.local`） | 一直在这里（不管有没有 plugin/） |
| Marketplace | 扩展/插件商城 | — |

因此本仓库带一份 `plugin/plugin.json`（`contributes.chatPlugins: [{ "path": "./plugin" }]`）。

⚠ **配置项从哪来**（容易踩错）：详情页的 `Configuration` 区读取的是**宿主扩展 `package.json` 的
`contributes.configuration.properties`**，不是 `plugin/plugin.json` 里的 `configuration`
（后者只是与 codebuddy-provider 同约定的镜像，便于插件包自带一份说明）。

而宿主扩展的匹配规则有一个坑：VsSaros 用 `isEqualOrParent(插件目录, 扩展目录)` 判定归属
（2026-09-20 修复前是模糊名称包含匹配）。旧规则依赖 `plugin.label`，而本地插件的 label 实际是
**扩展目录名**（`basename(插件目录的父目录)`）——一旦**目录名 ≠ 包名**就匹配不上、配置区**静默为空**。
所以：**扩展目录名要与包名保持一致**（本仓库安装后目录为 `saros-agents-pocket-<版本>`，天然包含包名）。

### 为什么是这两条通道

dsh-pocket 的 client 由 cordis 插件框架注入到 dsh web 页面里，RPC 挂在框架自带的
`/dsh-pocket` 逻辑通道上。VsSaros **没有对等的插件注入点**，所以本扩展改成
「代理自己托管 App」：App 与 RPC 都挂在 Pocket 代理的本地路由上，排在
**访问密码校验 + 局域网开关之后**、转发上游之前——能打开 App 的人必然已经过了 PIN，
不另开一条认证口子，也不需要改 VsSaros 的任何源码。

---

## 远程查看 VsSaros.exe 的 UI（桌面画面）

> 参考 [billd-desk](https://github.com/galaxy-s10/billd-desk) 的「web 网页观看/控制电脑端」形态。

Pocket 原先只能代理 **server/web 模式** 的 VsSaros；**桌面版 vssaros.exe 不暴露 HTTP 端口**，代理会 502。
现在 App 里新增「屏幕」页签，手机可以**直接看电脑上的 VsSaros 窗口**（桌面版也能看）：

```
电脑：命令面板 → Saros Pocket: 远程查看 VsSaros 桌面（屏幕）
手机：App → 底部「屏幕」页签（或扫码后访问 /pocket/#screen）
```

完整图文说明（含界面 mockup、参数选择、实测带宽、排障命令）：[`docs/screen-usage.html`](docs/screen-usage.html)。

| 通道 | 路径 | 说明 |
| --- | --- | --- |
| 画面流 | `GET /saros-pocket/screen.mjpeg` | MJPEG（`multipart/x-mixed-replace`），浏览器 `<img>` 直接渲染；不支持时自动降级为按帧拉取 |
| 单帧 | `GET /saros-pocket/screen.jpg` | 截图 / 轮询兜底 |
| 状态 | `desktop.status` | 后端、是否采集中、观看人数、采集区域、最近错误 |
| 参数 | `desktop.config` | fps / quality / scale / mode / processName / monitor |
| 输入 | `desktop.input` | 鼠标点击 / 滚轮 / 按键 / 文本（**默认开启**，`sarosPocket.allowDesktopInput`，仅 Windows）。App 里还有一层**本机开关**（默认开、关掉后记住，画面左上角常显「远程操作中」，防误触）：主机允许后，手机屏幕上打开「允许远程操作」才会真的发键鼠；未允许时开关旁会写明「去哪开」并给「重新检测」 |
| 全屏 | —（纯前端） | 浏览器走标准 Fullscreen API；**原生壳 / iOS Safari 没有元素的 Fullscreen API**，自动退回 CSS 全屏（铺满视口 + 「退出全屏」，Esc 可退） |

采集实现（与 billd-desk 的关键差异）：

- billd-desk 被控端是 Electron 应用，可用 `desktopCapturer` + WebRTC 硬件编码；
- Pocket 跑在 **VsSaros 的扩展宿主**（纯 Node：没有 Electron API、不能装原生模块），
  因此走**零依赖**路线：Windows 用长驻 PowerShell 子进程（`PrintWindow` 抓窗口 → 缩放 → JPEG → stdout），
  macOS 用 `screencapture`、Linux 用 `import`/`ffmpeg`。
- 实测（2560×1440 屏、VsSaros 窗口 2576×1408）：单帧 抓屏 ~45ms + 缩放 ~20ms + 编码 ~10ms，
  scale 0.75 约 13fps；默认 **4fps / scale 0.5 / quality 55**。
- **带宽自适应**：App 会把自己的显示宽度（`innerWidth × dpr`，上限 1600）通过 `desktop.config`
  的 `maxWidth` 下发给主机，实际缩放 = `min(scale, maxWidth / 采集区域宽)`，每帧按当前区域算。
  实测同一画面（q60）：全尺寸 772KB → maxWidth 1170 约 461KB → maxWidth 800 约 222KB。
  手机流量下建议选「流畅 + 2fps」。
- 代价：没有硬件编码、没有 WebRTC 的低延迟与自适应码率；优点是**零依赖、零驱动、装扩展即用**。

安全护栏（与其他写出口同规格）：

- 画面/输入路由与 App 共用代理的 **PIN + 局域网开关** 栅栏；
- `desktopEnabled=false` 时采集拒绝启动（不会「静默抓屏」）；
- 输入默认关闭，且坐标只能落在当前采集区域内（0~1 归一化后映射，越界拒绝）；
- 无人观看 3 秒后自动停掉采集进程，切走页面/断开连接即释放。

---

## 前置条件

> VsSaros 必须以 **server/web 模式**启动，本扩展才有可代理的上游。桌面模式（Electron）不暴露 HTTP 端口，代理会 502。

> **桌面版下这个 502 是预期的「这条入口打不开」，不是 Pocket 坏了**：
> `/` = **同屏 web 入口**，必须转发给 VsSaros server；而 **Pocket App（`/pocket/`）走扩展本地路由，
> 完全不经过上游**，对话 / 文件 / 变更 / 状态 / 屏幕都照常可用。
> 打开 `/` 时不再是一行 `ECONNREFUSED`，而是一张说明页（标题「VsSaros 同屏 web 暂不可用」，
> 带「打开 Pocket App」直达链接 + `vssaros --server` 命令 + 重试）。
> 面板「局域网访问」卡片也会显示 **同屏 web 入口：可用 / 不可达**（含「重新探测」），不必等撞上 502。
>
> ⚠ 面板的「局域网访问」卡片里那个二维码是 **Pocket App 的局域网入口**（`/pocket/`），扫了直接进 App；
> **同屏 web 入口只作为一行状态 + 可用时才出现的「打开」链接** —— 早先这张卡放的是代理根路径（同屏 web）的二维码，
> 桌面版下扫了必然是「VsSaros 同屏 web 暂不可用」页，属于入口用错了地方。

启动 server 模式（任选其一）：

```bash
# 直接以 web server 模式启动（默认 127.0.0.1:8000）
vssaros --server --port 8000

# 或指定连接令牌（更可控，把同一个令牌填到扩展设置 connectionToken）
vssaros --server --port 8000 --connection-token <你的令牌>

# 或用不带令牌的测试模式（仅可信网络）
vssaros --server --port 8000 --without-connection-token
```

扩展会自动：

- 探测 `127.0.0.1:8000`（及常见端口）；
- 读取 `<userDataDir>/token` 拿到连接令牌（或在设置里显式填写 `sarosPocket.connectionToken` / `sarosPocket.userDataDir`）。

---

## 安装与使用

1. 用 VsSaros 的扩展加载器安装本扩展（`.vsix` 或开发模式指向本仓库根目录）。
2. 重启 VsSaros（扩展默认 `onStartupFinished` 激活）。
3. 命令面板（`Ctrl+Shift+P`）搜 **`Saros Pocket: 打开访问面板`**（面板会以编辑器标签页形式打开）。
   扩展激活时右下角会弹一条提示（不是状态栏常驻入口），点它不会打开面板，仍走命令面板。
4. 面板里：
   - 局域网：开关 + 二维码 + 密码；
   - 公网：点「开启公网」→ 等待隧道就绪 → 扫码/分享链接；
   - 设置：自定义密码、固定局域网地址、命名隧道（Tunnel Token + 固定域名）、恢复出厂。

---

## 设置（`settings.json` / 扩展配置页）

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `sarosPocket.upstreamPort` | `8000` | VsSaros server/web 模式端口 |
| `sarosPocket.connectionToken` | `""` | 连接令牌；留空则自动读 `<userDataDir>/token` |
| `sarosPocket.userDataDir` | `""` | VsSaros 用户数据目录（用于自动读令牌），留空自动探测 |
| `sarosPocket.proxyPort` | `3081` | Pocket 代理监听端口 |
| `sarosPocket.launchPublicOnStart` | `false` | 激活时是否自动开公网隧道 |
| `sarosPocket.chatModel` | `""` | App 默认模型 ID（留空 = 第一个可用模型） |
| `sarosPocket.chatSystemPrompt` | 见设置页 | App 对话的系统提示词（只影响 App 内模型直连） |

| `sarosPocket.allowedCommands` | 3 个只读命令 | App 可远程触发的命令白名单（精确匹配） |
| `sarosPocket.allowFileWrite` | `false` | 是否允许 App 写工作区文件 |
| `sarosPocket.allowTerminal` | `false` | 是否允许 App 向终端发送文本 |
| `sarosPocket.fileRoot` | `""` | App 文件浏览根目录（留空 = 工作区第一个文件夹） |
| `sarosPocket.maxFileBytes` | `262144` | App 单次读文件上限（字节） |
| `sarosPocket.desktopEnabled` | `true` | 允许远程查看桌面画面（关掉后画面流/截图不可用） |
| `sarosPocket.desktopMode` | `window` | 采集范围：`window`（只抓 VsSaros 窗口）/ `screen`（整屏） |
| `sarosPocket.desktopProcessName` | `vssaros` | `window` 模式按进程名定位窗口 |
| `sarosPocket.desktopFps` | `4` | 画面帧率（1-15） |
| `sarosPocket.desktopQuality` | `55` | JPEG 质量（10-95） |
| `sarosPocket.desktopScale` | `0.5` | 画面缩放（0.2-1） |
| `sarosPocket.desktopMonitor` | `-1` | `screen` 模式采集第几块屏（-1 = 主屏） |
| `sarosPocket.allowDesktopInput` | `true`（默认开） | 允许手机远程操作鼠标/键盘（仅 Windows）。关掉后手机上的开关也会变灰 |
| `sarosPocket.lanEnabled` | `true` | **局域网访问总开关**（= 面板里那个开关，同一份值） |
| `sarosPocket.lanAuthEnabled` | `true` | **局域网访问是否需要密码**（公网入口始终强制密码） |
| `sarosPocket.lanIpOverride` | `""` | **局域网地址覆盖**（IPv4；多网卡/VPN 探测不准时填） |
| `sarosPocket.tunnelMode` | `quick` | **公网隧道模式**：`quick` 随机域名 / `named` 固定域名 |
| `sarosPocket.tunnelHostname` | `""` | **命名隧道的固定域名**（如 `pocket.example.com`） |

### 插件设置页怎么组织（2026-09-21 方案 A）

配置区是**左栏分组导航 + 右栏卡片**：左栏列分组（项数 + 「● 已修改」），点一下右侧即切换，不必滚动查找；
第一个页签是 **「快速访问」**：12 个动作按钮按用途分行（连接 / 公网隧道 / 密码 / 维护），
**访问面板直接内嵌在这个页签里**（webview 元素，不跳独立标签页；右上角留「在新标签打开 / 刷新」备用）；
顶部**状态条**给「局域网 / 公网 / 远程键鼠 / 上游」四个状态（数据来自扩展的 `sarosPocket.status` 命令，只回状态、不回密码）；
12 个动作按钮收进**快捷操作卡**并按用途分行（连接 / 公网隧道 / 密码 / 维护，主操作主色、危险操作红色）；
`x-advanced` 标注的 8 个低频项（上游端口 / 连接令牌 / 数据目录 / 代理端口 / 公网自启 / 进程名 / 显示器 / 单次读文件上限）
进左栏底部「高级」默认收起；底部 sticky 保存条带「N 项已修改 / 撤销更改 / 保存设置」，左栏底部是「全部重置为默认」。
窄屏（编辑器面板 < 760px）左栏变顶部 chips、网格降为单列。设计稿 + 实施记录：`docs/settings-mockup.html`。

### 面板里的动作，在插件设置页也是一排按钮

插件详情页（Plugins → Installed → `saros-pocket` → Configuration）除了上面的设置项，
还给了一排**动作按钮**（走 VsSaros 的 `x-action` 约定：点击即执行命令，不写设置）：

`打开访问面板` · `打开随身 App` · `复制 App 地址` · `开启公网访问` · `关闭公网访问` ·
`用快速隧道（随机域名）` · `用命名隧道（固定域名）` · `设置隧道 Token` ·
`设置局域网密码` · `刷新局域网密码` · `设置公网密码` · `恢复出厂设置`

> **为什么有 5 个开关变成了设置项**：它们原先只存在于扩展 globalStorage ⇒ 插件设置页看不到、
> 也改不了（用户反馈「面板里有的选项，插件设置里没有」）。现在这 5 项以**设置为唯一真源**，
> 面板与插件页读写同一份值（`lib/state.mjs` 的 settings 后端），改一处两边生效。
>
> **凭据不进设置**：PIN（局域网/公网密码）与隧道 Token 仍只落 `globalStorage`（文件 0600）——
> `settings.json` 会被同步、被别的扩展读到，不适合放凭据；改它们走上面那些按钮（命令内弹输入框）。

---

## 与 dsh-pocket 的差异

| 维度 | dsh-pocket | Saros Agents Pocket |
| --- | --- | --- |
| 集成形态 | cordis 插件（跑在 `dsh web` 进程内） | VsSaros 原生扩展（`activate()`） |
| 上游 | `dsh web` 默认 `:3080` | VsSaros server/web 默认 `:8000` |
| 连接令牌 | `?token=` + `dsh-auth-` cookie | `?tkn=` + `vscode-tkn` cookie |
| 设置页 | cordis RPC 网页 | VsSaros webview 面板 |
| 仓库 | 独立 cordis 插件 | VsSaros 扩展（本仓库） |
| 客户端 | `client/`（React + esbuild，由框架注入 dsh web 页面；RPC 走框架通道） | `app/`（原生 HTML/CSS/JS，无构建；由代理托管在 `/pocket/`，RPC/SSE 走代理本地路由） |
| 宿主能力 | 文件读取、隧道控制 | 模型对话（流式）、Agent 下发、文件读写、编辑器、命令、终端、通知 |

通用部分（反向代理、Host/Origin 改写、速率限制、WS 心跳、压缩注入、cloudflared 隧道、二维码生成）基本原样移植。

---

## 安全说明

- 公网访问**强制** 8 位访问密码；局域网默认也要求，可关。
- 登录失败有滑动窗口限速（单 IP 60s 内 ≥5 次锁 60s，全局 1 分钟 >50 次锁 30s），成功登录清空计数。
- 密码 cookie 为 HttpOnly、有效期 30 天；VsSaros 重启 → 会话密钥变化 → 手机需重输。
- **重启后旧 cookie 会被自动替换**：带着失效旧 cookie 用 `?token=<PIN>` 打开（「在浏览器打开（自动填密码）」就是这么打开的）时，
  代理会**重发**新 cookie，所以页面里的 `app.css` / `app.js` 不会因旧 cookie 失效而 401（曾经的表现是：页面裸奔、JS 不执行、地址栏 `?token=` 也摘不掉）。
  不必手动清站点 cookie。
- **「在浏览器打开（自动填密码）」**：只用于 `openExternal`（本机浏览器，地址固定走 `127.0.0.1`，
  密码不会经网络外传）；**「复制 App 地址」给的是干净地址，永远不带密码** —— 这条有断言守着。
- 非安全上下文（http://IP）下 Safari 不保存 cookie，会导致握手循环——此时请用 Chrome/Edge，或改用公网 HTTPS 入口。
- **VsSaros 能执行代码，公网二维码/链接请勿泄露。**
- Pocket App 的 RPC/SSE 与网页共用同一套 PIN 与局域网开关（代理在鉴权之后才接管这些路由），不额外开认证口子。
- App 的**写操作默认全关**：`files.write` 需 `allowFileWrite`、`terminal.send` 需 `allowTerminal`、`commands.run` 只认白名单；文件读写一律限制在工作区根目录内（`..` 与跨盘符路径会被拒）。
- 聊天走的是 VsSaros 已配置的模型（`vscode.lm`）；若 VsSaros 未暴露该 API，App 会自动隐藏「模型直连」，只留「会话列表 → 点进会话」那条通路（`sessions.send`，需开启 `sarosPocket.allowAgentControl`）。
- **桌面画面会把你的屏幕实时发给连进来的设备**：默认只抓 VsSaros 窗口（`desktopMode=window`），可用 `desktopEnabled=false` 一键关闭；画面路由与 App 共用 PIN 栅栏。
- **远程键鼠默认开启**（`sarosPocket.allowDesktopInput=true`）：方便即开即用，但意味着**拿到密码的人可以点击/打字**。
  两道闸门都保留：电脑侧设置 + 手机侧开关（默认开、关掉后记住）；远程操作生效时**画面左上角常显「⌨ 远程操作中」**。
  坐标只能落在当前采集区域内，但不防「授权用户自己误操作」——公网使用时请谨慎，不用时在设置里关掉。

---

## CI：每次提交自动出 Android / iOS 包

打包相关文件分两处（根目录只留 2 行 `include` shim）：

| 位置 | 内容 |
| --- | --- |
| [`.ci/package-android.yml`](.ci/package-android.yml) | **蓝盾 PAC 打包流水线**（与主仓 `.ci/package-win-exe.yml` 同方言）；[`.gitlab-ci.yml`](.gitlab-ci.yml) 是 GitLab 那份；说明见 [`.ci/README.md`](.ci/README.md) |
| [`scripts/`](scripts/README.md) | 流水线调用的脚本（`verify.sh` / `android-sdk.sh` / `build-android.sh` / `build-ios.sh` / `package-vsix.sh`）—— **本地可原样跑** |
| `.ci/out/` | 所有产物（`*.vsix` / `*.apk` / `*.ipa`），已被 `.gitignore` 忽略 |

流水线（远端是 git.woa.com，GitLab 形态）：

```
push → test（全量测试）→ package:vsix（扩展包） + build:android（APK） + build:ios（IPA）
```

| Job | Runner | 调用的脚本 | 产物（落 `.ci/out/`） |
| --- | --- | --- | --- |
| `test` | Linux | `scripts/verify.sh` | —（全量测试，gate 后面所有 job） |
| `package:vsix` | Linux | `scripts/package-vsix.sh` | `saros-pocket-<sha>.vsix`（可直接「从 VSIX 安装」） |
| `build:android` | Linux | `scripts/android-sdk.sh` + `build-android.sh` | `saros-pocket-android-debug-<sha>.apk`（+ 可选签名 release） |
| `build:ios` | macOS | `scripts/build-ios.sh` | `saros-pocket-ios-unsigned-<sha>.ipa` |

- 原生工程（`mobile/android`、`mobile/ios`）**不入库**，由脚本里的 `npx cap add` 生成；
- Web 产物来自根 `app/`（无构建），改前端提交即出新包（vsix 与 Android/iOS 同源）；
- iOS 需要 **macOS runner**（Xcode 工具链限制）：注册自托管 Mac runner，或设 `IOS_SKIP=1` 跳过；
- Android 签名变量齐全时额外产出已签名 release APK。
- ⚠ 打包 vsix 必须带 `--baseContentUrl/--baseImagesUrl`：vsce 认不出 git.woa.com 的仓库归属，
  否则 README 里的相对链接会让它直接 ERROR 退出（`scripts/package-vsix.sh` 里已固化）。

细节（runner 注册命令、变量表、iOS 签名与分发）见 [`mobile/README.md`](mobile/README.md#ci每次提交自动出-android--ios-包)。

---

## 开发

```bash
npm run install:deps   # 只有一个依赖：qrcode
npm test               # 冒烟测试：App 静态服务 + RPC + SSE + 桥接（含安全边界断言）

# 打包与 CI 相关的动作全部走 scripts/（与流水线用的是同一套命令，清单见 scripts/README.md）
bash scripts/verify.sh         # 等价 CI 的 verify 阶段（npm ci + npm test）
bash scripts/package-vsix.sh   # 出 .ci/out/saros-pocket-<sha>.vsix，可直接「从 VSIX 安装」
bash scripts/build-android.sh  # 出 debug APK（需要 JDK 17 + ANDROID_HOME）
bash scripts/build-ios.sh      # 出未签名 IPA（仅 macOS）
```

> VsSaros 里还有一份**内置副本**（`extensions/saros-pocket/`），随 VsSaros 一起加载、无需安装；
> 它是从本仓库单向同步过去的（同步命令见 `extensions/saros-pocket/README.md` 顶部）。

模块分工：

| 文件 | 职责 |
| --- | --- |
| `extension.js` | 装配：状态仓库 → 事件总线 → VsSaros 桥接 → RPC/App 路由 → 代理服务 |
| `lib/bridge.mjs` | VsSaros 桥接：endpoint → vscode API（聊天/文件/命令/编辑器/通知），含开关与白名单 |
| `lib/rpc.mjs` | RPC 信封 + SSE 事件流（不做认证，依赖代理的 PIN 栅栏） |
| `lib/app.mjs` | `/pocket/` 静态资源（白名单文件 + 目录穿越防护 + 启动参数注入） |
| `lib/events.mjs` | 事件总线（VsSaros 侧事件 → SSE） |
| `lib/screen.mjs` | 桌面画面采集（Windows PowerShell 长驻抓屏 / macOS `screencapture` / Linux `import`·`ffmpeg`） |
| `lib/desktop-input.mjs` | 桌面输入转发（鼠标/键盘/滚轮，默认关闭，仅 Windows） |
| `app/` | App 前端（原生 JS，无构建；会话列表 / 当前会话 / 屏幕 / 变更 / 连接） |

### 品牌资源（统一用 VsSaros 同款 logo）

| 文件 | 用在哪 | 来源 |
| --- | --- | --- |
| `app/saros-logo.svg` | App 头部 + favicon、面板头部、登录页（data URI 注入） | VsSaros `resources/.agents/saros-logo.svg`（**与 titlebar 同一个文件**，372×126，橙 `#F86441` + 白） |
| `media/icon.png`（512²） | 扩展图标（vsix / 插件页 / 插件列表） | 由 `media/saros-mark.svg` 渲染 |
| `media/saros-mark.svg` | **方形 mark 定稿**（PNG 的源） | VsSaros `src/vs/sessions/browser/media/sessions-logo-dark.svg` 的同一几何（白底圆角 `rx=96` + 橙 `#FF5A2E`），**另加 1px `#D3D1C7` 描边** |
| `app/apple-touch-icon.png` | iOS「添加到主屏幕」 | `media/icon.png` 的副本（iOS 不认 SVG） |

三点说明：

- logo 放 `app/` 而不是 `media/`：**App 由代理静态托管**（`/pocket/saros-logo.svg`），文件必须在 `appDir` 内；
  面板与登录页复用同一份，避免多处拷贝漂移。
- wordmark 是**白字 + 橙**，只在深色底上可读 —— 登录页是浅色卡片，所以给它套了一条深色品牌条。
- 方形 mark 为什么带 1px 描边：纯白圆角块在**白底**（扩展卡片 / 商城 / 浅色 Dock）上没有边界，
  加一条极浅的 `#D3D1C7` 才看得出形状（黑底/深色 UI 上几乎不可见，无副作用）。
- 源 logo 更新后重渲图标（本地无构建依赖，用无头 Chrome；`file://` 直接读本地 SVG 即可）：

  ```bash
  chrome --headless=new --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 --window-size=512,512 \
    --screenshot media/icon.png "file:///$(pwd)/media/saros-mark.svg"
  cp media/icon.png app/apple-touch-icon.png
  ```

---

## 许可

GPL-2.0（与 dsh-pocket 一致）。详见 `LICENSE`。
