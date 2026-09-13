# _unused/ — P2-10 影子模块存档（2026-09-09）

本目录文件**不在编译路径内**（tsconfig `rootDir: ./src`，位于 src 之外）。
三批移动共 **98 个源文件 + 4 个测试文件 + worker/ 目录**（原 133 源文件 → src 剩 46，固定点检查
`scripts/check-all-unused.mjs` 无 FREE 残留，即 src 内全部文件都在活跃 import 图上）。
全部经零引用核查——与 `src/` 内活跃实现（amFunctions / amPipeline / amSlots / amAdvanced 等）
功能重复或从未被 import。

## 与活跃实现的对应关系

| 本目录（影子） | 活跃实现 |
|---|---|
| contextBuilder.ts | amFunctions.buildContext |
| retention.ts / evict.ts | amFunctions.retentionScore / evict |
| rrf.ts | amFunctions.searchMemories 内联 RRF |
| lessons.ts | amFunctions.lesson* |
| slots.ts | amSlots.ts |
| consolidation.ts | amPipeline.runConsolidationPipeline |
| sketches/sentinels/crystallize/snapshots/facets.ts | amAdvanced.ts 内对应段 |
| smartSearch/multiSearch/fuzzySearch/unifiedScorer/searchCache.ts | searchMemories 六步流水线 |
| dedup.ts / bloomFilter.ts | amFunctions.remember 指纹去重 |
| accessTracker.ts / accessPatterns.ts | amFunctions.recordAccess |
| openai/gemini/cohere/voyage/clipEmbedding + embeddingProviders + noopProvider | vectorIndex.ts（trigram 降级，xenova 可选依赖未装） |
| visionSearch.ts | 无活跃对应（CLIP 依赖上述死 embedding） |
| lessons/slots/sentinels/crystallize 被引用于 | obsidianExport/reflector/healthMonitor（同为死代码，一并移出） |

对应测试一并移入 `__tests__/`：rrf.test.ts、dedup.test.ts、sentinel.test.ts、concurrency.test.ts
（runAllTests.ts 已同步移除其注册）。

## 第二批（2026-09-09 续，53 源文件 + concurrency.test）

独立功能模块从未被活跃链 import：temporalGraph / meshCoord / teamMemory / memorySync / routines /
workingMemory / projectProfile / subagentTracker / frontier / branchAware / eventBus / metricsCollector /
notificationHub / configManager / sessionReplay / replay / migrate / resilientProvider（携 circuitBreaker /
rateLimiter）/ priorityQueue / batchProcessor / preCompactInjector / triggerSystem / enricher / timeline /
imageStore / imageRefs / imageQuotaCleanup / diskCache / diskManager / compressFile / diffCompressor /
exportImport / healthThresholds / diagnostics / memoryFacade / answerGen / prompts / chunking /
queryExpansion / recentSearches / memoryUtils / provenance / indexPersistence / indexRebuilder /
migrateVectorIndex / projectResolver / tokenBudget / summarize / slidingWindow / verify / logger / cascade。

若 P1-6 决断选择「接入远端 embedding」，从本目录恢复
`embeddingProviders.ts` + 5 个 provider + `noopProvider.ts`（接口 `EmbeddingProvider` 在 noopProvider 中定义）。
