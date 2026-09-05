/*---------------------------------------------------------------------------------------------
 *  visual/canvas.spec.mjs — 画布沙箱的**自动验收**（P3）。
 *
 *  产出 LLM 可消费的 `visual/canvas/report.json` + `report.md`：
 *    判定链：`run.ok === false` 或 `ui.pageErrors.length > 0` → 有错 → 回改 → 重跑
 *
 *  用法：
 *    node visual/canvas.spec.mjs                          默认图（两个 Prompt 串联）
 *    node visual/canvas.spec.mjs --fixture=graph/x.json   从 fixture 载入
 *    node visual/canvas.spec.mjs --type=ComfyTV.ImageStage
 *
 *  ★ 说明：连线走 `sandbox.connect()` 而非模拟鼠标拖拽。画布端口画在 canvas 上
 *    （非 DOM），鼠标拖拽要按 LiteGraph 内部坐标换算，脆弱且易碎；而 connect()
 *    与手拖走的是**同一条 store 路径**（setEdges → syncStoreToGraph → configure），
 *    验证价值等价。真实手拖由人在浏览器里做。
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 报告进 dist（产物目录，不入库）
const REPORT_DIR = path.join(__dirname, 'dist', 'canvas');
fs.mkdirSync(REPORT_DIR, { recursive: true });
const PORT = Number(process.env.CANVAS_PORT ?? 5599);
const BASE = `http://127.0.0.1:${PORT}/canvas/`;

const arg = (k, d) => {
	const hit = process.argv.find(a => a.startsWith(`--${k}=`));
	return hit ? hit.split('=').slice(1).join('=') : d;
};

const fixturePath = arg('fixture', '');
const nodeType = arg('type', 'Saros.Prompt');
const valuesJson = arg('values', '{"prompt":"a cinematic portrait of a cat, 85mm"}');

const fixture = fixturePath
	? JSON.parse(fs.readFileSync(path.resolve(fixturePath), 'utf8'))
	: {
		nodes: [
			{ id: 'n1', type: nodeType, values: JSON.parse(valuesJson), position: { x: 160, y: 140 } },
			{ id: 'n2', type: nodeType, values: JSON.parse(valuesJson), position: { x: 520, y: 140 } },
		],
		edges: [{ from: 'n1', to: 'n2', fromPort: 'output', toPort: 'input' }],
	};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const consoleErrors = [];
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') { consoleErrors.push(m.text()); } });

const t0 = Date.now();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__canvasReady === true, undefined, { timeout: 120000 });

// ── 载入图 ──────────────────────────────────────────────────────────────
await page.evaluate((g) => {
	window.__canvasSandbox.clearAll();
	window.__canvasSandbox.seed(g);
}, fixture);
await page.waitForTimeout(1200);

const canvasBox = await page.locator('#canvas-root canvas').first().boundingBox();
const lgNodes = await page.evaluate(() => {
	const c = window.__canvasSandbox.canvas();
	const inst = c && c.canvasInstance && c.canvasInstance();
	return inst && inst.graph ? inst.graph._nodes.length : -1;
});

// ── 运行 ────────────────────────────────────────────────────────────────
await page.evaluate(() => window.__canvasSandbox.runAll());
await page.waitForFunction(() => window.__canvasSandbox.getLastRun() !== null, undefined, { timeout: 120000 });
const run = await page.evaluate(() => window.__canvasSandbox.getLastRun());
const graph = await page.evaluate(() => window.__canvasSandbox.getGraph());

const shot = path.join(REPORT_DIR, 'screenshot.png');
await page.screenshot({ path: shot, fullPage: false });
await browser.close();

// ── 报告 ────────────────────────────────────────────────────────────────
const ok = !!run && run.ok === true && pageErrors.length === 0;
const report = {
	generatedAt: new Date().toISOString(),
	ok,
	durationMs: Date.now() - t0,
	graph: {
		nodes: graph.nodes.map(n => ({ id: n.id, type: n.type, position: n.position })),
		edges: graph.edges.map(e => ({
			from: e.source, to: e.target,
			...(e.sourceHandle ? { fromPort: e.sourceHandle } : {}),
			...(e.targetHandle ? { toPort: e.targetHandle } : {}),
		})),
	},
	run: run ? { ok: run.ok, order: run.order, nodes: run.nodes } : null,
	ui: {
		canvasRendered: !!canvasBox && canvasBox.width > 400 && canvasBox.height > 300,
		canvasSize: canvasBox ? { w: Math.round(canvasBox.width), h: Math.round(canvasBox.height) } : null,
		liteGraphNodeCount: lgNodes,
		consoleErrors,
		pageErrors,
		screenshot: shot,
	},
};

fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

const md = [
	'# 画布沙箱验收报告',
	'',
	`- 生成时间：${report.generatedAt}`,
	`- 结论：**${ok ? 'PASS' : 'FAIL'}**（${report.durationMs}ms）`,
	'',
	'## 图',
	'',
	'| # | id | type |',
	'|---|---|---|',
	...report.graph.nodes.map((n, i) => `| ${i + 1} | \`${n.id}\` | ${n.type} |`),
	'',
	`连线 ${report.graph.edges.length} 条` +
		(report.graph.edges.length
			? '：' + report.graph.edges.map(e => `\`${e.from}→${e.to}\``).join('、')
			: ''),
	'',
	'## 执行',
	'',
	'| # | id | type | status | upstreams | ms | error |',
	'|---|---|---|---|---|---|---|',
	...(run ? run.nodes.map((n, i) =>
		`| ${i + 1} | \`${n.id}\` | ${n.type} | ${n.status} | ${(n.upstreams ?? []).length} | ${n.durationMs ?? '-'} | ${n.error ?? ''} |`
	) : ['| — | — | — | 未执行 | | | |']),
	'',
	'## UI',
	'',
	`- 画布渲染：${report.ui.canvasRendered ? '是' : '否'}（${report.ui.canvasSize?.w ?? 0}×${report.ui.canvasSize?.h ?? 0}）`,
	`- LiteGraph 节点数：${report.ui.liteGraphNodeCount}`,
	`- 控制台错误：${consoleErrors.length}`,
	`- 页面异常：${pageErrors.length}`,
	'',
	...(consoleErrors.length ? ['```', ...consoleErrors.slice(0, 20), '```', ''] : []),
	...(pageErrors.length ? ['```', ...pageErrors.slice(0, 20), '```', ''] : []),
	'',
].join('\n');
fs.writeFileSync(path.join(REPORT_DIR, 'report.md'), md, 'utf8');

console.log(`[canvas] ${ok ? 'PASS' : 'FAIL'}  ${report.durationMs}ms`);
console.log(`[canvas] 节点 ${report.graph.nodes.length} · 连线 ${report.graph.edges.length} · LiteGraph ${lgNodes}`);
if (run) {
	for (const n of run.nodes) {
		console.log(`  ${n.status === 'success' ? '✓' : '✗'} ${n.type} [${n.id}] ${n.durationMs}ms` +
			(n.upstreams?.length ? `  上游 ${n.upstreams.length}` : '') + (n.error ? `  — ${n.error}` : ''));
	}
}
if (pageErrors.length) { console.log('[canvas] 页面异常：\n  ' + pageErrors.slice(0, 5).join('\n  ')); }
if (consoleErrors.length) { console.log('[canvas] 控制台错误：\n  ' + consoleErrors.slice(0, 5).join('\n  ')); }
console.log(`[canvas] 报告 → ${path.join(REPORT_DIR, 'report.json')}`);

process.exit(ok ? 0 : 1);
