# agentmemory 核心功能落地对比分析

> 对比 `G:\CustomWorkspaces\AIProjects\agentmemory`（上游开源项目 v0.9.16）与本项目 `extensions/agentmemory-memory/`（IDE 内进程式移植版）的核心功能落地情况。

---

## 一、架构差异（根本性）

| 维度 | agentmemory（上游） | 本项目（vssaros-agents-client） | 说明 |
|------|---------------------|-------------------------------|------|
| **运行形态** | 独立服务器进程（iii-engine Worker） | IDE 扩展进程内（in-process） | 本项目无需启动外部服务 |
| **引擎依赖** | iii-sdk（WebSocket → iii-engine :49134） | 无外部引擎，全部算法在进程内执行 | 本项目自包含 |
| **状态存储** | SQLite via iii-engine StateModule | JSONL 文件（host.mjs 文件服务 :3111） | 本项目用轻量文件持久化 |
| **API 暴露** | 128 REST 端点 + 53 MCP 工具 + iii 函数 | IDE 扩展 API（`IMemoryProvider` 接口） | 本项目通过 `registerMemoryProvider` 注入 |
| **LLM 调用** | 8 种 Provider（Anthropic/OpenAI/OpenRouter/MiniMax/Gemini/AgentSDK/Local/Noop） | NoopProvider + IDE 自带 LLM（AgentOS 驱动） | 本项目复用 IDE 的模型调用链 |
| **Embedding** | 7 种 Provider（Local/OpenAI/Gemini/Cohere/Voyage/OpenRouter/CLIP） | 仅 Local（@xenova/transformers） | 本项目仅本地嵌入 |
| **观测性** | OTEL traces/metrics/logs（iii-observability） | metricsCollector.ts + IDE 日志 | 本项目无 OTEL 导出 |
| **部署** | Docker/Fly.io/Railway/Render/Coolify | 随 IDE 安装 | 不需要独立部署 |

**结论**：本项目是 agentmemory 的 **进程内移植版**，将服务器架构适配为 IDE 扩展架构。所有核心算法逻辑已移植，服务器外壳（REST/MCP/CLI/Viewer/iii-engine）被 IDE 原生能力替代。

---

## 二、核心功能逐项对比

### 2.1 记忆管线（Memory Pipeline）— ✅ 完整落地

| 管线阶段 | agentmemory | 本项目 | 状态 |
|----------|-------------|--------|------|
| Observe（观察捕获） | `functions/observe.ts` | `memoryProvider.ts` `_writeMemoryInner` + `workingMemory.ts` | ✅ |
| SHA-256 去重（5min 窗口） | `functions/dedup.ts` | `dedup.ts` `DedupManager` | ✅ |
| 隐私过滤（strip secrets） | `functions/privacy.ts` | `privacyFilter.ts` `stripPrivateData` | ✅ |
| 存储（raw observation） | iii KV `kv.set` | JSONL 文件 `writeFile` | ✅ |
| 压缩（LLM → 结构化） | `functions/compress.ts` + `compress-synthetic.ts` | `compressor.ts` `compress` + `compressSynthetic` | ✅ |
| 向量嵌入 | `providers/embedding/*` | `vectorIndex.ts` `embed`（xenova） | ✅ |
| 索引（BM25 + Vector） | `state/search-index.ts` + `state/vector-index.ts` | `bm25Index.ts` + `vectorIndex.ts` | ✅ |

### 2.2 四层记忆固化（4-Tier Consolidation）— ✅ 完整落地

| 层级 | agentmemory | 本项目 | 状态 |
|------|-------------|--------|------|
| **Working**（工作记忆） | `functions/working-memory.ts` | `workingMemory.ts` + `memoryProvider.ts` short-term | ✅ |
| **Episodic**（情景记忆） | `functions/consolidate.ts` | `consolidation.ts` `ConsolidationPipeline` | ✅ |
| **Semantic**（语义记忆） | `functions/consolidate.ts` | `consolidation.ts` `SemanticMemory` | ✅ |
| **Procedural**（程序记忆） | `functions/consolidate.ts` | `consolidation.ts` `ProceduralMemory` | ✅ |
| 固化管线调度 | `functions/consolidation-pipeline.ts` | `consolidation.ts` + `memoryProvider.ts` | ✅ |
| Ebbinghaus 衰减 | `functions/retention.ts` + `functions/evict.ts` | `memoryProvider.ts` `applyDecay` + `retention.ts` + `evict.ts` | ✅ |
| 矛盾检测 | `functions/auto-forget.ts` | `memoryProvider.ts` `autoForget` | ✅ |
| 版本链（supersede） | `types.ts` `supersededBy` | `memoryProvider.ts` `parentId`/`isLatest`/`supersededBy` | ✅ |
| TTL 自动遗忘 | `functions/auto-forget.ts` | `memoryProvider.ts` `setForgetAfter` + `autoForget` | ✅ |

### 2.3 三流混合检索（Triple-Stream Search）— ✅ 完整落地

| 检索流 | agentmemory | 本项目 | 状态 |
|--------|-------------|--------|------|
| **BM25**（关键词匹配） | `state/search-index.ts` + `state/stemmer.ts` + `state/synonyms.ts` | `bm25Index.ts` + `stemmer.ts` + `cjkSegmenter.ts` | ⚠️ 缺 synonyms |
| **Vector**（向量相似度） | `state/vector-index.ts` | `vectorIndex.ts`（xenova all-MiniLM-L6-v2） | ✅ |
| **Graph**（知识图谱遍历） | `functions/graph.ts` + `functions/graph-retrieval.ts` | `knowledgeGraph.ts` `KnowledgeGraph` | ✅ |
| **RRF 融合**（k=60） | `state/hybrid-search.ts` | `rrf.ts` `RRFFusion` + `smartSearch.ts` | ✅ |
| **Reranker** | `state/reranker.ts` | `reranker.ts` `rerank`/`rerankSimple` | ✅ |
| **会话多样化**（max 3/session） | `state/hybrid-search.ts` | `smartSearch.ts` `SmartSearchOptions` | ✅ |
| **查询扩展** | `functions/query-expansion.ts` | `queryExpansion.ts` `expandQuery` | ✅ |
| **模糊搜索** | — | `fuzzySearch.ts` `FuzzySearcher` | ✅ 本项目额外增加 |
| **搜索缓存** | — | `searchCache.ts` `SearchCache` | ✅ 本项目额外增加 |
| **同义词扩展** | `state/synonyms.ts` | ❌ 未移植 | ⚠️ 缺失 |

### 2.4 Hook 系统（生命周期钩子）— ⚠️ 部分落地（8/12）

| Hook | agentmemory | 本项目 | 状态 |
|------|-------------|--------|------|
| `SessionStart` | `hooks/session-start.ts` | `hooks.ts` `createSessionStartHook` + `agentOSService.ts` | ✅ |
| `UserPromptSubmit` | `hooks/prompt-submit.ts` | ❌ 未实现独立 hook | ⚠️ 缺失 |
| `PreToolUse` | `hooks/pre-tool-use.ts` | ❌ 未实现独立 hook | ⚠️ 缺失 |
| `PostToolUse` | `hooks/post-tool-use.ts` | `hooks.ts` `createPostToolUseHook` + `agentOSService.ts` | ✅ |
| `PostToolUseFailure` | `hooks/post-tool-failure.ts` | `hooks.ts` `createPostToolFailureHook` | ✅ |
| `PreCompact` | `hooks/pre-compact.ts` | `preCompactInjector.ts` `PreCompactInjector` + `contextManager.ts` | ✅ |
| `SubagentStart` | `hooks/subagent-start.ts` | `agentOSService.ts` trigger point | ✅ |
| `SubagentStop` | `hooks/subagent-stop.ts` | `agentOSService.ts` trigger point | ✅ |
| `Stop` | `hooks/stop.ts` | `agentOSService.ts` trigger point | ✅ |
| `SessionEnd` | `hooks/session-end.ts` | `agentOSService.ts` trigger point | ✅ |
| `Notification` | `hooks/notification.ts` | ❌ 未实现 | ⚠️ 缺失 |
| `TaskCompleted` | `hooks/task-completed.ts` | `hooks.ts` `createTaskCompletedHook` | ✅ |
| `PostCommit` | `hooks/post-commit.ts` | `postCommitCapture.ts` `PostCommitCapture` | ✅ |
| `SDK Guard` | `hooks/sdk-guard.ts` | ❌ 不适用（无 iii-sdk） | N/A |

**已落地：8/12**（SessionStart, PostToolUse, PostToolUseFailure, PreCompact, SubagentStart/Stop, Stop, SessionEnd, TaskCompleted, PostCommit）

### 2.5 编排层（Orchestration）— ✅ 完整落地

| 编排原语 | agentmemory | 本项目 | 状态 |
|----------|-------------|--------|------|
| Actions（工作项+依赖） | `functions/actions.ts` | `actions.ts` `ActionManager` | ✅ |
| Frontier（优先级队列） | `functions/frontier.ts` | `frontier.ts` `FrontierDetector` | ✅ |
| Leases（独占租约） | `functions/leases.ts` | `leases.ts` `LeaseManager` | ✅ |
| Routines（工作流模板） | `functions/routines.ts` | `routines.ts` `RoutineManager` | ✅ |
| Signals（Agent 间消息） | `functions/signals.ts` | `signals.ts` `SignalHub` | ✅ |
| Checkpoints（外部条件门） | `functions/checkpoints.ts` | `checkpoints.ts` `CheckpointManager` | ✅ |
| Flow Compress（流程压缩） | `functions/flow-compress.ts` | `flowCompress.ts` `FlowCompressor` | ✅ |
| Mesh（P2P 同步） | `functions/mesh.ts` | `meshCoord.ts` `MeshCoordinator` | ✅ |
| Branch Aware（分支感知） | `functions/branch-aware.ts` | `branchAware.ts` `BranchAwareManager` | ✅ |
| Sentinels（事件守望者） | `functions/sentinels.ts` | `sentinels.ts` `SentinelManager` | ✅ |
| Sketches（临时行动图） | `functions/sketches.ts` | ❌ 未独立实现 | ⚠️ 缺失 |
| Crystallize（压缩行动链） | `functions/crystallize.ts` | `crystallize.ts` `CrystallizeManager` | ✅ |
| Diagnostics（健康检查） | `functions/diagnostics.ts` | `diagnostics.ts` `Diagnostics` | ✅ |
| Facets（维度标签） | `functions/facets.ts` | `facets.ts` `FacetManager` | ✅ |
| Cascade（级联操作） | `functions/cascade.ts` | `cascade.ts` `CascadeManager` | ✅ |

### 2.6 高级检索（v0.6 Advanced Retrieval）— ✅ 完整落地

| 检索能力 | agentmemory | 本项目 | 状态 |
|----------|-------------|--------|------|
| Sliding Window | `functions/sliding-window.ts` | `slidingWindow.ts` `SlidingWindow` | ✅ |
| Query Expansion | `functions/query-expansion.ts` | `queryExpansion.ts` `expandQuery` | ✅ |
| Temporal Graph | `functions/temporal-graph.ts` | `temporalGraph.ts` `TemporalGraph` | ✅ |
| Retention Scoring | `functions/retention.ts` | `retention.ts` `RetentionScorer` | ✅ |
| Access Tracker | `functions/access-tracker.ts` | `accessTracker.ts` `AccessTracker` | ✅ |
| Recent Searches | `functions/recent-searches-sweep.ts` | `recentSearches.ts` `RecentSearchesManager` | ✅ |
| Unified Scorer | — | `unifiedScorer.ts` `UnifiedScorer` | ✅ 本项目额外增加 |
| Bloom Filter | — | `bloomFilter.ts` `BloomFilter` + `HyperLogLog` | ✅ 本项目额外增加 |

### 2.7 团队与治理（Team & Governance）— ✅ 完整落地

| 能力 | agentmemory | 本项目 | 状态 |
|------|-------------|--------|------|
| Team Memory（共享+私有） | `functions/team.ts` | `teamMemory.ts` `TeamMemoryManager` | ✅ |
| Governance（审计删除） | `functions/governance.ts` | `governance.ts` `GovernanceManager` | ✅ |
| Audit Trail | `functions/audit.ts` | `auditLog.ts` `AuditLog` | ✅ |
| Provenance（溯源链） | `functions/verify.ts` | `provenance.ts` + `verify.ts` `MemoryVerifier` | ✅ |
| Export/Import | `functions/export-import.ts` | `exportImport.ts` `ExportImportManager` | ✅ |
| Snapshot（Git 版本） | `functions/snapshot.ts` | `snapshots.ts` `SnapshotManager` | ✅ |
| Migration | `functions/migrate.ts` | `migrate.ts` `MigrationManager` | ✅ |
| Vector Index Migration | `functions/migrate-vector-index.ts` | `migrateVectorIndex.ts` `VectorIndexMigrator` | ✅ |

### 2.8 LLM/Embedding Provider — ⚠️ 仅 Noop + Local

| Provider 类型 | agentmemory | 本项目 | 状态 |
|---------------|-------------|--------|------|
| **LLM: Noop** | `providers/noop.ts` | `noopProvider.ts` `NoopProvider` | ✅ |
| **LLM: Anthropic** | `providers/anthropic.ts` | ❌ 未移植 | ⚠️ 用 IDE AgentOS 替代 |
| **LLM: OpenAI** | `providers/openai.ts` | ❌ 未移植 | ⚠️ 用 IDE AgentOS 替代 |
| **LLM: OpenRouter** | `providers/openrouter.ts` | ❌ 未移植 | ⚠️ 用 IDE AgentOS 替代 |
| **LLM: MiniMax** | `providers/minimax.ts` | ❌ 未移植 | ⚠️ 用 IDE AgentOS 替代 |
| **LLM: Agent SDK** | `providers/agent-sdk.ts` | ❌ 不适用 | N/A |
| **LLM: Circuit Breaker** | `providers/circuit-breaker.ts` | `circuitBreaker.ts` `CircuitBreaker` | ✅ |
| **LLM: Fallback Chain** | `providers/fallback-chain.ts` | `fallbackChain.ts` `FallbackChain` | ✅ |
| **LLM: Resilient** | `providers/resilient.ts` | `resilientProvider.ts` `ResilientProvider` | ✅ |
| **Embedding: Local (xenova)** | `providers/embedding/local.ts` | `vectorIndex.ts` `embed`（xenova） | ✅ |
| **Embedding: OpenAI** | `providers/embedding/openai.ts` | ❌ 未移植 | ⚠️ 缺失 |
| **Embedding: Gemini** | `providers/embedding/gemini.ts` | ❌ 未移植 | ⚠️ 缺失 |
| **Embedding: Cohere** | `providers/embedding/cohere.ts` | ❌ 未移植 | ⚠️ 缺失 |
| **Embedding: Voyage** | `providers/embedding/voyage.ts` | ❌ 未移植 | ⚠️ 缺失 |
| **Embedding: OpenRouter** | `providers/embedding/openrouter.ts` | ❌ 未移植 | ⚠️ 缺失 |
| **Embedding: CLIP (image)** | `providers/embedding/clip.ts` | ❌ 未移植 | ⚠️ 缺失 |
| **Image Embedding** | `providers/embedding/clip.ts` | `visionSearch.ts`（仅搜索逻辑，无 CLIP 嵌入） | ⚠️ 部分 |

### 2.9 状态管理（State）— ✅ 基本完整

| 状态模块 | agentmemory | 本项目 | 状态 |
|----------|-------------|--------|------|
| KV Store | `state/kv.ts`（iii-engine） | JSONL 文件（host.mjs） | ✅ 替代实现 |
| Schema | `state/schema.ts` | 内联在 `memoryProvider.ts` | ✅ |
| Search Index (BM25) | `state/search-index.ts` | `bm25Index.ts` `BM25Index` | ✅ |
| Vector Index | `state/vector-index.ts` | `vectorIndex.ts` `VectorIndex` | ✅ |
| Hybrid Search | `state/hybrid-search.ts` | `smartSearch.ts` + `rrf.ts` | ✅ |
| Index Persistence | `state/index-persistence.ts` | `indexPersistence.ts` `IndexPersistence` | ✅ |
| Reranker | `state/reranker.ts` | `reranker.ts` | ✅ |
| Stemmer | `state/stemmer.ts` | `stemmer.ts` | ✅ |
| CJK Segmenter | `state/cjk-segmenter.ts` | `cjkSegmenter.ts` | ✅ |
| Synonyms | `state/synonyms.ts` | ❌ 未移植 | ⚠️ 缺失 |
| Keyed Mutex | `state/keyed-mutex.ts` | `concurrentLock.ts` `ConcurrentLock` | ✅ 替代实现 |
| Memory Utils | `state/memory-utils.ts` | `memoryUtils.ts` | ✅ |

### 2.10 其他功能模块

| 功能 | agentmemory | 本项目 | 状态 |
|------|-------------|--------|------|
| Slots（固定记忆槽） | `functions/slots.ts` | `slots.ts` `SlotRegistry` | ✅ |
| Reflect（Stop hook 反思） | `functions/reflect.ts` | `reflector.ts` `Reflector` | ✅ |
| Lessons（经验教训） | `functions/lessons.ts` | `lessons.ts` `LessonExtractor` | ✅ |
| Patterns（模式检测） | `functions/patterns.ts` | `patternDetector.ts` `PatternDetector` | ✅ |
| Profile（项目画像） | `functions/profile.ts` | `projectProfile.ts` `ProjectProfileBuilder` | ✅ |
| Timeline（时间线） | `functions/timeline.ts` | `timeline.ts` `Timeline` | ✅ |
| Enrich（文件增强） | `functions/enrich.ts` | `enricher.ts` `FileEnricher` | ✅ |
| Relations（关系图） | `functions/relations.ts` | `relations.ts` `RelationGraph` | ✅ |
| File Index | `functions/file-index.ts` | `fileIndex.ts` `FileIndex` | ✅ |
| Compress File | `functions/compress-file.ts` | `compressFile.ts` `FileCompressor` | ✅ |
| Vision Search | `functions/vision-search.ts` | `visionSearch.ts` `VisionSearchManager` | ✅ |
| Image Quota Cleanup | `functions/image-quota-cleanup.ts` | `imageQuotaCleanup.ts` `ImageQuotaCleanup` | ✅ |
| Image Refs | `functions/image-refs.ts` | `imageRefs.ts` `ImageRefManager` | ✅ |
| Disk Size Manager | `functions/disk-size-manager.ts` | `diskManager.ts` `DiskManager` | ✅ |
| Claude Bridge（MEMORY.md 同步） | `functions/claude-bridge.ts` | `claudeBridge.ts` `ClaudeBridge` | ✅ |
| Obsidian Export | `functions/obsidian-export.ts` | ❌ 未移植 | ⚠️ 缺失 |
| Skill Extract | `functions/skill-extract.ts` | `skillExtract.ts` `SkillExtractor` | ✅ |
| Replay（会话回放） | `functions/replay.ts` | `replay.ts` + `sessionReplay.ts` | ✅ |
| Summarize（会话摘要） | `functions/summarize.ts` | `summarize.ts` `SessionSummarizer` | ✅ |
| Remember（长期记忆保存） | `functions/remember.ts` | `memoryProvider.ts` `writeMemory` | ✅ |
| Context（上下文生成） | `functions/context.ts` | `contextBuilder.ts` `ContextBuilder` + `memoryProvider.ts` `loadContext` | ✅ |
| Evict（驱逐） | `functions/evict.ts` | `evict.ts` `EvictionManager` | ✅ |
| Auto Forget | `functions/auto-forget.ts` | `memoryProvider.ts` `autoForget` | ✅ |
| Privacy Filter | `functions/privacy.ts` | `privacyFilter.ts` `stripPrivateData` | ✅ |
| Synthetic Compress | `functions/compress-synthetic.ts` | `compressor.ts` `compressSynthetic` | ✅ |

### 2.11 服务器外壳层 — ❌ 架构性不适用

| 外壳组件 | agentmemory | 本项目 | 状态 |
|----------|-------------|--------|------|
| **MCP Server**（53 工具） | `mcp/server.ts` + `mcp/tools-registry.ts` + `mcp/rest-proxy.ts` + `mcp/standalone.ts` + `mcp/transport.ts` + `mcp/in-memory-kv.ts` | ❌ 不适用（IDE 扩展非服务器） | N/A |
| **REST API**（128 端点） | `triggers/api.ts` + `triggers/events.ts` | ❌ 不适用（进程内调用） | N/A |
| **Real-time Viewer**（:3113） | `viewer/server.ts` | ❌ 替代为 `memoryDetailEditorPane.ts`（IDE 编辑器面板，8 个 Tab） | ✅ 替代实现 |
| **CLI**（28 命令） | `cli/`（28 文件） | ❌ 不适用（IDE 扩展） | N/A |
| **iii-engine 集成** | `index.ts` `registerWorker` | ❌ 不适用（无 iii-engine） | N/A |
| **OTEL Telemetry** | `telemetry/setup.ts` | ❌ 用 `metricsCollector.ts` 替代 | ⚠️ 简化 |
| **Health Monitor** | `health/monitor.ts` | `healthMonitor.ts` `HealthMonitor` + `healthThresholds.ts` | ✅ |
| **Skills**（15 SKILL.md） | `plugin/`（52 文件） | ❌ 不适用（IDE 有自己的技能系统） | N/A |
| **Docker/Deploy** | `deploy/`（17 文件） | ❌ 不适用 | N/A |
| **Plugin 集成**（Claude/Codex/Copilot 等） | `integrations/`（16 文件） | ❌ 不适用 | N/A |
| **Eval/Benchmark** | `eval/` + `benchmark/` | `__tests__/`（9 文件，含 benchmark.ts） | ✅ 简化 |

---

## 三、本项目额外增加的功能（agentmemory 没有）

| 额外功能 | 文件 | 说明 |
|----------|------|------|
| **ConfigManager 热重载** | `configManager.ts` | 运行时配置变更无需重启，带变更订阅 |
| **SearchCache** | `searchCache.ts` | 搜索结果 LRU 缓存 |
| **UnifiedScorer** | `unifiedScorer.ts` | 统一评分系统（BM25+Vector+Graph+时效+重要性） |
| **FuzzySearch** | `fuzzySearch.ts` | 模糊搜索容错 |
| **BloomFilter + HyperLogLog** | `bloomFilter.ts` | 概率数据结构去重 |
| **DiffCompressor** | `diffCompressor.ts` | 差异压缩（版本化内容） |
| **BatchProcessor** | `batchProcessor.ts` | 批量写入/删除/搜索 |
| **PriorityQueue** | `priorityQueue.ts` | 优先级队列 |
| **QuotaManager** | `quotaManager.ts` | 配额管理 |
| **RateLimiter** | `rateLimiter.ts` | 速率限制 |
| **EventBus** | `eventBus.ts` | 事件总线 |
| **NotificationHub** | `notificationHub.ts` | 通知中心 |
| **TriggerSystem** | `triggerSystem.ts` | 触发器系统 |
| **ReportGenerator** | `reportGenerator.ts` | 系统报告生成 |
| **IndexRebuilder** | `indexRebuilder.ts` | 索引重建器 |
| **MemoryFacade** | `memoryFacade.ts` | 记忆门面 |
| **MemorySync** | `memorySync.ts` | 记忆同步 |
| **PostCommitCapture** | `postCommitCapture.ts` | Git post-commit 捕获 |
| **PreCompactInjector** | `preCompactInjector.ts` | 预压缩注入器（独立模块化） |
| **SubagentTracker** | `subagentTracker.ts` | 子代理跟踪 |
| **AccessPatterns** | `accessPatterns.ts` | 访问模式分析 |
| **ImageStore** | `imageStore.ts` | 图片存储 |
| **ProjectResolver** | `projectResolver.ts` | 项目解析器 |
| **PromptManager** | `prompts.ts` | 提示词管理（含 XML 解析） |
| **Logger** | `logger.ts` | 结构化日志 |

---

## 四、缺失功能清单（需补齐）

### 4.1 算法层缺失（影响检索质量）

| 缺失项 | 上游文件 | 影响 | 优先级 |
|--------|----------|------|--------|
| **Synonyms（同义词扩展）** | `state/synonyms.ts` | BM25 无法识别 "auth"↔"authentication" 等同义词，检索召回率降低 | P2 |
| **Sketches（临时行动图）** | `functions/sketches.ts` | 无法创建临时行动图并提升为永久 | P3 |

### 4.2 Provider 层缺失（影响功能完整性）

| 缺失项 | 上游文件 | 影响 | 优先级 |
|--------|----------|------|--------|
| **OpenAI Embedding** | `providers/embedding/openai.ts` | 无法用 OpenAI text-embedding-3-small（高质量） | P2 |
| **Gemini Embedding** | `providers/embedding/gemini.ts` | 无法用 Gemini embedding-001 | P3 |
| **Cohere Embedding** | `providers/embedding/cohere.ts` | 无法用 Cohere embed-english-v3.0 | P3 |
| **Voyage Embedding** | `providers/embedding/voyage.ts` | 无法用 voyage-code-3（代码优化） | P3 |
| **CLIP Image Embedding** | `providers/embedding/clip.ts` | vision-search 无真实图像嵌入 | P3 |
| **Anthropic/OpenAI/OpenRouter/MiniMax LLM** | `providers/*.ts` | 压缩/摘要/固化依赖 IDE AgentOS（无法独立调用 LLM） | P2（设计选择） |

### 4.3 Hook 缺失（影响捕获完整性）

| 缺失项 | 上游文件 | 影响 | 优先级 |
|--------|----------|------|--------|
| **UserPromptSubmit** | `hooks/prompt-submit.ts` | 无法在用户提交 prompt 时捕获/注入 | P2 |
| **PreToolUse** | `hooks/pre-tool-use.ts` | 无法在工具调用前注入文件上下文 | P2 |
| **Notification** | `hooks/notification.ts` | 无法捕获通知事件 | P3 |

### 4.4 导出缺失

| 缺失项 | 上游文件 | 影响 | 优先级 |
|--------|----------|------|--------|
| **Obsidian Export** | `functions/obsidian-export.ts` | 无法导出到 Obsidian vault | P3 |

### 4.5 架构层不适用（非缺失，设计差异）

以下组件因架构差异**不需要移植**，已由 IDE 原生能力替代：

- ❌ MCP Server（53 工具）→ IDE 扩展 API 替代
- ❌ REST API（128 端点）→ 进程内方法调用替代
- ❌ Real-time Viewer（:3113）→ `memoryDetailEditorPane.ts` IDE 面板替代
- ❌ CLI（28 命令）→ IDE 命令面板替代
- ❌ iii-engine 集成 → 进程内执行替代
- ❌ OTEL Telemetry → IDE 日志系统替代
- ❌ Skills（15 SKILL.md）→ IDE 技能系统替代
- ❌ Docker/Deploy → 随 IDE 安装
- ❌ Plugin 集成（Claude/Codex/Copilot）→ 本项目自身就是 IDE

---

## 五、量化统计

### 5.1 源码规模对比

| 指标 | agentmemory（上游） | 本项目 | 说明 |
|------|---------------------|--------|------|
| 源文件数（src/） | 175 .ts | 103 .ts | 本项目不含 CLI/MCP/REST/Viewer/Plugin |
| 核心算法文件 | 64 functions + 12 state | 103 全部 | 本项目算法全覆盖 |
| memoryProvider.ts | — | 152 KB（单文件） | 本项目核心入口 |
| 测试文件 | 130 .ts（1423+ 测试） | 9 .ts | ⚠️ 本项目测试覆盖不足 |

### 5.2 功能落地率

| 类别 | 上游功能数 | 本项目已落地 | 落地率 |
|------|-----------|-------------|--------|
| **记忆管线** | 7 | 7 | **100%** |
| **四层固化** | 9 | 9 | **100%** |
| **三流检索** | 10 | 9（缺 synonyms） | **90%** |
| **Hook 系统** | 12 | 8 | **67%** |
| **编排层** | 15 | 14（缺 sketches） | **93%** |
| **高级检索** | 6 | 6 | **100%** |
| **团队治理** | 8 | 8 | **100%** |
| **LLM Provider** | 8 | 1（Noop）+ IDE AgentOS | **13%**（设计选择） |
| **Embedding Provider** | 7 | 1（Local） | **14%** |
| **状态管理** | 12 | 11（缺 synonyms） | **92%** |
| **其他功能** | 25 | 24（缺 obsidian-export） | **96%** |
| **服务器外壳** | 11 | 0（架构不适用）+ 1 替代 | N/A |

### 5.3 综合落地率

- **算法逻辑层**：**97%**（64/64 functions 中 62 已移植，缺 sketches + obsidian-export）
- **状态管理层**：**92%**（11/12 state 模块已移植，缺 synonyms）
- **Hook 层**：**67%**（8/12 hooks 已落地）
- **Provider 层**：**14%**（仅 Local Embedding + Noop LLM，其余由 IDE AgentOS 替代）
- **服务器外壳**：**N/A**（架构性不适用，已由 IDE 原生替代）
- **额外增强**：本项目有 **25+ 个上游没有的增强模块**

---

## 六、结论

### 核心发现

1. **算法层几乎完整落地（97%）**：agentmemory 的全部 64 个核心函数中，62 个已 1:1 移植为独立模块。缺失的 2 个（sketches、obsidian-export）为低优先级功能。

2. **架构层合理替代**：MCP Server / REST API / CLI / Viewer / iii-engine 等服务器外壳组件因架构差异不需移植，已由 IDE 原生能力（扩展 API、编辑器面板、命令面板、进程内执行）合理替代。

3. **Provider 层为设计选择**：LLM Provider 仅保留 Noop（复用 IDE AgentOS 的模型调用链），Embedding 仅保留 Local（xenova）。这是合理的架构决策——IDE 内无需重复实现 8 种 LLM 客户端。

4. **Hook 层有缺口（67%）**：12 个 hook 中 8 个已落地，缺 UserPromptSubmit / PreToolUse / Notification 3 个。其中 PreToolUse（工具调用前注入文件上下文）影响上下文增强能力。

5. **检索质量有提升空间**：缺 synonyms（同义词扩展）会影响 BM25 召回率，建议补齐。

6. **测试覆盖不足**：上游 1423+ 测试，本项目仅 9 个测试文件，建议补充。

7. **本项目有 25+ 个增强模块**：ConfigManager 热重载、SearchCache、UnifiedScorer、FuzzySearch、BloomFilter、BatchProcessor 等均为上游没有的增强。

### 建议补齐优先级

| 优先级 | 项目 | 理由 |
|--------|------|------|
| **P1** | Synonyms（同义词扩展） | 直接影响 BM25 检索召回率 |
| **P1** | PreToolUse Hook | 工具调用前注入文件上下文，提升记忆增强 |
| **P1** | UserPromptSubmit Hook | 捕获用户 prompt，完整记忆管线 |
| **P2** | OpenAI Embedding Provider | 提供高质量嵌入选项 |
| **P2** | 测试覆盖扩充 | 当前仅 9 个测试文件，需覆盖核心模块 |
| **P3** | Sketches（临时行动图） | 低频功能 |
| **P3** | Obsidian Export | 小众需求 |
| **P3** | Notification Hook | 通知事件捕获 |
| **P3** | Gemini/Cohere/Voyage/CLIP Embedding | 多 Provider 选项 |
