/**
 * `find` op 的**纯逻辑**（2026-10-14，P0-③）：在**已拿到的快照**里按文本/正则检索，
 * 只回命中的那一小撮 —— 不回整棵树。
 *
 * ## 为什么需要它
 *
 * 大页面的 `snapshot` 整页回灌 ⇒ token 成倍放大，而模型多数时候要的只是"那个『关注』按钮在哪"
 * （一行 ref 就够）。调研里 Playwright MCP 的 `browser_find` 正是这条路（返回匹配节点 + 上下文），
 * 这里按同思路做 —— 但**输入是我们自己的快照形状**（`{nodes:[{ref,role,name}], headings, textExcerpt}`），
 * 所以零新增依赖 ✓（也**不改** `browserCdpSnapshot.ts` 真源 ⇒ 不动 `--check` 守卫链 ✓）。
 *
 * ## 边界（刻意的）
 *
 * · 文本匹配**大小写不敏感**（模型不会记大小写，记了也是错配源 ✓）；
 * · `text` 与 `regex` **只能给一个**（两个一起给说不清"以谁为准" ✗ —— 报错，不猜）；
 * · 命中条目上限 `FIND_MAX_HITS`（上限不是"少给"，是"让模型知道还有更多" ⇒ 用 `truncated` 如实说 ✓）；
 * · 这是**读**，不碰页面 ⇒ 不属于动作类（不走审批 ✓），也不改任何 ref ⇒ **旧 ref 不会被它作废** ✓
 *   （这一点很重要：`snapshot` 每次都会清旧 ref 重标 ⇒ 先 `snapshot` 再 `find` 只读同一帧 ✓）。
 */

/** 命中条目上限（ref / 标题 / 正文窗口各自一份）。 */
export const FIND_MAX_HITS = 20;
/** 正文命中时回给的前后窗口（字符）。 */
export const FIND_TEXT_WINDOW = 80;
/** 正文命中最多回几条（多了就是变相回整页 ✗）。 */
export const FIND_MAX_TEXT_HITS = 5;

/**
 * `find` 参数归一 —— **必须先于任何页内调用跑**。
 * 返回 `{ text?, regex?, max }`；坏值一律报错（不猜 ✗）。
 */
export function normalizeFindQuery(params) {
	const text = typeof params?.text === 'string' && params.text.trim() ? params.text.trim() : undefined;
	const regexSrc = typeof params?.regex === 'string' && params.regex.trim() ? params.regex.trim() : undefined;
	if (text !== undefined && regexSrc !== undefined) {
		throw new Error('browser.find 的 `text` 与 `regex` **只能给一个**（两个一起给说不清"以谁为准"）。');
	}
	if (text === undefined && regexSrc === undefined) {
		throw new Error('browser.find 需要 `text`（子串，大小写不敏感）或 `regex`（正则，如 `价格|到手价`）之一。');
	}
	let regex;
	if (regexSrc !== undefined) {
		try {
			regex = new RegExp(regexSrc, 'i');   // 不带 g ⇒ `.test` 是纯函数（无 lastIndex 状态 ✓）
		} catch (e) {
			throw new Error(`browser.find 的 ` + '`regex`' + ` 不是合法正则：${errText(e)}`);
		}
	}
	const raw = params?.max;
	const max = (typeof raw === 'number' && Number.isFinite(raw)) ? Math.min(Math.max(Math.floor(raw), 1), FIND_MAX_HITS) : FIND_MAX_HITS;
	return { text, regex, max };
}

/**
 * 在快照里检索（纯函数 ⇒ 可单测）。
 *
 * @param {object} raw `client.snapshot()` 的原始形状（`nodes/headings/textExcerpt/url/title/truncatedRefs`）
 * @param {ReturnType<typeof normalizeFindQuery>} query 归一后的查询
 */
export function findInSnapshot(raw, query) {
	const test = s => query.regex ? query.regex.test(String(s ?? '')) : String(s ?? '').toLowerCase().includes(query.text.toLowerCase());
	const nodes = [];
	let truncatedNodes = false;
	for (const n of raw?.nodes ?? []) {
		if (nodes.length >= query.max) { truncatedNodes = true; break; }
		if (test(`${n.role} ${n.name}`)) { nodes.push({ ref: n.ref, role: n.role, name: n.name }); }
	}
	const headings = [];
	let truncatedHeadings = false;
	for (const h of raw?.headings ?? []) {
		if (headings.length >= FIND_MAX_HITS) { truncatedHeadings = true; break; }
		if (test(h)) { headings.push(h); }
	}
	// 正文命中：needle 在**正文摘录**里的出现点（±80 字窗口，最多 FIND_MAX_TEXT_HITS 条）
	const textHits = [];
	const excerpt = String(raw?.textExcerpt ?? '');
	const needleLower = query.regex ? undefined : query.text.toLowerCase();
	const excerptLower = excerpt.toLowerCase();
	for (let idx = 0; ; ) {
		let at = -1;
		let len = 0;
		if (query.regex) {
			const m = query.regex.exec(excerpt.slice(idx));
			if (m) { at = idx + m.index; len = m[0].length; }
		} else {
			at = excerptLower.indexOf(needleLower, idx);
			if (at >= 0) { len = needleLower.length; }
		}
		if (at < 0) { break; }
		if (textHits.length >= FIND_MAX_TEXT_HITS) { break; }
		const from = Math.max(0, at - FIND_TEXT_WINDOW);
		const to = Math.min(excerpt.length, at + len + FIND_TEXT_WINDOW);
		textHits.push((from > 0 ? '…' : '') + excerpt.slice(from, to) + (to < excerpt.length ? '…' : ''));
		idx = at + Math.max(len, 1);
	}
	return {
		url: raw?.url, title: raw?.title,
		nodes, headings, textHits,
		truncated: truncatedNodes || truncatedHeadings,
		truncatedRefs: raw?.truncatedRefs === true,
		totalNodes: (raw?.nodes ?? []).length,
	};
}

/** 渲染给模型的文本（纯函数 ⇒ 可单测；**必须如实说"只回了一部分"** ✗）。 */
export function formatFindResult(query, result) {
	const lines = [];
	lines.push(`# find —— ${result.title || '(无标题)'}`);
	lines.push(result.url || '(无 url)');
	lines.push('');
	if (result.nodes.length > 0) {
		lines.push(`## 命中的可交互元素（${result.nodes.length} 条${result.truncated ? '，还有未列出' : ''}）`);
		for (const n of result.nodes) {
			lines.push(`- [${n.ref}] ${n.role} ${n.name}`);
		}
	} else {
		lines.push('## 命中的可交互元素：0 条');
	}
	if (result.headings.length > 0) {
		lines.push('');
		lines.push(`## 命中的标题（${result.headings.length} 条）`);
		for (const h of result.headings) { lines.push(`- ${h}`); }
	}
	if (result.textHits.length > 0) {
		lines.push('');
		lines.push(`## 命中的正文窗口（${result.textHits.length} 条）`);
		for (const t of result.textHits) { lines.push(`- ${t}`); }
	}
	if (result.nodes.length === 0 && result.headings.length === 0 && result.textHits.length === 0) {
		lines.push('');
		lines.push('没命中。换个关键字，或先 `snapshot` 看全貌（`find` 只在**最近一次 snapshot** 的那一帧里找 ✓）。');
	}
	if (result.truncatedRefs) {
		lines.push('');
		lines.push(`⚠ 这一帧的可交互元素超过上限（${FIND_MAX_HITS} 命中条之外，快照本身也只标了前 400 个）⇒ 先缩小页面范围再查。`);
	}
	return lines.join('\n');
}

/** 把底层错误译成一行人话。 */
function errText(e) {
	return String(e instanceof Error ? e.message : e).split('\n')[0];
}
