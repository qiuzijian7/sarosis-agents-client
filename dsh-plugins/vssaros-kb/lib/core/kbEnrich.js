// @vssaros/dsh-kb — **确定性补链**的纯逻辑（真源 `knowledge/enrichWikilinks.ts` 逐字移植 ✓）。
//
// ## 它做什么（真源文件头原话）
// *"扫描笔记正文，若出现「已有笔记的文件名（去扩展名）」作为**整词**，且当前无对应 `[[wikilink]]`，
//  则自动包裹为 `[[文件名]]`，增强图谱连通性。仅修改正文（frontmatter 外），跳过代码块。"* ✓
// 接入策略同样照抄：**只补"本次新写的笔记"**（候选标题来自全部笔记 ✓），不动已有笔记 ✓
//（真源原话："避免大面积改动用户内容" ✓）。
//
// ## 为什么 dsh 侧也要做
// 笔记之间的 `[[链接]]` 就是知识图谱的**边** ⇒ 少了补链，dsh 构建出来的笔记是**孤岛** ✗：
//   · IDE 侧的图谱/洞察（`insights.md` 按 wikilink 建图 ✓）看不到连接；
//   · 门控的"来源确认"虽然用的是 `sources` 字段（不依赖链接 ✓），但**人看的知识体系**是靠链接串起来的 ✓。
//
// ## 六条判据（都能让结果分叉，逐条照抄 ✓）
//   ① 候选标题 = 其它笔记**文件名去扩展名**（大小写不敏感去重 ✓）；② 标题长度 < 2 字符 ⇒ 跳过（易误匹配 ✗）；
//   ③ 自身标题 ⇒ 跳过；④ 正文里**已有** `[[标题]]` / `[[标题|…]]` ⇒ 整条跳过（不重复包裹 ✓）；
//   ⑤ 只在**正文**里替换（frontmatter 外 ✓），且按 ``` 代码块分段 ⇒ **代码块不动** ✗；
//   ⑥ 整词匹配：前后不是字母/数字/汉字/下划线，且不在 `[[` 之后、不是 `]` 之前 ✓。
// ⇒ 交叉校验：`poc/dsh-p0/scripts/p3-62-kb-enrich.mjs` 拿 IDE 侧**真** `enrichWikilinks` 在同一份夹具上跑
//   ⇒ 每个文件的最终内容**逐字节**比 ✓（IDE 侧读数由 `kbEnrichParity.test.ts` 打印 ✓）。

// `locateFrontmatterBlock` 与 frontmatter 解析只有一处实现（见 core/kbFrontmatter.js ✓）
import { locateFrontmatterBlock } from './kbFrontmatter.js';

/** 取"标题"＝文件名去 `.md`/`.markdown` 扩展名（真源 `displayName` 同口径 ✓）。 */
export function displayNameOf(rel) {
	const base = String(rel ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
	return base.replace(/\.(md|markdown)$/i, '');
}

/** 正则转义（真源 `escapeRe` 逐字 ✓）。 */
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 纯函数：在正文（frontmatter 外）把出现的候选标题整词包裹为 `[[标题]]`。
 * 跳过 ``` 代码块；不重复包裹已有 `[[标题]]`；不包裹自身标题；要求标题长度 ≥ 2 字符。
 * @param {string} content
 * @param {Map<string, string>} titles lower → 原始 display（**插入顺序**参与结果 ⇒ 调用方按真源同序构造 ✓）
 * @param {string} selfTitle
 * @returns {{ newContent: string, added: string[] }}
 */
export function enrichContent(content, titles, selfTitle) {
	const located = locateFrontmatterBlock(content);
	const rawBlock = located?.rawBlock ?? '';
	const body = located?.body ?? content;

	// 按代码块分段：奇数索引为代码块内容（不替换 ✓）
	const segments = body.split(/(```[\s\S]*?```)/g);
	const added = [];
	const selfLower = selfTitle.toLowerCase();

	for (const [lower, display] of titles) {
		if (lower === selfLower) {
			continue;
		}
		if (lower.length < 2) {
			continue;   // 过短标题易误匹配
		}
		// 已有 [[display]] 或 [[display|...]] 链接则跳过
		const hasLink = new RegExp(`\\[\\[${escapeRe(display)}(?:\\|[^\\]]+)?\\]\\]`, 'i').test(body);
		if (hasLink) {
			continue;
		}
		// 整词匹配：前后非字母/数字/汉字/下划线，且不在 [[ 之后（避免 [[X 内重复）
		const re = new RegExp(
			`(?<!\\[)(?<![\\w\\u4e00-\\u9fa5_])${escapeRe(display)}(?![\\w\\u4e00-\\u9fa5_])(?!\\])`,
			'g',
		);
		let changed = false;
		for (let i = 0; i < segments.length; i += 2) {   // 仅文本段（偶数索引 ✓）
			if (re.test(segments[i])) {
				segments[i] = segments[i].replace(re, `[[${display}]]`);
				changed = true;
			}
		}
		if (changed) {
			added.push(display);
		}
	}

	if (added.length === 0) {
		return { newContent: content, added };
	}
	const newBody = segments.join('');
	const newContent = rawBlock ? `${rawBlock}\n${newBody}` : newBody;
	return { newContent, added };
}

/**
 * 计划一次补链：候选标题取自 `allNotes`，只对 `targetRels` 里的笔记动手 ✓（真源同策略 ✓）。
 * @param {{ rel: string, content: string }[]} allNotes 笔记区里的**全部**笔记（已过 selectNoteFiles ✓）
 * @param {Set<string>|string[]} targetRels 本次要补的笔记（相对笔记区的路径 ✓）
 * @returns {{ changed: { rel: string, content: string }[], added: { rel: string, titles: string[] }[], candidates: number }}
 */
export function planEnrichment(allNotes, targetRels) {
	const targets = new Set([...(targetRels ?? [])].map(rel => String(rel).replace(/\\/g, '/')));
	// 候选标题（去重，lower ✓ —— Map 的插入顺序 = allNotes 的顺序 ⇒ 调用方要保持与真源一致 ✓）
	const titles = new Map();
	for (const note of allNotes) {
		const display = displayNameOf(note.rel);
		if (display) {
			titles.set(display.toLowerCase(), display);
		}
	}
	const changed = [];
	const added = [];
	for (const note of allNotes) {
		if (!targets.has(note.rel)) {
			continue;
		}
		const result = enrichContent(note.content, titles, displayNameOf(note.rel));
		if (result.added.length > 0) {
			changed.push({ rel: note.rel, content: result.newContent });
			added.push({ rel: note.rel, titles: result.added });
		}
	}
	return { changed, added, candidates: titles.size };
}
