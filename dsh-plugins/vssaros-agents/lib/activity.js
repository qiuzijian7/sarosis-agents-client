// @vssaros/dsh-agents —— 「活动」feed（mockup 款 C）与「时间线」（mockup 款 D）的数据构建。
//
// 为什么单独一个文件：这两块是**跨数据源聚合**的视图（委派 / 会话 / 群消息 / 审批 / 记忆提交），
// 逻辑不该塞进页面渲染文件里；纯函数（无 IO）⇒ 探针能直接单测 ✓。
//
// 口径（都取自既有后端，不新造数据面）：
//   委派   = /x/agents/api/assignments 的 items（status: running/done/其它）
//   会话   = sessionRows（id/title/turns/lastActiveAt）
//   群消息 = groups.groups[].transcript（role: user/member；成员回复 ⇒ 「回收回复」）
//   审批   = outbox.entries（status: pending=在途/unknown=结果未知/done=已回收）
//   记忆   = /x/agents/api/memory?agent=… 的 log（Git 提交 = 记忆快照）
//
// ⚠ 本文件含模板串：注释里不许出现反引号（会提前闭合 —— 本仓已踩过）。

/** 截断（超长加省略号）。⚠ 导出（客户端要靠 toString 内联它，见 ACTIVITY_CLIENT_JS）。 */
export function clipText(s, n) {
	const t = String(s ?? '');
	return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 时间标签：今天给 HH:MM，更早给 M/D HH:MM。 */
export function timeLabel(t) {
	const d = new Date(t ?? 0);
	if (!t) { return ''; }
	const p = n => String(n).padStart(2, '0');
	const hhmm = p(d.getHours()) + ':' + p(d.getMinutes());
	const today = new Date();
	if (d.toDateString() === today.toDateString()) { return hhmm; }
	return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm;
}

/** 「多久之前」（粗粒度，够用）。 */
export function agoLabel(t) {
	if (!t) { return '—'; }
	const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
	if (s < 60) { return s + ' 秒前'; }
	if (s < 3600) { return Math.floor(s / 60) + ' 分钟前'; }
	if (s < 86400) { return Math.floor(s / 3600) + ' 小时前'; }
	return Math.floor(s / 86400) + ' 天前';
}

/**
 * 「此刻」feed（款 C）+ 「待你处理」聚合。
 * @returns {{items: Array<{icon:string,text:string,at:number,kind:string}>, todo: {approvals:number, unknown:number, running:number}}}
 */
export function buildActivityItems({ agents, sessionRows, assignments, groups, outbox } = {}) {
	const nameOf = id => (agents ?? []).find(a => a?.id === id)?.name ?? id ?? '';
	const items = [];

	// 委派：创建 / 进行中 / 已回报 / 中断
	for (const r of (assignments?.items ?? [])) {
		const who = r.agentName || nameOf(r.agentId);
		items.push({ icon: '🚀', text: '委派创建：' + clipText(r.task, 60), at: r.createdAt ?? 0, kind: 'assign-created' });
		if (r.status === 'running') {
			items.push({ icon: '⏳', text: who + ' 正在处理「' + clipText(r.task, 40) + '」', at: r.updatedAt ?? r.createdAt ?? 0, kind: 'assign-running' });
		} else if (r.status === 'done') {
			items.push({ icon: '🧭', text: who + ' 回合完成 ⇒ 委派报告已登记', at: r.updatedAt ?? r.createdAt ?? 0, kind: 'assign-done' });
		} else {
			items.push({ icon: '⚠', text: who + ' 的委派中断：' + clipText(r.error || r.status || '未知', 60), at: r.updatedAt ?? r.createdAt ?? 0, kind: 'assign-stopped' });
		}
	}

	// 群聊：用户消息被成员回复 ⇒ 「回收回复」
	for (const g of (groups?.groups ?? [])) {
		const log = Array.isArray(g.transcript) ? g.transcript : [];
		log.forEach((entry, i) => {
			if (entry?.role !== 'user') { return; }
			const replied = log.slice(i + 1).find(e => e?.role === 'member');
			if (!replied) { return; }
			items.push({
				icon: '📥',
				text: '# ' + (g.name ?? '群') + ' 回收 ' + (replied.name || nameOf(replied.agentId) || '成员') + ' 回复',
				at: replied.at ?? entry.at ?? 0,
				kind: 'group-reply',
			});
		});
	}

	// 审批/回传：在途 = 等你处理；unknown = 结果未知（永不自动重发 ✓）
	for (const e of (outbox?.entries ?? [])) {
		if (e.status === 'pending') {
			items.push({ icon: '⏳', text: (e.kind === 'group' ? '群聊回传' : '回传 ' + (e.from || '会话')) + ' ⇒ 等你处理', at: e.sentAt ?? 0, kind: 'approval' });
		} else if (e.status === 'unknown') {
			items.push({ icon: '?', text: '回传结果未知（不会自动重发）· ' + (e.note || e.kind || ''), at: e.sentAt ?? 0, kind: 'unknown' });
		}
	}

	// 会话：有活动 ⇒ 一条。⚠ **限量**（最近 3 条）：会话很多时会刷屏、把委派/群/审批挤掉
	//   （款 C 的 feed 是"混合事件流"，不是会话列表）✗。
	const sessionItems = (sessionRows ?? [])
		.map(r => ({ icon: '💬', text: '会话「' + clipText(r.title || '（未命名会话）', 40) + '」', at: r.lastActiveAt ?? 0, kind: 'session' }))
		.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
		.slice(0, 3);
	for (const it of sessionItems) { items.push(it); }

	items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

	const entries = outbox?.entries ?? [];
	const todo = {
		approvals: entries.filter(e => e.status === 'pending').length,
		unknown: entries.filter(e => e.status === 'unknown').length,
		running: assignments?.running ?? (assignments?.items ?? []).filter(r => r?.status === 'running').length,
	};
	return { items: items.slice(0, 12), todo };
}

/**
 * 时间线（款 D）：**委派 + 会话 + 记忆快照**串成一条线（"这个 agent 最近在干嘛"）。
 * @param {string} agentId 当前聚焦的 agent（记忆快照按它取）
 * @param {Array} memoryLog 该 agent 的记忆 Git 提交（{hash, subject, date}）
 * @returns {Array<{kind:string,st:string,title:string,sub:string,at:number,hash?:string,sessionId?:string}>}
 */
export function buildTimelineItems({ agentId, sessionRows, assignments, groups, memoryLog } = {}) {
	const items = [];

	for (const r of (assignments?.items ?? [])) {
		if (agentId && r.agentId !== agentId) { continue; }
		const running = r.status === 'running';
		items.push({
			kind: 'assign',
			st: running ? 'run' : (r.status === 'done' ? 'done' : 'err'),
			title: '委派「' + clipText(r.task, 50) + '」' + (running ? '运行中' : (r.status === 'done' ? '已回报 ⇒ 报告' : '中断')),
			sub: (timeLabel(r.createdAt) || '—') + (running ? ' 开始 · 追问/中断' : ' · ' + (r.error ? clipText(r.error, 40) : '已完成')),
			at: r.updatedAt ?? r.createdAt ?? 0,
		});
	}

	// 会话：限量最近 5 条（时间线是"精选"，不是会话列表 ⇒ 不限量会被刷屏 ✗）
	const sessionItems = (sessionRows ?? [])
		.map(r => ({
			kind: 'session',
			st: 'done',
			title: '会话「' + clipText(r.title || '（未命名会话）', 50) + '」',
			sub: (timeLabel(r.lastActiveAt) || '—') + ' · ' + (r.turns ?? 0) + ' 回合 · 点击续聊',
			at: r.lastActiveAt ?? 0,
			sessionId: r.id,
		}))
		.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
		.slice(0, 5);
	for (const it of sessionItems) { items.push(it); }

	for (const c of (memoryLog ?? [])) {
		items.push({
			kind: 'memory',
			st: 'done',
			title: '记忆快照 ' + String(c.hash ?? '').slice(0, 7) + '「' + clipText(c.subject, 40) + '」',
			sub: (c.date || timeLabel(c.at)) + ' · 记忆仓库提交',
			at: c.at ?? 0,
			hash: c.hash,
		});
	}

	items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
	return items;
}

/**
 * 客户端内联版：把上面这些**纯函数**用 toString 搬进页面脚本（与 home.js 的 HOME_CLIENT_JS 同套路 ✓）。
 * 页面侧要用它们在**轮询后重建 feed**（不重载整页 ⇒ 活动面板能自己刷新）。
 * ⚠ 被内联的函数只能依赖同批内联的函数（clipText/timeLabel/agoLabel 都在内 ⇒ 名字要对得上 ✓）。
 */
export const ACTIVITY_CLIENT_JS = [clipText, timeLabel, agoLabel, buildActivityItems, buildTimelineItems]
	.map(f => f.toString())
	.join('\n');
