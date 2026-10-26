// @vssaros/dsh-agents — 群主权限单测（2026-10-26）
//   跑法：node dsh-plugins/vssaros-agents/test/owner-policy.test.mjs
//
// 为什么单测：权限判定写反的代价是**双向**的 ——
//   写松了：任何 bot 都能删别人的群；写紧了：人自己都改不了群设置。
//   两种都不容易在界面上发现（一个是"没人报错"，一个是"点了没反应"）。
import assert from 'node:assert/strict';
import { groupMutableDenial, normalizeActor } from '../lib/groups.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
	try { fn(); pass += 1; }
	catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); }
};

/* ── normalizeActor ──────────────────────────────────────────────────── */
check('缺省 actor ⇒ 人（HTTP 调用都是人）', () => {
	assert.deepEqual(normalizeActor(undefined), { kind: 'human' });
	assert.deepEqual(normalizeActor(null), { kind: 'human' });
	assert.deepEqual(normalizeActor({}), { kind: 'human' });
});
check('bot actor 保留 agentId（并 trim）', () => {
	assert.deepEqual(normalizeActor({ kind: 'bot', agentId: ' coder ' }), { kind: 'bot', agentId: 'coder' });
});
check('未知 kind ⇒ 当作人（宁可放过人，也不要误判成 bot 把人挡在外面）', () => {
	assert.deepEqual(normalizeActor({ kind: 'robot' }), { kind: 'human' });
	assert.deepEqual(normalizeActor({ kind: 'HUMAN' }), { kind: 'human' });
});

/* ── groupMutableDenial ──────────────────────────────────────────────── */
check('★ 没设群主 ⇒ 不设限（存量群行为不变，bot 也能改）', () => {
	assert.equal(groupMutableDenial({}, { kind: 'bot', agentId: 'coder' }), null);
	assert.equal(groupMutableDenial({ ownerAgentId: '' }, { kind: 'bot', agentId: 'coder' }), null);
});
check('★ 有群主时：人始终可以', () => {
	assert.equal(groupMutableDenial({ ownerAgentId: 'coder' }, { kind: 'human' }), null);
	assert.equal(groupMutableDenial({ ownerAgentId: 'coder' }, undefined), null);
});
check('★ 有群主时：群主本人可以', () => {
	assert.equal(groupMutableDenial({ ownerAgentId: 'coder' }, { kind: 'bot', agentId: 'coder' }), null);
});
check('★ 有群主时：别的 bot 不行（返回原因，含群主 id）', () => {
	const why = groupMutableDenial({ ownerAgentId: 'coder' }, { kind: 'bot', agentId: 'architect' });
	assert.ok(typeof why === 'string' && why.includes('coder'), String(why));
	assert.ok(why.includes('architect'), '原因里应写清当前调用方，便于排查');
});
check('★ 未署名 bot 也被挡（不能靠"不写 agentId"绕过）', () => {
	const why = groupMutableDenial({ ownerAgentId: 'coder' }, { kind: 'bot' });
	assert.ok(typeof why === 'string' && why.length > 0, String(why));
});
check('群主 id 带空白也能对上（存储/比较都 trim）', () => {
	assert.equal(groupMutableDenial({ ownerAgentId: ' coder ' }, { kind: 'bot', agentId: 'coder' }), null);
});

/* ── 汇总 ──────────────────────────────────────────────────────────── */
const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 群主权限单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
