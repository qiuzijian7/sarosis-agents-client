/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — AutoList
 *
 *  Port of the simple list AutoType (`hyperextract/types/list.py`-style).
 *  Extracts a flat list of homogeneous records (entities / facts / items) with
 *  a single-stage per-chunk extraction, keyed dedup/merge via one OMem store,
 *  a vector index, semantic search, and RAG chat inherited from BaseAutoType.
 *
 *  This is the lightweight counterpart to AutoGraph: no edges, no two-stage
 *  pipeline — ideal for glossaries, FAQ banks, requirement lists, etc.
 *--------------------------------------------------------------------------------------------*/

import { BaseAutoType } from './base.js';
import { OMem } from './omem.js';
import { IMerger, MergeStrategy } from './merge.js';
import {
	AutoTypeConfig, JsonSchema, KeyExtractor, KnowledgeItem, filterValidItems, listSchema,
} from './types.js';
import { IChatModel } from './llm.js';
import { IEmbedder } from './embedder.js';
import { getPrompt } from './i18nPrompts.js';

export interface AutoListDeps {
	llm: IChatModel;
	embedder: IEmbedder;
	itemSchema: JsonSchema;
	keyExtractor: KeyExtractor;
	config?: AutoTypeConfig;
	strategy?: MergeStrategy | IMerger<KnowledgeItem>;
	fieldsForIndex?: string[];
	/** One-stage extraction prompt. `{source_text}` is substituted. */
	prompt?: string;
}

// Default list prompt now lives in the i18n catalog (i18nPrompts.ts), keyed `default.list`.

function render(tpl: string, vars: Record<string, string>): string {
	return tpl.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}

export class AutoList extends BaseAutoType<{ items: KnowledgeItem[] }> {
	private readonly itemSchema: JsonSchema;
	private readonly keyExtractor: KeyExtractor;
	private memory!: OMem<KnowledgeItem>;

	constructor(private readonly ldeps: AutoListDeps) {
		super({ llm: ldeps.llm, embedder: ldeps.embedder, config: { ...ldeps.config, prompt: ldeps.prompt ?? ldeps.config?.prompt } });
		this.itemSchema = ldeps.itemSchema;
		this.keyExtractor = ldeps.keyExtractor;
		this.memory = new OMem<KnowledgeItem>({
			keyExtractor: this.keyExtractor,
			itemSchema: this.itemSchema,
			llm: ldeps.llm,
			embedder: ldeps.embedder,
			strategy: ldeps.strategy ?? MergeStrategy.BALANCED,
			fieldsForIndex: ldeps.fieldsForIndex,
		});
		this._initDataState();
		this._initIndexState();
	}

	protected _defaultPrompt(): string { return getPrompt('default.list'); }

	get data(): { items: KnowledgeItem[] } { return { items: this.memory.all }; }
	get items(): KnowledgeItem[] { return this.memory.all; }

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
			// Drop malformed records (missing required fields) before they enter OMem.
			return { items: filterValidItems(r?.items, this.itemSchema) };
		} catch (e) {
			if (this.verbose) { console.warn('[AutoList] extract failed:', e); }
			return null;
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
			throw new Error('List index not built. Call buildIndex() first.');
		}
		return this.memory.search(query, topK);
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
		return new AutoList(this.ldeps);
	}

	/**
	 * Export the list as portable Markdown. Each item becomes a bullet / sub-heading
	 * driven by its schema fields; array fields render as nested bullets. This makes
	 * list / model / set / hypergraph (multi-participant) templates exportable,
	 * mirroring `AutoGraph.toMarkdown`.
	 */
	override toMarkdown(opts: { title?: string; mermaid?: boolean; wikilinks?: boolean } = {}): string {
		const items = this.items;
		const title = opts.title ?? 'Knowledge List';
		const lines: string[] = [];
		lines.push(`# ${title}`, '');
		lines.push(`> AutoList export — ${items.length} item(s).`, '');
		if (!items.length) {
			lines.push('_No items extracted._', '');
			return lines.join('\n');
		}
		for (const it of items) {
			const heading = String(it['title'] ?? it['name'] ?? it['item'] ?? it['question'] ?? it['term'] ?? 'Item');
			lines.push(`- **${heading}**`);
			for (const [k, v] of Object.entries(it)) {
				if (['title', 'name', 'item', 'question', 'term'].includes(k)) { continue; }
				if (Array.isArray(v)) {
					if (v.length) {
						lines.push(`  - ${k}:`);
						for (const sub of v) { lines.push(`    - ${String(sub)}`); }
					}
				} else if (v !== undefined && v !== '') {
					lines.push(`  - ${k}: ${String(v)}`);
				}
			}
			lines.push('');
		}
		return lines.join('\n');
	}
}
