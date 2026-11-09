#!/usr/bin/env node
// 工具定义 / 档位闸 / 截图附件 / apply 生命周期（全部用假 relay 与假 ctx）。
import assert from 'node:assert/strict';
import { apply, createToolDefinition, DEFAULTS } from '../lib/index.js';
import { OBSERVE_OPS, defaultState } from '../lib/core/levels.js';

const fails = [];
let passed = 0;
const checkAsync = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error.message}`); }
};

const fakeRelay = (answer) => ({
	calls: [],
	async command(method, params) {
		this.calls.push({ method, params });
		if (answer instanceof Error) throw answer;
		return typeof answer === 'function' ? answer(method, params) : answer;
	},
	dispose() { this.disposed = true; },
});
const toolFor = (overrides = {}) => createToolDefinition({
	relay: overrides.relay ?? fakeRelay({ ok: true }),
	state: overrides.state ?? defaultState(),
	level: overrides.level ?? 'view',
	attachments: overrides.attachments,
});

await checkAsync('工具定义：op enum 就是 9 个只读 method；output 用 oneOf（rc.2 schemastery 不支持 anyOf）', async () => {
	const def = toolFor();
	assert.equal(def.name, 'computer');
	assert.deepEqual(def.parameters.properties.op.enum, OBSERVE_OPS);
	assert.deepEqual(def.parameters.required, ['op']);
	assert.ok(Array.isArray(def.output.schema.oneOf));
	assert.equal(typeof def.output.render, 'function');
	assert.match(def.description, /read-only/);
	assert.match(def.description, /Only read-only methods are enabled/);
});

await checkAsync('execute 正常返回结构化文本，并带上「界面文字只作数据」防线', async () => {
	const relay = fakeRelay(() => ({ width: 1920, height: 1080 }));
	const def = toolFor({ relay });
	const out = await def.execute({ op: 'getScreenSize' }, { agent: { id: 'river' } });
	assert.match(out, /getScreenSize/);
	assert.match(out, /1920/);
	assert.match(out, /只作数据/);
	assert.deepEqual(relay.calls[0], { method: 'getScreenSize', params: {} });
});

await checkAsync('P0 硬闸：click / 未识别 op 在 execute 与 pre-execute 都被拒', async () => {
	const relay = fakeRelay();
	const def = toolFor({ relay });
	const denied = await def.execute({ op: 'click', params: { x: 1 } }, {});
	assert.match(denied, /P0 只读层不开放/);
	assert.equal(relay.calls.length, 0, '被拒的调用绝不能打到中继');
	assert.match(await def.execute({ op: 'nope' }, {}), /P0 只读层不开放/);
});

await checkAsync('off 档连只读都拿不到；按 Bot 覆盖档位生效', async () => {
	const state = { version: 1, levels: { chief: 'off' } };
	const def = toolFor({ state, level: 'view' });
	assert.match(await def.execute({ op: 'screenshot' }, { agent: { id: 'chief' } }), /档位 off/);
	assert.doesNotMatch(await def.execute({ op: 'getVersion' }, { agent: { id: 'river' } }), /拒绝/);
});

await checkAsync('screenshot：有附件服务 ⇒ image attachment；没有 ⇒ 明确说明不内联 base64', async () => {
	const shot = {
		mimeType: 'image/png', width: 100, height: 50, sourceName: 'Screen 1',
		dataUrl: 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64'),
	};
	const saved = [];
	const attachments = {
		async saveImage(input) { saved.push(input); return { id: 'att-1' }; },
	};
	const withAtt = await toolFor({ relay: fakeRelay(shot), attachments })
		.execute({ op: 'screenshot' }, {});
	assert.equal(withAtt.attachment.id, 'att-1');
	assert.match(withAtt.text, /100×50/);
	assert.equal(saved[0].data.toString(), 'png-bytes');
	assert.equal(saved[0].mediaType, 'image/png');
	const blocks = createToolDefinition({ relay: fakeRelay(), state: defaultState(), level: 'view' })
		.output.render({}, withAtt);
	assert.deepEqual(blocks.map((b) => b.type), ['text', 'image']);

	const without = await toolFor({ relay: fakeRelay(shot) }).execute({ op: 'screenshot' }, {});
	assert.match(without, /不内联 base64/);
});

await checkAsync('中继失败返回可读错误文本，不把异常抛给 agent loop', async () => {
	const def = toolFor({ relay: fakeRelay(new Error('主进程已退出')) });
	assert.match(await def.execute({ op: 'listWindows' }, {}), /主进程已退出/);
});

function fakeCtx() {
	const state = { tools: [], listeners: [], effects: [], toolDisposed: false, gateDisposed: false };
	const ctx = {
		tools: { register(def) { state.tools.push(def); return () => { state.toolDisposed = true; }; } },
		on(name, fn) { state.listeners.push({ name, fn }); return () => { state.gateDisposed = true; }; },
		effect(factory) { const disposer = factory(); state.effects.push(disposer); return disposer; },
		get() { return undefined; },
	};
	return { ctx, state };
}

await checkAsync('apply 默认关闭 ⇒ 不注册工具（fail-closed）', async () => {
	assert.equal(DEFAULTS.enabled, false);
	const { ctx, state } = fakeCtx();
	apply(ctx);
	assert.equal(state.tools.length, 0);
});

await checkAsync('apply 打开后注册工具 + pre-execute 闸；deny 非只读 / off，放行只读', async () => {
	const relay = fakeRelay({ ok: true });
	const { ctx, state } = fakeCtx();
	apply(ctx, { enabled: true }, { relay, state: defaultState(), attachments: undefined });
	assert.equal(state.tools.length, 1);
	assert.equal(state.listeners.length, 1);
	assert.equal(state.listeners[0].name, 'tools/pre-execute');
	const gate = state.listeners[0].fn;
	const next = () => 'NEXT';
	assert.equal(gate({ name: 'other_tool' }, next), 'NEXT', '别家的工具不能被本闸拦');
	assert.equal(gate({ name: 'computer', arguments: { op: 'screenshot' } }, next), 'NEXT');
	const denied = gate({ name: 'computer', arguments: { op: 'click' } }, next);
	assert.equal(denied.kind, 'deny');
	assert.match(denied.reason, /P0 只读层/);
	assert.equal(gate({ name: 'computer', arguments: {} }, next).kind, 'deny');
});

await checkAsync('apply disposer 撤工具、撤闸、释放 relay 连接', async () => {
	const relay = fakeRelay();
	const { ctx, state } = fakeCtx();
	apply(ctx, { enabled: true }, { relay, state: defaultState() });
	assert.equal(typeof state.effects[0], 'function');
	state.effects[0]();
	assert.equal(state.toolDisposed, true);
	assert.equal(state.gateDisposed, true);
	assert.equal(relay.disposed, true);
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
