# AgentLoop 编排范式专项优化方案

> 状态：设计定稿，待逐项实施
> 日期：2026-07-20
> 目标：将当前 agentloop 对齐用户期望的"思考 → 并行探索 → 汇总再思考 → 拆分计划 → 子代理独立执行"编排范式
> **重要原则：本方案已逐条核查现有实现，明确区分「✅ 已实现（勿重复设计）」与「⚠️ 待优化」，避免重复造轮子。**

---

## 一、目标范式（用户期望的 9 步顺序）

```
1. 主 agent 接收用户需求
2. 先思考问题，输出思考过程（thinking 可见）
3. 再调用 plan_explore（如需要）
4. plan_explore 中子代理并行、流式输出到卡片
5. 等待所有子代理执行完毕
6. 主 agent 对汇总信息再思考（thinking 可见）
7. 任务拆分，生成执行计划
8. 执行计划
9. 计划中每个任务由子代理独立完成
```

---

## 二、现状核查表（基于源码逐行核实，带锚点）

| # | 能力点 | 状态 | 现有实现位置 / 证据 |
|---|---|---|---|
| 1 | 接收需求 | ✅ 已实现 | 主 turn 入口，无需改动 |
| 2 | 先思考并输出思考过程 | ⚠️ 部分 | `thinking` delta 渲染已支持（`nativeChatEditorPane.ts:1954` case 'thinking'）；但**无 prompt 强制"先思考再调工具"**，依赖模型 reasoning 能力 |
| 3 | 按复杂度判断是否 explore | ⚠️ 软约束 | `CRAFT_MODE_SYSTEM_PROMPT` 的 SKIP/触发条件（`chatModeConfig.ts:270-280`）；**纯 LLM 语义判断，无代码强制** |
| 4 | 子代理并行 + 流式卡片 | ✅ 已实现 | `plan_explore`→`dispatchParallelExplore`（`unifiedSubAgentDispatch.ts:1038`）；流式旁路 `onDidSubAgentTrace`→`_upsertSubAgentCards`（`nativeChatEditorPane.ts:1226/1884`）。**本会话刚修复：并发真并行(≤5)、结果对齐、卡片位置字段名 bug、子代理深读 prompt** |
| 5 | 等待全部完成 | ✅ 已实现 | `plan_explore` handler `await dispatch.dispatchParallelExplore(...)` blocking |
| 6 | 汇总后再思考 | ⚠️ 部分 | 同 #2：findings 注入上下文后由 LLM 综合，但无强制思考输出 |
| 7 | 拆分生成计划 | ✅ 已实现 | LLM 写 `## Tasks` → `plan_exit` → `_parsePlanDocument` → `_orchestratePlan`（`agentOSService.ts:591`）→ `createPlanFromTasks`（`taskOrchestrationService.ts:1067`） |
| 8 | 执行计划（DAG 调度） | ✅ 已实现 | `_executePlan`（`taskOrchestrationService.ts:544`）+ DAG ready queue（`taskDag.ts` getReadyTasks / `_tryAutoExecutePendingTasks:610` / `_unblockDependentTasks`）+ persist-before-execute CAS |
| 9 | 每个任务由子代理独立完成 | 🔴 **断裂** | 机制存在（`_executeTask:2986` 以 `assigneeId` agent 独立 session + 完整 turn 执行，甚至可再派 explore 子代理 `_executeExploreSubAgents`）；**但 plan_exit 计划的 task 无 assignee，导致永不执行**（详见 P0-1） |

**结论**：范式主链路（#4/#5/#7/#8/#9 机制）**均已实现**，不需重新设计。真正待优化的是 **#9 的 assignee 断裂（P0）** 与 **#2/#6 的思考可见性（P1）**、**#3 的编排确定性（P2）**。

---

## 三、差距清单与优化方案（按优先级）

### 🔴 P0-1：plan_exit 计划的 task 无 assignee，计划创建后不执行

**根因（已核实）**：
- `createPlanFromTasks`（`taskOrchestrationService.ts:1109-1119`）：`assigneeId` 靠 `suggestedRole` 匹配现有 agent 名解析；匹配不到则 `assigneeId=undefined, autoCreateAgent=true`。
- CRAFT 的 `## Tasks` 格式（`chatModeConfig.ts:254-260`）字段为 Title/Description/Files/Dependencies/Deliverable/Complexity —— **无角色/assignee 字段** → 解析出的 task 全部 `suggestedRole` 缺失 → 全部 `assigneeId=undefined`。
- 执行路径全部要求 assignee：`_tryAutoExecutePendingTasks:628` 的 `.filter(t => t.assigneeId && ...)`；`_executeTask:2987` 的 `if (!task.assigneeId) return`。
- **`autoCreateAgent` 标志从未在 plan 执行路径被消费**（全文件仅设置于 1119/1475/1828、统计于 3204，无物化逻辑）。`ensureTaskAgent`（含自动建 agent，2223）**只在任务看板路径调用**，plan 路径未接入。

**后果**：plan_exit 后计划创建成功、看板同步（`approvePlan:534`），但所有 ready task 因无 assignee 被静默跳过 → 需求 9 完全断裂。

**优化方案（三选一，推荐 A）**：
- **方案 A（推荐，最小改动）**：在 `_executePlan` 与 `_tryAutoExecutePendingTasks` 派发前，对 `autoCreateAgent===true || !assigneeId` 的 ready task 调用一个新的 `_materializeAssignee(plan, task)`：优先按 `assigneeRole` 匹配现有 agent，否则复用 `ensureTaskAgent` 的建 agent 逻辑（抽出 planTask 版本），赋 `assigneeId` 并落盘，再进入派发。
- **方案 B**：扩展 `## Tasks` 格式 + `parsePlanDocument`，新增可选 `Role:` 字段；`workMode.ts` 解析 `suggestedRole`。仍需 A 的兜底（用户没写 Role 时）。
- **方案 C**：为 plan 执行引入"默认执行 agent"——所有无 assignee task 交由 planner 本身或一个通用 executor agent 顺序执行。语义最简单但失去"多子代理并行"。

**推荐组合**：A（兜底建 agent，保证一定能执行）+ B（允许显式指定角色，语义更清晰）。

**改动文件**：`taskOrchestrationService.ts`（新增 `_materializeAssignee`，接入 `_executePlan`/`_tryAutoExecutePendingTasks`）；可选 `chatModeConfig.ts` + `workMode.ts`（Role 字段）。

**验收**：plan_exit 后 3 个无角色 task 能各自创建/分配 agent 并独立执行，聊天面板显示各 task 的执行 turn。

---

### 🟡 P1-1：思考过程未显式输出（需求 2、6）

**根因（已核实）**：渲染层支持 `thinking` delta（`nativeChatEditorPane.ts:1954`），但提示词无"先思考再行动"的强制约束；对非 reasoning 模型无原生 thinking。

**优化方案**：
- 在 `GLOBAL_SYSTEM_PREFIX` 或 `CRAFT_MODE_SYSTEM_PROMPT` 增加显式指令：
  - "在调用 `plan_explore` **之前**，先用 1-3 句说明你对需求的理解、拆解思路与探索方向。"
  - "在 `plan_explore` 返回后、写 `## Tasks` **之前**，先用 2-4 句综合各子代理发现、指出关键结论与风险。"
- 与现有 `<status_update_spec>` 进度更新协议协同（避免重复/冲突）。
- 复用现有 thinking 渲染；无需新增 delta 类型。

**改动文件**：`chatModeConfig.ts`（仅 prompt）。

**验收**：一次复杂任务中，plan_explore 前后各出现一段可见的思考/综述文本。

---

### 🟡 P2-1：复杂度判断是 LLM 自主而非代码确定（需求 3）

**根因**：见现状表 #3。已知风险：LLM 可能不 plan_enter 直接答（历史日志实证）。

**优化方案（渐进）**：
- **P2-1a（低成本）**：扩展运行时 enforcement——`plan_exit` 前若从未 `plan_explore` 过且任务达复杂度阈值，给 LLM 反馈提示先探索（类比现有 "plan_explore 未 enter 则 auto-enter"）。
- **P2-1b（中成本）**：turn 入口加轻量复杂度启发式（粘贴字节数 / 涉及文件数 / analyze|refactor|diagnose 关键词 → 复杂度分），达阈值时由**代码**注入"必须先 plan_enter"的强 reminder，而非纯靠主 prompt。可复用 `taskDecomposer.ts` 的信号。
- **P2-1c（高成本，后续）**：显式 PlanGraph 状态机（`doc/plan-mode-optimization-design.md` 已有 V2 草案），Enter→Explore→Synthesize→Plan→Execute 强制流转 + checkpoint/resume。

**改动文件**：`agentTurnExecutor.ts`（enforcement）、`chatModeConfig.ts`（reminder）。

---

### 🟢 P3（增强项，非阻塞）

- **P3-1 plan 执行阶段的子代理卡片**：`_executeTask` 通过 `chat.stream.delta` 转发（`taskOrchestrationService.ts:3087`）与 workflow trace 事件（2471+）已有渲染；确认与 `_upsertSubAgentCards` 的卡片体系一致，必要时统一。
- **P3-2 汇总结果完整性**：plan_explore findings 截断 3000B、卡片 output 2000B；对深度探索场景评估是否放宽。
- **P3-3 explore 子代理迭代预算**：`createChildBudget=min(50, remaining*0.6)`（`iterationBudget.ts:61`）通常够；若深读仍不足可为 plan_explore 显式传 `maxIterations`。

---

## 四、实施路线图（逐项优化顺序）

| 阶段 | 项 | 依赖 | 说明 |
|---|---|---|---|
| **第 1 步** | P0-1 方案 A | 无 | **最高优先**——不修则计划不执行，需求 9 断裂。先做兜底建 agent |
| 第 2 步 | P1-1 | 无 | 纯 prompt，低风险，立即提升"思考可见性" |
| 第 3 步 | P0-1 方案 B | 第 1 步 | 增加 Role 字段，语义更清晰（可选） |
| 第 4 步 | P2-1a/1b | 无 | enforcement + 复杂度 reminder，提升编排确定性 |
| 第 5 步 | P3 增强 | 前述 | 卡片一致性 / 预算 / 截断微调 |
| 后续 | P2-1c | 大改造 | PlanGraph 确定性状态机（单独立项） |

---

## 五、已实现能力清单（勿重复设计）

以下能力经核实**已存在且工作**，优化时直接复用，不要重写：

1. 并行子代理引擎 `UnifiedSubAgentDispatch`（dispatchParallelExplore / executeMultipleSubAgents，Promise.allSettled 故障隔离，maxConcurrent 可 per-call 覆盖）。
2. plan_explore blocking 等待 + findings 结构化汇总。
3. 子代理流式旁路总线（`onDidSubAgentTrace` + `_upsertSubAgentCards` + 100ms 节流 + 幂等 upsert + parentToolCallId 位置路由）。
4. 专用 SubAgentCard（`_createSubAgentCard`，"执行过程 N 步" trace 明细 + progress）。
5. plan_enter/plan_exit 控制工具 + workMode 只读隔离 + 审批 gate。
6. plan 解析（`parsePlanDocument` / `## Tasks`）→ OrchestrationPlan（`createPlanFromTasks`）。
7. DAG 调度（`taskDag.ts` 拓扑排序 + ready queue + persist-before-execute CAS + 依赖失败 Blocked 传播）。
8. 单任务执行 `_executeTask`（独立 agent session + 完整 turn + 流式转发 + 任务内可再派 explore 子代理 + AbortController 取消 + 超时监控）。
9. thinking delta 渲染、plan_tasks 专用卡片、mode_changed/work_mode_changed 跨 turn 持久化。

---

## 六、关键源码锚点速查

| 功能 | 文件:行 |
|---|---|
| CRAFT prompt / Tasks 格式 / SKIP 条件 | `common/chatModeConfig.ts:226-280` |
| plan reminder 阶段说明 | `common/chatModeConfig.ts:370-450` |
| plan_exit 拦截 + 审批 | `browser/agentTurnExecutor.ts:2087-2135` |
| plan 编排入口 | `browser/agentOSService.ts:591 _orchestratePlan` |
| 计划创建 + assignee 解析 | `browser/taskOrchestrationService.ts:1067 createPlanFromTasks`（1109-1119）|
| 计划执行 + DAG | `taskOrchestrationService.ts:544 _executePlan` / `610 _tryAutoExecutePendingTasks`（628 assignee 过滤）|
| 单任务执行 | `taskOrchestrationService.ts:2986 _executeTask`（2987 assignee 门）|
| 自动建 agent（仅看板路径） | `taskOrchestrationService.ts:2223 ensureTaskAgent`（2328 Strategy 3）|
| 并行子代理引擎 | `common/unifiedSubAgentDispatch.ts:1038 dispatchParallelExplore` / `967 executeMultipleSubAgents` |
| 子代理预算 | `common/iterationBudget.ts:60 createChildBudget` |
| plan_explore 工具 | `browser/providers/tool/planExploreTool.ts` |
| 流式卡片订阅 + 位置路由 | `browser/nativeChatEditorPane.ts:1226 onDidSubAgentTrace` / `1884 _upsertSubAgentCards` |
| 子代理卡片渲染 | `agentChat/agentChatPanel.toolCards.ts:1578 _createSubAgentCard` / `markdown.ts:407 inline 渲染` |
