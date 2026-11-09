#!/usr/bin/env node
// P2：人机接管 / 交接状态机、前台租约、工具面展开。
import assert from 'node:assert/strict';
import {
	CONTROL_OPS, DesktopHandoffs, HANDOFF_BACK_TEXT, HANDOFF_REASONS,
	isControlOp, validateHandoffReason,
} from '../lib/core/handoff.js';
import { preGate } from '../lib/core/gates.js';
import { LeaseTable } from '../lib/core/leases.js';
import { defaultState } from '../lib/core/levels.js';
import { BACKGROUND_OPS, FOREGROUND_OPS, OBSERVE_OPS, createToolDefinition } from '../lib/index.js';

const fails = [];
let passed = 0;
const checkAsync = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error?.message ?? error}`); }
};

const execOf = (id = 'river', sessionId = 's1') => ({ agent: { id }, sessionId });
const fakeRelay = () => ({ calls: [], async command(op, params) { this.calls.push({ op, params }); return { dispatched: true }; }, dispose() {} });

const toolFor = (overrides = {}) => {
	const leases = overrides.leases ?? new LeaseTable();
	const handoffs = overrides.handoffs ?? new DesktopHandoffs();
	const relay = overrides.relay ?? fakeRelay();
	const def = createToolDefinition({
		relay, state: defaultState(), leases, handoffs,
		level: 'foreground', allowBackground: true, allowForeground: true, allowHandoff: true,
		approval: { request: async () => 'allowed-once' },
	});
	return { def, leases, handoffs, relay };
};

await checkAsync('状态机：takeover 阻塞 → handback 回 idle 且给「重新观察」followup', async () => {
	const h = new DesktopHandoffs();
	assert.equal(h.stateOf('s1'), 'idle');
	assert.equal(h.isBlocked('s1'), false);
	h.takeover('s1');
	assert.equal(h.stateOf('s1'), 'user');
	assert.equal(h.isBlocked('s1'), true);
	assert.match(h.blockReason('s1'), /用户正在操作/);
	const back = h.handback('s1');
	assert.equal(back.state, 'idle');
	assert.equal(back.text, HANDOFF_BACK_TEXT);
	assert.equal(h.resume('s1'), HANDOFF_BACK_TEXT);
	assert.equal(h.resume('s1'), '没有待读取的交接结果。');
	h.reset('s1');
	assert.equal(h.size, 0);
});

await checkAsync('状态机：Bot 交接开卡 → pending 阻塞 → 用户 skip/done/takeover 三种回答', async () => {
	const h = new DesktopHandoffs();
	const opened = h.open({ sessionId: 's1', reason: 'payment', note: '请付款', url: 'https://x' });
	assert.equal(opened.state, 'pending');
	assert.equal(opened.card.reason, 'payment');
	assert.match(h.blockReason('s1'), /待处理的交接卡/);
	assert.equal(h.cardOf('s1').note, '请付款');
	assert.equal(h.answer({ sessionId: 's1', action: 'skip' }).ok, true);
	assert.match(h.resume('s1'), /跳过/);

	h.open({ sessionId: 's1', reason: 'login' });
	assert.match(h.answer({ sessionId: 's1', action: 'done', note: '已登录' }).text, /已登录/);

	h.open({ sessionId: 's1', reason: 'captcha' });
	assert.equal(h.answer({ sessionId: 's1', action: 'takeover' }).ok, true);
	assert.equal(h.stateOf('s1'), 'user');
	assert.equal(h.answer({ sessionId: 's1', action: 'skip' }).ok, false, '没有卡时不能凭空回答');
});

await checkAsync('状态机：未知原因归一为 other；控制 op 判定只认四个名字', async () => {
	assert.deepEqual(HANDOFF_REASONS, ['login', 'payment', 'captcha', 'confirm', 'other']);
	assert.equal(validateHandoffReason('nope'), 'other');
	assert.equal(validateHandoffReason('login'), 'login');
	assert.deepEqual(CONTROL_OPS, ['takeover', 'handback', 'handoff', 'resume']);
	for (const op of CONTROL_OPS) assert.equal(isControlOp(op), true);
	assert.equal(isControlOp('click'), false);
});

await checkAsync('preGate：接管中 / 待交接卡时连只读都被暂停', async () => {
	const handoffs = new DesktopHandoffs();
	handoffs.takeover('s1');
	const common = { state: defaultState(), botId: 'river', sessionId: 's1', leases: new LeaseTable(), allowBackground: true, handoffs };
	assert.match(preGate({ ...common, op: 'screenshot', level: 'view' }).message, /用户正在操作/);
	assert.match(preGate({ ...common, op: 'click', level: 'background', appKey: 'notes' }).message, /用户正在操作/);
	handoffs.handback('s1');
	assert.equal(preGate({ ...common, op: 'screenshot', level: 'view' }).ok, true);
});

await checkAsync('前台租约：同一时间只有一个 Bot 能动可见指针', async () => {
	const leases = new LeaseTable();
	const common = { state: defaultState(), sessionId: 's1', leases, allowBackground: true, level: 'foreground', appKey: 'notes' };
	assert.equal(preGate({ ...common, op: 'movePointer', botId: 'river' }).ok, true);
	// 换一个应用，避免先撞上「应用租约」，才能真正测到前台租约。
	const blocked = preGate({ ...common, op: 'movePointer', botId: 'chief', appKey: 'mail' });
	assert.equal(blocked.ok, false);
	assert.match(blocked.message, /正在使用前台/);
	assert.equal(preGate({ ...common, op: 'click', botId: 'river' }).ok, true, '同 Bot 可重入');
});

await checkAsync('★ 端到端：handoff → 动作被拒 → 用户 done → resume → 动作恢复', async () => {
	const { def, handoffs, relay } = toolFor();
	const opened = await def.execute({ op: 'handoff', reason: 'login', note: '请扫码' }, execOf());
	assert.match(opened, /已把「login」交给用户/);
	assert.equal(handoffs.stateOf('s1'), 'pending');
	const blocked = await def.execute({ op: 'click', appKey: 'Notes' }, execOf());
	assert.match(blocked, /交接卡/);
	assert.equal(relay.calls.length, 0);
	handoffs.answer({ sessionId: 's1', action: 'done', note: '已登录' });
	const resumed = await def.execute({ op: 'resume' }, execOf());
	assert.match(resumed, /已登录/);
	const ok = await def.execute({ op: 'click', appKey: 'Notes' }, execOf());
	assert.match(ok, /【活动】/);
	assert.equal(relay.calls.length, 1);
});

await checkAsync('★ 端到端：takeover 后全拒（控制 op 仍可交还），handback 后恢复', async () => {
	const { def, handoffs, leases, relay } = toolFor();
	await def.execute({ op: 'click', appKey: 'Notes' }, execOf());
	const taken = await def.execute({ op: 'takeover' }, execOf());
	assert.match(taken, /交给用户/);
	assert.equal(leases.size, 0, '接管要放开该 Bot 的全部租约');
	const denied = await def.execute({ op: 'screenshot' }, execOf());
	assert.match(denied, /用户正在操作/);
	assert.equal(relay.calls.length, 1);
	const back = await def.execute({ op: 'handback' }, execOf());
	assert.match(back, /重新观察/);
	assert.equal(handoffs.stateOf('s1'), 'idle');
	const ok = await def.execute({ op: 'screenshot' }, execOf());
	assert.doesNotMatch(ok, /用户正在操作|电脑操控被拒绝/);
	assert.equal(relay.calls.length, 2);
});

await checkAsync('工具 op 面按三个开关逐级展开；默认仍只有 9 个只读 op', async () => {
	const base = { relay: fakeRelay(), state: defaultState() };
	assert.deepEqual(createToolDefinition({ ...base, level: 'view' }).parameters.properties.op.enum, OBSERVE_OPS);
	const bg = createToolDefinition({ ...base, level: 'background', allowBackground: true })
		.parameters.properties.op.enum;
	assert.equal(bg.length, OBSERVE_OPS.length + BACKGROUND_OPS.length);
	const full = createToolDefinition({
		...base, level: 'foreground', allowBackground: true, allowForeground: true,
		allowHandoff: true, handoffs: new DesktopHandoffs(),
	}).parameters.properties.op.enum;
	assert.equal(full.length, OBSERVE_OPS.length + BACKGROUND_OPS.length + FOREGROUND_OPS.length + CONTROL_OPS.length);
	const def = createToolDefinition({ ...base, level: 'view' });
	assert.match(await def.execute({ op: 'takeover' }, execOf()), /未启用/);
});

await checkAsync('pre-execute 与 execute 对控制 op 的处理一致（不会被自己的闸挡住）', async () => {
	const { def } = toolFor();
	assert.equal(def.isConcurrencySafe({ op: 'takeover' }), false);
	assert.equal(def.isConcurrencySafe({ op: 'screenshot' }), true);
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
