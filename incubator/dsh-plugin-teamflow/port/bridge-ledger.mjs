/**
 * P1 · 状态机复用探针：TeamFlow `journal.stages` → 本仓 `vssaros-workitem` 账本。
 *
 * ⚠ 边界：这是 incubator 内的**语义验证**，用相对路径直接 import 本仓真源。
 *    P2 接 seam 时必须改成 cordis 服务 `vssarosWorkItems` —— 插件之间在 profile 里
 *    没有跨包解析路径（见 vssaros-workitem/lib/core/ledger.js 头注释），这个相对 import
 *    绝不能被带进 dsh-plugins/。
 *
 * 语义对照：
 *   上游 loadJournals()   : 残留 running → interrupted（保留已完成阶段产物）
 *   本仓 recoverOnStart() : 残留 running → failed + attempts+1 + 退避（不补跑）
 * 两者都「崩溃后不直接重跑、由策略决定何时再跑」，用词不同但行为同构。
 */
import {
	createLedger, normalizeLedger, entryOf, markRunning, markDone, markFailed,
	markBlocked, recoverOnStart, skipReasonOf, summarizeLedger,
} from '../../../dsh-plugins/vssaros-workitem/lib/core/ledger.js';

export const STATUS_MAP = Object.freeze({
	done: 'done',
	running: 'running',
	interrupted: 'failed',
	failed: 'failed',
	blocked: 'blocked',
	'needs-human': 'blocked',
});

/** 阶段身份：run 内稳定；不用 title（上游实锤 title 会因任务合并漂移）。 */
export const stageKeyOf = (journal, stage) => `${journal.id}:${stage.seq}:${stage.phase}`;

/** marker 保持本仓 `[item:*]` 完成契约，附加可读性签名用于幂等判重。 */
function markerOf(target, stage) {
	if (target === 'running') return '';
	const tail = `tf:${stage.phase}:${String(stage.outcome ?? stage.status ?? '')}`;
	if (target === 'done') return `[item:done] ${tail}`;
	if (target === 'failed') return `[item:failed:tf] ${tail}`;
	return `[item:blocked] ${tail}`;
}

/**
 * 把 journal 的阶段投影到账本。重复调用必须幂等：状态 + marker 都一致时跳过写入，
 * 否则每次同步都会给 failed 阶段 +1 attempts（直接撞穿 maxAttempts）。
 */
export function syncJournalStages(journal, raw = null, { nowMs = Date.now(), source = 'teamflow' } = {}) {
	const { ledger, warning } = raw ? normalizeLedger(raw) : { ledger: createLedger(), warning: '' };
	const mapped = [];
	for (const stage of journal.stages ?? []) {
		const key = stageKeyOf(journal, stage);
		const target = STATUS_MAP[stage.status];
		if (!target) { mapped.push({ key, status: 'skipped' }); continue; }
		const marker = markerOf(target, stage);
		const prev = entryOf(ledger, key);
		if (prev && prev.status === target && prev.marker === marker) {
			mapped.push({ key, status: target, unchanged: true });
			continue;
		}
		const meta = {
			sessionId: typeof stage.childId === 'string' ? stage.childId : '',
			source,
			marker,
			reason: String(stage.outcome ?? stage.status ?? ''),
		};
		if (target === 'done') markDone(ledger, key, meta, nowMs);
		else if (target === 'running') markRunning(ledger, key, { ...meta, marker: '' }, nowMs);
		else if (target === 'blocked') markBlocked(ledger, key, meta, nowMs);
		else markFailed(ledger, key, meta, nowMs);
		mapped.push({ key, status: target });
	}
	return { ledger, warning, mapped, counts: summarizeLedger(ledger) };
}

/** 崩溃恢复：先按磁盘账本投影，再归正残留 running（顺序反了会互相抵消）。 */
export function recoverJournalStages(journal, raw = null, nowMs = Date.now()) {
	const synced = syncJournalStages(journal, raw, { nowMs });
	const recovered = recoverOnStart(synced.ledger, nowMs);
	return { ...synced, recovered, counts: summarizeLedger(synced.ledger) };
}

/** 断点续跑：逐阶段问本仓账本「该不该跳过」，不另写一套判定。 */
export function resumeKeysOf(journal, ledger, policy = {}, nowMs = Date.now()) {
	return (journal.stages ?? []).map((stage) => {
		const key = stageKeyOf(journal, stage);
		return { key, phase: stage.phase, status: stage.status, skip: skipReasonOf(entryOf(ledger, key), policy, nowMs) };
	});
}
