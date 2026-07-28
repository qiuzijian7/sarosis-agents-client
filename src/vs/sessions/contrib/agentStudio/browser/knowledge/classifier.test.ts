/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  classifier.test.ts — schema 驱动分类器 + 安全降级单元测试（无网络）。
 *
 *  覆盖：
 *   1. safeSchemaFallback: 始终落到 schema 默认类型（misc）+ 未分类，confidence=0
 *   2. classifyContentViaSchema: LLM 成功路径 / 无效 typeId 降级 / 异常降级 /
 *      置信度限幅 / topic 清洗（无 LLM 时绝不做关键词猜测）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { classifyContentViaSchema, safeSchemaFallback } from './classifier.js';
import { DEFAULT_KB_SCHEMA, buildTypeClassificationPrompt } from './kbSchema.js';
import type { IChatModel, ExtractRequest } from './engine/llm.js';

// ── 辅助：Mock LLM（返回指定的分类结果）──────────────────────────────
class MockClassifyLLM implements IChatModel {
	constructor(private readonly extractResult: any, private readonly shouldThrow = false) { }
	async extract<T = any>(_req: ExtractRequest): Promise<T> {
		if (this.shouldThrow) { throw new Error('LLM connection refused'); }
		return this.extractResult as T;
	}
	async complete(_system: string | undefined, _user: string): Promise<string> {
		return 'mock complete';
	}
}

// ═══════════════════════════════════════════════════════════════════════
// safeSchemaFallback
// ═══════════════════════════════════════════════════════════════════════

suite('safeSchemaFallback', () => {

	test('始终返回 schema 默认类型（misc）+ 未分类，confidence=0，source=fallback', () => {
		const r = safeSchemaFallback(DEFAULT_KB_SCHEMA);
		assert.strictEqual(r.typeId, 'misc');
		assert.strictEqual(r.typeLabel, '杂记');
		assert.strictEqual(r.typeDir, '杂记');
		assert.strictEqual(r.topic, '未分类');
		assert.strictEqual(r.confidence, 0);
		assert.strictEqual(r.source, 'fallback');
		assert.ok(r.reasoning.length > 0, 'reasoning 不能为空');
	});

	test('自定义 reason 透传', () => {
		const r = safeSchemaFallback(DEFAULT_KB_SCHEMA, 'LLM 超时');
		assert.strictEqual(r.reasoning, 'LLM 超时');
	});

	test('schema 缺 misc 类型时回退到最后一个类型', () => {
		const schema = {
			...DEFAULT_KB_SCHEMA,
			types: DEFAULT_KB_SCHEMA.types.filter(t => t.id !== 'misc'),
		};
		const r = safeSchemaFallback(schema);
		const last = schema.types[schema.types.length - 1];
		assert.strictEqual(r.typeId, last.id);
		assert.strictEqual(r.topic, '未分类');
		assert.strictEqual(r.source, 'fallback');
	});
});

// ═══════════════════════════════════════════════════════════════════════
// classifyContentViaSchema
// ═══════════════════════════════════════════════════════════════════════

suite('classifyContentViaSchema', () => {

	test('LLM 返回有效 typeId → source=llm，字段透传', async () => {
		const llm = new MockClassifyLLM({
			typeId: 'concept',
			typeLabel: '概念',
			topic: 'UE5垃圾回收',
			confidence: 0.92,
			reasoning: '内容讲解机制原理',
		});
		const r = await classifyContentViaSchema(llm, DEFAULT_KB_SCHEMA, '垃圾回收机制原理分析');
		assert.strictEqual(r.source, 'llm');
		assert.strictEqual(r.typeId, 'concept');
		assert.strictEqual(r.typeLabel, '概念');
		assert.strictEqual(r.typeDir, '概念');
		assert.strictEqual(r.topic, 'UE5垃圾回收');
		assert.strictEqual(r.confidence, 0.92);
		assert.strictEqual(r.reasoning, '内容讲解机制原理');
	});

	test('LLM 返回无效 typeId → 安全降级（不做关键词猜测）', async () => {
		const llm = new MockClassifyLLM({
			typeId: 'nonexistent_type',
			typeLabel: '不存在的类型',
			topic: 'X',
			confidence: 0.99,
			reasoning: 'fancy',
		});
		const r = await classifyContentViaSchema(llm, DEFAULT_KB_SCHEMA, '修复了一个错误');
		assert.strictEqual(r.source, 'fallback');
		assert.strictEqual(r.typeId, 'misc');
		assert.strictEqual(r.topic, '未分类');
		assert.strictEqual(r.confidence, 0);
	});

	test('LLM 返回空 typeId → 安全降级', async () => {
		const llm = new MockClassifyLLM({ typeId: '', typeLabel: '', topic: '', confidence: 0.9, reasoning: 'x' });
		const r = await classifyContentViaSchema(llm, DEFAULT_KB_SCHEMA, '修复了一个错误');
		assert.strictEqual(r.source, 'fallback');
		assert.strictEqual(r.typeId, 'misc');
	});

	test('LLM 抛异常 → 安全降级', async () => {
		const llm = new MockClassifyLLM({}, true);
		const r = await classifyContentViaSchema(llm, DEFAULT_KB_SCHEMA, '修复了一个 NullPointerException 错误');
		assert.strictEqual(r.source, 'fallback');
		assert.strictEqual(r.typeId, 'misc');
		assert.strictEqual(r.topic, '未分类');
		assert.strictEqual(r.confidence, 0);
	});

	test('LLM 置信度超出 [0,1] → 限幅', async () => {
		const llm = new MockClassifyLLM({ typeId: 'concept', topic: 't1', confidence: 999, reasoning: 'r' });
		const r = await classifyContentViaSchema(llm, DEFAULT_KB_SCHEMA, 'x');
		assert.strictEqual(r.source, 'llm');
		assert.strictEqual(r.confidence, 1);
	});

	test('LLM 返回负置信度 → 限幅到 0', async () => {
		const llm = new MockClassifyLLM({ typeId: 'concept', topic: 't1', confidence: -5, reasoning: 'r' });
		const r = await classifyContentViaSchema(llm, DEFAULT_KB_SCHEMA, 'x');
		assert.strictEqual(r.confidence, 0);
	});

	test('LLM 返回非数字置信度 → 默认 0.8', async () => {
		const llm = new MockClassifyLLM({ typeId: 'concept', topic: 't1', confidence: 'high', reasoning: 'r' });
		const r = await classifyContentViaSchema(llm, DEFAULT_KB_SCHEMA, 'x');
		assert.strictEqual(r.confidence, 0.8);
	});

	test('topic 清洗：过短/非法 → 未分类', async () => {
		const llm = new MockClassifyLLM({ typeId: 'concept', topic: 'a', confidence: 0.5, reasoning: 'r' });
		const r = await classifyContentViaSchema(llm, DEFAULT_KB_SCHEMA, 'x');
		assert.strictEqual(r.topic, '未分类');
	});

	test('topic 缺省时回退类型标签', async () => {
		const llm = new MockClassifyLLM({ typeId: 'concept', confidence: 0.5, reasoning: 'r' });
		const r = await classifyContentViaSchema(llm, DEFAULT_KB_SCHEMA, 'x');
		assert.strictEqual(r.topic, '概念', 'topic 缺省应回退到类型标签');
	});

	test('parsed 包装结构（{ parsed: {...} }）可正确解包', async () => {
		const llm = new MockClassifyLLM({
			parsed: { typeId: 'entity', typeLabel: '实体', topic: 'UE5', confidence: 0.7, reasoning: 'r' },
		});
		const r = await classifyContentViaSchema(llm, DEFAULT_KB_SCHEMA, 'x');
		assert.strictEqual(r.source, 'llm');
		assert.strictEqual(r.typeId, 'entity');
		assert.strictEqual(r.topic, 'UE5');
	});
});

suite('buildTypeClassificationPrompt（existingTopics 引导复用）', () => {

	test('传入 existingTopics 时 prompt 包含既有主题目录块', () => {
		const prompt = buildTypeClassificationPrompt(DEFAULT_KB_SCHEMA, '一些内容', ['概念/UE5 GC机制分析', '概念/内存管理']);
		assert.ok(prompt.includes('## 已有主题目录'), 'prompt 应包含既有主题目录块标题');
		assert.ok(prompt.includes('概念/UE5 GC机制分析'), 'prompt 应列出既有目录');
		assert.ok(prompt.includes('概念/内存管理'), 'prompt 应列出既有目录');
		assert.ok(prompt.includes('原样返回该目录名'), 'prompt 应指示复用原目录名');
	});

	test('不传 existingTopics 时 prompt 不含既有主题目录块', () => {
		const prompt = buildTypeClassificationPrompt(DEFAULT_KB_SCHEMA, '一些内容');
		assert.ok(!prompt.includes('## 已有主题目录'), '不传 existingTopics 时不应有该块');
	});

	test('existingTopics 为空数组时不含既有主题目录块', () => {
		const prompt = buildTypeClassificationPrompt(DEFAULT_KB_SCHEMA, '一些内容', []);
		assert.ok(!prompt.includes('## 已有主题目录'), '空数组不应有该块');
	});
});
