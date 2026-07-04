# agentmemory 全功能对比分析与优化建议

> 分析时间：2026-07-04
> agentmemory v0.9.27 vs sarosis-agents-client v2.2.25903

---

## 一、agentmemory 架构总览

### 核心设计特点

| 维度 | 说明 |
|------|------|
| 运行时 | iii-engine Worker（WebSocket + 函数注册模式） |
| 状态存储 | 基于文件的 SQLite（每项目一个 .db 文件），通过 `StateKV` 封装 |
| MCP 接口 | 独立 MCP 服务器（47 个工具：40 内存 + 7 图谱） |
| 嵌入 | 本地（Xenova transformers / ONNX Runtime）+ 远程 Anthropic API 回退 |
| 分词 | CJK 感知（jieba/tiny-segmenter）+ 词干提取 |
| 记忆模型 | Working → Episodic → Semantic → Procedural + Lessons + Skills

### 数据流

```
Agent Hook (tool/subtask execute)
  → observe() → KV 存储 CompressedObservation
  → session_start / prompt_submit hooks
  → chat.system.transform (注入 context + instructions)

压缩管线:
  session.compacted / session.idle
  → summarize() → LLM 生成 SessionSummary
  → consolidate() → LLM 提取 Episodic/Semantic/Procedural 记忆

召回管线:
  mem::context / mem::recall
  → BM25 关键词搜索 + 向量语义搜索 + RRF 融合
  → ContextBlock 组装 + token budget 截断
  → <agentmemory-context> 标签注入

巩固管线:
  mem::reflect → LLM 反思 → 生成 Lessons + Insights
```

---

## 二、核心功能矩阵

### 2.1 记忆生命周期

| 功能 | agentmemory | sarosis | 状态 |
|------|-------------|---------|------|
| observe（原始观察记录） | ✅ KV 存储 CompressedObservation | ✅ writeMemory (fire-and-forget) | 对齐 |
| summarize（会话摘要） | ✅ LLM 生成 SessionSummary | ✅ triggerEpisodicExtraction | 已对齐 |
| consolidate（长期记忆提取） | ✅ LLM 驱动 Episodic/Semantic/Procedural | ✅ ConsolidationPipeline | 已对齐 |
| working-context（工作记忆上下文） | ✅ Core + Archival 分层 + auto-page | ✅ P12 已实现 | 已对齐 |
| pinned 记忆 | ✅ CoreMemoryEntry.pinned | ✅ P12 InternalMemoryEntry.pinned | 已对齐 |
| 版本链 | ✅ parentId + isLatest + version | ✅ parentId + isLatest + supersededBy | 已对齐 |
| 记忆去重 | ✅ fingerprintId (SHA-256) + memoryProjectCache | ✅ DedupManager + BloomFilter + P9 toolCallId | 已对齐 |
| 矛盾检测 | ✅ _detectContradiction (Jaccard) | ✅ _detectContradiction | 已对齐 |
| 保留管理 | ✅ retension 评分 (importance*recency*access) | ⚠️ STRENGTH_FLOOR + decay | 待优化: Q1 |
| 自动过期 (forgetAfter) | ✅ forgetAfter 时间戳 | ✅ InternalMemoryEntry.forgetAfter | 已对齐 |
| 记忆关系 | ✅ relations (SURPASSED/EXTENDS/DERIVES_FROM/REVISES 等) | ✅ _relations Map | 已对齐 |

### 2.2 搜索召回

| 功能 | agentmemory | sarosis | 状态 |
|------|-------------|---------|------|
| BM25 关键词搜索 | ✅ SearchIndex + sortedTerms + prefix | ✅ BM25Index + sortedTerms + prefix | 已对齐 |
| 同义词扩展 | ✅ weighted 0.7 | ✅ P10 weight 0.7 | 已对齐 |
| 向量语义搜索 | ✅ embedViaTransformers / Anthropic API | ✅ embedSync (trigram 回退) + Xenova 可选 | 基本对齐 |
| RRF 融合 | ✅ RRF + diversity | ✅ RRF + diversification | 已对齐 |
| 混合搜索 (BM25+Vector) | ✅ mem::recall | ✅ _hybridSearch + RRF | 已对齐 |
| 跨会话搜索 | ✅ 过滤 + recency 排序 | ✅ searchAllAgents | 已对齐 |
| 搜索结果缓存 | ❌ | ✅ _searchCache LRU 100/5min | sarosis 领先 |
| 搜索索引持久化 | ✅ sharded JSON 到 KV | ✅ JSON 文件 + vector-index.json | 已对齐 |

### 2.3 Context 组装

| 功能 | agentmemory | sarosis | 状态 |
|------|-------------|---------|------|
| ContextBlock 抽象 | ✅ type/tokens/recency/sourceIds | ✅ ContextBlock 相同字段 | 已对齐 |
| token budget 贪心截断 | ✅ 固定 budget | ✅ selectWithBudgetAndPriority | 已对齐 |
| 固定块保护 | ❌ 无 priority 分层 | ✅ priority=0 不受 budget 限制 | sarosis 领先 |
| context 结果缓存 | ❌ | ✅ P3 fingerprint + 60s TTL | sarosis 领先 |
| 会话级 context 缓存 | ✅ startContextCache (一次性) | ✅ P6 _sessionContextCache | 已对齐 |
| 注入幂等 | ✅ contextInjectedSessions | ✅ P7 _injectedSessions | 已对齐 |
| 文件路径暂存 enrich | ✅ stashedFiles | ✅ P8 _stashedFiles | 已对齐 |
| Project Profile | ✅ profile concepts/files/conventions/errors | ❌ | 待优化: Q2 |
| 可编辑 Slots | ✅ mem:slots (labeled memories) | ⚠️ _slots（部分） | 待优化: Q3 |
| 访问追踪 | ✅ recordAccessBatch (批量写回) | ✅ P11 write-through on read | 已对齐 |
| 三因子评分 | ✅ importance*0.5 + recency*0.3 + access*0.2 | ✅ P13 已实现 | 已对齐 |

### 2.4 学习与巩固

| 功能 | agentmemory | sarosis | 状态 |
|------|-------------|---------|------|
| Lessons（经验教训） | ✅ LessonExtractor + decay + reinforce | ✅ LessonExtractor 已对齐 | 已对齐 |
| Skills（可复用技能） | ✅ SkillExtractor + fingerprint + SKILL.md | ✅ SkillExtractor 已对齐 | 已对齐 |
| Routines（可重复工作流） | ✅ mem:routines + routine-runs | ⚠️ _routines（部分） | 待优化: Q4 |
| 行动链结晶 | ✅ mem:crystals (action chain summary) | ❌ | 待优化: Q5 |
| 反思 (reflect) | ✅ mem::reflect → LLM 返回 insights | ⚠️ _reflector（部分） | 待优化: Q6 |

### 2.5 知识图谱

| 功能 | agentmemory | sarosis | 状态 |
|------|-------------|---------|------|
| 图谱节点/边 | ✅ mem:graph:nodes/edges | ✅ CodebaseGraph (代码图谱) | 各有侧重 |
| 社区检测 (Leiden) | ✅ community 字段 | ✅ 已实现 | 已对齐 |
| 语义搜索 | ✅ 6-signal 融合 | ✅ _runSemanticSearch | 已对齐 |
| 路径追踪 | ✅ trace_path (Dijkstra/BFS) | ✅ tracePath | 已对齐 |
| 图谱快照 | ✅ mem:graph:snapshot (pre-computed) | ❌ | 待优化: Q7 |
| 名称索引 | ✅ mem:graph:name-index | ❌ | 低优先级 |

### 2.6 高级功能

| 功能 | agentmemory | sarosis | 状态 |
|------|-------------|---------|------|
| Action/Task 管理 | ✅ mem:actions + action-edges + leases | ❌ | 待优化: Q8 |
| 批准/Review 门控 | ✅ mem:checkpoints | ❌ | N/A（sarosis 用不同机制） |
| 分布式 Mesh 同步 | ✅ mem:mesh | ✅ MeshCoordinator（部分） | 待优化: Q9 |
| 多维标签 (Facets) | ✅ mem:facets | ❌ | 待优化: Q10 |
| 审计日志 | ✅ mem:audit (完整的操作记录) | ✅ _audit (简化版) | 基本对齐 |
| 健康监控 | ✅ HealthMonitor | ✅ HealthMonitor | 已对齐 |
| 速率限制 | ❌ | ✅ RateLimiter | sarosis 领先 |
| 检查点/回滚 | ✅ mem:checkpoints | ❌ | 待优化: Q11 |
| 图片引用/嵌入 | ✅ mem:image-refs + mem:image-embeddings | ⚠️ _imageRefs（部分） | 待优化: Q12 |
| 最近搜索诊断 | ✅ mem:recent-searches | ✅ _recentSearches | 已对齐 |

---

## 三、优化建议

### Q1 保留评分增强 (高优先级)

**现状**: sarosis 使用 `STRENGTH_FLOOR` + decay，agentmemory 使用 `importance * recencyScore * accessScore * 0.1`

**建议**: 在 `MemoryDecay.decay()` 中引入三因子保留评分，低于阈值时降级而非删除

```typescript
retentionScore = (importance/10) * recencyScore * (1 + log2(accessCount + 1) * 0.1) * 0.1
if (retentionScore < RETENTION_FLOOR) → archive to shortTerm
```

### Q2 Project Profile (中优先级)

**现状**: agentmemory 维护项目级 Profile（topConcepts, topFiles, conventions, commonErrors），在 context 中注入。

**建议**: 在 `memoryProvider.ts` 中加入 `_projectProfile`，从 LLM 提取结果中自动维护，在 `loadContext` 中注入。

### Q3 可编辑 Slots (中优先级)

**现状**: sarosis 有 `_slots.buildSystemPrompt()`，但不支持通过 memory_remember 工具编辑。

**建议**: 添加 `memory_remember` 工具的 `slot_id` 参数，支持 LLM 直接编辑记忆槽。

### Q4 Routines 完善 (中优先级)

**现状**: sarosis 有 `_routines` 模块但功能不完整。

**建议**: 对齐 agentmemory mem::routines — 支持 register/run/list 流程，routineRuns 跟踪。

### Q5 行动链结晶 (低优先级)

**现状**: agentmemory 的 processCrystallisation 将已完成行动链压缩为长期摘要。

**建议**: 当 tool call chain 完成后，异步触发 LLM 总结并写入 longTerm。

### Q6 Reflect 反思增强 (中优先级)

**现状**: sarosis 有 `_reflector.reflect()`，agentmemory 有 `mem::reflect` 返回结构化 insights。

**建议**: 增强 reflector 返回跨概念簇的 insights（agentmemory 的 generateInsights 模式）。

### Q7 图谱快照 (低优先级)

**现状**: agentmemory 预计算 top 500 节点快照用于快速检测变化。

**建议**: 在 CodebaseGraph 索引完成后预计算 `graph:snapshot` 供 detect_changes 使用。

### Q8 Action/Task 管理 (低优先级)

**现状**: agentmemory 有完整的 action-edges + leases + sentinels 系统。

**建议**: 如果 sarosis 需要复杂任务编排，可考虑对齐 mem::actions 模型。

### Q9 Mesh 同步完善 (低优先级)

**现状**: sarosis 有 `MeshCoordinator` 基础实现，agentmemory 有更完整的 peer discovery。

**建议**: 增强 MeshCoordinator 的 heartbeat + peer discovery 机制。

### Q10 多维标签 (低优先级)

**现状**: agentmemory 的 FacetManager 支持多维度标注（category, language, priority, status 等）。

**建议**: 在 writeMemory 时自动推断标签维度，提升搜索过滤能力。

### Q11 检查点系统 (N/A)

agentmemory 的 checkpoints 系统为 OpenCode 特定功能，sarosis 使用不同的 session 管理机制，无需对齐。

### Q12 图片嵌入 (N/A)

agentmemory 的图片引用/嵌入用于多模态记忆，sarosis 目前不需要。

---

## 四、对比总结

### agentmemory 领先项（需对齐）

| 优先级 | 功能 | 代码量估计 |
|--------|------|------------|
| Q1 | 保留评分（importance*recency*access） | ~30行 |
| Q2 | Project Profile 自动维护 | ~80行 |
| Q3 | 可编辑 Slots | ~50行 |
| Q4 | Routines 完善 | ~100行 |
| Q6 | Reflect 增强 | ~40行 |
| Q5 | 行动链结晶 | ~60行 |
| Q7 | 图谱快照预计算 | ~30行 |
| Q8 | Action 管理 | ~~200行（可选） |

### sarosis 领先项（agentmemory 无）

| 功能 | 说明 |
|------|------|
| LRU 搜索缓存 | `_searchCache` 100条5min，agentmemory 无缓存 |
| 跨请求 context 缓存 | `_contextCache` fingerprint + 60s TTL |
| Anthropic cache_control | 消息级 KV cache 标注 |
| 冻结快照 | 会话内不刷新记忆注入 |
| anti-thrashing | 压缩抗抖动 + 窗口重载保护 |
| ContextBlock priority | 固定块（priority=0）不受 budget 截断 |
| RateLimiter | 请求速率限制 |
| 代码图谱 | CodebaseGraph 22-pass pipeline（agentmemory 无） |
