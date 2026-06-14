# SubAgent 与主 Agent 消息汇总逻辑对比分析

> **对比对象**：`saros-agents-client` (SAC) vs `Hermes-Agent` (HA)
> **分析维度**：SubAgent 执行完成后，消息如何返回给主 Agent（消息汇总逻辑）

---

## 1. 核心结论（一句话版）

| 维度 | **Sarosis-Agents-Client (SAC)** | **Hermes-Agent (HA)** |
|---|---|---|
| **返回格式** | 纯文本字符串 `output` | 结构化 JSON（`summary` + 元数据） |
| **父 Agent 可见内容** | 仅子 Agent 的最终文本输出 | 子任务 `summary` + `status` + `api_calls` + `tool_trace` + `tokens` 等 |
| **中间过程可见性** | 不可见（设计正确） | 不可见（设计正确） |
| **信息完整性** | 低（只有文本） | 高（状态/耗时/token/工具追踪全覆盖） |
| **父 Agent 解析成本** | 低（纯文本） | 中（需解析 JSON） |
| **上下文占用** | 小（仅文本） | 大（JSON 含元数据） |

**核心差异**：HA 返回**结构化摘要**（JSON），SAC 返回**纯文本输出**（非结构化）。HA 的设计更利于父 Agent 做后续决策。

---

## 2. SAC 消息汇总逻辑（详细）

### 2.1 调用链路

```
父 Agent 调用 delegate_task 工具
  → builtinToolProvider.ts handler (L997-1041)
    → UnifiedSubAgentDispatch.dispatch() (L295-303)
      → executeSubAgent() (L196-246)
        → _executeWithBudget() (L485-524)  ← 关键：累积 output
          → agentOS.executeAgentTurn()  ← 子 Agent 执行
```

### 2.2 核心代码：`_executeWithBudget()` (unifiedSubAgentDispatch.ts L485-524)

```typescript
private async _executeWithBudget(
    executeFn, request, budget
): Promise<string> {
    let output = '';
    const stream = executeFn(request, budget);
    for await (const delta of stream) {
        if (delta.type === 'text' && delta.content) {
            output += delta.content;  // ← 只累积 text delta
        }
        if (delta.type === 'done' || delta.type === 'error') {
            break;
        }
        // tool_end 只用于消耗预算，不累积到 output
    }
    return output;  // ← 返回纯文本字符串
}
```

### 2.3 返回给父 Agent 的内容

`builtinToolProvider.ts` L1019-1035：

```typescript
// 单任务模式
if (result.success) {
    return [{ type: 'text', text: result.output ?? '(no output)' }];
} else {
    return [{ type: 'text', text: `Sub-agent failed: ${result.error ?? 'unknown error'}` }];
}

// 批量任务模式
const lines = results.map((r, i) =>
    `Task ${i + 1}: ${r.success ? 'SUCCESS' : 'FAILED'}\n${
        r.success ? `  Output: ${r.output ?? '(empty)'}` : `  Error: ${r.error ?? 'unknown'}`
    }`
).join('\n\n');
return [{ type: 'text', text: lines.join('\n\n') }];
```

**父 Agent 看到的内容**：纯文本字符串，格式为：
```
Task 1: SUCCESS
  Output: <子 agent 的文本输出>
Task 2: FAILED
  Error: <错误信息>
```

### 2.4 信息丢失分析

| 丢失信息 | 原因 |
|---|---|
| 子 Agent 的 API 调用次数 | `_executeWithBudget` 不追踪 |
| 子 Agent 的耗时 | 不记录 |
| 子 Agent 的 token 使用量 | 不记录 |
| 子 Agent 的工具调用追踪 | 不记录 |
| 子 Agent 的退出原因（completed vs max_iterations） | 不记录 |
| 子 Agent 的错误详情（如果是失败） | 只有 error 字符串 |

---

## 3. HA 消息汇总逻辑（详细）

### 3.1 调用链路

```
父 Agent 调用 delegate_task 工具
  → run_agent.py _dispatch_delegate_task() (L4294-4311)
    → tools/delegate_tool.py delegate_task() (L1918-2310)  ← 核心函数
      → _run_single_child() (L1321-1771)  ← 执行单个子 Agent
        → child.run_conversation()  ← 子 Agent 执行
```

### 3.2 核心代码：`_run_single_child()` (delegate_tool.py L1620-1718)

```python
# 从子 Agent 执行结果中提取 summary
summary = result.get("final_response") or ""  # ← 子 Agent 的最终响应
completed = result.get("completed", False)
interrupted = result.get("interrupted", False)
api_calls = result.get("api_calls", 0)

# 构建返回给父 Agent 的结构化结果
entry = {
    "task_index": task_index,
    "status": status,            # "completed" | "failed" | "interrupted"
    "summary": summary,         # ← 子 Agent 的最终响应（文本）
    "api_calls": api_calls,   # ← API 调用次数
    "duration_seconds": duration,
    "model": _model,
    "exit_reason": exit_reason,  # ← "completed" | "max_iterations" | "interrupted"
    "tokens": {
        "input": _input_tokens,
        "output": _output_tokens,
    },
    "tool_trace": tool_trace,    # ← 工具调用追踪（tool name + args_bytes + result_bytes + status）
    "_child_role": ...,
    "_child_cost_usd": ...,
}
```

### 3.3 `delegate_task()` 返回值 (delegate_tool.py L2303-2309)

```python
return json.dumps(
    {
        "results": results,  # ← 数组，每个元素是一个子任务的 entry
        "total_duration_seconds": total_duration,
    },
    ensure_ascii=False,
)
```

**父 Agent 看到的内容**：JSON 字符串，格式为：
```json
{
  "results": [
    {
      "task_index": 0,
      "status": "completed",
      "summary": "子 Agent 的最终响应文本",
      "api_calls": 5,
      "duration_seconds": 12.3,
      "model": "claude-sonnet-4",
      "exit_reason": "completed",
      "tokens": {"input": 1000, "output": 500},
      "tool_trace": [...]
    }
  ],
  "total_duration_seconds": 15.6
}
```

### 3.4 信息完整性分析

| 信息 | 是否包含 | 说明 |
|---|---|---|
| 子 Agent 的最终响应（summary） | ✅ | `final_response` |
| 子 Agent 的状态 | ✅ | `status`: completed/failed/interrupted |
| 子 Agent 的 API 调用次数 | ✅ | `api_calls` |
| 子 Agent 的耗时 | ✅ | `duration_seconds` |
| 子 Agent 的退出原因 | ✅ | `exit_reason` |
| 子 Agent 的 token 使用量 | ✅ | `tokens.input` + `tokens.output` |
| 子 Agent 的工具调用追踪 | ✅ | `tool_trace`（含 tool name, args_bytes, result_bytes, status） |
| 子 Agent 的成本 | ✅ | `_child_cost_usd`（内部字段，返回后剥离） |
| 子 Agent 的中间推理过程 | ❌ | 设计目标：不可见 |
| 子 Agent 的工具调用详情 | ❌ | 设计目标：不可见（但有 tool_trace 摘要） |

---

## 4. 架构设计对比

### 4.1 设计哲学

| 维度 | SAC | HA |
|---|---|---|
| **设计目标** | 简单直接：子 Agent 输出文本，父 Agent 看到文本 | 结构化摘要：子 Agent 输出 JSON，父 Agent 解析后决策 |
| **适用场景** | 简单委托（父 Agent 只需要知道结果） | 复杂委托（父 Agent 需要基于结果做后续决策） |
| **可扩展性** | 低（纯文本难以扩展） | 高（JSON 可随时添加新字段） |

### 4.2 父 Agent 上下文占用对比

**SAC 示例**（2 个子任务，假设每个输出 500 字符）：
```
Task 1: SUCCESS
  Output: <500 字符>
Task 2: SUCCESS
  Output: <500 字符>

总占用：~1000 字符 + 格式字符
```

**HA 示例**（2 个子任务，每个 summary 500 字符 + 元数据）：
```json
{"results": [{"task_index": 0, "status": "completed", "summary": "<500 字符>", "api_calls": 5, ...}, {"task_index": 1, ...}], "total_duration_seconds": 15.6}

总占用：~1500 字符（JSON 格式开销）+ 元数据
```

**结论**：HA 的上下文占用更大（约 1.5x），但信息密度更高。

### 4.3 父 Agent 解析成本对比

**SAC**：父 Agent（LLM）需要自己解析纯文本，理解子任务的结果。如果输出格式不统一，解析难度大。

**HA**：父 Agent（LLM）收到结构化 JSON，可以直接解析。但 LLM 需要"理解" JSON 格式，这增加了一些 token 消耗。

**实际影响**：HA 的 JSON 格式对 LLM 友好（LLM 擅长解析 JSON），所以解析成本差异不大。

---

## 5. 优缺点深入分析

### 5.1 SAC 的优点

1. **简单直接**：实现简单，不需要构建复杂的数据结构
2. **上下文占用小**：只有文本输出，没有额外的元数据
3. **对 LLM 友好**：纯文本，LLM 可以直接理解

### 5.2 SAC 的缺点

1. **信息不完整**：父 Agent 不知道子 Agent 的 API 调用次数、耗时、token 使用量等
2. **难以调试**：没有结构化信息，出问题时难以定位
3. **难以扩展**：如果需要添加新信息（如 token 使用量），需要修改文本格式，可能影响父 Agent 的解析逻辑
4. **批量模式格式不统一**：批量任务返回的文本格式是硬编码的（`Task N: SUCCESS\n  Output: ...`），如果子 Agent 输出包含类似格式，可能混淆

### 5.3 HA 的优点

1. **信息完整**：父 Agent 可以获得子 Agent 的所有关键信息（状态、耗时、token、工具追踪）
2. **易于调试**：JSON 格式便于日志和调试
3. **易于扩展**：随时可以在 JSON 中添加新字段，不影响现有逻辑
4. **结构化**：父 Agent（或监控系统的 TUI）可以轻松解析 JSON，获取需要的信息
5. **TUI 友好**：HA 有 TUI 界面，`tool_trace` 可以在 TUI 中展示，帮助用户理解子 Agent 的行为

### 5.4 HA 的缺点

1. **上下文占用大**：JSON 格式有额外的开销（字段名、括号、引号等）
2. **对 LLM 的 token 消耗稍高**：LLM 需要处理 JSON 格式，消耗更多 token
3. **复杂度高**：实现复杂，需要维护 `entry` 数据结构
4. **JSON 可能超长**：如果 `tool_trace` 很大（子 Agent 调用了很多工具），JSON 可能超长，占用大量上下文

---

## 6. 关键设计决策对比

### 6.1 子 Agent 消息历史是否返回给父 Agent？

| 项目 | 子 Agent 消息历史是否返回 | 原因 |
|---|---|---|
| **SAC** | ❌ 否 | `_executeWithBudget` 只累积 `delta.content`（文本），不保留消息历史 |
| **HA** | ❌ 否 | `summary = result.get("final_response")`，只取最终响应，不返回消息历史 |

**结论**：两个项目都**不返回**子 Agent 的消息历史。这是正确设计，避免上下文污染。

### 6.2 父 Agent 是否能看到子 Agent 的工具调用？

| 项目 | 父 Agent 是否看到工具调用 | 原因 |
|---|---|---|
| **SAC** | ❌ 否 | `output` 只包含文本，不包含工具调用 |
| **HA** | ⚠️ 部分可见（摘要） | `tool_trace` 包含工具调用的摘要（tool name + args_bytes + result_bytes + status），但不包含完整的工具调用参数和结果 |

**结论**：HA 的设计更好——父 Agent 可以看到工具调用的**摘要**，了解子 Agent 做了什么，但不会看到完整的工具调用细节（避免上下文污染）。

### 6.3 失败时返回什么信息？

**SAC**（`builtinToolProvider.ts` L1022）：
```typescript
return [{ type: 'text', text: `Sub-agent failed: ${result.error ?? 'unknown error'}` }];
```
→ 只有 `error` 字符串，信息量有限。

**HA**（`_run_single_child` L1694-1720）：
```python
if status == "failed":
    entry["error"] = result.get("error", "Subagent did not produce a response.")
```
→ 有 `error` 字段，且 `summary` 可能为空或包含部分输出。

**结论**：HA 的失败信息更完整（有 `status` + `error` + `summary` 可能非空），SAC 只有 `error` 字符串。

---

## 7. SAC 应借鉴 HA 的特性（按优先级）

### P0（必须做）

1. **返回结构化 JSON 而非纯文本**
   - 修改 `builtinToolProvider.ts` 的 `delegate_task` handler，返回 JSON 字符串而非纯文本
   - 好处：父 Agent 可以解析 JSON，获取子任务的详细状态

2. **在 `SubAgentResult` 中添加元数据字段**
   - 当前 `SubAgentResult` 只有 `success`、`output`、`error`、`completedAt`
   - 应添加：`status`、`apiCalls`、`durationMs`、`exitReason`、`tokens`、`toolTrace`
   - 修改 `unifiedSubAgentDispatch.ts` 的 `SubAgentResult` 接口

### P1（应该做）

3. **在 `_executeWithBudget` 中追踪 API 调用次数和耗时**
   - 当前 `_executeWithBudget` 只追踪 `deltaCount` 和预算消耗
   - 应添加：`apiCallCount`（遇到 `tool_end` delta 时递增）、`startTime`、`endTime`

4. **添加 `tool_trace` 摘要**
   - 在 `_executeWithBudget` 中，遇到 `tool_end` delta 时，记录工具调用的摘要（tool name + args length + result length + status）
   - 存储到 `SubAgentResult.toolTrace` 中

### P2（可以做）

5. **添加 token 使用量追踪**
   - 需要从 `IChatStreamDelta` 中提取 token 使用量（如果有）
   - 存储到 `SubAgentResult.tokens` 中

6. **优化批量模式的返回格式**
   - 当前批量模式返回硬编码的文本格式
   - 应改为 JSON 格式，与单任务模式一致

---

## 8. 实施路径建议

### 阶段 1：添加元数据字段（1-2 小时）

1. 修改 `unifiedSubAgentDispatch.ts`：
   - 扩展 `SubAgentResult` 接口，添加 `status`、`apiCalls`、`durationMs`、`exitReason`、`tokens`、`toolTrace`
   - 修改 `_executeWithBudget()`，追踪 `apiCallCount` 和 `durationMs`
   - 修改 `executeSubAgent()`，设置 `result.status`、`result.exitReason` 等

2. 修改 `builtinToolProvider.ts`：
   - 修改 `delegate_task` handler，返回 JSON 字符串而非纯文本
   - JSON 格式：`{"results": [{"task_index": 0, "status": "...", "summary": "...", ...}], "total_duration_ms": N}`

### 阶段 2：添加 tool_trace（2-3 小时）

1. 修改 `_executeWithBudget()`：
   - 遇到 `tool_start` delta 时，记录工具名称
   - 遇到 `tool_end` delta 时，记录工具参数长度和结果长度
   - 构建 `toolTrace` 数组

2. 修改 `SubAgentResult` 接口，添加 `toolTrace` 字段

### 阶段 3：优化和测试（1-2 小时）

1. 编写单元测试，验证 JSON 格式正确性
2. 手动测试 delegate_task 工具，确认父 Agent 能正确解析 JSON
3. 优化 JSON 格式，确保 token 消耗合理（避免超长 JSON）

---

## 9. 风险与缓解措施

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| JSON 格式超长，占用大量上下文 | 父 Agent 的上下文溢出 | 限制 `toolTrace` 长度（只保留最近 N 条）；对 `summary` 截断（最多 M 字符） |
| 父 Agent（LLM）解析 JSON 失败 | 父 Agent 无法理解子任务结果 | 在 system prompt 中添加 JSON 解析指导；使用更简单的 JSON 格式（减少嵌套） |
| 修改 `SubAgentResult` 接口影响其他代码 | 编译错误 | 逐步修改，先添加可选字段（使用 `?` 修饰符），不影响现有代码 |
| `_executeWithBudget` 改动影响子 Agent 执行 | 子 Agent 执行失败 | 添加充分的单元测试；在修改前先编写测试用例 |

---

## 10. 总结

**核心观点**：HA 的 subagent 消息汇总设计明显优于 SAC。SAC 应该借鉴 HA 的设计，返回结构化 JSON 而非纯文本。

**关键改进点**：
1. 返回 JSON 而非纯文本
2. 添加元数据（status、apiCalls、durationMs、exitReason、tokens、toolTrace）
3. 在 `_executeWithBudget` 中追踪 API 调用次数和耗时
4. 添加 tool_trace 摘要

**预期收益**：
- 父 Agent 可以基于结构化信息做更好的决策
- 调试更方便（有结构化日志）
- 系统更易于扩展（随时添加新字段）

**实施成本**：约 4-7 小时（分 3 个阶段）

---

## 附录：关键代码文件索引

### SAC 关键文件

| 文件 | 行号 | 说明 |
|---|---|---|
| `src/vs/sessions/contrib/agentStudio/browser/providers/tool/builtinToolProvider.ts` | L997-1041 | `delegate_task` handler |
| `src/vs/sessions/contrib/agentStudio/common/unifiedSubAgentDispatch.ts` | L119-124 | `SubAgentResult` 接口定义 |
| `src/vs/sessions/contrib/agentStudio/common/unifiedSubAgentDispatch.ts` | L485-524 | `_executeWithBudget()` 方法 |

### HA 关键文件

| 文件 | 行号 | 说明 |
|---|---|---|
| `tools/delegate_tool.py` | L1918-2310 | `delegate_task()` 函数（核心） |
| `tools/delegate_tool.py` | L1321-1771 | `_run_single_child()` 函数 |
| `tools/delegate_tool.py` | L1620-1718 | 从子 Agent 结果中提取 `summary` 和元数据 |
| `run_agent.py` | L4294-4311 | `_dispatch_delegate_task()` 函数（入口） |
