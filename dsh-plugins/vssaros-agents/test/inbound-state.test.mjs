// @vssaros/dsh-agents — 入站「上次是否在跑」的持久化单测（2026-10-29）
//   跑法：node dsh-plugins/vssaros-agents/test/inbound-state.test.mjs
//
// 为什么要单测：这段代码只在"重启 Host"时起作用，而那是最难手动复现的场景
//   （2026-10-29 真机：点了启动、重启后又静默回到未启动 ⇒ "飞书发消息永远没反应"）。
//   四个边界写错任何一个，症状都是"重启后又不工作了"，而且没有任何报错。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	INBOUND_PLATFORMS, inboundStatePathOf, readInboundEnabled, setInboundEnabled,
} from '../lib/imInboundState.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const fresh = () => mkdtempSync(join(tmpdir(), 'vssaros-inb-'));

await checkAsync('★ 缺文件 ⇒ 全 false（不猜、不默认连）', async () => {
	const root = fresh();
	const got = await readInboundEnabled({ dataRoot: root });
	for (const p of INBOUND_PLATFORMS) { assert.equal(got[p], false, p + ' 必须默认 false'); }
	rmSync(root, { recursive: true, force: true });
});

await checkAsync('★ 打开 feishu ⇒ 落盘，其它平台仍是 false', async () => {
	const root = fresh();
	const config = { dataRoot: root };
	const after = await setInboundEnabled(config, 'feishu', true);
	assert.equal(after.feishu, true);
	assert.equal(after.telegram, false);
	assert.equal(after.discord, false);
	const onDisk = JSON.parse(readFileSync(inboundStatePathOf(config), 'utf8'));
	assert.equal(onDisk.enabled.feishu, true);
	const reread = await readInboundEnabled(config);
	assert.equal(reread.feishu, true, '重新读回来必须一致（否则重启后恢复不了）');
	rmSync(root, { recursive: true, force: true });
});

await checkAsync('★ 关掉一个平台不影响另一个（逐个平台独立）', async () => {
	const root = fresh();
	const config = { dataRoot: root };
	await setInboundEnabled(config, 'feishu', true);
	await setInboundEnabled(config, 'telegram', true);
	await setInboundEnabled(config, 'feishu', false);
	const got = await readInboundEnabled(config);
	assert.equal(got.feishu, false);
	assert.equal(got.telegram, true, '关 feishu 不能把 telegram 一起关掉');
	rmSync(root, { recursive: true, force: true });
});

await checkAsync('★ 没有入站网关的平台（wecom）⇒ 不记、也不改别人的值', async () => {
	const root = fresh();
	const config = { dataRoot: root };
	await setInboundEnabled(config, 'feishu', true);
	const after = await setInboundEnabled(config, 'wecom', true);
	assert.equal(after.feishu, true);
	assert.equal(after.wecom, undefined, 'wecom 是被动回调，不该出现在状态里');
	rmSync(root, { recursive: true, force: true });
});

await checkAsync('★ 坏 JSON ⇒ 全 false（不能因为文件被写坏就起不来）', async () => {
	const root = fresh();
	const config = { dataRoot: root };
	writeFileSync(inboundStatePathOf(config), 'not-json', 'utf8');
	const got = await readInboundEnabled(config);
	for (const p of INBOUND_PLATFORMS) { assert.equal(got[p], false); }
	rmSync(root, { recursive: true, force: true });
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 入站状态持久化单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
