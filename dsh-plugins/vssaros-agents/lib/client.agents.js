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
		const { useState, useEffect, useCallback, useRef } = react;

		const API = '/x/agents/api';
		/** 快速来回切 bot 时防止把同一只反复建成一串会话（模块级 ⇒ 跨渲染保留） */
		const BOT_SESSION_PENDING = new Set();

		/* ══ 群聊 `@` 提及：纯函数（2026-10-26）════════════════════════════════════
		   为什么在 chunk 里再写一份：客户端 chunk **不能** import 服务端文件
		   （装载器只认 `client.*.js` 的相对请求），而服务端/单测要用同一套规则。
		   ⇒ 服务端权威实现在 `lib/mentions.js`（有 29 条单测），这里是同语义的紧凑版；
		     `p3-197` 会把下面 `@MENTIONS-BEGIN/END` 之间的代码抽出来跑同一批向量，
		     两边行为一旦漂移，那条守卫直接红 ⇒ 不会静默分叉。
		   规则同 `lib/mentions.js` 头注释（token = `@` + agent.id，因为 bot 名含空格）。 */
		/* @MENTIONS-BEGIN */
		const AT_ALL = '所有人';
		const AT_MAX = 8;
		const AT_MAXQ = 34;
		const AT_WORD = /[A-Za-z0-9._%+-]/u;

		/** 当前是否正在输入 `@` ⇒ { start, end, query } | undefined */
		const atQuery = (value, caret) => {
			const text = String(value == null ? '' : value);
			const pos = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), text.length) : text.length;
			const start = text.lastIndexOf('@', pos - 1);
			if (start < 0 || pos - start > AT_MAXQ) { return undefined; }
			if (pos <= start) { return undefined; }            // caret 在 @ 之前（lastIndexOf(-1) 的坑）
			if (start > 0 && AT_WORD.test(text[start - 1])) { return undefined; }   // 邮箱不触发
			const query = text.slice(start + 1, pos);
			// 任何空白/`@`/`#` 都算"已不在写这个 token"（打 `@ ` 立刻关浮层；与 lib/mentions.js 同口径）
			if (/[\s@#]/u.test(query)) { return undefined; }
			return { start, end: pos, query };
		};

		/** 选中候选：替换 `@query` 为 `@label` + 恰好一个尾空格；返回新文本与新 caret */
		const atSelect = (value, query, label) => {
			const text = String(value == null ? '' : value);
			const token = '@' + String(label == null ? '' : label);
			const skip = text[query.end] === ' ' ? 1 : 0;
			return {
				value: text.slice(0, query.start) + token + ' ' + text.slice(query.end + skip),
				caret: query.start + token.length + 1,
			};
		};

		/** 成员的显示名（空则退回 id）—— token 里写它，用户看到的是人话不是 slug */
		const atLabelOf = (agent) => {
			const name = String((agent && agent.name) || '').trim();
			return name || String((agent && agent.id) || '').trim();
		};

		/**
		 * 从文本反扫 mentions（同时认显示名与 id；**长串优先、丢弃重叠**）；`@所有人` 标 kind:'all'。
		 * ⚠ 长串优先是必须的：`@Code Architect` 不能先被 `@Code` 命中（会静默 @ 错人）。
		 */
		const atCollect = (text, members) => {
			const value = String(text == null ? '' : text);
			const out = [];
			const taken = [];
			const needles = [];
			for (const agent of (Array.isArray(members) ? members : [])) {
				const id = String((agent && agent.id) || '').trim();
				if (!id) { continue; }
				const label = atLabelOf(agent);
				if (label) { needles.push({ needle: '@' + label, label, agentId: id }); }
				if (label !== id) { needles.push({ needle: '@' + id, label: id, agentId: id }); }
			}
			needles.sort((a, b) => b.needle.length - a.needle.length);
			for (const n of needles) {
				const re = new RegExp(n.needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9._-])', 'g');
				let m = re.exec(value);
				while (m) {
					const start = m.index;
					const end = start + n.needle.length;
					if (!taken.some((t) => start < t.end && end > t.start)) {
						taken.push({ start, end });
						out.push({ start, end, label: n.label, agentId: n.agentId });
					}
					m = re.exec(value);
				}
			}
			const reAll = new RegExp('@' + AT_ALL + '(?![A-Za-z0-9._-])', 'g');
			let a = reAll.exec(value);
			while (a) {
				const start = a.index;
				const end = start + a[0].length;
				if (!taken.some((t) => start < t.end && end > t.start)) {
					out.push({ start, end, label: AT_ALL, kind: 'all' });
				}
				a = reAll.exec(value);
			}
			return out.sort((x, y) => x.start - y.start);
		};

		/** 文本切成 普通/mention 片段（offset 对不上的丢弃） */
		const atRuns = (value, mentions) => {
			const text = String(value == null ? '' : value);
			const list = [...(Array.isArray(mentions) ? mentions : [])]
				.filter((m) => Number.isInteger(m.start) && Number.isInteger(m.end))
				.sort((x, y) => x.start - y.start);
			const runs = [];
			let cursor = 0;
			for (const m of list) {
				if (m.start < cursor || m.end <= m.start || m.end > text.length) { continue; }
				if (text.slice(m.start, m.end) !== '@' + m.label) { continue; }
				if (m.start > cursor) { runs.push({ text: text.slice(cursor, m.start) }); }
				runs.push({ text: text.slice(m.start, m.end), mention: m });
				cursor = m.end;
			}
			if (cursor < text.length) { runs.push({ text: text.slice(cursor) }); }
			return runs;
		};

		/** Backspace/Delete 落在 mention 上 ⇒ 整块删（含尾空格）；未命中返回 undefined */
		const atDelete = (value, mentions, s, e, key) => {
			const text = String(value == null ? '' : value);
			const list = (Array.isArray(mentions) ? mentions : [])
				.filter((m) => Number.isInteger(m.start) && Number.isInteger(m.end));
			const target = list.find((m) => {
				const trailingEnd = text[m.end] === ' ' ? m.end + 1 : m.end;
				if (s !== e) { return s < trailingEnd && e > m.start; }
				return key === 'Backspace' ? (s > m.start && s <= trailingEnd) : (s >= m.start && s < m.end);
			});
			if (!target) { return undefined; }
			const end = text[target.end] === ' ' ? target.end + 1 : target.end;
			const start = s === e ? target.start : Math.min(s, target.start);
			const finish = s === e ? end : Math.max(e, end);
			return { value: text.slice(0, start) + text.slice(finish), caret: start };
		};

		/**
		 * 显示名去歧义：名字唯一 ⇒ 名字；**同名冲突** ⇒ `名字 · id`。
		 * 只影响**显示**（不删数据、不改 token），重名时用户才分得清是哪一只。
		 */
		const atDisplayLabels = (members) => {
			const list = Array.isArray(members) ? members.filter(Boolean) : [];
			const counts = new Map();
			for (const a of list) {
				const k = atLabelOf(a).toLocaleLowerCase();
				counts.set(k, (counts.get(k) || 0) + 1);
			}
			const out = new Map();
			for (const a of list) {
				const name = atLabelOf(a);
				const dup = (counts.get(name.toLocaleLowerCase()) || 0) > 1;
				out.set(String(a.id), dup ? (name + ' · ' + String(a.id)) : name);
			}
			return out;
		};

		/** 候选：成员过滤（name/id 大小写不敏感）+ `@所有人`（成员为空时不给） */
		const atCandidates = (members, query) => {
			const list = Array.isArray(members) ? members.filter(Boolean) : [];
			if (query === undefined || query === null) { return []; }
			const needle = String(query).toLocaleLowerCase();
			const labels = atDisplayLabels(list);
			const bots = list
				.filter((m) => String(m.name || '').toLocaleLowerCase().includes(needle)
					|| String(m.id || '').toLocaleLowerCase().includes(needle))
				.slice(0, AT_MAX)
				.map((agent) => ({ kind: 'bot', agent, display: labels.get(String(agent.id)) || atLabelOf(agent) }));
			const offerAll = list.length > 0 && [AT_ALL, 'all', 'everyone']
				.some((n) => n.toLocaleLowerCase().includes(needle));
			return offerAll ? [{ kind: 'all', label: AT_ALL, display: AT_ALL }, ...bots] : bots;
		};

		/** 被 @ 到的 agentId（`@所有人` ⇒ 全群）；发送与派发都用它 */
		const atTargets = (text, members) => {
			const mentions = atCollect(text, members);
			if (mentions.some((m) => m.kind === 'all')) {
				return (Array.isArray(members) ? members : []).map((m) => String((m && m.id) || '')).filter(Boolean);
			}
			const out = [];
			for (const m of mentions) { if (m.agentId && !out.includes(m.agentId)) { out.push(m.agentId); } }
			return out;
		};
		/* @MENTIONS-END */

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
					/* ★ 2026-10-26：原来 `.catch(() => {})` 把失败**吞掉**了 —— 用户只看到"点了没反应"
					   或者一个黑屏页（真机日志里是 `emulate timeout`），完全无从判断。
					   ⇒ 失败时至少给一条可读提示 + 可复制的地址。 */
					Promise.resolve(b.openModulePage(url)).then((ok) => {
						if (ok === false) { throw new Error('宿主拒绝了打开请求'); }
					}).catch((e) => {
						const why = String((e && e.message) || e);
						try { console.warn('[vssaros-agents] 打开模块页失败（' + (label || '') + '）：' + why + ' → ' + url); } catch (err) { /* ignore */ }
						try { window.prompt('打不开「' + (label || '完整页') + '」（' + why + '）。可复制地址自行打开：', url); } catch (err) { /* ignore */ }
					});
					return true;
				} catch (e) { /* 落到兜底 */ }
			}
			/* ★★ 2026-10-26 修「点群设置 ⇒ 黑屏」：
			   工作台现在跑在**承载页的 iframe** 里（`/x/agents/` → iframe → dsh 客户端），
			   而 preload 注入的桥只在 iframe 的**父文档**上 ⇒ 这里 `bridge()` 是 undefined。
			   旧逻辑会落到 `window.open(url, '_blank')`：Electron 里会开一个没有 preload/会话的
			   空窗口 ⇒ 用户看到**黑屏**。
			   ⇒ iframe 且同源时，直接导航**顶层**（= Bots 那个 webview，桥和样式都在），
			     页面在 Bots 页签里正常打开，不再黑屏。
			   ⚠ 跨域时 `top.location` 会抛（安全限制）⇒ try/catch 兜住，继续走后面的兜底。 */
			const inFrame = (() => { try { return window.self !== window.top; } catch (e) { return false; } })();
			if (inFrame) {
				try {
					window.top.location.assign(url);
					return true;
				} catch (e) { /* 跨域/被拦 ⇒ 落到下面 */ }
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
			/**
			 * 把官方对话切到某条会话 —— **先绑定再显示**。
			 *
			 * ★ 2026-10-25 用户要求「切换不同 bot 时，输入框显示不同的人格 chip」：
			 *   那排 chip（工作区 / 人格）是**官方对话**按「当前停靠会话的 preset」渲的
			 *   （chat-surface 的 `client.preset.js`）。只改左栏选中项、不换会话 ⇒ chip 永远停在
			 *   第一个 bot 上 ✗。所以这里必须真的把停靠会话切过去。
			 *   未归属本工作台的会话 ⇒ 主动 `bindSession`（不主动绑就只能干看着 chip 不动）。
			 */
			const focusDock = (sessionId) => {
				if (!dockService || !sessionId) { return; }
				try {
					if (typeof dockService.ownsSession === 'function' && dockService.ownsSession(sessionId)) {
						dockService.showSession(sessionId);
						return;
					}
					if (ownerId && typeof dockService.bindSession === 'function') {
						Promise.resolve(dockService.bindSession(ownerId, sessionId))
							.then(() => { try { dockService.showSession(sessionId); } catch (e) { /* 忽略 */ } })
							.catch(() => { /* 已属于别的工作台 ⇒ 不动，也不把用户踢走 */ });
					}
				} catch (e) { /* 停靠服务拒绝 ⇒ 保持现状，不打断 */ }
			};

			/** 切到某个 bot 的会话：有最近会话就用它；没有就按**它的 preset** 建一条再绑定 */
			const ensureBotSession = (a) => {
				if (!a) { return; }
				const recent = ((home[a.id] || {}).sessions || [])[0];
				if (recent && recent.id) { focusDock(String(recent.id)); return; }
				if (!dockService || !ownerId || !a.presetId) { return; }
				// 防抖：快速来回切 bot 时别把同一只建成一串会话
				if (BOT_SESSION_PENDING.has(String(a.id))) { return; }
				BOT_SESSION_PENDING.add(String(a.id));
				fetch('/x/agents/api/session', {
					method: 'POST', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ agentPreset: String(a.presetId) }),
				}).then(r => r.json()).then((j) => {
					if (!j || j.ok === false || !j.sessionId) { return null; }
					const sid = String(j.sessionId);
					return Promise.resolve(dockService.bindSession(ownerId, sid))
						.then(() => { try { dockService.showSession(sid); } catch (e) { /* 忽略 */ } });
				}).catch(() => { /* 建不出来就保持现状（chip 不跟着变，但不会跳走） */ })
					.finally(() => { BOT_SESSION_PENDING.delete(String(a.id)); });
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
			/* ⚠ 群聊重拉的**唯一**开关（2026-10-25 修"群聊永远 0"）：
			   原来 effect 依赖里有 `groupsView.status`，而 effect 内部又 `setGroupsView({status:'loading'})`
			   ⇒ 自己触发自己重跑 ⇒ cleanup 把 `alive` 置 false ⇒ 响应回来被丢弃
			   ⇒ **永远停在 loading，群聊列表永远是 0**。
			   ⇒ 依赖改成 `[tab, groupsTick]`：只有切页签或手动刷新才重拉。 */
			const [groupsTick, setGroupsTick] = useState(0);
			/* ── 群聊在工作台里**真能聊**（2026-10-26 用户报「复刻未生效」）──────────
			   真相：工作台的 `midGroup` 原来把 composer 的 submit 接成了
			   `openModuleRoute('/x/agents/group/…')` —— **点发送是跳页**，不是发消息。
			   ⇒ 这里补两样东西：
			     `gOut`   待发送/失败的本地队列（pending/failed，poll 覆盖不掉）
			     `gDraft` 各群草稿（localStorage，切群不丢）  */
			const [gOut, setGOut] = useState([]);
			const [gDraft, setGDraft] = useState({});
			/* ── 群聊附件（2026-10-26）──────────────────────────────────────────
			   上传走 `POST /api/group-file?group=&name=`（body = 原始字节），拿到
			   `{ id, name, size, mime }` 后挂在待发送列表里；发送时随消息带 `files[]`。
			   `gFiles` 是**全局**待发列表（切群会被清，避免把 A 群的附件发到 B 群）。 */
			const [gFiles, setGFiles] = useState([]);
			const [gUpBusy, setGUpBusy] = useState(false);
			const [gUpErr, setGUpErr] = useState('');
			const gPickRef = useRef(null);
			/* ── 群聊 `@` 提及（2026-10-26）──────────────────────────────────────
			   用户报「输入框敲 @ 没反应」。原来 composer 的 onKeyDown 只处理 Enter，
			   `@` 就是普通字符。现在：输入框监听 → 算 query → 弹候选 → 选中插入。
			   `atState.items` 里直接存候选（含 agent 对象），避免渲染时重算。 */
			const [atState, setAtState] = useState({ open: false, start: 0, end: 0, query: '', active: 0, items: [] });
			const groupTaRef = useRef(null);
			// 右栏记忆类数据（mem/evo/ver/br 共用一次 GET）
			const [memView, setMemView] = useState({ status: 'idle', data: null, error: '' });   // 列表
			const [memFile, setMemFile] = useState(null);   // { title, content, loading, error }
			const [evoDiff, setEvoDiff] = useState(null);   // { title, rows, added, removed, coarse, loading, error }
			// 「Agent 设置」= 二级页面（**React 实现**，数据源只有 /x/agents/api/*，不开编辑器 ⇒ 桌面窗口不黑屏）
			const [settingFor, setSettingFor] = useState('');
			const [stab, setStab] = useState('basic');           // 设置页当前页签（basic|prompt|runtime|versions|skills|channel|mcp|rules）
			const [setBusy, setSetBusy] = useState(false);
			const [setErr, setSetErr] = useState('');
			const [setOk, setSetOk] = useState('');
			/* 「群设置」= 二级页面（2026-10-26：用户报「点群设置 ⇒ 黑屏」）
			   黑屏根因：它原走 `openModuleRoute` ⇒ 宿主新建一个 webview 编辑器页，
			   实测该 webview `emulate timeout`（没就绪）⇒ 面板纯黑，随后 app 还可能 exit code=1。
			   ⇒ 改成工作台内二级页：**零新窗口、零新 WebContents**，写动作仍走 `/api/groups`。 */
			const [groupSetFor, setGroupSetFor] = useState('');   // 正在设置的群 id（''=不在该页）
			const [gsName, setGsName] = useState('');
			const [gsMode, setGsMode] = useState('all');
			const [gsBusy, setGsBusy] = useState(false);
			const [gsErr, setGsErr] = useState('');
			const [gsOk, setGsOk] = useState('');
			// System Prompt 页签（2026-10-25）：受控 textarea + 自己的加载/保存态
			const [promptText, setPromptText] = useState('');
			const [promptLoaded, setPromptLoaded] = useState(false);
			const [promptBusy, setPromptBusy] = useState(false);
			/* 版本页签（2026-10-25）：数据来自**记忆库**（`/api/memory`），不是 `/api/agents`。
			   后端早已全套：snapshot / version-add / version-remove / restore / backup /
			   restore-backup / branch-create / branch-switch ⇒ 这里只是把 UI 补上。 */
			const [evo, setEvo] = useState({ status: 'idle', data: null, error: '' });
			const [evoBusy, setEvoBusy] = useState(false);
			const [evoMsg, setEvoMsg] = useState('');
			/* 技能页签（2026-10-25）：池来自 `vssaros-skills` 的 `/x/skills/api/skills`，
			   该 agent 已启用的来自 `.agent.md` 的 `skills:`（逗号分隔，走 `GET /api/agents?id=`）。
			   写回走 `action:'update'` 的 `draft.skills`（数组会被 `listOf` 归一化成逗号串）。 */
			const [skillPool, setSkillPool] = useState([]);
			const [skillOwned, setSkillOwned] = useState([]);
			const [skillLoaded, setSkillLoaded] = useState(false);
			const [skillBusy, setSkillBusy] = useState(false);
			const [skillFilter, setSkillFilter] = useState('');
			/* Channel 页签（2026-10-25）：dsh 侧**没有**飞书凭据（那在 IDE 主进程的 TOF 里），
			   但它有一个真实的对应物 —— **群聊**：群的 `members` 就是"哪些 agent 在这个渠道里"。
			   ⇒ 这里如实显示"它参与了哪些群"，而不是画一个假的飞书绑定。 */
			const [chGroups, setChGroups] = useState([]);
			const [chLoaded, setChLoaded] = useState(false);

			/* ── 创建 Bot / 创建群聊（2026-10-25 用户要求）─────────────────────────
			   两条接口本来就有（完整页的向导在用），工作台只是缺入口：
			     POST /x/agents/api/agents  { action:'create', draft:{ name, description, persona } }
			     POST /x/agents/api/groups  { action:'create', name, mode, members[] }
			   都在站内弹层里填，**不开编辑器**（桌面窗口里那会黑屏）。 */
			const [creating, setCreating] = useState('');          // '' | 'agent' | 'group'
			const [createErr, setCreateErr] = useState('');
			const [createBusy, setCreateBusy] = useState(false);
			// ⚠ `id` **必须给**：服务端 `previewAgentDraft` 会校验 `id 必填`（p3-178 实测 400）。
			//   所以这里跟着名字自动生成一个 slug，用户可改（改了就不再跟随）。
			const [form, setForm] = useState({ name: '', id: '', idTouched: false, description: '', persona: '', mode: 'all', members: [] });
			// ⚠ 只保留 ASCII：中文会生成中文目录名 / 中文 preset id，dsh 侧注册不稳
			//   （中文名 ⇒ slug 为空 ⇒ submitCreate 里再兜一个 `bot-<时间戳>`）
			const slugify = (v) => String(v || '').trim().toLowerCase()
				.replace(/[\s_]+/g, '-')
				.replace(/[^a-z0-9-]+/g, '')
				.replace(/-+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 40);

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

			/* ── 分组折叠（2026-10-25 用户要求：bot 列表支持折叠）─────────────────
			   三组（已注册 / 未注册 / 群聊）各自可折，状态存 localStorage。
			   为什么折叠：名册一多（截图里 21 个已注册）中间栏会被挤，且找"群聊"要滚到底。 */
			const COLLAPSE_KEY = 'vssaros.agents.collapsedSections.v1';
			const [collapsed, setCollapsed] = useState(() => {
				try {
					const raw = window.localStorage.getItem(COLLAPSE_KEY);
					const o = raw ? JSON.parse(raw) : null;
					return o && typeof o === 'object' ? o : {};
				} catch (e) { return {}; }
			});
			const toggleSection = (key) => {
				setCollapsed((prev) => {
					const next = { ...prev, [key]: !prev[key] };
					try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch (e) { /* 隐私模式写不了就算了 */ }
					return next;
				});
			};
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
				// ⚠ 必须是 camelCase：写成 'stroke-width' React 会报
				//   `Invalid DOM property` 警告（p3-179 的 console 监听抓到的）
				strokeWidth: 1.2, strokeLinecap: 'round', 'aria-hidden': 'true',
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
			/* ── 创建 Bot / 群聊：打开、关闭、提交 ────────────────────────────── */
			const openCreate = (kind) => {
				setCreateErr('');
				setCreateBusy(false);
				setForm({ name: '', id: '', idTouched: false, description: '', persona: '', mode: 'open', members: [] });
				setCreating(kind);
			};
			const closeCreate = () => { if (!createBusy) { setCreating(''); setCreateErr(''); } };
			const submitCreate = async () => {
				if (createBusy) { return; }
				const name = String(form.name || '').trim();
				if (!name) { setCreateErr('名字不能为空'); return; }
				if (creating === 'group' && form.members.length === 0) { setCreateErr('群聊至少要选一个成员'); return; }
				setCreateBusy(true);
				setCreateErr('');
				try {
					const isGroup = creating === 'group';
					const body = isGroup
						? { action: 'create', name, mode: form.mode, members: form.members }
						// ⚠ `id` 必填（服务端 previewAgentDraft 校验）⇒ 用自动 slug；用户改过就用他的
						: { action: 'create', draft: { name, id: String(form.id || slugify(name) || ('bot-' + Date.now().toString(36))), description: String(form.description || ''), persona: String(form.persona || '') } };
					const res = await fetch('/x/agents/api/' + (isGroup ? 'groups' : 'agents'), {
						method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setCreating('');
					// 群聊列表是独立拉取的（置 idle 会让它的 effect 重新拉）；Bot 名册走 load()
					if (isGroup) { setGroupsTick((t) => t + 1); } else { void load(); }
				} catch (e) {
					setCreateErr(String((e && e.message) || e));
				} finally {
					setCreateBusy(false);
				}
			};

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
				// ⚠ 依赖只有 [tab, groupsTick]：内部 setGroupsView 不会触发自己重跑，
				//   `alive` 就不会被自己的 cleanup 提前置 false（原 bug 见 groupsTick 的注释）
				if (tab !== 'roster') { return undefined; }
				let alive = true;
				/* ★★ 2026-10-26 用户报「bot 页面每隔一段时间抖动一次」：
				   下面那条 3 秒轮询会 bump `groupsTick` ⇒ 本 effect 重跑 ⇒ 原来**无条件**
				   `setGroupsView({status:'loading', data:null})` ⇒ 左栏群聊列表先被清空、
				   再被请求结果填回来（几十毫秒）⇒ 视觉上就是**列表周期性闪一下**。
				   ⇒ 两条约束：
				     ① 已经有数据时**不要把 data 置空**（只有首次加载才显示 loading）
				     ② 请求回来先比**签名**（id/名字/模式/成员数/消息数/最后一条时间），
				        没变化就返回同一个 state 对象 ⇒ React 直接跳过重渲染（连 diff 都省了） */
				/* ⚠⚠ 2026-10-26 踩过的坑：签名最初只比 id/名字/模式/成员数/消息数/最后时间。
				   于是改 **relay / dispatchMode / wakePolicies / ownerAgentId** 这类
				   "不改变上述字段" 的设置时，签名不变 ⇒ 返回同一个 state 对象 ⇒ React 不重渲染
				   ⇒ **界面上设置看起来回滚了**（POST 已经成功，磁盘也改了）。
				   `p3-189` 的 ⑦s 就是靠"复选框点了之后仍是未选中"抓到它的。
				   ⇒ 原则：**签名必须覆盖 UI 会渲染的每一个字段**，否则去重就是在骗自己。 */
				const sigOf = (body) => {
					const gs = (body && Array.isArray(body.groups)) ? body.groups : [];
					return JSON.stringify(gs.map((g) => [
						String(g.id || ''),
						String(g.name || ''),
						String(g.mode || ''),
						String(g.dispatchMode || ''),
						String(g.ownerAgentId || ''),
						g.requireApproval === true ? '1' : '0',
						String(g.avatar || '').length,
						JSON.stringify(g.relay || null),
						JSON.stringify(g.wakePolicies || null),
						Array.isArray(g.members) ? g.members.join(',') : '',
						Array.isArray(g.transcript) ? g.transcript.length : 0,
						Array.isArray(g.transcript) && g.transcript.length
							? Number(g.transcript[g.transcript.length - 1].at) || 0 : 0,
					]));
				};
				setGroupsView((prev) => (prev.status === 'ready' && prev.data
					? prev                                              // 已有数据 ⇒ 保留，别闪空
					: { status: 'loading', data: null, error: '' }));
				getJson('/groups')
					.then(body => {
						if (!alive) { return; }
						setGroupsView((prev) => (prev.status === 'ready' && prev.data
							&& sigOf(prev.data) === sigOf(body)
							? prev                                      // 内容没变 ⇒ 不换对象（零重渲染）
							: { status: 'ready', data: body, error: '' }));
					})
					.catch(e => { if (alive) { setGroupsView({ status: 'error', data: null, error: String(e && e.message || e) }); } });
				return () => { alive = false; };
			}, [tab, groupsTick]);

			/* ── 群聊：选中某个群时**定时刷新**（2026-10-26）────────────────────
			   原来 `groups` 只在切页签/手动刷新时重拉 ⇒ 群聊面板看不到别人（成员 bot）的新消息。
			   3 秒一次、页面不可见时跳过（与独立群聊页的 `poll` 同口径）。 */
			useEffect(() => {
				if (sel.kind !== 'group' || tab !== 'roster') { return undefined; }
				const t = setInterval(() => {
					try {
						if (!document.hidden) { setGroupsTick((n) => n + 1); }
					} catch (e) { /* ignore */ }
				}, 3000);
				return () => clearInterval(t);
			}, [sel.kind, sel.id, tab]);

			/* ── 群聊草稿：打开某个群时把它自己的草稿填回来 ──────────────────── */
			useEffect(() => {
				if (sel.kind !== 'group' || !sel.id) { return; }
				const gid = String(sel.id);
				let v = null;
				// ⚠ 读不到时返回 null（不是 ''）⇒ 下面直接 return，**保留内存里的草稿**。
				//   否则 localStorage 被禁用（about:blank / 隐私模式）时会把正在打字的草稿清空
				//   （2026-10-26 p3-189 抓到的：`SecurityError: Access is denied`）。
				try { v = window.localStorage.getItem('vssaros.agents.gDraft.' + gid); } catch (e) { v = null; }
				if (v !== null) { setGDraft((prev) => (prev[gid] === v ? prev : { ...prev, [gid]: v })); }
				/* ⚠ 切群必须清掉**待发附件**：附件是绑在群上的（上传时就带 group=），
				   不清的话会把 A 群的附件发到 B 群里去。 */
				setGFiles([]);
				setGUpErr('');
				/* `@` 候选同理：不清的话切群后浮层还挂着上一个群的成员（会 @ 错人）。 */
				setAtState({ open: false, start: 0, end: 0, query: '', active: 0, items: [] });
			}, [sel.kind, sel.id]);

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
				// 切 bot ⇒ 把官方对话也切到它的会话（这样输入框上方的人格 chip 才跟着变）。
				// 没有会话就按它的 preset 建一条；建不出来 / 会话属于别的工作台 ⇒ 保持现状，不跳走。
				ensureBotSession(a);
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
			/** 分组标题（可点折叠）：caret + 名字 + 数量 + 可选右侧动作 */
			const sectionHead = (key, label, count, extra) => h('div', {
				className: 'ag3-sechd ag3-sechd-toggle', 'data-ag-section': key,
				role: 'button', tabIndex: 0,
				'aria-expanded': collapsed[key] ? 'false' : 'true',
				title: (collapsed[key] ? '展开' : '折叠') + '「' + label + '」',
				onClick: () => toggleSection(key),
				onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleSection(key); } },
			},
				h('span', { className: 'ag3-caret' + (collapsed[key] ? ' is-off' : '') }, '▾'),
				h('span', null, label),
				h('small', null, String(count)),
				extra || null);

			/* 分组标题右侧的小按钮：**新建 Bot / 新建群聊 / 去群聊页**
			   ⚠ 一律 `stopPropagation`：否则点按钮会顺带把分组折了。 */
			const miniAct = (act, title, label, fn) => h('button', {
				type: 'button', className: 'wb-btn is-ghost ag3-mini', 'data-ag-act': act, title,
				onClick: (ev) => { ev.stopPropagation(); fn(); },
			}, label);

			const leftPane = h('div', { className: 'ag3-l', 'data-ag-list': String(visible.length), 'data-ag-roster-panel': '', 'data-ag-left': '' },
				/* ★ 2026-10-26 用户要求：创建入口**放进名册页**（左栏顶部），按钮文字就叫「新建 bot」，
				   打开的面板以**二级页面**呈现（见下方 createPage）。
				   群聊的入口也一并放这里，与它并列 —— 两个都是"新建"，分开放反而难找。 */
				h('div', { className: 'ag3-lcreate', 'data-ag-lcreate': '' },
					h('button', {
						type: 'button', className: 'wb-btn is-primary ag3-lcreate-main', 'data-ag-act': 'create-agent',
						title: '新建 bot（写一个 .agent.md）', onClick: () => openCreate('agent'),
					}, '＋ 新建 bot'),
					h('button', {
						type: 'button', className: 'wb-btn ag3-lcreate-side', 'data-ag-act': 'create-group',
						title: '新建群聊（选成员 + 模式）', onClick: () => openCreate('group'),
					}, '群聊')),
				// 「已注册」标题常显（即使 0 个也留着 —— 否则分组就没了折叠入口）
				sectionHead('reg', '已注册', regRows.length,
					miniAct('create-agent', '新建 bot（写一个 .agent.md）', '＋', () => openCreate('agent'))),
				collapsed.reg ? null : regRows.map(agentRow),
				// 折叠时给一行"被折叠了"的提示，避免用户以为列表空了
				collapsed.reg && regRows.length ? h('p', { className: 'ag-hint ag3-tip', 'data-ag-folded': 'reg' }, '已折叠 ' + regRows.length + ' 个 —— 点「已注册」展开') : null,
				unregRows.length ? sectionHead('unreg', '未注册', unregRows.length) : null,
				collapsed.unreg ? null : unregRows.map(agentRow),
				collapsed.unreg ? null : (unregRows.length ? h('p', { className: 'ag-hint ag3-tip' }, '未注册 = 花名册里没有它的 preset ⇒ dsh 侧不会加载。') : null),
				/* 未注册折叠后的提示（必须紧跟它自己的行，不能放到别的分组后面） */
				collapsed.unreg && unregRows.length ? h('p', { className: 'ag-hint ag3-tip', 'data-ag-folded': 'unreg' }, '已折叠 ' + unregRows.length + ' 个未注册 —— 点「未注册」展开') : null,
				sectionHead('groups', '群聊', groups.length,
					h('span', { className: 'ag3-mini-row' },
						miniAct('create-group', '新建群聊', '＋', () => openCreate('group')),
						/* ★ 2026-10-26：原本跳独立群聊页（新 webview）。左栏**本来就有**群聊列表
						   ⇒ 改成直接选中第一个群（发消息就在中间栏）；一个群都没有时才回退到完整页（那里能建群）。 */
						miniAct('groups-app', '打开群聊（选中第一个群）', '↗', () => {
							if (groups.length) {
								setSel({ kind: 'group', id: String(groups[0].id) });
							} else {
								openModuleRoute('/x/agents/group', '群聊页');
							}
						}))),
				collapsed.groups ? null : groupsView.status === 'loading' ? h('p', { className: 'ag-hint ag3-tip' }, '正在读群聊…') : null,
				collapsed.groups ? null : groupsView.status === 'error' ? h('p', { className: 'ag-hint ag3-tip' }, '群聊读不到：' + groupsView.error) : null,
				collapsed.groups ? null : (groups.length ? groups.map(groupRow) : (groupsView.status === 'ready' ? h('p', { className: 'ag-hint ag3-tip' }, '还没有群聊。') : null)),
				/* ⚠ 2026-10-26（p3-194 抓到的缺口）：群聊分组折叠后原来**没有任何提示**，
				   列表直接变空 ⇒ 看着像"群聊数据丢了"。与「已注册」保持同一口径。 */
				collapsed.groups && groups.length ? h('p', { className: 'ag-hint ag3-tip', 'data-ag-folded': 'groups' }, '已折叠 ' + groups.length + ' 个群聊 —— 点「群聊」展开') : null);

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
					}, '发起会话')),
				/* ⚠ 2026-10-26：这里原来还有「Agent 设置」。已去掉 ——
				   用户要求把「委派任务 / Agent 设置」都收到**右栏**（`ag3-rhd` 已各有一个图标按钮），
				   中间栏只放会话内容，不再出现设置入口（空态卡也不留）。 */
				h('div', { className: 'ag3-start-hint' }, '点「发起会话」会在这里开会话，消息实时显示。设置与委派在右侧栏。'));

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
					/* ★ 2026-10-26 `@` 提及：调用方给的 `onKeyDown` 先跑 —— 它要处理
					   ↑↓/Enter/Tab/Esc（候选导航）与 Backspace 整块删 mention。
					   返回 true = 已消费 ⇒ 这里不再当成"回车发送"。
					   ⚠ IME 保护在调用方里做（`isComposing` 时不能抢 Enter，否则选词就发出去了）。 */
					onKeyDown: (ev) => {
						if (o.onKeyDown && o.onKeyDown(ev) === true) { return; }
						if (ev.key === 'Enter' && !ev.shiftKey) {
							if (ev.nativeEvent && ev.nativeEvent.isComposing) { return; }
							ev.preventDefault();
							submit();
						}
					},
				};
				if (o.taRef) { inputProps.ref = o.taRef; }
				if (actKey === 'chat') {
					inputProps.value = draft;
					inputProps.onChange = (ev) => setDraft(ev.target.value);
				} else if (o.value !== undefined) {
					/* 2026-10-26：其它 composer（群聊的 `group-send`）也能受控 ——
					   群聊要按群保存草稿，必须由外部持有输入值。 */
					inputProps.value = o.value;
					inputProps.onChange = o.onChange;
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
				/* `@` 候选浮层（2026-10-26）：定位在输入卡片**上方**（`bottom:100%`）。
				   ⚠ 用 `onMouseDown` + preventDefault 而不是只用 onClick ——
				   否则点候选时 textarea 先失焦，caret 丢失、插入位置就错了。 */
				const atPop = (o.at && o.at.open && Array.isArray(o.at.items) && o.at.items.length)
					? h('div', { className: 'ag3-atpop', 'data-ag-atpop': String(o.at.items.length), role: 'listbox' },
						o.at.items.map((item, i) => h('button', {
							key: (item.kind === 'all' ? 'all' : String(item.agent && item.agent.id || i)),
							type: 'button',
							className: 'ag3-atitem' + (i === (o.at.active || 0) ? ' is-on' : ''),
							role: 'option',
							'aria-selected': i === (o.at.active || 0) ? 'true' : 'false',
							'data-ag-atitem': item.kind === 'all' ? 'all' : String(item.agent && item.agent.id || ''),
							onMouseDown: (ev) => { ev.preventDefault(); },
							onClick: () => { if (o.onAtChoose) { o.onAtChoose(item); } },
							title: item.kind === 'all'
								? ('@' + String(item.label || '所有人') + '（唤醒全部成员）')
								/* slug 只留在 tooltip 里（排查时有用），列表上一律显示名字 */
								: ('@' + String(item.agent && item.agent.name || item.agent && item.agent.id || '')
									+ '  ·  id: ' + String(item.agent && item.agent.id || '')),
						},
						h('span', { className: 'ag3-atmark' }, item.kind === 'all' ? '＠' : '@'),
						/* ★ 2026-10-26 用户要求「显示可读名字，不要 slug」：
						   只渲染名字；**同名冲突**时 `item.display` 自带 ` · id` 后缀（否则两行长得一样，
						   看起来就是"重复 bot"）。正常情况下与名字完全一致。 */
						h('span', { className: 'ag3-atname' },
							item.kind === 'all'
								? String(item.label || '所有人')
								: String(item.display || (item.agent && item.agent.name) || (item.agent && item.agent.id) || '')))))
					: null;
				return h('div', { className: 'ag3-compwrap', 'data-ag-composer': actKey },
					atPop,
					h('div', { className: 'ag3-compcard' + (off ? ' is-off' : '') },
						h('div', { className: 'ag3-comp-in' }, h('textarea', inputProps)),
						h('div', { className: 'ag3-comp-row' },
													h('button', {
								type: 'button', className: 'ag3-add',
								/* ⚠ 2026-10-26：以前这里接的是 `submit()` —— 点「＋」会**直接发消息**（误触）。
								   现在：给了 `onPick` 就选附件（群聊用），否则保持"添加文件或调用指令"的旧提示。 */
								'aria-label': o.onPick ? '添加附件' : '添加文件或调用指令',
								title: o.onPick ? '添加附件（图片/文件，单个 ≤20MB）' : '添加文件或调用指令（在会话里）',
								'data-ag-act': o.onPick ? (actKey + '-pick') : actKey,
								onClick: () => { if (o.onPick) { o.onPick(); } else { submit(); } },
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
				// 2026-10-25：「委派任务」移到**右栏 header**（和 Agent 设置放一起）；
				//   中间栏这里只留身份信息，把宽度让给会话内容。
				h('span', { className: 'wb-spacer' }));

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


			/** 发一条群消息：乐观上屏（pending）→ 成功剔除 / 失败转 failed 可重试 */
			/** 单个附件上限（与后端 `MAX_FILE_BYTES` 同一个数 ⇒ 前端先拦，省一次往返） */
			const MAX_ATTACH = 20 * 1024 * 1024;

			/** 上传一个附件，成功后挂进待发送列表（`gFiles`） */
			const uploadGroupFile = async (g, file) => {
				if (!g || !g.id || !file) { return; }
				if (file.size > MAX_ATTACH) {
					setGUpErr(`${file.name} 太大（${(file.size / 1048576).toFixed(1)}MB，上限 20MB）`);
					return;
				}
				setGUpBusy(true);
				setGUpErr('');
				try {
					const res = await fetch('/x/agents/api/group-file?group=' + encodeURIComponent(String(g.id))
						+ '&name=' + encodeURIComponent(file.name || 'file'), {
						method: 'POST',
						headers: { 'content-type': file.type || 'application/octet-stream' },
						body: file,
						credentials: 'same-origin',
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					if (j.file) { setGFiles((prev) => [...prev, j.file]); }
				} catch (e) {
					setGUpErr(String((e && e.message) || e));
				} finally {
					setGUpBusy(false);
				}
			};

			/* ── `@` 提及：交互层（2026-10-26）────────────────────────────────── */
			/** 本群成员（按 `g.members` 过滤 agents；候选与派发都用它） */
			const mentionMembersOf = (g) => {
				const ids = Array.isArray(g && g.members) ? g.members.map(String) : [];
				return agents.filter((a) => ids.includes(String(a.id)));
			};

			const atClose = () => setAtState((s) => (s.open
				? { open: false, start: 0, end: 0, query: '', active: 0, items: [] } : s));

			/** 输入变化后重算候选（caret 从事件里取，不要用 state —— 会慢一帧） */
			const atSync = (value, caret, g) => {
				const q = atQuery(value, caret);
				if (!q) { atClose(); return; }
				const items = atCandidates(mentionMembersOf(g), q.query);
				if (!items.length) { atClose(); return; }
				setAtState({ open: true, start: q.start, end: q.end, query: q.query, active: 0, items });
			};

			/** 选中候选：写回草稿 + 把 caret 放到 token 之后 */
			const atChoose = (item, g) => {
				if (!item || !g || !g.id) { atClose(); return; }
				const gid = String(g.id);
				const value = gDraft[gid] || '';
				/* ★ 2026-10-26：插入的是**显示名**（`@Code Architect`），不是 id —— 用户看到的是人话。
				   `agentId` 由事后反扫 `atCollect` 得出，服务端用 offset + agentId 派发。 */
				const label = item.kind === 'all' ? AT_ALL : atLabelOf(item.agent);
				if (!label) { atClose(); return; }
				const r = atSelect(value, { start: atState.start, end: atState.end }, label);
				setGDraft((prev) => ({ ...prev, [gid]: r.value }));
				try { window.localStorage.setItem('vssaros.agents.gDraft.' + gid, r.value); } catch (e) { /* ignore */ }
				const ta = groupTaRef.current;
				atClose();
				// 等 React 把 value 写进 DOM 再设选区（否则 selectionStart 会被重置到末尾）
				requestAnimationFrame(() => {
					if (!ta) { return; }
					try { ta.focus(); ta.setSelectionRange(r.caret, r.caret); } catch (e) { /* ignore */ }
				});
			};

			/**
			 * 输入框按键：返回 true = 已消费（composer 不会再当成"回车发送"）。
			 * 覆盖三类：候选导航（↑↓/Enter/Tab/Esc）、mention 整块删除（Backspace/Delete）、IME 保护。
			 */
			const atKey = (ev, g) => {
				// ⚠ 输入法组词期间**绝不能**抢键：否则打拼音时按 Enter 选词会变成"发送消息"
				const composing = !!(ev.nativeEvent && ev.nativeEvent.isComposing);
				if (composing) { return false; }
				const open = atState.open && Array.isArray(atState.items) && atState.items.length > 0;
				if (open) {
					const n = atState.items.length;
					const cur = atState.active || 0;
					if (ev.key === 'ArrowDown') {
						setAtState((s) => ({ ...s, active: (cur + 1) % n })); ev.preventDefault(); return true;
					}
					if (ev.key === 'ArrowUp') {
						setAtState((s) => ({ ...s, active: (cur - 1 + n) % n })); ev.preventDefault(); return true;
					}
					if (ev.key === 'Enter' || ev.key === 'Tab') {
						atChoose(atState.items[cur], g); ev.preventDefault(); return true;
					}
					if (ev.key === 'Escape') { atClose(); ev.preventDefault(); return true; }
				}
				if ((ev.key === 'Backspace' || ev.key === 'Delete') && g && g.id) {
					const gid = String(g.id);
					const value = gDraft[gid] || '';
					const ta = ev.target;
					const s = ta && Number.isInteger(ta.selectionStart) ? ta.selectionStart : value.length;
					const e2 = ta && Number.isInteger(ta.selectionEnd) ? ta.selectionEnd : s;
					const r = atDelete(value, atCollect(value, mentionMembersOf(g)), s, e2, ev.key);
					if (r) {
						setGDraft((prev) => ({ ...prev, [gid]: r.value }));
						try { window.localStorage.setItem('vssaros.agents.gDraft.' + gid, r.value); } catch (e) { /* ignore */ }
						requestAnimationFrame(() => {
							try { ta.setSelectionRange(r.caret, r.caret); } catch (e) { /* ignore */ }
						});
						ev.preventDefault();
						return true;
					}
				}
				return false;
			};

			const sendGroupMsg = async (g, text) => {
				const txt = String(text || '').trim();
				/* ★ 2026-10-26：允许「只有附件」的消息（后端也放开了这条）。 */
				const filesNow = gFiles.slice();
				if ((!txt && !filesNow.length) || !g || !g.id) { return; }
				/* ★ `@` 提及：把 offset 一起发给后端（后端优先用它派发；这是修掉
				   「子串匹配误唤醒」的关键 —— `@test` 不会再命中 `@test1`）。 */
				const members = mentionMembersOf(g);
				const ats = atCollect(txt, members);
				const cid = 'c' + Date.now().toString(36);
				setGOut((prev) => [...prev, {
					cid, gid: String(g.id), text: txt, at: Date.now(), state: 'pending', files: filesNow,
					mentions: ats,
				}]);
				setGFiles([]);
				setGUpErr('');
				setGDraft((prev) => { const n = { ...prev }; delete n[String(g.id)]; return n; });
				try { window.localStorage.removeItem('vssaros.agents.gDraft.' + String(g.id)); } catch (e) { /* ignore */ }
				try {
					const res = await fetch('/x/agents/api/groups', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							action: 'message', id: String(g.id), text: txt,
							...(filesNow.length ? { files: filesNow } : {}),
							...(ats.length ? { mentions: ats } : {}),
						}),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setGOut((prev) => prev.filter((x) => x.cid !== cid));
					setGroupsTick((t) => t + 1);
				} catch (e) {
					/* 失败时把附件**放回**待发列表：否则用户重试时附件没了，还得重新传一遍。 */
					setGFiles((prev) => [...filesNow, ...prev]);
					setGOut((prev) => prev.map((x) => (x.cid === cid
						? { ...x, state: 'failed', err: String((e && e.message) || e) } : x)));
				}
			};
			/** 重试一条失败的群消息（cid 不变，不会越点越多） */
			const retryGroupMsg = (cid) => {
				const hit = gOut.find((x) => x.cid === cid);
				if (!hit) { return; }
				const g = groups.find((x) => x.id === hit.gid);
				setGOut((prev) => prev.filter((x) => x.cid !== cid));
				if (g) { void sendGroupMsg(g, hit.text); }
			};

			/** 时间分隔文案（对齐 DSB 的 `separatorLabel`：今天只给时间，更早给"昨天/日期 + 时间"） */
			const sepLabelOf = (at) => {
				const d = new Date(at || Date.now());
				const n = new Date();
				const hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
				if (d.toDateString() === n.toDateString()) { return hm; }
				const y = new Date(n.getTime() - 86400000);
				if (d.toDateString() === y.toDateString()) { return '昨天 ' + hm; }
				return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
			};
			/**
			 * 群消息行 —— **与 `lib/core/groupChat.js` 的 `chatRows` 逐字同构**（2026-10-26 收敛）。
			 *
			 * 为什么不是直接 import：本文件是宿主 chunk，跑在 `__ModuleLoader__` 里，
			 * 拿不到本地模块（`require` 只给 react 等宿主模块）。
			 * ⇒ React 侧保留这份同构实现，**由 `p3-190` 用同一组夹具比对两边结果**防漂移。
			 *   改这里的口径时，必须同步改 `core/groupChat.js`，否则 p3-190 立刻红。
			 */
			/* ── 投递状态摘要（2026-10-26）──────────────────────────────────────
			   服务端在每条用户消息上写 `deliveries: [{ id, agentId, name, state, at, repliedAt?, error? }]`
			   （state: dispatched / replied / failed）。这里把它压成群头部的一行字：
			     `已回 2/3 · 等 1`，`title` 里给具体人名。
			   ⚠ 「超时」是**读时判定**（`dispatched` 且超过 10 分钟），不改磁盘
			   —— 否则得为它专门跑一个扫描器，收益不值。 */
			const DELIVERY_TIMEOUT_MS = 10 * 60 * 1000;
			const summarizeDeliveries = (list, nowMs) => {
				const rows = Array.isArray(list) ? list.filter(Boolean) : [];
				if (!rows.length) { return null; }
				const now = Number.isFinite(nowMs) ? nowMs : Date.now();
				const names = (arr) => arr.join('、');
				let replied = 0;
				const wait = [];
				const slow = [];
				const bad = [];
				for (const d of rows) {
					const name = String(d.name || d.agentId || '?');
					if (d.state === 'replied') { replied += 1; continue; }
					if (d.state === 'failed') { bad.push(name); continue; }
					const at = Number(d.at) || 0;
					if (at && now - at > DELIVERY_TIMEOUT_MS) { slow.push(name); } else { wait.push(name); }
				}
				const total = rows.length;
				const text = '已回 ' + replied + '/' + total
					+ (bad.length ? ' · 失败 ' + bad.length : '')
					+ (slow.length ? ' · 超时 ' + slow.length : '')
					+ (wait.length ? ' · 等 ' + wait.length : '');
				const parts = [];
				const repliedNames = rows.filter((d) => d.state === 'replied')
					.map((d) => String(d.name || d.agentId || '?'));
				if (repliedNames.length) { parts.push('已回：' + names(repliedNames)); }
				if (wait.length) { parts.push('等待中：' + names(wait)); }
				if (slow.length) { parts.push('超时未回：' + names(slow)); }
				if (bad.length) { parts.push('派发失败：' + names(bad)); }
				return { text, title: parts.join('\n'), pending: wait.length + slow.length, failed: bad.length };
			};

			const groupRows = (list, mentionPool) => {
				const GROUP_MS = 300000;        // 相邻 ≤5 分钟成组（DSB 的 GROUP_MS）
				const SEPARATOR_MS = 1800000;   // 距上一条 ≥30 分钟插分隔（DSB 的 SEPARATOR_MS）
				const GROUP_MAX = 8;            // 每组 ≤8 条（我们自己的上限）
				const dayKeyOf = (at) => {
					const d = new Date(at);
					return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
				};
				const out = [];
				let prev = null;
				let groupN = 0;
				let lastDay = '';
				for (let i = 0; i < list.length; i += 1) {
					const m = list[i] || {};
					const at = Number(m.at) || 0;
					const isSystem = String(m.role || '') === 'system';
					const isMe = String(m.role || '') === 'user';
					const who = isMe ? '__me' : String(m.agentId || m.role || '');
					const dk = dayKeyOf(at);
					const crossDay = dk !== lastDay;
					const bigGap = !!prev && (at - prev.at) >= SEPARATOR_MS;

					// 分隔：跨天 或 距上一条 ≥30 分钟（系统消息不参与，免得把提示前后切成两段）
					if (!isSystem && (crossDay || bigGap)) {
						out.push(h('div', { className: 'ag3-gsep', key: 'sep' + i }, sepLabelOf(at)));
						lastDay = dk;
						prev = null;
						groupN = 0;
					}
					if (isSystem) {
						out.push(h('div', { className: 'ag3-gsys', key: 'sys' + i }, String(m.text || '')));
						prev = null;
						groupN = 0;
						continue;
					}

					const gap = prev ? (at - prev.at) : 1e9;
					const grp = !!prev && prev.who === who && gap >= 0 && gap <= GROUP_MS && groupN < GROUP_MAX;
					if (!grp) { groupN = 0; }
					groupN += 1;
					const a = isMe ? null : agents.find((x) => x.id === who);
					const name = isMe ? '你' : String((a && a.name) || who);
					out.push(h('div', {
						key: 'm' + i,
						className: 'ag3-gmsg' + (isMe ? ' is-me' : '') + (grp ? ' is-grp' : '')
							+ (m.state === 'failed' ? ' is-fail' : '') + (m.state === 'pending' ? ' is-pend' : ''),
					},
						h('div', { className: 'ag3-gav' + (grp ? ' is-hidden' : '') }, name.slice(0, 1)),
						h('div', { className: 'ag3-gcol' },
							grp ? null : h('div', { className: 'ag3-gwho' }, name),
							h('div', { className: 'ag3-gbub' + (String(m.text || '') ? '' : ' is-fileonly') },
								/* @ 提及高亮（2026-10-26）：消息自带 `mentions[]` 就用它（带 offset 校验），
								   否则按本群成员**从文本反扫** ⇒ 老消息也能正常高亮。 */
								...(atRuns(String(m.text || ''),
									(Array.isArray(m.mentions) && m.mentions.length)
										? m.mentions
										: atCollect(String(m.text || ''), mentionPool || []))
									.map((run, ri) => (run.mention
										? h('span', {
											key: 'r' + ri,
											className: 'ag3-gat' + (run.mention.kind === 'all' ? ' is-all' : ''),
											'data-ag-mention': String(run.mention.agentId || run.mention.label || ''),
											title: run.mention.kind === 'all' ? '发给全群' : String(run.mention.label || ''),
										}, run.text)
										: run.text))),
								/* 附件（2026-10-26）：图片给缩略图（点开看原图），其它给文件卡片。
								   href 直接用 GET /api/group-file?id= —— 服务端已按 mime 设 content-type，
								   浏览器的 <img>/下载 都能直接用，不需要再转 base64。 */
								(Array.isArray(m.files) && m.files.length)
									? h('div', { className: 'ag3-gfiles' }, m.files.map((f, fi) => {
										const url = '/x/agents/api/group-file?id=' + encodeURIComponent(String(f.id || ''));
										const isImg = /^image\//i.test(String(f.mime || ''));
										const sizeTxt = (Number(f.size) || 0) >= 1048576
											? ((Number(f.size) / 1048576).toFixed(1) + 'MB')
											: (Math.max(1, Math.round((Number(f.size) || 0) / 1024)) + 'KB');
										return isImg
											? h('a', {
												key: 'f' + fi, className: 'ag3-gimg-a', href: url, target: '_blank', rel: 'noreferrer',
												title: String(f.name || '图片') + ' · ' + sizeTxt, 'data-ag-attach': String(f.id || ''),
											}, h('img', { className: 'ag3-gimg', src: url, alt: String(f.name || '图片'), loading: 'lazy' }))
											: h('a', {
												key: 'f' + fi, className: 'ag3-gfile', href: url, target: '_blank', rel: 'noreferrer',
												title: String(f.name || '文件') + ' · ' + sizeTxt, 'data-ag-attach': String(f.id || ''),
											}, h('span', { className: 'ag3-gfile-ic' }, '📄'),
											h('span', { className: 'ag3-gfile-n' }, String(f.name || '文件')),
											h('span', { className: 'ag3-gfile-s' }, sizeTxt));
									}))
									: null),
							m.state === 'failed'
								? h('div', { className: 'ag3-gfail' },
									h('span', null, '未发送 · ' + String(m.err || '网络错误')),
									h('button', {
										type: 'button', className: 'wb-btn is-ghost ag3-mini', 'data-ag-act': 'group-retry',
										onClick: () => retryGroupMsg(m.cid),
									}, '重试'))
								: null,
							m.state === 'pending' ? h('div', { className: 'ag3-gpend' }, '发送中…') : null)));
					prev = { at, who };
				}
				return out;
			};

			/**
			 * 群聊中间栏（2026-10-26 重写，对齐 DeepSeekBot 的 `message-groups.ts`）：
			 *   · 消息按 **5 分钟成组**（同作者连续），只首条显示名字/头像
			 *   · 距上一条 **≥30 分钟**或**跨天** ⇒ 插时间分隔
			 *   · 右对齐自己的、左对齐成员的，各自有头像
			 *   · 本地 pending / failed 追加在末尾（failed 可点重试）
			 */
			const midGroup = (g) => {
				const raw = Array.isArray(g.transcript) ? g.transcript : [];
				// 服务端消息 + 本地待发送/失败（只取这个群的）
				const mine = gOut.filter((x) => x.gid === String(g.id));
				const rows = raw.map((m) => ({
					at: Number(m.at) || 0,
					text: String(m.text || m.content || ''),
					role: String(m.role || 'member'),
					agentId: String(m.agentId || m.name || ''),
					files: Array.isArray(m.files) ? m.files : [],
					state: '',
				})).concat(mine.map((x) => ({
					at: x.at, text: x.text, role: 'user', agentId: '', state: x.state, cid: x.cid, err: x.err,
					files: Array.isArray(x.files) ? x.files : [],
				})));
				return h('div', { className: 'ag3-m', 'data-ag-mid': 'group' },
					h('div', { className: 'ag3-mhd' },
						h('span', { className: 'ag-gmark' }, '#'),
						h('div', { className: 'ag3-mhd-main' },
							h('div', { className: 'ag3row-l1' },
								h('span', { className: 'ag3-mname', 'data-ag-file-name': String(g.name || g.id || '') }, String(g.name || g.id || '?')),
								h('span', { className: 'wb-badge' }, String(g.mode || 'open'))),
							h('div', { className: 'ag3row-l2' },
								(Array.isArray(g.members) ? g.members.length : 0) + ' 位成员 · ' + rows.length + ' 条消息',
								/* 投递状态：取**最近一条带 deliveries 的用户消息**（一次派发的真实结果） */
								(() => {
									const last = [...raw].reverse()
										.find((m) => Array.isArray(m.deliveries) && m.deliveries.length);
									const sum = last ? summarizeDeliveries(last.deliveries) : null;
									if (!sum) { return null; }
									return h('span', {
										className: 'ag3-dl' + (sum.pending ? ' is-wait' : (sum.failed ? ' is-bad' : ' is-done')),
										'data-ag-delivery': sum.text,
										title: sum.title,
									}, ' · ' + sum.text);
								})())),
						h('span', { className: 'wb-spacer' }),
						/* ★ 2026-10-26：两个按钮都改成**页内二级页**（原来走 openModuleRoute ⇒ 新 webview
						   ⇒ 真机 `emulate timeout` ⇒ 黑屏）。邀请成员 = 同一个设置页（成员区在最下面）。 */
						h('button', { type: 'button', className: 'wb-btn', 'data-ag-act': 'group-invite', onClick: () => openGroupSet(g) }, '邀请成员'),
						h('button', { type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'group-settings', onClick: () => openGroupSet(g) }, '群设置')),
					h('div', { className: 'ag3-mlist', 'data-ag-midlist': 'group', 'data-ag-gcount': String(rows.length) },
						rows.length
							? groupRows(rows, mentionMembersOf(g))
							: h('p', { className: 'wb-empty', 'data-ag-mid-empty': '' }, '群里还没有消息 —— 在下面发一句开始。')),
					/* 待发送附件（2026-10-26）：上传成功的先排成一行 chip，可单个移除。
					   `gUpBusy` 时显示「上传中…」，失败显示原因（不是静默）。 */
					(gFiles.length || gUpBusy || gUpErr)
						? h('div', { className: 'ag3-gup', 'data-ag-gup': String(gFiles.length) },
							gUpBusy ? h('span', { className: 'ag3-gup-chip is-busy', 'data-ag-gup-busy': '' }, '上传中…') : null,
							...gFiles.map((f, i) => h('span', { className: 'ag3-gup-chip', key: 'u' + i },
								/^image\//i.test(String(f.mime || '')) ? '🖼 ' : '📄 ',
								h('span', { className: 'ag3-gup-name' }, String(f.name || '附件')),
								h('button', {
									type: 'button', className: 'ag3-gup-x', 'data-ag-act': 'group-remove-file',
									'aria-label': '移除附件', title: '移除这个附件',
									onClick: () => setGFiles((prev) => prev.filter((x) => x.id !== f.id)),
								}, '✕'))),
							gUpErr ? h('span', { className: 'ag3-gup-err', 'data-ag-gup-err': '' }, '⚠ ' + gUpErr) : null)
						: null,
					// 隐藏的 file input：点 composer 的「＋」时由 gPickRef 触发
					h('input', {
						key: 'gpick', type: 'file', multiple: true, className: 'ag3-gpick',
						ref: gPickRef, 'data-ag-act': 'group-file-input', 'aria-hidden': 'true', tabIndex: -1,
						onChange: (ev) => {
							const list = ev.target.files ? Array.from(ev.target.files) : [];
							ev.target.value = '';   // 清空才能重复选同一个文件
							for (const f of list) { void uploadGroupFile(g, f); }
						},
					}),
					// ★ 发送**就在这里发**（原来接的是 openModuleRoute「跳去群聊页」，等于发不出去）
					composer('发消息…', 'group-send',
						() => { void sendGroupMsg(g, gDraft[String(g.id)] || ''); },
						gFiles.length ? ('群聊 · ' + String(g.mode || 'open') + ' · ' + gFiles.length + ' 个附件') : ('群聊 · ' + String(g.mode || 'open')),
						{
							value: gDraft[String(g.id)] || '',
							taRef: groupTaRef,
							/* `@` 提及：候选浮层 + 键盘（↑↓/Enter/Tab/Esc）+ Backspace 整块删 */
							at: atState,
							onKeyDown: (ev) => atKey(ev, g),
							onAtChoose: (item) => atChoose(item, g),
							onChange: (ev) => {
								const v = ev.target.value;
								const gid = String(g.id);
								setGDraft((prev) => { const n = { ...prev }; n[gid] = v; return n; });
								try { window.localStorage.setItem('vssaros.agents.gDraft.' + gid, v); } catch (e) { /* ignore */ }
								// ⚠ caret 必须从**事件**里取：state 里的 value 比 DOM 慢一帧，算出来会错位
								const caret = Number.isInteger(ev.target.selectionStart) ? ev.target.selectionStart : v.length;
								atSync(v, caret, g);
							},
							// 「＋」= 选附件（不传的话点＋会直接发消息，那是旧行为）
							onPick: () => { try { if (gPickRef.current) { gPickRef.current.click(); } } catch (e) { /* ignore */ } },
						}));
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
					// 2026-10-25：按用户要求，「委派任务」从中间栏搬到这里；「Agent 设置」也在这里给一个入口
					//   （左栏 item 的 hover 齿轮仍保留 —— 那是"在这一行上顺手点"，这里是"看完档案再改"）。
					//   ⚠ 右栏只有 320 宽 ⇒ 用**图标 + title**，不写中文（否则会挤掉"会话 N"）。
					curAgent ? h('button', {
						type: 'button', className: 'wb-btn is-ghost ag3-hbtn', 'data-ag-act': 'delegate',
						// ★ 2026-10-26 用户确认：右栏用**图标**不写中文（320 宽，文字会挤掉「会话 N」）。
						//   `data-tip` 走 CSS tooltip（悬停 0ms 出现）；`title`/`aria-label` 保留给
						//   原生提示与读屏（三者都留，缺一个都会让"图标按钮"变得不可发现/不可读）。
						title: '委派任务（切到「委派」页签）', 'aria-label': '委派任务', 'data-tip': '委派任务',
						/* ★ 2026-10-26：原来跳完整页（新开 webview）。工作台**本来就有**「委派」页签
						   ⇒ 直接切页签，零新窗口、零加载等待。 */
						onClick: () => setTab('assign'),
					}, '⇄') : null,
					curAgent ? h('button', {
						type: 'button', className: 'wb-btn is-ghost ag3-hbtn', 'data-ag-act': 'settings',
						title: 'Agent 设置（站内弹层，不开编辑器）', 'aria-label': 'Agent 设置', 'data-tip': 'Agent 设置',
						onClick: () => setSettingFor(curAgent.id),
					}, gearIcon()) : null,
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

			/* ── Agent 设置 = **二级页面**（2026-10-25 用户要求：点击后进入二级页面）──────
			   ⚠ 之前是站内**弹层**（`.ag3-mask` 遮罩 + `.ag3-dlg`）。用户要的是页面级切换：
			     整块内容区换成设置页，顶部有「← 返回」回到三栏。
			   ⚠ 仍然**不开编辑器**（桌面全窗环境里 openEditor 会整窗黑屏）。 */
			/* ── 设置页：**React 重写**（2026-10-25 用户要求：转 React / 统一样式 / 统一数据源 / 都搬到 dsh 侧）──
			   数据源**只有** `/x/agents/api/*`：
			     读  GET  /api/home（agents[].name/description/role/model/presetId/toolCount/personaBytes/registered）
			     写  POST /api/agents { action:'update', id, draft:{ name, description, role, model } }  ← 2026-10-25 新加
			     写  POST /api/agents { action:'resetModel', id } / { action:'set-subagent', id, enabled }
			   样式**只用共享层**（`wb-*` 原语 + `--dsw-alias-*` / `--wb-*` 令牌），不写裸色。
			   页签按 IDE 侧 `agentSettingsEditorPane.ts` 的 8 个对齐；**没后端支撑的如实标"待接"**，不假装。 */
			const SET_TABS = [
				{ k: 'basic', label: '基本信息', icon: '📋' },
				{ k: 'prompt', label: 'System Prompt', icon: '💬' },
				{ k: 'runtime', label: '运行时', icon: '⚙️' },
				{ k: 'versions', label: '版本', icon: '🕐' },
				{ k: 'skills', label: '技能', icon: '🛠' },
				{ k: 'channel', label: 'Channel', icon: '🔗' },
				{ k: 'mcp', label: 'MCP', icon: '🔌' },
				{ k: 'rules', label: 'Rule', icon: '📏' },
			];
			/** 从表单容器按 data-ag-field 读值（不引入受控 state，打开时用 defaultValue 填） */
			const readField = (k) => {
				const el = document.querySelector('[data-ag-settings-form] [data-ag-field="' + k + '"]');
				return el ? String(el.value || '').trim() : '';
			};
			/** 保存基本信息（name / description / role / model） */
			const saveSetBasic = async () => {
				if (setBusy) { return; }
				const name = readField('name');
				if (!name) { setSetErr('名字不能为空'); setSetOk(''); return; }
				const draft = { name, description: readField('description'), role: readField('role') };
				const model = readField('model');
				if (model) { draft.model = model; }
				setSetBusy(true); setSetErr(''); setSetOk('');
				try {
					const res = await fetch('/x/agents/api/agents', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action: 'update', id: String(settingFor), draft }),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setSetOk('已保存');
					void load();
				} catch (e) {
					setSetErr(String((e && e.message) || e));
				} finally {
					setSetBusy(false);
				}
			};
			/** 运行时页签的两个开关（各自独立提交） */
			const toggleSubagent = async (enabled) => {
				setSetBusy(true); setSetErr(''); setSetOk('');
				try {
					const res = await fetch('/x/agents/api/agents', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action: 'set-subagent', id: String(settingFor), enabled: enabled === true }),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setSetOk(enabled ? '已允许被委派' : '已禁止被委派');
					void load();
				} catch (e) { setSetErr(String((e && e.message) || e)); } finally { setSetBusy(false); }
			};
			/** 读某只 bot 的 System Prompt（`.agent.md` 正文）—— 走 `GET /api/agents?id=` */
			const loadPrompt = async (id) => {
				setPromptLoaded(false);
				setSetErr('');
				try {
					const res = await fetch('/x/agents/api/agents?id=' + encodeURIComponent(String(id)), { credentials: 'same-origin' });
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setPromptText(String((j.draft && j.draft.persona) || ''));
					setPromptLoaded(true);
				} catch (e) {
					setSetErr(String((e && e.message) || e));
					setPromptText('');
					setPromptLoaded(true);
				}
			};
			/** 保存 System Prompt（写回 `.agent.md` 正文；与"改基本信息"同一条 action:'update'） */
			const savePrompt = async () => {
				if (promptBusy) { return; }
				setPromptBusy(true); setSetErr(''); setSetOk('');
				try {
					// ⚠ 必须把 name 一起带上：`validateDraft` 要求 name 必填
					//   （update 是"整份重写"，不是"只改一个字段"）
					const a = agents.find((x) => x.id === settingFor);
					const draft = { name: String((a && a.name) || settingFor), persona: String(promptText) };
					const res = await fetch('/x/agents/api/agents', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action: 'update', id: String(settingFor), draft }),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setSetOk('人设已保存（' + String(promptText.length) + ' 字）');
					void load();
				} catch (e) {
					setSetErr(String((e && e.message) || e));
				} finally {
					setPromptBusy(false);
				}
			};
			/** 读版本数据（一次拿全：log + versions + backups + branches + git 状态） */
			const loadEvo = async (id) => {
				setEvo({ status: 'loading', data: null, error: '' });
				try {
					const q = '/x/agents/api/memory?agent=' + encodeURIComponent(String(id))
						+ '&limit=30&versions=1&backups=1&branches=1';
					const res = await fetch(q, { credentials: 'same-origin' });
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setEvo({ status: 'ready', data: j, error: '' });
				} catch (e) {
					setEvo({ status: 'error', data: null, error: String((e && e.message) || e) });
				}
			};
			/** 版本页签上的写动作（全部走 `/api/memory`） */
			const evoAct = async (action, extra) => {
				if (evoBusy) { return; }
				setEvoBusy(true); setEvoMsg('');
				try {
					const res = await fetch('/x/agents/api/memory', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action, agent: String(settingFor), ...(extra || {}) }),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setEvoMsg('✓ ' + action + ' 成功');
					void loadEvo(String(settingFor));
				} catch (e) {
					setEvoMsg('⚠ ' + String((e && e.message) || e));
				} finally {
					setEvoBusy(false);
				}
			};
			/** 读技能：可用池（skills 插件）+ 该 agent 已启用（.agent.md 的 skills: 逗号串） */
			const loadSkills = async (id) => {
				setSkillLoaded(false);
				setSetErr('');
				try {
					const [own, pool] = await Promise.all([
						fetch('/x/agents/api/agents?id=' + encodeURIComponent(String(id)), { credentials: 'same-origin' })
							.then(r => r.json()).catch(() => ({})),
						fetch('/x/skills/api/skills', { credentials: 'same-origin' })
							.then(r => r.json()).catch(() => ({})),
					]);
					const raw = String((own && own.draft && own.draft.skills) || '');
					setSkillOwned(raw.split(',').map(s => s.trim()).filter(Boolean));
					setSkillPool(Array.isArray(pool && pool.skills)
						? pool.skills.map(s => ({ name: String((s && s.name) || ''), description: String((s && s.description) || '') })).filter(s => s.name)
						: []);
				} catch (e) {
					setSetErr(String((e && e.message) || e));
					setSkillPool([]);
					setSkillOwned([]);
				} finally {
					setSkillLoaded(true);
				}
			};
			/** 保存技能勾选（数组 → `draft.skills`，序列化成 `skills: a, b`） */
			const saveSkills = async () => {
				if (skillBusy) { return; }
				setSkillBusy(true); setSetErr(''); setSetOk('');
				try {
					const a = agents.find((x) => x.id === settingFor);
					// ⚠ 必须带 name：update 是整份重写，validateDraft 要 name 必填
					const draft = { name: String((a && a.name) || settingFor), skills: skillOwned.slice() };
					const res = await fetch('/x/agents/api/agents', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action: 'update', id: String(settingFor), draft }),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setSetOk('技能已保存（' + String(skillOwned.length) + ' 个）');
					void load();
				} catch (e) {
					setSetErr(String((e && e.message) || e));
				} finally {
					setSkillBusy(false);
				}
			};
			/** 读"这只 bot 在哪些群里"（dsh 侧的 channel 对应物） */
			const loadChannels = async (id) => {
				setChLoaded(false);
				try {
					const res = await fetch('/x/agents/api/groups', { credentials: 'same-origin' });
					const j = await res.json().catch(() => ({}));
					const all = Array.isArray(j && j.groups) ? j.groups : [];
					setChGroups(all
						.filter((g) => Array.isArray(g && g.members) && g.members.map(String).includes(String(id)))
						.map((g) => ({ id: String(g.id || ''), name: String(g.name || ''), mode: String(g.mode || '') })));
				} catch (e) {
					setChGroups([]);
				} finally {
					setChLoaded(true);
				}
			};
			const resetModelOf = async () => {
				setSetBusy(true); setSetErr(''); setSetOk('');
				try {
					const res = await fetch('/x/agents/api/agents', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action: 'resetModel', id: String(settingFor) }),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					setSetOk('已改为跟随默认模型');
					void load();
				} catch (e) { setSetErr(String((e && e.message) || e)); } finally { setSetBusy(false); }
			};

			const settingPage = () => {
				const a = agents.find((x) => x.id === settingFor);
				if (!a) {
					return h('div', { className: 'ag2-page', 'data-ag-settings-page': '' },
						h('div', { className: 'ag2-hd' },
							h('button', { type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'settings-back', onClick: () => setSettingFor('') }, '← 返回'),
							h('b', null, 'Agent 设置')),
						h('p', { className: 'wb-empty' }, '这个 agent 不见了（可能已被删除）。'));
				}
				const d = home[a.id] || {};
				const field = (k, label, value, placeholder, hint) => h('label', { className: 'ag2-field', key: k },
					h('span', { className: 'ag2-field-lb' }, label),
					h('input', { className: 'wb-input', 'data-ag-field': k, defaultValue: value || '', placeholder: placeholder || '' }),
					hint ? h('span', { className: 'ag2-field-hint' }, hint) : null);
				/**
				 * 模型 = **下拉框**（2026-10-26 用户要求）。
				 *
				 * 候选来自 `/api/home` 的 `modelCandidates`（= `modelCandidatesOf`，
				 * 只收**合法**的 `provider/model` 引用 ⇒ 裸名 `claude-sonnet-4-20250514` 进不来）。
				 *
				 * ⚠ 但当前值如果**不在候选里**（比如旧数据里的裸名），必须仍在下拉里**显示出来**
				 *   并标红 —— 否则用户看到的"选中项"和真实值不一致，会以为已经改好了。
				 */
				const modelField = (a) => {
					const cur = String(a.model || '');
					const cands = (data && Array.isArray(data.modelCandidates)) ? data.modelCandidates.map(String) : [];
					const legal = /^[^/\s]+\/\S+$/.test(cur);
					const opts = [{ v: '', t: '跟随默认模型' }];
					for (const c of cands) { opts.push({ v: c, t: c }); }
					if (cur && !cands.includes(cur)) {
						opts.push({ v: cur, t: cur + (legal ? '（不在候选里）' : '  ⚠ 旧格式，需清空或改成 provider/model') });
					}
					return h('label', { className: 'ag2-field', key: 'model' },
						h('span', { className: 'ag2-field-lb' }, '模型'),
						h('select', {
							className: 'wb-select', 'data-ag-field': 'model', defaultValue: cur,
						}, opts.map((o) => h('option', { key: o.v, value: o.v }, o.t))),
						h('span', { className: 'ag2-field-hint' },
							'留空 = 跟随默认。候选只列**合法**的 provider/model'
							+ (cands.length ? '（当前 ' + String(cands.length) + ' 个）' : '（暂时没有可选项，说明还没有哪个 agent 用过合法模型）')
							+ '。'));
				};

				/** 没后端支撑的页签：**如实**列出缺口，而不是画假控件 */
				const pending = (title, lines) => h('div', { className: 'ag2-sec', 'data-ag-settings-pending': title },
					h('div', { className: 'ag2-sec-hd' }, title + ' · 待接'),
					...lines.map((t, i) => h('p', { className: 'ag-hint', key: 'l' + i }, t)));

				const bodyOf = () => {
					if (stab === 'basic') {
						return h('div', { className: 'ag2-sec', 'data-ag-settings-form': '' },
							h('div', { className: 'ag2-sec-hd' }, '身份'),
							field('name', '名字', a.name, '例如：Code Architect'),
							field('description', '描述', a.description, '一句话说明它擅长什么'),
							field('role', '角色', a.role, '例如：架构设计'),
							// 模型是**下拉框**（2026-10-26 用户要求），不是自由输入
							modelField(a),
							h('div', { className: 'ag2-kv' }, h('span', null, 'id'), h('code', null, String(a.id) + '（不可改）')),
							h('div', { className: 'ag2-kv' }, h('span', null, '预设'), h('code', null, String(a.presetId || '—'))),
							h('div', { className: 'ag2-kv' }, h('span', null, '注册'), h('span', null, a.registered ? '已注册' : '未注册（花名册里没有它的 preset）')));
					}
					if (stab === 'prompt') {
						/* ★ 2026-10-25 接通了：读 `GET /api/agents?id=` 拿正文，写 `action:'update'` 的 draft.persona。
						   之前这里是「待接」占位 —— 因为只有写没有读（`/api/home` 只给 personaBytes 字数）。 */
						return h('div', { className: 'ag2-sec' },
							h('div', { className: 'ag2-sec-hd' }, 'System Prompt（写进 .agent.md 的正文）'),
							!promptLoaded ? h('p', { className: 'ag-hint' }, '正在读取人设…') : null,
							h('textarea', {
								className: 'ag2-ta', rows: 14, value: promptText,
								'data-ag-prompt': '', placeholder: '例如：你是一名代码架构师，优先给出模块划分与依赖方向。',
								onChange: (ev) => setPromptText(ev.target.value),
							}),
							h('div', { className: 'ag2-row' },
								h('button', {
									type: 'button', className: 'wb-btn is-primary', 'data-ag-act': 'settings-save-prompt',
									disabled: promptBusy || !promptLoaded, onClick: () => { void savePrompt(); },
								}, promptBusy ? '保存中…' : '💾 保存人设'),
								h('span', { className: 'ag2-field-hint' }, String(promptText.length) + ' 字'),
								h('button', {
									type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'settings-reload-prompt',
									disabled: promptBusy, onClick: () => { void loadPrompt(String(settingFor)); },
								}, '↻ 重新读取')),
							h('p', { className: 'ag-hint' }, '保存会**重写整个 .agent.md**（名字沿用当前值）。改完立刻重新注册 preset。'));
					}
					if (stab === 'runtime') {
						return h('div', { className: 'ag2-sec' },
							h('div', { className: 'ag2-sec-hd' }, '运行时'),
							h('div', { className: 'ag2-kv' }, h('span', null, '模型'), h('span', null, String(a.model || '跟随默认模型'))),
							h('div', { className: 'ag2-row' },
								h('button', {
									type: 'button', className: 'wb-btn', 'data-ag-act': 'settings-reset-model',
									disabled: setBusy, onClick: () => { void resetModelOf(); },
								}, '↺ 改为跟随默认模型'),
								h('button', {
									type: 'button', className: 'wb-btn', 'data-ag-act': 'settings-allow-sub',
									disabled: setBusy, onClick: () => { void toggleSubagent(true); },
								}, '允许被委派'),
								h('button', {
									type: 'button', className: 'wb-btn', 'data-ag-act': 'settings-deny-sub',
									disabled: setBusy, onClick: () => { void toggleSubagent(false); },
								}, '禁止被委派')),
							h('div', { className: 'ag2-kv' }, h('span', null, '工具'), h('span', null, String(a.toolCount || 0) + ' 个')),
							h('div', { className: 'ag2-kv' }, h('span', null, '会话'), h('span', null, String(d.sessionsTotal || 0) + ' 个 · 进行中 ' + String(Array.isArray(d.running) ? d.running.length : 0))),
							pending('Turn Budget', [
								'后端缺：`set-limits` 是「记忆口径」（chars/mode），不是 IDE 那个「每 Turn 最大迭代次数（默认 90）」。',
								'下一步：`.agent.md` 加 `budget` 字段 + 写口，再接这里。',
							]));
					}
					if (stab === 'versions') {
						/* ★ 2026-10-25 接通：数据来自**记忆库**（`/api/memory?agent=&versions=1&backups=1&branches=1`）。
						   元素结构（memory.js 实测，不是猜的）：
						     log[]      = { hash, date, subject }
						     versions[] = { tag, date, hash }
						     branches[] = { name, hash, date, current }
						     backups[]  = { id, at, reason, files }
						   写动作全部 `POST /api/memory { action, agent, … }`。 */
						const d = evo.data || {};
						const gitOn = !!(d.git && d.git.enabled);
						const logs = Array.isArray(d.log) ? d.log : [];
						const vers = Array.isArray(d.versions) ? d.versions : [];
						const baks = Array.isArray(d.backups) ? d.backups : [];
						const brs = Array.isArray(d.branches) ? d.branches : [];
						const row = (key, left, mid, acts) => h('div', { className: 'ag2-kv ag2-evrow', key },
							h('span', { className: 'ag2-ev-l' }, left),
							h('span', { className: 'ag2-ev-m' }, mid),
							h('span', { className: 'ag2-ev-a' }, ...acts));
						return h('div', { className: 'ag2-sec', 'data-ag-evo': evo.status },
							h('div', { className: 'ag2-kv' },
								h('span', null, 'Git'),
								h('span', null, gitOn
									? ('已启用 · 分支 ' + String(d.branch || '—') + (d.branchDirty ? ' · 有未提交改动' : ' · 干净'))
									: '未启用（记忆库还不是 git 仓库）')),
							evo.status === 'loading' ? h('p', { className: 'ag-hint' }, '正在读版本…') : null,
							evo.status === 'error' ? h('p', { className: 'ag2-err' }, '⚠ ' + evo.error) : null,
							evoMsg ? h('p', { className: 'ag-hint', 'data-ag-evo-msg': '' }, evoMsg) : null,
							h('div', { className: 'ag2-row' },
								!gitOn ? h('button', {
									type: 'button', className: 'wb-btn is-primary', 'data-ag-act': 'settings-evo-enable',
									disabled: evoBusy, onClick: () => { void evoAct('enable-git'); },
								}, '启用 Git') : null,
								gitOn ? h('button', {
									type: 'button', className: 'wb-btn is-primary', 'data-ag-act': 'settings-evo-snapshot',
									disabled: evoBusy, title: '提交一条快照（提交前会自动备份一份）',
									onClick: () => { void evoAct('snapshot', { message: '设置页手动快照' }); },
								}, '＋ 快照') : null,
								h('button', {
									type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'settings-evo-reload',
									disabled: evoBusy, onClick: () => { void loadEvo(String(settingFor)); },
								}, '↻ 刷新')),

							gitOn ? h('div', { className: 'ag2-sec-hd' }, '提交历史 · ' + String(logs.length)) : null,
							...(gitOn ? logs.slice(0, 12).map((c, i) => row('c' + i,
								String(c.hash || '').slice(0, 7),
								String(c.date || '') + '  ' + String(c.subject || ''),
								[
									h('button', {
										type: 'button', className: 'wb-btn is-ghost ag3-mini', 'data-ag-act': 'settings-evo-tag',
										disabled: evoBusy, title: '给这次提交打个 tag（快照）',
										onClick: () => { void evoAct('version-add', { tag: 'v' + Date.now().toString(36), rev: c.hash }); },
									}, 'tag'),
									h('button', {
										type: 'button', className: 'wb-btn is-ghost ag3-mini', 'data-ag-act': 'settings-evo-restore',
										disabled: evoBusy, title: '把 MEMORY.md 回滚到这次提交（回滚前自动备份）',
										onClick: () => { void evoAct('restore', { rev: c.hash, file: 'MEMORY.md' }); },
									}, '回滚'),
								])) : []),

							gitOn && vers.length ? h('div', { className: 'ag2-sec-hd' }, '版本（tag）· ' + String(vers.length)) : null,
							...(gitOn ? vers.slice(0, 12).map((v, i) => row('v' + i,
								String(v.tag || ''),
								String(v.date || '') + '  ' + String(v.hash || ''),
								[h('button', {
									type: 'button', className: 'wb-btn is-ghost ag3-mini', 'data-ag-act': 'settings-evo-version-del',
									disabled: evoBusy, onClick: () => { void evoAct('version-remove', { tag: v.tag }); },
								}, '删除')])) : []),

							baks.length ? h('div', { className: 'ag2-sec-hd' }, '备份 · ' + String(baks.length) + '（保留 ' + String(d.backupKeep || 0) + '）') : null,
							...baks.slice(0, 6).map((b, i) => row('b' + i,
								String(b.id || ''),
								String(b.reason || '') + (b.at ? '  ' + new Date(Number(b.at)).toLocaleString() : ''),
								[h('button', {
									type: 'button', className: 'wb-btn is-ghost ag3-mini', 'data-ag-act': 'settings-evo-backup-restore',
									disabled: evoBusy, onClick: () => { void evoAct('restore-backup', { backup: b.id }); },
								}, '恢复')])),

							gitOn && brs.length ? h('div', { className: 'ag2-sec-hd' }, '分支 · ' + String(brs.length)) : null,
							...(gitOn ? brs.slice(0, 8).map((n, i) => row('br' + i,
								String(n.name || '') + (n.current ? '（当前）' : ''),
								String(n.date || ''),
								[h('button', {
									type: 'button', className: 'wb-btn is-ghost ag3-mini', 'data-ag-act': 'settings-evo-branch-switch',
									disabled: evoBusy || !!n.current, onClick: () => { void evoAct('branch-switch', { name: n.name }); },
								}, '切换')])) : []),

							h('p', { className: 'ag-hint' }, '版本是**记忆库**（MEMORY.md）的 Git 历史，不是 .agent.md 的历史。快照/回滚前都会自动备份一份。'));
					}
					if (stab === 'skills') {
						/* ★ 2026-10-25 接通：不需要新增后端接口 —— 两块数据本来就都有
						     池：`GET /x/skills/api/skills`  → skills[]{ name, description }
						     已选：`GET /x/agents/api/agents?id=` → draft.skills（逗号串）
						   写：`POST /api/agents { action:'update', draft:{ name, skills:[…] } }`
						     （`normalizeDraft` 的 `listOf` 会把数组归一化成 `skills: a, b`） */
						const needle = skillFilter.trim().toLowerCase();
						const shown = needle
							? skillPool.filter((s) => (s.name + ' ' + s.description).toLowerCase().includes(needle))
							: skillPool;
						return h('div', { className: 'ag2-sec', 'data-ag-skills': skillLoaded ? 'ready' : 'loading' },
							h('div', { className: 'ag2-sec-hd' }, '可用技能 · 已选 ' + String(skillOwned.length) + ' / ' + String(skillPool.length)),
							h('div', { className: 'ag2-row' },
								h('input', {
									className: 'wb-input ag-sk-search', value: skillFilter, placeholder: '筛选技能…',
									'aria-label': '筛选技能', 'data-ag-skill-filter': '',
									onChange: (ev) => setSkillFilter(ev.target.value),
								}),
								h('button', {
									type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'settings-skill-reload',
									onClick: () => { void loadSkills(String(settingFor)); },
								}, '↻ 重读'),
								h('span', { className: 'wb-spacer' }),
								h('button', {
									type: 'button', className: 'wb-btn is-primary', 'data-ag-act': 'settings-save-skills',
									disabled: skillBusy || !skillLoaded, onClick: () => { void saveSkills(); },
								}, skillBusy ? '保存中…' : '💾 保存技能')),
							!skillLoaded ? h('p', { className: 'ag-hint' }, '正在读技能池…') : null,
							skillLoaded && !skillPool.length
								? h('p', { className: 'ag-hint', 'data-ag-skills-empty': '' },
									'技能池是空的 —— `vssaros-skills` 里还没有技能（去技能工作台装一个）。')
								: null,
							...shown.slice(0, 200).map((s) => {
								const on = skillOwned.includes(s.name);
								return h('label', { className: 'ag2-skill' + (on ? ' is-on' : ''), key: s.name },
									h('input', {
										type: 'checkbox', checked: on, 'data-ag-skill': s.name,
										onChange: (ev) => setSkillOwned((prev) => (ev.target.checked
											? [...new Set([...prev, s.name])]
											: prev.filter((x) => x !== s.name))),
									}),
									h('span', { className: 'ag2-skill-n' }, s.name),
									s.description ? h('span', { className: 'ag2-skill-d' }, s.description.slice(0, 70)) : null);
							}),
							h('p', { className: 'ag-hint' },
								'勾选会写进 `.agent.md` 的 `skills:`（逗号分隔）。保存后立刻重新注册 preset。'));
					}
					if (stab === 'channel') {
						/* ★ 2026-10-25：从"待接"改成**如实可用** —— dsh 侧没有飞书凭据，
						   但它有真实的对应物：**群聊**。群的 `members` 就是"哪些 agent 在这个渠道里"。
						   ⇒ 显示"它参与了哪些群"，并给去群聊页管理的入口。 */
						return h('div', { className: 'ag2-sec', 'data-ag-channels': chLoaded ? 'ready' : 'loading' },
							h('div', { className: 'ag2-sec-hd' }, '参与的群聊 · ' + String(chGroups.length)),
							!chLoaded ? h('p', { className: 'ag-hint' }, '正在读群聊…') : null,
							chLoaded && !chGroups.length
								? h('p', { className: 'ag-hint', 'data-ag-channels-empty': '' },
									'它还没有被加进任何群 —— 在「群聊 ＋」里建一个群并勾选它。')
								: null,
							...chGroups.map((g) => h('div', { className: 'ag2-kv', key: g.id },
								h('span', null, g.name || g.id),
								h('span', null, '模式 ' + g.mode),
								h('span', { className: 'wb-spacer' }),
								h('button', {
									type: 'button', className: 'wb-btn is-ghost ag3-mini', 'data-ag-act': 'settings-goto-group',
									/* ★ 2026-10-26：改成"在左栏选中这个群"（零新窗口），不再跳独立群聊页 */
									onClick: () => {
										setSettingFor('');
										setSel({ kind: 'group', id: String(g.id) });
									},
								}, '打开这个群 →'))),
							h('div', { className: 'ag2-row' },
								h('button', {
									type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'settings-channel-reload',
									onClick: () => { void loadChannels(String(settingFor)); },
								}, '↻ 刷新')),
							h('p', { className: 'ag-hint' },
								'说明：**飞书 / 外部 Channel 的绑定不在 dsh 侧** —— 那需要飞书 App 凭证，'
								+ '在 IDE 主进程里（TOF 登录态）。dsh 侧的"渠道"就是**群聊**：把 bot 加进群，它就能在群里被点名。'));
					}
					if (stab === 'mcp') { return pending('MCP 配置', ['IDE 侧自己也是「🚧 即将上线」⇒ 不需要复刻。']); }
					return pending('Rule 配置', ['IDE 侧自己也是「🚧 即将上线」⇒ 不需要复刻。']);
				};

				return h('div', { className: 'ag2-page', 'data-ag-settings': settingFor, 'data-ag-settings-page': '', 'data-ag-settings-tab': stab },
					h('div', { className: 'ag2-hd' },
						h('button', {
							type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'settings-back',
							title: '返回 Bots 列表', onClick: () => { setSettingFor(''); setSetErr(''); setSetOk(''); },
						}, '← 返回'),
						h('b', null, String(a.name || a.id)),
						h('span', { className: 'ag2-sub' }, 'Agent 设置'),
						h('span', { className: 'wb-spacer' }),
						// ⚠ 必须判**值**（setOk），不能判 setter（setSetOk 是函数，恒真 ⇒ 永远渲染且内容为空）
						setOk ? h('span', { className: 'ag2-ok', 'data-ag-settings-ok': '' }, setOk) : null,
						stab === 'basic'
							? h('button', {
								type: 'button', className: 'wb-btn is-primary', 'data-ag-act': 'settings-save',
								disabled: setBusy, onClick: () => { void saveSetBasic(); },
							}, setBusy ? '保存中…' : '💾 保存')
							: null),
					h('nav', { className: 'ag2-tabs', role: 'tablist', 'data-ag-settings-tabs': '' },
						SET_TABS.map((t) => h('button', {
							key: t.k, type: 'button', role: 'tab', 'data-ag-stab': t.k,
							'aria-selected': stab === t.k ? 'true' : 'false',
							className: 'ag2-tab' + (stab === t.k ? ' is-on' : ''),
							onClick: () => {
								setStab(t.k); setSetErr(''); setSetOk('');
								// System Prompt 要先读正文；版本要读记忆库（只有切到该页签才拉，避免每次开设置页都多请求）
								if (t.k === 'prompt') { void loadPrompt(String(settingFor)); }
								if (t.k === 'versions') { void loadEvo(String(settingFor)); }
								if (t.k === 'skills') { void loadSkills(String(settingFor)); }
								if (t.k === 'channel') { void loadChannels(String(settingFor)); }
							},
						}, t.icon + ' ' + t.label))),
					h('div', { className: 'ag2-body' },
						// ⚠ 同上：判值不是判 setter（否则会渲染出 '⚠ function () { [native code] }'）
						setErr ? h('p', { className: 'ag2-err', 'data-ag-settings-err': '' }, '⚠ ' + setErr) : null,
						bodyOf()));
			};

			/* ★ 2026-10-26 用户要求：「新建 bot」的面板作为**二级页面**展示。
			   和 `settingFor`（Agent 设置）同一模式：`rosterPane()` 里优先返回它，
			   整块内容区切换（三栏让位），顶部一条「← 返回」。
			   ⚠ 表单本体沿用原来的 81 行（只换了外壳），避免重写字段逻辑出错。 */
			const createPage = () => (
				h('div', { className: 'ag3-sub', 'data-ag-create': creating, 'data-ag-subpage': 'create' },
					h('div', { className: 'ag3-subinner' },
						h('div', { className: 'ag3-dlg-hd ag3-subhd' },
							h('button', {
								type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'create-close',
								title: '返回名册', onClick: closeCreate,
							}, '← 返回'),
							h('b', null, creating === 'group' ? '新建群聊' : '新建 bot'),
							h('span', { className: 'wb-spacer' })),
						h('div', { className: 'ag3-dlg-bd' },
							h('label', { className: 'ag3-field' },
								h('span', null, '名字'),
								h('input', {
									className: 'wb-input', value: form.name, 'data-ag-create-name': '',
									placeholder: creating === 'group' ? '例如：架构评审群' : '例如：Code Architect',
									// 名字变了就跟着改 id（用户手动改过 id 就不再覆盖）
									onChange: (ev) => setForm((f) => {
										const v = ev.target.value;
										return { ...f, name: v, id: f.idTouched ? f.id : slugify(v) };
									}),
								})),
							creating === 'agent'
								? h('label', { className: 'ag3-field' },
									h('span', null, 'id（目录名 · 必填）'),
									h('input', {
										className: 'wb-input', value: form.id, 'data-ag-create-id': '',
										placeholder: '例如：code-architect',
										onChange: (ev) => setForm((f) => ({ ...f, id: ev.target.value, idTouched: true })),
									}))
								: null,
							creating === 'group'
								? h('label', { className: 'ag3-field' },
									h('span', null, '模式'),
									h('select', {
										className: 'wb-select', 'data-ag-create-mode': '', value: form.mode,
										onChange: (ev) => setForm((f) => ({ ...f, mode: ev.target.value })),
									},
										// ⚠ 合法值只有 all / mentions（normalizeGroupMode 只认 GROUP_MODES；
										//   写 `open` 会被静默改成 `all` —— 用户看到的和存下去的就对不上）
										h('option', { value: 'all' }, 'all（都能发言）'),
										h('option', { value: 'mentions' }, 'mentions（只回应 @）')))
								: h('label', { className: 'ag3-field' },
									h('span', null, '描述（可空）'),
									h('input', {
										className: 'wb-input', value: form.description, 'data-ag-create-desc': '',
										placeholder: '一句话说明它擅长什么',
										onChange: (ev) => setForm((f) => ({ ...f, description: ev.target.value })),
									})),
							creating === 'group'
								? h('div', { className: 'ag3-field' },
									h('span', null, '成员（已选 ' + form.members.length + '）'),
									h('div', { className: 'ag3-members', 'data-ag-create-members': '' },
										// 名册为空时给提示 —— 否则用户看到一块空白，提交时只被告知"至少要选一个成员"，
										// 却不知道该选谁（这是最容易被当成"没反应"的场景）。
										agents.filter((x) => x.registered).length === 0
											? h('p', { className: 'ag-hint', 'data-ag-create-no-members': '' },
												'名册里还没有可选的 Bot —— 先点「已注册 ＋」建一个，再回来建群。')
											: null,
										agents.filter((x) => x.registered).map((x) => {
											const on = form.members.includes(x.id);
											return h('label', { key: x.id, className: 'ag3-member' + (on ? ' is-on' : '') },
												h('input', {
													type: 'checkbox', checked: on, 'data-ag-member': x.id,
													onChange: (ev) => setForm((f) => ({
														...f,
														members: ev.target.checked ? [...f.members, x.id] : f.members.filter((m) => m !== x.id),
													})),
												}),
												h('span', null, String(x.name || x.id)));
										})))
								: h('label', { className: 'ag3-field' },
									h('span', null, '人设（可空，之后在完整页细化）'),
									h('textarea', {
										className: 'ag3-create-ta', rows: 3, value: form.persona, 'data-ag-create-persona': '',
										placeholder: '例如：你是一名代码架构师，优先给出模块划分与依赖方向。',
										onChange: (ev) => setForm((f) => ({ ...f, persona: ev.target.value })),
									})),
							createErr ? h('p', { className: 'ag3-err-txt', 'data-ag-create-err': '' }, '⚠ ' + createErr) : null),
						h('div', { className: 'ag3-dlg-ft' },
							h('button', {
								type: 'button', className: 'wb-btn is-primary', 'data-ag-act': 'create-submit',
								disabled: createBusy, onClick: () => { void submitCreate(); },
							}, createBusy ? '创建中…' : '创建'),
							h('button', { type: 'button', className: 'wb-btn is-ghost', onClick: closeCreate }, '取消'))))
			);

			/* ══ 群设置 = 二级页面（2026-10-26）═══════════════════════════════════════
			   为什么从「开编辑器页」改成「页内二级页」：
			     原来「群设置 / 邀请成员」→ `openModuleRoute('/x/agents/group/<id>')` → 宿主新建 webview。
			     真机日志显示该 webview `emulate prefers-color-scheme failed … emulate timeout`（没就绪）
			     ⇒ 用户看到**黑屏**；同一个 webview 若再被复制一份，整机还会出现 exit code=1。
			   现在：零新窗口 / 零新 WebContents，能力不减（改名 / 策略 / 成员增删 / 删群全走 /api/groups）。
			   保留「打开完整群聊页 ↗」作为逃生通道（历史消息全文、附件管理等 SSR 侧能力在那边）。 */

			/** 调一次 `/api/groups` 的写动作；失败按后端给的 message 抛。 */
			const postGroupAction = async (body) => {
				const res = await fetch('/x/agents/api/groups', {
					method: 'POST', headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				});
				const j = await res.json().catch(() => ({}));
				if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
				return j;
			};

			/** 进群设置页：把该群当前值灌进表单（避免"打开看到的是上一个群"） */
			const openGroupSet = (g) => {
				if (!g || !g.id) { return; }
				setGroupSetFor(String(g.id));
				setGsName(String(g.name || g.id));
				setGsMode(String(g.mode || 'all'));
				setGsErr(''); setGsOk('');
			};

			/** 统一包一层 busy/错误/成功提示；成功后触发群清单刷新。 */
			const runGroupAction = async (body, okText) => {
				setGsBusy(true); setGsErr(''); setGsOk('');
				try {
					await postGroupAction(body);
					setGsOk(okText || '已保存');
					setGroupsTick((t) => t + 1);
					return true;
				} catch (e) {
					setGsErr(String((e && e.message) || e));
					return false;
				} finally {
					setGsBusy(false);
				}
			};

			const groupSetPage = () => {
				const t = groups.find((x) => String(x.id) === String(groupSetFor));
				const back = h('button', {
					type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'group-set-back',
					onClick: () => setGroupSetFor(''),
				}, '← 返回');
				if (!t) {
					return h('div', { className: 'ag3-sub', 'data-ag-gset': 'missing' },
						h('div', { className: 'ag3-subinner' }, back,
							h('p', { className: 'wb-empty' }, '这个群不存在了（可能已被删除）。')));
				}
				const members = Array.isArray(t.members) ? t.members.map(String) : [];
				const MODES = [['all', '全员派发'], ['mentions', '仅 @ 派发'], ['digest', '汇总派发'], ['silent', '静默收件']];
				return h('div', { className: 'ag3-sub', 'data-ag-gset': String(t.id) },
					h('div', { className: 'ag3-subinner' },
						h('div', { className: 'ag3-dlg-hd ag3-subhd' },
							back,
							h('b', null, '群设置 · ' + String(t.name || t.id)),
							h('span', { className: 'wb-spacer' }),
							h('button', {
								type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'group-set-full',
								onClick: () => openModuleRoute('/x/agents/group/' + encodeURIComponent(String(t.id)), '群聊页'),
							}, '打开完整群聊页 ↗')),
						gsErr ? h('p', { className: 'ag2-err', 'data-ag-gset-err': '' }, '⚠ ' + gsErr) : null,
						gsOk ? h('p', { className: 'ag2-ok', 'data-ag-gset-ok': '' }, '✓ ' + gsOk) : null,
						h('label', { className: 'ag3-field' },
							h('span', null, '群名'),
							h('input', {
								className: 'wb-input', value: gsName, 'data-ag-gset-name': '',
								onChange: (ev) => setGsName(ev.target.value),
							})),
						/* ★ 2026-10-26 群主：设了群主后，改名/改策略/加人/移人/删群**只有群主 bot 或人**能做。
						   （不设 = 人管，向后兼容存量群） */
						h('label', { className: 'ag3-field' },
							h('span', null, '群主'),
							h('select', {
								className: 'wb-input', 'data-ag-gset-owner': '',
								value: String(t.ownerAgentId || ''),
								disabled: gsBusy,
								onChange: (ev) => {
									const v = String(ev.target.value || '');
									const nm = (agents.find((a) => String(a.id) === v) || {}).name || v;
									void runGroupAction(
										{ action: 'mode', id: String(t.id), ownerAgentId: v },
										v ? ('群主已移交给 ' + nm) : '已取消群主（由人管理）',
									);
								},
							}, [h('option', { key: '__none', value: '' }, '我（人管，不设群主）')]
								.concat(members.map((id) => h('option', { key: id, value: id },
									String((agents.find((a) => String(a.id) === id) || {}).name || id))))),
							h('span', { className: 'ag-hint' },
								'设了群主后：改名 / 改策略 / 加人 / 移人 / 删群都只允许群主 bot 或人。')),
						h('label', { className: 'ag3-field' },
							h('span', null, '唤醒策略'),
							h('select', {
								className: 'wb-input', value: gsMode, 'data-ag-gset-mode': '',
								onChange: (ev) => setGsMode(ev.target.value),
							}, MODES.map(([v, label]) => h('option', { key: v, value: v }, label)))),
						/* ★ 2026-10-26 群内接力：默认**关闭**。开启后成员回复里 @ 到别人会转给对方。
						   四道闸（hop≤4 / 同根不重复叫醒 / 单根≤6 次 / 只认显式 @）在服务端
						   `planRelay` 里 —— 这里只做开关，别在前端再算一遍策略。 */
						h('label', { className: 'ag3-field ag3-field-row' },
							h('input', {
								type: 'checkbox', 'data-ag-gset-relay': '',
								checked: !!(t.relay && t.relay.enabled === true),
								disabled: gsBusy,
								onChange: (ev) => {
									const on = ev.target.checked === true;
									void runGroupAction(
										{ action: 'mode', id: String(t.id), allowRelay: on },
										on ? '已开启群内接力（成员回复里 @ 别人会转给他）' : '已关闭群内接力',
									);
								},
							}),
							h('span', null, '群内接力'),
							h('span', { className: 'ag-hint' },
								'开启后：成员答复里 @ 到的同群成员会收到这条答复（最多 4 跳，同一根消息不重复叫醒同一人，单根最多 6 次）。@所有人 在接力里不生效。')),

						/* ★ 2026-10-26 派发方式：steer 会**注入正在跑的回合**（可能把话插进中间），
						   followup 则**等这一回合结束**再作为新回合处理（不打断，消息也不会丢）。 */
						h('label', { className: 'ag3-field' },
							h('span', null, '派发方式'),
							h('select', {
								className: 'wb-input', 'data-ag-gset-dispatch': '',
								value: String(t.dispatchMode || 'steer'),
								disabled: gsBusy,
								onChange: (ev) => {
									const v = String(ev.target.value || 'steer');
									void runGroupAction(
										{ action: 'dispatch', id: String(t.id), dispatchMode: v },
										v === 'followup' ? '已改为排队（等成员当前回合结束再派）' : '已改为抢断（立刻注入成员当前回合）',
									);
								},
							}, [['steer', '抢断（立刻注入当前回合）'], ['followup', '排队（等当前回合结束）']]
								.map(([v, label]) => h('option', { key: v, value: v }, label))),
							h('span', { className: 'ag-hint' },
								'抢断：成员正在生成时会立刻看到这条（可能打断它）；排队：等它这一回合跑完再开新回合。')),
						h('div', { className: 'ag3-field' },
							h('button', {
								type: 'button', className: 'wb-btn is-primary', 'data-ag-act': 'group-set-save',
								disabled: gsBusy,
								onClick: async () => {
									// 改名与改策略是两个 action ⇒ 分别发；任一失败都会有红字（不静默）
									const okName = await runGroupAction({ action: 'rename', id: String(t.id), name: gsName }, '名称已保存');
									if (okName && String(t.mode || 'all') !== gsMode) {
										await runGroupAction({ action: 'mode', id: String(t.id), mode: gsMode }, '已保存');
									}
								},
							}, gsBusy ? '保存中…' : '保存名称与策略')),
						h('div', { className: 'ag3-field' },
							h('span', null, '成员（' + members.length + '）'),
							h('div', { className: 'ag3-members', 'data-ag-gset-members': '' },
								(() => {
									/* 同名冲突时给成员行补 ` · id`（只改显示，不删数据）—— 否则两行一模一样 */
									const pool = agents.filter((x) => x.registered);
									const counts = new Map();
									for (const x of pool) {
										const k = String(x.name || x.id).toLocaleLowerCase();
										counts.set(k, (counts.get(k) || 0) + 1);
									}
									return pool.map((x) => ({
										agent: x,
										disp: (counts.get(String(x.name || x.id).toLocaleLowerCase()) || 0) > 1
											? (String(x.name || x.id) + ' · ' + String(x.id)) : String(x.name || x.id),
									}));
								})().map(({ agent: x, disp }) => {
									const on = members.includes(String(x.id));
									/* ★ 2026-10-26 成员级接收策略：`inherit` = 跟随群默认（后端算好生效值放在
									   `t.wakeEffective[id]`，这里只判断"有没有个人配置"用于显示）。
									   群成员才给下拉 —— 非成员连消息都收不到，改策略没有意义。 */
									const MODE_LABEL = { all: '全员', mentions: '仅 @', digest: '汇总', silent: '静默' };
									const own = (t.wakePolicies && t.wakePolicies[String(x.id)]) || 'inherit';
									const eff = (t.wakeEffective && t.wakeEffective[String(x.id)]) || String(t.mode || 'all');
									return h('label', { key: x.id, className: 'ag3-member' + (on ? ' is-on' : '') },
										h('input', {
											type: 'checkbox', checked: on, 'data-ag-gset-member': x.id,
											disabled: gsBusy,
											onChange: (ev) => {
												const want = ev.target.checked;
												void runGroupAction(
													want
														? { action: 'invite', id: String(t.id), members: [String(x.id)] }
														: { action: 'remove', id: String(t.id), member: String(x.id) },
													want ? ('已加入 ' + disp) : ('已移出 ' + disp),
												);
											},
										}),
										h('span', { className: 'ag3-mname2' }, disp),
									on ? h('select', {
										className: 'ag3-gmode',
										'data-ag-gset-member-mode': String(x.id),
										title: own === 'inherit'
											? ('跟随群默认：' + MODE_LABEL[eff] + '（' + eff + '）')
											: ('个人策略：' + MODE_LABEL[own] + '（' + own + '）'),
										value: own,
										disabled: gsBusy,
										/* 阻止冒泡：member 是 <label>，点 select 会顺带切换 checkbox（=邀请/移出） */
										onClick: (ev) => ev.stopPropagation(),
										onChange: (ev) => {
											const mode = String(ev.target.value || 'inherit');
											void runGroupAction(
												{ action: 'policy', id: String(t.id), agentId: String(x.id), mode },
												'已更新 ' + String(x.name || x.id) + ' 的接收策略：'
													+ (mode === 'inherit' ? ('继承（' + MODE_LABEL[eff] + '）') : MODE_LABEL[mode]),
											);
										},
									}, [['inherit', '继承'], ['all', '全员'], ['mentions', '仅 @'], ['digest', '汇总'], ['silent', '静默']]
										.map(([v, label]) => h('option', { key: v, value: v }, label))) : null);
								}))),
						h('div', { className: 'ag3-field' },
							h('button', {
								type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'group-set-delete',
								disabled: gsBusy,
								onClick: async () => {
									const yes = (() => { try { return window.confirm('删除群「' + String(t.name || t.id) + '」？消息记录会一起删除，不可恢复。'); } catch (e) { return false; } })();
									if (!yes) { return; }
									const ok = await runGroupAction({ action: 'delete', id: String(t.id) }, '已删除');
									if (ok) { setGroupSetFor(''); }
								},
							}, '删除这个群'),
							h('span', { className: 'ag-hint' }, ' 删除后不可恢复；只想清理成员请用上面的勾选。')),
					));
			};

			const rosterPane = () => {
				// 二级页面优先：有 settingFor 就整块内容区换成设置页
				if (settingFor) { return settingPage(); }
				// 群设置也是二级页（2026-10-26）：不再新开 webview（那是黑屏的根因）
				if (groupSetFor) { return groupSetPage(); }
				// 创建 bot / 新建群聊也是**二级页面**（2026-10-26）：整块让位，返回名册
				if (creating) { return createPage(); }
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
					/* ★ 2026-10-26 用户要求：创建入口**移进名册页**（左栏顶部），不占工具栏。
					   （原来这里是 `＋ Bot` / `＋ 群聊` 两个文字按钮 —— 那是 2026-10-25 为
					     "入口太隐蔽"加的；现在统一收到 `leftPane` 顶部，工具栏只留刷新/完整页。） */
					tab === 'roster' ? h('input', {
						className: 'wb-input ag-search', value: q, placeholder: '筛选', 'aria-label': '筛选 agent',
						'data-ag-search': '', onChange: (ev) => setQ(ev.target.value),
					}) : null,
					h('button', {
						type: 'button', className: 'wb-btn ag-refresh' + (refreshing ? ' is-busy' : ''),
						'data-ag-act': 'refresh', 'aria-busy': refreshing ? 'true' : 'false', disabled: refreshing,
						title: refreshing ? '正在刷新…' : '重新读取（GET /x/agents/api/home）',
						onClick: () => { void load(); setGroupsTick((t) => t + 1); },
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

				/* ── 创建 bot / 新建群聊 = **二级页面**（2026-10-26 用户要求）────────
				   原来是 `ag3-mask` 居中弹层（点遮罩关闭）。现在改成占满内容区的二级页：
				     · 容器 `ag3-sub`（不再 fixed 遮罩、点外部不关）
				     · 顶部一条 header：「← 返回」+ 标题
				     · 表单区 `ag3-subbd` 直接铺开（原来是窄弹窗，字段挤在一列）
				   ⚠ 表单本体一个字没改 —— 只换了外壳，避免重写 81 行字段逻辑出错。 */
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
/* 投递状态（群头部"已回 2/3"） */
.ag3-dl { font-variant-numeric:tabular-nums; }
.ag3-dl.is-wait { color:var(--dsw-alias-state-warning-primary, #e0a43a); }
.ag3-dl.is-bad { color:var(--dsw-alias-state-error-primary, #e05252); }
.ag3-dl.is-done { color:var(--dsw-alias-state-success-primary, #3fb950); }
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

/* ── 右栏 header 的图标按钮（委派 ⇄ / 设置 ⚙）──────────────────────────
   右栏固定 320 宽，写中文会挤掉「会话 N」⇒ 只放图标 + title 提示。 */
.ag3-hbtn { height:20px; min-width:20px; padding:0 4px; font-size:var(--wb-f-xs); line-height:1; opacity:.7; }
.ag3-hbtn:hover { opacity:1; }

/* ── 分组折叠（2026-10-25）：标题整行可点，caret 折叠时转 -90° ──────────── */
.ag3-sechd-toggle { cursor:pointer; user-select:none; }
.ag3-sechd-toggle:hover { color:var(--dsw-alias-label-secondary, inherit); }
.ag3-sechd-toggle:focus-visible { outline:1px solid var(--dsw-alias-brand-primary, #007fd4); outline-offset:1px; }
.ag3-caret { display:inline-block; width:9px; font-size:9px; line-height:1; opacity:.75;
  transition:transform 120ms ease; }
.ag3-caret.is-off { transform:rotate(-90deg); }

/* ── 创建 Bot / 群聊 弹层的表单（复用 .ag3-dlg 外观，不开编辑器）────────── */
.ag3-field { display:flex; flex-direction:column; gap:4px; font-size:var(--wb-f-xs); }
.ag3-field > span { color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.65)); }
.ag3-field .wb-input, .ag3-field .wb-select { width:100%; }
/* 带 checkbox 的一行式字段（群内接力开关等）：复选框与标题同行，说明折到下一行 */
.ag3-field-row { flex-direction:row; flex-wrap:wrap; align-items:center; gap:6px; }
.ag3-field-row input[type="checkbox"] { margin:0; flex:0 0 auto; }
.ag3-field-row > .ag-hint { flex:1 1 100%; }
.ag3-create-ta { width:100%; resize:vertical; min-height:64px; padding:6px 8px; border-radius:var(--wb-r-sm);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); background:transparent;
  color:var(--dsw-alias-label-primary, inherit); font:inherit; font-size:var(--wb-f-xs); line-height:1.6; }
.ag3-members { display:flex; flex-wrap:wrap; gap:4px; max-height:180px; overflow:auto; padding:4px;
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius:var(--wb-r-sm); }
.ag3-member { display:inline-flex; align-items:center; gap:4px; font-size:var(--wb-f-xs); padding:2px 6px;
  border-radius:var(--wb-r-sm); cursor:pointer; color:var(--dsw-alias-label-secondary, inherit); }
.ag3-member.is-on { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16));
  color:var(--dsw-alias-label-primary, inherit); }
/* 成员级接收策略下拉（2026-10-26）：成员是 <label>，下拉要能单独点而不误触邀请/移出 */
.ag3-member .ag3-mname2 { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ag3-gmode { flex:0 0 auto; font-size:10px; padding:1px 2px; border-radius:4px; cursor:pointer;
  background:var(--dsw-alias-bg-module-platform, rgba(127,127,127,.16));
  color:var(--dsw-alias-label-secondary, inherit);
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28)); }
.ag3-err-txt { margin:0; font-size:var(--wb-f-xs); color:var(--dsw-alias-state-error-primary, #e05252); }
.ag3-mini-row { display:inline-flex; gap:2px; align-items:center; }
/* 分组标题右侧的小动作键（＋ / ↗ / ✕）：原来**没有样式**，只吃 wb-btn 默认值 ⇒
   视觉上「＋」才 13px，点偏就落到标题上把分组折了，看着像"点了没反应"。给足 22×22。 */
.ag3-mini { min-width:22px; height:22px; padding:0 4px; display:inline-flex;
  align-items:center; justify-content:center; line-height:1; flex:0 0 auto; }

/* ── Agent 设置 = 二级页面（2026-10-25 用户要求：从弹层改成页面级切换）─────
   整块内容区换成设置页，顶部「← 返回」回到三栏。 */
.ag2-page { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
.ag2-hd { display:flex; align-items:center; gap:var(--wb-s2); padding:var(--wb-s2) var(--wb-s3); flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.ag2-sub { font-size:var(--wb-f-xs); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.ag2-body { flex:1 1 auto; min-height:0; overflow:auto; padding:var(--wb-s3);
  display:flex; flex-direction:column; gap:var(--wb-s4); max-width:860px; }
.ag2-sec { display:flex; flex-direction:column; gap:5px; }
.ag2-sec-hd { font-size:var(--wb-f-xs); font-weight:600;
  color:var(--dsw-alias-label-secondary, rgba(230,230,230,.8)); }
.ag2-kv { display:flex; gap:var(--wb-s2); font-size:var(--wb-f-xs); align-items:baseline; }
.ag2-kv > span:first-child { min-width:84px; flex:0 0 auto;
  color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }

/* ── Agent 设置二级页 = iframe 加载完整页（2026-10-25 用户要求）───────────
   ⚠ 用 iframe 而不是 openEditor：桌面全窗客户端没有编辑区，开编辑器页会整窗黑屏。 */


/* ── 设置页（React 版，2026-10-25）：页签条 / 表单 / 状态行 ─────────────── */
.ag2-tabs { display:flex; gap:2px; padding:var(--wb-s1) var(--wb-s2); flex:none; flex-wrap:wrap;
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.ag2-tab { height:28px; padding:0 10px; border-radius:var(--wb-r-sm); border:1px solid transparent;
  background:transparent; color:var(--dsw-alias-label-secondary, inherit); font:inherit;
  font-size:var(--wb-f-xs); cursor:pointer; white-space:nowrap; }
.ag2-tab:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.ag2-tab.is-on { color:var(--dsw-alias-label-primary, inherit);
  background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16));
  border-color:var(--dsw-alias-border-l2, rgba(127,127,127,.4)); }
.ag2-field { display:flex; flex-direction:column; gap:3px; max-width:520px; margin-bottom:6px; }
.ag2-field-lb { font-size:var(--wb-f-xs); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.65)); }
.ag2-field-hint { font-size:var(--wb-f-xs); color:var(--dsw-alias-label-quaternary, rgba(230,230,230,.5)); }
.ag2-row { display:flex; gap:var(--wb-s1); flex-wrap:wrap; }
.ag2-ok { font-size:var(--wb-f-xs); color:var(--dsw-alias-state-success-primary, #3fa45b); }
.ag2-err { margin:0 0 6px; font-size:var(--wb-f-xs); color:var(--dsw-alias-state-error-primary, #e05252); }

/* ── 设置页 · 版本页签的行（2026-10-25）────────────────────────────────── */
.ag2-evrow { align-items:center; gap:var(--wb-s2); padding:2px 0; }
.ag2-ev-l { min-width:64px; flex:0 0 auto; font-family:var(--wb-font-mono, ui-monospace, Consolas, monospace);
  color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.65)); }
.ag2-ev-m { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--dsw-alias-label-secondary, inherit); }
.ag2-ev-a { flex:0 0 auto; display:inline-flex; gap:2px; }

/* ── 设置页 · 技能页签的行（2026-10-25）────────────────────────────────── */
.ag2-skill { display:flex; align-items:baseline; gap:var(--wb-s2); padding:3px 4px; cursor:pointer;
  border-radius:var(--wb-r-sm); font-size:var(--wb-f-xs); }
.ag2-skill:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10)); }
.ag2-skill.is-on { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.ag2-skill-n { flex:0 0 auto; min-width:140px;
  color:var(--dsw-alias-label-primary, inherit); font-family:var(--wb-font-mono, ui-monospace, Consolas, monospace); }
.ag2-skill-d { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }

/* ── 群聊消息（2026-10-26 复刻 DeepSeekBot 的 message-groups / message-bubble）──
   5 分钟成组（组内隐藏头像与名字、上方圆角收紧）+ ≥30 分钟插时间分隔 + failed 可重试。 */
.ag3-gmsg { display:flex; gap:8px; align-items:flex-start; margin-top:3px; }
.ag3-gmsg.is-grp { margin-top:-6px; }
.ag3-gmsg.is-me { flex-direction:row-reverse; }
.ag3-gav { width:26px; height:26px; border-radius:8px; flex:0 0 26px; display:flex; align-items:center;
  justify-content:center; font-size:11px; font-weight:600;
  color:var(--dsw-alias-label-primary, #fff);
  background:var(--dsw-alias-bg-module-platform, rgba(127,127,127,.22)); }
.ag3-gav.is-hidden { visibility:hidden; }
.ag3-gcol { min-width:0; max-width:78%; display:flex; flex-direction:column; }
.ag3-gmsg.is-me .ag3-gcol { align-items:flex-end; }
.ag3-gwho { font-size:11.5px; font-weight:600; margin-bottom:3px;
  color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); }
.ag3-gbub { border-radius:14px; padding:7px 11px; font-size:var(--wb-f-xs); line-height:1.65;
  white-space:pre-wrap; word-break:break-word;
  background:var(--dsw-alias-bg-module-platform, rgba(127,127,127,.16));
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); }
.ag3-gmsg.is-grp .ag3-gbub { border-top-left-radius:4px; }
.ag3-gmsg.is-me .ag3-gbub { background:var(--dsw-alias-brand-primary, #007fd4);
  border-color:transparent; color:var(--dsw-alias-label-primary, #fff); border-top-right-radius:4px; }
/* @ 提及：气泡里的 token 用强调色（不是裸 hex —— 跟随主题令牌） */
.ag3-gat { color:var(--dsw-alias-brand-primary, #4c9aff); font-weight:600; }
.ag3-gmsg.is-me .ag3-gat { color:inherit; text-decoration:underline; text-underline-offset:2px; }
.ag3-gat.is-all { color:var(--dsw-alias-state-warning-primary, #e0a43a); }
/* @ 候选浮层（2026-10-26）：贴着输入卡片上方弹出；320px 宽的右栏/中间栏都能放 */
.ag3-compwrap { position:relative; }
.ag3-atpop { position:absolute; left:8px; right:8px; bottom:calc(100% - 2px); z-index:30;
  display:flex; flex-direction:column; gap:1px; padding:4px;
  max-height:232px; overflow:auto;
  border-radius:10px; background:var(--dsw-alias-bg-overlay, rgba(30,30,30,.98));
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
  box-shadow:var(--wb-shadow-dialog, 0 8px 24px rgba(0,0,0,.28)); }
.ag3-atitem { display:flex; align-items:center; gap:8px; width:100%;
  padding:6px 8px; border:0; border-radius:7px; cursor:pointer; text-align:left;
  background:transparent; color:var(--dsw-alias-label-primary, inherit);
  font-size:var(--wb-f-xs); line-height:1.4; }
.ag3-atitem:hover, .ag3-atitem.is-on { background:var(--dsw-alias-bg-module-platform, rgba(127,127,127,.22)); }
.ag3-atitem .ag3-atmark { flex:none; width:14px; text-align:center;
  color:var(--dsw-alias-brand-primary, #4c9aff); font-weight:600; }
.ag3-atitem .ag3-atname { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ag3-atitem .ag3-atid { flex:none; max-width:44%;
  color:var(--dsw-alias-label-quaternary, rgba(230,230,230,.5));
  font-family:var(--wb-font-mono, monospace); font-size:10px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ag3-gsep { text-align:center; font-size:11px; margin:10px 0 4px;
  color:var(--dsw-alias-label-quaternary, rgba(230,230,230,.5)); }
.ag3-gpend { font-size:11px; margin-top:2px; color:var(--dsw-alias-label-quaternary, rgba(230,230,230,.5)); }
.ag3-gfail { display:flex; align-items:center; gap:6px; font-size:11px; margin-top:3px;
  color:var(--dsw-alias-state-error-primary, #e05252); }
.ag3-gmsg.is-fail .ag3-gbub { opacity:.72;
  border-color:var(--dsw-alias-state-error-primary, #e05252); }

/* 系统提示（接力/未派发/失败）：居中一行，不占气泡 */
.ag3-gsys { text-align:center; font-size:11px; margin:6px 0;
  color:var(--dsw-alias-label-quaternary, rgba(230,230,230,.55)); }

/* 白屏兜底（2026-10-26）：错误边界渲染的提示块 —— 至少让"白屏"变成可截图的错误。 */
.ag-crash { padding:24px; max-width:720px; margin:0 auto; text-align:left; }
.ag-crash-msg { margin:8px 0; font-family:ui-monospace,Menlo,monospace; font-size:12px;
  color:var(--dsw-alias-state-error-primary, #e05252); white-space:pre-wrap; word-break:break-word; }
.ag-crash-stack { margin:8px 0; padding:8px; max-height:180px; overflow:auto; font-size:11px;
  line-height:1.5; white-space:pre-wrap; border-radius:6px;
  background:var(--dsw-alias-bg-module-platform, rgba(127,127,127,.12));
  color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.7)); }

/* ── 群聊附件（2026-10-26）：气泡里的图片缩略图 / 文件卡片 + 待发 chip 行 ──
   图片走 <img src="/api/group-file?id=">：服务端按 mime 设 content-type，浏览器直接渲染，
   不需要前端转 base64（省内存、也避免大图把 DOM 字符串撑大）。 */
.ag3-gbub.is-fileonly { padding:6px; }
.ag3-gfiles { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.ag3-gbub.is-fileonly .ag3-gfiles { margin-top:0; }
.ag3-gimg-a { display:block; line-height:0; border-radius:8px; overflow:hidden;
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.ag3-gimg { display:block; max-width:220px; max-height:160px; object-fit:cover; }
.ag3-gfile { display:inline-flex; align-items:center; gap:6px; padding:5px 9px; border-radius:8px;
  font-size:var(--wb-f-xs); text-decoration:none; color:inherit;
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  background:var(--dsw-alias-bg-module-platform, rgba(127,127,127,.10)); }
.ag3-gfile:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18)); }
.ag3-gfile-n { max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ag3-gfile-s { opacity:.6; }
.ag3-gup { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:6px 2px 2px; }
.ag3-gup-chip { display:inline-flex; align-items:center; gap:5px; padding:2px 6px 2px 8px;
  border-radius:999px; font-size:11px;
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25));
  background:var(--dsw-alias-bg-module-platform, rgba(127,127,127,.12)); }
.ag3-gup-chip.is-busy { opacity:.7; }
.ag3-gup-name { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ag3-gup-x { border:0; background:transparent; color:inherit; cursor:pointer; font-size:11px;
  line-height:1; padding:0 2px; opacity:.6; }
.ag3-gup-x:hover { opacity:1; }
.ag3-gup-err { font-size:11px; color:var(--dsw-alias-state-error-primary, #e05252); }
.ag3-gpick { display:none; }

/* ── 名册左栏顶部的创建入口（2026-10-26：从工具栏搬进来，主按钮就叫「新建 bot」）──
   两个按钮并排：「＋ 新建 bot」（主） + 「群聊」（次）。窄屏时自动换行。 */
.ag3-lcreate { display:flex; gap:6px; padding:2px 8px 8px; flex-wrap:wrap; }
.ag3-lcreate-main { flex:1 1 auto; min-width:96px; }
.ag3-lcreate-side { flex:0 0 auto; }

/* ── 创建页 = 二级页面（原来是居中弹层 ag3-mask/ag3-dlg）──
   它现在由 rosterPane() 直接 return，**替代**整个 .ag3 三栏 ⇒ 必须自己占满并滚动。 */
.ag3-sub { flex:1 1 auto; min-width:0; min-height:0; display:flex; flex-direction:column;
  overflow:auto; padding:14px 20px 20px; }
.ag3-subinner { width:100%; max-width:760px; margin:0 auto; display:flex; flex-direction:column; gap:8px; }
.ag3-subhd { display:flex; align-items:center; gap:8px; padding:0 0 10px; flex:0 0 auto;
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
/* 表单区：原来窄弹窗里是一列，现在铺开后两列更顺手（字段少的会自动单列） */
.ag3-sub .ag3-dlg-bd { padding:8px 0 0; overflow:visible; display:grid; gap:8px;
  grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); }
.ag3-sub .ag3-field { display:flex; flex-direction:column; gap:4px; }
/* 成员多选这类"整行"内容跨满所有列 */
.ag3-sub .ag3-dlg-bd > .ag3-members,
.ag3-sub .ag3-dlg-bd > .ag3-create-foot { grid-column:1 / -1; }

/* ── 右栏图标按钮的 tooltip（2026-10-26 用户确认「用图标不写文字」）──
   原生 title 要悬停 ~1s 才出、且样式不可控；右栏窄，图标按钮必须"一看就懂"。
   ⚠ 用 data-tip 而非子元素：tooltip 不能吃掉点击（pointer-events:none）。
   ⚠ 定位锚在按钮**右边缘**并向右不超出：右栏 320 宽，居中对齐会压到中间栏。 */
.ag3-hbtn { position:relative; }
.ag3-hbtn::after {
  content:attr(data-tip);
  position:absolute; top:calc(100% + 6px); right:0;
  padding:3px 8px; border-radius:6px; white-space:nowrap;
  font-size:11px; line-height:1.5; font-weight:400;
  opacity:0; pointer-events:none; transform:translateY(-2px);
  transition:opacity .12s ease, transform .12s ease;
  background:var(--dsw-alias-bg-layer-2, rgba(34,34,34,.97));
  color:var(--dsw-alias-text-primary, #e6e6e6);
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  z-index:20;
}
.ag3-hbtn:hover::after,
.ag3-hbtn:focus-visible::after { opacity:1; transform:translateY(0); }
/* 只有 data-tip 为空时不显示（防御：漏传属性不会留一个空框） */
.ag3-hbtn:not([data-tip])::after { content:none; }
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
		/**
		 * 白屏兜底（2026-10-26 用户报「bots 工作台白屏」）。
		 *
		 * 不加这个的话，任何渲染期异常都会让 React **卸载整棵树** ⇒ 用户看到的是一片纯白，
		 * 而且没有任何线索可以反馈（我这边也拿不到 IDE 的 console：`%APPDATA%\VsSaros\logs`
		 * 停在 8 月，不是活的日志通道）。
		 * ⇒ 兜底成一条可截图的错误行 + 出错位置，至少能定位。
		 *
		 * 只在**渲染期**生效（React 的 error boundary 不捕事件处理器与异步里的错，
		 * 那些由组件内各自的 try/catch 与页面级兜底处理）。
		 */
		/* ⚠⚠ 2026-10-26 真机抓到的致命错误：这里原来写的是 `React.Component`，
		   但本 chunk 只有 `const react = require('react')` + 解构 hooks，**从未定义 `React`**
		   ⇒ 整个子块加载即抛 `ReferenceError: React is not defined`
		   ⇒ 工作台根本没注册（`window.__vssarosAgentsClient.workbenchFailed` 里写得一清二楚）
		   ⇒ Bots 里永远看不到 React 工作台。用 `react.Component`（模块变量）才对。 */
		class WorkbenchBoundary extends react.Component {
			constructor(p) {
				super(p);
				this.state = { err: '', info: '' };
			}
			static getDerivedStateFromError(e) {
				return { err: String((e && e.message) || e || '未知错误') };
			}
			componentDidCatch(e, info) {
				this.setState({ info: String((info && info.componentStack) || '').slice(0, 400) });
			}
			render() {
				if (this.state.err) {
					return h('div', { className: 'wb-empty ag-crash', 'data-ag-crash': '', role: 'alert' },
						h('b', null, '⚠ Bots 工作台渲染出错'),
						h('p', { className: 'ag-crash-msg', 'data-ag-crash-msg': '' }, this.state.err),
						this.state.info ? h('pre', { className: 'ag-crash-stack' }, this.state.info) : null,
						h('p', { className: 'ag-hint' }, '把这段截图反馈即可；「⟳ 刷新」或重开这个页签通常能恢复。'),
						h('button', {
							type: 'button', className: 'wb-btn', 'data-ag-act': 'crash-retry',
							onClick: () => this.setState({ err: '', info: '' }),
						}, '再试一次'));
				}
				return this.props.children;
			}
		}

		function AgentsRoot(props) {
			useEffect(() => { ensureStyle(); }, []);
			// ⚠ boundary 必须在**最外层**：放在 AgentsPanel 内部的话，panel 自己崩了就没人接住
			return h(WorkbenchBoundary, null, h(AgentsPanel, props || null));
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
