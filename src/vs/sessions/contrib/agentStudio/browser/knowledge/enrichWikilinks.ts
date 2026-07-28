/*---------------------------------------------------------------------------------------------
 *  确定性自动补链（P2-2，对齐 llm_wiki `src/lib/enrich-wikilinks.ts`）。
 *
 *  扫描笔记正文，若出现「已有笔记的文件名（去扩展名）」作为整词，且当前无对应 [[wikilink]]，
 *  则自动包裹为 `[[文件名]]`，增强图谱连通性。仅修改正文（frontmatter 外），跳过代码块。
 *
 *  接入策略：导入流程中对**本次新生成的笔记**补链（候选标题来自全部笔记），不动已有笔记，
 *  避免大面积改动用户内容。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { locateFrontmatterBlock } from './frontmatter.js';

export interface IEnrichResult {
	note: URI;
	added: string[];
}

const displayName = (u: URI): string => u.path.split('/').pop()!.replace(/\.(md|markdown)$/i, '');

/**
 * 对 targetNotes 补链：候选标题来自 allNotes 的文件名（去扩展名）。
 * 仅修改 targetNotes，不动 allNotes 中未被列入 targetNotes 的笔记。
 */
export async function enrichWikilinks(
	fileService: IFileService,
	targetNotes: URI[],
	allNotes: URI[],
): Promise<IEnrichResult[]> {
	// 候选标题（去重，lower）
	const titles = new Map<string, string>(); // lower → 原始 display
	for (const n of allNotes) {
		const d = displayName(n);
		if (d) { titles.set(d.toLowerCase(), d); }
	}
	const results: IEnrichResult[] = [];
	for (const n of targetNotes) {
		let content: string;
		try { content = (await fileService.readFile(n)).value.toString(); } catch { continue; }
		const self = displayName(n);
		const { newContent, added } = enrichContent(content, titles, self);
		if (added.length > 0) {
			try {
				await fileService.writeFile(n, VSBuffer.fromString(newContent));
				results.push({ note: n, added });
			} catch { /* ignore */ }
		}
	}
	return results;
}

/**
 * 纯函数：在正文（frontmatter 外）把出现的候选标题整词包裹为 [[标题]]。
 * 跳过 ``` 代码块；不重复包裹已有 [[标题]]；不包裹自身标题；要求标题长度 ≥ 2 字符。
 */
export function enrichContent(
	content: string,
	titles: Map<string, string>,
	selfTitle: string,
): { newContent: string; added: string[] } {
	const located = locateFrontmatterBlock(content);
	const rawBlock = located?.rawBlock ?? '';
	const body = located?.body ?? content;

	// 按代码块分段：奇数索引为代码块内容（不替换）
	const segments = body.split(/(```[\s\S]*?```)/g);
	const added: string[] = [];
	const selfLower = selfTitle.toLowerCase();

	for (const [lower, display] of titles) {
		if (lower === selfLower) { continue; }
		if (lower.length < 2) { continue; } // 过短标题易误匹配
		// 已有 [[display]] 或 [[display|...]] 链接则跳过
		const hasLink = new RegExp(`\\[\\[${escapeRe(display)}(?:\\|[^\\]]+)?\\]\\]`, 'i').test(body);
		if (hasLink) { continue; }
		// 整词匹配：前后非字母/数字/汉字/下划线，且不在 [[ 之后（避免 [[X 内重复）
		const re = new RegExp(
			`(?<!\\[)(?<![\\w\\u4e00-\\u9fa5_])${escapeRe(display)}(?![\\w\\u4e00-\\u9fa5_])(?!\\])`,
			'g',
		);
		let changed = false;
		for (let i = 0; i < segments.length; i += 2) { // 仅文本段（偶数索引）
			if (re.test(segments[i])) {
				segments[i] = segments[i].replace(re, `[[${display}]]`);
				changed = true;
			}
		}
		if (changed) { added.push(display); }
	}

	if (added.length === 0) { return { newContent: content, added }; }
	const newBody = segments.join('');
	const newContent = rawBlock ? rawBlock + '\n' + newBody : newBody;
	return { newContent, added };
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
