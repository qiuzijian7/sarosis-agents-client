# Open-Multi-Agent vs Sarosis-Agents-Client 任务编排功能对比分析

> 对比两个项目的多智能体任务编排架构、实现方式和设计哲学

---

## 1. 项目定位与架构哲学

| 维度 | Open-Multi-Agent (OMA) | Sarosis-Agents-Client (SAC) |
|------|--------------------------|----------------------------|
| **项目性质** | 独立 TypeScript 多智能体编排框架（npm 包） | VSCode 二次开发项目的内置 Agent Studio 功能 |
| **架构哲学** | **Goal-First**（目标驱动）：描述目标，协调器自动分解任务 DAG | **Graph-First**（图驱动）：任务 DAG 由 AI 分解或通过 UI 手动构建 |
| **运行时依赖** | 仅 3 个（`@anthropic-ai/sdk`, `openai`, `zod`） | 依赖 VSCode 基础设施（DI、Event、FileService 等） |
| **部署形态** | Node.js 后端 / CLI / 集成到其他应用 | VSCode 扩展，运行在 VSCode 进程内 |
| **目标用户** | TypeScript 后端开发者，需要嵌入多智能体能力 | VSCode 开发者，需要 AI 辅助编程工作流 |

---

## 2. 任务编排核心架构对比

### 2.1 Open-Multi-Agent 架构

```
OpenMultiAgent (Orchestrator)
├── createTeam() / runTeam() / runTasks() / runAgent()
├── Team
│   ├── AgentConfig[]           # 智能体配置列表
│   ├── MessageBus             # 点对点 + 广播消息
│   ├── TaskQueue              # 依赖感知队列（拓扑排序）
│   └── SharedMemory           # 共享内存（可插拔后端）
├── Scheduler                 # 4种调度策略
├── AgentPool                 # 并发控制执行池
└── Agent + AgentRunner       # 对话循环引擎
```

**核心流程（`runTeam`）：**
1. 协调器（Coordinator）Agent 接收 `goal + roster`
2. 输出 JSON 任务数组（title, description, assignee, dependsOn）
3. `TaskQueue` 拓扑排序，独立任务并行执行
4. `Scheduler` 自动分配未指定执行人的任务
5. 每个结果写入 `SharedMemory` 供后续 Agent 使用
6. 协调器汇总最终结果

### 2.2 Sarosis-Agents-Client 架构

```
TaskOrchestrationService (VSCode Service)
├── TaskDecomposer           # 目标 → PlanTask[] 分解
├── AgentFactory              # 智能体评分、选择、创建
├── CanvasLayoutEngine        # DAG 深度画布自动布局
├── UnifiedSubAgentDispatch   # 统一子智能体调度
└── AgentDelegationService   # 委托任务管理

AgentOS (中间层)
├── 6个能力槽位: Model / Memory / Tool / Planning / Execution / Retrieval
└── BuiltinToolProvider      # 工具提供（含 delegate_task）
```

**核心流程（`executeWorkflow`）：**
1. 获取起始 Agent
2. 构建下游图（BFS 遍历）
3. 创建临时 OrchestrationPlan
4. 创建任务板项目
5. 执行根任务（`_executeTask`）
6. 标记完成 → 解除下游阻塞 → 递归执行

---

## 3. 任务分解策略对比

| 维度 | OMA | SAC |
|------|-----|-----|
| **分解触发** | `runTeam(team, goal)` 自动触发协调器分解 | `createPlan(goal)` 或 AI 自动分解 |
| **分解方式** | 协调器 Agent 调用 LLM 生成 JSON 任务数组 | `TaskDecomposer` 调用 AI 模型分解 |
| **人工干预** | `onPlanReady` 钩子审批计划后再执行 | `approvePlan()` 审批后开始执行 |
| **预演模式** | `runTeam(team, goal, { planOnly: true })` 只生成不执行 | 有对应的计划审批流程 |
| **分解策略** | 单一协调器模式 | 类型导向分解（coding→design→impl→test） |
| **简单目标短路** | `isSimpleGoal()` 判断，简单目标跳过协调器 | 无此机制 |

**OMA 优势**：协调器本身是一个 LLM Agent，可以"思考"如何分解任务，更灵活。

**SAC 优势**：分解策略类型化（coding/design/impl/test），更适合编程场景。

---

## 4. Agent 管理与调度对比

### 4.1 Agent 定义与生命周期

| 维度 | OMA | SAC |
|------|-----|-----|
| **Agent 定义** | `AgentConfig { name, model, systemPrompt, tools }` | `Employee { id, name, agentType, capabilities }` |
| **生命周期** | idle → running → completed/error | Idle → Busy → (任务完成) |
| **并发控制** | `AgentPool` 信号量控制（`maxConcurrency`） | `_runningAssignees` Map 计数 |
| **互斥锁** | 每个 Agent 有独立 mutex，防止并发运行 | 无明确 mutex，依赖计数 |
| **Agent 复用** | Pool 模式，Agent 实例可复用 | `AgentFactory` 创建/复用 |

### 4.2 调度策略

| 策略 | OMA | SAC |
|------|-----|-----|
| **round-robin** | ✅ 按索引均匀分配 | ❌ 无 |
| **least-busy** | ✅ 分配给进行中任务最少的 Agent | ❌ 无 |
| **capability-match** | ✅ 关键词亲和力评分 | ✅ 多维度评分（能力/负载/可用性） |
| **dependency-first** | ✅ 优先关键路径（阻塞最多依赖的任务） | ✅ 拓扑排序 + 优先级 |

**OMA 优势**：调度策略更丰富，特别是 `least-busy` 和 `round-robin` 适合不同场景。

**SAC 优势**：`capability-match` 是多维度评分，更精细；且集成了 VSCode 的 DI 系统。

---

## 5. 子智能体（Sub-Agent）支持对比

### 5.1 子智能体类型

| 类型 | OMA | SAC |
|------|-----|-----|
| **Explore** | ❌ 无此概念 | ✅ 只读代码探索（grep/glob/read） |
| **General** | ✅ 对应普通 Agent | ✅ 读写，但不能生成子智能体 |
| **Scout** | ❌ 无此概念 | ✅ 外部研究（克隆仓库/获取网页） |
| **委托机制** | `delegate_to_agent` 工具（需 opt-in） | `delegate_task` 工具（内置） |

### 5.2 子智能体执行

| 维度 | OMA | SAC |
|------|-----|-----|
| **创建方式** | Agent 调用 `delegate_to_agent` 工具 | Agent 调用 `delegate_task` 工具 / `UnifiedSubAgentDispatch.createSubAgent()` |
| **执行隔离** | `pool.runEphemeral()` 临时执行，不持有 Agent 锁 | `AgentOS.executeAgentTurn()` 独立执行 |
| **递归委托** | ✅ 支持（深度 guard，`maxDelegationDepth=3`） | ✅ 支持（General 类型 `canSpawnSubAgent: false` 限制） |
| **循环检测** | `LoopDetector` 检测 stuck agent loops | 无明确循环检测（依赖超时） |
| **预算控制** | 委托的 token 使用计入父预算 | `IterationBudget` 控制迭代次数 |

**OMA 优势**：`delegate_to_agent` 是可选工具，只在 `runTeam/runTasks` 时注入，设计更清晰；循环检测机制完善。

**SAC 优势**：子智能体类型化（Explore/General/Scout），权限控制更细粒度；`UnifiedSubAgentDispatch` 统一了三种调度路径。

---

## 6. 工具系统对比

### 6.1 内置工具

| 工具 | OMA | SAC |
|------|-----|-----|
| **文件读取** | `file_read` | `read_file` |
| **文件写入** | `file_write` | `write_file` |
| **文件编辑** | `file_edit` | `edit_file` |
| **Bash 执行** | `bash` | `run_command` |
| **代码搜索** | `grep`, `glob` | `grep`, `glob` |
| **Web 获取** | `web_fetch` | `web_fetch` |
| **委托任务** | `delegate_to_agent` | `delegate_task` |
| **MCP 集成** | ✅ `connectMCPTools()` | ✅ 通过 Agent OS 能力槽位 |

### 6.2 工具权限控制

| 维度 | OMA | SAC |
|------|-----|-----|
| **沙箱机制** | 文件系统工具限定在 `.agent-workspace` 内 | 无明确沙箱（依赖 VSCode 工作区） |
| **工具预设** | `readonly`, `readwrite`, `full` | 无预设，按需注册 |
| **允许/拒绝列表** | `allowedTools`, `disallowedTools` | `SUB_AGENT_PERMISSIONS` 按类型控制 |
| **Bash 沙箱** | ❌ `bash` 工具无沙箱 | ❌ 无 |

**OMA 优势**：工具预设和允许/拒绝列表更灵活；`bash` 工具明确标注"无沙箱"是已知风险。

**SAC 优势**：按子智能体类型（Explore/General/Scout）控制权限，设计更细粒度。

---

## 7. 依赖图与执行模型对比

### 7.1 依赖图管理

| 维度 | OMA | SAC |
|------|-----|-----|
| **图表示** | `TaskQueue` 内 `Map<taskId, Task>`，事件驱动 | `PlanTask[].dependencies`（数组存储父依赖） |
| **拓扑排序** | `TaskQueue` 内部维护，事件触发 | `_topologicalSort()` Kahn 算法 |
| **循环检测** | 插入依赖时 DFS 检测 | `_topologicalSort()` 检测未排序节点 |
| **自动解除阻塞** | `TaskQueue.complete()` → `unblockDependents()` | `_unblockDependentTasks()` |
| **级联失败** | `TaskQueue.fail()` → `cascadeFailure()` | 无明确级联失败（依赖任务保持 Pending） |

### 7.2 执行模型

| 维度 | OMA | SAC |
|------|-----|-----|
| **并发限制** | `maxConcurrency`（默认 5） | `maxConcurrency`（默认 3） |
| **超时监控** | 无内置超时（依赖 `AbortSignal`） | `_startTimeoutMonitor()` 每 30 秒检查（默认 5 分钟） |
| **自动重试** | `executeWithRetry()` 指数退避 | 无明确重试（依赖上层处理） |
| **取消支持** | `AbortSignal` 取消运行中任务 | 无明确取消机制 |

**OMA 优势**：级联失败处理完善；`AbortSignal` 取消机制标准；指数退避重试。

**SAC 优势**：超时监控内置；`CanvasLayoutEngine` 提供 DAG 可视化布局。

---

## 8. 可观测性（Observability）对比

| 维度 | OMA | SAC |
|------|-----|-----|
| **进度事件** | `onProgress` 回调（`agent_start`, `task_complete` 等） | `onDidChangePlan`, `onDidChangeTask` 事件 |
| **追踪 span** | `onTrace` 回调（LLM 调用、工具、任务） | 无等价机制（依赖 VSCode 日志） |
| **HTML 仪表板** | `renderTeamRunDashboard()` 渲染任务 DAG | `CanvasLayoutEngine` 画布可视化 |
| **Token 统计** | `TeamRunResult.tokenUsage` 汇总 | 无明确统计（依赖日志） |
| **敏感信息脱敏** | `redactSensitiveObject()` 自动脱敏 API Key | 无明确脱敏 |

**OMA 优势**：可观测性远超 SAC；HTML 仪表板可以回放完整运行；追踪 span 可以接入外部系统。

**SAC 优势**：与 VSCode UI 深度集成，任务板（TaskBoard）提供更好的交互体验。

---

## 9. 生产就绪功能对比

| 功能 | OMA | SAC |
|------|-----|-----|
| **Token 预算** | `maxTokenBudget` 硬上限 | `IterationBudget` 迭代次数控制 |
| **上下文策略** | `contextStrategy`（`sliding-window`/`summarize`/`compact`） | 无（依赖 Agent OS） |
| **循环检测** | `LoopDetector` + `onLoopDetected` | 无 |
| **工具输出截断** | `maxToolOutputChars` + `compressToolResults` | 无 |
| **人类介入** | `onPlanReady` + `onApproval` 钩子 | `approvePlan()` 审批流程 |
| **多模型支持** | 12+ 内置提供者 + OpenAI 兼容 | Knot AG-UI（可扩展 Agent OS） |
| **本地模型** | ✅ Ollama/vLLM/LM Studio | ❌ 无 |

**OMA 优势**：生产就绪功能全面；特别是上下文管理和循环检测，防止无限循环。

**SAC 优势**：与 VSCode 生态深度集成；Agent OS 中间层支持多种后端（Knot/OpenClaw/Direct）。

---

## 10. 集成与扩展对比

### 10.1 提供者（Provider）集成

| 维度 | OMA | SAC |
|------|-----|-----|
| **内置提供者** | 12+（Anthropic, OpenAI, Gemini, Bedrock, Grok, DeepSeek 等） | 1（Knot AG-UI），可通过 Agent OS 扩展 |
| **OpenAI 兼容** | ✅ `baseURL` + `apiKey` | 通过 Agent OS 能力槽位 |
| **Vercel AI SDK** | ✅ 可选集成（`@ai-sdk/*`） | ❌ 无 |
| **MCP 支持** | ✅ `connectMCPTools()` stdio MCP | ✅ 通过 Agent OS |

### 10.2 扩展方式

| 维度 | OMA | SAC |
|------|-----|-----|
| **自定义工具** | `defineTool()` + Zod 校验 | 注册到 `ToolRegistry` |
| **自定义内存后端** | 实现 `MemoryStore` 接口 | 通过 Agent OS 能力槽位 |
| **自定义调度器** | 无（内置 4 种策略） | 可扩展 `AgentFactory` |
| **插件系统** | 无（通过 npm 包集成） | VSCode 扩展系统 |

---

## 11. 优缺点总结

### 11.1 Open-Multi-Agent 优点

1. **Goal-First 设计**：描述目标即可，协调器自动分解，降低使用门槛
2. **生产就绪**：上下文管理、循环检测、Token 预算、指数退避重试等生产功能齐全
3. **可观测性强**：`onTrace` 追踪 + HTML 仪表板，调试体验好
4. **多提供者支持**：12+ 内置提供者，本地模型支持完善
5. **轻量依赖**：仅 3 个运行时依赖，适合嵌入任何 Node.js 应用
6. **TypeScript 原生**：类型安全，与 Vercel AI SDK 等生态兼容
7. **CLI 工具**：`oma` 二进制，适合 Shell/CI 场景

### 11.2 Open-Multi-Agent 缺点

1. **无 UI 界面**：纯代码/CLI，不适合需要可视化任务管理的场景
2. **编程场景弱**：工具集偏向通用，无代码理解能力（依赖外部工具）
3. **无版本控制集成**：不感知 Git 等版本控制系统
4. **沙箱不完整**：`bash` 工具无沙箱，有安全风险
5. **社区生态新**：2026-04-01 发布，生态还在建设

### 11.3 Sarosis-Agents-Client 优点

1. **VSCode 深度集成**：任务板、画布布局、代码编辑无缝衔接
2. **编程场景优化**：类型导向分解（coding/design/impl/test），更适合开发工作流
3. **子智能体类型化**：Explore/General/Scout 权限控制细粒度
4. **Agent OS 中间层**：6 个能力槽位，支持多种后端（Knot/OpenClaw/Direct）
5. **可视化布局**：`CanvasLayoutEngine` 自动布局 DAG，交互体验好
6. **统一调度**：`UnifiedSubAgentDispatch` 统一三种调度路径

### 11.4 Sarosis-Agents-Client 缺点

1. **依赖 VSCode**：无法独立部署，绑定 VSCode 生态
2. **生产功能缺失**：无循环检测、无上下文管理、无 Token 预算硬上限
3. **可观测性弱**：无追踪 span，无 HTML 仪表板，依赖日志
4. **调度策略少**：仅 `capability-match`，无 `round-robin`/`least-busy`
5. **级联失败缺失**：依赖任务失败时，被依赖任务保持 Pending 而非 Failed
6. **本地模型不支持**：仅 Knot AG-UI，无 Ollama 等本地模型支持

---

## 12. 设计哲学差异总结

| 维度 | OMA | SAC |
|------|-----|-----|
| **核心哲学** | Goal-First：描述目标，框架搞定一切 | Graph-First：任务 DAG 是核心抽象 |
| **目标场景** | 通用多智能体编排（研究、内容生成、数据分析等） | VSCode AI 辅助编程（代码生成、重构、测试等） |
| **用户角色** | 开发者嵌入框架到自己的应用 | 开发者在 VSCode 中使用 AI 功能 |
| **灵活性** | 高（多种模式、多种提供者、多种调度策略） | 中（绑定 VSCode，但 Agent OS 可扩展） |
| **易用性** | 中（需要写代码或 CLI） | 高（VSCode UI 交互） |

---

## 13. 借鉴建议

### 13.1 SAC 可以借鉴 OMA 的特性

1. **Goal-First 短路机制**：`isSimpleGoal()` 判断简单目标，跳过协调器
2. **循环检测**：`LoopDetector` 防止 Agent 无限循环
3. **上下文管理**：`contextStrategy`（`sliding-window`/`summarize`/`compact`）
4. **可观测性**：`onTrace` 追踪 + HTML 仪表板
5. **级联失败**：依赖任务失败时，级联标记下游为 Failed
6. **指数退避重试**：`executeWithRetry()` 自动重试失败任务
7. **更多调度策略**：`round-robin`、`least-busy`

### 13.2 OMA 可以借鉴 SAC 的特性

1. **子智能体类型化**：Explore/General/Scout 权限控制
2. **可视化布局**：`CanvasLayoutEngine` DAG 画布
3. **类型导向分解**：coding/design/impl/test 分解策略
4. **VSCode 集成**：任务板 UI 交互体验
5. **Agent OS 中间层**：能力槽位解耦后端

---

## 14. 结论

两个项目定位不同，各有优势：

- **OMA** 是一个**通用多智能体编排框架**，适合需要嵌入到 Node.js 应用的场景，生产功能齐全，但缺少 UI 和编程场景优化。

- **SAC** 是一个**VSCode AI 编程助手**，与 VSCode 深度集成，适合开发工作流，但生产功能和可观测性较弱。

**建议**：SAC 可以借鉴 OMA 的生产功能（循环检测、上下文管理、可观测性）和调度策略（round-robin、least-busy），提升稳定性和灵活性。同时保留自身的 VSCode 集成优势和子智能体类型化设计。

---

*生成时间：2026-05-30*
*对比版本：OMA main branch / SAC latest code*
