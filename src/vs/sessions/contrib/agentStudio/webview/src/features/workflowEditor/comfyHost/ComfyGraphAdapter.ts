/*---------------------------------------------------------------------------------------------
 *  ComfyGraphAdapter — bidirectional conversion between
 *    (A) saros workflow JSON (WorkflowGraphNode[] + WorkflowGraphConnection[]) and
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
import { getNodeSpec } from './registry';

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

/** Map a saros node type → LiteGraph node type (namespaced). */
export function toLiteGraphType(nodeType: string): string {
	if (nodeType.startsWith('Saros.') || nodeType.includes('.')) {
		return nodeType;
	}
	return `Saros.${capitalize(nodeType)}`;
}

/** Map a LiteGraph node type → saros node type (de-namespaced). */
export function toSarosType(liteType: string): string {
	if (liteType.startsWith('Saros.')) {
		return liteType.slice('Saros.'.length).toLowerCase();
	}
	return liteType;
}

function capitalize(s: string): string {
	return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Convert saros workflow graph to LiteGraph serialize format.
 * Node IDs are remapped to numeric ids; a map preserves the original saros id
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
			properties: { ...(wfNode.data ?? {}), __sarosId: wfNode.id },
		});
	}

	const idToLite = new Map<string, number>();
	for (const [liteId, sarosId] of nodeIdMap) {
		idToLite.set(sarosId, liteId);
	}

	for (const conn of wfConnections) {
		const from = idToLite.get(conn.from);
		const to = idToLite.get(conn.to);
		if (from === undefined || to === undefined) {
			// 诊断：打印被丢弃的边（source/target 节点未注册/被过滤）
			// eslint-disable-next-line no-console
			console.warn('[toLiteGraph] dropped edge', conn.from, '->', conn.to,
				'reason:', from === undefined ? 'from not in idToLite' : 'to not in idToLite');
			continue; // dangling edge — drop (same as LiteGraph would)
		}
		// ⚠ 根据 port 名推断正确的源/目标 slot（旧版硬编码 0 会导致
		// ImageStage.texts(slot0) 连到 ImagePicker.batch 而非 images(slot1)）。
		const srcNode = wfNodes.find(n => n.id === conn.from);
		const tgtNode = wfNodes.find(n => n.id === conn.to);
		let srcSlot = 0;
		let tgtSlot = 0;
		if (srcNode && conn.fromPort) {
			const srcSpec = getNodeSpec(srcNode.type);
			if (srcSpec?.kind === 'schema') {
				const idx = srcSpec.outputs.findIndex(o => o.name === conn.fromPort);
				if (idx >= 0) { srcSlot = idx; }
			}
		}
		if (tgtNode && conn.toPort) {
			const tgtSpec = getNodeSpec(tgtNode.type);
			if (tgtSpec?.kind === 'schema') {
				const idx = tgtSpec.inputs.findIndex(i => i.name === conn.toPort);
				if (idx >= 0) { tgtSlot = idx; }
			}
		}
		let linkType: string = 'ANY';
		if (conn.fromPort && conn.toPort) {
			// 优先用真实端口类型（如 COMFYTV_IMAGES），确保与对端输入类型匹配、
			// 不被 LiteGraph 类型检查拒绝；否则回退到粗粒度 media 类型。
			const srcSpec = getNodeSpec(srcNode.type);
			const outSpec = srcSpec?.outputs?.find(o => o.name === conn.fromPort);
			const tgtSpec = getNodeSpec(tgtNode.type);
			const inSpec = tgtSpec?.inputs?.find(i => i.name === conn.toPort);
			if (outSpec?.type) { linkType = outSpec.type; }
			else if (inSpec?.type) { linkType = inSpec.type; }
			else if (typeof conn.fromPort === 'string') {
				const fromU = conn.fromPort.toUpperCase();
				linkType = fromU === 'IMAGE' ? 'IMAGE' : fromU === 'VIDEO' ? 'VIDEO' : fromU === 'AUDIO' ? 'AUDIO' : 'ANY';
			}
		}
		liteLinks.push([nextLinkId++, from, srcSlot, to, tgtSlot, linkType]);
		// 诊断：记录每条 liteLink 的解析结果
		// eslint-disable-next-line no-console
		console.warn('[toLiteGraph] LINK', JSON.stringify({
			linkId: nextLinkId - 1, from, to, srcSlot, tgtSlot, linkType,
			fromPort: conn.fromPort, toPort: conn.toPort,
			fromFound: from !== undefined, toFound: to !== undefined,
		}));
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
 * Convert LiteGraph serialize format back to saros workflow graph.
 */
export function fromLiteGraph(
	graph: LiteGraphSerialisedGraph,
): { nodes: WorkflowGraphNode[]; connections: WorkflowGraphConnection[] } {
	const nodes: WorkflowGraphNode[] = [];
	const liteToSaros = new Map<number, string>();

	for (const liteNode of graph.nodes ?? []) {
		const props = liteNode.properties ?? {};
		// Prefer the preserved saros id; otherwise generate one from LiteGraph id.
		const sarosId = (props.__sarosId as string | undefined) ?? `node-${liteNode.id}`;
		liteToSaros.set(liteNode.id, sarosId);
		const { __sarosId, ...data } = props as Record<string, unknown>;
		nodes.push({
			id: sarosId,
			type: toSarosType(liteNode.type) as WorkflowGraphNode['type'],
			name: liteNode.title ?? liteNode.type,
			position: { x: liteNode.pos[0], y: liteNode.pos[1] },
			data: Object.keys(data).length ? (data as WorkflowGraphNode['data']) : undefined,
			style: liteNode.size ? { width: liteNode.size[0], height: liteNode.size[1] } : undefined,
		});
	}

	const connections: WorkflowGraphConnection[] = [];
	for (const link of graph.links ?? []) {
		const [id, fromLite, , toLite, , linkType] = link;
		const from = liteToSaros.get(fromLite);
		const to = liteToSaros.get(toLite);
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
