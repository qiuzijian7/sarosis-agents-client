// @vssaros/dsh-agents — 群级会话绑定：纯函数单测（2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/group-session.test.mjs
//
// 为什么要单测：绑定决定"这条群消息进哪条会话"。写错的后果是**静默串上下文**——
//   用户在 A 群说的话跑到 B 群的会话里（或者反过来，A 群的历史被私聊污染），
//   界面上完全看不出来，只有当事人发现"它怎么知道那件事"才会暴露。
import assert from 'node:assert/strict';
import { boundSessionOf, withMemberSession } from '../lib/groups.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
	try { fn(); pass += 1; }
	catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); }
};

/* ── boundSessionOf ──────────────────────────────────────────────────── */
check('没有绑定 ⇒ 空串（调用方据此回落"最近活跃"）', () => {
	assert.equal(boundSessionOf({}, 'coder'), '');
	assert.equal(boundSessionOf({ memberSessions: {} }, 'coder'), '');
	assert.equal(boundSessionOf(undefined, 'coder'), '');
	assert.equal(boundSessionOf({ memberSessions: { coder: '   ' } }, 'coder'), '');
});
check('有绑定 ⇒ 返回（并 trim）', () => {
	assert.equal(boundSessionOf({ memberSessions: { coder: ' sess-1 ' } }, 'coder'), 'sess-1');
});
check('只认自己的键（别人绑的不串）', () => {
	const g = { memberSessions: { coder: 'sess-c' } };
	assert.equal(boundSessionOf(g, 'architect'), '');
	assert.equal(boundSessionOf(g, 'coder'), 'sess-c');
});
check('id 类型不敏感（数字/字符串都能对上）', () => {
	assert.equal(boundSessionOf({ memberSessions: { 7: 'sess-7' } }, '7'), 'sess-7');
});

/* ── withMemberSession（纯函数：不改入参）────────────────────────────── */
check('★ 新增绑定：返回新对象，**不改入参**', () => {
	const cur = { coder: 'sess-1' };
	const next = withMemberSession(cur, 'architect', 'sess-2');
	assert.deepEqual(next, { coder: 'sess-1', architect: 'sess-2' });
	assert.deepEqual(cur, { coder: 'sess-1' }, '入参必须原样不动（纯函数）');
});
check('覆盖已有绑定', () => {
	assert.deepEqual(withMemberSession({ coder: 'old' }, 'coder', 'new'), { coder: 'new' });
});
check('★ 传空 ⇒ 删掉该成员（其余保留）', () => {
	assert.deepEqual(withMemberSession({ coder: 'x', architect: 'y' }, 'coder', ''), { architect: 'y' });
	assert.deepEqual(withMemberSession({ coder: ' x ' }, 'coder', '  '), undefined);
});
check('★ 删空 ⇒ 返回 undefined（不落空对象进数据文件）', () => {
	assert.equal(withMemberSession({ coder: 'x' }, 'coder', ''), undefined);
	assert.equal(withMemberSession(undefined, 'coder', ''), undefined);
});
check('空 agentId ⇒ 原样返回（防御性：不误删别人的绑定）', () => {
	assert.deepEqual(withMemberSession({ coder: 'x' }, '', 'sess-9'), { coder: 'x' });
	assert.equal(withMemberSession({}, '', 'sess-9'), undefined);
});
check('从 undefined 起步也能建', () => {
	assert.deepEqual(withMemberSession(undefined, 'coder', 'sess-1'), { coder: 'sess-1' });
});
check('★ 往返一致：withMemberSession 建好的，boundSessionOf 读得回', () => {
	const g = { memberSessions: withMemberSession(undefined, 'coder', 'sess-abc') };
	assert.equal(boundSessionOf(g, 'coder'), 'sess-abc');
});

/* ── 汇总 ──────────────────────────────────────────────────────────── */
const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 群会话绑定单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
