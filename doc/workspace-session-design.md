# Workspace Session 设计框架

## 1. 概述

### 1.1 核心概念

本设计引入 **Workspace Root / Fork** 模型来管理定时任务场景下的多 Session 需求：

```
┌─────────────────────────────────────────────────────────────────┐
│                      Workspace (Root)                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  画布: Agent A ─── Agent B ─── Agent C                   │   │
│  │  模式: 可编辑 (创建/删除Agent, 修改模型/Provider/Skill)  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  workspace_sessions/                                            │
│  ├── workspace_session_task001/   ← 定时任务 #1 的 Fork        │
│  │   ├── session_index.json       ← 所有 Agent 实例的 Session  │
│  │   │   ├── agent_a → session_xxx                              │
│  │   │   ├── agent_b → session_yyy                              │
│  │   │   └── agent_c → session_zzz                              │
│  │   └── metadata.json            ← Fork 元数据(任务ID/时间等) │
│  │                                                              │
│  ├── workspace_session_task002/   ← 定时任务 #2 的 Fork        │
│  │   ├── session_index.json                                     │
│  │   └── metadata.json                                          │
│  │                                                              │
│  └── workspace_session_manual001/ ← 手动创建的 Fork            │
│      ├── session_index.json                                     │
│      └── metadata.json                                          │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 关键设计原则

| 原则 | 说明 |
|------|------|
| **Root 唯一可编辑** | 只有 Root 模式下可以创建/删除 Agent、修改 Agent 配置（模型、Provider、Skill 等） |
| **Fork 只读画布** | Fork 模式下画布不可编辑，Agent 实例冻结在创建 Fork 时的快照状态 |
| **Fork 独立 Session** | 每个 Fork 为所有 Agent 实例创建一组全新的独立 Session |
| **整体切换** | 切换 Workspace Session 时，画布上所有 Agent 的 Session 同时切换 |
| **定时任务驱动** | 每次定时任务启动自动创建一个新 Fork，基于当前 Workspace 的所有 Agent |

---

## 2. 类型定义

### 2.1 新增核心类型 (`agentStudioTypes.ts`)

```typescript
// ─── Workspace Session (Fork) ───────────────────────────────────────────────

/**
 * Workspace 模式
 * - root: 原始工作区，画布可编辑
 * - fork: 定时任务/手动创建的分支，画布只读
 */
export const enum WorkspaceMode {
    Root = 'root',
    Fork = 'fork',
}

/**
 * Fork 的来源
 */
export const enum WorkspaceSessionSource {
    /** 定时任务自动创建 */
    ScheduledTask = 'scheduled_task',
    /** 用户手动创建 */
    Manual = 'manual',
}

/**
 * Fork 的运行状态
 */
export const enum WorkspaceSessionStatus {
    /** 已创建，等待执行 */
    Pending = 'pending',
    /** 正在运行中 */
    Running = 'running',
    /** 已完成 */
    Completed = 'completed',
    /** 执行出错 */
    Error = 'error',
    /** 已归档 */
    Archived = 'archived',
}

/**
 * Agent 在某个 Fork 中的 Session 记录
 */
export interface AgentSessionEntry {
    /** Agent 实例 ID (对应 Employee.id) */
    readonly agentId: string;
    /** 该 Agent 在此 Fork 中的 Session ID */
    readonly sessionId: string;
    /** Session 创建时间 */
    readonly createdAt: string;
    /** Session 最后活跃时间 */
    updatedAt: string;
    /** Session 内消息数 */
    messageCount: number;
    /** Session 状态 */
    status: 'active' | 'idle' | 'completed' | 'error';
}

/**
 * Workspace Session — 一个 Workspace 的 Fork 实例
 * 每个定时任务创建一个 Fork，包含所有 Agent 的独立 Session
 */
export interface WorkspaceSession {
    /** 唯一 ID，格式: workspace_session_{shortId} */
    readonly id: string;
    /** 所属 Workspace ID */
    readonly workspaceId: string;
    /** 显示名称 (如 "定时任务 #3 - 2026-05-17") */
    name: string;
    /** Fork 来源 */
    source: WorkspaceSessionSource;
    /** 关联的定时任务 ID (如果 source=ScheduledTask) */
    scheduledTaskId?: string;
    /** Fork 运行状态 */
    status: WorkspaceSessionStatus;
    /** 所有 Agent 实例的 Session 索引 */
    agentSessions: AgentSessionEntry[];
    /**
     * Fork 时刻的 Agent 快照 ID 列表
     * 记录 Fork 创建时 Workspace 中有哪些 Agent，
     * 即使后续 Root 新增/删除了 Agent，Fork 仍保持不变
     */
    readonly snapshotAgentIds: string[];
    /** 创建时间 */
    readonly createdAt: string;
    /** 最后更新时间 */
    updatedAt: string;
    /** 完成时间 */
    completedAt?: string;
    /** 错误信息 */
    error?: string;
}

/**
 * 扩展 Workspace 类型，增加 Root/Fork 概念
 */
export interface WorkspaceRootInfo {
    /** 当前活跃的 Session (Fork) ID，null 表示在 Root 模式 */
    activeSessionId: string | null;
    /** 当前模式 */
    mode: WorkspaceMode;
}
```

### 2.2 扩展现有 Workspace 类型

```typescript
// 在现有 Workspace 接口中扩展：
export interface Workspace {
    readonly id: string;
    name: string;
    description?: string;
    path?: string;
    employees: string[];
    connections: Connection[];
    layout?: WorkspaceLayout;
    createdAt: string;
    updatedAt: string;

    // ─── 新增字段 ───
    /** Root/Fork 管理信息 */
    rootInfo?: WorkspaceRootInfo;
}
```

### 2.3 扩展 ChatMessage 类型

```typescript
// 强化 sessionId 为 Fork 场景下的必需关联
export interface ChatMessage {
    readonly id: string;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: string;
    employeeId: string;
    /** Workspace Session (Fork) ID — Fork 模式下所有消息都关联到此 */
    sessionId?: string;
    /** Workspace Session 内的 Agent Session ID */
    agentSessionId?: string;
    toolCalls?: ToolCall[];
    thinking?: string;
    timestamp: string;
    tokenUsage?: { input: number; output: number; total: number };
}
```

---

## 3. Store 设计

### 3.1 新增 `useWorkspaceSessionStore` (Zustand)

```typescript
// store/useWorkspaceSessionStore.ts

interface WorkspaceSessionState {
    /** 当前 Workspace 下所有 Fork Session 列表 */
    sessions: WorkspaceSession[];
    /** 当前活跃的 Session ID，null = Root 模式 */
    activeSessionId: string | null;
    /** 当前模式 (派生自 activeSessionId) */
    mode: WorkspaceMode; // computed: activeSessionId ? 'fork' : 'root'
    /** 加载状态 */
    isLoading: boolean;

    // ─── Actions ───

    /** 加载指定 Workspace 下的所有 Session */
    loadSessions: (workspaceId: string) => Promise<void>;

    /**
     * 创建新 Fork
     * - 为所有 Agent 生成新 Session
     * - 返回新创建的 WorkspaceSession
     */
    createFork: (params: {
        workspaceId: string;
        name: string;
        source: WorkspaceSessionSource;
        scheduledTaskId?: string;
    }) => Promise<WorkspaceSession | null>;

    /**
     * 切换到指定 Session (Fork)
     * - 切换模式为 Fork
     * - 画布变为只读
     * - 所有 Agent 的 Chat 切换到对应 Session
     */
    switchToSession: (sessionId: string) => Promise<void>;

    /**
     * 切换回 Root 模式
     * - 画布恢复可编辑
     * - 所有 Agent 的 Chat 切换回默认 Session
     */
    switchToRoot: () => Promise<void>;

    /** 更新 Fork 状态 */
    updateSessionStatus: (
        sessionId: string,
        status: WorkspaceSessionStatus,
        error?: string
    ) => Promise<void>;

    /** 删除 Fork */
    deleteSession: (sessionId: string) => Promise<void>;

    /** 归档 Fork */
    archiveSession: (sessionId: string) => Promise<void>;

    // ─── Agent Session 管理 ───

    /** 获取当前活跃 Fork 中指定 Agent 的 Session ID */
    getAgentSessionId: (agentId: string) => string | null;

    /** 获取当前活跃 Fork 中所有 Agent 的 Session 索引 */
    getActiveAgentSessions: () => AgentSessionEntry[];
}
```

### 3.2 修改 `useChatStore` — Session 感知

```typescript
// 核心变更：loadHistory 和 sendMessage 增加 Session 上下文

interface ChatState {
    messages: ChatMessage[];
    streamState: StreamState;
    inputValue: string;
    isLoading: boolean;
    activeEmployeeId: string | null;

    // ─── 新增 ───
    /** 当前 Fork 中 active Agent 的 Session ID */
    activeAgentSessionId: string | null;

    // Actions (修改)
    setActiveEmployee: (employeeId: string) => void;  // 内部自动解析 agentSessionId
    loadHistory: (employeeId: string, agentSessionId?: string) => Promise<void>;
    sendMessage: (message: string) => Promise<void>;  // 自动携带 agentSessionId
    cancelStream: () => void;
    setInputValue: (value: string) => void;
    clearMessages: () => void;
}
```

**关键修改逻辑：**

```typescript
// setActiveEmployee 时自动获取 Fork Session
setActiveEmployee: (employeeId: string) => {
    const sessionStore = useWorkspaceSessionStore.getState();
    const agentSessionId = sessionStore.getAgentSessionId(employeeId);

    resetStream();
    set({
        activeEmployeeId: employeeId,
        activeAgentSessionId: agentSessionId,
        messages: [],
        inputValue: '',
    });
    get().loadHistory(employeeId, agentSessionId ?? undefined);
},

// loadHistory 增加 sessionId 参数
loadHistory: async (employeeId: string, agentSessionId?: string) => {
    set({ isLoading: true });
    try {
        const messages = await sendRequest<
            { employeeId: string; sessionId?: string },
            ChatMessage[]
        >('chat.history', { employeeId, sessionId: agentSessionId });
        set({ messages: messages || [], isLoading: false });
    } catch (err) {
        set({ isLoading: false });
    }
},

// sendMessage 自动携带 session 上下文
sendMessage: async (message: string) => {
    const { activeEmployeeId, activeAgentSessionId } = get();
    if (!activeEmployeeId) return;

    await sendRequest('chat.send', {
        employeeId: activeEmployeeId,
        message,
        sessionId: activeAgentSessionId, // Fork 内的 Agent Session
    });
},
```

### 3.3 修改 `useWorkspaceStore` — 模式感知

```typescript
interface WorkspaceState {
    // ... 现有字段 ...

    // ─── 新增 ───
    /** 当前是否为 Fork 只读模式 */
    isReadOnly: boolean;

    // Actions (修改)
    setActiveWorkspace: (id: string) => Promise<void>;
    setReadOnly: (readOnly: boolean) => void;
}
```

### 3.4 修改 `useEmployeeStore` — 只读保护

```typescript
// 在 mutation 操作中检查只读模式
createEmployee: async (data) => {
    const { isReadOnly } = useWorkspaceStore.getState();
    if (isReadOnly) {
        console.warn('[EmployeeStore] Cannot create employee in Fork (read-only) mode');
        throw new Error('Fork 模式下不可创建 Agent');
    }
    // ... 原有逻辑 ...
},

updateEmployee: async (id, data) => {
    const { isReadOnly } = useWorkspaceStore.getState();
    if (isReadOnly) {
        throw new Error('Fork 模式下不可修改 Agent 配置');
    }
    // ... 原有逻辑 ...
},

deleteEmployee: async (id) => {
    const { isReadOnly } = useWorkspaceStore.getState();
    if (isReadOnly) {
        throw new Error('Fork 模式下不可删除 Agent');
    }
    // ... 原有逻辑 ...
},
```

---

## 4. Session 切换流程

### 4.1 切换到 Fork 模式

```
用户点击 Fork Session / 定时任务自动创建
           │
           ▼
┌─ workspaceSessionStore.switchToSession(sessionId) ──────┐
│  1. 设置 activeSessionId = sessionId                     │
│  2. 设置 mode = 'fork'                                   │
│                                                          │
│  3. 通知 workspaceStore.setReadOnly(true)               │
│     → 画布: nodesDraggable=true, 但禁用创建/删除/编辑   │
│     → 隐藏 "添加 Agent" 按钮                            │
│     → Agent 节点右键菜单隐藏编辑/删除选项               │
│                                                          │
│  4. 获取 Fork 的 agentSessions 索引                      │
│                                                          │
│  5. 如果当前有 selectedEmployee:                         │
│     → chatStore.setActiveEmployee(selectedId)            │
│       内部自动找到对应的 agentSessionId                  │
│       → loadHistory(selectedId, agentSessionId)          │
│                                                          │
│  6. 发送事件: workspace.sessionChanged                    │
│     → 所有监听者同步切换上下文                          │
└──────────────────────────────────────────────────────────┘
```

### 4.2 切换回 Root 模式

```
用户点击 "Root" / "主工作区"
           │
           ▼
┌─ workspaceSessionStore.switchToRoot() ──────────────────┐
│  1. 设置 activeSessionId = null                          │
│  2. 设置 mode = 'root'                                   │
│                                                          │
│  3. 通知 workspaceStore.setReadOnly(false)              │
│     → 画布恢复完整编辑能力                              │
│                                                          │
│  4. 如果当前有 selectedEmployee:                         │
│     → chatStore.setActiveEmployee(selectedId)            │
│       agentSessionId = null (Root 的默认 Session)       │
│       → loadHistory(selectedId, undefined)               │
│                                                          │
│  5. 发送事件: workspace.sessionChanged                    │
└──────────────────────────────────────────────────────────┘
```

### 4.3 定时任务创建 Fork 流程

```
定时任务触发 (ScheduledTask)
           │
           ▼
┌─ Host: onScheduledTaskStart(taskId, workspaceId) ───────┐
│  1. 读取 Workspace 的所有 Agent 实例                     │
│     agents = await getEmployees(workspaceId)             │
│                                                          │
│  2. 为每个 Agent 生成一个新 Session ID                   │
│     agentSessions = agents.map(a => ({                   │
│       agentId: a.id,                                     │
│       sessionId: generateId(),                           │
│       createdAt: now,                                    │
│       status: 'active',                                  │
│     }))                                                  │
│                                                          │
│  3. 创建 WorkspaceSession (Fork)                        │
│     fork = {                                             │
│       id: `workspace_session_${shortId}`,                │
│       workspaceId,                                       │
│       name: `定时任务 #${n} - ${date}`,                  │
│       source: 'scheduled_task',                          │
│       scheduledTaskId: taskId,                            │
│       status: 'running',                                 │
│       agentSessions,                                     │
│       snapshotAgentIds: agents.map(a => a.id),           │
│     }                                                    │
│                                                          │
│  4. 持久化到 workspace_sessions/ 目录                    │
│                                                          │
│  5. 通知 WebView: 'workspace.sessionCreated'             │
│     → 自动切换到新 Fork (如果用户正在观看)              │
│                                                          │
│  6. 开始执行定时任务逻辑...                              │
│     每个 Agent 的对话都写入对应的 agentSessionId         │
│                                                          │
│  7. 任务完成后更新 status = 'completed'                  │
└──────────────────────────────────────────────────────────┘
```

---

## 5. UI 交互设计

### 5.1 Session 切换器 (新增组件)

在 `WorkspaceToolbar` 或 `WorkspaceHeader` 中添加 Session 切换下拉：

```
┌──────────────────────────────────────────────────────────┐
│  🏠 My Workspace  ▾  │  📋 Root (可编辑)  ▾             │
│                       │  ┌─────────────────────────┐     │
│                       │  │ 🏠 Root (主工作区)    ✓ │     │
│                       │  │ ─────────────────────── │     │
│                       │  │ 🔄 定时任务 #3 - 05/17 │     │
│                       │  │ 🔄 定时任务 #2 - 05/16 │     │
│                       │  │ ✅ 定时任务 #1 - 05/15 │     │
│                       │  │ ─────────────────────── │     │
│                       │  │ ➕ 手动创建 Fork        │     │
│                       │  └─────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
```

### 5.2 Fork 只读模式 UI 指示

```
┌──────────────────────────────────────────────────────────┐
│  ⚠️ Fork 只读模式 — 定时任务 #3 (2026-05-17 08:00)     │
│  [返回 Root 编辑] [查看任务详情]                         │
├──────────────────────────────────────────────────────────┤
│  画布区域 (只读)                                         │
│  ┌────────┐    ┌────────┐    ┌────────┐                  │
│  │Agent A │───▶│Agent B │───▶│Agent C │                  │
│  │ 🤖     │    │ 🤖     │    │ 🤖     │                  │
│  └────────┘    └────────┘    └────────┘                  │
│                                                          │
│  ❌ "添加 Agent" 按钮隐藏                                │
│  ❌ 节点右键菜单: 编辑/删除 选项禁用                     │
│  ✅ 节点可点击查看 Chat (Fork 内的 Session)             │
│  ✅ 节点可拖动 (仅视觉调整，不持久化)                   │
└──────────────────────────────────────────────────────────┘
```

### 5.3 WorkspaceCanvas 修改

```tsx
// WorkspaceCanvas.tsx — 关键变更
export function WorkspaceCanvas(): React.ReactElement {
    const { isReadOnly } = useWorkspaceStore();
    const { mode, activeSessionId } = useWorkspaceSessionStore();

    return (
        <div className="canvas-container">
            {/* Fork 只读模式横幅 */}
            {mode === 'fork' && (
                <ForkReadOnlyBanner
                    sessionId={activeSessionId}
                    onSwitchToRoot={() => switchToRoot()}
                />
            )}

            {displayMode === 'canvas' && (
                <div className="canvas-flow-area" ref={reactFlowWrapper}>
                    {/* 条件隐藏 "添加 Agent" 按钮 */}
                    {!isReadOnly && (
                        <button onClick={() => setShowCreateModal(true)}>
                            添加 Agent
                        </button>
                    )}

                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        nodesDraggable={true}         // 仍可拖动查看
                        nodesConnectable={!isReadOnly} // Fork 中不可新建连接
                        elementsSelectable={true}
                        // ... 其余不变
                    >
                        {/* ... */}
                    </ReactFlow>
                </div>
            )}
        </div>
    );
}
```

---

## 6. 通信协议扩展

### 6.1 新增 Request 类型 (`messageProtocol.ts`)

```typescript
export type RequestType =
    // ... 现有类型 ...
    | 'workspaceSession.list'       // 列出 Workspace 下所有 Fork
    | 'workspaceSession.get'        // 获取单个 Fork 详情
    | 'workspaceSession.create'     // 创建 Fork (手动)
    | 'workspaceSession.delete'     // 删除 Fork
    | 'workspaceSession.archive'    // 归档 Fork
    | 'workspaceSession.switch'     // 切换到指定 Fork
    | 'workspaceSession.switchRoot' // 切回 Root
    | 'workspaceSession.updateStatus'; // 更新 Fork 状态
```

### 6.2 新增 Event 类型

```typescript
export type EventType =
    // ... 现有类型 ...
    | 'workspace.sessionCreated'    // 新 Fork 创建 (定时任务自动触发)
    | 'workspace.sessionChanged'    // 当前活跃 Session 切换
    | 'workspace.sessionUpdated'    // Fork 状态/数据更新
    | 'workspace.modeChanged';      // Root/Fork 模式切换
```

### 6.3 新增 Payload 接口

```typescript
export interface IWorkspaceSessionCreatePayload {
    readonly workspaceId: string;
    readonly name: string;
    readonly source: 'scheduled_task' | 'manual';
    readonly scheduledTaskId?: string;
}

export interface IWorkspaceSessionSwitchPayload {
    readonly sessionId: string;
}

export interface IWorkspaceSessionStatusPayload {
    readonly sessionId: string;
    readonly status: string;
    readonly error?: string;
}
```

---

## 7. 数据存储结构

### 7.1 磁盘文件布局

```
.sarosworkspace/
├── workspaces.json              ← Workspace 列表 (扩展 rootInfo 字段)
├── employees.json               ← Agent 实例列表 (Root 数据)
├── sessions.json                ← 全局 Session 索引 (旧, 可废弃)
├── agents/                      ← Agent 实例目录
│   ├── agent-a/
│   │   ├── agent.yaml
│   │   ├── AGENTS.md
│   │   ├── SOUL.md
│   │   └── sessions/            ← 每个 Agent 的 Session 数据
│   │       ├── default/          ← Root 模式的默认 Session
│   │       │   └── history.json
│   │       ├── {agentSessionId1}/ ← Fork #1 中的 Session
│   │       │   └── history.json
│   │       └── {agentSessionId2}/ ← Fork #2 中的 Session
│   │           └── history.json
│   ├── agent-b/
│   │   └── ...
│   └── agent-c/
│       └── ...
│
└── workspace_sessions/          ← ★ 新增: Fork 管理目录
    ├── workspace_session_task001/
    │   ├── metadata.json        ← Fork 元数据
    │   └── session_index.json   ← Agent → Session 映射
    ├── workspace_session_task002/
    │   ├── metadata.json
    │   └── session_index.json
    └── workspace_session_manual001/
        ├── metadata.json
        └── session_index.json
```

### 7.2 文件格式示例

**`workspace_sessions/workspace_session_task001/metadata.json`**
```json
{
    "id": "workspace_session_task001",
    "workspaceId": "ws_main",
    "name": "定时任务 #1 — 2026-05-17 08:00",
    "source": "scheduled_task",
    "scheduledTaskId": "sched_abc123",
    "status": "completed",
    "snapshotAgentIds": ["agent-a", "agent-b", "agent-c"],
    "createdAt": "2026-05-17T08:00:00.000Z",
    "updatedAt": "2026-05-17T08:45:00.000Z",
    "completedAt": "2026-05-17T08:45:00.000Z"
}
```

**`workspace_sessions/workspace_session_task001/session_index.json`**
```json
{
    "sessionId": "workspace_session_task001",
    "agentSessions": [
        {
            "agentId": "agent-a",
            "sessionId": "sess_a_001",
            "createdAt": "2026-05-17T08:00:00.000Z",
            "updatedAt": "2026-05-17T08:30:00.000Z",
            "messageCount": 12,
            "status": "completed"
        },
        {
            "agentId": "agent-b",
            "sessionId": "sess_b_001",
            "createdAt": "2026-05-17T08:00:00.000Z",
            "updatedAt": "2026-05-17T08:45:00.000Z",
            "messageCount": 8,
            "status": "completed"
        },
        {
            "agentId": "agent-c",
            "sessionId": "sess_c_001",
            "createdAt": "2026-05-17T08:00:00.000Z",
            "updatedAt": "2026-05-17T08:20:00.000Z",
            "messageCount": 5,
            "status": "completed"
        }
    ]
}
```

---

## 8. Host 端服务扩展

### 8.1 新增 `IWorkspaceSessionService`

```typescript
// common/agentStudioService.ts

export const IWorkspaceSessionService =
    createDecorator<IWorkspaceSessionService>('workspaceSessionService');

export interface IWorkspaceSessionService {
    readonly _serviceBrand: undefined;

    readonly onDidChangeWorkspaceSessions: Event<string>; // workspaceId

    // CRUD
    getSessions(workspaceId: string): Promise<WorkspaceSession[]>;
    getSession(sessionId: string): Promise<WorkspaceSession | undefined>;
    createSession(params: {
        workspaceId: string;
        name: string;
        source: WorkspaceSessionSource;
        scheduledTaskId?: string;
    }): Promise<WorkspaceSession>;
    deleteSession(sessionId: string): Promise<void>;
    archiveSession(sessionId: string): Promise<void>;
    updateSessionStatus(
        sessionId: string,
        status: WorkspaceSessionStatus,
        error?: string
    ): Promise<void>;

    // Session 切换
    getActiveSession(workspaceId: string): Promise<WorkspaceSession | null>;
    setActiveSession(workspaceId: string, sessionId: string | null): Promise<void>;

    // Agent Session 查询
    getAgentSessionId(sessionId: string, agentId: string): Promise<string | null>;
    getAgentSessions(sessionId: string): Promise<AgentSessionEntry[]>;
    updateAgentSession(
        sessionId: string,
        agentId: string,
        data: Partial<AgentSessionEntry>
    ): Promise<void>;
}
```

### 8.2 `AgentStudioService` 修改

```typescript
// browser/agentStudioService.ts — 关键扩展

class AgentStudioService implements IAgentStudioService {
    // 现有 CRUD 方法保持不变

    // 扩展 chat.history 支持 sessionId 路由
    // → AgentChatService.getHistory(employeeId, sessionId?)
    //   如果 sessionId 存在，从 agents/{slug}/sessions/{sessionId}/history.json 读取
    //   如果 sessionId 为空，从 agents/{slug}/sessions/default/history.json 读取
}
```

### 8.3 `WebviewController` 路由扩展

```typescript
// browser/agentStudioWebviewController.ts

// 新增消息路由:
case 'workspaceSession.list':
    return this._sessionService.getSessions(payload.workspaceId);
case 'workspaceSession.get':
    return this._sessionService.getSession(payload.sessionId);
case 'workspaceSession.create':
    return this._sessionService.createSession(payload);
case 'workspaceSession.delete':
    return this._sessionService.deleteSession(payload.sessionId);
case 'workspaceSession.switch':
    return this._handleSessionSwitch(payload.sessionId);
case 'workspaceSession.switchRoot':
    return this._handleSwitchToRoot(payload.workspaceId);
```

---

## 9. Store 交互关系图

```
┌──────────────────────────────────────────────────────────────────┐
│                    Zustand Store 交互                             │
│                                                                  │
│  ┌───────────────────────┐                                       │
│  │useWorkspaceSessionStore│ ← ★ 新增                             │
│  │  - sessions[]          │                                       │
│  │  - activeSessionId     │                                       │
│  │  - mode (root/fork)    │                                       │
│  └─────────┬─────────────┘                                       │
│            │ switchToSession() / switchToRoot()                   │
│            │                                                      │
│            ├──────────────────────────┐                           │
│            ▼                          ▼                           │
│  ┌─────────────────┐       ┌──────────────────┐                  │
│  │useWorkspaceStore │       │ useChatStore      │                  │
│  │  + isReadOnly    │       │  + agentSessionId │                  │
│  │                  │       │                    │                  │
│  │ setReadOnly() ←──┘      │ loadHistory() 增加 │                  │
│  │                  │       │   sessionId 参数   │                  │
│  └────────┬─────────┘       │                    │                  │
│           │                 │ sendMessage() 携带 │                  │
│           ▼                 │   agentSessionId  │                  │
│  ┌─────────────────┐       └──────────────────┘                  │
│  │useEmployeeStore  │                                             │
│  │  + 只读保护       │  ← create/update/delete                   │
│  │    if isReadOnly  │     throw Error in Fork mode              │
│  └──────────────────┘                                            │
│                                                                  │
│  ┌──────────────────┐  ┌───────────────────┐                     │
│  │useDelegationStore │  │useTaskBoardStore   │                    │
│  │  (暂不受影响)     │  │  (暂不受影响)      │                    │
│  └──────────────────┘  └───────────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 10. 实施计划

### Phase 1: 基础类型与存储 (后端)
1. 扩展 `agentStudioTypes.ts` — 添加 `WorkspaceSession`, `AgentSessionEntry`, `WorkspaceMode` 等类型
2. 新增 `IWorkspaceSessionService` 接口
3. 实现 `WorkspaceSessionService` — 文件系统读写 `workspace_sessions/` 目录
4. 修改 `AgentChatService.getHistory()` — 支持 `sessionId` 路由到不同 Session 目录
5. 扩展 `messageProtocol.ts` — 添加 `workspaceSession.*` 请求和事件类型
6. 扩展 `agentStudioWebviewController.ts` — 路由新协议消息

### Phase 2: WebView Store 层
7. 新建 `useWorkspaceSessionStore.ts`
8. 修改 `useChatStore.ts` — 增加 `activeAgentSessionId`, 修改 `loadHistory`/`sendMessage`
9. 修改 `useWorkspaceStore.ts` — 增加 `isReadOnly` 字段
10. 修改 `useEmployeeStore.ts` — mutation 操作增加只读保护

### Phase 3: UI 组件层
11. 新建 `SessionSwitcher` 组件 — Session/Fork 选择下拉
12. 新建 `ForkReadOnlyBanner` 组件 — Fork 模式提示横幅
13. 修改 `WorkspaceCanvas.tsx` — 条件隐藏编辑控件
14. 修改 `EmployeeNode.tsx` — 条件禁用右键菜单
15. 修改 `WorkspaceToolbar.tsx` — 集成 Session 切换器
16. 修改 `CreateAgentModal.tsx` — Fork 模式下不可打开

### Phase 4: 定时任务集成
17. 实现定时任务触发 → 自动创建 Fork 的钩子
18. Fork 内 Agent 执行逻辑 — 每个 Agent 使用独立 Session 收发消息
19. Fork 完成后自动更新状态
20. Fork Session 的查看/回放 UI

---

## 11. 边界情况处理

| 场景 | 处理方式 |
|------|----------|
| Fork 创建后 Root 新增了 Agent | Fork 的 `snapshotAgentIds` 不变，新 Agent 不出现在 Fork 画布中 |
| Fork 创建后 Root 删除了 Agent | Fork 中仍保留该 Agent 的 Session 数据，可查看历史记录 |
| Fork 创建后 Root 修改了 Agent 模型 | Fork 中 Agent 配置保持创建时的快照，不受影响 |
| 用户在 Fork 模式下尝试编辑 | 前端 Store 拦截 + UI 禁用，双重保护 |
| 定时任务并发触发 | 每次触发创建独立 Fork，互不影响 |
| 切换 Fork 时有正在进行的对话 | 先 cancel 当前 stream，再切换 Session |
| Fork 中 Agent 执行出错 | 更新对应 `AgentSessionEntry.status = 'error'`，Fork 状态为 `error` |
| 大量 Fork 堆积 | 提供归档/删除功能，可设定自动清理策略 |

---

## 12. 后续扩展

- **Fork Diff**: 对比不同 Fork 中同一 Agent 的对话差异
- **Fork 回放**: 时间线回放 Fork 内所有 Agent 的执行过程
- **Fork 模板**: 保存 Fork 配置为模板，支持快速重建
- **Fork 权限**: 多用户场景下 Fork 的读写权限控制
- **Agent 快照深拷贝**: Fork 时不仅记录 Agent ID，还拷贝完整配置快照
