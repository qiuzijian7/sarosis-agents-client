# Sarosis Agents Client — 四层架构完整框架

> **版本**: v1.1  
> **日期**: 2026-05-11  
> **状态**: 设计定稿 + 部分实现（核心服务层已落地）  
> **基于**: OpenClaw-VSCode-Architecture-v2.md (v1.7, 28章)

---

## 目录

- [一、架构总览](#一架构总览)
- [二、Layer 1 — UI 层 (Presentation)](#二layer-1--ui-层-presentation)
- [三、Layer 2 — Driver 层 (Orchestration)](#三layer-2--driver-层-orchestration)
- [四、Layer 3 — OS 层 (Capability Abstraction)](#四layer-3--os-层-capability-abstraction)
- [五、Layer 4 — Provider 层 (Plugin Implementation)](#五layer-4--provider-层-plugin-implementation)
- [六、横切关注点](#六横切关注点)
- [七、完整目录结构](#七完整目录结构)
- [八、数据流与交互时序](#八数据流与交互时序)
- [九、服务依赖矩阵](#九服务依赖矩阵)
- [十、Phase 实施路线图](#十phase-实施路线图)

---

## 一、架构总览

### 1.1 四层模型

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Layer 1: UI 层 (Presentation)                     │
│   WebView (React + Zustand + ReactFlow + TailwindCSS)                   │
│   ChatBar · Canvas · TaskBoard · Gallery · ModelSelector                │
├─────────────────────────────────────────────────────────────────────────┤
│                  ↕ messageProtocol (Host ↔ WebView RPC)                  │
├─────────────────────────────────────────────────────────────────────────┤
│                     Layer 2: Driver 层 (Orchestration)                    │
│   IAgentDriverService — 执行编排引擎                                      │
│   TurnManager · SlotOrchestrator · LoopEngine · PipelineBuilder          │
│   StreamController · ErrorRecovery · CancellationHub · StateManager      │
├─────────────────────────────────────────────────────────────────────────┤
│                  ↕ Slot API (getActiveXxxProvider())                      │
├─────────────────────────────────────────────────────────────────────────┤
│                Layer 3: OS 层 (Capability Abstraction)                    │
│   IAgentOSService — 无状态能力仓库 + 注册中心                              │
│   7 Slots: Model · Memory · Tool · Planning · Execution · Retrieval · Kanban│
├─────────────────────────────────────────────────────────────────────────┤
│                  ↕ Provider Interface (registerXxxProvider())             │
├─────────────────────────────────────────────────────────────────────────┤
│                Layer 4: Provider 层 (Plugin Implementation)               │
│   Knot AG-UI · DirectLLM · OpenClaw · Hermes · MCP Gateway · Custom     │
│   各 Provider 通过 Adapter 实现标准 Slot 接口                              │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心设计原则

| 原则 | 描述 |
|------|------|
| **单向依赖** | UI → Driver → OS → Provider，反向禁止 |
| **接口隔离** | 每层仅暴露接口（`I`前缀），实现细节封装 |
| **工作区隔离** | 每个工作区独立持有完整的 Driver + OS + Provider 实例栈，无全局调度 |
| **能力可组合** | 一次对话可混合来自不同 Provider 的能力（如 Knot 模型 + OpenClaw 工具） |
| **优雅降级** | Slot 无 Provider 时 Driver 自动跳过，退化为直通模式 |
| **插件化一切** | 所有 Provider（含 Model）均为可安装/卸载的插件 |

### 1.3 源码分层约束

```
VSCode 原有分层:
  base → platform → editor → workbench

Sarosis 新增:
  sessions（顶层，与 workbench 同级）
    ├── 可 import workbench
    └── workbench 不可 import sessions（反向禁止）
```

---

## 二、Layer 1 — UI 层 (Presentation)

### 2.1 定位

用户交互的唯一入口，负责消息收发、视觉呈现、手势事件。**不含任何业务逻辑。**

### 2.2 技术栈

| 技术 | 用途 |
|------|------|
| React 18 | 组件框架 |
| Zustand | 状态管理 |
| ReactFlow | 画布/节点图 |
| TailwindCSS | 样式系统 |
| esbuild | WebView 打包 |

### 2.3 核心模块

```
WebView App
├── features/
│   ├── chat/           # ChatBar — 对话界面（主交互面板）
│   ├── canvas/         # Canvas — 工作区画布（Agent 节点拖拽）
│   ├── taskBoard/      # TaskBoard — 任务看板（4种视图）
│   ├── gallery/        # Gallery — Agent 模板库
│   ├── modelSelector/  # 模型选择器（Provider分组 + 模型列表）
│   ├── delegation/     # Delegation — 任务委派面板
│   └── health/         # Health Monitor — 健康监控面板
├── shared/
│   ├── protocol/       # messageProtocol 定义与 Hook
│   ├── components/     # 通用 UI 组件
│   └── stores/         # Zustand stores
└── app.tsx             # 入口
```

### 2.4 通信协议

```typescript
// Host ↔ WebView 通信采用 messageProtocol
interface IMessageProtocol {
  // WebView → Host
  sendMessage(content: string, attachments?: IAttachment[]): void;
  cancelTurn(turnId: string): void;
  selectModel(selection: IModelSelection): void;
  delegateTask(params: IDelegateTaskParams): void;

  // Host → WebView (事件推送)
  onChatStreamDelta(delta: IChatStreamDelta): void;
  onTurnStateChange(state: ITurnState): void;
  onTaskBoardUpdate(update: ITaskBoardUpdate): void;
  onModelListChange(models: IModelInfo[]): void;
}
```

### 2.5 布局结构

```
┌──────────────────────────────────────────────────────────────┐
│ Sidebar                │    Editor Area                       │
│ ┌────────────────┐     │  ┌──────────────┬───────────────┐  │
│ │ Sessions       │     │  │ Left Editor  │ Right Editor   │  │
│ │ Workspaces     │     │  │ (Unlocked)   │ (Locked)       │  │
│ │ Agent Gallery  │     │  │              │  · Canvas Tab  │  │
│ │                │     │  │ 普通文件      │  · Chat Tab    │  │
│ └────────────────┘     │  │              │  · TaskBoard   │  │
│                        │  └──────────────┴───────────────┘  │
│ AuxiliaryBar (右侧)     │                                     │
│ ┌────────────────┐     │  Panel (底部)                       │
│ │ Chat           │     │  ┌────────────────────────────────┐│
│ │ Delegation     │     │  │ TaskBoard · Terminal · Output  ││
│ └────────────────┘     │  └────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

---

## 三、Layer 2 — Driver 层 (Orchestration)

### 3.1 定位

执行编排引擎，位于 UI 与 OS 之间。接收用户意图，按 Pipeline 编排调用 OS 层各能力槽，管理 Turn 生命周期。

**核心职责**:
- 统一执行入口（`executeTurn()`）
- Pipeline 构建与步骤编排
- Agent Loop 循环（Plan → Act → Observe → Reflect）
- 流式输出管道与背压控制
- 错误恢复与取消协调
- 会话状态管理

### 3.2 核心接口

```typescript
interface IAgentDriverService {
  // 核心执行
  executeTurn(request: ITurnRequest): AsyncIterable<IChatStreamDelta>;
  cancelTurn(turnId: string): Promise<void>;

  // 状态查询
  getTurnState(turnId: string): ITurnState;
  getActivePipeline(): IPipelineConfig;

  // 配置
  setPipelineConfig(config: IPipelineConfig): void;
  registerMiddleware(middleware: IDriverMiddleware): IDisposable;

  // 事件
  readonly onDidStartTurn: Event<ITurnStartEvent>;
  readonly onDidEndTurn: Event<ITurnEndEvent>;
  readonly onDidError: Event<ITurnErrorEvent>;
}
```

### 3.3 内部 9 大组件

| 组件 | 职责 | 关键行为 |
|------|------|----------|
| **TurnManager** | 回合生命周期 | Pending → Running → Completed/Failed/Cancelled |
| **SlotOrchestrator** | 能力槽编排 | 按 Pipeline 步骤顺序调用 OS Slots |
| **LoopEngine** | Agent 循环 | Plan→Act→Observe→Reflect，支持内置+委托模式 |
| **PipelineBuilder** | 管线构建 | 3种预置：FULL_AGENT / SIMPLE_CHAT / RAG |
| **StreamController** | 流式输出 | 背压控制、16ms帧节流、多路复用 |
| **ErrorRecovery** | 异常恢复 | 5策略：Abort/Retry/Skip/Fallback/AskUser |
| **CancellationHub** | 取消协调 | 令牌传播、超时自动取消、预算控制 |
| **StateManager** | 状态管理 | Turn/Session 状态持久化 + GC |
| **EventBus** | 驱动层事件 | TurnStart/End/Error, StepStart/End, LoopIteration |

### 3.4 Pipeline 配置

```typescript
interface IPipelineConfig {
  name: string;
  steps: IPipelineStep[];
  maxIterations: number;   // 默认 20
  timeoutMs: number;       // 默认 300_000
}

type IPipelineStep =
  | { type: 'slot-call'; slot: AgentCapability; optional: boolean }
  | { type: 'agent-loop'; engine: 'builtin' | 'delegated'; maxIterations: number }
  | { type: 'parallel'; steps: IPipelineStep[] }
  | { type: 'conditional'; condition: ICondition; then: IPipelineStep; else?: IPipelineStep };

// 3 种预置管线
const SIMPLE_CHAT: IPipelineConfig = {
  name: 'simple-chat',
  steps: [
    { type: 'slot-call', slot: 'memory', optional: true },   // 加载上下文
    { type: 'slot-call', slot: 'model', optional: false },   // LLM 推理
    { type: 'slot-call', slot: 'memory', optional: true },   // 写入记忆
  ]
};

const FULL_AGENT: IPipelineConfig = {
  name: 'full-agent',
  steps: [
    { type: 'slot-call', slot: 'memory', optional: true },
    { type: 'slot-call', slot: 'planning', optional: true },
    { type: 'agent-loop', engine: 'builtin', maxIterations: 20 },
    { type: 'slot-call', slot: 'kanban', optional: true },
    { type: 'slot-call', slot: 'memory', optional: true },
  ]
};
```

### 3.5 Middleware 洋葱模型

```typescript
interface IDriverMiddleware {
  name: string;
  beforeTurn?(context: ITurnContext): Promise<void>;
  afterTurn?(context: ITurnContext, result: ITurnResult): Promise<void>;
  beforeStep?(context: IStepContext): Promise<void>;
  afterStep?(context: IStepContext, result: IStepResult): Promise<void>;
  onError?(context: ITurnContext, error: Error): Promise<ErrorRecoveryAction>;
}

// 预置 Middleware
// - LoggingMiddleware:  日志记录
// - RateLimitMiddleware: 速率限制
// - MetricsMiddleware:  指标采集
// - ValidationMiddleware: 输入校验
```

---

## 四、Layer 3 — OS 层 (Capability Abstraction)

### 4.1 定位

无状态能力仓库与注册中心。管理 7 个能力槽位，提供 Provider 注册/查询/切换的统一接口。**不包含执行逻辑。**

### 4.2 核心接口

```typescript
interface IAgentOSService {
  // ─── Provider 注册 ───
  registerModelProvider(provider: IModelProvider): IDisposable;
  registerMemoryProvider(provider: IMemoryProvider): IDisposable;
  registerToolProvider(provider: IToolProvider): IDisposable;
  registerPlanningProvider(provider: IPlanningProvider): IDisposable;
  registerExecutionProvider(provider: IExecutionProvider): IDisposable;
  registerRetrievalProvider(provider: IRetrievalProvider): IDisposable;
  registerKanbanProvider(provider: IKanbanProvider): IDisposable;

  // ─── 活跃 Provider 查询 ───
  getActiveModelProvider(): IModelProvider | undefined;
  getActiveMemoryProvider(): IMemoryProvider | undefined;
  getActiveToolProvider(): IToolProvider | undefined;
  getActivePlanningProvider(): IPlanningProvider | undefined;
  getActiveExecutionProvider(): IExecutionProvider | undefined;
  getActiveRetrievalProvider(): IRetrievalProvider | undefined;
  getActiveKanbanProvider(): IKanbanProvider | undefined;

  // ─── 模型管理 ───
  getModelProviders(): readonly IModelProvider[];
  setActiveModelSelection(selection: IModelSelection): void;
  readonly onDidChangeModelSelection: Event<IModelSelection>;

  // ─── 能力查询 ───
  getRegisteredCapabilities(): AgentCapability[];
  hasCapability(cap: AgentCapability): boolean;
  readonly onDidChangeCapabilities: Event<AgentCapability[]>;
}
```

### 4.3 七大能力槽

| # | Slot | 接口 | 职责 | 典型 Provider |
|---|------|------|------|---------------|
| 1 | **Model** | `IModelProvider` | LLM 推理通道 | Knot AG-UI, DirectLLM |
| 2 | **Memory** | `IMemoryProvider` | 短期/长期记忆读写 | OpenClaw Memory, Hermes Memory |
| 3 | **Tool** | `IToolProvider` | 工具发现与执行 | MCP Gateway, OpenClaw Tools |
| 4 | **Planning** | `IPlanningProvider` | 意图分析、任务分解 | OpenClaw Planning, Hermes Planner |
| 5 | **Execution** | `IExecutionProvider` | Agent Loop 执行引擎 | OpenClaw Runtime, Hermes Executor |
| 6 | **Retrieval** | `IRetrievalProvider` | 知识检索（RAG） | 向量 DB, 文档索引 |
| 7 | **Kanban** | `IKanbanProvider` | 任务看板 CRUD | 内置看板, TAPD, Jira |

### 4.4 Provider 接口定义

```typescript
// ─── Model Slot ───
interface IModelProvider {
  readonly id: string;
  readonly displayName: string;
  listModels(): Promise<IModelInfo[]>;
  chat(request: IChatRequest): AsyncIterable<IChatStreamDelta>;
  getAuthStatus(): IAuthStatus;
  readonly onDidChangeModels: Event<IModelInfo[]>;
}

// ─── Memory Slot ───
interface IMemoryProvider {
  readonly id: string;
  loadContext(query: IMemoryQuery): Promise<IMemoryEntry[]>;
  writeMemory(entry: IMemoryWriteRequest): Promise<void>;
  searchMemory(query: string, options?: ISearchOptions): Promise<IMemoryEntry[]>;
  deleteMemory(entryId: string): Promise<void>;
}

// ─── Tool Slot ───
interface IToolProvider {
  readonly id: string;
  listTools(): Promise<IToolDefinition[]>;
  executeTool(name: string, args: Record<string, unknown>): AsyncIterable<IToolEvent>;
  getToolSchema(name: string): Promise<IToolSchema>;
}

// ─── Planning Slot ───
interface IPlanningProvider {
  readonly id: string;
  analyzeIntent(message: string, context: IContext): Promise<IIntentAnalysis>;
  decomposePlan(goal: string, context: IContext): Promise<IPlan>;
  validatePlan(plan: IPlan): Promise<IValidationResult>;
}

// ─── Execution Slot ───
interface IExecutionProvider {
  readonly id: string;
  executeLoop(config: ILoopConfig): AsyncIterable<ILoopEvent>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getStatus(): IExecutionStatus;
}

// ─── Retrieval Slot ───
interface IRetrievalProvider {
  readonly id: string;
  retrieve(query: string, options?: IRetrievalOptions): Promise<IRetrievalResult[]>;
  index(documents: IDocument[]): Promise<void>;
  getIndexStatus(): IIndexStatus;
}

// ─── Kanban Slot ───
interface IKanbanProvider {
  readonly id: string;
  createBoard(params: IBoardCreateParams): Promise<IKanbanBoard>;
  createCard(boardId: string, params: ICardCreateParams): Promise<IKanbanCard>;
  moveCard(cardId: string, columnId: string): Promise<void>;
  updateCard(cardId: string, updates: Partial<IKanbanCard>): Promise<void>;
  readonly onDidChangeCards: Event<IKanbanCardChangeEvent>;
  readonly onDidChangeBoard: Event<IKanbanBoardChangeEvent>;
}
```

### 4.5 能力枚举

```typescript
enum AgentCapability {
  Model = 'model',
  Memory = 'memory',
  Tool = 'tool',
  Planning = 'planning',
  Execution = 'execution',
  Retrieval = 'retrieval',
  Kanban = 'kanban',
}
```

---

## 五、Layer 4 — Provider 层 (Plugin Implementation)

### 5.1 定位

具体能力实现。每个 Provider 是一个可安装/卸载的 VSCode 扩展插件，通过 Adapter 模式桥接标准 Slot 接口与原生 API。

### 5.2 插件注册机制

```jsonc
// extensions/knot-agui/package.json (示例)
{
  "name": "knot-agui",
  "contributes": {
    "agentCapabilities": [
      { "slot": "model", "id": "knot-agui", "displayName": "Knot AG-UI" }
    ],
    "configuration": {
      "title": "Knot AG-UI",
      "properties": {
        "saros.knot.token": { "type": "string", "description": "Knot API Token" },
        "saros.knot.endpoint": { "type": "string", "default": "https://knot.woa.com" },
        "saros.knot.defaultAgent": { "type": "string" }
      }
    }
  }
}
```

### 5.3 Adapter 基类

```typescript
abstract class BaseProviderAdapter<TNativeAPI> {
  protected native: TNativeAPI;

  constructor(native: TNativeAPI) {
    this.native = native;
  }

  abstract get id(): string;
  abstract get capabilities(): AgentCapability[];

  // 子类实现：将标准接口调用映射到原生 API
  abstract initialize(): Promise<void>;
  abstract dispose(): void;
}
```

### 5.4 已规划 Provider 插件

| 插件 | 路径 | 提供的能力槽 | 状态 |
|------|------|-------------|------|
| **Knot AG-UI** | `extensions/knot-agui/` | Model | 核心（首个实现） |
| **DirectLLM** | `extensions/direct-llm/` | Model | 支持 OpenAI/Anthropic/Ollama/Azure |
| **OpenClaw** | `extensions/openclaw/` | Memory + Tool + Execution + Planning | 中期实现 |
| **Hermes** | `extensions/hermes/` | Memory + Tool + Planning + Execution | 中期实现 |
| **MCP Gateway** | `extensions/mcp-gateway/` | Tool | 本地/远程工具网关 |
| **Vector DB** | `extensions/vector-retrieval/` | Retrieval | RAG 检索 |
| **Built-in Kanban** | 内置（sessions层） | Kanban | TaskBoard 内部 |
| **TAPD** | `extensions/tapd-kanban/` | Kanban | 外部项目管理对接 |

### 5.5 插件内部结构（以 Knot 为例）

```
extensions/knot-agui/
├── package.json              # Manifest + contributes.agentCapabilities
├── src/
│   ├── extension.ts          # 插件入口 (activate/deactivate)
│   ├── knotModelProvider.ts  # IModelProvider 实现
│   ├── knotAGUIClient.ts     # AG-UI 协议客户端
│   ├── adapters/
│   │   └── modelAdapter.ts   # BaseProviderAdapter 子类
│   └── config/
│       └── settings.ts       # 配置读取 + Token 验证
├── tsconfig.json
└── README.md
```

### 5.6 OpenClaw 插件结构（多能力）

```
extensions/openclaw/
├── package.json
├── src/
│   ├── extension.ts
│   ├── gateway/              # OpenClaw Gateway 进程管理
│   │   ├── processManager.ts
│   │   └── healthCheck.ts
│   ├── adapters/
│   │   ├── memoryAdapter.ts     # IMemoryProvider → @openclaw/memory
│   │   ├── toolAdapter.ts       # IToolProvider → MCP Gateway
│   │   ├── executionAdapter.ts  # IExecutionProvider → @openclaw/runtime
│   │   └── planningAdapter.ts   # IPlanningProvider → @openclaw/planner
│   └── native/
│       ├── openclawSDK.ts       # 原生 SDK 封装
│       └── types.ts
└── tsconfig.json
```

---

## 六、横切关注点

### 6.1 多工作区隔离

```typescript
interface IWorkspaceRegistry {
  registerWorkspace(workspaceId: string): IWorkspaceContext;
  unregisterWorkspace(workspaceId: string): void;
  getWorkspace(workspaceId: string): IWorkspaceContext | undefined;
  readonly activeWorkspaces: ReadonlyMap<string, IWorkspaceContext>;
}

interface IWorkspaceContext {
  readonly id: string;
  readonly osService: IAgentOSService;          // 独立 OS 实例
  readonly driverService: IAgentDriverService;  // 独立 Driver 实例
  readonly quotaGuard: IQuotaGuard;             // 独立配额管理
  readonly rootPath: string;                    // 工作区根路径
}
```

**设计决策**: 无全局调度器、无资源池、无优先级队列。每工作区完全独立运行，互不干扰。

### 6.2 Agent 实例化

```typescript
interface IAgentInstanceService {
  createInstance(templateId: string, workspaceId: string): Promise<IAgentInstance>;
  cloneInstance(instanceId: string): Promise<IAgentInstance>;
  importFromOpenClaw(path: string): Promise<IAgentInstance>;
  deleteInstance(instanceId: string): Promise<void>;
  upgradeInstance(instanceId: string, newTemplate: IAgentTemplate): Promise<void>;
  listInstances(workspaceId: string): Promise<IAgentInstance[]>;
}

interface IAgentGalleryService {
  listTemplates(filter?: IGalleryFilter): Promise<IAgentTemplate[]>;
  getTemplate(templateId: string): Promise<IAgentTemplate>;
  installTemplate(source: IGallerySource): Promise<void>;
  // 模板来源: builtin / marketplace / custom
}
```

**实例目录**:
```
.saros/agents/{instance-id}/
├── agent.yaml          # 核心配置
├── system-prompt.md    # 系统提示词
├── tools/              # 自定义工具
├── skills/             # 技能库
├── memory/             # 本地记忆
├── sessions/           # 会话历史
├── logs/               # 执行日志
└── state/              # 运行时状态
```

### 6.3 Agent Scheduler（触发调度）

```typescript
interface IAgentSchedulerService {
  createSchedule(agentId: string, schedule: IScheduleConfig): Promise<string>;
  deleteSchedule(scheduleId: string): Promise<void>;
  listSchedules(agentId: string): Promise<IScheduleInfo[]>;
  pauseSchedule(scheduleId: string): Promise<void>;
  resumeSchedule(scheduleId: string): Promise<void>;
}

// 5 种触发模式
type TriggerType = 'cron' | 'file-watch' | 'event' | 'one-shot' | 'interval';

// 事件类型
type EventType =
  | 'git:push' | 'git:commit'
  | 'terminal:command-fail'
  | 'build:fail' | 'build:success'
  | 'workspace:open' | 'workspace:close'
  | 'agent:task-complete'
  | 'external:webhook';
```

### 6.4 Memory Consolidation（记忆沉淀）

5 阶段后台流程:
```
Session Memory (短期)
    ↓ [1] 压缩: 合并连续相似条目
    ↓ [2] 提升: 高重要性条目升级为长期记忆
    ↓ [3] 去重: embedding相似度>0.92的合并
    ↓ [4] 衰减: 时间衰减(exponential/linear/step) + pinned保护
    ↓ [5] 知识图谱: 抽取实体关系，构建知识网络
Long-term Memory (长期)
```

### 6.5 Agent Self-Upgrade（自升级）

| 升级能力 | 描述 | 数据来源 |
|----------|------|----------|
| Prompt 优化 | 自动调优系统提示词 | Turn 成功/失败率 |
| 工具分析 | 优化工具选择策略 | Tool Call 历史 |
| 技能提取 | 从重复操作中提炼 Skill | 序列模式挖掘(PrefixSpan) |
| 配置调优 | 调整 temperature/maxTokens | A/B 对比 |
| 错误学习 | 记录错误模式避免重蹈 | ErrorRecovery 日志 |

**安全保障**: constraints 段不可删 · A/B 验证退化自动回滚 · 每日最多 3 个自动升级

### 6.6 Crew/Team 编排

```typescript
interface IAgentCrewService {
  createCrew(config: ICrewConfig): Promise<ICrew>;
  executeCrew(crewId: string, task: string): AsyncIterable<ICrewEvent>;
}

// 4 种编排模式
type CrewMode = 'sequential' | 'parallel' | 'router' | 'hierarchical';
```

### 6.7 Enhanced Task Board

层级任务树 + 4 种视图:
1. **看板视图** — 5列 Kanban (Todo/InProgress/Review/Done/Cancelled)
2. **树形视图** — 实时 Agent 活动树 + 进度/cost + Kill/Pause 控制
3. **分析视图** — Token/Cost/Duration 统计图表 + Agent/Tool 排行
4. **时间线视图** — 甘特图 + 依赖连线

```typescript
interface ITaskDelegationService {
  delegateTask(params: IDelegateTaskParams): Promise<ITaskRecord>;
  delegateBatch(params: IDelegateBatchParams): Promise<ITaskRecord[]>;
  cancelTask(taskId: string): Promise<void>;
  cancelBatch(batchId: string): Promise<void>;
  pauseTask(taskId: string): Promise<void>;
  resumeTask(taskId: string): Promise<void>;
  retryTask(taskId: string): Promise<void>;
}
```

### 6.8 Health Monitor

```typescript
interface IHealthMonitorService {
  getHealth(workspaceId: string): IHealthReport;
  getMetrics(agentId: string): IAgentMetrics;
  readonly onDidChangeHealth: Event<IHealthChangeEvent>;
}

interface IHealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  providers: Map<AgentCapability, IProviderHealth>;
  uptime: number;
  lastError?: IErrorInfo;
}
```

### 6.9 EventBridge（事件总线）

> **实现状态**: ✅ 已实现 — `common/eventBridge.ts`

统一事件总线服务，实现组件间松耦合通信。Scheduler 通过 EventBridge 监听系统事件触发 Agent 执行。

```typescript
interface IEventBridgeService {
  readonly onAnyEvent: Event<IEventBridgeEvent>;

  on(eventType: string, handler: (event: IEventBridgeEvent) => void): IDisposable;
  once(eventType: string, handler: (event: IEventBridgeEvent) => void): void;
  emit(eventType: string, data?: any, source?: string): void;
  off(eventType: string, handler?: (event: IEventBridgeEvent) => void): void;
  getEventTypes(): string[];
  getListenerCount(eventType: string): number;
}

// 预定义事件类型
const AgentTriggerEventType = {
  GitPush: 'git:push', GitCommit: 'git:commit', GitMerge: 'git:merge',
  TerminalCommandFail: 'terminal:command:fail', TerminalCommandComplete: 'terminal:command:complete',
  BuildFail: 'build:fail', BuildSuccess: 'build:success',
  WorkspaceOpen: 'workspace:open', WorkspaceClose: 'workspace:close',
  AgentTaskComplete: 'agent:task:complete', AgentError: 'agent:error',
  FileCreate: 'file:create', FileChange: 'file:change', FileDelete: 'file:delete',
  Custom: 'custom',
};
```

**设计特点**: 支持通配符 `'*'` 监听全部事件 · Scheduler 内部依赖此服务实现 event-trigger 类型调度。

### 6.10 Runtime Utilities（运行时工具集）

> **实现状态**: ✅ 已实现 — 均在 `common/` 目录下

Agent 执行循环的底层运行时组件，参考 Hermes-Agent 设计：

| 工具 | 文件 | 职责 |
|------|------|------|
| **ContextManager** | `contextManager.ts` | 上下文压缩管理器。当对话历史超出 token 阈值 (50%) 时，使用 LLM 生成历史摘要，保留最近 20 条消息。 |
| **ParallelToolExecutor** | `parallelToolExecutor.ts` | 智能判断工具调用批次是否可并行执行（黑名单检查、文件路径冲突检测、上限 8 并行），自动选择并行/串行模式。 |
| **IterationBudget** | `iterationBudget.ts` | 迭代预算控制器。防止 Agent 无限循环。默认 90 次上限。支持子预算分配（Sub-Agent 使用父预算的 60%）、退款、低预算告警。 |
| **SubAgentManager** | `subAgentManager.ts` | 子 Agent 委派管理器。支持创建子 Agent、并行执行多个子 Agent、超时控制（默认 5 分钟）、预算隔离。 |
| **ToolArgumentRepairer** | `toolRepair.ts` | 工具参数 JSON 修复器。自动修复 LLM 输出的常见 JSON 格式错误：尾随逗号、Python None→null、控制字符转义、单引号→双引号、未引用键名。 |

```typescript
// IterationBudget 使用示例
const budget = new IterationBudget(90);
const childBudget = budget.createChildBudget(); // 子Agent预算 = min(50, 父剩余*60%)

while (budget.hasRemaining()) {
  budget.consume(1);
  if (budget.isRunningLow()) { /* 预算低于10%，注入提示 */ }
}

// ParallelToolExecutor 使用示例
const executor = new ParallelToolExecutor();
if (executor.shouldParallelize(toolCalls)) {
  results = await executor.executeTools(toolCalls, executeTool);
}
```

### 6.11 WorkspaceTemplate（工作区模板）

> **实现状态**: ✅ 接口已定义 — `common/workspaceTemplate.ts`

允许用户保存/加载工作区状态，实现"模板化启动"和快照回滚。

```typescript
interface IWorkspaceTemplateService {
  // 模板生命周期
  createTemplate(name: string, description: string, type: TemplateType, options?: ICaptureTemplateOptions): Promise<ITemplateMetadata>;
  applyTemplate(templateId: string, options: IApplyTemplateOptions): Promise<boolean>;
  listTemplates(filter?: ITemplateFilter): Promise<ITemplateMetadata[]>;

  // 快照管理
  createSnapshot(templateId: string, name: string): Promise<ITemplateSnapshot>;
  restoreSnapshot(snapshotId: string, targetWorkspace: URI): Promise<boolean>;
  rollbackToSnapshot(snapshotId: string, targetWorkspace: URI): Promise<boolean>;

  // 模板分享
  exportTemplate(templateId: string): Promise<ITemplateExport>;
  importTemplate(templateExport: ITemplateExport): Promise<ITemplateMetadata>;

  // 事件
  readonly onDidCreateTemplate: Event<ITemplateMetadata>;
  readonly onDidCompleteApply: Event<{ templateId: string; success: boolean }>;
}

// 模板类型
enum TemplateType { Blank, Project, Task, Snapshot, Custom }

// 捕获内容类型
enum CaptureContentType { Files, Layout, Environment, Terminal, Debug, Git, Extensions }

// 应用策略
enum ApplyStrategy { Merge, Overwrite, Skip, Prompt }
```

**核心能力**:
1. **捕获** — 文件内容 + 编辑器布局 + 环境变量 + 终端状态 + Git 状态
2. **应用** — 4 种策略（合并/覆盖/跳过/提示），支持变量替换
3. **版本管理** — 快照 + diff + 回滚
4. **分享** — 导出/导入/分享 URL，支持 Private/Team/Public 三种范围

---

## 七、完整目录结构

```
src/vs/sessions/contrib/agentStudio/
├── common/                          # 接口层（跨进程共享）
│   ├── agentOS.ts                   # IAgentOSService 接口 ✅
│   ├── agentDriver.ts              # IAgentDriverService 接口 ✅
│   ├── providers.ts                 # 7 个 Provider 接口 + IChatStreamDelta ✅
│   ├── agentStudio.ts              # IAgentStudioService + IAgentChatService + IDelegation + ITaskBoard ✅
│   ├── agentInstance.ts            # IAgentInstanceService + IAgentGalleryService ✅
│   ├── agentScheduler.ts           # IAgentSchedulerService (5种触发模式) ✅
│   ├── crewTeam.ts                 # ICrewTeamService (Crew/Team 编排) ✅
│   ├── healthMonitor.ts            # IHealthMonitorService (告警+指标) ✅
│   ├── eventBridge.ts              # IEventBridgeService + EventBridgeService 实现 ✅
│   ├── workspaceTemplate.ts        # IWorkspaceTemplateService (模板/快照) ✅
│   ├── contextManager.ts           # ContextManager (上下文压缩) ✅
│   ├── parallelToolExecutor.ts     # ParallelToolExecutor (并行工具执行) ✅
│   ├── iterationBudget.ts          # IterationBudget (迭代预算控制) ✅
│   ├── subAgentManager.ts          # SubAgentManager (子Agent管理) ✅
│   ├── toolRepair.ts               # ToolArgumentRepairer (JSON修复) ✅
│   ├── cronParser.ts               # CronParser 工具类 ✅
│   ├── modelSelector.ts            # IModelSelectorService
│   ├── agentWorkspace.ts           # Agent工作区相关
│   ├── adapters.ts                 # BaseProviderAdapter 基类
│   ├── errors.ts                   # AgentOSError 定义
│   ├── types.ts                    # Employee, Workspace, Connection, ChatMessage 等类型
│   └── constants.ts                # View IDs, Setting Keys, 常量定义
│
├── browser/                         # 实现层（Renderer 进程）
│   ├── agentOSService.ts           # AgentOSService 实现 ✅ (含 Fallback 机制)
│   ├── slotRegistry.ts             # SlotRegistry（能力槽注册表）✅
│   ├── agentDriverService.ts       # AgentDriverService 实现 ✅ (含完整编排4步)
│   ├── agentStudioService.ts       # AgentStudioService (Employee/Workspace/Session CRUD) ✅
│   ├── agentChatService.ts         # AgentChatService ⚠️ 兼容层（→ 委托 Driver）
│   ├── agentInstanceService.ts     # AgentInstanceService 实现 ✅
│   ├── agentGalleryService.ts      # AgentGalleryService 实现 ✅
│   ├── agentSchedulerService.ts    # AgentSchedulerService 实现 ✅ (5种触发全实现)
│   ├── agentDelegationService.ts   # AgentDelegationService 实现
│   ├── agentStudioProvider.ts      # Editor Provider
│   ├── agentStudioEditorInput.ts   # Editor Input
│   ├── agentStudioEditorPane.ts    # Editor Pane
│   ├── agentStudioSidebarView.ts   # Sidebar View
│   ├── agentStudioToolbar.contribution.ts  # Toolbar 贡献
│   ├── agentStudioToolbarView.ts   # Toolbar View
│   ├── agentStudio.contribution.ts # DI 注册入口
│   ├── providers/                   # ⭐ 内置 Provider 实现
│   │   ├── execution/
│   │   │   ├── executionProvider.ts
│   │   │   └── executionProviderService.ts
│   │   ├── memory/
│   │   │   ├── memoryProvider.ts
│   │   │   ├── localFileMemory.ts   # 本地文件记忆实现
│   │   │   └── vectorMemory.ts      # 向量记忆实现
│   │   ├── planning/
│   │   │   ├── planningProvider.ts
│   │   │   └── planningProviderService.ts
│   │   └── tool/
│   │       ├── toolProvider.ts
│   │       └── toolProviderService.ts
│   ├── views/                       # UI 视图（非 WebView）
│   │   └── media/
│   └── media/                       # 静态资源
│
├── webview/                         # WebView 源码 (React)
│   ├── src/
│   │   ├── features/
│   │   │   ├── chat/
│   │   │   ├── canvas/
│   │   │   ├── taskBoard/
│   │   │   ├── gallery/
│   │   │   ├── modelSelector/
│   │   │   ├── delegation/
│   │   │   └── health/
│   │   ├── shared/
│   │   │   ├── protocol/
│   │   │   ├── components/
│   │   │   └── stores/
│   │   └── app.tsx
│   ├── node_modules/               # WebView 独立依赖
│   ├── esbuild.config.js
│   └── tsconfig.json
│
└── test/                            # 测试
    ├── common/
    └── browser/
```

### 插件目录

```
extensions/
├── knot-agui/                # Model Provider: Knot AG-UI
│   ├── package.json
│   └── src/
├── direct-llm/               # Model Provider: OpenAI/Anthropic/Ollama
│   ├── package.json
│   └── src/
├── openclaw/                  # Multi-Capability: Memory+Tool+Execution+Planning
│   ├── package.json
│   └── src/
├── hermes/                    # Multi-Capability: Memory+Tool+Planning+Execution
│   ├── package.json
│   └── src/
├── mcp-gateway/              # Tool Provider: MCP 远程工具
│   ├── package.json
│   └── src/
└── vector-retrieval/          # Retrieval Provider: 向量检索
    ├── package.json
    └── src/
```

### Agent 实例目录

```
{workspace-root}/
└── .saros/
    ├── config.yaml           # 工作区级配置
    └── agents/
        ├── {instance-id-1}/
        │   ├── agent.yaml    # Agent 配置
        │   ├── system-prompt.md
        │   ├── tools/
        │   ├── skills/
        │   ├── memory/
        │   ├── sessions/
        │   ├── logs/
        │   └── state/
        └── {instance-id-2}/
            └── ...
```

---

## 八、数据流与交互时序

### 8.1 标准对话流（FULL_AGENT Pipeline）

```
用户输入消息
    │
    ▼
┌─── Layer 1: UI ────────────────────┐
│  WebView → messageProtocol.send()  │
└────────────────────────────────────┘
    │
    ▼
┌─── Layer 2: Driver ────────────────────────────────────────────────┐
│  AgentDriverService.executeTurn(request)                            │
│    │                                                                │
│    ├─→ [1] TurnManager: 创建 Turn, 状态 → Running                   │
│    ├─→ [2] PipelineBuilder: 选择 FULL_AGENT 管线                    │
│    ├─→ [3] SlotOrchestrator: 按步骤调用 OS Slots                    │
│    │       │                                                        │
│    │       ├─→ Step 1: Memory.loadContext() ←── OS Layer            │
│    │       ├─→ Step 2: Planning.analyzeIntent() ←── OS Layer        │
│    │       ├─→ Step 3: LoopEngine 启动                              │
│    │       │           ┌─────────────────────────┐                  │
│    │       │           │  Plan → Act → Observe   │ ← Agent Loop     │
│    │       │           │    ↑                ↓   │                  │
│    │       │           │    └── Reflect ──────┘  │                  │
│    │       │           └─────────────────────────┘                  │
│    │       │           Loop 内调用:                                   │
│    │       │             Model.chat() ←── OS Layer                  │
│    │       │             Tool.executeTool() ←── OS Layer             │
│    │       ├─→ Step 4: Kanban.updateCard() ←── OS Layer             │
│    │       └─→ Step 5: Memory.writeMemory() ←── OS Layer            │
│    │                                                                │
│    ├─→ [4] StreamController: yield IChatStreamDelta → UI            │
│    └─→ [5] TurnManager: 状态 → Completed                            │
└────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─── Layer 3: OS ───────────────────────────────────┐
│  AgentOSService.getActiveXxxProvider()             │
│  ↓ 路由到注册的 Provider                            │
└───────────────────────────────────────────────────┘
    │
    ▼
┌─── Layer 4: Provider ─────────────────────────────┐
│  KnotModelProvider.chat(request)                   │
│  → Knot AG-UI HTTP/WebSocket → LLM Response       │
│  OpenClawToolAdapter.executeTool(name, args)       │
│  → MCP Gateway → Tool Result                      │
└───────────────────────────────────────────────────┘
```

### 8.2 降级模式（仅 Model Provider）

```
用户输入 → Driver.executeTurn()
  → PipelineBuilder: 自动选择 SIMPLE_CHAT
  → SlotOrchestrator:
      [1] Memory.loadContext() — 跳过(无 Provider)
      [2] Model.chat()         — Knot AG-UI 执行
      [3] Memory.writeMemory() — 跳过(无 Provider)
  → StreamController: yield 流式输出
```

### 8.3 IChatStreamDelta 事件类型

```typescript
type IChatStreamDelta =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; toolName: string; callId: string }
  | { type: 'tool_args'; callId: string; argsChunk: string }
  | { type: 'tool_end'; callId: string; result: unknown }
  | { type: 'plan_start'; planId: string }
  | { type: 'plan_step'; planId: string; step: IPlanStep }
  | { type: 'plan_end'; planId: string }
  | { type: 'memory_write'; entryId: string; summary: string }
  | { type: 'kanban_update'; cardId: string; status: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; usage: ITokenUsage };
```

---

## 九、服务依赖矩阵

### 9.1 服务间依赖关系

```
                  依赖方向 →
                  ┌─────────────────────────────────────────────┐
                  │ OS  Driver  WsReg  Instance  Sched  TaskDel │
  ┌───────────────┼─────────────────────────────────────────────┤
  │ Driver        │ ✓                                           │
  │ WsRegistry    │ ✓    ✓                                      │
  │ Instance      │           ✓                                 │
  │ Scheduler     │      ✓           ✓                          │
  │ TaskDeleg     │      ✓                                      │
  │ Consolidation │ ✓                        ✓                  │
  │ SelfUpgrade   │ ✓    ✓                   ✓                  │
  │ Crew          │      ✓           ✓              ✓           │
  │ HealthMonitor │ ✓    ✓    ✓                                 │
  └───────────────┴─────────────────────────────────────────────┘
```

### 9.2 Level 级别定义

| Level | 含义 | 标准 |
|-------|------|------|
| L0 | 接口定义 | .ts 文件存在，类型完整，编译通过 |
| L1 | 空壳实现 | DI 可注入，方法返回空/默认值 |
| L2 | 功能实现 | 核心路径可用，无 edge case 处理 |
| L3 | 生产就绪 | 错误处理、日志、超时、重试完备 |

### 9.3 各服务 Level 路线

| 服务 | P0 | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 |
|------|----|----|----|----|----|----|----|----|---- |
| IAgentOSService | - | L1 | L2 | L2 | L2 | L3 | L3 | L3 | L3 |
| IAgentDriverService | - | - | L2 | L2 | L2 | L2 | L3 | L3 | L3 |
| IModelProvider (Knot) | - | - | - | L2 | L2 | L2 | L2 | L2 | L3 |
| IWorkspaceRegistry | - | - | - | - | L2 | L2 | L2 | L2 | L3 |
| IAgentInstanceService | - | - | - | - | L2 | L2 | L2 | L2 | L3 |
| IMemoryProvider | - | - | - | - | - | L2 | L2 | L2 | L3 |
| IToolProvider | - | - | - | - | - | L2 | L2 | L2 | L3 |
| IPlanningProvider | - | - | - | - | - | L2 | L2 | L2 | L3 |
| IAgentSchedulerService | - | - | - | - | - | - | L2 | L2 | L3 |
| ITaskDelegationService | - | - | - | - | - | - | - | L2 | L3 |
| IMemoryConsolidation | - | - | - | - | - | - | - | - | L2 |
| IAgentSelfUpgrade | - | - | - | - | - | - | - | - | L2 |
| IAgentCrewService | - | - | - | - | - | - | - | - | L2 |

---

## 十、Phase 实施路线图

### 10.1 总览（P0-P8, 约 16 周）

```
Week:  1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16
       ├───┤
P0     █████ 文档重组

           ├───────┤
P1         █████████ OS 骨架

                   ├───────────┤
P2                 █████████████ Driver 层
                   ├───────┤
P3                 █████████ Model 插件化 (∥ P2)

                               ├───────────┤
P4                             █████████████ 工作区 + 实例

                                           ├───────────────────┤
P5a                                        █████████ Memory
P5b                                        █████████ Tool/MCP   (∥ P5a)
P5c                                                █████████████ Planning+Exec

                                           ├───────┤
P6                                         █████████ Scheduler  (∥ P5)

                                                       ├───────────┤
P7                                                     █████████████ TaskBoard (∥ P8)

                                                       ├───────────────┤
P8                                                     █████████████████ 高阶能力
```

### 10.2 各 Phase 详情

| Phase | 名称 | 周期 | 依赖 | 产出 |
|-------|------|------|------|------|
| **P0** | 文档重组 | 1w | 无 | 架构文档重构（22章→4Part+12章） |
| **P1** | OS 骨架 | 2w | P0 | `IAgentOSService` + 7 Provider 接口 + SlotRegistry |
| **P2** | Driver 层 | 3w | P1 | `IAgentDriverService` + Pipeline + Loop + 流控 |
| **P3** | Model 插件化 | 2w | P1 (∥P2) | Knot 抽取 + `IModelProvider` + 模型选择器 UI |
| **P4** | 工作区+实例 | 3w | P2 | `IWorkspaceRegistry` + Instance + Gallery |
| **P5a** | Memory Provider | 2w | P1+P2 | `IMemoryProvider` 实现 + 存储后端 |
| **P5b** | Tool Provider | 2w | P1+P2 (∥P5a) | `IToolProvider` + MCP Gateway 对接 |
| **P5c** | Planning+Execution | 3w | P5a+P5b | `IPlanningProvider` + `IExecutionProvider` |
| **P6** | Scheduler | 2w | P2+P4 (∥P5) | `IAgentSchedulerService` + 5种触发 |
| **P7** | Enhanced TaskBoard | 3w | P2 (∥P8) | 层级任务树 + 4种视图 + `ITaskDelegationService` |
| **P8** | 高阶能力 | 4w | P5+P6 (∥P7) | Consolidation + SelfUpgrade + Crew |

### 10.3 关键路径

```
P0(1w) → P1(2w) → P2(3w) → P4(3w) → P5c(3w) = 12 周
```

### 10.4 并行机会

- **P2 ∥ P3** — Driver 与 Model 插件化同步推进
- **P5a ∥ P5b ∥ P6** — Memory、Tool、Scheduler 互不依赖
- **P7 ∥ P8** — TaskBoard 与高阶能力互不依赖

### 10.5 每 Phase 验收标准

**通用检查表**:
- [ ] 编译通过（`npm run compile`）
- [ ] 无循环依赖（`madge --circular`）
- [ ] 现有功能不退化（冒烟测试）
- [ ] 新接口有 JSDoc 注释
- [ ] DI 注册正确
- [ ] 可独立 merge 到 main

---

## 附录 A: 术语表

| 术语 | 定义 |
|------|------|
| **Driver** | 驱动层，执行编排引擎，统一入口 |
| **OS** | 操作系统层，无状态能力仓库 |
| **Provider** | 能力提供者插件，实现具体 Slot 接口 |
| **Slot** | 能力槽位，OS 层的抽象能力接口 |
| **Turn** | 一次用户输入到模型输出的完整执行周期 |
| **Pipeline** | 可配置的执行步骤序列 |
| **Adapter** | 适配器，桥接标准接口与原生 API |
| **Instance** | Agent 实例，从 Gallery 模板创建 |
| **Gallery** | Agent 模板库 |
| **Workspace** | 工作区，隔离的独立运行环境 |
| **Crew** | Agent 团队，多 Agent 协作编排 |

## 附录 B: agent.yaml 配置示例

```yaml
# .saros/agents/{instance-id}/agent.yaml
apiVersion: saros/v1
kind: Agent
metadata:
  id: "code-reviewer-001"
  name: "Code Reviewer"
  template: "builtin/code-reviewer"
  createdAt: "2026-05-11T14:00:00Z"

spec:
  model:
    provider: "knot-agui"
    modelId: "gpt-4o"
    temperature: 0.3
    maxTokens: 4096

  tools:
    enabled:
      - "file-read"
      - "file-write"
      - "terminal"
      - "git"
    blocked:
      - "browser"
    mcpServers:
      - name: "project-tools"
        url: "http://localhost:3000"

  memory:
    shortTerm:
      maxEntries: 100
      ttlHours: 24
    longTerm:
      backend: "file"  # file | vector-db
      maxEntries: 10000
    consolidation:
      enabled: true
      schedule: "0 3 * * *"  # 每天凌晨3点
      importanceThreshold: 0.6

  execution:
    maxIterations: 20
    timeoutMs: 300000
    pipeline: "full-agent"  # simple-chat | full-agent | rag

  constraints:
    # ⚠️ 此段不可被 Self-Upgrade 修改
    maxTokensPerTurn: 8192
    maxToolCallsPerTurn: 50
    blockedPaths:
      - "~/.ssh/"
      - "~/.aws/"
    requireConfirmation:
      - "file-delete"
      - "git-push"

  schedules:
    - trigger: "cron"
      expression: "0 9 * * 1-5"  # 工作日 9:00
      input: "检查代码质量并生成报告"
    - trigger: "event"
      event: "git:push"
      input: "审查最新推送的代码: {{event.detail}}"

  crew:
    role: "leaf"  # leaf | orchestrator
    maxConcurrentChildren: 3
    maxSpawnDepth: 1
```

## 附录 C: 统一流事件协议 (IChatStreamDelta)

所有层间通信的流式事件均使用 `IChatStreamDelta` 类型，保证 UI 层无需了解底层实现细节即可正确渲染。

```typescript
// 完整事件类型枚举
enum StreamDeltaType {
  // 基础
  Text = 'text',
  Thinking = 'thinking',
  Done = 'done',
  Error = 'error',

  // 工具
  ToolStart = 'tool_start',
  ToolArgs = 'tool_args',
  ToolEnd = 'tool_end',

  // 规划
  PlanStart = 'plan_start',
  PlanStep = 'plan_step',
  PlanEnd = 'plan_end',

  // 记忆
  MemoryWrite = 'memory_write',

  // 看板
  KanbanUpdate = 'kanban_update',

  // Agent Loop
  LoopIteration = 'loop_iteration',
  LoopEnd = 'loop_end',
}
```

---

## 附录 D: 实现状态与源码对照

> **更新日期**: 2026-05-11 (v1.1)  
> **来源**: 源码审查 `src/vs/sessions/contrib/agentStudio/`

### D.1 服务/组件实现状态总览

| 设计服务 | 接口文件 | 实现文件 | 状态 | 备注 |
|----------|----------|----------|------|------|
| **IAgentOSService** | `common/agentOS.ts` | `browser/agentOSService.ts` | ✅ 已实现 | 含 Fallback 机制 (3备用模型) |
| **IAgentDriverService** | `common/agentDriver.ts` | `browser/agentDriverService.ts` | ✅ 已实现 | 4步编排: Memory→Planning→Execute→Memory |
| **SlotRegistry** | `common/providers.ts` (ISlotRegistry) | `browser/slotRegistry.ts` | ✅ 已实现 | 管理6能力槽 (Model由OS直管) |
| **IAgentStudioService** | `common/agentStudio.ts` | `browser/agentStudioService.ts` | ✅ 已实现 | Employee/Workspace/Session CRUD |
| **IAgentChatService** | `common/agentStudio.ts` | `browser/agentChatService.ts` | ⚠️ 兼容层 | 将委托给 Driver，过渡期保留 |
| **IAgentDelegationService** | `common/agentStudio.ts` | `browser/agentDelegationService.ts` | ✅ 已实现 | 含 Auto-Plan |
| **IAgentTaskBoardService** | `common/agentStudio.ts` | — | 🔲 接口已定义 | 实现待 Phase 3 |
| **IAgentInstanceService** | `common/agentInstance.ts` | `browser/agentInstanceService.ts` | ✅ 已实现 | 含磁盘加载/创建配置 |
| **IAgentGalleryService** | `common/agentInstance.ts` | `browser/agentGalleryService.ts` | ✅ 已实现 | 含模板目录 + Mock 数据 |
| **IAgentSchedulerService** | `common/agentScheduler.ts` | `browser/agentSchedulerService.ts` | ✅ 已实现 | 5种触发全实现 (Cron/FileWatch/Event/OneShot/Interval) |
| **IHealthMonitorService** | `common/healthMonitor.ts` | — | 🔲 接口已定义 | 实现待 Phase 4 |
| **ICrewTeamService** | `common/crewTeam.ts` | — | 🔲 接口已定义 | 实现待 Phase 4.5 |
| **IWorkspaceTemplateService** | `common/workspaceTemplate.ts` | — | 🔲 接口已定义 | 实现待 Phase 4.2 |
| **IEventBridgeService** | `common/eventBridge.ts` | `common/eventBridge.ts` (含实现) | ✅ 已实现 | 接口+实现同文件 |
| **IWorkspaceRegistry** | — | — | 🔲 未创建 | 设计文档中规划，待实现 |
| **IMemoryConsolidationService** | — | — | 🔲 未创建 | 设计文档中规划，待 Phase 5 |
| **IAgentSelfUpgradeService** | — | — | 🔲 未创建 | 设计文档中规划，待 Phase 6 |
| **ITaskDelegationService** | — | — | 🔲 未创建 | 设计文档中规划，待 Phase 5c |

### D.2 Driver 层 9 大组件的实现现状

文档设计中 Driver 层包含 9 个独立组件（TurnManager, SlotOrchestrator, LoopEngine, PipelineBuilder, StreamController, ErrorRecovery, CancellationHub, StateManager, EventBus）。

**当前实际状态**: 这些组件的逻辑**已部分实现**但**尚未拆分为独立文件**。核心编排逻辑直接内联在以下两个文件中：

| 文件 | 实现的组件逻辑 |
|------|---------------|
| `browser/agentDriverService.ts` | TurnManager (状态追踪) + SlotOrchestrator (Memory→Planning→Execute→Memory 4步) + CancellationHub (AbortController) |
| `browser/agentOSService.ts` | ErrorRecovery (_executeWithFallback) + 模型自动选择 + Stream 适配 |

**未实现的组件**:
- `browser/driver/` 目录 — **不存在**（计划中的独立组件目录）
- PipelineBuilder — 当前是固定编排顺序，未实现动态管线
- StreamController — 16ms 帧节流逻辑在 agentChatService 中（兼容层）
- LoopEngine — 委托给 ExecutionProvider.runAgentLoop()
- StateManager — 暂时使用 Map 内存管理
- EventBus — 使用 VSCode 原生 Emitter

**重构路线**: Phase 2 中将从 agentDriverService.ts 提取独立组件文件。

### D.3 内置 Provider 实现 (browser/providers/)

文档中 Provider 规划为外部插件 (`extensions/`)，但当前已有**内置 Provider 实现**直接位于 sessions 层：

```
browser/providers/
├── execution/
│   ├── executionProvider.ts         # IExecutionProvider 基础实现
│   └── executionProviderService.ts  # ExecutionProvider 服务注册
├── memory/
│   ├── memoryProvider.ts            # IMemoryProvider 基础实现
│   ├── localFileMemory.ts           # 本地文件记忆（JSON文件存储）
│   └── vectorMemory.ts              # 向量记忆（embedding相似搜索）
├── planning/
│   ├── planningProvider.ts          # IPlanningProvider 基础实现
│   └── planningProviderService.ts   # PlanningProvider 服务注册
└── tool/
    ├── toolProvider.ts              # IToolProvider 基础实现
    └── toolProviderService.ts       # ToolProvider 服务注册
```

**定位**: 这些是 Phase 0/1 的**内置默认 Provider**，为系统提供开箱即用能力。外部插件 Provider（如 Knot、OpenClaw）在 Phase 3+ 中以扩展方式覆盖。

### D.4 运行时工具集（设计文档未覆盖的新增组件）

以下组件是在实现过程中参考 Hermes-Agent 新增的运行时支撑层，原设计文档未规划：

| 组件 | 来源参考 | 功能描述 | 被谁使用 |
|------|----------|----------|----------|
| **ContextManager** | Hermes-Agent context_window | 自动压缩对话历史超长消息 | ExecutionProvider |
| **ParallelToolExecutor** | Hermes-Agent _should_parallelize_tool_batch | 智能并行/串行工具执行决策 | ExecutionProvider |
| **IterationBudget** | Hermes-Agent iteration_budget | Agent循环预算控制(默认90次) | ExecutionProvider + SubAgentManager |
| **SubAgentManager** | Hermes-Agent sub-agent delegation | 子Agent创建/并行执行/超时/预算 | ExecutionProvider |
| **ToolArgumentRepairer** | Hermes-Agent _repair_tool_call_arguments | LLM输出JSON修复 | ToolProvider |
| **CronParser** | 内部工具 | Cron表达式解析/下次触发计算 | AgentSchedulerService |

### D.5 View ID 与 UI 常量（实际源码）

从 `common/constants.ts` 提取的完整 View 系统：

```typescript
// Toolbar 侧边栏视图 (左侧工具栏)
AGENT_STUDIO_TOOLBAR_VIEW_ID        = 'agentStudio.toolbarView'
AGENT_STUDIO_CLAW_CHAT_VIEW_ID      = 'agentStudio.clawChatView'       // Claw 对话
AGENT_STUDIO_WORKSPACE_VIEW_ID      = 'agentStudio.workspaceView'      // 工作区
AGENT_STUDIO_PRESET_AGENT_VIEW_ID   = 'agentStudio.presetAgentView'    // 预设Agent
AGENT_STUDIO_SKILLS_VIEW_ID         = 'agentStudio.skillsView'         // 技能管理
AGENT_STUDIO_TASKS_VIEW_ID          = 'agentStudio.tasksView'          // 任务列表
AGENT_STUDIO_SCHEDULE_VIEW_ID       = 'agentStudio.scheduleView'       // 调度管理
AGENT_STUDIO_TOOLS_VIEW_ID          = 'agentStudio.toolsView'          // 工具管理
AGENT_STUDIO_CHANGES_VIEW_ID        = 'agentStudio.changesView'        // 变更追踪
AGENT_STUDIO_SEARCH_VIEW_ID         = 'agentStudio.searchView'         // 搜索
AGENT_STUDIO_PLUGINS_VIEW_ID        = 'agentStudio.pluginsView'        // 插件管理
AGENT_STUDIO_PERSONAL_VIEW_ID       = 'agentStudio.personalView'       // 个人中心
AGENT_STUDIO_SETTINGS_VIEW_ID       = 'agentStudio.settingsView'       // 设置
AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID = 'agentStudio.healthMonitorView'  // 健康监控
AGENT_STUDIO_WORKSPACE_TEMPLATE_VIEW_ID = 'agentStudio.workspaceTemplateView' // 工作区模板
AGENT_STUDIO_CREW_TEAM_VIEW_ID      = 'agentStudio.crewTeamView'       // Crew/Team

// 主面板类型 (WebView 渲染选择)
type AgentStudioPanelType = 'canvas' | 'chat' | 'taskboard'

// 配置 Keys
AGENT_STUDIO_ENABLED_SETTING         = 'sessions.agentStudio.enabled'
AGENT_STUDIO_KNOT_TOKEN_SETTING      = 'sessions.agentStudio.knot.token'
AGENT_STUDIO_KNOT_AGENT_ID_SETTING   = 'sessions.agentStudio.knot.agentId'
AGENT_STUDIO_KNOT_BASE_URL_SETTING   = 'sessions.agentStudio.knot.baseUrl'
AGENT_STUDIO_KNOT_MODELS_SETTING     = 'sessions.agentStudio.knot.models'
AGENT_STUDIO_KNOT_USER_SETTING       = 'sessions.agentStudio.knot.user'
AGENT_STUDIO_DATA_PATH_SETTING       = 'sessions.agentStudio.dataPath'
```

### D.6 设计 vs 实现差异摘要

| 维度 | 设计文档描述 | 实际实现 | 差异说明 |
|------|-------------|----------|----------|
| **Driver 组件** | 9个独立文件在 `browser/driver/` | 逻辑内联于 agentDriverService.ts | Phase 2 重构时拆分 |
| **Pipeline 动态构建** | 3种预置管线 (SIMPLE_CHAT/FULL_AGENT/RAG) | 固定4步编排 | Phase 2 实现 PipelineBuilder |
| **Provider 部署** | 全部为外部 extensions/ 插件 | 内置实现在 browser/providers/ | Phase 0 先内置，后迁移 |
| **IChatStreamDelta** | 定义在 common/protocol.ts | 定义在 common/providers.ts + common/agentStudio.ts (重复) | 需统一，消除重复 |
| **Workspace Registry** | 独立服务 IWorkspaceRegistry | 未实现 | 当前单工作区模式 |
| **Memory Consolidation** | 5阶段后台流程 | 未实现 | Phase 5 |
| **Self-Upgrade** | 5种升级能力 | 未实现 | Phase 6 |
| **OS 执行入口** | 仅作注册中心，不含执行逻辑 | AgentOSService.executeAgentTurn() 含完整执行 | 实际 OS 承担了部分 Driver 职责 |
| **Model Fallback** | 文档未明确 | 3个备用模型列表 + 最大3次重试 | 实现超出设计 |
| **Agent 实例配置** | agent.yaml (YAML格式) | 实际写入 JSON 格式 | _createAgentConfig 写 JSON |

### D.7 待实现文件列表 (设计中但源码不存在)

```
❌ common/workspaceRegistry.ts        # IWorkspaceRegistry
❌ common/memoryConsolidation.ts       # IMemoryConsolidationService
❌ common/selfUpgrade.ts               # IAgentSelfUpgradeService
❌ common/taskDelegation.ts            # ITaskDelegationService (增强版)
❌ common/protocol.ts                  # 独立协议文件 (当前分散在多个文件)
❌ browser/driver/                     # Driver 9组件独立目录
❌ browser/workspaceRegistryService.ts
❌ browser/healthMonitorService.ts
❌ browser/agentCrewService.ts
❌ browser/memoryConsolidationService.ts
❌ browser/selfUpgradeService.ts
❌ browser/taskDelegationService.ts
❌ browser/modelSelectorService.ts
```

---

> **文档维护说明**: 本文档为 Sarosis Agents Client 架构设计的权威参考。如有更新请同步修改版本号并记录变更。
> 
> **变更记录**:
> - v1.0 (2026-05-11): 初版，设计定稿
> - v1.1 (2026-05-11): 源码审查后补充实现状态，新增附录 D，更新目录结构，新增 §6.9-6.11
