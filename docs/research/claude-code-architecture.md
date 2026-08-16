# Claude Code 核心机制调研：Goal / Loop / Batch / Simplify / Debug

> 基于 Claude Code 51 万行源码泄露的分析 + 社区逆向研究 + 官方文档
> 调研时间：2026-06-14

---

## 目录

1. [Goal —— 目标设定与任务规划](#1-goal--目标设定与任务规划)
2. [Loop —— 主控制循环](#2-loop--主控制循环)
3. [Batch —— 批量/并行执行](#3-batch--批量并行执行)
4. [Simplify —— 上下文压缩](#4-simplify--上下文压缩)
5. [Debug —— 验证与自修正](#5-debug--验证与自修正)
6. [对 Saros 的借鉴意义](#6-对-saros-的借鉴意义)

---

## 1. Goal —— 目标设定与任务规划

Claude Code 有两种目标系统，互补使用：

### 1.1 TodoWrite（LLM 驱动任务拆解）

**核心思想**：不让模型凭记忆记住做到了哪一步，让它用数据记住。

```typescript
// 数据模型
interface Todo {
  content: string;       // 任务描述
  status: "pending" | "in_progress" | "completed" | "cancelled";
  activeForm?: string;   // 进行时的描述（如 "正在添加登录路由"）
}

interface TodoWriteInput {
  todos: Todo[];
  // 线程隔离：oldTodos 与 newTodos 的 diff 保证跨多轮一致
}
```

关键设计点：
- **Plan-Execute-Verify 三阶段模式**：先规划→按序执行→验证所有更改
- **动态调整**：执行中发现新信息时，模型可追加新任务、修改已有任务、取消不再需要的任务
- **System prompt 注入提醒**：每次工具调用后，system message 注入当前 TODO 列表状态，防止模型在长对话中"忘记"目标
- **TodoWrite 只支持全量更新**，不支持部分更新——通过 `oldTodos`/`newTodos` 对比保持一致性
- **UI 渲染**：任务列表在终端渲染为交互式 checklist，用户可实时看到进度

### 1.2 /goal 命令（条件驱动的自主循环）

**核心机制**：**执行与评估分离** 的双模型循环。

```
用户设定目标条件 → 主模型执行一轮操作 → 评估模型独立判定条件是否满足
                                                ↓
                    不满足 ← 评估模型返回原因 → 主模型根据原因继续下一轮
                                                ↓
                    满足 → 循环结束
```

关键设计点：
- **评估独立**：评估模型（默认 Haiku）独立判定条件是否满足，不能运行命令或读文件——只评审会话中已明确输出的内容
- **Token 效率**：评估模型 token 消耗远低于主模型（Haiku ≈ 70-80% 便宜），不增加显著开销
- **硬限制**：条件长度上限 4000 字符，单会话只支持一个激活目标
- **目标语法示例**：`/goal 修复 src 目录下所有 lint 错误，直到 eslint 输出无错误信息`

### 1.3 Plan Mode（显式规划模式）

- `--plan` 或 `/plan` 进入：Claude 在写任何代码前必须先输出方案
- 支持探索阶段（并行 Explore Agent）、方案设计（并行 Plan Agent）、审查对齐、写入 plan.md
- Plan 文件（plan.md）可作为断点续传——进程 Crash 后重喂给模型即可恢复

---

## 2. Loop —— 主控制循环

### 2.1 核心循环（nO + h2A）

Claude Code 的循环不是简单的 `while`，而是一个**两层异步状态机**：

```
┌─────────────────────────────────────────────┐
│  外层 QueryEngine (会话管理)                  │
│  - 多轮状态、transcript 持久化               │
│  - SDK 协议适配、usage 累积                  │
│  - 消费内层 queryLoop 的 AsyncGenerator 输出  │
├─────────────────────────────────────────────┤
│  内层 queryLoop (单轮执行)                    │
│  - while(true) 循环                          │
│  - State { messages, toolUseContext,          │
│           turnCount, transition, ... }        │
│  - 7 种恢复路径 + 10 种终止条件               │
└─────────────────────────────────────────────┘
```

### 2.2 基础循环模式

```typescript
// 极简核心逻辑
while (true) {
  const response = await model.generate(messages);
  if (response.stop_reason !== "tool_use") break;

  for (const block of response.content) {
    if (block.type === "tool_use") {
      const result = await executeTool(block.name, block.input);
      messages.push({ role: "user", content: [result] });
    }
  }
}
```

**设计哲学**：
- 单一主线程，一个平坦的消息列表——没有 swarm，没有多 agent 竞争
- 最多一个 sub-agent 分支（子 agent 不能再 spawn 子 agent）
- 当 Claude 输出纯文本（无 tool call）时循环自然终止

### 2.3 h2A 异步双缓冲队列（实时转向）

- **pause/resume** 支持——用户可在中途注入新指令而不需要完全重启
- nO 与 h2A 协同工作：用户输入→h2A 队列→nO 消费→产生输出→反馈给用户
- 这种交互性让 Claude Code 从"批处理器"变成"真正的编码伙伴"

### 2.4 为什么用 AsyncGenerator？

三个原因：
1. **背压控制**：调用方按需消费，不会被消息洪水淹没
2. **中断语义**：generator 的 `.return()` 会级联关闭所有嵌套 generator，取消操作自然传播
3. **流式组合**：子 agent 的 `runAgent()` 也是 AsyncGenerator，可直接嵌套在父 agent 流中

### 2.5 Token Budget 机制

当模型自然停止（`end_turn`）但 token 预算未用完时：
- 系统注入 **nudge 消息**让模型继续工作
- **递减收益检测**：连续 3 次检查每次增量都 < 500 tokens → 说明已无实质性工作 → 停止
- 只适用于主线程 agent，子 agent 不参与

---

## 3. Batch —— 批量/并行执行

### 3.1 两种执行模式

| 模式 | 行为 | 特点 |
|------|------|------|
| **BatchMode** | 等 API 流式接收完全结束，然后按序执行所有工具 | 简单可靠，延迟高 |
| **StreamingToolExecutor（默认）** | API 流式接收期间，每收到一个 tool_use block 就立即开始执行 | 性能优化的关键 |

### 3.2 并行分区算法（StreamingToolExecutor）

```
核心规则：
1. 每个工具通过 isConcurrencySafe(input) 声明自己是否可并行
2. 连续的并发安全工具组成一个"并行分区"
3. 遇到非并发安全工具就开始新分区
4. 分区之间串行执行，分区内部并行执行
```

```typescript
// 伪代码
interface Tool {
  isConcurrencySafe(input: unknown): boolean;
}

function partitionTools(toolCalls: ToolCall[]): ToolCall[][] {
  const partitions: ToolCall[][] = [];
  let current: ToolCall[] = [];

  for (const call of toolCalls) {
    if (isToolConcurrencySafe(call.name, call.input)) {
      current.push(call);  // 同一个并行分区
    } else {
      if (current.length > 0) partitions.push(current);
      current = [call];     // 开始新分区（串行屏障）
    }
  }
  if (current.length > 0) partitions.push(current);
  return partitions;
}

// 分区间串行，分区内并行
for (const partition of partitions) {
  await Promise.all(partition.map(call => executeTool(call)));
}
```

### 3.3 并发安全判断

| 工具 | 是否并发安全 | 原因 |
|------|-------------|------|
| FileRead | ✅ 安全 | 只读不写，天然无冲突 |
| Grep | ✅ 安全 | 只读搜索 |
| Glob | ✅ 安全 | 只读文件匹配 |
| FileEdit | ❌ 不安全 | 并行编辑同一文件导致行号偏移和冲突 |
| Bash（写操作） | ❌ 不安全 | 可能产生文件系统竞争 |

**防御性设计**：如果 `isConcurrencySafe` 调用抛出异常（如输入解析失败），**默认视为不安全**（fail-closed 原则）。

### 3.4 BatchTool

专用批量工具，支持将多个原子操作打包为一个调用，减少 round-trip：
```json
{
  "name": "BatchTool",
  "operations": [
    { "tool": "Read", "input": { "file_path": "a.ts" } },
    { "tool": "Read", "input": { "file_path": "b.ts" } }
  ]
}
```

---

## 4. Simplify —— 上下文压缩

### 4.1 压缩管线（从轻到重）

每次 API 调用前，消息经过一条多阶段处理管线：

```
轻量操作（本地，0 成本）
    ↓
Context Collapse（按重要性折叠，保留细粒度）
    ↓
AutoCompact（API 调用生成全量摘要，最昂贵）
    ↓
重建阶段（重新注入关键文件 + skill 指令）
```

**设计哲学**：如果前面的轻量操作已释放足够空间，AutoCompact 就不触发。

### 4.2 AutoCompact (wU2) 详细设计

**触发阈值**：
```
有效上下文窗口 = 模型上下文窗口 - max(max_output_tokens, 20000)
触发阈值 = 有效上下文窗口 - 13000
```
对于 200k 上下文的模型，约在 **167k tokens** 时触发（约 92% 窗口使用率）。

**断路器机制**：
- 连续失败 **3 次**后停止重试
- 真实数据：1,279 个 session 有 50+ 次连续失败（最高 3,272），浪费 ~250K API 调用/天

### 4.3 摘要 Prompt 的"反遗忘"设计

要求保留 **9 类信息**，其中特别强调：
- **所有用户消息**（原文要求 "ALL user messages that are not tool results"）
- 直接引用最近对话内容

> 设计动机：如果压缩后丢失了"用户说不要用 Redux"，模型可能在后续对话中又引入 Redux。

### 4.4 Context Collapse vs AutoCompact 互斥

当 Context Collapse 启用时，AutoCompact 被抑制。

原因：AutoCompact 的"全量摘要"会**摧毁** Collapse 保留的细粒度上下文。系统选择更精细的策略 → Collapse 优先。

### 4.5 记忆系统：CLAUDE.md

- 项目根目录下的 Markdown 文件，每次对话开始时读取
- 200 行以内、2000 token 以下
- 内容：构建命令、代码风格、工作流规则等持久上下文
- `/init` 命令自动生成，后续可手动精化

---

## 5. Debug —— 验证与自修正

### 5.1 Verification Agent（内置验证子代理）

Claude Code 源码中有一个专门的 **Verification Agent**，system prompt 最长（约 120 行）。

**核心设计**：
- 明确列出 LLM 常见的**验证逃避模式**：
  - "代码看起来正确"
  - "测试已经通过了"
- 强制要求：**每个检查必须有实际执行的命令和输出**
- `background: true` —— 总是异步运行，不阻塞主 agent

**Agent 配置**：
| 属性 | 值 | 说明 |
|------|-----|------|
| 模型 | inherit | 继承父 agent 模型 |
| 权限 | 只读（项目目录），可写 /tmp | 独立验证环境 |
| 执行模式 | 总是异步 | 不阻塞主 agent |

### 5.2 三层 Hooks 验证体系

> 来源：Boris Cherny（Claude Code 作者）确认 + 社区实践

```
Layer 1: Syntax Check（PostToolUse Hook）
  - 每次 Write/Edit 后运行 lint/typecheck
  - 快速、确定性、零 token 成本
  - 错误通过 additionalContext 注入下一轮

Layer 2: Intent Verification（Stop Prompt Hook）
  - 当 Claude 尝试停止时触发
  - 由 LLM 检查原始需求是否被真正满足
  - block/allow 双向决策

Layer 3: Regression Check（Stop Command Hook）
  - 确定性检查：测试是否通过？构建是否成功？
  - exit 2 阻止停止，错误信息注入为反馈
  - 内置无限循环保护：stop_hook_active 检查
```

**ROI 排序**：Layer 3（测试运行器）→ Layer 1（lint 检查）→ Layer 2（意图验证）

### 5.3 Agent Loop 中的自我修正

基础循环本身就是修正机制：
```typescript
// 工具错误 → 模型感知 → 自动调整 → 重试
try {
  result = executeTool(tool.name, tool.input);
} catch (error) {
  result = `ERROR: ${error.message}. Please adjust and retry.`;
}
messages.push({ role: "user", content: [result] });
```

**7 种恢复路径**（queryLoop 状态机内）：
- `prompt-too-long` → reactiveCompact 扣留 → 压缩后重试
- `media-size` → 剥离过大图片
- `max_output_tokens` → 等待恢复循环
- 连续错误计数器 + 指数退避

### 5.4 递增成本效率

| 指标 | 无验证 | 有验证 |
|------|--------|--------|
| Token 成本 | 基线 | +10-20% |
| 返工率 | 20-30% | ~5-10% |
| 每周浪费工时 | ~7 hours | ~2-3 hours |
| "Done" 意味着完成 | 有时 | 几乎总是 |

---

## 6. 对 Saros 的借鉴意义

### 6.1 Goal：可直接借鉴的模式

| Claude Code 特性 | Saros 可借鉴 |
|------------------|---------------|
| TodoWrite 全量更新 | 已有类似机制（AgentChat 中的任务卡），可增加 `oldTodos`/`newTodos` diff 校验 |
| /goal 双模型循环 | 工作流 Agent 中可引入"执行→评估→修正"循环体，用轻量模型做验收 |
| Plan Mode 5 阶段 | 现有 OrchestrationPlan 可对齐为：Explore→Design→Review→Write Plan→Approve |

### 6.2 Loop：架构差异分析

| 特性 | Claude Code | Saros 现状 |
|------|------------|-------------|
| 循环模型 | 单主循环 + 最多 1 sub-agent | 多 Agent 独立会话，通过会话隔离 |
| 消息结构 | 平坦消息列表 | 按 session 分组的 ChatMessages |
| 取消机制 | AsyncGenerator `.return()` 级联 | `cancelAgentLoop()` + `cancelStream()` |
| 实时转向 | h2A 队列 | 直接 postMessage 到 webview |

**建议**：Saros 的 Agent Chat 本质上是多会话并行，与 Claude Code 的单线程模型不同。但可以在工作流执行层面引入"单一控制循环 + 子节点 AsyncGenerator 嵌套"模式。

### 6.3 Batch：可立即实施

当前 Execute 按钮已有并行工具调用，但缺少：
1. **显式并发安全声明**：为每个 Capability Provider 的工具添加 `isConcurrencySafe` 属性
2. **并行分区算法**：`StreamingToolExecutor` 的分区逻辑可直接移植
3. **BatchTool**：工作流中可引入批量节点，一次执行多个工具

### 6.4 Simplify：高优先级

当前 Saros 缺少上下文压缩，长对话后质量下降。建议：
1. **CLAUDE.md 等价物**：已在用 Agent Studio 的 System Prompt 配置
2. **AutoCompact**：引入阈值触发（如 >80% 上下文窗口），用轻量模型生成摘要
3. **四层策略**：本地清理→渐进式折叠→API 摘要→重建关键文件

### 6.5 Debug：差异化需求

Claude Code 的三层 Hooks 体系可对齐到 Saros：
- Layer 1（Syntax）：已有 TypeScript 编译错误诊断
- Layer 2（Intent）：工作流中的验证节点（已在实施）
- Layer 3（Regression）：工作流完成后自动运行测试 → 失败则自动重试

**独有的 Saros 优势**：工作流可视化使得 debug 过程对用户完全透明——每个节点的输入/输出/错误都可实时查看。
