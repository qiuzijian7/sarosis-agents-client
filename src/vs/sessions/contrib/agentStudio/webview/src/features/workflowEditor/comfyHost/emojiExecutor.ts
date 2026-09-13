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
import { hasSheetLikeMeta, isSheetFullMeta, META_SHEET_FLAG, sheetDimsMeta } from './mediaSnapshotStore.js';
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
import { runVideoToGifNode, convertVideoToGif, convertVideoToGridTransparentGifs, blobToDataUrl, dataUrlToBlob } from './videoToGifExecutor.js';
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
import { splitStickerSheet, defaultSheetCellCrops, parseSheetCellCrops, buildEmojiSheetPrompt, resolveSheetBackground, resolveEmojiSheetSize, makeSizePostProcess, composePostProcess, autoDetectCellCrops, EMOJI_SHEET_MARGIN_RATIO, type SheetCellCrop, type SplitSheetCell, type SheetOwnershipMask } from './emojiSheetUtils.js';
import { composeImageGridOnChroma } from './chromaCompose.js';

// ★ 静态表情包执行器（runEmojiStageGrid）。

export async function runEmojiStageGrid(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, values, upstreams, store, getSpec, onProgress, signal } = input;
	const snapshotKey = input.snapshotKey ?? nodeId;
	const spec = getSpec(type);

	// ★ 整轮开始：汇总输入（rows/cols/upstreams/上游文本数/默认 workflow）。
	const initialWorkflow = typeof values.workflow === 'string' ? values.workflow : '(default)';
	// eslint-disable-next-line no-console
	console.log(
		`[EmojiStage] run start nodeId=${nodeId} rows=${values.rows} cols=${values.cols} ` +
		`workflow="${initialWorkflow}" upstreams=${upstreams?.length ?? 0}`,
	);

	const rows = clampInt(values.rows, 1, 6, 3);
	const cols = clampInt(values.cols, 1, 6, 3);
	const total = rows * cols;
	const cells = parseEmojiCells(values.cells, total);
	// 主题专属完整 prompt 模板：作为每格 prompt 的兜底主体（取代原顶部全局 prompt）。
	// 选了主题但某格手填/上游文本都空时，用该模板直接当主 prompt，而非"后缀叠加"。
	const themeTemplate = styleTemplateOf(typeof values.style_preset === 'string' ? values.style_preset : undefined);
	// ★ run_scope='recrop'（单格调整裁剪应用）必须走 **cell 语义**——它会按
	//   cell_crops 重裁现有图集。此前映射落到了 'all' → 执行开头 clearNode
	//   清空全部快照，recrop 又查不到基底图集 → 节点 OUTPUT 全空（数据丢失）。
	const scope = (values.run_scope === 'cell' || values.run_scope === 'recrop') ? 'cell' : 'all';
	const selIdx = clampInt(values.selected_index, 0, total - 1, 0);

	// ★ 上游文本 → m×n 逐格数据。两条路径（严格优先）：
	//   1. `parseEmojiCellArray`：JSON 数组 → 完整 cell（prompt/seed/text 全字段），
	//      是「严格按 JSON 数组划分」的权威来源，覆盖手填 cells 的对应格子；
	//   2. `splitEmojiPrompts`：非 JSON 文本 → 只产 prompt（多行/分隔符/单条），
	//      作为 cell.prompt 的兜底。
	//   最终每格 prompt 优先级：严格 cell.prompt > 手填 cell.prompt > 启发式 prompt > 主题模板。
	const upstreamTexts = collectUpstreamTexts(store, upstreams);
	const strictCells = parseEmojiCellArray(upstreamTexts);
	const splitPrompts = strictCells ? [] : splitEmojiPrompts(upstreamTexts);
	const splitCount = splitPrompts.length;
	// 单条上游文本 → 所有格子共用（配合不同 seed 生成变体）；多条 → 按格序分配，
	// 不足时循环复用。零条 → 无上游文本，回退 cell.prompt / 主题模板。
	const cellPromptFromText = (i: number): string => {
		if (splitCount === 0) { return ''; }
		return splitPrompts[i % splitCount];
	};

	// ★ 诊断：上游文本拆分结果（为空时用户可能误以为「接了但没生效」）。
	// eslint-disable-next-line no-console
	console.log(
		`[EmojiStage] upstream text texts=${upstreamTexts.length} strictCells=${strictCells?.length ?? 0} ` +
		`splitPrompts=${splitCount} themeTemplate=${truncateForLog(themeTemplate, 60) || '(empty)'}`,
	);

	const targets = scope === 'cell' ? [selIdx] : Array.from({ length: total }, (_, i) => i);

	// 单格模式：记录现有图/视频列表（按 index 序）用于跑完重排回原位。
	// ★ 同时统计 image 与 video：动态表情现在是 MiniMax H3 视频（mp4，kind='video'），
	//   runEmojiStageGrid 必须按 media 粒度感知，否则单格产物归档不到 cellRef（曾因
	//   kind==='image' 过滤导致 `[EmojiStage] cell #0 success but no new image entry`）。
	// ★ 格序列收集**排除图集类 entry**（2026-09-02）：静态表情包节点 byNode 里
	//   同时有独立格（port 'output'）与图集（port 'sheet' 的 sheetFull / port
	//   'image' 的合并图集 meta.sheet='1'）。图集混进 before → recrop 收尾重放
	//   时被当"格"写回 port 'output' → OUTPUT 网格里出现嵌套图集、且 cell_crops
	//   格位与列表错位（用户看到的「移动后裁剪列表错乱」）。
	//   图集不进格序列：合并图集由收尾统一重建（image 口），sheetFull 在
	//   scope='all' 的 clearNode 中清掉后由合并图集承担 recrop 基底职能。
	const isSheetEntry = (m: MediaRef): boolean => {
		const meta = (m as { meta?: Record<string, string> }).meta as Record<string, string> | undefined;
		return hasSheetLikeMeta(meta);
	};
	const imagesOf = (): MediaRef[] => store.byNode(snapshotKey)
		.filter(e => (e.media.kind === 'image' || e.media.kind === 'video') && !isSheetEntry(e.media))
		.map(e => e.media);
	/** 当前节点名下全部归档 key 的集合 —— 用于「跑完后按 key 差集精确定位本格新产物」。 */
	const imageKeysOf = (): Set<string> => new Set(
		store.byNode(snapshotKey).filter(e => (e.media.kind === 'image' || e.media.kind === 'video') && !isSheetEntry(e.media)).map(e => e.key),
	);
	const before: MediaRef[] = scope === 'cell' ? imagesOf() : [];

	if (scope === 'all') { store.clearNode(snapshotKey); }

	const collected: MediaSnapshotEntry[] = [];
	// 每格烘焙后的最终 media（按格 index 对齐），循环结束后清空重放。
	// 配文只烘焙到静态贴纸（PNG）；动画 webp 跳过（保动画），配文走编辑器预览层 CSS 叠加。
	const bakedByTarget = new Map<number, MediaRef>();
	let lastPromptId = '';

	// ── 渠道选择（2026-09-02）：backend='comfyui'（默认）| 'provider' ─────────
	// ComfyUI 渠道：模型下拉 values.comfy_model → 模板 option:comfy_model 注入
	//   CheckpointLoaderSimple.ckpt_name（qwen/sdxl 等本地模型）；单格路径沿用
	//   现有逐格循环（cellValues 展开 values 已携带 comfy_model）。
	// Provider 渠道：走 imagegen.generate RPC（provider/model 下拉，supportsImageGen）。
	const backend = values.backend === 'provider' ? 'provider' : 'comfyui';
	const comfyModel = typeof values.comfy_model === 'string' ? values.comfy_model.trim() : '';
	const providerIdRaw = typeof values.provider === 'string' ? values.provider.trim() : '';
	const modelIdRaw = typeof values.model === 'string' ? values.model.trim() : '';
	// ★ 外网 ref（provider 签名 URL 等）CSP 兜底——splitStickerSheet/compose 拉
	//   远程 ref 时原生 fetch 会被 webview connect-src 拦截 → forceProxy 直走
	//   host 代理（消除必败直连的 CSP 报错噪音）。
	const fetchImpl = withRemoteProxyFetch(input.fetchImpl ?? globalThis.fetch, { forceProxy: true });

	/** 每格描述解析（与循环内三级优先级一致：严格 JSON cell > 手填 > 上游文本 > 主题模板）。 */
	const resolveCellPrompt = (i: number): string => {
		const strict = strictCells?.[i];
		const cell: EmojiCellState = strict ?? cells[i] ?? { prompt: '', seed: 0, text: '' };
		return (cell.prompt || '').trim() || cellPromptFromText(i) || themeTemplate;
	};

	/**
	 * 通用收尾：把 bakedByTarget 交给函数尾部统一的「收尾重排」——
	 * 置 sheetMode=true 跳过逐格循环，重排/重放/返回值全部复用现有代码
	 * （scope='all' 清空重放、scope='cell' 替换重排，语义都正确）。
	 */
	let sheetMode = false;

	// ★ 上游参考图（images 端口连线 / 卡片钉住资产）：整图与 provider 单格共用。
	//   此前整图路径完全丢失参考图（模板纯 text2img + provider 未传 imageInput），
	//   「输入端口引入的图像没有被作为参考图使用」即此因。来源解析与单格循环
	//   同源：① 上游连线快照 ② values.comfytv_image_refs 钉住资产。
	const upstreamRefMap = collectUpstreamRefs(store, upstreams);
	applyAssetRefOverrides(upstreamRefMap, values);
	// ★ 改 let（2026-09-08）：sheet 口兜底普通图（isSheetFull=false）不再短路生成
	//   （原「无条件直通」让点「重新生成」永远不调 provider——用户日志实证），
	//   改为并入参考图（img2img），见 upstreamSheet 声明后的回填。
	let upstreamImageRef = upstreamRefMap['image'] ?? '';
	// ★ sheet 输入直通（2026-09）：`sheet` 输入端口连线 → 取上游归档的整图图集
	//   （meta.sheetFull='1'，port 'sheet'；兜底上游最新 image——外部拼贴图上游
	//   未必带 sheetFull 标注）。调度器已把边 source 映射为上游 snapshotKey
	//   （workflowRun 主调度 inbound 构造处），byNode 直查即可。
	const sheetInputSource = input.inbound?.find(e => e.targetHandle === 'sheet')?.source ?? '';
	const upstreamSheet = sheetInputSource ? (() => {
		const entries = store.byNode(sheetInputSource).filter(e => e.media.kind === 'image');
		const hit = [...entries].reverse().find(e => isSheetFullMeta(e.media.meta));
		// ★ 与预览（nodeCard）同规则：命中 sheetFull = 真图集基底（cell_crops 坐标系有效）；
		//   兜底普通图仅作显示兼容，isSheetFull=false 供日志/下游判定。
		return { ref: (hit ?? entries[entries.length - 1])?.media.ref ?? '', isSheetFull: !!hit };
	})() : { ref: '', isSheetFull: false };
	const upstreamSheetRef = upstreamSheet.ref;
	// ★ 兜底普通图（isSheetFull=false）并入参考图（2026-09-08）：上游连线的是
	//   普通图（非 sheetFull 归档）时，用户意图多半是 img2img 参考——直通切分会
	//   「吞掉重新生成」且把普通图伪装成图集等分切割（几何必然错位）。
	if (!upstreamSheet.isSheetFull && !upstreamImageRef && upstreamSheetRef) {
		upstreamImageRef = upstreamSheetRef;
	}
	// ★ 生成图像大小（2026-09-02）：整版图集分辨率，两渠道共用。
	//   provider → sendImageGen.width/height；comfyui → 覆盖模板 latent 尺寸。
	const sheetSize = resolveEmojiSheetSize(values.size);
	const sizePostProcess = makeSizePostProcess(sheetSize.width, sheetSize.height);

	// ═══ 整图图集模式（v7）：生成 m×n 拼贴整图 → **简单行列裁剪**（cell_crops 可由
	//   用户在编辑器拖拽/缩放修正）。run_scope='recrop' = 跳过生成，对上次归档的
	//   整图（port 'sheet'）按新 cell_crops 重裁——零生成成本反复校准。
	const cellCrops = parseSheetCellCrops(values.cell_crops, rows, cols);
	const isRecrop = values.run_scope === 'recrop';
	// ★ 抠图方式（2026-09-08）：none = 纯裁剪（2026-09-03 起默认）；flood = 白底
	//   flood-fill；chroma = 绿幕 chroma-key（需绿幕图集，prompt 自动追加绿幕底）。
	//   声明在外层：切分（splitStickerSheet）在 if(isRecrop)/else 之外共用。
	const cutoutMode = values.cutout_mode === 'flood' || values.cutout_mode === 'chroma'
		? (values.cutout_mode as 'flood' | 'chroma')
		: 'none';
	// ★ 切分 = **纯裁剪**（2026-09-03 用户要求）：生成链路不执行任何抠图
	//   （flood-fill / AI 均不跑）。透明化由两条路径覆盖：① prompt 的图集底
	//   约束（模型原生输出）；② 用户手动点「去背景」/迷你编辑器（内置 U²Net）。
	try {
		let sheetRef = '';
		let cellPromptList: string[] = [];
		// ★ sheet 直通模式（2026-09）：上游整图图集 → 跳过生成，直接切分。
		//   归档契约与自生成一致（sheetFull='1' + rows/cols meta），下游
		//   latestRoundOf / nodeCard 对账逻辑无需感知来源差异。
		// ★ 2026-09-08 收紧：仅 **sheetFull='1' 真图集**才直通——上游是普通图时
		//   直通会①吞掉「重新生成」（永远不调 provider，用户日志实证）②把普通图
		//   伪装成图集等分切割（几何错位）。普通图改走参考图（见 upstreamSheet
		//   声明处的回填），落到下方正常生成分支。
		if (upstreamSheetRef && upstreamSheet.isSheetFull) {
			sheetRef = await localizeImageRef(upstreamSheetRef);
			cellPromptList = [];
			// 整图归档（port 'sheet'，meta.sheetFull='1'）：与自生成分支同契约，
			// 本节点输出 sheet 口（sheetFull 归档）供下一级 EmojiStage 直通连线。
			store.put({
				nodeId: snapshotKey,
				port: 'sheet',
				key: '',
				media: { kind: 'image', ref: sheetRef, meta: { sheetFull: META_SHEET_FLAG, rows: String(rows), cols: String(cols) } },
			});
			onProgress?.({ progress: 60 });
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] sheet passthrough from=${sheetInputSource.slice(0, 40)} isSheetFull=${upstreamSheet.isSheetFull} len=${sheetRef.length}…`);
		} else if (isRecrop) {
			// 裁剪基底 = **原生整图**（meta.sheetFull='1'）：cell_crops 是用户在
			// MiniImageEditor 的整图视图上调出来的，坐标系归属于原生整图；合并
			// 图集（sheet='1'）已被标准化重拼，几何不再对应 cell_crops。此前靠
			// 「key 字典序尾部恰好是 sheetFull」碰对——显式化，消除运气依赖。
			const sheetEntry = [...store.byNode(snapshotKey)].reverse()
				.find(e => e.media.kind === 'image' && isSheetFullMeta(e.media.meta));
			if (!sheetEntry) {
				return { promptId: '', status: 'error', error: '没有可重裁的图集——请先正常生成一次', entries: collected };
			}
			sheetRef = sheetEntry.media.ref;
			// ★ 历史归档可能是未本地化的远程签名 URL（旧版本写入/本地化失败回退）：
			//   recrop 前先本地化（幂等，data URL 原样返回），重裁产物不再续写过期 URL。
			sheetRef = await localizeImageRef(sheetRef);
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] recrop base=${isSheetFullMeta(sheetEntry.media.meta) ? 'sheetFull' : 'mergedSheet'} rows/cols=${rows}x${cols} cellCrops=${JSON.stringify(cellCrops)} ref=${sheetRef.slice(0, 40)}…`);
			// 保留上次各格 prompt 元数据（recrop 不改内容只改裁剪）
			cellPromptList = store.byNode(snapshotKey)
				.filter(e => e.port === 'output' && e.media.meta?.cellPrompt)
				.map(e => String(e.media.meta?.cellPrompt));
			onProgress?.({ progress: 30 });
		} else {
			const cellPrompts = targets.map((i) => resolveCellPrompt(i));
			// ★ 背景策略：默认 auto —— 不再强加白底，让「透明背景」的格描述生效
			//   （白底交由下方切图的 floodFillWhiteBg 兜底抠除，见 cutoutBg）。
			const sheetBg = resolveSheetBackground(values.sheet_background);
			// chroma 模式需要**绿幕图集**——prompt 自动追加绿幕底约束（用户不必手写）；
			// 但 sheet_background='green' 时 header/替换已含绿幕子句，不重复追加。
			// 抠像在切分阶段进行（cutoutMode 见上方声明）。
			const chromaSuffix = cutoutMode === 'chroma' && sheetBg !== 'green'
				? ', IMPORTANT: the entire background MUST be solid pure green screen color (#00FF00), flat uniform green backdrop behind every sticker, absolutely no white background, no transparent background, no gray, no gradient, no shadows on the background'
				: '';
			const sheetPrompt = buildEmojiSheetPrompt(rows, cols, cellPrompts, sheetBg) + chromaSuffix;
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] sheet mode backend=${backend} bg=${sheetBg} cutout=${cutoutMode} size=${sheetSize.width}x${sheetSize.height} ${rows}x${cols} prompt=${truncateForLog(sheetPrompt, 140)}`);
			onProgress?.({ progress: 5 });
			if (backend === 'provider') {
				const send = input.sendImageGen;
				if (!send) {
					return { promptId: '', status: 'error', error: 'Provider 图像生成通道未注入（imagegen.generate）', entries: collected };
				}
				let pid = providerIdRaw;
				let mid = modelIdRaw;
				if (!pid || !mid) {
					const picker = collectUpstreamProviderConfig(store, upstreams);
					if (picker) {
						pid = pid || picker.providerId;
						mid = mid || picker.modelId;
					}
				}
				if (!pid || !mid) {
					return { promptId: '', status: 'error', error: '请先在 Provider 选项卡中选择 Provider 和图像模型', entries: collected };
				}
				const resp = await raceAbort(send({
					providerId: pid,
					modelId: mid,
					prompt: sheetPrompt,
					width: sheetSize.width,
					height: sheetSize.height,
					numImages: 1,
					// ★ img2img：上游 images 端口参考图（gpt_image_2 等图生图模型）
					...(upstreamImageRef ? { imageInput: upstreamImageRef } : {}),
				}), signal);
				const first = resp?.images?.[0];
				sheetRef = first?.url ?? (first?.b64 ? `data:image/png;base64,${first.b64}` : '');
				if (!sheetRef) {
					return { promptId: '', status: 'error', error: '图像生成接口未返回图片（检查 provider 额度 / 模型是否支持文生图）', entries: collected };
				}
				// ★ 归档前本地化：provider 签名 URL 有时效（COS 2h），直接归档 →
				//   重启后 403「llm 原图消失」。拉取转 data URL 固化（失败保留原 ref）。
				sheetRef = await localizeImageRef(sheetRef);
				signal?.throwIfAborted();
			} else {
				// ComfyUI 渠道：**模型驱动组装**（2026-09-04「任意模型」）——不再按
				// comfy_model_group 挑模板，按所选模型族（qwen/flux/sd3.5/sdxl/sd15 ×
				// ckpt/unet）动态构造最终 api_json（emojiModelAdapt）。单图与图集
				// 共用同一条组装路径，任何模型都能生成。
				const seed = Math.floor(Math.random() * 0x7fffffff);
				const modelSpec = parseComfyModelValue(comfyModel || 'sd_xl_base_1.0.safetensors');
				// 参考图先 resolve 成 ComfyUI 文件名（组装侧 LoadImage 就地写入；
				// promptOverride 直通不再执行 executor 内的上游桥接）。
				let sheetRefImage: string | undefined;
				if (upstreamImageRef) {
					const resolver = input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner);
					const bridged = await raceAbort(resolver(upstreamImageRef, signal), signal);
					if (bridged.ok && bridged.image) {
						sheetRefImage = bridged.image;
					} else {
						// eslint-disable-next-line no-console
						console.warn(`[EmojiStage] sheet ref resolve failed: ${bridged.error ?? 'unknown'} → 退回 text2img`);
					}
				}
				const built = buildEmojiModelPrompt(modelSpec, {
					positive: sheetPrompt,
					negative: EMOJI_NEGATIVE_PROMPT,
					seed,
					width: sheetSize.width,
					height: sheetSize.height,
					refImage: sheetRefImage,
					denoise: sheetRefImage ? 0.75 : 1.0,
					filenamePrefix: 'ComfyTV/emoji_sheet',
				});
				// eslint-disable-next-line no-console
				console.warn(`[EmojiStage] sheet 组装 model=${built.debug}`);
				const r = await runStageWorkflow({
					runner,
					nodeId,
					snapshotKey,
					type,
					kind: spec?.comfyTV?.kind ?? 'emoji',
					workflowKind: spec?.comfyTV?.workflowKind ?? 'emoji',
					values: {
						...values,
						prompt: sheetPrompt,
						main_prompt: sheetPrompt,
						comfy_model: comfyModel,
						seed,
						batch_size: 1,
					},
					upstreams,
					store,
					onProgress: (p) => onProgress?.({ progress: 5 + (typeof p.progress === 'number' ? p.progress : 0) * 0.6 }),
					signal,
					resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
					// ★ 模型驱动组装直通（跳过模板/bindings/预检），产物提取节点由组装返回
					promptOverride: built.prompt,
					promptSaveNodeId: built.saveNodeId,
				});
				lastPromptId = r.promptId || lastPromptId;
				if (r.status !== 'success') {
					return { promptId: lastPromptId, status: r.status, error: `整图图集生成失败：${r.error ?? 'unknown'}`, entries: collected };
				}
				const produced = store.byNode(snapshotKey).filter(e => e.media.kind === 'image');
				sheetRef = produced[produced.length - 1]?.media.ref ?? '';
				if (!sheetRef) {
					return { promptId: lastPromptId, status: 'error', error: '整图图集生成成功但未取到图像', entries: collected };
				}
			}
			// ★ 整图归档（port 'sheet'，meta.sheetFull='1'）：编辑器「调整裁剪」的
			//   原图来源 + recrop 的重裁输入。ownSnapshots 消费端按 port 过滤。
			//   meta 顺带带 rows/cols：下游转动态表情包接此图集时可自动对齐拆分行列。
			store.put({
				nodeId: snapshotKey,
				port: 'sheet',
				key: '',
				media: { kind: 'image', ref: sheetRef, meta: { sheetFull: META_SHEET_FLAG, rows: String(rows), cols: String(cols) } },
			});
			cellPromptList = cellPrompts;
		}
		onProgress?.({ progress: 72 });
		// ★ 切分方式（2026-09-10）：'auto' = 自动居中——抠图后逐格检测贴纸包围盒，
		//   以贴纸中心正方形裁剪（三重有界防跑偏/吞并/交叉，失败落回等分）。检测
		//   需 alpha：cutout_mode=none 时函数内部用「检测域四边中位色」色差兜底。
		// ★ 2026-09-10 修正：recrop 才跳过（尊重用户手动微调过的 cell_crops），
		//   新生成 + 上游直通都启用 auto（直通图集往往格式不规则，最需要自动居中）。
		let effectiveCrops = cellCrops;
		let ownership: SheetOwnershipMask | null = null;
		if (values.cell_crop_mode === 'auto' && !isRecrop) {
			onProgress?.({ progress: 73 });
			const detected = await autoDetectCellCrops(sheetRef, rows, cols, { fetchImpl });
			if (detected) {
				effectiveCrops = detected.crops;
				ownership = detected.ownership;
				// eslint-disable-next-line no-console
				console.warn(`[EmojiStage] auto cell crops applied: ${JSON.stringify(detected.crops.slice(0, 3).map(c => ({ x: +c.x.toFixed(3), y: +c.y.toFixed(3), w: +c.w.toFixed(3) })))}…`);
			}
		}
		// ★ 拆分 = 按行列（cell_crops / 自动检测框）裁剪 + 可选抠图（cutout_mode）：
		//   none = 纯裁剪（2026-09-03 起默认）；flood = 白底 flood-fill 抠底；
		//   chroma = 绿幕 chroma-key（sheetUtils 内自动采样 key 色 + 五道后处理）。
		const cellsOut = await splitStickerSheet(sheetRef, rows, cols, {
			marginRatio: EMOJI_SHEET_MARGIN_RATIO,
			cutoutBg: cutoutMode === 'flood',
			chroma: cutoutMode === 'chroma',
			cellCrops: effectiveCrops,
			ownership,
		}, fetchImpl);
		for (let i = 0; i < cellsOut.length; i++) {
			bakedByTarget.set(i, {
				kind: 'image',
				ref: cellsOut[i].dataUrl,
				meta: {
					mime: 'image/png',
					...(cellPromptList[i] ? { cellPrompt: cellPromptList[i] } : {}),
					sheetMode: '1',
					cellSize: `${cellsOut[i].w}x${cellsOut[i].h}`,
					...(cellCrops?.[i] ? { cellRect: JSON.stringify(cellCrops[i]) } : {}),
					...(isRecrop ? { recrop: '1' } : {}),
				},
			});
		}
		// eslint-disable-next-line no-console
		console.warn(`[EmojiStage] sheet done (v7): ${rows}x${cols} → ${cellsOut.length} cells recrop=${isRecrop}`);
		sheetMode = true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// ★ 取消响应：abort（任务面板 ✕ / 卡片取消）→ 立即返回 canceled
		if (signal?.aborted || /AbortError/i.test(msg)) {
			return { promptId: lastPromptId, status: 'canceled', error: '已取消', entries: collected };
		}
		// eslint-disable-next-line no-console
		console.error(`[EmojiStage] sheet mode failed: ${msg}`);
		return { promptId: lastPromptId, status: 'error', error: `表情图集生成/裁剪失败：${msg}`, entries: collected };
	}
	// （2026-09-02 缝合说明：外部并行编辑的中间态在此多了一个闭合 `}`，已移除；
//    本分支即外部目标态的独立 if——scope='cell' && backend==='provider'。）
	// ★ recrop（调整裁剪应用）**只重裁现有图集，绝不调图像生成 API**——
	//   此前 scope='recrop' 映射到 cell 后会命中本分支 → 白白烧一次生成配额，
	//   且 API 新产物（可能与图集格位不符）塞进图集导致错乱。
	if (scope === 'cell' && backend === 'provider' && !isRecrop) {
		// ═══ Provider 渠道单格重生成（需求3）：只重出选中格，不影响其他格 ═══
		try {
			const send = input.sendImageGen;
			if (!send) {
				return { promptId: '', status: 'error', error: 'Provider 图像生成通道未注入（imagegen.generate）', entries: collected };
			}
			let pid = providerIdRaw;
			let mid = modelIdRaw;
			if (!pid || !mid) {
				const picker = collectUpstreamProviderConfig(store, upstreams);
				if (picker) {
					pid = pid || picker.providerId;
					mid = mid || picker.modelId;
				}
			}
			if (!pid || !mid) {
				return { promptId: '', status: 'error', error: '请先在 Provider 选项卡中选择 Provider 和图像模型', entries: collected };
			}
			const cellPrompt = resolveCellPrompt(selIdx);
			const seed = cells[selIdx]?.seed || Math.floor(Math.random() * 0x7fffffff);
			// ★ 与整版同源的背景策略：white 追加 isolated on white background（供
			//   floodFillWhiteBg 抠图）；transparent 追加 isolated on transparent
			//   background；auto 不追加 —— 让用户在格描述里写的「透明背景」生效。
			const cellBg = resolveSheetBackground(values.sheet_background);
			const cellBgClause = cellBg === 'auto' ? '' :
				cellBg === 'transparent' ? ', isolated on transparent background' : ', isolated on white background';
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] provider cell #${selIdx} bg=${cellBg} prompt=${truncateForLog(cellPrompt, 100)} seed=${seed}`);
			onProgress?.({ progress: 10 });
			const resp = await raceAbort(send({
				providerId: pid,
				modelId: mid,
				prompt: `${cellPrompt}, single die-cut sticker, thick outlines${cellBgClause}, centered`,
				width: sheetSize.width,
				height: sheetSize.height,
				numImages: 1,
				// ★ img2img：上游 images 端口参考图（与整图模式同源）
				...(upstreamImageRef ? { imageInput: upstreamImageRef } : {}),
			}), signal);
			const first = resp?.images?.[0];
			const ref = first?.url ?? (first?.b64 ? `data:image/png;base64,${first.b64}` : '');
			if (!ref) {
				return { promptId: '', status: 'error', error: '图像生成接口未返回图片', entries: collected };
			}
			// 单格也走切分管线（1×1 = 纯裁剪，不做抠图——与整图切分一致）
			const one = await splitStickerSheet(ref, 1, 1, { marginRatio: EMOJI_SHEET_MARGIN_RATIO, cutoutBg: false }, fetchImpl);
			bakedByTarget.set(selIdx, {
				kind: 'image',
				ref: one[0]?.dataUrl ?? ref,
				meta: { mime: 'image/png', cellPrompt, sheetMode: 'cell' },
			});
			sheetMode = true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// ★ 取消响应（同 sheet 分支）：abort → 立即 canceled
			if (signal?.aborted || /AbortError/i.test(msg)) {
				return { promptId: '', status: 'canceled', error: '已取消', entries: collected };
			}
			// eslint-disable-next-line no-console
			console.error(`[EmojiStage] provider cell failed: ${msg}`);
			return { promptId: '', status: 'error', error: `表情生成失败：${msg}`, entries: collected };
		}
	}

	// ★ ComfyUI 渠道单格生成（2026-09-04，与 provider 单格同语义——两渠道粒度
	//   完全对齐：一个提示词 → 一张单表情贴纸 → 1×1 切分管线 → 替换选中格）。
	//   此前 comfyui 的 scope='cell' 落进通用逐格循环走模板（无单贴纸样式约束、
	//   无背景策略、产物不经 1×1 切分），行为与 provider 单格不一致。
	if (scope === 'cell' && backend === 'comfyui' && !isRecrop) {
		try {
			const cmRaw = comfyModel || 'sd_xl_base_1.0.safetensors';
			const modelSpec = parseComfyModelValue(cmRaw);
			const cellPrompt = resolveCellPrompt(selIdx);
			const seed = cells[selIdx]?.seed || Math.floor(Math.random() * 0x7fffffff);
			// ★ 与 provider 单格/整版同源的背景策略 + 单贴纸样式约束。
			const cellBg = resolveSheetBackground(values.sheet_background);
			const cellBgClause = cellBg === 'auto' ? '' :
				cellBg === 'transparent' ? ', isolated on transparent background' : ', isolated on white background';
			const cellPositive = `${cellPrompt}, single die-cut sticker, thick outlines${cellBgClause}, centered`;
			// 参考图 resolve 成 ComfyUI 文件名（组装侧 LoadImage 就地写入）。
			let cellRefImage: string | undefined;
			if (upstreamImageRef) {
				const resolver = input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner);
				const bridged = await raceAbort(resolver(upstreamImageRef, signal), signal);
				if (bridged.ok && bridged.image) { cellRefImage = bridged.image; }
			}
			const built = buildEmojiModelPrompt(modelSpec, {
				positive: cellPositive,
				negative: EMOJI_NEGATIVE_PROMPT,
				seed,
				width: sheetSize.width,
				height: sheetSize.height,
				refImage: cellRefImage,
				denoise: cellRefImage ? 0.75 : 1.0,
				filenamePrefix: 'ComfyTV/emoji_cell',
			});
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] comfyui cell #${selIdx} 组装 model=${built.debug}`);
			onProgress?.({ progress: 10 });
			const r = await runStageWorkflow({
				runner,
				nodeId,
				snapshotKey,
				type,
				kind: spec?.comfyTV?.kind ?? 'emoji',
				workflowKind: spec?.comfyTV?.workflowKind ?? 'emoji',
				values: { ...values, prompt: cellPositive, main_prompt: cellPositive, comfy_model: cmRaw, seed, batch_size: 1 },
				upstreams,
				store,
				onProgress: (p) => onProgress?.({ progress: 10 + (typeof p.progress === 'number' ? p.progress : 0) * 0.8 }),
				signal,
				resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
				promptOverride: built.prompt,
				promptSaveNodeId: built.saveNodeId,
			});
			if (r.status !== 'success') {
				return { promptId: r.promptId || lastPromptId, status: r.status, error: `表情生成失败：${r.error ?? 'unknown'}`, entries: collected };
			}
			const produced = store.byNode(snapshotKey).filter(e => e.media.kind === 'image');
			const cellRef = produced[produced.length - 1]?.media.ref ?? '';
			if (!cellRef) {
				return { promptId: r.promptId || lastPromptId, status: 'error', error: '表情生成成功但未取到图像', entries: collected };
			}
			// 单格同样走 1×1 切分管线（纯裁剪，与 provider 单格/整图切分一致）。
			const one = await splitStickerSheet(cellRef, 1, 1, { marginRatio: EMOJI_SHEET_MARGIN_RATIO, cutoutBg: false }, fetchImpl);
			bakedByTarget.set(selIdx, {
				kind: 'image',
				ref: one[0]?.dataUrl ?? cellRef,
				meta: { mime: 'image/png', cellPrompt, sheetMode: 'cell' },
			});
			sheetMode = true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// 取消响应（与 provider 单格分支一致）。
			if (signal?.aborted || /AbortError/i.test(msg)) {
				return { promptId: '', status: 'canceled', error: '已取消', entries: collected };
			}
			// eslint-disable-next-line no-console
			console.error(`[EmojiStage] comfyui cell failed: ${msg}`);
			return { promptId: '', status: 'error', error: `表情生成失败：${msg}`, entries: collected };
		}
	}

	if (!sheetMode) for (let n = 0; n < targets.length; n++) {
		if (signal?.aborted) {
			return { promptId: lastPromptId, status: 'canceled', error: '已取消', entries: collected };
		}
		const i = targets[n];
		const manual = cells[i] ?? { prompt: '', seed: 0, text: '' };
		// ★ 严格 JSON cell 数组优先：上游 `[{prompt,seed,text},...]` 覆盖手填 cells
		//   的对应格子（三字段全量替换）。该格无严格 cell 时回退手填。
		const strict = strictCells?.[i];
		const cell: EmojiCellState = strict ?? manual;
		// ★ prompt 优先级：严格 cell.prompt > 手填 cell.prompt > 启发式 prompt[i] > 主题模板。
		//   （编辑器「↩ 用模板」清空 cell.prompt 后，若接入了上游文本则优先用文本，
		//   否则回退主题模板 —— 模板即完整主 prompt，直接当本格 prompt 使用。）
		const cellPrompt = cell.prompt.trim() || cellPromptFromText(i) || themeTemplate;
		// seed=0 视为「未指定」→ 随机，保证每格图不同。
		const cellSeed = cell.seed || Math.floor(Math.random() * 0x7fffffff);
		const cellValues: Record<string, unknown> = {
			...values,
			prompt: cellPrompt,
			main_prompt: cellPrompt,
			seed: cellSeed,
			// batch_size 固定 1：网格由本循环驱动，模板不再自行出多图。
			batch_size: 1,
		};
		// ★ 诊断：每格详细 prompt 来源（用户报告「表情包图像混乱」期间加强）。
		//   三级优先级的实际命中，便于区分「cell.prompt 是错」「strictCells 是错」
		//   还是「prompt 没错、产物渲染就错」。
		// ⚠ 必须放在 cellValues 声明**之后**：之前引用 cellValues.duration_s 会触发
		//   TDZ（`Cannot access 'cellValues' before initialization`）——生产构建
		//   esbuild 的 `pure:['console.log']` 删除 console.log 时仍保留有副作用参数
		//   求值，导致「生成表情包卡住」（日志 Uncaught (in promise) ReferenceError）。
		// eslint-disable-next-line no-console
		console.log(
			`[EmojiStage] cell #${i}/${total} cellPromptSource=${cellPrompt === cell.prompt.trim() ? 'cell' : cellPrompt === cellPromptFromText(i) ? 'split' : 'theme'} ` +
			`prompt="${cellPrompt.slice(0, 80)}" seed=${cellSeed} duration_s=${cellValues.duration_s}`,
		);
		// ★ 本格执行前的图 key 快照 —— 跑完后用差集精确定位「本格产出的图」。
		//   不能用 `imagesOf().at(-1)`：store 里可能并存多个 port 前缀
		//   （`output:*` 由 comfyOutputsToSnapshots 写入、`output:*` 由收尾重放写入），
		//   `byNode` 按 index 排序后不同前缀会交错，末项未必是本格新图。
		const keysBeforeCell = imageKeysOf();
		// ★ Emoji 自动 fallback：先试默认模板（透明贴纸，需 LayeredDiffusion LoRA），
		//   失败时降级到「普通贴纸（无需 LoRA）」—— 覆盖 LoRA 缺失/版本不兼容/
		//   sub_batch_size 不匹配等环境问题导致的图像混乱或执行报错。
		const EMOJI_FALLBACK_LABEL = '普通贴纸 (SDXL, 无需 LoRA)';
		// ★ 检测参考图（用于 fallback 时决定是否切换 img2img 模式）。
		//   参考图有两大来源：① 上游连线快照；② 卡片上「钉住」的资产引用
		//   （values.comfytv_image_refs）。此前只取 ①，钉住的资产被完全忽略
		//   → hasRefImg=false → fallback 走 text2img，生成结果与参考资产无关。
		const upstreamRefMap = collectUpstreamRefs(store, upstreams);
		applyAssetRefOverrides(upstreamRefMap, values);
		const upstreamImageRef = upstreamRefMap['image'] ?? '';
		const hasRefImg = Boolean(upstreamImageRef);
		/** Fallback SDXL 模板的 img2img 切换：有参考图时 KSampler 接 VAEEncode + denoise=0.75 */
		const patchFallbackToImg2Img: StageWorkflowRunOptions['promptPostProcess'] = hasRefImg ? (prompt) => {
			const ks = (prompt as Record<string, unknown>)['5'] as { inputs?: Record<string, unknown> } | undefined;
			if (!ks?.inputs) return;
			ks.inputs.latent_image = ['11', 0];
			ks.inputs.denoise = 0.75;
			console.log('[EmojiStage] fallback → img2img mode (denoise=0.75)');
		} : undefined;

		const tryRunCell = async (fallback?: string): Promise<SingleNodeRunResult> => {
			const v = fallback ? { ...cellValues, workflow: fallback } : cellValues;
			const label = fallback ?? (typeof v.workflow === 'string' ? v.workflow : '(default)');
			// eslint-disable-next-line no-console
			console.log(`[EmojiStage] cell #${i} tryRunCell label="${label}" prompt=${truncateForLog(cellPrompt, 80)} seed=${cellSeed}`);
			// ★ 模型驱动组装优先（2026-09-04「任意模型」）：单格同样按 comfy_model
			//   族动态构造（768² 贴纸惯例尺寸，SD1.5 自动 clamp）。fallback 重试
			//   （fallback 参数存在）走模板路径——组装失败多为辅助模型缺失，
			//   落回内置模板兜底。
			const cmRaw = typeof v.comfy_model === 'string' ? v.comfy_model.trim() : '';
			if (cmRaw && !fallback) {
				const modelSpec = parseComfyModelValue(cmRaw);
				let cellRefImage: string | undefined;
				if (upstreamImageRef) {
					const resolver = input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner);
					const bridged = await raceAbort(resolver(upstreamImageRef, signal), signal);
					if (bridged.ok && bridged.image) { cellRefImage = bridged.image; }
				}
				const built = buildEmojiModelPrompt(modelSpec, {
					positive: cellPrompt,
					negative: EMOJI_NEGATIVE_PROMPT,
					seed: cellSeed,
					width: 768,
					height: 768,
					refImage: cellRefImage,
					denoise: cellRefImage ? 0.75 : 1.0,
					filenamePrefix: 'ComfyTV/emoji_cell',
				});
				// eslint-disable-next-line no-console
				console.warn(`[EmojiStage] cell #${i} 组装 model=${built.debug}`);
				return runStageWorkflow({
					runner,
					nodeId,
					snapshotKey,
					type,
					kind: spec?.comfyTV?.kind ?? 'emoji',
					workflowKind: spec?.comfyTV?.workflowKind ?? 'emoji',
					values: v,
					upstreams,
					store,
					onProgress: (p) => {
						const inner = typeof p.progress === 'number' ? p.progress : 0;
						onProgress?.({ progress: (n + inner) / targets.length });
					},
					signal,
					resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
					promptOverride: built.prompt,
					promptSaveNodeId: built.saveNodeId,
				}).catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					// eslint-disable-next-line no-console
					console.error(`[EmojiStage] cell #${i} 组装 threw: ${msg}`);
					return {
						promptId: '',
						status: 'error' as const,
						error: msg,
						entries: [] as MediaSnapshotEntry[],
					};
				});
			}
			return runStageWorkflow({
				runner,
				nodeId,
				snapshotKey,
				type,
				kind: spec?.comfyTV?.kind ?? 'emoji',
				workflowKind: spec?.comfyTV?.workflowKind ?? 'emoji',
				values: v,
				upstreams,
				store,
				onProgress: (p) => {
					const inner = typeof p.progress === 'number' ? p.progress : 0;
					onProgress?.({ progress: (n + inner) / targets.length });
				},
				signal,
				// 钉住资产的 ref 多为 http/data URL（非 Comfy /view），必须经
				// resolveImageRef 上传给 ComfyUI，否则 LoadImage 拿不到图。
				resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
				// ★ 尺寸注入（size widget）对所有单格模板生效；fallback 模板额外切 img2img
				promptPostProcess: composePostProcess(
					sizePostProcess,
					fallback === EMOJI_FALLBACK_LABEL ? patchFallbackToImg2Img : undefined,
				),
			}).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				// eslint-disable-next-line no-console
				console.error(`[EmojiStage] cell #${i} tryRunCell label="${label}" threw: ${msg}`);
				return {
					promptId: '',
					status: 'error' as const,
					error: msg,
					entries: [] as MediaSnapshotEntry[],
				};
			});
		};
		let r = await tryRunCell();
		// ★ 取消检查（关键修复）：当前格刚结束就立即响应 abort，避免在 fallback
		//   重试 / 下一格开始前才停。否则用户点「取消」后，正在跑的格仍会跑完，
		//   视觉上像「取消没反应」。注意不能依赖 tryRunCell 内部的 throwIfAborted——
		//   它的 .catch 会把 AbortError 吞成 status:'error'，abort 信号就丢了。
		if (signal?.aborted) {
			return { promptId: lastPromptId, status: 'canceled', error: '已取消', entries: collected };
		}
		// ★ 透明模板失败时记录诊断信息（fallback 触发原因 + 执行结果）
		if (r.status !== 'success') {
			// eslint-disable-next-line no-console
			console.warn(
				`[EmojiStage] cell #${i} primary template FAILED, falling back to "${EMOJI_FALLBACK_LABEL}". ` +
				`reason=${r.error ?? 'unknown'}`,
			);
		}
		// 首次执行失败 → 自动 fallback（仅一次，避免无限重试）
		if (r.status !== 'success') {
			r = await tryRunCell(EMOJI_FALLBACK_LABEL);
			// ★ 取消检查：fallback 跑完后同样立即响应 abort（不重跑、不进下一格）
			if (signal?.aborted) {
				return { promptId: lastPromptId, status: 'canceled', error: '已取消', entries: collected };
			}
		}
		// ★ 诊断：每格最终结果（成功用哪个 workflow 出的图）。
		// eslint-disable-next-line no-console
		console.log(
			`[EmojiStage] cell #${i} result status=${r.status} entries=${r.entries.length} ` +
			`error=${r.error ? truncateForLog(r.error, 120) : 'none'}`,
		);
		lastPromptId = r.promptId || lastPromptId;
		if (r.status !== 'success') {
			// ★ 透明模板常见失败原因 → LoRA 缺失 / ComfyUI_LayeredDiffusion 未装
			//   / sub_batch_size 不匹配。给一条诊断提示（console + error 文本），
			//   用户可直接对照查环境。
			const err = r.error ?? '未知错误';
			const isLayeredDiffusionIssue = /layer_xl_transparent|vae's transparent|decoder.*transparent|LoRA|lora/i.test(err);
			const hint = isLayeredDiffusionIssue
				? '。可能原因：① models/loras/ 下缺少 layer_xl_transparent_conv.safetensors；② ComfyUI_LayeredDiffusion 自定义节点未装/版本不匹配；③ 当前已自动 fallback 到「普通贴纸」，无透明通道'
				: '';
			// eslint-disable-next-line no-console
			console.error(`[EmojiStage] cell #${i} all attempts FAILED: ${err}${hint}`);
			return {
				promptId: lastPromptId,
				status: r.status === 'canceled' ? 'canceled' : 'error',
				error: `表情 #${i} 生成失败：${err}${hint}`,
				entries: collected,
			};
		}
		collected.push(...r.entries);

		// ★ 本格产物 = 执行前后 key 差集里的图（fallback 可能产出多张）。
		//   用 store 里的 entry（已被 materializeComfyImageRefs 物化成 data: URL），
		//   **不能**用 `r.entries` —— runStageWorkflow 返回的是物化**前**的副本，
		//   ref 还是 ComfyUI `/view` URL，重启后失效。
		//
		//   EmojiStage 每格同时产出两个槽：`images`（静态贴纸）+ `animated`（动画 webp）。
		//   之前用 `producedNow.at(-1)` 取最后一张，而 comfyOutputsToSnapshots 按
		//   Object.keys 顺序遍历 → at(-1) 永远是 `animated`。动画 webp 因
		//   isAnimatedWebpRef 跳过文字烘焙（Canvas 无法无损重编码带 alpha 的动画
		//   webp），导致「动态图与描述不一致」：描述只活在编辑器 preview 层的 CSS
		//   叠字里，图本体（尤其导出/分享时）拿不到文字。
		//
		//   修复：显式取动画图作为本格主产物（不再依赖顺序 at(-1)），并把配文 caption
		//   作为结构化 meta 写入动画图 —— 描述随动画图一起归档，导出/引用时跟着图走。
		// ★ 同时识别 image + video（MiniMax H3 视频走 video 分支）
		const producedNow = store.byNode(snapshotKey)
			.filter(e => (e.media.kind === 'image' || e.media.kind === 'video') && !keysBeforeCell.has(e.key));
		// 优先取动画产物作为本格主产物：webp（AnimateDiff 动态贴纸）或 video（MiniMax H3）。
		const primaryEntry = producedNow.find(e => isAnimatedWebpRef(e.media.ref) || e.media.kind === 'video')
			?? producedNow[producedNow.length - 1];
		const latest = primaryEntry?.media;
		if (!latest) {
			// 不该发生（status=success 却没新增产物）：记一条诊断，跳过该格避免用
			// 别的格子的图冒充本格产物（历史上正是这里错位造成「表情两两重复」）。
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] cell #${i} success but no new image/video entry — skip baking`);
		} else {
			let media: typeof latest = latest;
			// ★ 视频产物（MiniMax H3 动态表情 mp4）自动转 GIF（微信表情包格式）：
			//   GIF 作为本格主产物（网格显示 GIF，kind='image'），mp4 保留在 OUTPUT 历史。
			//   转 GIF 失败不致命：回退用 mp4（网格用 <video> 渲染）。
			if (latest.kind === 'video') {
				try {
					const fetchImpl = withRemoteProxyFetch(input.fetchImpl ?? globalThis.fetch);
					const gif = await convertVideoToGif(latest.ref, EMOJI_GIF_PARAMS, fetchImpl, (p) => onProgress?.({ progress: (n + (p.value ?? 0) / 100) / targets.length }));
					const gifDataUrl = await blobToDataUrl(gif.gifBlob);
					media = {
						...latest,
						kind: 'image',
						ref: gifDataUrl,
						meta: {
							...(latest.meta ?? {}),
							mime: 'image/gif',
							gifFrames: String(gif.frames),
							gifSize: `${gif.width}x${gif.height}`,
						},
					};
					// eslint-disable-next-line no-console
					console.warn(`[EmojiStage] cell #${i} video→gif done ${gif.width}x${gif.height} ${gif.frames}帧`);
				} catch (e) {
					// eslint-disable-next-line no-console
					console.warn(`[EmojiStage] cell #${i} video→gif failed, fallback to mp4: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			bakedByTarget.set(i, media);
		}
		onProgress?.({ progress: (n + 1) / targets.length });
	}

	// 收尾重排：把（烘焙后的）media 按格序写回 store，让归档 index == 格 index，
	// 与卡片 `cellRefs`（ownSnapshots 顺序）对齐。
	//
	// ★ port 必须是 `'output'` —— 与 `comfyOutputsToSnapshots` 写入的 port 一致。
	//   曾误写成 `'images'`，导致 store 里并存 `uid:output:*` 与 `uid:images:*`
	//   两组前缀、各自从 0 独立编号；`byNode` 按 index 排序后两组交错，
	//   前 total 项变成 [A, A', B, B', …]（A' = A 的烘焙副本，无配文时 ref 相同）
	//   → 表情**两两重复**，且真正的后几格图被挤出可见范围。
	const REPLAY_PORT = 'output';
	// eslint-disable-next-line no-console
	console.warn(`[EmojiStage] 收尾重排 scope=${scope} total=${total} bakedCount=${bakedByTarget.size}`);
	if (scope === 'all') {
		// ★ 整图归档（port 'sheet'，meta.sheetFull='1'）必须**原样保留**：
		//   它是 MiniImageEditor 的裁剪基底 + 卡片「LLM 原图」缩略图来源。
		//   此前 clearNode 把它连同旧格子产物一起清掉，重排只回写格子 →
		//   sheetFull 永远不存在：缩略图不显示、双击一律走「旧版产物」降级
		//   （编辑器 decoded 尺寸 = 单格图而非整图）、裁剪框功能全部失效。
		//   （日志佐证：clearNode before: 1 entries → replay done: store now=9）
		const preservedSheet = store.byNode(snapshotKey).filter(e => e.port === 'sheet');
		// eslint-disable-next-line no-console
		console.warn(`[EmojiStage] clearNode before: ${store.byNode(snapshotKey).length} entries (preserve sheet=${preservedSheet.length})`);
		store.clearNode(snapshotKey);
		let replayed = 0;
		for (let i = 0; i < total; i++) {
			const media = bakedByTarget.get(i);
			if (media) {
				// ★ meta 补 cellIndex：部分格生成失败时 ownOutputs 会**缺条目**、数组
				//   下标与格号错位 —— nodeCard 的单格编辑替换按 cellIndex 精确匹配，
				//   不能信下标。
				const mediaWithIdx: typeof media = { ...media, meta: { ...(media.meta ?? {}), cellIndex: i } };
				// skipImport=true：重放的是已入库资产，避免重复导入媒体库。
				store.put({ nodeId: snapshotKey, port: REPLAY_PORT, key: '', media: mediaWithIdx }, true);
				replayed++;
			}
		}
		// 整图归档放回（media 含 meta.sheetFull/rows/cols，原样保留）
		for (const e of preservedSheet) {
			store.put({ nodeId: snapshotKey, port: 'sheet', key: '', media: e.media }, true);
		}
		// eslint-disable-next-line no-console
		console.warn(`[EmojiStage] replay done: ${replayed}/${total} entries, sheet preserved=${preservedSheet.length}, store now=${store.byNode(snapshotKey).length}`);
	} else if (scope === 'cell') {
		// 单格模式：新图被追加到末尾，需挪回 selIdx 原位。
		// 用 before（本轮开始前的列表）打底再替换第 selIdx 项。
		//
		// ⚠ 已知限制：`store.put` 只能「顺序追加」分配 index，**无法表达空洞**。
		//   因此当 before 比 selIdx 短（例如从未「生成全部」就直接点某格的
		//   「生成此表情」），该格图只能落在紧邻已有图之后的 index，而非 selIdx。
		//   要真正修好需给 MediaSnapshotStore 加稀疏写入 API；当前保持顺序语义，
		//   正常流程（先生成全部再单格重生成）不受影响。
		const baked = bakedByTarget.get(selIdx);
		if (baked) {
			const arranged = [...before];
			const replaced = arranged[selIdx]; // 被替换的旧产物（历史保留）
			arranged[selIdx] = baked;   // 越界赋值 → 稀疏数组，下面 put 时跳过空洞
			store.clearNode(snapshotKey);
			// skipImport=true：重排搬运的是已入库资产，避免重复导入媒体库。
			for (const media of arranged) {
				if (media) { store.put({ nodeId: snapshotKey, port: REPLAY_PORT, key: '', media }, true); }
			}
			// ★ 历史保留：被替换的旧产物追加到末尾（用户要求「重新生成后历史表情
			//   不要删除，仍在 outputs 显示」）。网格 cellRefs 取前 total 个 = 每格
			//   最新；末尾多出的旧产物只在 OUTPUT 预览条展示，不影响网格对齐。
			if (replaced && replaced.ref !== baked.ref) {
				store.put({ nodeId: snapshotKey, port: REPLAY_PORT, key: '', media: replaced }, true);
			}
		}
	}

	// ★ 整轮结束：汇总结果（成功/取消/error）
	// ★ image 口（2026-09-02）：编辑器「调整拆分」（拖拽/缩放裁剪框 → cell_crops）
	//   烘焙后的各格，按 rows×cols 合并回一整张**透明底图集**。下游「转动态表情包」
	//   接此口（COMFYTV_IMAGE）即可整版动图 → 逐格拆分；images 口仍输出独立表情。
	try {
		const cellRefs: string[] = [];
		for (let i = 0; i < total; i++) {
			const m = bakedByTarget.get(i);
			if (m && m.kind === 'image') { cellRefs.push(m.ref); }
		}
		if (cellRefs.length > 0) {
			onProgress?.({ progress: 97 });
			const sheetDataUrl = await composeImageGridOnChroma(cellRefs, rows, cols, 0, null, fetchImpl);
			const entry: MediaSnapshotEntry = {
				nodeId: snapshotKey,
				port: 'image',
				key: `${snapshotKey}:image:0`,
				media: {
					kind: 'image',
					ref: sheetDataUrl,
					meta: { mime: 'image/png', sheet: META_SHEET_FLAG, ...sheetDimsMeta(rows, cols), margin: '0' },
				},
				index: 0,
			};
			store.put(entry, true /* skipImport */);
			collected.push(entry);
		}
	} catch (e) {
		// eslint-disable-next-line no-console
		console.warn(`[EmojiStage] image 口图集拼合失败（不影响 images 口）: ${e instanceof Error ? e.message : String(e)}`);
	}

	// eslint-disable-next-line no-console
	console.log(
		`[EmojiStage] run done collected=${collected.length}/${targets.length} ` +
		`baked=${bakedByTarget.size}/${total} promptId=${lastPromptId || '(none)'}`,
	);
	return { promptId: lastPromptId, status: 'success', entries: collected };
}

/**
 * 「转动态表情包」（Saros.AnimatedEmoji）—— provider 后端动态表情执行器。
 *
 * 与 ComfyTV.DynEmojiStage 的本质差异：视频生成不绑定 ComfyUI + MiniMax H3
 * 绿幕工作流，而是走 `videogen.generate` RPC（provider/model 由用户选择），
 * 纯 provider 后端、无需 ComfyUI runner 在线。
 *
 * 链路：
 *   1. 取上游参考图（透明贴纸 PNG，① 显式 imageInput → ② 上游 IMAGE 快照）；
 *   2. 前端把参考图合成到纯绿幕底（provider 不吃 alpha，透明区会被模型按
 *      黑/白填充不可控；主动绿底 = 抠像可控性最强的先验）；
 *   3. videogen.generate（prompt 追加绿幕强约束，1:1、768P、duration 档位）；
 *   4. 绿幕 mp4 归档（port 'video'，诊断用——抠像质量问题可回看原视频）；
 *   5. convertVideoToGridTransparentGifs：chroma-key 抠像 + 透明 GIF 编码 +
 *      ≤max_kb 压缩迭代；grid_rows×grid_cols>1 时整图动图逐帧切格（1×1 退化单图），
 *      全部格共用同一压缩档位（微信表情规范 240×240 ≤500KB 循环）；
 *   6. GIF 归档（port 'output'，kind='image' —— GIF 是图片格式，<img> 播放）。
 */
