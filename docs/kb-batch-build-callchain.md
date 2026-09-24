# 「批量构建库」调用链说明

> 📄 **一页式全景（HTML）**：[`docs/kb-build-flow.html`](./kb-build-flow.html)（自包含、离线可开）—— 流程图 + 决策表。
> 本文档是它的函数级细节版（输入/输出/举例）。

> 触发点：知识库视图 →「库」分区标题右侧的 **🔧 批量构建库** 按钮（`title = '批量构建库（把库中所有未处理素材转为笔记）'`）。
> 涉及文件：`src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBaseView.ts`（视图侧）、
> `src/vs/sessions/contrib/agentStudio/browser/kbImportController.ts`（构建主体）。
> 行号会随代码演进漂移，**以函数名与文件为准**。

---

## 0. 总览

```
[用户点击] 库分区标题栏的 🔧 按钮
   │
   ├─ knowledgeBaseView._batchBuildAll()                      ← 视图侧：前置检查 / 进度反馈 / 收尾刷新
   │     │
   │     └─ this._kbImport.buildPendingAsAgentSession(vaultRoot)  ← ★ 新默认：agent 自主读写（见 §8 / §9.1）
   │           │   （降级时改走 → this._kbImport.buildAllPendingNotes(vaultRoot)，见 §2.1）
   │           └─ KbImportController._buildAllPendingCore(..., buildOne)  ← **降级/直连**批量主体（6 步）
   │                 ① _stageDocSourcesToText()      PDF/docx → 同名 .md
   │                 ② _readBuildCache()            读 <vault>/.kb-build-cache.json
   │                 ③ _collectMdFiles(libDir)      枚举「库」内全部 .md（递归）
   │                 ④ 计算 pending（排除已构建 + 已产出的笔记）
   │                 ⑤ for each pending：buildOne() = 实例 buildNotesFromLibrary()
   │                        ├─ agent 多轮 _buildNoteAgentic()   （默认，AGENT_STUDIO_KB_AGENTIC_BUILD）
   │                        └─ 失败 / 无产出 ⇒ 回落直连 _buildNoteCore()
   │                 ⑥ applyDeabstractionGating()   批量结束后统一收敛 active / pending
   │
   └─ 回到视图：清「构建中」标记 → 清进度 → 徽标「有新增」→ 刷新「笔记」「库」两个分区 → 搜索索引置脏
```

> ★★ 2026-09-23（用户需求）**批量构建的默认路径已换成「agent 自主读写」**：
> 宿主只把**素材路径清单**交给一个 agent 会话，agent 自己 `file_read` 依次读、`file_write` 写笔记，
> 再在**同一会话**里创建/完善「知识体系.md」。详见 §8。
> 下图（`_buildAllPendingCore`）现在是**降级 / 直连路径**：chat 服务不可用、会话建不出来，
> 或走单文件右键构建时使用。

**核心约定**（2026-09-23 确立）：

| 概念 | 目录 | 含义 |
|---|---|---|
| **库** | `<vault>/库` | **数据源层**：素材（`库/raw/…`）+ 历史遗留笔记 |
| **笔记** | `<vault>/笔记` | **知识体系层**：构建产物（LLM 提炼归纳的笔记）落这里 |

---

## 1. 视图侧：`_batchBuildAll()`

```ts
// knowledgeBaseView.ts
private async _batchBuildAll(): Promise<void>
```

**输入**：无（读 `this._activeVault` 等视图状态）。
**输出**：`Promise<void>`（无返回值；所有反馈走通知 / 徽标 / 行内状态）。

按顺序做 7 件事：

| # | 动作 | 失败/边界处理 |
|---|---|---|
| 1 | 无激活知识库 ⇒ 通知「请先选择知识库。」并返回 | 提前退出 |
| 2 | `KbImportController.kbAgentConfigState(agentStudioService, configurationService) === 'missing'` ⇒ 通知一次并**中止** | 放在最前面 ⇒ 不会逐个文件刷屏 |
| 3 | 把「库」分区所有文件行标记为「构建中」：`_setNodeBuilding(path, true)` | 仅视觉 |
| 4 | `agentStudioService.requestLibraryBadge({ source:'kb', kind:'building' })` | 长任务在 activitybar 上可见 |
| 5 | `const res = await this._kbImport.buildPendingAsAgentSession(vaultRoot); builtCount = res.built;`（降级/直连时为 `KbImportController.buildAllPendingNotes(vaultRoot, deps)`） | `finally` 里无条件清所有「构建中」标记 + `reportKbProcessing({active:false})` |
| 6 | `builtCount > 0` 才 `requestLibraryBadge({ kind:'new', count: builtCount })` | **原先无条件提示「有新增」**，一篇没构建也亮灯 ⇒ 已修 |
| 7 | `await refreshSection('notes')`、`await refreshSection('library')`、`markSearchDirty()` | 让新笔记进入搜索索引 / 关系图谱 |

---

## 2. 入口层：`buildAllPendingNotes`（**实例版 / 静态版两条入口**）

### 2.1 实例版 —— UI 走这条（**有 agent 多轮**）★ 2026-09-23 起

```ts
// kbImportController.ts
async buildAllPendingNotes(vaultRootUri?: URI): Promise<number>
```

**输入**：vault 根（缺省 `this._resolveKbRootUri()`）。
**输出**：`Promise<number>` = 本次真正构建出的笔记篇数。
**关键**：向 `_buildAllPendingCore` 传了一个 `buildOne` 回调：

```ts
(file, label) => this.buildNotesFromLibrary(file, vaultRoot, { progressLabel: label })
```

⇒ 单篇构建交给**实例**方法 ⇒ 默认走 **agent 多轮**（`_buildNoteAgentic`，knowledge-base-expert agent + 技能注入 + 工具），
失败 / 无产出时**自动回落**直连管线 ⇒ **与单文件右键「构建为笔记」完全同一条路径**。

> 视图为什么能调实例方法：`knowledgeBaseView` 在构造函数里 `new KbImportController(...)` **自持一个实例**
> （与 `workspaceView` / `nativeChatEditorPane` 的做法一致），并为此多注入 `IViewsService` 与 `IAgentDriverService`。
> ✅ 并发安全：`_vaultLocks`（per-vault 互斥锁）是**静态**的 ⇒ 多个控制器实例之间仍然互斥。

### 2.2 静态版 `buildAllPendingNotes(vaultRootUri, deps)` —— 直连管线，**不跑 agent**

**输入**：vault 根 URI + 一组服务（`fileService / configService / logService / notificationService / agentStudioService / requestService?`）。
**输出**：同实例版。
**实现**：一行转发 `_buildAllPendingCore(...)`，**不传** `buildOne` ⇒ 逐篇走直连 `_buildNoteCore`（STAGE1 + STAGE2 两次 LLM）。
保留用途：没有控制器实例的场景（例如单测）。

> 配置开关 `AGENT_STUDIO_KB_AGENTIC_BUILD`（`sessions.agentStudio.kb.agenticBuild`）**默认开启**
> （判据是 `!== false`，所以「没显式设置」也生效）；显式设为 `false` ⇒ 实例路径也回退纯直连。

---

## 3. 批量主体：`_buildAllPendingCore`

```ts
private static async _buildAllPendingCore(
  vaultRoot: URI, fileService: IFileService, configService: IConfigurationService,
  logService: ILogService, notificationService: INotificationService,
  agentStudioService: IAgentStudioService, requestService?: IRequestService,
): Promise<number>
```

**输入**：同上游。
**输出**：`Promise<number>` = 成功构建的笔记篇数。

### 步骤 ①：`_stageDocSourcesToText()` —— 非文本素材 → 文本

```ts
private static async _stageDocSourcesToText(
  fileService: IFileService, libDir: URI, logService: ILogService,
  notificationService: INotificationService, agentStudioService: IAgentStudioService,
): Promise<void>
```

| 项 | 内容 |
|---|---|
| **输入** | `库` 目录 |
| **输出** | 无返回值；副作用 = 为每个 `<PDF/docx>` 写一份**同目录同名 `.md`** |
| **为什么必须** | 素材枚举只收 `.md`（`_collectMdFiles` 里 `endsWith('.md')`），且构建管线把素材**当纯文本**塞进 prompt ⇒ PDF 既进不了候选、硬塞也是二进制乱码 |
| **怎么找源** | `_collectDocSources(fileService, dir): Promise<URI[]>` —— 只收 `KB_DOC_SOURCE_EXTENSIONS`（PDF/docx），跳过 dot 文件 |
| **跳过条件** | 同名 `.md` 已存在且**不比源文件旧** ⇒ 跳过（否则每次批量都重跑一遍 python） |
| **扫描件** | 有页无字 ⇒ **不写空 md**，只提示（空 md 会被构建成一篇空笔记） |
| **执行位置** | 主进程（`vscode:kbExtractDocText` → 本机 `python` + `PyMuPDF4LLM`）；桥不可用则**静默跳过**，批量照常进行 |
| **串行** | 本机 python 启停有成本、并发无收益、且会让进度文案乱序 |

**例**：`库/raw/UI优化篇.pdf` ⇒ 产出 `库/raw/UI优化篇.md`，头部形如

```markdown
> 来源：`UI优化篇.pdf`（PyMuPDF4LLM 结构化解析；提取后端：pymupdf4llm，共 3 页，提取图片 4 张）

# UI优化篇
...
![](assets/UI优化篇/img-01.png)
```

> ⚠ **必须在读缓存 / 枚举之前调用**：新生成的 md 要能被下一步收进来。

### 步骤 ②：`_readBuildCache()` —— 读构建缓存

```ts
private static async _readBuildCache(fileService: IFileService, vaultRoot: URI): Promise<Record<string, string>>
```

| 项 | 内容 |
|---|---|
| **输入** | vault 根 |
| **输出** | `{ 源文件的绝对路径: 已建笔记的绝对路径 }`；文件不存在/解析失败 ⇒ `{}` |
| **落盘位置** | `<vault>/.kb-build-cache.json`（**vault 根**，不是库内） |

**例**：

```json
{
  "e:\\VsSarosVault\\库\\raw\\UI优化篇.md": "e:\\VsSarosVault\\笔记\\内存管理\\UI优化技巧.md",
  "e:\\VsSarosVault\\库\\raw\\网络优化篇.md": "e:\\VsSarosVault\\笔记\\网络\\UE4网络同步优化.md"
}
```

> ⚠ 这是**路径映射**（键=素材路径、值=笔记路径），但**自 2026-09-24 起带「新鲜度」判定**：
> 素材的 mtime > 笔记的 mtime（素材在构建后又被改过）⇒ 缓存条目失效 ⇒ **自动重建**（笔记就地 patch 更新，见 `_cacheEntryFresh`）；
> 反之，缓存里残留的孤儿条目会让对应素材**永久**被跳过（KB 视图右键「修复（清缓存孤儿 / 失效来源）」可清理）。

### 步骤 ③：`_collectMdFiles()` —— 枚举素材

```ts
static async _collectMdFiles(
  fileService: IFileService, dir: URI, exclude?: string | readonly string[],
): Promise<URI[]>
```

| 项 | 内容 |
|---|---|
| **输入** | `库` 目录 + 排除名单（这里传 `SYS_INDEX_FILES = ['index.md','overview.md','insights.md','log.md','lint-report.md','dedup-report.md']`） |
| **输出** | 递归收集到的所有 `.md` 的 URI 数组 |
| **细节** | 跳过以 `.` 开头的文件/目录（`.overview.md` 等天然排除） |

**例**（`库/` 下）：
```
库/raw/UI优化篇.md            → 收
库/raw/UI优化篇.pdf           → 不收（非 .md；它的文本已由步骤①落到同名 .md）
库/raw/assets/UI优化篇/img-01.png → 不收
库/方法/UE4-UI性能优化指南.md  → 收（历史遗留笔记，属于「库」）
库/index.md                   → 不收（在排除名单里）
```

### 步骤 ④：计算 `pending`

```ts
const builtNotes = new Set(Object.values(cache).map(p => p.toLowerCase()));
const pending = libFiles.filter(f => !cache[f.fsPath] && !builtNotes.has(f.fsPath.toLowerCase()));
```

| 排除条件 | 原因 |
|---|---|
| `cache[f.fsPath]` 命中 | 这个源**已经构建过**（缓存键命中） |
| `builtNotes.has(...)` 命中 | 这个文件**本身是别人构建出来的笔记**（缓存值命中）⇒ 再当素材会「笔记→笔记」递归 churn |

**`pending.length === 0` 时**：写日志 + 发一条 Info 通知说明「为什么没东西可构建」，并 `return 0`
（原先此分支完全静默 ⇒ 用户点了按钮看不到任何反馈，看起来像命令失效）。

**例**：若 `库/raw/` 有 7 个 PDF 对应的 md 且都未构建 ⇒ `pending.length === 7`。

### 步骤 ⑤：逐篇 `buildOne()`（UI = 实例 `buildNotesFromLibrary`，见第 4 节）

```ts
const label = `批量构建 ${i + 1}/${pending.length}：${f.path.split('/').pop() ?? ''}`;
const notePath = buildOne
  ? await buildOne(f, label)                       // ← UI：agent 多轮（含自动回落）
  : await KbImportController._buildNoteCore(f, vaultRoot, fileService, configService,
      logService, notificationService, agentStudioService, requestService, label);  // ← 静态入口：直连
if (notePath) { built++; }
```

**串行**执行（agent 多轮成本高，串行也便于进度文案可读）；单篇失败只记日志、返回 `null`，`built` 不递增，**不影响后续文件**。

### 步骤 ⑥：`applyDeabstractionGating()` —— 统一收敛门控

```ts
static async applyDeabstractionGating(fileService: IFileService, libDir: URI): Promise<{ active: number; pending: number }>
```

| 项 | 内容 |
|---|---|
| **输入** | **笔记区**（`notesDir`）—— 笔记的新落点 |
| **输出** | `{ active, pending }` 两类的篇数（用于日志） |
| **规则** | 只作用于 `GATED_TYPES`（概念/对比/综合/实体等派生知识）；按 frontmatter `sources` 的**去重来源数**决定：`≥2 → status: active`，否则 `pending` |

**例**：`sources: [[raw/UI优化篇.md]]` 只有 1 个来源 ⇒ `status: pending`；
`sources: [[raw/A.md]], [[raw/B.md]]` ⇒ `status: active`。

最后 `reportProcessing(..., false)` 清进度，`return built`。

---

## 4. 单篇构建：`_buildNoteCore`

```ts
private static async _buildNoteCore(
  libFileUri: URI, vaultRoot: URI, fileService: IFileService, configService: IConfigurationService,
  logService: ILogService, notificationService: INotificationService,
  agentStudioService: IAgentStudioService, requestService?: IRequestService,
  progressLabel?: string,           // 批量传「批量构建 i/N：文件名」；单文件缺省「构建中：文件名」
): Promise<string | null>
```

**输入**：一篇素材的 URI（必须落在 `库/` 内，否则直接 `return null`）+ 服务集合。
**输出**：`Promise<string | null>` —— 产出的**首篇笔记的绝对路径**；失败/无产出 ⇒ `null`。

内部顺序：

| 步 | 调用 | 输入 → 输出 |
|---|---|---|
| 1 | `fileService.readFile(libFileUri)` | 素材 URI → 正文文本（**当纯文本用**） |
| 2 | `_getSchemaStatic(fileService, vaultRoot)` | vault 根 → `IKBSchema`（类型/id/label/dir 映射） |
| 3 | `_typeDirMapping(schema)` | schema → `{ typeToDir: Map<类型,目录>, defaultTypeDir }` |
| 4 | `_listEngineNoteDirs(fileService, notesDir)` | 笔记区 → **只含引擎产出**的目录清单（排除 `01_学习` 这类手写目录：数字前缀惯例 + 目录内必须有带 `sources`/`status` 的笔记） |
| 5 | `buildFileBlockPrompt(noteBaseDir, existingDirs)` | 落盘根 + 现有目录 → 提示词文本（要求「优先复用、必要时才新建」） |
| 6 | Stage 1「结构化分析」（LLM） | 素材 + schema + 目录候选 → 规划文本 |
| 7 | Stage 2「FILE 块生成」（LLM） | 分析 + schema + 素材 + 提示词 → 形如 `---FILE: 内存管理/GC机制.md --- …` 的文本 |
| 8 | `parseFileBlocks(gen, outputDir)` | 生成文本 + 落盘根 → `{ path, content }[]` |
| 9 | `_writeFileBlocks(...)` | 见下 |
| 10 | `cache[libFileUri.fsPath] = written[0]` + `_writeBuildCache(...)` | 记下「源 → 首篇笔记」 |
| 11 | `_injectSourcesIntoFiles(...)` | 把来源回链注入笔记 |
| 12 | `_enrichNewNotes(...)` | 确定性补链（把整词出现的其它笔记标题包成 `[[标题]]`） |
| 13 | `maintainKbNavigation(...)` | 刷新 `index.md` / `overview.md` / `insights.md` |
| 14 | `applyDeabstractionGating(fileService, notesDir)` | 单篇也收敛一次 |
| 15 | `agentStudioService.requestKbRefresh()` + 通知「笔记构建完成: …」 | 让视图刷新 |

### 4.1 `_writeFileBlocks` —— 真正落盘

```ts
private static async _writeFileBlocks(
  blocks: { path: string; content: string }[],
  notesDir: URI,                       // ← 笔记区（2026-09-23 起；此前是库）
  vaultRoot: URI,
  fileService: IFileService, logService: ILogService,
  typeToDir?: ReadonlyMap<string, string>, defaultTypeDir?: string,
): Promise<string[]>
```

| 项 | 内容 |
|---|---|
| **输入** | LLM 给出的 FILE 块数组 + 落盘根 + 类型目录映射 |
| **输出** | 实际写入的**绝对路径数组**（`written`） |

路径处理规则（关键）：

1. 去掉开头的 `/`、并剥掉模型可能带的 `笔记/` 前缀；
2. 首段若是 schema 类型目录（`概念/方法/…`）⇒ 视为类型前缀保留（**目录由 LLM 决定**，模型自选的目录一律尊重）；
3. **只有路径里完全没有目录**（裸文件名）时，才按 `frontmatter.type` → `defaultTypeDir` 兜底（防「笔记全部平铺」回归）；
4. 也**只在这种情况**下改路径 —— 旧实现会覆盖 LLM 按知识体系规划的目录，已修；
5. 越界（不在 vault 内）⇒ 跳过；同批次同名 ⇒ 自动改名 `xxx_2.md`。

**例**：

| LLM 输出的 `path` | 实际落盘 |
|---|---|
| `内存管理/GC机制分析.md` | `笔记/内存管理/GC机制分析.md` |
| `概念/UE5垃圾回收机制/UE5垃圾回收机制.md` | `笔记/概念/UE5垃圾回收机制/UE5垃圾回收机制.md` |
| `GC机制分析.md`（裸名） | `笔记/<defaultTypeDir>/GC机制分析.md` |

### 4.2 `_injectSourcesIntoFiles`

```ts
private static async _injectSourcesIntoFiles(
  fileService: IFileService, notePaths: string[], sourceRel: string,
): Promise<void>
```

| 项 | 内容 |
|---|---|
| **输入** | 刚写入的笔记路径 + 来源**相对「库」的路径**（如 `raw/UI优化篇.md`，由 `_relativeFromLib(libFileUri, libDir)` 算出） |
| **输出** | 无；副作用 = 在每篇笔记的 frontmatter `sources` 加上 `[[raw/UI优化篇.md]]` |

**例**：笔记 frontmatter 变为

```yaml
---
type: concept
title: UI优化技巧
sources:
  - "[[raw/UI优化篇.md]]"
---
```

> 该字段同时被「门控」（数来源个数）与「体检」（`missing-source` 检查来源是否还存在）消费。

### 4.3 `_enrichNewNotes`

```ts
private static async _enrichNewNotes(
  fileService: IFileService, allNotesDir: URI, writtenPaths: string[], logService: ILogService,
): Promise<void>
```

**输入**：笔记区 + 本次写入的路径（**只改本次新写的笔记**，不全库扫描，避免误伤）。
**输出**：无；副作用 = 把正文里整词出现的其它笔记 `title` 包成 `[[标题]]`（确定性补链，不需 LLM）。

### 4.4 `maintainKbNavigation`

```ts
static async maintainKbNavigation(fileService: IFileService, notesDir: URI, chatModel?: IChatModel): Promise<void>
```

内部并行刷新：`maintainKbIndex`（按 `type` 分组的索引）、`maintainKbOverview`、`maintainKbInsights`（有 `chatModel` 时附社区语义摘要，带指纹缓存）、以及 `refreshTopicOverviews`（目录摘要中间层，freshness ≥10% 才重算）。

**输出文件**：`笔记/index.md`、`笔记/overview.md`、`笔记/insights.md`（系统文件，`SYS_INDEX_FILES` 已在素材枚举里排除）。

---

## 5. 端到端举例（真实文件）

初始：

```
E:\VsSarosVault\
├─ .kb-build-cache.json      （空：{}）
├─ 库\raw\UI优化篇.pdf        （499 KB / 3 页）
└─ 笔记\01_学习\…              （用户手写目录）
```

点击 **批量构建库**：

```
① _stageDocSourcesToText
     库\raw\UI优化篇.pdf → 库\raw\UI优化篇.md（1806 字符 / 4 张图 → assets/UI优化篇/img-*.png）
② _readBuildCache                  → {} （无缓存）
③ _collectMdFiles(库, SYS_INDEX)   → [库\raw\UI优化篇.md]
④ pending                          → [库\raw\UI优化篇.md]（唯一素材）
⑤ buildOne → buildNotesFromLibrary(库\raw\UI优化篇.md, vaultRoot, { progressLabel: '批量构建 1/1：UI优化篇.md' })
     · agentic：以 knowledge-base-expert 跑一轮（技能注入 + 工具）→ 文本 FILE 块
     · 若无产出 / 抛错 ⇒ **自动回落**直连管线（STAGE1 分析 + STAGE2 FILE 块）
     · _listEngineNoteDirs(笔记) → []      （01_学习 被排除：数字前缀 + 无引擎字段）
     · buildFileBlockPrompt(笔记, []) → "笔记区目前为空，可自行规划顶层目录"
     · LLM 产出 FILE 块：---FILE: UI优化与性能/UI优化技巧.md ---
     · _writeFileBlocks → 笔记\UI优化与性能\UI优化技巧.md
     · 缓存 → { "…\库\raw\UI优化篇.md": "…\笔记\UI优化与性能\UI优化技巧.md" }
     · 注入 sources: - "[[raw/UI优化篇.md]]"
     · 补链 / 导航 / 门控（1 个来源 ⇒ status: pending）
⑥ applyDeabstractionGating(笔记) → { active: 0, pending: 1 }
```

最终：

```
E:\VsSarosVault\
├─ .kb-build-cache.json   { "…\\库\\raw\\UI优化篇.md": "…\\笔记\\UI优化与性能\\UI优化技巧.md" }
├─ 库\raw\UI优化篇.pdf / .md / assets\UI优化篇\img-01..04.png
└─ 笔记\UI优化与性能\UI优化技巧.md     ← 本次产物
```

再次点击：`cache[源]` 命中 ⇒ `pending = []` ⇒ 通知「批量构建：『库』中没有待构建的素材。」，返回 0。

---

## 6. 两条构建路径的差异（重要）

| | 批量构建（本按钮） | 单文件右键「构建为笔记」 |
|---|---|---|
| 入口 | 视图 `_batchBuildAll()` → **实例** `this._kbImport.buildAllPendingNotes()` | 视图右键 → 控制器实例 |
| 主体 | 实例 `buildNotesFromLibrary()` | 实例 `buildNotesFromLibrary()`（同左） |
| 是否走 agent | **是**（`AGENT_STUDIO_KB_AGENTIC_BUILD !== false`，默认开） | 是（同口径） |
| 回退 | agent 无产出 / 抛错 ⇒ 自动回落 `_buildNoteCore()`（直连） | 同 |
| 落点 / 收口 | 完全相同（笔记区 + 缓存 + sources + 补链 + 导航 + 门控） | 同 |

> ★ 2026-09-23：批量已与单文件**对齐到同一条路径**（此前批量走静态 `_buildNoteCore`，不跑 agent）。
> 想退回便宜的旧模式：把 `AGENT_STUDIO_KB_AGENTIC_BUILD` 显式设为 `false`，两条路径会一起退回直连管线。

---

## 7. 构建过程的聊天会话（★ 2026-09-23 新增）

用户要求：「构建过程在聊天框中打开知识库专家 agent 的一个新 session」。实现要点：

| 环节 | 做法 | 为什么必须这样 |
|---|---|---|
| 建会话 | `IAgentChatService.createAgentSession('knowledge-base-expert', '知识库构建 · 09-23 14:05')` | 只有**真实登记**的会话才会出现在聊天框的会话列表中（临时 id 用户找不到） |
| 开页签 | `NativeChatEditorInput.create(undefined, agentId, sessionId, name)` + `IEditorService.openEditor(input, { pinned: true })` | 每次 `create` 生成**唯一 chatId** ⇒ 新页签；页签必须绑定**同一个 sessionId**，否则 `nativeChatEditorPane` 的守卫（`_currentSessionId !== sessionId` ⇒ return）会忽略广播 delta |
| 跑这一轮 | `IAgentChatService.sendMessage(agentId, prompt, { agentSessionId, chatOnly: true, temperature: 0.3 }, onDelta)` | ⚠ **`IAgentDriverService.executeFromChatOptions` 只产流**：不落历史、不广播任何事件 ⇒ 哪怕传真实 sessionId，聊天框里也**什么都看不到**。`sendMessage` 内部会落 user/assistant 消息 + fire `onDidStreamDelta` ⇒ 已打开且绑定同一会话的页签走「外部接管」分支**实时渲染** |
| 收集产出 | 仍从 `onDelta` 累积 `text` / `content_replace` / `discard_prior_text` | 与旧实现**逐字符同源**；不依赖 `sendMessage` 的返回值（它是 Hermes 回合边界拼装的，未必等价） |
| 生命周期 | 批量 = 整批**一个**会话；单文件 = **每次新建** | 对应用户「构建过程（一个）新 session」的表述 |
| ⚠ 上下文保护 | 同一会话跑**下一个素材之前**先 `replaceHistory(agentId, sessionId, [])` | `sendMessage` 会把该会话**全量历史**当 `priorMessages` 下发（只剔"当前这条 user"）⇒ 不清空就会把前面素材的**整份原文 + 整份产出**再喂一遍：平方级膨胀，且模型很可能**重复输出前几个文件的 FILE 块**（写出重复笔记） |
| 兜底 | 没有 chat 服务（单测）/ 建会话失败 ⇒ 旧 headless 行为 | 构建本身不受影响，只是过程不可见 |

> 依赖注入：视图自持的控制器实例多注入了一个 `IAgentChatService`（`nativeChatEditorPane` 也一并传入）；
> 且**单文件右键「构建为笔记」已从静态直连版改为实例版** —— 否则它既不跑 agent、也不会开可见会话。

## 8. 批量：agent 自主读写（★ 新默认路径，2026-09-23）

入口：`KbImportController.buildPendingAsAgentSession(vaultRootUri?)`（视图「批量构建库」按钮调它）。

```
buildPendingAsAgentSession()
 ├─ _collectPendingSources()            ← 与旧路径共用的 pending 计算（前置转文本 + 缓存 + 枚举 + 过滤）
 ├─ _ensureKbBuildChatSession()         ← 新建并打开「知识库构建 · MM-DD HH:mm」会话（见 §7）
 ├─ _getSchemaStatic()                  ← 确保 <vault>/kb-schema.json 存在（agent 会自己 file_read 它）
 ├─ 快照：_collectMdFiles(笔记/)         ← 用于事后 diff
 ├─ Phase 1  sendMessage(素材清单 + 目录树 + 硬约束, {agentSessionId, explicitSkillIds:['kb-build']})  ← ⚠ 不传 chatOnly
 ├─ Phase 2  sendMessage(一句话触发技能的 Phase 2, 同 options)
 └─ 收尾：找出产出 → 回填缓存(靠 frontmatter sources) → 补链 → 门控 → 导航 → 通知
```

> ★ 2026-09-23（用户要求「构建时发送太多消息 ⇒ 抽象成技能」）：**规则全部移进技能 `kb-build`**
> （`resources/.agents/skills/kb-build/SKILL.md`），两条消息只带**数据**：
> Phase 1 = 素材清单 + 目录树快照 + 三条硬约束摘要；Phase 2 = 一句话触发。
> 技能经 `explicitSkillIds` 挂载（driver 把它作为独立 user message 注入本轮）⇒ 消息体积从「整份手册」降到「触发 + 数据」。
> ⚠ 同步指针：改流程时 `SKILL.md` 与 `_kbAgentBuildPrompt` **两边同步**（两处都写了同样的指针注释）。

### 与旧路径的本质差异

| | 旧（`_buildAllPendingCore`） | 新（`buildPendingAsAgentSession`） |
|---|---|---|
| 素材内容谁读 | **宿主** `readFile` 后塞进 prompt | **agent 自己**用 `file_read` 读（宿主只给路径） |
| 笔记谁写 | **宿主** 解析 FILE 块后 `_writeFileBlocks` | **agent 自己** `file_write` / `patch` |
| `chatOnly` | `true`（禁写工具） | **必须省略/false** —— `chatOnly:true` 会把 `file_write`/`patch` 从 enabledTools 里过滤掉 ⇒ agent 根本写不了盘 |
| 一次 prompt | 一个素材一条 | **全部素材一条**（清单） |
| 产出识别 | 解析文本 FILE 块 | ①流里 `file_write` 的结果串 `wrote N chars to <path>`；②`笔记/` 目录前后 diff |
| 体系文档 | 无（只有宿主生成的 index/overview/insights） | Phase 2 由 agent 依据真实目录/文件写 `笔记/知识体系.md`（已加入 `SYS_INDEX_FILES`） |

### 可行性的三个前提（已核实）

1. **工具白名单**：`builtinAgents.ts` 里 `knowledge-base-expert` 的 `tools` = `['file_write','file_read','search_files','terminal','kb_search','vision_analyze']`
   ⇒ 读 + 写 + 列目录都有（**没有** `list_dir`/`glob`：列目录用 `search_files`，改文件用 `patch`）。
2. **路径沙箱**：`workspaceSecurity.resolveAndCheckWorkspacePathImpl` 的 allowedRoots 含
   KB 存储根 / `agentStudio.kb.kbDir` / **`agentStudio.kb.vaults[].customPath`** ⇒ **vault 已注册就能写**；
   未注册的路径会被拒（弹「安全沙箱限制」卡片，不会静默写）。
3. **审批**：沙箱内、非删除类写默认**免审批**（`toolApprovalPolicy` 的 `edit: auto` + `toolExecutionGuard` 的
   `isSandboxFileWriteAutoApproved`）⇒ 无人值守可跑完。⚠ `terminal` 属 execute 档会弹审批 ⇒ 提示词里**明确禁用**。

### 其他要点

- **素材数量封顶 20/次**（`MAX_ASSETS`）：无人工介入的长任务，剩的下次构建继续处理（仍在 pending 里）。
- **降级**：没有 chat 服务 / 会话建不出来 ⇒ 自动回落 `buildAllPendingNotes`（宿主逐篇落盘），返回 `usedFallback: true`。
- **缓存回填**：agent 直接写盘后，宿主只能靠**新笔记自己的 frontmatter `sources`** 反查来源（`normalizeSourceRef` 口径，
  与门控/体检一致）；`知识体系.md` 不算笔记 ⇒ 不参与缓存与补链。

### 落点规则（★ 2026-09-23 用户要求变更）

| 要求（用户原话） | 实现 |
|---|---|
| **产物应该满足 schema 的类别** | frontmatter `type` **必须取自 schema**（`buildSchemaPromptText` 注入到 prompt 的「Schema 类型定义」段）；schema 的 `dir` **只作最后兜底**，禁止为每个 type 各建一套并行目录树 |
| **根据笔记中已有的目录结构…在对应目录下更新或者新建** | 宿主用 `_describeNoteTree(笔记)` 渲染**全量目录树**（**含用户手写层级**，深度 ≤4、行数 ≤400、每目录最多列 6 个文件名）塞进 Phase 1 prompt；并给出硬规则：**能复用就绝不新建目录**、目标文件已存在就 `patch` **就地更新**（不新建 `xxx_2.md`）。示例落点：`笔记\01_学习\UnrealEngine\09_UI与Slate\UI优化技巧.md` |
| Phase 2 体系文档也要贴合层级 | prompt 增加「文档必须按真实目录层级组织（含用户手写目录），不要凭空发明目录」 |

> ⚠ **与旧口径相反，记录矛盾点**：`_listEngineNoteDirs()` 的注释记载的是**当时**的用户要求 ——
> 「只把 LLM 自己建的目录作为候选，不要把技术笔记塞进用户自己的分类体系（01_学习…）」。
> 2026-09-23 用户明确要求**反过来**（落点复用他自己的层级）。因此：
> · 新路径（默认）：目录树来自 `_describeNoteTree`，**全量**目录（手写区也进树）；
> · 旧路径（降级/单文件右键）：候选目录由 `_listEngineNoteDirs`（只含引擎产出）改为 **`_listAllNoteSubdirs` 全量**，
>   只是把**引擎产出目录排前面**（`[...engineDirs, ...all.filter(...)]`）；
> · `_listEngineNoteDirs()` 本体**保留**（单测在引用它，且它记录了旧口径）。
> 顺手修掉单文件 agentic 路径的一处**基线不对称**：`buildFileBlockPrompt` 的基线原为 `libDir`（库），
> 而 `parseFileBlocks` 的锚点是**笔记区** ⇒ 模型按「相对库」写路径、解析却按「相对笔记区」，会产出嵌套错位目录。

### 完善与重构（★ 2026-09-23 用户要求：体系归用户，LLM 可完善补充、甚至重构）

| 权限 | 落地方式 |
|---|---|
| **用户自建分类体系** | 是**基础**：`_describeNoteTree` 把真实目录树喂给 agent，落点优先复用（见上表） |
| **LLM 完善补充** | 允许在既有层级下**新建子主题目录**（命名沿用同级风格，如已有 `01_核心系统`…`08_音频系统` ⇒ 新建 `09_xxx`） |
| **LLM 重构（小规模，≤10 项）** | **直接调用 `kb_organize` 工具**（★ 2026-09-23 新增，见下）—— agent **自己动手**：笔记区限定；执行前 checkpoint + vault 外备份；聊天页签 `undoAll` 可回滚 |
| **LLM 重构（大规模，>10 项）** | `KB_REORG` 计划通道（LLM 出计划 → 宿主校验 → 备份 → 用户确认 → 执行）—— 大批量先给用户看一眼再动 |

**`kb_organize` 工具（`providers/tool/kbOrganizeTools.ts`）的设计**：

| 设计点 | 实现 |
|---|---|
| 域限定 | 只允许在「笔记/」内操作（前缀校验 + 拒绝 `..`）⇒ 「库」与 vault 其它内容不可达 |
| 可回滚（双保险） | ① 每个涉及文件执行前 `checkpointService.captureBeforeToolEdit` ⇒ 聊天页签 `undoAll`/`openDiff`（**复用现有 checkpoint 体系**，此前它只挂 `file_write`/`patch`）；② 每个文件备份到 **vault 之外**的 `<vault 名>-backup-kborganize-<ts>/` —— **备份失败就跳过该项**（没有还原点就不动手） |
| 不覆盖 | `to` 已存在 ⇒ 拒绝该项（跳过并报告） |
| 回收站语义 | `deletes` **不是真删除**，而是**移入备份目录**（对齐 Aider 的可恢复删除，但不需要 git） |
| 免审批 | `category: 'filesystem'` + `securityLevel: Dangerous` ⇒ 沙箱内写默认 `edit: auto`（与 `file_write` 同口径）⇒ 无人值守不被审批卡住 |
| 可观测 | 结果里带一行 `KB_ORGANIZE_RESULT {json}`；`buildPendingAsAgentSession` 的 `onDelta` 解析它 ⇒ **同步修正 `.kb-build-cache.json`**（被移动笔记的旧路径改指新路径） |
| 上限 | 单次 ≤ 50 项操作 |

**重构流水（`KB_REORG`）**

```
Phase 2 文本末尾（agent 输出）
  <!-- KB_REORG
  {"reason":"…","moves":[{"from":"笔记/UI优化技巧.md","to":"笔记/01_学习/UnrealEngine/09_UI与Slate/UI优化技巧.md"}]}
  -->
        ↓ 宿主 _parseReorgPlan() 校验（不通过即跳过该项，绝不猜）
   · from/to 都必须在**笔记区**内（保护「库」与 vault 其它内容）
   · from 必须已存在、to 必须尚不存在（避免覆盖）
   · 拒绝含 `..`；from === to 跳过；最多 50 项（KB_REORG_MAX_MOVES）
        ↓ notificationService.prompt('应用重构' / '跳过')      ← 用户确认（非模态、回调式 run()）
   _applyReorgPlan()
   ① copy 备份 → `<vault 父目录>/<vault 名>-backup-kbreorg-<ts>/…`（**vault 之外**，否则会出现在文件树里且可点开）
      ⚠ **备份失败就不搬这个文件**（宁可少搬，也不能让用户失去还原能力）
   ② createFolder(dirname(to)) + move(from, to)
   ③ 修正 `.kb-build-cache.json`：值指向被移动笔记的条目改指新路径（否则下次构建按幽灵路径跳过）
   ④ 重跑 maintainKbNavigation + applyDeabstractionGating + requestKbRefresh，并通知「移动 N 项 / 备份位置 / 失败项」
```

> 另有两条 prompt 层面的硬约束（避免模型"曲线搬运"）：**不要**用 `file_write` 复制一份再想办法删旧的（它没有删除工具），
> 搬运一律走 `KB_REORG` 计划；整个构建过程只允许 `file_read / file_write / patch / search_files / vision_analyze`。

## 9. 单文件构建的完整调用流水（含每阶段产出）

示例素材：`E:\VsSarosVault\库\raw\UI优化篇.md`（由 `UI优化篇.pdf` 前置转换而来：3 页 / 1806 字符 / 4 张图）。

### 9.1 默认路径：agent 自主读写（`buildPendingAsAgentSession`，pending = 1 份时即"单文件"）

| # | 步骤 / 调用 | 输入 | **产出（样例）** | 谁做 |
|---|---|---|---|---|
| 0 | `_stageDocSourcesToText()` | `库/raw/UI优化篇.pdf` | `库/raw/UI优化篇.md`（1806 字符）+ `库/raw/assets/UI优化篇/img-01..04.png`；头部注释 `> 来源：…（提取后端：pymupdf4llm，共 3 页，提取图片 4 张）` | 宿主 → 主进程 python |
| 1 | `_readBuildCache()` | `<vault>/.kb-build-cache.json` | `{}`（首次） | 宿主 |
| 2 | `_collectMdFiles(库, SYS_INDEX_FILES)` → 过滤 | 库内全部 `.md` | `pending = ['…\库\raw\UI优化篇.md']` | 宿主 |
| 3 | `_ensureKbBuildChatSession()` | agentId + 标题 | `createAgentSession('knowledge-base-expert', '知识库构建 · 09-23 14:05')` → `sessionId`；`NativeChatEditorInput.create(...)` + `openEditor(pinned)` → **聊天页签** | 宿主 |
| 4 | `_collectMdFiles(笔记)`（快照） | 笔记区 | `before = {'…\笔记\01_学习\…'}`（仅用于事后 diff） | 宿主 |
| 5 | **Phase 1 prompt**（`_kbAgentBuildPrompt`） | 素材路径清单 + `_describeNoteTree(笔记)` 的真实目录树 + schema 文本 | 文本形如：<br>`## 待构建素材（共 1 份…）`<br>`1. 素材文件：E:\VsSarosVault\库\raw\UI优化篇.md`<br>`   （笔记 frontmatter 的 sources 写：raw/UI优化篇.md）`<br>`## 笔记区现有目录树（落点必须优先复用这里的目录）`<br>`- 01_学习/  （12 篇：…）`<br>`  - UnrealEngine/  （9 篇：…）`<br>`    - 09_UI与Slate/  （3 篇：UI优化技巧.md、…）`<br>`## 落点规则（严格遵守 —— 用户明确要求）`… `## Schema 类型定义` … | 宿主 |
| 6 | **agent 工具轮次**（会话里实时可见） | 上面那份 prompt | ① `file_read("E:\VsSarosVault\库\raw\UI优化篇.md")` → 正文<br>② 可选 `vision_analyze` × 4（逐张图片）/ `search_files` 复核目录<br>③ `file_write("E:\VsSarosVault\笔记\01_学习\UnrealEngine\09_UI与Slate\UI优化技巧.md", "---\ntype: method\ntitle: UI优化技巧\nsources:\n  - \"[[raw/UI优化篇.md]]\"\n---\n…")`<br>→ 工具结果 `wrote 2143 chars to E:\VsSarosVault\笔记\01_学习\UnrealEngine\09_UI与Slate\UI优化技巧.md` | **agent** |
| 7 | 宿主 `onDelta` 收工具结果 | `tool_end` / `tool_result` 的 `content` | `toolWrites = {'E:\VsSarosVault\笔记\01_学习\UnrealEngine\09_UI与Slate\UI优化技巧.md'}`（正则 `wrote N chars to <path>`，且必须落在笔记区内） | 宿主 |
| 8 | **Phase 2 prompt**（`_kbSystemDocPrompt`） | 笔记区路径 | 同会话再跑一轮：`search_files(笔记/)` → `file_write(笔记\知识体系.md)` → 结果 `wrote … to …\笔记\知识体系.md` | agent |
| 9 | 产出归集 | `toolWrites` ∪ `笔记/` 前后 diff | `written = {…\笔记\UI优化与性能\UI优化技巧.md, …\笔记\知识体系.md}`；`systemDoc = …知识体系.md`；`notePaths = [UI优化技巧.md]`（`知识体系.md` 在 `SYS_INDEX_FILES` 里 ⇒ **不算笔记**） | 宿主 |
| 10 | 缓存回填 | 每篇新笔记的 frontmatter | 读笔记 → `extractSources()` → `['raw/UI优化篇.md']` → `normalizeSourceRef()` → `ui优化篇.md` → 命中 pending ⇒ 写 `cache['…\库\raw\UI优化篇.md'] = '…\笔记\01_学习\UnrealEngine\09_UI与Slate\UI优化技巧.md'` → `_writeBuildCache` 落 `.kb-build-cache.json` | 宿主 |
| 11 | `_enrichNewNotes(笔记, notePaths)` | 本次新写的笔记 | 正文里整词出现的其它笔记标题被包成 `[[标题]]`（**只改本次产物**，不全库扫描） | 宿主 |
| 12 | `applyDeabstractionGating(笔记)` | 笔记区 | 该笔记 `sources` 只有 1 个来源 ⇒ `status: pending`；返回 `{active: 0, pending: 1}` | 宿主 |
| 13 | `maintainKbNavigation(笔记, chatModel)` | 笔记区 | 重写 `笔记/index.md`（按 `type` 分组全量 `[[rel\|name]]`）、`笔记/overview.md`（各 type 篇数 + 主题分布）、`笔记/insights.md`（Louvain 社区 + 可选语义摘要）、各主题 `.overview.md` | 宿主 |
| 14 | `requestKbRefresh()` + 通知 | — | 通知：`知识库构建完成（agent 自主读取素材并写盘）：新增/更新 1 篇笔记，并已创建/完善知识体系文档` | 宿主 |
| 15 | 返回视图 | `{pending:1, built:1, skipped:0, systemDoc, usedFallback:false}` | 徽标「有新增 1」+ 刷新「笔记」「库」两分区 + 搜索索引置脏 | 视图 |

> 关键点：**第 6 步是 agent 干的**——宿主全程没读过素材内容、也没写过笔记文件；它只给路径、收工具结果、做事后收尾。

### 9.2 降级 / 直连路径：`_buildNoteCore`（宿主读文件 + 解析 FILE 块 + 宿主落盘）

触发场景：`_agentChatService` 缺失、会话建不出来、`AGENT_STUDIO_KB_AGENTIC_BUILD = false`，
或静态入口 `KbImportController.buildNotesFromLibrary(uri, vaultRoot, deps)`。

| # | 步骤 / 调用 | 输入 | **产出（样例）** |
|---|---|---|---|
| 1 | 前置校验 | 素材 URI | 不在 `库/` ⇒ `return null`；`reportProcessing(true, '构建中：UI优化篇.md')`；`SYS_INDEX_FILES` 命中 ⇒ 提示「系统导航文件，无需构建」 |
| 2 | `_readBuildCache` 命中检查 | 缓存条目 | 命中且笔记**存在** ⇒ 直接返回该路径（通知「已构建: …」）；**不存在** ⇒ 逐出该条目并重写缓存（避免幽灵路径） |
| 3 | Provider / 模型检查 | 配置 | `isKbChatProviderAvailable()` / `_resolveKbChatModel()` 失败 ⇒ 通知「知识库专家未配置」+ `return null` |
| 4 | 读素材 + 取 schema | `libFileUri` | `libContent`（1806 字符）；`buildSchemaPromptText(schema)`（8 个类型的定义文本）；`_typeDirMapping()` ⇒ `{typeToDir: Map, defaultTypeDir: '杂记'}` |
| 5 | 目录候选：`_listEngineNoteDirs(笔记)` + `_listAllNoteSubdirs(笔记)` | 笔记区 | `engineDirs = []`（首次还没有引擎产出目录）、`allDirs = ['01_学习', '01_学习/UnrealEngine', …]` ⇒ `dirCandidates` = **全量、引擎目录优先**（★ 2026-09-23 起：允许落进用户手写层级） |
| 6 | **Stage 1** `_runStage1Analysis(...)` | `libContent` + schemaText + 候选目录 | `analysis` = 规划文本（要产出哪些笔记、归属类型/目录、拆分粒度） |
| 7 | `buildFileBlockPrompt(笔记, dirCandidates)` | 落盘根 + 候选 | `formatHint` = FILE 块格式说明（含「优先复用现有目录、必要时才新建」） |
| 8 | **Stage 2** `chatModel.complete(STAGE2_SYSTEM, genPrompt, 0.3)` | 规划 + schema + 素材 + formatHint | `gen` = 含 `---FILE: … ---` 块的完整文本 |
| 9 | `parseFileBlocks(gen, 笔记)` | `gen` + 基准目录 | `[{path: 'UI优化与性能/UI优化技巧.md', content: '…'}]`（剥 ``` 围栏；`isSafePath` 拦截穿越/绝对路径；跳过空块） |
| 10 | `_writeFileBlocks(blocks, 笔记, vault, …, typeToDir, defaultTypeDir)` | 块数组 | `written = ['…\笔记\UI优化与性能\UI优化技巧.md']`（路径规则：剥 `笔记/` 前缀 → 首段是类型目录则保留 → **仅裸文件名**才按 `type` 兜底到 `defaultTypeDir`；同批次重名 ⇒ `xxx_2.md`；越界跳过） |
| 10′ | 块为 0 时的兜底 | `gen` | `_parseLibCategory` + `_sanitizeFsName` → `_salvageSingleNoteToDir(gen, …, 笔记)`，把模型原始输出落成**一篇**笔记；仍为 0 ⇒ 通知「LLM 未生成可写笔记…」+ `return null` |
| 11 | 写缓存 | `written[0]` | `cache['…\库\raw\UI优化篇.md'] = '…\笔记\UI优化与性能\UI优化技巧.md'` ⇒ `.kb-build-cache.json` |
| 12 | `_injectSourcesIntoFiles(written, 'raw/UI优化篇.md')` | 笔记路径 + 来源相对路径 | 每篇 frontmatter 追加：<br>`sources:`<br>`  - "[[raw/UI优化篇.md]]"` |
| 13 | `_enrichNewNotes` / `maintainKbNavigation` / `applyDeabstractionGating` | 笔记区 | 与 §9.1 第 11–13 步**完全相同**（补链、index/overview/insights/主题 overview、`status` 门控） |
| 14 | 收尾 | — | `requestKbRefresh()` + 通知「笔记构建完成: …」→ `return written[0]` |

### 9.3 单文件右键「构建为笔记」的另一条分支：`_buildNoteAgentic`

实例 `buildNotesFromLibrary()` 在 `AGENT_STUDIO_KB_AGENTIC_BUILD !== false`（默认开）时先试 `_buildNoteAgentic`：

| | 读素材 | 提炼 | 写盘 | 过程可见 |
|---|---|---|---|---|
| `_buildNoteAgentic`（单文件右键） | **agent** 之外：宿主把**整份原文塞进 prompt** | **agent 多轮**（`chatOnly: true`） | **宿主**（解析 agent 回传的 FILE 块） | 聊天页签可见（§7） |
| `buildPendingAsAgentSession`（批量，§9.1） | **agent**（`file_read`，宿主只给路径） | **agent 多轮**（允许写工具） | **agent**（`file_write`） | 聊天页签可见 |
| `_buildNoteCore`（降级/直连，§9.2） | 宿主 | 2 次直连 LLM（非 agent） | 宿主 | 不可见 |

> 三条路径的**最终产物形态一致**：都落 `笔记/`、都有 `sources` frontmatter、都经缓存/补链/门控/导航收尾；
> 差别只在「谁读、谁写、过程能不能看见」。
>
> ⚠ 2026-09-23 顺手修正（`_buildNoteAgentic`）：它的 `buildFileBlockPrompt` 基线原为 `libDir`（库），
> 而 `parseFileBlocks` 的锚点是**笔记区** ⇒ 模型按「相对库」写路径、解析却按「相对笔记区」，会产出嵌套错位目录。
> 已改为 `notesDir`，并传入**全量目录候选**（引擎优先）以复用既有结构。

### 9.4 每阶段产出总表

| 阶段 | 产出物 | 落点 | 执行者 | 可见性 |
|---|---|---|---|---|
| 素材前置转换 | 同名 `.md` + `assets/<素材名>/img-*.png` | `库/` | 宿主驱动主进程 python | 库文件树 |
| 素材清单 | pending 数组 | 内存 | 宿主 | —（无待构建时发通知） |
| 构建会话 | 聊天会话 + 页签 | 聊天视图 | 宿主 | **聊天框实时可见** |
| 读取素材 | 会话里的 `file_read` 工具卡 | 会话历史 | agent | 聊天框 |
| 图片理解 | `vision_analyze` 工具卡 / 图片要点文本 | 会话历史 | agent | 聊天框 |
| 笔记正文 | `笔记/<已有目录（含手写层级）>/<笔记名>.md`（能复用就绝不新建目录） | **笔记区** | agent（新路径）/ 宿主（旧路径） | 文件树 + 预览 |
| 溯源 | frontmatter `sources:` | 笔记内 | agent（按指令）/ 宿主注入 | 笔记预览 |
| 构建缓存 | `{素材绝对路径: 笔记绝对路径}` | `<vault>/.kb-build-cache.json` | 宿主 | —（决定下次是否跳过） |
| 补链 | 正文里的 `[[其它笔记标题]]` | 本次新写的笔记 | 宿主（确定性，无需 LLM） | 笔记预览 / 图谱 |
| 门控 | frontmatter `status: active \| pending` | 笔记内 | 宿主 | 笔记预览 / 体检 |
| 导航文档 | `index.md` / `overview.md` / `insights.md` / 主题 `.overview.md` | 笔记区 | 宿主（insights 可选 LLM 摘要） | 笔记区系统文件 |
| **知识体系文档** | `笔记/知识体系.md`（目录总览 + 学习路径 + 知识缺口） | 笔记区 | **agent**（Phase 2） | 笔记区 |
| 收尾反馈 | 通知 + 徽标 + 视图刷新 + 搜索索引置脏 | UI | 宿主 + 视图 | 通知 / 徽标 |

## 10. 排障速查

| 现象 | 先看这里 |
|---|---|
| 点了没反应 | 是否无待构建素材（`pending=0` 会发 Info 通知）；`kbAgentConfigState === 'missing'` 会提前中止并提示 |
| 笔记没出现在「笔记」分区 | 产物落 `笔记/`；若在 `库/` 说明该笔记是**旧版**构建（落点变更前）或外部遗留 |
| 该构建的素材被跳过 | `.kb-build-cache.json` 里是否有它的条目；若有但素材**被改过**（素材 mtime > 笔记 mtime）⇒ 会**自动重建**（`_cacheEntryFresh`，2026-09-24 起）|
| 目录乱 / 全平铺 | `buildFileBlockPrompt` 是否拿到了目录候选（`_listEngineNoteDirs` 只给「有引擎产出」的目录）|
| 来源显示失效 | 来源是**库内相对路径**；体检扫描根是笔记区、`sourceRoot` 传「库」 | 
