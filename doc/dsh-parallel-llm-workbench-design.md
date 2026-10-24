# 设计方案 — 并行执行 LLM 的工作台（Parallel LLM Workbench）

> 目标：一个工作台里**并行跑 N 个 LLM 会话**，**每个并行窗口是一个 TUI**（真终端形态，可交互、可写、可 resize），
> 人在一屏内编排、观察、收割、接管。
>
> 状态：**设计稿**（2026-10-22）。文中每条事实都标注了出处；未验证的写明"**待实测**"，不把推测写成结论。

---

## 0. 结论先行

| 问题 | 结论 | 依据 |
|---|---|---|
| 能复用官方能力吗？ | **能，但只对一半**：`remote.terminal` 的 PTY/流式输出现成，然而它的下行协议给的是**纯文本屏幕快照**（`screen: string`，无 ANSI 样式）⇒ 社区 TUI 的颜色会**全丢** ⇒ ★ **格位改为自管 PTY**（node-pty + 原始 ANSI 流 + 浏览器端 xterm.js）；官方 terminal 保留给"会话内普通 shell" | `doc/dsh-tui-ecosystem-research.md` §7.6 |
| "每个窗口一个 TUI"怎么落地？ | ★ **用社区 TUI `@tomowang/dsh-tui`**（MIT，需 dsh **0.2.1-rc.2**），跑在格子的 PTY 里。⚠ 实测（2026-10-22）：它是**自带 core 的独立 dsh 进程**（不起 Host、不连 Host）⇒ **N 格 = N 个独立 dsh 进程**，共享同一 profile 目录与 DSH_HOME；写锁是**会话级** ⇒ 不同格并行无冲突 | `doc/dsh-tui-ecosystem-research.md` §7 |
| 官方有"多 agent 并行"吗？ | 有，但**是单进程内**的（Lead + teammate + 任务板），且**明确不支持跨进程协调** ⇒ 跨进程那层**要我们自己做** | `dsh-experimental-agent-team/README.zh.md`：「不支持独立工作目录、跨进程协调和自动释放任务 owner」 |
| 能在 dsh 聊天页里并排多会话吗？ | **不能**（会话是单例选择模型）⇒ 并行 TUI 必须走**终端/独立进程**路线 | 既有结论：磁贴只能只读监控 + 点击接管 |
| 我们已有的资产怎么用？ | **看板（kanban）当共享任务板 + 记忆/知识库当共享上下文 + Bot 名册当角色来源** ⇒ 正好补上官方 agent-team 缺的"跨进程协调" | 本仓 `vssaros-kanban` / `vssaros-memory` / `vssaros-agents` |

---

## 1. 已验证的事实（设计的地基）

### 1.1 终端层（官方已有，最关键）
`@deepseek-ai/dsh-api-terminal-controller` 提供的 `remote.terminal`：

- 方法：`environment` / `shells` / `list` / `create` / `retain` / `attach` / `rename` / `close`
- **每个操作按 Session 标识限定范围** ⇒ 上限 `maxTerminals = 8`（**每 Session**）
- PTY：`TERM=xterm-256color`；**Headless xterm** —— 服务端维护屏幕，客户端只收"快照 + 增量帧"（带单调序号）
- 双工 `attach` 流：输出 + `write` / `resize` 命令，逐条 ack
- 客户端侧约定：xterm.js 解析；输入与 resize；`localStorage` 绑定键 `dsh.terminal.binding.v1.*`
- 其它限制：`maxCols 500` / `maxRows 200` / `scrollback 1000` / `maxBufferedBytes 2MB` / `maxInputBytes 64KB`
- 回收：无窗口持有且确认空闲 `unattendedTimeoutMs = 2h` 后自动回收
- ⚠ 终端是**用户交互式 shell**，**输出不进入 Agent 对话记录** ⇒ 格子里的 TUI 与 Agent 会话是**两件事**
- 官方 Web bundle 已挂它，并配了**侧栏终端**（`@deepseek-ai/dsh-client-ui-sidebar-terminal`）

### 1.2 应用层
- ⚠ **官方没有 TUI 客户端**：`dsh --help` 里写的 `dsh tui` 在 0.2.1-rc.1 **并不存在**（runtime 里无 `dsh-tui` 包、`dsh/bin` 为空、随包模板只有 `acp/headless/sdk/sdk-minimal/web`）⇒ **help 文本是过时示例**。
- `dsh headless "任务"` **存在**（一次性任务，打印结果后退出）⇒ 适合"批处理格位"。
- 我们的 `dsh-plugins/vssaros-agents/bin/agent.mjs`（`vssaros-agent`）是**离线管理 CLI**（list/show/create/export/import，**不需要 Host 在线**）⇒ **不是**交互式 TUI。
- ⇒ ~~"每格一个 TUI"要我们自己写一个交互式客户端~~ ★ **2026-10-22 更正：不用自写** —— 社区有现成 TUI，选 **`@tomowang/dsh-tui`**（MIT，out-of-tree mode bundle，需 dsh **0.2.1-rc.2**；`dsh plugin --profile tui add @tomowang/dsh-tui` ⇒ `dsh --profile tui`）。
- ★ **实测进程模型**（`doc/dsh-tui-ecosystem-research.md` §7）：TUI 是**自带 core 的独立 dsh 进程**（patch 原文 "mounts no Host, HTTP server, Web runtime"）⇒ **N 格 = N 个独立 dsh 进程**，共享同一 profile 目录 + DSH_HOME（会话/凭据/设置在磁盘上共享）。
  - 同 profile 两实例**实测可同时运行**；写锁是**会话目录级** ⇒ 不同格并行无冲突，同一会话只能一个写者（"接管"= 先关原格、再 `--resume <id>`）。
  - ⚠ 格子进程**不在** IDE 的 Host 里 ⇒ 我们插件的 Host 侧服务（看板/记忆/知识库页面路由）在格子里不可用；工具层要装进 `tui` profile 才有（待验 R6）。
- ⇒ **"每格起一个 dsh app"正是实测可行的形态**（之前担心的写租约互斥不成立）；代价是资源：每格一份 core（内存估算见阶段 0 结论）。

### 1.3 协作层（官方实验包）
`@deepseek-ai/dsh-experimental-agent-team`（+ `-tool-` / `-profile-` / `dsh-experimental-client-ui-agent-team`）：
- 一个会话内：Lead + 具名 teammate（fresh 或 fork 启动）+ 直接消息 + **持久共享任务板**
- roster 状态：`running` / `inactive` / `provisioning` / `failed`
- 上限：`maxMembers 16`、`maxTasks 256`、`maxMessageBytes 64KB`
- ★ **限制原文**：「不支持独立工作目录、**跨进程协调**和自动释放任务 owner」
  ⇒ **它是"进程内并行"**，与"每格一个独立 TUI 进程"**不是同一层** ⇒ 两者可叠加但不能互相替代

### 1.4 位置感知（可选增强）
`@deepseek-ai/dsh-tmux-context`：让模型知道自己的 **tmux session / window / pane** 与 pane 树；
仅在位置变化时、每轮第一个步骤注入一条带来源的读数；**不随附在 Web / 无头 profile 中**，需显式挂载。

### 1.5 客户端层的硬约束（沿用既有结论）
- dsh 客户端是**单例选择模型**（`SessionListState.current` 全局唯一）⇒ 一页内无法让多块 UI 各绑一条会话的**实时流**
  ⇒ 因此"多窗口"只能落在**终端 / 独立进程**上；会话磁贴只能"只读监控 + 点击接管"
- 客户端 chunk 的 `rev` **只跟包入口 `client.js` 走** ⇒ 改 `client.*.js` 必须同时动入口，否则浏览器吃旧缓存

---

### 1.4 ★ 主页 item 层（2026-10-22 用户口径）

**用户口径**：多个并行 TUI **收敛成「一个工作台」**，在**主页**里以 **item** 形式出现。

⇒ 落点（复用现成机制，改动很小）：
1. **工作台 item**：主页（`vssaros-dashboard`）已有「工作台」组件（`lib/catalog.js` 的 `kind:'workbench'`），数据源是**硬编码清单** `WORKBENCH_MODULES`（每条 `{route, name, desc, icon, alwaysPinned}`）⇒ ★ **加一条 `/x/parallel/` 即自动出现在主页** ✓（无需给 dashboard 加新组件类型）。
   ⚠ **route 必须与宿主的模块页表一致**（`dshModuleContainers.ts::DSH_MODULE_PAGES`）⇒ 否则「打开 / 固定 / 从活动栏隐藏」三条命令按 route 白名单**被静默拒掉**（表现 = 点了没反应）✗。
   ⚠ 主页**正在做 React 重构**（`doc/dashboard-react-mockup.html`）⇒ 视觉要按那一版：卡片圆角 **16px**、工作台 item 是**一行式** `.wcard`（圆角 12px、图标 18px + 名称 13px + 描述 12px dimmed）、配色走 `--dsw-alias-*` ⇒ mockup 已按此对齐（`doc/dsh-parallel-tui-home-item-mockup.html`）。
2. **并行运行集组件**（主页新增一块，让用户**不点进去**也能看到各格状态）：`catalog.js` 的 `WIDGETS` 加 `kind:'parallel'`（显示格位状态灯网格 + 计数 + 点格进工作台并定位）⚠ 数据来源：并行工作台插件在 **Host 侧 provide 的运行集状态**（同一 dsh 进程 ⇒ `ctx.get(...)` 可取）⚠ **不要**让 dashboard 自己落盘新数据（记忆：看板是唯一写者，加写者要改守卫的固定期望）✗。
3. **工作台页本体**：按 `doc/workbench-authoring-standard.md` —— 单路由 `/x/parallel/` + `?surface=sideview|editor` 分版（缺省 = 完整页）；页内是**稿 A 网格**（每格一个 TUI）。

**mockup**：`doc/dsh-parallel-tui-home-item-mockup.html`（两屏可切换：屏 1 主页 item + 运行集组件；屏 2 工作台网格；点 item「打开」/点运行集格 ⇒ 联动到屏 2）✓ 已在浏览器验（3 个 item / 6 格运行集 / 6 格网格 / 无溢出）✓

## 2. 形态与分层

```
┌──────────────────────────────────────────────────────────────────────┐
│  L3 编排层  —— 我们自己的工作台页面 /x/parallel（服务端渲染壳 + 客户端）│
│  · 任务队列（来自 kanban）   · 运行集（格位集合）   · 事件流/日志     │
│  · 收割（收集每格产物）      · 接管（把某格提到 IDE 聊天里）           │
├──────────────────────────────────────────────────────────────────────┤
│  L2 格位层  —— 一格 = 一个终端（PTY）+ 一个 dsh 会话 + 一个任务        │
│  · TUI 格：跑 dsh tui（可交互）     · 批处理格：跑 dsh headless      │
│  · 状态灯：running / awaiting-input / idle / done / failed            │
├──────────────────────────────────────────────────────────────────────┤
│  L1 轨道层  —— 共享上下文（我们已有资产）                            │
│  · 共享工作目录   · 角色/Bot 名册   · 看板任务板   · 记忆/知识库      │
│  ★ 补上官方 agent-team 缺的那层：**跨进程协调**                        │
└──────────────────────────────────────────────────────────────────────┘
```

**为什么要有 L1**：官方 `agent-team` 明说不支持跨进程 ⇒ N 个 TUI 进程之间要交换"谁在做什么、做完没、产出了什么"，
就得有一个**进程外**的共享状态层。我们已有的**看板**（持久任务板）与**记忆/知识库**正好是这个角色 ⇒ 不必新造。

---

## 3. 交互设计（工作台页面）

### 3.1 布局
- **左栏（240px）**：① 待派任务（来自看板，可勾选）② 运行集（格位列表：任务名 / 状态灯 / 耗时 / token）③ 过滤器
- **主区**：**格位网格**（1×1 / 2×2 / 3×3 / 自适应），每格是一个**终端**（xterm 渲染）
  - 格位头：任务名 · 会话/工作区 · 状态灯 · 耗时 · token · 三个动作（接管 / 收割 / 重跑）
  - 格位体：TUI 输出（可滚动、可输入、可 resize）
- **顶栏**：运行集名 · 并发上限 · 模型/角色选择 · 「＋新格位」· 「全部收割」· 视图切换（网格 / 列表 / 只看状态）
- **底栏（可折叠）**：事件流（派活 / 状态变化 / 工具调用摘要 / 报错 / 人工接管）

### 3.2 两种格位模式
| 模式 | 进程 | 适合 | 特点 |
|---|---|---|---|
| **TUI 格** | **社区 `@tomowang/dsh-tui`**（`dsh --profile tui`，独立 dsh 进程） | 需要人随时插话、逐步引导的长任务 | 真交互；可写可 resize；与其它格共享 profile 目录 + DSH_HOME（会话可互相 `--resume`）；同一会话只能一格在写 |
| **批处理格** | `dsh headless "任务"` | 有明确完成判据的长任务 | 无人值守；产出可收割；退出码即判据 |

### 3.3 关键动作
- **派活**：从左栏勾任务 → 「＋新格位」→ 选模式/角色/工作目录 → 起进程
- **观察**：格位头状态灯 + 底栏事件流；失败格位自动置顶并给出失败原因
- **收割**：把某格产物（diff / 报告 / 交付物）归档到看板任务卡
- **接管**：点格位头「接管」⇒ 在 IDE 的 dsh 聊天里打开**同一条会话**（人接手继续）—— 与"会话磁贴点击接管"同一套机制
- **重跑**：同任务、同目录重开一格（保留旧格输出做对比）

---

## 4. 风险与未闭合项（必须实测，不能靠推理）

| # | 事项 | 为什么关键 | 怎么验 |
|---|---|---|---|
| R1 | ~~同 profile 起两个 TUI 是否互斥~~ | ✅ **已实测（2026-10-22）**：同 profile 两个 `dsh --profile tui` **同时正常运行**、各自一条会话；写锁是**会话目录级**（`dsh-session-persistence-jsonl` 的 `SessionWriteLease`）⇒ 不同格可并行，同一会话只能一个写者 | `doc/dsh-tui-ecosystem-research.md` §7.2 |
| R2 | ~~TUI 从哪来~~ | ✅ **用社区 `@tomowang/dsh-tui`**（不自写）；需 dsh rc.2；TUI 要求真 TTY ⇒ 格子必须是 PTY | 同上 §7.3/7.4 |
| R3 | ~~`remote.terminal.create()` 里能否跑 TUI~~ | ✅ **已查清并改变架构**：官方 terminal 协议下行是 `snapshot{screen: string}`（**纯文本**，无 ANSI 样式）⇒ TUI 的 126 处颜色序列（58 处 truecolor）会全丢 ⇒ **格子自管 PTY**（node-pty + 原始流 + xterm.js） | `doc/dsh-tui-ecosystem-research.md` §7.6 |
| R4 | ~~每 Session 8 终端 ⇒ 8 格上限~~ | ✅ **已实测**：**每格 ≈ 39.4MB**（空闲态）⇒ 12 格 ≈ 0.5GB、24 格 ≈ 1GB ⇒ 自管 PTY 后不再是约束；真上限 = 屏幕 + **模型并发配额**（我们委派运行时上限 8） | `doc/dsh-tui-ecosystem-research.md` §7.7 |
| R6 | 我们的插件能否进 TUI 格 | ✅ **已实测**：rc.2 下 compose 出现 `@tomowang/dsh-tui, patched by @vssaros/dsh-agents` ⇒ 我们的 agent 名册/标准档 preset/工具与社区 TUI **共存**；⚠ 装法有坑（必须 `file:` 暂存目录形式，不能 `link:`） | 同上 §7.8 |
| R7 | runtime 要不要升 rc.2 | ✅ **不必升**：rc.2 compose 我们真实 profile 完全成功（无兼容问题）⇒ 格子用独立 rc.2 runtime，**dev 环境零改动** | 同上 §7.8 |
| **R5** | ~~我们要自己写一个交互式 TUI 客户端~~ | ✅ **取消**：用社区 `@tomowang/dsh-tui`（实测可在 PTY 里正常起交互界面） | `doc/dsh-tui-ecosystem-research.md` §7 |
| R6 | 一个 Host 能否同时服务 N 个 TUI 客户端 + web 客户端 | 多连接与"客户端内单例 current"是否打架 | 官方有 `dsh-client-connection` ⇒ 大概率支持；实测两个客户端同时连 |
| R7 | `dsh-tmux-context` 要不要挂 | 挂上后模型知道自己在 tmux 第几格；但我们用 `remote.terminal` 而非 tmux ⇒ 收益有限 | 只在改用 tmux 编排时才需要 |
| R8 | 跨进程共享状态用什么载体 | 若 1 Host ⇒ 会话/记忆/看板天然共享 ⇒ 只需"哪个客户端在跑哪条任务"这一层 | 设计试验：两个客户端同时写同一看板任务卡 |

---

## 5. 分阶段落地

> ★ **定稿（2026-10-22）**：形态选**稿 A 网格工作台**（`doc/dsh-parallel-llm-workbench-mockups.html` 可切三稿看）。

**阶段 0（探针）**：✅ **R1/R2/R3/R5 已实测完**（2026-10-22，见 `doc/dsh-tui-ecosystem-research.md` §7）；剩 R4（多开时的资源成本）/ R6（我们的插件能否装进 `tui` profile）/ R7（runtime 升 rc.2 的影响）。

**阶段 1（工作台骨架，2–3 天）**
- 服务端：`/x/parallel` 页面壳（沿用 sessions 插件那套服务端渲染 + 客户端脚本）+ **格位管理接口**（起/停/写/收流）
- 格位后端：**自管 PTY** —— Host 侧用 runtime 自带的 `node-pty@1.2.0-beta.15` 起 `dsh --profile tui`（社区 TUI）或 `dsh --profile headless "任务"`，把**原始 ANSI 字节流**推到页面
- 客户端：每格一个 **xterm.js** 实例渲染原始流（颜色完整）⇒ 状态灯、收割到看板
- ⚠ Windows ConPTY 下 `node-pty` 的 `pid` 为 **0** ⇒ 结束格子要靠 `pty.kill()` / 关闭句柄，不能按 pid 杀
- ⇒ 不占 dsh 会话、不受"每 Session 8 终端"限制；格位与"接管"靠**我们自己记的会话 id**（TUI 状态栏首行有 `session <id>`，从 PTY 输出解析）

**阶段 2（TUI 格增强，1–2 天）**：~~写 `vssaros-tui`~~ 不用写 TUI 了，改做"格子 ↔ 会话"的绑定
- 每格记下自己的会话 id（TUI 状态栏首行就有 `session <id>`，可从 PTY 输出解析）
- 「接管」= 关原格 ⇒ 新格 `dsh --profile tui --resume <id>`（会话级写锁保证不会两格同写）
- 「点格放大」（稿 A 的已知代价：格小看不清）

**阶段 3（跨进程协调 + 收割产物）**：看板承载"哪个格在跑哪条任务"；收割产物归档；失败重试

**阶段 4（规模化）**：并发上限策略、格位复用（`retain`/`attach`）、与磁贴视图合并入口、评估 `dsh-tmux-context`

---

## 6. 与既有资产的关系（不要重造）

| 已有 | 在本方案里的角色 |
|---|---|
| `vssaros-sessions` 磁贴视图（`?view=tiles`） | **总览/接管入口**：工作台跑起来后，磁贴里能一眼看到这些会话的状态；点磁贴也能进聊天接管 |
| `vssaros-kanban` 看板 | **跨进程共享任务板**（官方 agent-team 缺的那层） |
| `vssaros-agents` Bot 名册 / 群聊 / 委派 | **角色来源**（谁在跑）+ 进程内协作（agent-team）的挂载点 |
| `vssaros-memory` / `vssaros-kb` | **共享上下文**：任务书、知识、结论的落地处 |
| 官方 `remote.terminal` | **会话内普通 shell**（不需要颜色的场景）；⚠ 不用于 TUI 格（协议是纯文本屏幕，颜色会丢） |
| 官方 `dsh-client-ui-sidebar-terminal` | 客户端 xterm 渲染与 `dsh.terminal.binding.v1.*` 绑定的**参照实现**（我们要引入 xterm.js 渲染原始流） |
| runtime 自带 `node-pty@1.2.0-beta.15` | **格位后端**：起 `dsh --profile tui` 的 PTY（原始 ANSI 流） |

---

## 7. 与本仓纪律的对齐

- **先出 mockup 再实现**（界面需求）⇒ 本方案配套 `doc/dsh-parallel-llm-workbench-mockup.html`
- **文档说真话**：已验证事实标出处；未验证标"待实测"；不把"官方 agent-team 支持跨进程"之类误读当结论
- **不重造轮子，但要看清协议能力**：官方 `remote.terminal` 的 PTY/xterm 现成 ✓；⚠ 但它的下行是**纯文本屏幕快照** ⇒ 承载全屏彩色 TUI 不行 ⇒ **这一处必须自管 PTY**（用 runtime 自带的 node-pty + xterm.js）⇒ "不重造"不等于"不辨协议"
- **分叉要拍板**：§4 的 R1 若为"互斥"，§3 的"格位"定义要改（独立 profile？共享数据根？）⇒ **先跑探针再定形态**
