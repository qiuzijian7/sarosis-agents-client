# Goal 工作流实现总结

## 已完成的工作

### 1. 创建内置 Goal 工作流定义
**文件**: `resources/.agents/builtin-workflows/goal-workflow.json`

**工作流结构**:
```
Start → Agent (执行目标步骤) → Judge (评估完成状态)
  → IfElse (检查评估结果)
    → branch-done → End (Goal Completed)
    → branch-continue → Check Turns (检查轮次预算)
        → branch-exhausted → End (Budget Exhausted)
        → branch-within-budget → Loop Back (准备下一轮) → Agent (循环)
```

**关键节点**:
- `node-start`: 工作流入口
- `node-agent`: Prompt 节点，执行目标步骤（使用 `{{goal}}` 和 `{{progress}}` 变量）
- `node-judge`: Prompt 节点，评估目标是否完成（使用 Judge prompt）
- `node-if-else`: IfElse 节点，根据 `node-judge.output.done` 分支
- `node-check-turns`: IfElse 节点，检查 `turnsUsed >= maxTurns`
- `node-loop-back`: Prompt 节点，准备下一轮执行的 prompt
- `node-end-success`: 结束节点（目标完成）
- `node-end-exhausted`: 结束节点（轮次用尽）

### 2. 实现 GoalWorkflowService
**接口文件**: `src/vs/sessions/contrib/agentStudio/common/goalWorkflowService.ts`
**实现文件**: `src/vs/sessions/contrib/agentStudio/browser/goalWorkflowService.ts`

**服务接口** (`IGoalWorkflowService`):
- `getCurrentGoal()`: 获取当前 Goal
- `setGoal(goal, options)`: 设置 Goal（创建 Goal 对象，状态设为 Running）
- `clearGoal()`: 清除 Goal
- `pauseGoal()`: 暂停 Goal 执行
- `resumeGoal()`: 恢复 Goal 执行
- `evaluateGoal(goal, agentOutput)`: 评估 Goal 执行结果（Judge）
- `evaluateAfterTurn(goalId, agentOutput)`: Turn 完成后调用，评估是否继续 Goal 循环
- `loadBuiltinGoalWorkflow()`: 加载内置 Goal 工作流定义
- `executeGoalWorkflow(goalId)`: 执行 Goal 工作流
- `cancelGoal(goalId)`: 取消 Goal 执行

**状态管理**:
- Goal 状态持久化到 `IStorageService` (`saros.goal.current` key)
- 支持的状态: `Idle`, `Running`, `Paused`, `Completed`, `Failed`, `Cancelled`

### 3. Judge 评估节点详细设计

**Judge Prompt 设计**:
```
你是目标完成度评估器，负责客观评估 Agent 输出是否达成用户目标。

用户目标：{goal}
Agent 输出：{agentOutput}

请评估目标是否已完成。返回 JSON 格式：
{"done": true/false, "reason": "评估理由", "nextStep": "建议的下一步"}

判断标准：
- done=true: 目标已明确完成，或 Agent 明确表示无法继续，或陷入死循环
- done=false: 目标未完成，且有明确的下一步可执行

示例：
- Agent 输出"目标已完成" → done=true
- Agent 输出错误信息且无法恢复 → done=true
- Agent 输出部分结果但需要更多工作 → done=false
```

**LLM 调用方式**:
- 使用辅助模型 (auxiliary model)，不占用主模型 quota
- 调用服务: `IAgentChatService.sendMessage()` 或 `IModelProvider.chat()`
- Model 选择: 从配置读取 `AGENT_STUDIO_AUX_GOAL_JUDGE_PROVIDER/MODEL`
- Temperature: 0 (确定性判断)
- Max tokens: 500 (只需要 JSON 输出)

**响应解析**:
- 使用 `JSON.parse()` 解析响应
- 容错: 如果响应被 markdown code block 包裹，先提取 JSON
- 验证: 检查 `done` 是 boolean，`reason` 是 string
- 如果解析失败: 视为 fail-open，返回 `done=false`

**错误处理**:
- LLM 调用失败: 重试 1 次，如果仍失败 → fail-open (`done=false`)
- 解析失败: 计数 +1，如果连续失败 ≥3 → auto-pause goal
- Timeout: 设置 10s timeout，超时 → fail-open

**Fail-Open 策略**:
- Judge 失败不阻断进度，返回 `done=false` (继续循环)
- 连续失败 3 次后自动 pause goal（避免无限循环）

### 4. 服务注册
**文件**: `src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts`

**修改内容**:
- 添加 import: `import { IGoalWorkflowService, GoalWorkflowService } from '../common/goalWorkflowService.js';`
- 添加注册: `registerSingleton(IGoalWorkflowService, GoalWorkflowService, InstantiationType.Delayed);`

## 整体设计架构

### Goal 循环执行流程
```
用户设置 Goal (/goal <text>)
  → GoalWorkflowService.setGoal() 创建 Goal 对象 (status=Running)
  → 开始执行循环:
    1. Agent 执行当前步骤 (使用 goal + progress 作为 context)
    2. Judge 评估 (调用辅助 LLM 评估 agentOutput)
    3. 如果 done=true → Goal 完成 (status=Completed)
    4. 如果 done=false:
       - 检查 turnsUsed >= maxTurns?
       - 是 → Goal 失败 (status=Failed)
       - 否 → turnsUsed++, 更新 progress, 继续循环 (回到步骤1)
  → 循环结束
```

### 与 Hermes-Agent 的对比
| 特性 | Hermes-Agent (Python) | Saros (TypeScript) |
|------|---------------------|---------------------|
| Goal 存储 | `~/.config/hermes/goals.json` | `IStorageService` (浏览器存储) |
| Judge 实现 | `hermes_cli/goals.py:GoalManager.evaluate_after_turn()` | `GoalWorkflowService.evaluateGoal()` |
| Judge 模型 | `auxiliary_client` (独立 client) | `IAgentChatService` + aux config |
| 工作流定义 | Python 代码 (hardcoded) | JSON 文件 (`goal-workflow.json`) |
| 工作流执行 | Python 循环 (`continue_goal_loop`) | `WorkflowExecutionService` (通用执行器) |

### 优势
1. **内置工作流**: 随产品发布，用户无需额外安装
2. **可视化编辑**: 用户可在 Agent Studio 中查看/编辑 Goal 工作流
3. **通用执行器**: 复用 `WorkflowExecutionService`，支持断点调试、追踪等高级功能
4. **类型安全**: TypeScript 实现，编译时类型检查

## 下一步工作

### 必须实现
1. **Judge LLM 调用**: 实现真正的 LLM 调用（目前是 mock）
   - 需要集成 `IAgentChatService` 或 `IModelProvider`
   - 需要读取 aux model 配置
2. **Goal 工作流部署**: 实现 `executeGoalWorkflow()` 方法
   - 将内置工作流复制到 `.sarosworkspace/workflows/`
   - 替换变量 (`goal`, `progress`, `turnsUsed`, `maxTurns`)
   - 调用 `WorkflowExecutionService.executeWorkflow()`
3. **CLI 命令**: 添加 `/goal` 命令到 chat CLI
   - `/goal <text>`: 设置 Goal
   - `/goal pause/resume/clear`: 管理 Goal
   - `/goal status`: 查看 Goal 状态

### 可选增强
1. **Kanban 集成**: 支持从看板任务自动创建 Goal
2. **子目标 (Subgoals)**: 支持将大 Goal 分解为子目标
3. **进度可视化**: 在 UI 中显示 Goal 进度（turns used/max, current status）
4. **Goal 模板**: 预定义的 Goal 模板（代码审查、Bug 修复等）

## 文件清单
- `resources/.agents/builtin-workflows/goal-workflow.json` - 内置 Goal 工作流定义
- `src/vs/sessions/contrib/agentStudio/common/goalWorkflowService.ts` - 服务接口
- `src/vs/sessions/contrib/agentStudio/browser/goalWorkflowService.ts` - 服务实现
- `src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts` - 服务注册 (已修改)

## 测试建议
1. **单元测试**: 测试 `GoalWorkflowService` 的状态管理逻辑
2. **集成测试**: 测试完整的 Goal 循环执行流程
3. **E2E 测试**: 在 Agent Studio UI 中测试 Goal 工作流执行
