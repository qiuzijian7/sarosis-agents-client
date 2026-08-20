/*---------------------------------------------------------------------------------------------
 * Start → COMFYTV_TEXT 桥：collectOrchestrationValues 识别 Start 节点 + Prompt 类型修复。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { collectOrchestrationValues } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import type { RunNode } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';

suite('Start → ComfyTV bridge (collectOrchestrationValues)', () => {

	test('Start args.text feeds stage prompt (COMFYTV_TEXT bridge)', () => {
		const nodes: RunNode[] = [
			{ id: 'start1', type: 'Saros.Start', data: { args: '{"text":"a cyberpunk cat","count":4}' } },
		];
		const out = collectOrchestrationValues(nodes, ['start1']);
		assert.strictEqual(out.prompt, 'a cyberpunk cat');
	});

	test('Start args.prompt is used when args.text is absent', () => {
		const nodes: RunNode[] = [
			{ id: 'start1', type: 'Saros.Start', data: { args: '{"prompt":"neon rain"}' } },
		];
		const out = collectOrchestrationValues(nodes, ['start1']);
		assert.strictEqual(out.prompt, 'neon rain');
	});

	test('Start args object form (not JSON string) also works', () => {
		const nodes: RunNode[] = [
			{ id: 'start1', type: 'Saros.Start', data: { args: { text: '对象形式文本' } } },
		];
		const out = collectOrchestrationValues(nodes, ['start1']);
		assert.strictEqual(out.prompt, '对象形式文本');
	});

	test('Start without text/prompt fields contributes nothing', () => {
		const nodes: RunNode[] = [
			{ id: 'start1', type: 'Saros.Start', data: { args: '{"count":4}' } },
		];
		const out = collectOrchestrationValues(nodes, ['start1']);
		assert.strictEqual(out.prompt, undefined);
	});

	test('regression: Saros.Prompt (full name) now feeds stage prompt (was broken)', () => {
		const nodes: RunNode[] = [
			{ id: 'p1', type: 'Saros.Prompt', data: { prompt: '提示词文本' } },
		];
		const out = collectOrchestrationValues(nodes, ['p1']);
		assert.strictEqual(out.prompt, '提示词文本');
	});

	test('first non-empty prompt wins when both Start and Prompt upstream', () => {
		const nodes: RunNode[] = [
			{ id: 'start1', type: 'Saros.Start', data: { args: '{"text":"start 文本"}' } },
			{ id: 'p1', type: 'Saros.Prompt', data: { prompt: 'prompt 文本' } },
		];
		const out = collectOrchestrationValues(nodes, ['start1', 'p1']);
		assert.strictEqual(out.prompt, 'start 文本'); // 顺序在前者优先
	});

	test('malformed args JSON is ignored gracefully', () => {
		const nodes: RunNode[] = [
			{ id: 'start1', type: 'Saros.Start', data: { args: '{not json' } },
		];
		const out = collectOrchestrationValues(nodes, ['start1']);
		assert.strictEqual(out.prompt, undefined);
	});
});
