# Saros Memory System — 9 大模块详细使用指南

> 本文详细介绍 agentmemory 扩展中 9 个核心模块的原理与使用方法

---

## 1. 记忆 (Memory) — 4-Tier 记忆层级

**源文件**: `extensions/agentmemory-memory/src/memoryProvider.ts`

### 原理
四级分层记忆模型，对齐 agentmemory 的 Working → Episodic → Semantic → Procedural：

| 层级 | 类型 | 写入方式 | 检索 |
|------|------|----------|------|
| **Working** | 短期 | 每轮 fire-and-forget | 完整上下文 |
| **Episodic** | 情景 | L1 自动提取（每 3 轮） | BM25+Vector+RRF |
| **Semantic** | 语义 | LLM 跨会话固化 | 三因子评分 |
| **Procedural** | 程序 | XML 提取 | 步骤依赖图 |

### 使用

```typescript
// 写入记忆
await memProvider.writeMemory(agentId, {
  type: 'working',  // working | episodic | semantic | procedural
  content: 'User prefers TypeScript over JavaScript',
  metadata: { source: 'user_input', toolCallId: 'tc-123' }
});

// 加载上下文
const ctx = await memProvider.loadContext(agentId, sessionId, query, {
  scope: 'agent',  // agent | global
});
```

### 缓存层级
- **P3 跨请求结果缓存**: 60s TTL + fingerprint
- **P6 SessionContextCache 复合键**: `agentId::sessionId`
- **P11 Write-through on read**: 读取时递增 accessCount
- **P12 Core/Archival 分层**: pinned 优先 + auto-page 降级

---

## 2. 槽位 (Slots) — 可编辑固定记忆

**源文件**: `extensions/agentmemory-memory/src/slots.ts`

### 原理
8 个固定槽位（`persona`, `user_preferences`, `project_context`, `tool_guidelines`, `guidance`, `pending_items`, `session_patterns`, `self_notes`），每个槽位有 sizeLimit（500~2000 字符），可设置 `pinned` 标志。

### 使用

```typescript
const slots = memProvider._slots;

// 设置槽位内容
slots.set(agentId, 'persona', 'You are a helpful coding assistant');
slots.append(agentId, 'user_preferences', 'use tabs over spaces');

// Q3 运行时固定
slots.pin(agentId, 'project_context', true);

// 构建完整上下文
const ctx = slots.buildContext(agentId);
// 输出: pinned 优先 + unpinned 其后
```

### 内置槽位大小限制
| 槽位 | sizeLimit | 默认 pinned |
|------|-----------|-------------|
| persona | 500 | true |
| user_preferences | 1000 | true |
| project_context | 2000 | true |
| tool_guidelines | 2000 | true |
| guidance | 1500 | true |
| pending_items | 1000 | false |
| session_patterns | 1000 | false |
| self_notes | 1500 | false |

---

## 3. 教训 (Lessons) — 经验沉淀与衰减

**源文件**: `extensions/agentmemory-memory/src/lessons.ts`

### 原理
从对话中自动提取经验教训（"should/must/always" 模式 + 错误模式），支持强化、衰减、软删除。

- **LESSON_DECAY_DAYS = 60**: 每 60 天衰减一次
- **LESSON_DECAY_FACTOR = 0.95**: 衰减系数
- **LESSON_MIN_CONFIDENCE = 0.2**: 低于阈值自动清理
- **24h 节流**: 同一 agent 同一窗口不重复提取

### 使用

```typescript
const le = memProvider._lessons;

// 从对话中提取
const newLessons = le.extract(agentId, [
  { id: 'e1', content: 'You should always use transactions in DB writes', metadata: {}, timestamp: Date.now() }
]);

// 强化（每次使用后调用）
le.reinforce(agentId, lessonId);

// 软删除
le.delete(agentId, lessonId);

// 获取 Top N
const top = le.getTopLessons(agentId, 5);
// 按 confidence 排序
```

### 衰减公式
```
confidence(t) = max(MIN, initialConfidence * decayRate^periods)
periods = floor((now - lastDecayedAt) / DECAY_DAYS)
```

---

## 4. 固化 (Consolidation) — 4-Tier 跨层提取

**源文件**: `extensions/agentmemory-memory/src/consolidation.ts`

### 原理
LLM 驱动的 4-Tier 提取管道，从 Working memory 中逐层提取：

```
Working → (threshold 触发) → Episodic
  → (continues) → Semantic (LLM 跨会话事实)
  → (continues) → Procedural (LLM 提取步骤+触发)
```

每个层级支持 XML 解析 (`<facts>`, `<procedures>`) + 规则回退。

### 使用

```typescript
const pipe = new ConsolidationPipeline();

// 注入 LLM summarizer
pipe.setSummarizer(async (prompt) => {
  // 调用 LLM 并返回 XML 响应
  return '<facts><fact>...</fact></facts>';
});

// 触发 Episodic 提取
const result = await pipe.consolidateEpisodic(agentId, workingEntries);

// 触发 Semantic（需要 episodic 已存在）
await pipe.consolidateSemantic(agentId);

// 触发 Procedural
await pipe.consolidateProcedural(agentId);

// 查询
const episodic = pipe.getEpisodic(agentId);
const semantic = pipe.getSemantic(agentId);
const procedural = pipe.getProcedural(agentId);
```

### 触发阈值
- **EPISODIC_THRESHOLD = 3**: 至少 3 轮对话后触发
- **SEMANTIC_MIN_EPISODIC = 5**: 至少 5 条 episodic
- **PROCEDURAL_MIN_SEMANTIC = 3**: 至少 3 条 semantic

---

## 5. 审计 (Audit) — 全量操作日志

**源文件**: `extensions/agentmemory-memory/src/auditLog.ts`

### 原理
记录所有记忆操作（write/search/delete/decay/sweep/reinforce/consolidate 等）用于诊断和合规。

### AuditOperations
- `write` / `search` / `delete` / `decay` / `sweep`
- `reinforce` / `consolidate` / `session_start` / `session_end`
- `contradiction` / `flush` / `dedup_skip` / `retention` / `cascade`
- `skill_extract` / `cache_hit` (P3 新增)

### 使用

```typescript
const audit = memProvider._audit;

// 自动调用（写入时）
audit.record('write', agentId, [entry.id], {
  contentLength: content.length,
  source: 'l1_auto_extraction',
});

// 查询摘要
const summary = audit.getSummary();
// { write: 42, search: 15, cache_hit: 8, dedup_skip: 3, ... }
```

---

## 6. 钩子 (Hooks) — 生命周期事件订阅

**源文件**: `extensions/agentmemory-memory/src/hooks.ts`

### 原理
事件驱动的钩子系统，支持 `session_start`, `session_end`, `prompt_submit`, `subtask`, `tool_call` 等。

### 使用

```typescript
const hooks = memProvider._hooks;

// 触发同步事件
hooks.trigger('session_start', {
  agentId, sessionId, timestamp: Date.now(),
});

// 注册处理器
hooks.register('session_end', async (ctx) => {
  // 清理资源
});

// 批量触发并收集结果
const result = await hooks.triggerAndCollect('prompt_submit', {
  agentId, sessionId, userMessage: '...',
});
```

---

## 7. 提交 (Commits) — 记忆与代码关联

**源文件**: `extensions/agentmemory-memory/src/commits.ts`

### 原理
将记忆条目与 Git 提交关联，记录每条记忆的"作者"和"代码变更上下文"。

### 使用

```typescript
const commits = memProvider._commits;

// 关联提交
commits.link(agentId, memoryId, {
  commitHash: 'abc123',
  filePath: 'src/memoryProvider.ts',
  diffSummary: 'Added P12 auto-page mechanism',
});

// 查询记忆的提交历史
const history = commits.getHistory(memoryId);
```

---

## 8. 报告 (Report) — 记忆健康度报告

**源文件**: `extensions/agentmemory-memory/src/report.ts`

### 原理
生成 Agent 记忆系统健康度报告，包括记忆分布、衰减情况、Top 概念、Top 教训等。

### 使用

```typescript
const report = memProvider.generateReport(agentId, {
  includeRaw: false,  // 是否包含原始条目
  maxEntries: 100,
});

// 输出格式
{
  agentId: 'agent-1',
  timestamp: 1234567890,
  totalMemories: 142,
  byType: { working: 30, episodic: 80, semantic: 20, procedural: 12 },
  avgStrength: 0.68,
  topConcepts: [{ concept: 'TypeScript', frequency: 45 }, ...],
  topLessons: [...],
  recentActivity: [...],
}
```

---

## 9. 技能 (Skills) — 可复用知识沉淀

**源文件**: `extensions/agentmemory-memory/src/skillExtract.ts`

### 原理
从重复工作流中提取可复用的技能（Skill），生成 SKILL.md 文件保存到 `~/.saros/skills/<slug>/SKILL.md`。

### 使用

```typescript
const se = memProvider._skillExtractor;

// 从会话中提取
const skill = se.extract({
  sessionId: '...',
  agentId: '...',
  observations: [
    { content: 'Step 1: read file', timestamp: ... },
    { content: 'Step 2: parse config', timestamp: ... },
  ],
  trigger: 'config-update',
});

// 强化（同一指纹的技能被多次使用时）
se.reinforce(skillId);

// 标记为已写入
se.markWritten(skillId);

// 搜索
const matches = se.search('parse config file', { minConfidence: 0.5 });

// 获取统计
const stats = se.getStats();
// { total: 25, written: 20, avgConfidence: 0.72, topSkills: [...] }
```

### SKILL.md 生成

```typescript
const md = generateSkillMd(skill);
// 输出 frontmatter + markdown body
// ---
// title: "修复 TypeScript 编译错误"
// slug: "fix-typescript-compile-error"
// confidence: 0.9
// ---
//
// ## Steps
// 1. 运行 tsc --noEmit 定位错误
// 2. 检查导入路径和类型定义
// ...
```

---

## 完整使用流程示例

```typescript
// 1. 启动 Memory Provider
const memProvider = new MemoryProvider(config);
await memProvider.initialize();

// 2. 启动 Session
const ctx = await memProvider.loadContext(agentId, sessionId, query, options);

// 3. 写入 Working
await memProvider.writeMemory(agentId, {
  type: 'working',
  content: userMessage,
  metadata: { role: 'user' }
});

// 4. 自动触发 L1 提取（每 3 轮）
// (由 memoryProvider 内部计时器管理)

// 5. 固化
await consolidation.consolidateEpisodic(agentId, workingEntries);

// 6. 教训提取
lessons.extract(agentId, [...recentEntries]);

// 7. 报告生成
const report = memProvider.generateReport(agentId);

// 8. Session 结束
const summary = memProvider._endSession(agentId);
```
