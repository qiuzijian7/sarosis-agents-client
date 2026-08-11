/*---------------------------------------------------------------------------------------------
 *  ComfyGraphAdapter — bidirectional conversion between
 *    (A) sarosis workflow JSON (WorkflowGraphNode[] + WorkflowGraphConnection[]) and
 *    (B) LiteGraph graph.serialize() format.
 *
 *  Pure functions, no LiteGraph singleton dependency — unit-testable in isolation.
 *  The goal is that a workflow edited on the LiteGraph canvas can be exported back
 *  to the existing host `workflow.json` format without data loss, and existing
 *  workflows can be imported onto the canvas.
 *--------------------------------------------------------------------------------------------*/

import type {
	WorkflowGraphNode,
	WorkflowGraphConnection,
	WorkflowNodePosition,
} from '../../../types/workflowStorage';
import { isUsableNodeTitle } from './schemaLiteGraphNodes';

/** LiteGraph serialised node (subset we read/write). */
export interface LiteGraphSerialisedNode {
	id: number;
	type: string;
	pos: [number, number];
	size?: [number, number];
	flags?: Record<string, unknown>;
	properties?: Record<string, unknown>;
	widgets_values?: unknown[];
	title?: string;
	mode?: number;
	/** optional input/output slot descriptors (ComfyUI GUI export / LiteGraph serialize) */
	inputs?: Array<{ name: string; type?: string; link?: number | null; widget?: { name: string } | null }>;
	outputs?: Array<{ name: string; type?: string; links?: (number | null)[] | null }>;
}

/** LiteGraph serialised link: [id, originNode, originSlot, targetNode, targetSlot, type]. */
export type LiteGraphSerialisedLink = [number, number, number, number, number, string];

export interface LiteGraphSerialisedGraph {
	last_node_id: number;
	last_link_id: number;
	nodes: LiteGraphSerialisedNode[];
	links: LiteGraphSerialisedLink[];
	groups?: unknown[];
	version?: number;
}

/** Map a sarosis node type → LiteGraph node type (namespaced). */
export function toLiteGraphType(nodeType: string): string {
	if (nodeType.startsWith('Sarosis.') || nodeType.includes('.')) {
		return nodeType;
	}
	return `Sarosis.${capitalize(nodeType)}`;
}

/** Map a LiteGraph node type → sarosis node type (de-namespaced). */
export function toSarosisType(liteType: string): string {
	if (liteType.startsWith('Sarosis.')) {
		return liteType.slice('Sarosis.'.length).toLowerCase();
	}
	return liteType;
}

function capitalize(s: string): string {
	return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Convert sarosis workflow graph to LiteGraph serialize format.
 * Node IDs are remapped to numeric ids; a map preserves the original sarosis id
 * so `fromLiteGraph` can restore it.
 */
export function toLiteGraph(
	wfNodes: WorkflowGraphNode[],
	wfConnections: WorkflowGraphConnection[],
	options?: { startId?: number; startLinkId?: number },
): { graph: LiteGraphSerialisedGraph; nodeIdMap: Map<number, string> } {
	let nextNodeId = options?.startId ?? 1;
	let nextLinkId = options?.startLinkId ?? 1;
	const nodeIdMap = new Map<number, string>();
	const liteNodes: LiteGraphSerialisedNode[] = [];
	const liteLinks: LiteGraphSerialisedLink[] = [];

	for (const wfNode of wfNodes) {
		const liteId = nextNodeId++;
		nodeIdMap.set(liteId, wfNode.id);
		const position = normalizePosition(wfNode.position);
		// Always emit a `size` so the widgetBridge overlay can position its
		// React card against the same rectangle the LiteGraph node draws at.
		// Without this, the overlay falls back to a 220×150 default while the
		// node is rendered at its computeSize-based size — the card drifts.
		const width = wfNode.style?.width ?? 220;
		const height = wfNode.style?.height ?? 60;
		// Old workflows persisted `name = liteNode.title ?? liteNode.type`, so
		// `name` can be a type string ("ComfyTV.ImageStage") or a truncated
		// fragment ("t"). Restoring those would show internal implementation
		// detail in the title bar — drop them and let LiteGraph fall back to
		// the registered class title (spec.title). Genuine renames are kept.
		const savedTitle = wfNode.data?.label ?? wfNode.name;
		const liteType = toLiteGraphType(wfNode.type);
		const keepTitle = isUsableNodeTitle(savedTitle, liteType);
		liteNodes.push({
			id: liteId,
			type: liteType,
			pos: [position.x, position.y],
			size: [width, height],
			title: keepTitle ? savedTitle : undefined,
			properties: { ...(wfNode.data ?? {}), __sarosisId: wfNode.id },
		});
	}

	const idToLite = new Map<string, number>();
	for (const [liteId, sarosisId] of nodeIdMap) {
		idToLite.set(sarosisId, liteId);
	}

	for (const conn of wfConnections) {
		const from = idToLite.get(conn.from);
		const to = idToLite.get(conn.to);
		if (from === undefined || to === undefined) {
			continue; // dangling edge — drop (same as LiteGraph would)
		}
		const linkType = conn.fromPort && conn.toPort
			? (typeof conn.fromPort === 'string' && conn.fromPort.toUpperCase() === 'IMAGE' ? 'IMAGE' : 'ANY')
			: 'ANY';
		liteLinks.push([nextLinkId++, from, 0, to, 0, linkType]);
	}

	return {
		graph: {
			last_node_id: nextNodeId - 1,
			last_link_id: nextLinkId - 1,
			nodes: liteNodes,
			links: liteLinks,
			version: 0.4,
		},
		nodeIdMap,
	};
}

/**
 * Convert LiteGraph serialize format back to sarosis workflow graph.
 */
export function fromLiteGraph(
	graph: LiteGraphSerialisedGraph,
): { nodes: WorkflowGraphNode[]; connections: WorkflowGraphConnection[] } {
	const nodes: WorkflowGraphNode[] = [];
	const liteToSarosis = new Map<number, string>();

	for (const liteNode of graph.nodes ?? []) {
		const props = liteNode.properties ?? {};
		// Prefer the preserved sarosis id; otherwise generate one from LiteGraph id.
		const sarosisId = (props.__sarosisId as string | undefined) ?? `node-${liteNode.id}`;
		liteToSarosis.set(liteNode.id, sarosisId);
		const { __sarosisId, ...data } = props as Record<string, unknown>;
		nodes.push({
			id: sarosisId,
			type: toSarosisType(liteNode.type) as WorkflowGraphNode['type'],
			name: liteNode.title ?? liteNode.type,
			position: { x: liteNode.pos[0], y: liteNode.pos[1] },
			data: Object.keys(data).length ? (data as WorkflowGraphNode['data']) : undefined,
			style: liteNode.size ? { width: liteNode.size[0], height: liteNode.size[1] } : undefined,
		});
	}

	const connections: WorkflowGraphConnection[] = [];
	for (const link of graph.links ?? []) {
		const [id, fromLite, , toLite, , linkType] = link;
		const from = liteToSarosis.get(fromLite);
		const to = liteToSarosis.get(toLite);
		if (!from || !to) { continue; }
		connections.push({
			id: `edge-${id}`,
			from,
			to,
			fromPort: linkType === 'ANY' ? undefined : linkType,
			toPort: undefined,
		});
	}

	return { nodes, connections };
}

/** Stable, deterministic serialisation keyed by ids for git-friendly diffs. */
export function stableSerializeGraph(graph: LiteGraphSerialisedGraph): string {
	const nodes = [...(graph.nodes ?? [])].sort((a, b) => a.id - b.id);
	const links = [...(graph.links ?? [])].sort((a, b) => a[0] - b[0]);
	return JSON.stringify({
		last_node_id: graph.last_node_id,
		last_link_id: graph.last_link_id,
		nodes,
		links,
		version: graph.version ?? 0.4,
	}, null, 2);
}

function normalizePosition(p: WorkflowNodePosition | undefined): WorkflowNodePosition {
	return {
		x: round2(p?.x ?? 0),
		y: round2(p?.y ?? 0),
	};
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}
