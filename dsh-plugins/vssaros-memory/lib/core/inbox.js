// @vssaros/dsh-memory — 收件箱视图模型（记忆工作台 v2 · P1，2026-11-02）。
//
// 作用：把草稿行（`draft.js` 的 JSONL）投影成页面要的三组——待审 / 自动提升动态 / 已处理，
// 并给每条待审候选算出"**为什么没被自动提升**"（门控透明）。别家插件只展示结果，
// 用户不知道"为什么没记住"；这里把 `decideAutoPromotion` 的拒绝原因翻译成人话。
//
// ⚠ 纯函数、零 I/O、零 dsh 依赖 ⇒ 能被 `node --test` 直接钉住（页面逻辑别藏在组件里）。
// ⚠ 判定用 `judgeOk: true` 假设：页面要回答的是"结构上差什么"（句式 / 次数 / 长度），
//   而不是"LLM 这次有没有回话"（那是回合内的瞬时状态）。结构全满足 ⇒ `awaiting-judge`。

import {
	AUTO_PROMOTE_KINDS,
	SUMMARY_FACT_MIN_HITS,
	decideAutoPromotion,
} from './promotion.js';

/** 待审列表上限（页面不分页 ⇒ 防止一次渲染几百行；草稿本身上限 500）。 */
export const INBOX_PENDING_LIMIT = 100;
/** 「已处理」只看最近 N 条。 */
export const INBOX_DONE_LIMIT = 30;
/** 「自动提升动态」只看最近 N 条。 */
export const INBOX_AUTO_LIMIT = 30;

/** 批量动作白名单（路由层再校验一次，不允许由请求拼出方法名）。 */
export const INBOX_ACTIONS = Object.freeze(['promote', 'discard', 'restore', 'edit-promote']);

/** 单次批量最多处理多少条（防止被一个请求刷穿网关）。 */
export const INBOX_BATCH_MAX = 50;

/** 改写后文本的长度区间（人写的，比自动通道宽松，但仍要有下限和上限）。 */
export const INBOX_EDIT_MIN_CHARS = 4;
export const INBOX_EDIT_MAX_CHARS = 400;

/**
 * 把 `decideAutoPromotion` 的 `reason` 翻成人话。
 * @param {string} reason 拒绝原因
 * @param {{hits: number, minHits: number}} ctx 辅助信息
 * @returns {string} 一句话说明
 */
export function hintOfReason(reason, ctx = { hits: 1, minHits: 2 }) {
	const r = String(reason ?? '');
	if (r === 'mode-off') { return '自动提升已关闭：所有候选都在这里等你判断。'; }
	if (r === 'no-kind') { return '没有记录提取方式，无法自动判断。'; }
	if (r === 'summary-needs-human') { return '摘要由模型转述、体量大：永远需要人工判断。'; }
	if (r.startsWith('weak-kind:')) { return `「${r.slice('weak-kind:'.length)}」句式不进自动通道（曾误提过 skill 描述），建议你判断。`; }
	if (r === 'too-short') { return '太短，信息量不足以自动写入。'; }
	if (r === 'too-long') { return '太长，更像转述而不是一条约定。'; }
	if (r === 'sensitive') { return '疑似包含凭证类内容，不会自动写入。'; }
	if (r.startsWith('hits<')) {
		const need = Math.max(1, (Number(r.slice(5)) || ctx.minHits) - ctx.hits);
		return `只出现过 ${ctx.hits} 次；同一句再出现 ${need} 次，且 LLM 判定通过后会自动提升。`;
	}
	if (r === 'awaiting-judge') { return '结构门槛已满足；等下一回合的 LLM 判定（判定超时或失败时不会提升）。'; }
	if (r === 'judge-unavailable') { return 'LLM 判定没有给出结论，按 fail-closed 未提升。'; }
	return r || '未知原因';
}

/**
 * 一条草稿行的"为什么没被自动提升"。
 * @param {object} row 草稿行
 * @param {{mode?: string, minHits?: number}} cfg 自动提升配置
 * @returns {{why: string, hint: string, eligible: boolean}} 原因码 / 人话 / 结构上是否已达标
 */
export function whyNotPromoted(row, cfg = {}) {
	const verdict = decideAutoPromotion(row, { mode: cfg.mode, minHits: cfg.minHits, judgeOk: true });
	const hits = Number.isFinite(row?.hits) ? row.hits : 1;
	if (verdict.promote) {
		return { why: 'awaiting-judge', hint: hintOfReason('awaiting-judge'), eligible: true };
	}
	const minHits = String(row?.matched ?? '') === 'summary-fact'
		? Math.max(Number(cfg.minHits) || 2, SUMMARY_FACT_MIN_HITS)
		: (Number(cfg.minHits) || 2);
	return { why: verdict.reason, hint: hintOfReason(verdict.reason, { hits, minHits }), eligible: false };
}

/** 草稿行 → 页面行（只暴露页面要的字段 ⇒ 不把 digest 之类内部字段泄给前端）。 */
function viewOf(row, cfg) {
	const hits = Number.isFinite(row.hits) ? row.hits : 1;
	const base = {
		id: String(row.id ?? ''),
		text: String(row.text ?? ''),
		kind: String(row.matched ?? ''),
		hits,
		sessionId: String(row.sessionId ?? ''),
		turn: Number.isFinite(row.turn) ? row.turn : 0,
		at: Number.isFinite(row.at) ? row.at : 0,
		lastSeenAt: Number.isFinite(row.lastSeenAt) ? row.lastSeenAt : 0,
		updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
		status: String(row.status ?? 'draft'),
		promotedBy: typeof row.promotedBy === 'string' ? row.promotedBy : '',
		edited: row.edited === true,
	};
	return row.status === 'draft' ? { ...base, ...whyNotPromoted(row, cfg) } : base;
}

/**
 * 构造收件箱模型。
 *
 * 排序（借鉴 evolve 的"按热度"）：待审 = `hits` 降序 → 最近见到的优先；
 * 其余两组 = 最近处理的优先。
 *
 * @param {readonly object[]} rows 草稿行（`draftStore.read()`）
 * @param {{mode?: string, minHits?: number}} cfg 自动提升配置（`resolveAutoPromote` 的产物）
 * @returns {{pending: object[], autos: object[], done: object[], counts: object, reasons: Record<string, number>, truncated: boolean}} 视图模型
 */
export function buildInbox(rows, cfg = {}) {
	const list = Array.isArray(rows) ? rows : [];
	const recency = r => Math.max(Number(r.lastSeenAt) || 0, Number(r.at) || 0);
	const updated = r => Number(r.updatedAt) || Number(r.at) || 0;

	const pendingAll = list.filter(r => r.status === 'draft')
		.sort((a, b) => ((Number(b.hits) || 1) - (Number(a.hits) || 1)) || (recency(b) - recency(a)));
	const autosAll = list.filter(r => r.status === 'promoted' && r.promotedBy === 'auto-distill')
		.sort((a, b) => updated(b) - updated(a));
	const doneAll = list.filter(r => (r.status === 'promoted' && r.promotedBy !== 'auto-distill') || r.status === 'rejected')
		.sort((a, b) => updated(b) - updated(a));

	const pending = pendingAll.slice(0, INBOX_PENDING_LIMIT).map(r => viewOf(r, cfg));
	const reasons = {};
	for (const r of pending) {
		const key = String(r.why ?? '').split(':')[0];
		if (key) { reasons[key] = (reasons[key] ?? 0) + 1; }
	}
	return {
		pending,
		autos: autosAll.slice(0, INBOX_AUTO_LIMIT).map(r => viewOf(r, cfg)),
		done: doneAll.slice(0, INBOX_DONE_LIMIT).map(r => viewOf(r, cfg)),
		counts: { pending: pendingAll.length, autos: autosAll.length, done: doneAll.length },
		reasons,
		truncated: pendingAll.length > INBOX_PENDING_LIMIT,
	};
}

/**
 * 校验批量请求（纯函数；路由层先过这一关再碰草稿）。
 * @param {unknown} body 请求体（已 JSON.parse）
 * @returns {{ok: true, action: string, ids: string[], text: string} | {ok: false, error: string}} 校验结果
 */
export function parseInboxAction(body) {
	const b = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
	const action = typeof b.action === 'string' ? b.action : '';
	if (!INBOX_ACTIONS.includes(action)) { return { ok: false, error: `不认识的动作：${action || '(空)'}` }; }
	const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter(id => typeof id === 'string' && id))] : [];
	if (ids.length === 0) { return { ok: false, error: '缺少 ids' }; }
	if (ids.length > INBOX_BATCH_MAX) { return { ok: false, error: `一次最多 ${INBOX_BATCH_MAX} 条` }; }
	const text = typeof b.text === 'string' ? b.text.trim() : '';
	if (action === 'edit-promote') {
		if (ids.length !== 1) { return { ok: false, error: '改写后提升一次只能处理 1 条' }; }
		if (text.length < INBOX_EDIT_MIN_CHARS) { return { ok: false, error: `改写后的文本太短（至少 ${INBOX_EDIT_MIN_CHARS} 字）` }; }
		if (text.length > INBOX_EDIT_MAX_CHARS) { return { ok: false, error: `改写后的文本太长（最多 ${INBOX_EDIT_MAX_CHARS} 字）` }; }
	}
	return { ok: true, action, ids, text };
}

export { AUTO_PROMOTE_KINDS };
