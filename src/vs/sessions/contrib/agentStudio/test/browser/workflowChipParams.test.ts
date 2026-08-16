/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	serializeInlineWorkflowArgs,
	parseInlineWorkflowArgs,
	encodeWorkflowChipParams,
	decodeWorkflowChipParams,
	buildWorkflowTrigger,
} from '../../../../browser/agentChat/agentChatPanel.workflowChip.js';
import { collectWorkflowVariables } from '../../browser/utils/templateUtils.js';

suite('workflowChip params (方案 B)', () => {

	// ── 序列化/解析 round-trip ──
	suite('serializeInlineWorkflowArgs / parseInlineWorkflowArgs', () => {
		test('round-trip: simple key=value', () => {
			const s = serializeInlineWorkflowArgs({ topic: 'AI', style: '正式' });
			assert.strictEqual(s, '--topic=AI --style=正式');
			assert.deepStrictEqual(parseInlineWorkflowArgs(s).variables, { topic: 'AI', style: '正式' });
		});
		test('round-trip: value with spaces → quoted', () => {
			const s = serializeInlineWorkflowArgs({ title: 'hello world' });
			assert.strictEqual(s, '--title="hello world"');
			assert.deepStrictEqual(parseInlineWorkflowArgs(s).variables, { title: 'hello world' });
		});
		test('round-trip: empty value → --k=', () => {
			assert.strictEqual(serializeInlineWorkflowArgs({ a: '' }), '--a=');
			assert.deepStrictEqual(parseInlineWorkflowArgs('--a=').variables, { a: '' });
		});
		test('round-trip: quote inside value escaped', () => {
			const s = serializeInlineWorkflowArgs({ q: 'say "hi"' });
			assert.strictEqual(s, '--q="say \\"hi\\""');
			assert.deepStrictEqual(parseInlineWorkflowArgs(s).variables, { q: 'say "hi"' });
		});
		test('round-trip: key with dash/underscore', () => {
			const s = serializeInlineWorkflowArgs({ 'max-tokens': '100', 'my_key': 'x' });
			assert.deepStrictEqual(parseInlineWorkflowArgs(s).variables,
				{ 'max-tokens': '100', 'my_key': 'x' });
		});
		test('parse: trailing free text becomes input', () => {
			assert.deepStrictEqual(parseInlineWorkflowArgs('--topic=AI 帮我写周报'),
				{ variables: { topic: 'AI' }, input: '帮我写周报' });
		});
		test('parse: -- alone is NOT an arg', () => {
			assert.deepStrictEqual(parseInlineWorkflowArgs('-- 分隔线'),
				{ variables: {}, input: '-- 分隔线' });
		});
	});

	// ── chip data-params 编解码 ──
	suite('encode/decodeWorkflowChipParams', () => {
		test('encode + decode round-trip', () => {
			const json = encodeWorkflowChipParams({ a: '1', b: 'x y' });
			assert.deepStrictEqual(decodeWorkflowChipParams(json), { a: '1', b: 'x y' });
		});
		test('decode invalid JSON → undefined', () => {
			assert.strictEqual(decodeWorkflowChipParams('{bad'), undefined);
		});
		test('decode empty string → undefined', () => {
			assert.strictEqual(decodeWorkflowChipParams(''), undefined);
		});
		test('encode empty object → empty string', () => {
			assert.strictEqual(encodeWorkflowChipParams({}), '');
			assert.strictEqual(encodeWorkflowChipParams(undefined), '');
		});
		test('decode non-string values filtered out', () => {
			assert.deepStrictEqual(decodeWorkflowChipParams('{"a":"1","b":2}'), { a: '1' });
		});
	});

	// ── 变量提取（与后端 _collectTemplateVariables 一致）──
	suite('collectWorkflowVariables', () => {
		const nodes = [
			{ data: { prompt: '分析 {{topic}} 并写 {{style}} 报告，输入：{{input}}' } },
			{ data: { skillArgs: { q: '关于 {{topic}} 的细节' }, toolParams: { max: '{{max_tokens}}' } } },
			{ data: { prompt: '内置 {{taskDescription}} {{workflowName}} {{$prev}} 应被排除' } },
		];
		test('collects user variables, deduped ({{input}} included)', () => {
			const vars = collectWorkflowVariables(nodes).map(v => v.name).sort();
			assert.deepStrictEqual(vars, ['input', 'max_tokens', 'style', 'topic'].sort());
		});
		test('excludes builtins (task*/workflow*/$prev)', () => {
			const names = collectWorkflowVariables(nodes).map(v => v.name);
			assert.ok(!names.includes('taskDescription'));
			assert.ok(!names.includes('workflowName'));
			assert.ok(!names.includes('$prev'));
		});
		test('{{input}} IS collected (mirrors host _collectTemplateVariables)', () => {
			assert.ok(collectWorkflowVariables(nodes).some(v => v.name === 'input'));
		});
		test('empty/undefined nodes → []', () => {
			assert.deepStrictEqual(collectWorkflowVariables(undefined), []);
			assert.deepStrictEqual(collectWorkflowVariables([]), []);
		});
		test('non-string data fields ignored', () => {
			assert.deepStrictEqual(
				collectWorkflowVariables([{ data: { prompt: 123, skillArgs: { a: 1 } } }]),
				[],
			);
		});
	});

	// ── trigger 构造（含 variables）──
	suite('buildWorkflowTrigger with variables', () => {
		test('variables forwarded', () => {
			assert.deepStrictEqual(buildWorkflowTrigger('wf-x', '写周报', { topic: 'AI' }),
				{ workflowId: 'wf-x', input: '写周报', variables: { topic: 'AI' } });
		});
		test('no variables → field omitted', () => {
			const t = buildWorkflowTrigger('wf-x', '写周报', undefined)!;
			assert.strictEqual(t.workflowId, 'wf-x');
			assert.strictEqual(t.variables, undefined);
		});
		test('empty variables object → field omitted', () => {
			const t = buildWorkflowTrigger('wf-x', 'hi', {})!;
			assert.strictEqual(t.variables, undefined);
		});
	});

	// ── 端到端透传 ──
	suite('workflow params end-to-end', () => {
		test('chip params → context merge → autoValues resolve', () => {
			const params = { topic: 'AI', style: '正式' };
			const trigger = buildWorkflowTrigger('wf-main', '帮我写周报', params)!;
			const context = { input: trigger.input ?? '', ...(trigger.variables ?? {}) };
			assert.deepStrictEqual(context, { input: '帮我写周报', topic: 'AI', style: '正式' });

			const autoValues: Record<string, string> = {};
			for (const v of ['topic', 'style', 'input']) {
				autoValues[v] = String((context as any)[v] ?? '');
			}
			assert.deepStrictEqual(autoValues, { topic: 'AI', style: '正式', input: '帮我写周报' });
		});

		test('serialized composer text stable across save/restore', () => {
			const text = '/workflow wf-main ' + serializeInlineWorkflowArgs({ topic: 'AI', style: '正式' }) + ' 帮我写周报';
			assert.strictEqual(text, '/workflow wf-main --topic=AI --style=正式 帮我写周报');
			const after = text.replace(/^\/workflow\s+wf-main\s*/, '');
			assert.deepStrictEqual(parseInlineWorkflowArgs(after),
				{ variables: { topic: 'AI', style: '正式' }, input: '帮我写周报' });
		});

		test('manual --k=v text (方案 A fallback) still resolves', () => {
			// 未点表单、手打参数：send 层从 text 解析 variables
			const after = '--topic=AI 帮我写周报';
			const parsed = parseInlineWorkflowArgs(after);
			const trigger = buildWorkflowTrigger('wf-main', parsed.input, parsed.variables)!;
			assert.deepStrictEqual(trigger.variables, { topic: 'AI' });
			assert.strictEqual(trigger.input, '帮我写周报');
		});
	});
});
