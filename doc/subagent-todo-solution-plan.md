# 子智能体（subagent）与任务列表（todos）：官方方案 vs 本项目 + 优化方案

> 状态：**调研完成；P0 已实施**（2026-10-14，用户"执行/进行"）—— 见 §5 P0 的落地备注；P1 待做。
> 基线：dsh `0.2.0-rc.2`（见 `dsh-plugins/dsh-compat.json` 的 `"bundled"`）。
> 行号以该基线为参照（dsh 侧文件都在 `dsh-runtime/0.2.0-rc.2/node_modules/@deepseek-ai/` 下，下文省略前缀）。
> ⚠ 按本仓"界面需求先出 mockup 再实现"的固定流程：**动 UI 代码之前先出可交互 mockup**（见 §9）。

---

## 0. 结论（TL;DR）

1. **不缺少 UI**：截图里的「N 个子智能体」与「任务 N 已完成」**都是 dsh 自带包**渲染的 —— `dsh-client-ui-subagent`（子代理目录）与 `dsh-client-ui-conversation` 的 `TodoPanel`（任务清单）；数据来自会话**投影** `subagentCatalog` / `todos`。我们**不该**重做这两块 ✗。
2. **真正的缺口是"跨到 VsSaros 的那一半"**：
   - ① 聊天框形态把 dsh **右栏整个隐藏**（`DSH_CHAT_ONLY_CSS`）⇒ 官方"子代理 → 开右栏聊天"这条路在我们这儿**点了没反应** ✗（同类问题本仓已踩过一次：改动文件卡的行点击）。
   - ② `todos` 只活在会话投影里 ⇒ **进不了**我们的 Tasks 看板 / 主页 / Dashboard ✗。
   - ③ 页面桥（v6）**没有任何**命令或推送承载 `subagentCatalog` / `todos` ✗。
3. **最小风险的第一步是纯页面侧**：官方那两个槽（`conversation.input.dock`、`conversation.session.header.actions`）都是**稳定的 list 槽**，我们直接 `ctx.slots.inject` 就能把"子代理目录 / 任务清单"接到我们要的落点 ⇒ **不动桥、不动宿主**（§5 P0）。跨侧聚合（进看板/主页）才需要新推送通道（页面桥 v6→v7，两侧同步 + 对账测试，§5 P1）。
4. 结构性风险（要拍板）：我们自己的任务板（`vssaros-kanban` 的 `taskboard.json` + 自建锁）与 dsh 的 `todos` 是**两份真相**，目前没有机制保证一致性（`owns` / `resolveWriteOwnership` 只判定不执行）⇒ 见 §6 拍板点 1。

---

## 1. 官方方案盘点：一共 7 种"子智能体 / 任务"形态

| # | 形态 | 包 | 拓展槽（值） | 数据源 | 交互 |
|---|---|---|---|---|---|
| 1 | 子代理**目录下拉** + 谱系面包屑 + 右栏子会话聊天 | `dsh-client-ui-subagent` | `conversation.session.header.actions`（id `subagent-catalog`, order **-30**）；`conversation.session.header.lineage`；`conversation.composer`（只读 composer）；`sidebar.right.pane.tab`；`sidebar.chat.conversation` | `ctx.sessions` 的 `subagentCatalog` 投影 + `subagentTiming` + 身份 `subagent.address` | 行点击 → `ctx.uiWorkspace.openSession(childAddress)`（**切会话**）；行内侧栏按钮 → `ctx.sidebarRight.openResource(subagentchat://…)`（**开右栏**）；展开箭头递归加载下级 |
| 2 | 任务清单（todo dock，composer 上方） | `dsh-client-ui-conversation`（`TodoPanel`） | `conversation.input.dock`（id `todo`, order **0**，`kind:"list"`, `scope:"session"`） | `useProjection("todos")` ⇒ `TodoItem{content,status}` | **只有整体折叠/展开**；单项**没有 onClick**（点了没反应是官方现状） |
| 3 | 后台任务名单（bash job 生命周期） | `dsh-client-ui-jobs` | `conversation.session.header.actions`（id `job-list`, order **20**） | `ctx.jobs.state/watchRows/observe/kill` | 观察 / 终止 |
| 4 | Agent Teams：roster + **只读共享任务板** + teammate 导航 | `dsh-experimental-client-ui-agent-team`（**experimental**） | `conversation.session.header.actions` | 主导会话投影 `agentTeam` | 导航到 teammate |
| 5 | 工作流运行节点（运行 → 阶段 → 成员） | `dsh-client-ui-workflow-run` | `conversation.chat.node` | 工作流运行投影 | 展开层级 |
| 6 | composer 级"任务态"：goal / plan | `dsh-client-ui-goal`、`dsh-client-ui-plan` | `conversation.chat.node`、`conversation.input.dock` | `useProjection("goal"/"plan")` | 编辑 / 暂停 / 提交审批 |
| 7 | 原始时间线（按轮次事件表） | `dsh-client-ui-trajectory` | `conversation.view` | 会话事件流 | 只读查阅 |

## 2. 两个核心数据面（真正的"事实源"）

**子智能体**：主人是 `dsh-subagent`（投影注册 `lib/index.js:2848-2852`）
- 投影键：`subagentCatalog`（`{id, label?, mode: 'one-shot'|'continuable'|'unknown'}`）、`subagentTiming`（`{settledMs, active:{since,through}}`）、身份 `subagent.address = {parentSessionId, childSessionId, mode}`
- 生命周期事件：`subagent/start` / `subagent/end`
- 服务方法：`ctx.subagent.listChildren(parentSessionId)` —— ⚠ **额外依赖 `dsh-session-query`**，缺它抛 `SUBAGENT_CONTROL_QUERY_UNAVAILABLE`（`dsh-subagent/lib/index.js:2079-2083`）
- 浏览器侧控制：`subagent.prompt` / `subagent.interrupt`
- token 口径：`uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`

**任务清单（todos）**：主人是 `dsh-tool-todo`（**唯一主人**，`lib/types/types.d.ts:2,11,29`）
- `todo_write` 工具 → 会话事件 `todo/write`（**整表替换**）→ 会话投影 `todos`
- 类型：`TodoItem = { content: string; status: 'pending'|'in_progress'|'completed' }`
- `todos === null` 是"未知"，**不等于** `[]`（"未知不伪装成 0"）✓

> ⇒ 结论：**别再自建第二份真相** ✗。我们已有自家任务板（§3），合并策略见 §6。

## 3. 本项目现状（逐条证据）

**chat-surface（`dsh-plugins/vssaros-chat-surface/`）**
- 18 个 client 文件 + `index.js`：**零** subagent / todo 相关代码 ✓（全目录唯一 `todo` 命中是 `lib/client.settings.js:167` 的一个 React key，与任务清单无关）。
- 我们已占的官方槽（可对照官方"同槽并排"）：
  - `conversation.session.header.actions`：`client.agents.js:54`、`client.preset.js:234`、`client.workspace.js:113` —— **与官方子代理目录、jobs 同一槽** ✓（所以截图里那行是"我们的 chip + 官方下拉"并排）。
  - `conversation.session.header.utilities`：`client.sessions.js:75`、`client.settings.js:24`、`client.openInApp.js:21`、`client.hideBridgePing.js:27`
  - `conversation.composer`（审批）：`client.approval.js:22`；`conversation.chat.turnTail`（用量）：`client.usage.js:284`
  - `conversation.hero.brand.mark` / `conversation.hero.agentPreset`：`client.hero.js:21`、`client.preset.js:222`
- `conversation.input.dock`：**我们没有占** ✓（`lib/client.js:23` 明确"排队条交给官方 QueueDock"，因为重复表达；该槽官方已有 `todo`(order 0) 与 `queue`(order 20)）。

**IDE 侧**
- 页面桥：`src/vs/sessions/contrib/dshHarness/common/dshPageBridgeProtocol.ts` —— `DSH_PAGE_BRIDGE_VERSION = 6`（L23）；"改桥两边同步"注释 L14-22；preload 镜像 `electron-browser/preload-dshView.ts:109`（同值）；对账测试 `test/common/dshPageBridge.test.ts`。
- 现有命令里**能**承载这两类事实的只有间接的：`openSession`（可跳子会话）、`sessionTitle`、`sessionPersona`；**没有**任何 subagent/todos 命令或推送 ✗（反向推送先例：`DSH_PAGE_IPC_WORKTREES` / `DSH_PAGE_IPC_CREDIT` / `DSH_PAGE_IPC_RENAME`）。
- ⚠ 页面桥**单向**（主进程只回 `true`/`'pong'`）⇒ 要显示 dsh 侧事实，只能是**宿主推送**，不能页面查询。
- 聊天框形态下右栏被 `DSH_CHAT_ONLY_CSS` 隐藏 ⇒ 官方所有"落右栏"的动作都得换落点 ✗。

**我们已经会"读"，只是没"用"**（重要）
- `dsh-plugins/vssaros-dashboard/lib/core/dashboard.js` **已解析**：`TODOS_KEY='todos'`(L41)、`todosOf`(L67)、`SUBAGENT_TIMING_KEY`(L56)、`SUBAGENT_CATALOG_KEY`(L57)、`subagentOf`(L326)、`activityTally`(L555)；渲染在 `lib/catalog.js:51-52,178-182,358`。
- `vssaros-sessions` 读 `session_projcache`（含 subagent 投影）✓；真机探针已有 `poc/dsh-p0/scripts/p3-19-subagent-realdata.mjs`、`p3-45-kb-build-real-subagent.mjs` ✓，但 **todos 一条探针都没有** ✗。

**我们自建的任务面（另一套）**
- `vssaros-kanban`：数据源 = `<dataRoot>/taskboard.json` + `boards.json`（`lib/store.js:21-23,42-44`）、自建跨进程锁 + 原子写（`lib/store.js:223-255`）；入口 `/x/kanban`（`lib/index.js:30`）+ 工具 `kanban_*`（`lib/index.js:531-864`）+ 客户端 keyed tool-view（`lib/client.js:181`）。
- `vssaros-agents`：`<dataRoot>/agents/<id>/.agent.md` 只读（`lib/store.js:16-29,45`）。
- `vssaros-sessions`：`<DSH_HOME>/storages/session_projcache/sessions/*.json` 只读（`lib/store.js:15-37`）。

## 4. 能力对比

| 能力 | dsh 官方 | 本项目 | 差距 / 风险 |
|---|---|---|---|
| 看子代理目录 | ✅ 头部下拉（含 running/one-shot 标记、递归下级） | ❌ 不显示（但 IDE 侧有能力读） | 缺口：聊天框里看不到"我有几个子代理在跑" |
| 切到子代理 | ✅ `uiWorkspace.openSession(child)` | ⭕ 该桥命令已有，但未与子代理列表接线 | 可零成本复用 |
| 子代理开侧栏聊天 | ✅ `sidebarRight.openResource(subagentchat://…)` | ❌ 右栏被 chat-only 隐藏 ⇒ 点了没反应 | 必须换落点（IDE 编辑区 / 我们侧栏） |
| 看任务清单 | ✅ composer 上方 todo dock | ❌ 不显示（我们没占该槽） | 缺口：模型的任务进度用户在聊天框里看不到 |
| 点任务项 | ❌ 官方就没做（只有折叠） | ❌ | **机会点**：我们补"跳文件/跳回合"即超过官方 |
| 任务进看板/主页 | ➖（dsh 不管 IDE 面） | ⭕ 自家 `taskboard.json`，与 dsh todos 无关 | 两份真相，无一致性机制 ✗ |
| 跨会话聚合（"所有会话的子代理"） | ➖ | ⭕ Dashboard 已解析数据、无 UI | 缺口只在 UI |
| 扩展缝 | ✅ 稳定 list 槽 + `sidebarRightTabs.register` + `resources.register` | ✅ 已在用同款缝 | 风险低 |
| 版本稳定性 | `client-ui-subagent` / `dsh-tool-todo` **不带 experimental**；`agent-team` 带 | 兼容表钉 `0.2.0-rc.2` | 投影键是跨包契约会漂移 ⇒ 升版必须重跑对账 |

## 5. 优化方案（分期）

### P0 —— 纯页面侧，零桥改动（1 个插件版本 bump）

> **✅ 已落地（2026-10-14，chat-surface `0.2.66 → 0.2.67`）**
> - 新增两枚 chunk：`lib/client.todos.js`（`conversation.input.dock`，id `vssaros-todo`，order **5**
>   —— ⚠ 原取 10，与官方 `goal` **真 tie** ✗，2026-10-14 挪到空档 5 并补登进守卫的官方占位表 ✓）与
>   `lib/client.subagents.js`（`conversation.session.header.actions`，id `vssaros-subagents`，order **-25**），
>   并接进 `lib/client.js` 的 `PART_CHUNKS` ✓。
> - **一处按仓内不变量偏离了 mockup**：子代理「切会话」走 **宿主** `bridge.openSession`（页面侧禁止自己调
>   `uiWorkspace.openSession` —— 本视图绑定的会话 id 是宿主持有的事实，见 `client.sessions.js:11-17`）✓。
>   宿主较旧（无该方法）时**明确通知**，不装作成功 ✓。
> - 任务项「定位」按**文本**回找（`TodoItem` 无 id ⇒ 唯一可行的关联方式），找不到就通知 ✓；
>   不伪造"任务 ↔ 文件"的关联（dsh 侧没有这份数据 ✓）。
> - 新增永久守卫 `dsh-plugins/check-chat-surface-chunks.mjs`（已接进 `npm run check:dsh-plugins`）：
>   真装载每个 chunk + 真跑 `install` ⇒ 断言**接线**（磁盘文件 ↔ `PART_CHUNKS`）、**注册参数**
>   （多条目槽必须有 id/order、不与官方或我们别的条目撞 id/tie order；单条目槽的省略不误报 ✓）、
>   纯逻辑（进度/时长文案）、包清单（`version` + `files` 通配）✓。
> - ⏳ 仍未做：**todos 真机探针**（§7 的空白项）与页面桥 v7（P1）。

**P0-1 任务清单落到聊天框（`conversation.input.dock`）**
- 落点：`ctx.slots.inject("conversation.input.dock", …)`，`id: "vssaros-todo"`，`order: 10` ⇒ 与官方 `todo`(0) / `queue`(20) **并存** ✓（同槽靠 id+order 共存，官方 queue 与 todo 就是这么并的）。
- 数据源：`ctx.sessions` 的 `todos` 投影（**只读镜像**，不新建真相 ✓）。
- 超越官方的一点：**单项可点** —— 点击任务项 → 我们把"这条任务对应的工具调用/回合"定位出来（复用我们已有的"跳文件/开 diff"通道 ✓）。这正是官方 `TodoPanel` 没有的能力（§1 第 2 行）。
- 与官方的边界：官方 `TodoPanel` **保留**（用户没理由丢它）；我们这枚是"带动作的增强版" ⇒ 二者是否重复要在 mockup 里看视觉效果（可只在"有可跳转目标"时显示我们的那枚 ✓）。

**P0-2 子代理入口的落点修正（`conversation.session.header.actions`）**
- 官方那枚下拉（`subagent-catalog`, order -30）**保留** ✓ —— 它的"切会话"在聊天框形态下**是好用的**（`uiWorkspace.openSession` ✓）。
- 只在"**开右栏聊天**"这一条上做替代：我们在同一槽加一枚自己的入口（`id: "vssaros-subagents"`, order 用负数插到官方前后均可），点击后落到 **IDE 编辑区**（新增一条 `openModulePage`/专用命令的用法）或直接**切聊天框会话**（零跨侧）。
- 数据源：`subagentCatalog` / `subagentTiming` / `subagent.address`（与官方同源 ✓）；状态口径与 `client.usage.js` 的回合用量对齐（别另造一套 ✗）。

**P0-3 状态口径统一**：`running/inactive`（`statuses.get(id)?.running ?? summaries[id]?.running`）、`mode: one-shot | continuable`（one-shot 时输入框应呈"只读"语义 ✓）、token 四项加总。

### P1 —— 跨侧（需要页面桥 v6→v7 + 两侧同步 + 对账测试）

> **⚠ 2026-10-14 修正（动手前核出来的，比原方案省一大块）**：
> 1. **主页那两枚"计数卡"其实已经存在**：`kpi` 组件的描述里就写着「运行状态清点（**待办** / 待回答 / 重试 / 排队 /
>    **子代理**）」⇒ 模拟稿 ③ 的主页部分**不用做** ✓（缺的是**明细**面 ✓）。
> 2. **不需要动页面桥**：IDE 侧的"面"在这仓里是 **dsh 插件页**（宿主侧渲染 ✓），而 `todos` / subagent 四单元的
>    **解析能力已在宿主侧存在**（`vssaros-dashboard/lib/core/dashboard.js` ✓）⇒ 推送通道（`DSH_PAGE_IPC_*`）与
>    v6→v7 版本双写**本轮不做** ✓。**页面桥保持 v6** ✓（少一次"只改一边必红"的风险 ✓）。
> 3. 于是 P1 实际剩两块：**看板只读镜像**（✅ 已落地，见下）与**「子智能体」明细面**（✅ 已落地，见下）。
>
> **✅ 看板只读镜像（2026-10-14，kanban `0.4.14 → 0.4.15`）**
> - `lib/store.js`：新增 `readDshTodoMirrors()`（读 `<DSH_HOME>/storages/session_projcache/sessions/*.json` 的
>   `todos` 投影，分片链还原；`val: null` / 空表 / 非法项**都不产出**镜像 ✓）+ `dshHomeOf()`（与
>   dashboard 那份**逐字同形** ✓，并已纳入 `check-host-config.mjs` 的拷贝一致性检查 ✓）。
> - `lib/board.js`：按状态落列（`pending`→待执行 / `in_progress`→执行中 / `completed`→执行结束 ✓）渲染
>   **镜像卡**：带 `data-kanban-mirror`，**故意不带** `data-task-id` / `data-kanban-grab` / `data-kanban-card`
>   ⇒ 客户端天然**拖不动、开不了详情、不参与筛选**（写口 `/api/move` 只认 taskboard 的 id ✓）⇒ 看板**没有**
>   多出任何写路径 ✓。读不到时页面**如实显示原因**（`data-kanban-mirror-note` ✓），不静默 ✗。
> - 守卫：新 `poc/dsh-p0/scripts/p3-91-kanban-dsh-mirror.mjs` —— **19/19** ✓（纯函数 + 夹具，秒级）：
>   ①镜像卡锚点形状 + **三条负对照**（无 task-id / 无 grab / 不进 card 集合）②状态→列映射、我们自己的卡
>   未被改坏、"只有镜像卡"的列不许显示"这一列没有卡片"、读不到必须显示 ③分片链还原与顺序、`null`/空表/
>   非法项不产出、目录不存在**不抛**且给非空 note。既有 `p3-88`（看板）**74/74** ✓ 无回归。
>
> **✅「子智能体」明细面（2026-10-14，sessions `0.1.4 → 0.1.5`）**
> - **落点决定（与原稿不同，见下）**：**并入既有 `/x/sessions/` 整页**，**不新开整页** —— 子智能体**本身就是会话**
>   （父子关系就在投影里 ✓），而该页已经把会话读进来了 ⇒ 只差"把父子关系画出来" ✓；新开整页要多一个 IDE 容器 +
>   `DSH_MODULE_PAGES` 登记 + 「与插件清单逐项一致」守卫，成本高而信息量相同 ✗。
> - `lib/core/sessionList.js`：新增三个单元的归一（`subagentCatalog` / `subagent` / `subagentTiming` ✓，
>   与 dashboard 的单元名同一份）—— **形状不认识一律 `undefined`（未知）**，`[]` 才是"确实没有" ✓；
>   `subagentRowsOf()` 构造父子行（孩子不在扫描窗口里就**如实缺席**，不编造 ✓；有孩子在跑的父行排前 ✓）。
> - `lib/index.js`：会话组**之前**渲染 `subagentSectionOf()`（`data-vssaros-subagents` ✓），
>   **三种情况给三句不同的话**：有数据 / 确实没派过 / `subagentCatalog` 单元根本没出现（**未知，不当成 0** ✓）。
> - 守卫：新 `poc/dsh-p0/scripts/p3-92-sessions-subagents.mjs` —— **17/17** ✓（纯函数 + 夹具）：
>   三单元归一的**缺席/空数组/非法项**三条负对照、`running` 只在有 active 窗口时才给 ✓、孩子的标题状态
>   如实缺席 ✓、排序 ✓、**三种文案互不相同**且未知那一路不许出现"没有派过" ✓、转义 ✓。既有 `p3-49`
>   （sessions 页）**20/20** ✓ 无回归。
> - ⚠ **探针第一版替我们抓到一个真 bug**：`children: []`（空目录）也会产出一行「0 个子智能体」⇒ 页面上那
>   两句"确实没有 / 未知"的文案**永远走不到** ✗（已修：空目录不产出行 ✓）。另有 4 处是**探针自己**写错
>   （夹具那条"无 id"其实带着 `id` ✓；把"没有 active 窗口"读成 `running === false` ✗ —— 正解是 `undefined` ✓）。
> - ⏳ 仍未做（可选）：看板镜像卡的「点卡跳会话」（需要一条新的 IDE 能力或反向通道 op ✓）、以及**独立整页**形态
>   （若确实要单独页签，成本见上 ✓）。

- **P1-1 宿主推送**：新增 `DSH_PAGE_IPC_SUBAGENTS` / `DSH_PAGE_IPC_TODOS`（**推送而非查询** ✓，与 `_WORKTREES`/`_CREDIT` 同型；页面桥单向这条约束决定了方向）。
- **P1-2 IDE 侧消费**：Dashboard **已有解析能力** ✓ ⇒ 只差 UI：新增「子智能体」卡（跨会话聚合：主导会话 → 子代理树，含 running/耗时/token）；`dshHarnessService` 已有 `focusTaskboard`（capability `taskboard` ✓）可作为"从看板跳到会话"的先例。
- **P1-3 任务面合并**（见 §6 拍板点 1）：至少先把 **dsh todos 作为只读镜像**进看板/Dashboard，**不写回** ✓（写回要先把 `owns`/`resolveWriteOwnership` 从"只判定"变成"真执行" ✗，那是独立议题）。

### P2 —— 体验收敛

- 官方 `agent-team`（experimental ✗ **不作基线**）的"roster + 共享任务板"形态只作参考。
- 把用户眼前可能出现的 **4 种"任务"**（dsh `todos`、dsh `jobs`、`goal`/`plan`、我们的 Tasks 看板）在信息层级上收敛：明确"哪个是模型的待办、哪个是我们产品的工作项"。

## 6. 需要你拍板的 3 件事

1. **任务真相归谁**
   - A（推荐）**dsh `todos` 为准，我们的看板/主页做只读镜像**；我们的 `taskboard.json` 只保留"人建的、非模型生成的工作项"。
   - B 我们自建为准（dsh todos 仅显示，不进看板）。
   - C 双向同步 —— 需要先落地 `owns`（`dshHarness/common/dshPluginActivation.ts:84` 现在**只判定不执行**，`:62` 明写）⇒ 成本高、风险大，建议**不在本轮**。
2. **子代理交互落点**：A 切聊天框会话（零跨侧，推荐起步）／B 开 IDE 编辑区页（要新增页面桥命令或复用 `openModulePage`）／C 恢复 dsh 右栏（与 chat-only 形态冲突，不推荐）。
3. **要不要"任务进看板/主页"**（会动页面桥版本 ⇒ 必须两侧同步 + 对账）。

## 7. 风险与不可逆项

- **投影键是跨包契约**：`subagentCatalog` / `subagentTiming` / `todos` 的 schema 会随 dsh 版本漂移（`stateVersion 2/3`；`subagentModelSelectionPolicy` 属 `dsh-tool-subagent` 而**不是** `dsh-subagent`）⇒ 升级 dsh 时这些键必须重新对账（`dsh-compat.json` 目前只钉 `0.2.0-rc.2`）。
- **`listChildren` 有额外依赖**：需要组合里挂了 `dsh-session-query`，否则抛 `SUBAGENT_CONTROL_QUERY_UNAVAILABLE` ⇒ 用前先确认；否则走"读 projcache"（`vssaros-sessions` 那条路 ✓）。
- **页面桥单向 + 版本双写**：改桥必须 `v6→v7`、`preload-dshView.ts` 同值、对账测试同步（**只改一边必红**）。
- **chat-only 隐藏右栏**：官方任何"落右栏"的动作都要换落点（本仓已有同类教训：改动文件卡行点击）。
- **todos 无真机探针** ✗（`poc/dsh-p0/scripts` 下 todo 命中 0）⇒ **已补（2026-10-14）**：新增
  `poc/dsh-p0/scripts/p3-90-todo-realdata.mjs`（**14/14 通过** ✓）+ `mock-llm.mjs` 的 `todo list` 触发分支
  （写两次：3 条 → 2 条）。它钉住的不变量：① `todos` 元素 schema **只有 `content` + `status`**（没有 id/priority ✓）；
  ② **整表替换 last-wins**（最终 == 第二次写的那两条 ✓）；③ dashboard 归一与**原文**逐项一致（两条独立读法互证 ✓）；
  ④ 两条**负对照**：`val:null` / 键缺席都必须读成 `present:false` + `null`（**不是 `[]`** ✓），
  且全量扫描 406 个"没写过 todo"的会话**没有一个**被伪装成 `0` ✓。
  - ⚠ 期间踩到并写进注释的两个坑：**(a)** `todos` 探针分支**必须放在 kb 分流之前** —— 那三条 kb 分支
    **只按工具名单分流、不看提示词**（`mock-llm.mjs` 自己的注释里写着 ✓），否则它们会吞掉任何提示词
    （现象：`/__stats` 里 `sawTodoWrite=true` 却 `MOCK_LLM_BRANCH kb-build`、3.4 秒收场 ✗）；
    **(b)** 选"本轮会话"不能只按 `identity.cwd` 匹配 —— 探针工作区路径**跨轮复用**，readdir 顺序又不是时间序
    ⇒ 会读到**上一轮**那个 `todos: null` 的会话（6 条假红 ✓）；改成按 mtime 取最新 + 打印候选 ✓。
  - 📌 顺带发现（不属本线，留给 kb 那线）：`mock-llm.mjs` 的 kb 三条分支**没有提示词闸门**，
    在挂了 kb 的 profile 里对**任何**提示词都会点火 ⇒ 依赖"没有别的分支先命中"这一隐含前提 ✓。
- 页面侧槽位冲突：`conversation.input.dock` 已有官方两枚 ⇒ 我们的 `id`/`order` 必须显式（默认值可能与官方撞号）。

## 8. 验证方式（沿用仓里既有范式）

1. **静态守卫**：钉住"我们注册的 slot 名 / id / order 与官方并存"（照 `client.agents.js` 那套写法 + 反向突变确认变红）。
2. **真机探针**：
   - subagent 已有 `p3-19`（造真数据 + dashboard 双读互证）✓、`p3-45`（真 Host + 真 subagent）✓ ⇒ 照抄给 **todos** 补一条（**当前是空白** ✗），含负对照。
   - 跨侧推送通道的"两侧同键"对账（照 `DSH_PAGE_IPC_WORKTREES` 的既有做法）。
3. **插件侧校验**：改 `dsh-plugins/*` 后跑 `check-host-config.mjs` / `tools-snapshot.mjs`（若工具面无变化则 `--check` 应绿）；**版本号最后 bump**（仓里有守卫）。
4. **交互验收**：必须真浏览器点击（"断言 markup 存在 ≠ 交互可达"，本仓已栽过两次）。

## 9. 下一步（建议顺序）

1. 你拍板 §6 的三条（尤其 1 与 2）。
2. 我按本仓固定流程出 **`doc/subagent-todo-mockup.html`**（可交互草图：① 聊天框里的"带动作任务清单" ② 子代理入口/切换 ③ IDE 侧「子智能体」卡）—— **先看形态，再动生产代码**。
3. mockup 定稿后：先补 todos 真机探针 → 做 **P0**（纯页面侧，1 个插件 bump）→ 视拍板结果再做 P1（含桥 v7）。
