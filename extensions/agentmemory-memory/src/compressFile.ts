/*---------------------------------------------------------------------------------------------
 *  文件级压缩 — 压缩文件内容（保留标题/URL/代码块结构）。
 *  1:1 复刻 agentmemory src/functions/compress-file.ts
 *--------------------------------------------------------------------------------------------*/

const SENSITIVE_PATH_TERMS = ['secret', 'credential', 'private_key', '.env', 'id_rsa', 'token'];

export const COMPRESS_FILE_SYSTEM_PROMPT = `You compress markdown while preserving structure.
Rules:
- Keep all headings exactly as-is.
- Keep all URLs exactly as-is.
- Keep all fenced code blocks exactly as-is.
- Do not remove sections; shorten prose under each section.
- Output only markdown, no wrappers or explanations.`;

export function stripMarkdownFence(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
	return match ? match[1].trim() : trimmed;
}

export function extractUrls(text: string): string[] {
	return Array.from(new Set(text.match(/https?:\/\/[^\s)]+/g) || []));
}

export function extractHeadings(text: string): string[] {
	return text.split('\n').map(l => l.trim()).filter(l => /^#{1,6}\s+/.test(l));
}

export function extractCodeBlocks(text: string): string[] {
	return text.match(/```[\s\S]*?```/g) || [];
}

export function validateCompression(original: string, compressed: string): string[] {
	const errors: string[] = [];

	const originalHeadings = extractHeadings(original);
	const compressedHeadings = extractHeadings(compressed);
	for (const heading of originalHeadings) {
		if (!compressedHeadings.includes(heading)) {
			errors.push(`missing heading: ${heading}`);
		}
	}

	const originalUrls = extractUrls(original).sort();
	const compressedUrls = extractUrls(compressed).sort();
	if (originalUrls.length !== compressedUrls.length) {
		errors.push(`URL count mismatch: ${originalUrls.length} → ${compressedUrls.length}`);
	} else {
		for (let i = 0; i < originalUrls.length; i++) {
			if (originalUrls[i] !== compressedUrls[i]) {
				errors.push(`URL mismatch: ${originalUrls[i]} ≠ ${compressedUrls[i]}`);
			}
		}
	}

	const originalCodeBlocks = extractCodeBlocks(original);
	const compressedCodeBlocks = extractCodeBlocks(compressed);
	if (originalCodeBlocks.length !== compressedCodeBlocks.length) {
		errors.push(`Code block count mismatch: ${originalCodeBlocks.length} → ${compressedCodeBlocks.length}`);
	}

	return errors;
}

export function isSensitivePath(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return SENSITIVE_PATH_TERMS.some(term => lower.includes(term));
}

export interface FileCompressionResult {
	success: boolean;
	compressed: string;
	originalSize: number;
	compressedSize: number;
	ratio: number;
	validationErrors: string[];
	fromLLM: boolean;
}

/**
 * 合成压缩（不使用 LLM，基于规则的简化）
 */
export function compressFileSynthetic(content: string): FileCompressionResult {
	const lines = content.split('\n');
	const result: string[] = [];
	let inCodeBlock = false;

	for (const line of lines) {
		if (line.trim().startsWith('```')) {
			inCodeBlock = !inCodeBlock;
			result.push(line);
			continue;
		}
		if (inCodeBlock) {
			result.push(line);
			continue;
		}
		// Keep headings
		if (/^#{1,6}\s+/.test(line.trim())) {
			result.push(line);
			continue;
		}
		// Keep URLs
		if (/https?:\/\//.test(line)) {
			result.push(line);
			continue;
		}
		// Shorten prose: keep first sentence
		if (line.trim().length > 200) {
			const firstSentence = line.split(/[.。]/)[0] + '.';
			result.push(firstSentence);
		} else {
			result.push(line);
		}
	}

	const compressed = result.join('\n');
	const errors = validateCompression(content, compressed);

	return {
		success: errors.length === 0,
		compressed,
		originalSize: content.length,
		compressedSize: compressed.length,
		ratio: compressed.length > 0 ? content.length / compressed.length : 1,
		validationErrors: errors,
		fromLLM: false,
	};
}

export class FileCompressor {
	/**
	 * 压缩文件内容
	 */
	compress(content: string): FileCompressionResult {
		if (!content || content.trim().length === 0) {
			return { success: false, compressed: '', originalSize: 0, compressedSize: 0, ratio: 1, validationErrors: ['empty content'], fromLLM: false };
		}
		return compressFileSynthetic(content);
	}

	/**
	 * 批量压缩
	 */
	compressBatch(contents: string[]): FileCompressionResult[] {
		return contents.map(c => this.compress(c));
	}

	/**
	 * 获取统计
	 */
	getStats(results: FileCompressionResult[]): {
		total: number;
		successful: number;
		avgRatio: number;
		totalSaved: number;
	} {
		const successful = results.filter(r => r.success);
		const totalSaved = successful.reduce((s, r) => s + (r.originalSize - r.compressedSize), 0);
		const avgRatio = successful.length > 0
			? successful.reduce((s, r) => s + r.ratio, 0) / successful.length
			: 1;
		return {
			total: results.length,
			successful: successful.length,
			avgRatio: Math.round(avgRatio * 100) / 100,
			totalSaved,
		};
	}
}
