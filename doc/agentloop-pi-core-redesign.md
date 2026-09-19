# 以 pi 为 AgentLoop 核心的重设计方案（记忆 / 代码库 / 聊天框兼容本项目）

> 目标：**用 `@earendil-works/pi-agent-core@0.85.1` 的轻量 loop 替换 `executeAgentTurnDirect` 的内核**；
> **记忆、代码库、聊天框（UI / 会话 / 审批）保持现状**。
> 依据：`G:\CustomWorkspaces\AIProjects\pi`（checkout 09-16）与 `doc/agentloop-paradigm-comparison-and-pluggable-design.md`（7 月对比）+ 2026-09-19 的逐维对比分析。
> 设计日期：2026-09-19。

---

## 0. 目标与非目标

**目标**
- 内核换成 pi（`agentLoop` / `Agent`）——把"怎么驱动 LLM / 工具 / 重试 / 续跑"交给一个久经考验的原语层；
- 记忆、代码库、聊天框**完全兼容**：UI 一行不改、会话/审批不动、图谱索引/锁/存储不动。

**非目标（本期不做）**
- 不迁移到 pi **harness**（lane + drive + durable commit）—— 作为 P2 可选增强（只做写类工具三段式）；
- 不改 LLM provider 栈（继续走我方 `LMBridge` / driverService / BYOK / fallback）；
- 不动聊天 UI / parts 渲染。

---

## 1. 可行性基线（已逐条核实，不是推测）

| 事实 | 证据 |
|---|---|
| **pi 轻量 loop 是 Node-free 的** | `packages/agent/src/agent-loop.ts` / `agent.ts` / `types.ts` / `stream-fn.ts` 只 import `@earendil-works/pi-ai` 的类型与纯 TS 工具（`getCurrentTools`/`getToolStateChanges`/`normalizeContext`/`toToolDeclaration`/`validateToolArguments`）+ `typebox`；`pi-ai` 全包里 `node:` 导入**只在 `cli.ts`**（2 行）⇒ 可 esbuild 进 **renderer** ✓ |
| **`StreamFn` 显式可注入** | `stream-fn.ts` 注释原话："Hosts that provide a default model runtime can install its stream function here **without making pi-agent-core depend on a provider catalog or compatibility layer**" ⇒ **我方 LMBridge 就是它的 StreamFn** ✓✓ |
| **loop 契约正好是适配器形状** | `agentLoop(prompts, context, config, signal, streamFn) → EventStream<AgentEvent, AgentMessage[]>`；事件 sink 是 **async**（自带 backpressure，对齐我方流式调度器）✓；`agentLoopContinue` 原生支持续跑 ✓ |
| **续跑/终止语义现成** | `agentLoopContinue`（"最后一条消息必须可转换为 user/toolResult"）= 我方"截断续写/重试"的原语；`AgentToolResult.terminate=true` = 我方 `plan_exit`/`plan_approval` 的提前终止 ✓ |
| **工具形状可映射** | `AgentTool extends Tool { label, parameters(TSchema=JSON Schema), execute(args, signal, onUpdate) → AgentToolResult{content, details, terminate?, usage?} }`；typebox 的 TSchema 运行时就是 JSON Schema ⇒ 我方工具 schema 可直传 ✓ |
| **许可** | MIT（`packages/agent/package.json`）✓ |

---

## 2. 目标架构：**六件套适配层**（替换内核、保留外壳）

```
聊天框（agentChatPanel / nativeChatEditorPane / streamingRenderScheduler）   ← 零改动
agentChatService（会话 / fork / resume / 审批卡片）                            ← canonical，保持
        │  IChatStreamDelta（对外契约不变）
        ▼
PiTurnDriver  ← 新：替代 executeAgentTurnDirect 的"内核调度"
        │
        ├─ 1) EventAdapter     pi AgentEvent  →  我方 IChatStreamDelta / parts（UI 零改）
        ├─ 2) StreamFnAdapter  pi StreamFn    →  我方 LMBridge / driverService（streaming + usage + finishReason）
        ├─ 3) ToolAdapter      我方 53 builtin + MCP  →  pi AgentTool[]（execute 走我方执行器：审批/护栏全保留）
        ├─ 4) ContextAdapter   我方 Compression/HardPrune/记忆注入  →  pi transformContext / prepareNextTurn
        ├─ 5) StateAdapter     pi turn 状态  ↔  我方 AgentRunState（checkpoint 每 3 轮 / 快照恢复 不变）
        └─ 6) GuardrailBridge  我方护栏族  →  pi beforeToolCall（block/改参） + 截断续写  →  agentLoopContinue
        │
记忆（agentmemory-gateway + .codebuddy/memory + memory 工具）  ← 经 ToolAdapter + ContextAdapter 接入
代码库（codebaseGraph 工具族：search_code / query_graph / …）   ← 经 ToolAdapter 接入（索引/锁/watcher/SQLite 不动）
```

**一句话**：替换的是**内核**（`executeAgentTurnDirect` 内部怎么驱动 LLM/工具/重试/续跑），对外契约 `IChatStreamDelta` **不变** ⇒ UI、会话、审批、图谱**零改动**。

---

## 3. 逐件设计

### 3.1 StreamFnAdapter（Provider 适配）— `browser/piCore/streamFnAdapter.ts`

pi 侧：`StreamFn(model, context, options) → AssistantMessageEventStream`（事件：start / text_delta / thinking_delta / toolcall_delta / toolcall_end / done / error）。
我方：`driverService` / `LMBridge` 的流（`[LMBridge] sendChatRequest …`）。

映射：

| pi | 我方 |
|---|---|
| `text_delta` / `thinking_delta` | 流式文本 / 思考 |
| `toolcall_end`（完整 toolCall） | 组装完成的工具调用（pi 用 partial-json salvage 流式参数） |
| `done(stopReason)` | finishReason 映射：`stop / length / toolUse / error / aborted`；**我方 `truncated-text`（stop 但尾部结构截断，`detectTruncatedTail`）在适配层检测 ⇒ 触发 `agentLoopContinue`**（今天新加的机制直接变成 pi 的原生续跑原语 ✓✓） |
| `usage` | promptTokens / completionTokens / cache 命中（对齐 pi 的 cacheRead/cacheWrite 字段） |

- **超时/重试**：我方 `firstTokenTimeout` 自适应保留（包住 streamFn）；provider 错误分类**借 pi 的 `isRetryableAssistantError` 正则表**（25+ 种），指数退避封顶 60s。

### 3.2 ToolAdapter（工具适配）— `browser/piCore/toolAdapter.ts`

- 我方 `IToolDefinition` → `AgentTool`：`parameters` 直传 JSON Schema（cast 为 TSchema）；`execute` → 我方工具执行器（**审批、`toolExecutionGuard`、hardline 护栏全保留**）。
- **护栏桥**（见 §3.6）：pi 的 `beforeToolCall` 回调 ← 我方 `detectToolCallLoop` / `detectArgumentChurn` / XML 泄漏 / 审批门 ⇒ 返回 `{ block: true, reason }` 或改写参数。
- `terminate: true` ⇒ 我方 `plan_exit` / `plan_approval`。
- 并行/串行：pi 支持 per-tool `executionMode:"sequential"` ⇒ 对齐我方"多目标 churn 工具串行"（`_isMultiTargetChurnTool`）。

### 3.3 ContextAdapter（上下文 + 记忆注入）— `browser/piCore/contextAdapter.ts`

- pi 钩子：`transformContext(messages)`（每轮 LLM 前）+ `prepareNextTurn`（可换模型/上下文/注入消息）+ `steering` / `followUp` 队列。
- 映射：
  - 我方 `Compression`（阈值 0.7、工具 schema 估算、`ineffectiveCompression` 计数）→ `transformContext`；**`HardPrune` 保留为 model-free 兜底**（pi 没有 ⇒ 我方更强，保留）。
  - 记忆注入（agentmemory recall + `.codebuddy/memory` 工作记忆）→ `prepareNextTurn` 追加 `<system-reminder>`。
  - prefix-cache 对齐：pi 的 `convertToLlm` 边界 ⇒ 我方 `Fork prefix-cache aligned` 机制保留。

### 3.4 EventAdapter（事件 → 聊天框）— `browser/piCore/eventAdapter.ts`

pi `AgentEvent`（10 种）：`agent_start / agent_end / turn_start / turn_end / message_start / message_delta / message_end / tool_execution_start / tool_execution_update / tool_execution_end`。

映射到我方 `IChatStreamDelta` / parts：`message_delta`→text delta；`tool_execution_*`→tool part（**partial update ⇒ 工具卡片实时进度** ✓）；`turn_end`→iteration 边界。
⇒ UI / `streamingRenderScheduler` / 工具卡片 **零改动**。

### 3.5 StateAdapter（状态 ↔ AgentRunState）— `browser/piCore/stateAdapter.ts`

- pi 轻量 loop 是内存态（不持久化）⇒ **我方 `AgentRunState` 快照 + checkpoint 每 3 轮保留**；崩溃恢复先走我方粗粒度恢复。
- P2 再把 pi harness 的"写类工具三段式（planned→effect_pending→outcome）"嫁接进来（崩溃安全增强，不影响本期）。

### 3.6 GuardrailBridge（护栏与截断续写）— `browser/piCore/guardrailBridge.ts`

- `beforeToolCall`：churn / loop / 幻觉 / 审批 ⇒ block / 改参。
- **截断整批作废**（pi 原生语义）：`length` ⇒ 拒绝执行该批 tool call + 回喂"参数可能不完整"。
- 与我方 `truncated-text`（**有文本但结构截断** ⇒ 续写）区分并存：**length=作废工具；truncated-text=续写文本**（今天新加的机制保留）。

---

## 4. 兼容矩阵（记忆 / 代码库 / 聊天框）

| 子系统 | 兼容方式 | 改动量 |
|---|---|---|
| 聊天框 UI | EventAdapter ⇒ `IChatStreamDelta` 不变 | **0** |
| 会话 / fork / resume / 审批 | `agentChatService` 保持 canonical；pi 只驱动单 turn | 小（StateAdapter） |
| 记忆（agentmemory + 工作记忆 + memory 工具） | ToolAdapter（工具）+ ContextAdapter（注入） | 小 |
| 代码库（图谱工具族） | ToolAdapter；索引/锁/watcher/SQLite 存储**不动** | **0** |
| LLM provider | StreamFnAdapter ⇒ LMBridge/driver 保留 | 小 |
| MCP 工具 | ToolAdapter | 小 |
| 护栏族 | GuardrailBridge ⇒ pi `beforeToolCall` / 续跑原语 | 中 |
| 压缩 / HardPrune | ContextAdapter | 小 |

---

## 5. 迁移路线（零回归双跑）

- **P0 适配层骨架（1–2 天）**：新建 `browser/piCore/`（6 个适配器）；`agentloop.core = legacy | pi` **双跑开关**；**对拍**（同 prompt 双跑，比对 parts / 工具序列 / token 用量）。
- **P1 内核替换（2–3 天）**：`executeAgentTurnDirect` 内核改为驱动 pi（输出契约不变 ⇒ **现有 81 套 1871 例测试全绿为准入**）。
- **P2 吸收 pi 增强（按收益）**：存储不变量测试族（pi conformance 思想）、写类工具三段式、结构化遥测 schema（推广今天的心跳）、分支摘要、effect-gate。
- **P3 删除 legacy**：对拍一致后删除旧内核。

---

## 6. 风险与对策

1. **行为对齐成本**：我方护栏/截断/续写语义要在 pi 上逐一对拍 ⇒ **双跑对拍 + 现有测试族为准入**。
2. **pi 版本演进**：锁 `0.85.1` + vendor 适配层（**不 fork 源码**）；升级走依赖更新。
3. **renderer bundle**：已核实 Node-free ✓；注意只 import `pi-ai` 的 `types`/`models`/工具函数，**不引** `api/*` 的 provider 实现（否则会把 anthropic/openai/aws sdk 打进 renderer）。
4. **token 口径**：pi 与我方估算口径不同 ⇒ ContextAdapter 以**我方估算为准**。
5. **并发写者**：本工作区有并发会话 ⇒ 新目录 `browser/piCore/` 隔离，不碰热点文件。

---

## 7. 一句话总结

**pi 的轻量 loop 从第一天就是为"宿主自带 provider/tools/UI"而设计的**（`setDefaultStreamFn` 的注释原话）⇒ 它天生就是要被适配的内核。我方只需 **6 个适配器**即可把它装进来，且 UI / 记忆 / 代码库**零改动**；待跑稳后再按收益吸收 pi harness 的崩溃安全增强（P2）。
