/*---------------------------------------------------------------------------------------------
 *  Semantic Generation Flow — pure builder for "one sentence → a connected image-gen graph".
 *
 *  Docs: docs/Agent-画布编排设计方案.md P0 → `canvas_generate` tool.
 *
 *  `buildGenerateFlow(goal, opts)` produces a store-shaped { nodes, edges } graph:
 *    - one (or N) Saros.Prompt nodes (variants) → Saros.ModelImageGen nodes,
 *    - auto-wired prompt → model (TEXT → TEXT) and upstream JSON → prompt when chained,
 *    - provider/model auto-routed (explicit > resolveFirstImageGenDefaults).
 *
 *  Pure + DOM-free; the caller (webview) applies it to the store and the canvas
 *  renders via the existing store↔LiteGraph sync. Unit-testable without React.
 *--------------------------------------------------------------------------------------------*/

import { resolveFirstImageGenDefaults, type ImageGenProviderLike } from './workflowRun.js';
import { nextNodeId, type CanvasNode, type CanvasEdge } from './canvasOps.js';

export interface GenerateFlowVariant {
	/** Optional per-variant prompt. When omitted, the shared goal is used. */
	prompt?: string;
	/** Optional label override for the Prompt node. */
	label?: string;
}

export interface BuildGenerateFlowOptions {
	/** Explicit provider/model wins over auto-route. */
	providerId?: string;
	modelId?: string;
	/** Authenticated providers used for auto-routing when explicit is absent. */
	providers?: ImageGenProviderLike[];
	/** Number of variants to create (default 1). Ignored when `variants` is set. */
	count?: number;
	/** Per-variant prompts/labels. */
	variants?: GenerateFlowVariant[];
	/** Existing graph — used for id/name dedup and to chain after an optional upstream. */
	existing?: { nodes: CanvasNode[]; edges: CanvasEdge[] };
	/** Chain the flow after this existing node (its TEXT/JSON output → first prompt input). */
	chainAfterId?: string;
	/** Negative prompt applied to every ModelImageGen node. */
	negativePrompt?: string;
	/** Image size, e.g. "1024x1024". */
	size?: string;
	/** Seed for deterministic ids (tests). */
	seed?: number;
	/** Position origin for the generated columns. */
	origin?: { x: number; y: number };
}

export interface GenerateFlowResult {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	/** Ids of the newly created ModelImageGen nodes (for run targeting). */
	entryIds: string[];
	/** Ids of the newly created Prompt nodes. */
	promptIds: string[];
	/** Provider/model actually applied (auto-routed or explicit). */
	routing: { providerId?: string; modelId?: string };
}

/** The kind string used for auto-naming generated image nodes. */
export const IMAGE_NODE_KIND = 'ModelImageGen';
/** The kind string used for auto-naming generated prompt nodes. */
export const PROMPT_NODE_KIND = 'Prompt';

const DEFAULT_ORIGIN = { x: 240, y: 120 };

/**
 * Build a connected prompt→image-generation flow.
 *
 * Layout: each variant gets a Prompt column at `origin.x + i*300`, with its
 * ModelImageGen at `origin.x + i*300 + 220` (i.e. same row, offset right).
 */
export function buildGenerateFlow(goal: string, options: BuildGenerateFlowOptions = {}): GenerateFlowResult {
	const { existing = { nodes: [], edges: [] }, chainAfterId } = options;

	// ── Resolve routing: explicit wins, else auto-route. ───────────────────
	const routing = resolveRouting(options);

	// ── Variants ────────────────────────────────────────────────────────────
	const count = options.variants?.length ?? options.count ?? 1;
	const variantList: GenerateFlowVariant[] = [];
	for (let i = 0; i < count; i++) {
		variantList.push(options.variants?.[i] ?? {});
	}

	const nodes: CanvasNode[] = [...existing.nodes];
	const edges: CanvasEdge[] = [...existing.edges];
	const entryIds: string[] = [];
	const promptIds: string[] = [];
	const origin = options.origin ?? DEFAULT_ORIGIN;

	// ★ 用单调 counter 替代 idSeed 兜底：counter 按 kind 分桶，保证同一次生成流内
	//   同类节点 id 严格递增（即便 existing 里没有该 kind 节点，连续调用也
	//   image-1、image-2 而非撞车后靠 idSeed++ 补救）。确定性 id 语义不变
	//   （仍是 image-N），只是不复用、不回退。
	//   注意：counter 是**本次生成流局部**的；跨会话/跨调用不复用需持久化（方案 #5）。
	const idCounter = new Map<string, number>();
	const idSeed = options.seed ?? 0;
	const uid = (kind: string): string => {
		let id = nextNodeId(kind, nodes, idSeed, idCounter);
		// 兜底（理论上 counter 已保证不撞，保留以防 explicit 节点占位同一 id）。
		if (nodes.some(n => n.id === id) || entryIds.includes(id) || promptIds.includes(id)) {
			id = nextNodeId(kind, nodes, idSeed + 1, idCounter);
		}
		return id;
	};

	for (let i = 0; i < variantList.length; i++) {
		const variant = variantList[i];
		const promptText = variant.prompt ?? goal;
		const promptId = uid(PROMPT_NODE_KIND);
		const genId = uid(IMAGE_NODE_KIND);

		const px = origin.x + i * 300;
		const py = origin.y;

		const promptNode: CanvasNode = {
			id: promptId,
			type: 'Saros.Prompt',
			position: { x: px, y: py },
			data: {
				label: variant.label ?? (variantList.length > 1 ? `${IMAGE_NODE_KIND}-${i + 1} 提示` : '提示'),
				prompt: promptText,
			},
		};
		const genNode: CanvasNode = {
			id: genId,
			type: 'Saros.ModelImageGen',
			position: { x: px + 220, y: py },
			data: {
				label: `${IMAGE_NODE_KIND}-${i + 1}`,
				prompt: promptText,
				providerId: routing.providerId ?? '',
				modelId: routing.modelId ?? '',
				...(options.negativePrompt ? { negativePrompt: options.negativePrompt } : {}),
				...(options.size ? { size: options.size } : {}),
			},
		};

		nodes.push(promptNode, genNode);
		promptIds.push(promptId);
		entryIds.push(genId);

		edges.push({
			id: `e-${promptId}-${genId}`,
			source: promptId,
			target: genId,
			sourceHandle: 'output',
			targetHandle: 'prompt',
		});
	}

	// ── Chain after an existing upstream node (TEXT/JSON → first prompt). ───
	if (chainAfterId) {
		const upstream = nodes.find(n => n.id === chainAfterId);
		if (upstream) {
			const firstPrompt = promptIds[0];
			if (firstPrompt) {
				edges.push({
					id: `e-${chainAfterId}-${firstPrompt}`,
					source: chainAfterId,
					target: firstPrompt,
					sourceHandle: undefined,
					targetHandle: undefined,
				});
			}
		}
	}

	return { nodes, edges, entryIds, promptIds, routing };
}

/** Explicit provider/model wins; otherwise auto-route from authenticated providers. */
export function resolveRouting(options: BuildGenerateFlowOptions): { providerId?: string; modelId?: string } {
	if (options.providerId && options.modelId) {
		return { providerId: options.providerId, modelId: options.modelId };
	}
	const auto = resolveFirstImageGenDefaults(options.providers);
	if (auto) {
		return { providerId: auto.providerId, modelId: auto.modelId };
	}
	return {};
}
