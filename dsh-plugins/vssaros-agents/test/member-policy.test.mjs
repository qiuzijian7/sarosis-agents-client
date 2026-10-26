// @vssaros/dsh-agents — 成员级唤醒策略单测（2026-10-26）
//   跑法：node dsh-plugins/vssaros-agents/test/member-policy.test.mjs
//
// 为什么要单测："个人策略 > 群默认"这种回落链最容易在重构时悄悄反转，
// 而反转后的表现是"@ 了它却不理"或"全群被刷屏"，都很难靠肉眼发现。
import assert from 'node:assert/strict';
import {
	DISPATCH_MODES, dispatchModeOf, effectiveModeFor, GROUP_MODES, normalizeGroupMode,
} from '../lib/groups.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
	try { fn(); pass += 1; }
	catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); }
};

check('没有个人配置 ⇒ 继承群默认', () => {
	assert.equal(effectiveModeFor({ mode: 'mentions' }, 'coder'), 'mentions');
	assert.equal(effectiveModeFor({ mode: 'digest' }, 'coder'), 'digest');
});
check('★ 个人配置覆盖群默认（群 all，个人 silent）', () => {
	assert.equal(effectiveModeFor({ mode: 'all', wakePolicies: { coder: 'silent' } }, 'coder'), 'silent');
});
check('★ 个人配置覆盖群默认（群 mentions，个人 all）', () => {
	assert.equal(effectiveModeFor({ mode: 'mentions', wakePolicies: { coder: 'all' } }, 'coder'), 'all');
});
check('只影响配置过的那个人（同群其他人仍走群默认）', () => {
	const g = { mode: 'digest', wakePolicies: { a: 'silent' } };
	assert.equal(effectiveModeFor(g, 'a'), 'silent');
	assert.equal(effectiveModeFor(g, 'b'), 'digest');
});
check('个人配置是非法值 ⇒ 回落到群默认（不炸）', () => {
	assert.equal(effectiveModeFor({ mode: 'all', wakePolicies: { a: 'loud' } }, 'a'), 'all');
	assert.equal(effectiveModeFor({ mode: 'all', wakePolicies: { a: 42 } }, 'a'), 'all');
});
check('群 mode 缺省/旧值 ⇒ 走 normalizeGroupMode（open⇒all、admin⇒mentions）', () => {
	assert.equal(effectiveModeFor({}, 'a'), normalizeGroupMode(undefined));
	assert.equal(effectiveModeFor({ mode: 'open' }, 'a'), 'all');
	assert.equal(effectiveModeFor({ mode: 'admin' }, 'a'), 'mentions');
});
check('agentId 数字/字符串都能对上（id 口径统一成 String）', () => {
	assert.equal(effectiveModeFor({ mode: 'all', wakePolicies: { 7: 'silent' } }, 7), 'silent');
	assert.equal(effectiveModeFor({ mode: 'all', wakePolicies: { 7: 'silent' } }, '7'), 'silent');
});
check('空 group / 空 agentId 不抛错', () => {
	// ⚠ 默认档是 `mentions`（`normalizeGroupMode` 的口径），不是 all —— 别按直觉写死
	assert.equal(effectiveModeFor(undefined, 'x'), normalizeGroupMode(undefined));
	assert.equal(effectiveModeFor({ mode: 'digest' }, ''), 'digest');
});
check('返回值一定在四档里（否则上游 switch 会漏分支）', () => {
	for (const mode of ['all', 'mentions', 'digest', 'silent', 'open', 'admin', 'weird', undefined]) {
		const v = effectiveModeFor({ mode }, 'a');
		assert.ok(GROUP_MODES.includes(v), `${String(mode)} ⇒ ${v}`);
	}
});

/* ── 派发方式：steer（抢断）vs followup（排队）───────────────────────────
   语义来源是 dsh 的两个方法（见 `lib/tools.js` 的注释）：
     steer    —— 注入当前回合（"它在干活则下一 step 读到"）⇒ 会插进正在生成的回合里
     followup —— 等当前回合结束再作为新回合
   这里守的是"回落与别名"：写错/没配时必须是历史行为 steer，别悄悄变成排队。 */
check('派发方式缺省 ⇒ steer（与改动前一致，不惊扰存量群）', () => {
	assert.equal(dispatchModeOf({}), 'steer');
	assert.equal(dispatchModeOf({ dispatchMode: '' }), 'steer');
	assert.equal(dispatchModeOf(undefined), 'steer');
});
check('★ `turn` 是 followup 的别名（照 DeepSeekBot 的叫法写也能用）', () => {
	assert.equal(dispatchModeOf({ dispatchMode: 'turn' }), 'followup');
	assert.equal(dispatchModeOf({ dispatchMode: 'TURN' }), 'followup');
});
check('显式 followup / steer 原样返回', () => {
	assert.equal(dispatchModeOf({ dispatchMode: 'followup' }), 'followup');
	assert.equal(dispatchModeOf({ dispatchMode: 'steer' }), 'steer');
});
check('★ 非法值 ⇒ steer（绝不静默变成排队，否则"发不出去"很难查）', () => {
	assert.equal(dispatchModeOf({ dispatchMode: 'queue' }), 'steer');
	assert.equal(dispatchModeOf({ dispatchMode: 123 }), 'steer');
});
check('返回值一定在两档里', () => {
	for (const v of ['steer', 'followup', 'turn', '', 'x', undefined, null, 0]) {
		assert.ok(DISPATCH_MODES.includes(dispatchModeOf({ dispatchMode: v })), String(v));
	}
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 成员策略单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
