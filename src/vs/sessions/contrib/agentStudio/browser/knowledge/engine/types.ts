/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — Core types
 *
 *  Pure-TypeScript re-implementation of `hyperextract/types/*`.
 *  No `vs/` imports: this module is portable and unit-testable on its own.
 *
 *  Design notes vs the Python original:
 *   - Pydantic `BaseModel` → a JSON-Schema description (`JsonSchema`) plus a
 *     plain `Record<string, unknown>` runtime object. The LLM is asked to emit
 *     JSON conforming to the schema; we validate loosely (required keys present).
 *   - `Callable` key/label extractors → simple `(item: T) => string` functions.
 *   - Generics are preserved where useful but most stores operate on
 *     `Record<string, unknown>` for schema-agnostic dedup/index/search.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal JSON-Schema subset used to drive the LLM structured-output request.
 * Mirrors the `response_format.json_schema` shape accepted by OpenAI-compatible
 * chat completions endpoints.
 */
export interface JsonSchema {
	type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'integer';
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	required?: string[];
	description?: string;
	enum?: unknown[];
	[key: string]: unknown;
}

/**
 * A knowledge item is a plain object (the TS analogue of a Pydantic model instance).
 */
export type KnowledgeItem = Record<string, unknown>;

/** Extract a unique string key from an item (e.g. `item => item.name`). */
export type KeyExtractor = (item: KnowledgeItem) => string;

/** Extract a human-readable label for visualization / Obsidian export. */
export type LabelExtractor = (item: KnowledgeItem) => string;

/** Extract the two endpoint keys of an edge item (source, target). */
export type EdgeEndpoints = (edge: KnowledgeItem) => [string, string];

/**
 * Configuration for one AutoType instance (the TS analogue of
 * `BaseAutoType.__init__`'s kwargs, minus the LLM/embedder which are injected
 * separately as `IChatModel` / `IEmbedder`).
 */
export interface AutoTypeConfig {
	/** System prompt override for one-stage extraction. */
	prompt?: string;
	chunkSize?: number;
	chunkOverlap?: number;
	/** Max concurrent LLM extraction tasks (mirrors `max_workers`). */
	maxWorkers?: number;
	verbose?: boolean;
}

export const DEFAULT_CHUNK_SIZE = 2048;
export const DEFAULT_CHUNK_OVERLAP = 256;
export const DEFAULT_MAX_WORKERS = 10;

/** Build a JSON-Schema for a list-of-items container (the `items` field). */
export function listSchema(itemSchema: JsonSchema, description: string): JsonSchema {
	return {
		type: 'object',
		description,
		properties: {
			items: {
				type: 'array',
				description,
				items: itemSchema,
			},
		},
		required: ['items'],
	};
}

/** Build a JSON-Schema for a graph container (nodes + edges). */
export function graphSchema(
	nodeSchema: JsonSchema,
	edgeSchema: JsonSchema,
	description: string,
): JsonSchema {
	return {
		type: 'object',
		description,
		properties: {
			nodes: { type: 'array', description: 'Graph nodes / entities', items: nodeSchema },
			edges: { type: 'array', description: 'Graph edges / relationships', items: edgeSchema },
		},
		required: ['nodes', 'edges'],
	};
}

/** Loose validation: ensure all `required` keys exist (non-undefined). */
export function assertRequired(obj: unknown, schema: JsonSchema, ctx: string): void {
	if (!obj || typeof obj !== 'object') {
		throw new Error(`${ctx}: expected object, got ${typeof obj}`);
	}
	const req = schema.required ?? [];
	const o = obj as Record<string, unknown>;
	for (const k of req) {
		if (o[k] === undefined) {
			throw new Error(`${ctx}: missing required field "${k}"`);
		}
	}
}

/**
 * Keep only items that satisfy a schema's `required` fields (present & non-empty).
 * Used to filter malformed LLM extractions (e.g. a node missing its `name`) before
 * they enter the OMem store, so broken records never pollute the dedup/index/search
 * pipeline. Mirrors the defensive parsing Hyper-Extract gets from Pydantic
 * `model_validate` discarding invalid rows.
 */
export function filterValidItems(items: KnowledgeItem[] | undefined, schema: JsonSchema): KnowledgeItem[] {
	if (!items) { return []; }
	const req = schema.required ?? [];
	if (req.length === 0) { return items.slice(); }
	return items.filter(it => {
		if (!it || typeof it !== 'object') { return false; }
		for (const k of req) {
			const v = (it as KnowledgeItem)[k];
			if (v === undefined || v === null || v === '') { return false; }
		}
		return true;
	});
}

/** Render an item as a compact, single-line debug summary. */
export function summarizeItem(item: KnowledgeItem): string {
	try {
		const parts: string[] = [];
		for (const [k, v] of Object.entries(item)) {
			if (Array.isArray(v)) { parts.push(`${k}=${v.length}`); }
			else if (typeof v === 'string') { parts.push(`${k}=${(v as string).slice(0, 50)}`); }
			else { parts.push(`${k}=${JSON.stringify(v).slice(0, 50)}`); }
		}
		return parts.join(', ') || JSON.stringify(item).slice(0, 100);
	} catch {
		return String(item).slice(0, 100);
	}
}
