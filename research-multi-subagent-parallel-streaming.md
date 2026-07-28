# 开源「多 SubAgent 并行 + 聊天框流式输出并行内容」调研报告

> 调研日期：2026-07-20
> 目标：找出支持「多个 subagent 并行执行」，且「聊天框能以流式方式呈现这些并行内容」的开源项目，并提炼可复用的架构模式。

---

## 1. 调研结论（TL;DR）

把诉求拆成两半看：

- **A. 多 subagent 并行执行** —— 主流框架（LangGraph / AG2 / OpenAI Agents SDK / Agno / CrewAI）都已具备，差异在「并行是图分支 / group chat / team / handoff」等形态。
- **B. 聊天框流式输出并行内容** —— 这是真正的区分点。多数框架只是「并行算完再汇总流式」，而少数产品做到了「聊天框里每个 subagent 各占一个区块、同时流式吐字」。

**最贴合「两者兼得」的开源项目（按契合度排序）：**

| 排名 | 项目 | 一句话定位 | 并行形态 | 聊天流式 | 许可 |
|---|---|---|---|---|---|
| ★★★ | **swarm-ide / agent-wechat-k** | 微信式聊天 + 自组织 Agent 蜂群，流式 graph 实时展现协作 | 液态拓扑，任意动态创建/嵌套 sub-agent，真正并发 | 微信式对话流 + 流式 graph + tool-call 参数实时流式 | 开源 |
| ★★★ | **agent-network (anet)** | 多 Agent 组网协作 + Web Dashboard | MCP + SSE 中枢，任务 fan-out 并行 | Dashboard 含 Chat 面板 + 实时拓扑图 + 流式协作 | Apache 2.0 |
| ★★★ | **nexus-chat** | 多 LLM 同屏对比聊天 | 所有 agent 同时生成（parallel generation） | SSE 打字机流式，每个 agent 独立区块 + 单独 stop | 开源 |
| ★★☆ | **Agentia** | IM 式多 Agent 协作平台（字节挑战赛） | @mention fan-out 并行 / DAG 执行引擎 / 动态 sub-agent | 流式回复 + 取消生成，事件驱动 | 开源 |
| ★★☆ | **AllBeingsFuture** | Electron+React 多智能体工作台 | 主 Agent 拆任务 → 子 Agent 并行 → 结果回注 | 实时操作追踪时间线（读文件/命令/推理） | MIT |
| ★★☆ | **opencode-chat-webui** | 轻量静态多 Agent 群聊 UI | 多个 agent 并发「抢答」 | 并发对话，拟人化延迟模拟群聊 | 开源 |
| ★☆☆ | **WebMultiAgentChat** | 多角色 AI 群聊 Web APP | 轮流/随机/AI 指定下一位（偏**串行**轮流） | 群聊 UI，Markdown + 自动滚动 | 开源 |

**框架层（需要自己接聊天 UI，但并行+流式能力最成熟）：**
- **LangGraph**：Send API / 原生并行分支 → 汇总后流式（经典「fan-out + Synthesizer」模式）。
- **AG2 (AutoGen)**：group chat / handoff / `run_stream` + AG-UI 协议集成。
- **Agno (Phidata)**：Multi-Agent Teams（route/collaborate/coordinate）+ **自带 AgentOS UI + SSE/WebSocket 流式**。
- **OpenAI Agents SDK**：handoff 是串行交接；`agent.asTool()` / `parallel_tool_calls` + `run_streamed` 事件透传才是并行流式路径。
- **CrewAI**：多 crew 用 `asyncio.gather` 并行；`stream=True` 逐 chunk；CrewAI Flows 支持 fan-in/分支/流式。
- **Magentic-UI (微软)**：Magentic-One 多 agent team，实时 co-tasking UI，多任务会话并行（单任务内为顺序委派）。

**可视化工作流（带聊天 UI）：**
- **Dify**：Workflow 并行分支（`asyncio.gather`）+ 聊天 UI 流式输出 + 多 answer 节点优化体验，开箱即用、最易上手。

**协议层（让「聊天框流式并行」成为标准的关键）：**
- **AG-UI Protocol (CopilotKit)**：16 种实时事件类型的开放协议（TEXT_MESSAGE_CONTENT / TOOL_CALL_* / STATE_DELTA / RUN_* 等），HTTP/SSE，天然支持 multi-agent handoff 同通道流式。把「M 框架 × N 客户端」降为「M + N」。

---

## 2. 需求拆解：什么叫「聊天框流式输出并行内容」

实践中有两种形态，产品选型前要先定清楚：

- **形态一：并行算完、汇总后流式**（内部并行，UI 不交错）
  - 优点：UI 干净、不抖动、易实现。
  - 代表：LangGraph 的 Synthesizer、Dify 并行分支聚合、CrewAI 多 crew 汇总、Agno Teams 回传 leader。
- **形态二：聊天框内每 agent 独立流式卡片（真·并行可视）**
  - 优点：用户能实时看到每个 subagent 在干什么，透明度高。
  - 代表：nexus-chat（每模型一卡）、swarm-ide（流式 graph + 多 agent 并发）、agent-network（拓扑 + Chat）、opencode-chat-webui（群聊抢答）。

> 你们 saros-agents-client 现有的 **SubAgent 视觉折叠块（思考紫 / 工具橙 / 输出蓝）** + **IChatStreamDelta** 已经天然适合做「形态二」。本报告第 9 节给出具体落地建议。

---

## 3. 重点开源产品详解（自带聊天 UI + 并行 + 流式）

### 3.1 nexus-chat（HyxiaoGe/nexus-chat）
- **并行机制**：「Parallel Generation」——所有启用的 agent 同时响应同一条 prompt；每个 agent 有独立「重新生成 / 单独停止」控制。
- **流式聊天**：SSE 打字机式逐字；每个 agent 独立消息卡片；支持思维链可视化（DeepSeek R1 / o1）。
- **特点**：多 LLM 对比视角（GPT-4 / Claude / Gemini / DeepSeek），纯前端 + localStorage（隐私优先）。
- **局限**：偏「多模型同答」而非「subagent 协作拆解任务」；但「聊天框多卡并行流式」交互范式非常值得参考。
- 链接：https://github.com/HyxiaoGe/nexus-chat

### 3.2 swarm-ide / agent-wechat-k（yhyu13/swarm-ide）
- **并行机制**：极简原语 `create + send`；液态拓扑——运行时自演化，Agent 主动「雇佣」下属；支持**嵌套 Agent**、Agent 间通信、人与任意层级 sub-agent 通信、群聊模式。
- **流式聊天**：微信式聊天界面 + **流式 graph 实时展现协作状态** + 实时流式输出 tool-call 参数；树状多级对话（可像微信一样进入任意层级 agent 对话）；LLM history 面板（agent 不再黑箱）。
- **亮点**：明确对标 Kimi-Swarm / Claude Agent Team，且支持嵌套 + 可视化（后两者当时未开源/不支持嵌套）。对「聊天框里看并行蜂群」是迄今最完整的开源实现。
- 链接：https://github.com/yhyu13/swarm-ide

### 3.3 agent-network / anet（sleep2agi/agent-network）
- **并行机制**：CommHub 中枢（SSE push）+ 约 40 个 MCP 工具自动发现 + 互相派活（mesh）；4 种 Runtime（claude-code / claude-agent-sdk / codex-sdk / grok-build-acp）× 8 家 LLM。
- **流式聊天**：Web Dashboard（Next.js，:3000）含 7 大页：**Chat 面板（人+Agent 同台）**、实时节点拓扑图（mesh/ring 双视图，连线按消息频度分级）、任务流可视化（父子任务 chain）。
- **定位**：本地优先、零 Python 依赖的 npm 包，强调「多厂商不锁定 + 人机同台」。
- 链接：https://github.com/sleep2agi/agent-network

### 3.4 AllBeingsFuture（Electron + React + TS）
- **并行机制**：Supervisor 模式——主 Agent 拆任务 → 创建子 Agent → **并行执行** → 结果回注父会话；支持持久化子会话、消息调度队列、并发控制。
- **流式聊天**：实时时间线面板，清晰展示每个 Agent 在后台做了什么（读文件 / 执行命令 / 思考推理）；内置 64+ 技能模块。
- **定位**：国产，MIT，面向「单会话工具无法多 Agent 协作」的痛点。
- 链接：https://github.com/AllBeingsFuture/AllBeingsFuture

### 3.5 Agentia（字节跳动 AI 全栈挑战赛项目）
- **并行机制**：Orchestrator 自动拆解 → fan-out 分派给多 Agent 并行/串行；**事件驱动 DAG 执行引擎**；运行时动态创建 sub-agent；支持 `/map-reduce`（分片并行）、`/router-experts`、`/tree-executor` 三种编配策略。
- **流式聊天**：IM 式三栏（会话列表 | 聊天流 | 上下文侧栏）；@ 提及多 Agent 并行协作；**流式回复 + 取消生成**。
- **协议**：WebSocket + REST，统一 Agent 适配器（Mock / 多后端）。
- 链接：https://github.com/jasonfan0607/Agentia

### 3.6 opencode-chat-webui（Darkstarrd-dev）
- **并行机制**：多个 Agent **并发思考并回复**，带拟人化延迟，模拟「群聊抢答」。
- **流式聊天**：零构建纯原生 JS + Tailwind(CDN)；Agent 人设由后端 Markdown 文件定义；支持自动循环。
- **定位**：轻量前端，配 opencode 后端即可体验多 Agent 群聊流式。
- 链接：https://github.com/Darkstarrd-dev/opencode-chat-webui

### 3.7 WebMultiAgentChat（stamns）
- **并行机制**：多角色 AI 群聊；发言模式为**轮流固定 / 随机 / AI 指定下一位**（偏串行轮流，非严格并发）。
- **流式聊天**：群聊 UI，Markdown + 自动滚动 + 置底按钮；细粒度「视野/权限」控制；@角色名补全。
- **定位**：纯前端 localStorage，适合「多角色讨论」场景。
- 链接：https://github.com/stamns/WebMultiAgentChat

---

## 4. 主流多 Agent 框架（库层，并行 + 流式最成熟，需自建/接 UI）

### 4.1 LangGraph（⭐ 并行 + 流式的事实标准之一）
- **并行**：`Send` API 动态 fan-out；0.4+ 原生并行分支（`add_conditional_edges` 返回列表即同一 superstep 并发）。
- **流式**：`astream_events`（v2）捕获 ReAct 子图内部 LLM token；**关键坑**——`on_chat_model_stream` 同时含工具调用 token，需过滤 `tool_call_chunks` 否则前端收到乱码 JSON。
- **经典模式（见 planMultiAgent 实战）**：单 agent → 逐 token 流式；多 agent → `ainvoke` 收集完整结果 → **Synthesizer 统一汇总后再流式输出**（避免多路交错）。Synthesizer 失败自动降级为拼接。
- 链接：https://github.com/langchain-ai/langgraph ｜ 实战：https://github.com/sslovett/planMultiAgent

### 4.2 AG2 / AutoGen（Apache 2.0，原 AutoGen 社区分叉）
- **并行 + 协作**：group chat、`a_run_group_chat`、`DefaultPattern`、显式 handoff（`AgentNameTarget`）、上下文变量。
- **流式**：`team.run_stream` 产出 agent 名 / message delta / tool call 事件。
- **UI 集成**：官方博客给出 **AG-UI 协议集成**（AG2 + CopilotKit），`AGUIStream` 用 SSE 推送 TOOL_CALL_START→ARGS→END 及 STATE_SNAPSHOT；多 agent 流水线可用 ContextVariables + STATE_SNAPSHOT 模拟（原生多 agent 支持在演进中）。
- 链接：https://github.com/ag2ai/ag2

### 4.3 OpenAI Agents SDK
- **并行 vs 串行**：`handoff` = **串行交接**（同一时刻仅一个 active agent）；要做并行需 `agent.asTool()`（保持一个 active agent、把另一个当函数调用）或 `parallel_tool_calls`。
- **流式**：`run_streamed()` → `stream_events()`；**子 Agent 事件透传**到顶层（嵌套工作流从顶层即可拿到所有层级事件，无需逐层订阅）；`mcp_approval_requested` 支持 HITL 中断恢复。
- **注意**：Output Guardrail 在流式末尾才执行（token 已流出），需自己缓冲再渲染。
- 链接：https://github.com/openai/openai-agents-python

### 4.4 Agno（Phidata，Apache 2.0）
- **并行 + 协作**：Multi-Agent Teams，3 种模式（route / collaborate / coordinate），lead agent 委派 specialist sub-agent；**async streaming 让 sub-agent 并发并回流 team leader**。
- **流式聊天 UI**：自带 **AgentOS**（FastAPI，50+ 端点，**SSE + WebSocket 流式**，JWT RBAC，多租户隔离）+ 漂亮的 **Agent UI**；可直接 `AgentOS(agents=[...]).get_app()` 起一个能聊天的服务。
- **亮点**：无图无链，纯 Python；v2.6 起支持把 LangGraph/DSPy agent 包进 AgentOS。
- 链接：https://github.com/agno-agi/agno

### 4.5 CrewAI
- **并行**：`Process.parallel`（或独立 crew 用 `asyncio.gather` / `akickoff_for_each` 并行）；CrewAI Flows 用 `@start/@listen/@router` + `and_()` fan-in / `or_()` 先到先触发。
- **流式**：crew `stream=True` → `CrewStreamingOutput` 逐 chunk（含 `task_name / agent_role / chunk_type=TEXT|TOOL_CALL`）；Flows `stream=True` 监听 `LLMStreamChunkEvent` / `LLMThinkingChunkEvent` 转发到 UI。
- 链接：https://github.com/crewAIInc/crewAI

### 4.6 Magentic-UI（微软，研究原型）
- **架构**：基于 Magentic-One + AutoGen；Orchestrator / WebSurfer / Coder / FileSurfer 四 agent team。
- **流式聊天**：**co-tasking** 实时更新（计划步骤折叠 banner + 实时浏览器动画）；用户可随时暂停/接管；**多任务会话并行**（左侧会话列表切换，各会话独立状态）。
- **注意**：单任务内是顺序委派（Orchestrator 逐步决定由哪个 agent/用户完成），并非单聊天框内多 agent 并发吐字。
- 链接：https://github.com/microsoft/magentic-ui

---

## 5. 可视化工作流平台（带聊天 UI）

### 5.1 Dify
- **并行**：Workflow 中一个节点拉多条连接线到无依赖下游节点 → 自动归入「并行组」用 `asyncio.gather` 并发；迭代节点默认并行度 10。
- **流式聊天**：Chatflow 对 LLM 节点加「reply placeholder buffer」优化长等待体验；多 answer 节点优化流式；跨平台文案等场景官方实测并行加速明显。
- **定位**：No-code 拖拽，开箱即用，最易验证「聊天框 + 并行分支 + 流式」产品形态。
- 链接：https://github.com/langgenius/dify ｜ 并行实战：https://dify.ai/blog/cross-platform-copywriting-with-dify

---

## 6. 协议层：AG-UI Protocol（CopilotKit）—— 让并行流式成为标准

这是本次调研里**最值得关注的基础设施**，因为它直接定义了「聊天框怎么流式呈现并行 agent」的通信契约：

- **机制**：前端一次 HTTP POST → 监听 SSE 事件流；后端按 16 种事件类型（TEXT_MESSAGE_CONTENT、TOOL_CALL_START/END/RESULT、STATE_DELTA、RUN_STARTED/FINISHED、STEP_*、MESSAGE_ID 等）推送结构化 JSON。
- **多 agent**：multi-agent handoff 可在**同一通道**流式透传，前端按事件渲染——文本追加到聊天、工具结果就绪时展示、状态 diff 增量合并到表格/组件。
- **价值**：把「M 框架 × N 客户端」降为「M + N」；AG2 已集成，LangGraph 在跟进；CopilotKit 提供 React/Angular/Vue SDK + 预建 chat 组件 + Generative UI（agent 直接渲染你的 React 组件）。
- 链接：https://github.com/ag-ui-protocol/ag-ui ｜ https://copilotkit.ai

> 对你们的意义：你们已有的 `IChatStreamDelta` + `messageProtocol` 本质上是一个「私有版 AG-UI」。是否对齐其事件 schema，是可复用生态 vs 自造轮子的关键决策（见第 9 节）。

---

## 7. 关键架构模式（如何真正实现「并行 + 流式聊天」）

### 模式 A：并行 fan-out + 汇总后流式（避免交错）
- **做法**：Supervisor 把任务分发给 N 个并行 worker（LangGraph Send / Dify 并行组 / CrewAI 多 crew）；各自 `ainvoke` 收集完整结果；Synthesizer/聚合节点用 LLM 流式汇总。
- **适用**：答案需要整合、UI 不想抖动的场景。
- **坑**：`on_chat_model_stream` 需过滤 tool_call token；Synthesizer 失败要降级拼接。

### 模式 B：聊天框内每 agent 独立流式卡片（真·并行可视）
- **做法**：聊天流里为每个并行 subagent 分配独立消息区块（卡片/折叠块），各自持有自己的 SSE/流通道，同时吐字；支持单卡停止/重生成。
- **适用**：透明度优先、多视角对比（nexus-chat）、蜂群协作（swarm-ide）、群聊（opencode-chat-webui）。
- **实现要点**：前端用 key（agentId+runId）做消息桶隔离；后端用「单一 SSE 多路复用 + 事件带 source 标识」或「每 agent 独立流」皆可，前者更省连接。

### 模式 C：事件协议解耦（AG-UI）
- **做法**：后端只发结构化事件（文本增量 / 工具调用 / 状态 diff / 生命周期），前端纯消费渲染。多 agent 只是事件流里多了不同 source 的段。
- **适用**：任何严肃的多 agent 产品化——可换框架、可换 UI、可审计回放。

### 模式 D：蜂群 / 液态拓扑 + 流式 graph
- **做法**：极简原语（create + send），拓扑运行时自演化，嵌套 agent，人与任意层级通信；UI 用流式 graph 实时画协作链路 + 微信式对话。
- **适用**：任务结构动态、难以预设 DAG 的场景（swarm-ide）。

---

## 8. 与 saros-agents-client 的对照与建议

你们现有能力（来自项目记忆）：
- WebView：React + Zustand + ReactFlow + TailwindCSS + esbuild；Host↔WebView RPC 走 `messageProtocol` + `IChatStreamDelta`。
- Workflow Execution Service（`IWorkflowExecutionService`）+ `_sessionCache: Map<agentId:executionId, sessionId>` —— 已是 DAG 执行引擎，天生支持并行节点。
- SubAgent 视觉：3 类折叠子块（思考紫 / 工具橙 / 输出蓝），统一视觉语言。
- 关键约定 5：cancel 链路必须 abort 底层 stream（5 个 sendMessage 走 `_sendAndTrackStream`）。
- 关键约定 13/14：所有节点执行完必须存 `nodeState.output`，支持 node-level provider/model override。

**可立即借鉴的落点：**

1. **把「并行节点」升级为「并行流式卡片」**：你们 ReactFlow DAG + `_sessionCache` 已能跑并行节点；现在聊天流是「合并/顺序」呈现。可在聊天流里为每个并行 sub-agent 节点开一个独立折叠块（复用已有的思考/工具/输出三色块），各自消费 `IChatStreamDelta`，实现**模式 B（真·并行可视）**。

2. **IChatStreamDelta 对齐 AG-UI 事件 schema**：现有 delta 协议已接近 AG-UI。建议引入 `source`（agentId/nodeId）、`type`（TEXT / TOOL_CALL_START / TOOL_CALL_END / STATE_DELTA / RUN_STARTED / RUN_FINISHED）等字段，向前兼容现有 `suppressText`（约定 12）兜底渲染。这样未来可接 CopilotKit 等生态，也利于多路复用一个 SSE 通道（模式 C）。

3. **Synthesizer 兜底（模式 A）**：对「需要整合」的工作流，复用约定 13 的 `nodeState.output` 收集并行结果，加一个汇总节点做流式输出，并加约定 4 的 `console.warn` 防「按 session 误清桶」。

4. **取消/隔离（约定 5 + 模式 B）**：并行流式下 `_sendAndTrackStream` 的 cancel 要按 `(agentId, agentSessionId)` 精确 abort 对应流，避免取消一个 sub-agent 误伤其他并行流；参照 nexus-chat 的「单 agent 单独 stop」。

5. **参考 Agentia 的编配策略**：`/map-reduce`（分片并行）、`/router-experts`、`/tree-executor` 三种策略，可直接映射到你们 `IWorkflowExecutionService` 的编排能力，丰富并行模式。

---

## 9. 参考链接汇总

- nexus-chat：https://github.com/HyxiaoGe/nexus-chat
- swarm-ide / agent-wechat-k：https://github.com/yhyu13/swarm-ide
- agent-network (anet)：https://github.com/sleep2agi/agent-network
- AllBeingsFuture：https://github.com/AllBeingsFuture/AllBeingsFuture
- Agentia：https://github.com/jasonfan0607/Agentia
- opencode-chat-webui：https://github.com/Darkstarrd-dev/opencode-chat-webui
- WebMultiAgentChat：https://github.com/stamns/WebMultiAgentChat
- LangGraph：https://github.com/langchain-ai/langgraph ｜ planMultiAgent 实战：https://github.com/sslovett/planMultiAgent
- AG2 (AutoGen)：https://github.com/ag2ai/ag2 ｜ AG-UI 集成：https://docs.ag2.ai/latest/docs/blog/2026/02/17/AG2-AG-UI-Protocol/
- OpenAI Agents SDK：https://github.com/openai/openai-agents-python ｜ 流式解析：https://neodrop.ai/ja/post/WzdQwELuY2c
- Agno (Phidata)：https://github.com/agno-agi/agno
- CrewAI：https://github.com/crewAIInc/crewAI ｜ 流式：https://docs.crewai.com/pt-BR/learn/streaming-crew-execution
- Magentic-UI：https://github.com/microsoft/magentic-ui ｜ 微软博客：https://www.microsoft.com/en-us/research/blog/magentic-ui-an-experimental-human-centered-web-agent/
- Dify：https://github.com/langgenius/dify ｜ 并行实战：https://dify.ai/blog/cross-platform-copywriting-with-dify
- AG-UI Protocol (CopilotKit)：https://github.com/ag-ui-protocol/ag-ui ｜ https://copilotkit.ai ｜ 协议介绍：https://atai@copilotkit.ai/blog/ag-ui-protocol-bridging-agents-to-any-front-end
