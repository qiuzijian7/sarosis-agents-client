// @vssaros/dsh-memory — LLM 判定的**纯逻辑**半边（构造 prompt + 容错解析回答）。
//
// 为什么产品形态选"**判定**"而不是"自由摘要"：
//   ① **输入小**：只送候选片段（每条几十字），不送整个会话 ⇒ 成本与**隐私面**都小一个量级 ✓
//      （本插件的隐私默认值一贯是保守的：审计只落 digest + 前 80 字 ✓，同一取向 ✓）；
//   ② **输出结构化**：只要"保留哪些序号"⇒ 不需要解析长文本、不需要二次校验 ✓；
//   ③ **保住草稿语义**：判定的产出**仍然**是草稿（等人提升 ✓），而不是"插件自己写进长期层的记忆" ✓
//      —— 后者正是社区里 `haitang1` 自陈的坏法（"合并长期失败，而插件看起来是健康的"）。
//
// ⚠⚠ **失败必须 fail-open（保留候选）**，这条**不能反**（`parseJudgeReply` 的返回值里带着
// `parseFailed` 就是为了让调用方无法"不小心"把它当"全丢"✓）：
//   · fail-open ⇒ 最坏是草稿里多几条噪音 ✓ —— 而草稿**本来就是待定的**，多几条只是多看一眼 ✓；
//   · fail-closed ⇒ **静默丢掉真约定** ✗✗ —— 而草稿是它**唯一**的补救机制，丢了就永远找不回来 ✓。
//   判据一句话：**噪音可接受，漏掉不可接受** ✓。
//   （同样的理由也让"模型回答不可解析"与"模型明确说不要"必须区分开 —— 后者才是 drop ✓。）

/** 判定指令（写死在这里，不散落到调用方 ✓）。 */
export const JUDGE_INSTRUCTION = [
	'你是一个记忆筛选器。下面是从一段对话里按关键词粗筛出的候选片段。',
	'请判断**每一条**是否属于"用户在表达一条值得长期记住的约定 / 偏好 / 规范"。',
	'判据：',
	'- 属于：用户在陈述自己要遵守或要求别人遵守的长期规则（含"以后都要…""记住…""不要…"这类）。',
	'- 不属于：玩笑、反问、举例、引述别人的话、一次性的临时要求、以及明显是系统/文档文本而非用户说的话。',
	'只输出 JSON，形如 {"keep":[1,3]}（保留的序号；全部不要就输出 {"keep":[]}）。',
	'不要输出解释、不要输出 Markdown 代码块。',
].join('\n');

/**
 * 构造判定用的消息（纯函数）。
 *
 * ⚠ 片段里带 `序号` 前缀是**刻意**的：让模型用序号回答（而不是让它复述文本）——
 * 复述会引入改写风险（模型顺手改一个字，我们就没法与候选对齐 ✗），序号则天然可对齐 ✓。
 *
 * @param {readonly {digest: string, text: string}[]} candidates - 候选（`extractCandidates` 的产物）。
 * @returns {Array<{role: string, content: Array<{type: string, text: string}>}>} 消息数组。
 */
export function buildJudgeMessages(candidates) {
	const list = Array.isArray(candidates) ? candidates : [];
	const body = list.map((candidate, index) => `${index + 1}. ${String(candidate?.text ?? '')}`).join('\n');
	return [{
		role: 'user',
		content: [{ type: 'text', text: `${JUDGE_INSTRUCTION}\n\n候选：\n${body}` }],
	}];
}

/**
 * 从容错的模型回答里解析出"保留哪些"（纯函数）。
 *
 * 解析顺序（**都没拿到 `keep` 数组**才算 `parseFailed` ✓）：
 *   ① 直接 `JSON.parse`；
 *   ② 抓第一个 `{…}` 片段再 parse（模型爱加 Markdown 围栏或前后解释 ✗）；
 *   ③ 还没拿到 ⇒ `parseFailed: true` 且 **kept = 全部候选**（fail-open ✓）。
 *
 * ⚠ **只要拿到了 `keep` 数组，就完全尊重它**（`keep: [1]` 就只留第 1 条）——
 *   这是"判定"之所以有意义的前提 ✓。⚠ 第一版我在这里写错过：让"没被提到的"也归 keep
 *   ⇒ 那样 `keep: [1]` 与 `keep: [1,2,3]` 完全等价，模型说什么都一样 ✗✗（等于白调一次模型）。
 *   `keep: []` 是**有效**回答（明确"全不要"）⇒ 全部 drop ✓。
 *
 * 序号越界 / 非数字 / 重复：一律忽略或去重（`Set` ✓）—— 不因为模型的格式小错而放弃整次判定 ✓。
 *
 * @param {unknown} text - 模型输出正文。
 * @param {readonly {digest: string}[]} candidates - 候选（顺序必须与 prompt 里的序号一致 ✓）。
 * @returns {{kept: string[], dropped: string[], parseFailed: boolean}} 判定结果（digest 数组）。
 */
export function parseJudgeReply(text, candidates) {
	const list = Array.isArray(candidates) ? candidates : [];
	if (list.length === 0) {
		return { kept: [], dropped: [], parseFailed: false };
	}
	const all = list.map(candidate => String(candidate?.digest ?? '')).filter(Boolean);
	const raw = typeof text === 'string' ? text : '';
	const tryParse = value => {
		if (typeof value !== 'string') { return null; }
		try { return JSON.parse(value); } catch { return null; }
	};
	let parsed = tryParse(raw.trim());
	if (parsed === null) {
		const braced = /\{[\s\S]*\}/.exec(raw);
		if (braced !== null) { parsed = tryParse(braced[0]); }
	}
	const keep = parsed !== null && Array.isArray(parsed?.keep) ? parsed.keep : null;
	if (keep === null) {
		// 解析不了 ⇒ **全部保留**（fail-open ✓）；`parseFailed` 让调用方能如实报告这件事 ✓
		return { kept: all, dropped: [], parseFailed: true };
	}
	const wanted = new Set(keep.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0));
	const kept = [];
	const dropped = [];
	list.forEach((candidate, index) => {
		const digest = String(candidate?.digest ?? '');
		if (!digest) { return; }
		(wanted.has(index + 1) ? kept : dropped).push(digest);
	});
	return { kept, dropped, parseFailed: false };
}
