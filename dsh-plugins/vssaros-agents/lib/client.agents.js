// @vssaros/dsh-agents — **React 工作台 · 三栏版**（2026-10-23 按 poc/dsh-p0/mockups/agents-workbench-v3.html 重做）
//
// 布局（与 mockup 逐条对应）：
//   ┌ 工具栏：Bots · 统计 · 筛选 · ⟳刷新 · 完整页 ┐
//   ├ T3 页签：◍名册 ｜ ▤用量 ｜ ⇄委派 ｜ ⚿授权      ← **4 个**（群聊签已并入名册左栏）
//   ├─────────────┬──────────────────────────┬──────────────────────┤
//   │ 左 236      │ 中间：会话窗口            │ 右 320               │
//   │ 已注册 N    │  选中 agent ⇒ 它的会话    │ 最近会话 / 记忆 /     │
//   │ 未注册 N    │  选中群聊  ⇒ 群聊窗口     │ 演化 / 版本 / 分支    │
//   │ 群聊 # …    │  + 委派/设置/邀请/群设置  │ （5 个子 tab）        │
//   └─────────────┴──────────────────────────┴──────────────────────┘
//
// ⚠ 诚实边界（不照抄 mockup 的假交互）：
//   · **会话回合只能在 dsh 客户端里跑** ⇒ 中间栏给"该 agent 的最近会话 + 在 dsh 里发起"，
//     composer 可用但发送会明确提示"去完整页开新回合"（不假装能聊）。
//   · 群聊**发消息**同理（群聊页是独立三栏页，走桥打开）；这里只读 transcript。
//   · 版本 / 分支：记忆仓库的 tag/分支接口**插件没暴露** ⇒ 如实写"在完整页"，不编。
//   · 右栏 5 个子 tab 的数据全部来自现成 GET（home / groups / memory），不新造接口。
//
// 数据：`GET /x/agents/api/home`（agents + 每 agent 的 sessions/attention/running/inbox）、
//       `/groups`（群 + transcript）、`/memory?agent=`（文件 + Git 历史 + diff）、`/usage`、`/assignments`、`/approval-templates`+`/outbox`。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-agents',
	chunk: 'client.agents.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');
		const h = react.createElement;
		const { useState, useEffect, useCallback } = react;

		const API = '/x/agents/api';
		const DESCRIPTOR = {
			title: 'Bots',
			description: 'Agent 名册：创建、配置人设与群聊。',
			repository: 'vssaros:agents',
			icon: 'codicon:organization',
			customFrame: true,
		};

		async function getJson(path) {
			const res = await fetch(API + path, { cache: 'no-store', credentials: 'same-origin' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
			return body;
		}
		async function loadHome() { return getJson('/home'); }

		/* ── 调用宿主能力（2026-10-23 第二轮修）───────────────────────────────
		   上一版把**所有**按钮都接到 `openModulePage('/x/agents/')`（"在 IDE 编辑区打开模块页"）。
		   真机报「点 Agent 设置 ⇒ 整个窗口黑屏」：桌面全窗客户端（`VsSaros — Desktop`）**没有编辑区**
		   ⇒ 宿主开出一个空编辑器 ⇒ 黑屏 ✗。

		   桥其实有**专用方法**（`preload-dshView.ts`，桥版本 19）：
		     · `openAgentSettings(agentId, name?)` —— 打开某个 bot 的设置编辑器页（`5 → 6`）
		     · `newChat(agentPreset?)`             —— 新开一个会话（指定 preset）
		     · `openSession(sessionId, agentPreset?, cwd?)` —— 打开已有会话（`12 → 13` 起带 cwd）
		   ⇒ 用对方法既修黑屏，又让"发起会话 / 续聊"真的通向**真聊天**（而不是自绘假聊天窗）。
		   ⚠ 桥不存在（老宿主 / 无 preload）时**必须给反馈**，不能静默。 */
		const bridge = () => {
			try { return typeof window !== 'undefined' ? window.vssarosDsh : null; } catch (e) { return null; }
		};
		const callBridge = (method, args, label) => {
			const b = bridge();
			if (b && typeof b[method] === 'function') {
				try {
					Promise.resolve(b[method].apply(b, args || [])).catch(() => { /* 桥内部失败不阻塞 */ });
					return true;
				} catch (e) { /* 落到兜底 */ }
			}
			// 兜底：明确告诉用户"宿主不支持"，并给出可复制的入口（不要静默）
			try {
				window.prompt((label || '这个操作') + ' 需要 IDE 侧支持（当前宿主没提供桥）。可复制入口：', '/x/agents/');
			} catch (e) { /* 连 prompt 都不可用就算了 */ }
			return false;
		};
		/**
		 * 「Agent 设置」**不用桥**（2026-10-23 第三轮）。
		 * 根因链：`openModulePage` 与 `openAgentSettings` 在宿主侧**都是 `editorService.openEditor`**
		 * （`dshHarness.contribution.ts:1501` 明确开了 `mainPart.activeGroup`）⇒ 桌面全窗客户端
		 * （`VsSaros — Desktop`）没有可渲染的编辑器区 ⇒ **整个窗口黑屏** ✗。
		 * ⇒ 站内弹层展示元信息（不碰编辑器），改人设/模型的入口走 `openModuleRoute`
		 *   （它只在 IDE 里开编辑区，桌面窗口退化成整页导航，不黑屏）。 */
		/**
		 * ⚠ 2026-10-23 第四轮：`newChat` / `openSession` **在工作台里不能用**。
		 * 宿主只受理 `viewId.startsWith('dsh-plugin-')` 的页面（`dshHarness.contribution.ts:1093-1098`：
		 * `case 'newChat': case 'openSession': if (viewId.startsWith('dsh-plugin-')) {...} return;`）——
		 * 工作台是 `desktopWorkbenches` 注册的（viewId 不是 `dsh-plugin-` 前缀）⇒ **命令被静默丢弃** ✗。
		 * ⇒ 所以「发起会话 / 续聊」统一走「完整页」（那里有真会话入口）；
		 *   `openModuleRoute` 在桌面全窗退化成整页导航，不会黑屏、也不会静默。
		 */
		const startChat = () => openModuleRoute('/x/agents/', '发起会话');
		const openSessionById = () => openModuleRoute('/x/agents/', '续聊');
		/** 打开完整页 / 群聊页（IDE 编辑区）。⚠ 桌面全窗窗口没有编辑区 ⇒ 退化成整页导航，避免黑屏。 */
		function openModuleRoute(url, label) {
			const b = bridge();
			const topLevel = (() => { try { return window.self === window.top; } catch (e) { return false; } })();
			// 桌面全窗（surface=full 且顶层）没有 IDE 编辑器 ⇒ openModulePage 会开出空编辑器（黑屏）
			if (b && b.surface === 'full' && topLevel) {
				try { window.location.assign(url); return true; } catch (e) { /* 落到下面 */ }
			}
			if (b && typeof b.openModulePage === 'function') {
				try {
					Promise.resolve(b.openModulePage(url)).catch(() => { /* 不阻塞 */ });
					return true;
				} catch (e) { /* 落到兜底 */ }
			}
			try {
				const w = window.open(url, '_blank', 'noopener');
				if (w) { return true; }
			} catch (e) { /* 被拦 */ }
			try { window.prompt((label || '完整页') + '：宿主没提供桥，可复制地址打开：', url); } catch (e) { /* 放弃 */ }
			return false;
		}

		/* ── T3 页签（4 个；群聊已并入名册左栏）────────────────────────────── */
		const TABS = [
			{ k: 'roster', label: '名册', icon: '◍' },
			{ k: 'usage', label: '用量', icon: '▤' },
			{ k: 'assign', label: '委派', icon: '⇄' },
			{ k: 'auth', label: '授权', icon: '⚿' },
		];
		/* 右栏 5 个子 tab（顺序与 mockup 一致） */
		const RTABS = [
			{ k: 'recent', label: '最近会话', icon: '💬' },
			{ k: 'mem', label: '记忆', icon: '❐' },
			{ k: 'evo', label: '演化', icon: '⎇' },
			{ k: 'ver', label: '版本', icon: '🏷' },
			{ k: 'br', label: '分支', icon: '⑂' },
		];

		const initialOf = (name) => String(name || '?').trim().slice(0, 1).toUpperCase();

		/* ⚠ `props` 来自宿主（customFrame 工作台才有）：
		     props.conversation = 官方对话节点（真 chat-surface）
		     props.service      = 工作台停靠服务（bindSession / ownsSession / showSession）
		     props.entry        = 本工作台条目（id 等）
		   没有 props 时（例如被单测直接渲染）走"自绘降级"。 */
		function AgentsPanel(props) {
			const nativeConversation = (props && props.conversation) || null;
			const dockService = (props && props.service) || null;
			const ownerId = (props && props.entry && props.entry.id) || '';
			/** 让官方对话停靠到**本工作台已拥有的**会话；不拥有就别动（否则会把用户踢到原生对话页） */
			const focusDock = (sessionId) => {
				if (!dockService || !sessionId) { return; }
				try {
					if (typeof dockService.ownsSession === 'function' && dockService.ownsSession(sessionId)) {
						dockService.showSession(sessionId);
					}
				} catch (e) { /* 停靠服务拒绝 ⇒ 保持现状，不打断 */ }
			};
			const [view, setView] = useState({ status: 'loading', data: null, error: '' });
			const [q, setQ] = useState('');
			const [refreshing, setRefreshing] = useState(false);
			const [tab, setTab] = useState('roster');
			const [tabView, setTabView] = useState({ status: 'idle', data: null, error: '' });
			// 三栏枢纽：左栏选中的是谁（agent 或 群聊）
			const [sel, setSel] = useState({ kind: 'agent', id: '' });
			// 右栏子 tab
			const [rtab, setRtab] = useState('recent');
			// 群聊数据（名册签时拉一次；只读）
			const [groupsView, setGroupsView] = useState({ status: 'idle', data: null, error: '' });
			// 右栏记忆类数据（mem/evo/ver/br 共用一次 GET）
			const [memView, setMemView] = useState({ status: 'idle', data: null, error: '' });   // 列表
			const [memFile, setMemFile] = useState(null);   // { title, content, loading, error }
			const [evoDiff, setEvoDiff] = useState(null);   // { title, rows, added, removed, coarse, loading, error }
			// 「Agent 设置」站内弹层（**不开编辑器** ⇒ 桌面窗口不会黑屏）
			const [settingFor, setSettingFor] = useState('');

			/* ── 左栏拖拽排序（2026-10-23 用户要求）──────────────────────────────
			   顺序**本地持久化**到 localStorage：宿主没有"agent 排序"接口
			   （`/api/agents` 只有 POST 创建），所以不假装存到后端。
			   键名带版本号，以后改结构不会读到旧格式。 */
			const ORDER_KEY = 'vssaros.agents.rowOrder.v1';
			const [rowOrder, setRowOrder] = useState(() => {
				try {
					const raw = window.localStorage.getItem(ORDER_KEY);
					const arr = raw ? JSON.parse(raw) : [];
					return Array.isArray(arr) ? arr.map(String) : [];
				} catch (e) { return []; }
			});
			const [dragId, setDragId] = useState('');
			const saveOrder = (ids) => {
				setRowOrder(ids);
				try { window.localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch (e) { /* 隐私模式写不了就算了 */ }
			};
			/** 按已保存顺序排；不在列表里的排在后面（保持原有相对顺序，Array.sort 稳定） */
			const applyOrder = (rows) => {
				if (!rowOrder.length) { return rows; }
				const idx = new Map(rowOrder.map((id, i) => [id, i]));
				const big = 1e9;
				return rows.slice().sort((x, y) => (idx.has(x.id) ? idx.get(x.id) : big) - (idx.has(y.id) ? idx.get(y.id) : big));
			};
			const gearIcon = () => h('svg', {
				width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
				'stroke-width': 1.2, 'stroke-linecap': 'round', 'aria-hidden': 'true',
			},
				h('circle', { cx: 8, cy: 8, r: 2.3 }),
				h('path', { d: 'M8 1.7v1.6M8 12.7v1.6M1.7 8h1.6M12.7 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1' }));
			// 真聊天（第 2 步）：实时会话状态（字段都是 p3-174 抓帧实测的）
			const [live, setLive] = useState({ status: 'idle', items: [], title: '', error: '', streaming: false });
			const [manualSessionId, setManualSessionId] = useState('');
			const [draft, setDraft] = useState('');
			const [sending, setSending] = useState(false);

			const load = useCallback(async () => {
				setRefreshing(true);
				try {
					const body = await loadHome();
					setView({ status: 'ready', data: body, error: '' });
					const first = body && Array.isArray(body.agents) && body.agents[0] ? body.agents[0].id : '';
					setSel(prev => (prev.kind === 'agent' && prev.id ? prev : { kind: 'agent', id: first }));
				} catch (e) {
					setView({ status: 'error', data: null, error: String(e && e.message || e) });
				} finally {
					setRefreshing(false);
				}
			}, []);
			useEffect(() => { void load(); }, [load]);

			// 顶部页签数据（用量 / 委派 / 授权）—— 懒加载
			useEffect(() => {
				if (tab === 'roster') { setTabView({ status: 'idle', data: null, error: '' }); return undefined; }
				let alive = true;
				setTabView({ status: 'loading', data: null, error: '' });
				const path = tab === 'usage' ? '/usage' : tab === 'assign' ? '/assignments' : null;
				const p = tab === 'auth'
					? Promise.all([getJson('/approval-templates'), getJson('/outbox')]).then(([tpl, outbox]) => ({ templates: tpl, outbox }))
					: (path ? getJson(path) : Promise.resolve(null));
				p.then(body => { if (alive) { setTabView({ status: 'ready', data: body, error: '' }); } })
					.catch(e => { if (alive) { setTabView({ status: 'error', data: null, error: String(e && e.message || e) }); } });
				return () => { alive = false; };
			}, [tab]);

			// 群聊：名册签下一次拉齐（左栏列表 + 中间群聊窗口都用它）
			useEffect(() => {
				if (tab !== 'roster' || groupsView.status === 'ready' || groupsView.status === 'loading') { return undefined; }
				let alive = true;
				setGroupsView({ status: 'loading', data: null, error: '' });
				getJson('/groups')
					.then(body => { if (alive) { setGroupsView({ status: 'ready', data: body, error: '' }); } })
					.catch(e => { if (alive) { setGroupsView({ status: 'error', data: null, error: String(e && e.message || e) }); } });
				return () => { alive = false; };
			}, [tab, groupsView.status]);

			const data = view.data;
			const agents = (data && data.agents) || [];
			const home = (data && data.home) || {};
			const summary = (data && data.summary) || {};
			const roster = (data && data.roster) || [];
			const registeredCount = roster.filter(id => id.startsWith('vssaros-') && !/-assign$/.test(id)).length;
			const needle = q.trim().toLowerCase();
			const visible = needle
				? agents.filter(a => (a.id + ' ' + a.name + ' ' + (a.description || '')).toLowerCase().includes(needle))
				: agents;

			const groups = (groupsView.data && Array.isArray(groupsView.data.groups)) ? groupsView.data.groups : [];
			const curAgent = sel.kind === 'agent' ? (agents.find(a => a.id === sel.id) || visible[0] || null) : null;
			const curGroup = sel.kind === 'group' ? (groups.find(g => g.id === sel.id) || groups[0] || null) : null;

			/* ══ 真聊天（第 2 步）：中间栏接宿主的会话事件流 ══════════════════════════════
			   数据来自 GET /x/agents/api/live?session=<id>，三种帧（字段为 p3-174 抓帧实测）：
			     · snapshot        → { cursor, records:[{event:{…}}], hasMore }
			     · event           → { event: { type, seq, time, data } }，其中
			         user/message      data={ role:'user', id, content:[{type:'text',text}], source:{kind,rpcId} }
			         system/message    data={ turn, step, message:{ role, content:[…] } }
			         assistant/attempt data={ turn, step, stream:[{chunk:{…}}] }（正文 chunk 类型待定）
			         session/title     data={ title, messageSeqs, source }
			         turn/start|turn/end → 轮次边界
			     · assistant-stream → { frame:{ type:'start'|…, attemptId, revision } }
			   ⚠ 助手正文增量：抓帧那轮 LLM 缺 key，只拿到 finish{reason:'error'} ⇒ 文本做"尽力提取"，
			     取不到就显示错误/占位，**不编内容**。 */
			const agentSessions = curAgent && Array.isArray((home[curAgent.id] || {}).sessions) ? home[curAgent.id].sessions : [];
			const liveSessionId = manualSessionId || String((agentSessions[0] && agentSessions[0].id) || '');
			// ⚠ 依赖里必须放**布尔**：`props.conversation` 每次渲染都是新节点对象
			//   ⇒ 直接当依赖会无限重连 SSE。
			const hasNativeConv = !!nativeConversation;

			useEffect(() => {
				// 有官方对话节点 ⇒ 聊天由它负责，**不再**自建 SSE（避免两套同时跑、白耗连接）
				if (hasNativeConv) {
					setLive({ status: 'native', items: [], title: '', error: '', streaming: false });
					return undefined;
				}
				if (tab !== 'roster' || !curAgent || !liveSessionId) {
					setLive({ status: 'idle', items: [], title: '', error: '', streaming: false });
					return undefined;
				}
				let alive = true;
				let es = null;
				setLive({ status: 'connecting', items: [], title: '', error: '', streaming: false });

				const textOf = (content) => (Array.isArray(content) ? content : [])
					.filter(p => p && p.type === 'text' && typeof p.text === 'string')
					.map(p => p.text).join('');

				const toItem = (wire) => {
					if (!wire || typeof wire.type !== 'string') { return null; }
					const seq = wire.seq;
					if (wire.type === 'user/message') {
						const d = wire.data || {};
						const text = textOf(d.content);
						// ⚠ 真机实测（p3-175）：dsh 会把 **AGENTS.md 指令** 和 **运行时上下文** 也作为
						//   `user/message` 注入（`source.kind` 分别是 `agent-instructions` / `runtime-context`）。
						//   全当用户气泡的话，中间栏会凭空多出两条"用户说过的话" ⇒ 只认 kind==='user'。
						const kind = String((d.source && d.source.kind) || '');
						if (kind && kind !== 'user') { return { key: 's' + seq, seq, role: 'system', text }; }
						return { key: 'u' + seq, seq, role: 'user', text };
					}
					if (wire.type === 'system/message') {
						const d = wire.data || {};
						return { key: 's' + seq, seq, role: 'system', text: textOf(d.message && d.message.content) };
					}
					if (wire.type === 'assistant/attempt') {
						const d = wire.data || {};
						const chunks = (Array.isArray(d.stream) ? d.stream : []).map(s => s && s.chunk).filter(Boolean);
						const text = chunks.map(c => {
							if (typeof c.text === 'string') { return c.text; }
							if (c.delta && typeof c.delta.text === 'string') { return c.delta.text; }
							if (c.content && typeof c.content.text === 'string') { return c.content.text; }
							return '';
						}).join('');
						const fin = chunks.find(c => c && c.type === 'finish');
						const failure = fin && fin.reason && fin.reason.kind === 'error'
							? String((fin.reason.failure && fin.reason.failure.message) || '这一回合失败了')
							: '';
						return { key: 'a' + seq, seq, role: 'assistant', text, error: failure };
					}
					if (wire.type === 'session/title') {
						return { key: 't' + seq, seq, role: 'title', text: String((wire.data && wire.data.title) || '') };
					}
					if (wire.type === 'turn/start') {
						return { key: 'ts' + seq, seq, role: 'turn', text: '回合 ' + String((wire.data && wire.data.turn) || '') };
					}
					return null;
				};

				const applyWire = (wire) => {
					const item = toItem(wire);
					if (!item) { return; }
					setLive(prev => {
						if (item.role === 'title') { return { ...prev, title: item.text }; }
						return { ...prev, status: 'ready', items: prev.items.concat([item]) };
					});
				};

				try {
					es = new EventSource('/x/agents/api/live?session=' + encodeURIComponent(liveSessionId));
				} catch (e) {
					setLive({ status: 'error', items: [], title: '', error: String((e && e.message) || e), streaming: false });
					return undefined;
				}
				es.addEventListener('snapshot', (ev) => {
					if (!alive) { return; }
					let d = {};
					try { d = JSON.parse(ev.data); } catch { d = {}; }
					const cursor = Number(d.cursor);
					const items = (Array.isArray(d.records) ? d.records : [])
						.map(r => (r && r.event ? toItem(r.event) : null)).filter(Boolean);
					setLive(prev => ({ ...prev, status: 'ready', items }));
					/* ★ 历史首屏（2026-10-23 补）：snapshot 只给"游标附近一小段"，**不含完整历史**
					   ⇒ 用户接上一个有历史的会话时看到的是空的（只有增量）。
					   DSB 的对应做法是 RPC 拉首屏 + SSE 推增量两段；这里补齐第一段：
					   用 snapshot 的 `cursor` 当 `throughSeq` 往前翻一页，合并到列表最前面。 */
					if (Number.isFinite(cursor)) {
						fetch('/x/agents/api/page?session=' + encodeURIComponent(liveSessionId)
							+ '&throughSeq=' + String(cursor) + '&maxMessages=60', { credentials: 'same-origin' })
							.then(r => r.json())
							.then(j => {
								if (!alive || !j || j.ok === false) { return; }
								const hist = (Array.isArray(j.records) ? j.records : [])
									.map(r => (r && r.event ? toItem(r.event) : null)).filter(Boolean);
								if (!hist.length) { return; }
								setLive(prev => {
									const seen = new Set(hist.map(x => x.key));
									return { ...prev, items: hist.concat(prev.items.filter(x => !seen.has(x.key))), historyLoaded: true };
								});
							})
							.catch(() => { /* 历史拉不到不影响实时增量 */ });
					}
				});
				es.addEventListener('event', (ev) => {
					if (!alive) { return; }
					let d = {};
					try { d = JSON.parse(ev.data); } catch { return; }
					if (d && d.event) { applyWire(d.event); }
				});
				es.addEventListener('assistant-stream', () => {
					if (alive) { setLive(prev => ({ ...prev, streaming: true })); }
				});
				es.addEventListener('error', (ev) => {
					if (!alive) { return; }
					let d = null;
					try { d = ev && ev.data ? JSON.parse(ev.data) : null; } catch { d = null; }
					if (d && d.message) { setLive(prev => ({ ...prev, status: 'error', error: String(d.message) })); }
				});
				return () => { alive = false; try { if (es) { es.close(); } } catch { /* 已关 */ } };
			}, [tab, curAgent && curAgent.id, liveSessionId, hasNativeConv]);

			/** 真发一条消息（requestId = 幂等键，重试复用不会发两条） */
			const sendPrompt = async (text) => {
				const body = String(text || '').trim();
				if (!body || !liveSessionId || sending) { return; }
				setSending(true);
				try {
					const res = await fetch('/x/agents/api/prompt', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							sessionId: liveSessionId, text: body, mode: 'queue',
							requestId: 'wb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
						}),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setDraft('');
					setLive(prev => ({ ...prev, error: '' }));
				} catch (e) {
					setLive(prev => ({ ...prev, error: String((e && e.message) || e) }));
				} finally {
					setSending(false);
				}
			};

			/** 开新会话，成功后连它的流 */
			const startSession = async (agent) => {
				try {
					const res = await fetch('/x/agents/api/session', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify(agent && agent.presetId ? { agentPreset: String(agent.presetId) } : {}),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					if (j.sessionId) { setManualSessionId(String(j.sessionId)); }
				} catch (e) {
					setLive(prev => ({ ...prev, error: String((e && e.message) || e) }));
				}
			};

			/** 停掉当前回合 */
			const cancelTurn = async () => {
				if (!liveSessionId) { return; }
				try {
					await fetch('/x/agents/api/cancel', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ sessionId: liveSessionId }),
					});
				} catch (e) { setLive(prev => ({ ...prev, error: String((e && e.message) || e) })); }
			};


			// 右栏记忆类数据：只在需要时拉（mem/evo/ver/br），且跟着选中的 agent 走
			useEffect(() => {
				if (tab !== 'roster' || rtab === 'recent') { return undefined; }
				const agentId = curAgent ? curAgent.id : '';
				if (!agentId) { setMemView({ status: 'idle', data: null, error: '' }); return undefined; }
				let alive = true;
				setMemView({ status: 'loading', data: null, error: '' });
				getJson('/memory?agent=' + encodeURIComponent(agentId))
					.then(body => { if (alive) { setMemView({ status: 'ready', data: body, error: '' }); } })
					.catch(e => { if (alive) { setMemView({ status: 'error', data: null, error: String(e && e.message || e) }); } });
				return () => { alive = false; };
			}, [tab, rtab, curAgent && curAgent.id]);

			// 点记忆文件 ⇒ 只读查看（`&file=` / `&rev=&file=`）
			const openMemFile = useCallback(async (file, rev) => {
				const agentId = curAgent ? curAgent.id : '';
				if (!agentId || !file) { return; }
				const title = (rev ? rev.slice(0, 8) + ' · ' : '') + file;
				setMemFile({ title, loading: true });
				try {
					const body = await getJson('/memory?agent=' + encodeURIComponent(agentId) + '&file=' + encodeURIComponent(file) + (rev ? '&rev=' + encodeURIComponent(rev) : ''));
					setMemFile({ title, content: String((body.content && body.content.text) || ''), error: '' });
				} catch (e) {
					setMemFile({ title, content: '', error: String(e && e.message || e) });
				}
			}, [curAgent && curAgent.id]);

			// 演化：与「当前工作区版本」逐行对比（**服务端算 diff**，只读）
			const openEvoDiff = useCallback(async (rev, file) => {
				const agentId = curAgent ? curAgent.id : '';
				if (!agentId || !rev) { return; }
				const target = file || 'MEMORY.md';
				setEvoDiff({ title: rev.slice(0, 8) + ' → 当前 · ' + target, loading: true, rows: [] });
				try {
					const body = await getJson('/memory?agent=' + encodeURIComponent(agentId) + '&file=' + encodeURIComponent(target) + '&rev=' + encodeURIComponent(rev) + '&against=working');
					const diff = body.diff || {};
					setEvoDiff({ title: rev.slice(0, 8) + ' → 当前 · ' + target, rows: Array.isArray(diff.rows) ? diff.rows : [], added: diff.added, removed: diff.removed, coarse: !!diff.coarse, error: '' });
				} catch (e) {
					setEvoDiff({ title: target, rows: [], error: String(e && e.message || e) });
				}
			}, [curAgent && curAgent.id]);

			const pill = (text, cls, title) => h('span', { className: 'wb-badge ' + (cls || ''), title: title || '' }, text);
			const badge = (n, title) => h('span', { className: 'ag-numb', title: title || '' }, String(n));
			const avatar = (a, big) => h('span', {
				className: 'ag-avatar' + (big ? ' ag-avatar-lg' : ''),
				style: { background: a.color || 'var(--dsw-alias-brand-primary, #4C9AFF)' },
			}, a.icon && a.icon.length <= 2 ? a.icon : initialOf(a.name));

			/* ══════ 左栏 236：已注册 / 未注册 / 群聊 ══════ */
			/** 选中某个 agent：切中间栏 + 若它的最近会话已归属本工作台 ⇒ 官方对话也切过去 */
			const chooseAgent = (a) => {
				setSel({ kind: 'agent', id: a.id });
				setRtab('recent');
				setMemFile(null);
				setEvoDiff(null);
				const recent = ((home[a.id] || {}).sessions || [])[0];
				// focusDock 内部只看"本工作台是否拥有该会话"⇒ 不拥有的不会把用户踢去原生对话页
				if (recent && recent.id) { focusDock(String(recent.id)); }
			};
			const agentRow = (a) => {
				const d = home[a.id] || {};
				const on = !!curAgent && curAgent.id === a.id && sel.kind === 'agent';
				const pending = (d.attentionTotal || 0) + (d.inboxPending || 0);
				const running = Array.isArray(d.running) ? d.running.length : 0;
				const dragging = dragId === a.id;
				return h('div', {
					key: a.id,
					className: 'ag3row' + (on ? ' is-on' : '') + (a.registered ? '' : ' is-unreg') + (dragging ? ' is-drag' : ''),
					'data-ag-id': a.id, 'data-ag-open': on ? '1' : '0', 'data-ag-row': '',
					// 拖拽排序：只对**已注册**的开放（未注册的排了也没意义，反而容易误拖）
					draggable: a.registered ? 'true' : undefined,
					'data-ag-drag': a.registered ? '1' : '0',
					role: 'button', tabIndex: 0,
					onClick: () => { chooseAgent(a); },
					onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); chooseAgent(a); } },
					onDragStart: (ev) => {
						if (!a.registered) { return; }
						setDragId(a.id);
						try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', a.id); } catch (e) { /* 老浏览器 */ }
					},
					onDragOver: (ev) => {
						if (!a.registered || !dragId || dragId === a.id) { return; }
						ev.preventDefault();               // 不 preventDefault 就收不到 drop
						try { ev.dataTransfer.dropEffect = 'move'; } catch (e) { /* 忽略 */ }
					},
					onDrop: (ev) => {
						if (!a.registered) { return; }
						ev.preventDefault();
						const from = dragId || (ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '');
						setDragId('');
						if (!from || from === a.id) { return; }
						// 以**当前渲染顺序**（已注册组）为基准重排，避免与未注册组混在一起
						const ids = applyOrder(visible.filter(x => x.registered)).map(x => x.id);
						const fi = ids.indexOf(from); const ti = ids.indexOf(a.id);
						if (fi < 0 || ti < 0) { return; }
						ids.splice(ti, 0, ids.splice(fi, 1)[0]);
						saveOrder(ids);
					},
					onDragEnd: () => setDragId(''),
				},
					avatar(a),
					h('div', { className: 'ag3row-main' },
						h('div', { className: 'ag3row-l1' },
							h('span', { className: 'ag-name', 'data-ag-name': String(a.name || a.id) }, a.name || a.id),
							a.registered ? null : pill('未注册', 'warn', '花名册里没有它的 preset ⇒ dsh 侧没注册'),
							h('span', { className: 'wb-spacer' }),
							pending ? badge(pending, '待处理 ' + pending + ' 条') : null),
						h('div', { className: 'ag3row-l2' },
							h('span', { 'data-ag-sessions': String(d.sessionsTotal || 0) }, (a.model || '默认模型') + ' · 会话 ' + String(d.sessionsTotal || 0)))),
					// 状态点（运行中）与设置键**同一位置**：hover 时被设置键替换（见 CSS）
					h('span', { className: 'ag-dot' + (running ? ' is-run' : '') }, ''),
					h('button', {
						type: 'button', className: 'ag3row-set', 'data-ag-act': 'settings-row',
						title: 'Agent 设置（站内弹层，不开编辑器）', 'aria-label': 'Agent 设置',
						onClick: (ev) => { ev.stopPropagation(); setSettingFor(a.id); },
						onKeyDown: (ev) => ev.stopPropagation(),
						onDragStart: (ev) => ev.stopPropagation(),
					}, gearIcon()));
			};
			const groupRow = (g) => {
				const on = sel.kind === 'group' && curGroup && curGroup.id === g.id;
				const msgs = Array.isArray(g.transcript) ? g.transcript.length : 0;
				return h('div', {
					key: g.id,
					className: 'ag3row' + (on ? ' is-on' : ''),
					'data-ag-group-row': String(g.id), 'data-ag-open': on ? '1' : '0',
					role: 'button', tabIndex: 0,
					onClick: () => { setSel({ kind: 'group', id: g.id }); setRtab('recent'); },
					onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSel({ kind: 'group', id: g.id }); } },
				},
					h('span', { className: 'ag-gmark' }, '#'),
					h('div', { className: 'ag3row-main' },
						h('div', { className: 'ag3row-l1' }, h('span', { className: 'ag-name' }, String(g.name || g.id || '?'))),
						h('div', { className: 'ag3row-l2' }, (g.mode || 'open') + ' · ' + (Array.isArray(g.members) ? g.members.length : 0) + ' 人 · ' + msgs + ' 条')));
			};
			// 已注册组按**用户拖拽的顺序**渲染（未注册组保持原顺序，不参与排序）
			const regRows = applyOrder(visible.filter(x => x.registered));
			const unregRows = visible.filter(x => !x.registered);
			const leftPane = h('div', { className: 'ag3-l', 'data-ag-list': String(visible.length), 'data-ag-roster-panel': '', 'data-ag-left': '' },
				regRows.length ? h('div', { className: 'ag3-sechd' }, '已注册', h('small', null, String(regRows.length))) : null,
				regRows.map(agentRow),
				unregRows.length ? h('div', { className: 'ag3-sechd' }, '未注册', h('small', null, String(unregRows.length))) : null,
				unregRows.map(agentRow),
				unregRows.length ? h('p', { className: 'ag-hint ag3-tip' }, '未注册 = 花名册里没有它的 preset ⇒ dsh 侧不会加载。') : null,
				h('div', { className: 'ag3-sechd' }, '群聊', h('small', null, String(groups.length)),
					h('button', {
						type: 'button', className: 'wb-btn is-ghost ag3-mini', 'data-ag-act': 'groups-app',
						title: '建群 / 发消息在群聊页', onClick: () => openModuleRoute('/x/agents/group', '群聊页'),
					}, '＋')),
				groupsView.status === 'loading' ? h('p', { className: 'ag-hint ag3-tip' }, '正在读群聊…') : null,
				groupsView.status === 'error' ? h('p', { className: 'ag-hint ag3-tip' }, '群聊读不到：' + groupsView.error) : null,
				groups.length ? groups.map(groupRow) : (groupsView.status === 'ready' ? h('p', { className: 'ag-hint ag3-tip' }, '还没有群聊。') : null));

			/* ══════ 中间：会话窗口（agent）/ 群聊窗口（group）══════ */
			/** 空态起手卡（该 agent 还没有会话时） */
			const startCard = (a) => h('div', { className: 'ag3-start', 'data-ag-mid-empty': '' },
				avatar(a, true),
				h('div', { className: 'ag3-start-name' }, a.name || a.id),
				h('div', { className: 'ag3-start-hint' }, a.description || '（无描述）'),
				h('div', { className: 'ag3-start-acts' },
					h('button', {
						type: 'button', className: 'wb-btn is-primary', 'data-ag-act': 'start-chat',
						onClick: () => { void startSession(a); },
					}, '发起会话'),
					h('button', {
						type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'settings-mid',
						onClick: () => setSettingFor(a.id),
					}, 'Agent 设置')),
				h('div', { className: 'ag3-start-hint' }, '点「发起会话」会在这里开会话，消息实时显示。'));

			/* ── 一条消息 → 气泡（四层嵌套以内，避免括号错位）─────────────────────────
			   role: 'user' 右对齐 / 'assistant' 左对齐 / 'system' 折叠 / 'turn' 分隔线 */
			const bubbleOf = (m) => {
				if (!m) { return null; }
				if (m.role === 'turn') {
					return h('div', { key: m.key, className: 'ag3-turn' }, String(m.text || ''));
				}
				if (m.role === 'system') {
					const txt = String(m.text || '');
					return h('details', { key: m.key, className: 'ag3-sys' },
						h('summary', null, '系统提示 · ' + txt.length + ' 字'),
						h('pre', { className: 'ag3-sys-body' }, txt.slice(0, 6000)));
				}
				const mine = m.role === 'user';
				const text = m.text || (mine ? '（空消息）' : '（这条没有文本）');
				return h('div', {
					key: m.key, className: 'ag3-msgrow' + (mine ? ' is-me' : ''),
					'data-ag-msg': mine ? 'user' : 'assistant',
				},
					h('div', { className: 'ag3-bub' },
						h('div', { className: 'ag3-bub-body' }, text),
						m.error ? h('div', { className: 'ag3-bub-err' }, '⚠ ' + m.error) : null));
			};

			/* ── composer：**复刻 dsh chat-surface**（参数取自真机 `[data-composer-card]`）──
			   28px 圆角 / 无边框 / 三层极轻阴影 / 14px·24px 正文 / 左下「＋」28×28 圆形 /
			   右下发送键 34×34 圆形（↑ 箭头 SVG，不是文字「发送」）。 */
			const sendArrow = () => h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' },
				h('path', {
					d: 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z',
					fill: 'currentColor',
				}));
			const plusIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1.3 },
				h('path', { d: 'M8 2V14', stroke: 'currentColor' }), h('path', { d: 'M2 8H14', stroke: 'currentColor' }));

			/**
			 * @param placeholder 占位文案
			 * @param actKey      data 锚点（chat / group-send）
			 * @param submit      回车 / 点发送要做的事
			 * @param meta        左下角那行说明（模型 / 模式）
			 */
			const composer = (placeholder, actKey, submit, meta, opts) => {
				const o = opts || {};
				const busy = !!o.busy;
				const streaming = !!o.streaming;
				const off = !!o.disabled;
				const hint = busy ? '发送中…' : (streaming ? '生成中…' : (meta || ''));
				const inputProps = {
					className: 'ag3-comp-ta', rows: 1, placeholder, 'aria-label': placeholder,
					'data-ag-composer-input': actKey, disabled: off,
					onKeyDown: (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); } },
				};
				if (actKey === 'chat') {
					inputProps.value = draft;
					inputProps.onChange = (ev) => setDraft(ev.target.value);
				}
				const sendBtn = streaming
					? h('button', {
						type: 'button', className: 'ag3-stop', 'data-ag-act': 'stop',
						'aria-label': '停止生成', title: '停止当前回合', onClick: () => cancelTurn(),
					}, '■')
					: h('button', {
						type: 'button', className: 'ag3-send', 'data-ag-act': actKey,
						'aria-label': '发送消息', disabled: off || busy, title: '发送（真发到当前会话）',
						onClick: () => submit(),
					}, sendArrow());
				return h('div', { className: 'ag3-compwrap', 'data-ag-composer': actKey },
					h('div', { className: 'ag3-compcard' + (off ? ' is-off' : '') },
						h('div', { className: 'ag3-comp-in' }, h('textarea', inputProps)),
						h('div', { className: 'ag3-comp-row' },
							h('button', {
								type: 'button', className: 'ag3-add', 'aria-label': '添加文件或调用指令',
								title: '添加文件或调用指令（在会话里）', onClick: () => submit(),
							}, plusIcon()),
							h('span', { className: 'ag3-comp-meta' }, hint),
							h('span', { className: 'wb-spacer' }),
							sendBtn)));
			};

			/** 中间栏头部（官方对话分支与自绘分支共用，避免两处漂移） */
			const agentHeader = (a, statusText) => h('div', { className: 'ag3-mhd' },
				avatar(a, true),
				h('div', { className: 'ag3-mhd-main' },
					h('div', { className: 'ag3row-l1' },
						h('span', { className: 'ag3-mname', 'data-ag-file-name': String(a.name || a.id) }, a.name || a.id),
						a.role ? pill(a.role, 'role') : null,
						a.registered ? null : pill('未注册', 'warn'),
						live.title ? pill(live.title.slice(0, 16), '') : null),
					h('div', { className: 'ag3row-l2' },
						'会话 ', h('code', { className: 'ag-id' }, liveSessionId ? liveSessionId.slice(0, 12) : '—'),
						' · ', statusText)),
				h('span', { className: 'wb-spacer' }),
				h('button', { type: 'button', className: 'wb-btn', 'data-ag-act': 'delegate', onClick: () => openModuleRoute('/x/agents/', '委派任务') }, '委派任务'));

			const midAgent = (a) => {
				const items = live.items;
				const showStart = !liveSessionId;
				const statusText = live.status === 'ready'
					? ('实时 ' + items.length + ' 条')
					: (live.status === 'connecting' ? '连接中…' : (live.status === 'error' ? '连接异常' : '未连接'));

				/* ★★ 有官方对话节点 ⇒ 中间栏**就是 chat-surface**（2026-10-24 用户第 4 次要求）
				   来源：宿主对 `customFrame` 工作台注入 `props.conversation`
				   （`vssaros-workbenches/lib/client.js:433` = `ConversationMount`，
				    内部是 `SessionProvider` + `conversation.content` 子槽 + portal 停靠）。
				   ⇒ 不自绘气泡、不复刻 composer，直接把官方节点挂进来。
				   ⚠ 该节点只能挂**一处**（React 同一实例不能重复渲染）。 */
				if (nativeConversation) {
					return h('div', { className: 'ag3-m', 'data-ag-mid': 'agent', 'data-ag-native': '1' },
						agentHeader(a, statusText),
						h('div', { className: 'ag3-conv', 'data-ag-conversation': '' }, nativeConversation));
				}

				return h('div', { className: 'ag3-m', 'data-ag-mid': 'agent', 'data-ag-live': live.status, 'data-ag-native': '0' },
					agentHeader(a, statusText),
					live.error ? h('div', { className: 'ag3-err', 'data-ag-live-error': '' }, '⚠ ' + live.error) : null,
					h('div', { className: 'ag3-mlist', 'data-ag-midlist': 'agent', 'data-ag-live-items': String(items.length) },
						showStart ? startCard(a) : null,
						live.status === 'connecting' ? h('p', { className: 'wb-empty' }, '正在连接会话流…') : null,
						(!showStart && live.status === 'ready' && !items.length)
							// 空会话也是**居中起手**（chat-surface 的空态是 hero，不是一行小字）
							? h('div', { className: 'ag3-start', 'data-ag-mid-empty': '' },
								avatar(a, true),
								h('div', { className: 'ag3-start-name' }, a.name || a.id),
								h('div', { className: 'ag3-start-hint' }, '这个会话还没有消息 —— 在下面发一句开始。'))
							: null,
						items.map(bubbleOf)),
					composer('给 ' + (a.name || a.id) + ' 发消息…', 'chat', () => { void sendPrompt(draft); },
						'模型 ' + (a.model || '默认'),
						{ busy: sending, streaming: live.streaming, disabled: !liveSessionId }));
			};


			const midGroup = (g) => {
				const msgs = Array.isArray(g.transcript) ? g.transcript : [];
				return h('div', { className: 'ag3-m', 'data-ag-mid': 'group' },
					h('div', { className: 'ag3-mhd' },
						h('span', { className: 'ag-gmark' }, '#'),
						h('div', { className: 'ag3-mhd-main' },
							h('div', { className: 'ag3row-l1' },
								h('span', { className: 'ag3-mname', 'data-ag-file-name': String(g.name || g.id || '') }, String(g.name || g.id || '?')),
								h('span', { className: 'wb-badge' }, String(g.mode || 'open'))),
							h('div', { className: 'ag3row-l2' }, (Array.isArray(g.members) ? g.members.length : 0) + ' 位成员 · ' + msgs.length + ' 条消息')),
						h('span', { className: 'wb-spacer' }),
						h('button', { type: 'button', className: 'wb-btn', 'data-ag-act': 'group-invite', onClick: () => openModuleRoute('/x/agents/group/' + encodeURIComponent(String(g.id || '')), '群设置') }, '邀请成员'),
						h('button', { type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'group-settings', onClick: () => openModuleRoute('/x/agents/group/' + encodeURIComponent(String(g.id || '')), '群设置') }, '群设置')),
					h('div', { className: 'ag3-mlist', 'data-ag-midlist': 'group' },
						msgs.length
							? msgs.slice(-30).map((m, i) => h('div', { key: 'm' + i, className: 'ag3-msg' },
								h('div', { className: 'ag3-msg-who' }, String(m.who || m.role || m.agentId || '·')),
								h('div', { className: 'ag3-msg-b' }, String(m.text || m.content || '').slice(0, 500))))
							: h('p', { className: 'wb-empty', 'data-ag-mid-empty': '' }, '群里还没有消息。')),
					composer('发消息…', 'group-send',
						() => openModuleRoute('/x/agents/group/' + encodeURIComponent(String(g.id || '')), '群聊'),
						'群聊 · ' + String(g.mode || 'open')));
			};

			/* ══════ 右栏 320：5 个子 tab ══════ */
			const rbody = () => {
				if (rtab === 'recent') {
					const rows = curAgent ? (Array.isArray((home[curAgent.id] || {}).sessions) ? home[curAgent.id].sessions : []) : [];
					if (!curAgent) { return h('p', { className: 'wb-empty' }, '群聊没有"会话"；选中左边某个 agent 再看。'); }
					return rows.length
						? h('div', { 'data-ag-rtab-body': 'recent' }, rows.slice(0, 12).map((s, i) => h('div', {
							key: 'r' + i, className: 'ag3-item ag3-click', role: 'button', tabIndex: 0,
							'data-ag-recent': String(s.id || ''),
							onClick: () => openSessionById(s.id, curAgent),
						}, h('span', { className: 'ag-st' }, '💬'), ' ', String(s.title || '（未命名会话）'),
							h('small', null, ' · ' + String(s.ago) + '前'))))
						: h('p', { className: 'wb-empty', 'data-ag-rtab-body': 'recent' }, '这个 agent 还没有会话。');
				}
				if (rtab === 'ver' || rtab === 'br') {
					// ⚠ 版本 / 分支：插件没暴露 tag/分支接口 ⇒ 如实说明，不编数据。
					const log = (memView.data && Array.isArray(memView.data.log)) ? memView.data.log : [];
					if (rtab === 'ver') {
						return h('div', { 'data-ag-rtab-body': 'ver' },
							log.length
								? h('div', null,
									h('div', { className: 'ag3-sechd' }, '版本 = 记忆提交', h('small', null, String(log.length))),
									log.slice(0, 12).map((c, i) => h('div', { key: 'v' + i, className: 'ag3-item' },
										h('code', null, String(c.hash || c.rev || '').slice(0, 8)), ' ',
										h('small', null, String(c.message || c.subject || '').slice(0, 40)))))
								: h('p', { className: 'wb-empty' }, '还没有记忆提交（也就没有版本）。'),
							h('p', { className: 'ag-hint' }, '打 tag / 删除 tag 是写动作 —— 在',
								h('button', { type: 'button', className: 'wb-btn is-ghost', onClick: () => openModuleRoute('/x/agents/', '完整页') }, '完整页'),
								'做。'));
					}
					return h('div', { 'data-ag-rtab-body': 'br' },
						h('p', { className: 'wb-empty' }, '分支：插件没暴露读取接口（list/switch 都是写动作）。'),
						h('p', { className: 'ag-hint' }, '在',
							h('button', { type: 'button', className: 'wb-btn is-ghost', onClick: () => openModuleRoute('/x/agents/', '完整页') }, '完整页'),
							'看/切分支。'));
				}
				// mem / evo —— 共用同一次 /memory 拉取
				if (memView.status === 'loading') { return h('p', { className: 'wb-empty', 'data-ag-rtab-body': rtab }, '正在读取…'); }
				if (memView.status === 'error') { return h('p', { className: 'wb-empty', 'data-ag-rtab-body': rtab }, '读不到：' + memView.error); }
				const d = memView.data || {};
				const files = Array.isArray(d.files) ? d.files : (Array.isArray(d.listing) ? d.listing : []);
				const log = Array.isArray(d.log) ? d.log : [];
				const primary = String((files[0] && (files[0].name || files[0].file)) || 'MEMORY.md');
				if (!curAgent) {
					return h('p', { className: 'wb-empty', 'data-ag-rtab-body': rtab }, '群聊没有自己的记忆仓库 —— 记忆/演化是每个 agent 各自的 Git。选中左边某个 agent 再看。');
				}
				if (rtab === 'mem') {
					return h('div', { 'data-ag-rtab-body': 'mem' },
						h('div', { className: 'ag3-sechd' }, '记忆文件', h('small', null, String(files.length))),
						files.length
							? files.map((f, i) => {
								const name = String((f && (f.name || f.file)) || f || '');
								const pin = /^(SOUL|MEMORY)\.md$/i.test(name);
								return h('div', {
									key: 'f' + i, className: 'ag3-item ag3-click', role: 'button', tabIndex: 0,
									'data-ag-mem-file': name, onClick: () => { void openMemFile(name); },
								}, h('span', null, pin ? '📌' : '📄'), ' ', name,
									pin ? h('span', { className: 'wb-badge' }, '常驻') : null,
									f && f.bytes !== undefined ? h('small', null, ' · ' + f.bytes + ' B') : null);
							})
							: h('p', { className: 'wb-empty' }, '没有记忆文件。'),
						h('div', { className: 'ag3-sechd', style: { marginTop: '6px' } }, 'Git 历史', h('small', null, String(log.length))),
						log.length
							? log.slice(0, 10).map((c, i) => h('div', {
								key: 'c' + i, className: 'ag3-item ag3-click', role: 'button', tabIndex: 0,
								'data-ag-mem-rev': String(c.hash || c.rev || ''),
								onClick: () => { void openMemFile(primary, String(c.hash || c.rev || '')); },
							}, h('span', { className: 'ag-st' }, '🕘'), ' ',
								String(c.message || c.subject || '').slice(0, 40),
								h('small', null, ' · ' + String(c.hash || c.rev || '').slice(0, 8))))
							: h('p', { className: 'wb-empty' }, '还没有记忆提交。'),
						memFile
							? h('div', { className: 'ag3-memview', 'data-ag-mem-view': '' },
								h('div', { className: 'ag3-sechd' }, String(memFile.title || ''),
									h('button', { type: 'button', className: 'wb-btn is-ghost ag3-mini', onClick: () => setMemFile(null) }, '✕')),
								memFile.loading
									? h('p', { className: 'wb-empty' }, '读取中…')
									: (memFile.error
										? h('p', { className: 'wb-empty' }, '读不到：' + memFile.error)
										: h('pre', { className: 'wb-pre' }, String(memFile.content || '（空）'))))
							: null);
				}
				// evo
				return h('div', { 'data-ag-rtab-body': 'evo' },
					h('div', { className: 'ag3-sechd' }, '提交时间线', h('small', null, String(log.length))),
					log.length
						? log.slice(0, 12).map((c, i) => {
							const rev = String(c.hash || c.rev || '');
							return h('div', {
								key: 'e' + i, className: 'ag3-item ag3-click', role: 'button', tabIndex: 0,
								'data-ag-evo-diff': rev, onClick: () => { void openEvoDiff(rev, primary); },
							}, h('code', null, rev.slice(0, 8)), ' ',
								h('small', null, String(c.message || c.subject || '').slice(0, 40)),
								h('span', { className: 'wb-spacer' }), h('span', { className: 'ag-st' }, '看 diff'));
						})
						: h('p', { className: 'wb-empty' }, '没有历史版本（记忆目录可能还没启用 Git）。'),
					evoDiff
						? h('div', { className: 'ag3-memview', 'data-ag-evo-diffview': '' },
							h('div', { className: 'ag3-sechd' }, String(evoDiff.title || ''),
								h('span', { className: 'wb-badge' }, '+' + String(evoDiff.added ?? '?') + ' / -' + String(evoDiff.removed ?? '?')),
								h('button', { type: 'button', className: 'wb-btn is-ghost ag3-mini', onClick: () => setEvoDiff(null) }, '✕')),
							evoDiff.loading
								? h('p', { className: 'wb-empty' }, '正在算差异…')
								: (evoDiff.error
									? h('p', { className: 'wb-empty' }, '算不出来：' + evoDiff.error)
									: h('pre', { className: 'wb-pre', 'data-ag-evo-rows': String((evoDiff.rows || []).length) },
										(evoDiff.rows || []).map(r => (r.type === 'add' ? '+ ' : r.type === 'del' ? '- ' : '  ') + String(r.text ?? '')).join('\n'))))
						: h('p', { className: 'ag-hint' }, '点一条提交看它与当前工作区的逐行差异（只读）；回滚在完整页。'));
			};

			const rightPane = h('div', { className: 'ag3-r', 'data-ag-right': '' },
				h('div', { className: 'ag3-rhd' },
					h('b', null, sel.kind === 'group' ? (curGroup ? String(curGroup.name || '群聊') : '群聊') : (curAgent ? String(curAgent.name || curAgent.id) : '—')),
					h('span', { className: 'wb-spacer' }),
					curAgent ? h('small', null, '会话 ' + String((home[curAgent.id] || {}).sessionsTotal || 0)) : null),
				h('div', { className: 'ag3-rtabs', 'data-ag-rtabs': '' },
					RTABS.map(t => h('button', {
						key: t.k, type: 'button', 'data-ag-rtab': t.k,
						className: 'ag3-rtab' + (rtab === t.k ? ' is-on' : ''),
						onClick: () => { setRtab(t.k); setMemFile(null); setEvoDiff(null); },
					}, t.icon + ' ' + t.label))),
				h('div', { className: 'ag3-rbody', 'data-ag-rbody': '' }, rbody()));

			/* ══════ 顶部其它三个页签 ══════ */
			const usagePanel = () => {
				const d = tabView.data || {};
				const rows = Array.isArray(d.agents) ? d.agents : [];
				const totals = d.totals || {};
				// ⚠ `??` 不能和 `&&`/`||` 直接混用（SyntaxError）⇒ 先归一再算
				const tokOf = (r) => {
					const t = r.tokens;
					const n = (t && typeof t === 'object') ? (t.total ?? t.output ?? 0) : (t || 0);
					return Number(n) || 0;
				};
				const max = Math.max(...rows.map(tokOf), 1);
				return h('div', { className: 'ag-panel', 'data-ag-panel': 'usage' },
					h('div', { className: 'ag3-statgrid' },
						h('div', { className: 'ag3-stat' }, h('b', null, String(d.sessions ?? '—')), h('span', null, '会话总数')),
						h('div', { className: 'ag3-stat' }, h('b', null, String(totals.tokens ?? totals.totalTokens ?? '—')), h('span', null, 'token')),
						h('div', { className: 'ag3-stat' }, h('b', null, String(rows.length)), h('span', null, '有会话的 agent')),
						h('div', { className: 'ag3-stat' }, h('b', null, String(agents.filter(a => !a.registered).length)), h('span', null, '未注册'))),
					rows.length
						? h('table', { className: 'wb-table' },
							h('thead', null, h('tr', null, h('th', null, 'Agent'), h('th', null, '会话'), h('th', null, '回合'), h('th', null, 'token'), h('th', null, '占比'))),
							h('tbody', null, rows.map((a, i) => {
								const tok = tokOf(a);
								return h('tr', { key: 'u' + i },
									h('td', null, h('code', null, String(a.agentId || a.id || '?'))),
									h('td', null, String(a.sessions ?? '—')),
									h('td', null, String(a.turns ?? '—')),
									h('td', null, String(tok)),
									h('td', null, h('span', { className: 'ag3-bar', style: { width: Math.max(4, Math.round(tok / max * 100)) + '%' } }, '')));
							})))
						: h('p', { className: 'wb-empty' }, '还没有可统计的会话。'),
					(d.errors || []).length ? h('p', { className: 'wb-diag' }, (d.errors || []).slice(0, 2).join('；')) : null);
			};

			const assignPanel = () => {
				const d = tabView.data || {};
				const items = Array.isArray(d.items) ? d.items : [];
				return h('div', { className: 'ag-panel', 'data-ag-panel': 'assign' },
					h('p', { className: 'wb-diag' }, '台账 ' + items.length + ' 条 · 运行中 ' + String(d.running ?? 0) + ' / 上限 ' + String(d.cap ?? '—'), '（内存态，Host 重启清空 —— 如实写 ✓）'),
					items.length
						? h('table', { className: 'wb-table' },
							h('thead', null, h('tr', null, h('th', null, '状态'), h('th', null, 'Agent'), h('th', null, '任务'), h('th', null, '耗时/错误'))),
							h('tbody', null, items.slice(0, 50).map((row, i) => h('tr', { key: 'a' + i },
								h('td', null, h('span', { className: 'wb-badge ' + (row.status === 'running' ? 'role' : row.status === 'done' ? '' : 'warn') }, String(row.status || '?'))),
								h('td', null, h('code', null, String(row.agentId || '?'))),
								h('td', null, String(row.task || row.title || row.prompt || '（无描述）').slice(0, 80)),
								h('td', null, row.error ? String(row.error).slice(0, 60) : (row.ms ? Math.round(row.ms / 1000) + 's' : '—'))))))
						: h('p', { className: 'wb-empty' }, '台账里还没有委派记录。'));
			};

			const authPanel = () => {
				const d = tabView.data || {};
				const tpl = d.templates || {};
				const tools = Array.isArray(tpl.tools) ? tpl.tools : [];
				const templates = Array.isArray(tpl.templates) ? tpl.templates : [];
				const outbox = (d.outbox && Array.isArray(d.outbox.entries)) ? d.outbox.entries : [];
				return h('div', { className: 'ag-panel', 'data-ag-panel': 'auth' },
					h('p', { className: 'wb-diag' }, '能力声明（.agent.md 的 tools allowlist）', tools.length ? '：' : '：（无）', h('code', null, tools.slice(0, 12).join(', ') + (tools.length > 12 ? ' …' : ''))),
					h('div', { className: 'wb-group-hd' }, '审批模板 ', h('small', null, templates.length + ' 个')),
					templates.length
						? h('ul', { className: 'wb-ul' }, templates.slice(0, 10).map((t, i) => h('li', { key: 't' + i }, h('code', null, String(t.name || t.id || '?')), ' · ', String(t.tool || t.action || ''), ' · ', String(t.decision || t.mode || ''))))
						: h('p', { className: 'wb-empty' }, '还没有审批模板。'),
					h('div', { className: 'wb-group-hd' }, '发件箱（outbox） ', h('small', null, outbox.length + ' 条')),
					outbox.length
						? h('ul', { className: 'wb-ul' }, outbox.slice(0, 10).map((e, i) => h('li', { key: 'o' + i }, h('span', { className: 'wb-badge ' + (e.status === 'pending' ? 'warn' : '') }, String(e.status || '?')), ' ', h('code', null, String(e.tool || e.kind || '?')), ' · ', String(e.sentAt ? new Date(e.sentAt).toLocaleTimeString('zh-CN') : ''))))
						: h('p', { className: 'wb-empty' }, '发件箱是空的。'),
					h('p', { className: 'ag-hint' }, '重发 / 改模板 / 授权确认这些**写动作**仍在完整页 —— ',
						h('button', { type: 'button', className: 'wb-btn is-ghost', onClick: () => openModuleRoute('/x/agents/', '完整页') }, '去完整页 ↗')));
			};

			const rosterPane = () => {
				if (view.status === 'loading' && !data) { return h('p', { className: 'wb-empty', 'data-ag-state': 'loading' }, '正在读取名册…'); }
				if (!visible.length && !groups.length) {
					return h('p', { className: 'wb-empty', 'data-ag-empty': '' }, agents.length ? '没有匹配的 agent。' : '还没有可用的 agent（每个子目录需要一个带 name 的 .agent.md）。');
				}
				return h('div', { className: 'ag3' },
					leftPane,
					sel.kind === 'group'
						? (curGroup ? midGroup(curGroup) : h('div', { className: 'ag3-m' }, h('p', { className: 'wb-empty' }, '这个群不存在了。')))
						: (curAgent ? midAgent(curAgent) : h('div', { className: 'ag3-m' }, h('p', { className: 'wb-empty' }, '左边选一个 agent 或群聊。'))),
					rightPane);
			};

			return h('div', { className: 'wb wb-ag', 'data-vssaros-page': 'agents', 'data-vssaros-surface': 'workbench' },
				h('header', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' },
					h('h1', null, 'Bots'),
					h('span', { className: 'wb-sub' }, data
						? agents.length + ' 个 · 已注册 ' + registeredCount + ' / 花名册 ' + roster.length + ' · 群聊 ' + groups.length
						: '只读'),
					h('span', { className: 'wb-spacer' }),
					tab === 'roster' ? h('input', {
						className: 'wb-input ag-search', value: q, placeholder: '筛选', 'aria-label': '筛选 agent',
						'data-ag-search': '', onChange: (ev) => setQ(ev.target.value),
					}) : null,
					h('button', {
						type: 'button', className: 'wb-btn ag-refresh' + (refreshing ? ' is-busy' : ''),
						'data-ag-act': 'refresh', 'aria-busy': refreshing ? 'true' : 'false', disabled: refreshing,
						title: refreshing ? '正在刷新…' : '重新读取（GET /x/agents/api/home）',
						onClick: () => { void load(); setGroupsView({ status: 'idle', data: null, error: '' }); },
					}, refreshing ? '⟳ 刷新中…' : '⟳ 刷新'),
					h('button', {
						type: 'button', className: 'wb-btn is-primary', 'data-ag-act': 'full',
						title: '写动作（回滚 / 提交快照 / 改审批模板 / 建群）仍在完整页',
						onClick: () => openModuleRoute('/x/agents/', '完整页'),
					}, '完整页 ↗')),
				// T3 页签（4 个）
				h('nav', { className: 'ag3-tabs', role: 'tablist', 'data-ag-tabs': '' },
					TABS.map(t => h('button', {
						key: t.k, type: 'button', role: 'tab', 'data-ag-tab': t.k,
						'aria-selected': tab === t.k ? 'true' : 'false',
						className: 'ag3-tab' + (tab === t.k ? ' is-on' : ''),
						onClick: () => setTab(t.k),
					}, t.icon + ' ' + t.label,
						t.k === 'roster' ? h('span', { className: 'ag3-tabn' }, String(agents.length)) : null,
						t.k === 'assign' && tabView.data && tabView.data.running ? h('span', { className: 'ag3-tabn' }, String(tabView.data.running)) : null))),
				tab !== 'roster' && tabView.status === 'loading' ? h('p', { className: 'wb-empty', 'data-ag-state': 'loading' }, '正在读取…') : null,
				tab !== 'roster' && tabView.status === 'error' ? h('p', { className: 'wb-empty', 'data-ag-state': 'error', role: 'alert' }, '读取失败：' + tabView.error) : null,
				tab === 'usage' && tabView.status === 'ready' ? usagePanel() : null,
				tab === 'assign' && tabView.status === 'ready' ? assignPanel() : null,
				tab === 'auth' && tabView.status === 'ready' ? authPanel() : null,
				view.status === 'error'
					? h('p', { className: 'wb-empty', 'data-ag-state': 'error', role: 'alert' }, '读取失败：' + view.error)
					: null,
				tab === 'roster' && data && data.missing ? h('p', { className: 'wb-empty' }, 'agent 目录还不存在：', h('code', null, data.missing)) : null,
				tab === 'roster' ? rosterPane() : null,
				settingFor ? (() => {
					const a = agents.find(x => x.id === settingFor);
					if (!a) { return null; }
					return h('div', { className: 'ag3-mask', 'data-ag-settings': a.id, onClick: () => setSettingFor('') },
						h('div', { className: 'ag3-dlg', onClick: (ev) => ev.stopPropagation() },
							h('div', { className: 'ag3-dlg-hd' },
								h('b', null, 'Agent 设置 · ' + String(a.name || a.id)),
								h('span', { className: 'wb-spacer' }),
								h('button', { type: 'button', className: 'wb-btn is-ghost ag3-mini', 'data-ag-act': 'settings-close', onClick: () => setSettingFor('') }, '✕')),
							h('div', { className: 'ag3-dlg-bd' },
								h('div', { className: 'ag3-kv' }, h('span', null, 'id'), h('code', null, String(a.id))),
								h('div', { className: 'ag3-kv' }, h('span', null, '预设'), h('code', null, String(a.presetId || '—'))),
								h('div', { className: 'ag3-kv' }, h('span', null, '模型'), h('code', null, String(a.model || '跟随默认模型'))),
								h('div', { className: 'ag3-kv' }, h('span', null, '注册'), h('span', null, a.registered ? '已注册' : '未注册（花名册里没有 preset）')),
								h('div', { className: 'ag3-kv' }, h('span', null, '工具 / 人设'), h('span', null, String(a.toolCount || 0) + ' 个工具 · ' + String(a.personaBytes || 0) + ' 字人设')),
								h('div', { className: 'ag3-kv' }, h('span', null, '描述'), h('span', null, a.description || '（无描述）')),
								h('p', { className: 'ag-hint' }, '改人设正文 / 模型 / 工具是**写动作**，在完整页做（这里只读，避免开编辑器页 —— 桌面窗口里那会黑屏）。')),
							h('div', { className: 'ag3-dlg-ft' },
								h('button', { type: 'button', className: 'wb-btn', 'data-ag-act': 'settings-full', onClick: () => { setSettingFor(''); openModuleRoute('/x/agents/', '完整页'); } }, '去完整页改'),
								h('button', { type: 'button', className: 'wb-btn is-ghost', onClick: () => setSettingFor('') }, '关闭'))));
				})() : null,
				data && (data.errors || []).length
					? h('p', { className: 'wb-diag' }, (data.errors || []).slice(0, 3).join('；'))
					: null,
				data ? h('p', { className: 'wb-diag', 'data-vssaros-agents-count': String(summary.count ?? agents.length), 'data-vssaros-roster': roster.join(','), 'data-vssaros-agents-root': String(data.root || '') },
					'根目录 ', h('code', null, String(data.root || '')), ' · 实况 ', data.live ? String(data.live.sessions) + ' 会话' : '（读不到）') : null);
		}

		const STYLE_ID = 'vssaros-agents-workbench-layout';
		// 通用视觉交给共享层（宿主注入的 `wb-*`）；这里只留三栏工作台特有的东西。
		// ⚠ 用户可见色**只走** `--dsw-alias-*`（兜底值仅用于宿主没注入令牌时）+ `--wb-*` 刻度。
		const CSS = `
.wb-ag { overflow:hidden; display:flex; flex-direction:column; min-height:0; position:relative; }
/* 「Agent 设置」站内弹层（不碰编辑器 ⇒ 桌面窗口不会黑屏）*/
/* ⚠ 共享层没有"遮罩/阴影"令牌（'--wb-*' 只有字号/间距/圆角/等宽字体）⇒ 用 'var(..., 兜底)'
   包住（守卫口径：行内有 'var(--' 即合规；阴影是黑色半透明，明暗两套都可接受）。 */
.ag3-mask { position:absolute; inset:0; z-index:30; display:flex; align-items:center; justify-content:center;
  background:var(--wb-scrim, rgba(0,0,0,.35)); }
.ag3-dlg { width:min(460px, 92%); max-height:82%; display:flex; flex-direction:column; border-radius:var(--wb-r-md);
  background:var(--dsw-alias-bg-layer-1, #262626); border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
  box-shadow:var(--wb-shadow-dialog, 0 16px 44px rgba(0,0,0,.35)); }
.ag3-dlg-hd { display:flex; align-items:center; gap:var(--wb-s1); padding:var(--wb-s2) var(--wb-s3);
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); font-size:var(--wb-f-xs); }
.ag3-dlg-bd { padding:var(--wb-s3); overflow:auto; display:flex; flex-direction:column; gap:5px; }
.ag3-kv { display:flex; gap:var(--wb-s2); font-size:var(--wb-f-xs); align-items:baseline; }
.ag3-kv > span:first-child { min-width:74px; flex:0 0 auto; color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.ag3-dlg-ft { display:flex; gap:var(--wb-s1); justify-content:flex-end; padding:var(--wb-s2) var(--wb-s3);
  border-top:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); }
.wb-ag a.wb-btn { text-decoration:none; }
.wb-ag .wb-ul small { color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.wb-badge.warn, .wb-badge.att { color: var(--dsw-alias-state-warn-primary, #e0a43a); }
.wb-badge.role { color: var(--dsw-alias-brand-text, #4C9AFF); }
.ag-search { max-width:170px; min-width:70px; }
.ag-refresh.is-busy { opacity:.65; cursor:progress; }
/* ── T3 页签：图标+文字+数字 pill+2px 下划线（与 mockup 的 .t3tab 同参数）── */
.ag3-tabs { display:flex; gap:2px; padding:0 var(--wb-s3); border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); flex:none; overflow-x:auto; }
.ag3-tabs::-webkit-scrollbar { height:0; }
.ag3-tab { height:34px; padding:0 10px; font:inherit; font-size:var(--wb-f-xs); color:var(--dsw-alias-label-secondary, rgba(230,230,230,.8));
  background:transparent; border:0; cursor:pointer; position:relative; display:inline-flex; align-items:center; gap:6px; white-space:nowrap; flex:none; }
.ag3-tab:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); color:var(--dsw-alias-label-primary, currentColor); }
.ag3-tab.is-on { color:var(--dsw-alias-label-primary, currentColor); font-weight:600; }
.ag3-tab.is-on::after { content:""; position:absolute; left:8px; right:8px; bottom:-1px; height:2px; border-radius:2px; background:var(--dsw-alias-brand-primary, #007fd4); }
.ag3-tabn { min-width:15px; height:15px; padding:0 4px; border-radius:8px; background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2));
  color:var(--dsw-alias-label-secondary, rgba(230,230,230,.8)); font-size:10px; display:inline-flex; align-items:center; justify-content:center; }
.ag3-tab.is-on .ag3-tabn { background:var(--dsw-alias-brand-primary, #007fd4); color:var(--dsw-alias-label-primary-inverted, #fff); }
/* ── 三栏：236 / 弹性 / 320（与 mockup 一致）── */
.ag3 { display:flex; flex:1 1 auto; min-height:0; container-type:inline-size; }
.ag3-l { width:236px; flex:0 0 236px; min-width:0; overflow:auto; border-right:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); padding:var(--wb-s1) 0; }
.ag3-m { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; min-height:0; }
.ag3-r { width:320px; flex:0 0 320px; min-width:0; display:flex; flex-direction:column; min-height:0;
  border-left:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); }
/* 窄容器：先收右栏（信息密度让位给会话），再窄就只剩左 + 中 */
/* 2026-10-24：原来用 @media 判宽 —— 但工作台在 sideview / 右栏里时**窗口很宽、容器很窄**，
   @media 判不出来（同窗不同宽）⇒ 改成容器查询（与 doc/workbench-standard-compliance.md 的 S9/S10 对齐）。 */
@container (max-width: 1100px) { .ag3-r { width:260px; flex-basis:260px; } }
@container (max-width: 860px) { .ag3-r { display:none; } .ag3-l { width:200px; flex-basis:200px; } }
@container (max-width: 560px) { .ag3-l { display:none; } .ag3-tabs { padding:0 var(--wb-s2); } }
/* 左栏行 */
.ag3-sechd { display:flex; align-items:center; gap:6px; padding:var(--wb-s1) var(--wb-s3) 2px; font-size:10px; letter-spacing:.4px;
  text-transform:uppercase; color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.ag3-sechd small { margin-left:auto; }
.ag3-mini { height:18px; padding:0 5px; font-size:10px; }
.ag3-tip { padding:0 var(--wb-s3) var(--wb-s2); }
.ag3row { display:flex; align-items:center; gap:var(--wb-s2); padding:5px var(--wb-s3); cursor:pointer; border-left:2px solid transparent; }
.ag3row:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.ag3row.is-on { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); border-left-color:var(--dsw-alias-brand-primary, #007fd4); }
.ag3row.is-unreg { opacity:.85; }
.ag3row-main { min-width:0; flex:1 1 auto; display:flex; flex-direction:column; gap:1px; }
.ag3row-l1 { display:flex; align-items:center; gap:var(--wb-s1); min-width:0; }
.ag3row-l2 { font-size:10px; color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.65)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ag-avatar { width:24px; height:24px; border-radius:6px; display:flex; align-items:center; justify-content:center;
  font-size:var(--wb-f-xs); font-weight:600; color:var(--dsw-alias-label-primary-inverted, #fff); flex:0 0 auto; }
.ag-avatar-lg { width:34px; height:34px; border-radius:var(--wb-r-md); font-size:var(--wb-f-md); }
.ag-name { font-size:var(--wb-f-xs); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ag-id { font-family:var(--wb-mono); font-size:10px; }
.ag-numb { min-width:15px; height:15px; padding:0 4px; border-radius:8px; background:var(--dsw-alias-brand-primary, #007fd4);
  color:var(--dsw-alias-label-primary-inverted, #fff); font-size:10px; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; }
.ag-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-label-tertiary, rgba(127,127,127,.6)); flex:0 0 auto; }
.ag-dot.is-run { background:var(--dsw-alias-state-warn-primary, #e0a43a); }
.ag-gmark { width:22px; height:22px; border-radius:6px; display:flex; align-items:center; justify-content:center;
  font-weight:700; font-size:var(--wb-f-xs); color:var(--dsw-alias-label-primary-inverted, #fff); flex:0 0 auto;
  background:var(--dsw-alias-brand-primary, #007fd4); }
/* 中间栏 */
.ag3-mhd { display:flex; align-items:center; gap:var(--wb-s2); padding:var(--wb-s2) var(--wb-s3); flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); }
.ag3-mhd-main { min-width:0; flex:1 1 auto; display:flex; flex-direction:column; gap:1px; }
.ag3-mname { font-size:var(--wb-f-md); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* ⚠ 消息列必须和 composer **同宽居中**（2026-10-23 用户报"不像 chat-surface"）：
   之前消息贴边撑满整栏（844），而 composer 是 774 居中 ⇒ 两者不在一条中轴线上，
   一眼就不像。chat-surface 里消息列与输入框同宽（实测 774）、同中轴。 */
.ag3-mlist { flex:1 1 auto; min-height:0; overflow:auto; padding:var(--wb-s2) 16px; display:flex; flex-direction:column; gap:2px; }
.ag3-mlist > .ag3-msgrow,
.ag3-mlist > .ag3-turn,
.ag3-mlist > .ag3-sys,
.ag3-mlist > .wb-empty { width:100%; max-width:774px; margin-left:auto; margin-right:auto; }
.ag3-item { font-size:var(--wb-f-xs); padding:4px 6px; border-radius:var(--wb-r-sm); display:flex; align-items:center; gap:var(--wb-s1); min-width:0; }
.ag3-item:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.ag3-item small { color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ag3-click { cursor:pointer; }
.ag3-msg { padding:4px 0; display:flex; flex-direction:column; gap:1px; }
.ag3-msg-who { font-size:10px; color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.ag3-msg-b { font-size:var(--wb-f-xs); white-space:pre-wrap; word-break:break-word; }
/* ── composer：复刻 dsh chat-surface（真机 [data-composer-card] 的参数）──
   28px 圆角 / 无边框 / 三层极轻阴影 / 14px·24px；左下「＋」28×28；右下发送 34×34 圆形 */
.ag3-compwrap { flex:none; padding:0 16px 32px; }
.ag3-compcard { border:0; border-radius:28px; padding:8px 0 0; max-width:774px; margin:0 auto;
  background:var(--wb-comp-bg, rgba(255,255,255,.06));
  box-shadow:var(--wb-shadow-card, 0 0 0 .5px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.03), 0 0 24px rgba(0,0,0,.03)); }
.ag3-comp-in { padding:0 18px 4px; }
.ag3-comp-ta { width:100%; min-height:64px; max-height:132px; resize:none; border:0; outline:none; background:transparent;
  color:var(--dsw-alias-label-primary, inherit); font:inherit; font-size:14px; line-height:24px; }
.ag3-comp-ta::placeholder { color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.5)); }
.ag3-comp-row { display:flex; align-items:center; gap:8px; padding:0 10px 10px; }
.ag3-add { width:28px; height:28px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto;
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); background:transparent; color:var(--dsw-alias-label-secondary, inherit); cursor:pointer; }
.ag3-add:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.ag3-comp-meta { font-size:11px; color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ag3-send { width:34px; height:34px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto;
  border:0; background:var(--dsw-alias-brand-primary, #007fd4); color:var(--dsw-alias-label-primary-inverted, #fff); cursor:pointer; }
.ag3-send:hover { opacity:.9; }
/* 中间栏空态（像 dsh 的起手，不是一行干巴巴的 empty）*/
.ag3-start { margin:auto; display:flex; flex-direction:column; align-items:center; gap:6px; padding:24px 12px; text-align:center; }
.ag3-start-name { font-size:var(--wb-f-md); font-weight:600; }
.ag3-start-hint { font-size:var(--wb-f-xs); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.65)); max-width:36em; }
.ag3-start-acts { display:flex; gap:var(--wb-s1); margin-top:6px; flex-wrap:wrap; justify-content:center; }
.ag3-sess { padding:6px 8px; }
/* 右栏 */
.ag3-rhd { display:flex; align-items:center; gap:var(--wb-s1); padding:var(--wb-s2) var(--wb-s3); flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); font-size:var(--wb-f-xs); }
.ag3-rtabs { display:flex; gap:2px; padding:var(--wb-s1) var(--wb-s2); flex:none; flex-wrap:wrap;
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); }
.ag3-rtab { height:22px; padding:0 7px; border-radius:var(--wb-r-sm); font:inherit; font-size:10.5px; cursor:pointer;
  border:0; background:transparent; color:var(--dsw-alias-label-secondary, rgba(230,230,230,.8)); display:inline-flex; align-items:center; gap:4px; }
.ag3-rtab:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); color:var(--dsw-alias-label-primary, currentColor); }
.ag3-rtab.is-on { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); color:var(--dsw-alias-label-primary, currentColor); font-weight:600; }
.ag3-rbody { flex:1 1 auto; min-height:0; overflow:auto; padding:var(--wb-s2); }
.ag3-memview { margin-top:var(--wb-s2); border-top:1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.25)); padding-top:var(--wb-s1); }
.ag3-statgrid { display:grid; grid-template-columns:repeat(auto-fit, minmax(80px, 1fr)); gap:var(--wb-s1); margin-bottom:var(--wb-s2); }
.ag3-stat { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius:var(--wb-r-sm); padding:6px 8px; display:flex; flex-direction:column; gap:1px; }
.ag3-stat b { font-size:var(--wb-f-md); font-variant-numeric:tabular-nums; }
.ag3-stat span { font-size:10px; color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.ag3-bar { display:block; height:6px; border-radius:3px; background:var(--dsw-alias-brand-primary, #007fd4); min-width:2px; }
.ag-panel { display:flex; flex-direction:column; gap:var(--wb-s2); min-width:0; overflow:auto; padding:var(--wb-s3); }
.ag-st { color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); }
.ag-hint { margin:0; font-size:var(--wb-f-xs); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.ag-hint a { color:var(--dsw-alias-brand-text, currentColor); }
.ag-hint .wb-btn { height:18px; padding:0 5px; font-size:10px; }

/* ── 真聊天（第 2 步）：气泡 / 系统折叠 / 轮次分隔 / 停止键 / 错误条 ──
   本注释内禁止出现反引号（模板字符串会提前闭合，整份 CSS 失效）。 */
.ag3-msgrow { display:flex; padding:2px 0; }
.ag3-msgrow.is-me { justify-content:flex-end; }
.ag3-bub { max-width:86%; border-radius:10px; padding:6px 10px;
  background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10)); }
.ag3-msgrow.is-me .ag3-bub { background:var(--dsw-alias-brand-primary, #007fd4);
  color:var(--dsw-alias-label-primary-inverted, #fff); }
.ag3-bub-body { white-space:pre-wrap; word-break:break-word; font-size:12px; line-height:1.6; }
.ag3-bub-err { margin-top:4px; font-size:11px; color:var(--dsw-alias-state-error-primary, #c0392b); }
.ag3-turn { text-align:center; font-size:10px; padding:6px 0;
  color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.ag3-sys { font-size:10px; padding:2px 0; color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.65)); }
.ag3-sys summary { cursor:pointer; }
.ag3-sys-body { margin:4px 0 0; max-height:150px; overflow:auto; white-space:pre-wrap; font-size:10px; }
.ag3-stop { width:34px; height:34px; border-radius:50%; border:0; flex:0 0 auto; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center; font-size:14px;
  background:var(--dsw-alias-state-error-primary, #c0392b); color:var(--dsw-alias-label-primary-inverted, #fff); }
.ag3-compcard.is-off { opacity:.6; }
.ag3-err { margin:0 var(--wb-s3) var(--wb-s1); padding:6px 10px; border-radius:var(--wb-r-sm); font-size:11px;
  color:var(--dsw-alias-state-error-primary, #c0392b);
  border:1px solid var(--dsw-alias-state-error-primary, rgba(192,57,43,.5)); background:transparent; }
.ag3-dim { opacity:.6; }

/* ── 左栏 item：hover 时「状态点」原地换成「设置键」（不额外占宽，窄容器也不挤）── */
.ag3row { position:relative; }
.ag3row-set { position:absolute; right:6px; top:50%; transform:translateY(-50%);
  width:22px; height:22px; padding:0; display:none; align-items:center; justify-content:center;
  border:0; border-radius:var(--wb-r-sm); background:transparent; cursor:pointer;
  color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.65)); }
.ag3row:hover .ag3row-set, .ag3row-set:focus-visible { display:inline-flex; }
.ag3row:hover > .ag-dot { display:none; }
.ag3row-set:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14));
  color:var(--dsw-alias-label-primary, inherit); }
/* ── 拖拽排序：可拖的行给 grab 光标，拖动中的行淡出 ── */
.ag3row[draggable="true"] { cursor:grab; }
.ag3row.is-drag { opacity:.45; }
.ag3row[draggable="true"]:hover { box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1, rgba(127,127,127,.28)); }

/* ── 官方对话停靠容器（2026-10-24）：宿主把 chat-surface 的 conversation 节点 portal 进来
   ⇒ 这里只负责"撑满中间栏剩余高度"，**不画任何气泡/composer**（那是官方的）。
   ⚠ 官方节点外层是 div.vssWbDockHost > div.vssWbDock（未停靠时 hidden） */
.ag3-conv { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.ag3-conv > * { flex:1 1 auto; min-height:0; }
.ag3-conv .vssWbDockHost { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
.ag3-conv .vssWbDock { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
`;

		function ensureStyle() {
			if (typeof document === 'undefined') { return; }
			let el = document.getElementById(STYLE_ID);
			if (!el) {
				el = document.createElement('style');
				el.id = STYLE_ID;
				document.head.appendChild(el);
			}
			if (el.textContent !== CSS) { el.textContent = CSS; }
		}

		/* 组件包装：注入样式（懒一次）后渲染面板。
		   ⚠⚠ 2026-10-24：**必须把 props 透传下去**。
		   宿主对 `customFrame: true` 的工作台会额外塞两个 prop
		   （`dsh-plugins/vssaros-workbenches/lib/client.js:433`）：
		     props.active       —— 当前是否前台
		     props.conversation —— **官方对话的停靠节点**（SessionProvider + conversation.content）
		   之前这里写成 `AgentsRoot()` 无参 + `h(AgentsPanel, null)` ⇒ 把官方对话**丢掉了**，
		   所以中间栏只能自绘。（小红书工作台就是接了 `props.conversation` 才显示真聊天窗的。） */
		function AgentsRoot(props) {
			useEffect(() => { ensureStyle(); }, []);
			return h(AgentsPanel, props || null);
		}

		function install(ctx) {
			// 样式**在注册前**就注入（不然首帧是三栏裸布局，看起来像"布局错了"✗）
			try { ensureStyle(); } catch (e) { /* DOM 还没好就等组件挂载时再注入 */ }
			ctx.effect(() => {
				ctx.inject(['desktopWorkbenches'], (c) => {
					c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, AgentsRoot), 'vssaros-agents: workbench');
				});
			}, 'vssaros-agents: client');
		}

		module.exports = { install, AgentsRoot, AgentsPanel };
		return module.exports;
	},
});
