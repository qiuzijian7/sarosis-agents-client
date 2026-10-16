/**
 * `storage` op 的**纯逻辑**（2026-10-15，P1-⑤）：localStorage / sessionStorage 的**只读报告**与
 * **跨 profile 搬运**（`export` / `import`）。
 *
 * ## 为什么需要它（接上 cookie 通道那条的缺口）
 *
 * `cookies` 通道能把登录态从一个会话搬到另一个会话，但**很多站点的登录态在 localStorage 里**（token /
 * 前端自己存的凭据），只搬 cookie 的症状是"看着登录了、其实没登录" ✗ —— 这正是 4.92/4.93 那条
 * "专属 profile vs 你自己的 Chrome" 讨论里被点出来的坑。
 *
 * ## 七条硬约束（**与 `core/cookies.js` 同族**，改这里之前先读那六条）
 *
 * ① **值只落盘、绝不进工具返回值 / 日志 / 报错文案** —— 返回值里只有**键名、条数、字节数**
 *    （键名本身不足以冒充身份）。值进模型上下文 = 泄漏给推理链路 ⇒ 这是本模块的第一纪律 ✓；
 * ② **默认关闭**：`allowStorageIO` 为假时 export/import 直接拒（`list` 只读报告不受影响）；
 * ③ **只接受 https**（或本地回环 http，供开发自测）—— 仅对**写盘/注入**那一侧（export/import）✓；
 *    `list` 只是键名报告 ⇒ 不设这个围栏（否则 http 站点连"登录态在不在 localStorage"都查不了 ✗）；
 * ④ **存档路径不可由调用方指定**（`storageStorePath` 一个文件，与 cookie 通道同纪律）；
 * ⑤ **必须与当前页同源**：localStorage 是**按源**隔离的 ⇒ 要搬 `example.com` 的 storage，
 *    当前页就得在 `example.com` 上。**我们不替调用方导航**（导航是动作类）⇒ 不同源一律**报错并说清**
 *    "先把页面开过去" ✓（静默导航 = 一次未经审批的动作 ✗）；
 * ⑥ 读出来的存档一律**过一遍净化**（`sanitizeStorageMap`）—— 磁盘上的东西是不可信输入；
 * ⑦ **有界**：单值 ≤ `STORAGE_VALUE_MAX_BYTES`、每区 ≤ `STORAGE_MAX_ENTRIES` ⇒ 超出的**计数并如实报**
 *    （不静默丢 ✗，也不把 10MB 拖进 Host 进程 ✗）。
 */

import { cookieDomainMatches, looksLikeSessionCookie, safeHostSlug } from './cookies.js';

/** 存档格式版本（改字段必须升版本；读侧按版本分派，未知版本一律拒 —— 宁可读不出来也不误注入）。 */
export const STORAGE_STORE_VERSION = 1;

/** 存档目录名（放在 `<home>/.vssaros/` 下，与 cookie 存档同域但**不同目录** ⇒ 互不干扰 ✓）。 */
export const STORAGE_STORE_DIRNAME = 'browser-storage';

/** 单个值的字节上限（字符数近似）：再大的不是"登录态"，是数据本身 —— 那该走别的通道。 */
export const STORAGE_VALUE_MAX_BYTES = 64 * 1024;

/** 每个存储区（localStorage / sessionStorage）的条目上限。 */
export const STORAGE_MAX_ENTRIES = 200;

/** 归档/注入的两个存储区名（页内与磁盘上共用同一套 `localStorage` / `sessionStorage` 字样 ✓）。 */
export const STORAGE_AREAS = ['localStorage', 'sessionStorage'];

/**
 * 归一 `storage` op 的 action；**未知值一律落到只读的 `list`**
 *（不认识的动作不许有副作用 —— 与 `normalizeCookieAction` 同一条纪律 ✓）。
 */
export function normalizeStorageAction(raw) {
	const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	if (v === 'export' || v === 'import') { return v; }
	return 'list';
}

/** 某站点的**存档路径**（调用方不可指定 —— 见模块头 ④）。 */
export function storageStorePath(homeDir, platform, host) {
	const slug = safeHostSlug(host);
	if (!slug) { return undefined; }
	const sep = platform === 'win32' ? '\\' : '/';
	return `${homeDir}${sep}.vssaros${sep}${STORAGE_STORE_DIRNAME}${sep}${slug}.json`;
}

/**
 * 净化一个存储区（磁盘**双向**共用）：只留 `string → string`；**丢掉非字符串**（页面上可能有
 * 别的类型？`localStorage` 恒为字符串，但磁盘是**不可信输入** ⇒ 仍然只认字符串 ✓）。
 *
 * 有界（见模块头 ⑦）：超长值 / 超量条目**计数**返回，由调用方如实报（不静默丢 ✓）。
 * @returns `{ map, skippedLarge, skippedOverflow }`
 */
export function sanitizeStorageMap(raw, limits = {}) {
	const maxEntries = Number.isFinite(limits.maxEntries) ? Math.max(0, Math.floor(limits.maxEntries)) : STORAGE_MAX_ENTRIES;
	const maxValue = Number.isFinite(limits.maxValueBytes) ? Math.max(0, Math.floor(limits.maxValueBytes)) : STORAGE_VALUE_MAX_BYTES;
	const map = {};
	let skippedLarge = 0;
	let skippedOverflow = 0;
	const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
	for (const [k, v] of Object.entries(src)) {
		if (typeof k !== 'string' || !k) { continue; }
		if (typeof v !== 'string') { continue; }
		if (v.length > maxValue) { skippedLarge += 1; continue; }
		if (Object.keys(map).length >= maxEntries) { skippedOverflow += 1; continue; }
		map[k] = v;
	}
	return { map, skippedLarge, skippedOverflow };
}

/**
 * 存储区的**可外传摘要**：只有键名、条数、字节数 —— **没有值**（模块头 ①）。
 * `sessionish` 复用 cookie 那套"看起来像登录态"的启发式（**仅用于报数**，不参与任何授权判定 ✓）。
 */
export function summarizeStorage(map, host) {
	const names = Object.keys(map ?? {});
	const bytes = names.reduce((sum, k) => sum + String(map[k] ?? '').length, 0);
	const sessionish = names.filter(n => looksLikeSessionCookie(n, host));
	return { total: names.length, bytes, names, sessionish, hasSessionish: sessionish.length > 0 };
}

/** 存档信封（写入磁盘的形状；含 `savedAt` 便于用户自己判断新旧）。 */
export function storageEnvelope(host, areas, savedAt) {
	const out = { version: STORAGE_STORE_VERSION, host: String(host ?? ''), savedAt: String(savedAt ?? '') };
	const skipped = {};
	for (const area of STORAGE_AREAS) {
		const r = sanitizeStorageMap(areas?.[area]);
		out[area] = r.map;
		if (r.skippedLarge || r.skippedOverflow) {
			skipped[area] = { skippedLarge: r.skippedLarge, skippedOverflow: r.skippedOverflow };
		}
	}
	if (Object.keys(skipped).length > 0) { out.skipped = skipped; }
	return out;
}

/**
 * 解析存档（**不抛错**，判别式结果 —— 与 `parseCookieStoreEnvelope` 同纪律）。
 * 两个存储区都空 ⇒ `no-usable-entries`（"读到了但没东西可搬"是一种要如实说出的状态 ✓）。
 */
export function parseStorageEnvelope(rawText) {
	let data;
	try {
		data = JSON.parse(String(rawText ?? ''));
	} catch {
		return { ok: false, reason: 'not-json' };
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) { return { ok: false, reason: 'not-object' }; }
	if (data.version !== STORAGE_STORE_VERSION) { return { ok: false, reason: `version-mismatch(${String(data.version)})` }; }
	if (typeof data.host !== 'string' || !data.host) { return { ok: false, reason: 'missing-host' }; }
	const areas = {};
	let total = 0;
	for (const area of STORAGE_AREAS) {
		const r = sanitizeStorageMap(data[area]);
		areas[area] = r.map;
		total += Object.keys(r.map).length;
	}
	if (total === 0) { return { ok: false, reason: 'no-usable-entries' }; }
	return { ok: true, host: data.host, savedAt: typeof data.savedAt === 'string' ? data.savedAt : '', areas };
}

/**
 * **页内读取脚本**（我们自己的固定语句 ⇒ 不受 `allowEvaluate` 约束 ✓）：
 * 回 `{ protocol, host, localStorage, sessionStorage, skipped:{...} }` 的 **JSON 字符串**
 *（字符串而不是对象：避免 CDP `returnByValue` 在超大对象上的序列化开销与截断风险 ✓）。
 *
 * ⚠ 有界（页内**先**截断）：超长值 / 超量条目在**页面侧**就丢掉并计数 ⇒ 不把 10MB 拖进 Host 进程 ✓。
 * ⚠ 脚本里不能出现反引号或 `${`（与 `SNAPSHOT_SCRIPT` 同一纪律 ⇒ 用字符串拼接写 ✓）。
 */
export function buildReadStorageScript() {
	return '(function(){'
		+ 'var LIMIT=' + STORAGE_VALUE_MAX_BYTES + ',MAX=' + STORAGE_MAX_ENTRIES + ';'
		+ 'var skipped={localStorage:{large:0,overflow:0},sessionStorage:{large:0,overflow:0}};'
		+ 'function grab(store,area){var out={},n=0;if(!store){return out;}'
		+ 'for(var i=0;i<store.length;i++){var k=store.key(i);if(k===null){continue;}'
		+ 'var v=store.getItem(k);if(typeof v!=="string"){continue;}'
		+ 'if(v.length>LIMIT){skipped[area].large++;continue;}'
		+ 'if(n>=MAX){skipped[area].overflow++;continue;}'
		+ 'out[k]=v;n++;}return out;}'
		+ 'return JSON.stringify({protocol:location.protocol,host:location.host,'
		+ 'localStorage:grab(window.localStorage,"localStorage"),sessionStorage:grab(window.sessionStorage,"sessionStorage"),'
		+ 'skipped:skipped});'
		+ '})()';
}

/**
 * **页内写入脚本**：把 `entries` 逐条 `setItem` 进 localStorage，回写入条数。
 *
 * ⚠ 只写 localStorage（**不写 sessionStorage**）：sessionStorage 属于**标签页生命周期**，
 * 注入到新标签页没有意义（下次导航/关页即失）⇒ 搬它只会制造"看起来搬了、其实没生效" ✗。
 * 这一点在报告里**如实写明** ✓。
 */
export function buildWriteLocalStorageScript(entries) {
	return '(function(){var m=' + JSON.stringify(entries ?? {}) + ';var n=0;'
		+ 'for(var k in m){if(Object.prototype.hasOwnProperty.call(m,k)){try{window.localStorage.setItem(k,m[k]);n++;}catch(e){}}}'
		+ 'return n;})()';
}

/** 当前页是否与目标站点同源（localStorage 按源隔离 —— 见模块头 ⑤）。 */
export function sameOriginHost(host, pageHost) {
	return cookieDomainMatches(host, pageHost);
}

/**
 * 解析 {@link buildReadStorageScript} 的返回值（判别式，不抛错）。
 *
 * 为什么单独一个函数：它是"页内事实 → Host 事实"的那道边界 —— 畸形载荷必须**可表达**（`{ok:false, reason}`），
 * 而不是让一个 `JSON.parse` 的异常穿到模型那一层（那会丢掉"是谁答歪了"这个信息 ✗）。
 */
export function parseStorageRead(raw) {
	if (typeof raw !== 'string' || !raw.trim()) { return { ok: false, reason: 'empty-payload' }; }
	let data;
	try { data = JSON.parse(raw); } catch { return { ok: false, reason: 'not-json' }; }
	if (!data || typeof data !== 'object' || Array.isArray(data)) { return { ok: false, reason: 'not-object' }; }
	if (typeof data.host !== 'string' || !data.host) { return { ok: false, reason: 'missing-host' }; }
	const areas = {};
	for (const area of STORAGE_AREAS) {
		areas[area] = sanitizeStorageMap(data[area]).map;
	}
	const skipped = data.skipped && typeof data.skipped === 'object' ? data.skipped : {};
	return {
		ok: true,
		protocol: typeof data.protocol === 'string' ? data.protocol : '',
		host: data.host,
		areas,
		skipped,
	};
}

/**
 * 把"被截断/被丢掉"的事实写成一句人话 —— 三条渠道（页内读取、写盘、解析存档）都会产生它，
 * 只有一处实现 ⇒ 不会漂 ✓。**没有截断时返回 `undefined`**（报告里就不出现这一行 ✓）。
 */
export function skippedNote(...sources) {
	const perArea = {};
	const bump = (area, key, n) => {
		if (!Number.isFinite(n) || n <= 0) { return; }
		perArea[area] = perArea[area] ?? {};
		perArea[area][key] = (perArea[area][key] ?? 0) + n;
	};
	for (const src of sources) {
		if (!src || typeof src !== 'object') { continue; }
		for (const area of STORAGE_AREAS) {
			const s = src[area];
			if (!s || typeof s !== 'object') { continue; }
			bump(area, 'large', Number(s.large ?? s.skippedLarge));
			bump(area, 'overflow', Number(s.overflow ?? s.skippedOverflow));
		}
	}
	const parts = [];
	for (const area of STORAGE_AREAS) {
		const s = perArea[area];
		if (!s) { continue; }
		const bits = [];
		if (s.large) { bits.push(`${s.large} value(s) exceed ${STORAGE_VALUE_MAX_BYTES} chars`); }
		if (s.overflow) { bits.push(`${s.overflow} entry(ies) beyond the ${STORAGE_MAX_ENTRIES}-entry cap`); }
		if (bits.length) { parts.push(`${area}: ${bits.join(', ')} were **not** included`); }
	}
	return parts.length ? `⚠ Truncated on purpose (never silent): ${parts.join('; ')}.` : undefined;
}

/** `storage` op 的给模型报告（**只有键名、条数、字节数 —— 没有值** ✗）。 */
export function formatStorageReport(options) {
	const action = options?.action ?? 'list';
	const host = String(options?.host ?? '');
	const local = options?.summary?.localStorage ?? { total: 0, bytes: 0, names: [], sessionish: [], hasSessionish: false };
	const session = options?.summary?.sessionStorage ?? { total: 0, bytes: 0, names: [], sessionish: [], hasSessionish: false };
	const head = {
		list: `## Storage list — ${host}`,
		export: `## Storage export — ${host}`,
		import: `## Storage import — ${host}`,
	}[action] ?? `## Storage — ${host}`;

	const lines = [head, ''];
	lines.push(`localStorage: **${local.total}** key(s), ${local.bytes} char(s)`);
	if (local.hasSessionish) { lines.push(`  login-ish keys (heuristic, names only): ${local.sessionish.join(', ')}`); }
	if (local.total > 0 && !local.hasSessionish) { lines.push('  none of the keys look login-related — the site may simply not be signed in yet.'); }
	lines.push(`sessionStorage: **${session.total}** key(s), ${session.bytes} char(s)`);
	if (options?.skippedNote) { lines.push('', options.skippedNote); }

	if (action === 'export') {
		lines.push('', `Saved to: ${String(options?.path ?? '(unknown)')}`);
		lines.push('⚠ That file holds live tokens for this site. Do NOT paste it anywhere, and do not commit it.');
		lines.push('sessionStorage was recorded for reference but is **not** usable on import (it dies with the tab).');
	}
	if (action === 'import') {
		lines.push('', `Wrote **${Number(options?.injected ?? 0)}** localStorage entry(ies). Reload the page, then verify with ` + '`op: "login"`' + ' + `done: true`.');
		lines.push('sessionStorage entries in the store were **skipped** (tab-scoped; injecting them has no effect).');
	}
	if (action === 'list') {
		lines.push('', 'Values are deliberately **not** returned (a single key can hold a live token). '
			+ 'To move this login to another profile use `action: "export"` + `action: "import"` (both gated).');
	}
	return lines.join('\n');
}
