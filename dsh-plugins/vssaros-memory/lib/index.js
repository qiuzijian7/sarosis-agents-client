// @vssaros/dsh-memory — host half：工作记忆注入（system prompt section）+ 记忆工具 + 寄居资料库页的区块。
//
// 三件事：
//   ① **注入**：把网关产出的工作记忆文本注册成一条系统提示词 section。**section 的 text 提供者是同步的**
//      （`PromptSection.text: string | (ctx) => string`，见 dsh-system-prompt 类型），所以注入的是
//      "最近一次快照"，**刷新走：新装配主体首装 / `memory_refresh` 工具 / 页面请求**（绝不在 assembly 里做 I/O）。
//
//      ⚠ 2026-10-13 改（注入形态修正）：原来是 `TTL 60s` 的后台刷新，现改为**按装配主体冻结**
//      （`snapshotFor`）。理由：section 在提示词**最前面**（order 100），文本每 60 秒可能变一次 ⇒
//      **反复打掉 KV cache 的前缀** ✗ —— 这个代价远大于"写入后本会话看不到自己刚写的内容"（后者有
//      `memory_refresh` 兜底 ✓）。详见 `snapshotFor` 的注释。
//   ② **工具**：`memory_search` / `memory_stats` 用**已核实**的网关端点；`memory_refresh` 强制刷新快照。
//   ③ **页面**：`/x/memory/` **独立整页**（清单 `view.kind=page`，容器 `agentStudio.memory`，
//      order 111 —— 2026-10-12「资料库」拆分后从"寄居 kb 的片段"升格）。
//      旧片段路由 `/x/memory/section` **已删**（知识库页不再内嵌记忆分区，它没有调用方了）。
//
// 单写者：记忆的写入口是网关，本模块只读（不开直写文件的通道）。
//
// **静态 `inject` 只留 `tools`**（2026-10-12 改，见 `doc/dsh-modules-conformance.html` §5-9）：
// `webServer` / `connection` 只在 web 模板里存在，写进静态 inject 会让整个模块在 headless / tui
// profile 里**永久 pending**、**连工具一起失效** ✗（kanban 的注释就是这条教训的先例）。
// 现在：页面/片段路由改 `ctx.inject(['webServer','connection'], …)` 动态挂 ✓，路由里用**子 ctx** 的
// `page.webServer` / `page.connection` ✓，而 `ctx.tools` 等**已声明**的服务照旧从根 ctx 读 ✓。
// 改之前踩过的两个坑（结论仍然有效 —— 别踩回去 ✗）：
//   ① 页面 handler 里读**未声明**的服务（`page.tools`）→ 真机 500
//      `cannot get required service "tools" in inactive context`；
//   ② 用 `ctx.inject(...)` 的子 ctx 读工具表 → 拿不到（子 ctx 的可见范围与根不同）。

import { readFileSync } from 'node:fs';
import { bindFoundation, foundation } from './foundationRef.js';
import { buildAuditRow } from './core/audit.js';

import { DEFAULT_TOKEN_BUDGET, LEGACY_PARTITION, MAX_INJECT_CHARS, REQUEST_MARKER, SECTION_NAME, SEARCH_CONFIDENCE_THRESHOLD, SECTION_ORDER_FALLBACK, admitSnapshot, buildWriteReason, createSnapshot, isMemoryWriteRequest, isWriteIntent, normalizeSearchResults, parseWriteReason, partitionOf, personaIdOf, policyMemoryTypeOf, readPartitionsOf, renderWorkingContext, resolveWritePolicy, snapshotKeyOf, splitByConfidence, summarizeStats, targetKeyOf, targetLabelOf, validateWritePolicies, validateWritePolicy, WRITE_VERBS } from './core/memory.js';

import { createAuditWriter } from './audit.js';

// ★ 2026-10-14：「记忆详情」页（dsh 侧复刻 IDE 的 `MemoryDetailEditorPane`）—— 独立文件，理由见其文件头。
// ⚠ 为什么单独成文件：本文件已 3300+ 行，而详情页自带约 200 行 CSS + 十几个渲染函数 ⇒ 混进来会让
//   "页面"这件事在 index 里更难找 ✓；且它是**纯函数**（不碰 I/O ✓）⇒ 那个新文件能被探针直接喂数据测 ✓。
// ⚠ 已登记进 `package.json` 的 `files`（白名单式，不加进去不会随包分发 ✗）。
import { DETAIL_ROUTE, renderDetailPage } from './detail.js';


// ★ 2026-10-15：把**版本号**写进页面副标题 —— 因为"点了没反应"这类问题的根因**屡屡是"用户看到的是旧版"**，
//   而新旧两版**视觉上一模一样** ⇒ 没有版本号就只能靠猜 ✗。⇒ 副标题带版本 ⇒ 用户刷新后**一眼**能确认 ✓。
//   ⚠ 运行时读 package.json（不硬编码 ⇒ 不会漂移 ✓）；读不到就降级成 `(未知)` ✓（不炸页面 ✓）。
const PKG_VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '(未知)';
	} catch { return '(未知)'; }
})();
import { extractCandidates, parseFormUrlEncoded, SUMMARY_MATCHED_TAG, summaryCandidatesOf, userTextsOf } from './core/distill.js';

import { createDraftStore, draftRowsOf } from './draft.js';
import { recallHistory, renderHistory } from './history.js';

import { createJudge } from './judge.js';

import { createPromoter } from './promote.js';

import { createTaskQueue } from './queue.js';

import { autoCrystallize, cascadeUpdate, compressSession, createRoutine, crystalGet, crystalList, crystallize, facetDimensions, facetGet, facetQuery, facetStats, facetTag, facetUntag, forgetMemory, frontierAdd, gatewayUrlOf, getRoutine, getRoutines, governanceAuditQuery, governanceBulkDelete, governanceDelete, meshJoin, meshLeave, meshList, meshSync, obsidianExport, providerCall, recallFormatted, reinforceMemory, remember, requireGateway, routineDelete, routineFreeze, routineStatus, routineStepUpdate, runRoutine, search, sentinelCancel, sentinelCheck, sentinelCreate, sentinelList, sentinelTrigger, stats, teamQuery, teamShare, workingContext } from './gateway.js';


export const name = 'vssaros-memory';

/**
 * 必需服务：这三个在 Host 里**已证实存在**（kanban 同款声明，真机验过）。
 *
 * `systemPrompt` **刻意不放进这里**：写进静态 inject 会让插件在缺该服务的组合里**永久 pending**
 * （实测：加了它以后真机整片 404——路由/工具/注入全都不注册）。它走可选注入，是否生效由页面自诊断。
 */
export const inject = ['tools'];

const ROUTE_PREFIX = '/x/memory';
/**
 * 清单声明的**整页**路由（`view.kind=page`；2026-10-12「资料库」拆分后启用）。
 * **精确匹配**；独立工作台容器 `agentStudio.memory` 直接加载它。
 */
const PAGE_ROUTE = '/x/memory/';
/**
 * 草稿提升的表单动作路径（**无 JS**：页面里就是一个 `<form method="post">` ✓）。
 *
 * 为什么不用 client chunk 加"提升"按钮：本页是**服务端渲染 + 零脚本**（`lib/pageShell.js` 的口径 ✓），
 * 为了一个按钮引入 client chunk 会把"页面脚本能不能被当字符串 eval"那套契约一起拖进来 ✗ ——
 * 而表单这条路零新契约、零新依赖 ✓。
 */
const PROMOTE_ROUTE = '/x/memory/promote';
/**
 * 丢弃表单动作路径（与提升**对称**设计 ✓）。
 *
 * 为什么要有"丢弃"这个动作（而不只是"不理会"）：草稿区是**待办**，而"放着不管"与"我看过、不要"
 * 是两件事 ✓ —— 后者需要**当下**把它移出视线，否则草稿列表会被已知的噪音占满、真正的候选被淹掉 ✗。
 * ⚠ 但它**不是永久否决**（`seenDigestsOf` 只把 `status !== 'rejected'` 算作已见 ⇒ 下次还会再提 ✓），
 * 理由见 `lib/promote.js` 的 `discard` 注释 ✓。
 */
const DISCARD_ROUTE = '/x/memory/discard';
// ★ 2026-10-12：片段路由 `/x/memory/section`（`view.kind=section` 时代的宿主内嵌入口）已删 ——
// 知识库页不再内嵌记忆分区（记忆已是独立工作台），它不再有任何调用方。
// ★ 2026-10-13：`REFRESH_MS = 60_000`（TTL 保鲜期）**已删** —— 见 `snapshotFor`。
// 它唯一的用途是"过期后在下一个触发点后台刷新"，而那个行为**恰好是**要消灭的：section 在提示词最前面，
// 任何时间驱动的变更都会打掉 KV cache 前缀 ✗。刷新点改为**语义驱动**（新主体首装 / 工具 / 页面）✓。
/** 本插件注册的工具名（页面自诊断用）。 */
const TOOL_NAMES = ['memory_list', 'memory_search', 'memory_stats', 'memory_refresh', 'memory_remember',
	// 2026-10-13 批 1（从 IDE 侧高级记忆工具里接过来的**单方法**那几个 ✓；命名与真源逐字一致 ✓）
	'memory_recall', 'memory_forget', 'memory_obsidian_export', 'memory_cascade', 'memory_crystal',
	// 批 2a：多 action 的两个（例程 / 改进 ✓）—— 参数与 action 取值逐条照 `routineCrystalFacetTools.ts:44-62` ✓
	// 与 `unifiedMemoryTools.ts:80-89` ✓
	'memory_routine', 'memory_improve',
	// 批 2b：多维标签（6 action ✓，照 `routineCrystalFacetTools.ts:208-217` ✓）；`memory_crystal` 已升级为 4 action ✓
	'memory_facet',
	// 批 2c：四个多 action（治理 / 团队池 / 联邦 / 哨兵 ✓）—— action 表照 `advancedMemoryTools.ts:48-300` ✓
	'memory_governance', 'memory_team', 'memory_mesh', 'memory_sentinel',
	// 2026-10-13：通用**只读**入口（1 个工具覆盖 28 个已确证的只读方法 ✓，白名单见 `MEMORY_API_READONLY`）。
	// ⚠ 放在**末尾**：页面自诊断按本数组顺序输出（`index.js:2458`），`toolDefinitions` 也把它排在最后 ✓
	// ⇒ 两处顺序一致，`p3-07` 的整串断言才成立 ✓。
	// ⚠ 它**不在** `WRITE_TOOLS` 里（只读 ⇒ 不过闸 ✓；`p3-26` 的 89 条正是守这个）。
	'memory_api',
	// 2026-10-13：槽位（8 action，读写各半 ✓）—— 写类要过闸，所以必须独立成工具（不能塞进只读的 `memory_api` ✓）。
	'memory_slot',
	// 2026-10-13：课程（4 action：list/recall 只读、save/delete 写 ✓）—— 同上 ✓。
	'memory_lesson',
	// 2026-10-13：行动链 / 草图 / 信号（3 group × 各 3-5 个 sub ✓）—— 边界清楚，**不塞进 governance** ✓。
	'memory_work',
	// 2026-10-13：导入（写）—— 与 `memory_api` 的 `exportMemories`（只读）配对 ⇒ **按读/写切边界** ✓。
	'memory_import',
	// 2026-10-13：技能落盘（写）—— 补齐"引擎抽出的技能 → 平台 SKILL.md"这条**此前断开的链** ✓。
	'memory_skill'];

/**
 * 写入预算（**与 legacy 同纪律，但口径不同 —— 如实写在下面**）。
 *
 * 为什么要有：IDE 侧对 `memory_remember` 有预算（`src/.../providers/tool/memoryTools.ts:44-72`）：
 * 子代理 **10/任务**、主代理 **50/会话**，超限时**引导模型去复用**已有记忆而不是继续写。而 dsh 侧
 * 此前**只有"content 非空"一条校验** ⇒ 同一个库会被"有预算的那侧"和"**没预算**的那侧"以不同纪律写，
 * 出现"dsh 侧越写越多、只能回 IDE 清理"的单向沉淀（README 5.57 的第 2 问）。
 *
 * ⚠ **口径差异（这就是"口径统一"里还没定的那一半）**：dsh 侧**没有会话边界**（工具由 Host 进程里的
 * agent 调用，Host 与 IDE 的会话不是一件事）⇒ 这里的预算按 **Host 进程生命周期** 计，粒度是
 * "**每 Host 运行 N 次**"，而不是 legacy 的"每会话 N 次"。数值与 legacy 的**默认值**对齐（50 / 10 ✓），
 * 且用同一套 `subagent-` 前缀判据 ✓ —— 但两边**不共享计数器**（不同进程，各自计各自）。
 *
 * 判定发生在**打网关之前**（预算是"别写太多"，不是"网关说你写太多"）⇒ 超限时不会产生任何网络调用 ✓，
 * 也不会消耗任何写配额 ✓。计数在**尝试时**就 +1（与 legacy 的 `checkMemoryWriteBudget` 一致 ✓）：
 * 网关拒绝的那次也算，避免"失败重试"绕过预算 ✓。
 */
const MAIN_WRITE_BUDGET = 50;
const SUBAGENT_WRITE_BUDGET = 10;

/** 预算上限：`config.maxWritesPerRun`（正整数，探针用它把预算压到 2 好断言）> 前缀判据的默认值。 */
function writeBudgetOf(config, agentId) {
	const configured = config?.maxWritesPerRun;
	if (Number.isInteger(configured) && configured > 0) {
		return configured;
	}
	return String(agentId).startsWith('subagent-') ? SUBAGENT_WRITE_BUDGET : MAIN_WRITE_BUDGET;
}

/**
 * 本插件实例的**记忆分区键**（即网关的 `agentId`）。
 *
 * 实现搬到 `core/memory.js` 的 `partitionOf`（纯逻辑、探针可直接测 ✓）——
 * 2026-10-12 起它**按工作区派生**（`config.workspaceId` ⇒ `ws-<id>`，由壳注入）：
 * dsh 侧记忆因此按工作区隔离，而**不需要动网关的任何一行**（理由见 `partitionOf` 的注释）。
 *
 * ⚠ 后果（已与用户确认的取舍）：隔离**之前**的数据全在旧分区 `default` 里，且**无法按工作区还原**
 *   （写入时没有记录来源）⇒ 那些记忆**不再被注入**，但可以用 `memory_list` / `memory_search` 的
 *   `partition: 'legacy'` **显式查回来** ✓（`LEGACY_PARTITION`）。
 */
const agentIdOf = config => partitionOf(workspaceScoped(config));
const tokenBudgetOf = config => (Number.isInteger(config?.tokenBudget) && config.tokenBudget > 0 ? config.tokenBudget : DEFAULT_TOKEN_BUDGET);

/**
 * 把**运行期**工作区上下文叠进 config（2026-10-17）。
 *
 * 为什么必须叠（这是"切工作区不必重启"在本模块的落点）：`config.workspaceId` 只在 Host 启动时注入
 * 一次 ⇒ 不重启的话，切换工作区后新写入的记忆会静默落进**旧**分区 `ws-<旧id>` ✗（读取时"记忆不见了"
 * 只是表象，真身在旧分区）。运行期上下文的真源与三条纪律见
 * `@vssaros/dsh-foundation/lib/workspaceContext.js` ✓。
 *
 * ⚠ 有上下文就**以它为准**：上下文里没有 workspaceId（＝当前没有活动工作区）时**不**回落 config 的旧值，
 *   而是让 `partitionOf` 走它自己的兜底（旧分区 `default` ✓）——与"config 里没注入"同口径 ✓。
 * ⚠ 读不到上下文（foundation 未绑定 / 从未推过 / 老 Host）⇒ **原样返回** ⇒ 与从前逐字相同 ✓。
 */
function workspaceScoped(config) {
	const runtime = workspaceContext();
	return runtime ? { ...config, workspaceId: runtime.workspaceId } : config;
}

/** 运行期工作区上下文；`undefined` = 没有（foundation 缺席也算"没有" ⇒ 回落 config ✓）。 */
function workspaceContext() {
	// 为什么要 try：`foundation()` 在服务未绑定时**故意抛错**（fail-fast ✓），而本函数在工具/页面的
	// 热路径上 ⇒ 不能让它把"记忆按哪个分区挂"变成整页报错 ✗（与 config 回落同语义 ✓）。
	try {
		return foundation().workspaceContext?.() ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * 本插件实例的**记忆分区键**（＝ 生产用的 `agentIdOf` 的对外形态）。
 *
 * 为什么导出：它是**写路径**上的判据（分区认错 = 记忆静默落进旧工作区的分区 ✗）⇒ 必须能被守卫
 * 直接断言"运行期上下文优先 / 上下文说没有就不回落旧值"，而不是靠读源码猜 ✓
 * （`dsh-plugins/check-host-config.mjs` 的 `partition` 链就是它 ✓）。
 */
export function partitionKeyOf(config) {
	return agentIdOf(config);
}

// ── 部署配置兜底（2026-10-20，preset plane 半边副本没有壳注入的配置）──────────────────
//
// 只兜底**部署级**的三个键：网关地址 / 数据根 / 工作区（都由壳经 `--patch` 注入 host plane 那行）。
// ⚠ 刻意不兜底 `agentId`（显式分区是"我就要这个分区"，不该被别的挂载影响）与策略类键（writePolicy 等：
//   各行自己的配置说了算）。
// ⚠ 只给 `toolsOnly` 副本用：非半边的挂载缺配置时**保持原样**（探针 p3-35 的"壳未注入 ⇒ default"语义不变）。
const DEPLOYMENT_KEYS = Object.freeze(['gatewayUrl', 'dataRoot', 'workspaceId']);
/** 本进程登记的部署配置（最后一次带配置的非半边挂载）。 */
let deploymentConfig = null;

const hasValue = v => typeof v === 'string' && v.trim() !== '';

/** 登记；没有任何部署键 ⇒ 不登记（返回 null）。 */
function registerDeploymentConfig(raw) {
	if (!raw || !DEPLOYMENT_KEYS.some(k => hasValue(raw[k]))) { return null; }
	const snapshot = Object.freeze(Object.fromEntries(DEPLOYMENT_KEYS.filter(k => hasValue(raw[k])).map(k => [k, raw[k]])));
	deploymentConfig = snapshot;
	return snapshot;
}

function unregisterDeploymentConfig(snapshot) {
	if (deploymentConfig === snapshot) { deploymentConfig = null; }
}

/**
 * 半边副本的 config：自己有的键用自己的；缺的部署键在**读取时**取登记值（getter ⇒ 先挂载/后挂载都对）。
 * 展开（`{...config}`）也会求值 getter ⇒ `workspaceScoped` 等现有用法不用改。
 * @param {object} raw
 */
export function withDeploymentFallback(raw) {
	const out = { ...(raw ?? {}) };
	for (const key of DEPLOYMENT_KEYS) {
		if (hasValue(out[key])) { continue; }
		delete out[key];
		Object.defineProperty(out, key, { enumerable: true, configurable: true, get: () => deploymentConfig?.[key] });
	}
	return out;
}

/** 探针用：当前登记的部署配置（只读）。 */
export function deploymentConfigForTest() {
	return deploymentConfig;
}

/**
 * 本次调用的**读**分区清单（2026-10-20：写 ws、读 ws + 当前人设，口径见 `core/memory.js` 的人设分区注释）。
 * @param {object} config
 * @param {object} state - 需要 `state.projections`（`sessionProjections` 服务，可缺席）。
 * @param {unknown} agent - dsh `Agent`（装配上下文 / 工具执行上下文里的那个；缺席 ⇒ 只读主分区）。
 * @returns {{ primary: string, persona: string, partitions: string[] }}
 */
function readScopeOf(config, state, agent) {
	const primary = agentIdOf(config);
	const persona = personaIdOf(agent, state?.projections);
	return { primary, persona, partitions: readPartitionsOf(config, primary, persona) };
}

/**
 * 多分区检索 → 合并（按分数降序、按 id 去重、再截到 `limit`）。每条带上 `partition`（来自哪个分区）。
 * ⚠ 分区之间**并行**取；任一分区失败**不拖垮整次检索**（主分区失败才算失败，人设分区失败只记一条说明）。
 */
async function searchPartitions(base, partitions, query, limit) {
	const settled = await Promise.allSettled(partitions.map(p => search(base, p, query, limit)));
	const merged = [];
	const seen = new Set();
	const notes = [];
	let primaryError = '';
	settled.forEach((r, i) => {
		const part = partitions[i];
		const normalized = r.status === 'fulfilled' ? normalizeSearchResults(r.value, limit) : { error: String(r.reason?.message ?? r.reason) };
		if (normalized.error) {
			if (i === 0) { primaryError = normalized.error; } else { notes.push(`人设分区 ${part} 取数失败：${normalized.error}`); }
			return;
		}
		for (const item of normalized.items) {
			const key = `${part}\u0000${item.id}`;
			if (seen.has(key)) { continue; }
			seen.add(key);
			merged.push({ ...item, partition: part });
		}
	});
	if (primaryError) { return { error: primaryError }; }
	merged.sort((a, b) => (typeof b.score === 'number' ? b.score : -1) - (typeof a.score === 'number' ? a.score : -1));
	return { items: merged.slice(0, limit), notes };
}

function createState() {
	return {
		/** **默认槽位**：启动预热 / 工具 / 页面刷新都写它；也是新装配主体首次进入时的**种子**（见 `snapshotFor`） */
		snapshot: createSnapshot(),
		/**
		 * **冻结快照表**（按装配主体归属，键 = `context.scope` → `context.agent` → 全局保底）。
		 * 会话进入时取一次，之后**只**因"新主体 / 显式刷新 / 页面请求"更新 ⇒ 前缀稳定 ✓。
		 */
		snapshots: new Map(),
		/** 刷新计数（页面/探针自诊断） */
		refreshes: 0,
		/** 每个 agentId 已用的写入次数（**每 Host 运行**计 —— 口径见 `writeBudgetOf` 的说明） */
		writes: new Map(),
		/** 正在进行的刷新，**按槽位**去重（避免并发重复拉） */
		inflight: new Map(),
		/** 自动沉淀：每个会话已读到的事件位置（`session.seq` 偏移；缺省 0 ⇒ 从会话开头读）✓ */
		distillSeqs: new Map(),
		/** 自动沉淀的计数（页面/探针自诊断：**跳过与失败都要可见**，否则"没产出"分不清是哪种 ✗）✓ */
		distill: { turns: 0, candidates: 0, summaries: 0, written: 0, skipped: 0, failed: 0, judged: 0, judgeDropped: 0, judgeSkipped: 0 },
		/**
		 * 草稿区的**读回缓存**（页面渲染是同步的、读文件是异步的 ⇒ 页面请求时后台读一份放这里 ✓）。
		 * 为什么需要它：草稿如果只有文件、没有界面，就等于**不存在** ✗ —— 自动沉淀的价值全在
		 * "人能看见并决定要不要提升" ✓。
		 */
		drafts: { rows: [], readAt: 0, error: '' },
		/**
		 * **摘要版**（侧栏）最近一次的取数结果（`loadSummaryModel` ✓）：取数有预算（见 `SUMMARY_WAIT_MS`）——
		 * 超预算就用这份缓存渲染，并如实标注"取数中" ✓，而不是把侧栏空着等网关 ✗。
		 */
		summary: undefined,
		/** 提示词 section 的注册情况：`undefined` = `systemPrompt` 服务不在（组合里没挂），否则是 order */
		promptSection: undefined,
		/**
		 * `sessionProjections` 服务（可选注入；读"会话中途切换过的人格"用 —— 见 `core/memory.js` 的 `personaIdOf`）。
		 * 缺席 ⇒ 只按会话的 preset 认人设（不影响功能，只是认不出中途切换）。
		 */
		projections: undefined,
	};
}

/**
 * 拉一次工作记忆 → 写进**指定槽位**（`entry`）。失败也记录（页面可见），但**不往提示词里塞错误文本**。
 *
 * 为什么带 `entry` 参数（原来是写死的 `state.snapshot`）：快照现在是**按主体冻结**的多槽位结构
 * （见 `snapshotFor`）⇒ 刷新必须能指定"刷哪一个"，否则工具/页面的刷新会去改别的会话正冻结着的文本 ✗。
 * 去重也**按槽位**做：同一份记忆被 3 个会话同时首装，不该只发 1 个请求就把另外 2 个槽位丢掉 ✓。
 *
 * ⚠ 槽位是**原地更新**（`Object.assign`）而不是替换对象 —— `Map` 里存的是同一个引用，
 * 替换对象会让表里那份永远停在初始值 ✗（原单槽位实现是 `state.snapshot = {...}` 替换，搬不过来 ✓）。
 */
function refreshInto(state, config, entry) {
	const pending = state.inflight.get(entry);
	if (pending) {
		return pending;
	}
	const base = gatewayUrlOf(config);
	const agentId = agentIdOf(config);
	const tokenBudget = tokenBudgetOf(config);
	// ★ 2026-10-20：槽位登记时记下的人设（`snapshotFor` 写入；默认槽位没有 ⇒ 只读主分区）。
	//   显式 `config.agentId` ⇒ 不叠人设（`readPartitionsOf` 的口径）。
	const persona = readPartitionsOf(config, agentId, typeof entry.persona === 'string' ? entry.persona : '')[1] ?? '';
	const promise = (async () => {
		state.refreshes++;
		if (!base) {
			Object.assign(entry, { text: '', fetchedAt: Date.now(), ok: false, error: '记忆网关未配置（config.gatewayUrl / VSSAROS_MEMORY_GATEWAY_URL）', source: '', truncatedByChars: false, rawChars: 0 });
			return entry;
		}
		try {
			// ⚠ **真机订正（2026-10-13）**：读路径不是 `mem::context` ✗（那套 404 ✗），而是
			// `POST /provider/loadContext`（方法名＝ `IMemoryProvider` 接口名 ✓、信封 `{args:[…]}` ✓）。
			// `sessionId` 用**分区键**：本进程没有 dsh 会话身份（引擎只用它分页会话块），而**稳定值**才对 KV cache 友好 ✓。
			// ★ 2026-10-20：有人设 ⇒ **两个分区并行取**，各自用一份 `tokenBudget`（人设分区不挤占工作区那份）；
			//   人设那份失败**不拖垮**注入（只记 `personaError`，页面可见）。
			const [primaryText, personaResult] = await Promise.all([
				workingContext(base, agentId, agentId, tokenBudget),
				persona
					? workingContext(base, persona, persona, tokenBudget).then(t => ({ text: t }), e => ({ error: String(e?.message ?? e) }))
					: Promise.resolve(undefined),
			]);
			const personaText = typeof personaResult?.text === 'string' ? personaResult.text.trim() : '';
			const memoryText = personaText
				? `${primaryText}\n\n## 人设记忆（${persona}）\n${personaText}`
				: primaryText;
			// ★ 2026-10-20（借鉴 dsh-memento：待审提案随快照让模型看见）：草稿只在页面上可见 ⇒ 实测**从没被提升过**。
			//   告诉模型"有 N 条待审"，它才会在合适时提醒用户；只给**计数**不给正文 —— 未审的东西不能当事实用。
			//   随快照一起冻结（本会话内不变）⇒ 不打掉前缀缓存。
			const pending = await pendingDraftsOf(state);
			const text = pending.total > 0
				? `${memoryText ? `${memoryText}\n\n` : ''}${renderPendingDraftsNote(pending)}`
				: memoryText;
			// ⚠ 这里**有两道闸**，页面必须都说出来（报告 §5-7 的"互相掩盖" ✗）：
			//   ① **网关**按 `tokenBudget`（默认 1024 token）产出 —— 这才是**通常生效**的那道 ✓；
			//   ② 本插件另加一道 `MAX_INJECT_CHARS`（8000 字符 ≈ 该预算的十倍）⇒ **通常不生效** ✓，
			//      只在网关超发时兜底 ✓（system prompt 不该被一段记忆吃满 ✓）。
			// 所以"已注入 N 字"短，**不等于**记忆本来就少 ✗ —— 记下这次到底有没有被字符闸截 ✓。
			Object.assign(entry, {
				text: renderWorkingContext(text),
				fetchedAt: Date.now(),
				ok: true,
				error: '',
				source: `${base}/provider/loadContext`,
				truncatedByChars: text.length > MAX_INJECT_CHARS,
				rawChars: text.length,
				partitions: persona ? [agentId, persona] : [agentId],
				personaChars: personaText.length,
				personaError: personaResult?.error ?? '',
				pendingDrafts: pending.total,
			});
		} catch (e) {
			Object.assign(entry, { text: '', fetchedAt: Date.now(), ok: false, error: String(e?.message ?? e), source: `${base}/provider/loadContext`, truncatedByChars: false, rawChars: 0 });
		}
		return entry;
	})().finally(() => {
		state.inflight.delete(entry);
	});
	state.inflight.set(entry, promise);
	return promise;
}

/** 刷新**默认槽位**（启动预热 / 页面请求 / `memory_refresh` 工具用）。 */
function refresh(state, config) {
	return refreshInto(state, config, state.snapshot);
}

/**
 * 待审草稿计数（`status === 'draft'`），按类型拆成"约定"与"会话摘要"。
 * 草稿存储还没建好（启动预热那一次）/ 读失败 ⇒ 0 —— 计数只是提示，绝不让注入失败。
 */
async function pendingDraftsOf(state) {
	try {
		const rows = state.draftStore ? await state.draftStore.read() : [];
		const pending = rows.filter(row => row?.status === 'draft');
		const summaries = pending.filter(row => row.matched === SUMMARY_MATCHED_TAG).length;
		return { total: pending.length, summaries, conventions: pending.length - summaries };
	} catch {
		return { total: 0, summaries: 0, conventions: 0 };
	}
}

/**
 * 单分区的多策略召回（原 `memory_recall` 的逻辑原样搬出，供多分区并行调用）。
 * 回退与 IDE 同法（真源 `unifiedMemoryTools.ts:62-63` ✓）：老网关没有 `recallFormatted`（404 ⇒ 抛）时退回普通检索。
 * @returns {Promise<{ strategy: string, text: string }>}
 */
async function recallOne(base, partition, query, strategy, limit) {
	try {
		const raw = await recallFormatted(base, partition, query, strategy, limit);
		return { strategy, text: typeof raw === 'string' ? raw : JSON.stringify(raw ?? null) };
	} catch (error) {
		const normalized = normalizeSearchResults(await search(base, partition, query, limit), limit);
		if (normalized.error) {
			throw new Error(`${normalized.error}（且 recallFormatted 也失败：${error?.message ?? error}）`);
		}
		const text = normalized.items.length
			? `命中 ${normalized.items.length} 条（分区 ${partition}，已回退 memory_search）\n`
				+ normalized.items.map((item, i) => `[${i + 1}] ${item.id}${item.score === undefined ? '' : ` (${item.score.toFixed(2)})`}`).join('\n')
			: `分区 ${partition} 里没有命中任何记忆条目（已回退 memory_search）。`;
		return { strategy: 'searchMemory(fallback)', text };
	}
}

/** 快照里的"待审草稿"提示（纯文本、无正文）。 */
export function renderPendingDraftsNote({ total, summaries, conventions }) {
	const parts = [conventions > 0 ? `约定 ${conventions}` : '', summaries > 0 ? `会话摘要 ${summaries}` : ''].filter(Boolean).join('、');
	return `## 待审记忆草稿\n有 ${total} 条自动提取的候选${parts ? `（${parts}）` : ''}尚未进入长期记忆，需用户在「记忆」页审核并「提升」后才生效。`
		+ '合适时可以提醒用户去审核；在此之前不要把这些草稿当作已确认的事实。';
}

/**
 * 取本次装配该用的快照 —— **冻结**语义（2026-10-13 的注入形态修正，替换掉的 `REFRESH_MS = 60s`）。
 *
 * 为什么必须冻结：section 排在 system prompt **最前面**（order 100，紧随部署人设），而它的 `text`
 * provider **每次 assembly 都被调用** ⇒ 只要文本变过一次，**整条前缀缓存作废** ✗。一个每 60 秒就可能
 * 打掉 KV cache 的注入点，比"写入后本会话看不到自己刚写的内容"昂贵得多 ✓。
 * `core/memory.js` 的 `renderWorkingContext` 注释里早就写着"稳定性优先…否则每次 assembly 都会抖动、
 * 白白打掉 KV cache" —— 这里是把那句话**落到实现**上 ✓。
 *
 * 语义（与 `dsh-memento` 的"会话内冻结快照"同一取舍：它的 order -50 同样刻意排在最前，
 * 且会话内不变）：
 *   ① 每个装配主体（`context.scope` / `context.agent`）**首次进入**时登记一个槽位；
 *   ② 之后**只**在三种情况更新 —— 新主体首装 / 显式 `memory_refresh` / 页面请求（诊断面要看最新）✓；
 *   ③ 新槽位首装**同步借默认槽位的内容当种子**（乐观：同一分区的内容本就相同，只是写入时机不同）
 *      ⇒ 会话第一轮不会看到空白 ✓，同时后台取该主体自己那份，下一轮起生效 ✓。
 *
 * 已知边界：`snapshotKeyOf` 取不到主体时退回**全局保底键**（功能不丢、只是不隔离）——
 * 这个降级在页面上是可观察的（见诊断行的 `快照数`）✓。
 *
 * @param {object} state - 插件状态。
 * @param {object} config - 插件配置。
 * @param {unknown} context - section provider 收到的装配上下文（`AssembleContext`）。
 * @returns {string} 注入文本。
 */
function snapshotFor(state, config, context) {
	const entry = admitSnapshot(state.snapshots, snapshotKeyOf(context));
	// ★ 2026-10-20：本主体当前生效的人设（装配上下文是 `{ agent, scope: agent }` —— dsh-agent 的
	//   `assembleContextFor`）。拿不到就是 `''`（只读工作区分区，与从前一致）。
	const persona = personaIdOf(context?.agent, state.projections);
	if (entry.fetchedAt === 0) {
		// 首次进入该主体：先借默认槽位（本轮立刻有内容 ✓），再后台取自己那份 ✓
		Object.assign(entry, {
			text: state.snapshot.text,
			ok: state.snapshot.ok,
			error: state.snapshot.error,
			source: state.snapshot.source,
			fetchedAt: state.snapshot.fetchedAt,
			persona,
		});
		void refreshInto(state, config, entry);
	} else if ((entry.persona ?? '') !== persona) {
		// 会话**换了人设**（空白会话里改 preset / 中途切人格）：人设 section 本身已经变了 ⇒ 前缀反正要变，
		// 这时重取记忆**不额外**打掉缓存；不重取的话会一直注入**上一个人设**的记忆 ✗。
		entry.persona = persona;
		void refreshInto(state, config, entry);
	}
	return entry.text;
}

// 页面外壳（标题 / 工具条 / 分区 / 空态 / 诊断行）逐条移植自 VsSaros 原容器 Pane，
// 见 `lib/pageShell.js` 顶部注释（真源行号 + 分发约定）。`escapeHtml` 由它提供。
import { escapeHtml, renderShell } from './pageShell.js';


/**
 * 固定槽位（**逐字照抄** `memoryLibraryView.ts:45-48` 的 `SLOT_NAMES` —— 它与记忆引擎的
 * `DEFAULT_SLOTS` 同源）。它**不是**从网关读来的：IDE 侧同样是硬编码常量 ⇒ 这里也硬编码 ✓
 * （改成"从网关读槽位"反而会与真源分叉 ✗）。
 */
const SLOT_NAMES = [
	'persona', 'user_preferences', 'tool_guidelines', 'project_context',
	'guidance', 'pending_items', 'session_patterns', 'self_notes',
];

/**
 * 单个统计格子（等价于 IDE 侧 `libraryStatHelpers.ts:37-46` 的 `statCell`）：
 * `div.kb-stat-cell` > `span.kb-stat-num` + `span.kb-stat-label`，值为 0 时加 `.zero`（灰显 ✓）。
 */
function statCell(label, value) {
	const zero = value === 0 || value === '0';
	return `<div class="kb-stat-cell${zero ? ' zero' : ''}"><span class="kb-stat-num">${escapeHtml(String(value))}</span><span class="kb-stat-label">${escapeHtml(String(label))}</span></div>`;
}

/**
 * 页面正文（2026-10-13 复刻「记忆库」view 的结构）。
 *
 * 结构与类名**照 `memoryLibraryView.ts:84-163` 的 `renderBody` / `_renderList`**：
 * 面板（`kb-panel` + `kb-panel-bar`）→ 入口卡片（`kb-entry`）→ 统计区（`kb-stat-hero` +
 * 两个 `kb-stat-grid`）→ 固定槽位（`kb-side-section` + `kb-slot-chip`）✓。
 *
 * ★★ 一处**有意的不照搬**（改之前先读这段）：真源的统计区是「总数 / 4 层（Working·Episodic·
 * Semantic·Procedural）/ Episodic 6 个子类型」，数据来自 `provider.searchAllAgents('')` 全量遍历。
 * 那条路在 **dsh 侧不成立**（2026-10-13 真机实测，隔离网关 + 写 4 条不同类型记忆）：
 *   · `GET /stats/<agentId>` 只回 `{indexSize, serverAvailable}` —— **不是记忆统计** ✗；
 *   · `searchAllAgents('')` 只回 **1 条**（不是全量）✗ ⇒ 按它计数会得到"1"这个**错的数**；
 *   · `getStats(agentId)` 回 `{longTermCount:0, coreMemoryCount:0, lessonsCount:0}`，与刚写入的
 *     4 条**对不上** ✗。
 * ⇒ 所以本页**不显示**四层/子类型计数（显示错的数字比不显示更糟 ✗），改为**同样的视觉格子装
 *   dsh 侧真拿得到的数据**：注入字符 / 草稿待定 / 会话快照 / 刷新次数，以及自动沉淀的六项累计 ✓。
 *   这些都是本插件**自己状态里的事实**，不依赖网关的计数接口 ✓。将来若网关补齐计数，把数据源
 *   换掉即可 —— 格子与样式不用动 ✓。
 *
 * ⚠ 探针锚点（`data-vssaros-memory-*`）**一个都没删**：它们跟着各自的数据挪到了新的容器上
 * （如草稿区那三个属性从 `<div class="diag">` 挪到 `kb-side-section` 上）⇒ 属性名与取值不变，
 * `p3-07` / `p3-48` / `p3-50` 的断言照旧 ✓（**这是改这个文件时最容易踩的坑** ✗）。
 */
function renderFragment({ state, config, toolsRegistered }) {
	const { snapshot } = state;
	// ★ 草稿区（自动沉淀的产出）：**不**注入提示词、**不**自动进长期记忆 —— 只在这里给人看 ✓
	// 理由见 `core/distill.js` 的约束 ②（自动提取必然有误 ⇒ 先草稿 + 用户显式提升 ✓）。
	const drafts = Array.isArray(state.drafts?.rows) ? state.drafts.rows : [];
	// 最近 5 条（新的在后 ⇒ 倒过来看更自然）✓
	const draftItems = drafts.slice(-5).reverse().map(row => {
		const text = `<code>${escapeHtml(String(row.text ?? '').slice(0, 90))}</code>`;
		const meta = `<small>[${escapeHtml(String(row.matched ?? ''))}${Number.isFinite(row.turn) ? ` · turn ${escapeHtml(String(row.turn))}` : ''}]</small>`;
		// ⚠ **每条一个独立表单**（不是一个表单里放多个按钮）：HTML 的 submit 按钮只会提交**它所在的**
		// 那个表单 ⇒ 每条一个表单是最不容易写错的形状 ✓。
		const draftId = escapeHtml(String(row.id ?? ''));
		const action = row.status === 'draft'
			// ⚠ **每条两个独立表单**（不是一个表单放两个按钮）：`submit` 按钮只提交**它所在的**那个表单 ⇒
			// "一个表单两个动作"得靠 JS 改 `formaction` ✗ —— 而本页是零脚本的口径 ✓（见 `lib/pageShell.js`）。
			? ` <form method="post" action="${PROMOTE_ROUTE}" style="display:inline"><input type="hidden" name="id" value="${draftId}"><button type="submit" data-vssaros-memory-promote="${draftId}">提升</button></form>`
				+ ` <form method="post" action="${DISCARD_ROUTE}" style="display:inline"><input type="hidden" name="id" value="${draftId}"><button type="submit" data-vssaros-memory-discard="${draftId}">丢弃</button></form>`
			: ` <small>（${escapeHtml(String(row.status ?? ''))}）</small>`;
		return `<li>${text} ${meta}${action}</li>`;
	}).join('');
	// ★ 上一次草稿动作的**即时反馈**（2026-10-13）：303 回本页之后，若只靠"草稿从列表消失"暗示，
	// 用户分不清"成功了"与"页面没刷新"（尤其**失败**时 —— 比如网关没确认成功 ✗）⇒ 明说一次 ✓。
	// ⚠ 30 秒后自然过期：否则一个旧结果会一直挂在页面上、被当成"刚刚发生的事" ✗。
	const lastAction = state.lastAction;
	const feedback = lastAction && Number.isFinite(lastAction.at) && Date.now() - lastAction.at < 30_000
		? `<p class="dsh-diag" data-vssaros-memory-last-action="${escapeHtml(String(lastAction.action))}|${lastAction.ok ? 'ok' : 'failed'}">${lastAction.action === 'promote' ? '提升' : '丢弃'}${lastAction.ok ? '<b>成功</b>' : '<b>失败</b>'}：<code>${escapeHtml(String(lastAction.text ?? '').slice(0, 60))}</code>${lastAction.ok ? '' : ` —— ${escapeHtml(String(lastAction.error ?? '(无详情)'))}`}</p>`
		: '';
	const base = gatewayUrlOf(config);
	const agentId = agentIdOf(config);
	const stateName = !base ? 'unconfigured' : (snapshot.ok ? 'ok' : 'error');
	const detail = !base
		? `<p class="dsh-diag">记忆网关未配置：设 <code>VSSAROS_MEMORY_GATEWAY_URL</code>，或由 VsSaros 经 <code>--patch</code> 注入 <code>config.gatewayUrl</code>。</p>`
		: (snapshot.ok
			? `<pre>${escapeHtml(snapshot.text || '(工作记忆为空)')}</pre>`
			: `<p class="dsh-diag">刷新失败：<code>${escapeHtml(snapshot.error)}</code></p>`);
	const d = state.distill ?? {};
	return `<section data-vssaros-page="memory-section" data-vssaros-memory-state="${stateName}" data-vssaros-memory-agent="${escapeHtml(agentId)}" data-vssaros-memory-bytes="${Buffer.byteLength(snapshot.text, 'utf8')}" data-vssaros-memory-chars="${snapshot.text.length}" data-vssaros-memory-refreshes="${state.refreshes}" data-vssaros-memory-writes="${state.writes.get(agentId) ?? 0}" data-vssaros-memory-tools="${escapeHtml(toolsRegistered)}" data-vssaros-memory-gateway="${escapeHtml(base ?? '')}">
<div class="kb-panel kb-panel-mem active">
  <div class="kb-panel-bar">
    <span class="kb-panel-bar-label">记忆库</span>
    <span class="kb-spacer"></span>
    <span class="kb-count" title="待处理草稿">${drafts.length}</span>
  </div>
  <div class="kb-panel-content">
    <div class="kb-mem-list">
      <!-- ★★ 2026-10-14：这张卡**终于**恢复成真入口 ✓。
           改之前：dsh 侧没有详情面板 ⇒ 只能写成"跳到本页底部的注入正文"（href 指向页内锚点，不是面板）
           —— 一个**点起来不像它看起来那样**的入口 ✗（文案/箭头照真源，目标却换了 ✗）。
           现在 lib/detail.js 把 IDE 的 MemoryDetailEditorPane 复刻过来了 ⇒ 文案与目标都回归真源 ✓：
           标题「查看完整记忆」· 副文案「打开记忆详情」· 目标是独立页面 ./detail（子路由 ✓）。
           ⚠ 本段是 JS 模板字符串内：注释里**不能出现反引号**（本仓踩过五次 ✗ —— 这一轮我又踩了**两次**：
             先是在这里写了 href 的反引号形式，修完还留着三个 ⇒ 两次都是 node --check 才抓到 ✗）。
           ⚠ 教训：**写模板字符串内的注释时，把"反引号"当成和未转义引号一样的禁字符** ✓。 -->
      <!-- ⚠⚠ href **保留**（无 JS / 纯浏览器时它仍是可用的退化 ✓），但真机里的点击由
           OPEN_DETAIL_JS 接管 —— 因为实测"光有 href 点了完全没反应" ✗（见那个常量的注释 ✓）。
           data-vssaros-memory-action 就是给那段 JS 选目标用的 ✓。
           ⚠ 本段在模板字符串内 ⇒ 注释里**绝不能出现反引号**（这条我在本仓已踩四次 ✗✗）。 -->
      <a class="kb-entry" href="./detail" data-vssaros-memory-action="open-detail" role="button" tabindex="0">
        <span class="kb-entry-icon">🗃</span>
        <span class="kb-entry-text"><div class="kb-entry-title">查看完整记忆</div><div class="kb-entry-meta">打开记忆详情（复刻 IDE 的 MemoryDetailEditorPane）</div></span>
        <span class="kb-entry-arrow">→</span>
      </a>
      <div class="kb-stats">
        <div class="kb-stat-hero"><span class="kb-stat-hero-num">${snapshot.text.length}</span><span class="kb-stat-hero-label">字已注入 · agent <code>${escapeHtml(agentId)}</code></span></div>
        <div class="kb-stat-grid">
          ${statCell('注入字符', snapshot.text.length)}
          ${statCell('草稿待定', drafts.length)}
          ${statCell('会话快照', state.snapshots.size)}
          ${statCell('刷新次数', state.refreshes)}
        </div>
        <div class="kb-stat-sub">自动沉淀（本回合累计）</div>
        <div class="kb-stat-grid">
          ${statCell('回合', d.turns ?? 0)}
          ${statCell('候选', d.candidates ?? 0)}
          ${statCell('已写', d.written ?? 0)}
          ${statCell('跳过', d.skipped ?? 0)}
          ${statCell('失败', d.failed ?? 0)}
          ${statCell('判定丢弃', d.judgeDropped ?? 0)}
        </div>
      </div>
      <div class="kb-side-section">
        <div class="kb-side-section-head"><span>固定槽位</span><span class="kb-spacer"></span><span class="kb-count">${SLOT_NAMES.length}</span></div>
        <div class="kb-mem-slots">${SLOT_NAMES.map(name => `<span class="kb-slot-chip">${escapeHtml(name.replace(/_/g, ' '))}</span>`).join('')}</div>
      </div>
      <div class="kb-side-section" data-vssaros-memory-drafts="${drafts.length}" data-vssaros-memory-drafts-read="${state.drafts?.readAt ?? 0}">
        <div class="kb-side-section-head"><span>草稿区</span><span class="kb-spacer"></span><span class="kb-count">${drafts.length}</span></div>
        <p class="dsh-diag">自动沉淀（<code>agent/turn-stopping</code>）从会话里的**用户消息**提取的候选，<b>不会自动进长期记忆</b> ✓。「提升」= <b>人的显式确认</b>（所以这条路上<b>不会再弹审批窗</b> ✓，理由见 <code>lib/promote.js</code>）；<b>不</b>处理的草稿 30 天后自动淘汰 ✓。${state.drafts?.error ? ` · <b>读回失败</b>：${escapeHtml(state.drafts.error)}` : ''}</p>
        ${draftItems ? `<ul class="kb-draft-list" data-vssaros-memory-draft-list>${draftItems}</ul>` : ''}
      </div>
      ${feedback}
      <!-- ★ 诊断默认**折叠**（2026-10-13，照真源观感调的）：真源那个「记忆库」view 是**纯概览**
           —— hero + 统计 + 定槽位，一屏看完就结束 ✗；而本页原来把两段长诊断直接铺在下面，
           整页显得很长、与真源的"干净"观感差得远 ✗。
           用**原生 details**（零脚本 ✓ 有系统三角箭头 ✓ 语义就是"可展开" ✓），
           折叠的只是**呈现**：里面所有 data-vssaros-memory-* 锚点照旧在 DOM 里 ✓
           ⇒ 探针断言的属性一个都不少（它们只看 DOM 不看可见性 ✓）。 -->
      <details class="kb-side-section kb-details">
        <summary class="kb-side-section-head"><span>诊断</span><span class="kb-spacer"></span><span class="kb-count">展开</span></summary>
        <p class="dsh-diag" data-vssaros-memory-section="${state.promptSection === undefined ? 'absent' : 'registered'}" data-vssaros-memory-section-order="${state.promptSection ?? ''}" data-vssaros-memory-snapshots="${state.snapshots.size}" data-vssaros-memory-distill="${d.turns ?? 0}|${d.candidates ?? 0}|${d.written ?? 0}|${d.skipped ?? 0}|${d.failed ?? 0}|${d.judged ?? 0}|${d.judgeDropped ?? 0}|${d.judgeSkipped ?? 0}">agent <code>${escapeHtml(agentId)}</code> · 网关 <code>${escapeHtml(base ?? '(未配置)')}</code> · 刷新 ${state.refreshes} 次 · 工具 <code>${escapeHtml(toolsRegistered)}</code> · 会话快照 <code>${state.snapshots.size}</code> 份（每个装配主体首次装配时取一次后<b>冻结</b> ⇒ 提示词前缀不因时间而变 ✓；更新时机只有三个：新主体首装 / <code>memory_refresh</code> / 本页面刷新）${state.promptSection === undefined ? ' · <b>提示词 section 未注册</b>（组合里没有 systemPrompt 服务）' : ''}</p>
        <p class="dsh-diag" data-vssaros-memory-truncated="${snapshot.truncatedByChars ? 'yes' : 'no'}" data-vssaros-memory-token-budget="${tokenBudgetOf(config)}" data-vssaros-memory-char-cap="${MAX_INJECT_CHARS}">这段文本就是注入 system prompt 的那一份（section <code>${SECTION_NAME}</code>）。**两道闸**：网关按 <code>tokenBudget=${tokenBudgetOf(config)}</code> token 产出（**通常是它生效**）✓；本插件另加一道 <code>${MAX_INJECT_CHARS}</code> 字符硬上限（约十倍大 ⇒ 通常不生效，只在网关超发时兜底）✓ —— 所以"已注入 N 字"短**不等于**记忆本来就少 ✗。本次${snapshot.truncatedByChars ? `**触发了字符闸**（网关给了 ${snapshot.rawChars ?? '?'} 字，已截到 ${MAX_INJECT_CHARS} 字）` : '未触发字符闸'} ✓。</p>
      </details>
      <div class="kb-side-section" id="vssaros-working-memory">
        <div class="kb-side-section-head"><span>工作记忆</span><span class="kb-spacer"></span><span class="kb-count">${snapshot.ok ? `${snapshot.text.length} 字` : '未注入'}</span></div>
        ${detail}
      </div>
    </div>
  </div>
</div>
</section>`;
}

/**
 * 页面专属样式（`<pre>` 里的工作记忆文本；骨架与主题变量由 `pageShell.js` 给）。
 *
 * ★ 2026-10-13（复刻「记忆库」view 的样式）：下面 `.kb-*` 那一组**逐条移植自 IDE 侧的真源样式表**
 * `src/vs/sessions/contrib/agentStudio/browser/views/media/kbView.css` —— 因为 `memoryLibraryView.ts`
 * 就是那块表的使用者（它 `import './media/kbView.css'`，自己只搭 DOM）⇒ 复刻它的视觉
 * **等于**复刻那块表 ✓，而不是照截图猜数值 ✓。每条后面标了真源行号，改样式时两边一起改 ✓。
 *
 * ⚠ 移植时的两处**必要换算**（真源不能原样搬的地方，写下来免得后来人以为是抄漏了）：
 *   ① **图标字体**：真源用 `codicon`（IDE 自带的图标字体，如 `span.codicon.codicon-database`）✗ ——
 *      本页是**独立 document**，没有那个字体 ⇒ 同名的 span 会渲染成**空白** ✗。所以统一换成 emoji ✓，
 *      与页面上原有的 `⟳ 刷新` 同一口径 ✓。
 *   ② **类名保留 `kb-` 而不改写成 `dsh-`**：本页是独立 document，不存在与宿主样式撞名的可能 ✓；
 *      保留原名才能逐行对照真源（"这条对应 kbView.css 哪一行"一眼可查 ✓）。`dsh-*` 那组仍由
 *      `pageShell.js` 提供（它是**跨插件共享**的骨架，模块专属样式**不许**塞进去 —— 见该文件末尾的约定 ✗）✓。
 */
const PAGE_CSS = `
pre {
	background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15));
	padding: 8px;
	border-radius: 4px;
	margin: 6px 0 0;
	white-space: pre-wrap;
	word-break: break-word;
	font-family: var(--vscode-editor-font-family, ui-monospace), Consolas, monospace;
	font-size: 11px;
}

/* ── 视图外壳与标题栏（kbView.css:6-46）──────────────────────────────── */
.kb-view { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.kb-header {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 0 4px 0 10px;
	height: 35px;
	border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border));
	flex-shrink: 0;
}
.kb-header .kb-title {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: .5px;
	font-weight: 600;
	opacity: .8;
	display: flex;
	align-items: center;
	gap: 6px;
}
.kb-hbtn {
	width: 26px;
	height: 26px;
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: 4px;
	cursor: pointer;
	color: var(--vscode-icon-foreground);
	opacity: .75;
	border: 1px solid transparent;
	font-size: 14px;
	text-decoration: none;
}
.kb-hbtn:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); opacity: 1; }

/* ── 记忆库面板（kbView.css:837-838 / 841-856）────────────────────────── */
.kb-panel { display: none; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.kb-panel.active { display: flex; }
.kb-panel-bar {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 0 4px 0 10px;
	height: 30px;
	flex-shrink: 0;
	border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border));
}
.kb-panel-bar-label {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: .5px;
	font-weight: 600;
	opacity: .8;
}
.kb-spacer { flex: 1; }
/* 真源里 kb-scroll 与 kb-panel-content 同组定义（滚动容器 + 面板内容区）。
   ⚠⚠ 这条注释里**不能写反引号**：本段整体是一个 JS 模板字符串，一个反引号就会**提前结束**它，
   后面的 CSS 会被当成 JS 解析 ⇒ 报 scroll is not defined（2026-10-13 实测，栈正好指向这一行 ✗）。
   同理不要写美元符号紧跟花括号 —— 那是模板插值（本段样式不需要任何插值 ✓）。 */
.kb-panel-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 2px 0; }
.kb-mem-list { padding: 4px 0; }

/* ── 入口卡片（kbView.css:860-878）──────────────────────────────────── */
.kb-entry {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 6px 8px;
	padding: 10px 12px;
	border-radius: 4px;
	cursor: pointer;
	font-size: 12px;
	text-decoration: none;
	background: var(--vscode-editorWidget-background, var(--vscode-input-background));
	border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border));
	transition: background .1s, border-color .1s;
}
.kb-entry:hover { border-color: var(--vscode-focusBorder, #007acc); }
.kb-entry-icon { font-size: 16px; flex-shrink: 0; color: var(--vscode-icon-foreground); }
.kb-entry-text { flex: 1; min-width: 0; }
.kb-entry-title { color: var(--vscode-foreground); }
.kb-entry-meta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.kb-entry-arrow { flex-shrink: 0; font-size: 14px; color: var(--vscode-descriptionForeground); }

/* ★ 2026-10-15（用户报"记忆库 sideview 样式错误，要求与 codebase 风格一致"）：
   **删掉**上一版的 .kb-hbtn-primary（填充色大蓝按钮）✗ —— 它塞在 **35px 的标题行**里必然溢出
   （实测：按钮盖到标题栏上、还压住工具行 ✓），而 codebase 侧栏版的"置顶主按钮"根本不是填充色按钮，
   是下面这三条**卡片式主入口**（边框高亮 + 标题加粗）✓ —— 逐条同款抄自 vssaros-codebase 的侧栏版。
   ⚠ 本段在**模板字符串**里 ⇒ 注释里**不许出现反引号**（本仓第 6 次踩 ✓：写代码路径时顺手加了反引号，
     整段 CSS 被提前闭合、报 "Unexpected identifier" ✗✗）。 */
button.kb-entry { width: calc(100% - 16px); font: inherit; text-align: left; }
.kb-entry-primary { border-color: var(--vscode-focusBorder, #007acc); }
.kb-entry-primary .kb-entry-title { font-weight: 600; }

/* ── 摘要版（侧栏）的「最近记忆」行（2026-10-15 方案 1 ✓；只用 --vscode-* 令牌 ⇒ 主题跟随 ✓）── */
.kb-sum-list { padding: 2px 0 6px; }
.kb-sum-row {
	display: flex;
	align-items: baseline;
	gap: 6px;
	padding: 5px 12px;
	border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
}
.kb-sum-row:first-child { border-top: none; }
.kb-sum-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
.kb-sum-pill {
	flex: none;
	font-size: 10px;
	padding: 0 5px;
	border-radius: 8px;
	background: var(--vscode-badge-background, rgba(128,128,128,.25));
	color: var(--vscode-badge-foreground, var(--vscode-foreground));
}
.kb-sum-time { flex: none; font-size: 10px; color: var(--vscode-descriptionForeground); }
.kb-sum-empty { margin: 0; padding: 6px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); }

/* ── 统计区（kbView.css:915-976）────────────────────────────────────── */
.kb-stats { padding: 8px 10px 4px; }
.kb-stats-hint { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 6px 2px; }
.kb-stat-hero { display: flex; align-items: baseline; gap: 6px; padding: 2px 2px 8px; }
.kb-stat-hero-num {
	font-size: 20px;
	font-weight: 600;
	line-height: 1;
	color: var(--vscode-foreground);
}
.kb-stat-hero-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
.kb-stat-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
	gap: 4px;
	margin-bottom: 6px;
}
.kb-stat-cell {
	display: flex;
	flex-direction: column;
	gap: 1px;
	min-width: 0;
	padding: 5px 7px;
	border-radius: 4px;
	background: var(--vscode-editorWidget-background, rgba(128,128,128,.08));
	border: 1px solid var(--vscode-panel-border, transparent);
}
.kb-stat-cell.zero { opacity: .55; }
.kb-stat-num { font-size: 13px; font-weight: 600; line-height: 1.2; color: var(--vscode-foreground); }
.kb-stat-label {
	font-size: 10px;
	color: var(--vscode-descriptionForeground);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.kb-stat-sub {
	margin: 2px 2px 4px;
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: .5px;
	color: var(--vscode-descriptionForeground);
}

/* ── 侧栏小分区 / 槽位 chip（kbView.css:882-889 / 1000-1019）────────── */
.kb-side-section { padding: 2px 0 6px; }
.kb-side-section-head {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 10px;
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: .5px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground);
}
.kb-count {
	font-size: 10px;
	padding: 0 6px;
	border-radius: 10px;
	background: var(--vscode-badge-background, rgba(128,128,128,.2));
	color: var(--vscode-badge-foreground);
}
.kb-mem-slots { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; }
.kb-slot-chip {
	font-size: 9px;
	padding: 2px 6px;
	border-radius: 3px;
	color: var(--vscode-descriptionForeground);
	background: var(--vscode-badge-background, rgba(128,128,128,.18));
}
/* 可折叠分区（原生 details ⇒ **零脚本** ✓，与本页口径一致 ✓）。
   刻意**不画**默认三角（list-style:none + 去掉 webkit marker），改用 ::after 的小三角 ——
   这样 summary 能直接复用 .kb-side-section-head 的排版，与「固定槽位 / 草稿区」那些标题**完全对齐** ✓
   （否则系统三角会把这一行的左内边距顶歪 ✗）。 */
.kb-details > summary { cursor: pointer; list-style: none; user-select: none; }
.kb-details > summary::-webkit-details-marker { display: none; }
/* ⚠ 三角直接用**字符本身**（▾ / ▸），不要写 CSS 的码点转义。
   本段是 JS 模板字符串：码点转义里的反斜杠紧跟数字会被当成八进制转义，语法检查直接报错 ✗。
   要么写双反斜杠，要么干脆用字符 —— 这里选后者，少一层转义 ✓。
   ⚠ 另：本段注释里**不要引用代码标识符**（反引号会提前结束模板字符串，这个坑已踩多次 ✗）。 */
.kb-details > summary::after { content: '▾'; margin-left: 6px; font-size: 9px; opacity: .7; }
.kb-details:not([open]) > summary::after { content: '▸'; }
.kb-details > summary:hover { color: var(--vscode-foreground, #ccc); }

/* 草稿条目（真源无对应区块：草稿区是 dsh 侧独有的自动沉淀产出）*/
.kb-draft-list { margin: 0; padding: 0 12px 4px 26px; font-size: 11px; }
.kb-draft-list li { margin: 3px 0; color: var(--vscode-foreground); }
.kb-draft-list li small { color: var(--vscode-descriptionForeground); }

/* ⚠ 行内代码要**看得出是代码**：pageShell.js 的骨架只给了等宽字体、没给底色，
   结果诊断行里那一长串工具名与正文糊在一起 ✗（2026-10-13 按渲染实测补 ✓）。
   ⚠ 本段是 JS 模板字符串：注释里**不能有反引号**（这一条已经踩了四次 ✗ ⇒ 由 p3-69 的守卫兜住 ✓）。 */
code {
	background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.18));
	padding: 0 3px;
	border-radius: 3px;
}

/* ⚠⚠ 草稿的「提升 / 丢弃」**必须显式给样式**（2026-10-13 修，这是"看着和效果图不一致"的真因之一）：
   不给的话用的是**浏览器默认按钮** —— 实测计算样式是 background rgb(240,240,240) +
   border 2px outset，也就是**浅灰底 + 3D 凸起边框** ✗✗ ⇒ 在深色侧栏里极其突兀 ✗。
   这里照本页既有的 .dsh-btn 口径改用主题变量 ✓，并按草稿行的密度收小一点 ✓。 */
.kb-draft-list button {
	background: var(--vscode-button-secondaryBackground, #3a3d41);
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground, #ccc));
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
	border-radius: 3px;
	padding: 1px 7px;
	font: inherit;
	font-size: 10px;
	line-height: 1.5;
	cursor: pointer;
	vertical-align: baseline;
}
.kb-draft-list button:hover {
	background: var(--vscode-button-background, #0e639c);
	color: var(--vscode-button-foreground, #fff);
	border-color: var(--vscode-focusBorder, #007fd4);
}
`;

/**
 * 整页形态。
 *
 * ★ 2026-10-12（「资料库」拆分）：「记忆库」已是**独立工作台** —— 容器 `agentStudio.memory`
 * 加载的是清单声明的 `/x/memory/`（`view.kind=page`），**不再是**「kb 没装时的回退」（README
 * 4.82 / 5.16 那条）。所以这里的文案也从「寄居资料库」改成独立工作台的口径。
 * **只剩一种形态**（2026-10-12 起）：整页外壳。原先按 `?embed=1` 分出的「裸片段」形态，随片段路由
 * `/x/memory/section` 一起删除（知识库页不再内嵌记忆分区 —— 它是独立工作台，不是别人的区块）。
 * 页内仍保留锚点 `data-vssaros-page="memory-section"`（`p3-16` 用它认页，**锚点值不动**）。
 */
/**
 * 从 agent 上取本次判定该用的模型路由（优先级照官方 `dsh-compaction-basic/lib/index.js:293-302` ✓）：
 * `session.requestHeader()?.config`（最近一次真实请求用过的路由）→ `agent.options.{provider,model}`。
 * 两者都取不到 ⇒ `null` ⇒ 调用方**跳过判定并计入 `judgeSkipped`**（可见，不静默 ✓）——
 * 这比"瞎猜一个 provider"正确得多（猜错会静默失败或烧到别的路由 ✗）。
 * @param {object} agent - `agent/turn-stopping` 的 `payload.agent`。
 * @returns {{provider: string, model: string} | null} 路由。
 */
function modelTargetOf(agent) {
	try {
		const latest = agent?.session?.requestHeader?.()?.config;
		if (typeof latest?.provider === 'string' && latest.provider && typeof latest?.model === 'string' && latest.model) {
			return { provider: latest.provider, model: latest.model };
		}
	} catch { /* 头取不到就退到 options ✓ */ }
	const options = agent?.options;
	if (typeof options?.provider === 'string' && options.provider && typeof options?.model === 'string' && options.model) {
		return { provider: options.provider, model: options.model };
	}
	return null;
}

/**
 * 处理一次"提升"表单提交（`POST /x/memory/promote`，**无 JS** ✓）。
 *
 * ⚠ 非 POST 一律 **405**（不是 404）：这个路径**存在**、只是方法不对 —— 顺带挡住"被链接预取 /
 * 爬虫抓一下就触发一次写入"这类事故 ✓（写操作上这尤其要紧 ✓）。
 * ⚠ 一律 **303 回页面**：表单 POST 之后必须重定向，否则用户刷新会**重复提交** ✓
 *（而重复提交在这里是幂等的：`promotedMemoryIdOf` 由指纹派生 + `mark('promoted')` 会拦住第二次 ✓，
 * 但那是第二道防线，第一道就是 303 ✓）。
 * ⚠ 整个 handler 不返回 Promise、异常全部本地吞掉 ⇒ 路由层不会出现未处理的 rejection ✓。
 */
function handleDraftAction(req, res, { promoter, logger, action, state }) {
	// `action` 只允许这两个（白名单 ⇒ 不能被路径拼出一个任意方法名 ✗）
	if (action !== 'promote' && action !== 'discard') {
		res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
		res.end(`不认识的草稿动作：${String(action)}`);
		return;
	}
	let body = '';
	let size = 0;
	req.on('data', chunk => {
		size += chunk.length;
		// 体积闸：表单只该带一个 id ⇒ 超过 4 KB 直接断（不让它变成一个能被塞满的入口 ✓）
		if (size > 4096) { req.destroy(); } else { body += chunk; }
	});
	req.on('end', () => {
		void (async () => {
			const { id } = parseFormUrlEncoded(body);
			let result;
			try {
				result = await promoter[action](id);
			} catch (error) {
				result = { ok: false, error: String(error?.message ?? error) };
			}
			if (!result.ok) {
				const label = action === 'promote' ? '提升' : '丢弃';
				try { logger?.warn?.(`[vssaros-memory] 草稿${label}失败：${result.error}`); } catch { /* 绝不再抛 ✓ */ }
			}
			// ★ 把结果留给**下一次页面渲染**（303 之后浏览器马上会 GET 本页 ✓）：
			// 没有它的话，用户只能靠"草稿从列表消失"推断，而**失败**（比如网关没确认成功）在界面上
			// 与"页面没刷新"长得一模一样 ✗ —— 那正是这条提升路径上最容易误解的地方 ✓。
			if (state) {
				state.lastAction = {
					action, ok: result.ok, id,
					text: result.text, error: result.error, at: Date.now(),
				};
			}
			res.writeHead(303, { location: PAGE_ROUTE });
			res.end();
		})();
	});
	req.on('error', () => { /* 客户端断开：什么都不做（也绝不抛 ✓） */ });
}

/**
 * 页面里那段点击脚本的**共同缘由**（两个脚本各贴一次结论，正文在这里写清 ✓）。
 *
 * ## 为什么必须用 JS —— 这是**实测**出来的，不是设计偏好 ✗
 * 原先入口卡就是一个普通 `<a class="kb-entry" href="./detail">` ✓（服务端渲染、零脚本 ✓），
 * 而且我核实过：**href 正确、`/x/memory/detail` 返回 200、详情页内容也对**（`p3-07` 116/116 ✓）。
 * 但**用户实测：点下去"完全没反应"** ✗✗ —— 页面没变、也没跳浏览器。
 * ★ 2026-10-15 **真因（主进程日志实证）**：每点一次就是一行
 *   `webContents#will-navigate: Prevented webcontent navigation` —— `src/vs/code/electron-main/app.ts`
 *   的全局 `web-contents-created` 守卫对**所有** webContents 的页内导航一律 `preventDefault`
 *   ⇒ `<a href>`、`location.href`、`<form>` 提交**全部**被拦（`dshViewHost.ts` 里"同源放行"从未生效 ✗）。
 *   ⇒ 已在 `app.ts` 豁免 dsh 视图（`DshViewHost.isDshViewWebContents`，导航权限交还 `dshViewHost` 的同源守卫 ✓）。
 *   ⚠ 先前"JS 发起的导航同源 ⇒ `will-navigate` 放行"的判断是**错的** ✗（探针实测"已点击 ⇒ 发起导航"之后仍被拦）。
 *
 * ## ⚠ 零脚本的纪律被打破了（必须记清）
 * 本文件顶部写着"本页是服务端渲染 + **零脚本**"（`pageShell.js` 的口径 ✓）—— 代价换来的东西是
 * **"入口点了没反应"** ✗✗ ⇒「入口能用」优先 ✓。注入走平台的 `renderShell({ script })` ✓（kanban / workflow
 * 等好几页都在用 ✓），**没有**改 `pageShell.js`（那会违反它"与模块无关"的约定 ✗）。
 * ⚠ 本段在**模板字符串**里 ⇒ JS 里**不能用反引号**（本仓踩过多次 ✗），一律单引号 ✓。
 */

/**
 * **完整版页**上「查看完整记忆 → 记忆详情」的点击行为（子路由 ⇒ **不能**用 `openModulePage` ✗：
 * 白名单只认整页 `/x/memory/`，传 `/x/memory/detail` 会被宿主 warn 掉、表现仍是"点了没反应" ✗）。
 *
 * ⇒ 三级：① 有桥 ⇒ **原地**导航 `./detail`（`app.ts` 已豁免 dsh 视图，页内导航真的能走了 ✓）；
 *         ② 无桥（纯浏览器）⇒ 新标签页（这是**真能用的**退化，不是"点了没反应" ✓）。
 * ⚠ 本脚本只挂在**完整版页**上（`renderPage`）——侧栏那份摘要版走 `OPEN_LIBRARY_JS` ✓。
 */
const OPEN_DETAIL_JS = `(function(){
  var el = document.querySelector('[data-vssaros-memory-action="open-detail"]');
  var probe = document.getElementById('vssaros-memory-probe');
  var mark = function (s) { if (probe) { probe.textContent = s; } };
  if (!el) { mark('· JS 跑了但找不到入口卡 ✗'); return; }
  var go = function (ev) {
    if (ev) { ev.preventDefault(); }
    var at = new Date().toLocaleTimeString();
    var bridge = window.vssarosDsh;
    // ★★ 2026-10-24：走宿主的 openModulePage —— 在**编辑区标签页**里打开详情页面。
    //   为什么不再用 location.href='./detail'：那是**主 frame 整页导航** ⇒
    //   会把整个 dsh 客户端替换掉 ⇒ **页签栏/侧栏全没了**（用户报"错误的显示成了全屏"）✗✗
    //   且宿主的导航守卫（只放行 '/'）本来也会拦它 ⇒ 表现为"点了没反应"。
    //   openModulePage 支持子路由（宿主按"精确 → 前缀归属"匹配已注册模块）✓
    if (bridge && typeof bridge.openModulePage === 'function') {
      mark('· ' + at + ' 在编辑区打开详情');
      try {
        Promise.resolve(bridge.openModulePage('/x/memory/detail')).then(
          function () { mark('· ' + at + ' 已在编辑区打开详情'); },
          function (e) { mark('· ' + at + ' 打开失败：' + ((e && e.message) || e)); }
        );
        return;
      } catch (e) { mark('· ' + at + ' 打开失败：' + ((e && e.message) || e)); return; }
    }
    // 无桥（纯浏览器）⇒ 新标签页（这是**真能用**的退化，不是"点了没反应" ✓）
    mark('· ' + at + ' 新标签页打开详情');
    window.open('./detail', '_blank', 'noopener');
  };
  el.addEventListener('click', go);
  el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { go(ev); } });
})();`;

/**
 * **摘要版（侧栏）**主入口「查看完整记忆」的点击行为 —— **逐条照抄 codebase 的 `SIDEVIEW_SCRIPT`**
 * （`vssaros-codebase/lib/index.js:918-933` ✓）：点下去**立刻**把按钮文案换成"正在编辑区打开…"并加 `.busy`
 * ⇒ "点了没反应"**当场**就能分辨是页面没接住、还是宿主没开起来 ✓（这比事后读日志快得多 ✓）。
 *
 * ⚠ 为什么传 `location.pathname` 而不写死 `/x/memory/`：宿主用它查模块页表（白名单 ✓）；
 *   带不带 `?surface=sideview` 是**宿主的自由**，页面不该把自己钉在某个表面参数上 ✓（照 kanban 的注释 ✓）。
 * ⚠ 为什么必须是**整页**路由：宿主白名单只认 `DSH_MODULE_PAGES` 里的那几条（子路由 `/x/memory/detail` 会被拒 ✗
 *   ⇒ 表现仍然是"点了没反应" ✗✓，这条在 p3-07 里有负对照断言）。
 * ⚠ 失败分支**不静默**：把原因写进副文案（可见 ✓）——"静默失败"是这一串问题的共同病根 ✗。
 */
const OPEN_LIBRARY_JS = `(function(){
  var btn = document.querySelector('[data-vssaros-memory-action="open-library"]');
  if (!btn) { return; }
  var label = btn.querySelector('[data-vssaros-memory-action-label]');
  var meta = btn.querySelector('.kb-entry-meta');
  var reset = function (text) { btn.classList.remove('busy'); if (label) { label.textContent = '查看完整记忆'; } if (text && meta) { meta.textContent = text; } };
  btn.addEventListener('click', function () {
    if (label) { label.textContent = '正在编辑区打开…'; }
    btn.classList.add('busy');
    var bridge = window.vssarosDsh;
    if (bridge && typeof bridge.openModulePage === 'function') {
      try {
        Promise.resolve(bridge.openModulePage(location.pathname)).then(null, function (e) { reset('编辑区打开失败：' + ((e && e.message) || e)); });
        return;
      } catch (e) { reset('编辑区打开失败：' + ((e && e.message) || e)); return; }
    }
    // 没有桥：纯浏览器里本页就是完整版 ⇒ 原地打开（与 codebase 同款退化 ✓）
    if (bridge) { location.href = location.pathname; return; }
    window.open(location.pathname, '_blank', 'noopener');
  });
})();`;

/** 详情页一次最多取多少条（服务端渲染 ⇒ 比 IDE 侧的 200 小得多 ✓，翻页由"搜索/筛选收窄"代替 ✓）。 */
const DETAIL_ITEMS_LIMIT = 50;

/** 引擎返回值 → 行数组（三种既有形状 ✓；详情页与摘要版共用，别各写一份 ✗）。 */
function rowsOf(value) {
	return Array.isArray(value) ? value
		: (value && Array.isArray(value.memories) ? value.memories
			: (value && Array.isArray(value.items) ? value.items : []));
}

/**
 * 四个分层的**方法名与标签**（顺序与 `detail.js` 的页签一致 ✓）。
 *
 * ⚠ 分层 id（`episodic` / `semantic` / `procedural` / `working`）就是详情页的 `tier` 值 ——
 *   摘要版与详情页必须同源，否则同一个库在两个页面上给两个数字（用户会当成"链接错了" ✗）。
 */
const MEMORY_TIERS = [
	{ id: 'episodic', label: '事件', method: 'getEpisodicMemories' },
	{ id: 'semantic', label: '语义', method: 'getSemanticMemories' },
	{ id: 'procedural', label: '流程', method: 'proceduralList' },
	// ⚠ 第 4 层 id 叫 `working`，但方法名是 `coreMemoryList` —— 这是详情页既有的映射（照 IDE 侧那页 ✓）
	{ id: 'working', label: '核心', method: 'coreMemoryList' },
];

/**
 * 取四个分层的行。
 *
 * ⚠ 某层返回 `undefined` = **该层取数失败**，与"该层为空"（`[]`）**必须分开** ✗ ——
 *   混在一起就会把失败渲染成"0 条"（p3-51 那条纪律：不许把失败美化成成功 ✓）。
 */
async function fetchTierRows(base, agentId) {
	const rows = await Promise.all(MEMORY_TIERS.map(async tier => {
		try { return rowsOf(await providerCall(base, tier.method, [agentId])); } catch { return undefined; }
	}));
	return MEMORY_TIERS.map((tier, i) => ({ ...tier, rows: rows[i] }));
}

/** 摘要版最多列几条"最近记忆"。 */
const SUMMARY_RECENT_LIMIT = 5;
/**
 * 摘要版的**取数预算**（毫秒）：网关自己的超时是 5s（`gateway.js` 的 TIMEOUT_MS），
 * 但**侧栏**不该等满 5s 才出画面 —— 等不到就先用上次结果渲染、并如实标注"取数中" ✓
 * （那次请求**不取消**：它是只读的，跑完就进缓存 ⇒ 下次 ⟳ 立刻有数 ✓）。
 */
const SUMMARY_WAIT_MS = 2500;

/** 没有取到任何数时的空摘要（字段齐全 ⇒ 渲染端不必到处判 undefined ✓）。 */
function emptySummary(config) {
	return { agentId: agentIdOf(config), hasGateway: !!gatewayUrlOf(config), at: 0, tiers: [], failed: [], total: null, layers: null, recent: [] };
}

/**
 * 「记忆库」侧栏**摘要版**的取数（2026-10-15，用户拍板方案 1「仪表盘卡 + 按钮置顶」）。
 *
 * 三个数字的**口径**（都要能一眼说清，否则不如不显示）：
 *   ① 条记忆 = 四层合计（**本地聚合** ✓ —— 引擎 `getStats` 实测写入后仍回 0 ✗，见 `loadDetailModel` 的注释）；
 *   ② 分层   = **有内容**的层数（0 条的层不算 ✓ —— 否则永远是 4，等于没信息 ✗）；
 *   ③ 工作记忆 = 注入正文字数（**不在本函数里**：它来自 `state.snapshot`，另有冻结语义 ✓）。
 * 最近几条 = 四层合并、按时间倒序前 `SUMMARY_RECENT_LIMIT` 条（时间字段照 `toDetailItem` 的口径取 ✓）。
 *
 * ⚠ 任一层失败 ⇒ 合计与层数都给 `null`（渲染成 `—`）而**不显示半个数** ×：半个数比空着更容易被当真 ✓；
 *   失败的层名进 `model.failed`，渲染端点出来 ✓。
 */
async function loadSummaryModel({ config }) {
	const base = gatewayUrlOf(config);
	const agentId = agentIdOf(config);
	const model = emptySummary(config);
	model.agentId = agentId;
	model.at = Date.now();
	if (!base) { return model; }
	const tiers = await fetchTierRows(base, agentId);
	const seen = new Set();
	const rows = [];
	for (const tier of tiers) {
		if (tier.rows === undefined) { model.failed.push(tier.id); continue; }
		model.tiers.push({ id: tier.id, label: tier.label, count: tier.rows.length });
		for (const row of tier.rows) {
			if (!row || typeof row !== 'object') { continue; }
			const id = String(row.id ?? '');
			if (!id || seen.has(id)) { continue; }
			seen.add(id);
			const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
			// 排序键：`toDetailItem` 只给格式化后的时间 ⇒ 原值在这里自己取一次（口径与它一致 ✓）
			const raw = Number(row.timestamp ?? row.createdAt ?? meta.createdAt ?? 0);
			rows.push({ item: toDetailItem(row, tier.id), ts: Number.isFinite(raw) ? raw : 0 });
		}
	}
	if (model.failed.length === 0) {
		model.total = rows.length;
		model.layers = model.tiers.filter(t => t.count > 0).length;
	}
	model.recent = rows.sort((a, b) => b.ts - a.ts).slice(0, SUMMARY_RECENT_LIMIT).map(row => row.item);
	return model;
}

/**
 * 页面渲染用的摘要：**等一个有界预算**，超时/失败就用上次缓存并标注（见 `SUMMARY_WAIT_MS` 的说明 ✓）。
 */
async function summaryForRender(state, config) {
	let timer;
	const raced = await Promise.race([
		loadSummaryModel({ config }).then(model => { state.summary = model; return model; }, () => null),
		new Promise(resolve => { timer = setTimeout(() => resolve(null), SUMMARY_WAIT_MS); timer.unref?.(); }),
	]);
	clearTimeout(timer);
	if (raced) { return raced; }
	return { ...(state.summary ?? emptySummary(config)), timedOut: true };
}

/**
 * 「记忆详情」页的**取数**（2026-10-14）。
 *
 * ## 三个设计选择
 * ① **本函数只读**：只调只读方法 ✓（写入口仍是网关 + 审批闸 ✓，见文件头"单写者"）。
 * ② **分层列表四个方法并行**（`Promise.allSettled` ✓）：它们各自独立、失败互不影响 ⇒ 一个回空
 *    或抛错不该让整页 500 ✗（与 `p3-51` 那条"要如实说、不能美化成成功"同一纪律 ✓ —— 失败会
 *    进 `model.error` 或该层为空，**不静默吞掉** ✓）。
 *    ⚠ 为什么不用 `memory_api` 的 `searchMemory`：引擎那支**硬编码 limit=20**（实测 ✓）
 *    ⇒ 拿不到"该分区共几条" ⇒ 统计与列表都会失真 ✗。分层方法才是面板用的那支 ✓。
 * ③ 计数**在本地聚合**（与 IDE 侧 `_countByTier` 同款 ✓）—— 引擎的 `getStats` 实测"写入 4 条后
 *    仍回 0" ✗ ⇒ 不能拿它当"总数"（这条早先在 `getExtendedStats` 的 note 里已记 ✓）。
 */
/**
 * 「会话」页要查的**分区数上限**（2026-10-21）。
 *
 * 为什么要有上限：会话页现在要**同时**显示工作区分区与"按 agent 区分"的所有分区
 * ⇒ 分区数 = agent 数（实测一个 profile 就有 7~20 个）⇒ 每个分区 2 次网关往返。
 * 不设上限 ⇒ 一个装了 200 个 agent 的库会打出 400 次请求 ⇒ 页面直接卡死 ✗。
 * ⇒ 取前 N 个 ＋ **如实标注**"已截断"（不静默丢数据 ✓）。
 */
const SESSION_PARTITION_LIMIT = 24;

/** 会话行的排序时间（`updatedAt` → `startedAt` → 0）；解析不了就当 0（排最后）✓。 */
function sessionTimeOf(row) {
	const t = Date.parse(String(row?.updatedAt ?? row?.startedAt ?? ''));
	return Number.isFinite(t) ? t : 0;
}

/**
 * 「会话」页的取数（2026-10-21，用户拍板「记忆既可以按工作区隔离，也可以按 agent 区分，
 * 记忆的会话都应该显示出来」）。
 *
 * ## 病根（为什么之前页面永远是空的）
 * 之前这里只查 `agentIdOf(config)`（＝**工作区分区** `ws-*`/`wa-*`），而 dsh 侧的观测/会话
 * **实际落在纯 agent 分区**（`saros-claw` / `knowledge-base-expert` …）
 * ⇒ 真库实测：dev 与安装版两个 profile 的工作区 scope 都是 **0 条**，而 `mem:obs:*`
 * 有 3617 / 19703 条 ⇒ **数据在，只是查错了分区** ✗（截图里"暂无会话记录"就是这个）。
 *
 * ## 现在的口径
 * 读分区清单 = 主分区（工作区）＋ **所有有数据的 agent 分区**（`listAllAgentsWithData`）
 * ⇒ 合并展示，每条带 `partition`（来自哪个分区）⇒ 观察按**该会话自己的分区**去查
 * （用主分区查必然是空 ⇒ 点开什么都没有 ✗）。
 *
 * ⚠ 一个分区/辅助查询失败**不该**让整页 500（零脚本页崩了 = 用户什么都看不到 ✗）
 * ⇒ 逐分区 `allSettled` + 整体 try/catch（失败**如实说**，页面仍然渲染 ✓）。
 */
async function loadSessionsView({ model, config, state, base, params, agentId }) {
	const scope = readScopeOf(config, state, undefined);
	// ⚠ 必须 catch：`listAllAgentsWithData` 在**旧网关/代理**上可能不存在（unknown provider method ✗）
	let agentPartitions = [];
	try {
		agentPartitions = rowsOf(await providerCall(base, 'listAllAgentsWithData', []))
			.map(x => String(x ?? '').trim()).filter(Boolean);
	} catch { agentPartitions = []; }
	const allPartitions = [...new Set([...scope.partitions, ...agentPartitions])];
	const searched = allPartitions.slice(0, SESSION_PARTITION_LIMIT);
	const per = await Promise.all(searched.map(async p => {
		const [s, sum] = await Promise.allSettled([
			providerCall(base, 'listSessions', [p]),
			providerCall(base, 'listSummaries', [p]),
		]);
		return { p, sessions: rowsOf(s.value), summaries: rowsOf(sum.value) };
	}));
	const byTime = (a, b) => sessionTimeOf(b) - sessionTimeOf(a);
	model.sessions = per.flatMap(x => x.sessions.map(row => ({ ...row, partition: x.p }))).sort(byTime);
	model.summaries = per.flatMap(x => x.summaries.map(row => ({ ...row, partition: x.p }))).sort(byTime);
	model.sessionPartitions = searched;
	// ⚠ 截断必须**如实标注**（不静默丢分区 ⇒ 用户看到的会话数会与真实不符 ✗）
	model.sessionPartitionsTruncated = allPartitions.length > searched.length;
	model.sessionPartitionsTotal = allPartitions.length;
	// ⚠⚠ **只对选中的那一个**会话取观察（零脚本下"展开"= 换 `?session=` ✓）
	//   ⇒ 否则 N 个会话就是 N 次网关往返 ✗（IDE 侧是懒加载，天然只取一个 ✓）
	const sid = params.get('session');
	// ★ 2026-10-21：同名 session 可能出现在**多个分区** ⇒ 选中要**带分区**（`?partition=`），
	//   否则会同时展开多条、且观察会取到别的分区的那条 ✗（没给分区时退回"第一个匹配" ✓）。
	const spart = String(params.get('partition') ?? '');
	const picked = model.sessions.find(s => String(s?.id ?? '') === sid
			&& (spart === '' || String(s?.partition ?? '') === spart))
		?? model.sessions.find(s => String(s?.id ?? '') === sid);
	if (picked) {
		// ⚠ 用**该会话自己的分区**查观察（会话可能来自 agent 分区 ⇒ 用主分区查必然空 ✗）
		const p = String(picked.partition ?? agentId);
		try { model.sessionDetail = { observations: rowsOf(await providerCall(base, 'observeList', [p, sid])), partition: p }; }
		catch { model.sessionDetail = { observations: [], partition: p }; }
	}
}

async function loadDetailModel({ config, params, state }) {
	const base = gatewayUrlOf(config);
	const agentId = agentIdOf(config);
	const model = {
		params, agentId, hasGateway: !!base, tool: params.get('tool') ?? '',
		view: params.get('view') ?? 'memories',
		items: [], total: 0, tierCounts: { working: 0, episodic: 0, semantic: 0, procedural: 0 },
		typeCounts: {}, extStats: {}, agents: [],
		// ★ 槽位页要的**固定槽位名单**由本文件注入（`detail.js` 不能 import 本文件 ⇒ 会成环 ✗；
		//   而让它自己再抄一份就多了一个会漂移的真源 ✗ ⇒ 注入是唯一既单一真源又不引环的做法 ✓）
		slotNames: SLOT_NAMES,
	};
	if (!base) { return model; }

	const call = async method => {
		try { return await providerCall(base, method, [agentId]); } catch { return null; }
	};
	const settled = await Promise.allSettled([
		call('getEpisodicMemories'), call('getSemanticMemories'), call('proceduralList'), call('coreMemoryList'),
		call('getExtendedStats'), call('listAllAgentsWithData'),
	]);
	// ⚠ `rowsOf` 已提升到模块作用域（摘要版与详情页共用同一份形状归一 ✓ —— 别在这里再写一份 ✗）
	const tiers = [
		['episodic', rowsOf(settled[0].value)],
		['semantic', rowsOf(settled[1].value)],
		['procedural', rowsOf(settled[2].value)],
		['working', rowsOf(settled[3].value)],
	];
	const ext = settled[4].value;
	model.extStats = ext && typeof ext === 'object' ? ext : {};
	const agents = settled[5].value;
	model.agents = Array.isArray(agents) ? agents.map(a => String(a?.agentId ?? a?.id ?? a)).filter(Boolean) : [];

	const seen = new Set();
	model.items = [];
	for (const [tier, rows] of tiers) {
		model.tierCounts[tier] = rows.length;
		for (const row of rows) {
			if (!row || typeof row !== 'object') { continue; }
			const id = String(row.id ?? '');
			if (!id || seen.has(id)) { continue; }
			seen.add(id);
			model.items.push(toDetailItem(row, tier));
		}
	}
	model.total = model.items.length;
	// 子类型计数：只对 episodic 那一层做（IDE 侧 `Episodic 子类型` 的口径 ✓）
	for (const item of model.items) {
		const key = String(item.type ?? '').toLowerCase();
		if (key) { model.typeCounts[key] = (model.typeCounts[key] ?? 0) + 1; }
	}

	// 筛选（layer / type / q）—— 与 IDE 侧一样是**纯前端**（那边切换筛选不发任何请求 ✓）
	const layer = params.get('layer') ?? 'all';
	const type = params.get('type') ?? '';
	const q = (params.get('q') ?? '').toLowerCase().trim();
	if (layer !== 'all') { model.items = model.items.filter(i => i.tier === layer); }
	if (type) { model.items = model.items.filter(i => String(i.type ?? '').toLowerCase() === type); }
	if (q) { model.items = model.items.filter(i => i.content.toLowerCase().includes(q)); }
	// ⚠ `total` 保持"筛选前"的总数（= 上面那行统计的数字 ✓）；筛选后的条数是 `filtered` ✓
	model.filtered = model.items.length;
	model.truncated = model.items.length > DETAIL_ITEMS_LIMIT;
	model.items = model.items.slice(0, DETAIL_ITEMS_LIMIT);

	// ── 按页签取数：**只取当前那页要的** ✓（不做"每次都把全部拉一遍" —— 那是给引擎添无谓负载 ✗）
	// ⚠⚠ `getAuditLog` 这里**是页面直调**，而且**不能前置 agentId** ✗：
	//   它的首参**不是** agentId（正因为这个，它被**刻意**排除在 `MEMORY_API_READONLY` 之外 ——
	//   塞进 `memory_api` 会被前置成 `getAuditLog(agentId, {limit:200})` ⇒ 引擎参数错位 ✗）。
	//   ⇒ 正确的调法就是 IDE 侧那句的形状：`getAuditLog({ limit: 200 })` ✓（页面 ≠ 给模型的工具 ✓）
	if (model.view === 'slots') {
		model.slots = rowsOf(await call('getSlots'));
	}
	if (model.view === 'lessons') {
		model.lessons = rowsOf(await call('getLessons'));
	}
	if (model.view === 'audit') {
		model.auditSummary = (await call('getAuditSummary')) ?? {};
		try { model.auditLog = rowsOf(await providerCall(base, 'getAuditLog', [{ limit: 200 }])); } catch { model.auditLog = []; }
		// ★ 2026-10-21：审计的**单一真源**是**落盘账本**（`<数据根>/memory-audit/audit.jsonl`，
		//   由本插件写入）⇒ 引擎自带的 AuditLog 只是**进程内内存态**（重启即失、也没人调 record）
		//   ⇒ 只读它 ⇒ 审计页**永远是 0**（真库 `mem:audit:*` 也是 0 条）✗✗。
		//   ⇒ 这里读账本（页面直调，形状 = `{ limit }`）⇒ 页面与 IDE 侧看到**同一份**审计 ✓
		try {
			const ledger = rowsOf(await providerCall(base, 'getAuditLedger', [{ limit: 200 }]));
			if (ledger.length) {
				const seen = new Set((model.auditLog ?? []).map(r => String(r?.id ?? '')));
				model.auditLog = [...ledger.filter(r => !seen.has(String(r?.id ?? ''))), ...(model.auditLog ?? [])];
				model.auditSummary = {
					...(model.auditSummary ?? {}),
					totalAuditEntries: (Number(model.auditSummary?.totalAuditEntries) || 0) + ledger.length,
				};
			}
		} catch { /* 账本读不到就只用内存审计 ✓ */ }
	}
	// ⚠⚠ 下面这三页用的方法**全部**首参都不是 agentId ✗ ⇒ 必须**页面直调**，逐个写清形状：
	//   ⇒ 它们也正是**因此**被刻意排除在 `MEMORY_API_READONLY` 之外（塞进 `memory_api` 会被自动前置
	//     agentId ⇒ 参数错位 ✗，见本文件 `MEMORY_API_READONLY` 上方那段注释 ✓）。
	if (model.view === 'hooks') {
		// `getHookStats()` —— **无参** ⇒ `[]` ✓
		try { model.hookStats = (await providerCall(base, 'getHookStats', [])) ?? {}; } catch { model.hookStats = {}; }
	}
	if (model.view === 'commits') {
		// `getCommitStats()` 无参 ✓；★ `getRecentCommits(50)` 的首参是 **limit**（不是 agentId ✗）
		try { model.commitStats = (await providerCall(base, 'getCommitStats', [])) ?? {}; } catch { model.commitStats = {}; }
		try { model.commits = rowsOf(await providerCall(base, 'getRecentCommits', [50])); } catch { model.commits = []; }
	}
	if (model.view === 'report') {
		// ★ `generateReport(type, agentId)` —— 首参是 **type**（照 IDE 侧 1254 行的调用顺序 ✓）
		//   零脚本下类型由 `?rtype=` 表达；没传就默认 `summary`（照 IDE 侧 1241 行"首屏自动出摘要" ✓）
		const rtype = params.get('rtype') ?? 'summary';
		try { model.report = await providerCall(base, 'generateReport', [rtype, agentId]); } catch { model.report = null; }
	}
	if (model.view === 'sessions') {
		// ★ 2026-10-21：会话页现在**同时**显示工作区分区与 agent 分区的会话（口径见 loadSessionsView）。
		//   整体包 try/catch：一个分区查询失败**不该**让整页 500（零脚本页崩了 = 用户什么都看不到 ✗）
		//   ⇒ 失败**如实说**（写进 model，页面上会显示），页面仍然渲染 ✓。
		try {
			await loadSessionsView({ model, config, state, base, params, agentId });
		} catch (err) {
			console.error('[vssaros-memory] sessions view failed:', err instanceof Error ? (err.stack || err.message) : String(err));
			model.sessionsError = String(err instanceof Error ? err.message : err);
			model.sessions = [];
			model.summaries = [];
		}
	}
	if (model.view === 'consolidation') {
		// 三个分层方法首参**都是** agentId ✓；⚠ `getConsolidationContext` 回的是**字符串**（不是数组 ✗
		// ⇒ 别用 `rowsOf`，那会把它当数组处理 ✓）
		try { model.consolidationContext = String((await providerCall(base, 'getConsolidationContext', [agentId])) ?? ''); }
		catch { model.consolidationContext = ''; }
		model.episodicItems = rowsOf(await call('getEpisodicMemories'));
		model.semanticItems = rowsOf(await call('getSemanticMemories'));
		model.proceduralItems = rowsOf(await call('getProceduralMemories'));
	}
	if (model.view === 'skills') {
		// ⚠ IDE 侧那页还会**直读用户目录** `~/.vssaros/skills/*/.usage.json` 拿 usage 统计
		//   （read_skill 调用 / 近30天活跃 / 已钉选 ✗）—— 本页**不读用户目录** ✓（只读口径 + 单写者；
		//   数据只从网关来 ✓）；缺的那几项在页面上**如实标注** ✓（见 `detail.js` 的 `renderSkillsView`）
		model.skillStats = (await call('getSkillStats')) ?? {};
		model.skills = rowsOf(await call('listSkills'));
	}
	if (model.tool === 'diag') {
		const diag = await call('diagnose');
		model.diag = diag && typeof diag === 'object' ? { ...diag, ...(model.extStats ?? {}) } : { ...(model.extStats ?? {}) };
	}
	return model;
}

/** 一条引擎记忆 → 详情页卡片要的字段（`detail.js` 的 `renderCard` 口径 ✓）。 */
function toDetailItem(row, tier) {
	const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
	const content = typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '');
	const ts = row.timestamp ?? row.createdAt ?? meta.createdAt;
	const date = ts ? new Date(ts) : null;
	const valid = date && !Number.isNaN(date.getTime());
	return {
		id: String(row.id ?? ''),
		type: String(row.type ?? tier),
		tier,
		title: content.slice(0, 80).replace(/\s+/g, ' '),
		content,
		timestamp: valid ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
		strength: typeof meta.strength === 'number' ? meta.strength : undefined,
		// ⚠ 排除 owner/userId/agentId（IDE 侧 1936 行同款 ✓）—— 它们对"这条记忆是什么"没信息量
		meta: Object.entries(meta).filter(([k]) => !['owner', 'userId', 'agentId'].includes(k))
			.slice(0, 12).map(([k, v]) => [k, String(v ?? '').slice(0, 80)]),
	};
}

/**
 * 详情页的整页外壳。
 *
 * ⚠ 与 `renderPage` 的分工：本页的**正文与样式都来自 `lib/detail.js`** ✓（那边是纯函数、
 * 有独立探针 `p3-81` ✓），这里只负责"套上 dsh 的页面外壳 + 取数" ✓。
 */
function renderDetailShell(model) {
	const { title, extraCss, body } = renderDetailPage(model);
	return renderShell({
		kind: 'memory-detail',
		title: '记忆详情',
		subtitle: `复刻 IDE 的 MemoryDetailEditorPane · 只读 · 零脚本 · v${PKG_VERSION}`,
		extraCss,
		bodyHtml: body,
	});
}

/**
 * 详情页的两个导出动作（`?tool=export-json` / `export-md`）。
 *
 * ⚠ 为什么放**服务端**、而不是像 IDE 侧那样在前端 `Blob` 下载 ✗：本页是零脚本口径（`pageShell.js` ✓），
 *   前端做不了"生成文件并触发下载"⇒ 改成"服务端回一个带 `content-disposition` 的响应" ✓，
 *   由浏览器/宿主按附件处理 ✓ —— **零脚本** ✓。数据走 `exportMemories`（白名单里的**只读**导出 ✓）。
 */
async function handleDetailExport(res, { config, tool }) {
	try {
		const base = gatewayUrlOf(config);
		if (!base) { throw new Error('记忆网关未配置（VSSAROS_MEMORY_GATEWAY_URL）'); }
		const agentId = agentIdOf(config);
		// ⚡ 技能导出（IDE 侧技能页的 `⬇ 导出 JSON` ✓）：同一个动作类型，只是取数换成 `listSkills` ✓
		if (tool === 'export-skills') {
			const skills = await providerCall(base, 'listSkills', [agentId]);
			res.writeHead(200, {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': 'attachment; filename="vssaros-skills.json"',
				'cache-control': 'no-store',
			});
			res.end(JSON.stringify({ exportedAt: new Date().toISOString(), agentId, skills }, null, 2));
			return;
		}
		const data = await providerCall(base, 'exportMemories', [agentId]);
		if (tool === 'export-json') {
			res.writeHead(200, {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': 'attachment; filename="vssaros-memory.json"',
				'cache-control': 'no-store',
			});
			res.end(JSON.stringify(data, null, 2));
			return;
		}
		res.writeHead(200, {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': 'attachment; filename="vssaros-memory.md"',
			'cache-control': 'no-store',
		});
		res.end(memoriesToMarkdown(data, agentId));
	} catch (e) {
		res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('导出失败：' + String(e?.message ?? e));
	}
}

/** 导出载荷 → Markdown（字段按 `exportMemories` 的返回口径取，缺字段就跳过 ✓）。 */
function memoriesToMarkdown(data, agentId) {
	const rows = Array.isArray(data) ? data : (Array.isArray(data?.memories) ? data.memories : []);
	const head = ['# 记忆导出', '', '- 分区：' + agentId, '- 条数：' + rows.length,
		'- 导出时间：' + new Date().toISOString(), ''];
	const body = rows.map((row, i) => {
		const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
		const lines = ['## ' + (i + 1) + '. ' + String(row?.type ?? 'memory'), '',
			'- id: ' + String(row?.id ?? '')];
		if (meta.strength !== undefined) { lines.push('- strength: ' + String(meta.strength)); }
		lines.push('', String(row?.content ?? ''), '');
		return lines.join('\n');
	});
	return head.concat(body).join('\n');
}

/**
 * 标题栏（照 `memoryLibraryView.ts:88-99` 的 `kb-header`：标题 + spacer + ⟳ 刷新）—— **两个表面共用** ✓。
 *
 * ⚠ 两处换算（与 `PAGE_CSS` 顶部注释同源）：① 图标用 emoji（本页没有 codicon 图标字体，真源那两个
 *   `span.codicon.*` 在这里会渲染成空白 ✗）；② 刷新从 IDE 的 `onclick` 换成 `<a href="./">`
 *   （`./` 正是页路由本身 ✓ —— 原先进化成 `./section` 那个已删的片段路由时它是个 404 的死按钮 ✗）。
 * ★ 2026-10-15（用户拍板"仪表盘卡 + **按钮置顶**"）：只读工作台唯一的按钮就是"刷新" ⇒
 *   从"只有图标的角落链接"改成**带字的显眼主按钮** ✓（与 codebase sideview 的置顶主入口同一种视觉重量 ✓）。
 */
function headerHtmlOf() {
	// ★ 2026-10-15：`.kb-hbtn` 是**图标按钮**（26×26 ✓ 塞得进 35px 的标题行 ✓）—— codebase 完整版的
	//   刷新就是这个形状（`vssaros-codebase/lib/index.js:697` ✓）。**不要**再加填充色/加大内距：
	//   上一版那个 `.kb-hbtn-primary` 在 35px 行里必然溢出（用户报"样式错误"的真身 ✓）。
	//   ⚠ 为什么 href 直接写 `./` 就够、不需要带上当前表面：带 `surface` 的两个表面（侧栏 / 编辑区）都在
	//     路由里**提前 return** 了 ⇒ 只有"无参数"才会渲染本页（要么是纯浏览器，要么是详情页「← 记忆库」切回来 ✓），
	//     这时 `./` 正是它自己 ✓（不写一个永远走不到的分支 ✓）。
	return '<div class="kb-header"><span class="kb-title"><span>🗃</span><span>记忆库</span></span><span class="kb-spacer"></span><a class="kb-hbtn" href="./" title="刷新记忆库" aria-label="刷新记忆库">⟳</a></div>';
}

/**
 * 工具行（说明 + `#vssaros-memory-probe`）—— **两个表面共用** ✓。
 *
 * ⚠⚠ 版本号**必须放在这里**而不是 `subtitle`：`renderShell` 的取法是 `${headerHtml || '<div class="dsh-header">…'}`
 *   ⇒ 有 `headerHtml` 时 `subtitle` **根本不渲染** ✗（上一版把版本号加在 subtitle 上 ⇒ 用户永远看不到 ⇒
 *   我拿它判断"页面是不是旧的"，白折腾三轮 ✓）。
 * ⚠ 探针**两个表面都要有**：两边的脚本都会往里写状态（"已请求在编辑区打开"这类 ✓）——
 *   少一个就等于"点了没反应时现场什么都没有" ✗（这正是这一轮最初的病根）。
 */
function toolbarHtmlOf() {
	return '<div class="dsh-toolbar"><span class="dsh-diag" style="padding:0;font-size:11px">只读快照 · 写入走 <code>memory_remember</code> 工具</span>'
		+ `<span id="vssaros-memory-probe" class="dsh-diag" style="padding:0 0 0 8px;font-size:11px">· v${PKG_VERSION}</span></div>`;
}

/**
 * **完整版**记忆库页（编辑区承载 / 无 `surface` 参数的退化）。
 *
 * ★ 2026-10-15：侧栏现在是**摘要版**（`renderSideviewPage` ✓，用户拍板"只留三张卡 + 最近几条 + 置顶入口"）
 *   ⇒ 本函数只服务"编辑区那份完整版"与"浏览器直开"两种情形 ✓。
 */
function renderPage({ state, config, toolsRegistered }) {
	return renderShell({
		kind: 'memory-section',
		title: '记忆库',
		subtitle: `只读快照 · 独立工作台 · v${PKG_VERSION}`,
		headerHtml: headerHtmlOf(),
		toolbarHtml: toolbarHtmlOf(),
		// 真源的面板骨架自带滚动容器（`kb-panel-content`）⇒ 不再套 `dsh-scroll`/`dsh-section` ✓
		bodyHtml: `<div class="kb-view">${renderFragment({ state, config, toolsRegistered })}</div>`,
		extraCss: PAGE_CSS,
		// ★ 2026-10-15：本页**不再是零脚本** —— 见 `OPEN_DETAIL_JS` 的注释（"入口点了没反应"是实测 ✗，
		//   而"入口能用"优先于"零脚本"）。注入走平台的 `renderShell({ script })` ✓，不乱改 pageShell ✓。
		script: OPEN_DETAIL_JS,
	});
}

/**
 * 「记忆库」侧栏**摘要版**（2026-10-15；用户拍板方案 1「仪表盘卡 + 按钮置顶」
 * ⇒ 见 `doc/sideview-codebase-memory-mockup.html`，并按用户 2026-10-15 晚的要求**与 codebase 风格一致** ✓）。
 *
 * ## 骨架**逐条照抄 codebase 侧栏版**（`vssaros-codebase/lib/index.js:951-1000` ✓）
 *   · `headerHtml` 里开 `<div class="kb-view">` → `.kb-header`（标题 + spacer + **文字标签**）→ `.kb-panel`
 *     → `.kb-panel-bar`（面板名 + spacer + 副标题）→ `.kb-panel-content`，`bodyHtml` 再收掉三层 ✓。
 *   · 主入口是**卡片式按钮**（`button.kb-entry.kb-entry-primary` ✓ 边框高亮 + 标题加粗），**排在最上** ✓
 *     —— "按钮置顶"指的就是它 ✓。
 *   · ⚠⚠ **不要再放填充色大按钮**：上一版把 header 的 ⟳ 做成填充色（`.kb-hbtn-primary`）⇒
 *     在 **35px 的标题行**里必然溢出（盖住标题栏/压住工具行）✗✗ —— 用户报的"样式错误"就是这个 ✓。
 *     刷新在 codebase 里是 `.kb-hbtn`（26×26 图标 ✓）；本页的刷新在**完整版**的标题栏里（同款 ✓）。
 *
 * ## 内容（自上而下）
 *   ① 标题栏（标题 + 「侧栏摘要」标签）② 面板栏（`只读快照 · 写入走 memory_remember 工具 · v<版本>`）
 *   ③ **主入口卡片** ⇒ 编辑区打开**记忆详情**（`OPEN_LIBRARY_JS` ✓）
 *   ④ 三张仪表盘卡：条记忆 / 分层 / 工作记忆（口径见 `loadSummaryModel` ✓）
 *   ⑤ 最近 5 条记忆（类型 pill + 时间）⑥ 诊断行（agent / 网关 / 四层计数 ✓ 照 codebase 的 `summary` 段写法）
 *
 * ⚠ 数取不到时**如实显示 `—` + 原因**（`failed` / `timedOut` ✓）——**不许用 0 冒充**：
 *   0 = "这个分区确实没记忆"，与"取数失败"含义相反（p3-51 那条纪律 ✓）。
 */
function renderSideviewPage({ summary, state, config }) {
	const { snapshot } = state;
	const failed = Array.isArray(summary.failed) ? summary.failed : [];
	const gateway = gatewayUrlOf(config);
	const number = value => (value === null || value === undefined ? '—' : String(value));
	const cell = (value, label, title) => `<div class="kb-stat-cell${value === 0 ? ' zero' : ''}" title="${escapeHtml(title)}"><div class="kb-stat-num">${escapeHtml(String(value))}</div><div class="kb-stat-label">${escapeHtml(label)}</div></div>`;

	const tiers = summary.tiers.map(t => `${t.label} ${t.count}`).join(' · ');
	const failNote = failed.length
		? `这几层取数失败：${failed.join(' / ')}（网关 ${gateway ?? '(未配置)'}）—— 合计与层数因此显示为 —（半个数比空着更容易被当真 ✗）`
		: '';
	const timeoutNote = summary.timedOut
		? `取数超过 ${Math.round(SUMMARY_WAIT_MS / 1000)}s 还没答完 —— 现在这版是${summary.at ? '上一次的结果' : '空值'}（那次请求仍在跑，重开面板即可看到最新）`
		: '';
	const totalTitle = summary.total === null ? (failNote || '取数中…') : `四个分层合计 ${summary.total} 条｜${tiers}`;
	const layerTitle = summary.layers === null ? (failNote || '取数中…') : `有内容的层数 / 共 ${MEMORY_TIERS.length} 层｜${tiers}`;
	// 工作记忆卡走的是**另一条链**（`state.snapshot` = 注入面，另有冻结语义）⇒ 它失败要单独说 ✓
	const workingValue = snapshot.ok ? snapshot.text.length : '—';
	const workingTitle = snapshot.ok
		? `注入 system prompt 的正文 ${snapshot.text.length} 字（${new Date(snapshot.fetchedAt || Date.now()).toLocaleTimeString('zh-CN')} 取）`
		: `工作记忆取数失败：${snapshot.error || '(无详情)'}`;

	// ★ 主入口：**codebase 同款**（`button.kb-entry.kb-entry-primary` ✓）。文案照 IDE 真源
	//   （`memoryLibraryView.ts:126-138` 的那张卡：标题「查看完整记忆」· 副文案说明它通向 MemoryDetailEditorPane ✓）。
	//   ⚠ 目标由 `OPEN_LIBRARY_JS` 走桥 ⇒ 编辑区打开**记忆详情**（`?surface=editor` ⇒ `renderDetailShell` ✓）。
	const openEntry = `<button type="button" class="kb-entry kb-entry-primary" data-vssaros-memory-action="open-library">
	<span class="kb-entry-icon">🗃</span>
	<span class="kb-entry-text"><span class="kb-entry-title" data-vssaros-memory-action-label>查看完整记忆</span>
	<span class="kb-entry-meta">在编辑区打开记忆详情（复刻 IDE 的 MemoryDetailEditorPane）</span></span>
	<span class="kb-entry-arrow">›</span></button>`;

	const rows = summary.recent.map(item => `<div class="kb-sum-row" data-vssaros-memory-recent="${escapeHtml(item.id)}">`
		+ `<span class="kb-sum-t" title="${escapeHtml(item.content)}">${escapeHtml(item.title)}</span>`
		+ `<span class="kb-sum-pill">${escapeHtml(item.type)}</span>`
		+ `<span class="kb-sum-time">${escapeHtml(item.timestamp)}</span></div>`).join('');
	const empty = summary.recent.length ? ''
		: `<p class="kb-sum-empty">${!summary.hasGateway ? '记忆网关未配置（config.gatewayUrl / VSSAROS_MEMORY_GATEWAY_URL）'
			: failed.length >= MEMORY_TIERS.length ? '四个分层都取数失败 —— 见下面那行说明'
				: '这个分区还没有记忆'}</p>`;
	const notes = [failNote, timeoutNote].filter(Boolean);
	// 诊断行（照 codebase 的 `summary` 段写法：一段 `.dsh-diag` 带机器可读属性 ✓）
	const diag = `<p class="dsh-diag kb-log" data-vssaros-memory-total="${summary.total ?? ''}" data-vssaros-memory-layers="${summary.layers ?? ''}" data-vssaros-memory-failed="${escapeHtml(failed.join(','))}" data-vssaros-memory-agent="${escapeHtml(summary.agentId ?? '')}" data-vssaros-memory-gateway="${escapeHtml(gateway ?? '')}" data-vssaros-memory-refreshes="${state.refreshes}">agent <code>${escapeHtml(summary.agentId ?? '')}</code> · 网关 <code>${escapeHtml(gateway ?? '(未配置)')}</code><br>${escapeHtml(tiers || '四层都没取到')}${failed.length ? ` · <b>失败层</b> ${escapeHtml(failed.join(' / '))}` : ''}</p>`;

	return renderShell({
		kind: 'memory-sideview',
		title: '记忆库',
		// `subtitle` 实际不渲染（有 `headerHtml` ⇒ renderShell 只用 header ✓）；留着只为"万一没有 headerHtml"也不空 ✓
		subtitle: `只读快照 · 摘要版 · v${PKG_VERSION}`,
		// ⚠ 三层结构由 headerHtml 开、bodyHtml 收（照 codebase ✓）——中途不能插 `dsh-toolbar` 那种独立行 ✗
		// ★★ 2026-10-20（真机报障「记忆 sideview 为空」，截图是整片纯黑）：`.kb-panel` 在**完整版**的
		//   tab 式 CSS 里是 `display: none`，只有 `.kb-panel.active` 才 `display: flex`（见本文件
		//   PAGE_CSS 里那两行）。本页 `extraCss` 复用的正是那份 PAGE_CSS ⇒ 漏掉 `active` 会让
		//   **整个面板** `display:none`：页面加载成功（`did-finish-load` 正常、日志零错误）但内容区
		//   一片黑 —— 这是"日志全绿、界面全空"的典型成因（CSS 隐藏既不报错也不留痕 ✗）。
		//   ⚠ codebase 侧栏不需要 `active`，是因为它的 `.kb-panel` 本身就 `display: flex`
		//   —— 照抄骨架时**别把这一半一起照抄**。
		headerHtml: `<div class="kb-view">
<div class="kb-header">
	<span class="kb-title"><span>🗃</span><span>记忆库</span></span>
	<span class="kb-spacer"></span>
	<span class="kb-stat-hero-label">侧栏摘要</span>
</div>
<div class="kb-panel active">
	<div class="kb-panel-bar"><span class="kb-panel-bar-label">记忆库</span><span class="kb-spacer"></span><span class="kb-stat-hero-label">只读快照 · 写入走 <code>memory_remember</code> 工具 · v${PKG_VERSION}</span></div>
	<div class="kb-panel-content">`,
		bodyHtml: `${openEntry}<div class="kb-stats">
	<div class="kb-stat-grid">
		${cell(number(summary.total), '条记忆', totalTitle)}
		${cell(number(summary.layers), '分层', layerTitle)}
		${cell(workingValue, '工作记忆', workingTitle)}
	</div>
</div>
<div class="kb-side-section">
	<div class="kb-side-section-head"><span>最近记忆</span><span class="kb-spacer"></span><span class="kb-count">${summary.recent.length}</span></div>
	<div class="kb-sum-list">${rows}${empty}</div>
</div>
${notes.length ? `<p class="dsh-diag">${escapeHtml(notes.join('｜'))}</p>` : ''}
${diag}</div>
</div>
</div>`,
		extraCss: PAGE_CSS,
		script: OPEN_LIBRARY_JS,
		// 标准锚点（工作台规范 §7.4；chat-surface 的 probeCatalog 与探针只认这个名字）
		attrs: 'data-vssaros-surface="sideview"',
	});
}

/**
 * 把"非 remember 类写工具"的参数翻成**审批里那行人话**（`buildWriteReason` 的 `content` 位）。
 *
 * 为什么不能只传 `content` ✗：软删除 / 级联 / 结晶的载荷里**没有** `content` —— 若这里返回空串，
 * 闸会退回"取不到载荷"那句 ⚠，`parseWriteReason` 也解析不出 ⇒ 每条都被记成 `(unparsable)` ✗
 *（等于新工具**永远**弹一次"形状可能已变"的窗 ✓✗，那是最像坏了的好不好）。
 * 取不到关键字段就**如实返回空串** ⇒ 上面那条降级路径照旧生效 ✓（不静默造一个假载荷 ✗）。
 *
 * @param {string} toolName - 工具名。
 * @param {Record<string, unknown>} args - `exec.arguments`。
 * @returns {string} 人话载荷（空串 = 取不到）。
 */
function describeWritePayload(toolName, args) {
	if (toolName === 'memory_forget' || toolName === 'memory_cascade') {
		const id = typeof args.memory_id === 'string' ? args.memory_id.trim() : '';
		if (!id) { return ''; }
		const why = typeof args.reason === 'string' && args.reason.trim() ? `（原因：${args.reason.trim()}）` : '';
		return `${toolName === 'memory_forget' ? '软删除（标记 superseded）' : '级联修复（把引用它的下游标 stale）'} memory_id=${id}${why}`;
	}
	if (toolName === 'memory_crystal') {
		// 只有 `create`/`auto` 会走到这里（`isWriteIntent` 已把 list/get 放行 ✓）
		const action = typeof args.action === 'string' ? args.action : '';
		if (!action) { return ''; }
		const actionId = typeof args.action_id === 'string' ? args.action_id.trim() : '';
		return action === 'create'
			? `行动链结晶 action_id=${actionId}`
			: `自动结晶（把高强度记忆转成结晶）`;
	}
	if (toolName === 'memory_routine') {
		// 只有会改数据的 action 才走到这里（`isWriteIntent` 已把 list/get/status 放行 ✓）
		const action = typeof args.action === 'string' ? args.action : '';
		if (!action) { return ''; }
		const routineId = typeof args.routine_id === 'string' ? args.routine_id.trim() : '';
		const runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
		const name = typeof args.name === 'string' ? args.name.trim() : '';
		const detail = action === 'create' ? (name ? `name=${name}` : '')
			: action === 'step' ? `run_id=${runId} step_order=${String(args.step_order ?? '?')} → ${String(args.step_status ?? 'done')}`
				: `routine_id=${routineId || runId}`;
		return `例程（routine）${action}${detail ? ` ${detail}` : ''}`;
	}
	if (toolName === 'memory_governance') {
		// 只有 `delete` / `bulk_delete`（且 dry_run=false）会走到这里 ✓；`audit` 与 dry-run 已被判据放行 ✓
		const action = typeof args.action === 'string' ? args.action : '';
		if (!action) { return ''; }
		if (action === 'delete') {
			const ids = Array.isArray(args.ids) ? args.ids.filter(id => typeof id === 'string' && id.trim()) : [];
			return ids.length ? `按 id 删除 ${ids.length} 条记忆：${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ' …' : ''}` : '';
		}
		if (action === 'bulk_delete') {
			const f = args.filters && typeof args.filters === 'object' ? args.filters : {};
			return `按条件**真正删除**记忆（filters=${JSON.stringify(f).slice(0, 160)}，dry_run=false ✓ 会真删）`;
		}
		// 2026-10-14：新增的两个写 action 也要有审批文案 ✓
		// ⚠ 缺了它，弹窗只显示工具名（`memory_governance`）而**不说明要动什么** ✗ ——
		//   审批的意义正是"让人看清内容后再放行" ✓（与 `update` 那条的处境相同 ✓）。
		if (action === 'compress') {
			const sid = typeof args.session_id === 'string' ? args.session_id.trim() : '';
			return sid ? `压缩会话 ${sid} 的未压缩观察为叙事摘要（**不可逆** ⚠ 那些观察会被标记为已压缩）` : '';
		}
		if (action === 'frontier') {
			const c = typeof args.concept === 'string' ? args.concept.trim() : '';
			return c ? `把概念「${c}」加入**待探索的前沿队列**` : '';
		}
		return '';
	}
	if (toolName === 'memory_team') {
		// 只有 `share` 会走到这里 ✓（`query` 只读 ✓）
		const memId = typeof args.memory_id === 'string' ? args.memory_id.trim() : '';
		return memId ? `把记忆 ${memId} 共享到**团队池**${args.project ? `（project=${String(args.project)}）` : ''}` : '';
	}
	if (toolName === 'memory_mesh') {
		const action = typeof args.action === 'string' ? args.action : '';
		if (!action) { return ''; }
		if (action === 'join') {
			const name = typeof args.name === 'string' ? args.name.trim() : '';
			const url = typeof args.url === 'string' ? args.url.trim() : '';
			return name && url ? `加入联邦 peer「${name}」（${url}）` : '';
		}
		if (action === 'leave') { return `让 peer ${String(args.peer_id ?? '?')} 下线`; }
		if (action === 'sync') { return `与 peer 同步记忆（direction=${String(args.direction ?? 'both')}${args.peer_id ? `, peer=${String(args.peer_id)}` : '（全部在线 peer）'}）`; }
		return '';
	}
	if (toolName === 'memory_sentinel') {
		// ⚠ 只有 `create`/`check`/`cancel` 会走到这里 ✓（`check` 会**触发**哨兵 ⇒ 算写 ✓）
		const action = typeof args.action === 'string' ? args.action : '';
		if (!action) { return ''; }
		if (action === 'create') {
			const name = typeof args.name === 'string' ? args.name.trim() : '';
			const condition = typeof args.condition === 'string' ? args.condition.trim() : '';
			return name && condition ? `新建哨兵「${name}」监视条件：${condition}` : '';
		}
		if (action === 'check') { return '立即评估所有哨兵（**可能触发**它们 ✓）'; }
		if (action === 'trigger') { return `**直接触发**哨兵 ${String(args.sentinel_id ?? '?')}（**跳过条件评估** ⇒ 一定会置为已触发 ✓）`; }
		if (action === 'cancel') { return `取消哨兵 ${String(args.sentinel_id ?? '?')}`; }
		return '';
	}
	if (toolName === 'memory_improve') {
		const action = typeof args.action === 'string' ? args.action : '';
		const memId = typeof args.memory_id === 'string' ? args.memory_id.trim() : '';
		if (!action || !memId) { return ''; }
		return `改进记忆 ${memId}（${action}）`;
	}
	return '';
}

/**
 * `memory_api` 的**只读白名单**（2026-10-13 建）。
 *
 * ## 为什么要它
 * 引擎（`agentMemoryProviderV2`）公开约 200 个方法，但**每个方法都做成工具**是不可行的：
 * 工具定义进**系统提示词** ⇒ 17 → 77 个会让每次会话的提示词膨胀数倍，而 90% 的工具在 90% 的
 * 会话里用不到 ✗。⇒ 用**一个通用入口**覆盖一批只读能力，把上下文成本从 O(方法数) 降到 O(1) ✓。
 *
 * ## 名单怎么定出来的（**不是照抄引擎方法清单** ✗）
 * 候选先逐个在**真机网关**上实测（隔离端口 + 隔离数据目录），并且**分两轮**：第一轮裸调、
 * 第二轮先把"需要前置数据"的那批喂上数据（写 lesson / 建 checkpoint 与 snapshot / 加 skill /
 * observe / 写 semantic-procedural / enrichFile）再调 ✓。
 * ⚠ 没有第二轮就会把"**我没造数据**"误判成"**引擎没实现**" ✗（第一轮 17 个有货，第二轮 27 个 ✓）。
 *
 * ## 两种**不收录**（都要写下来，否则后来人会当成漏了再补一遍 ✗）
 * 1. **铁证桩**：源码里是单行体空实现 ⇒ 永远回空，做成工具只会**消耗调用并误导模型** ✗
 *    判据是"**源码是不是 `{ return <空常量>; }` 单行体**"（`p3-80` 的 ⑩ 自动扫 `agentMemoryProviderV2.ts`
 *    对账 ⇒ 白名单里混进一个就红 ✓）。
 *    **全清单（17 个，2026-10-13 扫出）** —— 别再把它们当"漏掉的"补一遍 ✗：
 *      `getTimeline` · `getTopLessons` · `searchLessons` · `traceProvenance` · `verifyProvenance` ·
 *      `enrichFile` · `setWorkingMemory` · `getWorkingMemory` · `getAllWorkingMemory` · `getFileIndex` ·
 *      `getActions` · `getSignals` · `restoreSnapshot` · `getCircuitStates` · `getRecentSearches` ·
 *      `registerHook` · `unregisterHook`
 *    ⚠⚠ 顺带纠正一处**我早先的判断**：我曾说"provenance 引擎早就有、只是没接出来" —— **错了** ✗，
 *    `ProviderV2` 上的 `traceProvenance` / `verifyProvenance` **是未实现的桩**（`provenance.ts` 那个
 *    151 行的模块**没有被 ProviderV2 接上**）⇒ 这条能力**在 dsh 侧无论怎么接都拿不到** ✓。
 *    ⚠ 判据为什么不能用"**实测回空**"：它**分不开**"没实现"与"没数据" ✗✗ —— 同一批方法裸测回空、
 *      造了前置数据就有货（普查时 17 → 27 ✓），而 `traceProvenance` 造什么都回 null ✓。
 * 2. **未证实**：实测回空，但**不能排除**是"还缺更特殊的前置数据"（如 `store.semantic` 不走
 *    `writeMemory`、profile 需要专门的构建步骤）⇒ 宁可**不收录**也不给模型一个"大概能返回点什么"
 *    的入口 ✗（与 `p3-51` 那条"能返回点什么 ≠ 精确匹配"同一判据 ✓）。要加先补一条能**造出数据**
 *    的对照，再进这张表 ✓。
 *
 * ## `args` 一栏的口径
 * 只写**除 `agentId` 之外**的位置参数（`agentId` 由 execute 自动前置，模型不该也不能传 ✗ ——
 * 手填 agentId 等于让它有机会写到别的分区去 ✓）。`?` 表示可选。
 */
const MEMORY_API_READONLY = new Map([
	// ── 分层读取 / 记忆清单 ─────────────────────────────────────────────
	['getEpisodicMemories', { args: '', note: '读情景记忆（按时间线，最接近“发生过什么”）' }],
	['getProceduralMemories', { args: '', note: '读程序性记忆（做法/步骤，引擎从技能等沉淀）' }],
	['proceduralList', { args: '', note: '程序性记忆清单（含技能沉淀物）' }],
	// ── 会话与观察 ──────────────────────────────────────────────────────
	['listSessions', { args: '', note: '本 agent 有记录的会话清单' }],
	['observeList', { args: 'sessionId', note: '某会话的观察记录（hook 落下的原始观测）' }],
	['observeCount', { args: 'sessionId', note: '某会话的观察条数' }],
	// ── 检索（比 memory_search 更强）────────────────────────────────────
	['smartSearch', { args: 'query, limit?', note: '★ 多策略检索（可给答案）——优先于 memory_search 用于“找相关的一批”' }],
	['smartSearchWithAnswer', { args: 'query, limit?', note: '★ 检索并尝试给答案（⚠ 引擎未配 LLM 时回 `{skipped:true, reason:"llm not configured"}`，要如实转述 ✓）' }],
	['expandQuery', { args: 'query', note: '查询改写（同义/时间/实体展开）——可用于把模糊问句变具体' }],
	['skillMatch', { args: 'task, limit?', note: '★ 按任务描述匹配**技能**（返回 skill + 匹配理由）' }],
	// ── 统计与诊断 ──────────────────────────────────────────────────────
	// ⚠⚠ 这条的 note **改正过**（2026-10-14）：原先写"比 `memory_stats` 可信" ✗ —— 它**自己也有坑**：
	//   `{...stats, bm25IndexSize: s.indexSize, vectorIndexSize: 0}` ⇒ `vectorIndexSize` 是**硬编码 0** ✗，
	//   而 `bm25IndexSize` 取自 `_serverStats`，dsh 走**网关模式**（`serverAvailable: false`）⇒ **实测恒 0** ✗✗
	//   （我在 2000 条、检索明明有效时看到 `bm25IndexSize: 0` ✓ ⇒ 是**观测字段**坏了，不是索引没建 ✓）。
	//   ⇒ 它**能用**的只有 `longTermCount` / `coreMemoryCount` / `lessonsCount` 这几个（`getStats` 那层 ✓）
	//     —— 而 `getStats` **自己**在写入后也可能回 0（早先实测过 ✗）⇒ **两者都别当权威** ✓。
	['getExtendedStats', { args: '', note: '扩展统计（长期/核心/课程数）——⚠ `bm25IndexSize`/`vectorIndexSize` 在网关模式下**恒为 0**（观测字段坏，不代表索引没建 ✗）；计数也别当权威' }],
	['followupStats', { args: 'windowMs?', note: '检索后的追问率统计' }],
	['diskSize', { args: '', note: '各分区的磁盘占用' }],
	['diagnose', { args: '', note: '★ 自诊断（逐层计数 + status）——排障首选' }],
	['runDiagnostics', { args: '', note: '运行诊断（status / serverAvailable）' }],
	['getHealthStatus', { args: '', note: '健康状态' }],
	// ── 课程 / 槽位 / 关系 / 检查点 ─────────────────────────────────────
	['getLessons', { args: '', note: '★ 课程清单（从错里学到的）' }],
	// ⚠⚠ **这两个不是"纯只读"** —— 2026-10-13 用"真机副作用审计"查出来的（**代码审计看不出来** ✓）：
	//   `slotList` 的第一行是 `await seedDefaults(kv, agentId)` ⇒ **首次调用会 `kv.set` 8 个缺省槽位**
	//   （`persona` / `user_preferences` / `tool_guidance` … 都是**空内容** ✓，见 `amSlots.ts:18-32` ✓）。
	// ⇒ 判它"不过闸"**仍然是对的**（判据是"**会不会改用户数据**"，而它只补引擎自己的空缺省项 ✓ ——
	//   与 `dry_run` 缺省 true、`memory_refresh` 不算写是同一条判据 ✓），但**不能标成"纯只读"** ✗。
	// ⇒ 真实性质由 `p3-80` 的 ⑰ 守着：调它**不会改动任何已有槽位的内容** ✓（只会**新增**缺省项 ✓）。
	['getSlots', { args: '', note: '全部槽位（name + content）⚠ 首次调用会由引擎补 8 个**空**缺省槽位（不改你已有的内容 ✓）' }],
	['slotList', { args: '', note: '全部槽位（含 sizeLimit / description，比 getSlots 详细）⚠ 同 `getSlots`：首次调用会补空缺省槽位 ✓' }],
	['getSlot', { args: 'label', note: '读单个槽位的内容（label 见 slotList）' }],
	['getRelationStats', { args: '', note: '记忆关系网规模' }],
	['checkpointList', { args: '', note: '检查点清单' }],
	['snapshotList', { args: '', note: '快照清单' }],
	// ── 技能 ────────────────────────────────────────────────────────────
	['listSkills', { args: '', note: '★ 技能清单（含 id / trigger / title）——记忆引擎的“技能”，**不是**平台的 SKILL.md ✗' }],
	['skillList', { args: '', note: '技能清单（与 listSkills 同源，保留两者以对齐引擎）' }],
	['getSkillStats', { args: '', note: '技能统计（总数 / 平均置信度 / 使用次数）' }],
	// ── 审计与规模 ──────────────────────────────────────────────────────
	['getAuditSummary', { args: '', note: '审计摘要（写入条数等）' }],
	['listAllAgentsWithData', { args: '', note: '哪些 agent 分区里有数据（⚠ 只看得到**本网关**上的分区）' }],
	// ── 导出（2026-10-13 收）─────────────────────────────────────────────
	// ⚠ 为什么"导出"进**只读**白名单、而"导入"另做一个工具（`memory_import`）：
	//   `exportMemories` 只**读**（返回 `{version, exportedAt, agentId, memories[]}` ✓），
	//   `importMemories` / `replayImportJsonl` 只**写** ⇒ 读写本就该分在两侧 ✓
	//   ⇒ 于是**不需要**一个"既导又入"的 `memory_transfer`（那会与已有的 `memory_obsidian_export`
	//     形成"两个导出"的局面，模型得猜该用哪个 ✗）⇒ 边界按**读/写**切，比按"导入导出"这个词切更清楚 ✓。
	['exportMemories', { args: '', note: '★ 导出全部记忆（`{version, exportedAt, agentId, memories[]}`）—— 可存档，或用 `memory_import` 导回 ✓' }],

	// ── 2026-10-13 全量对账后补入（+13）──────────────────────────────────
	// 动机：把引擎 226 个公开方法**逐个对账**（已接 / 桩 / 明确不做 / 未接）⇒ 还剩一批**只读的真实现**
	// 没接。只读的补进白名单是**零成本**的（不加工具、不加提示词）⇒ 没有理由不接 ✓。
	// ⚠ 以下都是 `async … { …真实实现… }`（非桩 ✓）；是否真有数据由引擎沉淀决定，不在这里保证 ✓
	//   （"收录"的判据见本表头注释：**源码不是单行体空实现**即可 ✓）。
	['coreMemoryList', { args: '', note: '读**核心记忆**（每轮都进提示词的常驻层；`memory_remember` 的 `working` 型就落这里 ✓）' }],
	['getCompactContext', { args: 'limit?', note: '压缩后的上下文文本（长会话里"已经把什么压掉了"的可见形式 ✓）' }],
	['getConsolidationContext', { args: '', note: '固化上下文（引擎把短期沉淀为长期时的输入 ✓）' }],
	['temporalQuery', { args: 'entity', note: '按实体查时间线（"这事的来龙去脉" ✓）' }],
	['getSmartSearchResults', { args: 'query, options?', note: '智能检索的**结构化**结果（要 id/分数等字段用它；要现成文本用 smartSearch ✓）' }],
	['teamProfile', { args: 'teamId?', note: '本 agent 在团队池里的画像' }],
	['teamFeed', { args: 'limit?, teamId?', note: '团队池动态流' }],
	['meshExport', { args: 'scopes?, since?', note: '联邦（mesh）导出负载 —— 给对端同步用 ✓' }],
	['claudeBridgeRead', { args: '', note: '读 Claude Code 桥接进来的条目（从 Claude 侧迁过来的记忆 ✓）' }],
	['runExtendedDiagnostics', { args: '', note: '扩展诊断（比 `diagnose` 多几层计数 ✓）' }],
	['circuitStatesGet', { args: '', note: '熔断状态（引擎对上游出错时的自保护状态 ✓）' }],
	['richFileContext', { args: 'files[], concepts?', note: '文件上下文的**丰富版**（比 `getFileContext` 多概念维度 ✓）' }],
	['diffFileContext', { args: 'filesChanged[]', note: '**改动过**的文件涉及哪些记忆 —— 改代码前先看这里 ✓' }],
	// ⚠ **刻意不收**（首参不是 agentId ⇒ 与本工具"自动前置 agentId"的约定冲突，硬收会传错参数 ✗）：
	//   `getReplaySession(sessionId)` · `getHookStats()` · `getCommitStats()` · `getRecentCommits(limit?)`。
	//   ⚠ 另：`getStats` 虽是真实现，但**实测在写入 4 条后仍回 0** ✗ ⇒ 不收（用 `getExtendedStats` ✓）。

	// ── 引擎自沉淀的层（2026-10-13 三次普查后补入，+11）────────────────────
	// ⚠ 为什么第一版没收它们：真机裸测**恒回空** ✗。但二轮普查（造前置数据）也没填上 ⇒ 当时判为
	//   "未证实"。**第三轮改判**：去读**源码** ⇒ 它们是**多行真实现**（`_kv.list(KV.semantic(...))` /
	//   `fn.sessionSummaryList(...)` / `pipe.getProfile(...)` / `rem.replayList(...)` …），只是数据由
	//   **引擎自己的管线**在真实使用中沉淀 ⇒ **我在探针里造不出来 ≠ 能力不存在** ✗✗。
	// ⇒ 判据改为「**源码是不是单行体空实现**」：是 ⇒ 桩，绝不收录；否 ⇒ 收录（数据有没有由引擎决定 ✓）。
	//   这条判据比"实测回空"可靠得多 —— 实测**分不开**"没实现"与"没数据" ✓（见 `p3-80` 的 ⑩）。
	// ⚠ `visionSearch` **故意不在此表**：它也是真实现，但需要**图像**数据，而 dsh 侧没有任何图像写入
	//   路径 ⇒ 收录了也**永远回空**，只会浪费一次调用 ✗（要加先得有一条真的能写图像的路径 ✓）。
	['getSemanticMemories', { args: '', note: '读语义记忆（由固化管线产出，非手动写入）' }],
	['semanticList', { args: '', note: '语义层清单（同上）' }],
	['listSummaries', { args: 'limit?', note: '会话摘要清单（需先有 summarizeSession 产出）' }],
	['getReplaySessions', { args: '', note: '可回放的会话清单' }],
	['insightSearch', { args: 'query, limit?', note: '洞察检索（insights 由引擎沉淀）' }],
	['getProfile', { args: '', note: 'agent 画像（由管线构建，未构建时回 null 是**正常**的 ✓）' }],
	['getRelations', { args: 'memoryId', note: '某条记忆的关系网（id 先用 memory_list 拿）' }],
	['frontierGet', { args: '', note: '前沿队列（待处理项）' }],
	['frontierNext', { args: 'project?, agentIdentity?, includeLeasedByOthers?', note: '取下一个前沿项' }],
	['getFileContext', { args: 'filePath', note: '文件上下文（该文件相关的记忆聚合）' }],
	['bugMemoriesForFiles', { args: 'files[], project?', note: '与这些文件相关的 bug 记忆' }],

	// ── 信号（2026-10-14 真机实测后补入）─────────────────────────────────
	// ⚠ 为什么不直接用它替换已接的 `signalQuery`：两者**排序口径不同** ✗ ——
	//   `signalQuery` 按 `createdAt` **降序**（新的在前 ✓，见 `amAdvanced.ts:115`）；
	//   而这个 `signalQueryExpanded` **不排序**（KV 原序 ✗）⇒ 各有各的用处 ✓。
	// ⚠ 它的**增量**在于**过滤**：可按 `type` / `from` 筛，且**会剔除已过期**的（`amFinal.ts:503-507` ✓）。
	//   真机实测：`type='info'` 只回 info ✓、`from='别的 agent'` 回 `[]` ✓ ⇒ 过滤确实生效 ✓。
	['signalQueryExpanded', { args: 'type?, from?', note: '信号检索（可按 type/from 过滤，且**自动剔除过期** ✓）—— ⚠ 与 `signalQuery` 的差别是**它会过滤、且不按时间排序** ✓' }],
]);

/** 工具定义（八个只读 + 四个写入）。写入也**只经网关**（本进程从不自己拼记忆的存储形状）。 */
function toolDefinitions(ctx, state, config, auditAppend) {
	return [{
		name: 'memory_remember',
		description: '把一条记忆写进当前 Agent 的记忆库。`memory_type` 里 `working` 进**核心槽位**（每轮对话都会带上，留给"当前任务与偏好"这类），其余原生类型（pattern / preference / architecture / bug / workflow / fact）进**长期记忆**；`semantic` / `procedural` **不接受手动写入**（由固化管线产出）。'
			+ ' ⚠ 这是**写**：只在确实值得跨会话记住时用（结论、偏好、踩过的坑、约定），不要记流水账。',
		parameters: {
			type: 'object',
			properties: {
				content: { type: 'string', description: '要记住的内容（一句话说清，别贴长文）' },
				memory_type: {
					type: 'string',
					enum: ['working', 'pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'],
					description: '记忆类型（缺省 fact）；working = 核心槽位，其余 = 长期记忆',
				},
				// 受限 schema 子集里没有 minimum/maximum：范围写在描述里、由代码夹紧（与 memory_search 的 limit 同法）
				importance: { type: 'integer', description: '重要度 0–10（缺省 5；超出会被夹到边界）' },
				tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
			},
			required: ['content'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, memory_type: { type: 'string' }, target: { type: 'string' }, reply: { type: 'string' },
				},
				required: ['ok', 'memory_type'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok ? `已写入${value.target}（${value.memory_type}）` : `写入失败：${value.reply ?? '网关没有返回可读信息'}`,
			}],
		},
		execute: async params => {
			const base = requireGateway(config);
			const content = typeof params?.content === 'string' ? params.content.trim() : '';
			if (!content) {
				throw new Error('content 不能为空');
			}
			// ★ 写入预算（与 legacy 同纪律；口径 = **每 Host 运行**，见 `writeBudgetOf`）——
			// 拦在**打网关之前**：超限时不产生任何网络调用、也不消耗写配额 ✓。
			const agentId = agentIdOf(config);
			const budget = writeBudgetOf(config, agentId);
			const used = state.writes.get(agentId) ?? 0;
			if (used >= budget) {
				// 错误信息照 legacy 的用意（`memoryTools.ts:100-103`）：不是"你坏了"，而是**引导改用检索** ✓
				throw new Error(`记忆写入预算已用尽（本 Host 运行 ${budget} 次上限，agentId=${agentId}）：请优先用 memory_search 复用已有记忆，或把结论写进最终回复，而不是继续写。`);
			}
			state.writes.set(agentId, used + 1);
			const memoryType = typeof params?.memory_type === 'string' && params.memory_type ? params.memory_type : 'fact';
			const importance = Math.min(10, Math.max(0, Number.isFinite(params?.importance) ? Math.floor(params.importance) : 5));
			const tags = Array.isArray(params?.tags) ? params.tags.filter(tag => typeof tag === 'string' && tag.trim()) : [];
			// ⚠ **真机订正（2026-10-13）**：**没有** `mem::core-add` / `mem::remember` 这两个方法 ✗（都 404 ✗）；
			// 类型路由（`working`/`short_term` ⇒ core，其余 ⇒ 长期层）**发生在网关侧**（引擎按 `entry.type` 自己分叉 ✓）
			// ⇒ 本进程只发一次 `POST /provider/writeMemory {args:[agentId, entry]}` ✓，不再自己分流 ✗。
			// `entry` 形状**逐字照抄** IDE 侧 `memory_remember`（`memoryTools.ts:137-146` ✓）。
			const entry = {
				id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
				type: memoryType,
				content,
				timestamp: Date.now(),
				importance,
				metadata: { importance, ...(tags.length ? { tags } : {}) },
			};
			// 审计「执行结果」这一格：**包住网关调用** ⇒ 网关拒了（HTTP 非 2xx / 超时 / 明确失败）
			// 也能留痕 ✓ —— 只在拿到 reply 之后记会漏掉"网关抛错"这类最需要排查的情形 ✗。
			// 用已算出的局部 `agentId`（＝ `agentIdOf(config)`，即记忆落的分区）而非再算一次 ✓。
			const auditBase = {
				action: 'executed', tool: 'memory_remember', agentId,
				target: targetKeyOf(memoryType), memoryType, content,
			};
			let reply;
			try {
				reply = await remember(base, agentId, entry);
			} catch (error) {
				await auditAppend({ ...auditBase, outcome: 'failed', error });
				throw error; // 记完**必须重抛** —— 审计绝不改变工具行为 ✓
			}
			// 网关回复**原样**判断与回传：形状里未核实的那部分靠真机错误暴露（本文件与 gateway.js 的既有口径）。
			// 只有网关**明确**说成功才算成功——"没报错"不算（写操作上这条尤其要紧）。
			const ok = reply?.ok === true || reply?.success === true;
			await auditAppend({ ...auditBase, outcome: ok ? 'ok' : 'rejected-by-gateway' });
			// 写成功后**主动刷新默认槽位**（报告 §5-7 的另一半 ✓）：否则页面会在"写入前"的工作记忆上停着 ✗
			// —— 刚写进去的东西看不见，最容易被当成"写失败" ✗。
			// ⚠ 只刷**默认槽位**（页面/新会话/种子用）✓；**不动各会话正冻结着的槽位** —— 那是 2026-10-13
			// 的冻结语义：本会话想立刻看见刚写的内容，走 `memory_refresh`（它会把冻结表清掉重取 ✓）。
			// 用 `void`：写工具的回执不该等一次网关往返 ✓（刷新失败不影响"写入成功"这个事实 ✓）。
			if (ok) {
				void refresh(state, config);
			}
			return {
				ok,
				memory_type: memoryType,
				target: targetLabelOf(memoryType),
				...(ok ? {} : { reply: JSON.stringify(reply ?? null).slice(0, 400) }),
			};
		},
	}, {
		name: 'memory_list',
		description: '**列出**当前 Agent 记忆库里的条目（只读）。空查询 = 全量列出（与 legacy 的 `memory_list` 同法：`provider.searchMemory(agentId, \'\')`）。⚠ 2026-10-13 起检索走 provider 平面（`searchMemory` ✓）⇒ 返回的是**完整条目**（含正文 ✓）；宿主路由 `/search/<agentId>` 只给 `{id,score}` 且空查询恒为 `[]` ✗，那条路已弃用。'
			+ ' ⚠ dsh 侧此前**只能检索、不能列举** ⇒ 写进去的东西得靠 memory_search 撞词才看得见，"越写越多、看不见"会把人逼回 IDE（README 5.59）。',
		parameters: {
			type: 'object',
			properties: {
				limit: { type: 'integer', description: '返回条数上限，1–100（默认 20；超出会被夹到边界）' },
				partition: { type: 'string', enum: ['current', 'legacy'], description: '缺省 `current` = 当前工作区分区 + 当前人设的分区（人设积累的记忆跟人设走）；选 `legacy` 列**旧分区**（`default`：本插件按工作区隔离之前的数据；它不再被注入，但可从这里显式查回来）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'integer' },
					limit: { type: 'integer' },
					partition: { type: 'string' },
					partitions: { type: 'array', items: { type: 'string' } },
					notes: { type: 'array', items: { type: 'string' } },
					items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, score: { type: 'number' }, partition: { type: 'string' } }, required: ['id'] } },
				},
				required: ['count', 'items'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.count
					? `记忆库（分区 ${value.partition ?? '?'}）列出 ${value.count} 条（上限 ${value.limit}）：${value.items.map(item => item.id).join(', ')}`
					: `分区 ${value.partition ?? '?'} 里没有可列出的条目（或用空查询取不到——那就换 memory_search 试试别的词）。`,
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params, exec) => {
			const base = requireGateway(config);
			// ⚠ 空查询**就是**全量列出（与 legacy 同法）—— 这不是漏了参数 ✓
			const rawLimit = Number.isFinite(params?.limit) ? Math.floor(params.limit) : 20;
			const limit = Math.min(100, Math.max(1, rawLimit));
			// `partition: 'legacy'` ⇒ **旧分区的显式出口**（旧混合记忆不再注入，但必须查得回来 ✓）
			if (params?.partition === 'legacy') {
				const normalized = normalizeSearchResults(await search(base, LEGACY_PARTITION, '', limit), limit);
				if (normalized.error) {
					throw new Error(normalized.error);
				}
				return { count: normalized.items.length, limit, partition: LEGACY_PARTITION, items: normalized.items };
			}
			// ★ 2026-10-20：缺省 = 工作区分区 **+ 当前人设分区**（口径见 `readScopeOf`）
			const scope = readScopeOf(config, state, exec?.agent);
			const merged = await searchPartitions(base, scope.partitions, '', limit);
			if (merged.error) {
				throw new Error(merged.error);
			}
			return { count: merged.items.length, limit, partition: scope.partitions.join(' + '), partitions: scope.partitions, items: merged.items, ...(merged.notes.length ? { notes: merged.notes } : {}) };
		},
	}, {
		name: 'memory_search',
		description: '在当前 Agent 的记忆库里检索条目，返回命中的记忆 id 与相关度分数（正文需用 memory_stats / 记忆页面查看）。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '检索词（自然语言即可）' },
				// dsh 的参数 schema 只接受受限子集（无 minimum/maximum）：范围写描述、由代码夹紧
				limit: { type: 'integer', description: '返回条数上限，1–100（默认 10；超出会被夹到边界）' },
				partition: { type: 'string', enum: ['current', 'legacy'], description: '缺省 `current` = 当前工作区分区 + 当前人设的分区（合并按分数排序，每条标注来源分区）；选 `legacy` 检索**旧分区**（`default`：按工作区隔离之前的数据；它不再被注入，但可从这里显式查回来）' },
			},
			required: ['query'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'integer' },
					partition: { type: 'string' },
					partitions: { type: 'array', items: { type: 'string' } },
					notes: { type: 'array', items: { type: 'string' } },
					items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, score: { type: 'number' }, partition: { type: 'string' } }, required: ['id'] } },
				},
				required: ['count', 'items'],
			},
			// ⚠️ `tools.register` 要求 output 里**必须有 render**（不是可选）：
			// 只写 schema 会抛 `tool "x" must declare output { schema, render, presentationMeta? }`，
			// 而它的表现是**整个插件不挂载**（真机 404，只有 Host 日志里有线索）。kanban 的写法就是对的。
			// ★ 2026-10-14：**按分数分组**输出（`splitByConfidence` ✓）。
			// 为什么必须分组：引擎 `searchMemory` **每查询恒回 20 条、且不做阈值截断**（实测：30 条库里搜
			// 「构建」回 20 条，其中**只有 2 条真相关** ✓）⇒ 默认 `limit=10` 时模型拿到的是
			// 「1–2 条真相关 + 8–9 条噪声」，而 `(0.0027)` 与 `(0.5081)` 在它眼里只是**两个小数** ✗
			// —— 它**没有**"多少分才算低"的标尺 ⇒ 很容易把噪声当命中用 ✗。这条把标尺内建进来 ✓。
			// ⚠ 低置信的 **id 仍然列出**（不替模型做"丢弃"的决定 ✓），只是明确标注"一般可忽略" ✓。
			// ⚠ **0 条高置信**是必须显式说的情形：那意味着"库里大概真没有"，不说的话模型会拿噪声硬答 ✗。
			render: (_args, value) => {
				if (!value?.count) {
					return [{ type: 'text', text: `分区 ${value?.partition ?? '?'} 里没有命中任何记忆条目。` }];
				}
				const { high, low } = splitByConfidence(value.items);
				// ⚠ 分数**统一三位**：`toFixed(2)` 会把 0.0027 打成 `0.00` ⇒ 噪声与零分无法区分 ✗
				//   （修好读取之前一直是 `undefined` ⇒ 这个坑此前看不到 ✓）
				const fmt = list => list.map(i => `${i.id}(${typeof i.score === 'number' ? i.score.toFixed(3) : '?'})`).join(', ');
				const lowScores = low.map(i => i.score).filter(s => typeof s === 'number');
				const lines = [`命中 ${value.count} 条（分区 ${value.partition ?? '?'}）：${high.length
					? `${high.length} 条高置信（分数 ≥${SEARCH_CONFIDENCE_THRESHOLD}）`
					: '**0 条高置信**'}`];
				if (high.length) {
					lines.push(`  ${fmt(high)}`);
				} else {
					lines.push('  ⚠ 没有一条达到高置信阈值 ⇒ 下面这些**很可能都与查询无关**'
						+ '（引擎在没有匹配时也会回填满额结果 ⇒ 别拿它们硬答 ✗）：');
				}
				if (low.length) {
					lines.push(`  低置信 ${low.length} 条（分数 `
						+ `${lowScores.length ? Math.min(...lowScores).toFixed(3) : '?'}–${lowScores.length ? Math.max(...lowScores).toFixed(3) : '?'}`
						+ '，通常是引擎无匹配时的模糊填充 ⇒ 一般可忽略）：');
					lines.push(`  ${fmt(low)}`);
				}
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		isConcurrencySafe: () => true,
		execute: async (params, exec) => {
			const base = requireGateway(config);
			const query = typeof params?.query === 'string' ? params.query : '';
			const rawLimit = Number.isFinite(params?.limit) ? Math.floor(params.limit) : 10;
			const limit = Math.min(100, Math.max(1, rawLimit));
			// `partition: 'legacy'` ⇒ **旧分区的显式出口**（同 memory_list ✓）
			if (params?.partition === 'legacy') {
				const normalized = normalizeSearchResults(await search(base, LEGACY_PARTITION, query, limit), limit);
				if (normalized.error) {
					throw new Error(normalized.error);
				}
				return { count: normalized.items.length, partition: LEGACY_PARTITION, items: normalized.items };
			}
			// ★ 2026-10-20：缺省 = 工作区分区 **+ 当前人设分区**（`exec.agent` 是调用方会话 —— dsh-tools 的 `ToolRunContext`）
			const scope = readScopeOf(config, state, exec?.agent);
			const merged = await searchPartitions(base, scope.partitions, query, limit);
			if (merged.error) {
				throw new Error(merged.error);
			}
			return { count: merged.items.length, partition: scope.partitions.join(' + '), partitions: scope.partitions, items: merged.items, ...(merged.notes.length ? { notes: merged.notes } : {}) };
		},
	}, {
		name: 'memory_stats',
		description: '查看当前 Agent 记忆库的统计信息（条目数等，字段由记忆网关决定）。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: { agentId: { type: 'string' }, summary: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } },
				required: ['agentId', 'summary'],
			},
			render: (_args, value) => [{ type: 'text', text: `${value.agentId} 的记忆库：${value.summary}` }],
		},
		isConcurrencySafe: () => true,
		execute: async () => {
			const base = requireGateway(config);
			return { agentId: agentIdOf(config), ...summarizeStats(await stats(base, agentIdOf(config))) };
		},
	}, {
		name: 'memory_refresh',
		description: '强制刷新工作记忆快照：刷新页面/新会话用的那一份，并解冻各会话的冻结快照（刚写入重要记忆后调它，下次请求就带新内容）。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, chars: { type: 'integer' }, frozen: { type: 'integer' }, error: { type: 'string' } },
				required: ['ok', 'chars'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `工作记忆已刷新：${value.chars} 字（下一次请求就带新内容${value.frozen > 0 ? `；同时解冻了 ${value.frozen} 份会话快照，它们下一轮各自重取` : ''}）`
					: `刷新失败：${value.error}`,
			}],
		},
		execute: async () => {
			// ★ 冻结语义下的"立刻生效"（2026-10-13 起）：
			//   (a) 刷**默认槽位** —— 页面 / 新会话 / 种子用的那份 ✓；
			//   (b) **清空冻结表** ⇒ 正在冻结的会话槽位作废，下一轮 assembly 重新登记并重取 ✓。
			// 为什么是"清表"而不是"逐个刷" ✗：工具执行阶段**拿不到装配主体** —— `AssembleContext`
			// （含 `scope` / `agent`）只在 section 的 text provider 里给（见 `snapshotFor`）⇒ 无法定位
			// "当前是哪个会话"。清表是**保守且正确**的做法：多花几次网关往返，换来"所有会话立刻看到" ✓。
			// 先清后刷：这样新登记的槽位能直接借到刚刷新好的默认槽位当种子（首轮即有内容 ✓）。
			const frozen = state.snapshots.size;
			state.snapshots.clear();
			const snapshot = await refresh(state, config);
			return { ok: snapshot.ok, chars: snapshot.text.length, frozen, ...(snapshot.ok ? {} : { error: snapshot.error }) };
		},
	}, {
		// ── 2026-10-13 批 1 ────────────────────────────────────────────────
		// 命名 / 参数 / 回复语义一律照 IDE 真源（注释里逐条给了行号）—— dsh 侧**只做**"过闸 + 走 provider 平面"。
		name: 'memory_recall',
		description: '**多策略**召回记忆（比 memory_search 更强）：可选 hybrid（BM25＋向量）/ graph_first / vector_first / graph_only / vector_only 并带重排；网关不支持该方法时**自动回退 memory_search**。只读。'
			+ ' 缺省还会附上**近 30 天同一工作区的历史会话片段**（会话原文、未经审核；`history: false` 关闭）——问"之前做过/聊过什么"时用它。'
			+ ' ⚠ 想"按词撞"用 memory_search，想"按语义捞一批"用这个 ✓。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '检索词（自然语言即可）' },
				strategy: { type: 'string', enum: ['hybrid', 'graph_first', 'vector_first', 'graph_only', 'vector_only'], description: '检索策略（缺省 hybrid）' },
				limit: { type: 'integer', description: '最多取几条，1–100（缺省 10；超出会被夹到边界）' },
				partition: { type: 'string', enum: ['current', 'legacy'], description: '缺省 `current` = 工作区分区 + 当前人设分区；选 `legacy` 时走**旧分区** `default`（与 memory_list / memory_search 同一出口 ✓）' },
				history: { type: 'boolean', description: '是否附带近 30 天同工作区的历史会话片段（缺省 true）' },
			},
			required: ['query'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { partition: { type: 'string' }, strategy: { type: 'string' }, text: { type: 'string' }, historySessions: { type: 'integer' } },
				required: ['text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		isConcurrencySafe: () => true,
		execute: async (params, exec) => {
			const base = requireGateway(config);
			const query = typeof params?.query === 'string' ? params.query.trim() : '';
			if (!query) { throw new Error('query 不能为空'); }
			const rawLimit = Number.isFinite(params?.limit) ? Math.floor(params.limit) : 10;
			const limit = Math.min(100, Math.max(1, rawLimit));
			const strategy = typeof params?.strategy === 'string' && params.strategy ? params.strategy : 'hybrid';
			// ★ 2026-10-20：与 memory_search / memory_list 同口径 —— 缺省读「工作区 + 当前人设」
			const partitions = params?.partition === 'legacy' ? [LEGACY_PARTITION] : readScopeOf(config, state, exec?.agent).partitions;
			const session = exec?.agent?.session;
			const [memory, history] = await Promise.all([
				Promise.all(partitions.map(p => recallOne(base, p, query, strategy, limit))),
				params?.history === false
					? Promise.resolve(null)
					: recallHistory(state.sessionQuery, {
						query,
						cwd: typeof session?.meta?.cwd === 'string' ? session.meta.cwd : undefined,
						excludeSessionId: typeof session?.id === 'string' ? session.id : (typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined),
					}).catch(error => ({ available: false, term: '', sessions: [], scanned: 0, truncated: false, error: String(error?.message ?? error) })),
			]);
			const memoryText = memory.map((m, i) => (i === 0 ? m.text : `## 人设记忆（${partitions[i]}）\n${m.text}`)).join('\n\n');
			const historyText = history ? renderHistory(history) : '';
			return {
				partition: partitions.join(' + '),
				strategy: memory[0]?.strategy ?? strategy,
				text: historyText ? `${memoryText}\n\n${historyText}` : memoryText,
				historySessions: history?.sessions?.length ?? 0,
			};
		},
	}, {
		name: 'memory_forget',
		description: '**软删除**一条记忆：标记为 superseded（不再被召回，但**保留审计痕迹**，不是物理删除）。⚠ 这是**写**（会改用户数据）⇒ 需审批。'
			+ ' 等价于 IDE 的 `memory_forget` / `memory_delete` —— 真源里两者调的是**同一个** `forgetMemory` ✓（所以 dsh 侧只做一个 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				memory_id: { type: 'string', description: '要遗忘的记忆 id（先用 memory_list / memory_search / memory_recall 拿到）' },
				// ⚠ 引擎的 `forgetMemory(kv, agentId, memId)` 只认 **2 参**（`amFunctions.ts:1050` ✓）⇒ `reason`
				// **不进记忆库** ✗ —— 它的用途是**审批文案 + 审计账本**（"批准即所见"，与 IDE 真源同法 ✓）。
				reason: { type: 'string', description: '可选：为什么忘掉它。⚠ 只进审批/审计（引擎不存这个字段 ✓），不进记忆库' },
			},
			required: ['memory_id'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, memory_id: { type: 'string' }, reply: { type: 'string' } },
				required: ['ok', 'memory_id'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `已遗忘 ${value.memory_id}（软删除：不再召回，审计痕迹仍在）`
					: `遗忘失败：${value.reply ?? '网关没有返回可读信息'}`,
			}],
		},
		execute: async (params) => {
			const base = requireGateway(config);
			const memoryId = typeof params?.memory_id === 'string' ? params.memory_id.trim() : '';
			if (!memoryId) { throw new Error('memory_id 不能为空'); }
			const reason = typeof params?.reason === 'string' && params.reason.trim() ? params.reason.trim() : undefined;
			const auditBase = {
				action: 'executed', tool: 'memory_forget', target: 'long', memoryType: 'fact',
				content: `软删除 memory_id=${memoryId}${reason ? `（原因：${reason}）` : ''}`,
			};
			let reply;
			try {
				reply = await forgetMemory(base, agentIdOf(config), memoryId, reason);
			} catch (error) {
				await auditAppend({ ...auditBase, outcome: 'failed', error });
				throw error;
			}
			// 真源返回 **boolean**（`unifiedMemoryTools.ts:162` ✓）；另两种形状也认（不猜 ⇒ 三种都收，其余算失败 ✓）
			const ok = reply === true || reply?.ok === true || reply?.success === true;
			await auditAppend({ ...auditBase, outcome: ok ? 'ok' : 'rejected-by-gateway' });
			return { ok, memory_id: memoryId, ...(ok ? {} : { reply: JSON.stringify(reply ?? null).slice(0, 400) }) };
		},
	}, {
		name: 'memory_obsidian_export',
		description: '把当前分区的**活跃记忆**导出成 Obsidian 兼容 Markdown（按记忆类型分组、带 wikilink）并**返回文本**。只读 ✓（落盘由调用方决定 —— 要存成 vault 笔记就自己写文件 ✓）。'
			+ ' ⚠ 超过 8000 字会**截断预览**并告知全量长度 ✓。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: { chars: { type: 'integer' }, truncated: { type: 'boolean' }, text: { type: 'string' } },
				required: ['chars', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		isConcurrencySafe: () => true,
		execute: async () => {
			const base = requireGateway(config);
			const raw = await obsidianExport(base, agentIdOf(config));
			const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
			if (!text) {
				return { chars: 0, truncated: false, text: 'Nothing to export（当前分区没有活跃记忆）。' };
			}
			// 截断保护与 IDE 同口径（`advancedMemoryTools.ts:318-321` ✓：8K 上限、预览前 4000 字 ✓）
			if (text.length > 8000) {
				return { chars: text.length, truncated: true, text: `已导出 ${text.length} 字 Obsidian Markdown（预览前 4000 字）：\n\n${text.slice(0, 4000)}\n\n…（已截断；要全量就再调一次并写入文件）` };
			}
			return { chars: text.length, truncated: false, text: `已导出 Obsidian Markdown（${text.length} 字）：\n\n${text}` };
		},
	}, {
		name: 'memory_cascade',
		description: '**级联修复**：给一条已被替代（superseded）的记忆 id，把它下游**引用过它**的条目（行动 / 草稿 / 快照）标记为 stale。⚠ 这是**写**（会改用户数据）⇒ 需审批。'
			+ ' 通常在替代发生时**自动**跑；手动调它是为了修历史遗留 ✓。',
		parameters: {
			type: 'object',
			properties: {
				memory_id: { type: 'string', description: '作为级联起点的**已被替代**记忆 id' },
			},
			required: ['memory_id'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, memory_id: { type: 'string' }, flagged: { type: 'integer' }, reply: { type: 'string' } },
				required: ['ok', 'memory_id'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `级联已执行（起点 ${value.memory_id}）：标记了 ${value.flagged ?? '?'} 条下游为 stale`
					: `级联失败：${value.reply ?? '网关没有返回可读信息'}`,
			}],
		},
		execute: async (params) => {
			const base = requireGateway(config);
			const memoryId = typeof params?.memory_id === 'string' ? params.memory_id.trim() : '';
			if (!memoryId) { throw new Error('memory_id 不能为空'); }
			const auditBase = { action: 'executed', tool: 'memory_cascade', target: 'long', memoryType: 'fact', content: `级联修复 memory_id=${memoryId}` };
			let reply;
			try {
				reply = await cascadeUpdate(base, agentIdOf(config), memoryId);
			} catch (error) {
				await auditAppend({ ...auditBase, outcome: 'failed', error });
				throw error;
			}
			// ★ 形状**已核实**（引擎 `amFinal.ts:16-20` ✓）：`{ success: boolean; flagged: number }`，
			// 且**起点不存在**时明确回 `{ success: false, flagged: 0 }` ✓ ⇒ 判据就是 `success === true` ✓
			//（不再用"非明确 false 就算成功"那种兜底 ✗ —— 引擎给了准确字段就该用它 ✓）。
			const ok = reply?.success === true;
			await auditAppend({ ...auditBase, outcome: ok ? 'ok' : 'rejected-by-gateway' });
			const flagged = Number.isFinite(reply?.flagged) ? reply.flagged : undefined;
			return { ok, memory_id: memoryId, ...(flagged === undefined ? {} : { flagged }), ...(ok ? {} : { reply: JSON.stringify(reply ?? null).slice(0, 400) }) };
		},
	}, {
		name: 'memory_crystal',
		description: '行动链**结晶**：把已完成的行动链固化成可复用经验（crystal）。4 个 action（照真源 ✓）：'
			+ '`create`（手动结晶 ✓）/ `list`（列出 ✓）/ `get`（取详情 ✓）/ `auto`（把高强度记忆自动结晶 ✓）。'
			+ ' ⚠ `create`/`auto` 是**写**（新增数据 ⇒ 需审批 ✓）；`list`/`get` **只读**（不弹窗 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['create', 'list', 'get', 'auto'], description: '要做的动作' },
				action_id: { type: 'string', description: '已完成行动链的 id（create）' },
				crystal_id: { type: 'string', description: '结晶 id（get）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const str = key => (typeof params?.[key] === 'string' ? params[key].trim() : '');
			const auditBase = detail => ({ action: 'executed', tool: 'memory_crystal', target: 'long', memoryType: 'fact', content: `结晶 ${action}${detail ? ` ${detail}` : ''}` });
			switch (action) {
				case 'create': {
					const actionId = str('action_id');
					if (!actionId) { throw new Error('create 需要 action_id'); }
					let reply;
					try {
						reply = await crystallize(base, agent, actionId);
					} catch (error) {
						await auditAppend({ ...auditBase(`action_id=${actionId}`), outcome: 'failed', error });
						throw error;
					}
					// ★ 形状已核实（引擎 `amAdvanced.ts:328-333` ✓）：成功回 `Crystal`、**行动链不存在回 `null`** ✗ ⇒ null = 失败 ✓
					const ok = reply !== null && reply !== undefined;
					await auditAppend({ ...auditBase(`action_id=${actionId}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return {
						ok, action,
						text: ok
							? `已结晶（起点行动链 ${actionId}${reply?.id ? ` → 结晶 ${reply.id}` : ''}）：${String(reply?.narrative ?? '').slice(0, 200)}`
							: `结晶失败：行动链 ${actionId} 不存在（引擎回 null ✓）`,
					};
				}
				case 'list': {
					const list = await crystalList(base, agent);
					const items = Array.isArray(list) ? list : [];
					return {
						ok: Array.isArray(list), action,
						text: items.length
							? `结晶 ${items.length} 条：\n${items.slice(0, 20).map(c => `- [${c?.id ?? '?'}] ${String(c?.narrative ?? '').slice(0, 120)}${c?.filesAffected?.length ? `（涉及 ${c.filesAffected.slice(0, 3).join(',')}）` : ''}`).join('\n')}`
							: '还没有任何结晶。',
					};
				}
				case 'get': {
					const id = str('crystal_id');
					if (!id) { throw new Error('get 需要 crystal_id'); }
					const c = await crystalGet(base, agent, id);
					if (c === null || c === undefined) { return { ok: false, action, text: `结晶 ${id} 不存在。` }; }
					const parts = [String(c?.narrative ?? '(无叙述)')];
					if (Array.isArray(c?.keyOutcomes) && c.keyOutcomes.length) { parts.push(`关键结果: ${c.keyOutcomes.join('; ')}`); }
					if (Array.isArray(c?.filesAffected) && c.filesAffected.length) { parts.push(`涉及文件: ${c.filesAffected.join(', ')}`); }
					if (Array.isArray(c?.lessons) && c.lessons.length) { parts.push(`经验: ${c.lessons.join('; ')}`); }
					return { ok: true, action, text: parts.join('\n') };
				}
				case 'auto': {
					let created;
					try {
						created = await autoCrystallize(base, agent);
					} catch (error) {
						await auditAppend({ ...auditBase(), outcome: 'failed', error });
						throw error;
					}
					// 形状已核实（`amFinal.ts:100` ⇒ **number** ＝ 新建几条 ✓）
					await auditAppend({ ...auditBase(), outcome: 'ok' });
					return { ok: true, action, text: `自动结晶完成：新建 ${typeof created === 'number' ? created : JSON.stringify(created)} 条。` };
				}
				default:
					throw new Error(`memory_crystal: 不认识的 action "${action}"（合法：create/list/get/auto）`);
			}
		},
	}, {
		// ── 批 2a：例程（8 action）─────────────────────────────────────────
		// action 取值与参数名**逐条照抄**真源 `routineCrystalFacetTools.ts:44-62` ✓；
		// 每个分支的调法与回执判据按**引擎源码**取实 ✓（`amRemaining.ts` / `amReplication.ts` ✓）。
		name: 'memory_routine',
		description: '**可复用多步流程**（routine）：把重复性procedure 固化成有序步骤，之后跑它、逐步回报、查状态（最后一步 done 自动完成 ✓）。'
			+ ' ⚠ `create`/`run`/`step`/`freeze`/`delete` 是**写**（需审批 ✓）；`list`/`get`/`status` **只读**（不弹窗 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['create', 'list', 'get', 'run', 'step', 'status', 'freeze', 'delete'], description: '要做的动作' },
				routine_id: { type: 'string', description: '例程 id（get / run / freeze / delete）' },
				name: { type: 'string', description: '例程名（create）' },
				description: { type: 'string', description: '例程说明（create）' },
				steps: {
					type: 'array', description: '有序步骤（create；按数组顺序编号 ✓）',
					items: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } } },
				},
				frozen: { type: 'boolean', description: '冻结/解冻（freeze；缺省 true ＝ 冻结 ✓）' },
				run_id: { type: 'string', description: '运行 id（step / status）' },
				step_order: { type: 'number', description: '步骤序号（step；从 0 起 ✓）' },
				step_status: { type: 'string', enum: ['done', 'failed', 'skipped', 'running'], description: '这一步的结果（step；缺省 done）' },
				result: { type: 'string', description: '简短结果摘要（step）' },
				error: { type: 'string', description: 'step_status=failed 时的错误信息（step）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const str = key => (typeof params?.[key] === 'string' ? params[key].trim() : '');
			const auditBase = detail => ({ action: 'executed', tool: 'memory_routine', target: 'long', memoryType: 'fact', content: `例程 ${action}${detail ? ` ${detail}` : ''}` });
			switch (action) {
				case 'create': {
					const name = str('name');
					const steps = Array.isArray(params?.steps) ? params.steps : [];
					if (!name) { throw new Error('create 需要 name'); }
					if (steps.length === 0) { throw new Error('create 需要非空的 steps[]'); }
					const reply = await createRoutine(base, agent, {
						name, steps,
						...(str('description') ? { description: str('description') } : {}),
					});
					const ok = typeof reply?.id === 'string' && !!reply.id;
					await auditAppend({ ...auditBase(`name=${name} steps=${steps.length}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return {
						ok, action,
						text: ok
							? `已建例程「${reply?.name ?? name}」（id ${reply.id}，${reply?.steps?.length ?? steps.length} 步）。`
							: `建例程失败：网关没有回可用的 id（回执 ${JSON.stringify(reply ?? null).slice(0, 200)}）`,
					};
				}
				case 'list': {
					const list = await getRoutines(base, agent);
					const items = Array.isArray(list) ? list : [];
					return {
						ok: Array.isArray(list), action,
						text: items.length
							? `例程 ${items.length} 个：\n${items.map(r => `- [${r?.id ?? '?'}] ${r?.name ?? '?'}（${r?.steps?.length ?? 0} 步，frozen=${r?.frozen !== false}）${r?.description ?? ''}`).join('\n')}`
							: '还没有注册任何例程。',
					};
				}
				case 'get': {
					const id = str('routine_id');
					if (!id) { throw new Error('get 需要 routine_id'); }
					const r = await getRoutine(base, agent, id);
					if (r === null || r === undefined) {
						return { ok: false, action, text: `例程 ${id} 不存在。` };
					}
					const steps = Array.isArray(r?.steps) ? r.steps : [];
					return {
						ok: true, action,
						text: `例程「${r?.name ?? '?'}」（id ${r?.id ?? id}，frozen=${r?.frozen !== false}）：\n${steps.map((s, i) => `  ${s?.order ?? i}. ${s?.title ?? '?'}${s?.description ? ` — ${s.description}` : ''}`).join('\n') || '（没有步骤）'}`,
					};
				}
				case 'run': {
					const id = str('routine_id');
					if (!id) { throw new Error('run 需要 routine_id'); }
					const run = await runRoutine(base, agent, id);
					const ok = typeof run?.id === 'string' && !!run.id;
					await auditAppend({ ...auditBase(`routine_id=${id}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return {
						ok, action,
						text: ok
							? `已开始运行 ${run.id}（例程 ${id}）。接下来逐步执行并用 action=step 回报（run_id=${run.id}）。`
							: `启动失败：网关没有回可用的 run id（回执 ${JSON.stringify(run ?? null).slice(0, 200)}）`,
					};
				}
				case 'step': {
					const runId = str('run_id');
					const order = Number(params?.step_order);
					if (!runId || !Number.isFinite(order)) { throw new Error('step 需要 run_id 与 step_order'); }
					const status = typeof params?.step_status === 'string' && params.step_status ? params.step_status : 'done';
					const run = await routineStepUpdate(base, agent, runId, order, status, str('result') || undefined, str('error') || undefined);
					const ok = run !== null && run !== undefined;
					await auditAppend({ ...auditBase(`run_id=${runId} step=${order} → ${status}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return {
						ok, action,
						text: ok
							? `第 ${order} 步 → ${status}。运行 ${run?.id ?? runId}：status=${run?.status ?? '?'}, currentStep=${run?.currentStep ?? '?'}${run?.completedAt ? `, completedAt=${run.completedAt}` : ''}`
							: `回报失败：运行 ${runId} 不存在（引擎回空 ✓）`,
					};
				}
				case 'status': {
					const runId = str('run_id');
					if (!runId) { throw new Error('status 需要 run_id'); }
					const s = await routineStatus(base, agent, runId);
					// ⚠ 形状已核实 ✓（`amReplication.ts:248`）：**唯一的失败信号是 `success:false`**（"run not found" ✓）
					// ⇒ 缺 `success` 字段时按成功（真源自带的 `progress` 形态就是这样 ✓），显式 `false` 才是失败 ✓。
					const ok = s?.success !== false;
					return { ok, action, text: ok ? JSON.stringify(s?.progress ?? s, null, 2) : `查状态失败：${s?.error ?? 'run not found'}` };
				}
				case 'freeze': {
					const id = str('routine_id');
					if (!id) { throw new Error('freeze 需要 routine_id'); }
					const frozen = params?.frozen !== false; // 真源缺省 true ＝ 冻结 ✓
					const r = await routineFreeze(base, agent, id, frozen);
					const ok = r?.success === true; // 形状已核实 ✓（`amReplication.ts:268`）
					await auditAppend({ ...auditBase(`routine_id=${id} frozen=${frozen}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, action, text: ok ? `例程 ${id} 已${frozen ? '冻结' : '解冻'}（frozen=${r?.routine?.frozen !== false}）。` : `冻结失败：${r?.error ?? '网关没有回可读信息'}` };
				}
				case 'delete': {
					const id = str('routine_id');
					if (!id) { throw new Error('delete 需要 routine_id'); }
					const ok = (await routineDelete(base, agent, id)) === true; // 形状已核实 ✓（`amRemaining.ts:132`：boolean ✓）
					await auditAppend({ ...auditBase(`routine_id=${id}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, action, text: ok ? `例程 ${id} 及其运行已删除。` : `例程 ${id} 不存在。` };
				}
				default:
					throw new Error(`memory_routine: 不认识的 action "${action}"（合法：create/list/get/run/step/status/freeze/delete）`);
			}
		},
	}, {
		// ── 批 2a：改进已有记忆（3 action）──────────────────────────────────
		name: 'memory_improve',
		description: '改进已有记忆：`reinforce`（提升强度/访问度 ⇒ 不再被衰减 ✓）/ `update`（用新内容替代 ✓）/ `merge`（把新内容并入 ✓）。'
			+ ' ⚠ 三个 action **都会改数据** ⇒ 这是**写**（需审批 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				memory_id: { type: 'string', description: '要改进的记忆 id' },
				action: { type: 'string', enum: ['reinforce', 'update', 'merge'], description: '怎么改（reinforce=强化已有条目；update=替代；merge=并入）' },
				new_content: { type: 'string', description: 'update / merge **必填**：新内容或要并入的内容' },
			},
			required: ['memory_id', 'action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, memory_id: { type: 'string' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'memory_id', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const memoryId = typeof params?.memory_id === 'string' ? params.memory_id.trim() : '';
			const action = typeof params?.action === 'string' ? params.action : '';
			if (!memoryId) { throw new Error('memory_id 不能为空'); }
			const newContent = typeof params?.new_content === 'string' ? params.new_content.trim() : '';
			const auditBase = { action: 'executed', tool: 'memory_improve', target: 'long', memoryType: 'fact', content: `改进记忆 ${memoryId}（${action}）` };
			if (action === 'reinforce') {
				let okReply;
				try {
					okReply = await reinforceMemory(base, agent, memoryId);
				} catch (error) {
					await auditAppend({ ...auditBase, outcome: 'failed', error });
					throw error;
				}
				// ⚠ 真源在旧 provider 上会**回退**成写一条 `(reinforced)` 假内容 ✗ —— 本模块刻意不做 ✓（见 gateway.js 的说明）
				const ok = okReply === true; // 形状已核实 ✓（`amFunctions.ts:1060`：boolean；记忆不存在 ⇒ false ✓）
				await auditAppend({ ...auditBase, outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return { ok, memory_id: memoryId, action, text: ok ? `已强化 ${memoryId}（strength +1 ✓）。` : `强化失败：记忆 ${memoryId} 不存在（或被遗忘）✓。` };
			}
			if (action === 'update' || action === 'merge') {
				if (!newContent) { throw new Error(`${action} 需要 new_content`); }
				// 载荷**逐字照抄**真源 ✓（`unifiedMemoryTools.ts:120-127`）：新 id 由 `${memId}-${action}-${时间戳}` 派生 ✓
				const entry = {
					id: `${memoryId}-${action}-${Date.now()}`,
					type: 'fact',
					content: newContent,
					metadata: { improves: memoryId, action, source: 'memory_improve' },
				};
				try {
					await remember(base, agent, entry);
				} catch (error) {
					await auditAppend({ ...auditBase, outcome: 'failed', error });
					throw error;
				}
				// ⚠ `writeMemory` **没有回执**（引擎返回 void ✓）⇒ 判据只能是"没抛错" ✓ —— 如实写在文案里，
				//   不假装拿到了成功确认 ✓（与"写操作上没报错不等于成功"是同一条纪律的例外：这里**没有**别的信号可用 ✓）。
				await auditAppend({ ...auditBase, outcome: 'ok' });
				return { ok: true, memory_id: memoryId, action, text: `已${action === 'update' ? '更新' : '并入'} ${memoryId}（新条目 ${entry.id}）。⚠ writeMemory 无回执 ⇒ 以"没报错"为准 ✓。` };
			}
			throw new Error(`memory_improve: 不认识的 action "${action}"（合法：reinforce/update/merge）`);
		},
	}, {
		// ── 批 2b：多维标签（facet，6 action）──────────────────────────────
		// action 与参数名**逐条照抄**真源 `routineCrystalFacetTools.ts:208-217` ✓；
		// 回执形状按**引擎源码**取实 ✓（`amAdvanced.ts:339/343` / `amFinal.ts:118/129/134/147` ✓）。
		name: 'memory_facet',
		description: '**多维标签**（facet）：给记忆/文件/会话/例程/结晶打 `维度:值` 标签，再按维度（可选值）查回目标，也可查某目标的标签、去标签、看维度统计。'
			+ ' ⚠ `tag`/`untag` 是**写**（需审批 ✓）；`query`/`get`/`stats`/`dimensions` **只读**（不弹窗 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['tag', 'query', 'get', 'untag', 'stats', 'dimensions'], description: '要做的动作' },
				target_id: { type: 'string', description: '目标 id（tag / get / untag）' },
				target_type: { type: 'string', enum: ['memory', 'file', 'session', 'routine', 'crystal'], description: '目标类型（tag；缺省 memory）' },
				dimension: { type: 'string', description: '维度名，如 project / domain / status（tag / query / get / untag）' },
				value: { type: 'string', description: '维度值（tag 必填；query 时可作过滤 ✓）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const str = key => (typeof params?.[key] === 'string' ? params[key].trim() : '');
			const auditBase = detail => ({ action: 'executed', tool: 'memory_facet', target: 'long', memoryType: 'fact', content: `标签 ${action}${detail ? ` ${detail}` : ''}` });
			switch (action) {
				case 'tag': {
					const targetId = str('target_id');
					const dimension = str('dimension');
					const value = str('value');
					if (!targetId || !dimension || !value) { throw new Error('tag 需要 target_id、dimension 与 value'); }
					const targetType = str('target_type') || 'memory';
					const reply = await facetTag(base, agent, targetId, targetType, dimension, value);
					const ok = typeof reply?.id === 'string' && !!reply.id;
					await auditAppend({ ...auditBase(`${targetId} ${dimension}=${value}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return {
						ok, action,
						text: ok
							? `已打标签 ${targetId}：${dimension}=${value}（facet ${reply.id}）`
							: `打标签失败：网关没有回可用的 facet id（回执 ${JSON.stringify(reply ?? null).slice(0, 200)}）`,
					};
				}
				case 'query': {
					const dimension = str('dimension');
					if (!dimension) { throw new Error('query 需要 dimension'); }
					const list = await facetQuery(base, agent, dimension, str('value') || undefined);
					const items = Array.isArray(list) ? list : [];
					return {
						ok: Array.isArray(list), action,
						text: items.length
							? `维度 [${dimension}] 命中 ${items.length} 条：\n${items.slice(0, 20).map(f => `- ${f?.targetId ?? '?'}（${f?.targetType ?? 'memory'}）：${f?.dimension ?? dimension}=${f?.value ?? '?'}`).join('\n')}`
							: `维度 [${dimension}] 下没有命中任何标签${str('value') ? `（值过滤 ${str('value')}）` : ''}。`,
					};
				}
				case 'get': {
					const targetId = str('target_id');
					const dimension = str('dimension');
					if (!targetId || !dimension) { throw new Error('get 需要 target_id 与 dimension'); }
					const list = await facetGet(base, agent, targetId, dimension);
					// ⚠ 形状已核实（`amFinal.ts:147`）⇒ **数组** ✗（不是记录或 null ✗）⇒ **空数组＝没有标签** ✓
					//（真源 IDE 的 `f ? … : 'No facet'` 对空数组也走"有"那条 ✗ —— 我们按诚实口径 ✓）
					const items = Array.isArray(list) ? list : [];
					return {
						ok: items.length > 0, action,
						text: items.length ? JSON.stringify(items) : `${targetId} 上没有 ${dimension} 标签。`,
					};
				}
				case 'untag': {
					const targetId = str('target_id');
					const dimension = str('dimension');
					if (!targetId || !dimension) { throw new Error('untag 需要 target_id 与 dimension'); }
					const ok = (await facetUntag(base, agent, targetId, dimension)) === true; // 形状已核实 ✓（boolean ✓）
					await auditAppend({ ...auditBase(`${targetId} ${dimension}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, action, text: ok ? `已去掉 ${targetId} 上的 ${dimension} 标签。` : `${targetId} 上没有 ${dimension} 标签。` };
				}
				case 'stats': {
					const s = await facetStats(base, agent);
					return { ok: s !== null && s !== undefined, action, text: JSON.stringify(s ?? {}) };
				}
				case 'dimensions': {
					const d = await facetDimensions(base, agent);
					const items = Array.isArray(d) ? d : [];
					return { ok: Array.isArray(d), action, text: `维度 ${items.length} 个：${items.join(', ') || '(无)'}` };
				}
				default:
					throw new Error(`memory_facet: 不认识的 action "${action}"（合法：tag/query/get/untag/stats/dimensions）`);
			}
		},
	}, {
		// ── 批 2c：治理（3 action）＋ 批 2d：检查点 / 快照（2026-10-13 扩）────────
		// action/参数名照真源 `advancedMemoryTools.ts:53-70` ✓；形状按引擎取实 ✓（`amExtras.ts` / `amFinal.ts` ✓）。
		// ★ 2026-10-13 扩两个 action（`checkpoint` / `snapshot`）而**不加新工具**：治理本来就是"低频高危操作"的
		//   收口处 ✓，多 action 的形态也已成熟（`routine` / `facet` / `sentinel` 都是 ✓）—— 工具数不涨 ⇒ 不加提示词成本 ✓。
		name: 'memory_governance',
		description: '**记忆治理**：按 id 精确删、按条件批量删（**默认 dry-run 只出计划** ✓）、查治理审计、'
			+ '以及**检查点 / 快照**（`checkpoint` / `snapshot`，见 `sub`）。'
			+ ' ⚠ 写类：`delete`、`dry_run=false` 的 `bulk_delete`、`checkpoint` 的 `create`/`resolve`/`expire`、'
			+ '`snapshot` 的 `create`/`restore`（**restore 会用快照覆盖当前记忆** ⚠）、'
			+ ' `compress`（把某会话**未压缩的观察**压成叙事摘要 —— ⚠ **不可逆**，且同一会话第二次调用**必回 null** ✓）、'
			+ ' `frontier`（把一个概念加入**待探索队列** ✓，读取端用 `memory_api` 的 `frontierGet`/`frontierNext` ✓）。'
			+ ' 只读：`audit`、dry-run、`checkpoint`/`snapshot` 的 `list`（不弹窗 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['delete', 'bulk_delete', 'update', 'audit', 'checkpoint', 'snapshot', 'compress', 'frontier'], description: '要做的动作' },
				// ── 2026-10-14 新增两个 action（**真机实测确证可用后**才接 ✓）──────────────────
				session_id: { type: 'string', description: '`compress`：要压缩的会话 id（必填；先用 `memory_api` 的 `listSessions` 拿）。⚠ **压缩不可逆**：它把该会话未压缩的观察标记为已压缩 ⇒ 同一会话**第二次调用必然回 null** ✓（那不是失败，是"无事可做" ✓）' },
				concept: { type: 'string', description: '`frontier`：要加入**前沿队列**的概念（必填）' },
				description: { type: 'string', description: '`frontier`：概念的一句话说明（可选）' },
				priority: { type: 'number', description: '`frontier`：优先级（可选，数字越大越靠前）' },
				updates: { type: 'object', description: '`update`：要改的字段（如 `{content, importance}`）—— ⚠ 只在**确信要改**时用，改错了要用快照恢复 ✓' },
				sub: { type: 'string', description: '`checkpoint`：list(缺省)/create/resolve/expire；`snapshot`：list(缺省)/create/restore。⚠ **缺省 = list（只读）** ✓ —— 与 `dry_run` 缺省 true 同一思路：不确定时不动数据 ✓' },
				ids: { type: 'array', items: { type: 'string' }, description: '要删的确切记忆 id（delete）' },
				filters: {
					type: 'object', description: '批量条件（bulk_delete）；**空对象 = 匹配全部活跃记忆** ⚠ 先用 dry-run 看一遍',
					properties: {
						type: { type: 'string', description: '只删这一类型（working/pattern/fact/preference/architecture/bug/workflow/semantic/procedural/episodic）' },
						maxStrength: { type: 'number', description: '只删 strength ≤ 此值的' },
						minAgeDays: { type: 'number', description: '只删比这更旧的（天）' },
						pattern: { type: 'string', description: '只删正文含此子串的（不区分大小写）' },
					},
				},
				dry_run: { type: 'boolean', description: '只预览不删（bulk_delete；**缺省 true** ✓ —— 要真删必须显式 false ✓）' },
				limit: { type: 'integer', description: '审计条数上限（audit；缺省 20）' },
				name: { type: 'string', description: '名字（checkpoint / snapshot 的 create）' },
				checkpoint_id: { type: 'string', description: '检查点 id（checkpoint 的 resolve / expire；先用 sub=list 拿到）' },
				passed: { type: 'boolean', description: '这个检查点算通过还是失败（checkpoint 的 resolve）' },
				snapshot_id: { type: 'string', description: '快照 id（snapshot 的 restore；先用 sub=list 拿到）' },
				memory_id: { type: 'string', description: '要改的记忆 id（update；先用 memory_list / memory_search 拿到）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const auditBase = detail => ({ action: 'executed', tool: 'memory_governance', target: 'long', memoryType: 'fact', content: `治理 ${action}${detail ? ` ${detail}` : ''}` });
			if (action === 'delete') {
				const ids = Array.isArray(params?.ids) ? params.ids.filter(id => typeof id === 'string' && id.trim()) : [];
				if (ids.length === 0) { throw new Error('delete 需要非空的 ids[]'); }
				const reply = await governanceDelete(base, agent, ids);
				const deleted = Number.isFinite(reply?.deleted) ? reply.deleted : undefined;
				const ok = deleted !== undefined;
				await auditAppend({ ...auditBase(`ids=${ids.length}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return { ok, action, text: ok ? `已删除 ${deleted} 条（请求 ${ids.length} 条）。` : `删除失败：网关没回可读的计数（回执 ${JSON.stringify(reply ?? null).slice(0, 200)}）` };
			}
			if (action === 'bulk_delete') {
				// 真源：`dry_run !== false` ⇒ 默认 **dry-run** ✓（要真删必须显式 false ✓）
				const dryRun = params?.dry_run !== false;
				const src = params?.filters && typeof params.filters === 'object' ? params.filters : {};
				// 只透传认识的字段 ✓（schema 之外的键一律丢掉 —— 与"不猜"同一条纪律 ✓）
				const filters = {
					...(typeof src.type === 'string' && src.type ? { type: src.type } : {}),
					...(Number.isFinite(src.maxStrength) ? { maxStrength: src.maxStrength } : {}),
					...(Number.isFinite(src.minAgeDays) ? { minAgeDays: src.minAgeDays } : {}),
					...(typeof src.pattern === 'string' && src.pattern ? { pattern: src.pattern } : {}),
					dryRun,
				};
				const reply = await governanceBulkDelete(base, agent, filters);
				const matched = Number.isFinite(reply?.matched) ? reply.matched : undefined;
				const scanned = Number.isFinite(reply?.scanned) ? reply.scanned : undefined;
				if (!dryRun) { await auditAppend({ ...auditBase(`filters=${JSON.stringify(filters).slice(0, 120)}`), outcome: 'ok' }); }
				return {
					ok: matched !== undefined,
					action,
					text: dryRun
						? `**dry-run**：扫描 ${scanned ?? '?'} 条活跃记忆，命中 ${matched ?? '?'} 条**将被删除** —— 要真删请显式传 dry_run=false ✓。`
						: `批量删除完成：扫描 ${scanned ?? '?'} 条，删除 ${Number.isFinite(reply?.deleted) ? reply.deleted : '?'} 条。`,
				};
			}
			// ── 批 2e：改记忆（2026-10-13 补）────────────────────────────────
			// 为什么补它：治理工具本来有 `delete`（硬删）却没有"**改**" ⇒ 只能用"删掉再写一条"绕过，
			// 而那会**丢 id 与关系** ✗。`updateMemory` 是真实现 ✓（`updateMemory(agentId, id, updates)` ✓）。
			if (action === 'update') {
				const id = typeof params?.memory_id === 'string' ? params.memory_id.trim() : '';
				if (!id) { throw new Error('update 需要 memory_id'); }
				const updates = params?.updates;
				if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).length === 0) {
					throw new Error('update 需要非空的 updates 对象（如 {content: "…"}）');
				}
				const reply = await providerCall(base, 'updateMemory', [agent, id, updates]);
				const ok = !!reply?.id;
				await auditAppend({ ...auditBase(`update ${id} ${Object.keys(updates).join(',')}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return { ok, action, text: ok ? `记忆 ${reply.id} 已更新（改了 ${Object.keys(updates).join('、')}）。` : `更新失败：引擎没找到记忆 ${id}（回执 ${JSON.stringify(reply ?? null).slice(0, 160)}）` };
			}
			// ── 2026-10-14：压缩会话（**写，且不可逆** ⚠）─────────────────────────────
			// ⚠⚠ `null` 有**两种含义**、而引擎把它们**混在一起**（`amCompress.ts:121` 的"没有未压缩的观察"
			//   vs `catch` 里的异常 ✓）⇒ 这里**如实转述两种可能**，绝不美化成"压缩完成" ✗
			//   （与"引擎回空要如实说"同一条纪律 ✓）。
			if (action === 'compress') {
				const sessionId = typeof params?.session_id === 'string' ? params.session_id.trim() : '';
				if (!sessionId) {
					throw new Error('memory_governance: action=compress 需要 session_id（先用 memory_api 的 listSessions 拿会话 id ✓）');
				}
				// ⚠ **不传 project**：缺省由引擎取 `existing?.project || 'default'` ✓ 够用；
				//   而多传它只会重现我实测踩过的那个坑（见 `gateway.js` 里 compressSession 的注释 ✓）。
				const summary = await compressSession(base, agent, sessionId);
				const ok = !!summary;
				await auditAppend({ ...auditBase(`compress ${sessionId}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				if (!ok) {
					return {
						ok: false, action,
						text: `会话 ${sessionId} 压缩返回 **null** —— 引擎把两种情况混在一起：`
							+ '① 该会话**已经没有未压缩的观察**（正常的“无事可做”，尤其是同一会话的第二次调用 ✓）；'
							+ '② 压缩过程**出错并被 `catch` 吞掉** ✗。⚠ 引擎不区分这两者 ⇒ **别当成“压缩成功”** ✓。',
					};
				}
				const lines = [`会话 ${sessionId} 已压缩 ✓（project=${summary.project ?? '?'}，观察数 ${summary.observationCount ?? '?'}）`];
				if (summary.title) { lines.push(`  标题：${String(summary.title).slice(0, 160)}`); }
				if (summary.narrative) { lines.push(`  叙事：${String(summary.narrative).slice(0, 400)}`); }
				if (Array.isArray(summary.keyDecisions) && summary.keyDecisions.length) {
					lines.push(`  关键决定：${summary.keyDecisions.slice(0, 5).map(d => String(d).slice(0, 80)).join(' | ')}`);
				}
				if (Array.isArray(summary.concepts) && summary.concepts.length) {
					lines.push(`  概念：${summary.concepts.slice(0, 10).join(', ')}`);
				}
				return { ok: true, action, text: lines.join('\n') };
			}
			// ── 2026-10-14：前沿队列入队（**写**）──────────────────────────────────
			// ⚠ 与 `getTopLessons` 那类**恒空桩**不同：真机实测它**返回完整对象并真的落库** ✓。
			if (action === 'frontier') {
				const concept = typeof params?.concept === 'string' ? params.concept.trim() : '';
				if (!concept) {
					throw new Error('memory_governance: action=frontier 需要 concept（要加入队列的概念 ✓）');
				}
				const desc = typeof params?.description === 'string' ? params.description.trim() : undefined;
				const pri = Number.isFinite(params?.priority) ? params.priority : undefined;
				const reply = await frontierAdd(base, agent, concept, desc, pri);
				const ok = !!reply?.id;
				await auditAppend({ ...auditBase(`frontier ${concept}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return {
					ok, action,
					text: ok
						? `已加入前沿队列：${concept}（id=${reply.id}${pri === undefined ? '' : `，priority=${pri}`}）—— 读取用 memory_api 的 frontierGet/frontierNext ✓`
						: `入队失败：引擎没回 id（回执 ${JSON.stringify(reply ?? null).slice(0, 160)}）`,
				};
			}
			if (action === 'audit') {
				const limit = Number.isFinite(params?.limit) ? Math.max(1, Math.floor(params.limit)) : 20;
				const entries = await governanceAuditQuery(base, agent, { limit });
				const items = Array.isArray(entries) ? entries : [];
				return {
					ok: Array.isArray(entries), action,
					text: items.length
						? `治理审计 ${items.length} 条：\n${items.slice(0, limit).map(e => `- ${e?.timestamp ?? e?.createdAt ?? ''} ${e?.operation ?? e?.action ?? ''} ${JSON.stringify(e?.details ?? e).slice(0, 160)}`).join('\n')}`
						: '治理审计为空。',
				};
			}
			// ── 批 2d：检查点（`Checkpoint` 形状见 `amAdvanced.ts:78-90` ✓）──────────────────
			if (action === 'checkpoint') {
				const sub = typeof params?.sub === 'string' && params.sub ? params.sub : 'list'; // 缺省 list ⇒ 只读 ✓
				const name = typeof params?.name === 'string' ? params.name.trim() : '';
				if (sub === 'list') {
					const list = await providerCall(base, 'checkpointList', [agent]);
					const items = Array.isArray(list) ? list : [];
					return {
						ok: Array.isArray(list), action,
						text: items.length
							? `检查点 ${items.length} 个：\n${items.map(c => `- ${c?.id ?? '?'}「${c?.name ?? ''}」status=${c?.status ?? '?'} created=${c?.createdAt ?? ''}${c?.resolvedAt ? ` resolved=${c.resolvedAt}` : ''}${c?.description ? `\n  ${String(c.description).slice(0, 160)}` : ''}`).join('\n')}`
							: '还没有任何检查点（`sub=create` 加一个 ✓）。',
					};
				}
				if (sub === 'create') {
					if (!name) { throw new Error('checkpoint create 需要 name'); }
					// ⚠ 方法名是 **`createCheckpoint`**（ProviderV2 的**公开**名 ✓），**不是** `checkpointCreate`
					//   —— 后者是**内部模块函数**（`adv.checkpointCreate`，见 `agentMemoryProviderV2.ts:597` 那行的
					//   转发 ✓）：两者**词序颠倒** ⇒ 真机上 `checkpointCreate` 是 **404** ✗✗。
					//   ★ 这一处是 `p3-80` 的 ⑫ 抓出来的（假网关永远发现不了 ✓）⇒ 别改回去 ✓。
					const cp = await providerCall(base, 'createCheckpoint', [agent, name]);
					const ok = typeof cp?.id === 'string' && !!cp.id;
					await auditAppend({ ...auditBase(`checkpoint create ${name}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, action, text: ok ? `已建检查点「${name}」（id ${cp.id}，status=${cp.status ?? 'pending'}）。用 sub=resolve 标记它通过/失败 ✓。` : `建检查点失败：网关没回可读的 id（回执 ${JSON.stringify(cp ?? null).slice(0, 200)}）` };
				}
				if (sub === 'resolve') {
					const id = typeof params?.checkpoint_id === 'string' ? params.checkpoint_id.trim() : '';
					if (!id) { throw new Error('checkpoint resolve 需要 checkpoint_id'); }
					if (typeof params?.passed !== 'boolean') { throw new Error('checkpoint resolve 需要 passed（true/false）'); }
					const cp = await providerCall(base, 'checkpointResolve', [agent, id, params.passed]);
					// ⚠ id 不存在时引擎回 **`null`**（`amAdvanced.ts:83` 的 `if (!cp) return null` ✓）⇒ **必须判失败** ✓
					const ok = !!cp && typeof cp.id === 'string';
					await auditAppend({ ...auditBase(`checkpoint resolve ${id}=${params.passed}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, action, text: ok ? `检查点「${cp.name ?? id}」已标记为 ${cp.status ?? (params.passed ? 'passed' : 'failed')}。` : `标记失败：引擎没找到检查点 ${id}（回执 ${JSON.stringify(cp ?? null).slice(0, 120)}）` };
				}
				if (sub === 'expire') {
					const id = typeof params?.checkpoint_id === 'string' ? params.checkpoint_id.trim() : '';
					if (!id) { throw new Error('checkpoint expire 需要 checkpoint_id'); }
					const r = await providerCall(base, 'checkpointExpire', [agent, id]);
					await auditAppend({ ...auditBase(`checkpoint expire ${id}`), outcome: 'ok' });
					return { ok: true, action, text: `检查点 ${id} 已过期（${JSON.stringify(r ?? null).slice(0, 160)}）。` };
				}
				throw new Error(`memory_governance checkpoint: 不认识的 sub "${sub}"（合法：list/create/resolve/expire）`);
			}
			// ── 批 2d：快照（`Snapshot` 形状见 `amAdvanced.ts:314`；恢复见 `amReplication.ts:212` ✓）──
			if (action === 'snapshot') {
				const sub = typeof params?.sub === 'string' && params.sub ? params.sub : 'list'; // 缺省 list ⇒ 只读 ✓
				const name = typeof params?.name === 'string' ? params.name.trim() : '';
				if (sub === 'list') {
					const list = await providerCall(base, 'snapshotList', [agent]);
					const items = Array.isArray(list) ? list : [];
					return {
						ok: Array.isArray(list), action,
						text: items.length
							? `快照 ${items.length} 个：\n${items.map(s => `- ${s?.id ?? '?'}「${s?.name ?? ''}」created=${s?.createdAt ?? ''}${Number.isFinite(s?.memoryCount) ? ` 记忆 ${s.memoryCount} 条` : ''}`).join('\n')}`
							: '还没有任何快照（`sub=create` 存一个 ✓）。',
					};
				}
				if (sub === 'create') {
					if (!name) { throw new Error('snapshot create 需要 name'); }
					const snap = await providerCall(base, 'createSnapshot', [agent, name]);
					const ok = typeof snap?.id === 'string' && !!snap.id;
					await auditAppend({ ...auditBase(`snapshot create ${name}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, action, text: ok ? `已建快照「${name}」（id ${snap.id}${Number.isFinite(snap.memoryCount) ? `，含 ${snap.memoryCount} 条记忆` : ''}）。⚠ 用 sub=restore 会**覆盖当前记忆**。` : `建快照失败：网关没回可读的 id（回执 ${JSON.stringify(snap ?? null).slice(0, 200)}）` };
				}
				if (sub === 'restore') {
					const id = typeof params?.snapshot_id === 'string' ? params.snapshot_id.trim() : '';
					if (!id) { throw new Error('snapshot restore 需要 snapshot_id'); }
					const r = await providerCall(base, 'snapshotRestore', [agent, id]);
					// ⚠ 引擎回 `{success, restored?, error?}` ✓ ⇒ **必须按 `success` 判**，不能只看"没抛错" ✗
					//   （典型失败：老快照是 legacy 格式（只有 ids 没有全量数据）⇒ 永远恢复不了 ✓，见 `amReplication.ts:212` ✓）
					const ok = r?.success === true;
					await auditAppend({ ...auditBase(`snapshot restore ${id}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, action, text: ok ? `快照 ${id} 已恢复：写回 ${r.restored ?? '?'} 条记忆。` : `恢复失败：${r?.error ?? '网关没回可读信息'}（回执 ${JSON.stringify(r ?? null).slice(0, 200)}）` };
				}
				throw new Error(`memory_governance snapshot: 不认识的 sub "${sub}"（合法：list/create/restore）`);
			}
			throw new Error(`memory_governance: 不认识的 action "${action}"（合法：delete/bulk_delete/audit/checkpoint/snapshot）`);
		},
	}, {
		// ── 批 2c：团队池（2 action）───────────────────────────────────────
		name: 'memory_team',
		description: '**团队记忆池**：把自己的一条记忆共享到团队池（其他 agent 可发现 ✓），或查别人共享了什么（跨 agent 知识共享 ✓）。'
			+ ' ⚠ `share` 是**写**（需审批 ✓）；`query` 只读（不弹窗 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['share', 'query'], description: '要做的动作' },
				memory_id: { type: 'string', description: '要共享的记忆 id（share；先用 memory_search 找到）' },
				item_type: { type: 'string', description: '共享项的类型标签（share；缺省 "memory"）' },
				project: { type: 'string', description: '项目范围标签（可选）' },
				query: { type: 'string', description: '关键词过滤（query；空 = 全部共享项）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const str = key => (typeof params?.[key] === 'string' ? params[key].trim() : '');
			if (action === 'share') {
				const memId = str('memory_id');
				if (!memId) { throw new Error('share 需要 memory_id'); }
				const reply = await teamShare(base, agent, memId, str('item_type') || 'memory', str('project') || undefined);
				// 形状已核实 ✓（`amRemaining.ts:145` ⇒ `{success, item?, error?}` ✓）
				const ok = reply?.success === true;
				await auditAppend({ action: 'executed', tool: 'memory_team', target: 'long', memoryType: 'fact', content: `共享记忆 ${memId} 到团队池`, outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return { ok, action, text: ok ? `已共享记忆 ${memId} 到团队池（share id ${reply?.item?.id ?? '?'}）。` : `共享失败：${reply?.error ?? '网关没有回可读信息'}` };
			}
			if (action === 'query') {
				const items = await teamQuery(base, agent, str('query') || undefined);
				const list = Array.isArray(items) ? items : [];
				return {
					ok: Array.isArray(items), action,
					text: list.length
						? `团队池 ${list.length} 项：\n${list.slice(0, 20).map(i => {
							const content = typeof i?.content === 'string' ? i.content : (i?.content?.content ?? JSON.stringify(i?.content ?? ''));
							return `- [${i?.type ?? 'item'}] by ${i?.sharedBy ?? '?'} @ ${i?.sharedAt ?? ''}：${String(content).slice(0, 160)}`;
						}).join('\n')}`
						: '团队池是空的。',
				};
			}
			throw new Error(`memory_team: 不认识的 action "${action}"（合法：share/query）`);
		},
	}, {
		// ── 批 2c：联邦（4 action）─────────────────────────────────────────
		name: 'memory_mesh',
		description: '**Mesh 联邦**（多 agent 跨网关协作）：加入一个 peer、列 peer、让 peer 下线、或同步（push/pull 记忆增量，last-write-wins ✓）。'
			+ ' ⚠ `join`/`leave`/`sync` 是**写**（需审批 ✓）；`list` 只读 ✓。⚠ `sync` 需要两端网关共享 `AGENTMEMORY_SECRET` ✓。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['join', 'list', 'leave', 'sync'], description: '要做的动作' },
				name: { type: 'string', description: 'peer 显示名（join）' },
				url: { type: 'string', description: 'peer 网关地址，如 http://192.168.1.10:3111（join）' },
				scopes: { type: 'array', items: { type: 'string' }, description: '共享范围（join/sync；缺省 ["memories","actions"]）' },
				peer_id: { type: 'string', description: 'peer id（leave/sync；sync 不带 = 所有在线 peer）' },
				direction: { type: 'string', enum: ['push', 'pull', 'both'], description: '同步方向（sync；缺省 both）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const str = key => (typeof params?.[key] === 'string' ? params[key].trim() : '');
			const scopes = Array.isArray(params?.scopes) ? params.scopes.filter(s => typeof s === 'string' && s.trim()) : undefined;
			const auditBase = detail => ({ action: 'executed', tool: 'memory_mesh', target: 'long', memoryType: 'fact', content: `联邦 ${action}${detail ? ` ${detail}` : ''}` });
			if (action === 'join') {
				const name = str('name');
				const url = str('url');
				if (!name || !url) { throw new Error('join 需要 name 与 url'); }
				const peer = await meshJoin(base, agent, name, url, scopes);
				// 形状已核实 ✓（`amRemaining.ts:173` ⇒ `MeshPeer` ✓）
				const ok = typeof peer?.id === 'string' && !!peer.id;
				await auditAppend({ ...auditBase(`${name} ${url}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return { ok, action, text: ok ? `已加入 peer「${name}」（${url}）→ peer id ${peer.id}` : `加入失败：网关没回可用的 peer id（回执 ${JSON.stringify(peer ?? null).slice(0, 200)}）` };
			}
			if (action === 'list') {
				const peers = await meshList(base, agent);
				const list = Array.isArray(peers) ? peers : [];
				return {
					ok: Array.isArray(peers), action,
					text: list.length
						? `Mesh peer ${list.length} 个：\n${list.map(p => `- [${p?.id ?? '?'}] ${p?.name ?? ''} ${p?.url ?? ''} status=${p?.status ?? '?'} scopes=${(p?.sharedScopes ?? []).join(',')}${p?.lastSyncAt ? ` lastSync=${p.lastSyncAt}` : ''}`).join('\n')}`
						: '还没有注册任何 mesh peer。',
				};
			}
			if (action === 'leave') {
				const peerId = str('peer_id');
				if (!peerId) { throw new Error('leave 需要 peer_id'); }
				const ok = (await meshLeave(base, agent, peerId)) === true; // 形状已核实 ✓（boolean ✓）
				await auditAppend({ ...auditBase(`peer=${peerId}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return { ok, action, text: ok ? `peer ${peerId} 已标记为 offline。` : `peer ${peerId} 不存在。` };
			}
			if (action === 'sync') {
				const reply = await meshSync(base, agent, {
					...(str('peer_id') ? { peerId: str('peer_id') } : {}),
					...(scopes ? { scopes } : {}),
					...(str('direction') ? { direction: str('direction') } : {}),
				});
				// 形状已核实 ✓（`amRemaining.ts:372` ⇒ `{success, results?, error?}` ✓）
				const ok = reply?.success === true;
				await auditAppend({ ...auditBase(`direction=${str('direction') || 'both'}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				if (!ok) { return { ok: false, action, text: `同步失败：${reply?.error ?? '网关没有回可读信息'}` }; }
				const lines = (Array.isArray(reply?.results) ? reply.results : []).map(x => `- ${x?.peerName ?? '?'}：pushed=${x?.pushed ?? '?'} pulled=${x?.pulled ?? '?'}${x?.errors?.length ? ` errors=[${x.errors.join('; ')}]` : ''}`);
				return { ok: true, action, text: `同步完成：\n${lines.join('\n') || '（没有在线 peer）'}` };
			}
			throw new Error(`memory_mesh: 不认识的 action "${action}"（合法：join/list/leave/sync）`);
		},
	}, {
		// ── 批 2c：哨兵（4 action）─────────────────────────────────────────
		name: 'memory_sentinel',
		description: '**哨兵**（条件监视器）：建一个命名监视器 + 条件表达式、列出来、立即评估（`check`）、**直接触发**（`trigger`）、取消。'
			+ ' ⚠ `create`/`check`/`trigger`/`cancel` 是**写**（`check`/`trigger` 都会把哨兵置为已触发 ✓，需审批 ✓）；`list` 只读 ✓。'
			+ ' 条件格式：threshold `"memory_count > 1000"` ✓ / pattern（正则或子串 ✓）/ schedule `"24h"`/`"7d"`/ISO 日期 ✓。'
			+ ' ⚠ `trigger` 与 `check` 的区别：`check` 是**先评估条件**、满足才触发；`trigger` 是**跳过评估直接触发** ✓。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['create', 'list', 'check', 'trigger', 'cancel'], description: '要做的动作' },
				name: { type: 'string', description: '监视器名（create）' },
				condition: { type: 'string', description: '要监视的条件表达式，如 "memory_count > 1000"（create）' },
				type: { type: 'string', enum: ['threshold', 'pattern', 'schedule'], description: '监视器类型（create；缺省 threshold）' },
				sentinel_id: { type: 'string', description: '哨兵 id（cancel / trigger；先用 action=list 拿）' },
				result: { type: 'object', description: '`trigger`：顺带记下触发时的上下文（可选 ✓ —— 引擎会存进该哨兵的触发记录 ✓）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const str = key => (typeof params?.[key] === 'string' ? params[key].trim() : '');
			const auditBase = detail => ({ action: 'executed', tool: 'memory_sentinel', target: 'long', memoryType: 'fact', content: `哨兵 ${action}${detail ? ` ${detail}` : ''}` });
			if (action === 'create') {
				const name = str('name');
				const condition = str('condition');
				if (!name || !condition) { throw new Error('create 需要 name 与 condition'); }
				const s = await sentinelCreate(base, agent, name, condition, str('type') || 'threshold');
				// 形状已核实 ✓（`amAdvanced.ts:133` ⇒ `Sentinel` ✓）
				const ok = typeof s?.id === 'string' && !!s.id;
				await auditAppend({ ...auditBase(`${name}：${condition}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return { ok, action, text: ok ? `已建哨兵「${name}」（id ${s.id}），条件：${condition}。下次维护扫描或 action=check 会评估它 ✓。` : `建哨兵失败：网关没回可用的 id（回执 ${JSON.stringify(s ?? null).slice(0, 200)}）` };
			}
			if (action === 'list') {
				const list = await sentinelList(base, agent);
				const items = Array.isArray(list) ? list : [];
				return {
					ok: Array.isArray(list), action,
					text: items.length
						? `哨兵 ${items.length} 个：\n${items.map(s => `- [${s?.id ?? '?'}] ${s?.name ?? '?'}（${s?.type ?? 'threshold'}）：${s?.condition ?? ''} status=${s?.status ?? 'watching'}${s?.triggeredAt ? ` triggered=${s.triggeredAt}` : ''} created=${s?.createdAt ?? ''}`).join('\n')}`
						: '还没有注册任何哨兵。',
				};
			}
			if (action === 'check') {
				const r = await sentinelCheck(base, agent);
				// 形状已核实 ✓（`amAdvanced.ts:224` ⇒ `SentinelCheckResult`：`checked`/`expired?`/`triggered?`/`errors?` ✓ —— 判据用 `checked` ✓）
				const ok = Number.isFinite(r?.checked);
				await auditAppend({ ...auditBase(), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				if (!ok) { return { ok: false, action, text: `评估失败：网关没回可读结果（回执 ${JSON.stringify(r ?? null).slice(0, 200)}）` }; }
				const parts = [`已评估 ${r.checked} 个 watching 哨兵`];
				if (r.expired) { parts.push(`${r.expired} 个过期`); }
				if (Array.isArray(r.triggered) && r.triggered.length) {
					parts.push(`**触发 ${r.triggered.length} 个**：`);
					for (const t of r.triggered) { parts.push(`  - 「${t?.name ?? '?'}」（${t?.type ?? '?'}）：${JSON.stringify(t?.result ?? null).slice(0, 200)}`); }
				} else { parts.push('没有触发任何哨兵 ✓'); }
				if (Array.isArray(r.errors) && r.errors.length) { parts.push(`错误：${r.errors.map(e => `${e?.id ?? '?'}: ${e?.error ?? '?'}`).join('; ')}`); }
				return { ok: true, action, text: parts.join('\n') };
			}
			if (action === 'cancel') {
				const sid = str('sentinel_id');
				if (!sid) { throw new Error('cancel 需要 sentinel_id'); }
				const r = await sentinelCancel(base, agent, sid);
				const ok = r?.success === true; // 形状已核实 ✓（`amAdvanced.ts:303` ✓）
				await auditAppend({ ...auditBase(`sentinel_id=${sid}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return { ok, action, text: ok ? `哨兵 ${sid} 已取消。` : `取消失败：${r?.error ?? '网关没有回可读信息'}` };
			}
			// 2026-10-14 新增：**直接触发**（跳过条件评估 ⇒ 一定置为 triggered ✓）
			// ⚠ 与 `check` 的分工：`check` 是"先评估**所有**哨兵的条件、满足才触发" ✓；
			//   `trigger` 是"点名触发某一个、不评估" ✓ ⇒ 两者语义不同、都要有 ✓。
			// ⚠ 形状**真机实测已核实**：成功 `{success:true}`、失败 `{success:false, error}` ✓
			//   （与 `compressSession` 那种"null 混两种含义"不同 ⇒ 这里能如实区分成功/失败 ✓）。
			if (action === 'trigger') {
				const sid = str('sentinel_id');
				if (!sid) { throw new Error('trigger 需要 sentinel_id（先用 action=list 拿 ✓）'); }
				const result = params?.result && typeof params.result === 'object' ? params.result : undefined;
				const r = await sentinelTrigger(base, agent, sid, result);
				const ok = r?.success === true;
				await auditAppend({ ...auditBase(`trigger sentinel_id=${sid}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return {
					ok, action,
					text: ok
						? `哨兵 ${sid} 已触发 ✓（status → triggered）`
						: `触发未生效：${r?.error ?? '网关没有回可读信息'}`
							// ⚠⚠ 这句**必须**写：真机实测"重复触发"就是这个错误 ✓ 而它是**幂等保护** ✓
							//   —— 不写清的话，模型会当成故障去重试 ✗（那是本仓反复踩的"把正常态当错误"✓）。
							+ ' ⚠ 若错误是 `sentinel already triggered` ⇒ 那是**幂等保护**（它**已经是** triggered 状态 ✓），'
							+ '**不是故障** ⇒ 别重试；用 `action=list` 看状态即可 ✓',
				};
			}
			throw new Error(`memory_sentinel: 不认识的 action "${action}"（合法：create/list/check/trigger/cancel）`);
		},
	}, {
		// ── 通用只读入口（2026-10-13 建）────────────────────────────────────
		// 为什么用"一个工具 + 方法名"而不是"每个能力一个工具"：见 `MEMORY_API_READONLY` 的头注释
		// （工具定义进系统提示词 ⇒ 数量就是上下文成本 ✓）。
		name: 'memory_api',
		description: '**通用只读记忆入口**：用 `method` 调引擎的高级只读能力（分层读取 / 智能检索 / 技能匹配 / '
			+ '会话观察 / 课程 / 槽位 / 统计诊断 / 清单）。'
			+ ' ⚠ **只读**：它不能写任何东西（写请走 memory_remember / memory_forget / memory_governance 等专用工具 ✓）。'
			+ ' ⚠ 不传 `method`（或传 `list_methods`）⇒ 返回**可用方法清单**（默认只给「方法名+参数」以省上下文 ✓；'
			+ '要看每个方法的**说明**再加 `verbose: true`）——**先看清单再调** ✓。'
			// ⚠ 这个数字**必须用变量**：白名单从 28 一路扩到 53，而硬编码的旧数字**没人守** ✗
			//   （`p3-78` 只对「文档里的工具名」与代码，不查这句 ✓）⇒ 写成变量就永不漂移 ✓。
			+ ' ⚠ 表外的 method 会被**直接拒绝**（不是透传 ✗）：引擎约 200 个方法里只有 '
			+ `${MEMORY_API_READONLY.size} 个被确证过可用，`
			+ '其余要么是未实现的空壳（恒回 null）、要么没验过 ⇒ 不给你猜的机会 ✓。',
		parameters: {
			type: 'object',
			properties: {
				method: { type: 'string', description: '要调用的只读方法名（见 `list_methods` 的清单）；省略则只返回清单' },
				args: {
					type: 'array', description: '该方法的**位置参数**（**不含 agentId** —— 当前分区由插件自动前置，手填会被忽略 ✓）',
					items: {},
				},
				// ★ 2026-10-14：清单默认**瘦身**，`verbose` 才给说明 —— 理由见 execute 里那段注释 ✓
				verbose: { type: 'boolean', description: '仅在 `list_methods` 时有效：给每个方法带上**一句话说明**（默认 false ⇒ 只给「方法名+参数」，省约 2/3 上下文 ✓；要挑方法时再设 true）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, method: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'method', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const method = typeof params?.method === 'string' ? params.method.trim() : '';
			// 清单：既是自描述，也是"该工具能干什么"的**唯一权威来源**（缺了它模型只能猜方法名 ✗）
			if (!method || method === 'list_methods') {
				const entries = [...MEMORY_API_READONLY.entries()];
				// ★ 2026-10-14：清单**默认瘦身**（`verbose` 才给说明）。
				// 为什么：这份清单**每次"不确定能干什么"都要吃一遍**，而完整版实测 **3231 字符**（53 个方法 ×
				// 一句话说明）✗ —— 但模型大多数时候只需要**知道有哪些方法** ✓，说明只在"要挑一个"时才需要。
				// ⇒ 默认只给「方法名+参数」（约 1/3 长度），要说明再加 `verbose: true` ✓。
				// ⚠ 引导语**必须写**：只说"要说明加 verbose"会让模型在**不确定**时干脆不用（
				//   而它本来就不该在不确定时调引擎 ✓）⇒ 明确写"按需" ✓。
				if (params?.verbose !== true) {
					return {
						ok: true, method: 'list_methods',
						text: `可用只读方法 ${entries.length} 个（args 不含 agentId —— 由插件自动前置 ✓）：\n`
							+ entries.map(([name, m]) => `${name}(${m.args || ''})`).join(' | ')
							+ '\n\n要挑方法时再调一次并加 `verbose: true`（带每个方法的一句话说明，约 3 倍长度 ⇒ 按需用 ✓）。'
							+ '\n⚠ 表外的 method 一律被拒（含写方法与引擎里未实现的空壳 ✓）。',
					};
				}
				const lines = entries
					.map(([name, m]) => `- ${name}(${m.args})${m.args ? '' : '（无参数）'} —— ${m.note}`);
				return {
					ok: true, method: 'list_methods',
					text: `可用的只读方法 ${entries.length} 个（args 从**不含 agentId** 的位置开始 ✓）：\n${lines.join('\n')}\n`
						+ '\n⚠ 引擎里另有约 170 个方法**刻意不在此表**：铁证为未实现空壳的（如 `traceProvenance` ⇒ 恒回 null）'
						+ '与未经真机验证的都在外 ✗ —— 需要哪个先说一声，验过再加 ✓。',
				};
			}
			const spec = MEMORY_API_READONLY.get(method);
			if (!spec) {
				// ⚠ 负对照：表外**必须拒绝**（写成"透传任意方法"＝白名单形同虚设 ✗）。回话里带上最近的名字，
				// 让模型能自我纠正（而不是盲猜一轮 ✓）。
				const near = [...MEMORY_API_READONLY.keys()].filter(k => k.toLowerCase().includes(method.toLowerCase().slice(0, 4)));
				throw new Error(`memory_api: 方法 "${method}" 不在**只读白名单**里 ⇒ 拒绝执行`
					+ `（不存在的引擎方法 / 未验证的方法 / 写方法都不放行 ✗）。`
					+ `${near.length ? `你是不是想调：${near.join(' / ')}？` : '先用 method=list_methods 看清单 ✓。'}`);
			}
			const base = requireGateway(config);
			// ⚠ agentId 由这里**前置**，不从参数取：手填等于让模型有机会写到别的分区 ✗（跨 agent 泄漏）
			const rest = Array.isArray(params?.args) ? params.args : [];
			try {
				const raw = await providerCall(base, method, [agentIdOf(config), ...rest]);
				const value = raw === undefined ? null : raw;
				const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
				// ⚠ 空结果**照实说**（不能美化成长句）：引擎回空有"真没数据"与"方法其实是空壳"两种，
				//   调用方需要能看出这个区别 ✓（这条与 p3-07 的"回 null 必须判失败"同一纪律 ✓）。
				const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0);
				return {
					ok: true, method,
					text: empty
						? `${method} 返回**空**（${value === null ? 'null' : Array.isArray(value) ? '[]' : "''"}）—— 要么本分区确实没有这类数据，要么该方法在引擎侧是空实现 ✓。`
						: `${method}（args=${JSON.stringify(rest)}）→\n${body}`,
				};
			} catch (error) {
				// 网关的报错**原样转述**（不吞成"操作失败" ✗）：参数不对时那句话本身就是纠正依据 ✓
				return { ok: false, method, text: `${method} 调用失败：${error?.message ?? error}` };
			}
		},
	}, {
		// ── 槽位（memory slot）─────────────────────────────────────────────
		// 为什么单独做成工具而不是靠 `memory_api`：槽位**一半是写**（create/set/append/replace/delete/reflect），
		// 而 `memory_api` 是**只读**入口 ⇒ 写类要独立走审批闸 ✓。
		// ⚠ 内部直接用 `providerCall` 而不在 `lib/gateway.js` 加一堆薄封装：`gateway.js` 里**一个 slot 方法都没有**
		//   （只有 `workingContext` 经 `loadContext` 间接读 ✓）⇒ 为 8 个方法各写一层一行的转发**没有信息量** ✓；
		//   `memory_api` 已开先例 ✓，且方法名与参数**逐字来自**引擎签名（`agentMemoryProviderV2.ts` ✓）⇒ 可核对 ✓。
		name: 'memory_slot',
		description: '**槽位**（slot）读写：槽位是"每轮对话都会带上"的**常驻上下文**（比普通记忆更靠近提示词），'
			+ '适合放"当前任务与偏好"这类需要一直生效的东西。'
			+ ' `list` / `get` **只读**（不弹窗 ✓）；`create` / `set` / `append` / `replace` / `delete` / `reflect` **是写**（需审批 ✓）。'
			+ ' ⚠ 先 `list` 看现有槽位与它们的 `sizeLimit`（超出上限的内容会被引擎截断 ✓），再决定 `set` 还是 `append`。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['list', 'get', 'create', 'set', 'append', 'replace', 'delete', 'reflect'], description: '要做的动作' },
				label: { type: 'string', description: '槽位名（`list` 之外都必填；`list` 能告诉你现有哪些）' },
				content: { type: 'string', description: '整段内容（create / set / replace）' },
				text: { type: 'string', description: '要追加的片段（append —— 与 set 的区别是它**不覆盖**已有内容 ✓）' },
				session_id: { type: 'string', description: '会话 id（reflect：把该会话的观察反思进槽位）' },
				max_observations: { type: 'integer', description: '反思时最多取多少条观察（reflect；可选）' },
				size_limit: { type: 'integer', description: '该槽位的内容上限（create；可选）' },
				description: { type: 'string', description: '槽位用途说明（create；可选 —— 它会出现在 `list` 的结果里，给以后的自己看 ✓）' },
				pinned: { type: 'boolean', description: '是否常驻进提示词（create；可选）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const label = typeof params?.label === 'string' ? params.label.trim() : '';
			const str = key => (typeof params?.[key] === 'string' ? params[key] : '');
			// 写类动作走审计（只读不动审计 —— 与 `memory_governance` 的 audit 同判据 ✓）
			const auditBase = detail => ({ action: 'executed', tool: 'memory_slot', target: 'long', memoryType: 'fact', content: `槽位 ${action} ${label}${detail ? ` ${detail}` : ''}` });
			// 每个动作 → 引擎方法名 + 除 agentId 外的位置参数（逐字对齐 `agentMemoryProviderV2.ts` 的签名 ✓）
			const plan = {
				create: { method: 'slotCreate', argv: () => [{ label, content: str('content'), sizeLimit: params?.size_limit, description: str('description'), pinned: params?.pinned === true }] },
				set: { method: 'slotSet', argv: () => [label, str('content')] },
				append: { method: 'slotAppend', argv: () => [label, str('text')] },
				replace: { method: 'slotReplace', argv: () => [label, str('content')] },
				delete: { method: 'slotDelete', argv: () => [label] },
				reflect: { method: 'slotReflect', argv: () => [str('session_id'), params?.max_observations] },
			};
			const render = list => (Array.isArray(list) ? list : [])
				.map(s => `- ${s?.label ?? s?.name ?? '?'}${s?.pinned ? ' 📌' : ''}${Number.isFinite(s?.sizeLimit) ? `（上限 ${s.sizeLimit}）` : ''}${s?.description ? `：${s.description}` : ''}\n  ${String(s?.content ?? '').slice(0, 300) || '（空）'}`)
				.join('\n');
			if (action === 'list') {
				const list = await providerCall(base, 'slotList', [agent]);
				return { ok: Array.isArray(list), action, text: Array.isArray(list) && list.length ? `槽位 ${list.length} 个：\n${render(list)}` : '当前没有任何槽位（用 action=create 建一个 ✓）。' };
			}
			if (action === 'get') {
				if (!label) { throw new Error('get 需要 label'); }
				const content = await providerCall(base, 'getSlot', [agent, label]);
				// ⚠ 回空**照实说**：引擎对"槽位不存在"与"槽位是空的"都回空串 ⇒ 不编造 ✓（与 p3-80 的判据一致 ✓）
				return { ok: true, action, text: typeof content === 'string' && content ? `槽位「${label}」的内容：\n${content}` : `槽位「${label}」读出**空**（可能不存在，也可能是空槽 —— 用 action=list 看有没有这个 label ✓）。` };
			}
			const step = plan[action];
			if (!step) { throw new Error(`memory_slot: 不认识的 action "${action}"（合法：list/get/create/set/append/replace/delete/reflect）`); }
			if (!label) { throw new Error(`${action} 需要 label`); }
			if (action === 'reflect' && !str('session_id')) { throw new Error('reflect 需要 session_id'); }
			if (action !== 'delete' && action !== 'reflect' && !str('content') && !str('text')) {
				throw new Error(`${action} 的内容不能为空（content${action === 'append' ? ' / text' : ''}）`);
			}
			const reply = await providerCall(base, step.method, [agent, ...step.argv()]);
			await auditAppend({ ...auditBase(`(${step.method})`), outcome: 'ok' });
			const body = typeof reply === 'string' ? reply : JSON.stringify(reply ?? null);
			return { ok: true, action, text: `槽位 ${action} 已完成（${step.method}）。\n${body.slice(0, 400)}` };
		},
	}, {
		// ── 课程（lesson）─────────────────────────────────────────────────
		// 为什么独立成工具：同 `memory_slot` —— `save` / `delete` 是写 ⇒ 不能塞进只读的 `memory_api` ✓。
		// ⚠⚠ **刻意没收 `getTopLessons` / `searchLessons`**：这两个在引擎里是**单行体空实现**（恒回 `[]` ✗，
		//   见 `MEMORY_API_READONLY` 头注释里那份 17 个桩的清单 ✓）⇒ 收进来只会浪费调用并让模型以为"没有课程" ✗。
		//   要"按相关度找课程"用 **`recall`**（走 `lessonRecall`，真实现 ✓）。
		// ⚠⚠ **刻意没收 `addLesson`**：它的签名有 `tags`，但实现是
		//     `fn.lessonSave(kv, agentId, content, context, 0.8)` —— **`tags` 根本没被用** ✗✗（静默丢弃）。
		//   ⇒ 它没有任何 `lessonSave` 不具备的能力 ⇒ 收两个只会让模型纠结"该调哪个" ✗。
		//     （这条是读实现读出来的，光看签名会以为 `tags` 有用 ✓ —— 与 provenance 那次同类的教训 ✓。）
		name: 'memory_lesson',
		description: '**课程**（lesson）读写：课程是"从错里学到的东西"，用于跨会话避免重复踩坑。'
			+ ' `list` / `recall` **只读**（不弹窗 ✓）；`save` / `delete` **是写**（需审批 ✓）。'
			+ ' ⚠ 想找"和当前任务相关的课程"用 `recall`（带 query）而不是 `list` + 自己翻 ✓。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['list', 'recall', 'save', 'delete'], description: '要做的动作' },
				query: { type: 'string', description: '检索词（recall）' },
				project: { type: 'string', description: '限定项目（recall / save；可选）' },
				limit: { type: 'integer', description: '最多几条（recall；可选）' },
				content: { type: 'string', description: '课程正文 —— 写清"什么情况下、该怎么做/不该怎么做"（save）' },
				context: { type: 'string', description: '这条课程从哪来的（save；可选 —— 给以后的自己留线索 ✓）' },
				confidence: { type: 'number', description: '确信度 0–1（save；可选）' },
				lesson_id: { type: 'string', description: '要删的课程 id（delete —— 先用 list 拿到）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const str = key => (typeof params?.[key] === 'string' ? params[key].trim() : '');
			const auditBase = detail => ({ action: 'executed', tool: 'memory_lesson', target: 'long', memoryType: 'fact', content: `课程 ${action}${detail ? ` ${detail}` : ''}` });
			// ⚠ 只读分支**不同审计**（与 `memory_governance` 的 audit / `memory_slot` 的 list 同判据 ✓）
			if (action === 'list' || action === 'recall') {
				// ⚠ 先校验再调用（否则空 query 会先打到网关才被拒 —— 白跑一次网络 ✓）
				if (action === 'recall' && !str('query')) { throw new Error('recall 需要 query'); }
				const reply = action === 'list'
					? await providerCall(base, 'getLessons', [agent])
					: await providerCall(base, 'lessonRecall', [agent, str('query'), str('project') || undefined, params?.limit]);
				const items = Array.isArray(reply) ? reply : (Array.isArray(reply?.lessons) ? reply.lessons : []);
				const body = items.length
					? items.map((l, i) => {
						const id = l?.id ?? l?.lesson?.id ?? '?';
						const text = l?.content ?? l?.lesson?.content ?? '';
						const why = l?.reason ?? l?.matchReason ?? '';
						const ctx = l?.context ?? l?.lesson?.context ?? '';
						const conf = l?.confidence ?? l?.lesson?.confidence;
						return `[${i + 1}] ${id}${Number.isFinite(conf) ? `（确信度 ${conf}）` : ''}\n  ${String(text).slice(0, 400)}${ctx ? `\n  来源：${String(ctx).slice(0, 160)}` : ''}${why ? `\n  为什么相关：${why}` : ''}`;
					}).join('\n')
					: (action === 'list' ? '还没有任何课程（用 action=save 记一条 ✓）。' : `没有与「${str('query')}」相关的课程。`);
				return { ok: true, action, text: items.length ? `课程 ${items.length} 条：\n${body}` : body };
			}
			if (action === 'save') {
				const content = str('content');
				if (!content) { throw new Error('save 需要 content'); }
				const conf = Number.isFinite(params?.confidence) ? params.confidence : undefined;
				const reply = await providerCall(base, 'lessonSave', [agent, content, str('context') || undefined, conf, str('project') || undefined]);
				await auditAppend({ ...auditBase(content.slice(0, 80)), outcome: 'ok' });
				return { ok: true, action, text: `已记下课程（${JSON.stringify(reply ?? null).slice(0, 200)}）。` };
			}
			if (action === 'delete') {
				const id = str('lesson_id');
				if (!id) { throw new Error('delete 需要 lesson_id'); }
				await providerCall(base, 'deleteLesson', [agent, id]);
				await auditAppend({ ...auditBase(id), outcome: 'ok' });
				return { ok: true, action, text: `课程 ${id} 已删除。` };
			}
			throw new Error(`memory_lesson: 不认识的 action "${action}"（合法：list/recall/save/delete）`);
		},
	}, {
		// ── 行动链 / 草图 / 信号（2026-10-13 建）──────────────────────────
		// ⚠ 为什么**另开工具**而不是像 checkpoint/snapshot 那样塞进 `memory_governance`：
		//   那三个与"**治理**"（删除 / 审计 / 回滚）是同一语义域（都是"对已有记忆做处置"）✓；
		//   而 `action` / `sketch` / `signal` 是**另一条链**（"行动 → 草图 → 结晶 → 跨代理信号" ✓）。
		//   塞进 governance 会让它的 action 涨到 8 个且**语义混杂** ⇒ 模型更难选对 ✗；
		//   多一个工具（提示词成本 +1 条）换来边界清楚，是划算的 ✓。
		// ⚠⚠ 三处**必须用"读"而不是同名的桩**（本仓第三次遇到这种"名字更像读的反而更差" ✗）：
		//   · 列行动用 **`actionList`** ✓，**不是** `getActions`（`getActions` ⇒ `{ return []; }` **桩** ✗）；
		//   · 列信号用 **`signalQuery`** ✓，**不是** `getSignals`（同样是桩 ✗）。
		//   判据同上：源码单行体空实现 ⇒ 永不收录（`MEMORY_API_READONLY` 头注释里有全清单 ✓）。
		name: 'memory_work',
		description: '**行动链 / 草图 / 信号**：`action` 是待办与依赖（`blocks` / `depends_on` / `relates_to` / `supersedes`），'
			+ '`sketch` 是"还没定形的想法、可以挂若干行动"（有有效期，7 天后过期），'
			+ '`signal` 是**跨 agent** 的短消息（默认 24h 过期）。'
			+ ' ⚠ 只读：各组的 `list` / `get`；其余（`create` / `update` / `edge` / `add` / `discard` / `send`）**是写**（需审批 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				group: { type: 'string', enum: ['action', 'sketch', 'signal'], description: '哪一组' },
				sub: { type: 'string', description: 'action: list(缺省)/get/create/update/edge；sketch: list(缺省)/create/add/discard；signal: list(缺省)/send/threads。⚠ 缺省 = list（只读）✓' },
				id: { type: 'string', description: '目标 id（action 的 get/update、sketch 的 add/discard；先用 list 拿到）' },
				title: { type: 'string', description: '标题（action / sketch 的 create）' },
				description: { type: 'string', description: '说明（action / sketch 的 create；可选）' },
				priority: { type: 'number', description: '优先级（action 的 create / update；可选）' },
				status: { type: 'string', description: '新状态（action 的 update，如 pending/done/failed）' },
				from: { type: 'string', description: '起点行动 id（action 的 edge）' },
				to: { type: 'string', description: '终点行动 id（action 的 edge）' },
				edge_type: { type: 'string', enum: ['blocks', 'depends_on', 'relates_to', 'supersedes'], description: '关系类型（action 的 edge）' },
				action_id: { type: 'string', description: '要挂到草图上的行动 id（sketch 的 add）' },
				limit: { type: 'integer', description: '线程数上限（signal 的 threads；可选）' },
				type: { type: 'string', description: '信号类型（signal 的 send，如 info/request/done）' },
				content: { type: 'string', description: '信号内容（signal 的 send）' },
				peer: { type: 'string', description: '收件方 agent id（signal 的 send；可选 —— 不填是广播 ✓）' },
			},
			required: ['group'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, group: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'group', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const group = typeof params?.group === 'string' ? params.group : '';
			const sub = typeof params?.sub === 'string' && params.sub ? params.sub : 'list'; // 缺省只读 ✓
			const str = key => (typeof params?.[key] === 'string' ? params[key].trim() : '');
			const auditBase = detail => ({ action: 'executed', tool: 'memory_work', target: 'long', memoryType: 'fact', content: `${group} ${sub}${detail ? ` ${detail}` : ''}` });
			const rows = (list, render) => (Array.isArray(list) ? `共 ${list.length} 条：\n${list.map(render).join('\n')}` : `结果不是列表（回执 ${JSON.stringify(list ?? null).slice(0, 160)}）`);

			if (group === 'action') {
				if (sub === 'list') {
					const list = await providerCall(base, 'actionList', [agent]); // ⚠ 不是桩 `getActions` ✗
					return { ok: Array.isArray(list), group, text: Array.isArray(list) && list.length ? rows(list, a => `- ${a?.id} [${a?.status ?? '?'}] p${a?.priority ?? '-'}「${a?.title ?? ''}」${a?.description ? ` ${String(a.description).slice(0, 120)}` : ''}`) : '没有行动项（`sub=create` 加一个 ✓）。' };
				}
				if (sub === 'get') {
					const id = str('id');
					if (!id) { throw new Error('action get 需要 id'); }
					const a = await providerCall(base, 'actionGet', [agent, id]);
					return { ok: !!a?.id, group, text: a?.id ? `- ${a.id} [${a.status ?? '?'}] p${a.priority ?? '-'}「${a.title ?? ''}」${a.description ? `\n  ${String(a.description).slice(0, 300)}` : ''}` : `没找到行动 ${id}（回执 ${JSON.stringify(a ?? null).slice(0, 120)}）` };
				}
				if (sub === 'create') {
					const title = str('title');
					if (!title) { throw new Error('action create 需要 title'); }
					const a = await providerCall(base, 'actionCreate', [agent, title, str('description') || undefined, Number.isFinite(params?.priority) ? params.priority : undefined]);
					const ok = typeof a?.id === 'string' && !!a.id;
					await auditAppend({ ...auditBase(`create ${title}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, group, text: ok ? `已建行动 ${a.id}「${title}」（status=${a.status ?? 'pending'}）。` : `建行动失败（回执 ${JSON.stringify(a ?? null).slice(0, 160)}）` };
				}
				if (sub === 'update') {
					const id = str('id');
					if (!id) { throw new Error('action update 需要 id'); }
					const a = await providerCall(base, 'actionUpdate', [agent, id, str('status') || undefined, Number.isFinite(params?.priority) ? params.priority : undefined]);
					const ok = typeof a?.id === 'string' && !!a.id;
					await auditAppend({ ...auditBase(`update ${id} ${str('status') || ''}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, group, text: ok ? `行动 ${a.id} 已更新（status=${a.status ?? '?'}，priority=${a.priority ?? '?'}）。` : `更新失败：引擎没找到行动 ${id}（回执 ${JSON.stringify(a ?? null).slice(0, 120)}）` };
				}
				if (sub === 'edge') {
					const from = str('from'); const to = str('to');
					if (!from || !to) { throw new Error('action edge 需要 from 与 to'); }
					const e = await providerCall(base, 'actionEdgeCreate', [agent, from, to, str('edge_type') || undefined]);
					const ok = typeof e?.id === 'string' && !!e.id;
					await auditAppend({ ...auditBase(`edge ${from}->${to}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, group, text: ok ? `已建关系 ${e.id}：${from} —${e.type ?? '?'}→ ${to}。` : `建关系失败（回执 ${JSON.stringify(e ?? null).slice(0, 160)}）` };
				}
				throw new Error(`memory_work action: 不认识的 sub "${sub}"（合法：list/get/create/update/edge）`);
			}

			if (group === 'sketch') {
				if (sub === 'list') {
					const list = await providerCall(base, 'sketchList', [agent]);
					return { ok: Array.isArray(list), group, text: Array.isArray(list) && list.length ? rows(list, s => `- ${s?.id} [${s?.status ?? '?'}]「${s?.title ?? ''}」挂 ${Array.isArray(s?.actionIds) ? s.actionIds.length : 0} 个行动 expires=${s?.expiresAt ?? '?'}`) : '没有草图（`sub=create` 起一个 ✓）。' };
				}
				if (sub === 'create') {
					const title = str('title');
					if (!title) { throw new Error('sketch create 需要 title'); }
					const s = await providerCall(base, 'sketchCreate', [agent, title, str('description') || undefined]);
					const ok = typeof s?.id === 'string' && !!s.id;
					await auditAppend({ ...auditBase(`create ${title}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, group, text: ok ? `已建草图 ${s.id}「${title}」（${s.expiresAt ? `${s.expiresAt} 过期` : '有有效期'} —— 用 sub=add 挂行动 ✓）。` : `建草图失败（回执 ${JSON.stringify(s ?? null).slice(0, 160)}）` };
				}
				if (sub === 'add') {
					const id = str('id'); const aid = str('action_id');
					if (!id || !aid) { throw new Error('sketch add 需要 id（草图）与 action_id（行动）'); }
					const r = await providerCall(base, 'sketchAdd', [agent, id, aid]);
					// ⚠ 引擎回 `{success, error?}` ✓ ⇒ **必须按 `success` 判**（不存在的草图会回 false ✗）
					const ok = r?.success === true;
					await auditAppend({ ...auditBase(`add ${aid}->${id}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, group, text: ok ? `已把行动 ${aid} 挂到草图 ${id} 上。` : `挂载失败：${r?.error ?? '网关没回可读信息'}（回执 ${JSON.stringify(r ?? null).slice(0, 160)}）` };
				}
				if (sub === 'discard') {
					const id = str('id');
					if (!id) { throw new Error('sketch discard 需要 id'); }
					const ok = await providerCall(base, 'sketchDiscard', [agent, id]);
					// ⚠ 引擎回**布尔** ✓ ⇒ 只有 `true` 才算成功 ✓
					await auditAppend({ ...auditBase(`discard ${id}`), outcome: ok === true ? 'ok' : 'rejected-by-gateway' });
					return { ok: ok === true, group, text: ok === true ? `草图 ${id} 已丢弃。` : `丢弃失败：引擎没找到草图 ${id}（回执 ${JSON.stringify(ok ?? null).slice(0, 80)}）` };
				}
				throw new Error(`memory_work sketch: 不认识的 sub "${sub}"（合法：list/create/add/discard）`);
			}

			if (group === 'signal') {
				if (sub === 'list') {
					const list = await providerCall(base, 'signalQuery', [agent]); // ⚠ 不是桩 `getSignals` ✗
					return { ok: Array.isArray(list), group, text: Array.isArray(list) && list.length ? rows(list, s => `- ${s?.id} ${s?.from ?? '?'}→${s?.to ?? '(广播)'} [${s?.type ?? '?'}] ${String(s?.content ?? '').slice(0, 160)}（${s?.createdAt ?? ''}）`) : '没有信号。' };
				}
				if (sub === 'send') {
					const type = str('type'); const content = str('content');
					if (!type || !content) { throw new Error('signal send 需要 type 与 content'); }
					const s = await providerCall(base, 'signalSend', [agent, type, content, str('peer') || undefined]);
					const ok = typeof s?.id === 'string' && !!s.id;
					await auditAppend({ ...auditBase(`send ${type}->${str('peer') || 'broadcast'}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
					return { ok, group, text: ok ? `已发信号 ${s.id}（${s.from} → ${s.to ?? '(广播)'}，${s.expiresAt ? `${s.expiresAt} 过期` : ''}）。` : `发信号失败（回执 ${JSON.stringify(s ?? null).slice(0, 160)}）` };
				}
				if (sub === 'threads') {
					const r = await providerCall(base, 'signalThreads', [agent, Number.isFinite(params?.limit) ? params.limit : undefined]);
					const th = Array.isArray(r?.threads) ? r.threads : [];
					return { ok: r?.success === true, group, text: r?.success === true ? (th.length ? `线程 ${th.length} 个：\n${th.map(t => `- ${t?.threadId ?? '?'}：${t?.messages ?? 0} 条，最近 ${t?.lastMessage ?? '?'}，参与方 ${Array.isArray(t?.participants) ? t.participants.join('/') : '?'}`).join('\n')}` : '还没有任何信号线程。') : `查询失败（回执 ${JSON.stringify(r ?? null).slice(0, 160)}）` };
				}
				throw new Error(`memory_work signal: 不认识的 sub "${sub}"（合法：list/send/threads）`);
			}
			throw new Error(`memory_work: 不认识的 group "${group}"（合法：action/sketch/signal）`);
		},
	}, {
		// ── 导入（2026-10-13 建）───────────────────────────────────────────
		// ⚠ 与 `memory_api` 的 `exportMemories` 配对：**读在那侧、写在这侧** ✓（见 `MEMORY_API_READONLY` 里的说明）。
		// 两个 action 都**是写** ⇒ 本工具无条件过闸（没有只读形态 ✓，不需要 `isWriteIntent` 分支）。
		name: 'memory_import',
		description: '**把记忆导回来**（写）：`import` 吃 `exportMemories` 的整份返回；'
			+ '`replay` 吃 **JSONL 会话日志**（每行一个事件，只认 `role` 为 user/human/tool_use/tool_result/tool 的行 ✓）。'
			+ ' ⚠ 两者都会**写入/追加**记忆 ⇒ 需审批。导出用 `memory_api` 的 `exportMemories`（只读 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['import', 'replay'], description: '要做的动作' },
				data: { type: 'object', description: '`import`：`exportMemories` 的完整返回（含 `memories[]`）。⚠ 只接受那一种形状 —— 别的形状会被引擎拒（它按 `data.memories` 迭代 ✓）' },
				session_id: { type: 'string', description: '`replay`：这些事件归属的会话 id' },
				jsonl: { type: 'string', description: '`replay`：JSONL 文本（每行一个事件）' },
				max_events: { type: 'integer', description: '`replay`：最多导入多少条（缺省 200；超出的计入 `skipped` ✓）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const auditBase = detail => ({ action: 'executed', tool: 'memory_import', target: 'long', memoryType: 'fact', content: `导入 ${action}${detail ? ` ${detail}` : ''}` });
			if (action === 'import') {
				const data = params?.data;
				// ⚠ 先在**本地**把形状挡住：引擎对坏数据是 **HTTP 500**（`data.memories is not iterable` ✓）
				//   ⇒ 与其让它 500，不如这里给一句人话（**但报错原话也要带上**，不能只说"参数不对" ✗）。
				if (!data || typeof data !== 'object' || !Array.isArray(data.memories)) {
					throw new Error(`import 需要 \`exportMemories\` 的整份返回（至少含 \`memories[]\`）—— 收到 ${data === null ? 'null' : Array.isArray(data) ? '一个数组' : typeof data}。`
						+ '（引擎对别的形状会直接 500：`data.memories is not iterable` ✓）');
				}
				const reply = await providerCall(base, 'importMemories', [agent, data]);
				// 引擎回**数字**（导入条数 ✓）⇒ 必须是有限数才算成（回 `undefined`/对象都判失败 ✓）
				const ok = Number.isFinite(reply);
				await auditAppend({ ...auditBase(`memories=${data.memories.length}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return { ok, action, text: ok ? `已导入 ${reply} 条（请求 ${data.memories.length} 条）。` : `导入失败：引擎没回可读的条数（回执 ${JSON.stringify(reply ?? null).slice(0, 200)}）` };
			}
			if (action === 'replay') {
				const sessionId = typeof params?.session_id === 'string' ? params.session_id.trim() : '';
				const jsonl = typeof params?.jsonl === 'string' ? params.jsonl : '';
				if (!sessionId) { throw new Error('replay 需要 session_id'); }
				if (!jsonl.trim()) { throw new Error('replay 需要 jsonl'); }
				const maxEvents = Number.isFinite(params?.max_events) ? Math.max(1, Math.floor(params.max_events)) : 200;
				const reply = await providerCall(base, 'replayImportJsonl', [agent, sessionId, jsonl, maxEvents]);
				const imported = Number.isFinite(reply?.imported) ? reply.imported : undefined;
				const skipped = Number.isFinite(reply?.skipped) ? reply.skipped : undefined;
				const ok = imported !== undefined;
				await auditAppend({ ...auditBase(`replay session=${sessionId} imported=${imported ?? '?'}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				// ⚠ `skipped` 大而 `imported=0` 是最可能踩的坑（格式不对 ⇒ 引擎**静默跳过**，不报错 ✗）
				//   ⇒ 这时必须**提示格式**，否则调用方会以为"日志是空的" ✓。
				const hint = (imported === 0 && (skipped ?? 0) > 0)
					? '\n⚠ 全部被跳过：`replay` 只认 `role` 为 user / human / tool_use / tool_result / tool 的行（其余字段如 `content`/`text` 二者取一 ✓）。'
					: '';
				return { ok, action, text: ok ? `回放导入：imported=${imported}，skipped=${skipped}。${hint}` : `回放失败：引擎没回可读计数（回执 ${JSON.stringify(reply ?? null).slice(0, 200)}）` };
			}
			throw new Error(`memory_import: 不认识的 action "${action}"（合法：import/replay）`);
		},
	}, {
		// ── 技能落盘（2026-10-13 建）───────────────────────────────────────
		// ★★ **建这个工具是因为一次实证，不是因为"引擎有那些方法"**：
		//   我本来把"技能"归为"**两侧都没做成工具** ⇒ 产品决策，先不动" ✗。但真机实测发现这条链是**通的**：
		//     引擎自动抽取技能（`extractSkill` → KV，形如 `skl-xxx`）
		//       → `writeAllSkillFiles` → `<skillsDir>/<slug>/SKILL.md`（**带 `match:` frontmatter + 标准章节** ✓）
		//       → 平台的 `vssaros-skills` 插件（`skill_manage` / `skill_search`）就能用 ✓
		//   ⇒ 两个"技能"**不是两套系统**，是同一条链的**两端** ✓（平台那个工具的说明里也写着"技能是你的**程序性记忆**" ✓）。
		//   ⇒ dsh 侧此前**有前端**（`skill_manage` 管 SKILL.md ✓）却**没有"把引擎学到的落成技能"的入口** ✗✗
		//     —— 这正是本工具要补的那一环 ✓。
		// ⚠ 只装**写类**：`listSkills` / `getSkillStats` / `skillMatch` 是只读、**已在 `memory_api` 白名单** ✓
		//   （重复收会变成"两个入口让模型猜" ✗）。
		name: 'memory_skill',
		description: '**把记忆引擎抽出的技能落成平台技能文件**（写）：`write` 把引擎侧的技能写成 '
			+ '`<数据根>/skills/<slug>/SKILL.md` ⇒ 平台技能库（`skill_manage` / `skill_search`）立刻可用 ✓。'
			+ ' ⚠ 先 `memory_api` 的 `listSkills` 看有哪些（没有就先让它自动抽取，或 `add` 一个）。'
			+ ' ⚠ `delete_file` 会**删掉磁盘上的技能目录**（引擎里的记录还在 ⇒ 可再 `write` 回来 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['write', 'delete_file', 'extract'], description: '要做的动作' },
				skill_id: { type: 'string', description: '`write` 想只落一个时给（不给则**全部**落盘 ✓）；`delete_file` 必给' },
				session_id: { type: 'string', description: '`extract`：从哪个会话里抽技能（先用 `memory_api` 的 `listSessions` 拿）' },
			},
			required: ['action'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' } },
				required: ['ok', 'action', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const base = requireGateway(config);
			const agent = agentIdOf(config);
			const action = typeof params?.action === 'string' ? params.action : '';
			const skillId = typeof params?.skill_id === 'string' ? params.skill_id.trim() : '';
			const auditBase = detail => ({ action: 'executed', tool: 'memory_skill', target: 'long', memoryType: 'fact', content: `技能 ${action}${detail ? ` ${detail}` : ''}` });
			if (action === 'write') {
				if (skillId) {
					const r = await providerCall(base, 'writeSkillFile', [agent, skillId]);
					// ⚠ 引擎回 `{ok, path?, error?}` ✓ ⇒ **按 `ok` 判**，并把 `path` 如实回报（人能去核对 ✓）
					await auditAppend({ ...auditBase(skillId), outcome: r?.ok === true ? 'ok' : 'rejected-by-gateway' });
					return { ok: r?.ok === true, action, text: r?.ok === true ? `技能 ${skillId} 已写成文件${r.path ? `：${r.path}` : ''}（平台侧可用了 ✓）。` : `落盘失败：${r?.error ?? '网关没回可读信息'}（回执 ${JSON.stringify(r ?? null).slice(0, 160)}）` };
				}
				const r = await providerCall(base, 'writeAllSkillFiles', [agent]);
				// 引擎回 `{written, failed, errors[]}` ✓ —— ⚠ 有 `failed` 时必须**如实说出来**，不能只报成功数 ✗
				const ok = Number.isFinite(r?.written) && !(r.failed > 0);
				await auditAppend({ ...auditBase(`all written=${r?.written ?? '?'}`), outcome: ok ? 'ok' : 'rejected-by-gateway' });
				return {
					ok, action,
					text: Number.isFinite(r?.written)
						? `技能落盘：成功 ${r.written} 个${r.failed ? `，**失败 ${r.failed} 个**：${(r.errors ?? []).slice(0, 3).join('；')}` : '，无失败 ✓'}`
						: `落盘失败：网关没回可读计数（回执 ${JSON.stringify(r ?? null).slice(0, 160)}）`,
				};
			}
			if (action === 'delete_file') {
				if (!skillId) { throw new Error('delete_file 需要 skill_id'); }
				const r = await providerCall(base, 'deleteSkillFile', [agent, skillId]);
				// 引擎回 `{ok, deleted?, error?}` ✓ ⇒ 按 `ok` 判（⚠ `deleted:false` 也算"文件本来就不在"⇒ 仍报 ok ✓）
				await auditAppend({ ...auditBase(skillId), outcome: r?.ok === true ? 'ok' : 'rejected-by-gateway' });
				return { ok: r?.ok === true, action, text: r?.ok === true ? `技能 ${skillId} 的文件已删除（引擎里的记录还在 ⇒ 可再 write 回来 ✓）。` : `删除失败：${r?.error ?? '网关没回可读信息'}（回执 ${JSON.stringify(r ?? null).slice(0, 160)}）` };
			}
			if (action === 'extract') {
				const sessionId = typeof params?.session_id === 'string' ? params.session_id.trim() : '';
				if (!sessionId) { throw new Error('extract 需要 session_id'); }
				const r = await providerCall(base, 'extractSkill', [agent, sessionId]);
				await auditAppend({ ...auditBase(`session=${sessionId}`), outcome: 'ok' });
				return { ok: true, action, text: `已从会话 ${sessionId} 抽取技能（${JSON.stringify(r ?? null).slice(0, 200)}）。⚠ 抽出来只在引擎侧 ⇒ 要用它就再跑 write ✓。` };
			}
			throw new Error(`memory_skill: 不认识的 action "${action}"（合法：write/delete_file/extract）`);
		},
	}];
}

/**
 * 写入类工具（审批闸只拦这些 ✓，见 README 5.104）。
 *
 * 为什么导出：跨模块守卫（`dshPluginPackages.test.ts`）拿它**机器核对** —— 名单非空 ✓、
 * 每个名字都真的被注册 ✓（防"闸挂了但名单是空的" ✗ 这种最像修好了的坏法 ✓）。
 *
 * ⚠ **名单里只有 `memory_remember`，不含 `memory_refresh`** —— 报告 R1 把后者也列成"写"，但按代码它只
 * 重取一次**记忆网关快照**并刷新注入文本 ⇒ **不改任何用户数据** ✗。给它弹窗只会造成审批疲劳，
 * 与 kb 那条"dry-run 只出计划 ⇒ 不该弹窗"是**同一判据** ✓（判据是"会不会改用户数据"，不是"函数名像不像写"）。
 */
export const WRITE_TOOLS = [
	'memory_remember',
	// 2026-10-13 批 1：判据仍是"**会不会改用户数据**"（不是"名字像不像写" ✓）——
	// 软删除（标记 superseded）/ 级联把下游标 stale / 行动链结晶，三者都会改 ⇒ 一律过闸 ✓。
	// 反例（**刻意不过闸**）：`memory_obsidian_export` 只**返回** markdown ✓、`memory_recall` 只读 ✓。
	'memory_forget', 'memory_cascade', 'memory_crystal',
	// 批 2a：两个多 action 工具 —— 它们在名单里，但**具体某次调用是否真写**由 `isWriteIntent` 判 ✓
	//（`memory_routine` 的 list/get/status 只读 ⇒ 不弹窗 ✗；`memory_improve` 三个 action 全写 ✓）。
	'memory_routine', 'memory_improve',
	// 批 2b：`memory_facet` 的 query/get/stats/dimensions 只读 ⇒ 不弹窗 ✗（tag/untag 过闸 ✓）
	'memory_facet',
	// 批 2c：四个多 action —— 具体某次是否真写**全部**由 `isWriteIntent` 判 ✓，其中三处是**参数敏感**的：
	//   · `memory_governance` 的 `audit` ✓ 与 `bulk_delete` 的 **dry-run**（缺省 true ＝ 只出计划 ✓）⇒ 不弹窗 ✗
	//   · `memory_team` 的 `query` ✓ / `memory_mesh` 的 `list` ✓ / `memory_sentinel` 的 `list` ✓ ⇒ 不弹窗 ✗
	//   · ⚠ `memory_sentinel` 的 `check` **算写**（会就地评估并可能**触发** ✓）—— 别按"看着像只读"放行 ✗
	'memory_governance', 'memory_team', 'memory_mesh', 'memory_sentinel',
	// 2026-10-13：槽位 —— 8 个 action 里 `list` / `get` 只读 ⇒ 具体某次是否真写由 `isWriteIntent` 判 ✓
	//（与 `memory_facet` / `memory_routine` 同一形态 ✓）。
	'memory_slot',
	// 2026-10-13：课程 —— `list` / `recall` 只读 ⇒ 同上 ✓（`recall` 会读索引但**不改**用户数据 ✓）。
	'memory_lesson',
	// 2026-10-13：行动链 / 草图 / 信号 —— 只读面是 `list` / `get` / `threads` ⇒ 其余过闸 ✓。
	'memory_work',
	// 2026-10-13：导入 —— **两个 action 都是写**（`import` / `replay`）⇒ 无条件过闸，
	// 因此 `isWriteIntent` **不需要**为它加分支（名单里的默认 `return true` 已经覆盖 ✓）。
	'memory_import',
	// 2026-10-13：技能落盘 —— 三个 action（`write` / `delete_file` / `extract`）**都是写**
	//（`write` 会**建/覆盖** SKILL.md ✓、`delete_file` 会**删目录** ✓）⇒ 同上，无条件过闸 ✓。
	'memory_skill',
];

export function apply(ctx, rawConfig = {}) {
	// ★ preset plane 半边判定（理由见下方 `toolsOnly` 的注释）必须在建 `config` 之前 —— 半边副本的 config 要叠部署兜底
	const toolsOnly = rawConfig?.toolsOnly === true;
	const config = toolsOnly ? withDeploymentFallback(rawConfig) : (rawConfig ?? {});
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
	/**
	 * ★ R13 preset plane 的**半边**（2026-10-20）：本包被 **host plane**（`cordis.patch.yml`）
	 * 与 **preset plane**（`vssaros-agents/preset-vssaros.rows.yml`）**双挂载**，而 `apply` 会跑两次。
	 *
	 * 现场证据（`~/.vssaros-dev/memory-audit/audit.jsonl`）：`agent/turn-stopping` 被注册了两个监听
	 * ⇒ **每回合 distill 跑两遍**，审计成对出现：
	 *   `agentId=ws-<workspaceId>`（preset plane 那侧的上下文）与 `agentId=default`（host plane）。
	 * 同理 `systemPrompt.section` 也注册两次（同样内容进两段，白占 token）。
	 *
	 * 修法口径与 `vssaros-agents` 的 `toolsOnly: true` **完全一致**：preset 那行只负责"工具对会话可见"
	 * （R13 的设计就是把给模型用的能力放进 preset）⇒ 这一次**只注册工具**，section / 钩子一概不碰。
	 * host plane 那行不传该键 ⇒ 仍是完整挂载（页面 + section + 钩子 + 工具）✓。
	 *
	 * ⚠ 这不是"把 host 行 disabled"那种 plane 迁移收尾（那条要产品决策：无 preset 的会话还留不留能力），
	 *   只是把**重复副作用**消掉 ⇒ 对 headless / 无 preset 会话零影响 ✓。
	 * ⚠ 审批钩子（`tools/pre-execute`）**不设**这道半边：waterfall 里先返回者终止，重复注册不会弹两次窗。
	 *
	 * ★★ 2026-10-20 真机订正（`dsh --profile vssaros --patch <壳的 memory 覆盖层> --dump-config`）：
	 *   壳的覆盖层**只打到 host plane 那一行**（`gatewayUrl` / `dataRoot` / `workspaceId`）；preset 两行
	 *   （`preset-vssaros-standard` / `preset-vssaros-ptc`）**只有 `toolsOnly: true`**。而 dsh 的工具解析是
	 *   「Scoped tools shadow globals」（`@deepseek-ai/dsh-tools` 类型注释）⇒ 默认 preset 的会话里，模型调用的是
	 *   **preset 这份**：网关未配置、分区回落 `default`、数据根回落 `~/.vssaros`（**安装版**的目录 ✗）。
	 *   ⇒ 半边副本经 `withDeploymentFallback` 在**调用时**借 host plane 那次的部署配置（与 YAML 写在哪一行无关）。
	 *   上面那句"ws- 是 preset 那侧"是旧推测，现场是反的：preset 那侧原本什么都没有。
	 */
	// 非半边、且带部署配置的那次挂载 ⇒ 登记为本进程的部署配置（半边副本兜底用）；卸载时撤销
	if (!toolsOnly) {
		ctx.effect(() => {
			const registered = registerDeploymentConfig(rawConfig);
			return () => { if (registered) { unregisterDeploymentConfig(registered); } };
		});
	}

	const state = createState();

	// ★ 写策略（移植 `dsh-memento` 的 `lib/gate.mjs`）—— 在**挂载期**校验并**响亮失败** ✗：
	//   错配置要在装配时第一个说话，而不是等到某次写被静默放行/拦截 ✓
	//   （缺省 `writePolicy='ask'` + 空表 ⇒ 与从前**逐字一样**：所有写都弹窗 ✓）。
	const writePolicy = validateWritePolicy(typeof config.writePolicy === 'string' ? config.writePolicy : 'ask');
	const writePolicies = validateWritePolicies(config.writePolicies);

	// ★ 审计账本（P2，用户 2026-10-12 拍板"插件侧 JSONL"）：**跨会话可查**的那一份。
	//   落点 `<数据根>/memory-audit/audit.jsonl`（为什么不放网关的 `.agentmemory/`，见 lib/audit.js 文件头）。
	//   这里只**建写入器**（零 I/O —— 目录到首次 append 才 mkdir ✓）；写失败由写入器自己吞掉并
	//   只喊一次 warn ⇒ **审计绝不影响记忆写入** ✓（core/audit.js 文件头的纪律 ②）。
	// ⚠ 读 `ctx.logger` 必须**防御性**：cordis 的 ctx 是 **Proxy**，"读未声明/未 provide 的名字会抛"
	// （本仓既有先例；`p3-07` 的假 ctx 就是照这条写的）⇒ 直接 `ctx.logger` 在真 Host 下会让
	// **整个 `apply` 在开头抛出** ⇒ 工具、页面路由、提示词 section **全部不注册** ✗✗
	// 实测症状：进程内断言全绿（fake ctx 有 logger）、真 Host 上 `/x/memory/section` 404 且工具不可见 ✓。
	const auditLogger = (() => {
		try { return ctx.logger; } catch { return undefined; }
	})();
	const audit = createAuditWriter(config, { logger: auditLogger });
	/** 是否在账本里落**全文**（默认否：只落 digest + 前 80 字，见 core/audit.js 的隐私说明）。 */
	const auditFull = config.auditFullContent === true;
	/**
	 * 记一笔审计：把 **writer + 全文开关 + 分区 agentId** 收在一处 ✓
	 *
	 * 为什么需要它、而不是各处直接 `audit.append(buildAuditRow(...))`：`toolDefinitions` 是**模块级
	 * 函数**（不在 `apply` 的闭包里）⇒ 那两个值必须**显式传进去**。收成一个函数比传两个值更难写错 ✓
	 * —— 第一版正是漏了这条：`memory_remember` 的 `execute` 里直接引用了 `auditFull`，
	 * 探针一跑就报 `auditFull is not defined` ✓（**源码级看完全正常**，只有真跑才现形）。
	 */
	const auditAppend = input => audit.append(buildAuditRow({ ...input, agentId: input.agentId ?? agentIdOf(config), full: auditFull }));

	// 启动即拉一次；之后靠 TTL / 工具 / 页面请求保鲜
	void refresh(state, config);

	// ① 注入：section 的 text 提供者同步返回快照（零 I/O），刷新永远发生在 assembly 之外。
	//    可选注入：组合里没有 systemPrompt 时不激活这一块，其余功能照常（页面会显示"未注册"）。
	// ⚠ `toolsOnly`（preset plane 那一次）不注册 section —— 否则每轮系统提示里会多出**同一段**记忆。
	if (!toolsOnly) ctx.inject(['systemPrompt'], child => child.effect(() => {
		let order = SECTION_ORDER_FALLBACK;
		try {
			const persona = child.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX');
			if (Number.isFinite(persona)) {
				order = persona + 100; // 紧随部署级人设之后
			}
		} catch {
			/* 中央表不可用就用兜底值 */
		}
		state.promptSection = order;
		// 注册返回的就是 Cordis effect disposer，撤销时要调用**它**（不是再调一次 section()）
		// ⚠ `text` 是**每次 assembly 都被调用**的 provider（`PromptSection.text: string | (context) => string`）
		// ⇒ 这里必须走 `snapshotFor`（**冻结**、按装配主体归属），绝不能直读"最新的那一份" ✗ ——
		// 直读＝每轮都可能变＝把最前面那条前缀的 KV cache 反复打掉（详见 `snapshotFor` 的注释）。
		const dispose = child.systemPrompt.section({
			name: SECTION_NAME,
			order,
			text: context => snapshotFor(state, config, context),
		});
		return () => {
			state.promptSection = undefined;
			dispose();
		};
	}));

	// ★ 写入类工具的**审批闸**（报告 §7.2 R1 / README 5.104）—— 与 kanban / workflow / kb **同一把** ✓：
	// 官方派发前决策钩子 `tools/pre-execute`（waterfall ✓），返回 `{ kind: 'ask' }` ＝ "先问用户" ✓；
	// 契约：只有审批服务回 `allowed-once` 才执行 ✓、**没有审批支持的部署 degrade to deny** ✓。
	// 为什么 memory 必须有这道闸：`memory_remember` 写的是**跨会话的长期记忆** —— 模型可以不经确认把
	// 内容固化进用户的记忆库，之后每轮都会被检索到 ✗（这类"越写越多、越检索越相信自己"的污染比一次
	// 文件写入更难挽回 ✓）。参数无关：只要调用就是写 ⇒ 不像 kb 那样带条件 ✓。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		if (!exec || !WRITE_TOOLS.includes(exec.name)) {
			return next(); // 只读工具（list / search / stats / recall / obsidian_export）与"只刷快照不改数据"的 memory_refresh ⇒ 默认 allow ✓
		}
		// ⚠ 参数在 **`exec.arguments`**，不是 `args` —— 官方真源 `ToolExecutionInput.arguments`
		//    （`@deepseek-ai/dsh-tools/lib/types/index.d.ts:226-227`："Losslessly JSON-serializable
		//    parsed arguments"），且 `tools/pre-execute` 在 **materialize 之后**执行
		//    （同文件 `:359`："Materialize input, run the ordered pre-execute/guard gate"）。
		//    p3-26 用真事件钉住这个字段名（写错 ⇒ 取不到参数 ⇒ 探针红 ✓）。
		const args = /** @type {{content?: unknown, memory_type?: unknown, importance?: unknown, tags?: unknown, memory_id?: unknown, reason?: unknown, action?: unknown, action_id?: unknown, new_content?: unknown, routine_id?: unknown, name?: unknown}} */ (exec.arguments ?? {});
		// ★ 参数敏感（2026-10-13 批 2a）：写名单里的工具也可能有**只读形态** ✗ —— `memory_routine` 的
		//   `list`/`get`/`status` 不写盘 ⇒ **不该弹窗** ✓（同 kb 那条"dry-run 只出计划 ⇒ 不该问"的判据 ✓）；
		//   判据收在纯函数 `isWriteIntent` 里 ✓（放在这儿会变成一长串 `&&/||`，接下一个工具时最容易漏 ✓）。
		if (!isWriteIntent(exec.name, args)) {
			return next();
		}
		const content = typeof args.content === 'string' ? args.content : '';
		// ★ 2026-10-13 批 1：写工具**不止 remember** 了 ⇒ 审批文案必须**说真话** ✗：
		//   拿 remember 的模板去描述一次"软删除"，等于"批准的不是它做的" ✗。动词 + 人话载荷都按工具取 ✓。
		//   （动词表收进 core/memory.js 的 `WRITE_VERBS`，2026-10-20 补齐后加的 5 个工具。）
		const verb = WRITE_VERBS[exec.name] ?? 'remember';
		// ★ 2026-10-20：策略的 type 维**不再**直接读 `args.memory_type`（只有 remember 声明了它；
		//   删改类工具多塞一个 `memory_type:'working'` 就能借到 core 档的宽松策略 ✗）—— 见 `policyMemoryTypeOf`。
		//   reason 里写的就是这个值 ⇒ 下游 answerer 解析出来的也是它（模型改不到 reason）。
		const policyType = policyMemoryTypeOf(exec.name, args);
		const payloadText = content || describeWritePayload(exec.name, args);
		// 载荷「批准即所见」（移植 dsh-memento 的 lib/gate.mjs）：reason 里带**完整内容** ⇒
		// 人批准的是具体变更，而不是"某个工具想写点什么"；且 `PreToolDecision.ask.reason` 按官方
		// 契约就是"被审计的审批理由"（types/index.d.ts:437-442），随 `approval/asked` 进会话日志
		// ⇒ 这一步顺带拿到审计，不必自建账本 ✓。
		// 取不到 content 时**说出来**，绝不产出一条"看起来正常、其实是空载荷"的审批 ✗
		//（那句必然 parseWriteReason ⇒ null，探针据此变红 ✓）。
		const reason = payloadText
			? buildWriteReason({ content: payloadText, memoryType: policyType, importance: args.importance, tags: args.tags, verb })
			: `${REQUEST_MARKER} ${verb} (未从 exec.arguments 取到载荷 —— 工具参数形状可能已变)`;
		// 审计「请求」这一格：**不 await** —— 闸的职责是"要不要弹窗"，不该被账本 I/O 拖慢 ✓。
		// 策略与裁决结果记在下一格 `decision`（此刻尚未裁决，policy 留空 ✓）。
		void auditAppend({
			action: 'request', tool: exec.name,
			target: targetKeyOf(policyType),
			memoryType: policyType,
			content,
		});
		return {
			kind: 'ask',
			reason,
			displayReason: { en: `Allow ${exec.name} to write into this agent's long-term memory?`, zh: `允许 ${exec.name} 写入本 Agent 的长期记忆？` },
		};
	}));

	// ★ 粒度写策略的**裁决点**（移植 `dsh-memento` 的 `index.mjs:1143-1156` 的 answerer 手法）。
	//
	// 为什么不把裁决写在闸里直接放行 ✗：`tools/pre-execute` 里 `return next()`（＝不弹窗）会让这次
	// 写入**在会话日志里零痕迹** ✗ —— 而 `approval/asked` + `approval/decided` 正是"这次写发生过、
	// 由谁放行"的唯一证据链（`dsh-user-approval/lib/types/types.d.ts:37-51`；注意 `displayReason`
	// 明确**不进**审计事件，只有 `reason` 进 ⇒ 载荷必须放 reason ✓）。
	// 让 `auto` 也走一遍审批服务、由本插件 answerer 直接回 `allowed-once`，审计对**照样落盘** ✓✓
	//（memento 原话："auto：本插件 answerer 直接放行（allowed-once）；审批来源仍随 approval/asked +
	// approval/decided 审计对记录"）。
	// `prepend: true`：`auto`/`off` 必须先于 UI answerer 生效（否则 auto 照样弹窗 ✗）；`ask` 走 next() 交 UI ✓。
	//
	// 不认领的请求**一律 next()**（绝不吞别人的审批 ✗）；认领了却解析不了载荷 ⇒ **退回 ask（最严）**
	// 并留一行 warn —— 形状漂移时宁可多问一次，也不能少问 ✓。
	ctx.effect(() => ctx.on('approval/request', async (req, next) => {
		if (!isMemoryWriteRequest(req, WRITE_TOOLS)) { return next(); }
		const parsed = parseWriteReason(req.reason);
		if (parsed === null) {
			auditLogger?.warn?.('[vssaros-memory] 认领到审批请求但载荷解析失败 ⇒ 退回 ask');
			// 认领了却解析不了 ⇒ 也记一笔：**异常路径必须可见**（它意味着 reason 的形状已经漂移 ✓）
			await auditAppend({
				action: 'decision', tool: req.toolName,
				policy: writePolicy, policyKey: '(unparsable)', outcome: 'degraded-to-ask', error: '载荷解析失败',
			});
			return next();
		}
		const { policy, key } = resolveWritePolicy(writePolicies, writePolicy, targetKeyOf(parsed.memoryType), parsed.memoryType);
		// 审计「裁决」这一格：**await** —— answerer 本身就是异步的，且这一笔是"谁放行的"核心证据 ✓。
		// `ask` 也记（outcome=delegated-to-ui）：它说明"本插件的策略没拦、交给了人类 UI" ✓。
		// 用户最终批没批由审批服务的会话日志（`approval/asked`+`decided`）记录，本账本**不假装知道** ✗。
		await auditAppend({
			action: 'decision', tool: req.toolName,
			target: targetKeyOf(parsed.memoryType), memoryType: parsed.memoryType,
			policy, policyKey: key,
			outcome: policy === 'ask' ? 'delegated-to-ui' : (policy === 'auto' ? 'allowed-once' : 'rejected'),
			content: parsed.content,
		});
		if (policy === 'ask') { return next(); }
		auditLogger?.info?.(`[vssaros-memory] writePolicy=${policy}（命中键 ${key}）⇒ ${policy === 'auto' ? 'allowed-once' : 'rejected'}：${req.toolName}`);
		return policy === 'auto' ? 'allowed-once' : 'rejected';
	}, { prepend: true }));

	// ★ 自动沉淀（2026-10-13）：挂 `agent/turn-stopping` ⇒ **fire-and-forget**。
	//
	// 为什么要有它：社区 12 款记忆插件里 **10 款**都有自动沉淀，而我们的写入此前只有
	// "模型显式调 `memory_remember`" 一条路 ⇒ 会话里说过的约定/偏好，模型不主动写就永久丢了 ✗
	//（这是历轮评估里排第一的能力缺口）。
	//
	// ⚠⚠ 处理函数里**绝不能 await 任何 I/O**：官方对该钩子的说明是
	// "The turn is about to close… **Awaited before the boundary commits**" + `@mode serial`
	//（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:370-391`）⇒ 在它里面做一次网关往返／
	// 一次 LLM 调用 ＝"**每个回合都多等那么久**"✗✗ —— 社区那句"永不阻塞回合"不是风格偏好，
	// 是这条契约的**硬要求** ✓。所以流程是：同步取事件（`snapshotEvents` 同步 ✓）→ 同步提取候选
	//（纯函数 ✓）→ `void` 排后台写盘 ✓。
	//
	// 产出是**草稿**（不是长期记忆）：自动提取必然有误（玩笑、否定句「以后不要 X」、转述的约定），
	// 直写＝把错误喂给之后每一轮 ✗ —— 见 `core/distill.js` 的约束 ② 与社区的自陈教训 ✓。
	const draftStore = createDraftStore(config, { logger: auditLogger });
	// 快照的"待审草稿"计数要读它（`pendingDraftsOf`）；启动预热那次刷新早于这里 ⇒ 那一次计 0，会话首装时才有值
	state.draftStore = draftStore;

	// ★ 后台队列（2026-10-13）：钩子必须 fire-and-forget（官方会 await 它 ✓），但**裸的 `void async`**
	// 没有并发上限、没有超时、不可观测 ⇒ 连续回合会同时打出多份请求，而一个挂住的请求会永久占住槽位 ✗。
	// 队列补这三样（见 `lib/queue.js` 文件头 ✓）。**并发 1**：这是本地网关 + 单机场景，串行已经够快，
	// 而且串行让"失败原因"更容易归因 ✓。`distillTimeoutMs` 可配（探针把它压到 1ms 来断言超时路径 ✓）。
	const distillQueue = createTaskQueue({
		concurrency: 1,
		timeoutMs: Number(config.distillTimeoutMs) > 0 ? Number(config.distillTimeoutMs) : 30_000,
		maxPending: 8,
		logger: auditLogger,
	});

	// ★ LLM 判定（2026-10-13）：**默认关** + **可选注入** `llm`。
	//
	// 两条纪律都是刻意的：
	//   · **默认关**：开启它意味着"每个回合都可能多一次模型调用"⇒ 成本与隐私面都由用户显式同意 ✓
	//     （本插件的隐私默认值一贯保守 ✓）；
	//   · **可选注入**：`llm` **不写进静态 `inject`** —— 那会让缺该服务的组合（headless / 精简 profile）
	//     **永久 pending**、连工具一起失效 ✗（本仓为 `systemPrompt` 已经踩过这一次，注释就在文件头 ✓）。
	//     服务不在 ⇒ `llmRuntime` 保持 null ⇒ 判定被跳过并计入 `judgeSkipped`（**可见**，不静默 ✓）。
	let llmRuntime = null;
	// ⚠ **开关只在这一处判断**，注入与钩子共用它 —— 两处各写一遍时，只改一处的行为**不会**被探针
	// 抓住（反向突变 M-L 实测：把注入这处改成"默认开"、钩子那处仍把关 ⇒ 行为不变、67/67 全绿 ✗✓）。
	// 抽出单一来源之后，任何一处改动都会体现在行为上 ✓。
	const judgeEnabled = config.distillJudge === true;
	if (judgeEnabled) {
		ctx.inject(['llm'], child => child.effect(() => {
			llmRuntime = child.llm;
			return () => { llmRuntime = null; };
		}));
	}
	// ★ 2026-10-20：会话投影服务（**可选**）—— 读"会话中途切换过的人格"，决定读哪个人设分区。
	//   缺席（老 Host / 组合里没挂）⇒ 只按会话 preset 认人设，功能不丢 ✓（`personaIdOf` 的注释）。
	//   ⚠ 只**读**它的状态，不 register 投影（`vssaros-persona` 由 `vssaros-agents` 注册 —— 重复注册以先注册者为准，
	//   这里注册反而可能让定义版本分叉 ✗）。
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		// 与 `vssarosFoundation` 那条同一写法：读服务包一层 try（探针的严格假 ctx 对未知属性抛错 ⇒ 当不存在；
		// 真 Cordis 下服务不在时根本不会进到这里）✓
		let svc;
		try { svc = child.sessionProjections; } catch { svc = undefined; }
		state.projections = svc && typeof svc.stateOf === 'function' ? svc : undefined;
		return () => { state.projections = undefined; };
	}));
	// ★ 2026-10-20：官方会话检索服务（**可选**）—— `memory_recall` 的"历史会话"那一段（见 lib/history.js）。
	//   缺席 ⇒ 那一段如实显示"未检索：服务不可用"，记忆那一段照常。
	ctx.inject(['sessionQuery'], child => child.effect(() => {
		let svc;
		try { svc = child.sessionQuery; } catch { svc = undefined; }
		state.sessionQuery = svc ?? undefined;
		return () => { state.sessionQuery = undefined; };
	}));
	// ⚠ 传 **getter** 而不是实例：`llmRuntime` 是可选注入、在装配后才可能被赋值 ✓（理由见 `lib/judge.js`）
	const judge = createJudge({ llm: () => llmRuntime, timeoutMs: Number(config.distillJudgeTimeoutMs), logger: auditLogger });

	// ★ 草稿提升（**人在页面上**触发）—— ⚠ 它**刻意不过审批闸**，推理见 `lib/promote.js` 文件头：
	// 闸的理由是"**模型**可能不经确认就写记忆"，而人按下按钮本身就是那次确认 ⇒ 再弹一次是把确认链
	// 叠两层 ✗（且走 `approval/request` 技术上也不通：审批服务要求在 open turn 内，页面请求没有 turn）。
	const promoter = createPromoter({
		draftStore,
		remember,
		// ★ getter（2026-10-20）：调用时现取 —— 切换工作区后提升写进**当前**分区（见 `promote.js` 的注释）
		gatewayBase: () => gatewayUrlOf(config),
		agentId: () => agentIdOf(config),
		auditAppend,
	});
	// ⚠ `toolsOnly`（preset plane 那一次）不注册本钩子 —— 否则**每回合 distill 跑两遍**
	//   （实测症状见 `apply` 开头 `toolsOnly` 的注释：审计成对出现 ws-… / default）。
	if (!toolsOnly) ctx.effect(() => ctx.on('agent/turn-stopping', payload => {
		state.distill.turns++;
		const session = payload?.agent?.session;
		if (!session || typeof session.snapshotEvents !== 'function') { state.distill.skipped++; return; }
		let events = [];
		try {
			const from = state.distillSeqs.get(session.id) ?? 0;
			const to = typeof session.seq === 'number' ? session.seq : 0;
			events = to > from ? Array.from(session.snapshotEvents(from, to)) : [];
			state.distillSeqs.set(session.id, to);
		} catch (error) {
			state.distill.failed++;
			try { auditLogger?.warn?.(`[vssaros-memory] 自动沉淀读会话事件失败：${error?.message ?? error}`); } catch { /* 记录失败本身绝不再抛 ✓ */ }
			return;
		}
		const texts = userTextsOf(events);
		// ★ 2026-10-20：同一段事件里若发生过**压缩**，`compaction/summary` 带着模型写好的会话摘要 ⇒
		//   作为「会话摘要」草稿（dsh 侧补上 IDE 时代"压缩即写长期记忆"那一跳；仍是草稿、人工提升 ✓）。
		//   事件游标与约定提取**共用**（上面已推进）⇒ 同一次压缩只会被看到一次。
		const hasSummary = events.some(event => event?.type === 'compaction/summary');
		if (texts.length === 0 && !hasSummary) { state.distill.skipped++; return; }
		// ★ LLM 判定的前置**同步取好**（路由）：后台块里不许再碰 `payload`/`agent` ✗ ——
		// 那些是回合期对象，回合结束后它们的状态未必还能读 ✓（路由也是"那一刻"的事实 ✓）。
		// ⚠ `judgeEnabled` 来自**外层**（与"要不要注入 `llm`"是同一个常量 ✓），不在这里重算 ——
		// 两处判断可能漂移，而漂移出的那一种组合**不会**被探针抓住 ✗。
		const judgeTarget = judgeEnabled ? modelTargetOf(payload?.agent) : null;
		// ⚠ 从这里起**全是后台**（`void` + 队列）：钩子已经返回，回合不会被这一跳拖住 ✓
		// 用队列而不是裸 `void async`：并发上限 + 超时 + 可观测（`state.distill` 里的计数即来自它的结果 ✓）。
		void distillQueue.push(async () => {
			try {
				const seenDigests = await draftStore.seen();
				const raw = extractCandidates(texts, {
					sessionId: String(session.id ?? ''),
					turn: payload?.turn,
					seenDigests,
					now: Date.now(),
				});
				// 摘要草稿**不过** LLM 判定：判定器的提示词是为"短约定"设计的（只能减少候选），
				// 对一整段摘要没有可用的判据 —— 摘要的把关就是人工「提升」✓。
				const summaries = hasSummary
					? summaryCandidatesOf(events, { sessionId: String(session.id ?? ''), turn: payload?.turn, seenDigests, now: Date.now() })
					: [];
				state.distill.candidates += raw.length;
				state.distill.summaries = (state.distill.summaries ?? 0) + summaries.length;
				// ★ LLM 判定（**默认关** ✓）：正则粗筛的噪音交给模型滤一遍 —— 它**只能减少**候选。
				// ⚠ 失败一律 **fail-open**（保留全部 ✓）：`judge.judge` 的四种失败（超时/抛错/形状不认识/
				//   回答解析不了）都收敛成"全保留" ⇒ 这里**不需要**再判一次错 ✓（判据：噪音可接受、漏掉不可接受 ✓）。
				let candidates = raw;
				if (raw.length > 0 && judgeEnabled) {
					if (judgeTarget === null) {
						state.distill.judgeSkipped++; // 路由取不到 ⇒ 可见地跳过（不静默、也不瞎猜 ✗）
					} else {
						const verdict = await judge.judge(raw, judgeTarget);
						state.distill.judged++;
						if (verdict.dropped.length > 0) {
							const drop = new Set(verdict.dropped);
							candidates = raw.filter(candidate => !drop.has(candidate.digest));
							state.distill.judgeDropped += verdict.dropped.length;
						}
					}
				}
				const written = await draftStore.append(draftRowsOf([...candidates, ...summaries]));
				state.distill.written += written;
				// ⚠ 写盘之后**必须**让 `state.drafts` 跟上（2026-10-13 修）：页面渲染读的是它 ✗ ——
				// 不更新的话，刚沉淀出来的草稿在页面上看不见（要等下一次页面请求才读盘 ✓）。
				// 走"**从盘重读**"而不是拿 `written` 去拼：这样页面上看到的永远等于文件里的真内容 ✓
				// （也顺带覆盖"别处改了草稿文件"的情形 ✓）。读失败不影响沉淀本身 ✓。
				void draftStore.read()
					.then(rows => { state.drafts = { rows, readAt: Date.now(), error: '' }; })
					.catch(error => { state.drafts = { rows: state.drafts.rows, readAt: Date.now(), error: String(error?.message ?? error) }; });
				await auditAppend({
					action: 'distill',
					agentId: agentIdOf(config),
					sessionId: String(session.id ?? ''),
					outcome: candidates.length === 0 && summaries.length === 0
						? 'no-candidate'
						: `drafted:${written}${summaries.length ? `(summary:${summaries.length})` : ''}`,
					content: [...candidates, ...summaries].map(candidate => candidate.text.slice(0, 200)).join(' | '),
				});
			} catch (error) {
				state.distill.failed++;
				try { auditLogger?.warn?.(`[vssaros-memory] 自动沉淀失败（不影响回合）：${error?.message ?? error}`); } catch { /* 绝不再抛 ✓ */ }
			}
		}).then(result => {
			// ⚠ 队列的结果也要**计入可见计数**：超时是 `Promise.race` 在**外层**判的 ⇒ 上面的 catch
			// 根本不会执行 ⇒ 不接这一下就会出现"任务失败了、但页面显示什么都没发生" ✗（观测出现洞 ✓）。
			if (!result.ok) {
				state.distill.failed++;
				try { auditLogger?.warn?.(`[vssaros-memory] 自动沉淀后台任务未完成：${result.error ?? result.skipped}`); } catch { /* 绝不再抛 ✓ */ }
			}
		});
	}));

	// ② 工具
	ctx.effect(() => {
		// ── R13（preset plane）：同一个包会被挂**两次**（host plane + 我们的 preset ✓）──
		// `hostHalf: true` ⇒ 这次只注册页面/片段，**不注册工具**（工具交给 preset 里那次 ✓）；
		// 缺省 ⇒ **与从前完全一样** ✓（零行为改变）。可选的 `systemPrompt` 注入**不受影响** ✓：
		// 那是"记忆区块"的可见性，属于 host 侧语义，两次挂载都该有（幂等注册 ✓）。
		if (config.hostHalf === true) { return undefined; }
		const disposers = toolDefinitions(ctx, state, config, auditAppend).map(definition => ctx.tools.register(definition));
		return () => {
			for (const dispose of disposers) {
				dispose();
			}
		};
	});

	// ③ 页面（清单 view.kind=page；2026-10-12「资料库」拆分后从"寄居片段"升为**独立整页**）。
	// 路由仍是**可选**依赖：`webServer` / `connection` 只在 web 模板里存在（见文件头的注释）。
	// 不在 web 模板 ⇒ 只是**没有页面** ✓，工具照常可用 ✓。
	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		// ⚠ 必须 async：下面渲染前要 `await draftStore.read()`（草稿区的内容是渲染依赖 ✓，
		// 而写出草稿是**别的路径**做的 —— 自动沉淀 / 提升丢弃 ✓）⇒ 见那段注释。
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			try {
				const url = new URL(req.url ?? '/', 'http://127.0.0.1');
				const pathname = url.pathname;
				// ★ 2026-10-22（工作台重构 §5 步骤 2）：**页面数据的 JSON 接口**（React 工作台用）。
				//   与 SSR 页**同一份 state**（`state.snapshot` / `state.drafts` / `state.distill` / `state.lastAction`）
				//   ⇒ 两个界面的数字与文案口径一致 ✓（各算一遍迟早分叉 ✗）。
				//   ⚠ 不在这里 `void refresh(...)`：那是**渲染**的副作用（页面每次打开刷一次）⇒
				//     放进 GET 接口会让轮询/重取把网关打爆 ✗。要新鲜数据由页面上的「刷新」显式触发 ✓。
				if (pathname === `${PAGE_ROUTE}api/page` || pathname === `${PAGE_ROUTE}api/page/`) {
					// 草稿是**渲染依赖** ⇒ 读一次（只读本地 jsonl，代价可忽略 ✓，与 SSR 页同口径）
					await draftStore.read()
						.then(rows => { state.drafts = { rows, readAt: Date.now(), error: '' }; })
						.catch(error => { state.drafts = { rows: state.drafts?.rows ?? [], readAt: Date.now(), error: String(error?.message ?? error) }; });
					const snapshot = state.snapshot;
					const base = gatewayUrlOf(config);
					const agentId = agentIdOf(config);
					const toolsRegistered = TOOL_NAMES.filter(tool => !!ctx.tools.get(tool)).join(',') || '(未注册)';
					const lastAction = state.lastAction;
					const fresh = lastAction && Number.isFinite(lastAction.at) && Date.now() - lastAction.at < 30_000;
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({
						ok: true,
						version: PKG_VERSION,
						state: {
							name: !base ? 'unconfigured' : (snapshot.ok ? 'ok' : 'error'),
							agent: agentId,
							gateway: base ?? '',
							bytes: Buffer.byteLength(snapshot.text, 'utf8'),
							chars: snapshot.text.length,
							refreshes: state.refreshes,
							writes: state.writes.get(agentId) ?? 0,
							tools: toolsRegistered,
							promptSection: state.promptSection === undefined ? null : state.promptSection,
							snapshots: state.snapshots.size,
							sectionName: SECTION_NAME,
							tokenBudget: tokenBudgetOf(config),
							charCap: MAX_INJECT_CHARS,
						},
						working: {
							ok: snapshot.ok === true,
							text: snapshot.text ?? '',
							error: snapshot.error ? String(snapshot.error) : '',
							source: snapshot.source ? String(snapshot.source) : '',
							fetchedAt: snapshot.fetchedAt ?? 0,
							truncated: snapshot.truncatedByChars === true,
							rawChars: snapshot.rawChars ?? null,
						},
						distill: state.distill ?? {},
						drafts: {
							rows: (state.drafts?.rows ?? []).map(row => ({
								id: String(row.id ?? ''), text: String(row.text ?? '').slice(0, 90),
								matched: String(row.matched ?? ''), turn: Number.isFinite(row.turn) ? row.turn : null,
								status: String(row.status ?? ''),
							})),
							readAt: state.drafts?.readAt ?? 0,
							error: state.drafts?.error ? String(state.drafts.error) : '',
						},
						lastAction: fresh ? { action: String(lastAction.action ?? ''), ok: lastAction.ok === true, text: String(lastAction.text ?? '').slice(0, 60), error: lastAction.error ? String(lastAction.error) : '' } : null,
						slots: SLOT_NAMES.slice(),
					}));
					return;
				}
				// ★ 提升路由（`POST /x/memory/promote`）—— 草稿区那个"无 JS"表单提交到这里 ✓
				// （为什么页面提升不过审批闸：见 `lib/promote.js` 文件头 ✓）
				if (pathname === PROMOTE_ROUTE || pathname === DISCARD_ROUTE) {
					if (req.method !== 'POST') {
						res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
						res.end('草稿操作必须用 POST（GET 会被预取/被链接抓到 ⇒ 一次点击变成两次写入 ✗）');
						return;
					}
					handleDraftAction(req, res, {
						promoter,
						logger: auditLogger,
						// 动作由**路径**决定（白名单在 `handleDraftAction` 里再校验一次 ✓）
						action: pathname === PROMOTE_ROUTE ? 'promote' : 'discard',
						state, // ⇒ 结果留给下一次渲染（见 `handleDraftAction` 的注释 ✓）
					});
					return;
				}
				// ★ 2026-10-14：**记忆详情页** `/x/memory/detail` ✓。
				// ⚠ 为什么做成**子路由**而不是新整页：整页要同步改三处（`dshModuleContainers.ts` 的
				//   `DSH_MODULE_PAGES` / 插件清单的 `vssaros.view` / `vssaros-dashboard` 的 catalog ✓），
				//   而子路由**零改动** ✓；且它本来就是"记忆库"的下钻页，不该在活动栏另占一格 ✗。
				if (pathname === DETAIL_ROUTE) {
					const params = url.searchParams;
					const tool = params.get('tool') ?? '';
					if (tool === 'export-json' || tool === 'export-md' || tool === 'export-skills') {
						await handleDetailExport(res, { config, tool });
						return;
					}
					const model = await loadDetailModel({ config, params, state });
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
					res.end(renderDetailShell(model));
					return;
				}
				// 只剩一条页面路由：**整页** `/x/memory/`（独立工作台）。旧的片段路由 `/x/memory/section`
				// 已于 2026-10-12 随「知识库页不再内嵌记忆分区」一起删除（不再有调用方）。
				if (pathname !== PAGE_ROUTE) {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(`不是本插件的页面路由：${pathname}`);
					return;
				}
				// ★★ 2026-10-15（用户两轮口径合并后的最终形态）：
				//   **侧栏**（宿主带 `?surface=sideview`）⇒ **摘要版**（置顶主入口 + 三张卡 + 最近几条 ✓）；
				//   **编辑区**（`?surface=editor`）⇒ **记忆详情**（复刻 IDE 的 `MemoryDetailEditorPane` ✓）——
				//     ⚠ 用户实测口径：编辑区显示详情"正常"✓，显示完整版"不正确"✗（第一版把完整版搬进去被否 ✓）；
				//   无参数（纯浏览器 / 详情页「← 记忆库」回链）⇒ **完整版**（草稿区 · 固定槽位 · 诊断 · 工作记忆正文 ✓
				//     —— 那些区块仍可达：详情页右上角「← 记忆库」就在同一个窗格里切过去 ✓）。
				//   ⚠ 两个表面**同一个路由**（`/x/memory/`）⇒ 判据只能是 `surface`（宿主注入的 ✓，页面自己不猜 ✗）。
				//   ⚠ 摘要版要数字 ⇒ 取数有**预算**（`summaryForRender` ✓）：等不到就用上次结果渲染并如实标注，
				//     不把侧栏空着等网关（网关忙时实测会答满 5s 超时 ✗）。
				if (url.searchParams.get('surface') === 'editor') {
					const model = await loadDetailModel({ config, params: url.searchParams, state });
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
					res.end(renderDetailShell(model));
					return;
				}
				if (url.searchParams.get('surface') === 'sideview') {
					// 工作记忆那份仍照完整版的节奏：**用当前快照渲染 + 后台刷新** ✓（它有冻结语义，不该在这里等 ✗）
					void refresh(state, config);
					const summary = await summaryForRender(state, config);
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
					res.end(renderSideviewPage({ summary, state, config }));
					return;
				}
				// 打开/刷新页面时顺手刷新**默认槽位**（不 await 刷新结果，只用当前快照渲染；下一次请求就是新数据）✓。
				// 为什么不顺手刷**各会话的冻结槽位** ✗：页面是**诊断面**（要看最新），而会话槽位是**冻结面**
				// （要前缀稳定）—— 两者诉求相反，页面刷会话槽位就等于把"每 60 秒打掉一次缓存"搬回来 ✓。
				void refresh(state, config);
				// ⚠⚠ 草稿这份**必须 await**（2026-10-13 修）：`state.drafts` 是**渲染依赖** ——
				// 原来写 `void`，等于"用上一次的值渲染本次页面" ✗ ⇒ **刚被自动沉淀写进草稿区的候选，
				// 在页面上要等到再刷新一次才出现** ✗✗。实测：真跑一次 `turn-stopping` 后
				// `state.distill.written=2`、草稿文件里也有 2 行，而页面草稿区仍是 **0 条** ✗。
				// 代价可忽略（只读一个本地 jsonl）✓；而快照那边保持 `void` 是对的 —— 它是**故意**要旧值 ✓。
				await draftStore.read()
					.then(rows => { state.drafts = { rows, readAt: Date.now(), error: '' }; })
					.catch(error => { state.drafts = { rows: state.drafts.rows, readAt: Date.now(), error: String(error?.message ?? error) }; });
				const toolsRegistered = TOOL_NAMES.filter(tool => !!ctx.tools.get(tool)).join(',') || '(未注册)';
				// 一律给**整页**外壳：容器加载的就是本路由，给裸片段会让用户看到没有样式的一段内容 ✗。
				const html = renderPage({ state, config, toolsRegistered });
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
