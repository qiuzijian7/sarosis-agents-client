# Goal 工作流实现 - 总结与后续计划

## 已完成的分析

### 1. 项目结构探索
- **Kanban (任务看板)**: `AgentTaskBoardService` 管理任务，已有 `workflowId` 字段
- **Workflow Execution**: `WorkflowExecutionService` 执行工作流，`executeWorkflow()` 方法
- **Agent Chat Service**: `IAgentChatService.sendMessage()` 发送消息给 agent
- **Task Orchestration**: `TaskOrchestrationService.executeTaskForBoard()` 执行任务

### 2. 需求分析

#### 需求 2: 不用实现 executeGoalWorkflow，采用任务看板中，选择 goal 工作流来驱动 goal
**发现**: 可能已经部分实现！
- `AgentTaskBoardService.updateTask()` 方法（第227行）在任务状态变为 `Running` 时，会调用 `orchestrationService.executeTaskForBoard()`
- `executeTaskForBoard()` 调用时已经传递 `workflowId: updated.workflowId`（第289行）
- 这意味着：当任务状态变为 Running 时，会执行关联的工作流

**待验证**: `executeTaskForBoard()` 是否真的使用 `workflowId` 来执行工作流？需要查看其实现。

#### 需求 4: Goal 工作流中，支持 goal agent 拆分子 agent
**发现**: 可能已经支持！
- 当前 `goal-workflow.json` 中的 `node-agent` 节点类型是 `prompt`
- `prompt` 节点会调用 agent 执行，agent 可以自主调用工具（包括 sub-agent 工具）
- 如果 agent 有 sub-agent 工具权限，它可以在执行过程中自主调用 sub-agent

**待验证**: `prompt` 节点类型是否真的会调用 agent？还是只是发送 prompt 给固定 agent？

#### 需求 1: 评估节点如何保证返回执行 json 格式
**方案**:
- **Prompt 工程 + 重试机制**（推荐，先实现）
- 在 Judge Prompt 中明确要求返回 JSON，并提供示例
- 解析失败时重试（最多2次），仍失败则 fail-open

#### 需求 3: Judge LLM 调用 - 实现真正的 LLM 调用
**方案**:
- 使用 `IAgentChatService.sendMessage()` 或 `IModelProvider.chat()`
- Judge 模型配置：从设置读取 `agentStudio.goalJudge.providerId/modelId`
- 实现 JSON 解析和容错逻辑

## 当前 goal-workflow.json 分析

### 工作流结构
```
Start → Agent (node-agent) → Judge (node-judge) → IfElse (node-if-else)
  → branch-done → End (node-end-success)
  → branch-continue → Check Turns (node-check-turns)
      → branch-exhausted → End (node-end-exhausted)
      → branch-within-budget → Loop Back (node-loop-back) → Agent (循环)
```

### 节点类型
- `node-start`: start - 开始节点
- `node-agent`: prompt - 执行目标步骤（调用 agent）
- `node-judge`: prompt - 评估目标完成状态（调用 judge agent）
- `node-if-else`: ifElse - 检查评估结果
- `node-check-turns`: ifElse - 检查轮次预算
- `node-loop-back`: prompt - 准备下一轮
- `node-end-success`: end - 目标已完成
- `node-end-exhausted`: end - 轮次用尽

### 问题
1. **Judge 节点是 prompt 类型**：这意味着它会调用一个 prompt，而不是专门的 judge 评估器。应该改为调用真正的 judge LLM。
2. **缺少 SubAgent 节点**：工作流中没有 sub-agent 节点，agent 只能在 prompt 节点中自主调用 sub-agent 工具。

## 后续行动计划

### 阶段 1: 验证现有实现（优先级：高）
**目标**: 确认需求 2 和需求 4 是否真的已经实现

1. **验证需求 2** (Kanban 集成):
   - 查看 `TaskOrchestrationService.executeTaskForBoard()` 实现
   - 确认它是否使用 `workflowId` 参数调用 `workflowExecutionService.executeWorkflow()`
   - 如果不是，修改它

2. **验证需求 4** (SubAgent 支持):
   - 查看工作流执行逻辑，确认 `prompt` 节点类型是否调用 agent
   - 确认 agent 是否有 sub-agent 工具权限
   - 如果没有，修改 goal 工作流或 agent 配置

### 阶段 2: 实现 Judge LLM 调用（优先级：中）
**目标**: 实现真正的 Judge 评估，替换 mock 实现

1. **修改 `GoalWorkflowService.evaluateGoal()`**:
   - 实现真正的 LLM 调用（使用 `IAgentChatService` 或 `IModelProvider`）
   - 添加 JSON 格式保证（Prompt 工程 + 重试）
   - 实现错误处理和 fail-open 策略

2. **设计 Judge Prompt**:
   ```
   你是目标完成度评估器，负责客观评估 Agent 输出是否达成用户目标。
   
   用户目标：{goal}
   Agent 输出：{agentOutput}
   
   请评估目标是否已完成。你必须只返回一个严格的 JSON 对象，不要有任何其他文字、解释或 markdown 格式。
   
   JSON 格式：
   {"done": true/false, "reason": "评估理由", "nextStep": "建议的下一步（如果未完成）", "needsDecomposition": false}
   ```

3. **实现 JSON 解析**:
   - 使用 `JSON.parse()` 解析响应
   - 容错：如果响应被 markdown 包裹，先提取 JSON
   - 验证：检查 `done` 是 boolean
   - 重试：解析失败时重试 2 次，仍失败则 fail-open

### 阶段 3: 修改 Goal 工作流（优先级：低）
**目标**: 优化工作流，支持更复杂的场景

1. **添加 SubAgent 节点**（如果需要）:
   - 在 Judge 评估后添加条件分支：如果需要拆解任务（`needsDecomposition=true`），则执行 SubAgent 节点
   - SubAgent 节点调用 `taskOrchestrationService.createPlan()` 拆解任务

2. **优化循环逻辑**:
   - 当前是简单循环，可以改为更智能的循环（根据 Judge 的 `nextStep` 建议）

## 文件清单

### 需要修改的文件
1. `src/vs/sessions/contrib/agentStudio/browser/goalWorkflowService.ts` - 实现 Judge LLM 调用
2. `resources/.agents/builtin-workflows/goal-workflow.json` - 优化工作流（可选）
3. `src/vs/sessions/contrib/agentStudio/browser/taskOrchestrationService.ts` - 验证/修改 `executeTaskForBoard()` 使用 workflowId
4. `src/vs/sessions/contrib/agentStudio/browser/agentTaskBoardService.ts` - 可能已经完成（Kanban 集成）

### 需要创建的文件
（无，所有修改都在现有文件上）

## 风险和建议

### 风险
1. **Judge LLM 调用可能失败**：需要实现重试和容错机制
2. **JSON 解析可能失败**：需要实现容错逻辑，Fail-open 策略
3. **SubAgent 节点可能不支持**：需要确认工作流执行逻辑是否支持 SubAgent 节点
4. **Kanban 集成可能不完整**：需要验证 `executeTaskForBoard()` 是否真的使用 `workflowId`

### 建议
1. **先验证再实现**：先验证需求 2 和 4 是否真的已经实现，避免重复工作
2. **使用 Mock 测试**：先使用 Mock LLM 测试整个流程，再接入真实 LLM
3. **分步实现**：先实现基本功能，再添加高级功能（如 SubAgent 节点）
4. **充分测试**：每个步骤完成后都要测试，确保功能正常

## 下一步

1. **验证需求 2**: 查看 `TaskOrchestrationService.executeTaskForBoard()` 实现，确认它是否使用 `workflowId`
2. **验证需求 4**: 查看工作流执行逻辑，确认 `prompt` 节点是否调用 agent，agent 是否有 sub-agent 工具权限
3. **实现 Judge LLM 调用**: 修改 `GoalWorkflowService.evaluateGoal()` 方法
4. **测试整个流程**: 创建任务 → 选择 Goal 工作流 → 执行 → 验证 Judge 评估

---

**当前状态**: 已完成分析，待验证和实现。
**估计剩余时间**: 4-8 小时（取决于验证结果和实现复杂度）
