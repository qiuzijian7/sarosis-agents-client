# Saros Agent Studio × OpenClaw 集成架构设计 (v2)

> 生成时间：2026-05-08 v2
> 核心前提：**Agent Studio WebView 完全替代 OpenClaw WebUI**，仅集成 Gateway + Agent Runtime
> 上游修改数：**实际仅 6 个文件**（非此前估计的 23 个）

---

## 目录

1. [项目现状重新评估](#1-项目现状重新评估)
2. [架构设计原则](#2-架构设计原则)
3. [Agent Studio 现有架构分析](#3-agent-studio-现有架构分析)
4. [OpenClaw 集成策略](#4-openclaw-集成策略)
5. [优化后的目录结构](#5-优化后的目录结构)
6. [数据流与通信协议](#6-数据流与通信协议)
7. [Gateway 进程管理](#7-gateway-进程管理)
8. [迁移计划](#8-迁移计划)
9. [Git 管理与更新策略](#9-git-管理与更新策略)

---

## 1. 项目现状重新评估

### 1.1 实际上游修改（仅 6 个文件）

经过精确的 `git diff upstream/main` 分析，实际直接修改上游源码的文件**仅 6 个**：

| # | 文件 | 修改类型 | 必要性 |
|----|------|----------|--------|
| A | `src/vs/platform/utilityProcess/electron-main/utilityProcessWorkerMainService.ts` | Worker 内存管理修复 | ✅ 不可避免 |
| B | `src/vs/workbench/services/chat/common/chatEntitlementService.ts` | Chat API 重构 | ✅ 不可避免 |
| C | `src/vs/workbench/contrib/chat/browser/chatStatus/chatStatusDashboard.ts` | UI 适配 | ✅ 跟随 B |
| D | `src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatQuotaExceededPart.ts` | UI 适配 | ✅ 跟随 B |
| E | `src/vs/workbench/contrib/chat/test/browser/chatStatusDashboard.test.ts` | 测试更新 | ✅ 跟随 C |
| F | `src/vs/workbench/contrib/chat/test/common/chatEntitlementService.test.ts` | 测试更新 | ✅ 跟随 B |

**关键发现**：Agent Studio 的全部实现位于 `src/vs/sessions/contrib/agentStudio/`，这是一个**新增模块**，不涉及任何上游修改。

### 1.2 Sessions 层定位

```
src/vs/sessions/          ← 独立顶层模块（与 vs/workbench 同级）
├── sessions.common.main.ts
├── sessions.desktop.main.ts
├── sessions.web.main.ts
├── services/sessions/    ← ISessionsProvider 核心框架
├── contrib/              ← 28 个贡献模块
│   ├── agentStudio/      ← ⭐ 我们的主战场
│   ├── chat/
│   ├── agentHost/
│   ├── remoteAgentHost/
│   └── ... (25 others)
└── browser/              ← Workbench 集成
```

**层级规则**：`vs/sessions` 可 import `vs/workbench`，但 `vs/workbench` **禁止** import `vs/sessions`。

---

## 2. 架构设计原则

### 2.1 核心原则

| 原则 | 说明 | 实践 |
|------|------|------|
| **零上游侵入** | Agent Studio + OpenClaw 集成不新增上游修改 | 全部在 `sessions/contrib/agentStudio/` 内完成 |
| **替代而非新建** | 用已有 Agent Studio 替代 OpenClaw WebUI | 扩展 `agentChatService` 而非另建 extension |
| **协议桥接** | 统一内部协议，对接多种后端 | IChatStreamDelta 作为统一中间层 |
| **Gateway 独立** | Gateway 作为 sidecar 进程运行 | UtilityProcess 或外部进程管理 |
| **最小依赖** | 不引入 OpenClaw 全部代码 | 仅 sparse-checkout gateway + protocol 定义 |

### 2.2 "无 Extension" 策略

**之前方案**推荐建 `extensions/openclaw/`。**现在取消此方案**，理由：

1. Agent Studio 已在 sessions 层实现完整的 Provider + WebView + Services 体系
2. Extension 层增加了不必要的间接性（Extension Host ↔ Renderer IPC）
3. `ISessionsProvider` 机制本身就是扩展点，不需要额外的 Extension 封装
4. Sessions 层可直接访问 `IFileService`、`IConfigurationService` 等核心服务

---

## 3. Agent Studio 现有架构分析

### 3.1 文件清单

```
src/vs/sessions/contrib/agentStudio/
├── common/                          # 接口定义 + 类型
│   ├── agentStudio.ts              # IAgentStudioService, IAgentChatService, IAgentDelegationService, IAgentTaskBoardService
│   ├── types.ts                    # Employee, Workspace, ChatMessage, Delegation, ToolCall, TaskBoard...
│   └── constants.ts                # 配置 key、ViewContainer ID、ContextKey
├── browser/                         # Host 端实现
│   ├── agentStudio.contribution.ts # DI 注册 + ViewContainer 注册 + Provider 贡献
│   ├── agentStudioProvider.ts      # implements ISessionsProvider
│   ├── agentStudioService.ts       # 员工/工作区/会话 CRUD + 文件持久化
│   ├── agentChatService.ts         # ⭐ Knot AG-UI 协议翻译 + 16ms 帧节流
│   ├── agentDelegationService.ts   # 任务代理管理
│   ├── agentTaskBoardService.ts    # 任务板管理
│   ├── agentStudioEditorInput.ts   # EditorInput（canvas/chat/taskboard 三种）
│   ├── agentStudioEditorPane.ts    # EditorPane（承载 WebView）
│   ├── agentStudioViewPane.ts      # ViewPane（Canvas/Chat/TaskBoard）
│   ├── agentStudioSidebarView.ts   # Sidebar 会话列表
│   ├── agentStudioWebviewController.ts # WebView 消息路由 + 流事件推送
│   ├── delegationTreeView.ts       # 任务委托树视图
│   └── messageProtocol.ts          # Host ↔ WebView RPC 协议定义
└── webview/                         # React WebView 应用
    ├── src/
    │   ├── App.tsx
    │   ├── index.tsx
    │   ├── bridge/
    │   │   ├── messageClient.ts    # RPC 客户端（sendRequest/initMessageClient）
    │   │   └── streamHandler.ts    # 流状态管理（textBuffer/thinkingBuffer/toolCalls）
    │   ├── features/
    │   │   ├── canvas/             # WorkspaceCanvas, EmployeeNode, ConnectionEdge
    │   │   ├── chat/               # EmployeeChat, ChatMessage, StreamingText
    │   │   ├── delegation/         # AutoPlanDialog
    │   │   ├── employees/          # EmployeeCard, EmployeeForm, EmployeeList
    │   │   ├── sidebar/            # WorkspaceSidebar
    │   │   ├── taskboard/          # TaskBoardPanel, TaskCard
    │   │   └── title/              # WorkspaceToolbar
    │   ├── store/                   # Zustand 状态管理
    │   │   ├── useChatStore.ts
    │   │   ├── useDelegationStore.ts
    │   │   ├── useEmployeeStore.ts
    │   │   ├── useTaskBoardStore.ts
    │   │   └── useWorkspaceStore.ts
    │   └── styles/globals.css
    ├── node_modules/                # React, ReactFlow, Zustand, TailwindCSS...
    └── media/
```

### 3.2 核心服务接口

```typescript
// IAgentChatService — 聊天核心（需扩展为多后端）
interface IAgentChatService {
  sendMessage(employeeId, message, options, onDelta): Promise<ChatMessage>;
  getHistory(employeeId, sessionId?): Promise<ChatMessage[]>;
  clearHistory(employeeId, sessionId?): Promise<void>;
  cancelStream(employeeId): void;
}

// IChatStreamDelta — 统一的流事件协议
interface IChatStreamDelta {
  type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'done' | 'error';
  content?: string;
  toolCallId?: string;
  toolName?: string;
}

// IChatSendOptions — 发送选项
interface IChatSendOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  workspaceId?: string;
}
```

### 3.3 当前后端：Knot AG-UI

当前 `AgentChatService` 硬编码对接 Knot API：
- 端点：`https://knot.woa.com/api/v1/agents/{agentId}/chat`
- 认证：Bearer Token
- 响应：SSE (Server-Sent Events)
- 事件翻译：AG-UI 事件 → IChatStreamDelta

### 3.4 现有布局

```
Sessions Window 布局:
┌────────────────────────────────────────────────────────────┐
│ Sidebar (左)    │ ChatBar (主内容)    │ AuxiliaryBar (右) │
│ ──────────────  │ ────────────────    │ ────────────────  │
│ Sessions 列表   │ Workspace Canvas    │ Agent Chat        │
│ Workspaces 列表 │ (ReactFlow 画布)    │ Task Delegation   │
├─────────────────┴─────────────────────┴───────────────────┤
│ Panel (底部)                                               │
│ Task Board (看板)                                          │
└────────────────────────────────────────────────────────────┘

同时有 Dual Editor Layout:
┌──────────────────────┬─────────────────────┐
│ 左侧 (解锁)          │ 右侧 (锁定)         │
│ 普通文件编辑器        │ Canvas (tab)        │
│                      │ Chat (tab)          │
│                      │ TaskBoard (tab)     │
└──────────────────────┴─────────────────────┘
```

---

## 4. OpenClaw 集成策略（插件化架构）

### 4.1 集成定位（重构为插件架构）

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Agent Studio UI                                    │
│   (WebView: React + Zustand + ReactFlow + TailwindCSS)               │
├──────────────────────────────────┬──────────────────────────────────┤
│    agentStudioWebviewController  │  messageProtocol                   │
├──────────────────────────────────┴──────────────────────────────────┤
│              IAgentChatService (插件注册路由)                         │
│   ┌─────────────┐  ┌─────────────┐  ┌──────────────┐             │
│   │ KnotBackend │  │OpenClawBack │  │ DirectLLMBack│             │
│   │ (插件)      │  │ end(插件)   │  │ end(插件)    │             │
│   └──────┬──────┘  └──────┬──────┘  └──────┬───────┘             │
├──────────┼─────────────────┼─────────────────┼────────────────────┤
│          ▼                 ▼                 ▼                    │
│   Knot AG-UI API   OpenClaw Gateway    Direct Model API         │
│                    (插件独立进程)           (插件)                │
│                         │                                      │
│                         ▼                                      │
│              ┌──────────────────────┐                          │
│              │  OpenClaw 插件包       │                          │
│              │  (独立更新)            │                          │
│              │  ├── dist/            │                          │
│              │  ├── gateway/         │                          │
│              │  ├── runtime/         │                          │
│              │  └── package.json     │                          │
│              └──────────────────────┘                          │
└─────────────────────────────────────────────────────────────────────┘

关键变化：
1. OpenClaw Backend 不再是 sessions 层的一部分
2. 作为独立插件安装在 extensions/openclaw/
3. 通过 IAgentChatService.registerBackend() 注册
4. 插件可独立更新，不影响 sessions 层
```

### 4.2 插件化架构设计

#### 4.2.1 核心原则

| 原则 | 说明 | 实践 |
|------|------|------|
| **插件隔离** | OpenClaw 功能完全封装在插件内 | 所有 Gateway/Runtime/Protocol 代码在 `extensions/openclaw/` |
| **接口稳定** | `IChatBackend` 接口保持稳定 | 插件内部更新不影响 sessions 层 |
| **独立版本** | 插件有自己的版本号 | 可独立发布和更新 |
| **热插拔** | 支持运行时启用/禁用插件 | `registerBackend()` / `unregisterBackend()` |
| **依赖管理** | 插件声明 OpenClaw 版本依赖 | `package.json` 中指定 `@openclaw/*` 版本 |

#### 4.2.2 插件注册机制

```typescript
// 新增: common/chatBackendPlugin.ts
export interface IChatBackendPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly priority: number;

  // 生命周期
  activate(context: IChatBackendContext): Promise<void>;
  deactivate(): Promise<void>;

  // 后端实例
  createBackend(): IChatBackend;

  // 版本信息
  getOpenClawVersion(): string;
  getSupportedFeatures(): string[];
}

export interface IChatBackendContext {
  readonly extensionPath: string;
  readonly globalStoragePath: string;
  readonly workspaceStoragePath: string;

  // VSCode 服务
  readonly configurationService: IConfigurationService;
  readonly logService: ILogService;
  readonly notificationService: INotificationService;

  // 注册后端
  registerBackend(backend: IChatBackend): void;
  unregisterBackend(backendId: string): void;
}

// 插件示例：OpenClaw Backend Plugin
export class OpenClawBackendPlugin implements IChatBackendPlugin {
  readonly id = 'openclaw-backend';
  readonly name = 'OpenClaw Backend';
  readonly version = '1.2.0'; // 插件版本（独立）
  readonly priority = 10;

  private _backend: OpenClawBackend | undefined;

  async activate(context: IChatBackendContext): Promise<void> {
    // 1. 检查 OpenClaw 依赖是否满足
    await this._checkDependencies(context);

    // 2. 创建后端实例
    this._backend = new OpenClawBackend({
      gatewayService: await this._createGatewayService(context),
      logService: context.logService,
    });

    // 3. 注册到 AgentChatService
    context.registerBackend(this._backend);

    // 4. 启动 Gateway（如果配置为自动启动）
    if (context.configurationService.getValue('openclaw.gateway.autoStart')) {
      await this._backend.startGateway();
    }
  }

  async deactivate(): Promise<void> {
    if (this._backend) {
      await this._backend.stopGateway();
      this._backend = undefined;
    }
  }

  createBackend(): IChatBackend {
    return this._backend!;
  }

  getOpenClawVersion(): string {
    // 从 package.json 读取
    return require('../package.json').dependencies['@openclaw/gateway'];
  }

  getSupportedFeatures(): string[] {
    return [
      'chat',
      'tool_calls',
      'canvas',
      'file_operations',
      'thinking',
    ];
  }

  private async _checkDependencies(context: IChatBackendContext): Promise<void> {
    const requiredVersion = '^1.0.0';
    const currentVersion = this.getOpenClawVersion();

    if (!semver.satisfies(currentVersion, requiredVersion)) {
      throw new Error(`OpenClaw version ${currentVersion} does not satisfy ${requiredVersion}`);
    }
  }

  private async _createGatewayService(context: IChatBackendContext): Promise<IOpenClawGatewayService> {
    // 创建 Gateway 服务实例
    // 这现在是插件内部实现，不依赖 sessions 层
    return new OpenClawGatewayService({
      port: context.configurationService.getValue('openclaw.gateway.port'),
      logService: context.logService,
    });
  }
}
```

#### 4.2.3 插件目录结构

```
extensions/openclaw/
├── package.json                # 插件 manifest + 依赖声明
├── README.md                  # 插件文档
├── CHANGELOG.md               # 版本更新日志
├── src/
│   ├── extension.ts          # 插件入口（activate/deactivate）
│   ├── backend/
│   │   ├── openclawBackend.ts         # IChatBackend 实现
│   │   ├── openclawGatewayService.ts  # Gateway 生命周期管理
│   │   └── eventTranslator.ts        # OpenClaw → IChatStreamDelta
│   ├── runtime/
│   │   ├── agentRuntime.ts           # Agent 运行时（从 OpenClaw 移植）
│   │   ├── skillLoader.ts            # Skill 加载器
│   │   └── toolRegistry.ts           # 工具注册表
│   ├── protocol/
│   │   ├── types.ts                 # OpenClaw 协议类型定义
│   │   └── streamProcessor.ts       # 流式响应处理
│   └── utils/
│       ├── versionChecker.ts         # 版本兼容性检查
│       └── dependencyManager.ts      # 依赖管理
├── dist/                       # 编译产物
│   ├── extension.js
│   ├── backend.js
│   └── runtime.js
├── gateway/                    # OpenClaw Gateway 可执行文件
│   ├── bin/
│   │   └── openclaw-gateway   # (从 @openclaw/gateway 编译)
│   └── config/
│       └── gateway.yaml        # 默认配置
├── node_modules/               # 插件独立依赖
│   ├── @openclaw/gateway/     # OpenClaw Gateway 包
│   ├── @openclaw/runtime/     # OpenClaw Runtime 包
│   └── @openclaw/protocol/    # OpenClaw Protocol 包
└── resources/
    ├── icon.svg
    └── sounds/                # 通知音效
```

### 4.3 插件 Manifest (package.json)

```json
{
  "name": "openclaw-backend",
  "displayName": "OpenClaw Backend for Agent Studio",
  "version": "1.2.0",
  "description": "OpenClaw Gateway integration for Agent Studio",
  "publisher": "sarosis",
  "engines": {
    "vscode": "^1.85.0",
    "agent-studio": "^0.5.0"
  },
  "main": "./dist/extension.js",
  "activationEvents": [
    "onCommand:openclaw.startGateway",
    "onCommand:openclaw.stopGateway"
  ],
  "contributes": {
    "configuration": {
      "type": "object",
      "title": "OpenClaw",
      "properties": {
        "openclaw.gateway.port": {
          "type": "number",
          "default": 9876,
          "description": "OpenClaw Gateway 监听端口"
        },
        "openclaw.gateway.autoStart": {
          "type": "boolean",
          "default": true,
          "description": "启动时自动启动 Gateway"
        },
        "openclaw.gateway.binaryPath": {
          "type": "string",
          "default": "",
          "description": "Gateway 可执行文件路径（留空使用内置）"
        }
      }
    },
    "commands": [
      {
        "command": "openclaw.startGateway",
        "title": "OpenClaw: Start Gateway"
      },
      {
        "command": "openclaw.stopGateway",
        "title": "OpenClaw: Stop Gateway"
      },
      {
        "command": "openclaw.checkUpdate",
        "title": "OpenClaw: Check for Updates"
      }
    ]
  },
  "dependencies": {
    "@openclaw/gateway": "^1.0.0",
    "@openclaw/runtime": "^1.0.0",
    "@openclaw/protocol": "^1.0.0",
    "@openclaw/skills-core": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "watch": "tsc -p tsconfig.json -w",
    "package": "vsce package",
    "publish": "vsce publish"
  }
}
```

### 4.4 从 OpenClaw 仅需要什么（更新）

| OpenClaw 组件 | 是否需要 | 如何获取 | 更新策略 |
|---------------|----------|----------|----------|
| Client (WebUI) | ❌ **不需要** | - | - |
| Gateway | ✅ **需要** | `@openclaw/gateway` npm 包 | `npm update @openclaw/gateway` |
| Agent Runtime | ✅ **需要** | `@openclaw/runtime` npm 包 | `npm update @openclaw/runtime` |
| 协议定义 | ✅ **需要** | `@openclaw/protocol` npm 包 | 自动跟随 runtime 更新 |
| Skills Core | ✅ **需要** | `@openclaw/skills-core` npm 包 | 独立更新 |
| 配置文件格式 | ✅ **需要** | 内置在插件中 | 插件版本更新 |

**关键变化**：
1. 不再使用 git submodule
2. 使用 npm 包管理 OpenClaw 依赖
3. 更新 OpenClaw 只需更新 npm 包
4. 插件重新编译后即可使用新版本

### 4.5 插件更新机制

#### 4.5.1 自动更新流程

```
┌─────────────────────────────────────────────────────────────┐
│                    插件更新流程                                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. 检测更新（每日一次）                                      │
│     │                                                       │
│     ▼                                                       │
│  2. 查询 npm registry                                       │
│     │  GET https://registry.npmjs.org/@openclaw/gateway    │
│     │                                                       │
│     ▼                                                       │
│  3. 比较版本                                               │
│     │  current: 1.0.0                                      │
│     │  latest:  1.2.0                                      │
│     │                                                       │
│     ├─ 有更新 → 继续                                      │
│     └─ 无更新 → 结束                                       │
│             │                                               │
│             ▼                                               │
│  4. 下载新版本包                                           │
│     │  npm pack @openclaw/gateway@1.2.0                    │
│     │                                                       │
│     ▼                                                       │
│  5. 验证完整性                                             │
│     │  - checksum                                          │
│     │  - signature                                         │
│     │                                                       │
│     ▼                                                       │
│  6. 更新 package.json                                      │
│     │  "dependencies": {                                    │
│     │    "@openclaw/gateway": "^1.2.0"                    │
│     │  }                                                    │
│     │                                                       │
│     ▼                                                       │
│  7. 重新编译插件                                           │
│     │  npm install                                          │
│     │  npm run build                                        │
│     │                                                       │
│     ▼                                                       │
│  8. 提示用户重启 VSCode                                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

#### 4.5.2 手动更新命令

```typescript
// 用户执行：Ctrl+Shift+P → "OpenClaw: Check for Updates"

async function checkForUpdates(): Promise<void> {
  const currentVersion = getInstalledVersion('@openclaw/gateway');
  const latestVersion = await fetchLatestVersion('@openclaw/gateway');

  if (semver.gt(latestVersion, currentVersion)) {
    const result = await showInformationMessage(
      `OpenClaw Gateway ${latestVersion} is available (current: ${currentVersion}). Update now?`,
      'Update',
      'Later',
      'Release Notes'
    );

    if (result === 'Update') {
      await updateOpenClawPackages();
      await recompilePlugin();
      showInformationMessage('Update complete. Please reload VSCode.');
    }
  } else {
    showInformationMessage('OpenClaw is up to date.');
  }
}

async function updateOpenClawPackages(): Promise<void> {
  const packages = [
    '@openclaw/gateway',
    '@openclaw/runtime',
    '@openclaw/protocol',
    '@openclaw/skills-core',
  ];

  for (const pkg of packages) {
    await execCommand('npm', ['install', `${pkg}@latest`, '--save']);
  }
}
```

#### 4.5.3 版本锁定策略

```json
// package.json 中的版本策略
{
  "dependencies": {
    "@openclaw/gateway": "^1.0.0",     // 允许 minor + patch 更新
    "@openclaw/runtime": "~1.0.0",     // 仅允许 patch 更新
    "@openclaw/protocol": "1.0.0"      // 锁定精确版本
  }
}
```

**推荐策略**：
- **开发阶段**：使用 `^1.0.0` 自动获取新功能
- **生产环境**：使用 `~1.0.0` 仅获取 bug 修复
- **关键版本**：锁定精确版本 `1.0.0`

### 4.6 插件与 sessions 层的交互

#### 4.6.1 依赖方向（重要）

```
✅ 正确方向：
   extensions/openclaw/  → 依赖 →  sessions/ (接口)

❌ 错误方向：
   sessions/  → 依赖 →  extensions/openclaw/

原则：
- sessions/ 定义接口（IChatBackend, IAgentChatService）
- extensions/openclaw/ 实现接口
- sessions/ 不知道具体实现细节
```

#### 4.6.2 接口稳定性

```typescript
// sessions/common/chatBackend.ts (稳定接口）
export interface IChatBackend {
  readonly id: string;
  readonly label: string;
  readonly priority: number;

  isAvailable(): Promise<boolean>;
  sendMessage(...): Promise<ChatMessage>;
  cancelStream(employeeId: string): void;
}

// 接口变更策略：
// - 新增方法 → OK（向后兼容）
// - 修改方法签名 → 大版本更新（v1 → v2）
// - 删除方法 → 大版本更新
```

#### 4.6.3 插件加载流程

```typescript
// sessions/browser/agentChatService.ts
export class AgentChatService extends Disposable implements IAgentChatService {
  private readonly _backendPlugins = new Map<string, IChatBackendPlugin>();

  // 加载插件
  async loadBackendPlugin(pluginPath: string): Promise<void> {
    try {
      // 1. 动态导入插件
      const pluginModule = await import(pluginPath);
      const plugin: IChatBackendPlugin = new pluginModule.default();

      // 2. 检查依赖
      await this._checkPluginDependencies(plugin);

      // 3. 激活插件
      const context = this._createPluginContext(plugin);
      await plugin.activate(context);

      // 4. 注册插件
      this._backendPlugins.set(plugin.id, plugin);

      // 5. 注册后端
      const backend = plugin.createBackend();
      this.registerBackend(backend);

    } catch (error) {
      this._logService.error(`Failed to load plugin: ${pluginPath}`, error);
    }
  }

  // 卸载插件
  async unloadBackendPlugin(pluginId: string): Promise<void> {
    const plugin = this._backendPlugins.get(pluginId);
    if (plugin) {
      await plugin.deactivate();
      this.unregisterBackend(plugin.createBackend().id);
      this._backendPlugins.delete(pluginId);
    }
  }

  private async _checkPluginDependencies(plugin: IChatBackendPlugin): Promise<void> {
    const openclawVersion = plugin.getOpenClawVersion();

    // 检查 OpenClaw 版本兼容性
    if (!this._isOpenClawVersionSupported(openclawVersion)) {
      throw new Error(`OpenClaw version ${openclawVersion} is not supported`);
    }
  }
}
```

### 4.7 多插件管理

#### 4.7.1 插件注册表

```typescript
// sessions/common/backendPluginRegistry.ts
export interface IBackendPluginRegistry {
  // 注册插件
  registerPlugin(plugin: IChatBackendPlugin): void;

  // 获取插件
  getPlugin(pluginId: string): IChatBackendPlugin | undefined;

  // 获取所有插件
  getAllPlugins(): IChatBackendPlugin[];

  // 启用/禁用插件
  enablePlugin(pluginId: string): Promise<void>;
  disablePlugin(pluginId: string): Promise<void>;

  // 插件状态
  getPluginStatus(pluginId: string): PluginStatus;
}

export enum PluginStatus {
  Active = 'active',
  Disabled = 'disabled',
  Error = 'error',
  UpdateAvailable = 'update_available',
}
```

#### 4.7.2 插件冲突处理

```typescript
// 场景：多个插件提供相同后端 ID
export class PluginConflictResolver {
  resolve(conflicts: IChatBackendPlugin[]): IChatBackendPlugin {
    // 策略1：优先级高的插件胜出
    const byPriority = conflicts.sort((a, b) => b.priority - a.priority);

    // 策略2：用户手动选择（显示 UI）
    if (byPriority.length > 1) {
      this._showConflictDialog(conflicts);
      return byPriority[0]; // 默认选择最高优先级
    }

    return byPriority[0];
  }

  private async _showConflictDialog(plugins: IChatBackendPlugin[]): Promise<void> {
    const items = plugins.map(p => ({
      label: p.name,
      description: `v${p.version} (priority: ${p.priority})`,
      detail: `OpenClaw v${p.getOpenClawVersion()}`,
    }));

    const selected = await showQuickPick(items, {
      placeHolder: 'Multiple plugins provide the same backend. Select one:',
    });

    // 用户选择后，禁用未选择的插件
  }
}
```

### 4.8 与现有架构的对比

| 维度 | 旧方案 (v2) | 新方案 (插件化) |
|------|-------------|----------------|
| **OpenClaw 位置** | `vendor/openclaw/` (submodule) | `extensions/openclaw/` (npm 包) |
| **更新方式** | `git submodule update` | `npm update @openclaw/*` |
| **编译方式** | 重新编译整个 VSCode | 仅重新编译插件 |
| **依赖管理** | sparse-checkout | package.json |
| **版本锁定** | git commit hash | semver |
| **多版本并存** | ❌ 不支持 | ✅ 支持（不同插件） |
| **回滚** | `git checkout` | `npm install @openclaw/gateway@1.0.0` |
| **发布** | 内部发布 | VSCode Marketplace |

### 4.9 实施步骤

#### Phase 1：插件骨架（1 周）

1. 创建 `extensions/openclaw/package.json`
2. 定义 `IChatBackendPlugin` 接口
3. 实现基本的 `OpenClawBackendPlugin` 类
4. 创建插件目录结构

#### Phase 2：依赖管理（1 周）

1. 发布 `@openclaw/gateway` npm 包
2. 发布 `@openclaw/runtime` npm 包
3. 发布 `@openclaw/protocol` npm 包
4. 配置插件依赖

#### Phase 3：更新机制（1 周）

1. 实现自动更新检测
2. 实现手动更新命令
3. 实现版本锁定策略
4. 测试回滚流程

#### Phase 4：多插件支持（1 周）

1. 实现插件注册表
2. 实现插件冲突处理
3. 实现插件启用/禁用
4. UI 管理界面

#### Phase 5：发布准备（0.5 周）

1. 打包插件（vsce package）
2. 发布到 VSCode Marketplace
3. 编写用户文档
4. 编写开发者文档

### 4.10 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| npm 包发布延迟 | 中 | 高 | 使用 npm 私有仓库 + 缓存 |
| 版本冲突 | 高 | 中 | 严格的 semver + 冲突检测 |
| 插件 API 变更 | 中 | 高 | 接口版本化 + 弃用期 |
| 依赖膨胀 | 低 | 低 | 定期审计 + 清理 |
| 安全漏洞 | 低 | 高 | npm audit + 自动更新 |

---

**关键优势**：
1. ✅ **独立更新**：OpenClaw 更新不影响 sessions 层
2. ✅ **版本管理**：semver 自动处理版本兼容性
3. ✅ **易于分发**：通过 VSCode Marketplace 一键安装
4. ✅ **多版本并存**：不同插件可以使用不同 OpenClaw 版本
5. ✅ **开发友好**：插件可以独立开发和测试

---

## 5. 优化后的目录结构（插件化架构）

### 5.1 完整目录树

```
sarosis-agents-client/
├── src/vs/sessions/contrib/agentStudio/    # ⭐ 核心集成区域（插件接口定义）
│   ├── common/                             # 接口定义（稳定，不常变更）
│   │   ├── agentStudio.ts                 # IAgentChatService, IAgentStudioService
│   │   ├── chatBackend.ts                 # 🆕 IChatBackend 接口（稳定）
│   │   ├── chatBackendPlugin.ts           # 🆕 IChatBackendPlugin 接口（稳定）
│   │   ├── types.ts                       # 通用类型定义
│   │   └── constants.ts                   # 配置 key 定义
│   ├── browser/                            # Host 端实现（插件加载器）
│   │   ├── agentStudio.contribution.ts    # 注册中心
│   │   ├── agentChatService.ts            # 多后端路由（加载插件）
│   │   ├── agentStudioService.ts          # 员工/工作区管理
│   │   ├── backendPluginRegistry.ts        # 🆕 插件注册表
│   │   ├── backends/                       # 内置后端（可选）
│   │   │   └── knotBackend.ts            # Knot 后端（示例）
│   │   └── ... (其他已有文件保持不变)
│   └── webview/                            # React WebView（通用 UI）
│       ├── src/
│       │   ├── features/                   # UI 组件（与后端无关）
│       │   ├── store/                      # 状态管理
│       │   └── bridge/                    # 消息桥
│       └── node_modules/
│
├── extensions/openclaw/                     # 🆕 OpenClaw 插件（独立更新）
│   ├── package.json                        # 插件 manifest + 依赖声明
│   ├── README.md                          # 插件文档
│   ├── CHANGELOG.md                       # 版本更新日志
│   ├── src/
│   │   ├── extension.ts                  # 插件入口（activate/deactivate）
│   │   ├── backend/
│   │   │   ├── openclawBackend.ts       # IChatBackend 实现
│   │   │   ├── openclawGatewayService.ts # Gateway 生命周期
│   │   │   └── eventTranslator.ts      # OpenClaw → IChatStreamDelta
│   │   ├── runtime/                      # OpenClaw Runtime（从 npm 包）
│   │   ├── protocol/                     # 协议定义（从 npm 包）
│   │   └── utils/
│   │       ├── versionChecker.ts         # 版本兼容性检查
│   │       └── dependencyManager.ts      # 依赖管理
│   ├── dist/                             # 编译产物
│   │   ├── extension.js
│   │   ├── backend.js
│   │   └── runtime.js
│   ├── gateway/                          # OpenClaw Gateway 可执行文件
│   │   ├── bin/
│   │   │   └── openclaw-gateway       # (从 @openclaw/gateway 编译)
│   │   └── config/
│   │       └── gateway.yaml            # 默认配置
│   ├── node_modules/                     # 插件独立依赖
│   │   ├── @openclaw/gateway/         # OpenClaw Gateway 包
│   │   ├── @openclaw/runtime/         # OpenClaw Runtime 包
│   │   └── @openclaw/protocol/        # OpenClaw Protocol 包
│   └── resources/
│       ├── icon.svg
│       └── sounds/
│
├── extensions/knot/                        # 🆕 Knot 后端插件（可选示例）
│   ├── package.json
│   ├── src/
│   │   ├── extension.ts
│   │   └── knotBackend.ts
│   └── dist/
│
├── scripts/                                # 构建 & 更新脚本
│   ├── openclaw-plugin-update.sh         # 🆕 更新 OpenClaw 插件
│   ├── openclaw-check-versions.sh        # 🆕 检查 OpenClaw 版本
│   └── ... (现有 VSCode 构建脚本)
│
├── patches/vscode/                         # 上游补丁（如需添加新补丁）
│   ├── 001-utilityProcess-lifecycle.patch  # 对应修改 A
│   └── 002-chat-entitlement-api.patch     # 对应修改 B+C+D+E+F
│
└── ... (VSCode 其余文件保持不变)
```

**关键变化**：
1. ❌ 移除 `vendor/openclaw/` （不再使用 git submodule）
2. ✅ 新增 `extensions/openclaw/` （插件化，独立更新）
3. ✅ OpenClaw 依赖通过 npm 包管理（`@openclaw/*`）
4. ✅ 插件可独立编译、打包、发布、更新

### 5.2 与旧方案对比

| 维度 | 旧方案 (v2) | 新方案 (插件化) |
|------|-------------|----------------|
| **OpenClaw 位置** | `vendor/openclaw/` (submodule) | `extensions/openclaw/` (npm 包) |
| **更新方式** | `git submodule update` | `npm update @openclaw/*` |
| **编译方式** | 重新编译整个 VSCode | 仅重新编译插件 |
| **依赖管理** | sparse-checkout | package.json |
| **版本锁定** | git commit hash | semver (^1.0.0) |
| **多版本并存** | ❌ 不支持 | ✅ 支持（不同插件） |
| **回滚** | `git checkout` | `npm install @openclaw/gateway@1.0.0` |
| **发布** | 内部发布 | VSCode Marketplace |
| **接口稳定性** | 需同步更新 | 接口稳定，插件独立更新 |

### 5.3 文件增量清单（插件化）

需要**新建**的文件/目录（共 12 个）：

| 文件/目录 | 用途 | 优先级 |
|-----------|------|--------|
| `extensions/openclaw/package.json` | 插件 manifest + 依赖声明 | P0 |
| `extensions/openclaw/src/extension.ts` | 插件入口（activate/deactivate） | P0 |
| `extensions/openclaw/src/backend/openclawBackend.ts` | IChatBackend 实现 | P0 |
| `extensions/openclaw/src/backend/openclawGatewayService.ts` | Gateway 生命周期 | P0 |
| `src/vs/sessions/contrib/agentStudio/common/chatBackendPlugin.ts` | IChatBackendPlugin 接口 | P0 |
| `src/vs/sessions/contrib/agentStudio/browser/backendPluginRegistry.ts` | 插件注册表 | P1 |
| `extensions/openclaw/src/utils/versionChecker.ts` | 版本兼容性检查 | P1 |
| `extensions/openclaw/src/utils/dependencyManager.ts` | 依赖管理 | P1 |
| `scripts/openclaw-plugin-update.sh` | 更新 OpenClaw 插件 | P1 |
| `scripts/openclaw-check-versions.sh` | 检查 OpenClaw 版本 | P2 |
| `extensions/openclaw/README.md` | 插件文档 | P2 |
| `extensions/openclaw/CHANGELOG.md` | 版本更新日志 | P2 |

需要**修改**的文件（共 4 个）：

| 文件 | 修改内容 |
|------|----------|
| `src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts` | 支持加载外部插件 |
| `src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts` | 注册插件加载逻辑 |
| `src/vs/sessions/contrib/agentStudio/common/constants.ts` | 添加插件配置 key |
| `package.json` (根目录) | 新增 workspaces 配置（monorepo） |

需要**移除**的文件/目录：

| 文件/目录 | 原因 |
|-----------|------|
| `vendor/openclaw/` | 不再使用 git submodule |
| `scripts/openclaw-update.sh` (旧) | 替换为 npm 更新机制 |
| `scripts/openclaw-build-gateway.sh` (旧) | Gateway 现在在插件内编译 |

### 5.4 插件依赖关系

```
┌─────────────────────────────────────────────────────────┐
│                    package.json (根目录)                  │
│  {                                                      │
│    "workspaces": [                                      │
│      "extensions/*"                                     │
│    ]                                                    │
│  }                                                      │
└───────────────────────┬─────────────────────────────────┘
                        │ npm install (根目录)
                        ▼
┌─────────────────────────────────────────────────────────┐
│            node_modules/ (根目录, hoisted)                │
│  ├── @openclaw/gateway/    ← 共享依赖                   │
│  ├── @openclaw/runtime/    ← 共享依赖                   │
│  └── @openclaw/protocol/   ← 共享依赖                   │
└───────────────────────┬─────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ extensions/  │ │ extensions/  │ │ extensions/  │
│ openclaw/    │ │ knot/        │ │ future/      │
│              │ │              │ │ backend/      │
│ package.json │ │ package.json │ │              │
│ "dependencies"│ │ "dependencies"│ │ package.json │
│ {            │ │ {            │ │ {            │
│  "@openclaw/ │ │  "..."      │ │  "..."      │
│  gateway":    │ │              │ │              │
│  "^1.0.0"   │ │              │ │              │
│ }            │ │              │ │              │
└──────────────┘ └──────────────┘ └──────────────┘
```

**优势**：
1. ✅ **依赖提升**：共享依赖只在根目录安装一次
2. ✅ **独立更新**：每个插件可以有不同的 `@openclaw/*` 版本
3. ✅ **版本隔离**：插件 A 用 `@openclaw/gateway@1.0.0`，插件 B 用 `@openclaw/gateway@1.2.0`
4. ✅ **简化更新**：`cd extensions/openclaw && npm update`

---

## 6. 数据流与通信协议

### 6.1 完整数据流

```
用户输入 "写一个排序算法"
         │
         ▼
┌─────────────────────────────┐
│ WebView (React)              │
│ useChatStore.sendMessage()   │
│ messageClient.sendRequest()  │
│ → postMessage('chat.send')   │
└────────────┬────────────────┘
             │ window.postMessage
             ▼
┌─────────────────────────────┐
│ Host: WebviewController      │
│ _dispatch('chat.send')       │
│ → agentChatService.send()    │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│ AgentChatService (路由)       │
│ activeBackend = 'openclaw'   │
│ → openclawBackend.send()     │
└────────────┬────────────────┘
             │ HTTP POST / WebSocket
             ▼
┌─────────────────────────────┐
│ OpenClaw Gateway (sidecar)   │
│ Session Manager              │
│ Tool Registry                │
│ → Agent Runtime              │
└────────────┬────────────────┘
             │ SSE stream
             ▼
┌─────────────────────────────┐
│ OpenClawBackend._translate() │
│ OpenClaw events → IChatStream│
│ Delta (统一协议)              │
│ 16ms 帧节流                  │
└────────────┬────────────────┘
             │ onDelta callback
             ▼
┌─────────────────────────────┐
│ WebviewController            │
│ _sendEvent('chat.stream.    │
│ delta', { chunks })          │
└────────────┬────────────────┘
             │ postMessage
             ▼
┌─────────────────────────────┐
│ WebView: streamHandler       │
│ → textBuffer += content      │
│ → React 组件重渲染            │
│ → 用户看到流式输出            │
└─────────────────────────────┘
```

### 6.2 IChatStreamDelta 统一协议

无论后端是 Knot、OpenClaw 还是直连 LLM，UI 层只看到统一的 IChatStreamDelta：

```typescript
// 事件类型对照表
| IChatStreamDelta.type | Knot AG-UI 事件              | OpenClaw 事件                    |
|-----------------------|------------------------------|----------------------------------|
| 'text'                | TEXT_MESSAGE_CONTENT         | message.content.delta            |
| 'thinking'            | THINKING_TEXT_MESSAGE_CONTENT | message.thinking.delta           |
| 'tool_start'          | TOOL_CALL_START              | tool.call.start                  |
| 'tool_args'           | TOOL_CALL_ARGS               | tool.call.args                   |
| 'tool_end'            | TOOL_CALL_END                | tool.call.end                    |
| 'tool_result'         | TOOL_CALL_RESULT             | tool.result                      |
| 'done'                | (stream end)                 | run.finished                     |
| 'error'               | RUN_ERROR                    | run.error                        |
```

### 6.3 OpenClaw 特有能力扩展

OpenClaw 提供的能力超出 Knot 的部分，需要扩展 IChatStreamDelta：

```typescript
// 新增 delta types（向前兼容）
interface IChatStreamDelta {
  type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result'
      | 'done' | 'error'
      | 'canvas_update'    // 🆕 Canvas/Artifact 内容更新
      | 'file_change'      // 🆕 文件系统变更通知
      | 'approval_request' // 🆕 需要用户确认的操作
      ;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;  // 🆕 扩展数据
}
```

---

## 7. Gateway 进程管理

### 7.1 进程策略

```typescript
// browser/gateway/openclawGatewayService.ts

export const IOpenClawGatewayService = createDecorator<IOpenClawGatewayService>('openclawGatewayService');

export interface IOpenClawGatewayService {
  readonly _serviceBrand: undefined;

  // Lifecycle
  readonly onDidChangeStatus: Event<GatewayStatus>;
  readonly status: GatewayStatus;

  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;

  // Health
  isRunning(): boolean;
  getEndpoint(): string;  // e.g., "http://localhost:9876"

  // Configuration
  getConfig(): GatewayConfig;
  updateConfig(config: Partial<GatewayConfig>): Promise<void>;
}

export const enum GatewayStatus {
  Stopped = 'stopped',
  Starting = 'starting',
  Running = 'running',
  Error = 'error',
}

export interface GatewayConfig {
  port: number;           // 默认 9876
  host: string;           // 默认 127.0.0.1
  modelProviders: ModelProviderConfig[];
  tools: ToolConfig[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}
```

### 7.2 进程管理器

两种模式供选择：

**模式 A：UtilityProcess（推荐，进程内管理）**

```typescript
// 利用 VSCode 已有的 UtilityProcess 机制
// Gateway 作为 Node.js worker 运行在 UtilityProcess 中
class GatewayProcessManager {
  private _process: IUtilityProcessWorker | undefined;

  async spawn(): Promise<void> {
    this._process = await utilityProcessWorkerService.createWorker({
      moduleId: 'vs/sessions/contrib/agentStudio/browser/gateway/gatewayWorker',
      type: 'openclawGateway',
    });
  }
}
```

**模式 B：External Process（简单，适合开发阶段）**

```typescript
// Gateway 作为外部 Node 进程运行
class GatewayProcessManager {
  private _childProcess: ChildProcess | undefined;

  async spawn(): Promise<void> {
    const gatewayBin = path.join(vendorPath, 'openclaw/dist/gateway');
    this._childProcess = cp.spawn(gatewayBin, ['--port', '9876'], {
      env: { ...process.env, OPENCLAW_CONFIG: configPath },
    });
  }
}
```

### 7.3 配置项

```typescript
// 新增配置 (constants.ts)
export const OPENCLAW_GATEWAY_ENABLED_SETTING = 'sessions.agentStudio.openclaw.enabled';
export const OPENCLAW_GATEWAY_PORT_SETTING = 'sessions.agentStudio.openclaw.port';
export const OPENCLAW_GATEWAY_AUTO_START_SETTING = 'sessions.agentStudio.openclaw.autoStart';
export const OPENCLAW_GATEWAY_MODEL_PROVIDER_SETTING = 'sessions.agentStudio.openclaw.modelProvider';
export const OPENCLAW_GATEWAY_BIN_PATH_SETTING = 'sessions.agentStudio.openclaw.binaryPath';
```

---

## 8. 迁移计划

### Phase 0：准备工作（0.5 天）

| 步骤 | 操作 | 验证 |
|------|------|------|
| 0.1 | 创建 `patches/vscode/` 目录，生成当前 6 个文件的 patch | `git format-patch` 成功 |
| 0.2 | 确认 upstream remote 指向正确 | `git remote -v` |
| 0.3 | 创建开发分支 `feature/openclaw-gateway-integration` | 分支存在 |

### Phase 1：后端抽象重构（1-2 天）

**目标**：将 `AgentChatService` 重构为多后端路由，不影响现有 Knot 功能。

| 步骤 | 操作 | 文件 |
|------|------|------|
| 1.1 | 定义 `IChatBackend` 接口 | `common/chatBackend.ts` 🆕 |
| 1.2 | 抽取现有 Knot 逻辑为 `KnotBackend` | `browser/backends/knotBackend.ts` 🆕 |
| 1.3 | 重构 `AgentChatService` 为路由器 | `browser/agentChatService.ts` ✏️ |
| 1.4 | 在 contribution 中注册 KnotBackend | `browser/agentStudio.contribution.ts` ✏️ |
| 1.5 | 端到端测试：Knot 后端功能不退化 | 手动测试 |

**验证标准**：
- ✅ 现有 Knot 聊天功能正常
- ✅ `AgentChatService` 暴露 `registerBackend()`
- ✅ 后端切换 API 可用

---

## 9. Git 管理与更新策略（插件化架构）

### 9.1 插件更新流程（npm 包管理）

#### 9.1.1 自动更新脚本

```bash
#!/bin/bash
# scripts/openclaw-plugin-update.sh

set -e

echo "=== Updating OpenClaw Plugin ==="

# 1. 进入插件目录
cd extensions/openclaw

# 2. 检查当前版本
CURRENT_VERSION=$(node -e "console.log(require('./package.json').dependencies['@openclaw/gateway'])")
echo "Current @openclaw/gateway version: $CURRENT_VERSION"

# 3. 更新 OpenClaw 依赖包
echo "=== Updating OpenClaw packages ==="
npm update @openclaw/gateway @openclaw/runtime @openclaw/protocol @openclaw/skills-core

# 4. 重新编译插件
echo "=== Rebuilding plugin ==="
npm run build

# 5. 验证编译结果
if [ $? -eq 0 ]; then
    # 6. 提交更新
    cd ../..
    git add extensions/openclaw/package.json extensions/openclaw/package-lock.json
    git commit -m "chore: update openclaw plugin to $(cd extensions/openclaw && npm view @openclaw/gateway version)"
    echo "✅ OpenClaw plugin updated successfully"
else
    echo "❌ Build failed! Please check the errors above."
    exit 1
fi
```

#### 9.1.2 手动更新命令

```bash
# 更新到最新版本
cd extensions/openclaw
npm update @openclaw/gateway
npm run build

# 更新到特定版本
cd extensions/openclaw
npm install @openclaw/gateway@1.2.0 --save
npm run build

# 回滚到之前版本
cd extensions/openclaw
npm install @openclaw/gateway@1.0.0 --save
npm run build
```

#### 9.1.3 版本检查脚本

```bash
#!/bin/bash
# scripts/openclaw-check-versions.sh

echo "=== OpenClaw Version Check ==="

# 1. 检查已安装版本
echo "Installed versions:"
cd extensions/openclaw
node -e "
const pkg = require('./package.json');
console.log('  @openclaw/gateway:', pkg.dependencies['@openclaw/gateway']);
console.log('  @openclaw/runtime:', pkg.dependencies['@openclaw/runtime']);
console.log('  @openclaw/protocol:', pkg.dependencies['@openclaw/protocol']);
"

# 2. 检查最新版本
echo ""
echo "Latest versions:"
npm view @openclaw/gateway version
npm view @openclaw/runtime version
npm view @openclaw/protocol version

# 3. 检查是否有更新
echo ""
echo "Update status:"
npm outdated @openclaw/* --prefix extensions/openclaw
```

### 9.2 VSCode Upstream 同步流程

```bash
#!/bin/bash
# scripts/vscode-upstream-sync.sh

set -e

echo "=== Syncing with VSCode upstream ==="

# 1. Fetch upstream
git fetch upstream main

# 2. 尝试合并
git merge upstream/main --no-commit --no-ff

# 3. 检查冲突数
CONFLICTS=$(git diff --name-only --diff-filter=U | wc -l)

if [ $CONFLICTS -eq 0 ]; then
    git commit -m "merge: sync with vscode upstream $(date +%Y-%m-%d)"
    echo "✅ Clean merge"
else
    echo "⚠️  $CONFLICTS conflicts detected"
    echo "Conflicting files:"
    git diff --name-only --diff-filter=U
    echo ""
    echo "Since we only modify 6 upstream files, conflicts should be minimal."
    echo "Please resolve manually and commit."
fi
```

**注意**：插件目录 `extensions/openclaw/` 不受 VSCode upstream 同步影响，因为插件是独立的。

### 9.3 补丁管理

由于实际只有 6 个上游修改，且都是必要的，**补丁策略简化为**：

```
patches/vscode/
├── 001-utilityProcess-lifecycle.patch    # 修改 A (内存泄漏修复)
└── 002-chat-entitlement-api.patch       # 修改 B+C+D+E+F (API 重构 + 适配)
```

补丁仅作为**文档和回退手段**，不用于日常开发流程。日常开发直接在源码上修改，仅在需要提交回上游时生成 patch。

**插件补丁管理**：
- 插件内部如需修改 OpenClaw 源码，应在 `@openclaw/*` npm 包中提交 PR
- 或 fork `@openclaw/*` 包，在 `package.json` 中指向 fork 地址

### 9.4 分支策略

```
main ─────────────────────────────────────────────────────→
  │
  ├─ feature/openclaw-plugin ─────────────┬── merge →
  │                                        │
  ├─ feature/knot-plugin ───────────────┬── merge →
  │                                        │
  └─ upstream-sync/YYYY-MM-DD ───────────┘

extensions/openclaw/ (插件):
  独立于主仓库，通过 npm 包管理依赖

  更新方式：
  1. cd extensions/openclaw
  2. npm update @openclaw/gateway
  3. npm run build
  4. 提交 package.json 变更
```

### 9.5 Monorepo 管理（workspaces）

```json
// package.json (根目录)
{
  "name": "sarosis-agents-client",
  "private": true,
  "workspaces": [
    "extensions/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "update:openclaw": "cd extensions/openclaw && npm update @openclaw/*",
    "check:versions": "bash scripts/openclaw-check-versions.sh"
  }
}
```

**使用方式**：

```bash
# 安装所有依赖（包括插件）
npm install

# 构建所有插件
npm run build

# 更新 OpenClaw 插件
npm run update:openclaw

# 检查版本
npm run check:versions
```

### 9.6 插件发布流程

#### 9.6.1 打包插件

```bash
# 1. 编译插件
cd extensions/openclaw
npm run build

# 2. 打包为 .vsix
npx vsce package

# 3. 生成文件
# extensions/openclaw/openclaw-backend-1.2.0.vsix
```

#### 9.6.2 发布到 Marketplace

```bash
# 1. 登录
npx vsce login sarosis

# 2. 发布
npx vsce publish

# 3. 指定版本发布
npx vsce publish 1.2.0
```

#### 9.6.3 自动发布（CI/CD）

```yaml
# .github/workflows/publish-openclaw-plugin.yml
name: Publish OpenClaw Plugin

on:
  push:
    tags:
      - 'openclaw-v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm install
      - run: npm run build --workspace=extensions/openclaw
      - run: npx vsce publish -p ${{ secrets.VSCE_TOKEN }}
        working-directory: extensions/openclaw
```

---

## 附录 A：配置全览（插件化架构）

### A.1 Agent Studio 配置（sessions 层）

```jsonc
// settings.json 中的 Agent Studio 配置项
{
  // 现有
  "sessions.agentStudio.enabled": true,
  "sessions.agentStudio.knot.token": "xxx",
  "sessions.agentStudio.knot.agentId": "xxx",
  "sessions.agentStudio.knot.baseUrl": "https://knot.woa.com",
  "sessions.agentStudio.dataPath": "",

  // 后端选择
  "sessions.agentStudio.chatBackend": "openclaw"  // "knot" | "openclaw" | "direct"
}
```

**变化**：
- ❌ 移除 `sessions.agentStudio.openclaw.*` 配置（这些现在在插件内）
- ✅ OpenClaw 相关配置移到插件配置（见 A.2）

### A.2 OpenClaw 插件配置（extensions/openclaw/）

```jsonc
// settings.json 中的 OpenClaw 插件配置项
{
  // 插件基本配置
  "openclaw.enabled": true,
  "openclaw.version": "1.2.0",           // 插件版本（只读）
  "openclaw.autoUpdate": true,              // 自动更新插件
  "openclaw.updateChannel": "stable",     // "stable" | "beta" | "dev"

  // Gateway 配置
  "openclaw.gateway.enabled": true,
  "openclaw.gateway.port": 9876,
  "openclaw.gateway.autoStart": true,
  "openclaw.gateway.binaryPath": "",       // 留空=使用插件内置
  "openclaw.gateway.logLevel": "info",    // "debug" | "info" | "warn" | "error"

  // 模型配置
  "openclaw.model.provider": "anthropic",
  "openclaw.model.apiKey": "",
  "openclaw.model.defaultModel": "claude-3-5-sonnet-20241022",

  // 工具配置
  "openclaw.tools.enabled": [
    "read_file",
    "write_file",
    "execute_command",
    "list_files",
    "search_in_files"
  ],
  "openclaw.tools.timeout": 30000,         // 工具执行超时（ms）

  // Skill 配置
  "openclaw.skills.enabled": [
    "code_analysis",
    "debug_helper",
    "api_designer"
  ],
  "openclaw.skills.autoLoad": true,

  // 高级配置
  "openclaw.advanced.allowAnonymousTelemetry": false,
  "openclaw.advanced.maxConcurrentSessions": 5,
  "openclaw.advanced.sessionTimeout": 3600000  // 1 hour
}
```

### A.3 插件配置文件（extensions/openclaw/configs/）

#### A.3.1 gateway.yaml

```yaml
# Gateway 配置
server:
  host: 127.0.0.1
  port: 9876
  cors:
    allowedOrigins:
      - "vscode://*"
      - "https://*.github.dev"

models:
  providers:
    - name: anthropic
      apiKey: ${ANTHROPIC_API_KEY}
      baseUrl: https://api.anthropic.com
      models:
        - claude-3-5-sonnet-20241022
        - claude-3-haiku-20240307

    - name: openai
      apiKey: ${OPENAI_API_KEY}
      baseUrl: https://api.openai.com/v1
      models:
        - gpt-4-turbo
        - gpt-3.5-turbo

tools:
  enabled:
    - read_file
    - write_file
    - execute_command
    - list_files
    - search_in_files

  # 工具权限
  permissions:
    execute_command:
      allowlist:
        - "git*"
        - "npm*"
        - "python*"
      denylist:
        - "rm -rf /"
        - "dd if=/dev/zero"

skills:
  enabled:
    - code_analysis
    - debug_helper
    - api_designer

logging:
  level: info
  file: ~/.openclaw/logs/gateway.log
  maxSize: 10485760  # 10MB
  maxFiles: 5
```

#### A.3.2 runtime.yaml

```yaml
# Agent Runtime 配置
runtime:
  maxIterations: 90
  maxTokens: 200000
  temperature: 0.7
  thinking:
    enabled: true
    budget: 20000

  # 会话管理
  session:
    persistence: true
    storagePath: ~/.openclaw/sessions
    maxSessions: 100

  # 工具缓存
  toolCache:
    enabled: true
    ttl: 3600000  # 1 hour
    maxSize: 1000

  # 性能优化
  performance:
    parallelToolCalls: true
    maxParallelCalls: 5
    streaming:
      enabled: true
      frameInterval: 16  # ms
```

### A.4 配置优先级

```
配置优先级（从高到低）：

1. settings.json (用户配置)
   ├── 用户设置
   └── 工作区设置

2. configs/gateway.yaml (插件配置文件)

3. package.json (插件默认值)

4. runtime 默认值
```

### A.5 配置同步策略

```typescript
// 配置同步（settings.json ↔ gateway.yaml）
export class ConfigSyncService {
  // 从 settings.json 同步到 gateway.yaml
  async syncToGatewayConfig(): Promise<void> {
    const config = this._configurationService.getValue('openclaw');
    const gatewayConfig = this._convertToGatewayConfig(config);
    await this._writeGatewayConfig(gatewayConfig);
  }

  // 从 gateway.yaml 同步到 settings.json
  async syncFromGatewayConfig(): Promise<void> {
    const gatewayConfig = await this._readGatewayConfig();
    const settings = this._convertToSettings(gatewayConfig);
    await this._updateSettings(settings);
  }
}
```

---

## 附录 B：依赖关系图（插件化架构）

### B.1 Agent Studio 核心依赖

```
┌─────────────────────────────────────────────────────────────────┐
│                      sessions.common.main.ts                     │
│  (入口: import 'vs/sessions/contrib/agentStudio/browser/...')    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│           agentStudio.contribution.ts (注册中心)                   │
├─────────────────────────────────────────────────────────────────┤
│  registerSingleton(IAgentStudioService, ...)                     │
│  registerSingleton(IAgentChatService, ...)                       │
│  registerSingleton(IAgentDelegationService, ...)                 │
│  registerSingleton(IAgentTaskBoardService, ...)                  │
│  registerWorkbenchContribution(AgentStudioProviderContribution)  │
│  registerWorkbenchContribution(RegisterAgentStudioViews)         │
└─────────────────────────────────────────────────────────────────┘
         │               │               │
         ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
│AgentChatSvc  │ │AgentStudioSvc│ │DelegationSvc    │
│(插件加载器)   │ │(CRUD+持久化)  │ │(任务管理)         │
├──────────────┤ └──────────────┘ └──────────────────┘
│ backends/    │
│ ├─ knot     │
│ └─ (插件)   │
└──────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                 插件加载器                                     │
│  loadBackendPlugin(path)                                   │
│    ├── 动态 import(pluginPath)                              │
│    ├── plugin.activate(context)                             │
│    ├── context.registerBackend(backend)                    │
│    └── this._backends.set(plugin.id, plugin)             │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│              extensions/openclaw/ (插件)                      │
│  ├── package.json (依赖 @openclaw/gateway@^1.0.0)      │
│  ├── src/extension.ts (activate/deactivate)               │
│  ├── src/backend/openclawBackend.ts (IChatBackend)      │
│  └── node_modules/@openclaw/gateway/                     │
└─────────────────────────────────────────────────────────────┘
```

### B.2 插件依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│                    package.json (根目录)                  │
│  {                                                      │
│    "workspaces": [                                      │
│      "extensions/*"                                     │
│    ]                                                    │
│  }                                                      │
└───────────────────────┬─────────────────────────────────┘
                        │ npm install (根目录)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│            node_modules/ (根目录, hoisted)                │
│  ├── @openclaw/gateway/    ← 共享依赖                   │
│  ├── @openclaw/runtime/    ← 共享依赖                   │
│  └── @openclaw/protocol/   ← 共享依赖                   │
└───────────────────────┬─────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ extensions/  │ │ extensions/  │ │ extensions/  │
│ openclaw/    │ │ knot/        │ │ future/      │
│              │ │              │ │ backend/      │
│ package.json │ │ package.json │ │              │
│ "dependencies"│ │ "dependencies"│ │ package.json │
│ {            │ │ {            │ │ {            │
│  "@openclaw/ │ │  "..."      │ │  "..."      │
│  gateway":    │ │              │ │              │
│  "^1.0.0"   │ │              │ │              │
│ }            │ │              │ │              │
└──────────────┘ └──────────────┘ └──────────────┘
```

### B.3 运行时依赖方向

```
✅ 正确方向：
   extensions/openclaw/  → 依赖 →  sessions/ (接口)

❌ 错误方向：
   sessions/  → 依赖 →  extensions/openclaw/

原则：
- sessions/ 定义接口（IChatBackend, IAgentChatService）
- extensions/openclaw/ 实现接口
- sessions/ 不知道具体实现细节
```

### B.4 插件更新依赖

```
┌─────────────────────────────────────────────────────────────┐
│                 npm update @openclaw/gateway                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Before:                                                    │
│    "dependencies": {                                        │
│      "@openclaw/gateway": "^1.0.0"                      │
│    }                                                        │
│             │                                               │
│             ▼                                               │
│  After:                                                     │
│    "dependencies": {                                        │
│      "@openclaw/gateway": "^1.2.0"                      │
│    }                                                        │
│             │                                               │
│             ▼                                               │
│  npm install                                                │
│  npm run build                                              │
│             │                                               │
│             ▼                                               │
│  ✅ Plugin updated with new OpenClaw features!             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### B.5 版本兼容性矩阵

| OpenClaw 版本 | 插件版本 | sessions 接口版本 | 兼容性 |
|----------------|------------|-------------------|----------|
| 1.0.0 | 1.0.0 | 1.0.0 | ✅ 完全兼容 |
| 1.1.0 | 1.1.0 | 1.0.0 | ✅ 向后兼容 |
| 1.2.0 | 1.2.0 | 1.0.0 | ✅ 向后兼容 |
| 2.0.0 | 2.0.0 | 2.0.0 | ⚠️ 需要更新 sessions 接口 |
| 2.0.0 | 1.2.0 | 1.0.0 | ❌ 不兼容 |

**策略**：
- 插件版本跟随 `@openclaw/gateway` 版本
- sessions 接口版本独立管理（semver）
- 大版本更新时评估接口变更需求

---

## 10. MCP Gateway 远程智能体调用本地 Skill 机制

### 10.1 核心概念

当用户通过 Knot AG-UI 发送消息到指定智能体后，服务端智能体配置了 `sarosis-mcp`，可通过 **MCP Gateway** 机制反向调用本地编辑器中注册的 MCP Server 工具（包括 Skill）。

**核心架构**：本地编辑器在 `127.0.0.1` 动态端口启动 HTTP Server，为每个 MCP Server 分配独立 Route。远程智能体通过标准 MCP 协议（JSON-RPC 2.0）与该 HTTP 端点通信，实现对本地工具的远程调用。

### 10.2 完整调用链路（7 步）

```
远程 Agent (Knot 服务端)
    │
    │ ① HTTP POST http://127.0.0.1:{port}/gateway/{routeId}
    │    Content-Type: application/json
    │    Mcp-Session-Id: {sessionId}  (首次请求无此 header)
    ▼
┌─────────────────────────────────────────────────────────────┐
│ McpGatewayService (Node.js, Main Process / Remote Server)    │
│ ② URL 解析 → 匹配 Route → 委托给 McpGatewayRoute            │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ McpGatewayRoute (per MCP Server)                             │
│ ③ 解析 JSON-RPC → 匹配/创建 Session → 交给 Session 处理      │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ McpGatewaySession (per client session)                       │
│ ④ 协议版本协商 → 分发 method (tools/list, tools/call 等)    │
│    → 调用 IMcpGatewaySingleServerInvoker                    │
└───────────────────────────┬─────────────────────────────────┘
                            │ IPC (Main ↔ Workbench)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ McpGatewayChannel (Main Process IPC Channel)                 │
│ ⑤ 通过 IPCServer.getChannel() 路由到对应 Workbench client   │
└───────────────────────────┬─────────────────────────────────┘
                            │ IPC
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ McpGatewayToolBrokerChannel (Workbench 侧)                   │
│ ⑥ 定位目标 Server → 等待 startup grace → 过滤 Visibility    │
│    → 调用 tool.call(args, context, token)                    │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ IMcpService → 本地 MCP Server 实例                           │
│ ⑦ 执行工具 → 返回 MCP.CallToolResult                        │
│    (content: TextContent[] | ImageContent[] | ...)           │
└─────────────────────────────────────────────────────────────┘
```

### 10.3 关键源文件清单

| 文件路径 | 层级 | 职责 |
|---------|------|------|
| `src/vs/platform/mcp/common/mcpGateway.ts` | 接口定义 | `IMcpGatewayService`, `IMcpGatewayToolInvoker`, `IMcpGatewaySingleServerInvoker` |
| `src/vs/platform/mcp/node/mcpGatewayService.ts` | Main Process | HTTP Server 管理, Route 创建/销毁, 动态端口分配 |
| `src/vs/platform/mcp/node/mcpGatewaySession.ts` | Main Process | MCP JSON-RPC 2.0 协议实现 (initialize, tools/list, tools/call, resources/*) |
| `src/vs/platform/mcp/node/mcpGatewayChannel.ts` | IPC Bridge | Main Process 侧 IPC Channel, 桥接 remote ↔ workbench |
| `src/vs/workbench/contrib/mcp/common/mcpGatewayToolBrokerChannel.ts` | Workbench | 工具执行代理, IMcpService 调用, visibility 过滤 |
| `src/vs/workbench/contrib/mcp/browser/mcpGatewayToolBrokerContribution.ts` | Workbench | 注册 ToolBroker Channel 到 RemoteAgentService |

### 10.4 协议细节

#### 10.4.1 MCP 协议版本支持

```typescript
const MCP_LATEST_PROTOCOL_VERSION = '2025-11-25';
const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
    '2025-11-25',
    '2025-06-18',
    '2025-03-26',
    '2024-11-05',
    '2024-10-07',
];
```

#### 10.4.2 Session 生命周期

```
首次请求 (无 Mcp-Session-Id header):
  ├── 消息必须是 "initialize" method
  ├── 服务端创建新 Session (UUID)
  ├── 返回 Mcp-Session-Id header
  └── 客户端后续请求携带此 header

后续请求:
  ├── 携带 Mcp-Session-Id header
  ├── Session 查找 → 如不存在返回 404
  └── 分发到 Session.handleIncoming()

Session 销毁:
  ├── DELETE 请求 + Mcp-Session-Id header
  └── 或 Gateway 整体销毁时连带清理
```

#### 10.4.3 支持的 MCP Methods

| Method | 类型 | 说明 |
|--------|------|------|
| `initialize` | Request | 协议版本协商 + 能力声明 |
| `ping` | Request | 健康检查 |
| `tools/list` | Request | 列出可用工具（只返回 `McpToolVisibility.Model` 标记的） |
| `tools/call` | Request | 调用指定工具，参数: `{ name, arguments }` |
| `resources/list` | Request | 列出可用资源 |
| `resources/read` | Request | 读取指定资源，参数: `{ uri }` |
| `resources/templates/list` | Request | 列出资源模板 |
| `notifications/initialized` | Notification | 客户端完成初始化 |
| `notifications/tools/list_changed` | Notification (Server→Client) | 工具列表变化通知 |
| `notifications/resources/list_changed` | Notification (Server→Client) | 资源列表变化通知 |

#### 10.4.4 Gateway 能力声明

```json
{
    "protocolVersion": "2025-11-25",
    "capabilities": {
        "tools": { "listChanged": true },
        "resources": { "listChanged": true }
    },
    "serverInfo": {
        "name": "VS Code MCP Gateway",
        "version": "1.0.0"
    }
}
```

### 10.5 工具可见性过滤

```typescript
// 只暴露标记为 Model 可见的工具给远程智能体
const tools = server.tools.get()
    .filter(t => t.visibility & McpToolVisibility.Model)
    .map(t => t.definition);
```

**可见性级别**：
- `McpToolVisibility.Model` — 可被 AI 模型/远程智能体调用 ✅
- 其他级别 — 仅限本地 UI 使用，不暴露给远程

### 10.6 Startup Grace Period（5 秒等待）

```typescript
// ToolBrokerChannel 为每个 Server 提供 5 秒启动宽限期
private readonly _startupGracePeriodMs = 5000;

private _waitForStartup(server: IMcpServer): Promise<boolean> {
    return Promise.race([
        this._ensureServerReady(server),  // 启动 Server 并等待工具加载
        new Promise<boolean>(resolve =>
            setTimeout(() => resolve(false), this._startupGracePeriodMs)
        ),
    ]);
}
```

- 首次 `tools/list` 请求时，如果 Server 未就绪，等待最多 5 秒
- 超时后返回空工具列表（不阻塞请求）
- 后续请求复用已解决的 Promise（不再等待）

### 10.7 动态 Server 变更事件

```typescript
// ToolBrokerChannel 监听 3 类事件:
autorun(reader => {
    // 1. 工具变更 → tools/list_changed 通知
    server.tools.read(reader);
    this._onDidChangeTools.fire();
});

autorun(reader => {
    // 2. 资源/能力变更 → resources/list_changed 通知
    server.capabilities.read(reader);
    this._onDidChangeResources.fire();
});

autorun(reader => {
    // 3. Server 增减 → 动态创建/销毁 Route
    const servers = this._mcpService.servers.read(reader);
    this._onDidChangeServers.fire(servers.map(s => ({ id, label })));
});
```

**Gateway 侧处理**：收到 `onDidChangeServers` 事件后，`McpGatewayService._refreshGatewayServers()` 自动为新增 Server 创建 Route、为移除的 Server 销毁 Route。

### 10.8 错误处理

| HTTP 状态码 | 错误码 | 场景 |
|------------|--------|------|
| 404 | - | Route 不存在 / Session 不存在 |
| 400 | -32600 | 缺少 Mcp-Session-Id / 非 initialize 消息 |
| 400 | -32700 | JSON 解析失败 |
| 405 | - | 不支持的 HTTP Method |
| 413 | - | 请求体超过 1MB |
| 500 | - | 内部错误 |
| 200 | -32601 | Method not found |
| 200 | -32602 | Invalid params |

### 10.9 安全机制

1. **随机 Route UUID**：每个 Gateway Route 使用 `generateUuid()` 生成，端点 URL 不可猜测
2. **Localhost 绑定**：Server 仅监听 `127.0.0.1`，拒绝外部网络访问
3. **动态端口**：使用 `port: 0` 让 OS 分配端口，避免固定端口冲突
4. **Client 隔离**：每个 Workbench Client 拥有独立 Gateway 和 Route 集合
5. **断开清理**：`onDidRemoveConnection` 自动销毁断开连接的 Client 的所有 Gateway

### 10.10 与 Agent Studio 的集成点

在当前 Knot AG-UI 架构中，远程智能体调用本地 Skill 的完整上下文：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Agent Studio (Workbench)                       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  AgentChatService ─── Knot AG-UI SSE ───→ Knot 服务端                │
│       │                                        │                     │
│       │                                        ▼                     │
│       │                              远程 Agent (配置 sarosis-mcp)    │
│       │                                        │                     │
│       │                                        │ MCP Protocol        │
│       │                                        ▼                     │
│       │         ┌─────── McpGatewayService (localhost:{port}) ───┐   │
│       │         │  Route A → Session → tools/list, tools/call   │   │
│       │         │  Route B → Session → ...                       │   │
│       │         └─────────────────────────────────────────────────┘   │
│       │                           │ IPC                               │
│       ▼                           ▼                                   │
│  WebView UI ←── stream ←── ToolBrokerChannel → IMcpService           │
│  (显示工具调用进度)                              → MCP Server → tool  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**关键要点**：
- Gateway 对 Agent Studio 的 Chat 流程**透明** — 用户发消息后，远程 Agent 自行决定是否调用本地工具
- 工具调用结果会通过 AG-UI SSE 事件 (`TOOL_CALL_START/ARGS/END/RESULT`) 返回给 Chat 流
- Agent Studio WebView 可实时展示工具调用进度

### 10.11 配置与注册

```jsonc
// MCP Server 配置文件 (~/.bg-agent/mcp_config.json 或 ~/.gongfeng-copilot/mcp.json)
{
    "mcpServers": {
        "my-skill-server": {
            "command": "node",
            "args": ["./skill-server.js"],
            "env": {}
        }
    }
}
```

**注册链路**：
1. 配置文件 → `IMcpService` 解析 → 创建 `McpServer` 实例
2. `McpGatewayToolBrokerContribution` 注册 `McpGatewayToolBrokerChannel` 到 `RemoteAgentService`
3. 远程连接建立时，`McpGatewayChannel` 通过 IPC 调用 ToolBroker 获取 Server 列表
4. `McpGatewayService.createGateway()` 为每个 Server 创建独立 Route

---

## 11. 系统架构总览

> 见下方 SVG 架构图 — 展示 Agent Studio + MCP Gateway + 远程智能体的完整交互关系

---

---

## 12. 多客户端共享 Gateway 架构设计（sarosis-mcp 统一接入）

### 12.1 问题定义

**场景**：同一个 Knot 智能体（配置了 `sarosis-mcp`）需要被多种客户端调用，且能回调到各客户端本地注册的 MCP 工具。

**客户端类型**：
| 客户端 | 形态 | MCP 工具来源 |
|--------|------|-------------|
| Saros VSCode | Desktop Electron | 本地 MCP Server 进程（IMcpService） |
| Saros WebUI | 浏览器 + Next.js | 浏览器端无法直接运行 MCP Server，需代理 |
| Saros CLI | 命令行工具 | 本地 MCP Server 进程 |
| 第三方渠道（企微/飞书/Slack） | IM Bot | 无本地 MCP 工具（纯远程交互） |

**当前架构限制**：
1. `McpGatewayService` 绑定 `127.0.0.1` — 仅本机进程可访问
2. 每个 Workbench 实例独立创建 Gateway — 多客户端间无法共享工具
3. Knot 服务端 `sarosis-mcp` 配置只能指向一个固定地址 — 多客户端切换困难
4. 无客户端注册/发现机制 — 无法动态感知哪些客户端在线

### 12.2 设计目标

| 目标 | 描述 |
|------|------|
| **统一端点** | Knot 智能体通过唯一固定 `sarosis-mcp` 端点访问工具，无需关心客户端拓扑 |
| **工具聚合** | 多个客户端注册的 MCP 工具在 Gateway 层聚合为统一工具列表 |
| **智能路由** | 同名工具跨客户端存在时，按优先级/会话上下文智能路由 |
| **会话亲和** | 同一对话 Session 中的工具调用优先路由到发起对话的客户端 |
| **客户端无感** | 单客户端场景下行为不变，开箱即用 |
| **安全隔离** | 不同用户的 Gateway 完全隔离，客户端间按策略共享 |

### 12.3 核心架构：中心化 MCP Gateway Hub

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Knot 服务端 (远程智能体)                               │
│                                                                             │
│  Agent(配置 sarosis-mcp) → tool.call("read_file", {path: "..."})           │
│                │                                                            │
│                │ MCP Protocol (JSON-RPC 2.0)                                │
│                ▼                                                            │
│  ┌───────────────────────────────────┐                                     │
│  │ sarosis-mcp (统一 MCP Endpoint)    │                                     │
│  │ URL: https://gateway.sarosis.io   │                                     │
│  │      /mcp/{userId}/{sessionId}    │                                     │
│  └───────────────┬───────────────────┘                                     │
└──────────────────┼─────────────────────────────────────────────────────────┘
                   │ HTTPS / WSS
                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│               Saros MCP Gateway Hub (中心化服务)                            │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Gateway Router                                     │   │
│  │  ┌──────────┐  ┌──────────────┐  ┌────────────────┐                │   │
│  │  │Tool      │  │Session       │  │Client          │                │   │
│  │  │Registry  │  │Affinity      │  │Health Monitor  │                │   │
│  │  │(聚合表)   │  │(会话亲和)     │  │(心跳检测)       │                │   │
│  │  └──────────┘  └──────────────┘  └────────────────┘                │   │
│  └─────────────────────────┬───────────────────────────────────────────┘   │
│                            │                                                │
│         ┌──────────────────┼───────────────────┐                           │
│         │                  │                   │                            │
│         ▼                  ▼                   ▼                            │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│  │ Client Slot │  │ Client Slot  │  │ Client Slot  │                      │
│  │ (VSCode)    │  │ (WebUI)      │  │ (CLI)        │                      │
│  │ Priority: 1 │  │ Priority: 2  │  │ Priority: 3  │                      │
│  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘                      │
└─────────┼────────────────┼─────────────────┼──────────────────────────────┘
          │ WSS            │ WSS             │ WSS
          ▼                ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ VSCode       │  │ WebUI        │  │ CLI          │
│ Desktop      │  │ (Browser)    │  │              │
│              │  │              │  │              │
│ MCP Servers: │  │ MCP Servers: │  │ MCP Servers: │
│ - read_file  │  │ - web_search │  │ - shell_exec │
│ - write_file │  │ - browser    │  │ - read_file  │
│ - shell_exec │  │              │  │ - git_ops    │
└──────────────┘  └──────────────┘  └──────────────┘
```

### 12.4 关键组件设计

#### 12.4.1 Gateway Hub Service（中心化）

**部署位置**：与 Knot 服务端同网络的独立微服务（或 sidecar）

```typescript
interface IGatewayHubService {
  // 客户端注册
  registerClient(userId: string, clientInfo: IClientRegistration): Promise<IClientSlot>;
  unregisterClient(userId: string, clientId: string): Promise<void>;

  // 工具聚合
  listAggregatedTools(userId: string, sessionId?: string): Promise<IMcpToolEntry[]>;

  // 工具调用路由
  routeToolCall(userId: string, sessionId: string, toolName: string, args: Record<string, unknown>): Promise<MCP.CallToolResult>;

  // 客户端状态
  getClientStatus(userId: string): IClientStatus[];
}

interface IClientRegistration {
  clientId: string;          // 唯一标识
  clientType: 'vscode' | 'webui' | 'cli' | 'channel';
  priority: number;          // 路由优先级 (1=最高)
  capabilities: string[];    // 该客户端支持的工具类别
  connectionType: 'websocket' | 'long-poll' | 'callback-url';
  endpoint?: string;         // 回调地址（仅 callback-url 模式）
}

interface IClientSlot {
  slotId: string;
  registeredAt: number;
  tools: IMcpToolEntry[];    // 该客户端注册的工具列表
  heartbeatInterval: number; // 心跳间隔 (ms)
}
```

#### 12.4.2 Tool Registry（工具注册表）

**核心问题**：多个客户端可能注册同名工具（如 `read_file` 同时存在于 VSCode 和 CLI 中）。

**聚合策略**：

```typescript
interface IMcpToolEntry {
  name: string;                    // 工具名
  description: string;             // 工具描述
  inputSchema: object;             // JSON Schema
  sourceClients: IToolSource[];    // 提供该工具的客户端列表
  routingPolicy: ToolRoutingPolicy;
}

interface IToolSource {
  clientId: string;
  clientType: string;
  priority: number;
  serverId: string;                // 客户端内部的 MCP Server ID
}

enum ToolRoutingPolicy {
  SessionAffinity = 'session-affinity',   // 优先路由到发起会话的客户端
  HighestPriority = 'highest-priority',   // 按优先级路由
  RoundRobin = 'round-robin',             // 轮询（负载均衡）
  Broadcast = 'broadcast',                // 广播到所有（聚合结果）
}
```

**暴露给 Knot 的工具列表**（去重后）：

```
tools/list 响应:
[
  { name: "read_file",  description: "..." },    // 来自 VSCode(P1) + CLI(P3)
  { name: "write_file", description: "..." },    // 来自 VSCode(P1) 独有
  { name: "shell_exec", description: "..." },    // 来自 VSCode(P1) + CLI(P3)
  { name: "web_search", description: "..." },    // 来自 WebUI(P2) 独有
  { name: "browser",    description: "..." },    // 来自 WebUI(P2) 独有
  { name: "git_ops",    description: "..." },    // 来自 CLI(P3) 独有
]
```

#### 12.4.3 Session Affinity（会话亲和）

```typescript
interface ISessionContext {
  sessionId: string;           // Knot 对话 Session ID
  originClientId: string;      // 发起对话的客户端
  toolCallHistory: IToolCallRecord[];
  affinityMap: Map<string, string>;  // toolName → preferredClientId
}

// 路由决策逻辑
function resolveToolRoute(
  toolName: string,
  session: ISessionContext,
  registry: IToolRegistry,
): IToolSource {
  const sources = registry.getSourcesForTool(toolName);

  // 1. 检查会话亲和绑定
  const affinityClientId = session.affinityMap.get(toolName);
  if (affinityClientId && isClientAlive(affinityClientId)) {
    return sources.find(s => s.clientId === affinityClientId)!;
  }

  // 2. 优先路由到发起对话的客户端
  const originSource = sources.find(s => s.clientId === session.originClientId);
  if (originSource && isClientAlive(originSource.clientId)) {
    return originSource;
  }

  // 3. 按优先级选择在线客户端
  const alive = sources.filter(s => isClientAlive(s.clientId));
  alive.sort((a, b) => a.priority - b.priority);
  return alive[0]; // 最高优先级
}
```

#### 12.4.4 Client Connection（客户端连接协议）

**连接方式选择**：

| 客户端类型 | 推荐连接方式 | 原因 |
|-----------|-------------|------|
| VSCode Desktop | WebSocket (outbound) | 可从内网穿透，无需暴露端口 |
| WebUI (Browser) | WebSocket (outbound) | 浏览器原生支持 WebSocket |
| CLI | WebSocket / Long-Poll | 取决于网络环境 |
| 第三方渠道 | 无连接（纯转发） | IM Bot 无 MCP 工具，仅消息转发 |

**连接协议**：

```typescript
// 客户端 → Hub 的 WebSocket 消息
type ClientToHubMessage =
  | { type: 'register'; payload: IClientRegistration }
  | { type: 'heartbeat'; payload: { clientId: string; timestamp: number } }
  | { type: 'tools_update'; payload: { tools: MCP.Tool[]; serverId: string } }
  | { type: 'tool_result'; payload: { requestId: string; result: MCP.CallToolResult } }
  | { type: 'tool_error'; payload: { requestId: string; error: string } };

// Hub → 客户端的 WebSocket 消息
type HubToClientMessage =
  | { type: 'registered'; payload: IClientSlot }
  | { type: 'tool_call'; payload: { requestId: string; serverId: string; toolName: string; args: Record<string, unknown> } }
  | { type: 'ping'; payload: { timestamp: number } }
  | { type: 'config_update'; payload: { routing: ToolRoutingPolicy } };
```

### 12.5 部署模式


#### 模式 C：远程 Hub 模式（多客户端跨网络）

```
Knot Agent → HTTPS gateway.sarosis.io/mcp/{userId}/{sessionId}
                     ↓
              Cloud Gateway Hub
              ├─ VSCode (WSS outbound)
              ├─ WebUI (WSS outbound)
              └─ CLI (WSS outbound)
```

- Hub 部署在云端，客户端通过 WSS 向外连接
- 解决了 NAT/防火墙穿透问题
- 适用于远程开发、团队协作场景
- 安全层：JWT Token + TLS + userId 隔离

### 12.6 对现有 McpGatewayService 的改造方案

**原则**：最小侵入，在现有架构上扩展。

#### 12.6.1 新增 `IMcpGatewayHubClient` 接口

```typescript
// src/vs/platform/mcp/common/mcpGatewayHub.ts (新增文件)

export interface IMcpGatewayHubClient {
  readonly _serviceBrand: undefined;

  /**
   * 连接到中心化 Gateway Hub
   * 模式 A 下不调用，模式 B/C 下在 workbench 启动时调用
   */
  connect(hubUrl: string, credentials: IHubCredentials): Promise<void>;

  /**
   * 注册本地 MCP 工具到 Hub
   */
  registerTools(tools: MCP.Tool[], serverId: string): Promise<void>;

  /**
   * 处理来自 Hub 的工具调用请求
   */
  onToolCallRequest: Event<IHubToolCallRequest>;

  /**
   * 返回工具调用结果给 Hub
   */
  respondToolCall(requestId: string, result: MCP.CallToolResult): Promise<void>;

  /**
   * 获取连接状态
   */
  readonly connectionState: IObservable<HubConnectionState>;

  /**
   * 断开连接
   */
  disconnect(): Promise<void>;
}

export interface IHubCredentials {
  userId: string;
  token: string;
  clientType: 'vscode' | 'webui' | 'cli';
  clientId: string;
}

export interface IHubToolCallRequest {
  requestId: string;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
}

export enum HubConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
}
```

#### 12.6.2 VSCode 侧实现

```typescript
// src/vs/sessions/contrib/agentStudio/browser/mcpGatewayHubClient.ts (新增)

export class McpGatewayHubClientService extends Disposable implements IMcpGatewayHubClient {
  private _ws: WebSocket | undefined;
  private _connectionState = observableValue<HubConnectionState>(HubConnectionState.Disconnected);

  constructor(
    @IMcpService private readonly _mcpService: IMcpService,
    @IConfigurationService private readonly _configService: IConfigurationService,
    @ILogService private readonly _logService: ILogService,
  ) {
    super();
    this._autoConnect();
  }

  private _autoConnect(): void {
    const hubUrl = this._configService.getValue<string>('sessions.agentStudio.gatewayHub.url');
    if (hubUrl) {
      this.connect(hubUrl, this._getCredentials());
    }
  }

  async connect(hubUrl: string, credentials: IHubCredentials): Promise<void> {
    this._connectionState.set(HubConnectionState.Connecting);
    this._ws = new WebSocket(hubUrl);

    this._ws.onopen = () => {
      // 注册客户端
      this._ws!.send(JSON.stringify({
        type: 'register',
        payload: {
          clientId: credentials.clientId,
          clientType: credentials.clientType,
          priority: 1, // VSCode = 最高优先级
          capabilities: ['filesystem', 'terminal', 'editor'],
          connectionType: 'websocket',
        }
      }));
      this._connectionState.set(HubConnectionState.Connected);

      // 推送当前工具列表
      this._pushCurrentTools();
    };

    this._ws.onmessage = (event) => {
      const msg: HubToClientMessage = JSON.parse(event.data);
      if (msg.type === 'tool_call') {
        this._handleToolCall(msg.payload);
      }
    };
  }

  private async _handleToolCall(request: IHubToolCallRequest): Promise<void> {
    try {
      // 复用现有 McpGatewayToolBrokerChannel 逻辑
      const server = this._getServerById(request.serverId);
      const tool = server.tools.get().find(t => t.definition.name === request.toolName);
      const result = await tool!.call(request.args, undefined, CancellationToken.None);
      this.respondToolCall(request.requestId, result);
    } catch (error) {
      this._ws?.send(JSON.stringify({
        type: 'tool_error',
        payload: { requestId: request.requestId, error: String(error) }
      }));
    }
  }
}
```

#### 12.6.3 配置项扩展

```jsonc
{
  // 现有（不变）
  "sessions.agentStudio.knot.token": "xxx",
  "sessions.agentStudio.knot.agentId": "xxx",

  // 新增 Gateway Hub 配置
  "sessions.agentStudio.gatewayHub.enabled": false,        // 是否启用 Hub 模式
  "sessions.agentStudio.gatewayHub.mode": "local",         // "local" | "remote"
  "sessions.agentStudio.gatewayHub.url": "",               // Hub WebSocket URL
  "sessions.agentStudio.gatewayHub.token": "",             // Hub 认证 Token
  "sessions.agentStudio.gatewayHub.clientPriority": 1,     // 当前客户端优先级
  "sessions.agentStudio.gatewayHub.autoConnect": true,     // 启动时自动连接
  "sessions.agentStudio.gatewayHub.reconnectInterval": 5000 // 重连间隔 (ms)
}
```

### 12.7 Gateway Hub 服务端实现要点

#### 12.7.1 核心模块

```
sarosis-gateway-hub/
├── src/
│   ├── server.ts                # HTTP/WS Server 入口
│   ├── router/
│   │   ├── mcpRouter.ts         # MCP 协议路由（对 Knot 暴露）
│   │   └── toolRouter.ts        # 工具调用路由决策
│   ├── registry/
│   │   ├── clientRegistry.ts    # 客户端注册管理
│   │   ├── toolRegistry.ts      # 工具聚合注册表
│   │   └── sessionStore.ts      # Session 亲和状态
│   ├── transport/
│   │   ├── wsTransport.ts       # WebSocket 传输层
│   │   └── healthCheck.ts       # 心跳 & 健康检测
│   ├── security/
│   │   ├── auth.ts              # JWT 认证
│   │   └── rateLimit.ts         # 速率限制
│   └── protocol/
│       ├── mcpSession.ts        # MCP Session 管理（复用第 10 章逻辑）
│       └── hubProtocol.ts       # Hub ↔ Client 通信协议
└── package.json
```

#### 12.7.2 请求处理流程

```
Knot Agent 发起 tools/call("read_file", {path: "/src/main.ts"})
    │
    ▼
Gateway Hub: mcpRouter 接收 JSON-RPC 请求
    │
    ├── 1. 鉴权: 验证 JWT Token → 获取 userId
    ├── 2. 解析 Session: 根据 Mcp-Session-Id 获取 SessionContext
    ├── 3. 查找工具: toolRegistry.findSources("read_file")
    │       → [VSCode(P1, alive), CLI(P3, alive)]
    ├── 4. 路由决策: toolRouter.resolve(session, "read_file")
    │       → SessionAffinity → 选择 VSCode
    ├── 5. 转发请求: wsTransport.send(vscodeClient, {type: "tool_call", ...})
    ├── 6. 等待结果: await responsePromise (timeout: 30s)
    └── 7. 返回结果: CallToolResult → JSON-RPC Response → Knot
```

### 12.8 容错与降级策略

| 场景 | 处理方式 |
|------|----------|
| 目标客户端离线 | 自动 failover 到次优先级客户端 |
| 所有客户端离线 | 返回 MCP error "No available client" |
| 工具调用超时（30s） | 重试一次到同客户端，再次超时则 failover |
| Hub 服务不可用 | 退回模式 A（直接本地 Gateway） |
| WebSocket 断连 | 自动重连 + 指数退避（1s → 2s → 4s → ... → 60s） |
| 客户端注册重复工具 | 按注册顺序 + priority 去重，保留最高优先级 |

### 12.9 与 Knot 服务端的对接

**sarosis-mcp 在 Knot 的配置方式变更**：

```yaml
# 当前方式（模式 A）：指向本地 Gateway
mcp_servers:
  - name: sarosis-mcp
    transport: http
    url: "http://127.0.0.1:{dynamic_port}/gateway/{routeId}"

# 新方式（模式 C）：指向中心化 Hub
mcp_servers:
  - name: sarosis-mcp
    transport: http
    url: "https://gateway.sarosis.io/mcp/{userId}"
    headers:
      Authorization: "Bearer {hub_token}"
```

**Knot 智能体无需改动**：Hub 对外暴露标准 MCP 协议接口，与现有 `McpGatewayService` 的 HTTP 接口完全兼容。

### 12.10 安全设计

| 层级 | 机制 | 说明 |
|------|------|------|
| 传输层 | TLS/WSS | 所有通信加密 |
| 认证层 | JWT Token | 客户端注册时验证身份 |
| 授权层 | userId 隔离 | 每个用户只能访问自己的 Gateway |
| 工具层 | McpToolVisibility | 仍只暴露 Model 可见工具 |
| 速率限制 | Per-user Rate Limit | 防止滥用（100 calls/min） |
| 审计层 | 调用日志 | 记录所有 tool_call 供审计 |

### 12.11 实施路径

| 阶段 | 内容 | 工期 | 交付 |
|------|------|------|------|
| Phase 1 | 本地 Hub Daemon + VSCode 客户端适配 | 1 周 | 模式 B 可用 |
| Phase 2 | 远程 Hub 服务 + 认证/鉴权 | 1.5 周 | 模式 C 基础可用 |
| Phase 3 | WebUI 客户端接入 + CLI 客户端接入 | 1 周 | 全客户端覆盖 |
| Phase 4 | Session 亲和 + 智能路由 + 降级策略 | 1 周 | 生产可用 |
| Phase 5 | 监控/审计/管理面板 | 0.5 周 | 运维就绪 |

### 12.12 与现有架构的兼容性

**关键设计决策**：Hub 模式是 **可选叠加层**，不修改现有 McpGatewayService 逻辑。

```
┌─────────────────────────────────────────────────────────────────┐
│                        决策树                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  gatewayHub.enabled == false ?                                   │
│     └─ YES → 模式 A（现有逻辑不变）                                │
│                McpGatewayService 照常工作                          │
│                                                                  │
│  gatewayHub.enabled == true ?                                    │
│     ├─ mode == "local" → 模式 B                                  │
│     │    启动本地 Hub Daemon                                      │
│     │    McpGatewayHubClient 连接本地 Hub                         │
│     │    本地 McpGatewayService 同时保留（向后兼容）                │
│     │                                                            │
│     └─ mode == "remote" → 模式 C                                 │
│          McpGatewayHubClient 连接远程 Hub                         │
│          本地 McpGatewayService 可选保留（混合模式）                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 13. 系统架构总览（含多客户端）

> 见下方 SVG 架构图 — 展示多客户端通过 Gateway Hub 共享同一 Knot 智能体的完整交互关系

---

## 14. OpenClaw Memory 机制接入

### 14.1 核心概念

OpenClaw 的 Memory 机制提供多层次的记忆系统，支持 Agent 在对话中保持上下文连贯性和长期知识积累。

**Memory 类型**：

| 类型 | 说明 | 存储后端 | 生命周期 |
|------|------|----------|----------|
| **短期记忆（Short-term）** | 当前对话的上下文，包括最近的消息历史 | 内存 + 可选持久化 | 会话结束或超时 |
| **长期记忆（Long-term）** | 持久化的知识库，使用向量数据库存储 | 向量数据库（ChromaDB/Pinecone） | 永久，直到手动删除 |
| **工作记忆（Working）** | 当前任务的执行状态、中间结果 | 内存 | 任务完成或超时 |

### 14.2 Memory 接口设计

#### 14.2.1 IMemoryProvider 接口

```typescript
// src/vs/sessions/common/memoryProvider.ts
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

export const IMemoryProvider = createDecorator<IMemoryProvider>('memoryProvider');

export interface IMemoryProvider {
  readonly _serviceBrand: undefined;

  readonly id: string;
  readonly name: string;

  // 存储记忆
  store(memory: MemoryItem): Promise<string>;  // 返回 memoryId

  // 批量存储
  storeBatch(memories: MemoryItem[]): Promise<string[]>;

  // 检索记忆
  retrieve(query: MemoryQuery): Promise<MemoryResult[]>;

  // 更新记忆
  update(memoryId: string, updates: Partial<MemoryItem>): Promise<void>;

  // 删除记忆
  delete(memoryId: string): Promise<void>;

  // 清空记忆
  clear(scope: MemoryScope): Promise<void>;

  // 获取统计信息
  getStats(scope: MemoryScope): Promise<MemoryStats>;
}

export interface MemoryItem {
  id?: string;          // 可选，存储时生成
  content: string;
  type: MemoryType;
  timestamp?: number;   // 可选，存储时生成
  embedding?: number[];  // 可选，由存储后端生成
  metadata?: Record<string, unknown>;

  // 关联信息
  sessionId?: string;
  workspaceId?: string;
  agentId?: string;
  userId?: string;
}

export interface MemoryQuery {
  query: string;          // 文本查询（会转为 embedding）
  type?: MemoryType;
  scope?: MemoryScope;
  limit?: number;          // 返回结果数量，默认 10
  threshold?: number;      // 相似度阈值，默认 0.7
  filter?: Record<string, unknown>;  // 元数据过滤条件
}

export interface MemoryResult {
  memory: MemoryItem;
  score: number;          // 相似度得分（0-1）
}

export enum MemoryType {
  ShortTerm = 'short_term',
  LongTerm = 'long_term',
  Working = 'working',
}

export enum MemoryScope {
  Session = 'session',
  Workspace = 'workspace',
  Global = 'global',
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  storageSize: number;    // 字节
  lastUpdated: number;    // 时间戳
}
```

#### 14.2.2 在 IChatBackendPlugin 中扩展

```typescript
// src/vs/sessions/common/chatBackendPlugin.ts

export interface IChatBackendPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly priority: number;

  // 生命周期
  activate(context: IChatBackendContext): Promise<void>;
  deactivate(): Promise<void>;

  // 后端实例
  createBackend(): IChatBackend;

  // 版本信息
  getOpenClawVersion(): string;
  getSupportedFeatures(): string[];

  // 🆕 Memory 机制（可选）
  createMemoryProvider?(): IMemoryProvider | undefined;

  // 🆕 Agent 机制（可选）
  createAgentRuntime?(): IAgentRuntime | undefined;
}

export interface IChatBackendContext {
  readonly extensionPath: string;
  readonly globalStoragePath: string;
  readonly workspaceStoragePath: string;

  // VSCode 服务
  readonly configurationService: IConfigurationService;
  readonly logService: ILogService;
  readonly notificationService: INotificationService;
  readonly fileService: IFileService;

  // 注册后端
  registerBackend(backend: IChatBackend): void;
  unregisterBackend(backendId: string): void;

  // 🆕 注册 Memory Provider
  registerMemoryProvider?(provider: IMemoryProvider): void;

  // 🆕 注册 Agent Runtime
  registerAgentRuntime?(runtime: IAgentRuntime): void;
}
```

### 14.3 OpenClaw Memory 实现

#### 14.3.1 目录结构

```
extensions/openclaw/src/
├── memory/
│   ├── openclawMemoryProvider.ts      # IMemoryProvider 实现
│   ├── memoryStorage.ts              # 存储后端抽象
│   ├── vectorStorage.ts              # 向量数据库存储
│   ├── fileStorage.ts                # 文件存储（短期记忆）
│   └── memoryUtils.ts               # 工具函数（embedding 生成等）
├── backend/
│   └── openclawBackend.ts            # 新增：集成 Memory Provider
└── ...
```

#### 14.3.2 OpenClawMemoryProvider 实现

```typescript
// extensions/openclaw/src/memory/openclawMemoryProvider.ts
import { IMemoryProvider, MemoryItem, MemoryQuery, MemoryResult, MemoryType, MemoryScope } from '../../../../src/vs/sessions/common/memoryProvider';

export class OpenClawMemoryProvider implements IMemoryProvider {
  readonly _serviceBrand: undefined;

  readonly id = 'openclaw-memory';
  readonly name = 'OpenClaw Memory Provider';

  private _storage: IMemoryStorage;
  private _gatewayEndpoint: string;
  private _logService: ILogService;

  constructor(options: MemoryProviderOptions) {
    this._gatewayEndpoint = options.gatewayEndpoint;
    this._logService = options.logService;

    // 根据配置选择存储后端
    this._storage = this._createStorage(options.storageType);
  }

  async store(memory: MemoryItem): Promise<string> {
    try {
      // 1. 生成 embedding（如果未提供）
      if (!memory.embedding && memory.type === MemoryType.LongTerm) {
        memory.embedding = await this._generateEmbedding(memory.content);
      }

      // 2. 设置时间戳
      memory.timestamp = memory.timestamp || Date.now();

      // 3. 存储到后端
      const memoryId = await this._storage.store(memory);

      this._logService.debug('[OpenClawMemory] Stored memory', { memoryId, type: memory.type });

      return memoryId;
    } catch (error) {
      this._logService.error('[OpenClawMemory] Failed to store memory', error);
      throw error;
    }
  }

  async retrieve(query: MemoryQuery): Promise<MemoryResult[]> {
    try {
      // 1. 生成查询 embedding
      const queryEmbedding = await this._generateEmbedding(query.query);

      // 2. 构建存储查询
      const storageQuery: StorageQuery = {
        embedding: queryEmbedding,
        type: query.type,
        scope: query.scope,
        limit: query.limit || 10,
        threshold: query.threshold || 0.7,
        filter: query.filter,
      };

      // 3. 从后端检索
      const results = await this._storage.query(storageQuery);

      this._logService.debug('[OpenClawMemory] Retrieved memories', {
        count: results.length,
        query: query.query.substring(0, 50),
      });

      return results;
    } catch (error) {
      this._logService.error('[OpenClawMemory] Failed to retrieve memories', error);
      throw error;
    }
  }

  async update(memoryId: string, updates: Partial<MemoryItem>): Promise<void> {
    // 更新记忆
    await this._storage.update(memoryId, updates);
  }

  async delete(memoryId: string): Promise<void> {
    // 删除记忆
    await this._storage.delete(memoryId);
  }

  async clear(scope: MemoryScope): Promise<void> {
    // 清空指定范围的记忆
    await this._storage.clear(scope);
  }

  async getStats(scope: MemoryScope): Promise<MemoryStats> {
    // 获取统计信息
    return this._storage.getStats(scope);
  }

  // 私有方法
  private async _generateEmbedding(text: string): Promise<number[]> {
    // 调用 OpenClaw Gateway 的 embedding API
    const response = await fetch(`${this._gatewayEndpoint}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
    });

    const data = await response.json();
    return data.embedding;
  }

  private _createStorage(type: StorageType): IMemoryStorage {
    switch (type) {
      case StorageType.VectorDB:
        return new VectorStorage(this._logService);
      case StorageType.File:
        return new FileStorage(this._logService);
      default:
        throw new Error(`Unsupported storage type: ${type}`);
    }
  }
}
```

#### 14.3.3 存储后端接口

```typescript
// extensions/openclaw/src/memory/memoryStorage.ts
export interface IMemoryStorage {
  store(memory: MemoryItem): Promise<string>;
  storeBatch(memories: MemoryItem[]): Promise<string[]>;
  query(query: StorageQuery): Promise<MemoryResult[]>;
  update(memoryId: string, updates: Partial<MemoryItem>): Promise<void>;
  delete(memoryId: string): Promise<void>;
  clear(scope: MemoryScope): Promise<void>;
  getStats(scope: MemoryScope): Promise<MemoryStats>;
}

export interface StorageQuery {
  embedding: number[];
  type?: MemoryType;
  scope?: MemoryScope;
  limit: number;
  threshold: number;
  filter?: Record<string, unknown>;
}
```

### 14.4 与 OpenClaw Gateway 的集成

#### 14.4.1 Gateway API 端点

```
OpenClaw Gateway 新增 Memory API：
  POST   /memory/store              # 存储记忆
  POST   /memory/retrieve          # 检索记忆
  PUT    /memory/{memoryId}        # 更新记忆
  DELETE /memory/{memoryId}        # 删除记忆
  DELETE /memory/clear             # 清空记忆
  GET    /memory/stats             # 获取统计信息
  POST   /embeddings               # 生成 embedding
```

#### 14.4.2 配置项

```jsonc
// settings.json 中的 Memory 配置项
{
  "openclaw.memory.enabled": true,
  "openclaw.memory.storageType": "vector",     // "vector" | "file"
  "openclaw.memory.vectorDbUrl": "http://localhost:8000",  // ChromaDB 端点
  "openclaw.memory.embeddingModel": "text-embedding-ada-002",
  "openclaw.memory.shortTermMaxTokens": 4096,
  "openclaw.memory.longTermMaxItems": 10000,
  "openclaw.memory.workingTimeout": 3600000,  // 1 hour
}
```

### 14.5 在 AgentChatService 中集成 Memory

```typescript
// src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts
export class AgentChatService extends Disposable implements IAgentChatService {
  private readonly _memoryProviders = new Map<string, IMemoryProvider>();

  // 注册 Memory Provider
  registerMemoryProvider(provider: IMemoryProvider): void {
    this._memoryProviders.set(provider.id, provider);
    this._logService.info(`Registered memory provider: ${provider.name}`);
  }

  // 获取 Memory Provider
  getMemoryProvider(providerId: string): IMemoryProvider | undefined {
    return this._memoryProviders.get(providerId);
  }

  // 在发送消息前，检索相关记忆
  private async _retrieveRelevantMemories(message: string, sessionId: string): Promise<MemoryResult[]> {
    const results: MemoryResult[] = [];

    for (const provider of this._memoryProviders.values()) {
      const query: MemoryQuery = {
        query: message,
        scope: MemoryScope.Session,
        limit: 5,
      };

      const providerResults = await provider.retrieve(query);
      results.push(...providerResults);
    }

    // 按相似度排序
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, 10);  // 返回 top 10
  }

  // 在接收响应后，存储记忆
  private async _storeMemory(message: string, response: string, sessionId: string): Promise<void> {
    for (const provider of this._memoryProviders.values()) {
      const memory: MemoryItem = {
        content: `User: ${message}\nAssistant: ${response}`,
        type: MemoryType.ShortTerm,
        sessionId,
        timestamp: Date.now(),
      };

      await provider.store(memory);
    }
  }
}
```

### 14.6 Memory 升级机制

#### 14.6.1 核心概念

Memory 升级机制支持在 OpenClaw 版本更新时，自动迁移和升级已有的 Memory 数据，确保数据兼容性和功能连续性。

**升级场景**：

| 场景 | 说明 | 触发条件 |
|------|------|----------|
| **存储格式升级** | Memory 数据格式发生变化 | 版本号变更，格式不兼容 |
| **存储后端升级** | 从文件存储迁移到向量数据库 | 用户配置变更或性能优化 |
| **Embedding 模型升级** | 更换 embedding 模型需要重新生成向量 | 模型配置变更 |
| **索引重建** | 向量索引损坏或需要优化 | 索引版本不匹配 |
| **批量数据迁移** | 从旧版本 OpenClaw 迁移数据 | 首次安装新版本 |

#### 14.6.2 IMemoryUpgradeService 接口

```typescript
// src/vs/sessions/common/memoryUpgradeService.ts
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

export const IMemoryUpgradeService = createDecorator<IMemoryUpgradeService>('memoryUpgradeService');

export interface IMemoryUpgradeService {
  readonly _serviceBrand: undefined;

  // 升级管理
  checkUpgradeNeeded(providerId: string): Promise<UpgradeCheckResult>;
  upgrade(providerId: string, options?: UpgradeOptions): Promise<UpgradeResult>;
  rollback(providerId: string, targetVersion: string): Promise<void>;

  // 数据迁移
  migrateData(sourceProviderId: string, targetProviderId: string, options?: MigrationOptions): Promise<MigrationResult>;

  // 索引管理
  rebuildIndex(providerId: string, options?: RebuildOptions): Promise<RebuildResult>;
  optimizeIndex(providerId: string): Promise<void>;

  // 版本管理
  getVersionInfo(providerId: string): Promise<MemoryVersionInfo>;
  setVersionInfo(providerId: string, version: string): Promise<void>;

  // 升级状态
  readonly onDidUpgradeStart: Event<UpgradeEvent>;
  readonly onDidUpgradeProgress: Event<UpgradeProgressEvent>;
  readonly onDidUpgradeComplete: Event<UpgradeEvent>;
  readonly onDidUpgradeError: Event<UpgradeErrorEvent>;
}

export interface UpgradeCheckResult {
  needed: boolean;
  currentVersion: string;
  targetVersion: string;
  upgradeType: UpgradeType;
  estimatedTime: number;  // 预计耗时（毫秒）
  affectedItems: number;    // 受影响的数据项数量
  warnings: string[];      // 警告信息
}

export enum UpgradeType {
  FormatChange = 'format_change',           // 格式变更
  BackendChange = 'backend_change',         // 存储后端变更
  EmbeddingModelChange = 'embedding_change', // Embedding 模型变更
  IndexRebuild = 'index_rebuild',           // 索引重建
  DataMigration = 'data_migration',         // 数据迁移
}

export interface UpgradeOptions {
  backup: boolean;              // 是否备份原有数据
  backupPath?: string;          // 备份路径
  batchSize: number;            // 批量处理大小
  maxConcurrent: number;        // 最大并发数
  dryRun: boolean;              // 试运行（不实际执行）
  force: boolean;               // 强制升级（忽略版本检查）
  keepOldData: boolean;         // 保留旧数据
}

export interface UpgradeResult {
  success: boolean;
  upgradedItems: number;        // 成功升级的数据项数量
  failedItems: number;          // 失败的数据项数量
  errors: UpgradeError[];       // 错误信息
  duration: number;             // 实际耗时（毫秒）
  backupPath?: string;          // 备份路径（如果创建了备份）
}

export interface UpgradeError {
  itemId: string;
  error: string;
  stack?: string;
}

export interface MigrationOptions {
  batchSize: number;
  maxConcurrent: number;
  preserveIds: boolean;         // 保留原有 ID
  transform?: (item: MemoryItem) => MemoryItem;  // 数据转换函数
  filter?: (item: MemoryItem) => boolean;        // 数据过滤函数
}

export interface MigrationResult {
  success: boolean;
  migratedItems: number;
  failedItems: number;
  errors: MigrationError[];
}

export interface MigrationError {
  sourceId: string;
  targetId?: string;
  error: string;
}

export interface RebuildOptions {
  force: boolean;              // 强制重建（即使索引完整）
  optimize: boolean;            // 重建后是否优化
  background: boolean;          // 是否在后台运行
}

export interface RebuildResult {
  success: boolean;
  rebuiltItems: number;
  duration: number;
  indexSize: number;            // 索引大小（字节）
}

export interface MemoryVersionInfo {
  version: string;
  schemaVersion: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
}

export interface UpgradeEvent {
  providerId: string;
  fromVersion: string;
  toVersion: string;
  timestamp: number;
}

export interface UpgradeProgressEvent {
  providerId: string;
  totalItems: number;
  processedItems: number;
  currentItem?: string;
  percent: number;
  estimatedRemaining: number;  // 预计剩余时间（毫秒）
}

export interface UpgradeErrorEvent {
  providerId: string;
  error: string;
  itemId?: string;
  timestamp: number;
}
```

#### 14.6.3 OpenClawMemoryUpgradeService 实现

```typescript
// extensions/openclaw/src/memory/openclawMemoryUpgradeService.ts
export class OpenClawMemoryUpgradeService implements IMemoryUpgradeService {
  readonly _serviceBrand: undefined;

  private _logService: ILogService;
  private _fileService: IFileService;
  private _progressService: IProgressService;

  // 升级事件
  private readonly _onDidUpgradeStart = this._register(new Emitter<UpgradeEvent>());
  readonly onDidUpgradeStart: Event<UpgradeEvent> = this._onDidUpgradeStart.event;

  private readonly _onDidUpgradeProgress = this._register(new Emitter<UpgradeProgressEvent>());
  readonly onDidUpgradeProgress: Event<UpgradeProgressEvent> = this._onDidUpgradeProgress.event;

  private readonly _onDidUpgradeComplete = this._register(new Emitter<UpgradeEvent>());
  readonly onDidUpgradeComplete: Event<UpgradeEvent> = this._onDidUpgradeComplete.event;

  private readonly _onDidUpgradeError = this._register(new Emitter<UpgradeErrorEvent>());
  readonly onDidUpgradeError: Event<UpgradeErrorEvent> = this._onDidUpgradeError.event;

  constructor(
    @ILogService logService: ILogService,
    @IFileService fileService: IFileService,
    @IProgressService progressService: IProgressService,
  ) {
    this._logService = logService;
    this._fileService = fileService;
    this._progressService = progressService;
  }

  async checkUpgradeNeeded(providerId: string): Promise<UpgradeCheckResult> {
    const provider = this._getProvider(providerId);
    const currentVersion = await provider.getVersionInfo();
    const targetVersion = this._getTargetVersion(provider);

    // 检查是否需要升级
    if (currentVersion.version === targetVersion) {
      return {
        needed: false,
        currentVersion: currentVersion.version,
        targetVersion,
        upgradeType: UpgradeType.FormatChange,
        estimatedTime: 0,
        affectedItems: 0,
        warnings: [],
      };
    }

    // 确定升级类型
    const upgradeType = this._determineUpgradeType(currentVersion, targetVersion);

    // 估算受影响的数据项数量
    const stats = await provider.getStats(MemoryScope.Global);

    // 估算耗时
    const estimatedTime = this._estimateUpgradeTime(upgradeType, stats.total);

    return {
      needed: true,
      currentVersion: currentVersion.version,
      targetVersion,
      upgradeType,
      estimatedTime,
      affectedItems: stats.total,
      warnings: this._generateWarnings(upgradeType, currentVersion),
    };
  }

  async upgrade(providerId: string, options?: UpgradeOptions): Promise<UpgradeResult> {
    const provider = this._getProvider(providerId);
    const checkResult = await this.checkUpgradeNeeded(providerId);

    if (!checkResult.needed) {
      return {
        success: true,
        upgradedItems: 0,
        failedItems: 0,
        errors: [],
        duration: 0,
      };
    }

    // 应用默认选项
    const opts: UpgradeOptions = {
      backup: true,
      batchSize: 100,
      maxConcurrent: 4,
      dryRun: false,
      force: false,
      keepOldData: false,
      ...options,
    };

    // 触发升级开始事件
    const upgradeEvent: UpgradeEvent = {
      providerId,
      fromVersion: checkResult.currentVersion,
      toVersion: checkResult.targetVersion,
      timestamp: Date.now(),
    };
    this._onDidUpgradeStart.fire(upgradeEvent);

    const startTime = Date.now();
    let upgradedItems = 0;
    let failedItems = 0;
    const errors: UpgradeError[] = [];

    try {
      // 1. 备份（如果启用）
      let backupPath: string | undefined;
      if (opts.backup && !opts.dryRun) {
        backupPath = await this._backup(provider, opts.backupPath);
      }

      // 2. 执行升级
      if (!opts.dryRun) {
        const result = await this._executeUpgrade(provider, checkResult.upgradeType, opts);
        upgradedItems = result.upgradedItems;
        failedItems = result.failedItems;
        errors.push(...result.errors);
      }

      // 3. 更新版本信息
      if (!opts.dryRun && failedItems === 0) {
        await provider.setVersionInfo(providerId, checkResult.targetVersion);
      }

      // 4. 清理旧数据（如果指定）
      if (!opts.keepOldData && backupPath && !opts.dryRun) {
        await this._cleanupOldData(backupPath);
      }

      const duration = Date.now() - startTime;

      // 触发升级完成事件
      this._onDidUpgradeComplete.fire(upgradeEvent);

      return {
        success: failedItems === 0,
        upgradedItems,
        failedItems,
        errors,
        duration,
        backupPath,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // 触发升级错误事件
      this._onDidUpgradeError.fire({
        providerId,
        error: String(error),
        timestamp: Date.now(),
      });

      // 尝试回滚
      if (opts.backup && !opts.dryRun) {
        await this.rollback(providerId, checkResult.currentVersion);
      }

      return {
        success: false,
        upgradedItems,
        failedItems: checkResult.affectedItems - upgradedItems,
        errors: [...errors, { itemId: '*', error: String(error) }],
        duration,
      };
    }
  }

  private async _executeUpgrade(
    provider: IMemoryProvider,
    upgradeType: UpgradeType,
    options: UpgradeOptions,
  ): Promise<Omit<UpgradeResult, 'duration' | 'backupPath'>> {
    switch (upgradeType) {
      case UpgradeType.FormatChange:
        return this._upgradeFormat(provider, options);
      case UpgradeType.BackendChange:
        return this._upgradeBackend(provider, options);
      case UpgradeType.EmbeddingModelChange:
        return this._upgradeEmbeddingModel(provider, options);
      case UpgradeType.IndexRebuild:
        return this._upgradeIndex(provider, options);
      default:
        throw new Error(`Unsupported upgrade type: ${upgradeType}`);
    }
  }

  private async _upgradeEmbeddingModel(
    provider: IMemoryProvider,
    options: UpgradeOptions,
  ): Promise<Omit<UpgradeResult, 'duration' | 'backupPath'>> {
    // 1. 获取所有需要重新生成 embedding 的数据
    const allMemories = await this._getAllMemories(provider);
    const totalItems = allMemories.length;
    let processedItems = 0;
    let upgradedItems = 0;
    let failedItems = 0;
    const errors: UpgradeError[] = [];

    // 2. 批量重新生成 embedding
    const batches = this._chunk(allMemories, options.batchSize);

    for (const batch of batches) {
      const promises = batch.map(async (memory) => {
        try {
          // 重新生成 embedding
          const newEmbedding = await this._regenerateEmbedding(memory.content);

          // 更新 memory
          await provider.update(memory.id!, { embedding: newEmbedding });

          upgradedItems++;
        } catch (error) {
          failedItems++;
          errors.push({ itemId: memory.id!, error: String(error) });
        } finally {
          processedItems++;

          // 报告进度
          this._onDidUpgradeProgress.fire({
            providerId: provider.id,
            totalItems,
            processedItems,
            currentItem: memory.id,
            percent: (processedItems / totalItems) * 100,
            estimatedRemaining: this._estimateRemainingTime(processedItems, totalItems, Date.now()),
          });
        }
      });

      await Promise.all(promises);
    }

    return { success: failedItems === 0, upgradedItems, failedItems, errors };
  }

  private async _backup(provider: IMemoryProvider, backupPath?: string): Promise<string> {
    // 创建备份
    const path = backupPath || await this._generateBackupPath(provider.id);

    // 导出所有数据
    const allMemories = await this._getAllMemories(provider);

    // 写入备份文件
    await this._writeBackupFile(path, allMemories, await provider.getVersionInfo());

    this._logService.info(`Created backup at: ${path}`);

    return path;
  }

  // ... 其他私有方法
}
```

#### 14.6.4 升级流程

**标准升级流程**：

```
1. 检查升级需求
   ├─ 检查当前版本
   ├─ 检查目标版本
   ├─ 确定升级类型
   └─ 估算影响范围

2. 创建备份（可选）
   ├─ 导出所有 Memory 数据
   ├─ 保存版本信息
   └─ 保存到备份路径

3. 执行升级
   ├─ 根据升级类型执行相应操作
   │  ├─ 格式变更：转换数据格式
   │  ├─ 后端变更：迁移数据到新后端
   │  ├─ Embedding 模型变更：重新生成向量
   │  └─ 索引重建：重建向量索引
   ├─ 批量处理（支持并发）
   ├─ 报告进度
   └─ 记录错误

4. 验证升级结果
   ├─ 检查数据完整性
   ├─ 验证索引正确性
   └─ 测试检索功能

5. 更新版本信息
   ├─ 更新版本号
   ├─ 更新 schema 版本
   └─ 记录升级时间

6. 清理（可选）
   ├─ 删除旧数据
   └─ 删除备份（如果用户确认）
```

**升级策略**：

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| **就地升级（In-place）** | 直接在原数据上升级 | 小版本更新，格式兼容 |
| **迁移升级（Migration）** | 创建新存储，迁移数据 | 大版本更新，后端变更 |
| **双写升级（Dual-write）** | 同时写入新旧存储 | 零停机时间升级 |
| **影子升级（Shadow）** | 后台升级，验证后切换 | 关键业务系统 |

#### 14.6.5 配置项

```jsonc
// settings.json 中的 Memory 升级配置项
{
  "openclaw.memory.upgrade.autoCheck": true,          // 启动时自动检查升级
  "openclaw.memory.upgrade.autoBackup": true,         // 升级前自动备份
  "openclaw.memory.upgrade.backupPath": "",           // 备份路径（空=默认路径）
  "openclaw.memory.upgrade.batchSize": 100,           // 批量处理大小
  "openclaw.memory.upgrade.maxConcurrent": 4,         // 最大并发数
  "openclaw.memory.upgrade.keepOldData": false,       // 升级后保留旧数据
  "openclaw.memory.upgrade.dryRun": false,            // 试运行模式
  "openclaw.memory.upgrade.notification": true,       // 升级完成时通知用户
  "openclaw.memory.upgrade.embeddingModel": "",        // 目标 Embedding 模型（空=使用当前配置）
}
```

#### 14.6.6 在 AgentChatService 中集成升级功能

```typescript
// src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts
export class AgentChatService extends Disposable implements IAgentChatService {
  private readonly _upgradeService: IMemoryUpgradeService;

  constructor(
    @IMemoryUpgradeService upgradeService: IMemoryUpgradeService,
  ) {
    this._upgradeService = upgradeService;

    // 监听升级事件
    this._register(this._upgradeService.onDidUpgradeStart((e) => {
      this._showUpgradeProgress(e, 'start');
    }));

    this._register(this._upgradeService.onDidUpgradeProgress((e) => {
      this._updateUpgradeProgress(e);
    }));

    this._register(this._upgradeService.onDidUpgradeComplete((e) => {
      this._showUpgradeResult(e, 'complete');
    }));

    this._register(this._upgradeService.onDidUpgradeError((e) => {
      this._showUpgradeResult(e, 'error');
    }));
  }

  // 检查并升级 Memory Provider
  async checkAndUpgradeMemory(providerId: string): Promise<void> {
    const checkResult = await this._upgradeService.checkUpgradeNeeded(providerId);

    if (!checkResult.needed) {
      this._logService.info(`No upgrade needed for provider: ${providerId}`);
      return;
    }

    // 显示升级确认对话框
    const confirmed = await this._showUpgradeConfirmation(checkResult);

    if (!confirmed) {
      return;
    }

    // 执行升级
    const result = await this._upgradeService.upgrade(providerId);

    if (result.success) {
      this._logService.info(`Upgrade completed for provider: ${providerId}`, result);
    } else {
      this._logService.error(`Upgrade failed for provider: ${providerId}`, result.errors);
    }
  }

  private async _showUpgradeConfirmation(checkResult: UpgradeCheckResult): Promise<boolean> {
    // 显示升级确认对话框
    // 包含升级详情、预计耗时、警告信息等
    return true; // 用户确认结果
  }
}
```

---

## 15. OpenClaw Agent 机制接入

### 15.1 核心概念

OpenClaw 的 Agent 机制提供完整的 Agent 运行时，支持创建、执行、管理和监控多个 Agent 实例。

**核心组件**：

| 组件 | 说明 | 职责 |
|------|------|------|
| **Agent Runtime** | Agent 运行时管理器 | 创建、执行、停止 Agent |
| **Agent Config** | Agent 配置 | 定义 Agent 的模型、工具、提示词等 |
| **Agent Loop** | Agent 执行循环 | 处理用户输入、调用工具、生成响应 |
| **Session Manager** | 会话管理器 | 管理多个对话会话 |
| **Tool Registry** | 工具注册表 | 注册和调用工具 |

### 15.2 Agent 运行时接口设计

#### 15.2.1 IAgentRuntime 接口

```typescript
// src/vs/sessions/common/agentRuntime.ts
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

export const IAgentRuntime = createDecorator<IAgentRuntime>('agentRuntime');

export interface IAgentRuntime {
  readonly _serviceBrand: undefined;

  readonly id: string;
  readonly name: string;

  // Agent 管理
  createAgent(config: AgentConfig): Promise<Agent>;
  getAgent(agentId: string): Promise<Agent | undefined>;
  updateAgent(agentId: string, updates: Partial<AgentConfig>): Promise<Agent>;
  deleteAgent(agentId: string): Promise<void>;
  listAgents(): Promise<Agent[]>;

  // Agent 执行
  executeAgent(agentId: string, input: AgentInput, token?: CancellationToken): Promise<AgentOutput>;
  stopAgent(agentId: string): Promise<void>;
  pauseAgent(agentId: string): Promise<void>;
  resumeAgent(agentId: string): Promise<void>;

  // 状态查询
  getAgentStatus(agentId: string): Promise<AgentStatus>;
  getAgentLogs(agentId: string, options?: LogOptions): Promise<AgentLogEntry[]>;

  // 事件
  readonly onDidAgentCreated: Event<Agent>;
  readonly onDidAgentDeleted: Event<string>;
  readonly onDidAgentStatusChange: Event<AgentStatusChangeEvent>;
}

export interface AgentConfig {
  id?: string;
  name: string;
  description?: string;

  // 模型配置
  model: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;

  // 提示词
  systemPrompt?: string;
  userPromptTemplate?: string;

  // 工具配置
  tools?: string[];  // 工具 ID 列表
  toolChoice?: 'auto' | 'none' | string;  // 工具选择策略

  // Memory 配置
  memory?: AgentMemoryConfig;

  // 高级配置
  maxIterations?: number;
  timeout?: number;
  retryPolicy?: RetryPolicy;
}

export interface AgentMemoryConfig {
  enabled: boolean;
  memoryProviderId?: string;  // 使用的 Memory Provider ID
  shortTermEnabled: boolean;
  longTermEnabled: boolean;
  workingEnabled: boolean;
  retrievalStrategy?: 'always' | 'on_demand' | 'never';
}

export interface Agent {
  id: string;
  config: AgentConfig;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface AgentInput {
  message: string;
  sessionId?: string;
  context?: Record<string, unknown>;
  attachments?: Attachment[];
  streaming?: boolean;  // 是否流式输出
}

export interface AgentOutput {
  response: string;
  toolCalls?: ToolCall[];
  memoryUpdates?: MemoryUpdate[];
  metadata?: Record<string, unknown>;

  // 流式输出支持
  stream?: AsyncIterable<StreamChunk>;
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'thinking' | 'done';
  content?: string;
  toolCall?: ToolCall;
}

export enum AgentStatus {
  Idle = 'idle',
  Running = 'running',
  Paused = 'paused',
  Stopped = 'stopped',
  Error = 'error',
}

export interface AgentStatusChangeEvent {
  agentId: string;
  oldStatus: AgentStatus;
  newStatus: AgentStatus;
  timestamp: number;
}

export interface LogOptions {
  from?: number;  // 起始时间戳
  to?: number;    // 结束时间戳
  level?: 'debug' | 'info' | 'warn' | 'error';
  limit?: number;
}

export interface AgentLogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}
```

#### 15.2.2 ToolCall 定义

```typescript
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  result?: ToolCallResult;
  error?: string;
}

export enum ToolCallStatus {
  Pending = 'pending',
  Running = 'running',
  Success = 'success',
  Error = 'error',
}

export interface ToolCallResult {
  content: string;
  metadata?: Record<string, unknown>;
}
```

### 15.3 OpenClaw Agent 实现

#### 15.3.1 目录结构

```
extensions/openclaw/src/
├── runtime/
│   ├── openclawAgentRuntime.ts       # IAgentRuntime 实现
│   ├── agentLoop.ts                   # Agent 执行循环
│   ├── agentManager.ts                # Agent 管理器
│   ├── sessionManager.ts              # 会话管理器
│   ├── toolRegistry.ts                # 工具注册表
│   └── agentUtils.ts                 # 工具函数
├── backend/
│   └── openclawBackend.ts            # 新增：集成 Agent Runtime
└── ...
```

#### 15.3.2 OpenClawAgentRuntime 实现

```typescript
// extensions/openclaw/src/runtime/openclawAgentRuntime.ts
import { IAgentRuntime, AgentConfig, Agent, AgentInput, AgentOutput, AgentStatus } from '../../../../src/vs/sessions/common/agentRuntime';

export class OpenClawAgentRuntime implements IAgentRuntime {
  readonly _serviceBrand: undefined;

  readonly id = 'openclaw-runtime';
  readonly name = 'OpenClaw Agent Runtime';

  private _agents = new Map<string, Agent>();
  private _agentLoops = new Map<string, AgentLoop>();
  private _logService: ILogService;
  private _gatewayEndpoint: string;

  constructor(options: AgentRuntimeOptions) {
    this._logService = options.logService;
    this._gatewayEndpoint = options.gatewayEndpoint;
  }

  async createAgent(config: AgentConfig): Promise<Agent> {
    // 1. 验证配置
    this._validateConfig(config);

    // 2. 生成 Agent ID（如果未提供）
    if (!config.id) {
      config.id = generateUuid();
    }

    // 3. 创建 Agent 实例
    const agent: Agent = {
      id: config.id,
      config,
      status: AgentStatus.Idle,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 4. 存储 Agent
    this._agents.set(agent.id, agent);

    this._logService.info(`Created agent: ${agent.name}`, { agentId: agent.id });

    // 5. 触发事件
    this._onDidAgentCreated.fire(agent);

    return agent;
  }

  async executeAgent(agentId: string, input: AgentInput, token?: CancellationToken): Promise<AgentOutput> {
    const agent = this._agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // 1. 更新 Agent 状态为 Running
    agent.status = AgentStatus.Running;
    this._onDidAgentStatusChange.fire({
      agentId,
      oldStatus: AgentStatus.Idle,
      newStatus: AgentStatus.Running,
      timestamp: Date.now(),
    });

    try {
      // 2. 创建或获取 Agent Loop
      let agentLoop = this._agentLoops.get(agentId);
      if (!agentLoop) {
        agentLoop = new AgentLoop(agent, this._gatewayEndpoint, this._logService);
        this._agentLoops.set(agentId, agentLoop);
      }

      // 3. 执行 Agent Loop
      const output = await agentLoop.execute(input, token);

      // 4. 更新 Agent 状态为 Idle
      agent.status = AgentStatus.Idle;
      this._onDidAgentStatusChange.fire({
        agentId,
        oldStatus: AgentStatus.Running,
        newStatus: AgentStatus.Idle,
        timestamp: Date.now(),
      });

      return output;
    } catch (error) {
      // 5. 更新 Agent 状态为 Error
      agent.status = AgentStatus.Error;
      this._onDidAgentStatusChange.fire({
        agentId,
        oldStatus: AgentStatus.Running,
        newStatus: AgentStatus.Error,
        timestamp: Date.now(),
      });

      this._logService.error(`Agent execution failed: ${agentId}`, error);
      throw error;
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    const agentLoop = this._agentLoops.get(agentId);
    if (agentLoop) {
      await agentLoop.stop();
    }

    const agent = this._agents.get(agentId);
    if (agent) {
      agent.status = AgentStatus.Stopped;
      this._onDidAgentStatusChange.fire({
        agentId,
        oldStatus: agent.status,
        newStatus: AgentStatus.Stopped,
        timestamp: Date.now(),
      });
    }
  }

  async getAgentStatus(agentId: string): Promise<AgentStatus> {
    const agent = this._agents.get(agentId);
    return agent?.status || AgentStatus.Stopped;
  }

  // ... 其他方法
}
```

#### 15.3.3 Agent Loop 实现

```typescript
// extensions/openclaw/src/runtime/agentLoop.ts
export class AgentLoop {
  private _agent: Agent;
  private _gatewayEndpoint: string;
  private _logService: ILogService;
  private _memoryProvider?: IMemoryProvider;

  constructor(agent: Agent, gatewayEndpoint: string, logService: ILogService) {
    this._agent = agent;
    this._gatewayEndpoint = gatewayEndpoint;
    this._logService = logService;
  }

  async execute(input: AgentInput, token?: CancellationToken): Promise<AgentOutput> {
    // 1. 检索相关记忆（如果启用）
    let relevantMemories: MemoryResult[] = [];
    if (this._agent.config.memory?.enabled) {
      relevantMemories = await this._retrieveMemories(input.message);
    }

    // 2. 构建消息列表
    const messages = await this._buildMessages(input, relevantMemories);

    // 3. 调用 OpenClaw Gateway 执行 Agent
    const response = await this._callGateway(messages, token);

    // 4. 处理工具调用
    const toolCalls = await this._processToolCalls(response.toolCalls);

    // 5. 存储记忆（如果启用）
    if (this._agent.config.memory?.enabled) {
      await this._storeMemory(input.message, response.content);
    }

    // 6. 返回结果
    return {
      response: response.content,
      toolCalls,
      metadata: response.metadata,
    };
  }

  private async _retrieveMemories(query: string): Promise<MemoryResult[]> {
    if (!this._memoryProvider) {
      return [];
    }

    const memoryQuery: MemoryQuery = {
      query,
      limit: 10,
    };

    return this._memoryProvider.retrieve(memoryQuery);
  }

  private async _storeMemory(message: string, response: string): Promise<void> {
    if (!this._memoryProvider) {
      return;
    }

    const memory: MemoryItem = {
      content: `User: ${message}\nAssistant: ${response}`,
      type: MemoryType.ShortTerm,
      timestamp: Date.now(),
    };

    await this._memoryProvider.store(memory);
  }

  private async _callGateway(messages: Message[], token?: CancellationToken): Promise<GatewayResponse> {
    // 调用 OpenClaw Gateway 的 Agent 执行 API
    const response = await fetch(`${this._gatewayEndpoint}/agents/${this._agent.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        model: this._agent.config.model,
        tools: this._agent.config.tools,
        maxIterations: this._agent.config.maxIterations,
      }),
      signal: token?.signal,
    });

    return response.json();
  }
}
```

### 15.4 与 OpenClaw Gateway 的集成

#### 15.4.1 Gateway API 端点

```
OpenClaw Gateway 新增 Agent API：
  POST   /agents                      # 创建 Agent
  GET    /agents                     # 列出所有 Agent
  GET    /agents/{agentId}           # 获取 Agent 详情
  PUT    /agents/{agentId}           # 更新 Agent 配置
  DELETE /agents/{agentId}           # 删除 Agent
  POST   /agents/{agentId}/execute   # 执行 Agent
  POST   /agents/{agentId}/stop      # 停止 Agent
  GET    /agents/{agentId}/status    # 获取 Agent 状态
  GET    /agents/{agentId}/logs      # 获取 Agent 日志
```

#### 15.4.2 配置项

```jsonc
// settings.json 中的 Agent 配置项
{
  "openclaw.agent.enabled": true,
  "openclaw.agent.defaultModel": "claude-3-5-sonnet-20241022",
  "openclaw.agent.defaultMaxIterations": 90,
  "openclaw.agent.defaultTemperature": 0.7,
  "openclaw.agent.memory.enabled": true,
  "openclaw.agent.memory.retrievalStrategy": "always",  // "always" | "on_demand" | "never"
  "openclaw.agent.tools.autoLoad": true,
  "openclaw.agent.executionTimeout": 300000,  // 5 minutes
}
```

### 15.5 在 AgentChatService 中集成 Agent Runtime

```typescript
// src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts
export class AgentChatService extends Disposable implements IAgentChatService {
  private readonly _agentRuntimes = new Map<string, IAgentRuntime>();

  // 注册 Agent Runtime
  registerAgentRuntime(runtime: IAgentRuntime): void {
    this._agentRuntimes.set(runtime.id, runtime);
    this._logService.info(`Registered agent runtime: ${runtime.name}`);
  }

  // 获取 Agent Runtime
  getAgentRuntime(runtimeId: string): IAgentRuntime | undefined {
    return this._agentRuntimes.get(runtimeId);
  }

  // 使用指定 Agent Runtime 执行
  async executeWithAgent(agentId: string, message: string, options?: IChatSendOptions): Promise<ChatMessage> {
    // 1. 找到 Agent 所属的 Runtime
    let targetRuntime: IAgentRuntime | undefined;
    for (const runtime of this._agentRuntimes.values()) {
      const agent = await runtime.getAgent(agentId);
      if (agent) {
        targetRuntime = runtime;
        break;
      }
    }

    if (!targetRuntime) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // 2. 执行 Agent
    const input: AgentInput = {
      message,
      sessionId: options?.sessionId,
      context: options?.context,
    };

    const output = await targetRuntime.executeAgent(agentId, input);

    // 3. 转换为 ChatMessage
    const chatMessage: ChatMessage = {
      id: generateUuid(),
      role: 'assistant',
      content: output.response,
      timestamp: Date.now(),
      toolCalls: output.toolCalls,
    };

    return chatMessage;
  }
}
```

### 15.6 Agent 升级机制

#### 15.6.1 核心概念

Agent 升级机制支持在 OpenClaw 版本更新时，自动迁移和升级已有的 Agent 配置和数据，确保 Agent 功能的连续性和兼容性。

**升级场景**：

| 场景 | 说明 | 触发条件 |
|------|------|----------|
| **配置格式升级** | Agent 配置格式发生变化 | 版本号变更，配置不兼容 |
| **运行时升级** | Agent 运行时版本更新 | 运行时 API 变更 |
| **工具接口升级** | Agent 使用的工具接口发生变化 | 工具 API 变更 |
| **模型配置升级** | 默认模型或模型参数变更 | 模型配置变更 |
| **批量 Agent 迁移** | 从旧版本 OpenClaw 迁移 Agent | 首次安装新版本 |

#### 15.6.2 升级流程

**标准升级流程**：

```
1. 检查升级需求
   ├─ 检查当前版本
   ├─ 检查目标版本
   ├─ 确定升级类型
   ├─ 检查破坏性变更
   └─ 估算影响范围

2. 创建备份（可选）
   ├─ 导出所有 Agent 配置
   ├─ 保存版本信息
   ├─ 备份工具配置
   └─ 保存到备份路径

3. 执行升级
   ├─ 根据升级类型执行相应操作
   │  ├─ 配置格式变更：转换配置格式
   │  ├─ 运行时变更：更新运行时 API 调用
   │  ├─ 工具接口变更：更新工具配置
   │  └─ 模型配置变更：更新模型参数
   ├─ 逐个升级 Agent
   ├─ 报告进度
   └─ 记录错误

4. 验证升级结果
   ├─ 检查配置完整性
   ├─ 验证 Agent 状态
   ├─ 测试 Agent 执行
   └─ 验证工具配置

5. 更新版本信息
   ├─ 更新版本号
   ├─ 更新 schema 版本
   └─ 记录升级时间

6. 清理（可选）
   ├─ 删除旧配置
   └─ 删除备份（如果用户确认）
```

**升级策略**：

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| **就地升级（In-place）** | 直接在原配置上升级 | 小版本更新，配置兼容 |
| **迁移升级（Migration）** | 创建新配置，迁移 Agent | 大版本更新，配置格式不兼容 |
| **蓝绿升级（Blue-Green）** | 同时运行新旧版本，逐步切换 | 零停机时间升级 |
| **金丝雀升级（Canary）** | 先升级部分 Agent，验证后全量升级 | 关键业务系统 |

#### 15.6.3 配置项

```jsonc
// settings.json 中的 Agent 升级配置项
{
  "openclaw.agent.upgrade.autoCheck": true,          // 启动时自动检查升级
  "openclaw.agent.upgrade.autoBackup": true,         // 升级前自动备份
  "openclaw.agent.upgrade.backupPath": "",           // 备份路径（空=默认路径）
  "openclaw.agent.upgrade.batchSize": 10,            // 批量处理大小
  "openclaw.agent.upgrade.keepOldConfig": false,     // 升级后保留旧配置
  "openclaw.agent.upgrade.dryRun": false,            // 试运行模式
  "openclaw.agent.upgrade.notification": true,       // 升级完成时通知用户
  "openclaw.agent.upgrade.upgradeTools": true,       // 自动升级工具配置
  "openclaw.agent.upgrade.upgradeModel": true,       // 自动升级模型配置
  "openclaw.agent.upgrade.autoRollback": true,       // 失败时自动回滚
}
```

#### 15.6.4 接口设计

```typescript
// src/vs/sessions/common/agentUpgradeService.ts
export interface IAgentUpgradeService {
  readonly _serviceBrand: undefined;

  // 升级管理
  checkUpgradeNeeded(runtimeId: string): Promise<AgentUpgradeCheckResult>;
  upgrade(runtimeId: string, options?: AgentUpgradeOptions): Promise<AgentUpgradeResult>;
  rollback(runtimeId: string, targetVersion: string): Promise<void>;

  // Agent 配置迁移
  migrateAgent(agentId: string, targetRuntimeId: string, options?: AgentMigrationOptions): Promise<AgentMigrationResult>;
  migrateAllAgents(sourceRuntimeId: string, targetRuntimeId: string, options?: AgentMigrationOptions): Promise<AgentMigrationResult>;

  // 配置格式转换
  upgradeConfig(config: AgentConfig, fromVersion: string, toVersion: string): Promise<AgentConfig>;
  validateConfig(config: AgentConfig, version: string): Promise<ConfigValidationResult>;

  // 版本管理
  getVersionInfo(runtimeId: string): Promise<AgentVersionInfo>;
  setVersionInfo(runtimeId: string, version: string): Promise<void>;

  // 升级状态
  readonly onDidUpgradeStart: Event<AgentUpgradeEvent>;
  readonly onDidUpgradeProgress: Event<AgentUpgradeProgressEvent>;
  readonly onDidUpgradeComplete: Event<AgentUpgradeEvent>;
  readonly onDidUpgradeError: Event<AgentUpgradeErrorEvent>;
}
```

#### 15.6.5 在 AgentChatService 中集成升级功能

```typescript
// src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts
export class AgentChatService extends Disposable implements IAgentChatService {
  private readonly _agentUpgradeService: IAgentUpgradeService;

  constructor(
    @IAgentUpgradeService agentUpgradeService: IAgentUpgradeService,
  ) {
    this._agentUpgradeService = agentUpgradeService;

    // 监听升级事件
    this._register(this._agentUpgradeService.onDidUpgradeStart((e) => {
      this._showUpgradeProgress(e, 'start');
    }));

    this._register(this._agentUpgradeService.onDidUpgradeProgress((e) => {
      this._updateUpgradeProgress(e);
    }));

    this._register(this._agentUpgradeService.onDidUpgradeComplete((e) => {
      this._showUpgradeResult(e, 'complete');
    }));

    this._register(this._agentUpgradeService.onDidUpgradeError((e) => {
      this._showUpgradeResult(e, 'error');
    }));
  }

  // 检查并升级 Agent Runtime
  async checkAndUpgradeAgentRuntime(runtimeId: string): Promise<void> {
    const checkResult = await this._agentUpgradeService.checkUpgradeNeeded(runtimeId);

    if (!checkResult.needed) {
      this._logService.info(`No upgrade needed for runtime: ${runtimeId}`);
      return;
    }

    // 显示升级确认对话框
    const confirmed = await this._showUpgradeConfirmation(checkResult);

    if (!confirmed) {
      return;
    }

    // 执行升级
    const result = await this._agentUpgradeService.upgrade(runtimeId);

    if (result.success) {
      this._logService.info(`Upgrade completed for runtime: ${runtimeId}`, result);
    } else {
      this._logService.error(`Upgrade failed for runtime: ${runtimeId}`, result.errors);
    }
  }

  // 迁移 Agent 到新的 Runtime
  async migrateAgentToRuntime(agentId: string, targetRuntimeId: string): Promise<void> {
    const result = await this._agentUpgradeService.migrateAgent(agentId, targetRuntimeId);

    if (result.success) {
      this._logService.info(`Migrated agent ${agentId} to runtime ${targetRuntimeId}`);
    } else {
      this._logService.error(`Failed to migrate agent ${agentId}`, result.errors);
    }
  }
}
```

---

## 16. 总结

本文档详细设计了 Saros Agent Studio 与 OpenClaw 的集成架构，采用插件化设计，支持灵活扩展和独立更新。

**核心成果**：
1. ✅ **插件化架构**：OpenClaw 功能封装为独立插件，支持独立更新
2. ✅ **Memory 机制接入**：设计 `IMemoryProvider` 接口，支持多层次记忆系统
3. ✅ **Agent 机制接入**：设计 `IAgentRuntime` 接口，支持完整的 Agent 运行时
4. ✅ **Memory 升级机制**：设计 `IMemoryUpgradeService` 接口，支持 Memory 数据迁移和版本升级
5. ✅ **Agent 升级机制**：设计 `IAgentUpgradeService` 接口，支持 Agent 配置迁移和版本升级
6. ✅ **与 Gateway 集成**：定义清晰的 API 端点，实现 VSCode 与 OpenClaw 的无缝对接
7. ✅ **配置管理**：提供灵活的配置项，支持用户自定义

**后续工作**：
1. 实现 `IMemoryProvider` 和 `IAgentRuntime` 接口
2. 实现 `IMemoryUpgradeService` 和 `IAgentUpgradeService` 接口
3. 开发 OpenClaw Memory 和 Agent 插件
4. 开发 Memory 和 Agent 升级功能
5. 完善 Gateway API 端点
6. 编写单元测试和集成测试
7. 更新用户文档和开发者文档

---

## 17. OpenClaw 引擎源码集成设计

### 17.1 核心设计理念

**设计目标**：将 OpenClaw 的核心引擎源码直接集成到 VSCode 插件中，而不是通过 npm 包依赖，实现：
1. **完全自给自足**：插件包含完整的 OpenClaw 引擎，无需外部依赖
2. **版本完全可控**：引擎版本与插件版本同步，避免依赖冲突
3. **深度定制能力**：可直接修改引擎代码以适应 VSCode 环境
4. **离线可用**：无需联网下载依赖，插件安装即可使用

### 17.2 引擎源码范围界定

#### 17.2.1 需要集成的核心模块

```
OpenClaw 引擎核心模块：
├── gateway/              # Gateway 服务核心
│   ├── server.ts        # HTTP/WebSocket 服务器
│   ├── router.ts        # API 路由
│   ├── session.ts       # 会话管理
│   ├── auth.ts          # 认证授权
│   └── config.ts       # 配置管理
├── runtime/             # Agent 运行时
│   ├── agent.ts         # Agent 主类
│   ├── loop.ts          # Agent 执行循环
│   ├── toolRegistry.ts  # 工具注册表
│   ├── memory.ts        # 记忆管理
│   └── modelAdapter.ts  # 模型适配器
├── protocol/            # 协议定义
│   ├── types.ts        # 类型定义
│   ├── serializer.ts    # 序列化/反序列化
│   └── validator.ts    # 协议验证
├── skills/              # 核心技能
│   ├── codeAnalysis.ts  # 代码分析
│   ├── fileOps.ts      # 文件操作
│   ├── shell.ts        # Shell 命令执行
│   └── webSearch.ts   # Web 搜索
└── utils/               # 工具函数
    ├── embedding.ts     # Embedding 生成
    ├── vectorDb.ts      # 向量数据库接口
    └── logger.ts       # 日志工具
```

#### 17.2.2 不需要集成的部分

```
无需集成的模块（使用 VSCode 原生能力替代）：
├── UI 层                # 使用 Agent Studio WebView 替代
├── 配置文件加载器        # 使用 VSCode ConfigurationService
├── 日志系统             # 使用 VSCode LogService
├── 文件系统集成         # 使用 VSCode FileService
└── 终端模拟器           # 使用 VSCode TerminalService
```

### 17.3 集成架构设计

#### 17.3.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    VSCode 主进程                                     │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │          Agent Studio Core (sessions/contrib/agentStudio/)    │   │
│  │  ├── agentChatService.ts (多后端路由)                      │   │
│  │  ├── agentStudioService.ts (员工/工作区管理)               │   │
│  │  └── backendPluginRegistry.ts (插件注册表)                 │   │
│  └───────────────────────┬─────────────────────────────────┘   │
│                          │ 加载插件                               │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │          OpenClaw 插件 (extensions/openclaw/)                │   │
│  │                                                             │   │
│  │  ┌─────────────────────────────────────────────────────┐   │   │
│  │  │             插件适配层 (adapter/)                        │   │   │
│  │  │  ├── vsCodeAdapter.ts       # VSCode API 适配        │   │   │
│  │  │  ├── configAdapter.ts       # 配置系统适配           │   │   │
│  │  │  ├── loggerAdapter.ts       # 日志系统适配           │   │   │
│  │  │  ├── fileSystemAdapter.ts  # 文件系统适配           │   │   │
│  │  │  └── terminalAdapter.ts    # 终端模拟器适配         │   │   │
│  │  └─────────────────────────────────────────────────────┘   │   │
│  │                          │                                   │   │
│  │                          ▼                                   │   │
│  │  ┌─────────────────────────────────────────────────────┐   │   │
│  │  │             OpenClaw 引擎源码 (engine/)                 │   │   │
│  │  │  ├── gateway/                                      │   │   │
│  │  │  │   ├── server.ts                                │   │   │
│  │  │  │   ├── router.ts                                │   │   │
│  │  │  │   └── session.ts                              │   │   │
│  │  │  ├── runtime/                                     │   │   │
│  │  │  │   ├── agent.ts                                 │   │   │
│  │  │  │   ├── loop.ts                                  │   │   │
│  │  │  │   └── toolRegistry.ts                          │   │   │
│  │  │  ├── protocol/                                   │   │   │
│  │  │  │   ├── types.ts                                 │   │   │
│  │  │  │   └── serializer.ts                           │   │   │
│  │  │  ├── skills/                                     │   │   │
│  │  │  │   ├── codeAnalysis.ts                          │   │   │
│  │  │  │   └── fileOps.ts                              │   │   │
│  │  │  └── utils/                                      │   │   │
│  │  │      ├── embedding.ts                              │   │   │
│  │  │      └── vectorDb.ts                              │   │   │
│  │  └─────────────────────────────────────────────────────┘   │   │
│  │                          │                                   │   │
│  │                          ▼                                   │   │
│  │  ┌─────────────────────────────────────────────────────┐   │   │
│  │  │             插件接口层 (interface/)                      │   │   │
│  │  │  ├── openclawBackend.ts     # IChatBackend 实现      │   │   │
│  │  │  ├── openclawMemoryProvider.ts # IMemoryProvider 实现 │   │   │
│  │  │  ├── openclawAgentRuntime.ts  # IAgentRuntime 实现  │   │   │
│  │  │  └── openclawGatewayService.ts # Gateway 生命周期  │   │   │
│  │  └─────────────────────────────────────────────────────┘   │   │
│  │                                                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

#### 17.3.2 目录结构（更新后）

```
extensions/openclaw/
├── package.json                      # 插件 manifest（无 @openclaw/* 依赖）
├── README.md                        # 插件文档
├── CHANGELOG.md                     # 版本更新日志
├── src/
│   ├── extension.ts                 # 插件入口（activate/deactivate）
│   │
│   ├── adapter/                    # 🆕 适配层（VSCode API → OpenClaw API）
│   │   ├── vsCodeAdapter.ts        # VSCode 核心 API 适配器
│   │   ├── configAdapter.ts        # 配置系统适配器
│   │   ├── loggerAdapter.ts        # 日志系统适配器
│   │   ├── fileSystemAdapter.ts   # 文件系统适配器
│   │   ├── terminalAdapter.ts     # 终端模拟器适配器
│   │   ├── embeddingAdapter.ts     # Embedding API 适配器
│   │   └── vectorDbAdapter.ts     # 向量数据库适配器
│   │
│   ├── engine/                    # 🆕 OpenClaw 引擎源码（直接集成）
│   │   ├── gateway/               # Gateway 服务核心
│   │   │   ├── server.ts
│   │   │   ├── router.ts
│   │   │   ├── session.ts
│   │   │   ├── auth.ts
│   │   │   └── config.ts
│   │   ├── runtime/               # Agent 运行时
│   │   │   ├── agent.ts
│   │   │   ├── loop.ts
│   │   │   ├── toolRegistry.ts
│   │   │   ├── memory.ts
│   │   │   └── modelAdapter.ts
│   │   ├── protocol/              # 协议定义
│   │   │   ├── types.ts
│   │   │   ├── serializer.ts
│   │   │   └── validator.ts
│   │   ├── skills/                # 核心技能
│   │   │   ├── codeAnalysis.ts
│   │   │   ├── fileOps.ts
│   │   │   ├── shell.ts
│   │   │   └── webSearch.ts
│   │   └── utils/                 # 工具函数
│   │       ├── embedding.ts
│   │       ├── vectorDb.ts
│   │       └── logger.ts
│   │
│   ├── interface/                 # 插件接口层（实现 VSCode 接口）
│   │   ├── openclawBackend.ts     # IChatBackend 实现
│   │   ├── openclawMemoryProvider.ts  # IMemoryProvider 实现
│   │   ├── openclawAgentRuntime.ts   # IAgentRuntime 实现
│   │   ├── openclawGatewayService.ts  # Gateway 生命周期管理
│   │   └── eventTranslator.ts    # OpenClaw → IChatStreamDelta
│   │
│   └── utils/                     # 插件工具函数
│       ├── versionChecker.ts      # 版本检查
│       └── dependencyManager.ts   # 依赖管理（现仅管理 VSCode API 版本）
│
├── dist/                           # 编译产物
│   ├── extension.js
│   ├── adapter.js
│   ├── engine.js
│   └── interface.js
│
└── resources/
    ├── icon.svg
    └── sounds/                    # 通知音效
```

### 17.4 适配层设计

#### 17.4.1 适配层核心原则

| 原则 | 说明 | 实践 |
|------|------|------|
| **API 映射** | 将 VSCode API 映射为 OpenClaw 期望的 API | `IFileService` → `FileSystemAPI` |
| **行为模拟** | 模拟 Node.js 原生 API 行为 | `fs.promises.readFile` → `IFileService.readFile()` |
| **错误处理** | 将 VSCode 错误转换为 OpenClaw 错误 | `FileNotFound` → `ENOENT` |
| **异步转换** | 将 VSCode 异步 API 转换为 OpenClaw 期望的格式 | `Promise<T>` → `AsyncResult<T>` |
| **配置桥接** | 将 VSCode ConfigurationService 桥接到 OpenClaw 配置系统 | `workspace.getConfiguration()` → `Config.get()` |

#### 17.4.2 文件系统适配器示例

```typescript
// extensions/openclaw/src/adapter/fileSystemAdapter.ts

import { IFileService } from 'vs/platform/files/common/files';
import { URI } from 'vs/base/common/uri';

/**
 * OpenClaw 期望的文件系统 API 接口
 */
interface IOpenClawFileSystem {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer | string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  mkdir(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

/**
 * VSCode FileService → OpenClaw FileSystem 适配器
 */
export class VSCodeFileSystemAdapter implements IOpenClawFileSystem {
  constructor(
    @IFileService private readonly _fileService: IFileService,
  ) {}

  async readFile(path: string): Promise<Buffer> {
    try {
      const uri = URI.file(path);
      const content = await this._fileService.readFile(uri);
      return Buffer.from(content.value.buffer);
    } catch (error) {
      // 将 VSCode 错误转换为 Node.js 风格错误
      if (error.code === 'FILE_NOT_FOUND') {
        const enoent = new Error(`ENOENT: no such file or directory, open '${path}'`);
        (enoent as any).code = 'ENOENT';
        (enoent as any).path = path;
        throw enoent;
      }
      throw error;
    }
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    const uri = URI.file(path);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

    await this._fileService.writeFile(uri, buffer);
  }

  async readdir(path: string): Promise<string[]> {
    const uri = URI.file(path);
    const children = await this._fileService.resolve(uri, { resolveMetadata: false });

    return children.children?.map(child => child.name) || [];
  }

  async stat(path: string): Promise<FileStat> {
    const uri = URI.file(path);
    const stat = await this._fileService.stat(uri);

    return {
      isFile: () => stat.isFile,
      isDirectory: () => stat.isDirectory,
      size: stat.size,
      mtime: stat.mtime,
    };
  }

  async mkdir(path: string): Promise<void> {
    const uri = URI.file(path);
    await this._fileService.createFolder(uri);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const uri = URI.file(path);
    await this._fileService.del(uri, { recursive: options?.recursive || false });
  }
}

interface FileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtime: number;
}
```

#### 17.4.3 配置系统适配器示例

```typescript
// extensions/openclaw/src/adapter/configAdapter.ts

import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';

/**
 * OpenClaw 期望的配置 API 接口
 */
interface IOpenClawConfig {
  get<T>(key: string, defaultValue?: T): T;
  set<T>(key: string, value: T): Promise<void>;
  has(key: string): boolean;
  delete(key: string): Promise<void>;
  getAll(): Record<string, unknown>;
}

/**
 * VSCode ConfigurationService → OpenClaw Config 适配器
 */
export class VSCodeConfigAdapter implements IOpenClawConfig {
  private readonly _prefix = 'openclaw';

  constructor(
    @IConfigurationService private readonly _configService: IConfigurationService,
    @IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
  ) {}

  get<T>(key: string, defaultValue?: T): T {
    const fullKey = `${this._prefix}.${key}`;
    const value = this._configService.getValue<T>(fullKey);

    return value !== undefined ? value : defaultValue as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const fullKey = `${this._prefix}.${key}`;

    // 写入工作区配置（优先）或用户配置
    const target = this._workspaceService.getWorkspace()
      ? 1  // ConfigurationTarget.WORKSPACE
      : 2; // ConfigurationTarget.USER

    await this._configService.updateValue(fullKey, value, target);
  }

  has(key: string): boolean {
    const fullKey = `${this._prefix}.${key}`;
    const value = this._configService.getValue(fullKey);

    return value !== undefined;
  }

  async delete(key: string): Promise<void> {
    const fullKey = `${this._prefix}.${key}`;
    const target = this._workspaceService.getWorkspace()
      ? 1
      : 2;

    await this._configService.updateValue(fullKey, undefined, target);
  }

  getAll(): Record<string, unknown> {
    const config = this._configService.getValue(this._prefix);
    return config || {};
  }
}
```

### 17.5 引擎源码修改策略

#### 17.5.1 修改原则

| 原则 | 说明 | 示例 |
|------|------|------|
| **最小修改** | 只修改必要的部分，尽量保持引擎原生代码不变 | 仅修改导入语句和 API 调用 |
| **抽象接口** | 为引擎定义抽象接口，通过适配器实现 | `FileSystemAPI` 抽象接口 |
| **配置驱动** | 通过配置项控制引擎行为，而非硬编码 | `useVSCodeFileSystem: boolean` |
| **可降级** | 修改应支持降级到原生 Node.js 环境 | 同时支持 `IFileService` 和 `fs.promises` |

#### 17.5.2 修改示例：Gateway Server

```typescript
// extensions/openclaw/src/engine/gateway/server.ts

import { IOpenClawFileSystem } from '../utils/fileSystem';
import { IOpenClawConfig } from '../utils/config';

/**
 * 修改后的 Gateway Server，支持 VSCode 环境和 Node.js 环境
 */
export class GatewayServer {
  // 使用抽象接口，而非直接依赖 Node.js fs 模块
  private readonly _fileSystem: IOpenClawFileSystem;
  private readonly _config: IOpenClawConfig;

  constructor(
    fileSystem: IOpenClawFileSystem,  // 注入文件系统抽象
    config: IOpenClawConfig,          // 注入配置抽象
  ) {
    this._fileSystem = fileSystem;
    this._config = config;
  }

  async start(): Promise<void> {
    // 使用抽象接口读取配置文件
    const configPath = this._config.get<string>('gateway.configPath');
    let configContent: Buffer;

    try {
      // 使用抽象文件系统 API
      configContent = await this._fileSystem.readFile(configPath);
    } catch (error) {
      // 错误处理（支持 Node.js 风格错误）
      if ((error as any).code === 'ENOENT') {
        // 配置文件不存在，使用默认配置
        configContent = Buffer.from(this._getDefaultConfig());
      } else {
        throw error;
      }
    }

    const config = JSON.parse(configContent.toString());

    // 启动服务器...
  }

  private _getDefaultConfig(): string {
    return JSON.stringify({
      server: {
        port: 9876,
        host: '127.0.0.1',
      },
      models: [],
      tools: [],
    }, null, 2);
  }
}
```

### 17.6 构建与打包策略

#### 17.6.1 构建配置

```json
// extensions/openclaw/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020", "DOM"],
    "outDir": "../../dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": [
    "src/**/*"
  ],
  "exclude": [
    "node_modules",
    "dist"
  ]
}
```

#### 17.6.2 打包配置

```json
// extensions/openclaw/package.json
{
  "name": "openclaw-backend",
  "version": "1.2.0",
  "description": "OpenClaw engine integrated directly into VSCode extension",
  "main": "./dist/extension.js",
  "engines": {
    "vscode": "^1.85.0"
  },
  "dependencies": {
    // 🔥 注意：无 @openclaw/* 依赖！引擎源码已直接集成
    // 仅保留必要的 VSCode 相关依赖
    "typescript": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.85.0",
    "vsce": "^2.0.0",
    "typescript": "^5.0.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "watch": "tsc -p tsconfig.json -w",
    "package": "vsce package",
    "publish": "vsce publish"
  }
}
```

---

## 18. OpenClaw 功能兼容适配设计

### 18.1 兼容目标

**核心目标**：确保 OpenClaw 的原生功能在 VSCode 插件环境中完全兼容，包括：
1. **API 兼容**：OpenClaw API 在 VSCode 环境中行为一致
2. **配置兼容**：OpenClaw 配置文件在 VSCode 环境中可正常加载
3. **工具兼容**：OpenClaw 内置工具在 VSCode 环境中可正常运行
4. **技能兼容**：OpenClaw 技能在 VSCode 环境中可正常加载和执行

### 18.2 兼容层架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw 兼容层                                 │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  功能检测模块                                    │   │
│  │  ├── apiCompatibilityChecker.ts  # API 兼容性检查            │   │
│  │  ├── configCompatibilityChecker.ts # 配置兼容性检查          │   │
│  │  ├── toolCompatibilityChecker.ts  # 工具兼容性检查          │   │
│  │  └── skillCompatibilityChecker.ts # 技能兼容性检查          │   │
│  └───────────────────────┬─────────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  适配执行模块                                    │   │
│  │  ├── apiAdapter.ts             # API 适配执行              │   │
│  │  ├── configAdapter.ts          # 配置适配执行               │   │
│  │  ├── toolAdapter.ts            # 工具适配执行               │   │
│  │  └── skillAdapter.ts           # 技能适配执行               │   │
│  └───────────────────────┬─────────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  降级处理模块                                    │   │
│  │  ├── apiFallback.ts            # API 降级处理              │   │
│  │  ├── configFallback.ts         # 配置降级处理               │   │
│  │  ├── toolFallback.ts           # 工具降级处理               │   │
│  │  └── skillFallback.ts          # 技能降级处理               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 18.3 API 兼容适配

#### 18.3.1 文件系统 API 兼容

```typescript
// extensions/openclaw/src/compatibility/api/fileSystemCompat.ts

import { IOpenClawFileSystem } from '../../engine/utils/fileSystem';
import { VSCodeFileSystemAdapter } from '../../adapter/fileSystemAdapter';

/**
 * 文件系统 API 兼容性适配器
 * 确保 OpenClaw 文件系统 API 在 VSCode 环境中行为一致
 */
export class FileSystemCompatAdapter implements IOpenClawFileSystem {
  private readonly _vsCodeAdapter: VSCodeFileSystemAdapter;
  private readonly _fallbackAdapter: NodeFileSystemAdapter;
  private readonly _useFallback: boolean;

  constructor(
    vsCodeAdapter: VSCodeFileSystemAdapter,
    fallbackAdapter: NodeFileSystemAdapter,
    useFallback: boolean = false,
  ) {
    this._vsCodeAdapter = vsCodeAdapter;
    this._fallbackAdapter = fallbackAdapter;
    this._useFallback = useFallback;
  }

  async readFile(path: string): Promise<Buffer> {
    try {
      // 优先使用 VSCode API
      if (!this._useFallback) {
        return await this._vsCodeAdapter.readFile(path);
      } else {
        throw new Error('Fallback to Node.js API');
      }
    } catch (error) {
      // 降级到 Node.js API
      console.warn(`FileSystemCompat: Falling back to Node.js API for readFile('${path}')`, error);
      return await this._fallbackAdapter.readFile(path);
    }
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    try {
      if (!this._useFallback) {
        return await this._vsCodeAdapter.writeFile(path, content);
      } else {
        throw new Error('Fallback to Node.js API');
      }
    } catch (error) {
      console.warn(`FileSystemCompat: Falling back to Node.js API for writeFile('${path}')`, error);
      return await this._fallbackAdapter.writeFile(path, content);
    }
  }

  // ... 其他方法类似实现
}

/**
 * Node.js 文件系统适配器（降级方案）
 */
class NodeFileSystemAdapter implements IOpenClawFileSystem {
  async readFile(path: string): Promise<Buffer> {
    const fs = require('fs/promises');
    return await fs.readFile(path);
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    const fs = require('fs/promises');
    await fs.writeFile(path, content);
  }

  // ... 其他方法使用 Node.js fs 模块实现
}
```

### 18.4 配置兼容适配

#### 18.4.1 配置文件格式兼容

```typescript
// extensions/openclaw/src/compatibility/config/configFormatCompat.ts

import { IOpenClawConfig } from '../../engine/utils/config';

/**
 * 配置文件格式兼容性适配器
 * 支持 OpenClaw 原生配置文件格式
 */
export class ConfigFormatCompatAdapter {
  /**
   * 从 OpenClaw 原生配置文件格式转换为 VSCode 配置格式
   */
  convertFromOpenClawFormat(openclawConfig: any): Record<string, unknown> {
    const vsCodeConfig: Record<string, unknown> = {};

    // 转换 Gateway 配置
    if (openclawConfig.gateway) {
      vsCodeConfig['gateway.port'] = openclawConfig.gateway.port;
      vsCodeConfig['gateway.host'] = openclawConfig.gateway.host;
      vsCodeConfig['gateway.autoStart'] = openclawConfig.gateway.autoStart || false;
    }

    // 转换模型配置
    if (openclawConfig.models) {
      vsCodeConfig['model.provider'] = openclawConfig.models[0]?.provider || 'anthropic';
      vsCodeConfig['model.defaultModel'] = openclawConfig.models[0]?.model || 'claude-3-5-sonnet-20241022';
    }

    // 转换工具配置
    if (openclawConfig.tools) {
      vsCodeConfig['tools.enabled'] = openclawConfig.tools.map((t: any) => t.name);
    }

    return vsCodeConfig;
  }

  /**
   * 从 VSCode 配置格式转换为 OpenClaw 原生配置文件格式
   */
  convertToOpenClawFormat(vsCodeConfig: Record<string, unknown>): any {
    const openclawConfig: any = {
      gateway: {},
      models: [],
      tools: [],
    };

    // 转换 Gateway 配置
    openclawConfig.gateway.port = vsCodeConfig['gateway.port'] || 9876;
    openclawConfig.gateway.host = vsCodeConfig['gateway.host'] || '127.0.0.1';
    openclawConfig.gateway.autoStart = vsCodeConfig['gateway.autoStart'] || false;

    // 转换模型配置
    openclawConfig.models.push({
      provider: vsCodeConfig['model.provider'] || 'anthropic',
      model: vsCodeConfig['model.defaultModel'] || 'claude-3-5-sonnet-20241022',
    });

    // 转换工具配置
    const enabledTools = vsCodeConfig['tools.enabled'] || [];
    openclawConfig.tools = enabledTools.map((name: string) => ({ name }));

    return openclawConfig;
  }

  /**
   * 检测配置文件格式版本
   */
  detectFormatVersion(config: any): 'v1' | 'v2' | 'unknown' {
    if (config.version) {
      return config.version === '2.0' ? 'v2' : 'v1';
    }

    // 根据配置项推断版本
    if (config.gateway && config.models) {
      return 'v2';
    } else if (config.port && config.host) {
      return 'v1';
    }

    return 'unknown';
  }
}
```

### 18.5 工具兼容适配

#### 18.5.1 内置工具兼容

```typescript
// extensions/openclaw/src/compatibility/tools/builtinToolsCompat.ts

import { IOpenClawTool } from '../../engine/utils/tools';

/**
 * OpenClaw 内置工具兼容性适配器
 */
export class BuiltinToolsCompatAdapter {
  private readonly _tools = new Map<string, IOpenClawTool>();
  private readonly _vsCodeAdapter: any;

  constructor(vsCodeAdapter: any) {
    this._vsCodeAdapter = vsCodeAdapter;
    this._registerBuiltinTools();
  }

  private _registerBuiltinTools(): void {
    // 注册文件读取工具
    this._tools.set('read_file', {
      name: 'read_file',
      description: 'Read content from a file',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file',
          },
        },
        required: ['path'],
      },
      execute: async (args: any) => {
        return await this._vsCodeAdapter.fileSystem.readFile(args.path);
      },
    });

    // 注册文件写入工具
    this._tools.set('write_file', {
      name: 'write_file',
      description: 'Write content to a file',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file',
          },
          content: {
            type: 'string',
            description: 'Content to write',
          },
        },
        required: ['path', 'content'],
      },
      execute: async (args: any) => {
        await this._vsCodeAdapter.fileSystem.writeFile(args.path, args.content);
        return { success: true };
      },
    });

    // 注册 Shell 命令执行工具
    this._tools.set('execute_command', {
      name: 'execute_command',
      description: 'Execute a shell command',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Command to execute',
          },
        },
        required: ['command'],
      },
      execute: async (args: any) => {
        return await this._vsCodeAdapter.terminal.executeCommand(args.command);
      },
    });
  }

  getTool(name: string): IOpenClawTool | undefined {
    return this._tools.get(name);
  }

  getAllTools(): IOpenClawTool[] {
    return Array.from(this._tools.values());
  }
}
```

### 18.6 技能兼容适配

#### 18.6.1 技能加载器兼容

```typescript
// extensions/openclaw/src/compatibility/skills/skillLoaderCompat.ts

import { IOpenClawSkill } from '../../engine/utils/skills';

/**
 * OpenClaw 技能加载器兼容性适配器
 */
export class SkillLoaderCompatAdapter {
  private readonly _skills = new Map<string, IOpenClawSkill>();
  private readonly _vsCodeAdapter: any;

  constructor(vsCodeAdapter: any) {
    this._vsCodeAdapter = vsCodeAdapter;
  }

  /**
   * 从指定路径加载技能
   */
  async loadSkill(skillPath: string): Promise<IOpenClawSkill> {
    try {
      // 使用 VSCode 文件系统 API 读取技能文件
      const skillContent = await this._vsCodeAdapter.fileSystem.readFile(skillPath);

      // 解析技能定义
      const skill = this._parseSkill(skillContent.toString());

      // 注册技能
      this._skills.set(skill.name, skill);

      return skill;
    } catch (error) {
      // 降级到 Node.js 文件系统 API
      console.warn(`SkillLoaderCompat: Falling back to Node.js API for loadSkill('${skillPath}')`, error);

      const fs = require('fs/promises');
      const skillContent = await fs.readFile(skillPath, 'utf-8');

      const skill = this._parseSkill(skillContent);
      this._skills.set(skill.name, skill);

      return skill;
    }
  }

  /**
   * 加载指定目录下的所有技能
   */
  async loadAllSkills(skillsDirectory: string): Promise<IOpenClawSkill[]> {
    const skills: IOpenClawSkill[] = [];

    try {
      // 使用 VSCode 文件系统 API 读取目录
      const files = await this._vsCodeAdapter.fileSystem.readdir(skillsDirectory);

      for (const file of files) {
        if (file.endsWith('.skill.js') || file.endsWith('.skill.ts')) {
          const skillPath = `${skillsDirectory}/${file}`;
          const skill = await this.loadSkill(skillPath);
          skills.push(skill);
        }
      }
    } catch (error) {
      // 降级到 Node.js 文件系统 API
      console.warn(`SkillLoaderCompat: Falling back to Node.js API for loadAllSkills('${skillsDirectory}')`, error);

      const fs = require('fs/promises');
      const files = await fs.readdir(skillsDirectory);

      for (const file of files) {
        if (file.endsWith('.skill.js') || file.endsWith('.skill.ts')) {
          const skillPath = `${skillsDirectory}/${file}`;
          const skill = await this.loadSkill(skillPath);
          skills.push(skill);
        }
      }
    }

    return skills;
  }

  private _parseSkill(content: string): IOpenClawSkill {
    // 解析技能定义（简化示例）
    const skill = {
      name: '',
      description: '',
      parameters: {},
      execute: async (args: any) => {
        return { result: 'Skill executed successfully' };
      },
    };

    // 实际解析逻辑...

    return skill;
  }

  getSkill(name: string): IOpenClawSkill | undefined {
    return this._skills.get(name);
  }

  getAllSkills(): IOpenClawSkill[] {
    return Array.from(this._skills.values());
  }
}
```

### 18.7 版本管理策略

#### 18.7.1 版本号规则

```
插件版本号规则：
<major>.<minor>.<patch>-<engine-version>

示例：
1.2.0-engine-1.0.0  # 插件 v1.2.0，包含 OpenClaw 引擎 v1.0.0
1.3.0-engine-1.2.0  # 插件 v1.3.0，包含 OpenClaw 引擎 v1.2.0
```

#### 18.7.2 版本同步机制

```typescript
// extensions/openclaw/src/utils/versionManager.ts

export interface EngineVersionInfo {
  engineVersion: string;      // OpenClaw 引擎版本
  pluginVersion: string;       // 插件版本
  schemaVersion: string;       // 配置 schema 版本
  compatibility: string[];     // 兼容的 VSCode 版本
}

export class VersionManager {
  private readonly _engineVersion: string;
  private readonly _pluginVersion: string;

  constructor() {
    // 从 package.json 读取版本号
    const packageJson = require('../../package.json');
    this._pluginVersion = packageJson.version;

    // 解析引擎版本号
    const match = this._pluginVersion.match(/-engine-(\d+\.\d+\.\d+)/);
    if (match) {
      this._engineVersion = match[1];
    } else {
      // 默认版本
      this._engineVersion = '1.0.0';
    }
  }

  getEngineVersion(): string {
    return this._engineVersion;
  }

  getPluginVersion(): string {
    return this._pluginVersion;
  }

  getVersionInfo(): EngineVersionInfo {
    return {
      engineVersion: this._engineVersion,
      pluginVersion: this._pluginVersion,
      schemaVersion: '1.0.0',
      compatibility: ['1.85.0', '1.90.0'],
    };
  }

  // 检查 VSCode 版本兼容性
  checkCompatibility(vscodeVersion: string): boolean {
    const [major, minor] = vscodeVersion.split('.').map(Number);

    for (const compatVersion of this.getVersionInfo().compatibility) {
      const [compatMajor, compatMinor] = compatVersion.split('.').map(Number);

      if (major === compatMajor && minor >= compatMinor) {
        return true;
      }
    }

    return false;
  }
}
```

### 18.8 测试策略

#### 18.8.1 单元测试

```typescript
// extensions/openclaw/src/engine/gateway/__tests__/server.test.ts

import { GatewayServer } from '../server';
import { MockFileSystem } from './mockFileSystem';
import { MockConfig } from './mockConfig';

describe('GatewayServer', () => {
  let server: GatewayServer;
  let mockFileSystem: MockFileSystem;
  let mockConfig: MockConfig;

  beforeEach(() => {
    mockFileSystem = new MockFileSystem();
    mockConfig = new MockConfig();
    server = new GatewayServer(mockFileSystem, mockConfig);
  });

  test('should start server with default config if config file not found', async () => {
    // 模拟文件不存在
    mockFileSystem.setReadFileError('config.json', 'ENOENT');

    // 启动服务器
    await server.start();

    // 验证使用了默认配置
    const config = server.getConfig();
    expect(config.server.port).toBe(9876);
    expect(config.server.host).toBe('127.0.0.1');
  });

  test('should start server with custom config if config file exists', async () => {
    // 模拟配置文件存在
    const customConfig = {
      server: {
        port: 9999,
        host: '0.0.0.0',
      },
    };
    mockFileSystem.setReadFileContent('config.json', JSON.stringify(customConfig));

    // 启动服务器
    await server.start();

    // 验证使用了自定义配置
    const config = server.getConfig();
    expect(config.server.port).toBe(9999);
    expect(config.server.host).toBe('0.0.0.0');
  });
});
```

---

## 19. 总结

本文档详细设计了 Saros Agent Studio 与 OpenClaw 的集成架构，采用插件化设计，支持灵活扩展和独立更新。

**核心成果**：
1. ✅ **插件化架构**：OpenClaw 功能封装为独立插件，支持独立更新
2. ✅ **引擎源码集成**：将 OpenClaw 引擎源码直接集成到插件中，完全自给自足
3. ✅ **适配层设计**：设计完整的适配层，使 OpenClaw 引擎可在 VSCode 环境中运行
4. ✅ **功能兼容适配**：确保 OpenClaw 的原生功能在 VSCode 环境中完全兼容
5. ✅ **Memory 机制接入**：设计 `IMemoryProvider` 接口，支持多层次记忆系统
6. ✅ **Agent 机制接入**：设计 `IAgentRuntime` 接口，支持完整的 Agent 运行时
7. ✅ **升级机制**：设计 Memory 和 Agent 的升级机制，支持版本迁移和回滚
8. ✅ **与 Gateway 集成**：定义清晰的 API 端点，实现 VSCode 与 OpenClaw 的无缝对接
9. ✅ **配置管理**：提供灵活的配置项，支持用户自定义

**后续工作**：
1. 实现引擎源码集成，将 OpenClaw 核心模块直接集成到插件中
2. 实现适配层，包括文件系统、配置系统、终端等适配器
3. 实现功能兼容适配层，确保 OpenClaw 原生功能完全兼容
4. 实现 `IMemoryProvider` 和 `IAgentRuntime` 接口
5. 实现 `IMemoryUpgradeService` 和 `IAgentUpgradeService` 接口
6. 开发 OpenClaw Memory 和 Agent 插件
7. 开发 Memory 和 Agent 升级功能
8. 完善 Gateway API 端点
9. 编写单元测试和集成测试
10. 更新用户文档和开发者文档

---

## 20. 版本历史

| 版本 | 日期 | 作者 | 变更说明 |
|------|------|------|----------|
| v1.0 | 2025-05-08 | AI Assistant | 初始版本，设计 OpenClaw 插件架构、Memory 机制、Agent 机制 |
| v1.1 | 2025-05-08 | AI Assistant | 新增 Memory 升级机制和 Agent 升级机制设计 |
| v1.2 | 2025-05-08 | AI Assistant | 新增 OpenClaw 引擎源码集成设计和功能兼容适配设计 |

---

*文档结束。本方案聚焦于最小改动、最大复用，利用已有的 Agent Studio 架构接入 OpenClaw Gateway 能力，通过 MCP Gateway 实现远程智能体对本地工具的安全调用，并通过中心化 Gateway Hub 支持多客户端统一接入。*
