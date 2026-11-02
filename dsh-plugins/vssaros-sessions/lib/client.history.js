// @vssaros/dsh-sessions — 历史会话**工作台**（注册式 React；身份 `vssaros/sessions`）。
//
// ★ 2026-11-02（承载收口 P1）：把 dsh 窗口里的「会话」从 iframe（`/x/sessions/` SSR 页）换成宿主渲染。
//
// 范围（**这一版只迁「看」与「打开」**，写操作仍留在旧页，避免一次迁太多 ⇒ 迁到一半点开空白）：
//   · 分组列表（按工作区 / 按 Bot）、搜索、状态筛选、仅当前工作区
//   · 点一行 = 打开会话（经宿主 `uiWorkspace.openSession`，与侧栏同一条通路）
//   · 2s 实时状态（只查页面**已经在显示**的 id，不重扫磁盘）
//   · 组内默认折叠空闲会话（运行中 / 等你回答的始终可见，与旧页同口径）
//   留在旧页的：固定 ★、清空历史、重命名、展开详情、磁贴视图（`?view=tiles`）。
//   ⇒ 工具栏里放一个「在页面中打开」入口，能力没丢，只是没搬。
//
// 数据：`GET /x/sessions/api/sessions`（与旧页同一份 collect + 同一份分组 ⇒ 不可能出现「页面 3 个、这里 5 个」）。
// 实时：`GET /x/sessions/api/live?ids=…`。
//
// ⚠ 规矩：改过这个子块之后，要再动一下入口 `lib/client.js`（守卫查 mtime ⇒ 漏了必红）。
// ⚠ 描述符字段一律写**字面量**（守卫的解析器只认字面量 + 一层常量回查）。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-sessions',
	chunk: 'client.history.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');
		const h = react.createElement;
		const useState = react.useState;
		const useEffect = react.useEffect;
		const useCallback = react.useCallback;
		const useMemo = react.useMemo;
		const useRef = react.useRef;

		const API = '/x/sessions/api';
		const PAGE_URL = '/x/sessions/';
		/** 组内默认露出的空闲会话数（与旧页 `SESSION_GROUP_IDLE_LIMIT` 同口径）。 */
		const IDLE_LIMIT = 5;
		const LIVE_INTERVAL_MS = 2000;
		const RETRY_DELAYS = [300, 900, 2000];

		/** 描述符（与清单 `vssaros.workbench` 同值 ⇒ 守卫逐项比对）。 */
		const DESCRIPTOR = {
			title: '历史会话',
			description: '历史会话：按工作区分组浏览、筛选与续聊。',
			repository: 'vssaros:sessions',
			icon: 'codicon:comment-discussion',
			customFrame: true,
		};

		const STATUS_LABEL = { running: '执行中', awaiting: '等你回答', idle: '空闲' };
		const STATUS_FILTERS = [['all', '全部'], ['running', '运行中'], ['awaiting', '等你回答'], ['idle', '空闲']];

		/** 相对时间（与旧页同形：刚刚 / N 分钟前 / N 小时前 / N 天前）。 */
		function relativeTime(ms, now) {
			if (typeof ms !== 'number' || !ms) { return ''; }
			const diff = Math.max(0, (now || Date.now()) - ms);
			const min = Math.floor(diff / 60000);
			if (min < 1) { return '刚刚'; }
			if (min < 60) { return min + ' 分钟前'; }
			const hour = Math.floor(min / 60);
			if (hour < 24) { return hour + ' 小时前'; }
			return Math.floor(hour / 24) + ' 天前';
		}

		/** 一行的搜索面：标题 + preset + 人格 + id（与旧页 `data-search` 同口径）。 */
		function searchFaceOf(s) {
			return [s.title, s.preset, s.persona, s.id].filter(Boolean).join(' ').toLowerCase();
		}

		/**
		 * 一个组要显示哪些会话：活跃的（运行中 / 等你回答）**始终可见且不占配额**，
		 * 空闲的最多 `limit + extra` 条；搜索时不折叠（用户在找东西，别藏起来）。
		 */
		function visibleOf(sessions, { query, extra, limit }) {
			if (query) { return { shown: sessions, hidden: 0 }; }
			let idleSeen = 0;
			const shown = [];
			for (const s of sessions) {
				if (s.active) { shown.push(s); continue; }
				idleSeen++;
				if (idleSeen <= limit + extra) { shown.push(s); }
			}
			return { shown, hidden: sessions.length - shown.length };
		}

		/**
		 * 打开会话：先 retain 再退避重试（会话还没进 roster / 引用被回收是**预期内的瞬时态**，
		 * 与侧栏 `client.workspaces.js` 的 `openSession` 同口径；一次性调用撞上就永久打不开）。
		 * 成败都**就地**反馈（`say`）——桌面窗口没有宿主桥，只写 state 等于静默失败。
		 */
		function openSessionWithRetry(ctx, sid, say) {
			let attempt = 0;
			const transient = (msg) => /unknown session|is released|not found|no such/i.test(msg);
			const tryOpen = () => {
				attempt++;
				const rejected = (e) => {
					const msg = String((e && e.message) || e || '未知错误');
					if (transient(msg) && attempt <= RETRY_DELAYS.length) {
						try {
							const svc = ctx && ctx.sessions;
							if (svc && typeof svc.retain === 'function') { void Promise.resolve(svc.retain(sid)).catch(() => undefined); }
						} catch { /* 下一跳还会再试 */ }
						say('正在打开会话…（第 ' + (attempt + 1) + ' 次，会话还没就绪）', 'note');
						window.setTimeout(tryOpen, RETRY_DELAYS[attempt - 1]);
						return;
					}
					say('打开会话失败：' + msg, 'error');
				};
				try {
					const ws = ctx && ctx.uiWorkspace;
					if (!ws || typeof ws.openSession !== 'function') { throw new Error('宿主没有会话打开能力（uiWorkspace 不可用）'); }
					const r = ws.openSession(sid);
					if (r && typeof r.then === 'function') { r.then(() => say(null), rejected); } else { say(null); }
				} catch (e) { rejected(e); }
			};
			tryOpen();
		}

		function SessionsPanel(props) {
			const ctx = props && props.ctx ? props.ctx : null;
			const [data, setData] = useState({ status: 'loading', groups: [], groupBy: 'workspace', now: Date.now(), note: '' });
			const [groupBy, setGroupBy] = useState('workspace');
			const [scope, setScope] = useState('all');
			const [statusFilter, setStatusFilter] = useState('all');
			const [query, setQuery] = useState('');
			const [extra, setExtra] = useState({});
			const [live, setLive] = useState({});
			const [msg, setMsg] = useState(null);
			const [openingId, setOpeningId] = useState('');
			const aliveRef = useRef(true);

			const say = useCallback((text, kind) => { setMsg(text ? { text, kind: kind || 'note' } : null); }, []);

			const load = useCallback(async () => {
				try {
					const url = API + '/sessions?groupBy=' + encodeURIComponent(groupBy) + '&scope=' + encodeURIComponent(scope);
					const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
					const body = await res.json().catch(() => ({}));
					if (!res.ok) { throw new Error(body.error || ('HTTP ' + res.status)); }
					if (!aliveRef.current) { return; }
					setData({
						status: 'ready',
						groups: Array.isArray(body.groups) ? body.groups : [],
						groupBy: body.groupBy || groupBy,
						now: typeof body.now === 'number' ? body.now : Date.now(),
						missing: body.missing || '',
						truncated: body.truncated === true,
						remaining: typeof body.remaining === 'number' ? body.remaining : 0,
						note: '',
					});
				} catch (e) {
					if (!aliveRef.current) { return; }
					setData(prev => ({ ...prev, status: 'error', note: String((e && e.message) || e) }));
				}
			}, [groupBy, scope]);

			useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
			useEffect(() => { void load(); }, [load]);

			// ── 2s 实时状态：只查**页面上已经显示的** id；id 集合变了（新增/删除）⇒ 整体重取，不在这里补行 ──
			const shownIds = useMemo(() => {
				const ids = [];
				for (const g of data.groups) { for (const s of g.sessions) { ids.push(s.id); } }
				return ids.slice(0, 300);
			}, [data.groups]);
			useEffect(() => {
				if (!shownIds.length) { return undefined; }
				let stopped = false;
				const tick = async () => {
					if (stopped || (typeof document !== 'undefined' && document.hidden)) { return; }
					try {
						const res = await fetch(API + '/live?ids=' + encodeURIComponent(shownIds.join(',')), { cache: 'no-store', credentials: 'same-origin' });
						const body = await res.json().catch(() => null);
						if (stopped || !body || !Array.isArray(body.sessions)) { return; }
						const next = {};
						for (const s of body.sessions) { if (s && s.live) { next[s.id] = s; } }
						setLive(next);
					} catch { /* 实时只是增强：失败就沿用上一次的值 */ }
				};
				const timer = window.setInterval(tick, LIVE_INTERVAL_MS);
				return () => { stopped = true; window.clearInterval(timer); };
			}, [shownIds]);

			const needle = query.trim().toLowerCase();
			/** 合并 live 覆盖 + 搜索 + 状态筛选；组内顺序保持服务端给的顺序。 */
			const groups = useMemo(() => {
				const out = [];
				for (const g of data.groups) {
					const sessions = g.sessions.map(s => {
						const l = live[s.id];
						if (!l) { return s; }
						const status = l.status || s.status;
						return { ...s, status, active: status === 'running' || status === 'awaiting', title: l.title || s.title };
					}).filter(s => (statusFilter === 'all' || s.status === statusFilter) && (!needle || searchFaceOf(s).indexOf(needle) >= 0));
					if (sessions.length) { out.push({ ...g, sessions }); }
				}
				return out;
			}, [data.groups, live, statusFilter, needle]);

			const total = useMemo(() => data.groups.reduce((n, g) => n + g.sessions.length, 0), [data.groups]);
			const shownTotal = useMemo(() => groups.reduce((n, g) => n + g.sessions.length, 0), [groups]);
			const activeTotal = useMemo(() => groups.reduce((n, g) => n + g.sessions.filter(s => s.active).length, 0), [groups]);

			const open = (s) => {
				setOpeningId(s.id);
				window.setTimeout(() => setOpeningId(prev => (prev === s.id ? '' : prev)), 2500);
				openSessionWithRetry(ctx, s.id, say);
			};

			const row = (s) => {
				const status = s.status || 'idle';
				const time = relativeTime(s.createdAt, data.now);
				return h('li', { key: s.id, style: { listStyle: 'none' } },
					h('div', {
						className: 'wb-row' + (status === 'running' ? ' is-active' : '') + (status === 'awaiting' ? ' is-warn' : '') + (openingId === s.id ? ' is-selected' : ''),
						role: 'button', tabIndex: 0,
						'data-session-id': s.id, 'data-session-status': status, 'data-sessions-row': '',
						title: s.cwd || s.id,
						onClick: () => open(s),
						onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(s); } },
					},
						h('div', null,
							h('div', { className: 'wb-row-l1' },
								h('span', { className: 'wb-row-name' }, s.title || '(未命名会话)'),
								s.persona ? h('span', { className: 'wb-badge is-brand', title: '本会话已热切换人格' }, '人格：' + s.persona) : null),
							h('div', { className: 'wb-row-l2' },
								h('span', { className: 'wb-row-desc' }, s.preset ? s.preset : 'preset 未知'),
								time ? h('span', { className: 'wb-meta' }, '· ' + time) : null)),
						h('div', { className: 'wb-acts' },
							status !== 'idle'
								? h('span', { className: 'wb-badge ' + (status === 'running' ? 'is-ok' : 'is-warn'), 'data-sessions-status': status }, STATUS_LABEL[status])
								: null)));
			};

			const body = (() => {
				if (data.status === 'loading') { return h('p', { className: 'wb-empty', 'data-sessions-loading': '' }, '加载中…'); }
				if (data.status === 'error') {
					return h('p', { className: 'wb-empty', 'data-sessions-error': '' }, '历史会话读取失败：' + data.note,
						h('button', { type: 'button', className: 'wb-btn is-ghost', onClick: () => { setData(p => ({ ...p, status: 'loading' })); void load(); } }, '重试'));
				}
				if (!total) {
					return h('p', { className: 'wb-empty', 'data-sessions-empty': '' },
						data.missing ? ('还没有历史会话数据（' + data.missing + '）。' ) : '还没有历史会话。新建一个会话后会出现在这里。');
				}
				if (!shownTotal) { return h('p', { className: 'wb-empty', 'data-sessions-nomatch': '' }, '没有匹配的会话。'); }
				return groups.map(g => {
					const extraShown = extra[g.key] || 0;
					const { shown, hidden } = visibleOf(g.sessions, { query: needle, extra: extraShown, limit: IDLE_LIMIT });
					const act = g.sessions.filter(s => s.active).length;
					return h('section', { key: g.key, className: 'wb-foot', 'data-sessions-group': g.key },
						h('div', { className: 'wb-group-hd' },
							h('span', { title: g.path || g.key }, g.title || g.key),
							h('small', null, g.sessions.length + ' 个' + (act ? ' · ' + act + ' 个进行中' : ''))),
						h('ul', { className: 'wb-list' }, shown.map(row)),
						hidden > 0 ? h('button', {
							type: 'button', className: 'wb-btn is-ghost', 'data-sessions-more': g.key,
							onClick: () => setExtra(prev => ({ ...prev, [g.key]: (prev[g.key] || 0) + 10 })),
						}, '展开其余 ' + hidden + ' 个') : null);
				});
			})();

			return h('div', {
				className: 'wb wb-sessions',
				'data-vssaros-surface': 'workbench',
				'data-vssaros-page': 'sessions',
				'data-sessions-total': String(total),
				'data-sessions-group-by': groupBy,
			},
				h('div', { className: 'wb-toolbar' },
					h('h1', { className: 'wb-title' }, '历史会话 ', h('small', { className: 'wb-sub' }, shownTotal + ' / ' + total + ' 条' + (activeTotal ? ' · ' + activeTotal + ' 个进行中' : ''))),
					h('div', { className: 'wb-field-row', 'data-dsh-workbench-toolbar': '' },
						h('input', {
							className: 'wb-input', type: 'search', value: query, placeholder: '搜索标题 / Bot / id', 'aria-label': '搜索会话',
							'data-sessions-search': '', onChange: (ev) => setQuery(ev.target.value),
						}),
						h('select', { className: 'wb-select', value: groupBy, 'aria-label': '分组方式', 'data-sessions-groupby': '', onChange: (ev) => setGroupBy(ev.target.value) },
							h('option', { value: 'workspace' }, '按工作区'), h('option', { value: 'bot' }, '按 Bot')),
						h('select', { className: 'wb-select', value: scope, 'aria-label': '展示范围', 'data-sessions-scope': '', onChange: (ev) => setScope(ev.target.value) },
							h('option', { value: 'all' }, '全部工作区'), h('option', { value: 'current' }, '仅当前工作区')),
						h('span', { className: 'wb-chips' }, STATUS_FILTERS.map(([key, label]) => h('button', {
							key, type: 'button', className: 'wb-chip' + (statusFilter === key ? ' is-active' : ''),
							'data-sessions-status-filter': key, onClick: () => setStatusFilter(key),
						}, label))),
						h('span', { className: 'wb-spacer' }),
						// 写操作（固定 / 清空 / 重命名 / 详情 / 磁贴）这一版仍在旧页 ⇒ 给个明确入口，能力没丢
						h('a', { className: 'wb-btn is-ghost', href: PAGE_URL, target: '_blank', rel: 'noopener noreferrer', 'data-sessions-legacy': '', title: '固定、清空历史、重命名、详情与磁贴视图仍在页面版里' }, '在页面中打开'))),
				msg ? h('p', { className: 'wb-diag', role: 'status', 'aria-live': 'polite', 'data-sessions-msg': msg.kind, style: msg.kind === 'error' ? { color: 'var(--dsw-alias-state-error-primary, currentColor)' } : undefined }, msg.text) : null,
				data.truncated ? h('p', { className: 'wb-diag', 'data-sessions-truncated': '' }, '只列出最近的一批，另有 ' + data.remaining + ' 条没有载入。') : null,
				h('div', { className: 'wb-scroll' }, body));
		}

		const STYLE_ID = 'vssaros-sessions-workbench-layout';
		const CSS = `
.wb-sessions { gap: var(--wb-s2); }
.wb-sessions .wb-toolbar { flex-direction: column; align-items: stretch; }
.wb-sessions .wb-field-row { flex-wrap: wrap; align-items: center; }
.wb-sessions .wb-input { flex: 1 1 160px; min-width: 120px; }
.wb-sessions .wb-row-name { max-width: 100%; }
@container vss-workbench (max-width:520px) { .wb-sessions .wb-input { flex-basis: 100%; } }
`;

		/**
		 * 工作台组件工厂：把 `ctx` 用**闭包**绑进组件。
		 * 宿主渲染 View 时给的 props 是 `{ service, entry, active?, conversation? }`，**没有 ctx**
		 * （`vssaros-workbenches` 的 `Frame`）；不要靠模块级全局去捞它（多实例会互相覆盖）。
		 */
		function makePanel(ctx) {
			return function SessionsPanelBound() { return h(SessionsPanel, { ctx }); };
		}

		/** 暴露 ctx 给组件（宿主渲染的 View 不一定把 ctx 当 prop 传进来 ⇒ 兜底从模块级取）。 */
		function install(ctx) {
			ctx.effect(() => {
				if (document.getElementById(STYLE_ID)) { return undefined; }
				const el = document.createElement('style');
				el.id = STYLE_ID;
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, 'vssaros-sessions: workbench styles');
			// ⚠ **可选注入**：宿主服务缺席时只是这个工作台不出现，SSR 页照旧可用
			ctx.inject(['desktopWorkbenches'], (c) => {
				c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, makePanel(ctx)), 'vssaros-sessions: workbench');
			});
			return undefined;
		}

		exports.install = install;
		exports.apply = install;
		exports.inject = [];
		// 探针用：纯函数拆出来能在 Node 里直接验
		exports.__test = { relativeTime, searchFaceOf, visibleOf, openSessionWithRetry, DESCRIPTOR, IDLE_LIMIT };
		return module.exports;
	},
});
