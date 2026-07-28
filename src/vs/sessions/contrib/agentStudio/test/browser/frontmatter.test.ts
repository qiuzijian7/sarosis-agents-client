/*---------------------------------------------------------------------------------------------
 *  Frontmatter 解析与 sources 注入单元测试（P0-1）。
 *  覆盖 llm_wiki 对齐的健壮性场景：两遍解析、anywhere fallback、```yaml 栅栏包裹、
 *  wikilink-list 修复、单值/块/流 sources 注入、保留其他字段。
 *
 *  运行（从仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/frontmatter.test.ts
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	parseFrontmatter,
	locateFrontmatterBlock,
	repairWikilinkLists,
	extractSources,
	normalizeSourceRef,
	injectSources,
} from '../../browser/knowledge/frontmatter.js';

suite('AgentStudio - Frontmatter 解析与 sources 注入', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ── locateFrontmatterBlock（两遍解析）────────────────────────────────────────
	test('locateFrontmatterBlock strict 顶锚命中', () => {
		const c = '---\ntitle: A\n---\nbody';
		const loc = locateFrontmatterBlock(c)!;
		assert.ok(loc);
		assert.strictEqual(loc.yamlPayload, 'title: A');
		assert.strictEqual(loc.body, 'body');
	});

	test('locateFrontmatterBlock anywhere fallback 容忍前导杂行', () => {
		// LLM 在 frontmatter 前塞了一行杂行
		const c = 'junk\n---\ntitle: A\n---\nbody';
		const loc = locateFrontmatterBlock(c)!;
		assert.ok(loc, '前 6 行内的 --- 应被 anywhere 命中');
		assert.strictEqual(loc.yamlPayload, 'title: A');
		assert.strictEqual(loc.body, 'body');
	});

	test('locateFrontmatterBlock 拒绝 body 深处的 --- 水平线', () => {
		// 开 fence 在 6 行之后 → 不应误判
		const c = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\n---\ntitle: A\n---\nbody';
		const loc = locateFrontmatterBlock(c);
		assert.strictEqual(loc, null, '开 fence 超过 6 行前缀不应被识别为 frontmatter');
	});

	test('locateFrontmatterBlock 剥离 ```yaml 代码栅栏包裹', () => {
		const c = '```yaml\n---\ntitle: A\n---\n```\nbody';
		const loc = locateFrontmatterBlock(c)!;
		assert.ok(loc);
		assert.strictEqual(loc.yamlPayload, 'title: A');
		assert.ok(!loc.body.startsWith('```'), 'body 不应残留代码栅栏');
		assert.ok(loc.body.includes('body'));
	});

	// ── repairWikilinkLists ─────────────────────────────────────────────────────
	test('repairWikilinkLists 修复裸 wikilink 列表为合法 YAML', () => {
		const payload = 'sources: [[a]], [[b]], [[c]]';
		const repaired = repairWikilinkLists(payload);
		assert.strictEqual(repaired, 'sources: ["[[a]]", "[[b]]", "[[c]]"]');
	});

	test('repairWikilinkLists 不动合法嵌套', () => {
		const payload = 'tags: [[red, blue]]';
		assert.strictEqual(repairWikilinkLists(payload), payload);
	});

	// ── parseFrontmatter ────────────────────────────────────────────────────────
	test('parseFrontmatter 解析块序列与流列表', () => {
		const c = '---\ntitle: A\ntags: [x, y]\nsources:\n  - a\n  - b\n---\nbody';
		const { frontmatter, body } = parseFrontmatter(c);
		assert.deepStrictEqual(frontmatter?.['title'], 'A');
		assert.deepStrictEqual(frontmatter?.['tags'], ['x', 'y']);
		assert.deepStrictEqual(frontmatter?.['sources'], ['a', 'b']);
		assert.strictEqual(body, 'body');
	});

	// ── extractSources / normalizeSourceRef ─────────────────────────────────────
	test('extractSources 归一化为库文件 basename（小写，去 库/ 与括号）', () => {
		const c = '---\nsources:\n  - "库/LibA.md"\n  - "[[库/LibB.md]]"\n---\nbody';
		const r = extractSources(c).sort();
		assert.deepStrictEqual(r, ['liba.md', 'libb.md']);
	});

	test('extractSources 流列表单元素带双括号也能归一化', () => {
		// P3 暴露的脆弱点：sources: [[库/Lib2.md]]
		const c = '---\nsources: [[库/Lib2.md]]\n---\nbody';
		assert.deepStrictEqual(extractSources(c), ['lib2.md']);
	});

	test('extractSources 无 frontmatter / 缺 sources → 空数组', () => {
		assert.deepStrictEqual(extractSources('# 标题\n正文'), []);
		assert.deepStrictEqual(extractSources('---\ntitle: x\n---\n正文'), []);
	});

	test('normalizeSourceRef 剥多层括号与引号', () => {
		assert.strictEqual(normalizeSourceRef('"[[库/X.md]]"'), 'x.md');
		assert.strictEqual(normalizeSourceRef('[Y]'), 'y');
	});

	// ── injectSources ───────────────────────────────────────────────────────────
	test('injectSources 无 frontmatter → 新建', () => {
		const { content, changed } = injectSources('正文', '[[库/L.md]]', 'L.md');
		assert.strictEqual(changed, true);
		assert.ok(content.startsWith('---\nsources:\n  - [[库/L.md]]\n---\n'));
		assert.ok(content.includes('正文'));
	});

	test('injectSources 缺 sources → 顶部插入且保留其他字段', () => {
		const c = '---\ntitle: A\ntags: [x]\n---\nbody';
		const { content, changed } = injectSources(c, '[[库/L.md]]', 'L.md');
		assert.strictEqual(changed, true);
		assert.ok(content.includes('sources:'));
		assert.ok(content.includes('  - [[库/L.md]]'));
		assert.ok(content.includes('title: A'), '其他字段应保留');
		assert.ok(content.includes('tags: [x]'), '其他字段应保留');
		assert.ok(content.includes('body'));
	});

	test('injectSources 块序列追加', () => {
		const c = '---\nsources:\n  - "[[库/A.md]]"\n---\nbody';
		const { content, changed } = injectSources(c, '[[库/B.md]]', 'B.md');
		assert.strictEqual(changed, true);
		assert.ok(content.includes('  - "[[库/A.md]]"'));
		assert.ok(content.includes('  - [[库/B.md]]'));
	});

	test('injectSources 流列表追加', () => {
		const c = '---\nsources: ["[[库/A.md]]"]\n---\nbody';
		const { content, changed } = injectSources(c, '[[库/B.md]]', 'B.md');
		assert.strictEqual(changed, true);
		assert.ok(content.includes('sources: ["[[库/A.md]]", "[[库/B.md]]"]'));
	});

	test('injectSources 单值转块序列', () => {
		const c = '---\nsources: "[[库/A.md]]"\n---\nbody';
		const { content, changed } = injectSources(c, '[[库/B.md]]', 'B.md');
		assert.strictEqual(changed, true);
		assert.ok(content.includes('  - [[库/A.md]]'));
		assert.ok(content.includes('  - [[库/B.md]]'));
	});

	test('injectSources 已含 refBase → 不变', () => {
		const c = '---\nsources:\n  - "[[库/L.md]]"\n---\nbody';
		const { content, changed } = injectSources(c, '[[库/L.md]]', 'L.md');
		assert.strictEqual(changed, false);
		assert.strictEqual(content, c);
	});

	test('injectSources 保留 LLM 损坏前缀的 body', () => {
		// 前导杂行 + frontmatter
		const c = 'junk\n---\nsources:\n  - "[[库/A.md]]"\n---\nbody';
		const { content, changed } = injectSources(c, '[[库/B.md]]', 'B.md');
		assert.strictEqual(changed, true);
		assert.ok(content.includes('  - [[库/B.md]]'));
		assert.ok(content.includes('body'));
	});
});
