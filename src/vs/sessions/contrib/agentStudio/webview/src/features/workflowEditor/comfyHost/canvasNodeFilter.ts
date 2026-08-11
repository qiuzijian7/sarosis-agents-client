/*---------------------------------------------------------------------------------------------
 *  canvasNodeFilter — decide which nodes should be rendered on the LiteGraph canvas.
 *
 *  The LiteGraph engine is "ComfyUI native": it draws node bodies (the rectangle,
 *  the title, the resize handles) on the canvas itself. It does NOT know how to
 *  render Sarosis custom nodes (e.g. type='call', 'askUser', 'ifElse') — feeding
 *  them through `graph.configure()` would create a node with a valid title but no
 *  body, producing a giant empty red-bordered rectangle on the canvas (see the
 *  observed "大空白节点" bug).
 *
 *  This module produces a small, pure decision that the canvas can apply both:
 *    - on engine change (drop Sarosis nodes before graph.configure)
 *    - on store → graph sync (same)
 *  plus a `findUnsupportedNodes` helper for the UI to surface a warning.
 *--------------------------------------------------------------------------------------------*/

import type { LiteGraphSerialisedGraph, LiteGraphSerialisedNode } from './ComfyGraphAdapter.js';
import { isPortTypeCompatible } from './registry.js';

/** Known Sarosis node types that now have real LiteGraph node classes. */
export const SAROSIS_NODE_TYPES = new Set<string>([
	'Sarosis.Start',
	'Sarosis.End',
	'Sarosis.Task',
	'Sarosis.Prompt',
	'Sarosis.Agent',
	'Sarosis.Skill',
	'Sarosis.Tool',
	'Sarosis.IfElse',
	'Sarosis.Switch',
	'Sarosis.AskUser',
	'Sarosis.Group',
	'Sarosis.ModelImageGen',
	'Sarosis.ProviderPicker',
]);

/** Node types the LiteGraph engine can render meaningfully.
 *  Sarosis types are renderable now (they have real LGraphNode classes);
 *  ComfyUI-compat (schema/native) types are renderable; anything else is dropped. */
export function isLiteGraphRenderable(type: string, hasComfyUISpec: boolean): boolean {
	if (SAROSIS_NODE_TYPES.has(type)) { return true; }
	return hasComfyUISpec;
}

export interface UnsupportedNode {
	id: number;
	type: string;
	reason: 'unknown';
}

/** Decide which nodes to drop before `graph.configure`. Pure. */
export function filterNodesForLiteGraph(
	graph: LiteGraphSerialisedGraph,
	hasSpec: (type: string) => boolean,
): { keep: LiteGraphSerialisedGraph; dropped: UnsupportedNode[] } {
	const dropped: UnsupportedNode[] = [];
	const nodes: LiteGraphSerialisedNode[] = [];
	for (const n of graph.nodes ?? []) {
		if (SAROSIS_NODE_TYPES.has(n.type)) {
			// Sarosis nodes now have real LiteGraph classes → keep them.
			nodes.push(n);
			continue;
		}
		if (!hasSpec(n.type)) {
			dropped.push({ id: n.id, type: n.type, reason: 'unknown' });
			continue;
		}
		nodes.push(n);
	}
	// Drop links whose endpoints no longer exist.
	const keptIds = new Set(nodes.map(n => n.id));
	const links = (graph.links ?? []).filter(l => keptIds.has(l[1]) && keptIds.has(l[3]));
	return { keep: { ...graph, nodes, links }, dropped };
}

/** Convenience: extract unsupported node ids from a list of store nodes (for the UI warning). */
export function findUnsupportedNodes(
	nodes: Array<{ id: string; type: string }>,
	hasSpec: (type: string) => boolean,
): UnsupportedNode[] {
	const out: UnsupportedNode[] = [];
	for (const n of nodes) {
		if (SAROSIS_NODE_TYPES.has(n.type)) { continue; }
		if (!hasSpec(n.type)) {
			out.push({ id: 0, type: n.type, reason: 'unknown' });
		}
	}
	return out;
}

/* istanbul ignore next — re-exported for type compatibility with adapter */
export { isPortTypeCompatible };
