/*---------------------------------------------------------------------------------------------
 *  writeScope.test.mjs — **写分区按 preset 映射**（★ 2026-10-26，用户要求）
 *
 * ## 需求
 * 「没有选择 agent 时，可以根据 preset 选择的模式进行映射」
 * ⇒ 会话选中了 preset（`vssaros-<id>`）就把记忆写进**该人设的 agent 分区**；
 *   没选中（或组合型 `vssaros-standard`）才退回工作区分区 `ws-<workspaceId>`。
 *
 * ## 为什么必须这样
 * dsh 侧的会话 / 观测 / 检索**都落在纯 agent 分区**（`saros-claw` / `default` / …）；
 * 而历史实现把写入落在 `ws-<workspaceId>` ⇒ **写 A 读 B** ⇒
 * 实测 `ws-*` 四层恒 0、人设分区有数千条 ⇒ 用户看到"聊了半天什么都没记住" ✗✗
 *
 * ## 本测试钉住
 *  ① `personaIdFromPreset`：`vssaros-<id>` ⇒ `<id>`；`-assign` 派生版归回本体；`vssaros-standard` ⇒ 空
 *  ② `writePartitionOf`：**人设优先**；没人设 ⇒ 退回工作区分区（不乱猜）
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { personaIdFromPreset, writePartitionOf } from '../lib/core/memory.js';

const results = [];
const check = (name, fn) => {
	try { const d = fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};

check('① preset ⇒ 人设 id（vssaros-<id> ⇒ <id>）', () => {
	assert.equal(personaIdFromPreset('vssaros-saros-claw'), 'saros-claw');
	assert.equal(personaIdFromPreset('vssaros-knowledge-base-expert'), 'knowledge-base-expert');
	return 'ok';
});

check('①b 委派派生版 -assign 归回本体（同一个人设）', () => {
	assert.equal(personaIdFromPreset('vssaros-coder-assign'), 'coder',
		'委派派生版不能自成一个分区（否则同一人设被拆成两处 ✗）');
	return 'ok';
});

check('①c 组合型 / 非 vssaros 前缀 ⇒ 空（不是人设）', () => {
	assert.equal(personaIdFromPreset('vssaros-standard'), '', '标准组合不是人设');
	assert.equal(personaIdFromPreset('some-other-preset'), '');
	assert.equal(personaIdFromPreset(undefined), '');
	assert.equal(personaIdFromPreset(''), '');
	return 'ok';
});

check('② 写分区：有人设 ⇒ **人设分区**（与读同一处）', () => {
	assert.equal(writePartitionOf('ws-proj-abc', 'saros-claw'), 'saros-claw');
	return 'ok';
});

check('②b 写分区：没人设 ⇒ 退回工作区分区（保持原行为，不乱猜）', () => {
	assert.equal(writePartitionOf('ws-proj-abc', ''), 'ws-proj-abc');
	assert.equal(writePartitionOf('ws-proj-abc', undefined), 'ws-proj-abc');
	assert.equal(writePartitionOf('ws-proj-abc', '   '), 'ws-proj-abc');
	return 'ok';
});

check('②c 端到端串起来：preset ⇒ 人设 ⇒ 写分区（用户要的那条链路）', () => {
	const preset = 'vssaros-coder-assign';
	const persona = personaIdFromPreset(preset);
	assert.equal(writePartitionOf('ws-proj-abc', persona), 'coder',
		'preset=vssaros-coder-assign ⇒ 人设 coder ⇒ 写分区必须是 coder（不是 ws-*）');
	return 'ok';
});

const failed = results.filter(r => !r.ok);
for (const r of results) { console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); }
console.log('');
if (failed.length) { console.error(`✗ 写分区映射测试失败：${failed.length}/${results.length}`); process.exit(1); }
console.log(`✓ 写分区按 preset 映射测试通过（${results.length} 项）`);
