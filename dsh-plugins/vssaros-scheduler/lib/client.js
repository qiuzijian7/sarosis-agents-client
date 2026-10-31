// CLIENT_BUILD_STAMP: 2026-10-31 self-built workbench (0.5.3: 两栏（列表+详情）+ 搜索/筛选 + 相对时间 + 规则可改 + 删除二次确认) —— 改了这个文件就把这一行也动一下（?rev 随入口 mtime 变）
// @vssaros/dsh-scheduler — 客户端入口（2026-10-31 重写：不再搬运官方 chunk）。
//
// ── 路线（用户 2026-10-31 拍板 A）──────────────────────────────────────────
// 曾有一版把官方 `@deepseek-ai/dsh-client-ui-schedule` 的 chunk（328KB）搬进来、
// 再把它的取数从 `remote.schedule` 改成同源路由 —— **那版是真能用的**（真机见过任务行）。
// 仍换成自绘的理由（与功能无关，是维护口径）：
//   · 自建引擎没有 `@Remote`，官方页的取数/字段要靠一层适配才能对上 ⇒ 两条语义并存；
//   · 官方 chunk 一升级就得重新搬运（diff 再贴一遍），自绘不受影响；
//   · 17KB vs 328KB，且字段直接是自建引擎的形状（`rule.kind` / `lastRun.at`）。
// ⚠ 若将来要回到官方页：从 git 找回 `lib/client.native.js`，并按那版的 description 改回清单。
//
// ── 视觉 ──────────────────────────────────────────────────────────────────
// 一律用共享层 `wb-*` 原语（`wb-toolbar` / `wb-title` / `wb-list` / `wb-row` / `wb-badge` / `wb-empty` …），
// 自己的类只留 `vssSched*`（创建弹窗与投递历史两块官方原语没有的）。
// ⚠ 别再回到"自带一套类名"：那会让 `check-workbench-style` 的 S6（用共享层）判红。
//
// ── 结构 ──────────────────────────────────────────────────────────────────
// 弹窗抽成独立的 `CreateDialog` 组件（而不是塞进列表的深层三元里）——
// 第一版就是那样写的，括号嵌套到 4 层，`node --check` 直接报 missing ) ✗。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-scheduler',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const react = require('react');
		const h = react.createElement;

		const WB_TITLE = '自动化任务';
		/** 与 package.json 的 `vssaros.workbench` 逐字同值（守卫钉住：改一处必须改两处）。 */
		const WB_DESCRIPTOR = {
			title: WB_TITLE,
			description: '自动化任务（自建调度）：定时/周期/一次性任务，支持触发循环（loop）与投递历史。',
			repository: 'vssaros:scheduler',
			icon: 'codicon:clock',
			customFrame: false,
			headerLayout: 'default',
			// ★ 2026-10-31（用户：「自动化任务 工作台中，不要有 浮动工具栏」）：
			//   退出宿主的 S2 浮动胶囊（AI 助手 + 外开）—— 本工作台是纯管理页，不需要它。
			floatingActions: false,
		};

		const API_LIST = '/x/scheduler/api/list';
		const API_CREATE = '/x/scheduler/api/create';
		const API_UPDATE = '/x/scheduler/api/update';
		const API_DELETE = '/x/scheduler/api/delete';
		const API_HISTORY = '/x/scheduler/api/history';
		// ★ 2026-10-31：卡片 hover 的「▶ 立即运行一次」（Host 侧 `engine.fireNow` 的路由）。
		const API_RUN = '/x/scheduler/api/run';

		const STYLE_ID = 'vssaros-scheduler-host';
		const CSS = `
.vssWbRoot { container-type: inline-size; display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; position:relative; }
.vssSchedBody { flex:1; min-height:0; overflow:auto; padding: var(--wb-s3, 12px) var(--wb-s4, 16px); }
/* ★ 2026-10-31（融合官方 UI）：左列表 + 右详情 的两栏；窄容器降级见下面的 @container */
.vssSchedSplit { flex:1 1 auto; min-height:0; display:flex; gap: var(--wb-s3, 12px); align-items:stretch; padding: var(--wb-s3, 12px) var(--wb-s4, 16px); }
.vssSchedRowMain { display:flex; flex-direction:column; gap:2px; min-width:0; }
.vssSchedRel { color: var(--dsw-alias-brand-text, #4c9aff); white-space:nowrap; }
.vssSchedEmpty { margin:auto; text-align:center; padding: var(--wb-s4, 16px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.66)); }
.vssSchedEmptyGlyph { font-size:24px; display:block; margin-bottom: var(--wb-s2, 8px); }
.vssSchedField { display:flex; flex-direction:column; gap: var(--wb-s1, 4px); min-width:0; }
.vssSchedField > label { font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.vssSchedCreateTitle { margin:0; font-size: var(--wb-f-md, 13px); font-weight:600; }
.vssSchedCreate { position:absolute; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; padding: var(--wb-s4, 16px); background: var(--dsw-alias-bg-overlay, rgba(0,0,0,.42)); }
.vssSchedCreateCard { display:flex; flex-direction:column; gap: var(--wb-s2, 8px); width:min(520px, 100%); max-height:100%; overflow:auto; padding: var(--wb-s4, 16px); border-radius: var(--wb-r-md, 10px); border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); font-size: var(--wb-f-sm, 12px); }
.vssSchedCreateRow { display:flex; flex-direction:column; gap:4px; min-width:0; }
.vssSchedCreateRow > label { font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.vssSchedCreateRow textarea { min-height:72px; resize:vertical; font-family:inherit; color:inherit; background:transparent; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: var(--wb-r-sm, 6px); padding:4px 6px; }
.vssSchedCreateRow input, .vssSchedCreateRow select { color:inherit; background:transparent; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: var(--wb-r-sm, 6px); padding:3px 6px; font-family:inherit; }
.vssSchedCreateHint { font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.vssSchedCreateErr { font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-state-error-primary, #f48771); }
.vssSchedCreateActs { display:flex; justify-content:flex-end; gap: var(--wb-s2, 8px); }
/* ★ 2026-10-31（编辑弹窗按截图）：会话式编辑器 + 三下拉 + 星期/通知行 */
.vssSchedEditor { border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: var(--wb-r-md, 10px); overflow:hidden; }
.vssSchedEditorArea { display:block; width:100%; min-height:110px; border:none; outline:none; resize:vertical; padding: var(--wb-s2, 8px); font:inherit; color:inherit; background:transparent; }
.vssSchedEditorBar { display:flex; align-items:center; gap: var(--wb-s1, 4px); padding:2px 4px; border-top:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.vssSchedEditorSp { flex:1 1 auto; }
.vssSchedEditorSub { display:flex; gap: var(--wb-s2, 8px); padding:2px 4px 6px; }
.vssSchedEditorIc { border:none; background:none; color: var(--dsw-alias-label-secondary, rgba(230,230,230,.78)); font:inherit; font-size: var(--wb-f-xs, 11px); cursor:pointer; padding:2px 6px; border-radius: var(--wb-r-sm, 6px); }
.vssSchedEditorIc:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.vssSchedEditorIc.is-warn { color: var(--dsw-alias-state-warn-primary, #e0a43a); }
.vssSchedSelects { display:grid; grid-template-columns:repeat(3, 1fr); gap: var(--wb-s2, 8px); margin-bottom: var(--wb-s2, 8px); }
.vssSchedSel { display:flex; align-items:center; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: var(--wb-r-md, 10px); padding:0 var(--wb-s2, 8px); min-width:0; }
.vssSchedSel > label { font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); white-space:nowrap; padding-right:6px; }
.vssSchedSel select { flex:1 1 auto; min-width:0; border:none; outline:none; background:transparent; font:inherit; font-size: var(--wb-f-sm, 12px); padding:8px 0; cursor:pointer; color:inherit; }
.vssSchedChips { display:flex; gap: var(--wb-s1, 4px); flex-wrap:wrap; }
.vssSchedSwitchRow { display:flex; align-items:center; gap: var(--wb-s2, 8px); font-size: var(--wb-f-sm, 12px); color: var(--dsw-alias-label-secondary, rgba(230,230,230,.78)); margin-bottom: var(--wb-s2, 8px); }
.vssSchedHist { display:flex; flex-direction:column; gap:2px; margin-top:2px; padding-left: var(--wb-s3, 12px); border-left:2px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
/* ★ 两栏撑不下（侧栏 / 右栏常见 420–760px）⇒ 上下堆叠，详情在上面那条分隔线之下 */
@container (max-width: 760px) {
	.vssSchedSplit { flex-direction:column; }
	.wb-pane-left { flex:0 0 auto; min-width:0; }
	.wb-pane-right { border-left:0; padding-left:0; border-top:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); padding-top: var(--wb-s3, 12px); }
}
/* ★ 2026-10-31（按 mockup 改版）：任务 item = 卡片网格，hover 出 ▶ / ✎ / ⋯ */
.vssSchedCards { display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap: var(--wb-s2, 8px); }
.vssSchedCard { display:flex; flex-direction:column; gap: var(--wb-s1, 4px); min-width:0; cursor:pointer; }
.vssSchedCardHd { display:flex; align-items:center; gap: var(--wb-s1, 4px); min-width:0; }
.vssSchedCardName { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* hover 才出现的三个按钮（不占密度，与截图一致） */
.vssSchedActs { display:none; align-items:center; gap:2px; margin-left:auto; }
.vssSchedCard:hover .vssSchedActs { display:flex; }
.vssSchedCard.is-menu .vssSchedActs { display:flex; }
.vssSchedIcb { min-width:22px; padding:1px 5px; line-height:1.3; font-size: var(--wb-f-xs, 11px); }
/* 启停开关（共享层没有 toggle 原语 ⇒ 自定义，走 alias 令牌） */
.vssSchedToggle { position:relative; width:30px; height:17px; flex:0 0 auto; border-radius: var(--wb-r-pill, 999px); border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background:transparent; cursor:pointer; }
.vssSchedToggle::after { content:""; position:absolute; top:2px; left:2px; width:11px; height:11px; border-radius:50%; background: var(--dsw-alias-label-secondary, rgba(230,230,230,.7)); transition:left .15s; }
.vssSchedToggle.is-on { background: var(--dsw-alias-brand-primary, #007fd4); border-color:transparent; }
.vssSchedToggle.is-on::after { left:15px; background: var(--dsw-alias-label-primary, #e6e6ea); }
.vssSchedDesc { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); flex:1 1 auto; min-height:0; }
.vssSchedCardFt { display:flex; align-items:center; gap: var(--wb-s2, 8px); font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.vssSchedCardFt .on { margin-left:auto; color: var(--dsw-alias-state-success-primary, #3fb950); }
/* ⋯ 的菜单（fixed 锚在视口坐标 ⇒ 不受祖先 overflow 裁切） */
.vssSchedMenu { position:fixed; z-index:80; display:flex; flex-direction:column; gap:2px; padding: var(--wb-s1, 4px); border-radius: var(--wb-r-md, 10px); border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: var(--dsw-alias-bg-layer-2, #25252a); box-shadow:0 8px 28px rgba(0,0,0,.4); min-width:150px; }
.vssSchedMenu button { border:none; background:none; text-align:left; padding:5px 10px; border-radius: var(--wb-r-sm, 6px); font:inherit; font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-primary, inherit); cursor:pointer; }
.vssSchedMenu button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); }
.vssSchedMenu button.is-danger { color: var(--dsw-alias-state-error-primary, #f48771); }
/* ★ S9：工作台会被塞进 320–420px 的侧栏/右栏 ⇒ 按**容器**响应，别按视口 */
@container (max-width: 420px) {
	.wb-row { flex-wrap: wrap; }
	.wb-row-l2 { flex-direction: column; align-items: flex-start; }
	.vssSchedCreateCard { width: 100%; }
	.vssSchedCards { grid-template-columns:1fr; }
	.vssSchedActs { display:flex; }
}
`;

		function maintainStyles() {
			if (document.getElementById(STYLE_ID)) { return undefined; }
			const el = document.createElement('style');
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
			return () => el.remove();
		}

		/**
		 * ★ 2026-10-31：以前裸 `res.json()` —— 接口给空 body（Host 侧 handler 抛异常被兜成 400 空）
		 *   时页面只会显示 "Unexpected end of JSON input"，真实原因完全看不见。
		 *   ⇒ 统一 no-store + 解析容错：非 JSON / 空响应 ⇒ 返回 `{ok:false,…}`，UI 显示可读原因。
		 */
		async function getJson(url, options) {
			const res = await fetch(url, { cache: 'no-store', ...options });
			const text = await res.text();
			try {
				return JSON.parse(text);
			} catch (error) {
				return {
					ok: false,
					available: false,
					entries: [],
					error: `HTTP ${res.status}，响应不是 JSON（${text ? '开头: ' + text.slice(0, 80) : '空响应'}）`,
				};
			}
		}
		const post = (url, body) => getJson(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body ?? {}),
		});

		function systemZone() {
			try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (error) { return 'UTC'; }
		}

		/** 时间戳 → 「10月31日 19:23」这样的短格式（列表里不需要秒与 ISO 的 T）。 */
		function shortWhen(value) {
			const ms = Number(value);
			if (!Number.isFinite(ms) || ms <= 0) { return '—'; }
			const d = new Date(ms);
			return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
		}

		/** 表单 → 自建 rule（字段与 Host 侧 `normalizeTask` 一致）。 @returns `{rule}` 或 `{error}`。 */
		function ruleFromForm(form) {
			const timeZone = form.timeZone || systemZone();
			if (form.ruleKind === 'daily' || form.ruleKind === 'weekly') {
				const m = /^(\d{1,2}):(\d{2})$/.exec(String(form.time ?? '').trim());
				if (!m) { return { error: '时间格式要 HH:MM' }; }
				const atMinute = Number(m[1]) * 60 + Number(m[2]);
				if (form.ruleKind === 'daily') { return { rule: { kind: 'daily', atMinute, timeZone } }; }
				const weekdays = String(form.weekdays ?? '').split(/[,，\s]+/).map(Number).filter(Number.isInteger).filter(d => d >= 0 && d <= 6);
				if (!weekdays.length) { return { error: '每周任务至少选一天（0=周日，1=周一…）' }; }
				return { rule: { kind: 'weekly', atMinute, weekdays: [...new Set(weekdays)].sort((a, b) => a - b), timeZone } };
			}
			if (form.ruleKind === 'every') {
				const seconds = Number(form.everySeconds);
				if (!Number.isInteger(seconds) || seconds < 60) { return { error: '间隔至少 60 秒' }; }
				return { rule: { kind: 'every', everySeconds: seconds, timeZone } };
			}
			if (form.ruleKind === 'once') {
				const date = String(form.date ?? '').trim();
				const time = String(form.time ?? '').trim();
				if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { return { error: '日期要 YYYY-MM-DD' }; }
				if (!/^\d{2}:\d{2}$/.test(time)) { return { error: '时间要 HH:MM' }; }
				return { rule: { kind: 'at', at: { date, time }, timeZone } };
			}
			const expression = String(form.expression ?? '').trim();
			if (!expression) { return { error: '要填 cron 表达式（分 时 日 月 周）' }; }
			return { rule: { kind: 'cron', expression, timeZone } };
		}

		/** 一行「标签 + 控件」。 */
		function field(label, control) {
			return h('div', { className: 'vssSchedCreateRow' },
				h('label', null, label),
				control);
		}

		/** 常用时刻（截图里「时间」是个下拉；回填值不在列表里就动态补一项）。 */
		const TIME_OPTIONS = ['06:00', '07:00', '08:00', '09:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '21:00', '22:00', '23:00', '23:30'];
		/** 星期 chips（值与自建引擎一致：0=周日 … 6=周六）。 */
		const WEEKDAY_CHIPS = [
			{ v: 1, label: '周一' }, { v: 2, label: '周二' }, { v: 3, label: '周三' },
			{ v: 4, label: '周四' }, { v: 5, label: '周五' }, { v: 6, label: '周六' }, { v: 0, label: '周日' },
		];
		/** 有效期（保存时折算成引擎的 `expiresAt`：相对项按当天起算）。 */
		const EXPIRY_OPTIONS = [
			{ v: '', label: '长期有效' },
			{ v: '+30d', label: '30 天' },
			{ v: '+90d', label: '90 天' },
			{ v: 'custom', label: '到指定日期' },
		];
		/** 星期 chips 的开/关（form.weekdays 是 0–6 逗号串）。 */
		function toggleWeekday(form, setField, v) {
			const set = new Set(String(form.weekdays ?? '').split(/[,，\s]+/).map(Number).filter(Number.isInteger));
			if (set.has(v)) { set.delete(v); } else { set.add(v); }
			setField('weekdays', [...set].sort((a, b) => a - b).join(','));
		}

		/** 新建/编辑弹窗（独立组件：不嵌进列表的深层三元里，括号才不会套到 4 层）。 */
		function CreateDialog(props) {
			const form = props.form;
			const setField = props.setField;
			// 编辑器/工作区/权限这些按钮在自建引擎里没有对应能力 ⇒ 占位：点了给一句说明，不静默。
			const note = props.onNote || (() => undefined);
			const weekdaySet = new Set(String(form.weekdays ?? '').split(/[,，\s]+/));
			const timeChoices = TIME_OPTIONS.includes(form.time) ? TIME_OPTIONS : [form.time, ...TIME_OPTIONS];
			const rows = [
				field('名称', h('input', { type: 'text', value: form.title, onChange: (ev) => setField('title', ev.target.value) })),
			];
			// ── 会话式编辑器（截图同款：大文本 + 工具条 + 工作区/权限行；装饰按钮点了给说明）──
			rows.push(h('div', { className: 'vssSchedEditor' },
				h('textarea', {
					className: 'vssSchedEditorArea', value: form.prompt,
					placeholder: '到点要 agent 做什么 —— 像写会话一样描述：步骤、输出格式、保存位置…',
					onChange: (ev) => setField('prompt', ev.target.value),
				}),
				h('div', { className: 'vssSchedEditorBar' },
					h('button', { type: 'button', className: 'vssSchedEditorIc', title: '附件（占位）', onClick: () => note('附件：未接线') }, '＋'),
					h('span', { className: 'vssSchedEditorSp' }),
					h('button', { type: 'button', className: 'vssSchedEditorIc', title: '模型选择（占位）', onClick: () => note('模型选择：未接线') }, '✨ Auto ▾'),
					h('button', {
						type: 'button', className: 'vssSchedEditorIc', title: '先保存修改，再用卡片 hover 的 ▶ 运行一次',
						onClick: () => note('试运行：先保存修改，再用卡片 hover 的 ▶ 运行一次'),
					}, '➤')),
				h('div', { className: 'vssSchedEditorSub' },
					h('button', { type: 'button', className: 'vssSchedEditorIc', onClick: () => note('工作区：未接线') }, '📁 工作区 ▾'),
					h('button', {
						type: 'button', className: 'vssSchedEditorIc is-warn',
						onClick: () => note('访问权限：由 item 会话的 allowTools 白名单管，这里暂不可调'),
					}, '⚠ 允许完全访问 ▾'))));
			// ── 三下拉（截图同款）：重复 / 时间 / 有效期 ──
			rows.push(h('div', { className: 'vssSchedSelects' },
				h('div', { className: 'vssSchedSel' },
					h('label', null, '重复：'),
					h('select', { value: form.ruleKind, 'aria-label': '重复规则', onChange: (ev) => setField('ruleKind', ev.target.value) },
						h('option', { value: 'daily' }, '每天'),
						h('option', { value: 'weekly' }, '每周'),
						h('option', { value: 'every' }, '固定间隔'),
						h('option', { value: 'once' }, '仅一次'),
						h('option', { value: 'cron' }, 'Cron 表达式'))),
				(form.ruleKind === 'daily' || form.ruleKind === 'weekly' || form.ruleKind === 'once')
					? h('div', { className: 'vssSchedSel' },
						h('label', null, '时间：'),
						h('select', { value: form.time, 'aria-label': '时间', onChange: (ev) => setField('time', ev.target.value) },
							timeChoices.map((t) => h('option', { key: t, value: t }, t))))
					: null,
				h('div', { className: 'vssSchedSel' },
					h('label', null, '有效期：'),
					h('select', { value: form.expiry, 'aria-label': '有效期', onChange: (ev) => setField('expiry', ev.target.value) },
						EXPIRY_OPTIONS.map((o) => h('option', { key: o.v, value: o.v }, o.label))))));
			if (form.ruleKind === 'weekly') {
				rows.push(h('div', { className: 'vssSchedCreateRow' },
					h('label', null, '星期'),
					h('div', { className: 'vssSchedChips' }, WEEKDAY_CHIPS.map((w) => h('button', {
						type: 'button',
						className: weekdaySet.has(String(w.v)) ? 'wb-chip is-active' : 'wb-chip',
						onClick: () => toggleWeekday(form, setField, w.v),
					}, w.label)))));
			}
			if (form.ruleKind === 'every') {
				rows.push(field('间隔秒数（≥60）', h('input', { type: 'text', value: form.everySeconds, onChange: (ev) => setField('everySeconds', ev.target.value) })));
			}
			if (form.ruleKind === 'once') {
				rows.push(field('日期（YYYY-MM-DD）', h('input', { type: 'text', value: form.date, onChange: (ev) => setField('date', ev.target.value) })));
			}
			if (form.ruleKind === 'cron') {
				rows.push(field('Cron（分 时 日 月 周）', h('input', { type: 'text', value: form.expression, onChange: (ev) => setField('expression', ev.target.value) })));
			}
			if (form.expiry === 'custom') {
				rows.push(field('到期日期（到点自动停用）', h('input', { type: 'date', value: form.expiryDate, onChange: (ev) => setField('expiryDate', ev.target.value) })));
			}
			rows.push(field('做什么', h('select', { value: form.kind, onChange: (ev) => setField('kind', ev.target.value) },
				h('option', { value: 'loop' }, '触发一个循环（loop）'),
				h('option', { value: 'prompt' }, '往会话投一句话'))));
			if (form.kind === 'loop') {
				rows.push(field('循环名（loop_list 里的名字）', h('input', { type: 'text', value: form.loopName, onChange: (ev) => setField('loopName', ev.target.value) })));
			} else {
				rows.push(field('会话 id（可选；不填则只记录不投递）', h('input', { type: 'text', value: form.sessionId, onChange: (ev) => setField('sessionId', ev.target.value) })));
			}
			// ── 通知开关（截图同款）──
			rows.push(h('div', { className: 'vssSchedSwitchRow' },
				h('span', null, '消息推送到企业微信'),
				h('button', {
					type: 'button',
					className: 'vssSchedToggle' + (form.notify ? ' is-on' : ''),
					'aria-label': '消息推送到企业微信',
					onClick: () => setField('notify', !form.notify),
				})));
			rows.push(h('div', { className: 'vssSchedCreateHint' }, `时区：${form.timeZone || systemZone()}`));
			if (props.err) {
				rows.push(h('div', { className: 'vssSchedCreateErr' }, props.err));
			}
			rows.push(h('div', { className: 'vssSchedCreateActs' },
				h('button', { type: 'button', className: 'wb-link', onClick: props.onCancel }, '取消'),
				h('button', {
					type: 'button', className: 'wb-link', 'data-vssaros-scheduler-submit': '1', onClick: props.onSubmit,
				}, props.submitLabel || '创建')));

			return h('div', { className: 'vssSchedCreate', 'data-vssaros-scheduler-dialog': '1' },
				h('div', { className: 'vssSchedCreateCard' },
					h('div', { className: 'wb-pane-title' }, props.title || '新建自动化任务'),
					rows));
		}

		/**
		 * 「x 小时后 / x 天后」—— 官方那句相对时间比裸的绝对时间好读，两条一起给。
		 * @returns 相对文案；解析不了给空串（调用方退化成只显示绝对时间）。
		 */
		/** 时间归一：列表给 ISO 字符串、投递记录给**数字**时间戳（两种都要认，否则显示成 `—`）。 */
		function toMs(value) {
			if (typeof value === 'number' && Number.isFinite(value)) { return value; }
			const at = Date.parse(value);
			return Number.isFinite(at) ? at : NaN;
		}
		function relativeWhen(iso) {
			const at = toMs(iso);
			if (!Number.isFinite(at)) { return ''; }
			const diff = at - Date.now();
			const abs = Math.abs(diff);
			if (abs < 60_000) { return '即将'; }
			const suffix = diff >= 0 ? '后' : '前';
			const minutes = Math.round(abs / 60_000);
			if (minutes < 60) { return `${minutes} 分钟${suffix}`; }
			const hours = Math.round(minutes / 60);
			if (hours < 24) { return `${hours} 小时${suffix}`; }
			return `${Math.round(hours / 24)} 天${suffix}`;
		}
		/** 绝对时间（本地）：`YYYY-MM-DD HH:mm`。 */
		function absoluteWhen(iso) {
			const at = toMs(iso);
			if (!Number.isFinite(at)) { return '—'; }
			const d = new Date(at);
			const pad = (n) => String(n).padStart(2, '0');
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}
		/** `atMinute` → `HH:mm`（详情里编辑用）。 */
		function clockOfMinute(atMinute) {
			const value = Number(atMinute);
			const minutes = Number.isFinite(value) ? Math.min(24 * 60 - 1, Math.max(0, Math.trunc(value))) : 0;
			const pad = (n) => String(n).padStart(2, '0');
			return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
		}
		/** 状态筛选（官方口径：全部 / 已开启 / 已结束）。 */
		const STATUS_FILTERS = [
			{ key: 'all', label: '全部' },
			{ key: 'active', label: '已开启' },
			{ key: 'ended', label: '已结束' },
		];
		/** 详情里的规则种类（与自建引擎 `rule.kind` 同名）。 */
		const RULE_LABELS = {
			daily: '每天', weekly: '每周', every: '固定间隔', at: '仅一次', cron: 'Cron 表达式',
		};

		function Schedules() {
			const [state, setState] = react.useState({ loading: true, available: false, entries: [], error: '' });
			const [creating, setCreating] = react.useState(false);
			const [form, setForm] = react.useState({
				title: '', ruleKind: 'daily', time: '09:00', weekdays: '1', everySeconds: '3600',
				date: '', expression: '', kind: 'loop', loopName: '', prompt: '', sessionId: '', timeZone: systemZone(),
				// ★ 2026-10-31（编辑弹窗按截图）：有效期（''=长期 / '+30d' / '+90d' / 'custom'）与企微推送开关。
				notify: false, expiry: '', expiryDate: '',
			});
			const [err, setErr] = react.useState('');
			// ★ 2026-10-31（融合官方 UI）：搜索 / 状态筛选 / 选中项 / 详情页签 / 规则草稿 / 投递记录 / 删除确认。
			const [search, setSearch] = react.useState('');
			const [statusFilter, setStatusFilter] = react.useState('all');
			const [selectedId, setSelectedId] = react.useState('');
			const [tab, setTab] = react.useState('rule');
			const [draft, setDraft] = react.useState(null);
			const [records, setRecords] = react.useState([]);
			const [pendingDelete, setPendingDelete] = react.useState('');
			const [saving, setSaving] = react.useState(false);
			// ★ 2026-10-31（卡片网格版）：主页签、全局运行记录、hover 菜单、编辑中的任务 id。
			const [mainTab, setMainTab] = react.useState('tasks');
			const [allRecords, setAllRecords] = react.useState([]);
			const [recordsFilterId, setRecordsFilterId] = react.useState('');
			const [menuFor, setMenuFor] = react.useState('');
			const [menuPos, setMenuPos] = react.useState({ left: 0, top: 0 });
			const [editingId, setEditingId] = react.useState('');

			const reload = react.useCallback(() => {
				getJson(API_LIST).then((data) => {
					setState({ loading: false, available: !!data?.available, entries: data?.entries ?? [], error: data?.error ?? '' });
				}).catch((error) => {
					setState({ loading: false, available: false, entries: [], error: String(error?.message ?? error) });
				});
			}, []);
			react.useEffect(() => { reload(); }, [reload]);

			/** 搜索 + 状态筛选后的可见行（官方这两条在任务一多时是刚需）。 */
			const keyword = search.trim().toLowerCase();
			const visible = (state.entries ?? []).filter((e) => {
				if (statusFilter === 'active' && e.status !== 'active') { return false; }
				if (statusFilter === 'ended' && e.status === 'active') { return false; }
				if (!keyword) { return true; }
				return String(e.title ?? '').toLowerCase().includes(keyword)
					|| String(e.ruleText ?? '').toLowerCase().includes(keyword);
			});
			/** 选中的任务（没选就落在第一条上 ⇒ 详情不会空着）。 */
			const selected = visible.find(e => e.id === selectedId) ?? visible[0] ?? null;

			// 选中项一变 ⇒ 规则草稿重新起一份（`/api/list` 给的是官方扁平字段：kind/time/timeZone/…）。
			react.useEffect(() => {
				if (!selected) { setDraft(null); return; }
				setDraft({
					kind: String(selected.kind ?? 'daily'),
					time: String(selected.time ?? clockOfMinute(selected.atMinute) ?? '09:00').slice(0, 5),
					timeZone: String(selected.timeZone ?? ''),
					weekdays: Array.isArray(selected.weekdays) ? selected.weekdays : [],
					everySeconds: selected.everySeconds,
					expression: String(selected.expression ?? ''),
				});
				setRecords([]);
				setTab('rule');
			}, [selected && selected.id]);

			function setField(key, value) { setForm(prev => ({ ...prev, [key]: value })); }
			function setDraftField(key, value) { setDraft(prev => (prev ? { ...prev, [key]: value } : prev)); }

			/** 打开编辑弹窗（把列表给的**官方扁平字段**回填成表单；没有该任务 ⇒ 当新建）。 */
			function openEdit(id) {
				const t = (state.entries ?? []).find((x) => x.id === id);
				if (t) {
					setForm({
						title: String(t.title ?? ''),
						ruleKind: String(t.kind ?? 'daily'),
						time: String(t.time ?? '09:00').slice(0, 5),
						// 列表给的是官方 ISO 星期（1=周一…7=周日），表单要自建的 0–6 ⇒ 7 → 0。
						weekdays: (t.weekdays ?? []).map((d) => String(Number(d) % 7)).join(','),
						everySeconds: String(t.everySeconds ?? 3600),
						date: t.expiresAt ? t.expiresAt.slice(0, 10) : '',
						expression: String(t.expression ?? ''),
						kind: 'prompt',
						loopName: '',
						prompt: String(t.prompt ?? ''),
						sessionId: String(t.sessionId ?? ''),
						timeZone: String(t.timeZone ?? systemZone()),
						// ★ 编辑回填：有 expiresAt ⇒ 「到指定日期」（日期取当天口径）。
						notify: t.notify === true,
						expiry: t.expiresAt ? 'custom' : '',
						expiryDate: t.expiresAt ? t.expiresAt.slice(0, 10) : '',
					});
					setEditingId(id);
				} else {
					setForm({
						title: '', ruleKind: 'daily', time: '09:00', weekdays: '1', everySeconds: '3600',
						date: '', expression: '', kind: 'prompt', loopName: '', prompt: '', sessionId: '', timeZone: systemZone(),
						notify: false, expiry: '', expiryDate: '',
					});
					setEditingId('');
				}
				setErr('');
				setCreating(true);
			}
			/** ▶ 立即运行一次（Host 侧 engine.fireNow；会写一条 manual 投递记录）。 */
			async function runNow(id) {
				const out = await post(API_RUN, { id });
				if (!out?.ok) { setErr(out?.error ? `运行失败：${out.error}` : '运行失败'); return; }
				reload();
			}
			/** 运行记录页签：不传 id ⇒ 全部任务的投递记录。 */
			async function loadAllRecords() {
				const data = await getJson(API_HISTORY);
				setAllRecords(data?.records ?? []);
			}

			async function submit() {
				setErr('');
				const parsed = ruleFromForm(form);
				if (parsed.error) { setErr(parsed.error); return; }
				// ★ 2026-10-31：有效期折算成引擎的 `expiresAt`（相对项从当下起算；custom 必须给日期）。
				let expiresAt = '';
				if (form.expiry === '+30d') { expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString(); }
				else if (form.expiry === '+90d') { expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString(); }
				else if (form.expiry === 'custom') {
					if (!form.expiryDate) { setErr('选了「到指定日期」要给出日期'); return; }
					expiresAt = new Date(`${form.expiryDate}T23:59:59`).toISOString();
				}
				const notify = form.notify === true;
				// ★ 编辑既有任务：走 /api/update（Host 侧 updateSchedule 现在也认 prompt/expiresAt/notify）
				if (editingId) {
					const out = await post(API_UPDATE, {
						id: editingId,
						title: form.title || '未命名任务',
						rule: parsed.rule,
						prompt: String(form.prompt ?? '').trim(),
						expiresAt,
						notify,
					});
					if (!out?.ok) { setErr(out?.error ?? '保存失败'); return; }
					setCreating(false);
					setEditingId('');
					reload();
					return;
				}
				// ★ 编辑既有任务：走 /api/update（Host 侧 updateSchedule 现在也认 prompt）
				if (editingId) {
					const out = await post(API_UPDATE, {
						id: editingId,
						title: form.title || '未命名任务',
						rule: parsed.rule,
						prompt: String(form.prompt ?? '').trim(),
					});
					if (!out?.ok) { setErr(out?.error ?? '保存失败'); return; }
					setCreating(false);
					setEditingId('');
					reload();
					return;
				}
				const body = { title: form.title || '未命名任务', kind: form.kind, rule: parsed.rule };
				if (form.kind === 'loop') {
					if (!form.loopName.trim()) { setErr('触发循环要填循环名（见 loop_list）'); return; }
					body.loopName = form.loopName.trim();
				} else {
					if (!form.prompt.trim()) { setErr('prompt 型要填内容'); return; }
					body.prompt = form.prompt.trim();
					if (form.sessionId.trim()) { body.sessionId = form.sessionId.trim(); }
				}
				// ★ 有效期 / 企微推送（编辑弹窗新字段）。
				body.expiresAt = expiresAt;
				body.notify = notify;
				const out = await post(API_CREATE, body);
				if (!out?.ok) { setErr(out?.error ?? '创建失败'); return; }
				setCreating(false);
				reload();
			}

			async function act(id, next) { await post(API_UPDATE, { id, status: next }); reload(); }
			async function remove(id) {
				setPendingDelete('');
				setSelectedId('');
				await post(API_DELETE, { id });
				reload();
			}
			/** 打开「任务运行记录」页签时才取（与官方同：按需加载）。 */
			async function openRecords() {
				setTab('records');
				if (!selected) { return; }
				const data = await getJson(`${API_HISTORY}?id=${encodeURIComponent(selected.id)}&limit=50`);
				setRecords(data?.records ?? []);
			}
			/**
			 * 保存规则：草稿 → 自建引擎的 rule（`{kind, atMinute, timeZone, weekdays…}`）。
			 * 官方的 `at`（仅一次）在列表里没有日期字段 ⇒ 改不了时间 ⇒ 明确禁用并说明。
			 */
			async function saveRule() {
				if (!selected || !draft) { return; }
				setSaving(true);
				const m = /^(\d{1,2}):(\d{2})$/.exec(String(draft.time ?? '').trim());
				const atMinute = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
				const zone = draft.timeZone || systemZone();
				let rule = null;
				if (draft.kind === 'daily') { rule = { kind: 'daily', atMinute, timeZone: zone }; }
				else if (draft.kind === 'weekly') {
					// 官方 weekdays 是 ISO（1=周一…7=周日），自建是 JS 约定（0=周日）⇒ 7 → 0。
					rule = { kind: 'weekly', atMinute, weekdays: (draft.weekdays ?? []).map(d => Number(d) % 7), timeZone: zone };
				}
				else if (draft.kind === 'every') { rule = { kind: 'every', everySeconds: Number(draft.everySeconds ?? 3600), timeZone: zone }; }
				else if (draft.kind === 'cron') { rule = { kind: 'cron', expression: String(draft.expression ?? ''), timeZone: zone }; }
				if (!rule) { setErr('一次性任务不支持改时间（缺少日期字段），请删除后重建'); setSaving(false); return; }
				const out = await post(API_UPDATE, { id: selected.id, rule });
				setSaving(false);
				if (!out?.ok) { setErr(out?.error ?? '保存失败'); return; }
				setErr('');
				reload();
			}

			const root = {
				className: 'wb vssWbRoot',
				'data-vssaros-page': 'scheduler',
				'data-vssaros-surface': 'workbench',
				'data-sched-state': state.loading ? 'loading' : (state.available ? 'ready' : 'unavailable'),
			};
			const toolbar = h('div', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' },
				h('h1', { className: 'wb-title' }, WB_TITLE),
				h('span', { className: 'wb-sub', 'data-sched-count': String(state.entries.length) }, `${state.entries.length} 个`),
				h('span', { className: 'wb-spacer' }),
				h('div', { className: 'wb-acts' },
					h('button', { type: 'button', className: 'wb-link', onClick: reload }, '刷新'),
					h('button', { type: 'button', className: 'wb-link', 'data-vssaros-scheduler-create': '1', onClick: () => openEdit('') }, '新建')));

			// ── 任务卡片网格（2026-10-31 按 mockup 改版：item = 卡片，hover 出 ▶ / ✎ / ⋯）─────
			let grid = null;
			if (state.loading) {
				grid = h('div', { className: 'wb-empty' }, '载入中…');
			} else if (!state.available) {
				grid = h('div', { className: 'wb-empty' }, '调度引擎不可用：' + (state.error || '未知原因') + '（不影响其它功能）');
			} else if (visible.length === 0) {
				grid = h('div', { className: 'vssSchedEmpty', 'data-sched-empty': state.entries.length === 0 ? 'none' : 'filtered' },
					h('span', { className: 'vssSchedEmptyGlyph' }, '🕒'),
					h('h2', null, state.entries.length === 0 ? '还没有自动化任务' : '没有匹配的自动化任务'),
					h('div', { className: 'wb-empty' }, '点「新建自动化任务」，或让 Agent 用 schedule_create 帮你建。'),
					h('button', { type: 'button', className: 'wb-btn is-primary', onClick: () => openEdit('') }, '新建自动化任务'));
			} else {
				grid = h('div', { className: 'vssSchedCards', 'data-sched-cards': String(visible.length) }, visible.map((e) => {
					const on = e.status === 'active';
					const rel = relativeWhen(e.scheduledAt);
					return h('div', {
						className: 'wb-card vssSchedCard' + (menuFor === e.id ? ' is-menu' : ''),
						key: e.id,
						'data-sched-id': e.id,
						onClick: () => { openEdit(e.id); },
					},
						h('div', { className: 'vssSchedCardHd' },
							h('span', { className: 'wb-row-name vssSchedCardName' }, e.title || '(未命名)'),
							h('div', { className: 'vssSchedActs' },
								h('button', {
									type: 'button', className: 'wb-btn is-icon is-ghost vssSchedIcb', title: '立即运行一次',
									'data-sched-act': 'run',
									onClick: (ev) => { ev.stopPropagation(); runNow(e.id); },
								}, '▶'),
								h('button', {
									type: 'button', className: 'wb-btn is-icon is-ghost vssSchedIcb', title: '编辑',
									'data-sched-act': 'edit',
									onClick: (ev) => { ev.stopPropagation(); openEdit(e.id); },
								}, '✎'),
								h('button', {
									type: 'button', className: 'wb-btn is-icon is-ghost vssSchedIcb', title: '更多',
									'data-sched-act': 'more',
									onClick: (ev) => {
										ev.stopPropagation();
										const rect = ev.currentTarget.getBoundingClientRect();
										setMenuFor(menuFor === e.id ? '' : e.id);
										setMenuPos({ left: Math.min(rect.left, Math.max(0, (window.innerWidth || 1200) - 180)), top: rect.bottom + 6 });
									},
								}, '⋯')),
							h('button', {
								type: 'button', className: 'vssSchedToggle' + (on ? ' is-on' : ''),
								'aria-label': on ? '停用' : '启用', 'data-sched-act': 'toggle',
								onClick: (ev) => { ev.stopPropagation(); act(e.id, on ? 'inactive' : 'active'); },
							})),
						// ⚠ 别拿 ruleText 兜底：底部那行已经是规则文本，兜底会显示成两遍。
						h('div', { className: 'vssSchedDesc' }, e.prompt || '（这条任务没写内容）'),
						h('div', { className: 'vssSchedCardFt' },
							h('span', null, e.ruleText ?? ''),
							rel ? h('span', { className: 'vssSchedRel' }, rel) : null,
							h('span', { className: on ? 'on' : '' }, on ? '已启用' : '已停用')));
				}));
			}

			// ── 运行记录（页签二）：/api/history 不传 id ⇒ 全部任务的投递记录 ──
			const nameOf = (id) => (state.entries ?? []).find((x) => x.id === id)?.title ?? id;
			const shownRecords = recordsFilterId ? allRecords.filter((r) => r.taskId === recordsFilterId) : allRecords;
			let recordsView = null;
			if (shownRecords.length === 0) {
				recordsView = h('div', { className: 'wb-empty' }, '还没有运行记录。');
			} else {
				recordsView = h('table', { className: 'wb-table', 'data-sched-records': recordsFilterId || 'all' },
					h('thead', null, h('tr', null,
						h('th', null, '时间'), h('th', null, '任务'), h('th', null, '轮次'), h('th', null, '来源'))),
					h('tbody', null, shownRecords.map((r, i) => h('tr', { key: `${r.taskId ?? i}#${r.seq ?? i}` },
						h('td', null, absoluteWhen(r.at)),
						h('td', null, nameOf(r.taskId)),
						h('td', null, `#${r.seq ?? ''}`),
						h('td', null, r.manual ? '手动' : '自动')))));
			}

			const tabs = h('div', { className: 'wb-tabs', 'data-sched-tabs': mainTab },
				h('button', {
					type: 'button', className: mainTab === 'tasks' ? 'wb-tab is-active' : 'wb-tab',
					onClick: () => { setMainTab('tasks'); setMenuFor(''); },
				}, '定时任务'),
				h('button', {
					type: 'button', className: mainTab === 'records' ? 'wb-tab is-active' : 'wb-tab',
					onClick: () => { setMainTab('records'); setMenuFor(''); loadAllRecords(); },
				}, '运行记录'));

			const children = [tabs, toolbar, h('div', { className: 'wb-scroll vssSchedBody' },
				mainTab === 'tasks'
					? h('div', { className: 'wb-field-row' },
						h('input', {
							className: 'wb-input', type: 'search', value: search, placeholder: '搜索自动化任务',
							'aria-label': '搜索自动化任务', 'data-sched-search': '',
							onChange: (ev) => setSearch(ev.target.value),
						}),
						search
							? h('button', { type: 'button', className: 'wb-btn is-icon', 'aria-label': '清空搜索', onClick: () => setSearch('') }, '✕')
							: null,
						h('div', { className: 'wb-chips' }, STATUS_FILTERS.map((f) => h('button', {
							key: f.key, type: 'button',
							className: statusFilter === f.key ? 'wb-chip is-active' : 'wb-chip',
							'data-sched-filter': f.key,
							onClick: () => setStatusFilter(f.key),
						}, f.label))))
					: (recordsFilterId
						? h('div', { className: 'wb-field-row' },
							h('span', { className: 'wb-diag' }, `只看：${nameOf(recordsFilterId)}`),
							h('button', { type: 'button', className: 'wb-btn is-icon', onClick: () => setRecordsFilterId('') }, '✕'))
						: null),
				mainTab === 'tasks' ? grid : recordsView)];
			if (creating) {
				children.push(h(CreateDialog, {
					form,
					setField,
					err,
					title: editingId ? '编辑自动化任务' : '新建自动化任务',
					submitLabel: editingId ? '保存修改' : '创建',
					// 编辑器里的装饰按钮（＋/Auto/📁/⚠）没有真实能力 ⇒ 点了给一句说明，不静默。
					onNote: (msg) => setErr(msg),
					onCancel: () => { setCreating(false); setEditingId(''); },
					onSubmit: submit,
				}));
			}
			// ⋯ hover 菜单（查看运行记录 / 定位会话 / 删除）
			if (menuFor) {
				const target = visible.find((x) => x.id === menuFor);
				children.push(h('div', {
					className: 'vssSchedMenu', style: { left: `${menuPos.left}px`, top: `${menuPos.top}px` },
					'data-sched-menu': menuFor,
				},
					h('button', {
						type: 'button',
						onClick: () => {
							setRecordsFilterId(menuFor);
							setMainTab('records');
							setMenuFor('');
							loadAllRecords();
						},
					}, '查看运行记录'),
					target && target.sessionId
						? h('button', {
							type: 'button',
							onClick: () => { setMenuFor(''); setMainTab('tasks'); setSearch(String(target.sessionId)); },
						}, '打开任务（按会话定位）')
						: null,
					h('button', {
						type: 'button', className: 'is-danger',
						onClick: () => { setMenuFor(''); setPendingDelete(menuFor); },
					}, '删除')));
			}
			// ★ 删除二次确认（取自官方：说明后果 + 显式确认，避免误删无法挽回）
			if (pendingDelete) {
				children.push(h('div', { className: 'vssSchedCreate', 'data-sched-confirm': pendingDelete },
					h('div', { className: 'vssSchedCreateCard' },
						h('h2', { className: 'vssSchedCreateTitle' }, '删除此任务？'),
						h('div', { className: 'vssSchedCreateHint' }, '任务将停止触发，并连同它的运行记录一起删除。原会话及其消息仍然保留。'),
						h('div', { className: 'vssSchedCreateActs' },
							h('button', { type: 'button', className: 'wb-btn', onClick: () => setPendingDelete('') }, '取消'),
							h('button', {
								type: 'button', className: 'wb-btn is-danger',
								onClick: () => remove(pendingDelete),
							}, '确认删除')))));
			}
			return h('div', root, children);
		}

		function apply(ctx) {
			ctx.effect(maintainStyles, 'vssaros-scheduler: styles');
			// 只依赖 `desktopWorkbenches` ⇒ **工作台一定注册**（点得开、有反应）；
			// 数据面是同源 fetch ⇒ 没有"服务未就绪 ⇒ 面板空白"这类失败模式。
			ctx.inject(['desktopWorkbenches'], (wb) => {
				wb.effect(() => wb.desktopWorkbenches.register(WB_DESCRIPTOR, Schedules), 'vssaros-scheduler: workbench');
			});
			return undefined;
		}

		module.exports.apply = apply;
		module.exports.inject = [];
		return module.exports;
	},
});
