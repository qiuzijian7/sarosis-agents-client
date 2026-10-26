// @vssaros/dsh-agents — 群内接力闸门单测（2026-10-26）
//   跑法：node dsh-plugins/vssaros-agents/test/relay-policy.test.mjs
//
// 为什么要单测：接力是**放大器**。闸门写错的后果不是"功能不好用"，而是
//   ① A↔B 无限对答（消息永远刷不完）  ② 一条回复叫醒全群（bill 直接爆）
//   这两种在真机上表现为"页面一直跳"，很难现场调试 ⇒ 必须在纯函数层钉死。
import assert from 'node:assert/strict';
import {
	planRelay, relayOf, RELAY_MAX_HOPS, RELAY_MAX_PER_ROOT,
} from '../lib/groups.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
	try { fn(); pass += 1; }
	catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); }
};

const AGENTS = [
	{ id: 'alpha', name: 'Alpha' },
	{ id: 'beta', name: 'Beta' },
	{ id: 'gamma', name: 'Gamma' },
	{ id: 'outsider', name: 'Outsider' },   // 不在群里
];
const MEMBERS = ['alpha', 'beta', 'gamma'];
const GROUP_ON = { id: 'g1', members: MEMBERS, relay: { enabled: true } };
const base = { members: MEMBERS, agents: AGENTS, hop: 1, rootId: 'root-1', log: [] };

/* ── relayOf：缺省关闭 + 阈值收敛 ─────────────────────────────────────── */
check('缺省 = 关闭（不惊扰存量群）', () => {
	assert.equal(relayOf({}).enabled, false);
	assert.equal(relayOf(undefined).enabled, false);
	assert.equal(relayOf({ relay: {} }).enabled, false);
});
check('阈值收敛到安全区间（手改成 999 也压回 8）', () => {
	assert.equal(relayOf({ relay: { maxHops: 999 } }).maxHops, 8);
	assert.equal(relayOf({ relay: { maxHops: 0 } }).maxHops, 1);
	assert.equal(relayOf({ relay: { maxPerRoot: 999 } }).maxPerRoot, 20);
	assert.equal(relayOf({}).maxHops, RELAY_MAX_HOPS);
	assert.equal(relayOf({}).maxPerRoot, RELAY_MAX_PER_ROOT);
});

/* ── 基本闸门 ───────────────────────────────────────────────────────── */
check('★ 未开启 ⇒ 一条都不派（reason=relay-off）', () => {
	const r = planRelay({ ...base, group: { members: MEMBERS }, replyText: '@beta 你看下' });
	assert.deepEqual(r.targets, []);
	assert.equal(r.reason, 'relay-off');
});
check('回复里没有 @ ⇒ 不派（no-mention）', () => {
	const r = planRelay({ ...base, group: GROUP_ON, replyText: '我觉得可以' });
	assert.deepEqual(r.targets, []);
	assert.equal(r.reason, 'no-mention');
});
check('★ 正常接力：@ 到同群成员 ⇒ 派给他，hop+1', () => {
	const r = planRelay({ ...base, group: GROUP_ON, replyText: '@beta 帮忙补一下' });
	assert.deepEqual(r.targets.map((a) => a.id), ['beta']);
	assert.equal(r.reason, 'ok');
	assert.equal(r.nextHop, 2);
});
check('@ 到不在群里的人 ⇒ 不派（不在成员表里）', () => {
	const r = planRelay({ ...base, group: GROUP_ON, replyText: '@outsider 你来' });
	assert.deepEqual(r.targets, []);
	assert.equal(r.reason, 'no-mention');
});

/* ── 闸门 ② 根事件去重（最关键）────────────────────────────────────── */
check('★ 同一个根消息已经叫醒过 beta ⇒ 再 @ 也不重复派（防 A↔B 死循环）', () => {
	const r = planRelay({
		...base, group: GROUP_ON, replyText: '@beta 再来一次',
		log: [{ rootId: 'root-1', agentId: 'beta', at: Date.now() }],
	});
	assert.deepEqual(r.targets, []);
	assert.equal(r.reason, 'all-deduped');
});
check('★ 不同根消息则互不影响（新消息可以再叫醒同一个 bot）', () => {
	const r = planRelay({
		...base, rootId: 'root-2', group: GROUP_ON, replyText: '@beta 新话题',
		log: [{ rootId: 'root-1', agentId: 'beta', at: Date.now() }],
	});
	assert.deepEqual(r.targets.map((a) => a.id), ['beta']);
});
check('同时 @ 两个，其中一个已叫醒 ⇒ 只派没叫醒的那个', () => {
	const r = planRelay({
		...base, group: GROUP_ON, replyText: '@beta @gamma 一起看',
		log: [{ rootId: 'root-1', agentId: 'beta', at: Date.now() }],
	});
	assert.deepEqual(r.targets.map((a) => a.id), ['gamma']);
});

/* ── 闸门 ① hop / ③ 单根上限 ──────────────────────────────────────── */
check('★ hop 到上限 ⇒ 停（nextHop > maxHops）', () => {
	const r = planRelay({ ...base, hop: RELAY_MAX_HOPS, group: GROUP_ON, replyText: '@beta 继续' });
	assert.deepEqual(r.targets, []);
	assert.equal(r.reason, 'hop-limit');
});
check('hop 未到上限 ⇒ 继续', () => {
	const r = planRelay({ ...base, hop: RELAY_MAX_HOPS - 1, group: GROUP_ON, replyText: '@beta 继续' });
	assert.deepEqual(r.targets.map((a) => a.id), ['beta']);
	assert.equal(r.nextHop, RELAY_MAX_HOPS);
});
check('★ 单根事件派发次数到上限 ⇒ 停（限制扇出宽度）', () => {
	const log = Array.from({ length: RELAY_MAX_PER_ROOT }, (_, i) => ({
		rootId: 'root-1', agentId: 'x' + i, at: Date.now(),
	}));
	const r = planRelay({ ...base, group: GROUP_ON, replyText: '@beta 再来', log });
	assert.deepEqual(r.targets, []);
	assert.equal(r.reason, 'root-cap');
});
check('★ @所有人 在接力里**不生效**（否则一条回复能叫醒全群）', () => {
	const r = planRelay({ ...base, group: GROUP_ON, replyText: '@所有人 都来看' });
	assert.deepEqual(r.targets, [], '接力不认 @所有人');
});
check('没有 rootId ⇒ 不派（没法去重就不能放行）', () => {
	const r = planRelay({ ...base, rootId: '', group: GROUP_ON, replyText: '@beta 看' });
	assert.deepEqual(r.targets, []);
	assert.equal(r.reason, 'no-root');
});

/* ── 边界：@test 不该命中 test1 ─────────────────────────────────────── */
check('★ 词尾边界：@alpha 不命中 alpha2（避免唤醒错人）', () => {
	const agents = [...AGENTS, { id: 'alpha2', name: 'Alpha Two' }];
	// ⚠ `members` 必须一起扩（planRelay 会按成员表过滤）—— 我第一次漏了这个，白红一条
	const members = [...MEMBERS, 'alpha2'];
	const r = planRelay({
		...base, members, group: { members, relay: { enabled: true } },
		agents, replyText: '@alpha2 你看',
	});
	assert.deepEqual(r.targets.map((a) => a.id), ['alpha2'], '应只命中 alpha2，不是 alpha');
});

/* ── 汇总 ──────────────────────────────────────────────────────────── */
const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 接力闸门单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
