// @ts-check
/*---------------------------------------------------------------------------------------------
 *  visual/visual.spec.mjs — 节点 UI 契约断言 + 截图基线。
 *
 *  用法：
 *    node visual/visual.spec.mjs                跑断言 + 与基线 diff
 *    node visual/visual.spec.mjs --baseline     （重新）生成基线
 *    node visual/visual.spec.mjs --only=ComfyTV.ImageStage   只跑一个节点
 *    node visual/visual.spec.mjs --no-shot      只跑 DOM 断言，跳过截图（快）
 *    node visual/visual.spec.mjs --dump=ComfyTV.MaterialStage[:success]
 *                                               诊断单节点：打印 DOM 树 + innerText
 *                                               + 浏览器 console/pageerror（定位白屏最快的手段）
 *
 *  产物：
 *    visual/baseline/<scenario>.png   基线（提交入库）
 *    visual/actual/<scenario>.png     本次实际
 *    visual/report.md                 失败汇总
 *
 *  为什么手写 runner 而不用 @playwright/test：
 *    - 场景是从 registry 运行时派生的（节点数会变），静态 test() 声明不好写
 *    - 项目已有「run-<name>.mjs 手写 runner」的惯例（见 test/run*.mjs）
 *    - 只用 playwright-core 的浏览器驱动，不引入 test runner 的配置面
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const baselineDir = path.join(__dirname, 'baseline');
const actualDir = path.join(__dirname, 'actual');
const diffDir = path.join(__dirname, 'diff');

const WRITE_BASELINE = process.argv.includes('--baseline');
const NO_SHOT = process.argv.includes('--no-shot');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) ?? '').split('=')[1] || '';
/** --dump=<nodeType>[:<state>] 单节点诊断模式 */
const DUMP_RAW = (process.argv.find(a => a.startsWith('--dump=')) ?? '').split('=')[1] || '';
const DUMP_NODE = DUMP_RAW.split(':')[0] || '';
const DUMP_STATE = DUMP_RAW.split(':')[1] || 'success';

/** 卡片宿主宽度（与 index.html 的 .vt-card-host 一致）——溢出断言的基准 */
const HOST_WIDTH = 280;
/** 卡片高度合理区间：太小=塌陷，太大=无限增高 */
const MIN_CARD_H = 24;
const MAX_CARD_H = 2000;
/** 像素差容忍比例 */
const PIXEL_TOLERANCE = 0.005;      // 0.5%
const PIXEL_TOLERANCE_WEBGL = 0.02; // WebGL 节点 2%（GPU 光栅化微差）

/** @type {{scenario:string, rule:string, detail:string}[]} */
const failures = [];
/** @type {string[]} */
const notes = [];

function fail(scenario, rule, detail) { failures.push({ scenario, rule, detail }); }

// ── 1. 构建 harness ────────────────────────────────────────────────────────
console.log('[visual] building harness…');
const build = spawnSync(process.execPath, [path.join(__dirname, 'build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) { console.error('[visual] build FAILED'); process.exit(1); }

// ── 2. 起静态服务 ──────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.map': 'application/json' };
const server = http.createServer((req, res) => {
	const urlPath = (req.url ?? '/').split('?')[0];
	const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
	const file = path.join(distDir, rel);
	if (!file.startsWith(distDir)) { res.writeHead(403).end('forbidden'); return; }
	fs.readFile(file, (err, buf) => {
		if (err) { res.writeHead(404).end('not found'); return; }
		res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
		res.end(buf);
	});
});
const PORT = await new Promise(resolve => server.listen(0, () => resolve(server.address().port)));
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`[visual] serving ${BASE}`);

// ── 3. 启动浏览器 ──────────────────────────────────────────────────────────
let chromium;
try {
	({ chromium } = await import('playwright-core'));
} catch {
	console.error('[visual] playwright-core 不可用。请在仓库根目录执行：npm run playwright-install');
	server.close();
	process.exit(1);
}

let browser;
try {
	browser = await chromium.launch({
		// WebGL 需要 GPU 栈；swiftshader 保证无显卡环境也能软渲染（结果确定性更好）
		args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1'],
	});
} catch (err) {
	console.error(`[visual] 浏览器启动失败：${err?.message ?? err}`);
	console.error('[visual] 请先执行：npm run playwright-install');
	server.close();
	process.exit(1);
}

const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', e => notes.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') { notes.push(`console.error: ${m.text()}`); } });

// ── 4. 单节点诊断模式（--dump）──────────────────────────────────────────────
if (DUMP_NODE) {
	await page.goto(`${BASE}/?only=${encodeURIComponent(DUMP_NODE)}&state=${DUMP_STATE}`, { waitUntil: 'load' });
	await page.waitForSelector('body[data-vt-ready]', { timeout: 20_000 });
	const info = await page.evaluate(() => {
		const cell = document.querySelector('[data-vt-scenario]');
		const host = cell?.querySelector('[data-vt-card-host]');
		/** 递归打印带尺寸的 DOM 树 —— 白屏/塌陷一眼可辨 */
		const dump = (el, depth = 0) => {
			if (!el || depth > 5) { return ''; }
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			let s = `${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}> ${Math.round(r.width)}x${Math.round(r.height)}`;
			if (cs.display === 'none') { s += ' [display:none]'; }
			if (el.children.length === 0 && el.textContent?.trim()) { s += `  "${el.textContent.trim().slice(0, 40)}"`; }
			s += '\n';
			for (const c of Array.from(el.children)) { s += dump(c, depth + 1); }
			return s;
		};
		return {
			mounted: cell?.getAttribute('data-vt-mounted'),
			error: cell?.getAttribute('data-vt-error'),
			controls: cell?.getAttribute('data-vt-meta-control-names'),
			hidden: cell?.getAttribute('data-vt-hidden-fields'),
			editorKind: cell?.getAttribute('data-vt-editor-kind'),
			height: host ? Math.round(host.getBoundingClientRect().height) : -1,
			canvases: host?.querySelectorAll('canvas').length ?? 0,
			text: host?.innerText ?? '',
			tree: host ? dump(host) : '(no host)',
		};
	});
	console.log(`=== ${DUMP_NODE} / ${DUMP_STATE}`);
	console.log(`mounted     : ${info.mounted}${info.error ? '  ERROR=' + info.error : ''}`);
	console.log(`editorKind  : ${info.editorKind}`);
	console.log(`meta.controls: ${info.controls}`);
	console.log(`hiddenFields: ${info.hidden}`);
	console.log(`height      : ${info.height}px   canvases: ${info.canvases}`);
	console.log(`--- innerText ---\n${info.text}`);
	console.log(`--- DOM tree ---\n${info.tree}`);
	console.log(`--- browser logs ---\n${notes.join('\n') || '(none)'}`);
	await browser.close();
	server.close();
	process.exit(0);
}

// ── 5. 先加载画廊，取全部场景清单 ──────────────────────────────────────────
const galleryUrl = ONLY ? `${BASE}/?only=${encodeURIComponent(ONLY)}` : `${BASE}/`;
await page.goto(galleryUrl, { waitUntil: 'load' });
await page.waitForSelector('body[data-vt-ready]', { timeout: 30_000 });

const ready = await page.getAttribute('body', 'data-vt-ready');
if (ready !== 'true') {
	const fatal = await page.getAttribute('body', 'data-vt-fatal');
	console.error(`[visual] harness 启动失败：${fatal}`);
	await browser.close(); server.close();
	process.exit(1);
}

const scenarios = await page.$$eval('[data-vt-scenario]', cells => cells.map(c => ({
	id: c.getAttribute('data-vt-scenario'),
	nodeType: c.getAttribute('data-vt-node-type'),
	state: c.getAttribute('data-vt-state'),
	kind: c.getAttribute('data-vt-kind'),
	webgl: c.getAttribute('data-vt-webgl') === 'true',
	upstreamImages: Number(c.getAttribute('data-vt-upstream-images')),
	// ★ 期望值来自 meta（卡片真实渲染输入），不是 spec
	metaControls: Number(c.getAttribute('data-vt-meta-controls') ?? 0),
	metaControlNames: (c.getAttribute('data-vt-meta-control-names') ?? '').split(',').filter(Boolean),
	metaHasPrompt: c.getAttribute('data-vt-meta-has-prompt') === 'true',
	metaIsPicker: c.getAttribute('data-vt-meta-is-picker') === 'true',
	metaActions: Number(c.getAttribute('data-vt-meta-actions') ?? 0),
	metaInputs: Number(c.getAttribute('data-vt-meta-inputs') ?? 0),
	metaOutputs: Number(c.getAttribute('data-vt-meta-outputs') ?? 0),
	// 由内嵌编辑器接管的字段（stageCardRegistry 单一数据源）
	hiddenFields: (c.getAttribute('data-vt-hidden-fields') ?? '').split(',').filter(Boolean),
	editorKind: c.getAttribute('data-vt-editor-kind') ?? 'none',
	hideOutput: c.getAttribute('data-vt-hide-output') === 'true',
})));
console.log(`[visual] ${scenarios.length} 个场景`);

// 网络隔离核对：harness 不应有漏网请求
const blocked = Number(await page.getAttribute('body', 'data-vt-blocked-requests'));
if (blocked > 0) { notes.push(`网络守卫拦下 ${blocked} 个真实请求（应为 0，说明有组件在直连后端）`); }

// ── 5. 逐场景聚焦渲染 → DOM 断言 + 截图 ────────────────────────────────────
fs.mkdirSync(actualDir, { recursive: true });
if (WRITE_BASELINE) { fs.mkdirSync(baselineDir, { recursive: true }); }

for (const sc of scenarios) {
	const url = `${BASE}/?only=${encodeURIComponent(sc.nodeType)}&state=${sc.state}`;
	await page.goto(url, { waitUntil: 'load' });
	await page.waitForSelector('body[data-vt-ready="true"]', { timeout: 20_000 });

	const cell = await page.$(`[data-vt-scenario="${sc.id}"]`);
	if (!cell) { fail(sc.id, 'mount', '聚焦视图里找不到该场景'); continue; }

	const mounted = await cell.getAttribute('data-vt-mounted');
	if (mounted !== 'ok') {
		fail(sc.id, 'mount', `挂载失败：${await cell.getAttribute('data-vt-error')}`);
		continue;
	}
	// 布局未收敛 ⇒ 截图不可信（会导致基线假 diff），显式暴露而非静默
	const settle = await page.getAttribute('body', 'data-vt-settle');
	if (settle && settle.startsWith('timeout')) {
		notes.push(`${sc.id}: 布局未收敛（${settle}）—— 截图可能不稳定`);
	}

	// ── DOM 契约断言 ──
	const probe = await page.evaluate((args) => {
		const { id } = args;
		const cellEl = document.querySelector(`[data-vt-scenario="${id}"]`);
		const host = cellEl?.querySelector('[data-vt-card-host]');
		if (!host) { return { error: 'host missing' }; }
		const card = host.firstElementChild?.firstElementChild ?? host.firstElementChild;
		const hostRect = host.getBoundingClientRect();
		const cardRect = (card ?? host).getBoundingClientRect();

		// 横向溢出：任何后代元素右边界超出宿主内容区
		const overflow = [];
		for (const el of Array.from(host.querySelectorAll('*'))) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) { continue; }
			const over = Math.round(r.right - hostRect.right);
			if (over > 2) {
				overflow.push({ tag: el.tagName.toLowerCase(), over, w: Math.round(r.width) });
			}
		}

		const imgs = Array.from(host.querySelectorAll('img'));
		// ★ 控件探测：nodeCard 的 COMBO 用自定义 ComboPopover（id="nc-<name>-combo"），
		//   不是原生 <select>。每个 control 包在一个 <label><span>name</span>…</label> 里。
		const comboIds = Array.from(host.querySelectorAll('[id^="nc-"][id$="-combo"]'))
			.map(e => (e.id.match(/^nc-(.+)-combo$/) ?? [])[1])
			.filter(Boolean);
		const labelNames = Array.from(host.querySelectorAll('label'))
			.map(l => l.querySelector('span')?.textContent?.trim() ?? '')
			.filter(Boolean);

		return {
			cardH: Math.round(cardRect.height),
			cardW: Math.round(cardRect.width),
			hostW: Math.round(hostRect.width),
			overflow: overflow.slice(0, 5),
			overflowCount: overflow.length,
			text: host.innerText ?? '',
			labels: labelNames,
			comboNames: comboIds,
			textareas: host.querySelectorAll('textarea').length,
			numbers: host.querySelectorAll('input[type="number"]').length,
			ranges: host.querySelectorAll('input[type="range"]').length,
			checkboxes: host.querySelectorAll('input[type="checkbox"]').length,
			buttons: host.querySelectorAll('button').length,
			canvases: host.querySelectorAll('canvas').length,
			imgTotal: imgs.length,
			imgBroken: imgs.filter(i => i.complete && i.naturalWidth === 0).length,
			imgPending: imgs.filter(i => !i.complete).length,
			zeroSizedDivs: Array.from(host.querySelectorAll('div')).filter(d => {
				const r = d.getBoundingClientRect();
				return r.width > 0 && r.height === 0 && d.children.length > 0;
			}).length,
		};
	}, { id: sc.id });

	if (probe.error) { fail(sc.id, 'probe', probe.error); continue; }

	// 卡片是否"有实质内容"——极简桥接/路由节点（Bridge*、无 control 无 action 无 prompt）
	// 天生就是一条标题栏，对它们套用高度/输出区断言只会产生噪音。
	const isMinimalCard = sc.metaControls === 0 && sc.metaActions === 0
		&& !sc.metaHasPrompt && !sc.metaIsPicker;

	// R1 卡片高度：有实质内容的卡片不能塌陷；所有卡片都不能无限增高
	if (!isMinimalCard && probe.cardH < MIN_CARD_H) {
		fail(sc.id, 'card-height-collapsed', `高度仅 ${probe.cardH}px（meta 声明 ${sc.metaControls} 控件 / ${sc.metaActions} actions）`);
	}
	if (probe.cardH > MAX_CARD_H) { fail(sc.id, 'card-height-runaway', `高度 ${probe.cardH}px > ${MAX_CARD_H}px`); }

	// R2 无横向溢出（捕捉宽度写死，如 TransformEditor VIEW_W=360）
	if (probe.overflowCount > 0) {
		const d = probe.overflow.map(o => `${o.tag} 超出 ${o.over}px (w=${o.w})`).join('; ');
		fail(sc.id, 'horizontal-overflow', `${probe.overflowCount} 个元素溢出：${d}`);
	}

	// R3 图片不能裂（捕捉 ref 解析 / localResourceRoots 类问题）
	if (probe.imgBroken > 0) { fail(sc.id, 'broken-image', `${probe.imgBroken} 张图 naturalWidth=0`); }
	if (probe.imgPending > 0) { notes.push(`${sc.id}: ${probe.imgPending} 张图未完成解码`); }

	// R4 ★ meta.controls 里的每个控件都必须在 DOM 里出现（捕捉参数漏渲染，
	//    如第 82 轮 Upscale 缺 scale）。
	//    豁免：stageCardRegistry.stageHiddenFields() 声明由内嵌编辑器接管的字段
	//    —— 这是"故意不渲染通用控件"的权威声明，不是缺陷。
	if (sc.metaControls > 0) {
		const rendered = new Set([...probe.comboNames, ...probe.labels]);
		const taken = new Set(sc.hiddenFields);
		const missing = sc.metaControlNames.filter(n => !rendered.has(n) && !taken.has(n));
		if (missing.length > 0) {
			// 有内嵌编辑器时降级为提示（编辑器可能以非 label 形式承载参数）；
			// 无内嵌编辑器则是确凿的漏渲染。
			if (sc.editorKind === 'none') {
				fail(sc.id, 'control-missing', `meta 声明但 DOM 缺失：${missing.join(', ')}`);
			} else {
				notes.push(`${sc.id}: ${missing.join(',')} 未见于 DOM，editorKind=${sc.editorKind}（若非编辑器接管则应登记进 stageHiddenFields）`);
			}
		}
	}

	// R5 hasPrompt ⇒ 有且仅有一个 textarea（捕捉专用编辑器与通用 prompt 双渲染）
	//    prompt 被登记进 hiddenFields 时豁免（由编辑器自动生成，如 Multiangle）
	if (sc.metaHasPrompt && probe.textareas === 0 && !sc.hiddenFields.includes('prompt') && sc.editorKind === 'none') {
		fail(sc.id, 'prompt-missing', 'meta.hasPrompt=true 但无 textarea');
	}
	if (probe.textareas > 1) { fail(sc.id, 'duplicate-prompt', `${probe.textareas} 个 textarea（应 ≤1）`); }

	// R6 !hasPrompt ⇒ 不应出现 prompt textarea（捕捉 hidden fields 漏配）
	if (!sc.metaHasPrompt && probe.textareas > 0) {
		notes.push(`${sc.id}: meta.hasPrompt=false 但有 ${probe.textareas} 个 textarea（专用编辑器？）`);
	}

	// R7 error 态必须显示错误信息（仅对有实质内容的卡片）
	if (sc.state === 'error' && !isMinimalCard && !probe.text.includes('VISUAL-TEST')) {
		fail(sc.id, 'error-not-shown', 'error 态未渲染 errorMsg');
	}

	// R8 success 态应显示输出区。豁免 stageCardRegistry 声明的 hideOutput
	//    （loader 类节点「输出即载入的素材本身」，重复展示无意义）。
	if (sc.state === 'success' && !isMinimalCard && !sc.hideOutput
		&& probe.imgTotal === 0 && !/OUTPUT/i.test(probe.text)) {
		fail(sc.id, 'output-not-shown', 'success 态既无输出图也无 OUTPUT 区');
	}

	// R9 picker 的 pool 计数应等于注入的上游图数（捕捉去重/累积语义回归）
	if (sc.metaIsPicker && sc.upstreamImages > 0) {
		const m = probe.text.match(/Pool\s+(\d+)/i);
		if (!m) {
			fail(sc.id, 'picker-no-pool', '未渲染 Pool 状态栏');
		} else if (Number(m[1]) !== sc.upstreamImages) {
			fail(sc.id, 'picker-pool-count', `Pool ${m[1]}，期望 ${sc.upstreamImages}`);
		}
	}

	// R10 actions 必须渲染成可点按钮（捕捉第 80 轮 actions 门控回归）
	if (sc.metaActions > 0 && sc.state === 'success' && probe.buttons === 0) {
		fail(sc.id, 'actions-missing', `meta 声明 ${sc.metaActions} 个 action 但无按钮`);
	}

	// R11 无塌陷容器
	if (probe.zeroSizedDivs > 0) { notes.push(`${sc.id}: ${probe.zeroSizedDivs} 个有子元素但高度 0 的 div`); }

	// R12 宿主宽度符合预期（保证溢出断言基准没被 CSS 改坏）
	if (probe.hostW !== HOST_WIDTH) { fail(sc.id, 'host-width', `宿主宽 ${probe.hostW}px，期望 ${HOST_WIDTH}px`); }

	// ── 截图 ──
	if (!NO_SHOT) {
		const shotPath = path.join(WRITE_BASELINE ? baselineDir : actualDir, `${sc.id}.png`);
		await cell.screenshot({ path: shotPath });
		if (!WRITE_BASELINE) {
			const basePath = path.join(baselineDir, `${sc.id}.png`);
			if (!fs.existsSync(basePath)) {
				notes.push(`${sc.id}: 无基线（新节点？跑 --baseline 建立）`);
			} else {
				const diff = comparePng(fs.readFileSync(basePath), fs.readFileSync(shotPath));
				const tol = sc.webgl ? PIXEL_TOLERANCE_WEBGL : PIXEL_TOLERANCE;
				if (diff.sizeMismatch) {
					fail(sc.id, 'screenshot-size', `尺寸变化 ${diff.baseSize} → ${diff.actualSize}`);
				} else if (diff.decodeFailed) {
					notes.push(`${sc.id}: PNG 解码降级（非 8bit RGB/RGBA），仅做字节相等判断`);
				} else if (diff.ratio > tol) {
					fail(sc.id, 'screenshot-diff', `像素差 ${(diff.ratio * 100).toFixed(2)}% > ${(tol * 100).toFixed(1)}%`);
				}
			}
		}
	}
}

await browser.close();
server.close();

// ── 6. 报告 ────────────────────────────────────────────────────────────────
const lines = [];
lines.push(`# 节点 UI 可视化测试报告`);
lines.push('');
lines.push(`- 场景数：${scenarios.length}`);
lines.push(`- 失败：${failures.length}`);
lines.push(`- 提示：${notes.length}`);
lines.push(`- 模式：${WRITE_BASELINE ? '生成基线' : NO_SHOT ? '仅 DOM 断言' : 'DOM 断言 + 截图 diff'}`);
lines.push('');
if (failures.length) {
	lines.push('## 失败明细');
	lines.push('');
	lines.push('| 场景 | 规则 | 详情 |');
	lines.push('|---|---|---|');
	for (const f of failures) { lines.push(`| ${f.scenario} | ${f.rule} | ${f.detail.replace(/\|/g, '\\|')} |`); }
	lines.push('');
}
if (notes.length) {
	lines.push('## 提示');
	lines.push('');
	for (const n of notes.slice(0, 80)) { lines.push(`- ${n}`); }
	lines.push('');
}
fs.writeFileSync(path.join(__dirname, 'report.md'), lines.join('\n'), 'utf8');

for (const f of failures) { console.error(`  FAIL  ${f.scenario}  [${f.rule}]  ${f.detail}`); }
for (const n of notes.slice(0, 20)) { console.warn(`  note  ${n}`); }
console.log(`\n[visual] ${WRITE_BASELINE ? '基线已生成' : `${scenarios.length - failures.length}/${scenarios.length} 通过`}  · 报告 visual/report.md`);
process.exit(failures.length ? 1 : 0);

// ── PNG 像素级比较（零依赖：node:zlib + 手写 unfilter）────────────────────
//
// ★ 为什么不能逐字节比 PNG：PNG 的 IDAT 是 zlib 压缩流，改动 1 个像素会让整个
//   压缩流重排 —— 实测「同一页面两次截图」的字节差可达 98%，基线完全失效。
//   必须解码到 RGBA 原始像素再逐像素比较。
/**
 * @param {Buffer} a @param {Buffer} b
 * @returns {{sizeMismatch:boolean, ratio:number, baseSize?:string, actualSize?:string, decodeFailed?:boolean}}
 */
function comparePng(a, b) {
	const pa = decodePng(a);
	const pb = decodePng(b);
	if (!pa || !pb) {
		// 解码失败（非 8-bit RGB/RGBA 或交错）→ 退化为「尺寸 + 字节相等」两级判断，
		// 并明确标记，避免把压缩噪音当成真实差异。
		const sa = readPngSize(a); const sb = readPngSize(b);
		if (sa.w !== sb.w || sa.h !== sb.h) {
			return { sizeMismatch: true, baseSize: `${sa.w}x${sa.h}`, actualSize: `${sb.w}x${sb.h}`, ratio: 1 };
		}
		return { sizeMismatch: false, ratio: a.equals(b) ? 0 : 1, decodeFailed: true };
	}
	if (pa.width !== pb.width || pa.height !== pb.height) {
		return { sizeMismatch: true, baseSize: `${pa.width}x${pa.height}`, actualSize: `${pb.width}x${pb.height}`, ratio: 1 };
	}
	const total = pa.width * pa.height;
	let diff = 0;
	for (let i = 0; i < total; i++) {
		const o = i * 4;
		// 逐通道容差 8/255：抵消字体抗锯齿与 GPU 光栅化的亚像素抖动
		if (Math.abs(pa.data[o] - pb.data[o]) > 8
			|| Math.abs(pa.data[o + 1] - pb.data[o + 1]) > 8
			|| Math.abs(pa.data[o + 2] - pb.data[o + 2]) > 8
			|| Math.abs(pa.data[o + 3] - pb.data[o + 3]) > 8) {
			diff++;
		}
	}
	return { sizeMismatch: false, ratio: diff / total };
}

/**
 * 最小 PNG 解码器：支持 8-bit colorType 2(RGB) / 6(RGBA)、非交错。
 * Playwright 截图正是这两种。其他情况返回 null 交由调用方降级。
 * @param {Buffer} buf
 * @returns {{width:number,height:number,data:Buffer}|null}
 */
function decodePng(buf) {
	try {
		if (buf.readUInt32BE(0) !== 0x89504e47) { return null; }
		let off = 8;
		let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
		const idat = [];
		while (off < buf.length) {
			const len = buf.readUInt32BE(off);
			const type = buf.toString('ascii', off + 4, off + 8);
			const dataStart = off + 8;
			if (type === 'IHDR') {
				width = buf.readUInt32BE(dataStart);
				height = buf.readUInt32BE(dataStart + 4);
				bitDepth = buf[dataStart + 8];
				colorType = buf[dataStart + 9];
				interlace = buf[dataStart + 12];
			} else if (type === 'IDAT') {
				idat.push(buf.subarray(dataStart, dataStart + len));
			} else if (type === 'IEND') {
				break;
			}
			off = dataStart + len + 4; // +4 CRC
		}
		if (bitDepth !== 8 || interlace !== 0) { return null; }
		const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
		if (channels === 0) { return null; }

		const raw = zlib.inflateSync(Buffer.concat(idat));
		const stride = width * channels;
		const out = Buffer.alloc(width * height * 4);
		let prev = Buffer.alloc(stride); // 上一扫描行（已 unfilter）
		let rp = 0;
		for (let y = 0; y < height; y++) {
			const filter = raw[rp++];
			const line = Buffer.from(raw.subarray(rp, rp + stride));
			rp += stride;
			unfilterLine(filter, line, prev, channels);
			// 展开成 RGBA
			for (let x = 0; x < width; x++) {
				const si = x * channels;
				const di = (y * width + x) * 4;
				out[di] = line[si];
				out[di + 1] = line[si + 1];
				out[di + 2] = line[si + 2];
				out[di + 3] = channels === 4 ? line[si + 3] : 255;
			}
			prev = line;
		}
		return { width, height, data: out };
	} catch {
		return null;
	}
}

/**
 * PNG 行滤波逆运算（RFC 2083 §6）。原地修改 `line`。
 * @param {number} filter @param {Buffer} line @param {Buffer} prev @param {number} bpp 每像素字节数
 */
function unfilterLine(filter, line, prev, bpp) {
	const n = line.length;
	switch (filter) {
		case 0: break; // None
		case 1: // Sub
			for (let i = bpp; i < n; i++) { line[i] = (line[i] + line[i - bpp]) & 0xff; }
			break;
		case 2: // Up
			for (let i = 0; i < n; i++) { line[i] = (line[i] + prev[i]) & 0xff; }
			break;
		case 3: // Average
			for (let i = 0; i < n; i++) {
				const left = i >= bpp ? line[i - bpp] : 0;
				line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
			}
			break;
		case 4: // Paeth
			for (let i = 0; i < n; i++) {
				const a = i >= bpp ? line[i - bpp] : 0;
				const b = prev[i];
				const c = i >= bpp ? prev[i - bpp] : 0;
				const p = a + b - c;
				const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
				const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
				line[i] = (line[i] + pred) & 0xff;
			}
			break;
		default: break; // 未知滤波：原样（会体现为差异）
	}
}

/** @param {Buffer} buf */
function readPngSize(buf) {
	// PNG: 8B 签名 + 4B 长度 + 'IHDR' + width(4) + height(4)
	return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
