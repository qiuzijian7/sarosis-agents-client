/**
 * 主页 React 应用（dsh dashboard 插件的**渲染与交互层**）。
 *
 * ## 为什么代码在这里、产物在 lib/app/dist/
 * 主页是**独立文档**（IDE 编辑区的 WebContentsView / dsh 窗口的 iframe），文档里**没有**
 * `window.__ModuleLoader__` ⇒ 拿不到 dsh 客户端壳的 React ⇒ 必须自带运行时并预打包
 * （`vendor/build.mjs` 用 esbuild 打成单文件 IIFE）。第三方 npm（react-grid-layout 等）
 * 同理：dsh 客户端壳的 `require` 只解析平台种子词 ⇒ 只能自己打包。
 *
 * ## 数据来源（只读两个 JSON 岛，不自己拼 URL）
 * - `[data-dash-layout-json]`：`{ version, updatedAt, settings, items }`（`updatedAt` 是 CAS 戳）
 * - `[data-dash-model-json]`：`catalog.summarizeModel()` 出来的 `model`
 * - `[data-dash-catalog-json]`：画廊条目（`serializeCatalog()`，与 `WIDGETS` 同源）
 * - `[data-dash-api]`（在网格元素上）：布局写口（页面在 `/x/dashboard` 与 `/x/dashboard/` 两种形态下都能用）
 *
 * ## 布局模型（与老实现**完全同构**，所以 `layout.json` 零迁移）
 * `items[]` 是**顺序流**：数组顺序 = 视觉顺序；`w` = 占几列（12 列制）；`h` = **最小高度**（行）。
 * 拖拽 = 重排（落在目标前后半 ⇒ 换算成 beforeId），缩放 = 改 w/h。
 * ⚠ 刻意**不做**自由 x/y 绝对定位：那要改 `layout.json` 契约 + 迁移老布局 + 重写守卫，
 *   收益只是"能摆成奇怪的洞"，不值。原型（react-grid-layout）的受控数组也能表达，见 README。
 *
 * ## 视觉
 * 官方设计 token（`vendor/dsw-theme/*.css`，MIT）由宿主以 `<link>` 提供；本文件只负责
 * **页面派生层级**（`--dash-*`）与组件样式。层级为什么不能直接用 `--dsw-alias-bg-layer-1`：
 * 真实页面里它被 IDE 主题覆盖成 `sideBar.background`（#181818），比页面底（#1F1F1F）更暗
 * ⇒ 卡片会"凹进去"。所以派生规则见 `deriveTokens()`。
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

// ★ 2026-10-22：**网格与坐标归一化只有一份**（`lib/layout.js`，宿主也用它）——
//   要是这里再抄一套 `clampInt` / 装箱算法，早晚两边算出不同的位置（"保存后卡片跳位"就是这么来的 ✗）。
//   esbuild 会把 layout.js 打进产物（它是纯函数、零依赖）。
import { clampInt, compactGrid, DEFAULT_GAP, DEFAULT_ROW_HEIGHT, GRID_COLUMNS, MAX_ROWS, MAX_ROWS_FREE, normalizeMode, packFlow, rectsOverlap, stripPlacement, textOf } from '../../layout.js';

const h = React.createElement;

/* ────────────────────────────────────────────────────────────────────────────
 * 基础工具
 * ──────────────────────────────────────────────────────────────────────────── */

function readJson(selector) {
	const el = document.querySelector(selector);
	if (!el) { return null; }
	try { return JSON.parse(el.textContent || ''); } catch { return null; }
}

function el(tag, attrs, ...children) {
	return h(tag, attrs, ...children);
}

function fmtMs(ms) {
	if (ms === undefined || ms === null || !Number.isFinite(ms)) { return '未知'; }
	if (ms < 1000) { return `${Math.round(ms)}ms`; }
	const s = ms / 1000;
	if (s < 60) { return `${s.toFixed(1)}s`; }
	const m = Math.floor(s / 60);
	const rest = Math.round(s - m * 60);
	if (m < 60) { return `${m}m${rest}s`; }
	const hh = Math.floor(m / 60);
	return `${hh}h${m - hh * 60}m`;
}

function fmtTokens(n) {
	if (n === undefined || n === null || !Number.isFinite(n)) { return '未知'; }
	if (n < 1000) { return String(Math.round(n)); }
	if (n < 1000 * 1000) { return `${(n / 1000).toFixed(1)}k`; }
	return `${(n / (1000 * 1000)).toFixed(2)}M`;
}

/* 颜色：派生层级用（纯 hex，能算对比度、也能被断言） */
function parseFlexible(str) {
	if (!str) { return null; }
	const s = String(str).trim();
	let m = s.match(/^#([0-9a-f]{6})$/i);
	if (m) {
		const n = parseInt(m[1], 16);
		return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
	}
	m = s.match(/^rgba?\(([^)]+)\)$/i);
	if (m) {
		const p = m[1].split(',').map(x => parseFloat(x));
		return { r: p[0], g: p[1], b: p[2] };
	}
	return null;
}

function mix(a, b, wa) {
	return {
		r: Math.round(a.r * wa + b.r * (1 - wa)),
		g: Math.round(a.g * wa + b.g * (1 - wa)),
		b: Math.round(a.b * wa + b.b * (1 - wa)),
	};
}

function hex(c) {
	return '#' + [c.r, c.g, c.b].map(v => ('0' + Math.max(0, Math.min(255, v)).toString(16)).slice(-2)).join('');
}

/**
 * 页面派生层级（见文件头）。比例按明暗分开：暗色下"往前景混"是提亮、亮色下是压暗，
 * 同一比例得到的对比度差很多（实测：亮色 30% 只有 1.39:1，要 35% 才过 1.5）。
 *
 * `hc` = **高对比档**（`prefers-contrast: more` 时启用；VS Code 的 hc-black / hc-light 主题会带上它）。
 * ⚠ 它是一档**更极端**的比例，既套暗底也套亮底（两边的方向都是"离底色更远"）⇒
 *   不需要拆成 hc-dark / hc-light 两套。守卫会断言 `hc` 每一项都 ≥ 明暗两档的较大值。
 */
const RATIOS = {
	dark: { surface: 0.08, surface2: 0.15, stroke: 0.30, stroke2: 0.55, muted: 0.72, faint: 0.54 },
	light: { surface: 0.09, surface2: 0.16, stroke: 0.35, stroke2: 0.63, muted: 0.80, faint: 0.64 },
	hc: { surface: 0.12, surface2: 0.20, stroke: 0.42, stroke2: 0.66, muted: 0.88, faint: 0.72 },
};

function isDark() {
	try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch { return true; }
}

/** 系统/IDE 是否要求"更高对比"（VS Code 的 hc-* 主题会带这个媒体特性）。 */
function prefersMoreContrast() {
	try { return !!(window.matchMedia && window.matchMedia('(prefers-contrast: more)').matches); } catch { return false; }
}

/**
 * 明暗切换的**唯一开关**是 `body[data-ds-dark-theme]` —— 官方 `design-platform.css` 就是这么分档的
 * （`body` = 亮色、`body[data-ds-dark-theme]` = 暗色），它**不看** `prefers-color-scheme`。
 * ⚠ 踩过：只按 `prefers-color-scheme` 算派生色、却忘了切这个属性 ⇒ 暗色环境里整页仍是白底
 *   （`--dsw-alias-bg-base` 仍是 #fff），派生出来的"暗色比例"就全算错了。
 */
function applyScheme() {
	const dark = isDark();
	if (dark) {
		document.body.setAttribute('data-ds-dark-theme', '');
	} else {
		document.body.removeAttribute('data-ds-dark-theme');
	}
	document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

function deriveTokens() {
	applyScheme();
	const root = document.documentElement;
	const cs = getComputedStyle(document.body);
	const base = parseFlexible(cs.getPropertyValue('--dsw-alias-bg-base')) || { r: 31, g: 31, b: 31 };
	const fg = parseFlexible(cs.getPropertyValue('--dsw-alias-label-primary')) || { r: 204, g: 204, b: 204 };
	// 取档：高对比 > 明暗（高对比本身不区分明暗，见 RATIOS.hc 的注释）
	const r = prefersMoreContrast() ? RATIOS.hc : (isDark() ? RATIOS.dark : RATIOS.light);
	// 给 CSS 一个钩子（高对比下可以顺手加粗描边，无需再问一次媒体特性）
	if (prefersMoreContrast()) {
		document.body.setAttribute('data-dash-contrast', 'more');
	} else {
		document.body.removeAttribute('data-dash-contrast');
	}
	root.style.setProperty('--dash-surface', hex(mix(fg, base, r.surface)));
	root.style.setProperty('--dash-surface-2', hex(mix(fg, base, r.surface2)));
	root.style.setProperty('--dash-stroke', hex(mix(fg, base, r.stroke)));
	root.style.setProperty('--dash-stroke-2', hex(mix(fg, base, r.stroke2)));
	root.style.setProperty('--dash-muted', hex(mix(fg, base, r.muted)));
	root.style.setProperty('--dash-faint', hex(mix(fg, base, r.faint)));
}

/* ────────────────────────────────────────────────────────────────────────────
 * 单色图标（16px，currentColor）——与 dsh 官方单色体系一致；不用彩色 emoji
 * ──────────────────────────────────────────────────────────────────────────── */

const ICONS = {
	graph: 'M2.6 13.2h10.8M4.7 13.2V8.6M8 13.2V5.4M11.3 13.2V10',
	'graph-line': 'M2.6 12.4h10.8M3.4 10.2 6.2 6.6l2.4 2.2 4-4.6',
	list: 'M2.8 4.4h6M2.8 8h6M2.8 11.6h3.6M12.9 3.4v6.1M11.2 8.2l1.7-1.7 1.7 1.7',
	'list-unordered': 'M2.8 4.4h1.4M2.8 8h1.4M2.8 11.6h1.4M6 4.4h7.2M6 8h7.2M6 11.6h7.2',
	home: 'M2.6 7.3 8 2.7l5.4 4.6V13a.7.7 0 0 1-.7.7H3.3a.7.7 0 0 1-.7-.7V7.3ZM6.3 13.7V9.5h3.4v4.2',
	pulse: 'M2.4 8h2.2l1.6-4 2.6 8 1.6-4h3.2',
	folder: 'M2.6 5.2a1 1 0 0 1 1-1h2.6l1.3 1.6h4.9a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V5.2Z',
	clock: 'M8 2.6a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 0 0 0-10.8ZM8 4.9v3.3l2.2 1.4',
	watch: 'M5.2 2.6h5.6l.5 2.6a4.4 4.4 0 0 1 0 5.6l-.5 2.6H5.2l-.5-2.6a4.4 4.4 0 0 1 0-5.6l.5-2.6ZM8 5.6v2.6l1.7 1',
	timer: 'M8 3.4a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6ZM8 6v2.8l1.8 1.1M6.2 2.4h3.6',
	play: 'M6.2 4.1 11.8 8l-5.6 3.9V4.1Z',
	close: 'M4 4l8 8M12 4l-8 8',
	plus: 'M8 3.2v9.6M3.2 8h9.6',
	checked: 'M3.2 8.4l3.1 3.1L12.8 4.9',
	stack: 'M8 2.8 2.8 5.6 8 8.4l5.2-2.8L8 2.8ZM2.8 8.4 8 11.2l5.2-2.8',
	grid: 'M3.4 3.4h3.4v3.4H3.4zM9.2 3.4h3.4v3.4H9.2zM3.4 9.2h3.4v3.4H3.4zM9.2 9.2h3.4v3.4H9.2z',
	broken: 'M8 2.8 14 13H2L8 2.8ZM8 6.2v3.2M8 11.2v.6',
	// ── 工作台模块图标（2026-10-23）──────────────────────────────────────────────
	// ⚠ `catalog.WORKBENCH_MODULES` 里带的是 **emoji**（🏠🗂📚…）。主页**不用 emoji**（单色体系，
	//   彩色 emoji 在近黑底上过饱和）⇒ 这里按 route 映射到本文件的单色图标。
	//   映射不到的一律回落 grid（新增模块不会白屏，只是图标泛一点）。
	kanban: 'M2.8 3H6v10H2.8zM6.5 3H9.8v6.2H6.5zM10.3 3h2.9v8.1h-2.9z',
	book: 'M8 3.6C6.6 2.9 4.8 2.8 3.2 3.4v8.4c1.6-.6 3.4-.5 4.8.2 1.4-.7 3.2-.8 4.8-.2V3.4C11.2 2.8 9.4 2.9 8 3.6ZM8 3.6v9.2',
	code: 'M5.8 4.6 2.6 8l3.2 3.4M10.2 4.6 13.4 8l-3.2 3.4M9.2 3 6.8 13',
	image: 'M2.8 3.6h10.4v8.8H2.8zM2.8 11 6.3 7.8l2.3 2 1.9-1.7 2.7 2.4M6 6.4h.01',
	puzzle: 'M4 4.6h2.2a1.3 1.3 0 1 1 2.6 0H11v2.2a1.3 1.3 0 1 1 0 2.6V12H4V9.4a1.3 1.3 0 1 1 0-2.6z',
	plug: 'M6 2.6v2.8M10 2.6v2.8M4.2 5.4h7.6v2.4a3.8 3.8 0 0 1-7.6 0zM8 11.6v1.8',
	robot: 'M4 6h8v6H4zM6.5 9v.8M9.5 9v.8M8 3v3M4 8H2.6M12 8h1.4',
	cart: 'M2.6 3h1.6l1.3 6.2h6.4L13 5H4.4M6 12.2h.01M11 12.2h.01',
	history: 'M8 4.2a4.4 4.4 0 1 1-4.2 3.1M2.8 4.4v2.8h2.8M8 6.4v2.3l1.7 1.1',
	monitor: 'M2.8 3.6h10.4v7H2.8zM6.2 13.4h3.6M8 10.6v2.8',
	pin: 'M6.2 2.6v3.2L4.6 8h6.8L9.8 5.8V2.6M8 8v5.4',
	hide: 'M2.4 8s2.2-3.2 5.6-3.2S13.6 8 13.6 8s-2.2 3.2-5.6 3.2S2.4 8 2.4 8ZM6.3 8a1.7 1.7 0 1 0 3.4 0M3 13 13 3',
};

function Icon({ name, size = 16, className = 'dash-ico' }) {
	// ⚠ 未知 name 一律回落 grid：**加新组件时图标名写错不会白屏**（也便于发现——形状不对但页面还在）。
	return el('svg', {
		className, width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
		stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round',
		'aria-hidden': 'true',
	}, el('path', { d: ICONS[name] || ICONS.grid }));
}

/**
 * 单卡错误边界（**每张卡各自兜底**）。
 *
 * 为什么必须有：React 里一个组件 render 抛错，会把**整个 root** 卸掉 ⇒ 用户看到的是整页空白
 * （比"少一块"糟得多，而且看不出是哪块）。这里降级成「这一块坏了 + 原因」，其余卡片照常。
 * ⚠ 它抓不到事件处理器/异步里的错（React 的既有边界）—— 那类错要各自 try/catch。
 */
/**
 * 根级兜底（**比 CardBoundary 更高一层**）。
 *
 * 为什么还要这一层：`CardBoundary` 只包住"单张卡"；而 Dashboard 自身渲染时抛错
 * （工具条 / 画廊 / 预设栏 / 网格坐标计算…），React 会把**整个 root 卸掉** ⇒ 用户看到的是
 * "页面被掏空、只剩零碎几块"，而且**没有任何提示**。2026-10-23 的「编排页遮挡住全部窗口」
 * 就是这一类：看不出发生了什么，也没法自救。
 * 这里保证：**任何**渲染崩溃都变成"一屏说明 + 两个出口"，绝不留下半截页面。
 */
class AppBoundary extends React.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error) {
		return { error };
	}
	componentDidCatch(error, info) {
		console.error('[dashboard] 页面渲染失败', error, info);
	}
	render() {
		const { error } = this.state;
		if (!error) { return this.props.children; }
		return el('div', { className: 'dash-fatal', role: 'alert', 'data-dash-fatal': true },
			el('b', null, '主页渲染失败了'),
			el('div', { className: 'dash-fatal-msg' }, String((error && error.message) || error)),
			el('div', { className: 'dash-fatal-hint' },
				'这是页面渲染错误，', el('b', null, '不影响已保存的布局'), '。点「重新加载」即可回到正常页面；把下面几行发给开发者能直接定位。',
			),
			el('pre', { className: 'dash-fatal-stack' }, String((error && error.stack) || '(无堆栈)').split('\n').slice(0, 6).join('\n')),
			el('div', { className: 'dash-cfg-ops', style: { justifyContent: 'flex-start', marginTop: 10 } },
				el('button', {
					type: 'button', className: 'dash-btn primary', 'data-dash-action': 'fatal-reload',
					onClick: () => window.location.reload(),
				}, '重新加载'),
				el('button', {
					type: 'button', className: 'dash-btn', 'data-dash-action': 'fatal-retry',
					onClick: () => this.setState({ error: null }),
				}, '重试渲染'),
			),
		);
	}
}

class CardBoundary extends React.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error) {
		return { error };
	}
	componentDidCatch(error, info) {
		// 不静默：控制台留一份（页面里也显示一行），否则只剩"这块是空的"没法查
		console.error('[dashboard] 卡片渲染失败', this.props.kind, error, info);
	}
	render() {
		const { error } = this.state;
		if (!error) { return this.props.children; }
		return el('div', { className: 'dash-broken', role: 'alert' },
			el(Icon, { name: 'broken', className: 'dash-card-ico' }),
			el('div', null,
				el('b', null, '这块渲染失败了'),
				el('div', { className: 'dash-broken-msg' }, String((error && error.message) || error)),
				el('div', { className: 'dash-broken-hint' }, `组件：${this.props.kind} · 其余卡片不受影响（换掉它或报个 bug）`),
			),
		);
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * 组件（8 个 + 占位卡）
 * 契约：每个组件拿 (model, config)；**只读**渲染 + 自己的局部状态。
 * ──────────────────────────────────────────────────────────────────────────── */

function KpiCard({ model }) {
	const { summary, tally } = model;
	/**
	 * 样式 B（2026-10-23 用户选定）：**4 组主指标 + 副指标小字**，靠字号分主次。
	 *
	 * 旧版是 8~13 个等权小格子（"219"和"1"看起来一样重要）⇒ 扫读时找不到重点。
	 * 现在只给 4 个主数字，其余清点类指标折成第 2 行小字（保留信息，但不抢视线）。
	 */
	const groups = [
		{ n: summary.sessions, u: '会话', s: `${summary.active ?? '未知'} 个活跃` },
		{ n: summary.turns ?? '未知', u: 'turn', s: `${summary.steps ?? '未知'} step` },
		{ n: fmtMs(summary.llmMs), u: '模型', s: `工具 ${fmtMs(summary.toolMs)}` },
		{
			n: tally.inProgress ?? 0, u: '待办',
			s: tally.retrying ? `${tally.retrying} 个正在重试` : `覆盖 ${tally.todoSessions ?? 0} 个会话`,
		},
	];
	// 其余清点项（只在有值时出现）—— 折成一行小字，不占主视觉
	const extras = [
		tally.waiting ? `待回答 ${tally.waiting}` : '',
		tally.activePlans ? `计划模式 ${tally.activePlans}` : '',
		tally.running ? `回合进行中 ${tally.running}` : '',
		tally.queued ? `排队 ${tally.queued}` : '',
		tally.subagentRunning ? `子代理在跑 ${tally.subagentRunning}` : '',
	].filter(Boolean);

	return el('div', null,
		el('div', { className: 'dash-kpis' }, groups.map((c, i) => el('div', { className: 'dash-kpi', key: i },
			el('b', null, String(c.n), el('em', null, c.u)),
			el('span', null, c.s),
		))),
		extras.length ? el('div', { className: 'dash-kpi-extra' }, extras.join(' · ')) : null,
	);
}

function DiagCard({ model }) {
	const { data, tokenLine, toolsRegistered, liveServices } = model;
	/**
	 * 样式 B（用户选定）：**键值两列**。
	 *
	 * 旧版是一整段 60+ 字的长句（"token：… · 数据目录 … · 工具 … · live 服务 …"）⇒
	 * 想知道"数据目录在哪"要通读一遍。现在每行一个键，扫一眼就能定位。
	 * ⚠ 行数固定 4 条：新增键要先问"这一行有人看吗"，别把诊断行变回长句。
	 */
	const rows = [
		['token', tokenLine],
		['数据目录', data.dir],
		['工具', toolsRegistered || '(未注册)'],
		['live', `${liveServices} · 覆盖 ${String(data.live ?? 0)} 个会话（其余 cache）`],
	];
	return el('dl', { className: 'dash-dl' }, rows.map(([k, v]) => el('div', { className: 'dash-dl-row', key: k },
		el('dt', null, String(k)),
		el('dd', null, el('code', null, String(v))),
	)));
}

/**
 * 会话明细。
 *
 * ⚠ 行**文案**由宿主算好（`catalog.sessionRowModel()`）放进数据岛 ⇒ 这里只负责结构：
 *   服务端字符串版与 React 版共用同一处文案，不会"同一个会话两版字段不一样" ✗
 *   （文案逐字由 `p3-46` 钉着：`来源 cache` / `参与标题的输入` / `turn` / `token：输入` / 子代理身份）。
 */
function SessionsCard({ model, config }) {
	const limit = clampInt(config?.limit, 1, 200, 50);
	// 排序：宿主给的是"最新在前"（创建时间倒序）⇒ 升序就是反过来（不重新排序，避免与宿主口径分家）
	const order = config?.order === 'asc' ? 'asc' : 'desc';
	// 关键字过滤（文本型配置）：只匹配**标题**，大小写不敏感；空串 = 不过滤
	const keyword = typeof config?.keyword === 'string' ? config.keyword.trim() : '';
	const total = (model.sessions || []).length;
	const all = React.useMemo(() => {
		let rows = model.sessions || [];
		if (keyword) {
			const needle = keyword.toLowerCase();
			rows = rows.filter(row => String(row.title || '').toLowerCase().includes(needle));
		}
		return order === 'asc' ? [...rows].reverse() : rows;
	}, [model.sessions, order, keyword]);
	const shown = all.slice(0, limit);
	const orderText = order === 'asc' ? '升序' : '倒序';
	const countLabel = keyword
		? `匹配「${keyword}」${all.length} / 共 ${total} 个（按创建时间${orderText}）`
		: shown.length === all.length
			? `${all.length} 个（按创建时间${orderText}）`
			: `显示 ${shown.length} / 共 ${all.length} 个（按创建时间${orderText}）`;
	return el('div', null,
		// ⚠ 卡片的**标题/图标**统一由外壳渲染（`dash-card-head`）⇒ 组件里只放"副信息"，
		//   别再各写一个 h2（那就是风格漂移的源头）。
		el('div', { className: 'dash-sub' }, countLabel),
		shown.length
			// 样式 B（用户选定）：**一行一条 + 右侧数值列**。
			//   旧版把 id/路径/模型/token 全铺成 4~5 行文字，一屏只能看 3 个会话；
			//   现在标题一行（超长省略），turn / step / 耗时各占一列，详情进 tooltip。
			//   ⚠ 仍保留 `li` + `.t` + `.dash-scroll`（守卫与探针按它们认行与滚动容器）。
			? el('div', { className: 'dash-scroll', 'data-dash-scroll': 'sessions' },
				el('ul', { className: 'dash-rows' }, shown.map((s, i) => el('li', {
					key: s.id || i,
					className: s.cold ? 'cold' : undefined,
					title: `${s.id}${s.cwd ? ' · ' + s.cwd : ''}\n${s.lines.join('\n')}`,
				},
					el('span', { className: 't' }, s.title),
					el('b', { className: 'num', 'data-dash-turns': s.turns === undefined ? 'unknown' : String(s.turns) }, s.turns === undefined ? '未知' : String(s.turns)),
					el('b', { className: 'num', 'data-dash-steps': s.steps === undefined ? 'unknown' : String(s.steps) }, s.steps === undefined ? '未知' : String(s.steps)),
					el('small', { className: 'num' }, fmtMs(s.llmMs)),
				))))
			: el('p', { className: 'empty' }, keyword ? `没有标题包含「${keyword}」的会话。` : '没有可显示的会话。'),
	);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 工作台：条目打开 / 固定 / 从活动栏隐藏 + 条目拖拽排序（**非编辑态也允许**）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 主页恒为固定（与 `catalog.js` 的 `alwaysPinned` 同口径；再兜一层防脚本/旧页面取消）。 */
const ALWAYS_PINNED_ROUTES = ['/x/dashboard/'];
const PINNED_KEY = 'vssaros.wb.pinned';
const THIRD_PARTY_PREFIX = 'wb:';

/**
 * 工作台模块 → 单色图标（`catalog.WORKBENCH_MODULES` 里是 emoji，主页不用 emoji）。
 * 新增模块忘了登记也不会白屏：回落 `grid`（只是图标泛一点）。
 */
const WB_ICONS = {
	'/x/dashboard/': 'home',
	'/x/kanban/': 'kanban',
	'/x/kb/': 'book',
	'/x/memory/': 'pulse',
	'/x/codebase/': 'code',
	'/x/media/': 'play',
	'/x/imagegen/': 'image',
	'/x/skills/': 'puzzle',
	// ★ 2026-10-23：`/x/mcp/` 已从主页卡片清单移除（用户要求）⇒ 这条图标映射成了死代码，一并删掉。
	//   （MCP 服务器仍在「工具」页的 MCP 页签里管理 ✓）
	'/x/workflow/': 'graph',
	'/x/agents/': 'robot',
	'/x/marketplace/': 'cart',
	'/x/sessions/': 'history',
	'/x/parallel/': 'monitor',
};

function readPinned() {
	try {
		const raw = window.localStorage.getItem(PINNED_KEY);
		const arr = raw ? JSON.parse(raw) : [];
		return Array.isArray(arr) ? arr.map(String) : [];
	} catch { return []; }
}

function writePinned(list) {
	try { window.localStorage.setItem(PINNED_KEY, JSON.stringify(list)); } catch { /* 私密模式：只是不回显 */ }
}

/** 这张页是不是开在 dsh 窗口里（父窗口 = 我们的 dsh 客户端）。两种宿主下"打开"的目标窗口不同。 */
function inDshWindow() {
	try { return !!(window.parent && window.parent !== window && window.parent.__vssarosChatSurface); } catch { return false; }
}

function notifyParentPin(route, pinned) {
	try {
		if (window.parent && window.parent !== window && window.parent.__vssarosChatSurface) {
			window.parent.postMessage({ type: 'vssaros-wb-pin', route: String(route || ''), pinned: !!pinned }, '*');
			return true;
		}
	} catch { /* 跨源被拒 ⇒ 不是 dsh 窗口 */ }
	return false;
}

/** 第三方工作台只注册在 dsh 客户端宿主里（`desktopWorkbenches`）⇒ 从父窗口读快照补卡片。 */
function parentWorkbenches() {
	try {
		if (!inDshWindow()) { return null; }
		const snap = typeof window.parent.__vssarosWorkbenchesSnapshot === 'function' ? window.parent.__vssarosWorkbenchesSnapshot() : null;
		return snap && Array.isArray(snap.workbenches) ? snap.workbenches : null;
	} catch { return null; }
}

function WorkbenchCard({ model, config, onSaveConfig, setStatus }) {
	const own = model.workbench || [];
	const order = React.useMemo(() => (Array.isArray(config?.order) ? config.order : []), [config]);
	const [thirdParty, setThirdParty] = React.useState([]);
	const [pinned, setPinned] = React.useState(readPinned);
	const [dragRoute, setDragRoute] = React.useState(null);
	const holderRef = React.useRef(null);
	/** 刚拖完 ⇒ 吃掉紧接着的那次 click（否则"调整顺序"会变成"打开页面" ✗）。 */
	const justDraggedRef = React.useRef(false);

	// 第三方工作台：宿主可能晚于本页就绪 / 中途装卸 ⇒ 低频复查（只在列表变化时 setState）
	React.useEffect(() => {
		const sync = () => {
			const list = parentWorkbenches();
			if (!list) { return; }
			const wanted = list
				.filter(w => w && w.id && String(w.id).indexOf('vssaros/') !== 0)
				.map(w => ({ route: `${THIRD_PARTY_PREFIX}${String(w.id)}`, id: String(w.id), name: String(w.title || w.id), desc: String(w.description || w.id), thirdParty: true }));
			setThirdParty(prev => {
				const key = p => p.map(x => `${x.id}|${x.name}`).join(',');
				return key(prev) === key(wanted) ? prev : wanted;
			});
		};
		sync();
		const timer = window.setInterval(sync, 3000);
		window.addEventListener('focus', sync);
		return () => { window.clearInterval(timer); window.removeEventListener('focus', sync); };
	}, []);

	// 固定清单与 chat-surface 客户端**共用一个键**（同源共享）⇒ 别处改了这边要回显
	React.useEffect(() => {
		const onStorage = ev => { if (ev && ev.key === PINNED_KEY) { setPinned(readPinned()); } };
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}, []);

	// 合并自家 + 第三方，按 `config.order` 还原（不在顺序里的保持默认序、排在最后 ⇒ 新模块不会"消失"）
	const merged = React.useMemo(() => {
		const all = [...own.map(m => ({ route: m.route, name: m.name, desc: m.desc, icon: m.icon, alwaysPinned: m.alwaysPinned === true })), ...thirdParty];
		const rank = new Map();
		order.forEach((route, i) => { if (!rank.has(route)) { rank.set(route, i); } });
		return all
			.map((item, index) => ({ item, index }))
			.sort((a, b) => {
				const ra = rank.has(a.item.route) ? rank.get(a.item.route) : Number.MAX_SAFE_INTEGER;
				const rb = rank.has(b.item.route) ? rank.get(b.item.route) : Number.MAX_SAFE_INTEGER;
				return ra === rb ? a.index - b.index : ra - rb;
			})
			.map(x => x.item);
	}, [own, thirdParty, order]);

	const api = () => (typeof window !== 'undefined' ? window.vssarosDsh : undefined);

	const openItem = item => {
		if (item.thirdParty) {
			try {
				const open = window.parent && window.parent.__vssarosOpenWorkbench;
				if (typeof open === 'function' && open(item.id)) { setStatus?.(`已在本窗口打开：${item.id}`); return; }
			} catch { /* 落到下面 */ }
			setStatus?.(`打不开 ${item.id}：它可能已被卸载，或安装后还没重启 Harness`);
			return;
		}
		if (inDshWindow()) {
			try {
				window.parent.postMessage({ type: 'vssaros-wb-open', route: String(item.route) }, '*');
				setStatus?.(`已请求在本窗口打开：${item.route}`);
				return;
			} catch { /* 落到桥兜底 */ }
		}
		const bridge = api();
		if (bridge && typeof bridge.openModulePage === 'function') {
			bridge.openModulePage(item.route);
			setStatus?.(`已请求打开：${item.route}`);
			return;
		}
		setStatus?.(`这个 IDE 版本还不支持从页面打开模块页：${item.route}`);
	};

	const togglePin = item => {
		if (ALWAYS_PINNED_ROUTES.indexOf(item.route) >= 0 || item.alwaysPinned) {
			setStatus?.('主页恒为固定，不可取消');
			return;
		}
		const wantPin = pinned.indexOf(item.route) < 0;
		// ① 共享清单（dsh 窗口侧栏那一行就按它长）
		const next = readPinned().filter(r => r !== item.route);
		if (wantPin) { next.push(item.route); }
		writePinned(next);
		setPinned(next);
		// ② 通知 dsh 客户端：侧栏那行立刻长/消（IDE 编辑区里没有父客户端 ⇒ 忽略）
		notifyParentPin(item.route, wantPin);
		// ③ IDE 活动栏也同步；第三方工作台不进活动栏（IDE 只认带 vssaros 清单的包）
		if (!item.thirdParty) {
			try {
				const bridge = api();
				if (bridge && typeof bridge.setWorkbenchPinned === 'function') { bridge.setWorkbenchPinned(item.route, wantPin); }
			} catch { /* 没有桥 ⇒ 只有 dsh 侧状态 */ }
		}
		setStatus?.(wantPin
			? (item.thirdParty ? `已固定到 dsh 侧栏（第三方工作台不进 IDE 活动栏）：${item.id}` : `已固定：${item.route}`)
			: `已取消固定：${item.thirdParty ? item.id : item.route}`);
	};

	const hideItem = item => {
		const bridge = api();
		if (!item.thirdParty && bridge && typeof bridge.setWorkbenchHidden === 'function') {
			bridge.setWorkbenchHidden(item.route, true);
			setStatus?.(`已请求「从活动栏隐藏」：${item.route}`);
			return;
		}
		setStatus?.(`这个 IDE 版本还不支持「从活动栏隐藏」：${item.route}`);
	};

	/* 条目拖拽排序（两轴都要判：多列网格里只判 Y ⇒ 左右拖不动）。
	   ⚠ 必须拦在卡片级拖拽之前（stopPropagation），否则编辑态下整张卡跟着跑。 */
	const onItemPointerDown = (ev, item) => {
		if (ev.button !== 0) { return; }
		const target = ev.target;
		if (target && target.closest && target.closest('button')) { return; }
		ev.preventDefault();
		ev.stopPropagation();
		const startX = ev.clientX;
		const startY = ev.clientY;
		let armed = false;
		const move = e => {
			if (!armed && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 6) { return; }
			armed = true;
			setDragRoute(item.route);
			const cards = holderRef.current ? [...holderRef.current.querySelectorAll('[data-dash-wb-route]')] : [];
			let beforeRoute = null;
			for (const card of cards) {
				if (card.getAttribute('data-dash-wb-route') === item.route) { continue; }
				const r = card.getBoundingClientRect();
				if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
					const useY = Math.abs(e.clientY - (r.top + r.height / 2)) >= Math.abs(e.clientX - (r.left + r.width / 2));
					const beforeHalf = useY ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
					beforeRoute = beforeHalf ? card.getAttribute('data-dash-wb-route') : (card.nextElementSibling ? card.nextElementSibling.getAttribute('data-dash-wb-route') : null);
					break;
				}
			}
			// 顺序数组：把拖的这条插到 beforeRoute 之前（null = 末尾）
			const routes = cards.map(c => c.getAttribute('data-dash-wb-route'));
			const without = routes.filter(r => r !== item.route);
			const at = beforeRoute === null ? without.length : Math.max(0, without.indexOf(beforeRoute));
			const nextOrder = [...without.slice(0, at), item.route, ...without.slice(at)];
			ev._dashNextOrder = nextOrder;
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			const nextOrder = ev._dashNextOrder;
			setDragRoute(null);
			justDraggedRef.current = armed;   // 拖过 ⇒ 让浏览器随后那次 click 不再触发"打开"
			if (armed && Array.isArray(nextOrder)) {
				onSaveConfig?.({ ...(config || {}), order: nextOrder });
			}
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};

	return el('div', null,
		// 磁贴网格：整块可点（打开）+ 悬停才露出「固定 / 隐藏」⇒ 13 个模块也不会被按钮撑爆。
		// ⚠ 保留 `data-dash-wb-route` / `data-dash-action`：探针与守卫按它们认条目与动作。
		el('div', { className: 'dash-wb-grid', 'data-dash-workbench': '1', ref: holderRef },
			merged.map(item => {
				const fixed = item.alwaysPinned === true || ALWAYS_PINNED_ROUTES.indexOf(item.route) >= 0;
				const isPinned = fixed || pinned.indexOf(item.route) >= 0;
				return el('div', {
					key: item.route,
					className: `dash-wb-tile${dragRoute === item.route ? ' dash-wb-dragging' : ''}${fixed ? ' is-fixed' : ''}`,
					'data-dash-wb-route': item.route,
					...(item.thirdParty ? { 'data-dash-wb-third-party': item.id } : {}),
					role: 'button',
					tabIndex: 0,
					title: `${item.name} · ${item.route}`,
					onPointerDown: e => onItemPointerDown(e, item),
					onClick: () => {
						if (justDraggedRef.current) { justDraggedRef.current = false; return; }
						openItem(item);
					},
					onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(item); } },
				},
					el('span', { className: 'dash-wb-ico' }, el(Icon, { name: WB_ICONS[item.route] || 'grid', size: 17 })),
					el('span', { className: 'dash-wb-body' },
						el('span', { className: 'dash-wb-nm' }, item.name,
							item.thirdParty ? el('i', { className: 'dash-wb-tag' }, '第三方') : null),
						el('span', { className: 'dash-wb-desc' }, item.desc || ''),
					),
					el('span', { className: 'dash-wb-actions' },
						fixed
							? el('span', { className: 'dash-wb-op is-on', title: '主页恒为固定（不可取消）' }, el(Icon, { name: 'pin', size: 13 }))
							: el('button', {
								type: 'button', className: `dash-wb-op${isPinned ? ' is-on' : ''}`,
								'data-dash-action': isPinned ? 'unpin-module' : 'pin-module',
								'data-dash-route': item.route,
								title: isPinned ? '已固定到侧栏（点击取消固定）' : '固定到侧栏',
								onClick: ev => { ev.stopPropagation(); togglePin(item); },
							}, el(Icon, { name: 'pin', size: 13 })),
						item.thirdParty ? null : el('button', {
							type: 'button', className: 'dash-wb-op',
							'data-dash-action': 'hide-module', 'data-dash-route': item.route,
							title: '从活动栏隐藏（单向动作，页面不回显结果）',
							onClick: ev => { ev.stopPropagation(); hideItem(item); },
						}, el(Icon, { name: 'hide', size: 13 })),
					),
				);
			}),
		),
		el('p', { className: 'dash-diag dash-wb-note' },
			'点卡片直接打开；「固定 / 隐藏」是', el('b', null, '单向动作'),
			'（dsh 侧读不到 IDE 的固定 / 显隐状态 ⇒ 卡片', el('b', null, '不回显'), '「已隐藏」）。',
			'直接', el('b', null, '拖动卡片'), '可调整顺序。',
		),
	);
}

/** 工作区：按 cwd 分组的会话数 / turn·step / 耗时 / 输出 token（分组由宿主算好，见 `catalog.groupByCwd`）。 */
function WorkspacesCard({ model, config }) {
	const limit = clampInt(config?.limit, 1, 30, 8);
	const all = model.workspaces || [];
	const groups = all.slice(0, limit);
	const total = (model.sessions || []).length;
	if (!groups.length) {
		return el('div', null,
			el('div', { className: 'dash-sub' }, '按 cwd 分组'),
			el('p', { className: 'empty' }, '没有可显示的会话。'),
		);
	}
	const top = groups[0].sessions || 1;
	return el('div', null,
		el('div', { className: 'dash-sub' }, `按 cwd 分组（${total} 个会话）`),
		el('table', { className: 'dash-tbl' },
			el('thead', null, el('tr', null,
				el('th', null, '工作区'), el('th', null, '会话'), el('th', null, 'turn / step'),
				el('th', null, '模型耗时'), el('th', null, '输出 token'),
			)),
			el('tbody', null, groups.map(g => [
				el('tr', { key: g.cwd + '-r' },
					el('td', null, el('code', null, g.cwd || '（cwd 未知）')),
					el('td', null, String(g.sessions)),
					el('td', null, `${g.turns ?? '未知'} / ${g.steps ?? '未知'}`),
					el('td', null, g.llmMs === undefined ? '未知' : fmtMs(g.llmMs)),
					el('td', null, g.output === undefined ? '未知' : fmtTokens(g.output)),
				),
				el('tr', { key: g.cwd + '-b' }, el('td', { colSpan: 5 },
					el('div', { className: 'dash-ws-track' }, el('i', { style: { width: `${Math.round(((g.sessions || 0) / top) * 100)}%` } })),
				)),
			])),
		),
		el('p', { className: 'dash-diag' }, '未知一律写「未知」，不伪装成 0（某个工作区一条会话都没带该单元时就是这样）。'),
	);
}

/** 用量：四路构成 + 按实际使用的模型分桶（`catalog.usageBuckets` 算好）。 */
function UsageCard({ model, config }) {
	const usage = model.usage;
	if (!usage || !usage.parts) { return el('p', { className: 'empty' }, '没有用量数据。'); }
	const total = usage.total || 0;
	const showByModel = config?.showByModel !== false;
	return el('div', null,
		el('div', { className: 'dash-sub' }, '四路构成 ＋ 按模型'),
		total > 0
			? el('div', { className: 'dash-stack' }, usage.parts.filter(p => (p.value || 0) > 0).map(p => el('i', {
				key: p.key, title: p.key,
				style: { width: `${((p.value || 0) / total) * 100}%`, background: p.color },
			})))
			: el('p', { className: 'empty' }, '范围内没有 token 用量可显示。'),
		// 样式 B（用户选定）：两列图例，**自带色块 + 数值 + 百分比**，按占比从大到小。
		//   旧版是一行流水（`输入 25.52M 输出 368.6k 读缓存 70.95M`）⇒ 看不出"哪个占大头"。
		//   百分比用 `usage.total` 算（服务端已给总量），未知值仍然显示「未知」，不伪装成 0。
		el('div', { className: 'dash-legend-b' }, [...usage.parts]
			.sort((a, b) => (b.value || 0) - (a.value || 0))
			.map(p => el('div', { key: p.key },
				el('i', { style: { background: p.color } }),
				el('span', { className: 'k' }, p.key),
				el('span', { className: 'v num' },
					p.value === undefined ? '未知' : fmtTokens(p.value),
					total > 0 && p.value !== undefined ? el('em', null, ` · ${Math.round(((p.value || 0) / total) * 100)}%`) : null,
				),
			))),
		showByModel ? el('table', { className: 'dash-tbl' },
			el('thead', null, el('tr', null,
				el('th', null, '实际使用的模型（modelSelection.used）'), el('th', null, '会话'), el('th', null, '输出 token'),
			)),
			el('tbody', null, (usage.byModel || []).map(row => el('tr', { key: row.key },
				el('td', null, row.key), el('td', null, String(row.sessions)),
				el('td', null, row.output === undefined ? '未知' : fmtTokens(row.output)),
			))),
		) : null,
		showByModel
			? el('p', { className: 'dash-diag' }, '数据全来自会话投影缓存；模型只认', el('b', null, '实际用过'), '的那个（「已选未生效」的不算）。')
			: null,
	);
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function ClockCard({ config }) {
	const [now, setNow] = React.useState(() => new Date());
	// 配置：显示秒 / 12 小时制（`configFields` 的 toggle 类型；宿主已归一化，这里再兜一次）
	const showSeconds = config?.showSeconds !== false;
	const hour12 = config?.hour12 === true;
	React.useEffect(() => {
		// 不显示秒时没必要每秒重渲染 ⇒ 30s 一跳够用（分钟边界最多晚 30s，可接受）
		const t = window.setInterval(() => setNow(new Date()), showSeconds ? 1000 : 30000);
		return () => window.clearInterval(t);
	}, [showSeconds]);
	const p = n => (n < 10 ? '0' : '') + n;
	const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${WEEK[now.getDay()]}`;
	const hours = hour12 ? (now.getHours() % 12 || 12) : now.getHours();
	const suffix = hour12 ? (now.getHours() < 12 ? ' AM' : ' PM') : '';
	const time = `${p(hours)}:${p(now.getMinutes())}${showSeconds ? `:${p(now.getSeconds())}` : ''}${suffix}`;
	return el('div', { className: 'dash-clock', 'data-dash-clock': '1' },
		el('div', { className: 'dash-clock-t', 'data-dash-clock-time': true }, time),
		el('div', { className: 'dash-clock-d', 'data-dash-clock-date': true }, date),
	);
}

const POMO_DEFAULT_FOCUS = 25;
const POMO_DEFAULT_BREAK = 5;

/** 番茄钟：专注 / 休息（纯客户端，**刻意不落盘** —— 关掉页面即停）。focus/break 来自卡片 config。 */
function PomodoroCard({ config }) {
	const focusMin = clampInt(config?.focus, 5, 90, POMO_DEFAULT_FOCUS);
	const breakMin = clampInt(config?.break, 1, 30, POMO_DEFAULT_BREAK);
	const [phase, setPhase] = React.useState('focus');
	const [round, setRound] = React.useState(1);
	const [running, setRunning] = React.useState(false);
	const [left, setLeft] = React.useState(focusMin * 60);

	// config 变了（换卡/改配置）⇒ 计时器回到新值
	React.useEffect(() => {
		setPhase('focus');
		setRound(1);
		setRunning(false);
		setLeft(focusMin * 60);
	}, [focusMin, breakMin]);

	React.useEffect(() => {
		if (!running) { return undefined; }
		const t = window.setInterval(() => {
			setLeft(prev => {
				if (prev > 1) { return prev - 1; }
				if (phase === 'focus') { setPhase('break'); return breakMin * 60; }
				setPhase('focus');
				setRound(r => (r >= 4 ? 1 : r + 1));
				return focusMin * 60;
			});
		}, 1000);
		return () => window.clearInterval(t);
	}, [running, phase, focusMin, breakMin]);

	const p = n => (n < 10 ? '0' : '') + n;
	const totalSec = (phase === 'focus' ? focusMin : breakMin) * 60;
	const frac = totalSec > 0 ? left / totalSec : 1;
	const C = 2 * Math.PI * 42;

	// 样式 B（用户选定）：**横排**（小环 + 右侧相位/按钮）——竖向 3 段要占 5 行高，只为一个倒计时不值。
	// ⚠ 保留 `data-dash-pomodoro` / `data-dash-pomo-time` / `data-dash-pomo-phase`（探针按它们认）。
	return el('div', { className: 'dash-pomo-b', 'data-dash-pomodoro': '1', 'data-dash-focus': String(focusMin), 'data-dash-break': String(breakMin) },
		el('svg', { className: 'dash-pomo-ring', viewBox: '0 0 100 100', width: 72, height: 72 },
			el('circle', { cx: 50, cy: 50, r: 42, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.12, strokeWidth: 8 }),
			el('circle', {
				cx: 50, cy: 50, r: 42, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 8,
				strokeLinecap: 'round', transform: 'rotate(-90 50 50)',
				strokeDasharray: `${(C * frac).toFixed(2)} ${C.toFixed(2)}`,
			}),
		),
		el('div', { className: 'dash-pomo-b-body' },
			el('div', { className: 'dash-pomo-b-top' },
				el('span', { className: 'dash-pomo-t', 'data-dash-pomo-time': true }, `${p(Math.floor(left / 60))}:${p(left % 60)}`),
				el('span', { className: 'dash-pomo-ph', 'data-dash-pomo-phase': true }, `${phase === 'focus' ? '专注' : '休息'} · 第 ${round} 个`),
			),
			el('div', { className: 'dash-pomo-ops' },
				el('button', { type: 'button', className: 'dash-btn primary', 'data-dash-action': 'pomo-toggle', onClick: () => setRunning(v => !v) }, running ? '暂停' : '开始'),
				el('button', {
					type: 'button', className: 'dash-btn', 'data-dash-action': 'pomo-reset',
					onClick: () => { setRunning(false); setPhase('focus'); setRound(1); setLeft(focusMin * 60); },
				}, '重置'),
			),
		),
	);
}

function MissingCard({ kind }) {
	return el('p', { className: 'empty' }, '该组件不存在：', el('code', null, kind), '（提供它的模块可能被卸下了）。');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 布局网格：顺序流 + 列宽 + 最小高度（受控数组，与 react-grid-layout 同心智）
 * ──────────────────────────────────────────────────────────────────────────── */

function minHeightStyle(item, rowPx, gapPx) {
	return { minHeight: `calc(${item.h} * ${rowPx}px + ${Math.max(0, item.h - 1)} * ${gapPx}px)` };
}

/** 把某张卡移到「落在 beforeId 之前」（与 `layout.js:moveBefore` 同语义，含 `before > from` 的 -1 坑）。 */
function moveBefore(items, id, beforeId) {
	const from = items.findIndex(item => item.id === id);
	const before = beforeId === null || beforeId === undefined
		? items.length
		: items.findIndex(item => item.id === beforeId);
	if (from < 0 || before < 0 || id === beforeId) { return items; }
	const to = before > from ? before - 1 : before;
	if (to === from) { return items; }
	const next = [...items];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/* ── 自由摆放：把重叠的卡「推开」────────────────────────────────────────────
 * 为什么不做完整的压缩求解（Grafana 那套）：那需要一整套碰撞/压实算法，
 * 而我们只需要"拖完不要互相盖住"。规则：**锚点钉住**，其余按 (y, x) 依次下沉到不撞为止。
 * ⚠ `rectsOverlap` 与「向上压实」`compactUp` 都在 `layout.js`（纯函数，守卫能直接测）。
 */
function resolveOverlaps(items, anchorId) {
	const next = items.map(item => ({ ...item }));
	const anchor = next.find(item => item.id === anchorId);
	if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) { return next; }

	// ⚠ 第一版只把"压到锚点的卡"推到锚点下方 —— 推出来的那几张**彼此还会重叠**
	//   （真机复现：拖动 kpi 后 diag 与 sessions 并排叠在同一行 ⇒ 直接看不见）。
	// 现在改成"先钉住锚点，其余按 (y, x) 依次下沉到不撞已放置的卡为止"。
	const placed = [anchor];
	const rest = next
		.filter(item => item !== anchor && Number.isFinite(item.x) && Number.isFinite(item.y))
		.sort((a, b) => (a.y - b.y) || (a.x - b.x));

	for (const item of rest) {
		for (let guard = 0; guard < 200; guard++) {
			const blockers = placed.filter(other => rectsOverlap(item, other));
			if (blockers.length === 0) { break; }
			const bottom = Math.max(...blockers.map(other => other.y + other.h));
			if (bottom <= item.y) { break; }                       // 防死循环
			item.y = Math.min(MAX_ROWS_FREE - 1, bottom);
			if (item.y >= MAX_ROWS_FREE - 1) { break; }
		}
		placed.push(item);
	}
	return next;
}

const WIDGETS = {
	kpi: KpiCard,
	diag: DiagCard,
	sessions: SessionsCard,
	workbench: WorkbenchCard,
	workspaces: WorkspacesCard,
	usage: UsageCard,
	clock: ClockCard,
	pomodoro: PomodoroCard,
};

/**
 * 卡片设置面板（**由组件声明的 `configFields` 自动生成**，不是每个组件写一套表单）。
 *
 * 契约：
 *   · 字段：`{ key, label, unit?, min, max, step?, fallback }`；
 *   · `min/max/fallback` 必须与 `catalog.js` 的 `normalizeConfig` 夹紧**同值**（守卫用行为断言钉住：
 *     `normalizeWidgetConfig(max+100) === max`）—— 面板界比夹紧宽的话，用户填了会被悄悄改掉 ✗；
 *   · 应用时再 clamp 一次（第二道防线），然后走 `onSaveConfig` ⇒ 跟布局一起 CAS 落盘。
 */
/** 字段当前生效值（面板初值 / 应用时都用它 ⇒ 面板与实际取值不会两套口径）。 */
function configValueOf(field, raw) {
	if (field.type === 'toggle') {
		return raw === true ? true : raw === false ? false : field.fallback;
	}
	if (field.type === 'select') {
		return (field.options || []).some(option => option.value === raw) ? raw : field.fallback;
	}
	// 文本：初值保留原始字符串（**不要在这里 trim**，否则用户输不进空格、光标会跳）
	if (field.type === 'text') {
		return typeof raw === 'string' ? raw : field.fallback;
	}
	return Number.isFinite(Number(raw)) ? Number(raw) : field.fallback;
}

/** 提交前归一化（数字夹紧 / 开关布尔化 / 下拉白名单校验 / 文本 trim + 截断）。 */
function normalizeFieldValue(field, raw) {
	if (field.type === 'toggle') { return raw === true; }
	if (field.type === 'select') { return (field.options || []).some(option => option.value === raw) ? raw : field.fallback; }
	if (field.type === 'text') { return textOf(raw, field.maxLength, field.fallback); }
	return clampInt(raw, field.min, field.max, field.fallback);
}

function CardSettings({ fields, config, onApply, onClose }) {
	const [draft, setDraft] = React.useState(() => {
		const initial = {};
		for (const field of fields) {
			initial[field.key] = configValueOf(field, config?.[field.key]);
		}
		return initial;
	});

	const rows = fields.map(field => {
		const key = `${field.type || 'number'}:${field.key}`;

		if (field.type === 'toggle') {
			return el('label', { className: 'dash-cfg-row', key },
				el('span', { className: 'dash-cfg-label' }, field.label),
				el('input', {
					className: 'dash-cfg-check',
					type: 'checkbox',
					'data-dash-cfg-key': field.key,
					checked: draft[field.key] === true,
					onChange: ev => setDraft(prev => ({ ...prev, [field.key]: ev.target.checked })),
				}),
			);
		}

		if (field.type === 'select') {
			return el('label', { className: 'dash-cfg-row', key },
				el('span', { className: 'dash-cfg-label' }, field.label),
				el('select', {
					className: 'dash-cfg-select',
					'data-dash-cfg-key': field.key,
					value: draft[field.key],
					onChange: ev => setDraft(prev => ({ ...prev, [field.key]: ev.target.value })),
				}, (field.options || []).map(option => el('option', { key: option.value, value: option.value }, option.label))),
			);
		}

		if (field.type === 'text') {
			const limit = field.maxLength || 40;
			return el('label', { className: 'dash-cfg-row', key },
				el('span', { className: 'dash-cfg-label' }, field.label),
				el('input', {
					className: 'dash-cfg-text',
					type: 'text',
					'data-dash-cfg-key': field.key,
					maxLength: limit,
					placeholder: field.placeholder || '',
					value: String(draft[field.key] ?? ''),
					onChange: ev => setDraft(prev => ({ ...prev, [field.key]: ev.target.value })),
					onKeyDown: ev => { if (ev.key === 'Enter') { ev.currentTarget.blur(); } },
				}),
				el('span', { className: 'dash-cfg-range' }, `≤${limit} 字`),
			);
		}

		return el('label', { className: 'dash-cfg-row', key },
			el('span', { className: 'dash-cfg-label' }, field.label),
			el('input', {
				className: 'dash-cfg-input',
				type: 'number',
				inputMode: 'numeric',
				min: field.min,
				max: field.max,
				step: field.step || 1,
				value: String(draft[field.key]),
				'data-dash-cfg-key': field.key,
				onChange: ev => setDraft(prev => ({ ...prev, [field.key]: ev.target.value })),
				onKeyDown: ev => { if (ev.key === 'Enter') { ev.currentTarget.blur(); } },
			}),
			field.unit ? el('span', { className: 'dash-cfg-unit' }, field.unit) : null,
			el('span', { className: 'dash-cfg-range' }, `${field.min}–${field.max}`),
		);
	});

	return el('div', { className: 'dash-cfg', 'data-dash-no-drag': true, 'data-dash-cfg': fields.map(field => field.key).join(',') },
		rows,
		el('div', { className: 'dash-cfg-ops' },
			el('button', {
				type: 'button', className: 'dash-btn primary', 'data-dash-action': 'config-apply',
				onClick: () => {
					const next = { ...(config || {}) };
					for (const field of fields) {
						next[field.key] = normalizeFieldValue(field, draft[field.key]);
					}
					onApply(next);
				},
			}, '应用'),
			el('button', { type: 'button', className: 'dash-btn', 'data-dash-action': 'config-cancel', onClick: onClose }, '取消'),
		),
	);
}

function CardBody({ item, model, onSaveConfig, setStatus }) {
	const Comp = WIDGETS[item.kind];
	if (!Comp) { return el(MissingCard, { kind: item.kind }); }
	return el(Comp, { model, config: item.config || {}, onSaveConfig, setStatus });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 主应用
 * ──────────────────────────────────────────────────────────────────────────── */

function Dashboard({ boot }) {
	const [items, setItems] = React.useState(boot.items);
	const [stamp, setStamp] = React.useState(boot.updatedAt);
	const [editing, setEditing] = React.useState(false);
	const [galleryOpen, setGalleryOpen] = React.useState(false);
	/** 哪张卡的设置面板是打开的（一次只开一张，避免一屏小表单）。 */
	const [cfgOpen, setCfgOpen] = React.useState(null);
	/** 「收紧高度」的测量态：置 true 时 CSS 会把卡片的 `min-height` 清零（量到的是**内容高度**）。 */
	const [measuring, setMeasuring] = React.useState(false);
	/**
	 * 自适应列数（2026-10-23 用户：「缩放页面时组件大小要求自适应」）。
	 *
	 * 固定 12 列在窄视口下会挤成"每条 30px"，同时 `h` 还是按宽屏量的 ⇒ 卡片留一大片空白。
	 * 解决：按网格**实际宽度**降列（12 → 8 → 6 → 4），卡片 `span` 取 `min(w, 列数)`；
	 * 列数变化后再**重算一次高度**（只收不放，见 `AUTO_TIGHTEN_MIN_ROWS`）。
	 * ⚠ 自由摆放**不降列**：x 是 0..11 的固定坐标，改列数等于把坐标解释坏；
	 *   太窄时改为横向滚动（见下面 grid 的 minWidth），行为可预期。
	 */
	const [cols, setCols] = React.useState(GRID_COLUMNS);
	const colsRef = React.useRef(GRID_COLUMNS);
	colsRef.current = cols;
	/** 多套布局：`active` / `presets` 只读（切换后整页重载，状态从岛里重取）。 */
	const [activePreset] = React.useState(boot.active || 'default');
	const [presets] = React.useState(() => (Array.isArray(boot.presets) && boot.presets.length ? boot.presets : ['default']));
	/** 「存为 / 重命名预设」的内联输入行：`null` = 收起，否则 `{ mode, value }`。 */
	const [presetForm, setPresetForm] = React.useState(null);
	/** 「删除」是**两段式**（先点亮确认，5 秒后自动复位）—— iframe 里 `confirm()` 可能被拦，不能依赖它。 */
	const [deleteArmed, setDeleteArmed] = React.useState(false);
	React.useEffect(() => {
		if (!deleteArmed) { return undefined; }
		const timer = window.setTimeout(() => setDeleteArmed(false), 5000);
		return () => window.clearTimeout(timer);
	}, [deleteArmed]);
	const [status, setStatus] = React.useState('');
	const [drag, setDrag] = React.useState(null);   // flow: { id, dropBefore } · free: { id, x, y }
	const gridRef = React.useRef(null);
	// ⚠ 必须用 boot 里算好的值（CSS 变量优先）。曾写成 `boot.settings?.gap || 0` ⇒ 布局文件没存
	//   settings 时页面以为间距 0、实际 CSS 是 12 ⇒ 每次切「自由摆放」行数涨一半（详见 boot 的 cssVarPx）。
	const rowPx = boot.rowPx || DEFAULT_ROW_HEIGHT;
	const gapPx = Number.isFinite(boot.gapPx) ? boot.gapPx : DEFAULT_GAP;
	/** 布局模式：flow（顺序流，默认）/ free（自由 x/y 摆放）。跟 `settings.mode` 一起落盘。 */
	const [mode, setMode] = React.useState(() => normalizeMode(boot.settings?.mode));
	const isFree = mode === 'free';
	/** 存盘 / 拖拽回调里要读"当前" items ⇒ 用 ref，避免闭包里拿到过期数组。 */
	const itemsRef = React.useRef(items);
	React.useEffect(() => { itemsRef.current = items; }, [items]);

	const setStatusMsg = React.useCallback(msg => setStatus(msg), []);

	/** 存盘（CAS）。失败/409 都**明说**，不装作成功。 */
	const save = React.useCallback(async (nextItems, nextSettings, reason) => {
		// ⚠ settings 里必须带 `mode`（flow / free）—— 否则服务端归一化后会回落 flow，
		//   表现就是"切到自由摆放、刷新一下又变回顺序流"（而且 items 里的 x/y 还在 ⇒ 半套数据）。
		const body = { updatedAt: stamp, items: nextItems, settings: nextSettings ?? { ...(boot.settings || {}), mode } };
		try {
			const res = await fetch(boot.api, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			const data = await res.json().catch(() => ({}));
			if (res.status === 409) {
				setStatusMsg('布局已被别处改过 ⇒ 正在重新加载…');
				window.setTimeout(() => window.location.reload(), 700);
				return false;
			}
			if (!res.ok || !data.ok) {
				setStatusMsg(`保存失败：${data.error || `HTTP ${res.status}`}`);
				return false;
			}
			// ★ 采纳服务端回传的 items（归一化后的那份）⇒ 防"删了又回来"
			if (Array.isArray(data.items)) { setItems(data.items); }
			if (Number.isFinite(data.updatedAt)) { setStamp(data.updatedAt); }
			setStatusMsg(reason ? `已保存（${reason}）` : '已保存');
			return true;
		} catch (e) {
			setStatusMsg(`保存失败：${e && e.message ? e.message : e}`);
			return false;
		}
	}, [boot.api, boot.settings, stamp, mode]);

	/**
	 * 预设操作（switch / saveAs / delete）。走 `${api}/presets`，与布局写入**同一把锁**。
	 * 成功后一律**整页重载**：切换预设等于换一份布局 + settings，让岛重新下发是最省事也最不会漂的做法。
	 */
	const presetPost = async body => {
		try {
			const res = await fetch(`${boot.api}/presets`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || !data.ok) {
				setStatusMsg(`预设操作失败：${data.error || `HTTP ${res.status}`}`);
				// 409 = 你操作的那份预设已被别处改过 ⇒ 整页重载，让用户看到**当前真实状态**再决定
				// （只把错误写在状态栏，用户面对的还是过期界面，很容易再点一次又 409 ✗）
				if (data.conflict === true) {
					setStatusMsg(`预设已被别处改过，正在重新加载…（${data.error || ''}）`);
					window.setTimeout(() => window.location.reload(), 700);
				}
				return false;
			}
			return true;
		} catch (e) {
			setStatusMsg(`预设操作失败：${e && e.message ? e.message : e}`);
			return false;
		}
	};

	const switchPreset = async name => {
		if (!name || name === activePreset) { return; }
		if (await presetPost({ action: 'switch', name })) { window.location.reload(); }
	};

	/** 内联输入行的提交：两种模式共用一个入口（`saveAs` 另存 / `rename` 改名）。 */
	const submitPresetForm = async () => {
		if (!presetForm) { return; }
		const name = String(presetForm.value ?? '').trim();
		if (!name) { setStatusMsg('预设名不能为空'); return; }

		if (presetForm.mode === 'rename') {
			if (name === activePreset) { setPresetForm(null); return; }   // 没改就静默收起
			// 带上 `updatedAt`：服务端据此判"我操作的是不是我看到的那一份"（预设级 CAS）
			if (await presetPost({ action: 'rename', name: activePreset, to: name, updatedAt: stamp })) {
				setStatusMsg(`已重命名为「${name}」，正在重载…`);
				window.setTimeout(() => window.location.reload(), 400);
			}
			return;
		}

		// 重名就覆盖（显式 overwrite），并在状态里说明 —— 不依赖 confirm()（iframe 里可能被拦）
		const overwrite = presets.includes(name);
		if (await presetPost({ action: 'saveAs', name, overwrite: true })) {
			setStatusMsg(overwrite ? `已覆盖预设「${name}」，正在重载…` : `已存为预设「${name}」，正在重载…`);
			window.setTimeout(() => window.location.reload(), 400);
		}
	};

	/**
	 * 退出编排。**三条入口都收敛到这一个函数**：工具栏按钮 / 右下角悬浮按钮 / Esc。
	 *
	 * ⚠ 为什么要三条（2026-10-23 用户反馈「进入编排状态后无法返回」）：工具按钮在页面顶部，
	 *   滚到中部就看不见了 ⇒ 容易以为"回不去"。加固定悬浮按钮（永远在视野里）+ Esc（键盘直觉），
	 *   三条路行为一致，不会出现"这条能退、那条不能"。
	 */
	const exitEditing = () => {
		setEditing(false);
		// 退出时一并收起画廊与设置面板（否则成了"没有入口也关不掉"的孤儿面板 ✗）
		setGalleryOpen(false);
		setCfgOpen(null);
	};
	const toggleEditing = () => { if (editing) { exitEditing(); } else { setEditing(true); } };

	// Esc 逐级退出：设置面板 → 画廊 → 编排（一次只退一级，符合直觉；只有编辑态才接管）
	React.useEffect(() => {
		if (!editing) { return undefined; }
		const onKey = ev => {
			if (ev.key !== 'Escape') { return; }
			if (cfgOpen !== null) { setCfgOpen(null); return; }
			if (galleryOpen) { setGalleryOpen(false); return; }
			exitEditing();
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [editing, cfgOpen, galleryOpen]);

	const deletePreset = async () => {
		if (presets.length <= 1) { setStatusMsg('至少要留一个预设'); return; }
		if (!deleteArmed) { setDeleteArmed(true); setStatusMsg(`再点一次确认删除预设「${activePreset}」（5 秒内有效）`); return; }
		setDeleteArmed(false);
		if (await presetPost({ action: 'delete', name: activePreset, updatedAt: stamp })) {
			setStatusMsg(`已删除预设「${activePreset}」，正在重载…`);
			window.setTimeout(() => window.location.reload(), 400);
		}
	};

	const addWidget = kind => {
		if (items.some(item => item.kind === kind)) {
			setStatusMsg(`「${kind}」已经在页面上（不允许重复添加）`);
			return;
		}
		const entry = boot.catalog.find(c => c.kind === kind);
		const base = { id: `w-${kind}`, kind, w: entry ? entry.w : GRID_COLUMNS, h: entry ? entry.h : 1, config: {} };
		// 自由摆放：新卡放在**现有卡片最下方**（x=0），不去重排别人（用户自己摆好的位置不能动 ✗）
		const bottom = items.reduce((max, item) => Math.max(max, (Number.isFinite(item.y) ? item.y : 0) + (item.h || 1)), 0);
		const next = [...items, isFree ? { ...base, x: 0, y: Math.min(MAX_ROWS_FREE - 1, bottom) } : base];
		setItems(next);
		void save(next, undefined, '添加组件');
	};

	const removeWidget = id => {
		const next = items.filter(item => item.id !== id);
		setItems(next);
		void save(next, undefined, '移除组件');
	};

	/** 组件自己的设置（目前只有工作台的 `config.order`）⇒ 跟着布局一起存盘。 */
	const saveConfig = (id, config) => {
		const next = items.map(item => (item.id === id ? { ...item, config } : item));
		setItems(next);
		void save(next, undefined, '更新卡片设置');
	};

	const resizeWidget = (id, w, h) => {
		const next = items.map(item => (item.id === id ? { ...item, w, h } : item));
		const resolved = isFree ? resolveOverlaps(next, id) : next;
		setItems(resolved);
		void save(resolved, undefined, '调整尺寸');
	};

	/**
	 * 切换布局模式。
	 *
	 * ⚠ flow → free 这一步是**有损换算**：`h` 从"最小高度"变成"真实高度" ⇒ 必须先把每张卡的
	 *   **实测高度**折算成行，否则 h=1 的卡（关键指标/诊断行）在自由模式下只有 24px 高、内容全溢出 ✗。
	 * ⚠ free → flow 要把 x/y **剥掉**（`stripPlacement`）—— 留着就是半套数据，下次归一化会认它。
	 */
	const toggleMode = () => {
		if (mode === 'flow') {
			const grid = gridRef.current;
			const rowUnit = Math.max(8, rowPx + gapPx);
			const measured = items.map(item => {
				const node = grid ? grid.querySelector(`[data-dash-id="${item.id}"]`) : null;
				if (!node) { return item; }
				const px = node.getBoundingClientRect().height + gapPx;
				return { ...item, h: clampInt(Math.ceil(px / rowUnit), 1, MAX_ROWS_FREE, item.h) };
			});
			const placed = packFlow(measured);
			setMode('free');
			setItems(placed);
			void save(placed, { ...(boot.settings || {}), mode: 'free' }, '切到自由摆放');
		} else {
			const flat = stripPlacement(items);
			setMode('flow');
			setItems(flat);
			void save(flat, { ...(boot.settings || {}), mode: 'flow' }, '切回自动排列');
		}
	};

	/**
	 * 自动收紧：页面加载后**自查一次**，把"明显虚高"的卡缩回内容高度。
	 *
	 * 为什么要自动：`h` 只在顺序流里当最小高度，历史上（"切自由摆放就长高"那个 bug）被顶高的值会
	 * 永久留在布局文件里 —— 用户得自己发现「收紧高度」按钮、还得先切到自动排列 + 编辑态才能点。
	 * 一个一次性的数据损坏，不该让每个人手动收拾。
	 *
	 * 两条纪律：
	 *  ① **只在内存里改，不 save**（"读一页不产生文件"）。用户下次改布局时会一并落盘。
	 *  ② **阈值 `AUTO_TIGHTEN_MIN_ROWS`**：只收"虚高 ≥3 行"的卡。用户可能故意把 `h` 调大留白
	 *     （+1~2 行），那不该被抹掉；而被 bug 顶高的通常是 +5 行以上，一收一个准。
	 */
	const AUTO_TIGHTEN_MIN_ROWS = 3;
	const AUTO_TIGHTEN_MAX_ROUNDS = 1;
	const autoTightenedRef = React.useRef(0);
	const tightenRef = React.useRef(null);

	/**
	 * 真正量一次内容高度并按需改写 `h`：手动按钮与自动自查**共用这一份**（否则两处算法迟早分家）。
	 *
	 * @param persist  要不要落盘（手动 = true；自动 = false，遵守"读一页不产生文件"）
	 * @param reason   落盘时的原因文案
	 * @param minDelta 只收「虚高 ≥ minDelta 行」的卡（自动传 3，手动传 0）
	 */
	tightenRef.current = (persist, reason, minDelta) => {
		setMeasuring(true);
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				const grid = gridRef.current;
				const rowUnit = Math.max(8, rowPx + gapPx);
				let changed = 0;
				const next = items.map(item => {
					const node = grid ? grid.querySelector(`[data-dash-id="${item.id}"]`) : null;
					if (!node) { return item; }
					const px = node.getBoundingClientRect().height + gapPx;
					const h = clampInt(Math.ceil(px / rowUnit), 1, MAX_ROWS, item.h);
					// 只**收**不放：`h` 是下限，比内容矮是允许的（内容自己撑开）
					if (h >= item.h || item.h - h < minDelta) { return item; }
					changed += 1;
					return { ...item, h };
				});
				setMeasuring(false);
				if (!changed) { return; }
				setItems(next);
				if (persist) {
					void save(next, undefined, `${reason}（${changed} 张）`);
				} else {
					setStatusMsg(`已按内容收紧 ${changed} 张卡（尚未落盘，下次改布局时会一并保存）`);
				}
			});
		});
	};

	// 加载后自查一次（见 AUTO_TIGHTEN_MIN_ROWS 的注释）。`autoTightenedRef` 保证只跑 AUTO_TIGHTEN_MAX_ROUNDS 次，
	// 免得和用户自己的操作打架（他手动放大某张卡，不该在下一帧又被收回去）。
	React.useEffect(() => {
		if (isFree || !items.length) { return; }
		if (autoTightenedRef.current >= AUTO_TIGHTEN_MAX_ROUNDS) { return; }
		autoTightenedRef.current += 1;
		tightenRef.current(false, '自动收紧', AUTO_TIGHTEN_MIN_ROWS);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isFree, items.length]);

	// 随容器宽度降列 + 跟着重算高度（窗口缩放 / 页面 zoom / 侧栏开合都会触发）
	React.useEffect(() => {
		const grid = gridRef.current;
		if (!grid || typeof ResizeObserver !== 'function') { return undefined; }
		let timer = 0;
		const apply = width => {
			const next = width >= 980 ? GRID_COLUMNS : width >= 760 ? 8 : width >= 560 ? 6 : 4;
			if (next === colsRef.current) { return false; }
			colsRef.current = next;
			setCols(next);
			return true;
		};
		apply(grid.getBoundingClientRect().width);
		const observer = new ResizeObserver(entries => {
			const width = entries[0] ? entries[0].contentRect.width : grid.getBoundingClientRect().width;
			const changed = apply(width);
			if (!changed) { return; }
			// 列数变了 ⇒ 每张卡的可用宽度与内容高度都变了 ⇒ 重算一次（**只收不放**，不会把卡片越撑越高）
			window.clearTimeout(timer);
			timer = window.setTimeout(() => { tightenRef.current(false, '自适应收紧', AUTO_TIGHTEN_MIN_ROWS); }, 240);
		});
		observer.observe(grid);
		return () => { window.clearTimeout(timer); observer.disconnect(); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/**
	 * 「收紧高度」：把每张卡的 `h` 重新按**内容高度**折算（顺序流下 `h` 只是最小高度）。
	 *
	 * 为什么需要它：一直用 `min-height` 的话，卡片一旦被某个 bug 定得过高（比如历史上"切自由摆放就长高"
	 * 那轮），`h` 就再也不回去；手动一张张拉回去太费。做法：先把 `min-height` 清零（测量态）
	 * ⇒ 卡片自然收缩到内容 ⇒ 量完写回 `h` ⇒ 恢复。
	 * ⚠ 只在**顺序流 + 编辑态**出现：自由摆放里 `h` 是用户自己定的真实高度，收紧它等于擅自改人家版面。
	 */
	const tightenHeights = () => {
		if (isFree) { setStatusMsg('自由摆放里高度由你定，「收紧高度」只在自动排列下有用'); return; }
		// 手动点 = 明确要"按内容收紧"，所以 minDelta 传 0（连同 +1~2 行的留白一起收）
		tightenRef.current(true, '收紧高度', 0);
	};

	/* ── 拖拽重排（指针事件 + 前后半落点判定；与老实现同口径）───────────────── */
	const onPointerDownCard = (ev, id) => {
		if (!editing) { return; }
		const target = ev.target;
		if (target && target.closest && target.closest('[data-dash-no-drag]')) { return; }
		ev.preventDefault();
		const startY = ev.clientY;
		const startX = ev.clientX;
		const elGrid = gridRef.current;

		// ── 自由摆放：二维移动（按格吸附），松手后把被压到的卡推下去 ──────────────
		if (isFree) {
			const item = itemsRef.current.find(entry => entry.id === id);
			if (!item || !elGrid) { return; }
			const rect = elGrid.getBoundingClientRect();
			const colW = rect.width / GRID_COLUMNS;
			const rowUnit = Math.max(8, rowPx + gapPx);
			const from = { x: Number.isFinite(item.x) ? item.x : 0, y: Number.isFinite(item.y) ? item.y : 0 };
			let armedFree = false;
			const moveFree = e => {
				if (!armedFree && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 4) { return; }
				armedFree = true;
				const x = clampInt(from.x + Math.round((e.clientX - startX) / colW), 0, GRID_COLUMNS - item.w, from.x);
				const y = clampInt(from.y + Math.round((e.clientY - startY) / rowUnit), 0, MAX_ROWS_FREE - 1, from.y);
				setDrag({ id, x, y });
				setItems(prev => prev.map(entry => (entry.id === id ? { ...entry, x, y } : entry)));
			};
			const upFree = () => {
				window.removeEventListener('pointermove', moveFree);
				window.removeEventListener('pointerup', upFree);
				setDrag(null);
				if (!armedFree) { return; }
				const next = resolveOverlaps(itemsRef.current, id);
				setItems(next);
				void save(next, undefined, '移动位置');
			};
			window.addEventListener('pointermove', moveFree);
			window.addEventListener('pointerup', upFree);
			return;
		}

		let armed = false;
		const move = e => {
			if (!armed && Math.abs(e.clientY - startY) + Math.abs(e.clientX - startX) < 4) { return; }
			armed = true;
			// 找落点：指针下的卡片；上下半决定 before/after
			const cards = [...elGrid.querySelectorAll('[data-dash-id]')];
			let dropBefore = null;
			for (const card of cards) {
				if (card.getAttribute('data-dash-id') === id) { continue; }
				const r = card.getBoundingClientRect();
				if (e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right) {
					const beforeHalf = e.clientY < r.top + r.height / 2;
					dropBefore = beforeHalf ? card.getAttribute('data-dash-id') : (card.nextElementSibling ? card.nextElementSibling.getAttribute('data-dash-id') : null);
					break;
				}
			}
			setDrag({ id, dropBefore });
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			setDrag(prev => {
				if (prev && armed) {
					const next = moveBefore(items, prev.id, prev.dropBefore);
					setItems(next);
					void save(next, undefined, '调整顺序');
				}
				return null;
			});
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};

	/* ── 缩放（右下角手柄；列 × 行）───────────────────────────────────────── */
	const onResizeDown = (ev, item) => {
		ev.preventDefault();
		ev.stopPropagation();
		const startX = ev.clientX;
		const startY = ev.clientY;
		const startW = item.w;
		const startH = item.h;
		const elGrid = gridRef.current;
		const colW = elGrid.getBoundingClientRect().width / GRID_COLUMNS;
		// 自由摆放：宽度最多到右边界（否则会把自己拽出网格 ⇒ 被 clamp 回来，手感像"卡住"）
		const maxW = isFree ? Math.max(1, GRID_COLUMNS - (Number.isFinite(item.x) ? item.x : 0)) : GRID_COLUMNS;
		// 自由摆放里 h 是真实高度（上限 MAX_ROWS_FREE）；顺序流里它是最小高度（上限 MAX_ROWS）
		const maxH = isFree ? MAX_ROWS_FREE : MAX_ROWS;
		const move = e => {
			const dw = Math.round((e.clientX - startX) / Math.max(1, colW));
			const dh = Math.round((e.clientY - startY) / Math.max(8, rowPx + gapPx));
			const w = clampInt(startW + dw, 1, maxW, startW);
			const hh = clampInt(startH + dh, 1, maxH, startH);
			setItems(prev => prev.map(x => (x.id === item.id ? { ...x, w, h: hh } : x)));
		};
		const up = e => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			const dw = Math.round((e.clientX - startX) / Math.max(1, colW));
			const dh = Math.round((e.clientY - startY) / Math.max(8, rowPx + gapPx));
			resizeWidget(item.id, clampInt(startW + dw, 1, maxW, startW), clampInt(startH + dh, 1, maxH, startH));
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};

	// 组件的**元数据**（图标 / 强调色 / 名称 / 描述）来自目录岛（`serializeCatalog` 的产物）⇒
	//   扩展一个组件时只要在 `catalog.js` 填了这几个字段，卡片头 / 画廊 / 占位就自动一致 ✓
	const metaOf = kind => (boot.catalog || []).find(entry => entry.kind === kind) || {};

	const cards = items.map(item => {
		const dropMark = drag && drag.dropBefore === item.id ? ' before' : '';
		const meta = metaOf(item.kind);
		// 标题优先级：布局项自带的 title（老字段，兼容手改 layout.json）> 目录里的 name > kind
		const cardTitle = item.title || meta.name || item.kind;
		return el('section', {
			key: item.id,
			className: `dash-w${editing ? ' dash-editing-card' : ''}${drag && drag.id === item.id ? ' dash-dragging' : ''}`,
			'data-dash-id': item.id,
			'data-dash-widget': item.kind,
			'data-dash-w': String(item.w),
			'data-dash-h': String(item.h),
			'data-dash-drop': dropMark ? 'before' : undefined,
			// 自由摆放：位置由 (x, y) 定死（`h` 是真实高度），**列数固定 12**（x 是坐标，不能降列）；
			// 顺序流：跨列按 `min(w, 当前列数)`，窄屏时 12 列的 w 会被压到实际列数内（不至于溢出）
			style: isFree && Number.isFinite(item.x) && Number.isFinite(item.y)
				? { gridColumn: `${item.x + 1} / span ${item.w}`, gridRow: `${item.y + 1} / span ${item.h}` }
				// 跨度**按比例**换算而不是简单 clamp：12 列下 `7+5` 是满行，降到 8 列时
				// 简单 clamp 会变成 `7+5`（超列 ⇒ 各占一行，留半个空行）；按比例得到 `5+3` ⇒ 仍是满行。
				: { gridColumn: `span ${Math.min(cols, Math.max(1, Math.round((item.w * cols) / GRID_COLUMNS)))}`, ...minHeightStyle(item, rowPx, gapPx) },
			onPointerDown: e => onPointerDownCard(e, item.id),
		},
			editing ? el('span', { className: 'dash-tools' },
				el('span', { 'data-dash-size': true }, `${item.w}×${item.h}`),
				// 齿轮：**只有声明了 configFields 的组件才有**（没可配项的组件不该出现空面板）
				(meta.configFields || []).length ? el('button', {
					type: 'button', className: 'dash-x', 'data-dash-no-drag': true,
					'data-dash-action': 'config',
					title: '卡片设置', 'aria-expanded': cfgOpen === item.id ? 'true' : 'false',
					onClick: () => setCfgOpen(prev => (prev === item.id ? null : item.id)),
				}, '⚙') : null,
				el('button', {
					type: 'button', className: 'dash-x', 'data-dash-no-drag': true,
					// ⚠ 保留 `data-dash-action`：探针 / 守卫按它认"移除"这颗按钮（DOM 契约不随渲染层换掉）
					'data-dash-action': 'remove',
					title: '移除这个组件', onClick: () => removeWidget(item.id),
				}, '✕'),
			) : null,
			// 统一卡片头：图标（按 accent 着色）+ 标题。**组件自己不再画标题** ⇒ 风格不会漂移。
			el('div', { className: 'dash-card-head' },
				el('span', {
					className: 'dash-card-ico',
					style: meta.accent ? { color: meta.accent } : undefined,
					title: meta.description || undefined,
				}, el(Icon, { name: meta.icon })),
				el('span', { className: 'dash-card-title' }, cardTitle),
			),
			// 卡片设置（声明式：字段来自目录岛的 configFields）
			cfgOpen === item.id && (meta.configFields || []).length
				? el(CardSettings, {
					fields: meta.configFields,
					config: item.config,
					onApply: next => { saveConfig(item.id, next); setCfgOpen(null); },
					onClose: () => setCfgOpen(null),
				})
				: null,
			// 每卡各自兜错：一个组件抛错只坏这一块（否则 React 会卸掉整个 root ⇒ 整页空白 ✗）
			el(CardBoundary, { kind: item.kind, key: item.kind },
				el(CardBody, {
					item,
					model: boot.model,
					onSaveConfig: cfg => saveConfig(item.id, cfg),
					setStatus: setStatusMsg,
				}),
			),
			editing ? el('span', {
				className: 'dash-resize', 'data-dash-no-drag': true,
				// ⚠ 同上：探针按 `data-dash-resize` 认这颗手柄
				'data-dash-resize': true,
				title: '拖动缩放（列 × 行）',
				onPointerDown: e => onResizeDown(e, item),
			}) : null,
		);
	});

	return el('div', { className: 'dash-app' },
		el('div', { className: `dash-bar${editing ? ' is-editing' : ''}` },
			el('button', {
				type: 'button', className: `dash-btn${editing ? ' primary' : ''}`, 'data-dash-action': 'edit', 'data-dash-edit-toggle': true,
				title: editing ? '完成编排（也可以按 Esc）' : '进入编排：可拖拽排序、改尺寸、增减组件',
				onClick: toggleEditing,
			}, editing ? '完成编排' : '编排'),
			el('button', {
				type: 'button', className: 'dash-btn dash-btn-add', 'data-dash-action': 'gallery',
				style: { display: editing ? 'inline-flex' : 'none' },
				onClick: () => setGalleryOpen(v => !v),
			}, '＋ 添加组件'),
			// 布局模式开关（只在编辑态出现）：自由摆放 ⇄ 自动排列
			el('button', {
				type: 'button', className: 'dash-btn', 'data-dash-action': 'mode',
				style: { display: editing ? 'inline-flex' : 'none' },
				title: isFree ? '切回自动排列（按顺序流排布，坐标会被清掉）' : '自由摆放（可拖到任意格，允许留空）',
				onClick: toggleMode,
			}, isFree ? '自动排列' : '自由摆放'),
			// 顺序流专属：把过高的 `h` 按内容收紧（历史 bug 遗留的"卡片越来越高"用它一次修好）
			!isFree ? el('button', {
				type: 'button', className: 'dash-btn', 'data-dash-action': 'tighten',
				style: { display: editing ? 'inline-flex' : 'none' },
				title: '按内容重新计算每张卡的高度（顺序流下 h 是最小高度，过高的会缩回去）',
				onClick: tightenHeights,
			}, '收紧高度') : null,
			// 自由摆放专属：把卡片往上顶紧（只动纵向，不打乱左右位置）
			isFree ? el('button', {
				type: 'button', className: 'dash-btn', 'data-dash-action': 'compact',
				style: { display: editing ? 'inline-flex' : 'none' },
				title: '整理空位：所有卡片往上、往左并拢（纵向 + 跨列填洞）',
				onClick: () => {
					const next = compactGrid(items);
					setItems(next);
					void save(next, undefined, '整理空位');
				},
			}, '整理') : null,
			// 多套布局（只在编辑态出现，避免误切）：切换 / 存为 / 删除
			editing ? el('span', { className: 'dash-preset', 'data-dash-preset-bar': activePreset },
				el('select', {
					className: 'dash-cfg-select',
					'data-dash-action': 'preset-switch',
					title: '切换布局预设（会重新加载页面）',
					value: activePreset,
					onChange: ev => void switchPreset(ev.target.value),
				}, presets.map(name => el('option', { key: name, value: name }, name))),
				el('button', {
					type: 'button', className: 'dash-btn', 'data-dash-action': 'preset-save',
					title: '把当前布局另存为一个预设',
					onClick: () => setPresetForm(prev => (prev && prev.mode === 'saveAs' ? null : { mode: 'saveAs', value: '' })),
				}, '存为…'),
				el('button', {
					type: 'button', className: 'dash-btn', 'data-dash-action': 'preset-rename',
					title: `重命名当前预设「${activePreset}」（不改内容，只换名字）`,
					onClick: () => setPresetForm(prev => (prev && prev.mode === 'rename' ? null : { mode: 'rename', value: activePreset })),
				}, '重命名'),
				presets.length > 1 ? el('button', {
					type: 'button', className: `dash-btn${deleteArmed ? ' primary' : ''}`, 'data-dash-action': 'preset-delete',
					title: deleteArmed ? '再点一次确认删除' : `删除预设「${activePreset}」（至少留一个）`,
					onClick: () => void deletePreset(),
				}, deleteArmed ? '确认删除' : '删除') : null,
			) : null,
			el('span', { className: 'dash-status', 'data-dash-status': true }, status),
		),
		// 「存为预设」的输入行（展开时才有）
		presetForm !== null ? el('div', { className: 'dash-preset-save', 'data-dash-preset-form': presetForm.mode },
			el('input', {
				className: 'dash-cfg-text',
				type: 'text',
				'data-dash-preset-name': true,
				maxLength: 24,
				placeholder: presetForm.mode === 'rename' ? '新名字（最多 24 字）' : '预设名（最多 24 字）',
				value: presetForm.value,
				onChange: ev => setPresetForm(prev => (prev ? { ...prev, value: ev.target.value } : prev)),
				onKeyDown: ev => { if (ev.key === 'Enter') { void submitPresetForm(); } },
			}),
			el('button', { type: 'button', className: 'dash-btn primary', 'data-dash-action': 'preset-save-ok', onClick: () => void submitPresetForm() }, presetForm.mode === 'rename' ? '改名' : '保存'),
			el('button', { type: 'button', className: 'dash-btn', 'data-dash-action': 'preset-save-cancel', onClick: () => setPresetForm(null) }, '取消'),
		) : null,
		galleryOpen && editing ? el('div', { className: 'dash-gallery', 'data-dash-gallery': true },
			el('p', { className: 'dash-gallery-title' }, '加一个组件：'),
			boot.catalog.map(entry => {
				const added = items.some(item => item.kind === entry.kind);
				return el('button', {
					key: entry.kind, type: 'button',
					className: `dash-gallery-item${added ? ' is-added' : ''}`,
					'data-dash-action': 'add', 'data-dash-kind': entry.kind,
					...(added ? { 'data-dash-added': '1', 'aria-disabled': 'true' } : {}),
					onClick: () => addWidget(entry.kind),
				},
					el('b', null, entry.name),
					el('small', null, added ? '已经在页面上（不允许重复添加）' : `${entry.description} · ${entry.w}×${entry.h}`),
				);
			}),
		) : null,
		el('div', {
			className: `dash-grid${editing ? ' dash-editing' : ''}${isFree ? ' dash-free' : ''}`,
			'data-dash-grid': '1',
			// 测量态：CSS 会清零 min-height ⇒ 量到的是内容高度（见 tightenHeights）
			...(measuring ? { 'data-dash-measure': '1' } : {}),
			'data-dash-count': String(items.length),
			'data-dash-mode': mode,
			'data-dash-api': boot.api,
			ref: gridRef,
			// 自由摆放：行高固定成 `--dash-row`（24px），`h` 行 = h*24 + (h-1)*gap ⇒ 与坐标语义一致；
			// 顺序流：列数随容器宽度自适应（`cols`），太窄时自由摆放改为横向滚动而不是把坐标挤坏
			style: isFree
				? { gridAutoRows: `${rowPx}px`, minWidth: cols < GRID_COLUMNS ? `${GRID_COLUMNS * 64}px` : undefined, overflowX: 'auto' }
				: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` },
		}, cards),
		// 悬浮「完成编排」：**固定定位，永远在视野里** —— 工具栏滚出屏幕时这就是唯一出口。
		// 真机反馈「进了编排回不来」的直接对策（Esc 是第三条路）。
		editing ? el('button', {
			type: 'button', className: 'dash-done-float', 'data-dash-action': 'edit-done',
			title: '完成编排（Esc 也可以）',
			onClick: exitEditing,
		}, '✓ 完成编排') : null,
	);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 挂载
 * ──────────────────────────────────────────────────────────────────────────── */

function boot() {
	const layoutJson = readJson('[data-dash-layout-json]') || {};
	const model = readJson('[data-dash-model-json]') || {};
	const catalog = readJson('[data-dash-catalog-json]') || [];
	const gridEl = document.querySelector('[data-dash-grid]');
	const rootEl = document.querySelector('[data-dash-app-root]');
	// 写口路径**由页面给**（`data-dash-api`），不在客户端拼 URL —— 页面在 `/x/dashboard` 与
	// `/x/dashboard/` 两种形态下都要能用。
	const api = (rootEl && rootEl.getAttribute('data-dash-api'))
		|| (gridEl && gridEl.getAttribute('data-dash-api'))
		|| '/x/dashboard/api/layout';

	/**
	 * 行高 / 间距：**以服务端注入的 CSS 变量为准**（`--dash-row` / `--dash-gap` 挂在挂载点上）。
	 *
	 * ⚠ 这里曾用 `boot.settings?.gap || 0` —— 布局文件没存 `settings` 时得到 **0**，而服务端 CSS
	 *   用的是 `DEFAULT_GAP = 12` ⇒ 页面按"每行 24px"折算、实际每行 36px，**每点一次「自由摆放」
	 *   行数就涨一半**（36h-12 被算成 1.5h 行，来回点就单调长高）。真机复现：期望 6 行算出 8 行。
	 * ⇒ 现在三种来源按顺序取：**计算后的 CSS 变量** → 岛里的 settings → 常量默认值。
	 */
	const cssVarPx = (name, fallback) => {
		try {
			const raw = rootEl ? getComputedStyle(rootEl).getPropertyValue(name) : '';
			const parsed = parseFloat(String(raw).trim());
			return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
		} catch {
			return fallback;
		}
	};

	deriveTokens();
	if (window.matchMedia) {
		try {
			window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', deriveTokens);
			// 高对比是**独立**的一条：IDE 切到 hc-* 主题时明暗可能不变，但对比度要求变了
			window.matchMedia('(prefers-contrast: more)').addEventListener('change', deriveTokens);
		} catch { /* 老浏览器 */ }
	}

	const settings = layoutJson.settings || {};
	let bootItems = Array.isArray(layoutJson.items) ? layoutJson.items : [];
	// 自由摆放但坐标缺了（手改过 layout.json / 半套数据）⇒ 页面自己补一次装箱，别让卡片全叠在 (0,0)
	if (normalizeMode(settings.mode) === 'free' && !bootItems.some(item => Number.isFinite(item.x) && Number.isFinite(item.y))) {
		bootItems = packFlow(bootItems);
	}

	const payload = {
		items: bootItems,
		updatedAt: Number.isFinite(layoutJson.updatedAt) ? layoutJson.updatedAt : 0,
		settings,
		// 多套布局：`active` 是当前生效的预设名，`presets` 是全部名字（顺序即落盘顺序）
		active: typeof layoutJson.active === 'string' && layoutJson.active ? layoutJson.active : 'default',
		presets: Array.isArray(layoutJson.presets) && layoutJson.presets.length ? layoutJson.presets : ['default'],
		model,
		catalog,
		api,
		// 行高 / 间距：CSS 变量优先（见上面 `cssVarPx` 的注释——这两值错了会让"切自由摆放就长高"）
		rowPx: cssVarPx('--dash-row', Number.isFinite(settings.rowHeight) ? settings.rowHeight : DEFAULT_ROW_HEIGHT),
		gapPx: cssVarPx('--dash-gap', Number.isFinite(settings.gap) ? settings.gap : DEFAULT_GAP),
	};

	if (!rootEl) { return; }
	// 根级兜底：任何渲染崩溃都变成"一屏说明 + 重新加载"，而不是把页面卸成空白
	createRoot(rootEl).render(h(AppBoundary, null, h(Dashboard, { boot: payload })));
}

if (typeof window !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot, { once: true });
	} else {
		boot();
	}
}
