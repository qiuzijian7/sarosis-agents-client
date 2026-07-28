/*---------------------------------------------------------------------------------------------
 *  FileBlockParser — FILE 块解析器（对齐 llm_wiki parseFileBlocks + writeFileBlocks）
 *
 *  格式：---FILE: wiki/path.md ---\n...content...\n---END FILE---
 *
 *  支持 LLM 在一次响应中生成多个 Wiki 页面，减少 Agent 调用次数。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

export interface FileBlock {
	/** 相对路径（如 "概念/GC机制.md"） */
	path: string;
	/** 文件内容 */
	content: string;
}

/** FILE 块正则（对齐 llm_wiki；容忍 LLM 常见变体：`--- FILE :`、`--- END FILE ---`、CRLF、路径首尾空格） */
const FILE_BLOCK_RE = /---\s*FILE\s*:\s*([^\n]*?)\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*END\s*FILE\s*---/g;

/**
 * 从 LLM 响应文本中解析 FILE 块。
 *
 * @param text LLM 响应的完整文本
 * @param baseDir 基准目录 URI（如 notesDir），用于路径安全校验
 * @returns 解析出的文件块列表，自动跳过不安全路径
 */
export function parseFileBlocks(text: string, baseDir: URI): FileBlock[] {
	const blocks: FileBlock[] = [];
	let m: RegExpExecArray | null;

	// 预处理：剥掉模型常在最外层包裹的 ``` 代码围栏，避免破坏块边界匹配。
	const cleaned = text
		.replace(/^```(?:markdown|md|text)?\s*\r?\n/i, '')
		.replace(/\r?\n```\s*$/, '');

	// 重置正则 lastIndex（全局模式下）
	FILE_BLOCK_RE.lastIndex = 0;
	while ((m = FILE_BLOCK_RE.exec(cleaned)) !== null) {
		const rawPath = m[1].trim();
		const content = m[2];

		if (!isSafePath(rawPath, baseDir)) {
			continue;  // 跳过不安全路径（路径穿越、绝对路径等）
		}

		if (!content.trim()) {
			continue;  // 跳过空内容块
		}

		blocks.push({ path: rawPath, content: sanitizeBlockContent(content) });
	}

	return blocks;
}

/**
 * 路径安全校验（对齐 llm_wiki isSafeIngestPath）。
 * 拒绝：
 * - 路径穿越（.. 或 /.）
 * - 绝对路径（Windows 盘符、Unix 根路径）
 * - 系统文件（.开头）
 * - 非 .md 后缀
 */
function isSafePath(rawPath: string, baseDir: URI): boolean {
	if (!rawPath || typeof rawPath !== 'string') { return false; }

	const normalized = rawPath.replace(/\\/g, '/');

	// 拒绝路径穿越
	if (normalized.includes('..')) { return false; }
	if (normalized.includes('/.')) { return false; }

	// 拒绝绝对路径
	if (/^[a-z]:/i.test(normalized)) { return false; }  // Windows: C:/...
	if (normalized.startsWith('/')) { return false; }    // Unix root

	// 拒绝系统文件
	const fileName = normalized.split('/').pop() ?? '';
	if (fileName.startsWith('.')) { return false; }

	// 必须是 .md 文件
	if (!fileName.endsWith('.md')) { return false; }

	return true;
}

/**
 * 清洗 FILE 块内容（对齐 llm_wiki sanitizeIngestedFileContent）。
 * 修复 LLM 常见错误：
 * - block 开头有 YAML frontmatter 但缺少结束 ---
 * - 代码围栏未闭合
 * - wikilink 列表前有无关前缀字符
 */
function sanitizeBlockContent(content: string): string {
	let result = content.trim();

	// 确保 frontmatter 正确闭合（LLM 常见遗漏）
	result = fixFrontmatterClosure(result);
	// 确保代码围栏成对
	result = fixCodeFencePairs(result);
	// 规范换行
	result = result.replace(/\r\n/g, '\n');

	return result;
}

/**
 * 检查 YAML frontmatter 是否正确闭合。
 * 如果以 --- 开头但未以 --- 闭合，自动补上。
 */
function fixFrontmatterClosure(text: string): string {
	const lines = text.split('\n');
	if (lines[0]?.trim() !== '---') { return text; }

	// 找闭合的 ---
	let closed = false;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '---') {
			closed = true;
			break;
		}
	}
	if (closed) { return text; }

	// 未闭合 → 在 frontmatter 字段后插入 ---
	let insertAt = 1;
	while (insertAt < lines.length && lines[insertAt].trim()) { insertAt++; }
	lines.splice(insertAt, 0, '---');
	return lines.join('\n');
}

/**
 * 确保代码围栏（```）成对出现。
 * 奇数个围栏 → 追加一个闭合的。
 */
function fixCodeFencePairs(text: string): string {
	const matches = text.match(/^```/gm);
	if (!matches) { return text; }
	if (matches.length % 2 === 0) { return text; }
	// 奇数 → 追加闭合围栏
	return text + '\n```\n';
}

/**
 * 为 LLM prompt 生成 FILE 块格式说明。
 * 注入到 Agent prompt 中，告诉 LLM 使用此格式输出。
 */
export function buildFileBlockPrompt(noteBaseDir: string): string {
	return [
		'### FILE Block Output Format',
		'',
		'Use the following format to output each wiki page:',
		'```',
		'---FILE: <filename relative to the current topic dir> ---',
		'<page content with YAML frontmatter>',
		'---END FILE---',
		'```',
		'',
	'Notes are placed FLAT in the current topic directory. Do NOT prefix the path with a type folder; the `type` belongs only in frontmatter.',
	'',
	'Cross-reference related notes in the body using [[Note Title]] wikilink syntax. Reference other notes in this batch (by their frontmatter `title`) to build bidirectional links for the knowledge graph.',
	'',
	'Examples:',
		'```',
		'---FILE: GC机制分析.md ---',
		'---',
		'type: concept',
		'title: GC机制分析',
		'created: 2026-07-24',
		'---',
		'',
		'## 概述',
		'...',
		'---END FILE---',
		'',
		'---FILE: 标记清除vs引用计数.md ---',
		'---',
		'type: comparison',
		'title: 标记清除 vs 引用计数',
		'---',
		'',
		'## 对比',
		'...',
		'---END FILE---',
		'```',
		'',
		`Base dir: \`${noteBaseDir}\``,
	].join('\n');
}
