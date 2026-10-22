/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `@vssaros/dsh-agents` 的「会话内人格热切换」核心（纯逻辑）：投影折叠、切换消息构造、人设段动态文本的
 * 解析与回退。这里只测纯函数——真机链路（inbox 注入 → 事件 → 投影 → 下一次装配）在 e2e 里断言
 * （`poc/dsh-p0/scripts/workbench-e2e.mjs` 的 persona 段）。规范依据见 `poc/dsh-p0/README.md` 4.38。
 *
 * 插件是宿主按包名加载的 ESM 纯 JS，这里按绝对路径动态 import：**测试与宿主跑同一份源码**。
 */

import assert from 'assert';
import { join } from '../../../../../base/common/path.js';
import { pathToFileURL } from 'url';

const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
const CORE_URL = pathToFileURL(join(REPO, 'dsh-plugins', 'vssaros-agents', 'lib', 'core', 'persona.js')).href;

/** 懒加载一次（顶层 await 在测试编译目标下不一定可用）。 */
let loaded: Promise<Record<string, any>> | undefined;
const core = () => (loaded ??= import(CORE_URL) as Promise<Record<string, any>>);

suite('dshHarness / agents plugin persona hot switch (pure core)', () => {

	test('projection folds a persona switch out of a durable inbox splice', async () => {
		const { personaProjection } = await core();
		const projection = personaProjection();
		const initial = projection.init();
		assert.strictEqual(initial.personaId, null, 'nothing switched yet');
		assert.strictEqual(initial.text, null);

		const event = { type: 'agent/inbox/spliced', seq: 12, data: { inserted: [{ source: { kind: 'vssaros/persona', personaId: 'fox', name: 'Fox', text: 'FOX' } }] } };
		const switched = projection.apply(initial, event);
		assert.deepStrictEqual(
			{ personaId: switched.personaId, name: switched.name, text: switched.text, atSeq: switched.atSeq },
			{ personaId: 'fox', name: 'Fox', text: 'FOX', atSeq: 12 },
		);
	});

	test('projection keeps the very same reference for every unrelated event', async () => {
		const { personaProjection } = await core();
		const projection = personaProjection();
		const state = projection.init();
		// dsh 靠 `Object.is` 抑制下游发布：忽略的事件必须返回**同一引用**（否则每次事件都算变化）。
		assert.strictEqual(projection.apply(state, { type: 'turn/start' }), state);
		assert.strictEqual(projection.apply(state, { type: 'user/message', data: {} }), state);
		assert.strictEqual(projection.apply(state, { type: 'agent/inbox/spliced', data: { inserted: [] } }), state);
	});

	test('projection ships to the page (wire) without the persona full text', async () => {
		// 没有 wire ⇒ dsh 不把这个单元下发给页面 ⇒ client.agents.js 读 projectionValues["vssaros-persona"]
		// 恒为 undefined（2026-10-20 读 dsh-session-projection 源码确认：只有带 wire 的单元会发）。
		const { personaProjection } = await core();
		const projection = personaProjection();
		assert.ok(projection.wire && typeof projection.wire.view === 'function', 'must declare wire');
		assert.strictEqual(typeof projection.wire.viewSchema?.parse, 'function');
		const switched = projection.apply(projection.init(), { type: 'agent/inbox/spliced', seq: 7, data: { inserted: [{ source: { kind: 'vssaros/persona', personaId: 'fox', name: 'Fox', text: 'A VERY LONG PERSONA' } }] } });
		const view = projection.wire.view(switched);
		assert.deepStrictEqual(view, { personaId: 'fox', name: 'Fox', atSeq: 7 }, '页面读的正是 personaId / name');
		assert.ok(!('text' in view), '人格全文不进页面（可能很长，页面也用不到）');
		assert.deepStrictEqual(projection.wire.view(projection.init()), { personaId: null, name: null, atSeq: -1 });
	});

	test('only our own marked splice counts as a switch', async () => {
		const { personaSwitchOf } = await core();
		// 别人往 inbox 里注入的消息（没有我们的 source.kind）不能被误判成人格切换。
		assert.strictEqual(personaSwitchOf({ type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'tool-registry' } }] } }), undefined);
		// 有 kind 但没带人格全文：不认（否则切换后装配会拿到空段）。
		assert.strictEqual(personaSwitchOf({ type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'vssaros/persona', personaId: 'x' } }] } }), undefined);
		assert.strictEqual(personaSwitchOf({ type: 'user/message', data: {} }), undefined);
		assert.strictEqual(personaSwitchOf(undefined), undefined);
	});

	test('switch message is user-role, and carries the persona text in its source', async () => {
		const { personaSwitchMessage } = await core();
		const message = personaSwitchMessage({ id: 'fox', name: 'Fox', persona: 'FOX-BODY' }, { uuid: () => 'id-1' });
		// 角色只能是 user：`developer` 会被 dsh-llm 的 withoutDeveloperMessages() 静默剔除（那是 loop 的
		// 工具增删专用通道），`system` 对应的 system/message 必须在打开的 step 内（dsh-session 不变量）。
		assert.strictEqual(message.role, 'user');
		assert.strictEqual(message.id, 'id-1', 'without the dsh-llm factory we mint our own id');
		assert.strictEqual(message.source.kind, 'vssaros/persona');
		assert.strictEqual(message.source.personaId, 'fox');
		assert.strictEqual(message.source.text, 'FOX-BODY', 'the persona body must land in the log (replay-exact)');
		assert.ok(message.content[0].text.includes('Fox'), 'the model also gets a short notice');

		let seen: any;
		const viaFactory = personaSwitchMessage({ id: 'fox', name: 'Fox', persona: 'B' }, {
			createUserMessage: (input: any) => { seen = input; return { ...input, role: 'user', id: 'factory' }; },
		});
		assert.strictEqual(seen.source.text, 'B');
		assert.strictEqual(viaFactory.id, 'factory', 'the dsh-llm factory owns identity/freezing when available');
	});

	test('a clear variant resets the projection back to the preset own persona', async () => {
		const { personaProjection, personaSwitchOf, personaSwitchMessage, switchedPersonaText } = await core();
		const splice = (source: any, seq: number) => ({ type: 'agent/inbox/spliced', seq, data: { inserted: [{ source }] } });
		assert.strictEqual(personaSwitchOf(splice({ kind: 'vssaros/persona', cleared: true }, 9))?.cleared, true);

		const projection = personaProjection();
		const switched = projection.apply(projection.init(), splice({ kind: 'vssaros/persona', personaId: 'fox', name: 'Fox', text: 'FOX' }, 3));
		const back = projection.apply(switched, splice({ kind: 'vssaros/persona', cleared: true }, 9));
		assert.deepStrictEqual({ ...back }, { personaId: null, name: null, text: null, atSeq: 9 }, 'cleared state keeps the sequence but drops the persona');
		assert.strictEqual(switchedPersonaText({ stateOf: () => back }, { agent: { session: {} } }), undefined, 'the section falls back to the preset persona again');
		assert.notStrictEqual(back, switched, 'a clear is a real change, not an ignored event');

		const message = personaSwitchMessage(null, { clear: true, uuid: () => 'id-clear' });
		assert.strictEqual(message.role, 'user');
		assert.strictEqual(message.source.cleared, true);
		assert.strictEqual(message.source.text, undefined, 'clear carries no persona body');
		assert.ok(message.content[0].text.includes('自带'), 'the model is told it is back to the agent own persona');
	});

	test('section text resolver: a switched persona wins, every failure path falls back', async () => {
		const { switchedPersonaText, PERSONA_PROJECTION_KEY } = await core();
		const withState = (state: any) => ({ stateOf: (_session: unknown, key: string) => (key === PERSONA_PROJECTION_KEY ? state : undefined) });
		const context = { agent: { session: {} } };

		assert.strictEqual(switchedPersonaText(withState({ text: 'NEW' }), context), 'NEW');
		assert.strictEqual(switchedPersonaText(withState({ text: null }), context), undefined, 'never switched → preset persona');
		assert.strictEqual(switchedPersonaText(withState({ text: '' }), context), undefined, 'empty text is not a persona');
		assert.strictEqual(switchedPersonaText(undefined, context), undefined, 'service not injected');
		assert.strictEqual(switchedPersonaText(withState({ text: 'NEW' }), {}), undefined, 'no session on the assembly context');
		// 读投影抛错也不能让装配失败——那会让整个会话打不开。
		assert.strictEqual(switchedPersonaText({ stateOf: () => { throw new Error('boom'); } }, context), undefined);
	});
});
