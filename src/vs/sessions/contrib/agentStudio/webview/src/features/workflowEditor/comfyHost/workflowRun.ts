/*---------------------------------------------------------------------------------------------
 *  workflowRun — run a whole workflow graph through the Comfy runners (P0).
 *
 *  Executes every executable node in topological order (upstream first) so
 *  media outputs land in the shared snapshot store before their downstream
 *  consumers run. Execution stops on the first failure (the failing card shows
 *  an error banner; the caller surfaces the reason in the toolbar).
 *
 *  Pure helper `isComfyExecutableSpec`; the async `runGraphExecution` performs
 *  IO only through injected runner / snapshot store / card store — testable
 *  with fakes.
 *--------------------------------------------------------------------------------------------*/

import type { IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { CardStateStore } from './cardState.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import { runSingleNode, comfyOutputsToFxSnapshots } from './nodeExecutor.js';
import { runStageWorkflow, StageWorkflowUnavailableError, collectUpstreamRefs, applyAssetRefOverrides, type StageWorkflowRunOptions } from './stageWorkflowExecutor.js';
import { styleTemplateOf } from './builtinWorkflows/emojiWorkflows.js';
import { buildEmojiModelPrompt, parseComfyModelValue } from './emojiModelAdapt.js';

/** 通用负向词（checkpoint 系 KSampler negative；qwen/flux 组装链无 negative 输入，忽略）。 */
const EMOJI_NEGATIVE_PROMPT = 'text, watermark, blurry, low quality, deformed, ugly, duplicate, morbid, mutilated, out of frame, extra fingers, mutated hands, poorly drawn hands, poorly drawn face, mutation, deformed, bad anatomy, bad proportions, extra limbs, cloned face, disfigured, gross proportions, malformed limbs, missing arms, missing legs, fused fingers, too many fingers, long neck';
import { getPluginNodeRunner } from './pluginLoader.js';
import type { MediaSnapshotEntry, MediaKind, MediaRef } from './mediaSnapshot.js';
import { mediaGet, resolveAssetUrl } from '../mediaAssets.js';
import { loadCanvasImageWithProxy } from '../canvasImageLoad.js';
import { WEIXIN_EXPORT_TARGETS } from './registry.js';
import { isVideoToGifNode, EMOJI_GIF_PARAMS } from './videoToGif.js';
import { isRemoveBgNode } from './removeBg.js';
import { runRemoveBgNode } from './removeBgExecutor.js';
import { runVideoToGifNode, convertVideoToGif, convertVideoToGridTransparentGifs, blobToDataUrl, dataUrlToBlob } from './videoToGifExecutor.js';
import { parseSize, findUpstreamImageRef } from './imageGenBackend.js';
import { isComfyViewRef, resolveLoadImageImageRef, type BridgeFetchLike } from './imageGenToComfyBridge.js';
import { buildExecutionPlan, buildParallelExecutionPlan, computeExecutionOrder, computeInactiveNodes, resolveStartScope, collectDownstreamClosure, type ExecutionNodeLike, type ExecutionEdgeLike } from './executionGraph.js';
import type { SubflowDefinition } from './subflow.js';
import { resolveNodeMentions, createStoreLookup } from './nodeMentions.js';
import { flattenSubflows } from './subflow.js';
import { isAnimatedWebpRef } from './emojiTextOverlay.js';
import { sendRequest } from '../../../bridge/messageClient.js';

/**
 * ★ 外网 ref 的 CSP 兜底 fetch（2026-09-03）。
 *
 * webview 的 CSP `connect-src` 只放行 `data: blob: http(s)://127.0.0.1|localhost`——
 * provider 返回的**外网资源**（如 MiniMax 视频落在腾讯 COS 的签名 URL）直接 fetch
 * 必被拦：`Connecting to 'https://…' violates CSP directive "connect-src"` →
 * `Failed to fetch`（日志实锤：AnimatedEmoji 整条链路因此报废）。
 *
 * 策略：非 localhost 的 http(s) 先走原 fetchImpl（有 CORS 头的源仍直连，省一跳
 * IPC）；失败（CSP 拦 / 无 CORS / 网络抖动）→ 回退 host 代理 `net.fetchAsDataUrl`
 * （ext host 的 node fetch 不受 webview CSP 限制）转 dataURL 再构 Response。
 * localhost / data: 一律原路（ComfyUI 路由与本地解码不受影响）。
 *
 * 注意：代理回退路径不透传 AbortSignal（host 拉取不可中断）——取消语义由上层
 * raceAbort 兜底（外层 RPC 已 abort 后，本兜底结果会被丢弃）。
 */
import { runEmojiStageGrid } from './emojiExecutor.js';
// ★ P0-2 清理（2026-09-11）：原先从 providerExecutors 导入的
//   runProviderPickerNode / runProviderImage / runProviderVideo / runProviderModel3D /
//   runProviderText / runProviderAudio / runMultiPanelStoryboardNode **在本文件内已无使用**
//   （分发链硬编码分支全部收编为 nodes/ 声明式定义；对外仍由下方 barrel 的
//   `export { … } from './providerExecutors.js'` 提供，消费方 import 不受影响）。
import {
	runWeixinStickerExport,
} from './weixinStickerExport.js';
import {
	runAgentNodeExecutor,
	runSkillNodeExecutor,
	runToolNodeExecutor,
	runAskUserNodeExecutor,
	runPromptNodeExecutor,
	runGateNodeExecutor,
	runMergeNodeExecutor,
	runEndNodeExecutor,
	runLoopNodeExecutor,
} from './graphNodeExecutors.js';
import {
	splitStickerSheet,
	composePostProcess,
	EMOJI_SHEET_MARGIN_RATIO,
} from './emojiSheetUtils.js';
import {
	composeImageGridOnChroma,
} from './chromaCompose.js';
import {
	runAnimatedEmoji,
} from './animatedEmojiExecutor.js';
import {
	withRemoteProxyFetch,
	localizeImageRef,
	ComfyTVSpecMeta,
	RunNode,
	isComfyExecutableSpec,
	isExecutableSpec,
	isAgentNodeType,
	isPromptNodeType,
	isGateNodeType,
	isStartNodeType,
	isMergeNodeType,
	isLoopNodeType,
	isTaskNodeType,
	isEndNodeType,
	isSkillNodeType,
	isToolNodeType,
	isAskUserNodeType,
	collectStartArgs,
	stringifyResolvedValue,
	findUnresolvedPlaceholders,
	resolveTemplateVars,
	resolvePromptVariables,
	makeNamedWithVariables,
	PROVIDER_PICKER_PREFIX,
	parseProviderPickerConfig,
	collectUpstreamProviderConfig,
	collectOrchestrationValues,
	GraphRunOptions,
	GraphRunResult,
	RunProgress,
	AgentNodePayload,
	AgentNodeRunResult,
	AgentNodeSendFn,
	AskUserPayload,
	AskUserSendFn,
	NodeExecutionInput,
	isLoadImageNode,
	resolveLoadImageInputForNode,
	defaultResolveLoadImageRef,
	ImageGenSendFn,
	raceAbort,
	VideoGenSendFn,
	Model3DGenSendFn,
	TextGenSendFn,
	AudioGenSendFn,
	ImageGenProviderLike,
	resolveFirstImageGenDefaults,
	resolvePreferredImageGenDefaults,
	collectUpstreamValues,
	isPickerNode,
	isLoaderNode,
	collectUpstreamCandidates,
	resolveMediaAssetUrl,
	inferPickerKind,
	runPickerNode,
	runLoaderNode,
	resolveUpstreamSnapshotText,
	mapSnapshotKeys,
	makeFlowEdgeClassifier,
	EmojiCellState,
	parseEmojiCells,
	clampInt,
	truncateForLog,
	collectUpstreamTexts,
	stripMarkdownCodeFence,
	extractJsonArray,
	parseEmojiCellArray,
	splitEmojiPrompts,
} from './workflowRunShared.js';
import { getNodeDefinition } from './nodeDefinition.js';
// ★ 节点定义汇聚（2026-09-07 框架）：副作用注册——definition 查表由此填充，
//   必须先于 runNodeOrStage 首次调用执行（模块求值序保证）。
import './nodes/index.js';

// ── 模块 barrel（2026-09-07 拆分）：对外符号保持原样，消费方 import 不变 ──
export type { ComfyTVSpecMeta, RunNode, GraphRunOptions, GraphRunResult, RunProgress, AgentNodePayload, AgentNodeRunResult, AgentNodeSendFn, AskUserPayload, AskUserSendFn, NodeExecutionInput, ImageGenSendFn, VideoGenSendFn, Model3DGenSendFn, TextGenSendFn, AudioGenSendFn, ImageGenProviderLike, EmojiCellState } from './workflowRunShared.js';
export {
	isComfyExecutableSpec, isExecutableSpec, isAgentNodeType, isPromptNodeType, isGateNodeType,
	isStartNodeType, isMergeNodeType, isLoopNodeType, isTaskNodeType, isEndNodeType, isSkillNodeType,
	isToolNodeType, isAskUserNodeType, collectStartArgs, stringifyResolvedValue, findUnresolvedPlaceholders,
	resolveTemplateVars, resolvePromptVariables, makeNamedWithVariables, isLLMImageNode, isProviderPickerNode,
	PROVIDER_PICKER_PREFIX, parseProviderPickerConfig, collectUpstreamProviderConfig, collectOrchestrationValues,
	makeFlowEdgeClassifier,
	raceAbort, isLoadImageNode, resolveLoadImageInputForNode, defaultResolveLoadImageRef,
	resolveFirstImageGenDefaults, resolvePreferredImageGenDefaults, collectUpstreamValues,
	isPickerNode, isLoaderNode, collectUpstreamCandidates, resolveMediaAssetUrl, inferPickerKind,
	parsePickerIndexList, parsePickerRefList, publishPickerSelection,
	withRemoteProxyFetch, localizeImageRef, resolveUpstreamSnapshotText,
	collectUpstreamTexts, stripMarkdownCodeFence, extractJsonArray, parseEmojiCellArray, splitEmojiPrompts,
	parseEmojiCells, clampInt, truncateForLog,
} from './workflowRunShared.js';
export { runProviderPickerNode, runProviderImage, runProviderVideo, runProviderModel3D, runProviderText, runProviderAudio } from './providerExecutors.js';
export { runWeixinStickerExport } from './weixinStickerExport.js';
export type { EmojiSheetBackground, SplitSheetCell, SheetCellCrop } from './emojiSheetUtils.js';
export { resolveSheetBackground, resolveEmojiSheetSize, EMOJI_SHEET_MARGIN_RATIO, buildEmojiSheetPrompt, parseSheetCellCrops, defaultSheetCellCrops, splitStickerSheet } from './emojiSheetUtils.js';
export { composeImageGridOnChroma } from './chromaCompose.js';
export { runAnimatedEmoji } from './animatedEmojiExecutor.js';

// ── 调度主体（runNodeOrStage / runGraphExecution）────────────────────────
export async function runNodeOrStage(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, getSpec, upstreams, store, onProgress, signal } = input;
	let values = input.values;
	// ★ 节点定义查表（2026-09-07 框架）：defineNode 注册的节点走声明式分发——
	//   新增节点只需 comfyHost/nodes/ 下一个 definition 文件 + index 一行 import，
	//   不再改本分发链。未命中走下方既有硬编码分支（存量节点渐进迁移）。
	const nodeDefinition = getNodeDefinition(type);
	if (nodeDefinition) { return nodeDefinition.run(input); }
	// ★ P0-2 迁移（2026-09-11）：原 `isProviderPickerNode` 硬编码分支已删除 ——
	//   `Saros.ProviderPicker` 由 nodes/providerPickerNode.ts 声明式收编，上方查表即命中。
	// ★ P0-2 迁移（2026-09-11）：原 `isLLMImageNode` 硬编码分支已删除 —— 它覆盖的
	//   **全部 7 个** provider 类节点（`kind='llm'` 或 `schema`+`backendKind='provider'`：
	//   ModelImageGen / ModelVideoGen / Model3DGen / TextGen / AudioGen /
	//   WeixinStickerCover / AnimatedEmoji）均已由 nodes/ 下定义收编，上方查表即命中。
	//   该分支原为「视频/3D/文本/音频必须先于 isLLMImageNode 判定」的补偿逻辑，
	//   收编后已无意义。
	//   护栏：workflowNodeDefinitions.test.ts「provider 类节点必须有声明式定义」——
	//   新增 provider 节点若漏定义会**测试失败**，而不是静默掉到下方 runSingleNode
	//   （拿 ComfyUI runner 跑纯 RPC 节点 → 崩 / node-not-found）。
	// ★ v41 批次 5（2026-09-09）：instant/relight/poster/layerEditor/storyboardEditor/
	//   material/scene3d/picker/loader 共 15 个本地 stage 已由 nodes/localStageNodes.ts
	//   声明式收编（分发首位查表命中即执行），硬编码分支删除。
	//   StatEmojiStage / MultiPanelStoryboardStage 同（批次 4）。
	// ★ v42 批次 10：fx（builder+chain）与原生 LoadImage 已由 nodes/fxAndLoadImageNodes.ts 收编。
	// 通用 schema 分支（StatEmojiStage 已由 nodes/statEmojiNode.ts 声明式收编）。
	const spec = getSpec(type);
	if (spec?.kind === 'schema') {
		return runStageWorkflow({
			runner,
			nodeId,
			snapshotKey: input.snapshotKey,
			type,
			kind: spec.comfyTV?.kind ?? type.replace(/^ComfyTV\./, '').replace(/Stage$/, '').toLowerCase(),
			workflowKind: spec.comfyTV?.workflowKind,
			workflowKinds: type === 'ComfyTV.ImageVariationsStage' ? ['multiview', 'sequence'] : undefined,
			values,
			upstreams,
			store,
			onProgress: (p) => onProgress?.({ progress: p.progress }),
			signal,
			resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
		}).catch(async (err: unknown): Promise<SingleNodeRunResult> => {
			if (err instanceof StageWorkflowUnavailableError) {
				// ComfyTV 扩展不可用（纯 ComfyUI / workflow 未准备）→ 按设计契约降级单节点执行。
				// StageWorkflowUnavailableError 的语义即 "→ degrade"，见 stageWorkflowExecutor.ts
				// 与 runStageWorkflow 的 JSDoc。单节点跑 ComfyTV 自定义节点可能报
				// required_input_missing / node not found，这是尽力而为的兜底路径。
				// 降级路径同样用 snapshotKey（快照归档键保持一致）。
				return await runSingleNode({ runner, nodeId, snapshotKey: input.snapshotKey, type, values, store, onProgress: (p) => onProgress?.({ value: p.value }), signal });
			}
			return { promptId: '', status: 'error', error: err instanceof Error ? err.message : String(err), entries: [] };
		});
	}
	// ★ v42 批次 10：LoadImage 已由 nodes/fxAndLoadImageNodes.ts 收编（bridging 一并迁入）。
	// P2: plugin nodes — run the plugin's onRun hook (if any) to transform the
	// values before the backend call. onRun gets upstream snapshot refs per port
	// and the plugin-local storage.
	const pluginRunner = getPluginNodeRunner(type);
	if (pluginRunner) {
		try {
			const upstream: Record<string, string[]> = {};
			for (const pid of upstreams ?? []) {
				const portRefs = store.byNode(pid).map(e => e.media.ref);
				upstream[pid] = portRefs;
			}
			const hookValues = await pluginRunner({
				values,
				upstream,
				storage: {
					get: (k) => localStorage.getItem(`plugin:${type}:${k}`) ?? undefined,
					set: (k, v) => localStorage.setItem(`plugin:${type}:${k}`, v),
				},
			});
			if (hookValues && typeof hookValues === 'object') {
				values = { ...values, ...hookValues };
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { promptId: '', status: 'error', error: `插件节点执行失败：${msg}`, entries: [] };
		}
	}
	return runSingleNode({ runner, nodeId, snapshotKey: input.snapshotKey, type, values, store, onProgress: (p) => onProgress?.({ value: p.value }), signal });
}

/**
 * 失败收尾：把 rootIds 的**可达下游**标 skipped（独立并行分支不受影响）。
 *
 * ★ 对齐 host 引擎的 `_cascadeSkipDownstream`（browser/workflowExecutionService.ts）：
 *   两个引擎对同一个工作流的失败收尾语义必须一致。此前 webview 侧失败后直接 return，
 *   下游卡片停留在 idle —— 用户无法区分「没跑到」与「被上游失败连累」。
 *   **仅改卡片状态与 skippedIds，不改执行语义**（调用方随后仍然终止本次 run）。
 */
function markDownstreamSkipped(
	cardState: CardStateStore,
	edges: ExecutionEdgeLike[],
	stepIds: readonly string[],
	result: GraphRunResult,
	rootIds: readonly string[],
): void {
	if (rootIds.length === 0) { return; }
	const closure = collectDownstreamClosure(rootIds, edges);
	const already = new Set<string>([...result.ran, ...result.skippedIds]);
	for (const id of stepIds) {
		if (!closure.has(id) || already.has(id)) { continue; }
		cardState.set(id, { runState: 'skipped', progress: 0 });
		result.skippedIds.push(id);
	}
}

/**
 * Execute the executable sub-graph upstream-first. Stops on the first failure
 * (its reachable downstream is marked skipped — independent branches keep their
 * own state, matching the host engine's cascade-skip semantics).
 * In 'parallel' mode independent steps run concurrently within each topological
 * layer (Comfy backend steps serialized; provider/local steps pooled).
 */
export async function runGraphExecution(options: GraphRunOptions): Promise<GraphRunResult> {
	const {
		nodes, edges, getSpec, resolveRunner, snapshotStore, cardState, nodeValues,
		onNodeStart, signal, sendImageGen, resolveImageGenDefaults, resolveLoadImageRef,
		mode = 'serial', parallelConcurrency = 4, taskId, fetchImpl, snapshotKeyOf,
	} = options;
	const result: GraphRunResult = {
		success: false, hasCycle: false, ran: [], skippedIds: [], outOfScopeIds: [], failed: null, results: {},
		taskId, mode,
	};

	// P2: flatten subflow nodes (data.subflow) into their internal sub-graphs
	// before planning — the composition is a design-time convenience; execution
	// runs the flattened graph.
	const flattened = flattenSubflows(nodes, edges);
	const runNodes = flattened.nodes;
	const runEdges = flattened.edges;

	if (mode === 'parallel') {
		return runGraphExecutionParallel({ ...options, nodes: runNodes, edges: runEdges }, result);
	}

	// W7: 从 Start 开始执行 —— 图含已编排的 Saros.Start 时只跑其作用域
	// （可达闭包 + 数据依赖补全）；无 Start / Start 未编排 → 全图（存量兼容）。
	const startScope = resolveStartScope(runNodes, runEdges);
	result.startScope = { startIds: startScope.startIds, degraded: startScope.degraded, scoped: startScope.scope !== null };
	// W7-flow：flowIn/flowOut 端口（type=FLOW）的边是纯控制流 —— 不进数据上游。
	const classifyEdge = makeFlowEdgeClassifier(runNodes, getSpec);
	const plan = buildExecutionPlan(runNodes, runEdges, type => isExecutableSpec(getSpec(type)) || isAgentNodeType(type) || isTaskNodeType(type) || isSkillNodeType(type) || isToolNodeType(type) || isPromptNodeType(type) || isGateNodeType(type) || isMergeNodeType(type) || isLoopNodeType(type) || isEndNodeType(type) || isAskUserNodeType(type), startScope.scope, classifyEdge);
	result.hasCycle = plan.hasCycle;
	if (plan.hasCycle) { return result; }
	// 作用域外的可执行节点：标 idle 并计入 outOfScopeIds（**不是** error——
	// 「没接到 Start」是编排状态而非失败；卡片保持中性，工具栏给出计数提示）。
	for (const id of plan.outOfScope) {
		cardState.set(id, { runState: 'idle', progress: 0 });
		result.outOfScopeIds.push(id);
	}
	// A ComfyUI runner is only required for schema/native nodes; a graph made
	// purely of provider (llm) nodes can run without a connected runner.
	const needsRunner = plan.steps.some(s => isComfyExecutableSpec(getSpec(s.type)));
	const runner = needsRunner ? resolveRunner() : undefined;
	if (needsRunner && !runner) {
		// P2 engine-ready gate: surface a clear per-node error instead of a
		// silent "nothing happened". Every backend step shows "未连接 ComfyUI
		// 引擎"; result.failed points at the first one.
		const backendSteps = plan.steps.filter(s => isComfyExecutableSpec(getSpec(s.type)));
		for (const s of backendSteps) {
			cardState.set(s.id, { runState: 'error', progress: 0, errorMsg: '未连接 ComfyUI 引擎：请先在 Runner 面板连接并测试 ComfyUI/ComfyTV' });
		}
		if (backendSteps[0]) {
			result.failed = { nodeId: backendSteps[0].id, error: '未连接 ComfyUI 引擎' };
		}
		return result;
	}

	// W2 端口感知路由状态：gate 节点 → 已判定分支。每步执行前用
	// computeInactiveNodes 重算激活表（拓扑序单遍传播，代价 O(V+E)，小图可忽略）。
	const branchOf = new Map<string, string>();
	const gateNodeIds = new Set(runNodes.filter(n => isGateNodeType(n.type ?? '')).map(n => n.id));
	// W1/W1b: Start 节点 args 输入契约（全图模板可用 {{args.*}}）；运行时覆盖 > 节点默认
	const startArgs = { ...collectStartArgs(runNodes), ...(options.startArgsOverride ?? {}) };
	// W4: 具名引用解析器（label → 归档键 → store 快照文本；重名取首个）
	const resolveNamed = (label: string): string | undefined => {
		const target = runNodes.find(x => {
			const l = (x.data as Record<string, unknown> | undefined)?.label;
			return (typeof l === 'string' && l ? l : x.type) === label;
		});
		if (!target) { return undefined; }
		return resolveUpstreamSnapshotText(snapshotStore, [snapshotKeyOf?.(target.id) ?? target.id]) || undefined;
	};

	for (const step of plan.steps) {
		if (signal?.aborted) { break; }
		// W2: 分支路由 —— 节点所有入边均未激活（gate 分支未命中 / 上游被 skip）→ 跳过
		if (computeInactiveNodes(runNodes, runEdges, branchOf, gateNodeIds).has(step.id)) {
			cardState.set(step.id, { runState: 'skipped', progress: 0 });
			result.skippedIds.push(step.id);
			continue;
		}
		onNodeStart?.(step);
		cardState.set(step.id, { runState: 'running', progress: 5 });
		// P2-tail: orchestration nodes are skipped, but their data flows into the
		// media node's values (e.g. Prompt 文本 → prompt). Editor values win.
		// ⚠ collectOrchestrationValues 按 **nodeId** 在 runNodes 里查节点，必须用
		//   原始 step.upstreams（不是归档键映射后的 uid）。
		const values = { ...collectOrchestrationValues(runNodes, step.upstreams), ...(nodeValues?.[step.id] ?? {}) };
		const progress = (p: { progress?: number; value?: number }) =>
			cardState.set(step.id, { runState: 'running', progress: p.progress ?? p.value ?? 50 });
		const r = await runNodeOrStage({
			runner: runner as IComfyRunner,
			nodeId: step.id,
			snapshotKey: snapshotKeyOf?.(step.id),
			type: step.type,
			getSpec,
			values,
			args: startArgs,
			resolveNamed,
			// executor 侧的 upstreams 只用于 `store.byNode(...)`（快照查询），
			// 因此这里传**归档键**；节点身份相关的消费方拿 `nodes` + step.id。
			upstreams: mapSnapshotKeys(step.upstreams, snapshotKeyOf),
			inbound: runEdges.filter(e => e.target === step.id).map(e => ({ source: snapshotKeyOf?.(e.source) ?? e.source, targetHandle: e.targetHandle, sourceHandle: e.sourceHandle })),
			nodes: runNodes,
			store: snapshotStore,
			onProgress: progress,
			signal,
			sendImageGen,
			runAgentNode: options.runAgentNode,
			askUser: options.askUser,
			resolveImageGenDefaults,
			resolveLoadImageRef,
		});
		if (r.status === 'success') {
			cardState.set(step.id, { runState: 'success', progress: 100, durationMs: r.durationMs });
			result.ran.push(step.id);
			result.results[step.id] = r;
			// W2: gate 执行成功 → 记录分支，后续步骤据此端口路由
			if (r.branch) { branchOf.set(step.id, r.branch); }
		} else {
			cardState.set(step.id, { runState: 'error', progress: 0, errorMsg: r.error ?? '执行失败' });
			result.failed = { nodeId: step.id, error: r.error ?? '执行失败' };
			// 下游显式标 skipped（对齐 host 引擎级联跳过语义），再终止本次 run。
			markDownstreamSkipped(cardState, runEdges, plan.steps.map(s => s.id), result, [step.id]);
			return result;
		}
	}
	result.success = true;
	return result;
}

/**
 * Parallel mode: group steps into independent layers (buildParallelExecutionPlan)
 * and run each layer as a barrier. Provider/local steps (llm, instant, editors,
 * pickers) share a concurrency pool; Comfy backend steps (schema/native) are
 * serialized because ComfyUI's queue is inherently serial — they run in their
 * own single-slot pool. A failure in a layer stops later layers (first failure
 * recorded), matching the serial stop-on-first-failure contract.
 */
async function runGraphExecutionParallel(options: GraphRunOptions, result: GraphRunResult): Promise<GraphRunResult> {
	const { nodes, edges, getSpec, resolveRunner, snapshotStore, cardState, nodeValues, onNodeStart, signal, sendImageGen, resolveImageGenDefaults, resolveLoadImageRef, parallelConcurrency = 4, fetchImpl, snapshotKeyOf, writeStepIds } = options;
	// W7: Start 入口作用域（parallel 版同款语义，见 runGraphExecution）
	const startScope = resolveStartScope(nodes, edges);
	result.startScope = { startIds: startScope.startIds, degraded: startScope.degraded, scoped: startScope.scope !== null };
	const plan = buildParallelExecutionPlan(nodes, edges, type => isExecutableSpec(getSpec(type)) || isAgentNodeType(type) || isTaskNodeType(type) || isSkillNodeType(type) || isToolNodeType(type) || isPromptNodeType(type) || isGateNodeType(type) || isMergeNodeType(type) || isLoopNodeType(type) || isEndNodeType(type) || isAskUserNodeType(type), startScope.scope, makeFlowEdgeClassifier(nodes, getSpec),
		// P0① 写者独占层：可写节点不与任何节点同层并发（未注入 writeStepIds → 不拆，行为不变）。
		writeStepIds ? (step => writeStepIds.has(step.id)) : undefined);
	// P0① 诊断：被单独串行化的写者（「为什么这一层慢」可解释）。
	if (plan.serializedWriters.length > 0) {
		// eslint-disable-next-line no-console
		console.warn(`[WorkflowRun] P0① 写者串行化 ${plan.serializedWriters.length} 个节点（同层写者互斥）：${plan.serializedWriters.join(', ')}`);
	}
	result.hasCycle = plan.hasCycle;
	if (plan.hasCycle) { return result; }
	for (const id of plan.outOfScope) {
		cardState.set(id, { runState: 'idle', progress: 0 });
		result.outOfScopeIds.push(id);
	}
	const needsRunner = plan.layers.some(l => l.some(s => isComfyExecutableSpec(getSpec(s.type))));
	const runner = needsRunner ? resolveRunner() : undefined;
	if (needsRunner && !runner) {
		// P2 engine-ready gate (parallel): same per-node error surfacing as serial.
		const backendSteps = plan.layers.flat().filter(s => isComfyExecutableSpec(getSpec(s.type)));
		for (const s of backendSteps) {
			cardState.set(s.id, { runState: 'error', progress: 0, errorMsg: '未连接 ComfyUI 引擎：请先在 Runner 面板连接并测试 ComfyUI/ComfyTV' });
		}
		if (backendSteps[0]) {
			result.failed = { nodeId: backendSteps[0].id, error: '未连接 ComfyUI 引擎' };
		}
		return result;
	}

	const isBackend = (step: { type: string }) => isComfyExecutableSpec(getSpec(step.type));

	// W2 端口感知路由（parallel 版）：gate 分支结果跨层传播；层内节点执行前
	// 重算激活表，未激活 → skipped（不占用并发池）。gate 与其分支下游天然
	// 落在不同层（barrier 不变量保证 gate 先完成），因此层内并发安全。
	const branchOf = new Map<string, string>();
	const gateNodeIds = new Set(nodes.filter(n => isGateNodeType(n.type ?? '')).map(n => n.id));
	// W1/W1b: Start args（parallel 版同样注入）；运行时覆盖 > 节点默认
	const startArgs = { ...collectStartArgs(nodes), ...(options.startArgsOverride ?? {}) };
	// W4: 具名引用解析器（parallel 版同款闭包）
	const resolveNamed = (label: string): string | undefined => {
		const target = nodes.find(x => {
			const l = (x.data as Record<string, unknown> | undefined)?.label;
			return (typeof l === 'string' && l ? l : x.type) === label;
		});
		if (!target) { return undefined; }
		return resolveUpstreamSnapshotText(snapshotStore, [snapshotKeyOf?.(target.id) ?? target.id]) || undefined;
	};

	const layerStats: GraphRunResult['layerStats'] = [];
	for (let li = 0; li < plan.layers.length; li++) {
		if (signal?.aborted) { break; }
		const layer = plan.layers[li];
		// W2: 先剔除本层未激活节点（gate 分支未命中 / 上游 skip 传导）
		const inactive = computeInactiveNodes(nodes, edges, branchOf, gateNodeIds);
		const activeLayer = layer.filter(s => !inactive.has(s.id));
		for (const s of layer.filter(x => inactive.has(x.id))) {
			cardState.set(s.id, { runState: 'skipped', progress: 0 });
			result.skippedIds.push(s.id);
		}
		const backend = activeLayer.filter(isBackend);
		const local = activeLayer.filter(s => !isBackend(s));
		let layerFailed = 0;
		let layerRan = 0;
		/** 本层失败节点（用于失败收尾时标下游 skipped）。 */
		const layerFailedIds: string[] = [];

		const runStep = async (step: { id: string; type: string; upstreams?: string[] }) => {
			if (signal?.aborted) { return; }
			onNodeStart?.(step);
			cardState.set(step.id, { runState: 'running', progress: 5 });
			const values = { ...collectOrchestrationValues(nodes, step.upstreams), ...(nodeValues?.[step.id] ?? {}) };
			const progress = (p: { progress?: number; value?: number }) =>
				cardState.set(step.id, { runState: 'running', progress: p.progress ?? p.value ?? 50 });
			const r = await runNodeOrStage({
				runner: runner as IComfyRunner,
				nodeId: step.id,
				snapshotKey: snapshotKeyOf?.(step.id),
				type: step.type,
				getSpec,
				values,
				args: startArgs,
				resolveNamed,
				upstreams: mapSnapshotKeys(step.upstreams, snapshotKeyOf),
				inbound: edges.filter(e => e.target === step.id).map(e => ({ source: snapshotKeyOf?.(e.source) ?? e.source, targetHandle: e.targetHandle })),
				nodes,
				fetchImpl,
				store: snapshotStore,
				onProgress: progress,
				signal,
				sendImageGen,
				runAgentNode: options.runAgentNode,
				askUser: options.askUser,
				resolveImageGenDefaults,
				resolveLoadImageRef,
			});
			if (r.status === 'success') {
				cardState.set(step.id, { runState: 'success', progress: 100, durationMs: r.durationMs });
				result.ran.push(step.id);
				result.results[step.id] = r;
				if (r.branch) { branchOf.set(step.id, r.branch); }
				layerRan++;
			} else {
				cardState.set(step.id, { runState: 'error', progress: 0, errorMsg: r.error ?? '执行失败' });
				if (!result.failed) {
					result.failed = { nodeId: step.id, error: r.error ?? '执行失败' };
				}
				layerFailedIds.push(step.id);
				layerFailed++;
			}
		};

		// Backend steps run in their own single-slot pool (serialized).
		const runBackendPool = runConcurrent(backend, 1, runStep);
		// Local/provider steps share the parallel pool.
		const runLocalPool = runConcurrent(local, parallelConcurrency, runStep);
		await Promise.all([runBackendPool, runLocalPool]);

		layerStats.push({ layer: li, total: layer.length, ran: layerRan, failed: layerFailed });
		result.layerStats = layerStats;

		// Stop at the first layer with a failure (barrier semantics).
		if (layerFailed > 0 || result.failed) {
			// 失败层之后的所有层都不再执行 → 把失败节点的可达下游标 skipped（同 serial 语义）。
			markDownstreamSkipped(cardState, edges, plan.layers.flat().map(s => s.id), result, layerFailedIds);
			break;
		}
	}

	if (!result.failed) { result.success = true; }
	return result;
}

/**
 * Run `items` with at most `limit` concurrent executions. Each item's fn is
 * called with the item. Rejects only if `fn` throws synchronously (runStep
 * never throws — failures are recorded in results).
 */
async function runConcurrent<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const workers = Math.min(limit, items.length);
	if (workers <= 0) { return; }
	const slot = async () => {
		while (cursor < items.length) {
			const i = cursor++;
			await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: workers }, () => slot()));
}

