// @vssaros/dsh-codebase — host half：代码图谱的只读页面 + 查询工具（在 Host 进程内跑）。
//
// 方案 6.6 把本模块列为"高/不满足（差距最大）"：图谱服务（tree-sitter WASM）与 18 个工具都还在渲染进程，
// 也正是"同步解析大图谱把界面卡死"的根因。本切片做的是**能先落且不打折的那部分**：在 Host 里读同一份图谱
// 文件（真源契约见 core/codebase.js），提供概览 / 检索 / 依赖 / 热点四类查询 + 只读页面。
// **未做**：tree-sitter 增量索引与文件监听（图谱的**生产**仍在 IDE 侧）、18 个工具的全量移植、
// 会话节点注册。也就是说：**读侧搬到 Host 了，写侧（索引）还没搬**。
//
// ★ 2026-10-12 **P0 自证已落地**（方案见 `doc/codebase-index-to-dsh-plan.html` §5 P0）：`lib/parser/`
// 把"Host（Node）能不能跑 tree-sitter"从假设变成了**页面诊断行 + `/x/codebase/api/parse-proof` 上看得见的事实** ✓：
//   · 运行时 `@vscode/tree-sitter-wasm` 是 **UMD**、带 `ENVIRONMENT_IS_NODE` ⇒ Node 里 `require` 直接可用 ✓；
//   · 资产解析走 `config.treeSitterWasmDir → env → 随包 vendor/ → dev node_modules` 的四级链 ✓（可观测、不猜）；
//   · ⚠ **随包陷阱已被钉住**：仓库根是 `"type":"module"` ⇒ 拷进包的 `tree-sitter.js` 会被当 ESM 求值、报一句
//     `Unable to determine script URL` ✗ ⇒ 纪律是**进包即改名 `.cjs`**，且加载失败时把它翻成人话 ✓（见 parser/resolve.js）。
//   ⚠ 仍然**没有任何写侧行为**：本切片只解析内存里的片段（自证用），**不读工作区、不写任何产物** ✓
//     ⇒ 缺省零行为改变（图谱生产仍在 IDE 侧 ✓）。
//
// ★ 2026-10-12 **P1 影子索引 v0 已落地**（方案 §5 P1）：`lib/shadow.js`（落点/锁/原子写）+
// `lib/indexService.js`（编排：复用既有 `indexer.js` 的增量与缓存）+ 工具 `codebase_index`（**过审批闸** ✓）/
// `codebase_index_status`（只读）+ 读侧 `store.js::graphDirOf`（**影子产物优先** ✓，否则回退 IDE 产物）。
//   · 产物落点：`config.indexDir` → `<DSH_HOME>/codebase-index` → **未配置就拒绝**（不猜 ✓）；
//     工作区键 = 绝对路径 sha256 前 16 位 ⇒ 多工作区互不干扰 ✓。
//   · **绝不写**工作区里的 `<ws>/.codebase-memory/`（IDE 的所有物 ✓）⇒ 与 IDE 索引器**结构上不可能双写** ✓；
//     产物与 IDE **逐字同形**（`artifact.json` + gzip 的 `graph.db.zst`）⇒ 将来要交接只差一个目录常量 ✓。
//   · v0 的诚实边界：正则顶层符号、边只有 `IMPORTS`/`CONTAINS`/`IMPORTS_SYMBOL`、无文件监听、无后台任务 ✓。
//
// 性能设计（见 store.js）：`artifact.json` 轻路径（不解压）+ `graph.db.zst` 重路径（按需、带缓存、有上限）；
// 页面默认轻，只有显式检索/深度视图才付 129MB 解压与内存的代价。
// 解析器那条链是**惰性**的：页面只报"资产在哪、几种语言"（几个 statSync ✓），**不在渲染路径上 parse** ✗。

import { ARCHITECTURE_ASPECTS, ARCHITECTURE_NOT_PORTED, architectureOf, dependenciesOf, graphSchemaOf, impactOf, isSafeGitRef, mapFilesToNodes, normalizeScope, pathOf, projectsOf, resolveSymbol, searchNodes, sliceLines, summarizeGraph, topNodes, traceFrom } from './core/codebase.js';
import { bindFoundation, foundation } from './foundationRef.js';
import { GRAPH_FILE, MANIFEST_FILE, SNIPPET_MAX_LINES, SQLITE_FILE, loadGraph, readOverview, readSourceSlice, runGitChanges, workspaceRootOf } from './store.js';

// 写侧前提自证（README 5.53）：Host 自己产出**最小**图谱产物（文件级 import 图）+ 用**同一个读侧**读回比对。
// 只写临时目录 —— 工作区里的 `.codebase-memory/` 是 VsSaros 侧的所有物（`owns` 没交接，5.48/5.50 同一条纪律）。
import { DEFAULT_MAX_FILES, flatSelfCheck, selfCheck, summarizeSelfCheck } from './indexer.js';

// P0（2026-10-12）：tree-sitter 在 Host 侧的自证通路（资产解析 + worker 门面）。见 lib/parser/*.js 的文件头。
import { PROOF_SNIPPET, createParserPool, describeParser } from './parser/pool.js';

// P1（2026-10-12）：影子索引 v0（编排 + 落点/锁/原子写）。见 lib/indexService.js / lib/shadow.js 的文件头。
import { DELETE_WHICH_VALUES, GRAPH_STALE_AFTER_MS, INDEX_MAX_FILES, INDEX_MAX_FILES_CAP, coverageOf, deleteIndexArtifacts, exportIndexArtifacts, importIndexArtifacts, runShadowIndex, shadowStatus, workspaceArtifactDirOf } from './indexService.js';

// P4（2026-10-12）：影子保鲜 watcher（缺省不启用；见 lib/watcher.js 文件头的五条纪律）。
import { createShadowWatcher, watchSummaryOf } from './watcher.js';

// A②（2026-10-13）：**形状查询**（Cypher 的诚实子集：4 种写法 ⇒ 转发到既有 helper ✓，见 lib/shapeQuery.js 文件头）
import { parseShapeQuery, runShapeQuery, SHAPE_HELP } from './shapeQuery.js';

import { shadowDirOf, writeDirOf } from './shadow.js';

// P8（2026-10-13）：**文本搜索**（真源 `search_code` 的对应物 ✓）—— 与图无关，**不需要索引** ✓
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, createAdr, deleteAdr, findFiles, getAdr, listAdrs, searchCode, updateAdr } from './store.js';


export const name = 'vssaros-codebase';

// 只依赖 tools：工具在任何模板里都该可用。`webServer` / `connection` 只在 web 模板里存在，
// 写进静态 `inject` 会让整个插件在 headless / tui profile 里**永久 pending**，连工具一起失效
//（2026-10-12 照 kanban / skills / workflow 的现成写法收窄 ✓，见 `doc/dsh-modules-conformance.html` §5-9）。
export const inject = ['tools'];

const ROUTE_PREFIX = '/x/codebase';
// ⚠ 这是**声明**的工具名清单（页面自诊断那一栏用它 filter 注册表 ✓）。2026-10-12 加 `codebase_snippet`
// 时把它**导出来** ✓ —— 于是探针能拿"声明 == 注册"**互相对账** ✓（本仓已有两处栽在"两处名单各写一份"✗：
// workflow 与 kb ✓；这里趁加工具一次治掉 ✓）。
export const TOOL_NAMES = ['codebase_overview', 'codebase_search', 'codebase_deps', 'codebase_hotspots', 'codebase_architecture', 'codebase_schema', 'codebase_projects', 'codebase_trace', 'codebase_changes', 'codebase_snippet', 'codebase_self_index', 'codebase_index', 'codebase_index_status', 'codebase_coverage', 'codebase_delete_project', 'codebase_export_artifact', 'codebase_import_artifact', 'codebase_search_code', 'codebase_search_files', 'codebase_manage_adr', 'codebase_query_graph'];
/**
 * ★ **写入类工具**名单（P1，2026-10-12）—— 它们是本模块**第一次**往自己的数据目录里**持久写**东西 ✓。
 *
 * 为什么它与 `codebase_self_index` **不同档**（后者刻意**不**过闸，理由在 `dshPluginPackages` 的台账里 ✓）：
 *   · `self_index` 只往 `mkdtemp` 写的**自证**，秒级、写完即弃 ✓；
 *   · `codebase_index` 会**扫整个工作区**（CPU/IO 与仓库规模成正比）+ 把产物**持久**落到数据目录 ✓
 *     ⇒ 属"模型自己想跑就跑的**有成本**动作"，与 kb 的写、kanban 的写同一档 ✓。
 *
 * ⚠ 导出的用处：`dshPluginPackages` 拿它对账（名单非空 + 每个名字真被注册 ✓）、`p3-40` 拿它发真事件断言拦/放行 ✓。
 */
export const WRITE_TOOLS = ['codebase_index', 'codebase_delete_project', 'codebase_export_artifact', 'codebase_import_artifact', 'codebase_manage_adr'];
/**
 * `codebase_manage_adr` 里**只读**的动作（⇒ 不追问 ✓）。
 *
 * ⚠ 这是对"审批闸**只按工具名**判"的一处**有意例外**，理由说清 ✓：
 *   · `codebase_index` 那条纪律的本意是"**同一个变更**不许靠参数绕过"（"这次只扫 50 个文件"不该免问 ✓）；
 *   · 而 `manage_adr` 的 `action` **不是**同一个变更的参数，是**不同的操作** ✓ ——
 *     `list` / `get` 根本不改任何东西，为它弹一次"允许读 ADR 吗？"是**纯噪音** ✓（而且会把闸门训练成"随手批准"✗）。
 *   ⇒ 写动作（`create` / `update` / `delete`）照旧必问 ✓，且理由里要**点名动作与 id** ✓。
 */
export const ADR_READ_ACTIONS = ['list', 'get'];

/**
 * 真源 18 个工具 → dsh 的**对账表**（P11，2026-10-14）。
 *
 * 为什么放进**代码**而不是只写在 doc 里 ✓：它要能在页面上被**当场核对** ✓ ——
 * `portAuditOf` 拿它去比"**这次部署真注册了哪些工具**"，把"改了工具名、忘了改表"这种漂移**当场报出来** ✗
 * （只写在 doc 里的清单，改完代码没人会回去核对 ✓；这种漂移正是本仓最忌讳的静默退化 ✗✗）。
 *
 * 三档（**互斥、且账要平** ✓）：
 *   · `to` ⇒ 1:1 对应 ✓；
 *   · `replacedBy` ⇒ 换了语言或换实现（原因写在 `why` ✓）；
 *   · `conclusion` ⇒ 明确**不移植**（理由写在 `conclusion` ✓）—— 结论也是交付物 ✓，不是空白 ✗。
 */
export const PORT_AUDIT = [
	{ from: 'index_repository', to: 'codebase_index' },
	{ from: 'index_status', to: 'codebase_index_status' },
	{ from: 'check_index_coverage', to: 'codebase_coverage' },
	{ from: 'list_projects', to: 'codebase_projects' },
	{ from: 'delete_project', to: 'codebase_delete_project' },
	{ from: 'search_graph', to: 'codebase_search' },
	{ from: 'get_architecture', to: 'codebase_architecture' },
	{ from: 'get_code_snippet', to: 'codebase_snippet' },
	{ from: 'get_graph_schema', to: 'codebase_schema' },
	{ from: 'trace_path', to: 'codebase_trace' },
	{ from: 'search_files', to: 'codebase_search_files' },
	{ from: 'search_code', to: 'codebase_search_code' },
	{ from: 'detect_changes', to: 'codebase_changes' },
	{ from: 'manage_adr', to: 'codebase_manage_adr' },
	{ from: 'export_artifact', to: 'codebase_export_artifact' },
	{ from: 'import_artifact', to: 'codebase_import_artifact' },
	{ from: 'query_graph', replacedBy: 'codebase_query_graph', why: '真源是 **Cypher** ✗；dsh 侧没有图查询语言（已决定不引入解析器/执行器）⇒ 对应物是**形状语法**（只认 SHAPE_HELP 那几种写法 ✓）' },
	{ from: 'ingest_traces', conclusion: '不移植：要运行时 trace 的来源（dsh 里没有被测应用 ✓），且动态边混进静态图会让"谁调用了谁"**不可证伪** ✗（理由与"要做得先有什么"见 doc ✓）' },
];

/**
 * 对账：拿 `PORT_AUDIT` 去比**这次部署真注册的工具**，漂移当场报出来 ✓。
 * `registered` 收数组（`TOOL_NAMES` ✓）或逗号串（页面上的 `toolsRegistered` ✓）。
 * @returns `{ sourceTools, mapped, replaced, conclusions, missing, extra }`
 *   `missing` = 表里写了、这次却没注册的（**空数组才正常** ✓）；`extra` = 注册了但不在表里（dsh 侧多出来的 ✓）。
 */
export function portAuditOf(registered) {
	const list = Array.isArray(registered) ? registered.map(String) : String(registered ?? '').split(',').map(part => part.trim()).filter(Boolean);
	const nameOf = entry => entry.to ?? entry.replacedBy;
	const mapped = PORT_AUDIT.filter(entry => entry.to).length;
	const replaced = PORT_AUDIT.filter(entry => entry.replacedBy).length;
	const conclusions = PORT_AUDIT.filter(entry => entry.conclusion).length;
	const missing = PORT_AUDIT.filter(entry => nameOf(entry) && !list.includes(nameOf(entry))).map(nameOf);
	const claimed = PORT_AUDIT.map(nameOf).filter(Boolean);
	const extra = list.filter(tool => !claimed.includes(tool));
	return { sourceTools: PORT_AUDIT.length, mapped, replaced, conclusions, missing, extra };
}
/** `codebase_snippet` 默认带的前后文行数（真源 `get_code_snippet` 也是 3 ✓）。 */
const SNIPPET_CONTEXT_DEFAULT = 3;
/** `codebase_schema` 每个列表默认列几条（页面那份 `summarizeGraph` 是 12 ✓；给模型可以多些，但**必须标 truncated** ✓）。 */
const SCHEMA_LIST_LIMIT = 40;
/** 本插件在反向通道里的调用方标识（VsSaros 侧据此查"这个插件声明了哪些能力"）。 */
const PLUGIN_ID = '@vssaros/dsh-codebase';
/** 「在编辑器打开」的等待预算：主进程一趟 + 渲染侧一趟（开文件，不开浏览器、不等用户），默认够用。 */
const OPEN_TIMEOUT_MS = 15_000;
/** JSON 回执的统一响应头（多处理由共用一份，免得一处改了另一处忘）。 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
/** 页面上一次最多渲染的检索结果。 */
const PAGE_RESULT_LIMIT = 30;
/** `/api/parse-proof` 接受的片段长度上限（自证用；不给人往里灌一整个仓库的机会 ✓）。 */
const MAX_PROOF_TEXT = 4000;

// 页面外壳（标题 / 工具条 / 分区 / 空态 / 诊断行）逐条移植自 VsSaros 原容器 Pane，
// 见 `lib/pageShell.js` 顶部注释（真源行号 + 分发约定）。`escapeHtml` 由它提供。
import { escapeHtml, renderShell } from './pageShell.js';


const bytesOf = n => (typeof n === 'number' ? (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`) : '未知');
const isoOf = ms => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '未知');
/** 时长的人话（P3-b 的新鲜度用：页面/工具都要能一眼看出"这图多久前建的" ✓）。 */
const ageOf = ms => {
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
		return '未知';
	}
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) { return '不到 1 分钟'; }
	if (minutes < 60) { return `${minutes} 分钟`; }
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天`;
};
const shortFile = path => (typeof path === 'string' ? path.split('/').slice(-3).join('/') : '未知');
/**
 * 单个统计格子 —— 移植 `views/libraryStatHelpers.ts::statCell`（数值 + 标签；**0 / 未知 ⇒ 灰显** ✓）。
 * 为什么不 import 真源：那是 IDE 侧的 `.ts`（依赖 `base/browser/dom` ✗），dsh 页面只能照抄**取值与结构** ✓。
 */
function statCellHtml(label, value) {
	const known = Number.isFinite(Number(value));
	const zero = !known || Number(value) === 0;
	return `<div class="kb-stat-cell${zero ? ' zero' : ''}">`
		+ `<span class="kb-stat-num">${escapeHtml(known ? String(value) : '未知')}</span>`
		+ `<span class="kb-stat-label">${escapeHtml(label)}</span></div>`;
}

function nodeRow(node) {
	// 可点（有 filePath 时）：经宿主路由走反向通道请求 IDE 能力 openFile —— 在编辑器里打开这个符号所在处。
	// 没有 filePath 的节点不挂这些属性（光标也不会变成"可点"），免得点了没反应。
	const openPath = typeof node.filePath === 'string' ? node.filePath : '';
	const openLine = Number.isFinite(Number(node.startLine)) ? String(Number(node.startLine)) : '';
	const openable = openPath ? ` data-open-path="${escapeHtml(openPath)}" data-open-line="${openLine}" role="button" tabindex="0" title="点击：在编辑器里打开这个符号"` : '';
	// ★ 2026-10-13：节点 id 也露出一个锚点（图浏览页的下钻靠它：`?view=graph&node=<id>` ✓；探针也按它取数 ✓）
	const nodeIdAttr = node.id !== undefined && node.id !== null ? ` data-node-id="${escapeHtml(String(node.id))}"` : '';
	return `<li${openable}${nodeIdAttr}><code>${escapeHtml(node.name ?? '(无名)')}</code> <small>${escapeHtml(node.label ?? '')}</small><br><small>${escapeHtml(shortFile(node.filePath))}${node.startLine ? `:${node.startLine}` : ''} · 入度 ${node.inDegree ?? '未知'} / 出度 ${node.outDegree ?? '未知'}${node.community !== undefined ? ` · 社区 ${node.community}` : ''}</small></li>`;
}

function pairRows(pairs) {
	return pairs.map(pair => `<li><code>${escapeHtml(pair.name)}</code> <small>${pair.count}</small></li>`).join('');
}

/**
 * 页面专属样式 —— ★ 2026-10-13：**逐条移植自「资料库 → 代码图谱」那套外观**（真源
 * `src/vs/sessions/contrib/agentStudio/browser/views/media/kbView.css`，值逐条抄，改样式时两边一起改 ✓）。
 *
 * 为什么要移植而不是自创：那一套就是用户在 VsSaros 里看「代码图谱」时的**既有观感**（迁移到 dsh 后
 * 若换一套皮，等于强迫用户重学一次 ✗）。类名沿用 `kb-*`，便于与真源**逐条对照** ✓。
 *
 * ⚠ 两处**有意的差异**（都是 dsh 页面环境的硬约束，不是偷懒 ✗）：
 *   ① **不用 codicon 字体**：dsh 自托管页不在 VS Code 的 DOM 里、拿不到 codicon 字体 ⇒
 *      图标位置用字符/emoji 代替（与工作流/看板页同一做法 ✓）；
 *   ② 日志位（原 Pane 是**运行时索引日志**）在这里放的是**静态诊断**（本页无运行时日志可打 ✓）
 *      ⇒ 沿用同一套 `.kb-log` 外观、但标题诚实地写「诊断」✓（不冒充日志 ✓）。
 *
 * 骨架与主题变量由 `pageShell.js` 给（那个文件是四个插件**逐字节共享**的 ⇒ 本插件的样式一律写这里 ✓）。
 */
const PAGE_CSS = `
/* ── 标题栏（kbView.css:13-33 同款：35px 高 + 底边框 + 小号大写标题）── */
.kb-view { display: flex; flex-direction: column; height: 100%; min-width: 0; }
.kb-header {
	display: flex; align-items: center; gap: 4px;
	padding: 0 4px 0 10px; height: 35px;
	border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128,128,128,.35)));
	flex-shrink: 0;
}
.kb-title {
	font-size: 11px; text-transform: uppercase; letter-spacing: .5px; font-weight: 600;
	opacity: .8; display: flex; align-items: center; gap: 6px;
}
.kb-spacer { flex: 1; }
.kb-hbtn {
	width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
	border-radius: 4px; cursor: pointer; color: inherit; text-decoration: none;
}
.kb-hbtn:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, rgba(128,128,128,.15))); }

/* ── 面板骨架（kbView.css:837-856）── */
.kb-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.kb-panel-bar {
	display: flex; align-items: center; gap: 4px;
	padding: 0 4px 0 10px; height: 30px; flex-shrink: 0;
	border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128,128,128,.35)));
}
.kb-panel-bar-label {
	font-size: 11px; text-transform: uppercase; letter-spacing: .5px; font-weight: 600; opacity: .8;
}
.kb-panel-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }

/* ── 入口卡片（kbView.css:860-878）── */
.kb-entry {
	display: flex; align-items: center; gap: 8px; margin: 6px 8px; padding: 10px 12px;
	border-radius: 4px; cursor: pointer; font-size: 12px; text-decoration: none; color: inherit;
	background: var(--vscode-editorWidget-background, var(--vscode-input-background, rgba(128,128,128,.08)));
	border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128,128,128,.35)));
	transition: background .1s, border-color .1s;
}
.kb-entry:hover { border-color: var(--vscode-focusBorder, #007acc); }
.kb-entry-icon { font-size: 15px; flex-shrink: 0; }
.kb-entry-text { flex: 1; min-width: 0; }
.kb-entry-title { color: var(--vscode-foreground, #ccc); }
.kb-entry-meta { font-size: 10px; color: var(--vscode-descriptionForeground, #999); margin-top: 2px; }
.kb-entry-arrow { flex-shrink: 0; font-size: 13px; color: var(--vscode-descriptionForeground, #999); }
/* 侧栏版的主入口是一个 button 元素（要点了才开编辑区）—— a 标签那套样式盖不全，这里补三条 ✓：
   ① 按钮是 shrink-to-fit 的替换元素 ⇒ 不给宽度就缩成一小块 ✗（margin 左右各 8px ⇒ 减掉 16 ✓）；
   ② 按钮**不继承** font-family/size ⇒ 用 font: inherit 补上；③ 文本靠左（按钮默认居中 ✓ 但 flex 里仍要钉住）。 */
button.kb-entry { width: calc(100% - 16px); font: inherit; text-align: left; }
button.kb-entry .kb-entry-text { display: block; }
.kb-entry-primary { border-color: var(--vscode-focusBorder, #007acc); }
.kb-entry-primary .kb-entry-title { font-weight: 600; }
.kb-entry.busy { opacity: .6; pointer-events: none; }

/* ── 原「Codebase Memory」面板那套（2026-10-13 按原 DOM 版重排编辑区页）────────────────────────
   规格：src/vs/sessions/contrib/agentStudio/browser/codebaseMemoryDetailEditorPane.ts ✓
   四张统计卡 + 可折叠分区（原生 details，无脚本也能开合 ✓）+ 键值行 + 按钮组 ✓ */
.cbm-cards { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 10px 2px; }
.cbm-card { flex: 1 1 120px; min-width: 0; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 6px; padding: 8px 10px; }
.cbm-card-icon { font-size: 14px; }
.cbm-card-num { display: block; font-size: 20px; font-weight: 600; margin-top: 2px; }
.cbm-card-label { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--vscode-descriptionForeground, #999); }
.cbm-card-sub { display: block; font-size: 10px; color: var(--vscode-descriptionForeground, #999); margin-top: 2px; }
.cbm-card.accent { border-left: 3px solid var(--vscode-textLink-foreground, #3794ff); }
.cbm-card.green { border-left: 3px solid #4ec9b0; }
.cbm-card.blue { border-left: 3px solid #569cd6; }
.cbm-card.purple { border-left: 3px solid #c586c0; }
.cbm-section { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 6px; margin: 8px 10px; }
.cbm-section > summary { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; font-size: 13px; font-weight: 600; list-style: none; }
.cbm-section > summary::-webkit-details-marker { display: none; }
.cbm-section-badge { margin-left: auto; font-size: 10px; font-weight: 400; color: var(--vscode-descriptionForeground, #999); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 8px; padding: 1px 6px; }
.cbm-section-body { padding: 2px 10px 10px; }
.cbm-kv { display: flex; gap: 8px; font-size: 11px; padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
.cbm-kv .key { flex: 0 0 120px; color: var(--vscode-descriptionForeground, #999); }
.cbm-kv .val { flex: 1; min-width: 0; word-break: break-word; }
.cbm-note { font-size: 10px; color: var(--vscode-descriptionForeground, #999); margin: 6px 0 0; line-height: 1.5; }
.cbm-btn-group { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.cbm-btn { font: inherit; font-size: 11px; padding: 4px 10px; border-radius: 4px; cursor: pointer; text-decoration: none; color: inherit; background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.15)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
.cbm-btn.primary { color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); border-color: transparent; }
.cbm-btn.disabled { opacity: .5; cursor: default; }
.cbm-pill { font-size: 10px; border-radius: 8px; padding: 2px 8px; border: 1px solid #4ec9b0; color: #4ec9b0; }
.cbm-pill.busy { border-color: #d7ba7d; color: #d7ba7d; }
/* ── 图浏览页的分布条（?view=graph）：没有前端库，占比就用宽度画 ✓ ── */
.cbm-bars { margin: 4px 0 2px; }
.cbm-bar { display: flex; align-items: center; gap: 6px; font-size: 10px; padding: 1px 0; }
.cbm-bar-label { flex: 0 0 110px; color: var(--vscode-descriptionForeground, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbm-bar-track { flex: 1; height: 8px; border-radius: 4px; background: var(--vscode-panel-border, rgba(128,128,128,.25)); overflow: hidden; }
.cbm-bar-fill { display: block; height: 100%; background: var(--vscode-button-background, #0e639c); }
.cbm-bar-num { flex: 0 0 54px; text-align: right; }

/* ── 统计区（kbView.css:915-997 同款：大数字 hero + 网格格子 + meta + 状态行）── */
.kb-stats { padding: 8px 10px 4px; }
.kb-stats-hint { font-size: 11px; color: var(--vscode-descriptionForeground, #999); padding: 6px 2px; }
.kb-stat-hero { display: flex; align-items: baseline; gap: 6px; padding: 2px 2px 8px; }
.kb-stat-hero-num { font-size: 20px; font-weight: 600; line-height: 1; color: var(--vscode-foreground, #ccc); }
.kb-stat-hero-label { font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
.kb-stat-grid {
	display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
	gap: 4px; margin-bottom: 6px;
}
.kb-stat-cell {
	display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 5px 7px;
	border-radius: 4px;
	background: var(--vscode-editorWidget-background, rgba(128,128,128,.08));
	border: 1px solid var(--vscode-panel-border, transparent);
}
.kb-stat-cell.zero { opacity: .55; }
.kb-stat-num { font-size: 13px; font-weight: 600; line-height: 1.2; color: var(--vscode-foreground, #ccc); }
.kb-stat-label { font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
.kb-stat-meta {
	padding: 2px; font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); word-break: break-all;
}
.kb-code-status {
	margin: 6px 2px 0; padding: 4px 8px; border-radius: 3px; font-size: 11px;
	color: var(--vscode-descriptionForeground, #999);
	background: var(--vscode-editorWidget-background, rgba(128,128,128,.08));
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.kb-code-status.busy { color: var(--vscode-textLink-foreground, #3794ff); }

/* ── 分区头（kbView.css:1000-1012）── */
.kb-side-section { padding: 2px 0 6px; }
.kb-side-section-head {
	display: flex; align-items: center; gap: 6px; padding: 4px 10px;
	font-size: 10px; text-transform: uppercase; letter-spacing: .5px; font-weight: 600;
	color: var(--vscode-descriptionForeground, #999);
}
.kb-side-section-head .kb-spacer { flex: 1; }

/* ── 诊断区：沿用 .kb-log 的外观（mono / 11px / 可滚动 / 只读），但装的是**静态诊断** ✓ ── */
.kb-log {
	display: block; width: calc(100% - 16px); min-height: 92px; max-height: 240px;
	margin: 0 8px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px;
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
	background: var(--vscode-input-background, transparent);
	color: var(--vscode-descriptionForeground, #999);
	font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5;
	white-space: pre-wrap; word-break: break-all; overflow: auto; outline: none;
}

/* ── 检索行（原 Pane 没有这一块；沿用同一套输入/按钮取值 ✓）── */
.kb-search {
	display: flex; align-items: center; gap: 4px; padding: 6px 8px;
	border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128,128,128,.25)));
}
.kb-search input {
	flex: 1; min-width: 0; font-size: 11px; padding: 3px 6px; border-radius: 3px;
	border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
	background: var(--vscode-input-background, transparent);
	color: var(--vscode-input-foreground, #ccc); outline: none;
}
.kb-search input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
.kb-search input + input { flex: 0 0 auto; width: 130px; }
.dsh-btn {
	background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
	border: 0; border-radius: 4px; padding: 4px 10px; font: inherit; cursor: pointer;
}
.dsh-link { color: var(--vscode-textLink-foreground, #3794ff); font-size: 11px; white-space: nowrap; }

/* ── 列表（检索结果 / 依赖 / 深度视图）：沿用原 Pane 的行观感（细分割线 + 两行）── */
.dsh-section { padding: 2px 0 4px; }
.dsh-section h2 {
	font-size: 10px; margin: 0; padding: 4px 10px; text-transform: uppercase; letter-spacing: .5px;
	font-weight: 600; color: var(--vscode-descriptionForeground, #999);
}
.dsh-section h2 small { color: inherit; font-weight: 600; }
.dsh-section h3 { font-size: 11px; margin: .8em 10px 4px; color: var(--vscode-descriptionForeground, #999); }
.dsh-section h3 small, .dsh-section small { color: var(--vscode-descriptionForeground, #999); font-weight: 400; }
.dsh-section ul { list-style: none; margin: 0; padding: 0 8px; }
.dsh-section li { padding: 5px 8px; border-radius: 4px; font-size: 12px; }
.dsh-section li:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
code { font-family: ui-monospace, Consolas, monospace; }
`;

/**
 * 页内交互（与看板 / 工作流页同一套做法）：点节点 → 在编辑器区打开这个符号所在处。
 *
 * 走宿主路由 /x/codebase/api/open，由插件经**反向通道**请求 IDE 能力 openFile —— 那个能力**早就实现**
 * （工作区校验 / 存在性检查 / 默认不抢焦点都在执行端），本插件只需在清单里**声明**它，零 src 改动。
 * 成功/失败都写进一行提示：失败把 IDE / 主进程给的原因原样显示，不静默。
 */
const CODEBASE_SCRIPT = `
(function () {
	var root = document.querySelector('[data-vssaros-page="codebase"]');
	if (!root) { return; }
	var flash = null;
	function say(text, isError) {
		if (!flash) {
			flash = document.createElement('div');
			flash.className = 'dsh-diag';
			flash.setAttribute('data-open-note', '');
			root.appendChild(flash);
		}
		flash.style.color = isError ? 'var(--vscode-errorForeground, #f48771)' : '';
		flash.textContent = text;
	}
	function open(path, line) {
		say('正在打开：' + path + (line ? ':' + line : ''), false);
		var url = '/x/codebase/api/open?path=' + encodeURIComponent(path) + (line ? '&line=' + encodeURIComponent(line) : '');
		fetch(url, { headers: { accept: 'application/json' } })
			.then(function (res) { return res.json().then(function (body) { return { ok: res.ok && body && body.ok, body: body }; }); })
			.then(function (out) {
				if (out.ok) { say('已打开：' + path, false); }
				else { say('打开失败：' + String((out.body && out.body.error) || '未知原因'), true); }
			})
			.catch(function (err) { say('打开失败：' + String(err && err.message ? err.message : err), true); });
	}
	Array.prototype.slice.call(root.querySelectorAll('[data-open-path]')).forEach(function (row) {
		var path = row.getAttribute('data-open-path') || '';
		var line = row.getAttribute('data-open-line') || '';
		row.style.cursor = 'pointer';
		row.addEventListener('click', function () { if (path) { open(path, line); } });
		row.addEventListener('keydown', function (event) {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				if (path) { open(path, line); }
			}
		});
	});
})();
`;

/**
 * 服务端渲染的只读代码图谱页 —— 外壳照 VsSaros 原容器 Pane 的规范（标题 / 工具条 / 分区 / 空态 /
 * 诊断行，样式在 `pageShell.js`）：原来是一张"平铺长页 + 16 行内联 CSS"，现在标题与统计卡进头部、
 * 检索表单进工具条、结果 / 依赖 / 深度视图各自成**分区**。
 *
 * 机器可断言的锚点**一个都没动**（探针按它们取数）：`body[data-vssaros-page=codebase]` 与诊断行上
 * 那串 `data-vssaros-codebase-*`（nodes / edges / project / root / tools / deep / ms / bytes / format）。
 * ★ 2026-10-12（P0）**新增两个**：`data-vssaros-codebase-parser`（available / unavailable）与
 * `data-vssaros-codebase-parser-langs`（可用语言数）—— 它们是"Host 侧解析器资产在哪"的**机器可断言事实** ✓。
 * ★ 2026-10-12（P1）**又加一个**：`data-vssaros-codebase-graph-source`（shadow / ide）——
 * "这张图是谁产的"必须能一眼看出来 ✓（影子产物一旦被读侧采用，读到的就**不是** IDE 那张图了 ✓）。
 */
function renderPage({ overview, deep, query, results, deps, toolsRegistered, parser, index, shape, projects }) {
	const manifest = overview.manifest;
	// ⚠ `overview.files` 可能整个不存在：`readOverview` 在**未配置 workspaceRoot**（Host 进程 cwd 不是工作区、
	// 且没有注入 config.workspaceRoot）等情况下返回的是 `{ error }`，不带 `files`。这里必须 fail-soft——
	// 否则页面渲染抛 `Cannot read properties of undefined (reading 'artifact.json')`，整页变成一段报错文本
	// （连 `data-vssaros-page` 都没有），把"没配 workspaceRoot"这个真原因彻底盖住。2026-10-11 实测（README 4.82）。
	const files = overview.files ?? {};
	// ⚠ 这里**不再**调 `graphStatsHtml`（那是**侧栏版**的形状 ✓）：编辑区版按原面板用四张卡（见下面的 `cardsHtml` ✓）
	// ⚠ 这两条仍被下面的 `diag` 引用（**别跟着统计块一起删** ✗ —— 2026-10-13 抽 `graphStatsHtml`
	//   时删过头：`node --check` 照样通过，页面渲染到 `diag` 时才 ReferenceError ⇒ 整页变一段报错文本
	//   （连 `data-vssaros-page` 都没有）。是 p3-11 的真机断言抓到的 ✓ —— 又一次"只有探针能看见"的错 ✓）。
	const fileLine = [MANIFEST_FILE, GRAPH_FILE, SQLITE_FILE]
		.map(name => `${escapeHtml(name)} ${files[name] ? bytesOf(files[name].bytes) : '缺失'}`)
		.join(' · ');
	const deepLine = deep
		? `已加载全量图：${deep.summary.nodes} 节点 / ${deep.summary.edges} 边 · ${deep.summary.files} 文件 · ${deep.summary.communities} 社区（${bytesOf(deep.bytes)}，${deep.ms}ms${deep.cached ? '，缓存命中' : ''}）`
		: '未加载全量图（轻路径：只读 artifact.json）';
	// P0 的解析器诊断：**只读资产目录**（几个 statSync/readdirSync ✓），**不在这里 parse** ✗ ——
	// 渲染路径上跑一次真解析会把"打开页面"变成"跑一次索引"（真源那条"零代码切档反而更慢"的教训同型 ✓）。
	// 拿不到也不当错误：`unavailable` 只是"这台机器上还没配/还没随包交付资产"，页面照常显示图谱 ✓。
	const parserLine = parser?.available
		? `解析器 <code>${escapeHtml(parser.dir)}</code>（${parser.languages.length} 语言 · 来自 ${escapeHtml(parser.source)}${parser.risk ? ' · ⚠ 只找到 `.js` 且落在 `type:module` 作用域' : ''}）`
		: `解析器不可用（${escapeHtml(String(parser?.why ?? '未探测'))}）`;
	// P1 的索引现状：**只读**（不在这里跑索引 ✗ —— 渲染路径上跑一次索引比"打开页面变慢"严重得多 ✓）。
	// ★ P3-b：这一行必须同时答两件事 —— "**有没有**影子产物" 与 "**读图走的是哪一份**" ✓
	//（影子被更新的 IDE 图顶掉时，只报前者会让人以为读的是影子 ✗）
	const indexLine = index && index.ok
		? `索引 ${index.target === 'workspace' ? '<strong>已交接</strong>（写工作区目录）' : '影子'} ${index.readable ? `有产物（${index.manifest?.nodeCount ?? '?'} 节点 / ${index.manifest?.edgeCount ?? '?'} 边，${isoOf(index.manifest?.savedAt)}）` : '还没有产物'}`
			+ `${index.orphanShadow?.savedAt !== undefined ? ` · ⚠ 影子里还留着旧产物（${isoOf(index.orphanShadow.savedAt)}，交接后不再被读）` : ''}`
			+ ` · 读图走 <strong>${escapeHtml(String(index.effectiveSource ?? '?'))}</strong>`
			+ `${index.effectiveAgeMs !== undefined ? `（这份图 ${ageOf(index.effectiveAgeMs)}前）` : ''}`
			+ `${index.staleShadow ? ` · ⚠ 影子比 IDE 的图旧 ${ageOf(index.staleShadow.ageMs)}（已让位给 IDE；重跑 codebase_index 即可回到影子 ✓）` : ''}`
			+ ` · <code>${escapeHtml(index.dir)}</code>（${escapeHtml(index.placement)}）`
			+ `${index.lock?.held ? ` · ⚠ 正在被 ${escapeHtml(String(index.lock.holder?.token ?? '未知'))} 索引` : ''}`
			+ `${index.watch?.active ? ` · 监听中（每 ${Math.round((index.watch.debounceMs ?? 0) / 1000)}s 合并一次变更${index.watch.pendingSince !== undefined ? ' · 有待处理变更' : ''}）` : ''}`
			// ★ 甲档·所有权交接（2026-10-14）的**三处显眼提示**（页面与状态工具同一份判断 ✓）：
			//   ① 交接档 + 保鲜没开 ⇒ IDE 不索引、我们也不自动索引 ⇒ 图会静默变旧 ✗
			+ `${index.target === 'workspace' && index.watch?.active !== true ? ` · ⚠ <strong>已交接给 dsh 但保鲜没开</strong>（<code>config.indexWatch</code> 不是 true）⇒ 图**不会自动更新** ✗` : ''}`
			//   ② 这份图有多旧（判决用 `effectiveStale` ✓ —— 阈值是我们定的启发式 ✓）
			+ `${index.effectiveStale ? ` · ⚠ 这份图已 <strong>${ageOf(index.effectiveAgeMs)}</strong> 没更新（阈值 ${ageOf(index.staleAfterMs)}）` : ''}`
			//   ③ **双输**：当前档 shadow、而工作区里那份清单还是我们的 ⇒ IDE 继续让路、dsh 又不写它 ✗✗
			+ `${index.orphanWorkspace ? ` · ⚠⚠ 工作区里还留着一份**我们产的**产物（${isoOf(index.orphanWorkspace.savedAt)}）⇒ **IDE 继续让路、dsh 又不写它 = 两边都不索引** ✗✗；改配置解决不了 ⇒ 用 <code>codebase_delete_project</code> 的 <code>which="workspace"</code> 删掉它 ✓` : ''}`
		: `索引不可用（${escapeHtml(String(index?.why ?? '未探测'))}）`;
	// ★ 2026-10-13：`kb-log` 是**外观**（mono/11px/可滚动，见 PAGE_CSS），锚点与文案**逐字不动** ✓
	const diag = `<p class="dsh-diag kb-log" data-vssaros-page="codebase" data-vssaros-codebase-nodes="${manifest?.nodeCount ?? ''}" data-vssaros-codebase-edges="${manifest?.edgeCount ?? ''}" data-vssaros-codebase-project="${escapeHtml(manifest?.project ?? '')}" data-vssaros-codebase-root="${escapeHtml(overview.workspaceRoot ?? '')}" data-vssaros-codebase-tools="${escapeHtml(toolsRegistered)}" data-vssaros-codebase-deep="${deep ? 'loaded' : 'light'}" data-vssaros-codebase-ms="${deep?.ms ?? ''}" data-vssaros-codebase-bytes="${deep?.bytes ?? ''}" data-vssaros-codebase-format="${escapeHtml(manifest?.format ?? '')}" data-vssaros-codebase-parser="${parser?.available ? 'available' : 'unavailable'}" data-vssaros-codebase-parser-langs="${parser?.available ? parser.languages.length : ''}" data-vssaros-codebase-graph-source="${escapeHtml(overview.graphSource ?? '')}" data-vssaros-codebase-graph-parser="${escapeHtml(index?.graphParser ?? '')}" data-vssaros-codebase-graph-parser-why="${escapeHtml(index?.graphParserWhy ?? '')}" data-vssaros-codebase-graph-ms="${index?.graphMetaMs ?? ''}" data-vssaros-codebase-graph-incremental="${index?.graphMetaIncremental === undefined ? '' : (index.graphMetaIncremental ? 'yes' : 'no')}" data-vssaros-codebase-index-readable="${index?.readable === true ? 'yes' : 'no'}" data-vssaros-codebase-target="${escapeHtml(String(index?.target ?? 'shadow'))}" data-vssaros-codebase-handover-watch-off="${index?.target === 'workspace' && index?.watch?.active !== true ? 'yes' : 'no'}" data-vssaros-codebase-effective-stale="${index?.effectiveStale === true ? 'yes' : 'no'}" data-vssaros-codebase-orphan-workspace="${index?.orphanWorkspace ? 'yes' : 'no'}">工作区 <code>${escapeHtml(overview.workspaceRoot ?? '(未配置)')}</code> · 图谱目录 <code>${escapeHtml(overview.dir ?? '')}</code> · ${fileLine}<br>${deepLine} · ${parserLine}<br>${indexLine}${overview.manifestError ? ` · <b>清单错误</b>：${escapeHtml(overview.manifestError)}` : ''}</p>`;
	const form = `<form class="kb-search" method="get">
	<span>🔍</span>
	<input name="q" value="${escapeHtml(query ?? '')}" placeholder="按名字检索节点（会加载全量图）" aria-label="按名字检索节点">
	<input name="file" value="${escapeHtml(deep?.file ?? '')}" placeholder="限定文件路径片段" aria-label="限定文件路径片段">
	<button class="dsh-btn" type="submit">检索</button>
</form>`;
	// 「诊断」区（P0/P1/P3-b 那些事实行）——沿用原 Pane 日志位的外观，但**诚实叫诊断** ✓
	// （本页没有运行时日志可打；把静态事实说成"日志"会是另一种静默失真 ✗）
	const diagPanel = `<div class="kb-side-section">
	<div class="kb-side-section-head"><span>诊断（只读）</span><span class="kb-spacer"></span><span>${deep ? '全量图已加载' : '轻路径'}</span></div>
	${diag}
</div>`;
	const notices = `${overview.error ? `<p class="dsh-empty">${escapeHtml(overview.error)}</p>` : ''}`
		+ `${overview.missing ? `<p class="dsh-empty">还没有图谱：<code>${escapeHtml(overview.missing)}</code>（在 VsSaros 里建过代码图谱后这里会出现）。</p>` : ''}`;
	const resultsHtml = results
		? (results.length
			? `<ul>${results.map(nodeRow).join('')}</ul>`
			: `<p class="dsh-empty">没有命中（query=${escapeHtml(query)}）。</p>`)
		: '';
	const depsHtml = deps
		? `<p class="dsh-diag">${deps.error
			? escapeHtml(deps.error)
			: `${deps.targets.length} 个节点：用出 ${deps.usesTotal} 条 / 被用 ${deps.usedByTotal} 条${deps.dangling ? `（${deps.dangling} 条边指向图外节点）` : ''}`}</p>
${deps.error ? '' : `<h3>它用了什么 <small>${deps.uses.length}/${deps.usesTotal}</small></h3><ul>${deps.uses.map(entry => `<li><small>${escapeHtml(entry.type)}</small> <code>${escapeHtml(entry.name)}</code> <small>${escapeHtml(shortFile(entry.filePath))}</small></li>`).join('') || '<li class="dsh-empty">没有出边</li>'}</ul>
<h3>谁用了它 <small>${deps.usedBy.length}/${deps.usedByTotal}</small></h3><ul>${deps.usedBy.map(entry => `<li><small>${escapeHtml(entry.type)}</small> <code>${escapeHtml(entry.name)}</code> <small>${escapeHtml(shortFile(entry.filePath))}</small></li>`).join('') || '<li class="dsh-empty">没有入边</li>'}</ul>`}`
		: '';
	// ★★ 2026-10-13：整页按**原「Codebase Memory」面板**（`codebaseMemoryDetailEditorPane.ts`）的分区顺序重排 ✓
	const graphBytes = overview.files?.[GRAPH_FILE]?.bytes;
	const fileCount = deep?.summary?.labels?.find(entry => /^file$/i.test(String(entry.name)))?.count;
	// ① 四张统计卡（原面板 `_renderStats` ✓：Nodes / Edges / Files / Last Index ✓）。
	//   ⚠ Files 只有**全量图**才知道（清单里没有 fileCount ✗）⇒ 没加载就如实写"—"并说明怎么拿 ✓（不猜 ✗）
	const cardsHtml = `<div class="cbm-cards">${
		cbmCard('accent', '🔗', manifest?.nodeCount ?? '—', 'Nodes', 'functions · classes · interfaces')
		+ cbmCard('green', '↔️', manifest?.edgeCount ?? '—', 'Edges', 'calls · imports · defines')
		+ cbmCard('blue', '📁', fileCount ?? '—', 'Files', fileCount === undefined ? '需加载全量图（见 Graph Details）' : 'indexed source files')
		+ cbmCard('purple', '⚡', isoOf(manifest?.savedAt), 'Last Index', bytesOf(graphBytes))
	}</div>`;
	// ② ⚙️ Index Configuration —— 只放 **dsh 侧真有的配置** ✓（原版那三档与 Exclude/Keep 属于 IDE 索引器 ✗）
	const configSection = cbmSection({
		id: 'config', icon: '⚙️', title: 'Index Configuration', badge: escapeHtml(String(index?.target ?? 'shadow')),
		bodyHtml: [
			cbmKv('落点', `<code>${escapeHtml(String(index?.dir ?? ''))}</code>（<code>${escapeHtml(String(index?.placement ?? '?'))}</code> 依据）`),
			cbmKv('解析器', parser?.available
				? `${parser.languages.length} 语言 · 来自 ${escapeHtml(parser.source)} · <code>${escapeHtml(parser.dir)}</code>`
				: `不可用（${escapeHtml(String(parser?.why ?? '未探测'))}）`),
			cbmKv('保鲜', index?.watch?.active ? `监听中（每 ${Math.round((index?.watch?.debounceMs ?? 0) / 1000)}s 合并变更${index?.watch?.pendingSince !== undefined ? ' · 有待处理变更' : ''}）` : '未启用'),
			// ★ 甲档·所有权交接（2026-10-14）：把"交接意味着什么"写在**显眼的一格**里 ✓
			//   （甲档不是"更快的档"，它是**换责任人**：IDE 不再索引 ⇒ 图会不会变新只取决于我们 ✓✗）
			cbmKv('交接状态', index?.target === 'workspace'
				? (index?.watch?.active === true
					? `已交接给 dsh（IDE **不再索引** ✓）；保鲜**已开** ⇒ 图会跟着改动更新 ✓`
					: `⚠ 已交接给 dsh（IDE **不再索引** ✓）但保鲜**没开**（<code>config.indexWatch</code> 不是 true）⇒ 只有手动跑 <code>codebase_index</code> 才更新，**图会静默变旧** ✗；<strong>开法</strong> ✓：覆盖层的 <code>vssaros-codebase:</code> 下加一行 <code>indexWatch: true</code>`)
				: `影子档（IDE 仍会自己索引工作区 ✓ —— 代价是**双份索引**，且两边视图**可能给出不同答案** ⚠）`),
			cbmKv('图的新鲜度', typeof index?.effectiveAgeMs === 'number'
				? `${ageOf(index.effectiveAgeMs)}前（${isoOf(index.effectiveSavedAt)}）${index.effectiveStale ? ` · ⚠ **已超过判决阈值**（${ageOf(index.staleAfterMs)}）⇒ 检索可能在用旧事实回答${index.target === 'workspace' ? '（甲档：没人会自动更新它 ✗）' : ''}` : ' ✓'}`
				: '不知道（这份图没有 `saved_at` ⇒ 判不了新旧，**不猜** ✗）'),
			...(index?.orphanWorkspace
				? [cbmKv('⚠ 双输风险', `工作区里还留着一份**我们产的**产物（<code>${escapeHtml(String(index.orphanWorkspace.dir))}</code>，${isoOf(index.orphanWorkspace.savedAt)}）⇒ IDE 见到它**继续让路**、而 dsh 又不写那里 ⇒ **两边都不索引** ✗✗；⚠ 改回配置**不解决**（权限凭据是那份清单 ✓）⇒ 用 <code>codebase_delete_project</code> 的 <code>which="workspace"</code>（或 <code>"both"</code>）删掉它 ✓`)]
				: []),
			// ★ P7：**这份图是哪一档建的**（与「解析器」那格是**两件事** ✗：那格说"本机资产在不在"，
			//   这格说"你正在读的这张图是谁用哪一档产的" ✓ —— 档位决定答案质量 ✓）
			cbmKv('产图档位', index?.graphParser
				? `<strong>${escapeHtml(String(index.graphParser))}</strong> · ${escapeHtml(String(index.graphParserWhy ?? ''))}`
					+ `${typeof index.graphMetaMs === 'number' ? ` · 上次**实测**用了 <strong>${Math.round(index.graphMetaMs / 1000)}s</strong>${index.graphMetaIncremental === false ? '（全量重解析 ✓）' : index.graphMetaIncremental === true ? '（增量 ✓）' : ''}` : ' · ⚠ 没有耗时记录（这份图不是这一代索引器产的 ⇒ 重建要多久**说不准** ✗）'}`
				: `未知（${escapeHtml(String(index?.graphParserWhy ?? '未探测'))}）`),
			// ★ P7：**代价**要给"实测值"，不是估算公式 ✓（重建要多久，取决于档位 + 增量/全量 —— 这两件上次都记下来了 ✓）
			cbmKv('重建代价参考', typeof index?.graphMetaMs === 'number'
				? `上一次 <strong>${Math.round(index.graphMetaMs / 1000)}s</strong>（${escapeHtml(String(index.graphParser ?? '?'))}${index.graphMetaIncremental === false ? ' / 全量' : index.graphMetaIncremental === true ? ' / 增量' : ''} ✓）—— **实测值**，不是估算 ✓`
					// ★ O2（2026-10-14）：把"最近几次"摆在旁边 ⇒ 能看出**趋势**（"这次比上次快/慢" ✓），不只"上一次" ✗
					+ `${Array.isArray(index?.graphMetaHistory) && index.graphMetaHistory.length > 1
						? `<br><small>最近 ${index.graphMetaHistory.length} 次（新→旧 ✓）：${index.graphMetaHistory.map(item => `${Math.round((item.ms ?? 0) / 1000)}s·${escapeHtml(String(item.parser ?? '?'))}${item.incremental === true ? '·增量' : item.incremental === false ? '·全量' : ''}`).join(' → ')}</small>`
						: ''}`
				: '没有耗时记录：这份图不是这一代 dsh 索引器产的（或还没建过 ✓）'),
			cbmKv('增量缓存', index?.cache?.files !== undefined ? `${index.cache.files} 个文件（${isoOf(index.cache.savedAt)}）` : '无'),
			`<p class="cbm-note">索引是**写动作**（有成本）⇒ 页面**不提供触发**：走审批闸的工具 <code>codebase_index</code>（在对话里让我跑，或经命令面板 ✓）。原版的 Fast / Moderate / Full 三档与 Exclude / Keep 属于 IDE 侧索引器，dsh 侧没有对应物 ⇒ 这里不摆不能用的控件 ✗。</p>`,
			// B②（2026-10-13）：档位在 dsh 侧的**真实**等价语义（**不借用** Fast/Moderate/Full 的名字 ✗ —— 假映射比没有更坏）
			`<h3 data-cbm-kb-tier="1">索引档位（dsh 的真实档位）</h3>
			<p class="cbm-note">dsh 侧只有<strong>两档</strong>，由 <code>codebase_index</code> 的 <code>parser</code> 参数决定；<strong>P7 起缺省是 <code>auto</code></strong>（<strong>按能力挑档</strong> ✓，不是第三种档位 ✓）：<br>
				· <strong>缺省</strong> <code>parser: "auto"</code>：本机 tree-sitter 资产可用 ⇒ 用真解析档 ✓；不可用 ⇒ <strong>如实降级</strong>到快档并写明为什么（返回值 <code>degraded</code> ✓）—— 降级可以是好选择，<strong>静默</strong>降级不是 ✗；<br>
				· <strong>快档</strong> <code>parser: "regex"</code>（<strong>显式</strong>）：顶层声明的正则近似 + <code>IMPORTS</code>/<code>CONTAINS</code> 边 ⇒ <strong>秒级</strong>；符号边界与行号是近似的 ✗；<br>
				· <strong>真解析档</strong> <code>parser: "treesitter"</code>：符号与起止行准确，并产出 <code>CALLS</code>/<code>USAGE</code>/<code>INHERITS</code>/<code>IMPLEMENTS</code> 四种边 ⇒ <strong>慢</strong>（全仓分钟级；需要随包资产可用 ✓）；<br>
				· 原版的第三档 <code>full</code>（语义/相似度索引）在 dsh 侧<strong>没有移植</strong> ⇒ <strong>不摆</strong> ✗（要它就得先做那部分引擎）。</p>`,
		].join(''),
	});
	// ③ 🌐 Graph Details（原面板：Storage / Last Modified / Node Types / Edge Types + View 3D Graph / Refresh / Open Directory ✓）
	const detailsSection = cbmSection({
		id: 'details', icon: '🌐', title: 'Graph Details', badge: bytesOf(graphBytes), open: true,
		bodyHtml: [
			cbmKv('Storage', `<code>${escapeHtml(String(overview.dir ?? ''))}</code>`),
			cbmKv('Last Modified', escapeHtml(isoOf(manifest?.savedAt)) + (overview.ageMs !== undefined ? `（${ageOf(overview.ageMs)}前）` : '')),
			cbmKv('Node Types', deep ? `<ul>${pairRows(deep.summary.labels)}</ul>` : '未加载全量图'),
			cbmKv('Edge Types', deep ? `<ul>${pairRows(deep.summary.edgeTypes)}</ul>` : '未加载全量图'),
			'<p class="cbm-note" data-kb-action-status></p>',
			`<div class="cbm-btn-group">${cbmBtn('🕸 图浏览（只读）', { href: `${ROUTE_PREFIX}/?view=graph`, primary: true })}`
				+ `${cbmBtn(deep ? '🌐 重新加载全量图' : '🌐 加载全量图', { href: `${ROUTE_PREFIX}/?deep=1` })}`
				+ `${cbmBtn('🔄 Refresh', { href: `${ROUTE_PREFIX}/?refresh=1` })}`
				+ `${cbmBtn('📂 Open Directory', { reveal: String(overview.dir ?? '') })}</div>`,
			`<p class="cbm-note">ℹ 原版的「View 3D Graph」是**三维**渲染 ⇒ dsh 侧没有对应物；这里给的是同一份数据的**只读图浏览**（<code>?view=graph</code>：类型分布 / 入度出度排行 / 按类型筛选 / 节点出入依赖 ✓）—— 不含 3D 与力导向布局 ✗（那一页自己也如实写着 ✓）。</p>`,
		].join(''),
	});
	// ④ 🏗️ Architecture（原版对**大图**是 deferred + Compute Now ✓ —— 这里同款：社区数来自全量图 ✓）
	const archSection = cbmSection({
		id: 'architecture', icon: '🏗️', title: 'Architecture',
		badge: deep ? `${deep.summary.communities ?? 0} communities` : 'Deferred',
		bodyHtml: deep
			? `${cbmKv('社区（communities）', String(deep.summary.communities ?? 0))}${cbmKv('文件', String(deep.summary.files ?? '?'))}${cbmKv('节点类型', `${deep.summary.labels.length} 类`)}`
				+ '<p class="cbm-note">分层 / 跨包这类**视角**用工具看更全：<code>codebase_architecture</code>（社区 · 分层 · 跨包依赖 ✓）。</p>'
			: `<p class="cbm-note">全量图未加载 ⇒ 架构分析先不算（原版对**大图**也是 deferred —— 省掉一次全图遍历 ✓）。</p>`
				+ `<div class="cbm-btn-group">${cbmBtn('🔍 Compute Now（加载全量图）', { href: `${ROUTE_PREFIX}/?deep=1` })}</div>`,
	});
	// ⑤ 🔍 Query Console（= 既有的检索 + 依赖；**机器锚点与行结构逐字未改** ✓，探针按它们取数 ✓）
	// A②（2026-10-13）：**形状查询**块（Cypher 的诚实子集 —— 支持什么一目了然 ✓；不支持的**明确报错并列出支持项** ✓）
	const shapeOutcome = shape?.outcome;
	// ⚠ 2026-10-14 修自相矛盾：这里原写着「形状查询（**Cypher 的子集**）」✗，而同一块下面两行就写着
	//   「⚠ **这不是 Cypher**」✓ —— 与 `shapeQuery.js` 的纪律直接打架 ✓（"Cypher 的子集"会让人以为
	//   多数 Cypher 能用、少数字集不支持；真相是**只认那几种形状**，其它一律拒 ✗✗）。
	const shapeBlock = `<h3 data-cbm-shape="1">形状查询（<strong>不是 Cypher</strong> ✗）</h3>
		<form class="kb-search" method="get">
			<span>🧩</span>
			<input name="shape" value="${escapeHtml(shape?.text ?? '')}" placeholder="type:class / file:src/vs/editor / deps:localize / hot:20" aria-label="形状查询">
			<button class="dsh-btn" type="submit">跑</button>
		</form>
		${chipRow(SHAPE_HELP.map(entry => ({ label: escapeHtml(entry.usage), href: `${ROUTE_PREFIX}/?shape=${encodeURIComponent(entry.example)}` })))}
		${!shapeOutcome ? '' : (shapeOutcome.error
			? `<p class="dsh-empty" data-shape-error="1">形状查询没跑：${escapeHtml(String(shapeOutcome.error))}${shapeOutcome.hint ? `<br><small>${escapeHtml(String(shapeOutcome.hint))}</small>` : ''}</p>`
			: `<p class="dsh-diag" data-shape-ok="1">${escapeHtml(String(shapeOutcome.title ?? ''))}</p>`
				+ `${shapeOutcome.rows?.length ? `<ul>${shapeOutcome.rows.map(nodeRow).join('')}</ul>` : ''}`
				+ `${shapeOutcome.deps && !shapeOutcome.deps.error ? `<h3>它用了什么 <small>${shapeOutcome.deps.uses.length}/${shapeOutcome.deps.usesTotal}</small></h3><ul>${shapeOutcome.deps.uses.map(entry => `<li><small>${escapeHtml(entry.type)}</small> <code>${escapeHtml(entry.name)}</code> <small>${escapeHtml(shortFile(entry.filePath))}</small></li>`).join('') || '<li class="dsh-empty">没有出边</li>'}</ul>
<h3>谁用了它 <small>${shapeOutcome.deps.usedBy.length}/${shapeOutcome.deps.usedByTotal}</small></h3><ul>${shapeOutcome.deps.usedBy.map(entry => `<li><small>${escapeHtml(entry.type)}</small> <code>${escapeHtml(entry.name)}</code> <small>${escapeHtml(shortFile(entry.filePath))}</small></li>`).join('') || '<li class="dsh-empty">没有入边</li>'}</ul>` : ''}`
				+ `${shapeOutcome.note ? `<p class="cbm-note">${escapeHtml(String(shapeOutcome.note))}</p>` : ''}`)}
		<p class="cbm-note">⚠ <strong>这不是 Cypher</strong>：只认上面列出的 ${SHAPE_HELP.length} 种写法（别的输入会<strong>明确报错并列出支持项</strong> ✓ —— "看着支持整门语言、其实只跑通一条"是最坏的形态 ✗）。要更复杂的图问题用工具：<code>codebase_search</code> / <code>codebase_deps</code> / <code>codebase_trace</code> / <code>codebase_hotspots</code> ✓。</p>`;
	const querySection = cbmSection({
		id: 'query', icon: '🔍', title: 'Query Console', badge: shape?.text ? escapeHtml(shape.text) : (query ? escapeHtml(query) : '轻路径'), open: Boolean(results || deps || shapeOutcome),
		bodyHtml: `${form}${resultsHtml ? `<div class="dsh-section"><h2>检索结果 <small>${results.length} 条</small></h2>${resultsHtml}</div>` : ''}${depsHtml ? `<div class="dsh-section"><h2>依赖</h2>${depsHtml}</div>` : ''}${shapeBlock}
			<p class="cbm-note">按名字检索会解压全量图（${bytesOf(graphBytes)}）⇒ 首查慢、之后有缓存 ✓；原版的 Cypher 控制台 dsh 侧没有（这里是**形状查询**子集 ✓，见上）。</p>`,
	});
	// ⑥ 🔬 Analysis Tools（原面板列工具 ✓；dsh 侧列**真有的**读工具 + 入度最高的节点 ✓）
	const toolsSection = cbmSection({
		id: 'tools', icon: '🔬', title: 'Analysis Tools', badge: '21 个工具',
		bodyHtml: `${deep ? `<h3>🔥 Hotspots（入度最高）</h3><ul>${deep.hotspots.map(nodeRow).join('')}</ul>` : ''}
			${(() => {
				// P11（2026-10-14）：**移植完成度**放到页面上 —— 数字从 `PORT_AUDIT` **现算** ✓（不硬编码 ✗），
				// 并把"表里写了、这次部署却没注册"的工具**当场列出来** ✗（改了名字忘了改表 = 一眼现形 ✓）。
				// ⚠ 页面上"没有对应物"的**不许写成空白** ✗：结论（不移植 + 理由）本身也是交付物 ✓。
				const audit = portAuditOf(toolsRegistered);
				return `<h3 data-cbm-port-audit="1">移植状态 <small>真源 ${audit.sourceTools} 个工具：${audit.mapped} 个 1:1 · ${audit.replaced} 个换了语言 · ${audit.conclusions} 个写成结论</small></h3>
				<div data-vssaros-codebase-port-mapped="${audit.mapped}" data-vssaros-codebase-port-replaced="${audit.replaced}" data-vssaros-codebase-port-conclusions="${audit.conclusions}" data-vssaros-codebase-port-missing="${escapeHtml(audit.missing.join(','))}">
				<p class="cbm-note">${audit.missing.length
					? `⚠ <strong>表里写着、这次部署却没注册</strong>：<code>${audit.missing.map(m => escapeHtml(String(m))).join('</code> / <code>')}</code> ✗（改了工具名忘了改表，就在这一行现形 ✓）`
					: `表里 ${audit.mapped + audit.replaced} 个有对应物的工具**这次部署全在** ✓；另有 ${audit.conclusions} 个是**明确不移植**的结论 ✓；dsh 侧还多出 ${audit.extra.length} 个（${audit.extra.map(m => `<code>${escapeHtml(String(m))}</code>`).join(' · ')} ✓）`}</p>
				<ul class="cbm-tools">
				${PORT_AUDIT.filter(entry => entry.to).map(entry => `<li><code>${escapeHtml(entry.from)}</code> → <code>${escapeHtml(entry.to)}</code> ✓</li>`).join('')}
				${PORT_AUDIT.filter(entry => entry.replacedBy).map(entry => `<li><code>${escapeHtml(entry.from)}</code> → <code>${escapeHtml(entry.replacedBy)}</code> <strong>（换了语言 ✓）</strong><br><small>${escapeHtml(entry.why)}</small></li>`).join('')}
				${PORT_AUDIT.filter(entry => entry.conclusion).map(entry => `<li><code>${escapeHtml(entry.from)}</code> <strong>（不移植 ✓）</strong><br><small>${escapeHtml(entry.conclusion)}</small></li>`).join('')}</ul></div>`;
			})()}
			<ul class="cbm-tools">
				<li><code>codebase_overview</code> 总览（轻路径 ✓）</li>
				<li><code>codebase_search</code> 按名字检索符号</li>
				<li><code>codebase_deps</code> 一个符号的出入依赖</li>
				<li><code>codebase_hotspots</code> 入度/出度最高的节点</li>
				<li><code>codebase_trace</code> 调用链（CALLS 多跳）</li>
				<li><code>codebase_architecture</code> 社区 / 分层 / 跨包</li>
				<li><code>codebase_schema</code> 图谱模式（节点/边类型统计）</li>
				<li><code>codebase_snippet</code> 按节点取源码片段</li>
				<li><code>codebase_changes</code> 索引之后的改动面</li>
				<li><code>codebase_index</code> / <code>codebase_index_status</code> 索引与状态（写动作走审批闸 ✓）</li>
				<li><code>codebase_coverage</code> 覆盖率（图里 vs 现在扫得到 ✓；只给"哪边多出来"，不给逐文件原因 ✗）</li>
				<li><code>codebase_delete_project</code> 删除本工作区的索引产物（破坏性 ⇒ 审批闸 ✓；红线：绝不删工作区根 ✓）</li>
				<li><code>codebase_export_artifact</code> / <code>codebase_import_artifact</code> 制品导出 / 导入（导入是**不可信输入** ⇒ 先验证再落盘 ✓，会覆盖现有产物 ⇒ 审批闸 ✓）</li>
				<li><code>codebase_search_code</code> <strong>文本</strong>搜索（真源 <code>search_code</code> ✓；与 <code>codebase_search</code> 的<strong>图</strong>上按名字找节点是<strong>两件事</strong> ✗；不需要索引 ✓）</li>
				<li><code>codebase_search_files</code> 按<strong>名字</strong>找文件 / 内容搜索四模式（真源 <code>search_files</code> ✓；<code>mode: files</code> 只读目录项 ⇒ 与文件大小无关 ✓）</li>
				<li><code>codebase_manage_adr</code> 架构决策记录（真源 <code>manage_adr</code> ✓；落在工作区 <code>.codebase-memory/adr/</code> ⇒ ADR 是<strong>仓库内容</strong> ✓、要跟着 git 走 ✓；读动作不追问 ✓、写动作走审批闸 ✓）</li>
				<li><code>codebase_query_graph</code> 形状查询（真源 <code>query_graph</code> 的对应物 ✓ —— 但 <strong>不是 Cypher</strong> ✗：只认 <code>SHAPE_HELP</code> 那六种写法，其它输入当场拒并列清单 ✓）</li>
			</ul>
			<p class="cbm-note">页面**不**代替工具执行（写动作与重活都在工具/对话里 ✓）—— 这里列出"有哪些工具、各自干嘛" ✓。</p>`,
	});
	// ⑦ 📦 Projects（2026-10-13 做实）：与工具 `codebase_projects` **同一个源**（`projectsOf` ✓）——
	// 一张图可能覆盖多个工作区根 ⇒ "图里有哪些项目"必须能看见 ✓；但那是**全量图**才知道的事 ⇒ 没加载就照实说 ✓
	const projectsSection = cbmSection({
		id: 'projects', icon: '📦', title: 'Projects',
		badge: projects?.length ? `${projects.length} 个项目` : escapeHtml(String(manifest?.project ?? '—')),
		bodyHtml: `${projects?.length
			? `<ul data-cbm-projects="1">${projects.map(entry => `<li><code>${escapeHtml(String(entry.project))}</code> <small>${entry.nodes} 节点 / ${entry.edges} 边 / ${entry.files} 文件${entry.topLabels?.length ? ` · ${entry.topLabels.slice(0, 3).map(label => `${escapeHtml(String(label.name))}×${label.count}`).join(', ')}` : ''}</small></li>`).join('')}</ul>`
			: '<p class="cbm-note" data-cbm-projects="light">一张图可能覆盖<strong>多个工作区根</strong> —— 要列"图里有哪些项目"，得先加载全量图 ✓（用 Graph Details 的「加载全量图」，或跑 <code>codebase_projects</code> 工具 ✓）。</p>'}`
			+ `${cbmKv('项目（清单）', escapeHtml(String(manifest?.project ?? '未知')))}${cbmKv('工作区根', `<code>${escapeHtml(String(overview.workspaceRoot ?? '(未配置)'))}</code>`)}`
			+ '<p class="cbm-note">⚠ 这节只说明"<strong>图里</strong>有什么" —— 不代表磁盘上还有那些文件（图可能已过期 ✓）。</p>',
	});
	// ⑧ 📋 Activity Log（**如实**：dsh 侧不保留历史日志 ✓ —— 给的是"现在这一刻的索引事实" ✓）
	const busyNow = index?.lock?.held === true || index?.watch?.pendingSince !== undefined;
	// 「此刻」的索引事实（读图走哪一份 / 锁 / 保鲜 / 增量缓存 —— 与状态工具同一口径 ✓，不编造历史 ✗）
	const activityLine = [
		cbmKv('读图走', `<strong>${escapeHtml(String(index?.effectiveSource ?? '?'))}</strong>${index?.effectiveAgeMs !== undefined ? `（这份图 ${ageOf(index.effectiveAgeMs)}前）` : ''}`),
		cbmKv('锁', index?.lock?.held ? `被 ${escapeHtml(String(index.lock.holder?.token ?? '未知'))} 持有${index.lock.ageMs !== undefined ? `（${Math.round(index.lock.ageMs / 1000)}s 前）` : ''}` : '空闲'),
		cbmKv('保鲜', index?.watch?.active ? `监听中（已跑 ${index.watch.runs ?? 0} 轮${index.watch.pendingSince !== undefined ? ' · 有待处理变更' : ''}）` : '未启用'),
		cbmKv('增量缓存', index?.cache?.files !== undefined ? `${index.cache.files} 个文件（${isoOf(index.cache.savedAt)}）` : '无'),
	].join('');
	const activitySection = cbmSection({
		id: 'log', icon: '📋', title: 'Activity Log', badge: busyNow ? '正在索引' : '空闲',
		bodyHtml: `${activityLine}`
			+ '<p class="cbm-note">⚠ dsh 侧**不保留历史日志**（索引由工具触发、日志在 IDE 宿主侧）⇒ 这里只有"此刻"的状态，不是日志回放 ✗。</p>',
	});
	return renderShell({
		kind: 'codebase',
		title: '代码图谱',
		subtitle: '只读 · 在 Host 进程内查询',
		headerHtml: `<div class="kb-view">
<div class="kb-header">
	<span class="kb-title"><span>🕸</span><span>Codebase Memory</span></span>
	<span class="kb-spacer"></span>
	<span class="cbm-pill${busyNow ? ' busy' : ''}">${busyNow ? 'Indexing…' : (overview.missing ? 'Not Indexed' : 'Ready')}</span>
	<a class="kb-hbtn" href="${ROUTE_PREFIX}/?refresh=1" title="刷新（重读清单，不解压图谱）" aria-label="刷新">⟳</a>
</div>
<div class="kb-panel">
	<div class="kb-panel-bar"><span class="kb-panel-bar-label">代码图谱</span><span class="kb-spacer"></span><span class="kb-stat-hero-label">只读 · 在 Host 进程内查询</span></div>
	<div class="kb-panel-content">`,
		// ⚠ 顺序 = 原面板的顺序 ✓：统计卡 → 配置 → 图谱细节 → 架构 → 查询 → 分析工具 → 项目 → 活动 ✓（诊断锚点殿后 ✓）
		bodyHtml: `${cardsHtml}${configSection}${detailsSection}${archSection}${querySection}${toolsSection}${projectsSection}${activitySection}${diagPanel}${notices}</div>
</div>
</div>`,
		extraCss: PAGE_CSS,
		script: `${CODEBASE_SCRIPT}${DETAIL_ACTIONS_SCRIPT}`,
	});
}

// ── 原「Codebase Memory」面板的积木（2026-10-13：用户要求**照原 DOM 版**重排编辑区页）─────────────
// 规格取自 `src/vs/sessions/contrib/agentStudio/browser/codebaseMemoryDetailEditorPane.ts`（原面板 ✓）：
// 四张统计卡 → ⚙️ Index Configuration → 🌐 Graph Details → 🏗️ Architecture → 🔍 Query Console →
// 🔬 Analysis Tools → 📦 Projects → 📋 Activity Log ✓。
// ⚠ 只有**能被 dsh 真支撑**的部分照搬；做不到的在原地**说清**（例如 3D 图、Cypher、索引三档档位 ✗✗ ——
//   摆一个点了没用的按钮才是本仓最贵的那类静默失真 ✓）。

/** 统计卡（原面板 `_appendStatCard` 的形状：图标 + 大数字 + 标签 + 一行小字 ✓）。 */
function cbmCard(cls, icon, num, label, sub) {
	return `<div class="cbm-card ${cls}">
	<span class="cbm-card-icon">${icon}</span>
	<span class="cbm-card-num">${escapeHtml(String(num))}</span>
	<span class="cbm-card-label">${escapeHtml(label)}</span>
	<span class="cbm-card-sub">${escapeHtml(sub)}</span>
</div>`;
}

/** 可折叠分区（用原生 `<details>`：**不依赖脚本**也能开合 —— 与"SSR 页面不假装有交互"一致 ✓）。 */
function cbmSection({ id, icon, title, badge, open = false, bodyHtml }) {
	return `<details class="cbm-section"${open ? ' open' : ''}${id ? ` data-cbm-section="${id}"` : ''}>
	<summary><span>${icon}</span><span>${escapeHtml(title)}</span>${badge ? `<span class="cbm-section-badge">${badge}</span>` : ''}</summary>
	<div class="cbm-section-body">${bodyHtml}</div>
</details>`;
}

/** 键值行（原面板的 Storage / Last Modified / Node Types … 那些 ✓）。 */
function cbmKv(key, value) {
	return `<div class="cbm-kv"><span class="key">${escapeHtml(key)}</span><span class="val">${value}</span></div>`;
}

/** 按钮组里的一枚（`data-kb-href` 的会走脚本里的整页跳转 ✓，`data-kb-reveal` 的走页面桥定位 ✓）。 */
function cbmBtn(label, { href, reveal, primary = false } = {}) {
	const cls = `cbm-btn${primary ? ' primary' : ''}`;
	if (href) {
		return `<a class="${cls}" data-kb-href="${escapeHtml(href)}" href="${escapeHtml(href)}">${label}</a>`;
	}
	if (reveal !== undefined) {
		return `<button type="button" class="${cls}" data-kb-reveal="${escapeHtml(reveal)}">${label}</button>`;
	}
	return `<span class="${cls} disabled">${label}</span>`;
}

/** 分布条（**纯 CSS 宽度**表示占比：页面不引任何前端库 ⇒ 这是最省的"可视化" ✓）。 */
function barsHtml(pairs, { limit = 12 } = {}) {
	const top = (pairs ?? []).slice(0, limit);
	if (!top.length) {
		return '<p class="dsh-empty">没有可显示的分布</p>';
	}
	const peak = Math.max(1, ...top.map(pair => Number(pair.count) || 0));
	const rows = top.map(pair => {
		const count = Number(pair.count) || 0;
		const pct = Math.max(2, Math.round((count / peak) * 100));
		return `<div class="cbm-bar"><span class="cbm-bar-label">${escapeHtml(String(pair.name ?? pair.type ?? '?'))}</span><span class="cbm-bar-track"><span class="cbm-bar-fill" style="width:${pct}%"></span></span><span class="cbm-bar-num">${count}</span></div>`;
	}).join('');
	return `<div class="cbm-bars">${rows}</div>`
		+ `${(pairs?.length ?? 0) > top.length ? `<p class="cbm-note">另有 ${pairs.length - top.length} 类未列（按数量降序只显示前 ${top.length} ✓）</p>` : ''}`;
}

/** 一排筛选/跳转按钮（`data-kb-href` ⇒ 脚本做整页跳转；`href` 兜底 ⇒ 没脚本也能用 ✓）。 */
function chipRow(items) {
	return `<div class="cbm-btn-group">${items.map(item => `<a class="cbm-btn${item.active ? ' primary' : ''}" data-kb-href="${escapeHtml(item.href)}" href="${escapeHtml(item.href)}">${item.label}</a>`).join('')}</div>`;
}

/**
 * ★ 只读**图浏览**页（`?view=graph`，2026-10-13 用户「执行」）—— 补上原面板 `View 3D Graph` 那个位置。
 *
 * ## 它是什么 / 不是什么（这条必须写在最前面，否则又会变成"看着像 3D、其实什么都没有" ✗）
 *
 * **是**：用 dsh 侧**已经有的**数据把图"看"起来 —— 类型分布（按占比画条 ✓）、入度/出度最高的节点、
 * 按**节点类型**筛选、点一个节点**就地**看它的出入依赖（`dependenciesOf` ✓）与"在编辑器打开"（`/api/open` ✓）。
 * **不是**：3D、力导向布局、交互式拖拽 —— 页面是服务端渲染 + 内联 CSS，**不引任何前端库** ✓
 * （与整页的既有口径一致：不假装有交互 ✗）。
 *
 * ## 为什么值这一页
 * 原面板那个按钮的**用途**是"这仓库该从哪读" ⇒ 真正有用的是**结构事实**（谁最被依赖、有哪些类型、
 * 依赖长什么样），而不是那朵花 ✓。全部用现成 helper 算，不新增引擎 ✓（`summarizeGraph` / `topNodes` /
 * `dependenciesOf` / `searchNodes` ✓）。
 */
function renderGraphView({ overview, graph, loadError, loadMs, loadBytes, cached, label, nodeId, deps, query, results, toolsRegistered, parser, index }) {
	const back = `${ROUTE_PREFIX}/?refresh=1`;
	if (!graph) {
		// 空态也要**说清是哪一种空**（没图 / 加载失败 / 没配 workspaceRoot —— 三者下一步完全不同 ✓）
		const why = loadError ?? overview.error ?? (overview.missing ? `还没有图谱：${overview.missing}` : (overview.workspaceRoot ? '全量图没加载起来' : '未配置 workspaceRoot'));
		return renderShell({
			kind: 'codebase', title: 'Codebase Memory', subtitle: '只读 · 图浏览',
			headerHtml: '<div class="kb-view"><div class="kb-header"><span class="kb-title"><span>🕸</span><span>图浏览</span></span><span class="kb-spacer"></span></div><div class="kb-panel"><div class="kb-panel-content">',
			bodyHtml: `<div data-graph-view="1" data-graph-available="no" data-vssaros-page="codebase" data-vssaros-codebase-tools="${escapeHtml(toolsRegistered)}"></div>
				<p class="dsh-empty">看不了图：${escapeHtml(String(why))}</p>
				${cbmSection({ id: 'details', icon: '🌐', title: 'Graph Details', badge: '不可用', open: true, bodyHtml: `${cbmKv('Storage', `<code>${escapeHtml(String(overview.dir ?? ''))}</code>`)}<div class="cbm-btn-group">${cbmBtn('← 回总览', { href: back })}</div>` })}</div></div></div>`,
			extraCss: PAGE_CSS, script: `${CODEBASE_SCRIPT}${DETAIL_ACTIONS_SCRIPT}`,
		});
	}
	const summary = summarizeGraph(graph);
	const total = Math.max(1, summary.nodes);
	const inTop = topNodes(graph, { by: 'inDegree', label, limit: 15 });
	const outTop = topNodes(graph, { by: 'outDegree', label, limit: 15 });
	const listOf = (nodes, empty) => (nodes.length ? `<ul>${nodes.map(nodeRow).join('')}</ul>` : `<p class="dsh-empty">${escapeHtml(empty)}</p>`);
	// 类型筛选筹码：全部 + 每个节点类型（带计数 ✓；选中项高亮 ✓）
	const chips = chipRow([
		{ label: `全部 ${summary.nodes}`, href: `${ROUTE_PREFIX}/?view=graph`, active: !label },
		...summary.labels.slice(0, 10).map(entry => ({
			label: `${escapeHtml(String(entry.name))} ${entry.count}`,
			href: `${ROUTE_PREFIX}/?view=graph&label=${encodeURIComponent(String(entry.name))}`,
			active: String(entry.name) === label,
		})),
	]);
	// 节点下钻：本地图里点一个节点 ⇒ 就地把它的出入依赖摊开（`dependenciesOf` ✓）
	const depsHtml = deps
		? `<p class="dsh-diag">${deps.error
			? escapeHtml(deps.error)
			: `${deps.targets.length} 个节点：用出 ${deps.usesTotal} 条 / 被用 ${deps.usedByTotal} 条${deps.dangling ? `（${deps.dangling} 条边指向图外节点）` : ''}`}</p>
${deps.error ? '' : `<h3>它用了什么 <small>${deps.uses.length}/${deps.usesTotal}</small></h3><ul>${deps.uses.map(entry => `<li><small>${escapeHtml(entry.type)}</small> <code>${escapeHtml(entry.name)}</code> <small>${escapeHtml(shortFile(entry.filePath))}</small></li>`).join('') || '<li class="dsh-empty">没有出边</li>'}</ul>
<h3>谁用了它 <small>${deps.usedBy.length}/${deps.usedByTotal}</small></h3><ul>${deps.usedBy.map(entry => `<li><small>${escapeHtml(entry.type)}</small> <code>${escapeHtml(entry.name)}</code> <small>${escapeHtml(shortFile(entry.filePath))}</small></li>`).join('') || '<li class="dsh-empty">没有入边</li>'}</ul>`}`
		: '';
	const resultsHtml = results
		? (results.length ? `<ul>${results.map(nodeRow).join('')}</ul>` : `<p class="dsh-empty">没有命中（query=${escapeHtml(query ?? '')}）。</p>`)
		: '';
	return renderShell({
		kind: 'codebase', title: 'Codebase Memory', subtitle: '只读 · 图浏览',
		headerHtml: `<div class="kb-view">
<div class="kb-header">
	<span class="kb-title"><span>🕸</span><span>图浏览（只读）</span></span>
	<span class="kb-spacer"></span>
	<span class="cbm-pill">${summary.nodes} Nodes</span>
</div>
<div class="kb-panel">
	<div class="kb-panel-bar"><span class="kb-panel-bar-label">Codebase Memory</span><span class="kb-spacer"></span><span class="kb-stat-hero-label">${label ? `筛选：${escapeHtml(label)}` : '全部节点类型'}</span></div>
	<div class="kb-panel-content">`,
		bodyHtml: `<div data-graph-view="1" data-graph-available="yes" data-vssaros-page="codebase" data-vssaros-codebase-nodes="${manifestNodesOf(summary)}" data-vssaros-codebase-edges="${summary.edges}" data-vssaros-codebase-project="${escapeHtml(String(overview.manifest?.project ?? ''))}" data-vssaros-codebase-root="${escapeHtml(String(overview.workspaceRoot ?? ''))}" data-vssaros-codebase-deep="loaded" data-vssaros-codebase-ms="${loadMs ?? ''}" data-vssaros-codebase-bytes="${loadBytes ?? ''}" data-vssaros-codebase-tools="${escapeHtml(toolsRegistered)}" data-vssaros-codebase-label="${escapeHtml(label ?? '')}"></div>
${cbmSection({ id: 'view-summary', icon: '📊', title: '分布（结构事实）', badge: `${summary.nodes} 节点 / ${summary.edges} 边`, open: true, bodyHtml: `${cbmKv('节点类型', `${summary.labels.length} 类`)}${cbmKv('边类型', `${summary.edgeTypes.length} 类`)}${cbmKv('文件', String(summary.files ?? '?'))}${cbmKv('社区', String(summary.communities ?? 0))}${cbmKv('加载', `${loadBytes !== undefined ? bytesOf(loadBytes) : '?'} / ${loadMs ?? '?'}ms${cached ? ' · 缓存命中' : ''}`)}
	<h3>节点类型分布</h3>${barsHtml(summary.labels)}
	<h3>边类型分布</h3>${barsHtml(summary.edgeTypes)}` })}
${cbmSection({ id: 'view-filter', icon: '🎛️', title: '按节点类型筛选', badge: label ? escapeHtml(label) : '全部', bodyHtml: `${chips}<p class="cbm-note">筛选只影响下面两张表（都在**已加载的全量图**里算 ✓，不再读盘 ✓）。</p>` })}
${cbmSection({ id: 'view-hot', icon: '🔥', title: '入度最高（谁被依赖最多）', badge: `${inTop.length} 条`, 	open: true, bodyHtml: listOf(inTop, '没有入度节点') + '<p class="cbm-note">点一行 ⇒ 在编辑器里打开它所在的文件与行（走 <code>/api/open</code> ✓）。想把它的出入依赖摊开：用 <code>?view=graph&amp;node=&lt;id&gt;</code>（行上的 <code>data-node-id</code> 就是那个 id ✓）。</p>' })}
${cbmSection({ id: 'view-out', icon: '🌱', title: '出度最高（谁依赖别人最多）', bodyHtml: listOf(outTop, '没有出度节点') })}
${depsHtml ? cbmSection({ id: 'view-node', icon: '🧭', title: `节点 #${nodeId} 的依赖`, badge: '下钻', open: true, bodyHtml: depsHtml }) : ''}
${resultsHtml ? cbmSection({ id: 'view-search', icon: '🔍', title: `检索：${query ?? ''}`, badge: `${results.length} 条`, open: true, bodyHtml: resultsHtml }) : ''}
${cbmSection({ id: 'view-note', icon: '⚠️', title: '这一页**不是**什么', badge: '诚实边界', bodyHtml: `<p class="cbm-note">原面板的「View 3D Graph」是**三维**渲染 + 力导向布局 ⇒ dsh 侧**没有对应物** ✗。这里给的是同一份数据的**结构事实**：类型分布、入度/出度排行、按类型筛选、节点出入依赖 ✓ —— 全部用现成 helper 算（<code>summarizeGraph</code> / <code>topNodes</code> / <code>dependenciesOf</code> ✓），**不引前端库、没有 3D、不能拖拽** ✗。要看源码就点节点行里的「在编辑器打开」（走 <code>/api/open</code> ✓）。</p>` })}
<div class="cbm-btn-group">${cbmBtn('← 回总览', { href: back })}${cbmBtn('🔄 重新加载全量图', { href: `${ROUTE_PREFIX}/?view=graph&refresh=1` })}</div></div>
</div>
</div>`,
		extraCss: PAGE_CSS, script: `${CODEBASE_SCRIPT}${DETAIL_ACTIONS_SCRIPT}`,
	});
}

/** summary.nodes 走字符串（`data-*` 属性）—— 与总览页的同一份口径 ✓。 */
function manifestNodesOf(summary) {
	return String(summary?.nodes ?? '');
}

/**
 * 「📂 Open Directory」等界面动作的脚本（原面板这些按钮都点了有用 ✓，dsh 侧只有两条能真做：
 * **整页刷新**与 **在系统里定位目录**（页面桥 `reveal` ✓，主进程有实现、路径不存在会弹通知 ✓）。
 * 桥不在就**说清**，不假装成功 ✗（与 `pageClient.js` 里工作台动作同一口径 ✓）。
 */
const DETAIL_ACTIONS_SCRIPT = `(function(){
function status(text){var el=document.querySelector('[data-kb-action-status]');if(el){el.textContent=text;}}
document.addEventListener('click',function(ev){
	var btn=ev.target&&ev.target.closest?ev.target.closest('[data-kb-reveal]'):null;
	if(!btn){return;}
	ev.preventDefault();
	var path=btn.getAttribute('data-kb-reveal')||'';
	var bridge=window.vssarosDsh;
	if(bridge&&typeof bridge.reveal==='function'){try{bridge.reveal(path);status('已请求定位：'+path);return;}catch(e){}}
	status('这个 IDE 版本不支持从页面定位目录：'+path);
});
})();`;


/**
 * 统计区（hero 体积 + 计数格子 + meta + 状态行）—— **完整版与侧栏版共用同一份** ✓。
 *
 * 为什么抽出来：同一份数字在两个版本里各写一遍 ⇒ 迟早漂移（"侧栏说 19 万节点、完整页说 17 万"这种 ✗✗）。
 * 口径与真源一致：hero 放**体积**、格子放**计数**、meta 放**时间/项目** ✓（见 PAGE_CSS 的说明）。
 */
function graphStatsHtml(overview, index) {
	const manifest = overview.manifest;
	const graphBytes = overview.files?.[GRAPH_FILE]?.bytes;
	const cells = [
		statCellHtml('节点', manifest?.nodeCount),
		statCellHtml('关系边', manifest?.edgeCount),
	].join('');
	// 状态行：与原 Pane 的「已就绪 / 正在索引…」同义 —— 这里能观察到的"忙"是**别人正持锁**或**watcher 有待处理变更** ✓
	const busy = index?.lock?.held === true || index?.watch?.pendingSince !== undefined;
	const statusLine = `<div class="kb-code-status${busy ? ' busy' : ''}">${
		busy
			? `正在索引…${index?.lock?.holder?.token ? `（${escapeHtml(String(index.lock.holder.token))}）` : ''}`
			: '已就绪（只读）'
	}</div>`;
	return `<div class="kb-stats">
	<div class="kb-stat-hero"><span class="kb-stat-hero-num">${bytesOf(graphBytes)}</span><span class="kb-stat-hero-label">图谱体积</span></div>
	<div class="kb-stat-grid">${cells}</div>
	<div class="kb-stat-meta">项目 <b>${escapeHtml(String(manifest?.project ?? '未知'))}</b> · 保存于 ${escapeHtml(isoOf(manifest?.savedAt))}</div>
	${statusLine}
</div>`;
}

/**
 * 「在编辑区打开完整版」的点击行为（**页面自己开不了编辑器** ⇒ 请宿主代劳 ✓）。
 *
 * 与 `vssaros-dashboard/lib/sideview.js` 的 `open-full` **逐条同款**（同一套桥、同一套退化）：
 * ① 有桥 ⇒ `openModulePage(location.pathname)`，宿主按模块页表**白名单**核对（`/x/codebase/` 在表里 ✓）；
 * ② 有桥但命令抛错 ⇒ 退化成整页跳转（`location.href = pathname`，真能用的退化 ✓）；
 * ③ 完全没桥（纯浏览器打开这页）⇒ 新标签页打开完整版 ✓。
 *
 * ⚠ 传 `location.pathname`（**不含查询串**）：带不带 `surface=sideview` 是宿主的自由，页面不该把自己钉在某个表面参数上 ✓。
 * ⚠ 点下去**先给反馈**（按钮置忙 + 文案改口）—— 原生宿主打开编辑器有一拍延迟，不给反馈就还是"点了没反应" ✗。
 */
const SIDEVIEW_SCRIPT = `(function(){
var btn=document.querySelector('[data-kb-action="open-full"]');
if(!btn){return;}
btn.addEventListener('click',function(){
	var text=btn.querySelector('[data-kb-action-label]');
	if(text){text.textContent='正在编辑区打开…';}
	btn.classList.add('busy');
	var bridge=window.vssarosDsh;
	if(bridge&&typeof bridge.openModulePage==='function'){
		try{bridge.openModulePage(location.pathname);return;}catch(e){/* 命令抛错 ⇒ 退化成整页跳转 ✓（与 dashboard 同款） */}
	}
	if(bridge){location.href=location.pathname;return;}
	window.open(location.pathname,'_blank','noopener');
});
})();`;

/**
 * 侧栏版（`?surface=sideview`，宿主在侧栏承载时注入）—— **摘要 + 入口**，
 * 与「主页」的侧栏版同一套口径（2026-10-13 用户 D1=A：侧栏承载摘要，**完整版由编辑区承载**；
 * 见 `common/dshPageBridgeProtocol.ts` 的 `openModulePage` 与 `vssaros-dashboard/lib/sideview.js`）。
 *
 * ## 为什么必须有这一版（用户 2026-10-13 报障的两件事都在这里）
 *
 * ① **「缺少打开代码图谱的按钮」**：完整版一直在编辑区，而侧栏这版此前**就是完整版本身**、
 *    却**没有任何"去编辑区"的入口** ⇒ 用户进不去 ✗。⇒ 这里给一个主按钮（走页面桥 ✓）。
 * ② **「点击无反应」**：完整版那两条入口是 **SSR 链接** —— 前者（深度视图）要现场解压 129MB
 *    （几十秒里页面一动不动，看起来就是死了 ✗），后者（刷新）跳到**同一个 URL**（内容逐字相同 ✗✗）。
 *    ⇒ 侧栏版**不再自己扛重活**：重活全在编辑区那版，这里只有一个入口 + 点下去立刻有反馈 ✓。
 *
 * ⚠ 侧栏版**坚持轻路径**：即使 URL 带了 `?deep=1` 也不解析（它存在的意义就是"侧栏不付 129MB"✓）。
 * ⚠ 数字与锚点**与完整版同一份来源**（`graphStatsHtml` ✓），并且探针会**逐值对账两版**（防漂移 ✓）。
 */
function renderSideview({ overview, parser, index, toolsRegistered }) {
	const manifest = overview.manifest;
	const cards = graphStatsHtml(overview, index);
	// 诊断：侧栏只放"一眼要看出"的几条（工作区 / 读图走哪一份 / 索引 / 解析器）——**不**重贴完整版那一大段 ✓
	const indexLine = index && index.ok
		? `读图走 <strong>${escapeHtml(String(index.effectiveSource ?? '?'))}</strong>${index.effectiveAgeMs !== undefined ? `（这份图 ${ageOf(index.effectiveAgeMs)}前）` : ''}`
			+ `${index.staleShadow ? ` · ⚠ 影子比 IDE 的图旧 ${ageOf(index.staleShadow.ageMs)}（已让位给 IDE）` : ''}`
			+ `${index.lock?.held ? ' · 正在索引' : ''}`
		: `索引不可用（${escapeHtml(String(index?.why ?? '未探测'))}）`;
	const parserLine = parser?.available
		? `解析器 ${parser.languages.length} 语言（来自 ${escapeHtml(parser.source)}）`
		: '解析器不可用';
	// ★ 2026-10-14（P12）：侧栏也要能答"**这份图是哪一档建的、上次建了多久**" ✓ —— 两个数都来自
	//   `index-meta.json` ✓（`shadowStatus` 已读出来 ✓）⇒ **不用加载图谱** ⇒ 侧栏的轻路径不被破坏 ✓✓
	//   （侧栏存在的意义就是"不付全量图的代价" ✓，所以这里**只读元数据** ✗ 不碰图 ✓）。
	//   ⚠ 取不到就**说未知** ✗：图来自 IDE（或旧一代索引器）时本来就没有这两个数 ✓ —— 猜一个出来最坏 ✓。
	const tierLine = index?.graphParser
		? `产图档位 <strong>${escapeHtml(String(index.graphParser))}</strong>${typeof index.graphMetaMs === 'number' ? ` · 上次实测 ${Math.round(index.graphMetaMs / 1000)}s${index.graphMetaIncremental === false ? '（全量）' : index.graphMetaIncremental === true ? '（增量）' : ''}` : ' · 无耗时记录'}`
		: '产图档位未知（这份图不是这一代 dsh 索引器产的 ⇒ 说不准 ✗）';
	const summary = `<p class="dsh-diag kb-log" data-vssaros-page="codebase" data-vssaros-codebase-nodes="${manifest?.nodeCount ?? ''}" data-vssaros-codebase-edges="${manifest?.edgeCount ?? ''}" data-vssaros-codebase-project="${escapeHtml(manifest?.project ?? '')}" data-vssaros-codebase-root="${escapeHtml(overview.workspaceRoot ?? '')}" data-vssaros-codebase-graph-source="${escapeHtml(overview.graphSource ?? '')}" data-vssaros-codebase-graph-parser="${escapeHtml(index?.graphParser ?? '')}" data-vssaros-codebase-graph-parser-why="${escapeHtml(index?.graphParserWhy ?? '')}" data-vssaros-codebase-graph-ms="${index?.graphMetaMs ?? ''}" data-vssaros-codebase-graph-incremental="${index?.graphMetaIncremental === undefined ? '' : (index.graphMetaIncremental ? 'yes' : 'no')}" data-vssaros-codebase-tools="${escapeHtml(toolsRegistered)}">工作区 <code>${escapeHtml(overview.workspaceRoot ?? '(未配置)')}</code> · 图谱目录 <code>${escapeHtml(overview.dir ?? '')}</code><br>${indexLine}<br>${parserLine}<br>${tierLine}</p>`;
	const openEntry = `<button type="button" class="kb-entry kb-entry-primary" data-kb-action="open-full">
	<span class="kb-entry-icon">🧭</span>
	<span class="kb-entry-text"><span class="kb-entry-title" data-kb-action-label>打开代码图谱</span>
	<span class="kb-entry-meta">在编辑区打开完整版：深度视图 · 检索 · 依赖分析</span></span>
	<span class="kb-entry-arrow">›</span></button>`;
	const notices = `${overview.error ? `<p class="dsh-empty">${escapeHtml(overview.error)}</p>` : ''}`
		+ `${overview.missing ? `<p class="dsh-empty">还没有图谱：<code>${escapeHtml(overview.missing)}</code>（在 VsSaros 里建过代码图谱后这里会出现）。</p>` : ''}`;
	return renderShell({
		kind: 'codebase',
		title: '代码图谱',
		subtitle: '只读 · 在 Host 进程内查询',
		headerHtml: `<div class="kb-view">
<div class="kb-header">
	<span class="kb-title"><span>🕸</span><span>代码图谱</span></span>
	<span class="kb-spacer"></span>
	<span class="kb-stat-hero-label">侧栏摘要</span>
</div>
<div class="kb-panel">
	<div class="kb-panel-bar"><span class="kb-panel-bar-label">代码图谱</span><span class="kb-spacer"></span><span class="kb-stat-hero-label">只读 · 在 Host 进程内查询</span></div>
	<div class="kb-panel-content">`,
		// ★ 2026-10-15（用户拍板：方案"仪表盘卡" + **按钮置顶** ✓）：主入口挪到**最上** ✓ —
		//   用户报障"缺少打开代码图谱的按钮"的根因就是入口不显眼 ✗ ⇒ 侧栏的第一眼就是它 ✓。
		//   ⚠ 卡片仍是 `graphStatsHtml`（与完整版同一份来源 ✓，探针逐值对账 ⇒ 不许动它结构 ✗）—— 只调**顺序** ✓。
		bodyHtml: `${openEntry}${cards}${notices}${summary}</div>
</div>
</div>`,
		extraCss: PAGE_CSS,
		script: SIDEVIEW_SCRIPT,
	});
}

function toolDefinitions(ctx, state, config) {
	const clamp = (value, fallback, max) => Math.min(max, Math.max(1, Number.isFinite(value) ? Math.floor(value) : fallback));
	return [{
		name: 'codebase_overview',
		description: '代码图谱总览：节点/边计数、project、保存时间、图谱文件大小（走轻路径 artifact.json，不解压全量图）。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: {
					workspaceRoot: { type: 'string' }, nodeCount: { type: 'integer' }, edgeCount: { type: 'integer' },
					project: { type: 'string' }, savedAt: { type: 'integer' }, graphBytes: { type: 'integer' },
					graphSource: { type: 'string' }, graphAgeMs: { type: 'integer' }, staleShadowAgeMs: { type: 'integer' },
				},
				required: [],
			},
			// ★ `presentationMeta`（报告 §5-11 / README 5.98 同款）：结构化元数据**随会话日志持久化**、
			// 卡片直接读 ✓ —— 此前结构化数据只以**文本行**出结果 ✓，卡片必须去解析那一行 ✗。
			// ⚠ 两条约束（官方 `dsh-tool-fs-search/lib/types/presentation.d.ts` 的做法）：
			//   ① `meta` 会被持久化并**每次请求重发** ⇒ 必须**限长** ✓（只放计数与短串 ✓，节点/边明细绝不入内 ✗）；
			//   ② 官方只为**顶层调用**算 meta ✓ ⇒ 卡片必须保留文本回落 ✗（旧日志 + 嵌套调用 ✓）。
			presentationMeta: (_args, value) => value.nodeCount === undefined
				? { shape: 'codebase-overview', ok: false, error: typeof value.error === 'string' ? value.error.slice(0, 200) : null }
				: {
					shape: 'codebase-overview',
					ok: true,
					workspaceRoot: value.workspaceRoot ?? null,
					project: value.project ?? null,
					nodeCount: value.nodeCount,
					edgeCount: value.edgeCount ?? null,
					graphBytes: value.graphBytes ?? null,
					savedAt: value.savedAt ?? null,
				},
			render: (_args, value) => {
				if (value.nodeCount === undefined) {
					return [{ type: 'text', text: `代码图谱不可用：${value.error ?? '没有 artifact.json'}` }];
				}
				return [
					// 人读那一行保持原样 ✓（已有探针与页面按它写文案 ✓）
					{
						type: 'text',
						text: `${value.project ?? '(未知 project)'}：${value.nodeCount} 节点 / ${value.edgeCount} 边 · 保存于 ${isoOf(value.savedAt)} · 图谱文件 ${bytesOf(value.graphBytes)}`
							// ★ P3-b：**图从哪来 + 多新**必须出现在人读那一行上 ✓（模型据此判断要不要重跑索引 ✓）
							+ `${value.graphSource ? ` · 来自 ${value.graphSource}` : ''}${value.graphAgeMs !== undefined ? `（${ageOf(value.graphAgeMs)}前）` : ''}`
							+ `${value.staleShadowAgeMs !== undefined ? ` · ⚠ 影子比 IDE 的图旧 ${ageOf(value.staleShadowAgeMs)}（已让位给 IDE）` : ''}`,
					},
					// ★ 机器可读那一行（README 5.09 的官方做法）：结构化数据以 `*_json:` 文本行出结果 ✓，
					// 卡片/探针据此取值，而不是去解析人读文案 ✗。键序**固定**（便于探针逐字钉住 ✓）。
					{
						type: 'text',
						text: `codebase_overview_json: ${JSON.stringify({
							workspaceRoot: value.workspaceRoot ?? null,
							project: value.project ?? null,
							nodeCount: value.nodeCount,
							edgeCount: value.edgeCount ?? null,
							savedAt: value.savedAt ?? null,
							graphBytes: value.graphBytes ?? null,
							graphSource: value.graphSource ?? null,
							graphAgeMs: value.graphAgeMs ?? null,
							staleShadowAgeMs: value.staleShadowAgeMs ?? null,
						})}`,
					},
				];
			},
		},
		isConcurrencySafe: () => true,
		execute: async () => {
			const overview = await readOverview(config);
			if (overview.error) {
				return { error: overview.error };
			}
			return Object.fromEntries(Object.entries({
				workspaceRoot: overview.workspaceRoot,
				nodeCount: overview.manifest?.nodeCount,
				edgeCount: overview.manifest?.edgeCount,
				project: overview.manifest?.project,
				savedAt: overview.manifest?.savedAt,
				graphBytes: overview.files[GRAPH_FILE]?.bytes,
				// ★ P3-b：**这张图从哪来、多新** —— 总览不给这两条，调用方就没法判断"看到的是不是当前代码" ✗
				graphSource: overview.graphSource,
				graphAgeMs: overview.ageMs,
				ideSavedAt: overview.ideSavedAt,
				staleShadowAgeMs: overview.staleShadow?.ageMs,
			}).filter(([, value]) => value !== undefined));
		},
	}, {
		name: 'codebase_search',
		description: '在代码图谱里按名字检索符号（函数/类/接口/变量/文件），返回命中节点的类型、文件、行号与入/出度（会加载全量图，首次较慢）。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '名字片段（大小写不敏感）' },
				label: { type: 'string', description: '限定节点类型：function / class / interface / variable / file / enum（留空不限）' },
				file: { type: 'string', description: '限定文件路径片段（留空不限）' },
				limit: { type: 'integer', description: '返回条数上限，1–100（默认 20；超出会被夹到边界）' },
			},
			required: ['query'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'integer' }, loadMs: { type: 'integer' },
					items: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'integer' }, name: { type: 'string' }, label: { type: 'string' },
								filePath: { type: 'string' }, startLine: { type: 'integer' },
								inDegree: { type: 'integer' }, outDegree: { type: 'integer' },
							},
							required: ['id', 'name'],
						},
					},
				},
				required: ['count', 'items'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.count
					? `${value.count} 个命中（图加载 ${value.loadMs}ms）：\n${value.items.map(item => `- ${item.name} [${item.label ?? '?'}] ${item.filePath ?? ''}${item.startLine ? `:${item.startLine}` : ''}（入度 ${item.inDegree ?? '?'}）`).join('\n')}`
					: '没有命中。',
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const loaded = await loadGraph(config);
			if (loaded.error) {
				throw new Error(loaded.error);
			}
			const items = searchNodes(loaded.graph, {
				query: typeof params?.query === 'string' ? params.query : '',
				label: typeof params?.label === 'string' ? params.label : '',
				filePath: typeof params?.file === 'string' ? params.file : '',
				limit: clamp(params?.limit, 20, 100),
			}).map(node => Object.fromEntries(Object.entries({
				id: node.id, name: node.name, label: node.label, filePath: node.filePath,
				startLine: node.startLine, inDegree: node.inDegree, outDegree: node.outDegree,
			}).filter(([, value]) => value !== undefined)));
			return { count: items.length, loadMs: loaded.ms, items };
		},
	}, {
		name: 'codebase_deps',
		description: '查一个符号（或一个文件里的全部符号）的依赖：它用了什么（出边）与谁用了它（入边），按 CALLS/USAGE/CONTAINS 标注（会加载全量图）。',
		parameters: {
			type: 'object',
			properties: {
				nodeId: { type: 'integer', description: '节点 id（codebase_search 返回的 id）' },
				filePath: { type: 'string', description: '或给出文件路径（图谱里的 filePath 形式，通常相对工作区根）' },
				limit: { type: 'integer', description: '每侧返回条数上限，1–200（默认 50）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					usesTotal: { type: 'integer' }, usedByTotal: { type: 'integer' }, dangling: { type: 'integer' },
					uses: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, name: { type: 'string' }, filePath: { type: 'string' } }, required: ['name'] } },
					usedBy: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, name: { type: 'string' }, filePath: { type: 'string' } }, required: ['name'] } },
				},
				required: ['usesTotal', 'usedByTotal'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `出边 ${value.usesTotal} 条 / 入边 ${value.usedByTotal} 条${value.dangling ? `（${value.dangling} 条指向图外节点）` : ''}\n`
					+ `它用了：${value.uses.slice(0, 12).map(entry => `${entry.name}(${entry.type})`).join(', ') || '—'}\n`
					+ `谁用了它：${value.usedBy.slice(0, 12).map(entry => `${entry.name}(${entry.type})`).join(', ') || '—'}`,
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const nodeId = Number.isFinite(params?.nodeId) ? Math.floor(params.nodeId) : undefined;
			const filePath = typeof params?.filePath === 'string' && params.filePath.trim() ? params.filePath.trim() : undefined;
			if (nodeId === undefined && !filePath) {
				throw new Error('需要 nodeId 或 filePath');
			}
			const loaded = await loadGraph(config);
			if (loaded.error) {
				throw new Error(loaded.error);
			}
			const result = dependenciesOf(loaded.graph, { nodeId, filePath, limit: clamp(params?.limit, 50, 200) });
			if (result.error) {
				throw new Error(result.error);
			}
			return {
				usesTotal: result.usesTotal,
				usedByTotal: result.usedByTotal,
				dangling: result.dangling,
				uses: result.uses,
				usedBy: result.usedBy,
			};
		},
	}, {
		name: 'codebase_hotspots',
		description: '代码图谱里入度（被引用最多）或出度最高的节点——"这个仓库该从哪开始读"的入口（会加载全量图）。',
		parameters: {
			type: 'object',
			properties: {
				by: { type: 'string', description: 'inDegree（默认）/ outDegree' },
				label: { type: 'string', description: '限定节点类型（留空不限）' },
				limit: { type: 'integer', description: '返回条数上限，1–100（默认 20）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					by: { type: 'string' }, count: { type: 'integer' }, loadMs: { type: 'integer' },
					items: {
						type: 'array',
						items: {
							type: 'object',
							properties: { id: { type: 'integer' }, name: { type: 'string' }, label: { type: 'string' }, degree: { type: 'integer' }, filePath: { type: 'string' } },
							required: ['id', 'name', 'degree'],
						},
					},
				},
				required: ['by', 'count', 'items'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `${value.by} 最高的 ${value.count} 个节点（图加载 ${value.loadMs}ms）：\n`
					+ value.items.map(item => `- ${item.name} [${item.label ?? '?'}] ${item.degree} · ${item.filePath ?? ''}`).join('\n'),
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const loaded = await loadGraph(config);
			if (loaded.error) {
				throw new Error(loaded.error);
			}
			const by = params?.by === 'outDegree' ? 'outDegree' : 'inDegree';
			const items = topNodes(loaded.graph, {
				by,
				label: typeof params?.label === 'string' ? params.label : '',
				limit: clamp(params?.limit, 20, 100),
			}).map(node => Object.fromEntries(Object.entries({
				id: node.id, name: node.name, label: node.label, degree: node.degree, filePath: node.filePath,
			}).filter(([, value]) => value !== undefined)));
			return { by, count: items.length, loadMs: loaded.ms, items };
		},
	}, {
		// ── codebase_architecture（§R.7 第 ② 项**最后一项**；≈ 真源 `get_architecture` ✓）──────────
		// ⚠ 真源有十几个 aspect（`packages` / `layers` / `services` / `routes` / `crossBoundaries` /
		//   `dependencies` / `deadCode` / 重算 communities … ✓）—— **大半要索引器的进阶分析** ✗，我们没有 ✓
		//   ⇒ 本工具**只做图里真有的事实** ✓：
		//     · `languages` 图里**没有** language 字段 ⇒ **按扩展名统计** ✓（并把这段方法写进输出 ✓）；
		//     · `entryPoints` **纯启发式**（文件名 ✓）⇒ 输出里 `entryPointsHeuristic: true` ✓；
		//     · `hotspots` / `communities` **真事实** ✓（度数已算好 ✓ / 直接用索引器写的 `community` 字段 ✓，
		//       **不重算**社区 —— 重算就是换一套结论 ✗）；
		//     · `tree` **按路径分组** ✓（不是包分析 ✗）；
		//     · 没移植的那些用 `notPorted` **列出来并指路** ✓（不假装 ✗）。
		name: 'codebase_architecture',
		description: '架构速览（**只给图里能算出来的事实** ✓）：语言分布（按扩展名 ✓）、入口点候选（**启发式** ✗ 已标注 ✓）、'
			+ '热点符号 ✓、社区（索引器写入的 `community` 字段 ✓）、按路径的顶层分组 ✓，以及 **packages / layers / services / routes / crossBoundaries / dependencies / deadCode**（2026-10-13 起 ✓）；可用 `path` 收敛到某个目录 ✓。'
			+ ' ⚠ 后 7 项是**按图近似**（路径 / 命名 / 度数层面 ✓）—— 每条都带一个 `*Method` 字段写明口径与近似程度 ✓，'
			+ '**不等价**于真源那套索引器分析 ✗（`notPortedHint` 里写明仍没建模的东西：LSP 推断 / 语义相似 / trace 摄入 / 3D 布局 ✓）。'
			+ ' ⚠ 想只看热点用 codebase_hotspots ✓、只看"有没有图/多大"用 codebase_overview ✓（轻路径 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '可选：只看这个目录前缀（**相对**路径 ✓；绝对路径 / 「..」会被拒 ✓）' },
				aspects: {
					type: 'array',
					items: { type: 'string' },
					description: `要哪些方面（缺省全给 ✓）：${ARCHITECTURE_ASPECTS.join(' / ')}`,
				},
				topLimit: { type: 'integer', description: '每个列表最多几条（缺省 12，1–50 ✓）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					nodes: { type: 'integer' }, edges: { type: 'integer' },
					scopePath: { type: 'string' }, scoped: { type: 'boolean' },
					notPorted: { type: 'array', items: { type: 'string' } },
					notPortedHint: { type: 'string' },
					languages: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } }, required: ['name', 'count'] } },
					languageCount: { type: 'integer' }, languagesMethod: { type: 'string' },
					entryPoints: { type: 'array', items: { type: 'string' } },
					entryPointsHeuristic: { type: 'boolean' }, entryPointsMethod: { type: 'string' },
					hotspots: {
						type: 'array',
						items: {
							type: 'object',
							properties: { qualifiedName: { type: 'string' }, label: { type: 'string' }, inDegree: { type: 'integer' }, filePath: { type: 'string' } },
							required: ['qualifiedName'],
						},
					},
					communities: {
						type: 'array',
						items: {
							type: 'object',
							properties: { id: { type: 'string' }, size: { type: 'integer' }, sample: { type: 'string' } },
							required: ['id', 'size'],
						},
					},
					communityCount: { type: 'integer' }, communitiesMethod: { type: 'string' },
					tree: {
						type: 'array',
						items: {
							type: 'object',
							properties: { dir: { type: 'string' }, files: { type: 'integer' }, nodes: { type: 'integer' } },
							required: ['dir', 'nodes'],
						},
					},
					treeMethod: { type: 'string' },
					loadMs: { type: 'integer' },
				},
				required: ['nodes', 'edges'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: [
					`图谱${value.scoped ? `（scope=${value.scopePath} ✓）` : ''}：${value.nodes} 节点 / ${value.edges} 边`,
					value.languages ? `语言（${value.languageCount} 种；按扩展名 ✓）：${value.languages.map(l => `${l.name}×${l.count}`).join(', ')}` : '',
					value.entryPoints ? `入口候选（**启发式** ✗）：${value.entryPoints.join(', ') || '(没匹配到)'}` : '',
					value.hotspots ? `热点（入度最高 ✓）：${value.hotspots.slice(0, 6).map(h => `${h.qualifiedName}(入度 ${h.inDegree})`).join(', ')}` : '',
					value.communities ? `社区（索引器字段 ✓，共 ${value.communityCount} 个）：${value.communities.slice(0, 5).map(c => `#${c.id}×${c.size}`).join(', ')}` : '',
					value.tree ? `顶层分组（按路径 ✓）：${value.tree.map(t => `${t.dir}(${t.files} 文件)`).join(', ')}` : '',
					`⚠ 未移植：${(value.notPorted ?? []).join(' / ')} —— ${value.notPortedHint ?? ''}`,
				].filter(Boolean).join('\n'),
			}],
		},
		execute: async params => {
			const scope = normalizeScope(params?.path);
			if (scope === undefined) {
				throw new Error(`path 必须是**工作区内的相对路径** ✗（收到 ${String(params?.path)}）—— 绝对路径 / 「..」会被拒 ✓`);
			}
			const loaded = await loadGraph(config);
			if (loaded.error) { throw new Error(`${loaded.error}（先确认这个工作区已建索引 ✓）`); }
			const wanted = Array.isArray(params?.aspects) && params.aspects.length
				? params.aspects.filter(aspect => ARCHITECTURE_ASPECTS.includes(aspect))
				: ARCHITECTURE_ASPECTS;
			const value = architectureOf(loaded.graph, { scopePath: scope, aspects: wanted, topLimit: params?.topLimit });
			const dropped = (Array.isArray(params?.aspects) ? params.aspects : []).filter(aspect => !ARCHITECTURE_ASPECTS.includes(aspect));
			return { ...value, loadMs: loaded.ms, ...(dropped.length ? { ignoredAspects: dropped } : {}) };
		},
	}, {
		// ── codebase_changes（§R.7 第 ② 项；≈ 真源 `detect_changes` ✓）────────────────────────────
		// 真源：`since` / `baseBranch` / `impactAnalysis` / `scope` / `depth`（BFS 影响传播 ✓）。我们有
		// `impactOf` 与 `mapFilesToNodes` 两块现成能力 ✓ ⇒ 拼起来就是它 ✓（`baseBranch` 未移植 ✗：它只是
		// "先算出分叉点再 diff" 的糖 ✓，用户给个 ref 就够 ✓）。
		// ⚠ 三条**诚实**设计：① 三类失败**分开报**（没 git / 不是仓库 / ref 不存在 ✓）；② **未跟踪的新文件**
		//   也算变更 ✓（否则"刚加的文件"永远不进影响面 ✗）；③ 图里**匹配不到**的变更文件**单独列** ✓
		//   （那说明图比工作区旧 ⇒ 绝不把它当成"没有影响" ✓）。
		name: 'codebase_changes',
		description: '看**自某个 git 引用以来改了哪些文件** ✓，并可选地算**影响面**：这些改动会波及哪些调用者 ✓。'
			+ ' `since` 缺省 `HEAD` = **未提交的改动** ✓（最常见的问题形态）；**未跟踪的新文件**也算 ✓（会分列出来 ✓）。'
			+ ' `impact: true` ⇒ 沿 `CALLS` **反向**走 `depth` 跳（缺省 5 ✓）—— 对"我改了它，谁会被波及"这个问题，'
			+ '**正确答案是往上找调用者** ✓（真源那句 "downstream impact" 读起来像往下走 ✗，我们按语义做 ✓）。'
			+ ' ⚠ 失败会**分型**报（没装 git / 不是仓库 / ref 不存在 ✓），不糊成一句"失败" ✗；'
			+ '⚠ 图谱里匹配不到的变更文件会**单独列出** ✓（图比工作区旧，或该文件没被索引 ⇒ 别当成"没有影响"✗）。',
		parameters: {
			type: 'object',
			properties: {
				since: { type: 'string', description: 'git 引用（commit / 分支 / tag ✓；缺省 HEAD = 未提交改动）' },
				scope: { type: 'string', description: '只看这个目录前缀下的变更（**相对**路径 ✓；绝对路径 / `..` 会被拒 ✓）' },
				impact: { type: 'boolean', description: '是否算影响面（沿 CALLS 反向找调用者 ✓；缺省 false ✓）' },
				depth: { type: 'integer', description: '影响面最多几跳（缺省 5，上限 20 ✓）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					since: { type: 'string' },
					scope: { type: 'string' },
					tracked: { type: 'array', items: { type: 'string' } },
					untracked: { type: 'array', items: { type: 'string' } },
					changed: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								filePath: { type: 'string' }, nodeCount: { type: 'integer' },
								symbols: { type: 'array', items: { type: 'string' } },
							},
							required: ['filePath', 'nodeCount'],
						},
					},
					notInGraph: { type: 'array', items: { type: 'string' } },
					impact: {
						type: 'object',
						properties: {
							used: { type: 'array', items: { type: 'string' } },
							total: { type: 'integer' },
							truncated: { type: 'boolean' },
							reached: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										depth: { type: 'integer' }, label: { type: 'string' }, name: { type: 'string' },
										qualifiedName: { type: 'string' }, filePath: { type: 'string' }, startLine: { type: 'integer' },
									},
									required: ['depth'],
								},
							},
						},
						required: ['total'],
					},
					loadMs: { type: 'integer' },
				},
				required: ['ok', 'since', 'changed'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: [
					`自 ${value.since} 起的变更（已跟踪 ${value.tracked.length} 个 / 未跟踪 ${value.untracked.length} 个${value.scope ? `；scope=${value.scope}` : ''}）`,
					...(value.changed ?? []).slice(0, 20).map(entry => `- ${entry.filePath}：${entry.nodeCount} 个节点（${entry.symbols.slice(0, 4).join(', ') || '无符号'}）`),
					(value.changed ?? []).length > 20 ? `（还有 ${value.changed.length - 20} 个文件未列 ✓）` : '',
					value.notInGraph?.length ? `⚠ 图谱里**没有**这些文件（图可能比工作区旧 ✓）：${value.notInGraph.slice(0, 8).join('、')}${value.notInGraph.length > 8 ? ' …' : ''}` : '',
					value.impact
						? `\n影响面（沿 ${(value.impact.used ?? []).join(', ')} **反向**；共 ${value.impact.total} 个${value.impact.truncated ? '，**已截断** ✓' : ''}）：\n`
							+ (value.impact.reached ?? []).slice(0, 20).map(hop => `  ${'  '.repeat(Math.min(hop.depth, 6))}${hop.depth}：${hop.qualifiedName ?? hop.name} @ ${hop.filePath}:${hop.startLine}`).join('\n')
						: '',
				].filter(Boolean).join('\n'),
			}],
		},
		execute: async params => {
			const since = typeof params?.since === 'string' && params.since.trim() ? params.since.trim() : 'HEAD';
			if (!isSafeGitRef(since)) {
				throw new Error(`since 形态不合法：${since} ✗（git 引用只允许字母/数字/._/-/~/^/@{}/+ ✓，且**不能以「-」开头** ✗ —— 那会被 git 当选项解析）`);
			}
			const scope = normalizeScope(params?.scope);
			if (scope === undefined) {
				throw new Error(`scope 必须是**工作区内的相对路径** ✗（收到 ${String(params?.scope)}）—— 绝对路径 / 「..」会被拒 ✓`);
			}
			const git = await runGitChanges(config, { since });
			if (!git.ok) { throw new Error(git.why); }
			const inScope = path => !scope || path === scope || path.startsWith(`${scope}/`);
			const tracked = git.tracked.filter(inScope);
			const untracked = git.untracked.filter(inScope);
			const loaded = await loadGraph(config);
			if (loaded.error) { throw new Error(`${loaded.error}（先确认这个工作区已建索引 ✓）`); }
			const { hit, missed } = mapFilesToNodes(loaded.graph, [...tracked, ...untracked]);
			const seedIds = hit.flatMap(entry => entry.nodeIds ?? []);
			const impact = params?.impact === true
				? impactOf(loaded.graph, seedIds, { depth: params?.depth })
				: undefined;
			return {
				ok: true, since, scope, tracked, untracked,
				changed: hit.map(entry => ({ filePath: entry.filePath, nodeCount: entry.nodeCount, symbols: entry.symbols })),
				notInGraph: missed,
				...(impact ? { impact: { used: impact.used, total: impact.total, truncated: impact.truncated, reached: impact.reached } } : {}),
				loadMs: loaded.ms,
			};
		},
	}, {
		// ── codebase_trace（§R.7 第 ② 项：补廉价读图谱；≈ 真源 `trace_path` 的 **calls 半边** ✓）──────
		// ⚠ **为什么只做半边**：真源还有 `mode: data_flow / cross_service`（要 `DATA_FLOWS` / `HTTP_CALLS` 边 ✓）
		//   与 `riskLabels` / `toon` 输出 ✗ —— 而 2026-10-12 的前提取证显示：**本仓真图里只有**
		//   `CONTAINS` / `CALLS` / `USAGE` 三种边 ✓ ⇒ 承诺那两种 mode 就是**编** ✓。
		// ⚠ 三条从真实数据里学到的细节都由 `traceFrom` 兜住 ✓：去自环（真图有 `console→console` ✓）、
		//   同对去重 ✓、`edgeTypes` 写了图里没有的类型 ⇒ **明确报错并列出可用类型** ✓（不静默变"没找到"✗）。
		name: 'codebase_trace',
		description: '沿**调用边**追一条链：给一个符号名，往回找**谁调它**（callers ✓）、往下找**它调谁**（callees ✓）。'
			+ ' 适合影响面分析（"改这个函数会波及谁" ✓）；想只看一层的入/出边用 codebase_deps ✓。'
			+ ' 缺省沿 `CALLS` 走 ✓（图里实际有哪几种边，出错时会**列出来** ✓）；`targetName` 给了就找通向它的**最短链** ✓（BFS ⇒ 最短 ✓）。'
			+ ' ⚠ 真源的 `data_flow` / `cross_service` 模式**未移植** ✗ —— 它们需要的边类型图里没有 ✓；'
			+ ' 名字歧义时**列候选不猜** ✓；会加载**全量图** ✓（首次慢）。',
		parameters: {
			type: 'object',
			properties: {
				sourceName: { type: 'string', description: '从哪个符号开始（`路径::名字` / `类::成员` / 光一个 `名字` ✓）' },
				targetName: { type: 'string', description: '可选：要找通向谁的最短链 ✓（名字片段即可 ✓）' },
				direction: { type: 'string', description: 'both（缺省）/ callers（只往回）/ callees（只往下）' },
				maxDepth: { type: 'integer', description: '最多几跳（缺省 10，上限 30 ✓）' },
				edgeTypes: { type: 'array', items: { type: 'string' }, description: '限定沿哪些边走（缺省 ["CALLS"] ✓；图里没有的类型会报错并列可用 ✓）' },
				maxNodes: { type: 'integer', description: '最多回多少个节点（缺省 200，上限 2000 ✓；超了**如实标 truncated** ✓）' },
			},
			required: ['sourceName'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					start: {
						type: 'object',
						properties: { qualifiedName: { type: 'string' }, name: { type: 'string' }, label: { type: 'string' }, filePath: { type: 'string' }, startLine: { type: 'integer' } },
					},
					used: { type: 'array', items: { type: 'string' } },
					available: { type: 'array', items: { type: 'string' } },
					hops: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								depth: { type: 'integer' }, direction: { type: 'string' }, label: { type: 'string' },
								name: { type: 'string' }, qualifiedName: { type: 'string' }, filePath: { type: 'string' }, startLine: { type: 'integer' },
							},
							required: ['depth', 'direction'],
						},
					},
					truncated: { type: 'boolean' },
					target: { type: 'string' },
					path: { type: 'array', items: { type: 'string' } },
					targetMissing: { type: 'boolean' },
					loadMs: { type: 'integer' },
					ambiguous: { type: 'boolean' },
					candidates: { type: 'array', items: { type: 'string' } },
					message: { type: 'string' },
				},
				required: ['ok'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.message ?? [
					`${value.start?.qualifiedName ?? value.start?.name}（${value.start?.label}）@ ${value.start?.filePath}:${value.start?.startLine}`,
					`沿 ${(value.used ?? []).join(', ')} 走了 ${(value.hops?.length ?? 1) - 1} 跳`
						+ (value.truncated ? `（已达节点上限 ⇒ **截断** ✓，链不完整 ✓）` : ''),
					...(value.hops ?? []).slice(1).map(hop => `${'  '.repeat(Math.min(hop.depth, 6))}${hop.direction === 'callers' ? '↑ 谁调它' : '↓ 它调谁'} ${hop.depth}：${hop.qualifiedName ?? hop.name} @ ${hop.filePath}:${hop.startLine}`),
					value.path ? `命中目标的**最短链**：${value.path.join('  →  ')}` : '',
					value.targetMissing ? '没找到匹配 `targetName` 的节点 ⇒ 可能在 maxDepth 之外、或名字不同 ✓（先用 codebase_search 核名字 ✓）' : '',
				].filter(Boolean).join('\n'),
			}],
		},
		execute: async params => {
			const loaded = await loadGraph(config);
			if (loaded.error) { throw new Error(`${loaded.error}（先确认这个工作区已建索引 ✓）`); }
			const result = traceFrom(loaded.graph, {
				sourceQuery: params?.sourceName,
				targetQuery: params?.targetName,
				edgeTypes: Array.isArray(params?.edgeTypes) && params.edgeTypes.length ? params.edgeTypes : ['CALLS'],
				direction: typeof params?.direction === 'string' ? params.direction : 'both',
				maxDepth: params?.maxDepth,
				maxNodes: params?.maxNodes,
			});
			if (result.error) { throw new Error(result.error); }
			if (result.candidates) {
				return {
					ok: false, ambiguous: true, candidates: result.candidates, loadMs: loaded.ms,
					message: `「${params?.sourceName}」在图谱里有 ${result.candidates.length} 个候选 ⇒ 请给更完整的限定名再试 ✓：\n${result.candidates.map(name => `- ${name}`).join('\n')}`,
				};
			}
			return { ok: true, ...result, loadMs: loaded.ms };
		},
	}, {
		// ── codebase_schema（§R.7 第 ② 项：补廉价读图谱）────────────────────────────────────────
		// 真源：IDE `codebaseTools.ts` 的 `get_graph_schema`（节点标签 + 边类型 + 计数 ✓）。
		// ⚠ 与**页面上那条**自诊断的故意差别 ✗：页面用的 `summarizeGraph` 把 labels/edgeTypes 各**截到 top 12** ✗；
		//   给模型看必须① 说清**总数**（labelsTotal / edgeTypesTotal ✓）② 截断时**如实标 truncated** ✓ ——
		//   "看起来齐全、其实漏了"是这类汇总最容易犯的错 ✓。
		name: 'codebase_schema',
		description: '读**代码图谱的结构目录**：节点标签（function / class / file …）与边类型（CALLS / IMPORTS / CONTAINS …）各自的**计数**，'
			+ '外加 节点数 / 边数 / 文件数 / 社区数 ✓。'
			+ ` 列表最多列 ${SCHEMA_LIST_LIMIT} 条，截断时**如实标 truncated** ✓（总数看 labelsTotal / edgeTypesTotal ✓）。`
			+ ' ⚠ 会加载**全量图** ✓（首次慢）；只想知道"有没有图、多大"用 codebase_overview ✓（走轻路径 ✓，不解压 ✓）。',
		parameters: {
			type: 'object',
			properties: { limit: { type: 'integer', description: `每个列表最多几条（缺省 ${SCHEMA_LIST_LIMIT}，1–200）` } },
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					nodes: { type: 'integer' }, edges: { type: 'integer' }, files: { type: 'integer' }, communities: { type: 'integer' },
					labels: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } }, required: ['name', 'count'] } },
					edgeTypes: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } }, required: ['name', 'count'] } },
					labelsTotal: { type: 'integer' }, edgeTypesTotal: { type: 'integer' },
					truncated: { type: 'boolean' }, loadMs: { type: 'integer' },
				},
				required: ['nodes', 'edges', 'labels', 'edgeTypes'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `图谱结构：${value.nodes} 节点 / ${value.edges} 边 / ${value.files} 文件 / ${value.communities} 社区`
					+ `\n节点标签（${value.labels.length}/${value.labelsTotal}）：${value.labels.map(l => `${l.name}×${l.count}`).join(', ')}`
					+ `\n边类型（${value.edgeTypes.length}/${value.edgeTypesTotal}）：${value.edgeTypes.map(e => `${e.name}×${e.count}`).join(', ')}`
					+ (value.truncated ? `\n（列表已截断：只列了前 ${SCHEMA_LIST_LIMIT} 条 ✓，总数见上 ✓）` : ''),
			}],
		},
		execute: async params => {
			const loaded = await loadGraph(config);
			if (loaded.error) { throw new Error(`${loaded.error}（先确认这个工作区已建索引 ✓）`); }
			const limit = Math.min(200, Math.max(1, Number.isFinite(params?.limit) ? Math.floor(params.limit) : SCHEMA_LIST_LIMIT));
			return { ...graphSchemaOf(loaded.graph, { limit }), loadMs: loaded.ms };
		},
	}, {
		// ── codebase_manage_adr（P9，2026-10-13）────────────────────────────────────────────
		// 真源：`manage_adr`（list / get / create / update / delete ✓）。
		// ⚠ 这是本插件**唯一的多动作工具** ⇒ 审批闸**必须按 action 分岔**：读动作不问、写动作必问 ✓
		//   （例外的理由见 `ADR_READ_ACTIONS` ✓ —— 它不是"同一变更靠参数绕闸"那类 ✗，是不同操作 ✓）。
		// ⚠ 落点在**工作区内**（缺省 `.codebase-memory/adr/`，可用 `config.adrDir` 改 ✓，仍只许工作区内 ✓）：
		//   ADR 是**仓库内容** ✓（要跟着 git 走、要被同事 review ✓）—— 放进我们自己的索引数据目录就成"只有这台机器看得见的私有笔记" ✗✗。
		name: 'codebase_manage_adr',
		description: '架构决策记录（ADR）：`list` / `get` / `create` / `update` / `delete` —— 真源 `manage_adr` 的对应物 ✓。'
			+ ' ⚠ 落点是**工作区内的** `.codebase-memory/adr/`（可用 `config.adrDir` 改 ✓；绝对路径 / `..` 一律拒 ✓）：'
			+ 'ADR 是**仓库内容** ✓（跟 git 走 ✓），不是我们的私有数据 ✓ —— 这也是所有权交给 dsh 之后才敢往那里写的原因 ✓。'
			+ ' ⚠ `id` 就是文件名主干（`NNN-slug` ✓）：`create` 自动取**下一个编号** ✓；`update` **保留原编号** ✓（换了编号等于换了一条、引用全断 ✗）；'
			+ '`get` / `update` / `delete` 也收纯数字前缀（`007` ✓），**别的写法一律拒** ✗（内容或路径当 id = 路径穿越的入口 ✓）。'
			+ ' ⚠ 写动作（create / update / delete）走**审批闸** ✓（这是本插件唯一按 `action` 分岔的闸门 ✓）；`list` / `get` 只读 ⇒ **不追问** ✓。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], description: '要做什么（`list` / `get` 只读 ⇒ 不追问 ✓；另三个是写 ⇒ 走审批闸 ✓）' },
				id: { type: 'string', description: '`get` / `update` / `delete`：ADR 的 id（文件名主干 `NNN-slug`，或纯数字前缀 `007` ✓）' },
				title: { type: 'string', description: '`create`（必给）/ `update`：标题 —— 会写成正文第一行 `# 标题` ✓' },
				content: { type: 'string', description: '`create` / `update`：正文（`update` 不给 content 就只改标题 ✓）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, action: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' },
					relPath: { type: 'string' }, path: { type: 'string' }, bytes: { type: 'integer' }, content: { type: 'string' },
					dir: { type: 'string' }, relDir: { type: 'string' }, dirSource: { type: 'string' }, count: { type: 'integer' },
					items: { type: 'array' }, deleted: { type: 'boolean' }, notes: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
				},
				required: ['ok'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.action === 'list'
					? `ADR 共 ${value.count} 条（${value.relDir}/ · 落点依据 ${value.dirSource} ✓）\n${(value.items ?? []).map(item => `- ${item.id} — ${item.title}（${item.bytes}B）`).join('\n') || '（还没有 ADR ✓ 用 `action: "create"` 建一条 ✓）'}`
					: value.action === 'get'
						? `${value.relPath}（${value.bytes}B ✓）\n\n${value.content}`
						: `ADR ${value.action === 'create' ? '已新建' : value.action === 'update' ? '已改写' : '已删除'}：**${value.id}**${value.title ? ` — ${value.title}` : ''}（${value.relPath}${value.bytes !== undefined ? `，${value.bytes}B` : ''} ✓）`
							+ `${value.note ? `\n${value.note}` : ''}`,
			}],
		},
		execute: async params => {
			const action = String(params?.action ?? '');
			const id = typeof params?.id === 'string' ? params.id : undefined;
			const title = typeof params?.title === 'string' ? params.title : undefined;
			const content = typeof params?.content === 'string' ? params.content : undefined;
			const run = async (fn, label) => {
				const got = await fn();
				if (got.error) { throw new Error(String(got.error)); }
				return { action: label, ...got };
			};
			if (action === 'list') { return run(() => listAdrs(config), 'list'); }
			if (action === 'get') { return run(() => getAdr(config, { id }), 'get'); }
			if (action === 'create') { return run(() => createAdr(config, { title, content }), 'create'); }
			if (action === 'update') { return run(() => updateAdr(config, { id, title, content }), 'update'); }
			if (action === 'delete') { return run(() => deleteAdr(config, { id }), 'delete'); }
			// ⚠ 乱给的 action **不许**悄悄当成某个默认动作 ✗（本仓对"静默换语义"一贯当场拒 ✓）
			throw new Error(`不认识的 action \`${action}\` ✗（支持：list / get / create / update / delete ✓）`);
		},
	}, {
		// ── codebase_query_graph（P10，2026-10-13）──────────────────────────────────────────
		// 真源：`query_graph`（**Cypher**：`MATCH … WHERE … RETURN …` ✓，例：找 X 的全部调用者 ✓）。
		// ⚠ dsh 侧**没有图查询语言** ✗ —— 2026-10-13 已决定不引入解析器/执行器（那约等于一个新子系统 ✓）。
		//   能做且**诚实**的对应物是 `shapeQuery.js` 的**极小形状语法**：把用户真正在问的那几种"问题形状"
		//   （找同类型的 / 某个文件里的 / 一个符号的依赖 / 最热的 / 改动波及谁 ✓）表达出来，转发给既有 helper ✓。
		//   ⇒ 这个工具只是把它**挂出来**（原先只有页面的 `?shape=` 能到 ✓，"有能力、没出口" ✓）。
		// ⚠ 两条纪律照旧（见 shapeQuery.js 文件头 ✓）：**只认 `SHAPE_HELP` 里的写法**；其它输入**当场拒**并**列出支持的写法** ✓
		//   （"看着像支持整门语言、其实只跑通一条"是最坏的形态 ✗✗ —— 所以错误信息本身就是那份清单 ✓）。
		// ⚠ 需要索引 ✓（跑之前要加载全量图，与 `codebase_search` 同档 ✓）；只读 ⇒ **不进审批闸** ✓。
		name: 'codebase_query_graph',
		description: '形状查询（真源 `query_graph` 的对应物 ✓ —— ⚠ 但 <b>不是 Cypher</b> ✗）。'
			+ ' dsh 侧**没有**图查询语言（已决定不引入解析器/执行器 ✓）⇒ 这里是一个**极小的形状语法**：'
			+ '`type:<label>`（该类型里被依赖最多的 ✓）/ `file:<路径片段>` / `deps:<符号名>` / `file-deps:<文件名>` /'
			+ '`impact:<符号名>#<跳数≤5>`（改它波及谁 ✓）/ `hot:<N>` 或 `out:<N>`（入度 / 出度最高的前 N ✓，N ≤ 50 ✓）。'
			+ ' ⚠ **只认上面这些写法**：其它输入（比如真源那种 `MATCH (f:Function) WHERE … RETURN …` ✗）一律**当场拒**，'
			+ '并**列出支持的写法** ✓（返回值里也原样带 `supported` ✓）。'
			+ ' ⚠ 需要索引 ✓（会加载全量图）；要"找某段文本/某个文件"请用 `codebase_search_code` / `codebase_search_files` ✓。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '形状查询（如 `hot:10` ✓ / `deps:localize` ✓ / `impact:localize#2` ✓；写法清单见 `supported` ✓）' },
			},
			required: ['query'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, query: { type: 'string' }, shape: { type: 'object' }, title: { type: 'string' },
					rows: { type: 'array' }, rowCount: { type: 'integer' }, deps: { type: 'object' }, note: { type: 'string' },
					supported: { type: 'array' }, loadMs: { type: 'integer' },
				},
				required: ['ok', 'query', 'supported'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `${value.title ?? ''}（${value.rowCount ?? 0} 行 · 图加载 ${value.loadMs ?? '?'}ms ✓）`
					+ `${value.note ? `\n⚠ ${value.note}` : ''}`
					// ⚠ 行形状由 core helper 决定（不在这里假设字段齐全 ✓）⇒ 每个字段都**先看有没有**再打 ✓
					+ `\n${(value.rows ?? []).slice(0, 25).map(row => [`#${row?.id ?? '?'}`, row?.name, row?.label, row?.filePath, row?.inDegree !== undefined ? `入度 ${row.inDegree}` : undefined, row?.outDegree !== undefined ? `出度 ${row.outDegree}` : undefined].filter(Boolean).join(' · ')).join('\n') || '（没有行 ✓）'}`
					+ `\n支持的写法：\n${(value.supported ?? []).map(entry => `· \`${entry.usage}\` — ${entry.desc}`).join('\n')}`,
			}],
		},
		execute: async params => {
			const parsed = parseShapeQuery(params?.query);
			if (!parsed.ok) {
				// ★ 拒绝的**正文**就是那份支持清单 ✓（"支持什么"必须在出错的地方说，而不是藏在文档里 ✓）
				throw new Error(`${parsed.error} ✗ —— ${parsed.hint}\n支持的写法：\n${SHAPE_HELP.map(entry => `· \`${entry.usage}\` — ${entry.desc}`).join('\n')}`);
			}
			const loaded = await loadGraph(config);
			if (loaded.error) { throw new Error(`${loaded.error}（先确认这个工作区已建索引 ✓）`); }
			const shaped = runShapeQuery(loaded.graph, parsed.shape, { nodeLimit: parsed.shape.limit });
			if (shaped.error) { throw new Error(String(shaped.error)); }
			return {
				ok: true,
				query: String(params?.query ?? ''),
				shape: parsed.shape,
				title: shaped.title,
				rows: (shaped.rows ?? []).slice(0, 50),
				rowCount: (shaped.rows ?? []).length,
				...(shaped.deps ? { deps: shaped.deps } : {}),
				...(shaped.note ? { note: shaped.note } : {}),
				supported: SHAPE_HELP,
				loadMs: loaded.ms,
			};
		},
	}, {
		// ── codebase_search_files（P8，2026-10-13）──────────────────────────────────────────
		// 真源 `search_files` **是 `search_code` 的超集** ✓ —— 多出的正是 `mode: files`（**按名字找文件** ✓，
		// 也就是它 description 里那句"代替 find / ls" ✓）。这里把四种模式收齐，但**只实现一次搜索**：
		//   · `files` ⇒ `store.findFiles`（只读目录项 ⇒ 与文件大小无关 ✓）；
		//   · `content` ⇒ 直接委托 `searchCode` ✓；`files_with_matches` / `count` ⇒ 由 `searchCode` 的结果派生 ✓
		//     （**不另造第二套搜索** ✗ —— 那迟早与 `codebase_search_code` 的语义漂移 ✓）。
		// ⚠ 只读 ⇒ **不进审批闸** ✓（与 `codebase_search_code` 同 ✓）。
		// ⚠ 参数名照**这个**真源工具（`pattern` / `file_glob` / `offset` ✓），所以它与 `codebase_search_code`
		//   的 `query` / `filePattern` **拼写不同** —— 这是**有意**的 1:1 映射 ✓（各自对着自己的真源 ✓）。
		name: 'codebase_search_files',
		description: '按**文件名/路径**找文件，或搜索文件内容 —— 真源 `search_files` 的对应物 ✓。'
			+ ' `mode`：`content`（默认，**读内容**，等价于 `codebase_search_code` ✓）/ `files`（**按名字找** ✓：只读目录项、'
			+ '不读内容 ⇒ 与文件大小**无关** ✓；`pattern` 用 glob 如 `*.ts`；**不带通配符**时按**文件名子串**匹配，'
			+ '并把选择写在 `matchedBy` 里 ✓ —— 不静默换语义 ✓）/ `files_with_matches`（只列命中的**文件** ✓）/ `count`（每个文件命中多少**行** ✓）。'
			+ ' ⚠ 与 `codebase_search`（**图**上按名字找节点）是**两件事** ✗；这两种搜索都**不需要索引** ✓（有图没图都能用 ✓）。'
			+ ' ⚠ `scannedFiles` 是**遍历到**的文件数（含被名字匹配滤掉的 ✓，与 `codebase_search_code` 同义 ✓）；`truncatedScan` 为真时"没找到"只代表**扫到的那部分**没有 ✗。'
			+ ' ⚠ 与真源的差别同 `codebase_search_code`：真源 ripgrep-backed ✓，dsh 是 **Node 扫描** ✓（`backend` / `truncatedScan` 如实 ✓）；'
			+ '**不读 `.gitignore`** ✗；只在工作区内 ✓。'
			+ ' ⚠ `offset` 只在 `mode: files` 下按**文件列表**分页 ✓（内容类模式用 `limit` 控制返回的命中行 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: '`content` 模式：要搜的文本/正则 ✓；`files` 模式：文件名 glob（如 `*.ts`）或子串 ✓' },
				mode: { type: 'string', enum: ['content', 'files', 'files_with_matches', 'count'], description: '做什么：读内容 / 找文件名 / 只列命中文件 / 逐文件计数（默认 content ✓）' },
				path: { type: 'string', description: '范围：**工作区内的相对路径**（默认整个工作区 ✓；绝对路径 / `..` 一律拒 ✓）' },
				file_glob: { type: 'string', description: '`content` 模式：只搜匹配的文件（如 `*.ts` ✓；只支持 `*` / `**` / `?` ✓）' },
				regex: { type: 'boolean', description: '`content` 模式：把 pattern 当原始正则（默认 false = 字面量 ✓）' },
				context: { type: 'integer', description: '`content` 模式：每个命中行前后各带几行（0-5 ✓）' },
				limit: { type: 'integer', description: `最多返回多少个结果（默认 ${SEARCH_DEFAULT_LIMIT}，上限 ${SEARCH_MAX_LIMIT} ✓；达到上限如实报 truncated ✓）` },
				offset: { type: 'integer', description: '`mode: files`：跳过前 N 个文件（分页 ✓）' },
			},
			required: ['pattern'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					mode: { type: 'string' }, ok: { type: 'boolean' }, pattern: { type: 'string' }, matchedBy: { type: 'string' },
					effectivePattern: { type: 'string' }, backend: { type: 'string' }, scope: { type: 'string' },
					total: { type: 'integer' }, returned: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' },
					totalHits: { type: 'integer' }, hitUnit: { type: 'string' }, fileCount: { type: 'integer' },
					truncated: { type: 'boolean' }, truncatedScan: { type: 'boolean' }, scannedFiles: { type: 'integer' },
					files: { type: 'array' }, notes: { type: 'array', items: { type: 'string' } }, ms: { type: 'integer' },
				},
				required: ['mode', 'ok'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.mode === 'files'
					? `按名字找文件 \`${value.pattern}\`（${value.matchedBy}${value.effectivePattern && value.effectivePattern !== value.pattern ? ` ⇒ 生效 ${value.effectivePattern}` : ''}）：`
						+ `共 ${value.total} 个${value.truncated ? '（已截断 ✓）' : ''} · 扫描 ${value.scannedFiles} 个目录项 · ${value.ms}ms`
						+ `${value.truncatedScan ? ' · ⚠ **扫描被截断**（"没有更多"只代表扫到的那部分 ✗）' : ''}`
						+ `\n${(value.files ?? []).slice(0, 40).join('\n') || '（没有匹配 ✓）'}`
					: `搜索 \`${value.pattern}\`（mode=${value.mode}）：${value.totalHits ?? 0} 个**命中行** / ${value.fileCount ?? 0} 个文件 · ${value.ms}ms（backend=${value.backend} ✓）`
						+ `${value.truncated ? ` · ⚠ 已达上限 ${value.limit}（只列前 ${value.limit} 个 ✓）` : ''}`
						+ `\n${(value.files ?? []).slice(0, 30).map(entry => (typeof entry === 'string' ? entry : `${entry.relPath}${entry.lines !== undefined ? `（${entry.lines} 行）` : ''}`)).join('\n') || '（没有命中 ✓）'}`,
			}],
		},
		execute: async params => {
			const allowed = ['content', 'files', 'files_with_matches', 'count'];
			const mode = allowed.includes(params?.mode) ? params.mode : 'content';
			const limit = Number.isFinite(params?.limit) ? params.limit : undefined;
			if (mode === 'files') {
				const got = await findFiles(config, {
					pattern: params?.pattern,
					...(typeof params?.path === 'string' ? { path: params.path } : {}),
					...(limit !== undefined ? { limit } : {}),
					...(Number.isFinite(params?.offset) ? { offset: params.offset } : {}),
				});
				if (got.error) { throw new Error(String(got.error)); }
				return { mode, ...got };
			}
			const searched = await searchCode(config, {
				query: params?.pattern,
				regex: params?.regex === true,
				...(typeof params?.path === 'string' ? { path: params.path } : {}),
				...(typeof params?.file_glob === 'string' ? { filePattern: params.file_glob } : {}),
				...(Number.isFinite(params?.context) ? { context: params.context } : {}),
				...(limit !== undefined ? { limit } : {}),
			});
			if (searched.error) { throw new Error(String(searched.error)); }
			if (mode === 'content') {
				return { mode, ...searched };
			}
			// `files_with_matches` ⇒ 只给**路径** ✓；`count` ⇒ 给**逐文件行数** ✓（两种形状都在描述里写清 ✓）
			const listed = mode === 'files_with_matches'
				? (searched.files ?? []).map(file => file.relPath)
				: (searched.files ?? []).map(file => ({ relPath: file.relPath, lines: (file.hits ?? []).length }));
			return {
				mode, ok: true, pattern: searched.pattern, backend: searched.backend, scope: searched.scope,
				totalHits: searched.totalHits, hitUnit: searched.hitUnit, fileCount: listed.length,
				truncated: searched.truncated, truncatedScan: searched.truncatedScan, scannedFiles: searched.scannedFiles,
				files: listed, notes: searched.notes, ms: searched.ms,
			};
		},
	}, {
		// ── codebase_search_code（P8，2026-10-13）────────────────────────────────────────────
		// 真源：`search_code` / `search_files` ✓ —— ⚠ 这两个**不是图查询**，是**文件系统文本搜索** ✓
		// （真源自己的说明里就写着"结构类问题请用图工具" ✓）⇒ 这里不碰图谱，所以**不需要索引** ✓，
		// 但也**答不了**结构问题 ✗（那是 `codebase_search` / `codebase_deps` / `codebase_trace` 的活 ✓）。
		// ⚠ 与真源的硬差别：真源 ripgrep-backed（巨仓也快 ✓），dsh 侧是 **Node 扫描**（无外部依赖 ✓，但有上限 ✓）
		//   ⇒ 返回值带 `backend` / `truncatedScan` / `scannedFiles` ✓；**不读** `.gitignore` ✗（只按排除目录集 ✓）。
		// ⚠ 只读 ✓ ⇒ **不进审批闸**（这是新增工具里第一个不需要批准的动作 ✓）。
		name: 'codebase_search_code',
		description: '**文本**搜索（正则或字面量）—— 真源 `search_code` 的对应物 ✓。'
			+ ' ⚠ 与 `codebase_search` 是**两件事** ✗：那个在**图**上按名字找节点 ✓；这个在**文件内容**里搜字符串 ✓'
			+ '（结构类问题——调用关系 / 定义 / 依赖 ——请用 `codebase_search` / `codebase_deps` / `codebase_trace` ✓）。'
			+ ' ⚠ **不需要索引**：它不读图谱，没有图也能用 ✓（但只搜**工作区内**、且**不读 `.gitignore`** ✗）。'
			+ ' ⚠ 与真源的差别是**速度**不是语义：真源 ripgrep-backed ✓，这里是 Node 扫描 ✓ ⇒ 返回值带 `backend` / `scannedFiles` / `truncatedScan` ✓。'
			+ ' ⚠ `totalHits` 是**命中行数**（同一行多处只算一行 ✓，见 `hitUnit` ✓）；多词查询会按真源规则自动转成 `.*` 连接 ✓（生效模式见 `pattern` ✓）。'
			// ⚠ 口径必须写进**描述**（不能只写在 `notes` 里 ✗）：描述是模型唯一看得见的那份 ✓
			+ ' ⚠ `scannedFiles` 是**遍历到**的文件数（含被 `filePattern` 滤掉的 ✓，与 `codebase_search_files` 同义 ✓）；到上限会置 `truncatedScan` ✓ —— 那时"没找到"只代表**扫到的那部分**没有 ✗。'
			+ ' ⚠ `filePattern` 只支持 `*` / `**` / `?`（不含 `/` 时按"任意路径以它结尾"处理 ✓，与 ripgrep `-g` 同义 ✓）；复杂 glob **如实拒** ✗。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '要搜的文本（默认按字面量 ✓；`regex: true` 时按正则 ✓）' },
				regex: { type: 'boolean', description: '把 query 当原始正则（默认 false = 字面量，特殊字符会被转义 ✓）' },
				path: { type: 'string', description: '搜索范围：**工作区内的相对路径**（默认整个工作区 ✓；绝对路径 / `..` 一律拒 ✓）' },
				filePattern: { type: 'string', description: '只搜匹配的文件（如 `*.ts` ✓；只支持 `*` / `**` / `?` ✓）' },
				context: { type: 'integer', description: '每个命中行前后各带几行（0-5 ✓，默认 0 ✓）' },
				limit: { type: 'integer', description: `最多返回多少**命中行**（默认 ${SEARCH_DEFAULT_LIMIT}，上限 ${SEARCH_MAX_LIMIT} ✓；达到上限会如实报 truncated ✓）` },
			},
			required: ['query'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, query: { type: 'string' }, pattern: { type: 'string' }, regex: { type: 'boolean' },
					backend: { type: 'string' }, scope: { type: 'string' }, filePattern: { type: 'string' },
					limit: { type: 'integer' }, totalHits: { type: 'integer' }, hitUnit: { type: 'string' }, fileCount: { type: 'integer' },
					truncated: { type: 'boolean' }, truncatedScan: { type: 'boolean' }, scannedFiles: { type: 'integer' },
					files: { type: 'array', items: { type: 'object' } }, notes: { type: 'array', items: { type: 'string' } },
					ms: { type: 'integer' },
				},
				required: ['ok', 'pattern', 'totalHits', 'fileCount'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `文本搜索 \`${value.pattern}\`${value.filePattern ? `（限于 ${value.filePattern}）` : ''}：`
					+ `${value.totalHits} 个**命中行** / ${value.fileCount} 个文件 · 扫描 ${value.scannedFiles} 个文件 · ${value.ms}ms（backend=${value.backend} ✓）`
					+ `${value.truncated ? ` · ⚠ 已达上限 ${value.limit}（只列了前 ${value.limit} 个命中行 ✓）` : ''}`
					+ `${value.truncatedScan ? ' · ⚠ **扫描也被截断**（只扫了一部分文件 ⇒ 结论只是"扫到的那部分没有" ✗）' : ''}`
					+ `\n${(value.files ?? []).slice(0, 12).map(file => `**${file.relPath}**\n${(file.hits ?? []).slice(0, 6).map(hit => `  ${hit.line}: ${hit.text}`).join('\n')}`).join('\n') || '（没有命中 ✓）'}`
					+ `${(value.files ?? []).length > 12 ? `\n（只列了前 12 个文件 ✓）` : ''}`
					+ `\n\`${(value.notes ?? []).join('` · `')}\``,
			}],
		},
		execute: async params => {
			const got = await searchCode(config, {
				query: params?.query,
				regex: params?.regex === true,
				...(typeof params?.path === 'string' ? { path: params.path } : {}),
				...(typeof params?.filePattern === 'string' ? { filePattern: params.filePattern } : {}),
				...(Number.isFinite(params?.context) ? { context: params.context } : {}),
				...(Number.isFinite(params?.limit) ? { limit: params.limit } : {}),
			});
			if (got.error) { throw new Error(String(got.error)); }
			return got;
		},
	}, {
		// ── codebase_export_artifact / codebase_import_artifact（P6，2026-10-13）────────────────
		// 真源：IDE 的 `export_artifact` / `import_artifact` ✓。用途：跨机器共享图谱、把索引搬来搬去 ✓。
		// ⚠ 两条路径都只收**工作区内的相对路径**（与 codebase_snippet **同一条**围栏 ⇒ 不为"能写到 U 盘"开任意写口子 ✗）。
		// ⚠ 导入是**不可信输入** ⇒ 先证明读得动（清单硬校验 + 带上限的真解一遍 ✓）**再**落盘 ✗✗。
		name: 'codebase_export_artifact',
		description: '把**你正在查的那份**图谱产物（`artifact.json` + `graph.db.zst`）导出到工作区内的一个目录 ✓（真源 `export_artifact` 的对应物 ✓）。'
			+ '导出的是 `graphDirOf` 选中的那份（影子可读则影子 ✓，否则 IDE 的 ✓）—— 返回值 `from` / `fromSource` **如实说明** ✓。'
			+ ' ⚠ `toDir` 只收**工作区内的相对路径**（绝对路径 / `..` 一律拒 ✓）；要搬走请自己复制出去 ✓。'
			+ ' ⚠ **不**导出 `graph.db.sqlite`（本插件读的是 `graph.db.zst` ✓ —— 导一份用不上的东西只会让"这份包到底够不够"变模糊 ✗）。',
		parameters: {
			type: 'object',
			properties: { toDir: { type: 'string', description: '工作区内的相对目录（如 `.vssaros-export/graph-1` ✓；不存在会创建 ✓）' } },
			required: ['toDir'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					exported: { type: 'boolean' }, from: { type: 'string' }, fromSource: { type: 'string' },
					to: { type: 'string' }, relDir: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
					bytes: { type: 'integer' }, note: { type: 'string' },
				},
				required: ['exported', 'to'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `已导出索引产物 → ${value.to}（${value.files?.join(' + ')}，${bytesOf(value.bytes)} ✓）`
					+ `\n来源：${value.from}（${value.fromSource}）✓`
					+ `\n${value.note}`,
			}],
		},
		execute: async params => {
			const got = await exportIndexArtifacts(config, { toDir: params?.toDir });
			if (got.error) { throw new Error(String(got.error)); }
			return got;
		},
	}, {
		name: 'codebase_import_artifact',
		description: '把一份外来的产物装成**本工作区的索引** ✓（真源 `import_artifact` 的对应物 ✓）。'
			+ '**先验证再落盘**：清单过 `parseManifest` 硬校验 ✓ + 图谱**真解一遍**（且带输出上限 ⇒ 挡 zip bomb ✓）'
			+ ' ⇒ 不合格**拒绝落盘** ✗✗（装一份坏图进来会让之后每个查询都错 ✓）。落盘复用索引器**同一套**原子写 ✓。'
			+ ' ⚠ **破坏性**：会覆盖本工作区现有产物（返回值 `replaced` 如实说明覆盖了什么 ✓）⇒ 走审批闸 ✓。'
			+ ' ⚠ 清单里的项目名与本工作区对不上时置 `foreignProject` ✓：跨机器共享是合法用途 ✓，但**绝不**让人以为'
			+ '"这份图就是本工作区索引出来的" ✗（图里的相对路径指向**导出方**的源码布局 ✓，要本地的图就跑 `codebase_index` ✓）。'
			+ ' ⚠ `fromDir` 只收**工作区内的相对路径** ✓。',
		parameters: {
			type: 'object',
			properties: { fromDir: { type: 'string', description: '含 `artifact.json` + `graph.db.zst` 的目录（工作区内相对路径 ✓）' } },
			required: ['fromDir'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					imported: { type: 'boolean' }, from: { type: 'string' }, to: { type: 'string' }, target: { type: 'string' },
					bytes: { type: 'integer' }, nodeCount: { type: 'integer' }, edgeCount: { type: 'integer' },
					project: { type: 'string' }, workspaceName: { type: 'string' }, foreignProject: { type: 'boolean' },
					replaced: { type: 'object' }, note: { type: 'string' },
				},
				required: ['imported', 'to'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `已导入索引产物：${value.from} → ${value.to}（${value.nodeCount} 节点 / ${value.edgeCount} 边，${bytesOf(value.bytes)} ✓）`
					+ `\n覆盖了：${value.replaced ? `${value.replaced.project}（保存于 ${value.replaced.savedAt ?? '未知'}）` : '（原本没有产物 ✓）'}`
					+ `\n项目名：${value.project}（本工作区：${value.workspaceName}）${value.foreignProject ? ' · ⚠ **对不上** ⇒ 这份图来自别处，图里的相对路径指的是导出方的布局 ✗' : ''}`
					+ `\n${value.note}`,
			}],
		},
		execute: async params => {
			const got = await importIndexArtifacts(config, { fromDir: params?.fromDir });
			if (got.error) { throw new Error(String(got.error)); }
			return got;
		},
	}, {
		// ── codebase_delete_project（P6，2026-10-13；`which` 随甲档·交接 2026-10-14 加 ✓）────────
		// 真源：IDE `codebaseTools.ts` 的 `delete_project` ✓。**在 dsh 里，"项目"与"工作区"是同一件事** ✓
		// （一个工作区就一份产物 ⇒ 删除 = 删本工作区的索引产物 ✓）；差别照例写死 ✓。
		// ⚠ 破坏性 ⇒ 进审批闸（`WRITE_TOOLS` ✓），且闸门理由**按工具名分岔**（不许复用建图那条 ✗）。
		name: 'codebase_delete_project',
		description: '删除本工作区的**索引产物**（真源 `delete_project` 的对应物 ✓；dsh 里一个工作区一份产物 ⇒ "项目"即工作区 ✓）。'
			+ '`which` 决定删哪一处（缺省 `current` = 当前配置的落点 ✓）—— 具体路径**以返回值 `dir` / `removed[]` 为准** ✓。'
			+ '**不可撤销**：删完读侧退回读 IDE 的 `.codebase-memory/`（它也没有 ⇒ 报"还没有图谱"✓）；要重建就跑 `codebase_index` ✓。'
			+ ' ⚠ **`which="workspace"` / `"both"` 是"把权限还给 IDE"的正规出口** ✓：交接后权限的凭据是**工作区那份清单里的 `producer`** ✓、'
			+ '**不是配置** ✗ —— 只把 `indexTarget` 改回 `shadow` 的话，工作区那份还在 ⇒ IDE **继续让路**、而 dsh 又不写它 ⇒ **两边都不索引** ✗✗。'
			+ ' ⚠ 三条红线：绝不删工作区根 ✓ / 工作区落点**只认** `<ws>/.codebase-memory` ✓ / 别人正在索引时**拒绝**（除非 `force` ✓）/ 删之前先清点、报告如实 ✓。'
			+ ' ⚠ 没产物**不算失败**（`deleted: false` ✓ 幂等 ✓）。'
			+ ' ⚠ 属**破坏性写动作** ⇒ 走审批闸 ✓（与 `codebase_index` 同一把 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				force: { type: 'boolean', description: '即使有人正持索引锁也强删（默认 false ✓；强删会在返回值里留 `forcedWhileLocked` ✓）' },
				which: {
					type: 'string',
					enum: DELETE_WHICH_VALUES,
					description: '删哪一处产物：`current`（缺省，当前配置的落点 ✓）/ `shadow`（dsh 自己的索引目录 ✓）/ '
						+ '`workspace`（`<ws>/.codebase-memory/` ✓ ⇒ **把权限还给 IDE** 的动作 ✓）/ `both`（两处都删 ✓）',
				},
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					deleted: { type: 'boolean' }, dir: { type: 'string' }, target: { type: 'string' }, source: { type: 'string' },
					which: { type: 'string' }, note: { type: 'string' },
					removedFiles: { type: 'integer' }, removedBytes: { type: 'integer' },
					forcedWhileLocked: { type: 'boolean' }, reason: { type: 'string' }, afterDelete: { type: 'string' },
					removed: { type: 'array', items: { type: 'object' } },
					refused: { type: 'array', items: { type: 'object' } },
				},
				required: ['deleted'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.which === 'both'
					? `两处产物处理完毕：${(value.removed ?? []).map(item => `\n· [${item.which}] ${item.deleted
						? `已删 ${item.dir}（${item.removedFiles} 个文件 / ${bytesOf(item.removedBytes)}）`
						: item.error ? `⚠ 被拒：${item.error}` : `无产物可删（${item.dir}）`}`).join('')}`
						+ `\n合计 ${value.removedFiles} 个文件 / ${bytesOf(value.removedBytes)}`
						+ `\n${value.afterDelete}`
					: value.deleted
						? `已删除索引产物：${value.dir}（${value.removedFiles} 个文件 / ${bytesOf(value.removedBytes)}，target=${value.target}${value.which ? `，which=${value.which}` : ''} ✓）`
							+ `${value.forcedWhileLocked ? ` · ⚠ 当时锁仍被持有（forcedWhileLocked=${value.forcedWhileLocked}）` : ''}`
							+ `${value.note ? `\n${value.note}` : ''}`
							+ `\n${value.afterDelete}`
						: `没有删除任何东西：${value.reason}\n目录：${value.dir}${value.note ? `\n${value.note}` : ''}`,
			}],
		},
		execute: async params => {
			const got = await deleteIndexArtifacts(config, { force: params?.force === true, which: params?.which });
			if (got.error) { throw new Error(String(got.error)); }
			return got;
		},
	}, {
		// ── codebase_coverage（P6，2026-10-13）──────────────────────────────────────────────
		// 真源：IDE `codebaseTools.ts` 的 `check_index_coverage` ✓。**关键差异说死**：真源逐文件保留结果
		// （"这个文件为什么被跳过" ✓），而 dsh 的索引器只汇总计数 ✗（`stats.skippedUnsupported` / `stats.extractErrors`）
		// ⇒ 这里给的是**集合差**（哪边多出来 ✓），**不给"每个文件的原因"** ✗（要后者得先让索引器把逐文件结果落进产物 ✓）。
		name: 'codebase_coverage',
		description: '索引**覆盖率**（只读 ✓）：图里有多少文件、**现在**扫得到多少、哪边多出来。'
			+ '`missingInGraph` = 扫得到但图里没有 ⇒ **未覆盖**（上次索引之后新增 / 上次解析失败被跳 / 上次达 maxFiles 截断 ✓）；'
			+ '`missingOnDisk` = 图里有但现在扫不到 ⇒ **图已过期**（文件被删或移走，或索引范围变了 ✓）。'
			+ ' ⚠ 与真源 `check_index_coverage` 的差别：真源给"每个被跳过的文件 + 原因"（未支持 / 超大 / 超长行 / 解析错 / 超时 / 部分解析 ✓），'
			+ '我们**只保留计数、没有逐文件结果** ✗ ⇒ 这里是**集合差**，不是"每个文件的失败原因" ✗。'
			+ ' ⚠ 会加载**全量图**（与 codebase_search 同档 ✓）；扫的扩展名是**正则档 ∪ 真解析档认得的**'
			+ '（只按正则档扫会把 .py / .go 之类判成"图已过期" ✗✗ —— 方向反了，最坏的那类错 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				maxFiles: { type: 'integer', description: `扫描上限（默认 ${INDEX_MAX_FILES}，上限 ${INDEX_MAX_FILES_CAP} ✓；达到上限会如实报 truncated ✓ —— 数字会被压低，提高它再核 ✓）` },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, root: { type: 'string' },
					graphFileCount: { type: 'integer' }, scannedFileCount: { type: 'integer' },
					coveredCount: { type: 'integer' }, coveragePct: { type: 'number' },
					staleGraph: { type: 'boolean' }, truncated: { type: 'boolean' }, maxFiles: { type: 'integer' },
					missingOnDiskReliable: { type: 'boolean' },
					missingInGraph: { type: 'array', items: { type: 'string' } },
					missingOnDisk: { type: 'array', items: { type: 'string' } },
					method: { type: 'string' },
				},
				required: ['ok', 'graphFileCount', 'scannedFileCount', 'coveragePct'],
			},
			render: (_args, value) => [{
				type: 'text',
				// ⚠ 列表上限 20：这里不引常量（工具对象里放不下 const ✗），数字就地写死并说明 ✓
				text: `覆盖率 ${value.coveragePct}%：图里 ${value.graphFileCount} 个文件，现在扫到 ${value.scannedFileCount} 个（交集 ${value.coveredCount}）`
					+ `${value.staleGraph ? ' · ⚠ 存在"图里有、磁盘扫不到"的文件 ⇒ **图已过期**' : ''}`
					+ `${value.truncated ? ` · ⚠ 本次扫描达上限 ${value.maxFiles} ⇒ 覆盖率只是**下界**，且"图已过期"这一项**不可信**（没扫到 ≠ 不存在 ✗）；把 maxFiles 提到超过工作区文件数再核 ✓` : ''}`
					+ `\n未覆盖（扫得到但图里没有）：${value.missingInGraph.length} 个${value.missingInGraph.length ? `\n${value.missingInGraph.slice(0, 20).map(path => `- ${path}`).join('\n')}` : ''}`
					+ `${value.missingInGraph.length > 20 ? `\n（只列前 20 个 ✓）` : ''}`
					+ `\n图已过期（图里有但现在扫不到）：${value.missingOnDisk.length} 个${value.missingOnDisk.length ? `\n${value.missingOnDisk.slice(0, 20).map(path => `- ${path}`).join('\n')}` : ''}`
					+ `\n${value.method}\ncodebase_coverage_json: ${JSON.stringify({ ok: value.ok, root: value.root, graphFileCount: value.graphFileCount, scannedFileCount: value.scannedFileCount, coveredCount: value.coveredCount, coveragePct: value.coveragePct, staleGraph: value.staleGraph, truncated: value.truncated, maxFiles: value.maxFiles, missingOnDiskReliable: value.missingOnDiskReliable, missingInGraph: value.missingInGraph, missingOnDisk: value.missingOnDisk })}`,
			}],
		},
		execute: async params => {
			const loaded = await loadGraph(config);
			if (loaded.error) { throw new Error(`${loaded.error}（先确认这个工作区已建索引 ✓）`); }
			const maxFiles = Math.min(INDEX_MAX_FILES_CAP, Math.max(1, Number.isFinite(params?.maxFiles) ? Math.floor(params.maxFiles) : INDEX_MAX_FILES));
			const got = await coverageOf(config, loaded.graph, { maxFiles });
			if (got.error) { throw new Error(String(got.error)); }
			return { ok: true, ...got };
		},
		}, {
		// ── codebase_projects（§R.7 第 ② 项：补廉价读图谱）──────────────────────────────────────
		// 真源：IDE `codebaseTools.ts` 的 `list_projects` ✓。它在这里**特别必要**：本模块支持
		// `config.relatedRoots`（一张图可能覆盖**多个**根 ✓，README 4.87/4.88）⇒ 模型得先知道
		// "这张图里有哪几个项目"，才谈得上把检索/依赖查询收敛到对的那个 ✓。
		name: 'codebase_projects',
		description: '列出**这张代码图谱覆盖了哪些项目**：每个项目的 节点 / 边 / 文件 计数与 top 节点类型 ✓。'
			+ '（一张图可能覆盖多个工作区根 ✓ —— 先看这里，再用 codebase_search / codebase_deps 时心里有数 ✓。）'
			+ ' ⚠ 它只说明"**图里**有什么"，不代表磁盘上还有那些文件 ✓（图可能已过期 ✓）；会加载**全量图** ✓。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'integer' },
					projects: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								project: { type: 'string' }, nodes: { type: 'integer' }, edges: { type: 'integer' }, files: { type: 'integer' },
								topLabels: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } }, required: ['name', 'count'] } },
							},
							required: ['project', 'nodes'],
						},
					},
					loadMs: { type: 'integer' },
				},
				required: ['count', 'projects'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.count
					? `图谱里的项目（${value.count} 个）：\n${value.projects.map(p => `- ${p.project}：${p.nodes} 节点 / ${p.edges} 边 / ${p.files} 文件（${p.topLabels.map(l => `${l.name}×${l.count}`).join(', ') || '无标签'}）`).join('\n')}`
					: '图谱里没有任何节点（可能是空图 ✓）。',
			}],
		},
		execute: async () => {
			const loaded = await loadGraph(config);
			if (loaded.error) { throw new Error(`${loaded.error}（先确认这个工作区已建索引 ✓）`); }
			const projects = projectsOf(loaded.graph);
			return { count: projects.length, projects, loadMs: loaded.ms };
		},
	}, {
		// ── codebase_snippet（§R.7 第 ② 项：补"廉价读图谱"里**最值钱**的那个 ✓）──────────────────
		// 真源：IDE `codebaseTools.ts` 的 `get_code_snippet` ✓（按 qualified name 取源码 + 前后文 ✓）。
		// ⚠ 真源在图上查不到符号时会**退回全工作区 ripgrep** ✗ —— 我们这版**只做"图上查得到"的半边** ✓，
		//   报错里**指路**（先用 codebase_search ✓），**不**悄悄换成另一种语义 ✗（"同一个名字两种意思"最难解释 ✓）。
		// ⚠ 该工具会加载**全量图** ✓（首次慢，与 search/deps/hotspots 同档 ✓）；读文件有**三条围栏** ✓
		//   （按**实际用的根**解析 / 只许相对路径往里 / 先 stat 再读 ✓，见 `store.readSourceSlice` ✓）。
		name: 'codebase_snippet',
		description: '按符号名读**源码本体**（函数 / 类 / 接口的代码）—— 图谱里查到它的文件与行号，直接把那段读回来 ✓。'
			+ ' 名字给 `路径::名字` / `类::方法` / 光一个 `名字` 都行 ✓；**歧义时列出候选而不是猜** ✗（猜错等于把别的符号的源码当事实说出去 ✓）。'
			+ ` 默认前后各带 ${SNIPPET_CONTEXT_DEFAULT} 行上下文；一次最多 ${SNIPPET_MAX_LINES} 行 ✓。`
			+ ' ⚠ 只读**工作区内**的相对路径（绝对路径 / `..` 一律拒 ✓）；图上没有就如实报错并指路 codebase_search ✓（不会偷偷改成文本搜索 ✗）。',
		parameters: {
			type: 'object',
			properties: {
				qualifiedName: { type: 'string', description: '符号名（`src/foo.ts::bar` / `Foo::bar` / `bar` 均可）' },
				contextLines: { type: 'integer', description: `前后各带几行上下文（缺省 ${SNIPPET_CONTEXT_DEFAULT}，上限 200）` },
			},
			required: ['qualifiedName'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					qualifiedName: { type: 'string' },
					label: { type: 'string' },
					filePath: { type: 'string' },
					startLine: { type: 'integer' },
					endLine: { type: 'integer' },
					lineFrom: { type: 'integer' },
					lineTo: { type: 'integer' },
					truncated: { type: 'boolean' },
					endLineKnown: { type: 'boolean' },
					bytes: { type: 'integer' },
					loadMs: { type: 'integer' },
					code: { type: 'string' },
					ambiguous: { type: 'boolean' },
					candidates: { type: 'array', items: { type: 'string' } },
					message: { type: 'string' },
				},
				required: ['ok'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.message ?? [
					`${value.qualifiedName}（${value.label}）@ ${value.filePath}:${value.startLine}${value.endLineKnown ? `-${value.endLine}` : ''}`,
					value.code,
					value.truncated ? `（已截断：只回了前 ${SNIPPET_MAX_LINES} 行 ✓）` : '',
					value.endLineKnown ? '' : '（图谱只标了**起始行** ⇒ 上面是"这一行 + 前后文"，不是整个函数体 ✓）',
				].filter(Boolean).join('\n'),
			}],
		},
		execute: async params => {
			const loaded = await loadGraph(config);
			if (loaded.error) { throw new Error(`${loaded.error}（先确认这个工作区已建索引 ✓）`); }
			const picked = resolveSymbol(loaded.graph, { qualifiedName: params?.qualifiedName });
			if (picked.error) { throw new Error(picked.error); }
			if (picked.candidates) {
				return {
					ok: false, ambiguous: true, candidates: picked.candidates, loadMs: loaded.ms,
					message: `「${params?.qualifiedName}」在图谱里有 ${picked.candidates.length} 个候选 ⇒ 请给更完整的限定名再试 ✓：\n${picked.candidates.map(name => `- ${name}`).join('\n')}`,
				};
			}
			const node = picked.node;
			const read = await readSourceSlice(config, node, { contextLines: params?.contextLines });
			if (!read.ok) { throw new Error(read.why); }
			const sliced = sliceLines(read.text, {
				startLine: node.startLine, endLine: node.endLine, contextLines: params?.contextLines, maxLines: SNIPPET_MAX_LINES,
			});
			return {
				ok: true,
				qualifiedName: node.qualifiedName ?? node.name,
				label: node.label,
				filePath: node.filePath,
				startLine: node.startLine,
				endLine: node.endLine,
				lineFrom: sliced.from,
				lineTo: sliced.to,
				truncated: sliced.truncated,
				endLineKnown: sliced.endLineKnown,
				bytes: read.bytes,
				loadMs: loaded.ms,
				code: sliced.lines.map(line => `${String(line.n).padStart(5)} | ${line.text}`).join('\n'),
			};
		},
	}, {
		name: 'codebase_self_index',
		description: '写侧前提自证：在 Host 里扫工作区源码、产出**最小**图谱产物（文件级 import 图）并用**同一个读侧**读回比对。只写临时目录，不碰工作区的 .codebase-memory（那是 VsSaros 侧的所有物）。',
		parameters: {
			type: 'object',
			properties: {
				maxFiles: { type: 'integer', description: '最多扫多少源文件，50–5000（默认 1500）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, root: { type: 'string' },
					files: { type: 'integer' }, imports: { type: 'integer' },
					external: { type: 'integer' }, unresolved: { type: 'integer' }, truncated: { type: 'boolean' },
					nodeCount: { type: 'integer' }, edgeCount: { type: 'integer' },
					readBackNodeCount: { type: 'integer' }, readBackEdgeCount: { type: 'integer' },
					graphBytes: { type: 'integer' }, ms: { type: 'integer' },
					reused: { type: 'integer' }, incrementalEqual: { type: 'boolean' },
					deltaFiles: { type: 'integer' }, deltaReused: { type: 'integer' },
					deltaEdgesBefore: { type: 'integer' }, deltaEdgesAfter: { type: 'integer' },
					deltaEqual: { type: 'boolean' },
					missReused: { type: 'integer' }, missObserved: { type: 'boolean' }, rescannedEqual: { type: 'boolean' },
					symbolCount: { type: 'integer' }, containsEdges: { type: 'integer' }, symbolFixtureOk: { type: 'boolean' },
					// ⑥ 缓存跨进程（README 5.75）：字节数 / 子进程与全量是否一致 / 子进程复用数 / 该拒就拒的条数
					cacheBytes: { type: 'integer' }, cacheCrossProcessEqual: { type: 'boolean' },
					cacheReuseCount: { type: 'integer' }, cacheRejects: { type: 'integer' },
					readBackSymbolNodes: { type: 'integer' },
					importSymbolEdges: { type: 'integer' }, importSymbolsMissing: { type: 'integer' },
				},
				required: ['ok', 'files', 'nodeCount', 'edgeCount'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `写侧自证通过：扫 ${value.files} 个源文件 → ${value.nodeCount} 节点（文件 ${value.files} ＋ 符号 ${value.symbolCount}）/ ${value.edgeCount} 条边（含 CONTAINS ${value.containsEdges}）（外部依赖 ${value.external} · 未解析 ${value.unresolved}${value.truncated ? ' · 已达上限截断' : ''}），产物 ${value.graphBytes} 字节被**同一读侧**读回一致（${value.ms}ms）。\n`
					+ `符号级：顶层声明抽得对（含"缩进的不抽"反例）${value.symbolFixtureOk ? '✓' : '✗'}，读侧原样带回 ${value.readBackSymbolNodes} 个符号节点；具名导入连到真定义 ${value.importSymbolEdges} 条（名字在目标里找不到 ${value.importSymbolsMissing} 条，如实计数）。\n`
					+ `增量：pass2 复用 ${value.reused}/${value.files} 个文件且产物**逐字节相同** ${value.incrementalEqual ? '✓' : '✗'}；差分夹具 ${value.deltaFiles} 个文件、import 边 ${value.deltaEdgesBefore}→${value.deltaEdgesAfter}（复用 ${value.deltaReused}）⇒ 增量 ≡ 全量 ${value.deltaEqual ? '✓' : '✗'}。\n`
					+ `兜底：漏改**可复现** ${value.missObserved ? '✓' : '✗'}（复用 ${value.missReused} 个文件）⇒ 一次全量重扫与干净重建**逐字节相同** ${value.rescannedEqual ? '✓' : '✗'}。\n`
					+ `缓存：${value.cacheBytes} 字节的缓存交给**另一个 Node 进程**后，增量产物与干净全量**逐字节相同** ${value.cacheCrossProcessEqual ? '✓' : '✗'}（复用 ${value.cacheReuseCount} 个文件；该拒就拒 ${value.cacheRejects}/4）。\n`
					+ `codebase_self_index_json: ${JSON.stringify({ ok: value.ok, root: value.root, files: value.files, imports: value.imports, nodeCount: value.nodeCount, edgeCount: value.edgeCount, external: value.external, unresolved: value.unresolved, truncated: value.truncated, graphBytes: value.graphBytes, readBackNodeCount: value.readBackNodeCount, readBackEdgeCount: value.readBackEdgeCount, readBackSymbolNodes: value.readBackSymbolNodes, symbolCount: value.symbolCount, containsEdges: value.containsEdges, symbolFixtureOk: value.symbolFixtureOk, importSymbolEdges: value.importSymbolEdges, importSymbolsMissing: value.importSymbolsMissing, reused: value.reused, incrementalEqual: value.incrementalEqual, deltaFiles: value.deltaFiles, deltaReused: value.deltaReused, deltaEdgesBefore: value.deltaEdgesBefore, deltaEdgesAfter: value.deltaEdgesAfter, deltaEqual: value.deltaEqual, missReused: value.missReused, missObserved: value.missObserved, rescannedEqual: value.rescannedEqual, cacheBytes: value.cacheBytes, cacheCrossProcessEqual: value.cacheCrossProcessEqual, cacheReuseCount: value.cacheReuseCount, cacheRejects: value.cacheRejects, ms: value.ms })}`,
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const root = workspaceRootOf(config);
			if (!root) {
				throw new Error('未配置 workspaceRoot：Host 进程的 cwd 不是工作区，所以不猜要扫哪里（VsSaros 经 --patch 注入 config.workspaceRoot）。');
			}
			const requested = Number.isFinite(params?.maxFiles) ? Math.floor(params.maxFiles) : DEFAULT_MAX_FILES;
			const summary = summarizeSelfCheck(await selfCheck({ root, maxFiles: Math.min(5000, Math.max(50, requested)) }));
			// 自证**不通过就抛**：这是本工具的全部意义（"自己写的东西自己读不了"必须大声说出来，
			// 不能返回 ok:false 让人当噪声略过）。
			if (!summary.ok) {
				// 分项写进错误里（README 5.75）：只说"未通过"没用 ✓ —— 2026-10-12 为查"是哪一条"白跑了两轮 ✓。
				const why = summary.failed?.length ? summary.failed.join('；') : (summary.error ?? '读回比对不一致');
				throw new Error(`写侧自证未通过：${why}（files=${summary.files} 节点=${summary.nodeCount} 边=${summary.edgeCount}）`);
			}
			return flatSelfCheck(summary);
		},
	}, {
		// ★ P1（2026-10-12，方案 §5 P1）**影子索引 v0**：写进**我们自己的目录**
		// （默认 `<DSH_HOME>/codebase-index/<工作区哈希>/`，可由 `config.indexDir` 覆盖），
		// **绝不碰工作区里的 `.codebase-memory/`**（那是 IDE 的所有物 ✓）⇒ 与 IDE 索引器**结构上不可能双写** ✓。
		// ⚠ 2026-10-14 更正：以上是**缺省档 `shadow`** 的行为 ✓ —— **甲档**（`config.indexTarget='workspace'`，
		//   已拍板的所有权终态 ✓）**就是**写工作区目录 ✓；那时"不双写"靠的是 **IDE 见 `producer` 主动让路** ✓
		//   （契约常量 `DSH_ARTIFACT_PRODUCER`，见 IDE 侧 `codebaseIndexDefaults.ts` ✓）。
		// ⚠ 它的写语义与 `codebase_self_index` **不同档**（那个只写临时目录、秒级）⇒ 走审批闸 ✓（见 `WRITE_TOOLS`）。
		name: 'codebase_index',
		description: '（写·需审批）为当前工作区建/更新代码图谱。**落点由配置 `indexTarget` 决定**：缺省 `shadow` ⇒ 写 dsh 自己的索引目录（<DSH_HOME>/codebase-index/<工作区哈希>/，不动工作区的 `.codebase-memory/`）；`workspace` ⇒ 已交接的档位，直接写 `<工作区>/.codebase-memory/`（与 IDE 侧共用 `index.lock`，谁在跑另一个就等）。产物格式与 IDE 侧逐字同形，建好之后读图与页面就用这一份。解析口径由 `parser` 决定：`treesitter`（真解析：符号/行号准确 + CALLS/USAGE/INHERITS/IMPLEMENTS 边）或 `regex`（v0：文件级 import 图 + 顶层符号，只有 IMPORTS / CONTAINS）。默认增量（复用上次缓存只重解析变了的文件）。',
		parameters: {
			type: 'object',
			properties: {
				maxFiles: { type: 'integer', description: `最多扫多少源文件（默认 ${INDEX_MAX_FILES}，上限 ${INDEX_MAX_FILES_CAP}；达到上限会如实报 truncated）` },
				incremental: { type: 'boolean', description: 'true（默认）＝复用上次缓存只重解析变了的文件；false＝忽略缓存全量重解析' },
				fullRescan: { type: 'boolean', description: 'true＝强制忽略缓存全量重扫（`incremental:false` 的显式说法；连续增量太多次时本工具会**自己**兜底重扫并报 rescanned）' },
				parser: { type: 'string', description: "解析器：`regex`（快档，顶层声明的正则近似）或 `treesitter`（真解析：符号与起止行准确，并产出 CALLS / USAGE / INHERITS / IMPLEMENTS 四种符号间边；需要 tree-sitter 资产可用，覆盖扩展名见插件内的表）。缺省 `auto`：资产可用就真解析 ✓，不可用如实降级 ✓；⚠ 且**按上次实测规模**挑档（2026-10-14，O4 ✓）：文件数超 `config.autoTreesitterMaxFiles`（缺省 3,000 ✓）⇒ 走快档并**如实报为什么** ✓ —— 显式 `treesitter` 永远赢 ✓" },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, dir: { type: 'string' }, project: { type: 'string' }, parser: { type: 'string' },
					files: { type: 'integer' }, imports: { type: 'integer' }, nodes: { type: 'integer' }, edges: { type: 'integer' }, symbols: { type: 'integer' },
					reused: { type: 'integer' }, parsed: { type: 'integer' }, incrementalRuns: { type: 'integer' },
					truncated: { type: 'boolean' }, rescanned: { type: 'boolean' },
					graphBytes: { type: 'integer' }, cacheBytes: { type: 'integer' }, ms: { type: 'integer' },
					callEdges: { type: 'integer' }, usageEdges: { type: 'integer' }, inheritEdges: { type: 'integer' },
					unmatchedCalls: { type: 'integer' }, unmatchedUsages: { type: 'integer' }, unmatchedInherits: { type: 'integer' },
					extractErrors: { type: 'integer' }, skippedUnsupported: { type: 'integer' },
					cacheRejected: { type: 'string' }, cacheWarning: { type: 'string' },
					target: { type: 'string' },
					// ★ 甲档（2026-10-14）：交接档 + 保鲜没开 ⇒ 结果里**必须**带这两格（"建完就忘"是这条最大的风险 ✓）
					handoverWatchOff: { type: 'boolean' }, handoverWarning: { type: 'string' },
					// ★ O3 / O4（2026-10-14，用户拍板 ✓）：内容没变没落盘 ✓ / 规模挑档的"为什么" ✓
					graphUnchanged: { type: 'boolean' }, scaleCapped: { type: 'object' },
				},
				required: ['ok', 'dir', 'files', 'nodes', 'edges'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `${value.target === 'workspace' ? '工作区图谱已完成（已交接 ✓）' : '影子索引完成'}（解析档 ${value.parser ?? '?'}${value.degraded ? ' · ⚠ auto 已**如实降级**' : ''}）：${value.files} 个源文件 → ${value.nodes} 节点（文件 ＋ 符号 ${value.symbols}）/ ${value.edges} 条边（import ${value.imports}${value.parser === 'treesitter' ? ` · CALLS ${value.callEdges ?? 0} · USAGE ${value.usageEdges ?? 0} · INHERITS/IMPLEMENTS ${value.inheritEdges ?? 0}` : ''}）${value.truncated ? ' · **已达上限截断**（提高 maxFiles 或缩小范围）' : ''}，产物 ${bytesOf(value.graphBytes)} ${value.graphUnchanged ? '**与盘上逐字节相同 ⇒ 未重写** ✓（读侧零扰动 ✓）' : '写入'} ${value.dir}（${value.ms}ms${value.rescanned ? ' · 本轮为兜底全量重扫' : ''}）。${value.cacheRejected ? `\n⚠ 上一次的增量缓存被拒（如实报出，不影响本次）：${value.cacheRejected}` : ''}${value.cacheWarning ? `\n⚠ ${value.cacheWarning}` : ''}`
					+ `${value.parser === 'treesitter' && (value.skippedUnsupported || value.extractErrors || value.unmatchedCalls || value.unmatchedUsages || value.unmatchedInherits) ? `\n如实报差：未覆盖语言的文件 ${value.skippedUnsupported ?? 0} 个 · 解析失败 ${value.extractErrors ?? 0} 个 · 同名目标找不到（丢边）CALLS ${value.unmatchedCalls ?? 0} / USAGE ${value.unmatchedUsages ?? 0} / INHERITS ${value.unmatchedInherits ?? 0}` : ''}\n`
					+ `${value.handoverWarning ? `${value.handoverWarning}\n` : ''}`
					+ `读图用的就是这一份（页面诊断行会显示 graph-source=${value.target === 'workspace' ? 'workspace' : 'shadow'}）。\n`
					+ `codebase_index_json: ${JSON.stringify({ ok: value.ok, dir: value.dir, parserChoice: value.parserChoice, degraded: value.degraded, metaBytes: value.metaBytes, target: value.target ?? 'shadow', project: value.project, parser: value.parser ?? 'regex', files: value.files, imports: value.imports, nodes: value.nodes, edges: value.edges, symbols: value.symbols, callEdges: value.callEdges ?? null, usageEdges: value.usageEdges ?? null, inheritEdges: value.inheritEdges ?? null, unmatchedCalls: value.unmatchedCalls ?? null, unmatchedUsages: value.unmatchedUsages ?? null, unmatchedInherits: value.unmatchedInherits ?? null, extractErrors: value.extractErrors ?? null, skippedUnsupported: value.skippedUnsupported ?? null, reused: value.reused, parsed: value.parsed, incrementalRuns: value.incrementalRuns, truncated: value.truncated, rescanned: value.rescanned, graphBytes: value.graphBytes, cacheBytes: value.cacheBytes ?? null, cacheRejected: value.cacheRejected ?? null, cacheWarning: value.cacheWarning ?? null, handoverWatchOff: value.handoverWatchOff === true, handoverWarning: value.handoverWarning ?? null, graphUnchanged: value.graphUnchanged === true, scaleCapped: value.scaleCapped ?? null, ms: value.ms })}`,
			}],
		},
		// 拿锁 + 写盘 ⇒ **不是**并发安全（两个索引并排跑只会互相等锁 ✓）
		isConcurrencySafe: () => false,
		execute: async (params) => {
			const got = await runShadowIndex(config, {
				maxFiles: params?.maxFiles,
				incremental: params?.incremental !== false,
				fullRescan: params?.fullRescan === true,
				...(typeof params?.parser === 'string' && params.parser.trim() ? { parser: params.parser.trim() } : {}),
			});
			if (!got.ok) {
				// 四种失败各有各的下一步：没配工作区 / 没配索引目录 / 别的写者正在跑 / 要真解析但没有资产 ⇒ 全部如实抛出 ✓
				throw new Error(`影子索引没跑起来（${got.kind}）：${got.why}`);
			}
			return {
				ok: true,
				dir: got.dir,
				target: got.target ?? 'shadow',
				project: got.project,
				parser: got.parser,
				files: got.stats.files,
				imports: got.stats.imports,
				nodes: got.manifest.node_count,
				edges: got.manifest.edge_count,
				symbols: got.stats.symbolNodes,
				// P2 的真解析统计（regex 模式下这四条**不出现** ⇒ 工具的 JSON 行保持干净 ✓）
				...(got.parser === 'treesitter' ? {
					callEdges: got.stats.callEdges,
					usageEdges: got.stats.usageEdges,
					inheritEdges: got.stats.inheritEdges,
					unmatchedCalls: got.stats.unmatchedCalls,
					unmatchedUsages: got.stats.unmatchedUsages,
					unmatchedInherits: got.stats.unmatchedInherits,
					extractErrors: got.stats.extractErrors,
					skippedUnsupported: got.stats.skippedUnsupported,
				} : {}),
				reused: got.stats.reused,
				parsed: got.stats.parsed,
				incrementalRuns: got.stats.incrementalRuns,
				truncated: got.stats.truncated,
				rescanned: got.rescanned,
				graphBytes: got.graphBytes,
				...(got.cacheBytes !== undefined ? { cacheBytes: got.cacheBytes } : {}),
				// ⚠ 这两条**必须透出去**（"缓存被拒但照常产出"是本模块刻意选的行为 ⇒ 不能只写在函数返回里 ✓）
				...(got.cacheRejected ? { cacheRejected: got.cacheRejected } : {}),
				...(got.cacheWarning ? { cacheWarning: got.cacheWarning } : {}),
				ms: got.ms,
				// ★ 甲档·所有权交接（2026-10-14）：交接档 + **保鲜没开** ⇒ **没有人会自动更新这份图** ✗
				//   （IDE 已被挡住 ✓、我们也不会自动跑 ✓）⇒ 必须出现在**结果**里（批准理由说一次、结果再说一次：
				//   这条太容易"建完就忘" ✓）。
				...(got.target === 'workspace' && config?.indexWatch !== true ? {
					handoverWatchOff: true,
					handoverWarning: '⚠ 已交接给 dsh：IDE **不再索引**这个工作区 ✓，而 `config.indexWatch` 也不是 true'
						+ ' ⇒ **这份图不会自动更新**（只有手动跑 codebase_index 才会）✗。要么开 `indexWatch`，要么把"定期手动索引"当成制度 ✓。'
						+ ' 开法（O1 ✓）——覆盖层的 `vssaros-codebase:` 下加一行：`indexWatch: true` ✓',
				} : {}),
				// ★ O4 / O3（2026-10-14）：规模挑档的"为什么" ✓ 与"图没变 ⇒ 没落盘" ✓ 都要透出去（"建了一次索引"
				//   与"写出了一份**新的**图"是两件事 ✓ —— 不许用同一个回执糊过去 ✗）
				...(got.scaleCapped ? { scaleCapped: got.scaleCapped } : {}),
				...(got.graphUnchanged === true ? { graphUnchanged: true } : {}),
			};
		},
	}, {
		// 只读状态：**"为什么不能索引 / 上次索引成没成"要能被问出来** ✓（不然只有一句"失败"）
		name: 'codebase_index_status',
		description: '查看影子索引的现状：产物落点与凭什么（config.indexDir / DSH_HOME）、有没有产物与多大、清单内容、锁（谁在跑 / 是不是崩溃残留）、增量缓存，以及"读图现在会走影子还是 IDE 产物"。只读，不写任何东西。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, workspaceRoot: { type: 'string' }, dir: { type: 'string' }, placement: { type: 'string' },
					// 决策 3：写到哪一档（`shadow` = 我们自己的根；`workspace` = 已交接的 `<ws>/.codebase-memory/` ✓）
					target: { type: 'string' }, orphanShadowSavedAt: { type: 'integer' },
					readable: { type: 'boolean' }, project: { type: 'string' }, nodeCount: { type: 'integer' }, edgeCount: { type: 'integer' },
					graphBytes: { type: 'integer' }, graphMtimeMs: { type: 'integer' },
					// P3-b/P4 的新增面：**读图实际走哪一份** + 影子被顶掉的实情 + 保鲜 watcher 的现状 ✓
					effectiveSource: { type: 'string' }, effectiveDir: { type: 'string' },
					effectiveSavedAt: { type: 'integer' }, effectiveAgeMs: { type: 'integer' }, staleShadowAgeMs: { type: 'integer' },
					// ★ 甲档·所有权交接（2026-10-14）：① "这份图有多旧"的**判决** ✓ ② 交接档下"保鲜没开"的告警 ✓
					//   ③ 当前档 shadow 但工作区里还留着一份**我们产的**产物 ⇒ **两边都不索引**的探测器 ✓
					effectiveStale: { type: 'boolean' }, staleAfterMs: { type: 'integer' },
					handoverWatchOff: { type: 'boolean' }, handoverAlert: { type: 'string' },
					graphMetaHistory: { type: 'array' },
					orphanWorkspaceDir: { type: 'string' }, orphanWorkspaceSavedAt: { type: 'integer' }, orphanWorkspaceRisk: { type: 'string' },
					watchActive: { type: 'boolean' }, watchMode: { type: 'string' }, watchRuns: { type: 'integer' },
					watchPending: { type: 'boolean' }, watchWhy: { type: 'string' },
					lockHeld: { type: 'boolean' }, lockHolder: { type: 'string' }, lockAgeMs: { type: 'integer' }, lockStale: { type: 'boolean' },
					cacheFiles: { type: 'integer' }, cacheSavedAt: { type: 'integer' }, manifestError: { type: 'string' },
				},
				required: ['ok', 'dir', 'readable'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `${value.target === 'workspace' ? '代码索引（**已交接**：写工作区目录）' : '影子索引'}：${value.readable ? '**有产物**' : '还没有产物'} · **读图走 ${value.effectiveSource ?? '?'}**${value.effectiveAgeMs !== undefined ? `（这份图 ${ageOf(value.effectiveAgeMs)}前）` : ''} · 目录 ${value.dir}\n`
					+ `${value.target === 'workspace' && value.orphanShadowSavedAt !== undefined ? `⚠ 影子里还留着一份旧产物（${isoOf(value.orphanShadowSavedAt)}）—— 交接后它**不再被读**（要清可以手工删 ✓）\n` : ''}`
					+ `${value.staleShadowAgeMs !== undefined ? `⚠ 影子比 IDE 的图旧 ${ageOf(value.staleShadowAgeMs)} ⇒ 已让位给 IDE（重跑 codebase_index 即可让影子重新接管 ✓）\n` : ''}`
					+ `${value.orphanWorkspaceRisk ? `⚠ 工作区里还留着一份**我们产的**产物（${isoOf(value.orphanWorkspaceSavedAt)}）⇒ **IDE 继续让路、dsh 又不写它** = 两边都不索引 ✗✗；改配置**解决不了**（权限凭据是那份清单 ✓）⇒ 用 codebase_delete_project 的 which="workspace"（或 "both"）删掉它 ✓\n` : ''}`
					+ `落点 ${value.target ?? 'shadow'}（依据 ${value.placement}） · 项目 ${value.project ?? '(未知)'} · ${value.nodeCount ?? '?'} 节点 / ${value.edgeCount ?? '?'} 边 · 图 ${bytesOf(value.graphBytes)}\n`
					+ `保鲜：${value.watchActive ? `监听中（mode=${value.watchMode ?? '?'}，已跑 ${value.watchRuns ?? 0} 轮${value.watchPending ? ' · 有待处理变更' : ''}）` : `未启用（${value.watchWhy ?? '未说明'}）`}\n`
					+ `${value.handoverAlert ? `交接：${value.handoverAlert}\n` : ''}`
					+ `${value.effectiveStale ? `⚠ 这份图已经 ${ageOf(value.effectiveAgeMs)} 没更新（判决阈值 ${ageOf(value.staleAfterMs)}）⇒ 检索可能在用旧事实回答${value.target === 'workspace' ? '（甲档：**没人会自动更新它** ✗ ⇒ 开 indexWatch 或定期手动索引 ✓）' : ''}\n` : ''}`
					+ `锁：${value.lockHeld ? `被 ${value.lockHolder ?? '未知'} 持有${value.lockAgeMs !== undefined ? `（${Math.round(value.lockAgeMs / 1000)}s 前）` : ''}${value.lockStale ? ' ⚠ 已超时 ⇒ 下次索引会接管' : ''}` : '空闲'}`
					+ ` · 增量缓存：${value.cacheFiles !== undefined ? `${value.cacheFiles} 个文件（${isoOf(value.cacheSavedAt)}）` : '无'}`
					+ `${value.manifestError ? ` · ⚠ 清单错误：${value.manifestError}` : ''}\n`
					+ `codebase_index_status_json: ${JSON.stringify({ ok: value.ok, workspaceRoot: value.workspaceRoot, dir: value.dir, graphParser: value.graphParser, graphParserWhy: value.graphParserWhy, graphParserDegraded: value.graphParserDegraded, graphMetaMs: value.graphMetaMs, graphMetaIncremental: value.graphMetaIncremental, target: value.target ?? null, placement: value.placement, readable: value.readable, effectiveSource: value.effectiveSource ?? null, effectiveDir: value.effectiveDir ?? null, effectiveSavedAt: value.effectiveSavedAt ?? null, effectiveAgeMs: value.effectiveAgeMs ?? null, staleShadowAgeMs: value.staleShadowAgeMs ?? null, effectiveStale: value.effectiveStale === true, staleAfterMs: value.staleAfterMs ?? null, handoverWatchOff: value.handoverWatchOff === true, handoverAlert: value.handoverAlert ?? null, orphanWorkspaceDir: value.orphanWorkspaceDir ?? null, orphanWorkspaceSavedAt: value.orphanWorkspaceSavedAt ?? null, watchActive: value.watchActive === true, watchMode: value.watchMode ?? null, watchRuns: value.watchRuns ?? null, watchPending: value.watchPending === true, watchWhy: value.watchWhy ?? null, project: value.project ?? null, nodeCount: value.nodeCount ?? null, edgeCount: value.edgeCount ?? null, graphBytes: value.graphBytes ?? null, graphMtimeMs: value.graphMtimeMs ?? null, lockHeld: value.lockHeld === true, lockHolder: value.lockHolder ?? null, lockAgeMs: value.lockAgeMs ?? null, lockStale: value.lockStale === true, cacheFiles: value.cacheFiles ?? null, cacheSavedAt: value.cacheSavedAt ?? null, manifestError: value.manifestError ?? null })}`,
			}],
		},
		isConcurrencySafe: () => true,
		execute: async () => {
			const status = await shadowStatus(config);
			if (!status.ok) {
				throw new Error(`读不到索引状态（${status.kind}）：${status.why}`);
			}
			const watch = typeof state.watchStateOf === 'function' ? state.watchStateOf() : { active: false, why: '未探测' };
			return {
				ok: true,
				workspaceRoot: status.workspaceRoot,
				dir: status.dir,
				// ★ 决策 3：落点档位是状态必答的一格（"我以为在写工作区"与"其实还在写影子"是两件事 ✓）
				target: status.target ?? 'shadow',
				placement: status.placement,
				readable: status.readable,
				...(status.orphanShadow?.savedAt !== undefined ? { orphanShadowSavedAt: status.orphanShadow.savedAt } : {}),
				// P3-b/P4：**读图实际走哪一份** + 影子被顶掉的实情 + 保鲜现状 ✓
				...(status.effectiveSource ? {
					effectiveSource: status.effectiveSource,
					effectiveDir: status.effectiveDir,
					...(status.effectiveSavedAt !== undefined ? { effectiveSavedAt: status.effectiveSavedAt, effectiveAgeMs: status.effectiveAgeMs } : {}),
					...(status.staleShadow ? { staleShadowAgeMs: status.staleShadow.ageMs } : {}),
					...(status.effectiveStale !== undefined ? { effectiveStale: status.effectiveStale, staleAfterMs: status.staleAfterMs } : {}),
					// ★ O2（2026-10-14）：最近几次建图（新→旧 ✓）—— "优化有没有用"从此有数 ✓
					...(status.graphMetaHistory ? { graphMetaHistory: status.graphMetaHistory } : {}),
				} : {}),
				// ★ 甲档·所有权交接（2026-10-14）：交接档下 **IDE 不再索引** ⇒ 图会不会变新**只**看有没有人跑
				//   `codebase_index` 或开没开 `config.indexWatch` ✓ ⇒ "保鲜没开"必须能**被问出来**（页面与工具共用这一份判断 ✓）。
				...(status.target === 'workspace' ? {
					handoverWatchOff: watch.active !== true,
					handoverAlert: watch.active === true
						? `已交接给 dsh（IDE 不再索引 ✓）；保鲜已开（监听中）⇒ 图会跟着改动更新 ✓`
						: `⚠ 已交接给 dsh（IDE **不再索引** ✓）但**保鲜没开**（\`config.indexWatch\` 不是 true）⇒ 只有手动跑 codebase_index 才更新，**图会静默变旧** ✗；要么开 indexWatch，要么定期手动索引 ✓（开法 ✓：覆盖层的 \`vssaros-codebase:\` 下加一行 \`indexWatch: true\`）`,
				} : {}),
				// ★ 甲档的"双输"探测器：当前档 shadow、而工作区里那份清单**是我们的** ⇒ IDE 继续让路、dsh 又不写它 ✗✗
				...(status.orphanWorkspace ? {
					orphanWorkspaceDir: status.orphanWorkspace.dir,
					...(status.orphanWorkspace.savedAt !== undefined ? { orphanWorkspaceSavedAt: status.orphanWorkspace.savedAt } : {}),
					orphanWorkspaceRisk: status.orphanWorkspace.risk,
				} : {}),
				watchActive: watch.active === true,
				...(watch.mode ? { watchMode: watch.mode } : {}),
				...(watch.runs !== undefined ? { watchRuns: watch.runs } : {}),
				...(watch.pendingSince !== undefined ? { watchPending: true } : {}),
				...(watch.why ? { watchWhy: watch.why } : {}),
				...(status.manifest ? { project: status.manifest.project, nodeCount: status.manifest.nodeCount, edgeCount: status.manifest.edgeCount } : {}),
				...(status.graphBytes !== undefined ? { graphBytes: status.graphBytes, graphMtimeMs: status.graphMtimeMs } : {}),
				lockHeld: status.lock.held === true,
				...(status.lock.holder?.token ? { lockHolder: status.lock.holder.token } : {}),
				...(status.lock.ageMs !== undefined ? { lockAgeMs: status.lock.ageMs } : {}),
				...(status.lock.stale !== undefined ? { lockStale: status.lock.stale } : {}),
				...(status.cache?.files !== undefined ? { cacheFiles: status.cache.files } : {}),
				...(status.cache?.savedAt !== undefined ? { cacheSavedAt: status.cache.savedAt } : {}),
				...(status.manifestError ? { manifestError: status.manifestError } : {}),
			};
		},
	}];
}

export function apply(ctx, config = {}) {
	// 重构 1.3：绑定 foundation 共享服务（dataRoot/dshHome/pageShell/lock 的真源）。
	{
		// 同步直读在前：有插件在 apply 的**同步段**就建 store（inject 回调是异步的，会来不及 ✗）。
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针的 Proxy 假 ctx 对未知属性抛错 ⇒ 当不存在 */ }
		if (ready) { bindFoundation(ready); }
		ctx.inject(['vssarosFoundation'], child => {
		let svc = null;
		try { svc = child.vssarosFoundation ?? null; } catch { /* 探针的假 ctx（Proxy）对未知属性抛错 ⇒ 当不存在 */ }
		if (svc) { bindFoundation(svc); }
	});
	}
	// ── R13（preset plane）：同一个包会被挂**两次** ────────────────────────────────────────────
	// host plane 一行（`cordis.patch.yml`）+ 我们的 preset 里一行（`vssaros-agents/cordis.presets.yml`）✓。
	// 两次挂载要做**不同的事**，否则同一件事做两遍（工具重名是**静默顶掉** ✓，实测不报错 ✗ 所以更危险）。
	//   · `hostHalf: true` ⇒ 这一次只注册页面/服务，**不注册工具**（工具交给 preset 里那次 ✓）；
	//   · 缺省（不写）⇒ **与从前完全一样**（页面 + 工具都注册 ✓）⇒ 加这个闸本身**零行为改变** ✓。
	// 为什么只分"工具"这半边：preset 作用域里没有 `webServer`/`connection`（那是 host 服务 ✗）⇒
	// 页面侧不会被重复注册 ✓（2026-10-12 双挂载实测：stderr 无任何路由冲突 ✓）。
	const hostHalf = config.hostHalf === true;
	// `parser`：P0 的解析器门面。**惰性**创建（`apply` 期不建线程、不读 wasm ✓ —— 装在没资产的环境里
	// 也必须能正常 apply，否则整个插件的工具会一起失效 ✗，这是本仓反复踩过的"静态 inject 太宽"同型教训）。
	const state = { tools: null, parser: null, watch: null, watchWhy: undefined };
	function parserPoolOf() {
		if (!state.parser) {
			state.parser = createParserPool(config);
		}
		return state.parser;
	}
	/** 页面与状态工具共用的**保鲜状态**摘要（没启用时也要说清"为什么没启用" ✓）。 */
	function watchStateOf() {
		return state.watch ? watchSummaryOf(state.watch) : { active: false, why: state.watchWhy ?? '未启用（`config.indexWatch` 不是 true）' };
	}
	// ⚠ `toolDefinitions` 是**模块级**函数（不在 apply 的词法作用域里 ✗）⇒ 这个取值器要挂在 `state` 上 ✓
	//（挂 state 而不是新增参数：屏`state` 本来就是"apply 与工具共享的活状态" ✓）
	state.watchStateOf = watchStateOf;
	// 卸载时把解析线程收掉（`worker_threads` 不会跟着插件一起消失 ✗）
	ctx.effect(() => () => {
		const pool = state.parser;
		state.parser = null;
		Promise.resolve(pool?.dispose?.()).catch(() => { /* 卸载期的失败不值得打扰用户 ✓ */ });
	});
	// ★ P4：**影子保鲜**（缺省关 ✓）。三条前置不满足时**不静默**：把原因写进 `watchWhy`，页面/状态工具照实说 ✓。
	// 为什么不放在 `apply` 里直接 `fs.watch`：常驻监听是资源 + 会让"装上来就动盘"发生 ⇒ 必须**显式**开 ✓
	//（与 `indexWatch` 这个开关同名同义：VsSaros 想开就在覆盖层里写 `indexWatch: true` ✓）。
	ctx.effect(() => {
		if (config.indexWatch !== true) {
			state.watchWhy = '未启用（`config.indexWatch` 不是 true）';
			return undefined;
		}
		// ★ 2026-10-17：根从"**apply 时读一次**"改成"每次重算时读"（`workspaceRootOf` 内部是
		//   运行期上下文优先 ✓）—— 切工作区后要换监听目标，而**不再靠重启 Host** ✓（见 foundation 的
		//   workspaceContext.js）。apply 期上下文通常还没推（Host 先起、IDE 后连）⇒ 那时照旧取
		//   `config.workspaceRoot`（覆盖层那份），与从前逐字相同 ✓。
		let current;   // { root, watcher }
		const stopCurrent = () => {
			current?.watcher.stop();
			current = undefined;
			state.watch = null;
		};
		const start = () => {
			stopCurrent();
			const root = workspaceRootOf(config);
			if (!root) {
				state.watchWhy = '未配置 workspaceRoot ⇒ 不知道盯哪个目录';
				return;
			}
			if (!shadowDirOf(config, root)) {
				state.watchWhy = '未配置索引目录（`config.indexDir` 与 `DSH_HOME` 都没有）⇒ 重算了也没地方放';
				return;
			}
			const watcher = createShadowWatcher(config, {
				root,
				run: () => runShadowIndex(config, { root }),
				onLog: message => { try { ctx.logger?.info?.(message); } catch { /* 日志不可用无所谓 ✓ */ } },
			});
			watcher.start();
			current = { root, watcher };
			state.watch = watcher;
			state.watchWhy = undefined;
		};
		start();
		// 运行期工作区上下文变了 ⇒ 根可能也变了 ⇒ 换监听目标（根没变就不动，避免白重启监听 ✓）。
		// ⚠ try 包住：`foundation()` 未绑定时**故意抛错**（fail-fast）—— 而这里只是"订阅一个可选通知"，
		//   不该因为共享服务缺席就让整个插件 activation 失败 ✗。
		let off;
		try {
			off = foundation().onDidChangeWorkspaceContext?.(() => {
				if (workspaceRootOf(config) !== current?.root) {
					start();
				}
			});
		} catch { /* 没有 foundation ⇒ 保持 apply 时那个根（与这条能力不存在时一致 ✓） */ }
		return () => {
			try { off?.(); } catch { /* 退订失败不值得打扰用户 ✓ */ }
			stopCurrent();
		};
	});

	ctx.effect(() => {
		if (hostHalf) { return undefined; }
		const disposers = toolDefinitions(ctx, state, config).map(definition => ctx.tools.register(definition));
		state.tools = ctx.tools;
		return () => {
			state.tools = null;
			for (const dispose of disposers) {
				dispose();
			}
		};
	});

	// ★ P1 的**审批闸**（官方派发前决策钩子 `tools/pre-execute` ✓，与 kanban / workflow / kb / memory / skills
	// **同一把** ✓）：返回 `{ kind: 'ask' }` ＝ 先问用户 ✓；没有审批支持的部署 ⇒ 官方语义是 **degrade to deny** ✓。
	// ⚠ 写成**独立的 effect**（与 `vssaros-memory` 同形 ✓）：`ctx.effect` 认得 `ctx.on` 返回的 disposer ⇒
	//   卸载时自动摘掉 ✓。别自己 `const off = ctx.on(...)` 再在别处的 disposer 里 `off()` ✗ ——
	//   假 ctx（探针里的）`on` 可能返回 undefined ⇒ 一卸载就抛 ✓（本仓"假 ctx 也算两边之一"的教训 ✓）。
	// ⚠ 判据只用**工具名**：`codebase_index` 无论带什么参数都要问 ✓（"这次只扫 50 个文件"不该绕过闸 ✗）。
	// ⚠ 参数在 **`exec.arguments`**（不是 `args`）—— 官方 `ToolExecutionInput.arguments`，且钩子在 materialize
	//   之后跑 ✓（本仓已有一次"两边一起用错名 ⇒ 互相掩护"的教训 ✓，p3-40 用真事件钉住字段名 ✓）。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		// ⚠ `manage_adr` 的**只读动作**（list / get）不问 ✓ —— 例外的理由与它为何不违反"只按工具名"见 `ADR_READ_ACTIONS` ✓。
		//   必须放在下面那条"只按工具名放行"**之前** ✗（放后面就等于没放 ✓）。
		if (exec?.name === 'codebase_manage_adr' && ADR_READ_ACTIONS.includes(String(exec.arguments?.action ?? ''))) {
			return next();
		}
		if (!exec || !WRITE_TOOLS.includes(exec.name)) {
			return next(); // 只读工具（overview / search / … / index_status）⇒ 默认放行 ✓
		}
		const args = /** @type {{maxFiles?: unknown, incremental?: unknown, fullRescan?: unknown, force?: unknown, toDir?: unknown, fromDir?: unknown, which?: unknown, action?: unknown, id?: unknown, title?: unknown}} */ (exec.arguments ?? {});
		const root = workspaceRootOf(config);
		// ADR 的写动作：理由要**点名动作与 id** ✓（"某个工具想改点东西"不是可批准的对象 ✗）。
		if (exec.name === 'codebase_manage_adr') {
			const action = String(args.action ?? '(未给)');
			const label = action === 'create' ? '新建' : action === 'update' ? '改写' : '删除';
			const aimed = action === 'create' ? `「${String(args.title ?? '(未给 title)')}」` : ` id=${String(args.id ?? '(未给)')}`;
			return {
				kind: 'ask',
				reason: `${exec.name}：**${label}** 一条 ADR（${action}${aimed}）—— 落在工作区内的 \`.codebase-memory/adr/\`（ADR 是**仓库内容** ⇒ 会跟着 git 走 ✓；删了也要在 git 里提交 ✓）`,
				displayReason: { en: `Allow ${exec.name} to ${action} an ADR file inside the workspace?`, zh: `允许 ${exec.name} ${label}一条 ADR（工作区文件）？` },
			};
		}
		// 导出/导入：**两条不同的后果**，理由必须分开说 ✓（导出=只写一个目录；导入=**覆盖**现有产物 ✗）。
		if (exec.name === 'codebase_export_artifact' || exec.name === 'codebase_import_artifact') {
			const isImport = exec.name === 'codebase_import_artifact';
			const aimed = String((isImport ? args.fromDir : args.toDir) ?? '(未给)');
			return {
				kind: 'ask',
				reason: isImport
					? `${exec.name}：把工作区内的 \`${aimed}\` 装成本工作区的索引 —— **会覆盖现有产物，不可撤销**（装之前先验证清单与图谱，不合格就不落盘 ✓）`
					: `${exec.name}：把**当前正在查的**图谱产物复制到工作区内的 \`${aimed}\`（只写这一个目录 ✓）`,
				displayReason: {
					en: isImport ? `Allow ${exec.name} to import an artifact over this workspace's index? (overwrites)` : `Allow ${exec.name} to copy this workspace's graph artifact into the workspace?`,
					zh: isImport ? `允许 ${exec.name} 用外来产物**覆盖**当前工作区的索引？` : `允许 ${exec.name} 把当前图谱产物导出到工作区内？`,
				},
			};
		}
		// ⚠ 审批理由必须**按工具名分岔** ✗✗：删除工具若沿用"建/更新图谱"的理由，用户批准的就是一件
		//   他**没被问过**的事（"批准的是具体变更，不是某个工具想干点什么" ✗）。删除的理由必须点名**哪个目录** ✓。
		if (exec.name === 'codebase_delete_project') {
			const which = DELETE_WHICH_VALUES.includes(args.which) ? args.which : 'current';
			const planned = root ? writeDirOf(config, root) : undefined;
			const shadowPlanned = root ? shadowDirOf(config, root) : undefined;
			const wsDir = root ? workspaceArtifactDirOf(root) : undefined;
			// ⚠ 用户批准的必须是**将被删的那几个目录** ✗ —— `which` 一变，被删的就变了 ⇒ 逐处列名（不许写个笼统的"索引产物" ✓）
			const named = (which === 'both'
				? [shadowPlanned?.error ? undefined : shadowPlanned?.dir, wsDir]
				: which === 'workspace' ? [wsDir]
					: which === 'shadow' ? [shadowPlanned?.error ? undefined : shadowPlanned?.dir]
						: [planned?.error ? undefined : planned?.dir]).filter(Boolean);
			const where = !root
				? '删除本工作区的索引产物（未配置 workspaceRoot ⇒ 算不出落点 ✗）'
				: named.length === 0
					? `删除本工作区的索引产物（落点算不出来：${planned?.error ?? shadowPlanned?.error ?? '未知'} ✗）`
					: `**删除 ${named.join(' 与 ')}**（which=${which}${which === 'current' && planned && !planned.error ? `，target=${planned.target}` : ''}）`;
			const isRollback = which === 'workspace' || which === 'both';
			return {
				kind: 'ask',
				reason: `${exec.name}：${where} —— 本工作区的索引产物，**不可撤销**；删完读侧退回读 IDE 的 \`.codebase-memory/\`，要重建再跑 codebase_index`
					+ `${isRollback ? '；⚠ 这是**把索引权限还给 IDE** 的动作（权限凭据是工作区清单里的 `producer` ⇒ 清单删掉后 IDE 才会重新接管 ✓）' : ''}`
					+ `${args.force === true ? '；⚠ 本次带 force：即使有人正持索引锁也会强删' : ''}`,
				displayReason: {
					en: `Allow ${exec.name} to DELETE ${isRollback ? 'the WORKSPACE index artifact (hands indexing back to the IDE)' : "this workspace's index artifacts"}? (irreversible)`,
					zh: `允许 ${exec.name} 删除${isRollback ? '**工作区里的**索引产物（把索引权限还给 IDE）' : '当前工作区的索引产物'}？（不可撤销）`,
				},
			};
		}
		const mode = args.fullRescan === true || args.incremental === false ? '全量重解析' : '增量（复用缓存）';
		// ★ P7：批准的是**具体变更** ⇒ 档位必须写进理由 ✓（缺省 `auto` 会挑档：资产可用 = 真解析，
		//   更慢也更准 ✓ —— 用户批的应该是"真解析那一次"，不是"某个工具想干点活" ✗）。
		const askedParser = String(args.parser ?? config?.parser ?? 'auto').trim().toLowerCase();
		const tier = askedParser === 'auto'
			? (describeParser(config).available ? 'auto ⇒ **真解析**（本机资产可用 ✓）' : 'auto ⇒ 快档（本机没有 tree-sitter 资产 ⇒ 如实降级 ✓）')
			: `显式 ${askedParser}`;
		// `reason` 按官方契约就是**被审计的审批理由**（随 `approval/asked` 进会话日志 ✓）⇒ 载荷必须说清
		// "批准的是什么"：扫哪个工作区、什么模式、上限多少 ✓（批准的是具体变更，不是"某个工具想干点什么"✗）。
		// ★ 2026-10-14（甲档）：理由必须**跟着落点变** ✗✗ —— 原先这里写死了"建**影子**代码图谱…产物只写进
		//   dsh 自己的索引目录，**不触碰工作区里的 `.codebase-memory/`**" ⇒ 在**交接档**里这两句**全是假的** ✓
		//   （交接档写的**正是**工作区目录 ✓）。批准理由撒谎比没有理由更坏 ✗（用户以为没动工作区，其实动了 ✓）。
		const planned = root ? writeDirOf(config, root) : undefined;
		const placedNow = planned && !planned.error ? planned : undefined;
		const isHandover = placedNow?.target === 'workspace';
		const where = !placedNow
			? `（落点算不出来：${String(planned?.error ?? '未配置 workspaceRoot')} ✗）`
			: isHandover
				? `**更新工作区里的**代码图谱（${placedNow.dir} —— 已交接档：这份图归 dsh 负责 ✓）`
				: `建**影子**代码图谱（产物只写 ${placedNow.dir}，**不触碰**工作区里的 .codebase-memory/ ✓）`;
		// ★ 甲档的软肋必须在这里说（这是用户**唯一必看**的时刻 ✓）：交接档 + 保鲜没开 ⇒ 建完之后**没人会自动更新它** ✗
		const watchOff = isHandover && config?.indexWatch !== true;
		const reason = `${exec.name}：为 ${root ?? '(未配置 workspaceRoot)'} ${where}（${mode}，上限 ${Number.isFinite(Number(args.maxFiles)) ? Math.floor(Number(args.maxFiles)) : INDEX_MAX_FILES} 个文件）`
			+ `；解析档：${tier}`
			+ (watchOff
				? '；⚠ **交接档 + 保鲜没开**（`config.indexWatch` 不是 true）⇒ 这次建完之后 **IDE 不索引、dsh 也不自动索引** ⇒ 图会**静默变旧** ✗'
					+ '（O1 ✓ 开法——覆盖层的 `vssaros-codebase:` 下加一行：`indexWatch: true` ✓）'
				: '');
		return {
			kind: 'ask',
			reason,
			displayReason: isHandover
				? { en: `Allow ${exec.name} to UPDATE the workspace's code graph? (dsh owns it; the IDE has yielded)`, zh: `允许 ${exec.name} **更新工作区里的**代码图谱？（已交接：IDE 已让路 ✓）` }
				: { en: `Allow ${exec.name} to build/refresh this workspace's shadow code graph?`, zh: `允许 ${exec.name} 为当前工作区建/更新影子代码图谱？` },
		};
	}));

	// 反向通道（**可选**依赖）：页面上的「在编辑器打开」经它请求 IDE 的 openFile 能力（白名单里早有、
	// 执行端也早已实现 ⇒ 本插件只要**声明**它即可，零 src 改动）。
	// ★ 2026-10-14 修正（与 workflow / kanban 同一处根因）：原先 `const found = ctx.vssarosBridge`
	//   包 try/catch —— 那句**恒抛** ✗（cordis 的 context 代理对未在 `inject` 里声明的服务一律抛
	//   `cannot get property "vssarosBridge" without inject`，见 `@deepseek-ai/cordis/src/reflect.ts`）
	//   ⇒ 被 catch 吞掉后恒为 undefined ⇒ 「在编辑器打开」永远回 503「控制桥不可用」✗。
	//   ⇒ 改用 `ctx.inject(['vssarosBridge'], …)` **动态声明**（桥不在时不会让插件 pending ✓，
	//   与下面 webServer / connection 同一姿势），并在 scope 里读 ✓（盖章真身份仍生效 ✓）。
	let bridge;
	ctx.inject(['vssarosBridge'], scope => {
		bridge = scope.vssarosBridge;
		return () => { bridge = undefined; };
	});
	function bridgeOf() {
		return bridge && typeof bridge.callIDE === 'function' ? bridge : undefined;
	}

	// 页面路由（**可选**依赖）：`webServer` / `connection` 只在 web 模板里存在（见静态 `inject` 的注释）。
	// 不在 web 模板 ⇒ 只是**没有页面** ✓，工具照常可用 ✓。
	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			try {
				const url = new URL(req.url ?? '/', 'http://127.0.0.1');
				if (url.pathname === `${ROUTE_PREFIX}/api/open`) {
					// 「在编辑器打开」：只经反向通道请求 IDE 能力 openFile（**已实现**的能力：工作区校验、
					// 存在性检查、默认不抢焦点都由执行端负责）。没有桥 / 没有 IDE 时给可读错误，不静默成功。
					const path = (url.searchParams.get('path') ?? '').trim();
					if (!path) {
						res.writeHead(400, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: 'path 必填（图谱节点上的 filePath）' }));
						return;
					}
					const line = Number(url.searchParams.get('line'));
					const activeBridge = bridgeOf();
					if (!activeBridge || typeof activeBridge.callIDE !== 'function') {
						res.writeHead(503, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: '控制桥不可用（@vssaros/dsh-bridge 未加载或版本过旧）：打开文件需要反向通道（协议 v2）' }));
						return;
					}
					try {
						const reply = await activeBridge.callIDE('ide.request', {
							capability: 'openFile',
							pluginId: PLUGIN_ID,
							params: { path, ...(Number.isFinite(line) && line > 0 ? { startLine: line } : {}) },
						}, { timeoutMs: OPEN_TIMEOUT_MS });
						res.writeHead(200, JSON_HEADERS);
						res.end(JSON.stringify({ ok: true, reply: reply ?? null }));
					} catch (e) {
						// 主进程拒绝（未声明能力 / 插件未装 / 无 IDE 在监听）与执行端报错（不在工作区 / 文件不存在）
						// 都走这里，文案原样带出去——这是用户唯一能看到的线索。
						res.writeHead(502, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
					}
					return;
				}
				if (url.pathname === `${ROUTE_PREFIX}/api/self-index`) {
					// 写侧前提自证（README 5.53）的 HTTP 面：探针/页面要能对**真工作区**跑一次
					// —— 只在进程内对种子工作区跑证明不了"真扫得动"（那个种子没有源码 ⇒ 0 文件）。
					const root = workspaceRootOf(config);
					if (!root) {
						res.writeHead(503, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: '未配置 workspaceRoot（Host 的 cwd 不是工作区；VsSaros 经 --patch 注入）' }));
						return;
					}
					const requested = Number(url.searchParams.get('maxFiles'));
					const maxFiles = Math.min(5000, Math.max(50, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_MAX_FILES));
					// 回执形状与工具**共用** `flatSelfCheck`：第一版这里原样回嵌套对象 ⇒ 探针按工具的形状读
					// 就拿到 undefined ✗（p3-11 抓到的"同一件事两种形状"）。一处定义、两处使用 ✓。
					const flat = flatSelfCheck(summarizeSelfCheck(await selfCheck({ root, maxFiles })));
					res.writeHead(flat.ok ? 200 : 500, JSON_HEADERS);
					res.end(JSON.stringify(flat));
					return;
				}
				if (url.pathname === `${ROUTE_PREFIX}/api/parse-proof`) {
					// ★ P0 自证的 HTTP 面：**真起 worker、真喂 wasm、真拿回 AST 事实** ✓。
					// 为什么要有它（而不是只靠进程内探针）：探针跑在它自己的 Node 里，**证明不了 dsh Host 进程里也行** ✗ ——
					// 而"Host 能不能承载解析"正是方案里 P0 唯一要回答的问题 ✓（与 workflow 的 worker 自证同一套路 ✓）。
					// 只读入参（语言 + 可选片段，**有长度上限**）⇒ 不读工作区、不写任何东西 ✓。
					const language = (url.searchParams.get('lang') ?? 'typescript').trim() || 'typescript';
					const rawText = url.searchParams.get('text');
					const text = rawText === null ? PROOF_SNIPPET : rawText.slice(0, MAX_PROOF_TEXT);
					const file = (url.searchParams.get('file') ?? 'proof.ts').slice(0, 200);
					const started = Date.now();
					const got = await parserPoolOf().parseSource({ language, text, file });
					const retryable = got.kind === 'no-wasm-dir' || got.kind === 'no-grammar';
					res.writeHead(got.ok ? 200 : (retryable ? 503 : 500), JSON_HEADERS);
					res.end(JSON.stringify({
						...got,
						ms: Date.now() - started,
						// 资产从哪来的**一并回传**（"用错资产"是这一类功能最贵的静默错 ✓）
						describe: describeParser(config),
					}));
					return;
				}
				if (url.pathname === `${ROUTE_PREFIX}/api/index-status`) {
					// ★ P1：影子索引的**只读**现状（探针与页面共用同一份口径 ✓）。
					// ⚠ **没有**"HTTP 触发索引"的端点（也不该有 ✗）：索引是写动作 + 有成本 ⇒ 只走**过审批闸的工具** ✓
					// （开一条不设闸的写端点 = 结构上绕过审批 ✓，那正是本仓 R1 要防的事 ✓）。
					// ⚠ 保鲜状态也要带上（P4）—— 页面里有、接口里没有，会让"接口是机器可读的那一份"这句话不成立 ✗
					//（p3-42 第一版就是靠这条差异抓到的：接口缺 `watch` ⇒ 探针读到 undefined ✓）
					const status = await shadowStatus(config);
					res.writeHead(status.ok ? 200 : 503, JSON_HEADERS);
					res.end(JSON.stringify({ ...status, watch: watchStateOf() }));
					return;
				}
				const query = url.searchParams.get('q') ?? '';
				const fileFilter = url.searchParams.get('file') ?? '';
				// ⚠️ `Number(null)` 是 **0**，`Number.isFinite(0)` 为真 ⇒ 不写 `?node=` 也会被当成"要深加载"
				// （真机探针抓到的：默认请求就 deep=loaded、白付 129MB 解压）。必须先判 null。
				const rawNode = url.searchParams.get('node');
				const nodeId = rawNode === null || rawNode.trim() === '' ? undefined : Number(rawNode);
				// ★ 只读**图浏览**页（`?view=graph`，2026-10-13 用户「执行」）：它本来就是"看图"的那一页 ⇒ 必然要全量图 ✓
				const wantsGraphView = url.searchParams.get('view') === 'graph';
				const labelFilter = (url.searchParams.get('label') ?? '').trim().slice(0, 60);
				// A②：形状查询（`?shape=type:class` 之类 ✓）—— 它必须看全量图 ⇒ 与 deep 同一条加载路径 ✓
				const shapeText = (url.searchParams.get('shape') ?? '').trim().slice(0, 120);
				const wantsShape = !!shapeText;
				const wantsDeep = wantsGraphView || wantsShape || url.searchParams.get('deep') === '1' || !!query || Number.isFinite(nodeId);
				const overview = await readOverview(config);
				const toolsRegistered = TOOL_NAMES.filter(tool => !!state.tools?.get(tool)).join(',') || '(未注册)';
				// ★ 侧栏版（`?surface=sideview`，宿主在**侧栏**承载时注入）：**摘要 + 入口**，且**坚持轻路径** ✓
				//   重活（129MB 解压 / 检索 / 依赖）全在编辑区那版 —— 这正是"侧栏点了没反应"的根治：
				//   侧栏不再自己扛重活，点主入口立刻有反馈（见 renderSideview 的注释与 SIDEVIEW_SCRIPT ✓）。
				//   ⚠ 即使 URL 带了 `?deep=1` 也不解析（侧栏存在的意义就是"不付 129MB"✓）。
				if (url.searchParams.get('surface') === 'sideview') {
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
					res.end(renderSideview({
						overview,
						parser: describeParser(config),
						index: { ...(await shadowStatus(config)), watch: watchStateOf() },
						toolsRegistered,
					}));
					return;
				}
				let deep;
				let results;
				let deps;
				let loadedGraph;   // 图浏览页要它（**只活在这一个请求里** ✓ 不往别处存 ✗）
				let loadError;
				if (wantsDeep && !overview.error && !overview.missing) {
					const loaded = await loadGraph(config);
					if (loaded.error) {
						deep = { error: loaded.error };
						loadError = loaded.error;
					} else {
						loadedGraph = loaded;
						deep = {
							summary: summarizeGraph(loaded.graph),
							hotspots: topNodes(loaded.graph, { limit: 8 }),
							ms: loaded.ms,
							bytes: loaded.bytes,
							cached: loaded.cached,
							file: fileFilter,
						};
						if (query) {
							results = searchNodes(loaded.graph, { query, filePath: fileFilter, limit: PAGE_RESULT_LIMIT });
						}
						if (Number.isFinite(nodeId)) {
							deps = dependenciesOf(loaded.graph, { nodeId, limit: 12 });
						}
					}
				}
				// ⑦ Projects 段的真值（与工具 `codebase_projects` **同源** ✓）：只有全量图在手上时才算 ✓
				//（`projectsOf` 是过一遍节点 ✓ 便宜；代价大头在"要不要加载全量图"这一步 ✓）
				let projects;
				if (loadedGraph?.graph) {
					try { projects = projectsOf(loadedGraph.graph); } catch { projects = undefined; }
				}
				// A②：形状查询的产出（**解析失败也要有产出** ⇒ 页面才能"明确报错并列出支持项" ✓ 不静默 ✗）
				let shapeOutcome;
				if (wantsShape) {
					const parsed = parseShapeQuery(shapeText);
					if (!parsed.ok) {
						shapeOutcome = parsed;
					} else if (!loadedGraph?.graph) {
						shapeOutcome = { error: loadError ?? '全量图没加载 ⇒ 形状查询跑不了（先加载全量图 ✓）' };
					} else {
						shapeOutcome = runShapeQuery(loadedGraph.graph, parsed.shape);
					}
				}
				// ★ 只读**图浏览**页（`?view=graph`）：补上原面板 `View 3D Graph` 那个位置（见 renderGraphView 的头注释 ✓）
				if (wantsGraphView) {
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
					res.end(renderGraphView({
						overview,
						graph: loadedGraph?.graph,
						loadError,
						loadMs: loadedGraph?.ms,
						loadBytes: loadedGraph?.bytes,
						cached: loadedGraph?.cached,
						label: labelFilter,
						nodeId,
						deps,
						query,
						results,
						toolsRegistered,
						parser: describeParser(config),
						index: { ...(await shadowStatus(config)), watch: watchStateOf() },
					}));
					return;
				}
				const html = renderPage({
					overview,
					deep: deep && !deep.error ? deep : undefined,
					shape: wantsShape ? { text: shapeText, outcome: shapeOutcome } : undefined,
					projects,
					query,
					results,
					deps,
					toolsRegistered: `${toolsRegistered}${deep?.error ? ` · 全量图加载失败：${deep.error}` : ''}`,
					parser: describeParser(config),
					index: { ...(await shadowStatus(config)), watch: watchStateOf() },
				});
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(html);
			} catch (e) {
				const message = String(e?.message ?? e);
				if (res.headersSent) {
					res.end(message);
				} else {
					res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(message);
				}
			}
		},
	})));
}
