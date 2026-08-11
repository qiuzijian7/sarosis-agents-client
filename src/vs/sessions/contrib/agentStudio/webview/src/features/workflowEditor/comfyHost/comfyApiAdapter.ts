/*---------------------------------------------------------------------------------------------
 *  comfyApiAdapter — parse/export ComfyUI workflow JSON.
 *
 *  Two ComfyUI formats are handled:
 *   1. GUI workflow (graph.json): the LiteGraph serialisation used by ComfyUI's
 *      frontend — `{ nodes: [{id,type,pos,size,inputs,outputs,widgets_values}],
 *      links: [[id,origin,originSlot,target,targetSlot,type]], groups, … }`.
 *      This is structurally compatible with `ComfyGraphAdapter.LiteGraphSerialisedGraph`.
 *   2. API prompt (api.json): the `/prompt` submission format —
 *      `{ "<nodeId>": { class_type: "KSampler", inputs: { seed: 123, model: ["4", 0] } } }`.
 *
 *  Pure functions, unit-testable in isolation.
 *--------------------------------------------------------------------------------------------*/

import type { LiteGraphSerialisedGraph, LiteGraphSerialisedNode, LiteGraphSerialisedLink } from './ComfyGraphAdapter.js';

/** Raw GUI-workflow node as it appears in a ComfyUI exported workflow. */
export interface ComfyGuiNode {
	id: number;
	type: string;
	pos?: [number, number];
	size?: [number, number];
	title?: string;
	inputs?: Array<{ name: string; type?: string; link?: number | null; widget?: { name: string } | null }>;
	outputs?: Array<{ name: string; type?: string; links?: (number | null)[] | null }>;
	widgets_values?: unknown[];
	properties?: Record<string, unknown>;
}

export interface ComfyGuiWorkflow {
	nodes: ComfyGuiNode[];
	links?: Array<[number, number, number, number, number, string]>;
	groups?: unknown[];
	version?: number;
}

/** API prompt entry: node id string → { class_type, inputs }. */
export type ComfyApiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export interface ParseResult {
	graph: LiteGraphSerialisedGraph;
	issues: string[];
}

/** Coerce a raw exported ComfyUI workflow into our LiteGraph-serialised shape. */
export function parseGuiWorkflow(raw: unknown): ParseResult {
	const issues: string[] = [];
	if (!raw || typeof raw !== 'object') {
		return { graph: { last_node_id: 0, last_link_id: 0, nodes: [], links: [] }, issues: ['workflow is not an object'] };
	}
	const wf = raw as ComfyGuiWorkflow;
	if (!Array.isArray(wf.nodes)) {
		return { graph: { last_node_id: 0, last_link_id: 0, nodes: [], links: [] }, issues: ['workflow.nodes is not an array'] };
	}

	const nodes: LiteGraphSerialisedNode[] = [];
	for (const n of wf.nodes) {
		if (typeof n.id !== 'number' || typeof n.type !== 'string') {
			issues.push(`skipping node without id/type: ${JSON.stringify(n)}`);
			continue;
		}
		nodes.push({
			id: n.id,
			type: n.type,
			pos: n.pos ?? [0, 0],
			size: n.size,
			title: n.title,
			properties: n.properties ?? {},
			widgets_values: n.widgets_values,
			// Keep slot descriptors so guiToApi() (export) can reconstruct the
			// connections: input links reference link ids that map back through
			// `links[]`. Dropping them here caused imported ComfyUI workflows to
			// lose every connection when re-exported.
			inputs: n.inputs,
			outputs: n.outputs,
		});
	}

	const links: LiteGraphSerialisedLink[] = (wf.links ?? []).map(l => [l[0], l[1], l[2], l[3], l[4], l[5]]);
	// dedupe + sort by id for stability
	links.sort((a, b) => a[0] - b[0]);
	const lastNodeId = nodes.length ? Math.max(...nodes.map(n => n.id)) : 0;
	const lastLinkId = links.length ? Math.max(...links.map(l => l[0])) : 0;

	return { graph: { last_node_id: lastNodeId, last_link_id: lastLinkId, nodes, links, version: wf.version ?? 0.4 }, issues };
}

/**
 * Convert a GUI workflow into the ComfyUI API /prompt format.
 * Widgets map to `inputs` by position (widgets_values order); connections map to
 * `inputs[name] = [originId, originSlot]` via links.
 */
export function guiToApi(wf: ComfyGuiWorkflow): ComfyApiPrompt {
	const prompt: ComfyApiPrompt = {};
	// linkId → [originNodeId, originSlot]
	const linkOrigin = new Map<number, [number, number]>();
	for (const l of wf.links ?? []) {
		linkOrigin.set(l[0], [l[1], l[2]]);
	}

	for (const node of wf.nodes) {
		const inputs: Record<string, unknown> = {};
		let widgetIdx = 0;

		for (const inp of node.inputs ?? []) {
			if (!inp) { continue; }
			const name = inp.name;
			if (typeof inp.link === 'number' && inp.link >= 0) {
				const origin = linkOrigin.get(inp.link);
				if (origin) {
					inputs[name] = [String(origin[0]), origin[1]];
				}
				continue;
			}
			// Widget input → take the next value from widgets_values.
			// Some serializers omit the `widget` marker (LiteGraph serialize);
			// fall back to positional consumption whenever a value remains.
			if (node.widgets_values && widgetIdx < node.widgets_values.length) {
				inputs[name] = node.widgets_values[widgetIdx];
				widgetIdx++;
			}
		}

		prompt[String(node.id)] = { class_type: node.type, inputs };
	}
	return prompt;
}

export interface ExportFilterResult {
	/** GUI workflow with non-Comfy nodes (and their links) removed. */
	workflow: ComfyGuiWorkflow;
	/** Distinct node types that were skipped (react/llm Sarosis nodes). */
	skipped: string[];
}

/**
 * Strip Sarosis orchestration/provider nodes (kind 'react'/'llm') from a GUI
 * workflow before exporting to ComfyUI api.json. These types have no ComfyUI
 * class_type and would otherwise be exported as broken nodes. Links touching a
 * removed node are dropped. Pure + injectable predicate → unit-testable.
 */
export function stripSarosisNodesForExport(
	wf: ComfyGuiWorkflow,
	isNonComfyNode: (type: string) => boolean,
): ExportFilterResult {
	const kept: ComfyGuiNode[] = [];
	const skipped: string[] = [];
	for (const node of wf.nodes ?? []) {
		if (isNonComfyNode(node.type)) {
			if (!skipped.includes(node.type)) { skipped.push(node.type); }
			continue;
		}
		kept.push(node);
	}
	const keptIds = new Set(kept.map(n => n.id));
	const links = (wf.links ?? []).filter(l => keptIds.has(l[1]) && keptIds.has(l[3]));
	return { workflow: { ...wf, nodes: kept, links }, skipped };
}

/** Resolve every `[nodeId, slot]` reference in an api.json into the source class_type. */
export function resolveApiReferences(prompt: ComfyApiPrompt): Array<{ field: string; targetNode: string; targetSlot: number; sourceType?: string }> {
	const refs: Array<{ field: string; targetNode: string; targetSlot: number; sourceType?: string }> = [];
	for (const [nodeId, entry] of Object.entries(prompt)) {
		for (const [field, value] of Object.entries(entry.inputs)) {
			if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
				refs.push({
					field,
					targetNode: value[0],
					targetSlot: value[1],
					sourceType: prompt[value[0]]?.class_type,
				});
			}
		}
	}
	return refs;
}

/** Inverse: build a GUI graph from an api.json prompt (all nodes at origin, no positions). */
export function apiToGui(prompt: ComfyApiPrompt): ComfyGuiWorkflow {
	const nodes: ComfyGuiNode[] = [];
	const links: Array<[number, number, number, number, number, string]> = [];
	let linkId = 1;
	const idToIdx = new Map<string, number>();
	Object.keys(prompt).forEach((id, i) => idToIdx.set(id, i));

	for (const [nodeId, entry] of Object.entries(prompt)) {
		const inputs: NonNullable<ComfyGuiNode['inputs']> = [];
		for (const [field, value] of Object.entries(entry.inputs)) {
			if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
				// connection: create a link
				const fromIdx = idToIdx.get(value[0]);
				if (fromIdx === undefined) { continue; }
				inputs.push({ name: field, type: 'ANY', link: linkId });
				links.push([linkId, fromIdx, value[1], idToIdx.get(nodeId)!, inputs.length - 1, 'ANY']);
				linkId++;
			} else {
				inputs.push({ name: field, type: 'ANY', link: null, widget: { name: field } });
			}
		}
		nodes.push({ id: idToIdx.get(nodeId)!, type: entry.class_type, pos: [0, 0], inputs, outputs: [] });
	}
	return { nodes, links };
}
