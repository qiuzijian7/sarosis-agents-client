# 动态工作流（Dynamic Workflow）兼容设计

> 对标：`G:\CustomWorkspaces\AIProjects\deepseek-harness` 的 dynamic-workflows 子系统（对齐 Claude Code dynamic-workflows 范式）。
> 目标：让本项目的 Agent 具备「模型写 JS 编排脚本 → 脚本内扇出子代理 → 结构化结果回传」的能力，并与现有 LiteGraph 画布工作流、快照总线、子代理调度体系统一串联。
> 日期：2026-08-18

---

## 1. deepseek-harness 的工作流机制解析

### 1.1 范式定位

deepseek-harness（下称 dsh）的工作流是**动态脚本编排**：模型自己写一段 JavaScript，脚本里用 `agent()` 扇出子代理、用 `parallel()`/`pipeline()` 控制并发与流水线，最后 `return` 一个 JSON 值。**不是**可视化节点图（LiteGraph/ComfyUI 那类）。

```
模型 → workflow 工具调用 { meta, script, args }
     → 引擎在隔离环境执行脚本
     → 脚本调 agent(prompt, {schema}) → 宿主起子代理 → 结果回填脚本
     → 脚本 return JSON → 工具结果返回模型
```

### 1.2 四层架构（严格三层 seam + UI）

| 包 | 角色 | 职责 |
|---|---|---|
| `workflow/workflow` | **Service Definition** | `WorkflowRunId`/`WorkflowMeta`/`WorkflowResult` 类型 + `WorkflowError` + 6 个生命周期事件（`workflow/start|phase|log|agent-start|agent-end|end`）。只有类型与 id-brand 工厂，零运行时 |
| `workflow/workflow-worker-thread` | **Provider** | 每 run 起一个 Node worker 线程：`host.ts`（WorkerRun：spawn/child 注册表/grace/静默等待）+ `runtime.ts`（vm realm + hooks）+ `protocol.ts`（typed 消息协议）+ `realm.ts`（结果物化边界） |
| `workflow/tool-workflow` | **Consumer** | 模型工具 `workflow(script, meta, args)`；前台 `await run.result`；事件 recorder 投影回会话流 |
| `client/ui-workflow-run` | UI | 运行面板（React） |

Provider 可替换（未来换 sandbox/进程引擎），模型接口不变。

### 1.3 脚本模型（hook 契约，模型可见 spec）

脚本在 `node:vm` 里执行，注入的**全部**全局：

| hook | 语义 |
|---|---|
| `agent(prompt, opts?)` | 起一个子代理跑到完成。无 `schema` → 返回最终文本；有 `schema`（受限 JSON Schema 子集：type/properties/required/additionalProperties/items/enum/const/oneOf）→ 返回校验后的对象。**子代理自身失败 → `null`**（脚本 `.filter(Boolean)`）；opts 仅支持 `label/phase/schema/provider/model`，其余（effort/isolation/agentType）显式报错 |
| `pipeline(items, ...stages)` | 每 item 独立串行过所有 stage（`stage(prev, item, index)`），**无跨 stage barrier**（item A 在 stage 3 时 item B 可在 stage 1）。普通 stage 抛错 → 该 item 置 `null` 并跳过其后续 stage |
| `parallel(thunks)` | 并发跑零参函数并全部等待（barrier 语义）。抛错的 thunk → `null` |
| `phase(title)` / `log(msg)` | 进度叙事（纯观察，不施加执行结构） |
| `args` | 工具调用的 args 参数原样（structured clone 隔离，脚本改不动调用方数据） |

**没有** fs/network/timer/Node API——"agents do the work, the script only coordinates them"。

### 1.4 host↔worker 协议（`protocol.ts`）

闭合的 typed 消息枚举（payload map 单一真源，接收方 `assertNever`）：

- **worker → host**：`ready`（握手）→ `go`；`phase`/`log`（叙事）；`agent-start`/`agent-end`（配对账本）；`child-start`（RPC：`{callId, request}`）/`child-dispose`；`result`（终态唯一）
- **host → worker**：`go`/`cancel{reason}`；child RPC 回执 `child-started{childId}`/`child-start-error{rendered}`/`child-settled{result}`/`child-failed{rendered}`/`child-disposed`

`ChildStartRequest = {prompt, schema?, provider?, model?}`；`ChildResult = {output, structured?, stopReason}`。全部 plain JSON（structured clone 过线）。

host 收到 `child-start` 后调 `SubagentRuntime.start(provider, {prompt, parent, signal, outputSchema, agentOptions})` —— **workflow 引擎不自己实现子代理，只做桥**。

### 1.5 失败语义分级（最有价值的部分）

`WorkflowError` 带 `fatal` 标志，两类失败严格分开：

| 类别 | 例子 | 后果 |
|---|---|---|
| **Fatal**（引擎/契约错误） | `SCRIPT_PARSE`、`INVALID_ARGUMENT`、`UNSUPPORTED_OPTION`、`UNSUPPORTED_SCHEMA`、`AGENT_CAP`、`ITEM_CAP`、`AGENT_START`、`AGENT_RESULT`、`CANCELLED`、`RESULT_UNSERIALIZABLE` | 穿透 `parallel()`/`pipeline()` **杀死整个脚本**；worker 侧用 `instanceof` 判 fatal（realm 外构造，脚本无法伪造也无法误吞） |
| **普通失败**（子代理自身失败） | 子代理超时/产出不合格 | 该 item → `null`，脚本继续 |

### 1.6 生命周期与健壮性

- **`result` 永不 reject**：所有失败映射为 `{value, stopReason: 'completed'|'cancelled'|'error', error?, agentsStarted}`。
- **取消**：`cancel()` → worker 侧所有 hook 入口抛 `CANCELLED`（下一个 hook 边界死）+ 等待 slot 的 waiter 全部 reject + host abort 所有 child 共享的 AbortController；grace timer（默认 5s）到点 force-settle `cancelled` + `worker.terminate()`。
- **静默等待（quiescence）**：dispose 等 pending starts + 已发布 children 全部收敛（上限 grace），child dispose memoized（worker RPC / host 驱动 / reap 三方合流只跑一次）。
- **agent-start/agent-end 恰好配对**：host 持账本，worker 死亡/grace 强收时合成缺失的 `agent-end{outcome:'cancelled'}`。
- **dropped promise 防护**：`contain()` 给每个 hook promise 挂 no-op catch，脚本丢弃 promise 不会变成 unhandled rejection 杀线程。
- **caps**：`maxConcurrentAgents`（FIFO slot）、`maxTotalAgents`（默认 1000，runaway 兜底）、`maxItemsPerCall`（默认 4096）、`syncTimeoutMs`（vm 首个同步切片超时）。
- **结果边界**：`materializeFromRealm` 只放行 plain JSON（拒函数/symbol/循环/稀疏数组/非有限数），违规 → `RESULT_UNSERIALIZABLE` fatal。
- **竞态处理**：worker death 是逻辑投递屏障（error 后到达的消息不再受理）；Result 与 cancel 竞速有明确胜负规则（cancel 先到 → 汇报 cancelled）。

### 1.7 dsh 自陈的限制

仅前台收集（父 turn 阻塞）；无 journaling/resume；脚本无嵌套 workflow；无 token 预算；每 run 一个 worker 线程；run 是 holder-owned。

---

## 2. 与本项目的对比

### 2.1 能力矩阵

| 维度 | deepseek-harness | 本项目（现状） |
|---|---|---|
| 工作流范式 | 动态脚本编排（模型写 JS） | **静态节点图**（LiteGraph 画布 + 声明式 NodeSpec）+ DAG 任务编排（TaskOrchestrationService） |
| 脚本执行环境 | Node worker_threads + `node:vm` | 无。`execute_code` 是主进程 spawn 的 shell 单发沙箱（30s 默认超时），不是编排环境 |
| 子代理 seam | `SubagentRuntime.start`（provider 化） | `UnifiedSubAgentDispatch`（explore/general/scout 权限档 + Effect-TS fiber + IterationBudget + completionGate + stallWatchdog + 卡片事件流） |
| 并发原语 | `parallel`/`pipeline`（脚本内） | `forEachPar`（dispatch 内部）、`dispatchParallelExplore`、`delegate_task` 的 batch 参数、主循环 `splitDelegateParallelBatch` |
| 结构化输出 | `agent(prompt, {schema})` → 校验对象 | `StructuredOutputParser` + `completionGate.gateResult`（验收门），未暴露给编排层做 IO |
| 节点间数据传递 | JS 值流动（脚本变量） | **快照总线**（MediaSnapshotStore，IndexedDB，按 `stageUid` 归档）+ `resolveBinding` 上游解析 + 波次分层执行计划（层间 barrier） |
| 进度可观测 | 6 事件 + session recorder | `IChatStreamDelta`（tool_start/tool_end）+ `SubAgentEventSink` → subagent 卡片 reducer（含并行 batchGroup 卡片组）+ `ExecutionTimelinePanel` |
| 失败语义 | fatal vs per-item null 分级 | delegate_task 整体成败 + 完成门降级；无编排级组合子语义 |
| 取消 | cancel + grace + terminate | fiber `InterruptSignal` + watchdog；无脚本级取消边界 |
| 画布编排节点 | 无画布 | `Saros.Start/End/Task/Prompt/Agent/Skill/Tool/Subflow/IfElse/Switch/AskUser` **仅为静态 spec，执行时被 `isExecutableSpec` 跳过** |

### 2.2 架构差异（决定移植方式的三个硬约束）

1. **进程/环境模型**：dsh 是 Node 进程（worker_threads + node:vm 随手可用）。本项目 agent loop（`agentOSService`/`UnifiedSubAgentDispatch`）在 **workbench renderer**（沙箱、无 Node API）→ **不能**用 worker_threads/node:vm。但 renderer 有成熟 blob worker 基建：`browser/shared/workerPoolManager.ts` 的 `createBlobWorker`（已处理 Electron CSP `TrustedScriptURL` + CSP 拦截时降级主线程），`codebaseGraphService`/`kbWorkerManager` 都在用。
2. **子代理生态在 renderer**：dispatch 的预算/fiber/卡片事件流全在 renderer。若把引擎放主进程，`child-start` RPC 需双跳转发（引擎→主→renderer→dispatch），且卡片事件流断链。**引擎必须与 dispatch 同进程（renderer）**。
3. **本项目已有两条"节点图"链路**要统一而不是替代：媒体 DAG（webview 的 `workflowRun.ts`）与任务 DAG（browser 的 `taskOrchestrationService._executePlan` → `AgentFactory.wireConnections` → `CanvasLayoutEngine.autoArrangeCanvas`）。动态工作流是**第三条**，三者应共用「子代理原语 + 快照总线」底座。

### 2.3 可直接复用的资产

| 资产 | 位置 | 复用方式 |
|---|---|---|
| `createBlobWorker` | `browser/shared/workerPoolManager.ts` | worker 引擎的执行环境 |
| `UnifiedSubAgentDispatch` | `common/unifiedSubAgentDispatch.ts` | 新增轻量 child 入口；复用 fiber/预算/权限档/卡片事件 |
| `toolsetConfig` | `common/toolsetConfig.ts` | `workflow` toolset 已存在（`workflow_` 前缀，High），工具名 `workflow` 加入 exactNames |
| `delegationLedger` + 卡片 reducer | `common/` | workflow run/agent 事件投影 |
| 快照总线 | webview `comfyHost/mediaSnapshotStore` + `stageIdentity` | 动态工作流结果归档/画布 OUTPUT 展示（跨界经 RPC） |
| `StructuredOutputParser`/`completionGate` | `browser/` | 子代理 schema 输出的校验/验收 |
| `toolExecutionGuard` | `browser/` | workflow 工具的超时档（对齐 `DELEGATION_TOOL_TIMEOUT_MS` 思路） |

### 2.4 缺口清单

- 无脚本编排环境（worker + realm + hooks）
- 无 typed host↔worker 协议
- 无 fatal/per-item-null 失败分级
- 无 run 生命周期（cancel/grace/quiescence）
- `agent()` 式「单子代理 + schema 输出」的轻量入口不存在（delegate_task 面向卡片流，重）
- 画布 `Saros.*` 编排节点无执行语义
- 动态工作流与画布之间无数据桥

---

## 3. 兼容动态工作流的修改设计

### 3.1 总体架构

```
┌─ Chat (LLM) ─────────────────────────────────────────────────────┐
│  工具: workflow { meta, script, args }                            │
└──────────────┬────────────────────────────────────────────────────┘
               │ execute (browser/providers/tool/workflowTool.ts)
               ▼
┌─ renderer (workbench browser 层) ─────────────────────────────────┐
│  WorkflowEngine (browser/workflow/workflowEngine.ts)   ← host 侧  │
│   ├─ spawn blob worker（createBlobWorker，CSP 安全）              │
│   ├─ child 桥: dispatch.startWorkflowChild(req)                   │
│   │    └→ UnifiedSubAgentDispatch（fiber/预算/权限/卡片事件流）    │
│   ├─ cancel/grace/quiescence/事件扇出（onWorkflowEvent）          │
│   └─ 结果归档桥: 快照总线（SAROS_JSON snapshot，按 stageUid）      │
│        ↕ postMessage（protocol.ts 闭合 typed 协议）               │
│  WorkflowWorker (browser/workflow/workflowWorkerMain.ts 内联源码) │
│   ├─ hooks realm: agent/parallel/pipeline/phase/log/args          │
│   ├─ 并发 slot + caps + 取消边界 + contain()                      │
│   └─ materializeFromRealm（plain-JSON 结果边界）                   │
└───────────────────────────────────────────────────────────────────┘
```

**关键决策与理由**：

| 决策 | 选择 | 理由 |
|---|---|---|
| 引擎位置 | renderer（与 dispatch 同进程） | child 桥零 IPC；卡片事件流不断链；blob worker 已有 CSP 处理先例 |
| 脚本隔离 | **blob Web Worker**（非 node:vm/worker_threads） | renderer 无 Node；worker.terminate() 防死循环足矣。隔离目标与 dsh 声明一致：**可终止 + 结果边界，不是安全边界** |
| worker 源码形态 | worker 代码作为**字符串常量**内联在 `workflowWorkerMain.source.ts`，`createBlobWorker(code)` 动态创建 | 规避「URL worker 必须在 buildfile 注册」打包铁律；无需独立产物文件 |
| 子代理 seam | 不新建引擎私有池，`UnifiedSubAgentDispatch` 增加一个入口 | 预算/权限/watchdog/卡片复用；与 delegate_task/plan_explore 行为一致 |

### 3.2 模块设计

#### 3.2.1 `common/workflow/types.ts` —— Service Definition（对齐 dsh `workflow/types.ts`）

```ts
export type WorkflowRunId = string;                    // crypto.randomUUID()
export interface IWorkflowPhase { title: string; detail?: string; }
export interface IWorkflowMeta {
    name: string;                                      // kebab-case，必填
    description: string;                               // 必填
    whenToUse?: string;
    phases?: IWorkflowPhase[];
}
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error';
export interface IWorkflowResult {
    value: unknown;                                    // 物化后的 plain JSON
    stopReason: WorkflowStopReason;
    error?: string;
    agentsStarted: number;
}
export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled';
export interface IWorkflowAgentInfo { seq: number; label: string; phase?: string; childId: string; }
export interface IWorkflowAgentEndInfo extends IWorkflowAgentInfo { outcome: WorkflowAgentOutcome; }

/** fatal 编排错误：穿透组合子，杀死脚本（对齐 dsh WorkflowError） */
export class WorkflowError extends Error {
    constructor(message: string, readonly code: WorkflowErrorCode, readonly fatal = true) { super(message); }
}
export type WorkflowErrorCode =
    | 'SCRIPT_PARSE' | 'INVALID_ARGUMENT' | 'UNSUPPORTED_OPTION' | 'UNSUPPORTED_SCHEMA'
    | 'AGENT_CAP' | 'ITEM_CAP' | 'AGENT_START' | 'AGENT_RESULT'
    | 'CANCELLED' | 'RESULT_UNSERIALIZABLE';
export function isFatalWorkflowError(e: unknown): boolean { return e instanceof WorkflowError && e.fatal; }

/** 引擎 caps（宿主持有 provider/grace，worker 持有以下四项，经 workerData 传入） */
export interface IWorkflowLimits {
    maxConcurrentAgents: number;   // 默认对齐 dispatch DEFAULT_MAX_CONCURRENCY
    maxTotalAgents: number;        // 默认 1000
    maxItemsPerCall: number;       // 默认 4096
    syncTimeoutMs: number;         // 默认 5000（首个同步切片）
}

/** 引擎事件（引擎唯一输出面；UI/recorder/画布都订阅它） */
export interface IWorkflowRunHandle {
    readonly id: WorkflowRunId;
    readonly meta: IWorkflowMeta;
    readonly result: Promise<IWorkflowResult>;          // 永不 reject
    cancel(reason?: string): void;
    dispose(): Promise<void>;                          // 有界（grace 内收敛）
}
export type WorkflowEngineEvent =
    | { type: 'start'; id: WorkflowRunId; meta: IWorkflowMeta }
    | { type: 'phase'; id: WorkflowRunId; title: string }
    | { type: 'log'; id: WorkflowRunId; message: string }
    | { type: 'agent-start'; id: WorkflowRunId; info: IWorkflowAgentInfo }
    | { type: 'agent-end'; id: WorkflowRunId; info: IWorkflowAgentEndInfo }
    | { type: 'end'; id: WorkflowRunId; stopReason: WorkflowStopReason; error?: string; agentsStarted: number };
```

#### 3.2.2 `common/workflow/protocol.ts` —— 闭合 typed 协议

照搬 dsh `protocol.ts` 的结构（payload map 单一真源 + 判别联合 + `assertNever`），消息集完全同构：

- worker→host：`ready / phase / log / agent-start / agent-end / child-start{callId,request} / child-dispose{callId} / result`
- host→worker：`go / cancel{reason} / child-started{callId,childId} / child-start-error{callId,rendered} / child-settled{callId,result} / child-failed{callId,rendered} / child-disposed{callId}`

差异仅一处：`ChildStartRequest.provider/model` 在本项目映射为 `{ agentId?: string; model?: string }`（agentId 选中内置/自定义 Agent 身份，model 覆写模型选择，二者可独立传）。

#### 3.2.3 `browser/workflow/workflowWorkerMain.source.ts` —— worker 侧（realm + hooks）

worker 源码以字符串常量交付，`createBlobWorker(SOURCE)` 启动。内部结构对齐 dsh `runtime.ts`：

1. **环境遮蔽**（worker 第一行执行）：`self.fetch/XMLHttpRequest/importScripts/WebSocket/Worker = undefined` —— 比 dsh 的 vm 弱，但目标一致（防误用而非防恶意）；注释明示「不是安全边界」。
2. **hook 表**：`agent/parallel/pipeline/phase/log/args`，语义逐条对齐 §1.3（含 `SUPPORTED_AGENT_OPTIONS = {label, phase, schema, agentId, model}` 与显式拒绝列表）。
3. **并发 slot**：FIFO `acquireSlot/releaseSlot`，cancel 时 reject 全部 waiter。
4. **取消边界**：所有 hook 入口 `throwIfCancelled()`；`cancel()` 后下一个 hook 边界死。
5. **contain()**：hook promise 挂 no-op catch，防 unhandled rejection 杀 worker。
6. **materializeFromRealm**：plain-JSON 物化（拒函数/symbol/循环/稀疏/非有限数）——从 dsh `realm.ts` 移植算法（纯函数，无 Node 依赖，可直接搬）。
7. **同步切片超时**：无 node:vm 的 `timeout` 选项，改为**启动前静态扫描**（`new Function` 编译即语法检查）+ **运行期心跳看门狗**：脚本经 `Promise.resolve(thenable)` 包装，但纯同步死循环（`while(true){}`）会卡死 worker 线程——由 **host 侧 grace/terminate 兜底**（turn 超时或用户取消 → `worker.terminate()`）。这是与 dsh 的已知差异，写入工具 description 约束模型（"avoid unbounded sync loops"）并由 cancel 兜底。

#### 3.2.4 `browser/workflow/workflowEngine.ts` —— host 侧引擎

对齐 dsh `host.ts` 的 `WorkerRun`，适配 blob worker：

- `start({script, meta, args, limits, context}): IWorkflowRunHandle`：
  - meta 校验（name/description 必填、kebab-case；违规同步抛 → 工具结果 isError，模型可纠正）
  - `createBlobWorker(SOURCE, { workerData: {meta, body, args, limits} })`（workerData 经 structured clone，天然完成 args 隔离拷贝）
  - `ready → go` 握手；消息分派按 protocol；death（error/exit）为逻辑投递屏障
- **child 桥**：`child-start` → `dispatch.startWorkflowChild(request, context)` → 得 `{id, result, dispose}` → `child-started`；result settle → `child-settled`（先 `JSON 物化检查`，失败 → `child-failed`）；worker `child-dispose` → dispose → ack
- **账本**：`liveAgents(seq→info)`；death/grace 时合成缺失 `agent-end{cancelled}`
- **cancel/grace**：`cancel(reason)` → post `cancel` + abort children（child 桥向 dispatch 发 interrupt）+ grace timer（默认 5s）force-settle + `worker.terminate()`
- **quiescence**：等 pending starts + children 收敛（上限 grace），dispose 幂等 memoized
- **事件扇出**：`onWorkflowEvent: Event<WorkflowEngineEvent>`，工具层/recorder/画布桥各自订阅

#### 3.2.5 子代理桥 —— `UnifiedSubAgentDispatch.startWorkflowChild`

新增最小入口（不动既有 delegate_task 路径）：

```ts
export interface IWorkflowChildRequest {
    prompt: string;
    schema?: JsonObjectSchema;      // 受限子集（对齐 dsh assertObjectJsonSchema 的检查集）
    agentId?: string;               // 内置/自定义 Agent 身份（缺省 general 档）
    model?: string;                 // 模型覆写
    phase?: string; label?: string; // 归档与展示
}
export interface IWorkflowChildHandle {
    id: string;
    result: Promise<{ output: string; structured?: unknown; stopReason: string }>;  // 失败 resolve 非 completed，只有基建故障 reject
    dispose(): Promise<void>;
}
startWorkflowChild(req: IWorkflowChildRequest, ctx: { parentAgentId: string; batchGroupId?: string; signal?: AbortSignal }): IWorkflowChildHandle
```

实现要点：
- 复用 `fork + timeout + InterruptSignal`（effectRuntime）；预算从 `IterationBudget` 取子代理档
- **schema 输出**：请求带 schema 时，子代理最后一步注入「输出 JSON」指令（复用 `subAgentReturnFormat.injectReturnFormatIntoTask` 的机制换成 JSON schema 版），完成后 `StructuredOutputParser` 解析 → `structured`；解析失败 → `stopReason: 'failed'`（→ 脚本见 `null`，符合 §1.3 契约）
- **completionGate**：workflow child **不走完成门**（脚本是更可靠的消费者：schema + 重试由脚本自己决定），只保留 stallWatchdog
- **卡片事件流**：以 `batchGroupId`（复用并行卡片组）投 `SubAgentEvent`，UI 天然获得并行子代理卡片

#### 3.2.6 `browser/providers/tool/workflowTool.ts` —— Consumer（模型接口）

对齐 dsh `tool-workflow` 的 DESCRIPTION 契约（含 hook 语义、schema 子集、fatal 语义、"NO export const meta"、前台执行声明），参数：

```ts
{ script: string /* JS body，顶层 await，return JSON */,
  meta: { name, description, whenToUse?, phases? },
  args?: object }
```

execute 流程：引擎 `start()` → 订阅事件投 stream record（tool 卡片 + 子代理卡片联动）→ `await handle.result` → 非 completed 抛 `NonRetryableToolError`（模型可修脚本重试）→ completed 返回 `{runId, agentsStarted, result}`（渲染截断上限 50k 字符，对齐 dsh）→ `finally handle.dispose()`。turn 取消信号桥接 `handle.cancel('parent turn aborted')`。

注册：
- `toolsetConfig.ts` 的 `workflow` toolset 增加 `exactNames: ['workflow']`
- 系统提示 section（对齐 dsh 策略）：「仅当用户明确要求 workflow / 大规模多代理编排时使用；一两次委派仍走 delegate_task」
- `toolGuardrailController` / `toolExecutionGuard`：归入 delegation 超时档（长超时，非 30s 默认）

---

### 3.3 节点串联与输入输出（核心章节）

「节点正常串联、正常输入输出」在三个层面成立：

#### 3.3.1 第一层：脚本内串联（动态工作流本体）

**契约**：节点 = 一次 `agent()` 调用；边 = JS 值流动。串联正确性由三件事保证：

1. **值语义明确**：`agent()` 无 schema → `string`（最终文本）；有 schema → 校验过的对象。**永不 undefined**（失败 = `null`），下游可安全 `?? 默认值` / `.filter(Boolean)`。
2. **pipeline 无 barrier 串联**：`stage(prev, item, index)` 拿到上游物化值；上游 item 失败（null）时业务上由脚本决定传播策略（推荐 pattern 写进工具 description：stage 首行 `if (prev === null) return null` 短路，保持数组索引对齐）。
3. **结构化输出链**：上游 agent 的 schema 即下游的类型契约。工具 description 中给出 canonical 范式：

```js
phase('研究')
const topics = await pipeline(args.files,                       // item
  (prev, file) => agent(`分析 ${file}`, { schema: FINDINGS }),  // stage 1: 每文件一组发现
  (prev) => prev === null ? null : agent(`汇总 ${prev.title}`, { schema: SUMMARY }))  // stage 2
phase('写作')
const report = await agent(`写报告：${JSON.stringify(topics.filter(Boolean))}`)
return { report, filesAnalyzed: topics.filter(Boolean).length }
```

#### 3.3.2 第二层：动态工作流 ↔ 画布快照总线（跨界数据桥）

让一次 workflow run 的输入可来自画布节点、输出可回流画布 OUTPUT 卡片，**复用现有 stageUid 归档键体系**（绝不引入第三套键）：

1. **输入侧（画布 → 脚本）**：新增可选 hook `nodeOutput(stageUid, slot?): Promise<unknown>`
   - worker 把请求经 `node-output{callId, stageUid, slot}` RPC 发 host → host 桥到快照总线查询（webview 侧 store 经现有 RPC 通道查询，browser 侧需一个 `IMediaSnapshotQueryService` 薄代理，见 3.3.4）
   - 返回物化值：`SAROS_JSON` 快照 → 原始 JSON；`TEXT` → string；IMAGE/VIDEO → `{kind:'media', url, mime}`（脚本把它 JSON.stringify 进 prompt 或传给下游 agent）
   - 查无此 uid → fatal `INVALID_ARGUMENT`（fail-loud，杜绝静默 undefined 串坏链路——与本项目「归档键全链路一致」的既有教训对齐）
2. **输出侧（脚本 → 画布）**：run 完成后，引擎把 `result.value` 包装为 `{kind:'SAROS_JSON', value}` 写入快照总线，归档键 = 发起 run 的锚点节点 stageUid（chat 侧发起则只进会话流不进画布）。卡片 OUTPUT 区即可显示运行结果 JSON（NodeCard 现有 OUTPUT 通道，SAROS_JSON 类型渲染为折叠 JSON 卡）
3. **别名一致性**：归档继续走 `registerAlias(nodeId, stageUid)` 双前缀合并（run 用 uid、弹窗 savePayload 用 nodeId 的既有两路写入习惯不变）

#### 3.3.3 第三层：画布 `Saros.*` 编排节点获得执行语义（统一底座）

现状：编排节点在 `buildExecutionPlan` 被 `isExecutableSpec` 跳过。设计（二期）：给它们接上与动态工作流**同一套 child 桥**：

| 节点 | 执行语义 |
|---|---|
| `Saros.Agent` | 一次 `startWorkflowChild`：prompt 来自节点 widget 或上游 TEXT 端口；`agentId` 来自节点 spec；输出端口产出 `SAROS_JSON`（schema 由节点配置或默认 summary）快照 |
| `Saros.Task` | 展开为子图：任务描述 → 分解（复用 `TaskDecomposer`）→ 顺序/并行子 Agent |
| `Saros.Prompt` | 纯文本物化节点：把 widget 文本（含 `@node` 引用，经 `nodeMentions` 解析为 `nodeOutput`）物化为 TEXT 快照 |
| `Saros.IfElse` / `Saros.Switch` | 门节点：读上游 SAROS_JSON 的判定字段选择放行边（不产生新值，只裁剪后续波次） |
| `Saros.Subflow` | 已有 flatten 机制保持不变 |
| `Saros.AskUser` | 转 `clarify` 工具的画布版（等待用户输入物化为 TEXT） |

**执行计划融合**：`buildParallelExecutionPlan` 的波次分层不变（层间 barrier 保证「上游快照可得才跑下游」的既有不变量），编排节点作为可执行 step 加入 plan；媒体节点走 ComfyUI executor，编排节点走 child 桥 —— 二者在同一波次内可混排。**串联正确性的根基就是这条既有不变量 + stageUid 快照键 + resolveBinding 上游解析，全部复用、零新概念。**

#### 3.3.4 端口 IO 契约与类型检查

统一端口值模型（三种 kind），跨三层（脚本/画布/快照总线）同一表示：

```ts
type PortValue =
    | { kind: 'text'; value: string }
    | { kind: 'json'; value: unknown }
    | { kind: 'media'; url: string; mime: string; stageUid?: string };
```

- **画布静态检查**（编辑期，`workflowEditor` 增强）：连线时按 `PortSpec.type` 已有的类型 chip 做亲和校验（SAROS_JSON↔json、TEXT↔text、IMAGE/VIDEO↔media；`ANY` 通配）——现有 spec 体系直接支持
- **运行期 fail-loud**：执行器消费上游快照时，kind 与端口期望不符 → 该节点 error（ErrorBanner 现有通道），不静默降级
- **缺失上游**：上游未运行/无快照 → 明确报「上游节点 X 尚无输出」（对齐现有「请先在节点弹窗中绘制」的报错习惯），绝不传 undefined

---

### 3.4 失败 / 取消 / caps（逐条对齐 dsh）

| 机制 | 设计 |
|---|---|
| fatal vs per-item null | `WorkflowError` + `isFatalWorkflowError`；worker 侧组合子（parallel/pipeline）捕获后判定；基建故障（child reject、引擎错误）fatal，子代理自身失败 null |
| result 永不 reject | handle.result 全路径映射 stopReason |
| cancel | turn abort → `handle.cancel()` → worker hooks 抛 CANCELLED + slot waiter reject + children interrupt + grace 5s force-settle + terminate |
| 恰好配对 | host `liveAgents` 账本 + 死亡路径合成 agent-end |
| caps | `maxConcurrentAgents`（默认= dispatch 并发）、`maxTotalAgents=1000`、`maxItemsPerCall=4096`；设置键 `sessions.agentStudio.workflow.*` 可覆写 |
| 模型纠错回路 | meta 校验/语法错同步抛 → isError 工具结果 → 模型改脚本重调（dsh 同款） |

### 3.5 可观测与 UI

- **chat 侧**：workflow 工具卡片（展开显示 script + phase/ log 行）；每个 `agent()` 复用 subagent 卡片（batchGroup 并行组）；`agent-end` 打出 outcome 徽标
- **记录**：`delegationLedger` 增记 workflow run 与其 children 的从属关系（父=发起 turn，子=childId）
- **画布侧（二期）**：`ExecutionTimelinePanel` 增 workflow run 维度（phase 分组 → agent 行）
- 全部消费 `WorkflowEngineEvent` 单一事件面，UI 与 recorder 解耦（对齐 dsh recorder 模式）

### 3.6 安全边界（如实声明，与 dsh 口径一致）

- worker 隔离目标：**可终止（terminate）+ 结果物化边界 + 防误用遮蔽**，**不是**安全边界；模型代码理论可逃逸（无 vm）。风险与 dsh 相当（其 vm 亦自陈可逃逸），且子代理权限仍受 dispatch 权限档约束（explore 只读等）——**能力面没有扩大**：脚本自己无任何工具，一切副作用都经有权限档的子代理发生
- worker 无 fs/network/timer（遮蔽 + 未注入任何宿主对象）；`args` structured clone 隔离

### 3.7 分期落地

> **完整落地方案（workstream 拆解 + 89 条测试用例）见 `doc/Dynamic-Workflow-Implementation-Plan.md`** —— 本节仅保留里程碑概览。测试用例即契约：先冻结用例再实现（dsh 的测试目录结构可参考其用例设计）。

| 阶段 | 内容 | 验收要点 | feature flag |
|---|---|---|---|
| **M1 引擎 + 工具** | 类型协议 / worker 源码 / host 引擎 / dispatch 桥 / workflow 工具 / 聊天卡片（6 workstream） | Chat 闭环：fan-out+失败容忍+schema 回传；取消 5s 收敛；死循环 terminate；CSP 拦截 fail-loud | `workflow.enabled` |
| **M2 画布数据桥** | nodeOutput hook / 快照查询代理 / 结果 SAROS_JSON 归档 / 🔗 徽标 | 画布⇄chat 双向；stageUid 读写同源 | `workflow.canvasBridge` |
| **M3 编排节点执行** | Saros.Agent/Task/IfElse/Switch/AskUser 接入波次执行，与媒体节点混排 | 串联不变量在混排下成立；类型不符 fail-loud | `workflow.orchestrationNodes` |
| **M4 Canvas/Code 双模式** | M4a 画布→脚本导出 → M4b 运行时投影 → M4c 静态子集双向 sync（§5.3） | 导出脚本可直接执行；投影呈现动态扇出；round-trip 同构；越界降级 | `workflow.dualMode` |

---

## 4. 风险与开放问题

1. **纯同步死循环无法软杀**（无 vm timeout）：靠 host terminate 兜底，会丢脚本进度（dsh 同样丢）。缓解：工具 description 约束 + syncTimeoutMs 静态检查（`new Function` 编译 + 简单循环启发式告警）。
2. **worker 内无 `crypto.randomUUID`？** 浏览器 worker 有 `crypto.randomUUID`（Chromium ✓），保底降级实现（dsh 同款）。
3. **blob worker CSP 拦截**（kbWorkerManager 见过）：`createBlobWorker` 返回 null → 降级策略需决策：A) 拒绝启用 workflow 工具（提示用户）；B) 主线程受控执行（不可 terminate，仅靠 caps/超时）。建议 A（fail-loud），B 作为逃生门记录但不默认。
4. **子代理 schema 输出的可靠性**：本项目 completionGate 逻辑较重，workflow child 绕过它后，坏输出 → null → 脚本重试的成本（一轮完整子代理）。可配「每 child 一次免费重试」在桥内做（dsh 无此机制，属本项目增强，默认关闭）。
5. **与 `splitDelegateParallelBatch`/主循环并行策略的交互**：workflow 工具必须加入 `NEVER_PARALLEL_TOOLS`（它自己管理并发），避免与主循环并行执行器争抢。
6. **stageUid 快照查询的进程边界**：快照总线在 webview IndexedDB，browser 侧需经现有 webview RPC 代理查询（M2 落地前确认通道容量/延迟；大 JSON 走引用而非全量拷贝）。
7. **命名冲突**：`workflow` 工具名与 toolset 前缀 `workflow_*` 的既有工具（如有）无冲突（exactNames 精确匹配）。

---

## 5. 脚本与画布的关系：双模式（Canvas/Code）切换设计（M4）

### 5.1 两者的本质关系：同构但不对称

脚本与画布共享同一个执行底座（子代理原语 + 快照总线 + PortValue 模型），语义上高度同构：

| 脚本（JS） | 画布（LiteGraph） | 同构度 |
|---|---|---|
| `agent(prompt, {schema, agentId})` | `Saros.Agent` 节点（spec 配置） | 完全 |
| `const a = await agent(...)` 后传给下一个调用 | 边（上游输出端口 → 下游输入端口） | 完全 |
| `pipeline(items, s1, s2)` | 波次分层链（层间 barrier 语义略不同：pipeline 无 barrier，画布波次有） | 近似（语义差异需标注） |
| `parallel(thunks)` | 同波次并行节点组 | 完全 |
| `phase(title)` | `Saros.Group` / 分组注释 | 近似 |
| `if / switch`（JS 语句） | `Saros.IfElse / Switch` 节点 | 近似 |
| `args` | Start 节点 / 参数 widget | 完全 |
| `return value` | End 节点 / OUTPUT 归档 | 完全 |
| `nodeOutput(stageUid)` | 显式上游连线 | 完全 |
| `log()` | 无对应（运行时叙事，画布无元素） | 单向 |
| **`for / .map() 动态扇出`**（items 来自运行时） | **无静态对应**（画布无法表达「运行时才知道多少个节点」） | ★**不可静态同构** |

**不对称的根源**：画布是**声明式静态 DAG**（可全量静态分析、所见即所执行）；脚本是**图灵完备的命令式程序**（执行前无法完全确定 agent 调用次数与拓扑）。`for (const f of args.files) agent(...)` 这种按数据驱动的扇出，画布要么铺 N 个节点（N 运行时才知），要么引入「批处理节点」新概念。**这是所有双模式系统都必须面对的边界**。

### 5.2 开源项目解决方案对比（四种模式）

| 模式 | 代表项目 | 双向性 | 真源（source of truth） | 关键机制 | 对本项目的启示 |
|---|---|---|---|---|---|
| **A. 代码优先，图是只读投影** | LangGraph Studio、Dagster asset graph、Airflow Graph View | 代码→图（单向） | 代码 | 从代码/运行时生成可视化 | 动态脚本的「运行时 DAG 投影」正合适 |
| **B. 文档同源，双视图双向可编辑** | **Kestra**（YAML ↔ Topology ↔ No-Code 三视图）、**AWS Step Functions Workflow Studio**（ASL ↔ 画布）、Azure Logic Apps（JSON ↔ Designer）、**Windmill**（code ↔ flow）、**ComfyScript**（Python ↔ ComfyUI 画布，双向 sync） | 双向同步 | 单一文档（YAML/JSON/IR） | 同一份序列化文档，两个编辑器各自写入；离出可同步子集即降级 | 双向 sync 需定义**可同步子集** + 冲突策略；ComfyScript 证明 ComfyUI 生态可行 |
| **C. 画布优先，代码是序列化导入/导出** | n8n（workflow JSON import/export）、Node-RED（flow JSON）、Langflow、**ComfyUI-to-Python-Extension**（画布→Python 单向导出） | 单向或一次性互换 | 画布 JSON | 「导出代码」= 生成器（generators），改代码后需整体重导入，不保持同步 | M4a 的最小实现：画布→脚本骨架导出 |
| **D. 画布内嵌代码节点（局部逃生舱）** | Dify Code 节点、n8n Function/Code 节点 | 不适用 | 画布 | 代码只是画布中的一个节点类型 | 本项目对应物是 ComfyTV 的已有代码类 stage；不是全局双模式 |

**关键事实**：没有项目对「图灵完备脚本」做到无条件双向同步——B 类全部建立在**受限 DSL**（YAML/ASL/声明式 IR）上。ComfyScript 之所以能双向 sync，是因为 Python 侧被约束为生成节点调用的直线代码（每语句=一节点），自由 Python 控制流会破坏 sync。**可同步子集是双模式的充要条件**。

### 5.3 可行性结论与推荐方案

**可行，且本项目条件比多数开源项目更好**：已有成熟画布（LiteGraph）+ M1 将建脚本引擎 + 两者共享执行底座与 PortValue 模型。推荐「B+C 混合、A 为观察器」的三段式（对应 M4a/b/c）：

#### M4a 画布 → 脚本导出（模式 C，1 周级）
- 入口：画布工具栏「导出为 Workflow 脚本」；遍历 `buildExecutionPlan` 拓扑序生成脚本骨架
- 映射：节点→`agent()` 调用（spec 的 agentId/schema 进 opts）；边→变量传递；波次→`pipeline()`/`parallel()`；`IfElse`→`if`；`Group`→`phase()`
- 产物在 Chat 中作为可编辑起点（用户/模型再加工），**不做回写**——单向生成，无冲突问题
- 价值：画布用户零成本获得脚本的动态能力（导出后加 `for` 循环扇出）

#### M4b 脚本 → 画布运行时投影（模式 A，M1 后即可做，性价比最高）
- 数据源：`WorkflowEngineEvent` 事件流（phase/agent-start/agent-end 已含 label/phase/childId）
- 实现：每个 `agent()` → 一个 `Saros.Agent` 节点（只读，标 🔵 projected）；pipeline/parallel 的并发关系 → 边；phase → Group；运行结束保留为「运行快照图」（随快照总线按 stageUid 归档）
- **超越画布的表达**：动态扇出的 N 个 agent 在投影图中真实呈现（静态画布做不到）；聊天的 workflow 卡片头部加「在画布中查看」徽标 → 投影图
- 只读，不产生同步冲突

#### M4c 静态子集双向 sync（模式 B，最后做）
- **真源抉择：LiteGraph JSON**（画布已成熟、编辑器完备；脚本作为生成视图）——与 Kestra/Step Functions 同构
- 脚本编辑器（Code 视图）实时 lint：`agent()/pipeline()/parallel()/phase()/if` 的固定调用序列 = 可同步子集（绿色「Canvas Sync」徽标）；出现 `for/while/动态 items` → 徽标变灰「仅代码模式，画布投影将只读」（M4b 兜底显示）
- 切换语义：Canvas → Code = 生成器（5.3 M4a 规则）；Code → Canvas = AST 解析（acorn/esprima 提取调用图）重建 nodes/edges；越出子集的编辑拒绝回画布（提示原因），不丢代码
- 冲突策略：单侧编辑会话锁（编辑 Code 时画布只读，反之亦然）——ComfyScript 同款，避免三方合并

#### UI：切换控件
- 画布编辑器标题栏加 `Canvas | Code` 分段控件（Toggle）；Code 侧 = Monaco（mainProcess 已有 editor 能力，webview 内嵌 Monaco 或复用 chat 的代码块编辑器）
- M4a/b 阶段：切换是「导出/投影」按钮；M4c 阶段：真双视图

### 5.4 风险

1. **pipeline 与画布波次的语义差异**（无 barrier vs 层间 barrier）：投影/导出时在图中标注，或 M3 给画布加「无 barrier 边」选项——先标注，不急改执行器
2. **AST 提取的边界**：模板字符串/高阶函数包裹的 agent 调用可能漏提——可同步子集 lint 从严（只认直接调用形态），漏判降级为「仅代码」，不误判
3. **双真源诱惑**：不要做「两边都是真源的自由同步」（无先例、冲突地狱）；坚持单真源 + 降级路径
