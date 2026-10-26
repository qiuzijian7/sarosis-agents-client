/**
 * 群聊 `@` 提及 —— **纯函数层**（2026-10-26）。
 *
 * 为什么单独一个文件：这套逻辑要被三处共用（工作台 composer / 独立群聊页 / 服务端派发），
 * 而且全是"字符串 + 光标位置"的计算，**不该依赖 DOM 或 React** ⇒ 可以纯 node 跑单测。
 *
 * 语义移植自 DeepSeekBot 的 `packages/client/src/client/mentions.ts`（同一条规则集），
 * 只做了一处**有意的偏离**：
 *   · 那边 token 是 `@` + displayName；我们**用 `@` + agent.id**。
 *     原因：我们的 bot 名含空格（`Code Architect`），`@Code Architect ` 会在空格处断开，
 *     后端的 `(?![A-Za-z0-9._-])` 边界判断和 `slice(start,end)===@label` 校验都会失效。
 *     id 是 `code-architect` 这种无空格稳定串 ⇒ token 可靠。候选项仍**显示 name**。
 *
 * 关键规则（与参考实现一致，逐条都有对应测试）：
 *   ① `@` 前一个字符若是 `[A-Za-z0-9._%+-]` ⇒ **不触发**（所以 `a@b.com` 不会弹候选）
 *   ② caret 往回 34 字符内找不到 `@` ⇒ 不触发
 *   ③ query 里出现换行 / `@` / `#` ⇒ 放弃（说明用户已经不在写这个 token 了）
 *   ④ 选中后补一个尾随空格，并把 caret 放到空格之后
 *   ⑤ 编辑后老 mention 的 offset 会漂 ⇒ `rebaseMentions` 平移，**文本对不上的直接丢弃**
 *   ⑥ Backspace/Delete 在 token 边缘 ⇒ **整块删除**（不是逐字删）
 */

/** `@所有人` 的显示文案（token 只有这一种写法，含中文也算稳定：无空格）。 */
export const ALL_LABEL = '所有人';

/** 候选最多显示几条（超过就得滚，键盘选也没意义了）。 */
const MAX_CANDIDATES = 8;

/** `@` 与光标的最大距离；超过基本可以认为不是想 @ 人。 */
const MAX_QUERY = 34;

/** 触发 `@` 的"词边界"：`@` 前一字符命中这些就不是 mention（典型是邮箱）。 */
const WORD_BEFORE_AT = /[A-Za-z0-9._%+-]/u;

/** 正则转义（agent.id 里可能有 `.` / `-`）。 */
export function escapeRe(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 当前是否正在输入一个 `@`？返回 `{ start, end, query }` 或 `undefined`。
 *
 * @param {string} value  输入框全文
 * @param {number} caret  光标位置（`selectionStart`）
 */
export function activeMentionQuery(value, caret) {
	const text = String(value == null ? '' : value);
	const pos = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), text.length) : text.length;
	const start = text.lastIndexOf('@', pos - 1);
	if (start < 0 || pos - start > MAX_QUERY) { return undefined; }
	/* ⚠ `lastIndexOf('@', -1)` 在 JS 里等价于从 0 开始找 ⇒ caret=0 时会命中开头的 `@`，
	   返回一个 `{start:0,end:0,query:''}` 的假 query。单测当场抓到（caret 在 @ 之前不该触发）。 */
	if (pos <= start) { return undefined; }
	// ① 词边界：`a@b.com` 里的 `@` 不该弹候选
	if (start > 0 && WORD_BEFORE_AT.test(text[start - 1])) { return undefined; }
	const query = text.slice(start + 1, pos);
	/* ③ query 里出现空白、`@`、`#` 中的任意一个 ⇒ 用户已经不在写这个 token 了。
	   ⚠ 2026-10-26：从"只拦换行"改成"拦全部空白" —— 打 `@ ` 就该立刻关浮层。
	   id 不含空格，所以不会把某个候选锁在半截；名字带空格的 bot 请用 id（见文件头说明）。
	   ⚠ 写注释时别让星号紧挨斜杠，否则会把块注释提前闭合（这里踩过一次）。 */
	if (/[\s@#]/u.test(query)) { return undefined; }
	return { start, end: pos, query };
}

/**
 * 选中一个候选：把 `@query` 这段区间替换成 `@label` + 尾随空格。
 * 返回新文本与**新光标位置**（调用方负责 setSelectionRange）。
 */
export function selectMention(value, query, label) {
	const text = String(value == null ? '' : value);
	const token = '@' + String(label == null ? '' : label);
	/* ④ 选中后**恰好一个**尾随空格：
	   · 原本就有一个 ⇒ 跳过它（不产生两个空格），caret 落到那个空格之后
	   · 原本没有 ⇒ 补一个
	   统一写成「token + ' '」，两种情况 caret 都是 `start + token.length + 1`。 */
	const skip = text[query.end] === ' ' ? 1 : 0;
	const next = text.slice(0, query.start) + token + ' ' + text.slice(query.end + skip);
	return { value: next, caret: query.start + token.length + 1 };
}

/**
 * 编辑后重定位已有 mentions（前缀/后缀 diff 平移），并把**文本已对不上**的丢掉。
 * 为什么需要：用户可能在 token 前面插字，所有 offset 都会整体后移。
 */
export function rebaseMentions(before, after, mentions) {
	const a = String(before == null ? '' : before);
	const b = String(after == null ? '' : after);
	const list = Array.isArray(mentions) ? mentions : [];
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) { prefix += 1; }
	let suffix = 0;
	while (
		suffix < a.length - prefix
		&& suffix < b.length - prefix
		&& a[a.length - suffix - 1] === b[b.length - suffix - 1]
	) { suffix += 1; }
	const oldEnd = a.length - suffix;
	const delta = b.length - a.length;
	return list
		.flatMap((item) => {
			if (item.end <= prefix) { return [item]; }
			if (item.start >= oldEnd) { return [{ ...item, start: item.start + delta, end: item.end + delta }]; }
			return [];
		})
		// ⑤ 文本对不上就丢弃：宁可不高亮，也不要显示成错位的 chip
		.filter((item) => b.slice(item.start, item.end) === '@' + item.label);
}

/**
 * 把文本切成「普通片段 / mention 片段」—— 渲染气泡时用。
 * ⚠ 任何 offset 对不上的 mention 都会被**跳过**（防御脏数据，参考实现同口径）。
 */
export function mentionRuns(value, mentions) {
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
}

/**
 * Backspace / Delete 落在某个 mention 上 ⇒ **整块删除**该 token（含尾随空格）。
 * 返回 `{ value, mentions, caret }`，没有命中返回 `undefined`（让浏览器走默认行为）。
 */
export function deleteSelectedMention(value, mentions, selectionStart, selectionEnd, key) {
	const text = String(value == null ? '' : value);
	const s = Number.isInteger(selectionStart) ? selectionStart : text.length;
	const e = Number.isInteger(selectionEnd) ? selectionEnd : s;
	const list = (Array.isArray(mentions) ? mentions : [])
		.filter((m) => Number.isInteger(m.start) && Number.isInteger(m.end));
	const target = list.find((m) => {
		const trailingEnd = text[m.end] === ' ' ? m.end + 1 : m.end;
		if (s !== e) { return s < trailingEnd && e > m.start; }
		return key === 'Backspace'
			? s > m.start && s <= trailingEnd
			: s >= m.start && s < m.end;
	});
	if (!target) { return undefined; }
	const end = text[target.end] === ' ' ? target.end + 1 : target.end;
	const start = s === e ? target.start : Math.min(s, target.start);
	const finish = s === e ? end : Math.max(e, end);
	const next = text.slice(0, start) + text.slice(finish);
	return { value: next, mentions: rebaseMentions(text, next, list), caret: start };
}

/**
 * 候选列表。`members` 是本群成员（**已按成员表过滤**，调用方负责）。
 * 返回 `[{ kind:'bot', agent }]` 或 `[{ kind:'all', label }]`（`@所有人` 永远排第一）。
 *
 * ⚠ 与参考实现的差异：那边有 `paused` 概念与 `all.preview.recipients`；
 *   我们只需"成员数 > 0"。成员为空时不提供 `@所有人`（没有意义的按钮不该出现）。
 */
export function mentionCandidates(members, query) {
	const list = Array.isArray(members) ? members.filter(Boolean) : [];
	if (query === undefined || query === null) { return []; }
	const needle = String(query).toLocaleLowerCase();
	const bots = list
		.filter((m) => String(m.name || '').toLocaleLowerCase().includes(needle)
			|| String(m.id || '').toLocaleLowerCase().includes(needle))
		.slice(0, MAX_CANDIDATES)
		.map((agent) => ({ kind: 'bot', agent }));
	const allNames = [ALL_LABEL, 'all', 'everyone'];
	const offerAll = list.length > 0 && allNames.some((n) => n.toLocaleLowerCase().includes(needle));
	return offerAll ? [{ kind: 'all', label: ALL_LABEL }, ...bots] : bots;
}

/**
 * 从**文本**扫出 mentions（id 口径 + 词尾边界）。
 *
 * 为什么不让 UI 维护 offset：编辑（含输入法上屏、粘贴、撤销）会让手维护的 offset 频繁失效，
 * 而这套 token 是 `@` + 无空格 id ⇒ **从文本反扫**既准确又永远和显示一致。
 * 返回按 start 升序，`@所有人` 单独用 `kind:'all'` 标记。
 */
export function collectMentions(text, members) {
	const value = String(text == null ? '' : text);
	const out = [];
	for (const agent of (Array.isArray(members) ? members : [])) {
		const id = String(agent && agent.id || '').trim();
		if (!id) { continue; }
		const re = new RegExp('@' + escapeRe(id) + '(?![A-Za-z0-9._-])', 'g');
		let m = re.exec(value);
		while (m) {
			out.push({ start: m.index, end: m.index + m[0].length, label: id, agentId: id });
			m = re.exec(value);
		}
	}
	const allRe = new RegExp('@' + escapeRe(ALL_LABEL) + '(?![A-Za-z0-9._-])', 'g');
	let all = allRe.exec(value);
	while (all) {
		out.push({ start: all.index, end: all.index + all[0].length, label: ALL_LABEL, kind: 'all' });
		all = allRe.exec(value);
	}
	return out.sort((a, b) => a.start - b.start);
}

/** 发送前的收件人：`@所有人` ⇒ 全群；否则只取被 @ 到的 agentId（去重、保序）。 */
export function mentionedAgentIds(text, members) {
	const mentions = collectMentions(text, members);
	if (mentions.some((m) => m.kind === 'all')) {
		return (Array.isArray(members) ? members : []).map((m) => String(m && m.id || '')).filter(Boolean);
	}
	const out = [];
	for (const m of mentions) {
		if (m.agentId && !out.includes(m.agentId)) { out.push(m.agentId); }
	}
	return out;
}
