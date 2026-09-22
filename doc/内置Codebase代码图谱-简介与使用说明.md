# 内置 Codebase（代码知识图谱 / Codebase Memory）

> **一句话**：VsSarosis 内置的代码知识图谱能力 —— 用 VS Code 自带的 tree-sitter WASM 把工作区源码解析成「节点 + 边」的结构化图，落盘到 `<索引根>/.codebase-memory/`，并以 **18 个内置工具**直接提供给 Agent（同时提供 3D 图谱与架构分析 UI）。**零外部二进制、零安装、零 MCP 中转。**
>
> 本文档分两部分：**一、简介**（对比其他方案存在的问题，以及我们如何解决）；**二、使用说明**（详细操作步骤）。

---

## 一、简介

### 1.1 它是什么

```
工作区源码
   │  文件扫描（排除集：档位 core/balanced + .cbmignore + .code-workspace 排除项）
   ▼
tree-sitter WASM 解析（Worker 池并行，每文件 15s 超时）
   │  AST 遍历 → 符号/关系提取
   ▼
内存图 GraphStore（节点：project/folder/file/class/function/… 边：CONTAINS/CALLS/INHERITS/IMPLEMENTS/USAGE/…）
   │  可选跨文件 LSP 类型推断 / 复杂度与热路径指标 / 克隆检测 / 社区检测(Leiden)
   ├──────────────► 落盘制品：.codebase-memory/graph.db.zst（+ artifact.json，可选 graph.db.sqlite）
   │                        │
   │                        └──► 主进程 SQLite + FTS5（承担检索，避免内存全量扫描）
   │
   └──► 文件 watcher（5s~60s 自适应轮询）→ 增量索引（mtime + size 分类）
                                      │
                                      ▼
                          18 个内置 Agent 工具（search_graph / query_graph / trace_path / …）
                                      │
                                      ▼
                          3D 图谱 Viewer / Codebase Memory 面板（人也能看）
```

三条关键设计约束：

1. **解析用 VS Code 内置的 tree-sitter WASM**，不拉起任何外部进程、不依赖网络与 API Key；
2. **索引配置与图谱制品固定在 `<索引根>/.codebase-memory/`**，可随仓库分发（Git 团队共享 / artifact 导出导入）；
3. **Agent 侧不需要 MCP 服务器中转** —— codebase 工具由 `builtinToolProvider._registerCodebaseTools()` 直接注册，直连 `ICodebaseGraphService`。

### 1.2 其他做法存在的问题

| 方案 | 存在的问题 |
| --- | --- |
| **外部 `codebase-memory-mcp`（C 版 exe）** | ① 需要下载/安装/升级一个外部二进制，跨平台分发与杀软拦截都是问题；② 版本漂移（工具 schema 与产品内置能力脱节）；③ 必须通过 MCP stdio 协议中转，链路长、故障面大；④ 二进制与 IDE 之间无 UI 集成，用户只能靠 Agent 盲调；⑤ 程序内部产物对用户不可见、无法排查。 |
| **grep / ripgrep 纯文本检索** | 只能答「哪里出现了这个字符串」，答不了「谁调用了这个函数」「改动会影响哪些模块」「这个类实现了哪些接口」——文本匹配没有语义、没有方向、没有跨文件关系，且在大仓上结果噪音大。 |
| **语言服务器（LSP：clangd / cpptools / gopls…）** | ① 每种语言都要单独装并配置一个语言服务器，未装即失效（C++ 工程尤其常见「项目里根本没有 clangd/cpptools」）；② 作用域通常限于已打开/已编译的文件，跨仓库、全库架构视角几乎没有；③ 冷启动与索引编译数据库（compile_commands.json）依赖强，大型工程动辄失败。 |
| **向量检索 / Embedding / GraphRAG** | ① 需要额外的 embedding 模型或向量库，离线环境、内网、无 Key 场景直接不可用；② 索引成本高（切片 + 逐块向量化，大仓几十分钟起步）且模型版本变化后需重建；③ 结果不可解释 —— 只能给出「相似」，无法保证「调用链完整」；④ 检索到的碎片需要再喂给模型拼装，token 开销大。 |
| **云端代码索引服务** | 源码必须上传出企业内网，合规上过不去；且离线/内网环境下不可用。 |

此外，上述方案普遍缺少**工程化护栏**：大仓库一次全量索引就把渲染进程撑到 OOM、同步解压大图就把窗口卡死几十秒、索引中断后留下「残缺 → 全量 → 中止 → 仍残缺」永不收敛的死循环。

### 1.3 我们如何解决

| 上游问题 | 我们的解法 |
| --- | --- |
| 外部二进制 / MCP 中转 | **全部内置**：解析器用 VS Code 已捆绑的 tree-sitter WASM，工具由 `builtinToolProvider` 直接注册（`category: 'codebase'`、`source: 'saros.builtin-tools'`）。2026-07-03 起已移除外部二进制与 MCP 中转逻辑，Agent 调 `search_graph` 即直达 `ICodebaseGraphService`。 |
| 文本匹配无语义 | **结构化知识图谱**：AST 提取函数/类/方法/文件/包/服务节点与 CONTAINS / CALLS / INHERITS / IMPLEMENTS / USAGE / CROSS_* 等边，支持调用链追踪（`trace_path`）、结构查询（Cypher 子集 `query_graph`）、影响面分析（`detect_changes`）。 |
| LSP 依赖重、覆盖差 | **单一解析器覆盖 11 类语言**（TS/JS/Python/Go/Rust/Java/Ruby/C/C++/C#/PHP），无需任何外部语言服务器；C++ 在无 clangd/cpptools 时也能做「跳转定义/查找引用」（图谱兜底）；同时在非 fast 模式下保留**跨文件 LSP 类型推断**作为增强，两者互补。 |
| Embedding / GraphRAG 的成本与不可解释性 | **自研 6 信号融合语义检索**（`semanticSearch`：符号名/限定名/注释文档/路径/图结构/热度等信号加权融合 + 词级 min-score 重排），**不使用 embedding、不需要向量库**：离线可用、零额外索引成本、结果可解释、可控 token 预算（`max_output_tokens`，1 token ≈ 4 字符，TOON 紧凑输出再省约 60%）。 |
| 云端索引的合规问题 | **完全本地**：图谱就是工作区里的 `.codebase-memory/graph.db.zst`，团队共享走**企业内网 Git 仓库**或 `export_artifact` / `import_artifact` 便携快照，源码不出内网。 |
| 缺工程化护栏 | ① **内存预算**（`memoryBudgetMb`，按设备内存自动分档）与**解析期硬堆上限**（`hardHeapLimitMb`，默认 3072MB，每 250 文件检查一次），把「崩溃丢图」降级为「部分索引 + 明确提示」；② **残缺图分批修复**（`repairBatchFiles`，默认 4000 文件/批）保证多轮收敛；③ **非主 root 大图延迟加载**（`deferLargeNonPrimaryRootsMB`，默认 5MB）避免切工作区整窗卡死；④ 解析全程 Worker 池 + 单文件 15s 超时 + 大文件/超长行防护；⑤ **watcher 自适应轮询 + 2s 去抖**，改代码自动增量，无需手动重建。 |
| 用户看不见 / 无法排查 | **三套 UI**：Codebase Memory 面板（状态徽章、统计卡、索引配置、架构信息、工具调用/日志）、代码库索引面板（模式/排除/保留/索引路径 + 实时进度日志）、3D 图谱 Viewer（可交互查看图谱）。另有一组编辑器内命令（Find Symbol / Class Hierarchy / Find References 等）直接消费图谱。 |

> 对标结论：与 C 版 `codebase-memory-mcp` 的逐工具/逐管道对比见 `doc/codebase-mcp-comparison-analysis.md`（2026-07-18 结论：骨架已对齐，且 `manage_adr` 全 CRUD、`get_code_snippet` 带 `contextLines`、覆盖率体系、热路径指标、TOON 输出等项**反超**）。

### 1.4 能力清单：18 个内置工具

全部定义在 `src/vs/sessions/contrib/agentStudio/browser/providers/tool/codebaseTools.ts`；前 15 个（图谱类）归入 `core` toolset（`priority: Always`，永不被工具过滤剔除），`search_code` 单独归入 `codebase-grep` toolset。

**索引管理**

| 工具 | 用途 |
| --- | --- |
| `index_repository` | 建/重建代码图谱。参数 `repo_path`、`mode`(fast/moderate/full，默认 fast)、`force`、`exclude_dirs[]` |
| `index_status` | 查图谱是否已加载 + 节点/边统计（附 coverage） |
| `check_index_coverage` | 覆盖率报告：完整索引 vs 跳过/超时/解析失败/部分解析（含原因） |
| `list_projects` | 列出所有已索引项目 |
| `delete_project` | 删除某个已索引项目 |

**检索与结构分析**

| 工具 | 用途 |
| --- | --- |
| `search_graph` | **首选代码检索**。支持字段裁剪 `fields`、`include_connected`、`qn_pattern`、`relType`、出入度上下限、`format:"toon"` 紧凑输出 |
| `query_graph` | Cypher 子集结构化查询（跨文件关系、复杂度指标如 `f.cognitive > 15`）；`graph:"missed"` 查漏索引结构 |
| `get_architecture` | 架构概览：languages / packages / entryPoints / routes / hotspots / crossBoundaries / layers / communities / structure / dependencies / file_tree / services |
| `get_code_snippet` | 按限定名取源码（`contextLines` 上下文档 + `includeNeighbors` 邻接符号） |
| `get_graph_schema` | 图谱 schema：节点标签 / 边类型 / 属性分布 |
| `trace_path` | 调用路径追踪（callers/callees/both、`maxDepth`、`edge_types`、`risk_labels`、`include_tests`） |

**文本检索（不依赖索引）**

| 工具 | 用途 |
| --- | --- |
| `search_files` | ripgrep 驱动的文件/内容检索（替代终端 grep/rg/find/ls） |
| `search_code` | 代码正则检索（`mode: compact/full/files`、`regex`、`filePattern`、`context`、`project`、`limit/cap 100`、`offset`） |

**变更 · 运行时 · 归档**

| 工具 | 用途 |
| --- | --- |
| `detect_changes` | 检测相对 git ref 的变更 + 影响面分析（`since`/`baseBranch`/`impactAnalysis`/`scope`/`depth`） |
| `ingest_traces` | 注入运行时轨迹（OTLP JSON 或 `[{caller,callee,count}]`）富化真实调用边 |
| `manage_adr` | 架构决策记录 CRUD（list/get/create/update/delete 全量） |
| `export_artifact` / `import_artifact` | 图谱便携快照导出/导入（团队共享、分支隔离、跨仓库） |

### 1.5 语言支持与产物位置

**支持语言**（`common/codebaseIndexDefaults.ts` 的 `EXTENSION_TO_WASM_LANG`；未列出的扩展名不索引）：

`.ts .tsx .mts .cts`、`.js .jsx .mjs`、`.py`、`.go`、`.rs`、`.java`、`.rb`、`.c .cpp .cc .cxx .h .hpp .hxx`（C++）、`.cs`、`.php`

**产物（固定落在索引根目录下）**：

| 路径 | 内容 |
| --- | --- |
| `.codebase-memory/graph.db.zst` | 图谱主制品（gzip + JSON；`artifactFormat=sqlite` 时为 SQLite 快照 `graph.db.sqlite`，`both` 则两份都写） |
| `.codebase-memory/artifact.json` | 制品元数据（含 `node_count`） |
| `.codebase-memory/index.lock` | 跨进程索引锁（防多窗口重复索引） |
| `.cbmignore` | 目录排除清单（目录名，一行一个；`#` 注释；**不支持 glob**） |

---

## 二、使用说明

### 2.1 前置条件

- 用 VsSarosis 打开工作区（推荐用 **`.code-workspace`** 多根工作区文件打开，见 2.5 的自动索引条件）。
- 无需安装任何插件或外部程序；`git` 仅在用到 `detect_changes` 时需要；网络仅在团队图谱共享时需要。

### 2.2 打开入口

| 入口 | 路径 | 打开的面板 |
| --- | --- | --- |
| ① 知识库视图 | 侧边栏 **知识库** → 展开「已关联文件夹」条目 → 点击条目右侧的 **图谱图标（代码图谱（索引库））** | **代码库索引** 面板（索引控制台） |
| ② 右键菜单 | 在上述条目上**右键 → 代码图谱** | **3D 图谱 Viewer** |
| ③ 聊天框 / 知识库 | 点击「**Codebase Memory**」入口 | **Codebase Memory** 面板（状态 + 配置 + 架构 + 日志） |
| ④ 命令面板 | `F1` → 输入 **`Agent Studio: Codebase Memory Init`** | 定位到 Codebase 相关面板并在无图时引导索引 |

> 面板 ID 对照（供排查/自动化引用）：代码库索引 `workbench.editor.agentStudio.codebaseIndex`；Codebase Memory `workbench.editor.agentStudio.codebaseMemoryDetail`；3D 图谱 `workbench.editor.agentStudio.codebaseGraphViewer`。

### 2.3 首次索引（详细步骤）

**Step 1｜打开工作区**

打开包含目标代码的工作区。多个项目建议用 `.code-workspace` 组织：主项目放第一个 folder（主 root），其余作为附加 folder。

**Step 2｜打开「代码库索引」面板**

按 2.2 的入口 ①，或在命令面板执行 `Agent Studio: Codebase Memory Init`。面板顶部显示：

- 状态徽章：`○ 未索引` / `⏳ 索引中...` / `✓ 已索引（N 节点, M 边）`
- 按钮：**🔍 索引代码库**、**⏹ 取消**、**🌐 3D 图谱**

**Step 3｜配置索引范围（强烈建议大仓库先做）**

在面板的「⚙️ 索引配置」区设置四项，保存后下次打开会回填：

| 配置 | 说明 | 建议 |
| --- | --- | --- |
| **模式** | `⚡ Fast`：基础 AST 解析，跳过扩展 pass（跨文件引用 / LSP 推断），最快，适合快速验证；`⚖️ Moderate`：基础 + 扩展 pass + SQLite 同步，**日常推荐**；`🔬 Full`：当前与 Moderate 等价（预留给语义/相似度索引） | 首次用 Fast 验证，日常用 Moderate |
| **排除** | 逗号分隔的目录名列表（默认取内置 `COMMON_EXCLUDE_DIRS`：`node_modules`、`.git`、`build/out/dist`、`.vscode`、`.codebase-memory` 等） | 大仓先按档位默认值跑 |
| **保留** | 逗号分隔的相对路径（如 `Content/Script`）——即使父目录被排除也不跳过 | 仅当「排除」误伤了要索引的目录时填 |
| **索引路径** | 相对工作区根的子目录（如 `S1Game/Source`）；**留空 = 索引整个工作区** | **多项目父目录/UE 工程必填**，否则容易超时 |

> 「索引路径」是大型工作区收敛索引范围的唯一 UI 入口：图谱会落在该子目录的 `.codebase-memory/` 下。

**Step 4｜点击「🔍 索引代码库」**

- 点击后**会遍历工作区里所有 folder 逐个索引**（一次点击全部），进度写入面板下方的「📋 进度日志」，同时弹出通知。
- 索引期间按钮变灰、**⏹ 取消** 出现；可随时取消（已完成部分照常收尾落盘）。

**Step 5｜等待完成并确认**

进度日志会实时输出扫描/解析阶段信息，结束时打印成功/失败摘要（节点数、边数、耗时）。状态徽章变为 `✓ 已索引（N 节点, M 边）`。

**Step 6｜（可选）用 Agent 校验**

在聊天框让 Agent 执行：`调用 index_status 看下当前索引状态`，或直接问业务问题（见 2.6）。索引质量存疑时执行 `check_index_coverage`。

### 2.4 校验索引质量

| 目的 | 操作 |
| --- | --- |
| 看总体状态 | `index_status`（节点/边数量 + coverage 概要） |
| 看逐文件覆盖 | `check_index_coverage`（`includeFiles: true` 列出跳过/超时/解析失败/部分解析的文件与原因） |
| 找漏索引结构 | `query_graph`，`graph: "missed"` → 返回 `Project→Folder→File` 漏索引结构图（带 `kind`/`detail`） |
| 看语言/热点分布 | `get_architecture`，`aspects: ["languages","hotspots","packages"]` |
| 看图谱 schema | `get_graph_schema`（节点标签 / 边类型 / 属性分布） |

常见「未索引」原因与处理：

- **扩展名不在支持列表**（如 `.lua`、`.vue`）→ 属预期行为，改用 `search_code` 文本检索。
- **文件超限**：单文件 > 1MB、单行 > 10000 字符会被跳过；单行 > 50KB 视为 minified 跳过。
- **解析超时 > 15s** 的文件被跳过 → 检查是否属于生成代码目录，加入「排除」后重建。
- **解析期撞硬堆上限被中止** → 已完成部分照常落盘，剩余文件由增量索引或分批修复补齐；可调大 `saros.codebaseGraph.hardHeapLimitMb` 或缩小「索引路径」。

### 2.5 自动索引与增量更新（通常无需手动干预）

1. **打开工作区自动索引**：打开后延迟 5 秒，对每个 folder 检查 `.codebase-memory/graph.db.zst` —— 有则合并加载（跨 folder 检索），无则后台自动索引。
   ⚠ **条件**：仅当工作区根存在 `.code-workspace` 文件时才启用自动索引；用「添加文件夹到工作区」打开的裸文件夹不会自动索引，改由 Agent 在触发 codebase 工具时询问你是否索引（也可手动走 2.3）。
2. **文件 watcher 增量索引**：图谱就绪后启动文件监听，基础轮询 5s，每 500 个文件 +1s，上限 60s；变更去抖 2s。增量分类基于 **mtime + size**（不读内容），只重解析变动的文件。
3. **延迟加载**：非主 root 且图谱 > `deferLargeNonPrimaryRootsMB`（默认 5MB）的 folder，不在打开工作区时加载，首次真正用到 codebase 能力时再加载 —— 避免切换工作区时整窗卡死。

### 2.6 让 Agent 用起来

索引完成后无需额外配置，Agent 自动获得 codebase 工具（`core` toolset，Always 可用）。示例提示词：

```text
- 这个项目有哪些模块？帮我画一下架构（用 get_architecture）
- SearchService 这个类被哪些地方调用了？影响面多大（trace_path）
- 我要重构 parseConfig，帮我找出所有直接/间接调用者，并按风险排序
- 找出 cognitive complexity > 15 的函数（query_graph）
- 我改了这几个文件，帮我做影响面分析（detect_changes，baseBranch: main）
- AActor::BeginPlay 的实现贴给我看看（get_code_snippet）
```

推荐工具优先级（工具描述里也已约定）：

1. 代码结构类问题 → **`search_graph` 优先**，其次 `query_graph` / `trace_path`；
2. 纯文本/正则/找文件名 → `search_code` / `search_files`；
3. 拿具体实现 → `get_code_snippet`；
4. 架构级问题 → `get_architecture`。

### 2.7 3D 图谱与架构视图

- **3D 图谱 Viewer**（入口 ② / 面板按钮 **🌐 3D 图谱**）：webview 渲染的交互式图谱，用于人工确认节点/边、定位孤岛与热点。
- **Codebase Memory 面板**：状态徽章（ready/indexing/empty）、统计卡（节点/边/项目/大小）、**Index Config**（Mode 分段选择 / Index Path / Exclude / Keep）与操作按钮 **🔍 Index Codebase**、**💾 Save Config**、**🌐 View 3D Graph**、**🔄 Refresh**、**📂 Open Directory**；另有架构信息（language 分布、Hotspots、Layers、Cross-pkg）与图谱工具试跑区（含 `get_code_snippet`、`detect_changes` 等）以及可复制的运行日志。
- **编辑器内图谱命令**（`Shift+Alt+S` 等在编辑器里直接消费图谱）：Find Symbol in Codebase、Show Class Hierarchy、Find References、Go to Implementation、List Methods 等。

### 2.8 团队共享图谱

三种方式：

1. **内网 Git 图谱仓库（推荐）**：把 `.codebase-memory/` 制品提交到团队图谱仓库（当前远端：`https://git.woa.com/zijianqiu/vssaros-codebase-memory.git`），队友在 **Marketplace 面板**中「团队共享的代码库知识图谱」卡片上点 **⬇ 下载** 即同步。
2. **便携快照**：Agent 调 `export_artifact`（默认 `slim: true`）产出 `.codebase-memory/graph.db.zst` + `artifact.json`；队友用 `import_artifact` 导入并替换当前内存图谱。适合跨分支/跨仓库离线传递。
3. **索引配置下沉到工作区文件**：把 `codebase-memory` 配置写进 `.code-workspace`，团队共用同一套索引范围（见 2.9）。

### 2.9 配置项

**A. 编辑器设置（`settings.json`）**

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `saros.codebaseGraph.sqliteBackend` | `true` | 图谱查询/搜索走主进程 SQLite（FTS5），避免内存全量扫描；`false` 回退内存 store |
| `saros.codebaseGraph.artifactFormat` | `json` | 制品写出格式：`json`（`graph.db.zst`，兼容最好）/ `sqlite`（写 `graph.db.sqlite`，保存与载入都快，适合本机）/ `both`（迁移过渡）。**切换后下一次索引/保存生效** |
| `saros.codebaseGraph.memoryBudgetMb` | `0` | 单轮索引的内存增长预算（`0` = 按设备内存自动分档：≤4GB→256 / ≤8GB→512 / 更大→768）；超预算会打印对账行并告警 |
| `saros.codebaseGraph.hardHeapLimitMb` | `0`（=3072） | 解析期**硬堆上限**，每 250 文件检查一次，越过即中止本轮解析（部分索引 + 提示），防 OOM 崩溃 |
| `saros.codebaseGraph.repairBatchFiles` | `0`（=4000） | 残缺图谱分批修复的批次大小，保证多轮收敛 |
| `saros.codebaseGraph.excludeProfile` | `balanced` | 排除档位：`balanced` 额外排除 `test/tests/docs/scripts/resources` 等；`full` 只排除依赖与构建产物。**切换后需重新索引** |
| `saros.codebaseGraph.deferLargeNonPrimaryRootsMB` | `5` | 非主 root 图谱超过该大小时延迟加载；`0` = 关闭延迟（打开工作区即加载全部） |

**B. `.code-workspace` 里的 `codebase-memory` 配置（团队共享索引范围）**

支持放在顶层或 `settings` 下，文件支持 JSONC（注释 + 尾逗号）；仅在 workspace storage 中没有已保存配置时作为回退使用。字段：`mode`、`excludeDirs[]`、`keepDirs[]`、`subPath`。

```jsonc
{
  "folders": [{ "path": "S1Game" }],
  "settings": {
    "codebase-memory": {
      "mode": "moderate",
      "subPath": "Source",
      "excludeDirs": ["node_modules", "Intermediate", "Binaries", "Saved"],
      "keepDirs": ["Content/Script"]
    }
  }
}
```

**C. `.cbmignore`（目录名排除清单，团队可提交）**

```
# 索引排除目录（每行一个目录名；不支持 glob，含 * ? 的行会被忽略）
Intermediate
Binaries
Saved
DerivedDataCache
```

> 备注：索引排除**不使用** `.gitignore`（`.gitignore` 只被版本管理服务读取）；来源为「排除档位 + `.cbmignore` + `.code-workspace` 的 `search.exclude`/`files.exclude` 中的干净目录名」。

### 2.10 大仓库调优（实测参考）

| 现象 | 建议 |
| --- | --- |
| 索引过程中的内存峰值高 | 显式设置「**索引路径**」收敛到源码子目录；用 `excludeProfile: balanced`；必要时调低 `memoryBudgetMb` 观察对账行定位是哪一段吃内存 |
| 索引被硬堆上限中止（日志有中止提示） | 属预期保护：已完成部分已落盘，剩余由增量索引/分批修复补齐；持续不够就再缩小索引范围，或调大 `hardHeapLimitMb`（需机器内存富余） |
| 切到多根工作区整窗卡死数十秒 | 这是同步解压大图所致（实测 `sarosis` 8.2MB / 17.9 万节点；`UE5EA` 24.6MB / **87.6 万节点**）。保持 `deferLargeNonPrimaryRootsMB` 默认 5（非主 root 大图延迟加载），并把超大 UE 工程单独开窗口 |
| 「残缺 → 全量 → 中止 → 仍残缺」 | 保留 `repairBatchFiles` 默认 4000 让其分批收敛；不要反复手动清空重建 |
| 检索/查询偶发变慢 | 确认 `sqliteBackend: true`；图谱过大时可切 `artifactFormat: sqlite` 提升保存/载入速度 |

### 2.11 故障排查速查

| 症状 | 排查 |
| --- | --- |
| 面板显示 `○ 未索引` | 尚未索引过 → 按 2.3 手动发起；或从未含 `.code-workspace` 的裸文件夹打开（不会自动索引） |
| 状态已索引但检索结果少 | 用 `check_index_coverage` 看是否大量 skipped/timeout；用 `query_graph(graph:"missed")` 看漏索引结构；核对「排除」「索引路径」是否过窄 |
| Agent 说没有 codebase 工具 | 确认图谱已索引（无图时部分工具会引导你发起索引）；`search_code` / `search_files` 不依赖索引，可先用它们；极端情况下模型可能被工具数量限制折叠为 `tool_search` 桥接调用 |
| 索引过程中断 | 已解析部分照常收尾落盘，重跑即走增量补齐；大规模缺漏由分批修复收敛 |
| 图谱内容陈旧 | 检查 watcher 是否在跑（日志 `[CodebaseGraph]`）；确认 `.codebase-memory` 未被排除/删除；必要时 `delete_project` 后重新 `index_repository`（`force: true`） |
| 想看详细日志 | 面板「进度日志」；另外在日志中按标签 `[CodebaseGraph]` / `[CodebaseMemory]` / `[CodebaseGraphViewer]` 过滤 |

### 2.12 命令与快捷键

| 命令 ID / 快捷键 | 说明 |
| --- | --- |
| `Agent Studio: Codebase Memory Init`（`agentStudio.codebaseMemoryInit`） | 打开 Codebase 相关面板；无图时引导索引 |
| `Shift+Alt+S`（`sarosis.findGraphSymbol`） | Find Symbol in Codebase |
| `Alt+Shift+G`（`sarosis.classHierarchy.show`） | Show Class Hierarchy |
| `sarosis.openGraphFile` / `sarosis.findGraphReferences` / `sarosis.gotoGraphImplementation` / `sarosis.listGraphMethods` / `sarosis.searchSelectionInFiles` | 编辑器内图谱跳转与检索（C++ 在无 LSP 时由此兜底） |

### 2.13 停机/清理/重建

- **只想刷新内容**：什么都不做，watcher 自动增量；或面板 **🔄 Refresh** 重新渲染。
- **想换索引范围**：改「索引路径/排除/保留」→ 重新点 **🔍 索引代码库**（旧图谱会被更新）；档位类设置（`excludeProfile`、`artifactFormat`）切换后需重新索引/保存才生效。
- **想彻底重建**：`delete_project` 删除项目 → `index_repository`（`force: true`）重建；或直接删除索引根下的 `.codebase-memory/` 目录后重新索引。
- **不想让某些目录入库**：写入 `.cbmignore`（2.9 C）或加进「排除」输入框。

---

## 附录：源码位置索引

| 模块 | 路径（相对 `src/vs/sessions/contrib/agentStudio/`） |
| --- | --- |
| 图谱核心服务 | `browser/codebaseGraphService.ts`（`ICodebaseGraphService`、`indexWorkspace`、增量索引） |
| 内存图存储 | `browser/codebaseGraphStore.ts`（含 `HEAP_BUDGET_BYTES = 3GB`） |
| 解析 Worker 池 | `browser/codebaseGraphParserPool.ts` + `codebaseGraphWorkerCode.ts` |
| 扫描 / 排除解析 | `browser/codebaseGraphScanner.ts`、`codebaseGraphExcludeResolver.ts`、`common/codebaseIndexDefaults.ts` |
| watcher / 增量 | `browser/codebaseGraphWatcher.ts`、`codebaseGraphIncremental.ts` |
| 持久化 / SQLite 后端 | `browser/codebaseGraphPersistence.ts`、`node/codebaseGraphSqliteStore.ts` |
| Cypher / 语义检索 / 架构 / 追踪 | `browser/codebaseGraphCypher.ts`、`codebaseGraphSemantic.ts`、`codebaseGraphArchitecture.ts`、`codebaseGraphTrace.ts` |
| ADR / LSP 交叉推断 / 扩展 pass | `browser/codebaseGraphAdr.ts`、`codebaseGraphLsp.ts`、`codebaseGraphExtendedPasses.ts` |
| 自动加载与索引引导 | `browser/codebaseGraphBootstrap.ts` |
| 索引配置 + Git 共享 | `browser/codebaseMemoryMcpService.ts`、`codebaseMemoryMcpBootstrap.ts` |
| Agent 工具定义 | `browser/providers/tool/codebaseTools.ts`（注册入口 `browser/providers/tool/builtinToolProvider.ts`） |
| toolset 分类 | `common/toolsetConfig.ts`（`core` / `codebase-grep`） |
| UI 面板 | `browser/codebaseIndexEditorPane.ts`、`codebaseMemoryDetailEditorPane.ts`、`codebaseGraphViewerEditorPane.ts` |
| 设置注册 | `browser/agentStudio.contribution.ts`（`saros.codebaseGraph.*`） |
| 对比与分析文档 | `doc/codebase-mcp-comparison-analysis.md`、`doc/codebase-memory-mcp-analysis.md`、`doc/codebase-memory-mcp-knowledge-graph-analysis.md` |
