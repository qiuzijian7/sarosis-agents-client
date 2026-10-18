// @vssaros/dsh-agents — Bot 主页（编辑区「概览」签的四块面板，2026-10-16，方案 A 第 2 步）。
//
// doc/agents-botmode-mockup.html 方案 A：编辑区 = 当前 bot 的主页 —— 会话 / Bot 收件箱 / 记忆 / 定时 四块。
// 数据口径（全部**如实**，不造数）：
//   · 会话   = projcache 里该 agent preset 的会话（最近活跃排序）＋ 委派台账里它的委派（需要处理 / 进行中 / 已完成）。
//   · 收件箱 = **只读推导**：派给它的委派 ＋ 它所在群里需要它响应的群消息（open 模式全员 / admin 模式被 @）。
//              DeepSeekBot 那种「接纳层」我们没有 ⇒ 面板标题旁明写「推导自委派台账与群聊」✓。
//   · 记忆   = 异步读 /x/agents/api/memory（文件 + Git 历史；与「记忆」签同一个 API）。
//   · 定时   = 还没有 bot 级定时任务（Q4 未定）⇒ 如实占位，不放假条目 ✗。
//
// ⚠ `homePanelsHtml` / `homeMemoryHtml` 写成**自包含真函数**：服务端首渲直接调用，同时 toString() 内联进
//   页面脚本供换人时重渲 ⇒ 只有一套渲染（之前 hero / 正在做 各写了服务端 + 页面两份，靠人肉对齐 ✗）。
//   函数体里**不许引用本模块的任何变量**，只用 ES2017，不许出现脚本结束标签字面量。

import { presetIdOf } from './core/agents.js';
import { parseMentions } from './groups.js';

const SESSIONS_KEEP = 6;
const INBOX_KEEP = 8;
const DONE_KEEP = 3;

/** 相对时间（渲染时刻的快照口径；与 detail.js 的 agoOf 同口径）。 */
function agoOf(ms) {
	if (!Number.isFinite(ms)) { return ''; }
	const s = Math.floor((Date.now() - ms) / 1000);
	if (s < 60) { return '刚刚'; }
	const m = Math.floor(s / 60);
	if (m < 60) { return m + ' 分钟前'; }
	const h = Math.floor(m / 60);
	if (h < 24) { return h + ' 小时前'; }
	return Math.floor(h / 24) + ' 天前';
}
const fmtTokens = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/** 群消息是否点到了这个 agent：**直接用派发同一个解析器**（groups.js 的 parseMentions）——收件箱必须与真实派发一致，
 *  不能自己再写一份 @ 规则（两份迟早漂移 ✗）。 */
function mentions(text, agent, members, agents) {
	return parseMentions(String(text ?? ''), members, agents).some(x => x.id === agent.id);
}

/**
 * 每个 agent 的主页数据（页面 data-home 里按 agentId 存一份；换人只读这份，不再请求 ✓）。
 * @returns Record<agentId, HomeData>
 */
export function buildHomeData({ agents, sessionRows, assignments, groups }) {
	const out = {};
	const asgItems = assignments?.items ?? [];
	const cap = assignments?.cap ?? 8;
	const runningAll = assignments?.running ?? 0;
	for (const a of agents ?? []) {
		const preset = presetIdOf(a.id);
		const rows = (sessionRows ?? [])
			.filter(r => r && r.presetId === preset)
			.sort((x, y) => (y.lastActiveAt ?? 0) - (x.lastActiveAt ?? 0));
		const mine = asgItems.filter(r => r?.agentId === a.id);
		const attention = mine.filter(r => (r.status !== 'running' && r.status !== 'done') || r.error);
		const running = mine.filter(r => r.status === 'running' && !r.error);
		const done = mine.filter(r => r.status === 'done' && !r.error);
		const inbox = [];
		for (const r of mine) {
			inbox.push({
				icon: '☑',
				title: '委派任务 · 来自 ' + (r.fromSession ? '一条会话' : 'agents 页'),
				sub: clip(r.task, 80),
				st: r.status === 'running' ? 'proc' : (r.status === 'done' ? 'done' : 'att'),
				stText: r.status === 'running' ? '处理中' : (r.status === 'done' ? '已处理' : '已中断'),
				at: r.createdAt ?? null,
			});
		}
		for (const g of groups?.groups ?? []) {
			if (!Array.isArray(g?.members) || !g.members.includes(a.id)) {
				continue;
			}
			const log = Array.isArray(g.transcript) ? g.transcript : [];
			log.forEach((entry, i) => {
				if (entry?.role !== 'user' || !(g.mode === 'open' || mentions(entry.text, a, g.members, agents))) {
					return;
				}
				const replied = log.slice(i + 1).some(e => e?.role === 'member' && e.agentId === a.id);
				inbox.push({
					icon: '#',
					title: g.name + ' · 群消息' + (g.mode === 'open' ? '' : '（@ 了它）'),
					sub: clip(entry.text, 80),
					st: replied ? 'done' : 'pend',
					stText: replied ? '已回复' : '待回复',
					at: entry.at ?? null,
				});
			});
		}
		inbox.sort((x, y) => (y.at ?? 0) - (x.at ?? 0));
		const asgRow = r => ({ id: r.id, task: clip(r.task, 60), ago: agoOf(r.createdAt), error: r.error ? clip(r.error, 80) : '' });
		out[a.id] = {
			agentId: a.id,
			preset,
			cap,
			runningAll,
			sessionsTotal: rows.length,
			sessions: rows.slice(0, SESSIONS_KEEP).map(r => ({ id: r.id, title: clip(r.title || '（未命名会话）', 50), ago: agoOf(r.lastActiveAt), tokens: fmtTokens(r.tokens ?? 0), turns: r.turns ?? 0 })),
			attention: attention.map(asgRow),
			running: running.map(asgRow),
			doneTotal: done.length,
			done: done.slice(0, DONE_KEEP).map(asgRow),
			inboxTotal: inbox.length,
			inboxPending: inbox.filter(x => x.st === 'proc' || x.st === 'pend').length,
			inbox: inbox.slice(0, INBOX_KEEP).map(x => ({ ...x, ago: agoOf(x.at) })),
		};
	}
	return out;
}

/* eslint-disable */
// ↓ 自包含渲染（服务端 + 页面共用；见头注释 ⚠）。
function homePanelsHtml(d, esc) {
	if (!d) { return '<p class="empty">没有这个 agent 的数据。</p>'; }
	var h = '';
	// ① 会话
	h += '<div class="hp" data-home-panel="sessions"><div class="hp-h">◎ 会话 <span class="ct">' + d.sessionsTotal + '</span>'
		+ '<span class="sp"></span><button class="act" onclick="heroChat()" title="给这个 agent 开一段新会话">＋ 新会话</button></div><div class="hp-b">';
	if (d.attention.length) {
		h += '<div class="grp">需要处理</div>';
		for (var i = 0; i < d.attention.length; i++) {
			var a = d.attention[i];
			h += '<div class="it" onclick="showTab(\'assignments\')"><span class="ico">⚑</span><div class="mid">' + esc(a.task)
				+ '<div class="s">' + esc(a.error || '委派已中断') + '</div></div><span class="st att">需要处理</span></div>';
		}
	}
	h += '<div class="grp">进行中 · 并发 ' + d.runningAll + '/' + d.cap + '</div><div class="ovdoing" id="ovDoing">';
	if (d.running.length) {
		for (var j = 0; j < d.running.length; j++) {
			h += '<div class="row2"><span>◐ 委派「' + esc(d.running[j].task) + '」</span><span class="t">' + esc(d.running[j].ago) + ' 开始</span></div>';
		}
	} else {
		h += '<div class="row2 dim">现在没在跑委派</div>';
	}
	h += '</div><div class="grp">最近会话</div>';
	if (d.sessions.length) {
		for (var k = 0; k < d.sessions.length; k++) {
			var s = d.sessions[k];
			h += '<div class="it" data-session-id="' + esc(s.id) + '" onclick="homeOpenSession(this)" title="在右侧 Agent 栏切到这条会话">'
				+ '<span class="ico">💬</span><div class="mid">' + esc(s.title) + '<div class="s">' + esc(s.ago) + ' · ' + s.turns + ' 回合 · ' + esc(s.tokens) + ' token</div></div></div>';
		}
		if (d.sessionsTotal > d.sessions.length) { h += '<div class="more">还有 ' + (d.sessionsTotal - d.sessions.length) + ' 条更早的会话（用量签里看全部）</div>'; }
	} else {
		h += '<div class="it dim"><span class="ico">·</span><div class="mid">还没有会话 —— 点「＋ 新会话」聊第一句</div></div>';
	}
	if (d.done.length) {
		h += '<div class="grp">已完成的委派 · ' + d.doneTotal + '</div>';
		for (var m = 0; m < d.done.length; m++) {
			h += '<div class="it" onclick="showTab(\'assignments\')"><span class="ico">☑</span><div class="mid">' + esc(d.done[m].task)
				+ '<div class="s">' + esc(d.done[m].ago) + '</div></div><span class="st done">完成</span></div>';
		}
	}
	h += '</div></div>';
	// ② Bot 收件箱（只读推导）
	h += '<div class="hp" data-home-panel="inbox"><div class="hp-h">✉ Bot 收件箱 <span class="ct">' + d.inboxPending + '</span>'
		+ '<span class="sp"></span><small>只读 · 推导自委派台账与群聊</small></div><div class="hp-b">';
	if (d.inbox.length) {
		for (var n = 0; n < d.inbox.length; n++) {
			var x = d.inbox[n];
			h += '<div class="it"><span class="ico">' + esc(x.icon) + '</span><div class="mid">' + esc(x.title)
				+ '<div class="s">' + esc(x.sub) + (x.ago ? ' · ' + esc(x.ago) : '') + '</div></div><span class="st ' + esc(x.st) + '">' + esc(x.stText) + '</span></div>';
		}
		if (d.inboxTotal > d.inbox.length) { h += '<div class="more">共 ' + d.inboxTotal + ' 条，只显示最近 ' + d.inbox.length + ' 条</div>'; }
	} else {
		h += '<div class="it dim"><span class="ico">·</span><div class="mid">收件箱是空的：还没有派给它的委派，也没有需要它响应的群消息</div></div>';
	}
	h += '</div></div>';
	// ③ 记忆（异步填充：loadMemory → homeMemoryHtml）
	h += '<div class="hp" data-home-panel="memory"><div class="hp-h">📄 记忆 <span class="ct" id="homeMemCount">…</span>'
		+ '<span class="sp"></span><button class="act" onclick="homeOpenMemory()">打开记忆签</button></div>'
		+ '<div class="hp-b" id="homeMem"><div class="it dim"><span class="ico">·</span><div class="mid">读取中…</div></div></div></div>';
	// ④ 定时任务（如实占位：还没有 bot 级调度）
	h += '<div class="hp" data-home-panel="schedules"><div class="hp-h">⏰ 定时任务 <span class="ct">0</span></div><div class="hp-b">'
		+ '<div class="it dim"><span class="ico">·</span><div class="mid">还没有 bot 级定时任务'
		+ '<div class="s">「每天 21:00 打个招呼」这类任务需要 Host 侧的调度器，还没做；做好之前这里不放假条目。</div></div></div></div></div>';
	return h;
}

function homeMemoryHtml(j, esc) {
	if (!j) { return { html: '<div class="it dim"><span class="ico">·</span><div class="mid">读不到记忆（API 失败）</div></div>', count: '?' }; }
	var files = j.files || [];
	var log = (j.log && j.log.log) || j.log || [];
	if (!Array.isArray(log)) { log = []; }
	var h = '';
	if (files.length) {
		for (var i = 0; i < files.length && i < 6; i++) {
			var f = files[i];
			var kb = f.size >= 1024 ? (f.size / 1024).toFixed(1) + ' KB' : (f.size || 0) + ' B';
			h += '<div class="it" data-mem-file="' + esc(f.name) + '" onclick="homeOpenMemory(this.getAttribute(\'data-mem-file\'))"><span class="ico">📄</span><div class="mid">' + esc(f.name)
				+ (f.name === 'MEMORY.md' ? ' <span class="pin">注入 prompt</span>' : '') + '<div class="s">' + kb + '</div></div></div>';
		}
		if (files.length > 6) { h += '<div class="more">还有 ' + (files.length - 6) + ' 个文件</div>'; }
	} else {
		h += '<div class="it dim"><span class="ico">·</span><div class="mid">还没有记忆文件</div></div>';
	}
	var git = j.git || {};
	h += '<div class="grp">Git 历史' + (git.enabled ? ' · ' + (git.commits || 0) + ' 次提交' : '（未启用）') + '</div>';
	if (git.enabled && log.length) {
		for (var k = 0; k < log.length && k < 3; k++) {
			h += '<div class="it"><span class="ico">⎇</span><div class="mid">' + esc(log[k].subject || '(无说明)') + '<div class="s">' + esc(log[k].hash || '') + ' · ' + esc(log[k].date || '') + '</div></div></div>';
		}
	} else if (!git.enabled) {
		h += '<div class="it dim"><span class="ico">·</span><div class="mid">记忆还没 Git 化 —— 在「记忆」签里可以启用</div></div>';
	}
	return { html: h, count: String(files.length) };
}

// 页面胶水：换人重渲 / 记忆填充 / 切会话 / 跳记忆签。依赖页面主脚本的全局 esc / note / showTab /
// memoryLoad / memoryView / H_AGENT / M_LOADED（同一个 script 标签、同一个全局作用域 ✓）。
function homeClient() {
	window.renderHome = function (agentId) {
		var ov = document.getElementById('overview');
		var grid = document.getElementById('homeGrid');
		if (!ov || !grid) { return; }
		var all = {};
		try { all = JSON.parse(ov.getAttribute('data-home') || '{}'); } catch (e) { all = {}; }
		grid.innerHTML = homePanelsHtml(all[agentId], esc);
	};
	window.homeMemoryFill = function (j) {
		var box = document.getElementById('homeMem');
		if (!box) { return; }
		var r = homeMemoryHtml(j, esc);
		box.innerHTML = r.html;
		var c = document.getElementById('homeMemCount');
		if (c) { c.textContent = r.count; }
	};
	window.homeOpenSession = function (el) {
		var id = el && el.getAttribute ? el.getAttribute('data-session-id') : '';
		var hero = document.getElementById('hero');
		var preset = hero ? hero.getAttribute('data-h-preset') : '';
		var bridge = window.vssarosDsh;
		if (!id) { return; }
		if (!bridge || typeof bridge.openSession !== 'function') { note('当前宿主不支持从这里切会话（需要带 openSession 的宿主）'); return; }
		try { bridge.openSession(id, preset || undefined); note(''); } catch (e) { note('切会话失败：' + e); }
	};
	window.homeOpenMemory = function (file) {
		var sel = document.getElementById('mAgent');
		if (sel && H_AGENT) { sel.value = H_AGENT; }
		var loaded = M_LOADED;
		showTab('memory');
		if (loaded) { memoryLoad(); }
		if (file) { memoryView({ getAttribute: function () { return file; } }); }
	};
}
/* eslint-enable */

export { homePanelsHtml, homeMemoryHtml };

/** 内联进 detail.js 页面脚本的那一段（两个渲染函数原样搬过去 + 胶水立即执行）。 */
export const HOME_CLIENT_JS = homePanelsHtml.toString() + homeMemoryHtml.toString() + '(' + homeClient.toString() + ')();';

export const HOME_CSS = `
/* Bot 主页（方案 A 第 2 步）：概览签 = 身份条 + 四块面板 */
.home-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
@media (max-width: 760px) { .home-grid { grid-template-columns: minmax(0, 1fr); } }
.hp { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 8px; background: rgba(128,128,128,.04); display: flex; flex-direction: column; min-height: 150px; max-height: 340px; overflow: hidden; }
.hp-h { flex: none; height: 30px; display: flex; align-items: center; gap: 6px; padding: 0 9px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); font-size: 12px; font-weight: 600; }
.hp-h .ct { font-weight: 400; font-size: 10px; background: rgba(128,128,128,.2); border-radius: 7px; padding: 0 6px; }
.hp-h .sp { flex: 1; }
.hp-h small { font-weight: 400; font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
.hp-b { flex: 1; min-height: 0; overflow: auto; padding: 4px 6px; }
.hp .grp { font-size: 10px; color: var(--vscode-descriptionForeground, #999); padding: 6px 4px 2px; }
.hp .it { display: flex; gap: 7px; padding: 4px 5px; border-radius: 6px; align-items: flex-start; font-size: 11.5px; }
.hp .it[onclick] { cursor: pointer; }
.hp .it[onclick]:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
.hp .it.dim { color: var(--vscode-descriptionForeground, #999); }
.hp .it .ico { width: 18px; text-align: center; flex: none; }
.hp .it .mid { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.hp .it .s { font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
.hp .st { flex: none; font-size: 9.5px; border-radius: 7px; padding: 0 6px; border: 1px solid var(--vscode-panel-border, #555); white-space: nowrap; }
.hp .st.proc { color: #5b8cff; border-color: #2a3a5c; }
.hp .st.pend { color: #cca700; border-color: #57481f; }
.hp .st.att { color: #f48771; border-color: #5a2f2a; }
.hp .st.done { color: var(--vscode-descriptionForeground, #999); }
.hp .more { font-size: 10px; color: var(--vscode-descriptionForeground, #999); padding: 3px 5px; }
.hp .pin { font-size: 9px; color: #c586c0; border: 1px solid #3d2d4a; border-radius: 6px; padding: 0 4px; margin-left: 4px; }
.hp .ovdoing { padding: 0 5px; }
.idstrip { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 9px; font-size: 11.5px; }
.idstrip .lbl { color: var(--vscode-descriptionForeground, #999); font-size: 10.5px; }`;
