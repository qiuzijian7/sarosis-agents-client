/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 协议分派守卫：`ParseMode` → 解析器实例。
 *
 * 背景（P1 重构）：重构前 `runChatStream` 用二元 if 分派 ——
 *   `const anthropicState = parseMode === 'sse-anthropic' ? new AnthropicStreamState() : undefined;`
 * 并把 `anthropicState | undefined` 一路传进 `readStream` / `processRemainingBuffer` /
 * `parseFullJsonFallback`，三个函数各自再判一次 `if (anthropicState)`。
 * 加第三种协议要同时改 4 处。
 *
 * 现在收敛为查表：`resolveStreamParser(parseMode)` 返回解析器实例，下游只调实例方法。
 * 本测试把「协议选择正确」与「done 产出责任唯一」两条不变量固化。
 */

import * as assert from 'assert';
import {
	DEFAULT_PARSE_MODE,
	STREAM_PARSERS,
	resolveStreamParser,
} from '../../common/protocols/protocolRegistry.js';

suite('protocolRegistry — 协议分派', () => {

	suite('协议选择', () => {

		test('★ 未指定 parseMode → openai 兼容路径（默认值）', () => {
			const parser = resolveStreamParser(undefined);
			assert.strictEqual(parser.producesDone, false, 'openai 路径的 done 由 runChatStream 组装');
		});

		test('★ sse-anthropic → 自行产出 done（携带 stop_reason / response_id）', () => {
			const parser = resolveStreamParser('sse-anthropic');
			assert.strictEqual(parser.producesDone, true, 'anthropic 路径由状态机产出 done');
		});

		test('未知 parseMode 静默回落默认协议，而非抛错', () => {
			// 配置里写了将来才支持的协议值时，应降级而非让整个会话不可用
			const parser = resolveStreamParser('sse-unknown-future' as never);
			assert.strictEqual(parser.producesDone, false, '应回落到 openai 默认路径');
		});

		test('注册表覆盖 ParseMode 的每一个取值（新增协议漏注册会在编译期报错）', () => {
			assert.ok(Object.keys(STREAM_PARSERS).length >= 2, '至少覆盖 openai / anthropic');
			assert.ok('sse-openai' in STREAM_PARSERS);
			assert.ok('sse-anthropic' in STREAM_PARSERS);
			assert.strictEqual(DEFAULT_PARSE_MODE, 'sse-openai');
		});

		test('每次调用返回新实例（解析器有跨事件状态，不可共享）', () => {
			const a = resolveStreamParser('sse-anthropic');
			const b = resolveStreamParser('sse-anthropic');
			assert.notStrictEqual(a, b, '同一请求内复用了实例会导致前一个流的工具块污染后一个');

			// anthropic 状态机累积工具块；若共享实例，第二次 push 会带上第一次的残留
			a.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'f' } });
			const fromB = b.push({ type: 'content_block_stop', index: 0 });
			assert.deepStrictEqual(fromB, [], '新实例不应受另一实例的未闭合工具块影响');
		});
	});

	suite('OpenAI 兼容路径行为', () => {

		test('content delta → text delta', () => {
			const parser = resolveStreamParser('sse-openai');
			assert.deepStrictEqual(
				parser.push({ choices: [{ delta: { content: 'hi' } }] }),
				[{ type: 'text', content: 'hi' }],
			);
		});

		test('usage → usage delta', () => {
			const parser = resolveStreamParser('sse-openai');
			const out = parser.push({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
			assert.strictEqual(out.length, 1);
			assert.strictEqual(out[0].type, 'usage');
		});

		test('★ onCacheHit 回调被透传到 usage 解析（重构中曾一度丢失）', () => {
			let hits = 0;
			const parser = resolveStreamParser('sse-openai', () => { hits++; });
			parser.push({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } } });
			assert.strictEqual(hits, 1, 'onCacheHit 必须由工厂注入到 openai 解析器');
		});

		test('无 choices / 无 usage → 空数组，不抛错', () => {
			const parser = resolveStreamParser('sse-openai');
			assert.deepStrictEqual(parser.push({}), []);
			assert.deepStrictEqual(parser.push({ choices: [] }), []);
		});

		test('producesDone=false → end() 返回空（done 由 runChatStream 组装，避免双份）', () => {
			const parser = resolveStreamParser('sse-openai');
			assert.deepStrictEqual(parser.end(), []);
		});
	});

	suite('Anthropic 路径行为', () => {

		test('text_delta → text delta', () => {
			const parser = resolveStreamParser('sse-anthropic');
			const out = parser.push({
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'text_delta', text: 'A' },
			});
			assert.deepStrictEqual(out, [{ type: 'text', content: 'A' }]);
		});

		test('★ producesDone=true → end() 产出 done（否则整个会话缺收尾信号）', () => {
			const parser = resolveStreamParser('sse-anthropic');
			const out = parser.end();
			assert.strictEqual(out.filter(d => d.type === 'done').length, 1, '必须且仅产出一个 done');
		});
	});

	suite('buffer / 整段兜底', () => {

		test('finishBuffer 剥掉 `data:` 前缀后解析', () => {
			const parser = resolveStreamParser('sse-openai');
			const out = parser.finishBuffer('data: {"choices":[{"delta":{"content":"tail"}}]}');
			assert.deepStrictEqual(out, [{ type: 'text', content: 'tail' }]);
		});

		test('截断的不完整 buffer → 丢弃而非抛错', () => {
			const parser = resolveStreamParser('sse-openai');
			assert.deepStrictEqual(parser.finishBuffer('data: {"choices":[{"delta"'), []);
		});

		test('[DONE] / 空 buffer → 无 delta', () => {
			const parser = resolveStreamParser('sse-openai');
			assert.deepStrictEqual(parser.finishBuffer('data: [DONE]'), []);
			assert.deepStrictEqual(parser.finishBuffer(''), []);
		});

		test('★ 非 SSE 整段 JSON 兜底（网关退化为单个 JSON）', () => {
			const parser = resolveStreamParser('sse-openai');
			const out = parser.finishFullBody('{"choices":[{"message":{"content":"whole"}}]}');
			assert.deepStrictEqual(out, [{ type: 'text', content: 'whole' }]);
		});

		test('★ 非 JSON 整段响应 → 当作纯文本（如网关返回裸文本）', () => {
			const parser = resolveStreamParser('sse-openai');
			assert.deepStrictEqual(
				parser.finishFullBody('plain text body'),
				[{ type: 'text', content: 'plain text body' }],
			);
		});

		test('★ HTML 错误页不当作模型输出（网关 502 会返回 HTML）', () => {
			const parser = resolveStreamParser('sse-openai');
			assert.deepStrictEqual(parser.finishFullBody('<html>502 Bad Gateway</html>'), []);
		});

		test('空整段响应 → 无 delta', () => {
			const parser = resolveStreamParser('sse-openai');
			assert.deepStrictEqual(parser.finishFullBody(''), []);
		});
	});
});
