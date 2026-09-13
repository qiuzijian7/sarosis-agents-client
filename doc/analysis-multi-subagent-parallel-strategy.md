# 多 SubAgent 并行 + 聊天框流式工具卡片：本项目的机制分析与策略选型

> 配套调研文档：`research-multi-subagent-parallel-streaming.md`
> 分析日期：2026-07-20
> 关键判断：**本项目的「并行执行发动机」早已就位；真正缺的只是「并行 subagent 事件流 → 聊天框卡片」这截接线**——而这条接线在 `planExploreTool` 里已经被完整验证过。

---

## 0. 结论速览（先看这里）

| 维度 | 现状 | 结论 |
|---|---|---|
| 多 subagent 并行执行 | ✅ 已具备（`UnifiedSubAgentDispatch.executeMultipleSubAgents` / `dispatchParallelExplore` / `SwarmService` 真并行） | 不需新建并行能力 |
| 聊天框流式工具卡片 | ⚠️ 部分具备（仅 `planExploreTool` 接了事件总线；`delegate_task` / `swarm` 未接） | **缺的是接线，不是能力** |
| 取消/隔离 | ✅ 已具备（subagent/peer 双隔离档 + AbortSignal 级联 + `interruptSubAgentGlobal`） | 可复用 |

**推荐策略 A：复用已验证的 `SubAgentTrace` 旁路总线**——把 `planExploreTool` 的 `inlineTraceSink`（`SubAgentEvent` → 卡片快照 → `agentOS.fireSubAgentTrace`）移植到 `delegationTools.ts` 与 `swarmService.ts` 的 `eventSink` 参数里。改动集中在 host 侧 2 处，约 1 天工作量，风险极低。

根因一句话：`delegationTools.ts:294` 与 `:319` 把 `dispatchParallelExplore` 的 `eventSink` 传成了 **`undefined`**——并行 subagent 在跑，事件流却被丢弃，聊天框自然看不到卡片。

---

## 1. 本项目 agentloop 中的 subagent 机制全景

### 1.1 调度核心：`UnifiedSubAgentDispatch`（`common/unifiedSubAgentDispatch.ts`）

这是所有 subagent 的单一入口，已内建完备的并行与事件能力：

- **并行执行**
  - `executeMultipleSubAgents`（`:967`）——按 `_maxConcurrent`（默认 **3**）分批，用 `Promise.allSettled` 扇出，一个失败不影响整批。
  - `dispatchParallelExplore`（`:1031`）——创建多个 subagent 并自动生成 `groupId` 把整批聚簇（`:1063` 注释："Cluster all parallel explore agents under one group so the UI can render them as a single grouped SubAgentCard"）。
- **细粒度事件通道 `SubAgentEvent` + `eventSink`**（`:282-357`）
  - 事件类型：`Spawned / Thinking / ToolStarted / ToolCompleted / Progress / Completed / Failed / Interrupted`。
  - 每个事件携带 `subAgentId / subAgentType / task / parentId` 以及 `toolName / toolArgsPreview / toolResultPreview / thinkingText / output` 等载荷。
  - **关键字段 `groupId`**（`:344`）："Group id to cluster parallel sub-agents into one card"——UI 聚簇语义在设计层就已预留。
  - `_emit` 把事件投递给 `eventSink`（`:1487`），且明确注释"the caller (e.g. the webview controller) can translate them into `IChatStreamDelta` deltas"。
- **隔离档位 `subagent` / `peer`**（`:133`）
  - `subagent`（默认）：层级受控，父 turn 的 `AbortSignal` 级联取消子代（P3）。
  - `peer`：对等独立，父 abort **不**级联，只有显式 `interruptSubAgent` / `cancelSwarm` 才停。Swarm worker 显式用 `peer`（见 1.2）。
- **取消**：`interruptSubAgentGlobal`（`:458`）递归中断 + `_interruptedSubAgents` 集合 + `_executeWithBudget` 每轮 delta 检查中断信号（`:1462`）。

> 这意味着：**并行 + 流式事件 + 按组聚簇 + 安全取消，调度层一步到位**。

### 1.2 编排层：`SwarmService`（`browser/providers/swarm/swarmService.ts`）——真·并行

- `_runSwarm`（`:216`）直接 `Promise.all(workerPromises)`（`:232`）让所有 worker **真正并行**，再串 verifier、再串 synthesizer。
- worker/aggregator 均用 `isolationLevel: 'peer'`（`:303`、`:351`），经 `dispatch.dispatch(...)` 执行。
- **但**：三个 `dispatch.dispatch` 调用（`:296`、`:346`）**都没传 `eventSink`**；worker 的流式过程只以 `postBlackboardUpdate`（`:427`）文本追加到根任务描述。聊天框侧仅有 `onDidUpdateSwarm`（`:61`）驱动的拓扑/阶段 UI，**逐 token 工具卡片未进聊天框**。

### 1.3 触发入口：`delegate_task`（`browser/providers/tool/delegationTools.ts`）

- 单任务走 `dispatch(...)`（`:289`），批量任务走 `dispatchParallelExplore(...)`（`:313`）。
- **根因**：`:294` 与 `:319` 的 `eventSink` 参数都是 `undefined` → 并行 subagent 在跑，但 `SubAgentEvent` 流被丢弃。
- 最终只把每个 subagent 的结构化文本结果拼成一段 `text` 回父（`:298`、`:323-325` `formatDelegationResult`）。

### 1.4 聊天框渲染层（已验证通道）

- **`planExploreTool.ts:317` 是「多 subagent 并行 + 流式工具卡片」的完整范本**：
  - 定义 `inlineTraceSink`（`SubAgentEventSink`，`:239-303`）——把每个 subagent 的生命周期事件累积进 `cardMap`（含 `toolTraces`）。
  - 节流 `scheduleFlush`（`:233`，~100ms）后调用 **`ctx.agentOS.fireSubAgentTrace({ groupId, subagentData })`**（`:223`）。
- **`agentOSService.fireSubAgentTrace`**（`browser/agentOSService.ts:344`）→ 发射 `_onDidSubAgentTrace`（`:342`）→ **`nativeChatEditorPane` 订阅并把 `subAgents: SubAgentInfo[]` upsert 到当前流式 assistant 消息**，按 `groupId` 聚簇，字段含 `streamedText / thinking / toolTrace`（实时流式）。
- webview 数据模型 `SubAgentInfo`（`webview/src/store/useChatStore.ts:258-316`）**已含** `groupId / streamedText / thinking / toolTrace` 等流式字段；`LiveWorkflowSubAgent` 与 `liveWorkflowExecutions` 通道则是 workflow 节点并行卡片的另一条已通路径（`workflowExecutionService.ts:1093` 发 `subagent_start` → `workflowTraceController.ts` → chatPanel）。
- 取消已贯通：父 turn abort → `signal` 传入 `dispatch`（`:320`、`:318`）→ 子 `peer` 档降级不级联、`subagent` 档级联中断。

> **结论**：聊天框渲染并行 subagent 流式工具卡片的能力**已经存在且跑通**，只是被 `planExploreTool` 独占。delegate/swarm 只是没把事件接进来。

---

## 2. 结合调研文档的对照

调研文档的核心结论：
1. 主流框架（LangGraph/AG2/OpenAI Agents/CrewAI/Agno…）"多 subagent 并行"普遍可行；
2. **"聊天框中并行流式输出各 subagent 内容"才是真正区分点**，且分两种形态：
   - 模式 A：并行算完再汇总流式（fan-out + Synthesizer）
   - 模式 B：每 agent 独立卡片同时吐字（真·并行可视）
3. AG-UI Protocol（CopilotKit）是"聊天框并行流式"的事实标准事件层。

把本项目能力映射到调研结论：

| 调研维度 | 本项目对应 | 对照结论 |
|---|---|---|
| 并行执行 | `executeMultipleSubAgents` / `dispatchParallelExplore` / `SwarmService.Promise.all` | ✅ 胜过多数"需自建并行"的开源方案 |
| 流式卡片（模式 B） | `SubAgentTrace` 总线 + `SubAgentInfo` 三色块（思考/工具/输出，对应关键约定 7/9） | ✅ 已验证，但仅 `planExploreTool` 接线 |
| 协议层 | `IChatStreamDelta` + `SubAgentEvent`（含 `groupId`/`type`/`source` 可扩展） | 与 AG-UI 事件 schema 同构，可平滑对齐 |
| 取消/隔离 | subagent/peer 双档 + `cancelStream(agentId, agentSessionId)` | ✅ 已支持按流精确 abort（关键约定 5） |

**本项目与调研中开源项目的本质差异**：开源项目大多在"框架层就缺聊天框并行流式这层"；而本项目**能力层齐备，缺的是把 delegate/swarm 的事件流接进已存在的 `SubAgentTrace` 总线**——这是一个接线 bug / 未接线，而非架构缺口。

---

## 3. 策略选型与优缺点

### 策略 A（推荐）：复用 `SubAgentTrace` 旁路总线，补上 `eventSink` 接线

**做法**：将 `planExploreTool.ts:239-303` 的 `inlineTraceSink` 移植为通用 helper，注入到：
- `delegationTools.ts:313-321` 的 `dispatchParallelExplore` 调用（去掉 `areaIndex` 特化，改用 `ev.groupId` 聚簇）；
- `swarmService.ts:296` 与 `:346` 的 `dispatch.dispatch` 调用（worker 用 `peer` 隔离、`groupId = swarmId`）。

**优点**
- 复用已验证渲染层（`nativeChatEditorPane` + `SubAgentInfo` 三色块），**零 UI 重写**；
- 改动集中在 host 侧 2 处，约 1 天，风险极低；
- 视觉与现有 workflow/subagent 卡片一致（思考紫/工具橙/输出蓝，关键约定 7/9）；
- 取消链路天然复用（subagent 级联 / peer 独立 + AbortSignal）；
- 与调研推荐的"模式 B 真·并行可视"完全吻合。

**缺点 / 注意**
- `SubAgentInfo` 为 workflow/explore 场景设计，swarm 接入时需确认字段对齐（`groupId/type/name/status/streamedText/thinking/toolTrace`）；
- `inlineTraceSink` 有 ~100ms 节流（`scheduleFlush`），超高频率 tool 事件会略有延迟（可下调）；
- 同一父消息内多个 `groupId` 的布局（并排 vs 纵向堆叠）需明确，但属纯 UI 微调。

---

### 策略 B：把每个 subagent 提升为独立 agent session（fan-out 多会话）

**做法**：每个并行 subagent 走完整 `sendMessage` 管线（`_sendAndTrackStream` / `cancelStream` / 内存事件），各自独立 `sessionId`；UI 侧同屏渲染多张卡片。

**优点**
- subagent 成为一等公民：历史持久化、模型 override、内存事件全部天然支持；
- 最大化复用单 agent 的成熟流式基础设施。

**缺点**
- N 个并行 = N 倍 session 状态成本（文件/内存/历史持久化），与 `_historyCache` MAX_CACHED_SESSION_BUCKETS=15（agentChatService.ts:119）等约束冲突；
- `_activeOnDeltas` 虽按 `streamKey` 支持并发（agentChatService.ts:97），但"同屏多卡片"需重新设计 UI 布局，与现有 `SubAgentInfo` 卡片体系不统一；
- 与 swarm 的 `peer` 隔离语义冲突（peer 不应进父 session）；
- 工作量大（L 级，数天），收益却不如 A。

---

### 策略 C：Swarm 维持拓扑/阶段 UI（不渲染逐 token 工具卡片）

**做法**：swarm 维持现状，worker 间以 blackboard 解耦，UI 走看板拓扑 + 阶段流式。

**优点**：实现最简单；worker 解耦清晰，适合"宏观协作"叙事。

**缺点**：**不满足诉求**——只流式阶段文本与 blackboard，不流式工具级卡片。仅可作降级方案，不能单独满足"聊天框 subagent 工具卡片流式输出并行内容"。

---

### 策略 D：Workflow DAG 并行节点（`IWorkflowExecutionService`）

**做法**：把并行 subagent 建模为 workflow 的并行节点，复用已通的 `subagent_start` / `delta` / `subagent_end` 通道（经 `workflowTraceController` → chatPanel）。

**优点**：底层即"真并行 + 卡片流式"，是最成熟的通道；`onDidExecutionTrace` 路由已完备。

**缺点**：需把任务显式建模成 workflow，对 ad-hoc 的 LLM 自主委派（`delegate_task`）不直接适用；与 delegate 的"模型自己决定拆分"语义割裂；适合"编排驱动"场景而非"对话内随手并行"。

---

## 4. 推荐落地路径（策略 A，file:line 级）

| 步骤 | 位置 | 动作 |
|---|---|---|
| **S1** | `delegationTools.ts:313-321` | 注入通用 `inlineTraceSink`（从 `planExploreTool.ts:239-303` 提取为 `common/subAgentTraceSink.ts` helper，去掉 `areaIndex` 特化，直接用 `ev.groupId`）。`groupId` 由 `dispatchParallelExplore` 自动生成。 |
| **S2** | `swarmService.ts:296`、`:346` | `dispatch.dispatch(..., { isolationLevel:'peer' }, eventSink)` 补上传入的 `inlineTraceSink`；worker 用 `groupId = swarmId`，aggregator 同理。 |
| **S3** | （无需改） | `nativeChatEditorPane` 已订阅 `onDidSubAgentTrace` 并按 `groupId` upsert `subAgents`（`planExploreTool` 已跑通）——确认即可。 |
| **S4** | 验证 | 父 turn 点停止 → `signal` 级联中断 `subagent` 档子流、`peer` 档不级联；并行流各自精确 abort（对应关键约定 5 的 `cancelStream(agentId, agentSessionId)`）。 |
| **S5** | 可选 UI | 调整同一 `groupId` 内多卡片的并排/堆叠布局与节流窗口（默认 100ms）。 |

**两条总线不冲突**：workflow 走 `onDidExecutionTrace`；delegate/swarm 走 `onDidSubAgentTrace`（`_onDidSubAgentTrace`），互不干扰。

---

## 5. 风险与边界

1. **节流延迟**：`scheduleFlush` 默认 100ms（planExploreTool.ts:236），高频 tool 事件略有滞后；若需更跟手可下调至 ~40ms。
2. **字段对齐**：`fireSubAgentTrace` 的 `subagentData` 必须含 `groupId / type / name / status / streamedText / thinking / toolTrace`，否则 `SubAgentInfo` 渲染缺字段。
3. **上下文归属**：delegate 的 subagent 卡片 upsert 到**父 turn 的流式 assistant 消息**（与 planExploreTool 同）——这是期望行为（并行子 agent 作为父轮下的卡片簇出现），无需额外处理 session 路由。
4. **与 workflow 通道隔离**：两者独立，delegate/swarm 接入不影响既有 workflow 卡片渲染。

---

## 6. 一句话总结

> 本项目"多 subagent 并行"的发动机（调度层 + swarm）早已点火；"聊天框并行流式工具卡片"的渲染层（`SubAgentTrace` 总线 + `SubAgentInfo` 三色块）也被 `planExploreTool` 验证可用。**唯一缺口是 `delegate_task` 与 `swarm` 把 `eventSink` 传成了 `undefined`**。把 `planExploreTool` 的 `inlineTraceSink` + `fireSubAgentTrace` 移植过去，即可在最低风险下达成"多 subagent 并行执行 + 聊天框 subagent 工具卡片流式输出并行内容"——这是策略 A，也是唯一兼具低风险与高保真的方案。
