// @vssaros/dsh-kb — core/kbFulltext：**正文 BM25 全文检索**（纯逻辑：零 I/O、零 dsh 依赖）。
//
// 口径真源 = IDE 侧 `src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbIndex.ts`
// 的 `KbFullTextIndex`（`tokenize` / `extractTags` / `search` / `gatherTerms` / `snippet`）。
//
// ★ 为什么必须**逐字对齐**而不是"写得合理一点"：同一个 vault 会被 IDE 与 dsh 两侧同时检索
//   （两侧都有 `kb_search`，见 `common/toolOwnership.ts` 的同名工具登记表）⇒ 口径一旦分叉，
//   症状是"同一个库两套结果"，而且**两边都不会报错**（与 `.overview.md` 那次同一类事故）。
//   对齐点（每条都有对应的反向突变钉住）：
//     ① 分词：ASCII/数字按词边界 `[a-z0-9][a-z0-9_'-]*`；CJK + 日文假名按**单字 + 相邻二元**；
//     ② 被索引的文本 = `文件名.toLowerCase() + ' ' + cleanText`（cleanText = 正文去掉 `#标签#` 后的文本）；
//     ③ `length` = ② 的词元数（IDE 也是现算，不是我另取一个数）；
//     ④ BM25：k1 = 1.2、b = 0.75、`idf = ln((N - n + 0.5) / (n + 0.5) + 1)`；
//     ⑤ `gatherTerms`：精确命中 + **仅对 ASCII 且长度 >= 2** 的词做前缀展开；
//     ⑥ 加权：文件名整体命中 +10（matchedBy 记 name）、标签整体命中 +5（matchedBy 记 tag）；
//     ⑦ `snippet`：命中位置前 40 / 后 80 的窗口，空白折叠，两端按需加 `…`；
//     ⑧ 排序：**只按分数降序**（同分保持插入顺序 = 与 IDE 相同的遍历顺序）—— 这里**刻意不加**
//        二级排序键：加了就会与 IDE 的并列顺序不一致（那正是口径分叉 ✗）。
//
// ⚠ 两个正则都是 `/g`（**有状态**：`lastIndex` 会残留）⇒ 与 IDE 一样**每次调用现建**，
//   绝不放到模块级（放上去就会出现"同一次进程里第一次对、第二次开始漏"这种最难查的错 ✗）。

/** BM25 参数（照 `kbIndex.ts:80-81`）。 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** `snippet` 窗口（照 `kbIndex.ts:739-752`：命中位置前 40 / 后 80）。 */
export const SNIPPET_BEFORE = 40;
export const SNIPPET_AFTER = 80;

/** 标签的长度上限（照 `kbIndex.ts:406`：`tag.length > 0 && tag.length < 64`）。 */
export const TAG_MAX_LENGTH = 64;

/**
 * 一次检索允许建的正文总量上限（**字符**）。
 *
 * ⚠ 这里**刻意不做"按文档截断"** ✗：`length` 是 BM25 的长度归一因子，截断正文会让它与 IDE 侧
 * 索引出来的 `length` 不同 ⇒ 同一个库两侧分数不一样（正是本文件开头要防的那种分叉）。
 * 超限时**报错并指路**（`vaultId` 限定范围），而不是静默降级 ✗。
 */
export const MAX_FULLTEXT_TOTAL_CHARS = 64 * 1024 * 1024;

/**
 * 分词（照 `kbIndex.ts:369-386`）。
 * ASCII/数字词 + CJK/假名单字与相邻二元。
 */
export function tokenize(text) {
	const lower = String(text ?? '').toLowerCase();
	const tokens = [];
	const wordRe = /[a-z0-9][a-z0-9_'-]*/g;
	let m;
	while ((m = wordRe.exec(lower)) !== null) {
		tokens.push(m[0]);
	}
	const cjkRe = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309e\u30a0-\u30ff\u31f0-\u31ff\u31e0-\u31ef]+/g;
	while ((m = cjkRe.exec(lower)) !== null) {
		const s = m[0];
		for (let i = 0; i < s.length; i++) {
			tokens.push(s[i]);
			if (i + 1 < s.length) {
				tokens.push(s[i] + s[i + 1]);
			}
		}
	}
	return tokens;
}

/**
 * 提取 `#标签#` 并给出"去标签后的正文"（照 `kbIndex.ts:396-416`）。
 * 有效标签替换为**等长空格**（保持其余文本的偏移不变 ⇒ 以后若要在 cleanText 上做位置计算不会错位）；
 * 无效标签（空 / 超长）**保留原文**（不静默丢掉一段正文 ✗）。
 */
export function extractTags(text) {
	const source = String(text ?? '');
	const tags = [];
	const tagRe = /#[^#\s\u2000-\u206F]+#/g;
	const parts = [];
	let lastEnd = 0;
	let m;
	while ((m = tagRe.exec(source)) !== null) {
		const raw = m[0];
		const tag = raw.slice(1, -1).trim();
		const valid = tag.length > 0 && tag.length < TAG_MAX_LENGTH;
		if (valid) {
			tags.push(tag);
		}
		if (m.index > lastEnd) {
			parts.push(source.slice(lastEnd, m.index));
		}
		parts.push(valid ? ' '.repeat(raw.length) : raw);
		lastEnd = m.index + raw.length;
	}
	if (lastEnd === 0) {
		return { tags, cleanText: source };
	}
	if (lastEnd < source.length) {
		parts.push(source.slice(lastEnd));
	}
	return { tags, cleanText: parts.join('') };
}

/** 文件名（用于分词与"文件名命中"加权）：`uri` 的最后一段。 */
export function fileNameOf(uri) {
	const path = String(uri ?? '').replace(/^file:\/\//i, '').replace(/\\/g, '/');
	const segments = path.split('/').filter(Boolean);
	return segments.length ? segments[segments.length - 1] : path;
}

/**
 * 建索引。`docs` 每项 `{ uri, name, title?, text }`（`name` = 文件名；`uri` 是主键）。
 *
 * 与 IDE 的 `_addOrUpdateDoc` 等价：**重复 uri 后者覆盖前者**（IDE 是先 remove 再 add ✓），
 * 标签一律**从正文解析**（IDE 的 `doc.tags` 就是 `extractTags` 的结果 ✓ —— 不用 kernel 里那个
 * `tags` 字段：那是另一条写路径的产物，混进来就是第二套口径 ✗）。
 */
export function buildIndex(docs) {
	const postings = new Map();   // term -> Map(uri -> tf)
	const tagIndex = new Map();   // 小写标签 -> Set(uri)
	const byUri = new Map();      // uri -> { uri, name, title, tags, length, text }

	for (const raw of Array.isArray(docs) ? docs : []) {
		if (!raw || typeof raw.uri !== 'string' || !raw.uri) {
			continue;
		}
		const name = String(raw.name ?? fileNameOf(raw.uri));
		const text = String(raw.text ?? '');
		const { tags, cleanText } = extractTags(text);
		const toks = tokenize(`${name.toLowerCase()} ${cleanText}`);
		const uri = raw.uri;
		// `...raw` 在前：保留调用方附带的字段（如 `vaultId` —— 命中结果要能被归回某个库 ✓）
		byUri.set(uri, {
			...raw,
			uri,
			name,
			title: typeof raw.title === 'string' && raw.title ? raw.title : name,
			tags,
			length: toks.length,
			text,
		});
		const tf = new Map();
		for (const t of toks) {
			tf.set(t, (tf.get(t) ?? 0) + 1);
		}
		for (const [term, f] of tf) {
			let pm = postings.get(term);
			if (!pm) {
				pm = new Map();
				postings.set(term, pm);
			}
			pm.set(uri, f);
		}
		for (const tag of tags) {
			const normalized = tag.toLowerCase().trim();
			if (!normalized) {
				continue;
			}
			let set = tagIndex.get(normalized);
			if (!set) {
				set = new Set();
				tagIndex.set(normalized, set);
			}
			set.add(uri);
		}
	}

	let sum = 0;
	for (const doc of byUri.values()) {
		sum += doc.length;
	}
	const totalDocs = byUri.size;
	return { postings, tagIndex, byUri, totalDocs, avgLen: totalDocs ? sum / totalDocs : 0 };
}

/** 取词项对应的所有 posting key：精确命中 + ASCII（长度 >= 2）前缀命中（照 `kbIndex.ts:256-267`）。 */
export function gatherTerms(postings, term) {
	const keys = [];
	if (postings.has(term)) {
		keys.push(term);
	}
	if (/^[a-z0-9]{2,}$/.test(term)) {
		for (const key of postings.keys()) {
			if (key.length > term.length && key.startsWith(term)) {
				keys.push(key);
			}
		}
	}
	return keys;
}

/** 命中片段（照 `kbIndex.ts:739-752`：先找整条 query，再逐个找命中词）。 */
export function snippetOf(doc, matchedTerms, ql) {
	const text = String(doc?.text ?? '');
	let idx = text.toLowerCase().indexOf(ql);
	if (idx < 0) {
		for (const t of matchedTerms) {
			const i = text.toLowerCase().indexOf(t);
			if (i >= 0) {
				idx = i;
				break;
			}
		}
	}
	if (idx < 0) {
		return text.slice(0, 100).replace(/\s+/g, ' ').trim();
	}
	const start = Math.max(0, idx - SNIPPET_BEFORE);
	const end = Math.min(text.length, idx + SNIPPET_AFTER);
	return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

/**
 * 检索（照 `kbIndex.ts:191-254`）。
 *
 * @param index `buildIndex` 的产物
 * @param query 原始查询串（分词、标签整体匹配、文件名整体匹配都用**它**，不是分词结果 —— 与 IDE 一致）
 * @param options `{ limit }`
 * @returns `{ hits, matchedTerms }`；`hits` 每项 `{ uri, name, title, score, matchedBy, snippet }`
 */
export function searchFulltext(index, query, { limit = 20 } = {}) {
	const q = String(query ?? '');
	const queryTerms = tokenize(q);
	if (queryTerms.length === 0) {
		return { hits: [], matchedTerms: [] };
	}
	const N = index.totalDocs || 1;
	const scores = new Map();
	const matchedTerms = new Set();

	for (const term of queryTerms) {
		for (const key of gatherTerms(index.postings, term)) {
			matchedTerms.add(key);
			const pm = index.postings.get(key);
			if (!pm) {
				continue;
			}
			const n = pm.size;
			const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
			for (const [uri, tf] of pm) {
				const doc = index.byUri.get(uri);
				if (!doc) {
					continue;
				}
				const dl = doc.length || 1;
				const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / (index.avgLen || 1));
				const s = idf * (tf * (BM25_K1 + 1)) / denom;
				scores.set(uri, (scores.get(uri) ?? 0) + s);
			}
		}
	}

	const tagDocs = index.tagIndex.get(q.toLowerCase());
	if (tagDocs) {
		for (const uri of tagDocs) {
			scores.set(uri, (scores.get(uri) ?? 0) + 5);
		}
	}

	if (scores.size === 0) {
		return { hits: [], matchedTerms: [...matchedTerms] };
	}

	const ql = q.toLowerCase();
	const hits = [];
	for (const [uri, score] of scores) {
		const doc = index.byUri.get(uri);
		if (!doc) {
			continue;
		}
		let matchedBy = 'content';
		let sc = score;
		if (doc.name.toLowerCase().includes(ql)) {
			matchedBy = 'name';
			sc += 10;
		}
		if (doc.tags.some(t => t.toLowerCase() === ql)) {
			matchedBy = 'tag';
			sc += 5;
		}
		hits.push({
			uri,
			name: doc.name,
			title: doc.title,
			score: sc,
			matchedBy,
			snippet: snippetOf(doc, matchedTerms, ql),
			...(typeof doc.vaultId === 'string' ? { vaultId: doc.vaultId } : {}),
		});
	}
	hits.sort((a, b) => b.score - a.score);
	const capped = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
	return { hits: hits.slice(0, capped), matchedTerms: [...matchedTerms], totalHits: hits.length };
}
