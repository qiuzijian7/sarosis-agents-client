# Tool & MCP 架构对比分析

> OpenClaw vs Sarosis-Agents-Client 工具注入、解析、调用逻辑深度对比

---

## 目录

1. [架构总览](#1-架构总览)
2. [工具定义与注册](#2-工具定义与注册)
3. [MCP 集成](#3-mcp-集成)
4. [工具传递给 LLM 的方式](#4-工具传递给-llm-的方式)
5. [工具调用解析](#5-工具调用解析)
6. [工具执行与分发](#6-工具执行与分发)
7. [工具结果处理](#7-工具结果处理)
8. [安全与审批机制](#8-安全与审批机制)
9. [对比总结表](#9-对比总结表)
10. [优化建议](#10-优化建议)

---

## 1. 架构总览

### OpenClaw 架构

```
┌────────────────────────────────────────────────────────────────────┐
│                    pi-embedded-runner (主循环)                       │
│  while(true) → runAttempt → SDK session.prompt() → 流式响应         │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │
          ┌───────────────────────┼───────────────────────────┐
          ▼                       ▼                           ▼
   ToolDescriptor[]       ToolPolicyPipeline          SDK 自动执行
   (声明式定义)            (多层策略过滤)              (function_call → execute)
          │                       │                           │
          ▼                       ▼                           ▼
  ┌──────────────┐    ┌─────────────────────┐    ┌───────────────────────┐
  │ 核心工具 (core) │    │ 可用性评估 (auth/    │    │ pi-tool-definition-    │
  │ 插件工具 (plugin)│    │  env/config/context)│    │ adapter.ts (execute   │
  │ MCP 工具 (mcp)  │    │ + deny/allow list    │    │ wrapper + hooks)       │
  │ 频道工具 (channel)│    └─────────────────────┘    └───────────────────────┘
  └──────────────┘
```

### Sarosis-Agents-Client 架构

```
┌────────────────────────────────────────────────────────────────────┐
│                    AgentOSService (主循环)                           │
│  agenticLoop → _executeWithFallbackDirectly → 模型调用 → 响应解析    │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │
          ┌───────────────────────┼───────────────────────────┐
          ▼                       ▼                           ▼
   SlotRegistry             IToolProvider[]             手动执行分发
   (优先级排序)              (priority注册)              (executeTool → dispatch)
          │                       │                           │
          ▼                       ▼                           ▼
  ┌──────────────────┐    ┌──────────────────┐    ┌────────────────────┐
  │ BuiltinToolProvider │  │ McpToolProvider    │    │ agentOSService     │
  │ (priority=50)       │  │ (priority=70)      │    │ ._executeToolCalls │
  │ - 核心工具          │  │ - 桥接 IMcpService  │    │ (顺序/并行分发)      │
  │ - Skill 工具        │  │                    │    └────────────────────┘
  │ - Bundled 工具      │  └──────────────────┘
  └──────────────────┘
```

### 核心差异

| 维度 | OpenClaw | Sarosis |
|------|----------|---------|
| **执行模型** | SDK 驱动（pi-agent-core 自动执行 tool） | 手动驱动（自行解析 + 分发执行） |
| **工具来源** | 4 种 owner: core / plugin / channel / mcp | 3 种 provider: Builtin / MCP / Extension |
| **注册机制** | 声明式 ToolDescriptor + 策略管线过滤 | 命令式 registerToolProvider + priority |
| **可用性控制** | 表达式求值器（auth/env/config/context） | 简单 enable/disable 开关 |
| **复杂度** | 高（多层抽象 + SDK） | 中（直接实现 + 单一循环） |

---

## 2. 工具定义与注册

### 2.1 OpenClaw 的工具定义

**核心类型文件：** `src/tools/types.ts`

```typescript
// 声明式工具描述符
interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: TSchema;              // TypeBox JSON Schema
  owner: ToolOwnerRef;               // { type: 'core'|'plugin'|'mcp'|'channel', ... }
  executor: ToolExecutorRef;         // 执行器引用
  availability: ToolAvailabilityExpression;  // 声明式可用性条件
}

// 运行时工具（带 execute 方法）
interface AgentTool<TParams, TResult> {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  execute(toolCallId: string, params: TParams, signal?: AbortSignal, onUpdate?: Fn): Promise<TResult>;
}
```

**注册流程：**
1. 各模块导出 `AnyAgentTool[]`（如 bash-tools、web-tools 等）
2. `collectPresentOpenClawTools()` 汇总所有工具候选
3. `applyToolPolicyPipeline()` 应用多层策略过滤：
   - Profile 策略 → Provider 策略 → Agent 策略 → Group 策略 → Sender 策略 → Sandbox 策略 → Subagent 策略
4. `buildToolPlan()` 评估可用性，输出 visible/hidden 两组
5. `toToolDefinitions()` 适配为 SDK 可消费的格式

### 2.2 Sarosis 的工具定义

**核心类型文件：** `src/vs/sessions/contrib/agentStudio/common/providers.ts`

```typescript
interface IToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;  // JSON Schema
  readonly category?: string;
  readonly source?: string;
}

interface IToolProvider {
  readonly id: string;
  readonly name: string;
  listTools(agentId: string): Promise<IToolDefinition[]>;
  executeTool(agentId: string, toolCall: IToolCall): Promise<IToolResult>;
  enableTool(agentId: string, toolName: string): Promise<void>;
  disableTool(agentId: string, toolName: string): Promise<void>;
  isToolEnabled(agentId: string, toolName: string): Promise<boolean>;
}
```

**注册流程：**
1. `BuiltinCapabilityContribution` 在 `agentStudio.contribution.ts` 中启动时注册
2. `agentOSService.registerToolProvider(builtinProvider, 50)` — 内置工具
3. `agentOSService.registerToolProvider(mcpProvider, 70)` — MCP 工具
4. 扩展可通过 API 注入更高优先级的 Provider
5. `SlotRegistry` 按 priority 排序，高优先级覆盖低优先级同名工具

### 2.3 对比分析

| 方面 | OpenClaw | Sarosis | 评价 |
|------|----------|---------|------|
| **Schema 格式** | TypeBox (TSchema) | 原生 JSON Schema | OpenClaw 更类型安全，Sarosis 更灵活 |
| **可用性控制** | 声明式表达式 (`auth`/`env`/`config`) | 命令式 `enable/disable` | OpenClaw 可自动评估运行时条件 |
| **策略管线** | 7 层策略逐步过滤 | 无（仅 enable/disable） | OpenClaw 更精细但复杂度极高 |
| **工具发现** | 编译时注册 + 运行时策略 | 运行时动态注册 + Observable | Sarosis 架构更灵活 |
| **去重策略** | name 冲突时按策略决定 | priority 高的覆盖低的 | 各有道理 |

---

## 3. MCP 集成

### 3.1 OpenClaw 的 MCP 实现

**核心文件：**
- `src/agents/pi-bundle-mcp-runtime.ts` — MCP 运行时管理器
- `src/agents/pi-bundle-mcp-materialize.ts` — 工具物化（MCP → AnyAgentTool）
- `src/agents/mcp-stdio-transport.ts` — Stdio 传输实现

**架构特点：**

```
SessionMcpRuntimeManager (全局单例)
  └─ SessionMcpRuntime (per session, 带缓存)
      ├─ BundleMcpSession (per server)
      │   ├─ Client (@modelcontextprotocol/sdk)
      │   └─ Transport (stdio | sse | streamable-http)
      └─ McpToolCatalog (首次加载后缓存)
          └─ McpCatalogTool[] → materialize → AnyAgentTool[]
```

**关键机制：**
1. **配置指纹缓存**：对 server 配置做 SHA1 hash，配置不变则复用已建立的连接
2. **分页发现**：`listAllTools()` 支持 cursor 分页，确保获取所有工具
3. **空闲回收**：10 分钟无使用自动 dispose（lease 计数保护活跃 runtime）
4. **连接容错**：单 server 失败不阻塞其他 server 初始化
5. **名称安全化**：`{safeServerName}__{toolName}`，最长 64 字符
6. **重建而非重连**：不实现自动重连，通过配置变更检测触发重建

### 3.2 Sarosis 的 MCP 实现

**核心文件：**
- `src/vs/sessions/contrib/agentStudio/browser/providers/tool/mcpToolProvider.ts` — McpToolProvider
- `src/vs/workbench/contrib/mcp/common/mcpService.ts` — 上游 McpService
- `src/vs/sessions/contrib/agentStudio/common/bundled-tools/bundledMcpPresets.ts` — 预置模板

**架构特点：**

```
McpToolProvider (桥接层)
  │ observes
  ▼
IMcpService (VS Code 上游)
  ├─ McpRegistry (配置来源管理)
  │   ├─ settings.json
  │   ├─ claude_desktop_config.json
  │   ├─ cursor mcp.json
  │   └─ windsurf mcp_config.json
  ├─ McpServer[] (连接管理)
  │   ├─ connectionState: Observable
  │   └─ tools: Observable<IMcpTool[]>
  └─ Transport
      ├─ Stdio
      └─ HTTP/SSE
```

**关键机制：**
1. **桥接模式**：McpToolProvider 不直接管理连接，桥接 VS Code 上游的 `IMcpService`
2. **响应式路由**：通过 `autorun` 观察 `servers` + `tools` Observable，自动重建路由表
3. **自动启动**：调用时若 server 停止，自动 `server.start()`
4. **多配置源发现**：支持 Claude Desktop / Cursor / Windsurf / settings.json 等多来源
5. **名称格式**：`<serverPrefix>__<toolName>`（双下划线分隔）
6. **预置模板**：16 个常见 MCP 服务器一键添加

### 3.3 MCP 对比

| 方面 | OpenClaw | Sarosis | 评价 |
|------|----------|---------|------|
| **连接管理** | 自建 runtime + 手动 lifecycle | 复用 VS Code 上游 McpService | Sarosis 更轻量，但灵活性受限 |
| **缓存策略** | SHA1 配置指纹 + 空闲回收 | Observable 响应式 + 懒启动 | 各有优势 |
| **工具发现** | cursor 分页获取全部 | Observable 自动同步 | Sarosis 更实时 |
| **传输支持** | stdio / sse / streamable-http | stdio / HTTP(SSE) | OpenClaw 多一种 |
| **容错** | 单 server 失败不阻塞 | 依赖上游 McpService 处理 | 类似 |
| **配置来源** | 自有配置 + plugin bundle | 多 IDE 配置兼容 | Sarosis 兼容性更强 |
| **预置模板** | 无（靠 plugin） | 16 个内置预设 | Sarosis 开箱体验更好 |

---

## 4. 工具传递给 LLM 的方式

### 4.1 OpenClaw

通过 **API tool_use 参数** 传递，支持多种 API 格式：

```typescript
// OpenAI Responses API (openai-transport-stream.ts)
params.tools = convertResponsesTools(context.tools, model, { strict: ... });

// OpenAI Chat Completions API
params.tools = tools.map(t => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters }
}));

// Anthropic API (anthropic-transport-stream.ts)
params.tools = convertAnthropicTools(context.tools, isOAuthToken);
```

**Schema 兼容处理：**
- `normalizeToolParameterSchema()` 处理不同 LLM 的 schema 限制
- OpenAI strict 模式要求 `additionalProperties: false`
- Gemini 不支持 `$ref`/`$defs`

### 4.2 Sarosis

同样通过 **API tool_use 参数**：

```typescript
// builtInBYOKModelProvider.ts
body.tools = options.tools.map(t => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  },
}));
body.tool_choice = 'auto';
```

**差异：** 目前只支持 OpenAI function calling 格式。

### 4.3 对比

| 方面 | OpenClaw | Sarosis |
|------|----------|---------|
| **API 格式** | OpenAI Responses / Completions / Anthropic | 仅 OpenAI Function Calling |
| **Schema 标准化** | 有（per-provider 适配） | 无（直接传递） |
| **strict 模式** | 支持 OpenAI strict schema | 不支持 |
| **tool_choice** | 支持 auto/required/specific | 仅 auto |

---

## 5. 工具调用解析

### 5.1 OpenClaw

**三层解析机制：**

1. **Native API 解析**（SDK 自动处理）：
   - OpenAI: `type: "function_call"` output item
   - Anthropic: `type: "tool_use"` content block
   - SDK 自动从流中提取，无需手动解析

2. **文本降级检测** (`tool-call-shaped-text.ts`)：
   ```typescript
   function detectToolCallShapedText(text: string): ToolCallShapedTextDetection {
     // 检测 JSON 格式 / XML 格式 / Bracket 格式 / ReAct 格式
     // 用于识别模型将 tool call 输出为文本的情况
   }
   ```

3. **DeepSeek 特殊过滤** (`deepseek-text-filter.ts`)：
   - 流式拦截 `<|DSML|tool_calls>...</|DSML|tool_calls>` 标签
   - 将 DSML 文本解析为结构化 tool_calls

4. **流式工具装配**（SDK 内部）：
   - `function_call` 的 `arguments` 是流式拼接的
   - SDK 在 `done` 事件后完成 JSON 解析并触发 execute

### 5.2 Sarosis

**双层解析机制：**

1. **Native API 解析**（`builtInBYOKModelProvider.ts`）：
   ```typescript
   // 从 OpenAI response 中提取 tool_calls
   if (choice.message?.tool_calls) {
     for (const tc of choice.message.tool_calls) {
       toolCalls.push({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments) });
     }
   }
   ```

2. **文本降级提取**（`agentOSService.ts`）：
   ```typescript
   // _tryExtractToolCallsFromText: 当 API 未返回结构化 tool_calls 时
   // 使用 _extractJsonObjects() 从文本中找平衡括号的 JSON 对象
   // 用正则匹配 "name"+"arguments" 模式识别工具调用
   ```

3. **流式装配**（`StreamingToolCallAssembler`）：
   - `toolCallUtils.ts` 中实现
   - 支持 `function.name` 和 `function.arguments` 的增量拼接
   - 在 `finish_reason: "tool_calls"` 时完成装配

### 5.3 对比

| 方面 | OpenClaw | Sarosis |
|------|----------|---------|
| **Native 解析** | SDK 自动（多 provider） | 手动实现（仅 OpenAI） |
| **文本降级** | 检测+标记（不自动执行） | 检测+提取+执行 |
| **格式覆盖** | JSON/XML/Bracket/ReAct/DSML | 仅 JSON |
| **流式装配** | SDK 内部处理 | StreamingToolCallAssembler |
| **错误恢复** | 模型可看到检测结果 | 直接尝试解析执行 |

---

## 6. 工具执行与分发

### 6.1 OpenClaw

**SDK 自动执行模型：**

```
LLM 流式响应
  → SDK 检测 function_call
  → 调用 toolDefinition.execute(toolCallId, params, signal)
    → pi-tool-definition-adapter.ts (包装层)
      → before_tool_call hook (可拦截/审批)
      → 实际 tool.execute()
      → 结果自动发回 LLM
```

**关键特性：**
- **并行执行**：通过 `parallel_tool_calls: true` 参数，SDK 可并行触发多个工具
- **执行追踪**：`countActiveToolExecutions()` 追踪并发数
- **超时控制**：每个工具执行有 AbortSignal
- **结果截断**：`TOOL_RESULT_MAX_CHARS = 8000`
- **客户端工具**：部分工具标记为 `clientToolCalls`，需要外部执行后手动回传

### 6.2 Sarosis

**手动分发模型：**

```
模型响应
  → 解析 toolCalls[]
  → _executeToolCalls(toolCalls)
    → shouldParallelizeToolBatch(toolCalls, toolSchemaMap)
      → 如果可并行: Promise.all(toolCalls.map(executeSingle))
      → 否则: 逐个执行 for-of loop
    → executeSingle:
      → 按 tool name 在所有 registered providers 中查找
      → provider.executeTool(agentId, toolCall)
      → 格式化结果
  → 将结果加入消息历史
  → 继续循环
```

**关键特性：**
- **智能并行判断**：`shouldParallelizeToolBatch()` 分析工具类型决定是否并行
- **Provider 分发**：遍历所有已注册 provider，找到第一个能处理该 tool name 的
- **重试机制**：`MAX_INVALID_TOOL_RETRIES` 限制无效工具调用的重试次数
- **结果大小限制**：`limitToolResultSize()` 截断过大的结果
- **工具名修复**：`repairToolName()` 模糊匹配修复拼写错误

### 6.3 对比

| 方面 | OpenClaw | Sarosis |
|------|----------|---------|
| **执行方式** | SDK 自动 | 手动循环 |
| **并行策略** | LLM API 参数 + SDK 并行 | 运行时智能判断 |
| **Provider 分发** | 直接通过 tool.execute 闭包 | 遍历所有 providers 查找 |
| **工具名修复** | 无（依赖 SDK） | 有 repairToolName() |
| **结果截断** | 8000 chars | limitToolResultSize() |
| **重试** | SDK 内部管理 | 手动计数 + MAX_RETRIES |
| **超时** | AbortSignal | 无明确超时机制 |

---

## 7. 工具结果处理

### 7.1 OpenClaw

**结果格式化流程：**

```typescript
// 工具执行后 → AgentToolResult
{ content: ContentBlock[], details: { mcpServer?, status? } }

// 发回 LLM 时格式化为:
{
  type: "function_call_output",
  call_id: callId,
  output: textResult  // 或含图片的 content blocks
}
```

**特殊处理：**
- 图片结果 → base64 + content block 数组
- 错误结果 → `TOOL_ERROR_MAX_CHARS = 400` 截断后发回
- 超时 → 标记 `timedOut: true` 并记录
- 多模态支持 → text / image / resource 三种内容类型

### 7.2 Sarosis

**结果格式化流程：**

```typescript
// IToolResult
{
  toolCallId: string;
  success: boolean;
  content: IToolResultContent[];  // { type: 'text'|'image'|'resource', text?, data?, mimeType? }
  error?: string;
}

// 发回 LLM 时格式化为:
{
  role: 'tool',
  tool_call_id: result.toolCallId,
  content: stringifiedResult  // JSON.stringify 或拼接 text
}
```

**特殊处理：**
- `limitToolResultSize()` 限制结果大小
- `formatToolErrorResult()` 格式化错误信息
- `formatToolNotFoundResult()` 工具未找到的特殊处理
- `sanitizeToolError()` 清理错误信息中的敏感内容

### 7.3 对比

| 方面 | OpenClaw | Sarosis |
|------|----------|---------|
| **内容类型** | text / image / resource | text / image / resource |
| **错误截断** | 400 chars | sanitizeToolError() |
| **多模态** | 完整支持（content blocks） | 支持但序列化为字符串 |
| **结构化结果** | 支持 structuredContent | 无 |

---

## 8. 安全与审批机制

### 8.1 OpenClaw

**两层审批：**

1. **before_tool_call Plugin Hook**：
   - 插件注册 hook，在任何工具执行前拦截
   - 返回 `{ block: true }` 可阻止执行
   - 支持 `requireApproval` 触发人工审批流

2. **Shell 命令审批（Exec Approval）**：
   - 基于 `ExecSecurity` 安全策略
   - 两阶段确认：`exec.approval.request` → `exec.approval.waitDecision`
   - 决策选项：`allow-once` / `allow-always` / `deny`
   - UI 展示审批提示，等待用户决策

3. **沙箱隔离**：
   - 工具可标记 sandbox 限制
   - Subagent 策略限制子代理可用工具集

### 8.2 Sarosis

**当前机制：**
- 工具 enable/disable 开关（用户手动管理）
- 无运行时审批/确认流程
- 无沙箱隔离

---

## 9. 对比总结表

| 维度 | OpenClaw | Sarosis | 差距评估 |
|------|----------|---------|----------|
| **工具类型系统** | TypeBox + 声明式 Descriptor | 原生 JSON Schema + IToolProvider | ⭐ 中等 |
| **可用性评估** | 表达式引擎（auth/env/config） | 简单开关 | ⭐⭐ 较大 |
| **策略管线** | 7 层过滤 | 无 | ⭐⭐⭐ 显著 |
| **MCP 连接管理** | 自建 + 配置指纹缓存 + 空闲回收 | 桥接上游 + Observable | ⭐ 对等 |
| **MCP 工具名安全化** | 64 字符限制 + 冲突检测 | 前缀+双下划线 | ⭐ 基本对等 |
| **多 Provider API** | OpenAI + Anthropic + Azure | 仅 OpenAI | ⭐⭐⭐ 显著 |
| **Schema 标准化** | per-provider 适配 | 直接传递 | ⭐⭐ 较大 |
| **工具调用解析** | SDK + 多格式文本检测 | 手动 + 仅 JSON 提取 | ⭐⭐ 较大 |
| **并行执行** | API 参数 + SDK | 智能判断 + Promise.all | ⭐ 基本对等 |
| **安全审批** | 双层审批 + 沙箱 | 仅 enable/disable | ⭐⭐⭐ 显著 |
| **工具名修复** | 无 | repairToolName (优势) | Sarosis 更好 |
| **执行超时** | AbortSignal | 无 | ⭐⭐ 较大 |
| **预置模板** | 无（靠 plugin） | 16 个内置 | Sarosis 更好 |
| **配置兼容** | 自有格式 | 多 IDE 兼容 | Sarosis 更好 |

---

## 10. 优化建议

基于以上对比分析，以下是按优先级排序的优化建议：

### P0 — 高优先级（影响核心功能）

#### 10.1 增加工具执行超时机制

**问题：** 当前工具执行无超时保护，若 MCP 服务器挂起或工具执行无限阻塞，整个 agent 循环会卡死。

**建议：**
```typescript
// 在 _executeToolCalls 中增加 AbortController + timeout
async function executeWithTimeout(provider: IToolProvider, call: IToolCall, timeoutMs = 30_000): Promise<IToolResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await provider.executeTool(agentId, call, controller.signal);
  } catch (e) {
    if (controller.signal.aborted) {
      return { toolCallId: call.id, success: false, content: [], error: `Tool execution timed out after ${timeoutMs}ms` };
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
```

**参考：** OpenClaw 通过 AbortSignal 传递到每个 tool.execute()。

---

#### 10.2 增加工具执行前确认/审批机制

**问题：** 所有工具直接执行，无法对危险操作进行用户确认。

**建议：**
1. 定义工具安全等级（`safe` / `cautious` / `dangerous`）
2. 在 `IToolDefinition` 中增加 `securityLevel` 字段
3. 对 `dangerous` 级别工具（如 file_write, terminal_exec）执行前请求用户确认
4. 提供 "always allow" 选项避免反复确认

```typescript
interface IToolDefinition {
  // ... existing fields
  readonly securityLevel?: 'safe' | 'cautious' | 'dangerous';
  readonly requiresApproval?: boolean;
}
```

**参考：** OpenClaw 的 `before_tool_call` hook + `exec.approval.request/waitDecision` 两阶段审批。

---

#### 10.3 支持多 LLM Provider 的工具格式适配

**问题：** 当前仅支持 OpenAI function calling 格式，限制了模型选择。

**建议：**
1. 抽象出 `IToolFormatAdapter` 接口
2. 实现 OpenAI / Anthropic / Google 三种适配器
3. 每种适配器负责：
   - 将 `IToolDefinition[]` 转为对应 API 的 `tools` 参数格式
   - 将 API 响应中的 tool_calls 解析为统一的 `IToolCall[]`
   - 处理 schema 兼容性问题（如 Anthropic 不支持 `$ref`）

```typescript
interface IToolFormatAdapter {
  readonly provider: string;
  formatToolsForRequest(tools: IToolDefinition[]): unknown;
  parseToolCallsFromResponse(response: unknown): IToolCall[];
  formatToolResultForRequest(result: IToolResult): unknown;
}
```

**参考：** OpenClaw 的 `convertResponsesTools()` / `convertAnthropicTools()` + `normalizeToolParameterSchema()`。

---

### P1 — 中优先级（提升健壮性）

#### 10.4 增加工具可用性声明式评估

**问题：** 当前工具只有 enable/disable 开关，无法根据运行时条件自动判断可用性。

**建议：**
```typescript
interface IToolAvailability {
  type: 'always' | 'config' | 'env' | 'auth' | 'context';
  // config: 需要某配置项存在
  // env: 需要某环境变量
  // auth: 需要某认证 provider
  // context: 需要某上下文值
  condition?: string;
}

interface IToolDefinition {
  // ... existing
  readonly availability?: IToolAvailability[];
}
```

好处：
- 未配置 API key 时自动隐藏相关工具（而非执行时报错）
- 特定环境下自动启用/禁用工具
- 减少用户手动管理负担

**参考：** OpenClaw 的 `ToolAvailabilityExpression` + `evaluateToolAvailability()`。

---

#### 10.5 增强文本降级工具调用检测

**问题：** 当前只检测 JSON 格式的文本 tool call，部分模型会输出 XML 或 bracket 格式。

**建议：** 已在之前的重构中部分实现（`assistantVisibleText.ts`），但解析提取逻辑仍需增强：

```typescript
// 在 _tryExtractToolCallsFromText 中增加：
// 1. XML 格式: <tool_call>{"name":"x","arguments":{}}</tool_call>
// 2. Bracket 格式: [TOOL_CALL]...[/TOOL_CALL]
// 3. ReAct 格式: Action: tool_name\nAction Input: {...}
```

**参考：** OpenClaw 的 `detectToolCallShapedText()` 支持 JSON/XML/Bracket/ReAct 四种格式检测。

---

#### 10.6 增加工具执行结果的结构化元数据

**问题：** 当前 `IToolResult` 仅有 success/error 二元状态，缺乏结构化元数据。

**建议：**
```typescript
interface IToolResult {
  // ... existing
  readonly metadata?: {
    readonly executionTimeMs?: number;     // 执行耗时
    readonly truncated?: boolean;           // 结果是否被截断
    readonly structuredContent?: unknown;   // 结构化结果（可选）
    readonly mcpServer?: string;           // MCP 来源标记
    readonly retryable?: boolean;          // 是否可重试
  };
}
```

**参考：** OpenClaw 的 `AgentToolResult.details` 包含 `mcpServer`, `structuredContent`, `timedOut` 等字段。

---

### P2 — 低优先级（长期演进）

#### 10.7 工具策略管线

参考 OpenClaw 的 7 层策略管线，可逐步引入：
1. **Profile 策略**：不同 agent 配置文件限制不同工具集
2. **Sender 策略**：基于消息来源限制工具（如限制非认证用户）
3. **Sandbox 策略**：子代理限制工具集

#### 10.8 MCP 连接池与健康检查

- 实现类似 OpenClaw 的 `lease` 计数保护
- 增加 MCP server 心跳检测
- 实现自动重连策略（当前只有"重建"）

#### 10.9 工具执行进度回调

参考 OpenClaw 的 `onUpdate` 回调机制：
```typescript
execute(toolCallId: string, params: P, signal?: AbortSignal, onUpdate?: (update: ToolUpdate) => void): Promise<R>;
```

允许长时间运行的工具（如 web_search, file_search）报告进度到 UI。

---

### 实施路线图

```
Phase 1 (1-2 周): P0 项目
  ├─ 10.1 工具执行超时
  ├─ 10.2 执行审批机制 (基础版)
  └─ 10.3 多 Provider 适配 (Anthropic)

Phase 2 (2-3 周): P1 项目
  ├─ 10.4 可用性声明式评估
  ├─ 10.5 多格式文本检测增强
  └─ 10.6 结构化元数据

Phase 3 (持续): P2 项目
  ├─ 10.7 策略管线
  ├─ 10.8 MCP 连接池
  └─ 10.9 进度回调
```

---

## 附录：关键文件路径对照

| 功能模块 | OpenClaw | Sarosis |
|----------|----------|---------|
| 工具类型定义 | `src/tools/types.ts` | `src/vs/sessions/.../common/providers.ts` |
| 工具注册 | `src/agents/openclaw-tools.registration.ts` | `src/vs/sessions/.../browser/agentStudio.contribution.ts` |
| 内置工具 | `src/agents/tools/` (各子目录) | `src/vs/sessions/.../browser/providers/tool/builtinToolProvider.ts` |
| MCP 运行时 | `src/agents/pi-bundle-mcp-runtime.ts` | `src/vs/sessions/.../browser/providers/tool/mcpToolProvider.ts` |
| MCP 工具物化 | `src/agents/pi-bundle-mcp-materialize.ts` | (桥接上游 IMcpService) |
| 工具调用解析 | `src/agents/openai-transport-stream.ts` | `src/vs/sessions/.../browser/agentOSService.ts` |
| 工具策略 | `src/agents/tool-policy-pipeline.ts` | (无) |
| 可用性评估 | `src/tools/availability.ts` | (无) |
| 安全审批 | `src/agents/pi-tools.before-tool-call.ts` | (无) |
| 文本清理 | `src/shared/text/assistant-visible-text.ts` | `src/vs/sessions/.../common/assistantVisibleText.ts` |
| 流式装配 | (SDK 内部) | `src/vs/sessions/.../browser/toolCallUtils.ts` |
| 工具 UI | (客户端独立实现) | `src/vs/sessions/.../browser/views/toolsView.ts` |
| MCP UI | (客户端独立实现) | `src/vs/sessions/.../browser/views/mcpView.ts` |
