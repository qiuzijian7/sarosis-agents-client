/**
 * 站点 × 动作 × 时限的预授权（2026-11-07，P1 · 对齐 DS Bot 的 browserGrants，但不做 per-Bot）。
 *
 * ## 为什么不写进 `tool-allow.json`
 *
 * 那份文件有**两个读者**（IDE 侧 `toolExecutionGuard` 与本插件的 `allowRules.js`），语义必须逐条同构；
 * 时限是只有本插件懂的概念 ⇒ 写进去要么 IDE 侧读不懂、要么两边各自演进。所以单独一份：
 * `<数据根>/browser-grants.json`，只有本插件读写，写入者是**右栏浏览器页签里的授权条**（人点的），
 * 经本插件的 HTTP 路由（同源 + Host 登录 cookie，见 `core/routes.js`）。模型没有写入口：
 * 没有任何 op 能新增授权；文件在工作区之外（默认沙箱写不进去）。
 *
 * ## 语义
 *
 * · 一条授权 = `{ id, host, ops, until, createdAt }`：在 `host`（精确主机名，或 `*.example.com` = 它的所有子域）
 *   上做 `ops` 里的动作免问，直到 `until`（ISO 时间）。时限只有三档：1 小时 / 今天（本地时间当天结束）/ 7 天。
 *   没有「永久」—— 永久的写规则（`browser::click@host`，`tool-allow.json`），那是一次更显式的决定。
 * · 只免「问」：高危闸（付款 / 删除，`core/riskGate.js`）、`RULE_EXEMPT_DENY_OPS`（evaluate / cookies / storage /
 *   login）与各自的独立开关一律不受影响。
 * · 过期的条目读时就不算（也不再列出），下次写入时清掉。
 * · 解析失败 / 文件缺失 ⇒ 没有授权（照旧逐次问）—— 坏数据绝不当授权（fail-closed，同 `allowRules.js`）。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 授权能覆盖的动作（页面内的点击 / 输入 / 按键，与站内导航、后退）。`reset` 是进程级动作，不在内。 */
export const GRANTABLE_OPS = Object.freeze(['navigate', 'click', 'type', 'pressEnter', 'pressKey', 'back']);
/** 三档时限。 */
export const GRANT_DURATIONS = Object.freeze(['hour', 'today', 'week']);

/** 时限的终点（ISO）。 */
export function untilOf(duration, now = new Date()) {
	const at = new Date(now.getTime());
	if (duration === 'hour') { return new Date(at.getTime() + 3_600_000).toISOString(); }
	if (duration === 'week') { return new Date(at.getTime() + 7 * 86_400_000).toISOString(); }
	if (duration === 'today') { at.setHours(23, 59, 59, 999); return at.toISOString(); }
	throw new Error(`不认识的时限：${String(duration)}（只有 ${GRANT_DURATIONS.join(' / ')}）`);
}

/** 规范主机名模式：小写、去空白；只认 `host` 或 `*.host`（不认 `*`、不认端口与路径）。不合法 ⇒ undefined。 */
export function normalizeHostPattern(value) {
	const raw = String(value ?? '').trim().toLowerCase();
	const wildcard = raw.startsWith('*.');
	const host = wildcard ? raw.slice(2) : raw;
	if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
		return undefined;
	}
	return wildcard ? `*.${host}` : host;
}

/** `pattern` 是否覆盖主机 `host`：精确相等，或 `*.x` 覆盖 x 的子域（不含 x 本身）。 */
export function hostMatches(pattern, host) {
	const h = String(host ?? '').toLowerCase();
	if (!h || !pattern) { return false; }
	if (pattern.startsWith('*.')) { return h.endsWith(pattern.slice(1)); }
	return h === pattern;
}

/** 宽容解析：坏数据 ⇒ 空表（绝不抛）。 */
export function parseGrants(text) {
	let raw;
	try { raw = JSON.parse(String(text ?? '')); } catch { return []; }
	const list = Array.isArray(raw?.grants) ? raw.grants : [];
	return list.flatMap(item => {
		const host = normalizeHostPattern(item?.host);
		const ops = Array.isArray(item?.ops) ? item.ops.filter(op => GRANTABLE_OPS.includes(op)) : [];
		const until = typeof item?.until === 'string' && Number.isFinite(Date.parse(item.until)) ? item.until : undefined;
		if (!host || !ops.length || !until || typeof item?.id !== 'string' || !item.id) { return []; }
		return [{ id: item.id, host, ops, until, createdAt: typeof item?.createdAt === 'string' ? item.createdAt : until }];
	});
}

/**
 * 授权存储（按 mtime+size 缓存，同 `allowRules.js` 的取向）。
 * @param {string} filePath
 * @param {() => number} now
 */
export function createGrantStore(filePath, now = () => Date.now()) {
	let cached = [];
	let cacheKey;
	const load = () => {
		let key;
		try { const st = statSync(filePath); key = `${st.mtimeMs}:${st.size}`; } catch { key = 'missing'; }
		if (cacheKey === key) { return cached; }
		let grants = [];
		if (key !== 'missing') { try { grants = parseGrants(readFileSync(filePath, 'utf8')); } catch { grants = []; } }
		cached = grants;
		cacheKey = key;
		return grants;
	};
	const live = () => load().filter(grant => Date.parse(grant.until) > now());
	const save = grants => {
		const tmp = `${filePath}.tmp`;
		mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
		writeFileSync(tmp, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
		try { renameSync(tmp, filePath); } catch (error) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw error; }
		try { chmodSync(filePath, 0o600); } catch { /* Windows */ }
		cacheKey = undefined;
	};
	return {
		path: () => filePath,
		/** 还没过期的授权（新的在前）。 */
		list: () => [...live()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
		/** 新增一条（同主机同动作集的旧条目被它取代）。@returns 新条目 */
		add({ host, duration, ops = GRANTABLE_OPS }) {
			const pattern = normalizeHostPattern(host);
			if (!pattern) { throw new Error(`不是合法的主机名：${String(host)}`); }
			const picked = [...new Set((Array.isArray(ops) ? ops : []).filter(op => GRANTABLE_OPS.includes(op)))];
			if (!picked.length) { throw new Error(`没有可授权的动作（只有 ${GRANTABLE_OPS.join(' / ')}）`); }
			const grant = { id: randomUUID(), host: pattern, ops: picked, until: untilOf(duration, new Date(now())), createdAt: new Date(now()).toISOString() };
			const same = g => g.host === pattern && g.ops.length === picked.length && g.ops.every(op => picked.includes(op));
			save([...live().filter(g => !same(g)), grant]);
			return grant;
		},
		/** 撤销一条。@returns 撤了没有 */
		revoke(id) {
			const before = live();
			const after = before.filter(grant => grant.id !== id);
			if (after.length === before.length) { return false; }
			save(after);
			return true;
		},
		/** 在 `host` 上做 `op` 有没有还在期内的授权；有 ⇒ 那一条。 */
		match(op, host) {
			if (!GRANTABLE_OPS.includes(op)) { return undefined; }
			return live().find(grant => grant.ops.includes(op) && hostMatches(grant.host, host));
		},
	};
}
