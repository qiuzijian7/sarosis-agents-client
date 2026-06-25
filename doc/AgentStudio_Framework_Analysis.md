# Agent Studio 框架分析文档

> **文档版本**: v1.0  
> **生成时间**: 2026-05-11  
> **项目**: saros-agents-client (基于 VS Code 的 Agent Studio)

---

## 目录

1. [项目概述](#1-项目概述)
2. [架构设计](#2-架构设计)
3. [核心模块](#3-核心模块)
4. [服务层设计](#4-服务层设计)
5. [布局系统](#5-布局系统)
6. [WebView 设计](#6-webview-设计)
7. [数据流](#7-数据流)
8. [扩展点](#8-扩展点)
9. [文件结构](#9-文件结构)

---

## 1. 项目概述

### 1.1 项目定位

Agent Studio 是一个基于 **VS Code Workbench** 的 AI Agent 管理与协作平台，提供：

- **员工管理**：创建、配置 AI Agent（员工）
- **工作区管理**：组织多个员工到工作区
- **任务委派**：将任务委派给单个或多个员工
- **实时聊天**：与员工进行流式对话
- **任务看板**：可视化任务执行状态

### 1.2 技术栈

| 层级 | 技术 |
|------|------|
| 宿主环境 | VS Code Workbench (Custom) |
| 前端框架 | React + TypeScript (WebView) |
| 状态管理 | Zustand |
| 画布渲染 | ReactFlow (@xyflow/react) |
| 样式方案 | CSS Variables (VS Code Theme) |
| 通信协议 | postMessage JSON-RPC |

---

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    VS Code Workbench (Agent Sessions)               │
├─────────────────────────────────────────────────────────────────────┤
│  Titlebar (自定义)                                                │
├────────────┬──────────────────────────┬────────────────────────────┤
│  Sidebar   │   Editor Left (Files)   │   Editor Right (Agent Studio) │
│            │                          │                              │
│  [工具图标] │  ┌─────────────────┐    │  ┌─ Agent Chat ──────────┐  │
│  + 内容面板 │  │  file1.ts       │    │  │  (Tab)                 │  │
│            │  │  file2.ts       │    │  └────────────────────────┘  │
│  ┌────────┐ │  │  ...           │    │  [Chat] [TaskBoard] [Canvas] │
│  │ Sessions│ │  └─────────────────┘    │                             │
│  │ Changes │ │                          │                             │
│  │  ...   │ │                          │                             │
│  └────────┘ │                          │                             │
├────────────┴──────────────────────────┴────────────────────────────┤
│  Auxiliary Bar (可选) - 终端 / 调试                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│                    表示层 (Presentation)                    │
│  TitlebarPart / SidebarPart / AgentStudioEditorPane         │
├──────────────────────────────────────────────────────────────┤
│                    服务层 (Services)                        │
│  AgentStudioService / AgentChatService / AgentDelegation... │
├──────────────────────────────────────────────────────────────┤
│                    数据层 (Data)                            │
│  FileService (.agent-studio/data/*.json)                   │
├──────────────────────────────────────────────────────────────┤
│                  WebView 层 (Isolated)                     │
│  App.tsx → Stores → Components → Bridge → postMessage      │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. 核心模块

### 3.1 模块清单

| 模块 | 路径 | 职责 |
|------|------|------|
| Agent Studio Service | `browser/agentStudioService.ts` | 核心数据 CRUD |
| Agent Chat Service | `browser/agentChatService.ts` | 聊天流式输出 |
| Agent Delegation Service | `browser/agentDelegationService.ts` | 任务委派管理 |
| Agent Instance Service | `browser/agentInstanceService.ts` | 员工实例管理 |
| Workspace Registry | `browser/workspaceRegistryService.ts` | 工作区注册表 |
| Slot Registry | `browser/slotRegistry.ts` | 插槽注册表 |
| Planning Provider | `browser/providers/planningProvider.ts` | 规划提供者 |
| Execution Provider | `browser/providers/executionProvider.ts` | 执行提供者 |
| WebView Controller | `browser/agentStudioWebviewController.ts` | WebView 控制器 |

### 3.2 类型定义 (`common/types.ts`)

```typescript
// 员工
interface Employee {
  id: string;
  name: string;
  role: 'engineer' | 'analyst' | 'reviewer' | 'custom';
  email?: string;
  avatar?: string;
  presetId?: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  workspaceId: string;
  status: EmployeeStatus;
  position?: { x: number; y: number };
  createdAt: string;
  updatedAt: string;
}

// 工作区
interface Workspace {
  id: string;
  name: string;
  description?: string;
  layout?: WorkspaceLayout;
  createdAt: string;
  updatedAt: string;
}

// 委派任务
interface Delegation {
  id: string;
  workspaceId: string;
  employeeId: string;
  task: string;
  status: DelegationStatus;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

// 任务看板记录
interface TaskBoardRecord {
  id: string;
  title: string;
  status: TaskBoardStatus;
  source: TaskSource;
  delegationId?: string;
  assignee?: string;
  createdAt: string;
  updatedAt: string;
}
```

---

## 4. 服务层设计

### 4.1 IAgentStudioService

**职责**：员工、工作区、连接、会话的 CRUD 操作

**数据存储**：`~/.agent-studio/data/` 目录下的 JSON 文件

| 方法 | 说明 |
|------|------|
| `getEmployees(workspaceId?)` | 获取员工列表 |
| `createEmployee(data)` | 创建员工 |
| `updateEmployee(id, data)` | 更新员工 |
| `deleteEmployee(id)` | 删除员工 |
| `getWorkspaces()` | 获取工作区列表 |
| `createWorkspace(data)` | 创建工作区 |
| `updateWorkspaceLayout(id, layout)` | 更新工作区布局 |
| `getConnections(workspaceId)` | 获取连接列表 |
| `addConnection(workspaceId, conn)` | 添加连接 |

**事件**：

```typescript
interface IAgentStudioService {
  readonly onDidChangeEmployees: Event<void>;
  readonly onDidChangeWorkspace: Event<string>;
  readonly onDidChangeSessions: Event<void>;
}
```

### 4.2 IAgentChatService

**职责**：与员工进行流式对话

```typescript
interface IAgentChatService {
  sendMessage(
    employeeId: string,
    message: string,
    options: IChatSendOptions,
    onDelta: (delta: IChatStreamDelta) => void
  ): Promise<ChatMessage>;
  
  getHistory(employeeId: string, sessionId?: string): Promise<ChatMessage[]>;
  clearHistory(employeeId: string, sessionId?: string): Promise<void>;
  cancelStream(employeeId: string): void;
}
```

**流式输出类型**：

```typescript
interface IChatStreamDelta {
  type: 'text' | 'thinking' | 'tool_start' | 'tool_args' 
      | 'tool_end' | 'tool_result' | 'tool_progress' | 'done' | 'error';
  content?: string;
  toolCallId?: string;
  toolName?: string;
  progress?: number;
  stage?: string;
}
```

### 4.3 IAgentDelegationService

**职责**：任务委派和自动规划

```typescript
interface IAgentDelegationService {
  getDelegations(workspaceId?: string): Promise<Delegation[]>;
  createDelegation(data: Partial<Delegation>): Promise<Delegation>;
  updateDelegationStatus(id: string, status: DelegationStatus): Promise<Delegation>;
  deleteDelegation(id: string): Promise<void>;
  
  // 自动规划：根据任务描述自动拆分并委派
  autoPlan(workspaceId: string, task: string): Promise<IAutoPlanResult>;
}
```

---

## 5. 布局系统

### 5.1 Agent Sessions Workbench 布局

Agent Sessions 使用**简化的固定布局**，不同于标准 VS Code 布局：

```
┌────────────────────────────────────────────────────────────────┐
│                       Titlebar (自定义)                         │
├──────────┬─────────────────────┬───────────────────────────────┤
│ Sidebar  │  Editor Left       │  Editor Right (Agent Studio)   │
│          │  (文件编辑器)       │                               │
│ [图标]   │                     │  ┌─ Chat ───────────────┐    │
│ + 内容   │  ┌─────────────┐   │  │                       │    │
│          │  │  file.ts     │   │  │  (聊天界面)           │    │
│ ┌──────┐ │  │  ...        │   │  │                       │    │
│ │Sessions│ │  └─────────────┘   │  └──────────────────────┘    │
│ │Changes │ │                     │  [Chat][TaskBoard][Canvas]   │
│ │ ...  │ │                     │  (不可关闭的 Sticky Tabs)    │
│ └──────┘ │                     │                               │
└──────────┴─────────────────────┴───────────────────────────────┘
```

### 5.2 布局特性

| 特性 | 说明 |
|------|------|
| 固定位置 | 不支持用户自定义位置 |
| Sidebar | 左侧，250px 默认宽度，可调整 170-450px |
| Editor | 分为两个固定组：左（文件）、右（Agent Studio） |
| 排除部件 | 无 Panel、无 AuxiliaryBar、无 StatusBar |
| Sticky Tabs | Agent Studio 的 Chat/TaskBoard/Canvas 不可关闭 |

### 5.3 网格结构

```
Orientation: VERTICAL (root)
├── Titlebar (leaf, size: titleBarHeight)
└── Main Row (branch, HORIZONTAL)
    ├── Sidebar (leaf, size: 250px)
    └── Editor (leaf, size: remaining)
        ├── Left Group (文件编辑器)
        └── Right Group (Agent Studio Panes)
```

---

## 6. WebView 设计

### 6.1 四区布局

Agent Studio 的 WebView 采用**四区布局**设计：

```
┌──────────────────────────────────────────────────────────────┐
│ ① Title Bar  [🏢 工作区下拉框 ▼] [+员工] [画布/列表] [刷新]  │
├──────────────────────────┬───────────────────────────────────┤
│ ② 工作画布 / 员工列表   │ ④ 员工聊天框                     │
│                          │                                   │
│   画布模式：ReactFlow     │   Header: 头像+名称+模型         │
│   列表模式：竖向员工卡片  │   Messages: 消息流               │
│                          │   Input: 输入框+发送             │
│   点击员工 → 右侧聊天    │                                   │
├──────────────────────────┴───────────────────────────────────┤
│ ③ 任务看板 (可折叠)                                         │
│   [待执行 ⓝ] [执行中 ⓝ] [执行结束 ⓝ] [取消执行 ⓝ] [归档 ⓝ] │
│   ┌────┐ ┌────┐ ┌────┐                                   │
│   │Card│ │Card│ │Card│  ← 可拖拽卡片                       │
│   └────┘ └────┘ └────┘                                   │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 区域详细说明

#### ① Title Bar (顶部工具栏)

| 功能 | 说明 |
|------|------|
| 工作区下拉选择器 | 切换当前活动工作区 |
| 员工计数 badge | 显示当前工作区的员工数量 |
| 添加员工按钮 | 创建新员工 |
| 视图模式切换 | 画布 ↔ 列表 |
| 刷新按钮 | 重新加载数据 |

#### ② 工作画布 (中左区域)

**两种模式**：

- **画布模式 (ReactFlow)**：
  - 员工渲染为节点（头像 + 姓名 + 角色 + 状态灯 + 模型标签）
  - SmoothStep 边表示 subagent 关系
  - 拖拽节点 → 持久化位置
  - 连接节点 → 创建 subagent 关系

- **列表模式**：
  - 垂直卡片列表
  - 每张卡片：头像 + 名称 + 角色 + 状态 + 模型

#### ③ 任务看板 (底部区域，可折叠)

| 列 | 状态键 | 图标 | 颜色 |
|----|--------|------|------|
| 待执行 | todo | 📋 | amber |
| 执行中 | running | ⚡ | blue |
| 执行结束 | done | ✅ | green |
| 取消执行 | cancelled | ⏹ | gray |
| 归档任务 | archived | 🗄 | purple |

**功能**：
- 横向滚动的 5 列布局
- 任务卡片支持拖拽状态变更（running 除外）
- 折叠/展开切换（节省空间）

#### ④ 员工聊天框 (中右区域)

**结构**：
- Header：头像 + 名称 + 角色 + 模型标签
- 消息列表：user/assistant 消息 + thinking block + tool calls
- 流式输出：SSE delta 增量渲染 + typing indicator
- 输入框：多行 textarea + 发送/停止按钮

### 6.3 通信协议

WebView ↔ VS Code Host 通过 **postMessage JSON-RPC** 通信：

**Request Types**：

```typescript
| 'workspace.list'
| 'workspace.create'
| 'workspace.update'
| 'employee.list'
| 'employee.create'
| 'employee.update'
| 'employee.delete'
| 'chat.send'
| 'chat.history'
| 'delegation.create'
| 'delegation.list'
| 'taskBoard.list'
| 'taskBoard.create'
| 'taskBoard.update'
| 'taskBoard.delete'
| 'taskBoard.archive'
```

**Event Types**：

```typescript
| 'workspace.changed'
| 'employee.changed'
| 'delegation.changed'
| 'taskBoard.changed'
| 'chat.message'
```

### 6.4 Store 层设计

| Store | 职责 |
|-------|------|
| `useWorkspaceStore` | 工作区列表、活动工作区、布局状态 |
| `useEmployeeStore` | 员工列表、选中员工、在线状态 |
| `useChatStore` | 消息列表、流式状态、输入值 |
| `useDelegationStore` | 委派列表、执行状态 |
| `useTaskBoardStore` | 任务列表、折叠状态、拖拽状态 |

---

## 7. 数据流

### 7.1 员工聊天数据流

```
User Input
    ↓
EmployeeChat.tsx (handleSend)
    ↓
useChatStore.sendMessage()
    ↓
bridge.sendRequest('chat.send', { employeeId, message })
    ↓
VS Code Host (AgentChatService)
    ↓
LLM API (流式输出)
    ↓
SSE Delta 回调 (onDelta)
    ↓
useChatStore.addMessageDelta()
    ↓
EmployeeChat.tsx re-render (流式显示)
    ↓
stream done
    ↓
useChatStore.finalizeMessage()
    ↓
bridge.sendNotification('chat.message', { message })
```

### 7.2 工作画布数据流

```
WorkspaceCanvas.tsx (ReactFlow)
    ↓
useWorkspaceStore (nodes, edges, viewport)
    ↓
useEmployeeStore (员工数据)
    ↓
onSelectEmployee → useChatStore.setActiveEmployee
    ↓
EmployeeChat.tsx 切换聊天目标
    ↓
节点拖拽 → useWorkspaceStore.updateNodePosition()
    ↓
持久化到 AgentStudioService
```

---

## 8. 扩展点

### 8.1 Provider 扩展

Agent Studio 支持通过 Provider 扩展功能：

| Provider | 接口 | 职责 |
|----------|------|------|
| PlanningProvider | `IPlanningProvider` | 任务规划和拆分 |
| ExecutionProvider | `IExecutionProvider` | 任务执行和监控 |
| ModelProvider | `IModelProvider` | 模型选择和管理 |
| GalleryProvider | `IGalleryProvider` | Agent 模板市场 |

### 8.2 Slot Registry (插槽注册表)

`SlotRegistry` 允许插件注册扩展点：

```typescript
// 注册插槽
SlotRegistry.registerSlot('agentStudio.toolbar', {
  description: 'Agent Studio 工具栏扩展点',
  allowedTypes: ['button', 'dropdown'],
});

// 注册到插槽
SlotRegistry.registerToSlot('agentStudio.toolbar', {
  id: 'my-custom-button',
  type: 'button',
  label: 'My Button',
  onClick: () => { /* ... */ },
});
```

### 8.3 WebView Bridge 扩展

通过 Bridge 添加新的 Request/Notification：

```typescript
// 在 messageClient.ts 中添加
export type RequestType =
  // ... 现有类型
  | 'myCustom.request';

export type NotificationType =
  // ... 现有类型
  | 'myCustom.notification';

// 在 VS Code Host 中处理
bridge.onRequest('myCustom.request', async (params) => {
  // 处理逻辑
  return result;
});
```

---

## 9. 文件结构

### 9.1 完整目录树

```
src/vs/sessions/contrib/agentStudio/
├── browser/                                # 浏览器端实现
│   ├── agentStudioService.ts              # 核心服务实现
│   ├── agentChatService.ts                # 聊天服务
│   ├── agentDelegationService.ts          # 委派服务
│   ├── agentInstanceService.ts            # 实例服务
│   ├── agentGalleryService.ts             # 模板市场服务
│   ├── agentOSService.ts                  # 操作系统服务
│   ├── agentSchedulerService.ts           # 调度服务
│   ├── agentStudioWebviewController.ts    # WebView 控制器
│   ├── agentStudio.contribution.ts        # 贡献点注册
│   ├── agentStudioEditorPane.ts           # Agent Studio 编辑器面板
│   ├── agentStudioEditorInput.ts          # 编辑器输入
│   ├── agentStudioProvider.ts             # Provider 基类
│   ├── agentStudioService.ts              # 服务基类
│   ├── agentStudioSidebarView.ts         # 侧边栏视图
│   ├── agentStudioToolbarView.ts          # 工具栏视图
│   ├── agentTaskBoardService.ts          # 任务看板服务
│   ├── agentYamlParser.ts                # YAML 解析器
│   ├── crewTeamService.ts                # CrewAI 团队服务
│   ├── delegationTreeView.ts             # 委派树视图
│   ├── gitCommitService.ts               # Git 提交服务
│   ├── healthMonitorPanel.ts             # 健康监控面板
│   ├── healthMonitorService.ts           # 健康监控服务
│   ├── knotModelProvider.ts              # Knot 模型提供者
│   ├── messageProtocol.ts                # 消息协议
│   ├── modelSelectorService.ts           # 模型选择器
│   ├── slotRegistry.ts                   # 插槽注册表
│   ├── workspaceRegistryService.ts       # 工作区注册表
│   ├── workspaceTemplateService.ts       # 工作区模板服务
│   ├── providers/                        # 提供者实现
│   │   ├── planning/                     # 规划提供者
│   │   │   ├── planningProvider.ts
│   │   │   └── planningProviderService.ts
│   │   ├── execution/                    # 执行提供者
│   │   │   ├── executionProvider.ts
│   │   │   └── executionProviderService.ts
│   │   ├── model/                        # 模型提供者
│   │   └── gallery/                      # 模板市场提供者
│   ├── views/                            # 视图实现
│   │   ├── agentStudioViewPane.ts
│   │   └── ...
│   └── media/                            # 样式文件
│       └── agentStudio.css
├── common/                                # 通用定义
│   ├── adapters.ts                        # 适配器
│   ├── agentDriver.ts                     # Agent 驱动
│   ├── agentInstance.ts                   # Agent 实例
│   ├── agentOS.ts                         # 操作系统抽象
│   ├── agentScheduler.ts                  # 调度器
│   ├── agentStudio.ts                     # 核心接口定义
│   ├── agentWorkspace.ts                  # 工作区抽象
│   ├── constants.ts                       # 常量定义
│   ├── contextManager.ts                 # 上下文管理器
│   ├── crewTeam.ts                       # CrewAI 团队
│   ├── cronParser.ts                     # Cron 解析器
│   ├── errors.ts                         # 错误定义
│   ├── eventBridge.ts                    # 事件桥接
│   ├── healthMonitor.ts                  # 健康监控
│   ├── iterationBudget.ts                # 迭代预算
│   ├── modelSelector.ts                  # 模型选择器
│   ├── parallelToolExecutor.ts           # 并行工具执行器
│   ├── providers.ts                      # Provider 接口
│   ├── subAgentManager.ts                # Sub-Agent 管理器
│   ├── toolRepair.ts                     # 工具修复
│   ├── types.ts                          # 类型定义
│   └── workspaceTemplate.ts             # 工作区模板
├── test/                                 # 测试文件
│   ├── common/
│   │   ├── slotRegistry.test.ts
│   │   ├── planningProvider.test.ts
│   │   └── ...
│   └── ...
├── webview/                              # WebView 实现
│   ├── DESIGN.md                         # 设计文档
│   ├── src/
│   │   ├── App.tsx                       # 主应用
│   │   ├── index.tsx                     # 入口文件
│   │   ├── bridge/                       # 通信层
│   │   │   └── messageClient.ts
│   │   ├── store/                        # 状态管理
│   │   │   ├── useWorkspaceStore.ts
│   │   │   ├── useEmployeeStore.ts
│   │   │   ├── useChatStore.ts
│   │   │   ├── useDelegationStore.ts
│   │   │   └── useTaskBoardStore.ts
│   │   ├── features/                      # 功能组件
│   │   │   ├── title/
│   │   │   │   └── WorkspaceToolbar.tsx
│   │   │   ├── canvas/
│   │   │   │   ├── WorkspaceCanvas.tsx
│   │   │   │   ├── EmployeeNode.tsx
│   │   │   │   └── EmployeeList.tsx
│   │   │   ├── taskboard/
│   │   │   │   ├── TaskBoardPanel.tsx
│   │   │   │   └── TaskCard.tsx
│   │   │   └── chat/
│   │   │       ├── EmployeeChat.tsx
│   │   │       ├── ChatMessage.tsx
│   │   │       └── StreamingText.tsx
│   │   └── styles/
│   │       └── globals.css
└── agentStudio.css                       # 主样式文件
```

---

## 10. 总结

### 10.1 核心优势

| 优势 | 说明 |
|------|------|
| 深度集成 VS Code | 利用 VS Code Workbench 的成熟布局系统 |
| 模块化设计 | Provider/Service/Store 分层清晰 |
| ReactFlow 画布 | 直观的 Agent 关系可视化 |
| 流式聊天 | 实时 SSE 流式输出 |
| 可扩展架构 | Slot Registry 提供扩展点 |

### 10.2 待改进点

| 改进点 | 建议 |
|--------|------|
| 数据持久化 | 当前使用 JSON 文件，建议迁移到 SQLite |
| 错误处理 | 部分服务缺少完善的错误处理 |
| 类型安全 | 部分 `any` 类型需要细化 |
| 测试覆盖 | 需要增加单元测试覆盖率 |
| 文档完善 | 部分模块缺少文档 |

---

**文档结束**
