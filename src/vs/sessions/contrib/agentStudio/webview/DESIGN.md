# Agent Studio WebView - 四区布局设计文档

## 整体布局

基于 sarosis-webui 的 DockLayout 设计理念，在 VS Code AuxiliaryBar 中实现四区布局。
由于 VS Code WebView 面板空间有限（约 400-600px 宽），采用**上下分栏+左右分栏**的混合布局：

```
┌──────────────────────────────────────────────────────────────┐
│ ① Title Bar  [🏢 工作区下拉框 ▼] [+员工] [画布/列表] [刷新]  │
├──────────────────────────────────┬───────────────────────────┤
│ ② 工作画布 / 员工列表            │ ④ 员工聊天框              │
│                                  │                           │
│   画布模式：ReactFlow 画布        │   Header: 头像+名称+模型  │
│   列表模式：竖向员工卡片列表      │   Messages: 消息流        │
│                                  │   Input: 输入框+发送      │
│   点击员工 → 右侧聊天切换        │                           │
├──────────────────────────────────┴───────────────────────────┤
│ ③ 任务看板 (可折叠)                                           │
│   [待执行 ⓝ] [执行中 ⓝ] [执行结束 ⓝ] [取消执行 ⓝ] [归档 ⓝ] │
│   ┌────┐ ┌────┐ ┌────┐                                       │
│   │Card│ │Card│ │Card│  ← 可拖拽卡片                         │
│   └────┘ └────┘ └────┘                                       │
└──────────────────────────────────────────────────────────────┘
```

## 详细区域设计

### ① Title Bar (顶部工具栏)

**功能**：
- 工作区下拉选择器（切换当前活动工作区）
- 员工计数 badge
- 添加员工按钮
- 视图模式切换（画布 ↔ 列表）
- 刷新按钮

**数据流**：
```
WorkspaceToolbar → useWorkspaceStore.setActiveWorkspace(id)
                 → 触发 loadEmployees / loadDelegations
```

**对应 sarosis-webui 组件**：`WorkspaceToolbar.tsx`

---

### ② 工作画布 (中左区域)

**两种模式**：

#### A. 画布模式 (ReactFlow)
- @xyflow/react 渲染员工为节点
- 自定义 EmployeeNode：头像 + 姓名 + 角色 + 状态灯 + 模型标签
- smoothstep 边表示 subagent 关系
- 拖拽节点 → 持久化位置
- 连接节点 → 创建 subagent 关系
- 点击节点 → 选中员工 → 右侧聊天切换

#### B. 列表模式
- 垂直卡片列表
- 每张卡片：头像 + 名称 + 角色 + 状态 + 模型
- 点击切换选中员工

**数据流**：
```
WorkspaceCanvas → useWorkspaceStore (nodes, edges, viewport)
               → useEmployeeStore (员工数据)
               → onSelectEmployee → useChatStore.setActiveEmployee
```

**对应 sarosis-webui 组件**：`WorkspaceCanvas.tsx` + `EmployeeList.tsx`

---

### ③ 任务看板 (底部区域，可折叠)

**5列看板**：
| 列 | 状态键 | 图标 | 颜色 |
|----|--------|------|------|
| 待执行 | todo | 📋 | amber |
| 执行中 | running | ⚡ | blue |
| 执行结束 | done | ✅ | green |
| 取消执行 | cancelled | ⏹ | gray |
| 归档任务 | archived | 📦 | purple |

**功能**：
- 横向滚动的 5 列布局
- 每列显示计数 badge
- 任务卡片支持拖拽状态变更（running 除外）
- 卡片内容：标题 + 委派路线 + 时间 + 状态操作
- 折叠/展开切换（节省空间）

**数据源**：
- 独立任务：`taskBoard.list` API
- 委派任务：`delegation.list` → delegationToRecord 转换
- 合并后统一显示

**对应 sarosis-webui 组件**：`TaskBoardPanel.tsx`

---

### ④ 员工聊天框 (中右区域)

**结构**：
- Header：头像 + 名称 + 角色 + 模型标签
- 消息列表：user/assistant 消息 + thinking block + tool calls
- 流式输出：SSE delta 增量渲染 + typing indicator
- 输入框：多行 textarea + 发送/停止按钮

**数据流**：
```
EmployeeChat → useChatStore (messages, streamState, inputValue)
             → bridge.sendRequest('chat.send') → SSE stream
             → streamHandler → store update → re-render
```

**对应 sarosis-webui 组件**：`EmployeeChat.tsx`（176KB 精简版）

---

## 通信协议

WebView ↔ VS Code Host 通过 postMessage JSON-RPC 通信：

### 新增 RequestType

```typescript
// 任务看板相关
| 'taskBoard.list'       // 获取任务列表
| 'taskBoard.create'     // 创建任务
| 'taskBoard.update'     // 更新任务状态
| 'taskBoard.delete'     // 删除任务
| 'taskBoard.archive'    // 归档任务
```

### 新增 Event Type

```typescript
| 'taskBoard.changed'    // 任务看板更新推送
```

---

## Store 层设计

新增 `useTaskBoardStore.ts`：

```typescript
interface TaskBoardState {
  tasks: TaskBoardRecord[];
  isCollapsed: boolean;
  isLoading: boolean;
  dragTarget: string | null;

  loadTasks: (workspaceId: string) => Promise<void>;
  updateTaskStatus: (taskId: string, status: TaskBoardStatus, source: TaskSource) => Promise<void>;
  createTask: (data: Partial<TaskBoardRecord>) => Promise<void>;
  deleteTask: (taskId: string, source: TaskSource) => Promise<void>;
  archiveTask: (taskId: string, source: TaskSource) => Promise<void>;
  toggleCollapse: () => void;
  setDragTarget: (id: string | null) => void;
}
```

---

## 文件结构（新增/修改）

```
webview/src/
├── App.tsx                          # 🔄 重写为四区布局
├── index.tsx                        # 🔄 添加 taskBoard.changed 事件
├── bridge/
│   └── messageClient.ts             # 🔄 添加 taskBoard.* RequestType
├── store/
│   ├── useWorkspaceStore.ts         # ✅ 已有
│   ├── useEmployeeStore.ts          # ✅ 已有
│   ├── useChatStore.ts              # ✅ 已有
│   ├── useDelegationStore.ts        # ✅ 已有
│   └── useTaskBoardStore.ts         # 🆕 任务看板状态
├── features/
│   ├── title/
│   │   └── WorkspaceToolbar.tsx     # 🆕 顶部工具栏
│   ├── canvas/
│   │   ├── WorkspaceCanvas.tsx      # ✅ 已有 (增强)
│   │   ├── EmployeeNode.tsx         # ✅ 已有
│   │   ├── ConnectionEdge.tsx       # ✅ 已有
│   │   └── EmployeeList.tsx         # 🆕 列表模式
│   ├── taskboard/
│   │   ├── TaskBoardPanel.tsx       # 🆕 任务看板
│   │   └── TaskCard.tsx             # 🆕 任务卡片
│   ├── chat/
│   │   ├── EmployeeChat.tsx         # ✅ 已有
│   │   ├── ChatMessage.tsx          # ✅ 已有
│   │   └── StreamingText.tsx        # ✅ 已有
│   └── sidebar/
│       └── WorkspaceSidebar.tsx      # ❌ 移除（功能合并到 Title 下拉框）
└── styles/
    └── globals.css                   # 🔄 重写为四区布局样式
```

---

## 响应式设计

| 宽度 | 布局 |
|------|------|
| > 800px | 标准四区（画布+聊天并排，看板底部） |
| 600-800px | 画布全宽，聊天覆盖/Tab 切换 |
| < 600px | 纯 Tab 模式（画布/聊天/看板切换） |

---

## VS Code 主题集成

所有颜色通过 CSS 变量适配：
- `--vscode-editor-background`
- `--vscode-panel-border`
- `--vscode-list-hoverBackground`
- `--vscode-badge-background`
- `--vscode-button-background`
- `--vscode-input-background`
- 等等

确保 Light/Dark/High Contrast 三种主题下均正常显示。
