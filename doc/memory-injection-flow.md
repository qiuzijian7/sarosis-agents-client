# 会话记忆注入系统提示 — 调用链路与格式

## 文档信息
- **创建时间**: 2026-06-23
- **版本**: v1.0
- **适用范围**: Saros Agents Client 记忆系统调试与开发

---

## 一、核心结论（速查）

| 问题 | 答案 |
|------|------|
| **何时注入** | 每次 Agent 请求开始时，**一次性注入**（冻结快照模式） |
| **注入位置** | `messages` 数组最前面（所有 system / user 消息之前） |
| **注入格式** | `<memory_context>...</memory_context>` 包裹的 system 消息 |
| **中途更新** | ❌ 不支持，会话内保持冻结，新记忆下次会话生效 |
| **设计来源** | 借鉴 Hermes Agent 的"冻结快照"机制 |

---

## 二、注入时机详解

### 2.1 两个调用入口

记忆注入有两处实现，分别对应两条执行路径：

| 路径 | 入口文件 | 触发条件 |
|------|----------|----------|
| **Path 1（直通模式）** | `agentOSService.ts` → `sendMessage()` | 用户在工具栏选择模型直接对话 |
| **Path 2（Agent Loop 模式）** | `executionProvider.ts` → `runAgentLoop()` | 通过 Agent Studio 完整流程执行 |

> **历史 BUG**：Path 1 之前只有一行 `_logService.info('Memory provider available')`，根本没有调用 `loadContext`，导致选模型直接对话时 L1/L2/L3 记忆永远不注入。此 BUG 已修复。

### 2.2 时序图（文字版）

```
用户发送消息
    │
    ├─ Path 1: agentOSService.sendMessage()
    │       │
    │       ├─ 1. 解析 memoryScope（从 request 对象）
    │       ├─ 2. 抽取最近一条 user 消息作为 recallQuery
    │       ├─ 3. memoryProvider.loadContext(agentId, sessionId, recallQuery, recallOptions)  ← 注入时机
    │       ├─ 4. 按 strategy 过滤（summary / full）
    │       ├─ 5. 组装 <memory_context> 块
    │       ├─ 6. messages.unshift(system_message)  ← 注入动作
    │       └─ 7. 调用 LLM API（带记忆的 messages）
    │
    └─ Path 2: executionProvider.runAgentLoop()
            │
            ├─ 1. 解析 memoryScope（从 request 对象）
            ├─ 2. 抽取最近一条 user 消息作为 recallQuery
            ├─ 3. memoryProvider.loadContext(agentId, sessionId, recallQuery, recallOptions)  ← 注入时机
            ├─ 4. 按 strategy 过滤（summary / full）
            ├─ 5. 组装 <memory_context> 块
            ├─ 6. messages.unshift(system_message)  ← 注入动作
            └─ 7. 进入 agent loop（迭代调用 LLM）
                    │
                    └─  loop 内不再调用 loadContext（冻结语义）
```

---

## 三、注入格式详解

### 3.1 外层结构

记忆内容被包裹在一个独立的 `system` 消息中，插入到 `messages` 数组的最前面：

```json
{
  "role": "system",
  "content": "<memory_context>\n...记忆内容...\n</memory_context>"
}
```

### 3.2 内容结构（`memoryParts` 组装顺序）

按以下顺序拼接（空内容自动跳过）：

```
<memory_context>

## Long-term Memory (TDB-AM Recall)    ← L1/L2 召回（longTermMemories）
<逐条记忆内容，每条之间空一行>

## Short-term Memory                  ← L0 最近上下文（shortTermMemories，仅 full 策略）
<逐条记忆内容，每条之间空一行>

<systemPrompt 原文>                ← 第三方 Memory Provider 直接返回的格式化字符串
                                     （属于 L1 范畴，summary & full 均注入）

</memory_context>
```

### 3.3 各字段来源

| 字段 | 来源 | 注入条件 |
|------|------|----------|
| `Long-term Memory` | `IMemoryContext.longTermMemories[].content` | `filteredLongTerm.length > 0`（summary & full 均注入） |
| `Short-term Memory` | `IMemoryContext.shortTermMemories[].content` | `strategy === 'full'` 且 `filteredShortTerm.length > 0` |
| `systemPrompt` | `IMemoryContext.systemPrompt`（由 Memory Provider 端格式化） | 非空即注入（summary & full 均注入） |

### 3.4 策略过滤逻辑

```typescript
const strategy = request.memoryStrategy === 'summary' ? 'summary' : 'full';
// summary → 仅 L1（longTermMemories）
// full    → L1 + L0（longTermMemories + shortTermMemories）

const maxEntries = request.memoryMaxEntries; // 上限截断
```

`maxEntries` 截断逻辑（`executionProvider.ts` 第 97-101 行）：

```typescript
const cap = <T,>(arr: T[] | undefined): T[] => {
    if (!arr || arr.length === 0) { return []; }
    if (maxEntries === undefined) { return arr; }
    return arr.length > maxEntries ? arr.slice(-maxEntries) : arr;
};
```

---

## 四、完整函数调用图

### 4.1 Path 1（直通模式）— `agentOSService.ts`

```
用户点击"发送"
    │
    ▼
agentOSService.sendMessage(request: IAgentTurnRequest)
    │
    ├─ 读取 request.memoryScope          ← 缺省 'agent'
    ├─ 抽取 recallQuery                  ← 最近一条 user 消息 content
    │
    ▼
memoryProvider.loadContext(
    agentId, sessionId, recallQuery, { scope }
)
    │
    ▼
SessionMemoryProvider.loadContext()      ← 实现在 sessionMemoryProvider.ts
    │
    ├─ _readJsonl(short-term.jsonl)    ← 读短期记忆
    ├─ _readJsonl(long-term.jsonl)     ← 读长期记忆
    └─ _buildSystemPrompt()             ← 将记忆格式化为文本
            │
            ▼
    返回 IMemoryContext
    │
    ▼
agentOSService（继续）
    │
    ├─ 按 strategy 过滤（summary / full）
    ├─ 组装 memoryParts[]
    ├─ 拼接为 <memory_context>...</memory_context>
    ├─ messages.unshift({ role:'system', content: frozenMemoryBlock })
    │           ↑ 注入到消息队列最前面
    └─ 调用 LLM API（带记忆的 messages）
```

### 4.2 Path 2（Agent Loop 模式）— `executionProvider.ts`

```
用户触发 Agent 执行
    │
    ▼
executionProvider.runAgentLoop(request: IAgentTurnRequest)
    │
    ├─ 读取 request.memoryScope          ← 缺省 'agent'
    ├─ 抽取 recallQuery                  ← 最近一条 user 消息 content
    │
    ▼
memoryProvider.loadContext(
    agentId, sessionId, recallQuery, { scope }
)
    │
    ▼
SessionMemoryProvider.loadContext()      ← 同上
    │
    ▼
返回 IMemoryContext
    │
    ▼
executionProvider（继续）
    │
    ├─ 按 strategy 过滤（summary / full）
    ├─ 组装 memoryParts[]
    ├─ 拼接为 <memory_context>...</memory_context>
    ├─ messages.unshift({ role:'system', content: frozenMemoryBlock })
    │           ↑ 注入到消息队列最前面
    │
    ▼
进入 while (budget.hasRemaining()) loop
    │
    ├─ iteration 1: 调用 LLM（带记忆）
    ├─ iteration 2+: 不再调用 loadContext（冻结语义）
    └─ loop 结束
```

### 4.3 前置步骤 — `agentDriverService.ts`（两路径共用）

在 `Path 1` 和 `Path 2` 之前，`agentDriverService.ts` 会先解析 `memoryScope`：

```
agentDriverService.runTurn(request)
    │
    ▼
Step 1: 解析召回作用域（memoryScope）
    │
    ├─ 读取 AgentBinding.memoryConfig.scope
    │       └─  fallback: 'agent'（最严格隔离）
    │
    ├─ 将 scope 写入 enrichedRequest.memoryScope
    │       └─ 供后续 Path 1 / Path 2 直接使用
    │
    ▼
Step 2+: 分发到 Path 1 或 Path 2
    │
    ├─ Path 1: agentOSService.sendMessage(enrichedRequest)
    └─ Path 2: executionProvider.runAgentLoop(enrichedRequest)
```

---

## 五、关键文件索引

| 文件 | 职责 |
|------|------|
| `src/vs/sessions/contrib/agentStudio/browser/providers/memory/sessionMemoryProvider.ts` | `loadContext()` 实现：读 JSONL → 返回 `IMemoryContext` |
| `src/vs/sessions/contrib/agentStudio/browser/agentOSService.ts` | Path 1 注入逻辑（第 522-638 行） |
| `src/vs/sessions/contrib/agentStudio/browser/providers/execution/executionProvider.ts` | Path 2 注入逻辑（第 66-155 行） |
| `src/vs/sessions/contrib/agentStudio/browser/agentDriverService.ts` | 解析 `memoryScope`，分发到 Path 1/2（第 73-132 行） |
| `src/vs/sessions/common/providers.ts` | `IMemoryProvider`、`IMemoryContext`、`IAgentTurnRequest` 接口定义 |

---

## 六、调试要点

### 6.1 日志关键字

| 关键字 | 含义 |
|--------|------|
| `[AgentOS] Injected frozen memory snapshot` | Path 1 注入成功 |
| `[ExecutionProvider] Injected frozen memory snapshot` | Path 2 注入成功 |
| `[AgentDriver] Loaded memory context` | `agentDriver` 成功解析 scope 并调用 `loadContext` |
| `strategy=` | 当前使用的策略（summary / full） |
| `L1/L2=${N}` | 注入的长期记忆条数 |
| `L0=${N}` | 注入的短期记忆条数 |

### 6.2 常见问题排查

| 现象 | 可能原因 | 排查方式 |
|------|----------|----------|
| 记忆不注入 | Path 1 旧 BUG 未修复 | 搜索 `agentOSService.ts` 是否有 `loadContext` 调用 |
| 记忆内容为空 | `shortTerm.jsonl` / `longTerm.jsonl` 文件不存在或为空 | 检查 `<userRoamingDataHome>/.saros/memory/<agentId>/` 目录 |
| scope 不生效 | `AgentBinding.memoryConfig.scope` 未正确持久化 | 检查 `.sarosworkspace/agent-bindings.json` |
| 中途写入不生效 | 冻结快照设计（预期行为） | 新记忆下次会话才生效，符合设计 |

---

**文档结束**
