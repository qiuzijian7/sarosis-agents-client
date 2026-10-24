// @vssaros/dsh-kb —— 客户端入口（**单块**，2026-10-24 合并）。
//
// ★ 为什么把 `client.kb.js` 整段并进来（不再用子块 + require.async）：
//   真机排查结论 —— 宿主只对**入口** `<id>/client.js` 生成带 rev 的 URL；子块虽然也有
//   `client.<名>.js?rev=` 这条包内路由（装载器 CLIENT_CHUNK 正则接受），但它的 rev 取自
//   **入口文件**的 mtime/size，而浏览器对 `/plugins/**` 回的是 `immutable` 一年缓存 ⇒
//   子块一旦被缓存过，之后无论怎么改子块都对页面无影响（表现为「改了没反应」，
//   且服务端 probe 全部正常）。合并成单块后：只有入口一个 URL、rev 随它变，
//   不可能再出现"改了却没生效"。
//
// ⚠ 以后**不要再拆子块**：要加代码就往这个文件里加。
// ⚠ 入口里必须先 `var module = { exports: {} };`（否则真机报 `exports is not defined`）。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-kb',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const moduleRequire = require;   // 装载器：用它 require.async 拉同包 client 子块
		const react = require('react');
		const h = react.createElement;
		const { useState, useEffect, useCallback } = react;

		const API = '/x/kb/api';
		/** 「笔记」区（可写区）的目录名 —— 与后端 `NOTES_DIR` 同值（`lib/core/kb.js`）。 */
		const NOTES_NAME = '笔记';
		// ⚠ 描述符要与清单 `vssaros.workbench` **逐字段一致**：宿主快照直接取这里的 description / icon，
		//   **不回落到清单** ⇒ 漏写就是"注册表里那一项说明是空的" ✗（2026-10-22 审计发现本包就漏了 description）。
		const DESCRIPTOR = {
			title: '知识库',
			description: '本地资料库：检索、导入、整理与关系图谱。',
			repository: 'vssaros:kb',
			icon: 'codicon:book',
			customFrame: true,
		};

		async function getJson(path) {
			const res = await fetch(API + path, { cache: 'no-store', credentials: 'same-origin' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
			return body;
		}

		/**
		 * 写动作（第二刀）：建笔记 / 建目录 / 重命名 / 删除。
		 *
		 * ⚠ 全部走**后端现成的**那几条路由（`/api/new` `/api/rename` `/api/delete`）——
		 *   它们已经有「只在**笔记**区内动」「名字非法字符拒」「文件锁 + 派生刷新」这些围栏 ✓ ⇒
		 *   前端**不重写**一遍校验（重写就是两份围栏，迟早不一致 ✗）。
		 */
		async function postJson(path, payload) {
			const res = await fetch(API + path, {
				method: 'POST',
				headers: { 'content-type': 'application/json; charset=utf-8' },
				body: JSON.stringify(payload),
				credentials: 'same-origin',
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
			return body;
		}

		/** 目录树（折叠状态由父组件持有；点文件 = 打开正文；点**笔记区**目录 = 设为新建目标）。 */
		/** 目录下的文件总数（IDE sideview 的行尾计数口径：递归数文件，不数目录）。 */
		const countIn = (node) => (node && node.isDirectory
			? (node.children || []).reduce((n, child) => n + countIn(child), 0)
			: 1);
		/** 文件大小（>10KB 只留整 KB，避免行尾太长）。 */
		const sizeText = (bytes) => {
			if (typeof bytes !== 'number' || !Number.isFinite(bytes)) { return ''; }
			if (bytes >= 10240) { return Math.round(bytes / 1024) + ' KB'; }
			if (bytes >= 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
			return bytes + ' B';
		};
		/** 按扩展名给图标（sideview 那套：md 文档 / 图片 / 其它附件）。 */
		const iconOf = (name) => {
			const n = String(name || '').toLowerCase();
			if (/\.(md|markdown|txt)$/.test(n)) { return '📄'; }
			if (/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(n)) { return '🖼️'; }
			if (/\.(mp4|mov|webm|mkv)$/.test(n)) { return '🎬'; }
			if (/\.(pdf)$/.test(n)) { return '📕'; }
			if (/\.(json|ya?ml|js|ts|css|html|py)$/.test(n)) { return '📜'; }
			return '📎';
		};

		// ★ 2026-10-24：删掉了 legacy `KbPanel`（约 342 行）与它专用的 `TreeNodes`。
		//   它只服务于早期「工作台表面」，现在面板走 `KbWorkbenchPanel`（挂 kbSideview 同一份 bundle）
		//   ⇒ 那条路径再无入口，留着只会让人误以为还有第二套 UI（本仓为双实现付过代价）。

		const STYLE_ID = 'vssaros-kb-workbench-layout';
		// ★ 2026-10-22（工作台 UI 统一，方案稿 §6.19）：**通用视觉交给共享层**（宿主注入的 `wb-*`），
		//   这里只留知识库特有的东西：文件树行、检索命中行、正文列、新建/重命名的输入行。
		// ⚠ 原来写的 `--dsw-alias-border-default` / `-label-link` / `-font-family-monospace` / `-state-focus-primary`
		//   **都不存在** ⇒ 一律回落硬编码兜底 ⇒ 从没跟随过主题 ✗（迁移时统一换成真实令牌 / `--wb-*`）。
		const CSS = `
.wb-kbt .wb-field-row input { flex:1 1 auto; min-width:0; }
.kbt-search { display:flex; gap:var(--wb-s1); align-items:center; }
.kbt-treewrap, .kbt-hits { flex:1 1 auto; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:var(--wb-s2); }
.kbt-section { display:flex; flex-direction:column; gap:3px; }
.kbt-row { display:flex; align-items:center; gap:var(--wb-s1); font-size:var(--wb-f-sm); padding:1px var(--wb-s1); border-radius:var(--wb-r-sm); cursor:pointer; min-width:0; }
.kbt-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.kbt-file.is-current { background: var(--dsw-alias-interactive-bg-active, rgba(0,127,212,.14)); }
.kbt-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kbt-name.is-target { color: var(--dsw-alias-brand-primary, #007fd4); font-weight:600; }
.kbt-hit { padding:var(--wb-s1) 6px; border-radius:var(--wb-r-sm); cursor:pointer; min-width:0; }
.kbt-hit:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.kbt-hit-t { font-size:var(--wb-f-sm); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kbt-hit-s { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.65)); line-height:1.4; }
.kbt-doc { display:flex; flex-direction:column; gap:var(--wb-s2); min-width:0; }
.kbt-new { padding:var(--wb-s1) 0 3px; border-bottom:1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.2)); }
.kbt-new select, .kbt-new input, .kbt-rename input { padding:3px 8px; border-radius:var(--wb-r-sm); border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; font: inherit; font-size:var(--wb-f-xs); }
.kbt-new input { flex:1 1 90px; min-width:70px; }
.kbt-rename { display:flex; gap:var(--wb-s1); align-items:center; padding:var(--wb-s1) 0; }
.kbt-rename input { flex:1 1 auto; min-width:120px; border-color: var(--dsw-alias-brand-primary, rgba(0,127,212,.6)); }
.wb-kbt .wb-toolbar button, .wb-kbt .wb-field-row button, .wb-kbt .wb-acts button { padding:2px 10px; border-radius:var(--wb-r-pill); font-size:var(--wb-f-xs); font-family:inherit; cursor:pointer; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: transparent; color: inherit; }
.wb-kbt .wb-toolbar button:hover, .wb-kbt .wb-field-row button:hover, .wb-kbt .wb-acts button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.wb-kbt button:disabled { opacity:.5; cursor:default; }
.kbt-target { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); font-family: var(--wb-mono); }
`;

		/**
		 * ★★ 2026-10-24：工作台里**直接承载新版 React 侧栏页**（`/x/kb/sideview`，与 IDE 侧栏同一份 bundle）。
		 *
		 * 根因（为什么之前怎么改 `/x/kb/` 路由都不生效）：本包满足 `hasWorkbenchClient`（清单有
		 * `vssaros.workbench` + `exports['./client']` + `dsh.client.inject` 含 `@vssaros/dsh-workbenches`）⇒
		 * IDE 编辑区打开知识库时建的是 **'workbench' 视图**（`dshPluginPageEditorPane.ts:157/171`）——
		 * 它加载 dsh 客户端根路径 `/` 并挂**本文件注册的组件**，**根本不请求 `/x/kb/`** ✗。
		 * ⇒ 换视图只能从这里换：注册的组件改成 iframe 承载 `/x/kb/sideview`。
		 *
		 * 为什么用 iframe 而不是直接执行 `kbSideview.js`：那个 bundle 在顶层读 `window.__KB_SIDEVIEW_DATA__`
		 *   并 `createRoot` 到自己的根节点 —— 直接塞进 dsh 客户端会污染全局、和宿主 React 抢根 ✗。
		 *   iframe 同源（同一个 host、同一份 cookie），天然隔离 ✓。
		 * 降级：探测 `/x/kb/sideview` 失败（老 host / 路由缺失）⇒ 回落到下面的旧版 `KbPanel`，不白屏 ✓。
		 */
		/**
		 * ★★ 2026-10-24：**工作台面板**（与小红书工作台同一路线：宿主 React 树槽位 + props 注入）。
		 *
		 * 与旧 `KbPanel` 的区别：这里不自己实现 UI，而是把 `/x/kb/web/kbSideview.js` 这份
		 * **与 IDE 侧栏完全相同的 bundle** 挂到左栏（`window.__KB_SIDEVIEW_MOUNT__`），
		 * 右栏由本组件做正文预览 —— 因为工作台面板拿不到 IDE 编辑器。
		 *
		 * 数据：`/x/kb/api/page` + `/x/kb/api/graph`（与 `sync-kb-sideview.mjs` 同一套映射）。
		 * 交互：打开（读正文）/ 搜索（BM25）。写操作暂不在此开放（面板没有宿主对话框能力）。
		 */
		/**
		 * 关系图谱（面板内 canvas 渲染，2026-10-24）。
		 *
		 * 数据：`GET /x/kb/api/graph` —— 节点 id 是**库内相对路径**、边是 `{source,target}`。
		 * 力学常数与 `lib/graphPage.js` 的默认值一致（弹簧目标 = 两圆直径 + 40、单帧位移钳制 6、
		 * 中心力 0.012、速度衰减 0.9）。那个文件是**独立页脚本**，本组件拿不到它的作用域
		 * ⇒ 同一组常数在两处维护，改动时请一起改（已在两边注释里互相指认）。
		 */
		/**
		 * 图谱力学参数（**与 lib/shared/graphPhysics.js 同值**）。
		 * 本文件是单块客户端 chunk（拆子块会踩 immutable 缓存，见文件头），不能 import ⇒
		 * 保留一份常量，由 `scripts/check-kb-graph-physics.mjs` 逐项对账；不一致时守卫报红。
		 * 面板侧只用得到下面这几个（斥力/弹簧的公式与独立页不同，故不共享）。
		 */
		const KB_GRAPH_PHYS = { center: 0.012, damping: 0.9, minDist: 12, nodeRadius: 5, springPadding: 40, settleTicks: 260 };
		function KbGraph({ onClose, onOpen, vaultDir, vaultId }) {
			const wrapRef = react.useRef(null);
			const canvasRef = react.useRef(null);
			const [phase, setPhase] = useState('loading');
			const [error, setError] = useState('');
			const graphRef = react.useRef({ nodes: [], edges: [] });
			/** 「适应视图」按钮要调画布内的 fit（画布逻辑在 effect 里，用 ref 暴露出来） */
			const fitRef = react.useRef(null);

			useEffect(() => {
				let alive = true;
				const vid = String((vaultId && vaultId()) || '');
				fetch('/x/kb/api/graph?refresh=1' + (vid ? '&vault=' + encodeURIComponent(vid) : ''), { credentials: 'same-origin' })
					.then((r) => r.json())
					.then((b) => {
						if (!alive) { return; }
						if (!b || b.ok === false) { setPhase('error'); setError(String((b && b.error) || '读取图谱失败')); return; }
						const nodes = (b.nodes || []).map((n, i) => Object.assign({}, n, {
							x: Math.cos(i * 2.399963) * 160,
							y: Math.sin(i * 2.399963) * 160,
							vx: 0,
							vy: 0,
						}));
						const byId = new Map(nodes.map((n) => [n.id, n]));
						const edges = (b.edges || [])
							.map((e) => ({ s: byId.get(e.source), t: byId.get(e.target) }))
							.filter((e) => e.s && e.t);
						graphRef.current = { nodes, edges };
						setPhase('ready');
					})
					.catch((e) => { if (alive) { setPhase('error'); setError(String((e && e.message) || e)); } });
				return () => { alive = false; };
			}, []);

			useEffect(() => {
				if (phase !== 'ready') { return; }
				const canvas = canvasRef.current;
				const wrap = wrapRef.current;
				if (!canvas || !wrap) { return; }
				const ctx = canvas.getContext('2d');
				const R = KB_GRAPH_PHYS.nodeRadius;
				/** 常驻标签的度数门槛：只有枢纽节点才一直显示名字（其余靠悬停） */
				const HUB_DEGREE = 8;
				const view = { s: 0.8, x: 0, y: 0 };          // 缩放 + 平移（初始 0.8，先看到全貌）
				const pointer = { down: false, moved: false, lx: 0, ly: 0 };
				const hover = { node: null };
				let raf = 0;
				let ticks = 0;
				const dpr = () => window.devicePixelRatio || 1;
				const sizeOf = () => ({ w: wrap.clientWidth || 600, h: wrap.clientHeight || 400 });

				function resize() {
					const { w, h } = sizeOf();
					canvas.width = Math.round(w * dpr());
					canvas.height = Math.round(h * dpr());
					ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
					draw();
				}

				/** 屏幕坐标 → 图坐标（命中测试与悬停都要反变换） */
				function toGraph(mx, my) {
					return { x: (mx - view.x) / view.s, y: (my - view.y) / view.s };
				}

				/** 适应视图：按节点包围盒算缩放与居中，并做上下限保护 */
				function fit() {
					const { nodes } = graphRef.current;
					const { w, h } = sizeOf();
					if (!nodes.length) { return; }
					let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
					for (const n of nodes) {
						if (n.x < minX) { minX = n.x; }
						if (n.y < minY) { minY = n.y; }
						if (n.x > maxX) { maxX = n.x; }
						if (n.y > maxY) { maxY = n.y; }
					}
					const pad = 40;
					const gw = Math.max(1, maxX - minX);
					const gh = Math.max(1, maxY - minY);
					const s = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh);
					// 缩放保护：太小看不清、太大反而丢掉整体
					view.s = Math.max(0.45, Math.min(1.4, s));
					view.x = w / 2 - ((minX + maxX) / 2) * view.s;
					view.y = h / 2 - ((minY + maxY) / 2) * view.s;
					draw();
				}

				function draw() {
					const { w, h } = sizeOf();
					const { nodes, edges } = graphRef.current;
					ctx.clearRect(0, 0, w, h);
					ctx.save();
					ctx.translate(view.x, view.y);
					ctx.scale(view.s, view.s);

					ctx.strokeStyle = 'rgba(127,127,127,.32)';
					ctx.lineWidth = 1 / view.s;
					ctx.beginPath();
					for (const e of edges) { ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y); }
					ctx.stroke();

					const hv = hover.node;
					for (const n of nodes) {
						const isHover = hv === n;
						const isHub = (n.degree || 0) >= HUB_DEGREE;
						ctx.beginPath();
						ctx.arc(n.x, n.y, isHover ? R + 2 : R, 0, Math.PI * 2);
						ctx.fillStyle = isHover
							? '#ffffff'
							: (String(n.id).indexOf('/库/') >= 0 ? '#dcb67a' : '#3794ff');
						ctx.fill();
						if (isHover || isHub) {
							const label = String(n.id).split('/').pop().replace(/\.md$/i, '');
							ctx.font = (isHover ? '12px' : '11px') + ' sans-serif';
							ctx.fillStyle = isHover ? '#ffffff' : 'rgba(200,200,200,.8)';
							ctx.fillText(label, n.x + R + 4, n.y + 4);
						}
					}
					ctx.restore();
				}

				function step() {
					const { w, h } = sizeOf();
					const cx = w / 2;
					const cy = h / 2;
					const { nodes, edges } = graphRef.current;
					// 力学在**图坐标**里跑（与缩放无关）⇒ 以画布中心反算的图中心为准
					const gcx = (cx - view.x) / view.s;
					const gcy = (cy - view.y) / view.s;
					for (let i = 0; i < nodes.length; i++) {
						const a2 = nodes[i];
						for (let j = i + 1; j < nodes.length; j++) {
							const b2 = nodes[j];
							let dx = b2.x - a2.x;
							let dy = b2.y - a2.y;
							let d2 = dx * dx + dy * dy;
							if (d2 < KB_GRAPH_PHYS.minDist * KB_GRAPH_PHYS.minDist) {
								d2 = KB_GRAPH_PHYS.minDist * KB_GRAPH_PHYS.minDist;
								dx = ((i % 7) - 3) || 1;
								dy = ((j % 5) - 2) || 1;
							}
							const d = Math.sqrt(d2);
							const f = 900 / d2;
							a2.vx -= (dx / d) * f * 4; a2.vy -= (dy / d) * f * 4;
							b2.vx += (dx / d) * f * 4; b2.vy += (dy / d) * f * 4;
						}
					}
					for (const e of edges) {
						const dx = e.t.x - e.s.x;
						const dy = e.t.y - e.s.y;
						const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
						const want = R * 2 + KB_GRAPH_PHYS.springPadding;
						const f = (d - want) * 0.02;
						const ux = dx / d;
						const uy = dy / d;
						e.s.vx += ux * f; e.s.vy += uy * f;
						e.t.vx -= ux * f; e.t.vy -= uy * f;
					}
					for (const n of nodes) {
						n.vx += (gcx - n.x) * KB_GRAPH_PHYS.center;
						n.vy += (gcy - n.y) * KB_GRAPH_PHYS.center;
						n.vx *= KB_GRAPH_PHYS.damping;
						n.vy *= KB_GRAPH_PHYS.damping;
						const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
						if (sp > 6) { n.vx = (n.vx / sp) * 6; n.vy = (n.vy / sp) * 6; }
						n.x += n.vx;
						n.y += n.vy;
					}
					draw();
					ticks += 1;
					if (ticks < KB_GRAPH_PHYS.settleTicks) {
						raf = requestAnimationFrame(step);
					} else {
						fit();            // 收敛后自动适应一次（用户仍可手动缩放/拖动）
					}
				}

				/** 命中最接近的节点（半径 9px，按屏幕像素算，缩小时也好点） */
				function hitTest(mx, my) {
					const g = toGraph(mx, my);
					let best = null;
					let bestD = 1e9;
					for (const n of graphRef.current.nodes) {
						const dx = n.x - g.x;
						const dy = n.y - g.y;
						const d = dx * dx + dy * dy;
						if (d < 81 && d < bestD) { bestD = d; best = n; }
					}
					return best;
				}

				const onWheel = (ev) => {
					ev.preventDefault();
					const rect = canvas.getBoundingClientRect();
					const mx = ev.clientX - rect.left;
					const my = ev.clientY - rect.top;
					const before = toGraph(mx, my);
					const factor = ev.deltaY > 0 ? 0.9 : 1.1;
					view.s = Math.max(0.25, Math.min(3, view.s * factor));
					// 以鼠标位置为中心缩放：保证指针下的图坐标不动
					view.x = mx - before.x * view.s;
					view.y = my - before.y * view.s;
					draw();
				};

				const onDown = (ev) => {
					pointer.down = true;
					pointer.moved = false;
					pointer.lx = ev.clientX;
					pointer.ly = ev.clientY;
				};
				const onMove = (ev) => {
					const rect = canvas.getBoundingClientRect();
					const mx = ev.clientX - rect.left;
					const my = ev.clientY - rect.top;
					if (pointer.down) {
						const dx = ev.clientX - pointer.lx;
						const dy = ev.clientY - pointer.ly;
						if (Math.abs(dx) + Math.abs(dy) > 3) { pointer.moved = true; }
						view.x += dx;
						view.y += dy;
						pointer.lx = ev.clientX;
						pointer.ly = ev.clientY;
						draw();
						return;
					}
					const hit = hitTest(mx, my);
					if (hit !== hover.node) {
						hover.node = hit;
						canvas.style.cursor = hit ? 'pointer' : 'default';
						draw();
					}
				};
				const onUp = () => { pointer.down = false; };
				const onLeave = () => { pointer.down = false; hover.node = null; draw(); };
				const onClick = (ev) => {
					if (pointer.moved) { return; }        // 拖动结束不算点击
					const rect = canvas.getBoundingClientRect();
					const hit = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
					if (!hit) { return; }
					const base = String(vaultDir() || '').replace(/\\/g, '/').replace(new RegExp('/+$'), '');
					onOpen(base ? base + '/' + hit.id : String(hit.id));
				};

				resize();
				let ro = null;
				try { ro = new ResizeObserver(resize); ro.observe(wrap); } catch { /* 老内核 */ }
				fitRef.current = fit;
				raf = requestAnimationFrame(step);
				canvas.addEventListener('wheel', onWheel, { passive: false });
				canvas.addEventListener('mousedown', onDown);
				canvas.addEventListener('mousemove', onMove);
				canvas.addEventListener('mouseup', onUp);
				canvas.addEventListener('mouseleave', onLeave);
				canvas.addEventListener('click', onClick);
				return () => {
					cancelAnimationFrame(raf);
					fitRef.current = null;
					if (ro) { ro.disconnect(); }
					canvas.removeEventListener('wheel', onWheel);
					canvas.removeEventListener('mousedown', onDown);
					canvas.removeEventListener('mousemove', onMove);
					canvas.removeEventListener('mouseup', onUp);
					canvas.removeEventListener('mouseleave', onLeave);
					canvas.removeEventListener('click', onClick);
				};
			}, [phase, onOpen, vaultDir]);

			const bar = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', borderBottom: '1px solid rgba(127,127,127,.25)', flex: '0 0 auto' } },
				h('button', { type: 'button', onClick: onClose, style: { height: 22, padding: '0 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 3, background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)' } }, '← 返回笔记'),
				h('span', { style: { fontSize: 12, opacity: 0.7 } }, '关系图谱'),
				h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.6 } },
					graphRef.current.nodes.length + ' 节点 / ' + graphRef.current.edges.length + ' 边'));

			if (phase === 'error') {
				return h('div', { 'data-kb-workbench': 'graph', style: { display: 'flex', flexDirection: 'column', height: '100%' } },
					bar, h('div', { style: { padding: 16, opacity: 0.8 } }, '图谱加载失败：' + error));
			}
			return h('div', { 'data-kb-workbench': 'graph', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
				bar,
				h('div', { ref: wrapRef, style: { flex: '1 1 auto', minHeight: 0, position: 'relative' } },
					h('canvas', { ref: canvasRef, 'data-kb-graph-canvas': '1', style: { display: 'block', width: '100%', height: '100%' } }),
					phase === 'loading' ? h('div', { style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 12, opacity: 0.6 } }, '正在读取图谱…') : null));
		}

		/**
		 * 知识库设置（dsh 侧**二级页面**，2026-10-24）。
		 *
		 * 为什么是整页而不是弹窗：IDE 侧点 ⚙ 会开一个独立 editor pane（`kbSettingsEditorPane`），
		 * 窗口侧没有 editor 区 ⇒ 用「整页替换 + ← 返回」当等价物，两边的**信息层级**才对得上。
		 *
		 * 内容照 IDE 五节裁剪：只保留 dsh 侧真能生效的（目录 / 构建方式 / 飞书 / 状态）；
		 * 系统选目录、Embedding provider、全局索引这些属于宿主，不在这里假装。
		 */
		function KbSettingsPage({ onClose, onSwitchVault, onAddVault, vaultRef }) {
			/**
			 * ★★ 2026-10-24（真机：工作台「知识库」渲染时出错 · `c is not defined`）：
			 *   本组件在 3 处引用 `c.line` / `c.fgFaint`，但作用域里**从来没有 c**
			 *   （那是另一个组件里的常量）⇒ 一旦点开 ⚙ 就抛错，宿主错误边界把整个面板换成
			 *   「渲染时出错」。之前没暴露是因为设置页一直是死代码（从未被渲染）。
			 *   ⇒ 设置页自带一份**最小色板**，与面板同口径走 CSS 变量。
			 */
			const c = {
				line: 'rgba(127,127,127,.35)',
				fgFaint: 'var(--vscode-descriptionForeground, #9d9d9d)',
			};
			const [settings, setSettings] = useState(null);
			const [stats, setStats] = useState(null);
			const [busy, setBusy] = useState(false);
			const [out, setOut] = useState('');
			/** 新建：**文件夹路径**（文件夹名即库名，不再单独取名） */
			const [createPath, setCreatePath] = useState('');
			const [attachPath, setAttachPath] = useState('');
			/** 目录映射的三个输入框（本地笔记子目录 / 飞书 spaceId / 知识库名） */
			const [mapDir, setMapDir] = useState('');
			const [mapSpace, setMapSpace] = useState('');
			const [mapName, setMapName] = useState('');
			/** 飞书 CLI 状态（版本/错误）与知识库列表 —— 对齐 IDE 的「重新检测」「刷新知识库列表」 */
			const [cli, setCli] = useState(null);
			const [spaces, setSpaces] = useState([]);
			const [cliBusy, setCliBusy] = useState(false);
			/** CLI 路径草稿（保存到设置里的 feishu.cliPath；留空 = 走 PATH） */
			const [cliPathDraft, setCliPathDraft] = useState('');
			/** 目录 / 知识库两个自定义下拉的开关（原生 datalist 在 Electron 里滚不动也选不了） */
			const [dirMenu, setDirMenu] = useState(false);
			const [spaceMenu, setSpaceMenu] = useState(false);
			/** 拉取知识库列表的结果反馈（"点按钮没反应"就是因为原先没有任何可见结果） */
			const [spacesMsg, setSpacesMsg] = useState('');

			useEffect(() => {
				let alive = true;
				fetch('/x/kb/api/kb-settings', { credentials: 'same-origin' })
					.then((r) => r.json())
					.then((b) => { if (alive && b && b.ok) { setSettings(b.settings); } })
					.catch(() => { /* 读不到就保持空，页面照常可用 */ });
				const want = vaultRef && vaultRef.current && vaultRef.current.id;
				fetch('/x/kb/api/view-data' + (want ? '?vault=' + encodeURIComponent(want) : ''), { credentials: 'same-origin' })
					.then((r) => r.json())
					.then((b) => { if (alive && b && b.ok) { setStats(b.data); } })
					.catch(() => { /* 同上 */ });
				return () => { alive = false; };
			}, []);

			const save = (patch) => {
				const next = Object.assign({}, settings || {}, patch);
				setSettings(next);
				fetch('/x/kb/api/kb-settings', {
					method: 'POST', credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(next),
				}).then((r) => r.json()).then((b) => {
					if (!b || b.ok === false) { window.alert('保存设置失败：' + ((b && b.error) || '未知错误')); }
				}).catch((e) => window.alert('保存设置失败：' + String((e && e.message) || e)));
			};
			const patchFeishu = (k, v) => {
				const f = Object.assign({}, (settings && settings.feishu) || {}, { [k]: v });
				save({ feishu: f });
			};

			/** 检测 lark-cli（版本 or 缺失原因） */
			const checkCli = () => {
				setCliBusy(true);
				// 带上设置里的 CLI 路径（装在非标准位置 / npm 的 .cmd shim 时必填）
				const q = String((settings && settings.feishu && settings.feishu.cliPath) || '').trim();
				fetch('/x/kb/api/feishu-cli' + (q ? ('?cli=' + encodeURIComponent(q)) : ''), { credentials: 'same-origin' })
					.then((r) => r.json())
					.then((b) => setCli(b || { ok: false, error: '无响应' }))
					.catch((e) => setCli({ ok: false, error: String((e && e.message) || e) }))
					.then(() => setCliBusy(false));
			};
			/** 升级 lark-cli（IDE 的「⬆️ 升级 lark-cli」） */
			const upgradeCli = () => {
				if (!window.confirm('在后台执行 lark-cli update，可能需要一会儿。继续？')) { return; }
				setCliBusy(true);
				setOut('升级 lark-cli …');
				fetch('/x/kb/api/feishu-cli', {
					method: 'POST', credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ action: 'upgrade' }),
				}).then((r) => r.json())
					.then((b) => { setOut((b && b.output) || (b && b.error) || '(无输出)'); })
					.catch((e) => setOut(String((e && e.message) || e)))
					.then(() => { setCliBusy(false); checkCli(); });
			};
			/** 拉飞书知识库列表（映射右侧下拉的数据源） */
			const loadSpaces = () => {
				setCliBusy(true);
				setSpacesMsg('正在拉取…');
				fetch('/x/kb/api/feishu-spaces', { credentials: 'same-origin' })
					.then((r) => r.json())
					.then((b) => {
						const list = (b && b.ok && Array.isArray(b.spaces)) ? b.spaces : [];
						setSpaces(list);
						if (b && b.ok) {
							if (list.length) {
								setSpacesMsg('✓ ' + list.length + ' 个知识库');
								setSpaceMenu(true);   // 拉到就直接展开，省一次点击
							} else {
								setSpacesMsg('✓ 已连接，但没有可见的知识库');
							}
						} else {
							setSpacesMsg('✗ ' + String((b && b.error) || '未知原因').split('\n')[0].slice(0, 160));
						}
					})
					.catch((e) => setSpacesMsg('✗ ' + String((e && e.message) || e).slice(0, 160)))
					.then(() => setCliBusy(false));
			};
			/** 读取上次同步日志（落盘 `.kb-feishu-sync.log`） */
			const loadLog = () => {
				fetch('/x/kb/api/feishu-log?lines=200', { credentials: 'same-origin' })
					.then((r) => r.json())
					.then((b) => {
						if (!b || b.ok === false) { window.alert('读取日志失败：' + String((b && b.error) || '未知原因')); return; }
						setOut((b.lines || []).join('\n') || '（还没有同步日志）');
					})
					.catch((e) => window.alert('读取日志失败：' + String((e && e.message) || e)));
			};

			const runSync = (label, dry) => {
				setBusy(true);
				setOut(label + ' …');
				fetch('/x/kb/api/feishu-sync' + (dry ? '?dry=1' : ''), { method: 'POST', credentials: 'same-origin' })
					.then((r) => r.json())
					.then((b) => { setOut((b && b.output) || (b && b.error) || '(无输出)'); })
					.catch((e) => setOut(String((e && e.message) || e)))
					.then(() => setBusy(false));
			};

			// 设置加载后同步一次草稿（避免"已保存但输入框是空的"）
			useEffect(() => {
				setCliPathDraft(String((settings && settings.feishu && settings.feishu.cliPath) || ''));
			}, [settings]);

			// 进页面就检测一次 CLI（不阻塞渲染；失败只体现在状态行）
			useEffect(() => { checkCli(); }, []);

			const vaults = (stats && stats.vaults) || [];
			/** 已配置的目录映射（来自设置文件） */
			const feishuCfg = (settings && settings.feishu) || {};
			const maps = Array.isArray(feishuCfg.mappings) ? feishuCfg.mappings : [];
			/** 「笔记」区里的子目录（相对库根，形如 笔记/01_学习/AI）——映射的左侧就是它们 */
			const vaultDirOf = (stats && ((stats.vaults || []).find((v) => v.id === stats.activeVaultId) || {}).dir) || '';
			const relOf = (abs) => {
				const a = String(abs || '').replace(/\\/g, '/');
				const b = String(vaultDirOf || '').replace(/\\/g, '/').replace(new RegExp('/+$'), '');
				return b && a.indexOf(b) === 0 ? a.slice(b.length).replace(new RegExp('^/+'), '') : a;
			};
			const folders = [];
			const walkDirs = (nodes) => { for (const n of nodes || []) { if (n && n.isFolder) { folders.push(relOf(n.path)); walkDirs(n.children); } } };
			walkDirs(stats && stats.tree);
			const cur = vaults.find((v) => v.id === (stats && stats.activeVaultId)) || vaults[0];
			const row = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: 12 };
			/** 下拉面板（绝对定位、可滚动、最高 240px） */
			const menuBox = { position: 'absolute', left: 0, right: 0, top: 26, zIndex: 60, maxHeight: 240, overflow: 'auto', background: 'var(--vscode-menu-background, #252526)', border: '1px solid rgba(127,127,127,.4)', borderRadius: 4, boxShadow: '0 8px 24px rgba(0,0,0,.45)' };
			const menuItem = { padding: '4px 8px', fontSize: 11.5, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
			const btn = { height: 24, padding: '0 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 4, background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)' };
			const sec = { borderTop: '1px solid rgba(127,127,127,.25)', padding: '12px 16px' };
			const h2 = { fontSize: 12.5, fontWeight: 600, margin: '0 0 8px', opacity: .95 };

			return h('div', { 'data-kb-settings-page': '1', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px', borderBottom: '1px solid rgba(127,127,127,.25)', flex: '0 0 auto' } },
					h('button', { type: 'button', onClick: onClose, style: btn }, '← 返回知识库'),
					h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '知识库设置'),
					h('span', { style: { marginLeft: 'auto', fontSize: 10.5, opacity: .55 } }, '窗口模式 · ' + (settings ? '已加载' : '读取中'))),
				h('div', { style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } },

					// 📁 知识库目录
					h('div', { style: sec },
						h('div', { style: h2 }, '📁 知识库目录'),
						h('div', { style: { fontSize: 11.5, opacity: .75, marginBottom: 6 } }, cur ? (cur.name + '  ·  ' + (cur.dir || '')) : '（未连接）'),
						h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
							vaults.map((v) => h('button', {
								key: v.id, type: 'button',
								onClick: () => { onSwitchVault(v.id); onClose(); },
								style: Object.assign({}, btn, v.id === (stats && stats.activeVaultId) ? { background: 'rgba(127,127,127,.2)' } : {}),
							}, v.name + ' ' + v.count))),
						h('div', { style: row },
							h('input', { value: createPath, placeholder: '新建知识库的文件夹绝对路径，如 E:\\Notes\\MyVault', onChange: (e) => setCreatePath(e.target.value), style: { flex: 1, height: 24, padding: '0 8px', background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 4, fontSize: 12 } }),
							h('button', { type: 'button', style: btn, onClick: () => { if (createPath.trim()) { onAddVault('create', createPath.trim()); onClose(); } } }, '＋ 新建知识库')),
						// ★ 文件夹名即库名：不再让用户另取名字，避免"显示名与目录名对不上"
						h('div', { style: { fontSize: 10.5, opacity: .6, marginLeft: 2 } }, '文件夹不存在会自动创建（并补 笔记/ 与 库/ 子目录）；新建后**文件夹名就是知识库名字**。'),
						h('div', { style: row },
							h('input', { value: attachPath, placeholder: '已有文件夹绝对路径，如 E:\\MyNotes', onChange: (e) => setAttachPath(e.target.value), style: { flex: 1, height: 24, padding: '0 8px', background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 4, fontSize: 12 } }),
							h('button', { type: 'button', style: btn, onClick: () => { if (attachPath.trim()) { onAddVault('attach', attachPath.trim()); onClose(); } } }, '＋ 本地载入'))),

					// ⚙️ 构建方式
					h('div', { style: sec },
						h('div', { style: h2 }, '⚙️ 构建方式'),
						h('label', { style: row },
							h('input', { type: 'checkbox', checked: !!(settings && settings.agenticBuild), onChange: (e) => save({ agenticBuild: e.target.checked }) }),
							h('span', null, 'Agentic 构建（知识库专家 Agent：技能注入 + 工具，质量更高但更慢）')),
						h('div', { style: { fontSize: 11, opacity: .6, marginLeft: 22 } }, '关闭后走纯直连 LLM 管线（更快更省，无工具能力）')),

					// 📤 飞书同步
					h('div', { style: sec },
						h('div', { style: h2 }, '📤 飞书同步'),
						h('label', { style: row },
							h('input', { type: 'checkbox', checked: !!(settings && settings.feishu && settings.feishu.enabled), onChange: (e) => patchFeishu('enabled', e.target.checked) }),
							h('span', null, '启用飞书同步'),
							h('input', { type: 'checkbox', checked: !!(settings && settings.feishu && settings.feishu.schedule), onChange: (e) => patchFeishu('schedule', e.target.checked) }),
							h('span', null, '允许定时同步')),
						// 飞书 CLI：路径配置（IDE 的 `…kb.feishu.cliPath`）+ 状态 + 重新检测 + 升级
						h('div', { style: row },
							h('span', null, 'CLI 路径'),
							h('input', { value: cliPathDraft, placeholder: '留空 = 走 PATH；Windows 上 npm 装的是 lark-cli.cmd（可填全路径）', onChange: (e) => setCliPathDraft(e.target.value), style: { flex: 1, height: 24, padding: '0 8px', background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 4, fontSize: 12 } }),
							h('button', { type: 'button', style: btn, onClick: () => { patchFeishu('cliPath', cliPathDraft.trim()); setTimeout(() => checkCli(), 400); } }, '保存并检测')),
						h('div', { style: row },
							h('span', null, '飞书 CLI'),
							h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: .8 } },
								cliBusy ? '检测中…'
									: cli && cli.ok ? ('✓ ' + (cli.version || '已安装') + '  ' + (cli.exe || ''))
										: ('✗ ' + String((cli && cli.error) || '未检测'))),
							h('button', { type: 'button', style: btn, disabled: cliBusy, onClick: () => checkCli() }, '重新检测'),
							h('button', { type: 'button', style: btn, disabled: cliBusy, onClick: () => upgradeCli() }, '⬆️ 升级 lark-cli')),
						h('div', { style: row },
							h('span', null, '每篇间隔(ms)'),
							h('input', { type: 'number', value: (settings && settings.feishu && settings.feishu.intervalMs) || 800, onChange: (e) => patchFeishu('intervalMs', Number(e.target.value) || 0), style: { width: 90, height: 24, padding: '0 6px', background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 4, fontSize: 12 } }),
							h('span', null, '远端手改时'),
							h('select', { value: (settings && settings.feishu && settings.feishu.conflict) || 'skip', onChange: (e) => patchFeishu('conflict', e.target.value), style: { height: 24, background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 4, fontSize: 12 } },
								h('option', { value: 'skip' }, '跳过并记录冲突'),
								h('option', { value: 'local' }, '本地覆盖'))),
						h('label', { style: row },
							h('input', { type: 'checkbox', checked: !!(settings && settings.feishu && settings.feishu.deleteRemote), onChange: (e) => patchFeishu('deleteRemote', e.target.checked) }),
							h('span', null, '本地删除的文档同时移除远端节点（危险，默认关）')),
						h('div', { style: row },
							h('button', { type: 'button', style: btn, disabled: busy, onClick: () => runSync('预览同步计划（dry-run）', true) }, '🔍 预览同步计划'),
							h('button', { type: 'button', style: btn, disabled: busy, onClick: () => runSync('立即同步', false) }, busy ? '同步中…' : '📤 立即同步到飞书'),
							h('button', { type: 'button', style: btn, onClick: () => loadLog() }, '📄 查看同步日志'),
							h('button', { type: 'button', style: btn, onClick: () => setOut('') }, '清空日志')),
						h('pre', { style: { margin: '6px 0 0', maxHeight: 180, overflow: 'auto', fontSize: 11, lineHeight: 1.5, background: 'rgba(127,127,127,.10)', borderRadius: 4, padding: 8, whiteSpace: 'pre-wrap' } }, out || '（尚未运行同步）'),

						// ★ 2026-10-24（用户：设置里缺目录映射）：对齐 IDE 设置页的「目录映射」块 ——
						//   把「笔记」区里的某个子目录（含子目录）绑定到一个飞书知识库。
						//   同步时由服务端写成 `<vault>/.feishu-space-map.json`（脚本 `feishu-sync.mjs` 默认就读它）。
						h('div', { style: { marginTop: 12 } },
							h('div', { style: { fontSize: 11, color: c.fgFaint, marginBottom: 4 } }, '目录映射（本地「笔记」子目录 → 飞书知识库）'),
							(maps.length === 0
								? h('div', { style: { fontSize: 11, opacity: .6, marginBottom: 4 } }, '尚未配置映射 —— 不配也能同步：脚本会按类别自动建同名知识库')
								: h('div', { style: { border: `1px solid ${c.line}`, borderRadius: 4, marginBottom: 6 } },
									maps.map((m, i) => h('div', {
										key: String(i),
										style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderTop: i ? `1px solid ${c.line}` : 'none', fontSize: 11.5 },
									},
										h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(m.dir || '')),
										h('span', { style: { opacity: .5 } }, '→'),
										h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (m.spaceName ? String(m.spaceName) + ' ' : '') + '(' + String(m.spaceId || '') + ')'),
										h('button', { type: 'button', style: btn, onClick: () => { patchFeishu('mappings', maps.filter((_, j) => j !== i)); } }, '删除'))))),
							h('div', { style: row },
								h('div', { style: { position: 'relative', flex: 1, minWidth: 0 } },
									h('input', { value: mapDir, placeholder: '笔记子目录，如 笔记/01_学习/AI', onChange: (e) => setMapDir(e.target.value), style: { width: '100%', height: 24, boxSizing: 'border-box', padding: '0 24px 0 8px', background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 4, fontSize: 12 } }),
									h('button', { type: 'button', title: '选择目录', onClick: () => setDirMenu((v) => !v), style: { position: 'absolute', right: 0, top: 0, width: 22, height: 24, background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer' } }, '▾'),
									dirMenu ? h('div', { style: menuBox },
										(folders.filter((d) => !mapDir.trim() || d.toLowerCase().includes(mapDir.trim().toLowerCase())).slice(0, 400)).map((d) => h('div', { key: d, onClick: () => { setMapDir(d); setDirMenu(false); }, style: menuItem }, d))) : null),
								h('div', { style: { position: 'relative', width: 300 } },
									h('input', { value: mapSpace, placeholder: 'spaceId（点 ▾ 选）', onChange: (e) => setMapSpace(e.target.value), style: { width: '100%', height: 24, boxSizing: 'border-box', padding: '0 24px 0 8px', background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 4, fontSize: 12 } }),
									h('button', { type: 'button', title: '选择飞书知识库', onClick: () => { if (!spaces.length) { loadSpaces(); } setSpaceMenu((v) => !v); }, style: { position: 'absolute', right: 0, top: 0, width: 22, height: 24, background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer' } }, '▾'),
									spaceMenu ? h('div', { style: menuBox },
										spaces.length
											? spaces.map((s) => h('div', { key: s.id, onClick: () => { setMapSpace(s.id); if (s.name) { setMapName(s.name); } setSpaceMenu(false); }, style: menuItem }, (s.name || s.id) + (s.name && s.id ? '   ' + s.id : '')))
											: h('div', { style: Object.assign({}, menuItem, { opacity: .6 }) }, '（列表为空，先点「🔄 刷新知识库列表」）')) : null),
								h('button', { type: 'button', style: btn, disabled: cliBusy, onClick: () => loadSpaces() }, '🔄 刷新知识库列表'),
								spacesMsg ? h('span', { style: { fontSize: 10.5, opacity: .75, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: spacesMsg }, spacesMsg) : null,
								h('input', { value: mapName, placeholder: '知识库名（可选）', onChange: (e) => setMapName(e.target.value), style: { width: 140, height: 24, padding: '0 8px', background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 4, fontSize: 12 } }),
								h('button', { type: 'button', style: btn, onClick: () => {
									const dir = mapDir.trim();
									const spaceId = mapSpace.trim();
									if (!dir || !spaceId) { window.alert('请填写目录与 spaceId'); return; }
									patchFeishu('mappings', maps.concat([{ dir: dir, spaceId: spaceId, spaceName: mapName.trim() }]));
									setMapDir(''); setMapSpace(''); setMapName('');
								} }, '＋ 添加映射')),
							h('div', { style: { fontSize: 10.5, opacity: .6 } }, '同步时会写成 <vault>/.feishu-space-map.json；路径相对**库根**（以「笔记/」开头）。'))),

					// 📊 状态
					h('div', { style: Object.assign({}, sec, { borderBottom: '1px solid rgba(127,127,127,.25)' }) },
						h('div', { style: h2 }, '📊 状态'),
						h('div', { style: { fontSize: 11.5, opacity: .8, lineHeight: 1.8 } },
							'笔记 ' + ((stats && stats.noteCount) || 0) + ' 篇 · 库 ' + ((stats && stats.libraryCount) || 0) + ' 个文件',
							h('br'),
							'索引：' + ((stats && stats.indexState === 'ready') ? '就绪' : '未就绪') + ' · 标签 ' + (((stats && stats.tags) || []).length) + ' 个'),
						)))
			;
		}
		function KbWorkbenchPanel() {
			const hostRef = react.useRef(null);
			const disposeRef = react.useRef(null);
			const [phase, setPhase] = useState('loading');   // loading | ready | error
			const [error, setError] = useState('');
			const [doc, setDoc] = useState(null);            // { title, text }
			const vaultRef = react.useRef({ id: '', dir: '' });   // 写操作要 vaultId + 库根（绝对→相对折算）
			const remountRef = react.useRef(null);
			/** 面板内视图：tree（默认） | graph（关系图谱，/x/kb/graph） */
			const [pane, setPane] = useState('tree');
			/** 用户从「设置 → 切换库」选中的库（空 = 跟随 IDE 注入的当前库） */
			const vaultWantRef = react.useRef('');

			const countOf = (node) => (node.children ?? []).reduce((n, c) => n + (c.isDirectory ? countOf(c) : 1), 0);
			const mapNodes = (list) => (list ?? []).map((node) => node.isDirectory
				? { name: node.name, path: node.abs || node.rel, isFolder: true, count: countOf(node), children: mapNodes(node.children) }
				: { name: String(node.name).replace(/\.md$/i, ''), path: node.abs || node.rel, isFolder: false, size: node.size, name0: node.name });

			/**
			 * 取 bundle 的顺序（2026-10-24 真机教训）：
			 *   ① 已经有了 ⇒ 直接用
			 *   ② **装载器 `require.async('./client.kbview.js')`** —— 与 `client.kb.js` 同一条通道，
			 *      已证可用；`<script src>` 拉 `/x/kb/web/kbSideview.js` 会被宿主挡掉（子资源不走插件路由）。
			 *   ③ 装载器不可用（老宿主）⇒ 退回 script 标签，失败才报错。
			 */
			const loadBundle = () => new Promise((resolve, reject) => {
				if (typeof window.__KB_SIDEVIEW_MOUNT__ === 'function') { return resolve(); }
				const viaScript = () => {
					const s = document.createElement('script');
					s.src = '/x/kb/web/kbSideview.js';
					s.onload = () => (typeof window.__KB_SIDEVIEW_MOUNT__ === 'function' ? resolve() : reject(new Error('bundle 未导出 MOUNT')));
					s.onerror = () => reject(new Error('bundle 加载失败：/x/kb/web/kbSideview.js'));
					document.head.appendChild(s);
				};
				try {
					if (moduleRequire && typeof moduleRequire.async === 'function') {
						Promise.resolve(moduleRequire.async('./client.kbview.js'))
							.then(() => (typeof window.__KB_SIDEVIEW_MOUNT__ === 'function'
								? resolve()
								: reject(new Error('client.kbview.js 已加载但未导出 MOUNT'))))
							.catch(() => viaScript());
						return;
					}
				} catch { /* 落到 script 兜底 */ }
				viaScript();
			});

			const buildData = async () => {
				// ★ 2026-10-24：**服务端统一组装**（`/api/view-data`）。此前这里有一份 mapNodes / links 映射，
				//   与插件页（sync-kb-sideview.mjs）各写一份 ⇒ 字段会漂移（面板与页面篇数不一致就来自这里）。
				//   现在两侧都只 fetch 一次，想改结构只改服务端。
				try {
					// `?vault=` 用于「设置 → 切换库」；空则服务端退回 IDE 注入的当前库
					const want = vaultWantRef.current;
					const q = want ? ('?vault=' + encodeURIComponent(want)) : '';
					const r = await fetch('/x/kb/api/view-data' + q, { credentials: 'same-origin', cache: 'no-store' });
					const b = await r.json();
					if (b && b.ok && b.data) {
						const list = b.data.vaults || [];
						const cur = list.find((v) => v.id === b.data.activeVaultId) || list[0];
						if (cur) { vaultRef.current = { id: String(cur.id || ''), dir: String(cur.dir || '') }; }
						return b.data;
					}
				} catch (e) {
					console.error('[kb-workbench] view-data 失败', e);
				}
				return { vaultName: '(未连接)', vaults: [], noteCount: 0, tree: [], library: [], libraryCount: 0, tags: [], indexState: 'stale' };
			};

			const openDoc = async (path) => {
				try {
					const r = await fetch('/x/kb/api/doc?uri=' + encodeURIComponent(path), { credentials: 'same-origin' });
					const payload = await r.json();
					const text = payload && (payload.text ?? payload.content ?? payload.body);
					setDoc({ title: String(path).split('/').pop(), text: typeof text === 'string' ? text : (payload && payload.error) || '(读不到正文)' });
				} catch (e) {
					setDoc({ title: String(path).split('/').pop(), text: '读取失败：' + String((e && e.message) || e) });
				}
			};

			// ── 写操作（入参照抄 sync-kb-sideview.mjs:183-240，别自己猜字段名）──────────
			const BS = String.fromCharCode(92);
			const norm = (s) => String(s || '').split(BS).join('/');
			const relOf = (abs) => {
				const a = norm(abs);
				const root = norm(vaultRef.current.dir).replace(/\/+$/, '');
				return root && a.indexOf(root) === 0 ? a.slice(root.length).replace(/^\/+/, '') : a;
			};
			const post = (path, body) => fetch('/x/kb/api' + path, {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body || {}),
			});
			/** 写成功后**只重挂面板**（面板不像插件页那样整页 reload，否则会丢失滚动与选中）。 */
			const writeOp = (path, body) => post(path, body).then((r) => r.json()).then(async (b) => {
				if (b && b.ok === false) { window.alert('操作失败：' + (b.error || '未知错误')); return; }
				await remountRef.current?.();
			}).catch((e) => window.alert('操作失败：' + String((e && e.message) || e)));

			const actions = {
				// 视图自己弹对话框（Electron 不支持 window.prompt）
				useInlineDialogs: true,
				// 内嵌阅读：面板没有 IDE 编辑区 ⇒ 提供 loadDoc，视图据此渲染右栏正文。
				// ⚠ 2026-10-24 真机：`/api/page` 的**目录节点没有 abs**、部分叶子也可能只给 rel，
				//   直接拿 rel 去 /api/doc 会被服务端按**数据根**解析 ⇒ ENOENT（用户看到的那条错误）。
				//   ⇒ 这里做三层归一：绝对路径照用；相对路径按库根补；无扩展名再补 .md 重试。
				// 图片：交给插件的 `/api/asset`（围栏与 /api/doc 同源）
				assetUrl: (abs) => '/x/kb/api/asset?uri=' + encodeURIComponent(abs),
				loadDoc: async (p) => {
					const raw = String(p || '');
					const base = String(vaultRef.current.dir || '').replace(/\\/g, '/').replace(new RegExp('/+$'), '');
					const isAbs = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/');
					const fetchDoc = async (uri) => {
						const r = await fetch('/x/kb/api/doc?uri=' + encodeURIComponent(uri), { credentials: 'same-origin' });
						const payload = await r.json().catch(() => null);
						const t = payload && (payload.text ?? payload.content ?? payload.body);
						return { ok: typeof t === 'string', text: t, error: payload && payload.error, mtime: (payload && payload.mtime) || 0 };
					};
					const candidates = [];
					const first = isAbs ? raw : (base ? base + '/' + raw : raw);
					candidates.push(first.replace(/\\/g, '/'));
					if (!/\.[A-Za-z0-9]+$/.test(first)) { candidates.push((first + '.md').replace(/\\/g, '/')); }
					// 相对路径还可能落在「笔记/」或「库/」下 ⇒ 各补一次
					if (!isAbs) {
						candidates.push((base + '/笔记/' + raw).replace(/\\/g, '/'));
						if (!/\.[A-Za-z0-9]+$/.test(raw)) { candidates.push((base + '/笔记/' + raw + '.md').replace(/\\/g, '/')); }
					}
					let last = null;
					for (const uri of candidates) {
						last = await fetchDoc(uri);
						if (last.ok) { break; }
					}
					return {
						title: String(raw).split('/').pop().replace(/\.md$/i, ''),
						text: last && last.ok ? String(last.text) : ('读取失败：' + String((last && last.error) || '找不到该文件')),
						mtime: (last && last.mtime) || 0,
						// 文档所在目录：视图用它把 `![](相对路径)` 折成绝对路径，再走 /api/asset
						base: String(first).replace(/\\/g, '/').replace(new RegExp('/[^/]*$'), ''),
					};
				},
				// 保存正文（行内编辑 / 任务勾选）：服务端只允许写「笔记」区的 .md
				saveDoc: async (p, text, expectedMtime) => {
					const body = { uri: p, text };
					if (expectedMtime) { body.expectedMtime = expectedMtime; }
					const r = await fetch('/x/kb/api/doc', {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
					});
					return r.json().catch(() => ({ ok: false, error: '保存失败（响应不是 JSON）' }));
				},
				// 附件上传：body 直接是 File（浏览器原生），服务端按 chunk 收原始字节
				uploadAsset: async (file, docPath) => {
					const q = '?doc=' + encodeURIComponent(docPath) + '&name=' + encodeURIComponent(file.name || 'pasted.png');
					const r = await fetch('/x/kb/api/asset/upload' + q, {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': file.type || 'application/octet-stream' },
						body: file,
					});
					return r.json().catch(() => ({ ok: false, error: '上传失败（响应不是 JSON）' }));
				},
				// 备份历史 / 恢复
				listBackups: async (p) => {
					const r = await fetch('/x/kb/api/backup?doc=' + encodeURIComponent(p), { credentials: 'same-origin' });
					return r.json().catch(() => ({ ok: false, error: '读取备份失败（响应不是 JSON）' }));
				},
				restoreBackup: async (p, name) => {
					const r = await fetch('/x/kb/api/backup/restore', {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ doc: p, name }),
					});
					return r.json().catch(() => ({ ok: false, error: '恢复失败（响应不是 JSON）' }));
				},
				openNode: (p) => { void openDoc(p); },
				openLink: (p) => { void openDoc(p); },
				refresh: () => { void remountRef.current?.(); },
				// 设置面板里的「切换库」：记住目标库再重新取数（`/api/view-data?vault=`）
				switchVault: (id) => {
					vaultWantRef.current = String(id || '');
					void remountRef.current?.();
				},
				// 新建 / 本地载入库（写入 `<数据根>/.extra-vaults.json`，成功后自动切到新库）
				addVault: (mode, path, name) => {
					fetch('/x/kb/api/vault-add', {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ mode: mode, path: path, name: name }),
					}).then((r) => r.json()).then((b) => {
						if (!b || b.ok === false) { window.alert('操作失败：' + ((b && b.error) || '未知错误')); return; }
						vaultWantRef.current = String((b.vault && b.vault.id) || '');
						void remountRef.current?.();
					}).catch((e) => window.alert('操作失败：' + String((e && e.message) || e)));
				},
				// 设置：IDE 侧由宿主开 editor pane；面板侧开**二级页面**（整页 + ← 返回）
				openSettings: () => setPane('settings'),
				// 关系图谱：在面板内就地承载 `/x/kb/graph`（不跳转整壳）
				openGraph: () => { setPane('graph'); },
				// 同步飞书：走插件路由跑随包脚本（与 kb_feishu_sync 同一份实现）
				feishuSync: () => {
					window.alert('开始同步飞书…逐篇串行，可能需要几分钟，完成后会给出结果。');
					fetch('/x/kb/api/feishu-sync', { method: 'POST', credentials: 'same-origin' })
						.then((r) => r.json())
						.then((b) => {
							const tail = String((b && b.output) || '').split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
							window.alert((b && b.ok ? '同步完成' : '同步结束（有失败项，见下）') + '\n\n' + (tail || (b && b.error) || '(无输出)'));
						})
						.catch((e) => window.alert('同步失败：' + String((e && e.message) || e)));
				},
				createNote: (dir, name) => {
					const n = String(name || '').trim();
					if (n) { void writeOp('/new', { vaultId: vaultRef.current.id, kind: 'note', dir: dir || '笔记', name: n }); }
				},
				newFolder: (dir, name) => {
					const n = String(name || '').trim();
					if (n) { void writeOp('/new', { vaultId: vaultRef.current.id, kind: 'folder', dir: dir || '笔记', name: n }); }
				},
				renameNode: (p, newName) => {
					const n = String(newName || '').trim();
					if (!n) { return; }
					const rel = relOf(p);
					const segs = rel.split('/');
					const base = segs.pop() || '';
					const isMd = /\.md$/i.test(base);
					if (n === base.replace(/\.md$/i, '')) { return; }
					const to = segs.concat(n + (isMd ? '.md' : '')).join('/');
					void writeOp('/rename', { vaultId: vaultRef.current.id, from: rel, to, mode: 'move' });
				},
				deleteNode: (p) => {
					const rel = relOf(p);
					if (!rel) { return; }
					void writeOp('/delete', { vaultId: vaultRef.current.id, from: rel });
				},
				// skipConfirm：视图已弹过确认框（useInlineDialogs）⇒ 这里不再二次确认
				deleteNodes: (paths, skipConfirm) => {
					const list = (paths || []).map(relOf).filter(Boolean);
					if (!list.length) { return; }
					if (!skipConfirm && !window.confirm('删除选中的 ' + list.length + ' 项？')) { return; }
					let i = 0;
					const next = () => {
						if (i >= list.length) { void remountRef.current?.(); return; }
						const rel = list[i++];
						post('/delete', { vaultId: vaultRef.current.id, from: rel })
							.then((r) => r.json())
							.then((b) => { if (b && b.ok === false) { console.warn('[kb-workbench] 删除失败：', rel, b.error); } })
							.catch((e) => console.warn('[kb-workbench] 删除失败：', rel, e))
							.then(next);
					};
					next();
				},
				moveNodes: (froms, toFolder) => {
					const list = (froms || []).map(relOf).filter(Boolean);
					if (!list.length) { return; }
					const dirRel = relOf(toFolder).replace(/\/+$/, '');
					const jobs = list.map((rel) => ({ rel, to: dirRel + '/' + (rel.split('/').pop() || '') })).filter((j) => j.to !== j.rel);
					if (!jobs.length) { return; }
					let i = 0;
					const next = () => {
						if (i >= jobs.length) { void remountRef.current?.(); return; }
						const job = jobs[i++];
						post('/rename', { vaultId: vaultRef.current.id, from: job.rel, to: job.to, mode: 'move' })
							.then((r) => r.json())
							.then((b) => { if (b && b.ok === false) { console.warn('[kb-workbench] 移动失败：', job.rel, b.error); } })
							.catch((e) => console.warn('[kb-workbench] 移动失败：', job.rel, e))
							.then(next);
					};
					next();
				},
				// 全文检索：同源 fetch，失败返回 undefined ⇒ 组件退回"按名过滤"（不显示假空结果）
				search: (q, m) => {
					if (!q || !String(q).trim()) { return Promise.resolve([]); }
					if (m !== 'fulltext') { return Promise.resolve(undefined); }
					return fetch('/x/kb/api/search?q=' + encodeURIComponent(String(q).trim()) + '&limit=20', { credentials: 'same-origin' })
						.then((r) => r.json())
						.then((b) => {
							const raw = (b && (b.hits || b.results || b.items)) || null;
							if (!Array.isArray(raw)) { return undefined; }
							return raw.map((x) => ({
								title: String(x.title || x.name || String(x.path || x.rel || '').split('/').pop() || '').replace(/\.md$/i, ''),
								path: x.abs || x.path || x.rel || '',
								snippet: String(x.snippet || x.preview || '').replace(/\s+/g, ' ').slice(0, 110),
							})).filter((x) => !!x.path);
						})
						.catch(() => undefined);
				},
				// 标签筛选：面板没有宿主侧筛选能力 ⇒ 走全文检索（按标签名当关键词），行为可解释
				pickTag: (t) => { console.warn('[kb-workbench] 标签点击暂按关键词检索处理：' + t); },
			};

			remountRef.current = async () => {
				const data = await buildData();
				disposeRef.current?.();
				disposeRef.current = window.__KB_SIDEVIEW_MOUNT__(hostRef.current, data, actions) || null;
			};
			const remount = () => remountRef.current();

			useEffect(() => {
				let alive = true;
				(async () => {
					try {
						await loadBundle();
						if (!alive) { return; }
						await remount();
						if (alive) { setPhase('ready'); }
					} catch (e) {
						if (alive) { setPhase('error'); setError(String((e && e.message) || e)); }
					}
				})();
				return () => { alive = false; disposeRef.current?.(); disposeRef.current = null; };
			}, []);

			if (phase === 'error') {
				return h('div', { 'data-kb-workbench': 'error', style: { padding: 16, fontFamily: 'inherit' } },
					h('strong', null, '知识库加载失败'), h('div', { style: { opacity: 0.75, marginTop: 6 } }, error));
			}

			// 关系图谱：**用数据自己画**（2026-10-24）。之前用同源 iframe 承载 `/x/kb/graph`，
			//   但 iframe 属于「独立分区」模型 —— 宿主没给子框架传凭证 ⇒ 空白/不 load 都可能。
			//   ⇒ 改为读 `/x/kb/api/graph` 在本地 canvas 上跑力学与绘制：无 iframe、无额外页面依赖。
			// ⚠ 2026-10-24：面板**不再自己造右栏** —— 挂进来的视图本身会渲染左树 + 右正文
			//   （它拿到了 loadDoc ⇒ docMode）。此前两边各画一列 ⇒ 树栏与正文重叠。
			//
			// ★★ 2026-10-24（真机：图谱点「返回」后整片空白）：
			//   之前用的是「pane==='graph' 就 return 图谱组件」——那样树容器的 div 会被 React
			//   **卸载**，而挂载视图的 effect 只在首次 mount 跑一次（`[]` 依赖）⇒ 返回时新 div
			//   里没有任何东西被渲染，于是空白。
			//   ⇒ 改成**树常驻、只切 display**：视图永远不会被卸载，图谱作为兄弟节点叠上去。
			const treePane = h('div', { 'data-kb-workbench': 'panel', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontFamily: 'inherit' } },
				phase === 'loading' ? h('div', { style: { padding: 12, opacity: 0.6, fontSize: 12 } }, '正在加载…') : null,
				h('div', { ref: hostRef, 'data-kb-workbench-tree': '1', style: { flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'hidden' } }));

			// ⚠ 2026-10-24（真机：图谱只盖住面板下半部分）：
			//   上一版用 `position: fixed; inset: 0` 想让图谱覆盖整屏，但宿主的视图容器上
			//   带 `transform`（视图切换动画）⇒ **fixed 的包含块变成了那个容器**，而容器只占
			//   面板的一部分高度 ⇒ 图谱被"钉"在下半区。
			//   ⇒ 改回**面板内部绝对定位**：父容器 `position: relative` + 图谱层 `absolute inset:0`。
			//     树始终保留（不再 display:none），既提供高度、也保证返回时不需要重新挂载。
			return h('div', {
				'data-kb-workbench': 'shell',
				style: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
			},
				treePane,
				pane === 'graph' ? h('div', {
					'data-kb-graph-overlay': '1',
					style: {
						position: 'absolute', inset: 0, zIndex: 30,
						background: 'var(--vscode-sideBar-background, #252526)',
						display: 'flex', flexDirection: 'column', minHeight: 0,
					},
				}, h(KbGraph, {
					onClose: () => setPane('tree'),
					onOpen: (abs) => { setPane('tree'); void openDoc(abs); },
					vaultDir: () => vaultRef.current.dir,
					vaultId: () => vaultRef.current.id,
				})) : null,
				// ★★ 2026-10-24（真机：设置按钮点了没反应）：
				//   `openSettings` 把 pane 切成了 `'settings'`，但这里**只有 graph 一个分支**
				//   ⇒ 状态变了、画面不变，表现就是"点了没反应"。KbSettingsPage 早就写好了，
				//   却从来没被渲染过（等于死代码）。
				//   ⇒ 补上这条分支：整页覆盖（与 IDE 侧"独立 editor pane"等价），带「← 返回知识库」。
				pane === 'settings' ? h('div', {
					'data-kb-settings-overlay': '1',
					style: {
						position: 'absolute', inset: 0, zIndex: 31,
						background: 'var(--vscode-sideBar-background, #252526)',
						display: 'flex', flexDirection: 'column', minHeight: 0,
					},
				}, h(KbSettingsPage, {
					onClose: () => setPane('tree'),
					// 切库 / 建库都会重挂视图 ⇒ 顺手收起设置页，避免看到旧库的统计
					onSwitchVault: (id) => {
						vaultWantRef.current = String(id || '');
						setPane('tree');
						void remountRef.current?.();
					},
					onAddVault: (mode, path, name) => {
						if (typeof actions.addVault === 'function') { actions.addVault(mode, path, name); }
						setPane('tree');
					},
					vaultRef: vaultRef,
				})) : null);
		}

function install(ctx) {
			ctx.effect(() => {
				if (document.getElementById(STYLE_ID)) { return undefined; }
				const el = document.createElement('style');
				el.id = STYLE_ID;
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, 'vssaros-kb: workbench styles');
			// ★★ 2026-10-24（终态）：按**小红书工作台**的路线注册面板 —— 宿主 React 树槽位 +
			//   `require('react')` 共享宿主 React + 组件 props 注入。面板内部把
			//   `/x/kb/web/kbSideview.js`（与 IDE 侧栏同一份 bundle）挂到左栏，右栏做正文预览。
			//
			//   这条路线同时解决了两件事：
			//     · 编辑器用 'workbench' 表面时（`dshPluginPageEditorPane.ts:157`）能直接看到**新版 UI**
			//     · 不再依赖 iframe（子框架拿不到宿主凭证）与页面跳转（会顶掉整个壳）
			//   ⚠ 改过子块 `client.kb.js` 必须**再动一下入口 `client.js`**（守卫查 mtime，
			//     且 chunk 的 rev 取自入口文件的 mtime/size —— 不动入口会继续命中 immutable 缓存 ✗）
			ctx.inject(['desktopWorkbenches'], (c) => {
				c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, KbWorkbenchPanel), 'vssaros-kb: workbench');
			});
			return undefined;
		}

		exports.install = install;
		exports.apply = install;
		exports.inject = [];
		return module.exports;
	},
});
// 2026-10-24 (22): touch after tag filter
// 2026-10-24 (23): touch after graph/tree pane keep-alive
// 2026-10-24 (24): touch after obsidian tree replication
// 2026-10-24 (25): touch after section header redesign
// 2026-10-24 (26): touch after settings panel + vault switch
// 2026-10-24 (27): touch after graph overlay + settings parity
// 2026-10-24 (28): touch after graph overlay absolute fix
// 2026-10-24 (29): touch after graph zoom/pan/hover-labels
// 2026-10-24 (30): touch after vault dropdown + add/attach vault
// 2026-10-24 (31): touch after settings page
// 2026-10-24 (32): touch after settings pane render branch fix
// 2026-10-24 (33): touch after vault-create-by-path
// 2026-10-24 (34): touch after feishu dir-mapping UI
// 2026-10-24 (35): touch after feishu cli/spaces/log routed to dsh
// 2026-10-24 (36): touch after settings page c-is-not-defined fix
// 2026-10-24 (37): touch after feishu cli path + tag buckets
// 2026-10-24 (38): touch after custom dropdowns + dir abs
// 2026-10-24 (39): touch after spaces parser + feedback
