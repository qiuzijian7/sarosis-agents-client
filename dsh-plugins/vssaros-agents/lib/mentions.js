/**
 * 群聊 `@` 提及 —— **纯函数层**（2026-10-26）。
 *
 * 为什么单独一个文件：这套逻辑要被三处共用（工作台 composer / 独立群聊页 / 服务端派发），
 * 而且全是"字符串 + 光标位置"的计算，**不该依赖 DOM 或 React** ⇒ 可以纯 node 跑单测。
 *
 * 语义移植自 DeepSeekBot 的 `packages/client/src/client/mentions.ts`（同一条规则集）。
 *
 * ★★ 2026-10-26 语义修正（用户报「输入框 @ 时显示的是 slug，要可读名字」）：
 *   原来 token 用 `@` + agent.id（`@code-architect`）—— 理由是 bot 名含空格
 *   （`Code Architect`），怕在空格处断开。但这是**在"靠字符串分词"的前提下的顾虑**；
 *   我们已经随消息发送 `mentions[]{start,end,label,agentId}` 了 ⇒ token 里**可以有空格**，
 *   分词不再必要。
 *   ⇒ 现在：`label` = **显示名**（`@Code Architect`），`agentId` 单独带（`code-architect`）。
 *      · 服务端/渲染都用 `label` 校验 `slice(start,end) === '@'+label`，用 `agentId` 派发
 *      · 反扫（老消息、独立页）**同时**认名字与 id，且**长串优先 + 丢弃重叠**
 *        （否则 `@Code Architect` 会先被 `@Code` 命中，切出一个错的短 token）
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
 * 显示名去歧义（2026-10-26）：名字唯一时就是名字；**同名冲突**时追加 ` · id`。
 *
 * 为什么需要：`@` 候选与成员列表都按显示名渲染，两个 bot 都叫 `Coder` 时会出现
 * 两行一模一样的条目 —— 用户无法选择，看起来就是"重复 bot"。
 *
 * ⚠ 只影响**显示**：插入到输入框里的 token 仍是纯名字，派发靠 `mentions[].agentId`，
 *   所以这个后缀**不会**污染文本、也不会影响后端匹配。
 * ⚠ 也**不动任何数据** —— 重名是可以的，只是要让用户分得清。
 */
export function displayLabels(members) {
	const list = Array.isArray(members) ? members.filter(Boolean) : [];
	const counts = new Map();
	for (const a of list) {
		const key = mentionLabelOf(a).toLocaleLowerCase();
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	const out = new Map();
	for (const a of list) {
		const name = mentionLabelOf(a);
		const dup = (counts.get(name.toLocaleLowerCase()) || 0) > 1;
		out.set(String(a.id), dup ? `${name} · ${String(a.id)}` : name);
	}
	return out;
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
	/* `display` 只给 UI 用（同名时带 ` · id` 后缀）；`agent` 原样带出去，插入时仍用纯名字 */
	const labels = displayLabels(list);
	const bots = list
		.filter((m) => String(m.name || '').toLocaleLowerCase().includes(needle)
			|| String(m.id || '').toLocaleLowerCase().includes(needle))
		.slice(0, MAX_CANDIDATES)
		.map((agent) => ({ kind: 'bot', agent, display: labels.get(String(agent.id)) || mentionLabelOf(agent) }));
	const allNames = [ALL_LABEL, 'all', 'everyone'];
	const offerAll = list.length > 0 && allNames.some((n) => n.toLocaleLowerCase().includes(needle));
	return offerAll ? [{ kind: 'all', label: ALL_LABEL, display: ALL_LABEL }, ...bots] : bots;
}

/** 成员的**显示名**（空则退回 id）：token 里写它，用户看到的就是人话。 */
export function mentionLabelOf(agent) {
	const name = String((agent && agent.name) || '').trim();
	if (name) { return name; }
	return String((agent && agent.id) || '').trim();
}

/**
 * 从**文本**扫出 mentions（同时认「显示名」与「id」，长串优先、丢弃重叠）。
 *
 * 为什么不让 UI 维护 offset：编辑（含输入法上屏、粘贴、撤销）会让手维护的 offset 频繁失效。
 * 返回按 start 升序，`@所有人` 单独用 `kind:'all'` 标记。
 *
 * ⚠ 长串优先是必须的：成员叫 `Code Architect` 时，若先扫 `@Code`（另一个 bot 的名字）
 *   就会把 `@Code Architect` 切成 `@Code` + ` Architect` —— 静默 @ 错人。
 */
export function collectMentions(text, members) {
	const value = String(text == null ? '' : text);
	const out = [];
	const taken = [];
	const needles = [];
	for (const agent of (Array.isArray(members) ? members : [])) {
		const id = String((agent && agent.id) || '').trim();
		if (!id) { continue; }
		const label = mentionLabelOf(agent);
		if (label) { needles.push({ needle: '@' + label, label, agentId: id }); }
		// 兼容旧消息 / 手写 `@id`
		if (label !== id) { needles.push({ needle: '@' + id, label: id, agentId: id }); }
	}
	needles.sort((a, b) => b.needle.length - a.needle.length);
	for (const n of needles) {
		const re = new RegExp(escapeRe(n.needle) + '(?![A-Za-z0-9._-])', 'g');
		let m = re.exec(value);
		while (m) {
			const start = m.index;
			const end = start + n.needle.length;
			if (!taken.some((t) => start < t.end && end > t.start)) {
				taken.push({ start, end });
				out.push({ start, end, label: n.label, agentId: n.agentId });
			}
			m = re.exec(value);
		}
	}
	const allRe = new RegExp('@' + escapeRe(ALL_LABEL) + '(?![A-Za-z0-9._-])', 'g');
	let all = allRe.exec(value);
	while (all) {
		const start = all.index;
		const end = start + all[0].length;
		if (!taken.some((t) => start < t.end && end > t.start)) {
			out.push({ start, end, label: ALL_LABEL, kind: 'all' });
		}
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
