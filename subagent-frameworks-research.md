# 支持 SubAgent 调用的开源 Agent 项目调研

> 调研时间：2026年7月  
> 核心关注：哪些开源项目支持 subagent（子代理）调用，以及它们的调用机制差异

---

## 一、SubAgent 调用机制分类

在深入具体项目前，先明确目前开源社区中 subagent 调用的**四种核心机制**——不同项目本质上是这四种机制的组合实现：

| 机制 | 核心思想 | 控制权变化 | 上下文隔离 |
|------|---------|-----------|-----------|
| **A. Handoff 转交** | 主 agent 把控制权交给子 agent，子 agent 接管对话 | 完全转移 | 共享对话历史 |
| **B. Tool 包装** | 子 agent 被包装成工具，主 agent 像调用工具一样调用 | 不转移，等待返回 | 完全隔离 |
| **C. 嵌套图/子图** | 子 agent 是独立的状态机/子图，作为节点嵌入主图 | 图内转移 | 独立状态空间 |
| **D. Manager-Worker** | 专门的管理 agent 负责分解任务并分派给 worker agent | 动态分配 | 可配置 |

---

## 二、项目详细分析

### 1. LangGraph（LangChain 生态）— Subgraph 机制

**机制类型：C. 嵌套图/子图 + D. Manager-Worker**

LangGraph 的 subagent 通过 **Subgraph**（子图）实现：每个子 agent 是一个独立的 `StateGraph`，作为节点嵌入主图。

**核心特性：**
- **三种持久化模式**：
  - Per-thread subagents：每个子 agent 有独立 thread_id，跨调用累积记忆
  - Per-invocation subagents：每次调用独立，无累积
  - Stateless：无 checkpoint，纯函数式调用
- **命名空间隔离**：每个子图有唯一 namespace，避免状态冲突
- **interrupt 支持**：子图内的工具调用可触发 `interrupt()`，支持人机交互
- **Supervisor 模式**：主 agent 是 LLM 驱动的路由器，动态决定下一步交给哪个 worker

**GitHub：** https://github.com/langchain-ai/langgraph  
**Stars：** ~18k

**优点：**
- 控制粒度最细，支持条件分支、循环、并行
- 子图完全独立，状态隔离干净
- 支持 Human-in-the-Loop（子图内可 interrupt）

**缺点：**
- 学习曲线陡峭，StateGraph 概念复杂
- 代码量大，简单场景过重

---

### 2. LangChain DeepAgents — Task 工具委托

**机制类型：B. Tool 包装 + 规划**

LangChain 2025 年推出的新框架，专为长周期任务设计，三大核心能力之一就是**子 agent 委托**。

**核心特性：**
- **`task` 工具**：主 agent 通过调用 `task(description, subagent_type)` 工具将子任务委托给专门的子 agent
- **独立上下文窗口**：每个子 agent 有自己的上下文窗口和工具集
- **文件系统访问**：`write_todos`/`read_todos` 任务规划 + 文件读写工具
- **基于 LangGraph**：`create_deep_agent` 返回编译后的 LangGraph StateGraph

**GitHub：** https://github.com/langchain-ai/deepagents

**优点：**
- 专为长任务设计，解决上下文窗口限制
- 大型工具调用结果自动保存到文件，避免消耗上下文
- 模块化中间件设计，可扩展

**缺点：**
- 相对较新，生态待完善
- 依赖 LangGraph 全家桶

---

### 3. Google ADK（Agent Development Kit）— Agent Transfer + AgentTool

**机制类型：A. Handoff 转交 + B. Tool 包装（双模式）**

Google 2025 年开源的多 agent 框架，提供**两种 subagent 调用方式**，是最灵活的设计之一。

**核心特性：**

**方式一：LLM-Driven Delegation（Agent Transfer）**
- 主 agent 的 LLM 生成 `transfer_to_agent(agent_name='target')` 函数调用
- AutoFlow 拦截该调用，用 `root_agent.find_agent()` 找到目标 agent
- 更新 InvocationContext，切换执行焦点
- **控制权完全转移**，类似客服转接

**方式二：Explicit Invocation（AgentTool）**
- 把子 agent 包装成 `AgentTool`
- 主 agent 像调用工具一样调用，获得返回结果
- **控制权不转移**，强约束、可观测

**关键设计：**
- 父 agent 的 `sub_agents` 参数声明子 agent
- 子 agent 的 `description` 决定路由（LLM 根据 description 判断转交谁）
- 默认允许 sibling agent 间互相 transfer
- Session State 在所有 agent 间共享

**GitHub：** https://github.com/google/adk-python  
**Stars：** ~20k

**优点：**
- 双模式设计，覆盖"转交"和"调用"两种需求
- LLM 自动路由，无需硬编码工作流
- 企业级部署支持（Vertex Agent Engine）

**缺点：**
- Google Cloud 倾向
- A2A 协议虽好但增加复杂度

---

### 4. OpenAI Agents SDK — Handoff 机制

**机制类型：A. Handoff 转交**

OpenAI 2025年3月发布的生产级框架，核心原语就是 **handoff**。

**核心特性：**
- **Handoff 原语**：一个 agent 显式地将控制权转移给另一个 agent
- 对话上下文在 transfer 时跨 seam 传递
- 围绕 handoff 构建 agents、tools、guardrails、sessions
- 内置 tracing dashboard
- 有 TypeScript 移植版（openai-agents-js）

**GitHub：** https://github.com/openai/openai-agents-python  
**Stars：** ~27k

**优点：**
- 极简设计，"少抽象、快上手"
- OpenAI 生态深度集成
- 生产级 tracing

**缺点：**
- 供应商锁定（tuned for OpenAI Responses API）
- 只有 handoff 模式，无 tool 包装模式

---

### 5. AG2（原 AutoGen）— NestedChatTarget

**机制类型：C. 嵌套 + A. Handoff**

AG2 的 subagent 通过 **NestedChatTarget** 和 **Handoff 体系**实现。

**核心特性：**
- **NestedChatTarget**：6 种 TransitionTarget 之一，支持嵌套对话
- **三层条件优先级**：
  1. `OnContextCondition`（Python 谓词，无需 LLM）
  2. `OnCondition`（LLM 评估，编译为 `transfer_to_<target>` 工具）
  3. `after_works`（兜底）
- Agent 可将子任务作为嵌套对话处理，结果返回主流程
- 分布式运行时（beta）支持跨进程 subagent

**GitHub：** https://github.com/ag2ai/ag2  
**Stars：** ~55k

**优点：**
- Handoff 体系最灵活（三层条件 + 6 种 target）
- 支持嵌套对话和分布式 subagent
- 社区成熟

**缺点：**
- 伪异步（线程跑同步逻辑）
- 新旧架构并存增加认知负担

---

### 6. CrewAI — Hierarchical Process

**机制类型：D. Manager-Worker**

CrewAI 通过 **hierarchical process** 实现 subagent 调用。

**核心特性：**
- **Manager Agent**：在 hierarchical 模式下，自动创建一个 Manager Agent 负责任务分配
- Manager 动态决定将哪个 Task 分配给哪个 Agent
- 支持 `delegate` 工具：Agent 可主动将子任务委派给其他 Agent
- Agent 间通过 `SharedContext` 共享状态

**GitHub：** https://github.com/crewAIInc/crewAI  
**Stars：** ~36k

**优点：**
- 上手门槛最低
- 角色化设计直观（role + goal + backstory）
- hierarchical 模式自动任务分配

**缺点：**
- 复杂状态管理弱
- 定制化能力有限

---

### 7. Pydantic AI — Agent Delegation

**机制类型：B. Tool 包装**

Pydantic AI 的 subagent 通过**把 Agent 包装成工具**实现。

**核心特性：**
- **Agent Delegation**：将子 Agent 注册为主 Agent 的 tool
- Router Agent 模式：主 Agent 判断意图，调用对应专家 Agent
- 类型安全（Pydantic 验证每个边界）
- Provider 无关（~20 个 provider）

**GitHub：** https://github.com/pydantic/pydantic-ai  
**Stars：** ~18k

**优点：**
- 类型安全最强
- Provider 无关
- 设计简洁

**缺点：**
- 只有 tool 包装模式，无 handoff
- 需第三方扩展增强 subagent 能力

---

### 8. subagents-pydantic-ai（第三方扩展）

**机制类型：B. Tool 包装 + D. Manager-Worker**

为 Pydantic AI 添加完整的多 agent 委托能力。

**核心特性：**
- **三种执行模式**：sync（阻塞）/ async（后台）/ auto（智能选择）
- **嵌套 subagent**：subagent 可生成自己的 subagent
- **运行时创建 agent**：`DynamicAgentRegistry` 支持动态创建专家 agent
- **工具集工厂**：为 subagent 动态配置 toolsets

**GitHub：** https://github.com/samjaninf/subagents-pydantic-ai

**优点：**
- 补全了 Pydantic AI 的 subagent 能力
- 嵌套 subagent 支持深层委托
- 动态 agent 创建灵活

**缺点：**
- 第三方维护，依赖 Pydantic AI 版本兼容性

---

### 9. SmolAgents（HuggingFace）— Managed Agents

**机制类型：D. Manager-Worker**

HuggingFace 的轻量级 agent 框架，通过 **managed_agents** 实现 subagent。

**核心特性：**
- **Manager Agent + Managed Agent** 模式
- Manager 只负责协调，不直接执行
- Managed Agent 有独立工具集和记忆
- 1.8.0 版本后简化：移除 `ManagedAgent` 类，直接在 `CodeAgent` 构造函数中通过 `managed_agents` 参数声明
- 结构化返回：subagent 必须返回 `### 1. Task outcome (short version)` 等结构化格式

**GitHub：** https://github.com/huggingface/smolagents

**优点：**
- API 最简洁（一个参数声明 subagent）
- 记忆隔离（每个 agent 独立工具和记忆）
- HuggingFace 生态集成

**缺点：**
- 只有 Manager-Worker 模式
- 功能相对基础

---

### 10. Maestro — 指挥家-乐团架构

**机制类型：D. Manager-Worker + B. Tool 包装**

专为 LLM 智能编排子代理设计的开源框架。

**核心特性：**
- **三层智能协作**：
  - 指挥家模型（如 Claude Opus）：任务分解与全局协调
  - 子代理模型（如 Claude Haiku）：执行具体子任务
  - 精炼模型：整合子任务结果
- **递归分解**：复杂目标智能递归分解
- **共享执行记忆**：子代理间上下文感知
- **多模型引擎**：Anthropic/OpenAI/Gemini/Ollama/Groq

**GitHub：** https://github.com/Doriandarko/maestro

**优点：**
- 三层架构职责清晰
- 多模型混搭（强模型协调，弱模型执行，降成本）
- 递归分解能力强

**缺点：**
- 功能较单一，专注任务分解场景
- 代码量小，生产级能力待验证

---

### 11. Langroid — Actor 模式

**机制类型：D. Manager-Worker + B. Tool 包装**

基于 Actor 模式的多 agent 框架。

**核心特性：**
- **Actor 模式**：每个 Agent 是独立 Actor，通过消息通信
- **主控 Agent 分派**：主 Agent 将子任务分派给子 Agent
- **嵌套调用栈记录**：调用路径附加在消息元数据中
- **响应合并策略**：直接返回 / 二次加工 / 多结果融合
- **上下文隔离与共享可控**：默认独立，可配置共享

**GitHub：** https://github.com/langroid/langroid

**优点：**
- Actor 模式天然支持并发
- 嵌套调用栈可追溯
- 响应合并策略灵活

**缺点：**
- 相对小众
- Actor 模式增加理解成本

---

### 12. 腾讯 Cognitive Kernel-Pro — 双层多模块架构

**机制类型：D. Manager-Worker**

腾讯 AI Lab 的 Deep Research 智能体框架。

**核心特性：**
- **主智能体 + 子智能体**双层架构
- 主智能体负责统筹，将复杂任务分解并分派给子智能体
- 主智能体自身不具备网络浏览、文件处理等专项能力
- **两类子智能体**：
  - 网络智能体：基于 playwright 自主网页浏览
  - 文件智能体：处理图像等多种文件类型
- 完全开源，减少对付费 API 的依赖

**GitHub：** https://github.com/Tencent/CognitiveKernel-Pro

**优点：**
- 完全开源免费
- 8B 模型版本超越 WebDancer、WebSailor
- 子智能体专业能力强

**缺点：**
- 专注 Deep Research 场景
- 子智能体类型固定

---

### 13. Claude Code / OpenAI Codex CLI — Subagent 派生

**机制类型：B. Tool 包装（Agent 作为 CLI 工具）**

Claude Code 和 Codex CLI 都支持通过配置文件定义 subagent，由主 agent 在运行时调用。

**Claude Code：**
- 通过 `.claude/agents/` 目录定义 subagent
- 每个 subagent 有独立的 system prompt 和工具权限
- 主 agent 可通过 `Task` 工具委派子任务
- 生态有 `awesome-claude-code-subagents` 集合

**OpenAI Codex CLI：**
- 通过 `~/.codex/agents/` 或 `.codex/agents/` 目录定义
- 使用 `.toml` 配置文件
- 有 136+ 即用型 subagent 库（`awesome-codex-subagents`）
- 支持 `codex exec --profile <agent>` 保持隔离状态

**优点：**
- 与开发工作流深度集成
- 配置文件式定义，简单直接
- 生态丰富（大量预置 subagent）

**缺点：**
- 绑定特定 CLI 工具
- 非通用框架

---

### 14. CopilotKit — Sub-Agents

**机制类型：C. 嵌套图（基于 LangGraph）**

基于 LangGraph 的全栈多 agent 框架，提供可视化的 delegation log。

**核心特性：**
- Supervisor LLM 编排多个专业 sub-agent
- Sub-agent 作为 tool 暴露给 supervisor
- **Delegation Log**：每次委派追加到共享 state 的 `delegations` 列表
- UI 实时渲染委派日志
- 子 agent 有独立 system prompt，不共享记忆和工具

**GitHub：** https://github.com/CopilotKit/CopilotKit

**优点：**
- 全栈方案（后端 + 前端 UI）
- 委派日志可视化
- 基于 LangGraph，继承其能力

**缺点：**
- 依赖 LangGraph 生态
- 全栈方案较重

---

## 三、横向对比总表

| 项目 | 机制类型 | 控制权转移 | 上下文隔离 | 动态创建 | 嵌套深度 | 语言 | Stars |
|------|---------|-----------|-----------|---------|---------|------|-------|
| **LangGraph** | C+D | 图内转移 | 独立状态空间 | ✅ | 无限制 | Python/TS | ~18k |
| **DeepAgents** | B | 不转移 | 完全隔离 | ✅ | 无限制 | Python | 新 |
| **Google ADK** | A+B | 双模式 | 可配置 | ✅ | 无限制 | Python | ~20k |
| **OpenAI Agents SDK** | A | 完全转移 | 共享历史 | ❌ | 无限制 | Python/TS | ~27k |
| **AG2/AutoGen** | C+A | 嵌套+转移 | 可配置 | ✅ | 无限制 | Python | ~55k |
| **CrewAI** | D | 动态分配 | SharedContext | ❌ | 有限 | Python | ~36k |
| **Pydantic AI** | B | 不转移 | 完全隔离 | ❌ | 无限制 | Python | ~18k |
| **subagents-pydantic-ai** | B+D | 不转移 | 完全隔离 | ✅ | 嵌套 | Python | 新 |
| **SmolAgents** | D | Manager 分配 | 独立记忆 | ❌ | 1层 | Python | 活跃 |
| **Maestro** | D+B | 不转移 | 共享记忆 | ❌ | 递归 | Python | 中 |
| **Langroid** | D+B | 消息通信 | 可配置 | ✅ | 嵌套 | Python | 中 |
| **Cognitive Kernel-Pro** | D | 主智能体分派 | 独立 | ❌ | 1层 | Python | 中 |
| **Claude Code** | B | 不转移 | 独立会话 | ❌ | 1层 | Config | 闭源 |
| **Codex CLI** | B | 不转移 | 独立 profile | ❌ | 1层 | Config | 开源 |
| **CopilotKit** | C | 图内转移 | 独立 | ✅ | 无限制 | TS | 活跃 |

---

## 四、SubAgent 调用机制深度对比

### 4.1 Handoff 转交 vs Tool 包装

| 维度 | Handoff 转交 | Tool 包装 |
|------|-------------|----------|
| **控制权** | 完全转移给子 agent | 主 agent 保留控制权 |
| **上下文** | 共享对话历史 | 完全隔离 |
| **返回方式** | 子 agent 接管后可能不返回 | 必须返回结果给主 agent |
| **适用场景** | 客服转接、意图分发 | 任务委派、专家调用 |
| **代表项目** | OpenAI Agents SDK, Google ADK(Transfer) | Pydantic AI, DeepAgents, Claude Code |

**关键洞察：** Handoff 适合"换人接手"，Tool 包装适合"请人帮忙"。Google ADK 是唯一同时支持两种模式的主流框架。

### 4.2 嵌套深度限制

| 项目 | 嵌套深度 | 死锁防护 |
|------|---------|---------|
| **AG2** | 无限制（NestedChatTarget） | ❌ |
| **LangGraph** | 无限制（Subgraph） | ❌ |
| **subagents-pydantic-ai** | 无限制（嵌套 subagent） | ❌ |
| **Maestro** | 无限制（递归分解） | ❌ |
| **Open-Multi-Agent** | maxDelegationDepth=3 | ✅ delegationChain 环检测 |
| **Claude Code** | 1层 | N/A |
| **SmolAgents** | 1层 | N/A |

**关键洞察：** 大多数框架没有嵌套深度限制和死锁防护，Open-Multi-Agent 是少数内置环检测的框架。

---

## 五、选型建议

### 按使用场景推荐

| 场景 | 推荐 | 理由 |
|------|------|------|
| **需要"转交"式 subagent** | OpenAI Agents SDK / Google ADK | Handoff 是核心原语 |
| **需要"调用"式 subagent** | Pydantic AI / DeepAgents | Tool 包装模式干净利落 |
| **需要双模式** | Google ADK | 唯一同时支持 Transfer + AgentTool |
| **需要精细控制** | LangGraph | Subgraph + 状态机控制力最强 |
| **需要快速上手** | SmolAgents / CrewAI | API 最简洁 |
| **需要类型安全** | Pydantic AI | Pydantic 验证每个边界 |
| **需要多模型混搭** | Maestro / AG2 | 支持不同模型协调 vs 执行 |
| **需要开发工作流集成** | Claude Code / Codex CLI | 配置文件式 subagent |
| **需要全栈可视化** | CopilotKit | 委派日志实时渲染 |
| **需要 Deep Research** | Cognitive Kernel-Pro | 专为深度研究设计 |
| **需要嵌套 subagent** | subagents-pydantic-ai / AG2 | 支持深层嵌套委托 |

### 对 sarosis-agents-client 的参考价值

结合你们现有的 Workflow + SubAgent 架构：

1. **Google ADK 的双模式设计**最值得参考——你们的 SubAgent 目前是 Tool 包装模式，可以考虑增加 Handoff 模式（`transfer_to_agent`），让 subagent 接管后续对话
2. **AG2 的 NestedChatTarget** 与你们的 SubAgent 节点概念高度契合——三层条件优先级可以映射到你们的节点路由逻辑
3. **Open-Multi-Agent 的 `delegationChain` 环检测**——你们当前 SubAgent 调用缺少死锁防护，建议参考其 `maxDelegationDepth` 机制
4. **DeepAgents 的文件系统委托**——大型工具结果保存到文件而非上下文，这对你们长任务场景有参考价值

---

*本报告基于 2025-2026 年公开技术资料和源码分析整理。*
