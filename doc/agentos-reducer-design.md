# AgentOS Loop Reducer 化设计（对齐 LangGraph state-schema + channel reducer）

> 状态：设计已确认（2026-07-13）。实施分 5 步，每步可独立合入 / 回滚。
> 关联：LangGraph 优化总进度（P0 重试退避 / P0b 流式超时 / P1 fork 已落地）。
> 本设计是此前被搁置的 **checkpoint/resume**、**supervisor/AgentCommand(goto)** 的**前置地基**。

## 1. 目标与边界

- 对齐 LangGraph 的「**state schema + channel reducer**」模型：状态是一个带类型的纯对象，每个 channel 用**纯函数**合并增量，而非就地 mutate。
- **不动**：Path1/Path2（`ExecutionProvider`）、error-handler 三级降级路由（已是 langgraph error-handler 等价）、流式累加缓冲。
- **不引入**真正的 langgraph 运行时 / 图引擎——只借鉴 state/reducer 心智模型（我们是 AgentOS，不是 JS 版 langgraph）。

## 2. 现状痛点（已核实）

目标代码：`_executeWithFallbackDirectly`（`src/vs/sessions/contrib/agentStudio/browser/agentOSService.ts` L1108–L2675）。

- 主对话线程 `messages` 在 L2143/2194/2232/2325/2402/2428/2457/2488 共 **8 处 `push`** + L1319/1387 两处 `splice`，全程裸 `any[]`。
- 一批 `let` 控制变量散落：
  - `iteration` (L1408)、`invalidToolNameCount` (L1409)
  - `hasModifiedFiles` (L1458)、`reflectCount` (L1459)、`MAX_REFLECT_ITERATIONS`
  - `continuationNudgeCount` (L1491)、`forceToolChoiceNextIteration` (L1500)、`lastIterationForcedToolChoice` (L1504)
  - `lastRealPromptTokens` (L1486)、`_toolCallHistory` + `detectToolCallLoop` (L1416)
  - `startedToolIds` / `endedToolIds`（孤儿对账，L2222 附近）
- `phase` 通过 `yield { type: 'phase_change', phase }` 广播给 UI，但 **loop 内部没有状态对象**——phase 是隐式代码顺序，与 UI 广播不同源。
- 上述循环检测 / reflect / 续跑 nudge / forced tool choice / invalid-tool 熔断逻辑全是**无单测的隐式状态机**，最易回归。

## 3. 设计

### 3.1 `AgentRunState`（state schema）

```ts
interface AgentRunState {
  messages: AgentRunMessage[];          // 主线程（reducer: append）
  iteration: number;
  phase: StreamPhase;                  // 显式阶段机（对齐 providers.ts StreamPhase）
  invalidToolNameCount: number;
  continuationNudgeCount: number;
  reflectCount: number;
  hasModifiedFiles: boolean;
  forceToolChoiceNextIteration: boolean;
  lastIterationForcedToolChoice: boolean;
  toolCallHistory: { name: string; argsHash: string }[];   // 带窗口裁剪
  startedToolIds: string[];
  endedToolIds: string[];
  lastRealPromptTokens: number;
  reducerMode: 'legacy' | 'reducer';   // 灰度
}
```

**明确不做 reducer 的**：`_assistantChunks` / `_thinkingChunks` / `assistantToolCalls` 流式累加缓冲——天然增量、强塞反而损性能，保持原样。

### 3.2 Channel reducers（纯函数，对齐 LangGraph `Annotated` reducer）

```ts
appendMessages(prev, ...m): [...prev, ...m]              // = langgraph addMessages
increment(prev, by=1): prev + by
appendToolHistory(prev, entry, window): trim → [...prev, entry]
setFlag / mergeCounters ...
compactMessages(prev, compressed): compressed            // 压缩替换（纯换底）
// 组合入口（纯、不可变）：
reduceRunState(state: AgentRunState, action: AgentAction): AgentRunState
```

### 3.3 `AgentAction`（动作联合）

`APPEND_MESSAGES` · `COMPACT_MESSAGES` · `BUMP_ITERATION` · `SET_PHASE` · `RECORD_TOOL_CALL` · `RECONCILE_ORPHANS` · `INVALID_TOOL_NAME` · `REFLECT` · `CONTINUATION_NUDGE` · `SET_FORCE_TOOL_CHOICE` · `MARK_FILE_MODIFIED`

### 3.4 接入（增量，零行为变更）

- 新增 `common/agentRunState.ts`：类型 + 纯 reducer + `createInitialRunState(request)` 工厂 + 单测。
- loop 内 `let state = createInitialRunState(request)`；热点 mutation 改为 `state = reduceRunState(state, action)`。
- `messages.push/splice` 全部收口到 `APPEND_MESSAGES` / `COMPACT_MESSAGES` 两个 action——**单点**便于加 size guard / token 计费 / 复用已修的字符串泄漏防护。
- 每次 `yield { type: 'phase_change' }` 前先 `SET_PHASE`，loop 内部 phase 与 UI 广播同源。

### 3.5 序列化 seam（隐藏的最大收益）

`AgentRunState` 是纯 JSON 对象（无函数 / 类实例）→ 直接 `snapshot()` / `restore()`。
→ 这就是之前「未做」的 **checkpoint/resume** 和 **supervisor/goto** 变得可行的关键前提：在 iteration 边界 `toJSON` 存盘即可恢复。

### 3.6 灰度 / 回滚

`AgentOSReducerMode` 开关（legacy | reducer），默认 legacy 短期；新会话可开 reducer 路径。两条路并存，回滚 = 翻开关。

## 4. 收益

- **可单测**：最易回归的控制逻辑变成纯 `(state, action) -> state` 测试，无需 live model / provider。
- **单点收口 messages 增长** → 防止数组膨胀类 bug 复发。
- **解锁 checkpoint/resume、supervisor/goto**（此前因无统一 state 对象被搁置）。

## 5. 实施步骤（每步可独立合入、可回滚）

1. `common/agentRunState.ts`：类型 + reducer + 工厂 + 单测（纯函数，零风险）。✅ 本次实施
2. 热点收口 `messages` 的 append / compact 两个 action（最高频 bug 点）。
3. 控制变量（iteration / counters / flags / toolCallHistory）迁到 reducer。
4. `phase` 显式化 + 灰度开关。
5. （后续独立项）`snapshot/restore` 接 checkpoint——**已落地 2026-07-14**：`agentRunState.ts` 新增 `snapshotRunState(state)`（带版本 `AGENT_RUN_STATE_VERSION` 深拷贝）/ `restoreRunState(input)`（容错：快照 `{version,state}` 与裸 `AgentRunState` 两种形态，版本过高/损坏回退初始，`normalizeRunState` 缺省补全）/ `prepareResumeRunState(graph, restored)`（supervisor 续跑起点）；纯函数 + 单测，零行为变更。消费方见 `doc/agentos-supervisor-goto-design.md` Step D（`executeAgentGraph` 经注入式 `checkpointSink` 落盘、从 `currentNodeId` 续跑）。

## 6. 不做的事（明确边界）

- 不重写 streaming 累加缓冲为 reducer。
- 不引入真正的 LangGraph 运行时 / 图引擎。
- 不动 error-handler 路由（已是 langgraph error-handler 等价）。
