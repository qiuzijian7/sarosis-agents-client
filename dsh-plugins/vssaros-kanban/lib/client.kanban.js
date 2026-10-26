// @vssaros/dsh-kanban — **React 工作台**（工作台重构 P3 第 2 个；doc/workbench-refactor-plan.md §5 步骤 2）。
//
// 形态与官方一致：经宿主服务 `desktopWorkbenches.register(descriptor, Component)` 注册，宿主负责渲染
// （业务方不 createRoot）、错误边界与顶栏校验。描述符与清单 `vssaros.workbench` 同值（守卫逐项比对 ✓）。
// 数据只从 `/x/kanban/api/page` 取（与 SSR 页**同一份取数**：`lib/index.js` 的 `collectBoardData`）✓。
//
// 行为与旧 SSR 页**逐条对齐**（`board.js` 的 `BOARD_SCRIPT`）：
//   · 六列（待分解 / 待执行 / 执行中 / 执行结束 / 取消执行 / 归档）＋ 每列折叠 ＋ 每列可见计数；
//   · 筛选：搜索（id / 标题 / 状态 / 看板 / 优先级 / 负责人）、按看板、按负责人 ⇒ "显示 N / M 张"；
//   · 卡片点击 ⇒ 详情抽屉（`/api/task` ⇒ 状态 / 负责人 / 依赖 / 时间 / 描述 / 追加记录）；
//   · **拖拽换列**：指针拖动（不是 HTML5 DnD —— 与旧页同款）＋ 幽灵跟手 ＋ 落列高亮 ＋
//     锁定列（执行中）拒收 ＋ 乐观移动 ＋ **失败真回滚** ＋ **以服务端回的列为准**（旧页同款）✓。
//   · dsh 任务镜像卡（只读）：按状态落列，**不带 task-id** ⇒ 天然拖不动、开不了详情 ✓。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-kanban',
	chunk: 'client.kanban.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');
		const h = react.createElement;
		const useState = react.useState;
		const useEffect = react.useEffect;
		const useCallback = react.useCallback;
		const useRef = react.useRef;

		const API = '/x/kanban/api';
		/** 描述符（与清单 `vssaros.workbench` 同值 ⇒ 守卫逐项比对 ✓）。 */
		const DESCRIPTOR = {
			title: 'Tasks',
			description: '任务看板：按状态管理任务，拖拽改列。',
			repository: 'vssaros:kanban',
			icon: 'codicon:checklist',
			customFrame: true,
		};
		// ⚠ 优先级三色**必须用语义令牌**（不能写死 #ef4444 这类值）：dsw 令牌在 `body` / `body[data-ds-dark-theme]`
		//   下各有一套值，硬编码只有一套 ⇒ 切暗色主题时不跟随 ✗（2026-10-22 UI 统一时被守卫抓出来）。
		const PRIORITIES = {
			high: { label: '高', color: 'var(--dsw-alias-state-error-primary, #ef4444)', bg: 'var(--dsw-alias-state-error-secondary, rgba(239,68,68,.16))' },
			medium: { label: '中', color: 'var(--dsw-alias-state-warn-primary, #f59e0b)', bg: 'var(--dsw-alias-state-warn-secondary, rgba(245,158,11,.16))' },
			low: { label: '低', color: 'var(--dsw-alias-brand-primary, #3b82f6)', bg: 'var(--dsw-alias-interactive-bg-active, rgba(59,130,246,.16))' },
		};
		/** 拖动起点与"算作拖动"的距离（与旧页同款：6px 死区 ⇒ 点一下不会误拖 ✓）。 */
		const DRAG_THRESHOLD = 6;

		function KanbanPanel() {
			const [view, setView] = useState({ status: 'loading', columns: [], cards: [], mirrors: [], boardOptions: [], assigneeOptions: [], total: 0, missing: '', note: '', mirrorsNote: '', diag: null });
			const [cards, setCards] = useState([]);
			const [query, setQuery] = useState('');
			const [board, setBoard] = useState('');
			const [assignee, setAssignee] = useState('');
			const [collapsed, setCollapsed] = useState(() => new Set());
			const [message, setMessage] = useState('');
			const [messageIsError, setMessageIsError] = useState(false);
			const [drawer, setDrawer] = useState(null);
			const [drag, setDrag] = useState(null);
			const [selectedId, setSelectedId] = useState('');
			const dragRef = useRef(null);
			const boardRef = useRef(null);

			const say = useCallback((text, isError) => { setMessage(String(text || '')); setMessageIsError(!!isError); }, []);
			const load = useCallback(async () => {
				try {
					const res = await fetch(API + '/page', { cache: 'no-store' });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
					setView(body);
					setCards(Array.isArray(body.cards) ? body.cards : []);
					setCollapsed(prev => {
						const next = new Set(prev);
						for (const col of (body.columns || [])) { if (col.startCollapsed) { next.add(col.key); } }
						return next;
					});
				} catch (e) {
					setView(v => Object.assign({}, v, { status: 'error' }));
					say('读取失败：' + String(e && e.message || e), true);
				}
			}, [say]);
			useEffect(() => { void load(); }, [load]);

			// 筛选（与旧页 applyFilter 同口径：搜索串 / 看板 / 负责人）
			const searchText = useCallback(card => {
				return [card.id, card.title, card.status, card.boardId, card.priority, card.assigneeName].filter(Boolean).join(' ').toLowerCase();
			}, []);
			const visible = useCallback((card) => {
				const q = String(query || '').trim().toLowerCase();
				if (q && !searchText(card).includes(q)) { return false; }
				if (board && String(card.boardId || '') !== board) { return false; }
				if (assignee && String(card.assigneeName || '') !== assignee) { return false; }
				return true;
			}, [query, board, assignee, searchText]);

			const columns = view.columns || [];
			const byColumn = useCallback((key) => cards.filter(c => c.column === key && visible(c)), [cards, visible]);
			const visibleTotal = cards.filter(visible).length;
			const total = cards.length;

			// ── 详情抽屉 ────────────────────────────────────────────────────────
			const openDrawer = useCallback(async (card) => {
				if (!card || !card.id) { return; }
				setSelectedId(card.id);
				setDrawer({ id: card.id, title: card.title || '卡片详情', note: '正在读取详情…', body: null });
				try {
					const res = await fetch(API + '/task?id=' + encodeURIComponent(card.id), { headers: { accept: 'application/json' } });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) { setDrawer({ id: card.id, title: card.title, note: String(body.error || '读不到详情'), body: null }); return; }
					setDrawer({ id: card.id, title: (body.task && body.task.title) || card.title, note: '只读详情（与 IDE 看板同一份数据）。', body });
				} catch (e) {
					setDrawer({ id: card.id, title: card.title, note: '读不到详情：' + String(e && e.message || e), body: null });
				}
			}, []);
			useEffect(() => {
				const onKey = (ev) => { if (ev.key === 'Escape') { setDrawer(null); setSelectedId(''); } };
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, []);

			// ── 拖拽换列（指针拖动；幽灵跟手；落列高亮；锁定列拒收；乐观移动 + 失败回滚 + 以服务端为准）────
			const startDrag = useCallback((ev, card) => {
				if (!card || !card.draggable || ev.button !== 0) { return; }
				const node = ev.currentTarget;
				const rect = node.getBoundingClientRect();
				dragRef.current = {
					cardId: card.id,
					fromKey: card.column,
					startX: ev.clientX,
					startY: ev.clientY,
					grabDx: ev.clientX - rect.left,
					grabDy: ev.clientY - rect.top,
					width: rect.width,
					height: rect.height,
					moved: false,
					overKey: '',
				};
				try { node.setPointerCapture(ev.pointerId); } catch (e) { /* 捕获只是优化 ✓ */ }
			}, []);
			// ── 拖拽换列（指针拖动；幽灵跟手；落列高亮；锁定列拒收；乐观移动 + 失败回滚 + 以服务端为准）────
			// ⚠ 顺序有讲究：`commitMove` 必须在下面那个 effect **之前**定义（effect 的依赖数组在渲染时求值 ⇒
			//   引用还没初始化的 const ⇒ TDZ ReferenceError ⇒ 整个组件炸 ✗）。
			/** 乐观移动 ⇒ 落盘 ⇒ **以服务端回的列为准**（旧页同款：失败真回滚 ✓）。 */
			const commitMove = useCallback(async (cardId, fromKey, toKey) => {
				const label = (columns.find(c => c.key === toKey) || {}).label || toKey;
				setCards(prev => prev.map(c => (c.id === cardId ? Object.assign({}, c, { column: toKey }) : c)));
				say('正在移动到「' + label + '」…', false);
				try {
					const res = await fetch(API + '/move', {
						method: 'POST',
						headers: { 'content-type': 'application/json', accept: 'application/json' },
						body: JSON.stringify({ id: cardId, to: toKey }),
					});
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) {
						setCards(prev => prev.map(c => (c.id === cardId ? Object.assign({}, c, { column: fromKey }) : c)));
						say('没能移动：' + String(body.error || '未知原因'), true);
						return;
					}
					// ★ **以服务端为准**：它回的 column 才是卡片真正所属的列（"别人已经挪过"时服务端说"没改动" ⇒ 跟着它走 ✗）。
					const authoritative = String(body.column || toKey);
					setCards(prev => prev.map(c => (c.id === cardId ? Object.assign({}, c, { column: authoritative, status: body.status || c.status }) : c)));
					say(body.changed === false
						? ('没有改动：' + String(body.note || ('卡片就在「' + label + '」')))
						: ('已移动到「' + label + '」（' + String(body.statusLabel || body.status || '') + '）'), false);
				} catch (e) {
					setCards(prev => prev.map(c => (c.id === cardId ? Object.assign({}, c, { column: fromKey }) : c)));
					say('没能移动：' + String(e && e.message || e), true);
				}
			}, [columns, say]);

			useEffect(() => {
				// ⚠ 监听器**始终**挂着（不是"拖起来才挂"）：拖动状态住在 ref 里（`dragRef`），
				//   第一次 pointermove 就是靠这个监听把 `moved` 置真 ⇒ 若等 React 状态变化才挂监听，
				//   那个 move 事件没人接 ⇒ 拖动永远起不来 ✗（真机验收当场抓到 ✓）。
				const onMove = (ev) => {
					const st = dragRef.current;
					if (!st) { return; }
					if (!st.moved) {
						const dx = ev.clientX - st.startX;
						const dy = ev.clientY - st.startY;
						if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) { return; }
						st.moved = true;
					}
					// 落列 = 指针下面那一列。
					// ⚠ 用**几何**判定（与旧页 `columnUnder` 同款：横向落在列的带内、纵向在列的范围里），
					//   不用 `elementFromPoint` —— 后者取的是**真实指针**位置，元素被盖住时会落到别的元素上 ✗。
					const board = boardRef.current;
					let key = '';
					let locked = '';
					if (board) {
						const cols = Array.prototype.slice.call(board.querySelectorAll('[data-kanban-col]'));
						let nearest = null;
						for (const col of cols) {
							const r = col.getBoundingClientRect();
							const dx = ev.clientX < r.left ? r.left - ev.clientX : (ev.clientX > r.right ? ev.clientX - r.right : 0);
							const insideY = ev.clientY >= r.top && ev.clientY <= r.bottom;
							if (insideY && dx <= 16 && (!nearest || dx < nearest.dx)) { nearest = { col, dx }; }
						}
						if (nearest) {
							key = nearest.col.getAttribute('data-kanban-col') || '';
							locked = nearest.col.getAttribute('data-kanban-drop') === 'locked' ? key : '';
						}
					}
					st.overKey = locked ? '' : key;
					setDrag({ cardId: st.cardId, fromKey: st.fromKey, x: ev.clientX - st.grabDx, y: ev.clientY - st.grabDy, overKey: st.overKey, lockedKey: locked, width: st.width, height: st.height, moved: true });
				};
				const onUp = () => {
					const st = dragRef.current;
					dragRef.current = null;
					setDrag(null);
					if (!st || !st.moved) { return; }
					const target = st.overKey;
					if (!target || target === st.fromKey) { say('没有落到任何列（取消）', false); return; }
					void commitMove(st.cardId, st.fromKey, target);
				};
				const onCancel = () => { dragRef.current = null; setDrag(null); say('拖拽已取消', false); };
				window.addEventListener('pointermove', onMove);
				window.addEventListener('pointerup', onUp);
				window.addEventListener('pointercancel', onCancel);
				return () => {
					window.removeEventListener('pointermove', onMove);
					window.removeEventListener('pointerup', onUp);
					window.removeEventListener('pointercancel', onCancel);
				};
			}, [commitMove, say]);

			// ── 渲染零件 ────────────────────────────────────────────────────────
			const renderCard = card => {
				const pri = PRIORITIES[String(card.priority || '')];
				const deps = Array.isArray(card.deps) ? card.deps : [];
				return h('article', {
					key: card.id,
					className: 'wb-card kb-card status-' + String(card.status || '') + (selectedId === card.id ? ' is-selected' : '') + (drag && drag.cardId === card.id ? ' is-dragging' : ''),
					'data-kanban-card': '1',
					'data-task-id': card.id,
					'data-board': card.boardId,
					'data-assignee': card.assigneeName,
					'data-search': searchText(card),
					'data-focus-title': card.title,
					'data-kanban-grab': card.draggable ? '1' : null,
					'data-kanban-locked': card.draggable ? null : '1',
					role: 'button',
					tabIndex: 0,
					title: '完整 ID：' + card.id + '（点击看详情' + (card.draggable ? '，拖动可换列' : '；执行中不可拖') + '）',
					onPointerDown: (ev) => startDrag(ev, card),
					onClick: () => { void openDrawer(card); },
					onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); void openDrawer(card); } },
				},
					h('div', { className: 'kb-card-r1' },
						h('span', { className: 'kb-id' }, card.shortId),
						pri ? h('span', { className: 'kb-pri', style: { color: pri.color, background: pri.bg } }, pri.label) : null,
						card.source === 'delegation' ? h('span', { className: 'kb-src' }, '委派') : null),
					h('div', { className: 'kb-title' }, card.title),
					card.preview ? h('div', { className: 'kb-preview' }, card.preview) : null,
					h('div', { className: 'kb-card-r3' },
						h('span', { className: 'kb-agent' + (card.assigneeName ? '' : ' kb-agent-none') }, card.assigneeName ? '🤖 ' + card.assigneeName : '未指派'),
						card.whenText ? h('span', { className: 'kb-when' }, card.whenText) : null,
						deps.length
							? h('span', { className: 'kb-dep' }, deps.map(dep => h('span', {
								key: dep.id,
								className: 'kb-dep' + (dep.status === 'done' ? ' is-done' : dep.status === 'blocked' ? ' is-blocked' : ''),
								title: '依赖 ' + dep.id + '（状态：' + (dep.status || '未知') + '）',
							}, (dep.status === 'done' ? '✓' : dep.status === 'blocked' ? '🚧' : '○') + ' ' + dep.shortId)))
							: h('span', { className: 'kb-dep' }, '依赖：无')));
			};
			const renderMirror = mirror => h('article', {
				key: 'mirror-' + mirror.id,
				className: 'wb-card kb-card kb-card-mirror',
				'data-kanban-mirror': '1',
				'data-mirror-status': mirror.status,
				'data-mirror-session': mirror.sessionId,
				'data-focus-title': mirror.content,
			},
				h('div', { className: 'kb-mirror-title' }, mirror.content),
				h('div', { className: 'kb-mirror-meta' },
					h('span', { className: 'kb-src-mirror' }, 'dsh 会话投影 · 只读'),
					h('span', { className: 'kb-agent' }, mirror.sessionTitle || String(mirror.sessionId || '').slice(0, 8))));
			const renderColumn = column => {
				const list = byColumn(column.key);
				const mirrors = (view.mirrors || []).filter(m => m.column === column.key);
				const hidden = Math.max(0, cards.filter(c => c.column === column.key).length - list.length);
				const isOver = drag && drag.overKey === column.key;
				const isLockedOver = drag && drag.lockedKey === column.key;
				return h('section', {
					key: column.key,
					className: 'kb-col' + (collapsed.has(column.key) ? ' kb-col-folded' : '') + (isOver ? ' kb-col-drop' : '') + (isLockedOver ? ' kb-col-locked' : ''),
					'data-kanban-col': column.key,
					'data-kanban-drop': column.dropStatus === null ? 'locked' : column.dropStatus,
				},
					h('header', { className: 'kb-col-hd' },
						h('span', { className: 'kb-col-icon', 'aria-hidden': 'true' }, column.icon),
						h('span', { className: 'kb-col-label' }, column.label),
						h('span', { className: 'kb-col-count', style: { background: column.color + '33', color: column.color }, 'data-kanban-col-count': '' }, String(list.length)),
						h('span', { className: 'kb-col-spacer' }),
						h('button', {
							type: 'button', className: 'kb-col-toggle', 'data-kanban-collapse': '', title: '折叠 / 展开这一列',
							'aria-label': '折叠或展开「' + column.label + '」',
							onClick: () => setCollapsed(prev => { const next = new Set(prev); if (next.has(column.key)) { next.delete(column.key); } else { next.add(column.key); } return next; }),
						}, '‹')),
					h('div', { className: 'kb-col-body' },
						list.map(renderCard),
						list.length ? null : (mirrors.length ? null : h('p', { className: 'kb-col-empty' }, '这一列没有卡片')),
						mirrors.map(renderMirror)),
					hidden ? h('p', { className: 'kb-col-more', 'data-kanban-col-more': '' }, '还有 ' + hidden + ' 张未显示（超出单列上限 ' + column.limit + '）') : null);
			};
			const drawerBody = drawer && drawer.body ? (() => {
				const task = drawer.body.task || {};
				const desc = drawer.body.desc || {};
				const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
				const fld = (label, value, mono) => h('div', { className: 'kb-fld' },
					h('div', { className: 'kb-fld-l' }, label),
					h('div', { className: 'kb-fld-v' + (mono ? ' is-mono' : '') }, value));
				return h('div', { className: 'kb-drawer-fields', 'data-kanban-drawer-fields': '' },
					fld('状态', task.statusLabel || task.status || '未知'),
					fld('负责人 / 优先级 / 来源', [task.assigneeName || '未指派', task.priority || '未设', task.source || '未知'].join(' · ')),
					fld('看板', task.boardId || 'default'),
					deps.length
						? h('div', { className: 'kb-fld' }, h('div', { className: 'kb-fld-l' }, '依赖'),
							deps.map(id => h('div', { key: id, className: 'kb-fld-v is-mono' }, '#' + String(id).slice(-6) + ' · ' + ((drawer.body.depStatus && drawer.body.depStatus[id]) || '不在本次列表里'))))
						: fld('依赖', '无'),
					(task.createdAt || task.updatedAt || task.completedAt) ? fld('创建 / 更新 / 完成', [task.createdAt || '—', task.updatedAt || '—', task.completedAt || '—'].join('  ·  ')) : null,
					task.url ? fld('链接', task.url) : null,
					fld('任务 id', task.id || '', true),
					desc.head ? fld('描述', desc.head) : null,
					desc.notes && desc.notes.length
						? h('div', { className: 'kb-fld' }, h('div', { className: 'kb-fld-l' }, '追加记录（COMMENT / BLOCKED / HEARTBEAT）'),
							desc.notes.map((line, i) => h('div', { key: i, className: 'kb-log' }, line)))
						: null,
					desc.truncated ? fld('提示', '描述过长已截断显示（原文 ' + String(desc.length || 0) + ' 字，这里最多 ' + String(desc.limit || 0) + ' 字）；完整原文请用 kanban_show 或直接看数据文件。') : null);
			})() : null;

			const diag = view.diag;
			const allRegistered = diag && diag.expectedTools.length > 0 && diag.expectedTools.every(n => (diag.registeredTools || []).includes(n));

			let boardBody;
			if (view.status === 'loading' && !cards.length) {
				boardBody = h('p', { className: 'wb-empty', 'data-kanban-state': 'loading' }, '正在读取看板…');
			} else if (view.status === 'error') {
				boardBody = h('p', { className: 'wb-empty', 'data-kanban-state': 'error', role: 'alert' }, '读取失败：' + message);
			} else {
				boardBody = h('div', { className: 'kb-board', ref: boardRef }, columns.map(renderColumn));
			}

			return h('div', {
				className: 'wb wb-kanban',
				'data-vssaros-kanban-surface': 'board',
				'data-vssaros-page': 'kanban',
				'data-vssaros-surface': 'workbench',
				'data-sssaros-tools': diag ? (diag.registeredTools || []).join(',') : '',
				'data-registered': allRegistered ? 'true' : 'false',
				'data-vssaros-workspace': diag ? diag.workspaceId : '',
				'data-kanban-runner': diag && diag.runner ? 'on' : 'off',
				'data-kanban-runner-why': diag ? String(diag.runnerWhy || '') : '',
			},
				h('div', { className: 'wb-toolbar wb-header' },
					h('h1', null, 'Tasks ', h('small', null, total + ' 条（只读）')),
					h('div', { className: 'wb-field-row', 'data-dsh-workbench-toolbar': '' },
						h('input', { className: 'wb-input', type: 'search', value: query, 'data-kanban-search': '', placeholder: '搜索卡片（标题 / id / 负责人）', 'aria-label': '搜索卡片', onChange: (ev) => setQuery(ev.target.value) }),
						h('select', { className: 'wb-select', value: board, 'data-kanban-board': '', 'aria-label': '按看板筛选', onChange: (ev) => setBoard(ev.target.value) },
							h('option', { value: '' }, '全部看板'),
							(view.boardOptions || []).map(b => h('option', { key: b.id, value: b.id }, b.name))),
						h('select', { className: 'wb-select', value: assignee, 'data-kanban-assignee': '', 'aria-label': '按负责人筛选', onChange: (ev) => setAssignee(ev.target.value) },
							h('option', { value: '' }, '全部负责人'),
							(view.assigneeOptions || []).map(a => h('option', { key: a, value: a }, a))),
						h('span', { className: 'wb-diag wb-stat', 'data-kanban-count': '' }, '显示 ' + visibleTotal + ' / ' + total + ' 张'),
						h('span', { className: 'kb-status', 'data-kanban-status': '', role: 'status', 'aria-live': 'polite', style: messageIsError ? { color: 'var(--dsw-alias-state-error-primary, #f48771)' } : null }, message),
						h('span', { className: 'kb-chip-static', title: '卡片详情只读；只有拖动换列会写入 taskboard.json' }, '拖拽可换列'))),
				view.missing ? h('p', { className: 'wb-empty kb-notice' }, '看板数据文件还不存在：', h('code', null, view.missing), h('br'), '首次启动或尚未使用看板时属正常。') : null,
				view.note ? h('p', { className: 'wb-diag kb-notice' }, view.note) : null,
				view.mirrorsNote ? h('p', { className: 'wb-diag kb-notice', 'data-kanban-mirror-note': '' }, 'dsh 任务镜像：' + view.mirrorsNote) : null,
				(cards.length && !visibleTotal) ? h('p', { className: 'wb-empty', 'data-kanban-empty': '' }, '🔍 没有匹配的卡片') : null,
				// ★ 左右两档（2026-10-22 用户要求，与工作流页同款）：左列 = 六列看板，右列 = 卡片详情。
				//   详情原来是右下角浮层 ⇒ 现在常驻右栏（点左列卡片 ⇒ 右栏换它 ✓）。
				h('div', { className: 'wb-split', 'data-kb-layout': 'split' },
					h('section', { className: 'wb-pane wb-pane-board', 'data-kb-pane': 'board' }, boardBody),
					h('section', { className: 'wb-pane wb-pane-right wb-pane-detail', 'data-kb-pane': 'detail' },
						h('header', { className: 'wb-pane-hd' },
							h('span', { className: 'wb-pane-title' }, '卡片详情'),
							drawer ? h('code', { className: 'wb-pane-id' }, drawer.id) : null,
							h('span', { className: 'wb-spacer' }),
							drawer ? h('button', { type: 'button', className: 'wb-btn is-ghost', 'data-kanban-drawer-close': '', onClick: () => { setDrawer(null); setSelectedId(''); } }, '关闭') : null),
						drawer
							? h('div', { className: 'wb-drawer kb-detail', 'data-kanban-drawer': '' },
								h('strong', { className: 'kb-detail-title', 'data-kanban-drawer-title': '' }, drawer.title || '卡片详情'),
								h('p', { className: 'wb-diag', 'data-kanban-drawer-note': '' }, drawer.note),
								drawerBody)
							: h('p', { className: 'wb-empty', 'data-kanban-drawer-empty': '' }, '点左边任意一张卡片看详情（只读）；按住卡片拖动可以换列。'))) ,
				diag ? h('p', { className: 'wb-diag' },
					'工具：', (diag.registeredTools || []).length ? (diag.registeredTools || []).join(', ') : '（未注册）',
					'（' + (diag.registeredTools || []).length + '/' + (diag.expectedTools || []).length + '） · 工作区：',
					h('code', null, diag.workspaceId ? diag.workspaceId : '未注入（写工具会拒绝建卡）'),
					' · 自动执行：', h('code', null, diag.runner ? '已启动' : ('未启动（' + diag.runnerWhy + '）')),
					' · 数据文件：', h('code', null, diag.dataFile)) : null,
				// 拖拽幽灵（跟手；旧页是克隆节点，这里是固定定位的副本 ✓）
				drag && drag.moved ? h('div', {
					className: 'wb-ghost kb-ghost',
					style: { position: 'fixed', left: drag.x + 'px', top: drag.y + 'px', width: drag.width + 'px', height: drag.height + 'px', pointerEvents: 'none', opacity: .85, zIndex: 9999 },
				}, '移动到「' + ((columns.find(c => c.key === drag.overKey) || {}).label || '…') + '」') : null);
		}

		const STYLE_ID = 'vssaros-kanban-workbench-layout';
		// ★ 2026-10-22（工作台 UI 统一，方案稿 §6.19）：**通用视觉全部交给共享层**（宿主注入的 `wb-*`），
		//   这里只留看板特有的结构 —— 六列、列内滚动、卡片内几行、详情字段。
		// ⚠ 原来这里写了一批**不存在的令牌名**（`--dsw-alias-border-l2` / `--dsw-alias-state-focus-primary` /
		//   `--dsh-font-family-code-default`）⇒ 一律回落到硬编码兜底 ⇒ 切暗色主题时这些地方**不跟着变** ✗。
		//   现在统一成真实令牌（`border-l1/l2`、`brand-primary`、`--wb-mono`）。
		const CSS = `
.wb-kanban { gap: var(--wb-s2); }
.wb-header { flex-direction: column; align-items: stretch; }
.kb-board { display:flex; gap:var(--wb-s2); align-items:flex-start; overflow-x:auto; flex:1 1 auto; min-height:0; padding-bottom:var(--wb-s1); }
.kb-col { flex:0 0 268px; display:flex; flex-direction:column; min-height:0; max-height:100%; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius:var(--wb-r-md); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04)); }
.kb-col.kb-col-folded { flex-basis:44px; }
.kb-col.kb-col-folded .kb-col-body, .kb-col.kb-col-folded .kb-col-label, .kb-col.kb-col-folded .kb-col-count { display:none; }
.kb-col.kb-col-drop { outline:1px solid var(--dsw-alias-brand-primary, #007fd4); outline-offset:-1px; }
.kb-col.kb-col-drop .kb-col-body { background: var(--dsw-alias-interactive-bg-active, rgba(0,127,212,.10)); }
.kb-col.kb-col-locked { outline:1px dashed var(--dsw-alias-state-warn-primary, #e0a43a); outline-offset:-1px; }
.kb-col-hd { display:flex; align-items:center; gap:var(--wb-s1); padding:7px 9px; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
.kb-col-icon { font-size:var(--wb-f-md); }
.kb-col-label { font-size:var(--wb-f-sm); font-weight:600; }
.kb-col-count { font-size:var(--wb-f-xs); border-radius:var(--wb-r-pill); padding:0 7px; }
.kb-col-spacer { flex:1 1 auto; }
.kb-col-toggle { padding:0 6px; border-radius:var(--wb-r-sm); cursor:pointer; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: transparent; color: inherit; }
.kb-col-body { display:flex; flex-direction:column; gap:7px; padding:var(--wb-s2); overflow:auto; min-height:0; }
.kb-col-empty { margin:var(--wb-s1) 0; font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.55)); text-align:center; }
.kb-col-more { margin:0; padding:0 9px 7px; font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.kb-card { padding:var(--wb-s2); cursor:pointer; user-select:none; }
.kb-card.is-selected { outline:1px solid var(--dsw-alias-brand-primary, #007fd4); }
.kb-card.is-dragging { opacity:.45; }
.kb-card-r1 { display:flex; align-items:center; gap:var(--wb-s1); }
.kb-id { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); font-family: var(--wb-mono); }
.kb-pri, .kb-src, .kb-dep, .kb-agent { font-size:var(--wb-f-xs); border-radius:var(--wb-r-pill); padding:0 6px; border:1px solid currentColor; color: var(--dsw-alias-label-secondary, rgba(230,230,230,.85)); }
.kb-src { color: var(--dsw-alias-brand-text, #8b5cf6); }
.kb-dep.is-done { color: var(--dsw-alias-state-success-primary, #10b981); }
.kb-dep.is-blocked { color: var(--dsw-alias-state-warn-primary, #e0a43a); }
.kb-agent { border:none; color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); }
.kb-agent-none { color: var(--dsw-alias-label-dimmed, rgba(230,230,230,.45)); }
.kb-title { font-size:var(--wb-f-sm); font-weight:600; margin-top:var(--wb-s1); line-height:1.35; }
.kb-preview { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); margin-top:3px; }
.kb-card-r3 { display:flex; gap:var(--wb-s1); align-items:center; flex-wrap:wrap; margin-top:6px; font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.75)); }
.kb-when { color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); }
.kb-card-mirror { cursor:default; border-style:dashed; }
.kb-mirror-title { font-size:var(--wb-f-sm); line-height:1.35; }
.kb-mirror-meta { display:flex; gap:var(--wb-s1); align-items:center; margin-top:5px; font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); }
.kb-src-mirror { border:1px solid currentColor; border-radius:var(--wb-r-pill); padding:0 6px; }
.kb-detail-title { font-size:var(--wb-f-md); line-height:1.4; }
.kb-fld { margin-top:var(--wb-s2); }
.kb-fld-l { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.kb-fld-v { font-size:var(--wb-f-sm); line-height:1.5; word-break:break-word; }
.kb-fld-v.is-mono { font-family: var(--wb-mono); }
.kb-log { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-secondary, rgba(230,230,230,.8)); line-height:1.5; }
.kb-chip-static { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius:var(--wb-r-pill); padding:1px 8px; }
.kb-ghost { border:1px dashed var(--dsw-alias-brand-primary, #007fd4); border-radius:var(--wb-r-md); background: var(--dsw-alias-bg-overlay, rgba(0,127,212,.14)); color: inherit; display:flex; align-items:center; justify-content:center; font-size:var(--wb-f-sm); }
@container vss-workbench (max-width:900px) { .kb-col { flex-basis:220px; } }
`;

function install(ctx) {
			ctx.effect(() => {
				if (document.getElementById(STYLE_ID)) { return undefined; }
				const el = document.createElement('style');
				el.id = STYLE_ID;
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, 'vssaros-kanban: workbench styles');
			// ⚠ **可选注入**（同 scheduler / workflow）：宿主服务缺席时**只是这个工作台不出现**，SSR 页照旧可用 ✓
			ctx.inject(['desktopWorkbenches'], (c) => {
				c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, KanbanPanel), 'vssaros-kanban: workbench');
			});
			return undefined;
		}

		exports.install = install;
		exports.apply = install;
		exports.inject = [];
		return module.exports;
	},
});
