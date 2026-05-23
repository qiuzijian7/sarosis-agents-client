# Paperclip 项目任务编排功能深度分析报告

> **分析日期**: 2026-05-23  
> **分析对象**: G:\CustomWorkspaces\AIProjects\paperclip  
> **对比对象**: G:\CustomWorkspaces\AIProjects\sarosis-agents-client (Sarosis)  
> **分析人**: AI Assistant

---

## 目录

1. [项目概览对比](#1-项目概览对比)
2. [任务编排核心概念对比](#2-任务编排核心概念对比)
3. [任务编排流程对比](#3-任务编排流程对比)
4. [关键代码架构对比](#4-关键代码架构对比)
5. [前端实现对比](#5-前端实现对比)
6. [技术栈与基础设施对比](#6-技术栈与基础设施对比)
7. [总结与建议](#7-总结与建议)

---

## 1. 项目概览对比

### 1.1 Paperclip 项目

**项目类型**: 完整的 AI 原生公司控制平面（AI-native company control plane）系统

**架构**: Full-stack Monorepo
```
paperclip/
├── server/          # 后端服务（Node.js + TypeScript, Hono framework）
├── ui/              # 前端界面（React + TypeScript, Vite）
├── packages/        # 共享包（db, shared, adapters）
├── cli/             # 命令行工具
├── skills/          # Agent 技能库
└── docs/            # 文档
```

**核心特点**:
- 多租户 SaaS 平台
- 基于 PostgreSQL + Drizzle ORM
- 实时任务监控（Heartbeat 机制）
- Agent 自动化执行引擎

---

### 1.2 Sarosis (sarosis-agents-client) 项目

**项目类型**: VS Code 扩展（Electron 应用）

**架构**: VS Code Extension + Webview
```
sarosis-agents-client/
├── src/vs/                          # VS Code 核心代码
│   └── sessions/contrib/agentStudio/ # Agent Studio 功能模块
│       ├── browser/                  # 浏览器层（扩展主机）
│       │   ├── taskOrchestrationService.ts
│       │   ├── agentFactory.ts
│       │   └── taskDecomposer.ts
│       └── webview/                 # Webview 层（React 前端）
│           ├── src/
│           │   ├── features/orchestration/
│           │   └── store/useOrchestrationStore.ts
│           └── media/webview.js     # 编译后的前端 bundle
├── extensions/                      # VS Code 扩展
└── doc/                             # 文档
```

**核心特点**:
- VS Code 集成开发环境
- 本地文件系统存储（JSON 文件）
- 实时聊天界面
- 任务计划内联卡片

---

## 2. 任务编排核心概念对比

### 2.1 任务模型

#### Paperclip - Issue 模型

**数据表**: `packages/db/src/schema/issues.ts`

```typescript
// 核心字段
interface Issue {
  id: uuid                          // 主键
  companyId: uuid                    // 多租户隔离
  projectId: uuid                    // 所属项目
  parentId: uuid                     // 父任务（支持层级）
  title: text                        // 任务标题
  description: text                  // 任务描述（Markdown）
  status: text                       // 状态（7种）
  workMode: text                     // 工作模式（standard）
  priority: text                     // 优先级（low/medium/high）
  assigneeAgentId: uuid             // 分配的 Agent
  assigneeUserId: text               // 分配的用户（人类）
  checkoutRunId: uuid               // Checkout 锁（执行权）
  executionRunId: uuid               // 当前执行运行ID
  executionPolicy: jsonb             // 执行策略配置
  executionState: jsonb              // 执行状态
  monitorNextCheckAt: timestamp      // 监控下次检查时间
  originKind: text                   // 任务来源类型
  requestDepth: integer              // 请求深度（委托链）
  startedAt: timestamp              // 开始时间
  completedAt: timestamp            // 完成时间
  cancelledAt: timestamp             // 取消时间
}
```

**状态机（7种状态）**:
```typescript
const ALL_ISSUE_STATUSES = [
  "backlog",      // 待办
  "todo",         // 待处理
  "in_progress",  // 进行中
  "in_review",    // 审查中
  "blocked",      // 被阻塞
  "done",         // 已完成
  "cancelled"     // 已取消
];
```

---

#### Sarosis - OrchestrationPlan 模型

**数据接口**: `src/vs/sessions/contrib/agentStudio/browser/agentStudioService.ts`

```typescript
// 核心接口
interface OrchestrationPlan {
  id: string
  goal: string                      // 目标描述
  workspaceId: string               // 工作区ID
  plannerId: string                 // 创建者（Planner Agent）
  status: 'pending_approval' | 'approved' | 'executing' | 'completed' | 'rejected' | 'error'
  tasks: PlanTask[]                 // 任务列表
  summary: string                   // 计划摘要
  maxConcurrency: number            // 最大并发数
  createdAt: string
  updatedAt: string
}

interface PlanTask {
  id: string
  title: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled'
  assigneeId: string               // 分配的 Agent ID
  assigneeRole: string             // 分配的 Role（worker/tester）
  dependencies: string[]            // 依赖的任务ID
  result?: string                   // 执行结果
  autoCreateAgent: boolean          // 是否自动创建 Agent
}
```

**状态机（Plan 6种状态）**:
```typescript
type OrchestrationPlanStatus = 
  | 'pending_approval'  // 等待审批
  | 'approved'          // 已审批
  | 'executing'        // 执行中
  | 'completed'        // 已完成
  | 'rejected'         // 已拒绝
  | 'error';           // 错误
```

**状态机（Task 6种状态）**:
```typescript
type PlanTaskStatus = 
  | 'pending'     // 待执行
  | 'running'     // 执行中
  | 'completed'   // 已完成
  | 'failed'      // 失败
  | 'blocked'     // 被阻塞
  | 'cancelled';  // 已取消
```

---

### 2.2 对比分析

| 维度 | Paperclip (Issue) | Sarosis (OrchestrationPlan) |
|------|-------------------|-------------------------------|
| **模型粒度** | Issue = 单个任务 | Plan = 任务计划（包含多个 Task） |
| **层级支持** | ✅ 支持 parentId 父子关系 | ✅ 支持 Task 依赖（dependencies） |
| **状态数量** | 7种（更细粒度） | 6种（更简洁） |
| **多租户** | ✅ companyId 隔离 | ❌ 本地项目，无多租户 |
| **优先级** | ✅ priority 字段 | ❌ 无优先级概念 |
| **分配机制** | assigneeAgentId + assigneeUserId | assigneeId + assigneeRole |
| **执行锁** | ✅ checkoutRunId（防止并发） | ❌ 无执行锁 |
| **监控机制** | ✅ monitorNextCheckAt（定时检查） | ❌ 无定时监控 |
| **来源追踪** | ✅ originKind（manual/routine_execution） | ❌ 无来源追踪 |

**结论**:
- **Paperclip** 的 Issue 模型更企业级，支持多租户、优先级、执行锁、监控等企业特性
- **Sarosis** 的 OrchestrationPlan 模型更轻量，专注于任务计划的创建和审批流程

---

## 3. 任务编排流程对比

### 3.1 任务创建流程

#### Paperclip - Issue 创建

**入口**: `server/src/routes/issues.ts` (REST API)

```typescript
// POST /api/issues
createIssue: async (input: IssueCreateInput) => {
  // 1. 验证权限
  // 2. 创建 Issue 记录
  // 3. 处理标签（labelIds）
  // 4. 处理阻塞关系（blockedByIssueIds）
  // 5. 触发事件（issue.created）
}
```

**特点**:
- 通过 REST API 创建
- 支持批量创建子任务（`IssueChildCreateInput`）
- 支持继承执行工作区（`inheritExecutionWorkspaceFromIssueId`）

---

#### Sarosis - Plan 创建

**入口**: `webview/src/features/chat/EmployeeChat.tsx` (聊天命令)

```typescript
// 用户输入: /plan <goal>
handlePlanCommand: async (args: string) => {
  // 1. 解析目标
  const goal = args || '默认目标';
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  const plannerId = activeEmployeeId;
  
  // 2. 调用后端创建 Plan
  const plan = await useOrchestrationStore.getState().createPlan(goal, workspaceId, plannerId);
  
  // 3. 在聊天框中显示计划卡片
  const planMessage: ChatMessage = {
    id: `plan_${plan.id}`,
    role: 'system',
    content: `✅ 任务计划已创建，请在下方面板中审批：`,
    metadata: { type: 'orchestration_plan', planId: plan.id },
  };
}
```

**后端处理**: `browser/taskOrchestrationService.ts`

```typescript
createPlan: async (goal: string, workspaceId: string, plannerId: string) => {
  // 1. 调用 TaskDecomposer 分解目标
  const decomposition = await this.taskDecomposer.decompose(goal, workspaceId);
  
  // 2. 创建 Plan 记录
  const plan: OrchestrationPlan = {
    id: generateUuid(),
    goal,
    workspaceId,
    plannerId,
    status: 'pending_approval',
    tasks: decomposition.tasks,
    summary: decomposition.summary,
  };
  
  // 3. 保存 Plan
  this.plans.set(plan.id, plan);
  
  // 4. 发送事件（通知前端）
  this._onDidChangePlan.fire(plan);
  
  return plan;
}
```

**特点**:
- 通过聊天命令 `/plan` 触发
- 自动调用 AI 分解目标（TaskDecomposer）
- 在聊天框中显示内联审批卡片
- 支持 Human-in-the-Loop 审批

---

### 3.2 任务分配流程

#### Paperclip - Issue 分配

**机制**: 手动分配或自动分配

```typescript
// 更新 Issue 分配
updateIssue: async (id: string, data: Partial<Issue>) => {
  if (data.assigneeAgentId || data.assigneeUserId) {
    // 分配 Agent 或 User
    // 触发事件（issue.assigned）
  }
}
```

**特点**:
- 支持分配给 Agent 或 User
- 无自动分配算法（依赖手动或外部规则）

---

#### Sarosis - Task 分配

**机制**: `AgentFactory.assignAgents()` 自动分配

```typescript
// browser/agentFactory.ts
assignAgents: async (plan: OrchestrationPlan) => {
  for (const task of plan.tasks) {
    // Strategy 1: 按名称查找
    let assigned = await this._findAgentByName(task.assigneeRole);
    if (assigned) continue;
    
    // Strategy 2: 评分选择（跳过 autoCreateAgent=true）
    if (!task.autoCreateAgent) {
      assigned = this._selectBestAgent(allEmps, task.assigneeRole, usedAgentIds);
      if (assigned) continue;
    }
    
    // Strategy 3: 自动创建新 Agent
    if (task.autoCreateAgent) {
      assigned = await this._autoCreateAgent(task.assigneeRole, plan.workspaceId);
    }
  }
}
```

**特点**:
- **3层分配策略**（按名称 → 评分选择 → 自动创建）
- **评分算法**: 基于 role 匹配度 + 负载均衡 + 可用性
- **自动创建**: 当无合适 Agent 时自动创建新 Agent

---

### 3.3 任务执行流程

#### Paperclip - Heartbeat 执行机制

**核心**: `server/src/services/heartbeat.ts`

```typescript
// 定时心跳调度
tickTimers: async (now = new Date()) => {
  const allAgents = await db.select().from(agents);
  
  for (const agent of allAgents) {
    // 1. 检查 Agent 状态（paused/terminated 跳过）
    if (agent.status === "paused" || agent.status === "terminated") continue;
    
    // 2. 解析心跳策略
    const policy = parseHeartbeatPolicy(agent);
    if (!policy.enabled || policy.intervalSec <= 0) continue;
    
    // 3. 检查是否到达心跳间隔
    const elapsedMs = now.getTime() - baseline;
    if (elapsedMs < policy.intervalSec * 1000) continue;
    
    // 4. 入列唤醒请求
    const run = await enqueueWakeup(agent.id, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });
  }
  
  // 5. 检查到期的 Issue 监控
  const issueMonitors = await tickDueIssueMonitors(now);
}
```

**Issue 监控触发**:
```typescript
async function tickDueIssueMonitors(now = new Date()) {
  // 1. 查询需要监控的 issues
  const dueMonitors = await db
    .select(issueMonitorDispatchColumns)
    .from(issues)
    .where(and(
      sql`${issues.monitorNextCheckAt} is not null`,
      lte(issues.monitorNextCheckAt, now),  // 监控时间已到期
      isNull(issues.assigneeUserId),
      sql`${issues.assigneeAgentId} is not null`,
      inArray(issues.status, ["in_progress", "in_review"]),
    ))
    .limit(50);
  
  // 2. Claim 这个 monitor（防止重复处理）
  for (const due of dueMonitors) {
    const claimed = await db.transaction(async (tx) => {
      // 更新 monitorWakeRequestedAt 抢占锁
    });
    
    // 3. 分发 claimed issue monitor
    const result = await dispatchClaimedIssueMonitor(claimed, {
      wakeReason: "issue_monitor_due",
      actorType: "system",
      actorId: "heartbeat_scheduler",
    });
  }
}
```

**特点**:
- **定时调度**: 基于 Heartbeat 间隔（秒级）
- **监控机制**: Issue 自己管理 `monitorNextCheckAt`
- **抢占锁**: 防止重复处理（monitorWakeRequestedAt）
- **分布式**: 支持多实例部署

---

#### Sarosis - 直接执行机制

**核心**: `browser/taskOrchestrationService.ts`

```typescript
// 审批通过后执行
approvePlan: async (planId: string) => {
  // 1. 更新 Plan 状态
  plan.status = 'approved';
  this._onDidChangePlan.fire(plan);
  
  // 2. 分配 Agents
  await this.agentFactory.assignAgents(plan);
  
  // 3. 更新状态为 executing
  plan.status = 'executing';
  this._onDidChangePlan.fire(plan);
  
  // 4. 执行任务（串行或并行）
  await this._executeTasks(plan);
}

// 执行单个任务
_executeTask: async (plan: OrchestrationPlan, task: PlanTask) => {
  // 1. 检查依赖
  const deps = task.dependencies || [];
  const blocked = deps.some(depId => {
    const dep = plan.tasks.find(t => t.id === depId);
    return dep && dep.status !== 'completed';
  });
  
  if (blocked) {
    task.status = 'blocked';
    return;
  }
  
  // 2. 执行任务（调用 Agent）
  task.status = 'running';
  const result = await this._callAgent(task.assigneeId, task);
  
  // 3. 更新状态
  task.status = result.success ? 'completed' : 'failed';
  task.result = result.output;
}
```

**特点**:
- **即时执行**: 审批通过后立即执行
- **无定时调度**: 不支持定时任务
- **无监控机制**: 不主动检查任务状态
- **本地执行**: Agent 在本地进程执行

---

### 3.4 任务审批流程

#### Paperclip - 无内置审批

Paperclip 的 Issue 模型**无内置审批流程**，任务创建后直接进入 `backlog` 或 `todo` 状态。

**替代方案**:
- 通过 `in_review` 状态模拟审批
- 通过 `blocked` 状态暂停任务
- 依赖外部系统（如 GitHub PR）进行审批

---

#### Sarosis - Human-in-the-Loop 审批

**核心**: `webview/src/features/orchestration/OrchestrationPlanInline.tsx`

```typescript
// 用户点击"批准"按钮
handleApprove: async () => {
  await approvePlan(planId);
  // 后端执行 plan
}

// 用户点击"拒绝"按钮
handleReject: async () => {
  await rejectPlan(planId);
  // 计划被拒绝
}
```

**审批 UI**:
```tsx
<div className="orch-plan-inline-actions">
  <button onClick={handleApprove}>✅ 批准执行</button>
  <button onClick={handleReject}>❌ 拒绝</button>
</div>
```

**特点**:
- **内联审批**: 在聊天框中直接审批
- **实时反馈**: 审批结果立即通知后端
- **支持修改**: 可在审批前修改任务分配

---

## 4. 关键代码架构对比

### 4.1 后端服务层

#### Paperclip

**文件结构**:
```
server/src/services/
├── issues.ts                    # Issue 核心服务（206 KB）
├── heartbeat.ts                 # Heartbeat 调度（358 KB）
├── issue-execution-policy.ts   # 执行策略（37 KB）
├── issue-tree-control.ts        # 任务树控制（42 KB）
├── issue-thread-interactions.ts # 线程交互（45 KB）
└── recovery/service.ts          # 恢复服务
```

**特点**:
- **巨型文件**: 单个文件超过 200 KB（issues.ts, heartbeat.ts）
- **紧耦合**: Service 直接访问数据库
- **无接口抽象**: 无 `I*Service` 接口定义

---

#### Sarosis

**文件结构**:
```
src/vs/sessions/contrib/agentStudio/browser/
├── agentStudioService.ts         # 服务接口定义（I*Service）
├── taskOrchestrationService.ts  # 任务编排服务（实现）
├── agentFactory.ts              # Agent 工厂（分配+创建）
├── taskDecomposer.ts           # 任务分解器（AI 调用）
└── agentStudioWebviewController.ts # Webview 控制器
```

**特点**:
- **接口驱动**: `agentStudioService.ts` 定义 `ITaskOrchestrationService`
- **依赖注入**: 通过构造函数注入依赖
- **文件适中**: 单个文件通常 < 50 KB

---

### 4.2 前端存储层

#### Paperclip

**无前端存储**: 所有数据从后端 API 获取

```typescript
// ui/src/api/issues.ts
fetchIssues: async (params: ListIssuesParams) => {
  const res = await fetch(`/api/issues?${qs.stringify(params)}`);
  return res.json();
}
```

---

#### Sarosis

**Zustand 存储**: 前端状态管理

```typescript
// webview/src/store/useOrchestrationStore.ts
export const useOrchestrationStore = create<OrchestrationState>((set, get) => ({
  plans: [],
  activePlan: null,
  
  createPlan: async (goal, workspaceId, plannerId) => {
    const plan = await sendRequest('orchestration.plan', { goal, workspaceId, plannerId });
    set(state => ({ plans: [...state.plans, plan] }));
    return plan;
  },
}));
```

**特点**:
- **乐观更新**: 前端先更新状态，再同步后端
- **离线支持**: 无网络时仍可操作（本地状态）
- **复杂同步**: 需要处理前后端状态同步

---

## 5. 前端实现对比

### 5.1 任务看板（Kanban Board）

#### Paperclip - KanbanBoard.tsx

**文件**: `ui/src/components/KanbanBoard.tsx`

**核心功能**:
```typescript
export function KanbanBoard({ issues, agents, onUpdateIssue }: KanbanBoardProps) {
  // 1. 拖拽排序（@dnd-kit）
  const sensors = useSensors(useSensor(PointerSensor));
  const handleDragEnd = (event: DragEndEvent) => {
    const issueId = active.id as string;
    const targetStatus = resolveKanbanTargetStatus(over.id as string, issues);
    onUpdateIssue(issueId, { status: targetStatus });
  };
  
  // 2. 列折叠/展开
  const [collapsedStatuses, setCollapsedStatuses] = useState<string[]>([]);
  
  // 3. 分页加载
  const [displayCounts, setDisplayCounts] = useState<Record<string, number>>({});
  
  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      {boardStatuses.map(status => (
        <KanbanColumn key={status} status={status} issues={issuesByStatus[status]} />
      ))}
    </DndContext>
  );
}
```

**UI 特点**:
- ✅ 拖拽排序（@dnd-kit）
- ✅ 列折叠/展开
- ✅ 分页加载（Show more）
- ✅ 实时状态指示（isLive 蓝色脉冲）
- ✅ 任务卡片（KanbanCard）

---

#### Sarosis - TaskOverviewEditorPane.tsx

**文件**: `src/vs/sessions/contrib/agentStudio/browser/taskOverviewEditorPane.tsx`

**核心功能**:
```typescript
export class TaskOverviewEditorPane extends EditorPane {
  // 1. 显示任务列表（表格形式）
  // 2. 点击任务打开详情
  // 3. 支持审批操作
  
  renderBody(): void {
    // 渲染任务表格
  }
}
```

**UI 特点**:
- ✅ 表格视图（非看板）
- ✅ 任务详情面板
- ✅ 审批操作按钮
- ❌ 无拖拽排序
- ❌ 无实时状态指示

---

### 5.2 任务计划卡片（Inline Card）

#### Paperclip - 无内联卡片

Paperclip **无任务计划内联卡片**功能，任务创建后直接进入看板。

---

#### Sarosis - OrchestrationPlanInline.tsx

**文件**: `webview/src/features/orchestration/OrchestrationPlanInline.tsx`

**核心功能**:
```tsx
export function OrchestrationPlanInline({ planId, onClose }: OrchestrationPlanInlineProps) {
  const plan = useOrchestrationStore(state => state.plans.find(p => p.id === planId));
  
  return (
    <div className="orch-plan-inline">
      <div className="orch-plan-inline-header">
        <span className="orch-plan-inline-goal">{plan.goal}</span>
        <button onClick={onClose}>✕</button>
      </div>
      
      <div className="orch-plan-inline-tasks">
        {plan.tasks.map(task => (
          <div key={task.id} className="orch-task-item">
            <span className="orch-task-title">{task.title}</span>
            <span className="orch-task-status">{task.status}</span>
          </div>
        ))}
      </div>
      
      <div className="orch-plan-inline-actions">
        <button onClick={handleApprove}>✅ 批准执行</button>
        <button onClick={handleReject}>❌ 拒绝</button>
      </div>
    </div>
  );
}
```

**UI 特点**:
- ✅ 内联显示（在聊天框中）
- ✅ 实时更新（Zustand 订阅）
- ✅ 审批操作（批准/拒绝）
- ✅ 可关闭（onClose）

---

## 6. 技术栈与基础设施对比

### 6.1 技术栈

| 维度 | Paperclip | Sarosis |
|------|-----------|---------|
| **前端框架** | React + Vite | React + Vite |
| **前端状态** | React Query | Zustand |
| **后端框架** | Hono (Node.js) | VS Code Extension Host |
| **数据库** | PostgreSQL + Drizzle ORM | 文件系统（JSON） |
| **实时通信** | HTTP Polling | postMessage (iframe) |
| **拖拽库** | @dnd-kit | 无 |
| **Markdown** | 无 | react-markdown + remark-gfm |
| **图表** | 无 | Mermaid（任务依赖图） |

---

### 6.2 基础设施

| 维度 | Paperclip | Sarosis |
|------|-----------|---------|
| **部署方式** | Docker + Kubernetes | VS Code 扩展 |
| **多租户** | ✅ companyId 隔离 | ❌ 本地项目 |
| **认证** | Session + JWT | VS Code Authentication |
| **日志** | Winston | VS Code Output Channel |
| **监控** | Heartbeat + Issue Monitor | 无 |
| **错误恢复** | Recovery Service | 无 |
| **定时任务** | Heartbeat Scheduler | 无 |
| **分布式** | ✅ 支持多实例 | ❌ 单实例 |

---

## 7. 总结与建议

### 7.1 核心差异总结

| 维度 | Paperclip | Sarosis |
|------|-----------|---------|
| **定位** | 企业级 SaaS 平台 | VS Code 开发工具扩展 |
| **任务模型** | Issue（单任务） | Plan + Task（计划+任务） |
| **执行机制** | Heartbeat 定时调度 | 即时执行 |
| **审批流程** | 无内置审批 | Human-in-the-Loop 审批 |
| **分配策略** | 手动分配 | 自动分配（3层策略） |
| **监控机制** | Issue Monitor 定时检查 | 无监控 |
| **前端交互** | Kanban 看板（拖拽） | 聊天框内联卡片 |
| **技术复杂度** | 高（分布式系统） | 中（单实例应用） |

---

### 7.2 各自优缺点

#### Paperclip 优点

1. **企业级架构**: 多租户、分布式、高可用
2. **完善的监控**: Heartbeat + Issue Monitor 确保任务不丢失
3. **灵活的状态机**: 7种状态覆盖完整生命周期
4. **强大的恢复机制**: Recovery Service 处理各种异常
5. **可扩展性**: 支持水平扩展（多实例部署）

#### Paperclip 缺点

1. **复杂度高**: 学习曲线陡峭，维护成本高
2. **无审批流程**: 不支持 Human-in-the-Loop
3. **UI 较重**: Kanban 看板功能复杂，不够轻量
4. **无 AI 集成**: 任务分解依赖外部系统

---

#### Sarosis 优点

1. **轻量易用**: VS Code 集成，开箱即用
2. **AI 驱动**: 自动任务分解（TaskDecomposer）
3. **审批流程**: Human-in-the-Loop 确保质量控制
4. **内联交互**: 聊天框中直接审批，体验流畅
5. **自动分配**: 3层分配策略，智能匹配 Agent

#### Sarosis 缺点

1. **功能受限**: 无定时调度、无监控、无恢复机制
2. **单实例**: 不支持分布式部署
3. **数据持久化**: 文件系统存储，不适合大规模数据
4. **无优先级**: 任务无优先级概念，无法排序

---

### 7.3 改进建议

#### 对 Sarosis 的建议

1. **增加定时调度**: 参考 Paperclip 的 Heartbeat 机制，支持定时任务执行
2. **增加监控机制**: 参考 Issue Monitor，主动检查任务状态
3. **增加优先级**: 为 Task 增加 priority 字段，支持优先级排序
4. **增加恢复机制**: 参考 Recovery Service，处理 Agent 崩溃等异常
5. **改进前端**: 参考 KanbanBoard，增加拖拽排序功能
6. **数据持久化**: 考虑使用 IndexedDB 或 SQLite 替代文件系统

#### 对 Paperclip 的建议

1. **增加审批流程**: 参考 Sarosis 的 Human-in-the-Loop，增加任务审批功能
2. **AI 集成**: 参考 TaskDecomposer，增加自动任务分解功能
3. **简化 UI**: 参考 OrchestrationPlanInline，提供轻量级内联审批界面
4. **自动分配**: 参考 AgentFactory，增加智能 Agent 分配算法

---

## 8. 附录：关键代码引用

### 8.1 Paperclip 关键代码

- **Issue 模型**: `packages/db/src/schema/issues.ts`
- **Issue 服务**: `server/src/services/issues.ts`
- **Heartbeat 服务**: `server/src/services/heartbeat.ts`
- **Kanban 看板**: `ui/src/components/KanbanBoard.tsx`

### 8.2 Sarosis 关键代码

- **OrchestrationPlan 接口**: `src/vs/sessions/contrib/agentStudio/browser/agentStudioService.ts`
- **任务编排服务**: `src/vs/sessions/contrib/agentStudio/browser/taskOrchestrationService.ts`
- **Agent 工厂**: `src/vs/sessions/contrib/agentStudio/browser/agentFactory.ts`
- **任务分解器**: `src/vs/sessions/contrib/agentStudio/browser/taskDecomposer.ts`
- **计划内联卡片**: `webview/src/features/orchestration/OrchestrationPlanInline.tsx`
- **前端存储**: `webview/src/store/useOrchestrationStore.ts`

---

**报告结束**

> **生成时间**: 2026-05-23  
> **作者**: AI Assistant  
> **审核**: 待审核
