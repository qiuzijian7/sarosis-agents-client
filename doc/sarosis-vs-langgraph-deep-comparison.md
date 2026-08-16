# Saros vs LangGraph 深度源码对比：优化建议与风险评估

## 概述

本文档基于对 LangGraph（`G:\CustomWorkspaces\AIProjects\langgraph`）和 Saros（`src/vs/sessions/contrib/agentStudio/`）核心源码的逐行分析，从 7 个维度进行深度对比，给出可落地的优化建议和风险评估。

> **v2 更新（2026-07-12）**：新增第「六」节「兼容多聊天窗口同时存在」，基于对 `nativeChatEditorPane.ts` / `agentChatService.ts` / `agentOSService.ts` / `workbench.ts` 的逐行源码调研。这是 Saros 相对 LangGraph 的**独有 UI 架构维度**（LangGraph 是无 UI 的执行引擎），也是暴露「执行引擎单例串行化」问题的关键切入点。

---

## 一、多 Session 并行

### 1.1 LangGraph 的方案

LangGraph 通过 **thread_id** 隔离不同会话，每个 thread 有独立的 checkpoint 链：

```python
# 每个 thread_id 对应一条独立的 checkpoint 链
graph.invoke(
    input,
    config={"configurable": {"thread_id": "session-1"}}
)
# 同时另一个 session 完全隔离
graph.invoke(
    input,
    config={"configurable": {"thread_id": "session-2"}}
)
```

- **状态隔离**：每个 thread 有独立的 `channel_values`、`channel_versions`、`versions_seen`
- **并行安全**：不同 thread 的 checkpoint 写入互不干扰（checkpointer 内部按 thread_id 分区）
- **恢复机制**：`graph.invoke(None, config)` 从该 thread 的最新 checkpoint 恢复
- **时间旅行**：`graph.get_state_history(config)` 获取所有历史 checkpoint，可从任意点分支

### 1.2 Saros 的方案

Saros 通过 `agentChatService` 管理 session：

```typescript
// session 创建
createAgentSession(agentId: string, title?: string): string

// session 切换
_selectAndLoadAgent(agentId: string) {
    // 重建整个聊天面板 UI
    // 从磁盘加载消息历史
    // 重置滚动位置
}
```

- **状态隔离**：每个 session 有独立的消息历史文件（磁盘持久化）
- **并行能力**：❌ **不支持多 session 并行执行** — 同一时刻只有一个 active session
- **恢复机制**：从消息历史文件恢复，但**无法恢复中间迭代状态**（如当前迭代次数、活跃子 Agent、budget 剩余）
- **时间旅行**：❌ 不支持

### 1.3 差异与风险

| 维度 | LangGraph | Saros | 风险等级 |
|------|-----------|---------|---------|
| Session 隔离 | thread_id + checkpoint | 消息历史文件 | 🟡 中 |
| 并行 Session | ✅ 天然支持 | ❌ 单 active session | 🔴 高 |
| 状态恢复 | ✅ 完整 checkpoint | ❌ 仅消息历史 | 🔴 高 |
| 时间旅行 | ✅ 任意 checkpoint | ❌ 不支持 | 🟡 中 |

### 1.4 优化建议

**P0 — Session 并行执行**（高风险，高收益）

当前 `_selectAndLoadAgent` 会重建整个 UI 并切换到新 session，旧 session 的 agent loop 被中断。建议：

```
1. 将 agent loop 的执行与 UI 解耦
   - agentOSService.executeAgentTurn() 与 session 展示分离
   - 后台 session 的 agent loop 继续执行，delta 写入消息历史
   - 前台 session 切换时只切 UI 展示，不中断后台 loop

2. 引入 SessionExecutor 概念
   - 每个 session 有独立的 SessionExecutor 实例
   - SessionExecutor 持有 IterationBudget、消息历史、活跃子 Agent
   - 多个 SessionExecutor 可并行存在

3. UI 展示后台 session 的进度
   - 后台 session 的新消息通过事件通知 UI
   - 类似 VS Code 的多终端 tab — 后台运行，前台查看
```

**风险评估**：🔴 高风险 — 需要重构 `agentChatService` 的 session 管理逻辑，涉及 UI 状态同步、资源竞争（模型 API 并发限制）、消息历史并发写入。

**P1 — Checkpoint 恢复**（中风险，中收益）

```
引入 ICheckpointSaver 接口：
  - saveCheckpoint(sessionId, state): 保存当前迭代状态
  - loadCheckpoint(sessionId): 恢复到保存点
  - listCheckpoints(sessionId): 列出所有 checkpoint

state 包含：
  - iteration (当前迭代次数)
  - messages (消息历史)
  - budget (IterationBudget 状态)
  - activeSubAgents (活跃子 Agent 列表)
  - toolResultsPending (待处理工具结果)
```

**风险评估**：🟡 中风险 — 需要序列化 IterationBudget 等运行时状态，且恢复后需重建 model provider 连接。

---

## 二、多子 Agent 并行

### 2.1 LangGraph 的方案

**Send API — 动态并行分发**：

```python
# 运行时动态决定并行多少个子任务
def distribute_work(state):
    # 可以在运行时根据 state 动态决定数量
    return [
        Send("worker_node", {"task": task, "parent_id": state["id"]})
        for task in state["tasks"]
    ]

graph.add_conditional_edges("supervisor", distribute_work)
# 所有 worker_node 实例在同一超步并行执行
# 结果通过 channel reducer 自动合并
```

**子图嵌套**：

```python
child_graph = StateGraph(ChildState).compile(checkpointer=child_saver)
parent_graph = StateGraph(ParentState)
parent_graph.add_node("child_team", child_graph)  # 子图作为节点
# 子图有独立状态空间 + 独立 checkpointer
# 父子图通过状态转换函数通信
```

**关键特性**：
- 子任务数量**运行时动态决定**，不需预定义
- 每个子任务有**独立状态输入**（Send 的 state 参数）
- 结果通过 **reducer 自动合并**到父状态
- 支持**多层嵌套**（子图内可再嵌子图）
- `max_concurrency` 信号量控制最大并发数

### 2.2 Saros 的方案

**UnifiedSubAgentDispatch — 批量并行**：

```typescript
// 预先创建所有子 Agent，然后批量执行
async dispatchParallelExplore(parentAgentId, tasks, executeFn, ...) {
    // 1. 为每个 task 创建子 Agent
    const subAgentIds = tasks.map((task, idx) =>
        this.createSubAgent(parentAgentId, task, { type: SubAgentType.Explore, ... })
    );

    // 2. 批量并行执行（maxConcurrent 控制并发度）
    const resultMap = await this.executeMultipleSubAgents(subAgentIds, executeFn, ...);

    // 3. 结果直接返回（无自动合并）
    return subAgentIds.map(id => resultMap.get(id)!).filter(Boolean);
}
```

**关键特性**：
- 子任务列表**预先传入**（不能运行时动态扩展）
- `maxConcurrent` 分批控制（默认 3）
- `Promise.allSettled` 容错（单个失败不影响其他）
- 子 Agent 有独立 IterationBudget（父子联动）
- `maxSpawnDepth = 2` 限制嵌套深度
- **结果不自动合并** — 调用方需手动处理

### 2.3 差异与风险

| 维度 | LangGraph | Saros | 风险等级 |
|------|-----------|---------|---------|
| 动态并行 | ✅ Send API 运行时决定 | ❌ 预先传入 task 列表 | 🟡 中 |
| 结果合并 | ✅ Reducer 自动合并 | ❌ 手动处理 | 🟡 中 |
| 子图嵌套 | ✅ 多层（独立状态空间） | ✅ 有限（maxSpawnDepth=2） | 🟢 低 |
| 并发控制 | ✅ Semaphore | ✅ maxConcurrent 分批 | 🟢 低 |
| 预算联动 | ❌ 无 | ✅ IterationBudget 父子联动 | — |

### 2.4 优化建议

**P1 — 动态并行分发**（中风险，高收益）

借鉴 LangGraph 的 Send API，允许子 Agent 在执行过程中动态创建新的并行子任务：

```typescript
// 新增：子 Agent 运行时动态分发
interface DynamicDispatch {
    /** 子 Agent 可在执行中调用此方法创建新的并行子任务 */
    dispatchParallel(tasks: string[], options?: SubAgentOptions[]): Promise<SubAgentResult[]>;
}

// 使用场景：Explore agent 搜索代码后发现 5 个模块需要深入分析
// 当前：必须等当前 agent 完成后，由父 agent 决定是否继续
// 改进：子 agent 直接动态分发 5 个并行子任务
```

**风险评估**：🟡 中风险 — 需要防止无限递归（已有 maxSpawnDepth=2），需增加运行时 task 数量限制。

**P2 — 结果自动合并（Reducer 模式）**（低风险，中收益）

```typescript
// 新增：SubAgent 结果合并器
interface SubAgentResultReducer<T> {
    /** 合并多个子 Agent 的结果 */
    merge(results: SubAgentResult[]): T;
}

// 预定义 reducer
const Reducers = {
    // 消息追加（对齐 LangGraph add_messages）
    appendMessages: (results) => results.flatMap(r => r.messages),

    // 去重合并（按 id 或 content hash）
    dedupMerge: (results) => {
        const seen = new Set<string>();
        return results.flatMap(r => r.items).filter(item => {
            const key = item.id || hash(item.content);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    },

    // 最佳结果选择（按 score 排序）
    bestResult: (results) => results.sort((a, b) => b.score - a.score)[0],
};
```

**风险评估**：🟢 低风险 — 纯增量功能，不改变现有调用方式。

---

## 三、工具并行

### 3.1 LangGraph 的方案

LangGraph 的工具并行通过 **Pregel 超步模型** 实现：

```python
# ToolNode 预构建组件支持并行工具调用
class ToolNode:
    def __call__(self, state):
        tool_calls = state["messages"][-1].tool_calls
        # 并行执行所有工具调用
        results = asyncio.gather(*[
            self.tools_by_name[tc["name"]].ainvoke(tc["args"])
            for tc in tool_calls
        ])
        # 所有结果通过 add_messages reducer 合并
        return {"messages": [ToolMessage(result) for result in results]}
```

**关键特性**：
- 同一超步内所有工具**真正并行**（asyncio.gather）
- 工具结果通过 `add_messages` reducer **自动合并**
- `max_concurrency` 信号量控制并发
- 每个工具有独立的 **RetryPolicy** 和 **TimeoutPolicy**
- 工具失败可触发 **error_handler 节点**（不中断其他并行工具）

### 3.2 Saros 的方案

Saros 在 agent loop 内有条件并行：

```typescript
// agentOSService.ts — 工具执行
const canParallel = shouldParallelizeToolBatch(localExecutedCalls);

if (canParallel) {
    // 并行：Promise.race 轮询池，先完成先返回
    for await (const toolResult of this._executeToolCallsParallelStreaming(...)) {
        toolResults.push(toolResult);
        // 逐个 yield 给 UI 显示
    }
} else {
    // 串行
    const serial = await this._executeToolCalls(localExecutedCalls, ...);
}
```

**`shouldParallelizeToolBatch` 判断逻辑**：
- 所有工具都是"安全并行"类型（如 `file_read`、`grep`、`glob`）
- 不包含写操作（`file_write`、`file_edit`、`terminal`）
- 不包含有副作用的工具

**并行实现**：
- `Promise.race` 轮询池：所有工具同时启动，先完成的先返回
- 不是 `Promise.all` — 而是**流式返回**（先完成先显示）

### 3.3 差异与风险

| 维度 | LangGraph | Saros | 风险等级 |
|------|-----------|---------|---------|
| 并行模型 | Pregel 超步（全部并行） | 条件并行（安全工具才并行） | 🟢 低 |
| 并行度 | max_concurrency 信号量 | 无限制（所有 safe 工具同时启动） | 🟡 中 |
| 流式返回 | ❌ 全部完成后合并 | ✅ 先完成先返回 | — |
| 工具超时 | ✅ TimeoutPolicy per-tool | ❌ 全局无超时 | 🔴 高 |
| 工具重试 | ✅ RetryPolicy per-tool | ❌ 无重试 | 🟡 中 |
| 失败隔离 | ✅ error_handler 节点 | ✅ 不影响其他工具 | 🟢 低 |

### 3.4 优化建议

**P0 — 工具超时机制**（高风险，高收益）

当前工具执行没有超时保护，一个卡住的工具会阻塞整个 agent loop：

```typescript
// 新增：per-tool 超时配置
interface IToolExecutionOptions {
    timeoutMs?: number;  // 默认 30000，可 per-tool 覆盖
    retryPolicy?: {
        maxAttempts: number;
        backoffMs: number;
        retryableErrors?: string[];
    };
}

// 工具执行包装
async _executeToolWithTimeout(
    toolCall: IToolCall,
    options: IToolExecutionOptions
): Promise<IToolResult> {
    const timeout = options.timeoutMs ?? 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        return await this._executeToolCall(toolCall, controller.signal);
    } catch (err) {
        if (err.name === 'AbortError') {
            return { error: `Tool timed out after ${timeout}ms` };
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
```

**风险评估**：🔴 高风险 — 需要确保所有工具实现都尊重 AbortSignal，部分工具（如 terminal、file_write）可能不支持中断。

**P1 — 工具重试策略**（中风险，中收益）

```typescript
// 对齐 LangGraph RetryPolicy
interface IRetryPolicy {
    maxAttempts: number;      // 默认 3
    backoffMs: number;        // 指数退避基数，默认 1000
    retryableErrors: string[];// 可重试的错误类型
    jitterMs: number;         // 随机抖动，避免惊群
}

// 工具级别配置
const TOOL_RETRY_POLICIES: Record<string, IRetryPolicy> = {
    'file_read':     { maxAttempts: 3, backoffMs: 500,  retryableErrors: ['ENOENT', 'EACCES'] },
    'grep':          { maxAttempts: 2, backoffMs: 1000, retryableErrors: ['timeout'] },
    'web_fetch':     { maxAttempts: 3, backoffMs: 2000, retryableErrors: ['ECONNRESET', 'ETIMEDOUT', '5xx'] },
    'file_write':    { maxAttempts: 1, backoffMs: 0,    retryableErrors: [] }, // 不重试
    'terminal':      { maxAttempts: 1, backoffMs: 0,    retryableErrors: [] }, // 不重试
};
```

**风险评估**：🟡 中风险 — 写操作重试可能导致重复写入，需区分幂等/非幂等工具。

---

## 四、容错机制

### 4.1 LangGraph 的方案

LangGraph 有**多层容错**：

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Per-Task RetryPolicy + TimeoutPolicy           │
│   - 每个任务可配独立的重试次数、退避策略、超时           │
│   - 指数退避 + jitter                                    │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Error Handler Node                             │
│   - 节点失败后自动调度 error_handler 节点                │
│   - error_handler 可访问失败上下文（异常、输入、输出）    │
│   - error_handler 可返回新状态（修复/降级/跳过）          │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Parallel Task Isolation                        │
│   - 一个并行任务失败不影响其他并行任务                    │
│   - _should_stop_others() 判断是否需要终止其他任务       │
│   - SKIP_RERAISE_SET 标记的任务失败不传播                │
├─────────────────────────────────────────────────────────┤
│ Layer 4: Checkpoint Recovery                            │
│   - 每个超步后保存 checkpoint                            │
│   - 失败后可从最后一个成功 checkpoint 恢复               │
│   - 支持时间旅行（从任意历史 checkpoint 分支）            │
├─────────────────────────────────────────────────────────┤
│ Layer 5: Graph Interrupt                                │
│   - interrupt_before/after 节点级中断                    │
│   - Human-in-the-loop：暂停等待人类输入后恢复             │
│   - Command(resume=...) 恢复执行                         │
└─────────────────────────────────────────────────────────┘
```

**Error Handler 关键代码**：

```python
# _runner.py — 错误处理器调度
def commit(self, task, fut):
    try:
        result = fut.result()
        # 正常完成
    except Exception as exc:
        if isinstance(exc, GraphBubbleUp):
            return  # 不处理，由 _panic_or_proceed 处理

        # 保存 ERROR 写入到 checkpointer
        self.writer(task, ..., ("__error__", exc))

        # 如果节点有 error_handler → 调度处理器任务
        if task.node.error_handler_node:
            self.schedule_error_handler(task, exc)
        elif self._should_stop_others(fut):
            # 致命错误 → 终止其他并行任务
            raise
```

### 4.2 Saros 的方案

Saros 的容错机制**较为分散**：

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Model Call Fallback                            │
│   - 主模型调用失败 → fallback 到备用模型                  │
│   - _executeWithFallbackDirectly 内部 try-catch          │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Tool Error Recovery Prompt                     │
│   - 工具失败后注入"修复建议"到消息历史                    │
│   - 如 terminal 失败建议先 pwd && ls                     │
│   - 借鉴 Hermes-Agent                                   │
├─────────────────────────────────────────────────────────┤
│ Layer 3: SubAgent allSettled                            │
│   - Promise.allSettled 确保单个子 Agent 失败不影响其他   │
│   - 失败结果标记 success=false                          │
├─────────────────────────────────────────────────────────┤
│ Layer 4: Iteration Budget                               │
│   - MAX_TOOL_ITERATIONS=50 硬上限                       │
│   - IterationBudget 父子联动防止失控                     │
├─────────────────────────────────────────────────────────┤
│ Layer 5: Tool Call Loop Detection                       │
│   - 窗口 10 条，同一工具+相同参数重复 3 次则阻止          │
│   - 借鉴 OpenClaw                                       │
└─────────────────────────────────────────────────────────┘
```

### 4.3 差异与风险

| 维度 | LangGraph | Saros | 风险等级 |
|------|-----------|---------|---------|
| 重试策略 | ✅ per-task RetryPolicy | ❌ 无工具重试 | 🔴 高 |
| 超时保护 | ✅ per-task TimeoutPolicy | ❌ 无工具超时 | 🔴 高 |
| 错误处理器 | ✅ error_handler 节点 | ❌ 仅注入修复提示 | 🟡 中 |
| 并行隔离 | ✅ _should_stop_others | ✅ allSettled | 🟢 低 |
| Checkpoint 恢复 | ✅ 每超步保存 | ❌ 无 | 🔴 高 |
| Human-in-the-loop | ✅ interrupt + resume | ❌ 无 | 🟡 中 |
| 循环检测 | ❌ 无 | ✅ 3 次窗口检测 | — |

### 4.4 优化建议

**P0 — 工具级超时 + 重试**（见第三节，不重复）

**P1 — Error Handler 机制**（中风险，高收益）

借鉴 LangGraph 的 error_handler 节点，在工具失败后执行自定义恢复逻辑：

```typescript
// 新增：工具级 error handler
interface IToolErrorHandler {
    /** 工具失败时调用，返回恢复策略 */
    handle(error: Error, toolCall: IToolCall, context: IToolContext): Promise<ToolRecoveryAction>;
}

type ToolRecoveryAction =
    | { type: 'retry'; delayMs?: number }           // 重试
    | { type: 'fallback'; result: IToolResult }      // 降级返回默认值
    | { type: 'abort'; reason: string }              // 终止 agent loop
    | { type: 'continue'; message: string }          // 继续执行（注入修复提示）

// 注册 error handler
const TOOL_ERROR_HANDLERS: Record<string, IToolErrorHandler> = {
    'file_read': {
        handle: async (err, call) => {
            if (err.code === 'ENOENT') {
                return { type: 'fallback', result: { error: 'File not found' } };
            }
            return { type: 'retry', delayMs: 500 };
        }
    },
    'web_fetch': {
        handle: async (err, call) => {
            if (err.message.includes('5xx')) {
                return { type: 'retry', delayMs: 2000 };
            }
            return { type: 'continue', message: 'Web fetch failed, try alternative approach' };
        }
    },
};
```

**风险评估**：🟡 中风险 — 需要为每个工具定义合理的恢复策略，不当的自动重试可能放大错误。

**P2 — Human-in-the-loop 中断**（低风险，中收益）

```typescript
// 新增：agent loop 中断与恢复
interface IAgentInterrupt {
    /** 请求中断（暂停 agent loop） */
    requestInterrupt(reason: string): void;

    /** 恢复执行（从中断点继续） */
    resume(resumeValue?: unknown): Promise<void>;

    /** 检查是否被中断 */
    isInterrupted(): boolean;
}

// 使用场景：
// 1. 工具执行前需要用户确认（如 file_delete、terminal rm -rf）
// 2. 长任务暂停后恢复
// 3. 人工审核 LLM 输出后继续
```

**风险评估**：🟢 低风险 — 增量功能，不改变现有流程。需确保中断时正确保存当前状态（messages、iteration、budget）。

---

## 五、状态管理

### 5.1 LangGraph 的方案

**Channel + Reducer 模型**：

```python
# 4 种 Channel 类型

# 1. LastValue — 每步最多一个值（普通变量语义）
state = StateGraph(MyState)
state.add_channel("counter", LastValue(int), default=0)

# 2. BinaryOperatorAggregate — reducer 合并
state.add_channel("messages", BinaryOperatorAggregate(list, add_messages))
# 多个节点同时写入 messages → add_messages 自动合并

# 3. Topic — PubSub（可多写多读）
state.add_channel("events", Topic(str))

# 4. NamedBarrierValue — 等待多个节点完成
state.add_channel("barrier", NamedBarrierValue(concurrency=3))
# 3 个并行节点都写入后，barrier 才释放，触发下游节点
```

**状态流转**：

```
节点 A 写入 channel "messages" (version 1)
  ↓
prepare_next_tasks: 检查 channel_versions > versions_seen
  ↓
节点 B 读取 channel "messages" (看到 version 1)
节点 B 写入 channel "result" (version 1)
  ↓
apply_writes: 更新 channel_versions
  ↓
节点 C 读取 channel "result" (看到 version 1)
```

**关键特性**：
- 状态更新通过 **channel 版本号**追踪（不是覆盖）
- 多个节点同时写同一 channel → **reducer 自动合并**
- `versions_seen` 记录每个节点已处理的版本（避免重复触发）
- **确定性**：相同输入 + 相同 channel 状态 → 相同执行顺序

### 5.2 Saros 的方案

**消息历史 + IterationBudget**：

```typescript
// 状态由两部分组成：

// 1. 消息历史（messages 数组）
messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
    { role: 'assistant', content: response, tool_calls: [...] },
    { role: 'tool', tool_call_id: 'xxx', content: toolResult },
    ...
]

// 2. IterationBudget（迭代预算）
budget = new IterationBudget(90);
// 子 Agent: budget.createChildBudget(10) — 父子联动

// 状态更新 = 追加消息 + 消耗 budget
messages.push({ role: 'tool', content: result });
budget.consume(1);
```

**关键特性**：
- 状态更新 = **追加消息**（无 reducer，无版本号）
- 子 Agent 结果**直接返回**给父 Agent（无自动合并）
- IterationBudget **父子联动**（子消耗 → 父同步递减）
- **无状态版本追踪**（无法知道某个节点是否已处理某个状态版本）

### 5.3 差异与风险

| 维度 | LangGraph | Saros | 风险等级 |
|------|-----------|---------|---------|
| 状态模型 | Channel + Reducer | 消息数组 | 🟡 中 |
| 状态合并 | ✅ Reducer 自动 | ❌ 手动 | 🟡 中 |
| 版本追踪 | ✅ channel_versions | ❌ 无 | 🟡 中 |
| 确定性 | ✅ 相同输入→相同顺序 | ❌ 非确定性 | 🟡 中 |
| 持久化 | ✅ Checkpoint | ✅ 消息文件 | 🟢 低 |
| 预算控制 | ❌ 无 | ✅ IterationBudget | — |

### 5.4 优化建议

**P1 — 消息历史版本追踪**（中风险，中收益）

当前无法判断某个工具结果是否已被 LLM 处理过（可能导致重复处理）。建议：

```typescript
// 为每条消息添加版本号
interface IVersionedMessage extends IChatMessage {
    /** 消息版本号（递增） */
    version: number;
    /** 该消息是否已被当前迭代处理 */
    processed?: boolean;
}

// 或更轻量：用 message id + 已处理集合
interface IAgentState {
    messages: IChatMessage[];
    /** 已处理的消息 id 集合（对齐 LangGraph versions_seen） */
    processedMessageIds: Set<string>;
}
```

**风险评估**：🟡 中风险 — 需要修改消息类型定义，影响面广。

**P2 — SubAgent 结果 Reducer**（见第二节，不重复）

---

## 六、兼容多聊天窗口同时存在

> 本维度是 Saros 特有的：LangGraph 是无 UI 的执行引擎，"多窗口"对它不存在。但 Saros 作为 IDE 内的 Agent Studio，需要支持多个聊天窗口（多 tab / 多 EditorGroup / pop-out 独立窗口）同时存在。这直接考验底层执行引擎能否支持多个 agent loop 真正并发。

### 6.1 Saros 的多窗口架构（三层）

```
┌────────────────────────────────────────────────────────────────┐
│ Layer 1: UI — EditorInput / EditorPane（真多实例）              │
│   NativeChatEditorInput (每窗口一实例)                          │
│     - chatId 唯一，URI = native-chat:///{chatId}                │
│     - 携带 _agentId / _sessionId / _name / _cliMode（可序列化）  │
│     - _runtimeState（messages/streamPhase/isSending）挂在 input  │
│   NativeChatEditorPane (每 EditorGroup 一实例，同组内 tab 复用)  │
│     - setInput() 切 tab 时保存旧 input 状态、恢复新 input 状态   │
│     - 每 pane 有独立 _streamingAssistantMsg / _deltaBuffer       │
├────────────────────────────────────────────────────────────────┤
│ Layer 2: 会话服务 — 单例 + Map 分桶（隔离 ✅）                    │
│   AgentChatService (单例)                                       │
│     - _historyCache: Map<agentId::sessionId, ChatMessage[]>     │
│     - _activeStreams: Map<agentId::sessionId, AbortController>   │
│     - _activeOnDeltas: Map<agentId::sessionId, onDelta>         │
│   AgentDriverService (单例)                                     │
│     - _activeTurns: Map<sessionId::agentId, turnId>（防跨叉取消）│
├────────────────────────────────────────────────────────────────┤
│ Layer 3: 执行引擎 — 单例 + 单字段（串行化 ❌）                    │
│   AgentOSService (单例)                                         │
│     - _loopAbortController: AbortController（单字段，非 Map！）  │
│     - _executionTracker: 全局工具执行池 + cancelAll()           │
│     - _approvalService: 每次 turn reset（跨窗口互斥）           │
│     - model override: 全局 swap（并发污染）                     │
│     - _totalInputTokens: 全局累加（跨窗口混合）                 │
└────────────────────────────────────────────────────────────────┘
```

### 6.2 关键机制详解

**多 tab / 多 group 布局**：
- 每个聊天窗口 = 一个 `NativeChatEditorInput`（`chatId` 唯一，`matches()` 只比 chatId → 允许并存）
- 同一 EditorGroup 内多个 tab **复用一个 Pane 实例**，`setInput()` 时保存/恢复 input 携带的 `_runtimeState`
- 不同 EditorGroup → **各自独立的 Pane 实例**（真正并列显示）
- 布局持久化：`AGENT_CHAT_LAYOUT_KEY = 'vssaros.agentChatLayout.v1'`，reload/pop-out 后重建 group 布局
- Agent 区与文件区是**物理隔离的两个 EditorPart**（聊天不能拖到文件区）

**流式输出的窗口路由（两条路径）**：

| 路径 | 触发 | 路由机制 | 隔离性 |
|------|------|---------|--------|
| A. 本地发送 | 用户在窗口内输入 | `sendMessage(..., delta => this._handleStreamDelta(delta))` 闭包回调直达发起 pane | ✅ 完全隔离 |
| B. 外部广播 | 看板任务等 | `onDidStreamDelta` 事件 `{agentId, sessionId, delta}` | ⚠️ **仅按 agentId 过滤，缺 sessionId** |

**取消隔离（三层，逐层收窄）**：

| 层 | 字段 | 隔离粒度 |
|---|---|---|
| ChatService | `_activeStreams: Map` | `agentId::sessionId` ✅ |
| DriverService | `_activeTurns: Map` | `sessionId::agentId` ✅（注释：prevent cross-fork cancellation）|
| **OSService** | `_loopAbortController` | **单字段 ❌** |

### 6.3 核心问题：执行引擎单例串行化

`agentOSService.executeAgentTurn` 是 `async *` generator（理论上可多实例并发迭代），**但持有的关键状态是实例级单字段，不是 per-turn 分桶**：

```typescript
// agentOSService.ts:116 — 单字段，每次 executeAgentTurn 覆盖
private _loopAbortController: AbortController | undefined;

// line 1309 — window-B 发起时覆盖 window-A 的 controller
this._loopAbortController = new AbortController();

// line 571-577 — cancelAgentLoop() 无参数，只能取消"最后一个"
cancelAgentLoop(): void {
    if (this._loopAbortController) {
        this._loopAbortController.abort();     // 只能取消最后覆盖的那个
        this._executionTracker.cancelAll();    // ⚠️ 跨窗口取消所有工具
    }
}
```

**并发冲突清单**（两个窗口同时跑 loop 时）：

| 字段 | 问题 | 后果 |
|------|------|------|
| `_loopAbortController` | 单字段被覆盖 | window-A 的工具读到 window-B 的 signal |
| `_executionTracker` | 全局池 + `cancelAll()` | 一个窗口取消，另一窗口的工具也被杀 |
| `_approvalService.reset()` | 每次 turn 开头重置 | B 启动清掉 A 的审批记忆 |
| model override | 全局 swap | 并发时模型选择互相污染 |
| `_totalInputTokens` | 全局累加 | Dashboard 统计跨窗口混合 |
| `_injectedSessions: Set` | 按 session 隔离 | ✅ 唯一正确隔离的字段 |

### 6.4 与 LangGraph 多 thread 并行对比

| 能力 | LangGraph | Saros |
|------|-----------|---------|
| 并行执行单元 | thread（checkpointer 隔离，天然并发） | agent loop（单例 OS，单 AbortController） |
| 状态隔离 | 每 thread 独立 state graph | Chat/Driver 层 Map 隔离 ✅ / OS 层单例共享 ❌ |
| 取消粒度 | 按 thread/run 独立 | Chat/Driver 层 per-session ✅ / OS 层全局 ❌ |
| 流路由 | 按 run_id 独立 | 本地闭包隔离 ✅ / 外部广播缺 sessionId ⚠️ |
| 并发工具执行 | 每 thread 独立 | 全局池 + cancelAll 无差别 ❌ |

**结论**：Saros 多窗口是「**UI 与会话状态多实例，但执行引擎（AgentOS）单例串行化**」。两窗口 UI 层完全隔离，可同时**显示**流式内容；但底层 agent loop 共享单例 OS 状态，**并非为真正并发多 loop 设计**。当前实际可用性：多窗口**交替使用**没问题（切 tab、后台查看历史），但**两窗口同时跑 loop** 会互相干扰。

### 6.5 差异与风险

| 维度 | LangGraph | Saros | 风险等级 |
|------|-----------|---------|---------|
| UI 多窗口 | N/A（无 UI） | ✅ 多 tab/group/pop-out | 🟢 低 |
| 会话状态隔离 | thread | Map 分桶 ✅ | 🟢 低 |
| 执行引擎并发 | ✅ 天然 | ❌ 单例串行化 | 🔴 高 |
| 外部广播路由 | 按 run_id | ⚠️ 缺 sessionId 维度 | 🟡 中 |
| 跨窗口工具取消 | 独立 | ❌ cancelAll 无差别 | 🔴 高 |

### 6.6 优化建议

**P0 — AgentOSService 执行状态 per-turn 分桶**（高风险，高收益）

这是支持多窗口真并发的**根因修复**，也是第一节「Session 并行」的底层前提：

```typescript
// 当前：实例级单字段
private _loopAbortController: AbortController | undefined;
private _totalInputTokens = 0;

// 改进：按 turnKey (sessionId::agentId) 分桶
interface ITurnExecutionState {
    abortController: AbortController;
    approvalState: ApprovalState;      // per-turn 审批记忆
    modelSelection: IModelSelection;   // per-turn 模型选择（不再全局 swap）
    tokenUsage: { input: number; output: number };
}
private _activeTurnStates = new Map<string, ITurnExecutionState>();

// cancelAgentLoop 改为带参数
cancelAgentLoop(agentId?: string, sessionId?: string): void {
    if (agentId && sessionId) {
        const key = `${sessionId}::${agentId}`;
        this._activeTurnStates.get(key)?.abortController.abort();
        // 只取消该 turn 的工具（需 _executionTracker 也按 turnKey 分组）
        this._executionTracker.cancelByOwner(key);
    } else {
        // 兼容旧行为：全部取消
        for (const s of this._activeTurnStates.values()) s.abortController.abort();
    }
}
```

**配套改动**：
1. `_executionTracker`（`toolExecutionGuard.ts`）：`_activeExecutions` 增加 `ownerKey` 字段，`cancelAll()` → `cancelByOwner(key)`
2. `_approvalService`：审批状态按 turnKey 分桶，不再每次 turn 全局 reset
3. model override：从全局 swap 改为 per-turn 传参（`context.modelSelection`）
4. token 统计：per-turn 累加后合并到全局 Dashboard

**风险评估**：🔴 高风险 — `agentOSService.ts` 是核心执行引擎（5000+ 行），`_loopAbortController` 在工具执行闭包中被多处引用（第 2969/3289/3578 行等）。改为 Map 分桶需确保所有闭包捕获正确的 turnKey，回归测试覆盖单窗口场景。建议分步：先加 Map 但保留单字段兼容，逐步迁移引用点。

**P1 — 外部广播路由补 sessionId 维度**（中风险，中收益）

```typescript
// nativeChatEditorPane.ts:1003-1009 — 当前只过滤 agentId
this._register(this._chatService.onDidStreamDelta(({ agentId, sessionId, delta }) => {
    if (agentId !== this._currentAgentId) { return; }
    // ⚠️ 缺少 sessionId 检查 → 同 agent 不同 session 的窗口会串台
    if (this._isSending && !this._isExternalSend) { return; }
    this._handleStreamDelta(delta);
}));

// 改进：补上 sessionId 过滤
this._register(this._chatService.onDidStreamDelta(({ agentId, sessionId, delta }) => {
    if (agentId !== this._currentAgentId) { return; }
    if (sessionId && sessionId !== this._currentSessionId) { return; }  // 新增
    if (this._isSending && !this._isExternalSend) { return; }
    this._handleStreamDelta(delta);
}));
```

同时修复 `_getOnDeltaForAgent`（`agentChatService.ts:1811`）的 memory 事件路由——当前按 agentId 前缀选"最近创建的流"，同 agent 多 session 时有歧义，应改为精确 `agentId::sessionId` 匹配。

**风险评估**：🟡 中风险 — 需确认所有外部广播（看板任务、定时任务）都正确携带 sessionId。若某些路径 sessionId 为空，需保留 fallback（不过滤）避免丢消息。

**P2 — 后台窗口执行进度指示**（低风险，中收益）

配合 P0 的 Session 并行后，后台 tab 的 agent loop 继续执行时，在 tab 标题显示进度指示（如 spinner / 迭代数），类似 VS Code 多终端的运行状态。

**风险评估**：🟢 低风险 — 纯 UI 增量，依赖 P0 完成。

---

## 七、其他核心功能

### 7.1 上下文压缩

| 维度 | LangGraph | Saros |
|------|-----------|---------|
| 压缩方式 | Checkpoint 快照（不压缩，存全量） | LLM 摘要 + 消息裁剪 |
| 触发时机 | 每超步 | ContextManager 阈值 + pruneMessagesForContext |
| Token 计数 | N/A | chars/4 启发式 |
| 精确度 | 100%（全量快照） | ~95%（摘要可能丢信息） |

**Saros 优势**：LLM 摘要保留了语义信息，比简单裁剪更智能。
**Saros 劣势**：chars/4 启发式可能高估或低估 token 数。

**建议**：引入 tiktoken 或类似精确计数器（P2，低风险）。

### 7.2 工具调用循环检测

| 维度 | LangGraph | Saros |
|------|-----------|---------|
| 循环检测 | ❌ 无 | ✅ 窗口 10 条，重复 3 次阻止 |
| 死锁预防 | ❌ 无 | ✅ IterationBudget 硬上限 |

**Saros 优势**：Tool Call Loop Detection 是 Saros 独有的，LangGraph 需要用户自行实现。

### 7.3 续跑兜底（Auto-continuation）

| 维度 | LangGraph | Saros |
|------|-----------|---------|
| 自动续跑 | ❌ 无 | ✅ "未完成意图"检测 + tool_choice='required' |
| 反思机制 | ❌ 无 | ✅ Plan-Execute-Reflect（文件修改后自查） |

**Saros 优势**：续跑兜底和反思机制是 Saros 独有的工程实践。

### 7.4 多 Agent 协作模式

| 维度 | LangGraph | Saros |
|------|-----------|---------|
| Supervisor | ✅ 预构建 | ❌ |
| Swarm (Handoff) | ✅ 预构建 | ❌ |
| Hierarchical | ✅ 子图嵌套 | ✅ 有限嵌套(maxSpawnDepth=2) |
| 权限隔离 | ❌ 无 | ✅ Explore/General/Scout |

**建议**：引入 Supervisor 模式（P2，中风险）— 一个主 Agent 根据任务类型路由到不同的专家 Agent。

---

## 八、优化优先级总览

| 优先级 | 优化项 | 风险 | 收益 | 建议时间 | 依赖 |
|--------|--------|------|------|---------|------|
| **P0** | **AgentOSService 执行状态 per-turn 分桶** | 🔴 高 | 高 | 3-5 天 | 无（多窗口/Session 并行的根因修复） |
| **P0** | 工具级超时机制 | 🔴 高 | 高 | 1-2 天 | 无 |
| **P0** | Session 并行执行 | 🔴 高 | 高 | 3-5 天 | 依赖「per-turn 分桶」 |
| **P0** | Checkpoint 恢复 | 🔴 高 | 高 | 2-3 天 | 无 |
| **P1** | 外部广播路由补 sessionId | 🟡 中 | 中 | 0.5 天 | 无 |
| **P1** | 工具重试策略 | 🟡 中 | 中 | 1 天 | 依赖工具超时 |
| **P1** | Error Handler 机制 | 🟡 中 | 高 | 2 天 | 无 |
| **P1** | 动态并行分发 | 🟡 中 | 高 | 2-3 天 | 无 |
| **P1** | 消息版本追踪 | 🟡 中 | 中 | 1 天 | 无 |
| **P2** | SubAgent 结果 Reducer | 🟢 低 | 中 | 1 天 | 无 |
| **P2** | Human-in-the-loop | 🟢 低 | 中 | 2 天 | 依赖 Checkpoint |
| **P2** | 后台窗口执行进度指示 | 🟢 低 | 中 | 1 天 | 依赖 Session 并行 |
| **P2** | 精确 Token 计数 | 🟢 低 | 低 | 0.5 天 | 无 |
| **P2** | Supervisor 多 Agent 模式 | 🟡 中 | 中 | 2 天 | 无 |

### 推荐实施顺序（依赖链）

```
第一阶段（根因修复，解锁多窗口/多 Session 并发）:
  ① AgentOSService per-turn 分桶  ─┬─→  ③ Session 并行执行  ─→  后台窗口进度指示
  ② 外部广播路由补 sessionId      ─┘

第二阶段（容错健壮性，可并行推进）:
  ④ 工具超时  ─→  工具重试
  ⑤ Error Handler
  ⑥ Checkpoint 恢复  ─→  Human-in-the-loop

第三阶段（能力增强，独立推进）:
  ⑦ 动态并行分发 + SubAgent Reducer
  ⑧ 消息版本追踪 / 精确 Token 计数 / Supervisor 模式
```

**关键洞察**：多窗口/多 Session 并行的**根因**都在 `agentOSService` 的执行状态单例化。「per-turn 分桶」（第六节 P0）是解锁「Session 并行」（第一节 P0）的前提，应作为**第一优先**。

---

## 九、Saros 独特优势（不应丢失）

在向 LangGraph 学习的同时，以下 Saros 独有特性是 LangGraph 没有的，应保持：

1. **IterationBudget 父子联动** — 防止子 Agent 无限循环耗尽资源
2. **权限 Profile**（Explore/General/Scout） — 比 LangGraph 的"全权"子 Agent 更安全
3. **Tool Call Loop Detection** — 自动检测重复工具调用
4. **续跑兜底** — "未完成意图"检测 + 强制 tool_choice
5. **Plan-Execute-Reflect** — 文件修改后自动反思
6. **技能系统** — required/always/auto 三级激活
7. **Memory 三层架构** — Episodic/Semantic/Procedural 长期记忆
8. **流式工具返回** — 先完成先显示（LangGraph 全部完成后才合并）
