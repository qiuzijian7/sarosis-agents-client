/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — RecursiveCharacterTextSplitter
 *
 *  Faithful port of `langchain_text_splitters.RecursiveCharacterTextSplitter`
 *  with the same CJK-friendly separator list used by `hyperextract/types/base.py`.
 *--------------------------------------------------------------------------------------------*/

export interface TextSplitterOptions {
	chunkSize?: number;
	chunkOverlap?: number;
	separators?: string[];
}

const DEFAULT_SEPARATORS = [
	'\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', ' ', '',
];

/**
 * Recursively splits text into chunks bounded by `chunkSize`, preserving
 * `chunkOverlap` characters of context between consecutive chunks.
 */
export class RecursiveCharacterTextSplitter {
	private readonly chunkSize: number;
	private readonly chunkOverlap: number;
	private readonly separators: string[];

	constructor(opts: TextSplitterOptions = {}) {
		this.chunkSize = opts.chunkSize ?? 2048;
		this.chunkOverlap = opts.chunkOverlap ?? 256;
		this.separators = opts.separators ?? DEFAULT_SEPARATORS;
		if (this.chunkOverlap >= this.chunkSize) {
			throw new Error('chunkOverlap must be smaller than chunkSize');
		}
	}

	splitText(text: string): string[] {
		const normalized = text.length > 0 ? text : '';
		if (normalized.length <= this.chunkSize) {
			return normalized.length > 0 ? [normalized] : [];
		}
		return this._split(normalized, this.separators);
	}

	private _split(text: string, separators: string[]): string[] {
		if (text.length <= this.chunkSize) {
			return text.length > 0 ? [text] : [];
		}
		const sep = separators[0];
		const rest = separators.slice(1);
		if (sep === '') {
			// Character-level fallback split.
			const out: string[] = [];
			for (let i = 0; i < text.length; i += this.chunkSize) {
				out.push(text.slice(i, i + this.chunkSize));
			}
			return out;
		}
		const segments = text.split(sep);
		const good: string[] = [];
		const next: string[] = [];
		let current = '';
		for (const seg of segments) {
			const piece = current.length > 0 ? current + sep + seg : seg;
			if (piece.length > this.chunkSize) {
				if (current.length > 0) { good.push(current); current = ''; }
				if (sep && !rest.every(s => s === '')) {
					next.push(...this._split(piece, rest));
				} else {
					// No more separators — hard split.
					for (let i = 0; i < piece.length; i += this.chunkSize) {
						next.push(piece.slice(i, i + this.chunkSize));
					}
				}
			} else {
				current = piece;
			}
		}
		if (current.length > 0) { good.push(current); }
		const result = [...good, ...next].filter(c => c.length > 0);
		return this._mergeSmall(result);
	}

	/** Merge adjacent chunks that are far below chunkSize to reduce fragmentation. */
	private _mergeSmall(chunks: string[]): string[] {
		if (chunks.length <= 1) { return chunks; }
		const merged: string[] = [];
		let buf = chunks[0];
		for (let i = 1; i < chunks.length; i++) {
			const candidate = buf + (buf && !buf.endsWith('\n') ? '\n' : '') + chunks[i];
			if (candidate.length <= this.chunkSize) {
				buf = candidate;
			} else {
				merged.push(buf);
				buf = chunks[i];
			}
		}
		merged.push(buf);
		return merged;
	}

	/** Apply overlap window between chunks (post-process split boundaries). */
	withOverlap(chunks: string[]): string[] {
		if (this.chunkOverlap <= 0 || chunks.length <= 1) { return chunks; }
		const out: string[] = [];
		for (let i = 0; i < chunks.length; i++) {
			let chunk = chunks[i];
			if (i > 0) {
				const prev = chunks[i - 1];
				const tail = prev.slice(Math.max(0, prev.length - this.chunkOverlap));
				chunk = tail + chunk;
			}
			out.push(chunk);
		}
		return out;
	}
}
