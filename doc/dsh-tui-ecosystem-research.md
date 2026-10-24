# 调研 — 有没有现成的开源 dsh TUI / 多会话终端工作台

> 2026-10-22。结论先行：**有，而且有两类**（单会话 TUI 客户端 + 多会话终端工作台）。
> ⇒ 我们**不必自写 TUI**；但"**并排网格**多窗格"仍无现成实现 ⇒ 我们的价值在**编排层**。
> 本文只写**有出处的事实**（npm registry 元数据 / 官方架构文章 / 插件目录页），未验证项标"待实测"。

---

## 0. 结论

| 我们要做的事 | 有没有现成的 | 用什么 |
|---|---|---|
| 一个交互式 TUI（每格一个） | ★ **有，4 家开源** | 见 §1 |
| 多会话/多项目并排的终端工作台 | ★ **有 1 家高度重叠**（`dsh-tui-pro`） | 见 §2 |
| **并排网格**多窗格（每窗格一个 TUI）+ 收割/接管 | ✗ **没有** ⇒ **这是我们的差异化** | 自研编排层（薄） |

⇒ ★ **原计划里"自写 TUI 客户端"（工作量大头）可以取消** ⇒ 改成"格子里跑社区 TUI"。

---

## 1. 单会话 TUI 客户端（4 家，均 MIT）

| 包 | 最新版 | 形态 | dsh 版本耦合 | 仓库 |
|---|---|---|---|---|
| `@tomowang/dsh-tui` | **0.10.0** | out-of-tree **mode bundle**（叠在 `dsh-base` 上，像 `dsh-web-app` 一样），**自带四个模式的 preset**（standard/ptc/minimal/cordis 的 `presets/*.patch.yml`） | peerDeps 全为 **`@deepseek-ai/dsh-* ^0.2.1-rc.2`** ⇒ **离我们最近** | github.com/tomowang/dsh-tui |
| `@deepseek-harness-tui/dsh-tui` | 0.16.1 | **有 bin `dsh-tui`**（独立 CLI）+ bundle；Claude Code 风格，React 19 + Ink core（ported）+ `marked`/`highlight.js` | 旧版 peerDeps `^0.1.0-rc.6/7`；0.8.x 起改为**自带 `@dsh-std/*`**（workspace 依赖打进 tarball）⇒ 耦合更深 | github.com/ccch1mneyyy/dsh-TUI |
| `@dsh-tui/dsh-tui` | 0.1.2 | bundle（无 bin） | peerDeps `^0.1.0-rc.6` | github.com/dsh-tui/dsh-tui |
| `@lk251066/dsh-tui`（= **dsh-tui-pro**） | 见 §2 | 见 §2 | 见 §2 | github.com/lk251066/dsh-tui-pro |

**共同点**：都是 **out-of-tree plugin bundle**（不是 harness 的 fork）⇒ 装进一个 profile 即可用；官方插件目录（`dshpluginhub.ai` / `deepseekharness.io` / `dshhub.dev`）均有收录 ⇒ 官方生态在承认这条路线。
**能力**（社区描述）：像素鲸鱼顶栏、流式思考展开、底部实时状态行（TPS / 缓存命中率 / 上下文进度 / 推理等级）、Markdown 渲染、Tab 补全、`@` 文件引用、历史搜索、完整支持 Agent Preset / Skills / MCP / Goals / Todos / 子代理。

---

## 2. ★ `dsh-tui-pro` —— 最接近我们要做的东西

- npm **`@lk251066/dsh-tui`**；GitHub `lk251066/dsh-tui-pro`；**out-of-tree plugin bundle**
- 形态：**全屏终端工作台**（full-screen terminal workbench），"同时打开多个项目"
  - 一个**持久 Assistant 会话**（在项目工作区之外）
  - **活动项目会话按工作区分组**，固定侧栏
  - **只有聊天区滚动**（transcript-only scrolling）
  - 结构化视图：**thinking / tool / diff / plan / subagent**
  - 交互：Enter=steering、Tab=排队下一轮、Esc=取消前恢复最近排队消息、**双击 Esc=浏览 checkpoints**、Ctrl+O=tool/context 详情、Ctrl+R=展开 settled reasoning
  - 文件补全（`@` workspace files）、剪贴板图片附件（Alt+V，需模型支持 image input）
- 安装：`dsh plugin --profile tui add @lk251066/dsh-tui`（或 `dsh plugin --profile web add github:lk251066/dsh-tui-pro`）⇒ 之后 `dsh --profile tui` 启动
- ⚠ 终端要求：**内部宽度 < 65 列时侧栏会隐藏**，建议 ≥24 行
- ⚠ 包体同时带 TUI 插件本体与 `cordis.patch.yml` profile 层 ⇒ 不需要另一个 bundle

⇒ ★★ **这也解释了官方 `dsh --help` 里那句 `dsh tui`**：它指的就是"社区 tui profile"这个约定，**不是随包模板**（`--from-default-profile` 的可选只有 `acp/headless/sdk/sdk-minimal/web`）。

---

## 3. 官方架构事实（决定我们的编排层怎么写）

来源：DSH 架构解析（ai.lzw.me / 腾讯新闻转载）：
- **"TUI 通过 AppServerSession 接入同一套接口，VS Code 也被列为 app-server 客户端"**
- 多端共享的不是终端 UI，而是 **core 的执行语义** + **Thread / Turn / Item 的类型化合同**
- "DSH 的 Web 与 Headless Profile 同样复用 Cordis / Session / Agent 的基础合同，但**加载的默认插件集合不同**；**Profile 决定进程级宿主组合，Preset 决定每个会话用哪些工具/提示词/局部服务**"

⇒ 官方 runtime 侧也印证：`@deepseek-ai/dsh-client-connection`（客户端连接层）存在；`dsh-web` / `dsh-web-frontend` 是"web 客户端"形态。

⇒ ★ **含义**：**多客户端共享同一个 core 是官方设计** ⇒ 我们的工作台"编排 N 个 TUI"在架构上是被支持的路线。

---

## 4. 对我们方案的影响（改三处）

| 原方案 | 改成 | 理由 |
|---|---|---|
| ★ **自写 TUI 客户端**（`vssaros-tui`，3–5 天） | **格子里跑社区 TUI**（`@tomowang/dsh-tui` 或 `@lk251066/dsh-tui`） | 社区已把 UI/交互/状态栏做完 ⇒ **省掉本方案最大的一块工作量** |
| 自己管 PTY | 仍用**官方 `remote.terminal`**（不自造 pty） | 官方 `remote.terminal` 提供 create/attach/write/resize + 服务端 xterm 快照 + 双工流 |
| 跨进程协调层（看板+记忆） | **保留但降级**：因为 1 Host ⇒ 会话/记忆/看板天然共享，只需补"哪个格在跑哪条任务" | — |

⇒ **差异化收敛为**：**并排网格**（社区是侧栏单会话流）+ **收割/接管**（把产物归档到看板）+ **多格并行编排**。
⇒ 形态仍是**稿 A（网格工作台）**；但每一格不再是"我们的 TUI"，而是"**官方 PTY 里跑一个社区 TUI**" ⇒ 界面观感与社区 TUI 一致（Ink 渲染 ⇒ 我们的 xterm.js 直接显示它的 ANSI 输出 ✓）。

---

## 5. 待实测（阶段 0 探针，顺序变了）

| # | 事项 | 为什么关键 |
|---|---|---|
| **R1′** | ~~社区 TUI 是 app-server 客户端还是自带 Host 的 app？~~ ✅ **已实测（§7.1/7.2）**：自带 core 的独立 app；同 profile 多实例**可并行**（写锁是会话级） | — |
| **R2′** | ~~版本口径~~ ✅ **已实测（§7.3）**：tomowang 需 rc.2（`latest` 已是 rc.2）；dsh-tui-pro 是 0.1 代、与 0.2 不兼容 | — |
| **R3** | `remote.terminal.create()` 里能否直接跑社区 TUI 的 bin（PATH / `DSH_HOME` / 凭据） | 格位后端可行性 |
| **R4** | 每 Session 终端上限 **8** ⇒ 网格规模上限 | 6–8 格够不够 |
| R5 | `dsh-tui-pro`（多会话工作台）是否已覆盖"并排网格" ⇒ 若它有 ⇒ 我们的差异化要重新界定 | 避免重复造 |

---

## 6. 一句话

**不用自己写 TUI 了** —— 社区有 4 家现成的（MIT），其中 `@tomowang/dsh-tui` 的版本口径离我们最近（`^0.2.1-rc.2`），`@lk251066/dsh-tui`（dsh-tui-pro）已经是"多会话终端工作台"。
⇒ 我们的工作台收敛为**编排层**：官方 PTY + 社区 TUI + 收割/接管 + 并排网格（社区没有的那部分）。

---

## 7. ★ 阶段 0 实测结果（2026-10-22）

> 全部在一次性目录 `~/.vssaros-dev/tmp/probe-tui/` 里做：独立 runtime（`@deepseek-ai/dsh@0.2.1-rc.2`）+ 独立 `DSH_HOME`；**没碰** dev / 生产 profile，**没发任何消息**（不耗模型调用）。

### 7.1 R1′：社区 TUI 是**自带 core 的独立 app**，不是 Host 客户端 —— 已实证

| 证据 | 内容 |
|---|---|
| tomowang `cordis.patch.yml` 头注释原文 | *"It mounts **no Host, HTTP server, Web runtime**, or browser plugin. … the interactive runner **creates or resumes an Agent through the core registry** and drives it from the TTY."* |
| `--dump-config` 组合结果 | `dsh-base` 的 agent / session / **session-persistence-jsonl** / credentials / llm 全在 TUI 进程里；`dsh-host-webserver` / `dsh-api-session-controller` / `frontend-static` **一个都没有** |
| 两包源码检索 | `host.json` / `WebSocket` / `fetch(` / `127.0.0.1` / `--connect` **0 命中**；tomowang 的命令行只有 `--resume` 与 `--agent-preset` |
| 运行时 | 两实例运行中，DSH_HOME 里**没有** `host.json` / `host-port.json` |

⇒ **格子 = 一个独立的 dsh 进程**（进程内跑 core），**不能**连到 IDE 的那个 Host，也不能被别人连。
⇒ 我上一轮"N 格 = 1 Host + N 客户端 ⇒ 写租约问题消失"的推断**不成立**；但下面 7.2 证明这**不影响并行**。

### 7.2 并发：同一 profile 两实例同时跑 —— ✅ 可行

PTY 里同时起两个 `dsh --profile tui`（同一 DSH_HOME、同一 profile）：

```
[A] session f638fcd0-… · deepseek-official/deepseek-flash · Standard mode · idle · 3 events
[B] session 88cb81ea-… · deepseek-official/deepseek-flash · Standard mode · idle · 3 events
```

两个都正常进入交互界面、各自一条独立会话、互不干扰。

**写锁粒度 = 会话目录**（不是 profile）：`dsh-session-persistence-jsonl/lib/index.js:671-717` 的 `SessionWriteLease.acquire(dir, id)` 锁 `<会话目录>/session.lock`（Windows 是命名内核信号量，POSIX 是 flock；持有进程退出即释放、**不做过期**）⇒
- **不同会话可以任意并行**（网格每格一条会话 ✓）
- **同一会话同时只能有一个写者** ⇒ 两格不能同时写同一条会话；"接管"必须先关掉原来那格（⚠ 未用 `--resume` 实抢验证：空会话不落盘，没目标可抢；锁机制本身已在 2026-10-13 生产事故里实证过）

### 7.3 R2′：版本耦合 —— 严格 semver 判定

| 包 | 依赖的官方包 | 我们 rc.1 runtime 严格满足 | 结论 |
|---|---|---|---|
| `@tomowang/dsh-tui@0.10.0` | 37 个 | **2 个**（35 个要 `^0.2.1-rc.2`，rc.1 不满足） | 需要 **rc.2**；`@deepseek-ai/dsh` 的 `latest` 已是 **0.2.1-rc.2** ⇒ 升一档即可 ✓ |
| `@lk251066/dsh-tui@1.8.3`（dsh-tui-pro） | 33 个 | **1 个**（要 `^0.1.0-rc.8` ⇒ 0.1 那一代）+ `dsh-invariants` 在 0.2 里**已不存在** | ✗ **与 0.2.x 不兼容**，现阶段不能用 |

⇒ **选 `@tomowang/dsh-tui`**，前提是格子里的 dsh 用 **rc.2**。

### 7.4 其它实测细节

- `dsh plugin --profile tui add …` 会报一长串 peer 警告 —— 这是 profile 级 pnpm 的常态（官方包由 runtime 提供，不装进 profile；我们的 vssaros profile 也一样），**不影响运行**。
- TUI **要求 stdin/stdout 都是真 TTY**（管道会 fail loud，批处理请用 `--profile headless`）⇒ 格子必须是 PTY（官方 `remote.terminal` 正是 PTY ✓）。
- PTY 库现成：runtime 里自带 `node-pty@1.2.0-beta.15`（rc.1 / rc.2 都有）。
- ⚠ Windows ConPTY 下 `node-pty` 的 `pid` 是 **0** ⇒ 不能用 pid 结束格子进程，要靠 `pty.kill()` / 关闭 PTY 句柄（编排层清理逻辑要按这个写）。

### 7.5 对架构的修正

| 原推断 | 实测后 |
|---|---|
| N 格 = 1 Host + N 客户端 | **N 格 = N 个独立 dsh 进程**（每个进程内带 core），共享同一个 **profile 目录 + DSH_HOME**（会话/凭据/设置是磁盘共享，不是进程内共享） |
| 写租约问题消失 | 写锁是**会话级** ⇒ 不同格并行无冲突；同一会话只能一个写者 ⇒ "接管"= 先关原格再 `--resume` |
| 共享会话/记忆"几乎免费" | 会话列表/历史靠**同一 DSH_HOME 的磁盘**共享（新格 `--resume` 就能接着跑）；我们插件的 Host 侧服务（看板/记忆/知识库页面）**不在** TUI 进程里 ⇒ 要让 TUI 也有这些能力，得把我们的插件装进 `tui` profile（**未验证**，见 7.6） |
| IDE 的 Host 能"看到"格子里的会话 | 可以从磁盘读到（同一 DSH_HOME 时）；但**实时流**只在格子进程里 ⇒ 网格看实时输出必须看 PTY（这正是稿 A 的形态 ✓） |

### 7.6 ★ R3 结论：**官方 terminal 协议是"纯文本屏幕"模型 ⇒ 颜色会丢 ⇒ 格子改为自管 PTY**

**协议实测**（`dsh-api-terminal-controller/lib/typert.host.js`，客户端 ⇄ Host 的 remote）：
- `terminal.create(sessionId, {shellPath?, id, cols, rows})` → `{id, title, shell, state, exitCode?}`
- `terminal.attach(sessionId, terminalId)` → 双向流：上行 `write` / `resize`；下行 **`snapshot{sequence, screen: string, info}`** + `ack`
- `terminal.environment(sessionId)` → `{cwd, maxCols, maxRows, scrollback, maxInputBytes, maxBufferedBytes}`
- `terminal.list / shells / close`
⇒ ★ **下行给的是 `screen: string`（服务端 xterm 解析后的纯文本屏幕），协议里没有 ANSI 样式** ⇒ 颜色信息在通道里就丢了。

**社区 TUI 输出的实测统计**（node-pty 抓原始字节，12 秒，不发消息）：

| 指标 | 值 | 含义 |
|---|---|---|
| `sgrColor` | **126**（其中 truecolor **58**） | TUI **大量用颜色** ⇒ 走官方通道会**全变无色文本** ✗ |
| `altScreen` | **0** | ★ 没用 alternate screen ⇒ 不必处理屏幕切换 ⇒ 纯文本快照**可行** ✓ |
| `cursorMove` / `erase` | 4 / 80 | 有光标定位与擦除 ⇒ 需要**完整 ANSI 解析**（不是去转义） |
| printable / bytes | 1025 / 3628 | 约 72% 是控制序列 |

⇒ ★ **决策：格子自己管 PTY**（Host 侧用 runtime 自带的 `node-pty@1.2.0-beta.15` 起 `dsh --profile tui`，把**原始 ANSI 字节流**推给页面，浏览器端用 xterm.js 渲染）。
- 好处：颜色完整 ✓；不受"每 Session 8 终端"限制 ✓；**不需要占用 dsh 会话**（官方 terminal 是按 sessionId 的）✓；与"每格一个独立 dsh 进程"的实测模型一致 ✓。
- 代价：自己实现"起进程 → 推流 → 收键鼠 → 结束"的通道（我们插件已有同类页面路由可抄结构）；客户端要引入 xterm.js 渲染（官方 `dsh-client-ui-sidebar-terminal` 里有打包好的 xterm 可参照）。
- ⚠ 官方 terminal 通道仍值得用于**会话内的普通 shell**（不需要颜色的场景），两者并存。

### 7.7 ★ R4：多开的资源成本 —— **每格 ≈ 39MB**（实测）

同一 profile 起 N 个 `dsh --profile tui`（空闲、不发消息），量 node 进程工作集总和（tasklist 差值法）：

| 状态 | node 进程数 | 工作集合计 |
|---|---|---|
| 基线（0 个 TUI） | 21 | 2764MB |
| 1 个 TUI | 22 | 3176MB（+412MB，含首次模块加载的一次性开销） |
| 6 个 TUI | 27 | 3373MB（5 个增量仅 +197MB） |

⇒ **每格 ≈ 39.4MB** ⇒ 12 格 ≈ 0.5GB、24 格 ≈ 1GB（空闲态；跑任务时会更高）⇒ ★ **资源上完全撑得住 12+ 格** ⇒ 真正的上限变成"屏幕放得下几格"与**模型并发配额**（我们自己的委派运行时并发上限是 8）。
⇒ 官方"每 Session 8 终端"这条限制在自管 PTY 后**不再是约束**。

### 7.8 ★ R6：我们的插件能否进 TUI —— **能，而且 rc.2 兼容无问题**

**R7 的答案（顺带拿到）**：用 **rc.2 runtime** compose 我们**真实的 vssaros profile**（30+ 插件）⇒ **完全成功**，`@vssaros/dsh-agents` 的 patch 层正常生效 ⇒ ★ **没有 rc.1/rc.2 兼容问题** ⇒ **dev runtime 不需要升级**（格子进程用独立的 rc.2 runtime 即可 ⇒ dev 环境零改动 ✓）。

**装进 tui profile 的两个坑**：
1. ⚠ **不能用 `dsh plugin add <源码路径>`**：那会写成 `link:` 依赖 ⇒ dsh 解析 bundle 时报 `cannot resolve profile bundle "@vssaros/dsh-agents"` ⇒ ★ 必须按 IDE supervisor 的规则装（暂存目录 + `file:<暂存目录>`）⇒ 用仓库的 `install-plugin.mjs`（参数 `<pluginDir> <dshHome> <profile> [dshBin]`）✓。
2. ⚠ `dsh plugin add` **不会**自动把包追加进 `dsh.profile.bundles`（只有声明了 `dsh.bundle.patch` 的包会）⇒ 我们的插件**是** bundle（`package.json` 里有 `dsh.bundle.patch` ⇒ 指向 `cordis.patch.yml` + `cordis.presets.yml`）⇒ 用 `file:` 形式装就会自动进 bundles ✓。

**装成功后的 compose 结果**（rc.2）：
```
# == @tomowang/dsh-tui, patched by @vssaros/dsh-agents     ← ★ 我们的 patch 层叠在社区 TUI 之上
- id: agent-preset-registry ...
# == @vssaros/dsh-agents
- id: vssaros-agents ...
- id: preset-vssaros-standard ...
```
⇒ ★ **TUI 格与我们的模块（agent 名册、我们的标准档 preset、工具）可以共存** ⇒ 格子里可以用我们的 Bot 与标准模式。

### 7.9 ★ TUI **真跑**时我们插件的表现（实测，含一次失败与修正）

**第一次只装 agents（13 个模块没装）⇒ 满屏 `never started`**：
```
vssaros-skills / vssaros-kanban / vssaros-kb / vssaros-memory / vssaros-media /
vssaros-workflow / vssaros-codebase / vssaros-pele / vssaros-dashboard /
vssaros-ide / vssaros-web-content-import / vssaros-mcp: never started
```
⇒ 我们的标准档 preset 引用了 13 个我们的模块 ⇒ **tui profile 必须带齐我们的模块**，否则格子里用我们的标准档就是残废的。

**装齐 29 个我们的 bundle 插件后复测**（`install-plugin.mjs` 批量装进一次性 tui profile，成功 29/失败 0）：
- `never started` **全部消失** ⇒ 我们的模块在 TUI 进程里**都启动了** ✓
- 剩下的诊断只有两条，且**都是预期的**：
  - `vssaros-bridge: pending (waiting for services: webServer, connection, workspaceRegistry, sessionController)` ⇒ ★ TUI 里没有 webserver ⇒ bridge 起不来 ⇒
  - `vssaros-ide: pending (waiting for service: vssarosBridge)` ⇒ 级联 pending ⇒ ⇒ **格子里没有 IDE 桥能力**（"在 IDE 打开"这类动作不可用）⚠
  - `vssaros-browser: 浏览器不可达 ⇒ browser 已从模型工具面撤下` ⇒ 探活失败（探针环境本就没有浏览器）⚠
- ⚠ **一条曾被误判的告警**：`agent ppt-slides-master 的 tools 里有 dsh 不认识的名字（read/write/pwsh/edit/glob/grep）` ⇒ **不是 TUI 特有**：agent preset 的 tools allowlist 跨作用域（agent 所在作用域里没有那些工具）⇒ web profile 里同样会出现（记忆里 0.2.70 那条"映射后仍不认识就忽略"）⇒ 与 TUI 无关。
- ★ **我们的标准档在 TUI 里可用**：`cordis.presets.yml` 里**本来就显式带**官方工具行（tool-bash/tool-pwsh/tool-fs/tool-fs-search/tool-jobs/tool-skill/tool-goal/planning/tool-subagent/tool-todo/tool-web/present/tool-working-directory）⇒ 不依赖 host plane 是否有那些行 ⇒ 社区 bundle 把 host plane 工具禁掉也不影响我们的 preset ✓。

### 7.10 ★ R4 复测：带我们全套模块后的每格成本

| tui profile 内容 | 每格内存（空闲态） |
|---|---|
| 只有社区 `@tomowang/dsh-tui` | **39.4MB** |
| 社区 TUI + 我们 **29 个** bundle 插件 | **71.6MB**（5 格增量 358MB） |

⇒ 12 格 ≈ **0.86GB**、24 格 ≈ 1.7GB（空闲态；跑任务时更高）⇒ ★ **仍然可接受**，真正的上限依旧是屏幕与模型并发配额（我们委派运行时上限 8）。

### 7.11 仍未验
- 同一会话被两格争抢（锁机制已在 2026-10-13 生产事故中实证，但"两个 TUI 进程 --resume 同一条"没实跑过 ⇒ 需要一条已落盘的会话 ⇒ 会消耗模型调用，**故意未做**）。
- 跑任务时的每格内存（上面都是空闲态）。
- 在 TUI 里发一条消息，确认标准档的**实际工具面**（需模型调用，未做）。

