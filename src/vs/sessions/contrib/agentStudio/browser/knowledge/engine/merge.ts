/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — Merge strategies
 *
 *  Port of `ontomem.merger` (`MergeStrategy` + `create_merger`).
 *  Two strategies are provided:
 *    - SIMPLE : deterministic key-based dedup (keep first), no LLM.
 *    - LLM    : group by key, ask the model to intelligently fuse duplicates
 *               into one richer record (mirrors `MergeStrategy.LLM.BALANCED`).
 *--------------------------------------------------------------------------------------------*/

import { IChatModel } from './llm.js';
import { JsonSchema, KnowledgeItem, KeyExtractor } from './types.js';

export enum MergeStrategy {
	/** LLM-powered intelligent merge of duplicates. */
	LLM = 'llm',
	/** Deterministic dedup, first occurrence wins. */
	SIMPLE = 'simple',
	/**
	 * Balanced: deterministic field-level merge first; only groups with real
	 * field conflicts (same field, different non-empty values) are sent to the
	 * LLM. Mirrors `ontomem.merger.MergeStrategy.LLM.BALANCED`.
	 */
	BALANCED = 'balanced',
	/**
	 * LLM fusion that prefers the FIRST (existing) record's values when
	 * conflicting. Mirrors `MergeStrategy.LLM.PREFER_EXISTING`.
	 */
	PREFER_EXISTING = 'prefer_existing',
	/**
	 * LLM fusion that prefers the LAST (incoming) record's values when
	 * conflicting. Mirrors `MergeStrategy.LLM.PREFER_INCOMING`.
	 */
	PREFER_INCOMING = 'prefer_incoming',
	/**
	 * LLM fusion driven by a DECLARATIVE `rule` string (e.g. a
	 * domain-specific instruction like "merge only if the same wikidata id").
	 * Mirrors `MergeStrategy.LLM.CUSTOM_RULE` in ontomem / the GraphRAG
	 * node-merge rule (`GRAPH_RAG_NODE_MERGE_RULE`). The rule is injected
	 * into the merge system prompt so callers can steer dedup without code.
	 */
	CUSTOM_RULE = 'custom_rule',
}

export interface IMerger<T extends KnowledgeItem> {
	merge(items: T[]): Promise<T[]>;
}

const MERGE_SYSTEM = [
	'You are a knowledge-deduplication expert.',
	'You will be given several JSON records that all refer to the SAME entity',
	'(they share the same identity key). Fuse them into ONE JSON record that',
	'combines their information without contradiction or redundancy.',
	'Prefer more specific / non-empty values. Keep the merged object valid for the schema.',
	'Respond with the single merged JSON object only.',
].join(' ');

/**
 * Deterministic deduplication. Items sharing a key are collapsed to the first
 * occurrence. O(n) and free of LLM calls.
 */
export class SimpleMerger<T extends KnowledgeItem> implements IMerger<T> {
	constructor(private readonly keyExtractor: KeyExtractor) {}

	async merge(items: T[]): Promise<T[]> {
		const seen = new Set<string>();
		const out: T[] = [];
		for (const it of items) {
			const key = this.keyExtractor(it);
			if (key === undefined || key === null || key === '' || seen.has(key)) { continue; }
			seen.add(key);
			out.push(it);
		}
		return out;
	}
}

/**
 * LLM-powered merge. Items are grouped by key; any group with >1 member is
 * sent to the model to be fused into a single record. Groups of size 1 pass
 * through unchanged (no wasted LLM calls).
 */
export class LlmMerger<T extends KnowledgeItem> implements IMerger<T> {
	constructor(
		private readonly keyExtractor: KeyExtractor,
		private readonly llm: IChatModel,
		private readonly itemSchema: JsonSchema,
	) {}

	async merge(items: T[]): Promise<T[]> {
		if (items.length === 0) { return []; }

		// Group by key, preserving order of first appearance.
		const groups = new Map<string, T[]>();
		for (const it of items) {
			const key = this.keyExtractor(it) ?? '';
			const g = groups.get(key);
			if (g) { g.push(it); } else { groups.set(key, [it]); }
		}

		const out: T[] = [];
		for (const [, group] of groups) {
			if (group.length === 1) { out.push(group[0]); continue; }
			try {
				const merged = await this.llm.extract<T>({
					system: MERGE_SYSTEM,
					prompt:
						`Schema:\n${JSON.stringify(this.itemSchema)}\n\n` +
						`Duplicate records to fuse (JSON array):\n${JSON.stringify(group)}`,
					schema: this.itemSchema,
				});
				out.push(merged);
			} catch (e) {
				// On failure, keep the first occurrence (graceful degradation).
				console.warn('[LlmMerger] merge failed, keeping first:', e);
				out.push(group[0]);
			}
		}
		return out;
	}
}

/**
 * Balanced merge. Items are grouped by key; each group is first attempted as a
 * deterministic field-level merge (no conflict → no LLM call). Only groups where
 * the same field has conflicting non-empty values across records are sent to the
 * LLM for fusion. This dramatically cuts LLM calls when duplicate entities are
 * extracted identically across chunks (the common case).
 */
export class BalancedMerger<T extends KnowledgeItem> implements IMerger<T> {
	constructor(
		private readonly keyExtractor: KeyExtractor,
		private readonly llm: IChatModel,
		private readonly itemSchema: JsonSchema,
	) {}

	async merge(items: T[]): Promise<T[]> {
		if (items.length === 0) { return []; }

		// Group by key, preserving order of first appearance.
		const groups = new Map<string, T[]>();
		for (const it of items) {
			const key = this.keyExtractor(it) ?? '';
			const g = groups.get(key);
			if (g) { g.push(it); } else { groups.set(key, [it]); }
		}

		const out: T[] = [];
		for (const [, group] of groups) {
			if (group.length === 1) { out.push(group[0]); continue; }
			// Try a conflict-free deterministic merge first.
			const det = deterministicMerge(group);
			if (det !== undefined) { out.push(det as T); continue; }
			// Real conflict → LLM fuse.
			try {
				const merged = await this.llm.extract<T>({
					system: MERGE_SYSTEM,
					prompt:
						`Schema:\n${JSON.stringify(this.itemSchema)}\n\n` +
						`Duplicate records to fuse (JSON array):\n${JSON.stringify(group)}`,
					schema: this.itemSchema,
				});
				out.push(merged);
			} catch (e) {
				// On failure, keep the first occurrence (graceful degradation).
				console.warn('[BalancedMerger] LLM fuse failed, keeping first:', e);
				out.push(group[0]);
			}
		}
		return out;
	}
}

/**
 * Attempt a deterministic, conflict-free field-level merge of a group of records
 * that share a key. For each field, collect distinct non-empty values (objects/
 * arrays compared by their JSON string). If any field has more than one distinct
 * value, there is a conflict → return `undefined`. Otherwise return an object
 * holding the single non-empty value per field.
 */
function deterministicMerge<T extends KnowledgeItem>(group: T[]): KnowledgeItem | undefined {
	// field name -> (normalized key -> original value)
	const fields = new Map<string, Map<string, unknown>>();
	for (const it of group) {
		for (const [k, v] of Object.entries(it)) {
			if (v === undefined || v === null || v === '') { continue; }
			let m = fields.get(k);
			if (!m) { m = new Map(); fields.set(k, m); }
			const norm = (typeof v === 'object') ? JSON.stringify(v) : String(v);
			if (!m.has(norm)) { m.set(norm, v); }
		}
	}
	for (const m of fields.values()) {
		if (m.size > 1) { return undefined; } // conflict
	}
	const merged: KnowledgeItem = {};
	for (const [k, m] of fields) {
		merged[k] = m.values().next().value;
	}
	return merged;
}

/**
 * Factory mirroring `ontomem.merger.create_merger`. Accepts either a
 * {@link MergeStrategy} or a pre-built {@link IMerger} instance (mirrors the
 * Python `BaseMerger` pass-through), so callers can inject custom merge logic.
 */
const MERGE_SYSTEM_PREFER_EXISTING = [
	'You are a knowledge-deduplication expert.',
	'You will be given several JSON records that all refer to the SAME entity.',
	'Fuse them into ONE JSON record. When the same field has conflicting values',
	'across records, PREFER the value from the FIRST (earlier) record.',
	'Respond with the single merged JSON object only.',
].join(' ');

const MERGE_SYSTEM_PREFER_INCOMING = [
	'You are a knowledge-deduplication expert.',
	'You will be given several JSON records that all refer to the SAME entity.',
	'Fuse them into ONE JSON record. When the same field has conflicting values',
	'across records, PREFER the value from the LAST (later / incoming) record.',
	'Respond with the single merged JSON object only.',
].join(' ');

/**
 * LLM-powered merger with a directional preference: either prefer the
 * existing (earlier) record's values or the incoming (later) record's.
 */
class PreferMerger<T extends KnowledgeItem> implements IMerger<T> {
	constructor(
		private readonly keyExtractor: KeyExtractor,
		private readonly llm: IChatModel,
		private readonly itemSchema: JsonSchema,
		private readonly system: string,
	) {}

	async merge(items: T[]): Promise<T[]> {
		if (items.length === 0) { return []; }
		const groups = new Map<string, T[]>();
		for (const it of items) {
			const key = this.keyExtractor(it) ?? '';
			const g = groups.get(key);
			if (g) { g.push(it); } else { groups.set(key, [it]); }
		}
		const out: T[] = [];
		for (const [, group] of groups) {
			if (group.length === 1) { out.push(group[0]); continue; }
			try {
				const merged = await this.llm.extract<T>({
					system: this.system,
					prompt:
						`Schema:\n${JSON.stringify(this.itemSchema)}\n\n` +
						`Duplicate records to fuse (JSON array; prefer the ${this.system.includes('FIRST') ? 'first' : 'last'} record on conflicts):\n${JSON.stringify(group)}`,
					schema: this.itemSchema,
				});
				out.push(merged);
			} catch (e) {
				console.warn('[PreferMerger] merge failed, keeping first:', e);
				out.push(group[0]);
			}
		}
		return out;
	}
}

/**
 * LLM-powered merger steered by a DECLARATIVE `rule` string. Mirrors
 * `MergeStrategy.LLM.CUSTOM_RULE`: the rule is injected into the system
 * prompt so callers can express domain-specific fusion logic (e.g. GraphRAG's
 * "merge nodes that share the same wikidata entity") without writing code.
 */
export class RuleMerger<T extends KnowledgeItem> implements IMerger<T> {
	constructor(
		private readonly keyExtractor: KeyExtractor,
		private readonly llm: IChatModel,
		private readonly itemSchema: JsonSchema,
		private readonly rule: string,
	) {}

	async merge(items: T[]): Promise<T[]> {
		if (items.length === 0) { return []; }
		const groups = new Map<string, T[]>();
		for (const it of items) {
			const key = this.keyExtractor(it) ?? '';
			const g = groups.get(key);
			if (g) { g.push(it); } else { groups.set(key, [it]); }
		}
		const out: T[] = [];
		for (const [, group] of groups) {
			if (group.length === 1) { out.push(group[0]); continue; }
			try {
				const merged = await this.llm.extract<T>({
					system:
						`You are a knowledge-deduplication expert.\n` +
						`You will be given several JSON records that all refer to the SAME entity ` +
						`(they share the same identity key). Fuse them into ONE JSON record.\n` +
						`APPLY THIS RULE when fusing:\n${this.rule}\n` +
						`Keep the merged object valid for the schema. Respond with the single merged JSON object only.`,
					prompt:
						`Schema:\n${JSON.stringify(this.itemSchema)}\n\n` +
						`Duplicate records to fuse (JSON array):\n${JSON.stringify(group)}`,
					schema: this.itemSchema,
				});
				out.push(merged);
			} catch (e) {
				console.warn('[RuleMerger] merge failed, keeping first:', e);
				out.push(group[0]);
			}
		}
		return out;
	}
}

/** Convenience factory for a {@link RuleMerger}. */
export function customRuleMerger<T extends KnowledgeItem>(
	keyExtractor: KeyExtractor,
	llm: IChatModel,
	itemSchema: JsonSchema,
	rule: string,
): IMerger<T> {
	return new RuleMerger<T>(keyExtractor, llm, itemSchema, rule);
}

export function createMerger<T extends KnowledgeItem>(
	strategyOrMerger: MergeStrategy | IMerger<T>,
	keyExtractor: KeyExtractor,
	llm: IChatModel,
	itemSchema: JsonSchema,
	/** Declarative rule for `MergeStrategy.CUSTOM_RULE`. */
	rule?: string,
): IMerger<T> {
	if (typeof strategyOrMerger === 'object' && strategyOrMerger !== null &&
		typeof (strategyOrMerger as IMerger<T>).merge === 'function') {
		return strategyOrMerger as IMerger<T>;
	}
	const strategy = strategyOrMerger as MergeStrategy;
	if (strategy === MergeStrategy.SIMPLE) {
		return new SimpleMerger<T>(keyExtractor);
	}
	if (strategy === MergeStrategy.BALANCED) {
		return new BalancedMerger<T>(keyExtractor, llm, itemSchema);
	}
	if (strategy === MergeStrategy.PREFER_EXISTING) {
		return new PreferMerger<T>(keyExtractor, llm, itemSchema, MERGE_SYSTEM_PREFER_EXISTING);
	}
	if (strategy === MergeStrategy.PREFER_INCOMING) {
		return new PreferMerger<T>(keyExtractor, llm, itemSchema, MERGE_SYSTEM_PREFER_INCOMING);
	}
	if (strategy === MergeStrategy.CUSTOM_RULE) {
		return new RuleMerger<T>(keyExtractor, llm, itemSchema, rule ?? 'Merge records that refer to the same real-world entity.');
	}
	return new LlmMerger<T>(keyExtractor, llm, itemSchema);
}
