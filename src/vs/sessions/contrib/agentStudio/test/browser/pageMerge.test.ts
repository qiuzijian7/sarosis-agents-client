/*---------------------------------------------------------------------------------------------
 *  pageMerge 单元测试（P1-2）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mergeFrontmatter, mergeBody } from '../../browser/knowledge/pageMerge.js';

suite('AgentStudio - pageMerge 合并写', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('mergeFrontmatter incoming 覆盖同名字段，保留 old 独有字段', () => {
		const old = { title: '旧标题', tags: ['a'], custom: '用户手改' };
		const incoming = { title: '新标题', sources: ['x.md'] };
		const r = mergeFrontmatter(old, incoming);
		assert.strictEqual(r.title, '新标题');
		assert.strictEqual(r.custom, '用户手改');
		assert.deepStrictEqual(r.sources, ['x.md']);
		assert.deepStrictEqual(r.tags, ['a']);
	});

	test('mergeBody 保留 old 独有段落，incoming 覆盖同名段', () => {
		const old = '前置\n## A\nold A\n## B\nold B';
		const incoming = '## A\nnew A\n## C\nnew C';
		const r = mergeBody(old, incoming);
		assert.ok(r.includes('## A\nnew A'), 'A 段被 incoming 覆盖');
		assert.ok(r.includes('## B\nold B'), 'B 段（old 独有）保留');
		assert.ok(r.includes('## C\nnew C'), 'C 段（incoming 独有）追加');
	});

	test('mergeBody 前置段落保留', () => {
		const r = mergeBody('前置正文\n## A\nA', '## A\nnew A');
		assert.ok(r.startsWith('前置正文'), '前置正文保留');
		assert.ok(r.includes('## A\nnew A'));
	});
});
