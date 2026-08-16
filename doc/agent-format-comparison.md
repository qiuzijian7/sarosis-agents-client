# Agent 设计与存储格式对比分析

> 对比对象：VS Code Custom Agent、Hermes-Agent、OpenClaw、OpenHuman、本项目（Saros Agents Client）
>
> 生成日期：2026-05-26

---

## 一、项目概览

| 项目 | 语言/运行时 | 架构模式 | Agent 数量 | 定位 |
|------|------------|----------|-----------|------|
| **VS Code Custom Agent** | TypeScript (VS Code 内置) | IDE 内嵌 | 按需加载 | VS Code 原生 chat mode / subagent |
| **Hermes-Agent** | Python 3.12+ | 单体 CLI + Gateway | 1 (AIAgent 类) | Nous Research 的工具调用循环框架 |
| **OpenClaw** | TypeScript / ESM (Node 22+) | Gateway 中心化 | 多 (AgentConfig 数组) | 开源个人 AI 助手框架 |
| **OpenHuman** | Rust + Tauri (桌面) | 多层域架构 | 18 内置 + 自定义 | Rust 实现的个人 AI 助手 |
| **本项目 (Saros)** | TypeScript (VS Code fork) | IDE 扩展 + 画布 | 预设模板 + 运行时实例 | VS Code 深度集成的多 Agent 工作台 |

---

## 二、Agent 数据模型对比

### 2.1 身份标识字段

| 字段 | VS Code `ICustomAgent` | Hermes `AIAgent` | OpenClaw `AgentConfig` | OpenHuman `AgentDefinition` | 本项目 `Employee` |
|------|:---------------------:|:----------------:|:---------------------:|:-------------------------:|:-----------------:|
| 唯一 ID | `uri` (文件路径) | — (实例级无 ID) | `id: string` | `id: String` | `id: string` |
| 名称 | `name` | — (CLI 级) | `name?` | `display_name?` | `name` |
| 描述 | `description` | — | `description?` | `when_to_use` | `role` |
| 图标 | ❌ | ❌ | `identity.emoji?` | ❌ | `avatar` (emoji) |
| 来源 | `IAgentSource` | `provider` | `default?` | `DefinitionSource` | `AgentSource` 枚举 |
| 启用/禁用 | `enabled` | ❌ | ❌ | ❌ | `EmployeeStatus` |

**关键差异**：
- VS Code 用文件 URI 作为标识，其余项目用字符串 ID
- 本项目的 `role` 对应其他项目的 `description` / `when_to_use`
- OpenHuman 的 `when_to_use` 是给父模型做路由决策用的，不仅仅是展示

### 2.2 模型与推理参数

| 字段 | VS Code | Hermes | OpenClaw | OpenHuman | 本项目 |
|------|:-------:|:------:|:--------:|:---------:|:------:|
| 模型 | `model: string[]` | `model: str` | `model: string \| {primary, fallbacks}` | `model: ModelSpec` (Inherit/Exact/Hint) | `model: ModelSpec` (string \| string[] \| IModelChain) |
| 备选模型 | ✅ (数组) | ❌ | ✅ (fallbacks) | ✅ (Hint) | ✅ (数组 / IModelChain) |
| Temperature | ❌ | `temperature` | ❌ (通过 runtime) | `temperature: f64` | `temperature` |
| Max Tokens | ❌ | ❌ | ❌ | `max_result_chars` | `maxTokens` / `limits.maxResponseTokens` |
| Thinking 模式 | ❌ | ❌ | `thinkingDefault` | ❌ | ❌ |
| 推理模式 | ❌ | ❌ | `reasoningDefault` | ❌ | ❌ |

**关键差异**：
- VS Code 的 `model` 是数组（多候选），本项目现已支持 `ModelSpec`（string / string[] / `{primary, fallbacks}`），与 OpenClaw 对齐
- OpenHuman 的 `ModelSpec::Inherit` 支持从父级继承模型选择
- OpenClaw 的 `thinkingDefault` / `reasoningDefault` 提供细粒度的推理控制，其他项目均无

### 2.3 工具与技能

| 字段 | VS Code | Hermes | OpenClaw | OpenHuman | 本项目 |
|------|:-------:|:------:|:--------:|:---------:|:------:|
| 工具列表 | `tools: string[]` | `enabled_toolsets: List[str]` | `tools: AgentToolsConfig` | `tools: ToolScope` | `tools: string[]` |
| 工具白名单 | ✅ | ✅ | ✅ | `ToolScope::Named(Vec)` | ✅ |
| 工具黑名单 | ❌ | `disabled_toolsets` | ❌ | `disallowed_tools` | ❌ |
| 额外工具 | ❌ | ❌ | ❌ | `extra_tools` | ❌ |
| 技能 | ❌ | `skills/` 目录 (SKILL.md) | `skills: string[]` | `skill_filter` | `skills: string[]` |
| 技能版本 | ❌ | ❌ | ❌ | ❌ | `skillVersions` |
| 技能定向文件 | ❌ | ✅ (SKILL.md) | ❌ | ❌ | ✅ `skillDirectives` (ISkillDirective) |
| MCP 服务器 | `mcp-servers` (frontmatter) | ❌ | ❌ | ❌ | ❌ |

**关键差异**：
- Hermes 和 OpenClaw 的工具管理是 toolset 级别（工具包），本项目和 VS Code 是单个工具级别
- OpenHuman 有 `disallowed_tools` + `extra_tools` 的黑/白名单组合，最灵活
- 只有本项目和 OpenClaw 有独立的 `skills` 概念
- VS Code 独有的 `mcp-servers` 支持，其他项目均未实现

### 2.4 Hand-off / 子 Agent 委派

| 字段 | VS Code | Hermes | OpenClaw | OpenHuman | 本项目 |
|------|:-------:|:------:|:--------:|:---------:|:------:|
| Hand-off 定义 | `IHandOff` | ❌ | ❌ | ❌ | `IAgentHandOff` |
| 子 Agent 列表 | `agents` | `delegate_tool` | `subagents.allowAgents` | `subagents: Vec<SubagentEntry>` | `agents` |
| 委派模式 | ❌ | ❌ | `delegationMode: suggest\|prefer` | ❌ | ❌ |
| 委派工具名 | ❌ | ❌ | ❌ | `delegate_name` | ❌ |
| Hand-off 自动发送 | `send` | ❌ | ❌ | ❌ | `send` |
| Hand-off 模型切换 | `model` | ❌ | ❌ | ❌ | `model` |
| Hand-off 继续按钮 | `showContinueOn` | ❌ | ❌ | ❌ | ❌ |
| 子 Agent 层级 | ❌ | ❌ | ❌ | `AgentTier` (Chat/Reasoning/Worker) | `AgentType` (Planner/Worker) |

**关键差异**：
- 只有 VS Code 和本项目有声明式 `IHandOff` 结构（label + prompt + send），其他项目用子 Agent 列表做路由
- OpenHuman 的 `SubagentEntry::Skills(SkillsWildcard)` 可以按技能匹配子 Agent，而非硬编码名称
- OpenClaw 的 `delegationMode` 支持 `suggest`（建议）vs `prefer`（偏好）两种委派策略
- 本项目的 `AgentType.Planner/Worker` 和 OpenHuman 的 `AgentTier.Chat/Reasoning/Worker` 是类似的分层概念

### 2.5 可见性控制

| 字段 | VS Code | Hermes | OpenClaw | OpenHuman | 本项目 |
|------|:-------:|:------:|:--------:|:---------:|:------:|
| 用户可调用 | `user-invocable` | ❌ | ❌ | ❌ | `visibility.userInvocable` |
| Agent 可调用 | `disable-model-invocation` (反向) | ❌ | ❌ | ❌ | `visibility.agentInvocable` |
| 默认 Agent | ❌ | ❌ | `default: boolean` | ❌ | ❌ |

### 2.6 生命周期 Hooks

| 字段 | VS Code | Hermes | OpenClaw | OpenHuman | 本项目 |
|------|:-------:|:------:|:--------:|:---------:|:------:|
| Hook 类型 | `command` only | ❌ | ❌ | ❌ | `prompt` \| `command` \| `script` |
| PreToolUse | ✅ | ❌ | ❌ | ❌ | ✅ `IAgentToolHookEntry` |
| PostToolUse | ✅ | ❌ | ❌ | ❌ | ✅ `IAgentToolHookEntry` |
| Hook 可阻塞 | ✅ | ❌ | ❌ | ❌ | ✅ `blockable` |
| 工具模式匹配 | ✅ matcher | ❌ | ❌ | ❌ | ✅ `toolPattern` (glob) |
| OS 命令覆盖 | ✅ (win/linux/osx) | ❌ | ❌ | ❌ | ❌ |
| 会话事件 | SessionStart/End | ❌ | ❌ | ❌ | `start`/`stop`/`subagentStop` |

**关键差异**：
- 本项目的 Hook 系统是最完整的：支持 `prompt` 类型（注入系统提示词）、`command`（shell）、`script`（脚本）
- VS Code 的 Hook 只支持 `command`，但支持 OS 级覆盖
- Hermes / OpenClaw / OpenHuman 均无声明式 Hook 系统

### 2.7 沙箱与安全

| 字段 | VS Code | Hermes | OpenClaw | OpenHuman | 本项目 |
|------|:-------:|:------:|:--------:|:---------:|:------:|
| 沙箱模式 | ❌ | ❌ | `sandbox: AgentSandboxConfig` | `SandboxMode` (None/ReadOnly/Sandboxed) | ✅ `SandboxMode` (None/ReadOnly/Sandboxed) |
| 只读工具 | ❌ | ❌ | ❌ | ✅ `SandboxMode::ReadOnly` | ✅ `SandboxMode.ReadOnly` + `READ_ONLY_TOOL_IDS` |
| 迭代限制 | ❌ | `max_iterations` | `contextLimits` | `max_iterations` | ✅ `limits.maxIterations` |
| 超时 | ❌ | ❌ | ❌ | `timeout_secs` | ✅ `limits.timeoutSecs` |
| 后台执行 | ❌ | ❌ | ❌ | `background: bool` | ✅ `background` |

### 2.8 运行时状态（仅实例化后的 Agent 拥有）

| 字段 | VS Code | Hermes | OpenClaw | OpenHuman | 本项目 |
|------|:-------:|:------:|:--------:|:---------:|:------:|
| 运行状态 | ❌ | ❌ | ❌ | ❌ | `EmployeeStatus` (idle/working/thinking/error/offline) |
| Token 用量 | ❌ | `usage` (per-request) | ❌ | ❌ | `tokenUsage` |
| 画布位置 | ❌ | ❌ | ❌ | ❌ | `position: {x, y}` |
| Git Worktree | ❌ | ❌ | ❌ | ❌ | `worktreePath` / `worktreeBranch` |
| 画布连线 | ❌ | ❌ | ❌ | ❌ | `connections` |
| ConfigMD | ❌ | ❌ | ❌ | ❌ | `configMd` (MD↔HTML 双向同步) |

---

## 三、存储格式对比

### 3.1 格式总览

| 项目 | Agent 定义格式 | 配置文件 | 用户数据目录 |
|------|--------------|---------|------------|
| **VS Code** | `.agent.md` (YAML frontmatter + Markdown body) | `.vscode/agents/`, `.github/agents/`, `.claude/agents/` | 无独立目录 |
| **Hermes** | Python 类 + 文件系统 | `~/.hermes/config.yaml` | `~/.hermes/` |
| **OpenClaw** | YAML 配置文件 | `.agents/*.yml`, `agents.yml` | `~/.openclaw/agents/` |
| **OpenHuman** | TOML 定义 + Markdown 提示词 | `agents/{id}/agent.toml` + `agents/{id}/SOUL.md` | `~/.openhuman/` |
| **本项目** | JSON (employees.json) + Markdown (五文件体系) | `.sarosisworkspace/employees.json` | `.sarosisworkspace/agents/{slug}/` |

### 3.2 详细存储结构

#### VS Code: `.agent.md`

```yaml
---
name: Code Reviewer
description: Reviews code for quality and security
tools:
  - read
  - search
model:
  - gpt-4o
  - claude-sonnet-4-20250514
agents:
  - Tester
handoffs:
  - agent: Tester
    label: Run Tests
    prompt: Run tests for the reviewed code
    send: false
user-invocable: true
disable-model-invocation: false
target: vscode
mcp-servers:
  - name: my-server
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
---

You are a code reviewer. Focus on...
(Markdown body = system prompt)
```

#### Hermes: 文件系统 + SQLite

```
~/.hermes/
├── config.yaml           # 全局配置 (provider, model, toolsets)
├── SOUL.md               # 代理人格
├── MEMORY.md             # 持久记忆
├── USER.md               # 用户画像
├── skills/               # 用户安装的 Skill (SKILL.md 格式)
├── skill-bundles/        # Skill 捆绑包
└── state.db              # SQLite 会话数据库 (FTS5)
```

Hermes 的 Skill 格式 (`SKILL.md`)：

```yaml
---
name: code-review
description: Reviews code for quality issues
tools: [read, search]
triggers:
  - pattern: "/review"
---
(SKill content as Markdown)
```

#### OpenClaw: YAML 配置

```yaml
# .agents/coder.yml 或 agents.yml
- id: coder
  name: Coder
  description: Writes and modifies code
  default: true
  model:
    primary: claude-sonnet-4-20250514
    fallbacks:
      - gpt-4o
  skills:
    - code-gen
    - refactor
  subagents:
    delegationMode: prefer
    allowAgents:
      - tester
      - researcher
  identity:
    emoji: "💻"
  thinkingDefault: medium
  tools:
    enabled: ["*"]
    disabled: []
```

#### OpenHuman: TOML + Markdown

```toml
# agents/researcher/agent.toml
[id]
id = "researcher"
display_name = "Researcher"
when_to_use = "When you need to search the web or lookup information"

[model]
type = "Inherit"  # Inherit / Exact / Hint

[tools]
scope = "Named"
names = ["web_search", "read_file"]

[limits]
max_iterations = 12
sandbox_mode = "ReadOnly"

[[subagents]]
type = "AgentId"
value = "writer"
```

配合 Markdown 提示词文件：

```
agents/researcher/
├── agent.toml          # 结构化定义
└── SOUL.md             # 系统提示词 (人格)
```

#### 本项目: JSON + 五文件 Markdown 体系

```
.sarosisworkspace/
├── employees.json                    # 所有 Agent 实例的元数据
└── agents/
    └── coder/
        ├── AGENTS.md                 # 操作指令和工作区规则
        ├── SOUL.md                   # 核心人格、价值观、边界
        ├── IDENTITY.md               # 身份记录 (名称、emoji、备注)
        ├── TOOLS.md                  # 本地环境工具笔记
        ├── MEMORY.md                 # 长期记忆
        ├── config.md                 # (可选) ConfigMD 双向同步
        ├── agent.yaml                # Agent 配置（含调度、沙箱、限制）
        └── skills/                   # (可选) 技能定向文件目录
            └── code-review.md        # SKILL.md 格式的技能定义
```

`employees.json` 片段：

```json
{
  "id": "agent-001",
  "name": "Coder",
  "role": "Senior Developer",
  "model": ["claude-sonnet-4-20250514", "gpt-4o"],
  "tools": ["vscode", "read", "execute"],
  "skills": ["code-gen", "refactor"],
  "skillDirectives": [
    { "path": "skills/code-review.md", "autoActivate": true, "activation": "auto" }
  ],
  "sandbox": "none",
  "limits": { "maxIterations": 25, "timeoutSecs": 300 },
  "background": false,
  "handOffs": [
    { "agent": "Tester", "label": "Run Tests", "prompt": "...", "send": false }
  ],
  "visibility": { "userInvocable": true, "agentInvocable": true },
  "agents": ["Tester", "Researcher"],
  "status": "idle",
  "temperature": 0.4,
  "position": { "x": 100, "y": 200 }
}
```

---

## 四、系统提示词构建对比

| 项目 | 提示词来源 | 组装策略 | 模板系统 |
|------|----------|---------|---------|
| **VS Code** | `.agent.md` Markdown body | 单文件，直接注入 | ❌ |
| **Hermes** | 三层结构：SOUL.md + AGENTS.md + 技能目录 | `system_prompt.py` 动态组装 | ✅ Jinja2 风格变量替换 |
| **OpenClaw** | `systemPromptOverride` 或文件 | AgentScope 层层解析 | ✅ Lodash 模板 |
| **OpenHuman** | `PromptSource` (Inline/File/Dynamic) | `prompt_builder.rs` 组装 | ✅ Tera (Rust 模板引擎) |
| **本项目** | 五文件体系 + `customPrompt` | 预设模板 → 实例目录 → 运行时组装 | ❌ |

**关键差异**：
- Hermes 的三层提示词架构最成熟：SOUL（人格）→ AGENTS（规则）→ Skills（技能目录），每层独立管理
- OpenHuman 的 `PromptSource::Dynamic(fn)` 支持运行时动态生成提示词，灵活性最高
- 本项目的五文件体系（AGENTS/SOUL/IDENTITY/TOOLS/MEMORY）最细粒度，但无模板变量替换
- VS Code 最简单，所有提示词在单个 Markdown body 中

---

## 五、Skill / 技能系统对比

| 项目 | 技能定义格式 | 技能发现 | 技能运行时 | 技能可组合 |
|------|-----------|---------|-----------|-----------|
| **VS Code** | ❌ 无技能概念 | N/A | N/A | N/A |
| **Hermes** | `SKILL.md` (YAML frontmatter + MD) | 文件系统扫描 + 注册表 | 内联 Shell / QuickJS | ✅ Skill Bundles |
| **OpenClaw** | `SKILL.md` (YAML + MD) | 文件系统扫描 | QuickJS V8 隔离沙箱 | ✅ Skill Bundles |
| **OpenHuman** | 技能元数据 (Rust 结构体) | 编译时 + 文件扫描 | QuickJS (已移除) → 工具委派 | ❌ |
| **本项目** | 字符串 ID (`skills: string[]`) | 技能注册表 | VS Code 工具绑定 | ❌ |

**关键差异**：
- Hermes 和 OpenClaw 的 Skill 系统最完整：每个 Skill 是一个独立文件（SKILL.md），含触发器、工具列表、指令内容
- 本项目的 Skill 是轻量级标签，仅通过 ID 引用，实际能力由 `tools` 字段控制
- VS Code 完全没有 Skill 概念

---

## 六、记忆系统对比

| 项目 | 记忆类型 | 存储 | 检索 |
|------|---------|------|------|
| **VS Code** | ❌ | ❌ | ❌ |
| **Hermes** | `MEMORY.md` + SQLite FTS5 + 向量搜索 | 文件 + 数据库 | 全文 + 语义 |
| **OpenClaw** | `MEMORY.md` + 向量嵌入 | 文件 + ChromaDB | 语义搜索 (`memorySearch`) |
| **OpenHuman** | `MEMORY.md` + 向量嵌入 | 文件 + 内置向量 | `omit_memory_md` / `omit_memory_context` |
| **本项目** | `MEMORY.md` (纯文件) | 文件 | ❌ (手动读写) |

**关键差异**：
- Hermes / OpenClaw / OpenHuman 都有向量语义搜索能力
- 本项目仅有 Markdown 文件级记忆，无自动检索
- VS Code 无内置记忆系统

---

## 七、跨项目互操作性分析

### 7.1 格式兼容矩阵

| 导出 ↓ / 导入 → | VS Code .agent.md | Hermes | OpenClaw YAML | OpenHuman TOML | 本项目 JSON |
|-----------------|:-----------------:|:------:|:------------:|:-------------:|:-----------:|
| VS Code .agent.md | — | ⚠️ 需转换 | ⚠️ 需转换 | ⚠️ 需转换 | ⚠️ 需转换 |
| Hermes | ⚠️ 需转换 | — | ⚠️ 需转换 | ⚠️ 需转换 | ⚠️ 需转换 |
| OpenClaw YAML | ⚠️ 需转换 | ⚠️ 需转换 | — | ⚠️ 需转换 | ⚠️ 需转换 |
| OpenHuman TOML | ⚠️ 需转换 | ⚠️ 需转换 | ⚠️ 需转换 | — | ⚠️ 需转换 |
| 本项目 JSON | ⚠️ 需转换 | ⚠️ 需转换 | ⚠️ 需转换 | ⚠️ 需转换 | — |

---

## 八、差异总结与建议

### 8.1 本项目缺失的关键特性

| 特性 | 来源项目 | 优先级 | 状态 | 建议 |
|------|---------|:------:|:------:|------|
| **模型备选链** | VS Code, OpenClaw, OpenHuman | 🔴 高 | ✅ 已实现 | `model: ModelSpec` 支持 string / string[] / `{primary, fallbacks}` |
| **沙箱模式** | OpenClaw, OpenHuman | 🔴 高 | ✅ 已实现 | `SandboxMode` (None/ReadOnly/Sandboxed) + `AgentToolIsolator` 沙箱感知 |
| **迭代/超时限制** | Hermes, OpenHuman | 🟡 中 | ✅ 已实现 | `limits: IAgentLimits` (maxIterations / timeoutSecs / maxResponseTokens) |
| **技能定向文件** | Hermes, OpenClaw | 🟡 中 | ✅ 已实现 | `skillDirectives: ISkillDirective[]` (path / autoActivate / activation) |
| **后台执行** | OpenHuman | 🟢 低 | ✅ 已实现 | `background: boolean` |
| **MCP 服务器** | VS Code | 🔴 高 | ❌ 待实现 | 在 `Employee` 中增加 `mcpServers` 字段 |
| **向量记忆** | Hermes, OpenClaw, OpenHuman | 🟡 中 | ❌ 待实现 | 集成向量嵌入，支持语义搜索 |
| **委派模式** | OpenClaw | 🟢 低 | ❌ 待实现 | 增加 `delegationMode: suggest \| prefer` |
| **Hook OS 覆盖** | VS Code | 🟢 低 | ❌ 待实现 | 在 `IAgentHookEntry` 中增加 `windows/linux/osx` 命令覆盖 |
| **Agent 启用/禁用** | VS Code | 🟢 低 | ❌ 待实现 | 增加 `enabled: boolean` |

### 8.2 各项目的独特优势

| 项目 | 独特优势 |
|------|---------|
| **VS Code** | 最简洁的格式（.agent.md 单文件），MCP 服务器支持，OS 级 Hook 覆盖 |
| **Hermes** | 三层提示词架构最成熟，Skill Bundle 组合系统，20+ 平台 Gateway 适配 |
| **OpenClaw** | 模型 fallback 链 + thinking 模式控制，QuickJS 沙箱技能运行时，多通道适配 |
| **OpenHuman** | Rust 性能，`ModelSpec::Inherit` 继承链，`SandboxMode::ReadOnly` 安全沙箱，`SubagentEntry::Skills` 按技能匹配 |
| **本项目** | 画布可视化 + 连线编辑，Git Worktree 隔离，ConfigMD 双向同步，五文件 Markdown 体系，运行时状态管理 |

### 8.3 互操作路线图建议

1. **Phase 1** ✅：完善 VS Code `.agent.md` 桥接 — 已补全 `temperature` / `sandbox` / `limits` / `skillDirectives` / `background` 导出
2. **Phase 2** ✅：对齐跨项目 Agent 数据模型 — 已实现 `ModelSpec`、`SandboxMode`、`IAgentLimits`、`ISkillDirective`
3. **Phase 3**：增加 OpenClaw YAML 导入器（YAML → Employee），复用 Agent 配置
4. **Phase 4**：增加 OpenHuman TOML 导入器，利用其 `SandboxMode` 和 `ModelSpec` 设计
5. **Phase 5**：定义跨项目 Agent 互操作规范（统一 ID schema、通用字段映射表）

---

## 附录 A：类型定义速查

### 本项目 Employee 关键字段

```typescript
interface Employee {
  id: string;                    // 唯一 ID
  name: string;                  // 显示名称
  role: string;                  // 角色描述 (对应 VS Code description)
  model?: ModelSpec;             // 模型规格: string | string[] | IModelChain
  tools?: string[];              // 工具白名单
  skills?: string[];             // 技能 ID 列表
  skillDirectives?: ISkillDirective[]; // 技能定向文件 (SKILL.md)
  handOffs?: IAgentHandOff[];    // 声明式 Hand-off
  hooks?: IAgentHooks;           // 生命周期 Hook
  visibility?: IAgentVisibility; // 可见性控制
  agents?: string[];             // 子 Agent 白名单
  target?: AgentTarget;          // 目标平台
  source?: AgentSource;          // 来源追踪
  status: EmployeeStatus;        // 运行时状态
  agentType?: AgentType;         // Planner / Worker
  sandbox?: SandboxMode;         // 沙箱模式: None / ReadOnly / Sandboxed
  limits?: IAgentLimits;         // 迭代/超时限制
  background?: boolean;          // 后台执行
  temperature?: number;          // LLM 温度
  maxTokens?: number;            // 最大 token 数
  worktreePath?: string;         // Git Worktree
  configMd?: AgentConfigMd;      // MD↔HTML 双向同步
  bootstrapTemplates?: AgentBootstrapTemplates;  // 五文件引导模板
}

// 模型备选链
type ModelSpec = string | string[] | IModelChain;
interface IModelChain { primary: string; fallbacks?: string[]; }

// 沙箱模式
const enum SandboxMode { None = 'none', ReadOnly = 'readOnly', Sandboxed = 'sandboxed' }

// 迭代/超时限制
interface IAgentLimits { maxIterations?: number; timeoutSecs?: number; maxResponseTokens?: number; }

// 技能定向文件
interface ISkillDirective { path: string; autoActivate?: boolean; activation?: 'manual' | 'auto' | 'always'; }
```

### OpenHuman AgentDefinition 关键字段

```rust
struct AgentDefinition {
  id: String,                    // 唯一 ID
  display_name: Option<String>,  // 显示名称
  when_to_use: String,           // 路由描述
  system_prompt: PromptSource,   // Inline / File / Dynamic(fn)
  model: ModelSpec,              // Inherit / Exact / Hint
  temperature: f64,              // 采样温度
  tools: ToolScope,              // Wildcard / Named(Vec<String>)
  disallowed_tools: Vec<String>, // 禁用工具
  sandbox_mode: SandboxMode,     // None / ReadOnly / Sandboxed
  max_iterations: usize,         // 迭代限制
  timeout_secs: Option<u64>,     // 超时
  subagents: Vec<SubagentEntry>, // 子 Agent (AgentId / Skills)
  agent_tier: AgentTier,         // Chat / Reasoning / Worker
  background: bool,              // 后台执行
}
```

### OpenClaw AgentConfig 关键字段

```typescript
type AgentConfig = {
  id: string,                               // 唯一 ID
  name?: string,                             // 显示名称
  description?: string,                      // 描述
  default?: boolean,                         // 默认 Agent
  model?: string | {primary, fallbacks},     // 模型 + 备选
  skills?: string[],                         // 技能白名单
  subagents?: {                              // 子 Agent
    delegationMode?: "suggest" | "prefer",
    allowAgents?: string[],
  },
  thinkingDefault?: string,                  // 思考模式
  reasoningDefault?: string,                 // 推理模式
  sandbox?: AgentSandboxConfig,              // 沙箱
  tools?: AgentToolsConfig,                  // 工具
  identity?: IdentityConfig,                 // 身份 (emoji, 主题)
  systemPromptOverride?: string,             // 系统提示词覆盖
  memorySearch?: MemorySearchConfig,         // 向量记忆搜索
  contextLimits?: AgentContextLimitsConfig,  // 上下文限制
}
```
