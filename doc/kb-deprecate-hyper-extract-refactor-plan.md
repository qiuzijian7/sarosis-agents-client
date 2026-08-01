# 废弃 Hyper-Extract 知识引擎（系统A），统一为 llm-wiki（系统B）重构方案

> 日期：2026-07-31
> 状态：P0/P1/P2/P3/P4 全部落地（tsgo 全绿；`kbVaultRecallTools` 12/12、`kbLegacyMigration` 6/6）
> 范围：`src/vs/sessions/contrib/agentStudio/` 知识库子系统

---

## Release Note（2026-07-31）

**Breaking / 行为变更**

- **移除系统 A（Hyper-Extract 抽取式知识引擎）全部能力**：`browser/knowledge/engine/`、
  `knowledgeTools.ts`、每仓库 RAG session、URL 自动摄入链路（`urlSafety`/`urlIngest*`/`urlContentSanitizer`）。
- **移除以下 Agent 工具**：`kb_ask`、`kb_search_repo`、`kb_export`/`kb_export_notes`、`kb_list`、
  `kb_build`/`kb_ingest`/`kb_add`/`kb_delete`/`kb_status` 等；`agentStudioService` 的
  `importMessageToKnowledgeBase` / `summarizeMessageToKnowledgeBase` / `importMessageRawToKnowledgeBase` /
  `importFolderToRag` / `unlinkFolderRag` / `searchFolderRag` 一并下线（确认无调用方）。
- **`kb_search` 成为唯一检索入口**：混合 BM25 全文 + 向量，简化 RRF（`1/(60+rank)`）融合、按 URI 去重；
  无 Vault / 向量未构建 / 零命中一律返回**可执行引导文本**而非报错，避免 Agent 误判工具故障。
- `IKbVault.ragSessions` / `ragUnversionedSessionId` 标记为 `@deprecated`（仅用于兼容旧 `vault.json` 读取与清理）。

**新增**

- 命令面板 **`Agent Studio: 迁移旧版知识库到 llm-wiki`**（`agentStudio.kb.migrateLegacy`）：把旧版
  `<kb-storage-root>/<id>/kb.json` session 最佳努力转成 Markdown 笔记写入激活 Vault 的 `笔记/迁移/`，
  并将旧目录**安全归档**至 `<root>/_migrated_backup_<ts>/`（不硬删，可人工回滚）。
- `browser/knowledge/kbLegacyMigration.ts`（纯提取逻辑，6/6 单测）+ `browser/knowledge/kbVaultState.ts`
  （存储键 / Vault / 存储根解析单一来源）。

**注意（迁移限制）**：系统 A 的 `exportToNotes` 已随引擎删除，无法逐字复刻原 Markdown 结构。
旧 session 的检索文本为最佳努力提取（`data.items` / `data.nodes` / `data.texts` / 递归字符串），
结构信息可能不如原版精确，但保证可被 `kb_search` 全文检索且原始数据零丢失（无文本时内嵌原始 JSON）。

---

## 1. 背景

当前代码库并存两套互不相通的知识库系统：

| | 系统A：Hyper-Extract 引擎 | 系统B：llm-wiki（Obsidian 式库/笔记） |
|---|---|---|
| 核心 | `knowledge/engine/KnowledgeManager`（session + 内嵌向量 JSON） | `KbImportController` + `KbNativeKernel`（BM25 + 向量 + 双链图谱） |
| 落盘 | KB storage root 下 `*.kb.json`（含 `{texts,vectors}`） | vault 的 `库/raw/*.md`、`笔记/*.md`（纯 Markdown） |
| 召回 | LLM 工具 `kb_search` / `kb_ask` / `kb_search_repo` | UI 搜索框（`KbFullTextIndex` BM25 + `KbVectorIndex` 向量弱拼接） |
| 导入入口 | KB 视图「导入文件夹为 RAG」（`_importFolderRagAsync`） | 聊天框「收藏/导入知识库」、工作区文件右键、write_file 卡片 |

痛点：
- 双份向量索引、双份存储，同一份资料两边导入后互不可检索。
- 系统A 的构建类工具（`kb_build`/`kb_ingest`）已从 Agent 工具面移除，纯靠 UI 触发，链路近乎不可达。
- 系统B 是唯一被真实 UI 流程使用的系统，但对 LLM **零召回通道**。

**决策（用户拍板）**：废弃系统A，保留系统B（llm-wiki），并补齐系统B 的 LLM 召回工具。

## 2. 目标与非目标

### 目标
1. 完整移除系统A（engine 主体、`knowledgeTools.ts`、folder-RAG 链路、相关 RPC/视图按钮/测试）。
2. 系统B 依赖的共享文件零误删（`kbSchema`/`classifier`/`llm.ts`/`communityDetection.ts` 等）。
3. 废弃后 LLM 不失去知识库召回能力：新增基于系统B 的 `kb_search` 工具（向量 + 全文 RRF 融合）。
4. 存量系统A 数据提供迁移或显式废弃路径。

### 非目标
- 不改动系统B 的导入两阶段流程（`handleFavoriteMessage` / `importContentAndBuild` / 构建为笔记）。
- 不改动系统B 的 UI 搜索框召回逻辑（BM25+向量弱拼接保持原样，RRF 仅在 LLM 工具侧做）。
- 不迁移 AgentMemory 子系统（与两套 KB 均无关）。

## 3. 依赖盘点与删除边界

### 3.1 必删（系统A 专用）

**代码文件：**
| 文件 | 说明 |
|---|---|
| `browser/knowledge/knowledgeTools.ts` | `buildKnowledgeToolDescriptors`（kb_* 工具）、`importFolderToRag`、`searchFolderRag`、`buildKbManager`、`import/summarize/importMessageRaw*ToKnowledgeBase`、`exportToNotes` |
| `browser/knowledge/engine/knowledgeManager.ts` | KnowledgeManager 主体 |
| `browser/knowledge/engine/autoList.ts` / `autoGraph.ts` / `autoHypergraph.ts` / `autoSet.ts` / `autoTemporalGraph.ts` | Auto* 知识形态 |
| `browser/knowledge/engine/base.ts` / `types.ts` / `methodRegistry.ts` / `templates.ts` / `merge.ts` | engine 内部基础设施 |
| `browser/knowledge/engine/omem.ts` / `vectorIndex.ts` / `embedder.ts` | OMem / SplitIndex 向量引擎 |
| `browser/knowledge/engine/folderRagBuild.ts` | folder→RAG 管线 |
| `browser/knowledge/engine/hybridSearch.ts` | 仅 knowledgeManager 与 engine 测试引用，系统B 无引用 |
| `browser/knowledge/engine/communitySummary.ts` / `i18nPrompts.ts` / `prompts.yaml` / `textSplitter.ts` | engine 内部辅助 |
| `browser/knowledge/engine/__tests__/` | engine 全量测试 |
| `browser/knowledge/urlContentSanitizer.ts` / `urlIngestCache.ts` / `urlIngestQueue.ts` / `urlSafety.ts` | URL 摄取（kb_ingest_urls 支撑），browser 内零外部引用 |

**`agentStudioService.ts` 删除成员：**
- 方法：`importMessageToKnowledgeBase`、`summarizeMessageToKnowledgeBase`、`importMessageRawToKnowledgeBase`、`importFolderToRag`、`unlinkFolderRag`、`searchFolderRag`、`_buildKbToolDeps`、`_folderRagIndexPath`、`_readFolderRagIndex`、`_writeFolderRagIndex`
- import 清理：`KnowledgeManager`、`importFolderToRag`、`searchFolderRag`、`importMessageToKnowledgeBase` 等来自 `knowledgeTools.js` 的全部符号；`createFileStorageAdapter` 相关

**`knowledgeBaseView.ts` 删除成员：**
- `_importFolderRagAsync`（定义 L3029 附近 + 调用点 L2725/L2852/L2896）
- `unlinkFolderRag` 调用（L2984 附近）
- 「导入文件夹为 RAG」按钮/通知文案（`kb.folderRag.*` localize key）

**`kbTypes.ts`：**
- `folderRagSessionMap` 字段（L55 附近）及其读写点

**`providers/tool/knowledgeStorageTools.ts`：**
- `registerKnowledgeTools()` 中 `buildKnowledgeToolDescriptors` 注册循环（L77-79）→ 由 §5 新工具替代
- `registerEmbeddingProvider()` 与 `migrateKnowledgeStorage` 配置监听 **保留**

**接口/RPC 清理：**
- `common/` 下 `IAgentStudioService` 相关声明与 IPC channel/proxy 中上述 6 个方法的暴露（实施时以 grep 实际声明位置为准；browser 内 `agentStudioService` 为同进程注入，大概率无 channel 变更）

**测试：**
- `knowledge/engine/__tests__/`（含 `engine.test.ts` 中 `buildKnowledgeToolDescriptors` / `importFolderToRag` / `hybridSearch` 用例）
- `test/browser/hybridSearchGraphSignals.test.ts`
- `knowledge/__tests__/` 中系统A 相关用例（逐一甄别，保留 kbSchema/classifier 等共享测试）

**运行时产物：**
- `<kb-storage-root>/*.kb.json`（系统A session）
- `<kb-storage-root>/.folderRagIndex.json`

### 3.2 必留（系统B / 共享依赖）

| 文件 | 被谁依赖 |
|---|---|
| `knowledge/engine/llm.ts`（IChatModel） | `kbImportController.ts`、`knowledgeBaseView.ts`、`kbMindmapGenerator.ts`、`agentStudioService.ts` |
| `knowledge/engine/communityDetection.ts` | `kbImportController.ts`（图谱社区检测） |
| `knowledge/kbSchema.ts` / `classifier.ts` / `kbAliases.ts` / `frontmatter.ts` / `enrichWikilinks.ts` | `kbImportController.ts`（llm-wiki 导入管线） |
| `knowledge/knowledgeAdapters.ts` | `agentStudioService.ts`、`kbImportController.ts` |
| `knowledge/embeddingProviders.ts` | `knowledgeAdapters.ts` |
| `knowledge/embeddingConfigResolver.ts` / `builtinEmbeddingProvider.ts` | `agentStudioService.ts`、`knowledgeStorageTools.ts` |
| `knowledge/tokenEmbedder.ts` | `views/knowledgeBase/kbVectorIndex.ts`（`embedWithPooling`） |
| `knowledge/kbLint.ts` / `dedup.ts` / `reviewStore.ts` / `pageMerge.ts` / `kbOpLog.ts` | `knowledgeBaseView.ts`（lint/去重/评审/操作日志） |
| `knowledge/knowledgeStorage.ts` 的 `resolveKbRoot` / `migrateKnowledgeStorage` | `agentStudioService.ts`、`knowledgeBaseView.ts`、`workspaceSecurity.ts`、`knowledgeStorageTools.ts`（4 处共享） |

### 3.3 待核实零引用（删除前二次确认）

- `knowledge/kbAttachmentStore.ts` — 当前检索未见 importer，需再确认（可能经 `.js` 动态引用）。
- `knowledge/engine/` 瘦身前对每个文件跑一遍全局 import grep，以 tsgo 全检兜底。

## 4. 架构调整

### 4.1 `engine/` 目录瘦身迁移

`engine/` 删除 17 个系统A 文件后仅剩 `llm.ts`、`communityDetection.ts`——目录名 `engine`（Hyper-Extract 引擎）语义已失效。

- 迁移 `engine/llm.ts` → `knowledge/chatModel.ts`（或保留 `llm.ts` 文件名）
- 迁移 `engine/communityDetection.ts` → `knowledge/communityDetection.ts`
- 同步改 5 处 import（`kbImportController.ts` ×2、`knowledgeBaseView.ts`、`kbMindmapGenerator.ts`、`agentStudioService.ts`）
- 删除空的 `engine/` 目录

> 备选：不迁移、`engine/` 瘦身保留 2 文件。成本更低但语义混乱，不推荐。

### 4.2 `knowledgeStorage.ts` 拆分

- 保留：`resolveKbRoot`、`migrateKnowledgeStorage`（可更名 `kbRootResolver.ts`，或原文件瘦身）
- 删除：`createFileStorageAdapter`、`KBStorageAdapter` 接口、`KnowledgeSessionMeta`/`SerializedKB` 类型 re-export（随 engine 删除）

### 4.3 工具注册替换

`builtinToolProvider._getKnowledgeStorage().registerKnowledgeTools()`（`builtinToolProvider.ts` L358）当前注册系统A 工具描述符。改造为注册 §5 的系统B 召回工具（新 registrar）。

### 4.4 KB 视图

- 移除「导入文件夹为 RAG」入口；文件夹语义检索诉求由系统B 既有能力承接：`IKbNativeKernelService.buildVectorIndex(roots, opts)`（per-folder 向量索引）+ 新 `kb_search` 工具。
- 文件夹链接（`.code-workspace` → vault）保持不变。

## 5. 能力补位：`kb_search` 工具（系统B 的 LLM 召回通道）

废弃系统A 后 `kb_search` 名称空出，**直接复用该名**（延续 Agent 配置/文档中的既有工具名，`toolsetConfig.ts` knowledge 工具集 `prefixes: ['kb_']` 已就位）。

### 5.1 服务层改动（`kbNativeKernelService.ts`）

`IKbNativeKernelService` 现仅有 `searchVector` / `getBacklinks` / `getWorkspaceFiles`，**缺全文检索出口**。新增：

```ts
/** BM25 全文检索（桥接 KbNativeKernel 现有 search()，当前为无调用方代码，转正） */
searchFulltext(query: string, limit?: number): Promise<IKbFulltextHit[]>;
```

- 实现：`ensureBuilt()` 后调用 `KbNativeKernel.search(query, limit)`（`kbNativeKernel.ts` L267 既有实现）。
- `IKbFulltextHit`：`{ uri, title, snippet, score }`（对齐 kernel 返回结构）。

### 5.2 工具实现（新文件 `providers/tool/kbVaultRecallTools.ts`）

注册单个只读工具 `kb_search`：

- **handler 流程**：
  1. `await kernelService.ensureBuilt()`
  2. 并行：`searchFulltext(query, topK*2)` +（embedding 可用时）`searchVector(query, topK*2)`
  3. RRF 融合（`score = Σ 1/(k+rank)`，k=60），URI 去重，取 topK
  4. 返回 `[{ title, uri, snippet, score, source: 'bm25'|'vector'|'both' }]`
- **可用性守卫**：无 KB vault（无任何 vault 根）时 `available` 返回 false；embedding 未配置时降级为仅 BM25 单路（工具仍可用，结果标注 `source: 'bm25'`）。
- **只读标记**：`readonly: true`，可参与 `shouldParallelizeToolBatch` 并行批。
- **工具集**：归属既有 `knowledge` toolset（Medium/可折叠按现配置），无需改 `toolsetConfig.ts`。
- **结果体量护栏**：snippet 截断（≤300 字符/条）、topK 上限 20，避免上下文膨胀。

### 5.3 与旧 `kb_search` 的语义差异（需在工具描述中写清）

| | 旧（系统A） | 新（系统B） |
|---|---|---|
| 检索对象 | 按 id 的 KnowledgeSession | 当前激活 vault 的 库+笔记 |
| 引擎 | OMem/SplitIndex 向量 | BM25 + KbVectorIndex RRF |
| 参数 | `id`, `query`, `topK` | `query`, `topK`（无 id） |

`kb_ask` / `kb_search_repo` / `kb_list` / `kb_export*` **不补位**（问答由 Agent 主循环对 `kb_search` 结果自行综合；跨库检索由系统B vault 机制承接）。

## 6. 数据迁移

存量系统A 数据（`<kb-storage-root>/*.kb.json` + `.folderRagIndex.json`）两条路径，推荐 A：

- **A. 一次性迁移命令**：新增 workbench action「迁移旧版知识库到 llm-wiki」：
  1. 扫描 KB storage root 的 `*.kb.json`
  2. 逐 session 复用 `exportToNotes` 逻辑导出 Markdown（此函数在迁移完成前暂存，随后随 `knowledgeTools.ts` 一并删除）
  3. 写入激活 vault `笔记/迁移/` 目录
  4. 触发 `KbNativeKernel` 重建（BM25 + 双链）；向量索引由用户按需 `buildVectorIndex`
  5. 迁移完成后删除 `*.kb.json` 与 `.folderRagIndex.json`
- **B. 直接废弃**：版本 release note 声明数据不迁移，删除旧目录。

## 7. 实施计划

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 | ✅ 已完成 — `engine/llm.ts`、`embedder.ts`、`communityDetection.ts` 迁移到 `knowledge/` 根，改 5 处 import | tsgo 过 |
| P1+P2（同 PR） | ✅ 已完成 — 见下方「落地记录」 | tsgo 全绿 |
| P3 | 数据迁移命令（§6-A）+ 旧产物清理 | 独立 PR，待办 |
| P4 | 文档更新（工具列表/Agent 配置示例），release note 声明 `kb_ask`/`kb_search_repo` 移除 | 收尾，待办 |

### P1+P2 落地记录（2026-07-31）

**删除**（系统A）：
- `browser/knowledge/engine/`（整目录，含 `__tests__/`）
- `browser/knowledge/knowledgeTools.ts`
- `browser/knowledge/url{Safety,IngestQueue,IngestCache,ContentSanitizer}.ts`（已零引用孤岛）
- `test/browser/hybridSearchGraphSignals.test.ts`
- `common/agentStudioService.ts`：`importMessageToKnowledgeBase` / `summarizeMessageToKnowledgeBase` /
  `importMessageRawToKnowledgeBase` / `importFolderToRag` / `unlinkFolderRag` / `searchFolderRag` 及其实现
- `knowledgeBaseView.ts`：`_importFolderRagAsync` 及全部调用点、`newFolders` 变量、`isEmbedderConfigured` 导入

**新增 / 改造**：
- `browser/providers/tool/kbVaultRecallTools.ts` — 唯一 Agent 检索入口 `kb_search`
  （hybrid = BM25 + 向量，简化 RRF `1/(60+rank)` 融合、按 URI 去重、重合命中保留更长的语义片段）
- `kbNativeKernelService.ts` — `searchFulltext` / `hasActiveVault` / `IKbFulltextHit`
- `knowledgeStorageTools.ts` — `KnowledgeStorageContext` 新增 `kernelService`；
  `registerKnowledgeTools()` 改为调用 `registerKbVaultRecallTools`；删除 `resolveWorkspaceDir`
- `builtinToolProvider.ts` — 注入 `IKbNativeKernelService` 并透传
- `builtinAgents.ts` — KB agent `tools` 由 `[kb_export_notes, kb_list, kb_search, kb_ask]` 收敛为 `[kb_search]`
- `kbTypes.ts` — `ragSessions` / `ragUnversionedSessionId` 标记 `@deprecated`（仅兼容旧 vault.json 读取与清理）

**验证**：`compile-check-ts-native` 退出码 0；新增 `test/browser/kbVaultRecallTools.test.ts` 12/12 通过；
browser 全量套件剩余失败均为既有 mock 漂移（`mgr.buildMentionIndex` / `getTagForProvider` /
`taskBoardService.updateTaskStatus` 等），无一条源于本次删除（输出中零 `Cannot find module`）。

## 8. 验证

1. `npm run compile-check-ts-native`（tsgo 全检，兜住漏改 import；注意 tsserver 不查 noUnusedLocals）
2. 单测：`run-*-tests` 中 KB 相关（kbImportController / kbEntryFlows / kbLint / dedup.review / dedup.merge / pageMerge / kbOpLog / tokenEmbedder / embeddingProviders / embeddingConfigResolver）全绿；新增 `kbVaultRecallTools` 单测（mock `IKbNativeKernelService`，断言 RRF 融合、URI 去重、BM25 降级路径——只断言确定性契约，不写语义排名断言）
3. 手动链路：聊天框「导入知识库」→ 构建为笔记 → UI 搜索框召回 → Agent 调 `kb_search` 双通道均能命中同一笔记

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 漏删/误删共享文件导致编译断裂 | §3.2 白名单 + P0 先迁移 + tsgo 全检 |
| 存量用户 `.kb.json` 数据丢失 | §6 迁移命令；release note 明示 |
| Agent 配置引用 `kb_ask`/`kb_search_repo` 失效 | 工具描述/文档指引迁移到新 `kb_search`；保留 `knowledge` toolset 归组不变 |
| 新 `kb_search` 无 embedding 时退化为单路 | 显式降级设计 + 结果标注 `source` |
| `KbNativeKernel.search()` 转正后暴露既有缺陷 | P2 内补 `searchFulltext` 的最小单测 |
