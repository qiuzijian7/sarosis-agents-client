// @vssaros/dsh-agents — **群聊聊天框**（独立 chunk，2026-11-02，Bots 工作台重构 · 方案 B）
//
// 为什么拆出来：群聊 UI 有**两个载体**要用同一份实现 ——
//   ① agents 工作台的中间栏（`AgentsPanel` 里选中群聊时）；
//   ② chat-surface 的中栏页签（侧栏「Bots」里点群聊 ⇒ `GroupChatRoot` 只渲染群聊列）。
// 以前它是 `AgentsPanel` 那个 4700 行闭包里的一坨状态 + 函数（midGroup / groupRows / 发送 / 上传 /
// `@` 提及 …），谁想复用都得整个面板带上；本仓已经因为"同一个群聊有两套 UI"踩过一次（独立页 groupPage.js
// 与工作台 midGroup 漂移）。现在群聊聊天框 = 本文件的 `GroupChat` 组件，状态自带、靠 props 驱动，
// 工作台与中栏页签**只此一份**。
//
// ── 边界（刻意的）──────────────────────────────────────────────────────────────
//   · 本文件**只负责聊天列**：头部（群名 / 成员数 / 投递状态 / 三个按钮）+ 消息列表 + 附件 + composer。
//   · 群设置 / IM 绑定 / 「新建会话」的服务端调用**不在这里**：它们与群设置页共享状态
//     （`newGroupSessions` 群设置页也在用），留在 `AgentsPanel`，通过 `onOpenSettings` / `onNewSession` 回调进来。
//   · 样式不在这里：`ag3-*` 类名的 CSS 在 `client.agents.js` 的 `ensureStyle()`（两个入口都会注入）。
//   · 数据**不在这里拉**：`group`（含 transcript）由调用方轮询 `/api/groups` 后传入；本组件只写
//     （发消息 / 传附件），写完调 `reloadGroups()` 让调用方重拉。
//
// ── 装载契约 ────────────────────────────────────────────────────────────────
//   `lib/client.js`（入口）先 `require.async('./client.groupChat.js')`，再把模块交给
//   `client.agents.js` 的 `bindGroupChat(mod)`。探针 / 单测同理：先 factory 出本模块再 bind。
//   ⚠ 本文件**不依赖** client.agents.js（反向才依赖）。
//
// ── 抽取前后行为必须一致（回归：poc/dsh-p0/scripts/p3-189-workbench-group-chat.mjs）──────────
//   · 待发送 / 失败队列（outbox）是**模块级**共享的：切到别的群再切回来，失败的那条还在（与抽取前一致）；
//   · 草稿按群存 `localStorage['vssaros.agents.gDraft.<gid>']`，**同时**留一份内存（about:blank / 隐私模式
//     localStorage 抛 SecurityError 时，切群草稿也不能丢 —— p3-189 ⑤ 就是跑在 about:blank 里的）。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-agents',
	chunk: 'client.groupChat.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');
		const h = react.createElement;
		const { useState, useEffect, useRef } = react;

		/* ══ 群聊 `@` 提及：纯函数（2026-10-26；2026-11-02 随群聊一起搬到本 chunk）═══════════════════
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

		/* ── composer：**复刻 dsh chat-surface**（参数取自真机 `[data-composer-card]`）──
		   agent 会话（`AgentsPanel.midAgent`）与群聊共用这一个：纯展示组件，输入值 / 提交 / 候选
		   全由 props 给，本身无状态 ⇒ 不会因为"两处各写一份"而漂移。 */
		const sendArrow = () => h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' },
			h('path', {
				d: 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z',
				fill: 'currentColor',
			}));
		const plusIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1.3 },
			h('path', { d: 'M8 2V14', stroke: 'currentColor' }), h('path', { d: 'M2 8H14', stroke: 'currentColor' }));

		/**
		 * @param props.placeholder 占位文案
		 * @param props.actKey      data 锚点（chat / group-send）
		 * @param props.onSubmit    回车 / 点发送要做的事
		 * @param props.meta        左下角那行说明（模型 / 模式）
		 * @param props.value/onChange  受控输入（调用方持有）
		 * @param props.at / onKeyDown / onAtChoose  `@` 候选浮层与键盘（群聊用）
		 * @param props.onPick      给了 ⇒ 「＋」是选附件；否则保持"添加文件或调用指令"的旧提示
		 * @param props.busy / streaming / disabled / onStop
		 */
		function Composer(props) {
			const o = props || {};
			const placeholder = o.placeholder;
			const actKey = o.actKey;
			const submit = () => { if (o.onSubmit) { o.onSubmit(); } };
			const busy = !!o.busy;
			const streaming = !!o.streaming;
			const off = !!o.disabled;
			const hint = busy ? '发送中…' : (streaming ? '生成中…' : (o.meta || ''));
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
			if (o.value !== undefined) {
				/* 受控：agent 会话的 draft 与群聊按群保存的草稿都由外部持有输入值 */
				inputProps.value = o.value;
				inputProps.onChange = o.onChange;
			}
			const sendBtn = streaming
				? h('button', {
					type: 'button', className: 'ag3-stop', 'data-ag-act': 'stop',
					'aria-label': '停止生成', title: '停止当前回合', onClick: () => { if (o.onStop) { o.onStop(); } },
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
		}

		/* ── 待发送 / 失败队列（outbox）：**模块级**共享 ────────────────────────────
		   乐观上屏（pending）→ 成功剔除 / 失败转 failed 可重试。放模块级而不是组件 state：
		   用户切到别的群 / 别的页签再回来，失败的那条还得在（抽取前它挂在 AgentsPanel 上，
		   同样是"切群不丢"）；同一个群同时出现在工作台与中栏页签时两边看到同一份队列。 */
		const outbox = { items: [], subs: new Set() };
		const outboxSet = (fn) => {
			outbox.items = fn(outbox.items);
			for (const f of [...outbox.subs]) { try { f(); } catch (e) { /* 单个订阅者出错不影响别人 */ } }
		};
		const useOutbox = () => {
			const [, force] = useState(0);
			useEffect(() => {
				const f = () => force((n) => n + 1);
				outbox.subs.add(f);
				return () => { outbox.subs.delete(f); };
			}, []);
			return outbox.items;
		};

		/* ── 群草稿：按群存 localStorage + 内存各一份 ─────────────────────────────
		   ⚠ 读不到 localStorage（about:blank / 隐私模式抛 SecurityError）时**不能**清空内存里正在打的草稿
		   （2026-10-26 p3-189 抓到的）⇒ 内存优先，localStorage 兜底。 */
		const DRAFT_KEY = 'vssaros.agents.gDraft.';
		const draftMem = new Map();
		const readDraft = (gid) => {
			if (draftMem.has(gid)) { return draftMem.get(gid); }
			let v = '';
			try { const s = window.localStorage.getItem(DRAFT_KEY + gid); if (s !== null) { v = s; } } catch (e) { v = ''; }
			return v;
		};
		const writeDraft = (gid, v) => {
			draftMem.set(gid, v);
			try { window.localStorage.setItem(DRAFT_KEY + gid, v); } catch (e) { /* ignore */ }
		};
		const clearDraft = (gid) => {
			draftMem.delete(gid);
			try { window.localStorage.removeItem(DRAFT_KEY + gid); } catch (e) { /* ignore */ }
		};

		/** 单个附件上限（与后端 `MAX_FILE_BYTES` 同一个数 ⇒ 前端先拦，省一次往返） */
		const MAX_ATTACH = 20 * 1024 * 1024;
		const AT_CLOSED = { open: false, start: 0, end: 0, query: '', active: 0, items: [] };

		/**
		 * 群聊聊天框（2026-10-26 重写，对齐 DeepSeekBot 的 `message-groups.ts`；2026-11-02 抽成独立组件）：
		 *   · 消息按 **5 分钟成组**（同作者连续），只首条显示名字/头像
		 *   · 距上一条 **≥30 分钟**或**跨天** ⇒ 插时间分隔
		 *   · 右对齐自己的、左对齐成员的，各自有头像
		 *   · 本地 pending / failed 追加在末尾（failed 可点重试）
		 *
		 * props：
		 *   group          群对象（含 transcript / members / mode …，调用方轮询 `/api/groups` 得到）
		 *   agents         全部 agent（算 @ 候选、消息里的显示名）
		 *   sessBusy       「新建会话」是否进行中（状态在调用方：群设置页共用同一个）
		 *   onNewSession   (group, 'group'|'all') => void
		 *   onOpenSettings (group) => void   群设置 / 邀请成员（页内二级页，由调用方渲染）
		 *   reloadGroups   () => void        写完让调用方重拉群清单
		 * ⚠ 调用方应给 `key = group.id`：切群 ⇒ 重挂载 ⇒ 待发附件 / `@` 候选自然清空
		 *   （附件在上传时就绑了群 id，不清会把 A 群的附件发到 B 群）。
		 */
		function GroupChat(props) {
			const g = props.group;
			const agents = Array.isArray(props.agents) ? props.agents : [];
			const gid = String(g.id);
			const outItems = useOutbox();
			const [draft, setDraftState] = useState(() => readDraft(gid));
			/* 群聊附件（2026-10-26）：上传走 `POST /api/group-file?group=&name=`（body = 原始字节），
			   拿到 `{ id, name, size, mime }` 后挂在待发送列表里；发送时随消息带 `files[]`。 */
			const [gFiles, setGFiles] = useState([]);
			const [gUpBusy, setGUpBusy] = useState(false);
			const [gUpErr, setGUpErr] = useState('');
			const gPickRef = useRef(null);
			/* `@` 提及（2026-10-26）：输入框监听 → 算 query → 弹候选 → 选中插入。
			   `atState.items` 里直接存候选（含 agent 对象），避免渲染时重算。 */
			const [atState, setAtState] = useState(AT_CLOSED);
			const groupTaRef = useRef(null);

			const setDraft = (v) => { setDraftState(v); writeDraft(gid, v); };

			/* ── `@` 提及：交互层 ───────────────────────────────────────────────── */
			/** 本群成员（按 `g.members` 过滤 agents；候选与派发都用它） */
			const mentionMembersOf = (grp) => {
				const ids = Array.isArray(grp && grp.members) ? grp.members.map(String) : [];
				return agents.filter((a) => ids.includes(String(a.id)));
			};

			const atClose = () => setAtState((s) => (s.open ? AT_CLOSED : s));

			/** 输入变化后重算候选（caret 从事件里取，不要用 state —— 会慢一帧） */
			const atSync = (value, caret, grp) => {
				const q = atQuery(value, caret);
				if (!q) { atClose(); return; }
				const items = atCandidates(mentionMembersOf(grp), q.query);
				if (!items.length) { atClose(); return; }
				setAtState({ open: true, start: q.start, end: q.end, query: q.query, active: 0, items });
			};

			/** 选中候选：写回草稿 + 把 caret 放到 token 之后 */
			const atChoose = (item, grp) => {
				if (!item || !grp || !grp.id) { atClose(); return; }
				const value = draft || '';
				/* ★ 2026-10-26：插入的是**显示名**（`@Code Architect`），不是 id —— 用户看到的是人话。
				   `agentId` 由事后反扫 `atCollect` 得出，服务端用 offset + agentId 派发。 */
				const label = item.kind === 'all' ? AT_ALL : atLabelOf(item.agent);
				if (!label) { atClose(); return; }
				const r = atSelect(value, { start: atState.start, end: atState.end }, label);
				setDraft(r.value);
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
			const atKey = (ev, grp) => {
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
						atChoose(atState.items[cur], grp); ev.preventDefault(); return true;
					}
					if (ev.key === 'Escape') { atClose(); ev.preventDefault(); return true; }
				}
				if ((ev.key === 'Backspace' || ev.key === 'Delete') && grp && grp.id) {
					const value = draft || '';
					const ta = ev.target;
					const s = ta && Number.isInteger(ta.selectionStart) ? ta.selectionStart : value.length;
					const e2 = ta && Number.isInteger(ta.selectionEnd) ? ta.selectionEnd : s;
					const r = atDelete(value, atCollect(value, mentionMembersOf(grp)), s, e2, ev.key);
					if (r) {
						setDraft(r.value);
						requestAnimationFrame(() => {
							try { ta.setSelectionRange(r.caret, r.caret); } catch (e) { /* ignore */ }
						});
						ev.preventDefault();
						return true;
					}
				}
				return false;
			};

			/** 上传一个附件，成功后挂进待发送列表（`gFiles`） */
			const uploadGroupFile = async (grp, file) => {
				if (!grp || !grp.id || !file) { return; }
				if (file.size > MAX_ATTACH) {
					setGUpErr(`${file.name} 太大（${(file.size / 1048576).toFixed(1)}MB，上限 20MB）`);
					return;
				}
				setGUpBusy(true);
				setGUpErr('');
				try {
					const res = await fetch('/x/agents/api/group-file?group=' + encodeURIComponent(String(grp.id))
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

			/** 发一条群消息：乐观上屏（pending）→ 成功剔除 / 失败转 failed 可重试 */
			const sendGroupMsg = async (grp, text) => {
				const txt = String(text || '').trim();
				/* ★ 2026-10-26：允许「只有附件」的消息（后端也放开了这条）。 */
				const filesNow = gFiles.slice();
				if ((!txt && !filesNow.length) || !grp || !grp.id) { return; }
				/* ★ `@` 提及：把 offset 一起发给后端（后端优先用它派发；这是修掉
				   「子串匹配误唤醒」的关键 —— `@test` 不会再命中 `@test1`）。 */
				const members = mentionMembersOf(grp);
				const ats = atCollect(txt, members);
				const cid = 'c' + Date.now().toString(36);
				outboxSet((prev) => [...prev, {
					cid, gid: String(grp.id), text: txt, at: Date.now(), state: 'pending', files: filesNow,
					mentions: ats,
				}]);
				setGFiles([]);
				setGUpErr('');
				setDraftState('');
				clearDraft(String(grp.id));
				try {
					const res = await fetch('/x/agents/api/groups', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							action: 'message', id: String(grp.id), text: txt,
							...(filesNow.length ? { files: filesNow } : {}),
							...(ats.length ? { mentions: ats } : {}),
						}),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || j.ok === false) { throw new Error(j.error || ('HTTP ' + res.status)); }
					outboxSet((prev) => prev.filter((x) => x.cid !== cid));
					if (props.reloadGroups) { props.reloadGroups(); }
				} catch (e) {
					/* 失败时把附件**放回**待发列表：否则用户重试时附件没了，还得重新传一遍。 */
					setGFiles((prev) => [...filesNow, ...prev]);
					outboxSet((prev) => prev.map((x) => (x.cid === cid
						? { ...x, state: 'failed', err: String((e && e.message) || e) } : x)));
				}
			};
			/** 重试一条失败的群消息（cid 不变，不会越点越多） */
			const retryGroupMsg = (cid) => {
				const hit = outbox.items.find((x) => x.cid === cid);
				if (!hit) { return; }
				outboxSet((prev) => prev.filter((x) => x.cid !== cid));
				void sendGroupMsg(g, hit.text);
			};

			/**
			 * 群消息行 —— **与 `lib/core/groupChat.js` 的 `chatRows` 逐字同构**（2026-10-26 收敛）。
			 *
			 * 为什么不是直接 import：本文件是宿主 chunk，跑在 `__ModuleLoader__` 里，
			 * 拿不到本地模块（`require` 只给 react 等宿主模块）。
			 * ⇒ React 侧保留这份同构实现，**由 `p3-190` 用同一组夹具比对两边结果**防漂移。
			 *   改这里的口径时，必须同步改 `core/groupChat.js`，否则 p3-190 立刻红。
			 */
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

			const raw = Array.isArray(g.transcript) ? g.transcript : [];
			// 服务端消息 + 本地待发送/失败（只取这个群的）
			const mine = outItems.filter((x) => x.gid === gid);
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
					/* ★ 2026-10-26 用户报「群会话中缺少新建会话按钮」：
					   群没有单一会话 ⇒ 这个按钮= 给**每个成员**各开一条新会话（旧会话保留）。 */
					h('button', {
						type: 'button', className: 'wb-btn', 'data-ag-act': 'group-newsession',
						disabled: !!props.sessBusy,
						title: '给群内每个成员各开一条新会话并**只绑到本群**（旧会话保留，私聊/其它群不受影响）',
						onClick: () => { if (props.onNewSession) { void props.onNewSession(g, 'group'); } },
					}, props.sessBusy ? '新建中…' : '新建会话'),
					h('button', { type: 'button', className: 'wb-btn', 'data-ag-act': 'group-invite', onClick: () => { if (props.onOpenSettings) { props.onOpenSettings(g); } } }, '邀请成员'),
					h('button', { type: 'button', className: 'wb-btn is-ghost', 'data-ag-act': 'group-settings', onClick: () => { if (props.onOpenSettings) { props.onOpenSettings(g); } } }, '群设置'),
					/* ★ 2026-11-02「展开右侧栏」按钮（用户：群聊 UI 右上角缺少展开按钮）：
					   只在**中栏群聊页签**里出现（调用方给了 `onToggleDrawer`）。
					   为什么要自带：官方右侧栏是**按会话**存在的（官方 README：「Without a session there is no button
					   and no panel」），而群聊页签是我们挂的 `main` 面板、期间没有会话在屏 ⇒ 官方展开按钮 / 右栏
					   在这里根本不存在，只能由面板自己画一个同形态的展开栏（工作台里群设置仍是页内二级页，不画它）。 */
					props.onToggleDrawer
						? h('button', {
							type: 'button', className: 'wb-btn is-ghost ag3-drawer-btn' + (props.drawerOpen ? ' is-on' : ''),
							'data-ag-act': 'group-drawer-toggle',
							'aria-label': props.drawerOpen ? '收起右侧栏' : '展开右侧栏', 'aria-expanded': props.drawerOpen ? 'true' : 'false',
							title: props.drawerOpen ? '收起右侧栏' : '展开右侧栏（群设置）',
							onClick: () => props.onToggleDrawer(),
						}, h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
							h('rect', { x: 1.75, y: 2.75, width: 12.5, height: 10.5, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
							h('path', { d: 'M10 3v10', stroke: 'currentColor', strokeWidth: 1.3 })))
						: null),
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
				h(Composer, {
					placeholder: '发消息…', actKey: 'group-send',
					onSubmit: () => { void sendGroupMsg(g, draft || ''); },
					meta: gFiles.length ? ('群聊 · ' + String(g.mode || 'open') + ' · ' + gFiles.length + ' 个附件') : ('群聊 · ' + String(g.mode || 'open')),
					value: draft || '',
					taRef: groupTaRef,
					/* `@` 提及：候选浮层 + 键盘（↑↓/Enter/Tab/Esc）+ Backspace 整块删 */
					at: atState,
					onKeyDown: (ev) => atKey(ev, g),
					onAtChoose: (item) => atChoose(item, g),
					onChange: (ev) => {
						const v = ev.target.value;
						setDraft(v);
						// ⚠ caret 必须从**事件**里取：state 里的 value 比 DOM 慢一帧，算出来会错位
						const caret = Number.isInteger(ev.target.selectionStart) ? ev.target.selectionStart : v.length;
						atSync(v, caret, g);
					},
					// 「＋」= 选附件（不传的话点＋会直接发消息，那是旧行为）
					onPick: () => { try { if (gPickRef.current) { gPickRef.current.click(); } } catch (e) { /* ignore */ } },
				}));
		}

		module.exports = {
			GroupChat, Composer, summarizeDeliveries,
			// 纯函数（`@` 提及）：p3-197 的同构比对读的是本文件里 @MENTIONS-BEGIN/END 之间的源码；这里再导一份给单测
			at: { atQuery, atSelect, atCollect, atRuns, atDelete, atCandidates, atTargets, atDisplayLabels, atLabelOf, AT_ALL },
			__test: { outbox, draftMem, readDraft, writeDraft, MAX_ATTACH },
		};
		return module.exports;
	},
});
