/*---------------------------------------------------------------------------------------------
 *  Canvas Operations — pure, DOM-free atomic batch ops for the LiteGraph workflow canvas.
 *
 *  This is the execution kernel of the "Agent-driven canvas" design
 *  (docs/Agent-画布编排设计方案.md P0). Agent-side canvas_* tools produce
 *  CanvasOp[] batches; applyCanvasOps applies them to a store-shaped
 *  { nodes, edges } model and returns the new model + per-op results.
 *
 *  Design goals (mirroring infinite-canvas canvas_apply_ops + TapCanvas
 *  label→id resolution):
 *   - Atomic: any failing op rolls the WHOLE batch back (snapshot restore).
 *   - Label→id three-tier resolution (exact id → title/label → case-insensitive).
 *   - Port-type checking against the node registry (isPortTypeCompatible).
 *   - Auto-naming (nextAutoName) so agent-created nodes read "图像-1", "图像-2".
 *
 *  This module is UI-free and unit-testable without LiteGraph/React.
 *--------------------------------------------------------------------------------------------*/

import { getNodeSpec, isPortTypeCompatible, canConnectLayers, type PortSpec } from './registry.js';

// ─── Framework-agnostic model (mirrors store.ts shape) ─────────────────────────

export interface CanvasNode {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: Record<string, unknown> & { label?: string };
}

export interface CanvasEdge {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
	targetHandle?: string;
}

export interface CanvasModel {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

// ─── Ops ───────────────────────────────────────────────────────────────────────

export type CanvasOp =
	| { op: 'add_node'; type: string; id?: string; label?: string; position?: { x: number; y: number }; data?: Record<string, unknown> }
	| { op: 'update_node'; node: string; patch: Record<string, unknown> }
	| { op: 'delete_node'; node: string }
	| { op: 'connect'; source: string; target: string; sourceHandle?: string; targetHandle?: string; id?: string }
	| { op: 'disconnect'; source: string; target: string; sourceHandle?: string; targetHandle?: string }
	| { op: 'select'; node?: string | null };

export interface OpResult {
	/** Index of the op this result belongs to (for diagnostics). */
	opIndex: number;
	/** Short machine-friendly description, e.g. "added node prompt-1". */
	summary: string;
	/** ids referenced/created by this op (node ids in connect/disconnect). */
	ids?: string[];
}

export interface ApplyOpsResult {
	model: CanvasModel;
	results: OpResult[];
	/** True when every op succeeded. */
	ok: boolean;
	/** First error message when ok=false (previous ops rolled back). */
	error?: string;
	/** Index of the first failing op (rollback point). */
	failedOpIndex?: number;
	/** Auto-selected node id from an op:'select'. */
	selectedNodeId?: string | null;
}

export interface ApplyOpsOptions {
	/** Registry lookup for a node type (defaults to getNodeSpec). Injectable for tests. */
	getSpec?: (type: string) => { inputs: PortSpec[]; outputs: PortSpec[] } | undefined;
	/** Node id factory (defaults to deterministic "type-N"). */
	nextId?: (type: string, existing: CanvasNode[]) => string;
	/** Auto-name factory for new nodes (defaults to nextAutoName). */
	nextName?: (kind: string, existing: CanvasNode[]) => string;
	/** Seed for auto-name counters (defaults to max existing + 1). */
	seed?: number;
}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

/** Three-tier node reference resolution: exact id → label → case-insensitive label. */
export function resolveNodeRef(nodes: CanvasNode[], ref: string): CanvasNode | undefined {
	const exact = nodes.find(n => n.id === ref);
	if (exact) { return exact; }
	const labelHit = nodes.find(n => n.data?.label === ref);
	if (labelHit) { return labelHit; }
	const lower = ref.toLowerCase();
	return nodes.find(n => (n.data?.label ?? '').toLowerCase() === lower);
}

/**
 * Auto-name for agent-created nodes: "图像-1", "图像-2" (by kind counters).
 * Counts never fall back after deletion (matches TapCanvas behavior).
 */
export function nextAutoName(kind: string, existing: CanvasNode[], seed = 0): string {
	let max = seed;
	for (const n of existing) {
		const label = n.data?.label;
		if (typeof label !== 'string') { continue; }
		// Match "<kind>-<number>" where <kind> is a prefix of the label (e.g. "图像").
		const prefix = kind.replace(/-/g, '');
		const m = label.match(new RegExp(`^${prefix}-(\\d+)$`));
		if (m) { max = Math.max(max, Number(m[1])); }
	}
	return `${kind}-${max + 1}`;
}

/**
 * Deterministic "type-N" id (unused if explicit id is provided).
 *
 * @param counter 可选：按 base 分桶的**持久化单调计数器**。传入时，id 取
 *   `max(扫描现有节点, counter 已记录值) + 1`，并把新值写回 counter —— 这样
 *   **删除节点后不会再复用旧 id**（扫描 existing 拿不到已删的 max，counter 兜住）。
 *   不传（undefined）保持纯函数确定性，向后兼容既有测试与调用点。
 *
 *   注意 counter 的生命周期由**调用方**决定：单次生成流内用局部 Map 即可；
 *   跨会话不复用需把 Map 持久化到工作流 JSON（方案 #5，暂缓）。
 */
export function nextNodeId(type: string, existing: CanvasNode[], seed = 0, counter?: Map<string, number>): string {
	// "Saros.ModelImageGen" → "model-image-gen" (camelCase split + kebab).
	const base = type
		.replace(/^Saros\./, '')
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/[^A-Za-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
	let max = seed;
	for (const n of existing) {
		const m = n.id.match(new RegExp(`^${base}-(\\d+)$`));
		if (m) { max = Math.max(max, Number(m[1])); }
	}
	if (counter) {
		// 已记录的 base 计数兜底（覆盖「节点已删、扫描拿不到」的复用场景）。
		max = Math.max(max, counter.get(base) ?? 0);
		counter.set(base, max + 1);
	}
	return `${base}-${max + 1}`;
}

function defaultGetSpec(type: string) {
	return getNodeSpec(type);
}

function defaultNextId(type: string, existing: CanvasNode[]): string {
	return nextNodeId(type, existing);
}

function defaultNextName(kind: string, existing: CanvasNode[]): string {
	return nextAutoName(kind, existing);
}

// ─── Apply ─────────────────────────────────────────────────────────────────────

/**
 * Apply a batch of canvas ops atomically.
 *
 * Semantics:
 *  - The batch runs on a deep clone. On the FIRST failing op, the entire batch
 *    is rolled back (original model returned untouched).
 *  - connect validates both endpoints exist and, when handles are known, that
 *    the port types are compatible (registry-driven).
 *  - select returns the chosen node id (null clears selection).
 */
export function applyCanvasOps(model: CanvasModel, ops: CanvasOp[], options: ApplyOpsOptions = {}): ApplyOpsResult {
	const getSpec = options.getSpec ?? defaultGetSpec;
	const nextId = options.nextId ?? defaultNextId;
	const nextName = options.nextName ?? defaultNextName;

	// Deep clone so rollback = "keep working copy, discard on failure".
	const working: CanvasModel = JSON.parse(JSON.stringify(model)) as CanvasModel;
	const results: OpResult[] = [];
	let selectedNodeId: string | null | undefined;

	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		try {
			switch (op.op) {
				case 'add_node': {
					const type = op.type;
					const spec = getSpec(type);
					if (!spec) {
						throw new Error(`add_node: 未注册的节点类型 "${type}"（可用类型见节点面板）`);
					}
					const id = op.id ?? nextId(type, working.nodes);
					if (working.nodes.some(n => n.id === id)) {
						throw new Error(`add_node: 节点 id "${id}" 已存在`);
					}
					const kind = type.replace(/^Saros\./, '');
					const label = op.label ?? nextName(kind, working.nodes);
					const node: CanvasNode = {
						id,
						type,
						position: op.position ?? { x: 200 + working.nodes.length * 32, y: 160 + working.nodes.length * 28 },
						data: { ...(op.data ?? {}), label },
					};
					working.nodes.push(node);
					results.push({ opIndex: i, summary: `added node ${label} (${type})`, ids: [id] });
					break;
				}

				case 'update_node': {
					const node = resolveNodeRef(working.nodes, op.node);
					if (!node) {
						throw new Error(`update_node: 找不到节点 "${op.node}"`);
					}
					node.data = { ...node.data, ...op.patch };
					results.push({ opIndex: i, summary: `updated node ${node.data?.label ?? node.id}`, ids: [node.id] });
					break;
				}

				case 'delete_node': {
					const node = resolveNodeRef(working.nodes, op.node);
					if (!node) {
						throw new Error(`delete_node: 找不到节点 "${op.node}"`);
					}
					working.nodes = working.nodes.filter(n => n.id !== node.id);
					working.edges = working.edges.filter(e => e.source !== node.id && e.target !== node.id);
					results.push({ opIndex: i, summary: `deleted node ${node.data?.label ?? node.id}`, ids: [node.id] });
					break;
				}

				case 'connect': {
					const src = resolveNodeRef(working.nodes, op.source);
					const dst = resolveNodeRef(working.nodes, op.target);
					if (!src) { throw new Error(`connect: 找不到源节点 "${op.source}"`); }
					if (!dst) { throw new Error(`connect: 找不到目标节点 "${op.target}"`); }
					// Port-type validation when both handles are known.
					const srcSpec = getSpec(src.type);
					const dstSpec = getSpec(dst.type);
					// Cross-layer gate: orchestration nodes must NOT connect directly
					// to media nodes — they must route through a bridge (ComfyTV stage).
					// Skipped when either spec is unknown (kind unavailable).
					if (srcSpec && dstSpec && !canConnectLayers(srcSpec.kind, dstSpec.kind)) {
						throw new Error(
							`connect: 禁止跨层直连 ${src.data?.label ?? src.id} (${srcSpec.kind}) → ${dst.data?.label ?? dst.id} (${dstSpec.kind})，须经 ComfyTV stage 中转`,
						);
					}
					if (op.sourceHandle && op.targetHandle) {
						const outPort = srcSpec?.outputs.find(p => p.name === op.sourceHandle);
						const inPort = dstSpec?.inputs.find(p => p.name === op.targetHandle);
						if (outPort && inPort && !isPortTypeCompatible(outPort.type, inPort.type)) {
							throw new Error(
								`connect: 端口类型不兼容 ${src.data?.label ?? src.id}.${op.sourceHandle} (${outPort.type}) → ${dst.data?.label ?? dst.id}.${op.targetHandle} (${inPort.type})`,
							);
						}
					}
					// Dedupe identical edge.
					const dup = working.edges.find(e =>
						e.source === src.id && e.target === dst.id &&
						(op.sourceHandle ? e.sourceHandle === op.sourceHandle : true) &&
						(op.targetHandle ? e.targetHandle === op.targetHandle : true));
					if (!dup) {
						const id = op.id ?? `e-${src.id}-${dst.id}-${Date.now()}`;
						working.edges.push({
							id,
							source: src.id,
							target: dst.id,
							...(op.sourceHandle ? { sourceHandle: op.sourceHandle } : {}),
							...(op.targetHandle ? { targetHandle: op.targetHandle } : {}),
						});
					}
					results.push({ opIndex: i, summary: `connected ${src.data?.label ?? src.id} → ${dst.data?.label ?? dst.id}`, ids: [src.id, dst.id] });
					break;
				}

				case 'disconnect': {
					const src = resolveNodeRef(working.nodes, op.source);
					const dst = resolveNodeRef(working.nodes, op.target);
					if (!src) { throw new Error(`disconnect: 找不到源节点 "${op.source}"`); }
					if (!dst) { throw new Error(`disconnect: 找不到目标节点 "${op.target}"`); }
					const before = working.edges.length;
					working.edges = working.edges.filter(e =>
						!(e.source === src.id && e.target === dst.id &&
							(op.sourceHandle ? e.sourceHandle === op.sourceHandle : true) &&
							(op.targetHandle ? e.targetHandle === op.targetHandle : true)));
					if (working.edges.length === before) {
						throw new Error(`disconnect: ${src.data?.label ?? src.id} → ${dst.data?.label ?? dst.id} 之间没有连线`);
					}
					results.push({ opIndex: i, summary: `disconnected ${src.data?.label ?? src.id} → ${dst.data?.label ?? dst.id}`, ids: [src.id, dst.id] });
					break;
				}

				case 'select': {
					if (op.node == null) {
						selectedNodeId = null;
						results.push({ opIndex: i, summary: 'cleared selection' });
					} else {
						const node = resolveNodeRef(working.nodes, op.node);
						if (!node) { throw new Error(`select: 找不到节点 "${op.node}"`); }
						selectedNodeId = node.id;
						results.push({ opIndex: i, summary: `selected ${node.data?.label ?? node.id}`, ids: [node.id] });
					}
					break;
				}

				default: {
					const _never: never = op;
					throw new Error(`applyCanvasOps: 未知操作 ${(op as CanvasOp).op}`);
				}
			}
		} catch (err) {
			// Rollback the whole batch on first failure.
			return {
				model,
				results,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
				failedOpIndex: i,
				selectedNodeId,
			};
		}
	}

	return { model: working, results, ok: true, selectedNodeId };
}
