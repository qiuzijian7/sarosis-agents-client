// @vssaros/dsh-agents — 群聊写口的幂等 / 陈旧防护（2026-10-31，P2）
//   跑法：node dsh-plugins/vssaros-agents/test/group-ops.test.mjs
//
// 这一层的价值：建群 / 拉人**重复提交**不会执行两次（Bot 重试、双击、页面重发都会遇到）。
// 判定全是纯函数 ⇒ 单测不碰文件系统；`withIdempotency` 那几条用真临时目录跑一遍端到端。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPS_FILE_NAME, payloadFingerprint, planIdempotent, staleDenial, withIdempotency } from '../lib/core/groupOps.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

/* ── 指纹 ── */
check('指纹：键顺序无关（{a,b} 与 {b,a} 同值）',
	() => assert.equal(payloadFingerprint({ a: 1, b: 2 }), payloadFingerprint({ b: 2, a: 1 })));
check('指纹：值变 ⇒ 指纹变', () => assert.notEqual(payloadFingerprint({ a: 1 }), payloadFingerprint({ a: 2 })));
check('指纹：null / undefined 安全', () => assert.equal(payloadFingerprint(null), payloadFingerprint(undefined)));

/* ── 判定（纯） ── */
check('没给 operationKey ⇒ run（向后兼容）',
	() => assert.equal(planIdempotent({ payload: { a: 1 }, records: [] }).kind, 'run'));
check('台账里没有 ⇒ run',
	() => assert.equal(planIdempotent({ key: 'k1', payload: { a: 1 }, records: [] }).kind, 'run'));
check('★ 同 key 同参数 ⇒ replay（带回当时的结果）', () => {
	const fp = payloadFingerprint({ a: 1 });
	const p = planIdempotent({ key: 'k1', payload: { a: 1 }, records: [{ key: 'k1', fingerprint: fp, result: { id: 'g1' } }] });
	assert.equal(p.kind, 'replay');
	assert.deepEqual(p.result, { id: 'g1' });
});
check('★★ 同 key 换参数 ⇒ conflict（绝不静默覆盖）', () => {
	const p = planIdempotent({ key: 'k1', payload: { a: 2 }, records: [{ key: 'k1', fingerprint: payloadFingerprint({ a: 1 }) }] });
	assert.equal(p.kind, 'conflict');
});

/* ── 陈旧判定（纯） ── */
check('不传 expectedUpdatedAt ⇒ 不校验', () => assert.equal(staleDenial({ updatedAt: 5 }, undefined), null));
check('updatedAt 一致 ⇒ 放行', () => assert.equal(staleDenial({ updatedAt: 5 }, 5), null));
check('★ 期间被改过 ⇒ 拒绝（带新旧值，便于重试）', () => {
	const d = staleDenial({ updatedAt: 9 }, 5);
	assert.ok(d && d.includes('9') && d.includes('5'), String(d));
});
check('非数字 ⇒ 拒绝（不静默当成"不校验"）', () => assert.ok(staleDenial({ updatedAt: 1 }, 'abc')));

/* ── withIdempotency（真文件） ── */
const root = mkdtempSync(join(tmpdir(), 'vssaros-groupops-'));
const config = { dataRoot: root };
let calls = 0;
const run = async () => { calls += 1; return { id: 'g' + calls, n: calls }; };

await checkAsync('★ 同 key 第二次 ⇒ 回放，run 只跑一次', async () => {
	calls = 0;
	const a = await withIdempotency(config, { operationKey: 'op-1', payload: { x: 1 } }, run);
	const b = await withIdempotency(config, { operationKey: 'op-1', payload: { x: 1 } }, run);
	assert.equal(a.replayed, false);
	assert.equal(b.replayed, true);
	assert.deepEqual(b.result, a.result);
	assert.equal(calls, 1);
});
await checkAsync('换一个 key ⇒ 真的再跑一次', async () => {
	const c = await withIdempotency(config, { operationKey: 'op-2', payload: { x: 1 } }, run);
	assert.equal(c.replayed, false);
	assert.equal(calls, 2);
});
await checkAsync('★ 同 key 换参数 ⇒ 抛 409（不覆盖、不重跑）', async () => {
	const before = calls;
	await assert.rejects(
		() => withIdempotency(config, { operationKey: 'op-1', payload: { x: 999 } }, run),
		(e) => e.httpStatus === 409,
	);
	assert.equal(calls, before);
});
await checkAsync('不传 key ⇒ 每次都跑（老调用方不受影响）', async () => {
	const before = calls;
	await withIdempotency(config, { payload: { x: 1 } }, run);
	await withIdempotency(config, { payload: { x: 1 } }, run);
	assert.equal(calls, before + 2);
});
await checkAsync('台账落盘在 <数据根>/agent-group-ops.json', async () => {
	const ops = JSON.parse(readFileSync(join(root, OPS_FILE_NAME), 'utf8'));
	assert.ok(Array.isArray(ops.ops) && ops.ops.length >= 2, JSON.stringify(ops).slice(0, 80));
});

try { rmSync(root, { recursive: true, force: true, maxRetries: 2 }); } catch { /* tmp 自清 */ }

console.log(`\n[group-ops] ${pass} passing / ${fails.length} failing`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
process.exit(fails.length === 0 ? 0 : 1);
