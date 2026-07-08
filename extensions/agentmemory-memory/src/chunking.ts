/*---------------------------------------------------------------------------------------------
 *  G2: 多级文本分块引擎 — 对齐 cognee infrastructure/data/chunking
 *
 *  策略:
 *    fixed    — 固定字符数分块（简单截断）
 *    semantic — 语义边界分块（段落/句子边界）
 *    markdown — Markdown 结构分块（按标题层级）
 *    code     — 代码结构分块（按函数/类边界）
 *
 *  使用:
 *    const chunks = chunkText(content, ChunkStrategy.markdown, 2000);
 *    for (const c of chunks) await provider.writeMemory(agentId, { content: c, ... });
 *--------------------------------------------------------------------------------------------*/

export enum ChunkStrategy {
	Fixed = 'fixed',
	Semantic = 'semantic',
	Markdown = 'markdown',
	Code = 'code',
}

export interface ChunkResult {
	text: string;
	startIndex: number;
	endIndex: number;
	metadata?: {
		heading?: string;
		language?: string;
	};
}

/** 默认分块大小 (字符) */
const DEFAULT_CHUNK_SIZE = 2000;
/** 分块重叠 (字符) — 保证上下文连续性 */
const CHUNK_OVERLAP = 200;

/**
 * 主入口：按策略分块文本
 */
export function chunkText(
	text: string,
	strategy: ChunkStrategy = ChunkStrategy.Semantic,
	chunkSize: number = DEFAULT_CHUNK_SIZE,
): ChunkResult[] {
	switch (strategy) {
		case ChunkStrategy.Fixed:
			return chunkFixed(text, chunkSize);
		case ChunkStrategy.Semantic:
			return chunkSemantic(text, chunkSize);
		case ChunkStrategy.Markdown:
			return chunkMarkdown(text, chunkSize);
		case ChunkStrategy.Code:
			return chunkCode(text, chunkSize);
		default:
			return chunkSemantic(text, chunkSize);
	}
}

/** 固定字符数分块 */
function chunkFixed(text: string, chunkSize: number): ChunkResult[] {
	if (!text || text.length === 0) return [{ text: '', startIndex: 0, endIndex: 0 }];
	const results: ChunkResult[] = [];
	const effectiveSize = Math.max(100, chunkSize - CHUNK_OVERLAP);
	for (let i = 0; i < text.length; i += effectiveSize) {
		const end = Math.min(text.length, i + chunkSize);
		results.push({
			text: text.slice(i, end),
			startIndex: i,
			endIndex: end,
		});
	}
	return results;
}

/** 语义边界分块 — 按段落/句子分割 */
function chunkSemantic(text: string, chunkSize: number): ChunkResult[] {
	const results: ChunkResult[] = [];
	// 先按段落分割
	const paragraphs = text.split(/\n\s*\n/);
	let current = '';
	let startIdx = 0;

	for (const para of paragraphs) {
		const paraWithBreak = (current ? '\n\n' : '') + para;
		if ((current + paraWithBreak).length > chunkSize && current.length > 0) {
			// 当前块已满，推入结果
			results.push({
				text: current,
				startIndex: startIdx,
				endIndex: startIdx + current.length,
			});
			// 保留 overlap
			const overlap = current.slice(-CHUNK_OVERLAP);
			current = overlap + paraWithBreak;
			startIdx = startIdx + current.length - overlap.length - paraWithBreak.length + paraWithBreak.length;
		} else {
			current += paraWithBreak;
		}
	}
	if (current.trim().length > 0) {
		results.push({
			text: current,
			startIndex: startIdx,
			endIndex: startIdx + current.length,
		});
	}
	return results.length > 0 ? results : [{ text, startIndex: 0, endIndex: text.length }];
}

/** Markdown 结构分块 — 按标题层级分割 */
function chunkMarkdown(text: string, chunkSize: number): ChunkResult[] {
	const results: ChunkResult[] = [];
	// 按 Markdown 标题分割 (## ### ####)
	const sections: Array<{ heading: string; content: string; start: number }> = [];
	const headingRe = /^(#{1,6})\s+(.+)$/gm;
	let lastEnd = 0;
	let lastHeading = '';
	let match: RegExpExecArray | null;

	while ((match = headingRe.exec(text)) !== null) {
		if (lastEnd < match.index) {
			sections.push({
				heading: lastHeading,
				content: text.slice(lastEnd, match.index).trim(),
				start: lastEnd,
			});
		}
		lastHeading = match[2].trim();
		lastEnd = match.index + match[0].length;
	}
	if (lastEnd < text.length) {
		sections.push({
			heading: lastHeading,
			content: text.slice(lastEnd).trim(),
			start: lastEnd,
		});
	}

	// 如果没有标题，回退到语义分块
	if (sections.length === 0 || (sections.length === 1 && !sections[0].heading)) {
		return chunkSemantic(text, chunkSize);
	}

	// 合并小节直到接近 chunkSize
	let currentContent = '';
	let currentHeading = '';
	let currentStart = 0;

	for (const sec of sections) {
		const combined = currentContent ? `${currentContent}\n\n` : '';
		if ((combined + sec.content).length > chunkSize && currentContent) {
			results.push({
				text: `## ${currentHeading}\n${currentContent}`,
				startIndex: currentStart,
				endIndex: currentStart + currentContent.length,
				metadata: { heading: currentHeading },
			});
			currentContent = sec.content;
			currentHeading = sec.heading;
			currentStart = sec.start;
		} else {
			currentContent = combined + sec.content;
			if (!currentHeading) currentHeading = sec.heading;
		}
	}
	if (currentContent.trim()) {
		results.push({
			text: currentHeading ? `## ${currentHeading}\n${currentContent}` : currentContent,
			startIndex: currentStart,
			endIndex: currentStart + currentContent.length,
			metadata: { heading: currentHeading },
		});
	}
	return results;
}

/** 代码结构分块 — 按函数/类边界分割 */
function chunkCode(text: string, chunkSize: number): ChunkResult[] {
	const results: ChunkResult[] = [];
	// 检测语言
	const lang = detectLanguage(text);
	// 按函数/类定义分割
	const defRe = lang === 'python'
		? /^(async\s+def\s+\w+|^class\s+\w+|^\s{0,4}def\s+\w+)/m
		: /^(export\s+)?(async\s+)?function\s+\w+|^export\s+class\s+\w+|^class\s+\w+|^(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/m;

	const lines = text.split('\n');
	let currentChunk = '';
	let currentStart = 0;
	let inDefinition = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isDef = defRe.test(line);

		if (isDef && currentChunk.length > 0 && currentChunk.length > chunkSize * 0.5) {
			// 遇到新定义且当前块已够大 → 推入结果
			results.push({
				text: currentChunk,
				startIndex: currentStart,
				endIndex: currentStart + currentChunk.length,
				metadata: { language: lang },
			});
			currentChunk = '';
			currentStart = i;
			inDefinition = true;
		}

		currentChunk += (currentChunk ? '\n' : '') + line;

		// 如果块过大，强制截断
		if (currentChunk.length > chunkSize) {
			results.push({
				text: currentChunk,
				startIndex: currentStart,
				endIndex: currentStart + currentChunk.length,
				metadata: { language: lang },
			});
			currentChunk = '';
			currentStart = i + 1;
		}
	}
	if (currentChunk.trim()) {
		results.push({
			text: currentChunk,
			startIndex: currentStart,
			endIndex: currentStart + currentChunk.length,
			metadata: { language: lang },
		});
	}
	return results.length > 0 ? results : [{ text, startIndex: 0, endIndex: text.length, metadata: { language: lang } }];
}

/** 简单语言检测 */
function detectLanguage(text: string): string {
	if (/^\s*def\s+\w+/m.test(text) || /^\s*import\s+\w+/m.test(text)) return 'python';
	if (/^\s*export\s+(function|class|const)/m.test(text) || /^\s*import\s+.*from\s+['"]/m.test(text)) return 'typescript';
	if (/^\s*package\s+\w+/m.test(text) || /^\s*func\s+\w+/m.test(text)) return 'go';
	if (/^\s*#include/m.test(text) || /^\s*int\s+main/m.test(text)) return 'c';
	return 'unknown';
}
