/*---------------------------------------------------------------------------------------------
 *  visual/fixtures — 场景枚举：注册表里每个节点 × 运行状态矩阵。
 *
 *  设计原则：
 *  1. 场景完全由 registry 派生（`getAllSpecs()`），新增节点自动进入画廊与截图基线，
 *     不需要手工维护清单 —— 这是"节点 UI 不回归"的关键。
 *  2. 每个场景自带**独立的 store 实例**，避免相互污染（picker pool 尤其敏感）。
 *  3. 上游图注入固定 3 张确定性假图：既能验证 picker pool 计数，也能给
 *     MaskPainter / TransformEditor / CropEditor 等内嵌编辑器提供背景纹理。
 *--------------------------------------------------------------------------------------------*/

import type { NodeSpec } from '../src/features/workflowEditor/comfyHost/registry';
import { fakeImageDataUrl } from './mocks';

export type RunStateName = 'idle' | 'running' | 'success' | 'error';

export const ALL_RUN_STATES: RunStateName[] = ['idle', 'running', 'success', 'error'];

/** 上游注入的假图数量（picker pool 计数断言依赖这个常量）。 */
export const UPSTREAM_IMAGE_COUNT = 3;

export interface VisualScenario {
	/** 稳定 ID，同时用作截图文件名：`<nodeType>__<state>` */
	id: string;
	nodeType: string;
	spec: NodeSpec;
	state: RunStateName;
	/** 画布上的节点 ID（store key 前缀） */
	nodeId: string;
	/** 上游生产者节点 ID（picker / 编辑器背景图来源） */
	upstreamNodeIds: string[];
	/** 是否往 store 注入上游假图 */
	withUpstream: boolean;
	/** 需要 WebGL（Three.js）→ 截图容差放宽 */
	needsWebGL: boolean;
}

const WEBGL_NODE_TYPES = new Set([
	'ComfyTV.MultiangleStage',
	'ComfyTV.RelightStage',
	'ComfyTV.MaterialStage',
	'Saros.Scene3D',
]);

/** 文件名安全化：`ComfyTV.ImageStage` → `ComfyTV.ImageStage`（点保留，斜杠等替换）。 */
export function safeFileName(s: string): string {
	return s.replace(/[^\w.\-]+/g, '_');
}

export interface BuildScenarioOptions {
	states?: RunStateName[];
	withUpstream?: boolean;
	/** 只保留这个 nodeType（URL `?only=`） */
	only?: string;
}

/** 从 registry 派生全部场景。纯函数，可单测。 */
export function buildScenarios(specs: NodeSpec[], opts: BuildScenarioOptions = {}): VisualScenario[] {
	const states = opts.states ?? ALL_RUN_STATES;
	const withUpstream = opts.withUpstream ?? true;
	const out: VisualScenario[] = [];
	for (const spec of specs) {
		if (opts.only && spec.type !== opts.only) { continue; }
		for (const state of states) {
			const nodeId = `vt-${safeFileName(spec.type)}`;
			out.push({
				id: `${safeFileName(spec.type)}__${state}`,
				nodeType: spec.type,
				spec,
				state,
				nodeId,
				upstreamNodeIds: [`${nodeId}-up`],
				withUpstream,
				needsWebGL: WEBGL_NODE_TYPES.has(spec.type),
			});
		}
	}
	return out;
}

/** 上游假图的 media ref 列表（确定性，顺序稳定）。 */
export function upstreamImageRefs(): string[] {
	const refs: string[] = [];
	for (let i = 0; i < UPSTREAM_IMAGE_COUNT; i++) {
		refs.push(fakeImageDataUrl(`UP-${i + 1}`, i === 0 ? '#1e293b' : i === 1 ? '#312e46' : '#1f2937'));
	}
	return refs;
}

/** 节点自身输出的假图（success 态 OUTPUT 区显示）。 */
export function ownOutputRefs(batch = 1): string[] {
	const refs: string[] = [];
	for (let i = 0; i < batch; i++) {
		refs.push(fakeImageDataUrl(`OUT-${i + 1}`, '#0f2d1f'));
	}
	return refs;
}
