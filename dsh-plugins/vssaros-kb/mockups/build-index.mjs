/*
 * 把 mockup-*.html **内联**进一个 index.html（2026-10-26）。
 *
 * 为什么要这个脚本：`<iframe src="mockup-a.html">` 在 IDE 的预览器 / 某些沙箱里是**空白**
 *   （file:// 子框架被拦，CSP 也可能禁止）。用户看到的是一排空框 ⇒ 以为没做出东西。
 * ⇒ 改成：抽取每个 mockup 的 `<style>` 与 `<body>`，把**类名加前缀**后内联到同一页，
 *   用原生 `<details>` 折叠（零 JS，预览器禁脚本也能看）。
 *
 * 为什么必须加前缀：四个方案都用了 `.pane/.hdr/.crumb` 等同名类，直接拼会互相污染。
 *
 * 跑法：node dsh-plugins/vssaros-kb/mockups/build-index.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const GALERIES = [
	{
		dir: 'right-pane',
		title: '知识库右侧栏 · 文档顶部固定栏（4 个方案）',
		desc: '现状：右栏只有一行不吸顶的标题（标题 + ●未保存·字数 + 编辑/历史），滚动后无任何上下文。参照 IDE 侧 '
			+ '<code>kbMarkdown</code> 的 <code>kb-toolbar</code> 与编辑器面包屑。每块都可滚动，验证吸顶效果。',
		items: [
			['a', 'A · 双行（面包屑 + 工具行）', '最贴近 IDE：上行面包屑+工具，下行标题+元信息+主动作'],
			['b', 'B · 单行（面包屑即标题）', '34px 一行，动作 hover 显影，正文顶部保留 H1'],
			['c', 'C · 多文档 Tab + 工具行', '62px：Tab 条 + 面包屑/工具行，可多篇并存'],
			['d', 'D · 极简细条 + 阅读进度', '28px，面包屑折叠 + 预览/编辑分段 + 进度线'],
		],
	},
	{
		dir: 'section-buttons',
		title: '知识库「笔记」节 · 按钮布局（4 个方案）',
		desc: '统一约束：面板宽 <b>340px</b>（真机最窄形态）、深色主题、按钮<b>不缩不断行</b>（这是当初被压成竖排单字的根因）。',
		items: [
			['a', 'A · 两行分层（图标化）', '节头留新建；第二行 = 排序下拉 + 4 个动作图标'],
			['b', 'B · 单行收纳（⋯ 更多）', '全部收进一行，低频动作进菜单（已实现）'],
			['c', 'C · 工具条常驻（胶囊 + 状态点）', '分组常驻可见，用状态点外显"有没有事"'],
			['d', 'D · 搜索行内联（Obsidian 风）', '动作移到搜索行，省一行高度'],
		],
	},
];

/** 给 class 加前缀（CSS 选择器与 HTML class 属性都要改） */
function scopeCss(css, p) {
	return css.replace(/\.([a-zA-Z_][\w-]*)/g, (_m, cls) => '.' + p + '-' + cls);
}
function scopeHtml(html, p) {
	return html.replace(/class="([^"]*)"/g, (_m, list) => {
		const next = list.split(/\s+/).filter(Boolean).map(c => p + '-' + c).join(' ');
		return 'class="' + next + '"';
	});
}

function extract(file) {
	const s = readFileSync(file, 'utf8');
	const style = /<style>([\s\S]*?)<\/style>/i.exec(s)?.[1] ?? '';
	let body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(s)?.[1] ?? '';
	// 去掉 mockup 自带的说明条（index 里用自己的 caption，避免重复）
	body = body.replace(/<div class="note">[\s\S]*?<\/div>\s*$/i, '');
	return { style, body };
}

for (const g of GALERIES) {
	const dir = join(HERE, g.dir);
	if (!existsSync(dir)) { console.log('  跳过（缺目录）：' + g.dir); continue; }
	const cssParts = [];
	const sections = [];

	for (const [key, name, desc] of g.items) {
		const file = join(dir, `mockup-${key}.html`);
		if (!existsSync(file)) { console.log('  跳过（缺文件）：' + file); continue; }
		const { style, body } = extract(file);
		const p = 'v' + key;                       // 前缀：va / vb / vc / vd
		cssParts.push(`/* ── ${name} ─────────────────────────── */`, scopeCss(style, p));
		sections.push(
			`<details class="item"${key === 'a' ? ' open' : ''}>`,
			`\t<summary><b>${name}</b><em>${desc}</em></summary>`,
			`\t<div class="demo ${p}-demo">${scopeHtml(body, p)}</div>`,
			`</details>`,
		);
	}

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${g.title}</title>
<style>
	:root{--fg:#cccccc;--dim:#9d9d9d;--line:#3c3c3c;--accent:#3794ff}
	*{box-sizing:border-box}
	body{margin:0;background:#121212;color:var(--fg);font:13px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;padding:18px 20px 40px}
	h1{font-size:16px;font-weight:600;margin:0 0 6px}
	.lead{margin:0 0 16px;color:var(--dim);font-size:12px;max-width:1100px}
	.item{border:1px solid var(--line);border-radius:6px;margin-bottom:12px;overflow:hidden;background:#161616}
	.item > summary{cursor:pointer;padding:9px 12px;font-size:12.5px;list-style:none;background:#1d1d1d;border-bottom:1px solid transparent}
	.item[open] > summary{border-bottom-color:var(--line)}
	.item > summary::-webkit-details-marker{display:none}
	.item > summary::before{content:"▸ ";color:var(--dim)}
	.item[open] > summary::before{content:"▾ "}
	.item > summary em{font-style:normal;color:var(--dim);font-size:11.5px;margin-left:8px}
	.demo{padding:14px;background:#121212;overflow:auto}
	/* 说明：下面这段是各 mockup 自己的样式（已加前缀，互不污染） */
${cssParts.join('\n')}
</style>
</head>
<body>
<h1>${g.title}</h1>
<p class="lead">${g.desc}<br>本页**不用 iframe**（IDE 预览器会拦 file:// 子框架 ⇒ 一片空白），四个方案已内联，点标题展开/收起。</p>
${sections.join('\n')}
</body>
</html>
`;

	writeFileSync(join(dir, 'index.html'), html, 'utf8');
	console.log(`  ✓ ${g.dir}/index.html  (${(html.length / 1024).toFixed(1)} KB，内联 ${sections.length / 5} 个方案)`);
}
