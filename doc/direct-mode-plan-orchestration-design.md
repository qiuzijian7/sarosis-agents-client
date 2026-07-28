# Direct Model Call 路径下 Plan 模式 Subagent 派发方案设计

> 2026-07-18

## 问题

Direct model call 路径（`agentTurnExecutor.ts`）缺少 ExecutionProvider 中的 plan
confirmation → orchestration → subagent dispatch 流程。即使 LLM 正确调用了
`exit_plan_mode`，handler 只返回文本"Plan submitted: N task(s) ready"，不触发后续。

## 现有架构对比

| 阶段 | ExecutionProvider | Direct Model (当前) | 说明 |
|------|------------------|---------------------|------|
| LLM 工具调用 | 循环内逐批处理 | 循环内逐批处理 | ✅ 一致 |
| `exit_plan_mode` 拦截 | 有（L395-429）| 无 | ❌ 缺失 |
| confirmation delta 弹出 | `yield { type: 'confirmation' }` | 无 | ❌ 缺失 |
| 用户审批挂起 | 循环 break，等 `executeAgentTurn` 再调用 | 无 | ❌ 缺失 |
| OrchestrationPlan 创建 | TaskOrchestrationService | 无 | ❌ 缺失 |
| Subagent 派发 | ExecutionProvider 图执行 | 无 | ❌ 缺失 |

## 设计目标

1. **Plan 确认卡片**：LLM 调用 `exit_plan_mode` 后，弹出确认卡片让用户审批
2. **审批后自动执行**：用户批准后，自动创建 OrchestrationPlan + 派发 subagent
3. **最小侵入**：复用 Direct Mode 已有的 sandbox confirmation 模式
4. **不重复**：不复制 ExecutionProvider 整个循环，仅抽取关键的 confirmation 逻辑

## 方案设计

### 插入位置

`agentTurnExecutor.ts` 的主循环（`while (iteration < MAX_TOOL_ITERATIONS)`）中，
在工具执行完成后、loop decision 之前插入。精确位置：

```
agentTurnExecutor.ts 行 1785 之后（local tool execution block 结束）
                                  ↓
[新增] Step A: 检测 exit_plan_mode → yield confirmation → await 用户决策
                                  ↓
[现有] Step B: shouldTerminateToolBatch / codebase ops / memory write
```

这样不会影响现有的沙箱确认流程（沙箱确认在工具结果处理**时** inline 处理，新逻辑在工具结果处理**完成后**）。

### 核心流程（伪代码）

```typescript
// 在行 1785 之后，local tool execution block 结束后

// ── Step A: Plan confirmation（对齐 ExecutionProvider 7.6a）────────
if (request.chatMode === 'plan') {
    // 检查所有 tool call（不只 local，因为理论上有可能是 server-executed）
    const exitPlanCall = effectiveToolCalls.find(tc => tc.name === 'exit_plan_mode');
    if (exitPlanCall) {
        // 1. 解析参数
        let args: any;
        try {
            args = typeof exitPlanCall.arguments === 'string'
                ? JSON.parse(exitPlanCall.arguments)
                : exitPlanCall.arguments;
        } catch { args = {}; }

        // 2. 构建确认卡片数据
        const confirmationId = `plan-${Date.now().toString(36)}`;
        yield {
            type: 'confirmation',
            confirmationData: {
                id: confirmationId,
                type: 'plan-approval' as const,
                title: 'Plan Approval',
                planSummary: args?.plan_summary || '',
                tasks: (args?.tasks || []).map((t: any) => ({
                    title: t.title || '',
                    description: t.description || '',
                    files: t.files || [],
                    complexity: t.complexity,
                    suggestedRole: t.suggestedRole,
                    dependencies: t.dependencies,
                })),
                nextMode: args?.next_mode || 'craft',
            },
        };

        // 3. 等待用户审批（复用 sandbox 等待模式）
        const decision = await host._awaitPlanApproval(confirmationId);
        yield {
            type: 'confirmation_resolved',
            confirmationId,
            confirmationStatus:
                decision === 'approved' ? 'approved'
                : decision === 'rejected' ? 'rejected'
                : 'pending',
        };

        // 4. 审批通过：创建 OrchestrationPlan 并派发 subagent
        if (decision === 'approved') {
            yield* host._orchestratePlan(
                request,
                args ?? {},
                exitPlanCall.id,
            );
        }

        // 5. 无论审批结果，plan 模式结束
        yield { type: 'done' };
        break;  // 退出 while 循环
    }
}
```

### 新增方法（在 `agentOSService.ts` 或独立模块中）

#### `_awaitPlanApproval(confirmationId: string): Promise<'approved' | 'rejected' | 'cancelled'>`

复用沙箱确认的等待机制：前端看到确认卡片 → 用户点击 Approve/Reject →
通过 IPCS 或 callback 发回决策 → 此 Promise resolve。

实现可选：
- **方案 A**：在 `agentOSService` 中加一个类似 `_sandboxGuard` 的 plan approval guard
- **方案 B**：复用 `_sandboxGuard` 扩展（因为确认卡片的 UI 流程相同，只是卡片内容和后续操作不同）

推荐**方案 A**（独立 guard），保持关注点分离，但用相同的 Promise pattern。

#### `_orchestratePlan(request, args, toolCallId): AsyncGenerator<IChatStreamDelta>`

审批通过后的编排流程：

```typescript
async *_orchestratePlan(request, args, toolCallId) {
    const planSummary = args.plan_summary || '';
    const tasks = args.tasks || [];
    const nextMode = args.next_mode || 'craft';

    // 1. 创建 OrchestrationPlan
    const plan = await this._taskOrchestrationService.createPlan({
        goal: planSummary,
        tasks: tasks.map((t: any) => ({
            title: t.title,
            description: t.description,
            files: t.files || [],
            complexity: t.complexity || 'medium',
            suggestedRole: t.suggestedRole,
            dependencies: (t.dependencies || []).map((d: string) => {
                const idx = tasks.findIndex((tt: any) => tt.title === d);
                return idx >= 0 ? tasks[idx].title : d;
            }),
        })),
        workspaceId: request.workspaceId || this._currentWorkspaceId,
        plannerId: request.agentId,
    });

    // 2. 产出 plan 创建事件
    yield { type: 'plan_created', metadata: { planId: plan.id, taskCount: tasks.length } };

    // 3. 为每个 task 创建/分配 agent
    for (const task of tasks) {
        yield { type: 'text', content: `\n🔧 Assigning task: "${task.title}"...` };
        // 调用 TaskOrchestrationService.assignAgents
        yield* this._taskOrchestrationService.assignAndExecute(plan.id, task);
    }

    // 4. 可选：建议切到 craft 模式继续
    if (nextMode === 'craft') {
        yield {
            type: 'text',
            content: '\n\n✅ Plan approved and tasks assigned. Switch to CRAFT mode to begin execution.',
        };
    }
}
```

### 需要复用的已有机制

| 机制 | 来源 | 用途 |
|------|------|------|
| `yield { type: 'confirmation' }` | `agentTurnExecutor.ts:1704` | 弹出确认卡片 |
| `await host._awaitSandboxConfirmation(id)` | `agentOSService.ts:458` | Promise 挂起等用户决策 |
| `yield { type: 'confirmation_resolved' }` | `agentTurnExecutor.ts:1706` | 通知前端决策结果 |
| `yield { type: 'done' }` + `break` | `executionProvider.ts:426-427` | 退出 agent loop |
| `TaskOrchestrationService.createPlan` | `taskOrchestrationService.ts` | 创建 OrchestrationPlan |

## 改动清单

### 1. `agentTurnExecutor.ts`（核心改动）
- 行 ~1785 之后：新增 `exit_plan_mode` 拦截逻辑（~50 行）
- 依赖注入：`host._awaitPlanApproval()` 和 `host._orchestratePlan()`（从 agentOSService 透传）

### 2. `agentOSService.ts`（新增方法）
- `_awaitPlanApproval(confirmationId): Promise<'approved' | 'rejected'>`
- `_orchestratePlan(request, args, toolCallId): AsyncGenerator<IChatStreamDelta>`

### 3. `compatibilityTools.ts`（已有，可能需要微调）
- 当前 `exit_plan_mode` handler 返回文本，不影响拦截逻辑（拦截发生在工具执行后、handler 结果已入 messages）

## 风险与注意事项

1. **确认卡片渲染**：前端已有 `confirmation` delta 的处理（sandbox 卡片），但 `plan-approval` 类型的卡片可能需要前端新模板。需要确认或新增 plan 卡片的渲染。

2. **审批后消息状态**：`exit_plan_mode` 的工具结果是 "Plan submitted: N task(s) ready" 文本，已在 messages 中。审批通过后需要追加 system 消息表示计划已执行。

3. **模式切换**：`exit_plan_mode` 建议 `next_mode: 'craft'`，但实际切换需要用户手动操作。可以在审批通过后提示用户切换。

4. **存量 plan 恢复**：如果用户关闭了确认卡片（cancel），不需要清理（plan 未生效，对话可继续）。

5. **与 ExecutionProvider 的后期合并**：如果将来 ExecutionProvider 路径也被废弃，
   可以把 plan 拦截从 ExecutionProvider 移除，统一走 Direct Mode 路径。
