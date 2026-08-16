# Agent ConfigHTML — 自定义 HTML 交互面板设计

## 1. 概述

### 1.1 目标

允许每个 Agent 配置一个自定义 HTML 页面（可以是单文件 HTML 或复杂的前端工程构建产物），通过该 HTML 页面与 Agent 进行双向交互：

- **HTML → Agent**: 用户在 HTML 中的操作（如点击按钮、提交表单）产生事件，Agent 接收事件后向 Model 发送消息
- **Agent → HTML**: Model 返回消息后，Agent 可以向 HTML 发送控制指令，驱动 HTML 页面更新

### 1.2 典型场景

| 场景 | 说明 |
|------|------|
| **审批工作流** | HTML 展示审批表单，点击"同意/拒绝"按钮 → Agent 收到事件 → 向 Model 发送审批决策 → Model 返回下一步操作 → HTML 更新状态 |
| **数据可视化看板** | Agent 从 Model 获取数据 → 推送给 HTML → HTML 使用 ECharts 渲染图表 → 用户点击图表区域 → Agent 获取详情 |
| **表单填报助手** | HTML 展示复杂表单 → 用户填写部分字段 → Agent 自动补全剩余字段 → HTML 回显结果 |
| **游戏/交互演示** | HTML 是一个小游戏界面 → 用户操作 → Agent 作为 AI 对手或裁判进行响应 |
| **聊天增强 UI** | HTML 替代默认聊天界面，提供自定义消息渲染、富交互组件 |

### 1.3 核心设计原则

| 原则 | 说明 |
|------|------|
| **沙箱隔离** | ConfigHTML 运行在独立的 iframe 中，无法访问宿主页面的 DOM 和数据 |
| **协议驱动** | HTML 与 Agent 之间通过 `window.postMessage` 协议通信，定义明确的消息类型 |
| **Agent 中心** | 所有与 Model 的通信仍由 Agent/Host 侧控制，HTML 不直接调用 Model API |
| **渐进式** | 支持从简单的单文件 HTML 到 Vite/Webpack 构建的复杂前端项目 |
| **可持久化** | ConfigHTML 的状态可选择持久化到 Agent Session 中 |

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        VS Code Host                                  │
│                                                                      │
│  ┌────────────────────────────────┐                                  │
│  │     AgentStudioService         │                                  │
│  │  ┌──────────────────────────┐  │                                  │
│  │  │  AgentChatService        │  │  ← Model 通信                    │
│  │  └──────────┬───────────────┘  │                                  │
│  │             │                  │                                  │
│  │  ┌──────────▼───────────────┐  │                                  │
│  │  │  ConfigHTMLService ★     │  │  ← 新增服务                      │
│  │  │  - 管理 HTML 资源路径     │  │                                  │
│  │  │  - 路由 HTML↔Agent 消息  │  │                                  │
│  │  │  - 持久化 HTML 状态      │  │                                  │
│  │  └──────────┬───────────────┘  │                                  │
│  └─────────────┼──────────────────┘                                  │
│                │ postMessage                                         │
│  ┌─────────────▼──────────────────────────────────────────────────┐  │
│  │              Main WebView (React App)                           │  │
│  │                                                                 │  │
│  │  ┌───────────────────┐  ┌──────────────────────────────────┐   │  │
│  │  │  EmployeeChat     │  │  ConfigHTMLPanel ★               │   │  │
│  │  │  (聊天面板)        │  │  ┌──────────────────────────┐   │   │  │
│  │  │                   │  │  │ <iframe sandbox>          │   │   │  │
│  │  │                   │  │  │                            │   │   │  │
│  │  │                   │  │  │   用户自定义 HTML          │   │   │  │
│  │  │                   │  │  │   (agent-confightml-sdk)   │   │   │  │
│  │  │                   │  │  │                            │   │   │  │
│  │  │                   │  │  └──────────────────────────┘   │   │  │
│  │  └───────────────────┘  └──────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 消息流向

```
用户点击 HTML 按钮
    │
    ▼
iframe (ConfigHTML) ──postMessage──▶ ConfigHTMLPanel (React)
    │                                       │
    │                               messageClient.sendRequest(
    │                                 'confightml.event', ...)
    │                                       │
    │                                       ▼
    │                               Host: ConfigHTMLService
    │                                       │
    │                               ┌───────▼────────┐
    │                               │ AgentChatService│
    │                               │ .sendMessage()  │
    │                               └───────┬────────┘
    │                                       │
    │                               Model 响应 (stream)
    │                                       │
    │                               Host: ConfigHTMLService
    │                               解析 Model 输出
    │                                       │
    │                               postMessage 推送到 WebView
    │                                       │
    │                               ConfigHTMLPanel
    │                                       │
iframe (ConfigHTML) ◀──postMessage── iframe.contentWindow.postMessage(...)
    │
    ▼
HTML 更新 UI
```

---

## 3. Agent 配置扩展

### 3.1 Employee 模型扩展 (`agentStudioTypes.ts`)

```typescript
export interface Employee {
    // ... 现有字段 ...

    /**
     * ConfigHTML — 自定义 HTML 交互面板配置。
     * 指定一个 HTML 文件或前端项目目录，Agent 会在聊天面板旁展示该 HTML，
     * 并通过 postMessage 协议与之通信。
     */
    configHtml?: AgentConfigHtml;
}

/**
 * Agent 的自定义 HTML 面板配置
 */
export interface AgentConfigHtml {
    /**
     * HTML 资源类型
     * - 'file': 单文件 HTML（相对于 agent 目录）
     * - 'directory': 前端工程构建产物目录（需含 index.html）
     * - 'url': 外部 URL（开发调试用，需满足 CSP）
     */
    type: 'file' | 'directory' | 'url';

    /**
     * HTML 资源路径
     * - type='file': 相对于 agentDir 的 HTML 文件路径，如 "ui/index.html"
     * - type='directory': 相对于 agentDir 的目录路径，如 "ui/dist"
     * - type='url': 完整 URL，如 "http://localhost:3000"（仅开发模式允许）
     */
    path: string;

    /**
     * 面板展示模式
     * - 'side': 在聊天面板旁（右侧/下方）展示，Chat + HTML 并排
     * - 'replace': 替代默认聊天面板，仅展示 HTML
     * - 'tab': 在独立 Tab 面板中展示
     * - 'overlay': 在画布上以浮动窗口展示
     */
    displayMode: 'side' | 'replace' | 'tab' | 'overlay';

    /**
     * 面板尺寸配置
     */
    size?: {
        /** 初始宽度（px 或百分比） */
        width?: string;
        /** 初始高度（px 或百分比） */
        height?: string;
        /** 最小宽度 */
        minWidth?: string;
        /** 最小高度 */
        minHeight?: string;
        /** 是否允许调整大小 */
        resizable?: boolean;
    };

    /**
     * iframe 安全策略
     * - 'strict': sandbox="allow-scripts"（默认，最严格）
     * - 'standard': sandbox="allow-scripts allow-forms allow-popups"
     * - 'permissive': sandbox="allow-scripts allow-forms allow-popups allow-same-origin"（慎用）
     */
    sandboxLevel?: 'strict' | 'standard' | 'permissive';

    /**
     * 是否在 Agent 选中时自动展示 ConfigHTML 面板
     * 默认 true
     */
    autoShow?: boolean;

    /**
     * 是否在 Agent 切换后保持 HTML 状态（不重新加载）
     * 默认 false（切换时重新加载）
     */
    persistState?: boolean;

    /**
     * 允许 HTML 调用的能力白名单
     * 不在白名单中的能力请求会被拒绝
     */
    capabilities?: ConfigHtmlCapability[];
}

/**
 * ConfigHTML 可申请的能力
 */
export type ConfigHtmlCapability =
    | 'chat.send'           // 允许 HTML 触发向 Model 发送消息
    | 'chat.history'        // 允许 HTML 读取聊天历史
    | 'agent.status'        // 允许 HTML 获取 Agent 状态
    | 'agent.config'        // 允许 HTML 读取 Agent 配置（只读）
    | 'storage.read'        // 允许 HTML 读取持久化存储
    | 'storage.write'       // 允许 HTML 写入持久化存储
    | 'notification'        // 允许 HTML 发送通知
    | 'clipboard'           // 允许 HTML 访问剪贴板
    | 'file.read'           // 允许 HTML 读取工作区文件（受限）
    | 'file.write';         // 允许 HTML 写入工作区文件（受限）
```

### 3.2 Agent 目录扩展

```
.sarosisworkspace/agents/{agent-slug}/
├── agent.yaml               ← 新增 configHtml 配置
├── AGENTS.md
├── SOUL.md
├── IDENTITY.md
├── TOOLS.md
├── MEMORY.md
├── sessions/
└── ui/                      ← ★ 新增: ConfigHTML 资源目录
    ├── index.html           ← 主入口 HTML
    ├── style.css
    ├── app.js
    └── assets/
        └── ...
```

**agent.yaml 配置示例：**

```yaml
name: "审批助手"
role: "处理各类审批请求"
model: "deepseek-v3.1"
provider: "knot"

# ★ ConfigHTML 配置
configHtml:
  type: directory
  path: ui
  displayMode: side
  size:
    width: "50%"
    height: "100%"
    resizable: true
  sandboxLevel: standard
  autoShow: true
  persistState: true
  capabilities:
    - chat.send
    - chat.history
    - storage.read
    - storage.write
    - notification
```

---

## 4. ConfigHTML SDK（嵌入到用户 HTML 中）

用户在自定义 HTML 中引入一个轻量 SDK（`agent-confightml-sdk.js`），通过它与 Agent 通信。

### 4.1 SDK API 设计

```typescript
/**
 * agent-confightml-sdk.js
 * 轻量级 SDK，嵌入到用户的 ConfigHTML 页面中，
 * 提供与 Agent Host 的通信能力。
 *
 * 使用方式:
 *   <script src="agent-confightml-sdk.js"></script>
 *   <script>
 *     const agent = AgentSDK.connect();
 *     agent.on('message', (data) => { ... });
 *     agent.sendEvent('button_click', { action: 'approve' });
 *   </script>
 */

interface AgentSDK {
    /**
     * 建立与 Agent Host 的连接。
     * 自动握手并获取 Agent 上下文信息。
     */
    connect(options?: ConnectOptions): AgentConnection;
}

interface ConnectOptions {
    /** 连接超时（ms），默认 5000 */
    timeout?: number;
    /** 连接成功后是否自动请求 Agent 状态 */
    autoFetchStatus?: boolean;
}

interface AgentConnection {
    /** 连接状态 */
    readonly state: 'connecting' | 'connected' | 'disconnected';

    /** Agent 信息（握手后可用） */
    readonly agent: {
        readonly id: string;
        readonly name: string;
        readonly role: string;
        readonly status: string;
    };

    // ─── 事件发送 (HTML → Agent) ───

    /**
     * 发送自定义事件到 Agent。
     * Agent 收到后可决定是否转发给 Model。
     *
     * @param eventName - 事件名称，如 'button_click', 'form_submit'
     * @param payload - 事件数据（需可 JSON 序列化）
     * @returns Promise，resolve 时表示 Agent 已确认接收
     */
    sendEvent(eventName: string, payload?: unknown): Promise<void>;

    /**
     * 请求 Agent 向 Model 发送消息。
     * 等效于用户在聊天框中输入并发送。
     *
     * @param message - 消息内容
     * @param options - 发送选项
     * @returns Promise<string> - Model 的回复内容
     */
    sendMessage(message: string, options?: SendMessageOptions): Promise<string>;

    /**
     * 请求 Agent 向 Model 发送消息（流式）。
     * 返回一个可迭代的流。
     */
    sendMessageStream(message: string, options?: SendMessageOptions): AsyncIterable<StreamChunk>;

    // ─── 事件监听 (Agent → HTML) ───

    /**
     * 监听来自 Agent 的消息/指令。
     * Agent（或 Model）可以主动推送数据到 HTML。
     */
    on(event: 'message', handler: (data: AgentMessage) => void): void;

    /**
     * 监听 Agent 状态变更。
     */
    on(event: 'status', handler: (status: AgentStatus) => void): void;

    /**
     * 监听 Agent 发来的指令（Model 输出解析后的结构化指令）。
     * 这是让 Model 控制 HTML 的核心机制。
     */
    on(event: 'command', handler: (command: AgentCommand) => void): void;

    /**
     * 监听连接状态变更。
     */
    on(event: 'connection', handler: (state: string) => void): void;

    /**
     * 移除事件监听。
     */
    off(event: string, handler: Function): void;

    // ─── 存储 API ───

    /**
     * 读取持久化存储（存储在 Agent Session 中）。
     * 需要 'storage.read' 能力。
     */
    storage: {
        get(key: string): Promise<unknown>;
        set(key: string, value: unknown): Promise<void>;
        delete(key: string): Promise<void>;
        keys(): Promise<string[]>;
    };

    // ─── 通知 API ───

    /**
     * 发送通知（显示在 Agent Studio UI 中）。
     * 需要 'notification' 能力。
     */
    notify(message: string, type?: 'info' | 'success' | 'warning' | 'error'): Promise<void>;

    /**
     * 断开连接，释放资源。
     */
    disconnect(): void;
}

// ─── 消息类型 ───

interface AgentMessage {
    /** 消息 ID */
    id: string;
    /** 消息来源: model 的回复或 agent 系统消息 */
    source: 'model' | 'agent' | 'system';
    /** 消息内容（文本） */
    content: string;
    /** 结构化数据（Model 输出中解析出的 JSON） */
    data?: unknown;
    /** 时间戳 */
    timestamp: string;
}

interface AgentCommand {
    /** 指令名称，如 'updateForm', 'showResult', 'navigate' */
    name: string;
    /** 指令参数 */
    params: Record<string, unknown>;
    /** 指令 ID（用于 ack） */
    id: string;
}

interface AgentStatus {
    status: 'idle' | 'working' | 'thinking' | 'error';
    model?: string;
}

interface StreamChunk {
    type: 'text' | 'thinking' | 'tool' | 'done';
    content?: string;
}

interface SendMessageOptions {
    /** 是否在聊天面板中显示此消息 */
    showInChat?: boolean;
    /** 附加上下文（注入到系统提示词中） */
    context?: string;
    /** Model 参数覆盖 */
    temperature?: number;
}
```

### 4.2 SDK 使用示例

**审批表单 HTML：**

```html
<!DOCTYPE html>
<html>
<head>
    <title>审批面板</title>
    <script src="agent-confightml-sdk.js"></script>
    <style>
        body { font-family: sans-serif; padding: 20px; }
        .approval-card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 10px 0; }
        .btn { padding: 8px 24px; border: none; border-radius: 4px; cursor: pointer; margin: 4px; }
        .btn-approve { background: #52c41a; color: white; }
        .btn-reject { background: #ff4d4f; color: white; }
        .status { font-weight: bold; }
        .status.approved { color: #52c41a; }
        .status.rejected { color: #ff4d4f; }
    </style>
</head>
<body>
    <h2>待审批事项</h2>
    <div id="approval-list"></div>
    <div id="status-bar">等待加载...</div>

    <script>
        const agent = AgentSDK.connect();
        const listEl = document.getElementById('approval-list');
        const statusEl = document.getElementById('status-bar');

        // 连接成功后请求审批列表
        agent.on('connection', (state) => {
            if (state === 'connected') {
                statusEl.textContent = `已连接 Agent: ${agent.agent.name}`;
                agent.sendEvent('request_approvals');
            }
        });

        // Agent 推送审批项
        agent.on('command', (cmd) => {
            switch (cmd.name) {
                case 'showApprovals':
                    renderApprovals(cmd.params.items);
                    break;
                case 'updateApprovalStatus':
                    updateStatus(cmd.params.id, cmd.params.status);
                    break;
                case 'showResult':
                    statusEl.textContent = cmd.params.message;
                    break;
            }
        });

        // Model 回复
        agent.on('message', (msg) => {
            if (msg.data?.approvals) {
                renderApprovals(msg.data.approvals);
            }
        });

        function renderApprovals(items) {
            listEl.innerHTML = items.map(item => `
                <div class="approval-card" id="card-${item.id}">
                    <h3>${item.title}</h3>
                    <p>${item.description}</p>
                    <p>申请人: ${item.applicant} | 金额: ¥${item.amount}</p>
                    <div class="actions">
                        <button class="btn btn-approve" onclick="handleApprove('${item.id}')">同意</button>
                        <button class="btn btn-reject" onclick="handleReject('${item.id}')">拒绝</button>
                    </div>
                    <span class="status" id="status-${item.id}">待审批</span>
                </div>
            `).join('');
        }

        async function handleApprove(id) {
            statusEl.textContent = '正在处理...';
            // 发送事件给 Agent，Agent 将携带上下文发送给 Model
            await agent.sendEvent('approval_decision', {
                id: id,
                action: 'approve',
                comment: '同意'
            });
        }

        async function handleReject(id) {
            const reason = prompt('请输入拒绝原因:');
            if (reason === null) return;
            await agent.sendEvent('approval_decision', {
                id: id,
                action: 'reject',
                comment: reason
            });
        }

        function updateStatus(id, status) {
            const el = document.getElementById(`status-${id}`);
            if (el) {
                el.textContent = status === 'approved' ? '已通过' : '已拒绝';
                el.className = `status ${status}`;
            }
            // 禁用按钮
            const card = document.getElementById(`card-${id}`);
            if (card) {
                card.querySelectorAll('.btn').forEach(btn => btn.disabled = true);
            }
        }
    </script>
</body>
</html>
```

---

## 5. 通信协议设计

### 5.1 iframe ↔ ConfigHTMLPanel 消息协议

```typescript
// ─── iframe → Panel (上行) ──────────────────────────────────

interface ConfigHtmlToPanel {
    /** 协议标识 (用于 message 事件过滤) */
    readonly __confightml: true;
    /** 消息 ID (用于请求-响应配对) */
    readonly id: string;
    /** 消息类型 */
    readonly type: ConfigHtmlUpMessageType;
    /** 消息负载 */
    readonly payload: unknown;
}

type ConfigHtmlUpMessageType =
    | 'handshake'          // 握手请求（SDK connect 时发送）
    | 'event'              // 自定义事件 → Agent
    | 'chat.send'          // 请求发送消息给 Model
    | 'chat.sendStream'    // 请求流式发送消息
    | 'chat.history'       // 请求聊天历史
    | 'storage.get'        // 读存储
    | 'storage.set'        // 写存储
    | 'storage.delete'     // 删存储
    | 'storage.keys'       // 列存储键
    | 'notify'             // 发送通知
    | 'command.ack'        // 确认收到指令
    | 'ready';             // HTML 加载完成

// ─── Panel → iframe (下行) ──────────────────────────────────

interface PanelToConfigHtml {
    readonly __confightml: true;
    readonly id?: string;   // 如果是响应，匹配请求 ID
    readonly type: ConfigHtmlDownMessageType;
    readonly payload: unknown;
}

type ConfigHtmlDownMessageType =
    | 'handshake.ack'      // 握手确认 + Agent 上下文
    | 'response'           // 请求的响应
    | 'error'              // 请求的错误响应
    | 'message'            // Agent/Model 消息推送
    | 'command'            // Agent 指令推送
    | 'status'             // Agent 状态变更
    | 'stream.delta'       // 流式消息增量
    | 'stream.complete'    // 流式消息完成
    | 'stream.error';      // 流式消息错误
```

### 5.2 Panel ↔ Host 消息协议（扩展 messageProtocol.ts）

```typescript
// ─── 新增 RequestType ───

export type RequestType =
    // ... 现有类型 ...
    | 'confightml.event'           // HTML 发来的自定义事件
    | 'confightml.chatSend'        // HTML 请求发送聊天消息
    | 'confightml.chatHistory'     // HTML 请求聊天历史
    | 'confightml.storageGet'      // HTML 读存储
    | 'confightml.storageSet'      // HTML 写存储
    | 'confightml.storageDelete'   // HTML 删存储
    | 'confightml.storageKeys'     // HTML 列存储键
    | 'confightml.getResource'     // 获取 HTML 资源内容
    | 'confightml.notify';         // HTML 发送通知

// ─── 新增 EventType ───

export type EventType =
    // ... 现有类型 ...
    | 'confightml.message'         // Agent/Model 向 HTML 推送消息
    | 'confightml.command'         // Agent 向 HTML 推送指令
    | 'confightml.status';         // Agent 状态变更 → HTML

// ─── 新增 Payload 接口 ───

export interface IConfigHtmlEventPayload {
    readonly employeeId: string;
    readonly eventName: string;
    readonly payload?: unknown;
    readonly agentSessionId?: string;
}

export interface IConfigHtmlChatSendPayload {
    readonly employeeId: string;
    readonly message: string;
    readonly context?: string;
    readonly showInChat?: boolean;
    readonly agentSessionId?: string;
}

export interface IConfigHtmlStoragePayload {
    readonly employeeId: string;
    readonly key: string;
    readonly value?: unknown;
    readonly agentSessionId?: string;
}

export interface IConfigHtmlResourcePayload {
    readonly employeeId: string;
    /** HTML 资源路径配置 */
    readonly configHtml: {
        type: string;
        path: string;
    };
}

export interface IConfigHtmlCommandPayload {
    readonly employeeId: string;
    readonly command: {
        name: string;
        params: Record<string, unknown>;
        id: string;
    };
}
```

---

## 6. Host 端服务设计

### 6.1 ConfigHTMLService（新增）

```typescript
// src/vs/sessions/contrib/agentStudio/browser/configHtmlService.ts

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event, Emitter } from '../../../../base/common/event.js';

export const IConfigHtmlService = createDecorator<IConfigHtmlService>('configHtmlService');

export interface IConfigHtmlService {
    readonly _serviceBrand: undefined;

    /**
     * 当 HTML 发来事件时触发。
     * Host 侧的 Agent 逻辑可监听此事件，
     * 决定是否要向 Model 发送消息。
     */
    readonly onDidReceiveHtmlEvent: Event<IHtmlEvent>;

    /**
     * 处理来自 ConfigHTML 的自定义事件。
     * 1. 验证 Agent 的 capabilities 白名单
     * 2. 根据 Agent 的 system prompt + 事件构造消息
     * 3. 发送给 Model
     * 4. 解析 Model 输出中的 commands
     * 5. 推送 commands 回 HTML
     */
    handleHtmlEvent(employeeId: string, eventName: string, payload: unknown): Promise<void>;

    /**
     * 处理 HTML 请求的消息发送。
     * 区别于 handleHtmlEvent: 此方法直接将文本消息发送给 Model，
     * 不做额外的事件包装。
     */
    handleChatSend(
        employeeId: string,
        message: string,
        options?: { context?: string; showInChat?: boolean; agentSessionId?: string },
    ): Promise<unknown>;

    /**
     * 向指定 Agent 的 ConfigHTML 推送指令。
     * 由 Model 回复解析后调用。
     */
    sendCommandToHtml(employeeId: string, command: IHtmlCommand): void;

    /**
     * 向指定 Agent 的 ConfigHTML 推送消息。
     */
    sendMessageToHtml(employeeId: string, message: IHtmlMessage): void;

    // ─── HTML 状态存储 ───

    getStorage(employeeId: string, key: string, sessionId?: string): Promise<unknown>;
    setStorage(employeeId: string, key: string, value: unknown, sessionId?: string): Promise<void>;
    deleteStorage(employeeId: string, key: string, sessionId?: string): Promise<void>;
    getStorageKeys(employeeId: string, sessionId?: string): Promise<string[]>;

    // ─── 资源管理 ───

    /**
     * 获取 Agent 的 ConfigHTML 资源内容。
     * 读取 agentDir + configHtml.path 下的文件，
     * 将其转换为 data URI 或 webview 可访问的 URI。
     */
    resolveHtmlResource(employeeId: string): Promise<IResolvedHtmlResource | null>;
}

interface IHtmlEvent {
    employeeId: string;
    eventName: string;
    payload: unknown;
}

interface IHtmlCommand {
    name: string;
    params: Record<string, unknown>;
    id: string;
}

interface IHtmlMessage {
    source: 'model' | 'agent' | 'system';
    content: string;
    data?: unknown;
}

interface IResolvedHtmlResource {
    /** HTML 内容（对于 file/directory 类型） */
    html?: string;
    /** Webview 可访问的 URI（对于 directory 类型） */
    baseUri?: string;
    /** 外部 URL（对于 url 类型） */
    externalUrl?: string;
    /** 资源类型 */
    type: 'inline' | 'local' | 'external';
}
```

### 6.2 Model 输出的 Command 解析

Agent 的 system prompt 中注入 ConfigHTML 协议说明，让 Model 知道如何输出结构化指令：

```markdown
## ConfigHTML 交互协议

你关联了一个自定义 HTML 交互面板。当 HTML 发来事件时，你会收到如下格式的消息：

```
[ConfigHTML Event: {eventName}]
{JSON payload}
```

你可以在回复中包含发送给 HTML 的指令，使用以下格式：

```confightml-command
{
  "name": "指令名称",
  "params": { ... }
}
```

支持的指令由 HTML 开发者定义，常见的有：
- `updateForm`: 更新表单字段
- `showResult`: 显示结果
- `navigate`: 页面导航
- `updateStatus`: 更新状态显示

你也可以同时回复普通文本和指令。普通文本会显示在聊天面板中，
`confightml-command` 代码块中的 JSON 会被解析并发送给 HTML。
```

**Host 侧的解析逻辑：**

```typescript
/**
 * 从 Model 输出中提取 ConfigHTML commands。
 * 格式: ```confightml-command\n{JSON}\n```
 */
function parseConfigHtmlCommands(content: string): IHtmlCommand[] {
    const regex = /```confightml-command\s*\n([\s\S]*?)\n```/g;
    const commands: IHtmlCommand[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            commands.push({
                name: parsed.name,
                params: parsed.params || {},
                id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            });
        } catch {
            // skip malformed command blocks
        }
    }

    return commands;
}
```

---

## 7. WebView 前端组件设计

### 7.1 ConfigHTMLPanel 组件

```
features/confightml/
├── ConfigHTMLPanel.tsx          # 主面板容器 + iframe 管理
├── ConfigHTMLIframe.tsx         # iframe 封装 + 消息桥
├── ConfigHTMLToolbar.tsx        # 工具栏（刷新/全屏/设置）
├── useConfigHtmlStore.ts        # Zustand store
└── configHtmlBridge.ts          # iframe ↔ Panel 消息桥
```

### 7.2 ConfigHTMLPanel 组件设计

```tsx
// features/confightml/ConfigHTMLPanel.tsx

interface ConfigHTMLPanelProps {
    employeeId: string;
    configHtml: AgentConfigHtml;
    className?: string;
}

function ConfigHTMLPanel({ employeeId, configHtml, className }: ConfigHTMLPanelProps) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    // 加载 HTML 资源
    const { htmlContent, baseUri } = useConfigHtmlResource(employeeId, configHtml);

    // 消息桥: 处理 iframe 发来的消息
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data;
            if (!msg?.__confightml) return;
            handleIframeMessage(msg, employeeId, iframeRef.current);
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [employeeId]);

    // 监听 Host 推送的 confightml.command / confightml.message
    useEffect(() => {
        const unsub = subscribeToConfigHtmlEvents(employeeId, (event) => {
            // 转发给 iframe
            iframeRef.current?.contentWindow?.postMessage({
                __confightml: true,
                type: event.type,
                payload: event.data,
            }, '*');
        });
        return unsub;
    }, [employeeId]);

    // 构建 sandbox 属性
    const sandboxAttrs = useMemo(() => {
        switch (configHtml.sandboxLevel) {
            case 'permissive': return 'allow-scripts allow-forms allow-popups allow-same-origin';
            case 'standard': return 'allow-scripts allow-forms allow-popups';
            default: return 'allow-scripts';
        }
    }, [configHtml.sandboxLevel]);

    return (
        <div className={`confightml-panel ${className}`} style={panelStyle}>
            <ConfigHTMLToolbar
                onRefresh={() => reloadIframe()}
                onToggleFullscreen={toggleFullscreen}
                isConnected={isConnected}
            />
            {isLoading && <LoadingSpinner />}
            <iframe
                ref={iframeRef}
                sandbox={sandboxAttrs}
                srcDoc={htmlContent}
                src={configHtml.type === 'url' ? configHtml.path : undefined}
                style={{ width: '100%', height: '100%', border: 'none' }}
                onLoad={() => setIsLoading(false)}
            />
        </div>
    );
}
```

### 7.3 EmployeeChat 集成

在现有的 `EmployeeChat` 组件中集成 ConfigHTMLPanel：

```tsx
// features/chat/EmployeeChat.tsx — 修改

function EmployeeChat() {
    const { selectedEmployee } = useEmployeeStore();
    const employee = employees.find(e => e.id === selectedEmployee);

    // 判断是否有 ConfigHTML
    const hasConfigHtml = employee?.configHtml?.path;
    const displayMode = employee?.configHtml?.displayMode || 'side';

    if (displayMode === 'replace' && hasConfigHtml) {
        // 完全替代聊天面板
        return (
            <ConfigHTMLPanel
                employeeId={employee.id}
                configHtml={employee.configHtml}
            />
        );
    }

    return (
        <div className="employee-chat-container">
            {/* 标准聊天面板 */}
            <div className={`chat-section ${hasConfigHtml && displayMode === 'side' ? 'with-confightml' : ''}`}>
                {/* ... 现有聊天 UI ... */}
            </div>

            {/* ConfigHTML 侧边面板 */}
            {hasConfigHtml && displayMode === 'side' && (
                <ConfigHTMLPanel
                    employeeId={employee.id}
                    configHtml={employee.configHtml}
                    className="confightml-side-panel"
                />
            )}
        </div>
    );
}
```

---

## 8. 详细消息流 — 完整交互周期

### 8.1 HTML 按钮点击 → Model 响应 → HTML 更新

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Step 1: 用户点击 HTML 中的"同意"按钮                                    │
│                                                                         │
│  [iframe] 用户 HTML:                                                    │
│    button.onclick → agent.sendEvent('approval_decision',                │
│                       { id: 'req_001', action: 'approve' })             │
│                                                                         │
│  [iframe → Panel] postMessage:                                          │
│    { __confightml: true, id: 'msg_1', type: 'event',                   │
│      payload: { eventName: 'approval_decision',                         │
│                 data: { id: 'req_001', action: 'approve' } } }          │
├─────────────────────────────────────────────────────────────────────────┤
│  Step 2: ConfigHTMLPanel 转发到 Host                                     │
│                                                                         │
│  [Panel → Host] sendRequest('confightml.event', {                       │
│    employeeId: 'agent-approver',                                        │
│    eventName: 'approval_decision',                                      │
│    payload: { id: 'req_001', action: 'approve' },                       │
│    agentSessionId: 'sess_xxx'                                           │
│  })                                                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  Step 3: Host ConfigHTMLService 处理                                     │
│                                                                         │
│  ConfigHTMLService.handleHtmlEvent():                                    │
│    1. 检查 capabilities 白名单: ['chat.send'] ✓                         │
│    2. 构造消息:                                                          │
│       "[ConfigHTML Event: approval_decision]                             │
│        {"id":"req_001","action":"approve"}"                              │
│    3. 调用 AgentChatService.sendMessage(                                 │
│         employeeId, constructedMessage, { stream: true })               │
├─────────────────────────────────────────────────────────────────────────┤
│  Step 4: Model 回复（含 confightml-command）                             │
│                                                                         │
│  Model 输出:                                                             │
│    "审批请求 req_001 已通过处理。                                         │
│                                                                         │
│     ```confightml-command                                                │
│     {"name":"updateApprovalStatus",                                     │
│      "params":{"id":"req_001","status":"approved"}}                     │
│     ```                                                                  │
│                                                                         │
│     ```confightml-command                                                │
│     {"name":"showResult",                                               │
│      "params":{"message":"审批已通过，已通知申请人"}}                      │
│     ```"                                                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  Step 5: Host 解析 commands 并分发                                       │
│                                                                         │
│  ConfigHTMLService:                                                      │
│    1. parseConfigHtmlCommands(modelOutput) → 2 commands                  │
│    2. 文本部分 → chat.stream.delta（显示在聊天面板）                      │
│    3. Command 1 → sendEvent('confightml.command', {                      │
│         employeeId, command: {name:'updateApprovalStatus',...} })        │
│    4. Command 2 → sendEvent('confightml.command', {                      │
│         employeeId, command: {name:'showResult',...} })                  │
├─────────────────────────────────────────────────────────────────────────┤
│  Step 6: ConfigHTMLPanel 接收并转发给 iframe                             │
│                                                                         │
│  [Panel → iframe] postMessage:                                          │
│    { __confightml: true, type: 'command',                               │
│      payload: { name: 'updateApprovalStatus',                           │
│                 params: { id: 'req_001', status: 'approved' } } }       │
│                                                                         │
│  [iframe] SDK on('command') handler 触发:                                │
│    → updateStatus('req_001', 'approved')                                │
│    → HTML DOM 更新: 状态变绿 ✅, 按钮禁用                               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 9. WebView Controller 路由扩展

### 9.1 新增消息路由 (`agentStudioWebviewController.ts`)

```typescript
// _dispatch() 中新增:

// ─── ConfigHTML ──────────────────────────────────────
case 'confightml.event':
    return this.configHtmlService.handleHtmlEvent(
        p.employeeId as string,
        p.eventName as string,
        p.payload,
    );
case 'confightml.chatSend':
    return this.configHtmlService.handleChatSend(
        p.employeeId as string,
        p.message as string,
        {
            context: p.context as string | undefined,
            showInChat: p.showInChat as boolean | undefined,
            agentSessionId: p.agentSessionId as string | undefined,
        },
    );
case 'confightml.chatHistory':
    return this.agentChatService.getHistory(
        p.employeeId as string,
        p.sessionId as string | undefined,
    );
case 'confightml.storageGet':
    return this.configHtmlService.getStorage(
        p.employeeId as string,
        p.key as string,
        p.sessionId as string | undefined,
    );
case 'confightml.storageSet':
    return this.configHtmlService.setStorage(
        p.employeeId as string,
        p.key as string,
        p.value,
        p.sessionId as string | undefined,
    );
case 'confightml.storageDelete':
    return this.configHtmlService.deleteStorage(
        p.employeeId as string,
        p.key as string,
        p.sessionId as string | undefined,
    );
case 'confightml.storageKeys':
    return this.configHtmlService.getStorageKeys(
        p.employeeId as string,
        p.sessionId as string | undefined,
    );
case 'confightml.getResource':
    return this.configHtmlService.resolveHtmlResource(p.employeeId as string);
case 'confightml.notify':
    // TODO: 集成到 VS Code 通知系统
    this.logService.info(`[ConfigHTML] Notification from ${p.employeeId}: ${p.message}`);
    return undefined;
```

---

## 10. 数据存储

### 10.1 ConfigHTML 状态存储目录

```
.sarosisworkspace/agents/{agent-slug}/
├── ui/                        ← ConfigHTML 资源
│   ├── index.html
│   └── ...
├── sessions/
│   ├── default/
│   │   ├── history.json
│   │   └── confightml_storage.json   ← ★ ConfigHTML 持久化存储
│   └── {sessionId}/
│       ├── history.json
│       └── confightml_storage.json
└── confightml_storage.json    ← ★ 全局（非 Session 绑定）存储
```

### 10.2 存储格式

```json
// confightml_storage.json
{
    "version": 1,
    "updatedAt": "2026-05-17T08:00:00.000Z",
    "data": {
        "approvalStatus": { "req_001": "approved", "req_002": "pending" },
        "userPreferences": { "theme": "dark", "layout": "grid" },
        "lastSyncTime": "2026-05-17T07:55:00.000Z"
    }
}
```

---

## 11. 安全设计

### 11.1 iframe 沙箱

| 安全层 | 措施 |
|--------|------|
| **iframe sandbox** | 默认 `sandbox="allow-scripts"`，无 `allow-same-origin` 防止逃逸 |
| **CSP** | `Content-Security-Policy` 限制 script-src / style-src / connect-src |
| **Origin 校验** | ConfigHTMLPanel 的 message handler 校验 `event.source === iframeRef.contentWindow` |
| **协议标识** | 所有消息必须携带 `__confightml: true` 标记 |
| **能力白名单** | 仅 `capabilities` 列表中声明的能力可被调用 |
| **速率限制** | `chat.send` 等高成本操作有频率限制（默认 10 次/分钟） |
| **内容大小限制** | 单条消息 payload 最大 1MB |

### 11.2 能力审计

```typescript
class ConfigHtmlService {
    private _checkCapability(
        employee: Employee,
        capability: ConfigHtmlCapability,
    ): void {
        const allowed = employee.configHtml?.capabilities || [];
        if (!allowed.includes(capability)) {
            throw new Error(
                `ConfigHTML capability '${capability}' not allowed for agent '${employee.name}'. `
                + `Allowed: [${allowed.join(', ')}]`
            );
        }
    }
}
```

---

## 12. CreateAgentModal 扩展

### 12.1 新增 ConfigHTML 配置区

在 `CreateAgentModal.tsx` 的 Agent 创建/编辑表单中新增 "交互面板" 配置区：

```
┌───────────────────────────────────────────────────────────┐
│  创建 Agent                                               │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 基本信息 │ 模型配置 │ Skills │ ★ 交互面板 │ 高级 │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ★ 交互面板 (ConfigHTML)                                  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ☑ 启用自定义 HTML 交互面板                          │  │
│  │                                                      │  │
│  │ 资源类型:  ○ 文件  ○ 目录  ○ URL(调试)             │  │
│  │                                                      │  │
│  │ 路径: [ ui/index.html              ] [浏览...]       │  │
│  │                                                      │  │
│  │ 展示模式:  ○ 侧边并排  ○ 替代聊天  ○ 独立Tab       │  │
│  │                                                      │  │
│  │ 安全级别:  ○ 严格  ○ 标准  ○ 宽松                   │  │
│  │                                                      │  │
│  │ 允许的能力:                                          │  │
│  │ ☑ 发送消息  ☑ 读取历史  ☐ 读写存储  ☐ 通知          │  │
│  │ ☐ 读取文件  ☐ 写入文件  ☐ 剪贴板                    │  │
│  │                                                      │  │
│  │ [预览面板]  [上传 HTML 包]                            │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

---

## 13. 画布上的 ConfigHTML 指示

### 13.1 EmployeeNode 扩展

```
┌──────────────────────────────┐
│  🤖 审批助手                  │
│  Role: 审批流程处理           │
│  Model: deepseek-v3.1        │
│  ┌──────────────────────┐    │
│  │ 📄 HTML Panel Active │    │  ← 新增: ConfigHTML 状态指示
│  └──────────────────────┘    │
│  💬 12 msgs  🔧 2 tools     │
└──────────────────────────────┘
```

点击 ConfigHTML 指示区域可快速打开/关闭 ConfigHTML 面板。

---

## 14. 实施计划

### Phase 1: 基础设施（后端）
1. **类型扩展**: `agentStudioTypes.ts` 添加 `AgentConfigHtml` 接口
2. **协议扩展**: `messageProtocol.ts` 添加 `confightml.*` 请求/事件类型
3. **ConfigHTMLService**: 实现核心服务（事件处理、Command 解析、存储）
4. **WebviewController 路由**: 添加 `confightml.*` 消息处理
5. **agent.yaml 解析**: 支持读写 `configHtml` 配置节

### Phase 2: SDK + 前端组件
6. **agent-confightml-sdk.js**: 实现轻量 SDK（~5KB gzipped）
7. **ConfigHTMLPanel 组件**: iframe 容器 + 消息桥
8. **ConfigHTMLIframe 组件**: iframe 生命周期 + sandbox 管理
9. **useConfigHtmlStore**: Zustand store
10. **configHtmlBridge**: iframe ↔ Panel 消息路由

### Phase 3: UI 集成
11. **EmployeeChat 集成**: 支持 side / replace / tab 展示模式
12. **CreateAgentModal**: 添加 ConfigHTML 配置表单
13. **EmployeeNode**: 添加 ConfigHTML 状态指示
14. **样式**: ConfigHTML 面板样式 + 响应式布局

### Phase 4: Model 集成
15. **System Prompt 注入**: 自动注入 ConfigHTML 交互协议说明
16. **Command 解析器**: 从 Model 输出中提取 `confightml-command`
17. **流式 Command 分发**: 在 stream 过程中实时检测并分发 commands

### Phase 5: 高级功能
18. **HTML 热重载**: 开发模式下支持 HTML 文件变更自动刷新
19. **存储持久化**: 实现 confightml_storage.json 读写
20. **安全审计日志**: 记录所有 ConfigHTML 的能力调用
21. **模板库**: 提供常用 ConfigHTML 模板（审批、表单、看板等）

---

## 15. 与现有系统的关系

```
┌────────────────────────────────────────────────────────────────────┐
│                    Agent Studio 功能矩阵                            │
│                                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐      │
│  │  Canvas   │  │   Chat   │  │TaskBoard │  │ ConfigHTML ★ │      │
│  │  (画布)   │  │  (聊天)  │  │  (看板)  │  │ (自定义HTML) │      │
│  └────┬──────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘      │
│       │              │              │                │              │
│       ├──────────────┼──────────────┼────────────────┘              │
│       ▼              ▼              ▼                               │
│  ┌─────────────────────────────────────────────────┐               │
│  │           messageProtocol.ts (统一通信)          │               │
│  └─────────────────────┬───────────────────────────┘               │
│                        ▼                                           │
│  ┌──────────────────────────────────────────────────┐              │
│  │              Host Services                        │              │
│  │  AgentStudio | Chat | Delegation | ConfigHTML ★  │              │
│  └──────────────────────────────────────────────────┘              │
│                        ▼                                           │
│  ┌──────────────────────────────────────────────────┐              │
│  │              Agent OS (Model 通信)                │              │
│  └──────────────────────────────────────────────────┘              │
└────────────────────────────────────────────────────────────────────┘
```

**与 Workspace Session (Fork) 的关系：**
- ConfigHTML 状态存储支持 Session 隔离（每个 Fork 有独立的 `confightml_storage.json`）
- Fork 模式下 ConfigHTML 面板仍可交互（因为 Fork 允许 Chat，ConfigHTML 也允许）

**与 Orchestration 的关系：**
- Planner/PM 类型的 Agent 也可以配置 ConfigHTML（如任务看板 HTML、甘特图等）
- Worker Agent 可以通过 ConfigHTML 展示其专业工具界面

---

## 16. 后续扩展

| 扩展方向 | 说明 |
|----------|------|
| **ConfigHTML 市场** | 共享 ConfigHTML 模板，类似 VS Code 扩展市场 |
| **多 HTML 面板** | 单个 Agent 支持配置多个 HTML 面板（如左侧表单 + 右侧可视化） |
| **Agent 间 HTML 通信** | 不同 Agent 的 ConfigHTML 之间通过 Agent 转发消息 |
| **HTML → Tool 调用** | ConfigHTML 直接触发 Agent 的 Tool（如 MCP 工具），而非仅聊天 |
| **离线模式** | ConfigHTML 在无 Model 连接时也能运行基础功能 |
| **版本管理** | ConfigHTML 资源的版本控制，支持回滚 |
| **自适应布局** | 根据面板尺寸自动切换 ConfigHTML 的 responsive 布局 |
| **性能监控** | ConfigHTML 的 CPU / 内存使用监控，防止恶意/低效 HTML |
