# Symphony 项目分析与对比报告

> 分析日期：2026-05-24  
> 对比项目：Symphony (OpenAI) vs Sarosis Agents Client (本项目)

---

## 一、Symphony 项目概述

**Symphony** 是 OpenAI 开源的**长期运行自动化编排服务**，它将项目工作转化为隔离的、自主的实现运行。核心理念：**让团队管理工作本身，而不是监督编码 Agent**。

- **仓库**: `G:\CustomWorkspaces\AIProjects\symphony`
- **许可证**: Apache License 2.0 (Copyright 2025 OpenAI)
- **技术栈**: Elixir/OTP 28 + Phoenix + Bandit + LiveView + Codex App Server
- **状态**: 低优先级工程预览版

### 核心工作流

```
Linear Issue → 创建隔离工作空间 → 启动 Codex App Server → 持续驱动完成 → 自动创建 PR → 着陆合并
```

1. 轮询 Linear 问题跟踪器获取候选工作
2. 为每个 Issue 创建隔离的工作空间（独立目录）
3. 在该工作空间中启动 Codex（App Server 模式）
4. 向 Codex 发送工作流提示
5. Codex 持续处理问题直到完成
6. 自动 push 代码、创建/更新 PR
7. 自动监控 CI、处理审查反馈、squash-merge

---

## 二、架构详解

### 2.1 六层架构

| 层级 | 组件 | 职责 |
|------|------|------|
| 1 | **策略层** (`WORKFLOW.md` 提示体) | 团队定义的工单处理、验证、交付规则 |
| 2 | **配置层** (`Config` / `Config.Schema`) | 解析 YAML front matter 为类型化运行时设置 |
| 3 | **协调层** (`Orchestrator`) | 轮询循环、Issue 资格判断、并发控制、重试、对账 |
| 4 | **执行层** (`Workspace` + `AgentRunner` + `Codex.AppServer`) | 文件系统生命周期、工作区准备、Codex 协议通信 |
| 5 | **集成层** (`Linear.Adapter` / `Linear.Client`) | Linear API 调用和数据规范化 |
| 6 | **可观测层** (`StatusDashboard` / `HttpServer`) | 日志、终端 UI、LiveView Dashboard、JSON API |

### 2.2 OTP 监督树

```
SymphonyElixir.Application
├── Phoenix.PubSub
├── Task.Supervisor
├── WorkflowStore (热重载 WORKFLOW.md)
├── Orchestrator (核心调度 GenServer)
├── HttpServer (可选 Phoenix/Bandit)
└── StatusDashboard (终端 UI)
```

### 2.3 关键设计决策

- **单权威编排器状态**：避免重复调度，所有运行时状态在一个 GenServer 中
- **工作空间隔离**：每个 Issue 有独立目录，Codex 只在该目录运行
- **WORKFLOW.md 即配置**：团队随代码版本化 Agent 提示和运行时设置
- **动态热重载**：WORKFLOW.md 变更时无需重启自动应用（1 秒轮询 mtime + content hash）
- **内存状态**：重启恢复靠跟踪器轮询和文件系统，不需要持久数据库
- **指数退避重试**：失败后自动重试，上限可配置
- **SSH Worker 扩展**：支持在远程主机通过 SSH 执行工作

---

## 三、关键特性分析

### 3.1 自动 PR — ✅ 完整支持

Symphony 通过 Codex 技能系统实现完整的自动 PR 流程：

#### push 技能（`.codex/skills/push/SKILL.md`）
- 自动推送分支到 origin
- **自动创建 PR**（如果不存在）
- **自动更新 PR**（如果已存在且 open）
- 处理 closed/merged PR 的情况（创建新分支 + PR）
- 自动写入 PR body（遵循 `pull_request_template.md`）
- PR body 格式验证（`mix pr_body.check`）

#### land 技能（`.codex/skills/land/SKILL.md`）
- **自动着陆 PR**：监控冲突、CI 检查、squash-merge
- 异步监控审查评论和 CI 状态（`land_watch.py`）
- 自动处理冲突：调用 pull 技能合并 origin/main
- 自动修复 CI 失败：拉日志 → 修复 → commit → push → 重新检查
- 审查反馈处理：对每个 review comment 选择 accept/clarify/push back
- 合并后自动清理

#### commit 技能（`.codex/skills/commit/SKILL.md`）
- 规范化 git commit，包含 session 上下文、Co-authored-by

### 3.2 自动创建 Worktree — ❌ 不支持

**Symphony 不使用 git worktree**。它采用的是**独立目录隔离**策略：

- 工作空间路径：`~/code/symphony-workspaces/<issue-identifier>/`
- 创建方式：`mkdir -p` + `git clone --depth 1`（after_create hook）
- 不是 git worktree，而是完全独立的仓库 clone
- 每个工作空间有独立的生命周期钩子（after_create, before_run, after_run, before_remove）

`worktree_init.sh` 只是一个 bootstrap 脚本（mise trust + make setup），与 git worktree 无关。

### 3.3 可观测性

- **终端 UI**：实时状态仪表盘（`StatusDashboard`）
- **Web Dashboard**：Phoenix LiveView 实时仪表盘
- **JSON API**：`GET /api/v1/state`、`GET /api/v1/:issue_identifier`、`POST /api/v1/refresh`
- **结构化日志**：带 token 计费的详细日志

### 3.4 弹性与容错

- 指数退避重试（可配置 max_retry_backoff_ms）
- 状态协调：编排器重启后通过 Linear 轮询自动恢复
- 工作空间持久化：文件系统状态不丢失
- 路径安全验证（`PathSafety` 模块）

### 3.5 WORKFLOW.md 配置驱动

```yaml
# YAML Front Matter
tracker:
  kind: linear
  project_slug: "symphony-0c79b11b75ea"
  active_states: [Todo, In Progress, Merging, Rework]
  terminal_states: [Closed, Cancelled, Done]
polling:
  interval_ms: 5000
workspace:
  root: ~/code/symphony-workspaces
hooks:
  after_create: |
    git clone --depth 1 https://github.com/openai/symphony .
    ...
agent:
  max_concurrent_agents: 10
  max_turns: 20
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  approval_policy: never
  thread_sandbox: workspace-write
```

```markdown
<!-- Markdown 提示模板 (Liquid 语法) -->
{% if attempt %}
This is attempt {{ attempt }} for {{ issue.identifier }}: {{ issue.title }}.
Previous attempts failed. Review the history and try a different approach.
{% else %}
You are working on {{ issue.identifier }}: {{ issue.title }}.
{% endif %}
```

---

## 四、与 Sarosis Agents Client 的对比

### 4.1 架构对比

| 维度 | Symphony | Sarosis Agents Client |
|------|----------|----------------------|
| **架构范式** | 单编排器 + 文件系统隔离 | 四层架构 (UI → Driver → OS → Provider) |
| **运行时** | Elixir/OTP (BEAM VM) | TypeScript/VS Code Extension Host |
| **Agent 运行方式** | Codex App Server 子进程 | 多 Provider 插件 (Knot AG-UI, DirectLLM 等) |
| **状态管理** | 内存 GenServer + 文件系统 | Zustand Store + VS Code State |
| **配置驱动** | WORKFLOW.md (YAML + Liquid) | ConfigMD + employees.json + VS Code Settings |
| **UI** | 终端 UI + LiveView Dashboard | VS Code WebView (React + ReactFlow) |
| **Issue 跟踪** | Linear (内置适配器) | 自有员工系统 (employees.json) |
| **并发模型** | OTP Process (轻量级) | JavaScript 单线程 + Task Pool |

### 4.2 功能对比

| 功能 | Symphony | Sarosis Agents Client |
|------|----------|----------------------|
| **自动 PR** | ✅ 完整（push + land 技能） | ❌ 仅有 gitCommitService（基础提交） |
| **自动 Worktree** | ❌ 使用独立目录 clone | ❌ 不支持 |
| **工作空间隔离** | ✅ 每任务独立目录 + git clone | ⚠️ 工作区会话隔离（非 git 级别） |
| **Issue 跟踪集成** | ✅ Linear 深度集成 | ❌ 自有员工系统 |
| **热重载配置** | ✅ WORKFLOW.md 自动热重载 | ⚠️ 需手动刷新 |
| **可观测仪表盘** | ✅ 终端 + Web + JSON API | ⚠️ VS Code 面板（有限） |
| **多 Agent 并发** | ✅ 可配置并发数（默认 10） | ✅ AgentScheduler 调度 |
| **技能系统** | ✅ 6 个核心技能（commit/push/pull/land/linear/debug） | ✅ 107+ 内置技能 |
| **SSH 远程执行** | ✅ 内置 SSH Worker | ❌ 不支持 |
| **审查反馈处理** | ✅ 自动分类并回复 review | ❌ 不支持 |
| **CI 监控** | ✅ 自动监控 + 自动修复 | ❌ 不支持 |
| **重试/退避** | ✅ 指数退避 + 可配置 | ⚠️ 基础重试 |
| **任务分解** | ❌ 依赖 Codex 自行处理 | ✅ TaskDecomposer 模块 |
| **Agent 委派** | ❌ 单 Agent per Issue | ✅ AgentDelegationService |
| **Crew/Team** | ❌ 无 | ✅ CrewTeamService |
| **自进化** | ❌ 无 | ✅ SelfEvolutionService |
| **健康监控** | ❌ 基础日志 | ✅ HealthMonitorService |
| **MCP 支持** | ❌ 无 | ✅ MCP Gateway Provider |

### 4.3 设计哲学对比

| 维度 | Symphony | Sarosis Agents Client |
|------|----------|----------------------|
| **核心理念** | "让团队管理工作，而非监督 Agent" | "多 Agent 协作 + 能力可组合" |
| **规范驱动** | SPEC.md 是真理源，实现可替换 | 四层架构约束，接口隔离 |
| **可扩展性** | 适配器模式（Linear、SSH Worker） | Provider 插件模式（7 个 Slot） |
| **人机交互** | 最小化人类介入（approval_policy: never） | 强调人机协作（审批流、委派） |
| **持久化** | 纯内存 + 文件系统 | VS Code State + 文件系统 |

---

## 五、Symphony 的优点（值得借鉴）

### 5.1 🏆 完整的 Git 工作流自动化

Symphony 最突出的优势是**端到端的 Git 工作流自动化**：

```
commit → push → create PR → watch CI → handle review → land (squash-merge)
```

每个环节都有专门的技能文件定义，包含：
- 明确的步骤和前置条件
- 详细的失败处理策略
- 代码级别的命令示例
- 边界情况处理（冲突、closed PR、flaky CI）

**建议**：Sarosis 应该构建类似的 Git 工作流技能链，至少覆盖 `commit → push → create PR`。

### 5.2 🏆 WORKFLOW.md 配置即代码

将 Agent 提示和运行时配置版本化管理：
- YAML front matter 定义结构化配置
- Markdown body 定义 Agent 提示模板（Liquid 语法）
- 支持模板变量（`{{ issue.identifier }}`、`{{ attempt }}`）
- 热重载无需重启

**建议**：Sarosis 的 ConfigMD 系统可以借鉴这种混合格式，增强模板能力。

### 5.3 🏆 独立工作空间隔离

每个 Issue 有独立的 git clone，天然避免：
- 分支冲突
- 文件系统竞争
- 状态污染

**建议**：Sarosis 可以在 workspaceSessionService 基础上，增加 git worktree 级别的隔离。

### 5.4 🏆 可观测性三件套

终端 UI + Web Dashboard + JSON API 的组合提供了多层次的运行时洞察：
- 开发者可以在终端实时查看
- 团队可以通过浏览器共享状态
- 自动化系统可以通过 API 查询

**建议**：Sarosis 可以利用 VS Code 的 Webview API 和现有的 messageProtocol 构建类似的能力。

### 5.5 🏆 审查反馈自动处理

land 技能定义了完整的审查反馈处理协议：
- 分类每个 review comment（correctness/design/style/clarification/scope）
- 对每个 comment 选择 accept/clarify/push back
- 回复前声明意图，回复后实施变更
- Codex Review 的自动化处理

---

## 六、Sarosis 相对于 Symphony 的优势

### 6.1 🏆 更丰富的 Agent 协作模型

- **多 Agent 委派**：AgentDelegationService 支持 Agent 之间的任务委派
- **Crew/Team 编排**：CrewTeamService 支持团队级协作
- **Task Decomposer**：自动分解复杂任务
- Symphony 只有单 Agent per Issue 模式

### 6.2 🏆 更灵活的能力组合

- **7 Slot 能力模型**：Model/Memory/Tool/Planning/Execution/Retrieval/Kanban
- **Provider 插件化**：不同 Slot 可以混搭不同 Provider
- **优雅降级**：Slot 无 Provider 时自动跳过
- Symphony 的能力绑定在 Codex App Server 上，不可替换

### 6.3 🏆 更庞大的技能生态

- **107+ 内置技能** vs Symphony 的 6 个核心技能
- 技能注册、安装、生命周期管理
- Symphony 的技能仅覆盖 Git 工作流和 Linear 操作

### 6.4 🏆 自进化能力

- SelfEvolutionService 支持 Agent 自我改进
- Symphony 无此概念

### 6.5 🏆 MCP 协议支持

- MCP Gateway Provider 支持 Model Context Protocol
- 可以接入任意 MCP 兼容的工具服务器
- Symphony 无类似机制

### 6.6 🏆 IDE 原生集成

- 深度集成 VS Code 生态
- 编辑器上下文感知
- 工作区工具栏、面板等原生 UI
- Symphony 是独立命令行服务

---

## 七、关键问题回答

### Q1: Symphony 是否支持自动 PR？

**✅ 完整支持。** 通过 `push` 技能自动创建/更新 PR，通过 `land` 技能自动监控 CI 和合并。这是 Symphony 最成熟的特性之一，定义了完整的：

- PR 创建流程（含 title/body 自动生成）
- PR body 格式验证
- CI 检查监控与自动修复
- 审查反馈分类与回复
- Squash-merge 着陆

### Q2: Symphony 是否支持自动创建 Worktree？

**❌ 不支持。** Symphony 使用**独立目录 + git clone** 的隔离策略，而非 git worktree。每个 Issue 在 `~/code/symphony-workspaces/<issue-id>/` 下创建独立目录，执行 `git clone --depth 1` 获取代码。工作空间销毁时通过 `before_remove` hook 清理 PR。

---

## 八、建议借鉴的行动项

| 优先级 | 行动项 | 说明 |
|--------|--------|------|
| **P0** | Git 工作流技能链 | 构建 commit → push → create PR → watch CI 的完整技能链 |
| **P0** | 工作空间隔离 | 在 workspaceSessionService 基础上增加 git worktree 或独立 clone 隔离 |
| **P1** | 配置热重载 | ConfigMD 系统增加文件变更检测和自动重载 |
| **P1** | 可观测性 API | 暴露运行时状态的 HTTP API，便于外部监控 |
| **P2** | 审查反馈处理 | 增加 PR review 自动分类和回复的能力 |
| **P2** | Issue 跟踪集成 | 支持 Linear/Jira/GitHub Issues 等外部跟踪器 |
| **P3** | SSH 远程执行 | 支持 Agent 在远程主机上执行工作 |
| **P3** | 着陆技能 | 实现 land 技能的等价物（自动合并 PR） |

---

## 九、总结

Symphony 是一个**聚焦的、工程化的 Agent 编排服务**，在 Git 工作流自动化（自动 PR、自动着陆）和工作空间隔离方面做得非常出色。它的设计哲学是"最小化人类介入"，让 Agent 完全自主地完成从 Issue 到 PR 合并的全流程。

Sarosis Agents Client 则是一个**更全面的、IDE 原生的多 Agent 协作平台**，在 Agent 协作模型、能力组合、技能生态、自进化等方面有显著优势，但在 Git 工作流自动化和工作空间隔离方面存在明显短板。

**核心差距**：Sarosis 缺少 Symphony 那样端到端的 Git 工作流自动化能力（自动 PR、自动着陆、审查处理），这直接影响了"从任务到代码合入"的自动化程度。建议优先补齐这一短板。
