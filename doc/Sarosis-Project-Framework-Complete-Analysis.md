# Sarosis Agents Client - 项目框架完整分析

> **文档版本**: v1.0  
> **生成时间**: 2026-05-26  
> **项目版本**: code-oss-dev 1.120.0  
> **分析范围**: 完整项目架构、技术栈、核心模块、扩展系统

---

## 📋 目录

1. [项目概述](#1-项目概述)
2. [技术栈总结](#2-技术栈总结)
3. [目录结构分析](#3-目录结构分析)
4. [四层架构设计](#4-四层架构设计)
5. [核心模块详解](#5-核心模块详解)
6. [扩展系统分析](#6-扩展系统分析)
7. [Sarosis 创新特性](#7-sarosis-创新特性)
8. [开发工作流](#8-开发工作流)
9. [部署与构建](#9-部署与构建)
10. [总结与展望](#10-总结与展望)

---

## 1. 项目概述

### 1.1 项目定位

**Sarosis Agents Client** 是一个基于 VS Code 开源版本深度定制的企业级 AI Agent 开发平台，专为大模型应用开发和智能体编排而设计。

**核心特性**：
- 🏗️ **四层架构**：在 VS Code 三层架构基础上新增 Sessions 层
- 🤖 **AI 原生**：深度集成 AI 能力，支持多种大模型
- 🔌 **扩展丰富**：60+ 内置扩展，覆盖 AI 开发全流程
- 🛠️ **开发友好**：完整的调试、测试、部署工具链

### 1.2 项目身份

```json
{
  "name": "code-oss-dev",
  "version": "1.120.0",
  "publisher": "sarosis-agents",
  "engines": {
    "vscode": "^1.120.0"
  }
}
```

### 1.3 与 VS Code 的关系

| 维度 | VS Code OSS | Sarosis Agents Client |
|------|-------------|----------------------|
| **架构** | 三层架构 | 四层架构（+ Sessions） |
| **定位** | 通用代码编辑器 | AI Agent 开发平台 |
| **AI 能力** | 基础（Copilot） | 深度集成（多模型、多 Agent） |
| **扩展** | 通用扩展 | AI 专用扩展 + 通用扩展 |
| **目标用户** | 开发者 | AI 应用开发者、Agent 开发者 |

---

## 2. 技术栈总结

### 2.1 核心技术

| 技术 | 版本 | 用途 |
|------|------|------|
| **TypeScript** | 5.8.3 | 主要开发语言 |
| **Node.js** | 20.x+ | 运行时环境 |
| **Electron** | 36.0.0 | 桌面应用框架 |
| **Vite** | 6.2.4 | 前端构建工具 |
| **ESBuild** | 0.25.1 | 后端编译工具 |
| **Rollup** | 4.41.1 | 扩展打包工具 |
| **Playwright** | 1.53.0 | 测试自动化 |

### 2.2 关键依赖

#### 2.2.1 AI 相关
- **@anthropic-ai/sdk**: Anthropic API
- **@huggingface/transformers**: HuggingFace 模型
- **openai**: OpenAI API
- **@ellywastaken/node-pyright**: Python 类型检查

#### 2.2.2 数据处理
- **@loaders.gl/core**: 3D 数据加载
- **@loaders.gl/images**: 图像处理
- **@loaders.gl/tiles**: 瓦片数据
- **puppeteer-core**: 浏览器自动化

#### 2.2.3 开发工具
- **eslint**: 9.24.0（代码检查）
- **prettier**: 3.5.3（代码格式化）
- **mocha**: 11.1.0（测试框架）
- **sinon**: 18.0.1（Mock 工具）

### 2.3 构建系统

**混合构建策略**：
```
前端（Webview）: Vite + TypeScript
后端（Node.js）: ESBuild + TypeScript
扩展（Extensions）: Rollup + TypeScript
桌面（Electron）: Webpack + Electron
```

---

## 3. 目录结构分析

### 3.1 根目录结构

```
sarosis-agents-client/
├── .agents/                    # Agent 配置
├── .codebuddy/                 # CodeBuddy 配置
├── .config/                    # 项目配置
├── .devcontainer/              # 开发容器配置
├── .eslint-plugin-local/       # 本地 ESLint 插件
├── .github/                    # GitHub 配置
├── cli/                        # CLI 工具
├── doc/                        # 项目文档
├── extensions/                 # 扩展目录（60+）
├── resources/                  # 资源文件
├── scripts/                    # 构建脚本
├── src/                        # 源代码
│   ├── cli/                    # CLI 实现
│   ├── ts/                     # TypeScript 语言服务
│   ├── typings/                # 类型定义
│   └── vs/                     # VS Code 核心
│       ├── base/               # 基础工具层
│       ├── code/               # Electron 主进程
│       ├── editor/             # 编辑器层
│       ├── platform/           # 平台服务层（80+ 服务）
│       └── workbench/          # 工作台层
├── test/                       # 测试套件
├── out/                        # 构建输出
└── package.json                # 项目配置
```

### 3.2 核心源码结构

#### 3.2.1 `src/vs/platform/` - 平台服务层

**VS Code 原生服务**（60+）：
```
platform/
├── actions/                    # 命令系统
├── clipboard/                  # 剪贴板
├── configuration/               # 配置管理
├── contextkey/                 # 上下文键
├── extensions/                  # 扩展系统
├── files/                      # 文件服务
├── jsonschemas/                # JSON Schema
├── keybinding/                 # 快捷键
├── log/                        # 日志
├── markers/                    # 标记系统
├── quickinput/                 # 快速输入
├── terminal/                   # 终端
├── theme/                      # 主题
├── workspace/                  # 工作区
└── ...                         # 其他 50+ 服务
```

**Sarosis 新增服务**（20+）：
```
platform/
├── agentHost/                  # Agent 宿主服务
├── aiRouter/                   # AI 路由服务
├── chat/                       # 聊天服务
├── contextManagement/          # 上下文管理
├── diff/                       # 差异对比
├── documents/                  # 文档服务
├── editorEnhanced/             # 增强编辑器
├── extensionsNode/             # 扩展 Node 端
├── fileSystemProvider/         # 文件系统提供者
├── fileTransform/              # 文件转换
├── images/                     # 图像服务
├── lsp/                      # LSP 服务
├── memory/                     # 内存管理
├── nativeMcpClient/            # 原生 MCP 客户端
├── notebooks/                  # Notebook 服务
├── panels/                     # 面板服务
├── profiler/                   # 性能分析
├── prompt/                     # 提示词管理
├── sessions/                   # 会话服务 ⭐
├── skillLibrary/                # 技能库
├── terminalContrib/             # 终端贡献
├── tools/                      # 工具服务
└── views/                      # 视图服务
```

#### 3.2.2 `src/vs/workbench/` - 工作台层

**关键目录**：
```
workbench/
├── browser/                    # 浏览器端
│   ├── web.api.ts             # Web API
│   └── workbench.ts           # 工作台主文件
├── contrib/                    # 功能贡献
│   ├── chat/                  # 聊天系统 ⭐
│   ├── agents/                 # Agent 系统 ⭐
│   ├── aiDevAgent/             # AI 开发 Agent ⭐
│   ├── codex/                  # Codex 集成 ⭐
│   ├── commandCenter/          # 命令中心
│   ├── debug/                  # 调试
│   ├── terminal/               # 终端
│   ├── notebook/               # Notebook
│   └── ...                     # 其他贡献
├── services/                   # 工作台服务
└── test/                       # 测试
```

---

## 4. 四层架构设计

### 4.1 架构对比

#### VS Code 三层架构
```
┌─────────────────────────────────────┐
│  工作台层 (Workbench)                │  ← 用户界面、编辑器、面板
├─────────────────────────────────────┤
│  编辑器层 (Editor)                   │  ← Monaco Editor、Diff Editor
├─────────────────────────────────────┤
│  平台服务层 (Platform)               │  ← 文件、配置、扩展、终端
└─────────────────────────────────────┘
```

#### Sarosis 四层架构
```
┌─────────────────────────────────────┐
│  Sessions 层 (会话层) ⭐新增          │  ← Agent 会话、上下文管理
├─────────────────────────────────────┤
│  工作台层 (Workbench)                │  ← 聊天界面、Agent 面板
├─────────────────────────────────────┤
│  编辑器层 (Editor)                   │  ← 代码编辑、Notebook
├─────────────────────────────────────┤
│  平台服务层 (Platform)               │  ← AI 服务、扩展服务
└─────────────────────────────────────┘
```

### 4.2 Sessions 层详解

**核心职责**：
1. **会话管理**：管理 Agent 对话会话的生命周期
2. **上下文管理**：维护对话上下文和记忆
3. **状态持久化**：保存会话状态到磁盘
4. **多会话支持**：支持多个并发会话

**关键文件**：
```
platform/sessions/
├── common/
│   ├── session.ts              # 会话模型
│   └── sessionStorage.ts       # 存储接口
├── electron-main/
│   └── sessionManager.ts       # 主进程管理
├── node/
│   └── sessionStorage.ts       # Node 端存储实现
└── test/
    └── session.test.ts         # 单元测试
```

**会话生命周期**：
```
创建 → 初始化 → 激活 → 对话 → 暂停 → 恢复 → 销毁
  ↓        ↓        ↓      ↓      ↓      ↓      ↓
存储     加载     状态   消息   状态   状态   清理
```

### 4.3 层间通信

**通信机制**：
```typescript
// 1. 依赖注入（DI）
class ChatService {
  constructor(
    @ISessionService private sessionService: ISessionService,
    @IAiRouterService private aiRouter: IAiRouterService
  ) {}
}

// 2. 事件系统
this.eventEmitter.emit('session.created', session);

// 3. RPC 调用
await this.proxy.$createSession(config);
```

**数据流**：
```
用户输入
  ↓
工作台层（Chat UI）
  ↓
Sessions 层（会话管理）
  ↓
Platform 层（AI 路由、文件服务等）
  ↓
外部服务（AI 模型、MCP 服务器等）
```

---

## 5. 核心模块详解

### 5.1 Agent Host 模块

**位置**：`src/vs/platform/agentHost/`

**功能**：
- Agent 生命周期管理
- Agent 配置管理
- Agent 间通信
- Agent 权限控制

**关键接口**：
```typescript
interface IAgentHost {
  // 创建 Agent
  createAgent(config: AgentConfig): Promise<Agent>;
  
  // 启动 Agent
  startAgent(agentId: string): Promise<void>;
  
  // 停止 Agent
  stopAgent(agentId: string): Promise<void>;
  
  // 发送消息
  sendMessage(agentId: string, message: string): Promise<Response>;
}
```

### 5.2 AI Router 模块

**位置**：`src/vs/platform/aiRouter/`

**功能**：
- 多模型支持（OpenAI、Anthropic、Gemini 等）
- 模型路由和负载均衡
- 请求重试和熔断
- Token 计数和成本管理

**路由策略**：
```typescript
// 按模型能力路由
if (task.type === 'code') {
  routeTo('anthropic-claude-3-opus');
} else if (task.type === 'chat') {
  routeTo('openai-gpt-4');
} else {
  routeTo('default');
}
```

### 5.3 Chat 模块

**位置**：`src/vs/workbench/contrib/chat/`

**功能**：
- 聊天界面渲染
- 消息列表管理
- 流式响应显示
- 代码块渲染（Markdown、代码高亮）

**UI 结构**：
```
ChatPanel
├── ChatHeader                   # 头部（标题、操作）
├── ChatMessageList              # 消息列表
│   ├── ChatMessage (User)       # 用户消息
│   ├── ChatMessage (Assistant)  # Assistant 消息
│   └── ChatMessage (System)    # 系统消息
├── ChatInput                    # 输入框
└── ChatFooter                   # 底部（模型选择、设置）
```

### 5.4 Context Management 模块

**位置**：`src/vs/platform/contextManagement/`

**功能**：
- 上下文收集（文件、选择、剪贴板等）
- 上下文压缩和摘要
- 上下文窗口管理
- 长期记忆管理

**上下文类型**：
```typescript
type Context = {
  // 文件上下文
  files: Array<{ path: string; content: string }>;
  
  // 代码选择
  selection: { file: string; start: number; end: number };
  
  // 工作区上下文
  workspace: { root: string; files: string[] };
  
  // 对话历史
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
};
```

### 5.5 Skill Library 模块

**位置**：`src/vs/platform/skillLibrary/`

**功能**：
- 技能定义和管理
- 技能市场
- 技能执行引擎
- 技能权限控制

**技能结构**：
```typescript
interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  inputs: Schema;
  outputs: Schema;
  execute: (inputs: any) => Promise<any>;
}
```

---

## 6. 扩展系统分析

### 6.1 扩展目录结构

```
extensions/
├── [核心语言支持]
│   ├── typescript/              # TypeScript
│   ├── python/                  # Python
│   ├── java/                    # Java
│   ├── cpp/                     # C/C++
│   ├── csharp/                  # C#
│   ├── go/                      # Go
│   ├── rust/                    # Rust
│   └── ...
│
├── [Web 技术]
│   ├── html/                    # HTML
│   ├── css/                     # CSS
│   ├── javascript/              # JavaScript
│   ├── json/                    # JSON
│   ├── markdown/                # Markdown
│   └── ...
│
├── [框架和库]
│   ├── react/                   # React
│   ├── vue/                     # Vue
│   ├── angular/                 # Angular
│   ├── nestjs/                  # NestJS
│   └── ...
│
├── [Sarosis 专有]
│   ├── agent-studio/            # Agent 工作室 ⭐
│   ├── hermes-agent/            # Hermes Agent ⭐
│   ├── knot-agui/               # Knot GUI ⭐
│   ├── mcp-builder/             # MCP 构建器 ⭐
│   ├── sarosis-agent/           # Sarosis Agent ⭐
│   ├── skill-creator/           # 技能创建器 ⭐
│   └── ...
│
└── [工具类]
    ├── git/                     # Git
    ├── docker/                  # Docker
    ├── npm/                     # NPM
    ├── debug/                   # 调试
    └── ...
```

### 6.2 重点扩展分析

#### 6.2.1 Agent Studio

**功能**：可视化的 Agent 开发环境

**特性**：
- 拖拽式 Agent 编排
- 可视化工作流设计
- 实时调试和测试
- 性能监控

**技术栈**：
- React + Redux（前端）
- WebSocket（实时通信）
- Node.js（后端）

#### 6.2.2 Hermes Agent

**功能**：强大的 AI Agent 框架

**特性**：
- 多模型支持
- 工具调用（Tool Calling）
- 记忆管理
- 多 Agent 协作

**架构**：
```
HermesAgent
├── Planner                    # 规划器
├── Executor                   # 执行器
├── Memory                     # 记忆
├── Tools                      # 工具
└── Reflector                  # 反思器
```

#### 6.2.3 Knot AGUI

**功能**：Knot 平台的 GUI 集成

**特性**：
- Knot 智能体管理
- 对话界面
- 配置管理
- 监控面板

### 6.3 扩展开发

**扩展结构**：
```typescript
// extensions/my-extension/
├── package.json                # 扩展配置
├── src/
│   ├── extension.ts           # 扩展入口
│   ├── myFeature.ts           # 功能实现
│   └── test/
│       └── extension.test.ts  # 测试
├── out/                        # 编译输出
└── README.md                   # 说明文档
```

**扩展入口**：
```typescript
// src/extension.ts
export function activate(context: ExtensionContext) {
  // 注册命令
  const disposable = vscode.commands.registerCommand(
    'myExtension.hello',
    () => {
      vscode.window.showInformationMessage('Hello World!');
    }
  );
  
  context.subscriptions.push(disposable);
}

export function deactivate() {}
```

---

## 7. Sarosis 创新特性

### 7.1 AI 原生架构

#### 7.1.1 深度集成

**与传统 IDE 的区别**：
```
传统 IDE:
  代码编辑器 + 插件式 AI 功能

Sarosis:
  AI 驱动的智能开发环境
  ↓
  - AI 能力贯穿所有层级
  - 原生支持多模型
  - 智能体作为一等公民
  - 上下文感知的智能服务
```

#### 7.1.2 智能体系统

**多智能体协作**：
```typescript
// 创建智能体团队
const team = new AgentTeam({
  planner: 'hermes-agent',
  coder: 'sarosis-agent',
  tester: 'test-agent',
  reviewer: 'review-agent'
});

// 执行任务
await team.execute('实现一个 Todo App');
```

### 7.2 MCP 集成

**MCP（Model Context Protocol）**：
- 标准化的 AI 工具协议
- 支持自定义工具
- 工具市场

**MCP 客户端**：
```typescript
// 调用 MCP 工具
await this.mcpClient.callTool({
  server: 'filesystem',
  tool: 'read_file',
  args: { path: '/path/to/file' }
});
```

### 7.3 会话管理

**持久化会话**：
- 会话状态自动保存
- 跨重启恢复
- 多会话并发

**会话存储**：
```json
{
  "sessionId": "sess-001",
  "name": "Code Review Session",
  "createdAt": "2026-05-26T10:00:00Z",
  "messages": [...],
  "context": {...},
  "metadata": {...}
}
```

### 7.4 技能系统

**技能市场**：
- 社区贡献的技能库
- 一键安装技能
- 技能依赖管理

**技能执行**：
```typescript
// 加载技能
const skill = await skillLibrary.load('code-review');

// 执行技能
const result = await skill.execute({
  code: sourceCode,
  language: 'typescript'
});
```

---

## 8. 开发工作流

### 8.1 环境搭建

#### 8.1.1 系统要求

**操作系统**：
- Windows 10/11
- macOS 12+
- Linux (Ubuntu 20.04+)

**依赖**：
- Node.js 20.x+
- PNPM 10.10.0
- Python 3.9+（可选）
- Git

#### 8.1.2 安装步骤

```bash
# 1. 克隆仓库
git clone https://git.woa.com/your-team/sarosis-agents-client.git
cd sarosis-agents-client

# 2. 安装依赖
pnpm install

# 3. 编译
pnpm compile

# 4. 运行
pnpm watch        # 开发模式（自动重载）
pnpm run          # 运行桌面版
```

### 8.2 开发流程

#### 8.2.1 后端开发（Platform/Node）

```bash
# 1. 启动监听
cd g:\CustomWorkspaces\AIProjects\sarosis-agents-client
pnpm watch

# 2. 修改文件
# src/vs/platform/xxx/

# 3. 自动编译
# ESBuild 会自动编译修改的文件

# 4. 调试
# 在 VS Code 中按 F5 启动调试
```

#### 8.2.2 前端开发（Webview）

```bash
# 1. 启动 Vite 开发服务器
cd g:\CustomWorkspaces\AIProjects\sarosis-agents-client\src\vs\workbench\contrib\chat\browser
pnpm dev

# 2. 修改文件
# 会自动热更新

# 3. 构建
pnpm build
```

#### 8.2.3 扩展开发

```bash
# 1. 创建扩展
yo code

# 2. 开发
cd extensions/my-extension
pnpm compile

# 3. 调试
# 在扩展目录按 F5

# 4. 打包
pnpm package
```

### 8.3 测试

#### 8.3.1 单元测试

```bash
# 运行所有测试
pnpm test

# 运行特定测试
pnpm test -- --grep "AgentHost"

# 覆盖率
pnpm test -- --coverage
```

#### 8.3.2 集成测试

```bash
# 启动集成测试
pnpm test-integration

# 调试集成测试
pnpm test-integration -- --inspect
```

#### 8.3.3 E2E 测试

```bash
# 运行 E2E 测试
pnpm test-e2e

# 使用 Playwright
npx playwright test
```

### 8.4 代码质量

#### 8.4.1 ESLint

```bash
# 检查
pnpm lint

# 自动修复
pnpm lint -- --fix
```

#### 8.4.2 Prettier

```bash
# 格式化
pnpm format

# 检查
pnpm format -- --check
```

#### 8.4.3 类型检查

```bash
# TypeScript 类型检查
pnpm ts-check
```

---

## 9. 部署与构建

### 9.1 构建配置

#### 9.1.1 构建脚本

```json
{
  "scripts": {
    "compile": "node scripts/compile.js",
    "watch": "node scripts/watch.js",
    "build": "node scripts/build.js",
    "package": "node scripts/package.js",
    "release": "node scripts/release.js"
  }
}
```

#### 9.1.2 构建产物

```
out/
├── main/                       # Electron 主进程
├── renderer/                   # 渲染进程
├── preload/                    # 预加载脚本
├── extensions/                 # 扩展
└── resources/                  # 资源文件
```

### 9.2 打包

#### 9.2.1 Electron 打包

```bash
# Windows
pnpm package:win

# macOS
pnpm package:mac

# Linux
pnpm package:linux
```

#### 9.2.2 Web 版本

```bash
# 构建 Web 版本
pnpm build:web

# 部署到服务器
pnpm deploy:web
```

### 9.3 CI/CD

#### 9.3.1 GitHub Actions

```yaml
# .github/workflows/build.yml
name: Build
on: [push, pull_request]

jobs:
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
    
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 20
      
      - run: pnpm install
      - run: pnpm compile
      - run: pnpm test
      - run: pnpm package
```

#### 9.3.2 自动化发布

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: pnpm install
      - run: pnpm compile
      - run: pnpm test
      - run: pnpm package
      - uses: softprops/action-gh-release@v1
        with:
          files: out/package/*
```

---

## 10. 总结与展望

### 10.1 项目优势

#### 10.1.1 技术优势

✅ **先进的架构**：
- 四层架构，层次清晰
- 依赖注入，解耦良好
- 模块化设计，易于扩展

✅ **丰富的功能**：
- 60+ 内置扩展
- 完整的 AI 工具链
- 强大的调试和测试支持

✅ **优秀的开发体验**：
- TypeScript 类型安全
- 热重载和快速编译
- 完整的文档和示例

#### 10.1.2 创新优势

✅ **AI 原生**：
- 深度集成 AI 能力
- 智能体作为一等公民
- 上下文感知的智能服务

✅ **开放生态**：
- 兼容 VS Code 扩展
- 支持自定义技能
- 活跃的社区

### 10.2 挑战和不足

#### 10.2.1 技术挑战

⚠️ **性能优化**：
- 大型项目的启动速度
- 内存占用优化
- 渲染性能优化

⚠️ **兼容性**：
- VS Code 扩展兼容性
- 多平台适配
- 依赖版本管理

#### 10.2.2 生态挑战

⚠️ **文档完善**：
- API 文档不够详细
- 示例不够丰富
- 最佳实践待总结

⚠️ **社区建设**：
- 用户基数较小
- 第三方扩展较少
- 生态系统待完善

### 10.3 未来展望

#### 10.3.1 短期目标（3-6 个月）

📋 **功能完善**：
- 完善 Agent Studio 可视化编排
- 增强调试和监控工具
- 优化性能和用户体验

📋 **生态建设**：
- 发布更多示例和教程
- 完善 API 文档
- 建立社区论坛

#### 10.3.2 中期目标（6-12 个月）

📋 **平台扩展**：
- 支持更多 AI 模型
- 集成更多外部工具
- 支持协作开发

📋 **生态繁荣**：
- 吸引更多开发者
- 丰富扩展市场
- 建立认证体系

#### 10.3.3 长期目标（1-2 年）

📋 **行业领先**：
- 成为 AI 开发的首选平台
- 建立行业标准
- 推动 AI 开发工具的发展

📋 **生态完善**：
- 完整的工具链
- 丰富的扩展生态
- 活跃的开源社区

---

## 附录

### A. 参考文献

1. [VS Code Architecture](https://code.visualstudio.com/api/advanced-topics/architecture)
2. [Electron Documentation](https://www.electronjs.org/docs)
3. [TypeScript Handbook](https://www.typescriptlang.org/docs/)
4. [Model Context Protocol](https://modelcontextprotocol.io/)

### B. 相关文档

- [Project-Framework-Analysis.md](./Project-Framework-Analysis.md)
- [Four-Layer-Architecture-Framework.md](./Four-Layer-Architecture-Framework.md)
- [Sessions-Layer-Analysis.md](./Sessions-Layer-Analysis.md)
- [Extensions-Directory-Analysis.md](./Extensions-Directory-Analysis.md)

### C. 更新日志

| 版本 | 日期 | 作者 | 变更内容 |
|------|------|------|----------|
| v1.0 | 2026-05-26 | AI Agent | 初始版本 |

---

**文档结束**

> 本文档提供了 Sarosis Agents Client 项目的完整框架分析，包括技术栈、架构设计、核心模块、扩展系统、开发工作流等内容。希望对理解和使用本项目有所帮助。
