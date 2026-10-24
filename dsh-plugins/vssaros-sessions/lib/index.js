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
import { bindFoundation, foundation } from './foundationRef.js';
import { applyPresetNames, buildSessionGroups, computeGroupWindow, displayTitleOf, filterByStatus, filterHiddenByClear, isActiveSession, isAwaitingSession, normalizeGroupBy, normalizeStatusFilter, personaLabelOf, presetNamesOf, SESSION_GROUP_BY, SESSION_STATUS_FILTERS, sessionFromCacheRows, statusOf, subagentDisplayName, subagentDurationText, subagentModeLabel, subagentRowsOf, workspaceTitleOf } from './core/sessionList.js';

import path from 'node:path';
import { dshHomeOf, projCacheDirOf, readSessionCaches } from './store.js';
// ★ 2026-10-19（用户要求）：pin / 最近使用落 prefs.json（跨窗口一致；localStorage 是分区级的 ✗）
import { normalizePrefs, readPrefs, resetCleared, withClearedAt, withRecent, withShowBlank, withToggledPin, writePrefs } from './core/prefs.js';
// ★ 2026-10-19（用户要求）：展开条目要能看到**用户消息** —— 正文在会话日志（多帧 zstd）里，
//   读法与两个坑见 `core/sessionLog.js` 文件头。
import { readFirstPrompt, readUserMessages } from './core/sessionLog.js';


export const name = 'vssaros-sessions';

/** 没有工具、也不硬依赖任何服务（页面路由走可选注入）。 */
// 重构 4（2026-10-16）：本插件现在有工具（session_search）⇒ 静态声明 tools（与 kanban 同口径：
// tools 在任何模板都该可用 ✓；webServer/connection 仍走可选注入——它们只在 web 模板里有 ✓）。
export const inject = ['tools'];

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
/** 绝对时间（本地 `YYYY-MM-DD HH:mm`）—— 详情行用；非数字 / NaN ⇒ 空串（那一行不显示 ✓）。 */
function absTimeOf(ms) {
	if (typeof ms !== 'number' || !isFinite(ms)) { return ''; }
	const d = new Date(ms);
	const p = n => (n < 10 ? '0' : '') + n;
	return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 状态的人话（详情行用）：与行内那盏灯**同一个判据**（`statusOf`），不另造一套 ✗。 */
function statusLabelOf(session, status) {
	if (status === 'running') { return '执行中'; }
	if (status === 'awaiting') { return '等待你回答 / 审批'; }
	if (session && session.blank === true) { return '空白会话（还没有回合）'; }
	return '空闲';
}

function rowHtml(session, { idle, hidden, now, pinned }) {
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
		// ★ 2026-10-19（用户要求「双击会话 item 打开对应聊天框」）：打开会话时要交给宿主两件事 ——
		//   ① preset（宿主据此同步 preset 记账）；② **cwd**（宿主先 session.start 幂等接管这条会话，
		//   否则不在 Host live 集合里的历史会话换绑后也打不开，界面会永久停在「正在打开会话…」）。
		//   两者都从投影里来，缺了就不写属性（不猜 ✗）。
		typeof session.preset === 'string' && session.preset ? `data-preset="${escapeHtml(session.preset)}"` : '',
		typeof session.cwd === 'string' && session.cwd ? `data-cwd="${escapeHtml(session.cwd)}"` : '',
		// 原始标题（改名输入框的初值）。空 ⇒ 不写属性：让输入框留空 + 占位提示，而不是预填"（未命名会话）"。
		typeof session.title === 'string' && session.title ? `data-title="${escapeHtml(session.title)}"` : '',
		hidden ? 'hidden' : '',
	];
	const dotClass = status === 'awaiting' ? 'sv-dot sv-dot-awaiting' : (status === 'running' ? 'sv-dot sv-dot-running' : 'sv-dot');
	// ★★ 2026-10-19（用户改选 **稿 A · 双行紧凑 + 行尾 ⋯**）：
	//   ① 状态是**行首 2px 竖条**（运行中绿色脉动 / 等待黄色 / 空闲灰色）—— 比卡片边框省空间；
	//   ② 展开入口 `⋯`（展开后变 `×`）与固定星同在右侧操作区，平时隐形、hover/展开/键盘选中才出来；
	//   ③ 双行：标题（+人格）一行、preset·时间一行 ⇒ 窄侧栏（320px）里标题能拿到最多宽度。
	//   ⚠ 类名 `sv-dot / sv-dot-running / sv-dot-awaiting` **保持不变**（真机探针与既有断言钉着它们），
	//     这里只改视觉载体（环 ⇒ 竖条），不是改结构。
	return `<div ${attrs.filter(Boolean).join(' ')}>
	<span class="${dotClass}" title="${status === 'awaiting' ? '等待你回答 / 审批' : (status === 'running' ? 'Agent 正在执行' : '空闲')}"></span>
	<span class="sv-body">
		<span class="sv-title-line">
			<span class="sv-title">${escapeHtml(displayTitleOf(session))}</span>
			${persona ? `<span class="sv-persona" title="本会话已热切换人格：${escapeHtml(persona)}（只改提示词人设，工具与模型不变）">人格：${escapeHtml(persona)}</span>` : ''}
		</span>
		<span class="sv-sub-line">
			${preset ? `<span class="sv-preset">${escapeHtml(preset)}</span>` : '<span class="sv-preset sv-unknown">preset 未知</span>'}
			${time ? `<span class="sv-time">· ${escapeHtml(time)}</span>` : ''}
			${/* ★ 2026-10-19（稿 B）：`cache`/`live` 是内部术语，对用户没有意义 ⇒ 从行里去掉（详情里有 source 事实） */ ''}
		</span>
	</span>
	${/* ★ 2026-10-19：固定星改成**服务端渲染**（状态来自 prefs.json ⇒ 跨窗口/换设备一致；
	   从前由脚本按 localStorage 创建 ⇒ 另一个窗口看不见 ✗）。点击由页面脚本绑（走 POST api/prefs）。 */ ''}
	<span class="sv-acts">
	<span class="sv-pin" role="button" tabindex="0" data-pin="${pinned ? '1' : '0'}"
		title="固定 / 取消固定（写入 dshHome 的 prefs.json，跨窗口一致）">${pinned ? '📌' : '☆'}</span>
	${/* 展开入口：「⋯」（展开后脚本换成「×」）。类名仍是 sv-arrow —— 脚本与键盘导航都按它找人，
	   换掉的只是字形与位置（用户要求：不要三角形）。 */ ''}
	<span class="sv-arrow" role="button" tabindex="0" data-exp="1" title="展开 / 收起这条会话的详情（点行其它位置 = 打开该会话）">⋯</span>
	</span>
	<div class="sv-detail" hidden>
		<div class="sv-detail-row"><span class="sv-k">工作目录</span><span class="sv-v">${escapeHtml(session.cwd || '（未知）')}</span></div>
		<div class="sv-detail-row"><span class="sv-k">preset</span><span class="sv-v">${escapeHtml(preset || '（未记录）')}</span></div>
		<div class="sv-detail-row"><span class="sv-k">状态</span><span class="sv-v">${escapeHtml(statusLabelOf(session, status))}</span></div>
		${absTimeOf(session.createdAt) ? `<div class="sv-detail-row"><span class="sv-k">创建</span><span class="sv-v">${escapeHtml(absTimeOf(session.createdAt))}</span></div>` : ''}
		${absTimeOf(session.lastPromptAt) ? `<div class="sv-detail-row"><span class="sv-k">最后提问</span><span class="sv-v">${escapeHtml(absTimeOf(session.lastPromptAt))}</span></div>` : ''}
		${persona ? `<div class="sv-detail-row"><span class="sv-k">人格</span><span class="sv-v">${escapeHtml(persona)}</span></div>` : ''}
		${Array.isArray(session.children) && session.children.length ? `<div class="sv-detail-row"><span class="sv-k">子智能体</span><span class="sv-v">${session.children.length} 个</span></div>` : ''}
		<div class="sv-detail-row"><span class="sv-k">会话 id</span><span class="sv-v sv-mono">${escapeHtml(session.id || '')}</span></div>
	</div>
</div>`;
}

/** 一个分组（头 + 条目 + 「展开其余」）。 */
function groupHtml(group, now, pinnedSet) {
	const window = computeGroupWindow(group.sessions, 0, isActiveSession);
	const activeCount = group.sessions.filter(isActiveSession).length;
	// ★ 2026-10-19（稿 B「工作区工作台」）：组头除了"运行中"，还要给出**等你回答**的数量 ——
	//   这是用户唯一"必须马上处理"的一类，埋在小圆点里等于没显示 ✗。
	const awaitingCount = group.sessions.filter(isAwaitingSession).length;
	// 「已被配额折叠」= 可见集之外的那些；它们在 DOM 里存在但 hidden，脚本揭开时按 `data-idle` 顺序走。
	const visibleSet = new Set(window.visible.map(session => session.id));
	const rows = group.sessions.map(session => rowHtml(session, {
		idle: !isActiveSession(session),
		hidden: !visibleSet.has(session.id),
		now,
		pinned: pinnedSet instanceof Set && pinnedSet.has(session.id),
	})).join('\n');
	const more = window.canExpand
		? `<div class="sv-more" data-hidden="${window.hiddenIdle}" data-shown="0">展开其余 ${window.hiddenIdle} 条</div>`
		: '';
	// ★ 2026-10-19（用户要求）：多根工作区 —— 组头显示**根的数量**（`N 根`），
	//   hover 时用**自绘浮层**列出每个根（`title` 只作无脚本时的兜底）。
	//   为什么不用原生 title 承载详情（前一轮就是这么做的、正是用户这条需求的由来）：
	//   ① 原生 title 要停 ~1s 才弹，且**不能换行/不可控**（多根糊成一行，用户看不懂）；
	//   ② 它挂在徽标上，用户根本不知道那小胶囊能停 ⇒ 必须给一个**看得见的数字** + 主动弹出的详情。
	//   ⚠ 浮层由页面脚本建（`position: fixed` 挂 body）⇒ 不会被滚动容器 / overflow 裁掉 ✓
	//   ⚠ 本段在模板字符串里：注释里禁反引号。
	const roots = Array.isArray(group.roots) ? group.roots.filter(r => typeof r === 'string' && r) : [];
	const multiRoot = roots.length > 1;
	const rootsTip = multiRoot
		? `${group.title}：共 ${roots.length} 个根（主根 + ${roots.length - 1} 个关联根）\n`
			+ roots.map((r, i) => `${i === 0 ? '主根' : '关联根'}：${r}`).join('\n')
		: '';
	return `<section class="sv-group${group.ungrouped ? ' is-ungrouped' : ''}" data-group-key="${escapeHtml(group.key)}">
	<header class="sv-group-header" role="button" tabindex="0" title="${escapeHtml(group.path || group.title)}">
		<span class="sv-chev">▼</span>
		<span class="sv-group-name">${escapeHtml(group.title)}</span>
		${group.path ? `<span class="sv-group-path">${escapeHtml(group.path)}</span>` : ''}
		${multiRoot ? `<span class="sv-group-roots" role="note" tabindex="0" data-roots="${escapeHtml(roots.join('\n'))}" title="${escapeHtml(rootsTip)}" aria-label="${escapeHtml(rootsTip)}">${roots.length} 根</span>` : ''}
		<span class="sv-group-meta">
			${awaitingCount ? `<span class="sv-group-awaiting" title="${awaitingCount} 个会话在等你回答 / 审批">等你 ${awaitingCount}</span>` : ''}
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

/**
 * 一块磁贴（稿 C：dsh desktop 的「多会话窗口」= 会话磁贴矩阵）。
 *
 * 为什么磁贴**只读、不各自绑定一条实时流**：上游客户端的会话是**单例选择模型**
 * （`SessionListState.current` 全局只有一个 id，scope 绑定永远指向它）⇒ 一个页面里
 * 不可能给每块磁贴各绑一条会话的实时流 ⇒ 磁贴负责「一眼看到一批会话在什么状态」，
 * 点一下才把那条会话换到聊天框（走既有的桥 `openSession`，与列表行同一条路 ✓）。
 *
 * ⚠ 磁贴与列表**同一批可见行**（同一份 visibleRows ⇒ 同一套清空/空白/工作区口径），
 *   状态判据也同一个 `statusOf` —— 两处各判一次必然漂移 ✗。
 */
function tileHtml(session, { now, pinned }) {
	const status = statusOf(session);
	const persona = personaLabelOf(session);
	const preset = typeof session.preset === 'string' ? session.preset : '';
	const time = relativeTime(session.createdAt, now);
	// 标题只用**显式标题**；没有标题时留「未命名会话」，把首条用户消息放到预览行
	//（列表视图是拿首条消息当标题的 —— 那是窄栏里的取舍，磁贴有位置分开摆 ✓）。
	const title = session.title && String(session.title).trim() ? String(session.title).trim() : '(未命名会话)';
	const preview = typeof session.firstPrompt === 'string' ? session.firstPrompt : '';
	const searchFace = [title, preview, preset, persona, session.id ?? ''].join(' ').toLowerCase();
	const attrs = [
		'class="sv-tile' + (status === 'awaiting' ? ' is-awaiting' : '') + (status === 'running' ? ' is-running' : '') + (pinned ? ' is-pinned' : '') + '"',
		`data-session-id="${escapeHtml(session.id ?? '')}"`,
		`data-status="${status}"`,
		`data-search="${escapeHtml(searchFace)}"`,
		typeof session.preset === 'string' && session.preset ? `data-preset="${escapeHtml(session.preset)}"` : '',
		typeof session.cwd === 'string' && session.cwd ? `data-cwd="${escapeHtml(session.cwd)}"` : '',
		typeof session.title === 'string' && session.title ? `data-title="${escapeHtml(session.title)}"` : '',
	];
	const dotClass = status === 'awaiting' ? 'sv-dot sv-dot-awaiting' : (status === 'running' ? 'sv-dot sv-dot-running' : 'sv-dot');
	const statusText = status === 'running' ? '运行中' : (status === 'awaiting' ? '等你回答' : '空闲');
	const wsLabel = session.cwd ? workspaceTitleOf(session.cwd) : '(无工作区)';
	return `<div ${attrs.filter(Boolean).join(' ')} role="button" tabindex="0">
	<div class="sv-tile-head">
		<span class="${dotClass}" title="${status === 'awaiting' ? '等待你回答 / 审批' : (status === 'running' ? 'Agent 正在执行' : '空闲')}"></span>
		<span class="sv-tile-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
		<span class="sv-tile-status sv-tile-status-${status}">${statusText}</span>
	</div>
	<div class="sv-tile-preview" title="${escapeHtml(preview)}">${escapeHtml(preview || '(还没有用户消息)')}</div>
	<div class="sv-tile-foot">
		<span class="sv-tile-ws" title="${escapeHtml(session.cwd || '')}">${escapeHtml(wsLabel)}</span>
		${preset ? `<span class="sv-tile-preset">${escapeHtml(preset)}</span>` : ''}
		${persona ? `<span class="sv-tile-persona">${escapeHtml(persona)}</span>` : ''}
		${time ? `<span class="sv-tile-time">${escapeHtml(time)}</span>` : ''}
	</div>
</div>`;
}

/** 磁贴矩阵（网格）。空集也给一句话（不空白页）。 */
function tilesHtml(rows, now, pinnedSet) {
	if (!rows.length) {
		return '<p class="sv-note">没有符合条件的会话。</p>';
	}
	const tiles = rows.map(session => tileHtml(session, {
		now,
		pinned: pinnedSet instanceof Set && pinnedSet.has(session.id),
	})).join('\n');
	return `<div class="sv-tiles" data-vssaros-tiles="1">${tiles}</div>`;
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

	// ★ 2026-10-19（用户要求）：多根工作区的「N 根」徽标 —— hover / 聚焦时弹出**每个根**的详情。
	//   为什么自绘不用原生 title：title 延迟 ~1s、不能换行、窄侧栏里多根糊成一行看不懂，
	//   而且用户不知道那小胶囊可以停上去 ⇒ 一段可见的数字 + 主动弹出的浮层才说得清。
	//   浮层用 position: fixed 挂在 body 上：滚动容器 / overflow 都裁不到它 ✓
	//   ⚠ 本段在模板字符串里：注释与代码一律禁反引号。
	var rootsPop = null;
	function hideRootsPop() {
		if (rootsPop) { rootsPop.remove(); rootsPop = null; }
	}
	function showRootsPop(anchor, roots) {
		hideRootsPop();
		var pop = document.createElement('div');
		pop.className = 'sv-roots-pop';
		var head = document.createElement('div');
		head.className = 'sv-pop-title';
		head.textContent = '本工作区包含 ' + roots.length + ' 个根（主根 + ' + (roots.length - 1) + ' 个关联根）';
		pop.appendChild(head);
		roots.forEach(function (root, index) {
			var row = document.createElement('div');
			row.className = 'sv-pop-row';
			var key = document.createElement('span');
			key.className = 'sv-pop-k';
			key.textContent = index === 0 ? '主根' : '关联根';
			var value = document.createElement('span');
			value.className = 'sv-pop-v';
			value.textContent = root;
			row.appendChild(key);
			row.appendChild(value);
			pop.appendChild(row);
		});
		document.body.appendChild(pop);
		// 定位：贴徽标下方；底部放不下就上翻，右侧超出就左移（都夹在视口内）
		var box = anchor.getBoundingClientRect();
		var size = pop.getBoundingClientRect();
		var left = Math.min(box.left, window.innerWidth - size.width - 8);
		var top = box.bottom + 4;
		if (top + size.height > window.innerHeight - 8) {
			top = Math.max(4, box.top - size.height - 4);
		}
		pop.style.left = Math.max(4, left) + 'px';
		pop.style.top = top + 'px';
		rootsPop = pop;
	}
	Array.prototype.forEach.call(document.querySelectorAll('.sv-group-roots[data-roots]'), function (badge) {
		// ⚠ 必须写**两个**反斜杠：本文件是模板字符串，写一个反斜杠加 n 会在生成页面时被求值成
		//   真正的换行 ⇒ 页面里的字符串字面量被换行截断 ⇒ 整段脚本 SyntaxError（本轮实测踩到；
		//   而 new Function(源码切片) 是绿的 —— 只有"按模板求值后的产物"才验得出来）。
		var roots = String(badge.getAttribute('data-roots') || '').split('\\n').filter(function (r) { return !!r; });
		if (!roots.length) { return; }
		badge.addEventListener('mouseenter', function () { showRootsPop(badge, roots); });
		badge.addEventListener('mouseleave', hideRootsPop);
		badge.addEventListener('focus', function () { showRootsPop(badge, roots); });
		badge.addEventListener('blur', hideRootsPop);
		// 徽标长在组头里，而组头整行是"折叠/展开"开关 ⇒ 点徽标不该把整组折起来
		badge.addEventListener('click', function (e) { e.stopPropagation(); });
		badge.addEventListener('mousedown', function (e) { e.stopPropagation(); });
	});
	window.addEventListener('scroll', hideRootsPop, true);
	document.addEventListener('mousedown', hideRootsPop, true);

	// 分组方式切换：链接自己会带 ?groupBy= 去发新请求；这里只把选择记进 cookie，
	// 让"下次直接打开这页"保持上次的选择（服务端拿它当默认值）。
	// ★ 2026-10-19：切换控件从四个 chip（.sv-mode）改成两个**下拉**（.sv-dd > .sv-dd-items > a.sv-dd-item）
	//   ⇒ 绑定点必须跟着改。只认旧选择器的话这里**一个都匹配不到**，cookie 永远写不进去（静默失效，
	//   p3-49 的「选择会被记住」就是这么变红的）⇒ 现在两种形态都能绑，值从 data-group-by 或 href 里取。
	// ⚠ 本文件里这段是**模板字符串**：注释里千万别写反引号（写了就把模板截断，整文件变语法错 ✗）。
	function rememberGroupBy(value) {
		try { document.cookie = 'vssaros-sessions-group=' + encodeURIComponent(value) + ';path=/;max-age=31536000'; } catch (e) { /* cookie 不可用也不影响这次跳转 */ }
	}
	Array.prototype.forEach.call(document.querySelectorAll('.sv-mode[data-group-by], .sv-dd-item[href*="groupBy="]'), function (link) {
		link.addEventListener('click', function () {
			var value = link.getAttribute('data-group-by');
			if (!value) {
				var m = /[?&]groupBy=([^&]+)/.exec(link.getAttribute('href') || '');
				value = m ? decodeURIComponent(m[1]) : '';
			}
			if (value) { rememberGroupBy(value); }
		});
	});
	// 搜索：命中即**不截断**（与 VsSaros 侧同口径：否则"刚搜到的行被 5 条配额折叠掉了"）。
	// ★ 2026-10-19（用户报「会话 item 太多」的连带）：**清空搜索要回到配额窗口**，不是"全部展开"——
	//   从前清空时把所有行的 hidden 一并摘掉 ⇒ 搜一次再清空，187 条全摊开，且和「展开其余 N 条」打架 ✗。
	var search = document.getElementById('sv-search');
	if (search) {
		search.addEventListener('input', function () {
			var q = String(search.value || '').trim().toLowerCase();
			Array.prototype.forEach.call(document.querySelectorAll('.sv-group'), function (group) {
				var more = group.querySelector('.sv-more');
				if (!q) {
					// 空查询 = 回到"配额 + 用户已展开的数量"（data-shown 是唯一真源，搜索时没动过它 ✓）
					applyWindow(group, Number(more ? more.getAttribute('data-shown') || '0' : 0));
					group.style.display = '';
					if (more) { more.style.display = ''; }
					return;
				}
				var hit = 0;
				items(group).forEach(function (el) {
					if (String(el.getAttribute('data-search') || '').indexOf(q) >= 0) { hit++; el.removeAttribute('hidden'); } else { el.setAttribute('hidden', ''); }
				});
				group.style.display = hit ? '' : 'none';
				if (more) { more.style.display = 'none'; }
			});
		});
	}
	// ★★ 2026-10-19（B 方案：会话管理收敛到 dsh 插件页）────────────────────────────
	// 从前这页是**纯只读**（只有列表 + 分组 + 搜索），点一行没有任何反应 ⇒ 它没法当"会话管理"。
	// 现在补两件事，且**都必须经宿主**（桥），与 chat-surface 的「历史会话」菜单同一条路：
	//   · 点行 = 打开该会话（桥的 openSession ⇒ 宿主校验 + rebind 回推）；
	//   · 顶部「＋ 新建会话」= 桥的 newChat（页面开不了编辑器 ⇒ 由宿主开页签并起会话）。
	// ⚠ 本段在**模板字符串**里：注释与代码一律不许出现反引号（写了会把模板截断 ⇒ 整文件语法错，
	//   本仓已踩过两次）。方法名直接写英文单词即可。
	// ⚠ 桥**没有语义返回值**（只回 true / pong）⇒ 这里**不许**把"命令已发出"当成功：
	//   真实结果由 vssaros-dsh-rebind 回推体现（页面会看到会话换过去）；桥不在/过旧 ⇒ 如实提示。
	function bridge() { return typeof window !== 'undefined' ? window.vssarosDsh : null; }
	function tell(text) {
		var b = bridge();
		if (b && typeof b.notify === 'function') { b.notify('attention', text); }
	}
	// ★ 2026-10-19（用户报障）：会话条目**要能展开** —— 行首那颗 ▶ 从前不响应点击。
	//   分工：▶ = 展开 / 收起**详情**（元数据：cwd / preset / 状态 / 时间 / 人格 / id）；
	//         行其它位置 = 打开会话（既有行为，保持不变 ✓）。
	//   ⚠ 展开只显示**投影里真有的事实**（不含消息正文：正文在 zstd 会话日志里，本页读不到 ✗）。
	Array.prototype.forEach.call(document.querySelectorAll('.sv-item[data-session-id]'), function (el) {
		var arrow = el.querySelector('.sv-arrow');
		var detail = el.querySelector('.sv-detail');
		if (arrow && detail) {
			function toggleDetail() {
				var open = detail.hasAttribute('hidden');
				if (open) { detail.removeAttribute('hidden'); loadMessages(); } else { detail.setAttribute('hidden', ''); }
				// ★ 2026-10-19（稿 C）：展开入口是「⋯」/「×」（用户要求**不要三角形**），
				//   同时把 .open 挂到卡片上 —— 卡片高亮与「⋯」常显都靠它（见 PAGE_CSS 的 .sv-item.open）。
				arrow.textContent = open ? '×' : '⋯';
				el.classList.toggle('open', open);
				arrow.setAttribute('aria-expanded', open ? 'true' : 'false');
			}
			// ★ 2026-10-19（用户要求）：展开时**懒加载用户消息**（首屏不读日志）。
			//   数据来自 /x/sessions/api/messages?id=<会话 id>；读不到就如实说，不编造内容 ✓。
			var loaded = false;
			function loadMessages() {
				if (loaded) { return; }
				var id = el.getAttribute('data-session-id');
				if (!id) { return; }
				var host = detail.querySelector('.sv-msgs');
				if (!host) {
					host = document.createElement('div');
					host.className = 'sv-msgs';
					host.textContent = '正在读取用户消息…';
					detail.appendChild(host);
				}
				loaded = true;
				var apiBase = '';
				var groupsEl = document.querySelector('.sv-groups');
				if (groupsEl) { apiBase = groupsEl.getAttribute('data-api') || ''; }
				if (!apiBase) { apiBase = 'api/messages'; }   // 兜底（老页面/被裁剪的 HTML）
				// 不传 limit ⇒ 服务端返回**全部**用户消息（用户要求：展开看到每一条输入）✓
				fetch(apiBase + '?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
					.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
					.then(function (data) {
						var list = data && Array.isArray(data.messages) ? data.messages : [];
						host.textContent = '';
						if (!list.length) {
							host.className = 'sv-msgs is-empty';
							host.textContent = data && data.reason ? '暂无用户消息（' + data.reason + '）' : '暂无用户消息';
							return;
						}
						host.className = 'sv-msgs';
						// ★ 2026-10-19（用户定稿）：条数多时**默认折叠为「最近 5 条 + 展开全部」**（更省高度）。
						//   序号始终按**全量**计（折叠时从 N-4 开始），否则"#1"会让人以为是第一句 ✗。
						var FOLD = 5;
						var showAll = false;
						function paint() {
							host.textContent = '';
							var start = (!showAll && list.length > FOLD) ? list.length - FOLD : 0;
							for (var i = start; i < list.length; i++) {
								var m = list[i];
								var row = document.createElement('div');
								row.className = 'sv-msg';
								var head = document.createElement('span');
								head.className = 'sv-msg-t';
								head.textContent = '#' + (i + 1) + (m.time ? ' · ' + new Date(m.time).toLocaleString() : '');
								var b = document.createElement('span');
								b.className = 'sv-msg-b';
								b.textContent = String(m.text || '');
								row.appendChild(head);
								row.appendChild(b);
								host.appendChild(row);
							}
							if (list.length > FOLD) {
								var toggle = document.createElement('div');
								toggle.className = 'sv-msg-more';
								toggle.textContent = showAll
									? '收起（只看最近 ' + FOLD + ' 条）'
									: '展开全部 ' + list.length + ' 条（还有 ' + (list.length - FOLD) + ' 条更早的）';
								toggle.addEventListener('click', function (e) { e.stopPropagation(); showAll = !showAll; paint(); });
								host.appendChild(toggle);
							}
							var note = document.createElement('div');
							note.className = 'sv-msg-note';
							note.textContent = '共 ' + list.length + ' 条用户消息（助手回复请点行打开会话查看）';
							host.appendChild(note);
						}
						paint();
					})
					.catch(function (e) {
						host.className = 'sv-msgs is-empty';
						host.textContent = '读取用户消息失败：' + String(e && e.message || e);
					});
			}
			arrow.addEventListener('click', function (e) { e.stopPropagation(); toggleDetail(); });
			arrow.addEventListener('keydown', function (e) {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleDetail(); }
			});
		}
	});
	Array.prototype.forEach.call(document.querySelectorAll('.sv-item[data-session-id]'), function (el) {
		el.setAttribute('role', 'button');
		el.setAttribute('tabindex', '0');
		el.classList.add('is-clickable');
		// ★ 2026-10-19（用户要求「双击会话 item 后，应该打开对应的聊天框 UI」）：
		//   单击 = 打开（既有），双击 = 也是打开 —— 但**必须去抖**：dblclick 之前浏览器会先发两次
		//   click ⇒ 不去抖的话一次双击会发两遍 openSession（两遍 session.start 接管 + 两次换绑，
		//   真机日志里 15:42:36 / 15:42:38 那两条就是这么来的 ✗）。
		//   cwd / preset 一起带上：宿主据此先幂等接管会话再换绑（见 rowHtml 的注释）。
		var lastOpenAt = 0;
		function open() {
			var id = el.getAttribute('data-session-id');
			if (!id) { return; }
			var nowAt = Date.now();
			if (nowAt - lastOpenAt < 600) { return; }   // 双击的第二次 click / 手抖：忽略
			lastOpenAt = nowAt;
			// 记一次"最近使用"（服务端组内排序用）。失败**不打扰**用户 —— 这是隐式记录，
			// 不是用户的显式意图（pin 才是 ⇒ 那条失败要提示并回滚）。
			postPrefs({ recent: id }).catch(function () { /* 忽略 */ });
			// ★ 2026-10-19（用户反复报「点了没反应」）：给一个**立刻可见**的受理反馈 ——
			//   聊天页签可能在别的 group / 被折叠，页面这一侧看不到任何变化 ⇒ 行变暗 2.5s 表示"请求已发出"。
			//   ⚠ 它只表示**受理**（桥没有语义返回值），成功与否由聊天框那边体现。
			el.classList.add('is-opening');
			window.setTimeout(function () { el.classList.remove('is-opening'); }, 2500);
			var b = bridge();
			if (b && typeof b.openSession === 'function') {
				b.openSession(id, el.getAttribute('data-preset') || undefined, el.getAttribute('data-cwd') || undefined);
				return;
			}
			tell('当前宿主不支持从会话页打开会话（页面桥过旧）');
		}
		el.addEventListener('click', open);
		el.addEventListener('dblclick', function (e) { e.preventDefault(); open(); });
		el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
	});
	// ★ 稿 C（2026-10-21 用户拍板）：点磁贴 = 打开那条会话（与列表行**同一条路**：桥 openSession + 同一条去抖口径）。
	//   ⚠ 桥**没有语义返回值**（只回 true / pong）⇒ 不许把"命令已发出"当成功 ⇒ 给一个受理反馈（磁贴变暗）✓。
	//   ⚠ 去抖 600ms：dblclick 之前浏览器会先发两次 click ⇒ 不去抖就是两次 session.start 接管 + 两次换绑 ✗。
	//   ⚠ 磁贴携带 preset + cwd（与列表行同款）：宿主要先 session.start 幂等接管这条历史会话，
	//     否则不在 live 集合里的会话会永远停在「正在打开会话…」✗。
	// ⚠ 本段在模板字符串里：注释与代码一律禁反引号。
	Array.prototype.forEach.call(document.querySelectorAll('.sv-tile[data-session-id]'), function (el) {
		var lastOpenAt = 0;
		function open() {
			var id = el.getAttribute('data-session-id');
			if (!id) { return; }
			var nowAt = Date.now();
			if (nowAt - lastOpenAt < 600) { return; }
			lastOpenAt = nowAt;
			postPrefs({ recent: id }).catch(function () { /* 隐式记录，失败不打扰用户 */ });
			el.classList.add('is-opening');
			window.setTimeout(function () { el.classList.remove('is-opening'); }, 2500);
			var b = bridge();
			if (b && typeof b.openSession === 'function') {
				b.openSession(id, el.getAttribute('data-preset') || undefined, el.getAttribute('data-cwd') || undefined);
				return;
			}
			tell('当前宿主不支持从磁贴打开会话（页面桥过旧）');
		}
		el.addEventListener('click', open);
		el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
	});
	var newBtn = document.getElementById('sv-new');
	if (newBtn) {
		newBtn.addEventListener('click', function () {
			var b = bridge();
			if (b && typeof b.newChat === 'function') { b.newChat(); return; }
			tell('当前宿主不支持从会话页新建会话（页面桥过旧）');
		});
	}
	// ★ 2026-10-19（用户要求「清空历史会话」）：二次确认 → POST prefs → 重载页面。
	//   ⚠ 只**隐藏**（prefs.clearedAt），不删任何文件：删投影缓存只是删索引（dsh 里的会话还在），
	//     而且误点不可逆 ⇒ 「恢复被清空的会话」随时能还原 ✓
	//   ⚠ 本段在模板字符串里：注释与代码一律禁止出现反引号。
	// ★ 稿 C：搜索也要过滤**磁贴**（磁贴视图里没有 .sv-item 行可滤）——
	//   否则「搜到了却什么都没少」= 搜索在磁贴视图里静默失效 ✗。
	//   ⚠ 本段在模板字符串里：注释与代码一律禁反引号。
	var searchTiles = document.getElementById('sv-search');
	if (searchTiles) {
		searchTiles.addEventListener('input', function () {
			var q = String(searchTiles.value || '').trim().toLowerCase();
			Array.prototype.forEach.call(document.querySelectorAll('.sv-tile[data-session-id]'), function (el) {
				if (!q) { el.removeAttribute('hidden'); return; }
				if (String(el.getAttribute('data-search') || '').indexOf(q) >= 0) { el.removeAttribute('hidden'); }
				else { el.setAttribute('hidden', ''); }
			});
		});
	}
	var clearPanelEl = document.getElementById('sv-clear-panel');
	function showClearPanel(show) {
		if (!clearPanelEl) { return; }
		if (show) { clearPanelEl.removeAttribute('hidden'); }
		else { clearPanelEl.setAttribute('hidden', ''); }
	}
	var clearBtnEl = document.getElementById('sv-clear');
	if (clearBtnEl) {
		clearBtnEl.addEventListener('click', function () { showClearPanel(true); });
	}
	var clearNo = document.getElementById('sv-clear-no');
	if (clearNo) {
		clearNo.addEventListener('click', function () { showClearPanel(false); });
	}
	if (clearPanelEl) {
		// 点遮罩关掉（点卡片本身不算）
		clearPanelEl.addEventListener('click', function (e) {
			if (e.target === clearPanelEl) { showClearPanel(false); }
		});
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && !clearPanelEl.hasAttribute('hidden')) { showClearPanel(false); }
		});
	}
	var clearYes = document.getElementById('sv-clear-yes');
	if (clearYes) {
		clearYes.addEventListener('click', function () {
			clearYes.disabled = true;
			clearYes.textContent = '正在清空…';
			postPrefs({ clearHistory: true }).then(function () {
				window.location.reload();
			}).catch(function (err) {
				clearYes.disabled = false;
				clearYes.textContent = '清空';
				showClearPanel(false);
				tell('清空失败：' + String((err && err.message) || err));
			});
		});
	}
	var restoreBtnEl = document.getElementById('sv-restore');
	if (restoreBtnEl) {
		restoreBtnEl.addEventListener('click', function () {
			restoreBtnEl.disabled = true;
			restoreBtnEl.textContent = '正在恢复…';
			postPrefs({ resetClear: true }).then(function () {
				window.location.reload();
			}).catch(function (err) {
				restoreBtnEl.disabled = false;
				tell('恢复失败：' + String((err && err.message) || err));
			});
		});
	}
	// ★ B（2026-10-19）：空白会话开关（默认不显示）—— 落 prefs.showBlank，再重载页面让服务端重算。
	var showBlankEl = document.getElementById('sv-show-blank');
	if (showBlankEl) {
		showBlankEl.addEventListener('click', function () {
			showBlankEl.disabled = true;
			postPrefs({ showBlank: true }).then(function () {
				window.location.reload();
			}).catch(function (err) {
				showBlankEl.disabled = false;
				tell('切换失败：' + String((err && err.message) || err));
			});
		});
	}
	var hideBlankEl = document.getElementById('sv-hide-blank');
	if (hideBlankEl) {
		hideBlankEl.addEventListener('click', function () {
			hideBlankEl.disabled = true;
			postPrefs({ showBlank: false }).then(function () {
				window.location.reload();
			}).catch(function (err) {
				hideBlankEl.disabled = false;
				tell('切换失败：' + String((err && err.message) || err));
			});
		});
	}
	// ★★ 2026-10-19（用户报「会话执行过程中，sideview 的 item 状态不实时」）：
	//   本页是**服务端渲染一次**的 ⇒ 状态环 / 相对时间 / 组头“运行中·等你”都停在打开那一刻。
	//   现在每 2s 只问一次“**界面上这些 id** 现在什么状态”（走 api/live，不读磁盘 ⇒ 毫秒级），
	//   就地打补丁；页面不可见时停表（省电），切回来立刻校准一次。
	//   ⚠ 不整页重载：那会丢掉滚动位置、展开态、正在输入的改名框（用户会以为页面在闪 ✗）。
	//   ⚠ 本段在模板字符串里：注释与代码一律禁反引号。
	// ⚠ 这里**不能**用 groupsEl：它的赋值在本段**之后**（var 提升 ⇒ 此刻还是 undefined），
	//   一用就静默变成空串 ⇒ 轮询永远不启动（本轮实测栽在这里：页面全套事件都正常，只状态不更新 ✗）。
	var liveGroups = document.querySelector('.sv-groups');
	var liveApi = liveGroups ? (liveGroups.getAttribute('data-live-api') || '') : '';
	var liveTimer = null;
	var RING_LABEL = { running: 'Agent 正在执行', awaiting: '等待你回答 / 审批', idle: '空闲' };

	/** 组头的“运行中 / 等你”计数跟着变（它也是状态的一部分，不更新就会自相矛盾）。 */
	function syncGroupCounts() {
		Array.prototype.forEach.call(document.querySelectorAll('.sv-group'), function (group) {
			var running = group.querySelectorAll('.sv-item.is-running').length;
			var awaiting = group.querySelectorAll('.sv-item.is-awaiting').length;
			var meta = group.querySelector('.sv-group-meta');
			if (!meta) { return; }
			var live = meta.querySelector('.sv-group-live');
			if (running > 0 && !live) {
				live = document.createElement('span');
				live.className = 'sv-group-live';
				live.setAttribute('title', running + ' 个会话正在运行');
				live.innerHTML = '<span class="sv-live-dot"></span>';
				meta.insertBefore(live, meta.firstChild);
			}
			if (live) {
				if (running > 0) {
					live.setAttribute('title', running + ' 个会话正在运行');
					live.innerHTML = '<span class="sv-live-dot"></span>' + running;
				} else {
					live.remove();
				}
			}
			var wait = meta.querySelector('.sv-group-awaiting');
			if (awaiting > 0 && !wait) {
				wait = document.createElement('span');
				wait.className = 'sv-group-awaiting';
				meta.insertBefore(wait, meta.firstChild);
			}
			if (wait) {
				if (awaiting > 0) {
					wait.setAttribute('title', awaiting + ' 个会话在等你回答 / 审批');
					wait.textContent = '等你 ' + awaiting;
				} else {
					wait.remove();
				}
			}
		});
	}

	/** 按服务端快照就地更新一行（状态环 / data-active / data-idle / 时间 / 标题）。 */
	function patchRow(el, s) {
		if (s.status) {
			var ring = el.querySelector('.sv-dot');
			if (ring) {
				ring.className = 'sv-dot' + (s.status === 'running' ? ' sv-dot-running' : (s.status === 'awaiting' ? ' sv-dot-awaiting' : ''));
				ring.setAttribute('title', RING_LABEL[s.status] || '空闲');
			}
			var active = s.status === 'running' || s.status === 'awaiting';
			// 这两个属性是**配额/展开/搜索**的判据（脚本 applyWindow 按 data-idle 走）⇒ 必须跟着改，
			// 否则“会话从运行变成空闲”后，点「展开其余」仍会把它当成 active 不算配额（或反之）✗。
			el.setAttribute('data-active', active ? '1' : '0');
			el.setAttribute('data-idle', active ? '0' : '1');
			el.classList.toggle('is-running', s.status === 'running');
			el.classList.toggle('is-awaiting', s.status === 'awaiting');
			// 与服务端配额规则对齐：**运行中 / 等待中的行始终可见**（它们不吃 5 条配额）。
			// 若它此前被折叠（hidden），现在跑起来了就必须露出来 —— 否则用户看不到"它正在跑"✗。
			if (active) { el.removeAttribute('hidden'); }
		}
		if (typeof s.time === 'string' && s.time) {
			var timeEl = el.querySelector('.sv-time');
			if (timeEl) { timeEl.textContent = '· ' + s.time; }
		}
		if (typeof s.title === 'string' && s.title) {
			var titleEl = el.querySelector('.sv-title');
			if (titleEl && titleEl.textContent !== s.title) { titleEl.textContent = s.title; }
		}
	}

	/**
	 * ★ 稿 C（2026-10-21）：按服务端快照更新**一块磁贴**（状态灯 / 状态文案 / 时间 / 标题）。
	 * ⚠ 与列表行**同一个** RING_LABEL 口径（running / awaiting / idle）—— 两处各写一套必然漂移 ✗。
	 * ⚠ 本段在模板字符串里：注释与代码一律禁反引号。
	 */
	function patchTile(el, s) {
		if (s.status) {
			var dot = el.querySelector('.sv-dot');
			if (dot) {
				dot.className = 'sv-dot' + (s.status === 'running' ? ' sv-dot-running' : (s.status === 'awaiting' ? ' sv-dot-awaiting' : ''));
				dot.setAttribute('title', RING_LABEL[s.status] || '空闲');
			}
			el.setAttribute('data-status', s.status);
			var st = el.querySelector('.sv-tile-status');
			if (st) {
				st.className = 'sv-tile-status sv-tile-status-' + s.status;
				st.textContent = s.status === 'running' ? '运行中' : (s.status === 'awaiting' ? '等你回答' : '空闲');
			}
		}
		if (typeof s.time === 'string' && s.time) {
			var timeEl = el.querySelector('.sv-tile-time');
			if (timeEl) { timeEl.textContent = s.time; }
		}
		if (typeof s.title === 'string' && s.title) {
			var titleEl = el.querySelector('.sv-tile-title');
			if (titleEl && titleEl.textContent !== s.title) { titleEl.textContent = s.title; }
		}
	}

	function pollLive() {
		if (!liveApi || document.hidden) { return; }
		var ids = Array.prototype.map.call(
			document.querySelectorAll('.sv-item[data-session-id], .sv-tile[data-session-id]'),
			function (el) { return el.getAttribute('data-session-id'); },
		).filter(Boolean);
		if (!ids.length) { return; }
		fetch(liveApi + '?ids=' + encodeURIComponent(ids.join(',')), { credentials: 'same-origin' })
			.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
			.then(function (data) {
				var list = data && Array.isArray(data.sessions) ? data.sessions : [];
				list.forEach(function (s) {
					if (!s || !s.id) { return; }
					var el = document.querySelector('.sv-item[data-session-id="' + s.id + '"]');
					if (el) { patchRow(el, s); }
					// ★ 稿 C（2026-10-21）：磁贴也要跟着刷新（状态灯 / 状态文案 / 时间 / 标题）
					//   —— 磁贴视图里**没有**列表行可打补丁，不补这一段就等于「磁贴永远显示打开那一刻的状态」✗。
					var tile = document.querySelector('.sv-tile[data-session-id="' + s.id + '"]');
					if (tile) { patchTile(tile, s); }
				});
				syncGroupCounts();
			})
			.catch(function () { /* 网络抖动：下一轮再试，不打扰用户 */ });
	}

	if (liveApi) {
		liveTimer = window.setInterval(pollLive, 2000);
		document.addEventListener('visibilitychange', function () {
			if (document.hidden) {
				if (liveTimer) { window.clearInterval(liveTimer); liveTimer = null; }
				return;
			}
			// 切回前台：**立刻**校准一次（别让用户先看见最多 2s 的旧状态），再把表挂回去。
			pollLive();
			if (!liveTimer) { liveTimer = window.setInterval(pollLive, 2000); }
		});
		window.setTimeout(pollLive, 600);
	}
	// ★★ 2026-10-19（用户要求）：pin / 最近使用改成**服务端真源** prefs.json
	//   （dshHome/storages/vssaros-sessions/prefs.json）—— 跨窗口、换设备一致 ✓
	//   ⚠ 本段在模板字符串里：注释与代码一律禁止出现反引号（截断模板 ⇒ 整文件语法错，已踩过多次）
	//   从前是 localStorage：WebContents 分区级 ⇒ 另一个窗口根本看不到，清缓存就丢 ✗
	//   写入走 POST api/prefs（服务端原子写）；失败**回滚**并提示（不假装成功 ✗）。
	var groupsEl = document.querySelector('.sv-groups');
	var prefsApi = groupsEl ? (groupsEl.getAttribute('data-prefs-api') || '') : '';
	var prefsState = (function () {
		try {
			var o = JSON.parse((groupsEl && groupsEl.getAttribute('data-prefs')) || '{}');
			return { pinned: Array.isArray(o.pinned) ? o.pinned : [], recent: Array.isArray(o.recent) ? o.recent : [] };
		} catch (e) { return { pinned: [], recent: [] }; }
	})();
	function postPrefs(body) {
		if (!prefsApi) { return Promise.reject(new Error('no prefs api')); }
		return fetch(prefsApi, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}).then(function (r) {
			return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
		}).then(function (data) {
			return (data && data.prefs) ? data.prefs : {};
		});
	}
	// 组内排序：固定的在前（按 prefs 顺序），其次"最近用过"的，其余保持服务端顺序
	function reorder() {
		var pinList = prefsState.pinned;
		var recentList = prefsState.recent;
		function rankOf(id) {
			var p = pinList.indexOf(id);
			if (p >= 0) { return p; }
			var r = recentList.indexOf(id);
			return 10000 + (r >= 0 ? r : 9999);
		}
		Array.prototype.forEach.call(document.querySelectorAll('.sv-group'), function (group) {
			var wrap = group.querySelector('.sv-items');
			if (!wrap) { return; }
			var items = Array.prototype.slice.call(wrap.querySelectorAll('.sv-item'));
			items.sort(function (a, b) {
				return rankOf(a.getAttribute('data-session-id')) - rankOf(b.getAttribute('data-session-id'));
			});
			// ★ 2026-10-19（用户报障「展开其余」跑到了组头下面）：.sv-more 也是 .sv-items 的子节点，
			//   直接 appendChild(item) 会把所有行排到它**后面** ⇒ 「展开其余 N 条」被顶到列表最上面 ✗。
			//   ⇒ 行一律插到 .sv-more **之前**（没有它才 append）。
			var more = wrap.querySelector('.sv-more');
			items.forEach(function (el) {
				if (more) { wrap.insertBefore(el, more); } else { wrap.appendChild(el); }
			});
			// 固定的**不受 5 条配额折叠**（埋起来就失去了固定的意义）
			items.forEach(function (el) {
				if (pinList.indexOf(el.getAttribute('data-session-id')) >= 0) { el.removeAttribute('hidden'); }
			});
		});
	}
	// 固定星由服务端渲染（初始态来自 prefs）⇒ 这里只绑事件、就地改星
	Array.prototype.forEach.call(document.querySelectorAll('.sv-item[data-session-id]'), function (el) {
		var id = el.getAttribute('data-session-id');
		var pin = el.querySelector('.sv-pin');
		if (!id || !pin) { return; }
		function isOn() { return prefsState.pinned.indexOf(id) >= 0; }
		function paint() {
			pin.setAttribute('data-pin', isOn() ? '1' : '0');
			pin.textContent = isOn() ? '📌' : '☆';
		}
		function toggle() {
			var before = prefsState.pinned.slice();
			prefsState.pinned = isOn()
				? prefsState.pinned.filter(function (x) { return x !== id; })
				: [id].concat(prefsState.pinned);
			paint(); reorder();
			postPrefs({ togglePin: id }).then(function (p) {
				if (p && Array.isArray(p.pinned)) { prefsState.pinned = p.pinned; paint(); reorder(); }
			}).catch(function () {
				prefsState.pinned = before; paint(); reorder();
				tell('固定状态保存失败（prefs.json 写不进）');
			});
		}
		// ★ 必须阻止冒泡：行本身是"点开会话"，固定按钮不能顺带把会话打开 ✗
		pin.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
		pin.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); } });
	});
	reorder();

	// ★★ 键盘导航（用户要求）：↑↓ 选、Enter 打开、Space 展开详情、Esc 清焦点。
	//   列表容器带 tabindex=0；输入框里不抢键。
	var kbdIndex = -1;
	function kbdItems() {
		return Array.prototype.filter.call(document.querySelectorAll('.sv-item[data-session-id]'), function (el) {
			return !el.hasAttribute('hidden');
		});
	}
	function paintKbd() {
		Array.prototype.forEach.call(kbdItems(), function (el, i) { el.classList.toggle('is-kbd', i === kbdIndex); });
	}
	if (groupsEl) {
		groupsEl.addEventListener('keydown', function (e) {
			var tag = (e.target && e.target.tagName) || '';
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { return; }
			var items = kbdItems();
			if (!items.length) { return; }
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				kbdIndex = e.key === 'ArrowDown'
					? Math.min(items.length - 1, kbdIndex + 1)
					: Math.max(0, kbdIndex - 1);
				paintKbd();
				items[kbdIndex].scrollIntoView({ block: 'nearest' });
			} else if (e.key === 'Enter') {
				if (kbdIndex >= 0 && items[kbdIndex]) { e.preventDefault(); items[kbdIndex].click(); }
			} else if (e.key === ' ') {
				if (kbdIndex >= 0 && items[kbdIndex]) {
					e.preventDefault();
					var arrow = items[kbdIndex].querySelector('.sv-arrow');
					if (arrow) { arrow.click(); }
				}
			} else if (e.key === 'Escape') {
				kbdIndex = -1; paintKbd();
			}
		});
	}

	/**
	 * 就地重命名：把标题换成输入框（回车保存 / Esc 取消 / 失焦按取消处理 ——
	 * 不做"点别处也算保存"，避免用户以为改成功了其实没有）。
	 * ⚠ 本段在**模板字符串**里：注释与代码一律禁反引号。
	 */
	function startRename(el) {
		var id = el.getAttribute('data-session-id');
		var titleEl = el.querySelector('.sv-title');
		if (!id || !titleEl || el.querySelector('.sv-rename')) { return; }
		var prevText = titleEl.textContent;
		var input = document.createElement('input');
		input.className = 'sv-rename';
		input.type = 'text';
		input.value = el.getAttribute('data-title') || '';
		input.setAttribute('placeholder', '输入新标题，回车保存（Esc 取消）');
		input.setAttribute('maxlength', '120');
		titleEl.replaceWith(input);
		input.focus();
		input.select();
		var done = false;
		function finish(save) {
			if (done) { return; }
			done = true;
			var next = String(input.value || '').trim();
			if (!save || !next || next === (el.getAttribute('data-title') || '')) {
				input.replaceWith(titleEl);
				return;
			}
			commitRename(el, titleEl, next, prevText);
		}
		input.addEventListener('keydown', function (e) {
			e.stopPropagation();   // 别让 ↑↓ / Enter 被键盘导航抢走
			if (e.key === 'Enter') { e.preventDefault(); finish(true); }
			else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
		});
		input.addEventListener('blur', function () { finish(false); });
		input.addEventListener('click', function (e) { e.stopPropagation(); });
		input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
	}

	/** 提交改名：先乐观显示，再用**服务端真值**确认（失败回滚 + 如实提示，绝不假成功）。 */
	function commitRename(el, titleEl, next, prevText) {
		var id = el.getAttribute('data-session-id') || '';
		var input = el.querySelector('.sv-rename');
		if (input) { input.replaceWith(titleEl); }
		var b = bridge();
		if (!b || typeof b.renameSession !== 'function') {
			titleEl.textContent = prevText;
			tell('当前宿主不支持重命名会话（页面桥过旧，需要 14+）');
			return;
		}
		titleEl.textContent = next;
		el.setAttribute('data-title', next);
		el.classList.add('is-renaming');
		titleEl.setAttribute('title', '正在同步改名…');
		try {
			b.renameSession(id, next, {
				agentPreset: el.getAttribute('data-preset') || undefined,
				cwd: el.getAttribute('data-cwd') || undefined,
			});
		} catch (err) {
			titleEl.textContent = prevText;
			el.setAttribute('data-title', '');
			el.classList.remove('is-renaming');
			titleEl.removeAttribute('title');
			tell('重命名请求没发出去：' + String((err && err.message) || err));
			return;
		}
		confirmRename(el, titleEl, id, next, prevText);
	}

	/** 回读 api/sessions（服务端真值）确认改名落地；10 次 × 500ms 仍未变 ⇒ 回滚 + 提示。 */
	function confirmRename(el, titleEl, id, next, prevText) {
		var api = groupsEl ? (groupsEl.getAttribute('data-sessions-api') || '') : '';
		var tries = 0;
		function titleFrom(data) {
			var groups = (data && Array.isArray(data.groups)) ? data.groups : [];
			for (var i = 0; i < groups.length; i++) {
				var rows = Array.isArray(groups[i].sessions) ? groups[i].sessions : [];
				for (var j = 0; j < rows.length; j++) {
					if (rows[j] && rows[j].id === id) { return rows[j].title || ''; }
				}
			}
			return null;
		}
		function fail() {
			titleEl.textContent = prevText;
			el.classList.remove('is-renaming');
			titleEl.removeAttribute('title');
			tell('重命名没有生效：宿主没有确认这次改名');
		}
		if (!api) { fail(); return; }
		function tick() {
			tries += 1;
			if (tries > 10) { fail(); return; }
			fetch(api, { credentials: 'same-origin' })
				.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
				.then(function (data) {
					if (titleFrom(data) === next) {
						el.classList.remove('is-renaming');
						titleEl.removeAttribute('title');
						return;
					}
					window.setTimeout(tick, 500);
				})
				.catch(function () { window.setTimeout(tick, 500); });
		}
		window.setTimeout(tick, 500);
	}

	// ★★ 右键菜单（用户要求）：打开 / 重命名 / 固定·取消固定 / 复制会话 id。
	//   插件页里没有 IDE 的 contextMenuService ⇒ 自绘（fixed 定位；点外部或 Esc 关闭）。
	var ctxMenu = null;
	function closeCtx() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
	function openCtx(el, x, y) {
		closeCtx();
		var id = el.getAttribute('data-session-id') || '';
		var on = prefsState.pinned.indexOf(id) >= 0;
		var menu = document.createElement('div');
		menu.className = 'sv-ctx';
		menu.style.left = x + 'px';
		menu.style.top = y + 'px';
		function item(label, fn) {
			var it = document.createElement('div');
			it.className = 'sv-ctx-item';
			it.textContent = label;
			it.addEventListener('click', function (e) { e.stopPropagation(); closeCtx(); fn(); });
			menu.appendChild(it);
		}
		item('打开会话', function () { el.click(); });
		// ★ 2026-10-19（用户要求）：重命名会话 —— 就地输入，回车保存、Esc 取消。
		//   改名只能由**聊天页**做（dsh 的 ctx.sessions.rename 在客户端）⇒ 走桥交宿主转交；
		//   成败以**服务端真值**为准（回读 api/sessions 确认），绝不"点了就显示成功" ✗。
		item('重命名会话…', function () { startRename(el); });
		item(on ? '取消固定' : '固定会话', function () {
			var p = el.querySelector('.sv-pin');
			if (p) { p.click(); }
		});
		item('复制会话 id', function () {
			var done = function () { tell('已复制会话 id'); };
			var fail = function () { tell('复制失败（剪贴板不可用）'); };
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(id).then(done, fail);
					return;
				}
			} catch (e) { /* 落到下面统一报失败 */ }
			fail();
		});
		document.body.appendChild(menu);
		ctxMenu = menu;
		// 贴边修正：菜单不许跑出可视区（超出就向左/向上翻）
		var r = menu.getBoundingClientRect();
		if (r.right > window.innerWidth) { menu.style.left = Math.max(0, window.innerWidth - r.width - 4) + 'px'; }
		if (r.bottom > window.innerHeight) { menu.style.top = Math.max(0, window.innerHeight - r.height - 4) + 'px'; }
	}
	document.addEventListener('click', closeCtx);
	document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeCtx(); } });
	Array.prototype.forEach.call(document.querySelectorAll('.sv-item[data-session-id]'), function (el) {
		el.addEventListener('contextmenu', function (e) {
			e.preventDefault();
			e.stopPropagation();
			openCtx(el, e.clientX, e.clientY);
		});
	});
})();
`;

/** 页面专属 CSS（外壳样式在 pageShell.js；这里只加本页独有的：分组头 / 人格 / 状态点 / 配额行）。 */
const PAGE_CSS = `
.sv-groups { flex: 1; overflow-y: auto; }
.sv-group { border-bottom: 1px solid var(--vscode-sideBar-border, rgba(128,128,128,.25)); }
.sv-group:last-child { border-bottom: none; }
/* ★★ 2026-10-19（用户第二次报障「工作区 item 和会话 item 有重叠」，截图实证）：
   组头是 sticky（top:0），滚动时下面的会话行**必然**从它身上经过 —— 而它原来的底色只有
   --vscode-sideBarSectionHeader-background 一层，在真实主题里是**半透明/全透明** ⇒ 行标题从组头里透出来，
   看起来就是"两块 item 叠在一起"（实测：滚 14px 后第一行标题正好压在组头下沿 ✓）。
   修法：先铺一层**与页面同色的实心底**，再把 section-header 的色作为**叠加层**（渐变当地色用），
   这样主题变量缺失 / 半透明都不会露底；hover 只换那个叠加层的颜色（绝不写 background 简写，
   否则又会把 background-image 重置掉 ⇒ 悬停时重新透底 ✗）。
   ⚠ 本段在模板字符串里：注释里不许出现反引号。 */
.sv-group-header { display: flex; align-items: center; gap: 6px; padding: 5px 8px; min-height: 26px;
	cursor: pointer; position: sticky; top: 0; z-index: 2; user-select: none;
	--sv-head-tint: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,.12));
	background-color: var(--vscode-sideBar-background, #1e1e1e);
	background-image: linear-gradient(var(--sv-head-tint), var(--sv-head-tint)); }
.sv-group-header:hover { --sv-head-tint: var(--vscode-list-hoverBackground, rgba(128,128,128,.2)); }
.sv-chev { width: 12px; font-size: 9px; text-align: center; flex-shrink: 0; color: var(--vscode-descriptionForeground, #999); }
/* ★ 2026-10-19（同一句报障的**另一半**，别和上面那条混为一谈）：组头是 flex 行，
   长路径必须能被压缩 + 省略（缺 min-width:0 时 flex 子项不肯缩 ⇒ 路径文本压在组名上 ✗）。
   ⚠ 但它治不了"会话行从组头里透出来"——那条的真因是 sticky 组头底色半透明，见上面那条注释。 */
.sv-group-name { font-size: 11.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; max-width: 60%; }
.sv-group-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sv-group-path { font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); white-space: nowrap;
	overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; min-width: 0; }
.sv-group-meta { margin-left: auto; display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
/* ★ 2026-10-19（用户要求）：多根工作区的「N 根」徽标 —— 显示**根的数量**，
   hover 时由脚本弹出下面那个浮层（title 只作无脚本兜底）。
   组头副文本仍然只放主根（否则窄侧栏会被整串路径挤成一坨 ✗，见上一轮报障）。 */
.sv-group-roots { flex: 0 0 auto; font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 7px;
	cursor: help; white-space: nowrap;
	border: 1px solid var(--vscode-badge-background, rgba(128,128,128,.45)); color: var(--vscode-descriptionForeground, #bbb); }
.sv-group-roots:hover, .sv-group-roots:focus { border-color: var(--vscode-focusBorder, #3794ff); color: var(--vscode-foreground, #ccc); }
/* 多根详情浮层：脚本建、position: fixed 挂 body ⇒ 不会被滚动容器 / overflow 裁掉 ✓
   （pointer-events: none：不抢鼠标，避免 hovering 时抖动） */
.sv-roots-pop { position: fixed; z-index: 70; max-width: min(520px, 92vw);
	padding: 6px 8px; border-radius: 6px; font-size: 11px; line-height: 16px; pointer-events: none;
	background-color: var(--vscode-sideBar-background, #252526);
	background-image: linear-gradient(var(--vscode-editorHoverWidget-background, #252526), var(--vscode-editorHoverWidget-background, #252526));
	color: var(--vscode-editorHoverWidget-foreground, #ccc);
	border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,.45));
	box-shadow: 0 4px 14px rgba(0, 0, 0, .38); }
.sv-roots-pop .sv-pop-title { color: var(--vscode-descriptionForeground, #9a9a9a); margin-bottom: 4px; }
.sv-roots-pop .sv-pop-row { display: flex; gap: 6px; align-items: baseline; }
.sv-roots-pop .sv-pop-k { flex: 0 0 auto; color: var(--vscode-descriptionForeground, #9a9a9a); }
.sv-roots-pop .sv-pop-v { flex: 1 1 auto; min-width: 0; word-break: break-all;
	font-family: var(--vscode-editor-font-family, Consolas, monospace); }
.sv-group-live { display: flex; align-items: center; gap: 3px; font-size: 10px; color: #3fb950; }
.sv-live-dot { width: 6px; height: 6px; border-radius: 50%; background: #3fb950; }
.sv-group-count { font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 8px;
	background: var(--vscode-badge-background, rgba(128,128,128,.25)); color: var(--vscode-descriptionForeground, #999); }
.sv-group.is-collapsed .sv-items { display: none; }
.sv-group.is-ungrouped .sv-group-name { color: var(--vscode-descriptionForeground, #999); font-weight: 500; }
/* ★★ 2026-10-19（用户改选 **稿 A · 双行紧凑 + 行尾 ⋯**）：
   一条会话 = 左侧 2px 状态竖条 + 两行内容（标题 / preset·时间）+ 右侧操作（固定星 + ⋯）。
   · **无卡片边框**：稿 A 比稿 C 紧凑，一屏多 2~3 条（187 条时这很关键）；
   · 展开时只有淡蓝底（不再画边框 —— 边框会把相邻行割裂，也占掉 2px 高度）；
   · 展开入口是「⋯」（展开后脚本换成「×」）**不是三角形**。
   ⚠ 本段在模板字符串里：注释与规则里禁反引号。 */
.sv-item { display: flex; align-items: flex-start; gap: 7px; flex-wrap: wrap;
	margin: 0; padding: 5px 8px 5px 0; cursor: pointer;
	border: 0; background: transparent; }
/* ★★ 2026-10-19（用户报障「工作区里的会话 item 太多，默认只显示最近 5 个」）：这一行是**必需的**。
   浏览器内置的 [hidden] { display: none } 只是**UA 样式**，作者样式里的 .sv-item { display: flex }
   优先级高于它 ⇒ 光加 hidden 属性**根本没隐藏**：配额（5 条 + 展开其余）与搜索过滤全都静默失效，
   187 条会话一条不落地摊在侧栏里（服务端明明只给 5 条可见、其余带 hidden）。
   ⇒ 不写这一行，"折叠"就永远是纸面上的。 */
.sv-item[hidden] { display: none; }
.sv-item:hover { background: rgba(255, 255, 255, .05); }
/* 展开态：淡蓝底（脚本在 toggleDetail 里加/摘 .open）。稿 A 不用边框 —— 见上面注释。 */
.sv-item.open { background: rgba(55, 148, 255, .07); }
/* 右上操作区（固定星 + 展开入口）：靠右对齐；星常驻，「⋯」只在 hover / 展开 / 键盘选中时显形。 */
.sv-acts { margin-left: auto; flex: 0 0 auto; display: flex; align-items: center; gap: 1px; }
.sv-arrow { width: 18px; height: 18px; line-height: 17px; text-align: center; font-size: 13px;
	flex: 0 0 auto; border-radius: 4px; cursor: pointer; user-select: none;
	color: var(--vscode-descriptionForeground, #999); opacity: 0; }
.sv-item:hover .sv-arrow, .sv-item.open .sv-arrow, .sv-item.is-kbd .sv-arrow, .sv-arrow:focus { opacity: 1; }
/* ⚠ 必须是 flex-basis **0**（不是 auto）：卡片是 flex-wrap:wrap（详情块要换行），
   而换行判定用的是各项的**max-content 假设尺寸** —— 一个长标题的 max-content 会把「固定星 + ⋯」
   挤到**第二行**（实测：标题一长，卡片从 49px 变 98px，右上操作区掉到下一行 ✗）。
   basis 0 ⇒ 假设尺寸为 0，先不换行，再靠 grow 吃掉剩余空间，标题才在**同一行**里省略。 */
.sv-body { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sv-title-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 稿 A 的标题 13px（比稿 C 大 0.5px：无卡片留白后，字要大一点才不显松散） */
.sv-title { font-size: 13px; line-height: 17px; font-weight: 600;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* ★ 2026-10-19（用户要求「增加会话重命名功能」）：就地改名输入框，与标题同字号同行高，
   占满标题那一格的剩余宽度（否则输入框会把行撑开、把副行挤下去）。
   ⚠ 本段在模板字符串里：注释与规则里禁反引号。 */
.sv-rename { flex: 1 1 auto; min-width: 0; font: inherit; font-size: 13px; line-height: 17px;
	padding: 0 4px; margin: -1px 0; border-radius: 3px; outline: none;
	border: 1px solid var(--vscode-focusBorder, #3794ff);
	background: var(--vscode-input-background, rgba(0, 0, 0, .35));
	color: var(--vscode-input-foreground, #ccc); }
.sv-item.is-renaming .sv-title { opacity: .65; font-style: italic; }
.sv-persona { font-size: 10px; line-height: 15px; padding: 0 6px; border-radius: 4px; flex-shrink: 0;
	border: 1px solid rgba(215,165,33,.45); background: rgba(215,165,33,.1); color: #dcb84a;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
.sv-sub-line { display: flex; align-items: center; gap: 6px; font-size: 10px; line-height: 14px;
	color: var(--vscode-descriptionForeground, #999); min-width: 0; }
/* ★ 稿 A 的状态竖条：运行中 = 绿色脉动，等待 = 黄条，空闲 = 灰条。
   类名沿用 sv-dot / sv-dot-running / sv-dot-awaiting（真机探针与既有断言钉着它们），
   这里只换**视觉载体**（环 ⇒ 竖条），不动结构。
   动效尊重 prefers-reduced-motion：关掉脉动仍保留绿色，不丢"运行中"这个事实。 */
.sv-dot { width: 2px; height: 17px; border-radius: 1px; flex: 0 0 2px; box-sizing: border-box;
	margin: 1px 0 0 6px; background: rgba(128, 128, 128, .5); border: 0; }
.sv-dot-running { background: #3fb950; animation: sv-bar-pulse 1.6s ease-in-out infinite; }
.sv-dot-awaiting { background: #d7a521; }
@keyframes sv-bar-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) {
	/* 只停脉动，**保留绿条**：颜色本身就是"进行中"的静态记号 */
	.sv-dot-running { animation: none; opacity: 1; }
}
.sv-preset { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
.sv-preset.sv-unknown { opacity: .6; }
.sv-time { flex-shrink: 0; }
/* （cache/live 标签已按稿 B 删掉：内部术语，对用户无意义。⚠ 模板字符串里不许写反引号） */
.sv-more { padding: 3px 8px 6px 30px; font-size: 11.5px; color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer; user-select: none; }
.sv-more:hover { text-decoration: underline; }
.sv-note { padding: 6px 10px; font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
/* ★ 2026-10-19：会话行可点（= 打开该会话）与「＋ 新建会话」按钮 —— 这页不再是只读列表。 */
.sv-item.is-clickable { cursor: pointer; }
.sv-item.is-clickable:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
/* 「打开会话」的**受理**反馈（2.5s 后由脚本摘掉）：点了立刻有反应，而不是等聊天框那边才看得见。 */
.sv-item.is-opening { opacity: .55; }
.sv-new { margin-left: auto; font-size: 11px; line-height: 18px; padding: 1px 8px; border-radius: 3px; cursor: pointer;
	border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
	color: var(--vscode-button-secondaryForeground, #ccc); }
.sv-new:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.32)); }
/* ★ 2026-10-19（用户要求）：清空历史会话 —— 危险动作，用**次要按钮 + 页面内二次确认**（不阻塞）。
   确认面板带"会影响多少条 / 保留多少条"的数字；.sv-confirm[hidden] 必须**显式**写，
   否则作者样式的 display:flex 会盖掉浏览器内置的 [hidden]{display:none}（本仓踩过 ✗）。
   ⚠ 本段在模板字符串里：注释里禁反引号（本轮又踩了一次 —— 单个反引号会把 CSS 提前闭合，
     后面的 .sv-confirm 被解析成 .sv 减 confirm ⇒ 模块 import 时报 confirm is not defined ✗）。 */
.sv-clear { font-size: 11px; line-height: 18px; padding: 1px 8px; border-radius: 3px; cursor: pointer;
	border: 1px solid var(--vscode-button-border, transparent);
	background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
	color: var(--vscode-button-secondaryForeground, #ccc); }
.sv-clear:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.32)); }
#sv-clear { border-color: rgba(229, 83, 75, .45); color: #e5847c; }
#sv-clear:hover { background: rgba(229, 83, 75, .16); color: #ff9b93; }
.sv-confirm { position: fixed; inset: 0; z-index: 61; display: flex; align-items: center; justify-content: center;
	background: rgba(0, 0, 0, .45); }
.sv-confirm[hidden] { display: none; }
.sv-confirm-card { width: min(380px, 92vw); padding: 12px 14px; border-radius: 8px; font-size: 12px; line-height: 18px;
	background: var(--vscode-editorWidget-background, #252526); color: var(--vscode-foreground, #ccc);
	border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.45)); box-shadow: 0 8px 24px rgba(0,0,0,.45); }
.sv-confirm-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.sv-confirm-text { color: var(--vscode-descriptionForeground, #9a9a9a); }
.sv-confirm-text b { color: var(--vscode-foreground, #ccc); }
.sv-confirm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.sv-btn-danger, .sv-btn-plain { font: inherit; font-size: 11.5px; line-height: 20px; padding: 0 10px; border-radius: 4px; cursor: pointer; }
.sv-btn-danger { border: 1px solid rgba(229, 83, 75, .55); background: rgba(229, 83, 75, .18); color: #ff9b93; }
.sv-btn-danger:hover { background: rgba(229, 83, 75, .3); }
.sv-btn-plain { border: 1px solid var(--vscode-button-border, rgba(128,128,128,.4)); background: transparent; color: var(--vscode-foreground, #ccc); }
.sv-btn-plain:hover { background: rgba(128,128,128,.2); }
/* ★ 2026-10-19（稿 A）：详情块在行内换行（flex-basis:100% + order:9），
   上方一条**实线**把它与行内容分开（稿 A 的写法；虚线在紧凑列表里太碎）。
   ⚠ 本段在模板字符串里：注释里不许出现反引号（截断模板 ⇒ 整文件语法错，已踩过多次）。 */
.sv-arrow:hover { color: var(--vscode-foreground, #ccc); background: rgba(128, 128, 128, .24); }
/* ⚠ 缩进用 **padding** 不用 margin：flex-basis:100% + margin-left 会让详情块比行宽 20px
   （实测右侧越界，浏览器里看不出来但会把行撑出滚动条）。box-sizing:border-box 把它收回来。 */
.sv-detail { flex-basis: 100%; order: 9; box-sizing: border-box; margin: 4px 0 2px; padding: 6px 0 0 15px;
	border-top: 1px solid var(--vscode-widget-border, #454545);
	font-size: 11px; line-height: 16px; color: var(--vscode-descriptionForeground, #999); }
.sv-detail-row { display: flex; gap: 6px; }
.sv-detail .sv-k { flex: 0 0 56px; opacity: .8; }
.sv-detail .sv-v { flex: 1 1 auto; word-break: break-all; color: var(--vscode-foreground, #ccc); }
.sv-detail .sv-mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; }
/* 展开后的用户消息（懒加载）：只显示 user/message，助手回复请点行打开会话看。 */
/* 展开后的全部用户消息：**每条都列**（用户要求）⇒ 条数可能很多，容器限高滚动（不把侧栏撑爆）。 */
.sv-msgs { margin-top: 4px; padding-top: 4px; border-top: 1px dashed var(--vscode-widget-border, #454545);
	display: flex; flex-direction: column; gap: 4px; max-height: 300px; overflow-y: auto; }
.sv-msgs.is-empty { color: var(--vscode-descriptionForeground, #999); font-style: italic; }
.sv-msg { display: flex; flex-direction: column; gap: 1px; }
.sv-msg-t { font-size: 9.5px; opacity: .65; }
.sv-msg-b { white-space: pre-wrap; word-break: break-word; color: var(--vscode-foreground, #ccc); }
.sv-msg-note { font-size: 9.5px; opacity: .55; margin-top: 2px; }
/* 「最近 5 条 + 展开全部」（用户定稿）：条数多时默认折叠，别把侧栏撑高。 */
.sv-msg-more { font-size: 10.5px; color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer; padding: 1px 0; }
.sv-msg-more:hover { text-decoration: underline; }
/* 组头「等你 N」（稿 B）：黄色，与运行中的绿灯区分开。 */
.sv-group-awaiting { font-size: 10px; color: var(--vscode-editorWarning-foreground, #cca700); flex: 0 0 auto; }
/* ★ 2026-10-19（对齐 mockup）：顶部两个**下拉**（展示范围 / 分组方式），原生 details/summary
   —— 无 JS 也能用，点一下就是带参数的新请求。原先四个 chip 并排会把两类语义混成一行 ✗。
   ⚠ 本段在模板字符串里：注释与规则里禁反引号。 */
.sv-dd { position: relative; font-size: 11px; }
.sv-dd > summary { list-style: none; cursor: pointer; padding: 2px 8px; border-radius: 3px; white-space: nowrap;
	color: var(--vscode-foreground, #ccc); background: rgba(128, 128, 128, .18); }
.sv-dd > summary::-webkit-details-marker { display: none; }
.sv-dd > summary:hover { background: rgba(128, 128, 128, .3); }
.sv-dd[open] > summary { outline: 1px solid var(--vscode-focusBorder, #3794ff); }
.sv-dd-items { position: absolute; z-index: 40; left: 0; top: 22px; min-width: 148px; padding: 4px 0;
	background-color: var(--vscode-sideBar-background, #252526);
	background-image: linear-gradient(var(--vscode-menu-background, #252526), var(--vscode-menu-background, #252526));
	border: 1px solid var(--vscode-menu-border, #454545);
	border-radius: 4px; box-shadow: 0 4px 14px rgba(0, 0, 0, .45); }
.sv-dd-item { display: block; padding: 4px 12px; color: var(--vscode-menu-foreground, #ccc); text-decoration: none; white-space: nowrap; }
.sv-dd-item:hover { background: var(--vscode-menu-selectionBackground, #094771); color: var(--vscode-menu-selectionForeground, #fff); }
.sv-dd-item.is-active { font-weight: 600; }
.sv-toolbar-spacer { flex: 1 1 auto; }
/* 诊断行：压成一行，超出省略（细节在 title 里悬停看） */
/* ★ 2026-10-19（清空历史按钮）：诊断行改成 flex —— 左边文字可省略，右边挂「恢复 / 清空」两个小按钮。
   原来 nowrap + ellipsis 会把按钮一起裁掉（按钮是控件，不能被 text-overflow 吃掉 ✗）。
   ⚠ 本段在模板字符串里：注释与规则里禁反引号。 */
.sv-diag { display: flex; align-items: center; gap: 6px; }
.sv-diag-text { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sv-diag-actions { flex: 0 0 auto; display: flex; gap: 4px; }
.sv-diag .sv-clear { font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 8px; }

/* 固定（pin）：行尾那颗星。⚠ 本地偏好（localStorage），不跨视图同步 —— 文案里已写明。 */
.sv-pin { flex: 0 0 auto; font-size: 11px; line-height: 18px; opacity: .55; cursor: pointer; padding: 0 2px; border-radius: 3px; }
.sv-pin:hover { opacity: 1; }
.sv-pin[data-pin="1"] { opacity: 1; }

/* ★ 2026-10-19（用户要求）：键盘导航高亮（↑↓ 选中项）与自绘右键菜单。
   ⚠ 本段在模板字符串里 —— 注释与规则里不许出现反引号。 */
.sv-item.is-kbd { background: var(--vscode-list-inactiveSelectionBackground, rgba(55,148,255,.18));
	outline: 1px solid var(--vscode-focusBorder, #3794ff); outline-offset: -1px; }
.sv-groups:focus { outline: none; }
.sv-ctx { position: fixed; z-index: 99; min-width: 148px; padding: 4px 0;
	background-color: var(--vscode-sideBar-background, #252526);
	background-image: linear-gradient(var(--vscode-menu-background, #252526), var(--vscode-menu-background, #252526));
	border: 1px solid var(--vscode-menu-border, #454545);
	border-radius: 4px; box-shadow: 0 4px 14px rgba(0,0,0,.45); }
.sv-ctx-item { padding: 4px 12px; font-size: 12px; cursor: pointer; color: var(--vscode-menu-foreground, #ccc); white-space: nowrap; }
.sv-ctx-item:hover { background: var(--vscode-menu-selectionBackground, #094771); color: var(--vscode-menu-selectionForeground, #fff); }
/* 分组方式切换（按工作区 / 按 Bot）：链接形态，选中态在 .is-active 上（脚本不参与判定） */
.sv-modes { display: flex; align-items: center; gap: 2px; }
.sv-mode { font-size: 11px; line-height: 18px; padding: 1px 7px; border-radius: 9px; text-decoration: none;
	border: 1px solid transparent; cursor: pointer; color: var(--vscode-descriptionForeground, #999); }
.sv-mode:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.sv-mode.is-active { color: var(--vscode-foreground, #ccc); border-color: var(--vscode-focusBorder, #3794ff);
	background: var(--vscode-badge-background, rgba(128,128,128,.25)); }
`;

/**
 * 稿 C（2026-10-21 用户拍板）：会话磁贴矩阵（dsh desktop 的「多会话窗口」形态）。
 *
 * 为什么磁贴是**网格**而不是多栏并排：上游客户端的会话是**单例选择模型**
 * （`SessionListState.current` 全局只有一个 id）⇒ 一个页面里没法让每块磁贴各绑一条会话的实时流，
 * 磁贴只能「只读地」显示一批会话的状态 ⇒ 压缩成网格（一眼看全）而不是并排的完整聊天窗 ✓。
 *
 * ⚠ 本段在**模板字符串**里：注释与规则里一律禁反引号（写了就把模板截断 ⇒ 整文件语法错 ✗）。
 */
const TILE_CSS = `
.sv-groups.sv-view-tiles { padding: 8px 10px 12px; }
.sv-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(228px, 1fr)); gap: 8px; align-content: start; }
.sv-tile { display: flex; flex-direction: column; gap: 6px; padding: 8px 9px; border-radius: 10px; cursor: pointer;
	border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
	background-color: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); }
/* ⚠ 必须显式写：作者样式的 display:flex 会压掉 UA 的 [hidden]{display:none}
   （列表行已经踩过这个坑：配额与搜索过滤静默失效 ✗）—— 磁贴同样要能真的隐藏。 */
.sv-tile[hidden] { display: none; }
.sv-tile:hover { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.45));
	background-color: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06)); }
.sv-tile.is-opening { opacity: .55; }
.sv-tile.is-pinned { box-shadow: inset 2px 0 0 var(--vscode-textLink-foreground, #3794ff); }
/* 磁贴里的状态灯是**圆点**（列表行是 2px 竖条）—— 类名不变，只换视觉载体 ✓ */
.sv-tile .sv-dot { width: 7px; height: 7px; border-radius: 50%; margin: 0; flex: 0 0 7px; }
.sv-tile-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sv-tile-title { flex: 1 1 0; min-width: 0; font-size: 12.5px; font-weight: 600;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sv-tile-status { flex: 0 0 auto; font-size: 10px; line-height: 15px; padding: 0 6px; border-radius: 8px;
	border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); color: var(--vscode-descriptionForeground, #999); }
.sv-tile-status-running { color: #3fb950; border-color: rgba(63,185,80,.45); }
.sv-tile-status-awaiting { color: var(--vscode-editorWarning-foreground, #cca700); border-color: rgba(204,167,0,.45); }
.sv-tile-preview { font-size: 11.5px; line-height: 16px; color: var(--vscode-descriptionForeground, #999);
	display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 34px; }
.sv-tile-foot { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 10.5px;
	color: var(--vscode-descriptionForeground, #999); flex-wrap: wrap; row-gap: 2px; }
/* 工作区独占一行（磁贴窄，挤在一行里三个字段全是省略号，什么都看不清 ✗） */
.sv-tile-ws { flex: 1 1 100%; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sv-tile-preset, .sv-tile-persona { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .75; }
.sv-tile-time { flex: 0 0 auto; margin-left: auto; }
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
	// ★ 2026-10-19（用户：与 mockup 不一致）：这行从 2 行压成 1 行，细节进 title（悬停看）
	//   —— 它每屏都占两行，信息量却只有"不知道"。
	const text = anyCatalog ? '子智能体：这批会话都没派过' : '子智能体：未知';
	const title = anyCatalog
		? '这批会话的投影里 children 都是空数组 ⇒ 确实没有派过子智能体'
		: '这批会话的投影里没有 subagentCatalog 单元 ⇒ 无法判断有没有子智能体（未知，不当成 0）';
	return `<p class="sv-note sv-sub-unknown" data-vssaros-subagents-empty title="${escapeHtml(title)}">${text}</p>`;
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

/**
 * 当前工作区的根集合（主根在前），来自 foundation 的运行期上下文（宿主推的 `workspace.context`）。
 * ⚠ 它只描述**当前**工作区；其它工作区的历史会话仍按 cwd 各自成组（没有别的数据来源 ⇒ 不猜 ✓）。
 * ★ 2026-10-19：抽成函数是因为**页面和 API 必须用同一份根**（从前只有页面传 ⇒ 多根工作区下
 *   页面是 1 组、API 是 N 组，谁也说不清哪个是真的 ✗）。
 */
function currentWorkspaceRoots() {
	try {
		const f = foundation();
		const v = f && typeof f.workspaceContext === 'function' ? f.workspaceContext() : undefined;
		if (!v || typeof v !== 'object') { return []; }
		const all = [v.workspaceRoot, ...(Array.isArray(v.relatedRoots) ? v.relatedRoots : [])];
		return all.filter(r => typeof r === 'string' && r.trim());
	} catch {
		return [];   // 没绑到 foundation / 从未推过上下文 ⇒ 空数组（退回按 cwd 分组 ✓）
	}
}

/** 页面 + API 共用的一份投影（**不可能出现"页面 3 个、API 5 个"**）。 */
function viewOf(scan, now, groupBy, workspaceRoots = []) {
	const groups = applyPresetNames(buildSessionGroups(scan.rows, { by: groupBy, workspaceRoots }), groupBy, scan.presetNames).map(group => ({
		key: group.key,
		title: group.title,
		path: group.path,
		roots: group.roots,
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

/**
 * 「未命名会话」的标题兜底缓存（sessionId → 首条用户消息）。
 *
 * 为什么缓存：投影没有 title 的会话占绝大多数（300 条里 ~290 条），而首条用户消息**不会变**
 * ⇒ 读一次就够；不缓存会让每次渲染（切分组/搜索）都重复解压日志 ✗。
 */
const FIRST_PROMPT_CACHE = new Map();
const FIRST_PROMPT_CACHE_MAX = 800;

/**
 * 读 JSON 请求体（`api/prefs` 用）。
 * 上限 16 KB；坏 JSON / 超限 ⇒ `undefined`（调用方按"没给"处理，不抛进路由的 catch 里）。
 */
function readJsonBody(req, { maxBytes = 16 * 1024 } = {}) {
	return new Promise(resolve => {
		let size = 0;
		let settled = false;
		const chunks = [];
		const finish = value => {
			if (!settled) { settled = true; resolve(value); }
		};
		req.on('data', chunk => {
			size += chunk.length;
			if (size > maxBytes) { finish(undefined); return; }
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				finish(undefined);
			}
		});
		req.on('error', () => finish(undefined));
	});
}

/**
 * 给"投影没标题"的会话补**首条用户消息**（`prefillFirstPrompts`，2026-10-20 从 `pageHtml` 搬出）。
 *
 * 为什么必须是独立 async 函数：读盘 + 解 zstd 都是阻塞操作，而 dsh Host 是单线程
 * （本仓守卫 `dshPluginPackages.test.ts`「插件不许用同步解压」钉的就是这条）。原来它作为同步
 * IIFE 嵌在 `pageHtml` 里 ⇒ 一次渲染最多 40 条 × 24 帧的同步解压。
 *
 * 口径不变：只处理**没标题**的会话、单次最多 `budget` 条（其余下次渲染继续）、命中进程内缓存则跳过、
 * 读不到就保持"未命名会话"（**不编造** ✗）。传 `scan.rows` 全量即可 —— 多补几条只会进缓存，
 * 下次渲染直接命中；scope 过滤仍在 `pageHtml` 里做（它读 `row.firstPrompt` 这个已填好的字段 ✓）。
 */
async function prefillFirstPrompts(rows, config, { budget = 40 } = {}) {
	let left = budget;
	try {
		const root = path.join(dshHomeOf(config), 'sessions');
		for (const row of rows) {
			if (row.title) { continue; }
			const cached = FIRST_PROMPT_CACHE.get(row.id);
			if (cached !== undefined) { row.firstPrompt = cached; continue; }
			if (left <= 0) { break; }
			left--;
			const prompt = await readFirstPrompt(root, row.id, { maxChars: 40 });
			if (prompt) {
				if (FIRST_PROMPT_CACHE.size > FIRST_PROMPT_CACHE_MAX) { FIRST_PROMPT_CACHE.clear(); }
				FIRST_PROMPT_CACHE.set(row.id, prompt);
				row.firstPrompt = prompt;
			}
		}
	} catch { /* dshHome 读不到 ⇒ 保持"未命名会话"（只影响标题，不该让整页失败 ✗） */ }
}

function pageHtml(scan, config, groupBy, scope = 'all', view = 'list', status = 'all') {
	const now = Date.now();
	const by = normalizeGroupBy(groupBy);
	// ★ 稿 C（2026-10-21 用户拍板）：`view=tiles` = 会话磁贴矩阵
	//（dsh desktop 的「多会话窗口」形态：一眼看到一批会话，点一块换到那条会话）。
	// ⚠ 磁贴与列表**同一批可见行**（下面同一份 visibleRows）⇒ 两个视图看到的会话集合永远一致 ✓。
	const isTiles = view === 'tiles';
	const statusFilter = normalizeStatusFilter(status);
	// ⚠ 渲染必须用**原始会话对象**（`buildSessionGroups(scan.rows)`），**不能**用 API 的 DTO：
	// DTO 把 `turnRunning` / `personaId` 收敛成了 `status` / `persona` 标签，而 `groupHtml` 认的是前者
	// ⇒ 拿 DTO 渲染会得到"运行指示灯不亮、人格标记不出现、配额把运行中的那条也算成空闲"。
	// 2026-10-12 由探针 `poc/dsh-p0/scripts/p3-49-sessions-plugin.mjs` 抓到（纯逻辑/数据路径单测看不见它 ✗）。
	// ★ 2026-10-19（用户报障）：按工作区分组要**支持多根** —— 一个 IDE 工作区可以有主根 + 关联根，
	//   它们的会话必须归到**同一组**（从前只按 cwd ⇒ 被拆成好几块 ✗）。
	//   根集合来自 foundation 的运行期上下文（宿主推的 `workspace.context`）。
	//   ⚠ 它只描述**当前**工作区；其它工作区的历史会话仍按 cwd 各自成组（没有别的数据来源 ⇒ 不猜 ✓）。
	const workspaceRoots = currentWorkspaceRoots();
	// ★ 2026-10-19（稿 B「工作区工作台」）：顶部可选“全部工作区 / 仅当前工作区”。
	//   ⚠ 默认 **全部**：切到“仅当前”会让其它工作区的历史会话从列表里消失（用户会以为丢数据 ✗）。
	const scopedRows = (() => {
		if (scope !== 'current' || workspaceRoots.length === 0) { return scan.rows; }
		const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		const roots = workspaceRoots.map(norm);
		return scan.rows.filter(row => {
			const c = norm(row.cwd || '');
			return !!c && roots.some(n => c === n || c.startsWith(n + '/'));
		});
	})();
	// ★ 2026-10-19（体感最差的一条：300 条里全是"未命名会话"）：投影没标题 ⇒ 用**首条用户消息**当标题。
	// ★ 2026-10-20：这段从 `pageHtml` 里**搬出去**了（`prefillFirstPrompts`，在路由 handler 里
	//   `await` 完再渲染）—— 它要读盘 + 解 zstd，同步做会把 Host 主线程占住（本仓"插件不许同步解压"
	//   的守卫钉的就是这条）。`pageHtml` 现在只看 `row.firstPrompt` 这个已填好的字段 ✓。
	//   · 只补**本次要渲染的**无标题会话，每次最多 40 条（其余下次渲染继续，配合进程内缓存 ✓）
	//   · `readFirstPrompt` 只解前 24 帧 ⇒ 不会为了一个标题把 1.4 MB 日志全解
	//   · 读不到就保持"未命名会话"（不编造 ✗）
	// ★ 2026-10-19（用户要求）：pin / 最近使用落到 `<dshHome>/storages/vssaros-sessions/prefs.json`
	//   —— 跨窗口、换设备一致（localStorage 是 WebContents 分区级的，另一个窗口根本看不到 ✗）。
	//   读坏 / 不存在 ⇒ 空偏好（页面照常工作，只是没有 pin 状态）。
	const prefs = (() => {
		try { return readPrefs(dshHomeOf(config)); } catch { return normalizePrefs(undefined); }
	})();
	const pinnedSet = new Set(prefs.pinned);
	// ★ 2026-10-19（用户要求「清空历史会话」按钮）：**只隐藏、不删数据**（见 core/prefs.js 的注释）。
	//   被隐藏的那批**不进分组**（否则组头计数、配额、展开其余全都不对 ✗）。
	const clearedSplit = filterHiddenByClear(scopedRows, { clearedAt: prefs.clearedAt, pinned: pinnedSet });
	// ★ 2026-10-19（B 方案）：**空白会话默认不显示**（没说过话；官方 `sessionListMetadata.blank`）。
	//   它们是"新建对话"过程的副产品，不是历史；实测本机 1691 条里 1681 条是这种，会把列表占满。
	//   开关在诊断行上（「显示空白会话 N」），偏好落 prefs.showBlank ✓
	const blankRows = prefs.showBlank ? [] : clearedSplit.kept.filter(row => row.blank === true);
	const visibleRows = prefs.showBlank ? clearedSplit.kept : clearedSplit.kept.filter(row => row.blank !== true);
	// 按钮/确认面板要显示的数字：这次清空会影响多少条、又有多少条会被跳过（运行中 / 已固定）。
	// ⚠ 用 **visibleRows**（空白已按开关过滤）而不是 scopedRows：面板上的数字必须与"眼前看到的行"对得上，
	//   否则用户会看到"将隐藏 1681 条"却只列着 10 条（被空白撑大的数字 = 假数字 ✗）。
	const clearSkippedActive = visibleRows.filter(isActiveSession).length;
	const clearSkippedPinned = visibleRows.filter(row => !isActiveSession(row) && pinnedSet.has(row.id)).length;
	const clearableCount = visibleRows.length - clearSkippedActive - clearSkippedPinned;
	const groups = applyPresetNames(buildSessionGroups(visibleRows, { by, workspaceRoots }), by, scan.presetNames);
	// 搜索行走**页面壳自带**的 `.dsh-search` 样式（pageShell.js）—— 与看板 / 工作流页同形，不再内联一份。
	// ★ 2026-10-19（B 方案）：「＋ 新建会话」—— 会话管理不能只有列表。
	//   页面自己开不了编辑器 ⇒ 走桥 `newChat` 交宿主（与 chat-surface header 的那个 ＋ 同一条路 ✓）。
	const newBtn = `<button id="sv-new" class="sv-new" type="button" title="新建一个聊天页签（会话由 VsSaros 宿主在 dsh 侧起）">＋ 新建会话</button>`;
	// ★ 2026-10-19（用户：与 mockup 不一致）：顶部从"两排 chips 挤一起"改成
	//   **两个下拉 + 新建按钮**（mockup 的形态）：
	//     [全部工作区 ▾] [分组：按工作区 ▾]                    [＋ 新建会话]
	//   下拉用原生 `details/summary`（无 JS 也能用，服务端渲染，点一下就是带参数的新请求 ✓）。
	//   之前"全部工作区/当前工作区/按工作区/按 Bot"四个 chip 并排 ⇒ 两类不同语义混在一行，看着像同一组 ✗。
	const scopeLabel = workspaceRoots.length ? workspaceTitleOf(workspaceRoots[0]) : '当前工作区';
	const scopeMenu = `<details class="sv-dd"><summary title="展示范围">`
		+ `${scope === 'current' ? '仅当前工作区' : '全部工作区'} ▾</summary><div class="sv-dd-items">`
		+ `<a class="sv-dd-item${scope === 'all' ? ' is-active' : ''}" href="?view=${view}&scope=all&groupBy=${by}"`
		+ `${scope === 'all' ? ' aria-current="true"' : ''}>全部工作区</a>`
		+ `<a class="sv-dd-item${scope === 'current' ? ' is-active' : ''}" href="?view=${view}&scope=current&groupBy=${by}"`
		+ `${scope === 'current' ? ' aria-current="true"' : ''} title="${escapeHtml(scopeLabel)}（含关联根）">仅当前工作区</a>`
		+ `</div></details>`;
	const modeMenu = `<details class="sv-dd"><summary title="分组方式">分组：${by === 'bot' ? '按 Bot' : '按工作区'} ▾</summary><div class="sv-dd-items">`
		+ SESSION_GROUP_BY.map(key => `<a class="sv-dd-item${key === by ? ' is-active' : ''}" href="?view=${view}&scope=${scope}&groupBy=${key}"`
			+ `${key === by ? ' aria-current="true"' : ''}`
			+ ` title="${key === 'bot' ? '按 Bot（会话跑的 preset）分组' : '按工作区（会话的 cwd）分组'}">${key === 'bot' ? '按 Bot' : '按工作区'}</a>`).join('')
		+ `</div></details>`;
	// ★ 稿 C（2026-10-21 用户拍板）：视图切换（列表 / 磁贴）。**链接带参数**（服务端渲染）⇒ 无 JS 也能切 ✓。
	//   切视图时**保留**工作区范围与分组方式（别把用户的筛选口径悄悄重置 ✗）。
	const viewMenu = `<details class="sv-dd"><summary title="视图">视图：${isTiles ? '磁贴' : '列表'} ▾</summary><div class="sv-dd-items">`
		+ `<a class="sv-dd-item${isTiles ? '' : ' is-active'}" href="?view=list&scope=${scope}&groupBy=${by}&status=${statusFilter}"`
		+ `${isTiles ? '' : ' aria-current="true"'} title="逐条列出会话（窄容器里用它）">列表</a>`
		+ `<a class="sv-dd-item${isTiles ? ' is-active' : ''}" href="?view=tiles&scope=${scope}&groupBy=${by}&status=${statusFilter}"`
		+ `${isTiles ? ' aria-current="true"' : ''} title="会话磁贴矩阵：一眼看到一批会话的状态（dsh desktop 的多会话窗口）">磁贴（多会话窗口）</a>`
		+ `</div></details>`;
	// ★ 稿 C：磁贴视图的状态筛选（全部 / 运行中 / 等你回答 / 空闲）——同样走链接（服务端筛）✓。
	const statusLabels = { all: '全部', running: '运行中', awaiting: '等你回答', idle: '空闲' };
	const statusMenu = `<details class="sv-dd"><summary title="状态筛选">状态：${statusLabels[statusFilter]} ▾</summary><div class="sv-dd-items">`
		+ SESSION_STATUS_FILTERS.map(key => `<a class="sv-dd-item${key === statusFilter ? ' is-active' : ''}" href="?view=${view}&scope=${scope}&groupBy=${by}&status=${key}"`
			+ `${key === statusFilter ? ' aria-current="true"' : ''}>${statusLabels[key]}</a>`).join('')
		+ `</div></details>`;
	// ★ 2026-10-19（用户要求「增加清空历史会话按钮」）：只**隐藏**、不删数据（见 core/prefs.js）。
	//   两个按钮：`清空历史`（danger 二次确认）与 `恢复被清空的 N 条`（仅在清空过时出现 ⇒ 可逆看得见）。
	const clearBtn = `<button id="sv-clear" class="sv-clear" type="button" title="从列表里隐藏历史会话（不会删除数据；运行中 / 等待中 / 已固定的会保留）">清空历史</button>`;
	// 「恢复」的条数要按**当前显示口径**算：空白会话本来就不显示（未开开关），把它们算进
	// "恢复 N 条"会让用户恢复完发现只多了几条（数字与结果对不上 ✗）。
	const restorableCount = clearedSplit.hidden.filter(row => prefs.showBlank || row.blank !== true).length;
	const restoreBtn = prefs.clearedAt
		? `<button id="sv-restore" class="sv-clear" type="button" title="把「清空历史」隐藏的会话重新显示出来">恢复被清空的 ${restorableCount} 条</button>`
		: '';
	// ★ B（2026-10-19）：空白会话开关 —— 默认不显示；打开后连"没说过话"的会话一起列出来。
	//   计数取**当前作用域里真实存在的空白条数**（清空过的那批已经被 clearedAt 挡掉了，不重复计 ✓）。
	const blankBtnId = prefs.showBlank ? 'sv-hide-blank' : 'sv-show-blank';
	const blankBtnLabel = prefs.showBlank ? '隐藏空白会话' : `显示空白会话 ${blankRows.length}`;
	const blankBtn = `<button id="${blankBtnId}" class="sv-clear" type="button" title="${prefs.showBlank ? '不再列出没说过话的空白会话' : '把没说过话的空白会话也列出来（它们只是"新建对话"的副产品）'}">${blankBtnLabel}</button>`;
	// 二次确认**放在页面内**（不用 window.confirm：插件页里它是阻塞模态、样式也不跟主题，
	// 而且我们需要把"会影响多少条 / 保留多少条"这些数字摆在按钮旁边 ✓）。
	const clearPanel = `<div id="sv-clear-panel" class="sv-confirm" hidden>
	<div class="sv-confirm-card" role="dialog" aria-modal="true" aria-labelledby="sv-clear-title">
		<div class="sv-confirm-title" id="sv-clear-title">清空历史会话？</div>
		<div class="sv-confirm-text">将从列表隐藏 <b>${clearableCount}</b> 条历史会话；运行中 / 等待中 <b>${clearSkippedActive}</b> 条与已固定 <b>${clearSkippedPinned}</b> 条会保留。<br>只改列表显示，<b>不会删除</b> dsh 里的会话数据 —— 之后可点「恢复被清空的会话」还原。</div>
		<div class="sv-confirm-actions">
			<button id="sv-clear-yes" class="sv-btn-danger" type="button">清空</button>
			<button id="sv-clear-no" class="sv-btn-plain" type="button">取消</button>
		</div>
	</div>
</div>`;
	// ⚠ 清空 / 恢复**不进工具栏**：320px 侧栏里工具栏会因为多这两个按钮而换行
	//   （实测 27px → 67px，白占一行）⇒ 放在诊断行末尾当小链接（那行本来就是文字，挂两个按钮不多占高）。
	const toolbar = `<div class="dsh-toolbar">${scopeMenu}${modeMenu}${viewMenu}${isTiles ? statusMenu : ''}<span class="sv-toolbar-spacer"></span>${newBtn}</div>`
		+ `<div class="dsh-search"><span class="dsh-search-icon">🔍</span>`
		+ `<input id="sv-search" type="search" placeholder="搜索会话标题 / preset / 人格…"></div>`
		+ clearPanel;
	// ⚠ 这里原来写"只读" —— 加了打开/新建之后就是**假话** ⇒ 必须跟着改（本仓纪律：可见文案描述真发生的事）。
	// ⚠ 2026-10-19（A/B 两个入口消歧）：本页**只看得到 dsh 会话**（数据源是 dsh 的投影缓存）
	//   ⇒ IDE 侧那份（legacy / agentHost 的 claude·copilot / 工作流 / 知识库 / bridge / 手机端会话）
	//   **不在这里** ⇒ 必须写清楚，否则用户会以为"会话少了"。
	// ★ 2026-10-19（用户：与 mockup 不一致）：诊断行从 4 行压成 **1 行**，
	//   细节（live 合并 / 未列出条数 / 读不动的文件 / "仅 dsh"的范围解释）全部进 `title`（悬停看）。
	//   理由：这些是**诊断**信息，不该每屏都占 4 行；而"仅 dsh"已由标题副行说过一次。
	const diagTitle = [
		`投影目录：${scan.dir}`,
		`live 合并 ${scan.live} 行`,
		scan.truncated ? `另有 ${scan.remaining} 条未列出` : '',
		prefs.clearedAt ? `已清空 ${restorableCount} 条历史会话（可点「恢复被清空的会话」还原，数据没有被删除）` : '',
		scan.missing ? '投影缓存目录尚不存在（还没有已投影的会话）' : '',
		scan.errors.length ? `${scan.errors.length} 个文件读不动` : '',
		'这里是唯一的会话历史：IDE 侧的 legacy / agentHost / 工作流会话不经 dsh，因此不在此列',
	].filter(Boolean).join('\n');
	const diag = `<p class="sv-note sv-diag" data-vssaros-sessions-dir="${escapeHtml(scan.dir)}" title="${escapeHtml(diagTitle)}">`
		+ `<span class="sv-diag-text">${visibleRows.length} 个会话 · ${isTiles ? '点一块磁贴打开' : '点一行打开'}`
		+ (scan.truncated ? ` · 另有 ${scan.remaining} 条未列出` : '')
		+ (blankRows.length ? ` · 已隐藏 ${blankRows.length} 条空白会话` : '')
		+ (scan.errors.length ? ` · ${scan.errors.length} 个读不动` : '')
		+ `</span>`
		+ `<span class="sv-diag-actions">${blankBtn}${restoreBtn}${clearBtn}</span>`
		+ `</p>`;
	// ★ 2026-10-19（用户报障「有重复的标题」）：标题只由页面壳（`renderShell` 的 title/subtitle）画一次 ——
	//   这里**不许**再写一个 `<h1>`，否则页面上会出现两行一模一样的标题 ✗。
	// ★ 稿 C（2026-10-21 用户拍板）：磁贴视图 ——
	//   ① **同一批可见行**（同一份 visibleRows ⇒ 同一套清空/空白/工作区口径）⇒ 两个视图看到的会话集合永远一致 ✓；
	//   ② 状态筛选复用列表**同一个** statusOf（core/filterByStatus）⇒ 两处判活不会漂移 ✓；
	//   ③ 排序与列表重排同口径：固定的在前，其次最近用过，其余保持服务端顺序（createdAt 降序）✓。
	const tileRows = filterByStatus(visibleRows, statusFilter);
	const tileOrder = (() => {
		const pinnedOrder = prefs.pinned;
		const recentOrder = prefs.recent;
		function rankOf(id) {
			const p = pinnedOrder.indexOf(id);
			if (p >= 0) { return p; }
			const r = recentOrder.indexOf(id);
			return 10000 + (r >= 0 ? r : 9999);
		}
		return tileRows.slice().sort((a, b) => rankOf(a.id ?? '') - rankOf(b.id ?? ''));
	})();
	// ⚠ 两个视图**共用同一个滚动容器**（.sv-groups）：它身上挂着 data-live-api / data-prefs-api 等
	//   契约属性（页面脚本靠它们轮询与写偏好）⇒ 磁贴视图若另起一个容器 ⇒ 实时状态与 pin 全失效 ✗。
	const groupsBlock = `<div class="sv-groups${isTiles ? ' sv-view-tiles' : ''}" tabindex="0" role="${isTiles ? 'group' : 'listbox'}" aria-label="${isTiles ? '会话磁贴' : '会话列表'}" data-api="${ROUTE_PREFIX}/api/messages"`
		// `data-sessions-api`：改名后回读**服务端真值**用（见 startRename 那一族的注释）
		+ ` data-sessions-api="${ROUTE_PREFIX}/api/sessions"`
		// `data-live-api`：会话执行中的**实时状态**（运行/等待/时间/改名）—— 页面按 2s 轮询打补丁
		+ ` data-live-api="${ROUTE_PREFIX}/api/live"`
		+ ` data-prefs-api="${ROUTE_PREFIX}/api/prefs" data-prefs="${escapeHtml(JSON.stringify({ pinned: prefs.pinned, recent: prefs.recent }))}">`
		+ (isTiles
			? tilesHtml(tileOrder, now, pinnedSet)
			: (groups.length ? groups.map(group => groupHtml(group, now, pinnedSet)).join('\n') : '<p class="sv-note">还没有会话投影（投影缓存为空）。</p>'))
		+ `</div>`;
	const body = toolbar
		+ diag
		// ★ 子智能体明细（2026-10-14 P1 第二块）：放会话组**之前** —— 它是"哪个会话在下崽、下到哪一步了"
		//   的汇总，比逐条会话更适合先看 ✓。
		//   ⚠ 稿 C：磁贴视图**不画**它（磁贴 = 会话总览，子智能体明细是列表视角的补充）⇒
		//   少一个"两处各说各话"的汇总块，但磁贴里的会话仍是同一批 ✓。
		+ (isTiles ? '' : subagentSectionOf(scan.rows))
		+ groupsBlock;
	return renderShell({
		kind: 'sessions',
		// ⚠ 可见文案必须描述**真的发生的事**（本仓纪律）：磁贴视图的标题/副标题按视图改，
		//   不能让用户以为还在看列表 ✗。
		title: isTiles ? '会话磁贴（仅 dsh）' : '历史会话（仅 dsh）',
		// 同上：不再是只读页（点行可打开、顶部可新建）⇒ 副标题不能还写"只读" ✗
		subtitle: isTiles
			? `仅 dsh 会话 · ${statusLabels[statusFilter]} · ${tileRows.length} 块磁贴`
			: '仅 dsh 会话 · 按工作区',
		bodyHtml: body,
		extraCss: PAGE_CSS + SUBAGENT_CSS + TILE_CSS,
		script: PAGE_SCRIPT,
	});
}

/**
 * 测试出口：渲染一张**磁贴页**（稿 C）——给守卫与探针用（与 chat-surface 的 `__test` 同款）。
 *
 * ⚠ 生产路径**不经过**它（生产走 `pageHtml`）——这里只是把**同一批渲染件**（PAGE_CSS / TILE_CSS /
 *   tilesHtml / PAGE_SCRIPT）拼起来，好让探针能**真渲染**一眼（正则断言看不见布局 ✗）。
 */
export function renderTilesPreview(rows, { now = Date.now(), pinned = [] } = {}) {
	const list = Array.isArray(rows) ? rows : [];
	const pinnedSet = new Set(pinned);
	return renderShell({
		kind: 'sessions',
		title: '会话磁贴（仅 dsh）',
		subtitle: `仅 dsh 会话 · 全部 · ${list.length} 块磁贴`,
		bodyHtml: '<div class="dsh-toolbar"><span class="sv-dd"><summary title="视图">视图：磁贴 ▾</summary></span>'
			+ '<span class="sv-toolbar-spacer"></span><button id="sv-new" class="sv-new" type="button">＋ 新建会话</button></div>'
			+ '<div class="dsh-search"><span class="dsh-search-icon">🔍</span>'
			+ '<input id="sv-search" type="search" placeholder="搜索会话标题 / preset / 人格…"></div>'
			+ '<div class="sv-groups sv-view-tiles" tabindex="0" role="group" aria-label="会话磁贴"'
			+ ' data-live-api="/x/sessions/api/live" data-prefs-api="/x/sessions/api/prefs" data-prefs="{}">'
			+ tilesHtml(list, now, pinnedSet)
			+ '</div>',
		extraCss: PAGE_CSS + SUBAGENT_CSS + TILE_CSS,
		script: PAGE_SCRIPT,
	});
}

// ─── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
	// 重构 1.3：绑定 foundation 共享服务（dataRoot/dshHome/pageShell/lock 的真源）。
	{
		// 同步直读在前：有插件在 apply 的**同步段**就建 store（inject 回调是异步的，会来不及 ✗）。
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针的 Proxy 假 ctx 对未知属性抛错 ⇒ 当不存在 */ }
		if (ready) { bindFoundation(ready); }
		ctx.inject(['vssarosFoundation'], child => {
		let svc = null;
		try { svc = child.vssarosFoundation ?? null; } catch { /* 探针的假 ctx（Proxy）对未知属性抛错 ⇒ 当不存在 */ }
		if (svc) { bindFoundation(svc); }
	});
	}
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
				// 稿 B：工作区范围（`all` 默认；`current` = 只看当前 IDE 工作区，含多根）
				const scope = url.searchParams.get('scope') === 'current' ? 'current' : 'all';
				// ★ 稿 C（2026-10-21 用户拍板）：视图（列表 / 磁贴）+ 磁贴的状态筛选。
				//   ⚠ 坏参数一律回默认（不抛错、不空页）—— 磁贴是"看着更方便"，不是"必须"✓。
				const view = url.searchParams.get('view') === 'tiles' ? 'tiles' : 'list';
				const status = normalizeStatusFilter(url.searchParams.get('status'));
				// 程序化消费面（探针 / 对账脚本）：与页面**同一份 collect 与同一份分组**，
				// 不可能出现"页面 3 个、API 5 个"。
				if (url.pathname === `${ROUTE_PREFIX}/api/sessions`) {
					const scan = await collect(config, { limit }, state);
					// ★ 2026-10-19（清空历史会话）：API 必须与页面**同口径**（否则侧栏 / 对账工具会看到
					//   "页面看不到的会话"，两边各说各话 ✗）。
					const apiPrefs = (() => {
						try { return readPrefs(dshHomeOf(config)); } catch { return normalizePrefs(undefined); }
					})();
					const apiCleared = filterHiddenByClear(scan.rows, { clearedAt: apiPrefs.clearedAt, pinned: new Set(apiPrefs.pinned) }).kept;
					const apiScan = {
						...scan,
						// 与页面同口径：清空隐藏的 + 空白会话默认不列（用户开了 showBlank 才给）
						rows: apiPrefs.showBlank ? apiCleared : apiCleared.filter(row => row.blank !== true),
					};
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
						// 清空状态一并暴露：消费方要能区分"本来就没有"和"被用户清空了" ✓
						clearedAt: apiPrefs.clearedAt,
						...viewOf(apiScan, Date.now(), groupBy, currentWorkspaceRoots()),
					}));
					return;
				}
				// ★★ 2026-10-19（用户报「会话执行过程中 sideview 的 item 状态不实时」）：
				//   页面是**服务端渲染一次**的 ⇒ 运行状态环 / 相对时间只反映"打开那一刻"，
				//   会话跑起来也一直显示空闲 ✗。这里给一个**极轻**的实时快照：
				//   只查页面**已经在显示的**那些 id（不读磁盘、不做 300 文件扫描），走
				//   `sessions.get(id)` + `sessionProjections.stateOf` ⇒ 每次毫秒级，2s 轮询无压力。
				//   ⚠ 新增 / 删除的会话**不走这条**：id 集合变了就整页重载（见前端 pollLive 的注释）。
				if (url.pathname === `${ROUTE_PREFIX}/api/live`) {
					const ids = String(url.searchParams.get('ids') ?? '')
						.split(',').map(s => s.trim()).filter(Boolean).slice(0, 500);
					const nowMs = Date.now();
					const rows = ids.map(id => {
						const live = state?.sessions && typeof state.sessions.get === 'function' ? state.sessions.get(id) : undefined;
						if (!live || !state?.projections) {
							return { id, live: false };
						}
						try {
							const fresh = sessionFromCacheRows(
								unit => state.projections.stateOf(live, unit),
								{ id, source: 'live' },
							);
							return {
								id,
								live: true,
								status: statusOf(fresh),
								title: displayTitleOf(fresh),
								preset: fresh.preset,
								time: relativeTime(fresh.createdAt, nowMs),
								blank: fresh.blank,
							};
						} catch {
							return { id, live: false };   // 读活服务出任何差错 ⇒ 如实说"不知道"，不猜空闲
						}
					});
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ now: nowMs, sessions: rows }));
					return;
				}
				// ★ 2026-10-19（用户要求）：展开条目时**懒加载**用户消息（不在首屏读 1436 个日志文件）。
				//   `?id=<sessionId>&limit=5` ⇒ `{ messages: [{time, text}], reason? }`。
				//   读不到就返回 `messages: []` + `reason`（页面如实显示"暂无用户消息"，不编造 ✓）。
				if (url.pathname === `${ROUTE_PREFIX}/api/messages`) {
					const id = String(url.searchParams.get('id') ?? '').trim();
					// ⚠ 默认 **0 = 全部**（2026-10-19 用户要求：展开要看到**每一条**用户输入消息）。
					//   仍接受 `?limit=N` 作上限（大日志/诊断兜底，上限 500）。
					const rawLimit = Number(url.searchParams.get('limit'));
					const msgLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : 0;
					let result = { messages: [], reason: 'no-id' };
					if (id) {
						try {
							result = await readUserMessages(path.join(dshHomeOf(config), 'sessions'), id, { limit: msgLimit });
						} catch (e) {
							result = { messages: [], reason: 'failed: ' + String(e && e.message || e) };
						}
					}
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify(result));
					return;
				}
				// ★ 2026-10-19（用户要求）：pin / 最近使用 / **清空历史**的写入面（POST，服务端原子写 prefs.json）。
				//   body: `{ togglePin?: string, recent?: string, clearHistory?: true, resetClear?: true }`
				//   回执带**最新整份 prefs** ⇒ 页面据此纠正乐观更新（失败时页面自己回滚）。
				//   ⚠ clearHistory 只写 `clearedAt`（**隐藏**，不删文件）：见 core/prefs.js 的语义说明。
				if (url.pathname === `${ROUTE_PREFIX}/api/prefs`) {
					let dshHome = '';
					try {
						dshHome = dshHomeOf(config);
					} catch {
						res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ ok: false, error: 'dshHome 不可用（foundation 未绑定）' }));
						return;
					}
					const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
					const payload = body && typeof body === 'object' ? body : {};
					let cur = readPrefs(dshHome);
					if (typeof payload.togglePin === 'string') { cur = withToggledPin(cur, payload.togglePin); }
					if (typeof payload.recent === 'string') { cur = withRecent(cur, payload.recent); }
					if (payload.clearHistory === true) { cur = withClearedAt(cur); }
					if (payload.resetClear === true) { cur = resetCleared(cur); }
					if (typeof payload.showBlank === 'boolean') { cur = withShowBlank(cur, payload.showBlank); }
					const ok = writePrefs(dshHome, cur);
					res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok, prefs: cur }));
					return;
				}
				const scan = await collect(config, { limit }, state);
				// 补"未命名会话"的标题：读盘 + 解 zstd ⇒ **必须 await**（同步做会占住 Host 主线程）
				await prefillFirstPrompts(scan.rows, config);
				/**
				 * ★★ 必须禁缓存（2026-10-24 实测定位）。
				 *
				 * 症状：服务端已经输出新渲染（组头是「末两段」如 `GR_qiuzijian_main/S1Game`，
				 * 且带「N 根」徽标 —— 我用 cookie 直取 HTML 验证过），但 IDE 左栏 webview
				 * 仍显示旧的短名（`S1Game`），刷新页面、甚至重载窗口都不一定重取。
				 *
				 * ⇒ 左栏是 Electron webview，对服务端渲染的 HTML 缓存比普通标签页顽固得多。
				 *   从服务端禁缓存是唯一可靠的办法，否则每次改渲染都要用户手动清缓存。
				 *
				 * ⚠ 这里只禁 HTML 页面的缓存；JSON API（/api/*）不动 —— 那些是页面自己按需拉的。
				 */
				res.writeHead(200, {
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
					pragma: 'no-cache',
					expires: '0',
				});
				res.end(pageHtml(scan, config, groupBy, scope, view, status));
			} catch (e) {
				res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(`历史会话页面渲染失败：${String(e?.message ?? e)}`);
			}
		},
	})));

	// 重构 4（2026-10-16）：`session_search` 工具——全文检索历史会话（标题 / cwd / 投影文本）。
	// legacy 侧那个是 stub（"还没实现"）；这里实现真的：读投影缓存 + 大小写不敏感匹配。
	// 可选注入 `tools`（只在有工具服务的模板里注册；headless/tui 里没有 ⇒ 只是没这个工具 ✓）。
	// 工具同步注册（与 kanban 同口径：ctx.effect 立即执行 ⇒ REAL-composition boot 后即读得到 ✓；
	// 别用 inject 回调——它是异步的，boot 后立刻读会读不到 ✗，实测踩到）。
	ctx.effect(() => ctx.tools.register({
		name: 'session_search',
		description: '搜索历史会话：按标题与工作区路径做大小写不敏感的全文匹配（投影缓存只有元数据，没有正文 ⇒ 不搜内容，如实说 ✓），返回匹配的会话列表（id / 标题 / 工作区 / 更新时间）。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '搜索关键词（匹配标题 / 路径 / 内容）' },
				limit: { type: 'number', description: '最多返回几条（默认 20，上限 100）' },
			},
			required: ['query'],
		},
		// 官方契约：工具必须声明 output { schema, render }（注册期就拒 ✗——REAL-composition 抓到的 ✓）。
		output: {
			schema: {
				type: 'object',
				properties: {
					query: { type: 'string' },
					count: { type: 'number' },
					sessions: { type: 'array', items: { type: 'object', properties: {
						sessionId: { type: 'string' }, title: { type: 'string' }, cwd: { type: 'string' }, updatedAt: { type: 'string' },
					} } },
				},
			},
			render: (_args, value) => [{ type: 'text', text: `找到 ${value.count} 条匹配「${value.query}」的会话` }],
		},
		async execute(args = {}) {
			const query = String(args.query ?? '').trim();
			if (!query) { throw new Error('query 必填（搜索关键词）'); }
			const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
			const { sessions } = await readSessionCaches(config, { limit: 300 });
			const q = query.toLowerCase();
			const hits = sessions
				.filter(s => {
					// 只匹配元数据（title/cwd）——投影缓存没有正文 ✓（描述里已如实写清）
					const hay = [s.title, s.cwd].filter(Boolean).join('\n').toLowerCase();
					return hay.includes(q);
				})
				.slice(0, limit)
				.map(s => ({ sessionId: s.id, title: s.title ?? '', cwd: s.cwd ?? '', ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}) }));
			return { query, count: hits.length, sessions: hits };
		},
	}));

	// 诊断用：当前数据源可达性（不读盘、不拉服务，只报告注入状态）。
	return { describe: () => ({ route: ROUTE_PREFIX, live: Boolean(state.sessions && state.projections) }) };
}
