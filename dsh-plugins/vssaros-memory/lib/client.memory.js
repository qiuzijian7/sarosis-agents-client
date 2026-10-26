// @vssaros/dsh-memory — **React 工作台**（工作台重构 P3 第 3 个；doc/workbench-refactor-plan.md §5 步骤 2）。
//
// 形态与官方一致：经宿主服务 `desktopWorkbenches.register(descriptor, Component)` 注册。
// 数据只从 `GET /x/memory/api/page` 取（与 SSR 页**同一份 state** ⇒ 数字与文案口径一致 ✓）。
//
// 行为与旧 SSR 页**逐条对齐**（`lib/index.js` 的 `renderFragment`）：
//   · 顶部主入口（查看完整记忆 ⇒ `/x/memory/detail`）＋ 四张统计卡（注入字符 / 草稿待定 / 会话快照 / 刷新次数）
//     ＋「自动沉淀」那组（回合 / 候选 / 已写 / 跳过 / 失败 / 判定丢弃）；
//   · 固定槽位 chips；
//   · **草稿区**：最近 5 条（新的在上）＋ 每条「提升 / 丢弃」（**写路径照旧走后端那两个 POST 路由** ⇒
//     审批闸口径不变 ✓），30 秒内的上次动作结果**明说一次**（成功/失败都说明，不靠"列表少一条"暗示 ✓）；
//   · 诊断（默认折叠）：agent / 网关 / 刷新次数 / 工具 / 快照份数与冻结语义 / 两道闸口径；
//   · 工作记忆原文（`<pre>`；网关未配置 / 刷新失败都**如实说**，不冒充空 ✓）。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-memory',
	chunk: 'client.memory.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');
		const h = react.createElement;
		const { useState, useEffect, useCallback } = react;

		const API = '/x/memory/api';
		const PROMOTE_ROUTE = '/x/memory/promote';
		const DISCARD_ROUTE = '/x/memory/discard';
		const DETAIL_HREF = '/x/memory/detail';


// ★★ 2026-10-24（第 9 轮）：**文档级点击探针** —— 用 console.warn（宿主只记 error/warn）。
//   作用：点一下页面任何地方，日志里就会出现一行 ⇒ 一次分清
//   "点击根本没到这个文档"（嵌入式宿主吞掉了）还是"到了但按钮处理器没挂上" ✗
if (typeof document !== 'undefined' && typeof console !== 'undefined' && console.warn) {
	document.addEventListener('click', ev => {
		const t = ev && ev.target;
		const el = t && t.closest ? t.closest('[data-vssaros-memory-action]') : null;
		console.warn('[vssaros-memory][v0.3.99] doc-click action=' + (el ? el.getAttribute('data-vssaros-memory-action') : '(none)')
			+ ' tag=' + (t && t.tagName ? t.tagName : '?'));
	}, true);
}
		/** 描述符（与清单 `vssaros.workbench` 同值 ⇒ 守卫逐项比对 ✓）。 */
		const DESCRIPTOR = {
			title: '记忆库',
			description: '查看与整理 Agent 的长期记忆（边对话边看记忆）。',
			repository: 'vssaros:memory',
			// ⚠ 必须自带 icon：规范说"缺省回落 activityBar.icon"，但**宿主快照不回落**（`e.icon || ''`）
			//   ⇒ 漏写就是"注册表里图标为空、商城落到 🧩" ✗（2026-10-22 审计发现本包就漏了）。
			icon: 'codicon:database',
			customFrame: false,
			layout: { businessSide: 'right', businessWidth: 0.36 },
		};

		async function loadPage() {
			const res = await fetch(API + '/page', { cache: 'no-store' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
			return body;
		}


		/* ─── **记忆详情：React 二级页**（2026-10-26；用户要求"二级页面 + React 实现"）────────
		   历史：这个入口先后试过 3 条路，全都不对 ——
		     · `location.href='/x/memory/detail'` ⇒ **主 frame 整页导航** ⇒ 被导航守卫拦（"点了没反应"），
		       或把整个客户端替换掉（丢页签栏/全屏）；
		     · `window.open('./detail')` ⇒ 内部浏览器打开**没有 token** 的地址 ⇒ **黑屏窗口**；
		     · `openModulePage('/x/memory/detail')` ⇒ 桌面全窗客户端**没有编辑区** ⇒ 宿主开出空编辑器 ⇒ **黑屏**
		       （`vssaros-agents/lib/client.agents.js:52-55` 2026-10-23 已踩过同一坑）；且它**不接受带查询串的 route**
		       （`validatePluginRoute` 逐段校验 ⇒ `?` 判非法 ⇒ invalid command）。
		   ⇒ 正解：**在同一个 React 工作台里用 state 切二级页**（不导航、不开窗、不需要桥）
		     ⇒ 页签栏/侧栏/会话上下文全保留，也没有任何 token 问题 ✓
		   数据：`GET /x/memory/api/detail?view=<id>` ⇒ 服务端复用 `loadDetailModel`（与 SSR 详情页同一份取数 ⇒ 口径不分叉）✓ */
		/* @generated:detailView begin —— 由 `webapp/build.mjs` 从 `webapp/src/detailView.js` 生成，**别手改** ✗
		   （改真源后跑 `node dsh-plugins/vssaros-memory/webapp/build.mjs`；守卫会比对这块与真源是否一致）*/
		/**
		 * 工作台吸顶工具条 —— **全插件唯一**的吸顶锚点（宿主据此 sticky）。
		 *
		 * ★ 2026-10-26：原来「记忆库」（MemoryPanel）与「记忆详情」（本文件）各写一个 header，
		 *   运行时互斥但**静态计数是 2** ⇒ `check-workbench-style` 的「恰好 1 个」判据一直红。
		 *   ⇒ 抽成这个 helper：锚点只在**这里**出现一次，两个页面都调它。
		 *   ⚠ 定义**只允许这一份**：chunk 侧那份已删，靠 `webapp/build.mjs` 生成同步；
		 *     否则真源与生成块会漂移（`check-memory-detail-react` 会红 ✓）。
		 */
		const wbToolbar = (opts) => {
		  const o = opts || {};
		  return h('header', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' },
		    o.back ? h('button', {
		      type: 'button', className: 'wb-btn is-ghost',
		      'data-vssaros-memory-action': 'back-to-library', onClick: o.back,
		    }, '← 返回记忆库') : null,
		    h('h1', null, String(o.title || '')),
		    h('span', { className: 'wb-sub' }, String(o.sub || '')),
		    h('span', { className: 'wb-spacer' }),
		    o.refresh ? h('button', { type: 'button', 'data-vssaros-memory-action': 'refresh', onClick: o.refresh }, '⟳ 刷新') : null,
		    // 页面自己的额外按钮（如「查看完整记忆 →」）；位置在刷新之后，与原布局一致
		    o.extra || null);
		};

		const DETAIL_TABS = [
			{ id: 'memories', label: '🧠 记忆' },
			{ id: 'sessions', label: '💬 会话' },
			{ id: 'slots', label: '📌 槽位' },
			{ id: 'lessons', label: '📖 教训' },
			{ id: 'consolidation', label: '🔄 固化' },
			{ id: 'audit', label: '📋 审计' },
			{ id: 'hooks', label: '🪝 钩子' },
			{ id: 'commits', label: '🔀 提交' },
			{ id: 'report', label: '📊 报告' },
			{ id: 'skills', label: '⚡ 技能' },
		];

		async function loadDetail(view) {
			const res = await fetch(API + '/detail?view=' + encodeURIComponent(view), { cache: 'no-store' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
			return body;
		}

		const kvRow = (label, value) => h('div', { className: 'md2-kv' },
			h('span', { className: 'md2-k' }, String(label)),
			h('span', { className: 'md2-v' }, typeof value === 'string' ? value : JSON.stringify(value)));

		const emptyHint = text => h('p', { className: 'wb-empty', 'data-memory-detail-empty': '' }, text);

		const badge = (text, cls) => h('span', { className: 'md2-badge ' + (cls || '') }, String(text));

		/** 每条数据的**首列摘要**（不同来源字段名不同 ⇒ 统一在这里挑一个能看的 ✓）。 */
		function rowText(row, keys) {
			for (let i = 0; i < keys.length; i++) {
				const v = row && row[keys[i]];
				if (typeof v === 'string' && v.trim()) { return v.trim(); }
			}
			try { return JSON.stringify(row).slice(0, 300); } catch (e) { return '(无法显示)'; }
		}


		/**
		 * **按页签渲染详情正文**（★ 2026-10-26 从 `MemoryDetailPage` 抽出来的**纯函数**）。
		 *
		 * 为什么要抽：SSR（`react-dom/server`）里 `useEffect` **不跑** ⇒ 组件永远停在 loading 态
		 * ⇒ 自动化测试只能测到页签壳、测不到每个页签的内容 ✗
		 * ⇒ 抽成纯函数后可以直接 `renderToStaticMarkup(renderDetailTab('slots', 假模型))` ✓
		 * ⚠ 纯函数：**不许读 state、不许发请求**（只吃 `(tab, model)` 两个入参 ✓）。
		 */
		function renderDetailTab(tab, m, filters) {
			const arr = v => (Array.isArray(v) ? v : []);
			if (tab === 'memories') {
				// ★★ 2026-10-26：复刻 IDE 侧（memoryDetailEditorPane 的记忆页）——
				//   · 层筛选 = 纯前端（IDE 侧切筛选也不发请求 ✓）；子类型 chips 来自 typeCounts
				//   · 统计行：总数 / 当前显示 / 是否截断 / 已查分区数（空要能分辨「没有」与「没查到」✓）
				//   · 每行：tier 徽标（data-tier ⇒ 颜色由 CSS 给）+ 类型 + 时间 + 来源分区（非当前分区才显示）
				//   ⚠ item.timestamp 是**已格式化的字符串**（toDetailItem 里 toLocaleString 过）
				//     ⇒ 这里不能再 new Date(Number(...))（会全变 1970 ✗，冒烟测试已覆盖此点）
				const all = arr(m.items);
				const layer = (filters && filters.layer) || 'all';
				const type = (filters && filters.type) || '';
				const cur = String(m.agentId || '');
				const shown = all.filter(it => (layer === 'all' || it.tier === layer)
					&& (!type || String(it.type || '').toLowerCase() === type));
				const parts = arr(m.partitions);
				const stats = h('div', { className: 'md2-stats', 'data-memory-detail-stats': '' },
					h('span', null, '共 ' + String(m.total != null ? m.total : all.length) + ' 条'),
					h('span', null, '显示 ' + shown.length + (m.truncated ? '（已截断到 ' + String(m.itemLimit || all.length) + ' 条）' : '')),
					h('span', null, '已查 ' + parts.length + ' 个分区' + (m.partitionsTruncated ? '（部分）' : '')));
				if (!shown.length) {
					return h('div', null, stats, emptyHint(all.length
						? '当前筛选下没有条目（共 ' + all.length + ' 条 ⇒ 换层/换类型试试）'
						: '这些分区里确实没有记忆条目（已查 ' + parts.length + ' 个分区：' + parts.slice(0, 6).join('、') + '）'));
				}
				return h('div', null, stats,
					h('ul', { className: 'md2-list', 'data-memory-detail-list': 'memories' }, shown.map((it, i) =>
						h('li', { key: 'm' + i, className: 'md2-row', 'data-memory-item-tier': String(it.tier || '') },
							h('span', { className: 'md2-row-top' },
								h('span', { className: 'md2-badge md2-tier', 'data-tier': String(it.tier || '?') }, String(it.tier || '?')),
								it.type ? badge(String(it.type), 'md2-badge-type') : null,
								it.partition && String(it.partition) !== cur
									? h('span', { className: 'md2-badge md2-part', 'data-partition': String(it.partition) }, '🗂 ' + String(it.partition))
									: null,
								it.timestamp ? h('span', { className: 'md2-time' }, String(it.timestamp)) : null),
							h('span', { className: 'md2-row-text' }, String(it.content || '').slice(0, 500))))));
			}
			if (tab === 'sessions') {
				const ss = arr(m.sessions), sm = arr(m.summaries);
				return h('div', { 'data-memory-detail-list': 'sessions' },
					m.sessionsError ? h('p', { className: 'mem-err' }, '会话读取失败：' + String(m.sessionsError)) : null,
					h('h4', { className: 'md2-h' }, '会话（' + ss.length + '）'),
					ss.length ? h('ul', { className: 'md2-list' }, ss.slice(0, 100).map((x, i) =>
						h('li', { key: 's' + i, className: 'md2-row' }, h('span', { className: 'md2-row-text mono' }, String(x.sessionId || x.id || rowText(x, ['sessionId', 'id'])))))
					) : emptyHint('没有会话记录'),
					h('h4', { className: 'md2-h' }, '摘要（' + sm.length + '）'),
					sm.length ? h('ul', { className: 'md2-list' }, sm.slice(0, 100).map((x, i) =>
						h('li', { key: 'sm' + i, className: 'md2-row' }, h('span', { className: 'md2-row-text' }, rowText(x, ['summary', 'text', 'content']).slice(0, 400))))
					) : emptyHint('没有会话摘要'));
			}
			if (tab === 'slots') {
				const slots = arr(m.slots);
				const names = arr(m.slotNames);
				const byName = {};
				slots.forEach(x => { byName[String(x.name || x.slot || '')] = x; });
				const list = names.length ? names.map(n => byName[n] || { name: n, content: '' }) : slots;
				if (!list.length) { return emptyHint('没有固定槽位'); }
				return h('div', { 'data-memory-detail-list': 'slots' }, list.map((x, i) => {
					const content = String(x.content || '');
					return h('div', { key: 'sl' + i, className: 'md2-slot' },
						h('div', { className: 'md2-slot-head' }, h('strong', null, String(x.name || '(未命名)')),
							badge(content.trim() ? (content.length + ' 字') : '(空)', content.trim() ? '' : 'md2-badge-empty')),
						content.trim() ? h('pre', { className: 'md2-pre' }, content.slice(0, 1200)) : null);
				}));
			}
			if (tab === 'lessons') {
				const ls = arr(m.lessons);
				if (!ls.length) { return emptyHint('还没有教训 —— 教训要**显式提炼**才会产生（不是自动攒的）'); }
				return h('ul', { className: 'md2-list', 'data-memory-detail-list': 'lessons' }, ls.slice(0, 200).map((x, i) =>
					h('li', { key: 'l' + i, className: 'md2-row' },
						h('span', { className: 'md2-row-text' }, String(x.content || '').slice(0, 400)),
						arr(x.tags).length ? h('span', { className: 'md2-row-top' }, arr(x.tags).map((t, j) => h('span', { key: 'tag' + j, className: 'md2-badge md2-badge-type' }, String(t)))) : null)));
			}
			if (tab === 'consolidation') {
				// ★ 2026-10-26：**自动沉淀计数**（含「回合摘要」）—— 用户要求显示在固化页签上。
				//   为什么不显示就等于没有：之前 106/106 `no-candidate` 完全不可见，用户以为"沉淀在跑"，
				//   实际一条都没产 ⇒ 计数必须上页面 ✓
				const ds = (m.distillStats && typeof m.distillStats === 'object') ? m.distillStats : {};
				const n = v => String(Number(v) || 0);
				return h('div', { 'data-memory-detail-list': 'consolidation' },
					h('div', { className: 'md2-cards', 'data-memory-distill-stats': '' },
						kvRow('回合', n(ds.turns)),
						kvRow('候选', n(ds.candidates)),
						kvRow('会话摘要', n(ds.summaries)),
						kvRow('回合摘要', n(ds.turnSummaries)),
						kvRow('已写草稿', n(ds.written)),
						kvRow('跳过', n(ds.skipped)),
						kvRow('失败', n(ds.failed))),
					h('p', { className: 'md2-hint', 'data-memory-distill-hint': '' },
						'「回合摘要」= 按回合自动沉淀的条数（普通对话也会产草稿；仍需在记忆库里「提升」才进长期记忆）'),
					h('div', { className: 'md2-cards' },
						kvRow('Episodic', arr(m.episodicItems).length),
						kvRow('Semantic', arr(m.semanticItems).length),
						kvRow('Procedural', arr(m.proceduralItems).length)),
					h('h4', { className: 'md2-h' }, '固化上下文'),
					String(m.consolidationContext || '').trim()
						? h('pre', { className: 'md2-pre' }, String(m.consolidationContext).slice(0, 4000))
						: emptyHint('没有固化上下文（引擎未返回）'));
			}
			if (tab === 'audit') {
				const summary = m.auditSummary || {};
				const log = arr(m.auditLog);
				return h('div', { 'data-memory-detail-list': 'audit' },
					h('div', { className: 'md2-cards' }, Object.keys(summary).map((k, i) => h('span', { key: 'as' + i }, kvRow(k, summary[k])))),
					h('h4', { className: 'md2-h' }, '审计日志（落盘账本 + 内存态，' + log.length + ' 条）'),
					log.length ? h('ul', { className: 'md2-list' }, log.slice(0, 200).map((x, i) =>
						h('li', { key: 'au' + i, className: 'md2-row' },
							h('span', { className: 'md2-row-top' }, badge(String(x.operation || x.action || '?')),
								x.type || x.tool ? badge(String(x.type || x.tool), 'md2-badge-type') : null,
								x.timestamp ? h('span', { className: 'md2-time' }, new Date(Number(x.timestamp) || 0).toLocaleString()) : null),
							h('span', { className: 'md2-row-text' }, String(x.content || x.target || '').slice(0, 300)))))
						: emptyHint('账本里没有审计条目'));
			}
			if (tab === 'hooks') {
				const stats = m.hookStats || {};
				const keys = Object.keys(stats);
				if (!keys.length) { return emptyHint('没有钩子统计'); }
				return h('div', { className: 'md2-cards', 'data-memory-detail-list': 'hooks' }, keys.map((k, i) => h('span', { key: 'h' + i }, kvRow(k, stats[k]))));
			}
			if (tab === 'commits') {
				const stats = m.commitStats || {};
				const cs = arr(m.commits);
				return h('div', { 'data-memory-detail-list': 'commits' },
					h('div', { className: 'md2-cards' }, Object.keys(stats).map((k, i) => h('span', { key: 'cs' + i }, kvRow(k, stats[k])))),
					cs.length ? h('ul', { className: 'md2-list' }, cs.map((x, i) =>
						h('li', { key: 'c' + i, className: 'md2-row' },
							h('span', { className: 'md2-row-top mono' }, String(x.sha || '').slice(0, 10),
								x.timestamp ? h('span', { className: 'md2-time' }, new Date(Number(x.timestamp) || 0).toLocaleString()) : null),
							h('span', { className: 'md2-row-text' }, String(x.message || '').slice(0, 300)))))
						: emptyHint('记忆库没记过提交（这一页统计的是**记忆库自己记录的提交**，不是代码库 git 历史）'));
			}
			if (tab === 'report') {
				const r = m.report;
				if (!r) { return emptyHint('报告为空（引擎未返回）'); }
				if (typeof r === 'string') { return h('pre', { className: 'md2-pre' }, r.slice(0, 6000)); }
				const keys = Object.keys(r);
				return h('div', { className: 'md2-cards', 'data-memory-detail-list': 'report' }, keys.map((k, i) => h('span', { key: 'r' + i }, kvRow(k, r[k]))));
			}
			// skills
			const stats = m.skillStats || {};
			const skills = arr(m.skills);
			return h('div', { 'data-memory-detail-list': 'skills' },
				h('div', { className: 'md2-cards' }, Object.keys(stats).map((k, i) => h('span', { key: 'ks' + i }, kvRow(k, stats[k])))),
				skills.length ? h('ul', { className: 'md2-list' }, skills.map((x, i) =>
					h('li', { key: 'k' + i, className: 'md2-row' },
						h('span', { className: 'md2-row-top' }, badge(String(x.confidence != null ? x.confidence : '?')),
							x.skillMdWritten ? badge('SKILL.md ✓') : badge('未写文件', 'md2-badge-empty')),
						h('span', { className: 'md2-row-text' }, String(x.title || x.trigger || x.id || '').slice(0, 300)))))
					: emptyHint('没有技能（技能需显式提取；旧口径数据在 mem:skills 里，读侧已兼容）'));
		}

		function MemoryDetailPage(props) {
			const [tab, setTab] = useState('memories');
			// ★ 层筛选是纯前端（与 IDE 侧同口径：切筛选不发请求 ✓）
			const [layer, setLayer] = useState('all');
			const [type, setType] = useState('');
			const [st, setSt] = useState({ status: 'loading', data: null, error: '' });
			const reload = useCallback(async () => {
				setSt(prev => ({ status: 'loading', data: prev.data, error: '' }));
				try {
					const body = await loadDetail(tab);
					setSt({ status: 'ready', data: body, error: '' });
				} catch (e) {
					setSt({ status: 'error', data: null, error: String((e && e.message) || e) });
				}
			}, [tab]);
			useEffect(() => { void reload(); }, [reload]);

			const m = st.data || {};

			return h('div', { className: 'wb wb-mem md2', 'data-vssaros-page': 'memory-detail' },
				// 吸顶工具条走**唯一** helper（锚点字面量全插件只出现一次 ⇒ 守卫可数 ✓）
				wbToolbar({
					back: () => props.onBack(),
					title: '记忆详情',
					sub: 'v' + String(m.version || '') + (m.agentId ? ' · ' + String(m.agentId) : ''),
					refresh: () => { void reload(); },
				}),
				h('nav', { className: 'md2-tabs', 'data-memory-detail-tabs': '' }, DETAIL_TABS.map(t =>
					h('button', {
						key: t.id, type: 'button',
						className: 'md2-tab' + (t.id === tab ? ' is-active' : ''),
						'data-memory-detail-tab': t.id,
						'aria-selected': t.id === tab ? 'true' : 'false',
						onClick: () => setTab(t.id),
					}, t.label))),
				// 层筛选行（复刻 IDE 侧第二行标签：全部 / Working / Episodic / Semantic / Procedural）
				// ⚠ 只在记忆页签显示：其它页签不是「层」结构，显示这行会误导 ✗
				tab === 'memories' ? h('nav', { className: 'md2-filters', 'data-memory-detail-filters': '' },
					[['all', '全部'], ['working', 'Working'], ['episodic', 'Episodic'], ['semantic', 'Semantic'], ['procedural', 'Procedural']].map(f =>
						h('button', {
							key: f[0], type: 'button',
							className: 'md2-chip' + (layer === f[0] ? ' is-active' : ''),
							'data-memory-layer': f[0],
							onClick: () => setLayer(f[0]),
						}, f[1])),
					type ? h('button', { type: 'button', className: 'md2-chip', onClick: () => setType('') }, '✕ ' + type) : null,
					Object.keys(m.typeCounts || {}).slice(0, 8).map(k =>
						h('button', {
							key: 't-' + k, type: 'button',
							className: 'md2-chip md2-chip-type' + (type === k ? ' is-active' : ''),
							'data-memory-type': k,
							onClick: () => setType(type === k ? '' : k),
						}, k + ' (' + String((m.typeCounts || {})[k]) + ')'))) : null,
				st.status === 'error'
					? h('p', { className: 'wb-empty mem-err', role: 'alert', 'data-memory-detail-state': 'error' }, '详情读取失败：' + st.error)
					: (st.status === 'loading' && !st.data
						? h('p', { className: 'wb-empty', 'data-memory-detail-state': 'loading' }, '正在读取详情…')
						: h('section', { className: 'md2-body', 'data-memory-detail-state': 'ready' }, renderDetailTab(tab, m, { layer, type }))));
		}
		/* @generated:detailView end */


		function MemoryPanel() {
			const [view, setView] = useState({ status: 'loading', data: null, error: '' });
			const [note, setNote] = useState('');
			const [noteError, setNoteError] = useState(false);
			const [busy, setBusy] = useState('');
			const [diagOpen, setDiagOpen] = useState(false);
			// ★ 2026-10-26：**页内二级页**（不导航/不开窗）—— 见 MemoryDetailPage 顶部注释里的三条失败路 ✗
			const [page, setPage] = useState('library');

			const say = (text, isError) => { setNote(String(text || '')); setNoteError(!!isError); };
			const reload = useCallback(async () => {
				try {
					const body = await loadPage();
					setView({ status: 'ready', data: body, error: '' });
				} catch (e) {
					setView(v => Object.assign({}, v, { status: 'error', error: String(e && e.message || e) }));
				}
			}, []);
			useEffect(() => { void reload(); }, [reload]);

			/** 草稿动作：照旧打后端那两个 POST 路由（审批闸口径不变）⇒ 完成后重取页面数据 ✓。 */
			const draftAction = useCallback(async (id, action) => {
				const label = action === 'promote' ? '提升' : '丢弃';
				setBusy(id + ':' + action);
				say('正在' + label + '…', false);
				try {
					const res = await fetch(action === 'promote' ? PROMOTE_ROUTE : DISCARD_ROUTE, {
						method: 'POST',
						headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
						body: 'id=' + encodeURIComponent(id),
					});
					// 后端回 303 到页面（表单口径）⇒ 这里只关心成不成，然后自己重取 JSON ✓
					if (!res.ok && res.status !== 0) { throw new Error('HTTP ' + res.status); }
					await reload();
					const fresh = (await loadPage().catch(() => null));
					const last = fresh && fresh.lastAction;
					if (last && last.action === action) {
						say((action === 'promote' ? '提升' : '丢弃') + (last.ok ? '成功' : '失败') + '：' + String(last.text || '') + (last.ok ? '' : ' —— ' + String(last.error || '(无详情)')), !last.ok);
					} else {
						say(label + '已提交（结果见下方草稿区）', false);
					}
				} catch (e) {
					say(label + '失败：' + String(e && e.message || e), true);
				} finally {
					setBusy('');
				}
			}, [reload]);

			const d = (view.data && view.data.state) || null;
			const working = (view.data && view.data.working) || { ok: false, text: '', error: '', truncated: false };
			const distill = (view.data && view.data.distill) || {};
			const drafts = (view.data && view.data.drafts) || { rows: [], error: '', readAt: 0 };
			const lastAction = view.data && view.data.lastAction;
			const slots = (view.data && view.data.slots) || [];
			const rows = Array.isArray(drafts.rows) ? drafts.rows : [];
			const recent = rows.slice(-5).reverse();
			// ⚠ 机器锚点用 `data-*` 而不是类名：类名属于**视觉层**（UI 统一时会被换成 `wb-*`），
		//   拿类名当锚点 ⇒ 一改样式探针就瞎 ✗（2026-10-22 迁移当场踩到：`.kb-stat-cell` / `.mem-slot` 被换掉后
		//   探针数出 stats=0 / slots=0）。
		const statCell = (label, value) => h('div', { className: 'wb-card', 'data-vssaros-memory-stat': '' },
				h('div', { className: 'wb-card-num' }, String(value)),
				h('div', { className: 'wb-card-label' }, label));

			// 二级页：同一个工作台内切换（页签栏/侧栏/会话上下文全保留 ✓）
			if (page === 'detail') { return h(MemoryDetailPage, { onBack: () => setPage('library') }); }

			if (view.status === 'loading' && !view.data) {
				return h('div', { className: 'wb wb-mem', 'data-vssaros-page': 'memory' }, h('p', { className: 'wb-empty', 'data-memory-state': 'loading' }, '正在读取记忆…'));
			}
			if (view.status === 'error' && !view.data) {
				return h('div', { className: 'wb wb-mem', 'data-vssaros-page': 'memory' }, h('p', { className: 'wb-empty', 'data-memory-state': 'error', role: 'alert' }, '读取失败：' + view.error));
			}

			return h('div', {
				className: 'wb wb-mem',
				'data-vssaros-page': 'memory',
				'data-vssaros-surface': 'workbench',
				'data-vssaros-memory-state': d ? d.name : '',
				'data-vssaros-memory-agent': d ? d.agent : '',
				'data-vssaros-memory-chars': d ? String(d.chars) : '0',
				'data-vssaros-memory-bytes': d ? String(d.bytes) : '0',
				'data-vssaros-memory-refreshes': d ? String(d.refreshes) : '0',
				'data-vssaros-memory-writes': d ? String(d.writes) : '0',
				'data-vssaros-memory-tools': d ? d.tools : '',
				'data-vssaros-memory-gateway': d ? d.gateway : '',
			},
				wbToolbar({
					title: '记忆库',
					sub: '只读快照 · v' + (view.data ? view.data.version : ''),
					refresh: () => { void reload(); },
					// ★★ 2026-10-26：入口改成**页内切换**（不再导航/不开窗/不调桥）——
					//   三条失败路见 `MemoryDetailPage` 顶部注释（整页导航被拦 / window.open 丢 token 黑屏 /
					//   桌面全窗 openModulePage 开空编辑器黑屏）⇒ 同一个 React 工作台里切二级页最稳 ✓
					extra: h('button', {
						type: 'button',
						className: 'wb-btn is-ghost mem-link',
						'data-vssaros-memory-action': 'open-detail',
						title: '在同一页面内打开记忆详情（React 二级页；不跳转、不新开窗口）',
						onClick: () => setPage('detail'),
					}, '查看完整记忆 →'),
				}),
				// 主入口 + 统计（与旧页同一组数字口径 ✓）
				h('div', { className: 'wb-card mem-card' },
					h('div', { className: 'mem-hero' },
						h('span', { className: 'mem-hero-num wb-card-num' }, String(working.text.length)),
						h('span', { className: 'wb-card-label' }, '字已注入 · agent ', h('code', null, d ? d.agent : ''))),
					h('div', { className: 'wb-cards' },
						statCell('注入字符', working.text.length),
						statCell('草稿待定', rows.length),
						statCell('会话快照', d ? d.snapshots : 0),
						statCell('刷新次数', d ? d.refreshes : 0)),
					h('div', { className: 'wb-card-sub' }, '自动沉淀（本回合累计）'),
					h('div', { className: 'wb-cards' },
						statCell('回合', distill.turns ?? 0),
						statCell('候选', distill.candidates ?? 0),
						statCell('已写', distill.written ?? 0),
						statCell('跳过', distill.skipped ?? 0),
						statCell('失败', distill.failed ?? 0),
						statCell('判定丢弃', distill.judgeDropped ?? 0))),
				// 固定槽位
				h('section', { className: 'wb-card mem-section' },
					h('div', { className: 'wb-group-hd' }, h('span', null, '固定槽位'), h('span', { className: 'wb-spacer' }), h('span', { className: 'wb-card-sub mem-count' }, String(slots.length))),
					h('div', { className: 'wb-chips', 'data-vssaros-memory-slots': String(slots.length) }, slots.map(name => h('span', { key: name, className: 'wb-badge', 'data-vssaros-memory-slot': String(name) }, String(name).replace(/_/g, ' '))))),
				// 草稿区
				h('section', { className: 'wb-card mem-section', 'data-vssaros-memory-drafts': String(rows.length), 'data-vssaros-memory-drafts-read': String(drafts.readAt || 0) },
					h('div', { className: 'wb-group-hd' }, h('span', null, '草稿区'), h('span', { className: 'wb-spacer' }), h('span', { className: 'wb-card-sub mem-count' }, String(rows.length))),
					h('p', { className: 'wb-diag' },
						'自动沉淀（', h('code', null, 'agent/turn-stopping'), '）从会话里的**用户消息**提取的候选，', h('b', null, '不会自动进长期记忆'),
						' ✓。「提升」= ', h('b', null, '人的显式确认'), '（这条路上不会再弹审批窗 ✓）；不处理的草稿 30 天后自动淘汰 ✓。',
						drafts.error ? h('span', { className: 'mem-err' }, ' · 读回失败：' + drafts.error) : null),
					recent.length
						? h('ul', { className: 'mem-drafts', 'data-vssaros-memory-draft-list': '' }, recent.map(row => h('li', { key: row.id },
							h('code', null, row.text), ' ',
							h('small', null, '[' + row.matched + (row.turn !== null ? ' · turn ' + row.turn : '') + ']'),
							row.status === 'draft'
								? h('span', { className: 'wb-acts' },
									h('button', { type: 'button', 'data-vssaros-memory-promote': row.id, disabled: !!busy, onClick: () => { void draftAction(row.id, 'promote'); } }, '提升'),
									h('button', { type: 'button', 'data-vssaros-memory-discard': row.id, disabled: !!busy, onClick: () => { void draftAction(row.id, 'discard'); } }, '丢弃'))
								: h('small', null, '（' + row.status + '）'))))
						: h('p', { className: 'wb-diag' }, '草稿区是空的（还没有自动沉淀的候选，或都被处理完了）。')),
				// 上次动作的即时反馈（30 秒内 ✓，与旧页同一条纪律）
				lastAction
					? h('p', { className: 'wb-diag', 'data-vssaros-memory-last-action': lastAction.action + '|' + (lastAction.ok ? 'ok' : 'failed') },
						lastAction.action === 'promote' ? '提升' : '丢弃',
						h('b', null, lastAction.ok ? '成功' : '失败'), '：', h('code', null, lastAction.text),
						lastAction.ok ? '' : ' —— ' + String(lastAction.error || '(无详情)'))
					: null,
				note ? h('p', { className: 'wb-diag', 'data-memory-note': '', role: noteError ? 'alert' : 'status', style: noteError ? { color: 'var(--dsw-alias-state-error-primary, #f48771)' } : null }, note) : null,
				// 诊断（默认折叠；锚点照旧在 DOM 里 ✓）
				h('details', { className: 'wb-card mem-section', open: diagOpen, onToggle: (ev) => setDiagOpen(!!(ev.target && ev.target.open)) },
					h('summary', { className: 'wb-group-hd' }, h('span', null, '诊断'), h('span', { className: 'wb-spacer' }), h('span', { className: 'wb-card-sub mem-count' }, '展开')),
					h('p', {
						className: 'wb-diag', 'data-vssaros-memory-section': d && d.promptSection !== null ? 'registered' : 'absent',
						'data-vssaros-memory-section-order': d && d.promptSection !== null ? String(d.promptSection) : '',
						'data-vssaros-memory-snapshots': d ? String(d.snapshots) : '0',
						'data-vssaros-memory-distill': [distill.turns ?? 0, distill.candidates ?? 0, distill.written ?? 0, distill.skipped ?? 0, distill.failed ?? 0, distill.judged ?? 0, distill.judgeDropped ?? 0, distill.judgeSkipped ?? 0].join('|'),
					},
						'agent ', h('code', null, d ? d.agent : ''), ' · 网关 ', h('code', null, d && d.gateway ? d.gateway : '(未配置)'), ' · 刷新 ' + (d ? d.refreshes : 0) + ' 次 · 工具 ', h('code', null, d ? d.tools : ''),
						' · 会话快照 ', h('code', null, d ? String(d.snapshots) : '0'), ' 份（每个装配主体首次装配时取一次后**冻结** ⇒ 提示词前缀不因时间而变 ✓）',
						d && d.promptSection === null ? ' · 提示词 section 未注册（组合里没有 systemPrompt 服务）' : ''),
					h('p', {
						className: 'wb-diag', 'data-vssaros-memory-truncated': working.truncated ? 'yes' : 'no',
						'data-vssaros-memory-token-budget': d ? String(d.tokenBudget) : '', 'data-vssaros-memory-char-cap': d ? String(d.charCap) : '',
					},
						'这段文本就是注入 system prompt 的那一份（section ', h('code', null, d ? d.sectionName : ''), '）。**两道闸**：网关按 ', h('code', null, 'tokenBudget=' + (d ? d.tokenBudget : '')), ' token 产出（**通常是它生效**）✓；本插件另加一道 ',
						h('code', null, String(d ? d.charCap : '')), ' 字符硬上限（约十倍大 ⇒ 通常不生效）✓ —— 所以"已注入 N 字"短**不等于**记忆本来就少 ✗。本次',
						working.truncated ? '**触发了字符闸**（网关给了 ' + String(working.rawChars ?? '?') + ' 字，已截到 ' + String(d ? d.charCap : '') + ' 字）' : '未触发字符闸', ' ✓。')),
				// 工作记忆原文
				h('section', { className: 'wb-card mem-section', id: 'vssaros-working-memory' },
					h('div', { className: 'wb-group-hd' }, h('span', null, '工作记忆'), h('span', { className: 'wb-spacer' }), h('span', { className: 'wb-card-sub mem-count' }, working.ok ? working.text.length + ' 字' : '未注入')),
					!d || !d.gateway
						? h('p', { className: 'wb-diag' }, '记忆网关未配置：设 ', h('code', null, 'VSSAROS_MEMORY_GATEWAY_URL'), '，或由 VsSaros 经 ', h('code', null, '--patch'), ' 注入 ', h('code', null, 'config.gatewayUrl'), '。')
						: (working.ok
							? h('pre', { className: 'wb-pre' }, working.text || '(工作记忆为空)')
							: h('p', { className: 'wb-diag' }, '刷新失败：', h('code', null, working.error || '(无详情)')))));
		}

		const STYLE_ID = 'vssaros-memory-workbench-layout';
		// ★ 2026-10-22（工作台 UI 统一，方案稿 §6.19）：**通用视觉交给共享层**（宿主注入的 `wb-*`），
		//   这里只留记忆库特有的排版（大数字 hero、草稿列表、错误色）。
		// ⚠ 原来写的 `--dsw-alias-border-default` / `--dsw-alias-label-link` / `--dsw-alias-font-family-monospace`
		//   **都不存在** ⇒ 一律回落硬编码兜底 ⇒ 从没跟随过主题 ✗（迁移时统一换成真实令牌 / 共享层的 `--wb-*`）。
		const CSS = `
.wb-mem { overflow:auto; }
.wb-mem a.wb-btn { text-decoration:none; }
.mem-hero { display:flex; align-items:baseline; gap:var(--wb-s2); }
.mem-hero-num { font-size:26px; line-height:1; }
.mem-card { gap:var(--wb-s2); }
.mem-section { gap:var(--wb-s1); }
.mem-count { font-weight:400; }
.mem-drafts { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:var(--wb-s1); }
.mem-drafts li { font-size:var(--wb-f-sm); line-height:1.5; word-break:break-word; }
.wb-mem .wb-acts button, .wb-mem .wb-toolbar button {
	padding:2px 10px; border-radius:var(--wb-r-pill); font-size:var(--wb-f-xs); font-family:inherit; cursor:pointer;
	border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: transparent; color: inherit;
}
.wb-mem .wb-acts button:hover, .wb-mem .wb-toolbar button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.mem-err { color: var(--dsw-alias-state-error-primary, #f48771); }
/* ── 记忆详情（React 二级页，2026-10-26）────────────────────────────── */
.md2 .md2-tabs { display:flex; flex-wrap:wrap; gap:4px; padding:0 16px; margin:6px 0 2px; }
.md2 .md2-tab { padding:3px 10px; border-radius:var(--wb-r-pill, 999px); font-size:var(--wb-f-xs, 12px);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background:transparent; color:inherit; cursor:pointer; }
.md2 .md2-tab.is-active { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); font-weight:600; }
.md2 .md2-body { padding:8px 16px 20px; overflow:auto; }
.md2 .md2-h { margin:12px 0 6px; font-size:var(--wb-f-xs, 12px); opacity:.75; font-weight:600; }
.md2 .md2-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.md2 .md2-row { display:flex; flex-direction:column; gap:3px; padding:6px 8px; border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); }
.md2 .md2-row-top { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
.md2 .md2-row-text { font-size:var(--wb-f-xs, 12px); line-height:1.5; white-space:pre-wrap; word-break:break-word; }
.md2 .md2-row-text.mono { font-family:var(--wb-font-mono, monospace); }
.md2 .md2-badge { padding:1px 6px; border-radius:999px; font-size:11px;
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); opacity:.9; }
.md2 .md2-badge-empty { opacity:.55; }
.md2 .md2-time { font-size:11px; opacity:.6; }
.md2 .md2-stats { display:flex; flex-wrap:wrap; gap:10px; padding:2px 0 8px; font-size:11px; opacity:.75; }
.md2 .md2-filters { display:flex; flex-wrap:wrap; gap:4px; padding:0 16px 6px; }
.md2 .md2-chip { padding:2px 8px; border-radius:999px; font-size:11px; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background:transparent; color:inherit; }
.md2 .md2-chip.is-active { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); font-weight:600; }
.md2 .md2-chip-type { opacity:.8; }
/* 四个记忆层级的分类色（2026-10-26：原来是裸 hex ⇒ 不随主题、且过不了 S7 守卫）。
   改成 var(令牌, 兜底) 形式：主题里有对应令牌就跟随主题，没有就用兜底色（语义不变）。
   ⚠ 这段是**模板字符串**里的 CSS，注释只能用 CSS 的 /* *​/ ——
     千万别在里面写反引号，那会提前闭合模板字符串（这一行就踩过）。 */
.md2 .md2-tier[data-tier="working"] { border-color:var(--dsw-alias-brand-primary, #5aa9e6); color:var(--dsw-alias-brand-primary, #5aa9e6); }
.md2 .md2-tier[data-tier="episodic"] { border-color:var(--dsw-alias-state-warning-primary, #f0a04b); color:var(--dsw-alias-state-warning-primary, #f0a04b); }
.md2 .md2-tier[data-tier="semantic"] { border-color:var(--dsw-alias-state-success-primary, #8bc34a); color:var(--dsw-alias-state-success-primary, #8bc34a); }
.md2 .md2-tier[data-tier="procedural"] { border-color:var(--dsw-alias-state-info-primary, #b07cf0); color:var(--dsw-alias-state-info-primary, #b07cf0); }
.md2 .md2-part { opacity:.75; }
.md2 .md2-cards { display:flex; flex-wrap:wrap; gap:8px; }
.md2 .md2-kv { display:flex; gap:8px; align-items:baseline; font-size:var(--wb-f-xs, 12px);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); border-radius:6px; padding:3px 8px; }
.md2 .md2-k { opacity:.7; }
.md2 .md2-v { font-weight:600; }
.md2 .md2-slot { border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); border-radius:8px; padding:8px 10px; margin-bottom:8px; }
.md2 .md2-slot-head { display:flex; gap:8px; align-items:center; margin-bottom:4px; }
.md2 .md2-pre { margin:4px 0 0; padding:8px; border-radius:6px; white-space:pre-wrap; word-break:break-word;
  background:var(--dsw-alias-bg-l2, rgba(127,127,127,.08)); font-size:11px; max-height:320px; overflow:auto; }
/* 2026-10-24：按**容器**响应（sideview / 右栏只有 320–420px，@media 判不出来） */
.wb-mem { container-type: inline-size; }
@container (max-width: 860px) {
  .mem-hero { flex-wrap: wrap; }
  .mem-hero-num { font-size: 22px; }
  .wb-mem .wb-row { grid-template-columns: minmax(0, 1fr); }
}
@container (max-width: 560px) {
  .wb-mem .wb-toolbar { flex-wrap: wrap; row-gap: var(--wb-s1); }
  .mem-drafts li { font-size: var(--wb-f-xs); }
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
			}, 'vssaros-memory: workbench styles');
			// ⚠ **可选注入**（同其它工作台）：宿主服务缺席 ⇒ 只是这个工作台不出现，SSR 页照旧可用 ✓
			ctx.inject(['desktopWorkbenches'], (c) => {
				c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, MemoryPanel), 'vssaros-memory: workbench');
			});
			return undefined;
		}

		// ★ 2026-10-26：**测试钩子**（`test/reactDetailSmoke.mjs` 用；线上不依赖它们 ✓）
		//   `__renderDetailTab` 是纯函数 ⇒ SSR 直渲 10 个页签；`__MemoryDetailPage` 测页签壳/返回按钮。
		exports.__renderDetailTab = renderDetailTab;
		exports.__MemoryDetailPage = MemoryDetailPage;

		exports.install = install;
		exports.apply = install;
		exports.inject = [];
		return module.exports;
	},
});
