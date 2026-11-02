// healthInfo.test.mjs — 网关 /health 附加信息（2026-11-02，记忆工作台 v2 · P3）
//
// 钉住：
//  ① 备份文件名解析：只数符合命名的、按时间新→旧、无关文件不算
//  ② 版本行：缺失/损坏 ⇒ null（= 从未迁移），不抛
//  ③ schema.state 的四种状态（current / behind / ahead / unknown）
//  ④ lastSweepAt：0/负数/非数 ⇒ null（"没跑过"和"值为 0"分得清）
//  ⑤ 接线守卫：/health 必须调用 buildHealthExtras、且附加项失败不能拖垮健康检查、
//     sweep 完成后必须记时间（否则状态条永远显示"没跑过"）

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildHealthExtras, parseBackupStamp, parseSchemaRow, summarizeBackups } from '../host/healthInfo.mjs';

const B = (v, stamp) => `state_store.v${v}.${stamp}.bak.db`;

test('① 备份汇总：只数符合命名的，新→旧，无关文件不算', () => {
	const out = summarizeBackups([
		B(0, '2026-11-02T03-08-29-101Z'),
		B(1, '2026-11-03T10-00-00-000Z'),
		'state_store.db', 'notes.txt', 'state_store.v1.bad-stamp.bak.db',
	]);
	assert.equal(out.count, 2, '命名不符合的不能算备份');
	assert.equal(out.latest, B(1, '2026-11-03T10-00-00-000Z'));
	assert.equal(out.latestAt, '2026-11-03T10:00:00.000Z');
	assert.deepEqual(summarizeBackups([]), { count: 0, latest: null, latestAt: null });
	assert.deepEqual(summarizeBackups(undefined), { count: 0, latest: null, latestAt: null }, '读不到目录时传 undefined 也不能抛');
});

test('① 时间戳解析：冒号和点被换成短横的格式能还原；非法格式 ⇒ null', () => {
	assert.equal(parseBackupStamp('2026-11-02T03-08-29-101Z'), '2026-11-02T03:08:29.101Z');
	assert.equal(parseBackupStamp('2026-13-45T99-99-99-999Z'), null, '数值非法');
	assert.equal(parseBackupStamp('nope'), null);
	assert.equal(parseBackupStamp(undefined), null);
});

test('② 版本行：缺失/损坏 ⇒ null，不抛', () => {
	assert.equal(parseSchemaRow(null), null);
	assert.equal(parseSchemaRow(''), null);
	assert.equal(parseSchemaRow('{坏 json'), null);
	assert.equal(parseSchemaRow(JSON.stringify({ version: -1 })), null);
	assert.equal(parseSchemaRow(JSON.stringify({ version: 'x' })), null);
	const ok = parseSchemaRow(JSON.stringify({ version: 1, migratedAt: '2026-11-02T03:08:29.000Z', applied: ['1:strength-scale-unify(189)'] }));
	assert.deepEqual(ok, { version: 1, migratedAt: '2026-11-02T03:08:29.000Z', applied: ['1:strength-scale-unify(189)'] });
});

test('③ schema.state 四种状态', () => {
	const mk = (schemaRaw, expectedVersion) => buildHealthExtras({ schemaRaw, expectedVersion }).schema;
	assert.equal(mk(JSON.stringify({ version: 1 }), 1).state, 'current');
	assert.equal(mk(null, 1).state, 'behind', '没有版本行 = v0，落后于期望的 v1 ⇒ 迁移没跑成');
	assert.equal(mk(JSON.stringify({ version: 2 }), 1).state, 'ahead', '库比进程新 ⇒ 不降级、状态条要提示');
	assert.equal(mk(JSON.stringify({ version: 1 }), undefined).state, 'unknown');
	assert.equal(mk(JSON.stringify({ version: 1 }), 1).expected, 1);
});

test('④ lastSweepAt：0 / 负数 / 非数 ⇒ null', () => {
	const at = v => buildHealthExtras({ lastSweepAt: v }).lastSweepAt;
	assert.equal(at(0), null);
	assert.equal(at(-5), null);
	assert.equal(at(NaN), null);
	assert.equal(at('x'), null);
	assert.equal(at(1730000000000), 1730000000000);
});

test('⑤ ★ 接线守卫：/health 调用 buildHealthExtras、附加项失败兜底、sweep 完成记时间', async () => {
	const src = await readFile(new URL('../host/host.mjs', import.meta.url), 'utf8');
	const at = src.indexOf("url.pathname === '/health'");
	assert.ok(at > 0, '找不到 /health 处理器（守卫需同步更新）');
	const block = src.slice(at, at + 1400);
	assert.match(block, /buildHealthExtras\(/, '/health 必须调用 buildHealthExtras');
	assert.match(block, /catch \{ extras = \{\}; \}/, '附加项失败必须兜底为空，不能拖垮 /health');
	assert.match(block, /status: 'ok', dataDir, port, engine: backendKind/, '原有字段不得被改动（旧客户端依赖）');
	assert.match(src, /lastSweepAt = Date\.now\(\);/, 'sweep 一轮跑完后必须记录时间');
	const sweepAt = src.indexOf('lastSweepAt = Date.now();');
	const finallyAt = src.indexOf('} finally {', sweepAt);
	const loopAt = src.lastIndexOf('for (const scope of tick)', sweepAt);
	assert.ok(loopAt > 0 && loopAt < sweepAt && sweepAt < finallyAt, '记录必须在 for 循环之后、finally 之前（跑完才记）');
});
