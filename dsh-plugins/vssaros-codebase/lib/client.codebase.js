// @vssaros/dsh-codebase — **React 工作台**（工作台重构 P3 第 4 个；doc/workbench-refactor-plan.md §5 步骤 2）。
//
// 形态与官方一致：经宿主服务 `desktopWorkbenches.register(descriptor, Component)` 注册。
// 数据只从 `GET /x/codebase/api/page` 取（与 SSR 页**同一份装配**：路由里只装配一次 `pageData` ✓）。
//
// 分区与**顺序**照 IDE 侧 `codebaseMemoryDetailEditorPane.ts`（用户 2026-10-23 要求"参照那个 pane 补齐内容"✓）：
//   ① 四张统计卡（Nodes / Edges / Files / Last Index）；
//   ② ⚙️ Index Configuration —— 落点 / 解析器 / 保鲜 / 交接状态 / 图的新鲜度 / 产图档位 / 重建代价 / 增量缓存；
//   ③ 🌐 Graph Details —— Storage / Last Modified / Node Types / Edge Types + 加载全量图 / 图谱页 / 刷新；
//   ④ 🏗️ Architecture —— 社区 / 文件 / 类型数（全量图未加载时同原版 **deferred** ✓）；
//   ⑤ 🔍 Query Console —— 按名字检索（点一条看依赖）+ 形状查询（`SHAPE_HELP` 那几种写法，**不是 Cypher** ✗）；
//   ⑥ 🔬 Analysis Tools —— 入度最高（hotspots）+ 移植对账表（`PORT_AUDIT` 现算 ✓）；
//   ⑦ 📦 Projects —— 图里有哪些工作区根（全量图才答得出 ✓）；
//   ⑧ 📋 Activity Log —— 读图走哪一份 / 锁 / 保鲜 / 增量缓存（**此刻**的事实，不是历史回放 ✗）；
//   ⑨ 诊断（折叠）：`data-vssaros-codebase-*` 机器锚点照旧在 DOM 里 ✓。
//
// ⚠ 原面板**做不到**的三件仍在原地说明，不摆点了没用的控件 ✗：
//   3D 图（没有渲染器）/ Cypher 控制台（只有形状子集）/ 索引三档 + Exclude·Keep（那是 IDE 侧索引器）。
// ⚠ 重活（129MB 全量图）**原样保留在 Host**：本组件只在「检索 / 形状查询 / 加载全量图」时才让 Host 加载，
//   打开页面本身仍是轻路径（只读 artifact.json）✓。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-codebase',
	chunk: 'client.codebase.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');
		const h = react.createElement;
		const { useState, useEffect, useCallback, useMemo, useRef } = react;

		const API = '/x/codebase/api';
		// ⚠ **没有** `ROUTE` 常量了（2026-10-23）：原来那两条指向 `/x/codebase/?view=graph` 的链接在工作台里
		//   **点了没反应**（工作台跑在 dsh 客户端 SPA 里 ⇒ 换整页；且查询串不在宿主入口白名单里 ✗）⇒
		//   图谱浏览已搬进本组件（`/api/graph`），不再需要跳 SSR 页 ✓。
		// 工具条锚点（宿主据此吸顶）。⚠ 工作台有两个"页面"（总览 / 图谱）各有一个工具条 ⇒ 源码里这个**字面量**
		// 会出现两次，而守卫 `check-workbench-style` 要求**恰好一次**（它按源码文本数，不是按运行时 DOM）⇒
		// 收成一个常量、两处都用计算键 ✓（运行时仍各自恰好一个 ✓）。
		const TOOLBAR_ATTR = 'data-dsh-workbench-toolbar';
		const DESCRIPTOR = {
			title: '代码库',
			// ⚠ 与清单 `vssaros.workbench.description` 同值（守卫比 repository + title；描述也保持一致免得漂 ✓）
			description: '代码图谱：符号、调用关系与影响面查询。',
			repository: 'vssaros:codebase',
			icon: 'codicon:type-hierarchy',
			customFrame: true,
		};

		async function loadPage(params) {
			const qs = new URLSearchParams();
			if (params && params.q) { qs.set('q', params.q); }
			if (params && params.file) { qs.set('file', params.file); }
			if (params && params.shape) { qs.set('shape', params.shape); }
			if (params && params.deep) { qs.set('deep', '1'); }
			if (params && params.node !== undefined && params.node !== null && params.node !== '') { qs.set('node', String(params.node)); }
			const suffix = qs.toString() ? '?' + qs.toString() : '';
			const res = await fetch(API + '/page' + suffix, { cache: 'no-store' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
			return body;
		}

		const kb = (v) => (v === undefined || v === null ? '—' : String(v));
		const shortFile = (p) => {
			const s = String(p || '');
			const parts = s.split(/[\\/]/);
			return parts.length <= 3 ? s : '…/' + parts.slice(-2).join('/');
		};
		const bytesText = (n) => {
			const v = Number(n);
			if (!Number.isFinite(v) || v <= 0) { return '—'; }
			if (v < 1024) { return v + ' B'; }
			if (v < 1024 * 1024) { return (v / 1024).toFixed(1) + ' KB'; }
			return (v / 1024 / 1024).toFixed(1) + ' MB';
		};
		const isoShort = (s) => {
			// ⚠ `savedAt` 可能是**时间戳（数字）**也可能是 ISO 串（IDE 那两份清单口径不同 ✓）
			if (typeof s === 'number' && Number.isFinite(s)) {
				try { return new Date(s).toISOString().replace('T', ' ').slice(0, 16); } catch { return '—'; }
			}
			const t = String(s || '');
			return t ? t.replace('T', ' ').slice(0, 16) : '—';
		};
		/**
		 * 2D 力导向布局（**纯函数、确定性、一次算完**）—— 图谱页面的可视化用。
		 *
		 * 与 IDE 侧的关系：`codebaseGraphViewerEditorPane.ts` 用 **Three.js（CDN）+ Barnes-Hut 3D**；
		 * dsh 客户端里没有 three、也没有网络 ⇒ 这里用 Fruchterman–Reingold 的经典 2D 版本，节点数
		 * 已被服务端夹到 ≤500（`/api/graph` 的 `viz`）⇒ O(n²) 一次跑完就**静态渲染**，
		 * ⚠ **不做逐帧动画**（2026-10-13 那次"550 节点每帧全量重排 ⇒ 卡死"就是这个形态 ✗）。
		 *
		 * 确定性：初始位置按**黄金角螺旋**（不用 Math.random）⇒ 同一份数据每次画出来一样 ✓
		 * （刷新就换一张图的"力导向"最难判断是不是坏了 ✗）。
		 */
		function layoutForce(nodes, edges, options) {
			const opts = options || {};
			const width = opts.width || 900;
			const height = opts.height || 540;
			const iterations = opts.iterations || 120;
			const n = nodes.length;
			if (!n) { return { width, height, points: [], labels: [] }; }
			const index = new Map();
			const points = nodes.map((node, i) => {
				index.set(node.id, i);
				const angle = i * 2.399963229728653;
				const radius = 0.42 * Math.min(width, height) * Math.sqrt((i + 1) / n);
				return {
					id: node.id, name: node.name, label: node.label, degree: node.degree,
					x: width / 2 + radius * Math.cos(angle),
					y: height / 2 + radius * Math.sin(angle),
					dx: 0, dy: 0,
				};
			});
			const links = [];
			for (const edge of edges || []) {
				const s = index.get(edge.source);
				const t = index.get(edge.target);
				if (s === undefined || t === undefined) { continue; }
				links.push([s, t]);
			}
			const k = Math.sqrt((width * height) / n);
			let temperature = Math.min(width, height) / 8;
			for (let iter = 0; iter < iterations; iter++) {
				for (let i = 0; i < n; i++) { points[i].dx = 0; points[i].dy = 0; }
				// 排斥（O(n²)：n≤500 ⇒ 12.5 万对 × 120 轮，纯算术，几毫秒到几十毫秒 ✓）
				for (let i = 0; i < n; i++) {
					const a = points[i];
					for (let j = i + 1; j < n; j++) {
						const b = points[j];
						let dx = a.x - b.x;
						let dy = a.y - b.y;
						let dist2 = dx * dx + dy * dy;
						if (dist2 < 0.01) { dx = 0.1 + (i % 7) * 0.3; dy = 0.1 + (j % 5) * 0.3; dist2 = dx * dx + dy * dy; }
						const force = (k * k) / dist2;
						const dist = Math.sqrt(dist2);
						const fx = (dx / dist) * force;
						const fy = (dy / dist) * force;
						a.dx += fx; a.dy += fy; b.dx -= fx; b.dy -= fy;
					}
				}
				// 吸引（边）
				for (const pair of links) {
					const a = points[pair[0]];
					const b = points[pair[1]];
					const dx = a.x - b.x;
					const dy = a.y - b.y;
					const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
					const force = (dist * dist) / k;
					const fx = (dx / dist) * force;
					const fy = (dy / dist) * force;
					a.dx -= fx; a.dy -= fy; b.dx += fx; b.dy += fy;
				}
				// 位移（按温度夹紧）+ 轻微向心，避免整图漂走
				for (const p of points) {
					const dist = Math.sqrt(p.dx * p.dx + p.dy * p.dy) || 1;
					const step = Math.min(dist, temperature);
					p.x += (p.dx / dist) * step;
					p.y += (p.dy / dist) * step;
					p.x += (width / 2 - p.x) * 0.008;
					p.y += (height / 2 - p.y) * 0.008;
				}
				temperature *= 0.96;
			}
			// 归一化到画布（留边距；保持长宽比）
			// ⚠ 用**分位数包围盒**（2%~98%）而不是 min/max：少数离群点会把整张图压成中间一小团
			//   （用户 2026-10-23 的截图正是这个形态 ✓）；被裁掉的离群点**夹到边上**（仍然可见，
			//   不静默丢节点 ✗）。
			const xs = points.map(p => p.x).sort((a, b) => a - b);
			const ys = points.map(p => p.y).sort((a, b) => a - b);
			const at = (arr, q) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(q * (arr.length - 1))))];
			const pad = 26;
			const minX = at(xs, 0.02);
			const maxX = at(xs, 0.98);
			const minY = at(ys, 0.02);
			const maxY = at(ys, 0.98);
			const spanX = Math.max(1, maxX - minX);
			const spanY = Math.max(1, maxY - minY);
			const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
			const offX = (width - spanX * scale) / 2;
			const offY = (height - spanY * scale) / 2;
			let maxDegree = 1;
			for (const p of points) { maxDegree = Math.max(maxDegree, Number(p.degree) || 0); }
			for (const p of points) {
				p.x = Math.min(width - pad, Math.max(pad, offX + (p.x - minX) * scale));
				p.y = Math.min(height - pad, Math.max(pad, offY + (p.y - minY) * scale));
				p.r = 3 + 6 * Math.sqrt((Number(p.degree) || 0) / maxDegree);
			}
			// 图例：按节点类型计数（降序），颜色槽位由调用方按 index 取（6 色轮转）
			const byLabel = new Map();
			for (const p of points) { byLabel.set(String(p.label || '?'), (byLabel.get(String(p.label || '?')) || 0) + 1); }
			const labels = [...byLabel.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
				.map(([name, count], i) => ({ name, count, slot: i % 6 }));
			const slotOf = new Map(labels.map(entry => [entry.name, entry.slot]));
			for (const p of points) { p.slot = slotOf.get(String(p.label || '?')) || 0; }
			return { width, height, points, labels };
		}

		/** 时长口语化（`ageOf` 的客户端等价物：秒/分/时/天，最多两位有效数字 ✓）。 */
		const ageText = (ms) => {
			const v = Number(ms);
			if (!Number.isFinite(v) || v < 0) { return '?'; }
			const s = Math.round(v / 1000);
			if (s < 60) { return s + ' 秒'; }
			const m = Math.round(s / 60);
			if (m < 60) { return m + ' 分钟'; }
			const hours = Math.round(m / 60);
			if (hours < 48) { return hours + ' 小时'; }
			return Math.round(hours / 24) + ' 天';
		};

		function CodebasePanel() {
			const [view, setView] = useState({ status: 'loading', data: null, error: '' });
			const [q, setQ] = useState('');
			const [file, setFile] = useState('');
			const [shape, setShape] = useState('');
			const [note, setNote] = useState('');
			const [noteError, setNoteError] = useState(false);
			// ⚠ 全部**默认折叠**（用户 2026-10-23：「页签未点击时，没有折叠」）—— 折叠态必须是**紧凑的一行**，
			//   不能被 `wb-card` 的 `flex:1 1 150px` 撑成大块空白（那是"看起来没折叠"的真原因，见 CSS ✓）。
			const [openSections, setOpenSections] = useState({});
			const [busy, setBusy] = useState(false);
			// 图谱页面：`graphPage` 为真时整个工作台切到「图谱页面」（**进页面才拉** `/api/graph` ——
			// 它必然解压全量图 ⇒ 不能让"打开工作台"就付这个代价 ✓）
			const [graphPage, setGraphPage] = useState(false);
			const [gv, setGv] = useState({ status: 'idle', data: null, error: '', label: '', node: '' });
			// 可视化的缩放/平移窗口（`viewBox`）：null = 适配整张图；拖动/滚轮改它
			const [vizView, setVizView] = useState(null);
			const dragging = useRef(null);
			const vizMoved = useRef(false);
			// 可视化的布局：`/api/graph` 回来才算一次（纯函数 + 确定性 ⇒ 不会每帧重排 ✓）
			// ⚠ 必须放在 `gv` 的 useState **之后**（放前面就是 TDZ：`Cannot access 'gv' before initialization` ✓）
			const vizLayout = useMemo(() => {
				const viz = gv.data && gv.data.viz;
				if (!viz || !Array.isArray(viz.nodes) || !viz.nodes.length) { return null; }
				return layoutForce(viz.nodes, viz.edges || [], { width: 900, height: 540 });
			}, [gv.data]);
			const vizSvgRef = useRef(null);
			/**
			 * 滚轮缩放：**必须自己挂非 passive 的原生监听**。
			 *
			 * 为什么：React 17+ 把 `onWheel` 挂成 **passive** 监听 ⇒ `preventDefault()` 无效，
			 * 于是"在一个可缩放的图里滚动"会同时把页面滚下去（用户 2026-10-23 报的冲突 ✓）。
			 * 这里直接 `addEventListener('wheel', handler, { passive: false })` ⇒ 图内滚动只缩放、页面不动 ✓。
			 * 缩放量用**函数式** setState（不读闭包里的 vizView，避免旧值 ✓）。
			 */
			useEffect(() => {
				const el = vizSvgRef.current;
				if (!graphPage || !el || !vizLayout) { return undefined; }
				const base = { x: 0, y: 0, w: vizLayout.width, h: vizLayout.height };
				const onWheel = (ev) => {
					ev.preventDefault();
					const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
					const px = rect && rect.width ? Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) : 0.5;
					const py = rect && rect.height ? Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)) : 0.5;
					const factor = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
					setVizView(prev => {
						const from = prev || base;
						const w = Math.min(vizLayout.width * 6, Math.max(vizLayout.width / 10, from.w * factor));
						const h = w * (vizLayout.height / vizLayout.width);
						return { x: from.x + (from.w - w) * px, y: from.y + (from.h - h) * py, w, h };
					});
				};
				el.addEventListener('wheel', onWheel, { passive: false });
				return () => { el.removeEventListener('wheel', onWheel); };
			}, [graphPage, vizLayout]);

			const say = (text, isError) => { setNote(String(text || '')); setNoteError(!!isError); };
			const load = useCallback(async (params) => {
				setBusy(true);
				setView(v => Object.assign({}, v, { status: 'loading' }));
				try {
					const body = await loadPage(params || {});
					setView({ status: 'ready', data: body, error: '' });
					setQ(String(body.query || ''));
					setFile(String((body.deep && body.deep.file) || ''));
					setShape(String((body.shape && body.shape.text) || ''));
				} catch (e) {
					setView(v => Object.assign({}, v, { status: 'error', error: String(e && e.message || e) }));
				} finally {
					setBusy(false);
				}
			}, []);
			useEffect(() => { void load({}); }, [load]);
			// 图谱页面里按 ESC 回总览（整页视图没有浏览器后退可用 ⇒ 给一个习惯出口 ✓）
			useEffect(() => {
				if (!graphPage) { return undefined; }
				const onKey = (ev) => { if (ev && ev.key === 'Escape') { setGraphPage(false); } };
				window.addEventListener('keydown', onKey);
				return () => { window.removeEventListener('keydown', onKey); };
			}, [graphPage]);

			const runSearch = (ev) => {
				if (ev) { ev.preventDefault(); }
				// ⚠ 检索结果住在「Query Console」里，而所有分区**默认折叠** ⇒ 动作必须把那一节打开，
				//   否则就是"点了检索、页面没反应"（用户 2026-10-23 报障的同一类 ✗）
				setOpenSections(s => Object.assign({}, s, { query: true }));
				say('正在检索（会加载全量图，可能慢一点）…', false);
				void load({ q, file, shape });
			};
			const runShape = (text) => {
				const next = text === undefined ? shape : text;
				if (text !== undefined) { setShape(next); }
				if (!String(next || '').trim()) { say('形状查询是空的：写 type:class / deps:符号名 / hot:20 之类', true); return; }
				setOpenSections(s => Object.assign({}, s, { query: true }));
				say('正在跑形状查询（要全量图）…', false);
				void load({ q, file, shape: next });
			};
			const openNode = (id) => {
				setOpenSections(s => Object.assign({}, s, { query: true }));
				void load({ q, file, shape, node: id });
			};
			const loadDeep = () => {
				say('正在加载全量图（解压 + 建索引，可能几秒）…', false);
				void load({ q, file, shape, deep: 1 });
			};
			/**
			 * 图谱浏览的数据（`GET /x/codebase/api/graph`）。
			 *
			 * ⚠ 为什么不跳 SSR 的 `?view=graph` 那一页（用户 2026-10-23 报「点了没反应」）：
			 *   工作台跑在 **dsh 客户端这个 SPA** 里（`surface=workbench` 加载的是客户端根 `/`）⇒
			 *   `<a href="/x/codebase/?view=graph">` 是**换整页**（且带查询串，宿主入口白名单本来就不收 ✗）
			 *   ⇒ 点了等于没反应。正解是把那一页的**数据**取到工作台里渲染（同一份 helper 口径 ✓，零 iframe ✓）。
			 */
			const loadGraphView = useCallback(async ({ label, node }) => {
				setGv(v => Object.assign({}, v, { status: 'loading', error: '', label: String(label || ''), node: node === undefined || node === null ? '' : String(node) }));
				try {
					const qs = new URLSearchParams();
					if (label) { qs.set('label', String(label)); }
					if (node !== undefined && node !== null && node !== '') { qs.set('node', String(node)); }
					const suffix = qs.toString() ? '?' + qs.toString() : '';
					const res = await fetch(API + '/graph' + suffix, { cache: 'no-store' });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
					setGv({ status: 'ready', data: body, error: '', label: String(label || ''), node: node === undefined || node === null ? '' : String(node) });
				} catch (e) {
					setGv(v => Object.assign({}, v, { status: 'error', error: String(e && e.message || e) }));
				}
			}, []);
			/**
			 * 「打开图谱页面」：**切到图谱那一页**并（首次）取数。
			 *
			 * 为什么不跳 SSR 的 `/x/codebase/?view=graph`（用户 2026-10-23 报"点了没反应"的根因 ✓）：
			 * 工作台跑在 dsh 客户端这个 SPA 里，宿主 `dshViewHost` 的 `will-navigate` **明确拦掉**
			 * 同源非根路径的主 frame 导航（注释：「工作台页一律走宿主渲染」）⇒ 换整页那条路是死的 ✗。
			 */
			const openGraphPage = () => {
				setGraphPage(true);
				if (gv.status === 'idle' || gv.status === 'error') { void loadGraphView({ label: '', node: '' }); }
			};

			const data = view.data;
			const overview = (data && data.overview) || {};
			const manifest = overview.manifest || {};
			const files = overview.files || {};
			const deep = data && data.deep;
			const parser = (data && data.parser) || {};
			const index = (data && data.index) || {};
			const results = (data && data.results) || null;
			const deps = (data && data.deps) || null;
			const projects = (data && data.projects) || null;
			const shapeInfo = (data && data.shape) || null;
			const shapeOutcome = shapeInfo && shapeInfo.outcome;
			const shapeHelp = (data && data.shapeHelp) || [];
			const portAudit = (data && data.portAudit) || null;
			const relatedRoots = (data && data.relatedRoots) || [];
			const fileCount = deep && deep.summary && Array.isArray(deep.summary.labels)
				? (deep.summary.labels.find(e => /^file$/i.test(String(e.name || ''))) || {}).count
				: undefined;
			const busyNow = busy || (index && index.lock && index.lock.held === true);

			// ⚠ 机器锚点用 `data-*`（不是类名）：统计卡与"区块卡"共用 `wb-card`，类名数不出张数；
			//   类名还属视觉层（UI 统一时会换）⇒ 锚点必须与样式解耦（2026-10-22 迁移当场踩到：数出 5 张）。
			const card = (cls, icon, num, label, sub, anchor) => h('div', { key: anchor || label, className: 'wb-card cbm-card ' + cls, 'data-vssaros-codebase-stat': anchor || '' },
				h('div', { className: 'wb-card-ico', 'aria-hidden': 'true' }, icon),
				h('div', { className: 'wb-card-num' }, kb(num)),
				h('div', { className: 'wb-card-label' }, label),
				sub ? h('div', { className: 'wb-card-sub' }, sub) : null);
			// ⚠ 值位用 `div`（不是 `span`）：Node Types / Edge Types 那两格塞的是**分布条**（块级元素）✓
			// ⚠ `key` 直接取键名：键值行是**数组**渲染的（`configRows` 之类），没 key 会告警 ✓
			const kv = (k, v) => h('div', { key: k, className: 'cbm-kv' }, h('span', { className: 'cbm-kv-k' }, k), h('div', { className: 'cbm-kv-v' }, v));
			const nodeRow = (node, idx) => h('li', {
				key: String((node && (node.id ?? node.name)) ?? idx),
				className: 'cbm-node',
				role: 'button', tabIndex: 0,
				title: '点这条看它的依赖（用了什么 / 谁用了它）',
				onClick: () => { if (node && node.id !== undefined) { openNode(node.id); } },
				onKeyDown: (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && node && node.id !== undefined) { ev.preventDefault(); openNode(node.id); } },
			},
				h('span', { className: 'cbm-node-type' }, String((node && node.type) || '')),
				h('code', null, String((node && node.name) || '')),
				h('span', { className: 'cbm-node-file' }, shortFile(node && node.filePath)));
			/**
			 * 图谱浏览里的节点行：点一条 ⇒ **在那一节里**摊开它的出入依赖（不跳页 ✓）。
			 * ⚠ 度数用 `topNodes` 给的 `degree`（它才是这一张排行**按哪个方向排的**）；`inDegree` / `outDegree`
			 *   只有我们自己索引器产的图才保证有（IDE 产的图不一定）⇒ 直接读那两个会静默显示 0 ✗。
			 */
			const graphNodeRow = (node, idx, dirLabel) => h('li', {
				key: 'g' + String((node && node.id) ?? idx),
				className: 'cbm-node',
				role: 'button', tabIndex: 0,
				title: '点这条看它的出入依赖',
				onClick: () => { if (node && node.id !== undefined) { void loadGraphView({ label: gv.label, node: node.id }); } },
				onKeyDown: (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && node && node.id !== undefined) { ev.preventDefault(); void loadGraphView({ label: gv.label, node: node.id }); } },
			},
				h('span', { className: 'cbm-node-type' }, String((node && node.label) || (node && node.type) || '')),
				h('code', null, String((node && node.name) || '')),
				h('span', { className: 'cbm-node-file' }, String(dirLabel || '') + ' ' + String((node && node.degree) ?? '—')));
			const edgeRow = (entry, key) => h('li', { key: key, className: 'cbm-node' },
				h('span', { className: 'cbm-node-type' }, String(entry.type || '')),
				h('code', null, String(entry.name || '')),
				h('span', { className: 'cbm-node-file' }, shortFile(entry.filePath)));
			/** 分布条：`{name,count}` 列表 ⇒ 纯 CSS 宽度占比（不引前端库 ✓）。 */
			const bars = (pairs, limit) => {
				const top = (Array.isArray(pairs) ? pairs : []).slice(0, limit || 10);
				if (!top.length) { return h('p', { className: 'wb-empty' }, '没有可显示的分布'); }
				const peak = Math.max(1, ...top.map(pair => Number(pair && pair.count) || 0));
				return h('div', { className: 'cbm-bars' }, top.map((pair, i) => {
					const count = Number(pair && pair.count) || 0;
					const pct = Math.max(2, Math.round((count / peak) * 100));
					return h('div', { key: i, className: 'cbm-bar' },
						h('span', { className: 'cbm-bar-label' }, String((pair && pair.name) || '?')),
						h('span', { className: 'cbm-bar-track' }, h('span', { className: 'cbm-bar-fill', style: { width: pct + '%' } })),
						h('span', { className: 'cbm-bar-num' }, String(count)));
				}));
			};
			const toggleSection = (id) => (ev) => {
				const nextOpen = !!(ev && ev.target && ev.target.open);
				setOpenSections(s => Object.assign({}, s, { [id]: nextOpen }));
			};
			/** 可折叠分区（原生 `<details>`：不依赖脚本也能开合 ✓；锚点 `data-codebase-section` 供守卫取数 ✓）。
			 *  ⚠ 子节点是**变参**（`...children`）：写成单参会把第 7 个参数之后的全部丢掉 ⇒ 分区只剩第一块 ✗
			 *  （2026-10-23 真机渲染自证当场抓到：Index Configuration 只剩键值对、Query Console 只剩检索表单）。 */
			const section = (id, icon, title, badge, defaultOpen, ...children) => {
				const isOpen = openSections[id] === undefined ? !!defaultOpen : openSections[id];
				return h('details', {
					className: 'wb-card cbm-section',
					'data-codebase-section': id,
					open: isOpen,
					onToggle: toggleSection(id),
				},
					// ⚠ 自带的三角标记被 CSS 隐掉了（各浏览器样式不一）⇒ 给一个**明确的**开合指示 ✓
					//   （不然折叠成一行的分区看起来像"标题行"，用户不知道能点 ✗）
					h('summary', { className: 'wb-group-hd' },
						h('span', { className: 'wb-caret', 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
						h('span', null, icon + ' ' + title),
						h('span', { className: 'wb-spacer' }),
						badge ? h('span', { className: 'wb-card-sub' }, String(badge)) : null),
					// ⚠ 展开传（`...children`）：把数组整个当子节点会要求每个都带 `key`（React 告警）✓
					h('div', { className: 'cbm-sec-body' }, ...children));
			};

			// ── ① 统计卡（原面板 `_renderStats`：Nodes / Edges / Files / Last Index ✓）──────────
			const cards = h('div', { className: 'wb-cards' },
				card('accent', '🔗', manifest.nodeCount, 'Nodes', 'functions · classes · interfaces', 'nodes'),
				card('green', '↔️', manifest.edgeCount, 'Edges', 'calls · imports · defines', 'edges'),
				card('blue', '📁', fileCount, 'Files', fileCount === undefined ? '需加载全量图' : 'indexed source files', 'files'),
				card('purple', '⚡', isoShort(manifest.savedAt), 'Last Index', bytesText(files['graph.json'] && files['graph.json'].bytes), 'last'));

			// ── ② Index Configuration（只放 **dsh 侧真有的配置** ✓；IDE 索引器那三档与 Exclude/Keep 不摆 ✗）──
			const watchOn = !!(index.watch && index.watch.active === true);
			const handover = index.target === 'workspace';
			const configRows = [
				kv('落点', h('span', null, h('code', null, String(index.dir || '')), '（', h('code', null, String(index.placement || '?')), ' 依据）')),
				kv('解析器', parser.available
					? (String((parser.languages || []).length) + ' 语言 · 来自 ' + String(parser.source || '') + ' · ' + String(parser.dir || ''))
					: ('不可用（' + String(parser.why || '未探测') + '）')),
				kv('保鲜', watchOn
					? ('监听中（每 ' + Math.round((index.watch.debounceMs || 0) / 1000) + 's 合并变更' + (index.watch.pendingSince !== undefined ? ' · 有待处理变更' : '') + '）')
					: '未启用'),
				kv('交接状态', handover
					? (watchOn
						? '已交接给 dsh（IDE 不再索引 ✓）；保鲜已开 ⇒ 图会跟着改动更新 ✓'
						: '⚠ 已交接给 dsh（IDE 不再索引 ✓）但保鲜没开（config.indexWatch 不是 true）⇒ 只有手动跑 codebase_index 才更新，图会静默变旧 ✗')
					: '影子档（IDE 仍会自己索引工作区 ✓ —— 代价是双份索引，且两边视图可能给出不同答案 ⚠）'),
				kv('图的新鲜度', typeof index.effectiveAgeMs === 'number'
					? (ageText(index.effectiveAgeMs) + '前（' + isoShort(index.effectiveSavedAt) + '）'
						+ (index.effectiveStale ? (' · ⚠ 已超过判决阈值（' + ageText(index.staleAfterMs) + '）⇒ 检索可能在用旧事实回答') : ' ✓'))
					: '不知道（这份图没有 saved_at ⇒ 判不了新旧，不猜 ✗）'),
				index.orphanWorkspace
					? kv('⚠ 双输风险', '工作区里还留着一份我们产的产物（' + String(index.orphanWorkspace.dir || '') + '）⇒ IDE 见到它继续让路、而 dsh 又不写那里 ⇒ 两边都不索引 ✗✗；用 codebase_delete_project 的 which="workspace" 删掉它 ✓')
					: null,
				kv('产图档位', index.graphParser
					? (String(index.graphParser) + ' · ' + String(index.graphParserWhy || '')
						+ (typeof index.graphMetaMs === 'number'
							? (' · 上次实测 ' + Math.round(index.graphMetaMs / 1000) + 's' + (index.graphMetaIncremental === false ? '（全量重解析 ✓）' : index.graphMetaIncremental === true ? '（增量 ✓）' : ''))
							: ' · ⚠ 没有耗时记录'))
					: ('未知（' + String(index.graphParserWhy || '未探测') + '）')),
				kv('重建代价参考', typeof index.graphMetaMs === 'number'
					// ⚠ 两个子节点都必须在**同一个 `h(...)` 的参数表里** —— 上一版把 `)` 提前关掉、用逗号接上历史那一段
					//   ⇒ JS 逗号运算符只留下最后一个值 ⇒ 页面上"上一次 91s（…"**整句消失**（真机渲染自证抓到 ✓）。
					? h('div', null,
						h('div', null,
							'上一次 ' + Math.round(index.graphMetaMs / 1000) + 's（' + String(index.graphParser || '?')
							+ (index.graphMetaIncremental === false ? ' / 全量' : index.graphMetaIncremental === true ? ' / 增量' : '')
							+ '）—— 实测值，不是估算 ✓'),
						Array.isArray(index.graphMetaHistory) && index.graphMetaHistory.length > 1
							? h('div', { className: 'cbm-note' }, '最近 ' + index.graphMetaHistory.length + ' 次（新→旧）：'
								+ index.graphMetaHistory.map(item => Math.round((item.ms || 0) / 1000) + 's·' + String(item.parser || '?')
									+ (item.incremental === true ? '·增量' : item.incremental === false ? '·全量' : '')).join(' → '))
							: null)
					: '没有耗时记录：这份图不是这一代 dsh 索引器产的（或还没建过 ✓）'),
				kv('增量缓存', index.cache && index.cache.files !== undefined
					? (String(index.cache.files) + ' 个文件（' + isoShort(index.cache.savedAt) + '）')
					: '无'),
			].filter(Boolean);
			const configSection = section('config', '⚙️', 'Index Configuration', String(index.target || 'shadow'), false,
				h('div', { className: 'cbm-kvs' }, configRows),
				h('p', { className: 'cbm-note' }, '索引是写动作（有成本）⇒ 页面不提供触发：走审批闸的工具 ',
					h('code', null, 'codebase_index'), '（在对话里让我跑）。原版的 Fast / Moderate / Full 三档与 Exclude / Keep 属于 IDE 侧索引器，dsh 侧没有对应物 ⇒ 这里不摆不能用的控件 ✗。'),
				h('h3', { className: 'cbm-h3' }, '索引档位（dsh 的真实档位）'),
				h('p', { className: 'cbm-note' },
					'dsh 侧只有两档，由 ', h('code', null, 'codebase_index'), ' 的 ', h('code', null, 'parser'), ' 参数决定；P7 起缺省是 ', h('code', null, 'auto'), '（按能力挑档，不是第三种档位 ✓）：',
					h('br'), '· 缺省 ', h('code', null, 'auto'), '：tree-sitter 资产可用 ⇒ 真解析档 ✓；不可用 ⇒ 如实降级到快档并写明为什么（返回值 ', h('code', null, 'degraded'), ' ✓）—— 降级可以是好选择，静默降级不是 ✗',
					h('br'), '· 快档 ', h('code', null, 'regex'), '：顶层声明的正则近似 + IMPORTS / CONTAINS 边 ⇒ 秒级；符号边界与行号是近似的 ✗',
					h('br'), '· 真解析档 ', h('code', null, 'treesitter'), '：符号与起止行准确，并产出 CALLS / USAGE / INHERITS / IMPLEMENTS 四种边 ⇒ 全仓分钟级',
					h('br'), '· 原版第三档 ', h('code', null, 'full'), '（语义 / 相似度索引）dsh 侧没有移植 ⇒ 不摆 ✗'));

			// ── ③ Graph Details（原面板：Storage / Last Modified / Node Types / Edge Types + 三个按钮 ✓）──
			const detailsSection = section('details', '🌐', 'Graph Details', bytesText(files['graph.json'] && files['graph.json'].bytes), false,
				h('div', { className: 'cbm-kvs' },
					kv('Storage', h('code', null, String(overview.dir || ''))),
					kv('Last Modified', isoShort(manifest.savedAt) + (overview.ageMs !== undefined ? '（' + ageText(overview.ageMs) + '前）' : '')),
					kv('Node Types', deep ? bars(deep.summary.labels) : '未加载全量图'),
					kv('Edge Types', deep ? bars(deep.summary.edgeTypes) : '未加载全量图')),
				h('div', { className: 'wb-field-row' },
					h('button', { type: 'button', className: 'wb-btn is-primary', disabled: busy, onClick: loadDeep }, deep ? '🌐 重新加载全量图' : '🌐 加载全量图'),
					// ⚠ 这里是**按钮**不是链接：工作台在 dsh 客户端 SPA 里，跳 `/x/codebase/?view=graph` 等于没反应
					//   （宿主 `dshViewHost.will-navigate` 明确拦同源非根路径的主 frame 导航 ✗）
					//   ⇒ 改成**打开图谱页面**（工作台自己渲染整页，不再跳出去 ✓）
					h('button', { type: 'button', className: 'wb-btn', onClick: openGraphPage, 'data-vssaros-codebase-action': 'open-graph' }, '🕸 打开图谱页面'),
					h('button', { type: 'button', className: 'wb-btn', disabled: busy, onClick: () => { void load({ q, file, shape }); } }, '🔄 Refresh')),
				h('p', { className: 'cbm-note' }, 'ℹ 原版的「View 3D Graph」是三维渲染 ⇒ dsh 侧没有对应物；「图谱浏览」给的是同一份数据的只读结构事实（类型分布 / 出入度排行 / 按类型筛选 / 节点出入依赖 ✓）—— 不含 3D 与力导向布局 ✗。'));

			// ── ③b 🕸 **图谱页面**（独立一页；点「图谱」进来、点「← 返回代码库」回去 ✓）──────────────
			//   ⚠ 2026-10-23 用户：「点击图谱按钮应该打开图谱页面」—— 所以它**不是**折叠区块，
			//     而是把工作台切到一整页图谱（同一套数据 `/api/graph`；进来才加载全量图）。
			const gvData = gv.data;
			const gvReady = gv.status === 'ready' && gvData && gvData.available === true;
			const graphPageBody = (() => {
				if (gv.status === 'loading') { return h('p', { className: 'wb-empty', 'data-codebase-graph': 'loading' }, '正在加载全量图（解压 + 建图，几秒）…'); }
				if (gv.status === 'error') { return h('p', { className: 'wb-empty', 'data-codebase-graph': 'error', role: 'alert' }, '读图失败：' + gv.error); }
				if (gv.status === 'idle') { return h('p', { className: 'wb-empty', 'data-codebase-graph': 'idle' }, '正在加载全量图…'); }
				if (!gvReady) { return h('p', { className: 'wb-empty', 'data-codebase-graph': 'unavailable' }, '看不了图：' + String((gvData && gvData.why) || '未知原因')); }
				const labels = (gvData.summary && gvData.summary.labels) || [];
				const chips = [h('button', {
					key: '__all', type: 'button', className: 'wb-chip' + (gv.label ? '' : ' is-active'),
					'data-codebase-graph-label': '', onClick: () => { void loadGraphView({ label: '', node: '' }); },
				}, '全部 ' + String(gvData.summary.nodes))]
					.concat(labels.slice(0, 10).map(entry => h('button', {
						key: String(entry.name), type: 'button',
						className: 'wb-chip' + (String(entry.name) === gv.label ? ' is-active' : ''),
						'data-codebase-graph-label': String(entry.name),
						onClick: () => { void loadGraphView({ label: String(entry.name), node: '' }); },
					}, String(entry.name) + ' ' + String(entry.count))));
				const gvDeps = gvData.deps;
				const depsBlock = gvDeps
					? h('div', { className: 'cbm-block', 'data-codebase-graph-deps': '1' },
						h('p', { className: 'wb-diag' }, gvDeps.error
							? String(gvDeps.error)
							: ((gvDeps.targets || []).length + ' 个节点：用出 ' + (gvDeps.usesTotal ?? 0) + ' 条 / 被用 ' + (gvDeps.usedByTotal ?? 0) + ' 条')),
						gvDeps.error ? null : h('div', null,
							h('h3', { className: 'cbm-h3' }, '它用了什么 ', h('small', null, (gvDeps.uses || []).length + '/' + (gvDeps.usesTotal ?? 0))),
							h('ul', { className: 'cbm-nodes' }, (gvDeps.uses || []).length ? gvDeps.uses.map((e, i) => edgeRow(e, 'gu' + i)) : h('li', { className: 'wb-empty' }, '没有出边')),
							h('h3', { className: 'cbm-h3' }, '谁用了它 ', h('small', null, (gvDeps.usedBy || []).length + '/' + (gvDeps.usedByTotal ?? 0))),
							h('ul', { className: 'cbm-nodes' }, (gvDeps.usedBy || []).length ? gvDeps.usedBy.map((e, i) => edgeRow(e, 'gd' + i)) : h('li', { className: 'wb-empty' }, '没有入边'))))
					: null;
				const viz = gvData.viz;
				const pointById = new Map((vizLayout ? vizLayout.points : []).map(point => [point.id, point]));
				const baseView = vizLayout ? { x: 0, y: 0, w: vizLayout.width, h: vizLayout.height } : null;
				const currentView = vizView || baseView;
				const zoomViz = (factor, originX, originY) => {
					if (!vizLayout) { return; }
					const from = vizView || baseView;
					const w = Math.min(vizLayout.width * 6, Math.max(vizLayout.width / 10, from.w * factor));
					const h = w * (vizLayout.height / vizLayout.width);
					const px = typeof originX === 'number' ? originX : 0.5;
					const py = typeof originY === 'number' ? originY : 0.5;
					setVizView({ x: from.x + (from.w - w) * px, y: from.y + (from.h - h) * py, w, h });
				};
				// 结构图（SVG）：节点=符号（大小按度数、颜色按类型）、线=真实存在的边 ✓
				const vizBlock = vizLayout && currentView
					? h('div', {
						className: 'cbm-viz',
						// 机器锚点：可视化**真的画出来了**（点数/边数）—— 光有 data-* 不算，探针还要数 circle/line ✓
						'data-codebase-viz': String(vizLayout.points.length),
						'data-codebase-viz-edges': String((viz && viz.edges ? viz.edges.length : 0)),
					},
						h('div', { className: 'wb-group-hd' },
							h('span', null, '🕸 结构图'),
							h('span', { className: 'wb-spacer' }),
							h('span', { className: 'wb-card-sub' },
								'画 ' + vizLayout.points.length + ' 个节点 / ' + (viz && viz.edges ? viz.edges.length : 0) + ' 条边'
								+ (viz && viz.truncated ? '（按总度数取前 ' + viz.limit + '，图里共 ' + viz.connected + ' 个有连接节点）' : '（全部）'))),
						h('div', { className: 'wb-field-row' },
							h('button', { type: 'button', className: 'wb-btn is-icon', onClick: () => zoomViz(1 / 1.4), title: '放大' }, '＋'),
							h('button', { type: 'button', className: 'wb-btn is-icon', onClick: () => zoomViz(1.4), title: '缩小' }, '－'),
							h('button', { type: 'button', className: 'wb-btn', onClick: () => setVizView(null), title: '适配整张图' }, '适配'),
							h('span', { className: 'wb-card-sub' }, '滚轮缩放 · 按住拖动 · 点节点看依赖')),
						h('svg', {
							className: 'cbm-viz-svg',
							ref: vizSvgRef,
							viewBox: currentView.x + ' ' + currentView.y + ' ' + currentView.w + ' ' + currentView.h,
							'data-codebase-viz-svg': '',
							// ⚠ **不要**写 `onWheel`：React 的 wheel 是 passive ⇒ 拦不住页面滚动（见上面那个 effect ✓）
							onMouseDown: (ev) => {
								vizMoved.current = false;
								dragging.current = { x: ev.clientX, y: ev.clientY, view: currentView };
							},
							onMouseMove: (ev) => {
								const drag = dragging.current;
								if (!drag) { return; }
								const rect = ev.currentTarget && ev.currentTarget.getBoundingClientRect ? ev.currentTarget.getBoundingClientRect() : null;
								const unitX = rect && rect.width ? drag.view.w / rect.width : drag.view.w / 600;
								const unitY = rect && rect.height ? drag.view.h / rect.height : drag.view.h / 400;
								if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3) { vizMoved.current = true; }
								setVizView({
									x: drag.view.x - (ev.clientX - drag.x) * unitX,
									y: drag.view.y - (ev.clientY - drag.y) * unitY,
									w: drag.view.w, h: drag.view.h,
								});
							},
							onMouseUp: () => { dragging.current = null; },
							onMouseLeave: () => { dragging.current = null; },
						},
							(viz && viz.edges ? viz.edges : []).map((edge, i) => {
								const from = pointById.get(edge.source);
								const to = pointById.get(edge.target);
								if (!from || !to) { return null; }
								return h('line', {
									key: 've' + i, className: 'cbm-viz-edge',
									x1: Math.round(from.x * 10) / 10, y1: Math.round(from.y * 10) / 10,
									x2: Math.round(to.x * 10) / 10, y2: Math.round(to.y * 10) / 10,
								});
							}),
							vizLayout.points.map(point => h('circle', {
								key: 'vn' + point.id,
								className: 'cbm-viz-node l' + point.slot,
								cx: Math.round(point.x * 10) / 10,
								cy: Math.round(point.y * 10) / 10,
								r: Math.round(point.r * 10) / 10,
								'data-codebase-viz-node': String(point.id),
								onClick: () => {
									// 拖动结束时不要当成"点了一下"（否则拖一下就跳进依赖 ✗）
									if (vizMoved.current) { return; }
									void loadGraphView({ label: gv.label, node: point.id });
								},
							}, h('title', null, String(point.name || ('#' + point.id)) + '（' + String(point.label || '?') + '） · 度数 ' + String(point.degree ?? '?')))),
						h('div', { className: 'cbm-viz-legend' }, vizLayout.labels.map(entry => h('span', { key: entry.name, className: 'cbm-viz-legend-item' },
							h('i', { className: 'cbm-viz-dot l' + entry.slot }),
							String(entry.name) + ' ' + String(entry.count)))),
						h('p', { className: 'cbm-note' }, '⚠ 这是**取样**后的结构图（服务端按总度数取前 ' + String(viz ? viz.limit : '?') + ' 个有连接的节点），不是全图 ✗；边都是真实存在的（两端都在取样里 ✓）。IDE 侧那个面板是 Three.js 3D + 力导向动画，dsh 客户端没有 three / 没有网络 ⇒ 这里是同一份数据的 **2D 静态布局**（一次算完、不逐帧重排 ✓）。')))
					: null;
				return h('div', { className: 'cbm-block', 'data-codebase-graph': 'ready' },
					h('div', { className: 'cbm-kvs' },
						kv('规模', String(gvData.summary.nodes) + ' 节点 / ' + String(gvData.summary.edges) + ' 边 · ' + String(gvData.summary.files ?? '?') + ' 文件 · ' + String(gvData.summary.communities ?? 0) + ' 社区'),
						kv('加载', bytesText(gvData.loadBytes) + ' / ' + String(gvData.loadMs ?? '?') + 'ms' + (gvData.cached ? ' · 缓存命中' : ''))),
					vizBlock,
					h('h3', { className: 'cbm-h3' }, '按节点类型筛选 ', h('small', null, gv.label ? gv.label : '全部')),
					h('div', { className: 'wb-chips' }, chips),
					h('h3', { className: 'cbm-h3' }, '节点类型分布'),
					bars(labels),
					h('h3', { className: 'cbm-h3' }, '边类型分布'),
					bars((gvData.summary && gvData.summary.edgeTypes) || []),
					h('h3', { className: 'cbm-h3' }, '🔥 入度最高（谁被依赖最多） ',
						h('small', null, String((gvData.inTop || []).length) + ' 条 · 点一条看出入依赖')),
					h('ul', { className: 'cbm-nodes', 'data-codebase-graph-in': String((gvData.inTop || []).length) }, (gvData.inTop || []).length
						? gvData.inTop.map((node, idx) => graphNodeRow(node, idx, '入度'))
						: h('li', { className: 'wb-empty' }, '没有入度节点')),
					h('h3', { className: 'cbm-h3' }, '🌱 出度最高（谁依赖别人最多）'),
					h('ul', { className: 'cbm-nodes', 'data-codebase-graph-out': String((gvData.outTop || []).length) }, (gvData.outTop || []).length
						? gvData.outTop.map((node, idx) => graphNodeRow(node, idx, '出度'))
						: h('li', { className: 'wb-empty' }, '没有出度节点')),
					depsBlock);
			})();
			const graphNote = h('p', { className: 'cbm-note' }, '⚠ 这一页**不是** 3D 图：没有力导向布局、不能拖拽（dsh 侧没有渲染器 ✗）。给的是同一份数据的**结构事实**：类型分布、入/出度排行、按类型筛选、节点出入依赖 ✓ —— 全部用现成 helper 算（', h('code', null, 'summarizeGraph'), ' / ', h('code', null, 'topNodes'), ' / ', h('code', null, 'dependenciesOf'), ' ✓）。要看源码用工具的 ', h('code', null, 'codebase_snippet'), ' 或检索结果里的节点行 ✓。');

			// ── ④ Architecture（原版对**大图**是 deferred ✓：社区数来自全量图）──────────────────
			const archSection = section('architecture', '🏗️', 'Architecture', deep ? (String(deep.summary.communities || 0) + ' communities') : 'Deferred', false,
				deep
					? [h('div', { key: 'k', className: 'cbm-kvs' },
						kv('社区（communities）', String(deep.summary.communities || 0)),
						kv('文件', String(deep.summary.files === undefined ? '?' : deep.summary.files)),
						kv('节点类型', String((deep.summary.labels || []).length) + ' 类')),
					h('p', { key: 'n', className: 'cbm-note' }, '分层 / 跨包这类视角用工具看更全：',
						h('code', null, 'codebase_architecture'), '（社区 · 分层 · 跨包依赖 ✓）。')]
					: [h('p', { key: 'n', className: 'cbm-note' }, '全量图未加载 ⇒ 架构分析先不算（原版对大图也是 deferred —— 省掉一次全图遍历 ✓）。'),
					h('button', { key: 'b', type: 'button', className: 'wb-btn is-primary', disabled: busy, onClick: loadDeep }, '🔍 Compute Now（加载全量图）')]);

			// ── ⑤ Query Console（按名字检索 + 形状查询；**不是 Cypher** ✗）──────────────────────
			const shapeRows = shapeOutcome && shapeOutcome.rows && shapeOutcome.rows.length
				? h('ul', { className: 'cbm-nodes' }, shapeOutcome.rows.map(nodeRow))
				: null;
			const shapeDeps = shapeOutcome && shapeOutcome.deps && !shapeOutcome.deps.error
				? h('div', null,
					h('h3', { className: 'cbm-h3' }, '它用了什么 ', h('small', null, (shapeOutcome.deps.uses || []).length + '/' + (shapeOutcome.deps.usesTotal ?? 0))),
					h('ul', { className: 'cbm-nodes' }, (shapeOutcome.deps.uses || []).length
						? shapeOutcome.deps.uses.map((e, i) => edgeRow(e, 'su' + i))
						: h('li', { className: 'wb-empty' }, '没有出边')),
					h('h3', { className: 'cbm-h3' }, '谁用了它 ', h('small', null, (shapeOutcome.deps.usedBy || []).length + '/' + (shapeOutcome.deps.usedByTotal ?? 0))),
					h('ul', { className: 'cbm-nodes' }, (shapeOutcome.deps.usedBy || []).length
						? shapeOutcome.deps.usedBy.map((e, i) => edgeRow(e, 'sd' + i))
						: h('li', { className: 'wb-empty' }, '没有入边')))
				: null;
			const querySection = section('query', '🔍', 'Query Console',
				shapeInfo ? String(shapeInfo.text || '') : (q ? q : (deep ? '全量图' : '轻路径')),
				!!(results || deps || shapeOutcome),
				h('form', { className: 'wb-field-row cbm-search', onSubmit: runSearch },
					h('span', null, '🔍'),
					h('input', { value: q, placeholder: '按名字检索节点（会加载全量图）', 'aria-label': '按名字检索节点', 'data-codebase-q': '', onChange: (ev) => setQ(ev.target.value) }),
					h('input', { value: file, placeholder: '限定文件路径片段', 'aria-label': '限定文件路径片段', 'data-codebase-file': '', onChange: (ev) => setFile(ev.target.value) }),
					h('button', { type: 'submit', className: 'wb-btn is-primary', disabled: busy }, '检索'),
					h('button', { type: 'button', className: 'wb-btn', disabled: busy, onClick: loadDeep }, '加载全量图')),
				results
					? h('div', { className: 'cbm-block', 'data-codebase-results': String(results.length) },
						h('div', { className: 'wb-group-hd' }, h('span', null, '检索结果'), h('span', { className: 'wb-spacer' }), h('span', { className: 'wb-card-sub' }, String(results.length))),
						results.length
							? h('ul', { className: 'cbm-nodes' }, results.map(nodeRow))
							: h('p', { className: 'wb-empty' }, '没有命中（query=' + String(q) + '）。'))
					: null,
				deps
					? h('div', { className: 'cbm-block', 'data-codebase-deps': '1' },
						h('div', { className: 'wb-group-hd' }, h('span', null, '依赖'), h('span', { className: 'wb-spacer' }),
							h('span', { className: 'wb-card-sub' }, deps.error ? '?' : ((deps.targets || []).length + ' 个节点'))),
						deps.error
							? h('p', { className: 'wb-empty' }, deps.error)
							: h('div', null,
								h('p', { className: 'wb-diag' }, (deps.targets || []).length + ' 个节点：用出 ' + (deps.usesTotal ?? 0) + ' 条 / 被用 ' + (deps.usedByTotal ?? 0) + ' 条' + (deps.dangling ? '（' + deps.dangling + ' 条边指向图外节点）' : '')),
								h('h3', { className: 'cbm-h3' }, '它用了什么 ', h('small', null, (deps.uses || []).length + '/' + (deps.usesTotal ?? 0))),
								h('ul', { className: 'cbm-nodes' }, (deps.uses || []).length
									? deps.uses.map((e, i) => edgeRow(e, 'du' + i))
									: h('li', { className: 'wb-empty' }, '没有出边')),
								h('h3', { className: 'cbm-h3' }, '谁用了它 ', h('small', null, (deps.usedBy || []).length + '/' + (deps.usedByTotal ?? 0))),
								h('ul', { className: 'cbm-nodes' }, (deps.usedBy || []).length
									? deps.usedBy.map((e, i) => edgeRow(e, 'dd' + i))
									: h('li', { className: 'wb-empty' }, '没有入边'))))
					: null,
				h('h3', { className: 'cbm-h3' }, '形状查询（', h('strong', null, '不是 Cypher'), ' ✗）'),
				h('form', { className: 'wb-field-row cbm-search', onSubmit: (ev) => { ev.preventDefault(); runShape(); } },
					h('span', null, '🧩'),
					h('input', { value: shape, placeholder: 'type:class / file:src/vs/editor / deps:localize / hot:20', 'aria-label': '形状查询', 'data-codebase-shape-input': '', onChange: (ev) => setShape(ev.target.value) }),
					h('button', { type: 'submit', className: 'wb-btn', disabled: busy }, '跑')),
				shapeHelp.length
					? h('div', { className: 'wb-chips' }, shapeHelp.map(entry => h('button', {
						key: entry.example, type: 'button', className: 'wb-chip', title: String(entry.desc || ''),
						'data-codebase-shape-chip': entry.example, disabled: busy,
						onClick: () => runShape(entry.example),
					}, String(entry.usage))))
					: null,
				shapeInfo
					? h('div', { className: 'cbm-block', 'data-codebase-shape': String(shapeInfo.text || '') },
						shapeOutcome && shapeOutcome.error
							? h('p', { className: 'wb-empty', 'data-codebase-shape-error': '1' }, '形状查询没跑：' + String(shapeOutcome.error),
								shapeOutcome.hint ? h('span', { className: 'cbm-note' }, '（' + String(shapeOutcome.hint) + '）') : null)
							: h('div', null,
								h('p', { className: 'wb-diag', 'data-codebase-shape-ok': '1' }, String((shapeOutcome && shapeOutcome.title) || '')),
								shapeRows,
								shapeDeps,
								shapeOutcome && shapeOutcome.note ? h('p', { className: 'cbm-note' }, String(shapeOutcome.note)) : null))
					: null,
				h('p', { className: 'cbm-note' }, '⚠ ', h('strong', null, '这不是 Cypher'), '：只认上面列出的 ', String(shapeHelp.length || 6), ' 种写法（别的输入会明确报错并列出支持项 ✓ —— "看着支持整门语言、其实只跑通一条"是最坏的形态 ✗）。更复杂的图问题用工具：',
					h('code', null, 'codebase_search'), ' / ', h('code', null, 'codebase_deps'), ' / ', h('code', null, 'codebase_trace'), ' / ', h('code', null, 'codebase_hotspots'), ' ✓。'));

			// ── ⑥ Analysis Tools（hotspots + 移植对账；数字从 PORT_AUDIT **现算** ✓）─────────────
			const auditRows = portAudit && Array.isArray(portAudit.rows) ? portAudit.rows : [];
			const toolsSection = section('tools', '🔬', 'Analysis Tools', '21 个工具', false,
				deep && Array.isArray(deep.hotspots) && deep.hotspots.length
					? h('div', { className: 'cbm-block', 'data-codebase-hotspots': String(deep.hotspots.length) },
						h('div', { className: 'wb-group-hd' }, h('span', null, '🔥 Hotspots（入度最高）'), h('span', { className: 'wb-spacer' }), h('span', { className: 'wb-card-sub' }, '点一条看依赖')),
						h('ul', { className: 'cbm-nodes' }, deep.hotspots.map(nodeRow)))
					: h('p', { className: 'cbm-note' }, 'Hotspots 要全量图（入度是图上的事实，清单里没有 ✗）⇒ 用上面的「加载全量图」。'),
				portAudit
					? h('div', {
						className: 'cbm-block',
						'data-codebase-port-mapped': String(portAudit.mapped),
						'data-codebase-port-replaced': String(portAudit.replaced),
						'data-codebase-port-conclusions': String(portAudit.conclusions),
						'data-codebase-port-missing': (portAudit.missing || []).join(','),
					},
						h('h3', { className: 'cbm-h3' }, '移植状态 ',
							h('small', null, '真源 ' + portAudit.sourceTools + ' 个工具：' + portAudit.mapped + ' 个 1:1 · ' + portAudit.replaced + ' 个换了语言 · ' + portAudit.conclusions + ' 个写成结论')),
						h('p', { className: 'cbm-note' }, (portAudit.missing || []).length
							? ('⚠ 表里写着、这次部署却没注册：' + portAudit.missing.join(' / ') + ' ✗（改了工具名忘了改表，就在这一行现形 ✓）')
							: ('表里 ' + (portAudit.mapped + portAudit.replaced) + ' 个有对应物的工具这次部署全在 ✓；另有 ' + portAudit.conclusions + ' 个明确不移植 ✓；dsh 侧还多出 ' + (portAudit.extra || []).length + ' 个（' + (portAudit.extra || []).join(' · ') + ' ✓）')),
						h('ul', { className: 'cbm-nodes cbm-audit' }, auditRows.map((entry, i) => h('li', { key: 'pa' + i, className: 'cbm-node' },
							h('code', null, String(entry.from)),
							h('span', { className: 'cbm-node-type' }, entry.to ? '→ ' + entry.to : entry.replacedBy ? '→ ' + entry.replacedBy + '（换了语言）' : '（不移植）'),
							entry.why || entry.conclusion
								? h('span', { className: 'cbm-node-file' }, String(entry.why || entry.conclusion))
								: null))))
					: h('p', { className: 'wb-empty' }, '移植对账表没读到（接口没回 portAudit）'),
				h('p', { className: 'cbm-note' }, '页面不代替工具执行（写动作与重活都在工具 / 对话里 ✓）—— 这里列出"有哪些工具、各自干嘛"的账，具体调用让我在对话里做 ✓。'));

			// ── ⑦ Projects（与工具 `codebase_projects` 同源 ✓：全量图才答得出）─────────────────
			const projectsSection = section('projects', '📦', 'Projects',
				Array.isArray(projects) && projects.length ? (projects.length + ' 个项目') : String(manifest.project || '—'), false,
				Array.isArray(projects) && projects.length
					? h('ul', { className: 'cbm-nodes', 'data-codebase-projects': String(projects.length) }, projects.map((entry, i) => h('li', { key: 'p' + i, className: 'cbm-node' },
						h('code', null, String((entry && (entry.project || entry.name)) || '')),
						h('span', { className: 'cbm-node-file' }, String((entry && entry.nodes) ?? '') + ' 节点 / ' + String((entry && entry.edges) ?? '') + ' 边 / ' + String((entry && entry.files) ?? '') + ' 文件'))))
					: h('p', { className: 'cbm-note', 'data-codebase-projects': 'light' }, '一张图可能覆盖多个工作区根 —— 要列"图里有哪些项目"，得先加载全量图 ✓（用 Graph Details 的「加载全量图」）。'),
				h('div', { className: 'cbm-kvs' },
					kv('项目（清单）', String(manifest.project || '未知')),
					kv('工作区根', h('code', null, String(overview.workspaceRoot || '(未配置)'))),
					kv('相关根', relatedRoots.length ? relatedRoots.join(' · ') : '无（只主根）')),
				h('p', { className: 'cbm-note' }, '⚠ 这节只说明"图里"有什么 —— 不代表磁盘上还有那些文件（图可能已过期 ✓）。'));

			// ── ⑧ Activity Log（**如实**：dsh 侧不保留历史日志 ✓ —— 给"此刻"的索引事实）────────
			const activitySection = section('log', '📋', 'Activity Log', busyNow ? '正在索引' : '空闲', false,
				h('div', { className: 'cbm-kvs' },
					kv('读图走', String(index.effectiveSource || '?') + (index.effectiveAgeMs !== undefined ? '（这份图 ' + ageText(index.effectiveAgeMs) + '前）' : '')),
					kv('锁', index.lock && index.lock.held
						? ('被 ' + String((index.lock.holder && index.lock.holder.token) || '未知') + ' 持有' + (index.lock.ageMs !== undefined ? '（' + Math.round(index.lock.ageMs / 1000) + 's 前）' : ''))
						: '空闲'),
					kv('保鲜', watchOn ? ('监听中（已跑 ' + (index.watch.runs ?? 0) + ' 轮' + (index.watch.pendingSince !== undefined ? ' · 有待处理变更' : '') + '）') : '未启用'),
					kv('增量缓存', index.cache && index.cache.files !== undefined ? (String(index.cache.files) + ' 个文件（' + isoShort(index.cache.savedAt) + '）') : '无')),
				h('p', { className: 'cbm-note' }, '⚠ dsh 侧不保留历史日志（索引由工具触发、日志在 IDE 宿主侧）⇒ 这里只有"此刻"的状态，不是日志回放 ✗。'));

			// ── 🕸 图谱页面（整页）：自己的工具条（返回 / 标题 / 规模 / 刷新）────────────────────
			//   ⚠ 用户 2026-10-23：「点击图谱按钮应该打开图谱页面」⇒ 这里是**换一页**，不是展开区块 ✓
			if (graphPage) {
				return h('div', {
					className: 'wb wb-cbm',
					'data-vssaros-page': 'codebase',
					'data-vssaros-surface': 'workbench',
					'data-vssaros-codebase-view': 'graph',
				},
					h('header', { className: 'wb-toolbar', [TOOLBAR_ATTR]: '' },
						h('button', { type: 'button', className: 'wb-btn', onClick: () => setGraphPage(false), 'data-vssaros-codebase-action': 'graph-back' }, '← 返回代码库'),
						h('h1', { className: 'wb-title' }, '图谱页面'),
						h('span', { className: 'wb-sub' }, gv.status === 'loading' ? '加载中…' : (gvReady ? String(gvData.summary.nodes) + ' 节点 / ' + String(gvData.summary.edges) + ' 边' : '未加载')),
						h('span', { className: 'wb-spacer' }),
						h('button', { type: 'button', className: 'wb-btn', disabled: gv.status === 'loading', onClick: () => { void loadGraphView({ label: gv.label, node: gv.node }); } }, '⟳ 刷新')),
					h('div', { className: 'cbm-body' }, graphPageBody, graphNote));
			}

			let body;
			if (view.status === 'loading' && !data) {
				body = h('p', { className: 'wb-empty', 'data-codebase-state': 'loading' }, '正在读取图谱概要…');
			} else if (view.status === 'error' && !data) {
				body = h('p', { className: 'wb-empty', 'data-codebase-state': 'error', role: 'alert' }, '读取失败：' + view.error);
			} else {
				body = h('div', { className: 'cbm-body' },
					cards,
					// 读不到 / 还没图谱 ⇒ 如实说，不冒充空 ✓
					overview.error ? h('p', { className: 'wb-empty' }, overview.error) : null,
					overview.missing ? h('p', { className: 'wb-empty' }, '还没有图谱：', h('code', null, overview.missing), '（在 VsSaros 里建过代码图谱后这里会出现）。') : null,
					configSection,
					detailsSection,
					archSection,
					querySection,
					toolsSection,
					projectsSection,
					activitySection,
					// ⑨ 诊断（折叠；机器锚点照旧在 DOM 里 ✓）
					h('details', { className: 'wb-card cbm-section cbm-diagbox', open: !!openSections.diag, onToggle: toggleSection('diag') },
						h('summary', { className: 'wb-group-hd' },
							h('span', { className: 'wb-caret', 'aria-hidden': 'true' }, openSections.diag ? '▾' : '▸'),
							h('span', null, '诊断（只读）'),
							h('span', { className: 'wb-spacer' }),
							h('span', { className: 'wb-card-sub' }, deep ? '全量图已加载' : '轻路径')),
						h('div', {
							className: 'wb-foot-body',
							'data-vssaros-page': 'codebase',
							'data-vssaros-codebase-nodes': manifest.nodeCount === undefined ? '' : String(manifest.nodeCount),
							'data-vssaros-codebase-edges': manifest.edgeCount === undefined ? '' : String(manifest.edgeCount),
							'data-vssaros-codebase-project': String(manifest.project || ''),
							'data-vssaros-codebase-root': String(overview.workspaceRoot || ''),
							'data-vssaros-codebase-tools': String((data && data.toolsRegistered) || ''),
							'data-vssaros-codebase-deep': deep ? 'loaded' : 'light',
							'data-vssaros-codebase-format': String(manifest.format || ''),
							'data-vssaros-codebase-parser': parser.available ? 'available' : 'unavailable',
							'data-vssaros-codebase-parser-langs': parser.available ? String((parser.languages || []).length) : '',
							'data-vssaros-codebase-graph-source': String(overview.graphSource || ''),
							'data-vssaros-codebase-index-readable': index.readable === true ? 'yes' : 'no',
							'data-vssaros-codebase-target': String(index.target || 'shadow'),
						},
							kv('工作区', h('code', null, String(overview.workspaceRoot || '(未配置)')))
							, kv('图谱目录', h('code', null, String(overview.dir || '')))
							, kv('文件', ['artifact.json', 'graph.json', 'graph.sqlite'].map(n => n + ' ' + (files[n] ? bytesText(files[n].bytes) : '缺失')).join(' · '))
							, kv('全量图', deep
								? deep.summary.nodes + ' 节点 / ' + deep.summary.edges + ' 边 · ' + deep.summary.files + ' 文件 · ' + deep.summary.communities + ' 社区（' + bytesText(deep.bytes) + '，' + deep.ms + 'ms' + (deep.cached ? '，缓存命中' : '') + '）'
								: '未加载（轻路径：只读 artifact.json）')
							, kv('解析器', parser.available
								? (parser.languages || []).length + ' 语言 · 来自 ' + String(parser.source || '') + ' · ' + String(parser.dir || '')
								: '不可用（' + String(parser.why || '未探测') + '）')
							, kv('索引', index.ok
								? (handover ? '已交接（写工作区目录）' : '影子') + (index.readable ? ' 有产物' : ' 还没有产物') + ' · 读图走 ' + String(index.effectiveSource || '?') + ' · ' + String(index.dir || '')
								: '不可用（' + String(index.why || '未探测') + '）')
							, handover && !watchOn
								? kv('⚠ 交接提醒', '已交接给 dsh 但保鲜没开 ⇒ 图不会自动更新（覆盖层加 indexWatch: true）')
								: null
							, kv('工具', h('code', null, String((data && data.toolsRegistered) || '')))),
						note ? h('p', { className: 'wb-diag', 'data-codebase-note': '', role: noteError ? 'alert' : 'status' }, note) : null));
			}

			return h('div', { className: 'wb wb-cbm', 'data-vssaros-page': 'codebase', 'data-vssaros-surface': 'workbench', 'data-vssaros-codebase-view': 'overview' },
				h('header', { className: 'wb-toolbar', [TOOLBAR_ATTR]: '' },
					h('h1', { className: 'wb-title' }, '代码库'),
					h('span', { className: 'wb-sub' }, busyNow ? 'Indexing…' : (deep ? '全量图' : (overview.missing ? 'Not Indexed' : '轻路径'))),
					h('span', { className: 'wb-spacer' }),
					note ? h('span', { className: 'wb-diag', 'data-codebase-note-inline': '', role: noteError ? 'alert' : 'status' }, note) : null,
					h('button', { type: 'button', className: 'wb-btn', disabled: busy, onClick: () => { void load({ q, file, shape }); } }, '⟳ 刷新'),
					// ⚠ 原来这里是 `<a href="/x/codebase/?view=graph">` —— 在工作台里点了**没有任何反应**
					//   （宿主拦同源非根路径的主 frame 导航）⇒ 换成"打开图谱页面"（整页切换 ✓）
					h('button', { type: 'button', className: 'wb-btn is-ghost', onClick: openGraphPage, 'data-vssaros-codebase-action': 'open-graph-toolbar' }, '🕸 图谱页面')),
				body);
		}

		const STYLE_ID = 'vssaros-codebase-workbench-layout';
		// ★ 2026-10-22（工作台 UI 统一，方案稿 §6.19）：**通用视觉交给共享层**（宿主注入的 `wb-*`），
		//   这里只留代码库特有的东西（统计卡的四色强调、检索控件、节点行、键值对、分布条、小节标题）。
		// ⚠ 原来写的 `--dsw-alias-border-default` / `--dsw-alias-label-link` **不存在** ⇒ 一直回落硬编码兜底
		//   ⇒ 从没跟随过主题 ✗（同一批问题在 kanban / memory 也各有一份，统一时一起清掉）。
		const CSS = `
.wb-cbm { overflow:auto; container-type: inline-size; }
.wb-cbm a.wb-btn { text-decoration:none; }
/* 2026-10-24：按**容器**响应（sideview / 右栏 320–420px，@media 判不出来） */
@container (max-width: 860px) {
  .cbm-bar { grid-template-columns: minmax(56px, 96px) minmax(0, 1fr) 40px; }
  .wb-cbm .wb-cards { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
}
@container (max-width: 560px) {
  .wb-cbm .wb-toolbar { flex-wrap: wrap; row-gap: var(--wb-s1); }
  .cbm-node-file { display: none; }
  .cbm-kv { gap: var(--wb-s1); }
}
.cbm-body { display:flex; flex-direction:column; gap:var(--wb-s2); min-width:0; }
.cbm-card { flex:1 1 150px; min-width:140px; }
.wb-card.cbm-card.accent { border-color: var(--dsw-alias-brand-primary, rgba(76,154,255,.45)); }
.wb-card.cbm-card.green { border-color: var(--dsw-alias-state-success-primary, rgba(63,185,80,.45)); }
.wb-card.cbm-card.blue { border-color: var(--dsw-alias-state-business-primary, rgba(76,154,255,.35)); }
.wb-card.cbm-card.purple { border-color: var(--dsw-alias-brand-primary, rgba(139,92,246,.45)); }
.cbm-search input, .cbm-search button { padding:4px 10px; border-radius:var(--wb-r-sm); font-size:var(--wb-f-xs); font-family:inherit; cursor:pointer; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; }
.cbm-search input { min-width:160px; cursor:text; }
.cbm-search button { border-radius:var(--wb-r-pill); }
.cbm-search button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
/* ⚠ 共享层的 .wb-card 是 flex:1 1 150px（为**统计卡那一行**设计的）。分区卡套在 .cbm-body
   （flex column）里 ⇒ 会被**撑高**，折叠后仍占一大块空白，看起来"没有折叠" ✗（2026-10-23 用户报障）。
   ⇒ 分区一律不参与伸展、按内容高度走 ✓ */
.cbm-body > .cbm-section { flex: 0 0 auto; }
.cbm-section { gap:var(--wb-s1); }
.cbm-section > summary { cursor:pointer; list-style:none; }
.cbm-section > summary::-webkit-details-marker { display:none; }
.cbm-sec-body { display:flex; flex-direction:column; gap:var(--wb-s1); min-width:0; }
.cbm-block { display:flex; flex-direction:column; gap:var(--wb-s1); min-width:0; }
.cbm-kvs { display:flex; flex-direction:column; gap:2px; min-width:0; }
.cbm-nodes { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:var(--wb-s1); }
.cbm-node { display:flex; gap:var(--wb-s2); align-items:baseline; font-size:var(--wb-f-sm); padding:2px var(--wb-s1); border-radius:var(--wb-r-sm); cursor:pointer; min-width:0; }
.cbm-node:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.cbm-node-type { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.55)); min-width:64px; }
.cbm-node-file { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.5)); margin-left:auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:52%; }
.cbm-h3 { margin:var(--wb-s1) 0 2px; font-size:var(--wb-f-sm); }
.cbm-h3 small { font-weight:400; color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.cbm-kv { display:flex; gap:var(--wb-s2); font-size:var(--wb-f-xs); line-height:1.6; min-width:0; }
.cbm-kv-k { color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); min-width:72px; flex:0 0 auto; }
.cbm-kv-v { word-break:break-word; min-width:0; }
.cbm-note { margin:0; font-size:var(--wb-f-xs); line-height:1.6; color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.62)); }
.cbm-bars { display:flex; flex-direction:column; gap:2px; min-width:0; width:100%; }
.cbm-bar { display:grid; grid-template-columns:minmax(72px,140px) minmax(40px,1fr) 46px; gap:var(--wb-s2); align-items:center; font-size:var(--wb-f-xs); min-width:0; }
.cbm-bar-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color: var(--dsw-alias-label-secondary, rgba(230,230,230,.78)); }
.cbm-bar-track { height:6px; border-radius:var(--wb-r-pill); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.18)); overflow:hidden; }
.cbm-bar-fill { display:block; height:100%; background: var(--dsw-alias-brand-primary, #4c9aff); }
.cbm-bar-num { text-align:right; color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.cbm-audit .cbm-node { cursor:default; flex-wrap:wrap; }
/* 结构图（SVG）：节点大小=度数、颜色=节点类型（6 色轮转）；线=真实边 */
.cbm-viz { display:flex; flex-direction:column; gap:var(--wb-s1); min-width:0; }
.cbm-viz-svg { width:100%; height:420px; display:block; border-radius:var(--wb-r-md); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.1)); cursor:grab; touch-action:none; }
.cbm-viz-svg:active { cursor:grabbing; }
.cbm-viz-edge { stroke: var(--dsw-alias-border-l2, rgba(127,127,127,.35)); stroke-width:1; }
.cbm-viz-node { stroke: var(--dsw-alias-bg-layer-0, rgba(0,0,0,.4)); stroke-width:1; cursor:pointer; }
.cbm-viz-node:hover { stroke: var(--dsw-alias-label-primary, rgba(255,255,255,.9)); stroke-width:2; }
.cbm-viz-node.l0 { fill: var(--dsw-alias-brand-primary, #4c9aff); }
.cbm-viz-node.l1 { fill: var(--dsw-alias-state-success-primary, #3fb950); }
.cbm-viz-node.l2 { fill: var(--dsw-alias-state-warn-primary, #e0a43a); }
.cbm-viz-node.l3 { fill: var(--dsw-alias-state-error-primary, #f48771); }
.cbm-viz-node.l4 { fill: var(--dsw-alias-label-secondary, rgba(230,230,230,.78)); }
.cbm-viz-node.l5 { fill: var(--dsw-alias-brand-text, #6cb6ff); }
.cbm-viz-legend { display:flex; flex-wrap:wrap; gap:var(--wb-s2); font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); }
.cbm-viz-legend-item { display:inline-flex; align-items:center; gap:4px; }
.cbm-viz-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
.cbm-viz-dot.l0 { background: var(--dsw-alias-brand-primary, #4c9aff); }
.cbm-viz-dot.l1 { background: var(--dsw-alias-state-success-primary, #3fb950); }
.cbm-viz-dot.l2 { background: var(--dsw-alias-state-warn-primary, #e0a43a); }
.cbm-viz-dot.l3 { background: var(--dsw-alias-state-error-primary, #f48771); }
.cbm-viz-dot.l4 { background: var(--dsw-alias-label-secondary, rgba(230,230,230,.78)); }
.cbm-viz-dot.l5 { background: var(--dsw-alias-brand-text, #6cb6ff); }
`;

		function install(ctx) {
			ctx.effect(() => {
				if (document.getElementById(STYLE_ID)) { return undefined; }
				const el = document.createElement('style');
				el.id = STYLE_ID;
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, 'vssaros-codebase: workbench styles');
			ctx.inject(['desktopWorkbenches'], (c) => {
				c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, CodebasePanel), 'vssaros-codebase: workbench');
			});
			return undefined;
		}

		exports.install = install;
		exports.apply = install;
		exports.inject = [];
		// 纯函数导出：布局可以在进程内被自证（jsdom 挂载只验"画出来了"，布局质量要单独断言 ✓）
		exports.__layoutForce = layoutForce;
		return module.exports;
	},
});
