# Saros-Agents-Client Session & 上下文增强框架设计

> **方案2**：在 `saros-agents-client` TypeScript 端原生实现上下文压缩、记忆管理和 FTS5 全文搜索，
> 参考 Hermes Agent (Python) 的成熟实现，融入现有的 AgentHost / Sessions / Chronicle 架构。

**版本**：v1.0
**日期**：2026-05-13
**状态**：设计稿

---

## 目录

1. [设计目标](#一设计目标)
2. [现有架构基线](#二现有架构基线)
3. [增强框架总体架构](#三增强框架总体架构)
4. [模块一：SessionStore 增强（FTS5 搜索）](#四模块一sessionstore-增强fts5-搜索)
5. [模块二：ContextCompressionService（上下文压缩）](#五模块二contextcompressionservice上下文压缩)
6. [模块三：MemoryService（记忆管理）](#六模块三memoryservice记忆管理)
7. [集成点与数据流](#七集成点与数据流)
8. [接口定义](#八接口定义)
9. [数据库 Schema 迁移](#九数据库-schema-迁移)
10. [实现路线图](#十实现路线图)
11. [风险与缓解](#十一风险与缓解)

---

## 一、设计目标

| 目标 | 说明 | 优先级 |
|------|------|--------|
| **长对话支持** | 通过上下文压缩，支持超过模型上下文窗口的长对话 | P0 |
| **跨会话记忆** | 跨 session 记住用户偏好、项目知识、决策历史 | P0 |
| **全文搜索** | 对历史对话、摘要、文件编辑记录进行 BM25 全文检索 | P1 |
| **非侵入式集成** | 不破坏现有 AgentHost 状态协议和 SessionDatabase | P0 |
| **Provider 无关** | 压缩和记忆机制不绑定特定 LLM Provider | P1 |
| **渐进式增强** | 可按模块独立启用/禁用，不影响基础功能 | P1 |

---

## 二、现有架构基线

### 2.1 系统层次

```
┌─────────────────────────────────────────────────────────────────────┐
│  UI 层 (sessions/browser, workbench/contrib/chat)                  │
│  ├─ SessionsManagementService (统一管理入口)                         │
│  ├─ IActiveSession / ISession / IChat (可观察数据模型)               │
│  └─ ChatWidget (对话渲染)                                           │
├─────────────────────────────────────────────────────────────────────┤
│  服务层 (sessions/services)                                         │
│  ├─ ISessionsProvider (抽象提供者接口)                               │
│  ├─ ISessionsManagementService (聚合、多 provider 路由)             │
│  └─ IAgentSessionsService (AgentHost 封装)                          │
├─────────────────────────────────────────────────────────────────────┤
│  Agent Host 层 (platform/agentHost)                                 │
│  ├─ IAgentService → IAgentConnection → IAgent                      │
│  ├─ AgentHostStateManager + SessionState (Action 驱动状态机)         │
│  └─ ISessionDataService / ISessionDatabase (per-session 持久化)     │
├─────────────────────────────────────────────────────────────────────┤
│  存储层                                                             │
│  ├─ SessionDatabase (@vscode/sqlite3, turns + file_edits + metadata)│
│  └─ Chronicle SessionStore (node:sqlite + FTS5, 跨会话索引)          │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 已有的关键能力

| 组件 | 能力 | 位置 |
|------|------|------|
| `SessionDatabase` | per-session SQLite (turns, file_edits, metadata) | `platform/agentHost/node/` |
| `SessionStore` (Chronicle) | 跨会话 SQLite + FTS5 (sessions, turns, checkpoints, search_index) | `extensions/copilot/chronicle/` |
| `SessionStoreTracker` | OTel span 驱动的自动数据写入 | `extensions/copilot/chronicle/` |
| `SessionStoreSqlTool` | LLM 可调用的 SQL 查询工具 | `extensions/copilot/tools/` |
| AgentHost State Protocol | Action 驱动的状态机 (Turn 生命周期、Session 管理) | `platform/agentHost/common/state/` |

### 2.3 缺失的能力

| 能力 | 当前状态 |
|------|----------|
| 上下文压缩 | ❌ 不存在，长对话直接截断 |
| 记忆管理 | ❌ 不存在，无跨 session 记忆 |
| 记忆注入上下文 | ❌ 不存在，无自动召回机制 |
| 压缩摘要生成 | ⚠️ Chronicle 有 checkpoint 表，但无自动填充逻辑 |
| 跨会话 FTS5 搜索 | ⚠️ Chronicle 有实现，但与 AgentHost 层未打通 |

---

## 三、增强框架总体架构

### 3.1 架构图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         新增增强层                                       │
│                                                                          │
│  ┌─────────────────────┐  ┌──────────────────────┐  ┌─────────────────┐ │
│  │ ContextCompression-  │  │    MemoryService      │  │  SearchService  │ │
│  │ Service              │  │                        │  │                 │ │
│  │                      │  │ ┌──────────────────┐  │  │ FTS5 查询封装   │ │
│  │ • 5 阶段压缩策略     │  │ │ IMemoryProvider  │  │  │ BM25 排序       │ │
│  │ • 工具输出修剪       │  │ │  (贡献点接口)     │  │  │ 语义搜索扩展    │ │
│  │ • LLM 结构化摘要     │  │ ├──────────────────┤  │  │                 │ │
│  │ • 头/尾保护          │  │ │BuiltinMemory-    │  │  └────────┬────────┘ │
│  │ • 反抖动 + 冷却      │  │ │Provider          │  │           │          │
│  │                      │  │ │(文件记忆 + KV)   │  │           │          │
│  └──────────┬───────────┘  │ ├──────────────────┤  │           │          │
│             │              │ │ExtensionMemory-  │  │           │          │
│             │              │ │Provider          │  │           │          │
│             │              │ │(扩展贡献)        │  │           │          │
│             │              │ └──────────────────┘  │           │          │
│             │              └──────────┬─────────────┘           │          │
│             │                         │                         │          │
├─────────────┼─────────────────────────┼─────────────────────────┼──────────┤
│             ▼                         ▼                         ▼          │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                   EnhancedSessionStore                              │  │
│  │                                                                     │  │
│  │  sessions │ turns │ checkpoints │ memories │ search_index (FTS5)    │  │
│  │                                                                     │  │
│  │  现有 Chronicle SessionStore 增强版                                 │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│                     现有架构层（不修改）                                   │
│                                                                          │
│  AgentHost State Protocol ←→ SessionDatabase ←→ SessionsManagementService│
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 设计原则

1. **旁路增强**：新增服务通过监听 AgentHost 事件驱动，不修改核心状态协议
2. **贡献点扩展**：记忆 Provider 通过 `contributes` 注册，支持扩展自定义
3. **复用 Chronicle**：在现有 SessionStore (FTS5) 基础上增强，不另建存储
4. **参考 Hermes**：压缩算法和记忆架构直接移植 Hermes 的成熟策略

---

## 四、模块一：SessionStore 增强（FTS5 搜索）

### 4.1 目标

在现有 Chronicle `SessionStore` 基础上，增加 `memories` 表和压缩摘要自动写入能力，使其成为统一的跨会话知识库。

### 4.2 Schema 增强

```sql
-- ═══ 新增表：memories ═══
-- 存储跨会话的持久化记忆条目
CREATE TABLE IF NOT EXISTS memories (
    id            TEXT    PRIMARY KEY,
    session_id    TEXT,                          -- 来源 session（可为 NULL 表示全局记忆）
    category      TEXT    NOT NULL DEFAULT 'general',  -- 分类：user_preference | project_knowledge | decision | general
    content       TEXT    NOT NULL,              -- 记忆内容
    importance    REAL    NOT NULL DEFAULT 0.5,  -- 重要度 [0.0, 1.0]
    access_count  INTEGER NOT NULL DEFAULT 0,    -- 访问次数（用于衰减排序）
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT,                          -- 可选过期时间
    source        TEXT    NOT NULL DEFAULT 'auto' -- auto | user | tool
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);

-- ═══ 增强 search_index：索引记忆内容 ═══
-- source_type 新增值: 'memory'
-- source_id 格式: 'memory:{id}'
-- 利用现有 FTS5 search_index 表，无需新建虚拟表

-- ═══ 新增表：compression_log ═══
-- 记录压缩操作历史，用于反抖动和调试
CREATE TABLE IF NOT EXISTS compression_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL,
    compressed_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    strategy        TEXT    NOT NULL,            -- 'auto' | 'manual' | 'focused'
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    turns_compressed INTEGER,
    turns_preserved  INTEGER,
    savings_percent  REAL,
    summary_preview  TEXT                         -- 摘要前 200 字符
);

CREATE INDEX IF NOT EXISTS idx_compression_session ON compression_log(session_id);
```

### 4.3 搜索 API 增强

```typescript
// ═══ 新增接口方法 ═══

interface IEnhancedSessionStore extends ISessionStore {
    // ── 记忆操作 ──
    insertMemory(memory: IMemoryEntry): Promise<void>;
    updateMemory(id: string, updates: Partial<IMemoryEntry>): Promise<void>;
    deleteMemory(id: string): Promise<void>;
    getMemories(filter?: IMemoryFilter): Promise<IMemoryEntry[]>;

    // ── 语义搜索增强 ──
    searchWithRelevance(query: string, options?: ISearchOptions): Promise<ISearchResult[]>;

    // ── 压缩日志 ──
    logCompression(entry: ICompressionLogEntry): Promise<void>;
    getCompressionHistory(sessionId: string): Promise<ICompressionLogEntry[]>;
}

interface IMemoryEntry {
    id: string;
    sessionId?: string;
    category: 'user_preference' | 'project_knowledge' | 'decision' | 'general';
    content: string;
    importance: number;         // [0.0, 1.0]
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
    source: 'auto' | 'user' | 'tool';
}

interface IMemoryFilter {
    category?: string;
    sessionId?: string;
    minImportance?: number;
    limit?: number;
    includeExpired?: boolean;
}

interface ISearchOptions {
    maxResults?: number;
    sourceTypes?: string[];     // 过滤 source_type: 'turn' | 'checkpoint_*' | 'memory'
    sessionId?: string;         // 限定某个 session
    minRank?: number;           // BM25 最低分数
}

interface ISearchResult {
    content: string;
    sessionId: string;
    sourceType: string;
    sourceId: string;
    rank: number;               // BM25 分数
}
```

### 4.4 FTS5 查询策略

```sql
-- 基础搜索：BM25 排序
SELECT content, session_id, source_type, source_id, bm25(search_index) AS rank
FROM search_index
WHERE search_index MATCH ?
ORDER BY rank
LIMIT ?;

-- 带 source_type 过滤（仅搜索记忆）
SELECT content, session_id, source_type, source_id, bm25(search_index) AS rank
FROM search_index
WHERE search_index MATCH ? AND source_type = 'memory'
ORDER BY rank
LIMIT ?;

-- 组合查询：搜索 + 记忆重要度加权
SELECT si.content, si.session_id, si.source_type, si.source_id,
       bm25(search_index) AS text_rank,
       COALESCE(m.importance, 0.5) AS importance,
       bm25(search_index) * (1.0 + COALESCE(m.importance, 0.0)) AS combined_rank
FROM search_index si
LEFT JOIN memories m ON si.source_id = 'memory:' || m.id
WHERE search_index MATCH ?
ORDER BY combined_rank
LIMIT ?;
```

---

## 五、模块二：ContextCompressionService（上下文压缩）

### 5.1 目标

移植 Hermes Agent 的 5 阶段压缩策略到 TypeScript，监听 AgentHost 状态事件自动触发压缩。

### 5.2 压缩策略

```
┌─────────────────────────────────────────────────────────────────────┐
│                     5 阶段压缩管线                                   │
│                                                                     │
│  Stage 1: 工具输出修剪 (无 LLM 调用)                                │
│  ├─ 旧 tool_result → 单行摘要                                      │
│  │   "[terminal] ran `npm test` → exit 0, 47 lines"               │
│  ├─ 去重相同内容的 tool results                                     │
│  └─ 截断超过 500 字符的 tool_call arguments                         │
│                                                                     │
│  Stage 2: 头部保护                                                  │
│  └─ 保护前 N 条消息 (default=3, 含 system prompt + 首次交互)        │
│                                                                     │
│  Stage 3: 尾部 Token 预算保护                                       │
│  ├─ 从末尾向前累积 token                                            │
│  ├─ 保护最近 ~20K token (summary_target_ratio * threshold_tokens)   │
│  └─ 确保最后一条 user 消息始终在尾部                                 │
│                                                                     │
│  Stage 4: 结构化 LLM 摘要                                           │
│  ├─ 对中间轮次调用 LLM 生成结构化摘要                               │
│  │   包含: Active Task, Goal, Constraints, Completed Actions,       │
│  │         Active State, In Progress, Key Decisions, ...            │
│  └─ 摘要 Token 预算: min(context_length * 5%, 12000)               │
│                                                                     │
│  Stage 5: 迭代更新                                                  │
│  └─ 后续压缩更新已有摘要，而非重新生成                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 接口定义

```typescript
// ═══ src/vs/platform/agentHost/common/contextCompression.ts ═══

import { Event } from 'vs/base/common/event';
import { IDisposable } from 'vs/base/common/lifecycle';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

export const IContextCompressionService = createDecorator<IContextCompressionService>(
    'contextCompressionService'
);

export interface IContextCompressionService extends IDisposable {
    readonly _serviceBrand: undefined;

    /**
     * 当压缩发生时触发，携带压缩结果信息。
     */
    readonly onDidCompress: Event<ICompressionEvent>;

    /**
     * 检查指定 session 是否需要压缩。
     * 基于当前 token 使用率和阈值判断。
     */
    shouldCompress(sessionId: string): Promise<boolean>;

    /**
     * 对指定 session 执行压缩。
     * @param sessionId - 目标 session
     * @param options - 可选的压缩参数
     * @returns 压缩结果
     */
    compress(sessionId: string, options?: ICompressionOptions): Promise<ICompressionResult>;

    /**
     * 仅执行 Stage 1（工具输出修剪），不调用 LLM。
     * 可作为低成本预处理随时调用。
     */
    pruneToolOutputs(messages: ITurnMessage[]): ITurnMessage[];

    /**
     * 获取指定 session 的压缩历史。
     */
    getCompressionHistory(sessionId: string): Promise<ICompressionLogEntry[]>;

    /**
     * 重置指定 session 的压缩状态（反抖动计数器、冷却定时器等）。
     */
    resetState(sessionId: string): void;
}

// ── 压缩配置 ──

export interface ICompressionConfig {
    /** 触发压缩的 token 使用率阈值，默认 0.50 (50%) */
    thresholdPercent: number;

    /** 头部保护的消息数量，默认 3 */
    headProtectCount: number;

    /** 尾部保护的 token 预算比率，默认 0.20 */
    tailBudgetRatio: number;

    /** 摘要 token 上限，默认 12000 */
    summaryTokenLimit: number;

    /** 摘要 token 最小值，默认 2000 */
    summaryTokenMin: number;

    /** 摘要占上下文长度的最大百分比，默认 0.05 (5%) */
    summaryContextRatio: number;

    /** 工具输出截断字符数，默认 500 */
    toolOutputTruncateLength: number;

    /** 连续节省不足阈值（反抖动），默认 0.10 (10%) */
    antiThrashingThreshold: number;

    /** 失败后冷却时间（毫秒），默认 60000 */
    cooldownOnFailure: number;

    /** 无 Provider 时冷却时间（毫秒），默认 600000 */
    cooldownNoProvider: number;

    /** 是否启用，默认 true */
    enabled: boolean;
}

// ── 压缩选项 ──

export interface ICompressionOptions {
    /** 聚焦主题：生成摘要时优先保留与该主题相关的内容 */
    focusTopic?: string;

    /** 强制压缩，忽略阈值检查 */
    force?: boolean;

    /** 使用指定模型进行摘要生成 */
    modelOverride?: string;
}

// ── 压缩结果 ──

export interface ICompressionResult {
    success: boolean;
    sessionId: string;
    turnsCompressed: number;
    turnsPreserved: number;
    inputTokens: number;
    outputTokens: number;
    savingsPercent: number;
    summary?: IStructuredSummary;
    error?: string;
}

// ── 结构化摘要 ──

export interface IStructuredSummary {
    activeTask: string;
    goal: string;
    constraints: string[];
    completedActions: string[];
    activeState: string;
    inProgress: string[];
    blocked: string[];
    keyDecisions: string[];
    resolvedQuestions: string[];
    pendingQuestions: string[];
    relevantFiles: string[];
    remainingWork: string[];
    criticalContext: string[];
}

// ── 事件 ──

export interface ICompressionEvent {
    sessionId: string;
    result: ICompressionResult;
    timestamp: number;
}

// ── 消息类型 ──

export interface ITurnMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    toolName?: string;
    tokenCount?: number;
}

// ── 日志 ──

export interface ICompressionLogEntry {
    sessionId: string;
    compressedAt: string;
    strategy: 'auto' | 'manual' | 'focused';
    inputTokens: number;
    outputTokens: number;
    turnsCompressed: number;
    turnsPreserved: number;
    savingsPercent: number;
    summaryPreview: string;
}
```

### 5.4 实现类框架

```typescript
// ═══ src/vs/platform/agentHost/node/contextCompressionService.ts ═══

export class ContextCompressionService extends Disposable implements IContextCompressionService {

    declare readonly _serviceBrand: undefined;

    private readonly _onDidCompress = this._register(new Emitter<ICompressionEvent>());
    readonly onDidCompress = this._onDidCompress.event;

    // ── 反抖动状态 (per-session) ──
    private readonly _consecutiveLowSavings = new Map<string, number>();
    private readonly _cooldownUntil = new Map<string, number>();
    private readonly _lastSummary = new Map<string, IStructuredSummary>();

    constructor(
        @IAgentService private readonly agentService: IAgentService,
        @ISessionDataService private readonly sessionDataService: ISessionDataService,
        @IEnhancedSessionStore private readonly sessionStore: IEnhancedSessionStore,
        @IConfigurationService private readonly configService: IConfigurationService,
        @ILogService private readonly logService: ILogService,
    ) {
        super();
        this._registerListeners();
    }

    // ── Stage 1: 工具输出修剪 ──
    pruneToolOutputs(messages: ITurnMessage[]): ITurnMessage[] {
        return messages.map((msg, i) => {
            if (msg.role !== 'tool') return msg;
            // 仅修剪非尾部的 tool results
            if (i >= messages.length - this._config.headProtectCount) return msg;

            const summary = this._summarizeToolResult(msg);
            return { ...msg, content: summary };
        });
    }

    // ── Stage 2-5: 完整压缩 ──
    async compress(sessionId: string, options?: ICompressionOptions): Promise<ICompressionResult> {
        // 1. 冷却检查
        if (this._isInCooldown(sessionId) && !options?.force) {
            return { success: false, sessionId, error: 'In cooldown period', ... };
        }

        // 2. 获取 session 消息
        const messages = await this._getSessionMessages(sessionId);

        // 3. Stage 1 - 工具输出修剪
        const pruned = this.pruneToolOutputs(messages);

        // 4. Stage 2 - 头部保护
        const head = pruned.slice(0, this._config.headProtectCount);

        // 5. Stage 3 - 尾部 Token 预算保护
        const { tail, middle } = this._splitByTailBudget(pruned, head.length);

        if (middle.length === 0) {
            return { success: false, sessionId, error: 'Nothing to compress', ... };
        }

        // 6. Stage 4 - 结构化 LLM 摘要
        const previousSummary = this._lastSummary.get(sessionId);
        const summary = await this._generateStructuredSummary(
            middle, previousSummary, options?.focusTopic
        );

        // 7. Stage 5 - 存储 & 更新
        this._lastSummary.set(sessionId, summary);
        await this._persistCompression(sessionId, summary, middle, tail);

        // 8. 反抖动检查
        const savings = this._calculateSavings(middle, summary);
        this._updateAntiThrashing(sessionId, savings);

        const result: ICompressionResult = { ... };
        this._onDidCompress.fire({ sessionId, result, timestamp: Date.now() });
        return result;
    }

    // ── 私有方法 ──

    private _registerListeners(): void {
        // 监听 Turn 完成事件，检查是否需要自动压缩
        this._register(this.agentService.onDidSessionProgress(event => {
            if (event.kind === 'turnComplete') {
                this._maybeAutoCompress(event.sessionId);
            }
        }));
    }

    private async _maybeAutoCompress(sessionId: string): Promise<void> {
        if (!this._config.enabled) return;
        if (await this.shouldCompress(sessionId)) {
            await this.compress(sessionId);
        }
    }

    private _summarizeToolResult(msg: ITurnMessage): string {
        // 移植 Hermes 的 _make_tool_summary 逻辑
        // 识别 terminal / file_read / file_write / search 等类型
        // 生成单行信息丰富摘要
        ...
    }

    private async _generateStructuredSummary(
        middle: ITurnMessage[],
        previous?: IStructuredSummary,
        focusTopic?: string,
    ): Promise<IStructuredSummary> {
        const prompt = previous
            ? this._buildUpdatePrompt(middle, previous, focusTopic)
            : this._buildInitialPrompt(middle, focusTopic);

        // 调用 LLM 生成结构化摘要
        const response = await this._callLLM(prompt);
        return this._parseStructuredSummary(response);
    }

    ...
}
```

### 5.5 压缩触发时序

```
User 发送消息
    │
    ▼
AgentHost: SessionTurnStarted
    │
    ▼
[Agent 处理 + Tool Calls]
    │
    ▼
AgentHost: SessionTurnComplete
    │
    ▼
ContextCompressionService._maybeAutoCompress()
    │
    ├─ shouldCompress() → 检查 token 使用率
    │   ├─ < 50% → 跳过
    │   └─ ≥ 50% → 继续
    │
    ├─ 冷却检查 → 在冷却期？跳过
    │
    ├─ 反抖动检查 → 连续 2 次节省 < 10%？跳过
    │
    └─ compress()
        ├─ Stage 1: pruneToolOutputs()
        ├─ Stage 2: head protection (前 3 条)
        ├─ Stage 3: tail budget (后 ~20K tokens)
        ├─ Stage 4: _generateStructuredSummary() → LLM
        ├─ Stage 5: _persistCompression() → SessionStore
        │   ├─ insertCheckpoint()
        │   └─ 索引到 search_index (FTS5)
        └─ _onDidCompress.fire()
```

---

## 六、模块三：MemoryService（记忆管理）

### 6.1 目标

实现跨 session 的记忆管理，支持自动提取、手动记忆、上下文注入和贡献点扩展。

### 6.2 Provider 架构

```
┌─────────────────────────────────────────────────────────┐
│                    MemoryService                         │
│                   (协调 + 路由)                           │
│                                                          │
│  ┌──────────────────────┐  ┌──────────────────────────┐ │
│  │  BuiltinMemory-      │  │  ExtensionMemory-        │ │
│  │  Provider             │  │  Provider                │ │
│  │                       │  │  (贡献点扩展)             │ │
│  │  • 文件记忆 (~/.saros│  │                          │ │
│  │    /memories/)        │  │  • 自定义存储后端         │ │
│  │  • KV 键值对          │  │  • 自定义提取逻辑         │ │
│  │  • 自动重要度衰减     │  │  • 自定义注入策略         │ │
│  │  • 基于 SessionStore  │  │                          │ │
│  └──────────────────────┘  └──────────────────────────┘ │
│                                                          │
│  工具路由: _toolToProvider Map<toolName, IMemoryProvider> │
└─────────────────────────────────────────────────────────┘
```

### 6.3 接口定义

```typescript
// ═══ src/vs/platform/agentHost/common/memoryService.ts ═══

export const IMemoryService = createDecorator<IMemoryService>('memoryService');

export interface IMemoryService extends IDisposable {
    readonly _serviceBrand: undefined;

    /** 当记忆发生变化时触发 */
    readonly onDidChangeMemories: Event<IMemoryChangeEvent>;

    // ── 生命周期 ──

    /** 初始化所有 providers */
    initialize(sessionId: string): Promise<void>;

    /** Session 切换时通知所有 providers */
    onSessionSwitch(sessionId: string): Promise<void>;

    /** 关闭时清理 */
    shutdown(): Promise<void>;

    // ── 上下文注入 ──

    /**
     * 为即将发送的消息预取相关记忆。
     * 返回注入到上下文中的记忆文本。
     */
    prefetch(sessionId: string, userMessage: string): Promise<string>;

    /**
     * 构建记忆相关的系统提示片段。
     */
    buildSystemPromptBlock(): string;

    // ── Turn 同步 ──

    /**
     * Turn 完成后同步对话到记忆存储。
     * 自动提取值得记忆的内容。
     */
    syncTurn(sessionId: string, userMessage: string, assistantResponse: string): Promise<void>;

    /**
     * 为下一轮预加载记忆（异步，不阻塞当前轮）。
     */
    queuePrefetch(sessionId: string, userMessage: string): void;

    // ── 记忆 CRUD ──

    /** 写入记忆 */
    writeMemory(entry: Omit<IMemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'>): Promise<string>;

    /** 读取记忆 */
    readMemories(filter?: IMemoryFilter): Promise<IMemoryEntry[]>;

    /** 搜索记忆 */
    searchMemories(query: string, limit?: number): Promise<ISearchResult[]>;

    /** 删除记忆 */
    deleteMemory(id: string): Promise<void>;

    // ── Tool 路由 ──

    /** 获取所有 memory 相关的工具定义 */
    getToolSchemas(): IToolSchema[];

    /** 处理 LLM 调用的 memory 工具 */
    handleToolCall(toolName: string, args: Record<string, unknown>): Promise<string>;

    // ── Provider 管理 ──

    /** 注册记忆 Provider */
    registerProvider(provider: IMemoryProvider): IDisposable;

    /** 获取已注册的 providers */
    getProviders(): readonly IMemoryProvider[];
}

// ── 记忆 Provider 接口 ──

export interface IMemoryProvider {
    readonly id: string;
    readonly name: string;

    /** 初始化 */
    initialize(sessionId: string): Promise<void>;

    /** 系统提示片段 */
    systemPromptBlock(): string;

    /** 预取相关记忆 */
    prefetch(query: string): Promise<string>;

    /** 队列预取（异步） */
    queuePrefetch(query: string): void;

    /** 同步 turn 数据 */
    syncTurn(userMessage: string, assistantResponse: string): Promise<void>;

    /** 工具 schema */
    getToolSchemas(): IToolSchema[];

    /** 处理工具调用 */
    handleToolCall(name: string, args: Record<string, unknown>): Promise<string>;

    /** Session 切换 */
    onSessionSwitch(sessionId: string): Promise<void>;

    /** 压缩前回调：提供额外上下文给摘要 */
    onPreCompress?(): Promise<string>;

    /** 关闭 */
    dispose(): void;
}

// ── 事件 ──

export interface IMemoryChangeEvent {
    type: 'added' | 'updated' | 'deleted';
    memoryId: string;
    category: string;
}

// ── 工具 Schema ──

export interface IToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
```

### 6.4 内置记忆 Provider

```typescript
// ═══ src/vs/platform/agentHost/node/builtinMemoryProvider.ts ═══

export class BuiltinMemoryProvider implements IMemoryProvider {

    readonly id = 'builtin';
    readonly name = 'Built-in Memory';

    constructor(
        @IEnhancedSessionStore private readonly sessionStore: IEnhancedSessionStore,
        @ILogService private readonly logService: ILogService,
    ) {}

    // ── 系统提示 ──
    systemPromptBlock(): string {
        return [
            '## Memory',
            'You have access to a persistent memory system.',
            'Use `memory_write` to save important information for future sessions.',
            'Use `memory_search` to recall relevant past knowledge.',
            'Categories: user_preference, project_knowledge, decision, general.',
        ].join('\n');
    }

    // ── 预取 ──
    async prefetch(query: string): Promise<string> {
        const results = await this.sessionStore.searchWithRelevance(query, {
            maxResults: 5,
            sourceTypes: ['memory', 'checkpoint_overview'],
        });

        if (results.length === 0) return '';

        const lines = results.map(r =>
            `[${r.sourceType}] ${r.content.substring(0, 300)}`
        );

        return [
            '<memory-context>',
            '<!-- The following is recalled memory context, NOT new user input. -->',
            ...lines,
            '</memory-context>',
        ].join('\n');
    }

    // ── 工具定义 ──
    getToolSchemas(): IToolSchema[] {
        return [
            {
                name: 'memory_write',
                description: 'Save important information to persistent memory for future sessions.',
                parameters: {
                    type: 'object',
                    properties: {
                        content: { type: 'string', description: 'The information to remember.' },
                        category: {
                            type: 'string',
                            enum: ['user_preference', 'project_knowledge', 'decision', 'general'],
                            description: 'Category of the memory.',
                        },
                        importance: {
                            type: 'number', minimum: 0, maximum: 1,
                            description: 'Importance score (0.0 to 1.0). Default 0.5.',
                        },
                    },
                    required: ['content'],
                },
            },
            {
                name: 'memory_search',
                description: 'Search persistent memory for relevant past knowledge.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search query.' },
                        limit: { type: 'number', description: 'Max results. Default 5.' },
                        category: { type: 'string', description: 'Filter by category.' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'memory_delete',
                description: 'Delete a specific memory entry by ID.',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Memory entry ID to delete.' },
                    },
                    required: ['id'],
                },
            },
        ];
    }

    // ── 工具执行 ──
    async handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
        switch (name) {
            case 'memory_write': {
                const id = await this.sessionStore.insertMemory({
                    content: args.content as string,
                    category: (args.category as string) ?? 'general',
                    importance: (args.importance as number) ?? 0.5,
                    source: 'tool',
                    ...
                });
                return JSON.stringify({ success: true, id });
            }
            case 'memory_search': {
                const results = await this.sessionStore.searchWithRelevance(
                    args.query as string,
                    { maxResults: (args.limit as number) ?? 5, sourceTypes: ['memory'] }
                );
                return JSON.stringify({ results });
            }
            case 'memory_delete': {
                await this.sessionStore.deleteMemory(args.id as string);
                return JSON.stringify({ success: true });
            }
            default:
                return JSON.stringify({ error: `Unknown tool: ${name}` });
        }
    }

    // ── 自动提取 ──
    async syncTurn(userMessage: string, assistantResponse: string): Promise<void> {
        // 简单的启发式提取：
        // 1. 用户明确要求记住 → 提取为 user_preference
        // 2. 涉及项目架构决策 → 提取为 decision
        // 3. 工具调用产生的关键结论 → 提取为 project_knowledge
        // 详细提取逻辑在后续迭代中通过 LLM 增强
    }
}
```

### 6.5 记忆注入时序

```
User 发送消息
    │
    ▼
MemoryService.prefetch(sessionId, userMessage)
    │
    ├─ BuiltinMemoryProvider.prefetch(query)
    │   └─ sessionStore.searchWithRelevance(query)
    │       └─ FTS5 MATCH + BM25 排序
    │
    ├─ [ExtensionMemoryProvider.prefetch(query)]  (如有)
    │
    └─ 合并结果 → <memory-context> 标签
         │
         ▼
    注入到 system prompt 或 steering message
         │
         ▼
AgentHost: SessionTurnStarted
    │
    ▼
[Agent 处理，可调用 memory_write / memory_search 工具]
    │
    ▼
AgentHost: SessionTurnComplete
    │
    ▼
MemoryService.syncTurn(sessionId, userMsg, assistantResponse)
    │
    ├─ 自动提取值得记忆的内容
    ├─ sessionStore.insertMemory() + 索引到 FTS5
    └─ MemoryService.queuePrefetch() → 预加载下轮记忆
```

---

## 七、集成点与数据流

### 7.1 与 AgentHost State Protocol 的集成

```typescript
// ── 监听点 ──

// 1. Turn 完成 → 触发压缩检查 + 记忆同步
agentService.onDidSessionProgress(event => {
    if (event.kind === 'turnComplete') {
        contextCompressionService.maybeAutoCompress(event.sessionId);
        memoryService.syncTurn(event.sessionId, event.userMessage, event.response);
    }
});

// 2. Session 创建 → 初始化记忆
agentService.onDidSessionProgress(event => {
    if (event.kind === 'sessionReady') {
        memoryService.initialize(event.sessionId);
    }
});

// 3. 用户发送消息前 → 预取记忆 + 注入上下文
// 在 IAgentConnection.sendMessage 的 wrapper 中实现
async sendMessageWithMemory(session, prompt, attachments, turnId) {
    const memoryContext = await memoryService.prefetch(session.id, prompt);
    // 将 memoryContext 注入到 attachments 或 steeringMessage 中
    return agentConnection.sendMessage(session, prompt, enrichedAttachments, turnId);
}
```

### 7.2 与 SessionStore (Chronicle) 的集成

```
SessionStoreTracker (现有)              EnhancedSessionStore (增强)
    │                                       │
    ├─ insertSession() ────────────────────→│
    ├─ insertTurn() ───────────────────────→│
    ├─ insertCheckpoint() ─────────────────→│  ← ContextCompressionService 写入
    ├─ insertFile() ───────────────────────→│
    ├─ insertRef() ────────────────────────→│
    │                                       ├─ insertMemory() ← MemoryService 写入
    │                                       ├─ searchWithRelevance() ← MemoryService 查询
    │                                       └─ logCompression() ← ContextCompressionService 日志
    │
    └─ indexIntoFTS5() ────────────────────→ search_index (FTS5 虚拟表)
```

### 7.3 与 SessionDatabase (per-session) 的集成

```
SessionDatabase (现有，不修改)
    │
    ├─ turns 表 ──── 提供消息历史给 ContextCompressionService
    ├─ file_edits 表 ──── 提供文件变更记录
    └─ session_metadata 表
        ├─ 'compression.lastTimestamp' ──── 压缩状态
        ├─ 'compression.consecutiveLow' ── 反抖动计数
        └─ 'memory.lastPrefetchQuery' ──── 记忆预取状态
```

### 7.4 完整数据流图

```
┌──────────┐     ┌──────────────┐     ┌──────────────────────────┐
│  User    │────→│  ChatWidget  │────→│ SessionsManagementService │
│  Input   │     │              │     │                            │
└──────────┘     └──────────────┘     └─────────────┬──────────────┘
                                                     │
                                          ┌──────────▼──────────┐
                                          │   MemoryService      │
                                          │   .prefetch()        │
                                          └──────────┬──────────┘
                                                     │ memory context
                                          ┌──────────▼──────────┐
                                          │   AgentHost          │
                                          │   .sendMessage()     │
                                          └──────────┬──────────┘
                                                     │
                                          ┌──────────▼──────────┐
                                          │   Agent (LLM)        │
                                          │   + Tool Calls       │
                                          │   (memory_write,     │
                                          │    memory_search)    │
                                          └──────────┬──────────┘
                                                     │
                                          ┌──────────▼──────────┐
                                          │  SessionTurnComplete │
                                          └──────┬────────┬─────┘
                                                 │        │
                                    ┌────────────▼─┐  ┌───▼───────────────┐
                                    │  MemoryService│  │ ContextCompression│
                                    │  .syncTurn()  │  │ .maybeAutoCompress│
                                    └──────┬───────┘  └────────┬──────────┘
                                           │                    │
                                    ┌──────▼────────────────────▼──────────┐
                                    │       EnhancedSessionStore           │
                                    │                                      │
                                    │  memories │ checkpoints │ search_idx │
                                    └─────────────────────────────────────┘
```

---

## 八、接口定义汇总

### 8.1 服务注册

```typescript
// ═══ src/vs/platform/agentHost/common/enhancement.ts ═══

// 服务标识符
export const IContextCompressionService = createDecorator<IContextCompressionService>('contextCompressionService');
export const IMemoryService = createDecorator<IMemoryService>('memoryService');
export const IEnhancedSessionStore = createDecorator<IEnhancedSessionStore>('enhancedSessionStore');

// DI 注册 (在 workbench 初始化中)
registerSingleton(IEnhancedSessionStore, EnhancedSessionStore, InstantiationType.Delayed);
registerSingleton(IContextCompressionService, ContextCompressionService, InstantiationType.Delayed);
registerSingleton(IMemoryService, MemoryService, InstantiationType.Delayed);
```

### 8.2 配置项

```json
{
    "saros.session.compression.enabled": {
        "type": "boolean",
        "default": true,
        "description": "启用上下文自动压缩"
    },
    "saros.session.compression.thresholdPercent": {
        "type": "number",
        "default": 0.50,
        "description": "触发压缩的 token 使用率阈值"
    },
    "saros.session.compression.headProtectCount": {
        "type": "number",
        "default": 3,
        "description": "压缩时保护的头部消息数量"
    },
    "saros.session.memory.enabled": {
        "type": "boolean",
        "default": true,
        "description": "启用跨会话记忆管理"
    },
    "saros.session.memory.maxPrefetchResults": {
        "type": "number",
        "default": 5,
        "description": "每轮预取的最大记忆数量"
    },
    "saros.session.memory.autoExtract": {
        "type": "boolean",
        "default": true,
        "description": "自动从对话中提取记忆"
    }
}
```

### 8.3 贡献点（扩展可用）

```json
{
    "contributes": {
        "agentStudioMemoryProvider": {
            "id": "my-memory-provider",
            "name": "My Custom Memory",
            "description": "Custom memory provider with vector search",
            "activation": "onStartup"
        }
    }
}
```

---

## 九、数据库 Schema 迁移

### 9.1 SessionStore 迁移（版本 4）

```sql
-- Migration version 4: 添加 memories 表和 compression_log 表

CREATE TABLE IF NOT EXISTS memories (
    id            TEXT    PRIMARY KEY,
    session_id    TEXT,
    category      TEXT    NOT NULL DEFAULT 'general',
    content       TEXT    NOT NULL,
    importance    REAL    NOT NULL DEFAULT 0.5,
    access_count  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT,
    source        TEXT    NOT NULL DEFAULT 'auto'
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);

CREATE TABLE IF NOT EXISTS compression_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL,
    compressed_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    strategy        TEXT    NOT NULL,
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    turns_compressed INTEGER,
    turns_preserved  INTEGER,
    savings_percent  REAL,
    summary_preview  TEXT
);

CREATE INDEX IF NOT EXISTS idx_compression_session ON compression_log(session_id);
```

### 9.2 SessionDatabase 无需迁移

利用现有 `session_metadata` KV 表存储压缩/记忆状态元数据，无需新增 schema。

---

## 十、实现路线图

### Phase 1：基础设施（2 周）

```
Week 1:
├─ [P0] EnhancedSessionStore 实现
│   ├─ memories 表 CRUD
│   ├─ compression_log 表
│   ├─ FTS5 索引增强（memory 类型支持）
│   └─ searchWithRelevance() API
│
├─ [P0] IContextCompressionService 接口 + 骨架实现
│   └─ Stage 1: pruneToolOutputs()（无 LLM 依赖）
│
└─ [P0] IMemoryService 接口 + 骨架实现
    └─ BuiltinMemoryProvider 注册

Week 2:
├─ [P0] ContextCompressionService 完整实现
│   ├─ Stage 2-3: 头/尾保护逻辑
│   ├─ Stage 4: LLM 摘要生成（调用 Copilot LM API）
│   ├─ Stage 5: 迭代更新
│   └─ 反抖动 + 冷却机制
│
└─ [P0] AgentHost 集成
    ├─ 监听 SessionTurnComplete
    └─ 自动触发压缩检查
```

### Phase 2：记忆管理（2 周）

```
Week 3:
├─ [P0] BuiltinMemoryProvider 完整实现
│   ├─ prefetch()：FTS5 搜索 + BM25 排序
│   ├─ syncTurn()：启发式自动提取
│   ├─ memory_write / memory_search / memory_delete 工具
│   └─ 上下文注入（<memory-context> 标签）
│
└─ [P1] MemoryService 集成
    ├─ sendMessage wrapper（预取注入）
    ├─ Turn 完成后 syncTurn()
    └─ Session 切换通知

Week 4:
├─ [P1] 贡献点注册机制
│   ├─ contributes.agentStudioMemoryProvider schema
│   ├─ Extension activation 触发注册
│   └─ 多 Provider 路由
│
└─ [P1] 配置 UI
    ├─ AgentStudio Settings Tab 集成
    └─ 压缩/记忆 启用/禁用控制
```

### Phase 3：增强 & 优化（2 周）

```
Week 5:
├─ [P1] 高级搜索
│   ├─ 组合排序：BM25 + 记忆重要度加权
│   ├─ 时间衰减排序
│   └─ SessionStoreSqlTool 增强（支持 memory 查询）
│
└─ [P1] 记忆自动提取增强
    ├─ LLM 驱动的提取（识别用户偏好、决策等）
    └─ 去重 + 合并策略

Week 6:
├─ [P2] 压缩 UI 指示器
│   ├─ 状态栏显示压缩状态
│   ├─ 手动压缩命令
│   └─ 压缩历史查看
│
├─ [P2] 记忆浏览 UI
│   ├─ 记忆列表视图
│   ├─ 记忆编辑/删除
│   └─ 记忆导入/导出
│
└─ [P2] 测试 & 文档
    ├─ 单元测试
    ├─ 集成测试
    └─ 用户文档
```

### Phase 4：高级特性（后续）

```
├─ [P2] 向量搜索扩展
│   ├─ Embedding 生成
│   └─ 混合搜索（FTS5 + 向量余弦相似度）
│
├─ [P2] 记忆云同步
│   └─ CloudSessionStoreClient 扩展
│
└─ [P3] 记忆分享
    └─ 团队级记忆空间
```

---

## 十一、风险与缓解

| 风险 | 影响 | 缓解策略 |
|------|------|----------|
| 压缩摘要 LLM 调用失败 | 压缩中断 | 冷却机制（60s/600s），Stage 1 无 LLM 可独立生效 |
| FTS5 搜索性能退化 | 搜索延迟 | 限制 FTS5 索引大小，定期 VACUUM，结果限制 |
| 记忆注入污染上下文 | LLM 混淆 | `<memory-context>` 标签 + 系统注释明确标记 |
| 记忆自动提取误判 | 垃圾记忆 | 初期仅启发式提取，后续 LLM 增强 + 重要度衰减 |
| 与 Chronicle 耦合过紧 | 升级困难 | 通过 IEnhancedSessionStore 接口抽象，可替换实现 |
| SQLite 并发写入冲突 | 数据丢失 | SequencerByKey 写入序列化，WAL 模式 |
| 压缩后上下文不连贯 | LLM 行为异常 | 结构化摘要保留关键信息 + 尾部完整保护 |
| 内存开销（per-session 状态） | OOM | 懒初始化 + LRU 清理不活跃 session 状态 |

---

## 附录 A：文件清单

```
新增文件:
src/vs/platform/agentHost/common/
├── contextCompression.ts          # 压缩服务接口
├── memoryService.ts               # 记忆服务接口
└── enhancedSessionStore.ts        # 增强 SessionStore 接口

src/vs/platform/agentHost/node/
├── contextCompressionService.ts   # 压缩服务实现
├── memoryServiceImpl.ts           # 记忆服务实现
├── builtinMemoryProvider.ts       # 内置记忆 Provider
└── enhancedSessionStoreImpl.ts    # 增强 SessionStore 实现

src/vs/sessions/contrib/agentStudio/browser/views/
├── compressionStatusWidget.ts     # 压缩状态 UI
└── memoryBrowserView.ts           # 记忆浏览 UI

修改文件:
src/vs/platform/agentHost/common/agentService.ts      # 集成压缩/记忆监听
src/vs/sessions/services/sessions/browser/
    sessionsManagementService.ts                        # sendMessage wrapper
extensions/copilot/src/platform/chronicle/
    node/sessionStore.ts                                # Schema 迁移 v4
    common/sessionStore.ts                              # 接口扩展
```

## 附录 B：Hermes → TypeScript 移植映射

| Hermes (Python) | Saros (TypeScript) | 备注 |
|-----------------|---------------------|------|
| `context_compressor.py` | `contextCompressionService.ts` | 5 阶段策略完整移植 |
| `memory_manager.py` | `memoryServiceImpl.ts` | 协调器模式 |
| `MemoryProvider` ABC | `IMemoryProvider` interface | 贡献点扩展 |
| `prompt_builder.py` (记忆注入) | `MemoryService.prefetch()` | `<memory-context>` 标签 |
| `StreamingContextScrubber` | ChatWidget 输出过滤 | 防止标签泄露 |
| `SessionDB.messages` (FTS5) | `EnhancedSessionStore.search_index` | 复用 Chronicle |
| `SessionDB.summaries` | `SessionStore.checkpoints` | 结构化摘要 |
| `hermes_state.py` (压缩链) | `session_metadata` KV | 简化实现 |
| `redact_sensitive_text` | 待定 | 可对接 VSCode Secret Storage |

---

**文档版本**：v1.0
**生成时间**：2026-05-13
**作者**：AI Assistant
