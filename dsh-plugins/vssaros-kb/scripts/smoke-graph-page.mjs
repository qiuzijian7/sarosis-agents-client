/*
 * 冒烟：真的跑一次 `renderGraphPage()`（含 shell 渲染）+ 真实库数据，并把它挂到一个临时 HTTP 服务上，
 * 供浏览器实测。
 *
 * ★ 为什么要有它（2026-10-19 教训）：上一轮我用"手抄一份 body + 直接引用 GRAPH_CSS/GRAPH_SCRIPT"
 *   的方式做 mock —— 那条路**绕过了 renderGraphPage 本身**，于是
 *   `vaultDisplayName is not defined`（handler 里引用了 renderPage 的局部函数）在本地完全没暴露，
 *   一直到真机点按钮才 500 ✗。本脚本走真实函数，能抓到这类"只有组装时才炸"的问题。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/smoke-graph-page.mjs [--no-serve]
 *   · 不带参数：校验 HTML 后起 http://127.0.0.1:9876/x/kb/graph（Ctrl+C 结束）
 *   · --no-serve：只校验、不起服务（可进 CI）
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildGraphData } from '../lib/core/kbGraphData.js';
import { readNotesForGraph } from '../lib/organize.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const NOTES_DIR = process.env.VSSAROS_SMOKE_NOTES_DIR || 'E:/VsSarosVault/笔记';
const serve = !process.argv.includes('--no-serve');

/**
 * 假 foundation（真实实现在 `@vssaros/dsh-foundation`，独立进程里没有）。
 * ⚠ 只实现本页用到的三个：renderShell / escapeHtml / renderChips。
 *   renderShell 的**行为要与真源一致**：把 extraCss 塞进 <style>、script 塞进 <script>、
 *   bodyHtml 原样拼进 body —— 否则"模板串是否被提前闭合"这类问题就测不出来。
 */
globalThis.__VSSAROS_FOUNDATION__ = {
	SHELL_CSS: 'body{margin:0;background:#1e1e1e;color:#ccc;font-family:system-ui,sans-serif}',
	escapeHtml: (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
	renderChips: () => '',
	renderShell: ({ kind, title, subtitle = '', headerHtml = '', toolbarHtml = '', chipsHtml = '', bodyHtml = '', attrs = '', extraCss = '', script = '', lang = 'zh' }) => {
		const head = subtitle ? `${title} <small>${subtitle}</small>` : title;
		return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title} · VsSaros</title>`
			+ `<style>${globalThis.__VSSAROS_FOUNDATION__.SHELL_CSS}${extraCss}</style></head>`
			+ `<body data-vssaros-page="${kind}"${attrs ? ' ' + attrs : ''}>`
			+ `${headerHtml || `<div class="dsh-header"><h1>${head}</h1></div>`}${toolbarHtml}${chipsHtml}${bodyHtml}`
			+ `${script ? `<script>${script}</script>` : ''}</body></html>`;
	},
};

// 必须在设好 fake foundation **之后**再 import（pageShell 的 live binding 读时求值，其实顺序不敏感，
// 但显式放后面更稳妥）
const { renderGraphPage } = await import('../lib/graphPage.js');

let fail = 0;
const ck = (name, ok, detail = '') => {
	if (ok) { console.log('PASS  ' + name + (detail ? '  — ' + detail : '')); }
	else { fail++; console.log('FAIL  ' + name + '  — ' + detail); }
};

// ── ① 页面 HTML（真实函数）─────────────────────────────────────────────────
const html = renderGraphPage({ vaultId: 'real', vaultName: '冒烟库', notesDir: NOTES_DIR });
ck('renderGraphPage 不抛错', typeof html === 'string' && html.length > 1000, html.length + ' 字符');
ck('含根容器与数据属性', html.includes('id="kb-graph-root"') && html.includes('data-notes-dir=') && html.includes('data-vault="real"'));
ck('含工具条按钮', ['kbg-rebuild', 'kbg-relayout', 'kbg-fit', 'kbg-orphans'].every(id => html.includes(`id="${id}"`)));
ck('含 canvas 与图例', html.includes('id="kbg-canvas"') && html.includes('id="kbg-legend"'));
ck('CSS 已注入（不是空 style）', html.includes('kbg-legend') && html.includes('position: absolute'));
ck('页面脚本已注入', html.includes('function simulate()') && html.includes("getElementById('kb-graph-root')"));
// ⚠ 关键：handler 里引用了渲染函数局部变量时，这里会变成字符串 "undefined"
ck('没有 undefined 字样（未定义引用会在组装期留下它）', !/\bundefined\b/.test(html.replace(/data-notes-dir="[^"]*"/, '')),
	(() => { const m = /undefined/.exec(html); return m ? '首个出现位置 ' + m.index : '干净'; })());
ck('没有 [object Object]', !html.includes('[object Object]'));

// ── ② 数据（真实库）───────────────────────────────────────────────────────
let data;
try {
	const notes = await readNotesForGraph(NOTES_DIR);
	data = buildGraphData(notes);
	ck('真实库建图', data.nodes.length > 0, `${data.stats.notes} 节点 / ${data.stats.edges} 连线 / ${data.stats.orphans} 孤点`);
	ck('节点带 id/label/group/degree', data.nodes.every(n => n.id && n.label && n.group && typeof n.degree === 'number'));
} catch (e) {
	ck('真实库建图', false, String(e?.message ?? e));
}

// ── ③ 可选：挂到临时服务上给浏览器用 ────────────────────────────────────────
if (serve) {
	http.createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');
		if (url.pathname === '/x/kb/api/graph') {
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			res.end(JSON.stringify({ ok: true, vaultId: 'real', vaultName: '冒烟库', notesDir: NOTES_DIR, cached: false,
				nodes: data?.nodes ?? [], edges: data?.edges ?? [], stats: data?.stats ?? {} }));
			return;
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(html);
	}).listen(9876, '127.0.0.1', () => {
		console.log('\nserving http://127.0.0.1:9876/x/kb/graph  （Ctrl+C 结束）');
	});
} else {
	console.log(fail ? `\n✗ ${fail} 条红` : '\n✓ 全部通过');
	process.exit(fail ? 1 : 0);
}
