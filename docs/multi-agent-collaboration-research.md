# 多 Agent 协同：开源方案调研与本项目优化方案

> 分析日期：2026-09-11
> 分析范围：本项目画布编排引擎（`agentStudio/webview/src/features/workflowEditor/comfyHost/`）+ host 桥接（`agentStudio/browser/`）+ 脚本式 Dynamic Workflow
> 相关文档（避免重复，本篇聚焦**协同维度**）：
> - `multi-agent-context-comparison.md` —— 上下文管理与故障恢复横向对比（2026-06-12）
> - `workflow-agent-context-analysis.md` —— headless 路径上下文传递链路
> - `Agent-画布编排设计方案.md` —— 画布编排总体设计

---

## 一、本项目的协同现状（能力基线）

### 1.1 两套并行的多 Agent 执行体系

| 体系 | 入口 | 编排能力 | 与另一体系的关系 |
|---|---|---|---|
| **画布 DAG 引擎** | `comfyHost/workflowRun.ts` | 静态 DAG、串/并行、控制流节点、Subflow、Loop/Parallel 容器 | 独立 |
| **脚本式 Dynamic Workflow** | `browser/workflow/{workflowEngine,workflowExecutor}.ts` | JS worker 内 `agent()` / `parallel()` / `pipeline()` / `phase()`，支持**动态扇出** | 独立，节点类型同名但执行语义不同 |

> ⚠️ 二者**共享 `Saros.*` 节点类型但语义分裂**：画布走 `runAgentNode` → 子代理（`workflowChildPort`，只传 prompt）；headless 走 `workflowExecutionService._executeAgentNode` → 完整 agent turn（`agentChatService.sendMessage` + `contextScope`）。

### 1.2 协同相关的节点与能力

| 维度 | 现有节点/机制 | 实现要点 |
|---|---|---|
| 单个 agent | `Saros.Agent` / `Saros.Task`（共用 `runAgentNodeExecutor`） | 上游快照 → prompt 模板 → `runAgentNode` 子代理；`agentId` 决定 systemPrompt/tools |
| 能力调用 | `Saros.Skill` / `Saros.Tool` | 同为子代理通道，仅 prompt 前缀不同（"请使用技能 X" / "请调用工具 X"） |
| 控制流 | `Saros.IfElse` / `Switch` / `Merge` | 端口路由（`true`/`false`/`case-N`），`Merge` 有 `all`/`any`/`order` 三模式 |
| 迭代 | `Saros.Loop` / `Saros.Parallel` | body 存 `data.loopBody`，运行时递归 `runNodeOrStage`，**支持 body 内嵌 agent** |
| 组合 | `Saros.Subflow` | 设计期组合，**执行前 `flattenSubflows` 展平**（无运行时嵌套） |
| 人工介入 | `Saros.AskUser` | 图内**同步阻塞点**，暂停整条 DAG；支持动态参数表单 |
| 数据传递 | 快照 store + `SAROS_JSON` | **单向**：上游快照 → 下游 prompt 文本；`{{input}}` / `{{args.*}}` / `{{label.field}}` |
| 并发 | `parallelConcurrency=4`（画布）/ `maxConcurrentAgents=5`（脚本） | 画布 parallel 模式按层 barrier；ComfyUI 后端步骤单槽串行 |

### 1.3 已有但**未接入画布**的协同能力（重要机会点）

| 能力 | 现状位置 | 画布可用性 |
|---|---|---|
| `delegate_task`（1–5 只读子代理，`isolation_level: subagent\|peer`，`output_schema`） | `browser/providers/tool/delegationTools.ts` | ❌ 仅 agent 内部工具调用可用 |
| `new_agent`（持久化 agent 定义） | 同上 | ❌ |
| 黑板（blackboard） | `swarmService.postBlackboardUpdate` / `getBlackboard` | ❌ 仅 Swarm 看板体系 |
| `contextScope`（session / upstream-only / fresh） | `workflowExecutionService.ts` L1714+ | ❌ 仅 headless 路径 |
| Crew/Team 通信接口（`sendMessage`/`broadcast`/`delegateTask`） | `common/crewTeam.ts` | ❌ `crewTeamService.executeWorkflow` 是 **TODO 桩** |

### 1.4 能力边界（明确不支持）

- **动态委派**：画布 DAG 拓扑运行前固定，节点不能在运行期创建新节点/新 agent（动态扇出仅在脚本式体系）
- **Agent 间双向对话**：无消息总线，只有「上游快照 → prompt」单向注入
- **共享内存/黑板（画布）**：无跨 agent 共享上下文
- **子代理再派子代理**：`maxSpawnDepth` 默认 1
- **图级重试/检查点**：serial 首失败即停、parallel 首失败层即停，无重试无恢复点
- **Subflow 运行时嵌套**：执行前展平为单层

---

## 二、开源方案调研（2026）

### 2.1 三大多 Agent 框架

| 维度 | **LangGraph** | **CrewAI** | **AutoGen** |
|---|---|---|---|
| 范式 | 图状态机（FSM） | 角色化团队 | 会话优先 |
| 协同拓扑 | 显式图（任意有向图 + 循环） | sequential / hierarchical / consensus | 多 agent 对话轮次（自动 speaker selection） |
| 状态管理 | **显式 Channels + Checkpoint** | 隐式（任务输出传递） | 隐式（对话历史） |
| 通信机制 | **共享图状态**（状态键级） | 任务依赖编排 | **消息传递 / 对话轮次** |
| 动态路由 | `Send`（扇出）/ `Command`（显式跳转） | 有限 | 对话驱动 |
| 并发 | 分布式 + 异步 | 三种 process 模式 | 事件驱动 + 异步 + 分布式运行时 |
| 人在回路 | `interrupt` 节点（手动） | 有限 | **优秀**（对话式介入） |
| 状态/稳定性 | v1.0（2025-10），API 稳定承诺 | 发布频繁 | 正并入 **Microsoft Agent Framework** |
| Token 效率 | **最优** | 中 | **最差**（对话开销最大） |
| 调试 | **优秀**（LangSmith） | 良好 | 困难（对话轨迹） |
| 学习曲线 | 陡峭 | 中等 | 中等 |

### 2.2 轻量编排与生产实践

**OpenAI Swarm → Agents SDK**
- 核心抽象只有两个：**Agents**（instructions + tools）与 **Handoffs**（移交 = 返回另一个 agent 的函数）
- Agents SDK 生产化补充：**Guardrails**（输入/输出校验）、**Sessions**（自动会话历史）、**Tracing**（内置可视化追踪）
- 价值：证明「**极简抽象 + handoff**」足以表达大多数多 agent 协作；handoff 即「函数返回下一个 agent」——不需要图引擎

**Anthropic Multi-Agent Research System（2025-06 工程博客）**
- 架构：**Orchestrator–Worker 主从**——Opus 4 lead 规划派发，Sonnet 4 并行 subagent 执行
- 数据：内部研究评测比单 agent 提升 **+90.2%**；多 agent 消耗约 **15× token**；token 用量可解释约 80% 性能方差
- 要点：给 subagent 明确目标/输出格式/工具集/任务边界；按复杂度动态缩放投入；**3+ 工具并行**（研究时间最多缩短 90%）
- 启示：**编排框架并非必需**——关键在「清晰的委派契约 + 并行 + 评测」

### 2.3 互操作标准

| 标准 | 定位 | 现状 |
|---|---|---|
| **MCP**（Anthropic） | 模型 ↔ 工具/上下文 集成 | 事实标准 |
| **A2A**（Google，2025-04） | **Agent ↔ Agent** 通信 | Linux Foundation 项目，150+ 组织；v0.3 加 gRPC + 安全签名；即将落地 Azure AI Foundry / Copilot Studio |

二者**互补而非竞争**：MCP 管「agent 用什么工具」，A2A 管「agent 之间怎么协作」（AgentCard 能力发现 + task/sendMessage 消息语义）。

### 2.4 同形态可视化平台（可比性最强）

| 平台 | 协同强项 | 协同短板 |
|---|---|---|
| **n8n** | 400+ 集成、AI Agent 节点、原生可执行工作流 | 编排语义偏「自动化管线」，agent 间无共享状态 |
| **Dify** | LLM 应用/RAG/工作流一体、Agent 节点 + 工具编排 | 复杂分支/循环控制弱于图引擎 |
| **Langflow** | LangChain 组件可视化、快速原型 | 生产级调度/恢复能力弱 |

**共性**：可视化 DAG 平台普遍**擅长「管线编排」、弱于「agent 间协同」**（无共享黑板、无动态委派、无双向通信）——与本项目现状一致。

---

## 三、协同能力对比矩阵

以「多 agent 协同」的六个关键维度对比（★ = 强，○ = 有但弱，✗ = 无）：

| 维度 | 本项目画布 | 本项目脚本式 | LangGraph | CrewAI | AutoGen | Agents SDK | Anthropic 主从 | n8n/Dify |
|---|---|---|---|---|---|---|---|---|
| **静态编排** | ★ | ★ | ★ | ★ | ○ | ○ | ★ | ★ |
| **动态委派**（运行时 spawn） | ✗ | ★（扇出） | ○（Send 需预声明） | ○ | ★ | ★（handoff） | ★ | ✗ |
| **共享状态/黑板** | ✗ | ○ | ★（Channels） | ○（记忆） | ○（对话） | ○（Sessions） | ○ | ✗ |
| **Agent 间双向通信** | ✗ | ✗ | ○（状态回写） | ○（任务依赖） | ★（对话） | ○（handoff） | ✗ | ✗ |
| **人工介入** | ★（AskUser） | ✗ | ○（interrupt） | ○ | ★ | ○ | ○ | ○ |
| **恢复/检查点** | ✗ | ○ | ★（Checkpoint 时间旅行） | ○ | ○ | ○ | ○ | ○ |
| **互操作标准** | ✗ | ✗ | 跟进 A2A | 跟进 A2A | MCP | MCP | ✗ | ✗ |

**结论**：
- 本项目在**静态编排 + 可视化 + 人工介入**上不弱于主流方案（AskUser 的动态参数表单甚至优于多数框架）
- 短板集中在**动态委派、共享状态、双向通信、恢复**——正是「协同」而非「编排」的部分
- 本项目**已具备**动态委派与共享状态的**底层能力**（`delegate_task`、Swarm blackboard、`contextScope`），只是**未接入画布**——这是性价比最高的优化方向

---

## 四、优缺点分析

### 4.1 本项目优势（应保持）

1. **可视化 DAG + 强类型**：非开发者可构建多 agent 协作；TS 全链路类型检查
2. **双执行体系**：画布适合「确定性管线」，脚本式适合「动态扇出」——覆盖两种协同形态（代价见 4.2-5）
3. **人工介入最完善**：`Saros.AskUser` 支持多问题、动态参数表单、分支路由（多数框架仅支持单一确认）
4. **能力生态已就绪**：SkillRegistry（含 workflow-as-skill）、ToolRegistry、`delegate_task`、agent 记忆注入
5. **子代理基础设施强**：`UnifiedSubAgentDispatch` 已有预算控制、stallWatchdog、schema 重试、取消传播

### 4.2 核心差距（按协同影响排序）

| 差距 | 影响 | 现状证据 |
|---|---|---|
| **画布无共享黑板** | agent 之间只能单向传文本，无法「共同维护一份工作记忆」 | 画布子代理只收 prompt（`workflowChildPort.ts`）；blackboard 仅 Swarm |
| **画布无动态委派** | 无法「运行中按需拆任务」；只能在设计期画死拓扑 | DAG 运行前固定；动态扇出仅脚本式 |
| **无 agent 间双向通信** | 无法实现「辩论/协商/互审」类协作 | 无消息总线 |
| **双体系语义分裂** | 同名节点两套语义（画布=子代理单向 prompt；headless=完整 turn+contextScope），用户困惑、能力重复实现 | `runAgentNode` vs `_executeAgentNode` |
| **无图级恢复** | 长流程失败即全废（无检查点/重试） | serial 首失败即停 |
| **无互操作标准** | 无法与外部 agent（A2A）或异构框架协作 | 无 AgentCard/消息协议 |

---

## 五、优化方案

> 分层原则：**先接线已有能力（P0）→ 再补引擎缺口（P1）→ 最后做互操作（P2）**。
> 明确不引入外部编排框架：Anthropic 实践已证明编排框架非必需，本项目画布本身即编排层，引入将造成双引擎。

### P0：接线已有能力（低成本、见效快）

#### P0-1 画布共享黑板节点 `Saros.Blackboard`
- **设计**：新增节点，提供 `write` / `read` / `summary` 三种模式；底层复用 `swarmService.postBlackboardUpdate` / `getBlackboard` 的 KV 语义（换 namespace 避免污染 Swarm）
- **协同价值**：填补「画布无共享内存」——多个 agent 节点可读写同一份工作记忆，下游 agent 通过 `summary` 注入（对齐 CrewAI 记忆 + oma SharedMemory）
- **落点**：`comfyHost/registrySaros.ts`（spec）+ `comfyHost/graphNodeExecutors.ts`（executor）+ 注入 RPC（`WorkflowEditorPanel` → host）
- **注意**：注入下游时应走**摘要**而非全量（避免上下文爆炸，参考 `multi-agent-context-comparison.md` §6.1 按需上下文原则）

#### P0-2 委派节点 `Saros.Delegate`（**最高性价比**）
- **设计**：把已有 `delegate_task` 暴露为画布节点——widget：`agents`（1–5，可选 `code-explorer`/`researcher`/`data`）、`isolationLevel`（subagent/peer）、`outputSchema`（可选）；上游 prompt 作为 task
- **协同价值**：一步获得「单节点扇出多个只读子代理」能力，无需改引擎（能力已存在于 `delegationTools.ts`）
- **落点**：spec + executor（调 `delegate_task` 的 host RPC）+ palette 归入 Provider/编排组
- **限制**：保持只读子代理语义（写操作仍需 AskUser 确认）

#### P0-3 画布 Agent 节点接入 `contextScope`
- **设计**：`Saros.Agent` 加 `contextScope` widget（`session` / `upstream-only` / `fresh`），与 headless 路径语义对齐
- **协同价值**：让多 agent 协作时可选择「共享会话」或「隔离上下文」——同一画布上可混用（如「评审 agent 用 fresh 保持独立判断」）
- **落点**：`registrySaros.ts`（widget）+ `runAgentNodeExecutor`（透传 payload）+ `workflowChildPort.ts`（按 scope 决定是否带会话历史）
- **备注**：headless 已实现（`workflowExecutionService.ts` L1714+），此处是**语义对齐**而非新造

#### P0-4 迭代护栏
- **设计**：`Saros.Loop` / `Parallel` 加 `maxIterations`（默认 50）+ 嵌套深度上限；画布路径 `maxSpawnDepth` 显式声明为 1 并在 UI 提示
- **协同价值**：多 agent 协同的最大运行风险是失控（无限迭代/无限 spawn）；护栏是生产化前提
- **落点**：`graphNodeExecutors.ts` `runLoopNodeExecutor`（迭代计数守卫）+ `unifiedSubAgentDispatch.ts`（深度检查暴露配置）

### P1：补齐引擎缺口（能力跃迁）

#### P1-1 动态委派：`Saros.Supervisor`（对齐 Anthropic orchestrator-worker）
- **设计**：新增「主管」节点——输入任务描述 + 可用 agent 列表，运行时由 LLM 决策**动态 spawn** 若干子 agent（数量/角色/子任务由模型决定），汇总结果
- **参考**：OpenAI handoffs（handoff = 返回下一个 agent）+ Anthropic lead/subagent 契约（明确目标/输出格式/工具集/边界）
- **前提**：放开画布路径 `maxSpawnDepth`（1 → 2，需配套预算护栏）；子代理注册表复用 `new_agent`
- **协同价值**：从「设计期画死拓扑」升级为「运行期自适应编排」——这是与主流框架拉平的关键一步
- **风险**：token 成本（Anthropic 实测 15×）；必须配套预算上限 + 结果 schema 约束

#### P1-2 有状态循环（对齐 LangGraph 循环 + 状态回写）
- **设计**：`Saros.Loop` 增加 `while` 语义——`condition`（表达式或 LLM 判定）+ `stateKeys`（迭代间回写的状态键）+ `maxIterations`；退出条件满足或达上限即停
- **协同价值**：支持「多 agent 迭代改进」（生成 → 评审 → 修订）这类收敛型协作
- **落点**：`runLoopNodeExecutor` 扩展（当前仅 `items` 逐项迭代）

#### P1-3 双体系统一
- **设计**：脚本式 workflow 与画布共用节点执行器——脚本内可 `runNode(nodeId)` 复用画布节点；画布可将脚本节点作为 Subflow 嵌入
- **协同价值**：消除「同名节点两套语义」；用户按任务形态选入口而非按能力选
- **落点**：抽 `INodeExecutorRegistry` 中间层，`runNodeOrStage` 与 `workflowExecutor` 共用

#### P1-4 协同可观测性
- **设计**：运行 trace 树（节点 → 子代理 → 工具调用）+ token/成本归因 + 委派关系图
- **参考**：Agents SDK Tracing、LangSmith
- **协同价值**：多 agent 调试的核心痛点（AutoGen 的「对话轨迹难调试」正是反面教材）
- **落点**：`cardState.ts` 扩展为树形 + 任务进度面板展示

### P2：互操作与生态（长期）

#### P2-1 A2A 协议接入
- **设计**：把画布/agent 暴露为 A2A agent——发布 **AgentCard**（能力/输入输出 schema）、实现 `task/sendMessage` 端点；同时支持作为 A2A **client** 调用外部 agent
- **价值**：跨进程/跨厂商 agent 协作；与已有 MCP（工具侧）形成完整互操作层
- **备注**：A2A 已是 Linux Foundation 项目（150+ 组织），建议按互操作思路设计而非自造协议

#### P2-2 Crew/Team 落地
- **设计**：实现 `crewTeamService.executeWorkflow`（当前 TODO 桩），支持 hierarchical / consensus 编排模式（对齐 CrewAI）
- **备注**：接口已齐备（`common/crewTeam.ts` 的 `sendMessage`/`broadcast`/`delegateTask`），落地成本主要在编排语义

#### P2-3 检查点与时间旅行
- 对齐 LangGraph Checkpoint（从任意节点恢复重放）
- **注**：`multi-agent-context-comparison.md` §6.8 已提此建议，此处仅从「协同」视角强调——多 agent 长流程的失败代价随 agent 数指数上升，恢复能力的边际价值更高

---

## 六、优先级路线图

```
Phase 1（P0，接线已有能力，低风险）
  ├─ P0-2 Saros.Delegate 委派节点        ← 最高性价比（能力已存在，仅缺节点包装）
  ├─ P0-1 Saros.Blackboard 共享黑板      ← 填补「无共享状态」
  ├─ P0-3 Agent 节点 contextScope 对齐   ← 语义统一（headless 已实现）
  └─ P0-4 迭代/spawn 护栏                ← 生产化前提

Phase 2（P1，引擎缺口）
  ├─ P1-1 Saros.Supervisor 动态委派      ← 与主流框架拉平的关键
  ├─ P1-2 有状态循环（while + 状态回写）
  ├─ P1-3 双体系统一（共用执行器）
  └─ P1-4 协同可观测性（trace 树 + 成本归因）

Phase 3（P2，互操作）
  ├─ P2-1 A2A 协议接入（AgentCard + task）
  ├─ P2-2 Crew/Team 编排落地
  └─ P2-3 检查点 / 时间旅行
```

## 七、取舍与风险

1. **不引入外部编排框架**：本项目画布已是编排层；引入 LangGraph/CrewAI 会造成双引擎与语义分裂。借鉴**设计思想**（Channels 共享状态、handoff、orchestrator-worker）而非引入运行时。
2. **避免 AutoGen 式「对话优先」**：token 消耗最高（约 15×）且轨迹不可预测；除非明确需要「agent 辩论」场景，否则坚持「显式状态 + 单向数据流 + 按需上下文」。
3. **动态委派必须配预算护栏**：Anthropic 实测多 agent 15× token；`Saros.Supervisor` 需强制 `maxAgents` / `tokenBudget` / 输出 schema。
4. **共享状态优先注入摘要**：黑板全量注入会重演「全量历史捆绑」问题（见 `multi-agent-context-comparison.md` §2.3），默认注入 `summary`。
5. **互操作以 A2A 为准**：不要自造 agent 通信协议；MCP（工具）+ A2A（agent 间）已是行业事实分层。

---

## 八、关键代码位置速查

| 关注点 | 位置 |
|---|---|
| 画布执行引擎（serial/parallel） | `comfyHost/workflowRun.ts` `runGraphExecution` / `runGraphExecutionParallel` |
| 拓扑规划 / 分支路由 / Start 作用域 | `comfyHost/executionGraph.ts` |
| Agent/Skill/Tool/AskUser 执行器 | `comfyHost/graphNodeExecutors.ts` |
| Loop/Parallel 容器执行 | `comfyHost/graphNodeExecutors.ts` `runLoopNodeExecutor` |
| Subflow 展平 | `comfyHost/subflow.ts` `flattenSubflows` |
| 节点 spec 注册 | `comfyHost/registrySaros.ts` / `registry.ts` |
| 子代理派发（预算/深度/看门狗） | `common/unifiedSubAgentDispatch.ts` |
| 委派工具（可复用于画布节点） | `browser/providers/tool/delegationTools.ts` |
| 画布 → 子代理桥 | `browser/providers/tool/workflowChildPort.ts` |
| 黑板（Swarm） | `common/swarmService.ts` + `browser/providers/swarm/swarmService.ts` |
| Crew/Team 接口（TODO 桩） | `common/crewTeam.ts` + `browser/crewTeamService.ts` |
| headless 执行 + contextScope | `browser/workflowExecutionService.ts` |
| 脚本式 Dynamic Workflow | `browser/workflow/{workflowEngine,workflowExecutor}.ts` |
| 画布运行入口 | `webview/src/features/workflowEditor/WorkflowEditorPanel.tsx` L1332+ |
