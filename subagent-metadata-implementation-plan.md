# SAC 借鉴 HA 设计：SubAgent 消息汇总改进实施路径

> 基于 HA（`delegate_tool.py`）的设计，规划 SAC（`unifiedSubAgentDispatch.ts` + `builtinToolProvider.ts`）的改进实施路径。
> 目标：让父 Agent 收到**结构化元数据**，而非纯文本输出。

---

## 一、现状问题（SAC 当前）

### 1.1 `SubAgentResult` 接口（信息量不足）

```typescript
// unifiedSubAgentDispatch.ts:119-124（当前）
export interface SubAgentResult {
    readonly success: boolean;
    readonly output?: string;   // ← 只有纯文本
    readonly error?: string;
    readonly completedAt: number;
}
```

**缺失的元数据**：
- ❌ 子 Agent 执行状态（`status: "completed"|"failed"|"timeout"|"interrupted"`）
- ❌ API 调用次数（`api_calls: number`）
- ❌ 执行耗时（`duration_ms: number`）
- ❌ Token 使用量（`token_usage: IModelUsage`）
- ❌ 工具调用追踪（`tool_trace: Array<{tool_name, preview, is_error}>`）

### 1.2 `_executeWithBudget` 返回值（只有文本）

```typescript
// unifiedSubAgentDispatch.ts:485-489（当前）
private async _executeWithBudget(
    executeFn: ...,
    request: IAgentTurnRequest,
    budget: IterationBudget,
): Promise<string> {   // ← 只返回 string（纯文本）
    let output = '';
    // ...只收集 delta.type === 'text' 的 content
```

### 1.3 `builtinToolProvider.ts` delegate_task handler（返回纯文本）

```typescript
// builtinToolProvider.ts:1019-1023（当前）
if (result.success) {
    return [{ type: 'text', text: result.output ?? '(no output)' }];
    // ↑ 父 Agent 只看到纯文本，无法基于元数据做决策
}
```

---

## 二、HA 设计参考（值得借鉴的点）

### 2.1 HA `delegate_task` 返回结构（`delegate_tool.py:1918+`）

```python
# HA 返回给父 Agent 的 JSON 结构
{
    "results": [
        {
            "task_index": 0,
            "status": "completed",          # 状态
            "summary": "找到 3 个相关文件...", # 文本摘要
            "api_calls": 5,                 # API 调用次数
            "duration_seconds": 12.3,       # 耗时
            "tool_trace": [                  # 工具调用追踪
                {"tool": "grep", "preview": "grep -r 'foo'...", "is_error": false},
                {"tool": "read", "preview": "read file.py", "is_error": false}
            ],
            "tokens": {"input": 1200, "output": 350},  # Token 使用
            "interrupted": false,
            "timeout": false
        }
    ],
    "summary": "并行执行了 3 个子任务，全部完成。"
}
```

### 2.2 HA 元数据收集方式（`delegate_tool.py:_run_single_child`）

| 元数据 | HA 收集方式 |
|--------|--------------|
| `status` | 检查 `result.get("interrupted")`, `result.get("completed")`, `result.get("final_response")` |
| `api_calls` | `child.get_activity_summary()["api_call_count"]` |
| `duration_seconds` | `time.monotonic() - child_start` |
| `tool_trace` | 遍历 `result.get("messages")`，提取 `tool_call` / `tool_result` 消息 |
| `tokens` | `result.get("usage")` 或 `child.get_activity_summary()["token_usage"]` |
| `summary` | `result.get("final_response")` |

---

## 三、SAC 改进方案（分 4 个阶段）

### 阶段 1：扩展 `SubAgentResult` 接口 + 元数据收集（≈ 2h）

**目标**：让 `_executeWithBudget` 返回结构化结果，而非纯文本。

#### 1.1 新建 `SubAgentMetadata` 接口

```typescript
// unifiedSubAgentDispatch.ts（新增）
export interface SubAgentToolTrace {
    readonly toolName: string;
    readonly preview: string;   // 工具调用的预览文本（前 80 字符）
    readonly isError: boolean;
    readonly durationMs?: number;
}

export interface SubAgentMetadata {
    readonly status: 'completed' | 'failed' | 'timeout' | 'interrupted';
    readonly apiCalls: number;        // tool_start 事件计数
    readonly durationMs: number;       // Date.now() 差值
    readonly tokenUsage?: IModelUsage; // 从 usage delta 收集
    readonly toolTrace: readonly SubAgentToolTrace[];
    readonly interrupted: boolean;
    readonly timedOut: boolean;
}
```

#### 1.2 扩展 `SubAgentResult`

```typescript
// unifiedSubAgentDispatch.ts（修改）
export interface SubAgentResult {
    readonly success: boolean;
    readonly output?: string;       // 保留，向后兼容
    readonly error?: string;
    readonly completedAt: number;
    /** HA 风格的结构化元数据（新增）*/
    readonly metadata?: SubAgentMetadata;
}
```

#### 1.3 修改 `_executeWithBudget` 返回值

```typescript
// unifiedSubAgentDispatch.ts（修改）
// 改返回值为 { output: string; metadata: SubAgentMetadata }
private async _executeWithBudget(...): Promise<{ output: string; metadata: SubAgentMetadata }> {
    const startTime = Date.now();
    let output = '';
    let apiCalls = 0;
    let tokenUsage: IModelUsage | undefined;
    const toolTrace: SubAgentToolTrace[] = [];
    let currentToolName: string | undefined;
    let currentToolStart: number | undefined;

    for await (const delta of stream) {
        if (delta.type === 'text' && delta.content) {
            output += delta.content;
        }
        if (delta.type === 'tool_start') {
            apiCalls++;
            currentToolName = delta.toolName;
            currentToolStart = Date.now();
        }
        if (delta.type === 'tool_end') {
            toolTrace.push({
                toolName: currentToolName ?? delta.toolName ?? 'unknown',
                preview: '',  // 需要从 tool_args 收集，或留空
                isError: delta.success === false,
                durationMs: currentToolStart ? Date.now() - currentToolStart : undefined,
            });
        }
        if (delta.type === 'usage' && delta.usage) {
            tokenUsage = delta.usage;  // 取最后一次 usage
        }
        // ...done/error/timeout 处理
    }

    const metadata: SubAgentMetadata = {
        status: hasError ? 'failed' : timedOut ? 'timeout' : 'completed',
        apiCalls,
        durationMs: Date.now() - startTime,
        tokenUsage,
        toolTrace,
        interrupted: false,
        timedOut,
    };

    return { output, metadata };
}
```

#### 1.4 修改 `executeSubAgent` 使用新返回值

```typescript
// unifiedSubAgentDispatch.ts（修改 executeSubAgent 方法）
const { output, metadata } = await Promise.race([executionPromise, timeoutPromise]);

subAgent.result = {
    success: true,
    output,
    completedAt: Date.now(),
    metadata,  // ← 新增
};
```

**阶段 1 完成标志**：`npm run build` 通过，`SubAgentResult` 包含 `metadata` 字段。

---

### 阶段 2：修改 `builtinToolProvider.ts` 返回结构化 JSON（≈ 1.5h）

**目标**：让 `delegate_task` handler 返回 JSON 字符串，而非纯文本。

#### 2.1 修改 `delegate_task` handler 返回值

```typescript
// builtinToolProvider.ts（修改 handler）
handler: async (args, _signal, agentId) => {
    // ...
    if (task) {
        const result = await dispatch.dispatch(agentId ?? 'unknown', task, executeFn, { type: SubAgentType.General });
        if (result.success) {
            // HA 风格：返回结构化 JSON
            const jsonResult = {
                status: result.metadata?.status ?? 'completed',
                summary: result.output ?? '(no output)',
                api_calls: result.metadata?.apiCalls ?? 0,
                duration_seconds: (result.metadata?.durationMs ?? 0) / 1000,
                tool_trace: result.metadata?.toolTrace ?? [],
                tokens: result.metadata?.tokenUsage,
            };
            return [{ type: 'text', text: JSON.stringify(jsonResult, null, 2) }];
        } else {
            return [{ type: 'text', text: JSON.stringify({
                status: 'failed',
                error: result.error ?? 'unknown error',
            }) }];
        }
    } else {
        // batch mode — 保持现有逻辑，但改用 JSON 格式
        const results = await dispatch.dispatchParallelExplore(...);
        const jsonResults = results.map((r, i) => ({
            task_index: i,
            status: r.metadata?.status ?? (r.success ? 'completed' : 'failed'),
            summary: r.output ?? '',
            api_calls: r.metadata?.apiCalls ?? 0,
            duration_seconds: (r.metadata?.durationMs ?? 0) / 1000,
        }));
        return [{ type: 'text', text: JSON.stringify({ results: jsonResults }, null, 2) }];
    }
}
```

#### 2.2 兼容性考虑

- **旧版 Agent（不识别 JSON）**：JSON 是纯文本，旧版 Agent 会把它当普通文本处理，不会崩溃
- **新版 Agent（识别 JSON）**：可以 `JSON.parse()` 后基于 `status`/`api_calls` 做决策

**阶段 2 完成标志**：`delegate_task` 返回 JSON 字符串，父 Agent 可解析元数据。

---

### 阶段 3：AgentOS 提示词更新（≈ 1h）

**目标**：让 Agent 知道 `delegate_task` 返回的是 JSON，并指导它如何基于元数据做决策。

#### 3.1 修改 `builtinToolProvider.ts` 中 `delegate_task` 的 `description`

```typescript
// builtinToolProvider.ts（修改 inputSchema.description）
description: 'Delegate a task to a sub-agent. ' +
    'Returns a JSON object with status, summary, api_calls, duration_seconds, tool_trace, and tokens. ' +
    'Use the status field to check if the sub-agent succeeded. ' +
    'Use api_calls and duration_seconds to assess efficiency. ' +
    'The summary field contains the sub-agent\'s text output.',
```

#### 3.2 修改 Agent 系统提示词（optional）

如果 Agent 需要主动基于元数据决策（如"子 Agent 超时了，我应该重试"），需要在系统提示词中加入指导。

**阶段 3 完成标志**：Agent 能正确理解 `delegate_task` 返回的 JSON 结构。

---

### 阶段 4：流式更新父 Agent 消息（≈ 1.5h，可选）

**目标**：让父 Agent 在子 Agent 执行过程中，就能看到进度更新（如"子 Agent 已完成 3/5 个工具调用"）。

#### 4.1 方案 A：通过 `tool_progress` delta 推送进度

```typescript
// builtinToolProvider.ts（修改 handler）
// 在 executeFn 执行期间，通过 AbortSignal 或回调推送进度
const progressCallback = (progress: { apiCalls: number; toolName: string }) => {
    // 通过 stream 的 controller 推送 tool_progress delta
};
```

#### 4.2 方案 B：子 Agent 完成后一次性返回 JSON（推荐）

更简单，先实现这个。流式进度可以作为后续优化。

**阶段 4 完成标志**：父 Agent 在子 Agent 执行时能看到进度（可选）。

---

## 四、实施顺序与依赖关系

```
阶段 1（接口扩展 + 元数据收集）
   ↓
阶段 2（handler 返回 JSON）
   ↓
阶段 3（提示词更新）
   ↓
阶段 4（流式进度，可选）
```

**关键路径**：阶段 1 → 阶段 2 → 阶段 3（必须按顺序）
**可选路径**：阶段 4（可以后续单独做）

---

## 五、风险与缓解

| 风险 | 缓解措施 |
|------|-----------|
| JSON 返回格式变化导致旧 Agent 解析失败 | JSON 是纯文本子集，旧 Agent 将其当普通文本处理，不会崩溃 |
| 元数据收集影响性能（如 `tool_trace` 内存占用） | `tool_trace` 只保留预览（前 80 字符），不保存完整参数 |
| `usage` delta 可能不存在（某些模型不支持） | `tokenUsage` 设为 optional，收集不到就留空 |
| 阶段 1 修改 `_executeWithBudget` 返回值影响其他调用方 | 检查所有调用方（`executeSubAgent`、`dispatch`、`dispatchParallelExplore`），统一适配 |

---

## 六、验收标准

### 6.1 功能验收

- [ ] `SubAgentResult` 包含 `metadata` 字段
- [ ] `metadata.apiCalls` 准确计数（`tool_start` 事件数）
- [ ] `metadata.durationMs` 与实际耗时误差 < 100ms
- [ ] `metadata.tokenUsage` 正确收集（当有 `usage` delta 时）
- [ ] `metadata.toolTrace` 包含每个工具调用的 `toolName` + `isError`
- [ ] `delegate_task` 返回合法 JSON 字符串
- [ ] 父 Agent 能 `JSON.parse()` 返回值并读取 `status`/`api_calls`/`duration_seconds`

### 6.2 性能验收

- [ ] `tool_trace` 数组长度 ≤ API 调用次数（无重复）
- [ ] 元数据收集不增加 > 5% 的子 Agent 执行耗时
- [ ] 内存占用增加 < 10MB（对于 100+ API 调用的子 Agent）

### 6.3 兼容性验收

- [ ] 旧版 Agent（不识别 JSON）能正常处理 `delegate_task` 返回值（当纯文本）
- [ ] 新版 Agent（识别 JSON）能正确解析并基于元数据决策
- [ ] `SubAgentResult.output` 字段保留（向后兼容）

---

## 七、时间与人力估算

| 阶段 | 内容 | 估算时间 | 依赖 |
|------|------|----------|------|
| 阶段 1 | 接口扩展 + 元数据收集 | 2h | 无 |
| 阶段 2 | handler 返回 JSON | 1.5h | 阶段 1 |
| 阶段 3 | 提示词更新 | 1h | 阶段 2 |
| 阶段 4 | 流式进度（可选） | 1.5h | 阶段 3 |
| **合计** | | **6h**（不含可选） | |

---

## 八、后续优化方向（不在本方案范围内）

1. **递归深度 guard**：参考 HA 的 `max_spawn_depth`，防止 Agent 无限递归派生子 Agent
2. **循环检测**：参考 Open-Multi-Agent 的 `LoopDetector`，防止 Agent 陷入死循环
3. **上下文管理**：参考 HA 的 `contextStrategy`（sliding-window/summarize/compact），防止长对话上下文溢出
4. **级联失败**：依赖任务失败时，自动标记下游任务为 Failed（而非保持 Pending）
5. **HTML 仪表板**：参考 Open-Multi-Agent 的 `onTrace` + HTML 仪表板，提供可视化调试界面

---

## 九、关键代码文件清单

| 文件 | 修改内容 |
|------|----------|
| `unifiedSubAgentDispatch.ts` | 新增 `SubAgentMetadata` 接口；扩展 `SubAgentResult`；修改 `_executeWithBudget` 返回元数据；修改 `executeSubAgent` 填充 `metadata` |
| `builtinToolProvider.ts` | 修改 `delegate_task` handler 返回 JSON 字符串；更新 `description` |
| `subAgentManager.ts` | 可选：更新 `SubAgentResult` 重新导出（保持向后兼容） |
| `test/common/unifiedSubAgentDispatch.test.ts` | 新增测试用例验证元数据收集 |

---

*文档生成时间：2026-05-31*
*基于：HA（`delegate_tool.py`）+ SAC（`unifiedSubAgentDispatch.ts` / `builtinToolProvider.ts`）*
