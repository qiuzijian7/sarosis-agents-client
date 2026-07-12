/*---------------------------------------------------------------------------------------------
 *  Embedding tag 工具单元测试（buildEmbeddingTag / parseEmbeddingTag）。
 *  纯函数，无 IO 依赖，可用 mocha 直接运行。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	buildEmbeddingTag,
	parseEmbeddingTag,
	EMBEDDING_TAG_SEPARATOR,
} from '../../common/embeddingProvider.js';

suite('AgentStudio - Embedding Tag 工具', () => {

	test('buildEmbeddingTag 按 ${id}/${model}@${dim} 构造', () => {
		assert.strictEqual(buildEmbeddingTag('openai', 'text-embedding-3-small', 512), 'openai/text-embedding-3-small@512');
		assert.strictEqual(buildEmbeddingTag('knot', 'knot-embed-v1', 1024), 'knot/knot-embed-v1@1024');
		assert.strictEqual(buildEmbeddingTag('local', 'bge-small', 384), 'local/bge-small@384');
	});

	test('buildEmbeddingTag 与 parseEmbeddingTag 互逆', () => {
		const cases: [string, string, number][] = [
			['openai', 'text-embedding-3-small', 512],
			['knot', 'knot-embed-v1', 1024],
			['local', 'bge-small', 384],
			['my-provider', 'model/with/slash', 1536],
		];
		for (const [id, model, dim] of cases) {
			const tag = buildEmbeddingTag(id, model, dim);
			const parsed = parseEmbeddingTag(tag);
			assert.ok(parsed, `parseEmbeddingTag 应成功解析 ${tag}`);
			assert.strictEqual(parsed!.providerId, id);
			assert.strictEqual(parsed!.model, model);
			assert.strictEqual(parsed!.dimensions, dim);
		}
	});

	test('parseEmbeddingTag 处理 model 内含斜杠', () => {
		// model 中允许含 '/'，分隔符以最后一个 '@' 与第一个 '/' 解析
		const tag = 'openai/org/model-name@768';
		const parsed = parseEmbeddingTag(tag);
		assert.ok(parsed);
		assert.strictEqual(parsed!.providerId, 'openai');
		assert.strictEqual(parsed!.model, 'org/model-name');
		assert.strictEqual(parsed!.dimensions, 768);
	});

	test('parseEmbeddingTag 拒绝非法 tag', () => {
		assert.strictEqual(parseEmbeddingTag(''), undefined);
		assert.strictEqual(parseEmbeddingTag('no-at-sign'), undefined);
		assert.strictEqual(parseEmbeddingTag('provider/model@notanumber'), undefined);
		assert.strictEqual(parseEmbeddingTag('provider/model@0'), undefined);
		assert.strictEqual(parseEmbeddingTag('provider@512'), undefined);
		assert.strictEqual(parseEmbeddingTag('@512'), undefined);
	});

	test('EMBEDDING_TAG_SEPARATOR 为 @', () => {
		assert.strictEqual(EMBEDDING_TAG_SEPARATOR, '@');
	});
});
