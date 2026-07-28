# MiMo-Code vs Sarosis Plan Mode 对比分析

> 2026-07-18

## 核心差异一览

| 维度 | MiMo-Code | Sarosis（当前） | 影响 |
|------|-----------|----------------|------|
| **指令注入** | `<system-reminder>` 注入到**每条 user message** | System prompt 末尾（即使 prepend） | 🔴 长对话中 LLM 遗忘 |
| **Plan 载体** | **文件**：写 `.mimocode/plans/*.md` | **工具参数**：`exit_plan_mode(tasks=[...])` | 🟡 LLM 更擅长写文件 |
| **Plan 退出** | `plan_exit()` — 无参数，纯确认 | `exit_plan_mode(plan_summary, tasks, next_mode)` — 传 JSON | 🟡 参数复杂，LLM 难构造 |
| **权限层** | `hardPermission: { edit: {"*": "deny"} }` — 硬拒绝 | 仅 system prompt 提示 | 🟢 安全但不影响 LLM 行为 |
| **Agent 模型** | 独立 `plan` agent（切换 agent） | Chat mode（同一 agent 内切换） | 🟡 独立 agent 有清晰的边界 |
| **Subagent** | 主动 spawn `explore`/`general` subagent | 无 subagent 参与 | 🟡 并行探索效率更高 |
| **指令语气** | 极强的 DO/DON'T，5 阶段工作流 | 较温和的 "Your job is to..." | 🔴 关键差异 |

## 详细分析

### 1. `<system-reminder>` vs System Prompt（最关键差异）

**MiMo-Code**（`packages/opencode/src/session/prompt.ts:799-881`）：

在每条 user message 后追加一条 `synthetic: true` 的 text part：
```xml
<system-reminder>
Plan mode is active. The user wants you to research and design,
NOT to execute yet. This supersedes any other instructions you have received.

## What you SHOULD do (recommended)
- Prefer read-only tools...
- Spawn explore/general subagents for parallel research.

## What you MUST NOT do
- Do NOT edit or create any file other than the plan file.
- Do NOT run test/lint/typecheck/build.

## Plan Workflow
Phase 1: Initial Understanding → spawn explore subagents
Phase 2: Design → spawn general subagents
Phase 3: Review
Phase 4: Final Plan → write to plan file
Phase 5: Call plan_exit tool ← MUST end with this
</system-reminder>
```

LLM 在**每次回复前**都读到这段提醒。165K token 上下文也掩盖不住——因为它就在 user message 末尾。

**Sarosis**：

Plan 指令在 system prompt 中（即使 prepend 到最前），LLM 只在**对话开始时**读一次。165K token 的上下文中，这段指令被淹没在历史消息之后。

**建议**：在 `agentDriverService.ts` 或 `agentTurnExecutor.ts` 中，plan 模式下将 `<system-reminder>` 作为独立的 system/assistant message 注入到消息列表末尾，而不是拼到 system prompt 中。

### 2. 文件 Plan vs 工具参数 Plan

**MiMo-Code**：
- LLM 用 `write`/`edit` 工具写 plan 到 `.mimocode/plans/<session>.md`
- `plan_exit()` 无参数，只触发 Yes/No 对话框
- Plan 内容在文件中，用户可查看、编辑、保留

**Sarosis**：
- LLM 必须把 plan 打包成 JSON 传入 `exit_plan_mode(plan_summary, tasks=[{title, description, files, complexity, ...}])`
- 参数 schema 复杂，LLM 难以正确构造
- 165K token 上下文中 LLM 退化时可理解——它算不动复杂的 JSON

**建议**：简化 `exit_plan_mode` 为无参数或最小参数（类似 `plan_exit`）。Plan 内容可以让 LLM 通过 `update_plan` 逐步构建，或输出为文本后由系统解析。

### 3. 指令语气对比

**MiMo-Code**：
```
Plan mode is active. This supersedes any other instructions.
## What you MUST NOT do
- Do NOT edit files, Do NOT run test/lint...
Your turn should only end with either asking the user a question or calling plan_exit.
Do not stop unless it's for these 2 reasons.
```

**Sarosis**（`PLAN_MODE_SYSTEM_PROMPT_FULL`）：
```
You are in PLAN mode — a planning and task-decomposition assistant.
Your job is to analyze the user's request and produce a clear, structured plan.
```

MiMo 用的是**命令式 + 绝对否定**（"Do NOT", "MUST NOT", "supersedes any other instructions"），Sarosis 用的是**描述式 + 建议**（"You are in", "Your job is"）。

**建议**：改写 `PLAN_MODE_SYSTEM_PROMPT` 和 `PLAN_WORKFLOW_SECTION` 为 MiMo 风格的命令式语言。

### 4. Agent 边界

**MiMo-Code**：
- Plan 是独立 agent（`agent: "plan"`），有自己的 `hardPermission`、独立的 system prompt
- 进入/退出 plan mode 意味着切换 agent（消息头变更）
- Plan agent 看不到普通 agent 的 conversation history（干净上下文）

**Sarosis**：
- Plan 是同 agent 内的 chat mode（`chatMode: 'plan'`）
- 上下文包含所有历史消息（670+ messages，165K tokens）
- LLM 看到的历史消息让它认为"分析已完成"，不执行 plan 工作流

**建议**：Plan mode 启动时裁剪上下文（只保留最近 N 条 + plan 指令），避免历史对话污染。

### 5. Subagent 参与

**MiMo-Code** Plan 工作流明确指导 LLM spawn subagent：
- Phase 1：最多 3 个 `explore` subagent 并行探索
- Phase 2：最多 1 个 `general` subagent 设计方案

**Sarosis**：无 subagent 参与 plan 流程。LLM 自行探索。

## 建议的改进优先级

| 优先级 | 改动 | 预期效果 |
|--------|------|----------|
| **P0** | `<system-reminder>` 注入到消息列表末尾 | 165K token 也无法忽略 |
| **P0** | 简化 `exit_plan_mode` 为无参数 | LLM 退化时也能调 |
| **P1** | 改写 prompt 为命令式 + DO/DON'T | 更强的行为约束 |
| **P1** | Plan 模式压缩上下文 | 减少历史污染 |
| **P2** | Plan 模式 spawn subagent | 并行探索提高效率 |
