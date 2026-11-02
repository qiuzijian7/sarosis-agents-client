// 生成 doc/media-library-responsive/index.html。
//
// 为什么要有这一步：mockup 里的 CSS 必须是**真实样式**，不能手抄近似版。两处都从源码抽：
//   ① 「A 现状」= MEDIA_CSS 去掉 2026-11-02 新加的「窄窗口」小节（= 用户报 bug 时的渲染）；
//   ② 「B 推荐」  = 那一节的真身。
// 所以这个 mockup 不会随生产代码漂：改了 mediaPage.js 重跑一次就对齐（两节缺一段都会报错）。
//
// 用法：node doc/media-library-responsive/make.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const pageFile = path.join(repo, 'dsh-plugins/vssaros-media/lib/mediaPage.js');
const shellFile = path.join(here, 'shell.html');
const outFile = path.join(here, 'index.html');

// ── 窄窗口小节的首尾标记（在 mediaPage.js 里唯一）──────────────────────────────
const B_START = '/* ── 窄窗口：工具条两段式';
const B_END = '/* 窄容器（IDE 中栏 ~700 / 侧栏 ~340）';

const src = fs.readFileSync(pageFile, 'utf8');
const head = 'export const MEDIA_CSS = `';
const at = src.indexOf(head);
if (at < 0) { throw new Error('在 mediaPage.js 里找不到 MEDIA_CSS 定义'); }
const from = at + head.length;
const end = src.indexOf('\n`;', from);
if (end < 0) { throw new Error('MEDIA_CSS 的结尾标记（行首 `;）没找到'); }
const css = src.slice(from, end).replace(/\r\n/g, '\n');

const bAt = css.indexOf(B_START);
const bEndAt = css.indexOf(B_END, bAt);
if (bAt < 0 || bEndAt < 0) { throw new Error('MEDIA_CSS 里找不到「窄窗口」小节（标记：' + B_START + ' … ' + B_END + '）'); }
const cssB = css.slice(bAt, bEndAt).trim();
if (!cssB.includes('.m-actions') || !cssB.includes('.m-filters')) {
	throw new Error('「窄窗口」小节里没有 .m-filters / .m-actions —— 抽出来的不是那一段');
}
// A 现状 = 去掉这一节（等价于用户报 bug 时的渲染）
const cssNow = (css.slice(0, bAt) + css.slice(bEndAt)).trim();

const shell = fs.readFileSync(shellFile, 'utf8');
for (const marker of ['__CSS_NOW__', '__CSS_B_LIVE__']) {
	if (!shell.includes(marker)) { throw new Error('shell.html 缺少 ' + marker + ' 占位'); }
}

const out = shell
	.replace('__CSS_NOW__', JSON.stringify(cssNow))
	.replace('__CSS_B_LIVE__', JSON.stringify(cssB));
fs.writeFileSync(outFile, out, 'utf8');

// 自检：注入后不能残留占位、且 CSS 里不该出现反引号（会被模板字符串截断的经典坑）
const check = fs.readFileSync(outFile, 'utf8');
if (check.includes('__CSS_NOW__') || check.includes('__CSS_B_LIVE__')) { throw new Error('注入失败：占位仍在'); }
if (css.includes('`')) { throw new Error('MEDIA_CSS 里出现反引号 —— 上游模板字符串已损坏'); }
if (!check.includes('.m-chips')) { throw new Error('注入后 index.html 里没有 .m-chips（CSS 没进来）'); }

// ★ 只做语法检查（不执行）：模板字符串里写反引号会把整段截断，页面能开但脚本不跑，
//   表现为「控件都在、点了没反应」——这一坑本仓踩过多次，这里用 vm 编译提前拦下。
const scriptBody = /<script>([\s\S]*)<\/script>/.exec(check)?.[1] ?? '';
if (!scriptBody) { throw new Error('index.html 里没找到 <script> 段'); }
try {
	new vm.Script(scriptBody, { filename: 'index.html#script' });
} catch (error) {
	throw new Error('mockup 脚本语法错误（多半是模板字符串里出现了反引号）：' + error.message);
}

console.log(`ok  ${path.relative(repo, outFile)}  (MEDIA_CSS ${css.length} 字符 / B 小节 ${cssB.length} 字符)`);
