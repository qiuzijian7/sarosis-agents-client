/*---------------------------------------------------------------------------------------------
 *  enrichWikilinks 单元测试（P2-2）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { enrichContent } from '../../browser/knowledge/enrichWikilinks.js';

suite('AgentStudio - enrichWikilinks 自动补链', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('正文出现已有笔记标题 → 包裹为 [[wikilink]]', () => {
		const titles = new Map([['gc性能', 'GC性能']]);
		const content = '本文讨论 GC性能 的实现。';
		const { newContent, added } = enrichContent(content, titles, '当前笔记');
		assert.ok(added.includes('GC性能'));
		assert.ok(newContent.includes('[[GC性能]]'));
	});

	test('已有 [[wikilink]] → 不重复包裹', () => {
		const titles = new Map([['gc性能', 'GC性能']]);
		const content = '见 [[GC性能]] 一文。GC性能 很重要。';
		const { newContent, added } = enrichContent(content, titles, '当前');
		// 已有链接则整体跳过该标题
		assert.ok(!added.includes('GC性能'));
		assert.strictEqual(newContent, content);
	});

	test('代码块内的标题不包裹', () => {
		const titles = new Map([['foo', 'Foo']]);
		const content = '正文\n```\nFoo = 1\n```\n结尾';
		const { newContent, added } = enrichContent(content, titles, '当前');
		assert.ok(!added.includes('Foo'), '代码块内不应包裹');
		assert.ok(!newBodyHasLinkInCode(newContent), '代码块内不应出现 [[Foo]]');
	});

	test('不包裹自身标题', () => {
		const titles = new Map([['self', 'Self'], ['other', 'Other']]);
		const content = 'Self 与 Other 都出现';
		const { added } = enrichContent(content, titles, 'Self');
		assert.ok(added.includes('Other'));
		assert.ok(!added.includes('Self'), '自身标题不应包裹');
	});

	test('frontmatter 内的标题不被包裹', () => {
		const titles = new Map([['target', 'Target']]);
		const content = '---\ntitle: Target\n---\n正文中 Target 出现';
		const { newContent, added } = enrichContent(content, titles, '当前');
		assert.ok(added.includes('Target'));
		assert.ok(newContent.includes('正文中 [[Target]] 出现'));
		assert.ok(newContent.includes('title: Target'), 'frontmatter 不变');
	});

	function newBodyHasLinkInCode(c: string): boolean {
		const m = c.match(/```\n[\s\S]*?\n```/);
		return !!m && m[0].includes('[[');
	}
});
