/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — AutoTemporalGraph
 *
 *  Faithful port of `hyperextract/types/temporal_graph.py::AutoTemporalGraph`.
 *  A knowledge graph whose EDGES carry a `time` and are keyed INCLUDING that
 *  time, so two events that share (source, relation, target) but happened at
 *  DIFFERENT times are NOT collapsed into one edge (the core correctness bug
 *  of using a plain AutoGraph for temporal extraction).
 *
 *  It extends `AutoGraph` and only overrides:
 *    - the edge key extractor  → `${source}|${relation}|${target}@${time}`
 *    - prompt context injection  → `observation_time` (so the LLM can resolve
 *      relative expressions like "last year" against an absolute reference)
 *    - `toMarkdown`                      → renders `time` + `evidence` on edges
 *
 *  Mirrors how `AutoTemporalGraph` injects `observation_time` in the Python
 *  original (the template engine lower-binds the variable per-document).
 *--------------------------------------------------------------------------------------------*/

import { AutoGraph, AutoGraphDeps, MarkdownExportOptions } from './autoGraph.js';
import { KnowledgeItem, KeyExtractor } from './types.js';

const lc = (v: unknown): string => String(v ?? '').trim().toLowerCase();

export interface AutoTemporalGraphDeps extends AutoGraphDeps {
	/**
	 * Absolute reference timestamp injected into every extraction prompt as
	 * `observation_time`, enabling the LLM to resolve relative time phrases
	 * ("last year", "two months ago") to absolute values. Optional; when
	 * omitted, the LLM still extracts an explicit `time` per edge, which is
	 * what the temporal edge key relies on.
	 */
	observationTime?: string;
}

export class AutoTemporalGraph extends AutoGraph {
	constructor(deps: AutoTemporalGraphDeps) {
		// Augment the edge key with the edge's `time` so two events at different
		// times are never deduplicated into one edge.
		const baseKey: KeyExtractor = deps.edgeKeyExtractor ?? ((e: KnowledgeItem) =>
			`${lc(e['source'])}|${lc(e['relation'])}|${lc(e['target'])}`);
		const temporalKey: KeyExtractor = (e: KnowledgeItem) =>
			`${baseKey(e)}@${lc(e['time'])}`;

		const ctxVars: Record<string, string> = { ...(deps.contextVars ?? {}) };
		if (deps.observationTime) {
			ctxVars['observation_time'] = deps.observationTime;
		}

		super({ ...deps, edgeKeyExtractor: temporalKey, contextVars: ctxVars });
	}

	/** Temporal-aware Markdown: edges render `time` + `evidence`. */
	override toMarkdown(opts: MarkdownExportOptions = {}): string {
		const title = opts.title ?? 'Temporal Knowledge Graph';
		const useMermaid = opts.mermaid ?? true;
		const useWiki = opts.wikilinks ?? true;
		const nodes = this.nodes;
		const edges = this.edges;

		const link = (name: unknown): string => {
			const s = String(name ?? '').trim();
			return useWiki && s ? `[[${s}]]` : s;
		};

		const lines: string[] = [];
		lines.push(`# ${title}`, '');
		lines.push(`> 由 Hyper-Extract (TS) 时序知识引擎自动导出 · 节点 ${nodes.length} · 关系 ${edges.length}`, '');

		lines.push('## 节点 (Nodes)', '');
		if (nodes.length === 0) {
			lines.push('_（暂无节点）_', '');
		} else {
			for (const n of nodes) {
				const name = String(n['name'] ?? '').trim();
				const type = n['type'] ? ` (\`${String(n['type'])}\`)` : '';
				const desc = n['description'] ? `: ${String(n['description'])}` : '';
				lines.push(`- ${link(name)}${type}${desc}`);
			}
			lines.push('');
		}

		lines.push('## 时序关系 (Temporal Edges)', '');
		if (edges.length === 0) {
			lines.push('_（暂无关系）_', '');
		} else {
			for (const e of edges) {
				const src = link(e['source']);
				const tgt = link(e['target']);
				const rel = e['relation'] ? `\`${String(e['relation'])}\`` : 'relates to';
				const time = e['time'] ? ` @ ${String(e['time'])}` : '';
				const ev = e['evidence'] ? ` 「${String(e['evidence'])}」` : '';
				const desc = e['description'] ? ` — ${String(e['description'])}` : '';
				lines.push(`- ${src} --${rel}${time}--> ${tgt}${ev}${desc}`);
			}
			lines.push('');
		}

		if (useMermaid) {
			lines.push('## 图谱 (Mermaid)', '');
			lines.push('```mermaid', this.toMermaid(), '```', '');
		}

		return lines.join('\n');
	}
}
