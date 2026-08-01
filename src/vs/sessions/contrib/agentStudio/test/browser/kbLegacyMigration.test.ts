import * as assert from 'assert';
import { renderLegacyNote, extractLegacyKbText, sanitizeFilename } from '../../browser/knowledge/kbLegacyMigration.js';

suite('kbLegacyMigration（纯函数契约）', () => {
	test('extractLegacyKbText: data.items → 渲染全部字段', () => {
		const payload = {
			metadata: { id: 'abc', title: '我的笔记', type: 'list' },
			data: { items: [
				{ title: '条目一', content: '这是内容', tags: ['a', 'b'] },
				{ name: '条目二', desc: '另一个' },
			] },
		};
		const text = extractLegacyKbText(payload);
		assert.ok(text.includes('条目一'), '应包含条目一');
		assert.ok(text.includes('这是内容'), '应包含内容');
		assert.ok(text.includes('条目二'), '应包含条目二');
	});

	test('extractLegacyKbText: data.nodes → 渲染 label 与其余字段', () => {
		const payload = { data: { nodes: [
			{ label: '节点A', kind: 'person', note: '说明文字' },
		] } };
		const text = extractLegacyKbText(payload);
		assert.ok(text.includes('节点A'), '应包含 label');
		assert.ok(text.includes('说明文字'), '应包含节点说明');
	});

	test('extractLegacyKbText: 未知结构 → 递归收集可读字符串', () => {
		const payload = { foo: 'hello', bar: { baz: 'world' }, skip: { embedding: [1, 2, 3] } };
		const text = extractLegacyKbText(payload);
		assert.ok(text.includes('hello'));
		assert.ok(text.includes('world'));
		assert.ok(!text.includes('1'), '不应收集 embedding 数组');
	});

	test('renderLegacyNote: 无文本 → 内嵌原始 JSON 兜底（数据零丢失）', () => {
		const note = renderLegacyNote({});
		assert.ok(note.markdown.includes('```json'), '应内嵌 JSON');
		assert.ok(note.markdown.includes('migratedFrom: hyper-extract'), '应带迁移 frontmatter');
	});

	test('renderLegacyNote: title 优先取 metadata.title', () => {
		const { title, markdown } = renderLegacyNote({
			metadata: { id: 'x', title: 'T 标题' },
			data: { text: '正文内容' },
		});
		assert.strictEqual(title, 'T 标题');
		assert.ok(markdown.includes('# T 标题'), '标题应进 H1');
		assert.ok(markdown.includes('正文内容'), '应包含正文');
	});

	test('sanitizeFilename: 去除非法字符并限制长度', () => {
		assert.strictEqual(sanitizeFilename('a/b:c*?'), 'a_b_c__');
		assert.ok(sanitizeFilename('x'.repeat(200)).length <= 80);
		assert.strictEqual(sanitizeFilename(''), 'legacy-kb-session');
	});
});
