/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — OMem (vector-backed knowledge store)
 *
 *  Port of `ontomem.OMem`. Holds items keyed by `key_extractor`,
 *  provides deduplicating `add`/`merge`, a buildable vector index, and
 *  semantic `search`. This is the TS replacement for the Python `ontomem`
 *  dependency (which itself wrapped FAISS + a merge strategy).
 *--------------------------------------------------------------------------------------------*/

import { IChatModel } from './llm.js';
import { IEmbedder } from './embedder.js';
import { VectorIndex, SplitIndex } from './vectorIndex.js';
import { IMerger, MergeStrategy, createMerger } from './merge.js';
import { JsonSchema, KnowledgeItem, KeyExtractor } from './types.js';

export interface OMemOptions<T extends KnowledgeItem = KnowledgeItem> {
	keyExtractor: KeyExtractor;
	itemSchema: JsonSchema;
	llm: IChatModel;
	embedder: IEmbedder;
	/** Merge strategy for duplicate items, or a custom merger instance (default: BALANCED). */
	strategy?: MergeStrategy | IMerger<T>;
	verbose?: boolean;
	/**
	 * Which text fields to embed for the index. If omitted, ALL string/number
	 * fields are concatenated. Mirrors `fields_for_index`.
	 */
	fieldsForIndex?: string[];
}

/**
 * TS analogue of `ontomem.OMem` — a keyed item store with a vector index
 * and LLM/ deterministic merge. Generic over `T` (a knowledge item).
 */
export class OMem<T extends KnowledgeItem> {
	private items: T[] = [];
	private readonly byKey = new Map<string, T>();
	private readonly index: VectorIndex = new SplitIndex();
	private readonly merger: IMerger<T>;
	/**
	 * Embedding cache keyed by the indexed text. Survives `clearIndex()` (which
	 * only invalidates the search index after a data change) so that repeated
	 * `buildIndex()` calls after incremental `feedText` skip re-embedding
	 * unchanged items — avoiding O(n²) embedder calls when ingesting many docs.
	 */
	private readonly vectorCache = new Map<string, number[]>();
	/**
	 * Phase 4.2: Set of item keys that have already been added to the vector index.
	 * Enables incremental `buildIndex()` — only embed + add new items, skip existing.
	 * Cleared when the index is fully rebuilt (e.g. after loadData / clearIndex).
	 */
	private readonly _indexedKeys = new Set<string>();

	constructor(private readonly opt: OMemOptions<T>) {
		this.merger = createMerger<T>(
			opt.strategy ?? MergeStrategy.BALANCED,
			opt.keyExtractor,
			opt.llm,
			opt.itemSchema,
		);
	}

	get all(): T[] { return this.items.slice(); }
	get size(): number { return this.items.length; }
	empty(): boolean { return this.items.length === 0; }
	keys(): Set<string> { return new Set(this.byKey.keys()); }

	clear(): void {
		this.items = [];
		this.byKey.clear();
		this.clearIndex();
		this.vectorCache.clear();
		this._indexedKeys.clear();
	}

	clearIndex(): void {
		this.index.clear();
		this._indexedKeys.clear();
	}

	private _fieldsToIndex(item: T): string {
		const fields = this.opt.fieldsForIndex;
		const parts: string[] = [];
		for (const [k, v] of Object.entries(item)) {
			if (fields && !fields.includes(k)) { continue; }
			if (typeof v === 'string' && (v as string).trim()) { parts.push(v as string); }
			else if (typeof v === 'number' || typeof v === 'boolean') { parts.push(String(v)); }
		}
		return parts.join(' | ');
	}

	/** Merge `items` into the store, deduplicating against existing items. */
	async add(items: T[]): Promise<void> {
		if (!items || items.length === 0) { return; }
		const merged = await this.merger.merge([...this.items, ...items]);
		this.items = merged;
		this.byKey.clear();
		for (const it of merged) {
			this.byKey.set(this.opt.keyExtractor(it) ?? '', it);
		}
		this.clearIndex();
	}

	/** (Re)build the vector index over current items. */
	async buildIndex(): Promise<void> {
		await this.buildIndexIncremental();
	}

	/**
	 * Phase 4.2: Incremental index build.
	 * Only embeds and adds items whose keys have not yet been indexed.
	 * Falls back to full rebuild when the index is empty (first build or after clear).
	 */
	async buildIndexIncremental(): Promise<void> {
		if (this.empty()) { return; }
		const allTexts = this.items.map(it => this._fieldsToIndex(it));

		// Full rebuild needed if index is completely empty
		const needsFullRebuild = this.index.size() === 0 || this._indexedKeys.size === 0;
		if (needsFullRebuild) {
			return this._fullRebuild(allTexts);
		}

		// Incremental: find new items (keys not yet indexed)
		const newItems: { idx: number; text: string }[] = [];
		for (let i = 0; i < this.items.length; i++) {
			const key = this.opt.keyExtractor(this.items[i]) ?? '';
			if (!this._indexedKeys.has(key)) {
				newItems.push({ idx: i, text: allTexts[i] });
			}
		}

		if (newItems.length === 0) { return; } // nothing new

		// Embed only new items
		const newTexts = newItems.map(n => n.text);
		const emb = await this.opt.embedder.embed(newTexts);
		this.index.add(newTexts, emb);

		// Cache embeddings & mark as indexed
		for (let j = 0; j < newItems.length; j++) {
			this.vectorCache.set(newTexts[j], emb[j]);
			const key = this.opt.keyExtractor(this.items[newItems[j].idx]) ?? '';
			this._indexedKeys.add(key);
		}

		// Rebuild cluster structure after adding (SplitIndex K-Means)
		this.index.build?.();

		const totalKeys = this._indexedKeys.size;
		if (this.opt.verbose) {
			console.log(`[OMem] incrementally added ${newItems.length} items; total indexed=${totalKeys}`);
		}
	}

	/**
	 * Full rebuild: clear index, embed all items, rebuild.
	 * Used on first build or after clearIndex/loadData.
	 */
	private async _fullRebuild(allTexts: string[]): Promise<void> {
		const vectors: number[][] = new Array(allTexts.length);
		const missIdx: number[] = [];
		const missTxt: string[] = [];
		for (let i = 0; i < allTexts.length; i++) {
			const cached = this.vectorCache.get(allTexts[i]);
			if (cached) {
				vectors[i] = cached;
			} else {
				missIdx.push(i);
				missTxt.push(allTexts[i]);
			}
		}
		if (missTxt.length) {
			const emb = await this.opt.embedder.embed(missTxt);
			for (let j = 0; j < missIdx.length; j++) {
				vectors[missIdx[j]] = emb[j];
				this.vectorCache.set(missTxt[j], emb[j]);
			}
		}
		this.index.clear();
		this._indexedKeys.clear();
		this.index.add(allTexts, vectors);
		// Mark all items as indexed
		for (const item of this.items) {
			this._indexedKeys.add(this.opt.keyExtractor(item) ?? '');
		}
		this.index.build?.();
	}

	hasIndex(): boolean { return this.index.size() > 0; }

	/** Semantic search; requires `buildIndex()` first. */
	async search(query: string, topK: number): Promise<T[]> {
		if (!this.hasIndex()) {
			throw new Error('OMem index not built. Call buildIndex() first.');
		}
		const qv = await this.opt.embedder.embedOne(query);
		const hits = this.index.search(qv, topK);
		return hits
			.map(h => this.items[h.index])
			.filter((x): x is T => !!x);
	}

	// ── Serialization ─────────────────────────────

	dumpData(): T[] { return this.items.slice(); }

	loadData(items: T[]): void {
		this.items = (items ?? []).slice();
		this.byKey.clear();
		for (const it of this.items) {
			this.byKey.set(this.opt.keyExtractor(it) ?? '', it);
		}
		this.clearIndex();
		this.vectorCache.clear();
		this._indexedKeys.clear();
	}

	dumpIndex(): { texts: string[]; vectors: number[][] } {
		return this.index.dump();
	}

	loadIndex(data: { texts: string[]; vectors: number[][] }): void {
		this.index.load(data);
	}
}
