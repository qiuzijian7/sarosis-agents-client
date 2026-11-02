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
      h('h1', { className: 'wb-title' }, String(o.title || '')),
      h('span', { className: 'wb-sub' }, String(o.sub || '')),
      h('span', { className: 'wb-spacer' }),
      o.refresh ? h('button', { type: 'button', 'data-vssaros-memory-action': 'refresh', onClick: o.refresh }, '⟳ 刷新') : null,
      // 页面自己的额外按钮（如「查看完整记忆 →」）；位置在刷新之后，与原布局一致
      o.extra || null);
  };

// ★ 2026-11-02（工作台 v2 · P4 页签重排）：
//   · 新增「归档」（被取代的旧版本，90 天内可恢复）；
//   · 钩子 / 提交 / 报告 / 技能 4 页在 dsh 侧长期为空 ⇒ 折叠进「更多」，默认不占页签栏
//     （数据与渲染都保留，点「更多」仍可达——不是删功能，只是不让空页签抢首屏）。
//   · `DETAIL_TABS` 仍是**全集**（守卫、IDE 侧、测试按全集数）；分组只由 `primary` 标记表达。
const DETAIL_TABS = [
	{ id: 'memories', label: '🧠 记忆', primary: true },
	{ id: 'sessions', label: '💬 会话', primary: true },
	{ id: 'slots', label: '📌 槽位', primary: true },
	{ id: 'lessons', label: '📖 教训', primary: true },
	{ id: 'archive', label: '🗄 归档', primary: true },
	{ id: 'consolidation', label: '🔄 固化', primary: true },
	{ id: 'audit', label: '📋 审计', primary: true },
	{ id: 'hooks', label: '🪝 钩子', primary: false },
	{ id: 'commits', label: '🔀 提交', primary: false },
	{ id: 'report', label: '📊 报告', primary: false },
	{ id: 'skills', label: '⚡ 技能', primary: false },
];

/** 审计来源过滤：`policy` 字段是 `ask` / `auto` / `human` / `auto-distill`（见 `core/audit.js`）。 */
const AUDIT_FILTERS = [
	{ id: 'all', label: '全部' },
	{ id: 'human', label: '人工' },
	{ id: 'model', label: '模型写入' },
	{ id: 'auto-distill', label: '自动提升' },
];

/** 审计行属于哪一类来源（纯函数，给过滤和徽标共用）。 */
function auditSourceOf(row) {
	const p = String((row && row.policy) || '');
	if (p === 'auto-distill') { return 'auto-distill'; }
	if (p === 'human') { return 'human'; }
	// `off` = 被写策略拒绝的**模型**写入（`resolveWritePolicy` 的第三种取值），同样是模型来源
	if (p === 'ask' || p === 'auto' || p === 'off') { return 'model'; }
	return 'other';
}

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

/**
 * 页签计数（★ 2026-11-02）：**只报已知的**。
 * 详情接口是**按页签取数**的（`loadDetailModel` 里每个 view 只取自己那份）⇒ 没取过的页签，
 * 它的字段根本不在 model 里 ⇒ 这里返回 `null`，页面**不显示数字**（绝不把"未知"画成 0 ——
 * 那是本插件一直守的"取不到 ≠ 0"口径 ✗）。
 */
function tabCountOf(tab, m) {
	if (!m || typeof m !== 'object') { return null; }
	const arr = v => (Array.isArray(v) ? v : []);
	const num = v => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
	switch (tab) {
		case 'memories': { const n = num(m.total); return n != null ? n : (Array.isArray(m.items) ? m.items.length : null); }
		case 'sessions': return Array.isArray(m.sessions) ? arr(m.sessions).length : null;
		case 'slots': return Array.isArray(m.slots) ? arr(m.slots).filter(x => String((x && x.content) || '').trim()).length : null;
		case 'lessons': return Array.isArray(m.lessons) ? arr(m.lessons).length : null;
		case 'archive': return m.archive && typeof m.archive === 'object'
			? (num(m.archive.total) != null ? num(m.archive.total) : arr(m.archive.items).length) : null;
		case 'consolidation': {
			const has = Array.isArray(m.episodicItems) || Array.isArray(m.semanticItems) || Array.isArray(m.proceduralItems);
			return has ? arr(m.episodicItems).length + arr(m.semanticItems).length + arr(m.proceduralItems).length : null;
		}
		case 'audit': return Array.isArray(m.auditLog) ? arr(m.auditLog).length : null;
		case 'hooks': return m.hookStats && typeof m.hookStats === 'object' ? num(m.hookStats.totalHooks) : null;
		case 'commits': return m.commitStats && typeof m.commitStats === 'object'
			? (num(m.commitStats.totalCommits) != null ? num(m.commitStats.totalCommits) : arr(m.commits).length) : null;
		case 'report': return m.report ? 1 : null;
		case 'skills': return Array.isArray(m.skills) ? arr(m.skills).length : null;
		default: return null;
	}
}

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
function renderDetailTab(tab, m, filters, actions) {
	const arr = v => (Array.isArray(v) ? v : []);
	if (tab === 'archive') {
		// ★ 2026-11-02：归档页签。被取代 / 被矛盾判定淘汰的旧版本，90 天内可恢复；不参与检索与注入。
		//   三种状态要分得清：「网关不支持」≠「归档为空」≠「部分分区读失败」。
		const a = m.archive || { items: [], total: 0, shown: 0, failed: 0, unsupported: false, ttlDays: 90 };
		const rows = arr(a.items);
		const act = actions || {};
		const note = h('p', { className: 'md2-hint', 'data-memory-archive-note': '' },
			'被取代 / 被矛盾判定淘汰的旧版本。' + String(a.ttlDays || 90) + ' 天内可恢复，之后由 sweep 清理；不参与检索与注入。'
			+ '「恢复」只把它写回长期记忆，不会动现在的最新版本（两条并存，由你决定忘掉哪条）。');
		if (a.unsupported) {
			return h('div', { 'data-memory-detail-list': 'archive' }, note,
				emptyHint('当前网关版本不支持归档查询（需要新版网关）。这不代表归档是空的。'));
		}

		return h('div', { 'data-memory-detail-list': 'archive' }, note,
			a.failed ? h('p', { className: 'md2-hint mem-err', role: 'alert', 'data-memory-archive-partial': String(a.failed) },
				'有 ' + String(a.failed) + ' 个分区的归档读取失败，下面的列表可能不完整。') : null,
			h('div', { className: 'md2-stats', 'data-memory-detail-stats': '' },
				h('span', null, '共 ' + String(a.total != null ? a.total : rows.length) + ' 条'),
				a.total > rows.length ? h('span', null, '仅显示最近 ' + String(rows.length) + ' 条') : null),
			rows.length ? h('ul', { className: 'md2-list' }, rows.map(it =>
				h('li', { key: String(it.partition) + '|' + String(it.id), className: 'md2-row', 'data-memory-archive-row': String(it.id) },
					h('span', { className: 'md2-row-top' },
						badge(String(it.archiveReason || '未知原因')),
						it.type ? badge(String(it.type), 'md2-badge-type') : null,
						it.partition && it.partition !== m.agentId ? badge(String(it.partition), 'md2-part') : null,
						it.daysLeft != null
							? h('span', { className: 'md2-time', 'data-memory-archive-left': String(it.daysLeft) }, '剩 ' + String(it.daysLeft) + ' 天')
							: h('span', { className: 'md2-time' }, '无到期时间'),
						it.archivedAt ? h('span', { className: 'md2-time' }, new Date(it.archivedAt).toLocaleString()) : null,
						h('span', { className: 'wb-spacer' }),
						h('button', {
							type: 'button', className: 'md2-chip', 'data-memory-archive-restore': String(it.id),
							disabled: !act.restore || !!act.busy,
							onClick: () => { if (act.restore) { act.restore(it); } },
						}, '恢复')),
					h('span', { className: 'md2-row-text' }, String(it.content || '').slice(0, 400)))))
				: emptyHint('归档是空的（还没有旧版本被取代 / 淘汰过）'));
	}
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
						// ★ v3 · P2「标签可点」（longterm：tag chip → searchTag）—— 点 tier / 类型徽标
						//   就地切到对应筛选（不导航、不发请求：层/类型筛选本就是纯前端）。
						h('button', {
							type: 'button',
							className: 'md2-badge md2-tier md2-tag-btn',
							'data-tier': String(it.tier || '?'),
							'data-memory-tier-tag': String(it.tier || ''),
							title: '只看 ' + String(it.tier || '') + ' 层',
							onClick: actions && actions.setLayer ? () => actions.setLayer(String(it.tier || '')) : undefined,
							}, String(it.tier || '?')),
						it.type ? h('button', {
							type: 'button',
							className: 'md2-badge md2-badge-type md2-tag-btn',
							'data-memory-type-tag': String(it.type || ''),
							title: '只看 ' + String(it.type || '') + ' 类型',
							onClick: actions && actions.setType ? () => actions.setType(String(it.type || '').toLowerCase()) : undefined,
						}, String(it.type)) : null,
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
		// ★ 2026-11-02（用户问「为什么部分页签是空的」）：槽位名是**注册好的**、内容却全空 ⇒
		//   8 行「(空)」纯噪音。改成：全空只给一句说明（点名哪些槽位 + 说明不是丢数据），
		//   有内容才逐行展开，剩下空的一行带过。
		const filled = list.filter(x => String(x.content || '').trim());
		const emptyNames = list.filter(x => !String(x.content || '').trim()).map(x => String(x.name || '(未命名)'));
		if (!filled.length) {
			return h('div', { 'data-memory-detail-list': 'slots', 'data-memory-slots-empty': 'all' },
				emptyHint('这 ' + list.length + ' 个槽位都还没写入内容：' + emptyNames.join('、')
					+ '　—— 槽位名已注册、内容为空不等于丢数据；写入后这里会显示正文。'));
		}
		return h('div', { 'data-memory-detail-list': 'slots' },
			filled.map((x, i) => {
				const content = String(x.content || '');
				return h('div', { key: 'sl' + i, className: 'md2-slot' },
					h('div', { className: 'md2-slot-head' }, h('strong', null, String(x.name || '(未命名)')),
						badge(content.length + ' 字', '')),
					h('pre', { className: 'md2-pre' }, content.slice(0, 1200)));
			}),
			emptyNames.length ? h('p', { className: 'md2-hint', 'data-memory-slots-rest': String(emptyNames.length) },
				'另有 ' + emptyNames.length + ' 个槽位为空：' + emptyNames.join('、')) : null);
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
		const all = arr(m.auditLog);
		// ★ 2026-11-02：按来源过滤（人工 / 模型写入 / 自动提升）。过滤是**纯前端**（同记忆页的层筛选口径）。
		//   「自动提升」的凭据（hits / 句式）在 `policyKey` 里（审计行是字段白名单，证据只能放这个键）。
		const af = (filters && filters.audit) || 'all';
		const counts = { 'auto-distill': 0, human: 0, model: 0 };
		all.forEach(x => { const s = auditSourceOf(x); if (counts[s] != null) { counts[s]++; } });
		const log = af === 'all' ? all : all.filter(x => auditSourceOf(x) === af);
		const onFilter = actions && actions.setAuditFilter;
		return h('div', { 'data-memory-detail-list': 'audit' },
			h('div', { className: 'md2-cards' }, Object.keys(summary).map((k, i) => h('span', { key: 'as' + i }, kvRow(k, summary[k])))),
			h('nav', { className: 'md2-filters', 'data-memory-audit-filters': '', style: { padding: '0 0 6px' } }, AUDIT_FILTERS.map(f =>
				h('button', {
					key: f.id, type: 'button', 'data-memory-audit-filter': f.id,
					className: 'md2-chip' + (af === f.id ? ' is-active' : ''),
					onClick: () => { if (onFilter) { onFilter(f.id); } },
				}, f.label + (f.id !== 'all' ? ' (' + String(counts[f.id]) + ')' : '')))),
			h('h4', { className: 'md2-h' }, '审计日志（落盘账本 + 内存态，' + log.length + (af === 'all' ? '' : ' / ' + all.length) + ' 条）'),
			log.length ? h('ul', { className: 'md2-list' }, log.slice(0, 200).map((x, i) => {
				const src = auditSourceOf(x);
				return h('li', { key: 'au' + i, className: 'md2-row', 'data-memory-audit-source': src },
					h('span', { className: 'md2-row-top' }, badge(String(x.operation || x.action || '?')),
						src !== 'other' ? badge(src === 'auto-distill' ? '自动提升' : (src === 'human' ? '人工' : '模型'), 'md2-badge-type') : null,
						x.type || x.tool ? badge(String(x.type || x.tool), 'md2-badge-type') : null,
						x.timestamp ? h('span', { className: 'md2-time' }, new Date(Number(x.timestamp) || 0).toLocaleString()) : null),
					h('span', { className: 'md2-row-text' }, String(x.content || x.target || '').slice(0, 300)),
					src === 'auto-distill' && x.policyKey ? h('span', { className: 'md2-time', 'data-memory-audit-proof': '' }, '凭据：' + String(x.policyKey).replace(/^auto-distill\//, '')) : null);
			}))
				: emptyHint(af === 'all' ? '账本里没有审计条目' : '这一类来源下没有审计条目'));
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
	// `props.initialTab` 仅供测试（SSR 下没法点页签，不传入就测不到"当前页签在「更多」里"这种状态）；生产不传
	const [tab, setTab] = useState(DETAIL_TABS.some(t => t.id === props.initialTab) ? props.initialTab : 'memories');
	// ★ 层筛选是纯前端（与 IDE 侧同口径：切筛选不发请求 ✓）
	const [layer, setLayer] = useState('all');
	const [type, setType] = useState('');
	const [auditFilter, setAuditFilter] = useState('all');
	// 「更多」默认折叠；但**当前页签若在「更多」里就必须展开**（否则选中的页签从栏里消失，用户会迷路）
	const [moreOpen, setMoreOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState({ text: '', error: false });
	const [st, setSt] = useState({ status: 'loading', data: null, error: '' });
	// ★ 2026-11-02：**已取到**的页签计数缓存（取过才记；没取过的页签不显示数字 ⇒ 不把未知画成 0）
	const [tabCounts, setTabCounts] = useState({});
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
	useEffect(() => {
		if (st.status !== 'ready' || !st.data) { return; }
		const n = tabCountOf(tab, st.data);
		if (n == null) { return; }
		setTabCounts(prev => (prev[tab] === n ? prev : Object.assign({}, prev, { [tab]: n })));
	}, [st, tab]);

	/** 归档恢复：POST JSON（服务端要求 content-type: application/json，跨站表单发不出）。 */
	const restoreArchived = useCallback(async (it) => {
		setBusy(true);
		setNote({ text: '', error: false });
		try {
			const res = await fetch(API + '/archive/restore', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: it.id, partition: it.partition }),
			});
			const out = await res.json().catch(() => ({}));
			if (!res.ok && out.ok !== false) { throw new Error('HTTP ' + res.status); }
			if (out.ok) {
				setNote({ text: '已恢复到长期记忆：' + String(it.content || '').slice(0, 40), error: false });
				await reload();
			} else {
				setNote({ text: '恢复失败：' + String(out.error || ('HTTP ' + res.status)), error: true });
			}
		} catch (e) {
			setNote({ text: '恢复失败：' + String((e && e.message) || e), error: true });
		} finally {
			setBusy(false);
		}
	}, [reload]);

	const m = st.data || {};
	const primaryTabs = DETAIL_TABS.filter(t => t.primary !== false);
	const moreTabs = DETAIL_TABS.filter(t => t.primary === false);
	const curInMore = moreTabs.some(t => t.id === tab);
	const showMore = moreOpen || curInMore;
	const tabBtn = t => {
		const n = tabCounts[t.id];
		const known = typeof n === 'number';
		return h('button', {
			key: t.id, type: 'button',
			// 已知为空的页签置灰（点进去只有空态文案）；未知的保持常态，不预判
			className: 'md2-tab' + (t.id === tab ? ' is-active' : '') + (known && n === 0 ? ' is-empty' : ''),
			'data-memory-detail-tab': t.id,
			'data-memory-tab-count': known ? String(n) : '',
			'aria-selected': t.id === tab ? 'true' : 'false',
			title: known && n === 0 ? '已知为空（这个页签还没有数据）' : undefined,
			onClick: () => setTab(t.id),
		}, t.label, known ? h('span', { className: 'md2-tab-n' }, String(n)) : null);
	};

	return h('div', { className: 'wb wb-mem md2', 'data-vssaros-page': 'memory-detail' },
		// 吸顶工具条走**唯一** helper（锚点字面量全插件只出现一次 ⇒ 守卫可数 ✓）
		wbToolbar({
			back: () => props.onBack(),
			title: '记忆详情',
			sub: 'v' + String(m.version || '') + (m.agentId ? ' · ' + String(m.agentId) : ''),
			refresh: () => { void reload(); },
		}),
		h('nav', { className: 'md2-tabs', 'data-memory-detail-tabs': '' },
			primaryTabs.map(tabBtn),
			// 「更多」：钩子 / 提交 / 报告 / 技能（dsh 侧长期为空，折叠不删）。展开时它们紧跟其后。
			moreTabs.length ? h('button', {
				type: 'button', className: 'md2-tab' + (curInMore ? ' is-active' : ''),
				'data-memory-detail-more': showMore ? 'open' : 'closed',
				'aria-expanded': showMore ? 'true' : 'false',
				// 当前页签在「更多」里时不允许收起（收起会让选中项消失）
				onClick: () => { if (!curInMore) { setMoreOpen(!moreOpen); } },
			}, showMore ? '更多 ▴' : '更多 ▾') : null,
			showMore ? moreTabs.map(tabBtn) : null),
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
		note.text ? h('p', {
			className: 'md2-hint' + (note.error ? ' mem-err' : ''), role: note.error ? 'alert' : 'status',
			'data-memory-detail-note': note.error ? 'error' : 'ok', style: { padding: '0 16px' },
		}, note.text) : null,
		st.status === 'error'
			? h('p', { className: 'wb-empty mem-err', role: 'alert', 'data-memory-detail-state': 'error' }, '详情读取失败：' + st.error)
			: (st.status === 'loading' && !st.data
				? h('p', { className: 'wb-empty', 'data-memory-detail-state': 'loading' }, '正在读取详情…')
				: h('section', { className: 'md2-body', 'data-memory-detail-state': 'ready' },
					renderDetailTab(tab, m, { layer, type, audit: auditFilter }, { restore: restoreArchived, busy, setAuditFilter, setLayer, setType }))));
}

  return { DETAIL_TABS, renderDetailTab, MemoryDetailPage };
}
