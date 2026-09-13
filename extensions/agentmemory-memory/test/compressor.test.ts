/*---------------------------------------------------------------------------------------------
 *  compressor.test.ts — 压缩器回归测试（R6 补测，2026-09-09）
 *
 *  覆盖：compressSynthetic 的结构化提取（文件路径/概念/事实/importance 加权）、
 *        compress 短内容走 synthetic、compressWithLLM 未配置时静默回退 synthetic。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { compressSynthetic, compress, compressWithLLM } from '../src/compressor.js';

// 冒烟/单测环境不应配置 LLM env（保证回退路径可测）
const savedBase = process.env['AGENTMEMORY_LLM_BASE_URL'];
const savedKey = process.env['AGENTMEMORY_LLM_API_KEY'];

suite('compressor — 合成压缩提取（R6）', () => {
	suiteSetup(() => {
		delete process.env['AGENTMEMORY_LLM_BASE_URL'];
		delete process.env['AGENTMEMORY_LLM_API_KEY'];
	});
	suiteTeardown(() => {
		if (savedBase !== undefined) { process.env['AGENTMEMORY_LLM_BASE_URL'] = savedBase; }
		if (savedKey !== undefined) { process.env['AGENTMEMORY_LLM_API_KEY'] = savedKey; }
	});

	test('文件路径与 import 提取', () => {
		const r = compressSynthetic('we changed src/vs/workbench.ts and import { foo } from "./bar/baz.ts" to fix the bug');
		assert.ok(r.files.includes('src/vs/workbench.ts'), `files: ${r.files}`);
		assert.ok(r.files.includes('./bar/baz.ts') || r.files.includes('bar/baz.ts'), `import 路径应提取: ${r.files}`);
	});

	test('importance 加权：error +2 / decision +2 / architecture +1', () => {
		const base = compressSynthetic('plain observation text with nothing special in it').importance;
		assert.strictEqual(base, 5);
		const withError = compressSynthetic('TypeError: cannot read property of undefined crashed the build');
		assert.ok(withError.importance >= 7, `error 加权后应 ≥7，实际 ${withError.importance}`);
		const withDecision = compressSynthetic('we decided to adopt the repository pattern for the data layer');
		assert.ok(withDecision.importance >= 7, `decision 加权后应 ≥7，实际 ${withDecision.importance}`);
	});

	test('metadata.importance 直接优先', () => {
		const r = compressSynthetic('some content', { importance: 9 });
		assert.strictEqual(r.importance, 9);
	});

	test('事实提取按句子分割且过滤过短句', () => {
		const r = compressSynthetic('This is a sufficiently long first sentence for facts. Short. Another reasonably long sentence follows here.');
		assert.ok(r.facts.length >= 1);
		assert.ok(!r.facts.includes('Short.'), '过短句不应进入 facts');
	});

	test('narrative 截断 500 字符', () => {
		const r = compressSynthetic('x'.repeat(2000));
		assert.ok(r.narrative.length <= 500);
	});

	test('compress：短内容（<100 字符）直接 synthetic', async () => {
		const r = await compress('short text');
		assert.strictEqual(typeof r.title, 'string');
		assert.ok(r.importance >= 1 && r.importance <= 10);
	});

	test('compressWithLLM：未配置 LLM 时静默回退 synthetic（结构完整）', async () => {
		const r = await compressWithLLM('x'.repeat(150));
		assert.ok(typeof r.title === 'string' && r.title.length > 0);
		assert.ok(Array.isArray(r.facts) && Array.isArray(r.concepts) && Array.isArray(r.files));
	});
});
