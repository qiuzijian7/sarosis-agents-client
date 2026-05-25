# CodeBuddy IDE 聊天框模式分析：Craft、Ask、Plan

## 一、三种模式的定位

| 维度 | Ask（对话模式） | Craft（Agent 模式） | Plan（计划模式） |
|------|----------------|-------------------|-----------------|
| **核心定位** | 技术问答与概念解释 | 代码生成与局部修改 | 先规划后执行的自动化模式 |
| **是否修改代码** | 不直接修改代码 | 直接修改代码 | 先制定计划，确认后执行修改 |
| **适用场景** | 快速获取思路、查阅 API | 函数编写、小范围重构 | 跨文件修改、复杂功能开发 |
| **权限模式** | `default`（只读为主） | `acceptEdits`/`default` | `plan` → 用户确认后切换执行模式 |

---

## 二、三种模式对 System Prompt 的影响

三种模式通过 **三个维度** 影响 System Prompt：

### 1. 权限模式（Permission Mode）注入

系统有 7 种权限模式（`types/permissions.ts`），三种对话模式分别映射为：

- **Ask** → 对应 `default` 模式，每次需要权限的操作都询问用户，且工具集偏向只读（无文件写入工具）
- **Craft** → 对应 `acceptEdits` 模式，自动允许工作目录内的安全文件操作
- **Plan** → 对应 `plan` 模式，进入特殊的「只读探索+设计」权限状态

`plan` 模式的独特之处：AI 在此模式下只能执行只读操作（读文件、搜索代码等），**不能修改任何代码**。当 AI 调用 `EnterPlanModeTool` 进入 Plan 模式时，系统会：

```
handlePlanModeTransition(toolPermissionContextMode, "plan")
→ 设置 permissionContext.mode = "plan"
→ 注入 plan mode 的系统提示词
```

当用户批准计划后，`ExitPlanModePermissionRequest` 组件处理退出，此时可以选择后续权限模式：
- `yes-accept-edits` → 切换到 `acceptEdits`
- `yes-bypass-permissions` → 切换到 `bypassPermissions`
- `yes-default-keep-context` → 切换到 `default`

### 2. 工具池（Tool Pool）过滤

`assembleToolPool()`（`tools.ts:345-389`）根据模式过滤可用工具：

- **Ask 模式**：工具集最小化，偏向只读（Read、Grep、Glob、WebFetch 等），**不含** FileWrite、FileEdit、Bash 等写入工具
- **Craft 模式**：完整工具集（50+ 工具），包括文件读写编辑、Bash 执行、AgentTool 等
- **Plan 模式**：进入 Plan 后，可用工具受限为「只读+思考」：
  - 允许：Read、Grep、Glob（只读探索）
  - 允许：`EnterPlanModeTool`、`ExitPlanModeTool`、`AskUserQuestionTool`（Plan 专属工具）
  - 禁止：FileWrite、FileEdit、Bash（写入操作）

此外，Agent（子代理）不能使用 `ExitPlanModeTool`、`EnterPlanModeTool`、`AskUserQuestionTool`（`ALL_AGENT_DISALLOWED_TOOLS`），因为这些属于主线程抽象。

### 3. 系统提示词（System Prompt）定制

每个 Agent 定义（`AgentDefinition`）都有自己的 `getSystemPrompt()` 函数：

```typescript
{
  agentType: string
  getSystemPrompt: () => string  // 动态生成系统提示词
  tools: string[]                // 允许的工具
  permissionMode: string         // 权限模式
  // ...
}
```

**Ask 模式**的系统提示词会强调：
- 你是一个技术问答助手
- 不要直接修改代码文件
- 提供解释、建议和指导

**Craft 模式**的系统提示词会强调：
- 你是一个代码生成和修改的 Agent
- 可以直接读写文件、执行命令
- 对当前上下文进行精准修改

**Plan 模式**的系统提示词会强调：
- 你目前处于 Plan 模式
- 只能探索代码库和设计方案，**不能修改任何文件**
- 需要使用 `ExitPlanModeTool`（或 `ExitPlanModeV2Tool`）提交计划
- 计划经用户批准后才能执行

---

## 三、三种模式的实现机制

### Ask 模式实现

```
用户选择 Ask 模式
→ 设置 permissionMode = "default"
→ 工具池过滤：移除写入类工具（FileWrite, FileEdit, Bash）
→ 注入 Ask 模式的系统提示词（强调只回答、不修改）
→ 进入 Agentic Loop
```

### Craft 模式实现

```
用户选择 Craft 模式
→ 设置 permissionMode = "acceptEdits"
→ 工具池包含完整工具集
→ 注入 Craft 模式的系统提示词（强调代码生成和修改）
→ 进入 Agentic Loop
```

### Plan 模式实现（最复杂）

Plan 模式采用 **五阶段生命周期**：

```
需求澄清(Prepare) → 方案制定(Prepare) → 方案编辑/确认(Ready) → 方案实施(Building) → 方案完成(Finished)
```

具体实现流程：

```
1. 用户选择 Plan 模式
   → AI 调用 EnterPlanModeTool
   → 弹出 EnterPlanModePermissionRequest 弹窗
   → 用户确认后：
     - handlePlanModeTransition(mode, "plan")
     - 设置 permissionContext.mode = "plan"
     - 工具池切换为只读模式
     - 注入 Plan 模式系统提示词

2. Plan 阶段（探索+设计）
   → AI 只能读取文件、搜索代码
   → AI 设计方案并写入计划文件
   → 通过渐进式对话澄清需求
   → 生成包含需求分析/技术方案/视觉设计/任务列表的完整计划

3. 退出 Plan 模式
   → AI 调用 ExitPlanModeTool / ExitPlanModeV2Tool
   → 弹出 ExitPlanModePermissionRequest 弹窗
   → 用户可选择：
     - 批准执行（切换到 acceptEdits/bypassPermissions 模式）
     - 拒绝并反馈（继续 Plan 模式）
     - 选择是否清除上下文重新开始
   → 批准后：
     - 清除 Plan 模式约束
     - 恢复写入工具
     - 设置 initialMessage = "Implement the following plan: ..."
     - 可能清除上下文（clearContext: true）
     - 进入执行阶段

4. 执行阶段（Building）
   → 按任务列表逐步执行
   → 实时反馈进度
   → 完成后进入 Finished 状态
   → 计划保存到 .codebuddy/plans/ 目录
```

关键源码路径：
- `EnterPlanModeTool` / `ExitPlanModeTool`：Plan 模式切换的工具
- `EnterPlanModePermissionRequest`：进入 Plan 的权限弹窗组件
- `ExitPlanModePermissionRequest`：退出 Plan 的审批弹窗组件（最复杂，包含计划展示、编辑、权限切换逻辑）
- `handlePlanModeTransition()`：Plan 模式切换处理
- `assembleToolPool()`：根据模式组装工具池
- `hasPermissionsToUseToolInner()`：权限检查管线

---

## 四、总结

三种模式的核心差异在于对 **System Prompt 三大组成部分** 的控制：

| 影响维度 | Ask | Craft | Plan |
|---------|-----|-------|------|
| **系统提示词内容** | 强调只回答不修改 | 强调代码生成修改 | 强调只探索不执行 |
| **权限模式** | `default`（只读） | `acceptEdits`（允许编辑） | `plan`（只读探索）→ 确认后切换 |
| **可用工具集** | 只读工具子集 | 完整工具集 | Plan 期间只读 + Plan 专属工具 → 执行时完整工具集 |
| **Agentic Loop 行为** | 单轮问答为主 | 多轮工具调用 | 两阶段：规划→执行 |
