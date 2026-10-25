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

		function MemoryPanel() {
			const [view, setView] = useState({ status: 'loading', data: null, error: '' });
			const [note, setNote] = useState('');
			const [noteError, setNoteError] = useState(false);
			const [busy, setBusy] = useState('');
			const [diagOpen, setDiagOpen] = useState(false);

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
				h('header', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' },
					h('h1', null, '记忆库'),
					h('span', { className: 'wb-sub' }, '只读快照 · v' + (view.data ? view.data.version : '')),
					h('span', { className: 'wb-spacer' }),
					h('button', { type: 'button', onClick: () => { void reload(); } }, '⟳ 刷新'),
					// ★★ 2026-10-24（第 7 轮，真机定案）：**这一屏是 dsh 客户端渲染的**（不是服务端 SSR 页）
					//   ⇒ 服务端注入的 OPEN_DETAIL_JS **跑不到这里** ⇒ 之前这个 <a> 只有 href
					//   ⇒ 点击 = 普通**主 frame 整页导航** ⇒ 被宿主导航守卫（只放行 `/`）拦掉
					//   ⇒ 用户看到的就是"点了没反应" ✗✗（日志：`[nav] … target=/x/memory/detail => block`）
					//   ⇒ 改成走宿主的 `openModulePage`：在**编辑区标签页**打开详情（页签栏保留、可切回）✓
					//   无桥（纯浏览器）⇒ **不拦**，让 href 自己跳（这是真能用的退化 ✓）
					h('a', {
						className: 'wb-btn is-ghost mem-link',
						href: '/x/memory/?view=detail',   // ★ 无 JS 也至少路径正确（token 由宿主加载时补）
						'data-vssaros-memory-action': 'open-detail',
						onClick: ev => {
							if (ev) { ev.preventDefault(); }
							// ★★ 2026-10-25（第 10 轮）：照抄 `vssaros-agents/lib/client.agents.js` 的 **openModuleRoute** 模式
							//   —— 那边 2026-10-23 用四轮踩出了同一组坑，结论直接可用：
							//   ① **桌面全窗客户端（VsSaros — Desktop）没有 IDE 编辑区** ⇒ 调 `openModulePage` 会
							//      让宿主开出一个**空编辑器** ⇒ 用户看到"**整个窗口黑屏**" ✗✗（真机一致）
							//      ⇒ 该场景必须**整页导航**。
							//   ② 用 **`?view=detail`（同路由查询参数）**而不是 `/x/memory/detail`：
							//      · pathname 不变（仍 `/x/memory/`）⇒ 不触发"从 / 跳模块页"的禁令 ✓
							//      · **文档同源同路径** ⇒ 宿主加载时拼的 token 不会丢 ⇒ 不会再出现"没有 token 的黑屏"✓
							//   ③ IDE 编辑区场景仍走 `openModulePage`（开标签页、页签栏保留）✓
							const b = (() => { try { return typeof window !== 'undefined' ? window.vssarosDsh : null; } catch { return null; } })();
							const topLevel = (() => { try { return window.self === window.top; } catch { return false; } })();
							const say = m => { if (typeof console !== 'undefined' && console.warn) { console.warn('[vssaros-memory][v0.4.0] ' + m); } };
							// ⚠⚠ 目标 URL 必须是**绝对路径 + 继承当前查询参数**：
							//   ① 相对 `?view=detail` 会按**当前文档**解析 ⇒ 当前若是 `/` 就变成 `/?view=detail`（错）✗
							//   ② 丢掉当前查询串 ⇒ **token 丢了** ⇒ 服务端 401 ⇒ 又是黑屏 ✗✗
							const targetUrl = (() => {
								try {
									const u = new URL('/x/memory/?view=detail', location.href);
									for (const kv of new URL(location.href).searchParams) {
										if (!u.searchParams.has(kv[0])) { u.searchParams.set(kv[0], kv[1]); }
									}
									return u.pathname + '?' + u.searchParams.toString();
								} catch (e) { return '/x/memory/?view=detail'; }
							})();
							say('open-detail click; surface=' + (b && b.surface) + ' topLevel=' + topLevel + ' hasBridge=' + !!b);
							// ① 桌面全窗（无编辑区）⇒ 整页导航到**同路由**的详情视图（不黑屏、不丢 token）
							if (b && b.surface === 'full' && topLevel) {
								say('⇒ 桌面全窗：整页导航 ' + targetUrl);
								try { window.location.assign(targetUrl); return; } catch (e) { say('location.assign 失败：' + ((e && e.message) || e)); }
							}
							// ② IDE 编辑区 ⇒ 在标签页里打开（同路由查询参数，服务端会渲染详情）
							if (b && typeof b.openModulePage === 'function') {
								say('⇒ 编辑区打开 openModulePage(' + targetUrl + ')');
								try {
									Promise.resolve(b.openModulePage(targetUrl)).then(
										() => say('openModulePage OK'),
										e => say('openModulePage FAILED: ' + ((e && e.message) || e))
									);
									return;
								} catch (e) { say('openModulePage 抛错：' + ((e && e.message) || e)); }
							}
							// ③ 无桥 ⇒ 原样跳同路由（子帧/顶层都可能，最差是"被守卫拦"但绝不黑屏、绝不静默）
							say('⇒ 无桥兜底：location.assign(' + targetUrl + ')');
							try { window.location.assign(targetUrl); } catch { /* 放弃 */ }
						},
					}, '查看完整记忆 →')),
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

		exports.install = install;
		exports.apply = install;
		exports.inject = [];
		return module.exports;
	},
});
