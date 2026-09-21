/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenAI **strict 工具模式**的接入回归（2026-09-21）。
 *
 * 背景：strict 是"参数结构必合法"的强约束，但 OpenAI 对 schema 的子集校验**不满足就整个请求 400**
 * ⇒ 接入的正确性标准有两面：① 该 strict 的必须真的 strict；② **不该 strict 的绝不能 strict**
 * （且默认路径必须一个字节不改）。本文件按这两面钉住。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/common/toolSchemaStrict.test.ts
 */

import * as assert from 'assert';
import {
	prepareToolSchemaForStrict, isStrictApplicable, applyStrictToTools,
	STRICT_DROPPED_KEYWORDS,
} from '../../common/adapters/toolSchemaStrict.js';
import { MessageFormatConverter } from '../../common/adapters/messageFormatConverter.js';
import { RequestBuilder } from '../../common/protocols/requestBuilder.js';
import type { RequestBuildInput } from '../../common/protocols/chatProtocol.js';
import type { IChatMessage, IModelInfo, IModelOptions, IToolDefinition } from '../../common/providers.js';

const def = (name: string, inputSchema: Record<string, unknown>): IToolDefinition => ({
	name, description: `${name} desc`, inputSchema,
} as unknown as IToolDefinition);

/** 带 `pattern`（strict 不允许）+ 可选参数（strict 要求全进 required）的典型本仓工具。 */
const PLAIN_TOOL = def('file_read', {
	type: 'object',
	properties: {
		path: { type: 'string', pattern: '^[A-Za-z]:[\\\\/]' },
		offset: { type: 'number', minimum: 0 },
	},
	required: ['path'],
});

/** 结构上无法清洗（改了语义就变了）⇒ 必须退回普通模式。 */
const BLOCKED_TOOLS = [
	def('union_tool', { type: 'object', oneOf: [{ type: 'string' }], additionalProperties: false }),
	def('ref_tool', { type: 'object', properties: { a: { $ref: '#/$defs/x' } } }),
	def('nullable_tool', { type: 'object', properties: { a: { type: ['string', 'null'] } } }),
];

suite('toolSchemaStrict — strict 子集清洗', () => {

	test('★★★ 普通工具：补 additionalProperties:false + required 全覆盖 + 删掉不允许的 pattern', () => {
		const { parameters, strict } = prepareToolSchemaForStrict(PLAIN_TOOL.inputSchema);
		assert.strictEqual(strict, true, '该工具应能进入 strict ✗');
		assert.strictEqual(parameters['additionalProperties'], false, 'strict 要求 additionalProperties:false ✗');
		assert.deepStrictEqual(parameters['required'], ['path', 'offset'],
			'strict 要求**每个**属性都进 required（本仓 schema 大量可选参数，不补齐必 400）✗');
		const props = parameters['properties'] as Record<string, Record<string, unknown>>;
		assert.ok(!('pattern' in props['path']), '`pattern` 在 strict 下不允许出现，必须清洗掉 ✗');
		assert.ok(!('minimum' in props['offset']), '`minimum` 同理 ✗');
		assert.strictEqual(props['path']['type'], 'string', '清洗只删不允许的关键字，不得动结构 ✗');
	});

	test('★★★ 入参不被修改（同一份 inputSchema 还被 prompt/文本兜底路径使用）', () => {
		const before = JSON.parse(JSON.stringify(PLAIN_TOOL.inputSchema));
		prepareToolSchemaForStrict(PLAIN_TOOL.inputSchema);
		assert.deepStrictEqual(PLAIN_TOOL.inputSchema, before,
			'清洗必须在副本上进行 —— 原地改会污染同一份工具定义在别处的用途 ✗');
	});

	test('★★★ 结构阻断的工具必须退回（且**原样**返回，不得猜测性改写语义）', () => {
		for (const t of BLOCKED_TOOLS) {
			const { parameters, strict } = prepareToolSchemaForStrict(t.inputSchema);
			assert.strictEqual(strict, false, `${t.name} 结构上无法 strict，必须退回 ✗`);
			assert.strictEqual(parameters, t.inputSchema, `${t.name} 退回时必须原样返回（不克隆不改写）✗`);
			assert.strictEqual(isStrictApplicable(t.inputSchema), false, `${t.name} 的判定应与转换一致 ✗`);
		}
	});

	test('★ 嵌套 object（items 内）同样自洽化', () => {
		const nested = def('workflow_apply', {
			type: 'object',
			properties: {
				nodes: {
					type: 'array',
					items: {
						type: 'object',
						properties: { id: { type: 'string' }, kind: { type: 'string', pattern: '^[a-z]+$' } },
						required: ['id'],
					},
				},
			},
			required: ['nodes'],
		});
		const { parameters, strict } = prepareToolSchemaForStrict(nested.inputSchema);
		assert.strictEqual(strict, true);
		const item = (parameters['properties'] as any).nodes.items;
		assert.strictEqual(item.additionalProperties, false, '嵌套 object 也要 additionalProperties:false ✗');
		assert.deepStrictEqual(item.required, ['id', 'kind'], '嵌套 required 也要补齐 ✗');
		assert.ok(!('pattern' in item.properties.kind), '嵌套里的 pattern 也要清洗 ✗');
	});

	test('★ 无 properties 的 object 补空 required（strict 下显式更稳）', () => {
		const { parameters } = prepareToolSchemaForStrict({ type: 'object', additionalProperties: false });
		assert.deepStrictEqual(parameters['required'], []);
	});

	test('★ 清洗清单只包含"删了不改变语义骨架"的关键字（防误删 structural 关键字）', () => {
		for (const structural of ['type', 'properties', 'required', 'items', 'enum', 'description']) {
			assert.ok(!STRICT_DROPPED_KEYWORDS.includes(structural),
				`${structural} 是结构关键字，绝不能进清洗清单 ✗`);
		}
	});
});

suite('MessageFormatConverter.toOpenAIToolDefinitions — strict 按工具粒度', () => {

	test('★★★ 默认（不传 strict）：一个字节不改（回归）', () => {
		const out = MessageFormatConverter.toOpenAIToolDefinitions([PLAIN_TOOL]);
		assert.strictEqual(out.length, 1);
		assert.ok(!('strict' in out[0].function), 'strict 关闭时不得出现 strict 字段 ✗');
		assert.deepStrictEqual(out[0].function.parameters, PLAIN_TOOL.inputSchema,
			'strict 关闭时 schema 必须原样透传（含 pattern）✗');
	});

	test('★★★ strict 开：兼容工具声明 strict，结构阻断工具**自己退回**且不影响同批', () => {
		const out = MessageFormatConverter.toOpenAIToolDefinitions(
			[PLAIN_TOOL, ...BLOCKED_TOOLS], undefined, false, undefined, true);
		const byName = new Map(out.map(o => [o.function.name, o.function]));
		assert.strictEqual(byName.get('file_read')!['strict'], true, '兼容工具应 strict ✗');
		for (const t of BLOCKED_TOOLS) {
			assert.ok(!('strict' in byName.get(t.name)!),
				`${t.name} 必须退回普通模式（否则整个请求 400）✗`);
		}
		assert.deepStrictEqual(byName.get('file_read')!.parameters['required'], ['path', 'offset'],
			'同批的兼容工具仍应被自洽化（不能被坏 schema 拖垮）✗');
	});

	test('★ strict 开 + Anthropic 兼容且无 fork：不得凭空打 cache_control', () => {
		const out = MessageFormatConverter.toOpenAIToolDefinitions([PLAIN_TOOL], undefined, true, undefined, true);
		assert.ok(!('cache_control' in out[0]), '无 forkContext 时不应打 cache 断点 ✗');
		assert.strictEqual(out[0].function['strict'], true, '但 strict 仍应生效（两者互不干扰）✗');
	});

	test('★ applyStrictToTools 的统计与转换一致（供日志归因）', () => {
		const { out, stats } = applyStrictToTools([PLAIN_TOOL, ...BLOCKED_TOOLS]);
		assert.strictEqual(out.length, 4);
		assert.deepStrictEqual(stats.strictTools, ['file_read']);
		assert.deepStrictEqual(stats.fallbackTools, BLOCKED_TOOLS.map(t => t.name));
	});
});

suite('RequestBuilder — strict 生效链（provider 级 / 模型级）', () => {

	const MESSAGES: IChatMessage[] = [{ role: 'user', content: 'hi' }];

	const makeInput = (over: Partial<RequestBuildInput> = {}): RequestBuildInput => ({
		modelId: 'gpt-4o',
		messages: MESSAGES,
		options: { tools: [PLAIN_TOOL] } as IModelOptions,
		baseUrl: 'https://api.openai.com',
		...over,
	});
	const toolsOf = (body: Record<string, unknown>): Array<{ function: Record<string, unknown> }> =>
		body['tools'] as Array<{ function: Record<string, unknown> }>;

	test('★★★ provider 级声明 true（官方端点）→ 请求体真的带上 strict', () => {
		const logs: string[] = [];
		const r = new RequestBuilder(
			{ responseFormat: 'openai', isAnthropic: false, strictToolSchema: true },
			(_l, m) => logs.push(m), 'openai');
		const body = r.build(makeInput()).body;
		assert.strictEqual(toolsOf(body)[0].function['strict'], true, 'provider 声明了就必须真的发 strict ✗');
		assert.ok(logs.some(l => /strict mode ON: 1\/1/.test(l)),
			'必须留下按工具粒度的统计日志（否则线上无从归因）✗');
	});

	test('★★ provider 未判定 + 模型级 capabilityConfig.strictToolSchema=true → 生效（逐模型 opt-in）', () => {
		const model = {
			id: 'gpt-4o', name: 'gpt-4o', capabilities: [],
			capabilityConfig: { supportsSystemMessage: 'system-role', strictToolSchema: true },
		} as unknown as IModelInfo;
		const r = new RequestBuilder(
			{ responseFormat: 'openai', isAnthropic: false, getModel: id => (id === 'gpt-4o' ? model : undefined) },
			() => { }, 'custom');
		assert.strictEqual(toolsOf(r.build(makeInput()).body)[0].function['strict'], true,
			'模型声明 strict 时应生效（自建网关用户唯一的开启途径）✗');
	});

	test('★★★ 两边都没声明 → 不发 strict（网关默认零风险）', () => {
		const logs: string[] = [];
		const r = new RequestBuilder({ responseFormat: 'openai', isAnthropic: false }, (_l, m) => logs.push(m), 'openrouter');
		const body = r.build(makeInput({ baseUrl: 'https://openrouter.ai/api/v1' })).body;
		assert.ok(!('strict' in toolsOf(body)[0].function),
			'未声明就发 strict 会给 OpenRouter/Ollama 之类网关制造 400 ✗');
		assert.ok(!logs.some(l => /strict mode ON/.test(l)), '未开启时不应打印 strict 日志 ✗');
	});
});
