/*---------------------------------------------------------------------------------------------
 *  LiteGraph Node Registry — three-tier node registration.
 *
 *  Keeps all LiteGraph interaction behind a small facade so tests can run without
 *  touching the real @comfyorg/litegraph singleton, and so the webview never calls
 *  `LiteGraph.registerNodeType` directly.
 *
 *  Node kinds:
 *   - 'react'  : existing Saros.* nodes, cards rendered as React components
 *                (React is preserved; no Vue bridge).
 *   - 'schema' : ComfyTV-style stages. Only the registration info (kind/inputs/outputs)
 *                is consumed; the card is rendered by a React component driven by that schema.
 *   - 'native' : ComfyUI native nodes, dynamically registered from /object_info.
 *
 *  Port type vocabulary (mirrors LiteGraph link `type`):
 *   'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT' | 'SAROS_JSON' | 'ANY'
 *--------------------------------------------------------------------------------------------*/
import {
	registerNodeSpec,
	SAROS_NODE_COLORS,
	workflowOptionsFor,
	WEIXIN_EXPORT_TARGETS,
	COMFYTV_RESOLUTIONS,
	COMFYTV_ASPECT_RATIOS,
	COMFYTV_IMAGE_WORKFLOWS,
	type PortSpec,
	type NodeSpec,
	type PortType,
	type NodeKind,
} from './registry.js';
import { INSTANT_WIDGETS } from './instantNodes.js';
import { registerSchemaLiteGraphNode } from './schemaLiteGraphNodes.js';
import { COMFYTV_STAGE_META } from './comfyTVStageMeta.generated.js';
import { COMFYTV_FX_FIELDS } from './comfyTVFxFields.generated.js';
import { listBuiltinLabels } from './builtinWorkflows/index.js';
import { EMOJI_SHEET_SIZES, EMOJI_SHEET_SIZE_DEFAULT } from './builtinWorkflows/emojiWorkflows.js';
import { isFxBuildNode } from './fxChain.js';
import { registry, normalizeStageVariant } from './registry.js';

/**
 * ComfyTV schema/native 节点（图像/视频/音频 stage + meta.py 补端口 + 打光/海报/图层/导演台/材质/3D/多宫格）。
 * 拆自 registry.ts（2026-09-07）：注册副作用封装在函数内，由 registry.ts 在核心
 * 初始化完成后显式调用（规避 ESM 循环 import 的 TDZ/时序问题）。
 */
export function registerComfyStageNodes(): void {
	// -- ComfyTV schema/native 节点（图像/视频/音频 stage + meta.py 补端口 + 打光/海报/图层/导演台/材质/3D/多宫格） --
	// （registerComfyUINativeNode 的注册尾段已回迁 registrySaros.ts 宿主函数内。）
}

/**
 * Register the built-in ComfyTV stage presets.
 * 本项目**完全不依赖 ComfyTV 后端 API**：节点定义来自静态内置的
 * comfyTVStageMeta.generated.ts（171 个 stage，无需 /comfytv/stages）。
 * 这些预设保证 ComfyTV 调色板永远非空，用户无需连接 runner 即可添加 stage 节点。
 */
/**
 * kind → schema 节点输出端口类型（映射 ComfyTV `_KIND_TO_OUTPUT_TYPE` + schema 惯例）。
 * 媒体 kind 直出对应 COMFYTV_* 端口；编辑器/工具 kind 复用其输入媒体类型。
 */
function comfyTVKindOutputType(kind: string): string {
	switch (kind) {
		case 'image': case 'image-batch': case 'image-picker': case 'panorama': return 'COMFYTV_IMAGES';
		case 'video': case 'video-picker': return 'COMFYTV_VIDEO';
		case 'audio': case 'audio-picker': return 'COMFYTV_AUDIO';
		case 'text': return 'COMFYTV_TEXT';
		case 'model': return 'COMFYTV_MODEL';
		case 'material': return 'COMFYTV_MATERIAL';
		case 'storyboard': return 'COMFYTV_STORYBOARD';
		case 'timeline': return 'COMFYTV_TIMELINE';
		case 'project': return 'COMFYTV_JSON';
		default: return 'COMFYTV_IMAGE';
	}
}

/**
 * 全量注册 ComfyTV stage（171 个，顺序对齐 ComfyTV `get_node_list()`）。
 * 数据源 = comfyTVStageMeta.generated.ts（由 ComfyTV nodes/stages 生成）。
 *  - 每个 stage 注册为 schema 节点，category/title/kind/workflowKind 与上游一致；
 *  - 输出端口按 kind 映射（COMFYTV_IMAGES/VIDEO/AUDIO/TEXT/...）；
 *  - 可见 widgets 走通用 `workflow` COMBO（options 来自内置静态模板 builtinWorkflows/，
 *    非 /comfytv/workflows）+ 核心 generator（Image/Video/Audio/Speech/Text/Model3D）
 *    用精确 widgets 覆盖。
 */
export function registerDefaultComfyTVStages(): void {
	const genericStageWidgets = (kind: string): NodeSpec['widgets'] => {
		// 通用 stage：workflow 下拉（options 来自内置静态模板）+ 媒体输入可选。
		// 核心 generator 单独精确覆盖。
		const opts = workflowOptionsFor(kind);
		const w: NonNullable<NodeSpec['widgets']> = [
			{ name: 'workflow', type: 'COMBO', default: opts[0], options: opts },
		];
		return w;
	};
	// ImageVariationsStage：ComfyTV variations.py 把 labels_for('multiview') +
	// labels_for('sequence') 两组 workflow 合并进同一个下拉（分组预览），运行时再
	// 按选中 label 推断 kind。原通用分支用 workflowOptionsFor('image-batch') 取到空
	// 数组 → 下拉空白，这里显式合并两组并分组；同时补 variant_count（slider 1-25）
	// 与 prompt。
	const imageVariationsWidgets = (): NodeSpec['widgets'] => {
		const mv = workflowOptionsFor('multiview');
		const seq = workflowOptionsFor('sequence');
		const options: Array<string | { label: string; value: string; group: string }> = [
			...mv.map(label => ({ label, value: label, group: 'Multi-view' })),
			...seq.map(label => ({ label, value: label, group: 'Sequence' })),
		];
		return [
			{ name: 'workflow', type: 'COMBO', default: mv[0], options },
			{ name: 'variant_count', type: 'INT', default: 3, min: 1, max: 25 },
			{ name: 'prompt', type: 'TEXT', default: '' },
		];
	};
	// UpscaleStage：ComfyTV model_edits.py 定义 workflow + scale["2x","4x"] +
	// main_prompt（可选扩散精修引导）+ image(COMFYTV_IMAGE)。genericStageWidgets 只生成
	// workflow，缺少 scale → 用户无法选择放大倍数；此处补 prompt，image 输入由
	// 循环后 refineStage 精确补上。
	const upscaleWidgets = (): NodeSpec['widgets'] => {
		const opts = workflowOptionsFor('upscale');
		return [
			{ name: 'workflow', type: 'COMBO', default: opts[0], options: opts },
			{ name: 'scale', type: 'COMBO', default: '2x', options: ['2x', '4x'] },
			{ name: 'prompt', type: 'TEXT', default: '' },
		];
	};
	// PanoramaStage：ComfyTV panorama.py 的 define_schema 无 direction 参数
	//   （direction 属于 LensDistort/STMapGen/Particles，见 preset_fields.py）。
	//   此处不再特殊生成（由循环后 panoramaRefineWidgets 精确覆盖）。
	const panoramaWidgets = (): NodeSpec['widgets'] => workflowOptionsFor('panorama').length
		? [{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('panorama')[0], options: workflowOptionsFor('panorama') }]
		: [];
	// fx 节点（VideoColorStage/AudioEQStage/…）：ComfyTV 这些是 fx-chain builder，
	// 走单节点执行（class_type = stage 本身），参数直接作为 socketless hidden 字段
	// 由 StagePresetBar + CustomParamsSection 渲染。此处把 COMFYTV_FX_FIELDS 的字段
	// 转成 DOM widgets（FLOAT/INT/COMBO/BOOLEAN），让 nodeCard 通用控件渲染参数面板，
	// 替代原本对 fx 节点无意义的 workflow 下拉。TEXT 字段（lut_file/bands/curves 等
	// 需专用 UI）不在表内，保留后端默认值。
	const fxFieldWidgets = (nodeId: string): NodeSpec['widgets'] => {
		const fields = COMFYTV_FX_FIELDS[nodeId];
		if (!fields || fields.length === 0) { return undefined; }
		const w: NonNullable<NodeSpec['widgets']> = [];
		for (const f of fields) {
			if (f.type === 'COMBO') {
				w.push({ name: f.name, type: 'COMBO', default: String(f.default), options: f.options ?? [] });
			} else if (f.type === 'BOOLEAN') {
				w.push({ name: f.name, type: 'BOOLEAN', default: Boolean(f.default) });
			} else if (f.type === 'INT') {
				w.push({ name: f.name, type: 'INT', default: Number(f.default), min: f.min, max: f.max });
			} else {
				w.push({ name: f.name, type: 'FLOAT', default: Number(f.default), min: f.min, max: f.max, step: f.step });
			}
		}
		return w;
	};
	for (const meta of COMFYTV_STAGE_META) {
		const outType = comfyTVKindOutputType(meta.kind);
		let widgets: NodeSpec['widgets'] = genericStageWidgets(meta.workflowKind ?? meta.kind);
		if (meta.nodeId === 'ComfyTV.ImageVariationsStage') {
			widgets = imageVariationsWidgets();
		} else if (meta.nodeId === 'ComfyTV.UpscaleStage') {
			widgets = upscaleWidgets();
		} else if (meta.nodeId === 'ComfyTV.PanoramaStage') {
			widgets = panoramaWidgets();
		} else if (isFxBuildNode(meta.nodeId)) {
			// fx 节点用参数字段替代 workflow 下拉（fx 不走 workflow）。
			widgets = fxFieldWidgets(meta.nodeId);
		}
		// ★ MultiangleStage 不在此处特殊生成：旧 angle_step/num_views 参数已过时
		//   （ComfyTV 现为 model_edits.py 的 horizontal_angle/vertical_angle/zoom），
		//   由循环后的 multiangleRefineWidgets 精确覆盖。
		registerNodeSpec({
			type: meta.nodeId,
			kind: 'schema',
			title: meta.title,
			category: 'comfyTV',
			// ComfyTV exposes the autogrow lists as connectable pins; everything
			// else is socketless (Vue panel owns it).
			inputs: [{ name: 'input', type: 'ANY' }],
			outputs: [{ name: 'output', type: outType }],
			widgets,
			color: '#e879f9',
			comfyTV: {
				stageKind: meta.kind,
				workflowKind: meta.workflowKind ?? meta.kind,
				// variant 是 ComfyTV 框架驱动卡片形态的核心声明（transform/loader
				// 无运行按钮、无 prompt）。generated meta 一直带着它，此前在注册时
				// 被丢弃，导致卡片只能按节点类型硬编码 26 个 isXxx 分支。
				variant: normalizeStageVariant(meta.variant),
			},
		});
	}
	// 核心 generator：精确 widgets（对齐 ComfyTV generators.py），覆盖上面通用注册。
	const imageWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('image')[0], options: workflowOptionsFor('image') },
		{ name: 'resolution', type: 'COMBO', default: '1K', options: COMFYTV_RESOLUTIONS },
		{ name: 'aspect_ratio', type: 'COMBO', default: '1:1', options: COMFYTV_ASPECT_RATIOS },
		{ name: 'grid_count', type: 'COMBO', default: '4', options: ['2', '4', '6', '9'] },
		{ name: 'batch_size', type: 'INT', default: 1, min: 1, max: 8 },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	const videoWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('video')[0], options: workflowOptionsFor('video') },
		{ name: 'resolution', type: 'COMBO', default: '720P', options: COMFYTV_RESOLUTIONS },
		{ name: 'aspect_ratio', type: 'COMBO', default: '16:9', options: COMFYTV_ASPECT_RATIOS },
		{ name: 'duration_s', type: 'INT', default: 5, min: 1, max: 120 },
		{ name: 'generate_audio', type: 'BOOLEAN', default: false },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	// AudioStage 参数严格对齐 ComfyTV generators.py define_schema：
	//   workflow + main_prompt(prompt) + lyrics(String multiline) +
	//   duration_s(Float 30, 1~240) + bpm(Int 120, 10~300) +
	//   timesignature(ACE_TIME_SIGNATURES) + keyscale(ACE_KEYSCALES 34 项) +
	//   language(ACE_LANGUAGES 51 项)。
	const COMFYTV_ACE_KEYSCALES = (() => {
		const roots = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];
		return roots.flatMap(root => [`${root} major`, `${root} minor`]);
	})();
	const COMFYTV_ACE_LANGUAGES = ['ar', 'az', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'ht', 'hu', 'id', 'is', 'it', 'ja', 'ko', 'la', 'lt', 'ms', 'ne', 'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'sa', 'sk', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'yue', 'zh', 'unknown'];
	const COMFYTV_SPEECH_LANGUAGES = ['Auto', 'English', 'English (British)', 'Mandarin Chinese', 'Japanese', 'Korean', 'French', 'German', 'Spanish', 'Brazilian Portuguese', 'Portuguese', 'Italian', 'Hindi', 'Russian', 'Arabic'];
	const audioWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('audio')[0], options: workflowOptionsFor('audio') },
		{ name: 'prompt', type: 'TEXT', default: '' },
		{ name: 'lyrics', type: 'TEXT', default: '' },
		{ name: 'duration_s', type: 'FLOAT', default: 30, min: 1, max: 240, step: 1 },
		{ name: 'bpm', type: 'INT', default: 120, min: 10, max: 300 },
		{ name: 'timesignature', type: 'COMBO', default: '4', options: ['2', '3', '4', '6'] },
		{ name: 'keyscale', type: 'COMBO', default: 'C major', options: COMFYTV_ACE_KEYSCALES },
		{ name: 'language', type: 'COMBO', default: 'en', options: COMFYTV_ACE_LANGUAGES },
	];
	const speechWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('speech')[0], options: workflowOptionsFor('speech') },
		{ name: 'prompt', type: 'TEXT', default: '' },
		{ name: 'voice', type: 'TEXT', default: '' },
		{ name: 'language', type: 'COMBO', default: 'Auto', options: COMFYTV_SPEECH_LANGUAGES },
		{ name: 'speed', type: 'FLOAT', default: 1.0, min: 0.5, max: 2.0, step: 0.05 },
		{ name: 'reference_text', type: 'TEXT', default: '' },
	];
	const textWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('text')[0], options: workflowOptionsFor('text') },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	const modelWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('model')[0], options: workflowOptionsFor('model') },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	const refineStage = (type: string, widgets: NodeSpec['widgets'], extraInputs: { name: string; type: string }[], extraOutputs: { name: string; type: string }[]): void => {
		const existing = registry.get(type)?.spec;
		if (!existing) { return; }
		registerNodeSpec({
			...existing,
			widgets,
			inputs: extraInputs,
			outputs: extraOutputs,
		});
	};
	refineStage('ComfyTV.ImageStage', imageWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }],
		[{ name: 'images', type: 'COMFYTV_IMAGES' }, { name: 'image', type: 'COMFYTV_IMAGE' }]);
	// MultiangleStage：ComfyTV model_edits.py 的 define_schema 定义
	// horizontal_angle(Int 0-360 默认0) / vertical_angle(Int -30~60 默认0) /
	// zoom(Float 0-10 默认5.0) 三个 slider + prompt。与 ImageStage 的
	// workflow/resolution/aspect_ratio/batch_size 完全不同，必须单独 refine。
	// ★ 数值严格对齐 model_edits.py（此前 FLOAT 0-180 默认30 / -90~90 / 0.5-2
	//   默认1.0 全是错的——zoom 默认 1.0 会退化成原始大小，LoRA 相机控制失效）。
	const multiangleRefineWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('multiangle')[0], options: workflowOptionsFor('multiangle') },
		{ name: 'horizontal_angle', type: 'INT', default: 0, min: 0, max: 360 },
		{ name: 'vertical_angle', type: 'INT', default: 0, min: -30, max: 60 },
		{ name: 'zoom', type: 'FLOAT', default: 5.0, min: 0.0, max: 10.0, step: 0.1 },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	refineStage('ComfyTV.MultiangleStage', multiangleRefineWidgets,
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }]);
	// PanoramaStage：ComfyTV panorama.py 定义 workflow + main_prompt + image 输入，
	// 输出为**单个** COMFYTV_PANORAMA.Output("panorama")（非 images/image 双输出）。
	// ★ ComfyTV panorama.py 无 direction 参数（direction 属于 LensDistort/STMapGen/
	//   Particles）。此处只保留 workflow + prompt，严格对齐 define_schema。
	const panoramaRefineWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('panorama')[0], options: workflowOptionsFor('panorama') },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	refineStage('ComfyTV.PanoramaStage', panoramaRefineWidgets,
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'panorama', type: 'COMFYTV_PANORAMA' }]);
	// EraseStage：ComfyTV model_edits.py 定义 workflow + mask_data(hidden) + image。
	// ★ 源码无 brush_size 参数（笔刷大小是 MaskPainter 编辑器的内部 UI 状态，非节点
	//   参数）。此处只保留 workflow + image 输入，mask_data 由 MaskPainter 写入
	//   节点 properties（见 nodeCard commitMaskField）。
	refineStage('ComfyTV.EraseStage',
		[
			{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('erase')[0], options: workflowOptionsFor('erase') },
		],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }]);
	// UpscaleStage：补 image 输入 + image 输出（对齐 model_edits.py）。
	refineStage('ComfyTV.UpscaleStage', upscaleWidgets(),
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }]);
	refineStage('ComfyTV.VideoStage', videoWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }, { name: 'videos', type: 'COMFYTV_VIDEO' }, { name: 'audio', type: 'COMFYTV_AUDIO' }],
		[{ name: 'videos', type: 'COMFYTV_VIDEO' }]);
	// KenBurnsStage：ComfyTV KenBurnsStageCard.vue 实际仅是滑块卡片
	// （width/height/fps/duration/start·end zoom·x·y + interp），无 workflow 选择、
	// 无专门视口拖拽编辑器。参数精确对齐 ComfyTV video_generate.py 的 define_schema。
	// 节点级渲染走 nodeCard 的 KenBurns 滑块分支（range slider，对齐 ComfyTV FxSlider）。
	const kenBurnsWidgets: NodeSpec['widgets'] = [
		{ name: 'width', type: 'INT', default: 1280, min: 16, max: 4096, step: 16 },
		{ name: 'height', type: 'INT', default: 720, min: 16, max: 4096, step: 16 },
		{ name: 'fps', type: 'INT', default: 24, min: 1, max: 120, step: 1 },
		{ name: 'duration', type: 'FLOAT', default: 5.0, min: 0.5, max: 120, step: 0.5 },
		{ name: 'start_zoom', type: 'FLOAT', default: 1.0, min: 1.0, max: 6.0, step: 0.05 },
		{ name: 'end_zoom', type: 'FLOAT', default: 1.3, min: 1.0, max: 6.0, step: 0.05 },
		{ name: 'start_x', type: 'FLOAT', default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
		{ name: 'start_y', type: 'FLOAT', default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
		{ name: 'end_x', type: 'FLOAT', default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
		{ name: 'end_y', type: 'FLOAT', default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
		{ name: 'interp', type: 'COMBO', default: 'smooth', options: ['linear', 'smooth', 'ease_in', 'ease_out'] },
	];
	// KenBurnsStage：源码 video_generate.py 输入 image(COMFYTV_IMAGE)、输出
	// video(COMFYTV_VIDEO)（非通用 input/output 端口名）。
	refineStage('ComfyTV.KenBurnsStage', kenBurnsWidgets,
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	// AudioStage：源码 generators.py 无媒体输入端口（纯 socketless 参数 + 输出 audio）。
	refineStage('ComfyTV.AudioStage', audioWidgets,
		[],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	// SpeechStage：源码仅 reference_audio(COMFYTV_AUDIO) 一个输入端口（无 texts）。
	refineStage('ComfyTV.SpeechStage', speechWidgets,
		[{ name: 'reference_audio', type: 'COMFYTV_AUDIO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	// TextStage：源码 texts(8) + images(8) + videos(4) 三个 autogrow 输入。
	refineStage('ComfyTV.TextStage', textWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }, { name: 'videos', type: 'COMFYTV_VIDEO' }],
		[{ name: 'texts', type: 'COMFYTV_TEXT' }]);
	// Model3DStage：源码 texts(4) + images(4) + models(4) 三个 autogrow 输入。
	refineStage('ComfyTV.Model3DStage', modelWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }, { name: 'models', type: 'COMFYTV_MODEL' }],
		[{ name: 'models', type: 'COMFYTV_MODEL' }, { name: 'image', type: 'COMFYTV_IMAGE' }]);
	// ── 补齐 meta.py 缺失节点的精确端口（对齐源码 define_schema）─────────────
	// ShotImagesStage：storyboard(COMFYTV_STORYBOARD) + images 输入 → images/image 输出。
	const shotImagesWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('shot-images')[0], options: workflowOptionsFor('shot-images') },
		{ name: 'resolution', type: 'COMBO', default: '1K', options: COMFYTV_RESOLUTIONS },
		{ name: 'aspect_ratio', type: 'COMBO', default: '1:1', options: COMFYTV_ASPECT_RATIOS },
	];
	refineStage('ComfyTV.ShotImagesStage', shotImagesWidgets,
		[{ name: 'storyboard', type: 'COMFYTV_STORYBOARD' }, { name: 'images', type: 'COMFYTV_IMAGE' }],
		[{ name: 'images', type: 'COMFYTV_IMAGES' }, { name: 'image', type: 'COMFYTV_IMAGE' }]);
	// StoryboardStage：texts 输入 → storyboard 输出（含 total_duration_s/shot_count/
	// characters 参数，对齐 generators.py）。
	const storyboardWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('storyboard')[0], options: workflowOptionsFor('storyboard') },
		{ name: 'prompt', type: 'TEXT', default: '' },
		{ name: 'total_duration_s', type: 'INT', default: 30, min: 2, max: 600 },
		{ name: 'shot_count', type: 'INT', default: 6, min: 1, max: 25 },
		{ name: 'characters', type: 'TEXT', default: '' },
	];
	refineStage('ComfyTV.StoryboardStage', storyboardWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }],
		[{ name: 'storyboard', type: 'COMFYTV_STORYBOARD' }]);
	// DirectorTimelineStage：images + audio 输入 → timeline 输出（transform 变体）。
	refineStage('ComfyTV.DirectorTimelineStage', undefined,
		[{ name: 'images', type: 'COMFYTV_IMAGE' }, { name: 'audio', type: 'COMFYTV_AUDIO' }],
		[{ name: 'timeline', type: 'COMFYTV_TIMELINE' }]);
	// TimelineVideoStage：timeline 输入 → video 输出（源码含 timeline workflow 下拉）。
	// 注意：builtinWorkflows 暂无 'timeline' 模板，故用 listBuiltinLabels 直取（空则不
	// 兜底成 Local SD1.5，避免误导）；后端补模板后自动出现。
	const timelineLabels = listBuiltinLabels('timeline');
	const timelineVideoWidgets: NodeSpec['widgets'] = timelineLabels.length
		? [{ name: 'workflow', type: 'COMBO', default: timelineLabels[0], options: timelineLabels }]
		: [];
	refineStage('ComfyTV.TimelineVideoStage', timelineVideoWidgets,
		[{ name: 'timeline', type: 'COMFYTV_TIMELINE' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	// VideoUpscaleStage：video 输入 → video 输出 + scale 下拉。
	const videoUpscaleWidgets: NodeSpec['widgets'] = [
		{ name: 'scale', type: 'COMBO', default: '2x', options: ['2x', '4x'] },
	];
	refineStage('ComfyTV.VideoUpscaleStage', videoUpscaleWidgets,
		[{ name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	// 字幕擦除系列：video 输入 → video 输出。
	refineStage('ComfyTV.VideoSubtitleSmartEraseStage', undefined,
		[{ name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	refineStage('ComfyTV.VideoSubtitleSelectEraseStage', undefined,
		[{ name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	// 人声/背景提取：video 输入 → audio 输出 + workflow 下拉（源码 labels_for('audio-vocal'/'audio-bg')）。
	// builtinWorkflows 暂无这两个 kind，用 listBuiltinLabels 直取避免兜底误导。
	const audioVocalLabels = listBuiltinLabels('audio-vocal');
	const audioBgLabels = listBuiltinLabels('audio-bg');
	const audioExtractVocalWidgets: NodeSpec['widgets'] = audioVocalLabels.length
		? [{ name: 'workflow', type: 'COMBO', default: audioVocalLabels[0], options: audioVocalLabels }]
		: [];
	const audioExtractBgWidgets: NodeSpec['widgets'] = audioBgLabels.length
		? [{ name: 'workflow', type: 'COMBO', default: audioBgLabels[0], options: audioBgLabels }]
		: [];
	refineStage('ComfyTV.AudioExtractVocalStage', audioExtractVocalWidgets,
		[{ name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	refineStage('ComfyTV.AudioExtractBgStage', audioExtractBgWidgets,
		[{ name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	// AudioClipStage（Audio Trim）：audio + video 输入 → audio 输出。
	refineStage('ComfyTV.AudioClipStage', undefined,
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }, { name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	// AudioSplitStage：audio + video 输入 → audio_a + audio_b 双输出。
	refineStage('ComfyTV.AudioSplitStage', undefined,
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }, { name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'audio_a', type: 'COMFYTV_AUDIO' }, { name: 'audio_b', type: 'COMFYTV_AUDIO' }]);
	// Picker 家族：媒体批量 → 选择快照（**多选**，2026-09-12 用户需求「多选图片时
	// UI 要有多选状态」）。
	// ★ 选中字段**必须声明在 widgets 里**：`getNodeCardMeta.toControls` 只把
	//   spec.widgets 派生成 `meta.controls`（ComfyTV 分支且只收 COMBO/INT/FLOAT/
	//   BOOLEAN）→ 未声明的字段在卡片**重挂载**后读不回（多选态丢失、回退单张）。
	//   同 AnimatedEmoji `run_scope/cell_indices` 的教训。
	//   · `selected_index`(INT, 1-based) = **主选**（旧数据/外部调用兼容，执行器兜底）；
	//   · `selected_indices`(TEXT, JSON 0-based 数组) = 上游池视图的**全部**选中；
	//   · `directRef`(TEXT) / `directRefs`(TEXT, JSON 数组) 同上，用于「全部」池视图。
	//   picker 卡片 `showRun === false` → 这些 widget 不会渲染成通用控件行 ✓
	//   （多选 UI 由 Pool 网格自绘）。
	const pickerWidgets: NodeSpec['widgets'] = [
		{ name: 'selected_index', type: 'INT', default: 1, min: 1, max: 9999 },
		{ name: 'selected_indices', type: 'TEXT', default: '' },
		{ name: 'directRef', type: 'TEXT', default: '' },
		{ name: 'directRefs', type: 'TEXT', default: '' },
	];
	refineStage('ComfyTV.ImagePickerStage', pickerWidgets,
		[{ name: 'batch', type: 'COMFYTV_IMAGES' }],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }]);
	refineStage('ComfyTV.VideoPickerStage', pickerWidgets,
		[{ name: 'batch', type: 'COMFYTV_VIDEO' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	refineStage('ComfyTV.AudioPickerStage', pickerWidgets,
		[{ name: 'batch', type: 'COMFYTV_AUDIO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	// Loader 家族（ComfyTV loaders.py 语义：media 输入 / 上传 → 快照输出）。
	// ★ 输出端口名对齐 ComfyTV `define_schema` 的 Output 名（loaders.py）：
	//   ImageLoaderStage → `image`、VideoLoaderStage → `video`、AudioLoaderStage →
	//   `audio`、TextLoaderStage → `text`（非通用的 `output`）。此前写死 `output`
	//   导致连线端口标签与 ComfyTV 参考 UI 不一致（「loadimage/loadvideo 参数错误」）。
	//   端口**类型**仍用 COMFYTV_* 族（与其它 ComfyTV stage 同族，连线语义一致）。
	const loader = (type: string, outType: string, outName: string, widgets: NodeSpec['widgets'] = []): void => {
		const existing = registry.get(type)?.spec;
		if (!existing) { return; }
		registerNodeSpec({
			...existing,
			inputs: [],
			outputs: [{ name: outName, type: outType }],
			widgets,
		});
	};
	// LoadImage 复刻 ComfyTV LoadImage 编辑器：文件名 input + 本地上传按钮 + 缩略图
	// + 尺寸文字（image widget 类型见 NodeEditorPopup ImageFieldEditor）。
	loader('ComfyTV.ImageLoaderStage', 'COMFYTV_IMAGE', 'image', [
		{ name: 'image', type: 'IMAGE', default: '' },
	]);
	loader('ComfyTV.VideoLoaderStage', 'COMFYTV_VIDEO', 'video', [
		{ name: 'video', type: 'TEXT', default: '' },
	]);
	loader('ComfyTV.AudioLoaderStage', 'COMFYTV_AUDIO', 'audio', [
		{ name: 'audio', type: 'TEXT', default: '' },
	]);
	loader('ComfyTV.TextLoaderStage', 'COMFYTV_TEXT', 'text', [
		{ name: 'text', type: 'TEXT', default: '' },
	]);
	// Asset 系列（loaders.py Asset*LoaderStage，输出名同基础 loader）：
	//   本项目未走 ComfyTV 的文件上传 Combo，改由拖拽媒体库资产（mediaAssetId）
	//   注入；但**输出端口名**仍须对齐 ComfyTV（image/video/audio）。
	loader('ComfyTV.AssetImageLoaderStage', 'COMFYTV_IMAGE', 'image');
	loader('ComfyTV.AssetVideoLoaderStage', 'COMFYTV_VIDEO', 'video');
	loader('ComfyTV.AssetAudioLoaderStage', 'COMFYTV_AUDIO', 'audio');
	// Model loader 双输出（loaders.py ModelLoaderStage/AssetModelLoaderStage：
	//   outputs=[COMFYTV_MODEL.Output("model"), COMFYTV_IMAGE.Output("image")]）。
	const modelLoader = (type: string): void => {
		const existing = registry.get(type)?.spec;
		if (!existing) { return; }
		registerNodeSpec({
			...existing,
			inputs: [],
			outputs: [
				{ name: 'model', type: 'COMFYTV_MODEL' },
				{ name: 'image', type: 'COMFYTV_IMAGE' },
			],
		});
	};
	modelLoader('ComfyTV.ModelLoaderStage');
	modelLoader('ComfyTV.AssetModelLoaderStage');
	// P4 — ComfyTV ↔ native bridge nodes (single-node prompts; full tensor
	// wiring lands with native-graph execution).
	const bridge = (type: string, title: string, inType: string, outType: string): void => {
		registerNodeSpec({
			type,
			kind: 'native',
			title,
			category: 'comfyBridge',
			inputs: [{ name: 'input', type: inType as PortType }],
			outputs: [{ name: 'output', type: outType as PortType }],
			color: '#5eead4',
		});
	};
	bridge('ComfyTV.BridgeToImage', 'Bridge → 图像快照', 'IMAGE', 'IMAGE');
	bridge('ComfyTV.BridgeToImages', 'Bridge → 图像批量', 'IMAGE', 'IMAGE');
	bridge('ComfyTV.BridgeToVideo', 'Bridge → 视频快照', 'VIDEO', 'VIDEO');
	bridge('ComfyTV.BridgeToAudio', 'Bridge → 音频快照', 'AUDIO', 'AUDIO');
	bridge('ComfyTV.BridgeToText', 'Bridge → 文本快照', 'TEXT', 'TEXT');
	bridge('ComfyTV.BridgeFromImage', 'Bridge ← 图像快照', 'IMAGE', 'IMAGE');
	bridge('ComfyTV.BridgeFromMask', 'Bridge ← 蒙版快照', 'IMAGE', 'IMAGE');
	bridge('ComfyTV.BridgeFromVideo', 'Bridge ← 视频快照', 'VIDEO', 'VIDEO');
	bridge('ComfyTV.BridgeFromAudio', 'Bridge ← 音频快照', 'AUDIO', 'AUDIO');
	bridge('ComfyTV.BridgeFromText', 'Bridge ← 文本快照', 'TEXT', 'TEXT');
	// P2 — instant browser-local stages (Crop/Rotate/Mirror, processed on canvas).
	const instant = (type: string, title: string): void => {
		registerNodeSpec({
			type,
			kind: 'native',
			title,
			category: 'comfyInstant',
			// 端口名对齐 ComfyTV 参考 UI：卡片头部显示 `Image ─ Image`
			// （ComfyTV 的 stage 端口按类型命名），而非通用的 input/output。
			// 端口**类型**同样对齐其它 ComfyTV stage：用 `COMFYTV_IMAGE` 而非裸
			// `IMAGE` —— 卡片 OUTPUT 标题取 `primaryOutputType`，裸 IMAGE 会渲染成
			// `OUTPUT (IMAGE)`，而参考 UI 是 `OUTPUT (COMFYTV_IMAGE)`；
			// 且与 ImageStage 的 COMFYTV_IMAGES / PickerStage 的 COMFYTV_IMAGE
			// 同族，连线语义更一致。
			inputs: [{ name: 'Image', type: 'COMFYTV_IMAGE' }],
			outputs: [{ name: 'Image', type: 'COMFYTV_IMAGE' }],
			widgets: INSTANT_WIDGETS[type],
		});
	};
	instant('ComfyTV.CropStage', '裁剪');
	instant('ComfyTV.RotateStage', '旋转');
	instant('ComfyTV.MirrorStage', '镜像');
	// 见 syncNodePortsToSpec：已存在于画布/存档里的节点端口名是**序列化数据**，
	// 改这里的 spec 只影响新建节点；老节点靠画布层的同步函数就地纠正。
	// P3 — Relight embedded light-ball editor (browser-local, two outputs).
	// ★ 对齐 ComfyTV model_edits.py：RelightStage 无 image 输入（纯灯光球编辑器，
	//   灯光数据由内嵌编辑器持久化为 lights_data/light_render_url hidden 字段）；
	//   输出类型 = COMFYTV_IMAGE("3d light") + COMFYTV_TEXT。
	registerNodeSpec({
		type: 'ComfyTV.RelightStage',
		kind: 'native',
		title: '打光',
		category: 'comfyRelight',
		inputs: [],
		outputs: [
			{ name: 'light_render', type: 'COMFYTV_IMAGE' },
			{ name: 'light_prompt', type: 'COMFYTV_TEXT' },
		],
		widgets: [
			{ name: 'main_prompt', type: 'STRING', default: 'soft studio lighting, gentle shadows' },
		],
	});
	// P3 — Poster embedded layout editor (browser-local, template + layout blob).
	// ★ 对齐 ComfyTV poster.py：images(Autogrow 12) 输入 + image 输出均为 COMFYTV_*
	//   类型；补 layout 隐藏字段（画布布局+配色+字体 blob）。
	registerNodeSpec({
		type: 'ComfyTV.PosterStage',
		kind: 'native',
		title: '海报',
		category: 'comfyPoster',
		inputs: [{ name: 'images', type: 'COMFYTV_IMAGE' }],
		outputs: [{ name: 'image', type: 'COMFYTV_IMAGE' }],
		widgets: [
			{ name: 'template', type: 'COMBO', options: ['hero'], default: 'hero' },
			{ name: 'width', type: 'INT', default: 1240 },
			{ name: 'height', type: 'INT', default: 1754 },
			{ name: 'layout', type: 'TEXT', default: '{}' },
		],
	});
	// P3 — Layer Editor artboard (browser-local compositing + upload).
	// ★ 对齐 ComfyTV layer_editor.py：双输出 image(COMFYTV_IMAGE) + images(COMFYTV_IMAGES)。
	registerNodeSpec({
		type: 'ComfyTV.LayerEditorStage',
		kind: 'native',
		title: '图层画板',
		category: 'comfyLayer',
		inputs: [],
		outputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
			{ name: 'images', type: 'COMFYTV_IMAGES' },
		],
		widgets: [
			{ name: 'width', type: 'INT', default: 1024 },
			{ name: 'height', type: 'INT', default: 1024 },
		],
	});
	// P3 — 导演台编辑器（Storyboard Editor，复用 Layer Editor 画板 per board）。
	registerNodeSpec({
		type: 'ComfyTV.StoryboardEditorStage',
		kind: 'native',
		title: '导演台',
		category: 'comfyStoryboard',
		inputs: [
			// text = 上游分镜文本（Fountain 剧本）→ 打开编辑器时自动解析成 boards
			{ name: 'text', type: 'COMFYTV_TEXT' },
		],
		// 对齐 ComfyTV storyboard_editor.py 三输出：image（封面）/ images（批次）/ video（animatic）
		outputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
			{ name: 'images', type: 'COMFYTV_IMAGES' },
			{ name: 'video', type: 'COMFYTV_VIDEO' },
		],
		widgets: [
			{ name: 'width', type: 'INT', default: 1280 },
			{ name: 'height', type: 'INT', default: 720 },
		],
	});
	// P3 — Material PBR ball editor (browser-local, dual output).
	// 对齐 ComfyTV material.py：image 输入 + 双输出 material(COMFYTV_MATERIAL) +
	// image(COMFYTV_IMAGE)（此前 material 误用 TEXT、image 误用 IMAGE）。
	registerNodeSpec({
		type: 'ComfyTV.MaterialStage',
		kind: 'native',
		title: '材质',
		category: 'comfyMaterial',
		inputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			{ name: 'material', type: 'COMFYTV_MATERIAL' },
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('material-estimate')[0], options: workflowOptionsFor('material-estimate') },
			{ name: 'material_state', type: 'TEXT', default: '' },
		],
	});
	// P3 — 3D Scene (2.5D isometric MVP, browser-local capture).
	// ★ 对齐 ComfyTV scene3d.py：三输出 image + video + images（均为 COMFYTV_*）。
	registerNodeSpec({
		type: 'ComfyTV.Scene3DStage',
		kind: 'native',
		title: '3D 摆场',
		category: 'comfyScene3D',
		inputs: [],
		outputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
			{ name: 'video', type: 'COMFYTV_VIDEO' },
			{ name: 'images', type: 'COMFYTV_IMAGES' },
		],
		widgets: [
			{ name: 'width', type: 'INT', default: 1024 },
			{ name: 'height', type: 'INT', default: 1024 },
		],
	});
	// 多宫格故事板 — 网格宫格（2/4/6/9）漫画分格编辑器（browser-local）。
	// 每格独立描述（角色/动作/对白/图像提示），run 时拼 qwen 多宫格 prompt 单图直出
	// 整张多宫格合成图（workflowRun.runMultiPanelStoryboardNode → IMAGE_QWEN_2512_MULTI_PANEL）。
	// 内嵌编辑器 = MultiPanelStoryboardEditor；inputs 接上游故事提示词（text，可选）。
	registerNodeSpec({
		type: 'ComfyTV.MultiPanelStoryboardStage',
		kind: 'native',
		title: '多宫格故事板',
		category: 'comfyMultiPanel',
		inputs: [
			{ name: 'text', type: 'COMFYTV_TEXT' },
		],
		outputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			{ name: 'panels_state', type: 'TEXT', default: '' },
			{ name: 'width', type: 'INT', default: 1328 },
			{ name: 'height', type: 'INT', default: 1328 },
		],
	});
}
