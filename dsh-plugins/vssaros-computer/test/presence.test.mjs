#!/usr/bin/env node
// P2：托盘 / 浮动指示器的状态上报、紧急停止闸、接管状态回显。
import assert from 'node:assert/strict';
import { DesktopHandoffs } from '../lib/core/handoff.js';
import { LeaseTable } from '../lib/core/leases.js';
import { defaultState } from '../lib/core/levels.js';
import { DEFAULTS, createToolDefinition } from '../lib/index.js';

const fails = [];
let passed = 0;
const checkAsync = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error?.message ?? error}`); }
};

const execOf = () => ({ agent: { id: 'river' }, sessionId: 's1' });
const fakeRelay = () => ({
	calls: [],
	async command(op, params) { this.calls.push({ op, params }); return { dispatched: true }; },
	dispose() {},
});
const fakePresence = (overrides = {}) => ({
	reports: [], stoppedValue: false,
	async stopped() { return this.stoppedValue; },
	async report(patch) { this.reports.push(patch); },
	...overrides,
});
const toolFor = (presence, relay = fakeRelay()) => ({
	relay,
	def: createToolDefinition({
		relay, state: defaultState(), leases: new LeaseTable(),
		handoffs: new DesktopHandoffs(), level: 'foreground',
		allowBackground: true, allowForeground: true, allowHandoff: true,
		approval: { request: async () => 'allowed-once' },
		presence,
	}),
});

await checkAsync('默认配置：presenceEnabled 关闭 ⇒ 不上报、不多一次网络往返', async () => {
	assert.equal(DEFAULTS.presenceEnabled, false);
	const { def, relay } = toolFor(undefined);
	await def.execute({ op: 'click', appKey: 'Notes' }, execOf());
	assert.equal(relay.calls.length, 1, '只应有实际动作那一次调用');
});

await checkAsync('★ 动作执行前后各上报一次（active true → false），带 botId / appKey', async () => {
	const presence = fakePresence();
	const { def } = toolFor(presence);
	const out = await def.execute({ op: 'click', appKey: 'Notes' }, execOf());
	assert.match(out, /【活动】/);
	assert.equal(presence.reports.length, 2);
	assert.deepEqual(presence.reports[0], { active: true, botId: 'river', appKey: 'notes', handoffState: 'idle' });
	assert.equal(presence.reports[1].active, false);
});

await checkAsync('只读 op 不上报（观察不该点亮指示器）', async () => {
	const presence = fakePresence();
	const { def } = toolFor(presence);
	await def.execute({ op: 'getVersion' }, execOf());
	assert.equal(presence.reports.length, 0);
});

await checkAsync('★ 用户点了托盘/指示器的停止 ⇒ 动作被拒且不打到中继', async () => {
	const presence = fakePresence({ stoppedValue: true });
	const { def, relay } = toolFor(presence);
	const out = await def.execute({ op: 'click', appKey: 'Notes' }, execOf());
	assert.match(out, /已通过托盘 \/ 指示器停止/);
	assert.equal(relay.calls.length, 0);
	assert.equal(presence.reports.length, 0);
	// 只读仍可用（用户还能看）
	const ok = await def.execute({ op: 'getVersion' }, execOf());
	assert.match(ok, /【电脑】/);
});

await checkAsync('上报失败不挡住动作（主进程 relay 仍有独立停止闸）', async () => {
	const presence = fakePresence({
		async stopped() { throw new Error('中继不可达'); },
		async report() { throw new Error('中继不可达'); },
	});
	const { def, relay } = toolFor(presence);
	const out = await def.execute({ op: 'click', appKey: 'Notes' }, execOf());
	assert.match(out, /【活动】/);
	assert.equal(relay.calls.length, 1);
});

await checkAsync('★ takeover / handback 把接管状态推给指示器', async () => {
	const presence = fakePresence();
	const { def } = toolFor(presence);
	await def.execute({ op: 'takeover' }, execOf());
	assert.equal(presence.reports.at(-1).handoffState, 'user');
	await def.execute({ op: 'handback' }, execOf());
	assert.equal(presence.reports.at(-1).handoffState, 'idle');
	assert.equal(presence.reports.every((row) => row.active === false), true);
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
