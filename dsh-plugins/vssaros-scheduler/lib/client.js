// @vssaros/dsh-scheduler — 客户端：「自动化任务」工作台（2026-10-24 用户：「移除自动化任务 item，
// 将自动化任务包装成一个 自动化任务工作台，并设计工作台UI」）。
//
// 为什么要有这个工作台：官方那条「自动化任务」是**侧栏里的一个面板**（`sidebar.panellist` id=schedules），
// 面板里只有一张极简列表；而"自动化任务"本质上是**一个功能域**（建/看/删/查下次运行），
// 按产品口径它应该是一个**工作台**（和主页 / 知识库 / 代码库平级），从页签条进，而不是挤在侧栏。
// ⇒ 侧栏那行隐藏（`client.workbenchNav.js` 的 HIDDEN_LABELS），能力搬到这里。
//
// 写法与官方工作台一致：经宿主服务 `desktopWorkbenches.register(descriptor, Component)` 注册，
// 宿主负责渲染（业务方不 createRoot）、错误边界与 compact 顶栏校验。描述符与清单 `vssaros.workbench` 同值
// （守卫 `dshPluginPackages.test.ts` 钉住）。数据只从 `/x/scheduler/api/…` 取（与 SSR 页同源）。
// ⚠ 注释里**不许**写 `api` 后面紧跟斜杠加星号那种路径写法 —— 那是块注释开头，
//   会把后面的 DESCRIPTOR 整段吃掉（守卫 `run-scheduler-check.mjs` 的 strip 会误判，实测踩过）。
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
		const TITLE = '自动化任务';
		const DESCRIPTOR = {
			// ⚠ 与 package.json 的 `vssaros.workbench` 逐字同值（守卫钉住）：改一处必须改两处。
			title: TITLE,
			description: '自动化任务：按计划自动运行 Agent（建、看、删、查下次运行）。',
			repository: 'vssaros:scheduler',
			icon: 'codicon:clock',
			customFrame: true,
			headerLayout: 'compact',
		};

		function Btn(props) {
			const { onClick, disabled, children, danger, title } = props;
			if (prim && typeof prim.Button === 'function') {
				return h(prim.Button, { onClick, disabled, size: 'small', variant: danger ? 'danger' : undefined, title }, children);
			}
			return h('button', { type: 'button', className: 'wb-btn' + (danger ? ' danger' : ''), onClick, disabled, title }, children);
		}

		async function call(path, body) {
			const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
			const data = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
			if (!res.ok || data.ok === false) { throw new Error(data.error || 'HTTP ' + res.status); }
			return data;
		}

		/** 一条任务在几秒后 / 在什么时候跑（列表里那行"下次"用相对时间更好读）。 */
		function relTime(text) {
			if (!text) { return ''; }
			const t = Date.parse(text);
			if (Number.isNaN(t)) { return String(text); }
			const diff = t - Date.now();
			const min = Math.round(diff / 60000);
			if (Math.abs(min) < 1) { return '不到 1 分钟'; }
			if (Math.abs(min) < 60) { return (min > 0 ? '' : '') + Math.abs(min) + ' 分钟' + (min > 0 ? '后' : '前'); }
			const hr = Math.round(min / 60);
			if (Math.abs(hr) < 24) { return Math.abs(hr) + ' 小时' + (hr > 0 ? '后' : '前'); }
			const day = Math.round(hr / 24);
			return Math.abs(day) + ' 天' + (day > 0 ? '后' : '前');
		}

		/** 概览一格。 */
		function Stat(props) {
			return h('div', { className: 'vssSchedStat' + (props.on ? ' on' : '') },
				h('span', { className: 'vssSchedStatN' }, String(props.n)),
				h('span', { className: 'vssSchedStatL' }, props.label));
		}

		function SchedulerPanel() {
			const [view, setView] = React.useState({ status: 'loading', entries: [], available: true, error: '' });
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState('');
			const [filter, setFilter] = React.useState('all');       // all | active | other
			const [openId, setOpenId] = React.useState('');          // 详情抽屉里的任务 id

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
				if (!window.confirm('删除自动化任务「' + (row.title || row.id) + '」？行为与官方一致：只删这一条。')) { return; }
				setBusy(true);
				try { await call('/delete', { id: row.id, sessionId: row.sessionId }); setNote(''); setOpenId(''); }
				catch (e) { setNote('删除失败：' + (e && e.message || e)); }
				setBusy(false);
				void reload();
			};

			const entries = view.entries || [];
			const active = entries.filter(r => r.status === 'active');
			const other = entries.filter(r => r.status !== 'active');
			const shown = filter === 'active' ? active : filter === 'other' ? other : entries;
			const nextSoon = entries
				.map(r => ({ r, t: Date.parse(r.next || '') }))
				.filter(x => !Number.isNaN(x.t))
				.sort((a, b) => a.t - b.t)[0];

			// ── 各种"没有内容"的状态（都要说清原因，不能只显示空白 ✗）──────────────
			let body;
			if (view.status === 'loading' && !entries.length) {
				body = h('p', { className: 'wb-empty', 'data-sched-state': 'loading' }, '正在读取自动化任务…');
			} else if (view.status === 'error') {
				body = h('div', { className: 'vssSchedNotice', 'data-sched-state': 'error', role: 'alert' },
					h('div', { className: 'vssSchedNoticeT' }, '读取失败'),
					h('div', null, view.error),
					h('div', { style: { marginTop: 8 } }, h(Btn, { onClick: () => void reload(), disabled: busy }, '重试')));
			} else if (!view.available) {
				body = h('div', { className: 'vssSchedNotice', 'data-sched-state': 'unavailable' },
					h('div', { className: 'vssSchedNoticeT' }, '调度服务不可用'),
					h('div', null, '官方 @deepseek-ai/dsh-experimental-schedule-bundle 没装上 —— 不影响应用其它功能，只是没有自动化任务能力。'));
			} else if (!entries.length) {
				body = h('div', { className: 'vssSchedEmpty', 'data-sched-state': 'empty' },
					h('div', { className: 'vssSchedEmptyIco' }, '🕒'),
					// ⚠ 2026-10-24：改用共享层 `wb-title`（原本自己写的 `.vssSchedEmptyT`
					//   与它**逐字等价**：`font-size:var(--wb-f-lg)` + `font-weight:600`）⇒
					//   共享层那份还会随主题/刻度变，自己那份不会。CSS 里的重复定义已删。
					h('div', { className: 'wb-title' }, '还没有自动化任务'),
					h('div', { className: 'vssSchedEmptyD' }, '在对话里说「每天早上 9 点跑一次 XXX」，Agent 会用官方 schedule_create 建一条；也可以把旧的 agent.yaml 定义迁移过来。'),
					h('div', { className: 'vssSchedEmptyA' }, h(Btn, { onClick: migrate, disabled: busy }, '迁移 legacy 定义')));
			} else {
				body = h('ul', { className: 'wb-list vssSchedList', 'data-sched-state': 'ready' }, shown.map(row => {
					const isOpen = openId === row.id;
					return h('li', { key: row.id, className: 'vssSchedRow' + (isOpen ? ' open' : ''), 'data-id': row.id },
						h('span', { className: 'vssSchedIco', 'aria-hidden': 'true' }, '⏰'),
						h('div', { className: 'vssSchedMain' },
							h('div', { className: 'vssSchedTitle' }, row.title || row.id),
							h('div', { className: 'vssSchedRule' }, row.ruleText)),
						h('div', { className: 'vssSchedMeta' },
							h('span', { className: 'wb-badge' + (row.status === 'active' ? ' on' : '') }, row.status === 'active' ? '已启用' : '未运行'),
							row.next ? h('span', { title: '下次运行（' + row.next + '）' }, '下次 ' + relTime(row.next)) : null,
							row.lastDelivered ? h('span', { title: '最近投递（' + row.lastDelivered + '）' }, '上次 ' + relTime(row.lastDelivered)) : null),
						h('div', { className: 'wb-acts' },
							h(Btn, { onClick: () => setOpenId(isOpen ? '' : row.id) }, isOpen ? '收起' : '详情')),
						isOpen ? h('div', { className: 'vssSchedDrawer' },
							h('dl', null,
								h('dt', null, '规则'), h('dd', null, row.ruleText || '-'),
								h('dt', null, '状态'), h('dd', null, row.status === 'active' ? '已启用' : '未运行'),
								h('dt', null, '下次运行'), h('dd', null, row.next || '—'),
								h('dt', null, '最近投递'), h('dd', null, row.lastDelivered || '—'),
								h('dt', null, '所属会话'), h('dd', null, row.sessionId || '—'),
								h('dt', null, '任务 ID'), h('dd', null, row.id || '—')),
							h('div', { className: 'vssSchedDrawerA' },
								h('span', { className: 'vssSchedHint' }, '修改规则 / 暂停：在对话里让 Agent 改（官方 schedule_update），本页只做查看与删除'),
								h(Btn, { onClick: () => remove(row), disabled: busy, danger: true }, '删除')))
						: null);
				}));
			}

			return h('div', { className: 'wb wb-sched', 'data-vssaros-page': 'scheduler', 'data-vssaros-surface': 'workbench' },
				h('header', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' },
					h('h1', null, h('span', { className: 'vssSchedH1Ico', 'aria-hidden': 'true' }, '🕒'), TITLE),
					h('span', { className: 'wb-stat' },
						view.status === 'ready' && view.available ? entries.length + ' 条 · ' + active.length + ' 已启用' : ''),
					h('span', { className: 'wb-spacer' }),
					h(Btn, { onClick: migrate, disabled: busy || !view.available, title: '把 agent.yaml 里的旧定时定义迁过来' }, '迁移 legacy'),
					h(Btn, { onClick: () => void reload(), disabled: busy }, '刷新')),

				// 概览：三个数字 + 下一次（一眼看出"有没有在跑"）
				view.status === 'ready' && view.available && entries.length
					? h('div', { className: 'vssSchedStats' },
						h(Stat, { n: entries.length, label: '全部任务' }),
						h(Stat, { n: active.length, label: '已启用', on: active.length > 0 }),
						h(Stat, { n: other.length, label: '未运行' }),
						h('div', { className: 'vssSchedNext' },
							nextSoon ? h(React.Fragment, null,
								h('span', { className: 'vssSchedNextL' }, '下一次'),
								h('span', { className: 'vssSchedNextV' }, nextSoon.r.title || nextSoon.r.id),
								h('span', { className: 'vssSchedNextT' }, relTime(nextSoon.r.next)))
								: h('span', { className: 'vssSchedNextL' }, '没有已排期的任务')))
					: null,

				// 过滤（只在有任务时出现，空态下多一条没用）
				view.status === 'ready' && entries.length
					? h('div', { className: 'vssSchedFilters', role: 'tablist' },
						[['all', '全部 ' + entries.length], ['active', '已启用 ' + active.length], ['other', '未运行 ' + other.length]]
							.map(([k, label]) => h('button', {
								key: k, type: 'button', role: 'tab',
								'aria-selected': filter === k ? 'true' : 'false',
								className: 'vssSchedChip' + (filter === k ? ' on' : ''),
								onClick: () => setFilter(k),
							}, label)))
					: null,

				note ? h('p', { className: 'wb-diag', role: 'status' }, note) : null,
				body);
		}

		const STYLE_ID = 'vssaros-scheduler-layout';
		// ★ 2026-10-22（工作台 UI 统一，方案稿 §6.19）：**通用视觉交给共享层**（宿主注入的 `wb-*`），
		//   本包只补自己的排版；颜色全部走真实令牌（切暗色主题会跟着变 ✓）。
		const CSS = `
.wb-sched { gap:var(--wb-s3); }
.vssSchedH1Ico { margin-right:var(--wb-s2); opacity:.9; }
/* 概览 */
.vssSchedStats { display:flex; align-items:stretch; gap:var(--wb-s2); flex-wrap:wrap; }
.vssSchedStat { display:flex; flex-direction:column; min-width:86px; padding:var(--wb-s2) var(--wb-s3); border-radius:var(--wb-r-md); border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); }
.vssSchedStat.on { border-color:var(--dsw-alias-brand-primary, #4a8cff); }
.vssSchedStatN { font-size:20px; font-weight:600; line-height:1.15; color:var(--dsw-alias-label-primary, inherit); }
.vssSchedStat.on .vssSchedStatN { color:var(--dsw-alias-brand-primary, #4a8cff); }
.vssSchedStatL { font-size:var(--wb-f-sm); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); }
.vssSchedNext { display:flex; flex-direction:column; justify-content:center; min-width:0; padding:var(--wb-s2) var(--wb-s3); border-radius:var(--wb-r-md); border:1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.3)); }
.vssSchedNextL { font-size:var(--wb-f-sm); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); }
.vssSchedNextV { font-size:var(--wb-f-md); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vssSchedNextT { font-size:var(--wb-f-sm); color:var(--dsw-alias-brand-primary, #4a8cff); }
/* 过滤 */
.vssSchedFilters { display:flex; gap:var(--wb-s1, 4px); flex-wrap:wrap; }
.vssSchedChip { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)); background:transparent; color:var(--dsw-alias-label-secondary, inherit); border-radius:999px; padding:2px 10px; font:inherit; font-size:var(--wb-f-sm); cursor:pointer; }
.vssSchedChip:hover { background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.vssSchedChip.on { border-color:var(--dsw-alias-brand-primary, #4a8cff); color:var(--dsw-alias-brand-primary, #4a8cff); }
/* 列表 */
.vssSchedList { display:flex; flex-direction:column; gap:var(--wb-s2); }
.vssSchedRow { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto; align-items:center; gap:var(--wb-s3); padding:var(--wb-s2) var(--wb-s3); border-radius:var(--wb-r-md); border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); min-width:0; }
.vssSchedRow.open { border-color:var(--dsw-alias-brand-primary, #4a8cff); }
.vssSchedIco { font-size:15px; opacity:.85; }
.vssSchedMain { min-width:0; }
.vssSchedTitle { font-size:var(--wb-f-md); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vssSchedRule { font-size:var(--wb-f-sm); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vssSchedMeta { display:flex; gap:var(--wb-s2); font-size:var(--wb-f-sm); color:var(--dsw-alias-label-secondary, rgba(230,230,230,.8)); white-space:nowrap; }
.wb-btn.danger { color:var(--dsw-alias-state-error-primary, #e5484d); }
.wb-badge.on { color:var(--dsw-alias-state-success-primary, #4ec9b0); }
/* 详情抽屉（同一行里展开，不另开面板） */
.vssSchedDrawer { grid-column:1 / -1; margin-top:var(--wb-s2); padding-top:var(--wb-s2); border-top:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); display:flex; flex-direction:column; gap:var(--wb-s2); }
.vssSchedDrawer dl { display:grid; grid-template-columns:76px minmax(0,1fr); gap:2px var(--wb-s2); margin:0; font-size:var(--wb-f-sm); }
.vssSchedDrawer dt { color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); }
.vssSchedDrawer dd { margin:0; overflow-wrap:anywhere; color:var(--dsw-alias-label-primary, inherit); }
.vssSchedDrawerA { display:flex; align-items:center; gap:var(--wb-s2); }
.vssSchedHint { font-size:var(--wb-f-sm); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); flex:1 1 auto; min-width:0; }
/* 空态 / 提示 */
.vssSchedEmpty { display:flex; flex-direction:column; align-items:center; gap:var(--wb-s2); padding:32px var(--wb-s3); text-align:center; }
.vssSchedEmptyIco { font-size:28px; opacity:.75; }
.vssSchedEmptyD { max-width:520px; font-size:var(--wb-f-sm); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); line-height:1.6; }
.vssSchedEmptyA { margin-top:var(--wb-s1, 4px); }
.vssSchedNotice { display:flex; flex-direction:column; gap:2px; padding:var(--wb-s3); border-radius:var(--wb-r-md); border:1px solid var(--dsw-alias-state-error-primary, rgba(229,72,77,.5)); font-size:var(--wb-f-sm); }
.vssSchedNoticeT { font-weight:600; color:var(--dsw-alias-state-error-primary, #e5484d); }
/* 窄容器（工作台面板可能被压窄） */
@container vss-workbench (max-width:760px) { .vssSchedRow { grid-template-columns:auto minmax(0,1fr) auto; } .vssSchedMeta { grid-column:1 / -1; grid-row:2; } }
@container vss-workbench (max-width:520px) { .vssSchedMeta { flex-wrap:wrap; white-space:normal; } .vssSchedStats { gap:var(--wb-s1, 4px); } }
@container vss-workbench (max-width:320px) { .vssSchedRow { grid-template-columns:minmax(0,1fr); } .wb-acts { justify-self:end; } }
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
