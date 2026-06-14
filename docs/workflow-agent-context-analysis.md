# 工作流 Agent 上下文传递机制与风险分析

> 分析日期: 2026-06-12
> 分析范围: `workflowExecutionService.ts` + `agentChatService.ts` + `contextManager.ts` + `executionProvider.ts`

---

## 一、上下文传递全链路

### 1.1 变量替换（两轮设计）

```
┌──────────────────────────────────────────────────────────────┐
│  Pass 1: Pre-execution (所有节点启动前，只跑一次)               │
│  _substituteVariables(workflow, values)                       │
│  替换 {{userVar}} → 用户填入的实际值                            │
│  {{$prev.output}} / {{nodeId.output}} 此时保留为字面量         │
├──────────────────────────────────────────────────────────────┤
│  Pass 2: Per-node (_executeNodeRecursive 入口，每节点跑)       │
│  _substituteUpstreamVariables(executionState, workflow, node) │
│  替换 {{$prev.output}} / {{nodeId.output}} → 上游实际输出      │
│  此时上游节点状态 map 已填充                                    │
└──────────────────────────────────────────────────────────────┘
```

**关键点**：
- 第 1 轮正则 `HOST_VARIABLE_PATTERN = /\{\{(\$?\w+(?:\.\w+)*)\}\}/g` 匹配 `{{input}}` 类用户变量
- 第 2 轮同一正则会匹配 `{{$prev.output}}` 和 `{{myNode.output}}`——此时 value map 里 Layer 3 已填好值
- `data.prompt` / `data.skillArgs` / `data.toolParams` **原地变异**，4 个节点执行器（task/agent/skill/tool）都直接读

### 1.2 Agent 节点执行链路

```
_executeAgentNode(node, executionState, workflow)
  │
  ├─→ 1. 获取 prompt
  │     优先 data.prompt（已通过 Pass 2 替换了上游变量）
  │     为空时：仅第一个 agent 节点消费 executionState.context.taskDescription
  │     再为空时：fallback 到 workflow.description 或 node 名称
  │
  ├─→ 2. 获取/创建 session
  │     _getOrCreateAgentSession(agentId, executionId, sessionName)
  │     缓存 key = `${agentId}:${executionId}`
  │     ⚠️ 同一 agentId + 同一 executionId → 共享同一 session
  │
  ├─→ 3. 调用 LLM
  │     _sendAndTrackStream(executionState, node, agentId, prompt, agentSessionId, onDelta)
  │       └→ agentChatService.sendMessage(agentId, prompt, { workspaceId, agentSessionId }, onDelta)
  │
  └─→ 4. 存储输出
        nodeState.output = message.content || ''
```

### 1.3 聊天服务 sendMessage 的上下文构造

```
agentChatService.sendMessage(agentId, message, options, onDelta)
  │
  ├─→ 1. 持久化当前 user 消息（5s 去重窗口）
  │
  ├─→ 2. 加载全量历史 ← 核心！
  │     const history = await this.getHistory(agentId, options.agentSessionId)
  │     ↓
  │     获取该 session 的全部持久化消息（从磁盘 .json + 内存缓存）
  │     ↓
  │     若有 sessionId：还会 merge 无 session 的 system 消息（task orchestration 注入）
  │     ↓
  │     剔除末尾的当前 user 消息（避免重复）
  │     ↓
  │     const priorMessages = this._toDriverMessages(trimmed)
  │     ↓
  │     转为 LLM 兼容格式（role/content/toolCalls/toolCallId）
  │     ⚠️ 不做任何截断——所有历史消息完整传递
  │
  ├─→ 3. 传递给 Driver
  │     this.driverService.executeFromChatOptions(agentId, message, options, priorMessages)
  │     Driver 收到 priorMessages（完整历史）+ 当前 message（用户新输入）
  │
  └─→ 4. 流式接收 + 持久化 assistant 消息
```

### 1.4 历史消息的 _toDriverMessages 处理

```
_toDriverMessages(history: ChatMessage[]) → IChatMessage[]
  │
  ├─→ 去重：折叠相邻重复的 user 消息（persist race 防护）
  ├─→ 过滤：丢弃污染的 assistant（虚假完成语料 + 无工具调用）
  ├─→ 清洗：有工具调用的 assistant 的 content → 空串（仅保留 toolCalls）
  ├─→ 配对：为完成的 toolCalls 生成 tool 角色响应
  └─→ ⚠️ 无截断，全部消息按角色转换后返回
```

### 1.5 Provider 层的上下文压缩（最终防线）

```
ExecutionProvider.run() 主循环
  │
  ├─→ 每次迭代前：
  │     contextManager.compressContext(messages, ..., compressionWindow, lastRealPromptTokens)
  │
  ├─→ 触发条件（默认配置）：
  │     • token 使用量 > 50% contextWindow（compressionThreshold: 0.5）
  │     • 消息数量 >= 10（minMessagesToCompress: 10）
  │     • 用真实 provider usage token 判定，非 char/4 估算
  │
  └─→ Hermes 三段式压缩：
        • PROTECT_FIRST_N = 3：保留前 3 条消息原样
        • TAIL_MIN_MESSAGES = 3：保留最后 3 条消息原样
        • 中间段 → 摘要为 1 条 system 消息（最多 1200 token）
        • compressedMessages 就地替换原 messages 数组
```

---

## 二、识别的 7 个风险

### 🔴 风险 1（HIGH）：跨节点 Session 共享导致上下文污染

**位置**: `workflowExecutionService.ts` L1013-1028

```typescript
// key = `${agentId}:${executionId}`
// 同一 agentId + 同一 executionId → 共享同一 conversation session
private async _getOrCreateAgentSession(agentId, executionId, sessionName) { ... }
```

**场景**：一个工作流有 3 个 Agent 节点，都引用同一个 `agentId: "saros-claw"`。

```
Node 1 → LLM 调用 → assistant 响应（含 tool_calls）
Node 2 → LLM 调用 → 上下文 = Node 1 的完整历史 + Node 2 的 prompt
Node 3 → LLM 调用 → 上下文 = Node 1+2 的完整历史 + Node 3 的 prompt
```

**影响**：
- 节点 2 看到节点 1 的整个对话历史（prompt + response + tool calls + results）
- 节点 3 看到节点 1 + 节点 2 的全部历史
- **优点**：适合顺序链式工作任务（下游自然需要上游上下文）
- **风险**：不适合独立并行或 diamond 分支（不相关的节点上下文互相污染）
- 随着节点增多，上下文迅速膨胀（见风险 2）

**实例**：如果 Node 1 要求"列出所有 .ts 文件"，Node 2 要求"检查代码风格"，Node 2 的 LLM 会看到 Node 1 的文件列表输出作为对话历史的一部分。

### 🔴 风险 2（HIGH）：上下文爆炸，无工作流级消息上限

**链路**：
```
sendMessage → getHistory → 全量消息 → priorMessages → Driver → LLM
                                     ↑ 无截断
```

**问题**：
- 每个 Agent 节点至少产生：1 条 user 消息 + 1 条 assistant 消息 + N 条 tool 消息
- 一个 5 节点工作流可能产生 25+ 条消息、数万 token
- `_toDriverMessages` 不做截断
- 压缩仅在 Provider 层触发（50% 阈值），当上下文快速膨胀时压缩可能**滞后**

**实例推算**：
- 假设 contextWindow = 128K，每个节点产生 3K token
- 5 个节点 = 15K token → 约 11.7% 窗口，远低于 50%，**不触发压缩**
- 10 个节点 = 30K token → 约 23.4%，仍不触发
- 用户可能感知到"越来越慢"但不知道是上下文膨胀导致

### 🟡 风险 3（MEDIUM）：Prompt 节点产生孤儿消息

**位置**: `workflowExecutionService.ts` L782-827

```typescript
// _executePromptNode: 只 append user 消息，不调用 sendMessage
await this.agentChatService.appendMessage(agentId, {
    role: 'user',
    content: promptText,
    agentSessionId,
});
```

**问题**：
- Prompt 节点向会话历史追加 user 消息，但**不产生 assistant 响应**
- 下游 Agent 节点看到的历史中，存在**没有对应响应的 user 消息**
- 破坏 user→assistant→user→assistant 的正常对话节奏
- LLM 可能困惑：上一个"用户"说了什么但"我"没有回答？

**示例**：
```
历史：[user: "列出所有文件"] [assistant: "找到 5 个文件: ..."]
      [user: "检查代码风格"]  ← Prompt 节点注入的孤儿消息
现在：[user: "修复风格问题"]  ← Agent 节点
```

LLM 看到两个连续的 user 消息（"检查代码风格" + "修复风格问题"），但没有中间响应。

### 🟡 风险 4（MEDIUM）：`$prev` 解析依赖于 V8 对象键迭代顺序

**位置**: `templateUtils.ts` L152-158

```typescript
const lastId = Object.keys(args.upstreamOutputs).pop();
if (lastId) {
    const lastOut = args.upstreamOutputs[lastId];
    values['$prev'] = lastOut;
    values['$prev.output'] = lastOut;
}
```

**问题**：
- 依赖 `Object.keys().pop()` 取"最后一个"键 = 最近插入的键
- 现代 V8 中字符串键按插入顺序迭代，但这不是规范保证的行为
- 在 diamond/parallel 分支中，多个节点可能几乎同时完成
- `_collectUpstreamOutputs` 的 `upstream` map 用 `Map.entries()` 遍历，但传给 `buildRuntimeValueMap` 时是一个普通对象——迭代顺序取决于 `Object.entries()` → 映射回对象时的插入顺序
- 代码注释（L1726-1733）也承认了这个脆弱性

### 🟡 风险 5（MEDIUM）：无节点级上下文隔离

**问题**：
- 工作流设计层面没有"此节点仅需上游输出，无需历史对话"的语义
- 所有共享 session 的 Agent 节点默认获得完整历史
- 缺少类似 "context scope: upstream-only" 的配置选项
- 即使用户设计了一个独立子任务，Agent 仍能看到前面所有对话

### 🟢 风险 6（LOW - 已修复）：跨 Session 泄漏

已有多层防御（2026-06-05 修复）：
- `appendMessage` 写入侧：非 system 消息必须带 `agentSessionId`
- `getHistory` 读取侧：仅透传 system 消息，丢弃 user/assistant/tool
- 连续重复 user 消息去重

### 🟢 风险 7（LOW - 已有防御）：双重写入/竞争条件

已有多层防御：
- 5 秒去重窗口（`sendMessage` L741）
- 连续重复 user 消息检测（`appendMessage` L388）
- `_toDriverMessages` 折叠相邻重复（L559）

---

## 三、压缩机制的局限

### 3.1 压缩触发条件偏高

```
compressionThreshold: 0.5  → token > 50% contextWindow 才压缩
minMessagesToCompress: 10   → 至少 10 条消息
```

对于 128K 窗口，需要 64K token 才触发压缩——对于工作流来说太晚了。

### 3.2 压缩是 Provider 层行为，AgentChatService 不感知

```
AgentChatService → 无截断传递全量历史
        ↓
ExecutionProvider → 每迭代执行 compressContext
        ↓
compressContext → 就地替换 messages 数组
```

压缩后的消息不会同步回 AgentChatService 的 `_historyCache`，下次 `sendMessage` 仍从 `_historyCache` 加载全量历史。

**含义**：如果 Provider 层压缩了 50→5 条消息，下次同一个 session 再次调用 `sendMessage`，AgentChatService 仍然会加载 50 条原始消息，然后 Provider 再次压缩。这是**重复压缩开销**。

### 3.3 硬编码的常量和阈值

```
PROTECT_FIRST_N = 3       // 保护前 3 条
TAIL_MIN_MESSAGES = 3     // 保护后 3 条
MAX_INEEFFECTIVE_COMPRESSIONS = 2  // 连续低效压缩后停止
```

这些值硬编码在 `contextManager.ts` 中，无法按工作流类型（简单 vs 复杂）调整。

---

## 四、建议修复方案

### 4.1 优先修复（P0-P1）

| 优先级 | 风险 | 建议修复 |
|--------|------|---------|
| P0 | 上下文爆炸 | 在 `_sendAndTrackStream` 或 `_getOrCreateAgentSession` 处增加工作流级 `maxHistoryMessages` 限制（如 50 条），超过则对 AgentChatService 调用清理旧消息 |
| P0 | Session 共享无隔离 | 增加配置：Agent 节点的 `data.contextScope` = `"session"`（默认，共享历史）或 `"upstream"`（仅上游输出，无历史对话）或 `"fresh"`（新 session，完全隔离） |
| P1 | 压缩滞后 | 将 `compressionThreshold` 从 0.5 降到 0.25（25%），或暴露为工作流级配置 |
| P1 | 重复压缩 | 压缩后将精简后的消息写回 `_historyCache`，避免下次加载全量再压缩 |

### 4.2 后续改进（P2）

| 优先级 | 风险 | 建议修复 |
|--------|------|---------|
| P2 | `$prev` 脆弱的 key 迭代 | 改用显式的 `_collectUpstreamOutputs` 中 `lastId`/`lastOut` 直接注入 `buildRuntimeValueMap`，而非依赖 `Object.keys().pop()` |
| P2 | Prompt 节点孤儿消息 | 给 Prompt 节点的 user 消息追加 `[系统提示: 此消息来自工作流流程，无需生成回复]` 前缀 |
| P2 | 硬编码常量 | 将 `PROTECT_FIRST_N` / `TAIL_MIN_MESSAGES` 等暴露为 Agent 配置项 |

### 4.3 "upstream-only" 上下文模式的实现思路

当 Agent 节点配置 `contextScope: "upstream"` 时：
1. 为该节点创建**独立 session**（不走 `_getOrCreateAgentSession` 缓存）
2. 将上游节点输出作为 system 消息注入（而非对话历史）
3. 当前节点的 prompt 作为唯一的 user 消息
4. 节点执行完毕后，将结果写入父 session 的上下文（供下游引用）

```typescript
// 伪代码
if (data.contextScope === 'upstream') {
    // 创建独立 session
    const isolatedSessionId = await agentChatService.createAgentSession(agentId, `${sessionName}_${node.id}`);
    // 构造仅含上游输出的 system 消息
    const upstreamContext = buildUpstreamContext(executionState);
    // 发送时指定 systemPrompt 而非 priorMessages
    await agentChatService.sendMessage(agentId, nodePrompt, {
        agentSessionId: isolatedSessionId,
        systemPrompt: upstreamContext,  // 需在 IChatSendOptions 新增
    }, onDelta);
}
```

---

## 五、总结

当前工作流 Agent 的上下文传递采用**全量历史 + 延迟压缩**策略：

```
上游输出 → 变量替换 → Prompt 构造 → 全量历史加载 → Driver → Provider 压缩 → LLM
```

| 层级 | 行为 | 截断/限制 |
|------|------|----------|
| AgentChatService | 加载全量持久化历史为 priorMessages | **无** |
| Driver | 透传 priorMessages + 当前 message | **无** |
| ExecutionProvider | per-iteration compressContext | 50% 阈值触发 |
| ContextManager | Hermes 三段式压缩 | 保留头尾 + 摘要中间 |

**核心矛盾**：AgentChatService 层的"全量传递"与工作流多节点的"累积效应"之间的张力。

压缩在工作流场景下**来得太晚**（50% 阈值对短/中工作流几乎不触发），而 AgentChatService 层的全量历史传递意味着**即使节点间无关联，历史也照传不误**。建议在 Agent 节点层面增加上下文范围控制（session/upstream/fresh），让工作流作者能显式管理每个节点的上下文边界。
