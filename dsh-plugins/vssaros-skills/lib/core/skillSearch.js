// @vssaros/dsh-skills — core：技能检索（纯逻辑，零 I/O、零 dsh 依赖，可进程内直测）。
//
// 契约真源：`src/vs/sessions/contrib/agentStudio/browser/providers/tool/skillTools.ts` 的
// `bm25Score` / `tokenize` / `skill_search` handler（**16–52 行与 179–254 行**）。方案 6.9 方案 C：
// 契约共享、实现各自一份（`src/vs` 不得 import 本包 ⇒ 只能各写一遍，靠探针做口径对齐）。
//
// 为什么要有这个工具（而不是让 dsh 原生 `skill` 工具包办）：
//   dsh 原生 `skill` 工具解决的是**加载**（渐进披露：先给目录，模型挑一个取正文）。技能多了以后，
//   模型要在几十上百个条目里"凭描述挑"，挑错就等于加载了无关正文、白烧一轮。`skill_search` 解决的是
//   **检索**（BM25 排序，把最相关的几条排到前面，并告诉模型用哪个 id 去取正文）。
//   ⇒ 两者不重叠：一个是"取"，一个是"找"。名字也刻意不与原生 `skill` 相同（不遮蔽 ✓）。
//
// ⚠ 这个 BM25 是**退化的**（照搬 IDE 口径，不是笔误）：`n` 取 0/1（文档 token 存在与否），`tf` 恒为 1
//   ⇒ IDF 因 doc 而异的部分几乎消失，实际排序接近"命中查询词的个数 × 文档长度归一"。
//   照搬而非"修正"的理由：同一句查询在两处（IDE 引擎 / dsh 引擎）应当挑出**同一个**技能，
//   算式一改就是"换个壳结果就变了"这类最难解释的差异 ✓。要改成标准 BM25 得**两侧同时**改 + 对齐探针。
//
// 与 IDE 的**唯一**有意差异：分数相同时按 `id` 字典序做稳定 tie-break（IDE 用注册顺序 ⇒ 依赖来源顺序）。
//   技能来源顺序在两侧本就不同，靠顺序定序无法复现；字典序让"同样输入⇒同样输出"可被钉住 ✓。

/** BM25 参数（与 IDE 真源逐字一致，探针会拿源码核对）。 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
/** 默认返回条数 / 上限（IDE：`limit` 缺省 3，夹到 1–10 ✓）。 */
export const SKILL_SEARCH_DEFAULT_LIMIT = 3;
export const SKILL_SEARCH_MAX_LIMIT = 10;

/**
 * 分词：小写 → 非 `[a-z0-9_]` 与**非 CJK** 的字符当分隔 →
 *   段内再按 **ASCII / CJK 边界**切 → 英文/数字丢长度 < 2 的碎片、**中文逐字保留**。
 *
 * ★★ 2026-10-19 修（离线基准驱动的改动，见 `scripts/bench-skill-search.mjs`）：
 *
 * **旧行为是错的**（注释曾声称"每个汉字各自成一个 token"，但实现做不到）：
 *   旧正则 `replace(/[^a-z0-9_\u4e00-\u9fff]/g, ' ')` 只替换**非保留字符** ⇒ 中文字符不被替换
 *   ⇒ 连续中文**整段一个 token**（`"帮我讲懂这个机制"` → 一个 token）
 *   ⇒ 与描述里的"讲懂"永远匹配不上。实测对比（153 技能 / 12 条中文请求）：
 *     旧：recall@1 = 2/12（17%）、换说法类进 top3 = 0/6
 *     新：recall@1 = 4/12、**recall@3 = 8/12**、换说法类进 top3 = **6/6**
 *
 * 两条口径（与"英文丢 <2"不同，**中文单字必须保留**）：
 *   · 中文没有词边界 ⇒ 只能逐字切；单字本身有信息量（"懂"、"改"），
 *     若按英文那条 `length >= 2` 过滤，逐字切完会被**全部滤光** ⇒ 等于回到旧 bug ✗
 *   · 英文/数字保留 `length >= 2`：挡住 `a`、`1` 这类噪声（与旧口径一致 ✓）
 *   · 段内还要再按 ASCII/CJK 边界切：`UE5的GC` 是**一个 chunk**，
 *     不细分就会整段成一个 token（或把 `ue5` 拆成 `u`/`e`/`5`）✗
 */
export function tokenize(text) {
	const out = new Set();
	const lower = String(text ?? '').toLowerCase();
	for (const chunk of lower.replace(/[^a-z0-9_\u4e00-\u9fff]/g, ' ').split(/\s+/)) {
		if (!chunk) { continue; }
		// 段内再按 ASCII / CJK 边界切（`ue5的gc` ⇒ ue5 / 的 / gc）
		for (const part of chunk.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) ?? []) {
			if (/^[a-z0-9_]+$/.test(part)) {
				if (part.length >= 2) { out.add(part); }
			} else {
				for (const ch of part) { out.add(ch); }
			}
		}
	}
	return out;
}

/**
 * BM25 单文档打分（k1 / b 见上）。签名与 IDE 真源一致：`(queryTokens, docTokens, avgDocLen, totalDocs)`。
 * `docTokens` 是 Set ⇒ `n` 只能取 0/1、`tf` 只能取 1（退化，见文件头）。
 */
export function bm25Score(queryTokens, docTokens, avgDocLen, totalDocs) {
	const docLen = docTokens.size;
	let score = 0;
	for (const term of queryTokens) {
		const n = docTokens.has(term) ? 1 : 0;
		if (n === 0) {
			continue;
		}
		const idf = Math.log((totalDocs - n + 0.5) / (n + 0.5) + 1);
		const tf = 1;
		// `avgDocLen === 0` 意味着**所有**文档都是 0 个 token（分词把长度 < 2 的碎片滤光）⇒ 任何查询词都过不了
		// 上面的 `has(term)` ⇒ 早就 `continue` 掉了，除号那一步**根本走不到** ✓
		// （2026-10-12 实测确认：两侧都不崩 —— IDE 侧那版也没有这个问题，见 skillToolsBm25.test.ts 的单字符用例 ✓）。
		// 所以这个条件只是**防御性**的（不承担正确性），留着是为了让"除号两侧都不为 0"一眼可见 ✓。
		const tfNorm = avgDocLen > 0 ? (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * docLen / avgDocLen)) : 1;
		score += idf * tfNorm;
	}
	return score;
}

/**
 * 检索并排序。
 * `skills` 每项需要 `{ id, name, description }`（正文不参与打分：索引只建在 name + description + id 上，
 * 与 IDE 一致 ✓ —— 正文几百 KB，进不了"轻量检索"这件事）。
 * 返回 `[{ id, name, description, score }]`（score 已四舍五入到两位，与 IDE 的返回口径一致 ✓）。
 */
export function rankSkills(skills, query, limit = SKILL_SEARCH_DEFAULT_LIMIT) {
	const list = Array.isArray(skills) ? skills : [];
	const rawLimit = Number.isFinite(limit) ? Math.floor(limit) : SKILL_SEARCH_DEFAULT_LIMIT;
	const capped = Math.max(1, Math.min(SKILL_SEARCH_MAX_LIMIT, rawLimit));
	const queryTokens = tokenize(query);
	if (list.length === 0 || queryTokens.size === 0) {
		return [];
	}
	const entries = list.map(skill => ({
		id: skill.id,
		name: skill.name,
		description: skill.description ?? '',
		tokens: tokenize(`${skill.name} ${skill.description ?? ''} ${skill.id}`),
	}));
	const totalDocs = entries.length;
	const avgDocLen = entries.reduce((sum, e) => sum + e.tokens.size, 0) / totalDocs;
	return entries
		.map(e => ({ id: e.id, name: e.name, description: e.description, score: bm25Score(queryTokens, e.tokens, avgDocLen, totalDocs) }))
		.filter(e => e.score > 0)
		.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
		.slice(0, capped)
		.map(e => ({ ...e, score: Math.round(e.score * 100) / 100 }));
}
