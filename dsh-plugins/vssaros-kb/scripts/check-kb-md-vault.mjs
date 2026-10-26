/*
 * 守卫：**真实库全文渲染覆盖扫描**（2026-10-25）。
 *
 * 前两个渲染守卫用的是**人造样本**（覆盖已知语法）。这一条反过来：把真实库里的
 * 每一篇 `.md` 都过一遍渲染器，然后检查 HTML 里**还有没有残留的原始标记**——
 * 残留意味着"这个语法没被解析"，这正是用户报"渲染不对"时最难自查的一类问题。
 *
 * 检查项（都先剥掉 <pre>/<code> 内部，避免把代码里的符号误判）：
 *   `[[` / `]]`  双链没解析
 *   `[!`         Callout 没解析
 *   `**`         粗体没解析
 *   `~~`         删除线没解析
 *   `| ---`      表格没解析
 *
 * 库路径默认 `E:/VsSarosVault/笔记`；不存在则跳过（CI 环境没有真库时不算失败）。
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-md-vault.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { renderMarkdownHtml } from '../lib/md/render.js';

const ROOT = process.env.KB_VAULT_NOTES || 'E:/VsSarosVault/笔记';

if (!existsSync(ROOT)) {
	console.log(`（跳过）未找到真实库：${ROOT}`);
	process.exit(0);
}

const files = [];
(function walk(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name.startsWith('.')) { continue; }
		const p = join(dir, e.name);
		if (e.isDirectory()) { walk(p); } else if (/\.md$/i.test(e.name)) { files.push(p); }
	}
})(ROOT);

const PATTERNS = [
	{ key: '双链未解析', re: /\[\[/g },
	{ key: '双链未闭合', re: /\]\]/g },
	{ key: 'Callout 未解析', re: /\[!/g },
	{ key: '粗体未解析', re: /\*\*/g },
	{ key: '删除线未解析', re: /~~/g },
	{ key: '表格未解析', re: /\|\s*-{3,}/g },
];

const strip = (html) => String(html)
	.replace(/<pre[\s\S]*?<\/pre>/g, '')
	.replace(/<code[\s\S]*?<\/code>/g, '');

const totals = new Map(PATTERNS.map(p => [p.key, 0]));
const offenders = [];
let okCount = 0;
let mathCount = 0;
let tableCount = 0;
let calloutCount = 0;
let wikiCount = 0;

for (const file of files) {
	let src = '';
	try { src = readFileSync(file, 'utf8'); } catch { continue; }
	let html = '';
	try {
		const r = renderMarkdownHtml(src, { resolveWiki: () => undefined });
		html = r.html;
		if (r.math) { mathCount += 1; }
	} catch (e) {
		offenders.push({ file, key: '渲染抛错', n: 1, err: String(e?.message ?? e) });
		continue;
	}
	tableCount += (html.match(/<table class="kb-table"/g) ?? []).length;
	calloutCount += (html.match(/kb-callout/g) ?? []).length;
	wikiCount += (html.match(/kb-wiki-missing|kb-wiki"/g) ?? []).length;

	const body = strip(html);
	let bad = false;
	for (const { key, re } of PATTERNS) {
		const n = (body.match(re) ?? []).length;
		if (n > 0) {
			totals.set(key, (totals.get(key) ?? 0) + n);
			offenders.push({ file, key, n });
			bad = true;
		}
	}
	if (!bad) { okCount += 1; }
}

console.log(`  扫描 ${files.length} 篇（干净 ${okCount} 篇）`);
console.log(`  渲染产出：表格 ${tableCount} 个 · Callout ${calloutCount} 个 · 双链 ${wikiCount} 个 · 含公式 ${mathCount} 篇`);

const totalLeft = [...totals.values()].reduce((a, b) => a + b, 0);
if (totalLeft > 0) {
	for (const [k, v] of totals) {
		if (v > 0) { console.log(`  ✗ ${k}：${v} 处`); }
	}
	for (const o of offenders.slice(0, 8)) {
		console.log(`    ${o.key} x${o.n}  ${o.file.replace(ROOT, '…')}${o.err ? '  (' + o.err + ')' : ''}`);
	}
	console.log('='.repeat(60));
	console.log(`✗ ${totalLeft} 处残留（共 ${files.length} 篇）`);
	process.exit(1);
}

console.log('='.repeat(60));
console.log(`✓ 全库无残留原始标记（${files.length} 篇）`);
