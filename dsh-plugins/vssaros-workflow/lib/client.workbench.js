// @vssaros/dsh-workflow — **React 工作台**（工作台重构 P3 第 1 个；doc/workbench-refactor-plan.md §5 步骤 2）。
//
// 形态与 dsh-desktop 官方工作台一致：经宿主服务 `desktopWorkbenches.register(descriptor, Component)` 注册，
// 宿主负责渲染（业务方不 createRoot）、错误边界与顶栏校验。描述符与清单 `vssaros.workbench` 同值
// （守卫 `dshPluginPackages.test.ts` 钉住）：`repository: 'vssaros:workflow'` ⇒ 身份 `vssaros/workflow`
// ⇒ dsh 窗口页签条里 `/x/workflow/` 那一条**自动**从 iframe 换成宿主渲染（workbenchNav 的 `wbIdOf`）✓。
//
// 数据只从 `/x/workflow/api/page` 取（与 SSR 页**同一份取数**：`lib/index.js` 的 `collectPageData`）⇒
// 两个界面的数字 / 筛选 / 画布永远一致 ✓（各写各的 ⇒ 迟早分叉 ✗）。
//
// 交互与旧 SSR 页**逐条对齐**（页内脚本 `WORKFLOW_SCRIPT` 的行为）：
//   · 搜索（名称 / id / 描述 / 元信息）· 排序（索引顺序 / 更新时间 / 名称）· 筛选（全部 / 有图 / 运行中 / 待整理）；
//   · 行点击 = 在画布里打开（`/api/open` ⇒ 经控制桥让 IDE 开画布）；▶ = 执行（`/api/run`）；
//   · ⤓ 导出 / 🗑 删除 / ＋新建 —— **仍未迁到 Host**，点了给原因（不假装成功 ✗）。
//   · 新增「◎ 看图」= 把某条工作流设为**页内画布预览**的目标（服务端 SVG；旧页只能看自动选中的那条）。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-workflow',
	chunk: 'client.workbench.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');
		const h = react.createElement;

		const API = '/x/workflow/api';
		// React 的 Hook 快捷名（老代码里写 `react.useState` 也一样能用 ✓）。
		const { useState, useEffect, useCallback } = react;
		/** 描述符（与清单 `vssaros.workbench` 同值 ⇒ 守卫逐项比对 ✓）。 */
		const DESCRIPTOR = {
			title: 'Workflow',
			description: '工作流：编排多步任务并查看运行进度。',
			repository: 'vssaros:workflow',
			icon: 'codicon:list-tree',
			customFrame: true,
		};
		const SORTS = [
			['order', '索引顺序'],
			['updated-desc', '更新时间（新→旧）'],
			['updated-asc', '更新时间（旧→新）'],
			['title-asc', '名称（A→Z）'],
			['title-desc', '名称（Z→A）'],
		];
		const CHIPS = [
			['all', '全部'],
			['graph', '有图'],
			['active', '运行中'],
			['warn', '待整理'],
		];

		/** 读页面数据（SSR 页与本组件同源）。 */
		async function loadPage(id) {
			const res = await fetch(API + '/page' + (id ? '?id=' + encodeURIComponent(id) : ''), { cache: 'no-store' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
			return body;
		}

		function sortRows(rows, mode) {
			const numeric = mode === 'updated-desc' || mode === 'updated-asc';
			const desc = mode === 'updated-desc' || mode === 'title-desc';
			const key = mode === 'order' ? 'order' : (mode.indexOf('title') === 0 ? 'titleKey' : 'updatedKey');
			const sorted = [...rows].sort((a, b) => {
				const av = String(a[key] || '');
				const bv = String(b[key] || '');
				if (!av && bv) { return 1; }
				if (av && !bv) { return -1; }
				if (numeric) { return (Number(av) || 0) - (Number(bv) || 0); }
				return av.localeCompare(bv, 'zh', { numeric: true });
			});
			return desc ? sorted.reverse() : sorted;
		}

		function WorkflowPanel(props) {
			const [view, setView] = react.useState({ status: 'loading', rows: [], summary: null, selected: null, canvas: null, worker: null, tools: '', root: '', errors: [], missing: '' });
			const [query, setQuery] = useState('');
			const [sort, setSort] = useState('order');
			const [chip, setChip] = useState('all');
			const [flash, setFlash] = useState('');
			const [flashError, setFlashError] = useState(false);
			const [diagOpen, setDiagOpen] = useState(false);
			const [busy, setBusy] = useState(false);
			// ★ 左右两档（2026-10-22 用户要求）：左列 = 工作流条目列表，右列 = 该条工作流的画布。
			//   `selectedId` = 右侧正在显示哪一条（默认 = 服务端自动选中的那条：节点最多的 ✓）。
			const [selectedId, setSelectedId] = useState('');
			const [canvasView, setCanvasView] = useState({ status: 'ready', selected: null, canvas: null, error: '' });

			const say = (text, isError) => { setFlash(String(text || '')); setFlashError(!!isError); };
			const reload = useCallback(async (id) => {
				setView(v => Object.assign({}, v, { status: 'loading' }));
				try {
					const body = await loadPage(id);
					setView({
						status: 'ready',
						rows: Array.isArray(body.rows) ? body.rows : [],
						summary: body.summary || null,
						selected: body.selected || null,
						canvas: body.canvas || null,
						worker: body.worker || null,
						tools: String(body.toolsRegistered || ''),
						root: String(body.root || ''),
						errors: Array.isArray(body.errors) ? body.errors : [],
						missing: String(body.missing || ''),
					});
					// 首次载入：右侧默认显示服务端选中的那一条（`?id=` 之外的自动选择 ✓）
					const picked = (body.selected && body.selected.id) || '';
					setSelectedId(picked);
					setCanvasView({ status: 'ready', selected: body.selected || null, canvas: body.canvas || null, error: '' });
				} catch (e) {
					setView(v => Object.assign({}, v, { status: 'error', rows: [] }));
					say('读取失败：' + String(e && e.message || e), true);
				}
			}, []);
			react.useEffect(() => { void reload(''); }, [reload]);

			/**
			 * 选中一条工作流 ⇒ 右侧换它的画布。
			 *
			 * 只取画布（`/api/canvas?id=`）而不是整页重取：整页会重带一遍所有行 + 摘要 ⇒ 每次点行都白搬一遍 ✗。
			 */
			const selectWorkflow = useCallback(async (id) => {
				if (!id) { return; }
				setSelectedId(id);
				setCanvasView(v => Object.assign({}, v, { status: 'loading' }));
				try {
					const res = await fetch(API + '/canvas?id=' + encodeURIComponent(id), { headers: { accept: 'application/json' } });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) {
						setCanvasView({ status: 'error', selected: null, canvas: null, error: String(body.error || '未知原因') });
						return;
					}
					setCanvasView({ status: 'ready', selected: body.selected || null, canvas: body.canvas || null, error: '' });
				} catch (e) {
					setCanvasView({ status: 'error', selected: null, canvas: null, error: String(e && e.message || e) });
				}
			}, []);

			// 筛选 + 排序（与旧页脚本同口径：先判可见、再对可见项排序 ✓）
			const visible = sortRows(view.rows.filter(row => {
				const q = String(query || '').trim().toLowerCase();
				const hitQuery = !q || String(row.search || '').indexOf(q) >= 0;
				const hitChip = chip === 'all'
					|| (chip === 'graph' && row.hasGraph === true)
					|| (chip === 'active' && row.isActive === true)
					|| (chip === 'warn' && !!row.tidy);
				return hitQuery && hitChip;
			}), sort);

			const openCanvas = async (id) => {
				say('正在在画布里打开：' + id + ' …');
				try {
					const res = await fetch(API + '/open?id=' + encodeURIComponent(id), { headers: { accept: 'application/json' } });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) { say('打开失败：' + String(body.error || '未知原因'), true); return; }
					say('已在画布里打开：' + id);
				} catch (e) { say('打开失败：' + String(e && e.message || e), true); }
			};
			const runWorkflow = async (id) => {
				say('正在执行：' + id + ' …（dsh 引擎，结果写进轨迹）');
				try {
					const res = await fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: id }) });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) { say('执行失败：' + String(body.error || '未知原因'), true); return; }
					say('执行完成：' + id + '（' + String(body.executionId || '') + '）');
				} catch (e) { say('执行失败：' + String(e && e.message || e), true); }
			};
			// 未迁到 Host 的写出入口：点了**说清原因**（不是静默失败，也不是假装成功）。
			const notMigrated = (what, why) => say(what + '还没迁到 Host：' + why, true);

			const summary = view.summary || { count: 0, active: 0, nodes: 0, withGraph: 0 };
			const edgeTotal = view.rows.reduce((sum, row) => sum + (row.edgeCount || 0), 0);
			const tidyCount = view.rows.filter(row => !!row.tidy).length;
			const workerOk = !!(view.worker && view.worker.ok);
			const workerText = view.worker
				? (workerOk
					? '可用（threadId ' + String(view.worker.threadId) + ' · 回显 ' + String(view.worker.echo) + ' · ' + String(view.worker.ms) + 'ms）'
					: '不可用：' + String(view.worker.error || '未知原因'))
				: '（还没取到）';

			let body;
			if (view.status === 'loading' && !view.rows.length) {
				body = h('p', { className: 'wb-empty', 'data-wf-state': 'loading' }, '正在读取工作流…');
			} else if (view.status === 'error') {
				body = h('p', { className: 'wb-empty', 'data-wf-state': 'error', role: 'alert' }, '读取失败：' + flash);
			} else if (!view.rows.length) {
				body = h('p', { className: 'wb-empty', 'data-wf-state': 'empty' }, '还没有工作流。');
			} else {
				body = h('div', { className: 'wb-list', 'data-wf-list': '' },
					visible.map(row => h('div', {
						key: row.id,
						className: 'wb-row' + (row.isActive ? ' is-active' : '') + (row.tidy ? ' is-warn' : '') + (row.empty ? ' is-cold' : '') + (selectedId === row.id ? ' is-selected' : ''),
						'data-open-id': row.id,
						'data-order': row.order,
						'data-title': row.titleKey,
						'data-updated': row.updatedKey,
						'data-search': row.search,
						'data-has-graph': row.hasGraph ? '1' : '0',
						'data-active': row.isActive ? '1' : '0',
						'data-warn': row.tidy ? '1' : '0',
						'data-selected': selectedId === row.id ? '1' : '0',
						role: 'button',
						tabIndex: 0,
						title: '点击：右侧显示这张工作流的画布' + (row.tidy ? ' ｜ ' + row.tidy : ''),
						onClick: () => { void selectWorkflow(row.id); },
						onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); void selectWorkflow(row.id); } },
					},
						h('div', { className: 'wb-row-l1' },
							h('span', { className: 'wb-row-name' }, row.name || row.id),
							row.isActive ? h('em', { className: 'wb-badge is-ok' }, '运行中') : null,
							row.tidy ? h('em', { className: 'wb-badge is-warn' }, '待整理') : null),
						h('div', { className: 'wb-row-l2' },
							h('code', { className: 'wb-code' }, row.id),
							h('span', { className: 'wb-row-desc' }, row.description || '（无描述）'),
							h('span', { className: 'wb-meta' }, row.nodeCount + ' 节点 · ' + row.edgeCount + ' 边'),
							h('span', { className: 'wb-meta' }, row.updatedText)),
						h('div', { className: 'wb-acts' },
							h('button', { type: 'button', title: '在编辑器区打开画布（另开一个画布页）', onClick: (ev) => { ev.stopPropagation(); void openCanvas(row.id); } }, '⧉'),
							h('button', { type: 'button', title: '执行（dsh 引擎跑这条工作流，结果写进轨迹）', onClick: (ev) => { ev.stopPropagation(); void runWorkflow(row.id); } }, '▶'),
							h('button', { type: 'button', 'aria-disabled': 'true', title: '导出 JSON —— 未迁到 Host（选文件对话框是 IDE 能力，要新的反向通道 capability）', onClick: (ev) => { ev.stopPropagation(); notMigrated('导出', '选文件对话框是 IDE 能力，需要新的反向通道 capability。'); } }, '⤓'),
							h('button', { type: 'button', 'aria-disabled': 'true', title: '删除 —— 未迁到 Host（需要一个新 Host 工具 + 审批闸）', onClick: (ev) => { ev.stopPropagation(); notMigrated('删除', '需要一个新 Host 工具 + 审批闸（现在 store.js 只有 list / read / mutate / apply）。'); } }, '🗑')))),
					visible.length ? null : h('p', { className: 'wb-empty', 'data-wf-none': '' }, '没有匹配的工作流：清空搜索，或把筛选切回「全部」。'));
			}

			// ── 右栏：画布（选中哪条就显示哪条）──────────────────────────────
			const canvasSel = canvasView.selected;
			const canvasSvg = canvasView.canvas && canvasView.canvas.svg;
			const canvasPane = h('section', { className: 'wb-pane wb-pane-right', 'data-wf-pane': 'canvas' },
				h('header', { className: 'wb-pane-hd' },
					h('span', { className: 'wb-pane-title' }, canvasSel ? (canvasSel.name || canvasSel.id) : '画布'),
					canvasSel ? h('code', { className: 'wb-pane-id' }, canvasSel.id) : null,
					h('span', { className: 'wb-spacer' }),
					canvasSel ? h('span', { className: 'wb-stat' }, canvasSel.nodes + ' 节点 · ' + canvasSel.edges + ' 边') : null),
				canvasView.status === 'loading'
					? h('p', { className: 'wb-empty', 'data-wf-canvas-state': 'loading' }, '正在画…')
					: (canvasView.status === 'error'
						? h('p', { className: 'wb-empty', 'data-wf-canvas-state': 'error', role: 'alert' }, '画不出来：' + canvasView.error)
						: (canvasSvg
							? h('div', { className: 'wb-canvas-wrap' },
								h('div', { className: 'wb-canvas', 'data-wf-canvas': canvasSel ? canvasSel.id : '', dangerouslySetInnerHTML: { __html: canvasSvg } }),
								canvasView.canvas && canvasView.canvas.dangling
									? h('p', { className: 'wb-diag' }, canvasView.canvas.dangling + ' 条边指向图外节点，未画。')
									: null)
							: h('p', { className: 'wb-empty', 'data-wf-canvas-state': 'empty' }, canvasSel ? '这个工作流没有节点图（可能只有线性步骤）。' : '还没有工作流可画。'))));

			return h('div', {
				className: 'wb wb-wf',
				'data-vssaros-page': 'workflow',
				'data-vssaros-surface': 'workbench',
				'data-vssaros-workflow-count': String(summary.count),
				'data-vssaros-workflow-active': String(summary.active),
				'data-vssaros-workflow-nodes': String(summary.nodes),
				'data-vssaros-workflow-root': String(view.root || ''),
				'data-vssaros-workflow-tools': String(view.tools || ''),
				'data-vssaros-workflow-workers': workerOk ? 'ok' : 'fail',
				'data-vssaros-workflow-worker-thread': view.worker && view.worker.threadId ? String(view.worker.threadId) : '',
				'data-wf-selected': selectedId || '',
			},
				h('header', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' },
					h('h1', { className: 'wb-title' }, 'Workflow', h('small', null, ' ' + summary.count + ' 个 · 只读')),
					h('span', { className: 'wb-spacer' }),
					h('span', { className: 'wb-stat' }, '已显示 ', h('b', { 'data-wf-shown': '' }, String(visible.length)), ' / ' + summary.count, ' · 节点 ', summary.nodes, ' · 边 ', edgeTotal, ' · 运行中 ', summary.active, ' · 待整理 ', tidyCount),
					h('button', { type: 'button', title: '刷新（重新读盘）', onClick: () => { void reload(''); } }, '⟳'),
					h('button', { type: 'button', title: '新建工作流 —— 未迁到 Host（点了说明原因）', onClick: () => notMigrated('新建工作流', 'IDE 侧由 WorkflowViewPane 建（会同时盖 presetId / agentId / workspaceId），Host 侧现在只有 workflow_apply 的写盘能力，页面还没有表单路由。') }, '＋')),
				h('div', { className: 'wb-field-row' },
					h('input', {
						type: 'search', value: query, 'data-wf-search': '', placeholder: '搜索名称 / id / 描述', 'aria-label': '搜索工作流',
						onChange: (ev) => setQuery(ev.target.value),
					}),
					h('select', { value: sort, 'data-sort-select': '', 'aria-label': '排序', onChange: (ev) => setSort(ev.target.value) },
						SORTS.map(([value, label]) => h('option', { key: value, value: value }, label)))),
				h('div', { className: 'wb-chips' },
					CHIPS.map(([value, label]) => h('button', {
						key: value, type: 'button', 'data-chip': value, className: 'wb-chip' + (chip === value ? ' active' : ''),
						onClick: () => setChip(value),
					}, label + (value === 'all' ? ' ' + summary.count : value === 'graph' ? ' ' + summary.withGraph : value === 'active' ? ' ' + summary.active : value === 'warn' ? ' ' + tidyCount : '')))),
				view.missing ? h('p', { className: 'wb-empty' }, '工作流根目录还不存在：', h('code', null, view.missing)) : null,
				view.errors.length ? h('p', { className: 'wb-diag' }, view.errors.length + ' 项读不了：' + view.errors.slice(0, 3).join('；') + (view.errors.length > 3 ? ' …' : '')) : null,
				// ★ 左右两档：左列 = 列表，右列 = 画布（点左列任一条 ⇒ 右列换它的画布 ✓）
				h('div', { className: 'wb-split', 'data-wf-layout': 'split' },
					h('section', { className: 'wb-pane wb-pane-left', 'data-wf-pane': 'list' },
						h('header', { className: 'wb-pane-hd' },
							h('span', { className: 'wb-pane-title' }, '工作流'),
							h('span', { className: 'wb-spacer' }),
							h('span', { className: 'wb-stat' }, visible.length + ' / ' + summary.count)),
						h('div', { className: 'wb-scroll' }, body)),
					canvasPane),
				h('div', { className: 'wb-foot' },
					h('button', { type: 'button', onClick: () => setDiagOpen(v => !v) }, '⚙ 自诊断' + (diagOpen ? '（收起）' : '')),
					diagOpen ? h('div', { className: 'wb-foot-body', 'data-vf-diag-body': '' },
						h('p', { className: 'wb-diag' }, '根目录 ', h('code', null, view.root), ' · 工具 ', h('code', null, view.tools)),
						h('p', { className: 'wb-diag', 'data-vssaros-workflow-worker-detail': workerText }, 'Host worker_threads：', workerText),
						h('p', { className: 'wb-diag' }, h('small', null, '这条是引擎迁移的前提：引擎要从渲染进程 worker 迁到 Host worker_threads（本版只做只读 + 自证，未迁引擎）。'))) : null,
					h('p', { className: 'wb-diag', 'data-wf-flash': '', role: flashError ? 'alert' : 'status', style: flashError ? { color: 'var(--dsw-alias-state-error-primary, #f48771)' } : null }, flash)),
				busy ? null : null);
		}

		const STYLE_ID = 'vssaros-workflow-workbench-layout';
// ★ 2026-10-22（工作台 UI 统一）：**视觉不再自己写** —— 颜色/间距/圆角/字号全在共享层
//   （宿主 `@vssaros/dsh-workbenches` 注入的 `wb-*`），这里只留**本工作台特有的布局**。
const CSS = `
.wb-wf .wb-split { align-items: stretch; }
.wb-wf .wb-canvas { min-height: 0; }
.wb-wf .wb-row { grid-template-columns: minmax(0, 1fr) auto; }
/* 2026-10-24：按**容器**响应（工作台会被塞进 320–420px 的 sideview / 右栏，@media 判不出来） */
.wb-wf { container-type: inline-size; }
@container (max-width: 860px) {
  .wb-wf .wb-split { grid-template-columns: 1fr; grid-auto-rows: minmax(0, 1fr); }
  .wb-wf .wb-toolbar { flex-wrap: wrap; row-gap: var(--wb-s1); }
}
@container (max-width: 560px) {
  .wb-wf .wb-toolbar { gap: var(--wb-s1); }
  .wb-wf .wb-row { grid-template-columns: minmax(0, 1fr); }
}
`;

function install(ctx) {
			ctx.effect(() => {
				if (document.getElementById(STYLE_ID)) { return undefined; }
				const el = document.createElement('style');
				el.id = STYLE_ID;
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, 'vssaros-workflow: workbench styles');
			// ⚠ **可选注入**（同 scheduler）：宿主服务缺席时**只是这个工作台不出现**，SSR 页照旧可用 ✓
			//   （写成静态依赖 ⇒ 宿主没装上会把整次 web boot 判失败 ✗ —— 真机踩过，见 scheduler 的注释）。
			ctx.inject(['desktopWorkbenches'], (c) => {
				c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, WorkflowPanel), 'vssaros-workflow: workbench');
			});
			return undefined;
		}

		exports.install = install;
		exports.apply = install;
		exports.inject = [];
		// 纯函数也导出：探针可以直接调它们验（与其它卡/工作台同一做法 ✓）。
		exports.sortRows = sortRows;
		return module.exports;
	},
});
