/*---------------------------------------------------------------------------------------------
 *  stageWorkflowExecutor — P1: execute a ComfyTV stage as its FULL ComfyUI workflow.
 *
 *  A ComfyTV stage (e.g. ComfyTV.ImageStage) is not a plain class_type — it maps
 *  to a complete workflow. 本项目**完全不依赖 ComfyTV 后端 API**：workflow 的
 *  api_json 已静态打包进 builtinWorkflows/（由 scripts/export-builtin-workflows.py
 *  从本机 ComfyTV DB 导出）。执行流程：
 *
 *    1. 读内置模板 getBuiltinWorkflowConfig(kind, label) → { api_json, result, inputs }
 *    2. clone api_json, inject form/upstream values into the bound inputs
 *       (bindings: node_id → input_name → { from, default, cast, prefix, suffix })
 *    3. POST /prompt (runner.invoke) with the injected prompt
 *    4. read the workflow's result node output and persist it as snapshots
 *
 *  All helpers are pure except the invoke path (injected runner).
 *  当 kind 无内置模板时，`runStageWorkflow` 抛 `StageWorkflowUnavailableError`
 *  使调用方可降级到单节点执行。
 *--------------------------------------------------------------------------------------------*/

import type { IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { MediaSnapshotEntry } from './mediaSnapshot.js';
import { comfyOutputsToSnapshots } from './nodeExecutor.js';
import { materializeComfyImageRefs } from './comfyImagePersist.js';
// 见 nodeExecutor.ts 同款注释。
const _bridge = (globalThis as { __vssarosBridge?: { createComfyFetch: typeof import('../../../bridge/messageClient.js')['createComfyFetch'] } }).__vssarosBridge
	?? (() => { throw new Error('vssarosBridge not initialised'); })();
const { createComfyFetch } = _bridge;
import type { MediaKind } from './mediaSnapshot.js';
import { getBuiltinWorkflowConfig, listBuiltinWorkflows } from './builtinWorkflows/index.js';
import { ASSET_REFS_PROP, parseAssetRefs, refType } from './assetRefs.js';
import { isComfyViewRef, resolveLoadImageImageRef } from './imageGenToComfyBridge.js';
import type { BridgeFetchLike } from './imageGenToComfyBridge.js';

/**
 * ★ 硬超时包裹（2026-08-26 修复「生成卡死」）：不依赖底层 fetch 是否 Honor
 *   AbortSignal（proxiedComfyFetch 的 sendRequest 会忽略 signal），直接用一个
 *   独立 setTimeout + Promise.race 强制在 ms 后 reject。无论 fetch 实现如何，
 *   调用方都不会永久挂起。
 */
function withHardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} 硬超时（${ms}ms）— 底层请求无响应`)), ms);
		p.then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
}

/** One bound input inside a workflow config (ComfyTV WorkflowInputBinding). */
export interface WorkflowInputBindingSpec {
	/** stage input name that provides the value (e.g. "prompt") */
	from?: string;
	default?: unknown;
	prefix?: string;
	suffix?: string;
	required?: boolean;
	error?: string;
	cast?: string;
}

/** bindings keyed node_id → input_name → spec. */
export type WorkflowBindings = Record<string, Record<string, WorkflowInputBindingSpec>>;

export interface StageWorkflowApiJson {
	[nodeId: string]: {
		class_type: string;
		inputs: Record<string, unknown>;
	};
}

export interface StageWorkflowConfig {
	api_json: StageWorkflowApiJson;
	result?: { type?: string; node?: string };
	inputs?: WorkflowBindings;
	sizing?: unknown;
	prune_when_missing?: unknown[];
	meta?: Record<string, unknown>;
}

/**
 * ComfyTV 自定义节点（ImageStage/VideoStage/...）运行时由后端解析、但在前端 UI 没有对应控件的
 * required inputs 占位表。ComfyUI `validate_node_inputs`（execution.py:850-861）只在键完全
 * 缺失时才报 `Required input is missing`，空字符串不算 missing。我们按字段名推断类型补占位：
 *   - 数字字段给 0；字符串字段给 ''；列表字段给 []；对象字段给 {}；可选 enum 给首项。
 * 出现 "Required input is missing: xxx" 时把 xxx 添到这里即可（key 不区分大小写）。
 */
export const RUNTIME_REQUIRED_INPUTS: Record<string, unknown> = {
	// 类型严格对齐 /object_info 的 INPUT_TYPES（INT→number、COMBO→options 内值、STRING→string）。
	force_run_token: 0,
	project_id: '',
	parent_output_id: 0,
	workflow: 'Local SD1.5',
	resolution: '1K',
	aspect_ratio: '1:1',
	batch_size: 1,
	main_prompt: '',
	selected_index: 1,
	custom_params: '{}',
	// texts/images 是 Autogrow 连线槽位，不能兜底。
};

/**
 * 节点级运行期占位字段（由 ComfyTV 后端运行时解析），非 binding 的 string
 * inputs 命中此集合才会被强制清空为 ''，其余 string inputs（真实值，如
 * sampler_name="euler"、ckpt_name="…safetensors"、CLIPTextEncode.text）
 * 必须保留。
 */
export const RUNTIME_PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
	'selected_index',
	'force_run_token',
	'project_id',
	'parent_output_id',
	'custom_params',
	'asset_id',
	'asset_key',
	'asset_subkey',
	'output_format',
]);

export interface StageWorkflowListEntry {
	id?: number | string;
	kind?: string;
	label?: string;
	default?: boolean;
	state?: string;
}

export interface StageWorkflowListResponse {
	kinds?: string[];
	workflows?: StageWorkflowListEntry[];
	recent_added?: string[];
}

/** Thrown when the runner / workflow DB cannot serve a stage workflow → degrade. */
export class StageWorkflowUnavailableError extends Error { }

/**
 * 校验 prompt 的节点引用完整性（POST /prompt 前）。
 *
 * ComfyUI api_json 里节点 input 以 `[sourceNodeId, slotIndex]` 引用上游输出。
 * 若 sourceNodeId 不在 prompt 里，ComfyUI 会在 validate_prompt 抛
 * `KeyError`（HTTP 400 `prompt_outputs_failed_validation`），报错信息是
 * 「Exception when validating node: '5'」这类**不可读**的错。
 *
 * ★ 根因场景（2026-08-19）：builtinWorkflows 由导出脚本从 ComfyTV DB 生成，
 * 导出时会**跳过未安装插件的自定义节点**（如 LaMa Erase 的
 * INPAINT_LoadInpaintModel / INPAINT_InpaintWithModel 依赖 comfyui-inpaint-nodes），
 * 但下游 SaveImage 仍引用这些节点 → api_json 残缺。执行前校验，把 KeyError
 * 换成可读的「workflow 残缺」错误，并让调用方降级单节点执行。
 *
 * 返回缺失的 sourceNodeId 列表（空 = 完整）。
 */
export function findMissingNodeRefs(prompt: StageWorkflowApiJson): string[] {
	const nodeIds = new Set(Object.keys(prompt));
	const missing = new Set<string>();
	for (const node of Object.values(prompt)) {
		const inputs = node?.inputs as Record<string, unknown> | undefined;
		if (!inputs || typeof inputs !== 'object') { continue; }
		for (const value of Object.values(inputs)) {
			// ComfyUI 节点引用：['nodeId', slotIndex]（nodeId 是 string，slot 是 number）
			if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
				if (!nodeIds.has(value[0])) { missing.add(value[0]); }
			}
		}
	}
	return [...missing].sort((a, b) => Number(a) - Number(b));
}

/** Parsed result of a ComfyTV `upstream_<kind>[:variant][idx]` binding `from`. */
export interface UpstreamFrom {
	kind: MediaKind | 'model';
	variant: 'annotated' | 'value' | 'masked' | undefined;
	index: number | undefined;
}

const UPSTREAM_RE = /^upstream_(image|video|audio|text|model)(?::(annotated|value|masked))?(?:\[(\d+)\])?$/;

/**
 * Parse a ComfyTV upstream binding `from` (e.g. "upstream_image:annotated[0]").
 * Mirrors ComfyTV's `_UPSTREAM_PAT` in runners/_workflow_resolve.py. Pure.
 */
export function matchUpstreamFrom(from: string): UpstreamFrom | null {
	const m = UPSTREAM_RE.exec(from);
	if (!m) { return null; }
	return {
		kind: m[1] as UpstreamFrom['kind'],
		variant: (m[2] ?? undefined) as UpstreamFrom['variant'],
		index: m[3] !== undefined ? Number(m[3]) : undefined,
	};
}

/**
 * Convert a `/view?filename=…&subfolder=…&type=…` URL into ComfyUI's annotated
 * filepath `subfolder/filename [type]` — mirrors ComfyTV `_view_url_to_annotated`.
 * Pure; returns the input unchanged when it doesn't look like a /view URL.
 */
export function viewUrlToAnnotated(url: string): string {
	const qIdx = url.indexOf('?');
	if (qIdx < 0) { return url; }
	const qs = new URLSearchParams(url.slice(qIdx + 1));
	const filename = qs.get('filename');
	if (!filename) { return url; }
	const subfolder = qs.get('subfolder') ?? '';
	const type = qs.get('type') ?? 'output';
	const prefix = subfolder ? `${subfolder}/` : '';
	return `${prefix}${filename} [${type}]`;
}

/**
 * Collect the first available snapshot ref per media kind across upstream nodes.
 * Order: upstreams order, then entry index. Ref is a `/view?` URL (or text).
 */
export function collectUpstreamRefs(
	store: MediaSnapshotStore,
	upstreams: string[] | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!upstreams) { return out; }
	for (const nodeId of upstreams) {
		for (const entry of store.byNode(nodeId)) {
			const kind = entry.media.kind;
			if (kind === 'unknown' || out[kind]) { continue; }
			out[kind] = entry.media.ref;
		}
	}
	return out;
}

/**
 * 把卡片上「钉住的资产引用」覆盖进 upstream 值表。
 *
 * 对齐 ComfyTV `injectAssetRefs` 的 **override** 语义：钉住的资产优先于同 slot
 * 的上游连线。项目侧的 upstream 绑定按媒体 kind 取单一 ref（`upstream_image`
 * 无 slot 维度），因此每种 kind 取 **slot 最小** 的那条引用。
 *
 * 数据来源 = `values[ASSET_REFS_PROP]`（node.properties.comfytv_image_refs，
 * 由 AssetReferences 区块经 wf-node-control 写回，可能是 JSON 字符串或数组）。
 * 纯函数（原地改 upstreamValues）。
 */
export function applyAssetRefOverrides(
	upstreamValues: Record<string, string>,
	values: Record<string, unknown>,
): void {
	const refs = parseAssetRefs(values[ASSET_REFS_PROP]);
	if (refs.length === 0) { return; }

	// kind → slot 最小的 ref
	const best = new Map<string, { slot: number; ref: string }>();
	for (const r of refs) {
		const kind = refType(r);
		const prev = best.get(kind);
		if (!prev || r.slot < prev.slot) { best.set(kind, { slot: r.slot, ref: r.ref }); }
	}
	for (const [kind, hit] of best) {
		upstreamValues[kind] = hit.ref;
	}
}

/**
 * Resolve a binding `from` against form values + upstream snapshot refs.
 * Supported forms (mirrors ComfyTV bindings):
 *   - upstream_<kind>[:annotated|value|masked][idx] → upstream ref (annotated variant converted)
 *   - main_prompt                          → values.prompt / values.main_prompt
 *   - option:<key>                         → values.<key>
 *   - literal:<value>                      → the literal itself
 *   - anything else                        → values.<from>
 * Pure.
 */
export function resolveBindingValue(
	from: string,
	values: Record<string, unknown>,
	upstreamValues: Record<string, string> | undefined,
): { has: boolean; value: unknown } {
	const upstream = matchUpstreamFrom(from);
	if (upstream) {
		const url = upstreamValues?.[upstream.kind];
		if (url) {
			const v = upstream.variant === 'annotated' ? viewUrlToAnnotated(url) : url;
			return { has: true, value: v };
		}
		return { has: false, value: undefined };
	}
	if (from === 'main_prompt') {
		const v = values['prompt'] ?? values['main_prompt'];
		return v !== undefined && v !== null && v !== '' ? { has: true, value: v } : { has: false, value: undefined };
	}
	if (from.startsWith('option:')) {
		const v = values[from.slice(7)];
		return v !== undefined && v !== null && v !== '' ? { has: true, value: v } : { has: false, value: undefined };
	}
	if (from.startsWith('literal:')) {
		return { has: true, value: from.slice(8) };
	}
	const v = values[from];
	return v !== undefined && v !== null && v !== '' ? { has: true, value: v } : { has: false, value: undefined };
}

/**
 * Replace `{{key}}` placeholders in a prefix/suffix template with the matching
 * form value (String()). Unknown/empty keys are left verbatim so an untouched
 * template stays readable and a missing optional widget doesn't inject garbage.
 * Pure.
 */
export function interpolateBindingTemplate(
	template: string,
	values: Record<string, unknown>,
): string {
	return template.replace(/\{\{([^}]+)\}\}/g, (_m, key: string) => {
		const k = key.trim();
		const v = values[k];
		return v === undefined || v === null || v === '' ? `{{${key}}}` : String(v);
	});
}

/**
 * Pick the workflow label to use for a kind: prefer the default flag, else the
 * first entry. Pure.
 */
export function pickDefaultWorkflowLabel(
	resp: StageWorkflowListResponse | undefined,
	kind: string | undefined,
): string | undefined {
	const list = resp?.workflows ?? [];
	const byKind = kind ? list.filter(w => w.kind === kind) : list;
	const def = byKind.find(w => w.default);
	return def?.label ?? byKind[0]?.label;
}

/**
 * Clone api_json and inject values into the bound inputs. For each binding
 * (node_id.input_name), resolve the value via `resolveBindingValue` (form values
 * + upstream snapshot refs); fall back to the binding's `default`; apply
 * `cast`/`prefix`/`suffix`. Unbound inputs are left untouched. Pure.
 *
 * Defensive: returns `{prompt: {}, applied: 0}` when `apiJson` is null/undefined
 * or a non-object so the caller (runStageWorkflow) gets a graceful empty result
 * instead of "Cannot convert undefined or null to object".
 */
export function injectWorkflowValues(
	apiJson: StageWorkflowApiJson | null | undefined,
	bindings: WorkflowBindings | undefined,
	values: Record<string, unknown>,
	upstreamValues?: Record<string, string>,
): { prompt: StageWorkflowApiJson; applied: number } {
	const prompt: StageWorkflowApiJson = {};
	let applied = 0;
	if (!apiJson || typeof apiJson !== 'object') { return { prompt, applied }; }
	for (const [nodeId, node] of Object.entries(apiJson)) {
		const inputs = { ...(node.inputs ?? {}) };
		const nodeBindings = bindings?.[nodeId];
		if (nodeBindings) {
			for (const [inputName, spec] of Object.entries(nodeBindings)) {
				const key = spec.from ?? inputName;
				const resolved = resolveBindingValue(key, values, upstreamValues);
				let raw: unknown;
				if (resolved.has) {
					raw = resolved.value;
				} else if (spec.default !== undefined) {
					raw = spec.default;
				} else {
					continue;
				}
				let v: unknown = raw;
				switch (spec.cast) {
					case 'int': v = Math.round(Number(raw)); break;
					case 'float': v = Number(raw); break;
					case 'string': v = String(raw); break;
					case 'boolean': v = raw === true || raw === 'true' || raw === 1 || raw === '1'; break;
				}
				if (spec.prefix || spec.suffix) {
					const pre = interpolateBindingTemplate(spec.prefix ?? '', values);
					const suf = interpolateBindingTemplate(spec.suffix ?? '', values);
					v = `${pre}${v}${suf}`;
				}
				inputs[inputName] = v;
				applied++;
			}
		}
		prompt[nodeId] = { ...node, inputs };
	}
	return { prompt, applied };
}

/**
 * ComfyTV 的 Stage 节点（ComfyTV.ImageStage 等）把 batch_size / resolution /
 * aspect_ratio / workflow / selected_index / main_prompt 等作为节点 INPUTS，
 * 由节点 execute() 透传给底层流程（见 ComfyTV nodes/stages/generators.py 的
 * ImageStage.execute → invoke_runner(options={resolution, aspect_ratio, batch_size})）。
 *
 * 内置模板（builtinWorkflows/）对多数 workflow 的 bindings 只暴露 main_prompt
 * （注入 CLIPTextEncode 的 text），其余 option 不在 bindings 里 →
 * injectWorkflowValues 不会覆盖 → 永远用模板默认值（batch_size=1、resolution=1K…）。
 * 这与用户实际改动（画布/表单控件）不符，正是「batch_size 不生效」的根因。
 *
 * 这里把用户在画布控件里改过的值直接覆写到 stage 节点（class_type === type）的
 * inputs，与 ComfyTV 后端 expansion 读取节点 inputs 的行为完全一致。仅当该 input
 * 确实存在于 stage 节点时才覆写，避免误写不存在的字段。
 */
const STAGE_OPTION_MAP: ReadonlyArray<readonly [input: string, src: string, kind: 'int' | 'float' | 'str']> = [
	['batch_size', 'batch_size', 'int'],
	['resolution', 'resolution', 'str'],
	['aspect_ratio', 'aspect_ratio', 'str'],
	['workflow', 'workflow', 'str'],
	['selected_index', 'selected_index', 'int'],
	['seed', 'seed', 'int'],
	['negative', 'negative', 'str'],
	['main_prompt', 'main_prompt', 'str'],
	['main_prompt', 'prompt', 'str'],
];

function applyStageOptionValues(
	apiJson: StageWorkflowApiJson,
	stageType: string,
	values: Record<string, unknown>,
): void {
	let stageId: string | undefined;
	for (const [id, n] of Object.entries(apiJson)) {
		if (n.class_type === stageType) { stageId = id; break; }
	}
	if (!stageId) { return; }
	const stageInputs = apiJson[stageId].inputs;
	if (!stageInputs || typeof stageInputs !== 'object') { return; }
	let applied = 0;
	for (const [input, src, kind] of STAGE_OPTION_MAP) {
		const raw = values[src];
		if (raw === undefined || raw === null || raw === '') { continue; }
		let v: unknown = raw;
		if (kind === 'int') {
			v = Math.round(Number(raw));
			if (!Number.isFinite(v as number)) { continue; }
		} else if (kind === 'float') {
			v = Number(raw);
			if (!Number.isFinite(v as number)) { continue; }
		}
		if (input in stageInputs) {
			stageInputs[input] = v;
			applied++;
			// eslint-disable-next-line no-console
			console.warn(`[applyStageOptionValues] ${stageId}.${input} <- ${JSON.stringify(v)} (values.${src})`);
		}
	}
	// eslint-disable-next-line no-console
	console.warn(`[applyStageOptionValues] stage=${stageId} type=${stageType} applied=${applied}`);
}

/** Normalize the result node's /history output into slot-layer outputs. Pure.
 *
 * Defensive: returns `undefined` for `undefined`/`null`/non-object inputs so
 * callers can short-circuit cleanly (no "Cannot read properties of undefined").
 */
export function extractResultOutputs(
	outputs: Record<string, unknown> | undefined | null,
	resultNode: string | undefined,
): Record<string, unknown> | undefined {
	if (!outputs || typeof outputs !== 'object') { return undefined; }
	if (resultNode && outputs[resultNode] && typeof outputs[resultNode] === 'object') {
		return outputs[resultNode] as Record<string, unknown>;
	}
	// fallback: single node, or anything under the prompt node key
	const direct = outputs['1'];
	if (direct && typeof direct === 'object') { return direct as Record<string, unknown>; }
	const keys = Object.keys(outputs);
	if (keys.length === 1) {
		const v = outputs[keys[0]];
		if (v && typeof v === 'object') { return v as Record<string, unknown>; }
	}
	return outputs;
}

export interface StageWorkflowRunOptions {
	runner: IComfyRunner;
	/** logical node id (snapshot keys) */
	nodeId: string;
	/**
	 * 快照归档键（= stageUid，见 stageIdentity）。缺省回退 nodeId。
	 *
	 * ★ 为什么必须与 nodeId 分离：nodeCard 读快照用 `stageUid`（随机 uuid，
	 *   永不复用，防止 nodeId 复用串号），而旧代码这里用 nodeId 归档 →
	 *   写入 nodeId、读取 stageUid → OUTPUT 永远读不到新图。
	 */
	snapshotKey?: string;
	/** stage class type (e.g. "ComfyTV.ImageStage") */
	type: string;
	/** stage kind (e.g. "image") — used for workflow lookup */
	kind: string;
	/** workflow kind override (spec.comfyTV.workflowKind) */
	workflowKind?: string;
	/** extra workflow kinds whose labels populate this stage's shared dropdown
	 *  (e.g. ImageVariationsStage = ['multiview','sequence']). When set, the
	 *  resolved kind is chosen by which kind contains the selected label. */
	workflowKinds?: string[];
	/** form/editor values (prompt, seed, …) */
	values: Record<string, unknown>;
	/** upstream node ids (P2: their snapshots feed `upstream_*` bindings) */
	upstreams?: string[];
	store: MediaSnapshotStore;
	onProgress?: (p: { progress?: number }) => void;
	signal?: AbortSignal;
	/**
	 * Provider→Comfy LoadImage bridge：把上游图片快照 ref（http/data URL，非
	 * Comfy /view 引用）上传到 ComfyUI，返回可被原生 LoadImage 消费的 /view
	 * 引用。三阶段串联（阶段1 透明 PNG 物化成 data: URL → 阶段2 内嵌 LoadImage
	 * 作 first_frame）必须经此桥接，否则原生 LoadImage 把 data: URL 当文件路径
	 * 报 `Invalid image file`。缺省时不做桥接（单阶段/已传 /view 引用场景）。
	 *
	 * ★ 第二个参数为可选 AbortSignal（2026-08-26 修复卡死）：必须透传到内部
	 *   fetch 调用，否则 ComfyUI /upload/image 无响应时整个流程永远不返回。
	 */
	resolveImageRef?: (ref: string, signal?: AbortSignal) => Promise<{ ok: boolean; image?: string; error?: string }>;
	/**
	 * 可选的 prompt 后处理钩子：在所有值注入（applyInputs + applyStageOptionValues +
	 * uploadLoadImageRefs）完成后、runner.invoke 前调用。用于调用方对已解析的 prompt
	 * JSON 做条件性修改（如 fallback 模式下根据上游是否有参考图切换 img2img/text2img）。
	 * 纯函数，接收深拷贝后的 prompt 引用，原地修改即可。
	 */
	promptPostProcess?: (prompt: StageWorkflowApiJson) => void;
}

export interface StageWorkflowRunResult {
	promptId: string;
	status: 'success' | 'error' | 'canceled';
	error?: string;
	durationMs?: number;
	entries: MediaSnapshotEntry[];
}

/**
 * Run a stage as its full workflow. Throws StageWorkflowUnavailableError when
 * the runner has no ComfyTV extension or the workflow can't be resolved —
 * callers should then degrade to single-node execution.
 */
/**
 * 把模板内原生 LoadImage 节点注入的 data:/http URL 参考图上传到 ComfyUI，得到
 * input 目录文件名。原生 LoadImage.image 只接受文件名（COMBO），不接受 data:/http
 * URL —— 否则报 `image - Invalid image file: data:...`（R2V/LTX 图生视频模板的
 * 参考图经 upstream_image 注入时踩到）。resolveImageRef 缺省时用默认桥
 * （resolveLoadImageImageRef + createComfyFetch 代理，能绕过 data: CSP 与 403）。
 */
async function uploadLoadImageRefsForPrompt(
	prompt: StageWorkflowApiJson,
	runner: IComfyRunner,
	resolveImageRef?: (ref: string) => Promise<{ ok: boolean; image?: string; error?: string }>,
): Promise<void> {
	for (const node of Object.values(prompt)) {
		if (!node || node.class_type !== 'LoadImage') { continue; }
		const inputs = node.inputs as Record<string, unknown> | undefined;
		const img = typeof inputs?.image === 'string' ? inputs.image : '';
		if (!/^(data:|https?:)/i.test(img)) { continue; } // 已是文件名 / 其他，跳过
		const resolve = resolveImageRef ?? ((r: string) => resolveLoadImageImageRef({
			ref: r,
			baseUrl: runner.baseUrl,
			// ★ createComfyFetch 是**工厂函数**，必须传 baseUrl 调用才能返回真正的 fetch
			//   实现（之前直接传函数本身 → "fetchImpl" 不是 fetch，跑不通、r.ok 静默 false）。
			fetchImpl: createComfyFetch(runner.baseUrl) as unknown as BridgeFetchLike,
		}));
		const r = await resolve(img);
		if (r.ok && r.image) {
			// resolveLoadImageImageRef 返回 /view?filename=xxx 引用，LoadImage 只要文件名
			const m = /[?&]filename=([^&]+)/.exec(r.image);
			inputs.image = m ? decodeURIComponent(m[1]) : r.image;
			// eslint-disable-next-line no-console
			console.warn(`[runStageWorkflow] LoadImage ref uploaded → image=${inputs.image}`);
		} else {
			// ★ 上传失败的诊断：之前静默返回（没日志），debug 时找不到原因
			// eslint-disable-next-line no-console
			console.warn(`[runStageWorkflow] LoadImage upload FAILED (skip): ref_prefix=${img.slice(0, 30)}... error=${r.error ?? '(no error msg)'}`);
		}
	}
}

/**
 * 模板 **输入字段名 → 加载器节点类名**（用于查 object_info 可选列表）。
 * ⚠ 键是 binding 的字段名（ckpt_name/unet_name/...），值是节点类——
 * 此前写反（类名→字段名）导致查表恒 undefined、预检恒空放行（2026-09-03）。
 */
const LOADER_NODE_FIELDS: Record<string, string> = {
	ckpt_name: 'CheckpointLoaderSimple',
	unet_name: 'UNETLoader',
	clip_name: 'CLIPLoader',
	vae_name: 'VAELoader',
	lora_name: 'LoraLoader',
};

/**
 * ★ 加载器模型存在性预检（2026-09-03）。
 *
 * 模板里写死的辅助模型（如 Qwen 的 text encoder `qwen_2.5_vl_7b_fp8_scaled` /
 * VAE `qwen_image_vae`、LayeredDiffusion LoRA）不在任何下拉里，缺失时 ComfyUI
 * 只报 `value not in list` —— 用户无从下手。这里在执行前把模板涉及的所有加载器
 * 模型与对应 object_info 列表核对，缺失即返回中文清单（含目录指引）。
 *
 * 宽容策略：object_info 拉取失败 / 列表为空 → 不判缺失（交由 ComfyUI 原生报错），
 * 避免预检自身故障阻塞正常执行。
 */
async function checkBuiltinLoaderModels(
	runner: IComfyRunner | undefined,
	cfg: StageWorkflowConfig,
	values: Record<string, unknown> | undefined,
): Promise<string[]> {
	if (!runner || typeof cfg.inputs !== 'object' || cfg.inputs === null) {
		// eslint-disable-next-line no-console
		console.warn('[loaderPrecheck] skip: runner=', Boolean(runner), 'inputs type=', typeof cfg.inputs);
		return [];
	}
	const base = runner.baseUrl.replace(/\/$/, '');
	const toCheck: Array<{ node: string; value: string }> = [];
	for (const [nodeId, fieldMap] of Object.entries(cfg.inputs)) {
		if (!fieldMap || typeof fieldMap !== 'object') { continue; }
		for (const [field, bindingRaw] of Object.entries(fieldMap)) {
			const node = LOADER_NODE_FIELDS[field];
			if (!node || !bindingRaw || typeof bindingRaw !== 'object') { continue; }
			const b = bindingRaw as { from?: unknown; default?: unknown };
			const fromOpt = typeof b.from === 'string' && b.from.startsWith('option:')
				? String(values?.[b.from.slice('option:'.length)] ?? '')
				: '';
			const actual = (fromOpt || (typeof b.default === 'string' ? b.default : '')).trim();
			if (actual) { toCheck.push({ node, value: actual }); }
		}
	}
	if (toCheck.length === 0) {
		// eslint-disable-next-line no-console
		console.warn('[loaderPrecheck] skip: toCheck 为空');
		return [];
	}
	const lists = new Map<string, string[]>();
	for (const node of new Set(toCheck.map(c => c.node))) {
		try {
			const r = await fetch(`${base}/object_info/${node}`);
			if (!r.ok) { lists.set(node, []); continue; }
			const j = await r.json() as { [k: string]: { input?: { required?: Record<string, [string[], Record<string, unknown>]> } } };
			const field = LOADER_NODE_FIELDS[node];
			const l = j?.[node]?.input?.required?.[field]?.[0];
			lists.set(node, Array.isArray(l) ? l : []);
		} catch {
			lists.set(node, []);
		}
	}
	const missing: string[] = [];
	for (const c of toCheck) {
		const l = lists.get(c.node) ?? [];
		if (l.length > 0 && !l.includes(c.value)) {
			missing.push(`${c.value}（${c.node} 加载器，可经「依赖管理」下载）`);
		}
	}
	// eslint-disable-next-line no-console
	console.warn('[loaderPrecheck] toCheck=', JSON.stringify(toCheck), 'listSizes=', [...lists.entries()].map(([k, v]) => `${k}:${v.length}`).join(','), 'missing=', missing.length);
	return missing;
}

export async function runStageWorkflow(options: StageWorkflowRunOptions): Promise<StageWorkflowRunResult> {
	// eslint-disable-next-line no-console
	console.warn(`[runStageWorkflow] ▶ START nodeId=${options.nodeId} type=${options.type} hasResolveImageRef=${Boolean(options.resolveImageRef)} signal=${options.signal ? 'present' : 'none'}`);
	const { runner, nodeId, type, kind, workflowKind, values, upstreams, store, onProgress, signal, resolveImageRef } = options;
	// 快照归档键：优先 stageUid（与 nodeCard 读侧一致），缺省 nodeId。
	const snapshotKey = options.snapshotKey ?? nodeId;
	const wfKind = workflowKind || kind;
	// 完全不依赖 ComfyTV 后端 API：直接读内置静态模板（builtinWorkflows/）。
	// 模板 api_json 是纯原生 ComfyUI workflow，POST /prompt 即可出图，无需
	// ComfyTV 扩展的 /comfytv/workflows、/comfytv/workflows/config 等端点。
	// 未命中才抛 StageWorkflowUnavailableError，由调用方降级单节点执行。
	const candidateKinds = options.workflowKinds?.length ? options.workflowKinds : [wfKind];
	const rawWf = values?.workflow;
	const selectedLabel = typeof rawWf === 'string' && rawWf ? rawWf : undefined;
	// 解析实际 kind：优先按用户选中的 label 落在哪个候选 kind 的列表里，
	// 否则回退到默认 kind + 默认 label（对齐 ComfyTV 运行时按 label 推断 kind）。
	let resolvedKind = wfKind;
	if (selectedLabel) {
		for (const k of candidateKinds) {
			if (listBuiltinWorkflows(k).workflows.some(w => w.label === selectedLabel)) { resolvedKind = k; break; }
		}
	}
	const builtinList = listBuiltinWorkflows(resolvedKind);
	const label = selectedLabel ?? pickDefaultWorkflowLabel(builtinList, resolvedKind);
	const cfg: StageWorkflowConfig | undefined = label
		? getBuiltinWorkflowConfig(resolvedKind, label)
		: undefined;
	if (!cfg || typeof cfg.api_json !== 'object' || cfg.api_json === null) {
		throw new StageWorkflowUnavailableError(`kind ${wfKind} 没有可用内置 workflow`);
	}
	// ★ 加载器模型存在性预检（2026-09-03）：模板写死的辅助模型（Qwen text
	//   encoder / VAE / LayeredDiffusion LoRA 等）缺失时给出中文指引，而不是等
	//   ComfyUI 报 `value not in list`。预检自身失败不阻塞（交由 ComfyUI 原生报错）。
	try {
		const missing = await checkBuiltinLoaderModels(runner, cfg, values);
		if (missing.length > 0) {
			// ★ 区分两类缺失，给不同指引：
			//   ① qwen/flux 等 Diffusion 模型填进了 SDXL 模板（或反之）= 组错配 →
			//      指引切模板（模型下拉已按模板过滤，重载后一般不会走到这）；
			//   ② 辅助模型（text encoder/VAE/LoRA）真缺失 → 指引「依赖管理」下载。
			const isDiffusion = /qwen|flux|sd3|wan|auraflow/i.test(missing.join(' '));
			throw new Error(
				isDiffusion
					? `模型与模板不匹配：${missing.join('；')}。\n「${label}」模板需要 Checkpoint 模型（SDXL 系）；` +
						`若要使用 qwen 等 Diffusion 模型，请把「工作流」切换为「Qwen 贴纸 (默认)」后重试。`
					: `模板「${label}」缺少辅助模型：\n- ${missing.join('\n- ')}\n请打开「依赖管理」下载对应模型后重试。`,
			);
		}
	} catch (e) {
		if (e instanceof Error && /缺少辅助模型|模型与模板不匹配/.test(e.message)) { throw e; }
		// eslint-disable-next-line no-console
		console.warn('[runStageWorkflow] 加载器模型预检跳过（不阻塞）：', e);
	}
	// P2: inject upstream snapshots (first ref per media kind) so chained
	// stages consume their predecessor's output.
	const upstreamValues = collectUpstreamRefs(store, upstreams);
	// 「资产引用」（asset references，对齐 ComfyTV ImageStage）：卡片上钉住的资产
	// **覆盖**同媒体类型的上游连线（与 ComfyTV injectAssetRefs 的 override 语义
	// 一致）。项目侧 upstream 绑定按 kind 取单一 ref（无 slot 维度），故取
	// slot 最小的一条作为该 kind 的输入。见 assetRefs.ts。
	applyAssetRefOverrides(upstreamValues, values);
	// ★ 三阶段串联桥接：上游图片快照 ref 可能是 data:/http URL（阶段产物经
	//   materializeComfyImageRefs 物化），而 stage 内嵌的原生 LoadImage 只认
	//   Comfy /view 引用或服务端文件名。这里在注入前把非 /view 引用上传到
	//   ComfyUI，换成 /view 引用（后续 upstream_image:annotated 会再转 annotated
	//   path 供 LoadImage 消费）。视频（kind=video）保持 /view 引用不物化，无需桥接。
	if (resolveImageRef && typeof upstreamValues.image === 'string' && upstreamValues.image && !isComfyViewRef(upstreamValues.image)) {
		// eslint-disable-next-line no-console
		console.warn(`[runStageWorkflow] ⏳ before resolveImageRef (ref=${upstreamValues.image.slice(0, 80)})`);
		const bridged = await withHardTimeout(resolveImageRef(upstreamValues.image, options.signal), 35_000, 'resolveImageRef');
		// eslint-disable-next-line no-console
		console.warn(`[runStageWorkflow] ✅ after resolveImageRef ok=${bridged.ok}`);
		if (bridged.ok && bridged.image) {
			upstreamValues.image = bridged.image;
		} else {
			// 桥接失败：保留原 ref（让 LoadImage 报 Invalid image file），
			// 比静默替换成错误值更好排查。记录一条诊断日志。
			// eslint-disable-next-line no-console
			console.warn(`[runStageWorkflow] upstream image bridge failed: ${bridged.error ?? 'unknown'} (ref=${upstreamValues.image.slice(0, 60)})`);
		}
	}
	// eslint-disable-next-line no-console
	console.warn('[runStageWorkflow] upstreams=' + JSON.stringify(upstreams) + ' upstreamValues=' + JSON.stringify(upstreamValues));
	const { prompt } = injectWorkflowValues(cfg.api_json, cfg.inputs, values, upstreamValues);
	// 把画布/表单里改过的 stage option（batch_size/resolution/aspect_ratio/workflow…）
	// 直接覆写到 stage 节点的 inputs（后端 bindings 多数不覆盖这些 option，否则永远用模板默认值）。
	applyStageOptionValues(prompt, type, values);
	// ★ 上传桥：模板内原生 LoadImage 的 data:/http URL 参考图 → 上传取文件名
	//   （否则 LoadImage 报 Invalid image file，见 uploadLoadImageRefsForPrompt）。
	// eslint-disable-next-line no-console
	console.warn('[runStageWorkflow] ⏳ before uploadLoadImageRefsForPrompt');
	await withHardTimeout(uploadLoadImageRefsForPrompt(prompt, runner, resolveImageRef), 35_000, 'uploadLoadImageRefsForPrompt');
	// eslint-disable-next-line no-console
	console.warn('[runStageWorkflow] ✅ after uploadLoadImageRefsForPrompt');
	// 诊断：遍历所有 CLIPTextEncode 节点，打印注入后的 text 值，确认用户输入是否生效
	const clipNodes = Object.entries(prompt as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>)
		.filter(([, n]) => n.class_type === 'CLIPTextEncode')
		.map(([id, n]) => `${id}:${JSON.stringify(n.inputs?.text)}`);
	// eslint-disable-next-line no-console
	console.warn('[runStageWorkflow] injected CLIPTextEncode=' + clipNodes.join(' | ') + ' from values.prompt=' + JSON.stringify(values.prompt ?? values.main_prompt));
	// 诊断：打印 KSampler / KSamplerAdvanced 的真实种子与 batch 维度，定位「图像混乱」
	// （动画模板 batch_size=N 作为时间轴，seed 必须是单一固定值才能驱动连贯帧；
	// 若 seed 缺失/每帧派生，帧会发散成杂乱图）。
	for (const [id, node] of Object.entries(prompt as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>)) {
		if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
			const ins = node.inputs ?? {};
			// eslint-disable-next-line no-console
			console.warn(
				`[runStageWorkflow] KSampler ${id} class=${node.class_type} ` +
				`seed=${JSON.stringify(ins.seed ?? ins.noise_seed)} batch_size=${JSON.stringify(ins.batch_size)} ` +
				`sub_batch_size=${JSON.stringify(ins.sub_batch_size)} steps=${JSON.stringify(ins.steps)} ` +
				`sampler=${JSON.stringify(ins.sampler_name)}`,
			);
		}
	}
	// ★ 诊断：动画表情模板的多帧/时间轴关键参数。彩色噪声常因这里不一致：
	//   - EmptyLatentImage.batch_size 与 DecodeRGBA.sub_batch_size 必须相等
	//     （否则 LayeredDiffusionDecodeRGBA 按错误分批数解码 → 越界读 → 彩色噪声）
	//   - SaveAnimatedWEBP.fps 实际值（fps 越大产物越短，越像噪声）
	//   - ADE_AnimateDiffLoaderGen1.beta_schedule 必须是 SDXL 专用
	for (const [id, node] of Object.entries(prompt as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>)) {
		const ins = (node.inputs ?? {}) as Record<string, unknown>;
		const ct = node.class_type;
		if (ct === 'EmptyLatentImage' || ct === 'LayeredDiffusionDecodeRGBA' || ct === 'SaveAnimatedWEBP' || ct === 'ADE_AnimateDiffLoaderGen1') {
			// eslint-disable-next-line no-console
			console.warn(`[runStageWorkflow] ${ct} ${id} inputs=${JSON.stringify({
				...(ct === 'EmptyLatentImage' ? { batch_size: ins.batch_size } : {}),
				...(ct === 'LayeredDiffusionDecodeRGBA' ? { sub_batch_size: ins.sub_batch_size, sd_version: ins.sd_version } : {}),
				...(ct === 'SaveAnimatedWEBP' ? { fps: ins.fps, lossless: ins.lossless } : {}),
				...(ct === 'ADE_AnimateDiffLoaderGen1' ? { model_name: ins.model_name, beta_schedule: ins.beta_schedule } : {}),
			})}`);
		}
	}
	// 诊断：打印后端/内置 cfg.inputs bindings 全貌，确认 prompt 绑定是否命中
	// eslint-disable-next-line no-console
	console.warn('[runStageWorkflow] cfg.inputs=' + JSON.stringify(cfg.inputs), 'api_json nodeIds=' + Object.keys(cfg.api_json ?? {}).join(','));
	// ComfyTV 自定义节点（ImageStage/VideoStage/...）的 inputs 列表里大量"运行期由后端解析"字段
	//（如 selected_index/force_run_token/project_id/parent_output_id 等）在 ComfyUI 端声明为
	// required，但前端无对应控件——ComfyUI /prompt validation 对**键完全缺失**才返回
	// `Required input is missing`（execution.py:850-861 `if x not in inputs`），空字符串则不会触发。
	// 我们做两层兜底：
	//   1) 已存在的**非 binding** string inputs → 强制空串（兜底如 selected_index 等运行期字段）；
	//   2) 已知的运行期必需键白名单（按字段名推断类型）→ 在 inputs 里补 key+占位值。
	// 注意：cfg.inputs 里有绑定（binding）的字段（prompt/seed/upstream_* 等）已被
	// injectWorkflowValues 注入实际值，绝不能在这里被清空。
	const boundKeys = new Map<string, Set<string>>();
	for (const [nid, nodeBindings] of Object.entries(cfg.inputs ?? {})) {
		if (nodeBindings && typeof nodeBindings === 'object') {
			boundKeys.set(nid, new Set(Object.keys(nodeBindings)));
		}
	}
	for (const nodeId of Object.keys(prompt)) {
		const node = prompt[nodeId];
		if (!node || typeof node !== 'object') { continue; }
		const inputs = (node as { inputs?: Record<string, unknown> }).inputs;
		if (!inputs || typeof inputs !== 'object') { continue; }
		const bound = boundKeys.get(nodeId);
		// 仅清空「运行期由 ComfyTV 后端解析」的占位字符串字段（节点级白名单）。
		// ComfyUI 标准节点（KSampler/CheckpointLoaderSimple/CLIPTextEncode/...）的
		// string inputs 是真实值（如 sampler_name="euler"、ckpt_name="…safetensors"），
		// 必须保留——之前无差别清空导致 value_not_in_list。
		for (const k of Object.keys(inputs)) {
			if (bound?.has(k)) { continue; }
			if (typeof inputs[k] === 'string' && RUNTIME_PLACEHOLDER_KEYS.has(k)) {
				inputs[k] = '';
			}
		}
		// (2) 补 key：ComfyTV 节点已知 required 但前端未注入的运行时字段，按字段名推断占位类型。
		for (const [k, v] of Object.entries(RUNTIME_REQUIRED_INPUTS)) {
			if (!(k in inputs)) { inputs[k] = v; }
		}
	}
	// ★ 引用完整性校验（修 HTTP 400 KeyError 难懂错误）：api_json 若引用不存在的
	// 节点（导出脚本跳过未安装插件的自定义节点导致），在 POST /prompt 前就失败，
	// 报可读错误并让调用方降级，而不是让 ComfyUI 抛「Exception when validating node: '5'」。
	const missingRefs = findMissingNodeRefs(prompt);
	if (missingRefs.length > 0) {
		throw new StageWorkflowUnavailableError(
			`workflow「${label ?? wfKind}」的 api_json 残缺：节点 ${missingRefs.join(', ')} 被引用但不存在（导出时依赖的自定义插件未安装，节点被跳过）。请安装对应插件后重新导出，或改用其它 stage。`,
		);
	}
	const started = Date.now();
	// ★ 调用方后处理钩子（如 fallback 模式下根据上游参考图切换 img2img/text2img）
	options.promptPostProcess?.(prompt);
	// eslint-disable-next-line no-console
	console.warn(`[runStageWorkflow] invoking runner.invoke label="${label ?? wfKind}" kind=${wfKind} prompt keys=` + Object.keys(prompt).join(','));
	const run = await withHardTimeout(runner.invoke({
		prompt,
		onProgress: (p) => {
			// eslint-disable-next-line no-console
			console.warn('[runStageWorkflow] onProgress value=' + p.value);
			onProgress?.({ progress: p.value });
		},
		signal,
	}), 600_000, 'runner.invoke');
	// eslint-disable-next-line no-console
	console.warn('[runStageWorkflow] invoke done status=' + run.status + ' outputs=' + Object.keys(run.outputs ?? {}).join(','));
	const durationMs = run.durationMs ?? Date.now() - started;
	if (run.status !== 'success') {
		return {
			promptId: run.promptId,
			status: run.status,
			error: run.error ?? (run.status === 'canceled' ? '已取消' : 'workflow 执行失败'),
			durationMs,
			entries: [],
		};
	}
	// The result node's /history output is already slot-layer (e.g. { images: [...] }).
	const resultNode = cfg.result?.node;
	// 诊断：打印 /history 返回的全部节点 key 和 resultNode，确认输出提取是否正确
	// eslint-disable-next-line no-console
	console.warn('[runStageWorkflow] outputs keys=', Object.keys(run.outputs ?? {}), 'resultNode=', resultNode, 'nodeId=', nodeId);
	const slotOutputs = extractResultOutputs(run.outputs ?? {}, resultNode);
	// 诊断：打印提取结果
	// eslint-disable-next-line no-console
	console.warn('[runStageWorkflow] slotOutputs=', slotOutputs ? Object.keys(slotOutputs) : 'null/undefined');
	const entries: MediaSnapshotEntry[] = slotOutputs
		? comfyOutputsToSnapshots(runner.baseUrl, slotOutputs, snapshotKey)
		: [];
	// 物化 ComfyUI /view 引用为自包含 data: URL，app 重启后仍可显示。
	const persisted = await materializeComfyImageRefs(entries, runner.baseUrl, createComfyFetch(runner.baseUrl));
	// 诊断：打印生成的 snapshot entries（含 port/动画标识），定位「混乱图」来自哪个槽
	// eslint-disable-next-line no-console
	console.warn('[runStageWorkflow] entries count=', persisted.length, 'firstKey=', persisted[0]?.key ?? 'none');
	for (const e of persisted) {
		const ref = typeof e.media?.ref === 'string' ? e.media.ref : '';
		const isAnim = /anim/i.test(ref) || /\.webp/i.test(ref);
		// eslint-disable-next-line no-console
		console.warn(
			`[runStageWorkflow] entry key=${e.key} port=${e.port} index=${e.index ?? '?'} kind=${e.media?.kind} ` +
			`ref=${ref.length > 90 ? ref.slice(0, 90) + '…' : ref} animated=${isAnim}`,
		);
	}
	// ★ 诊断（用户报告「图像错乱」后加入）：解码产物 base64 拿第一帧像素摘要，
	//   区分「产物空（opaque_pct≈0）」vs「花屏（base64_len 异常小或大 + 极端均值）」vs「正常」。
	//   仅 webview 环境跑（Node 单测跳过，避免 Image/document undefined）。
	if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
		void (async () => {
			for (const e of persisted) {
				const ref = typeof e.media?.ref === 'string' ? e.media.ref : '';
				if (!ref.startsWith('data:image/')) { continue; }
				try {
					const img = new Image();
					await new Promise<void>((resolve, reject) => {
						img.onload = () => resolve();
						img.onerror = () => reject(new Error('load failed'));
						img.src = ref;
					});
					const w = img.naturalWidth;
					const h = img.naturalHeight;
					if (w === 0 || h === 0) {
						// eslint-disable-next-line no-console
						console.warn(`[runStageWorkflow] DIAGNOSE ${e.key}: empty (0x0) base64_len=${ref.length}`);
						continue;
					}
					const canvas = document.createElement('canvas');
					canvas.width = w;
					canvas.height = h;
					const ctx = canvas.getContext('2d');
					if (!ctx) { continue; }
					ctx.drawImage(img, 0, 0);
					const data = ctx.getImageData(0, 0, w, h).data;
					const total = w * h;
					let opaque = 0, sumR = 0, sumG = 0, sumB = 0;
					for (let i = 0; i < data.length; i += 4) {
						const a = data[i + 3];
						if (a > 16) {
							opaque++;
							sumR += data[i]; sumG += data[i + 1]; sumB += data[i + 2];
						}
					}
					const opaquePct = (opaque / total * 100).toFixed(1);
					const meanR = opaque > 0 ? (sumR / opaque).toFixed(1) : 'n/a';
					const meanG = opaque > 0 ? (sumG / opaque).toFixed(1) : 'n/a';
					const meanB = opaque > 0 ? (sumB / opaque).toFixed(1) : 'n/a';
					// eslint-disable-next-line no-console
					console.warn(`[runStageWorkflow] DIAGNOSE ${e.key}: ${w}x${h} base64_len=${ref.length} opaque_pct=${opaquePct}% meanRGB=(${meanR},${meanG},${meanB})`);
				} catch (err) {
					// eslint-disable-next-line no-console
					console.warn(`[runStageWorkflow] DIAGNOSE ${e.key} failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		})();
	}
	for (const e of persisted) { store.put(e); }
	return { promptId: run.promptId, status: 'success', durationMs, entries };
}
