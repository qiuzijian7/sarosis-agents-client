/*---------------------------------------------------------------------------------------------
 *  CJK 分词器 — 中文/日文/韩文分词。
 *  1:1 复刻 agentmemory src/state/cjk-segmenter.ts
 *
 *  分词策略：
 *    1. 中文（Han）→ 优先使用 @node-rs/jieba 分词，降级到 bigram
 *    2. 日文（Kana）→ 优先使用 tiny-segmenter，降级到整串
 *    3. 韩文（Hangul）→ 按音节块分割
 *
 *  在 renderer 进程中，@node-rs/jieba 不可用（原生模块），
 *  降级到 bigram 分词（比单字分割更准确）：
 *    "身份认证" → ["身份", "份认", "认证"]（bigram）
 *    而非 ["身", "份", "认", "证"]（单字）
 *--------------------------------------------------------------------------------------------*/

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HAN_RE = /\p{Script=Han}/u;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const HANGUL_BLOCK_RE = /[가-힯]+/g;

type Script = 'han' | 'kana' | 'hangul' | 'other';

export function hasCjk(text: string): boolean {
	return CJK_RE.test(text);
}

export function detectScript(text: string): Script {
	if (HAN_RE.test(text)) return 'han';
	if (KANA_RE.test(text)) return 'kana';
	if (HANGUL_RE.test(text)) return 'hangul';
	return 'other';
}

// ─── Jieba loading (best effort, native module may not be available) ────────

interface JiebaInstance {
	cut(text: string, hmm?: boolean): string[];
}

let jiebaInstance: JiebaInstance | null = null;
let jiebaLoaded = false;

function getJieba(): JiebaInstance | null {
	if (jiebaLoaded) return jiebaInstance;
	jiebaLoaded = true;
	try {
		// Try to load @node-rs/jieba (native module, only available in Node.js)
		const req = (globalThis as any).require;
		if (req) {
			const mod = req('@node-rs/jieba');
			try {
				const dictMod = req('@node-rs/jieba/dict');
				jiebaInstance = mod.Jieba.withDict(dictMod.dict);
			} catch {
				jiebaInstance = new mod.Jieba();
			}
		}
		return jiebaInstance;
	} catch {
		return null;
	}
}

// ─── Japanese segmenter (best effort) ───────────────────────────────────────

interface JaSegmenter {
	segment(text: string): string[];
}

let jaSegmenterInstance: JaSegmenter | null = null;
let jaSegmenterLoaded = false;

function getJaSegmenter(): JaSegmenter | null {
	if (jaSegmenterLoaded) return jaSegmenterInstance;
	jaSegmenterLoaded = true;
	try {
		const req = (globalThis as any).require;
		if (req) {
			const Ctor = req('tiny-segmenter');
			jaSegmenterInstance = new Ctor();
		}
		return jaSegmenterInstance;
	} catch {
		return null;
	}
}

// ─── Fallback: Bigram tokenization for Chinese ──────────────────────────────

function bigramSegment(text: string): string[] {
	const out: string[] = [];
	// Single chars (for 1-2 char strings)
	if (text.length <= 2) {
		if (text.trim()) out.push(text.trim());
		return out;
	}
	// Bigrams: "身份认证" → ["身份", "份认", "认证"]
	for (let i = 0; i < text.length - 1; i++) {
		out.push(text.slice(i, i + 2));
	}
	// Also add the full string as a token (for exact match)
	out.push(text);
	return out;
}

// ─── Segmentation by script ────────────────────────────────────────────────

function cleanTokens(tokens: string[]): string[] {
	const out: string[] = [];
	for (const t of tokens) {
		const trimmed = t.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}

function segmentHan(text: string): string[] {
	const j = getJieba();
	if (j) {
		try {
			return cleanTokens(j.cut(text, true));
		} catch {
			// fall through to bigram
		}
	}
	// Fallback: bigram tokenization (better than single char)
	return bigramSegment(text);
}

function segmentKana(text: string): string[] {
	const s = getJaSegmenter();
	if (s) {
		try {
			return cleanTokens(s.segment(text));
		} catch {
			// fall through
		}
	}
	// Fallback: return whole string
	return [text];
}

function segmentHangul(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(HANGUL_BLOCK_RE)) {
		if (m[0]) out.push(m[0]);
	}
	return out.length > 0 ? out : [text];
}

/**
 * Segment CJK text into tokens.
 * Non-CJK text is returned as-is (for further Latin tokenization).
 */
export function segmentCjk(text: string): string[] {
	if (!hasCjk(text)) return [text];

	const out: string[] = [];
	let cursor = 0;

	for (const m of text.matchAll(CJK_RUN_RE)) {
		const start = m.index ?? 0;
		const run = m[0];
		const end = start + run.length;

		// Add non-CJK text before this run
		if (start > cursor) {
			const piece = text.slice(cursor, start).trim();
			if (piece) out.push(piece);
		}

		// Segment the CJK run by script
		if (HANGUL_RE.test(run)) {
			out.push(...segmentHangul(run));
		} else if (KANA_RE.test(run)) {
			out.push(...segmentKana(run));
		} else {
			out.push(...segmentHan(run));
		}

		cursor = end;
	}

	// Add trailing non-CJK text
	if (cursor < text.length) {
		const trailing = text.slice(cursor).trim();
		if (trailing) out.push(trailing);
	}

	return out;
}

/**
 * Reset state (for testing)
 */
export function __resetCjkSegmenterStateForTests(): void {
	jiebaInstance = null;
	jiebaLoaded = false;
	jaSegmenterInstance = null;
	jaSegmenterLoaded = false;
}
