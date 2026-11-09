#!/usr/bin/env node
// P1：应用授权三态 / 租约 / 完整执行闸 / 审批 fail-closed。
import assert from 'node:assert/strict';
import {
	GRANT_ALWAYS, GRANT_DENY, GRANT_ONCE, appKeyOf, applyGrant, grantOf, listGrants, revokeGrant,
} from '../lib/core/grants.js';
import { LeaseTable } from '../lib/core/leases.js';
import { preGate, requestConsent } from '../lib/core/gates.js';
import { defaultState } from '../lib/core/levels.js';
import { BACKGROUND_OPS, OBSERVE_OPS, createToolDefinition, gateContextOf } from '../lib/index.js';

const fails = [];
let passed = 0;
const checkAsync = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error?.message ?? error}`); }
};

const state0 = () => defaultState();
const execOf = (id = 'river', sessionId = 's1') => ({ agent: { id }, sessionId });
const fakeRelay = () => ({ calls: [], async command(op, params) { this.calls.push({ op, params }); return { dispatched: true }; }, dispose() {} });

await checkAsync('appKeyOf 规范化路径/大小写/尾斜杠', async () => {
	assert.equal(appKeyOf('C:\\Program Files\\Notepad\\Notepad.exe'), 'notepad.exe');
	assert.equal(appKeyOf('/Applications/Notes.app/'), 'notes.app');
	assert.equal(appKeyOf('  Notes  '), 'notes');
	assert.equal(appKeyOf(''), '');
});

await checkAsync('授权三态：一直允许按 Bot、这一次按会话、拒绝按会话；撤销清干净', async () => {
	const state = state0();
	assert.equal(grantOf(state, 'river', 'Notes', 's1'), null);
	applyGrant(state, 'river', 'Notes', GRANT_ALWAYS, 's1');
	assert.equal(grantOf(state, 'river', 'Notes', 's999'), GRANT_ALWAYS);
	assert.equal(grantOf(state, 'chief', 'Notes', 's1'), null, 'grant 不跨 Bot');
	assert.equal(listGrants(state, 'river').length, 1);

	const other = state0();
	applyGrant(other, 'river', 'Notes', GRANT_ONCE, 's1');
	assert.equal(grantOf(other, 'river', 'Notes', 's1'), GRANT_ONCE);
	assert.equal(grantOf(other, 'river', 'Notes', 's2'), null, 'once 不跨会话');
	applyGrant(other, 'river', 'Notes', GRANT_DENY, 's1');
	assert.equal(grantOf(other, 'river', 'Notes', 's1'), GRANT_DENY);

	revokeGrant(state, 'river', 'Notes');
	assert.equal(grantOf(state, 'river', 'Notes', 's1'), null);
	assert.equal(listGrants(state, 'river').length, 0);
});

await checkAsync('租约：同应用互斥、同 Bot 可重入、releaseOwner 全放、空闲自动回收', async () => {
	let now = 1000;
	const leases = new LeaseTable({ idleMs: 60_000, now: () => now });
	assert.equal(leases.acquire('app:notes', 'river').ok, true);
	assert.equal(leases.acquire('app:notes', 'river').ok, true);
	const blocked = leases.acquire('app:notes', 'chief');
	assert.equal(blocked.ok, false);
	assert.equal(blocked.holder, 'river');
	assert.equal(leases.acquire('app:mail', 'chief').ok, true, '不同应用可并行');
	assert.equal(leases.releaseOwner('river'), 1);
	assert.equal(leases.acquire('app:notes', 'chief').ok, true);
	now += 60_001;
	assert.equal(leases.acquire('app:notes', 'river').ok, true, '空闲后自动释放');
	leases.clear();
	assert.equal(leases.size, 0);
});

await checkAsync('preGate：默认只读拒一切动作；background 有 appKey 进入审批、没给则拒', async () => {
	const leases = new LeaseTable();
	assert.equal(preGate({ op: 'click', level: 'view', appKey: 'notes', state: state0(), botId: 'r', leases }).ok, false);
	const withApp = preGate({ op: 'click', level: 'background', appKey: 'notes', state: state0(), botId: 'r', leases, allowBackground: true });
	assert.equal(withApp.ok, true);
	assert.equal(withApp.needsApproval, true);
	leases.clear();
	const noApp = preGate({ op: 'click', level: 'background', state: state0(), botId: 'r', leases, allowBackground: true });
	assert.equal(noApp.ok, false);
	assert.match(noApp.message, /appKey/);
});

await checkAsync('★ 受保护应用：连用户都不能授权，且不占租约、不问审批', async () => {
	const leases = new LeaseTable();
	const state = state0();
	applyGrant(state, 'river', 'VsSaros', GRANT_ALWAYS, 's1');
	const gate = preGate({ op: 'click', level: 'background', appKey: 'VsSaros', state, botId: 'river', leases, allowBackground: true });
	assert.equal(gate.ok, false);
	assert.match(gate.message, /受保护应用/);
	assert.equal(leases.size, 0);
});

await checkAsync('preGate：未授权 needsApproval；always/once 免问；deny 拒；租约冲突拒', async () => {
	const leases = new LeaseTable();
	const common = { op: 'click', level: 'background', appKey: 'notes', botId: 'river', sessionId: 's1', leases, allowBackground: true };
	const pending = preGate({ ...common, state: state0() });
	assert.equal(pending.needsApproval, true);
	assert.equal(leases.size, 1, '先占租约再问，避免两 Bot 同时拿授权');

	const always = state0(); applyGrant(always, 'river', 'notes', GRANT_ALWAYS, 's1');
	assert.equal(preGate({ ...common, state: always }).needsApproval, undefined);
	const once = state0(); applyGrant(once, 'river', 'notes', GRANT_ONCE, 's1');
	assert.equal(preGate({ ...common, state: once }).needsApproval, undefined);
	const denied = state0(); applyGrant(denied, 'river', 'notes', GRANT_DENY, 's1');
	assert.match(preGate({ ...common, state: denied }).message, /已拒绝/);

	leases.clear();
	leases.acquire('app:notes', 'chief');
	const conflict = preGate({ ...common, state: state0() });
	assert.equal(conflict.ok, false);
	assert.match(conflict.message, /chief 正在使用/);
});

await checkAsync('requestConsent：无服务 / 非 allowed-once / 抛错一律 deny', async () => {
	assert.equal(await requestConsent({ approval: undefined, appKey: 'notes', action: 'click' }), GRANT_DENY);
	assert.equal(await requestConsent({ approval: { request: async () => 'allowed-once' }, appKey: 'n', action: 'c' }), GRANT_ONCE);
	for (const outcome of ['rejected', 'cancelled', 'unavailable', undefined]) {
		assert.equal(await requestConsent({ approval: { request: async () => outcome }, appKey: 'n', action: 'c' }), GRANT_DENY);
	}
	assert.equal(await requestConsent({ approval: { request: async () => { throw new Error('x'); } }, appKey: 'n', action: 'c' }), GRANT_DENY);
});

const toolFor = (overrides = {}) => {
	const state = overrides.state ?? state0();
	const leases = overrides.leases ?? new LeaseTable();
	const approval = Object.hasOwn(overrides, 'approval')
		? overrides.approval
		: { request: async () => 'allowed-once' };
	const relay = overrides.relay ?? fakeRelay();
	const changes = { count: 0 };
	const def = createToolDefinition({
		relay, state, leases, approval,
		level: overrides.level ?? 'background',
		allowBackground: overrides.allowBackground ?? true,
		onStateChange: () => { changes.count++; },
	});
	return { def, state, leases, approval, relay, changes };
};

await checkAsync('★ 端到端：未授权 → 审批 allowed-once → 记 once → 执行成功且有活动行', async () => {
	const { def, state, relay, changes } = toolFor();
	const out = await def.execute({ op: 'click', appKey: 'Notes', params: { x: 10, y: 20 } }, execOf());
	assert.match(out, /【活动】river · click · notes/);
	assert.match(out, /dispatched/);
	assert.equal(relay.calls.length, 1);
	assert.equal(grantOf(state, 'river', 'notes', 's1'), GRANT_ONCE);
	assert.equal(changes.count, 1, '授权要落盘');
	// 同一会话第二次不再问
	const out2 = await def.execute({ op: 'click', appKey: 'Notes' }, execOf());
	assert.equal(changes.count, 1, '不应重复写状态');
	assert.equal(relay.calls.length, 2);
	assert.match(out2, /【活动】/);
});

await checkAsync('★ 审批拒绝 / 无审批服务 ⇒ 不打到中继、释放租约（fail-closed）', async () => {
	for (const approval of [{ request: async () => 'rejected' }, undefined]) {
		const leases = new LeaseTable();
		const relay = fakeRelay();
		const { def } = toolFor({ approval, leases, relay });
		const out = await def.execute({ op: 'click', appKey: 'Notes' }, execOf());
		assert.match(out, /未授权/);
		assert.equal(relay.calls.length, 0);
		assert.equal(leases.size, 0, '被拒后要放开租约');
	}
});

await checkAsync('★ 两 Bot 抢同一应用被拒；受保护应用不问审批也不执行', async () => {
	const leases = new LeaseTable();
	const relay = fakeRelay();
	const { def } = toolFor({ leases, relay });
	await def.execute({ op: 'click', appKey: 'Notes' }, execOf('river', 's1'));
	const denied = await def.execute({ op: 'click', appKey: 'Notes' }, execOf('chief', 's2'));
	assert.match(denied, /正在使用|被拒绝/);
	const protectedOut = await def.execute({ op: 'click', appKey: 'VsSaros' }, execOf('river', 's1'));
	assert.match(protectedOut, /受保护应用/);
	assert.equal(relay.calls.length, 1, '只有第一次真正执行');
});

await checkAsync('默认配置（allowBackground=false）仍是纯 P0 行为：op enum 只有 9 个只读', async () => {
	const def = createToolDefinition({ relay: fakeRelay(), state: state0(), level: 'view' });
	assert.deepEqual(def.parameters.properties.op.enum, OBSERVE_OPS);
	assert.equal(def.isConcurrencySafe({ op: 'screenshot' }), true);
	assert.equal(def.isConcurrencySafe({ op: 'click' }), false);
	assert.match(await def.execute({ op: 'click', appKey: 'notes' }, execOf()), /P0 只读层不开放/);
	assert.ok(BACKGROUND_OPS.length > 0);
});

await checkAsync('pre-execute 与 execute 共用 gateContextOf（判据不会漂移）', async () => {
	const settings = { state: state0(), level: 'background', allowBackground: true, leases: new LeaseTable() };
	const exec = execOf('river', 's1');
	const context = gateContextOf(settings, exec, { op: 'click', appKey: 'Notes' });
	assert.equal(context.botId, 'river');
	assert.equal(context.sessionId, 's1');
	assert.equal(context.level, 'background');
	assert.equal(context.appKey, 'Notes');
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
