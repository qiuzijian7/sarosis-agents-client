/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 请求构造器（`common/protocols/requestBuilder.ts`）的回归守卫。
 *
 * 这些断言锁的是「抽出请求构造」这一重构中**容易被静默改变**的行为：
 *   1. URL 拼接的去斜杠规则（抽出的直接动因 —— 此前两处逐字重复）；
 *   2. `parseMode` 必须与 body 格式同源（Anthropic 体 ⇒ sse-anthropic），
 *      否则响应会按错误协议解码；
 *   3. Anthropic 体的 `max_tokens` 必填兜底（缺了会被 API 400）；
 *   4. reasoning 参数按 `reasoningType` 分派的三种形态；
 *   5. 无 tools 时不得设 `tool_choice: 'auto'`（部分网关会校验报错），
 *      唯一例外是收尾轮的 `'none'`。
 *
 * 之所以能直接 import：builder 是纯函数式实现，不依赖 DOM / VS Code /
 * 配置服务 —— 这正是把它从 provider 里抽出来的收益之一
 * （原 `_buildRequestBody` 是 protected 方法，必须实例化 provider 才能测）。
 */

import * as assert from 'assert';
import { RequestBuilder, joinUrl } from '../../common/protocols/requestBuilder.js';
import type { RequestBuildInput } from '../../common/protocols/chatProtocol.js';
import type { IChatMessage, IModelOptions } from '../../common/providers.js';

const MESSAGES: IChatMessage[] = [
	{ role: 'user', content: 'hello' },
];

function makeInput(overrides: Partial<RequestBuildInput> = {}): RequestBuildInput {
	return {
		modelId: 'test-model',
		messages: MESSAGES,
		options: {} as IModelOptions,
		baseUrl: 'https://api.example.com',
		...overrides,
	};
}

/** OpenAI 兼容模式的 builder（无 Anthropic 特征）。 */
function openAIBuilder(logs: string[] = []): RequestBuilder {
	return new RequestBuilder({ responseFormat: 'openai', isAnthropic: false }, (_l, m) => logs.push(m), 'test');
}

suite('requestBuilder — URL 拼接', () => {

	test('两侧多余斜杠都被规整', () => {
		assert.strictEqual(
			joinUrl('https://api.example.com/', '/v1/chat/completions'),
			'https://api.example.com/v1/chat/completions',
		);
		assert.strictEqual(
			joinUrl('https://api.example.com///', '//v1/chat/completions'),
			'https://api.example.com/v1/chat/completions',
		);
	});

	test('未配置 chatEndpointPath 时按协议取默认值', () => {
		const openai = openAIBuilder().build(makeInput()).url;
		assert.strictEqual(openai, 'https://api.example.com/v1/chat/completions');

		const anthropic = new RequestBuilder({ responseFormat: 'anthropic' })
			.build(makeInput()).url;
		assert.strictEqual(anthropic, 'https://api.example.com/v1/messages');
	});

	test('显式 chatEndpointPath 优先于默认值', () => {
		const url = openAIBuilder().build(makeInput({ chatEndpointPath: 'custom/path' })).url;
		assert.strictEqual(url, 'https://api.example.com/custom/path');
	});
});

suite('requestBuilder — parseMode 与 body 格式同源', () => {

	test('OpenAI 兼容 → sse-openai', () => {
		const built = openAIBuilder().build(makeInput());
		assert.strictEqual(built.parseMode, 'sse-openai');
		assert.strictEqual(built.body.model, 'test-model');
		// OpenAI 体不含 Anthropic 专有的 system 顶层字段
		assert.strictEqual(built.body.system, undefined);
	});

	test('Anthropic → sse-anthropic（回归守卫）', () => {
		// 这条断言防的是「请求发 Anthropic 体、响应按 OpenAI SSE 解」的错配：
		// 两者必须由同一个字段派生，不能各自 if 判断。
		const built = new RequestBuilder({ responseFormat: 'anthropic' }).build(makeInput());
		assert.strictEqual(built.parseMode, 'sse-anthropic');
		assert.ok(Array.isArray(built.body.messages));
	});
});

suite('requestBuilder — Anthropic 请求体', () => {

	test('max_tokens 必填兜底为 8192', () => {
		const built = new RequestBuilder({ responseFormat: 'anthropic' }).build(makeInput());
		assert.strictEqual(built.body.max_tokens, 8192);
	});

	test('显式 maxTokens 覆盖兜底值', () => {
		const built = new RequestBuilder({ responseFormat: 'anthropic' })
			.build(makeInput({ options: { maxTokens: 1234 } as IModelOptions }));
		assert.strictEqual(built.body.max_tokens, 1234);
	});

	test('system 提示提升为顶层 system 字段', () => {
		// toAnthropic 产出的是 AnthropicSystemParam（content-block 数组，
		// 便于携带 cache_control 断点），而非裸字符串。
		const built = new RequestBuilder({ responseFormat: 'anthropic' })
			.build(makeInput({ options: { systemPrompt: 'be terse' } as IModelOptions }));
		const system = built.body.system as Array<{ type: string; text: string }>;
		assert.ok(Array.isArray(system), 'system 应为 content-block 数组');
		assert.strictEqual(system[0].text, 'be terse');
	});

	test('未传 systemPrompt 时不设 system 字段', () => {
		const built = new RequestBuilder({ responseFormat: 'anthropic' }).build(makeInput());
		assert.strictEqual(built.body.system, undefined);
	});
});

suite('requestBuilder — reasoning 分派', () => {

	test('budget-slider 模型 + budget → thinking 块', () => {
		// thinking 块仅在 isAnthropic 或 reasoningType==='budget-slider' 时产出，
		// 故此处需注入 getModel 模拟一个 budget-slider 模型。
		const builder = new RequestBuilder(
			{
				responseFormat: 'openai',
				isAnthropic: false,
				getModel: () => ({ capabilityConfig: { reasoningType: 'budget-slider' } } as never),
			},
			() => { }, 'test',
		);
		const built = builder.build(makeInput({
			options: { reasoning: { enabled: true, budget: 4096 } } as IModelOptions,
		}));
		assert.deepStrictEqual(built.body.thinking, { type: 'enabled', budget_tokens: 4096 });
	});

	test('isAnthropic 时 budget → thinking 块', () => {
		const builder = new RequestBuilder({ responseFormat: 'openai', isAnthropic: true }, () => { }, 'test');
		const built = builder.build(makeInput({
			options: { reasoning: { enabled: true, budget: 4096 } } as IModelOptions,
		}));
		assert.deepStrictEqual(built.body.thinking, { type: 'enabled', budget_tokens: 4096 });
	});

	test('纯 OpenAI 兼容 + 无 budget → 由 effort 填 reasoning_effort', () => {
		const built = openAIBuilder().build(makeInput({
			options: { reasoning: { enabled: true, effort: 'low' } } as IModelOptions,
		}));
		assert.strictEqual(built.body.reasoning_effort, 'low');
	});

	test('纯 OpenAI 兼容 + budget 无 effort → 退化为 reasoning_effort 分档', () => {
		// 无 reasoningType 信息的 OpenAI 兼容模型：budget 按阈值粗分档。
		const built = openAIBuilder().build(makeInput({
			options: { reasoning: { enabled: true, budget: 6144 } } as IModelOptions,
		}));
		assert.strictEqual(built.body.reasoning_effort, 'high');
		assert.strictEqual(built.body.thinking, undefined);
	});

	test('reasoning 未启用时不注入任何 reasoning 字段', () => {
		const built = openAIBuilder().build(makeInput());
		assert.strictEqual(built.body.reasoning_effort, undefined);
		assert.strictEqual(built.body.thinking, undefined);
	});
});

suite('requestBuilder — tool_choice 规则', () => {

	test('有 tools 时默认 tool_choice=auto', () => {
		const built = openAIBuilder().build(makeInput({
			options: { tools: [{ name: 'read_file', description: 'd', parameters: {} }] } as unknown as IModelOptions,
		}));
		assert.strictEqual(built.body.tool_choice, 'auto');
	});

	test('无 tools 时不设 tool_choice（回归守卫）', () => {
		// 防的是「空工具面仍发 tool_choice:'auto'」——部分网关会直接 400。
		const built = openAIBuilder().build(makeInput({ options: {} as IModelOptions }));
		assert.strictEqual(built.body.tool_choice, undefined);
	});

	test('无 tools 但收尾轮 none → 显式声明 tool_choice=none', () => {
		const built = openAIBuilder().build(makeInput({
			options: { toolChoice: 'none' } as IModelOptions,
		}));
		assert.strictEqual(built.body.tool_choice, 'none');
	});
});

suite('requestBuilder — 上下文透传', () => {

	test('previousResponseId 注入 body', () => {
		const built = openAIBuilder().build(makeInput({ context: { previousResponseId: 'resp-1' } }));
		assert.strictEqual(built.body.previous_response_id, 'resp-1');
	});

	test('temperature 为 0 时仍被保留（非 falsy 判断）', () => {
		const built = openAIBuilder().build(makeInput({
			options: { temperature: 0 } as IModelOptions,
		}));
		assert.strictEqual(built.body.temperature, 0);
	});
});
