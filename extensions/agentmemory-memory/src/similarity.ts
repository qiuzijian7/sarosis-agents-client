/*---------------------------------------------------------------------------------------------
 *  相似度口径 —— 记忆去重 / 矛盾判定共用的**唯一** tokenizer（2026-11-02）
 *
 *  为什么单独一个文件：
 *   · `amSchema.ts` 被 388 个调用点引用，改它内部实现的产品面太大 ⇒ 抽出纯函数单独可测；
 *   · 不使用 `cjkSegmenter.ts`（它有 `await import('node:module')` 的顶层 await）⇒
 *     本模块**零依赖、无顶层 await**，网关 / 渲染侧 / 单测三处都能直接加载。
 *
 *  旧口径（`split(/\s+/)` + 丢弃 ≤2 字符 token）对中文的两种失效（2026-11-02 实测）：
 *   ① 整句中文没有空格 ⇒ 只有 1 个 token ⇒ 两条完全不同的中文记忆 jaccard = **0**
 *      ⇒ 去重与"矛盾检测"永不命中（库里 275 条中文记忆对它失明）；
 *   ② 短句（"已修复"）所有 token 都 ≤2 字符 ⇒ **空集**，而旧实现里
 *      `空集 vs 空集 = 1.0` ⇒ 任意两条短中文记忆被判成"完全相同"
 *      ⇒ 后者把前者标 `isLatest=false` ⇒ 7 天后被 `evict` 硬删。
 *
 *  新口径：
 *   · CJK 连续段 → **bigram**（单字段回退单字），与 `bm25Index` 的 jieba 不可用分支同构；
 *   · 非 CJK → 按非词字符切分，保留 >2 字符（与原口径尽量接近，English 用例不受影响）；
 *   · **空集 ≠ 相似**：任一侧为空集 ⇒ 0（唯一正确的保守方向：宁可不去重，不可误删）。
 *--------------------------------------------------------------------------------------------*/

/** CJK 连续段（Han / 平假名 / 片假名 / 谚文）—— 与 `cjkSegmenter` 的字符集一致。 */
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/** 非 CJK 文本的切分符：除「字母 / 数字 / 下划线 / 点 / 横线 / 斜杠 / 反斜杠」之外都算分隔。 */
const NON_WORD_SPLIT_RE = /[^\p{L}\p{N}_.\-/\\]+/u;

/**
 * 单条文本最多保留的 token 数。
 *
 * 为什么要上限：`autoForget` 用倒排表做候选剪枝，token 越多候选对越稠密
 * （实测 saros-claw 1903 条时全两两曾独占 sweep 16.9s）。中文改 bigram 后
 * 长文本的 token 数会涨一个量级 ⇒ 必须封顶，否则重新引入"网关事件循环被独占"。
 */
export const SIMILARITY_MAX_TOKENS = 256;

/**
 * 文本 → 归一化 token 集合（小写、CJK bigram、拉丁词保留 >2 字符、封顶 256）。
 * @param text 任意文本（非字符串 ⇒ 空集）。
 */
export function similarityTokens(text: string): Set<string> {
	const out = new Set<string>();
	if (typeof text !== 'string' || text.length === 0) { return out; }
	const lower = text.toLowerCase();

	// ① CJK 段：bigram（单字段回退单字）
	for (const match of lower.matchAll(CJK_RUN_RE)) {
		const run = Array.from(match[0]);
		if (run.length === 1) { out.add(run[0]); continue; }
		for (let i = 0; i + 1 < run.length; i++) { out.add(run[i] + run[i + 1]); }
	}

	// ② 非 CJK 段：按非词字符切分
	for (const word of lower.replace(CJK_RUN_RE, ' ').split(NON_WORD_SPLIT_RE)) {
		if (word.length > 2) { out.add(word); }
	}

	// ③ 封顶（按插入序截断：同一条文本恒定，不会在两次比较之间抖动）
	if (out.size > SIMILARITY_MAX_TOKENS) {
		const capped = new Set<string>();
		for (const token of out) {
			if (capped.size >= SIMILARITY_MAX_TOKENS) { break; }
			capped.add(token);
		}
		return capped;
	}
	return out;
}

/**
 * 两个 token 集合的 Jaccard 相似度。
 *
 * ⚠ 与旧实现的关键差异：**任一侧为空集 ⇒ 0**（旧实现是"双空 ⇒ 1.0"，
 * 正是短中文句子互相误判为重复的根因）。
 *
 * @param a 集合 A
 * @param b 集合 B
 * @returns [0, 1]
 */
export function jaccardFromSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) { return 0; }
	let inter = 0;
	for (const token of a) { if (b.has(token)) { inter++; } }
	return inter / (a.size + b.size - inter);
}

/**
 * 两条文本的 Jaccard 相似度（`amSchema.jaccardSimilarity` 的唯一实现）。
 * @param a 文本 A
 * @param b 文本 B
 * @returns [0, 1]
 */
export function jaccardSimilarity(a: string, b: string): number {
	return jaccardFromSets(similarityTokens(a), similarityTokens(b));
}
