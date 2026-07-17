# AG2 vs Swarms vs Open-Multi-Agent 深度对比分析

> 基于源码级分析的三项目多 Agent 协同架构对比
> 分析时间：2026年6月

---

## 一、项目定位与技术栈

| 维度 | AG2（原 AutoGen） | Swarms | Open-Multi-Agent |
|------|-------------------|--------|-------------------|
| **语言** | Python | Python | TypeScript |
| **定位** | 通用多 Agent 对话框架 | 企业级 Swarm 编排框架 | 目标驱动的 Agent 编排框架 |
| **包名** | `ag2` | `swarms` | `@open-multi-agent/core` |
| **核心依赖** | Pydantic, anyio | Pydantic, networkx/rustworkx | `@anthropic-ai/sdk`, openai, zod |
| **设计哲学** | 对话即接口，能力可插拔 | 单一巨型 Agent + 多策略编排器 | 运行时建 DAG + 依赖拓扑调度 |

---

## 二、核心抽象层对比

### 2.1 Agent 抽象

**AG2：Protocol + 分层继承**

```
Agent (Protocol, runtime_checkable)
  └─ ConversableAgent (核心实现, ~5000行)
       ├─ AssistantAgent (默认 system message)
       ├─ UserProxyAgent (人类代理)
       └─ GroupChatManager (群聊管理器)
```

- 同步/异步双轨设计（`send`/`a_send`）
- `handoffs` 容器持有转移条件
- `context_variables` 跨 Agent 共享状态
- `register_for_llm`/`register_for_execution` 注册工具

**Swarms：单一巨型具体类**

```
Agent (具体类, ~6500行, 269KB)
  — 既是执行单元也是可调用对象 (__call__)
  — 持有 short_memory (Conversation) + long_term_memory (外部对象)
  — 三种终止机制: stopping_func / stopping_condition / stopping_token
```

- 无抽象基类，无继承层次
- 所有功能塞入一个类（LLM 调用、工具执行、记忆管理、MCP 集成）
- 实用主义设计，牺牲抽象换取开箱即用

**Open-Multi-Agent：状态机 + Runner 分离**

```
Agent (状态机: idle→running→completed|error)
  └─ AgentRunner (真正的对话循环, turn-based)
       — LLM调用 → 工具执行 → 回填tool_result → 继续
  └─ AgentPool (全局Semaphore + per-agent Semaphore)
```

- Agent 是高层封装，Runner 负责底层对话循环
- `outputSchema` 结构化输出（失败自动重试）
- `timeoutMs` + `abortSignal` 合并取消
- `LoopDetector` 滑动窗口检测重复行为

### 2.2 多 Agent 组织抽象

| 维度 | AG2 | Swarms | Open-Multi-Agent |
|------|-----|--------|-------------------|
| **组织单元** | GroupChat / Team / Pattern | BaseSwarm 子类 | Team |
| **消息机制** | Pydantic 消息模型，函数调用 | Conversation 共享实例 | MessageBus pub/sub |
| **共享状态** | ContextVariables | Conversation 字符串快照 | SharedMemory（命名空间隔离） |
| **Agent 间通信** | send/receive 方法调用 | 共享 Conversation 读取 | send(点对点) + broadcast(广播) |

---

## 三、编排模式深度对比

### 3.1 AG2：Pattern 抽象 + Handoff 体系

**四种 Pattern（`agentchat/group/patterns/`）：**

| Pattern | 工作原理 | 选择下一个 Agent 的方式 |
|---------|---------|----------------------|
| AutoPattern | GroupManager 用 LLM 自动选择 | LLM 评估上下文（Selector 语义） |
| RoundRobinPattern | 自动生成环形 handoffs | 固定轮转 |
| RandomPattern | 随机选择 | `random.choice` |
| ManualPattern | 人工选择 | 用户输入 |

**Swarm 机制（核心亮点）：**

AG2 的 Swarm 不是独立类，而是通过 **Handoffs + TransitionTarget** 体系实现：

```python
# 三层条件优先级求值
1. OnContextCondition  — Python 谓词，无需 LLM，回复前求值
2. OnCondition         — LLM 评估，编译为 transfer_to_<target>_<i> 工具函数
3. after_works         — 兜底，condition=None 表示恒真
```

**TransitionTarget 层级：**
- `AgentTarget` — 转交给指定 Agent
- `TerminateTarget` — 终止
- `StayTarget` — 留在当前 Agent
- `NestedChatTarget` — 嵌套对话
- `AskUserTarget` — 询问用户
- `RevertToUserTarget` — 回退给用户

**关键设计**：LLM handoff 通过 `update_conditional_functions` 动态注册/移除工具函数，实现"模型决定转交谁"的动态路由。

### 3.2 Swarms：SwarmRouter 工厂 + 16 种策略

**SwarmRouter（`structs/swarm_router.py`）：**

工厂模式 + 缓存，16 种 `SwarmType` 通过分发表 O(1) 查找：

```
SequentialWorkflow → 委托 AgentRearrange，自动生成 "A -> B -> C"
ConcurrentWorkflow → 所有 Agent 同任务并发，ThreadPoolExecutor
AgentRearrange     → einsum 风格 DSL
GroupChat          → 异步消息广播（唯一真正的 asyncio.Queue 实现）
GraphWorkflow      → networkx/rustworkx DAG
MixtureOfAgents    → 混合专家
MajorityVoting     → 多数表决
HierarchicalSwarm  → 层级
RoundRobin         → 轮转
...共16种
```

**AgentRearrange DSL（最简洁的设计）：**

```python
# 字符串语法 → 执行图
flow = "researcher -> writer, editor"
# 解析逻辑（极简）:
# 1. flow.split("->") 得到顺序步骤
# 2. 每步 step.split(",") 得到并发 Agent 名
# 3. len(agent_names) > 1 → 并发，否则 → 顺序
```

**GroupChat（唯一异步实现）：**
- 每个 Agent 一个 `asyncio.Queue` inbox
- `RESPOND_TOOL` 强制函数调用返回 `(score, message)`
- `score > threshold` 才广播（避免无关 Agent 发言）
- `idle_timeout` 静默终止

### 3.3 Open-Multi-Agent：Coordinator 模式 + DAG 调度

**runTeam（旗舰特性）：**

```
用户目标 → isSimpleGoal?
  ├─ 是 → 选最优 agent 单跑（短路）
  └─ 否 → Coordinator agent 分解为 JSON 任务规格
           → 装入 TaskQueue
           → Scheduler.autoAssign（依赖拓扑排序）
           → executeQueue（并行批次执行）
           → Coordinator 综合结果
```

**任务 DAG 调度：**

```typescript
// executeQueue 每轮并行批次
while (!queue.isComplete()) {
  const ready = queue.getReadyTasks();  // 依赖已满足
  await Promise.all(ready.map(task => runTask(task)));  // 并行执行
  // 完成后解锁下游依赖
}
```

**delegate_to_agent（运行时 handoff）：**

```typescript
// Agent 运行中可委派子任务给队友
// 内置安全机制：
// - delegationChain 环检测
// - maxDelegationDepth (默认 3)
// - 池槽位检查避免死锁
// - 被委派 agent 跑全新会话
// - token 用量回传父预算
```

**runConsensus（共识模式）：**

```
proposer → judge → (revise if dissent)
  ├─ quorum: 法定人数
  ├─ maxRounds: 最大轮次
  └─ onDissent: keep | revise
```

### 3.4 编排模式总览

| 编排能力 | AG2 | Swarms | Open-Multi-Agent |
|---------|-----|--------|-------------------|
| **顺序执行** | RoundRobinPattern | SequentialWorkflow | TaskQueue 依赖链 |
| **并行执行** | ⚠️ 有限支持 | ConcurrentWorkflow | ✅ DAG 自动并行化 |
| **动态路由** | ✅ Handoff（LLM 决策） | ❌ 需显式指定 | ✅ Coordinator 运行时分解 |
| **Swarm 模式** | ✅ Handoff 体系 | ✅ 16 种 Swarm 类型 | ❌ 无 Swarm 概念 |
| **共识/投票** | ❌ 无内置 | ✅ MajorityVoting | ✅ runConsensus |
| **嵌套对话** | ✅ NestedChatTarget | ❌ | ✅ delegate_to_agent |
| **人机协作** | ✅ AskUserTarget | ❌ | ❌ |
| **图编排** | ⚠️ beta/network | ✅ GraphWorkflow | ✅ 运行时 DAG |
| **目标驱动分解** | ❌ | ❌ | ✅ 核心特性 |

---

## 四、运行时架构对比

### 4.1 并发模型

| 维度 | AG2 | Swarms | Open-Multi-Agent |
|------|-----|--------|-------------------|
| **执行模型** | 同步为主，异步封装 | 同步为主，ThreadPoolExecutor | 全异步（Promise/async generator） |
| **并行机制** | AsyncThreadIOStream（线程跑同步逻辑） | ThreadPoolExecutor（默认 95% CPU 核数） | Semaphore（全局 maxConcurrency=5 + per-agent 锁） |
| **Agent 间通信** | 函数调用 | 共享 Conversation 字符串 | MessageBus pub/sub |
| **死锁防护** | ❌ 无 | ❌ 无 | ✅ delegationChain 环检测 + runEphemeral 绕过锁 |

**关键差异分析：**

- **AG2** 的异步是"伪异步"——在独立线程跑同步逻辑，通过 `AsyncThreadIOStream` 桥接。适合需要兼容大量同步代码的场景，但无法真正利用事件循环并发
- **Swarms** 直接用 `ThreadPoolExecutor` 做 CPU 级并行，简单粗暴但对 I/O 密集的 LLM 调用不是最优
- **Open-Multi-Agent** 是唯一真正基于事件循环的异步架构，`Semaphore` 控制并发度，`runEphemeral` 专门解决委派场景的死锁问题

### 4.2 状态管理

| 维度 | AG2 | Swarms | Open-Multi-Agent |
|------|-----|--------|-------------------|
| **短期记忆** | Agent 消息历史 | Conversation 实例 | Agent 对话历史 |
| **长期记忆** | ❌ 无内置 | 外部对象注入 | SharedMemory（命名空间 + TTL） |
| **跨 Agent 共享** | ContextVariables | 共享 Conversation | SharedMemory + MessageBus |
| **持久化/恢复** | ✅ Pydantic 序列化 | ❌ | ✅ Checkpoint snapshot/restore |
| **上下文策略** | ❌ 手动管理 | ❌ 手动管理 | ✅ ContextStrategy（滑窗/摘要/压缩） |

---

## 五、工具与扩展生态

### 5.1 工具系统

| 维度 | AG2 | Swarms | Open-Multi-Agent |
|------|-----|--------|-------------------|
| **工具基类** | `Tool` 类 + `@tool` 装饰器 | `BaseTool(BaseModel)` | `defineTool`（Zod schema） |
| **依赖注入** | ✅ ChatContext 自动注入 | ❌ | ❌ |
| **动态注册** | ✅ register_for_llm/execution | ✅ tools_list_dictionary | ✅ 运行时注册/注销 |
| **结构化输出** | ❌ | ❌ | ✅ outputSchema 校验 + 自动重试 |
| **工具执行器** | GroupToolExecutor（统一执行） | Agent 内部 execute_tools | ToolExecutor（maxOutputChars 截断） |

### 5.2 MCP 集成

| 维度 | AG2 | Swarms | Open-Multi-Agent |
|------|-----|--------|-------------------|
| **集成深度** | ✅ 完整（stdio + sse） | ✅ 完整（多服务器聚合） | ✅ 可选 peer dep |
| **工具包装** | Toolkit 类 | 自动转为 BaseTool | connectMCPTools 包装为框架工具 |
| **多服务器** | ✅ | ✅ 多服务器聚合 | ✅ namePrefix 隔离 |

### 5.3 内置工具

| 工具 | AG2 | Swarms | Open-Multi-Agent |
|------|-----|--------|-------------------|
| 代码执行 | ✅ Docker 沙箱 | ❌ | ✅ bash |
| 文件操作 | ❌ | ❌ | ✅ read/write/edit/glob/grep |
| Web 搜索 | ❌ | ❌ | ❌ |
| 委派 | ❌ | ❌ | ✅ delegate_to_agent |
| 用户交互 | ✅ UserProxyAgent | ❌ | ❌ |

---

## 六、优缺点总结

### 6.1 AG2（原 AutoGen）

**优点：**
1. **Handoff 体系设计精巧**——三层条件优先级（Context→LLM→兜底）+ 6 种 TransitionTarget，是最灵活的动态路由机制
2. **分层架构清晰**——Protocol → ConversableAgent → Pattern → GroupChat，每层职责明确
3. **分布式运行时（beta）**——Hub/Channel/Envelope/TransitionGraph 架构有生产级潜力
4. **生态成熟**——55k Stars，文档完善，AutoGen Studio 可视化工具
5. **人机协作**——原生支持三种 Human-in-the-loop 模式

**缺点：**
1. **伪异步**——AsyncThreadIOStream 在线程跑同步逻辑，无法真正利用事件循环并发
2. **新旧架构并存**——`group/targets/` 和 `beta/network/transitions.py` 两套 TransitionTarget，增加认知负担
3. **无内置长期记忆**——只有 ContextVariables 做短期共享，长期记忆需自行实现
4. **无目标驱动分解**——需要开发者预定义 Agent 角色和 handoff 规则，不能自动分解复杂目标
5. **并行能力弱**——GroupChat 本质是串行轮转，缺乏真正的并行执行

### 6.2 Swarms

**优点：**
1. **编排策略最丰富**——16 种 Swarm 类型，覆盖顺序、并发、图、投票、层级等所有常见模式
2. **AgentRearrange DSL 极简**——两次 `split` 解析执行图，学习成本几乎为零
3. **SwarmRouter 统一入口**——工厂模式 + 缓存，切换策略只需改 `swarm_type` 参数
4. **GroupChat 异步实现**——唯一真正的 asyncio.Queue 消息广播，score 过滤避免无关发言
5. **ThreadPoolExecutor 并行**——对 CPU 密集场景有优势

**缺点：**
1. **Agent 类过于臃肿**——6500 行 269KB 单一具体类，违反 SRP，维护困难
2. **抽象层级浅**——无 Agent 基类/接口，无继承层次，扩展靠修改巨型类
3. **消息传递原始**——通过共享 Conversation 字符串快照传递数据，非结构化消息
4. **无长期记忆**——short_memory 是 Conversation，long_term_memory 需外部注入
5. **无死锁防护**——并行执行无环检测
6. **无目标驱动分解**——需要显式指定 Agent 列表和执行策略
7. **TypeScript 类型安全缺失**——纯 Python，无静态类型检查（虽然有 type hints）

### 6.3 Open-Multi-Agent

**优点：**
1. **目标驱动分解（核心亮点）**——Coordinator 自动将目标分解为任务 DAG，无需预定义工作流
2. **真正的全异步架构**——Promise/async generator + Semaphore，最适合 I/O 密集的 LLM 调用
3. **死锁防护完善**——delegationChain 环检测 + maxDelegationDepth + runEphemeral 绕过锁
4. **SharedMemory 设计优秀**——命名空间隔离 + TTL + Checkpoint 恢复
5. **结构化输出**——outputSchema 校验 + 失败自动重试
6. **LoopDetector**——滑动窗口检测重复行为，防止 Agent 陷入死循环
7. **预算控制**——maxTokenBudget + 任务级 cascadeFailure/Skip
8. **TypeScript 类型安全**——Zod schema 运行时校验 + 编译时类型检查

**缺点：**
1. **无 Swarm 模式**——没有 Swarm/Handoff 概念，动态路由依赖 Coordinator 分解
2. **生态规模小**——相比 AG2（55k Stars）和 Swarms，社区和文档较少
3. **单一语言**——TypeScript only，无法在 Python 生态中使用
4. **无可视化工具**——没有 AutoGen Studio 那样的 GUI
5. **人机协作弱**——无内置 Human-in-the-loop 机制
6. **MCP 为可选依赖**——需要额外安装 `@modelcontextprotocol/sdk`

---

## 七、选型建议

### 7.1 按场景推荐

| 场景 | 推荐 | 理由 |
|------|------|------|
| **需要动态路由和 Handoff** | AG2 | Handoff 体系是最灵活的动态路由机制 |
| **需要多种编排策略快速切换** | Swarms | 16 种 Swarm 类型，SwarmRouter 一键切换 |
| **需要目标驱动的自动分解** | Open-Multi-Agent | Coordinator 模式自动建 DAG |
| **需要高并发异步执行** | Open-Multi-Agent | 唯一真正的全异步架构 |
| **需要人机协作** | AG2 | 原生支持三种 Human-in-the-loop |
| **需要可视化构建** | AG2 | AutoGen Studio 拖拽式 GUI |
| **需要生产级容错** | Open-Multi-Agent | Checkpoint + LoopDetector + 预算控制 |
| **Python 生态深度集成** | AG2 / Swarms | 原生 Python |
| **TypeScript/Node.js 生态** | Open-Multi-Agent | 原生 TypeScript |
| **快速原型验证** | Swarms | AgentRearrange DSL 最简洁 |
| **大规模 Agent 协作** | Open-Multi-Agent | Semaphore + AgentPool 并发控制 |

### 7.2 架构成熟度评分

| 维度 | AG2 | Swarms | Open-Multi-Agent |
|------|-----|--------|-------------------|
| **抽象设计** | 9/10 | 5/10 | 8/10 |
| **编排灵活性** | 8/10 | 9/10 | 7/10 |
| **并发模型** | 5/10 | 6/10 | 9/10 |
| **容错能力** | 6/10 | 5/10 | 9/10 |
| **记忆系统** | 4/10 | 4/10 | 9/10 |
| **工具生态** | 8/10 | 7/10 | 8/10 |
| **可扩展性** | 8/10 | 6/10 | 8/10 |
| **开发体验** | 7/10 | 8/10 | 7/10 |
| **生产就绪** | 8/10 | 7/10 | 7/10 |
| **综合** | **7/10** | **6.3/10** | **8/10** |

### 7.3 对 vssaros-agents-client 的参考价值

结合你们的项目（VSCode 二开、Agent Studio、Workflow Execution Service）：

1. **AG2 的 Handoff 体系**最值得参考——三层条件优先级 + 6 种 TransitionTarget 可以直接映射到你们的 Workflow 节点类型
2. **Open-Multi-Agent 的 DAG 调度**与你们的 ReactFlow 可视化高度契合——Coordinator 自动建 DAG 的思路可以增强你们的 Workflow 自动编排能力
3. **Open-Multi-Agent 的 AgentPool + Semaphore**并发控制对你们多工作区隔离有参考价值
4. **Swarms 的 AgentRearrange DSL**可以简化你们的 Workflow 定义——用字符串描述执行图比 JSON 配置更简洁

---

*本报告基于三个项目源码的深度分析，所有文件路径和代码片段均来自实际源码。*
