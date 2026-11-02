// @vssaros/dsh-memory — 注入预览的视图模型（记忆工作台 v2 · P3，2026-11-02）。
//
// 回答用户一个此前页面上答不出的问题：**模型此刻到底看到了什么，下次会话会变多少？**
//   · 冻结快照 = 本会话已注入的文本（`state.snapshot.text`，会话内不变，KV 缓存靠它）；
//   · 当前库   = 现在重新装配一遍会得到的文本（不写库、不改快照）；
//   · 两者比对 ⇒ 前缀有多长没变（= 能命中 KV 缓存的部分），变化落在哪一块。
//
// ⚠ 纯函数、零 I/O、零 dsh 依赖 ⇒ 可直接单测。取数由路由层做。
// ⚠ token 估算与引擎 `estimateTokens` 同口径（`ceil(字符/3)`）：页面上的数字要能和引擎的预算对上，
//   但它**只是估算**——页面必须标注，不能让人当成提供方计费的真实 token。

/** 与引擎 `amSchema.estimateTokens` 同口径。 */
export function estimateTokens(text) {
	return Math.ceil(String(text ?? '').length / 3);
}

/**
 * 已知块的起始行 ⇒ 块 id / 名称。
 * 顺序无关；匹配整行（锚定行首）。块标题来自引擎 `buildContext` 与本插件拼装（见 `refreshInto`）。
 * 其它 `## xxx`（比如固定槽位内容里用户自己写的小标题）**不是**块边界，归入当前块。
 */
const BLOCK_MARKERS = Object.freeze([
	{ id: 'slots', name: '固定槽位', re: /^# agentmemory pinned slots\s*$/ },
	{ id: 'profile', name: '项目画像', re: /^## Project Profile\s*$/ },
	{ id: 'lessons', name: '教训', re: /^## Lessons Learned\s*$/ },
	{ id: 'routines', name: '可复用流程', re: /^## Reusable Routines\s*$/ },
	{ id: 'crystals', name: '工作链结晶', re: /^## Recent Workflow Crystals\s*$/ },
	{ id: 'relevant', name: '相关记忆', re: /^## Relevant Memories\s*$/ },
	{ id: 'session', name: '会话块', re: /^## Session \S+ \(/ },
	{ id: 'persona', name: '人设记忆', re: /^## 人设记忆（/ },
	{ id: 'pending', name: '待审提示', re: /^## 待审记忆草稿\s*$/ },
]);

/** 引擎输出外面那层包装，不算块、不计 token（但算字符：它确实在前缀里）。 */
const WRAPPER_RE = /^<\/?agentmemory-context\b/;

/**
 * 把注入文本切成块。
 *
 * 规则：遇到 `BLOCK_MARKERS` 的起始行就开新块；包装标签行跳过（归入 `wrapperChars`）；
 * 其余行归入当前块。**人设记忆**之后的内容整体并入"人设记忆"块（那是另一个分区的完整引擎输出，
 * 里面也有自己的槽位/画像标题——拆开会把同名块算两次），直到遇到"待审提示"。
 *
 * @param {string} text 注入文本
 * @returns {{blocks: Array<{id: string, name: string, start: number, end: number, chars: number, tokens: number, text: string}>, wrapperChars: number, totalChars: number}}
 *   `start/end` 是该块在 `text` 里的字符区间（用来和前缀比对）
 */
export function splitBlocks(text) {
	const src = typeof text === 'string' ? text : '';
	const blocks = [];
	let wrapperChars = 0;
	let cur = null;
	let inPersona = false;
	let offset = 0;
	const close = at => {
		if (!cur) { return; }
		cur.end = at;
		const raw = src.slice(cur.start, at).replace(/\s+$/, '');
		cur.text = raw;
		cur.chars = raw.length;
		cur.tokens = estimateTokens(raw);
		blocks.push(cur);
		cur = null;
	};
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineStart = offset;
		offset += line.length + 1; // +1 = 被 split 吃掉的 '\n'
		if (WRAPPER_RE.test(line)) {
			wrapperChars += line.length + 1;
			continue;
		}
		const marker = BLOCK_MARKERS.find(m => m.re.test(line));
		if (marker && inPersona && marker.id !== 'pending') {
			// 人设分区内部的块：并入人设块，不另开
		} else if (marker) {
			close(lineStart);
			cur = { id: marker.id, name: marker.name, start: lineStart, end: lineStart, chars: 0, tokens: 0, text: '' };
			inPersona = marker.id === 'persona';
			continue;
		}
		if (!cur && line.trim()) {
			// 第一个标记之前就有内容（不认识的头部）⇒ 归为"其它"，不丢
			cur = { id: 'other', name: '其它', start: lineStart, end: lineStart, chars: 0, tokens: 0, text: '' };
		}
	}
	close(Math.min(offset, src.length));
	return { blocks, wrapperChars, totalChars: src.length };
}

/** 最长公共前缀长度（按 UTF-16 码元，和 `String.length` 同口径）。 */
export function commonPrefixLength(a, b) {
	const x = typeof a === 'string' ? a : '';
	const y = typeof b === 'string' ? b : '';
	const n = Math.min(x.length, y.length);
	let i = 0;
	while (i < n && x.charCodeAt(i) === y.charCodeAt(i)) { i++; }
	return i;
}

/**
 * 比对冻结快照与当前库。
 *
 * verdict：
 *  · `identical`      两者逐字节相同
 *  · `append-only`    当前库 = 冻结快照 + 尾部新增（**最好**：旧前缀 100% 命中缓存）
 *  · `tail-changed`   第一处差异落在冻结快照的**最后一块**（典型：待审提示里的计数变了）
 *                     ⇒ 除最后一块外的前缀都能命中缓存
 *  · `prefix-broken`  第一处差异落在更靠前的块 ⇒ 该块之后的所有内容整体位移，缓存从那里起失效
 *  · `unavailable`    某一侧没取到（网关不可达 / 快照为空）⇒ **不下结论**（宁可说"比不了"，不能说"稳定"）
 *
 * @param {string|null} frozen 冻结快照文本（null/'' = 没有）
 * @param {string|null} live 当前库文本（null = 没取到）
 * @returns {{verdict: string, prefixChars: number, frozenChars: number, liveChars: number,
 *   addedChars: number, removedChars: number, brokenAt: string|null, firstDiffAt: number|null}}
 */
export function comparePrefix(frozen, live) {
	if (typeof frozen !== 'string' || typeof live !== 'string' || !frozen) {
		return { verdict: 'unavailable', prefixChars: 0, frozenChars: typeof frozen === 'string' ? frozen.length : 0, liveChars: typeof live === 'string' ? live.length : 0, addedChars: 0, removedChars: 0, brokenAt: null, firstDiffAt: null };
	}
	const prefixChars = commonPrefixLength(frozen, live);
	const base = { prefixChars, frozenChars: frozen.length, liveChars: live.length, addedChars: Math.max(0, live.length - prefixChars), removedChars: Math.max(0, frozen.length - prefixChars) };
	if (frozen === live) {
		return { verdict: 'identical', ...base, addedChars: 0, removedChars: 0, brokenAt: null, firstDiffAt: null };
	}
	if (live.startsWith(frozen)) {
		return { verdict: 'append-only', ...base, removedChars: 0, brokenAt: null, firstDiffAt: frozen.length };
	}
	// 第一处差异落在冻结快照的哪一块？
	const { blocks } = splitBlocks(frozen);
	const hit = blocks.find(b => prefixChars >= b.start && prefixChars < Math.max(b.end, b.start + 1));
	const last = blocks[blocks.length - 1];
	const inLast = !!hit && !!last && hit.start === last.start;
	return { verdict: inLast ? 'tail-changed' : 'prefix-broken', ...base, brokenAt: hit ? hit.name : null, firstDiffAt: prefixChars };
}

/**
 * 给每个块标"相对冻结快照"的状态（页面用颜色区分）：
 *  `same`    整块都在公共前缀里（缓存命中）
 *  `changed` 块被公共前缀的终点切开（这一块从中间开始变）
 *  `new`     整块在公共前缀之外（该块及其后全部缓存失效 / 新追加）
 * @param {ReadonlyArray<{start: number, end: number}>} blocks 当前库的块
 * @param {number} prefixChars 公共前缀长度
 */
export function markBlocks(blocks, prefixChars) {
	return (Array.isArray(blocks) ? blocks : []).map(b => ({
		...b,
		state: b.end <= prefixChars ? 'same' : (b.start >= prefixChars ? 'new' : 'changed'),
	}));
}

/**
 * 组装页面用的完整视图。
 *
 * @param {{frozenText?: string|null, liveText?: string|null, liveError?: string, budgetTokens?: number, charCap?: number}} input
 * @returns {object} `{ budget, frozen, live, diff }`（`live` 取失败时为 null 并带 `liveError`）
 */
export function buildInjectionView(input = {}) {
	const frozenText = typeof input.frozenText === 'string' ? input.frozenText : '';
	const liveText = typeof input.liveText === 'string' ? input.liveText : null;
	const budget = Number.isFinite(input.budgetTokens) && input.budgetTokens > 0 ? Math.floor(input.budgetTokens) : 0;
	const diff = comparePrefix(frozenText || null, liveText);

	const side = (text, markWith) => {
		const { blocks, wrapperChars, totalChars } = splitBlocks(text);
		const tokens = estimateTokens(text);
		return {
			chars: totalChars,
			tokens,
			wrapperChars,
			blocks: markWith === null ? blocks : markBlocks(blocks, markWith),
			// 真正的"超预算"判据：**所有块**合计（包装标签几乎不占）
			pct: budget > 0 ? Math.round((tokens / budget) * 100) : null,
			over: budget > 0 && tokens > budget,
		};
	};
	return {
		budget: { tokens: budget, charCap: Number.isFinite(input.charCap) ? input.charCap : null, estimated: true },
		frozen: frozenText ? side(frozenText, null) : null,
		live: liveText === null ? null : side(liveText, diff.verdict === 'unavailable' ? null : diff.prefixChars),
		liveError: liveText === null ? String(input.liveError ?? '') : '',
		diff,
	};
}
