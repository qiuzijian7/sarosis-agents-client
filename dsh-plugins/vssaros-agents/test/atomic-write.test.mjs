// @vssaros/dsh-agents — 原子替换的退避重试（2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/atomic-write.test.mjs
//
// 为什么单独测：Windows 上 `rename` 会因目标被杀软/索引器短暂持有而抛 EPERM/EBUSY，
//   裸 rename 让整次写入失败 —— `dead-letters` 的「有界 FIFO」单测就是这样偶发红的
//   （连跑 8 次里 1~2 次）。
//
// 三条判据：
//   ① 可恢复错误（EPERM/EBUSY/EACCES）**重试**后成功
//   ② 不可恢复错误（ENOENT 等）**立刻**抛（不把真实故障拖 385ms 才暴露）
//   ③ 用尽退避仍失败 ⇒ 抛最后一次错误（不吞）
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RENAME_BACKOFF_MS, RENAME_RETRYABLE_CODES, renameWithRetry } from '../lib/atomicWrite.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const errWith = (code) => Object.assign(new Error(code), { code });

check('可恢复错误清单就是那三类（不要随手扩大）', () => {
	assert.deepEqual([...RENAME_RETRYABLE_CODES].sort(), ['EACCES', 'EBUSY', 'EPERM']);
	assert.ok(RENAME_BACKOFF_MS.length >= 3);
});

await checkAsync('★ EPERM 两次后成功 ⇒ 重试生效（不抛）', async () => {
	let calls = 0;
	const impl = async () => {
		calls += 1;
		if (calls <= 2) { throw errWith('EPERM'); }
		return undefined;
	};
	const ok = await renameWithRetry('a', 'b', { renameImpl: impl, delays: [1, 1, 1] });
	assert.equal(ok, true);
	assert.equal(calls, 3);
});

await checkAsync('★ EBUSY / EACCES 同样重试', async () => {
	for (const code of ['EBUSY', 'EACCES']) {
		let calls = 0;
		const impl = async () => { calls += 1; if (calls === 1) { throw errWith(code); } };
		await renameWithRetry('a', 'b', { renameImpl: impl, delays: [1] });
		assert.equal(calls, 2, code + ' 应该重试一次');
	}
});

await checkAsync('★ 不可恢复错误（ENOENT）立刻抛，只调一次', async () => {
	let calls = 0;
	const impl = async () => { calls += 1; throw errWith('ENOENT'); };
	await assert.rejects(
		() => renameWithRetry('a', 'b', { renameImpl: impl, delays: [1, 1, 1] }),
		(e) => e.code === 'ENOENT',
	);
	assert.equal(calls, 1, 'ENOENT 不该重试');
});

await checkAsync('★ 一直 EPERM ⇒ 用尽退避后抛（不吞）', async () => {
	let calls = 0;
	const impl = async () => { calls += 1; throw errWith('EPERM'); };
	await assert.rejects(
		() => renameWithRetry('a', 'b', { renameImpl: impl, delays: [1, 1] }),
		(e) => e.code === 'EPERM',
	);
	assert.equal(calls, 3, '1 次首试 + 2 次重试');
});

await checkAsync('真实 rename：tmp 覆盖目标后内容正确、tmp 消失', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-atomic-'));
	try {
		const target = join(dir, 'state.json');
		const tmp = join(dir, 'state.json.tmp');
		writeFileSync(target, '{"old":true}', 'utf8');
		writeFileSync(tmp, '{"new":true}', 'utf8');
		const ok = await renameWithRetry(tmp, target);
		assert.equal(ok, true);
		assert.equal(readFileSync(target, 'utf8'), '{"new":true}');
		assert.equal(existsSync(tmp), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 原子写重试单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
