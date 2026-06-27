/*---------------------------------------------------------------------------------------------
 *  记忆压缩器 — 将原始观察压缩为结构化记忆。
 *  参考 agentmemory src/functions/compress.ts + compress-synthetic.ts
 *
 *  合成压缩（无需 LLM）：
 *    - 提取关键词（TF 排序）
 *    - 提取文件路径（正则匹配）
 *    - 生成标题（首句截断）
 *    - 提取事实（句号分割）
 *
 *  LLM 压缩（可选，需 OPENAI_BASE_URL 配置）：
 *    - 调用 LLM 生成 facts + concepts + narrative
 *--------------------------------------------------------------------------------------------*/

export interface CompressedObservation {
	title: string;
	subtitle?: string;
	facts: string[];
	concepts: string[];
	files: string[];
	narrative: string;
	importance: number;
}

// ─── Regex patterns for extraction ─────────────────────────────────────────

const FILE_PATH_RE = /(?:src\/|test\/|lib\/|app\/|extensions\/|packages\/|docs\/)?[\w-]+\/[\w./-]+\.(?:ts|js|json|md|py|go|rs|java|cpp|c|h|jsx|tsx|vue|css|html|yml|yaml|sh|mjs)/g;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const IMPORT_RE = /(?:import|require|from)\s+['"]([^'"]+)['"]/g;
const FUNC_NAME_RE = /(?:function|class|def|fn|func)\s+(\w+)/g;
const ERROR_RE = /(?:Error|Exception|TypeError|RangeError|ReferenceError|SyntaxError)[:\s]([^\n]+)/gi;

/** Extract file paths from text */
function extractFiles(text: string): string[] {
	const matches = text.match(FILE_PATH_RE) ?? [];
	const importMatches = [...text.matchAll(IMPORT_RE)].map(m => m[1]);
	return [...new Set([...matches, ...importMatches])].slice(0, 10);
}

/** Extract function/class names */
function extractConcepts(text: string): string[] {
	const funcMatches = [...text.matchAll(FUNC_NAME_RE)].map(m => m[1]);
	const words = text.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.split(/\s+/)
		.filter(w => w.length > 4);
	const freq = new Map<string, number>();
	for (const w of words) {
		freq.set(w, (freq.get(w) ?? 0) + 1);
	}
	const topWords = [...freq.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([w]) => w);
	return [...new Set([...funcMatches, ...topWords])].slice(0, 8);
}

/** Extract facts (sentences ending with . or ;) */
function extractFacts(text: string): string[] {
	const cleaned = text.replace(CODE_BLOCK_RE, '').trim();
	const sentences = cleaned.split(/[.。;；\n]+/)
		.map(s => s.trim())
		.filter(s => s.length > 10 && s.length < 200);
	return sentences.slice(0, 5);
}

/** Generate a title from the first sentence */
function generateTitle(text: string): string {
	const firstLine = text.split('\n')[0].trim();
	const firstSentence = firstLine.split(/[.。!！?？]/)[0].trim();
	return (firstSentence || firstLine.slice(0, 80)).slice(0, 80);
}

/** Extract errors */
function extractErrors(text: string): string[] {
	return [...text.matchAll(ERROR_RE)].map(m => m[1].trim()).slice(0, 3);
}

/** Calculate importance based on content signals */
function calculateImportance(content: string, metadata?: Record<string, unknown>): number {
	let score = 5; // base
	if (metadata?.['importance'] && typeof metadata['importance'] === 'number') {
		return metadata['importance'] as number;
	}
	// Boost for error context
	if (/error|fail|exception|crash|bug/i.test(content)) score += 2;
	// Boost for decision context
	if (/decided|chose|should|must|need to|will use|adopted/i.test(content)) score += 2;
	// Boost for architecture
	if (/architecture|design|pattern|structure|framework/i.test(content)) score += 1;
	// Boost for file paths (concrete code context)
	if (FILE_PATH_RE.test(content)) score += 1;
	return Math.min(10, score);
}

/**
 * Synthetic compression — no LLM needed.
 * Extracts structure from raw observation text using regex + heuristics.
 */
export function compressSynthetic(content: string, metadata?: Record<string, unknown>): CompressedObservation {
	const errors = extractErrors(content);
	const facts = [...extractFacts(content), ...errors.map(e => `Error: ${e}`)];

	return {
		title: generateTitle(content),
		subtitle: extractFiles(content).slice(0, 2).join(', ') || undefined,
		facts: facts.slice(0, 5),
		concepts: extractConcepts(content),
		files: extractFiles(content),
		narrative: content.replace(CODE_BLOCK_RE, '').trim().slice(0, 500),
		importance: calculateImportance(content, metadata),
	};
}

/**
 * LLM compression — optional, requires OPENAI_BASE_URL.
 * Falls back to synthetic if LLM unavailable.
 */
export async function compressWithLLM(
	content: string,
	metadata?: Record<string, unknown>,
): Promise<CompressedObservation> {
	const baseUrl = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.['AGENTMEMORY_LLM_BASE_URL'];
	const apiKey = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.['AGENTMEMORY_LLM_API_KEY'];
	const model = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.['AGENTMEMORY_LLM_MODEL'] ?? 'gpt-4o-mini';

	if (!baseUrl || !apiKey) {
		// No LLM configured → synthetic fallback
		return compressSynthetic(content, metadata);
	}

	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				max_tokens: 300,
				messages: [
					{
						role: 'system',
						content: 'Extract structured memory from the observation. Return JSON with: title (string), facts (string[]), concepts (string[]), files (string[]), narrative (string), importance (1-10).',
					},
					{ role: 'user', content: content.slice(0, 2000) },
				],
			}),
			signal: AbortSignal.timeout(10000),
		});

		if (!response.ok) {
			return compressSynthetic(content, metadata);
		}

		const data = await response.json();
		const text = data?.choices?.[0]?.message?.content ?? '';
		// Try to parse JSON from response
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			return {
				title: parsed.title ?? generateTitle(content),
				subtitle: extractFiles(content).slice(0, 2).join(', ') || undefined,
				facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 5) : extractFacts(content),
				concepts: Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 8) : extractConcepts(content),
				files: Array.isArray(parsed.files) ? parsed.files.slice(0, 10) : extractFiles(content),
				narrative: typeof parsed.narrative === 'string' ? parsed.narrative.slice(0, 500) : content.slice(0, 500),
				importance: typeof parsed.importance === 'number' ? parsed.importance : calculateImportance(content, metadata),
			};
		}
	} catch {
		// LLM call failed → synthetic fallback
	}

	return compressSynthetic(content, metadata);
}

/**
 * Compress an observation, preferring LLM but falling back to synthetic.
 */
export async function compress(content: string, metadata?: Record<string, unknown>): Promise<CompressedObservation> {
	// For short content (< 100 chars), synthetic is sufficient
	if (content.length < 100) {
		return compressSynthetic(content, metadata);
	}
	return compressWithLLM(content, metadata);
}
