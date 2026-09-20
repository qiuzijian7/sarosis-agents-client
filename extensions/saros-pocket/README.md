# Saros Agents Pocket（VsSaros 内置副本）

> **内置说明**：本目录是 VsSaros 的**内置扩展**（`extensions/saros-pocket`），会随 VsSaros 一起加载，
> 不需要用户手动安装 vsix。唯一源（source of truth）仍是独立仓库
> `Saros-agents-pocket`；改动请先在那个仓库改，再同步过来。

同步（Windows）：

```powershell
# ★ 必须排除 package.json 与 README.md —— 内置副本这两份与源仓库**刻意不同**
#   （package.json 去了 publisher/repository/scripts；README 顶部有「内置说明」），
#   不排除就会被覆盖回去。
robocopy "G:\SarosWorkspace\Saros-agents-pocket" "G:\SarosWorkspace\sarosis-agents-client\extensions\saros-pocket" `
  /E /XD node_modules .git mobile test docs .codebase-memory `
  /XF *.vsix .gitignore .vscodeignore .gitlab-ci.yml package.json README.md
cd G:\SarosWorkspace\sarosis-agents-client\extensions\saros-pocket
npm install --no-audit --no-fund   # 运行时依赖 qrcode（已登记在 build/npm/dirs.ts）
```

内置副本与发布版（vsix）的差异：

- `package.json` 去掉了 `publisher` / `repository` / `scripts`（内置扩展不需要发布信息）；
- 不带 `test/`、`mobile/`、`docs/`（不进产品包）；
- 依赖由 `build/npm/dirs.ts` 里的 `extensions/saros-pocket` 条目在根 `npm install` 时安装。

---

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

App 不加载整个工作台，只通过两条通道与 VsSaros 通信：

| 通道 | 路径 | 用途 |
| --- | --- | --- |
| RPC | `POST /saros-pocket/rpc/<endpoint>` | 请求-响应：聊天、文件、命令、状态 |
| SSE | `GET /saros-pocket/events` | 服务端推送：聊天流式增量、VsSaros 侧事件 |

### App 能做什么

| 能力 | endpoint | 说明 |
| --- | --- | --- |
| 对话（模型直连） | `chat.send` / `chat.models` | 用 **VsSaros 里配置好的模型**（`vscode.lm`）聊天，流式增量经 SSE 实时回显 |
| 交给 Agent | `agent.send` | 把消息送进 **VsSaros 自己的 Agent 会话**（默认 `workbench.action.chat.open`，可配），带完整工具链执行 |
| 看信息 | `vsaros.info` / `pocket.status` | VsSaros 版本、工作区、当前编辑器、代理/隧道状态、能力开关 |
| 看文件 | `files.list` / `files.read` | 浏览工作区、读文本（默认 256 KB 上限，二进制拒绝） |
| 改文件 | `files.write` | **默认关闭**（`sarosPocket.allowFileWrite`） |
| 开文件 | `editor.open` | 在 VsSaros 里打开该文件 |
| 跑命令 | `commands.run` / `commands.list` | **仅白名单**（`sarosPocket.allowedCommands`，精确匹配；`sarosPocket.*` 始终允许） |
| 发终端 | `terminal.send` | **默认关闭**（`sarosPocket.allowTerminal`） |
| 通知 | `notify` | 在电脑上弹一条 VsSaros 通知 |

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
| 输入 | `desktop.input` | 鼠标点击 / 滚轮 / 按键 / 文本（**默认关闭**，`sarosPocket.allowDesktopInput`，仅 Windows） |

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
| `sarosPocket.agentCommand` | `workbench.action.chat.open` | 「交给 Agent」执行的命令 |
| `sarosPocket.agentMode` | `agent` | 「交给 Agent」的聊天模式 |
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
| `sarosPocket.allowDesktopInput` | `false` | 允许远程操作鼠标/键盘（仅 Windows） |

开关（局域网总开关、局域网密码、隧道模式/Token/域名、自定义 PIN）存于扩展的 globalStorage，可在面板内操作。

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
- 非安全上下文（http://IP）下 Safari 不保存 cookie，会导致握手循环——此时请用 Chrome/Edge，或改用公网 HTTPS 入口。
- **VsSaros 能执行代码，公网二维码/链接请勿泄露。**
- Pocket App 的 RPC/SSE 与网页共用同一套 PIN 与局域网开关（代理在鉴权之后才接管这些路由），不额外开认证口子。
- App 的**写操作默认全关**：`files.write` 需 `allowFileWrite`、`terminal.send` 需 `allowTerminal`、`commands.run` 只认白名单；文件读写一律限制在工作区根目录内（`..` 与跨盘符路径会被拒）。
- 聊天走的是 VsSaros 已配置的模型（`vscode.lm`）；若 VsSaros 未暴露该 API，App 会自动隐藏模型直连，只保留「交给 Agent」。
- **桌面画面会把你的屏幕实时发给连进来的设备**：默认只抓 VsSaros 窗口（`desktopMode=window`），可用 `desktopEnabled=false` 一键关闭；画面路由与 App 共用 PIN 栅栏。
- **远程键鼠默认关闭**：`sarosPocket.allowDesktopInput=false`，开启后可被远端点击/打字；坐标只能落在当前采集区域内，但不防「授权用户自己误操作」——公网使用时请谨慎。

---

## CI：每次提交自动出 Android / iOS 包

流水线见 [`.gitlab-ci.yml`](.gitlab-ci.yml)（远端是 git.woa.com，GitLab 形态）：

```
push → test（全量测试）→ build:android（APK） + build:ios（IPA）
```

- 原生工程（`mobile/android`、`mobile/ios`）**不入库**，由 CI 里的 `npx cap add` 生成；
- Web 产物来自根 `app/`（无构建），改前端提交即出新包；
- iOS 需要 **macOS runner**（Xcode 工具链限制）：注册自托管 Mac runner，或设 `IOS_SKIP=1` 跳过；
- Android 签名变量齐全时额外产出已签名 release APK。

细节（runner 注册命令、变量表、iOS 签名与分发）见 [`mobile/README.md`](mobile/README.md#ci每次提交自动出-android--ios-包)。

---

## 开发

```bash
npm run install:deps   # 只有一个依赖：qrcode
npm test               # 冒烟测试：App 静态服务 + RPC + SSE + 桥接（含安全边界断言）
```

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
| `app/` | App 前端（原生 JS，无构建；收件箱 / 会话 / 屏幕 / 变更 / 连接） |

---

## 许可

GPL-2.0（与 dsh-pocket 一致）。详见 `LICENSE`。
