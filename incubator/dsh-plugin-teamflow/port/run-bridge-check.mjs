/**
 * P1 · 状态机复用探针自测：验证 TeamFlow journal 阶段能直接落进本仓 workitem 账本，
 * 且「崩溃恢复 / 去重 / 退避 / 人工持有」全部复用真源，不复制第四套状态机。
 */
import { skipReasonOf, entryOf } from '../../../dsh-plugins/vssaros-workitem/lib/core/ledger.js';
import { syncJournalStages, recoverJournalStages, resumeKeysOf, stageKeyOf } from './bridge-ledger.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
	if (cond) { console.log(`  ✓ ${msg}`); pass += 1; }
	else { console.error(`  ✗ ${msg}`); fail += 1; }
};
const show = (v) => {
	const s = typeof v === 'string' ? v : JSON.stringify(v);
	return s.length > 90 ? `${s.slice(0, 90)}…` : s;
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（实际 ${show(a)}）`);

const NOW = Date.parse('2026-11-04T10:00:00Z');
const journal = {
	id: 'tf-p1',
	stages: [
		{ seq: 1, phase: 'prd', status: 'done', outcome: 'completed', childId: 'c1' },
		{ seq: 2, phase: 'tech', status: 'done', outcome: 'completed', childId: 'c2' },
		{ seq: 3, phase: 'dev', status: 'running', outcome: null, childId: 'c3' },
		{ seq: 4, phase: 'qa', status: 'pending', outcome: null },
		{ seq: 5, phase: 'acceptance', status: 'needs-human', outcome: '需要人工确认', childId: 'c5' },
	],
};
const keyDev = stageKeyOf(journal, journal.stages[2]);
const keyPrd = stageKeyOf(journal, journal.stages[0]);
const keyAcc = stageKeyOf(journal, journal.stages[4]);

console.log('── 1) 阶段投影 ──');
const first = syncJournalStages(journal, null, { nowMs: NOW });
eq(first.counts, { total: 4, done: 2, failed: 0, blocked: 1, running: 1 }, '5 阶段 → 4 条账本（pending 不建条目）');
eq(first.mapped.filter((x) => x.status === 'skipped').length, 1, 'pending 阶段跳过');
ok(entryOf(first.ledger, keyPrd).status === 'done' && entryOf(first.ledger, keyDev).status === 'running', 'done/running 状态正确');
ok(entryOf(first.ledger, keyAcc).status === 'blocked', 'needs-human → blocked（人工持有）');
ok(entryOf(first.ledger, keyPrd).marker.includes('[item:done]'), 'done marker 保留本仓完成契约');

console.log('── 2) 幂等（重复同步不得刷 attempts）──');
const second = syncJournalStages(journal, first.ledger, { nowMs: NOW });
eq(second.counts, first.counts, '计数不变');
eq(second.mapped.filter((x) => x.unchanged).length, 4, '4 条已有条目全部判为未变化');
eq(entryOf(second.ledger, keyDev).attempts, 0, 'running 阶段 attempts 仍为 0');
eq(JSON.stringify(second.ledger), JSON.stringify(first.ledger), '账本逐字不变');

console.log('── 3) 断点续跑判定复用本仓 skipReasonOf ──');
eq(skipReasonOf(entryOf(first.ledger, keyPrd), { maxAttempts: 2, retryBackoffS: 1800 }, NOW), 'ledger:done', 'done 永不再做');
ok(String(skipReasonOf(entryOf(first.ledger, keyAcc), { maxAttempts: 2, retryBackoffS: 1800 }, NOW)).includes('ledger:blocked'), 'blocked 等待人工回答');
eq(skipReasonOf(entryOf(first.ledger, keyDev), { maxAttempts: 2, retryBackoffS: 1800 }, NOW), null, 'running 不跳过');
eq(resumeKeysOf(journal, first.ledger, { maxAttempts: 2, retryBackoffS: 1800 }, NOW).filter((x) => x.skip === null).length, 2, '本轮可继续 2 项（running + 未登记的 pending）');

console.log('── 4) 崩溃恢复（对齐上游 loadJournals 的 interrupted 语义）──');
const recovered = recoverJournalStages(journal, null, NOW);
eq(recovered.recovered, [keyDev], '只归正残留 running 的那一条');
eq(entryOf(recovered.ledger, keyDev).status, 'failed', 'running → failed');
eq(entryOf(recovered.ledger, keyDev).attempts, 1, 'attempts +1');
ok(String(entryOf(recovered.ledger, keyDev).lastError).includes('interrupted'), 'lastError 记 interrupted');
eq(entryOf(recovered.ledger, keyPrd).status, 'done', '已完成阶段产物/状态保留');
const policy = { maxAttempts: 2, retryBackoffS: 1800 };
ok(String(skipReasonOf(entryOf(recovered.ledger, keyDev), policy, NOW)).includes('backoff'), '恢复后先退避，不立即补跑');
eq(skipReasonOf(entryOf(recovered.ledger, keyDev), policy, NOW + 2 * 3600_000), null, '退避到期后可重试');
ok(String(skipReasonOf(entryOf(recovered.ledger, keyDev), { maxAttempts: 1, retryBackoffS: 1800 }, NOW + 2 * 3600_000)).includes('attempts-exhausted'), 'attempts 耗尽不再跑');

console.log('── 5) 坏账本自愈 ──');
const broken = syncJournalStages(journal, 'not-a-ledger', { nowMs: NOW });
ok(broken.warning.length > 0, '坏文件如实告警');
eq(broken.counts.total, 4, '坏账本重建后阶段仍完整');

console.log(`\n[bridge] ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
