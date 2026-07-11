/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — AutoSet
 *
 *  Port of `hyperextract/types/set.py::AutoSet`. A deduplicated collection
 *  of items where each item is uniquely keyed (via `keyExtractor`). Supports
 *  set operations (union / intersect / diff) and the full lifecycle:
 *  extract → merge-dedup → build vector index → search → chat → serialize.
 *
 *  Implemented as a thin OMem wrapper; the only difference from AutoList is
 *  that AutoSet exposes set-algebra operations and defaults to a KEEP-first
 *  merge strategy (first occurrence wins on duplicates).
 *--------------------------------------------------------------------------------------------*/

import { BaseAutoType } from './base.js';
import { OMem } from './omem.js';
import { IMerger, MergeStrategy } from './merge.js';
import {
	AutoTypeConfig, JsonSchema, KeyExtractor, KnowledgeItem, filterValidItems, listSchema,
} from './types.js';
import { IChatModel } from './llm.js';
import { IEmbedder } from './embedder.js';

export interface AutoSetDeps {
	llm: IChatModel;
	embedder: IEmbedder;
	itemSchema: JsonSchema;
	keyExtractor: KeyExtractor;
	config?: AutoTypeConfig;
	strategy?: MergeStrategy | IMerger<KnowledgeItem>;
	fieldsForIndex?: string[];
	prompt?: string;
}

const DEFAULT_SET_PROMPT =
	'You are an expert knowledge extraction assistant. ' +
	'Extract all unique items from the text into a set. ' +
	'Be exhaustive and ensure no item is missed.\n\n' +
	'### Source Text:\n{source_text}';

function render(tpl: string, vars: Record<string, string>): string {
	return tpl.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}

export class AutoSet extends BaseAutoType<{ items: KnowledgeItem[] }> {
	private readonly itemSchema: JsonSchema;
	private readonly keyExtractor: KeyExtractor;
	private memory!: OMem<KnowledgeItem>;

	constructor(private readonly sdeps: AutoSetDeps) {
		super({ llm: sdeps.llm, embedder: sdeps.embedder, config: { ...sdeps.config, prompt: sdeps.prompt ?? sdeps.config?.prompt } });
		this.itemSchema = sdeps.itemSchema;
		this.keyExtractor = sdeps.keyExtractor;
		this.memory = new OMem<KnowledgeItem>({
			keyExtractor: this.keyExtractor,
			itemSchema: this.itemSchema,
			llm: sdeps.llm,
			embedder: sdeps.embedder,
			// Default: keep first occurrence on dedup (set semantics).
			strategy: sdeps.strategy ?? MergeStrategy.SIMPLE,
			fieldsForIndex: sdeps.fieldsForIndex,
		});
		this._initDataState();
		this._initIndexState();
	}

	protected _defaultPrompt(): string { return DEFAULT_SET_PROMPT; }

	get data(): { items: KnowledgeItem[] } { return { items: this.memory.all }; }
	get items(): KnowledgeItem[] { return this.memory.all; }
	get size(): number { return this.memory.size; }

	empty(): boolean { return this.memory.empty(); }

	protected _initDataState(): void { this.memory?.clear(); }

	protected async _setDataState(data: { items: KnowledgeItem[] }): Promise<void> {
		this.memory.clear();
		if (data.items?.length) { await this.memory.add(data.items); }
		this.clearIndex();
	}

	protected async _updateDataState(data: { items: KnowledgeItem[] }): Promise<void> {
		if (data.items?.length) { await this.memory.add(data.items); }
		this.clearIndex();
	}

	protected _initIndexState(): void { this.memory?.clearIndex(); }

	protected async _extractOne(text: string): Promise<{ items: KnowledgeItem[] } | null> {
		const rendered = render(this.prompt, { source_text: text });
		try {
			const r = await this.llm.extract<{ items: KnowledgeItem[] }>({
				prompt: rendered,
				schema: listSchema(this.itemSchema, 'Extracted items'),
			});
			return { items: filterValidItems(r?.items, this.itemSchema) };
		} catch {
			return { items: [] };
		}
	}

	mergeBatchData(list: { items: KnowledgeItem[] }[]): { items: KnowledgeItem[] } {
		return { items: list.flatMap(x => x.items ?? []) };
	}

	async buildIndex(): Promise<void> {
		if (this.empty()) { return; }
		await this.memory.buildIndex();
	}

	async search(query: string, topK = 3): Promise<KnowledgeItem[]> {
		if (!this.memory.hasIndex()) {
			throw new Error('Set index not built. Call buildIndex() first.');
		}
		return this.memory.search(query, topK);
	}

	// ── Set operations ──────────────────────────────────────────────

	/** Union: all items from this set AND another (dedup by key). */
	async union(other: AutoSet): Promise<AutoSet> {
		const out = new AutoSet({ ...this.sdeps, strategy: MergeStrategy.SIMPLE });
		await out.memory.add([...this.items, ...other.items]);
		return out;
	}

	/** Intersection: items present in BOTH sets (by key). */
	async intersect(other: AutoSet): Promise<AutoSet> {
		const otherKeys = new Set(other.items.map(it => this.keyExtractor(it)));
		const common = this.items.filter(it => otherKeys.has(this.keyExtractor(it)));
		const out = new AutoSet({ ...this.sdeps, strategy: MergeStrategy.SIMPLE });
		if (common.length) { await out.memory.add(common); }
		return out;
	}

	/** Difference: items in this set but NOT in the other (by key). */
	async diff(other: AutoSet): Promise<AutoSet> {
		const otherKeys = new Set(other.items.map(it => this.keyExtractor(it)));
		const diff = this.items.filter(it => !otherKeys.has(this.keyExtractor(it)));
		const out = new AutoSet({ ...this.sdeps, strategy: MergeStrategy.SIMPLE });
		if (diff.length) { await out.memory.add(diff); }
		return out;
	}

	protected _dumpData(): unknown { return { items: this.memory.dumpData() }; }

	protected _loadData(data: unknown): void {
		const d = (data ?? {}) as { items?: KnowledgeItem[] };
		this.memory.loadData(d.items ?? []);
		this.clearIndex();
	}

	protected async _dumpIndex(): Promise<unknown | undefined> {
		if (!this.memory.hasIndex()) { return undefined; }
		return { index: this.memory.dumpIndex() };
	}

	protected async _loadIndex(data: unknown): Promise<void> {
		const d = (data ?? {}) as { index?: { texts: string[]; vectors: number[][] } };
		if (d.index) { this.memory.loadIndex(d.index); }
	}

	protected _createEmptyInstance(): BaseAutoType<{ items: KnowledgeItem[] }> {
		return new AutoSet(this.sdeps);
	}

	override toMarkdown(opts: { title?: string } = {}): string {
		const lines: string[] = [];
		lines.push(`# ${opts.title ?? 'Knowledge Set'}`, '');
		lines.push(`> ${this.items.length} unique items.`, '');
		for (const it of this.items) {
			const heading = String(it['title'] ?? it['name'] ?? it['term'] ?? 'Item');
			lines.push(`- **${heading}**`);
			for (const [k, v] of Object.entries(it)) {
				if (['title', 'name', 'term'].includes(k)) { continue; }
				if (v !== undefined && v !== null && v !== '') {
					lines.push(`  - ${k}: ${Array.isArray(v) ? (v as unknown[]).join(', ') : String(v)}`);
				}
			}
		}
		return lines.join('\n');
	}
}
