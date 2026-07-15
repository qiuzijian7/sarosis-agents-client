# AgentOS Supervisor / `AgentCommand(goto)` 设计

> 状态：设计草案（2026-07-14）。**前置依赖**：`doc/agentos-reducer-design.md`（Step 1~4 已落地；Step 5 snapshot/restore 待做）。
> 本设计是 reducer 化落地的**直接后续收益项**：`AgentRunState`（纯 JSON 可序列化）使"多 agent 图"首次可被统一 snapshot/resume。
> 关联：LangGraph supervisor 模式 + `Command(goto=...)` 路由原语。

## 0. 一句话定义

把现有的**单 agent loop** 升级为一个 **agent 图运行时**：图由若干 *agent 节点* 与 *边* 组成；每个节点 = 一次既有 loop 运行（`_executeWithFallbackDirectly`），节点在"自然停止点"返回一个 `AgentCommand`（含 `goto`）告诉运行时**下一个去哪个节点**。supervisor 只是一种特殊节点（由 LLM 决定 `goto` 到哪个 worker）。

这等价于 LangGraph 的 `Command(goto=...)`，但只借用心智模型，不引入真正的图引擎。

## 1. 目标与边界

### 1.1 目标
- 支持 **动态 LLM 驱动的 agent 间路由**（supervisor 模式）：supervisor 节点根据上下文 `Command({ goto: 'worker_x' })`。
- 多 agent 图的整体状态（当前节点、各节点消息线程、共享黑板、pending command）**统一进 `AgentRunState`**，从而由 Step 5 的 snapshot/restore 直接获得 checkpoint/resume。
- 复用既有单 agent loop 作为"节点执行器"，**不重写** loop 内部逻辑；复用既有三级 error-handler 降级。
- 单 agent 的 `sendMessage` 成为「1 节点图（entry=END）」的特例，**向后兼容**。

### 1.2 边界（明确不做）
- **不替换** `SwarmService` / `WorkflowExecutionService` / `AgentScheduler`：三者是面向用户/特定拓扑的独立服务。本设计是 **OS 层原语**，未来可作为它们的统一底层（见 §7），v1 不做迁移。
- **不引入**真正的 LangGraph 运行时 / 编译期图。只实现「节点 + Command(goto)」的最小动态路由。
- v1 **不做**带 predicate 函数的条件边（`edge(from, to, conditionFn)`）；只做 `Command(goto)` 动态边 + 可选的静态 `END` 边。
- 不做人类介入（`interrupt`/`AskUser`）——那是 WorkflowService 已有能力，本设计交还上层或后续独立项。

## 2. 现状痛点（已核实）

- loop 是单 agent（`agentOSService.ts` `_executeWithFallbackDirectly`）：一个 `agentId` 一跑到底，终止点见 L2169（无工具调用收尾）、L2358（全服务端执行）、L2596（terminate）、L2584（invalid tool 熔断）。
- 没有任何"把控制交给另一个 agent"的机制。现有跨 agent 协作只有：
  - `SwarmService`：静态 DAG，worker 间靠 `[swarm:blackboard]` 追加式文本共享，拓扑在创建时固定 → **路由是静态的，不能由 LLM 在运行时决定下一步**。
  - `WorkflowExecutionService`：node graph + `sharedMemory`，但边/流转由**引擎按静态连接 + 节点类型**驱动，节点本身不能返回"跳到 X"。
- `AgentRunState`（reducer 地基）目前只有单线程 `messages` + 控制变量，**没有图/节点/跨节点共享态**。

## 3. 设计

### 3.1 图定义（纯数据）

```ts
// common/agentGraph.ts（新建，纯类型 + 纯函数，零运行时依赖）

export type AgentGraphNodeKind = 'supervisor' | 'worker' | 'io';

export interface AgentGraphNode {
  id: string;                       // 节点 id（goto 目标）
  agentId: string;                  // 绑定到 AgentStudio 中已配置的 agent
  kind: AgentGraphNodeKind;
  /** 进入该节点时注入的 system 追加指令（如 supervisor 的路由规则） */
  systemAppend?: string;
  /** 是否把上一节点的 handoff summary 作为首条 user 消息注入 */
  inheritHandoff?: boolean;         // 默认 true
  /** 该节点是否可在无 goto 时自然结束（worker 默认 true；supervisor 默认 false） */
  terminalAllowed?: boolean;
}

export interface AgentGraphEdge {
  from: string;
  to: string;                       // 静态兜底边（当节点无 goto 时遵循）
}

export interface AgentGraph {
  id: string;
  entryNodeId: string;
  nodes: Record<string, AgentGraphNode>;
  edges: AgentGraphEdge[];          // 静态兜底边集合
  /** 终态节点 id（到达即整图结束），默认 'END' 哨兵 */
  endNodeId?: string;
}
```

### 3.2 `AgentCommand`（节点返回的路由指令）

对齐 LangGraph `Command`：

```ts
export interface AgentCommand {
  /** 下一个节点 id（动态路由）。支持 fan-out 多目标。 */
  goto?: string | string[];
  /** 交接摘要：作为下一节点的首条 user 上下文（来自 transfer_to_agent.summary）。 */
  summary?: string;
  /** 写回共享黑板（跨节点 KV，等价于 WorkflowService.sharedMemory） */
  update?: Record<string, unknown>;
}
```

`goto: undefined` + `terminalAllowed` → 节点自然结束，沿静态边或 `END`。

### 3.3 节点如何"发出" `AgentCommand`（两种来源）

**来源 A（推荐，最低风险）：builtin 交接工具 `transfer_to_agent`**
- 新增一个 `kind: 'handoff'` 的内建工具，声明于 `builtinToolProvider`，按 `agentId` 可见（仅当其所属图有 ≥2 节点时启用）。
- 参数：`{ node_id: string; summary: string }`，`node_id` 必须是图内合法节点。
- loop 在工具分发阶段**拦截**该工具：不真正执行，而是把它当作"路由指令" → 生成 `AgentCommand({ goto: node_id, update: { lastHandoffSummary: summary } })`；该节点本轮立即以"已路由"收尾（等价现有 L2358 服务端执行收尾：发 `done` 语义但带上 command）。
- 复用现有工具循环与审批/guard 机制，零新协议。
- **实现（2026-07-14 落地）**：graph 经 `IAgentTurnRequest.agentGraph` 透传；`_getEnabledTools(agentId, agentGraph?)` 在 `agentGraph` 缺省或节点数 <2 时从工具列表过滤掉 `transfer_to_agent`（单 agent 模式不可见 → 零行为变更）；loop 在 `effectiveToolCalls` 确定后拦截该工具，调用纯函数 `buildHandoffCommand(args, graph)` 解析 `node_id`/`summary` 并校验目标合法性，合法则经 `applyCommandToState` 写 `sharedMemory`/`handoffSummary` 后 `return command`（节点立即收尾），非法/缺失则丢弃该 call 继续正常流程（避免孤立 tool_start 转圈）。

**来源 B（可选，supervisor 结构化输出）**：supervisor 节点可在 system 中被告知"以 `{"goto":"worker_x","summary":"..."}` 作为最终 JSON 输出"；loop 在"无工具调用收尾"分支（L2169/L2256）尝试解析最终文本为 `AgentCommand`。失败则按终止处理。v1 以来源 A 为主，来源 B 作为 supervisor 节点的补充。

> 设计取舍：优先工具化（来源 A），因为现有 loop 对"工具调用 → 收尾"路径已稳定、可单测、可审计；不污染"无工具调用=结束"主语义。

### 3.4 图状态并入 `AgentRunState`

在 `AgentRunState` 增加图子状态（`graph` 段），使整图可被 Step 5 序列化：

```ts
// 在 agentRunState.ts 的 AgentRunState 增加：
export interface AgentGraphRunState {
  /** 当前所在节点 id（单 agent 模式为 undefined） */
  currentNodeId?: string;
  /** 各节点已运行的消息线程（节点退出时落地，进入时加载），key=nodeId */
  nodeThreads: Record<string, AgentRunMessage[]>;
  /** 跨节点共享黑板（等价 WorkflowService.sharedMemory） */
  sharedMemory: Record<string, unknown>;
  /** 最近一次 handoff summary（进入下一节点的首条上下文） */
  handoffSummary?: string;
  /** 节点执行状态（供 UI / resume 读取） */
  nodeStatus: Record<string, 'pending' | 'running' | 'done' | 'error'>;
}

// AgentRunState 增加字段：
graph?: AgentGraphRunState;
```

单 agent 模式 `graph` 为 `undefined`，loop 行为完全不变（向后兼容）。

新增对应 action（纯函数，进 `reduceRunState`）：
`ENTER_NODE` · `EXIT_NODE` · `SET_NODE_STATUS` · `WRITE_SHARED_MEMORY` · `SET_HANDOFF`.

### 3.5 图解释器（graph interpreter）

新增 `runAgentGraph(graph, request)`（在 `agentOSService.ts`，包在现有单 agent 路径外）：
```
current = graph.entryNodeId
while (current !== END) {
  node = graph.nodes[current]
  // 进入：把 sharedMemory + handoffSummary 注入该节点上下文；加载/新建 nodeThreads[current]
  runState = reduceRunState(runState, { type: 'ENTER_NODE', nodeId: current })
  // 节点执行 = 既有单 agent loop，但：
  //   - agentId = node.agentId
  //   - systemAppend 注入
  //   - transfer_to_agent 被拦截为 AgentCommand
  const command = yield* this._executeWithFallbackDirectly(nodeRequest)  // 返回 { command? }
  // 退出：落地 nodeThreads[current]
  runState = reduceRunState(runState, { type: 'EXIT_NODE', nodeId: current, messages: currentThread })
  if (command?.update) runState = reduceRunState(runState, { type: 'WRITE_SHARED_MEMORY', patch: command.update })
  if (command?.goto) {
    current = resolveGoto(command.goto, graph)   // 单目标或 fan-out 首目标；多目标用队列
  } else if (node.terminalAllowed) {
    current = graph.endNodeId ?? 'END'
  } else {
    current = staticEdgeTarget(graph, current) ?? 'END'  // supervisor 无 goto 走静态兜底
  }
}
```

- `_executeWithFallbackDirectly` 小改造：返回 `AgentCommand | undefined`（通过拦截 `transfer_to_agent` 与解析 supervisor 文本）。
- **节点 = 一次 loop 运行到自然停止点**（L2169 收尾 / L2358 服务端收尾 / L2596 terminate / transfer_to_agent 拦截）。这些既有终止点即"节点停止点"。
- pause/resume/checkpoint：节点边界天然是 iteration 边界，Step 5 的 snapshot 在 `EXIT_NODE`/`ENTER_NODE` 落盘 → 整图可 resume（这是 reducer 化的最大回报）。
- **实现（2026-07-14 落地）**：`agentGraph.ts` 新增纯函数 `computeNextNode(graph, node, command?)`（goto→`resolveGoto` 首目标；否则按 `terminalAllowed` 默认语义 worker=true/supervisor=false → END；否则 `staticEdgeTarget` 兜底 → END），可单测。`agentOSService.ts` 新增 `executeAgentGraph(request)` async generator：① `request.agentGraph` 缺或节点数<2 → 回退 `_executeWithFallbackDirectly({...request, agentGraph:undefined})`（零行为变更）；② 否则 `while current !== END` 循环：每节点 `reduceRunState(ENTER_NODE)` → 构造 `nodeRequest`（`agentId=node.agentId`、`agentGraph=graph`、`systemAppend` 注入、`inheritHandoff` 时上一节点 `handoffSummary` 作首条 user 消息、清空 `modelOverride`）→ 独立 turn 控制器 → `yield* _executeWithFallbackDirectly(nodeRequest)` 取 `command` → `EXIT_NODE` 落地线程 + `WRITE_SHARED_MEMORY`/`SET_HANDOFF` 写回 → `computeNextNode` 路由；节点异常 `SET_NODE_STATUS('error')` 并 `break`；内置 `MAX_GRAPH_STEPS=64` 防环；末 `yield {type:'done'}`。`executeAgentTurn` 顶部新增委派：当 `request.agentGraph` 含≥2 节点时自动 `yield* this.executeAgentGraph(request)`（单 agent 无 agentGraph → 完全不进入，零行为变更）；`executeAgentGraph` 内部直接调 `_executeWithFallbackDirectly`（非 `executeAgentTurn`）避免递归。`IAgentOSService` 接口新增 `executeAgentGraph`。

### 3.6 与 `StreamPhase` / UI 的关系

- 节点切换广播 `phase_change`：`idle`（切换/路由中）→ `llm_streaming`（节点内推理）；supervisor 决策期可复用 `idle` 或新增可选 `'routing'`（v1 不新增，避免改 UI 协议，留作可选）。
- UI 可消费 `runState.graph.nodeStatus` 渲染"当前节点 / 路由历史"；handoff 卡片可复用既有 `sub_agent_start/end` delta 风格（新增一种 `goto` delta 可选）。

### 3.7 与现有服务的边界（重要）

| 能力 | SwarmService | WorkflowExecutionService | **本设计（supervisor/goto）** |
|---|---|---|---|
| 拓扑 | 静态 DAG | 静态 node graph | **动态 LLM 路由** |
| 路由决策 | 创建时固定 | 引擎按节点类型 | **节点返回 `Command(goto)`** |
| 节点= | worker（sub-agent） | 任意 agent node | **既有 loop 一次运行** |
| 跨节点共享 | blackboard 文本 | sharedMemory Map | sharedMemory（同概念） |
| 人类介入 | 无 | AskUser/breakpoint | 无（交上层） |
| 状态可序列化 | 部分 | `IWorkflowExecutionState` | **整图进 `AgentRunState`（Step5）** |

**v1 关系**：supervisor/goto 作为 OS 层独立能力，由 `executeAgentGraph` 暴露；Swarm/Workflow 不改。§7 给出未来用其统一底层的演进路径。

## 4. `AgentCommand` 在 reducer 中的形态（可单测）

`AgentCommand` 本身不进 state；它经 `reduceRunState` 转化为 graph 状态变更（§3.4 action）。纯函数可测：
- `resolveGoto(command.goto, graph)` → 下一节点 id（含 fan-out 拆解）。
- `applyCommandToState(state, command)` → 返回新 state（写 sharedMemory / 置 handoffSummary）。
- 无需 live model / provider，对齐 `agentRunState.test.ts` 风格。

## 5. 实施步骤（每步可独立合入、可回滚）

- **A. 类型 + 纯函数 + 单测（零风险）**：新建 `common/agentGraph.ts`（`AgentGraph`/`AgentGraphNode`/`AgentCommand`/`resolveGoto`/`applyCommandToState`），`agentRunState.ts` 增加 graph 子状态与 `ENTER_NODE`/`EXIT_NODE`/`SET_NODE_STATUS`/`WRITE_SHARED_MEMORY`/`SET_HANDOFF` action + 单测。**不接 loop。**
- **B. 交接工具 `transfer_to_agent`（已落地 2026-07-14）**：`builtinToolProvider` 注册（仅多节点图启用）；loop 拦截生成 `AgentCommand`（来源 A）。`_executeWithFallbackDirectly` 返回 `command?`。
- **C. 图解释器 `runAgentGraph`（已落地 2026-07-14）**：`agentOSService.ts` 新增 `executeAgentGraph` 方法，复用 `_executeWithFallbackDirectly` 按节点执行 + goto 路由（`computeNextNode` 纯函数）；`IAgentOSService` 暴露 `executeAgentGraph`；`executeAgentTurn` 在检测到≥2节点 agentGraph 时自动委派。`END_NODE` 终态哨兵；`MAX_GRAPH_STEPS=64` 防环。
- **D. checkpoint/resume（已落地 2026-07-14）**：`agentRunState.ts` 新增 `snapshotRunState(state)`（带版本深拷贝）/ `restoreRunState(input)`（容错：接受快照 `{version,state}` 与裸 `AgentRunState` 两种形态，版本过高/损坏回退初始，字段缺省补全）+ `prepareResumeRunState(graph, restored)`（从 `restored.graph.currentNodeId` 续跑，非法/缺失回退 entry）；新增 `SET_CURRENT_NODE` action 更新续跑点。`IAgentTurnRequest` 增加 `resumeFrom?`（裸 AgentRunState）与 `checkpointSink?`（注入式落盘回调，agentOSService 保持存储无关）。`executeAgentGraph` 起点改用 `prepareResumeRunState`；ENTER_NODE 与路由后 `SET_CURRENT_NODE` 两处经 `checkpointSink` 落盘；节点子请求剥离 `checkpointSink`/`resumeFrom`；sink 缺省时零行为变更。driver 层后续可把 `checkpointSink` 接到 `IStorageService`（按 sessionId）实现真实持久化。
- **E. 观测/UI（可选）**：广播节点状态、handoff 卡片、当前节点高亮。

每步均可像 reducer 改造那样"只写 state、不改 UI 协议、零行为变更"地灰度推进。

## 6. 收益

- **动态多 agent 编排**：首个支持 LLM 运行时决定下一步去向的能力（supervisor 模式），补足 Swarm/Workflow 静态路由的空白。
- **整图可 checkpoint/resume**：reducer 化的直接回报——多 agent 图在节点边界可暂停/恢复/崩溃续跑。
- **复用最大化**：节点执行器 = 既有 loop，错误降级 = 既有三级；新增代码集中在"路由拦截 + 解释器"，风险面小。
- **可单测**：`resolveGoto` / `applyCommandToState` / graph action 全纯函数，无 live model。

## 7. 未来演进（非 v1，仅记录）

- Swarm/Workflow 可逐步重表达为 `AgentGraph`：Swarm 的 DAG 边 → 静态 `edges` + 末节点 `transfer_to_agent`；Workflow 的 node graph → 节点 + 静态边。统一后三者共享同一 snapshot/resume 与错误降级。
- 条件边（`edge(from,to,conditionFn)`）：在 `resolveGoto` 增加 predicate 分支即可，不影响节点执行器。
- `interrupt`/`AskUser`：作为图节点的一种 `kind: 'io'`，在节点 begin 注入暂停点，复用 WorkflowService 的 pause/resume 协议。

## 8. 不做的事（明确边界）

- 不引入真正的 LangGraph 运行时 / 图引擎。
- v1 不替换 Swarm/Workflow/Scheduler。
- v1 不做带 predicate 的条件边、不做人类介入。
- 不重写单 agent loop 内部逻辑；loop 仅做"返回 command"与"拦截交接工具"两处最小改造。
