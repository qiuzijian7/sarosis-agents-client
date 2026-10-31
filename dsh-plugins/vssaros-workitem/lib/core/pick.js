// 真源：挑活（picking）与完成契约（completion contract）。纯函数、零 I/O。
//
// 两种驱动共用同一份判据：
//   · loop —— rows 来自 `harvest.command`，key 由 `identityFields` 派生；
//   · 群聊 —— rows 来自消息里的 `#task:` 标签，key 就是标签本身。
// 差别只在"key 怎么来"，所以 `keyOf` 由调用方注入，内核不认识任何一方的数据结构 ✓。

import { skipReasonOf } from './ledger.js';

/**
 * 从候选行里挑出这一轮要做的 item。
 *
 * 返回 `excluded` 而不是静默丢弃 —— 干跑（loop）与"为什么没派"（群聊）的价值全在这张表上。
 * 顺序：先按账本去重/退避，再截 `maxItemsPerRound`；被截掉的如实标 `round-cap`。
 */
export function pickItems({ rows, keyOf, ledger, policy = {}, nowMs = Date.now() }) {
	const picked = [];
	const excluded = [];
	const list = Array.isArray(rows) ? rows : [];
	if (!Array.isArray(rows)) {
		excluded.push({ key: '(rows)', reason: '候选不是数组' });
	}
	const maxItems = Number(policy?.maxItemsPerRound ?? 3);
	for (const row of list) {
		const key = typeof keyOf === 'function' ? keyOf(row) : null;
		if (!key || typeof key !== 'string') {
			excluded.push({ key: '(row)', reason: 'no-identity（拿不到稳定的 key）' });
			continue;
		}
		const skip = skipReasonOf(ledger?.items?.[key] ?? null, policy, nowMs);
		if (skip) {
			excluded.push({ key, reason: skip });
			continue;
		}
		if (picked.length >= maxItems) {
			excluded.push({ key, reason: `round-cap（本轮上限 ${maxItems}）` });
			continue;
		}
		picked.push({ key, row });
	}
	return { picked, excluded, total: list.length };
}

/**
 * 解析完成标记（末行契约）。
 *
 * 与 `[plan:ready]` 是**不同命名空间** —— 两个解析器永远不会读到对方的信号。
 * 契约：`[item:done]` / `[item:failed:<原因>]` / `[item:blocked:<原因>]`
 */
export function parseItemMarker(raw) {
	const input = typeof raw === 'string' ? raw : '';
	const m = /\[item:(done|failed|blocked)(?::([^\]]*))?\]/i.exec(input);
	if (!m) {
		return { found: false, status: '', reason: '' };
	}
	return {
		found: true,
		status: m[1].toLowerCase(),
		reason: (m[2] ?? '').trim(),
		marker: m[0],
	};
}

/**
 * 把一次执行结果折算成账本终态。
 *
 * `onMissingMarker='failed'`（默认）的意义：模型没按契约签字就**不算成功** —— 反过来把
 * "没签字"当成功，是无人值守里最常见的假绿。
 */
export function outcomeOf({ finalText, stopReason, completion }) {
	const marker = parseItemMarker(finalText);
	if (marker.found) {
		return { status: marker.status, reason: marker.reason, marker: marker.marker };
	}
	if (stopReason && stopReason !== 'completed') {
		return { status: 'failed', reason: `stopReason=${stopReason}`, marker: '' };
	}
	if (completion?.requireMarker === false || completion?.onMissingMarker === 'done') {
		return { status: 'done', reason: '', marker: '' };
	}
	return { status: 'failed', reason: 'missing [item:...] marker', marker: '' };
}
