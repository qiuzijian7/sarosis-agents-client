# Phase 1 实施总结 - Session & 上下文增强框架

> **日期**：2026-05-13  
> **状态**：Phase 1 完成  
> **作者**：AI Assistant

---

## 实施内容

### 1. 接口定义（3 个文件）

| 文件 | 接口 | 说明 |
|------|------|------|
| `src/vs/platform/agentHost/common/enhancedSessionStore.ts` | `IEnhancedSessionStore` | 增强 SessionStore 接口，添加记忆和压缩日志操作 |
| `src/vs/platform/agentHost/common/contextCompression.ts` | `IContextCompressionService` | 上下文压缩服务接口，5 阶段压缩管线定义 |
| `src/vs/platform/agentHost/common/memoryService.ts` | `IMemoryService`, `IMemoryProvider` | 记忆服务和 Provider 接口 |

### 2. 实现文件（4 个文件）

| 文件 | 类 | 说明 |
|------|------|------|
| `extensions/copilot/src/platform/chronicle/node/enhancedSessionStoreImpl.ts` | `EnhancedSessionStore` | 扩展 Chronicle SessionStore，Schema v4 迁移 |
| `src/vs/platform/agentHost/node/contextCompressionService.ts` | `ContextCompressionService` | 压缩服务实现（骨架 + Stage 1） |
| `src/vs/platform/agentHost/node/memoryServiceImpl.ts` | `MemoryService` | 记忆服务实现（多 Provider 协调） |
| `src/vs/platform/agentHost/node/builtinMemoryProvider.ts` | `BuiltinMemoryProvider` | 内置记忆 Provider（工具 + 自动提取） |

### 3. 集成文件（3 个文件）

| 文件 | 说明 |
|------|------|
| `src/vs/platform/agentHost/node/agentHostIntegration.ts` | AgentHost 事件集成（监听 SessionTurnComplete） |
| `src/vs/platform/agentHost/node/agentHostServices.ts` | 服务注册辅助函数 |
| `src/vs/platform/agentHost/common/sessionConfiguration.ts` | 配置项定义（压缩 + 记忆） |

---

## Schema 迁移（v3 → v4）

```sql
-- 新增表：memories（记忆存储）
CREATE TABLE IF NOT EXISTS memories (
    id            TEXT    PRIMARY KEY,
    session_id    TEXT    REFERENCES sessions(id),
    category      TEXT    NOT NULL DEFAULT 'general',
    content       TEXT    NOT NULL,
    importance    REAL    NOT NULL DEFAULT 0.5,
    access_count  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at    TEXT,
    source        TEXT    NOT NULL DEFAULT 'auto'
);

-- 新增表：compression_log（压缩历史）
CREATE TABLE IF NOT EXISTS compression_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT    NOT NULL REFERENCES sessions(id),
    compressed_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    strategy          TEXT    NOT NULL,
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    turns_compressed  INTEGER,
    turns_preserved   INTEGER,
    savings_percent   REAL,
    summary_preview   TEXT
);

-- FTS5 索引自动包含 memories（source_type = 'memory'）
```

---

## 核心功能实现状态

### EnhancedSessionStore ✅

- [x] `insertMemory()` - 写入记忆 + FTS5 索引
- [x] `updateMemory()` - 更新记忆 + 重建索引
- [x] `deleteMemory()` - 删除记忆 + 清理索引
- [x] `getMemories()` - 过滤查询（category, sessionId, minImportance）
- [x] `incrementMemoryAccess()` - 访问计数
- [x] `searchWithRelevance()` - BM25 + 重要度加权搜索
- [x] `logCompression()` - 压缩日志写入
- [x] `getCompressionHistory()` - 压缩历史查询

### ContextCompressionService ⚠️（骨架 + Stage 1）

- [x] `pruneToolOutputs()` - **Stage 1 完整实现**
- [x] 反抖动（anti-thrashing）逻辑
- [x] 冷却机制（cooldown）
- [x] `shouldCompress()` - 阈值检查
- [x] `compress()` - 压缩管线框架
- [ ] `\_generateStructuredSummary()` - **Stage 4 需要 LLM 调用**（待实现）
- [ ] `\_persistCompression()` - **Stage 5 持久化**（待实现）
- [ ] `\_getSessionMessages()` - **消息获取**（待实现）

### MemoryService ✅（骨架）

- [x] Provider 注册/注销
- [x] 工具路由（tool → provider）
- [x] `prefetch()` - 上下文注入
- [x] `syncTurn()` - Turn 同步
- [ ] `writeMemory()` - 需要完善错误处理
- [ ] `searchMemories()` - 需要完善

### BuiltinMemoryProvider ✅（基础实现）

- [x] `systemPromptBlock()` - 系统提示片段
- [x] `prefetch()` - FTS5 搜索 + 结果格式化
- [x] `getToolSchemas()` - memory\_write, memory\_search, memory\_delete
- [x] `handleToolCall()` - 工具执行
- [x] `syncTurn()` - **基础启发式提取**（待 LLM 增强）
- [ ] `onPreCompress()` - 压缩前上下文（待完善）

---

## 配置项

```jsonc
{
    // 压缩配置
    "sarosis.session.compression.enabled": true,
    "sarosis.session.compression.thresholdPercent": 0.50,
    "sarosis.session.compression.headProtectCount": 3,
    "sarosis.session.compression.tailBudgetRatio": 0.20,
    "sarosis.session.compression.toolOutputTruncateLength": 500,

    // 记忆配置
    "sarosis.session.memory.enabled": true,
    "sarosis.session.memory.maxPrefetchResults": 5,
    "sarosis.session.memory.autoExtract": true,
    "sarosis.session.memory.defaultImportance": 0.5
}
```

---

## 待完成事项（Phase 1 剩余）

### 高优先级

1. **实现 `_getSessionMessages()`** - 从 SessionStore 或 SessionDatabase 获取消息
2. **实现 `_generateStructuredSummary()`** - 调用 LLM 生成结构化摘要
3. **实现 `_persistCompression()`** - 将摘要持久化到 checkpoint
4. **完善 AgentHost 集成** - 在 `agentService.ts` 中注册事件监听

### 中优先级

5. **服务注册** - 在 workbench 初始化中调用 `registerAgentHostServices()`
6. **配置注册** - 调用 `registerSessionConfiguration()`
7. **类型检查** - 修复可能的类型错误
8. **单元测试** - 为关键函数编写测试

---

## 文件清单

### 新增文件（11 个）

```
src/vs/platform/agentHost/common/
├── enhancedSessionStore.ts        # IEnhancedSessionStore 接口
├── contextCompression.ts          # IContextCompressionService 接口
├── memoryService.ts              # IMemoryService + IMemoryProvider 接口
└── sessionConfiguration.ts       # 配置项定义

src/vs/platform/agentHost/node/
├── enhancedSessionStoreImpl.ts    # EnhancedSessionStore 实现 (extensions/copilot/...)
├── contextCompressionService.ts   # ContextCompressionService 实现
├── memoryServiceImpl.ts          # MemoryService 实现
├── builtinMemoryProvider.ts      # BuiltinMemoryProvider 实现
├── agentHostIntegration.ts       # AgentHost 事件集成
└── agentHostServices.ts         # 服务注册辅助函数
```

### 修改文件（待定）

```
src/vs/platform/agentHost/common/agentService.ts  # 集成压缩/记忆监听
src/vs/workbench/browser/        # workbench 初始化中注册服务
```

---

## 下一步（Phase 2）

根据设计文档，Phase 2 将完成：

1. **BuiltinMemoryProvider 完善**
   - LLM 驱动的自动提取
   - 记忆去重 + 合并策略

2. **MemoryService 集成**
   - `sendMessage` wrapper（预取注入）
   - Session 切换通知

3. **贡献点注册机制**
   - `contributes.agentStudioMemoryProvider` schema
   - 扩展激活触发注册

4. **配置 UI**
   - AgentStudio Settings Tab 集成

---

## 测试建议

### 单元测试

```bash
# 运行单元测试
cd g:\CustomWorkspaces\AIProjects\sarosis-agents-client
npx vitest run src/vs/platform/agentHost/
```

### 手动测试

1. **压缩测试**：
   - 打开 Agent Studio
   - 发送大量消息触发压缩阈值
   - 检查 `compression_log` 表是否有记录

2. **记忆测试**：
   - 使用 `memory_write` 工具保存记忆
   - 使用 `memory_search` 工具搜索记忆
   - 检查 `memories` 表和 FTS5 索引

3. **集成测试**：
   - 完成 Turn 后检查是否自动触发压缩检查
   - 切换 Session 后检查记忆是否同步

---

**文档版本**：v1.0  
**生成时间**：2026-05-13  
**实施者**：AI Assistant
