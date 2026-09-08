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
import { isFxNode, isFxChainNode } from './fxChain.js';
import type { MediaSnapshotEntry, MediaKind, MediaRef } from './mediaSnapshot.js';
import { mediaGet, resolveAssetUrl } from '../mediaAssets.js';
import { loadCanvasImageWithProxy } from '../canvasImageLoad.js';
import { WEIXIN_EXPORT_TARGETS } from './registry.js';
import { isInstantNode } from './instantNodes.js';
import { runInstantNode } from './instantExecutor.js';
import { isVideoToGifNode, EMOJI_GIF_PARAMS } from './videoToGif.js';
import { isRemoveBgNode } from './removeBg.js';
import { runRemoveBgNode } from './removeBgExecutor.js';
import { runVideoToGifNode, convertVideoToGif, convertVideoToTransparentGif, blobToDataUrl, dataUrlToBlob } from './videoToGifExecutor.js';
import { isRelightNode } from './relightEditor.js';
import { runRelightNode } from './relightExecutor.js';
import { isPosterNode } from './posterEditor.js';
import { runPosterNode } from './posterExecutor.js';
import { isLayerEditorNode } from './layerEditor.js';
import { runLayerEditorNode } from './layerExecutor.js';
import { isStoryboardEditorNode } from './storyboardEditor.js';
import { runStoryboardEditorNode } from './storyboardExecutor.js';
import { isMultiPanelStoryboardNode, parsePanelsState, buildMultiPanelPrompt, isPanelsEmpty, splitStoryToPanels } from './multiPanelStoryboard.js';
import { isMaterialNode } from './materialEditor.js';
import { runMaterialNode } from './materialExecutor.js';
import { isScene3DNode } from './scene3dEditor.js';
import { runScene3DNode } from './scene3dExecutor.js';
import { parseSize, findUpstreamImageRef } from './imageGenBackend.js';
import { isComfyViewRef, resolveLoadImageImageRef, type BridgeFetchLike } from './imageGenToComfyBridge.js';
import { buildExecutionPlan, buildParallelExecutionPlan, computeExecutionOrder, computeInactiveNodes, type ExecutionNodeLike, type ExecutionEdgeLike } from './executionGraph.js';
import type { SubflowDefinition } from './subflow.js';
import { resolveNodeMentions, createStoreLookup } from './nodeMentions.js';
import { flattenSubflows } from './subflow.js';
import { isAnimatedWebpRef } from './emojiTextOverlay.js';
import { splitStickerSheet, EMOJI_SHEET_MARGIN_RATIO } from './emojiSheetUtils.js';
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
	isLLMImageNode,
	isProviderPickerNode,
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
	mapSnapshotKeys,
	resolveUpstreamSnapshotText,
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
import { compositeImageOnChroma, ANIMATED_EMOJI_GREEN_SUFFIX } from './chromaCompose.js';
import { ASSET_REFS_PROP } from './assetRefs.js';

// ★ 转动态表情包执行器（runAnimatedEmoji）。

export async function runAnimatedEmoji(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store, onProgress } = input;
	const snapKey = input.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const send = input.sendVideoGen;
	if (!send) {
		return { ...empty, error: 'Provider 视频生成通道未注入（videogen.generate）' };
	}
	// provider/model 解析（与 runProviderVideo 同序：① 显式 widget → ② 上游 Picker）
	let providerId = typeof values.videoProvider === 'string' && values.videoProvider
		? values.videoProvider
		: typeof values.providerId === 'string' ? values.providerId : '';
	let modelId = typeof values.videoModel === 'string' && values.videoModel
		? values.videoModel
		: typeof values.modelId === 'string' ? values.modelId : '';
	const picker = providerId && modelId
		? undefined
		: collectUpstreamProviderConfig(input.store, input.upstreams);
	if (picker) {
		providerId = providerId || picker.providerId;
		modelId = modelId || picker.modelId;
	}
	if (!providerId || !modelId) {
		return { ...empty, error: '请先在节点设置中选择 Provider 和视频生成模型' };
	}
	// 参考图：① 显式 imageInput（单图，优先）→ ② 上游 IMAGE 快照。上游传入
	// **多张**图时自动拼贴成 m×n 图集（行列与切分 grid_rows×grid_cols 对齐）：
	// 拼图集 → 整图一次生成动图 → 逐格拆分（convertVideoToGridTransparentGifs），
	// 每格对应一张输入贴纸的动图。参考图应为透明背景 PNG（普通照片无 alpha 时
	// 绿底合成不改变外观 → 抠像会把背景整块抠掉，编辑器文案已提示该边界）。
	// ★ chroma_enable（2026-09-03）：**非透明背景图像**（照片/带底插画）不适用
	//   绿幕+抠像（无绿幕可抠，抠像会把背景整块抠掉）→ 关闭后：不合成绿底、
	//   抠像容差清零（全保留），产出**保留原背景**的逐格 GIF。
	// ★ forceProxy：provider 视频产物落在 COS 签名 URL（无 CORS 头，CSP
	//   connect-src 必拦）→ 直连 100% 失败且每次刷 CSP 报错，直接走 host 代理。
	const fetchImpl = withRemoteProxyFetch(input.fetchImpl ?? globalThis.fetch, { forceProxy: true });
	const chromaEnabled = !(values.chroma_enable === false || values.chroma_enable === 'false');
	// ★ 生成渠道（2026-09-03）：comfyui（本地视频工作流 I2V）/ provider（RPC）
	const backend = values.backend === 'comfyui' ? 'comfyui' : 'provider';
	const chromaColor = typeof values.chroma_color === 'string' && values.chroma_color ? values.chroma_color : '#00FF00';
	// ★ 逐格模式（2026-09-07）：grid_rows/grid_cols/grid_margin 与整图切格路线
	//   一并移除——每格独立生成视频，无需网格几何参数。

	const upstreamImageRefs: string[] = [];
	// 上游「图集」探测：静态表情包的 image 口输出带 meta.sheet/rows/cols 的整版
	// 图集（composeImageGridOnChroma 写入）——单图输入时自动按其行列拆分，
	// 消除「手动把 grid_rows×grid_cols 对齐图集」的易错步骤。
	//
	// ★ 端口精确路由（2026-09-02）：静态表情包节点 byNode 里**同时**存在
	//   独立表情格（images 口）与图集 entry（image 口，meta.sheet='1'）——
	//   快照不按 port 过滤，二者混在同一列表。按 inbound 边的 **sourceHandle**
	//   （源输出口名）决定消费语义：
	//     - 连 'image' 口 → **仅引用图集整图**（单图路径，meta 行列自动拆分）
	//     - 连 'images' 口 / 无 handle（存量图）→ 独立格（多图拼贴），sheet 兜底
	let upstreamSheetGrid: { rows: number; cols: number; margin: number } | undefined;
	let upstreamSheetRef = '';
	// ★ 逐格模式的每格动作描述（2026-09-07）：上游单格快照的 meta.cellPrompt
	//   （静态表情包生成时随格归档）→ 逐格视频生成的 prompt 组装输入。
	const cellPromptByRef = new Map<string, string>();
	{
		// upstream uid → 该连线源端口（同 uid 多条边时取第一条有 handle 的）
		const handleByUid = new Map<string, string>();
		for (const b of input.inbound ?? []) {
			if (b.source && b.sourceHandle && !handleByUid.has(b.source)) { handleByUid.set(b.source, b.sourceHandle); }
		}
		const cellRefs: string[] = [];
		let anyCellSource = false;
		if (input.store && input.upstreams?.length) {
			for (const uid of input.upstreams) {
				const portWanted = handleByUid.get(uid); // 'image' | 'images' | undefined（存量图/非表情节点）
				// ★ latestRoundOf：只取「最新一轮」格子——快照按次**追加**不清理，
				//   byNode 会把 EmojiStage 历史轮全混进来（9 旧 + 16 新 → 计数膨胀，
				//   拼贴图集也把废格拼进去）。
				const round = input.store.latestRoundOf(uid);
				if (round.sheet && !upstreamSheetRef) {
					// 第一个有 sheet 的上游：图集取**最新**（旧逻辑取 byNode 第一个 = 最旧轮）
					upstreamSheetRef = round.sheet.entry.media.ref;
					if (round.sheet.rows >= 1 && round.sheet.cols >= 1) {
						upstreamSheetGrid = { rows: round.sheet.rows, cols: round.sheet.cols, margin: round.sheet.margin };
					}
				}
				for (const e of round.cells) {
					// 连的是 image 口 → 该上游只消费图集（格跳过）
					if (portWanted === 'image') { continue; }
					if (!cellRefs.includes(e.media.ref)) {
						cellRefs.push(e.media.ref);
						const cp = e.media.meta?.cellPrompt;
						if (typeof cp === 'string' && cp.trim()) { cellPromptByRef.set(e.media.ref, cp.trim()); }
					}
				}
				// 连的是 image 口 → 该上游只消费图集
				if (portWanted === 'image' && round.sheet) { upstreamImageRefs.push(round.sheet.entry.media.ref); }
				if (portWanted === 'images' || portWanted === undefined) { anyCellSource = true; }
			}
		}
		if (upstreamImageRefs.length === 0) {
			// 没有按口命中的（连 images 口但格尚未生成 / 非表情上游）→ 兜底：
			// 有独立格用独立格（多图拼贴），否则图集整图。
			if (cellRefs.length > 0) { upstreamImageRefs.push(...cellRefs); }
			else if (upstreamSheetRef) { upstreamImageRefs.push(upstreamSheetRef); }
			void anyCellSource;
		}
	}

	// ★ 逐格任务收集（2026-09-07 需求变更）：动态表情包**移除「图集统一生成后
	//   拆分」路线**——每个表情单格独立走图生视频（编辑器网格切分页签同步移除）。
	//   任务源：① 上游独立格（images 口，含每格 cellPrompt）② 上游 sheet 口整图
	//   → 按其行列本地切分成单格（EMOJI_SHEET_MARGIN_RATIO 内缩吸收边缘渗入）
	//   ③ 显式 imageInput / 单图 = 1 格。
	if (typeof values.imageInput === 'string' && values.imageInput) {
		upstreamImageRefs.splice(0, upstreamImageRefs.length, values.imageInput);
	}
	if (upstreamImageRefs.length === 0) {
		return { ...empty, error: '动态表情包制作需要上游参考图输入（请先连接并运行一个图像节点）。' };
	}
	// prompt：动作描述可选（图生视频以参考图为主体）——① 显式 widget ② 上游
	// TEXT 快照（texts 端口连线）。绿幕/网格约束后缀恒定追加（背景控制不依赖
	// 用户输入）。上游 TEXT 来自 resolveUpstreamSnapshotText（与 runProviderVideo 同源）。
	const widgetPrompt = typeof values.prompt === 'string' ? values.prompt.trim() : '';
	const rawPrompt = widgetPrompt || resolveUpstreamSnapshotText(store, input.upstreams).trim();

	// ★ 抠像关闭 → similarity/smoothness 归零（chromaKeyFrame 零像素被判透明 →
	//   产出**保留原背景**的逐格 GIF，管线复用）；绿幕约束后缀也不追加
	//   （否则视频模型仍会把背景画成绿幕）。
	const chromaSimilarity = chromaEnabled && Number.isFinite(Number(values.chroma_similarity)) ? Number(values.chroma_similarity) : 0;
	const chromaSmoothness = chromaEnabled && Number.isFinite(Number(values.chroma_smoothness)) ? Number(values.chroma_smoothness) : 0;
	const fps = Math.max(6, Math.min(15, Math.round(Number(values.fps) || 12)));
	const maxKb = Math.max(100, Math.min(2000, Math.round(Number(values.max_kb) || 500)));
	const durationS = Math.max(2, Math.min(5, Math.round(Number(values.duration_s) || 3)));
	// 后缀以 ', ' 开头——rawPrompt 为空时去掉前导逗号（避免「， solid pure…」）
	// ★ 网格约束后缀（ANIMATED_EMOJI_GRID_SUFFIX）随整图切格路线一并移除：
	//   逐格生成无需「格间不越界」约束。
	const prompt = rawPrompt
		? `${rawPrompt}${chromaEnabled ? ANIMATED_EMOJI_GREEN_SUFFIX : ''}`
		: (chromaEnabled ? ANIMATED_EMOJI_GREEN_SUFFIX.slice(2) : '');

	// ── 逐格任务表（两渠道共用）：上游独立格直用；上游 sheet 整图先本地切格。──
	type EmojiCellJob = { ref: string; cellIndex: number; cellPrompt?: string };
	let jobs: EmojiCellJob[] = [];
	{
		const sheetGridSnapshot = upstreamSheetGrid;
		const sheetAsOnly = upstreamImageRefs.length === 1 && sheetGridSnapshot
			&& (sheetGridSnapshot.rows > 1 || sheetGridSnapshot.cols > 1)
			&& upstreamSheetRef === upstreamImageRefs[0];
		if (sheetAsOnly && sheetGridSnapshot) {
			onProgress?.({ progress: 3 });
			const cellsSplit = await splitStickerSheet(
				upstreamImageRefs[0], sheetGridSnapshot.rows, sheetGridSnapshot.cols,
				{ marginRatio: EMOJI_SHEET_MARGIN_RATIO, cutoutBg: false }, fetchImpl,
			);
			jobs = cellsSplit.map((c, i) => ({ ref: c.dataUrl, cellIndex: i }));
		} else {
			jobs = upstreamImageRefs.map((ref, i) => {
				const cp = cellPromptByRef.get(ref);
				return { ref, cellIndex: i, ...(cp ? { cellPrompt: cp } : {}) };
			});
		}
	}
	if (jobs.length === 0) {
		return { ...empty, error: '没有可生成动态视频的表情格：请先在上游生成表情包（单格或图集）。' };
	}

	// ★ 每格动作覆盖（2026-09-07）：编辑器逐格填写的动作描述（cell_actions JSON
	//   数组按格序，TEXT widget 持久化在 node.properties）。优先级：
	//   手填动作 > 上游格自动描述（meta.cellPrompt）> 全局 prompt。
	{
		let manualActions: string[] = [];
		try {
			const arr = JSON.parse(typeof values.cell_actions === 'string' && values.cell_actions.trim() ? values.cell_actions : '[]') as unknown;
			if (Array.isArray(arr)) { manualActions = arr.map(x => (typeof x === 'string' ? x : '')); }
		} catch { /* 非法 JSON 忽略——回退上游格自动描述/全局 prompt */ }
		jobs = jobs.map((job, i) => {
			const manual = (manualActions[i] ?? '').trim();
			return manual ? { ...job, cellPrompt: manual } : job;
		});
	}

	try {
		// ★ chroma_enable=false → 单格不做绿底合成（保留原背景直喂视频模型）。
		onProgress?.({ progress: 5 });
		// eslint-disable-next-line no-console
		console.warn(`[AnimatedEmoji] run start nodeId=${nodeId} backend=${backend}${backend === 'comfyui' ? ` workflow=${String(values.workflow ?? '')}` : ` provider=${providerId} model=${modelId}`} duration=${durationS}s cells=${jobs.length} chroma=${chromaEnabled ? 'on' : 'off'}`);

		// ② **逐格独立生成**（2026-09-07 全渠道统一）：每个表情单格 → 独立图生
		//   视频 → 单格抠像 → 单格 GIF。不再有「整图集一次生成 → 切格」路线
		//   （视频模型对整版运动理解差、单格动作不独立、邻格渗入相互污染）。
		//   两渠道差异仅在「单格 → 视频」一步：
		//   - comfyui：该格作 LoadImage 输入跑所选本地视频工作流（I2V）；
		//   - provider：videogen RPC（1:1 方形、768P；raceAbort 可取消）。
		{
			// comfyui 渠道守卫（提前于循环，避免逐格才报配置错）。
			const workflowName = backend === 'comfyui'
				? (typeof values.workflow === 'string' && values.workflow.trim() ? values.workflow.trim() : '')
				: '';
			if (backend === 'comfyui' && !workflowName) {
				return { ...empty, error: 'ComfyUI 渠道需要选择视频工作流（生成渠道 → 工作流下拉）。' };
			}
			if (backend === 'comfyui' && !input.runner) {
				return { ...empty, error: 'ComfyUI 渠道需要 ComfyUI runner：请在 Runner 面板连接 ComfyUI 后重试（或切回 Provider 渠道）。' };
			}
			// ★ seed（comfyui 渠道）：用户可固定（>0 复现同一动图）；0/未设置 = 随机。
			const seedUser = Number(values.seed);
			const seed = Number.isFinite(seedUser) && seedUser > 0 ? Math.floor(seedUser) : Math.floor(Math.random() * 0x7fffffff);
			// eslint-disable-next-line no-console
			console.warn(`[AnimatedEmoji] per-cell mode: ${jobs.length} 格 × 1 视频/格（backend=${backend} provider=${providerId} model=${modelId} duration=${durationS}s chroma=${chromaEnabled ? 'on' : 'off'}）`);
			const entriesLocal: MediaSnapshotEntry[] = [];
			const failures: string[] = [];
			const per = 92 / jobs.length;
			for (let ji = 0; ji < jobs.length; ji++) {
				const job = jobs[ji];
				const base = 4 + per * ji;
				onProgress?.({ progress: base });
				try {
					// ① 单格绿底合成（chroma 关闭 → 原图直喂）
					const seedCell = chromaEnabled ? await compositeImageOnChroma(job.ref, chromaColor, fetchImpl) : job.ref;
					// ② 单格视频（1:1 方形、768P；prompt = 全局动作描述 + 该格动作描述 + 绿幕约束）
					const cellPrompt = typeof job.cellPrompt === 'string' ? job.cellPrompt.trim() : '';
					const promptParts = [rawPrompt, cellPrompt].filter(Boolean);
					const cellPromptFull = promptParts.length
						? `${promptParts.join(', ')}${chromaEnabled ? ANIMATED_EMOJI_GREEN_SUFFIX : ''}`
						: (chromaEnabled ? ANIMATED_EMOJI_GREEN_SUFFIX.slice(2) : '');
					onProgress?.({ progress: base + per * 0.05 });
					let cellVideoUrl = '';
					if (backend === 'comfyui') {
						// 单格 → 工作流 LoadImage：把该格 ref 写入 comfytv_image_refs
						// （applyAssetRefOverrides 的 override 语义：钉住资产优先于上游
						// 连线，覆盖 upstream_image 绑定）。快照归档键按格隔离（snapKey#cellN
						// ——nodeCard 按 snapKey 读 OUTPUT，逐格写同一 snapKey 会让上次
						// run 的视频混入本次）。
						const r = await runStageWorkflow({
							runner: input.runner!,
							nodeId,
							snapshotKey: `${snapKey}#cell${job.cellIndex}`,
							type: 'Saros.AnimatedEmoji',
							kind: 'video',
							workflowKind: 'video',
							values: {
								...values,
								seed,
								workflow: workflowName,
								prompt: cellPromptFull,
								main_prompt: cellPromptFull,
								[ASSET_REFS_PROP]: [{ ref: seedCell, slot: 0, type: 'image' }],
							},
							upstreams: input.upstreams,
							store,
							onProgress: (p) => onProgress?.({ progress: base + per * 0.05 + (typeof p.progress === 'number' ? p.progress : 0) * per * 0.6 }),
							signal: input.signal,
							resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
						});
						if (r.status !== 'success') {
							throw new Error(`ComfyUI 视频工作流失败：${r.error ?? 'unknown'}`);
						}
						const producedVideos = store.byNode(`${snapKey}#cell${job.cellIndex}`).filter((e: MediaSnapshotEntry) => e.media.kind === 'video');
						cellVideoUrl = producedVideos[producedVideos.length - 1]?.media.ref ?? '';
						if (!cellVideoUrl) {
							throw new Error('ComfyUI 视频工作流完成但未取到视频（检查工作流的 video 输出）。');
						}
					} else {
						const resp = await raceAbort(send({
							providerId,
							modelId,
							prompt: cellPromptFull,
							duration: durationS,
							resolution: '768P',
							ratio: '1:1',
							imageInput: seedCell,
						}), input.signal);
						cellVideoUrl = resp?.videos?.[0]?.url ?? '';
						if (!cellVideoUrl) {
							throw new Error('视频生成接口未返回视频（检查 provider 额度 / 模型是否支持图生视频）');
						}
					}
					// ③ 单格抠像 → 透明 GIF（≤max_kb 压缩迭代；240 上限 = 微信规范，
					//    单格天然适配，无切格/内缩开销）。
					const gif = await convertVideoToTransparentGif(
						cellVideoUrl,
						{ ...EMOJI_GIF_PARAMS, fps, max_width: 240, max_frames: durationS * fps, end_s: durationS },
						{ color: chromaColor, similarity: chromaSimilarity, smoothness: chromaSmoothness },
						fetchImpl,
						(p) => onProgress?.({ progress: base + per * 0.8 + (p.value ?? 0) * per * 0.15 }),
						maxKb * 1024,
						// ★ 首帧一致性（2026-09-07）：以参考图（已绿底合成）替换视频首帧
						// → GIF 第 0 帧 = 输入静态贴纸（视频模型首帧常漂移）。
						seedCell,
					);
					const gifDataUrl = await blobToDataUrl(gif.gifBlob);
					const overLimit = gif.bytes > maxKb * 1024;
					const media: MediaRef = {
						kind: 'image',
						ref: gifDataUrl,
						meta: {
							mime: 'image/gif',
							gifFrames: String(gif.frames),
							gifSize: `${gif.width}x${gif.height}`,
							gifDelayCs: String(gif.delayCs),
							bytes: String(gif.bytes),
							compressLevel: String(gif.level),
							cellIndex: String(job.cellIndex),
							...(cellPrompt ? { cellPrompt } : {}),
							backend,
							...(backend === 'comfyui'
								? { provider: 'comfyui', model: workflowName }
								: { provider: providerId, model: modelId }),
							perCell: '1',
							...(overLimit ? { overLimit: '1' } : {}),
						},
					};
					// ④ 归档：绿幕 mp4（诊断）+ 透明 GIF（输出）。
				// ★ 每格唯一 key（2026-09-08）：此前全部 key='' → store 同 key 覆盖，
				//   快照里只剩最后一格（多格图集的 OUTPUT 互相挤掉）。改 cellN key 后
				//   逐格**累加**显示——第 1 格 GIF 转换完成即出现在卡片 OUTPUT，其余
				//   格继续生成（store.put 触发订阅重渲染，天然「处理一个显示一个」）。
				store.put({
					nodeId: snapKey, port: 'video', key: `cell${job.cellIndex}`,
					media: { kind: 'video', ref: cellVideoUrl, meta: { greenScreen: '1', provider: providerId, model: modelId, cellIndex: String(job.cellIndex) } },
				});
				store.put({ nodeId: snapKey, port: 'output', key: `cell${job.cellIndex}`, media });
					entriesLocal.push({ nodeId: snapKey, port: 'output', key: '', media, index: entriesLocal.length });
					onProgress?.({ progress: base + per });
				} catch (cellErr) {
					const cm = cellErr instanceof Error ? cellErr.message : String(cellErr);
					// 取消立即上抛（其余格不再继续）；普通失败记录后继续下一格
					if (input.signal?.aborted || /AbortError/i.test(cm)) { throw cellErr; }
					failures.push(`格 ${ji + 1}: ${cm}`);
					// eslint-disable-next-line no-console
					console.warn(`[AnimatedEmoji] cell ${ji + 1}/${jobs.length} failed: ${cm}`);
				}
			}
			if (entriesLocal.length === 0) {
				return { promptId: '', status: 'error', error: `全部 ${jobs.length} 格生成失败：${failures[0] ?? 'unknown'}`, entries: [] };
			}
			onProgress?.({ progress: 100 });
			const partialNote = failures.length > 0
				? `（${entriesLocal.length}/${jobs.length} 格成功；失败：${failures.join('；')}）`
				: '';
			// eslint-disable-next-line no-console
			console.warn(`[AnimatedEmoji] per-cell done: ${entriesLocal.length}/${jobs.length} 格成功${partialNote}`);
			return {
				promptId: '',
				status: 'success',
				entries: entriesLocal,
				...(partialNote ? { error: partialNote } : {}),
			};
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// ★ 取消响应：abort → 立即 canceled（videogen RPC 600s 内可取消）
		if (input.signal?.aborted || /AbortError/i.test(msg)) {
			return { promptId: '', status: 'canceled', error: '已取消', entries: [] };
		}
		// eslint-disable-next-line no-console
		console.error(`[AnimatedEmoji] run threw: ${msg}`);
		return { ...empty, error: msg };
	}
}

/**
 * Unified node executor shared by the single-node editor popup and the
 * workflow Run: schema nodes execute as their FULL ComfyTV workflow (degrading
 * to single-node when the runner has no ComfyTV extension), everything else
 * executes as a single ComfyUI class_type. ComfyTV fx-chain stages (builders
 * + the FX Chain terminal) run as single-node prompts with the threaded
 * fx value injected on the video input and fx-aware output extraction.
 * ComfyTV pickers/loaders (P2) resolve locally without any backend call.
 * Provider image-gen nodes (kind 'llm') run through the injected RPC.
 * M3: Saros.Agent orchestration nodes run through the injected agent RPC.
 */
