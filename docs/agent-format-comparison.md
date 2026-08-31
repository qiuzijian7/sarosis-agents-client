# Agent 定义格式与目录结构 · 跨项目调研对比

调研对象：本项目 VsSaros / VS Code Copilot / Claude Code / opencode / OpenHands
调研日期：2026-08-31
本项目真源：`common/agentMdFormat.ts`、`browser/agentStudioService.ts`、`resources/.agents/agents/`

---

## 一、结论速览

| 维度 | **VsSaros（本项目）** | **VS Code / Copilot** | **Claude Code** | **opencode** | **OpenHands** |
|---|---|---|---|---|---|
| 文件组织 | **每 agent 一个目录** `{id}/.agent.md` | 扁平文件 `.github/agents/{name}.agent.md` | 扁平文件 `.claude/agents/{name}.md`（可递归子目录） | `AGENTS.md` + `opencode.json` | `microagents/` 目录 |
| 标识来源 | `id`（ASCII slug，= 目录名，必需） | `name` 或**文件名** | `name`（必需，文件名不必匹配） | JSON key | `name` |
| 作用域层级 | 2 级（内置产品源 / 用户目录） | 4 级（workspace / user / org / extension） | **5 级**（managed > CLI > project > user > plugin） | 全局 + 项目 | 3 类（Repo / Knowledge / Task） |
| 可随仓库提交 | ❌ 仅全局 `~/.vssaros/agents/` | ✅ `.github/agents/` | ✅ `.claude/agents/` | ✅ `opencode.json` | ✅ `microagents/` |
| 内置 agent 可编辑 | ❌ 只读，编辑走"覆写" | ❌ 内置不可改 | ✅ 同名用户文件覆盖内置 | 内置 4 个 | — |
| 覆写语义 | 用户目录同名 → 覆写内置 | 高优先级位置胜出 | **就近原则**（嵌套目录取最近 cwd） | 同级取第一个匹配 | — |
| frontmatter 字段量 | **最多**（标准 + 20+ 扩展） | 中等 | 多 | 少（JSON 配置） | 少 |
| 配套资源目录 | ✅ agent 目录可放 `config.html`/资产 | 引用 `.github/skills/` | `skills` 预加载 + `mcpServers` 内联 + `memory` 目录 | `instructions` 引用外部文件 | `microagents/` 知识库 |
| Agent 版本管理 | ✅ 每 agent 独立 git 仓库 | ❌ | ❌ | ❌ | ❌ |
| LLM 自建 agent | ✅ `new_agent` 工具（Cautious 需审批） | ✅ `/create-agent` | ✅ 让 Claude 写文件 | ❌ | ❌ |
| 触发方式 | LLM 读 description 自主判断 | 用户切换 + handoff | LLM 自主委托 + @-mention | Tab 切换 / @ 提及 | **triggers 关键词自动触发**（Knowledge 型） |

---

## 二、各方案详解

### 2.1 本项目 VsSaros

**目录结构**
```
resources/.agents/agents/            # 内置（产品源，只读）
  ├─ code-reviewer/.agent.md
  ├─ researcher/.agent.md
  └─ ...（15 个内置 agent，各占一个目录）

~/.vssaros/agents/                   # 用户（唯一可写）
  └─ {id}/
      ├─ .agent.md                   # 定义（YAML frontmatter + Markdown body）
      ├─ config.html                 # 可选：配置面板 UI
      └─ .git/                       # 每 agent 独立版本仓库
```

**frontmatter**（`agentMdFormat.ts:190` buildAgentMd / `:244` parseAgentMd）
- *VS Code 标准字段*：`name`、`description`、`model`、`tools`、`icon`、`handoffs`、`agents`、`hooks`、`providerId`
- *扩展字段*：`id`、`role`、`category`、`source`、`owner`、`version`、`storeId`、`skills`、`enabledToolsets`/`disabledToolsets`、`temperature`、`status`、`sortOrder`、`avatar`、`confidenceThreshold`、`parallelStrategy`、`sandbox`、`configHtml`、`visibility`、`paradigm`、`budgetMaxTotal`、`createdAt`、`updatedAt`

**创建方式**：UI 弹窗（`CreateAgentModal`）｜LLM 工具 `new_agent`（`delegationTools.ts:149`）｜文件夹导入 `installAgentFromFolder`（`:1339`）

**合并规则**（`agentStudioService.ts:624`）：`builtinAgents.map(a => userOverrides.get(a.id) ?? a)` + `customAgents`
**启动清理**（`:1167`）：持续删除用户目录内所有内置同名目录，保证产品源始终生效。

---

### 2.2 VS Code / GitHub Copilot

来源：https://code.visualstudio.com/docs/agent-customization/custom-agents

**位置**
| Scope | 路径 |
|---|---|
| Workspace | `.github/agents/`（任意 `.md` 均识别） |
| Workspace（Claude 格式） | `.claude/agents/`（纯 `.md`） |
| User profile | `~/.copilot/agents/` |
| Organization | GitHub org 级，需开启 `github.copilot.chat.organizationCustomAgents.enabled` |

**frontmatter**：`name`、`description`、`argument-hint`、`tools`（数组，支持 `<server>/*`）、`agents`（子代理白名单，`*` 全允许 / `[]` 全禁）、`model`（字符串或优先级数组）、`user-invocable`、`disable-model-invocation`、`target`、`mcp-servers`、`handoffs`（`label`/`agent`/`prompt`/`send`/`model`）、`hooks`（Preview）

**要点**：body 用 Markdown 写指令，可用 `#tool:<name>` 引用工具；优先级上 prompt file 的 `tools` 高于 agent；原 `.chatmode.md` 已重命名演进为 `.agent.md`。

---

### 2.3 Claude Code

来源：https://code.claude.com/docs/zh-CN/sub-agents

**位置与优先级**（高 → 低）
1. 托管设置（managed settings）目录内 `.claude/agents/`
2. `--agents` CLI 标志（JSON，仅当前会话，不落盘）
3. 项目 `.claude/agents/`（**可递归子目录**，如 `agents/review/`；嵌套项目取离 cwd 最近）
4. 用户 `~/.claude/agents/`（递归扫描）
5. Plugin 的 `agents/` 目录（子文件夹成为 scoped id：`my-plugin:review:security`）

**frontmatter**（仅 `name`/`description` 必需）
`name`、`description`、`tools`、`disallowedTools`、`model`（`sonnet`/`opus`/`haiku`/`inherit`/完整 ID）、`permissionMode`、`maxTurns`、`skills`（**启动时把技能全文注入上下文**）、`mcpServers`（可内联定义，父会话不可见）、`hooks`（PreToolUse/PostToolUse/Stop）、`memory`（`user`/`project`/`local` 持久目录）、`background`、`effort`、`isolation`（`worktree` 隔离仓库副本）、`color`、`initialPrompt`

**要点**：身份**仅来自 `name`**，文件名不必匹配；同目录重名时按文件系统读取顺序只加载一个（无文档化优先级，`/doctor` 会检查）；subagent 默认后台运行；嵌套深度上限 5。

---

### 2.4 opencode

- 规则：`AGENTS.md`（当前目录向上查找 → 全局 `~/.config/opencode/AGENTS.md` → 回退 `~/.claude/CLAUDE.md`）。**同级只取第一个匹配**。
- Agent：`opencode.json` 声明，分 **Primary**（Tab 切换，内置 `Build`/`Plan`）与 **Subagent**（`@` 提及，内置 `General`/`Explore`）。
- 扩展规则：`opencode.json` 的 `instructions` 字段可引用外部文件（如 `CONTRIBUTING.md`），无需复制进 `AGENTS.md`。

### 2.5 OpenHands

- `microagents/` 目录，Markdown + frontmatter（`name`、`agent`、`version`、`triggers` 等）。
- **三类型**：
  - `RepoMicroagent` — 始终加载（等价 `AGENTS.md` 仓库规范）
  - `KnowledgeMicroagent` — **关键词触发**，领域知识按需注入
  - `TaskMicroagent` — 带参数的任务模板
- 兼容读取 `.cursorrules` / `agents.md` / `agent.md` 等第三方命名。

---

## 三、与本项目的主要差异

### 3.1 目录式 vs 扁平文件（最核心差异）

| | 本项目 | VS Code / Claude Code |
|---|---|---|
| 形态 | `{id}/.agent.md`（固定文件名） | `{name}.agent.md` / `{name}.md`（文件名即 agent） |
| 一目录能否放多个 agent | ❌ 只能一个 | ✅ 一个目录多文件，各是一个 agent |
| 能否用子目录归类 | ❌ id 即目录名，扁平 | ✅ Claude Code 递归扫描，可 `agents/review/` |
| 配套文件 | ✅ 目录内可放 `config.html`、资产 | ❌ 只能靠外部引用 |

**评价**：目录式是"富 agent"载体（能塞 UI 配置、资产、独立 git 仓库），代价是不兼容扁平生态、一个目录只能有一个 agent。本项目 `installAgentFromFolder` 只认根目录 `.agent.md`，也正是这个约束。

### 3.2 标识：`id`（强约束） vs `name`（弱约束）

- 本项目 `id` **必需**且必须是 ASCII slug（字母开头，仅字母/数字/`-`/`_`），与目录名绑定。非 ASCII 名必须显式提供 `id`，否则 `new_agent` **直接报错**（`delegationTools.ts:189-198`）——因为中文名 slug 会剥离中文导致互相覆盖（「Saros记忆专家」/「Saros工作区专家」都 → `saros`）。
- Claude Code 身份仅来自 `name`（无 ASCII 限制），文件名可自由。
- VS Code 用文件名兜底 `name`。

**评价**：这是"**强约束换稳定**"的取舍。好处是目录路径可预测、可做商城（`storeId`/`owner`）与 git 版本管理；代价是 LLM 自建中文名 agent 会碰壁，且导入外部 agent 文件时需做 slug 归一。

### 3.3 作用域层级：2 级 vs 5 级（**最大生态差距**）

本项目只有「内置产品源 + 用户全局目录」两层，**没有 workspace 级**。后果：

- agent 定义**不能随仓库提交**，团队无法共享/评审/演进 agent（VS Code `.github/agents`、Claude Code `.claude/agents` 都能进版本控制）。
- 项目间差异只能靠 **binding**（`worktreePath`/`worktreeBranch`/`agentDir`/`memoryConfig`）承载，而 binding 存的是运行时状态，**不是定义**。
- 无 org / extension / plugin 分发层，内置 agent 只能随产品发版。

### 3.4 覆写机制

- **本项目**：内置只读 + 用户目录同名即覆写；`.agent.md` 不存在时 `updateAgent` **回退 `{...builtin}`**（`:1246-1251`）——这就是"用户首次编辑内置 agent → 复制成覆写"的路径。启动时还会删除用户目录里的内置同名目录。
- **Claude Code**：同 `name` 时高优先级位置胜出，嵌套目录取**离 cwd 最近**的一个；内置 Explore/Plan 可被同名用户文件覆盖且保留自己的 `model`。
- **VS Code**：无覆写概念，各处 agent 并列展示，靠位置区分来源（诊断视图可看来源）。

**评价**：本项目"内置只读 + 覆写"更利于产品升级不丢用户改动，但语义比 Claude 的就近覆盖更绕（用户不显式知道自己改的是覆写还是原定义）。

### 3.5 字段丰富度

本项目 frontmatter 字段**远超**其他项目，但分两类：
- 与 VS Code/Claude 对齐的（`name`/`description`/`model`/`tools`/`handoffs`/`agents`/`hooks`）→ 好，利于生态互通
- 产品专属扩展（`configHtml`/`sandbox`/`budgetMaxTotal`/`parallelStrategy`/`visibility`/`owner`/`storeId`/`enabledToolsets`）→ 是 IDE 产品 vs CLI 工具的定位差异，Claude Code 不需要"商城"和"配置面板 UI"

**缺口**（对标 Claude Code）：无 `mcpServers` 内联、无 `memory` 持久目录、无 `isolation: worktree`、无 `maxTurns`/`effort`、无 `triggers` 关键词触发。

> 注意 `isolation: worktree` 与本项目 binding 里的 `worktreePath` 形似但**语义不同**：前者是"为单次运行开临时隔离副本"，后者是"agent 绑定的长期工作树路径"。

---

## 四、本项目优缺点

### 优点
1. **目录式承载富 agent** —— `config.html` 配置面板、配套资产、每 agent 独立 git 仓库（`agentVersionService`），这是所有对比项目都没有的能力。
2. **双源分离干净** —— 内置产品源只读 + 用户目录唯一可写，升级绝不覆盖用户改动；启动时**持续**清理内置同名残留（非一次性 marker），保证产品源定义长期不漂移。
3. **兼容输入友好** —— `parseAgentMd` 容忍：`tools` 既接受数组也接受逗号分隔字符串（VS Code/Claude 两种写法）、`id` 缺失回退 `name` slug、`handoffs`/`handOffs` 双拼写、纯 VS Code 格式文件可直接吃。
4. **LLM 可自建且带审批** —— `new_agent` 安全等级 `Cautious`，需用户审批才落盘，比 Claude Code 的"让 Claude 直接写文件"更可控。
5. **版本管理** —— 每个 agent 目录一个 git 仓库 + `autoCommit`，agent 定义可回滚，其他项目均无。

### 缺点 / 风险
1. **❌ 无 workspace 级 agent（最致命）** —— 团队无法把 agent 定义提交进仓库共享，只能靠导出文件夹 / 商城分发。
2. **❌ 非 ASCII 名必须显式 id** —— LLM 自建中文名 agent 会直接报错，需多一轮交互纠正（Claude Code 无此限制）。
3. **❌ 一个目录只能一个 agent，不支持子目录归类** —— agent 数量增长后无法按域分组（Claude Code 可 `agents/review/`）。
4. **⚠️ 覆写语义隐晦** —— 用户编辑内置 agent 时实际创建的是「回退内置定义的覆写副本」，UI 上不易感知。
5. **⚠️ 无关键词触发** —— 只能靠 LLM 读 description 自主判断（与 Claude Code 相同）；OpenHands 的 `triggers` 可做确定性注入。
6. **⚠️ 无 `mcpServers` 内联 / `memory` 持久目录** —— 对比 Claude Code 是能力缺口。

---

## 五、可借鉴清单（按收益排序）

| 优先级 | 借鉴项 | 来源 | 收益 | 改动面 |
|---|---|---|---|---|
| **P0** | 支持工作区级 agent 目录（`.vssaros/agents/` 或兼容 `.github/agents/` + `.claude/agents/`） | VS Code + Claude Code | 团队可提交共享、按项目定制；顺带直接吃进两大生态的存量 agent | 新增第 3 个数据源并并入三级合并（`getAgents`） |
| **P1** | 兼容扁平命名 `{name}.agent.md`（一个目录可多 agent）+ 递归子目录 | Claude Code | 生态双向互通，支持按域归类 | `getAgents` 扫描逻辑 + `installAgentFromFolder` |
| **P2** | frontmatter 增加 `triggers` 关键词触发 | OpenHands Knowledge | 领域知识确定性注入，减少 LLM 判断失误 | 新增解析字段 + 注入时机 |
| **P2** | frontmatter 增加 `mcpServers` 内联 | Claude Code | 按需挂载 MCP，避免全局 MCP 污染上下文 | 运行时注入 |
| **P3** | 非 ASCII 名自动 slug 冲突消解（如追加短 hash / 提示可选 id）而非直接报错 | Claude Code | LLM 自建成功率更高 | `handleNewAgentTool` |
| **P3** | `memory` 持久目录声明 | Claude Code | agent 跨会话积累知识 | 新目录 + 提示注入 |

**不建议照搬**：
- Claude Code 的 `--agents` CLI JSON（本项目是 IDE，无 CLI 会话语义）
- Claude Code 的 `isolation: worktree`（本项目已有 binding 级 worktree 绑定，语义不同，引入会混淆）
- opencode「同级只取第一个匹配」的静默取舍（本项目显式三级合并更可预测）

---

## 附：关键真源索引

| 内容 | 位置 |
|---|---|
| `.agent.md` 序列化 / 解析 | `common/agentMdFormat.ts:190` / `:244` |
| 创建 agent | `browser/agentStudioService.ts:811` |
| 读取三级合并 | `browser/agentStudioService.ts:559` / `_loadAgentsInternal:582` |
| 内置源加载 | `browser/agentStudioService.ts:639` |
| 编辑 / 覆写 | `browser/agentStudioService.ts:1205` |
| 启动清理 | `browser/agentStudioService.ts:1167` |
| LLM 自建工具 | `browser/providers/tool/delegationTools.ts:149`（注册 `:877`） |
| 文件夹导入 | `browser/agentStudioService.ts:1339` |
| 内置 agent 清单 | `resources/.agents/agents/`（15 个） |
