# 多 Agent 上下文管理与故障恢复：五大项目横向对比

> 分析日期: 2026-06-12
> 项目范围: sarosis-agents-client（本项目）+ openclaw + Hermes-Agent + open-multi-agent + LangGraph

---

## 一、架构总览对比

| 维度 | Sarosis (本项目) | OpenClaw | Hermes-Agent | open-multi-agent | LangGraph |
|------|:---:|:---:|:---:|:---:|:---:|
| **语言** | TypeScript (VSCode fork) | TypeScript (Node.js) | Python | TypeScript | Python |
| **编排模式** | DAG 工作流 | 层次化生成 (树形) | 树形委托 | Coordinator + 任务队列 | 有状态图 (BSP 模型) |
| **Agent 模型** | 全局定义 + per-workspace 绑定 | 有状态 Agent 类 + 事件订阅 | AIAgent 类 + 继承 | 轻量 AgentConfig + Runner | 无 Agent 类，纯节点函数 |
| **并行执行** | 顺序递归执行 (DAG) | 嵌套 while 循环 | ThreadPoolExecutor | AgentPool + Semaphore | PregelRunner 并发任务 |
| **核心复杂度** | ~2000 行 execution service | ~1800 行 subagent-spawn | ~2000 行 delegate_tool | ~2300 行 orchestrator | ~2000 行 Pregel 引擎 |

---

## 二、多 Agent 上下文管理对比

### 2.1 上下文存储方式

```
┌──────────────────────────────────────────────────────────────────┐
│  Sarosis:  每个 session 的完整 JSON 文件 + 内存 historyCache     │
│  OpenClaw: ContextEngine 可插拔 + SessionEntry JSON 文件          │
│  Hermes:   SQLite SessionDB + Memory Provider 可插拔系统          │
│  oma:      每个 Agent 独立 messageHistory[] + SharedMemory KV    │
│  LangGraph: Channels (共享状态) + Checkpoint 持久化              │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 上下文传递路径

| 项目 | 传递方式 | 粒度 | 优缺点 |
|------|---------|------|--------|
| **Sarosis** | 完整历史 → priorMessages → Driver → Provider 压缩 | 会话级（粗） | ✅ 简单可靠 ❌ 短工作流全量冗余 |
| **OpenClaw** | SteeringQueue 注入 + Announcement 交付 | 消息级（精） | ✅ 精准注入 ✅ 父代理可引导子代理 |
| **Hermes** | 函数调用 + 结构化结果字典 + Memory Provider | 调用级（精） | ✅ Memory Provider 跨轮次关联 ❌ 无消息总线 |
| **oma** | 依赖结果注入 + SharedMemory + MessageBus | 三层分级 | ✅ 多种粒度可选 ✅ 默认拒绝(最小上下文) |
| **LangGraph** | Channels 共享状态 + Send 动态路由 + Command 显式路由 | 状态键级（最精） | ✅ 精确到单个 key ❌ 学习曲线陡峭 |

### 2.3 核心发现：Sarosis 的"全量历史捆绑" vs 其它项目的"按需上下文"

**Sarosis 的问题**（已在 `docs/workflow-agent-context-analysis.md` 详述）：
```
Agent Node 1 → 执行（产生对话历史）
Agent Node 2 → getHistory() → 完整历史 → sendMessage
Agent Node 3 → getHistory() → 完整历史 → sendMessage
...
所有节点的上下文 = 共享会话的全量历史
```

**open-multi-agent 的优雅方案**：
```typescript
// 默认拒绝原则：只注入直接依赖任务的结果
contextStrategy: {
  type: 'dependencies-only',  // 默认！
  // 或 'shared-memory', 'message-bus', 'all'
}
// Worker 只看到：自己的任务 + 依赖任务的结果 +（可选）共享内存摘要
```

**LangGraph 的精确控制**：
```python
# 每个节点只看到 Channels 中自己声明的 key
def node_a(state: AgentState) -> dict:
    # state 只包含通道中声明的字段，不会看到无关历史
    return {"research_result": findings}

def node_b(state: AgentState) -> dict:
    # 只收到 research_result，不会看到 node_a 的完整 LLM 对话
    pass
```

---

## 三、上下文窗口管理对比

### 3.1 压缩/截断策略

| 项目 | 策略 | 触发阈值 | 粒度 |
|------|------|---------|------|
| **Sarosis** | Hermes 三段式压缩 (Provider 层) | 50% contextWindow | 迭代级 |
| **OpenClaw** | LLM 摘要压缩 + 轮次分割 | `tokens > window - reserve(16K)` | 轮次级 |
| **Hermes** | ContextCompressor LLM 摘要 | 75% contextWindow | 轮次级 |
| **oma** | 4 种策略可选: 滑动窗口 / LLM摘要 / 规则压缩 / 工具结果压缩 | 可配置 `maxTokenBudget` | 策略可配 |
| **LangGraph** | 无内置压缩，依赖应用代码 + DeltaChannel | 手动实现 | 开发者控制 |

### 3.2 压缩时机的关键差异

```
Sarosis:    [Provider 层压缩]  ← 每次迭代都传全量历史，压缩在此层
            ↑ 问题：AgentChatService 不感知压缩，下次加载又全量

OpenClaw:  [ContextEngine.compact()] ← 引擎感知压缩，压缩后写回
           [assemble()] ← 每次组装前检查预算

Hermes:    [ContextCompressor.should_compress()] ← 75% 阈值
           [压缩后拆分 session → parent_session_id 链]

oma:       [AgentRunner 循环每次检查 maxTokenBudget]
           [4 种策略按 Agent 配置独立选择]

LangGraph: [无内置] ← 需手动 trim_messages() + DeltaChannel 增量
```

### 3.3 Sarosis 的压缩滞后问题（对比验证）

| 场景 | Sarosis (50% 阈值) | OpenClaw (token > window-16K) | oma (可配 maxTokenBudget) |
|------|:---:|:---:|:---:|
| 128K 窗口, 5 节点(15K) | 不触发 (11.7%) | 不触发 (15K < 112K) | 可配 20K 预算 → 触发截断 |
| 128K 窗口, 10 节点(30K) | 不触发 (23.4%) | 不触发 (30K < 112K) | 可配 20K 预算 → 触发截断 |
| 128K 窗口, 20 节点(60K) | 不触发 (46.9%) | 不触发 (60K < 112K) | 可配 30K 预算 → 触发截断 |
| 128K 窗口, 25 节点(75K) | 触发 (58.6%) | 不触发 (75K < 112K) | 可配 50K 预算 → 触发截断 |

**结论**：OpenClaw 的 `window - 16K reserve` 策略也对中短工作流很宽松，但 Sarosis 的 50% 阈值更宽。

---

## 四、Agent 失败恢复机制对比

### 4.1 恢复能力矩阵

| 恢复能力 | Sarosis | OpenClaw | Hermes | oma | LangGraph |
|----------|:---:|:---:|:---:|:---:|:---:|
| **取消当前执行** | ✅ (v21 修复) | ✅ | ✅ | ✅ | ✅ |
| **节点级重试** | ❌ | ✅ (子代理恢复) | ✅ (21种错误分类+16种恢复路径) | ✅ (指数退避, max 3) | ✅ (RetryPolicy 指数退避+抖动) |
| **超时保护** | ❌ | ✅ (48h 默认) | ✅ (可配 child_timeout + 心跳) | ✅ (timeoutMs per agent) | ✅ (TimeoutPolicy: run + idle) |
| **检查点/回滚** | ❌ | ❌ (基于恢复) | ✅ (Git 文件快照, 最多20个, 500MB) | ❌ (依赖任务级联) | ✅ (Checkpoint 时间旅行) |
| **错误分类** | ❌ | ❌ (基础) | ✅ (21种 FailureReason) | ❌ (基础 Exception) | ✅ (RetryPolicy.retry_on 可配) |
| **凭据轮换** | ❌ | ✅ | ✅ (CredentialPool 多密钥) | ❌ | ❌ |
| **循环检测** | ✅ (v31 visited Set + 深度限制) | ❌ (深度限制) | ❌ | ✅ (滑动窗口 3种模式) | ✅ (recursion_limit) |
| **预算控制** | ❌ | ❌ | ✅ (IterationBudget 90/50) | ✅ (maxTokenBudget + maxTurns) | ✅ (recursion_limit) |
| **级联失败** | ❌ | ✅ (父代理感知) | ✅ (interrupt 传播) | ✅ (cascadeFailure) | ✅ (ParentCommand 冒泡) |
| **流程审批** | ❌ (仅 breakpoint) | ❌ | ✅ (生成暂停) | ✅ (onPlanReady + onApproval) | ❌ |
| **异常后恢复** | ❌ | ✅ (孤儿恢复 3 次重试) | ✅ (会话重连) | ❌ | ✅ (checkpoint 时间旅行) |

### 4.2 各项目最值得借鉴的恢复设计

#### 🏆 Hermes-Agent：最全面的分层恢复系统

```
Layer 1: classify_api_error() → 21 种 FailureReason
           ├── auth / auth_permanent → 凭据刷新
           ├── rate_limit → 退避 + 凭据轮换
           ├── context_overflow → 压缩
           ├── image_too_large → 缩小重试
           ├── content_policy_blocked → 不重试
           └── server_error / overloaded / timeout → 重试

Layer 2: TurnRetryState → 16 个一次性恢复守卫
          每个恢复路径 (OAuth/图片缩小/格式清理...) 只能触发一次
          防止恢复死循环

Layer 3: CredentialPool → 多密钥故障转移
          租约获取/释放 → ok → exhausted → dead

Layer 4: CheckpointManager → Git 文件快照
          每轮自动触发，最多 20 个，500MB 限制
          restore() 支持全目录 + 单文件回滚

Layer 5: Heartbeat 心跳 → 子代理卡死检测
          过期检测 + 停止父代理活动时间戳
```

#### 🏆 LangGraph：最优雅的状态恢复

```python
# 时间旅行：从任意 checkpoint 恢复
previous_state = graph.get_state(config)
graph.invoke(None, previous_state.config)  # 从该点重放

# 错误处理器：节点级错误委托
graph.add_node("researcher", research_fn,
    retry_policy=RetryPolicy(max_attempts=3))
graph.add_node("error_handler", handle_error_fn)
# 节点出错 → 自动路由到 error_handler

# 优雅排空：SIGTERM 时在超步边界停止
runtime.control.request_drain("shutdown")
```

#### 🏆 open-multi-agent：最实用的任务级恢复

```typescript
// 任务配置
{
  maxRetries: 3,
  retryDelayMs: 1000,
  retryBackoff: 2,    // 指数退避
}

// 级联失败
taskA 失败 → 所有依赖 taskA 的任务自动标记为 failed

// 循环检测
loopDetection: {
  type: 'warn',       // warn → terminate
  window: 4,          // 滑动窗口大小
  threshold: 3,       // 连续重复次数
}
```

---

## 五、Sarosis 与各项目的差异总结

### 5.1 最大优势

| 优势 | 说明 |
|------|------|
| **可视化工作流** | ReactFlow 拖拽式 DAG，非开发者也能构建多 Agent 协作 |
| **强类型系统** | TypeScript 全链路编译检查，类型安全 |
| **变量系统** | 两轮替换 + `$prev.output` 上游引用，工作流作者友好 |
| **Session 隔离** | per-session 历史持久化，多轮对话天然支持 |
| **断点调试** | 工作流节点级断点暂停/继续 |

### 5.2 核心差距

| 差距 | 严重程度 | 对比基准 |
|------|:---:|------|
| **无按需上下文** | 🔴 高 | oma 的 dependency-only 默认策略 |
| **无节点级重试** | 🔴 高 | LangGraph RetryPolicy + Hermes 21 种错误分类 |
| **无超时保护** | 🔴 高 | 所有 4 个项目都有 |
| **上下文爆炸** | 🟡 中 | oma 的 maxTokenBudget |
| **无检查点回滚** | 🟡 中 | LangGraph Checkpoint + Hermes 文件快照 |
| **无消息总线** | 🟡 中 | oma 的 MessageBus |
| **无共享内存** | 🟡 中 | oma 的 SharedMemory + LangGraph Channels |
| **压缩滞后** | 🟡 中 | oma 的可配置策略 + OpenClaw 的 reserve 策略 |
| **无预算控制** | 🟡 中 | Hermes IterationBudget |
| **无级联失败** | 🟢 低 | oma 的 cascadeFailure |

---

## 六、对 Sarosis 的优化建议

### 6.1 P0：按需上下文（借鉴 open-multi-agent）

**当前状态**：所有 Agent 节点共享 session → 完整历史传递。

**建议**：在 Agent 节点配置中增加 `contextScope` 字段：

```typescript
// workflowStorage.ts - WorkflowNodeData 新增
interface AgentNodeData {
  // ...现有字段
  contextScope?: 'session' | 'upstream-only' | 'fresh';
  // session:      共享会话历史（当前默认行为）
  // upstream-only: 新 session + 仅上游节点输出作为 system 消息
  // fresh:        完全独立 session，不继承任何上下文
}
```

**实现要点**：
- `upstream-only` 时在 `_executeAgentNode` 中创建独立 session
- 将 `_collectUpstreamOutputs` 的结果构造为 system 消息注入
- 当前节点 prompt 作为唯一 user 消息
- 执行完毕后将结果写入父 session 的上下文（供下游 `$prev` 引用）

### 6.2 P0：`maxHistoryMessages` 工作流级限制（借鉴 oma）

```typescript
// workflowExecutionService.ts
interface IWorkflowExecutionOptions {
  // ...现有字段
  maxHistoryMessages?: number;  // 默认 50，超过则清理旧消息
}
```

在 `_sendAndTrackStream` 中，每次发送前检查 session 历史长度，超过限制则调用 `agentChatService.clearOldMessages(agentId, sessionId, keepRecent)`。

### 6.3 P1：节点级重试策略（借鉴 LangGraph + Hermes）

```typescript
// WorkflowNodeData 新增
interface RetryConfig {
  maxAttempts: number;          // 默认 0（不重试）
  initialDelayMs: number;       // 默认 1000
  backoffMultiplier: number;    // 默认 2
  maxDelayMs: number;           // 默认 30000
  retryOn?: string[];           // 可重试的错误类型
}
```

在 `_executeNodeRecursive` 的 catch 块中实现重试循环：

```typescript
for (let attempt = 0; attempt <= retryConfig.maxAttempts; attempt++) {
  try {
    await executeNode();
    break;  // 成功
  } catch (err) {
    if (attempt === retryConfig.maxAttempts) throw err;
    if (!isRetryable(err, retryConfig.retryOn)) throw err;
    await sleep(backoffDelay(attempt, retryConfig));
  }
}
```

### 6.4 P1：节点超时保护（借鉴 LangGraph TimeoutPolicy）

```typescript
interface TimeoutConfig {
  runTimeoutMs: number;    // 节点最大执行时间，默认 300000 (5min)
  idleTimeoutMs: number;   // 无输出最大空闲时间，默认 60000 (1min)
}

// 在 _sendAndTrackStream 中使用 Promise.race
const result = await Promise.race([
  agentChatService.sendMessage(...),
  timeoutPromise(runTimeoutMs),
]);
```

### 6.5 P1：上下文策略可配置（借鉴 oma 4 种策略）

在 Provider 层将当前的"仅 Hermes 三段式"扩展为可选策略：

```typescript
type ContextStrategy = 
  | { type: 'hermes-segment'; threshold: number }   // 当前默认
  | { type: 'sliding-window'; keepTurns: number }    // 借鉴 oma
  | { type: 'summarize'; budgetTokens: number }      // 借鉴 oma
  | { type: 'compact'; keepRecentTurns: number };    // 借鉴 oma
```

### 6.6 P1：压缩时机优化（借鉴 OpenClaw）

将压缩触发条件从 `token > 50% * window` 改为 `token > window - reserveTokens`：

```typescript
// contextManager.ts
const reserveTokens = 16384;  // 从 OpenClaw 借鉴
const shouldCompress = estimatedTokens > (contextWindow - reserveTokens);
```

### 6.7 P1：压缩结果回写（借鉴 OpenClaw ContextEngine）

当前 Provider 层压缩后不写回 `AgentChatService._historyCache`，导致下次加载又来一次全量压缩。建议：

```typescript
// executionProvider.ts - 压缩后
if (compactionApplied) {
  await this.agentChatService.replaceHistory(agentId, sessionId, compressedMessages);
}
```

### 6.8 P2：级联失败 + Checkpoint（借鉴 LangGraph）

```typescript
// 级联失败
function cascadeFailure(executionState, failedNodeId) {
  // 标记所有依赖 failedNodeId 的节点为 Skipped (上游失败)
}

// Checkpoint 持久化
interface WorkflowCheckpoint {
  executionId: string;
  nodeStates: Map<string, IWorkflowNodeExecutionState>;
  context: Record<string, unknown>;
  timestamp: string;
}
// 每个节点完成后自动保存 checkpoint
// 失败后可以从上一个 checkpoint 恢复
```

### 6.9 P2：SharedMemory + MessageBus（借鉴 oma）

在工作流层面增加 Agent 间横向通信能力：

```typescript
// workflowExecutionService.ts
interface IWorkflowSharedMemory {
  write(agentId: string, key: string, value: string): void;
  read(key: string): string | undefined;
  getSummary(): string;  // 用于注入下游节点 prompt
}

interface IWorkflowMessageBus {
  send(fromAgentId: string, toAgentId: string, content: string): void;
  broadcast(fromAgentId: string, content: string): void;
  getMessages(agentId: string): Message[];
}
```

---

## 七、优先级路线图

```
┌──────────────────────────────────────────────────────────┐
│  Phase 1 (立即, P0):                                     │
│  1. contextScope: 'upstream-only' | 'fresh'              │
│  2. maxHistoryMessages 工作流级限制                       │
│                                                          │
│  Phase 2 (本周, P1):                                     │
│  3. 节点级重试策略 (RetryConfig)                          │
│  4. 节点超时保护 (TimeoutConfig)                          │
│  5. 上下文策略可配置 (Strategy 选择)                       │
│  6. 压缩时机优化 (window - reserveTokens)                 │
│  7. 压缩结果回写 _historyCache                            │
│                                                          │
│  Phase 3 (下周, P2):                                     │
│  8. 级联失败 + Checkpoint 持久化                          │
│  9. SharedMemory + MessageBus 横向通信                    │
└──────────────────────────────────────────────────────────┘
```

---

## 八、附录：各项目关键文件速查

| 关注点 | Sarosis | OpenClaw | Hermes | oma | LangGraph |
|--------|---------|----------|--------|-----|-----------|
| **Agent 上下文** | `agentChatService.ts:417` getHistory | `context-engine/types.ts` ContextEngine | `agent/context_compressor.py` | `agent/runner.ts:390` truncateToSlidingWindow | `channels/base.py` BaseChannel |
| **消息传递** | `agentChatService.ts:686` sendMessage | `subagent-announce-delivery.ts` | `tools/delegate_tool.py:1970` delegate_task | `team/messaging.ts` MessageBus | `types.py:664` Send / `types.py:758` Command |
| **多 Agent 编排** | `workflowExecutionService.ts:484` _executeNodeRecursive | `subagent-spawn.ts` spawnSubagentDirect | `tools/delegate_tool.py` _build_child_agent | `orchestrator/orchestrator.ts:1537` runTeam | `pregel/main.py` Pregel + `_loop.py` PregelLoop |
| **重试/恢复** | `workflowExecutionService.ts:1890` _sendAndTrackStream (仅 abort) | `subagent-orphan-recovery.ts` | `agent/error_classifier.py` 21种分类 + `agent/conversation_loop.py` | `orchestrator/orchestrator.ts:301` executeWithRetry | `pregel/_retry.py` run_with_retry |
| **超时** | ❌ | `agents/timeout.ts` | `tools/delegate_tool.py:400` _get_child_timeout | `agent/agent.ts:343` timeoutMs | `types.py:449` TimeoutPolicy |
| **压缩** | `contextManager.ts:1585` compressContext | `harness/compaction/compaction.ts` | `agent/context_compressor.py` | `agent/runner.ts:442` summarize + `agent/runner.ts:1158` compact | ❌ (应用自实现) |
| **持久化** | JSON 文件 | JSON SessionEntry | SQLite SessionDB | ❌ (内存) | Checkpoint (内存/SQLite/PG) |
