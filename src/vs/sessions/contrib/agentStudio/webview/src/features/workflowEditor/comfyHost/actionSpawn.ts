/*---------------------------------------------------------------------------------------------
 *  actionSpawn — ComfyTV action → create node + connect, ported to the Saros store model.
 *
 *  Faithful port of ComfyTV's follow-up stage spawning:
 *    - `stageActions.ts`   → ACTIONS_BY_KIND (per-kind action list, id + icon + presets)
 *    - `imagePresets.ts`   → IMAGE_VARIANT_PRESETS (preset:* targets)
 *    - `imageEditPresets.ts`→ IMAGE_EDIT_PRESETS (edit:* targets)
 *    - `spawnFollowUp.ts`  → SPAWN_HANDLERS (actionId → spawn handler)
 *
 *  Unlike ComfyTV (which mutates `app.graph` + `LiteGraph.createNode` directly), this
 *  module drives the framework-agnostic Zustand store — `store.addNode` + `store.setEdges`
 *  — because the store is the single source of truth and the LiteGraph canvas is a
 *  two-way-synced view. The diff effect ([nodes, edges]) then pushes the new node/edge
 *  into the graph.
 *
 *  Port-name mapping: ComfyTV addresses sockets by name (`image` / `batch` / `panorama`),
 *  but our fallback schema stages use a generic `input`/`output` port (except the picker
 *  family, which has a precise `batch` input). `targetInputPort` / `sourceOutputPort`
 *  resolve the *actual* registered port name at spawn time, so links stay correct even
 *  when the live runner refines the spec.
 *--------------------------------------------------------------------------------------------*/

import { useWorkflowEditorStore, pauseTracking, resumeTracking } from '../store';
import { getNodeSpec } from './registry';

// ─── Preset model (mirrors ComfyTV ImagePreset) ─────────────────────────────

export interface ImagePreset {
	id: string;
	icon: string;
	/** Human-readable display name (shown in the ACTIONS submenu). */
	label: string;
	category: 'imageVariant' | 'imageEdit' | 'videoChange';
	targetClass?: string;
	/** ComfyTV socket name on the target (e.g. "image" / "batch" / "panorama"). */
	inputSocket?: string;
	/** Widget values stamped onto the new node (workflow / variant_count / main_prompt). */
	widgets?: Record<string, unknown>;
	multiTargetClasses?: string[];
}

export interface StageAction {
	id: string;
	icon: string;
	label: string;
	presets?: ImagePreset[];
}

// ─── Presets (faithful to ComfyTV imageEditPresets.ts / imagePresets.ts) ────

const IMAGE_EDIT_PRESETS: ImagePreset[] = [
	{ id: 'hd',         icon: '✦', label: 'HD',            category: 'imageEdit', targetClass: 'ComfyTV.UpscaleStage',  inputSocket: 'image' },
	{ id: 'outpaint',   icon: '⤢', label: 'Outpaint',      category: 'imageEdit', targetClass: 'ComfyTV.OutpaintStage', inputSocket: 'image' },
	{ id: 'inpaint',    icon: '✎', label: 'Inpaint',       category: 'imageEdit', targetClass: 'ComfyTV.InpaintStage',  inputSocket: 'image' },
	{ id: 'erase',      icon: '⌫', label: 'Erase',         category: 'imageEdit', targetClass: 'ComfyTV.EraseStage',    inputSocket: 'image' },
	{ id: 'cutout',     icon: '✂', label: 'Cutout',        category: 'imageEdit', targetClass: 'ComfyTV.CutoutStage',   inputSocket: 'image' },
	{ id: 'crop',       icon: '⤡', label: 'Crop',          category: 'imageEdit', targetClass: 'ComfyTV.CropStage',     inputSocket: 'image' },
	{ id: 'rotate',     icon: '↻', label: 'Rotate',        category: 'imageEdit', targetClass: 'ComfyTV.RotateStage',   inputSocket: 'image' },
	{ id: 'mirror',     icon: '⇋', label: 'Mirror',        category: 'imageEdit', targetClass: 'ComfyTV.MirrorStage',   inputSocket: 'image' },
	{ id: 'colorGrade', icon: '◐', label: 'Color Grade',   category: 'imageEdit', targetClass: 'ComfyTV.ColorGradeStage', inputSocket: 'image' },
	{ id: 'grid',       icon: '▦', label: 'Grid Split',    category: 'imageEdit', targetClass: 'ComfyTV.GridSplitStage', inputSocket: 'image' },
	{ id: 'ken-burns',  icon: '◈', label: 'Ken Burns',     category: 'imageEdit', targetClass: 'ComfyTV.KenBurnsStage',  inputSocket: 'image' },
];

const IMAGE_VARIANT_PRESETS: ImagePreset[] = [
	{ id: 'face-3view',      icon: '👤', label: 'Face 3-view',          category: 'imageVariant', targetClass: 'ComfyTV.ImageVariationsStage', inputSocket: 'image',
		widgets: { workflow: 'Face 3-View',      variant_count: 3 } },
	{ id: 'product-3view',   icon: '▣', label: 'Product 3-view',       category: 'imageVariant', targetClass: 'ComfyTV.ImageVariationsStage', inputSocket: 'image',
		widgets: { workflow: 'Product 3-View',   variant_count: 3 } },
	{ id: 'character-3view', icon: '🪪', label: 'Character 3-view',     category: 'imageVariant', targetClass: 'ComfyTV.ImageVariationsStage', inputSocket: 'image',
		widgets: { workflow: 'Character 3-View', variant_count: 3 } },
	{ id: 'multi-cam-9',     icon: '🎬', label: 'Multi-cam 9-grid',     category: 'imageVariant', targetClass: 'ComfyTV.ImageVariationsStage', inputSocket: 'image',
		widgets: { workflow: 'Multi-cam 9',      variant_count: 9 } },
	{ id: 'story-4',         icon: '📖', label: 'Story Progression',    category: 'imageVariant', targetClass: 'ComfyTV.ImageVariationsStage', inputSocket: 'image',
		widgets: { workflow: 'Story 4',          variant_count: 4 } },
	{ id: 'storyboard-25',   icon: '🗂', label: '25-grid Storyboard',   category: 'imageVariant', targetClass: 'ComfyTV.ImageVariationsStage', inputSocket: 'image',
		widgets: { workflow: 'Storyboard 25',    variant_count: 25 } },
	{ id: 'cinematic-light', icon: '💡', label: 'Cinematic Lighting',   category: 'imageVariant', targetClass: 'ComfyTV.ImageEditStage', inputSocket: 'image',
		widgets: { main_prompt: 'cinematic key light, dramatic mood, color graded look; relight the image, preserving identity, geometry, and details' } },
	{ id: 'frame-3s',        icon: '⏱', label: 'Project +3s',          category: 'imageVariant', targetClass: 'ComfyTV.ImageEditStage', inputSocket: 'image',
		widgets: { main_prompt: 'show the scene 3 seconds later, preserving character, environment, and style; continue the action naturally' } },
	{ id: 'frame-5s',        icon: '⏱', label: 'Project +5s',          category: 'imageVariant', targetClass: 'ComfyTV.ImageEditStage', inputSocket: 'image',
		widgets: { main_prompt: 'show the scene 5 seconds later, preserving character, environment, and style; continue the action naturally' } },
];

// ─── Actions per kind (faithful to ComfyTV stageActions.ts) ─────────────────

// ComfyTV videoChangePresets.ts 的本项目子集：仅保留 comfyTVStageMeta.generated.ts
// 已注册的 video 处理 stage。inputSocket 用 'input'（本项目的批量注册 stage 统一
// 用 'input' 端口，而 ComfyTV 用 'video'/'video_a' 等语义名）。
const VIDEO_CHANGE_PRESETS: ImagePreset[] = [
	{ id: 'clip',          icon: '✂', label: 'Clip',           category: 'videoChange', targetClass: 'ComfyTV.VideoClipStage',       inputSocket: 'input' },
	{ id: 'split',         icon: '⏸', label: 'Split',          category: 'videoChange', targetClass: 'ComfyTV.VideoSplitStage',      inputSocket: 'input' },
	{ id: 'speed',         icon: '⏩', label: 'Speed',          category: 'videoChange', targetClass: 'ComfyTV.VideoSpeedStage',      inputSocket: 'input' },
	{ id: 'rotate',        icon: '↻', label: 'Rotate',         category: 'videoChange', targetClass: 'ComfyTV.VideoRotateStage',     inputSocket: 'input' },
	{ id: 'crop',          icon: '⤡', label: 'Crop',           category: 'videoChange', targetClass: 'ComfyTV.VideoCropStage',       inputSocket: 'input' },
	{ id: 'resize',        icon: '⇱', label: 'Resize',         category: 'videoChange', targetClass: 'ComfyTV.VideoResizeStage',     inputSocket: 'input' },
	{ id: 'volume',        icon: '🔊', label: 'Volume',         category: 'videoChange', targetClass: 'ComfyTV.VideoVolumeStage',    inputSocket: 'input' },
	{ id: 'mux-audio',     icon: '🎧', label: 'Mux Audio',      category: 'videoChange', targetClass: 'ComfyTV.VideoMuxAudioStage',  inputSocket: 'input' },
	{ id: 'concat',        icon: '🔗', label: 'Concat',         category: 'videoChange', targetClass: 'ComfyTV.VideoConcatStage',    inputSocket: 'input' },
	{ id: 'extract-frame', icon: '🖼', label: 'Extract Frame',   category: 'videoChange', targetClass: 'ComfyTV.VideoExtractFrameStage', inputSocket: 'input' },
	{ id: 'frames',        icon: '🖼', label: 'Frames',         category: 'videoChange', targetClass: 'ComfyTV.VideoFramesStage',    inputSocket: 'input' },
	{ id: 'color',         icon: '◐', label: 'Color',          category: 'videoChange', targetClass: 'ComfyTV.VideoColorStage',      inputSocket: 'input' },
	{ id: 'curves',        icon: '∿', label: 'Curves',         category: 'videoChange', targetClass: 'ComfyTV.VideoCurvesStage',     inputSocket: 'input' },
	{ id: 'lut',           icon: '◑', label: 'LUT',            category: 'videoChange', targetClass: 'ComfyTV.VideoLUTStage',        inputSocket: 'input' },
	{ id: 'blur-sharpen',  icon: '◌', label: 'Blur/Sharpen',   category: 'videoChange', targetClass: 'ComfyTV.VideoBlurSharpenStage', inputSocket: 'input' },
	{ id: 'denoise',       icon: '⌫', label: 'Denoise',        category: 'videoChange', targetClass: 'ComfyTV.VideoDenoiseStage',    inputSocket: 'input' },
	{ id: 'chroma-key',    icon: '◈', label: 'Chroma Key',     category: 'videoChange', targetClass: 'ComfyTV.VideoChromaKeyStage',  inputSocket: 'input' },
	{ id: 'transition',    icon: '⇄', label: 'Transition',     category: 'videoChange', targetClass: 'ComfyTV.VideoTransitionStage', inputSocket: 'input' },
	{ id: 'stabilize',     icon: '≋', label: 'Stabilize',      category: 'videoChange', targetClass: 'ComfyTV.VideoStabilizeStage',  inputSocket: 'input' },
	{ id: 'interpolate',   icon: '⏩', label: 'Interpolate',    category: 'videoChange', targetClass: 'ComfyTV.VideoInterpolateStage', inputSocket: 'input' },
	{ id: 'stylize',       icon: '✦', label: 'Stylize',        category: 'videoChange', targetClass: 'ComfyTV.VideoStylizeStage',    inputSocket: 'input' },
	{ id: 'scopes',        icon: '▤', label: 'Scopes',         category: 'videoChange', targetClass: 'ComfyTV.VideoScopesStage',     inputSocket: 'input' },
	{ id: 'transform',     icon: '⤢', label: 'Transform',      category: 'videoChange', targetClass: 'ComfyTV.VideoTransformStage',  inputSocket: 'input' },
	{ id: 'composite',     icon: '⧉', label: 'Composite',      category: 'videoChange', targetClass: 'ComfyTV.VideoCompositeStage',  inputSocket: 'input' },
];

const imageActions: StageAction[] = [
	{ id: 'edit',       icon: '✎', label: 'Edit Image',  presets: IMAGE_EDIT_PRESETS },
	{ id: 'panorama',   icon: '◐', label: 'Panorama' },
	{ id: 'multiangle', icon: '◳', label: 'Multi-angle' },
	{ id: 'relight',    icon: '☀', label: 'Relight' },
	{ id: 'material',   icon: '◆', label: 'Material' },
	{ id: 'preset',     icon: '▦', label: 'Presets',     presets: IMAGE_VARIANT_PRESETS },
];

export const ACTIONS_BY_KIND: Record<string, StageAction[]> = {
	text: [{ id: 'refine', icon: '✎', label: '精修' }],
	image: imageActions,
	'image-picker': imageActions,
	'image-batch': imageActions,
	video: [
		{ id: 'extend', icon: '→', label: '延展' },
		{ id: 'change', icon: '✎', label: '变换', presets: VIDEO_CHANGE_PRESETS },
	],
	// audio 家族（speech-to-speech / t2s / music 等）：actionKeyFor 对含
	// 'audio'/'music'/'speech' 的 stageKind 归一化成 'audio'（见下），
	// 这里必须存在对应键 —— 否则 ACTIONS_BY_KIND['audio'] 为 undefined，
	// audio 节点的 ACTIONS 区块（及 card 的 actions gate）整体消失。
	// ComfyTV 原生无 audio 键，本项目补齐为「精修」单个动作（语义对齐 text 的 refine）。
	audio: [
		{ id: 'refine', icon: '✎', label: '精修' },
	],
	panorama: [
		{ id: 'view-current', icon: '◉', label: '当前视图' },
		{ id: 'view-four',    icon: '▤', label: '四视图' },
		{ id: 'view-twelve',  icon: '▦', label: '十二视图' },
	],
	storyboard: [{ id: 'gen-shots', icon: '🎬', label: '生成镜头' }],
	model: [{ id: 'product-shot', icon: '📷', label: '产品图' }],
};

/** Normalize a stageKind (or node type) to an ACTIONS_BY_KIND key. */
export function actionKeyFor(kindOrType: string | undefined): string | undefined {
	if (!kindOrType) { return undefined; }
	if (kindOrType in ACTIONS_BY_KIND) { return kindOrType; }
	const k = kindOrType.toLowerCase();
	if (k.includes('image') || k.startsWith('i2i') || k.startsWith('t2i') || k === 't2v' || k === 'i2v') {
		return k.includes('batch') || k.includes('picker') ? (k.includes('picker') ? 'image-picker' : 'image-batch') : 'image';
	}
	if (k.includes('video') || k.startsWith('v2v')) { return 'video'; }
	if (k.includes('audio') || k.includes('music') || k.includes('speech')) { return 'audio'; }
	return undefined;
}

// ─── Spawn core (store-driven; faithful to ComfyTV spawnFollowUp.ts) ────────

/** Resolve the *actual* registered input port name for a target class. */
function targetInputPort(targetClass: string, preferred?: string): string {
	const spec = getNodeSpec(targetClass);
	if (preferred && spec?.inputs?.some(p => p.name === preferred)) { return preferred; }
	return spec?.inputs?.[0]?.name ?? 'input';
}

/** Resolve the *actual* registered output port name for a source class. */
function sourceOutputPort(srcClass: string, srcSlot: number): string {
	const spec = getNodeSpec(srcClass);
	return spec?.outputs?.[srcSlot]?.name ?? 'output';
}

/** Node position right of the source node (ComfyTV posRightOf: + width + 60). */
function posRightOf(srcId: string): { x: number; y: number } {
	const state = useWorkflowEditorStore.getState();
	const src = state.nodes.find(n => n.id === srcId);
	const w = src?.style?.width ?? 280;
	return { x: (src?.position.x ?? 0) + w + 60, y: src?.position.y ?? 0 };
}

/** Create a node of `type`, stamp its widgets, connect src → node, return new id. */
function spawnConsumingNode(
	srcId: string,
	srcType: string,
	targetClass: string,
	inputSocket?: string,
	srcSlot = 0,
	widgets?: Record<string, unknown>,
): string | null {
	const state = useWorkflowEditorStore.getState();
	const srcNode = state.nodes.find(n => n.id === srcId);
	if (!srcNode) { return null; }

	const pos = posRightOf(srcId);
	const newId = state.addNode(targetClass, pos);
	if (widgets && Object.keys(widgets).length > 0) {
		state.updateNodeData(newId, widgets);
	}

	// 目标节点无 input 端口（browser-local 独立编辑器，如 RelightStage /
	// MaterialStage / StoryboardStage，inputs=[]）时跳过连线——对齐 ComfyTV
	// spawnConsumingNode 的 `findNamedSlot slot<0 → return newNode`（节点已创建
	// 但不连）。否则 targetInputPort 会回退到假端口 'input'，产生指向不存在
	// 端口的 broken edge。
	const tgtSpec = getNodeSpec(targetClass);
	if (!tgtSpec?.inputs?.length) {
		return newId;
	}

	const srcPort = sourceOutputPort(srcType, srcSlot);
	const dstPort = targetInputPort(targetClass, inputSocket);
	const edge = {
		id: `e-${srcId}-${newId}`,
		source: srcId,
		target: newId,
		sourceHandle: srcPort,
		targetHandle: dstPort,
		type: 'default',
	};
	// 诊断：记录 spawnConsumingNode 创建的边（含端口名）
	// eslint-disable-next-line no-console
	console.warn('[spawnConsumingNode] EDGE created:', JSON.stringify({
		source: edge.source, sourceHandle: edge.sourceHandle,
		target: edge.target, targetHandle: edge.targetHandle,
	}), 'srcType=', srcType, 'inputSocket=', inputSocket, 'srcSlot=', srcSlot);
	pauseTracking();
	try {
		state.setEdges([...useWorkflowEditorStore.getState().edges, edge]);
	} finally {
		resumeTracking();
	}
	return newId;
}

// ─── 媒体库资产拖入画布 → 创建 Asset Loader 节点（对齐 ComfyTV
//     createAssetLoaderNode + LOADER_CLASS_BY_MEDIA）──────────────────────────

/** HTML5 drag MIME：媒体库资产卡片拖拽时写入 dataTransfer 的标识。 */
export const ASSET_DRAG_MIME = 'application/x-saros-asset';

/** media kind → loader 节点类型（ComfyTV LOADER_CLASS_BY_MEDIA 的等价物；本项目
 *  Asset*LoaderStage 未注册，落到已注册的基础 LoaderStage，靠 mediaAssetId 注入）。 */
function assetLoaderClass(kind: string): string | null {
	switch (kind) {
		case 'video': return 'ComfyTV.VideoLoaderStage';
		case 'audio': return 'ComfyTV.AudioLoaderStage';
		case 'image': return 'ComfyTV.ImageLoaderStage';
		default: return null;
	}
}

/**
 * 拖媒体库资产到画布：在给定位置创建对应 Loader 节点并注入 mediaAssetId。
 * 节点运行（runLoaderNode）时读 mediaAssetId → resolve 资产 URL → 产出快照。
 * 对齐 ComfyTV handleAssetDrop → createAssetLoaderNode(asset, pos)。
 */
export function spawnAssetLoader(assetId: string, kind: string, pos: { x: number; y: number }): string | null {
	const loaderClass = assetLoaderClass(kind);
	if (!loaderClass) { return null; }
	const state = useWorkflowEditorStore.getState();
	const newId = state.addNode(loaderClass, pos);
	if (newId) {
		state.updateNodeData(newId, { mediaAssetId: assetId });
	}
	return newId;
}

// ─── Handlers (faithful to ComfyTV SPAWN_HANDLERS) ──────────────────────────

function spawnRelightPair(srcId: string, srcType: string, srcSlot: number): void {
	/* Step 1: 创建 RelightStage（在源节点右侧） */
	const relightId = spawnConsumingNode(srcId, srcType, 'ComfyTV.RelightStage', 'image', srcSlot);
	if (!relightId) return;

	/* Step 2: 创建下游 ImageStage（在 relight 右侧，用于接收打光结果）。
	 * 对齐 ComfyTV 截图：新 ImageStage 有额外输入 pin 接收 light_render。 */
	const state = useWorkflowEditorStore.getState();
	const relightNode = state.nodes.find(n => n.id === relightId);
	const srcNode = state.nodes.find(n => n.id === srcId);
	const dstX = (relightNode?.position.x ?? (srcNode?.position.x ?? 0) + 340) + 340;
	const dstY = relightNode?.position.y ?? srcNode?.position.y ?? 0;

	pauseTracking();
	try {
		const dstId = state.addNode({
			type: 'ComfyTV.ImageStage',
			position: { x: dstX, y: dstY },
			data: { _spawnedBy: 'relight-pair' },
		});
		if (!dstId) return;

		/* Step 3: 连线 relight.light_render → dst（动态添加输入 pin） */
		// 为下游节点添加额外 image 输入 pin
		state.updateNodeData(dstId, (prev) => {
			const extraPins = (prev?._extraInputPins as number) ?? 0;
			return { ...prev, _extraInputPins: extraPins + 1 };
		});

		// 连线：relight → dst
		state.setEdges([...state.edges, {
			source: relightId,
			sourceHandle: 'light_render',
			target: dstId,
			targetHandle: `image${(state.nodes.find(n => n.id === dstId)?.data?._extraInputPins ?? 1)}`,
			type: 'default',
		}]);
	} finally {
		resumeTracking();
	}
}

function spawnPanoramaView(srcId: string, srcType: string, mode: 'current' | 'four' | 'twelve'): void {
	if (mode === 'current') {
		spawnConsumingNode(srcId, srcType, 'ComfyTV.PanoramaCurrentViewStage', 'panorama');
		return;
	}
	const nodeId = spawnConsumingNode(srcId, srcType, 'ComfyTV.PanoramaMultiViewStage', 'panorama');
	if (!nodeId) { return; }
	useWorkflowEditorStore.getState().updateNodeData(nodeId, { view_count: mode === 'four' ? 4 : 12 });
}

type SpawnHandler = (srcId: string, srcType: string, srcSlot: number) => void;

function makeImageHandlers(srcSlot: number): Record<string, SpawnHandler> {
	return {
		'panorama':   (id, t) => spawnConsumingNode(id, t, 'ComfyTV.PanoramaStage',   'input', srcSlot),
		'multiangle': (id, t) => spawnConsumingNode(id, t, 'ComfyTV.MultiangleStage', 'input', srcSlot),
		'relight':    (id, t) => spawnRelightPair(id, t, srcSlot),
		'material':   (id, t) => spawnConsumingNode(id, t, 'ComfyTV.MaterialStage',   'input', srcSlot),
		...Object.fromEntries(IMAGE_VARIANT_PRESETS.map(p => [
			`preset:${p.id}`,
			(id: string, t: string) => spawnConsumingNode(id, t, p.targetClass ?? 'ComfyTV.ImageStage', p.inputSocket, srcSlot, p.widgets),
		])),
		...Object.fromEntries(IMAGE_EDIT_PRESETS.map(p => [
			`edit:${p.id}`,
			(id: string, t: string) => spawnConsumingNode(id, t, p.targetClass ?? 'ComfyTV.ImageStage', p.inputSocket, srcSlot, p.widgets),
		])),
	};
}

const imageHandlers = makeImageHandlers(0);
const imageBatchHandlers = makeImageHandlers(1);

const PRODUCT_SHOT_WIDGETS: Record<string, unknown> = {
	workflow: 'Qwen Edit 2511',
	main_prompt: "Turn this 3D viewport render into a professional product photograph on a clean light-gray studio backdrop with soft diffused lighting and a subtle ground reflection. Keep the subject's colors, materials and pose exactly as they are.",
};

const SPAWN_HANDLERS: Partial<Record<string, Record<string, SpawnHandler>>> = {
	text: {
		'refine': (id, t) => spawnConsumingNode(id, t, 'ComfyTV.TextStage', 'texts'),
	},
	image: imageHandlers,
	'image-picker': imageHandlers,
	'image-batch': imageBatchHandlers,
	model: {
		'product-shot': (id, t) => spawnConsumingNode(id, t, 'ComfyTV.ImageEditStage', 'image', 1, PRODUCT_SHOT_WIDGETS),
	},
	video: {
		'extend': (id, t) => {
			// ComfyTV: VideoExtractFrameStage ← src, then VideoStage ← extract.
			const extractId = spawnConsumingNode(id, t, 'ComfyTV.VideoExtractFrameStage', 'input');
			if (extractId) { spawnConsumingNode(extractId, 'ComfyTV.VideoExtractFrameStage', 'ComfyTV.VideoStage', 'images'); }
		},
		...Object.fromEntries(VIDEO_CHANGE_PRESETS.map(p => [
			`change:${p.id}`,
			(id: string, t: string) => spawnConsumingNode(id, t, p.targetClass ?? 'ComfyTV.VideoStage', p.inputSocket),
		])),
	},
	storyboard: {
		// ComfyTV 走 fallback（STAGE_CLASS_BY_KIND.storyboard → StoryboardStage + texts）。
		// 本项目无 StoryboardStage schema 节点，只有 native 的 StoryboardEditorStage
		// （browser-local 分镜画板编辑器，inputs=[]）——spawn 不连线（对齐 ComfyTV
		// findNamedSlot slot<0 → 只创建不连）。
		'gen-shots': (id, t) => spawnConsumingNode(id, t, 'ComfyTV.StoryboardEditorStage', 'texts'),
	},
	panorama: {
		'view-current': (id, t) => spawnPanoramaView(id, t, 'current'),
		'view-four':    (id, t) => spawnPanoramaView(id, t, 'four'),
		'view-twelve':  (id, t) => spawnPanoramaView(id, t, 'twelve'),
	},
};

// ─── Public entry points ────────────────────────────────────────────────────

/** Dispatch a ComfyTV action for a source node (action item click / preset pick). */
export function spawnFollowUp(srcNodeId: string, actionId: string): void {
	const state = useWorkflowEditorStore.getState();
	const srcNode = state.nodes.find(n => n.id === srcNodeId);
	if (!srcNode) { return; }
	const srcType = srcNode.type;
	const spec = getNodeSpec(srcType);
	const kind = spec?.comfyTV?.stageKind ?? spec?.kind;
	const key = actionKeyFor(kind ?? srcType);
	const handler = key ? SPAWN_HANDLERS[key]?.[actionId] : undefined;
	if (handler) {
		handler(srcNodeId, srcType, key === 'image-batch' ? 1 : 0);
	}
}

/**
 * ComfyTV auto-picker: 点运行 ImageStage（VideoStage）时**始终确保**
 * 对应 ImagePickerStage（VideoPickerStage）存在并连上 src → picker.batch，
 * 而不是仅在无下游时 spawn。原因：用户需求是「点生成后自动创建 picker 并
 * 自动连线」，旧版「connected=true 时跳过」导致先手动连过任何下游后 picker
 * 永远不被自动 spawn，与上游 ComfyUI 行为不符。
 *
 * 算法：
 *   1) 查下游是否已连到 pickerStage 类（target.type 匹配）→ 是则复用，不重复 spawn
 *   2) 否则 spawn 一个新 picker 并连 src 正确的图像输出 → picker.batch
 *
 * ⚠ 关键：ImageStage 的 outputs 定义为 [{name:'texts',...}, {name:'images',...}]，
 * ImageStage 输出端口：slot 0 = images(COMFYTV_IMAGES)、slot 1 = image(COMFYTV_IMAGE)。
 * picker 的 batch 输入为 COMFYTV_IMAGES，故必须显式传 srcSlot=0 连接 images 输出
 * （slot1 的 COMFYTV_IMAGE 与 batch 类型不匹配，会被 LiteGraph 类型检查拒绝，
 * 导致连线不可见且 picker 取不到上游图像）。
 *
 * Faithful to useStageNode.onRunRequest (ComfyTV) — invoked before execution.
 */
export function spawnPickerForStage(srcNodeId: string, srcType: string): void {
	const state = useWorkflowEditorStore.getState();
	const srcNode = state.nodes.find(n => n.id === srcNodeId);
	if (!srcNode) {
		// eslint-disable-next-line no-console
		console.warn('[spawnPickerForStage] src node not found in store: ' + srcNodeId);
		return;
	}

	// ★ EmojiStage 与 ImageStage 同路径：表情包输出的 images 批次（slot 0，
	//   COMFYTV_IMAGES）接到 ImagePickerStage.batch，让 picker 立即显示 m×n 缩略图。
	//   此前 EmojiStage 不在映射里 → 点运行后 auto-picker 落空（日志
	//   「no picker class for srcType=ComfyTV.EmojiStage」），用户只能手动拖 picker
	//   连线，而手动连线又受端口类型 / 保存链路影响容易失效 → picker 空。
	const pickerClass = (srcType === 'ComfyTV.ImageStage' || srcType === 'ComfyTV.EmojiStage')
		? 'ComfyTV.ImagePickerStage'
		: srcType === 'ComfyTV.VideoStage' ? 'ComfyTV.VideoPickerStage'
			: undefined;
	if (!pickerClass) {
		// eslint-disable-next-line no-console
		console.warn('[spawnPickerForStage] no picker class for srcType=' + srcType);
		return;
	}

	// 已存在 src → picker 的连线：复用（避免重复 spawn）。
	const alreadyConnected = state.edges.some(e => {
		if (e.source !== srcNodeId) { return false; }
		const target = state.nodes.find(n => n.id === e.target);
		return target?.type === pickerClass;
	});
	if (alreadyConnected) {
		// eslint-disable-next-line no-console
		console.warn('[spawnPickerForStage] picker already connected, reuse: ' + srcNodeId);
		return;
	}

	// ImageStage / EmojiStage 输出端口：slot 0 = images(COMFYTV_IMAGES)、slot 1 =
	// image(COMFYTV_IMAGE)。picker 的 batch 输入类型为 COMFYTV_IMAGES，故必须连
	// slot0(images) 才能类型匹配（slot1 的 COMFYTV_IMAGE 与 batch 不匹配，会被
	// LiteGraph 类型检查拒绝，导致连线不可见且 picker 经图遍历取不到上游图像）。
	// 注意：上面「slot 0 = texts」是 INPUTS 布局，OUTPUTS 布局为 slot0=images。
	const imageOutputSlot = 0;
	const newId = spawnConsumingNode(srcNodeId, srcType, pickerClass, 'batch', imageOutputSlot);
	// eslint-disable-next-line no-console
	console.warn('[spawnPickerForStage] created ' + pickerClass + ' id=' + newId + ' from ' + srcNodeId + ' srcSlot=' + imageOutputSlot);
}
