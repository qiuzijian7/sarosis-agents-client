/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 单元测试：`common/protocols/sseParsers.ts`
 *
 * 回归网 —— 这些函数原先在 renderer 与 Electron 主进程各实现一份（逐字重复），
 * P0-1 重构提取为共享纯函数。测试锁定其行为，供后续迁移编排逻辑时兜底。
 */

import assert from 'assert';
import {
	extractJsonPayload,
	extractUsage,
	parseContentFromJson,
	parseToolCall,
	processRemainingBuffer,
	parseFullJsonFallback,
} from '../../common/protocols/sseParsers.js';
import { AnthropicStreamState } from '../../common/llmBridge.js';

suite('sseParsers / extractJsonPayload', () => {

	test('`data:` 前缀（含空格与不含空格）均剥离', () => {
		assert.strictEqual(extractJsonPayload('data: {"a":1}'), '{"a":1}');
		assert.strictEqual(extractJsonPayload('data:{"a":1}'), '{"a":1}');
	});

	test('[DONE] 哨兵原样返回', () => {
		assert.strictEqual(extractJsonPayload('data: [DONE]'), '[DONE]');
	});

	test('裸 JSON（NDJSON 行）直接返回', () => {
		assert.strictEqual(extractJsonPayload('{"a":1}'), '{"a":1}');
	});

	test('无法识别的行返回 null', () => {
		assert.strictEqual(extractJsonPayload('event: ping'), null);
		assert.strictEqual(extractJsonPayload(''), null);
		assert.strictEqual(extractJsonPayload(': comment'), null);
	});
});

suite('sseParsers / extractUsage', () => {

	test('OpenAI 字段名', () => {
		const d = extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
		assert.deepStrictEqual(d, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cachedTokens: undefined, cacheWriteTokens: undefined, reasoning: undefined } });
	});

	test('Anthropic 字段名', () => {
		const d = extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } });
		assert.deepStrictEqual((d as any).usage.inputTokens, 10);
		assert.deepStrictEqual((d as any).usage.outputTokens, 5);
	});

	test('缓存字段：OpenAI cached_tokens 与 Anthropic cache_read/create', () => {
		const openai = extractUsage({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } } });
		assert.strictEqual((openai as any).usage.cachedTokens, 80);

		const anthropic = extractUsage({ usage: { input_tokens: 100, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 } });
		assert.strictEqual((anthropic as any).usage.cachedTokens, 60);
		assert.strictEqual((anthropic as any).usage.cacheWriteTokens, 20);
	});

	test('reasoning tokens 两种来源', () => {
		const a = extractUsage({ usage: { completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 7 } } });
		assert.strictEqual((a as any).usage.reasoning, 7);

		const b = extractUsage({ usage: { reasoning_tokens: 9 } });
		assert.strictEqual((b as any).usage.reasoning, 9);
	});

	test('无 usage 或无有效字段 → null', () => {
		assert.strictEqual(extractUsage({}), null);
		assert.strictEqual(extractUsage({ usage: {} }), null);
	});

	test('onCacheHit 回调仅在 cachedTokens 命中时触发', () => {
		let hits = 0;
		extractUsage({ usage: { prompt_tokens: 10 } }, () => { hits++; });
		assert.strictEqual(hits, 0);

		extractUsage({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } } }, () => { hits++; });
		assert.strictEqual(hits, 1);
	});
});

suite('sseParsers / parseContentFromJson', () => {

	test('纯文本', () => {
		assert.deepStrictEqual(parseContentFromJson({ content: 'hi' }), [{ type: 'text', content: 'hi' }]);
	});

	test('reasoning_content / thinking / reasoning 三种键名', () => {
		for (const key of ['reasoning_content', 'thinking', 'reasoning']) {
			const out = parseContentFromJson({ [key]: 'think', content: 'answer' });
			assert.deepStrictEqual(out, [{ type: 'thinking', content: 'think' }, { type: 'text', content: 'answer' }]);
		}
	});

	test('content 内联 <think> 标签被剥离并入 thinking', () => {
		const out = parseContentFromJson({ content: '<think>internal</think>visible' });
		assert.deepStrictEqual(out, [{ type: 'thinking', content: 'internal' }, { type: 'text', content: 'visible' }]);
	});

	test('<thinking> 标签同样识别', () => {
		const out = parseContentFromJson({ content: '<thinking>a</thinking>b' });
		assert.strictEqual((out[0] as any).content, 'a');
		assert.strictEqual((out[1] as any).content, 'b');
	});

	test('空内容不产出 delta', () => {
		assert.deepStrictEqual(parseContentFromJson({}), []);
	});

	test('tool_calls 三种格式均被解析', () => {
		// 1. OpenAI 标准
		const std = parseContentFromJson({ tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{"x":1}' } }] });
		assert.deepStrictEqual(std, [{ type: 'tool_call', toolCall: { id: 't1', name: 'f', arguments: '{"x":1}' } }]);

		// 2. Anthropic 经代理（input 为对象）
		const anth = parseContentFromJson({ tool_calls: [{ id: 't2', name: 'g', input: { y: 2 } }] });
		assert.deepStrictEqual((anth[0] as any).toolCall, { id: 't2', name: 'g', arguments: '{"y":2}' });

		// 3. 扁平（arguments 为字符串）
		const flat = parseContentFromJson({ tool_calls: [{ id: 't3', name: 'h', arguments: '{"z":3}' }] });
		assert.deepStrictEqual((flat[0] as any).toolCall, { id: 't3', name: 'h', arguments: '{"z":3}' });
	});
});

suite('sseParsers / parseToolCall', () => {

	test('OpenAI function 嵌套格式', () => {
		assert.deepStrictEqual(parseToolCall({ id: 'a', function: { name: 'n', arguments: '{}' } }), { id: 'a', name: 'n', arguments: '{}' });
	});

	test('Anthropic tool_use_id 作为 id 回退', () => {
		assert.deepStrictEqual(parseToolCall({ tool_use_id: 'u1', name: 'n', input: {} }), { id: 'u1', name: 'n', arguments: '{}' });
	});

	test('id 优先于 tool_use_id', () => {
		assert.strictEqual(parseToolCall({ id: 'primary', tool_use_id: 'fallback', name: 'n', input: {} })!.id, 'primary');
	});

	test('args 键也被接受', () => {
		assert.strictEqual(parseToolCall({ name: 'n', args: '{"a":1}' })!.arguments, '{"a":1}');
	});

	test('无 name 且无 args → null', () => {
		assert.strictEqual(parseToolCall({}), null);
	});

	test('非字符串非对象参数降级为空字符串', () => {
		assert.deepStrictEqual(parseToolCall({ name: 'n', arguments: 42 }), { id: '', name: 'n', arguments: '' });
	});
});

suite('sseParsers / processRemainingBuffer', () => {

	test('空 buffer → 无 delta', () => {
		assert.deepStrictEqual(processRemainingBuffer(''), []);
		assert.deepStrictEqual(processRemainingBuffer('   '), []);
	});

	test('[DONE] 残留 → 无 delta', () => {
		assert.deepStrictEqual(processRemainingBuffer('data: [DONE]'), []);
	});

	test('未终止的 OpenAI JSON 行被解析', () => {
		const out = processRemainingBuffer('data: {"choices":[{"delta":{"content":"tail"}}]}');
		assert.deepStrictEqual(out, [{ type: 'text', content: 'tail' }]);
	});

	test('不完整 JSON 静默忽略', () => {
		assert.deepStrictEqual(processRemainingBuffer('data: {"choices":[{"delta"'), []);
	});

	test('携带 anthropicState 时改走 Anthropic 状态机', () => {
		const state = new AnthropicStreamState();
		const out = processRemainingBuffer('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A"}}', state);
		assert.deepStrictEqual(out, [{ type: 'text', content: 'A' }]);
	});
});

suite('sseParsers / parseFullJsonFallback', () => {

	test('非流式完整响应：usage + message 均产出', () => {
		const body = JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 }, choices: [{ message: { content: 'hello' } }] });
		const out = parseFullJsonFallback(body);
		assert.strictEqual(out[0].type, 'usage');
		assert.deepStrictEqual(out[1], { type: 'text', content: 'hello' });
	});

	test('无法解析为 JSON → 兜底为纯文本', () => {
		assert.deepStrictEqual(parseFullJsonFallback('plain text body'), [{ type: 'text', content: 'plain text body' }]);
	});

	test('HTML 错误页不兜底为文本', () => {
		assert.deepStrictEqual(parseFullJsonFallback('<html>502 Bad Gateway</html>'), []);
	});

	test('空响应体 → 无 delta', () => {
		assert.deepStrictEqual(parseFullJsonFallback(''), []);
	});

	test('携带 anthropicState 时改走 Anthropic 状态机', () => {
		const state = new AnthropicStreamState();
		const body = JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'X' } });
		assert.deepStrictEqual(parseFullJsonFallback(body, state), [{ type: 'text', content: 'X' }]);
	});
});
