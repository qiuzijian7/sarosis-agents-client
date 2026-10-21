// @vssaros/dsh-memory — 历史会话召回（`memory_recall` 的第二段；2026-10-20，借鉴 dsh-memento 的 recallHistory）。
//
// 为什么要有：dsh 侧没有逐轮 observe（IDE 时代那条写入链随聊天框废弃），长期记忆里几乎没有"上次做过什么"。
// 而会话日志本身就在 —— 官方 `sessionQuery` 服务能直接查，比再造一份写入链便宜得多。
//
// ⚠ 只用**与后端无关**的两个方法：`filterSessions`（元数据过滤）+ `filterEvents`（字面量文本扫描）。
//   不用 `searchSessions`：vssaros profile 的 `session-query-sqlite` 是 `openAt: never`
//   （类型注释原文："`never` disables full-text search entirely"）⇒ 全文检索在本部署里**一定被拒**。
// ⚠ 全程有界：候选会话数、命中会话数、片段长度、总时长（`filterEvents` 不收 signal ⇒ 用截止时间在调用之间判）。
//   任何失败都**降级为"没有历史"**并带原因，绝不让 `memory_recall` 的记忆那一段跟着失败。
// ⚠ 零 dsh import ⇒ 探针直接喂假服务就能测。

/** 缺省参数。 */
export const HISTORY_DEFAULTS = Object.freeze({
	windowDays: 30,
	maxCandidates: 12,
	maxSessions: 5,
	snippetsPerSession: 2,
	snippetChars: 160,
	deadlineMs: 2500,
});

/**
 * 从查询里挑一个用于**字面量**匹配的词：`filterEvents` 的 text 谓词是整串字面匹配，
 * 多词查询整串几乎撞不上 ⇒ 取最长的那个词（≥2 字）。
 * @param {string} query
 * @returns {string}
 */
export function literalTermOf(query) {
	const parts = String(query ?? '').split(/[\s,，;；、|]+/).map(s => s.trim()).filter(s => s.length >= 2);
	if (parts.length === 0) { return String(query ?? '').trim(); }
	return parts.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * 以命中位置为中心截一段片段（折叠空白）。
 * @param {string} text
 * @param {string} term
 * @param {number} maxChars
 */
export function snippetAround(text, term, maxChars) {
	const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
	if (flat.length <= maxChars) { return flat; }
	const at = term ? flat.toLowerCase().indexOf(term.toLowerCase()) : -1;
	const half = Math.floor(maxChars / 2);
	const start = at < 0 ? 0 : Math.max(0, Math.min(flat.length - maxChars, at - half));
	return `${start > 0 ? '…' : ''}${flat.slice(start, start + maxChars)}${start + maxChars < flat.length ? '…' : ''}`;
}

/**
 * 召回近期同工作区的历史会话片段。
 * @param {object | undefined} sessionQuery - 官方 `sessionQuery` 服务（可缺席）。
 * @param {{ query: string, cwd?: string, excludeSessionId?: string, now?: number } & Partial<typeof HISTORY_DEFAULTS>} options
 * @returns {Promise<{ available: boolean, term: string, sessions: Array<{ sessionId: string, createdAt: number, snippets: string[] }>, scanned: number, truncated: boolean, error?: string }>}
 */
export async function recallHistory(sessionQuery, options) {
	const o = { ...HISTORY_DEFAULTS, ...options };
	const term = literalTermOf(o.query);
	const empty = extra => ({ available: false, term, sessions: [], scanned: 0, truncated: false, ...extra });
	if (!sessionQuery || typeof sessionQuery.filterSessions !== 'function' || typeof sessionQuery.filterEvents !== 'function') {
		return empty({ error: '会话检索服务不可用（组合里没有 sessionQuery）' });
	}
	if (!term) { return empty({ available: true, error: '查询为空' }); }
	const now = Number.isFinite(o.now) ? o.now : Date.now();
	// ⚠ 截止时间必须按**墙钟**算：`now` 是可注入的**逻辑时间**（时间窗用），拿它算截止会让"过去的 now"一上来就超时
	const deadline = Date.now() + o.deadlineMs;
	const timeLeft = () => deadline - Date.now();
	const filters = [{ kind: 'created-at', from: now - o.windowDays * 86400000 }];
	if (typeof o.cwd === 'string' && o.cwd) { filters.push({ kind: 'cwd', values: [o.cwd] }); }

	let records;
	try {
		records = await withTimeout(sessionQuery.filterSessions(filters, AbortSignal.timeout(Math.max(1, o.deadlineMs))), o.deadlineMs);
	} catch (error) {
		return empty({ error: `列举会话失败：${error?.message ?? error}` });
	}
	const candidates = (Array.isArray(records) ? records : [])
		.map(r => r?.header)
		.filter(h => h && typeof h.id === 'string' && h.id !== o.excludeSessionId)
		.slice(0, o.maxCandidates);

	const sessions = [];
	let scanned = 0;
	let truncated = false;
	for (const header of candidates) {
		if (sessions.length >= o.maxSessions) { break; }
		const left = timeLeft();
		if (left <= 0) { truncated = true; break; }
		let docs;
		try {
			docs = await withTimeout(sessionQuery.filterEvents(header.id, [{ kind: 'text', text: term }]), left);
		} catch (error) {
			if (error?.code === 'TIMEOUT') { truncated = true; break; }
			continue; // 单个会话读失败（格式迁移中 / 损坏）⇒ 跳过它，不拖垮整次召回
		}
		scanned++;
		const hits = (Array.isArray(docs) ? docs : []).filter(d => typeof d?.text === 'string' && d.text);
		if (hits.length === 0) { continue; }
		// 用户原话优先（比工具输出更像"当时在做什么"）
		hits.sort((a, b) => (a.type === 'user/message' ? 0 : 1) - (b.type === 'user/message' ? 0 : 1));
		sessions.push({
			sessionId: header.id,
			createdAt: Number(header.createdAt) || 0,
			snippets: hits.slice(0, o.snippetsPerSession).map(d => snippetAround(d.text, term, o.snippetChars)),
		});
	}
	return { available: true, term, sessions, scanned, truncated };
}

/** 渲染成 `memory_recall` 文本的第二段。 */
export function renderHistory(result, windowDays = HISTORY_DEFAULTS.windowDays) {
	if (!result) { return ''; }
	if (!result.available) { return `## 历史会话\n（未检索：${result.error ?? '不可用'}）`; }
	const head = `## 历史会话（近 ${windowDays} 天、同一工作区，字面匹配「${result.term}」；共查 ${result.scanned} 个会话${result.truncated ? '，已到时间上限' : ''}）`;
	if (result.sessions.length === 0) { return `${head}\n（没有命中）`; }
	const lines = result.sessions.map(s => {
		const day = s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : '?';
		return `- ${day} · ${s.sessionId}\n${s.snippets.map(t => `  > ${t}`).join('\n')}`;
	});
	return `${head}\n${lines.join('\n')}\n（片段来自会话原文，未经审核；需要细节可让用户打开对应会话）`;
}

function withTimeout(promise, ms) {
	let timer;
	return Promise.race([
		Promise.resolve(promise),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(Object.assign(new Error(`超时（${ms}ms）`), { code: 'TIMEOUT' })), Math.max(1, ms));
		}),
	]).finally(() => clearTimeout(timer));
}
