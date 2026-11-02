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
		const { useState, useEffect, useCallback, useRef } = react;

		const API = '/x/memory/api';
		const PROMOTE_ROUTE = '/x/memory/promote';
		const DISCARD_ROUTE = '/x/memory/discard';
		const DETAIL_HREF = '/x/memory/detail';

		/** 描述符（与清单 `vssaros.workbench` 同值 ⇒ 守卫逐项比对 ✓）。 */
		const DESCRIPTOR = {
			title: '记忆库',
			description: '查看与整理 Agent 的长期记忆：审核沉淀候选、检查注入内容与归档。',
			repository: 'vssaros:memory',
			// ⚠ 必须自带 icon：规范说"缺省回落 activityBar.icon"，但**宿主快照不回落**（`e.icon || ''`）
			//   ⇒ 漏写就是"注册表里图标为空、商城落到 🧩" ✗（2026-10-22 审计发现本包就漏了）。
			icon: 'codicon:database',
			customFrame: false,
			// ★ 2026-11-02（用户：「记忆库中，移除右侧 AI 助手栏」）：
			//   `splitConversation: false` = 宿主的**逃生门**（`conversationMode()` 判 `detach`）
			//   ⇒ 不再渲染常驻对话列，记忆面板独占整幅；点左侧会话才切到原生会话页（旧行为）。
			//   ⚠ 这个键**不能写进 package.json**：IDE 侧 `vssarosPluginManifest.ts` 的
			//     `WORKBENCH_KEYS` 白名单不含它，未知字段会直接抛「不认识的字段」⇒ 只能声明在**运行期描述符**里
			//     （宿主 `normalize()` 才认它；清单本来也不参与行为判定）。

			splitConversation: false,
			// ★ 2026-11-02（用户：「记忆库不应该有浮动工具栏」）：记忆库是纯管理页，不需要「展开 AI 助手 / 外开」胶囊。
			//   用宿主的正式开关（与 scheduler / loop 同一机制），**不要**用全局 CSS 去藏（那会连带藏掉所有工作台）。
			floatingActions: false,
			// `layout` 只在分栏模式（split）下生效；现在分栏已关，保留它只为**将来重开**时位置与宽度是对的
			// （`businessSide:'left'` = 业务在左、对话在右，与商城 / 媒体库同惯例）。
			layout: { businessSide: 'left', businessWidth: 0.36 },
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

		const AUDIT_FILTERS = [
			{ id: 'all', label: '全部' },
			{ id: 'human', label: '人工' },
			{ id: 'model', label: '模型写入' },
			{ id: 'auto-distill', label: '自动提升' },
		];

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
		/* @generated:detailView end */


		// ═══ 收件箱（记忆工作台 v2 · P2，2026-11-02）═══════════════════════════════════
		// 取代原来的「草稿区」：批量处理 + 撤销 + 改写后提升 + 每条写明"为什么没被自动提升"。
		// 数据：GET api/inbox；写：POST api/inbox/act（JSON；动作白名单在服务端）。
		// 设计依据：doc/memory-workbench-v2-mockup.html（对标 eternal 的批量条+撤销、longterm 的建议动作、
		// evolve 的 hits 排序与就地改写）。
		// ⚠ 机器锚点沿用旧草稿区的 data-vssaros-memory-*（promote/discard/drafts/draft-list），探针不用改。
		// ── v3 · R1「收件箱优先」：四道门判定（纯函数，SSR 可直测）──────────────
		//   数据来自草稿行本身（hits / kind / eligible / why），不发明后端没有的字段。
		const STRONG_KINDS = ['习惯约定', '项目规范', '偏好', 'summary-fact'];
		const SUMMARY_KINDS = ['turn-summary', 'session-summary'];
		function gatesOf(row, minHits) {
			const mn = minHits || 2;
			return [
				{ key: 'hits', label: '同一句说过 ' + mn + ' 次', state: row.hits >= mn ? 'ok' : 'err', r: row.hits + '/' + mn },
				{ key: 'kind', label: '强约定句式', state: STRONG_KINDS.includes(row.kind) ? 'ok' : 'err', r: row.kind || '' },
				{ key: 'summary', label: '不是整段摘要', state: SUMMARY_KINDS.includes(row.kind) ? 'err' : 'ok', r: '' },
				{ key: 'judge', label: 'LLM 判定', state: row.eligible ? 'ok' : (row.why === 'judge-unavailable' ? 'warn' : 'err'), r: row.eligible ? '通过' : (row.why === 'judge-unavailable' ? '未配置' : '未通过') },
			];
		}

		function InboxSection(props) {
			// `props.initial` 仅供测试：SSR 下 `useEffect` 不跑 ⇒ 组件永远停在 loading，测不到任何内容态。
			// 生产不传 ⇒ 行为完全不变。
			const init = props.initial || null;
			const [st, setSt] = useState(init && init.data ? { status: 'ready', data: init.data, error: '' } : (init && init.error ? { status: 'error', data: null, error: init.error } : { status: 'loading', data: null, error: '' }));
			const [seg, setSeg] = useState((init && init.seg) || 'pending');
			const [sel, setSel] = useState({});
			const [open, setOpen] = useState((init && init.open) || '');
			// ★ v3 · R1：批量「冻结确认」——第一次点只冻结目标集合，第二次（确认）才真正发请求。
			const [frozen, setFrozen] = useState(null);
			const [edit, setEdit] = useState(null);
			const [busy, setBusy] = useState(false);
			const [toast, setToast] = useState(null);

			const load = useCallback(async () => {
				try {
					const res = await fetch(API + '/inbox', { cache: 'no-store' });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
					setSt({ status: 'ready', data: body, error: '' });
				} catch (e) {
					setSt(prev => ({ status: prev.data ? 'ready' : 'error', data: prev.data, error: String((e && e.message) || e) }));
				}
			}, []);
			// 30s 轮询 + 每次动作后立即刷新（不做 SSE：收益低，见 mockup 待确认第 7 条）
			useEffect(() => {
				void load();
				const timer = setInterval(() => { void load(); }, 30000);
				return () => clearInterval(timer);
			}, [load]);

			// 撤销条 10s 倒计时
			useEffect(() => {
				if (!toast || !toast.undoIds || !toast.undoIds.length) { return undefined; }
				const timer = setInterval(() => {
					setToast(cur => (cur && cur.left > 1 ? Object.assign({}, cur, { left: cur.left - 1 }) : null));
				}, 1000);
				return () => clearInterval(timer);
			}, [toast && toast.key]);

			/** 发一个批量动作；成功的那些可以撤销（`restore` 本身不再给撤销，避免无限套娃）。 */
			const act = useCallback(async (action, ids, label, text) => {
				if (!ids.length) { return; }
				setBusy(true);
				try {
					const res = await fetch(API + '/inbox/act', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action, ids, text }),
					});
					const out = await res.json().catch(() => ({}));
					if (!res.ok && !Array.isArray(out.results)) { throw new Error(out.error || ('HTTP ' + res.status)); }
					const okIds = (out.results || []).filter(r => r.ok).map(r => r.id);
					const bad = (out.results || []).filter(r => !r.ok);
					setSel({}); setEdit(null); setFrozen(null);
					setToast({
						key: Date.now(),
						text: (okIds.length ? label + ' ' + okIds.length + ' 条' : '') + (bad.length ? (okIds.length ? '；' : '') + '失败 ' + bad.length + ' 条：' + String(bad[0].error || '').slice(0, 80) : ''),
						error: bad.length > 0,
						undoIds: action === 'restore' ? [] : okIds,
						left: 10,
					});
					await load();
					if (props.onChanged) { props.onChanged(); }
				} catch (e) {
					setToast({ key: Date.now(), text: '操作失败：' + String((e && e.message) || e), error: true, undoIds: [], left: 8 });
				} finally {
					setBusy(false);
				}
			}, [load, props.onChanged]);

			const d = st.data;
			const ago = ms => {
				if (!ms) { return ''; }
				const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
				if (s < 60) { return '刚刚'; }
				if (s < 3600) { return Math.round(s / 60) + ' 分钟前'; }
				if (s < 86400) { return Math.round(s / 3600) + ' 小时前'; }
				return Math.round(s / 86400) + ' 天前';
			};
			const pending = d ? d.pending : [];
			const selIds = Object.keys(sel).filter(id => sel[id]);

			const header = h('div', { className: 'wb-group-hd' },
				h('span', null, '待你处理'),
				h('span', { className: 'mem-seg', role: 'tablist' }, [
					['pending', '待审', d ? d.counts.pending : 0],
					['auto', '自动提升动态', d ? d.counts.autos : 0],
					['done', '已处理', d ? d.counts.done : 0],
				].map(s => h('button', {
					key: s[0], type: 'button', role: 'tab', 'aria-selected': seg === s[0] ? 'true' : 'false',
					className: 'mem-seg-btn' + (seg === s[0] ? ' is-on' : ''), 'data-memory-inbox-seg': s[0],
					onClick: () => { setSeg(s[0]); setSel({}); setOpen(''); setFrozen(null); },
				}, s[1], h('span', { className: 'mem-seg-n' }, String(s[2]))))),
				// ★ v3 · R1：位置标签「第 n / total 条」（eternal TUI 的做法：长队列里的方位感）
				h('span', { className: 'mem-pos', 'data-memory-inbox-pos': (() => {
					const n = pending.length;
					const i = open ? pending.findIndex(r => r.id === open) : -1;
					return (i >= 0 ? (i + 1) + '/' + n : '0/' + n);
				})() }, pending.length ? (open ? (pending.findIndex(r => r.id === open) + 1) : 0) + ' / ' + pending.length + ' 条' : '0 / 0 条'),
				h('span', { className: 'wb-spacer' }),
				// 档位在窄栏里已由状态条显示（同一个值）⇒ 窄容器下隐藏这份重复
				h('span', { className: 'wb-card-sub mem-count mem-hide-sm', title: '自动提升档位（config.autoPromote）' }, d ? '自动提升：' + d.mode : ''));

			let body;
			if (st.status === 'loading') {
				body = h('p', { className: 'wb-diag', 'data-memory-inbox-state': 'loading' }, '正在读取收件箱…');
			} else if (st.status === 'error') {
				body = h('p', { className: 'wb-diag mem-err', role: 'alert', 'data-memory-inbox-state': 'error' }, '收件箱读取失败：' + st.error);
			} else if (seg === 'pending') {
				if (!pending.length) {
					body = h('p', { className: 'wb-diag', 'data-memory-inbox-state': 'empty' }, '收件箱清空了 —— 没有需要你判断的候选。达标的候选已自动入库，见「自动提升动态」。');
				} else {
					// ★ v3 · R1：双栏审核——左列表、右「这条凭什么」（四道门逐项 ✓/✗）。
					//   宽容器（≥700px）并排；窄容器证据块顶到列表上方（有「收起」回列表）。
					const openRow = open ? pending.find(r => r.id === open) : null;
					const pane = openRow ? h('aside', { className: 'mem-inbox-evidence', 'data-memory-inbox-evidence': openRow.id },
						h('div', { className: 'wb-group-hd' }, h('span', null, '这条为什么没被自动提升'),
							h('span', { className: 'wb-spacer' }),
							h('button', { type: 'button', 'data-memory-inbox-evidence-close': '', onClick: () => setOpen('') }, '收起')),
						h('p', { className: 'mem-inbox-ev-text' }, openRow.text),
						h('div', { className: 'mem-gates', 'data-memory-inbox-gates': '' }, gatesOf(openRow, d ? d.minHits : 2).map(g =>
							h('div', { key: g.key, className: 'mem-gate is-' + g.state, 'data-memory-inbox-gate': g.key },
								h('span', { className: 'mem-gate-mark' }, g.state === 'ok' ? '✓' : (g.state === 'warn' ? '!' : '✗')),
								h('span', null, g.label),
								h('span', { className: 'mem-gate-r' }, g.r)))),
						h('p', { className: 'wb-diag' }, '判定：', h('b', null, openRow.eligible ? '等待 LLM 判定' : openRow.why), openRow.hint ? ' · ' + openRow.hint : ''),
						h('p', { className: 'wb-diag mem-hide-sm' }, openRow.sessionId ? '来源：会话 ' + String(openRow.sessionId).slice(0, 8) + ' · turn ' + openRow.turn + ' · ' + ago(openRow.lastSeenAt || openRow.at) : '')) : null;
					body = h('div', { className: 'mem-inbox-cols' },
						h('ul', { className: 'mem-drafts mem-inbox', 'data-vssaros-memory-draft-list': '' }, pending.map(row => {
							const isOpen = open === row.id;
							const isEdit = edit && edit.id === row.id;
							return h('li', { key: row.id, className: 'mem-inbox-row' + (sel[row.id] ? ' is-sel' : '') + (isOpen ? ' is-open' : ''), 'data-memory-inbox-row': row.id },
								h('input', {
									type: 'checkbox', 'aria-label': '选择这条', checked: !!sel[row.id], disabled: busy || !!frozen,
									onChange: ev => { const on = ev.target.checked; setSel(cur => Object.assign({}, cur, { [row.id]: on })); },
								}),
								h('div', { className: 'mem-inbox-main' },
									h('div', { className: 'mem-inbox-l1', onClick: () => setOpen(isOpen ? '' : row.id) },
										h('span', { className: 'wb-badge' }, row.kind || '候选'),
										h('span', { className: 'mem-inbox-text' }, row.text)),
									h('div', { className: 'mem-inbox-l2' },
										h('span', null, 'hits ' + row.hits),
										h('span', { className: 'mem-hide-sm' }, row.sessionId ? '会话 ' + String(row.sessionId).slice(0, 8) + ' · turn ' + row.turn : ''),
										h('span', null, ago(row.lastSeenAt || row.at)),
										row.edited ? h('span', null, '已改写') : null,
										h('span', { className: 'mem-why', 'data-memory-inbox-why': row.why }, row.eligible ? '等待 LLM 判定' : '未自动提升：' + row.why)),
									isEdit ? h('div', null,
										h('textarea', {
											className: 'mem-inbox-edit', value: edit.text, rows: 3, 'aria-label': '改写后的文本',
											onChange: ev => setEdit({ id: row.id, text: ev.target.value }),
										}),
										h('div', { className: 'wb-acts' },
											h('button', { type: 'button', disabled: busy, onClick: () => { void act('edit-promote', [row.id], '已改写并提升', edit.text); } }, '改写后提升'),
											h('button', { type: 'button', disabled: busy, onClick: () => setEdit(null) }, '取消'))) : null),
								h('span', { className: 'wb-acts' },
									h('button', { type: 'button', 'data-vssaros-memory-promote': row.id, disabled: busy, onClick: () => { void act('promote', [row.id], '已提升'); } }, '提升'),
									h('button', { type: 'button', disabled: busy, onClick: () => { setEdit({ id: row.id, text: row.text }); setOpen(row.id); } }, '改写'),
									h('button', { type: 'button', 'data-vssaros-memory-discard': row.id, disabled: busy, onClick: () => { void act('discard', [row.id], '已丢弃'); } }, '丢弃')));
						})),
						pane);
				}
			} else {
				const list = seg === 'auto' ? d.autos : d.done;
				body = !list.length
					? h('p', { className: 'wb-diag', 'data-memory-inbox-state': 'empty' }, seg === 'auto'
						? (d.mode === 'off' ? '自动提升当前为 off（只产草稿）。' : '还没有自动提升过的条目。门槛：强句式 + LLM 判定通过 + 同一句说过两次 + 长度/敏感词合规。')
						: '暂无已处理的记录。')
					: h('ul', { className: 'mem-drafts mem-inbox' }, list.map(row => h('li', { key: row.id, className: 'mem-inbox-row is-plain' },
						h('div', { className: 'mem-inbox-main' },
							h('div', { className: 'mem-inbox-l1' },
								h('span', { className: 'wb-badge' }, row.status === 'rejected' ? '已丢弃' : (row.promotedBy === 'auto-distill' ? '已自动提升' : '已提升')),
								h('span', { className: 'mem-inbox-text' }, row.text)),
							h('div', { className: 'mem-inbox-l2' },
								h('span', null, row.kind),
								h('span', null, ago(row.updatedAt || row.at)),
								row.promotedBy === 'auto-distill' ? h('span', null, '凭据：hits=' + row.hits + ' · ' + row.kind + ' · LLM 判定通过') : null)),
						h('span', { className: 'wb-acts' },
							h('button', {
								type: 'button', disabled: busy, 'data-memory-inbox-restore': row.id,
								onClick: () => { void act('restore', [row.id], row.status === 'promoted' ? '已撤销提升' : '已恢复到待审'); },
							}, row.status === 'promoted' ? '撤销提升' : '恢复到待审')))));
			}

			// ★ v3 · R1：批量「冻结确认」（eternal TUI 的做法：进入确认即锁定目标集合，
			//   Enter 提交的一定是用户看到的那批）——第一次点只冻结，第二次才发请求。
			const bulk = seg === 'pending' && pending.length
				? h('div', { className: 'mem-bulk' },
					h('label', null,
						h('input', {
							type: 'checkbox', checked: selIds.length > 0 && selIds.length === pending.length, disabled: busy || !!frozen,
							onChange: ev => { const on = ev.target.checked; const next = {}; if (on) { pending.forEach(r => { next[r.id] = true; }); } setSel(next); },
						}), ' 全选'),
					frozen
						? h('span', { className: 'wb-card-sub', 'data-memory-inbox-frozen': String(frozen.ids.length) },
							'将' + (frozen.action === 'promote' ? '提升' : '丢弃') + '这 ' + frozen.ids.length + ' 条？目标已冻结')
						: h('span', { className: 'wb-card-sub' }, selIds.length ? '已选 ' + selIds.length + ' 条' : '勾选后可批量处理'),
					h('span', { className: 'wb-spacer' }),
					h('span', { className: 'wb-acts' },
						frozen
							? [
								h('button', { key: 'ok', type: 'button', className: 'mem-confirm', disabled: busy, 'data-memory-inbox-confirm': frozen.action,
									onClick: () => { void act(frozen.action, frozen.ids, frozen.action === 'promote' ? '已提升' : '已丢弃'); } },
								frozen.action === 'promote' ? '确认提升' : '确认丢弃'),
								h('button', { key: 'no', type: 'button', disabled: busy, 'data-memory-inbox-cancel': '', onClick: () => setFrozen(null) }, '取消'),
							]
							: [
								h('button', { key: 'p', type: 'button', disabled: busy || !selIds.length, 'data-memory-inbox-bulk': 'promote',
									onClick: () => setFrozen({ action: 'promote', ids: selIds.slice() }) }, '批量提升'),
								h('button', { key: 'd', type: 'button', disabled: busy || !selIds.length, 'data-memory-inbox-bulk': 'discard',
									onClick: () => setFrozen({ action: 'discard', ids: selIds.slice() }) }, '批量丢弃'),
							]))
				: null;

			const reasons = d && seg === 'pending' && Object.keys(d.reasons || {}).length
				? h('p', { className: 'wb-diag', 'data-memory-inbox-reasons': '' }, '未自动提升的原因：',
					Object.keys(d.reasons).map(k => h('span', { key: k, className: 'wb-badge mem-reason' }, k + ' × ' + d.reasons[k])))
				: null;

			return h('section', {
				className: 'wb-card mem-section', 'data-vssaros-memory-drafts': String(d ? d.counts.pending : 0),
				'data-memory-inbox': seg,
			},
				header,
				// 窄容器（右栏 ~300px）只留一行摘要；完整门槛说明在宽容器里显示（见 CSS 的 mem-inbox-desc / mem-inbox-desc-sm）
				h('p', { className: 'wb-diag mem-inbox-desc-sm', 'data-memory-inbox-desc': 'short' }, '高置信候选自动入库，其余在此待审（每条写明原因）；不处理 30 天后淘汰。'),
				h('p', { className: 'wb-diag mem-inbox-desc', 'data-memory-inbox-desc': 'full' },
					'自动沉淀从会话里提取候选。', h('b', null, '高置信条目会自动提升'), '（强约定句式 + LLM 判定通过 + 同一句说过两次 + 长度/敏感词合规，每回合最多 1 条；摘要永远需人工）；'
					+ '其余留在这里等你判断，每条写明了没被自动提升的原因。「提升」= ', h('b', null, '人的显式确认'), '（不会再弹审批窗）；不处理的 30 天后自动淘汰。'),
				reasons,
				body,
				bulk,
				toast ? h('div', { className: 'mem-toast' + (toast.error ? ' is-err' : ''), role: 'status', 'data-memory-inbox-toast': '' },
					h('span', null, toast.text),
					h('span', { className: 'wb-spacer' }),
					toast.undoIds && toast.undoIds.length
						? h('button', { type: 'button', disabled: busy, 'data-memory-inbox-undo': '', onClick: () => { const ids = toast.undoIds; setToast(null); void act('restore', ids, '已撤销'); } }, '撤销（' + toast.left + 's）')
						: null) : null);
		}

		// ═══ 状态条 · 注入预览 · 沉淀漏斗（记忆工作台 v2 · P3/P4，2026-11-02）═══════════════
		// 数据：GET api/overview（状态条 + 漏斗）、GET api/inject-preview（注入预览，**懒加载**：
		//   展开才取——它会让网关重新装配一次，不该每次开页面都白打一发）。
		// 设计依据：doc/memory-workbench-v2-mockup.html（门控透明 / 前缀稳定性可视化 / 沉淀漏斗）。
		// 铁律：**取不到 ≠ 0**。后端对缺席项给 null ⇒ 这里不画那一项，而不是画成 0 / v0。
		const agoOf = ms => {
			if (!ms) { return ''; }
			const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
			if (s < 60) { return '刚刚'; }
			if (s < 3600) { return Math.round(s / 60) + ' 分钟前'; }
			if (s < 86400) { return Math.round(s / 3600) + ' 小时前'; }
			return Math.round(s / 86400) + ' 天前';
		};
		const VERDICT_TEXT = {
			identical: ['ok', '与会话冻结快照一致 —— 提示词前缀不因时间而变。'],
			'append-only': ['ok', '前缀稳定：当前库只在冻结快照的尾部追加了内容，已注入的部分仍可命中 KV 缓存。'],
			'tail-changed': ['warn', '只有最后一块变了（通常是待审提示里的计数），其余前缀仍可命中缓存。'],
			'prefix-broken': ['warn', '差异落在靠前的块：从该块起的缓存会失效（新会话才会生效，当前会话不受影响）。'],
			unavailable: ['dim', '无法比对（网关不可达或快照为空）—— 不下"稳定"的结论。'],
		};

		// ── v3 · P6「数据可信度」：全站统一字形（living-memory 的做法：† 估算、⌊ 下限兜底）────
		// † = 估算（token = 字符/3，与引擎 estimateTokens 同口径）
		// ⌊ = 下限兜底（统计快照可能不全/被重置过 ⇒ 真实历史只会更多，不会更少）
		const TRUST_FOOTNOTE = '† 估算（token = 字符/3，与引擎同口径） · ⌊ 至少这么多（统计快照不全或重置过只会更少，真实值 ≥ 此数）';

		function OverviewSection(props) {
			const init = props.initial || null;
			const [st, setSt] = useState(init && init.data ? { status: 'ready', data: init.data, error: '' } : (init && init.error ? { status: 'error', data: null, error: init.error } : { status: 'loading', data: null, error: '' }));
			const [hOpen, setHOpen] = useState(false);
			const [inj, setInj] = useState(init && init.inject ? { status: 'ready', data: init.inject, error: '' } : { status: 'idle', data: null, error: '' });
			const [injOpen, setInjOpen] = useState(!!(init && init.inject));
			const [textOpen, setTextOpen] = useState(false);
			const [side, setSide] = useState('live');

			const load = useCallback(async () => {
				try {
					const res = await fetch(API + '/overview', { cache: 'no-store' });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
					setSt({ status: 'ready', data: body, error: '' });
				} catch (e) {
					setSt(prev => ({ status: prev.data ? 'ready' : 'error', data: prev.data, error: String((e && e.message) || e) }));
				}
			}, []);
			const loadInject = useCallback(async () => {
				setInj(prev => ({ status: 'loading', data: prev.data, error: '' }));
				try {
					const res = await fetch(API + '/inject-preview', { cache: 'no-store' });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
					setInj({ status: 'ready', data: body, error: '' });
				} catch (e) {
					setInj({ status: 'error', data: null, error: String((e && e.message) || e) });
				}
			}, []);
			useEffect(() => {
				void load();
				const timer = setInterval(() => { void load(); }, 30000);
				return () => clearInterval(timer);
			}, [load]);
			useEffect(() => { if (injOpen && inj.status === 'idle') { void loadInject(); } }, [injOpen]);

			// ── 状态条 ──
			let strip;
			if (st.status === 'loading') {
				strip = h('div', { className: 'mem-health', 'data-memory-health': 'loading' }, h('span', { className: 'wb-card-sub' }, '正在读取状态…'));
			} else if (st.status === 'error') {
				strip = h('div', { className: 'mem-health', role: 'alert', 'data-memory-health': 'error' }, h('span', { className: 'mem-err' }, '状态读取失败：' + st.error));
			} else {
				const hl = st.data.health;
				const gw = hl.gateway;
				const dot = (cls) => h('i', { className: 'mem-dot ' + cls });
				const items = [];
				items.push(h('span', { key: 'gw', className: 'mem-it', 'data-memory-health-gateway': gw.state },
					dot(gw.state === 'ok' ? 'ok' : (gw.state === 'unconfigured' ? 'dim' : 'err')),
					gw.state === 'ok' ? '网关在线' : (gw.state === 'unconfigured' ? '网关未配置' : '网关不可达')));
				// schema：缺席（老网关）⇒ 不画；落后/超前 ⇒ 要醒目
				if (hl.schema) {
					const sc = hl.schema;
					items.push(h('span', { key: 'sc', className: 'mem-it', 'data-memory-health-schema': sc.state, title: sc.migratedAt ? '迁移于 ' + sc.migratedAt : '' },
						dot(sc.state === 'current' ? 'ok' : 'warn'), 'schema v' + sc.version + (sc.state === 'behind' ? '（落后，迁移未完成）' : (sc.state === 'ahead' ? '（库比进程新）' : ''))));
				}
				items.push(h('span', { key: 'ap', className: 'mem-it', 'data-memory-health-autopromote': hl.autoPromote.mode },
					dot(hl.autoPromote.mode === 'off' ? 'warn' : 'ok'), '自动提升 ' + hl.autoPromote.mode));
				items.push(h('span', { key: 'sn', className: 'mem-it mem-opt' }, '会话快照 ' + hl.snapshots));
				if (hl.archive) { items.push(h('span', { key: 'ar', className: 'mem-it mem-opt', 'data-memory-health-archive': String(hl.archive.total) }, '归档 ' + hl.archive.total + ' 条')); }
				strip = h('div', { className: 'mem-health', 'data-memory-health': 'ready' }, items,
					h('span', { className: 'wb-spacer' }),
					h('button', { type: 'button', 'data-memory-health-toggle': hOpen ? 'open' : 'closed', onClick: () => setHOpen(!hOpen) }, hOpen ? '收起' : '健康详情'));
			}
			// ── v3 · P7「降级三态」：网关不是 ok 时，状态条下面直接给**人话诊断**（eternal 的做法：
			//   缺什么、在哪、怎么修；不再是只有一行 error 让人猜）。
			const gwDiag = (st.status === 'ready' && st.data.health.gateway.state !== 'ok') ? (() => {
				const hl = st.data.health;
				const err = hl.gateway.state === 'error';
				return h('div', { className: 'mem-diag', role: 'status', 'data-memory-health-diag': hl.gateway.state },
					h('p', { className: 'wb-diag' }, err
						? '网关不可达：记忆读写都走它，此刻收件箱 / 注入预览 / 检索会跟着失败。'
						: '网关未配置：工作台只有展示，没有实际读写。'),
					err
						? h('ol', { className: 'mem-diag-steps' },
							h('li', null, '确认进程在跑：', h('code', null, 'curl ' + (hl.gateway.url || '127.0.0.1:3112') + '/health'), ' → 期望 ', h('code', null, '{"status":"ok"}')),
							h('li', null, '端口对不上？安装版 ', h('code', null, '3111'), '、dev ', h('code', null, '3112'), '，配置写哪个用哪个（不猜）。'),
							h('li', null, '还不行看 ', h('code', null, 'gateway.log'), ' 末尾 20 行：常见是数据目录被占用或端口被抢。'))
						: h('ol', { className: 'mem-diag-steps' },
							h('li', null, '设环境变量 ', h('code', null, 'VSSAROS_MEMORY_GATEWAY_URL'), '，或由 VsSaros 经 ', h('code', null, '--patch'), ' 注入 ', h('code', null, 'config.gatewayUrl'), '。'),
							h('li', null, '改完重启 dev app / 插件才生效（客户端 chunk 按入口 mtime 判定）。')));
			})() : null;
			const card = (st.status === 'ready' && hOpen) ? (() => {
				const hl = st.data.health;
				const cells = [];
				const kv = (k, v) => cells.push(h('span', { key: k, className: 'mem-kv' }, k + ' ', h('b', null, v)));
				kv('网关', hl.gateway.url || '(未配置)');
				if (hl.gateway.error) { kv('网关错误', hl.gateway.error); }
				if (hl.engine) { kv('引擎', hl.engine); }
				if (hl.schema) { kv('schema', 'v' + hl.schema.version + (hl.schema.migratedAt ? '（迁移于 ' + hl.schema.migratedAt.slice(0, 16).replace('T', ' ') + '）' : '')); }
				if (hl.backups) { kv('迁移备份', hl.backups.count + ' 份' + (hl.backups.latestAt ? '（最近 ' + hl.backups.latestAt.slice(0, 16).replace('T', ' ') + '）' : '')); }
				if (hl.lastSweepAt) { kv('最近 sweep', agoOf(hl.lastSweepAt)); } else if (hl.schema) { kv('最近 sweep', '本进程尚未跑完一轮'); }
				if (hl.archive) { kv('归档', hl.archive.total + ' 条 · 90 天内可恢复'); }
				kv('注入预算', hl.tokenBudget + ' token（估算 †）· 字符闸 ' + hl.charCap);
				kv('分区', hl.partitions.join(' / ') || hl.agent);
				kv('草稿保留', '30 天');
				return h('div', { className: 'mem-hcard', 'data-memory-health-card': '' }, cells);
			})() : null;

			// ── 漏斗 ──
			let funnel = null;
			if (st.status === 'ready') {
				const f = st.data.funnel;
				const max = Math.max(1, f.turns, f.candidates, f.drafts);
				const row = (name, n, cls, key) => h('div', { key, className: 'mem-fr ' + cls, 'data-memory-funnel-row': key },
					h('span', null, name),
					h('span', { className: 'mem-bar' }, h('i', { style: { width: Math.max(n > 0 ? 3 : 0, Math.round(n / max * 100)) + '%' } })),
					h('span', { className: 'mem-n' }, String(n)));
				const rs = Object.keys(f.reasons || {});
				funnel = h('section', { className: 'wb-card mem-section', 'data-memory-funnel': '' },
					h('div', { className: 'wb-group-hd' }, h('span', null, '沉淀漏斗'), h('span', { className: 'wb-spacer' }),
						h('span', { className: 'wb-card-sub mem-count', title: '累计事件数，跨重启保留；下限兜底（快照不全时真实值只会更多）' },
							f.since ? '自 ' + new Date(f.since).toLocaleDateString() + ' 累计' : '累计',
							h('span', { className: 'mem-trust', 'data-memory-funnel-lower': '' }, '⌊'))),
					h('div', { className: 'mem-funnel' },
						row('回合', f.turns, 'turn', 'turns'), row('候选', f.candidates, 'cand', 'candidates'), row('草稿', f.drafts, 'cand', 'drafts'),
						row('自动提升', f.auto, 'auto', 'auto'), row('人工提升', f.human, 'human', 'human'), row('已丢弃', f.discarded, 'drop', 'discarded')),
					h('p', { className: 'wb-diag', 'data-memory-funnel-now': String(f.pendingNow) },
						'当前待审 ', h('b', null, String(f.pendingNow)), ' 条（时点值，不在上面的累计漏斗里）',
						f.undone ? ' · 撤销 ' + f.undone + ' 次' : '', f.failed ? ' · 失败 ' + f.failed + ' 次' : ''),
					rs.length ? h('p', { className: 'wb-diag', 'data-memory-funnel-reasons': '' }, '没被自动提升的原因：',
						rs.map(k => h('span', { key: k, className: 'wb-badge mem-reason' }, k + ' × ' + f.reasons[k]))) : null,
					h('p', { className: 'wb-diag mem-trust-note', 'data-memory-trust-note': '' }, TRUST_FOOTNOTE),
					h('p', { className: 'wb-diag' }, '「自动提升 0」时看这里：是没有候选，还是候选被某条门槛拦下——两者在页面上不该长得一样。'));
			}

			// ── 注入预览 ──
			let preview;
			if (!injOpen) {
				preview = h('section', { className: 'wb-card mem-section', 'data-memory-inject': 'closed' },
					h('div', { className: 'wb-group-hd' }, h('span', null, '模型此刻看到的'), h('span', { className: 'wb-spacer' }),
						h('button', { type: 'button', 'data-memory-inject-open': '', onClick: () => setInjOpen(true) }, '展开预览')),
					h('p', { className: 'wb-diag' }, '展开才会让网关重新装配一次，与会话冻结快照比对前缀是否稳定（不写任何数据）。'));
			} else if (inj.status === 'loading' && !inj.data) {
				preview = h('section', { className: 'wb-card mem-section', 'data-memory-inject': 'loading' }, h('p', { className: 'wb-diag' }, '正在装配…'));
			} else if (inj.status === 'error') {
				preview = h('section', { className: 'wb-card mem-section', 'data-memory-inject': 'error' },
					h('p', { className: 'wb-diag mem-err', role: 'alert' }, '注入预览读取失败：' + inj.error),
					h('button', { type: 'button', onClick: () => { void loadInject(); } }, '重试'));
			} else if (inj.data) {
				const d = inj.data;
				const v = VERDICT_TEXT[d.diff.verdict] || VERDICT_TEXT.unavailable;
				const cur = side === 'live' && d.live ? d.live : (d.frozen || d.live);
				const showing = cur === d.live ? 'live' : 'frozen';
				const pct = cur && cur.pct != null ? cur.pct : null;
				preview = h('section', { className: 'wb-card mem-section', 'data-memory-inject': 'ready' },
					h('div', { className: 'wb-group-hd' }, h('span', null, '模型此刻看到的'),
						h('span', { className: 'mem-seg' },
							h('button', { type: 'button', className: 'mem-seg-btn' + (showing === 'frozen' ? ' is-on' : ''), 'data-memory-inject-side': 'frozen', disabled: !d.frozen, onClick: () => setSide('frozen') }, '冻结快照'),
							h('button', { type: 'button', className: 'mem-seg-btn' + (showing === 'live' ? ' is-on' : ''), 'data-memory-inject-side': 'live', disabled: !d.live, onClick: () => setSide('live') }, '当前库')),
						h('span', { className: 'wb-spacer' }),
						h('button', { type: 'button', 'data-memory-inject-reload': '', disabled: inj.status === 'loading', onClick: () => { void loadInject(); } }, '重新比对'),
						h('button', { type: 'button', onClick: () => setInjOpen(false) }, '收起')),
					cur ? h('div', null,
						h('div', { className: 'mem-inj-line' },
							h('span', null, '已用 ', h('b', null, String(cur.tokens)), pct != null ? ' / 预算 ' + d.budget.tokens + ' token' : ' token', '（估算，字符/3）',
								h('span', { className: 'mem-trust', title: '估算：token = 字符/3' }, '†')),
							pct != null ? h('span', { className: 'wb-badge' + (cur.over ? ' mem-over' : ''), 'data-memory-inject-pct': String(pct) }, pct + '%') : null),
						h('div', { className: 'mem-blocks', 'data-memory-inject-blocks': String(cur.blocks.length) }, cur.blocks.map(b =>
							h('div', { key: b.id + b.start, className: 'mem-blk is-' + (b.state || 'plain'), 'data-memory-inject-block': b.id, 'data-memory-inject-state': b.state || 'plain' },
								h('span', null, b.name, b.state === 'new' ? h('span', { className: 'wb-card-sub' }, ' · 新增 / 之后失效') : (b.state === 'changed' ? h('span', { className: 'wb-card-sub' }, ' · 此处起变化') : null)),
								h('span', { className: 'mem-mono' }, b.tokens + ' tok'))))
						, cur.blocks.length === 0 ? h('p', { className: 'wb-diag' }, '注入文本是空的（没有可注入的记忆）。') : null)
						: h('p', { className: 'wb-diag' }, '没有可显示的内容。'),
					d.liveError ? h('p', { className: 'wb-diag mem-err', role: 'alert', 'data-memory-inject-live-error': '' }, '当前库没取到：' + d.liveError) : null,
					d.frozenError ? h('p', { className: 'wb-diag mem-err' }, '冻结快照有错误：' + d.frozenError) : null,
					h('p', { className: 'mem-verdict is-' + v[0], 'data-memory-inject-verdict': d.diff.verdict }, v[1],
						d.diff.verdict === 'append-only' || d.diff.verdict === 'tail-changed' || d.diff.verdict === 'prefix-broken'
							? ' 前 ' + d.diff.prefixChars.toLocaleString() + ' 字不变' + (d.diff.addedChars ? '，新增 ' + d.diff.addedChars.toLocaleString() + ' 字' : '') + '。' : ''),
					cur && cur.blocks.length ? h('details', { open: textOpen, onToggle: ev => setTextOpen(!!(ev.target && ev.target.open)) },
						h('summary', { className: 'wb-card-sub' }, '展开注入原文'),
						h('pre', { className: 'mem-pre', 'data-memory-inject-text': '' }, cur.blocks.map(b => b.text).join('\n\n'))) : null,
					h('p', { className: 'wb-diag mem-trust-note', 'data-memory-trust-note': '' }, TRUST_FOOTNOTE));
					}

			// `part`：'top' = 状态条（今日页最上）；'inject' = 只注入预览；'funnel' = 只漏斗；'bottom' = 注入+漏斗；缺省 = 全部。
			//   ★ v3 · R1：分段导航后每个页签只取自己那份（各自轮询，不跨组件提状态）。
			const part = props.part || 'all';
			const showStrip = part === 'all' || part === 'top';
			const showCard = part === 'all' || part === 'top';
			const showPreview = part === 'all' || part === 'bottom' || part === 'inject';
			const showFunnel = part === 'all' || part === 'bottom' || part === 'funnel';
			return h('div', { className: 'mem-overview', 'data-memory-overview': st.status, 'data-memory-overview-part': part },
				showStrip ? strip : null,
				showStrip ? gwDiag : null,
				showCard ? card : null,
				showPreview ? preview : null,
				showFunnel ? funnel : null);
		}

		// ★ v3 · R1「收件箱优先」：主页 = 分段导航（今日/记忆/注入/维护/指南）——
		//   今日 = 状态条 + 收件箱（审核第一任务）；其余各占一段，不再一条长滚动。
		const MEMORY_SEGS = [['today', '今日'], ['memory', '记忆'], ['inject', '注入'], ['maint', '维护'], ['guide', '指南']];
		const MEMORY_DENSITY = [['compact', '紧凑'], ['standard', '标准'], ['large', '大']];
		const MEMORY_GUIDE = [
			['这页在做什么', '自动沉淀产出「草稿」，只有你确认才进长期记忆；每条都带「凭什么」。'],
			['四道门', '同一句说过 2 次 · 强约定句式 · 不是整段摘要 · LLM 判定通过；任何一条不过就落到「今日」。'],
			['批量与撤销', '勾选后底部出现批量条；提交前会冻结目标并确认一次；任何提升 10 秒内可撤销。'],
			['密度', '紧凑 / 标准 / 大 只改行高与字号；窄容器自动退回单栏。'],
			['数字怎么读', '注入 token 是估算（字符/3）；「待审」是时点值，「漏斗」是累计值，两者不混排。'],
			['出问题时', '网关不可达时「今日」顶部会亮红；诊断细节在「维护」页。'],
		];

		function MemoryPanel() {
			const [view, setView] = useState({ status: 'loading', data: null, error: '' });
			const [diagOpen, setDiagOpen] = useState(false);
			// ★ 2026-10-26：**页内二级页**（不导航/不开窗）—— 见 MemoryDetailPage 顶部注释里的三条失败路 ✗
			const [page, setPage] = useState('library');
			// ★ v3 · R1：主页分段 + 密度三档（eternal 0.18.2 的做法：紧凑/标准/大）
			const [seg, setSeg] = useState('today');
			const [density, setDensity] = useState('standard');
			// ★ 2026-11-02（用户真机「顶部页签被裁剪」）：切段时把面板滚动位置归零——
			//   否则上一段滚过的位置会带过来，顶部工具条/导航看起来像被裁掉。
			const rootRef = useRef(null);
			useEffect(() => { if (rootRef.current) { rootRef.current.scrollTop = 0; } }, [seg]);

			const reload = useCallback(async () => {
				try {
					const body = await loadPage();
					setView({ status: 'ready', data: body, error: '' });
				} catch (e) {
					setView(v => Object.assign({}, v, { status: 'error', error: String(e && e.message || e) }));
				}
			}, []);
			useEffect(() => { void reload(); }, [reload]);

			// 草稿的提升 / 丢弃 / 撤销 / 批量全部交给 `InboxSection`（POST api/inbox/act）；
			// 旧的表单路由 `/x/memory/promote|discard` 仍在，供 SSR 页的"无 JS"表单使用。
			const d = (view.data && view.data.state) || null;
			const working = (view.data && view.data.working) || { ok: false, text: '', error: '', truncated: false };
			const distill = (view.data && view.data.distill) || {};
			const drafts = (view.data && view.data.drafts) || { rows: [], error: '', readAt: 0 };
			const slots = (view.data && view.data.slots) || [];
			const rows = Array.isArray(drafts.rows) ? drafts.rows : [];
			// ⚠ 机器锚点用 `data-*` 而不是类名：类名属于**视觉层**（UI 统一时会被换成 `wb-*`），
		//   拿类名当锚点 ⇒ 一改样式探针就瞎 ✗（2026-10-22 迁移当场踩到：`.kb-stat-cell` / `.mem-slot` 被换掉后
		//   探针数出 stats=0 / slots=0）。
		const statCell = (label, value) => h('div', { className: 'wb-card', 'data-vssaros-memory-stat': '' },
				h('div', { className: 'wb-card-num' }, String(value)),
				h('div', { className: 'wb-card-label' }, label));
			// ★ v3 · R1：各段内容抽成常量（记忆 / 维护 两段复用；锚点与旧结构逐字不变）
			const statsCard = h('div', { className: 'wb-card mem-card' },
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
					statCell('判定丢弃', distill.judgeDropped ?? 0), statCell('自动提升', distill.autoPromoted ?? 0)));
			const slotsCard = h('section', { className: 'wb-card mem-section' },
				h('div', { className: 'wb-group-hd' }, h('span', null, '固定槽位'), h('span', { className: 'wb-spacer' }), h('span', { className: 'wb-card-sub mem-count' }, String(slots.length))),
				h('div', { className: 'wb-chips', 'data-vssaros-memory-slots': String(slots.length) }, slots.map(name => h('span', { key: name, className: 'wb-badge', 'data-vssaros-memory-slot': String(name) }, String(name).replace(/_/g, ' ')))));
			const diagCard = h('details', { className: 'wb-card mem-section', open: diagOpen, onToggle: (ev) => setDiagOpen(!!(ev.target && ev.target.open)) },
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
					working.truncated ? '**触发了字符闸**（网关给了 ' + String(working.rawChars ?? '?') + ' 字，已截到 ' + String(d ? d.charCap : '') + ' 字）' : '未触发字符闸', ' ✓。'));
			const workingCard = h('section', { className: 'wb-card mem-section', id: 'vssaros-working-memory' },
				h('div', { className: 'wb-group-hd' }, h('span', null, '工作记忆'), h('span', { className: 'wb-spacer' }), h('span', { className: 'wb-card-sub mem-count' }, working.ok ? working.text.length + ' 字' : '未注入')),
				!d || !d.gateway
					? h('p', { className: 'wb-diag' }, '记忆网关未配置：设 ', h('code', null, 'VSSAROS_MEMORY_GATEWAY_URL'), '，或由 VsSaros 经 ', h('code', null, '--patch'), ' 注入 ', h('code', null, 'config.gatewayUrl'), '。')
					: (working.ok
						? h('pre', { className: 'wb-pre' }, working.text || '(工作记忆为空)')
						: h('p', { className: 'wb-diag' }, '刷新失败：', h('code', null, working.error || '(无详情)'))));
			const guideCard = h('section', { className: 'wb-card mem-section', 'data-memory-guide': '' },
				h('div', { className: 'wb-group-hd' }, h('span', null, '指南'), h('span', { className: 'wb-spacer' }), h('span', { className: 'wb-card-sub mem-count' }, '6 条')),
				h('div', { className: 'mem-guide' }, MEMORY_GUIDE.map(g => h('div', { key: g[0], className: 'mem-guide-it' },
					h('h4', null, g[0]), h('p', null, g[1])))));

			// 二级页：同一个工作台内切换（页签栏/侧栏/会话上下文全保留 ✓）
			if (page === 'detail') { return h(MemoryDetailPage, { onBack: () => setPage('library') }); }

			if (view.status === 'loading' && !view.data) {
				// v3 · P7：首屏进度（eternal 的做法：纯 CSS 进度条，不依赖任何数据回来）
				return h('div', { className: 'wb wb-mem', 'data-vssaros-page': 'memory' },
					h('div', { className: 'mem-loading', 'data-memory-state': 'loading' },
						h('div', { className: 'mem-progress', 'aria-hidden': 'true' }, h('i', null)),
						h('p', { className: 'wb-empty' }, '正在读取记忆…（网关不可达时这里会给出三步诊断）')));
			}
			if (view.status === 'error' && !view.data) {
				return h('div', { className: 'wb wb-mem', 'data-vssaros-page': 'memory' }, h('p', { className: 'wb-empty', 'data-memory-state': 'error', role: 'alert' }, '读取失败：' + view.error));
			}

			return h('div', {
				ref: rootRef,
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
				'data-memory-seg': seg,
				'data-memory-density': density,
			},
				wbToolbar({
					title: '记忆库',
					// 分段导航已经把「今日/记忆/注入/维护」摆在显眼位置 ⇒ 副标题不再重复，改带 agent
					sub: (d && d.agent ? d.agent + ' · ' : '') + 'v' + (view.data ? view.data.version : ''),
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
				// ★ v3 · R1「收件箱优先」：分段导航（页签计数能力留给各自段；不造假数）
				h('nav', { className: 'mem-nav', role: 'tablist', 'data-memory-nav': seg },
					MEMORY_SEGS.map(([id, label]) => h('button', {
						key: id, type: 'button', role: 'tab', 'aria-selected': seg === id ? 'true' : 'false',
						className: 'mem-nav-btn' + (seg === id ? ' is-on' : ''), 'data-memory-seg': id,
						onClick: () => setSeg(id),
					}, label)),
					h('span', { className: 'wb-spacer' }),
					h('span', { className: 'mem-density', 'data-memory-density-group': density },
						MEMORY_DENSITY.map(([id, label]) => h('button', {
							key: id, type: 'button', title: '行距：' + label, 'aria-pressed': density === id ? 'true' : 'false',
							className: 'mem-nav-btn' + (density === id ? ' is-on' : ''), 'data-memory-density': id,
							onClick: () => setDensity(id),
						}, label)))),
				drafts.error ? h('p', { className: 'wb-diag mem-err', role: 'alert' }, '草稿读回失败：' + drafts.error) : null,
				// 今日 = 状态条 + 收件箱（审核第一任务）；其余各占一段——不再一条长滚动
				seg === 'today'
					? h('div', { className: 'mem-seg-body' },
						h(OverviewSection, { part: 'top' }),
						h(InboxSection, { onChanged: reload }))
					: seg === 'memory'
						? h('div', { className: 'mem-seg-body' }, statsCard, slotsCard, workingCard)
						: seg === 'inject'
							? h('div', { className: 'mem-seg-body' }, h(OverviewSection, { part: 'inject' }))
							: seg === 'maint'
								? h('div', { className: 'mem-seg-body' }, h(OverviewSection, { part: 'funnel' }), diagCard)
								: guideCard);
		}

		const STYLE_ID = 'vssaros-memory-workbench-layout';
		// ★ 2026-10-22（工作台 UI 统一，方案稿 §6.19）：**通用视觉交给共享层**（宿主注入的 `wb-*`），
		//   这里只留记忆库特有的排版（大数字 hero、草稿列表、错误色）。
		// ⚠ 原来写的 `--dsw-alias-border-l2` / `--dsw-alias-label-link` / `--dsh-font-family-code-default`
		//   **都不存在** ⇒ 一律回落硬编码兜底 ⇒ 从没跟随过主题 ✗（迁移时统一换成真实令牌 / 共享层的 `--wb-*`）。
		const CSS = `
.wb-mem { overflow:auto; --mem-row-y: var(--wb-s2); overflow-anchor:none; }
/* ★ 2026-11-02（用户真机「顶部页签被裁剪」，两张截图都有）：
   .wb 是 height:100% + display:flex; flex-direction:column，.wb-mem 再叠 overflow:auto
   ⇒ 内容超高时**先压缩子项（工具条 / 分段导航）再滚动**，子项带 overflow 就把文字裁掉。
   ⇒ 直接子项一律不参与压缩（要滚动就滚容器，别挤上面的控件）。
   另外 overflow-anchor:none：异步数据（overview / inbox）回来时高度变化会触发浏览器
   滚动锚定，把面板顶到非零滚动位置（截图里「记忆库」标题上半截被切就是它）。
   ⚠ 这段是 CSS 模板字符串内部，注释里不能写反引号（会提前闭合模板）。 */
.wb-mem > * { flex: 0 0 auto; }
.wb-mem[data-memory-density="compact"] { --mem-row-y: var(--wb-s1); }
.wb-mem[data-memory-density="large"] { --mem-row-y: var(--wb-s3); }
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
/* ── 收件箱（记忆工作台 v2，2026-11-02）──────────────────────────────────
   只用 wb-* 令牌；颜色一律 var(令牌, 兜底) 同行写（包内自检的「无裸色值」逐行判定）。 */
/* ★ 窄栏（右栏 ~300px）修复：宿主的 .wb-group-hd 是 flex 且不换行 ⇒ 标题被挤成竖排、分段按钮每个 3 行。
   组头允许换行；标题与按钮文字一律不折行（宁可整块换到下一行，也不把字挤断）。 */
.wb-mem .wb-group-hd { flex-wrap:wrap; row-gap:var(--wb-s1); }
.wb-mem .wb-group-hd > :first-child { white-space:nowrap; flex:0 0 auto; }
.mem-seg { display:inline-flex; max-width:100%; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius:var(--wb-r-pill); overflow:hidden; }
.mem-seg-btn { border:0; background:transparent; color:inherit; padding:2px 10px; font-size:var(--wb-f-xs); font-family:inherit; cursor:pointer; white-space:nowrap; }
.mem-inbox-desc-sm { display:none; }
.mem-seg-btn.is-on { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.22)); font-weight:600; }
.mem-seg-n { margin-left:4px; opacity:.7; }
.mem-inbox { gap:0; }
.mem-inbox-row { display:grid; grid-template-columns:20px minmax(0,1fr) auto; gap:var(--wb-s2); align-items:start; padding:var(--mem-row-y, var(--wb-s2)) var(--wb-s1);
  border-bottom:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2)); }
.mem-inbox-row.is-open { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }
.mem-inbox-row.is-plain { grid-template-columns:minmax(0,1fr) auto; }
.mem-inbox-row:last-child { border-bottom:0; }
.mem-inbox-row.is-sel { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.mem-inbox-main { min-width:0; }
.mem-inbox-l1 { display:flex; gap:var(--wb-s1); align-items:baseline; flex-wrap:wrap; cursor:pointer; }
.mem-inbox-text { font-size:var(--wb-f-sm); word-break:break-word; }
.mem-inbox-l2 { display:flex; gap:var(--wb-s1) var(--wb-s3); flex-wrap:wrap; margin-top:2px; font-size:var(--wb-f-xs); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.mem-why { color:var(--dsw-alias-state-warn-primary, #cca700); }
.mem-reason { display:inline-block; margin:2px 0 0 var(--wb-s1); }
.mem-inbox-detail { margin-top:var(--wb-s1); padding:var(--wb-s1) var(--wb-s2); border-radius:var(--wb-r-sm); font-size:var(--wb-f-xs);
  background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
.mem-inbox-edit { width:100%; margin-top:var(--wb-s1); padding:var(--wb-s1) var(--wb-s2); border-radius:var(--wb-r-sm); font:inherit; font-size:var(--wb-f-sm); color:inherit; resize:vertical;
  background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); }
.mem-bulk { display:flex; align-items:center; gap:var(--wb-s2); flex-wrap:wrap; padding-top:var(--wb-s2);
  border-top:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25)); font-size:var(--wb-f-xs); }
.mem-toast { display:flex; align-items:center; gap:var(--wb-s2); padding:var(--wb-s1) var(--wb-s2); border-radius:var(--wb-r-md); font-size:var(--wb-f-xs);
  background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.22)); border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.mem-toast.is-err { border-color:var(--dsw-alias-state-error-primary, #f48771); }
.mem-toast button { padding:1px 10px; border-radius:var(--wb-r-pill); font-size:var(--wb-f-xs); font-family:inherit; cursor:pointer; color:inherit; background:transparent;
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); }
/* ── 状态条 · 注入预览 · 沉淀漏斗（记忆工作台 v2 · P3/P4，2026-11-02）──────────── */
.mem-overview { display:flex; flex-direction:column; gap:var(--wb-s2); }
.mem-health { display:flex; flex-wrap:wrap; align-items:center; gap:var(--wb-s1) var(--wb-s3); padding:var(--wb-s1) var(--wb-s2);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius:var(--wb-r-md); font-size:var(--wb-f-xs); }
.mem-health button, .mem-overview section button { padding:1px 10px; border-radius:var(--wb-r-pill); font-size:var(--wb-f-xs); font-family:inherit; cursor:pointer; color:inherit; background:transparent;
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); }
.mem-it { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
.mem-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-success-primary, #4ec9b0); }
.mem-dot.warn { background:var(--dsw-alias-state-warn-primary, #cca700); }
.mem-dot.err { background:var(--dsw-alias-state-error-primary, #f48771); }
.mem-dot.dim { background:var(--dsw-alias-label-tertiary, rgba(230,230,230,.4)); }
.mem-hcard { display:flex; flex-wrap:wrap; gap:var(--wb-s1) var(--wb-s3); padding:var(--wb-s1) var(--wb-s2); border-radius:var(--wb-r-md); font-size:var(--wb-f-xs);
  background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
.mem-kv b { font-weight:600; word-break:break-all; }
.mem-funnel { display:flex; flex-direction:column; gap:4px; }
.mem-fr { display:grid; grid-template-columns:74px minmax(0,1fr) 40px; gap:var(--wb-s2); align-items:center; font-size:var(--wb-f-xs); }
.mem-bar { height:12px; border-radius:3px; background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); overflow:hidden; display:block; }
.mem-bar i { display:block; height:100%; background:var(--dsw-alias-brand-primary, #5aa9e6); opacity:.85; }
.mem-fr.auto .mem-bar i { background:var(--dsw-alias-state-success-primary, #4ec9b0); }
.mem-fr.human .mem-bar i { background:var(--dsw-alias-brand-primary, #b07cf0); }
.mem-fr.drop .mem-bar i { background:var(--dsw-alias-label-tertiary, rgba(230,230,230,.5)); }
.mem-n { text-align:right; font-variant-numeric:tabular-nums; }
.mem-inj-line { display:flex; justify-content:space-between; align-items:center; font-size:var(--wb-f-xs); margin-bottom:4px; }
.mem-over { color:var(--dsw-alias-state-error-primary, #f48771); border-color:var(--dsw-alias-state-error-primary, #f48771); }
.mem-blocks { display:flex; flex-direction:column; gap:4px; margin:var(--wb-s1) 0; }
.mem-blk { display:flex; justify-content:space-between; gap:var(--wb-s2); padding:3px var(--wb-s2); border-radius:var(--wb-r-sm); font-size:var(--wb-f-xs);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25)); }
.mem-blk.is-same { border-left:3px solid var(--dsw-alias-state-success-primary, #4ec9b0); }
.mem-blk.is-changed, .mem-blk.is-new { border-left:3px solid var(--dsw-alias-state-warn-primary, #cca700); background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
.mem-mono { font-family:var(--wb-font-mono, monospace); }
.mem-verdict { margin:var(--wb-s1) 0; padding:var(--wb-s1) var(--wb-s2); border-radius:var(--wb-r-sm); font-size:var(--wb-f-xs);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.mem-verdict.is-ok { border-color:var(--dsw-alias-state-success-primary, #4ec9b0); }
.mem-verdict.is-warn { border-color:var(--dsw-alias-state-warn-primary, #cca700); }
.mem-pre { margin:4px 0 0; padding:var(--wb-s2); border-radius:var(--wb-r-sm); white-space:pre-wrap; word-break:break-word; font-size:11px; max-height:320px; overflow:auto;
  background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
/* ── v3 · R1「收件箱优先」（2026-11-02）：分段导航 / 双栏审核 / 冻结批量 / 指南 / 密度 ── */
/* ★ 2026-11-02（用户真机反馈「UI 未更新」）：导航第一版做成 12px 灰字 + 2px 下划线，
   夹在工具条和状态条之间几乎看不见 ⇒ 用户以为重构没生效。改成**显眼的分段控件**。
   ★ 2026-11-02（用户真机反馈「顶部页签被挤压」）：真宿主页面（dsh web）还有自己的全局样式，
   会把按钮的 padding/字号压小 ⇒ 选择器提到 .wb-mem .mem-nav .mem-nav-btn（0,3,0）并把
   字体/内边距/行高/边框**全部显式声明**——宿主任何 ≤(0,2,1) 的通用 button 规则都压不过它。 */
.wb-mem .mem-nav { display:flex; align-items:center; gap:8px; padding:8px 16px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25));
  overflow-x:auto; scrollbar-width:none; background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); }
.wb-mem .mem-nav::-webkit-scrollbar { display:none; }
.wb-mem .mem-nav .mem-nav-btn { box-sizing:border-box; border:1px solid transparent; border-radius:var(--wb-r-pill); background:transparent; color:inherit;
  padding:6px 18px; min-height:28px; font-size:var(--wb-f-sm, 12px); line-height:1.4; font-family:inherit; cursor:pointer; white-space:nowrap; opacity:.78; flex:0 0 auto; }
.wb-mem .mem-nav .mem-nav-btn:hover { opacity:1; background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.wb-mem .mem-nav .mem-nav-btn.is-on { opacity:1; font-weight:600; background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.22));
  border-color:var(--dsw-alias-border-l2, rgba(127,127,127,.35)); }
.wb-mem .mem-nav .mem-density { display:inline-flex; gap:4px; margin-left:auto; flex:0 0 auto; }
.wb-mem .mem-nav .mem-density .mem-nav-btn { padding:3px 12px; min-height:22px; font-size:var(--wb-f-xs, 11px); }
.mem-pos { font-size:var(--wb-f-xs); color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); white-space:nowrap; }
.mem-seg-body { display:flex; flex-direction:column; gap:var(--wb-s2); }
.mem-inbox-cols { display:grid; grid-template-columns:minmax(0,1fr); gap:var(--wb-s2); align-items:start; }
.mem-inbox-evidence { display:flex; flex-direction:column; gap:var(--wb-s2); padding:var(--wb-s2) var(--wb-s3);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius:var(--wb-r-md); font-size:var(--wb-f-xs); }
.mem-inbox-evidence button { padding:1px 10px; border-radius:var(--wb-r-pill); font-size:var(--wb-f-xs); font-family:inherit; cursor:pointer; color:inherit;
  background:transparent; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); }
.mem-inbox-ev-text { margin:0; padding:var(--wb-s1) var(--wb-s2); border-radius:var(--wb-r-sm); font-size:var(--wb-f-sm); line-height:1.6;
  word-break:break-word; background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
.mem-gates { display:flex; flex-direction:column; gap:3px; }
.mem-gate { display:grid; grid-template-columns:14px minmax(0,1fr) auto; gap:6px; align-items:baseline; }
.mem-gate-r { color:var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px; }
.mem-gate.is-ok .mem-gate-mark { color:var(--dsw-alias-state-success-primary, #4ec9b0); }
.mem-gate.is-err .mem-gate-mark { color:var(--dsw-alias-state-error-primary, #f48771); }
.mem-gate.is-warn .mem-gate-mark { color:var(--dsw-alias-state-warn-primary, #cca700); }
.mem-confirm { font-weight:600; }
.mem-guide { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:var(--wb-s2); }
.mem-guide-it { border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25)); border-radius:var(--wb-r-md); padding:var(--wb-s2); font-size:var(--wb-f-xs); }
.mem-guide-it h4 { margin:0 0 4px; font-size:var(--wb-f-sm); }
.mem-guide-it p { margin:0; opacity:.8; line-height:1.6; }
/* ── v3 · P6 数据可信度字形 / P7 降级诊断与首屏进度 ── */
.mem-trust { opacity:.65; margin-left:2px; }
.mem-trust-note { opacity:.72; }
.mem-diag { display:flex; flex-direction:column; gap:4px; padding:var(--wb-s1) var(--wb-s2); border-radius:var(--wb-r-md); font-size:var(--wb-f-xs);
  border:1px solid var(--dsw-alias-state-warn-primary, rgba(204,167,0,.55)); }
.mem-diag-steps { margin:0; padding-left:18px; }
.mem-diag-steps li { margin:2px 0; }
.mem-diag code, .mem-loading code { font-family:var(--wb-font-mono, monospace); padding:0 4px; border-radius:3px;
  background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.mem-loading { display:flex; flex-direction:column; align-items:center; gap:var(--wb-s2); padding:var(--wb-s4, 16px); }
.mem-progress { width:min(320px, 80%); height:6px; border-radius:999px; overflow:hidden;
  background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); }
.mem-progress i { display:block; height:100%; width:40%; border-radius:999px; opacity:.8;
  background:var(--dsw-alias-brand-primary, #5aa9e6); animation:mem-slide 1.2s ease-in-out infinite; }
@keyframes mem-slide { 0% { margin-left:-40%; } 100% { margin-left:100%; } }
/* 双栏审核：容器 ≥700px 才并排；窄容器（右栏 ~300px）证据块顶到列表上方 */
@container (min-width: 700px) {
  .mem-inbox-cols { grid-template-columns:minmax(0, 1fr) minmax(0, 320px); }
}
@container (max-width: 699px) {
  .mem-inbox-evidence { order:-1; }
}
/* ── 记忆详情（React 二级页，2026-10-26）────────────────────────────── */
.md2 .md2-tabs { display:flex; flex-wrap:wrap; gap:4px; padding:0 16px; margin:6px 0 2px; }
.md2 .md2-tab { padding:3px 10px; border-radius:var(--wb-r-pill, 999px); font-size:var(--wb-f-xs, 12px);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background:transparent; color:inherit; cursor:pointer; }
.md2 .md2-tab.is-active { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); font-weight:600; }
/* ★ 2026-11-02：页签计数徽标 + 已知为空置灰（与 detail.css 真源同款） */
.md2 .md2-tab.is-empty { opacity:.55; }
.md2 .md2-tab-n { margin-left:4px; padding:0 5px; border-radius:999px; font-size:10px; line-height:1.5;
  background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); opacity:.9; }
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
/* 可点徽标（tier/类型）：消掉 button 的 UA 背景/字体默认，只留徽标外观（与 detail.css 真源同款） */
.md2 .md2-tag-btn { background:transparent; font:inherit; color:inherit; cursor:pointer; }
.md2 .md2-tag-btn:hover { opacity:.65; }
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
.md2 .md2-tier[data-tier="episodic"] { border-color:var(--dsw-alias-state-warn-primary, #f0a04b); color:var(--dsw-alias-state-warn-primary, #f0a04b); }
.md2 .md2-tier[data-tier="semantic"] { border-color:var(--dsw-alias-state-success-primary, #8bc34a); color:var(--dsw-alias-state-success-primary, #8bc34a); }
.md2 .md2-tier[data-tier="procedural"] { border-color:var(--dsw-alias-brand-primary, #b07cf0); color:var(--dsw-alias-brand-primary, #b07cf0); }
.md2 .md2-part { opacity:.75; }
.md2 .md2-cards { display:flex; flex-wrap:wrap; gap:8px; }
.md2 .md2-kv { display:flex; gap:8px; align-items:baseline; font-size:var(--wb-f-xs, 12px);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); border-radius:6px; padding:3px 8px; }
.md2 .md2-k { opacity:.7; }
.md2 .md2-v { font-weight:600; }
.md2 .md2-slot { border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); border-radius:8px; padding:8px 10px; margin-bottom:8px; }
.md2 .md2-slot-head { display:flex; gap:8px; align-items:center; margin-bottom:4px; }
.md2 .md2-pre { margin:4px 0 0; padding:8px; border-radius:6px; white-space:pre-wrap; word-break:break-word;
  background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); font-size:11px; max-height:320px; overflow:auto; }
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
  .mem-inbox-row { grid-template-columns:20px minmax(0,1fr); }
  .mem-inbox-row.is-plain { grid-template-columns:minmax(0,1fr); }
  .mem-inbox-row > .wb-acts { grid-column:2; }
  .mem-inbox-row.is-plain > .wb-acts { grid-column:1; }
  .mem-hide-sm { display:none; }
  .mem-inbox-desc { display:none; }
  .mem-inbox-desc-sm { display:block; }
  .mem-opt { display:none; }
  .mem-fr { grid-template-columns:62px minmax(0,1fr) 34px; }
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
		exports.__InboxSection = InboxSection;
		exports.__InboxGates = gatesOf;
		exports.__OverviewSection = OverviewSection;
		// 仅供测试：把描述符交给宿主外壳的 `normalize()` 跑一遍，证明"分栏真的关了"（而不是字符串里写了个 false）
		exports.__DESCRIPTOR = DESCRIPTOR;

		exports.install = install;
		exports.apply = install;
		exports.inject = [];
		return module.exports;
	},
});
