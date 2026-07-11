/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — BaseAutoType
 *
 *  Faithul port of `hyperextract/types/base.py::BaseAutoType`.
 *  Provides the unified lifecycle (extract → merge → index → search → chat →
 *  serialize). Subclasses implement the abstract hooks; the generic single-stage
 *  `_extractData` uses `_extractOne` per chunk so simple types (AutoList /
 *  AutoModel) work out-of-the-box, while AutoGraph overrides `_extractData`
 *  for its two-stage pipeline (mirrors the Python design).
 *--------------------------------------------------------------------------------------------*/

import { IChatModel } from './llm.js';
import { IEmbedder } from './embedder.js';
import { RecursiveCharacterTextSplitter } from './textSplitter.js';
import {
	AutoTypeConfig, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP, DEFAULT_MAX_WORKERS,
	KnowledgeItem, summarizeItem,
} from './types.js';

/** Run an async mapper over `items` with bounded concurrency. */
export async function batch<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < items.length) {
			const i = cursor++;
			out[i] = await fn(items[i], i);
		}
	}
	const n = Math.max(1, Math.min(concurrency || 1, items.length || 1));
	await Promise.all(Array.from({ length: n }, () => worker()));
	return out;
}

/** Serialized form of a knowledge base (engine-agnostic; the glue persists it). */
export interface SerializedKB {
	data: unknown;
	metadata: Record<string, unknown>;
	index?: unknown;
}

export interface BaseDeps {
	llm: IChatModel;
	embedder: IEmbedder;
	config?: AutoTypeConfig;
}

export abstract class BaseAutoType<T extends KnowledgeItem> {
	protected readonly llm: IChatModel;
	protected readonly embedder: IEmbedder;
	protected prompt: string;
	protected readonly chunkSize: number;
	protected readonly chunkOverlap: number;
	protected readonly maxWorkers: number;
	protected readonly verbose: boolean;
	protected readonly splitter: RecursiveCharacterTextSplitter;
	protected readonly metadata: Record<string, unknown> = {
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	constructor(deps: BaseDeps) {
		this.llm = deps.llm;
		this.embedder = deps.embedder;
		this.chunkSize = deps.config?.chunkSize ?? DEFAULT_CHUNK_SIZE;
		this.chunkOverlap = deps.config?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
		this.maxWorkers = deps.config?.maxWorkers ?? DEFAULT_MAX_WORKERS;
		this.verbose = deps.config?.verbose ?? false;
		this.prompt = deps.config?.prompt ?? this._defaultPrompt();

		this.splitter = new RecursiveCharacterTextSplitter({
			chunkSize: this.chunkSize,
			chunkOverlap: this.chunkOverlap,
		});

		this._initDataState();
		this._initIndexState();
	}

	// ── Abstract hooks ─────────────────────────────

	protected abstract _defaultPrompt(): string;
	abstract get data(): T;
	abstract empty(): boolean;
	protected abstract _initDataState(): void;
	protected abstract _setDataState(data: T): Promise<void>;
	protected abstract _updateDataState(data: T): Promise<void>;
	protected abstract _initIndexState(): void;
	/** Extract a single knowledge object from ONE chunk. */
	protected abstract _extractOne(text: string): Promise<T | null>;
	/** Merge multiple extracted objects into one. */
	protected abstract mergeBatchData(list: T[]): T;
	abstract buildIndex(): Promise<void>;
	abstract search(query: string, topK?: number): Promise<unknown[]>;

	/**
	 * Export the knowledge as Markdown (Obsidian-style). Overridden by
	 * subclasses that support it (e.g. AutoGraph). The base default throws
	 * so callers get a clear "not supported" error for list/model types.
	 */
	toMarkdown(_opts?: { title?: string; mermaid?: boolean; wikilinks?: boolean }): string {
		throw new Error('toMarkdown is not supported by this knowledge template.');
	}
	protected abstract _dumpData(): unknown;
	protected abstract _loadData(data: unknown): void;
	protected abstract _dumpIndex(): Promise<unknown | undefined>;
	protected abstract _loadIndex(data: unknown): Promise<void>;
	/** Build an empty instance with identical configuration (for parse/feed/+). */
	protected abstract _createEmptyInstance(): BaseAutoType<T>;

	// ── Extraction pipeline (generic single-stage) ─────────────────────────────

	protected async _extractData(text: string): Promise<T> {
		let rawList: (T | null)[];
		if (text.length <= this.chunkSize) {
			const one = await this._extractOne(text);
			rawList = [one];
		} else {
			const chunks = this.splitter.withOverlap(this.splitter.splitText(text));
			if (this.verbose) { console.log(`[BaseAutoType] split into ${chunks.length} chunks`); }
			rawList = await batch(chunks, this.maxWorkers, (c) => this._extractOne(c));
		}
		const list = this._filterNone(rawList);
		return this.mergeBatchData(list);
	}

	protected _filterNone(list: (T | null)[]): T[] {
		return list.filter((x): x is T => x !== null && x !== undefined);
	}

	// ── Public ingestion API ─────────────────────────────

	/** Extract into a NEW instance (does not mutate this one). */
	async parse(text: string): Promise<BaseAutoType<T>> {
		const parsed = await this._extractData(text);
		const inst = this._createEmptyInstance();
		await inst._setDataState(parsed);
		inst.metadata['createdAt'] = new Date().toISOString();
		inst.metadata['updatedAt'] = new Date().toISOString();
		return inst;
	}

	/** Ingest into THIS instance (chained: `ka.feedText(a).feedText(b)`). */
	async feedText(text: string): Promise<this> {
		const extracted = await this._extractData(text);
		await this._updateDataState(extracted);
		this.metadata['updatedAt'] = new Date().toISOString();
		return this;
	}

	clear(): void {
		this._initDataState();
		this._initIndexState();
		this.metadata['updatedAt'] = new Date().toISOString();
	}

	clearIndex(): void {
		this._initIndexState();
	}

	// ── RAG chat ─────────────────────────────

	async chat(query: string, topK = 3): Promise<{ text: string; retrieved: unknown[] }> {
		const results = await this.search(query, topK);
		const context = this._buildChatContext(results);

		const answer = await this.llm.complete(
			'Based on the following knowledge, answer the user\'s question. ' +
			'If the knowledge does not contain the answer, say so.',
			`Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
		);
		return { text: answer, retrieved: results };
	}

	/**
	 * Streaming RAG chat (Phase 4.1).
	 * Calls `onToken` for each token delta as the LLM generates the answer.
	 * Returns the full accumulated text.
	 *
	 * Falls back to non-streaming `chat()` if the LLM doesn't support `streamComplete`.
	 */
	async chatStream(
		query: string,
		onToken: (token: string, accumulated: string) => boolean | void,
		topK = 3,
	): Promise<{ text: string; retrieved: unknown[] }> {
		const results = await this.search(query, topK);
		const context = this._buildChatContext(results);

		if (this.llm.streamComplete) {
			const answer = await this.llm.streamComplete(
				'Based on the following knowledge, answer the user\'s question. ' +
				'If the knowledge does not contain the answer, say so.',
				`Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
				onToken,
			);
			return { text: answer, retrieved: results };
		}

		// Fallback: non-streaming
		const answer = await this.llm.complete(
			'Based on the following knowledge, answer the user\'s question. ' +
			'If the knowledge does not contain the answer, say so.',
			`Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
		);
		onToken(answer, answer);
		return { text: answer, retrieved: results };
	}

	private _buildChatContext(results: unknown[]): string {
		return results.length === 0
			? 'No relevant information found in the knowledge base.'
			: results
				.map((r, i) => `--- Item ${i + 1} ---\n${formatItem(r)}`)
				.join('\n');
	}

	// ── Serialization ─────────────────────────────

	async serialize(): Promise<SerializedKB> {
		const index = await this._dumpIndex();
		return {
			data: this._dumpData(),
			metadata: { ...this.metadata },
			...(index !== undefined ? { index } : {}),
		};
	}

	async deserialize(payload: SerializedKB): Promise<void> {
		this._loadData(payload.data);
		if (payload.metadata) {
			this.metadata['createdAt'] = payload.metadata['createdAt'] ?? this.metadata['createdAt'];
			this.metadata['updatedAt'] = payload.metadata['updatedAt'] ?? new Date().toISOString();
		}
		if (payload.index !== undefined) {
			await this._loadIndex(payload.index);
		}
	}
}

/** Best-effort JSON rendering of a retrieved item for RAG context. */
function formatItem(r: unknown): string {
	try {
		if (r && typeof r === 'object') { return JSON.stringify(r, null, 2); }
		return String(r);
	} catch {
		return String(r);
	}
}

export { summarizeItem };
