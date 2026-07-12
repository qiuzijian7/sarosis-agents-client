# 多 Agent 并行处理与状态管理：Continue vs LangGraph vs Sarosis 对比分析

## 一、架构总览

| 维度 | Continue | LangGraph | Sarosis (本项目) |
|------|----------|-----------|-----------------|
| **语言** | TypeScript | Python | TypeScript |
| **并行模型** | 串行 Subagent（beta） | Pregel 超步并行（true parallel） | Promise.allSettled 批量并行 |
| **状态管理** | Service Container + 临时覆盖 | Channel + Reducer + Checkpoint | IterationBudget + 消息历史 |
| **上下文管理** | Auto-compaction (80% 阈值) | Checkpoint 快照 + State snapshot | ContextManager 压缩 + 消息裁剪 |
| **子 Agent 模式** | 单一 Subagent 工具 | Subgraph + Send + Supervisor | Explore/General/Scout 三类 |
| **持久化** | ChatHistoryService (内存) | InMemory/Postgres/SQLite Saver | 消息历史文件 + session 存储 |

---

## 二、Continue 的方案

### 2.1 Agent Loop（串行循环）

```
streamChatResponse() {
  while (true) {
    1. 刷新 chatHistory
    2. 获取 systemMessage
    3. 获取可用工具
    4. Pre-API 自动压缩检查 (handlePreApiCompaction)
    5. 调用 LLM 流式 API
    6. 处理工具调用 (handleToolCalls) → 如有工具调用，继续循环
    7. 工具后验证
    8. 80% 阈值常规自动压缩 (handleNormalAutoCompaction)
    9. 自动继续 (handleAutoContinuation)
    10. shouldContinue=false → break
  }
}
```

**特点**：
- **单线程串行**：工具调用是逐个执行的，没有并行
- **压缩优先**：每轮迭代都检查上下文占用，超 80% 自动压缩
- **无状态隔离**：子 Agent 通过临时覆盖全局 Service Container 实现"隔离"

### 2.2 Subagent 机制（串行，非真并行）

```typescript
// executor.ts — 子 Agent 执行
async function executeSubAgent(...) {
  // 1. 临时覆盖全局权限为 allow all
  serviceContainer.set(TOOL_PERMISSIONS, { permissions: { policies: [{ tool: "*", permission: "allow" }] } });

  // 2. 创建全新 chatHistory（不继承父 Agent 历史）
  const chatHistory = [{ message: { role: "user", content: prompt }, contextItems: [] }];

  // 3. 调用 streamChatResponse（阻塞等待完成）
  const result = await streamChatResponse({ chatHistory, ... });

  // 4. finally 恢复原始全局状态
  serviceContainer.set(TOOL_PERMISSIONS, originalPermissions);
}
```

**关键设计**：
- 子 Agent 有**独立的历史记录**，不继承父 Agent 的对话上下文
- 通过**临时覆盖 + finally 恢复**实现"伪隔离"（不是真正的并发安全隔离）
- 子 Agent 执行时**阻塞主 Agent**，等结果返回后才继续
- **没有并行多个子 Agent 的机制**

### 2.3 状态管理

```
ServiceContainer (全局单例)
├── ModelService        — 模型列表、auth
├── ChatHistoryService  — 对话历史
├── ToolPermissionService — 工具权限
├── SystemMessageService — 系统提示
├── ContextService      — 上下文项
└── ConfigService       — 配置
```

- **无持久化**：ChatHistoryService 纯内存，重启即丢
- **无状态快照**：没有 checkpoint 机制
- **压缩策略**：
  - Pre-API 压缩：发送 API 前检查，超限先压缩
  - 80% 阈值压缩：常规迭代中检查
  - 压缩方式：用 LLM 把旧消息摘要为一条 system 消息

### 2.4 上下文压缩（Compaction）

```typescript
// compaction.ts — 核心压缩逻辑
async function compactMessages(messages, llm) {
  // 1. 保留最后 N 条消息（不压缩）
  const keepRecent = messages.slice(-6);
  
  // 2. 将较早的消息送给 LLM 摘要
  const toCompress = messages.slice(0, -6);
  const summary = await llm.chat([
    { role: "system", content: "Summarize the following conversation..." },
    { role: "user", content: JSON.stringify(toCompress) },
  ]);
  
  // 3. 用摘要消息替换旧消息
  return [
    { role: "system", content: `Previous conversation summary:\n${summary}` },
    ...keepRecent,
  ];
}
```

---

## 三、LangGraph 的方案

### 3.1 Pregel 超步模型（True Parallel）

```
PregelLoop.tick() 流程:
1. prepare_next_tasks() — 根据当前 channel 版本决定哪些节点就绪
2. 检查 interrupt_before
3. PregelRunner.tick() / atick() — 并行执行所有就绪任务
4. after_tick() — apply_writes() 将结果写入 channel，创建新 checkpoint
5. 检查 interrupt_after
6. 循环直到无任务 → done
```

**核心特点**：
- **BSP（Bulk Synchronous Parallel）模型**：每个超步内所有就绪节点并行执行，步间同步
- **Channel 驱动**：节点通过 channel 读取输入、写入输出，channel 的版本号决定哪些节点就绪
- **真正的并行**：异步模式用 `asyncio.gather`，同步模式用 `ThreadPoolExecutor`

### 3.2 并行调度引擎（PregelRunner）

```python
# _runner.py — 异步并行调度
class PregelRunner:
    async def atick(self, tasks, ...):
        futures = []
        for task in tasks:
            fut = self.submit()(
                arun_with_retry, task, retry_policy,
                stream=self.use_astream,
                ...
            )
            futures.append(fut)
        
        # 等待所有任务完成（FIRST_COMPLETED 逐个收割）
        while futures:
            done, pending = await asyncio.wait(futures, return_when=FIRST_COMPLETED)
            for fut in done:
                result = await fut
                # 收集结果
            futures = list(pending)
```

**并发控制**：
- `max_concurrency` 信号量限制最大并发数
- `asyncio.Semaphore` 或 `threading.Semaphore`
- 超时策略：`TimeoutPolicy`（每个任务可配独立超时）
- 重试策略：`RetryPolicy`（指数退避，可配 max_attempts）

### 3.3 状态管理（Channel + Reducer）

```python
# 四种 Channel 类型

# 1. LastValue — 每步最多一个值（最常用，普通变量语义）
channel = LastValue(int)

# 2. BinaryOperatorAggregate — reducer 合并（列表追加、字典合并等）
channel = BinaryOperatorAggregate(list, operator.add)  # list 追加

# 3. Topic — PubSub 主题（可多写多读）
channel = Topic(str)

# 4. NamedBarrierValue — 等待多个节点完成后触发
channel = NamedBarrierValue(concurrency=3)
```

**add_messages reducer（最常用）**：
```python
# message.py — 消息追加 reducer
def add_messages(left: list, right: list) -> list:
    # 按 id 去重合并：相同 id 的消息，right 覆盖 left
    by_id = {m.id: m for m in left}
    for m in right:
        if m.id in by_id:
            by_id[m.id] = m  # 覆盖
        else:
            by_id[m.id] = m  # 追加
    return list(by_id.values())

class MessagesState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]  # 声明 reducer
```

### 3.4 动态并行分发（Send API — Map-Reduce）

```python
# types.py — Send 对象用于动态并行分发
@dataclass
class Send:
    node: str        # 目标节点名
    state: dict      # 该任务的独立状态

# 使用示例：Map-Reduce 模式
def map_topics(state):
    """为每个主题创建一个并行子任务"""
    return [
        Send("research_node", {"topic": topic})
        for topic in state["topics"]
    ]

graph.add_conditional_edges("init", map_topics)
# 所有 research_node 实例并行执行，结果通过 reducer 合并回 state
```

**关键设计**：
- `Send` 允许在运行时动态决定并行多少个子任务
- 每个子任务有**独立的状态输入**（不共享父状态）
- 结果通过 channel reducer 自动合并
- 无需预先定义并行数量

### 3.5 子图组合（Subgraph）

```python
# 子图作为节点嵌入父图
child_graph = StateGraph(ChildState)
child_graph.add_node("worker", worker_fn)
child_graph.add_edge(START, "worker")
child_graph.add_edge("worker", END)
child_compiled = child_graph.compile(checkpointer=child_saver)

parent_graph = StateGraph(ParentState)
parent_graph.add_node("orchestrator", orchestrator_fn)
# 子图作为节点
parent_graph.add_node("child", child_compiled)
parent_graph.add_edge("orchestrator", "child")
parent_graph.add_edge("child", "orchestrator")
```

**特点**：
- 子图有**独立的状态空间**（不同 TypedDict）
- 子图可有**独立的 checkpointer**
- 父子图通过**状态转换函数**传递数据
- 支持**多层嵌套**

### 3.6 Checkpoint 持久化

```python
# Checkpoint 结构
checkpoint = {
    "v": 1,                    # 版本
    "id": "thread-1-step-3",   # 唯一 ID
    "ts": "2026-07-11T...",    # 时间戳
    "channel_values": {        # 所有 channel 的当前值
        "messages": [...],
        "counter": 42,
    },
    "channel_versions": {      # 每个 channel 的版本号
        "messages": 5,
        "counter": 3,
    },
    "versions_seen": {         # 每个节点已处理的 channel 版本
        "node_a": {"messages": 4, "counter": 2},
    },
    "pending_writes": [...],   # 待写入的操作
}

# 三种 Saver
class InMemorySaver(BaseCheckpointSaver): ...     # 内存
class SqliteSaver(BaseCheckpointSaver): ...       # SQLite
class PostgresSaver(BaseCheckpointSaver): ...     # PostgreSQL
```

**恢复机制**：
- `graph.invoke(None, config={"configurable": {"thread_id": "xxx"}})` — 从 checkpoint 恢复
- 支持时间旅行：`graph.get_state_history(config)` — 获取所有历史状态
- 支持分支：从任意历史 checkpoint 继续执行

### 3.7 多 Agent 协作模式

```
┌─────────────────────────────────────────────┐
│ Supervisor 模式                              │
│                                              │
│  ┌──────────┐                                │
│  │Supervisor│──┬──→ Agent A (research)       │
│  └──────────┘  ├──→ Agent B (coding)         │
│       ↑        └──→ Agent C (review)         │
│       │                                      │
│  Supervisor 决定下一个调用哪个 Agent          │
│  Agents 之间不直接通信                       │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ Swarm 模式（Handoff）                        │
│                                              │
│  Agent A ──handoff──→ Agent B                │
│     ↑                     │                  │
│     └─────handoff─────────┘                  │
│                                              │
│  Agent 通过 Tool 调用将控制权交给另一个 Agent │
│  状态在 handoff 时完整传递                    │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ Hierarchical 模式                            │
│                                              │
│  Main Graph                                  │
│  ├── Subgraph 1 (Team A)                     │
│  │   ├── Agent A1                            │
│  │   └── Agent A2                            │
│  └── Subgraph 2 (Team B)                     │
│      ├── Agent B1                            │
│      └── Agent B2                            │
│                                              │
│  每层有独立的图结构和状态空间                  │
└─────────────────────────────────────────────┘
```

---

## 四、Sarosis（本项目）的方案

### 4.1 Agent Loop（迭代循环）

```typescript
// agentOSService.ts — 主循环
while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    
    // Yield to event loop every 5 iterations
    if (iteration % 5 === 0) {
        await new Promise(r => setTimeout(r, 0));
    }
    
    // 1. 调用模型
    const stream = modelProvider.chat(modelId, messages, modelOptions, context);
    
    // 2. 处理流式响应
    for await (const delta of stream) {
        // 收集 text / tool_calls / thinking
    }
    
    // 3. 执行工具调用（串行）
    for (const toolCall of effectiveToolCalls) {
        const result = await executeTool(toolCall);
        // 将结果加入 messages
    }
    
    // 4. 无工具调用 → break
    if (effectiveToolCalls.length === 0) break;
}
```

### 4.2 SubAgent 并行调度

```typescript
// unifiedSubAgentDispatch.ts — 批量并行
async executeMultipleSubAgents(
    subAgentIds: string[],
    executeFn: (request, budget) => AsyncIterable<IChatStreamDelta>,
    eventSink?: SubAgentEventSink,
    groupId?: string,
): Promise<Map<string, SubAgentResult>> {
    const results = new Map<string, SubAgentResult>();
    
    // 按 maxConcurrent 分批执行
    for (let i = 0; i < subAgentIds.length; i += this._maxConcurrent) {
        const batch = subAgentIds.slice(i, i + this._maxConcurrent);
        
        // Promise.allSettled — 一个失败不影响其他
        const settled = await Promise.allSettled(
            batch.map(async (subAgentId) => {
                const result = await this.executeSubAgent(subAgentId, executeFn, eventSink, groupId);
                return { subAgentId, result };
            })
        );
        
        for (const outcome of settled) {
            if (outcome.status === 'fulfilled') {
                results.set(outcome.value.subAgentId, outcome.value.result);
            } else {
                // 记录失败结果
            }
        }
    }
    return results;
}
```

**特点**：
- **真并行**：`Promise.allSettled` 批量执行，`maxConcurrent` 控制并发度
- **容错**：一个子 Agent 失败不影响其他（allSettled 语义）
- **预算隔离**：每个子 Agent 有独立的 `IterationBudget`，且共享父预算

### 4.3 三类 SubAgent

| 类型 | 权限 | 用途 |
|------|------|------|
| **Explore** | 只读（grep/glob/read/webfetch） | 代码探索，不能修改 |
| **General** | 读写（含执行，不能 delegate） | 通用任务执行 |
| **Scout** | 外部（clone repo/web fetch） | 外部研究 |

### 4.4 迭代预算（IterationBudget）

```typescript
class IterationBudget {
    private _remaining: number;
    private readonly _parentBudget?: IterationBudget;
    
    consume(count = 1): void {
        this._remaining = Math.max(0, this._remaining - count);
        // 同步消耗父预算
        if (this._parentBudget) {
            this._parentBudget.consume(count);
        }
    }
    
    createChildBudget(maxIterations?: number): IterationBudget {
        return new IterationBudget(maxIterations ?? this._remaining, this);
    }
}
```

**特点**：
- 父子预算联动：子 Agent 消耗迭代时，父预算同步递减
- 防止子 Agent 无限循环耗尽资源
- 支持 refund（工具失败时退还）

### 4.5 上下文管理

```
ContextManager
├── 消息压缩 — 超阈值时用 LLM 摘要旧消息
├── 消息裁剪 — pruneMessagesForContext（对齐 Continue）
│   └── system + tools + 最后一条消息不可裁剪
├── Memory 注入 — Episodic/Semantic/Procedural
└── 技能注入 — required 强制加载 / always / auto 关键词匹配
```

---

## 五、三方对比矩阵

### 5.1 并行能力

| 能力 | Continue | LangGraph | Sarosis |
|------|----------|-----------|---------|
| **工具并行执行** | ❌ 串行 | ✅ Pregel 超步并行 | ❌ 串行（循环内） |
| **子 Agent 并行** | ❌ 串行阻塞 | ✅ Send API 动态并行 | ✅ Promise.allSettled 批量 |
| **并发度控制** | N/A | ✅ max_concurrency 信号量 | ✅ maxConcurrent 分批 |
| **容错（部分失败）** | N/A | ✅ per-task retry/timeout | ✅ allSettled 语义 |
| **Map-Reduce 模式** | ❌ | ✅ Send + reducer | ❌ |

### 5.2 状态管理

| 能力 | Continue | LangGraph | Sarosis |
|------|----------|-----------|---------|
| **状态结构** | Service Container | Channel + Reducer | 消息历史 + Budget |
| **状态隔离** | 临时覆盖+恢复 | 独立 Channel 空间 | 独立 Budget + 权限 |
| **状态合并** | N/A | Reducer（add/list/dict） | N/A（结果直接返回） |
| **持久化** | ❌ 内存 | ✅ Memory/SQLite/Postgres | ✅ 消息文件 |
| **Checkpoint** | ❌ | ✅ 完整快照 + 时间旅行 | ❌ |
| **恢复执行** | ❌ | ✅ 从任意 checkpoint | ❌ |

### 5.3 上下文管理

| 能力 | Continue | LangGraph | Sarosis |
|------|----------|-----------|---------|
| **压缩策略** | LLM 摘要 (80%) | N/A（依赖 checkpoint） | LLM 摘要 + 裁剪 |
| **消息裁剪** | compileChatMessages | N/A | pruneMessagesForContext |
| **Token 计数** | tiktoken（精确） | N/A | chars/4（启发式） |
| **Memory** | ❌ | ❌（需自建） | ✅ Episodic/Semantic |

### 5.4 多 Agent 架构

| 能力 | Continue | LangGraph | Sarosis |
|------|----------|-----------|---------|
| **协作模式** | 仅 Subagent 工具 | Supervisor/Swarm/Hierarchical | Explore/General/Scout |
| **子图组合** | ❌ | ✅ 多层嵌套子图 | ❌ |
| **动态分发** | ❌ | ✅ Send API | ❌ |
| **权限隔离** | 临时覆盖 | 独立状态空间 | 权限 profile（read/write/exec） |
| **预算控制** | ❌ | ❌ | ✅ IterationBudget 父子联动 |

---

## 六、Sarosis 可借鉴的改进方向

### 6.1 从 LangGraph 借鉴

1. **Channel + Reducer 状态模型**
   - 当前：子 Agent 结果直接返回给父 Agent，无状态合并机制
   - 改进：引入 channel 概念，子 Agent 结果通过 reducer 自动合并
   - 场景：多个 Explore agent 并行搜索，结果通过 `add_messages` reducer 合并到父 Agent 的消息历史

2. **Send API 动态并行**
   - 当前：`dispatchParallelExplore` 需要预先传入 task 列表
   - 改进：允许 Agent 在运行时动态创建并行子任务（如 LLM 返回多个搜索方向）
   - 场景：Agent 分析代码后决定并行搜索 5 个模块，数量在运行时才确定

3. **Checkpoint 持久化**
   - 当前：仅消息历史持久化，无法从中间状态恢复
   - 改进：增加 checkpoint 保存当前迭代/budget/活跃子 Agent 状态
   - 场景：长任务中断后恢复，不需要从头开始

4. **子图组合**
   - 当前：SubAgent 是扁平的，不能嵌套
   - 改进：允许 SubAgent 内部再派生子 Agent（多层委托）
   - 场景：Supervisor → Team Lead → Worker 三层架构

### 6.2 从 Continue 借鉴

1. **Auto-compaction 策略**
   - 当前：ContextManager 有压缩，但阈值/触发逻辑不如 Continue 精细
   - 改进：引入 Pre-API 压缩（发请求前检查）+ 80% 阈值常规压缩
   - 场景：长对话中自动压缩，避免 400 错误

2. **精确 Token 计数**
   - 当前：`chars/4` 启发式
   - 改进：引入 tiktoken 或类似精确计数器
   - 场景：更精确的裁剪，减少误裁或漏裁

### 6.3 Sarosis 的独特优势

1. **IterationBudget 父子联动** — Continue 和 LangGraph 都没有的迭代预算控制
2. **权限 Profile** — Explore/General/Scout 三类权限隔离比 Continue 的 allow-all 更安全
3. **技能系统** — required/always/auto 三级激活机制
4. **Memory 三层架构** — Episodic/Semantic/Procedural 长期记忆
