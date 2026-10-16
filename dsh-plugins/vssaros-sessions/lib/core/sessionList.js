// @vssaros/dsh-sessions — 会话列表的**纯逻辑**（无 I/O、无 DOM、无 ctx）：缓存解析 / 分组 / 配额 / 状态归约。
//
// ── 为什么单独一个纯模块 ────────────────────────────────────────────────────
// 「哪些会话可见、折叠掉几条」是这套 UI 的**唯一判据**。写成纯函数后可以断言行为
// （不必起 Host、不必起浏览器），页面与 API 两边共用同一份。
//
// ── 与 VsSaros 侧的黄金表关系 ───────────────────────────────────────────────
// 口径**同源**：`src/vs/sessions/contrib/sessionHistory/common/sessionGrouping.ts`
//   · 每组默认 5 条**空闲**会话；每次「展开其余」+5；全部展开后给「收起」；
//   · **运行中 / 等待用户**的行始终可见且**不占**那 5 条配额；
//   · 未归属的会话落「未分组」，恒排最后；组标题三级回退（name → 路径末段 → id）。
// 两侧各自一份实现（插件是独立安装的包，profile 里没有互相解析的路径 ⇒ 不能跨包 import），
// 所以**改一侧必须同步另一侧 + 两侧各自的测试**。
//
// ── 数据来源与"未知不伪装"纪律 ──────────────────────────────────────────────
// 读 dsh 自己的会话投影缓存（见 store.js 的路径契约）。**任何字段缺席就是未知**，
// 一律保 `undefined` 交给渲染层不渲染 —— 绝不填 0 / 假字符串（沿用 dashboard 的家规）。

/** 每组默认显示的空闲会话条数。 */
export const SESSION_GROUP_IDLE_LIMIT = 5;
/** 「展开其余」每次追加的条数。 */
export const SESSION_GROUP_EXPAND_STEP = 5;
/** 「未归属任何工作区」的分组 key（`\u0000` 前缀保证与任何真实 cwd 都不可能撞）。 */
export const UNGROUPED_GROUP_KEY = '\u0000ungrouped';

/** 缓存文件的顶层版本；不认识就报错，**不猜结构**（与 dashboard 同口径）。 */
export const SUPPORTED_CACHE_VERSION = 7;

// ── 投影单元名 ──────────────────────────────────────────────────────────────
// 与 `dsh-plugins/vssaros-dashboard/lib/core/dashboard.js:35-53` 是**同一份**单元名
// （两边都从运行时 schema 逐字核对过）。本插件只读其中 7 个。
export const TITLE_KEY = 'title';
export const PRESET_KEY = 'agentPreset';
export const TURN_KEY = 'turnBoundary';
export const RETRY_KEY = 'llmRetry';
export const QUESTIONS_KEY = 'userQuestions';
export const LIST_META_KEY = 'sessionListMetadata';
/**
 * 会话内热切换的「人格」—— 由 `@vssaros/dsh-agents` 注册的投影。
 * 值形如 `{ personaId, name, text, atSeq }`；`personaId === null` = 跟随本 Agent 自带人设
 * ⇒ **不渲染任何人格标记**（见 `vssaros-agents/lib/core/persona.js`）。
 */
export const PERSONA_KEY = 'vssaros-persona';

/**
 * 路径末段（同时认 `/` 与 `\`）。
 * 为什么不用 node:path：本模块要能被浏览器侧/测试直接 import，不引入平台差异。
 */
export function lastPathSegment(path) {
	const normalized = String(path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
	if (!normalized) {
		return '';
	}
	const at = normalized.lastIndexOf('/');
	return at >= 0 ? normalized.slice(at + 1) : normalized;
}

/**
 * 分组标题：cwd 末段 → cwd 本身。
 *
 * dsh 侧没有"工作区显示名"这个独立字段（工作区就是注册的目录），所以只有这两级；
 * 与 VsSaros 侧的 `workspaceTitleOf`（name → 路径末段 → id）是**同一个判据的下游形态**。
 */
export function workspaceTitleOf(cwd) {
	const segment = lastPathSegment(cwd);
	return segment || String(cwd ?? '').trim();
}

/** 数字或 undefined（**不把 0 与未知混起来**——0 是有信息的）。 */
function numOrUndefined(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 取一个单元的 `val`（缓存行形状 `rows[unit] = { val }`）。 */
function unitValue(rows, key) {
	const row = rows[key];
	return row && typeof row === 'object' ? row.val : undefined;
}

/** 字符串或 undefined（空串当没有）。 */
function strOrUndefined(value) {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * 「待用户回答 / 待审批」的条数。
 *
 * 形状容错（三种都见过）：数字 → 直接用；数组 → 长度；`{ count | pending | items }` → 里面那个数。
 * **返回 undefined = 这个单元缺席（未知）**，与"已知是 0"必须分开 —— 页面上前者不画黄点。
 */
export function pendingQuestionsOf(value) {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
	}
	if (Array.isArray(value)) {
		return value.length;
	}
	if (value && typeof value === 'object') {
		for (const key of ['count', 'pending', 'items', 'questions']) {
			const inner = value[key];
			if (typeof inner === 'number' && Number.isFinite(inner)) {
				return Math.max(0, Math.trunc(inner));
			}
			if (Array.isArray(inner)) {
				return inner.length;
			}
		}
	}
	return undefined;
}

/**
 * 从缓存行装配出**页面真正要用的那几个字段**（其余一律丢弃——只读面越小越不容易与上游漂移）。
 *
 * ⚠ 这里刻意**不做** dashboard 那套 stats/tokens/contextBreakdown 的整形：本页是会话列表，
 * 不显示用量；少读一个单元就少一处"上游改了形状而这边静默显示错值"的机会。
 */
export function sessionFromCacheRows(valueOf, { id, cwd, createdAt, source = 'cache' } = {}) {
	const persona = valueOf(PERSONA_KEY);
	const personaId = persona && typeof persona === 'object' ? strOrUndefined(persona.personaId) : undefined;
	const personaName = persona && typeof persona === 'object' ? strOrUndefined(persona.name) : undefined;
	const turn = valueOf(TURN_KEY);
	const retry = valueOf(RETRY_KEY);
	return {
		id: strOrUndefined(id),
		cwd: strOrUndefined(cwd),
		createdAt: numOrUndefined(createdAt),
		title: strOrUndefined(valueOf(TITLE_KEY)),
		preset: strOrUndefined(valueOf(PRESET_KEY)),
		// 人格：切换过才有（personaId === null ⇒ 跟随自带人设 ⇒ 不显示标记）
		personaId,
		personaName,
		personaAtSeq: persona && typeof persona === 'object' ? numOrUndefined(persona.atSeq) : undefined,
		// 运行状态（三个信号各自可能缺席）
		turnRunning: turn && typeof turn === 'object' && turn.running === true ? true
			: (turn && typeof turn === 'object' && turn.running === false ? false : undefined),
		retrying: retry && typeof retry === 'object' && typeof retry.retry === 'number' && retry.retry > 0 ? true : undefined,
		pendingQuestions: pendingQuestionsOf(valueOf(QUESTIONS_KEY)),
		// 「空白会话」权威口径（产品自己给的）：blank=true 表示折叠前缀里没有回合
		blank: (() => {
			const meta = valueOf(LIST_META_KEY);
			return meta && typeof meta === 'object' && typeof meta.blank === 'boolean' ? meta.blank : undefined;
		})(),
		lastPromptAt: (() => {
			const meta = valueOf(LIST_META_KEY);
			if (!meta || typeof meta !== 'object' || !Object.prototype.hasOwnProperty.call(meta, 'lastPromptAt')) {
				return undefined;
			}
			return meta.lastPromptAt === null ? null : numOrUndefined(meta.lastPromptAt);
		})(),
		// 子智能体三件（父会话给 `children`、子会话给 `role`/`timing`）—— 缺席一律 `undefined`（未知 ✓）
		children: subagentChildrenOf(valueOf),
		role: subagentRoleOf(valueOf),
		timing: subagentTimingOf(valueOf),
		source,
	};
}

// ── 子智能体（subagent）明细：2026-10-14（P1 第二块）──────────────────────────────
// 为什么加在**会话页**而不是新开一整页：子智能体**本身就是会话**（父子关系在投影里 ✓），而本页
// 已经把会话读进来了 ⇒ 只差"把父子关系渲染出来" ✓。新开整页要多一个 IDE 容器 + `DSH_MODULE_PAGES`
// 登记 + 逐项一致守卫，成本高而信息量相同 ✗。
//
// 三个单元的名字与 `vssaros-dashboard/lib/core/dashboard.js:55-58` **同一份**（都从运行时 schema 逐字核对 ✓）：
//   · `subagentCatalog` —— 父会话上：`Array<{ id, createdAt, mode: 'one-shot'|'continuable'|'unknown', label? }>`
//   · `subagent`         —— 子会话上：身份 `{ mode, label?, seq, parentSessionId? }`
//   · `subagentTiming`   —— 子会话上：`{ settledMs?, active?: { since } }`
// ⚠ `running` **不在投影里**（官方从状态通道取）⇒ 这里用"子会话自己的 `turnBoundary`/`llmRetry`"判
//   （与 {@link isRunningSession} 同口径 ✓，页面里那盏灯也是这么判的 ✓）。
export const SUBAGENT_CATALOG_KEY = 'subagentCatalog';
export const SUBAGENT_KEY = 'subagent';
export const SUBAGENT_TIMING_KEY = 'subagentTiming';

/**
 * 父会话的子代理目录 → 归一化数组；**缺席/形状不认识 ⇒ `undefined`（未知）**，空数组才是"确实没有" ✓
 * （家规：未知不许伪装成 0 ✗ —— 页面上"没派过"和"这个单元读不到"要给不同的话 ✓）。
 */
export function subagentChildrenOf(valueOf) {
	const raw = typeof valueOf === 'function' ? valueOf(SUBAGENT_CATALOG_KEY) : undefined;
	if (!Array.isArray(raw)) {
		return undefined;
	}
	return raw.filter(entry => entry && typeof entry === 'object' && strOrUndefined(entry.id)).map(entry => ({
		id: String(entry.id),
		mode: strOrUndefined(entry.mode) ?? 'unknown',
		label: strOrUndefined(entry.label),
		createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : undefined,
	}));
}

/** 子会话自己的身份（`{ mode, label?, seq, parentSessionId? }`）；缺席 ⇒ `undefined` ✓。 */
export function subagentRoleOf(valueOf) {
	const raw = typeof valueOf === 'function' ? valueOf(SUBAGENT_KEY) : undefined;
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const mode = strOrUndefined(raw.mode);
	const seq = Number.isFinite(raw.seq) ? raw.seq : undefined;
	const label = strOrUndefined(raw.label);
	const parentSessionId = strOrUndefined(raw.parentSessionId);
	if (mode === undefined && seq === undefined && label === undefined) {
		return undefined;
	}
	return { mode, label, seq, parentSessionId };
}

/** 子会话的耗时（`{ settledMs?, running }`）：`settledMs` 缺席 ⇒ 只报 `running`（不编造 0 秒 ✗）。 */
export function subagentTimingOf(valueOf, now = Date.now()) {
	const raw = typeof valueOf === 'function' ? valueOf(SUBAGENT_TIMING_KEY) : undefined;
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const settledMs = Number.isFinite(raw.settledMs) ? raw.settledMs : undefined;
	// 官方口径：`running` 只在"有 active 窗口"时才给（`dashboard.js` 的注释同款 ✓）
	const running = raw.active && typeof raw.active === 'object';
	const since = running && Number.isFinite(raw.active.since) ? raw.active.since : undefined;
	return {
		settledMs,
		running,
		...(running && since !== undefined && now > since ? { liveMs: now - since } : {}),
	};
}

/**
 * 把"全都话列表"里带子代理的挑出来 → 页面用的**父子行**。
 *
 * `sessions` 是 `sessionFromCacheRows()` 的产物（含 `children` / `role` / `timing` ✓）。
 * 只收**父会话**（有 `children` 的）；每个孩子带上它自己的会话行（标题/状态/耗时 ✓）——
 * 孩子若不在本轮扫描窗口里（被截断/文件过大 ✗）就**如实缺席**，不编造 ✓。
 */
export function subagentRowsOf(sessions) {
	const list = Array.isArray(sessions) ? sessions : [];
	const byId = new Map(list.map(s => [String(s?.id ?? ''), s]));
	const rows = [];
	for (const parent of list) {
		const children = parent?.children;
		// ⚠ 空目录（`[]`）**不产出行**：那与"这个单元没出现"在页面上要分开说 —— 前者是"确实没派过"、
		//   后者是"未知"（见 `index.js` 的 `subagentSectionOf` ✓）。产出 `0 个子智能体` 的空行会让
		//   那两句文案**永远走不到** ✗（本探针 p3-92 第一版就是这么红出来的 ✓）。
		if (!Array.isArray(children) || children.length === 0) {
			continue;
		}
		rows.push({
			parentId: String(parent.id ?? ''),
			parentTitle: displayTitleOf(parent),
			parentStatus: statusOf(parent),
			children: children.map(child => {
				const row = byId.get(String(child.id));
				return {
					id: child.id,
					mode: child.mode,
					label: child.label,
					title: row ? displayTitleOf(row) : undefined,
					status: row ? statusOf(row) : undefined,
					settledMs: row?.timing?.settledMs,
					liveMs: row?.timing?.liveMs,
				};
			}),
		});
	}
	// 有孩子在跑的行排前面（页面上一眼看到"正在跑的那棵树" ✓）；其余按子代理数降序
	const rank = r => (r.children.some(c => c.status === 'running') ? 0 : 1);
	return rows.sort((a, b) => (rank(a) - rank(b)) || (b.children.length - a.children.length));
}

/** 子代理标识的显示名：`label` → id 前 8 位（**不猜**更有意义的名字 ✓）。 */
export function subagentDisplayName(child) {
	return strOrUndefined(child?.label) ?? String(child?.id ?? '').slice(0, 8);
}

/** 模式文案（`one-shot` / `continuable` / 其余 ⇒ 空串 = 不渲染标记 ✓）。 */
export function subagentModeLabel(mode) {
	const value = String(mode ?? '');
	if (value === 'one-shot') { return '一次性'; }
	if (value === 'continuable') { return '可继续'; }
	return '';
}

/** 耗时文案：`settledMs` → `liveMs` → 空串（都没有 ⇒ **不写 0 秒** ✗）。 */
export function subagentDurationText(child) {
	const ms = Number.isFinite(child?.settledMs) ? child.settledMs : (Number.isFinite(child?.liveMs) ? child.liveMs : undefined);
	if (ms === undefined || ms < 0) { return ''; }
	const total = Math.round(ms / 1000);
	if (total < 60) { return total + ' 秒'; }
	return Math.floor(total / 60) + ' 分 ' + String(total % 60).padStart(2, '0') + ' 秒';
}

/** 解析一个缓存文件 → `{ session }` 或 `{ error }`（坏文件只丢自己，带原因）。 */
export function parseSessionCache(text, { id } = {}) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { error: `不是合法 JSON：${String(e?.message ?? e)}` };
	}
	if (!raw || typeof raw !== 'object') {
		return { error: `顶层不是对象：${typeof raw}` };
	}
	if (raw.version !== SUPPORTED_CACHE_VERSION) {
		return { error: `缓存版本不认识：version=${String(raw.version)}（本模块按 v${SUPPORTED_CACHE_VERSION} 解析）` };
	}
	const record = raw.record;
	if (!record || typeof record !== 'object') {
		return { error: '缺 record' };
	}
	const identity = record.identity && typeof record.identity === 'object' ? record.identity : {};
	const rows = record.rows && typeof record.rows === 'object' ? record.rows : {};
	return {
		session: sessionFromCacheRows(key => unitValue(rows, key), {
			id,
			cwd: identity.cwd,
			createdAt: identity.createdAt,
		}),
	};
}

/**
 * 该会话是不是「正在跑」——**不占那 5 条配额**的那一类。
 * 口径：回合在跑 或 正在重试（LLM）。「等待用户」（`pendingQuestions > 0`）见 {@link isAwaitingSession}。
 */
export function isRunningSession(session) {
	return session.turnRunning === true || session.retrying === true;
}

/** 该会话是不是「在等用户」：有待回答/待审批的问题（黄点）。 */
export function isAwaitingSession(session) {
	return typeof session.pendingQuestions === 'number' && session.pendingQuestions > 0;
}

/** 「始终可见且不占配额」的判据（两个信号任一成立）。 */
export function isActiveSession(session) {
	return isRunningSession(session) || isAwaitingSession(session);
}

/**
 * 指示灯阶段（照 VsSaros 侧的四态口径，砍掉这里拿不到的那两态）。
 * `awaiting` 优先于 `running`：与 VsSaros 侧（`:2009-2011`）同一条判据 ——
 * 否则"该你回答了"会被紧接着的收尾 delta 覆盖掉。
 */
export function statusOf(session) {
	if (isAwaitingSession(session)) {
		return 'awaiting';
	}
	if (isRunningSession(session)) {
		return 'running';
	}
	return 'idle';
}

/** 一个分组。`key` = 规范化后的分组值（未归属为 {@link UNGROUPED_GROUP_KEY}）。 */
function groupOf(key, sessions, path, title) {
	return {
		key,
		title,
		path,
		ungrouped: key === UNGROUPED_GROUP_KEY,
		sessions,
	};
}

/**
 * 会话列表的两种分组方式（页面 `?groupBy=` 的取值，2026-10-12 用户要求）：
 *   · `workspace` —— 按**工作区**（会话的 `cwd`），默认；
 *   · `bot`       —— 按 **Bot**（会话跑的那个 preset，即投影 `agentPreset`）。
 * 「Bot」这个词是用户侧的叫法，数据上就是 dsh 的 preset id（如 `vssaros-standard`）——
 * 显示 id 本身，**不猜**"更好看的名字"（本页拿不到 Agent 注册表，硬编一套映射必然和那边漂移 ✗）。
 */
export const SESSION_GROUP_BY = ['workspace', 'bot'];

/** `?groupBy=` 归一化：不认识的值一律回默认（**不抛错**：坏参数最多是分组方式回到默认）。 */
export function normalizeGroupBy(value) {
	const key = String(value ?? '').trim().toLowerCase();
	return SESSION_GROUP_BY.includes(key) ? key : 'workspace';
}

/** 一条会话在某种分组方式下的**分组值**（未归属一律 {@link UNGROUPED_GROUP_KEY}）。 */
export function groupKeyOf(session, by = 'workspace') {
	const raw = by === 'bot' ? session?.preset : session?.cwd;
	return typeof raw === 'string' && raw.trim() ? raw.trim() : UNGROUPED_GROUP_KEY;
}

/** 分组标题：工作区取路径末段（`name → 路径末段 → id` 那条判据的下游形态）；Bot 就是 preset id。 */
function groupTitleOf(key, by) {
	if (key === UNGROUPED_GROUP_KEY) {
		return by === 'bot' ? '未归属 Bot' : '未分组';
	}
	return by === 'bot' ? key : workspaceTitleOf(key);
}

/**
 * 分组（默认按 cwd = dsh 的工作区；`options.by === 'bot'` 时按 preset）。
 *
 * 顺序：① 按"该组下最新会话的 `createdAt` 降序"（没有 createdAt 的排后）→ ② 未归属组恒在最后。
 * 为什么按活跃度而不是字典序：侧栏里最常用的那个应当最靠上，而字典序会让它随机沉底。
 * 组内**保持入参顺序**（调用方已按 createdAt 降序排好）。
 */
export function buildSessionGroups(sessions, options = {}) {
	const by = normalizeGroupBy(options.by);
	const buckets = new Map();
	for (const session of Array.isArray(sessions) ? sessions : []) {
		if (!session || typeof session !== 'object') {
			continue;
		}
		const key = groupKeyOf(session, by);
		let bucket = buckets.get(key);
		if (!bucket) {
			// `path` 只用于"工作区"那种分组（分组头副文本 = 完整路径）；按 Bot 分组时它等于组名本身，不再重复显示。
			bucket = { sessions: [], newest: undefined, path: key === UNGROUPED_GROUP_KEY || by === 'bot' ? '' : key };
			buckets.set(key, bucket);
		}
		bucket.sessions.push(session);
		const at = numOrUndefined(session.createdAt);
		if (at !== undefined && (bucket.newest === undefined || at > bucket.newest)) {
			bucket.newest = at;
		}
	}

	const groups = [];
	for (const [key, bucket] of buckets) {
		if (key !== UNGROUPED_GROUP_KEY) {
			groups.push(groupOf(key, bucket.sessions, bucket.path, groupTitleOf(key, by)));
		}
	}
	groups.sort((a, b) => {
		const left = buckets.get(a.key).newest;
		const right = buckets.get(b.key).newest;
		if (left === undefined && right === undefined) {
			return a.key.localeCompare(b.key);   // 两个都没时间：用 key 保证**确定性顺序**，不抖
		}
		if (left === undefined) {
			return 1;
		}
		if (right === undefined) {
			return -1;
		}
		return right - left;
	});
	const ungrouped = buckets.get(UNGROUPED_GROUP_KEY);
	if (ungrouped) {
		// 未归属**恒在最后**（与 VsSaros 侧同口径）。
		groups.push(groupOf(UNGROUPED_GROUP_KEY, ungrouped.sessions, '', groupTitleOf(UNGROUPED_GROUP_KEY, by)));
	}
	return groups;
}

/**
 * 组内可见会话（照 dsh desktop 的行投影）：
 * ① `isActive` 为真（运行中 / 等待用户）的行**始终可见**且**不占**「5 条」配额；
 * ② 空闲会话按原顺序取前 `limit + extraShown` 条，其余只计数不渲染。
 *
 * @param options.unlimited true = 不截断（搜索命中时用，否则"刚搜到的行被折叠掉了" ✗）
 */
export function computeGroupWindow(sessions, extraShown, isActive, options = {}) {
	const list = Array.isArray(sessions) ? sessions : [];
	if (options.unlimited === true) {
		return { visible: list.slice(), hiddenIdle: 0, canExpand: false, canCollapse: false };
	}
	const limit = Number.isFinite(options.limit) && options.limit >= 1 ? Math.floor(options.limit) : SESSION_GROUP_IDLE_LIMIT;
	const extra = normalizeExtra(extraShown, 0);
	const quota = limit + extra;

	const visible = [];
	let idleShown = 0;
	let hiddenIdle = 0;
	for (const session of list) {
		if (isActive(session)) {
			visible.push(session);
			continue;
		}
		if (idleShown < quota) {
			idleShown++;
			visible.push(session);
		} else {
			hiddenIdle++;
		}
	}
	return {
		visible,
		hiddenIdle,
		canExpand: hiddenIdle > 0,
		canCollapse: extra > 0 && hiddenIdle === 0,
	};
}

/** 「展开其余」后的额外条数。容错：非有限值 / 负数 / 非正 step 一律回落默认值。 */
export function nextExtraShown(extraShown, step = SESSION_GROUP_EXPAND_STEP) {
	const safeStep = Number.isFinite(step) && step > 0 ? Math.floor(step) : SESSION_GROUP_EXPAND_STEP;
	return normalizeExtra(extraShown, 0) + safeStep;
}

function normalizeExtra(value, fallback) {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/** 会话显示标题：title → 未命名（**不猜**：title 是产品自己投影的字段）。 */
export function displayTitleOf(session) {
	return strOrUndefined(session?.title) ?? '(未命名会话)';
}

/**
 * 把 dsh 的 preset **花名册**（`ctx.agentPresets.list()`）转成 `presetId → 显示名` 的纯映射。
 *
 * ⚠ 只收 `id` + **非空字符串** `name` 的项：加载失败 / `broken` / 没名字的项一律**不进表**
 * ⇒ 调用方据此回落显示 preset id（**绝不猜名字**）。这是"按 Bot 分组"组名的权威来源：
 * preset 的 `name` 由注册它的插件（`@vssaros/dsh-agents` 用 agent 的 `name`）给定，
 * 而 `presetId = 'vssaros-' + slugify(agentId)` 是**有损**的 ⇒ 只能正向由花名册查，不能反解。
 */
export function presetNamesOf(presets) {
	const map = new Map();
	const list = Array.isArray(presets) ? presets : (Array.isArray(presets?.presets) ? presets.presets : []);
	for (const preset of list) {
		const id = strOrUndefined(preset?.id);
		const name = strOrUndefined(preset?.name);
		if (id && name) {
			map.set(id, name);
		}
	}
	return map;
}

/**
 * 按 Bot 分组时把组名换成花名册里的显示名。
 * **副文本（`path`）仍是 preset id** —— 显示名友好了，但真身不藏（查不到就原样保留 id 当组名）。
 */
export function applyPresetNames(groups, by, names) {
	if (normalizeGroupBy(by) !== 'bot' || !names || typeof names.get !== 'function' || names.size === 0) {
		return groups;
	}
	return groups.map(group => {
		const name = group.ungrouped ? undefined : names.get(group.key);
		return name ? { ...group, title: name, path: group.key } : group;
	});
}

/** 人格标记的显示名：`name` → `personaId`；没切换过 ⇒ 空串（调用方据此不渲染标记）。 */
export function personaLabelOf(session) {
	if (!session?.personaId) {
		return '';
	}
	return strOrUndefined(session.personaName) ?? session.personaId;
}
