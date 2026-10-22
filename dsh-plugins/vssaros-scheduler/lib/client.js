// @vssaros/dsh-scheduler — 客户端：「定时任务」工作台（工作台重构 P1 样板，doc/workbench-refactor-plan.md §5）。
//
// 写法与 dsh-desktop 官方工作台一致：经宿主服务 `desktopWorkbenches.register(descriptor, Component)` 注册，
// 宿主负责渲染（业务方不 createRoot）、错误边界与 compact 顶栏校验。描述符与清单 `vssaros.workbench` 同值
// （守卫 `dshPluginPackages.test.ts` 钉住）。数据只从 `/x/scheduler/api/*` 取（与 SSR 页同源）。
//
// 组件：官方组件库 `@deepseek-ai/dsh-client-ui-primitives` 在 0.2.1-rc.1 的共享基座里（方案 §2 F1）⇒ 直接 require；
// 万一取不到（换了运行时）就退回原生 <button>，不让整个工作台挂掉。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-scheduler',
	factory: (require) => {
		var module = { exports: {} };
		const React = require('react');
		const h = React.createElement;
		let prim = null;
		try { prim = require('@deepseek-ai/dsh-client-ui-primitives'); } catch { prim = null; }

		const API = '/x/scheduler/api';
		const DESCRIPTOR = {
			title: '定时任务',
			description: '定时任务：按计划自动运行 Agent。',
			repository: 'vssaros:scheduler',
			icon: 'codicon:clock',
			customFrame: true,
			headerLayout: 'compact',
		};

		function Btn(props) {
			const { onClick, disabled, children, danger } = props;
			if (prim && typeof prim.Button === 'function') {
				return h(prim.Button, { onClick, disabled, size: 'small', variant: danger ? 'danger' : undefined }, children);
			}
			return h('button', { type: 'button', className: 'vssSchedBtn' + (danger ? ' danger' : ''), onClick, disabled }, children);
		}

		async function call(path, body) {
			const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
			const data = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
			if (!res.ok || data.ok === false) { throw new Error(data.error || 'HTTP ' + res.status); }
			return data;
		}

		function SchedulerPanel() {
			const [view, setView] = React.useState({ status: 'loading', entries: [], available: true, error: '' });
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState('');
			const reload = React.useCallback(async () => {
				setView(v => Object.assign({}, v, { status: 'loading' }));
				try {
					const res = await fetch(API + '/list', { cache: 'no-store' });
					const data = await res.json();
					if (!res.ok) { throw new Error(data.error || 'HTTP ' + res.status); }
					setView({ status: 'ready', entries: data.entries || [], available: data.available !== false, error: data.error || '' });
				} catch (e) {
					setView({ status: 'error', entries: [], available: true, error: String(e && e.message || e) });
				}
			}, []);
			React.useEffect(() => { void reload(); }, [reload]);

			const migrate = async () => {
				setBusy(true);
				try {
					const r = await call('/migrate');
					setNote('迁移完成：新建 ' + r.created + ' 条，跳过 ' + r.skipped + ' 条，失败 ' + r.failed.length + ' 条' + (r.failed.length ? '（' + r.failed.join('；') + '）' : ''));
				} catch (e) { setNote('迁移失败：' + (e && e.message || e)); }
				setBusy(false);
				void reload();
			};
			const remove = async (row) => {
				if (!window.confirm('删除定时任务「' + (row.title || row.id) + '」？')) { return; }
				setBusy(true);
				try { await call('/delete', { id: row.id, sessionId: row.sessionId }); setNote(''); }
				catch (e) { setNote('删除失败：' + (e && e.message || e)); }
				setBusy(false);
				void reload();
			};

			let body;
			if (view.status === 'loading' && !view.entries.length) {
				body = h('p', { className: 'vssSchedEmpty', 'data-sched-state': 'loading' }, '正在读取定时任务…');
			} else if (view.status === 'error') {
				body = h('p', { className: 'vssSchedEmpty', 'data-sched-state': 'error', role: 'alert' }, '读取失败：' + view.error);
			} else if (!view.available) {
				body = h('p', { className: 'vssSchedEmpty', 'data-sched-state': 'unavailable' }, '调度服务不可用：官方 @deepseek-ai/dsh-experimental-schedule-bundle 没装上（不影响启动，只是没有定时任务能力）。');
			} else if (!view.entries.length) {
				body = h('p', { className: 'vssSchedEmpty', 'data-sched-state': 'empty' }, '还没有定时任务。在对话里让 Agent 帮你建一个（官方 schedule_create 工具），或迁移 legacy 定义。');
			} else {
				body = h('ul', { className: 'vssSchedList', 'data-sched-state': 'ready' }, view.entries.map(row => h('li', { key: row.id, className: 'vssSchedRow', 'data-id': row.id },
					h('div', { className: 'vssSchedMain' },
						h('div', { className: 'vssSchedTitle' }, row.title || row.id),
						h('div', { className: 'vssSchedRule' }, row.ruleText)),
					h('div', { className: 'vssSchedMeta' },
						h('span', { className: 'vssSchedPill' + (row.status === 'active' ? ' on' : '') }, row.status === 'active' ? '已开启' : '未运行'),
						row.next ? h('span', { title: '下次运行（UTC）' }, '下次 ' + row.next) : null,
						row.lastDelivered ? h('span', { title: '最近投递' }, '最近 ' + row.lastDelivered) : null),
					h('div', { className: 'vssSchedOps' }, h(Btn, { onClick: () => remove(row), disabled: busy, danger: true }, '删除')))));
			}

			return h('div', { className: 'vssSched', 'data-vssaros-page': 'scheduler', 'data-vssaros-surface': 'workbench' },
				h('header', { className: 'vssSchedBar', 'data-dsh-workbench-toolbar': '' },
					h('h1', null, '定时任务'),
					h('span', { className: 'vssSchedCount' }, view.status === 'ready' && view.available ? view.entries.length + ' 条' : ''),
					h('span', { className: 'vssSchedSpacer' }),
					h(Btn, { onClick: () => void reload(), disabled: busy }, '刷新'),
					h(Btn, { onClick: migrate, disabled: busy }, '迁移 legacy 定义')),
				note ? h('p', { className: 'vssSchedNote', role: 'status' }, note) : null,
				body);
		}

		const STYLE_ID = 'vssaros-scheduler-style';
		const CSS = `
.vssSched { display:flex; flex-direction:column; gap:12px; padding:16px 20px; min-width:0; }
.vssSchedBar { display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap; }
.vssSchedBar h1 { margin:0; font-size:16px; font-weight:600; white-space:nowrap; }
.vssSchedCount { font-size:12px; opacity:.65; white-space:nowrap; }
.vssSchedSpacer { flex:1 1 auto; }
.vssSchedBtn { padding:5px 12px; border-radius:999px; font-size:12px; white-space:nowrap; cursor:pointer; }
.vssSchedBtn.danger { color:#e5484d; }
.vssSchedNote { margin:0; font-size:12px; opacity:.8; }
.vssSchedEmpty { margin:24px 0; font-size:13px; opacity:.7; line-height:1.6; }
.vssSchedList { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
.vssSchedRow { display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:12px; padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-border-default, rgba(127,127,127,.25)); min-width:0; }
.vssSchedMain { min-width:0; }
.vssSchedTitle { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vssSchedRule { font-size:12px; opacity:.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vssSchedMeta { display:flex; gap:8px; font-size:12px; opacity:.8; white-space:nowrap; }
.vssSchedPill { padding:1px 8px; border-radius:999px; background:rgba(127,127,127,.15); }
.vssSchedPill.on { background:rgba(78,201,176,.18); color:#4ec9b0; }
@container vss-workbench (max-width:760px) { .vssSchedRow { grid-template-columns:minmax(0,1fr) auto; } .vssSchedMeta { grid-column:1 / -1; grid-row:2; } }
@container vss-workbench (max-width:520px) { .vssSched { padding:12px; } .vssSchedMeta { flex-wrap:wrap; white-space:normal; } }
@container vss-workbench (max-width:320px) { .vssSchedRow { grid-template-columns:minmax(0,1fr); } .vssSchedOps { justify-self:end; } }
`;

		function apply(ctx) {
			ctx.effect(() => {
				if (document.getElementById(STYLE_ID)) { return undefined; }
				const el = document.createElement('style');
				el.id = STYLE_ID;
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, 'vssaros-scheduler: styles');
			// ⚠ **可选注入**（2026-10-22 真机报障）：把宿主服务写进静态依赖表时，宿主没装上
			//   ⇒ dsh 把整次 web boot 判失败（"Failed to load plugins / pending (waiting for service:
			//   desktopWorkbenches)"）⇒ 用户看到报错条。宿主缺席时本插件**只是不出现新界面**，SSR 页照旧可用 ✓。
			ctx.inject(['desktopWorkbenches'], (c) => {
				c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, SchedulerPanel), 'vssaros-scheduler: workbench');
			});
			return undefined;
		}

		module.exports.apply = apply;
		module.exports.inject = [];
		return module.exports;
	},
});
