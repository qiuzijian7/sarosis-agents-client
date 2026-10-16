// @vssaros/dsh-sessions — host 半边：**由 dsh 自己绘制**的历史会话 sideview（只读）。
//
// ── 这个插件解决什么 ────────────────────────────────────────────────────────
// VsSaros 左栏那个「历史会话」原先由壳侧 DOM 面板绘制（`SessionHistoryViewPane`），
// 于是它的两项数据在壳侧**根本拿不到**：
//   · 「会话内热切换的人格」——它只存在于 dsh 的会话投影（`vssaros-persona`）；
//   · 「工作区归属」——壳侧要旁路解析全局 sessions.json 才能拼出来。
// 本插件把这一面搬进 dsh：人格与运行状态**直接读自己的投影**，工作区就是会话的 `cwd`。
//
// ── 数据与纪律 ──────────────────────────────────────────────────────────────
// 冷读主路径 = 投影缓存 `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`（已结束的会话只有这里有）；
// **可选** live 合并 = `sessions.get(id)` + `sessionProjections.stateOf(session, unit)`，**live 优先且逐字段**，
// 没覆盖到的行仍如实标 `cache`（"活会话存在"≠"已投影"，不谎报 live）。
// 两条服务分别可选注入：缺任一条只少一路 live，不影响冷读。
//
// 只读：不注册工具、不声明 `owns`、不写任何文件。
// `inject` 故意为**空**：本插件没有工具（不像 dashboard 那样"工具在任何模板都该可用"），
// 而 `webServer`/`connection` 只在 web 模板里存在 ⇒ 写进静态 inject 会让它在 headless/tui profile
// **永久 pending**（见 `vssaros-dashboard/lib/index.js:26-29` 的注释与 `doc/dsh-modules-conformance.html` §5-9）。

import { escapeHtml, renderShell } from './pageShell.js';
import { applyPresetNames, buildSessionGroups, computeGroupWindow, displayTitleOf, isActiveSession, normalizeGroupBy, personaLabelOf, presetNamesOf, SESSION_GROUP_BY, sessionFromCacheRows, statusOf, subagentDisplayName, subagentDurationText, subagentModeLabel, subagentRowsOf } from './core/sessionList.js';
import { projCacheDirOf, readSessionCaches } from './store.js';

export const name = 'vssaros-sessions';

/** 没有工具、也不硬依赖任何服务（页面路由走可选注入）。 */
export const inject = [];

const ROUTE_PREFIX = '/x/sessions';
/** 一页最多列出的会话数（本地缓存读，够用）。 */
const PAGE_LIMIT = 300;
/** 「分组方式」的 cookie 名（页面脚本写、服务端读 ⇒ 下次直接开这页时保持上次选择）。 */
const GROUP_COOKIE = 'vssaros-sessions-group';

/** 从 Cookie 头里取一个值（取不到回空串）。只做**取值**，不认识的值交给 `normalizeGroupBy` 兜底。 */
function cookieValueOf(req, name) {
	const raw = typeof req?.headers?.cookie === 'string' ? req.headers.cookie : '';
	for (const part of raw.split(';')) {
		const at = part.indexOf('=');
		if (at < 0) {
			continue;
		}
		if (part.slice(0, at).trim() === name) {
			try {
				return decodeURIComponent(part.slice(at + 1).trim());
			} catch {
				return part.slice(at + 1).trim();
			}
		}
	}
	return '';
}

// ─── 渲染辅助 ───────────────────────────────────────────────────────────────

/** 相对时间：只给粗粒度（刚刚 / N 分钟 / N 小时 / N 天）。**未知就返回空串**，不写"未知"占位。 */
function relativeTime(ms, now) {
	if (typeof ms !== 'number' || !Number.isFinite(ms)) {
		return '';
	}
	const diff = Math.max(0, now - ms);
	const minute = 60_000;
	if (diff < minute) {
		return '刚刚';
	}
	if (diff < 60 * minute) {
		return `${Math.floor(diff / minute)} 分钟前`;
	}
	if (diff < 24 * 60 * minute) {
		return `${Math.floor(diff / (60 * minute))} 小时前`;
	}
	return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
}

/**
 * 会话行。`data-*` 是**给页面脚本用的契约**（配额与搜索都靠它，服务端不重复算第二遍）：
 *   · `data-idle="1"`  = 空闲会话（只有它们会被配额折叠）
 *   · `data-active="1"` = 运行中 / 等待用户（**不占配额、始终可见**）
 *   · `data-search`    = 小写化的搜索面（标题 / preset / 人格 / id）
 *   · `hidden`         = 服务端按配额**已经折叠**掉（脚本按需揭开）
 */
function rowHtml(session, { idle, hidden, now }) {
	const status = statusOf(session);
	const persona = personaLabelOf(session);
	const preset = typeof session.preset === 'string' ? session.preset : '';
	const time = relativeTime(session.createdAt, now);
	const searchFace = [displayTitleOf(session), preset, persona, session.id ?? ''].join(' ').toLowerCase();
	const attrs = [
		'class="sv-item' + (status === 'awaiting' ? ' is-awaiting' : '') + (status === 'running' ? ' is-running' : '') + '"',
		`data-session-id="${escapeHtml(session.id ?? '')}"`,
		`data-active="${isActiveSession(session) ? '1' : '0'}"`,
		`data-idle="${idle ? '1' : '0'}"`,
		`data-search="${escapeHtml(searchFace)}"`,
		session.source === 'live' ? 'data-source="live"' : 'data-source="cache"',
		hidden ? 'hidden' : '',
	];
	const dotClass = status === 'awaiting' ? 'sv-dot sv-dot-awaiting' : (status === 'running' ? 'sv-dot sv-dot-running' : 'sv-dot');
	return `<div ${attrs.filter(Boolean).join(' ')}>
	<span class="sv-arrow">▶</span>
	<span class="sv-body">
		<span class="sv-title-line">
			<span class="sv-title">${escapeHtml(displayTitleOf(session))}</span>
			${persona ? `<span class="sv-persona" title="本会话已热切换人格：${escapeHtml(persona)}（只改提示词人设，工具与模型不变）">人格：${escapeHtml(persona)}</span>` : ''}
		</span>
		<span class="sv-sub-line">
			<span class="${dotClass}" title="${status === 'awaiting' ? '等待你回答 / 审批' : (status === 'running' ? 'Agent 正在执行' : '空闲')}"></span>
			${preset ? `<span class="sv-preset">${escapeHtml(preset)}</span>` : '<span class="sv-preset sv-unknown">preset 未知</span>'}
			${time ? `<span class="sv-time">· ${escapeHtml(time)}</span>` : ''}
			<span class="sv-source">${session.source === 'live' ? 'live' : 'cache'}</span>
		</span>
	</span>
</div>`;
}

/** 一个分组（头 + 条目 + 「展开其余」）。 */
function groupHtml(group, now) {
	const window = computeGroupWindow(group.sessions, 0, isActiveSession);
	const activeCount = group.sessions.filter(isActiveSession).length;
	// 「已被配额折叠」= 可见集之外的那些；它们在 DOM 里存在但 hidden，脚本揭开时按 `data-idle` 顺序走。
	const visibleSet = new Set(window.visible.map(session => session.id));
	const rows = group.sessions.map(session => rowHtml(session, {
		idle: !isActiveSession(session),
		hidden: !visibleSet.has(session.id),
		now,
	})).join('\n');
	const more = window.canExpand
		? `<div class="sv-more" data-hidden="${window.hiddenIdle}" data-shown="0">展开其余 ${window.hiddenIdle} 条</div>`
		: '';
	return `<section class="sv-group${group.ungrouped ? ' is-ungrouped' : ''}" data-group-key="${escapeHtml(group.key)}">
	<header class="sv-group-header" role="button" tabindex="0" title="${escapeHtml(group.path || group.title)}">
		<span class="sv-chev">▼</span>
		<span class="sv-group-name">${escapeHtml(group.title)}</span>
		${group.path ? `<span class="sv-group-path">${escapeHtml(group.path)}</span>` : ''}
		<span class="sv-group-meta">
			${activeCount ? `<span class="sv-group-live" title="${activeCount} 个会话正在运行或等待你"><span class="sv-live-dot"></span>${activeCount}</span>` : ''}
			<span class="sv-group-count">${group.sessions.length}</span>
		</span>
	</header>
	<div class="sv-items">
${rows}
${more}
	</div>
</section>`;
}

/** 页面自带脚本：折叠 / 展开其余 / 搜索。**配额判据不在脚本里**（它是服务端的纯函数），脚本只按 `data-*` 揭开。 */
const PAGE_SCRIPT = `
(function () {
	var STEP = 5;
	function items(group) { return Array.prototype.slice.call(group.querySelectorAll('.sv-item')); }
	function idleOf(group) { return items(group).filter(function (el) { return el.getAttribute('data-idle') === '1'; }); }
	function syncMore(group, extra) {
		var more = group.querySelector('.sv-more');
		var idle = idleOf(group);
		var shownIdle = idle.filter(function (el) { return !el.hasAttribute('hidden'); }).length;
		var hidden = idle.length - shownIdle;
		if (!more) { return; }
		more.setAttribute('data-shown', String(extra));
		more.setAttribute('data-hidden', String(hidden));
		if (hidden > 0) { more.textContent = '展开其余 ' + hidden + ' 条'; }
		else if (extra > 0) { more.textContent = '收起'; }
	}
	function applyWindow(group, extra) {
		var limit = 5 + extra;
		var idle = idleOf(group);
		idle.forEach(function (el, index) { if (index < limit) { el.removeAttribute('hidden'); } else { el.setAttribute('hidden', ''); } });
		syncMore(group, extra);
	}
	Array.prototype.forEach.call(document.querySelectorAll('.sv-group'), function (group) {
		var header = group.querySelector('.sv-group-header');
		header.addEventListener('click', function () {
			group.classList.toggle('is-collapsed');
			header.querySelector('.sv-chev').textContent = group.classList.contains('is-collapsed') ? '▶' : '▼';
		});
		header.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.click(); } });
		var more = group.querySelector('.sv-more');
		if (more) {
			more.addEventListener('click', function () {
				var extra = Number(more.getAttribute('data-shown') || '0');
				var hidden = Number(more.getAttribute('data-hidden') || '0');
				applyWindow(group, hidden > 0 ? extra + STEP : 0);
			});
		}
	});
	// 分组方式切换：链接自己会带 ?groupBy= 去发新请求；这里只把选择记进 cookie，
	// 让"下次直接打开这页"保持上次的选择（服务端拿它当默认值）。
	// ⚠ 本文件里这段是**模板字符串**：注释里千万别写反引号（写了就把模板截断，整文件变语法错 ✗）。
	Array.prototype.forEach.call(document.querySelectorAll('.sv-mode'), function (mode) {
		mode.addEventListener('click', function () {
			var value = mode.getAttribute('data-group-by') || 'workspace';
			try { document.cookie = 'vssaros-sessions-group=' + encodeURIComponent(value) + ';path=/;max-age=31536000'; } catch (e) { /* cookie 不可用也不影响这次跳转 */ }
		});
	});
	// 搜索：命中即**不截断**（与 VsSaros 侧同口径：否则"刚搜到的行被 5 条配额折叠掉了"）。
	var search = document.getElementById('sv-search');
	if (search) {
		search.addEventListener('input', function () {
			var q = String(search.value || '').trim().toLowerCase();
			Array.prototype.forEach.call(document.querySelectorAll('.sv-group'), function (group) {
				var hit = 0;
				items(group).forEach(function (el) {
					var match = !q || String(el.getAttribute('data-search') || '').indexOf(q) >= 0;
					if (match) { hit++; el.removeAttribute('hidden'); } else { el.setAttribute('hidden', ''); }
				});
				group.style.display = hit ? '' : 'none';
				var more = group.querySelector('.sv-more');
				if (more) { more.style.display = q ? 'none' : ''; }
			});
		});
	}
})();
`;

/** 页面专属 CSS（外壳样式在 pageShell.js；这里只加本页独有的：分组头 / 人格 / 状态点 / 配额行）。 */
const PAGE_CSS = `
.sv-groups { flex: 1; overflow-y: auto; }
.sv-group { border-bottom: 1px solid var(--vscode-sideBar-border, rgba(128,128,128,.25)); }
.sv-group:last-child { border-bottom: none; }
.sv-group-header { display: flex; align-items: center; gap: 6px; padding: 5px 8px; min-height: 26px;
	cursor: pointer; position: sticky; top: 0; z-index: 2; user-select: none;
	background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,.12)); }
.sv-group-header:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.2)); }
.sv-chev { width: 12px; font-size: 9px; text-align: center; flex-shrink: 0; color: var(--vscode-descriptionForeground, #999); }
.sv-group-name { font-size: 11.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60%; }
.sv-group-path { font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); white-space: nowrap;
	overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; min-width: 0; }
.sv-group-meta { margin-left: auto; display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.sv-group-live { display: flex; align-items: center; gap: 3px; font-size: 10px; color: #3fb950; }
.sv-live-dot { width: 6px; height: 6px; border-radius: 50%; background: #3fb950; }
.sv-group-count { font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 8px;
	background: var(--vscode-badge-background, rgba(128,128,128,.25)); color: var(--vscode-descriptionForeground, #999); }
.sv-group.is-collapsed .sv-items { display: none; }
.sv-group.is-ungrouped .sv-group-name { color: var(--vscode-descriptionForeground, #999); font-weight: 500; }
.sv-item { display: flex; align-items: flex-start; gap: 4px; padding: 4px 8px; min-height: 40px; cursor: pointer; }
.sv-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.sv-arrow { width: 12px; font-size: 9px; text-align: center; flex-shrink: 0; color: var(--vscode-descriptionForeground, #999); padding-top: 4px; }
.sv-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.sv-title-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sv-title { font-size: 13px; line-height: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sv-persona { font-size: 10px; line-height: 15px; padding: 0 6px; border-radius: 4px; flex-shrink: 0;
	border: 1px solid rgba(215,165,33,.45); background: rgba(215,165,33,.1); color: #dcb84a;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
.sv-sub-line { display: flex; align-items: center; gap: 5px; font-size: 11px; line-height: 15px;
	color: var(--vscode-descriptionForeground, #999); min-width: 0; }
.sv-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #e6e6e6; opacity: .45; }
.sv-dot-running { background: #3fb950; opacity: 1; }
.sv-dot-awaiting { background: #d7a521; opacity: 1; }
.sv-preset { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
.sv-preset.sv-unknown { opacity: .6; }
.sv-time { flex-shrink: 0; }
.sv-source { margin-left: auto; flex-shrink: 0; font-size: 9px; opacity: .6; }
.sv-more { padding: 3px 8px 6px 30px; font-size: 11.5px; color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer; user-select: none; }
.sv-more:hover { text-decoration: underline; }
.sv-note { padding: 6px 10px; font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
/* 分组方式切换（按工作区 / 按 Bot）：链接形态，选中态在 .is-active 上（脚本不参与判定） */
.sv-modes { display: flex; align-items: center; gap: 2px; }
.sv-mode { font-size: 11px; line-height: 18px; padding: 1px 7px; border-radius: 9px; text-decoration: none;
	border: 1px solid transparent; cursor: pointer; color: var(--vscode-descriptionForeground, #999); }
.sv-mode:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.sv-mode.is-active { color: var(--vscode-foreground, #ccc); border-color: var(--vscode-focusBorder, #3794ff);
	background: var(--vscode-badge-background, rgba(128,128,128,.25)); }
`;

// ─── 数据收集 ───────────────────────────────────────────────────────────────

/**
 * live 合并（**逐字段、live 优先**）。
 *
 * 与 dashboard 同一条纪律的两点：① 两个服务**都在**才合并，缺一条就原样返回（宁可在页面上
 * 落后一点，也不让一个可选服务把只读主路径带崩）；② "活会话存在 ≠ 已投影" —— 一个刚建、
 * 还没跑回合的活会话可能每项都读不到 ⇒ 那些行**仍标 cache**，不谎报 live。
 */
function mergeLive(rows, state) {
	if (!state?.sessions || !state?.projections) {
		return { sessions: rows, live: 0 };
	}
	let live = 0;
	try {
		const merged = rows.map(row => {
			const session = state.sessions.get(row.id);
			if (!session) {
				return row;
			}
			const fresh = sessionFromCacheRows(
				unit => state.projections.stateOf(session, unit),
				{ id: row.id, cwd: row.cwd, createdAt: row.createdAt, source: 'live' },
			);
			// 逐字段合并：live 有值才覆盖（**把已读到的抹成未知比落后更糟**）。
			const out = { ...row };
			let touched = false;
			for (const [key, value] of Object.entries(fresh)) {
				if (value !== undefined && key !== 'source' && key !== 'id' && key !== 'cwd' && key !== 'createdAt') {
					out[key] = value;
					touched = true;
				}
			}
			if (!touched) {
				return row;
			}
			out.source = 'live';
			live++;
			return out;
		});
		return { sessions: merged, live };
	} catch {
		// 读活服务出任何差错 ⇒ 降级为纯缓存（可选服务不许把主路径带崩）。
		return { sessions: rows, live: 0 };
	}
}

/**
 * 花名册（`ctx.agentPresets.list()`）→ `presetId → 显示名`。
 *
 * **可选注入 + 全程兜底**：服务缺席 / `list()` 抛错 / 形状不认识 ⇒ 返回空表 ⇒ 组名回落 preset id ✓
 *（"按 Bot 分组"宁可显示 id，也不能因为一个可选服务让整页失败）。
 */
async function readPresetNames(state) {
	if (!state?.presets || typeof state.presets.list !== 'function') {
		return new Map();
	}
	try {
		return presetNamesOf(await state.presets.list());
	} catch {
		return new Map();
	}
}

async function collect(config, { limit = PAGE_LIMIT } = {}, state) {
	const { sessions, errors, dir, missing, truncated, remaining } = await readSessionCaches(config, { limit });
	const merged = mergeLive(sessions, state);
	// 排序：`createdAt` 降序（没有的排后，用 id 兜底保证**确定性顺序**，避免每次请求顺序抖动）。
	const rows = merged.sessions.slice().sort((a, b) => {
		const left = typeof a.createdAt === 'number' ? a.createdAt : undefined;
		const right = typeof b.createdAt === 'number' ? b.createdAt : undefined;
		if (left === right) {
			return String(a.id ?? '').localeCompare(String(b.id ?? ''));
		}
		if (left === undefined) {
			return 1;
		}
		if (right === undefined) {
			return -1;
		}
		return right - left;
	});
	return { rows, errors, dir, missing: Boolean(missing), truncated, remaining, live: merged.live, presetNames: await readPresetNames(state) };
}

/**
 * 子智能体明细区（2026-10-14，P1 第二块）。
 *
 * 为什么在**会话页**里而不是新开一整页：子智能体**本身就是会话**（父子关系就在投影里 ✓），本页已经把
 * 会话都读进来了 ⇒ 只差"把父子关系画出来" ✓；新开整页要多一个 IDE 容器 + `DSH_MODULE_PAGES` 登记 +
 * 逐项一致守卫，成本高而信息量相同 ✗（见 `core/sessionList.js` 的同段注释 ✓）。
 *
 * 「读不到」与「确实没派过」给**不同的话**：家规是未知不许伪装成 0 ✗，而这两件事对用户的意义完全不同 ✓。
 */
export function subagentSectionOf(rows) {
	const parents = subagentRowsOf(rows);
	if (parents.length) {
		const total = parents.reduce((n, row) => n + row.children.length, 0);
		return `<div class="sv-subagents" data-vssaros-subagents="1">`
			+ `<h2 class="sv-sub-title">子智能体 <small>${total} 个 · 来自 ${parents.length} 个会话</small></h2>`
			+ parents.map(subagentRowHtml).join('\n')
			+ '</div>';
	}
	// 一条 `children` 是数组都没有 ⇒ 这个投影单元在这批会话里**根本没出现** ⇒ 说"未知"，不说"没有" ✗
	const anyCatalog = rows.some(row => Array.isArray(row.children));
	return `<p class="sv-note" data-vssaros-subagents-empty>${anyCatalog
		? '这些会话都没有派过子智能体。'
		: '这批会话的投影里没有 subagentCatalog 单元 ⇒ 无法判断有没有子智能体（未知，不当成 0）。'}</p>`;
}

/** 一棵"父会话 → 它的子智能体"（每行：显示名 + 模式/状态/耗时 ✓；缺项不编造 ✗）。 */
function subagentRowHtml(row) {
	const kids = row.children.map(child => {
		const mode = subagentModeLabel(child.mode);
		const statusText = child.status === 'running' ? '运行中' : child.status === 'awaiting' ? '等你回答' : '';
		const dur = subagentDurationText(child);
		const meta = [mode, statusText, dur].filter(Boolean).join(' · ');
		// 子会话若不在本轮扫描窗口里（被截断/文件过大 ✗）⇒ 标题缺席，用 `label`/id 兜底 ✓（如实 ✓）
		const title = child.title && child.title !== subagentDisplayName(child) ? child.title : '';
		return '<li class="sv-sub-item">'
			+ `<span class="sv-sub-name">${escapeHtml(subagentDisplayName(child))}</span>`
			+ `<span class="sv-sub-meta">${escapeHtml(meta || '状态未知')}${title ? ` · ${escapeHtml(title)}` : ''}</span>`
			+ '</li>';
	}).join('');
	return `<div class="sv-sub-parent" data-vssaros-subagent-parent="${escapeHtml(row.parentId)}">`
		+ '<div class="sv-sub-line">'
		+ `<span class="sv-sub-parent-title">${escapeHtml(row.parentTitle)}</span>`
		+ `<span class="sv-sub-count">${row.children.length} 个子智能体</span>`
		+ '</div>'
		+ `<ul class="sv-sub-list">${kids}</ul>`
		+ '</div>';
}

/** 子智能体明细区的样式（**不塞进** `PAGE_CSS`：那条字符串很长，改动它风险高于收益 ✓）。 */
const SUBAGENT_CSS = `
.sv-subagents { margin: 14px 0 4px; }
.sv-sub-title { font-size: 14px; margin: 0 0 8px; }
.sv-sub-parent { border: 1px solid var(--dsw-alias-border-l1, #2f2f2f); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; background: rgba(255,255,255,.02); }
.sv-sub-line { display: flex; align-items: baseline; gap: 8px; }
.sv-sub-parent-title { font-weight: 600; }
.sv-sub-count { font-size: 11px; opacity: .7; }
.sv-sub-list { margin: 6px 0 0; padding-left: 16px; }
.sv-sub-item { display: flex; flex-wrap: wrap; gap: 8px; padding: 2px 0; font-size: 12px; }
.sv-sub-name { min-width: 180px; }
.sv-sub-meta { opacity: .72; font-size: 11.5px; }
`;

/** 页面 + API 共用的一份投影（**不可能出现"页面 3 个、API 5 个"**）。 */
function viewOf(scan, now, groupBy) {
	const groups = applyPresetNames(buildSessionGroups(scan.rows, { by: groupBy }), groupBy, scan.presetNames).map(group => ({
		key: group.key,
		title: group.title,
		path: group.path,
		ungrouped: group.ungrouped,
		sessions: group.sessions.map(session => ({
			id: session.id,
			title: displayTitleOf(session),
			cwd: session.cwd,
			preset: session.preset,
			persona: personaLabelOf(session) || undefined,
			status: statusOf(session),
			active: isActiveSession(session),
			createdAt: session.createdAt,
			source: session.source,
			blank: session.blank,
			pendingQuestions: session.pendingQuestions,
		})),
	}));
	return { groups, now, groupBy: normalizeGroupBy(groupBy) };
}

// ─── 页面 ───────────────────────────────────────────────────────────────────

function pageHtml(scan, config, groupBy) {
	const now = Date.now();
	const by = normalizeGroupBy(groupBy);
	// ⚠ 渲染必须用**原始会话对象**（`buildSessionGroups(scan.rows)`），**不能**用 API 的 DTO：
	// DTO 把 `turnRunning` / `personaId` 收敛成了 `status` / `persona` 标签，而 `groupHtml` 认的是前者
	// ⇒ 拿 DTO 渲染会得到"运行指示灯不亮、人格标记不出现、配额把运行中的那条也算成空闲"。
	// 2026-10-12 由探针 `poc/dsh-p0/scripts/p3-49-sessions-plugin.mjs` 抓到（纯逻辑/数据路径单测看不见它 ✗）。
	const groups = applyPresetNames(buildSessionGroups(scan.rows, { by }), by, scan.presetNames);
	// 分组方式切换（2026-10-12 用户要求：按工作区 / 按 Bot 两种）。
	// 用**链接**而不是按钮：分组是**服务端**算的（单一真源）⇒ 点一下就是带 `?groupBy=` 的新请求，无 JS 也能用；
	// 脚本只多做一件小事：把选择记进 cookie，下次直接开这页时保持上次的分组方式 ✓。
	const modes = SESSION_GROUP_BY.map(key => `<a class="sv-mode${key === by ? ' is-active' : ''}" data-group-by="${key}"`
		+ ` href="?groupBy=${key}"${key === by ? ' aria-current="true"' : ''}`
		+ ` title="${key === 'bot' ? '按 Bot（会话跑的 preset）分组' : '按工作区（会话的 cwd）分组'}">${key === 'bot' ? '按 Bot' : '按工作区'}</a>`).join('');
	// 搜索行走**页面壳自带**的 `.dsh-search` 样式（pageShell.js）—— 与看板 / 工作流页同形，不再内联一份。
	const toolbar = `<div class="dsh-toolbar"><span class="sv-modes">${modes}</span></div>`
		+ `<div class="dsh-search"><span class="dsh-search-icon">🔍</span>`
		+ `<input id="sv-search" type="search" placeholder="搜索会话标题 / preset / 人格…"></div>`;
	const diag = `<p class="sv-note" data-vssaros-sessions-dir="${escapeHtml(scan.dir)}">`
		+ `只读 · ${scan.rows.length} 个会话（live 合并 ${scan.live} 行）`
		+ (scan.truncated ? ` · 另有 ${scan.remaining} 个未列出` : '')
		+ (scan.missing ? ' · 投影缓存目录尚不存在（还没有已投影的会话）' : '')
		+ (scan.errors.length ? ` · ${scan.errors.length} 个文件读不动` : '')
		+ `</p>`;
	const body = `<div class="dsh-header"><h1>历史会话 <small>按工作区 · dsh 投影（只读）</small></h1></div>`
		+ toolbar
		+ diag
		// ★ 子智能体明细（2026-10-14 P1 第二块）：放会话组**之前** —— 它是"哪个会话在下崽、下到哪一步了"
		//   的汇总，比逐条会话更适合先看 ✓。
		+ subagentSectionOf(scan.rows)
		+ `<div class="sv-groups">${groups.length ? groups.map(group => groupHtml(group, now)).join('\n') : '<p class="sv-note">还没有会话投影（投影缓存为空）。</p>'}</div>`;
	return renderShell({
		kind: 'sessions',
		title: '历史会话',
		subtitle: '按工作区 · dsh 投影（只读）',
		bodyHtml: body,
		extraCss: PAGE_CSS + SUBAGENT_CSS,
		script: PAGE_SCRIPT,
	});
}

// ─── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
	const state = { sessions: null, projections: null, presets: null };

	// live 通道①：`sessions`（`get(id)` → 活 Session 对象）。
	ctx.inject(['sessions'], child => child.effect(() => {
		state.sessions = child.sessions;
		return () => { state.sessions = null; };
	}));
	// live 通道②：`sessionProjections`（`stateOf(session, unit)` → 该单元当前值）。
	// **分开注入**：任一条缺席只少一路 live。
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		state.projections = child.sessionProjections;
		return () => { state.projections = null; };
	}));
	// 花名册①：`agentPresets`（`list()` → `{ id, name }[]`，dsh 自己的 preset 注册表）——
	// 「按 Bot 分组」的组名就从这里来（**不猜** preset id 反解的名字，见 `presetNamesOf` 的注释）。
	// 同样**分开可选注入**：缺席只让组名回落成 id，不影响页面。
	ctx.inject(['agentPresets'], child => child.effect(() => {
		state.presets = child.agentPresets;
		return () => { state.presets = null; };
	}));

	// 页面路由（**可选**依赖）：`webServer` / `connection` 只在 web 模板里存在。
	// 不在 web 模板 ⇒ 只是**没有页面**，不影响插件激活。
	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			try {
				const url = new URL(req.url ?? '/', 'http://127.0.0.1');
				const requested = Number(url.searchParams.get('limit'));
				const limit = Number.isFinite(requested) && requested > 0 ? Math.min(1000, Math.floor(requested)) : PAGE_LIMIT;
				// 分组方式：URL 参数优先（切换链接带它）→ 上次记的 cookie → 默认按工作区。
				const groupBy = normalizeGroupBy(url.searchParams.get('groupBy') ?? cookieValueOf(req, GROUP_COOKIE));
				// 程序化消费面（探针 / 对账脚本）：与页面**同一份 collect 与同一份分组**，
				// 不可能出现"页面 3 个、API 5 个"。
				if (url.pathname === `${ROUTE_PREFIX}/api/sessions`) {
					const scan = await collect(config, { limit }, state);
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({
						dir: scan.dir,
						missing: scan.missing,
						truncated: scan.truncated,
						remaining: scan.remaining,
						errors: scan.errors,
						live: scan.live,
						// 花名册（`presetId → 显示名`）：程序化消费面也拿得到（页面组名用的就是它）。
						presetNames: Object.fromEntries(scan.presetNames ?? []),
						...viewOf(scan, Date.now(), groupBy),
					}));
					return;
				}
				const scan = await collect(config, { limit }, state);
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				res.end(pageHtml(scan, config, groupBy));
			} catch (e) {
				res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(`历史会话页面渲染失败：${String(e?.message ?? e)}`);
			}
		},
	})));

	// 诊断用：当前数据源可达性（不读盘、不拉服务，只报告注入状态）。
	return { describe: () => ({ route: ROUTE_PREFIX, live: Boolean(state.sessions && state.projections) }) };
}
