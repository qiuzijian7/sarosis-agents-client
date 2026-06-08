# ECC 框架 vs Sarosis Agents Client 深度对比分析

> 分析日期：2026-06-07

---

## 一、项目定位对比

| 维度 | ECC | Sarosis Agents Client |
|------|-----|----------------------|
| **本质** | 跨平台 Agent 插件生态系统 | VS Code 深度二次开发的 AI Agent 操作系统 |
| **形态** | 可插拔的 Skill/Agent/Hook 配置包 | 完整的 IDE 产品（嵌入 VS Code 的 Agent Studio） |
| **平台** | 12+ AI 代码助手（Claude Code/Cursor/Codex 等） | 仅 VS Code（但深度集成） |
| **用户** | 终端开发者（CLI-first） | IDE 内开发者（GUI-first） |
| **定位** | "Agent 的 App Store" | "Agent-first IDE" |
| **核心理念** | Skills-First（工作流即配置） | OS-First（能力槽抽象层） |

### 关键差异解读

ECC 是**横向生态**——它不绑定任何单一平台，而是通过适配器让 12+ 平台共享同一套 Agent/Skill/Hook 体系。它的价值在于"内容的广度"。

Sarosis 是**纵向深度**——它 fork 了整个 VS Code 源码，在 workbench 之上构建了完整的 Agent 操作系统。它的价值在于"集成的深度"。

---

## 二、架构设计对比

### 2.1 分层架构

**ECC（五层）：**
```
Operator Surface (CLI/TUI/GUI)
    ↓
Harness Adapter Layer（平台适配）
    ↓
Worktree/Session/Queue Runtime（任务编排）
    ↓
Observability & Evaluation Loop（可观测性）
    ↓
Security & Commercial Platform（安全与商业）
```

**Sarosis（四层）：**
```
WebView Frontend（React + Zustand + ReactFlow）
    ↓
Driver Layer（AgentDriverService，转向生命周期）
    ↓
Agent OS Layer（7 个能力槽 SlotRegistry）
    ↓
Provider Plugins（多后端 + 多能力）
```

### 2.2 架构优劣

| 维度 | ECC 优势 | Sarosis 优势 |
|------|---------|-------------|
| **抽象层次** | 分层清晰，每层职责单一 | Agent OS 层是创新性的能力槽抽象，解耦彻底 |
| **扩展性** | 新增 Platform 只需增加适配目录 | 新增 Provider 只需实现接口并注册到 SlotRegistry |
| **可观测性** | 独立的 Observability 层（JSONL 追踪、风险账本） | 内嵌在流协议中（IChatStreamDelta 事件类型） |
| **状态管理** | Session 级 SQLite + Rust 持久化 | Zustand Store 层（14+ Store）+ Node 端文件/数据库存储 |
| **并发隔离** | 通过环境变量 `ECC_AGENT_DATA_HOME` 隔离 | 通过 `IWorkspaceRegistry` 为每个工作区创建独立 AgentOS 实例栈 |

**总结：** ECC 的架构更"产品化"——每个横切关注点（安全、观测、适配）都有独立层。Sarosis 的架构更"系统化"——Agent OS 的 SlotRegistry 设计使得六种能力（Model/Memory/Tool/Planning/Execution/Retrieval）可以任意组合，**理论上 ECC 的概念可以作为一个 Sarosis ToolProvider 来嵌入**。

---

## 三、模块化与可扩展性对比

### 3.1 ECC：Skills-First 的配置驱动

```yaml
# ECC 扩展一个 Skill：只需一个 Markdown 文件
---
name: code-reviewer
description: Reviews code for quality
tools: ["Read", "Grep", "Glob", "Bash"]
model: opus
---
```

**优点：**
- 零代码扩展——写 Markdown 即可定义 Agent/Skill
- Manifest-driven 选择性安装——用户只装需要的组件
- 261 个 Skills 覆盖极广（从 Django 到 BGP 诊断到预测市场）
- Install-plan.js 安装计划引擎支持智能推荐（`npx ecc consult`）

**缺点：**
- Agent 行为受限于 Markdown prompt 的表达力
- 无法定义复杂的执行逻辑（只能通过 prompt 引导 LLM）
- Skill 之间缺乏类型安全的组合机制

### 3.2 Sarosis：Provider 接口的代码驱动

```typescript
// Sarosis 扩展一个能力：实现接口 + 注册到 SlotRegistry
class MyToolProvider implements IToolProvider {
    readonly providerId = 'my-tools';
    
    async listTools(context: IAgentContext): Promise<IToolInfo[]> { ... }
    async executeTool(toolName: string, parameters: any): Promise<IToolResult> { ... }
    async getToolSchema(toolName: string): Promise<IToolSchema> { ... }
}
```

**优点：**
- TypeScript 强类型保证接口契约
- 通过 DI 容器自动注入和组装
- 能力槽可以跨 Provider 组合（Knot 模型 + OpenClaw 工具 + Hermes 记忆）
- `package.json` → `contributes.agentCapabilities` 声明式注册

**缺点：**
- 扩展需要写 TypeScript 代码并重新编译
- 没有 ECC 那样"写个 Markdown 就上线"的轻量体验
- 缺少选择性安装机制

### 3.3 关键差距

| 场景 | ECC | Sarosis |
|------|-----|---------|
| 新增一个编程语言的规则 | 写 `rules/python/SKILL.md` | 无对应机制（需写代码） |
| 新增一个专业 Agent | 写 `agents/dba.md` | 需实现 `IAgentProvider` + 注册 |
| 用户选择性安装 | Manifest-driven 安装计划 | 无（编译时全量包含） |
| AI 自动创建 Skill | ✅ `Continuous Learning v2` 支持从对话自动提取 | 无 |

---

## 四、前后端分离与 UI 体验

这是 Sarosis 最显著的**结构性优势**。

### 4.1 Sarosis：完整的 WebView UI

```
┌──────────────────────────────────────────────────────────────┐
│  ChatBar (Canvas)            │  AuxiliaryBar (Chat+Delegation) │
│  ReactFlow 可视化工作区        │  对话面板 + 委托管理              │
├──────────────────────────────┼────────────────────────────────┤
│  Panel (TaskBoard)                                              │
│  任务看板 + 进度追踪                                             │
├──────────────────────────────┴────────────────────────────────┤
│  Sidebar (Sessions/Workspaces)                                  │
│  会话管理 + 工作区管理                                            │
└──────────────────────────────────────────────────────────────┘
```

**关键技术栈：** React 18 + Zustand（14+ Store）+ ReactFlow（画布）+ TailwindCSS（主题）+ react-markdown（渲染）+ prismjs（高亮）

**消息渲染能力：**
- 30+ 种 IChatStreamDelta 类型的事件级渲染
- ToolCallCard（工具调用卡片，含执行状态动画）
- SubAgentCard（子 Agent 生命周期可视化）
- CheckpointBar（时间旅行导航）
- ConfirmationCard（安全审批交互）
- ProgressCard（进度条动画）

### 4.2 ECC：CLI/TUI 为主

- **主入口**：终端 CLI（`npx ecc`）
- **TUI Dashboard**：Rust 实现的 ratatui 终端界面（Alpha 阶段）
- **GUI Dashboard**：Python Tkinter 桌面窗口（功能有限）
- **无 WebView**：没有浏览器渲染的交互式 UI

### 4.3 优劣对比

| 维度 | ECC | Sarosis |
|------|-----|---------|
| **Rich Text 渲染** | 终端 ANSI | Markdown + 代码高亮 + 工具卡片 |
| **可视化** | 无 | ReactFlow 工作区画布 |
| **交互式审批** | 终端 confirm | 卡片式 ConfirmationCard |
| **流式体验** | 基于终端输出 | 16ms 帧节流的 SSE 流式协议 |
| **检查点/时间旅行** | 无 | CheckpointBar 导航 |
| **主题集成** | 终端主题 | 复用 VS Code 主题变量 |
| **任务看板** | 无 | 完整的 TaskBoard 面板 |
| **安装成本** | 零（CLI 即用） | 高（需编译整个 VS Code） |

**结论：** Sarosis 的 UI 体验是 **IDE 级的**，ECC 的 UI 体验是**终端级的**。对于日常 IDE 内开发的用户，Sarosis 的体验碾压式领先。但 ECC 适用于任何终端环境，无需启动 IDE。

---

## 五、Agent 系统对比

### 5.1 ECC：Prompt-driven Agent

```markdown
---
name: code-reviewer
description: Expert code reviewer...
tools: ["Read", "Grep", "Glob", "Bash"]
---
# Your Role
You are an expert code reviewer...
## Review Process
1. First, understand the diff...
2. Check for security issues...
```

**模式：** Agent = 角色 Prompt + 可用工具列表 + 模型选择

**优点：**
- 极低创建成本（写 Markdown 即可）
- 64 个专业 Agent 覆盖领域极广
- Agent 可以自动委托给其他 Agent（Agent-First 设计）

**缺点：**
- 行为完全依赖 LLM 对 Prompt 的理解
- 无类型安全的输入/输出约束
- 无结构化的执行追踪
- Agent 之间无正式的通讯协议

### 5.2 Sarosis：SubAgent 调度系统

```typescript
export const enum SubAgentType {
    Explore = 'explore',  // 只读探索器
    General = 'general',  // 通用 Agent（可读可写，可派生）
    Scout = 'scout',      // 外部研究 Agent
}

// 权限矩阵
const SUB_AGENT_PERMISSIONS = {
    explore: { allowedToolPatterns: ['grep','glob','list','read',...] },
    general: { allowedToolPatterns: ['*'], deniedToolPatterns: ['todowrite'] },
    scout:   { ...explore permissions + ['repo_clone'] },
};
```

**功能矩阵：**

| 能力 | ECC | Sarosis |
|------|-----|---------|
| Agent 类型 | 64 种（Prompt 驱动） | 3 种（权限驱动） |
| 工具权限控制 | 声明式 tools 列表 | 正则匹配 + 白名单/黑名单 |
| 子 Agent 派生 | 无 | ✅ General 可派生子 Agent |
| 跨 Agent 中断 | 无 | ✅ `interruptSubAgent()` 递归传播 |
| 事件追踪 | 无 | ✅ 8 种 SubAgentEventType 细粒度事件 |
| 文件变更协调 | 无 | ✅ `filesModified` + `[NOTE: re-read]` 提醒 |
| 预算管理 | 无 | ✅ `_executeWithBudget` 迭代计数 + 超时 |
| 全局注册表 | 无 | ✅ 跨 dispatch 查找/中断/枚举 |
| CrewTeam 协作 | 无 | ✅ `ICrewTeamService` 多 Agent 编排 |
| Swarm 模式 | 无 | ✅ `ISwarmProvider` 群体智能 |

**关键差异解读：**

ECC 的 Agent 是**"角色卡片"**——定义了一个 Agent 应该怎么思考和行事，但执行完全依赖 LLM。Sarosis 的 Agent 是**"有权限约束的运行实例"**——有明确的类型边界、权限矩阵、事件追踪、中断机制和预算控制。

这导致一个根本性的差异：
- ECC 的 code-reviewer 能否真的 review 代码？**取决于 LLM 是否遵循 Prompt**。
- Sarosis 的 Explore subagent 能否执行 shell 命令？**绝对不会**，因为权限系统在代码层面阻止了。

---

## 六、多后端/多模型支持

### 6.1 ECC：Python LLM 抽象层

```python
# 统一的不可变数据类型
@dataclass(frozen=True)
class Message:
    role: str
    content: str

@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict

# 多 Provider 路由
class LLMProvider(ABC):
    async def chat(self, messages, tools=None) -> LLMOutput: ...
    async def stream(self, messages, tools=None) -> AsyncIterable[LLMOutput]: ...
```

**支持的后端：** Anthropic、OpenAI、Ollama、Astraflow（中国通道）

### 6.2 Sarosis：ModelProvider 接口 + 适配器层

```typescript
interface IModelProvider {
    readonly providerId: string;
    listModels(): Promise<IModelInfo[]>;
    chat(messages, tools, options): AsyncIterable<IModelDelta>;
    supportsAgents?: boolean;
    listAgents?(): Promise<IAgentInfo[]>;
}
```

**支持的后端：** OpenRouter、Anthropic、OpenAI、Gemini（Native）、Nous Research、Ollama、Custom OpenAI Compatible + LanguageModelsBridge（VSCode 扩展生态）

### 6.3 模型能力声明式配置（Sarosis 独有）

```typescript
interface IModelCapabilityConfig {
    supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated';
    specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style';
    reasoningType: 'budget-slider' | 'effort-slider' | false;
    supportsCaching: 'openai' | 'anthropic' | false;
}
```

这是 Sarosis 独有的能力——通过声明式配置消除不同模型 API 的差异性，实现真正的 Provider-agnostic 编排。

### 6.4 消息格式转换器

Sarosis 有独立的 `MessageFormatConverter`（`common/adapters/messageFormatConverter.ts`），支持五种格式的双向转换：
- **AG-UI**（Knot 内部协议）
- **OpenAI**（Chat Completions API）
- **Anthropic**（Messages API，含 tool_use 格式）
- **Gemini**（原生 Content/Part 格式）
- **XML**（函数调用转 XML）

ECC 在 Python 层也有 `to_anthropic_tool()` / `to_openai_tool()` 转换，但仅限工具格式。

| 维度 | ECC | Sarosis |
|------|-----|---------|
| Provider 架构 | Python ABC 抽象类 | TypeScript 接口 + DI 注册 |
| 后端数量 | 4 | 7+（含 LanguageModelsBridge 无限扩展） |
| 模型能力声明 | 无 | ✅ IModelCapabilityConfig |
| 多格式消息转换 | 仅工具格式 | ✅ 5 种格式全转换 |
| Agent-aware 模型 | 无 | ✅ supportsAgents + family 匹配 |
| 流式协议 | AsyncIterable[LLMOutput] | AsyncIterable[IModelDelta]（30+ 种事件） |
| Token 预算管理 | 无 | ✅ QuotaGuard（API 限流/Token 预算） |
| 健康检查/重试 | 无 | ✅ 指数退避 + 自动重试 |

---

## 七、安全与治理

### 7.1 ECC：AgentShield + Hook 治理

**AgentShield**（独立 npm 包 `ecc-agentshield`）：
- 1282 个测试，98% 覆盖率，102 条静态分析规则
- 5 类扫描：secrets 检测（14 模式）、权限审计、Hook 注入分析、MCP 服务器风险分析、Agent 配置审查
- `--opus` 标志运行三个 Opus Agent 红队/蓝队/审计管道
- 输出格式：Terminal（A-F 等级）、JSON（CI）、Markdown、HTML
- 发现 Critical 时 exit code 2（CI Gate）

**Governance Capture Hook：**
- `governance-capture.js` 捕获治理事件记录到结构化日志
- `gateguard-fact-force.js` 强制 fact-check
- `config-protection.js` 配置保护
- `block-no-verify.js` 阻止 `--no-verify`

### 7.2 Sarosis：工具安全审批 + 权限矩阵

**ToolSecurityLevel 三级安全：**
```typescript
enum ToolSecurityLevel {
    Safe = 'safe',        // 读操作，自动放行
    Cautious = 'cautious', // 轻微副作用，需确认
    Dangerous = 'dangerous', // 破坏性操作，严格审批
}
```

**IToolApprovalHandler：** 由 WebView 注册的审批回调，在工具执行前弹窗等待用户决策。支持记住审批决定。

**SubAgent 权限矩阵：** 基于正则的工具白名单/黑名单，在代码层面不可绕过。

### 7.3 对比

| 维度 | ECC | Sarosis |
|------|-----|---------|
| Secrets 检测 | ✅ AgentShield 14 模式 | 无 |
| Hook 注入分析 | ✅ AgentShield | 无（无 Hook 系统） |
| 工具执行审批 | 无独立机制（依赖 LLM 自审） | ✅ 三级安全 + ConfirmationCard |
| Agent 权限隔离 | 无（Prompt 级声明） | ✅ 正则白名单/黑名单（代码级） |
| CI Gate | ✅ AgentShield exit code 2 | 无 |
| 红队/蓝队审计 | ✅ AgentShield --opus 管道 | 无 |
| 审计日志 | ✅ governance-capture.js | 部分（Checkpoint 系统） |

**结论：** ECC 在**静态安全分析**和**审计合规**方面遥遥领先（AgentShield 是独立的安全产品）。Sarosis 在**运行时工具安全**和**Agent 权限隔离**方面更严格（代码级强制）。

---

## 八、工作区/多仓库管理

### 8.1 ECC：Worktree + Session 管理

Rust 实现的 ECC 2.0 有独立的 Worktree 模块（`ecc2/src/worktree/`），通过 `git2` 管理 Git worktree：
- 每个任务可以创建独立的 worktree
- Session 通过 SQLite 持久化
- 支持 `ecc sessions list/resume/stop`

但**没有多仓库管理**——ECC 假设单仓库工作流。

### 8.2 Sarosis：Workspace + RelatedFolders 多仓库模型

这是 Sarosis 最独特的设计之一：

```typescript
// 两类根目录
Workspace {
    path?: string;              // home/元数据目录（存 .sarosisworkspace）
    relatedFolders: RelatedFolder[]; // 真正的代码仓库（多仓库管理核心）
}

// 每个工作区独立的 AgentOS 实例栈
class WorkspaceRegistryService {
    registerWorkspace(config): IDisposable {
        const osService = createInstance(AgentOSService);  // 新实例
        // 独立的 Model/Memory/Tool/Planning/Execution/Retrieval Provider 集合
    }
}
```

| 维度 | ECC | Sarosis |
|------|-----|---------|
| Worktree 管理 | ✅ git2 原生 | ✅ 独立 worktree 模块 |
| 多仓库支持 | 无 | ✅ relatedFolders（关联/移除代码仓库） |
| 工作区隔离 | 环境变量（平台级） | ✅ 独立 AgentOS 实例栈（应用级） |
| SCM 集成 | 无 | ✅ SourceControl 多仓库显示 |
| Session 管理 | ✅ SQLite（Rust） | ✅ 文件存储 + Fork 模式会话 |

**结论：** Sarosis 的工作区设计是"微服务化"的——每个工作区是独立的 AgentOS 实例，拥有独立的 Provider 集合。这对多仓库 monorepo 场景至关重要。ECC 没有这个概念。

---

## 九、Hook/事件自动化系统

这是 ECC 独有的能力，Sarosis **完全没有等价物**。

### 9.1 ECC Hook 系统（69 个 Hook）

```
hooks/hooks.json     # 50KB+ Hook 定义
scripts/hooks/       # 69 个 Hook 实现
  session-start.js   # Session 开始
  session-end.js     # Session 结束
  pre-bash-dev-server-block.js  # 阻止危险操作
  post-edit-format.js           # 格式化
  post-edit-typecheck.js        # 类型检查
  gateguard-fact-force.js       # 事实检查
  cost-tracker.js               # 费用追踪
  mcp-health-check.js           # MCP 健康检查
  cursor-session-env.js         # Cursor 适配
```

**支持的事件：** SessionStart、SessionEnd、PreToolUse、PostToolUse、PreCompaction、Notification 等 8+ 种

### 9.2 Sarosis：事件仅限内部通信

```
WebView <--messageProtocol--> Host
```

Sarosis 的事件系统**仅服务于 WebView ↔ Host 通信**，没有对外的 Hook 机制。所有自动化逻辑必须硬编码在服务实现中。

**这是一个巨大的结构性差距。** ECC 的 Hook 系统意味着：
- 用户可以为任何平台事件编写自定义脚本
- 多平台适配只需一个 adapter.js 翻译
- 社区可以贡献 Hook 而无需修改核心代码

---

## 十、生态与社区

| 维度 | ECC | Sarosis |
|------|-----|---------|
| GitHub Stars | 182K+ | 私有仓库 |
| 贡献者 | 170+ | 个人/小团队 |
| 平台覆盖 | 12+ 平台 | 仅 VS Code |
| 多语言支持 | 18 种语言规则 + 12 种文档翻译 | 无 |
| 文档 | 多语言架构文档 | 少量设计文档 |
| 测试覆盖 | c8 + pytest + AgentShield 1282 测试 | 有限 |
| CI/CD | GitHub Actions | 无 |

---

## 十一、总结：核心优势与劣势

### Sarosis 的结构性优势（ECC 无法复制的）

1. **IDE 级 UI 体验**——React + Zustand + ReactFlow 的可视化面板，流式消息渲染，工具卡片，检查点导航。ECC 永远达不到这个水平的 UI，因为它是 CLI/TUI 的。

2. **Agent OS 能力槽抽象**——7 个 SlotRegistry 使得 Model/Memory/Tool/Planning/Execution/Retrieval 可以任意跨 Provider 组合。这个设计比 ECC 的 Skills-First 更底层、更灵活。

3. **多工作区完全隔离**——每个工作区独立 AgentOS 实例栈，独立的 Provider 集合。这对 monorepo/多仓库场景是杀手级特性。

4. **类型安全的 Provider 接口**——TypeScript 强类型 + DI 注入保证了接口契约。ECC 的 Markdown Agent 没有类型保证。

5. **模型能力声明式配置**——`IModelCapabilityConfig` 使得多后端路由不需要 hardcode 差异性。

6. **运行时安全隔离**——三级安全审批 + SubAgent 权限矩阵（代码级强制），不是 Prompt 级建议。

### ECC 的结构性优势（Sarosis 难以复制的）

1. **Hooks 事件自动化系统**——69 个 Hook，覆盖 Session 生命周期、工具前后、安全审计的全事件驱动。Sarosis **完全没有等价物**。这可能是 Sarosis 在架构上最大的缺失。

2. **AgentShield 安全审计**——独立安全产品，1282 测试，98% 覆盖率，CI Gate 集成。Sarosis 缺少静态安全分析能力。

3. **Skills-First 零代码扩展**——写 Markdown 即可定义 Agent/Skill，261 个 Skills 覆盖极广。Sarosis 必须写 TypeScript。

4. **Continuous Learning v2 (Instinct)**——从对话中自动提取模式，置信度评分，`/evolve` 聚类为 Skills。Sarosis 无自我进化能力。

5. **跨平台适配器矩阵**——一次编写，12+ 平台运行。Sarosis 深度绑定 VS Code。

6. **选择性安装系统**——Manifest-driven，用户只装需要的组件。Sarosis 编译时全量包含。

7. **多语言文档**——12 种语言翻译，18 种语言编码规范。Sarosis 无国际化。

8. **社区与生态**——182K Stars，170+ 贡献者，活跃的社区驱动开发。

### Sarosis 应该向 ECC 学习的

| 优先级 | 功能 | 理由 |
|--------|------|------|
| **P0** | Hooks 事件自动化系统 | 这是架构上最明显的缺失。没有 Hook，所有自动化逻辑都硬编码在服务中，扩展性极差。 |
| **P0** | 安全审计（AgentShield 等价物） | 当前只有运行时工具审批，缺少 secrets 检测、权限审计等静态分析。 |
| **P1** | 零代码 Agent/Skill 定义 | 当前必须写 TypeScript。应该支持 YAML/Markdown 声明的轻量 Agent。 |
| **P1** | Selective Install / Plugin 系统 | 当前全量编译。应该参考 ECC 的 manifest-driven 安装。 |
| **P2** | Continuous Learning | 从对话中自动提取可复用模式。 |
| **P2** | 多语言编码规范 | 参考 ECC 的 18 种语言 rules/ 目录。 |
| **P2** | 社区生态建设 | 开放贡献、文档、测试、CI。 |

### ECC 可以向 Sarosis 学习的

| 功能 | 理由 |
|------|------|
| 能力槽抽象 | 如果 ECC 的 Hook/Skill/Agent 系统也采用 SlotRegistry 式的接口抽象，扩展会更灵活 |
| WebView UI | 终端 UI 的天花板太低，浏览器渲染的消息卡片、ReactFlow 画布是未来方向 |
| 工作区隔离 | 多仓库场景下，每个仓库独立的 AgentOS 实例是必需的设计 |
| 模型能力声明式配置 | 消除多后端差异性的声明式方案比 hardcode 更优雅 |
| 类型安全 | TypeScript 强类型 Provider 接口比 Markdown prompt 更可靠 |

---

## 十二、最终评分

| 维度 | ECC | Sarosis | 评语 |
|------|-----|---------|------|
| 架构设计 | ★★★★☆ | ★★★★★ | Sarosis 的 Agent OS 槽抽象更底层、更系统 |
| 用户体验 | ★★★☆☆ | ★★★★★ | Sarosis 的 IDE 级 GUI 碾压 ECC 的终端 |
| 可扩展性 | ★★★★★ | ★★★☆☆ | ECC 的 Markdown 驱动 + Hook 系统完胜 |
| 安全性 | ★★★★★ | ★★★★☆ | ECC 有独立的 AgentShield 产品 |
| 多后端支持 | ★★★★☆ | ★★★★★ | Sarosis 的声明式能力配置更优雅 |
| 工作区管理 | ★★★☆☆ | ★★★★★ | Sarosis 的多仓库 + 实例隔离是独特设计 |
| 生态/社区 | ★★★★★ | ★☆☆☆☆ | 182K Stars vs 私有仓库，不在一个量级 |
| 安装/部署 | ★★★★★ | ★★☆☆☆ | ECC 一行命令安装，Sarosis 需编译 VS Code |
| Agent 系统 | ★★★☆☆ | ★★★★★ | Sarosis 的权限+事件+中断机制更可靠 |
| 自动化 | ★★★★★ | ★★☆☆☆ | ECC Hook 系统是 Sarosis 最大的结构性差距 |
| **综合评价** | **★★★★☆** | **★★★★☆** | 互补性强，最佳策略是整合而非竞争 |

---

**核心结论：这两个项目不是竞争关系，而是互补关系。ECC 是一个"Agent 的 App Store"（横向生态），Sarosis 是一个"Agent-first IDE"（纵向深度）。理想情况下，ECC 的 261 个 Skills、69 个 Hooks 和 AgentShield 可以集成到 Sarosis 的 Agent OS 中，作为 ToolProvider 和 HookProvider 运行；而 Sarosis 的能力槽架构可以作为 ECC 的参考升级方向。**

---

> 原报告路径：`doc/ECC-vs-Sarosis-对比分析.md`
> 分析工具：WorkBuddy Agent + 双项目深度探索
