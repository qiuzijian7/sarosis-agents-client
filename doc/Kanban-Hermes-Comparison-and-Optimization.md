# Kanban 看板系统对比与优化建议

> 基于 Hermes-Agent (`G:\CustomWorkspaces\AIProjects\Hermes-Agent`) 与本项目 (`saros-agents-client`) 看板架构的深度对比分析

## 一、架构总览对比

| 维度 | Hermes-Agent | Saros (本项目) | 差距评级 |
|------|-------------|-----------------|---------|
| 状态模型 | 7 状态 (triage→todo→ready→running→blocked→done→archived) | 5 状态 (todo→running→done→cancelled→archived) | **大** |
| 数据持久化 | SQLite (`kanban.db`) | JSON 文件 (`taskboard.json`) | **中** |
| LLM 驱动分解 | `kanban_decompose.py` + `kanban_specify.py` | 无 | **大** |
| 诊断/告警 | 8 条诊断规则 (`kanban_diagnostics.py`) | 无 | **大** |
| Agent 工具 | 9 个 `kanban_*` 工具 + handler | 9 个 schema 定义，无 handler | **大** |
| Swarm 协作 | `kanban_swarm.py`（并行拓扑 + blackboard） | 无 | **大** |
| 多 Board 隔离 | Board / Tenant 两级隔离 | workspaceId 过滤（单文件存储） | **中** |
| Provider 抽象 | DB 层直接访问（进程内） | `IKanbanProvider` 已定义未接入 | **中** |
| 实时更新 | Dispatcher 轮询驱动 | WebView messageProtocol 推送 | **小** |
| UI 交互 | CLI + Dashboard（Web） | WebView 5 列拖拽 | **小** |
| 文件附件 | 支持 | 无 | **小** |

---

## 二、核心差距分析

### 2.1 状态模型：5 → 7 状态

**Hermes 的三状态增量**：

| 状态 | 语义 | 转换规则 | 本项目缺失影响 |
|------|------|---------|--------------|
| `triage` | 粗糙需求待分解/细化 | 只能→todo（经 specify）或→todo×N（经 decompose） | 所有任务创建即 todo，无法区分"待规划"与"待执行" |
| `ready` | 已细化、可被 Agent 认领 | todo→ready（所有依赖满足） | 无法区分"等依赖"和"可开始"的 todo 任务 |
| `blocked` | 执行中被外部依赖阻塞 | running→blocked→running | 依赖阻塞只能用 cancelled 代替，丢失"暂时阻塞"语义 |

**推荐方案**：扩展 `TaskBoardStatus` 枚举：

```typescript
// src/vs/sessions/common/agentStudioTypes.ts
export enum TaskBoardStatus {
  triage = 'triage',     // 新增：待分解/细化
  todo = 'todo',
  ready = 'ready',       // 新增：可认领
  running = 'running',
  blocked = 'blocked',   // 新增：阻塞中
  done = 'done',
  cancelled = 'cancelled',
  archived = 'archived',
}
```

**UI 适配**：TaskBoardPanel 从 5 列扩展为 7 列（或合并 triage+todo 为折叠组，ready 独立列，blocked 作为 running 的子状态标记）。

### 2.2 LLM 驱动的 Triage 自动分解

**Hermes 实现**：

- `kanban_decompose.py`：调用 auxiliary LLM，将 triage 任务分解为 2-6 个子任务图
  - `fanout=true`：多子任务并行 → 自动创建 ready 状态
  - `fanout=false`：单任务细化 → 创建 todo 状态
  - 自动路由 assignee：无效 assignee 重写为 `default_assignee`
  - `DecomposeOutcome` 跟踪分解结果
- `kanban_specify.py`：将 rough idea 转为结构化 spec（Goal / Approach / Acceptance criteria / Out of scope）
  - 自动从 triage → todo 状态提升

**本项目缺失**：所有任务创建即 todo，无自动分解能力。用户需要手动拆分大任务。

**推荐实现路径**：

```
1. 定义 ITriageService 接口
   └─ specify(taskId: string): Promise<TaskBoardRecord>     // 细化
   └─ decompose(taskId: string): Promise<TaskBoardRecord[]> // 分解

2. 实现 LlmTriageService
   └─ 调用当前 chat backend（Knot/OpenClaw/Direct）做 LLM 推理
   └─ 解析 LLM 输出为结构化子任务列表
   └─ 创建子任务 + 设置父子依赖 link

3. 集成到 AgentTaskBoardService
   └─ 新增 triage 自动触发入口（手动按钮 + 自动检测大任务）
   └─ WebView 增加 "分解" / "细化" 按钮在 triage 卡片上
```

### 2.3 诊断/告警系统

**Hermes 的 8 条诊断规则**：

| 规则 | 严重级别 | 检测逻辑 | 价值 |
|------|---------|---------|------|
| `hallucinated_cards` | error | Agent 引用不存在的卡片 ID | 防止 Agent 幻觉导致执行错误 |
| `triage_not_actionable` | warning | triage 任务超过 24h 未细化 | 防止需求积压 |
| `repeated_failures` | critical | 连续失败次数 ≥ 2 | 自动降级/重试 |
| `repeated_crashes` | critical | 连续崩溃次数 ≥ 2 | Agent 自愈 |
| `stuck_in_blocked` | warning | blocked 超过 24h | 防止永久阻塞 |
| `block_unblock_cycling` | warning | 30min 内 block/unblock ≥ 3 次 | 检测依赖死锁 |
| `stranded_in_ready` | warning | ready 超过 30min 无人认领 | 资源调度优化 |
| `prose_phantom_refs` | warning | 文本中引用不存在的卡片 | 文档一致性 |

**诊断输出结构**：

```python
@dataclass
class Diagnostic:
    kind: str              # 规则标识
    severity: str          # warning/error/critical
    title: str
    detail: str
    actions: list[DiagnosticAction]  # reclaim/reassign/unblock/cli_hint/open_docs/comment
    first_seen_at: datetime
    last_seen_at: datetime
    count: int             # 累计出现次数
    data: dict             # 附加上下文
```

**推荐实现路径**：

```
1. 定义 IKanbanDiagnosticsService
   └─ runDiagnostics(boardId: string): Promise<Diagnostic[]>
   └─ onDidDetectDiagnostic: Event<Diagnostic>

2. 实现 KanbanDiagnosticsService
   └─ 8 条规则移植（优先级：repeated_failures > stuck_in_blocked > stranded_in_ready）
   └─ 定时检测（30min 间隔）+ 事件触发检测（状态变更时）

3. WebView 集成
   └─ TaskBoard 顶部增加 "诊断" 按钮 + 警告徽章
   └─ 诊断结果以 toast/snackbar 展示
   └─ 每条诊断提供快捷操作按钮（reassign/unblock 等）
```

### 2.4 Agent 工具 Handler 落地

**现状**：`bundledTools.ts` 已定义 9 个 kanban 工具 schema，但无 `IBundledToolProvider` handler 实现。

| 工具名 | 功能 | Hermes 对应 |
|--------|------|-----------|
| `kanban_show` | 查看任务详情 | `kanban_show` |
| `kanban_list` | 列出任务 | `kanban_list` |
| `kanban_create` | 创建任务 | `kanban_create` |
| `kanban_complete` | 完成任务 | `kanban_complete` |
| `kanban_block` | 阻塞任务 | `kanban_block` |
| `kanban_unblock` | 解除阻塞 | `kanban_unblock` |
| `kanban_heartbeat` | 更新心跳 | `kanban_heartbeat` |
| `kanban_comment` | 添加评论 | `kanban_comment` |
| `kanban_link` | 链接任务 | `kanban_link` |

**推荐实现**：

在 `src/vs/sessions/contrib/agentStudio/browser/bundled-tool-handlers/` 下创建 `kanbanToolHandler.ts`：

```typescript
export class KanbanToolHandler implements IBundledToolHandler {
  constructor(@IAgentTaskBoardService private taskBoardService: IAgentTaskBoardService) {}

  async handle(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    switch (toolName) {
      case 'kanban_show': return this.show(args.taskId);
      case 'kanban_list': return this.list(args.boardId, args.status);
      case 'kanban_create': return this.create(args);
      case 'kanban_complete': return this.complete(args.taskId);
      case 'kanban_block': return this.block(args.taskId, args.reason);
      case 'kanban_unblock': return this.unblock(args.taskId);
      case 'kanban_heartbeat': return this.heartbeat(args.taskId);
      case 'kanban_comment': return this.comment(args.taskId, args.body);
      case 'kanban_link': return this.link(args.parentId, args.childId);
    }
  }
}
```

**优先级**：先实现 `kanban_create` / `kanban_complete` / `kanban_block` / `kanban_unblock` 四个核心工具，其余后续补齐。

### 2.5 IKanbanProvider 抽象层激活

**现状**：`IKanbanProvider` 接口已定义（`providers.ts`），但 `AgentTaskBoardService` 直接操作 JSON 文件，绕过了该抽象。

**Hermes 参考**：Hermes 的 `kanban_db.py` 是纯数据层，上层服务通过 DB 层函数间接访问，而非绕过。

**推荐重构**：

```
1. AgentTaskBoardService 改为依赖 IKanbanProvider
   └─ 所有数据操作委托给 IKanbanProvider
   └─ 不再直接读写 taskboard.json

2. 实现 JsonFileKanbanProvider
   └─ 保持当前 JSON 文件读写逻辑
   └─ 迁移到 provider 层

3. 未来可扩展 SqliteKanbanProvider
   └─ SQLite 持久化（见 2.6）
   └─ 通过 DI 注册切换实现
```

### 2.6 数据持久化升级（JSON → SQLite）

**Hermes 优势**：SQLite 提供事务保证、并发安全、索引查询、大容量支持。

**本项目局限**：JSON 文件在任务量 > 100 时性能下降，无事务保证，并发写入可能丢数据。

**推荐策略（渐进式）**：

| 阶段 | 持久化方式 | 说明 |
|------|-----------|------|
| Phase 1 | JSON + IKanbanProvider 抽象 | 先完成 provider 层解耦 |
| Phase 2 | SQLite via `sql.js`（WASM） | 浏览器端内嵌 SQLite，零外部依赖 |
| Phase 3 | SQLite via Node.js `better-sqlite3` | 如果需要主进程端访问 |

**关键考虑**：本项目看板在 WebView 端运行，SQLite 需要在浏览器环境可用。`sql.js`（SQLite 编译为 WASM）是最简路径。

### 2.7 Swarm 协作模式

**Hermes Swarm 架构**：

```
Root Task (done immediately)
├── Worker 1 (ready) ───┐
├── Worker 2 (ready) ───┤──→ Verifier (todo, parents=workers) ──→ Synthesizer (todo, parent=verifier)
└── Worker 3 (ready) ───┘
```

- 共享 blackboard 通过结构化 JSON comment（`[swarm:blackboard]` 前缀）
- `post_blackboard_update()` / `latest_blackboard()` 实现追加式状态共享
- `SwarmWorkerSpec`：profile, title, body, skills, priority, max_runtime_seconds

**推荐实现**：

```
1. 定义 ISwarmService 接口
   └─ createSwarm(spec: SwarmSpec): Promise<SwarmResult>
   └─ getBlackboard(swarmId: string): Promise<BlackboardEntry[]>
   └─ postBlackboardUpdate(swarmId: string, entry: BlackboardEntry): Promise<void>

2. 实现 SwarmService（基于现有 SubAgent 系统）
   └─ 复用 unifiedSubAgentDispatch 做 Worker 调度
   └─ Worker 间通过 kanban comment 传递 blackboard
   └─ Verifier/Synthesizer 作为特殊 Worker

3. WebView 集成
   └─ TaskBoard 增加 "Swarm 视图" 模式
   └─ 显示拓扑关系 + blackboard 实时流
```

### 2.8 多 Board 隔离

**Hermes**：Board（项目级隔离）+ Tenant（租户级隔离），每 Board 独立 DB 表空间。

**本项目**：单文件 `taskboard.json`，所有 workspace 共享，通过 `workspaceId` 字段过滤。

**推荐增强**：

```typescript
// 扩展 IKanbanProvider
export interface IKanbanProvider {
  // 现有方法...
  listBoards(): Promise<Board[]>;
  createBoard(name: string, workspaceId: string): Promise<Board>;
  deleteBoard(boardId: string): Promise<void>;
  switchBoard(boardId: string): Promise<void>;
  onDidChangeActiveBoard: Event<Board>;
}
```

UI 侧：TaskBoard 顶部增加 Board 选择器（下拉菜单），支持创建/切换/删除 Board。

### 2.9 实时增量更新

**Hermes**：Dispatcher 轮询看板状态，无实时推送。

**本项目**：WebView messageProtocol 已支持增量推送（`onDidChangeCards`），这是本项目的一个优势。

**建议保持现有机制**，但增加：

1. **卡片级 delta 推送**：当前可能是全量刷新，改为只推送变更的卡片
2. **心跳机制**：参考 Hermes `kanban_heartbeat`，Agent 定期更新 `lastActiveAt`，UI 展示 "活跃中" 指示器
3. **冲突解决**：多 WebView 实例同时操作同一 Board 时的乐观锁机制

---

## 三、实施优先级与路线图

### P0 — 核心功能补全（1-2 周）

| 任务 | 涉及文件 | 依赖 |
|------|---------|------|
| 扩展 TaskBoardStatus 7 状态 | `agentStudioTypes.ts` + `TaskBoardPanel.tsx` + `TaskCard.tsx` | 无 |
| 实现 kanban 工具 handler（4 个核心） | 新建 `kanbanToolHandler.ts` | TaskBoardStatus 扩展 |
| 激活 IKanbanProvider 抽象 | `agentTaskBoardService.ts` → 委托到 provider | 无 |

### P1 — 智能化增强（2-3 周）

| 任务 | 涉及文件 | 依赖 |
|------|---------|------|
| 实现 ITriageService + LlmTriageService | 新建 `triageService.ts` | IKanbanProvider 激活 |
| 实现 IKanbanDiagnosticsService（4 条核心规则） | 新建 `kanbanDiagnosticsService.ts` | TaskBoardStatus 扩展 |
| 补齐 kanban 工具 handler（剩余 5 个） | `kanbanToolHandler.ts` | P0 handler |

### P2 — 高级能力（3-4 周）

| 任务 | 涉及文件 | 依赖 |
|------|---------|------|
| Swarm 协作模式 | 新建 `swarmService.ts` | TriageService + SubAgent |
| 多 Board 隔离 | IKanbanProvider 扩展 + WebView | IKanbanProvider 激活 |
| SQLite 持久化 | 新建 `sqliteKanbanProvider.ts` | IKanbanProvider 激活 |
| 文件附件支持 | TaskBoardRecord 扩展 + WebView | 无 |

---

## 四、关键接口设计

### 4.1 IKanbanDiagnosticsService

```typescript
export interface IKanbanDiagnosticsService {
  readonly _serviceBrand: undefined;

  runDiagnostics(boardId: string): Promise<Diagnostic[]>;
  onDidDetectDiagnostic: Event<Diagnostic>;
  dismissDiagnostic(diagnosticId: string): void;
}

export interface Diagnostic {
  readonly id: string;
  readonly kind: DiagnosticRule;
  readonly severity: 'warning' | 'error' | 'critical';
  readonly title: string;
  readonly detail: string;
  readonly actions: DiagnosticAction[];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly count: number;
  readonly data: Record<string, unknown>;
}

export enum DiagnosticRule {
  HallucinatedCards = 'hallucinated_cards',
  TriageNotActionable = 'triage_not_actionable',
  RepeatedFailures = 'repeated_failures',
  RepeatedCrashes = 'repeated_crashes',
  StuckInBlocked = 'stuck_in_blocked',
  BlockUnblockCycling = 'block_unblock_cycling',
  StrandedInReady = 'stranded_in_ready',
  ProsePhantomRefs = 'prose_phantom_refs',
}

export type DiagnosticAction =
  | { type: 'reassign'; targetAssignee: string }
  | { type: 'unblock'; taskId: string }
  | { type: 'reclaim'; taskId: string }
  | { type: 'dismiss' }
  | { type: 'open_docs'; url: string };
```

### 4.2 ITriageService

```typescript
export interface ITriageService {
  readonly _serviceBrand: undefined;

  specify(taskId: string): Promise<TaskBoardRecord>;
  decompose(taskId: string, options?: DecomposeOptions): Promise<TaskBoardRecord[]>;
}

export interface DecomposeOptions {
  fanout?: boolean;        // true=并行子任务, false=单任务细化
  maxSubTasks?: number;    // 默认 6
  assignee?: string;
}

export interface SpecifyResult {
  goal: string;
  approach: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
}
```

### 4.3 ISwarmService

```typescript
export interface ISwarmService {
  readonly _serviceBrand: undefined;

  createSwarm(spec: SwarmSpec): Promise<string>;
  getSwarmStatus(swarmId: string): Promise<SwarmStatus>;
  getBlackboard(swarmId: string): Promise<BlackboardEntry[]>;
  postBlackboardUpdate(swarmId: string, workerId: string, update: string): Promise<void>;
}

export interface SwarmSpec {
  readonly parentTaskId: string;
  readonly workers: SwarmWorkerSpec[];
  readonly verifierProfile?: string;
  readonly synthesizerProfile?: string;
}

export interface SwarmWorkerSpec {
  readonly profile: string;      // Agent persona
  readonly title: string;
  readonly body: string;
  readonly skills?: string[];
  readonly priority: 'low' | 'medium' | 'high';
  readonly maxRuntimeSeconds?: number;
}

export interface BlackboardEntry {
  readonly workerId: string;
  readonly timestamp: number;
  readonly content: string;
  readonly type: 'progress' | 'result' | 'blocked' | 'insight';
}
```

---

## 五、Hermes 设计中的可借鉴模式

### 5.1 结构化 Comment 通信

Hermes 的 `[swarm:blackboard]` 前缀模式很有启发性。在现有 `TaskBoardRecord` 基础上，可以扩展 comment 系统：

```typescript
export interface TaskBoardComment {
  readonly id: string;
  readonly taskId: string;
  readonly authorId: string;
  readonly body: string;
  readonly structured?: {
    type: 'swarm:blackboard' | 'triage:spec' | 'diagnostic:note';
    payload: Record<string, unknown>;
  };
  readonly createdAt: number;
}
```

### 5.2 依赖感知的状态转换

Hermes 的 `ready` 状态自动由依赖满足触发，而非手动设置。建议实现：

```typescript
// 在 IKanbanProvider 或 AgentTaskBoardService 中
async transitionToReadyIfDepsMet(taskId: string): Promise<boolean> {
  const task = await this.getTask(taskId);
  if (task.status !== 'todo') return false;

  const deps = await this.getDependencies(taskId);
  const allDepsDone = deps.every(d => d.status === 'done');

  if (allDepsDone) {
    await this.moveCard(taskId, 'ready');
    return true;
  }
  return false;
}
```

### 5.3 心跳与超时检测

```typescript
// kanban_heartbeat 工具实现
async heartbeat(taskId: string): Promise<void> {
  await this.provider.updateCard(taskId, {
    lastActiveAt: Date.now(),
    // 如果是 blocked 状态，重置阻塞计时器
  });
}
```

UI 侧：卡片上显示 "活跃" 指示器（绿点），超时无心跳则变灰 + 触发诊断。

---

## 六、风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 7 状态模型增加 UI 复杂度 | 7 列看板在小屏幕拥挤 | 折叠 triage/todo，blocked 作为 running 子状态 |
| LLM 分解可能产生幻觉子任务 | 无效任务浪费资源 | 分解结果需用户确认后才创建 |
| SQLite 引入 WASM 体积 | sql.js ~1MB | 懒加载，仅在看板面板打开时加载 |
| 诊断规则误报 | 用户噪音 | 前期仅实现 warning 级，不支持 critical 自动操作 |
| Swarm 多 Agent 资源竞争 | API 限流 | 复用 IQuotaGuard 做跨 workspace 限流 |

---

## 七、总结

本项目看板系统与 Hermes 相比，核心差距集中在 **智能化（LLM 分解/诊断）** 和 **协作化（Swarm/多 Board）** 两个维度。但本项目在 **UI 交互（WebView 拖拽）** 和 **实时推送（messageProtocol）** 上有自身优势。

建议按照 P0→P1→P2 的渐进路线推进，每个阶段都有可独立交付的价值：

- **P0 交付**：7 状态模型 + Agent 可操作看板 + Provider 解耦 → 看板从"展示板"升级为"可编程任务板"
- **P1 交付**：LLM 自动分解 + 诊断告警 → 看板从"被动记录"升级为"主动管理"
- **P2 交付**：Swarm 协作 + 多 Board + SQLite → 看板从"单任务流"升级为"多团队协作平台"
