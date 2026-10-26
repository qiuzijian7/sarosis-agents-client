/*
 * 守卫：**服务端 Markdown 渲染**（`lib/md/render.js`，2026-10-25）。
 *
 * 这轮引入 markdown-it（仓库已 vendored）+ 自写三条 Obsidian 规则。
 * 换解析器最大的风险是"某些语法悄悄变了" ⇒ 这里用**真渲染 + HTML 断言**把
 * 真实库里出现过的每一种语法钉住（数量取自 82 篇笔记的扫描结果）。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-md-node.mjs
 */
import { renderMarkdownHtml } from '../lib/md/render.js';

let pass = 0;
const failed = [];
const t = (name, cond, extra = '') => {
	if (cond) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};
const h = (md, ctx) => renderMarkdownHtml(md, ctx).html;

// ① frontmatter（真机 77 篇）
{
	const r = renderMarkdownHtml(['---', 'title: 我的手记', 'tags: [a, b]', '---', '', '# 正文标题', '', '正文一段'].join('\n'));
	t('frontmatter 被剥离', !r.html.includes('title:'), r.html.slice(0, 80));
	t('frontmatter 原文可取回', r.frontmatter.includes('title: 我的手记'));
	t('frontmatter 之后的标题正常', r.html.includes('正文标题'));
}
// ② Callout（189 处）
{
	const r = h('> [!note]\n> 这是提示内容');
	t('Callout 标记不裸露', !r.includes('[!note]'), r.slice(0, 120));
	t('Callout 带类型与中文标题', r.includes('data-callout="note"') && r.includes('data-callout-title="注意"'));
	t('Callout 正文保留', r.includes('这是提示内容'));
	t('Callout 有 class', r.includes('kb-callout'));
	const r2 = h('> [!warning]\n> 危险');
	t('warning 类型标题为「警告」', r2.includes('data-callout-title="警告"'));
}
// ③ 双链（790 处）
{
	const hit = h('见 [[笔记A]] 与 [[笔记A|别名]]', { resolveWiki: (k) => (k === '笔记A' ? 'E:/v/笔记/笔记A.md' : undefined) });
	t('双链解析成 data-wiki 链接', hit.includes('data-wiki="E:/v/笔记/笔记A.md"'));
	t('双链支持 |别名', hit.includes('>别名</a>'));
	const miss = h('见 [[不存在]]', { resolveWiki: () => undefined });
	t('未解析的双链不当链接', miss.includes('kb-wiki-missing') && !miss.includes('data-wiki'));
}
// ④ 任务清单（30 处）+ 行号要能对上磁盘行
{
	const md = ['---', 'title: t', '---', '', '- [ ] 未完成', '- [x] 已完成'].join('\n');
	const r = h(md);
	t('任务清单渲染为 checkbox', r.includes('type="checkbox"') && r.includes('class="kb-task"'));
	t('未完成无 checked', /data-task-line="4"(?![^>]*checked)/.test(r));
	t('已完成带 checked', /data-task-line="5"[^>]*checked/.test(r));
	t('任务清单不再残留 [ ] 文本', !r.includes('[ ]'));
}
// ⑤ 表格（694 行）
{
	const r = h('| 列A | 列B |\n| --- | ---: |\n| 1 | 2 |');
	t('表格渲染', r.includes('<table class="kb-table"') && r.includes('<th'));
	t('表格右对齐生效', r.includes('text-align:right'));
}
// ⑥ 代码块（73 处）
{
	const r = h('```js\nconst a = "<b>";\n```');
	t('代码块带语言 class', r.includes('kb-code lang-js'));
	t('代码内容被转义', r.includes('&lt;b&gt;') && !r.includes('<b>'));
}
// ⑦ 嵌套列表（584 处）
{
	const r = h('- 一级\n  - 二级\n    - 三级');
	t('嵌套列表三层都在', r.includes('一级') && r.includes('二级') && r.includes('三级'));
	t('嵌套产生 3 个 ul', (r.match(/<ul>/g) ?? []).length === 3, '实际 ' + (r.match(/<ul>/g) ?? []).length);
}
// ⑧ 行内数学（16 处）
{
	const r = renderMarkdownHtml('能量 $E=mc^2$ 守恒');
	t('行内数学走 KaTeX', r.html.includes('class="katex"'));
	t('含公式时 math 标记为真', r.math === true);
	const r2 = renderMarkdownHtml('没有公式的一段');
	t('无公式时 math 为假', r2.math === false);
}
// ⑨ 安全基线：原始 HTML 必须转义（html:false）
{
	const r = h('<div onclick="alert(1)">x</div><script>bad()</script>');
	t('原始 HTML 被转义', r.includes('&lt;div') && !r.includes('<div'));
	t('script 不落成标签', !r.includes('<script'));
}
// ⑩ 自动链接与分隔线
{
	t('裸 URL 变链接', h('见 https://example.com/x 结束').includes('href="https://example.com/x"'));
	// 开头单独的 `---` 会被 frontmatter 规则吃掉，测真分隔线要用两段之间
	t('分隔线渲染', h('段落一\n\n---\n\n段落二').includes('<hr>'));
}

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（服务端 Markdown 渲染）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（服务端 Markdown 渲染）`);
