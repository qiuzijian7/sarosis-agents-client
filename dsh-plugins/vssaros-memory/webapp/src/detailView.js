/*---------------------------------------------------------------------------------------------
 *  detailView.js — 「记忆详情」的**唯一实现**（React；2026-10-26）
 *
 * ## 为什么单独抽出来
 * 之前同一份详情页有两套实现：
 *   · dsh 侧 `lib/client.memory.js`（React，跑在 dsh 客户端里，用**宿主那份** react）
 *   · IDE 侧 `agentStudio/browser/memoryDetailEditorPane.ts`（2.3k 行**原生 DOM**，自己算一遍数据）
 * ⇒ 两个界面的字段口径、空态文案、筛选规则迟早分叉 ✗✗
 *   （用户要求：IDE 侧改用 React 版记忆 + **统一数据源**）
 *
 * ## 怎么共用（**构建期**单一真源，不是运行时）
 * ⚠ dsh chunk 里**不能**同步 `require('./detailView.js')` —— 插件 client chunk 只允许 `require('react')`
 *   （宿主那份）和 `require.async(...)`（异步）⇒ 运行时共用做不到 ✗
 * ⇒ 所以 `webapp/build.mjs`：
 *   ① 把本文件打进 `lib/detail.bundle.js`（自带 React ⇒ IDE webview / 独立页用）
 *   ② 把本文件**原样生成**到 `lib/client.memory.js` 的 `@generated:detailView` 标记之间
 *      ⇒ 两处永远同源；守卫比对标记块内容 ✓
 *
 * ## 数据源（统一）
 * 只走 `GET /x/memory/api/detail?view=<id>`（服务端 `loadDetailModel`：**跨分区**、与 SSR 详情页同一份取数）
 * ⇒ dsh 客户端 / IDE webview / SSR 页三处口径一致 ✓
 *--------------------------------------------------------------------------------------------*/

/**
 * 造一组详情视图组件（**依赖注入 react**：dsh chunk 传宿主那份，standalone bundle 传自己打包那份）。
 *
 * @param {{ createElement: Function, useState: Function, useEffect: Function, useCallback: Function }} react
 * @returns {{ DETAIL_TABS: Array<{id: string, label: string}>, renderDetailTab: Function, MemoryDetailPage: Function }}
 */
export function createDetailView(react) {
  const h = react.createElement;
  const { useState, useEffect, useCallback } = react;

  /** 详情 JSON 基址（与页面同一 Host ⇒ 同源，cookie/token 一致 ✓）。 */
  const API = '/x/memory/api';

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

/** 一行 label/value（详情页到处要用，统一在这儿 ✓）。 */
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
		return h('div', { 'data-memory-detail-list': 'consolidation' },
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
		h('header', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' },
			h('button', { type: 'button', className: 'wb-btn is-ghost', 'data-vssaros-memory-action': 'back-to-library', onClick: () => props.onBack() }, '← 返回记忆库'),
			h('h1', null, '记忆详情'),
			h('span', { className: 'wb-sub' }, 'v' + String(m.version || '') + (m.agentId ? ' · ' + String(m.agentId) : '')),
			h('span', { className: 'wb-spacer' }),
			h('button', { type: 'button', onClick: () => { void reload(); } }, '⟳ 刷新')),
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

  return { DETAIL_TABS, renderDetailTab, MemoryDetailPage };
}
