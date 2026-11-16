#!/usr/bin/env node
// 结果未知记账 / 按 callId 幂等（2026-11-11 收口）。
import assert from 'node:assert/strict';
import {
	createOutcomeLedger, callKeyOf, UNKNOWN_NOTICE, INFLIGHT_NOTICE, DUPLICATE_NOTICE,
} from '../lib/core/outcome.js';

const fails = [];
let passed = 0;
const check = (name, fn) => {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error.message}`); }
};

check('有 callId 时按 callId 归一键；参数不同也视为同一个调用', () => {
	assert.equal(callKeyOf({ callId: 'c1' }, { op: 'click', params: { x: 1 } }), 'call:c1');
	assert.equal(callKeyOf({ callId: 'c1' }, { op: 'typeText', params: { x: 2 } }), 'call:c1');
});

check('无 callId 退化成身份 + op + 参数指纹；参数变了就不是同一个调用', () => {
	const a = callKeyOf({}, { op: 'click', params: { x: 1 } }, 'bot', 's1');
	const b = callKeyOf({}, { op: 'click', params: { x: 2 } }, 'bot', 's1');
	assert.match(a, /^fp:/);
	assert.notEqual(a, b);
	assert.equal(a, callKeyOf({}, { op: 'click', params: { x: 1 } }, 'bot', 's1'));
});

check('在途调用拒绝重复注入', () => {
	const ledger = createOutcomeLedger();
	assert.deepEqual(ledger.begin('k'), { ok: true });
	assert.deepEqual(ledger.begin('k'), { ok: false, notice: INFLIGHT_NOTICE });
});

check('成功的 callId 复用缓存结果，不再打到中继', () => {
	const ledger = createOutcomeLedger();
	ledger.begin('k');
	ledger.settle('k', 'ok', { applied: true });
	const replay = ledger.begin('k');
	assert.equal(replay.ok, false);
	assert.equal(replay.notice, DUPLICATE_NOTICE);
	assert.deepEqual(replay.cached, { applied: true });
});

check('结果未知 ⇒ 换 callId 也禁止重放，直到一次成功观察', () => {
	const ledger = createOutcomeLedger();
	ledger.begin('k1');
	ledger.settle('k1', 'unknown');
	assert.equal(ledger.pending, true);
	assert.deepEqual(ledger.begin('k2'), { ok: false, notice: UNKNOWN_NOTICE });
	ledger.observe();
	assert.equal(ledger.pending, false);
	assert.deepEqual(ledger.begin('k2'), { ok: true });
});

check('明确被闸拒绝用 abort 清账，改参数后可重试', () => {
	const ledger = createOutcomeLedger();
	ledger.begin('k');
	ledger.abort('k');
	assert.deepEqual(ledger.begin('k'), { ok: true });
});

check('clear 清空账本与全局闸', () => {
	const ledger = createOutcomeLedger();
	ledger.begin('k');
	ledger.settle('k', 'unknown');
	assert.equal(ledger.size(), 1);
	ledger.clear();
	assert.equal(ledger.size(), 0);
	assert.equal(ledger.pending, false);
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
