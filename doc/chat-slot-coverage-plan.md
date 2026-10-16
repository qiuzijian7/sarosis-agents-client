# dsh 聊天页 slot：官方全清单 × 本项目覆盖 × 优化方案

> 状态：**调研完成，方案待拍板**（2026-10-14）。基线 dsh `0.2.0-rc.2`（`dsh-plugins/dsh-compat.json` 的 `bundled`）。
> 我们的形态 = `vssaros-chat-surface`（**聊天框**：左栏 / 右栏 / Panel 全被 `DSH_CHAT_ONLY_CSS` 裁掉，只剩会话主区 + composer + header）。
>
> **权威清单不是人肉搜出来的**：官方有一份**生成物** `CLIENT_SLOT_API`（"Every slot the shipped web bundle declares"，
> 字段含 `key/kind/scope/summary/registerOptions/declaredBy/occupants/replaceRisk`），位于
> `dsh-runtime/0.2.0-rc.2/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:2363+`（类型见同包
> `lib/types/client/slot-catalog.d.ts:27-66`），运行时经 `cordis_inspect what:"client"` 暴露给模型。
> ⚠ **`/dsh-runtime/` 在 `.gitignore` 里 ⇒ ripgrep 内容搜索默认搜不到它**（目录级搜索命中 0 ✗）——
> 本仓查 dsh 内部实现时必须用**文件级**路径读，别把"搜不到"当成"不存在" ✗。

---

## 0. TL;DR

1. 官方聊天表面共 **≈90 个槽**（另有 8 个是**服务键**不是槽 ✓）。其中**在我们形态下真的可见**的约 **50 个**，其余
   （`sidebar.*` / `rightbar.*` / `sidebar.right.*` / `settings.*` / `plugins.*`，共约 40 个）**整族不可见** ✗。
2. 我们目前只用了 **9 个槽 / 17 个条目**（全在 conversation 表面 ✓）—— 覆盖率不算低，但**集中度过高**：
   4 条挤在 `header.actions`、4 条挤在 `header.utilities` ✗。
3. **白捡的空位有 4 个**：`conversation.session.header.corner`（官方占用者=右栏展开按钮，**正是我们 CSS 藏掉的那颗**
   ⇒ 对我们事实上空闲 ✓）、`conversation.input.right`（官方空）、`conversation.header.leading`（官方空，且**无会话也渲染** ✓）、
   `conversation.chat.commandview`（官方空）。
4. **最该改的一处风险**：我们把**官方审批卡整个遮蔽**（`conversation.composer` 的 chain 槽 ✓）—— 这是 `replaceRisk:
   shadows-shipped-ui` 级别 ✓，官方审批 UI 一改版我们就对冲 ✗。官方给了 `conversation.approval.detail`（补细节、不动卡片 ✓）⇒ 应降到"补细节"。
5. **一处已修的真 tie**：我们 `vssaros-todo` 原取 order **10**，与官方 `goal`（也在 `conversation.input.dock`、order **10**）
   **真 tie** ✗ —— 守卫当时**报不出来**，因为它登记的官方占位表**漏了 `goal`** ✓（已补登 + 我们挪到空档 **5** ✓）。

---

## 1. 声明机制与硬约束（决定"能不能装、装上会怎样"）

| 问题 | 结论 | 证据 |
|---|---|---|
| 怎么**声明**一个槽 | **没有独立的 define/declare API** ✗：声明 = 父条目 `register/registerFactory` 调用里的 **`children` 表**；`root` 由框架预置 | `dsh-client-ui-slots/lib/index.js:64-72,104-114,224-236` |
| 第三方能否**挖新坑** ✗ | 机制上能（`children`），**实践上只能声明自己的命名空间**：同 key 第二个声明者抛 `slot "X" is already declared`；且你声明的子槽**只在你条目挂载期间存在**（disposer 递归坍缩） | 同上 `:80,193,501-517`；`README.md:46` |
| 注册进**未声明**的槽 | 直接抛 `slot "X" is not declared` | `lib/index.js:165` |
| `kind` 取值 | `single`（单占）/ `list`（有序多条目）/ `keyed`（按键分派）/ `chain`（选择器路由） | `lib/types/index.d.ts:83` |
| `scope` 取值 | `root` / `session-maybe` / `session`（**session 槽在无会话时不存在** ✗） | `:85` |
| 注册字段 | `name`(必填) `key`(keyed 必填) `id`(list 必填) `order`(list 序) `priority`(遮蔽序默认 0) `select`(chain 必填) `inject` `children` `store` `locale` | `lib/index.js:163-219` |
| 冲突行为 | **single** 同 priority 已有占用者 ⇒ 抛；**list** 同 `id` 同 priority ⇒ 抛（同 id 不同 priority = **顶掉**官方那 cell ✗）；**keyed** key 写错 ⇒ **静默不渲染** ✗ | `:172-193`；官方 `tool.call.toolview` 原文 "a typo never renders" |
| `inject` 一词两义 | `ctx.slots.inject('<槽名>', fn)` = 等槽存在的运行时助手（**注册前必须用** ✓）；`register` 的 `inject` 字段 = 业务注入面工厂 | 本仓用法见 `dsh-plugins/check-chat-surface-chunks.mjs:152` |

---

## 2. 官方 slot 全清单（按表面分组；末列是我们的判定）

`判定`：**★已用** / **空位=可用未用** / 可用（官方已占，动它要小心）/ ✗不可见 / —不适用。
`占用者`只列官方（带 id/order 时照抄），我们的条目见 §3。

### 2.1 会话主区 / 会话壳（conversation）

| slot | kind | scope | 官方占用者 | 用途 | 判定 |
|---|---|---|---|---|---|
| `root` | single | root | layout `AppFrame` | 渲染树根洞 | —（框架自用） |
| `main` | keyed | root | conv `ConversationPanel`(key `conversation`) | 主列面板分派 | 可用（单栏下只有 conversation 会渲染） |
| `main.conversation` | single | session-maybe | conv `ConversationRoot` | 会话壳 | 可用（替换=接管整个会话壳 ✗ 不建议） |
| `conversation.view` | list | session | chat `ChatView`(id `chat`)、traj `TrajectoryView`(id `trajectory`) | 会话视图 tab（一次渲染一个） | 可用（加一条=多一个视图 tab ✓ 机会） |
| `conversation.session` | single | session | conv `ConversationSession` | per-session 会话体 | 可用（替换=接管消息区 ✗） |
| `conversation.session.header` | single | session | conv `ConversationSessionHeader` | per-session 标题行容器 | 可用（替换=丢官方标题 ✗） |
| `conversation.session.header.actions` | list | session | apreset `agent-preset`；jobs `job-list`(20)；sub `subagent-catalog`(-30)；agent-team `agent-team` | **标题旁动作（升序）** | **★已用 ×4**（见 §3） |
| `conversation.session.header.utilities` | list | session | oia `open-in-app`；schedule；session-log-export | **右对齐工具位** | **★已用 ×4**（已挤 ✗） |
| `conversation.session.header.corner` | single | session | sbr `ExpandButton`（**已被我们 CSS 隐藏** ✓） | 头部最右角单控件 | **空位**（推荐把 ⚙/更多 迁来 ✓） |
| `conversation.session.header.lineage` | single | session | sub `SubagentHeaderLineage` | 面包屑标题替换位 | ✗黑洞（我们皮肤把面包屑整行 `display:none`，`client.skin.js:74`） |
| `conversation.header` | single | session-maybe | conv `ConversationHeader` | 常驻导航容器（无会话也在 ✓） | 可用 |
| `conversation.header.leading` | single | **root** | **空** | 标题之前的全局导航，**无会话可用** ✓ | **空位**（白捡 ✓） |
| `conversation.chat.node` | keyed | session | chat 各 NodeView（`user`/`context`/`turn-trigger`…） | 聊天流节点分派 | 可用（key 写错静默 ✗） |
| `conversation.chat.commandview` | keyed | session | **空** | 命令块视图分派 | **空位** |
| `conversation.chat.turnTail` | list | session | deliv `DeliverablesTail`；plan `PlanCards`；schedule | 回合尾部附加行 | **★已用**（我们的回合用量页脚 ✓） |
| `conversation.chat.assistant-actions` | list | session | mfb `feedback` **仅 1 条** | 已定稿助手消息的动作行 | **可用未用**（复制/重试/导出应放这里 ✓） |
| `conversation.message.images` | single | session | att `MessageImages` | 消息图片画廊 | 可用（single，装即顶替 ✗） |
| `conversation.trajectory.images` | single | session | att `MessageImages` | 轨迹视图图片画廊 | 可用 |

### 2.2 composer / 输入区

| slot | kind | scope | 官方占用者 | 用途 | 判定 |
|---|---|---|---|---|---|
| `conversation.composer` | **chain** | session | appr `ApprovalPanel`；sub `SubagentReadOnlyComposer`；uq `QuestionComposer` | **选择器路由的 composer 接管** | **★已用（1 条，遮蔽审批）** ⚠ 最高风险 |
| `conversation.composer.bar` | single | session-maybe | conv `InputBar` | composer 主体 | 可用（装=顶掉整个输入条 ✗） |
| `conversation.composer.dock` | list | session | chat `StatsPills`(**仅 1 条**) | composer **卡下方**环境区 | **可用未用**（"环境信息条"正位 ✓） |
| `conversation.input.dock` | list | session | conv `todo`(**0**)、**goal `goal`(10)**、`queue`(20) | composer 卡**上方**全宽区 | **★已用**（我们的任务清单，order **5** ✓） |
| `conversation.input.left` | list | session | **空** | 工具行左侧紧凑控件 | **★已用 ×2**（agent chip / persona chip ✓） |
| `conversation.input.right` | list | session | **空** | 提交按钮之前的紧凑控件 | **空位** |
| `conversation.input.overlay` | list | session | commands `command-popup`；input-trigger `slash-menu`；mfb `feedback-dialog` | composer 卡内浮层 | **★已用 ×2**（自绘面板 ✓） |
| `conversation.input.attachments` | single | session-maybe | att `ComposerAttachments` | 草稿附件栏/拖放目标 | 可用 |
| `conversation.input.activity` | single | session | voice `VoiceInput`（**实验，未装即空** ✓） | 可**横向占满**工具行的单动作 | **空位**（比挤 `input.left` 更省 ✓） |
| `conversation.input.model` | single | session | msel `ModelSelect` | 模型选择器 | 可用（装=顶掉官方模型选择 ✗） |
| `conversation.input.plan` | single | session | plan `PlanChip` | 计划控件 | 可用 |
| `conversation.input.permission` | single | session | perm `PermissionSelect` | 权限控件 | 可用 |
| `conversation.plan-review.actions` | list | session | plan `PlanReviewOpen` | 计划评审卡动作 | —（仅评审待处理时存在） |
| `conversation.approval.detail` | single | session | chat `ApprovalCommand` | **审批请求关联的工具调用详情**（由 composer 条目声明） | **可用未用** ⚠ 降险关键 |

### 2.3 Hero（空会话）

| slot | kind | scope | 官方占用者 | 判定 |
|---|---|---|---|---|
| `conversation.hero.brand.mark` | single | root | **空** | **★已用**（我们的品牌标 ✓） |
| `conversation.hero.workspace` | single | root | ws `WorkspacePicker` | 可用 |
| `conversation.hero.workspace.directoryFlow` | single | root | dpb/dpn 目录流程 | **可用未用**（自绘目录选择器的官方挂点 ✓） |
| `conversation.hero.agentPreset` | single | session-maybe | apreset `AgentPresetSeat` | **★已用**（遮蔽官方 ✓） |

### 2.4 工具调用 / 交付 / 其它（聊天可见）

| slot | kind | scope | 官方占用者 | 判定 |
|---|---|---|---|---|
| `tool.call.toolview` | keyed | session | deliv/skill/tool 各 Row（key=**工具名**） | 可用（key 写错静默 ✗；我们换皮走服务替换 ✓ 不占槽） |
| `tool.call.images` | single | session | att `MessageImages` | 可用（只能被一个 toolview 声明） |
| `tool.view.cordis` | keyed | session | pm | 可用 |
| `deliverables.file.actions` | list | session | oia `open-in-app` | 可用（加 id 即追加 ✓） |
| `deliverables.review.file.actions` | list | session | oia `open-in-app` | 可用 |

### 2.5 不可见整族（约 40 个槽 —— 我们形态下**装得上但用户永远看不见** ✗）

| 族 | 槽（举例） | 为什么不可见 |
|---|---|---|
| 左侧栏 `sidebar.*`（13） | `sidebar`、`sidebar.brand.mark/name`、`sidebar.panellist`、`sidebar.workspaces`、`sidebar.workspaces.session.menu.item`、`sidebar.session.row.leading/hover`、`sidebar.settings`、`sidebar.footer.action`、`sidebar.chat.conversation` … | `DSH_CHAT_ONLY_CSS` 把 `[data-slot="sidebar"]` 整列 `display:none` ✗ |
| 右侧栏 `rightbar.*` / `sidebar.right.*`（17） | `rightbar`、`rightbar.session`、`sidebar.right.pane.tab`(+`.title`)、`sidebar.right.tab.guide`(+`.entry`)、`sidebar.right.tab.menu.item`、`sidebar.right.tab.document*`、`sidebar.right.tab.files.actions` … | 同上（右栏整列被裁，连"展开右栏"按钮都被藏） |
| 设置面板 `settings.*`（13） | `settings.launcher`、`settings.trigger`、`settings.section`、`settings.general.item`、`settings.plugins.tab`、`settings.models.*` … | 槽能注册、程序化打开也渲染得出，但**官方唯一入口 `sidebar.settings` 在侧栏、已被裁** ⇒ 不能当功能唯一入口 ✗ |
| 插件面板 `plugins.*`（7） | `plugins.item`、`plugins.detail.actions/section/badge`、`plugins.bundle.activation/config` … | 选择入口在主列面板，而面板切换入口在侧栏 ✗ |
| 框架层（3） | `shell.leading`、`shell.overlay`、`shell.quota-notice` | **不在被裁两列内** ⇒ 可用 ✓（overlay 是 frame 的无条件子元素 ✓） |

---

## 3. 我们的覆盖（9 槽 / 17 条，全部在 conversation 表面）

| 槽 | id | order | 落点 | 作用 |
|---|---|---|---|---|
| `conversation.session.header.actions` | `vssaros-workspace-chip` | -30 | `client.workspace.js:448` | 工作区 chip（⚠ 与官方 `subagent-catalog` 同为 -30，历史 tie，已登记 ✓） |
| 〃 | `vssaros-worktree-chip` | -20 | `client.workspace.js:456` | worktree chip |
| 〃 | `vssaros-subagents` | -25 | `client.subagents.js:248` | **子智能体入口**（切会话 ✓，P0 新加） |
| 〃 | `agent-preset` | -10 | `client.agents.js:1077` | 兜底自绘 preset 标签（**遮蔽官方** ⚠） |
| `conversation.session.header.utilities` | `vssaros-settings` | -2 | `client.settings.js:180` | ⚙ 设置菜单 |
| 〃 | `vssaros-sessions` | -3 | `client.sessions.js:238` | 新建/历史会话 |
| 〃 | `vssaros-ping` | — | `client.hideBridgePing.js:29` | **遮蔽**桥 ping 提示（⚠） |
| 〃 | `open-in-app` | — | `client.openInApp.js:23` | **遮蔽**官方"在应用打开"（⚠） |
| `conversation.input.left` | `vssaros-agent-chip` / `vssaros-persona-chip` | 0 / 1 | `client.agents.js:1002` / `client.persona.js:265` | agent / 人格 chip |
| `conversation.input.overlay` | `vssaros-agents-panel` / `vssaros-persona-panel` | 0 / 1 | `client.agents.js:1012` / `client.persona.js:271` | 自绘浮层（官方此槽已占 3 条） |
| `conversation.input.dock` | `vssaros-todo` | **5** | `client.todos.js` | **任务清单（带动作）**（P0 新加；官方 todo=0/goal=10/queue=20 ✓） |
| `conversation.composer` | （chain，`select approval`） | — | `client.approval.js:67` | **遮蔽官方审批卡** ⚠ 最高风险 |
| `conversation.chat.turnTail` | `vssaros-turn-usage` | — | `client.usage.js:517` | 回合用量页脚 |
| `conversation.hero.brand.mark` | `vssaros-hero-mark` | 100 | `client.hero.js:47` | 空会话品牌标 |
| `conversation.hero.agentPreset` | `vssaros-preset-chip-hero` | — | `client.preset.js:224` | hero preset chip（**遮蔽官方** ⚠） |

> **不注册槽的三条**：`client.tools.js`（换皮走**服务替换**）、`client.fileCards.js` / `client.cardActions.js`（**DOM 读数 + 点击接管**）、`client.sessionLabel.js`（服务替换）—— 它们不占槽面 ✓（也是为什么"槽清单"看不全我们的能力 ✓）。
>
> ⚠ **`replaceRisk: shadows-shipped-ui` 清单**（我们的遮蔽面，官方改版时要逐个复核）：`agent-preset`(-10)、
> `vssaros-ping`、`open-in-app`、`composer` 的审批分支、`hero.agentPreset` 的 -10。

---

## 4. 差距与机会（按"用户看得见 / 省自绘成本 / 与官方一致性"排序）

1. **`conversation.session.header.corner`（single）** —— 官方占用者=右栏展开按钮，**正是我们 CSS 藏掉的那颗**
   ⇒ 对我们事实上**空闲** ✓。把「⚙ 设置 / 更多」迁到这里：比继续在 `utilities` 的 -2/-3 挤更贴官方语义 ✓，
   且不与官方其它工具位抢格 ✓。
2. **`conversation.input.right`（list，官方空）+ `conversation.header.leading`（single/root，官方空、**无会话也渲染**）**
   —— 两个白捡空位 ✓，可显著缓解 header 拥挤 ✓（后者还能承载"全局入口"这层我们目前没有的位置 ✓）。
3. **`conversation.chat.assistant-actions`（list，官方仅 `feedback` 一条）** —— "助手消息动作行"的官方 seat，
   我们**完全没用** ✗，反而把回合用量自绘在 `turnTail` ⇒ 动作类（复制 / 重试 / 反馈 / 导出）应优先注册这里 ✓。
4. **`conversation.composer.dock`（list，官方仅 `stats` 一条）** —— 语义是"**composer 下方环境信息条**" ✓；
   我们的用量页脚放 `turnTail` 是"回合尾部" ✗ ⇒ 至少值得评估迁移（可少写一层自绘定位 ✓）。
5. **`conversation.input.activity`（single，官方=实验语音、未装即空）** —— 唯一"可横向占满工具行但仍保留编辑器与
   提交按钮"的 seat ✓ ⇒ 比在 `input.left` 里挤自绘 chip 更省、更抗官方改版 ✓。
6. **`conversation.approval.detail`（single）** —— 官方给的"**补细节、不动卡片**"挂点 ✓。我们现在是 **chain 整卡遮蔽**
   （`replaceRisk: shadows-shipped-ui`）✗ ⇒ 建议改为"保留官方审批 composer + 用 `approval.detail` 补我们想加的信息"，
   一次性把这块对冲风险降下来 ✓（**优先级最高的一处风险收敛** ✓）。
7. **`conversation.view`（list）** —— 加一条 = 会话区多一个视图 tab ✓；我们的模块页目前全开在**编辑区** ✓，
   若想让"看板 / 工作流 / 知识库"贴着会话看，这是官方给的位 ✓（成本：视图组件 + 与编辑区页共存的口径 ✓）。
8. **`conversation.hero.workspace.directoryFlow`（single/root）** —— 想自绘"在聊天框里选文件夹"时，官方已有
   browse / native 两个实现可参照，复用它可以不重写整个目录选择流程 ✓。
9. **不可见整族（sidebar/rightbar/settings/plugins，约 40 槽）** —— **不要注册** ✗：装得上、渲染得出、用户永远看不见；
   本仓已有**三次实盘记录**（`client.tools.js:14` 右栏打开文件没反应、`client.fileCards.js:9`、`client.subagents.js:9`
   子代理目录开右栏没反应 ✓）。**任何"官方能力已在右栏"的功能都必须换落点重做** ✓。
10. **`conversation.session.header.lineage`** —— 存在且可注册，但我们皮肤把面包屑整行 `display:none`
    （`client.skin.js:74`）⇒ 注册进去等于扔黑洞 ✗；要么别注册，要么先改皮肤（放开面包屑 ✓）。

---

## 5. 优化方案（分期）

### P0 —— 零风险、纯页面侧（1 个插件 bump，可与下批合并）

| 项 | 落点 | 成本 | 守卫 / 探针 |
|---|---|---|---|
| **P0-1 官方占位表补全 + 无 tie 复核** | `dsh-plugins/check-chat-surface-chunks.mjs` 的官方表（补 `goal`(10) 等） | 极小 | ✅ **已完成**（本轮：`vssaros-todo` 10 ➜ **5** ✓） |
| **P0-2 ⚙ 迁 `header.corner`** | `client.settings.js`（id/order 不变，仅换槽）+ 官方占位表登记 | 小 | 守卫（槽白名单 + id/order）+ 真机截图复核 |
| **P0-3 `input.right` / `header.leading` 收纳** | 视 P0-2 效果决定是否再挪 chip | 小 | 同上 |

### P1 —— 语义归位（中等，仍不改桥）

| 项 | 落点 | 风险 |
|---|---|---|
| **P1-1 审批降险**：保留官方 `conversation.composer` 审批分支，改用 `conversation.approval.detail` 补细节 | `client.approval.js`（改写为主） | 中（要逐条复核我们原来自绘的四条纪律 ✓） |
| **P1-2 助手消息动作进 `assistant-actions`**（复制 / 重试 / 导出…） | 新 chunk `client.assistantActions.js` | 低（官方仅 1 条，同槽并存 ✓） |
| **P1-3 用量/环境信息评估迁 `composer.dock`**（或双挂） | `client.usage.js` | 低（先只加观测、不动现有 ✓） |

### P2 —— 需要拍板

| 项 | 要拍板的点 |
|---|---|
| **P2-1 会话区视图 tab（`conversation.view`）**：把看板/工作流/知识库做成"贴会话的视图" | 与现有"编辑区整页"并存还是替代 ✗ |
| **P2-2 `input.activity` 承载 agent/人格 chip** | 是否接受"占据工具行"的视觉变化（要 mockup ✓） |
| **P2-3 shell 层（`shell.overlay` 等）承载全局提示/引导** | 是否需要（目前 toast 走 IDE 通知 ✓） |

### 反模式（**列入禁区** ✗）

- 任何 `sidebar.*` / `rightbar.*` / `sidebar.right.*` / `settings.*` / `plugins.*` 的注册（用户看不见 ✗）；
- 新 slot 自己**声明**（官方机制"只能填坑不能挖坑"，且声明只在自己挂载期存在 ✗）；
- keyed 槽 key 拼错（**静默不渲染** ✗）；list 槽不带 `id` 或与官方 `id` 同 priority（**顶掉官方** ✗）。

---

## 6. 待拍板

1. **P0-2 是否把 ⚙ 迁到 `header.corner`**（官方占用者已被我们藏掉 ⇒ 事实上空闲 ✓，但这是"用了一个官方已声明、我们单方面让它空出来的位" ⚠，将来若恢复右栏按钮会撞 ✗）。
2. **P1-1 审批降险是否现在做**（收益：去掉最大一处 `shadows-shipped-ui` ✓；成本：要重验我们自绘的四条纪律 ✓）。
3. **P2-1 会话区视图 tab** 与现有编辑区整页的关系（并存 / 替代）。

---

## 7. 复核方法（这份文档怎么保持不腐烂）

1. **权威清单**：`dsh-cordis-client-runner/lib/client.js:2363+` 的 `CLIENT_SLOT_API`（升级 dsh 后重读 ✓）；
   或用运行时 `cordis_inspect what:"client"` ✓。⚠ 读它要用**文件级**路径（`/dsh-runtime/` 在 `.gitignore` 里，ripgrep 搜不到 ✗）。
2. **我们的覆盖**：`node dsh-plugins/check-chat-surface-chunks.mjs`（真装载每个 chunk + 真跑 `install`，输出我们全部
   `(slot, id, order)` ✓，并校验与官方占位表的 id/order 冲突 ✓；**含反向突变验证** ✓）。
3. **官方占位表**：`check-chat-surface-chunks.mjs` 的 `OFFICIAL_ENTRIES` —— **改一次 dsh 版本就要拿 §7.1 的清单复核**；
   本轮真事：漏登记 `goal` ⇒ 我们与它 tie 了一个月都报不出来 ✗（已补 ✓）。
