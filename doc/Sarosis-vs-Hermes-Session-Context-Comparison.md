# Sarosis-Agents-Client vs Hermes Agent：Session & 上下文管理对比分析

## 一、概述

本文档对比分析 `sarosis-agents-client` (VSCode 定制版) 与 `hermes-agent-studio` (Python) 在 Session 管理和上下文管理方面的功能支持情况。

---

## 二、Sarosis-Agents-Client 的 Session 管理实现

### 2.1 架构概览

```
sarosis-agents-client/
├── src/vs/platform/agentHost/     # 平台级 Agent 宿主服务
│   ├── node/sessionDatabase.ts     # SQLite 数据库实现
│   ├── common/
│   │   ├── sessionDataService.ts   # 数据服务接口
│   │   └── agentHost.ts           # Agent 宿主定义
│   └── browser/ | electron-*/     # 各平台实现
│
├── src/vs/sessions/                # Sessions 功能模块
│   ├── services/sessions/
│   │   └── browser/
│   │       ├── sessionsManagementService.ts  # Session 管理服务
│   │       └── sessionsProvidersService.ts   # Provider 管理服务
│   └── contrib/                   # UI 贡献点
│
└── extensions/hermes-agent/        # Hermes Agent 扩展 (Bridge 模式)
    └── src/hermesBridge.ts        # JSON-RPC over stdio 桥接
```

### 2.2 数据存储：SessionDatabase

**位置**：`src/vs/platform/agentHost/node/sessionDatabase.ts`

**数据库类型**：`@vscode/sqlite3` (VSCode 定制版 SQLite)

**数据表结构**：

```sql
-- 对话轮次表
CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT,  -- 版本 4 新增
    FOREIGN KEY (event_id) REFERENCES events(id)
);

-- 文件编辑记录表
CREATE TABLE IF NOT EXISTS file_edits (
    turn_id        TEXT    NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    tool_call_id   TEXT    NOT NULL,
    file_path      TEXT    NOT NULL,
    edit_type      TEXT    NOT NULL DEFAULT 'edit',
    original_path  TEXT,
    before_content BLOB,
    after_content  BLOB,
    added_lines    INTEGER,
    removed_lines  INTEGER,
    PRIMARY KEY (tool_call_id, file_path)
);

-- Session 元数据表
CREATE TABLE IF NOT EXISTS session_metadata (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
```

**特性**：
- ✅ 支持数据库迁移（通过 `PRAGMA user_version`）
- ✅ 外键级联删除（`ON DELETE CASCADE`）
- ✅ 写操作序列化（`SequencerByKey` 防止竞态）
- ✅ 写操作跟踪（`_pendingWrites`）确保优雅关闭
- ❌ 无 FTS5 全文搜索支持

### 2.3 Session 管理服务：SessionsManagementService

**位置**：`src/vs/sessions/services/sessions/browser/sessionsManagementService.ts`

**核心功能**：

| 方法 | 功能描述 |
|------|----------|
| `getSessions()` | 获取所有 provider 的 sessions |
| `getSession(resource)` | 根据 URI 获取特定 session |
| `createNewSession(providerId, repositoryUri, sessionTypeId)` | 创建新 session |
| `openSession(sessionResource)` | 打开指定 session |
| `openChat(session, chatUri)` | 打开 session 中的特定 chat |
| `sendRequest(session, chat, options)` | 发送请求 |
| `sendAndCreateChat(session, options)` | 发送请求并创建新 chat |
| `openNewSessionView()` | 打开新建 session 视图 |
| `openNewChatInSession(session)` | 在 session 内新建 chat |

**状态持久化**：
- 使用 VSCode 的 `IStorageService`
- 存储键：`agentSessions.activeSessionStates`
- 存储范围：`StorageScope.WORKSPACE`
- 存储目标：`StorageTarget.MACHINE`

**Context Key 集成**：
- `activeSessionProviderId` - 当前激活的 provider ID
- `activeSessionType` - 当前 session 类型
- `isWorkspaceAgent` - 是否为工作区 Agent
- `isActiveSessionArchived` - Session 是否已归档
- `supportsMultiChat` - 是否支持多聊天

---

## 三、Hermes Agent (Python) 的 Session 管理实现

### 3.1 数据存储：SessionDB

**位置**：`hermes-agent-studio/hermes_state.py`

**数据库类型**：`sqlite3` (Python 标准库)

**数据表结构**：

```sql
-- Sessions 表
CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    workspace     TEXT,
    profile       TEXT,
    parent_session_id TEXT,  -- 压缩链支持
    is_compressed BOOLEAN DEFAULT 0,
    model         TEXT,
    provider      TEXT
);

-- Messages 表 (FTS5 虚拟表)
CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
    session_id,
    role,
    content,
    timestamp UNINDEXED,
    content='sessions'
);

-- Agent Interactions 表
CREATE TABLE IF NOT EXISTS agent_interactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT REFERENCES sessions(session_id),
    turn_id       TEXT,
    role          TEXT,
    content       TEXT,
    tool_calls    TEXT,
    timestamp     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Summaries 表 (上下文压缩)
CREATE TABLE IF NOT EXISTS summaries (
    session_id    TEXT PRIMARY KEY REFERENCES sessions(session_id),
    summary       TEXT,
    model         TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**特性**：
- ✅ FTS5 全文搜索（支持 Unicode61 和 Trigram 分词器）
- ✅ 压缩链支持（`parent_session_id`）
- ✅ 多表关联（sessions, messages, interactions, summaries）
- ✅ WAL 模式（Write-Ahead Logging）支持并发
- ✅ 自动迁移和压缩

### 3.2 上下文压缩机制

**ContextCompressor** (`agent/context_compressor.py`)：
- 使用辅助 LLM 总结中间轮次
- 保护尾部上下文（最近 N 轮不压缩）
- 支持多种压缩策略（自动、手动、定时）

**压缩链投影**：
- 查询时自动将压缩根 session 投影到最新延续
- 用户无感知的长对话管理

---

## 四、功能对比表

| 功能特性 | Sarosis-Agents-Client | Hermes Agent (Python) |
|---------|----------------------|----------------------|
| **数据存储** | SQLite (@vscode/sqlite3) | SQLite (sqlite3) |
| **数据表数量** | 3 (turns, file_edits, metadata) | 7+ (sessions, messages, interactions, summaries, etc.) |
| **FTS5 全文搜索** | ❌ 不支持 | ✅ 支持 (Unicode61 + Trigram) |
| **压缩链** | ❌ 不支持 | ✅ 支持 (parent_session_id) |
| **上下文压缩** | ❌ 不支持 | ✅ 支持 (ContextCompressor) |
| **记忆管理** | ❌ 不支持 | ✅ 支持 (MemoryManager) |
| **多 Provider** | ✅ 支持 (SessionsProvidersService) | ✅ 支持 |
| **预算跟踪** | ❌ 不支持 | ✅ 支持 (IterationBudget) |
| **Prompt 缓存** | ❌ 不支持 | ✅ 支持 (Anthropic) |
| **文件编辑跟踪** | ✅ 支持 (file_edits 表) | ✅ 支持 |
| **状态持久化** | ✅ StorageService | ✅ SQLite |
| **数据库迁移** | ✅ 支持 | ✅ 支持 |
| **并发安全** | ✅ SequencerByKey | ✅ WAL mode |

---

## 五、上下文管理对比

### 5.1 Sarosis-Agents-Client 的上下文管理

**管理方式**：
- 通过 VSCode 的 `IChatWidgetService` 管理聊天界面
- `SessionsManagementService` 管理 session 和 chat 的生命周期
- 没有专门的上下文压缩机制

**上下文来源**：
- 当前 chat 的消息历史（由 UI 组件管理）
- 文件编辑记录（存储在 `file_edits` 表）
- Session 元数据（存储在 `session_metadata` 表）

**限制**：
- ❌ 没有上下文压缩，长对话可能超出模型窗口
- ❌ 没有记忆管理，无法跨 session 记住用户信息
- ❌ 没有 FTS5 搜索，历史消息检索困难

### 5.2 Hermes Agent 的上下文管理

**管理方式**：
- **动态构建**：`prompt_builder.py` 动态组装系统提示
- **压缩**：`context_compressor.py` 使用辅助 LLM 总结
- **记忆**：`MemoryManager` 编排内置 + 外部记忆提供者
- **缓存**：支持 Anthropic 提示缓存

**上下文来源**：
1. 系统提示（动态构建）
2. 记忆上下文（`<memory-context>` 标签）
3. 工具定义（自动发现）
4. 消息历史（支持压缩）
5. 文件上下文（可选）

**优势**：
- ✅ 自动上下文压缩，支持长对话
- ✅ 记忆管理，跨 session 记住用户信息
- ✅ FTS5 搜索，快速检索历史
- ✅ 提示缓存，降低重复成本

---

## 六、使用场景对比

### 6.1 Sarosis-Agents-Client 适用场景

✅ **适合**：
- VSCode 内的代码编辑辅助
- 短对话（单个 session 内）
- 文件编辑跟踪和回溯
- 多 provider 支持（本地 + 远程）

❌ **不适合**：
- 长对话（缺乏压缩机制）
- 需要记忆管理的场景
- 需要全文搜索历史的场景

### 6.2 Hermes Agent 适用场景

✅ **适合**：
- 长对话（自动压缩）
- 需要记忆管理的场景
- 需要全文搜索历史的场景
- 多平台部署（CLI, Gateway, TUI）

❌ **不适合**：
- 需要与 VSCode 深度集成的场景（需要通过 Bridge 模式）

---

## 七、集成方式：Bridge 模式

`sarosis-agents-client` 可以通过 `hermes-agent` 扩展使用 Bridge 模式调用 Hermes Agent 的完整功能：

```
VSCode (TypeScript)
    ↓
hermesBridge.ts (JSON-RPC over stdio)
    ↓
hermes_bridge_server.py (Python)
    ↓
AIAgent + ToolRegistry + Providers
```

**Bridge 模式优势**：
- ✅ 可以使用 Hermes Agent 的完整功能（压缩、记忆、搜索）
- ✅ 保留 VSCode 的 UI 体验
- ✅ 支持多种 provider 和模型

**Bridge 模式限制**：
- ❌ 需要安装 Python 和 hermes-agent
- ❌ 进程间通信开销
- ❌ 调试相对困难

---

## 八、结论

### 8.1 Sarosis-Agents-Client 是否支持相同功能？

**答案：部分支持**

1. **Session 管理**：
   - ✅ 支持基本的 session CRUD
   - ✅ 支持多 provider
   - ✅ 支持状态持久化
   - ❌ 不支持压缩链
   - ❌ 不支持 FTS5 搜索

2. **上下文管理**：
   - ✅ 支持基本的消息历史
   - ✅ 支持文件编辑跟踪
   - ❌ 不支持上下文压缩
   - ❌ 不支持记忆管理

### 8.2 推荐方案

| 需求 | 推荐方案 |
|------|----------|
| VSCode 内使用 + 完整功能 | 使用 `hermes-agent` 扩展 (Bridge 模式) |
| 轻量级 VSCode 集成 | 使用内置 session 管理 |
| 长对话支持 | 必须使用 Hermes Agent (Python) |
| 记忆管理 | 必须使用 Hermes Agent (Python) |
| 全文搜索 | 必须使用 Hermes Agent (Python) |

---

## 九、附录：关键代码路径

### Sarosis-Agents-Client

| 功能 | 文件路径 |
|------|----------|
| Session 数据库 | `src/vs/platform/agentHost/node/sessionDatabase.ts` |
| Session 管理服务 | `src/vs/sessions/services/sessions/browser/sessionsManagementService.ts` |
| Provider 管理服务 | `src/vs/sessions/services/sessions/browser/sessionsProvidersService.ts` |
| Hermes Bridge | `extensions/hermes-agent/src/hermesBridge.ts` |
| Agent 宿主服务 | `src/vs/platform/agentHost/common/agentService.ts` |

### Hermes Agent (Python)

| 功能 | 文件路径 |
|------|----------|
| Session 数据库 | `hermes_state.py` |
| Agent 主循环 | `run_agent.py` |
| 上下文压缩 | `agent/context_compressor.py` |
| 记忆管理 | `agent/memory_manager.py` |
| Prompt 构建 | `agent/prompt_builder.py` |
| 工具注册 | `tools/registry.py` |

---

## 十、后续建议

如果需要在 `sarosis-agents-client` 中实现与 Hermes Agent 相同的功能，建议：

1. **增强 SessionDatabase**：
   - 添加 `sessions` 表和 `parent_session_id` 字段
   - 集成 FTS5 全文搜索
   - 实现压缩链机制

2. **实现上下文压缩**：
   - 移植 `context_compressor.py` 到 TypeScript
   - 或使用 Bridge 模式调用 Python 端

3. **实现记忆管理**：
   - 移植 `MemoryManager` 到 TypeScript
   - 或集成外部记忆服务（Mem0, SuperMemory）

4. **推荐使用 Bridge 模式**：
   - 对于复杂功能，优先使用 Bridge 模式
   - 避免重复实现，保持一致性

---

**文档版本**：v1.0  
**生成时间**：2026-05-13  
**作者**：AI Assistant
