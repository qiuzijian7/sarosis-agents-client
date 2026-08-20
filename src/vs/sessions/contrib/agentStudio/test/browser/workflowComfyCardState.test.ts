/*---------------------------------------------------------------------------------------------
 *  Unit tests for cardState — per-node execution state driving the ComfyTV-style
 *  card feedback (run button / progress / error / output).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { CardStateStore, useNodeCardState } from '../../webview/src/features/workflowEditor/comfyHost/cardState.js';
import { getNodeCardMeta } from '../../webview/src/features/workflowEditor/comfyHost/nodeCard.js';
import { buildSarosEditorFields } from '../../webview/src/features/workflowEditor/comfyHost/nodeEditorForm.js';

suite('cardState (CardStateStore)', () => {

	test('default state is idle with 0 progress', () => {
		const store = new CardStateStore();
		const s = store.get('node-x');
		assert.strictEqual(s.runState, 'idle');
		assert.strictEqual(s.progress, 0);
	});

	test('set() stores and notifies subscribers', () => {
		const store = new CardStateStore();
		let notified = 0;
		const unsub = store.subscribe(() => { notified++; });
		store.set('node-x', { runState: 'running', progress: 42 });
		assert.strictEqual(notified, 1);
		assert.strictEqual(store.get('node-x').runState, 'running');
		assert.strictEqual(store.get('node-x').progress, 42);
		unsub();
		store.set('node-x', { runState: 'success', progress: 100 });
		assert.strictEqual(notified, 1); // no longer subscribed
	});

	test('nodes are independent', () => {
		const store = new CardStateStore();
		store.set('a', { runState: 'running', progress: 10 });
		assert.strictEqual(store.get('b').runState, 'idle');
	});

	test('clear() removes a node back to idle', () => {
		const store = new CardStateStore();
		store.set('a', { runState: 'error', progress: 0, errorMsg: 'boom' });
		store.clear('a');
		assert.strictEqual(store.get('a').runState, 'idle');
	});

	test('clearAll() resets every node', () => {
		const store = new CardStateStore();
		store.set('a', { runState: 'running', progress: 1 });
		store.set('b', { runState: 'error', progress: 0 });
		store.clearAll();
		assert.strictEqual(store.get('a').runState, 'idle');
		assert.strictEqual(store.get('b').runState, 'idle');
	});

	suite('transition', () => {

		test('running keeps previous errorMsg cleared via explicit values', () => {
			const next = CardStateStore.transition({ runState: 'error', progress: 0, errorMsg: 'old' }, { runState: 'running', progress: 5 });
			assert.strictEqual(next.runState, 'running');
			assert.strictEqual(next.progress, 5);
			// errorMsg carries forward unless overridden — tests default merge semantics
		});

		test('running clears finishedAt; terminal sets it', () => {
			const running = CardStateStore.transition(undefined, { runState: 'running', progress: 5 });
			assert.strictEqual(running.finishedAt, undefined);
			const done = CardStateStore.transition(running, { runState: 'success', durationMs: 800 });
			assert.strictEqual(done.durationMs, 800);
			assert.ok(done.finishedAt != null);
		});

		test('preserves prior fields when next omits them', () => {
			const prev = { runState: 'running', progress: 60, durationMs: 500 };
			const next = CardStateStore.transition(prev, { runState: 'success' });
			assert.strictEqual(next.progress, 60);
			assert.strictEqual(next.durationMs, 500);
		});
	});
});

suite('nodeCard ComfyTV metadata (getNodeCardMeta)', () => {

	test('schema stage exposes stageKind + hasPrompt for run-button styling', () => {
		const spec: any = {
			type: 'ComfyTV.ImageStage', kind: 'schema', title: '文生图', category: 'c',
			inputs: [], outputs: [],
			// hasPrompt 要求 schema spec 在 widgets 里声明 prompt 域（ComfyTV
			// MainPromptInput 语义；loader/picker 类无 prompt 不显示 textarea）
			widgets: [{ name: 'prompt' }],
			comfyTV: { stageKind: 'image', workflowKind: 'image-to-image' },
		};
		const meta = getNodeCardMeta(spec, {});
		assert.strictEqual(meta.stageKind, 'image');
		assert.strictEqual(meta.hasPrompt, true);
	});

	test('native / react nodes do not show run button (hasPrompt false)', () => {
		const native: any = { type: 'KSampler', kind: 'native', category: 'c', inputs: [], outputs: [] };
		assert.strictEqual(getNodeCardMeta(native, {}).hasPrompt, false);
		assert.strictEqual(getNodeCardMeta(native, {}).stageKind, undefined);
		const react: any = { type: 'Saros.Prompt', kind: 'react', category: 'c', inputs: [], outputs: [] };
		assert.strictEqual(getNodeCardMeta(react, {}).hasPrompt, false);
	});

	test('P1: react node summary counts JSON object fields instead of dumping JSON', () => {
		const spec: any = { type: 'Saros.Skill', kind: 'react', category: 'c', inputs: [], outputs: [] };
		const meta = getNodeCardMeta(spec, { skillName: 'frontend-slides', skillArgs: { topic: 'AI', depth: 3 } });
		assert.match(meta.widgetSummary ?? '', /Skill=frontend-slides/);
		assert.match(meta.widgetSummary ?? '', /参数 \(JSON\)=2 参数/);
		assert.doesNotMatch(meta.widgetSummary ?? '', /"topic"/); // 不再裸 JSON 截断
	});

	test('P1: long prompt shows a checkmark instead of truncated noise', () => {
		const spec: any = { type: 'Saros.Agent', kind: 'react', category: 'c', inputs: [], outputs: [] };
		const meta = getNodeCardMeta(spec, { prompt: '这是一个非常长的提示词内容，超过十六个字符就应该被折叠为已填标记'.repeat(2) });
		assert.match(meta.widgetSummary ?? '', /提示词=✓ 已填/);
	});

	test('P1: Start node exposes an args field (input contract)', () => {
		const fields = buildSarosEditorFields('Saros.Start');
		assert.strictEqual(fields.length, 1);
		assert.strictEqual(fields[0].key, 'args');
		assert.strictEqual(fields[0].kind, 'textarea');
	});

	test('P1: End node exposes a description field', () => {
		const fields = buildSarosEditorFields('Saros.End');
		assert.strictEqual(fields[0].key, 'description');
	});

	test('P1: Start args summary counts parameters from JSON string', () => {
		const spec: any = { type: 'Saros.Start', kind: 'react', category: 'c', inputs: [], outputs: [] };
		const meta = getNodeCardMeta(spec, { args: '{"topic":"cyberpunk","count":4}' });
		assert.match(meta.widgetSummary ?? '', /输入参数 \(JSON\)=2 参数/);
	});
});
