# DS Bot 三能力兼容设计：电脑操控 / 浏览器 / 本地 Agent

> 状态：**全部代码层已实施**（2026-11-09）：§4/§5/§6 的 P0–P2、自检聚合器挂进 CI 链、本地 Agent SSR 设置页、设置页卡片 / 会话头与详情引擎徽标 / 桌面浮动指示器与托盘停止。
> **真机接入（11-09 用户已授权重启）**：`dsh-compat-e2e.mjs --all` 在当前 dev app 上**23 项运行时自检真跑通**（主进程中继、presence 广播、截图、Host Cookie），
> 剩 L1 三步（把两个新插件装进 profile / profile 启用 / 重启 Host）与 L3 人工清单 —— 完整方案见 **§7.4**。
> 外部基线：`G:\CustomWorkspaces\AIProjects\DeepSeek-Bot\`（DS Bot，Apache-2.0，dsh `0.2.2-rc.1`）
> 本项目基线：随包 dsh `0.2.1-rc.2`（`dsh-plugins/dsh-compat.json:4`），`@vssaros/dsh-browser` `0.4.26`
> 目标：让本项目的 Bot 具备三类能力，同时与 DS Bot 的**设计/协议语义**对齐，而不是把它的插件搬进来。
>
> ⚠ 工作区长期有并发会话跑 `git clean` / `git checkout` ⇒ **未跟踪的新文件会被删**（本仓 `doc/群聊与记忆演化-复刻DeepSeekBot对照说明.md` 开头有同样的警告）。本文件请及时纳入版本控制或自行备份。
>
> **实施记录（2026-11-09）**：`dsh-plugins/test/llm-adapter-contract.test.mjs`（真实 rc.2 runtime，15/15 通过）、
> `dsh-plugins/vssaros-local-agents/`（P0 插件 + 3 个测试文件 29 项全绿）。
> ★ **实现口径修正**：插件**不**静态 import `@deepseek-ai/dsh-llm` —— 仓库根没有这份包，静态 import 会让
> `check-plugin-files` 的「入口真 import」变红；改为**零依赖 duck-typed adapter**，runtime 对 adapter 只按方法调用，
> 最少方法集由探针 ④ 钉住（见 §6.2）。插件默认 `enabled: false`（fail-closed），
> **尚未装进 profile、未重启 Host、未真机验证**。
>
> **第二批（同日）· §5 P0 电脑操控只读层**：`common/desktopControlProtocol.ts`（纯策略 11 项单测）、
> `electron-main/desktopControlRelay.ts`（loopback WS + token + 发现文件，只服务 9 个只读 method）、
> `app.ts:194,2026` 接线、`dsh-plugins/vssaros-computer/`（`computer(op)` + 23 项单测）、
> `dsh-plugins/check-computer-control.mjs`（25 项静态对账，含「中继不含输入注入代码」不变量）。
> tsgo 0 错误、8 组守卫全绿。★ **范围收缩**：P0 的「窗口/AX 树」只做到**本应用窗口级结构**
> （Electron `BrowserWindow` API，零新依赖、跨平台），OS 全量窗口枚举 / 控件级 UIA 树移 P1；
> 不抽 `nut-js`、不加 `.ps1`（避免随包登记与守卫链改动）。两个插件都**默认关闭、未装 profile、未真机验证**。
>
> **第三批（同日）· §6 P1 本地 Agent ACP/工具桥**：`lib/core/{queue,jsonrpc,mcp,acp,acpAdapter,approval,text}.js`
> + 4 个 ACP 内置引擎（opencode / kimi / hermes / gemini）+ `approve_agent_action` 审批工具；
> `test/acp.test.mjs` 10 项端到端（**真实 loopback MCP HTTP**：tools/call SSE 挂起 → dsh tool-call 三连 chunk
> → `role:'tool'` 结果回灌 → SSE 放行 → CLI 继续）。全插件 39 项 / 4 文件全绿、8 组守卫全绿。
> ★ 仍**未**做：stdio 版 MCP 工具桥、Codex app-server 驱动、图片输入、设置页/徽标（P2）；
> `approve_agent_action` 目前全局可见，P2 按会话 scope 收窄。
>
> **第四批（同日）· §5 P1 电脑操控后台输入**：主进程 `desktopInputService.ts`（**唯一**含 `nut-js` 的文件）、
> `desktopControlProtocol.ts` 加 `DESKTOP_DEFAULT_MAX_LEVEL='view'` / `isReadOnlyLevel()`、中继逐请求按
> **主进程自持最高档**裁决（不接受 Host 传档）、`app.ts` 显式 `maxLevel:'view'`；Host 侧新增
> `{grants,leases,gates}.js`（应用授权三态 / 60s 租约 / 完整执行闸 / 官方审批缝 fail-closed）与
> `p1-gates.test.mjs`（12 项）。守卫从「中继不含注入」升级为「注入只在独立 service + 默认档永不触发 +
> 两处开关都关」等 8 条不变量。
> ★ **默认仍是纯只读**：开 P1 后台输入必须同时改 `app.ts` 的 `maxLevel` 与插件 `config.allowBackground`；
> 本轮**两处都没开**。插件整体仍 `enabled:false`、未装 profile、未真机验证。
>
> **第五批（同日）· §4 浏览器兼容层**：`vssaros-browser/lib/core/alias.js`（12 个别名在 `runOp` 首行归一，
> 不注册第二套工具）、`core/screenshot.js` 加 180KB 体积闸并在存附件前拦截、
> `check-browser-compat.mjs`（别名对账 / 闸顺序 / 写盘路径不变量）、`test/compat.test.mjs`（5 项）、
> 版本 `0.4.26 → 0.4.27`。★ **第二条安全闸按实际源码修正**：本项目写盘路径本来就由
> `homeDir + safeHostSlug(host)` 固定构造、模型无路径参数 ⇒ 不新增 `pathGate.js`，改为静态不变量守卫。
> 浏览器插件既有 5 个测试文件与 11 组守卫全绿；**未重装插件、未重启 Host、未真机验证**。
>
> **第六批（同日）· §5 P2 逻辑层**：主进程 `desktopControlProtocol.ts` 加 3s 空闲门
> （`foregroundIdleRefusal`：NaN / Infinity / 读不到空闲时间一律拒）、中继解除 `foreground` 钳制并
> 逐请求过 OS 空闲门、`desktopInputService.ts` 加 `movePointer` 与 `activateApp`（**只置前本应用窗口**）；
> Host 侧新增 `core/handoff.js`（idle / pending / user 三态，接管期间全拒、交还给 followup、
> **不记录接管期间输入**）、前台租约、四个控制 op 在闸之前分派。`test/p2-handoff.test.mjs` 9 项、
> 策略单测 16/16、插件 44 项 / 5 文件全绿、守卫全绿、tsgo 0 错。
> ★ **明确未做**：桌面浮动指示器 / Bot 鼠标 overlay / 托盘停止 / 「让它继续 60s」按钮
> （aux 窗口 DOM 需真机验证且要改既有窗口贡献文件）⇒ 这些留在真机接入阶段。
> ★ 三处开关（主进程 `maxLevel`、插件 `allowForeground` / `allowHandoff`）**默认全关**，
> 产品行为仍与 P0 只读一致；插件整体也未装 profile、未重启 Host、未真机验证。
>
> **第七批（同日）· §6 P2 代码层收口 + 检查链收口**：`vssaros-local-agents/lib/core/images.js`
> （dsh `{type:'image', attachment}` → `attachments.readImage()` 取字节 → ACP
> `{type:'image', data:<base64>, mimeType}` ContentBlock）、`acp.js` 的 `session/prompt` 支持块数组、
> `adapter.js` 的 `resolveModel` **按真实能力声明** `inputModalities`、NDJSON 路径对图片给明确降级提示。
> ★ 刻意不迁移 DS Bot「声明 `['text','image']` 却只发 text」的已知不一致：只有
> `kind==='acp'` 且附件服务可用才宣称支持图；`images.test.mjs` 11 项逐条钉住这一点。
> 另新建 `dsh-plugins/scripts/run-dsb-compat-checks.mjs` 一键聚合 7 组守卫/测试（7/7 全绿）。
> ★ **挂链待办**：`package.json:19` 的 `check:dsh-plugins` 链在本轮仍被并发会话 staged 改动
> （新增 `verify:skill-catalog` 并调整链），硬挂会冲突 ⇒ 收敛后只需在链尾追加一行
> `&& node dsh-plugins/scripts/run-dsb-compat-checks.mjs`。
> ★ 仍未做：本地 Agent 设置页/徽标（要改 `vssaros-chat-surface` 的 React chunk 或
> `dshModuleContainers.ts` 登记表）、桌面指示器/托盘（aux 窗口 DOM）；ACP image 块形状**未真机验证**。
>
> **第八批（同日）· 挂链 + 设置页数据端点**：`package.json:19` 链尾追加
> `&& node dsh-plugins/scripts/run-dsb-compat-checks.mjs`（`run-checks.mjs --list` 解析通过、
> `check-plugin-files` / `check-plugins-tracked` 全绿）；`vssaros-local-agents/lib/core/settings.js`
> 提供 `ctx.provide('vssarosLocalAgents')` 服务：引擎检测列表（installed/version/signIn/models，
> **不泄露本地路径**）、Sign in 命令只复制不执行、自定义 agent 逐条校验、
> `refresh()` 重扫并经 `registration.replace()` 原子热换路由。`test/settings.test.mjs` 6 项。
> ★ 挂链的前提已核实：链内容与上一轮一致、`package.json` 无未暂存改动 ⇒ 一处精确链尾追加，
> 未覆盖他人 staged 改动。设置页**UI 呈现仍未做**，未来 UI 只需 `ctx.get('vssarosLocalAgents')`。
>
> **第九批（同日）· 设置页 UI 的低风险落地**：调研后确认两条常规路线都不适合本轮 ——
> `vssaros-mcp` 式独立 section 页面要改 `dshModuleContainers.ts` + `vssaros-skills/lib/index.js`
> + TS 测试 fixtures 共 4+ 个既有文件；`dsh.client` 卡片要进 boot graph，未收录会让**整批前端 chunk
> 被拒**（`check-dsh-plugin-sync.mjs` 事故记录）。改用第三条：`vssaros-local-agents/lib/core/page.js`
> 自贡献 `/x/local-agents/` 的 **SSR 页面 + HTTP API**（零 JS、严格 CSP、全量 XSS 转义、
> Host `requestRejection` 鉴权 + POST 同源校验 + 64KB 体长限制），`settings` 提到 `apply` 闭包
> 供页面与 adapter 共用；引擎列表 / 重新检测并热换路由 / 自定义 agent 校验 / Sign in 命令展示。
> `test/page.test.mjs` 5 项；版本 `0.1.0 → 0.1.1`。**只改插件自己的文件**，无 client chunk、
> 无模块登记表、无构建步骤。★ 代价：没有侧栏入口，需由宿主页面嵌入或直接打开该 URL；
> 侧栏卡片 / 徽标 / 指示器仍留真机阶段。
> ⚠ 既有问题（与本轮无关）：`check-host-singleton.mjs` 报 `vssaros-kb/lib/client.kbview.js`
> 打包了 React 实现；该文件未被本轮改动、该守卫也不在 `check:dsh-plugins` 链上 ⇒ 未擅自修改。
>
> **第十批（同日）· 用户指定的三项 UI**：
> ① **设置页卡片**：`vssaros-chat-surface/lib/client.modelAccounts.js` 的 `ModelsFooter` 既有 `<ul>`
> 加一张「本地 Agent」卡，链到 `/x/local-agents/`；零新 chunk、零新槽注册、`vssaros-accounts` 注册不变。
> 同步改入口 `CLIENT_BUILD_STAMP`（本仓硬规矩）、bump `0.2.340 → 0.2.341`。
> ② **引擎徽标**：会话头 `client.settings.js` 从会话模型选择投影读 route、Bot 详情
> `client.conversationViews.js` 从 `draft.model` 读，两处都用 `data-vssaros-local-agent-badge`，
> **读不到就不画**（不猜、不误标）。真源 `vssaros-local-agents/lib/core/badge.js`；
> chunk realm 只允许 `require("react")` ⇒ 两处各内联同形映射，新增
> `check-local-agent-badge.mjs` 静态对账三份。
> ③ **桌面浮动指示器 + 托盘停止**：新建主进程 `desktopControlPresence.ts`
> （独立 `BrowserWindow` + `Tray`/`Menu`，`setContentProtection(true)` 防自己入 Bot 截图，
> 空闲时零 UI，停止按钮靠 `will-navigate` 拦截、无需 preload bundle）。
> ★ 刻意避改 `dshFullWindowContribution.ts`：其 aux DOM 由 `check-dsh-new-window.mjs` 用
> 极严字面串守护，独立窗口同时满足两条硬规矩且不动巨型既有文件。
> 状态通道：中继加 `getStatus/stop/reportStatus` + WS 广播 + `onStatusChange`，
> `stop` 后锁住所有动作类（只读仍可用），`rearm()` 仅托盘可调；Host 侧用可选
> `presence` 注入上报（默认 `presenceEnabled:false`，带 800ms 短超时兜底）。
> 实测：tsgo 0 错、本地 Agent **63 项/8 文件**、电脑操控 **50 项/6 文件**、策略 **17 项**、
> 聚合器 **9/9 组** 全绿。
> ⚠ 并发归属：`check-chat-surface-chunks.mjs` 在交付末段转红，失败项为他人 10:57 改的
> `client.workbenchNav.js`（「缺 `__test.pickLatestSessionId`」+ 入口 mtime 竞态）；本轮未碰该文件，
> 聚合器在此之前 9/9 全绿 ⇒ 未替他人补半成品、未无限追着 touch 入口。
> ★ 三项 UI 的**运行时效果未经真机验证**（需重启 Host）：指示器是否真的不入截图、
> 徽标投影字段名是否匹配真实 session shape、托盘图标在打包版是否存在。

---

## 0. 结论摘要

**一句话**：浏览器不用改（已比 DS Bot 更贴本项目口径），本地 Agent 可直接复刻它的 seam（无需网关、无需升级 runtime），电脑操控是唯一需要从零新建的能力栈——但底层 native 能力本项目其实已经有了。

### 0.1 三条会改变方案走向的纠错

1. **`DeepSeek-Bot`（带连字符）与 `DeepSeekBot`（pnpm monorepo）是两个不同仓库**。本次调研对象是前者：`ds-bot/`（dsh 插件）+ `app/`（Electron 桌面）+ `browser-plugins/`（3 个 **dsh 插件**，不是 Chrome 扩展）。仓库自身 `README.zh.md:39-41` 与 `AGENTS.md:7-10` 写明它是「基于 dsh 的 bot 插件」。
2. **本项目 dsh `0.2.1-rc.2` 已经有 `ctx.llm.registerAdapter()` 与 `LlmAdapter` 抽象类**——实证在随包运行时 `node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:130,262`，实现在 `lib/index.js:1842`，`dsh-llm-pi-ai/lib/index.js:2952` 自己就在用；`AdapterRegistrationHandle.replace()` 也在（`:202-217`）。契约与 DS Bot 的 `LocalAgentAdapter` 完全对齐。⇒ **不需要造 OpenAI 兼容 HTTP 网关，不需要升级 runtime**。
   > 注意：只在本仓源码里搜 `registerAdapter` 会得出「没有扩展点」的**错误结论**——API 在随包 runtime 里，不在本仓源码里。
3. **本项目主进程已有电脑操控的底层**：`nut-js` 键鼠注入 + `desktopCapturer` 全屏采集（`src/vs/sessions/contrib/agentStudio/electron-main/remoteControlChannel.ts:402-512`），但它只服务 billd-desk 远程被控端，没有审批、没有工具注册、没有 Bot 入口。缺的是「策略层 + 工具层」，不是「驱动层」。

### 0.2 现状对照

| 能力 | DS Bot | 本项目 | 结论 |
|---|---|---|---|
| 浏览器 | 只读 `read_browser` 长轮询 + `refs/script/task` 三插件（Playwright + CDP over WS 接 Electron 视图） | 单工具 `browser(op)` 共 24 个 op，原生 CDP，右栏共享单页，`riskGate`/`grants`/`handoff`/`task`/`aria` 齐全 | **不改造**，只加薄兼容层 |
| 电脑操控（Bot 层） | 四档 + 应用租约 + 接管交接（策略层） | 完全没有；`computer_use` 只在 `bundledTools.ts:390-395` 元数据与技能文档里 | **新建** |
| 电脑操控（驱动层） | 上游 `@deepseek-ai/dsh-computer-use` + cua-driver（**不在其仓库内**） | `nut-js` + `desktopCapturer` 已有，但归远程被控 | **抽取复用** |
| 本地 Agent（seam） | `LocalAgentAdapter extends LlmAdapter` | rc.2 同一 API 已存在；插件 `inject=['llm']` 有先例（`vssaros-memory/lib/index.js:79`） | **直接复刻** |
| 本地 Agent（协议） | ACP / Codex app-server / Claude stream-json + 回环 MCP | 只有「工具调用」：`vssaros-memory/lib/coi/adapters.js:37-95`（kimi/codex/grok/hermes）+ 4 个 `*-cli-calling` 技能（命令手册）；**无 ACP/JSON-RPC 客户端** | **新建协议层** |
| 审批/授权/交接 | 官方审批缝 + 卡片 + 预授权 + 交接卡 | 同类基建齐备（`vssaros-browser/lib/index.js:437-545` 等） | **复用** |

---

## 1. 外部实现分析

> 下文 `DSB:` 前缀表示外部仓库 `G:\CustomWorkspaces\AIProjects\DeepSeek-Bot\` 下的相对路径；无前缀表示本项目。
> 所有结论来自源码与 `docs/plans/` 设计文档，不是从 README 推断。

### 1.1 电脑操控：DS Bot 只做策略，桌面 I/O 全在上游包

- **分层**：`DSB:docs/plans/2026-11-04-computer-use.md:11-17` 明确，DSH 提供方只负责「看」和「点」，把三件事留给调用方：①权限按谁管 ②共用一个桌面 ③看得见、能接管。运行时通过 `loader.import()` 动态挂载 `@deepseek-ai/dsh-computer-use` + 平台提供方（`DSB:ds-bot/src/host/computer/index.js:14-19,135-178`）。**仓库内没有一行输入注入自研代码**，也没有提供方包的源码或完整工具 schema。
- **模型工具面**：macOS 单工具 `cua{method,params}`；Win/Linux 一方法一工具、前缀 `cua_driver_native__`（`list_windows/get_accessibility_tree/screenshot/click/type_text/press_key/...`，`DSB:ds-bot/src/host/computer/catalog.js:22-42`）。截图走 DSH 工具结果的 image attachment 直接回模型，DS Bot 只记 `attachmentId` + MIME 白名单供 UI 出缩略图（`DSB:.../computer/index.js:789-798,1134-1143`）。
- **权限**：四档 `off/view/background/foreground`（`catalog.js:85-91`），未识别工具按最高档 fail-closed（`:46-61`）；应用授权按 Bot 持久化「拒绝 / 这一次 / 一直允许」（`index.js:559-652`）；受保护应用黑名单（自身、审批卡窗口、系统设置、凭据管理器）用户也不能授权（`:36-58`）；应用租约 + 前台租约 60s 空闲释放（`leases.js:1-65`）；用户活跃门（桌面版上报 `getSystemIdleTime()`，<3s 拒前台操作，`index.js:728-732`）。
- **人机协作**：`takeover` 中止在途并拒后续调用；`handback` 只 followup 一条「先看一遍再继续」，**不记录接管期间输入**；`computer_handoff{reason,note}` 复用浏览器交接卡（`index.js:821-909`）；付款/密码/有后果动作必须交人，界面文字一律当数据（`:911-931`）。
- **不做 / 限制**（`DSB:docs/plans/2026-11-04-computer-use.md:92-106`）：独立 VM、记录接管期间输入、手机实时画面、用 PTC 预设开电脑操作；Windows 后台 Chromium 收不到输入、管理员进程拒绝操作、cua driver 同进程崩溃连坐、租约只管自家 Bot。
- **文档缺口**：`DSB:SECURITY_MODEL.md:21-29,61-64` 的组件清单与威胁模型**完全没有电脑操控**。我们不要照抄这个疏漏。

### 1.2 浏览器：没有 Chrome 扩展，是两条链路

- **链路 A（默认只读）**：`read_browser` → Host 队列 → 客户端 HTTP 长轮询 `browser-wait/result` → 窗口 `executeJavaScript` → Markdown 正文 + `[#n]` 链接表回模型（`DSB:ds-bot/src/host/browser.js:24-233`）。无 CDP、无独立端口、无扩展。
- **链路 B（可操作）**：三选一插件 `refs / script / task`（`DSB:browser-plugins/refs|script|task/`），Playwright 驱动。桌面应用下 Host 经 `process.send` 向 Electron 换 `ws://127.0.0.1:<随机端口>/devtools/browser/<token>`，再 `chromium.connectOverCDP()` 连到 app 自己的 `WebContentsView`，与人看到同一组标签页（`DSB:app/src/bot-views.mjs:319-340,545-620`、`DSB:ds-bot/src/host/browser/session.js:96-110`）。**不接管用户真实 Chrome**；登录态靠一次性 cookie 导入（Chrome v20 app-bound 条目跳过，localStorage 不导）。
- **工具与定位**：13 个 `browser_*` 工具（`DSB:ds-bot/src/host/browser/refs.js:15-149`）；**只用 ARIA `[ref=eN]`** 定位，不用 CSS selector / 坐标；每步返回新 ARIA 快照（YAML，40k 截断）；截图 JPEG q32 转 attachment，>180KB 拒（`session.js:215-245,508-516`）。
- **安全**：`post/upload/download/delete` 四类动作需授权，站点 × 动作 × 时限预授权；删除强制二次 `confirm:true` + URL/label/nonce 核对；付款字段/按钮直接抛错；「结果未知」记账禁止盲重复；登录/验证码/付款走 `browser_handoff`（`DSB:docs/plans/2026-10-21-browser-plugins.md:20-31`）。
- **与电脑操控完全独立**：两套档位（`browserGrants` vs `computer.level`）、两套状态，只共用交接卡与「操控」设置分组（`DSB:docs/plans/2026-11-04-computer-use.md:17`）。

### 1.3 本地 Agent：把 CLI 伪装成模型路由（最值得借鉴）

- **seam**：`LocalAgentAdapter extends LlmAdapter`，`ctx.llm.registerAdapter(routes, adapter)`，`registration.replace(routes)` 支持热扫描（`DSB:ds-bot/src/host/local-agents/index.js:103-120`、`adapter.js:1-5,51`）。**dsh 的 loop、Session、工具、审批全部照常**，只有「模型 API 调用」这一步被换成「给 CLI 发 prompt + 把事件流翻译回 `StreamChunk`」。测试用真实 `ctx.agentLoop.create(...)` 验证（`DSB:ds-bot/test/local-agents-loop.test.js:35-44`）。
- **三种驱动**：ACP over stdio JSON-RPC（`acp.js`）、Codex app-server（`codex.js`）、Claude `stream-json`（`claude.js`）；10 个固定命令名表 + `existsSync` 探测（`engines.js:8-19`、`discover.js:75-89`），无全盘枚举、无登录态检测，`--version` 仅用于显示。
- **工具桥**：每个 CLI session 一个 `127.0.0.1` 随机端口 Streamable HTTP MCP Server + 32 字节 bearer token，只暴露 `initialize/ping/tools/list/tools/call`；`tools/call` 用 SSE 挂起，作为普通 DSH 工具调用发到流里，下一步的 tool result 回答挂起调用（`mcp.js:30-132`、`adapter.js:180-193,427-443`）。
- **审批 fail-closed**：CLI 的 `session/request_permission` / `*requestApproval` / `control_request` 转成 `approve_agent_action` → 正常审批卡；只有结构化 `{"decision":"allow"}` 且匹配 allow 类选项才放行，自由文本/解析失败/错误/拒绝一律 deny（`adapter.js:479-489`）。
- **上下文**：系统提示词作为**附加指令**（不覆盖 CLI 自己的），变更才重发；`session-title` / `compaction` 请求根本不启动 CLI（`adapter.js:19-49,296-313`）；压缩/steward 全跳过，交 CLI 自己（`DSB:ds-bot/src/host/parts.js:1179-1181`）；换引擎强制新 part、确定性交接包（`roster.js:417-426`）。
- **凭据归 CLI**：`cleanEnv()` 剔除 `OPENAI_API_KEY`/`ANTHROPIC_*`/`CLAUDE_CODE_*`/`DSH_*`/`DS_BOT_*` 等（`discover.js:9-24`）；设置页 Sign in 只是复制登录命令。**无进程沙箱**，靠 CLI permission mode + 审批卡。
- **不做 / 限制**（`DSB:docs/plans/2026-11-04-local-agents.md:73-85`）：无 ACP/等价 stdio 的 agent、stdio MCP 工具桥、代管 API key、改 CLI 配置；无 MCP-over-HTTP 的 CLI 拿不到团队工具；图片输入基本未贯通；`SECURITY_MODEL.md` 未覆盖该功能。

### 1.4 可迁移的五个设计母题

1. **能力按「身份」而非「会话」授权**：授权、租约、profile 都挂 Bot，换段/进群不丢。本项目身份是 `.agent.md`（声明式），不是 `state.json`。
2. **fail-closed**：认不出的操作按最高风险处理；审批通道不可用即拒；只有结构化 allow 才放行。
3. **交接卡统一**：浏览器与桌面共用一张卡、同一套 `login/payment/captcha/confirm/other` 原因枚举、同一「Bot 在操作 / 你在操作 / 等你处理」状态机。
4. **页面/界面内容一律是数据**：提示注入防线写进工具描述与系统提示，不是靠模型自觉。
5. **有后果动作永远交人**：付款、密码、发送、删除、发布；Bot 自己问「确定吗」不算授权。

---

## 2. 兼容性口径与不变量

### 2.1 三种「兼容」

| 口径 | 含义 | 决定 |
|---|---|---|
| ① 能力兼容 | 本项目 Bot 也能用这三类能力 | **主目标**，§4/§5/§6 |
| ② 设计/协议兼容 | 工具语义、审批、交接对齐，使 prompt / 技能 / 工作流可迁移 | **做**，用适配层，不改真源 |
| ③ 二进制兼容 | 直接安装 `ds-bot` 或 `browser-plugins/*` | **不做**。dsh 版本不同（`0.2.2-rc.1` vs `0.2.1-rc.2`）；身份模型冲突（它的 `state.json` 实例 vs 我们的 `.agent.md` 声明式）；工具名撞车；它的 per-Bot profile 隔离与用户 2026-11-05 明确口径「不做隔离，右栏显示浏览器内容」相反 |

### 2.2 六条不变量（改动前先钉住）

1. **不改 dsh 源码**。只走文档化插件 API / 主进程自有服务（`DSB:AGENTS.md:22` 也是这条硬规矩）。
2. **不做 per-Bot 浏览器隔离**。右栏 `RIGHTBAR_SHARED_VIEW_ID` 单一共享视图 + Global 登录态（`src/vs/sessions/contrib/dshHarness/common/dshRightbarCdp.ts:23-38`）。
3. **身份仍以 `.agent.md` 为真源**。`model` 走会话级选择（`dsh-plugins/vssaros-agents/lib/modelSelection.js:126-133`），不引入运行时身份实例。
4. **执行类能力不走页面桥**。`window.vssarosDsh` 安全模型明确禁止写入/执行（`dshPageBridgeProtocol.ts:8-18,797-806`）；桌面操控与本地 Agent 都不能挂到 preload 桥上。
5. **工具真源单一**。`browser` 只保留 `browser(op)` 一套工具定义；别名只做入参归一，不注册第二套工具（避免 `dsh-plugins/vssaros-browser/package.json:4` 注释警告过的同名碰撞）。
6. **可一键回滚**。每个新能力有独立总开关；关掉即撤工具、释放租约/进程，保留用户配置。

### 2.3 许可证与署名（容易漏，已有守卫）

DS Bot 是 Apache-2.0，本项目已有 `dsh-plugins/check-dsbot-notice.mjs`：

- 只要插件源码（`lib/**/*.js`、`dev/src/**/*.{ts,tsx,css}`）里写了 `ds-bot/src/<…>.js` 路径，就被判为**派生文件**，必须：①列在该插件 `NOTICE`；②`package.json` 的 `license` 含 `Apache-2.0` 复合声明；③`files` 含 `NOTICE`（`check-dsbot-notice.mjs:2-8,40-53`）。
- **本方案采取「借鉴设计、独立实现」**：协议层自己写，源码注释里**不要**贴 DS Bot 源路径；设计溯源写在本文件与 `NOTICE` 的说明性文字里即可。若后续确有逐行移植，先按守卫补齐署名再合入。
- 本文件是 `.md`，不在守卫扫描范围，可以正常引用外部路径。

---

## 3. 总体架构

### 3.1 分层

```
┌─ 模型（dsh Session / agent loop，保持不变）────────────────────────┐
│  browser(op)        computer(op)        model route = vssaros-<cli>/… │
└───────┬──────────────────┬──────────────────────┬──────────────────┘
        │                  │                      │  LlmAdapter（§6）
┌───────▼──────────────────▼──────────────────────▼──────────────────┐
│ dsh Host 插件进程（策略层：档位 / 授权 / 租约 / 审批 / 交接）          │
│   vssaros-browser 0.4.26 │ vssaros-computer（新）│ vssaros-local-agents（新）│
│   riskGate/grants/handoff │ 复用上面三件套 + appKey 维度 │ ACP/JSON-RPC + 回环 MCP │
└───────┬──────────────────┬──────────────────────┬──────────────────┘
        │ 发现文件+WS       │ 发现文件+WS（新）      │ spawn stdio / loopback HTTP
┌───────▼──────────────────▼──────────────────────▼──────────────────┐
│ Electron 主进程 / 本机                                                │
│  dshRightbarCdpRelay     DesktopControlRelay（新）  本地 CLI 进程       │
│  CDPBrowserProxy         nut-js + desktopCapturer   （CLI 自有登录/套餐）│
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 为什么选「发现文件 + loopback WS + token + 白名单」

本项目已有两套主进程↔Host 通道：

| 通道 | 证据 | 适用 |
|---|---|---|
| `ide.request` 反向桥（命名管道 JSON-RPC） | `dshBridgeProtocol.ts:6-23,167-190`；需清单声明 `vssaros.ideCapabilities` + 主进程授权 + 渲染端执行三关（`vssarosPluginManifest.ts:154-189`、`dshIdeRequestGate.ts:60`） | UI 命令类；**白名单封闭，没有桌面类 capability，且要经过渲染进程** |
| **发现文件 + loopback WS**（右栏 CDP 中继） | `app.ts:2013-2024`、`dshRightbarCdpRelay.ts:59-115,221-248`、`dsh-plugins/vssaros-browser/lib/core/rightbar.js:31-54` | 高频、二进制/图像、要求「人在同一视图里看得见」⇒ **桌面操控照这个范式** |

桌面操控是高频 I/O + 图像流，且不该经渲染进程，因此**复制右栏中继范式**，不扩展 `ide.request` 白名单。

### 3.3 双栈落点

- **dsh 侧为主**：Bots / 群聊 / 工作台的全部能力都落这里（用户当前主用形态）。
- **IDE 侧 agentStudio 为可选旁路**：若要让 IDE 自己的聊天也用本地 CLI，走 `IModelProvider`（`agentStudio/common/providers.ts:250-290`，`isServerSideProvider` 见 `:277-282`）或 `vscode.lm.registerLanguageModelChatProvider` 桥（`languageModelsBridge.ts:1467-1516`）；模型调用 seam 收敛在 `turnLlmStream.ts:107` 与 `piLoop/streamAdapter.ts:77`。**P0 不做**，避免两套 loop 同时改。

---

## 4. 设计 A：浏览器 —— 薄兼容层

### 4.1 现状与差距

`dsh-plugins/vssaros-browser/lib/index.js:111-127` 的 `KNOWN_OPS` 已有 24 个：
`status/snapshot/images/navigate/click/type/pressEnter/pressKey/scroll/back/reset/login/cookies/evaluate/waitFor/find/storage/media/screenshot/handoff/resume/task`。

对照 DS Bot，我们**已经覆盖**：ARIA `ref` 快照（`core/aria.js`）、`handoff/resume`、`grants` 时限授权、`task` ≤8 步内层循环、`riskGate`（拒 `file:/javascript:/chrome:` 与云元数据、支付一律拒、删除需 `confirm:true`+逐字 label、结果未知记账、页面内容只作数据）、`evaluate` 代替 `browser_exec`、右栏共享登录态代替 cookie 导入。

**真实差距只有三处**：

| 差距 | DS Bot | 我们 | 处理 |
|---|---|---|---|
| 工具形态 | 13 个 `browser_*` 多工具 | 单工具 `browser(op)` | 别名适配层（§4.2） |
| 截图体积闸 | >180KB 拒附加 | 未见等价上限 | 补（§4.3） |
| 上传/下载路径沙箱 | `realpath` 校验 + 文件名净化 + 防覆盖 | 未见等价实现 | 补（§4.3） |

> 不要为了「对齐」硬造需求：`read_browser` 只读长轮询与我们已有的 `snapshot/find/evaluate` 语义重叠；`browser_upload/download` 若现有 `media`/`cookies` 通道已够用，可不新增 op，只补**落盘校验**。

### 4.2 别名适配表（只在入参层归一）

| DS Bot 工具 | 归一到 `browser` | 备注 |
|---|---|---|
| `browser_open{url}` | `{op:'navigate',url}` | 走 `riskGate` 导航白名单 |
| `browser_snapshot` | `{op:'snapshot',format:'aria'}` | 我们 ARIA 是 opt-in |
| `browser_click{ref,confirm}` | `{op:'click',ref,confirm,label}` | 删除类仍需逐字 label |
| `browser_type{ref,text,submit}` | `{op:'type',ref,text}` | `submit` 忽略（不自动补 `pressEnter`，避免一调用两个动作） |
| `browser_press{key}` | `{op:'pressKey',key}` | |
| `browser_tabs{action,index}` | 无等价 | **不映射**（右栏单页口径，不建多标签） |
| `browser_screenshot` | `{op:'screenshot'}` | 已补体积闸 |
| `browser_handoff{reason,note}` | `{op:'handoff',text: note \|\| reason}` | 本项目 `handoff` 只收 `text` |
| `browser_resume` | `{op:'resume'}` | |
| `browser_task{goal}` | `{op:'task',goal,maxSteps}` | 已实现 |
| `browser_exec{script}` / `browser_upload` / `browser_select` | **不映射** | `evaluate` 替代脚本；另两个无等价 op |
| `read_browser{from}` | `{op:'snapshot'}` | 语义近似，`from` 忽略，不新建长轮询通道 |

**✅ 已实施（2026-11-09）**：`vssaros-browser/lib/core/alias.js`，`normalizeOpCall()` 在 `runOp` 的**第一行**归一，
未命中时原样返回。★ **别名只在入参层生效**：工具 schema 的 `op` enum 仍是 22 个原生 op，
模型侧只见一个 `browser` 工具；别名服务于迁移 DS Bot 风格的技能/工作流调用。
归一发生在所有 handler 与闸之前 ⇒ 换名字无法绕过 `isActionOp` / `riskGate` / 审批。

### 4.3 两条补齐的安全闸

1. **截图体积闸**：`core/screenshot.js` 输出前检查字节数，超过阈值（对齐 DS Bot 180KB）直接返回错误，不生成 attachment；参数保留 `quality`/`fullPage` 供模型降质重试。错误文案要给出「已拍到但过大，请降质重试」，别让模型误判为页面不可读。
2. **★ 范围修正（2026-11-09）：「落盘路径白名单」不新增代码**。调研实际源码后发现本项目的
   `cookieStorePath` / `storageStorePath` 由 `homeDir + safeHostSlug(host)` **固定构造**
   （`core/cookies.js:149-165`、`core/storage.js:55-60`），写盘用原子 tmp + rename + `0600`，
   **模型侧根本没有路径参数** ⇒ 再套一层 `pathGate.js` 是冗余代码。
   改为把这个更强的事实钉成 `check-browser-compat.mjs` 的静态不变量：
   「路径由 `safeHostSlug` 构造」「`index.js` 不含 `params.path/filePath/filename`」「写盘用构造出的 `storePath`」。
   这样防的是未来有人给模型开路径参数导致回归，而不是重复校验一个不可能出现的值。

### 4.4 明确不做

- 不引入 per-Bot profile / cookie 分区（不变量 2）。
- 不引入 `browser_exec` 脚本沙箱（`evaluate` 已等价且面更小）。
- 不接管用户真实 Chrome 进程；不新增 Chrome 扩展/native messaging。
- 不新增「站点黑名单」层：现有导航白名单（仅 http(s)、拒云元数据，`dshRightbarCdp.ts:89-136`）已是更强口径。

### 4.5 验收

- `check:rightbar-browser`、`dshBrowserPlugin.test.ts`、`risk-gate.test.mjs` 全绿，且 `KNOWN_OPS` 数量断言不变。
- 别名表逐条单测：每个别名归一后的 `op` 必须命中 `KNOWN_OPS`，危险别名（删除/付款）不得绕过 `riskGate`。
- 真机：右栏一页，模型用 DS Bot 风格工具名发起操作，人在同一页看得见；交接卡出现并可「我完成了」回灌。

**已实施部分的实测（2026-11-09）**：`vssaros-browser/test/compat.test.mjs` 5/5、
`check-browser-compat.mjs` 全绿；插件既有 5 个测试文件全绿、11 组守卫全绿；
版本 `0.4.26 → 0.4.27`（`check-dsh-plugin-sync` 按「待 F5」处理，未变红）。
真机项**未验证**（插件未重装、Host 未重启）。

---

## 5. 设计 B：电脑操控 —— 新建三层

### 5.1 组件与文件落点

| 层 | 新增/改动文件 | 职责 |
|---|---|---|
| 主进程 · 共享 service | **抽** `src/vs/sessions/contrib/agentStudio/electron-main/` 下 `remoteControlChannel.ts:402-512` 的 `loadNutJs()`/`toPixel()`/`injectInput()` 成 `desktopInputService.ts`；远程被控与中继共用 | native 键鼠 + 全屏采集，一处实现 |
| 主进程 · 中继 | **新** `src/vs/sessions/contrib/dshHarness/electron-main/desktopControlRelay.ts`；**新** `common/desktopControlProtocol.ts`；`app.ts` 启动点参照 `app.ts:2013-2024` | 发现文件、WS、token、命令白名单、窗口枚举/AX 树 |
| Host 插件 | **新** `dsh-plugins/vssaros-computer/`：`lib/index.js`（工具）、`lib/core/{relay,levels,apps,leases,gates,handoff,activity}.js`、`cordis.patch.yml`、`package.json`、`test/` | 策略层：档位/授权/租约/审批/交接/活动行 |
| 客户端 UI | 改 `vssaros-chat-surface` 交接卡 + Bots 设置「操控」分组；可选桌面浮动指示器 | 看得见、停得下 |
| 守卫 | **新** `dsh-plugins/check-computer-control.mjs` | 静态对账（见 §7.1） |

**P0 实际落地（2026-11-09）与范围收缩**：

| 文件 | 状态 |
|---|---|
| `src/vs/sessions/contrib/dshHarness/common/desktopControlProtocol.ts` | ✅ 纯策略：9 个 observe method、四档、fail-closed 拒绝、token 常量时间比较、受保护应用 |
| `electron-main/desktopControlRelay.ts` + `app.ts:194,2026` | ✅ 发现文件 `0600` + loopback WS + 随机 token + 逐请求白名单；**文件里没有任何键鼠注入代码** |
| `dsh-plugins/vssaros-computer/lib/{index.js,core/levels.js,core/relay.js}` | ✅ `computer(op)` 工具、`tools/pre-execute` 档位闸、截图转 DSH image attachment、生命周期释放 |
| `dsh-plugins/check-computer-control.mjs` | ✅ TS/JS 双份策略逐项对账 + P0 无注入不变量 + 接线与随包清单 |
| `desktopInputService.ts`（**唯一**含 `nut-js` 的文件）+ `lib/core/{grants,leases,gates}.js` | ✅ P1（默认不启用） |
| 前台档 / OS 空闲门 / 前台租约 / 接管交接三态 / 控制 op | ✅ P2（默认不启用） |
| PowerShell/UIA 全量窗口枚举、控件级 AX 树、桌面浮动指示器 / Bot 鼠标 overlay / 托盘停止 | ⬜ 真机阶段（需 aux 窗口 DOM 验证） |

**收缩理由与口径**：P0 的 `listWindows` / `getAccessibilityTree` 用 Electron `BrowserWindow.getAllWindows()`
只给**本应用窗口级结构**（`coarse:true` 明示），不是控件树；OS 全量窗口枚举与 UIA 需 PowerShell `.ps1`
+ 随包登记 + 守卫链改动，成本高且与「P0 零副作用」冲突，整体移 P1。`screenshot` 用
`desktopCapturer.getSources` 的 `thumbnail.toDataURL()` 转附件，**不内联 base64**。零新 npm 依赖。

### 5.2 数据契约

**发现文件** `<dataRoot>/dsh-run/desktop-control.json`（对齐 `IRightbarCdpEndpoint` 形状，`dshRightbarCdp.ts:40-48`）：

```jsonc
{
  "version": 1,
  "wsUrl": "ws://127.0.0.1:<随机端口>/desktop-control/vssaros/<token>",
  "pid": 12345,              // Host 侧校验进程存活
  "startedAt": "2026-11-08T…"
}
```

- 权限 `0600`（Windows 靠用户目录 ACL）；按 pid 清理陈旧文件；dispose 删除。
- `verifyClient`：仅 loopback、拒任何 `Origin` 头、token 常量时间比较（`dshRightbarCdp.ts:139-152`）；token 每次启动 `randomBytes(24)`。
- 协议：JSON-RPC 2.0，请求 `{id,method,params}` → `{id,result|error}`；图像作为 base64 + `mimeType` 返回，Host 侧转 DSH image attachment（**不塞进文本**）。

**命令白名单**（`desktopControlProtocol.ts` 导出纯函数 `desktopControlRefusal()`，单测覆盖）：

| 档 | 允许 method | 说明 |
|---|---|---|
| observe | `listApps / listWindows / getWindowState / getAccessibilityTree / screenshot / getScreenSize / getCursorPosition / checkPermissions` | 只读，不要租约 |
| background | `click / doubleClick / rightClick / typeText / pressKey / hotkey / setValue / scroll / drag / clipboardRead / showWindow / launchApp` | 不置前、不动可见指针 |
| foreground | `activateApp / movePointer` | 需前台租约 + 用户空闲门 |
| **永久拒绝** | `killApp / setConfig / startRecording / stopRecording / replayTrajectory / setAgentCursor*` | 对齐 `DSB:computer/catalog.js:69-83` |

未识别 method 一律按 `foreground` 判定并拒绝（fail-closed）。

**工具**：单工具 `computer(op)`，`KNOWN_OPS` 与上面白名单一一对应，参数 `{op, appKey?, windowId?, ref?, x?, y?, text?, key?, confirm?, label?, reason?, note?}`；`output.schema` + `render` 必填（`check-tool-definitions.mjs:36-55`）。

**状态文件** `<dataRoot>/computer-control.json`（与 `browser-grants.json` 分开，对齐本项目既有做法）：

```jsonc
{
  "enabled": false,
  "levels": { "<botId>": "off|view|background|foreground" },
  "grants": { "<botId>": { "<appKey>": { "name": "…", "grantedAt": "…" } } },
  "protectedApps": [ "…" ]   // 内置 + 用户不可移除
}
```

### 5.3 权限模型

1. **四档**：`off` 的 Bot 看不到工具也看不到系统提示段（`ctx.tools.restrict({deny})` + `systemPrompt.section`）；越档调用在 **执行前**拒，并告知当前档位与「用户可在 Bots 设置→操控修改」。只有用户能改档位与总开关（**不进任何 Bot 工具集**）。
2. **应用授权三态**：「拒绝」（本段对话不再问）/「这一次」（会话级 `once`）/「一直允许」（写 `grants`）。卡片永远出在 Bot 自己聊天里，群聊/IM 同收。撤销 grant 时清 `once`、中止在途操作。
3. **受保护应用黑名单**：VsSaros 自身、`dsh` Host 窗口、**审批卡所在窗口**、系统设置、凭据管理器、密码管理器。按进程名 + 窗口标题 + 可执行文件三套匹配；选中即拒，**用户也不能授权**（防止 Bot 点自己的审批卡或给自己加权限）。
4. **租约**：`app:<appKey>` + `foreground`，内存态，60s 空闲释放；回合结束 / stop / takeover 释放；不同应用可后台并行；只读调用不占租约。冲突时点名「X 正在用 Y」。
5. **用户空闲门**：主进程 `powerMonitor.getSystemIdleTime()` < 3s 且数据未过期（10s）时拒前台操作，指示器显示「等你停手 / 让它继续」，点了之后 60s 放行。
6. **用户确认**：动作类逐次问；官方审批缝 `ctx.get('approval').request({toolName,reason,displayReason,agent,callId})` 只认 `allowed-once`，**无审批通道 fail-closed**（`vssaros-browser/lib/index.js:437-545` 同款）。

### 5.4 安全闸与交接

- **直接复用** `vssaros-browser/lib/core/{riskGate,grants,handoff}.js`，把规则维度从 `host` 换成 `appKey`；授权键形如 `computer::<op>@<appKey>`，避免 IDE 侧同构读者误命中（现有 `browser::<op>@<host>` 已有这个前缀纪律）。
- 付款 / 密码 / 验证码 / 发送 / 删除 / 发布：坐标点击认不出来 ⇒ 由系统提示要求先 `computer_handoff`，**Bot 自己问「确定吗」不算授权**。
- 应用界面文字、窗口标题、剪贴板内容一律当数据（写进工具描述 + 系统提示段）。
- 工具结果只表示「已发出」，**Bot 必须重新观察再继续**；「结果未知」记账禁止重放（复用 `riskGate`）。
- `takeover` 中止在途、释放租约、状态置 `user`、拒后续调用；`handback` 清 hold + followup 一条「先看一遍再继续」；**不记录接管期间输入**。
- 每个操作一行活动（应用 + 动作 + 截图缩略图），「电脑」页保留最近 50 步与最近一张截图。

### 5.5 UI 硬规矩

> ✅ **P2 已实现（2026-11-09）**：桌面浮动指示器 / 托盘停止改用**主进程独立
> `BrowserWindow`**（`desktopControlPresence.ts`），不走 aux 窗口。理由：
> `dshFullWindowContribution.ts` 的 aux DOM 被 `check-dsh-new-window.mjs` 用极严字面串守护，
> 且「指示器不入 Bot 截图」需要 `setContentProtection(true)`（独立窗口天然可做）。
> 指示器 HTML 里按钮样式仍显式写 `cursor:pointer;pointer-events:auto`，与下面两条硬规矩同口径；
> 空闲时零 UI（不创建窗口/托盘）。**运行时效果未真机验证**。
> 下面的规矩保留给将来若要在 aux 窗口做指示器时逐条照做。

- 页面内交接卡复用 `vssaros-chat-surface` 现有卡片；工作台 CSS 色值必须带 `var(--)`（本项目既有守卫口径）。
- 若做**桌面浮动指示器 / Bot 鼠标 overlay** 并挂在 aux（子）窗口，必须遵守本项目踩过两次的两条硬规矩（`dshFullWindowContribution.ts` 的 `_installTitleBar` 是正确样板）：
  1. **用主窗口 `document.createElement`**，不能用 `container.ownerDocument.createElement`（子窗口 JS 上下文禁止 createElement）；
  2. **显式写 `pointer-events:auto`**（aux 容器 DOM 层默认 `pointer-events:none`，否则「看得见但拖不动」）。
- 指示器窗口 `setContentProtection(true)`，防止自己进入 Bot 截图；`focusable:false` + 点击穿透，不抢焦点。

### 5.6 分期与验收

| 期 | 范围 | 验收判据 |
|---|---|---|
| **P0 只读** ✅ 已完成 11-09 | 全屏截图、窗口级结构、四档中的 `view`、发现文件 + WS + 白名单、**不引入任何输入注入** | `computer(op)` 返回 attachment 与窗口级结构；`off` 档工具调用被拒；越档/pre-execute 被拒；中继拒非 loopback / 坏 token / 未知 method；单测全绿 |
| **P1 后台** ✅ 已完成 11-09 | 后台输入 + 应用授权三态 + 租约 + 审批 + 活动行 | 未授权应用必出卡；撤销即中止；两 Bot 抢同一应用被拒；审批通道不可用 fail-closed；受保护应用连用户都授权不了 |

**P1 验收实测（2026-11-09）**：`p1-gates.test.mjs` 12/12（含「审批拒绝/无审批服务 ⇒ 不打到中继且释放租约」、
「两 Bot 抢同一应用被拒」、「受保护应用连用户都不能授权」）、策略单测 13/13、插件 35 项 / 4 文件全绿、
`check-computer-control.mjs` 全绿、`tsgo` 0 错误。
★ 安全口径：**档位由主进程自持**，Host 请求不带 level，中继用 `min(配置档, 'background')` 裁决；
默认 `maxLevel='view'` ⇒ 逐请求强制只读、`desktopInputService` 永不被调用。守卫把这条钉成静态不变量。
| **P2 前台** ✅ 逻辑层已完成 11-09 | 置前/移动指针 + OS 空闲门 + 前台租约 + 接管交接三态 + 控制 op（**指示器/托盘 UI 未做**） | 用户活跃时前台操作被拒；`takeover` 后所有调用被拒；`handback` 后 Bot 重新观察；前台同一时间只给一个 Bot |

**P2 验收实测（2026-11-09）**：`p2-handoff.test.mjs` 9/9（含「handoff→动作被拒→用户 done→resume→恢复」、
「takeover 后全拒但控制 op 仍能交还」、「前台租约互斥」）、策略单测 16/16、插件 44 项 / 5 文件全绿、
守卫全绿、tsgo 0 错。
★ 空闲门**在主进程**，Host 无法豁免；读不到 OS 空闲时间（NaN）也一律拒绝前台动作。
★ `activateApp` 只置前 VsSaros 自己的窗口（不做 OS 全量窗口激活）——这是刻意的收窄。
指示器相关验收项（不出现在截图里 / 托盘停止）**随 UI 一起留到真机阶段**。

**P0 验收实测（2026-11-09）**：`desktopControlProtocol.test.ts` 11/11、`vssaros-computer` 23 项 / 3 个测试文件全绿、
`check-computer-control.mjs` 25 项全绿、`tsgo` 0 错误、8 组既有守卫全绿。守卫显式断言中继源码不含
`nut-js / injectInput / mouse.setPosition / SendInput` 等注入代码 —— 这是 P0 的**硬不变量**，不靠注释保证。

**平台口径修正**：P0 只用 Electron `desktopCapturer / screen / BrowserWindow`，天然跨平台；「Windows-first」的约束
从 P1 引入 PowerShell / UIA 时才生效，届时不支持的平台给 `unsupported` 并明确提示，不静默降级。

### 5.7 明确不做与已知限制

不做：独立 VM / 每 Bot 独立桌面、记录接管期间输入、手机实时画面、把档位挂到 PTC 预设、经页面桥或 `ide.request` 传桌面操作。

已知限制（写进设置页与文档，不藏）：管理员权限运行的窗口拒绝输入；后台 Chromium/Electron 常收不到输入；租约只协调本项目 Bot，别的程序仍能动同一桌面；AX 树覆盖率取决于目标应用；`nut-js` 加载失败时降级为「仅观看」（`remoteControlChannel.ts:414-418` 已有该行为）。

---

## 6. 设计 C：本地 Agent —— 复刻 seam

### 6.1 为什么不需要网关 / 升级 runtime

| 检查项 | 实证 |
|---|---|
| `LlmAdapter` 抽象类存在 | 随包 runtime `node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:130-197`，`lib/index.js:1670,2429` 导出 |
| `ctx.llm.registerAdapter(providers, adapter)` | 同 `index.d.ts:262`，实现 `lib/index.js:1842` |
| `handle.replace(routes)` 原子换路由 | 同 `index.d.ts:199-217`（`llm/adapters-updated` 事件在 `commitRoutes` 里发） |
| 上游自己在用 | `node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2952` |
| 插件能 `inject:['llm']` | `dsh-plugins/vssaros-memory/lib/index.js:79` |
| 插件能 import `@deepseek-ai/dsh-*` | `vssaros-browser/package.json:44-46` peerDependencies 惯例 |
| 方法契约与 DS Bot 对齐 | rc.2 的 `providerInfo/providerRetryPolicy/imageRequestPricing/listModels/resolveModel/stream` 与 `DSB:local-agents/adapter.js:63-114,196` 完全同名；DS Bot 未覆写 `prepareCall`/`imageRequestTarget`，用默认实现即可 |

⇒ **不需要**本地 OpenAI 兼容 HTTP 网关、**不需要**改 `vssaros-bridge` 的 `providers.sync`（`vssaros-bridge/lib/index.js:1253-1297` 那条是配置驱动 HTTP 路由，留给真正的 HTTP provider）、**不需要**升级 runtime（`dsh-compat.json:23` 记录 rc.4 启动即崩，profile 与 runtime 强绑定）。

**实证（2026-11-09）**：`dsh-plugins/test/llm-adapter-contract.test.mjs` 用官方 `dsh-app-boot.boot()` 在仓库内置
`dsh-runtime/0.2.1-rc.2/node_modules` 上真起 `llm` 服务，注册最小 adapter 并跑通 `runtime.stream()`，
15/15 全绿。另证实 `LlmAdapter.prototype.stream` 在运行时**不存在**（abstract 只在类型层），
基类有 `providerInfo/providerRetryPolicy/imageRequestPricing/imageRequestTarget/listModels/resolveModel/prepareCall` 默认实现。

### 6.2 组件与文件落点

**★ 实现口径修正（2026-11-09）**：插件源码**不静态 import** `@deepseek-ai/dsh-llm`。
仓库根 `node_modules` 里没有这份包（它只存在于 `<dataRoot>/dsh-runtime/<ver>/node_modules` 与仓库内置 runtime），
而 `check-plugin-files.mjs:217-252` 会在仓库根对每个插件「真 import 一次入口」⇒ 静态 import 必红。
dsh runtime 对 adapter 是 **duck-typing**：`prepareRoutes` 只调 `providerInfo()` / `providerRetryPolicy()`，
`adapterStream` 只调 `prepareCall()` / `stream()` ⇒ 插件用**零依赖普通对象**即可。
最少方法集 `providerInfo / providerRetryPolicy / listModels / resolveModel / prepareCall / stream`，
另补 `imageRequestTarget / imageRequestPricing`；由契约探针 ④ 长期钉住。

| 文件 | 职责 | 状态 |
|---|---|---|
| `dsh-plugins/vssaros-local-agents/lib/index.js` | `apply()`：动态 `inject(['llm'])`、扫描 CLI、`registerAdapter`、`ctx.effect` 释放 | ✅ P0 |
| `lib/core/engines.js` | 引擎表（codex / claude）、route 命名、自定义 agent 校验、`engineTable()` | ✅ P0 |
| `lib/core/discover.js` | `cleanEnv()` / `findExecutable()` / `searchDirs()` / `probeVersion()` | ✅ P0 |
| `lib/core/ndjson.js` | NDJSON 行解析、Codex/Claude 事件归一、`toChunks()`、`linesOf()` | ✅ P0 |
| `lib/core/adapter.js` | duck-typed adapter：prompt 组装、spawn CLI、流式翻译、abort、dispose | ✅ P0 |
| `test/{ndjson,adapter,discover-engines}.test.mjs` + `run-local-agents-check.mjs` | 29 项单测，fake CLI、零密钥 | ✅ P0 |
| `lib/core/{queue,jsonrpc,mcp,acp,acpAdapter,approval,text}.js` | ACP stdio JSON-RPC、跨 stream 多轮状态机、回环 MCP 工具桥、审批 fail-closed | ✅ P1 |
| `lib/core/images.js` | dsh 图片附件 → ACP image ContentBlock；NDJSON 路径明确降级；声明与实现一致 | ✅ P2 |
| `lib/core/settings.js` → `ctx.provide('vssarosLocalAgents')` | 引擎检测列表、Sign in 命令复制、自定义 agent 校验、`refresh()` 重扫 + `registration.replace()` 热换路由 | ✅ P2 |
| `lib/core/page.js` → `/x/local-agents/` | SSR 设置页 + JSON API：零 JS / 严格 CSP / XSS 转义 / Host 鉴权 / POST 同源 | ✅ P2（纯插件侧） |
| `vssaros-chat-surface`：ModelsFooter 卡片 / 会话头 / Bot 详情 | 设置页入口卡 + 两处引擎徽标（三份映射由 `check-local-agent-badge.mjs` 对账） | ✅ 已实现（改既有 React chunk，版本 0.2.341） |
| 主进程 `desktopControlPresence.ts` + 中继状态广播 | 托盘停止 / 重新允许 + 桌面浮动指示器（`setContentProtection`） | ✅ 已实现（独立窗口，未真机验证） |
| `vssaros-agents/lib/{stepMemory,memoryBus}.js` | 对 local route 跳过我方记忆复盘 / 压缩 | ⬜ P2 |

`package.json`：`peerDependencies["@deepseek-ai/dsh"]`（只声明、不 import）、`dsh.bundle.patch`、
**不写 `vssaros.module`**（避免触发 `DSH_BUILTIN_MODULES` 登记表）、`view.kind:'none'`；
`inject = []` + 动态 `ctx.inject(['llm'])`（静态写进 inject 会让 headless / tui profile 永久 pending）。
`cordis.patch.yml` 的 `config.enabled: false` ⇒ **默认关闭，fail-closed**；本轮**未**改任何既有文件、未挂检查链、未装 profile。

### 6.3 关键契约

```js
// install 骨架（形态对齐，实现独立）
const supported = () => typeof ctx.llm?.registerAdapter === 'function'
let registration
function applyRoutes() {
  if (!supported()) return                       // 老 runtime 明确降级，不假装支持
  const routes = [...found.keys(), ...customIds()]
  if (registration === undefined) {
    if (!routes.length) return                   // 首次注册至少要有一个 route
    registration = ctx.llm.registerAdapter(routes, adapter)
  } else registration.replace(routes)            // 原子热更新
}
ctx.effect(() => () => { void adapter.dispose(); registration?.() }, 'vssaros: local agents')
```

- **模型选择零改动**：`.agent.md` 写 `model: vssaros-codex/default`，由 `vssaros-agents/lib/core/agents.js:205-214`（`modelRouteOf`）+ `lib/modelSelection.js:126-133` 在 `agent/created` 时会话级选中；`vssaros-bridge/lib/index.js:298-308` 已补发 `llm/adapters-updated`，模型菜单能刷新。
- **route 命名**：`vssaros-claude-code` / `vssaros-codex-cli` / `vssaros-opencode` / `vssaros-acp-<id>`（自定义）；统一加 `vssaros-` 前缀，避免与 HTTP provider 路由撞名。
- **模型目录**：每个 route 至少一项 `CLI default`；ACP 从 `session/new` 的 `configOptions.model` 读，Codex 从 `model/list` 读，Claude 硬编码 `default/opus/sonnet/haiku`；`listModels()` 带按 route 失效的缓存。

### 6.4 CLI 探测与进程

- 固定命令名表 + `existsSync`（不做全盘 PATH 枚举、不调 `which`）；补齐登录 shell PATH、`npm prefix -g/bin`、`~/.local/bin`、`%APPDATA%\npm`、常见安装目录，结果缓存 60s；慢 `npm` 探测放后台不阻塞 Session（DS Bot 有 `local-agents-discover.test.js:8-32` 同类保证）。
- `spawn(bin, args[], { env: cleanEnv(), stdio:['pipe','pipe','inherit'], windowsHide:true })`：**数组参数、不走 shell**；自定义 agent 命令只允许纯程序名 / 绝对路径 / `~/…`，拒绝空格、NUL、换行。
- `cleanEnv()` 剔除 `OPENAI_API_KEY`、`ANTHROPIC_*`、`CLAUDE_CODE_*`、`GEMINI/GOOGLE/XAI_API_KEY`，以及 **`DSH_*`、`VSSAROS_*`、`DS_BOT_*`**（本项目额外要求），`ELECTRON_RUN_AS_NODE`。
- 进程空闲 10 分钟关闭但保留 CLI session id 供 `resume`；SIGTERM 5s 后 SIGKILL；插件卸载 `adapter.dispose()` 全关。
- 工作目录取 `agent.session.header.cwd` → Bot 工作目录 → 团队目录 → `tmpdir()`；**绝不把 `<dataRoot>` 当工作目录**。

### 6.5 工具桥 / 审批 / 上下文

- **回环 MCP**：每 CLI session 一个 `127.0.0.1` 随机端口 + 32 字节 bearer token；只暴露 `initialize/ping/tools/list/tools/call`；过桥工具名限定本项目团队工具白名单 + `approve_agent_action`；schema 扁平化去 `$ref/oneOf/const` 兼容挑剔 CLI；坏 token 401。
- **审批**：CLI 权限请求 → `approve_agent_action` → 官方审批缝 / 审批卡；**fail-closed**（只认结构化 `{"decision":"allow"}` 且匹配 allow 类选项）。群成员场景注意本项目口径：官方 `ask_user_question` 对群成员禁用，成员问用户走 `group_ask`（`vssaros-agents/lib/core/asks.js:1-13`）。
- **上下文**：系统提示词（含 dsh-memory 快照）作为**附加指令**，内容变化才重发；`session-title`/`compaction` 请求不启动 CLI，返回确定性结果；压缩交 CLI 自己，跳过我方 steward/压缩；换引擎强制新 part + 确定性交接包。
- **凭据与登录**：完全归 CLI；设置页 Sign in 只复制登录命令；错误码 `LOCAL_AGENT_MISSING / SIGNIN / QUOTA / EXIT` 进阻断修复卡。
- **图片输入** ✅ 已完成 11-09：dsh 的 `{type:'image', attachment: ImageAttachmentRef}` 经
  `attachments.readImage(ref)` 取字节，`acpPromptBlocks()` 按原顺序投影成 ACP
  `session/prompt` 的 `{type:'image', data:<base64>, mimeType}` 块（4 张 / 8MB 上限）；
  读图失败降级成明确文本，不静默丢。`resolveModel` **只在 `kind==='acp'` 且附件服务可用时**
  才声明 `inputModalities:['text','image']`；NDJSON 单轮路由保持 `['text']` 并给模型一条
  「当前引擎不支持图片」提示。★ 刻意不迁移 DS Bot「声明 image 却只发 text」的已知不一致。
  ACP image 块形状按公开 ContentBlock 规范构造，**未真机验证**（真机接入时按 CLI 实收形状校准）。

### 6.6 版本契约探针 —— ✅ 已完成（2026-11-09）

落点 `dsh-plugins/test/llm-adapter-contract.test.mjs`：`node <file>` 直跑、零 runner、跑前清 `NODE_OPTIONS`。
runtime 解析优先级 `DSH_RUNTIME_NM` > 仓库内置 `dsh-runtime/<最新>/node_modules` > dev 数据根；
找不到则明确 SKIP（干净检出不算回归）。用官方 `dsh-app-boot.boot()` 真起 `llm` 服务，
四层断言共 **15/15 通过**：

| 层 | 钉住什么 |
|---|---|
| ① 静态契约 | `GenerateOptions` 的 provider/model/messages/system/tools/signal/sessionId/purpose；`StreamChunk` 7 种类型；`registerAdapter` 与 `replace` 的类型声明 |
| ② 注册契约 | `registerAdapter → listProviders → replace（含空数组）→ DUPLICATE_ADAPTER → listModels → disposer → REGISTRATION_DISPOSED` |
| ③ 流式契约 | `runtime.stream()` 真打到 adapter，chunk 原样送出，`GenerateOptions` 字段完整透传 |
| ④ 零依赖契约 | **普通对象（不继承 `LlmAdapter`）** 也能完整服务一次 stream ⇒ 支撑 §6.2 的实现口径 |

结论：**rc.2 与 DS Bot 依赖的 0.2.2-rc.1 在这条 seam 上等价，方案不改道**。
唯一差异是 `stream()` 为抽象方法（运行时基类无实现），实现方必须自己给 —— 已显式断言，防止日后误判。

### 6.7 分期与验收

| 期 | 范围 | 验收判据 |
|---|---|---|
| **P0** | 契约探针 + 单引擎（`codex exec --json` 或 `claude -p`）+ 路由注册 + `.agent.md` 选模型 | 真实 dsh loop 跑通一问一答；`handle.replace()` 热更新；CLI 登录/配额错误有可读提示；探针单测常驻 |
| **P1** ✅ 已完成 11-09 | ACP stdio JSON-RPC + 回环 MCP 工具桥 + 审批 fail-closed + 会话映射 | CLI 能调用团队工具且结果回灌；权限请求出审批卡；拒绝/自由文本一律 deny；abort 能取消 turn 与挂起调用 |
| **P2** | 多引擎（含自定义 ACP）+ 设置页 + 徽标 + 图片输入 | 扫描/刷新/自定义校验；换引擎强制新 part；记忆复盘走团队默认模型 |

### 6.8 明确不做

- 不做无 ACP / 等价 stdio 协议的 agent 驱动；不做 stdio 版工具桥（只 HTTP）。
- 不代管 provider API key、不编辑 CLI 自己的配置、不检测 CLI 登录态。
- 不把 CLI 变成「整条 loop 外包」（`isServerSideProvider=true` 会丢掉 IDE 侧工具分层披露、审批卡、记忆注入与 `IModelDelta` 积分统计，见 §3.3）。
- 不在 P0 改 IDE 侧 `agentTurnExecutor` / `turnLlmStream.ts`。

---

## 7. 横切工程约束

### 7.1 守卫与检查链

- **单一清单**：`check:dsh-plugins` 的 `&&` 长链在 `package.json:19`；`dsh-plugins/scripts/run-checks.mjs:1-8,79-80` **直接解析这一条链**，不另存清单。⇒ 新守卫只挂 `package.json` **一处**，运行器自动跟上；不要复制第二份列表。
- ✅ 已落地的静态守卫（**均未挂链**，见下条待办）：
  - `dsh-plugins/check-computer-control.mjs`：TS/JS 双份策略逐项对账、发现文件契约、P1 注入隔离且默认只读、P2 OS 空闲门、控制 op 提前分派、随包清单；
  - `dsh-plugins/check-browser-compat.mjs`：别名归一后必命中 `KNOWN_OPS`、归一与体积闸都在闸前、写盘路径模型不可控；
  - `dsh-plugins/scripts/run-dsb-compat-checks.mjs`：一键聚合 7 组守卫/测试，**逐个跑完再汇总**，不因 `&&` 短路漏跑。
- ✅ **已挂链（2026-11-09）**：`package.json:19` 链尾追加 `&& node dsh-plugins/scripts/run-dsb-compat-checks.mjs` 一处；`run-checks.mjs --list` 解析通过，`check-plugin-files` / `check-plugins-tracked` 全绿。挂链前已核实链内容稳定且无未暂存改动，未覆盖他人 staged 改动。
- **范围修正**：设计稿里的 `core/pathGate.js` 与 `check-local-agents.mjs` **不新增** —— 写盘路径本来就由 `homeDir + safeHostSlug` 固定构造、模型无路径参数（§4.3）；「声明与实现一致」改由 `images.test.mjs` 的行为断言钉住，比静态 grep 更强。
- 守卫要能**反向突变自证**（故意删掉一条断言应红），且断言匹配代码形态而不是注释里的字符串；失败项写 stderr。
- 守卫脚本本身必须入库（`check-plugins-tracked.mjs` / `check-host-config.mjs` 会查链上脚本存在性）。

### 7.2 测试清单（按改动面跑，别信全量数字）

| 面 | 测试 |
|---|---|
| 中继策略 | ✅ `dshHarness/test/common/desktopControlProtocol.test.ts`（**17 项**：白名单、四档、P0 硬闸、拒绝名单、token、受保护应用、P2 空闲门与 presence 方法），对齐 `dshRightbarBrowser.test.ts` |
| 插件 | ✅ `vssaros-local-agents/test/{acp,adapter,badge,discover-engines,images,ndjson,page,settings}.test.mjs`（**63 项 / 8 文件**：fake CLI、零密钥；`acp.test.mjs` 起真实 loopback MCP HTTP 验证工具桥闭环；`images.test.mjs` 钉住图片声明与实现一致；`page.test.mjs` 验证 SSR 转义/CSP/鉴权/同源；`badge.test.mjs` 钉三份映射真源）；✅ `vssaros-computer/test/{levels,relay,index,p1-gates,p2-handoff,presence}.test.mjs`（**50 项 / 6 文件**：fake WS、假附件、假审批、假租约、接管三态、presence 上报与停止闸）；✅ `vssaros-browser/test/compat.test.mjs`（5 项） |
| 契约 / 一键 | ✅ `dsh-plugins/test/llm-adapter-contract.test.mjs`（15 项）；✅ `dsh-plugins/check-computer-control.mjs`（双份策略 + 注入隔离 + 空闲门 + presence 不变量）；✅ `dsh-plugins/check-browser-compat.mjs`；✅ `dsh-plugins/check-local-agent-badge.mjs`（三份引擎映射对账）；✅ `dsh-plugins/scripts/run-dsb-compat-checks.mjs`（**9 组**聚合入口，已挂 `check:dsh-plugins` 链） |
| 浏览器回归 | `dshBrowserPlugin.test.ts`、`dshRightbarBrowser.test.ts`、`risk-gate.test.mjs`、`check-rightbar-browser.mjs` |
| 编译 | `tsgo` 全项目 0 错（主进程 TS 改动还要单独 `electron-main` 口径） |

### 7.3 版本 / 生效路径 / bump

- 改插件**非入口文件**必须 bump 版本并重装两套 profile（dev `~/.vssaros-dev/dsh-home` 与产品 `~/.vssaros/dsh-home`），否则「改了没生效」。
- **Host 是 keepAlive**：装完插件要按规范重启 Host，注意本项目「杀 dsh Host = 整个 app 重启」，dev 走 `scripts/start-dev-app.mjs`。
- **主进程 TS 改动需整个开发版重启**，不随 `dsh plugin add` 生效；真机探针 `scripts/probe-*.mjs` 同理。
- 跑测试/守卫前清 `NODE_OPTIONS`（CodeBuddy 注入的 shim 会吞 stdout）；`run-checks.mjs` 已自带 `NODE_OPTIONS: ''`。
- 工作区有并发未提交改动：实施前先 `git status` 划清改动面；新增文件及时跟踪，避免被 `git clean` 删掉。

### 7.4 真机验证 checklist —— 分层方案（2026-11-09）

**自检脚本** `dsh-plugins/scripts/dsh-compat-e2e.mjs`：`--preflight` 只查文件不连进程；
`--all` 连运行中 dev app 跑运行时断言；`--all --wait 90` 用于重启后等 Host。
★ 脚本**只做只读验证**：不调 `stop`（会把中继锁进 stopped，只有托盘能 rearm）、不触发任何输入注入。

| 层 | 内容 | 命令 / 判据 |
|---|---|---|
| L0 静态 | 契约探针、插件单测、策略单测、14 组守卫、tsgo | `node dsh-plugins/scripts/run-dsb-compat-checks.mjs`（9/9 组） |
| L1 预检 | Node、runtime rc.2、4 个插件版本、profile 启用状态、`out/app.js` 编译产物、发现文件/端口/日志 | `node dsh-plugins/scripts/dsh-compat-e2e.mjs --preflight` |
| L2 运行时（自动） | 发现文件字段 + pid 存活、WS 握手、`getVersion` / `checkPermissions` / `getStatus` / `getScreenSize` / `screenshot` / `listWindows`、`reportStatus` → event 广播、Host auth 303+Cookie、SSR 页 CSP / JSON / 跨站 403 | `node dsh-plugins/scripts/dsh-compat-e2e.mjs --all` |
| L3 人工 | 见下方清单 | 逐条点选/观察 |

**当前实测基线（2026-11-09，未重启）**：`--all` = **23 通过 / 2 失败 / 1 跳过**。
★ 主进程侧**已在运行新代码**：`getVersion` 10 个 method、`checkPermissions.foregroundEnabled=false`、
`getStatus` 空闲态、`reportStatus` → event 广播、截图 128KB `dataUrl`、`listWindows` `self-only`、
Host auth 303+Set-Cookie 全部真跑通。
两个失败项都是「`vssaros-local-agents` / `vssaros-computer` 未装进 profile 且 `enabled:false`」；
1 个跳过是因此 `/x/local-agents/` 不注册（预期，非故障）。

**真机接入三步**（用户 2026-11-09 已授权重启；**时机**由用户定，因为重启会杀掉正在跑的
agent 会话 —— `dshHostSupervisor.ts:898-900`）：

```bat
:: 1) 装两个**从未装过**的新插件。
::    ⚠ 实测 `--all --dry vssaros-local-agents vssaros-computer` 回报「没有需要同步的插件改动」：
::       部署脚本只同步已有副本，装新包必须走官方 `dsh plugin add`（或通道 A 让 _ensurePlugin 自动装）。
::    通道 A（仓库标准通道，最不易错；但会 bump **所有**有差异的插件，并发会话改插件时慎用）：
node scripts\dsh-plugin-deploy.mjs --bump
::    通道 B（只装这两个；先指向 dev profile，否则可能落到 prod）：
set DSH_HOME=%USERPROFILE%\.vssaros-dev\dsh-home
node dsh-runtime\0.2.1-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile vssaros add file:G:/SarosWorkspace/sarosis-agents-client/dsh-plugins/vssaros-local-agents file:G:/SarosWorkspace/sarosis-agents-client/dsh-plugins/vssaros-computer
:: 2) 改运行期真源（**不改仓库默认**，测完可原样回滚）：
::    %USERPROFILE%\.vssaros-dev\dsh-home\profiles\vssaros\cordis.patch.yml
::    把 id: vssaros-local-agents / vssaros-computer 两行的 config.enabled 改成 true
:: 3) 重启 dev app（只杀 dev 专名，绝不 taskkill VsSaros.exe）
taskkill /F /IM "VsSaros Dev.exe"
node scripts\start-dev-app.mjs
:: 4) 等 Host 起来后自检
node dsh-plugins\scripts\dsh-compat-e2e.mjs --all --wait 90
```

★ F5 / `start-dev-app.mjs` 会自动 `transpile-client` + `dsh-plugin-deploy.mjs --changed`
（`start-dev-app.mjs:471-484,580-582`）；`dsh-home/host.json` 是当前 Host 的
`authUrl/origin` 真源（`dshHostSupervisor.ts:1303-1304`），日志里的历史 token 会 401。
★ 编译态检查查 `out/app.js` **内容**是否含 `DesktopControlPresence`，不用 mtime（本仓有假阴性先例）。
★ 启用只到「默认安全姿态」：`maxLevel:'view'` / `allowBackground:false` /
`allowForeground:false` / `allowHandoff:false` / `presenceEnabled:false` **保持不动**。

**L3 必须人工**（脚本无法断言）：① 审批卡「允许一次 / 拒绝」的实际 UI 与 deny-by-default；
② 托盘菜单「停止全部操控 / 重新允许」及对 Host 动作的阻断；③ 浮动指示器链接点击与
`setContentProtection` 是否真让指示器不入 Bot 截图；④ 托盘图标/窗口是否真的出现在屏幕；
⑤ CLI 真实登录态与套餐；⑥ 模型选择器里 `vssaros-*` 路由可见、`.agent.md` 选本地 CLI 后
真实 dsh loop 一问一答、abort 后进程收敛；⑦ 空闲门（用户活跃时前台被拒）与「用户接管」体感；
⑧ 总开关关闭后工具撤下、租约释放、用户配置保留；⑨ 浏览器右栏共享单页与隐藏视图截图。

**回滚**：profile patch 改回 `enabled:false`，必要时删
`.vssaros/plugins/<pkg>-<ver>-*`；`userData/dsh-home` 永不覆盖
（`dshHostSupervisor.ts:2130-2144`），登录态与配置不丢。

---

## 8. 路线图

| 顺序 | 事项 | 理由 |
|---|---|---|
| ① ✅ 已完成 11-09 | §6.6 `LlmAdapter` 契约探针 + §6 P0 插件（双引擎 NDJSON、路由注册、29 项单测） | 成本最低、零 native、复用已验证 seam；探针 15/15 + 单测 29/29 全绿。**默认关闭，未装 profile、未真机验证** |
| ② ✅ 已完成 11-09 | §5 P0 电脑操控只读层（主进程中继 + `computer(op)` 插件 + 双份策略守卫） | 复用右栏 CDP 中继范式；11 + 23 + 25 项测试全绿、tsgo 0 错。**默认关闭，未装 profile、未重启 Host、未真机验证** |
| ③ ✅ 已完成 11-09 | §6 P1 ACP + 回环 MCP 工具桥 + 审批 fail-closed（含 4 个 ACP 引擎） | 纯插件侧、无需重启；39 项单测全绿，MCP 工具桥端到端闭环已验证。**默认关闭，未装 profile、未真机验证** |
| ④ ✅ 已完成 11-09 | §5 P1 后台输入 + 应用授权 + 租约 + fail-closed 审批 | 受保护应用黑名单与审批闸先行；tsgo 0 错、P1 单测与守卫全绿。**两处开关都未打开，默认仍纯只读** |
| ⑤ ✅ 已完成 11-09 | §4 浏览器别名层 + 截图体积闸 + 写盘路径静态不变量（版本 0.4.27） | 兼容性收尾；插件既有 5 个测试文件 + 11 组守卫全绿，**未重装/未真机** |
| ⑥ ✅ 逻辑层已完成 11-09 | §5 P2 前台 / OS 空闲门 / 接管交接（**指示器 / 托盘 UI 未做**） | 三处开关默认全关；44 项单测、16 项策略、守卫、tsgo 全绿。UI 需真机验证，留真机接入阶段 |
| ⑦ ✅ 已完成 11-09 | §6 P2 代码层收口（图片输入）+ 7 组自检聚合器 | 声明与实现一致；50 项插件单测、聚合器 7/7 全绿 |
| ⑧ ✅ 已完成 11-09 | 聚合器挂进 `check:dsh-plugins` 链 + 设置页数据端点 `vssarosLocalAgents` | 链解析与 11 组守卫全绿；Refresh 经 `registration.replace()` 热换 |
| ⑨ ✅ 已完成 11-09 | 本地 Agent SSR 设置页 `/x/local-agents/`（纯插件侧，版本 0.1.1） | 零 JS / CSP / 鉴权 / 同源 |
| ⑩ ✅ 已完成 11-09 | 用户指定的三项 UI：设置页卡片 / 会话头与详情引擎徽标 / 浮动指示器与托盘停止 | 63 项 + 50 项 + 17 项测试、聚合器 9/9 全绿、tsgo 0 错；**运行时效果未真机验证** |

**至此路线图 ①–⑩ 的代码层全部完成，自检已进入 CI 链**。剩余只有**真机接入**，完整分层方案、
已实测基线（23 通过 / 2 失败 / 1 跳过）、三步命令与人工清单见 **§7.4**。
★ 用户 2026-11-09 已授权重启；重启时机由其决定（会杀掉正在跑的 agent 会话）。
★ 仓库内四个插件的版本与已装副本：`vssaros-chat-surface` 0.2.344（已追平）、
`vssaros-browser` 0.4.27（已追平）、`vssaros-local-agents` 0.1.1 与 `vssaros-computer` 0.1.0（**未安装**）。

---

## 9. 风险登记与未决问题

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **桌面输入注入放大 prompt injection 面**（远大于浏览器） | 受保护应用黑名单 + fail-closed 审批 + 交接状态机**先于** P1 落地；把电脑操控写进本项目安全模型文档（DS Bot 漏了这条） |
| R2 | rc.2 与 0.2.2-rc.1 的 `StreamChunk` / `GenerateOptions` 细节差异 | §6.6 探针；不升级 runtime（`rc.4` 有启动即崩记录） |
| R3 | `nut-js` 原生模块在打包版可用性 | P0 只做截图/AX 可绕开；`loadNutJs()` 已有「加载失败仅观看」降级 |
| R4 | AX 树覆盖率 / 后台输入在 Chromium/Electron 失效 | 设置页明示；只承诺 Windows-first；不承诺跨应用一致性 |
| R5 | 别名层诱发双工具注册 / 工具面膨胀 | 不变量 5 + 守卫断言「`KNOWN_OPS` 数量不变、工具定义唯一」 |
| R6 | 本地 CLI 子进程无沙箱 | 只承诺「CLI 自有 permission mode + 审批卡」；`cleanEnv` + 工作目录纪律；文档写明无进程隔离 |
| R7 | 并发会话覆盖 / 新文件被 `git clean` | 及时跟踪文件、实施前 `git status`、避免整文件重写 |

**待拍板**

- Q1：电脑操控是否要做**桌面浮动指示器**（aux 窗口）？不做则只用工作台内指示器，省掉 §5.5 的两条 DOM 硬规矩与一套窗口生命周期。
- Q2：本地 Agent 首批引擎范围？建议 `codex-cli` + `claude-code` 两家（本项目已有 `coi` 适配器与 `*-cli-calling` 技能基础），ACP 放 P1。
- Q3：IDE 侧 agentStudio 是否也要同源能力（§3.3 旁路）？建议**本期不做**，先收口 dsh 侧。
- Q4：浏览器别名层是否值得做？若没有外部技能/工作流要迁移，可直接跳过 §4.2，只保留 §4.3 两条安全闸。

---

## 附录 A：证据索引

**本项目**

| 主题 | 路径:行 |
|---|---|
| 随包 dsh 版本 | `dsh-plugins/dsh-compat.json:4` |
| `LlmAdapter` / `registerAdapter` / `replace` | `<dataRoot>/dsh-runtime/0.2.1-rc.2/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:130-197,199-217,245-262`；`lib/index.js:1670,1842,2429`；`dsh-llm-pi-ai/lib/index.js:2952` |
| 浏览器插件 | `dsh-plugins/vssaros-browser/package.json:2-4,44-46`；`lib/index.js:105-129,437-545,1028-1155`；`lib/core/{riskGate,grants,handoff,task,aria,routes,rightbar}.js` |
| 右栏 CDP 中继 | `src/vs/sessions/contrib/dshHarness/common/dshRightbarCdp.ts:23-48,50-87,89-152`；`electron-main/dshRightbarCdpRelay.ts:59-115,117-205,221-248`；`src/vs/code/electron-main/app.ts:2013-2024` |
| 页面桥不可执行 | `dshPageBridgeProtocol.ts:8-18,797-806`；`preload-dshView.ts:120-135,150-209` |
| 主进程能力三关 | `dshBridgeProtocol.ts:6-23,167-190`；`vssarosPluginManifest.ts:154-189`；`dshIdeRequestGate.ts:60` |
| 远程被控 native | `agentStudio/electron-main/remoteControlChannel.ts:402-512`；`package.json:198`（`@nut-tree/nut-js`） |
| ✅ 新增 · 本地 Agent P0 | `dsh-plugins/test/llm-adapter-contract.test.mjs`（契约探针）；`dsh-plugins/vssaros-local-agents/lib/{index.js,core/adapter.js,core/engines.js,core/discover.js,core/ndjson.js}`；`test/{ndjson,adapter,discover-engines}.test.mjs` |
| ✅ 新增 · 本地 Agent P1 | `vssaros-local-agents/lib/core/{queue,jsonrpc,mcp,acp,acpAdapter,approval,text}.js`；`test/acp.test.mjs`；契约依据 `dsh-runtime/0.2.1-rc.2/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:84-92,434-464` 与 `dsh-llm-pi-ai/lib/index.js:1589-1636` |
| ✅ 新增 · 本地 Agent P2 / 收口 | `vssaros-local-agents/lib/core/images.js`；`test/images.test.mjs`；`acp.js` 的块数组 prompt；`dsh-plugins/scripts/run-dsb-compat-checks.mjs`（7 组聚合）；图片附件依据 `dsh-runtime/0.2.1-rc.2/node_modules/@deepseek-ai/dsh-attachment/lib/types/types.d.ts:6-28,136-154` 与 `vssaros-memory/lib/notify.js:147-180` |
| ✅ 新增 · 挂链 / 设置页数据端点 | `package.json:19` 链尾聚合器；`vssaros-local-agents/lib/core/settings.js`（`ctx.provide('vssarosLocalAgents')`）；`test/settings.test.mjs`；`registration.replace()` 契约依据 `dsh-plugins/test/llm-adapter-contract.test.mjs` ② |
| ✅ 新增 · SSR 设置页 | `vssaros-local-agents/lib/core/page.js`（`/x/local-agents/`）；`lib/index.js` 的 `ctx.inject(['webServer','connection'])`；`test/page.test.mjs`；HTTP 鉴权样板 `vssaros-mcp/lib/index.js:258-301`；section 机制限制 `common/vssarosPluginManifest.ts:474-487` |
| ✅ 新增 · 三项 UI | `vssaros-chat-surface/lib/{client.modelAccounts,client.settings,client.conversationViews,client}.js`（卡片 / 徽标 / stamp，0.2.341）；`vssaros-local-agents/lib/core/badge.js` + `test/badge.test.mjs`；`dsh-plugins/check-local-agent-badge.mjs`；`dshHarness/electron-main/desktopControlPresence.ts`（Tray + 指示器）；`desktopControlRelay.ts` 的 `getStatus/stop/reportStatus` 与 WS 广播；`vssaros-computer/test/presence.test.mjs`；aux 硬规矩 `check-dsh-new-window.mjs:288-310` |
| ✅ 新增 · 电脑操控 P0 | `dshHarness/common/desktopControlProtocol.ts`；`electron-main/desktopControlRelay.ts`；`test/common/desktopControlProtocol.test.ts`；`app.ts:194,2026`；`dsh-plugins/vssaros-computer/lib/{index.js,core/levels.js,core/relay.js}`；`dsh-plugins/check-computer-control.mjs` |
| ✅ 新增 · 电脑操控 P1 | `dshHarness/electron-main/desktopInputService.ts`（唯一含 `nut-js`）；`vssaros-computer/lib/core/{grants,leases,gates}.js`；`test/p1-gates.test.mjs`；`app.ts` 的 `maxLevel:'view'` |
| ✅ 新增 · 电脑操控 P2 | `desktopControlProtocol.ts` 的 `foregroundIdleRefusal` / `DESKTOP_USER_IDLE_THRESHOLD_SECONDS`；中继的空闲门与 `movePointer`/`activateApp` 分派；`vssaros-computer/lib/core/handoff.js`；`test/p2-handoff.test.mjs` |
| ✅ 新增 · 浏览器兼容层 | `vssaros-browser/lib/core/alias.js`；`lib/core/screenshot.js`（体积闸）；`test/compat.test.mjs`；`dsh-plugins/check-browser-compat.mjs`；`package.json` 0.4.27 |
| Agent 身份 / 模型选择 | `agentStudio/common/builtinAgents.ts:122-137,159`；`common/agentMdFormat.ts:26-83,206-240,309-328`；`vssaros-agents/lib/core/agents.js:1-21,205-214,376-470`；`vssaros-agents/lib/modelSelection.js:41-59,84-133` |
| 分层披露 / 审批 / 记忆 | `agentStudio/common/{toolsetConfig.ts,toolSearchAssembler.ts}`；`browser/agentToolAssembly.ts:171-229`；`vssaros-agents/lib/core/asks.js:1-13`；`vssaros-memory/lib/index.js:63-79` |
| CLI 工具调用现状 | `vssaros-memory/lib/coi/adapters.js:1-95`；`coi/commands.js:238`；`coi/tools.js:115-133` |
| 守卫链 / 署名 | `package.json:19,49`；`dsh-plugins/scripts/run-checks.mjs:1-15,79-80`；`dsh-plugins/check-dsbot-notice.mjs:2-8,40-53`；`check-tool-definitions.mjs:36-55` |

**外部 DS Bot**（前缀 `G:\CustomWorkspaces\AIProjects\DeepSeek-Bot\`）

| 主题 | 路径:行 |
|---|---|
| 仓库定位 | `AGENTS.md:7-10,22,58-64`；`README.zh.md:39-41,126-154`；`SECURITY_MODEL.md:5-29,49-64` |
| 电脑操控 | `docs/plans/2026-11-04-computer-use.md:11-17,23-45,47-90,92-106`；`ds-bot/src/host/computer/{index.js,catalog.js,leases.js}`；`ds-bot/src/client/computer.js`；`app/src/{computer-indicator.mjs,computer-cursor.mjs}` |
| 浏览器 | `docs/plans/2026-10-08-browser-and-secrets.md`；`docs/plans/2026-10-21-browser-plugins.md:13-47`；`ds-bot/src/host/browser.js:24-285`；`ds-bot/src/host/browser/{mount,refs,session,task,loop}.js`；`app/src/{bot-views.mjs,bot-browser.mjs}`；`browser-plugins/README.md` |
| 本地 Agent | `docs/plans/2026-11-04-local-agents.md:14-85`；`ds-bot/src/host/local-agents/{index,adapter,engines,discover,jsonrpc,acp,codex,claude,mcp}.js`；`ds-bot/test/local-agents{,-loop,-discover}.test.js` |

## 附录 B：术语

- **DS Bot / DSB**：本文特指 `G:\CustomWorkspaces\AIProjects\DeepSeek-Bot\`；与 `G:\CustomWorkspaces\AIProjects\DeepSeekBot\`（pnpm monorepo）无关。
- **seam**：可替换的扩展缝。本文指 `ctx.llm.registerAdapter()` 这一个替换模型调用的点。
- **op**：本项目单工具 `browser(op)` / `computer(op)` 的动作参数；DS Bot 是「一动作一工具」。
- **appKey**：应用身份规范化后的键（进程名 / 可执行文件 / bundle id 三选一），用于授权与租约。
- **发现文件**：主进程写入 `<dataRoot>/dsh-run/*.json`、Host 读取并直连的握手方式（现有 `rightbar-cdp.json`，新增 `desktop-control.json`）。
