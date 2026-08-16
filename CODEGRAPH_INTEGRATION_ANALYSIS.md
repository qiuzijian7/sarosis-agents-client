# CodeGraph 集成分析报告

## 1. CodeGraph 项目分析

### 1.1 项目概述

**CodeGraph** 是一个为 AI 编程助手提供语义代码智能的工具。它通过以下方式工作：

1. **代码解析**: 使用 tree-sitter 解析源代码，生成 AST
2. **知识图谱**: 将符号（函数、类、方法）和边（调用、导入、继承）存储在 SQLite 数据库中
3. **MCP 服务器**: 通过 Model Context Protocol 向 AI Agent 暴露知识图谱查询工具
4. **本地运行**: 所有数据存储在本地 `.codegraph/codegraph.db`，不离开本地机器

### 1.2 核心功能

| 功能 | 描述 |
|------|------|
| **智能上下文构建** | 一次工具调用返回入口点、相关符号和代码片段 |
| **全文搜索** | 跨整个代码库按名称即时查找代码（FTS5） |
| **影响分析** | 追踪调用者、被调用者，以及修改任何符号的完整影响范围 |
| **自动同步** | 文件监听器使用原生 OS 事件，自动同步图谱 |
| **20+ 语言支持** | TypeScript, Python, Go, Rust, Java, C#, C/C++, Swift 等 |
| **框架感知路由** | 识别 Web 框架路由文件，链接 URL 到处理器 |

### 1.3 架构分层

```
文件 → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
          ↓
   ReferenceResolver (导入、名称匹配、框架模式)
          ↓
   GraphQueryManager / GraphTraverser (调用者、被调用者、影响范围)
          ↓
   ContextBuilder (为 AI 生成 markdown/JSON)
```

### 1.4 公共 API

CodeGraph 可以作为 **库** 使用，也可以作为 **MCP 服务器** 运行。

**库 API** (`CodeGraph` 类，位于 `src/index.ts`):
- `CodeGraph.init(projectPath)` / `CodeGraph.open(projectPath)` - 初始化/打开项目
- `codeGraph.indexAll(options)` - 完整索引
- `codeGraph.searchNodes(query)` - 搜索符号
- `codeGraph.getCallers(nodeId)` / `codeGraph.getCallees(nodeId)` - 获取调用关系
- `codeGraph.getImpactRadius(nodeId, depth)` - 影响范围分析
- `codeGraph.buildContext(taskDescription, options)` - 构建 AI 上下文
- `codeGraph.watch()` / `codeGraph.unwatch()` - 文件监听

**MCP 工具** (通过 `codegraph serve --mcp` 暴露):
- `codegraph_search` - 按名称查找符号
- `codegraph_context` - 为任务构建相关代码上下文
- `codegraph_trace` - 追踪两个符号之间的调用路径
- `codegraph_callers` - 查找调用某个函数的代码
- `codegraph_callees` - 查找某个函数调用的代码
- `codegraph_impact` - 分析修改符号的影响
- `codegraph_node` - 获取符号详情
- `codegraph_explore` - 返回多个相关符号的源码
- `codegraph_files` - 获取索引的文件结构
- `codegraph_status` - 检查索引健康状况

---

## 2. 当前项目架构分析

### 2.1 项目概述

当前项目 (`sarosis-agents-client`) 是 **VS Code OSS** 的一个分支，添加了 **Agent Studio** 功能。Agent Studio 允许管理多个 AI Agent（称为 "Employee"），每个 Agent 可以：

- 使用不同的 LLM 模型
- 拥有不同的工具集
- 通过 "HandOff" 机制相互协作
- 在 "Workspace" 中组织

### 2.2 核心架构

```
┌──────────────────────────────────────────────────────────────────┐
│                      Agent Studio UI                        │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Driver Layer                            │
│  (agentChatService, agentDriverService, ...)                │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                      OS Layer                               │
│  (AgentOSService + SlotRegistry)                           │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┐ │
│  │ Model    │ Memory   │ Tool     │Planning  │Execution│ │
│  │Provider  │Provider  │Provider  │Provider  │Provider │ │
│  └──────────┴──────────┴──────────┴──────────┴──────────┘ │
│  ┌──────────┬──────────┐                               │
│  │Retrieval  │ Kanban   │                               │
│  │Provider   │ Provider │                               │
│  └──────────┴──────────┘                               │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Provider Plugins                          │
│  - BuiltinToolProvider (22 内置工具)                      │
│  - McpToolProvider (MCP 服务器工具桥接)                   │
│  - ...                                                   │
└───────────────────────────────────────────────────────────────┘
```

### 2.3 工具系统

**IToolProvider 接口** (定义于 `common/providers.ts`):

```typescript
export interface IToolProvider {
  readonly id: string;
  readonly name: string;
  
  listTools(agentId: string): Promise<IToolDefinition[]>;
  executeTool(agentId: string, toolCall: IToolCall, signal?: AbortSignal): Promise<IToolResult>;
  
  enableTool(agentId: string, toolName: string): Promise<void>;
  disableTool(agentId: string, toolName: string): Promise<void>;
  // ... 其他管理方法
}
```

**BuiltinToolProvider** (`browser/providers/tool/builtinToolProvider.ts`):
- 注册 22 个内置工具
- 包括：`read_file`, `write_to_file`, `list_dir`, `grep_search`, `terminal`, `use_mcp_tool` (存根) 等
- `use_mcp_tool`, `fetch_mcp_tools`, `grep_mcp_tools` 当前是 **存根实现**（返回 stub 消息）

**McpToolProvider** (`browser/providers/tool/mcpToolProvider.ts`):
- 桥接 VS Code 内置的 `IMcpService` 到 `IToolProvider`
- 观察 `IMcpService.servers`，当 MCP 服务器启动并暴露工具时，自动创建路由工具名 `<serverPrefix>__<toolName>`
- 当 `executeTool` 被调用时，路由到对应的 `IMcpServer.tools.call()`
- **这意味着：如果配置 CodeGraph 为 MCP 服务器，McpToolProvider 会自动发现并暴露其工具！**

### 2.4 Retrieval 系统

**IRetrievalProvider 接口** (定义于 `common/providers.ts`):

```typescript
export interface IRetrievalProvider {
  readonly id: string;
  readonly name: string;
  
  retrieve(query: string, options?: IRetrievalOptions): Promise<IRetrievalResult[]>;
  indexDocument(doc: IDocumentToIndex): Promise<void>;
}
```

**用途**: RAG (Retrieval Augmented Generation) - 为 Agent 提供相关文档上下文

**当前状态**: 未发现已实现的具体 RetrievalProvider，这是一个扩展点。

---

## 3. 集成方案分析

### 3.1 方案 A: MCP 集成 (快速方案)

**描述**: 将 CodeGraph 配置为 VS Code 的 MCP 服务器，利用现有的 `McpToolProvider` 自动暴露 CodeGraph 工具。

**优点**:
- ✅ **快速实现**: 无需修改核心代码，只需添加 MCP 服务器配置
- ✅ **利用现有架构**: `McpToolProvider` 已完整实现
- ✅ **用户友好**: 可以通过 UI 添加 MCP 服务器
- ✅ **灵活性**: 用户可以禁用/启用特定工具

**缺点**:
- ❌ **性能开销**: MCP 使用 stdio/IPC 通信，有序列化/反序列化开销
- ❌ **依赖外部进程**: CodeGraph 需要作为单独进程运行
- ❌ **工具发现延迟**: MCP 工具需要在服务器启动后才能发现

**实施步骤**:

1. **添加 CodeGraph 为 bundled MCP 服务器预设** (修改 `bundledMcpPresets.ts`):
   ```typescript
   {
     id: "codegraph",
     name: "CodeGraph",
     description: "Semantic code intelligence with knowledge graph",
     transportType: "stdio",
     command: "codegraph",
     args: ["serve", "--mcp"],
   }
   ```

2. **用户通过 UI 添加 CodeGraph MCP 服务器**:
   - 用户在 "MCP Servers" UI 中选择 "CodeGraph" 预设
   - VS Code 会自动启动 `codegraph serve --mcp`
   - `McpToolProvider` 自动发现工具 `codegraph__codegraph_search` 等

3. **Agent 可以使用 CodeGraph 工具**:
   - Agent 的工具列表中会出现 `codegraph__codegraph_search`, `codegraph__codegraph_context` 等
   - Agent 可以调用这些工具获取代码智能

### 3.2 方案 B: 深度库集成 (最佳性能)

**描述**: 将 CodeGraph 作为库直接嵌入项目，创建 `CodeGraphRetrievalProvider` 实现 `IRetrievalProvider`。

**优点**:
- ✅ **最佳性能**: 无 IPC 开销，直接调用 CodeGraph 库 API
- ✅ **紧密集成**: 可以利用 VS Code 的文件系统 API、进度报告等
- ✅ **自动上下文注入**: `RetrievalProvider` 可以自动为 Agent 注入相关代码上下文
- ✅ **更好的用户体验**: 无需用户手动配置 MCP 服务器

**缺点**:
- ❌ **依赖管理复杂**: 需要添加 `@colbymchenry/codegraph` 作为依赖
- ❌ **原生模块兼容性**: CodeGraph 使用 `better-sqlite3` (原生模块)，在 VS Code Electron 环境中可能不兼容
- ❌ **WASM 加载**: CodeGraph 使用 `web-tree-sitter` WASM，需要正确处理 WASM 文件加载

**实施步骤**:

1. **添加 CodeGraph 依赖**:
   ```bash
   npm install @colbymchenry/codegraph
   ```

2. **创建 CodeGraphRetrievalProvider**:
   ```typescript
   export class CodeGraphRetrievalProvider implements IRetrievalProvider {
     readonly id = 'codegraph';
     readonly name = 'CodeGraph';
     
     private codeGraph: CodeGraph | null = null;
     
     async retrieve(query: string, options?: IRetrievalOptions): Promise<IRetrievalResult[]> {
       if (!this.codeGraph) {
         this.codeGraph = await CodeGraph.open(this.getProjectPath());
       }
       
       // 使用 codeGraph.buildContext() 或 codeGraph.searchNodes()
       const context = await this.codeGraph.buildContext(query, {
         maxNodes: options?.topK ?? 10,
         includeCode: true,
         format: 'markdown'
       });
       
       return [{
         documentId: 'codegraph-context',
         content: context,
         score: 1.0,
         metadata: { source: 'codegraph' }
       }];
     }
     
     async indexDocument(doc: IDocumentToIndex): Promise<void> {
       // CodeGraph 自动索引，无需手动索引单个文档
     }
   }
   ```

3. **注册 CodeGraphRetrievalProvider**:
   ```typescript
   // 在 AgentOS 初始化时
   agentOSService.registerRetrievalProvider(new CodeGraphRetrievalProvider(), 100);
   ```

### 3.3 方案 C: 混合方案 (推荐)

**描述**: 结合方案 A 和方案 B 的优点，分阶段实施。

**阶段 1: MCP 集成 (快速胜利)**
- 添加 CodeGraph 为 bundled MCP 服务器预设
- 用户可以通过 UI 快速启用 CodeGraph
- 所有 CodeGraph MCP 工具立即可用

**阶段 2: 深度库集成 (最佳性能)**
- 实现 `CodeGraphRetrievalProvider`
- 自动为 Agent 注入代码上下文
- 更好的性能和用户体验

**阶段 3: UI 集成 (完美体验)**
- 在 Agent Studio UI 中显示 CodeGraph 索引状态
- 提供 "Re-index" 按钮
- 显示索引统计信息（文件数、符号数、边数）

---

## 4. 推荐集成方案：混合方案

### 4.1 为什么选择混合方案？

1. **快速交付价值**: 阶段 1 (MCP 集成) 可以在几天内完成，立即为用户提供 CodeGraph 的能力
2. **逐步优化**: 阶段 2 和 3 可以在后续迭代中完成，不影响初始发布
3. **降低风险**: 如果库集成遇到问题（如原生模块兼容性），MCP 集成仍然可用

### 4.2 实施计划

#### 阶段 1: MCP 集成 (预计 2-3 天)

**目标**: 让用户可以通过 UI 添加 CodeGraph 作为 MCP 服务器，Agent 可以调用 CodeGraph 工具。

**任务列表**:

- [ ] **T1.1**: 添加 CodeGraph 为 bundled MCP 服务器预设
  - 修改文件: `src/vs/sessions/contrib/agentStudio/common/bundled-tools/bundledMcpPresets.ts`
  - 添加 CodeGraph 预设配置
  
- [ ] **T1.2**: 确保 `McpToolProvider` 正确桥接 CodeGraph 工具
  - 验证: 启动 CodeGraph MCP 服务器，检查工具是否出现在 Agent 工具列表中
  - 测试: Agent 调用 `codegraph__codegraph_search` 是否正常工作
  
- [ ] **T1.3**: 添加 CodeGraph 安装检测
  - 在 `McpToolProvider` 或 UI 中检测 `codegraph` 命令是否可用
  - 如果不可用，显示安装提示
  
- [ ] **T1.4**: 更新文档
  - 添加 CodeGraph 使用说明到项目 README
  - 添加 CodeGraph MCP 服务器配置示例

**代码示例 (T1.1)**:

```typescript
// src/vs/sessions/contrib/agentStudio/common/bundled-tools/bundledMcpPresets.ts

export const BUNDLED_MCP_PRESETS: readonly IMcpServerPreset[] = [
  // ... 现有预设
  {
    id: "codegraph",
    name: "CodeGraph",
    description: "Semantic code intelligence with knowledge graph. Provides tools for code search, call graph analysis, and impact analysis.",
    transportType: "stdio",
    command: "codegraph",
    args: ["serve", "--mcp"],
    icon: "codegraph-icon.png", // 可选：添加图标
  },
  // ...
];
```

#### 阶段 2: 深度库集成 (预计 1-2 周)

**目标**: 实现 `CodeGraphRetrievalProvider`，自动为 Agent 注入代码上下文。

**任务列表**:

- [ ] **T2.1**: 评估 CodeGraph 库依赖性
  - 检查 `better-sqlite3` 在 VS Code Electron 中的兼容性
  - 验证 `web-tree-sitter` WASM 加载是否正常
  - 如不兼容，考虑使用 CodeGraph 的 WASM fallback (`node-sqlite3-wasm`)

- [ ] **T2.2**: 添加 CodeGraph 为项目依赖
  ```bash
  npm install @colbymchenry/codegraph
  ```

- [ ] **T2.3**: 创建 `CodeGraphRetrievalProvider` 类
  - 实现 `IRetrievalProvider` 接口
  - `retrieve()` 方法映射到 `codeGraph.buildContext()` 或 `codeGraph.searchNodes()`
  - 处理 CodeGraph 初始化和索引

- [ ] **T2.4**: 注册 `CodeGraphRetrievalProvider` 到 AgentOS
  - 在 AgentOS 初始化时注册
  - 设置合适的优先级

- [ ] **T2.5**: 实现索引状态 UI
  - 显示 CodeGraph 索引状态（未索引/索引中/已索引）
  - 提供 "索引/重新索引" 按钮

- [ ] **T2.6**: 测试和性能优化
  - 测试大项目（如 VS Code 本身）的索引性能
  - 优化 `retrieve()` 的响应时间

**代码示例 (T2.3)**:

```typescript
// src/vs/sessions/contrib/agentStudio/browser/providers/retrieval/codeGraphRetrievalProvider.ts

import CodeGraph from '@colbymchenry/codegraph';
import { IRetrievalProvider, IRetrievalResult, IRetrievalOptions } from '../../../common/providers.js';

export class CodeGraphRetrievalProvider implements IRetrievalProvider {
  readonly id = 'codegraph';
  readonly name = 'CodeGraph';
  
  private codeGraph: InstanceType<typeof CodeGraph> | null = null;
  private projectPath: string | null = null;
  
  constructor(private readonly logService: ILogService) {}
  
  async retrieve(query: string, options?: IRetrievalOptions): Promise<IRetrievalResult[]> {
    try {
      const cg = await this.ensureCodeGraph();
      
      // 使用 buildContext 获取相关代码上下文
      const context = await cg.buildContext(query, {
        maxNodes: options?.topK ?? 10,
        includeCode: true,
        format: 'markdown',
      });
      
      return [{
        documentId: 'codegraph-context',
        content: context,
        score: 1.0,
        metadata: { 
          source: 'codegraph',
          query,
        }
      }];
    } catch (err) {
      this.logService.error('[CodeGraphRetrievalProvider] retrieve failed:', err);
      return [];
    }
  }
  
  async indexDocument(_doc: IDocumentToIndex): Promise<void> {
    // CodeGraph 自动索引文件系统变更，无需手动索引
    // 但我们可以触发重新索引
    const cg = await this.ensureCodeGraph();
    await cg.sync(); // 增量同步
  }
  
  private async ensureCodeGraph(): Promise<InstanceType<typeof CodeGraph>> {
    if (this.codeGraph) {
      return this.codeGraph;
    }
    
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      throw new Error('No project path available');
    }
    
    // 尝试打开现有索引，如果不存在则初始化
    try {
      this.codeGraph = await CodeGraph.open(projectPath);
    } catch {
      this.codeGraph = await CodeGraph.init(projectPath);
      await this.codeGraph.indexAll({
        onProgress: (p) => {
          this.logService.info(`[CodeGraph] Indexing: ${p.phase} ${p.current}/${p.total}`);
        }
      });
    }
    
    // 启动文件监听
    this.codeGraph.watch();
    
    return this.codeGraph;
  }
  
  private getProjectPath(): string | null {
    // 从 workspaceService 获取当前工作区路径
    // 实现略
    return null;
  }
  
  dispose(): void {
    if (this.codeGraph) {
      this.codeGraph.unwatch();
      this.codeGraph.close();
      this.codeGraph = null;
    }
  }
}
```

#### 阶段 3: UI 集成 (预计 3-5 天)

**目标**: 完善用户体验，提供 CodeGraph 索引状态可视化和管理功能。

**任务列表**:

- [ ] **T3.1**: 创建 CodeGraph 状态栏 UI
  - 显示索引状态（未索引/索引中/已索引）
  - 显示索引统计（文件数、符号数）
  - 点击可打开详细面板

- [ ] **T3.2**: 创建 CodeGraph 管理面板
  - 显示索引详细信息
  - 提供 "重新索引" 按钮
  - 提供 "清除索引" 按钮
  - 显示索引日志

- [ ] **T3.3**: 集成到 Agent 配置 UI
  - 在 Agent 编辑器中添加 "Code Intelligence" 开关
  - 允许选择使用 MCP 工具或 Retrieval Provider

- [ ] **T3.4**: 添加 CodeGraph 工具提示
  - 当 Agent 尝试读取大量文件时，提示使用 CodeGraph 工具
  - 在工具结果中显示 CodeGraph 来源标识

---

## 5. 技术挑战与解决方案

### 5.1 CodeGraph 库依赖性

**挑战**: CodeGraph 使用 `better-sqlite3` (原生模块)，在 VS Code Electron 中可能不兼容。

**解决方案**:
1. **使用 WASM fallback**: CodeGraph 有 `node-sqlite3-wasm` fallback，应该能在 Electron 中工作
2. **测试验证**: 在开发环境中测试 CodeGraph 库是否能在 VS Code 中正常加载
3. **备选方案**: 如果库集成不可行，回退到 MCP 集成方案

### 5.2 WASM 文件加载

**挑战**: CodeGraph 使用 `web-tree-sitter` WASM 文件，需要正确加载。

**解决方案**:
1. **Copy assets**: 确保 `node_modules/@colbymchenry/codegraph/dist/extraction/wasm/*.wasm` 被正确复制到输出目录
2. **配置 webpack/rspack**: 如果项目使用打包工具，需要配置 WASM 文件处理
3. **使用 CDN**: 或者配置 `web-tree-sitter` 从 CDN 加载 WASM

### 5.3 索引性能

**挑战**: 大项目（如 VS Code 本身有 10k+ 文件）索引可能很慢。

**解决方案**:
1. **增量索引**: CodeGraph 支持 `sync()` 增量更新
2. **后台索引**: 在后台线程中运行索引，不阻塞 UI
3. **进度显示**: 显示索引进度，让用户知道状态

### 5.4 MCP 与库集成的共存

**挑战**: 如果同时启用 MCP 集成和库集成，可能会有冲突。

**解决方案**:
1. **优先级**: RetrievalProvider (库集成) 优先级高于 MCP 工具
2. **用户选择**: 在设置中允许用户选择使用哪种方式
3. **自动检测**: 如果库集成可用，自动禁用 MCP 工具（或反之）

---

## 6. 测试策略

### 6.1 单元测试

- [ ] `CodeGraphRetrievalProvider.retrieve()` 测试
- [ ] `CodeGraphRetrievalProvider.indexDocument()` 测试
- [ ] MCP 工具路由测试

### 6.2 集成测试

- [ ] CodeGraph MCP 服务器启动测试
- [ ] Agent 调用 CodeGraph 工具测试
- [ ] 大项目索引性能测试

### 6.3 E2E 测试

- [ ] 用户添加 CodeGraph MCP 服务器 E2E 测试
- [ ] Agent 使用 CodeGraph 工具完成任务的 E2E 测试
- [ ] CodeGraph 索引状态 UI E2E 测试

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| CodeGraph 库在 Electron 中不兼容 | 高 | 回退到 MCP 集成方案；与 CodeGraph 维护者合作修复兼容性问题 |
| 索引性能不满足要求 | 中 | 优化索引策略；使用增量索引；后台索引 |
| MCP 工具发现延迟高 | 中 | 优化 MCP 服务器启动；预启动常用 MCP 服务器 |
| WASM 文件加载失败 | 中 | 确保正确复制 WASM 文件；配置 CDN 回退 |

---

## 8. 结论

CodeGraph 是一个强大的代码智能工具，可以显著增强当前项目的 Agent 能力。推荐使用 **混合集成方案**：

1. **第一阶段**: 快速实现 MCP 集成，让用户立即可以使用 CodeGraph 工具
2. **第二阶段**: 实现深度库集成，提供更好的性能和用户体验
3. **第三阶段**: 完善 UI 集成，提供完美的用户体验

这种分阶段方法可以快速交付价值，同时降低技术风险。

---

## 附录 A: 相关文件清单

### 当前项目需要修改/创建的文件

**阶段 1 (MCP 集成)**:
- `src/vs/sessions/contrib/agentStudio/common/bundled-tools/bundledMcpPresets.ts` - 添加 CodeGraph 预设

**阶段 2 (深度库集成)**:
- `src/vs/sessions/contrib/agentStudio/browser/providers/retrieval/codeGraphRetrievalProvider.ts` - 新建
- `src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts` - 注册 Provider
- `package.json` - 添加 `@colbymchenry/codegraph` 依赖

**阶段 3 (UI 集成)**:
- `src/vs/sessions/contrib/agentStudio/browser/views/codeGraphStatusView.ts` - 新建
- `src/vs/sessions/contrib/agentStudio/browser/views/codeGraphPanel.ts` - 新建

### CodeGraph 项目关键文件

- `src/index.ts` - CodeGraph 库主入口
- `src/mcp/server.ts` - MCP 服务器实现
- `src/mcp/tools.ts` - MCP 工具定义
- `package.json` - 依赖和脚本
