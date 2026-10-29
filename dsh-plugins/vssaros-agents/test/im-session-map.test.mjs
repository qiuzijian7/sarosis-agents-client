// @vssaros/dsh-agents — 「一条 IM 绑定 ⇄ 一条 dsh 会话」映射单测（2026-10-29）
//   跑法：node dsh-plugins/vssaros-agents/test/im-session-map.test.mjs
//
// 为什么单测：这张表决定"同一绑定是否复用同一条会话"。写成每次覆盖/每次清空，
//   症状就是真机那样 —— 飞书里能聊，但会话列表里不断长出「(未命名会话)」。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	clearImSession, getImSession, imSessionsPathOf, setImSession,
} from '../lib/imSessionMap.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const fresh = () => mkdtempSync(join(tmpdir(), 'vssaros-imses-'));

await checkAsync('★ 没记过 ⇒ 空串（不猜、不默认复用别的会话）', async () => {
	const root = fresh();
	assert.equal(await getImSession({ dataRoot: root }, 'b1'), '');
	rmSync(root, { recursive: true, force: true });
});

await checkAsync('★ 记住后读得回来（落盘，重启也在）', async () => {
	const root = fresh();
	const cfg = { dataRoot: root };
	await setImSession(cfg, 'b1', 'session-aaa');
	assert.equal(await getImSession(cfg, 'b1'), 'session-aaa');
	const onDisk = JSON.parse(readFileSync(imSessionsPathOf(cfg), 'utf8'));
	assert.equal(onDisk.map.b1, 'session-aaa');
	rmSync(root, { recursive: true, force: true });
});

await checkAsync('★ 两个绑定互不影响（键是 bindingId，不是 agentId）', async () => {
	const root = fresh();
	const cfg = { dataRoot: root };
	await setImSession(cfg, 'b1', 's1');
	await setImSession(cfg, 'b2', 's2');
	assert.equal(await getImSession(cfg, 'b1'), 's1');
	assert.equal(await getImSession(cfg, 'b2'), 's2');
	rmSync(root, { recursive: true, force: true });
});

await checkAsync('★ 覆盖写（会话失效后重建）', async () => {
	const root = fresh();
	const cfg = { dataRoot: root };
	await setImSession(cfg, 'b1', 's1');
	await setImSession(cfg, 'b1', 's2');
	assert.equal(await getImSession(cfg, 'b1'), 's2');
	rmSync(root, { recursive: true, force: true });
});

await checkAsync('★ clear 只删指定的那条', async () => {
	const root = fresh();
	const cfg = { dataRoot: root };
	await setImSession(cfg, 'b1', 's1');
	await setImSession(cfg, 'b2', 's2');
	assert.equal((await clearImSession(cfg, 'b1')).removed, 1);
	assert.equal(await getImSession(cfg, 'b1'), '');
	assert.equal(await getImSession(cfg, 'b2'), 's2');
	rmSync(root, { recursive: true, force: true });
});

await checkAsync('★ 空参数不写脏数据', async () => {
	const root = fresh();
	const cfg = { dataRoot: root };
	assert.deepEqual(await setImSession(cfg, '', 's1'), { ok: false });
	assert.deepEqual(await setImSession(cfg, 'b1', ''), { ok: false });
	assert.equal(await getImSession(cfg, 'b1'), '');
	rmSync(root, { recursive: true, force: true });
});

await checkAsync('★ 坏 JSON ⇒ 空表（最多重建一条会话，不该因此起不来）', async () => {
	const root = fresh();
	const cfg = { dataRoot: root };
	writeFileSync(imSessionsPathOf(cfg), 'not-json', 'utf8');
	assert.equal(await getImSession(cfg, 'b1'), '');
	rmSync(root, { recursive: true, force: true });
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ IM 会话映射单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
