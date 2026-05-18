# 任务编排功能设计文档

> **版本**: v2.0  
> **更新时间**: 2026-05-18  
> **核心算法参考**: Ruflo v3 (@claude-flow/swarm)

---

## 1. 功能概述

任务编排（Task Orchestration）允许 Planner Agent 将复杂目标自动分解为可执行的子任务 DAG，经 PM Agent 审批后，系统自动创建 Agent、建立画布连线、调度执行。

### 核心能力

| 能力 | 描述 |
|------|------|
| **目标分解** | 基于类型模板（coding/testing/research/deployment）+ 自然语言分隔符拆分 |
| **DAG 依赖管理** | Kahn 拓扑排序 + DFS 循环检测 + 双向邻接表 |
| **智能调度** | 多维 Agent 评分（能力 40% / 负载 30% / 可用性 30%）+ 并发控制 |
| **自动容错** | 超时监控（5 min）+ 自动重试（3 次）+ 自动依赖解锁 |
| **角色治理** | Planner（可多个，负责编排）/ PM（仅 1 个，负责调度）/ Worker |
| **可视化集成** | 自动画布节点创建 + 上下级连线 + 层级排布 + 任务看板联动 |

---

## 2. 角色模型

```
┌─────────────────────────────────────────────────────┐
│                    Workspace                         │
│                                                     │
│  ┌──────────┐   ┌──────────┐   ┌──────────────┐   │
│  │ Planner  │   │ Planner  │   │     PM       │   │
│  │ (可多个) │   │ (可多个) │   │  (仅允许1个) │   │
│  └────┬─────┘   └────┬─────┘   └──────┬───────┘   │
│       │               │                │           │
│       │   createPlan  │   approvePlan  │           │
│       ▼               ▼                ▼           │
│  ┌─────────────────────────────────────────────┐   │
│  │         OrchestrationPlan (DAG)             │   │
│  │  Task A ──→ Task B ──→ Task C              │   │
│  │       \                                     │   │
│  │        ──→ Task D (parallel)               │   │
│  └──────────────────────┬──────────────────────┘   │
│                         │ dispatch                  │
│                         ▼                          │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  │
│  │Worker 1│  │Worker 2│  │Worker 3│  │Worker 4│  │
│  └────────┘  └────────┘  └────────┘  └────────┘  │
└─────────────────────────────────────────────────────┘
```

### 角色权限

| 角色 | agentType | 数量限制 | 能力 |
|------|-----------|---------|------|
| **Planner** | `'planner'` | 无限制 | 创建编排计划（`createPlan`） |
| **PM** | `'pm'` | **仅 1 个** | 批准/拒绝计划、调度任务（`approvePlan`、`taskAction`） |
| **Worker** | `'worker'` | 无限制 | 执行被分配的任务 |

---

## 3. 数据模型

### 3.1 OrchestrationPlan

```typescript
interface OrchestrationPlan {
  id: string;                          // orch_plan_{timestamp}_{random}
  goal: string;                        // 用户输入的目标
  summary: string;                     // Planner 生成的摘要
  status: OrchestrationPlanStatus;     // 生命周期状态
  tasks: PlanTask[];                   // DAG 任务列表
  workspaceId: string;                 // 所属 Workspace
  plannerId: string;                   // 创建此计划的 Planner Agent
  pmId?: string;                       // 负责调度的 PM Agent
  maxConcurrency: number;              // 最大并行数（默认 3）
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  completedAt?: string;
}
```

### 3.2 PlanTask

```typescript
interface PlanTask {
  id: string;                          // orch_task_{timestamp}_{random}
  title: string;                       // 任务标题
  description?: string;                // 详细描述
  status: PlanTaskStatus;              // 任务状态
  dependencies: string[];              // 依赖的任务 ID 列表（DAG 边）
  assigneeId?: string;                 // 分配的 Agent ID
  assigneeName?: string;               // Agent 名称
  assigneeRole?: string;               // Agent 角色
  autoCreateAgent: boolean;            // 是否需要自动创建
  priority: number;                    // 优先级（0=critical, 1=high, 2=medium, 3=low）
  depth: number;                       // 拓扑层级（由算法计算）
  retryCount: number;                  // 当前重试次数
  maxRetries: number;                  // 最大重试次数（默认 3）
  timeoutMs: number;                   // 超时时间（默认 300000ms = 5分钟）
  result?: string;                     // 完成结果
  error?: string;                      // 错误信息
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
```

### 3.3 状态机

**Plan 状态:**
```
PendingApproval → Approved → Executing → Completed
                         ↘ Error
           → Rejected
```

**Task 状态:**
```
Pending → Running → Done
              ↘ Error (retryCount < max → Pending 重试)
              ↘ Error (retryCount >= max → 永久失败)
Pending → Paused → Pending (resume)
任何非终态 → Cancelled
```

---

## 4. 核心算法

### 4.1 DAG 拓扑排序（Kahn 算法）

**目的**: 确定任务执行顺序，计算每个任务的拓扑深度（用于画布层级排布）。

**算法步骤**:
1. 计算每个任务的入度（被依赖数量）
2. 将入度为 0 的任务加入初始队列
3. 逐层处理：当前层按优先级排序后弹出，将依赖者入度减 1
4. 入度变为 0 的任务进入下一层
5. 若最终排序数量 ≠ 总任务数 → 检测到循环依赖

**复杂度**: O(V + E)

```
Layer 0: [Task A (priority=1)]       ← 无依赖
Layer 1: [Task B, Task D]            ← 依赖 A
Layer 2: [Task C]                    ← 依赖 B
```

### 4.2 DFS 循环检测

**目的**: 在添加新依赖前，验证不会产生循环。

**算法**: 从新依赖节点出发 DFS 遍历依赖图，若能到达被依赖节点则存在环。

### 4.3 自动依赖解锁

**目的**: 任务完成后自动推进下游任务。

**算法**:
1. 构建反向邻接表（task → 依赖它的 tasks）
2. 任务 A 完成 → 查找所有依赖 A 的任务
3. 对每个 dependent：检查其所有 deps 是否已完成
4. 若全部完成且未超过并发上限 → 状态提升为 Running

### 4.4 Agent 多维评分

```
Score = Capability × 0.40 + Load × 0.30 + Availability × 0.30
```

| 维度 | 计算方式 |
|------|---------|
| **Capability** | 精确匹配=1.0，部分匹配=0.5~0.8，无匹配=0.3 |
| **Load** | idle=1.0, thinking=0.6, working=0.4, other=0.1 |
| **Availability** | idle/thinking=1.0, working=0.3, other=0.0 |

### 4.5 类型策略分解

基于目标文本关键词检测任务类型，匹配预定义模板：

| 类型 | 触发关键词 | 分解阶段 |
|------|-----------|---------|
| `coding` | code/implement/开发/编码 | 设计与规划 → 实现 → 测试 |
| `testing` | test/测试/qa | 测试分析 → 测试执行 |
| `research` | research/调研/研究 | 信息收集 → 分析总结 |
| `deployment` | deploy/部署/发布 | 构建打包 → 部署发布 |
| `generic` | 其他 | 按分隔符拆分 |

---

## 5. 执行流程

### 5.1 完整生命周期

```
用户输入目标
    ↓
① Planner 调用 createPlan(goal, workspaceId, plannerId)
    ├─ 验证 Planner 角色
    ├─ 类型检测 → 模板分解 / 分隔符分解
    ├─ 拓扑排序 → 验证 DAG 无环 + 计算 depth
    └─ 生成 Plan (status=PendingApproval)
    ↓
② 用户预览计划（列表视图 / 依赖图视图）
    ↓
③ PM 调用 approvePlan(planId)
    ├─ 验证 workspace 有且仅有 1 个 PM
    ├─ Plan.status → Approved → Executing
    └─ 触发 _executePlan()
    ↓
④ _executePlan 执行流程:
    ├─ Step 1: 拓扑排序（再次验证）
    ├─ Step 2: 自动创建 Agent + 智能评分分配
    ├─ Step 3: 自动创建画布连线（source→target）
    ├─ Step 4: 画布层级排布（按 depth 分行居中）
    ├─ Step 5: 创建 TaskBoard 看板项
    └─ Step 6: 启动就绪任务（并发 ≤ maxConcurrency）
    ↓
⑤ 运行时自动管理:
    ├─ 超时监控（每 30s 检查，超时触发 failTask）
    ├─ 自动重试（retryCount < maxRetries → 重新排队）
    ├─ 依赖解锁（任务完成 → unblockDependentTasks）
    └─ 计划完成检测（全部终态 → Plan.status 更新）
```

### 5.2 用户可执行的操作

| 操作 | 条件 | 效果 |
|------|------|------|
| **retry** | Error/Cancelled | 重置为 Pending，retryCount=0 |
| **pause** | Running/Pending | 暂停执行 |
| **resume** | Paused | 恢复为 Pending |
| **cancel** | 非 Done/Cancelled | 标记为 Cancelled |
| **completeTask** | Running | 标记为 Done + 解锁下游 |

---

## 6. 通信协议

### 6.1 请求类型 (WebView → Host)

| 类型 | Payload | 说明 |
|------|---------|------|
| `orchestration.plan` | `{ goal, workspaceId, plannerId }` | 创建编排计划 |
| `orchestration.approve` | `{ planId }` | PM 批准计划 |
| `orchestration.reject` | `{ planId }` | PM 拒绝计划 |
| `orchestration.getPlan` | `{ planId }` | 获取单个计划 |
| `orchestration.listPlans` | `{ workspaceId? }` | 列出计划 |
| `orchestration.taskAction` | `{ planId, taskId, action }` | 任务操作 |

### 6.2 事件类型 (Host → WebView)

| 类型 | Data | 说明 |
|------|------|------|
| `orchestration.planCreated` | OrchestrationPlan | 新计划创建 |
| `orchestration.planUpdated` | OrchestrationPlan | 计划状态变更 |
| `orchestration.taskUpdated` | `{ planId, task }` | 任务状态变更 |

---

## 7. 画布集成

### 7.1 自动排布算法

基于拓扑排序的 `depth` 值进行层级排布：

```
depth=0:  [Agent A]                    ← 顶层（无依赖）
                |
depth=1:  [Agent B]  [Agent D]         ← 第二层
                |
depth=2:  [Agent C]                    ← 第三层
```

**布局参数**:
- 行间距: 220px
- 列间距: 300px
- 起始偏移: (150, 100)
- 每行居中对齐

### 7.2 自动连线

根据 DAG 依赖关系自动创建 `subagent` 类型连线：
- 同一 Agent 的自依赖不创建连线
- 已存在的连线不重复创建
- 连线方向: 上游 Agent → 下游 Agent

---

## 8. 持久化

| 数据 | 文件 | 路径 |
|------|------|------|
| 编排计划 | `orchestration-plans.json` | `~/.agent-studio/data/` |
| 任务看板 | `taskboard.json` | `~/.agent-studio/data/` |
| Agent 数据 | `employees.json` | `.sarosisworkspace/` |

### 并发安全

使用简单自旋锁避免并发文件写入竞态：

```typescript
while (this._writeLock) { await sleep(10); }
this._writeLock = true;
try { await writeFile(...); }
finally { this._writeLock = false; }
```

---

## 9. UI 架构

### 9.1 入口

| 位置 | 触发方式 | 功能 |
|------|---------|------|
| Canvas 顶栏 | "🎯 任务编排" 按钮 | 打开 OrchestrationPlanDialog |
| TaskBoard 面板头部 | "🎯 任务编排" 按钮 | 打开 OrchestrationPlanDialog |
| ActivityBar Tasks | Sidebar 任务列表 | 点击打开 TaskDetail EditorPane |
| ActivityBar Tasks | "📋 Overview" 按钮 | 打开 TaskOverview EditorPane |

### 9.2 OrchestrationPlanDialog

- **阶段一**: 选择 Planner + 输入目标 → "生成计划"
- **阶段二**: 预览计划（列表/依赖图切换）→ PM "批准调度" / "拒绝计划"
- **阶段三**: 执行中 → 每个任务显示 重做/暂停/取消 按钮

### 9.3 TaskOverview EditorPane

5 列 Kanban 看板（Todo/Running/Done/Cancelled/Archived），原生 DOM 渲染在编辑器区域。

### 9.4 TaskDetail EditorPane

单任务详情页：状态 badge + 描述 + 元数据网格 + 操作按钮。

---

## 10. 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `DEFAULT_MAX_RETRIES` | 3 | 任务最大重试次数 |
| `DEFAULT_TIMEOUT_MS` | 300000 (5min) | 任务超时阈值 |
| `DEFAULT_MAX_CONCURRENCY` | 3 | 计划最大并行任务数 |
| Timeout check interval | 30s | 超时检查轮询间隔 |
| Agent scoring weights | 0.4/0.3/0.3 | 能力/负载/可用性权重 |

---

## 11. 文件索引

| 文件 | 路径 | 职责 |
|------|------|------|
| **TaskOrchestrationService** | `browser/taskOrchestrationService.ts` | 核心编排引擎（DAG/调度/超时/重试） |
| **ITaskOrchestrationService** | `common/agentStudioService.ts` | 服务接口定义 |
| **类型定义** | `common/agentStudioTypes.ts` | PlanTask, OrchestrationPlan, AgentType 等 |
| **消息协议** | `browser/messageProtocol.ts` | orchestration.* 请求/事件 |
| **WebView Controller** | `browser/agentStudioWebviewController.ts` | 消息路由 dispatch |
| **Zustand Store** | `webview/src/store/useOrchestrationStore.ts` | 前端状态管理 |
| **计划对话框** | `webview/src/features/orchestration/OrchestrationPlanDialog.tsx` | 编排 UI |
| **TasksViewPane** | `browser/views/tasksView.ts` | ActivityBar 侧边栏任务列表 |
| **TaskOverviewEditorInput** | `browser/taskOverviewEditorInput.ts` | 看板概览 EditorInput |
| **TaskOverviewEditorPane** | `browser/taskOverviewEditorPane.ts` | 看板概览 EditorPane |
| **TaskDetailEditorInput** | `browser/taskDetailEditorInput.ts` | 任务详情 EditorInput |
| **TaskDetailEditorPane** | `browser/taskDetailEditorPane.ts` | 任务详情 EditorPane |
| **CSS** | `webview/src/styles/globals.css` | 编排 UI 样式 |
| **注册** | `browser/agentStudio.contribution.ts` | EditorPane + ViewPane 注册 |

---

## 12. 与 Ruflo 的关系

本功能的核心算法从 [Ruflo v3](G:\CustomWorkspaces\AIProjects\ruflo) 移植并简化：

| Ruflo 原始模块 | 本项目对应 | 简化内容 |
|---------------|-----------|---------|
| `TaskOrchestrator.wouldCreateCycle` | `_wouldCreateCycle` | 完全移植 |
| `Task.resolveExecutionOrder` + `DagBridge.topologicalSort` | `_topologicalSort` | 合并为单函数 |
| `TaskOrchestrator.unblockDependentTasks` | `_unblockDependentTasks` | 完全移植 |
| `Queen.scoreAgent` (5维) | `_scoreAgent` (3维) | 去掉 performance/health |
| `Queen.decomposeTask` (类型策略) | `_decomposeGoal` + templates | 去掉 LLM 调用 |
| `Task.fail()` (重试) | `_failTask` | 完全移植 |
| `Task.isTimedOut()` | `_checkTimeouts` | 完全移植 |
| Kahn 算法 + 关键路径 | Kahn 算法 | 去掉关键路径分析 |

---

## 13. 未来扩展方向

1. **LLM 分解** — 将 `_decomposeGoal` 接入 AI 模型做语义级任务拆分
2. **关键路径高亮** — 在依赖图 UI 中标红瓶颈任务
3. **历史学习** — 记录执行轨迹，优化 Agent 评分权重
4. **5 维评分** — 添加 performanceScore + healthScore
5. **分布式执行** — 跨 Workspace 委派任务
6. **Webhook 通知** — 任务完成/失败时发送外部通知
