/*---------------------------------------------------------------------------------------------
 *  nodeCard — React cards mounted inside the LiteGraph overlay (widgetBridge).
 *
 *  One card per graph node; pure presentational (pointer-events:none) so LiteGraph's
 *  canvas handles selection/drag/connection. Cards are driven by the node spec from
 *  `registry.getNodeSpec(type)`:
 *   - react  : Saros.* nodes — title + type chip + port labels + key widget values
 *   - schema : ComfyTV stages — title + schema chip (kind/workflowKind) + prompt +
 *                               run button + progress + error banner + output preview
 *   - native : ComfyUI nodes  — title + native chip + widget names/values
 *
 *  Visual language follows ComfyTV's StageCard: a dark rounded panel, an uppercase
 *  section label, a full-width run button (primary bg), a thin progress bar, an
 *  error banner, and an output preview strip. Execution state (running/progress/
 *  error/duration) comes from `CardStateStore` (see cardState.ts).
 *
 *  A `createNodeCard` helper mounts the card into an overlay container and returns
 *  an unmount function; the canvas keeps a Map<nodeId, unmount>.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { NodeSpec, StageVariant } from './registry';
import { WEIXIN_EXPORT_TARGETS } from './registry';
import { ORCH_RICH_NODE_TYPES } from './registry.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore';
import { isSheetFullMeta, META_SHEET_FLAG, sheetDimsOf, sheetDimsMeta } from './mediaSnapshotStore.js';
import type { MediaSnapshotEntry } from './mediaSnapshot';
import { mergeImagePool, mediaDedupeKey, comfyViewUrl } from './mediaSnapshot';
import { useNodeSnapshots, usePickerSnapshots, useAllSnapshots, mediaSnapshotHooks as mshHooks } from './useMediaSnapshot';
// 通过命名空间对象访问 hook，避免 esbuild IIFE 下命名 hook 导出丢失
// （实测 `import { useStoreVersion }` 在 IIFE bundle 里拿到 undefined，
//  run-time 是 `ReferenceError: useStoreVersion is not defined`，把节点
//  整体 UI 抹掉 —— 见 2026-08-16 实战记录）。
// 这里 inline 一个 storeVersion hook 别名（其实等价于 mshHooks.storeVersion），
// 保证消费侧的 hook 名字一定在当前模块的标识符表里，esbuild 不会让它"失踪"。
function useStoreVersionLocal(store: import('./mediaSnapshotStore').MediaSnapshotStore | undefined): number {
	return React.useSyncExternalStore(
		React.useCallback((cb: () => void) => store?.subscribe(cb) ?? (() => { /* no-op */ }), [store]),
		React.useCallback(() => store?.getSnapshot() ?? 0, [store]),
		React.useCallback(() => store?.getSnapshot() ?? 0, [store]),
	);
}
// 见 nodeExecutor.ts 同款注释。
const _bridge = (globalThis as { __vssarosBridge?: { createProxiedFetch: typeof import('../../../bridge/messageClient')['createProxiedFetch'] } }).__vssarosBridge
	?? (() => { throw new Error('vssarosBridge not initialised'); })();
const { createProxiedFetch } = _bridge;
import { useNodeCardState, type CardStateStore, type NodeRunState } from './cardState';
import { useRunnerStatus } from './runnerStatusStore';
import { markFormHeightDirty } from './domWidget';
import { buildSarosEditorFields, migrateAskUserQuestions } from './nodeEditorForm';
import { ComboPopover } from './ComboPopover';
import { resolveMediaAssetUrl, collectUpstreamTexts, composeImageGridOnChroma, splitStickerSheet, EMOJI_SHEET_MARGIN_RATIO, parsePickerIndexList, parsePickerRefList, publishPickerSelection } from './workflowRun.js';
import { useProviderStore } from '../../../store/useProviderStore';
import { useAgentStore } from '../../../store/useAgentStore';
import { usePicklistStore } from '../picklistStore';
import { useWorkflowEditorStore } from '../store';
import { getNodeDefinition } from './nodeDefinition.js';
import { ACTIONS_BY_KIND, actionKeyFor, type StageAction, type ImagePreset } from './actionSpawn';
import { MaskPainter } from '../MaskPainter';
import { CropEditor } from '../CropEditor';
import { OutpaintEditor } from '../OutpaintEditor';
import { GridSplitEditor } from '../GridSplitEditor';
import { ColorGradeEditor } from '../ColorGradeEditor';
import { TransformEditor } from '../TransformEditor';
import { StatEmojiStageEditor } from '../StatEmojiStageEditor';
import { MiniImageEditor, type CellCropRect } from '../MiniImageEditor';
import { getFullyTransparentRatio, refToPngDataUrl } from '../miniEditorAi.js';
import { runSheetRemoveBg } from './emojiRemoveBg.js';
import { createPortal } from 'react-dom';
import { AnimatedEmojiEditor } from '../AnimatedEmojiEditor';
import { emojiInputSigFor, emojiInputSig } from './animatedEmojiExecutor';
import { MultiangleEditor } from './MultiangleEditor';
import { AssetReferences, type AssetCandidate } from './AssetReferences';
import { MentionTextarea, type MentionCandidate } from './MentionTextarea';
import { ASSET_REFS_PROP, type AssetRef } from './assetRefs';
import type { CameraState } from './cameraWidget';
import { PanoramaEditor } from './PanoramaEditor';
import { RelightEditor } from '../RelightEditor';
import { parseLightsData } from './relightEditor';
import { MaterialEditor } from '../MaterialEditor';
// ★ DirectorConsoleEditor 延迟加载包装器（解决 esbuild IIFE bundle 的 TDZ 错误）。
//   该组件依赖链较深（LayerEditor → layerEditor → …），在 IIFE 同步初始化时
//   某个中间变量被访问时尚未完成声明，报 "Cannot access 'O' before initialization"。
//   由于 esbuild 配置 splitting:false（单文件 IIFE），React.lazy 的动态 import()
//   无法拆分 chunk，故改用 useState + useEffect 在组件挂载后动态 require，
//   将模块求值从 IIFE 初始化推迟到首次渲染之后。
// ★ 错误边界：捕获 DirectorConsoleEditor 渲染期 TDZ，输出完整堆栈定位根因
class DCEErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
	state = { err: null as Error | null };
	static getDerivedStateFromError(err: Error) { return { err }; }
	componentDidCatch(err: Error) {
		// eslint-disable-next-line no-console
		console.error('[DirectorConsole] 渲染失败：', err);
	}
	render() {
		if (this.state.err) {
			return <div style={{ minHeight: 560, padding: 12, color: '#f66', fontSize: 12, whiteSpace: 'pre-wrap', overflow: 'auto' }}>
				{String(this.state.err && this.state.err.stack || this.state.err)}
			</div>;
		}
		return this.props.children as React.ReactElement;
	}
}

/** 校验画布尺寸：NaN/非正数/超范围 → fallback 默认值。对齐字段定义 min=64 max=4096 */
function clampDim(v: number, fallback: number): number {
	if (!Number.isFinite(v) || v < 64 || v > 4096) { return fallback; }
	return Math.round(v / 8) * 8; // 对齐 step=8
}

function LazyDirectorConsole(props: React.ComponentProps<typeof import('../DirectorConsoleEditor').DirectorConsoleEditor>) {
	const [Comp, setComp] = React.useState<React.ComponentType<typeof props> | null>(null);
	React.useEffect(() => {
		import('../DirectorConsoleEditor')
			.then(m => { setComp(() => m.DirectorConsoleEditor); })
			.catch(err => {
				// eslint-disable-next-line no-console
				console.error('[DirectorConsole] 懒加载失败：', err);
			});
	}, []);
	if (!Comp) return <div style={{ minHeight: 560, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>加载导演台…</div>;
	return <DCEErrorBoundary><Comp {...props} /></DCEErrorBoundary>;
}
import { getActiveRunnerRegistry, getActiveRunnerPreference } from './runnerContext';
import { useTransformPipeline, transformPhaseLabel } from './useTransformPipeline';
import { isInstantNode } from './instantNodes';
import { stageEditorKind, stageHiddenFields, stageMinHeight, stageCardFlags, contextSummary, hasStageEditor, stageEditorDescriptor } from './stageCardRegistry';
import { preRunHint } from './stageSlots';
import {
	listStagePresets, saveStagePreset, deleteStagePreset, pickPresetValues,
	findMatchingPreset, subscribePresets, getPresetsRevision,
	PRESET_EXCLUDED_FIELDS, type StagePreset,
} from './stagePresets';

// 解析 ComfyTV ColorGrade 的 grade_state JSON（{ effect, all }），失败时返回空 all。
type GradeAll = Record<string, Record<string, number | boolean | { points: Array<{ x: number; y: number }>; interpolation: 'monotone_cubic' | 'linear' }>>;
function safeParseGradeAll(raw: unknown): GradeAll {
	const out: GradeAll = {};
	if (typeof raw !== 'string' || !raw) { return out; }
	try {
		const parsed = JSON.parse(raw) as { all?: GradeAll };
		if (parsed.all && typeof parsed.all === 'object') {
			for (const [id, vals] of Object.entries(parsed.all)) { out[id] = vals; }
		}
	} catch { /* ignore */ }
	return out;
}

export interface NodeCardMeta {
	title: string;
	kind: 'react' | 'schema' | 'native' | 'llm';
	kindLabel: string;
	inputs: import('./registry.js').PortSpec[];
	outputs: import('./registry.js').PortSpec[];
	/** key widget values (native: seed=…, steps=…) */
	widgetSummary?: string;
	schemaDetail?: string;
	/** ComfyTV stage kind, used to pick run-button label + icon (image/video/audio/…) */
	stageKind?: string;
	/** ComfyTV workflow kind (e.g. ImageStage → 'image')，决定出图时读取哪个内置模板。 */
	workflowKind?: string;
	/** whether this node has a prompt editor (schema stages only) */
	hasPrompt?: boolean;
	/** current prompt text (schema stages) — bound to node.properties.prompt */
	prompt?: string;
	/**
	 * RelightStage 灯光数据原始 JSON（node.properties.lights_data）。
	 * ★ RelightEditor 重构后 props 改为 initialLights（LightInfoEntry[]），
	 *   但 lights_data 是 hidden 字段不进 meta.controls → 与 cells 同理显式透传，
	 *   否则 nodeCard 拿不到灯光数据（RelightEditor 崩溃/丢失）。
	 */
	lightsData?: string;
	/**
	 * RelightStage 主提示词（node.properties.main_prompt，STRING widget 不进
	 * controls，见 lightsData 注释）。RelightEditor 的 initialPrompt 用。
	 */
	mainPrompt?: string;
	/**
	 * EmojiStage 每格状态原始 JSON（node.properties.cells，数组 [{prompt,seed,text}]）。
	 *
	 * ★ EmojiStage 的 cells 是 TEXT 类型 widget，而 toControls 对 ComfyTV 节点只收
	 *   COMBO/INT/FLOAT/BOOLEAN → 不进 controls。EmojiStageEditor 的 initial 若走
	 *   ctl('cells','[]') 会永远拿到 fallback '[]'，导致「重启后每格 prompt/seed 丢失」。
	 *   这里与 prompt 一样显式透传（见 NodeCardMeta.image 的同类先例）。
	 */
	cells?: string;
	/**
	 * AnimatedEmoji 每格动作描述原始 JSON（node.properties.cell_actions，数组按格序）。
	 *
	 * ★ 与 cells 同理：TEXT widget 不进 controls → ctl 永远 fallback '[]'，
	 *   编辑器 initial 走 meta 直传，否则「重启后逐格动作丢失」。
	 */
	cellActions?: string;
	/**
	 * AnimatedEmoji 绿幕色（node.properties.chroma_color）。
	 *
	 * ★ 与 cells 同理：`chroma_color` 是 STRING widget，toControls 对 ComfyTV 节点
	 *   只收 COMBO/INT/FLOAT/BOOLEAN → 不进 controls → 编辑器 `ctl('chroma_color')`
	 *   永远 fallback '#00FF00'（用户调过的幕布色重开面板即丢，且 onCommit 会把
	 *   默认值写回覆盖）。这里显式透传。
	 */
	chromaColor?: string;
	/**
	 * EmojiStage 每格**裁剪框**原始 JSON（node.properties.cell_crops，
	 * 数组 [{x,y,w,h}]——MiniImageEditor「调整裁剪」的持久化）。
	 *
	 * ★ cell_crops 是**隐藏数据**（不在 widgets，toControls 不收）→ 不进
	 *   meta.controls。与 cells 同理显式透传，否则「重启后裁剪框回默认等分、
	 *   下游转动态图集裁剪与上游不一致」。
	 */
	cellCrops?: string;
	/**
	 * ★ Picker 多选选中态原始 JSON（2026-09-12 用户需求「多选图片时 UI 要有多选
	 *   状态」）：`node.properties.selected_indices`（上游池视图，0-based 序号数组）/
	 *   `node.properties.directRefs`（「全部」视图，ref 数组）。
	 *
	 * ★ 为什么显式透传：二者是 TEXT widget，而 `toControls` 的 ComfyTV 分支只收
	 *   COMBO/INT/FLOAT/BOOLEAN → 不进 `meta.controls` → `ctl()` 读不到，卡片
	 *   **重挂载后多选态丢失**（回退成 `selected_index` 单张）。与 cells /
	 *   cell_crops / chroma_color 完全同理。
	 */
	pickerSelectedIndices?: string;
	pickerDirectRefs?: string;
	/** quick actions row (ComfyTV ACTIONS): icon+label, click opens editor */
	actions?: StageAction[];
	/** brand tag (ComfyTV / ComfyUI) shown at the top of the card */
	brand?: string;
	/** inline editable parameter controls (ComfyTVWidget equivalents): COMBO →
	 *  select, INT/FLOAT → number, BOOLEAN → checkbox. Excludes `prompt` (own editor). */
	controls?: Array<{ name: string; type: string; value: unknown; options?: ComboOption[]; min?: number; max?: number; step?: number }>;
	/** 是否 ComfyTV 选择器节点（ImagePickerStage/VideoPickerStage/AudioPickerStage）。
	 *  选择器是 no-Run 的本地节点：不显示「生成」按钮，而是显示 Pool 状态栏
	 *  （上游候选数）+ 已选缩略图 + Clear 按钮。 */
	isPicker?: boolean;
	/** spec 类型（如 ComfyTV.CropStage），用于节点级编辑器路由（内嵌 CropEditor 等）。 */
	nodeType?: string;
	/** ComfyTV stage variant（generator/loader/transform）——驱动运行按钮、prompt、
	 *  server select 的显隐。transform/loader 无运行按钮（对齐 ComfyTV StageCard.vue）。 */
	variant?: StageVariant;
	/**
	 * 「资产引用」原始 JSON（node.properties.comfytv_image_refs）。
	 *
	 * 对齐 ComfyTV ImageStage 的 asset references：stage 除了连线拿上游图，还能
	 * **钉住**任意已生成资产作为参考图，每条占一个 slot（`images.image{N}` 等），
	 * 执行时覆盖同 slot 的连线输入。见 assetRefs.ts / AssetReferences.tsx。
	 */
	assetRefsJson?: string;
	/**
	 * Agent / Skill / Tool 节点的身份标识（画布卡片富身份显示用）。
	 *
	 * ★ 这是「选了 agent/skill/tool 后丰富元信息丢失」的修复入口：卡片不再只显示
	 *   `agentId=xxx` 碎片，而是 icon + name + role + description 身份卡。原始 id
	 *   从 properties 提取（agentId / skillName / toolName），渲染层据此查
	 *   useAgentStore / usePicklistStore 拿到完整元信息（纯函数无法访问 store）。
	 */
	identity?: { type: 'agent' | 'skill' | 'tool'; id: string };
	/**
	 * 节点类型身份（无论是否已选中）。`identity` 只在已选时存在；`identityType`
	 * 始终存在，用于区分「这是 agent/skill/tool 节点但未配置」→ 卡片显示虚线
	 * 占位「＋选择」引导，而非空白。
	 */
	identityType?: 'agent' | 'skill' | 'tool';
	/**
	 * 媒体库资产 id（拖拽资产到画布时注入 node.properties.mediaAssetId）。
	 *
	 * ★★ Load 节点空白的**真凶修复**：原来 NodeCard 的 ImageLoader IIFE 里直接写
	 *   `properties['mediaAssetId']` —— 但 NodeCard 的 props 解构**没有 properties**
	 *   （getNodeCardMeta 才接收它）。自由变量被 esbuild 当全局保留原名 →
	 *   运行时 `ReferenceError: properties is not defined` → 整卡 React 渲染崩溃
	 *   → Load 节点 body 空白（editorKind/inline editor 分支其实都正常）。
	 *   日志实证（vscode-app-1787159667152.log）：
	 *   `[AS-EARLY] ReferenceError: properties is not defined 3874` ×4 = 画布上
	 *   4 个 Load 节点各崩一次。
	 */
	mediaAssetId?: string;
	/**
	 * LoadImage 节点选中的图片值（node.properties.image，data URL 或媒体 ref）。
	 *
	 * ★ ImageLoaderStage 的 image widget 类型是 IMAGE，而 toControls 对 ComfyTV
	 *   只收集 COMBO/INT/FLOAT/BOOLEAN → 该字段不进 controls。用户通过弹窗
	 *   ImageFieldEditor 选图后值落到 properties.image，但卡片内嵌预览 storedImg
	 *   的三个来源（ownSnapshots / assetUrl / controlDrafts['image']）都读不到它，
	 *   导致「选了图但卡片空白」。这里显式透传，作为 storedImg 的第 4 个来源。
	 */
	image?: string;
}

/** A COMBO option — plain string or { label, value } pair. */
export type ComboOption = string | { label: string; value: string; group?: string };

/** Types that get an inline control on the card (COMBO/INT/FLOAT/BOOLEAN). */
function toControls(spec: NodeSpec | undefined, properties: Record<string, unknown>): NodeCardMeta['controls'] {
	if (!spec?.widgets) { return undefined; }
	const list: NonNullable<NodeCardMeta['controls']> = [];
	for (const w of spec.widgets) {
		// ComfyTV 参数（workflow/resolution/aspect_ratio/batch_size）现已 DOM 化
		// （对齐 ComfyTV applyHiddenWidgetFlags：canvas widget 全 hidden，参数由
		// StageCard 渲染）。这里 ComfyTV 节点收集 COMBO/INT/FLOAT/BOOLEAN，
		// prompt（TEXT）由专门的 textarea 渲染，不进 controls。
		if (spec.comfyTV) {
			if (w.type === 'COMBO' || w.type === 'INT' || w.type === 'FLOAT' || w.type === 'BOOLEAN') {
				const propVal = properties[w.name];
				const widgetDefault = w.default;
				const resolvedVal = propVal ?? widgetDefault;
				list.push({
					name: w.name,
					type: w.type,
					value: resolvedVal,
					options: w.options,
					min: w.min,
					max: w.max,
					step: w.step,
				});
			}
			continue;
		}
		if (w.name === 'prompt') { continue; } // prompt has its own textarea
		// ★ TEXT 只对**编排节点**放行（Start 的 args、IfElse 的 evaluationTarget、
		//   Skill 的 task/skillArgs、Tool 的 toolParams…）—— 它们的参数要用 DOM 绘制。
		//   ⚠ 不能全局放行：ComfyTV loader（Video/Audio/TextLoaderStage）的 widget
		//   就是 TEXT 类型，全局放行会把它们的上传区替换成一个裸 input。
		//   （当前 comfyTV 分支已在上面 return，这里是二重保险 + 意图声明。）
		const orchRich = ORCH_RICH_NODE_TYPES.has(spec.type ?? '');
		if (w.type === 'TEXT' && !orchRich) { continue; }
		if (w.type !== 'COMBO' && w.type !== 'INT' && w.type !== 'FLOAT' && w.type !== 'BOOLEAN' && w.type !== 'TEXT') { continue; }
		// provider/model 兼容旧命名 providerId/modelId（canvas_generate 等写入）。
		const legacy = w.name === 'provider' ? properties.providerId : w.name === 'model' ? properties.modelId : undefined;
		const current = properties[w.name] ?? legacy ?? w.default;
		list.push({
			name: w.name,
			type: w.type,
			value: current,
			options: w.options,
			min: w.min,
			max: w.max,
		});
	}
	return list.length > 0 ? list : undefined;
}

/** Resolve a control's COMBO options at render time.
 *
 *  Static widgets (workflow/seed/…) keep their registered options. Provider
 *  backend nodes get LIVE options from the provider store:
 *   * `provider` / `model`     → 文生图语义（ComfyTV ModelImageGen）：模型列表
 *                                过滤 `supportsImageGen`。
 *   * `providerId` / `modelId` → **LLM 语义**（Saros.Agent）：列全部聊天模型，
 *                                **不做** supportsImageGen 过滤（对齐
 *                                NodeEditorPopup.AgentProviderModelSelect）。
 *                                键名也必须是 providerId/modelId —— 与
 *                                VSSAROS_FIELDS 一致，否则值写到读不到的键。
 *   * `agentId` / `skillName` / `toolName` → 从 agent / picklist store 取**实时**
 *                                选项（用户要求这三个参数用下拉框而非文本框）。
 *  Falls back to the current value when nothing is available (empty select
 *  would otherwise be unusable). */
export function resolveControlOptions(
	c: { name: string; type: string; options?: ComboOption[] },
	drafts: Record<string, unknown>,
	providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; supportsImageGen?: boolean; supportsVideoGen?: boolean; supportsModelGen?: boolean; supportsAudioGen?: boolean }> }>,
	picks?: {
		agents?: Array<{ id: string; name?: string; icon?: string; role?: string }>;
		skills?: Array<{ id: string; name?: string }>;
		tools?: Array<{ id: string; name: string }>;
	},
): ComboOption[] | undefined {
	if (c.type !== 'COMBO') { return c.options; }
	if (c.name === 'provider' || c.name === 'providerId') {
		const opts = providers.map(p => ({ label: p.name, value: p.id }));
		return opts.length > 0 ? opts : undefined;
	}
	if (c.name === 'model' || c.name === 'modelId') {
		// providerId ⇒ LLM（不过滤）；provider ⇒ 文生图（过滤 supportsImageGen）
		const llm = c.name === 'modelId';
		const key = llm ? 'providerId' : 'provider';
		const pid = typeof drafts[key] === 'string' ? drafts[key] as string : '';
		const p = providers.find(x => x.id === pid) ?? (pid ? undefined : providers[0]);
		const opts = (p?.models ?? [])
			.filter(m => llm || m.supportsImageGen)
			.map(m => ({ label: m.name ?? m.id, value: m.id }));
		return opts.length > 0 ? opts : undefined;
	}
	// 视频 / 3D 模型生成节点（Saros.ModelVideoGen / Saros.Model3DGen）：
	// provider 下拉列全部已认证 provider（与文生图同语义），model 下拉按
	// supportsVideoGen / supportsModelGen 过滤（模型按能力标志区分品类）。
	if (c.name === 'videoProvider' || c.name === 'm3dProvider') {
		const opts = providers.map(p => ({ label: p.name, value: p.id }));
		return opts.length > 0 ? opts : undefined;
	}
	if (c.name === 'videoModel' || c.name === 'm3dModel') {
		const key = c.name === 'videoModel' ? 'videoProvider' : 'm3dProvider';
		const flag = c.name === 'videoModel' ? 'supportsVideoGen' : 'supportsModelGen';
		const pid = typeof drafts[key] === 'string' ? drafts[key] as string : '';
		const p = providers.find(x => x.id === pid) ?? (pid ? undefined : providers[0]);
		const opts = (p?.models ?? [])
			.filter(m => (flag === 'supportsVideoGen' ? m.supportsVideoGen : m.supportsModelGen))
			.map(m => ({ label: m.name ?? m.id, value: m.id }));
		return opts.length > 0 ? opts : undefined;
	}
	// 音频生成节点（Saros.AudioGen）：provider 列全部已认证 provider，model 按
	// supportsAudioGen 过滤（音乐/音效模型按能力标志区分品类）。
	if (c.name === 'audioProvider') {
		const opts = providers.map(p => ({ label: p.name, value: p.id }));
		return opts.length > 0 ? opts : undefined;
	}
	if (c.name === 'audioModel') {
		const pid = typeof drafts.audioProvider === 'string' ? drafts.audioProvider as string : '';
		const p = providers.find(x => x.id === pid) ?? (pid ? undefined : providers[0]);
		const opts = (p?.models ?? [])
			.filter(m => m.supportsAudioGen)
			.map(m => ({ label: m.name ?? m.id, value: m.id }));
		return opts.length > 0 ? opts : undefined;
	}
	// 文本生成节点（Saros.TextGen）：chat 是模型通用能力，model 下拉不按
	// 能力标志过滤（与 llm 分支的 `m.supportsImageGen` 过滤相反，全模型可选）。
	if (c.name === 'textProvider') {
		const opts = providers.map(p => ({ label: p.name, value: p.id }));
		return opts.length > 0 ? opts : undefined;
	}
	if (c.name === 'textModel') {
		const pid = typeof drafts.textProvider === 'string' ? drafts.textProvider as string : '';
		const p = providers.find(x => x.id === pid) ?? (pid ? undefined : providers[0]);
		const opts = (p?.models ?? []).map(m => ({ label: m.name ?? m.id, value: m.id }));
		return opts.length > 0 ? opts : undefined;
	}
	// agent / skill / tool 选择器：实时列出可用项（label 带 icon 便于辨识）。
	if (c.name === 'agentId') {
		const opts = (picks?.agents ?? []).map(a => ({
			label: `${a.icon ? a.icon + ' ' : ''}${a.name ?? a.id}`,
			value: a.id,
		}));
		return opts.length > 0 ? opts : undefined;
	}
	if (c.name === 'skillName') {
		const opts = (picks?.skills ?? []).map(s => ({ label: s.name ?? s.id, value: s.id }));
		return opts.length > 0 ? opts : undefined;
	}
	if (c.name === 'toolName') {
		const opts = (picks?.tools ?? []).map(t => ({ label: t.name, value: t.id }));
		return opts.length > 0 ? opts : undefined;
	}
	return c.options;
}

// Quick actions now live in `actionSpawn.ts` (faithful port of ComfyTV
// stageActions.ts / imagePresets.ts / imageEditPresets.ts). Re-export the
// per-kind action list resolution here so the card can render them.

/** First non-empty string among candidates (skips undefined/null/''). */
function firstNonEmpty(...values: unknown[]): string {
	for (const v of values) {
		if (typeof v === 'string' && v.length > 0) { return v; }
	}
	return '';
}

/** Background color for the schema-node header chip. ComfyTV uses stage-kind
 * badges (IMAGE=purple, VIDEO=green, AUDIO=amber, TEXT=blue) so users can tell
 * node types apart at a glance. The chip itself lives next to the title in
 * NodeCard; the port dots use the same palette (see portTypeColor). */
function kindBadgeColor(stageKind: string | undefined): string {
	switch (stageKind) {
		case 'image': case 'image-batch': return '#a855f7';
		case 'video': return '#10b981';
		case 'audio': return '#f59e0b';
		case 'text': return '#3b82f6';
		default: return '#6b7280';
	}
}

/**
 * ★ 端口条（ComfyUI/litegraph 视觉对齐）：DOM 富卡（schema / fullEditor /
 * orchRich）首行渲染 in/out 胶囊 —— 色点复用 canvas slot 的 `portTypeColor`
 * （DOM 与 canvas 连线圆点同色，视觉融合为一套端口语义）。
 *
 * 为什么需要：画布上连线锚点是 canvas slot（圆点画在节点边缘，本条不承担
 * 交互），但**纯 DOM 渲染场景**（visual 截图 / 用户肉眼核对基线 PNG）没有
 * canvas 层 → 端口完全不可见。此条让卡片自带端口语义展示，两处受益：
 *   1. visual 截图含端口（R14 断言锚点）；
 *   2. 画布上参数卡与端口的关系一目了然（in 左 / out 右，类型配色）。
 */
/** 端口仅由 LiteGraph canvas 渲染（在上方「端口行」里带可连线的圆点），
 *  DOM 不再重复绘制端口胶囊——避免 schema 节点上方 canvas 端口和下方 DOM
 *  端口 chip 同时显示。CONTEXT 折叠面板（语义摘要 "N images"）仍独立
 *  显示在卡片底部，与连线锚点无关。 */


/**
 * P1: 单个 Saros 字段的卡片摘要文案。Pure。
 *   * JSON 对象字段 → 「N 个变量/参数/选项」
 *   * prompt/questionText 长文本 → 「✓ 已填」（不显示无意义碎片）
 *   * cases（Switch）→ 「N 分支」
 *   * 其余短字段 → 截断 28 字
 */function sarosFieldSummary(label: string, key: string, value: unknown): string | undefined {
	if (value === undefined || value === null || value === '') { return undefined; }
	if (key === 'variables' || key === 'skillArgs' || key === 'toolParams' || key === 'options' || key === 'args') {
		let n = 0;
		if (Array.isArray(value)) { n = value.length; }
		else if (typeof value === 'object') { n = Object.keys(value as Record<string, unknown>).length; }
		else if (typeof value === 'string' && value.trim()) {
			try { const a: unknown = JSON.parse(value); n = Array.isArray(a) ? a.length : (a && typeof a === 'object' ? Object.keys(a as Record<string, unknown>).length : 0); } catch { /* 非法 JSON → 不显示计数 */ }
		}
		const unit = key === 'variables' ? '变量' : key === 'options' ? '选项' : '参数';
		return n > 0 ? `${label}=${n} ${unit}` : undefined;
	}
	// ★ 多问题（2026-09-11）：AskUser 卡片不再渲染旧字段控件（questionText/
	//   options/multiSelect/params 已从 spec.widgets 移除，与弹窗编辑器的
	//   `questions` 是两套不同步入口）→ 这里给卡片一个有意义的摘要：
	//   「问题列表=2 个 · 选项 5」。值兼容数组（新保存）与 JSON 字符串（旧数据）。
	if (key === 'questions') {
		let n = 0;
		let optN = 0;
		let parN = 0;
		try {
			const arr: unknown = typeof value === 'string' ? JSON.parse(value) : value;
			if (Array.isArray(arr)) {
				n = arr.length;
				for (const q of arr as Array<{ options?: unknown[]; params?: unknown[] }>) {
					if (Array.isArray(q?.options)) { optN += q.options.length; }
					if (Array.isArray(q?.params)) { parN += q.params.length; }
				}
			}
		} catch { /* 非法 JSON → 不显示计数 */ }
		if (n === 0) { return undefined; }
		const detail = [optN > 0 ? `选项 ${optN}` : '', parN > 0 ? `参数 ${parN}` : ''].filter(Boolean).join(' · ');
		return `${label}=${n} 个${detail ? ` · ${detail}` : ''}`;
	}
	if (key === 'cases') {
		let n = 0;
		if (typeof value === 'string') {
			const s = value.trim();
			if (s) {
				try { const a: unknown = JSON.parse(s); n = Array.isArray(a) ? a.length : 1; }
				catch { n = s.split(',').filter(x => x.trim()).length; }
			}
		} else if (Array.isArray(value)) { n = value.length; }
		return n > 0 ? `${label}=${n} 分支` : undefined;
	}
	if (key === 'prompt' || key === 'questionText') {
		const text = String(value);
		return text.length > 16 ? `${label}=✓ 已填` : `${label}=${text}`;
	}
	const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
	const short = text.length > 28 ? `${text.slice(0, 26)}…` : text;
	return `${label}=${short}`;
}

/** Derive card display metadata from a spec + node properties. Pure, unit-testable. */
export function getNodeCardMeta(spec: NodeSpec | undefined, properties: Record<string, unknown>): NodeCardMeta {
	const isSchema = spec?.kind === 'schema';
	// Schema nodes use spec.title (e.g. "文生图") as the visible title —
	// ComfyTV's reference UI shows `▾ Image Stage` (display name, not type).
	// Other node kinds keep the previous precedence (user-editable title wins).
	const rawTitle = isSchema
		? firstNonEmpty(spec?.title, properties.title, properties.label, spec?.type, 'Node')
		: firstNonEmpty(properties.title, properties.label, spec?.title, spec?.type, 'Node');
	// Strip the "ComfyTV." / "Comfy." / "Saros." prefix when it's the type
	// string (it would look like internal implementation detail in the UI).
	const title = rawTitle.replace(/^(?:ComfyTV\.|Comfy\.|Saros\.)/i, '');
	const kind = spec?.kind ?? 'react';
	const kindLabel = kind === 'schema' ? 'schema→React' : kind === 'native' ? 'ComfyUI 原生' : kind === 'llm' ? 'Provider 文生图' : 'React';

	let widgetSummary = spec?.widgets?.length
		? spec.widgets.slice(0, 4).map(w => {
			const v = properties[w.name];
			return v === undefined ? w.name : `${w.name}=${String(v)}`;
		}).join(' · ')
		: undefined;

	// Saros (react) nodes: show a compact parameter summary from the form
	// fields (e.g. agentId / skillName / questionText) so the canvas card is
	// informative without opening the editor.
	// P1: JSON 对象字段显示「N 个变量/参数/选项」而非裸 JSON 截断；prompt 类
	// 长文本显示「✓ 已填」而非无意义的 28 字碎片。
	if (!widgetSummary && kind === 'react') {
		// ★ AskUser 多问题（2026-09-11）：`questions` 可能尚未迁移（旧节点从未打开过
		//   弹窗）→ 用 migrateAskUserQuestions 从旧字段（questionText/options/params）
		//   合成同一份数据再摘要，保证卡片与弹窗显示**完全一致**的计数。
		const props = spec?.type === 'Saros.AskUser'
			? { ...properties, questions: JSON.stringify(migrateAskUserQuestions(properties)) }
			: properties;
		const summary = buildSarosEditorFields(spec?.type ?? '').map(f => {
			const v = props[f.key];
			if (v === undefined || v === null || v === '') { return undefined; }
			return sarosFieldSummary(f.label, f.key, v);
		}).filter((s): s is string => !!s);
		if (summary.length > 0) { widgetSummary = summary.slice(0, 4).join(' · '); }
	}

	const schemaDetail = spec?.comfyTV
		? `stage: ${spec.comfyTV.stageKind ?? '?'} · wf: ${spec.comfyTV.workflowKind ?? '?'}`
		: undefined;

	// ★ Agent / Skill / Tool 节点身份（富身份卡片）。原始 id 从 properties 提取，
	//   渲染层据此查 store 拿 icon/role/description（纯函数不访问 store）。
	let identity: NodeCardMeta['identity'];
	let identityType: NodeCardMeta['identityType'];
	const nodeType = spec?.type ?? '';
	if (nodeType === 'Saros.Agent' || nodeType === 'Saros.Task') {
		identityType = 'agent';
		const id = typeof properties.agentId === 'string' ? properties.agentId : '';
		if (id) { identity = { type: 'agent', id }; }
	} else if (nodeType === 'Saros.Skill') {
		identityType = 'skill';
		const id = typeof properties.skillName === 'string' ? properties.skillName : '';
		if (id) { identity = { type: 'skill', id }; }
	} else if (nodeType === 'Saros.Tool') {
		identityType = 'tool';
		const id = typeof properties.toolName === 'string' ? properties.toolName : '';
		if (id) { identity = { type: 'tool', id }; }
	}

	return {
		title,
		kind,
		kindLabel,
		inputs: spec?.inputs ?? [],
		outputs: spec?.outputs ?? [],
		widgetSummary,
		identity,
		identityType,
		// ★ Load 节点拖入资产预览：经 meta 传递（NodeCard 无 properties props，
		//   见 NodeCardMeta.mediaAssetId 注释 —— 旧代码的自由变量 bug 修复通道）。
		mediaAssetId: typeof properties.mediaAssetId === 'string' ? properties.mediaAssetId : undefined,
		// ★ LoadImage 选图值透传（见 NodeCardMeta.image 注释）。
		image: typeof properties.image === 'string' ? properties.image : undefined,
		schemaDetail,
		stageKind: spec?.comfyTV?.stageKind,
		workflowKind: spec?.comfyTV?.workflowKind ?? spec?.comfyTV?.stageKind,
		// hasPrompt = spec 声明了 prompt 文本域（ComfyTV 的 MainPromptInput 语义）。
		// ★ 不再限定 schema：编排节点（Saros.Prompt/Agent，见 ORCH_RICH_NODE_TYPES）
		//   也要复用同一个 MentionTextarea。ComfyTV 节点若 widgets 无 prompt
		//   （如 picker/loader）则仍不显示 textarea。
		hasPrompt: (kind === 'schema' || ORCH_RICH_NODE_TYPES.has(spec?.type ?? ''))
			&& (spec?.widgets?.some(w => w.name === 'prompt') ?? false),
		prompt: (kind === 'schema' || ORCH_RICH_NODE_TYPES.has(spec?.type ?? ''))
			&& typeof properties.prompt === 'string' ? properties.prompt : undefined,
		// ★ EmojiStage cells 透传（TEXT 不进 controls，见 NodeCardMeta.cells 注释）
		cells: typeof properties.cells === 'string' ? properties.cells : undefined,
		// ★ AnimatedEmoji 每格动作描述 JSON（node.properties.cell_actions，
		//   TEXT widget 不进 controls，同 cells 先例——编辑器逐格填写的动作）
		cellActions: typeof properties.cell_actions === 'string' ? properties.cell_actions : undefined,
		// ★ AnimatedEmoji 绿幕色（STRING widget 不进 controls，同 cells 先例）
		chromaColor: typeof properties.chroma_color === 'string' ? properties.chroma_color : undefined,
		// ★ Picker 多选选中态（TEXT widget 不进 controls，同 cells 先例——见
		//   NodeCardMeta.pickerSelectedIndices 注释）
		pickerSelectedIndices: typeof properties.selected_indices === 'string' ? properties.selected_indices : undefined,
		pickerDirectRefs: typeof properties.directRefs === 'string' ? properties.directRefs : undefined,
		// ★ RelightStage lights_data 透传（hidden 字段，见 NodeCardMeta.lightsData 注释）
		lightsData: typeof properties.lights_data === 'string' ? properties.lights_data : undefined,
		mainPrompt: typeof properties.main_prompt === 'string' ? properties.main_prompt : undefined,
		// 资产引用（asset references）原始 JSON —— 存在 node.properties 上，
		// 由 AssetReferences 区块消费。ComfyTV 存的是数组，这里统一序列化成
		// 字符串传给 React（避免每次 build 产生新数组引用触发无谓重渲染）。
		assetRefsJson: (() => {
			const raw = properties[ASSET_REFS_PROP];
			if (typeof raw === 'string') { return raw; }
			if (Array.isArray(raw)) { try { return JSON.stringify(raw); } catch { return undefined; } }
			return undefined;
		})(),
		// ★ 不能限定 kind==='schema'：Crop/Rotate/Mirror/Relight/Material 等是
		//   手写 `kind:'native'` 注册，但 registerNodeSpec 已统一从 STAGE_META
		//   补全 comfyTV.stageKind（Rotate/Mirror → 'image'），
		//   `ACTIONS_BY_KIND['image']` 正是 ComfyTV 参考 UI 里那 6 个动作
		//   （Edit Image / Panorama / Multi-angle / Relight / Material / Presets）。
		//   旧的 schema 门槛把 native 挡死 → actions=undefined →
		//   **ACTIONS 区块整段不渲染**（registry.ts:135 的注释早已预言此坑）。
		//   判据改为「有没有 stageKind」，与 variant 的处理保持一致。
		actions: ACTIONS_BY_KIND[actionKeyFor(spec?.comfyTV?.stageKind) ?? ''] ?? undefined,
		// brand 同理按「是不是 ComfyTV 节点」判断，而非 kind：
		// native 注册的 ComfyTV.RotateStage 也应显示 ComfyTV 而非 ComfyUI。
		brand: (spec?.type ?? '').startsWith('ComfyTV.')
			? 'ComfyTV'
			: kind === 'schema' ? 'ComfyTV' : kind === 'native' ? 'ComfyUI' : undefined,
		controls: toControls(spec, properties),
		// ★ cell_crops 显式透传（隐藏数据，toControls 不收——见 NodeCardMeta.cellCrops）
		cellCrops: typeof properties.cell_crops === 'string' ? properties.cell_crops : undefined,
		// ComfyTV 选择器节点（*PickerStage）是 no-Run 本地节点：卡片显示 Pool
		// 状态栏而非「生成」按钮。
		isPicker: kind === 'schema' && (spec?.type ?? '').endsWith('PickerStage'),
		nodeType: spec?.type,
		// ComfyTV variant（真源 STAGE_META，registerNodeSpec 统一补全）。
		// 不能限定 kind==='schema' —— Crop/Rotate/Mirror/Relight/Material 等是
		// 手写 native 注册，限定后会回退成 generator 而错误显示运行按钮。
		variant: spec?.comfyTV?.variant ?? 'generator',
	};
}

/**
 * ★ 诊断：暂存最最近一次 meta 计算的「首字段」，便于排查 UI 消失时该节点真实数据。
 *
 * 症状："表情包节点 UI 中的内容消失" —— 节点卡容器还画着蓝边框，但内嵌编辑器、
 *      预设、网格、帧率、动态开关全没了。已知在 syncOverlay 处有"DOM 容器空 → 重挂载"
 *      的自我修复（LiteGraphCanvas.tsx:1371），但重挂载依然空白 ⇒ 怀疑 meta 计算
 *      异常或 React child 渲染抛错被 React 静默吞掉。
 *
 * 输出节制：仅当 spec.type 是已知可疑 stage 类（emoji/material/panorama…）时才打，
 *      避免普通节点也刷屏。
 */
const _diagnoseSample = { nodeId: '', nodeType: '', t: 0 };
export function diagnoseCardMeta(nodeId: string, meta: NodeCardMeta, controlsCount: number): void {
	const interesting = ['ComfyTV.StatEmojiStage', 'ComfyTV.PanoramaStage', 'ComfyTV.RotateStage', 'ComfyTV.MaterialStage', 'ComfyTV.RelightStage'];
	if (!interesting.includes(meta.nodeType ?? '')) { return; }
	const now = Date.now();
	if (now - _diagnoseSample.t < 1500) { return; } // 节流 1.5s
	_diagnoseSample.t = now;
	if (_diagnoseSample.nodeId === nodeId && _diagnoseSample.nodeType === meta.nodeType) { return; }
	_diagnoseSample.nodeId = nodeId;
	_diagnoseSample.nodeType = meta.nodeType ?? '';
	// eslint-disable-next-line no-console
	console.warn('[cardMeta] ' + JSON.stringify({
		nodeId, nodeType: meta.nodeType, kind: meta.kind, variant: meta.variant,
		hasInlineEditor: hasStageEditor(meta.nodeType),
		controls: controlsCount,
		keys: Object.keys(meta).slice(0, 8),
	}));
}

const KIND_COLOR: Record<string, string> = {
	react: '#3b82f6',
	schema: '#e879f9',
	native: '#f59e0b',
	llm: '#06b6d4',
};

/**
 * 编排节点中使用 **ComfyTV 风格 DOM 富卡片**的类型。
 *
 * ★ 定义在 `registry.ts`（底层、无 React 依赖）作单一真源 —— `sarosLiteGraphNodes`
 *   也要用它把 canvas widget 标 hidden，避免 canvas / DOM 双绘同一参数。
 *   这里 re-export 供本模块与 `LiteGraphCanvas` 使用。
 *
 * 为什么需要这个集合：ImageStage 那套 DOM UI 的所有门控（`showRun`、
 * `hasPrompt`、`isProviderImageGen`、控件行样式）原本都硬编码
 * `kind === 'schema'`，而编排节点是 `kind:'react'` —— 于是 prompt 输入框与
 * provider/model 下拉根本不渲染，只能退回 LiteGraph canvas 原生 widget
 * （窄、无 @ 提及、配色与 ComfyTV 不一致）。
 */
export { ORCH_RICH_NODE_TYPES };

/**
 * 注册为 `kind:'native'`（浏览器本地执行，非 ComfyTV schema stage）但**卡片里要渲染
 * 专用内嵌编辑器**的节点。
 *
 * 为什么需要这个集合：`showRun` 是内嵌编辑器 / 通用控件 / prompt 三者的总门控。
 * 只按 `kind === 'schema'` 判定会让这些 native 节点的 showRun 恒为 false，
 * 于是控件、编辑器、prompt 三块全部被跳过 —— 症状是**整张卡片空白**（只剩标题栏
 * 与内边距，约 10~26px 高），而不是"少了个编辑器"，极难从截图察觉。
 *
 * 新增带内嵌编辑器的 native 节点时**必须**同步登记到这里。
 * 回归守护：`visual/visual.spec.mjs` 的 `card-height-collapsed` 规则。
 */
const LOCAL_EDITOR_NODE_TYPES = new Set<string>([
	// instant 本地处理（canvas 变换）
	'ComfyTV.CropStage',
	'ComfyTV.RotateStage',
	'ComfyTV.MirrorStage',
	// Three.js / 画布类本地编辑器
	'ComfyTV.MaterialStage',        // PBR 材质球（MaterialEditor）
	'ComfyTV.RelightStage',         // 3D 灯光球（RelightEditor）
	'ComfyTV.Scene3DStage',         // 3D 场景
	'ComfyTV.LayerEditorStage',     // 图层编辑
	'ComfyTV.PosterStage',          // 海报排版
	'ComfyTV.StoryboardEditorStage',// 导演台编辑器
]);

const RUN_LABEL: Record<string, { label: string; icon: string }> = {
	image: { label: '生成图像', icon: '▶' },
	'image-batch': { label: '生成批图', icon: '▶' },
	video: { label: '生成视频', icon: '▶' },
	audio: { label: '生成音频', icon: '▶' },
	text: { label: '生成文本', icon: '▶' },
	'text-batch': { label: '生成文本批', icon: '▶' },
	panorama: { label: 'Generate Panorama', icon: '▶' },
	material: { label: 'Generate Material', icon: '▶' },
	emoji: { label: '生成表情包', icon: '▶' },
};

/** Thin ComfyTV-style progress bar (h-1.5, gradient fill + mono caption + status message). */
function RunProgress({ progress, message }: { progress: number; message?: string }): React.JSX.Element {
	// NaN 必须显式拦：`Math.min(100, NaN)` 仍是 NaN，会让 width 变成 "NaN%"
	// （CSS 视为非法 → 进度条整条不渲染）。上游 value/max 的除零已在
	// comfyRunner / taskStatus 处防住，这里是纵深防御（对齐 ComfyTV
	// progressPercentOf 的 `if (!progress || !progress.max) return 0`）。
	const safe = Number.isFinite(progress) ? progress : 0;
	const clamped = Math.max(0, Math.min(100, safe));
	return (
		<div style={{ marginTop: 6 }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
				<div style={{ flex: 1, height: 5, borderRadius: 2, overflow: 'hidden', background: 'rgba(255,255,255,.10)' }}>
					<div
						style={{
							height: '100%', width: `${clamped}%`,
							borderRadius: 2,
							background: 'linear-gradient(90deg, rgba(59,130,246,.85), rgba(59,130,246,.6))',
							transition: 'width .15s ease-out',
						}}
					/>
				</div>
				<span style={{ flexShrink: 0, minWidth: 34, fontSize: 9, textAlign: 'right', fontFamily: 'Consolas, monospace', color: 'var(--vscode-descriptionForeground, #858585)' }}>
					{Math.round(clamped)}%
				</span>
			</div>
			{message ? (
				<div style={{ marginTop: 3, fontSize: 10, lineHeight: 1.4, color: 'var(--vscode-descriptionForeground, #9a9a9a)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={message}>
					{message}
				</div>
			) : null}
		</div>
	);
}

/** ComfyTV-style error banner. */
function ErrorBanner({ message, cancel }: { message: string; cancel: boolean }): React.JSX.Element | null {
	if (!message) { return null; }
	const color = cancel ? '#f59e0b' : '#ef4444';
	return (
		<div
			// ★ 拖拽豁免标记（2026-09-08）：LiteGraphCanvas 的 dragPointerDown 在
			//   container capture 阶段把按下-移动劫持为节点拖拽——错误横幅是长文本
			//   诊断区（userSelect:text），必须允许鼠标框选复制。
			data-no-node-drag="true"
			style={{
				display: 'flex', alignItems: 'flex-start', gap: 5,
				padding: '5px 7px', borderRadius: 4, fontSize: 10, lineHeight: 1.35,
				border: `1px solid ${color}88`, background: `${color}1a`,
				color: cancel ? '#fbbf24' : '#fca5a5',
				fontFamily: 'Consolas, monospace', wordBreak: 'break-word',
				// Hard containment: the banner must never exceed the card width
				// (long JSON error bodies are a single unbreakable-ish string).
				width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
				overflowWrap: 'anywhere',
				// Card 根容器有 `pointerEvents:'none'` + `userSelect:'none'`（防止
				// canvas 事件被遮罩拦截），错误横幅是子元素必须重新打开才可交互：
				// - pointerEvents:auto  → 内部滚动/选择生效
				// - userSelect:text      → 文本可选中复制（用于查看长 JSON 错误详情）
				pointerEvents: 'auto',
				userSelect: 'text',
			}}
		>
			<span style={{ fontSize: 12, lineHeight: 1, flexShrink: 0, userSelect: 'none' }}>{cancel ? '⏹' : '⚠'}</span>
			{/* Cap the banner height + internal scroll: a long ComfyUI validation
			    dump must not stretch the whole node (height-feedback loop sizes
			    the node to the card content). 9 lines ≈ one readable paragraph;
			    the full text stays scrollable inside. */}
			<span style={{
				flex: 1, minWidth: 0, overflowWrap: 'anywhere',
				maxHeight: 120, overflowY: 'auto', display: 'block',
			}}>{message}</span>
		</div>
	);
}

/** MIME → 下载扩展名（image/gif→.gif 等；未知返回空串）。 */
const MIME_EXT: Record<string, string> = {
	'image/png': '.png', 'image/gif': '.gif', 'image/jpeg': '.jpg', 'image/webp': '.webp',
	'image/apng': '.apng', 'image/svg+xml': '.svg',
	'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
	'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
};
function extFromMime(mime: string | undefined | null): string {
	if (!mime) { return ''; }
	return MIME_EXT[mime.split(';')[0].trim().toLowerCase()] ?? '';
}

/** Derive a friendly download filename from a snapshot ref (URL or key). */
function snapshotFileName(entry: MediaSnapshotEntry): string {
	const ref = entry.media.ref;
	// ★ data URL：MIME 前缀就是真实类型（转动态表情包产物 = data:image/gif）。
	//   旧逻辑对 data URL 匹配不到文件名 → 兜底猜 .png → GIF 存成 PNG（打不开/丢动画）。
	if (ref.startsWith('data:')) {
		const comma = ref.indexOf(',');
		const mime = comma >= 5 ? ref.slice(5, comma) : '';
		const safe = entry.key.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/\.(png|jpe?g|gif|webp|mp4|bin)$/i, '');
		return `${safe}${extFromMime(mime) || '.bin'}`;
	}
	const m = /[^/?#]+\.[A-Za-z0-9]{2,5}(?:[?#]|$)/.exec(ref);
	if (m) { return m[0].replace(/[?#].*$/, ''); }
	const safe = entry.key.replace(/[^A-Za-z0-9_.-]/g, '_');
	const ext = entry.media.kind === 'image' ? '.png' : entry.media.kind === 'video' ? '.mp4' : '.bin';
	return `${safe}${ext}`;
}

/** Strip a known media extension from a filename (for ext correction). */
function stripMediaExt(name: string): string {
	return name.replace(/\.(png|jpe?g|gif|webp|apng|svg|mp4|webm|mov|mp3|wav|ogg|bin)$/i, '');
}

/** Download a snapshot: fetch URL refs, or read locally-saved payloads. */
async function downloadSnapshot(store: MediaSnapshotStore, entry: MediaSnapshotEntry): Promise<void> {
	let blob: Blob | null = null;
	const ref = entry.media.ref;
	if (/^https?:\/\//i.test(ref) || ref.startsWith('data:')) {
		try {
			// ref 可能是 ComfyUI 本地 view URL（跨源 403）→ 代理 fetch（智能降级）。
			const res = await createProxiedFetch()(ref);
			if (res.ok) { blob = await res.blob(); }
		} catch { blob = null; }
	} else {
		const data = await store.getPayload(entry.key);
		if (data != null) { blob = data instanceof Blob ? data : new Blob([data]); }
	}
	if (!blob) { return; }
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	// ★ 扩展名按**实际内容**（blob.type = 响应 content-type / data URL MIME）校正：
	//   显示为 GIF 的动图下载必须是 .gif —— 文件名兜底猜的 .png 会让浏览器/看图
	//   软件按 PNG 解码 GIF 字节（静图丢动画，部分查看器直接报错）。
	const realExt = extFromMime(blob.type);
	a.download = realExt ? `${stripMediaExt(snapshotFileName(entry))}${realExt}` : snapshotFileName(entry);
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 给 ComfyUI 的 `view?filename=…` 之类 http(s) 图片 URL 附加**版本号**，强制
 * 浏览器重新取图。纯函数。
 *
 * ★ 「重新生成后 OUTPUT 图不更新」的根因（历经 4 轮才彻底定位）：
 *   ComfyUI 的输出 URL 在很多情形下**完全相同**：
 *     - ImageStage 用 `ComfyUI_00001_.png` 之类递增文件名时，浏览器端 ref
 *       字符串确实会变（没问题）；
 *     - 但**很多**情况下 ComfyUI 覆盖同名 temp 预览（filename_prefix 固定
 *       + counter 满），URL 字符串一字不差 → 浏览器命中磁盘缓存的旧位图。
 *   加上 ImageStage 重新生成时，store.put 用相同 entry.key（`n0:images:0`），
 *   store 内部**复用旧 index**（refs.set 替换不重排），所以 `e.index` 不会
 *   自增 → 用 `e.index` 作 `_v=` 也无效。
 *
 * 唯一可靠的版本号是 **storeVersion**（订阅式 counter，put/clear 必自增）：
 *   - 同 store 引用下，每次 put 必触发 notify → useSyncExternalStore 重读
 *     getSnapshot → 返回新 counter 值；
 *   - 同一条 entry 多次渲染**不**重下载（不是 Math.random()）；
 *   - 不同次运行（即使 entry.key 与 e.index 都相同）也必然 src 变。
 *
 * `data:` / `blob:` 不加（内容寻址，且加上会破坏解析）。
 */
function bustedSrc(ref: string, _index: number | undefined, storeVersion: number | undefined): string {
	if (!ref || !/^https?:/i.test(ref)) { return ref; }
	const sep = ref.includes('?') ? '&' : '?';
	return `${ref}${sep}_t=${storeVersion ?? 0}`;
}

/**
 * Thumbnail preview — grid of all image outputs, or a label row for other media.
 *
 * ★ 版式由**输出类型**决定，而不是由图片数量决定 —— 这是 ComfyTV 的核心设计：
 *   `StageCard.vue` 恒定渲染 `<ValuePreview :type="state.outputType" …/>`，
 *   `ValuePreview.vue` 内部按 type 分支：
 *     - `COMFYTV_IMAGE`（单值，Rotate/Mirror/Crop 等 transform）→
 *       `ctv:flex-1 object-contain` **整宽大图**；
 *     - `COMFYTV_IMAGES`（批次，ImageStage 等 generator）→
 *       `ctv-batch-grid` **缩略图网格**（每格 `object-cover` + `#N` 角标）。
 *   所以 batch_size=1 的 ImageStage 在参考实现里**依然是小缩略图**，不会因为
 *   "只有一张"就变成大图。上一版按 `images.length === 1` 判定正是踩了这个坑。
 *
 * @param batch 输出是否为批次类型（`COMFYTV_IMAGES`/`*S` 复数）。由调用方从
 *              `meta.outputs[0].type` 推导后传入。
 */
function SnapshotPreview({ store, nodeId, entries: entriesProp, batch }: { store: MediaSnapshotStore; nodeId: string; entries?: MediaSnapshotEntry[]; batch?: boolean }): React.JSX.Element | null {
	// 默认读本节点快照；picker 等消费型节点通过 entries 传入上游图像（图像存在
	// producer 节点 ID 下，picker 自身快照为空 → 必须用上游 entries 才能渲染缩略图）。
	const subscribed = useNodeSnapshots(store, nodeId);
	const entries = entriesProp ?? subscribed;
	// ★★ 必须在组件**顶层**调用一次 storeVersion hook，再在下方 `.map()` 里复用。
	//   曾经在 batch-grid 的 `images.map(...)` 里直接写 `useStoreVersionLocal(store)`
	//   （bustedSrc 的 cache-bust 参数），违反 hooks 规则：运行前网格 0 张图 = 0 次
	//   hook 调用、运行后 m×n 张 = N 次调用 → React error #310「Rendered more hooks
	//   than during the previous render」→ 整棵卡片树崩溃卸载 → **节点 UI 被清空**。
	//   日志实证：vscode-app-1787377582459.log:7584/7607 `Uncaught Error: Minified
	//   React error #310`，stack 指向 `.map()` 里的 useCallback（useStoreVersion 内部）。
	const storeVersion = useStoreVersionLocal(store);
	if (entries.length === 0) { return null; }
	// ★ 过滤诊断原片（2026-09-11「OUTPUT 混入绿幕原片」）：AnimatedEmoji 把每格
	//   绿幕原片归档在 port='video'（供 ⟳ 重抠图用）——它不是产物，混进 OUTPUT
	//   网格会顶掉真正的 GIF（用户实测「9 个 GIF 没全部展示」= 网格里 5 格是
	//   黑块原片播放器）。只排除 port==='video'（其他节点的产物都在 output
	//   port 或无 port，不受影响）。
	const entriesFiltered = entries.filter(e => e.port !== 'video');
	const images = entriesFiltered.filter(e => e.media.kind === 'image');
	// ★ videoEntries（2026-09-08）：video 条目单独收集——旧逻辑 video 落 others
	//   只显示文本标签行；视频直出模式（gif_enable=false）产物必须可播放。
	//   （下方 1069 行原有的 videos 变量是 others 的旧过滤，保持不动。）
	const videoEntries = entriesFiltered.filter(e => e.media.kind === 'video');
	const others = entries.filter(e => e.media.kind !== 'image' && e.media.kind !== 'video');
	// ★ 视频直出（gif_enable=false，2026-09-08）：产物是 mp4（kind='video'）——
	//   旧逻辑 images=0 时直接落到 others 标签行，视频完全不渲染（用户实测
	//   「生成的视频没有在 output 中显示」）。单值 + 纯 video → 整宽播放器。
	if (!batch && videoEntries.length >= 1 && images.length === 0) {
		const e = videoEntries[videoEntries.length - 1];
		return (
			<div
				style={{
					position: 'relative', marginTop: 4, width: '100%',
					borderRadius: 6, overflow: 'hidden',
					border: '1px solid rgba(255,255,255,.12)', background: '#000',
					pointerEvents: 'auto',
				}}
			>
				<video
					key={e.key}
					src={bustedSrc(e.media.ref, e.index, storeVersion)}
					autoPlay loop muted controls playsInline
					onLoadedMetadata={() => { markFormHeightDirty(nodeId); }}
					style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 360, objectFit: 'contain' }}
				/>
			</div>
		);
	}
	// 单值输出（COMFYTV_IMAGE）→ 整宽大图。批次输出（COMFYTV_IMAGES）→ 下方网格。
	if (!batch && images.length >= 1) {
		const e = images[images.length - 1];
		return (
			<div
				style={{
					position: 'relative', marginTop: 4, width: '100%',
					borderRadius: 6, overflow: 'hidden',
					border: '1px solid rgba(255,255,255,.12)', background: '#000',
					pointerEvents: 'auto',
				}}
				onMouseEnter={ev => {
					const bar = ev.currentTarget.querySelector('[data-out-toolbar]') as HTMLElement | null;
					if (bar) { bar.style.opacity = '1'; }
				}}
				onMouseLeave={ev => {
					const bar = ev.currentTarget.querySelector('[data-out-toolbar]') as HTMLElement | null;
					if (bar) { bar.style.opacity = '0'; }
				}}
			>
				<img
					// key 必须跟随快照 key：没有 key 时 React 会**复用同一个 <img>
					// 元素**只改 src，浏览器在新图解码完成前继续显示旧位图 ——
					// 表现就是"重新生成后 OUTPUT 没更新"。带 key 则新图挂载新元素。
					key={e.key}
					src={bustedSrc(e.media.ref, e.index, storeVersion)}
					alt="output"
					// 图片是异步解码的：加载完成前 scrollHeight 不含它的真实高度。
					// 不在 onLoad 重新标脏，节点会停在「大图出现之前」的尺寸上把图裁掉。
					onLoad={() => { markFormHeightDirty(nodeId); }}
					style={{
						display: 'block', width: '100%', height: 'auto',
						maxHeight: 360, objectFit: 'contain',
					}}
				/>
				{/* hover 工具条（对齐 ComfyTV OUTPUT 图右上角的浮层按钮）。
				    只暴露真实已实现的能力：下载。 */}
				<div
					data-out-toolbar=""
					style={{
						position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4,
						opacity: 0, transition: 'opacity .12s',
					}}
				>
					<button
						title="下载"
						onClick={(ev) => { ev.stopPropagation(); void downloadSnapshot(store, e); }}
						style={{
							width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
							fontSize: 12, lineHeight: 1, cursor: 'pointer',
							background: 'rgba(0,0,0,.6)', color: '#fff',
							border: '1px solid rgba(255,255,255,.18)', borderRadius: 4,
						}}
					>⤓</button>
				</div>
			</div>
		);
	}
	if (images.length > 0 || videoEntries.length > 0) {
		return (
			<div style={{ marginTop: 4 }}>
				{/* BATCH 徽标：对齐 ComfyTV 的粉色 `BATCH` 药丸（右对齐于网格上方）。 */}
				{images.length + videoEntries.length > 1 && (
					<div style={{ display: 'flex', marginBottom: 3 }}>
						<span style={{
							marginLeft: 'auto', fontSize: 8, fontWeight: 700, letterSpacing: .6,
							padding: '1px 5px', borderRadius: 3,
							background: 'rgba(255,140,200,.25)', color: '#ffb0d8',
						}}>BATCH {images.length + videoEntries.length}</span>
					</div>
				)}
				{/* ctv-batch-grid：自适应列宽的方格网（每格 object-cover + #N 角标）。
				    ★ video 条目（gif_enable=false 直出的 mp4）用 <video> 循环播放。 */}
				<div style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
					gap: 4,
				}}>
				{[...images, ...videoEntries].map((e, i) => (
					<div key={e.key} style={{
						position: 'relative', aspectRatio: '1 / 1', borderRadius: 4, overflow: 'hidden',
						border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.03)',
						// thumbnails are interactive (download) even though the
						// overlay container is pointer-events:none
						pointerEvents: 'auto',
					}}>
						{e.media.kind === 'video' ? (
							<video
								key={e.key}
								src={bustedSrc(e.media.ref, e.index, storeVersion)}
								autoPlay loop muted playsInline
								style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
							/>
						) : (
							<img
								key={e.key}
								src={bustedSrc(e.media.ref, e.index, storeVersion)}
								alt="preview"
								onLoad={() => { markFormHeightDirty(nodeId); }}
								style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
							/>
						)}
						{/* `#N` 角标（ComfyTV batch cell 左下角）。 */}
						<span style={{
							position: 'absolute', left: 2, bottom: 2, padding: '0 3px', borderRadius: 2,
							fontSize: 8, fontWeight: 700, fontFamily: 'Consolas, monospace',
							background: 'rgba(0,0,0,.7)', color: '#ffb0d8', pointerEvents: 'none',
						}}>#{i + 1}</span>
						<button
							title="下载"
							onClick={(ev) => { ev.stopPropagation(); void downloadSnapshot(store, e); }}
							style={{
								position: 'absolute', right: 2, bottom: 2, width: 18, height: 18,
								display: 'flex', alignItems: 'center', justifyContent: 'center',
								fontSize: 10, lineHeight: 1, cursor: 'pointer',
								background: 'rgba(0,0,0,.7)', color: '#fff', border: 'none', borderRadius: 3,
								// ★ 常显（2026-09-08 用户需求）：hover 才显示的隐藏式交互
								//   没有被感知（用户以为没有下载功能）。
								opacity: 0.85, transition: 'opacity .12s',
							}}
							onMouseEnter={ev => { ev.currentTarget.style.opacity = '1'; }}
							onMouseLeave={ev => { ev.currentTarget.style.opacity = '0.85'; }}
						>⤓</button>
					</div>
				))}
				</div>
			</div>
		);
	}
	// ★ 视频/音频输出：渲染真正的 <video>/<audio> 播放器（vox 口播视频 final.mp4、
	//   音频 stage 的 mp3 等）。此前仅显示 emoji + ref 文本，无法播放。
	const videos = others.filter(e => e.media.kind === 'video');
	const audios = others.filter(e => e.media.kind === 'audio');
	const rest = others.filter(e => e.media.kind !== 'video' && e.media.kind !== 'audio');
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
			{videos.map((e, i) => (
				<div key={`v${i}`} style={{
					borderRadius: 6, overflow: 'hidden', background: '#000',
					border: '1px solid rgba(255,255,255,.12)', pointerEvents: 'auto',
				}}>
					<video
						key={e.key}
						controls
						preload="metadata"
						src={bustedSrc(e.media.ref, e.index, storeVersion)}
						onLoadedMetadata={() => { markFormHeightDirty(nodeId); }}
						style={{ display: 'block', width: '100%', maxHeight: 300, objectFit: 'contain' }}
					/>
					<div style={{
						display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px',
						fontSize: 8.5, fontFamily: 'Consolas, monospace',
						color: 'var(--vscode-descriptionForeground, #9a9a9a)',
						background: 'rgba(255,255,255,.04)',
					}}>
						<span>🎞</span>
						<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{e.media.ref}</span>
						<button
							title="下载"
							onClick={(ev) => { ev.stopPropagation(); void downloadSnapshot(store, e); }}
							style={{
								width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
								fontSize: 9, lineHeight: 1, cursor: 'pointer', flexShrink: 0,
								background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none', borderRadius: 3,
							}}
						>⤓</button>
					</div>
				</div>
			))}
			{audios.map((e, i) => (
				<div key={`a${i}`} style={{ border: '1px solid rgba(255,255,255,.12)', borderRadius: 6, padding: '4px 6px', background: 'rgba(255,255,255,.03)' }}>
					<audio controls preload="metadata" src={bustedSrc(e.media.ref, e.index, storeVersion)} style={{ display: 'block', width: '100%' }} />
				</div>
			))}
			{rest.map((e, i) => (
				<div key={`r${i}`} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'Consolas, monospace' }}>
					<span>📄</span>
					<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.media.ref}</span>
				</div>
			))}
		</div>
	);
}

/**
 * Picker Pool 缩略图网格（对齐 ComfyTV AssetPickerPopup 的 batch tab）：64px
 * 缩略图 + 可点选 + 单张下载 + 单张删除。
 *
 * ★ **多选**（2026-09-12 用户需求「多选图片时 UI 要有多选状态」）：每个被选中的格
 * 都画紫框 + ✓（此前只有单张高亮，用户点第 2 张时第 1 张的选中态消失）。
 * 选中判定按视图：
 *   - scope='upstream'：`selectedIndices`（0-based 池序号集合）
 *   - scope='all'      ：`selectedRefs`（ref 集合，跨节点直接输出，无需序号）
 * 写回由 `onPick` 负责（切换：已选 → 取消，未选 → 追加）。
 */
function PickerPoolGrid({ entries, selectedIndices, selectedRefs, poolScope, onPick, onRemove, store }: {
	entries: MediaSnapshotEntry[];
	selectedIndices: ReadonlySet<number>;
	selectedRefs: ReadonlySet<string>;
	poolScope: 'upstream' | 'all';
	onPick: (zeroBasedIndex: number) => void;
	/** ★ 只**发起**删除（key + ref 供确认框显示缩略图）——真正删除由确认后执行。 */
	onRemove: (key: string, ref: string) => void;
	store: MediaSnapshotStore;
}): React.JSX.Element | null {
	const images = entries.filter(e => e.media.kind === 'image');
	if (images.length === 0) { return null; }
	return (
		<div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
			{images.length > 1 && (
				<div style={{
					width: '100%', fontSize: 9, fontFamily: 'Consolas, monospace',
					color: 'var(--vscode-descriptionForeground, #858585)', marginBottom: -1,
				}}>
					BATCH: {images.length}
				</div>
			)}
			{images.map((e, i) => {
				// ★ 上游视图也认 ref（2026-09-15）：`selected_indices` 里的序号是
				//   «池内下标»，而「聊天卡勾选 → 画布同步」的 ref **可能解析不出序号**
				//   （池与候选不同源/顺序不同 ⇒ `buildPickerSelectionPatch` 按约定
				//   **不写序号**，见 canvasOps.ts）⇒ 只比序号会**整批漏高亮** ✗
				//   （用户实测：聊天卡选了 9 张，画布网格只亮 3 个）。
				//   `directRefs` 是**精确 ref 匹配**，与序号互为补集 ⇒ 取并集：
				//   · 画布点选 → 序号 + ref 都写了（主路径，行为不变）；
				//   · 外部同步 → 序号可能缺，ref 兜底 ✓。
				const isSelected = poolScope === 'all'
					? selectedRefs.has(e.media.ref)
					: (selectedIndices.has(i) || selectedRefs.has(e.media.ref));
				return (
					<div
						key={e.key}
						onClick={() => onPick(i)}
						title={isSelected ? `已选第 ${i + 1} 张（点击取消）` : `选第 ${i + 1} 张（可多选）`}
						style={{
							position: 'relative', width: 64, height: 64, borderRadius: 4, overflow: 'hidden',
							border: isSelected ? '2px solid #a855f7' : '1px solid rgba(255,255,255,.12)',
							background: 'rgba(255,255,255,.03)', cursor: 'pointer', pointerEvents: 'auto',
							boxSizing: 'border-box',
						}}
					>
						<img src={e.media.ref} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
						{isSelected && (
							<div style={{
								position: 'absolute', left: 3, top: 3, width: 16, height: 16, borderRadius: 3,
								background: '#a855f7', color: '#fff', fontSize: 10, fontWeight: 700,
								display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
							}}>✓</div>
						)}
						<div style={{ position: 'absolute', right: 2, bottom: 2, display: 'flex', gap: 2, opacity: 0, transition: 'opacity .12s' }}
							onMouseEnter={ev => { ev.currentTarget.style.opacity = '1'; }}
							onMouseLeave={ev => { ev.currentTarget.style.opacity = '0'; }}
						>
							<button
								title="删除这张图"
								onClick={(ev) => { ev.stopPropagation(); onRemove(e.key, e.media.ref); }}
								style={{
									width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
									fontSize: 10, lineHeight: 1, cursor: 'pointer',
									background: 'rgba(0,0,0,.55)', color: '#ff6b6b', border: 'none', borderRadius: 3,
								}}
							>×</button>
							<button
								title="下载"
								onClick={(ev) => { ev.stopPropagation(); void downloadSnapshot(store, e); }}
								style={{
									width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
									fontSize: 9, lineHeight: 1, cursor: 'pointer',
									background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none', borderRadius: 3,
								}}
							>⤓</button>
						</div>
					</div>
				);
			})}
		</div>
	);
}

/** Uppercase section label (ComfyTV `ctv:text-2xs ctv:uppercase ctv:tracking-wide ctv:opacity-60`). */
function SectionLabel({ children, color }: { children: React.ReactNode; color?: string }): React.JSX.Element {
	return (
		<div style={{
			// ComfyTV sectionLabel 类：text-2xs(10px) uppercase tracking-wide opacity-60 mb-[3px]
			fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', opacity: .6,
			marginBottom: 3, color: color ?? 'var(--vscode-descriptionForeground, #858585)',
			whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
		}}>
			{children}
		</div>
	);
}

/**
 * Lightweight prompt store so inline prompt edits on a card stay in sync
 * with the editor popup (and vice-versa). Plain class + React hook, mirrors
 * CardStateStore. Values are persisted into node.properties by the canvas
 * (`wf-node-prompt` handler), so the workflow save path is unchanged.
 */
class PromptStore {
	private values = new Map<string, string>();
	private listeners = new Set<() => void>();
	get(nodeId: string): string { return this.values.get(nodeId) ?? ''; }
	set(nodeId: string, prompt: string): void {
		this.values.set(nodeId, prompt);
		this.notify();
	}
	clear(nodeId: string): void {
		this.values.delete(nodeId);
		this.notify();
	}
	clearAll(): void {
		this.values.clear();
		this.notify();
	}
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	private notify(): void {
		for (const l of this.listeners) { l(); }
	}
}

let promptStoreSingleton: PromptStore | null = null;
export function getPromptStore(): PromptStore {
	if (!promptStoreSingleton) { promptStoreSingleton = new PromptStore(); }
	return promptStoreSingleton;
}



/**
 * AnimatedEmoji 逐格产物选择（纯函数；导出供单测 —— 见 workflowComfyNodeCard.test.ts）。
 *
 * 按 `meta.cellIndex` 去重（同格保留 **index 最大** = 最新），按格号升序返回。
 *
 * ★★ **绝不按数量截断**（2026-09-12 修用户反馈「生成 GIF 按钮执行完毕后，预览图
 *   没有更新」）：每格至多 1 条**本身就是正确的限量**；若再套
 *   `slice(-batchSize)`（batchSize = 当前上游格数），当**产物格数 > 上游格数**时会
 *   从**低位格**开始丢 ✗ ——
 *   实测：picker 由 9 张缩到 8 张（batchSize=8）而产物仍 9 格 → `slice(-8)` 恰好
 *   丢掉 **cell 0**；用户刚点「③ 重新生成 GIF[0]」跑完、`output` 也原地替换成功，
 *   预览却永远不更新 ✗（diag 完全吻合：`videoCells:9` 而 `gifCells:7` +
 *   `cell0.gif:false`）。
 */
export function selectEmojiCellOutputs(deduped: MediaSnapshotEntry[]): MediaSnapshotEntry[] {
	const byCell = new Map<number, MediaSnapshotEntry>();
	for (const e of deduped) {
		const ci = Number(e.media.meta?.cellIndex ?? -1);
		if (ci < 0) { continue; }
		const prev = byCell.get(ci);
		if (!prev || (prev.index ?? 0) <= (e.index ?? 0)) { byCell.set(ci, e); }
	}
	return Array.from(byCell.keys()).sort((a, b) => a - b)
		.map(ci => byCell.get(ci) as MediaSnapshotEntry);
}

/**
 * 单条 AnimatedEmoji 产物是否**过期**（与当前上游输入不匹配 → 不送入预览）。
 *
 * 判定链（纯函数；导出供单测）：
 *   1. `enabled=false`（非动态表情包节点 / 无上游输入）→ 不判过期（无可比对象）。
 *   2. 无 `cellIndex`（非逐格产物，如旧的整图路线）→ 不判过期。
 *   3. **格号越界**：`cellIndex ≥ 输入格数` → 该格在当前输入里已不存在 → 必过期
 *      （无需指纹）。★ 仅当 `upstreamRefs.length > 1`（输入确实来自独立格）时判：
 *      length===1 可能是「图集整图」兜底，其产物格号 0..N-1 合法，按 length 判会
 *      把它们全误杀 ✗。
 *   4. **无指纹**（`meta.srcSig` 缺失 = 新版执行器之前的产物）：无法证明与当前输入
 *      一致 ✗ → 若本节点已有**带指纹**的产物（说明新版跑过、输入很可能已换过）则
 *      一律判过期 ✓（fail-safe：宁可少显示 + 提示重跑，也绝不显示错图 ✗）。
 *      整节点全无指纹时**不判** —— 否则升级瞬间会清空用户既有结果 ✗。
 *   5. 有指纹 → 与当前输入指纹比对（口径必须与执行器写入侧一致：`emojiInputSigFor`）。
 */
export function isStaleEmojiArtifact(
	entry: MediaSnapshotEntry,
	opts: { enabled: boolean; upstreamRefs: readonly string[]; hasSigBearingArtifact: boolean; sheetRef?: string },
): boolean {
	if (!opts.enabled) { return false; }
	const idx = Number(entry.media.meta?.cellIndex ?? -1);
	if (idx < 0) { return false; }
	if (opts.upstreamRefs.length > 1 && idx >= opts.upstreamRefs.length) { return true; }
	const sig = entry.media.meta?.srcSig;
	if (typeof sig !== 'string' || !sig) { return opts.hasSigBearingArtifact; }
	// ★ 候选指纹 = 该格输入 **∪ 图集整图**（2026-09-12，日志实证）：
	//   旧版执行器在「连的是 image 口且上游有图集」时按**图集整图**切格生成产物
	//   （sheetOnly 路径，见 animatedEmojiExecutor 的历史注释）→ 产物 `srcSig` 记的是
	//   **图集**的指纹 ✗。若只跟「第 i 格独立格」的指纹比，这一批产物会被**全部误判
	//   过期**（用户实测：8 条视频集体隐藏、预览回到输入原图）✗✗。
	//   产物只要与**当前任一可用输入**（该格 / 图集）一致即视为有效 ✓。
	const candidates = [emojiInputSigFor(opts.upstreamRefs, idx)];
	if (opts.sheetRef) { candidates.push(emojiInputSig(opts.sheetRef)); }
	return !candidates.includes(sig);
}

/**
 * OUTPUT / 逐格预览的**条目选择**（纯函数；导出供单测）。
 *
 * 两步：① 按 `mediaDedupeKey` 去重（executor 已 put 过一次、WorkflowEditorPanel
 * 成功分支又对 `r.entries` 再 put 一次 → 同一张图会产生两条 index 不同、ref 相同
 * 的条目；不去重会让 BATCH 计数翻倍，`slice(-batchSize)` 取到的其实是副本）；
 * ② 分派：AnimatedEmoji → 逐格去重（**不截断**，见 selectEmojiCellOutputs）；
 * 其余节点 → 取最后 batchSize 条（只显示最新一次 run 的 batch，不显示历史累积）。
 */
export function selectCardOutputs(
	ownOutputs: MediaSnapshotEntry[],
	opts: { isAnimatedEmoji: boolean; batchSize: number },
): MediaSnapshotEntry[] {
	const seen = new Map<string, MediaSnapshotEntry>();
	// 保留**最后一次**出现（index 最大 = 最新），顺序按首次出现位置。
	// 去重键用 mediaDedupeKey（locator 优先）：同一张图一次物化成 data:、
	// 另一次保留 /view URL 时 ref 不同但 locator 相同，仍应视为一张。
	for (const e of ownOutputs) { seen.set(mediaDedupeKey(e.media), e); }
	const deduped = Array.from(seen.values());
	if (opts.isAnimatedEmoji) { return selectEmojiCellOutputs(deduped); }
	return deduped.slice(-opts.batchSize);
}

export interface NodeCardProps {
	meta: NodeCardMeta;
	snapshotStore?: MediaSnapshotStore;
	cardStateStore?: CardStateStore;
	nodeId?: string;
	/**
	 * 持久 stage uid —— **媒体快照的归档键**（见 stageIdentity.ts）。
	 *
	 * 必须与 `nodeId` 分离：`nodeId`（如 `rotate-stage-1`）由
	 * `canvasOps.nextNodeId()` 按「同类节点最大序号 +1」生成，**删除后会被复用**，
	 * 而快照是 IndexedDB 持久且永不淘汰的 → 新建的同类节点会读到已删除节点的
	 * 输出图。uid 用 randomUUID 且随工作流序列化，永不复用。
	 *
	 * `nodeId` 仍用于画布交互（wf-node-control 事件、markFormHeightDirty 等）。
	 */
	stageUid?: string;
	/** 选择器节点的上游节点 id 列表（用于计算 Pool 候选数）。 */
	upstreamNodeIds?: string[];
}

/**
 * [EmojiSheet] 诊断去重表：nodeId → 上次判定的签名（final/连线/计数/可疑项）。
 * 相同签名不再重复打印，避免每次渲染刷同一条日志。
 */
/** SHA-256 摘要（WebCrypto，webview 可用）：用于去背景产物记录源内容指纹。 */
async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const emojiSheetDiagSeen = new Map<string, string>();

/** [EmojiStale] 换批检测诊断去重表：nodeId → 已打印（见 isStaleArtifact 调用处）。 */
const emojiStaleDiagSeen = new Set<string>();

export function NodeCard({ meta, snapshotStore, cardStateStore, nodeId, stageUid, upstreamNodeIds }: NodeCardProps): React.JSX.Element {
	/**
	 * 媒体快照的归档键。优先用持久 uid，未提供时回退 nodeId（向后兼容：
	 * 老工作流 / 单测 / 尚未迁移的调用方）。见 NodeCardProps.stageUid 注释。
	 */
	const snapKey = stageUid ?? nodeId;
	const kindColor = KIND_COLOR[meta.kind] ?? '#888';
	const run = useNodeCardState(cardStateStore, nodeId);
	// ★ 等待用户配置（2026-09-12 用户需求：聊天卡状态实时同步到画布节点 UI）：
	//   host 在 `pauseExecution` 时把该节点标为 `awaiting-input`（AskUser / 节点交互表单 /
	//   picker 选择）→ 画布这里显示**黄色描边 + 「待配置」角标** ✓。
	//   真源是 host 的 `nodeExecutionStates` —— 本地 `cardStateStore` 没有「等用户」这个
	//   概念 ✗（它只管进度），两者是**不同维度**（本地=进度、host=执行状态），不算重复源 ✓。
	const execStatus = useWorkflowEditorStore(s => s.nodeExecutionStates[nodeId ?? '']?.status);
	// ⚠ 必须收窄成 string 再比：store 把**每节点**状态声明成了**执行级**枚举
	//   （`IWorkflowNodeExecutionState.status: WorkflowExecutionStatus` ✗），
	//   所以 TS 认为不可能等于 `'awaiting-input'`（TS2367）。语义上它就是节点状态 ✓。
	const awaitingInput = (execStatus as string | undefined) === 'awaiting-input';
	/** 描边色：待用户操作时用黄色（其余沿用节点类别色）。 */
	const edgeColor = awaitingInput ? '#fbbf24' : kindColor;
	// ★ AnimatedEmoji 覆盖默认「生成视频」（2026-09-08）：其 stageKind='video'
	//   但语义是「全部格逐格动图」，与 VideoStage 的单视频区分——
	//   「生成全部动态表情」+ 点击前归位 run_scope='all'（编辑器单格重生成会
	//   残留 run_scope='cell'，直接点卡片按钮会只跑一格）。
	const isAnimatedEmoji = meta.nodeType === 'Saros.AnimatedEmoji';
	const runLabel = isAnimatedEmoji
		? { label: '生成全部动态表情', icon: '▶' }
		: RUN_LABEL[meta.stageKind ?? ''] ?? { label: '运行', icon: '▶' };
	// ★ Agent/Skill/Tool 富身份卡：从 store 查元信息（icon/role/description/徽章）。
	//   `meta.identity` 只带原始 id（纯函数提取），此处 resolve 成完整身份对象。
	const agents = useAgentStore(s => s.agents);
	const skills = usePicklistStore(s => s.skills);
	const tools = usePicklistStore(s => s.tools);
	const identityInfo = React.useMemo(() => {
		const idn = meta.identity;
		if (!idn) { return undefined; }
		if (idn.type === 'agent') {
			const a = agents.find(x => x.id === idn.id);
			if (!a) { return { icon: '🤖', name: idn.id, role: '', description: '' }; }
			return { icon: a.icon || '🤖', name: a.name || a.id, role: a.role || '', description: a.description || '', category: a.category, skills: a.skills?.length ?? 0, tools: a.tools?.length ?? 0 };
		}
		if (idn.type === 'skill') {
			const s = skills.find(x => x.id === idn.id);
			if (!s) { return { icon: '⚡', name: idn.id, role: '', description: '' }; }
			return { icon: '⚡', name: s.name || s.id, role: s.category || s.activation || '', description: s.description || '' };
		}
		const t = tools.find(x => x.id === idn.id);
		if (!t) { return { icon: '🔧', name: idn.id, role: '', description: '' }; }
		return { icon: '🔧', name: t.name, role: '', description: t.description || '' };
	}, [meta.identity, agents, skills, tools]);
	// 选择器节点（*PickerStage）是 no-Run 本地节点：不渲染「生成」按钮，改为
	// Pool 状态栏 + 已选缩略图 + Clear（对齐 ComfyTV 的 usePickerStage）。
	// instant 节点（Crop/Rotate/Mirror）也是可运行节点：卡片内嵌编辑器 + 运行
	// 按钮（runInstantNode 本地 canvas 处理）。
	//
	// ★ showRun 同时是**内嵌编辑器 / 控件 / prompt 的总门控**（见下方各 `showRun &&`
	//   分支），所以凡是「卡片里要渲染内嵌编辑器」的节点都必须让它为 true。
	//   LOCAL_EDITOR_NODE_TYPES 收录注册为 kind='native' 但有专用内嵌编辑器的本地
	//   节点 —— 漏收录的直接症状是**整张卡片空白**（控件+编辑器+prompt 全被跳过），
	//   由 visual/visual.spec.mjs 的 card-height-collapsed 规则守护。
	const showRun = (
		meta.kind === 'schema'
		|| LOCAL_EDITOR_NODE_TYPES.has(meta.nodeType ?? '')
		// ★ 编排富卡片（Saros.Prompt/Agent）：复用 ImageStage 的 prompt textarea
		//   与 provider/model 下拉，必须让总门控为 true，否则三块全被跳过。
		|| ORCH_RICH_NODE_TYPES.has(meta.nodeType ?? '')
	) && !meta.isPicker;
	/** 是否走「编排富卡片」（DOM 控件 + 宽 label 单列，与 ImageStage 同款）。 */
	const isOrchRich = ORCH_RICH_NODE_TYPES.has(meta.nodeType ?? '');
	// 运行按钮的显隐**完全由 ComfyTV variant 驱动**（对齐 ComfyTV
	// StageCard.vue:144 的 `variant!=='loader' && variant!=='transform' && !isPicker`）：
	//   - transform（Crop/Rotate/Mirror/ColorGrade/Compare/GridSplit/Panorama*View）
	//     改参数即由 useTransformPipeline 自动重算，无需运行按钮
	//   - loader（ImageLoader/TextLoader/Relight…）内容即输出
	//   - picker 显示 Pool 状态栏
	// generator（ImageStage/VideoStage/…）保留运行按钮。
	// 注意：不要硬编码为 false —— 那会连生成节点的运行入口一起移除。
	const stageVariant: StageVariant = meta.variant ?? 'generator';
	// ★ 编排富卡片不显示 ▶ 运行按钮：Prompt 只是提示词容器，Agent 的执行由整图
	//   Run / 右键菜单驱动（showRun 为 true 仅为放开控件+prompt 渲染，见上）。
	// ★ AnimatedEmoji 也不显示（2026-09-08 用户需求「仅保留生成表情包[x] 按钮」）：
	//   编辑器内唯一运行按钮已承担 全部/多选/单格 三种粒度——卡片 RUN 按钮与其
	//   重复且语义易混（success 态显示「重新运行」像另一个功能）。
	const showRunButton = stageVariant === 'generator' && !meta.isPicker && !isOrchRich
		&& meta.nodeType !== 'Saros.AnimatedEmoji';
	// P2 engine-ready gate: schema/native nodes need a live ComfyUI runner.
	// When none is connected, show a "disconnected" placeholder + disable the
	// run button instead of an executable (but doomed) control.
	const runnerStatus = useRunnerStatus();
	const needsRunner = meta.kind === 'schema' || meta.kind === 'native';
	// ★ 渠道感知豁免（2026-09-06，对齐调度层 runSingleSchemaNode 的三态判定）：
	//   混合 backend 节点（静态/转动态表情包）在 values.backend==='provider' 时
	//   纯走 provider RPC（videogen/imagegen.generate），**不需要 ComfyUI runner**
	//   ——按钮不应显示「未连接引擎」（否则 provider 渠道被 ComfyUI 连接状态卡死）。
	//   反向（backend==='comfyui'）仍按 needsRunner 走原探测。
	// 2026-09-07：`Any` 不是 TS 类型（Python 习惯误写）→ TS2304 ×5。改为 `any`。
	const nodeBackend = useWorkflowEditorStore(
		(s: any) => (s.nodes.find((nn: any) => nn.id === nodeId)?.data as any)?.backend as string | undefined,
	);
	// ★ sheet 直通上游（2026-09-06）：sheet 输入口连线的源节点 id（画布 nodeId）。
	//   对齐调度器 runEmojiStageGrid 的 inbound 解析（workflowRun.ts：targetHandle==='sheet'
	//   → 上游 snapshotKey）——UI 预览与执行取数必须同规则，否则「预览看到的」和
	//   「实际切分的」不一致。选择器返回 string（无连线 = 空串），Object.is 稳定。
	const sheetPassthroughSource = useWorkflowEditorStore((s: any) =>
		s.edges.find((e: any) => e.target === nodeId && e.targetHandle === 'sheet')?.source ?? '',
	);
	const providerBackendExempt = nodeBackend === 'provider'
		&& (getNodeDefinition(meta.nodeType ?? '')?.providerBackendExempt === true
			|| meta.nodeType === 'ComfyTV.StatEmojiStage'
			|| meta.nodeType === 'ComfyTV.DynEmojiStage');
	const engineDisconnected = needsRunner && !runnerStatus.ready && !providerBackendExempt;
	// Provider 后端的 schema 卡片（Saros.ModelImageGen）需要动态 provider/model
	// 下拉：provider 列出已认证文生图 provider，model 随 provider 联动。
	const providers = useProviderStore(s => s.providers);
	const imageGenProviders = React.useMemo(
		() => providers.filter(p => p.authStatus === 'authenticated' && p.models.some(m => m.supportsImageGen)),
		[providers],
	);
	// ★ Agent(LLM) 用**全部**已认证 provider（不过滤 supportsImageGen）——
	//   对齐 NodeEditorPopup.AgentProviderModelSelect 的语义。若沿用
	//   imageGenProviders，纯 LLM provider（无文生图模型）会整个消失。
	const chatProviders = React.useMemo(
		() => providers.filter(p => p.authStatus === 'authenticated'),
		[providers],
	);
	// 视频 / 3D 模型生成节点（Saros.ModelVideoGen / Saros.Model3DGen）：provider
	// 下拉只列**拥有对应能力模型**的已认证 provider（模型级过滤在
	// resolveControlOptions 里按 supportsVideoGen / supportsModelGen 做）。
	const videoGenProviders = React.useMemo(
		() => providers.filter(p => p.authStatus === 'authenticated' && p.models.some(m => m.supportsVideoGen)),
		[providers],
	);
	const modelGenProviders = React.useMemo(
		() => providers.filter(p => p.authStatus === 'authenticated' && p.models.some(m => m.supportsModelGen)),
		[providers],
	);
	const audioGenProviders = React.useMemo(
		() => providers.filter(p => p.authStatus === 'authenticated' && p.models.some(m => m.supportsAudioGen)),
		[providers],
	);
	/** 该卡片控件应使用的 provider 列表（Agent=LLM，文生视频/3D/音频按能力，其余=文生图）。 */
	const controlProviders = isOrchRich
		? chatProviders
		: (meta.nodeType === 'Saros.ModelVideoGen' || meta.nodeType === 'Saros.AnimatedEmoji')
			? videoGenProviders
			: meta.nodeType === 'Saros.Model3DGen'
				? modelGenProviders
				: meta.nodeType === 'Saros.AudioGen'
					? audioGenProviders
					: imageGenProviders;
	// ★ 编排富卡片「内容消失」排障顺序（需要时临时加回诊断日志）：
	//     1. `[syncOverlay] orch node skipped` → 该类型没登记进 ORCH_RICH_NODE_TYPES；
	//     2. DOM 通路/form widget 没建立 → 卡片从未挂载；
	//     3. controls=[] → registry spec 缺 widgets 声明；
	//     4. controls 有但下拉空 → 对应 store 数据源为空（未登录 provider / 无 agent）。
	// ★★ 下拉框为空的**真因修复**：这三个 store 都是**懒加载**（`loadXxx()`
	//   幂等、需显式调用）。原先只有 `NodeEditorPopup`（双击弹窗）会触发加载，
	//   画布卡片直接读 store → 永远是空数组 → 所有下拉显示 `—`。
	//   日志实证（当时的诊断打点，现已移除）：providersAll/agents/skills/tools 全为 0，
	//   而 controls 与 DOM 通路都正常 —— 通路没问题，纯粹是数据源没拉。
	//   这里按需触发（每个 store 各自 idempotent，不会重复请求）。
	const loadAgents = useAgentStore(s => s.loadAgents);
	const loadSkills = usePicklistStore(s => s.loadSkills);
	const loadTools = usePicklistStore(s => s.loadTools);
	const loadProviders = useProviderStore(s => s.loadProviders);
	React.useEffect(() => {
		if (!isOrchRich) { return; }
		const names = new Set((meta.controls ?? []).map(c => c.name));
		if (names.has('agentId') && agents.length === 0) { void loadAgents(); }
		if (names.has('skillName') && skills.length === 0) { void loadSkills(); }
		if (names.has('toolName') && tools.length === 0) { void loadTools(); }
		if ((names.has('providerId') || names.has('modelId')) && providers.length === 0) { void loadProviders(); }
	}, [isOrchRich, meta.controls, agents.length, skills.length, tools.length, providers.length,
		loadAgents, loadSkills, loadTools, loadProviders]);
	const duration = run.durationMs != null && run.durationMs > 0
		? run.durationMs < 60000 ? `${(run.durationMs / 1000).toFixed(1)}s` : `${Math.floor(run.durationMs / 60000)}m ${Math.round((run.durationMs % 60000) / 1000)}s`
		: '';
	// ComfyTV shows `OUTPUT (TYPE)` next to the Output label. Prefer the
	// primary COMFYTV_IMAGES / COMFYTV_IMAGE output type, fall back to the
	// first output's type or the stage kind.
	const primaryOutputType = (() => {
		const outs = meta.outputs ?? [];
		const prefer = outs.find(o => o.type === 'COMFYTV_IMAGES' || o.type === 'COMFYTV_IMAGE');
		const fallback = outs[0]?.type;
		// ★ 不再剥掉 `COMFYTV_` 前缀：ComfyTV 的 i18n 模板是
		//   `stage.section.output = "OUTPUT ({type})"`，`type` 直接就是
		//   `state.outputType`（完整的 `COMFYTV_IMAGES`）。参考卡片上写的是
		//   `OUTPUT (COMFYTV_IMAGES)`，剥前缀会显示成 `OUTPUT (IMAGES)`。
		return prefer?.type ?? fallback;
	})();
	// 本节点自身的快照（订阅 store）：app 重启后 CardStateStore 是全新的内存
	// 实例（runState 回到 'idle'），但 MediaSnapshotStore 会从 IndexedDB hydrate
	// 出历史图像 ref。若仅用 runState 判定就会把已恢复的图像整块隐藏，因此这里
	// 把「已有快照」也作为显示 OUTPUT 的依据。
	const ownSnapshots = useNodeSnapshots(snapshotStore, snapKey);
	// ★ output 口快照（2026-09-02）：sheet 模式新增 port 'sheet'（整图归档）——
	//   cellRefs / OUTPUT / assetUrl 等消费处只应看到最终产物（port 'output'），
	//   否则整图会混进网格/输出区。sheetRef 单独从全量快照取。
	// ★ 只消费「最新一轮」（2026-09-03）：快照按次**追加**不清理（clearNode 只在
	//   收尾重排内做，且 hydrate 会把 IndexedDB 的历史轮全部恢复）——ownOutputs 若
	//   取全部条目，多轮执行后**旧轮格子按 key 字典序排在前面** → 网格显示上一轮
	//   的编辑产物（「重新生成后单格没初始化」）。latestRoundOf 以最新 sheet 的
	//   rows×cols 从尾部截取本轮格子，与下游转动态节点的取数规则一致。
	const latestRound = React.useMemo(
		() => (snapshotStore && snapKey ? snapshotStore.latestRoundOf(snapKey) : undefined),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[snapshotStore, snapKey, ownSnapshots],
	);
	const ownOutputs = (latestRound?.cells ?? ownSnapshots).filter(e => e.port === 'output');
	// ★ cell_crops 读取走 **meta.cellCrops 显式透传**（properties.cell_crops 每次
	//   wf-node-control 写入后 meta 重算，即时 + 重启恢复）。不能走 ctl()——
	//   cell_crops 是隐藏数据不进 meta.controls，重启后 ctl 永远回退默认等分
	//   （「重启后裁剪框回默认、下游转动态裁剪与上游不一致」根因）。
	//   也不能在此处引用 controlDrafts（其 useState 在 1740 行，此处为 TDZ）。
	const cellCropsJson = meta.cellCrops ?? '';
	// 对账日志（诊断「显示旧一轮」类问题）：条目数/轮次/sheetFull 指纹。
	React.useEffect(() => {
		if (ownSnapshots.length === 0 || !(meta.nodeType ?? '').includes('Emoji')) { return; }
		// eslint-disable-next-line no-console
		console.log(
			`[EmojiCard] snapshots=${ownSnapshots.length} round=${latestRound?.cells.length ?? 0} ` +
			`sheetFull=${(sheetFullEntry?.media.ref ?? '').slice(0, 36) || '—'} ` +
			`snapKey=${snapKey ?? '—'}`,
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ownSnapshots.length]);
	// ★ 双击表情格 → 单格编辑（拖拽/缩放裁剪框 + 橡皮擦），以 portal 独立窗口呈现
	const [editingEmojiCell, setEditingEmojiCell] = React.useState<number | null>(null);
	// 单格编辑的裁剪基底整版图 = **LLM / ComfyUI 返回的原生整图**（meta.sheetFull='1'）。
	// ★ 2026-09-03 需求变更：**不再回退**到切分后的单格图 / 合并图集（sheet='1'）——
	//   用单格图当整图会让裁剪框坐标系完全错位。无原生整图（旧版产物）→ 禁止编辑，
	//   提示用户重新生成，而不是拿错误基底凑合。
	// ★ sheetFull 取**尾部最新**（2026-09-03）：find 从头取第一个——多轮生成后
	//   旧轮的原生整图（尺寸/内容都可能不同）会永久抢占缩略图与编辑基底。
	const localSheetFull = (() => {
		for (let i = ownSnapshots.length - 1; i >= 0; i--) {
			const e = ownSnapshots[i];
			if (e.media?.kind === 'image' && isSheetFullMeta(e.media?.meta)) { return e; }
		}
		return undefined;
	})();
	// ★ sheet 直通预览（2026-09-06）：sheet 输入口连线 → 立即把上游整图图集显示
	//   在「原图」页签（编辑器默认页签即 original，连线后无需再点任何东西）。
	//   取数规则对齐执行器 runEmojiStageGrid（workflowRun.ts ~3160）：优先上游
	//   sheetFull 归档、兜底上游最新 image（外部拼贴图上游未必带 sheetFull 标注）。
	//   响应式：ownSnapshots 的订阅基于 store 全局版本号，上游归档变更同样触发
	//   本卡片重渲染 → 随渲染重新求值。
	//   ★ 直通优先于本地（2026-09-06 修正）：执行器 if (upstreamSheetRef) 位于
	//     isRecrop/重新生成之前，是无条件最高优先级；而 store.put 只追加不覆盖
	//     （mediaSnapshotStore 注释），本节点只要生成过一次 localSheetFull 就永久
	//     非空 → 旧逻辑「本地优先」会让上游新图集永不显示，且执行器把上游图写进
	//     本节点归档后直通语义丢失（只读副本变成可编辑）。此处改为直通优先，
	//     所见即所得：预览显示的图 == 执行器实际切分的图。
	const passthroughSheetFull = (() => {
		if (!sheetPassthroughSource) { return undefined; }
		const images = (snapshotStore?.byNode(sheetPassthroughSource) ?? []).filter(e => e.media?.kind === 'image');
		// 兜底「最后一张图」为兼容外部拼贴图（上游未必带 sheetFull 标注），与执行器
		// workflowRun.ts 同规则；但是否**真图集基底**由 passthroughIsSheetFull 标记，
		// 非图集基底必须禁用依赖 cell_crops 坐标系的操作（见下）。
		const hit = [...images].reverse().find(e => isSheetFullMeta(e.media?.meta));
		return (hit ?? images[images.length - 1])?.media.ref ? (hit ?? images[images.length - 1]) : undefined;
	})();
	/**
	 * 直通基底是否为**真图集原图**（meta.sheetFull='1'）。
	 * cell_crops 坐标系归属原生整图——拿普通图当基底会让单格替换/重裁全错，
	 * 故非图集基底时禁用整图编辑（onSheetEdit）。无直通（本地归档）时为 true。
	 */
	const passthroughIsSheetFull = passthroughSheetFull
		? passthroughSheetFull.media?.meta?.sheetFull === '1'
		: true;
	// ★ 抢占条件（2026-09-07 修正）：旧版 `?? localSheetFull` 让上游**任何**图
	//   （含 ImageLoader 的普通图）无条件压掉本地真图集 —— 日志可见本地
	//   own=19、localSheetFull=YES，最终却 final=PASSTHROUGH，图集 UI 显示的是
	//   一张与网格无关的普通图。直通图只有在**确属图集基底**（meta.sheetFull='1'）
	//   时才可抢占；否则本地已有图集归档时一律本地优先。
	const sheetFullEntry = (passthroughSheetFull && (passthroughIsSheetFull || !localSheetFull))
		? passthroughSheetFull
		: localSheetFull;
	// 直通条目只读：整图编辑/联动重切/去背景都会经 replaceByKey 落键——直通时
	// 该键是**上游节点**名下的归档，改写会污染上游数据。消费处按此标志禁写。
	// 注意按**实际选中**的条目判定：本地优先时基底归本地，整图编辑应重新放开。
	const sheetFullEntryIsPassthrough = passthroughSheetFull != null && sheetFullEntry === passthroughSheetFull;
	// ★ 诊断日志（2026-09-06）：定位「sheet 口传入的图集未显示在图集 UI」。
	//   覆盖整条判定链：连线源 → 别名解析 → 上游归档 → 本地抢占 → 最终取值。
	//   重点排查三处短路：
	//   ① edgeSource 为空 —— 连线未识别（targetHandle 不是 'sheet'）；
	//   ② upstream 归档为空 —— 别名未注册 / 上游归档键是 stageUid 而此处按
	//      画布 nodeId 查（byNode 靠 alias 回退，未注册即 miss）；
	//   ③ localSheetFull=YES —— 本地旧归档恒优先，上游新图集被「覆盖」（最可疑）。
	// ★ 门控按「真有 sheet 输入口」判定（2026-09-06）：Saros.AnimatedEmoji 名字含
	//   Emoji 但无 sheet 口（registry.ts 仅 images/texts），旧门控 .includes('Emoji')
	//   误命中 → 每次渲染刷一屏 final=NONE 噪音。按 inputs 含 sheet 判定后只有
	//   StatEmojiStage（及未来新增 sheet 口的节点）进入诊断，白名单零维护。
	//   （同签名去重已存在：sig/emojiSheetDiagSeen，2026-09-08 补 upstreamKeys 压缩。）
	React.useEffect(() => {
		if (!(meta.inputs ?? []).some(p => p.name === 'sheet')) { return; }
		const upstreamAll = sheetPassthroughSource ? (snapshotStore?.byNode(sheetPassthroughSource) ?? []) : [];
		const upstreamImages = upstreamAll.filter(e => e.media?.kind === 'image');
		const upstreamSheetFull = upstreamImages.filter(e => isSheetFullMeta(e.media?.meta));
		// ── 可疑判定：只有这些才 warn；正常路径走 console.log（生产被 esbuild 摇掉，
		//    不再污染 WARN 通道 —— 旧版无条件 warn，每次渲染刷一屏 final=NONE）。
		const final = sheetFullEntry ? (sheetFullEntryIsPassthrough ? 'PASSTHROUGH' : 'LOCAL') : 'NONE';
		const suspicious: string[] = [];
		if (sheetPassthroughSource && upstreamAll.length === 0) { suspicious.push('①有sheet连线但上游无快照(别名miss?)'); }
		// ② 只有「直通图真的被选中」**且上游有表情图集语义**（快照带 sheet/rows
		//   痕迹）才算可疑 —— 上游是 ImageLoader 等普通图时本来就没有 sheetFull
		//   元数据，直通是设计路径（单图模式合法工作），报「整图编辑被禁」属误报
		//   （用户实测：loader → StatEmoji 一直触发 ⚠，但功能全部正常）。
		const upstreamHasSheetSemantic = upstreamImages.some(e =>
			e.media?.meta?.sheet === '1' || e.media?.meta?.rows !== undefined);
		if (sheetPassthroughSource && upstreamImages.length > 0 && upstreamSheetFull.length === 0
			&& sheetFullEntryIsPassthrough && upstreamHasSheetSemantic) {
			suspicious.push('②上游是表情图集快照但缺sheetFull原图→直通占位致整图编辑被禁(在上游重新生成一次即可补齐)');
		}
		// ③ 只在 LOCAL 模式（编辑基底应来自本节点 sheetFull 归档）才有「重裁无
		//   基底」问题 —— passthrough 模式基底来自上游直通图，本地产物（逐格 GIF
		//   等）不需要 sheetFull，报了也是误报。
		if (ownSnapshots.length > 0 && !localSheetFull && final === 'LOCAL') { suspicious.push('③本地有产物但无sheetFull原图归档(重裁无基底)'); }
		// ── 去重：同节点同状态只打一次（避免每次渲染重复）
		const sig = `${nodeId}|${final}|${sheetPassthroughSource}|${ownSnapshots.length}|${upstreamAll.length}|${upstreamSheetFull.length}|${suspicious.join(',')}`;
		if (emojiSheetDiagSeen.get(nodeId ?? '—') === sig) { return; }
		emojiSheetDiagSeen.set(nodeId ?? '—', sig);

		// data URL 只打描述符（旧版截断 base64 仍冗余）；aliases 只打相关条目 + 总数
		// （旧版打全量 35+ 条，噪声且随节点复制无限增长，如 --dup33）。
		const desc = (e?: { media?: { ref?: string } }) => {
			const ref = e?.media?.ref ?? '';
			if (!ref) { return '—'; }
			if (ref.startsWith('data:')) { return `data:${(ref.split(',')[0] ?? '').slice(5, 22)} len=${ref.length}`; }
			return ref.slice(0, 40);
		};
		const allAliases = (snapshotStore as { aliasEntries?: () => Array<{ nodeId: string; uid: string }> } | undefined)
			?.aliasEntries?.() ?? [];
		const relatedAlias = allAliases
			.filter(a => a.nodeId === sheetPassthroughSource || a.nodeId === nodeId)
			.map(a => `${a.nodeId}→${String(a.uid).slice(0, 8)}`)
			.join(' | ') || '—';
		// ★ 日志降噪（2026-09-08）：4)upstreamKeys 巨串（历史轮全打，随运行次数
		//   无限增长）压缩为「计数 + 首 3 条」；同一签名连续重渲染只打一次。
		const upstreamKeysBrief = upstreamAll.length
			? `${upstreamAll.length} 条: ${upstreamAll.slice(0, 3).map(e => e.key).join(' | ')}${upstreamAll.length > 3 ? ' …' : ''}`
			: '—';
		const text =
			`[EmojiSheet] node=${nodeId ?? '—'} type=${meta.nodeType ?? '—'}\n` +
			`  1)edgeSource=${sheetPassthroughSource || '—(无 sheet 连线)'}\n` +
			`  2)own=${ownSnapshots.length} localSheetFull=${localSheetFull ? 'YES' : 'no'} ref=${desc(localSheetFull)}\n` +
			`  3)upstream: all=${upstreamAll.length} image=${upstreamImages.length} sheetFull=${upstreamSheetFull.length}\n` +
			`  4)upstreamKeys=${upstreamKeysBrief}\n` +
			`  5)aliases(related)=${relatedAlias} (total=${allAliases.length})\n` +
			`  6)passthrough=${passthroughSheetFull ? 'YES' : 'no'}(isSheetFull=${passthroughIsSheetFull}) ` +
			`final=${final} ref=${desc(sheetFullEntry)}` +
			(suspicious.length ? `\n  ⚠ 可疑：${suspicious.join('；')}` : '');
		if (suspicious.length) {
			// eslint-disable-next-line no-console
			console.warn(text);
		} else {
			// eslint-disable-next-line no-console
			console.log(text);   // 生产被摇掉：正常路径不进 WARN 通道
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sheetPassthroughSource, ownSnapshots.length, snapshotStore]);
	// ★ LLM 原图一键去背景（2026-09-03；2026-09-06 语义变更）：本地 rembg 抠图 →
	// 透明 PNG 写入「调整后」图集口（port 'image'，meta.sheet='1'，与单格编辑重拼
	// 同一 gKey 契约）——**原图 sheetFull 归档不动**（仍是编辑基底）。「🧩 调整后」
	// 页签直显抠图结果（棋盘底透明显效），下游转动态读取该图集即得每格透明贴纸。
	// 失败时错误经 sheetRemoveBgError 在编辑器内红条展示（服务未启动等），任何归档都不动。
	const [sheetRemovingBg, setSheetRemovingBg] = React.useState(false);
	// 去背景阶段进度（模型下载阶段为字节级百分比 → 进度条宽度；其余阶段展示文本）
	const [sheetRemoveBgStage, setSheetRemoveBgStage] = React.useState<{ text: string; percent?: number } | null>(null);
	// 去背景完成计数（成功后 +1 → 编辑器据此自动切到「🧩 调整后」页签）
	const [sheetRemoveBgDoneTick, setSheetRemoveBgDoneTick] = React.useState(0);
	// 去背景失败错误（编辑器内红条展示）：webview 会静默吞掉 window.alert，
	// 错误必须走 UI 内反馈，否则执行链失败时用户看到「点了没反应」（2026-09-06）。
	const [sheetRemoveBgError, setSheetRemoveBgError] = React.useState<string | null>(null);
	const handleSheetRemoveBg = async (algo: 'ai' | 'chroma' | 'flood' = 'ai', chromaParams?: { similarity: number; smoothness: number; greenDominance: number }) => {
		// ★ 已整体迁移至 emojiRemoveBg.ts（2026-09-09，行为不变）：此为薄委托，
		//   显式注入原闭包捕获（派生值/store/ctl/setter）。调用点 onSheetRemoveBg 签名不变。
		return runSheetRemoveBg({
			sheetFullEntry, localSheetFull, ownSnapshots, sheetFullEntryIsPassthrough,
			nodeId, snapKey, snapshotStore, sheetRemovingBg, ctl,
			setSheetRemoveBgError, setSheetRemoveBgDoneTick, setSheetRemovingBg, setSheetRemoveBgStage,
		}, algo, chromaParams);
	};
	// Esc 关闭独立编辑窗口
	React.useEffect(() => {
		if (editingEmojiCell === null) { return; }
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setEditingEmojiCell(null); } };
		window.addEventListener('keydown', onKey);
		return () => { window.removeEventListener('keydown', onKey); };
	}, [editingEmojiCell]);
	/**
	 * CONTEXT 区块的数据源：已连线的输入 slot 名。
	 *
	 * 用 `upstreamNodeIds.length` 而非逐 slot 连线信息 —— 画布只传了上游节点 id
	 * 列表（syncOverlay 机械收集所有入边）。按上游数量截取输入端口名，足以还原
	 * ComfyTV `> CONTEXT 1 image` 的展示语义；精确的 slot↔link 映射需要画布额外
	 * 传入连线明细，当前不必要。
	 */
	const contextSlots = React.useMemo(() => {
		const n = upstreamNodeIds?.length ?? 0;
		if (n === 0) { return [] as string[]; }
		const ins = meta.inputs ?? [];
		if (ins.length === 0) { return [] as string[]; }
		return ins.slice(0, Math.min(n, ins.length)).map(p => p.name);
	}, [upstreamNodeIds, meta.inputs]);
	/**
	 * 运行前校验提示（对齐 ComfyTV `missingRequiredImageSlots` / `refSlotWarnings`）。
	 * ComfyTV 在点运行**之前**就告知「缺哪个输入」；本项目此前只能点了运行等后端
	 * 报错，用户拿到的是一句没有上下文的失败信息。
	 * 仅对有运行按钮的 generator 节点显示（transform/loader 无需输入校验）。
	 */
	const preRunWarning = React.useMemo(() => {
		if (!showRunButton) { return undefined; }
		const ins = meta.inputs ?? [];
		if (ins.length === 0) { return undefined; }
		// ★ 第 4 个参数显式传空数组 = 「没有任何槽位是必填的」。
		//   ComfyTV 的必填集来自 workflow config 的 `upstream_image:*[N]` 绑定，
		//   本项目没有这份数据；用端口名启发式（"不含 optional 就算必填"）会把
		//   ImageStage 的 texts/images 判成必填，弹出**假的**
		//   「缺少输入：texts、images」——而参考卡片上 text0/image0 悬空是完全
		//   正常的（文生图工作流不消费上游图）。宁可不报，也不能误报。
		//   pin 冲突类警告（duplicate/override/overflow/noSlots）不受影响，仍会出。
		return preRunHint(ins, contextSlots, [], []);
	}, [showRunButton, meta.inputs, contextSlots]);
	/** 语义聚合摘要，如 `1 image` / `2 images, 1 mask`（对齐 ComfyTV contextSummaryOf）。 */
	const contextSummaryText = React.useMemo(() => {		const ins = meta.inputs ?? [];
		// 用端口名 + 类型一起判类别，类型更可靠（COMFYTV_IMAGE → image）。
		return contextSummary(contextSlots.map(name => {
			const t = ins.find(p => p.name === name)?.type ?? '';
			return `${name} ${t}`;
		}));
	}, [contextSlots, meta.inputs]);
	// Picker thumbnails: images are stored under the **producer** node's ID (e.g.
	// ImageStage), not under the picker's own ID. Query upstream nodes so the
	// picker can render them. 必须用订阅式 hook（usePickerSnapshots）而非
	// useMemo：生成发生在 picker spawn 之后，store 变更时只有订阅能触发重渲染，
	// 否则依赖 [snapshotStore, upstreamNodeIds] 的 useMemo 不会重算 → Pool 计数已
	// 更新但缩略图始终为空。pickerPool（下方）再对结果 merge 去重 + 新图在前。
	const pickerOutputs = usePickerSnapshots(snapshotStore, upstreamNodeIds);
	/**
	 * 「本节点已经有输出内容」——**不含**展示开关 hideOutput。
	 *
	 * ★ 必须与 `showOutput` 区分开：ACTIONS 的显示条件在 ComfyTV 里是
	 *   `state.output`（有没有产物），而 `hideOutput` 只是"这个 stage 的 OUTPUT
	 *   区块重复展示无意义、别画出来"的**版式**开关。两者混用会导致
	 *   「一旦 hideOutput 就连 ACTIONS 一起消失」。
	 *   picker 尤其明显：它是 no-Run 节点（runState 恒 idle），自身快照往往为空，
	 *   产物其实来自上游 pool → 这里把 pool 也算作有输出，ACTIONS 才会出现。
	 */
	const hasOutputContent = run.runState === 'success' || run.runState === 'error'
		|| ownOutputs.length > 0
		|| (!!meta.isPicker && pickerOutputs.length > 0);
	/**
	 * picker 家族统一 hideOutput：pool 网格本身就是 picker 的「OUTPUT」展示
	 * （对齐 ComfyTV 设计）；再画一个独立 OUTPUT 区会把同一张图显示两遍，
	 * 用户看到的就是「picker 产生了 2 个同样的图片」。
	 */
	const pickerHideOutput = meta.isPicker === true || (meta.nodeType ?? '').endsWith('PickerStage');
	// 注册表可声明 hideOutput（如 TextLoaderStage：输出即载入的文本本身，
	// OUTPUT 区重复展示无意义）——对齐 ComfyTV STAGE_CARD_PROPS。
	const showOutput = !stageCardFlags(meta.nodeType, meta.isPicker).hideOutput && hasOutputContent && !pickerHideOutput;
	// 跨节点「全部生成图」候选（对齐 ComfyTV library 资产 / pinnedBatch 跨节点
	// 引用）：整个 workflow 所有节点产出的 image entry。仅 picker 使用，惰性
	// 但订阅式（useAllSnapshots），store 变更时同样重渲染。
	const allImageOutputs = useAllSnapshots(snapshotStore, 'image');
	/* ── 资产引用（Asset References，对齐 ComfyTV ImageStage）─────────────────
	 * 数据存在 node.properties.comfytv_image_refs（JSON 字符串），经 wf-node-control
	 * 写回（与其它 DOM 控件同一通道）。候选 = 工作流内所有已生成媒体快照。 */
	const [assetRefsDraft, setAssetRefsDraft] = React.useState<AssetRef[] | null>(null);
	const assetRefs = React.useMemo<AssetRef[]>(() => {
		if (assetRefsDraft) { return assetRefsDraft; }
		if (!meta.assetRefsJson) { return []; }
		try {
			const arr = JSON.parse(meta.assetRefsJson) as unknown;
			return Array.isArray(arr) ? (arr as AssetRef[]).filter(r => typeof r?.ref === 'string' && Number.isInteger(r?.slot)) : [];
		} catch { return []; }
	}, [assetRefsDraft, meta.assetRefsJson]);
	const setAssetRefs = React.useCallback((next: AssetRef[]) => {
		setAssetRefsDraft(next);
		if (nodeId) {
			window.dispatchEvent(new CustomEvent('wf-node-control', {
				detail: { nodeId, name: ASSET_REFS_PROP, value: JSON.stringify(next) },
			}));
		}
	}, [nodeId]);
	/** 可钉/可 @ 的媒体候选（去重，最多 40 条，新图在前）。 */
	const assetCandidates = React.useMemo<AssetCandidate[]>(() => {
		const seen = new Set<string>();
		const out: AssetCandidate[] = [];
		for (const e of [...allImageOutputs].reverse()) {
			// ★ AnimatedEmoji 排除本节点产物（2026-09-08 用户反馈）：生成的动态
			//   表情 GIF 在快照里也是 kind='image'，「新图在前」排序让它永远霸占
			//   资产引用候选前排——而资产引用的语义是「钉参考图（静态贴纸）」，
			//   自己的输出永远不该成为自己的参考。
			if (isAnimatedEmoji && nodeId && e.nodeId === nodeId) { continue; }
			const ref = e.media.ref;
			if (!ref || seen.has(ref)) { continue; }
			seen.add(ref);
			out.push({ ref, kind: e.media.kind, label: `${e.port || e.media.kind} · ${ref.slice(-12)}` });
			if (out.length >= 40) { break; }
		}
		return out;
	}, [allImageOutputs, isAnimatedEmoji, nodeId]);
	/** @ 提及候选：节点（插 @[node:label]）+ 文件（钉成资产引用）。 */
	const mentionCandidates = React.useMemo<MentionCandidate[]>(() => [
		...(meta.inputs ?? []).map(p => ({ group: 'node' as const, label: p.name })),
		...assetCandidates.map(c => ({ group: 'file' as const, label: c.label, kind: c.kind, ref: c.ref })),
	], [meta.inputs, assetCandidates]);
	/** @ 选中文件 → 钉成资产引用（分配下一个空闲 slot）。 */
	const pinMentionAsset = React.useCallback((c: MentionCandidate) => {
		if (!c.ref) { return; }
		const type = c.kind === 'video' ? 'video' as const : c.kind === 'audio' ? 'audio' as const : 'image' as const;
		if (assetRefs.some(r => r.ref === c.ref)) { return; }
		const taken = new Set(assetRefs.filter(r => (r.type ?? 'image') === type).map(r => r.slot));
		let slot = 0;
		while (taken.has(slot)) { slot++; }
		setAssetRefs([...assetRefs, { ref: c.ref, slot, label: c.label, ...(type !== 'image' ? { type } : {}) }]);
	}, [assetRefs, setAssetRefs]);
	/** 资产引用区块的显示条件：ComfyTV stage 且接受图像/参考输入。 */
	const showAssetRefs = !!meta.stageKind && !meta.isPicker
		&& (meta.inputs ?? []).some(p => /IMAGE|VIDEO|AUDIO/i.test(p.type ?? ''));
	// Erase / Inpaint 内嵌 mask 编辑器 + Crop 内嵌拖拽裁剪（对齐 ComfyTV
	// StageCard 把画布渲染在卡片里，而非双击弹窗）。上游 image ref 作为
	// 涂抹/裁剪参考背景。
	const isMaskEdit = meta.kind === 'schema' && (meta.workflowKind === 'erase' || meta.workflowKind === 'inpaint');
	// Fix #3：EraseStage 的 meta.kind='image'（非 schema），但仍然需要显示上游图像作为涂抹参考。
	// 扩展 needUpstreamImage 覆盖所有需要上游图像的 consumer 节点。
	const isEraseStage = meta.nodeType === 'ComfyTV.EraseStage';
	// ── 内嵌编辑器路由：全部由 stageCardRegistry 驱动（单一数据源）──────────
	// 此前这里是 11 个 `meta.nodeType === 'ComfyTV.XxxStage'` 字面量比较 + 8 个
	// 独立的 XXX_HIDDEN_FIELDS Set，新增 stage 要改 5 处以上。现在编辑器种类、
	// 接管字段、最小高度全部查表（见 stageCardRegistry.ts）。
	const editorKind = stageEditorKind(meta.nodeType);
	/** 由内嵌编辑器接管、不渲染通用控件的字段。 */
	const hiddenFields = React.useMemo(() => stageHiddenFields(meta.nodeType), [meta.nodeType]);
	/** 是否存在内嵌编辑器（决定通用控件网格整体是否渲染）。 */
	const hasInlineEditor = editorKind !== 'none';
	const isOutpaint = editorKind === 'outpaint';
	const isCrop = editorKind === 'crop';
	const isGridSplit = editorKind === 'gridSplit';
	const isColorGrade = editorKind === 'colorGrade';
	// Rotate/Mirror 共用 TransformEditor，用 nodeType 区分 mode。
	const isRotate = meta.nodeType === 'ComfyTV.RotateStage';
	const isMirror = meta.nodeType === 'ComfyTV.MirrorStage';
	const isMultiangle = editorKind === 'multiangle';
	const isPanorama = editorKind === 'panorama';
	// KenBurns：ComfyTV KenBurnsStageCard 实际仅是滑块卡片（无专门视口编辑器），
	// 但会在顶部显示上游源图「Wire an image」预览框。
	const isKenBurns = editorKind === 'kenBurns';
	const isRelight = editorKind === 'relight';
	const isMaterial = editorKind === 'material';
	const isDirectorConsole = editorKind === 'directorConsole';
	const isEmojiStatic = editorKind === 'emoji-static';
	// ★ 动态表情包也算「emoji 卡片 RUN 语义」（2026-09-08）：RUN 按钮点击前
	//   归位 run_scope='all'（编辑器单格重生成会残留 'cell'，直接点卡片按钮
	//   会只跑一格——「生成全部动态表情」必须全量）。
	const isEmoji = isEmojiStatic || editorKind === 'animated-emoji';
	// W: Loader 内嵌预览（对齐 ComfyTV LoadImage：filename + 上传 + 缩略图 + W×H），
	//   替代通用 OUTPUT 区。
	const isImageLoader = editorKind === 'image';
	// browser-local 独立编辑器节点（native，inputs=[]）：双击打开对应编辑器。
	// 卡片上补「打开编辑器」入口（否则仅 brand + widgetSummary，用户不知道可双击）。
	// 注意：MaterialStage 现在有内联编辑器，不再在此列表中。
	const isEditorNode = (() => {
		switch (meta.nodeType) {
			// MaterialStage 现在有内联 PBR 编辑器（MaterialEditor），不再显示「打开编辑器」按钮
			case 'ComfyTV.PosterStage':
			case 'ComfyTV.LayerEditorStage':
			case 'ComfyTV.CornerPinStage':
			case 'ComfyTV.RotoMaskStage':
			case 'ComfyTV.Scene3DStage':
				return true;
			default: return false;
			}
			})();

			// 导演台内嵌时，从上游节点收集分镜（Fountain）文本，传给 DirectorConsoleEditor 自动解析成 boards。
			const storyboardFountainText = React.useMemo(
			() => (snapshotStore && upstreamNodeIds?.length ? collectUpstreamTexts(snapshotStore, upstreamNodeIds).join('\n').trim() : ''),
			[snapshotStore, upstreamNodeIds],
			);
	// 生成节点（Image/VideoStage）显示「引用」缩略图区（对齐 ComfyTV Asset
	// references：显示该节点将使用的上游参考图）。
	const isGeneratorStage = meta.nodeType === 'ComfyTV.ImageStage' || meta.nodeType === 'ComfyTV.VideoStage';
	// ★ 表情包三节点（静态/动态/转动态）都消费 images 端口参考图 —— 对齐 ComfyTV
	//   「连线 → 卡片 reference 显示上游图」的设计逻辑（此前漏在白名单外，用户
	//   连线后无法确认参考图是否生效）。用 nodeType 直判：isEmojiStatic 等定义
	//   在本行之后（TDZ）。
	const isEmojiRefConsumer = meta.nodeType === 'ComfyTV.StatEmojiStage'
		|| meta.nodeType === 'Saros.AnimatedEmoji';
	const needUpstreamImage = isMaskEdit || isCrop || isGeneratorStage || isEraseStage || isOutpaint || isGridSplit || isColorGrade || isKenBurns || isRotate || isMirror || isMultiangle || isPanorama || isRelight || isMaterial || isEmojiRefConsumer;
	// 下游编辑节点的背景图取**最新**一张（byNode 按 index 升序 = 旧的在前，
	// 最新在末尾）。重新生成 ImageStage 后，下游（Erase/Rotate/Mirror/Outpaint
	// 等）编辑器应同步刷新为最新图，而非停留在最旧的那张。订阅式
	// useSyncExternalStore + store.subscribe 保证 store.put 新 entry 时重渲染。
	const upstreamImageRef = useSyncExternalStore(
		React.useCallback((cb: () => void) => snapshotStore?.subscribe(cb) ?? (() => { /* no-op */ }), [snapshotStore]),
		React.useCallback(() => {
			if (!needUpstreamImage || !snapshotStore || !upstreamNodeIds?.length) { return undefined; }
			for (const uid of upstreamNodeIds) {
				const images = snapshotStore.byNode(uid).filter(e => e.media.kind === 'image');
				const latest = images[images.length - 1];
				if (latest) { return latest.media.ref; }
			}
			return undefined;
		}, [needUpstreamImage, snapshotStore, upstreamNodeIds]),
		() => undefined,
	);
	// 上游所有图片引用（生成节点的「引用」缩略图区；mask/crop 用第一个即可）。
	// 订阅 store 版本号（getSnapshot 返回 number，引用稳定），render 时再查数据
	// —— 避免 getSnapshot 直接返回新数组导致 React 19 useSyncExternalStore
	// 「Maximum update depth exceeded」（error #185：节点 UI 整体消失）。
	// 模式对齐 useMediaSnapshot.ts 的 useStoreVersion。
	const upstreamRefsVersion = useSyncExternalStore(
		React.useCallback((cb: () => void) => snapshotStore?.subscribe(cb) ?? (() => { /* no-op */ }), [snapshotStore]),
		React.useCallback(() => snapshotStore?.getSnapshot() ?? 0, [snapshotStore]),
		React.useCallback(() => 0, []),
	);
	void upstreamRefsVersion;
	const upstreamImageRefs: string[] = [];
	// 上游图集 meta（静态表情包 image 口合并图集 meta.sheet='1' / recrop 归档
	// 整版 meta.sheetFull='1'，均带 rows/cols）：供转动态表情包预览网格与
	// 执行器自动行列对齐。
	//
	// ★ 与 runAnimatedEmoji 执行收集同规则（2026-09-02）：快照不按 port 过滤，
	//   静态表情包节点 byNode 里同时有独立格（images 口）与图集（image 口）——
	//   「引用」区若全量显示，图集（=各格拼合版）与独立格**内容重复**。
	//   规则：独立格优先进列表；无独立格时才回退图集整图（sheet 兜底）。
	const upstreamSheetMeta = { rows: 0, cols: 0, margin: 0, ref: '' };
	if (snapshotStore && upstreamNodeIds?.length) {
		const cellRefs: string[] = [];
		for (const uid of upstreamNodeIds) {
			// ★ latestRoundOf：只取「最新一轮」格子（快照按次追加不清理，byNode
			//   会把历史轮全混进来 → 9 张旧格 + 新格 → 计数膨胀为 16/25）。
			const round = snapshotStore.latestRoundOf(uid);
			if (round.sheet && !upstreamSheetMeta.ref) {
				upstreamSheetMeta.ref = round.sheet.entry.media.ref;
				upstreamSheetMeta.rows = round.sheet.rows;
				upstreamSheetMeta.margin = round.sheet.margin;
				upstreamSheetMeta.cols = round.sheet.cols;
			}
			for (const e of round.cells) {
				if (!cellRefs.includes(e.media.ref)) { cellRefs.push(e.media.ref); }
			}
		}
		if (cellRefs.length > 0) { upstreamImageRefs.push(...cellRefs); }
		else if (upstreamSheetMeta.ref) { upstreamImageRefs.push(upstreamSheetMeta.ref); }
	}
	// ★ 换批检测（2026-09-12 用户需求「输入新的一批图片时，阶段 1-2-3 的预览图应该
	//   同步更新为新的」）：执行器归档产物时把「该格输入图指纹」写进 `meta.srcSig`；
	//   此处比对**当前**上游输入指纹 —— 不一致的产物视为**过期**，不再送入预览
	//   （于是 ①②③ 预览自动回落到新输入原图）。
	//   ★ 逐条判定（而非整格判定）：重跑阶段① 后 video 已是新指纹、而 matte/output
	//     仍是旧指纹 → 只隐藏后者，阶段① 的新原片照常显示 ✓。
	//   ★ 无 srcSig 的历史数据不判过期（向后兼容：升级瞬间不清空既有结果）。
	const canDetectStale = meta.nodeType === 'Saros.AnimatedEmoji' && upstreamImageRefs.length > 0;
	/** 本节点是否已有「带输入指纹」的产物（= 新版执行器在本节点跑过）——见下方旧产物判定。 */
	const hasSigBearingArtifact = ownSnapshots.some(e => {
		const s = e.media.meta?.srcSig;
		return typeof s === 'string' && s.length > 0;
	});
	const isStaleArtifact = (e: MediaSnapshotEntry): boolean => isStaleEmojiArtifact(e, {
		enabled: canDetectStale,
		upstreamRefs: upstreamImageRefs,
		hasSigBearingArtifact,
		// ★ 图集整图也作为候选输入（旧版执行器按图集切格生成产物，见该函数注释）
		...(upstreamSheetMeta.ref ? { sheetRef: upstreamSheetMeta.ref } : {}),
	});
	/** 含过期产物的格（用于给用户一行「输入已更换，请重跑」提示）。 */
	const staleCells = new Set<number>();
	if (canDetectStale) {
		for (const e of ownSnapshots) {
			if (!isStaleArtifact(e)) { continue; }
			const idx = Number(e.media.meta?.cellIndex ?? -1);
			if (idx >= 0) { staleCells.add(idx); }
		}
	}
	// ★ 诊断（2026-09-12）：换批检测判过期时打印**首条过期产物的指纹**与**当前输入
	//   指纹** —— 「产物明明在、却被全判过期」只能靠这两个值定位（输入真换了？还是
	//   比对口径不一致 ✗）。每个节点只打一次（`emojiSheetDiagSeen` 同款去重）。
	if (canDetectStale && staleCells.size > 0 && !emojiStaleDiagSeen.has(snapKey)) {
		emojiStaleDiagSeen.add(snapKey);
		const first = ownSnapshots.find(e => isStaleArtifact(e));
		const idx = Number(first?.media.meta?.cellIndex ?? 0);
		// 上游首个 cell 的 key/index —— 判断「输入是真被重新生成（新 key / index 更大）
		// 还是只是重新编码/水合（同 key）」，配合两个指纹定性 ✗。
		const upUid = upstreamNodeIds?.[0];
		const upRound = snapshotStore && upUid ? snapshotStore.latestRoundOf(upUid) : undefined;
		const upCell0 = upRound?.cells?.[0];
		// eslint-disable-next-line no-console
		console.warn('[AnimatedEmoji][stale] ' + JSON.stringify({
			node: snapKey, staleCells: staleCells.size, refs: upstreamImageRefs.length,
			port: first?.port ?? '', cellIndex: idx,
			artifactSig: String(first?.media.meta?.srcSig ?? ''),
			cellSig: upstreamImageRefs.length ? emojiInputSigFor(upstreamImageRefs, idx) : '',
			sheetSig: upstreamSheetMeta.ref ? emojiInputSig(upstreamSheetMeta.ref) : '',
			upCell0: upCell0 ? { key: upCell0.key, index: upCell0.index, refLen: upCell0.media.ref.length } : null,
		}));
	}
	const commitMaskField = React.useCallback((name: string, value: string) => {
		if (!nodeId) { return; }
		window.dispatchEvent(new CustomEvent('wf-node-control', { detail: { nodeId, name, value } }));
	}, [nodeId]);
	// 注意：commitCrop / commitOutpaint 定义在下方 commitControls 之后
	//（它们依赖 controlDrafts 的 setter，而 controlDrafts 在本行之后才声明）。

	// Inline prompt editor (schema stages). Value is kept in a tiny store so the
	// editor popup and the canvas card stay in sync; every edit is also bridged
	// back to node.properties.prompt (canvas → store → workflow save).
	const promptStore = getPromptStore();
	// Seed the store from meta.prompt on first mount (idempotent — only set
	// when the store has no entry yet, so later meta.prompt changes from a
	// fresh load still apply).
	React.useEffect(() => {
		if (nodeId && promptStore.get(nodeId) === '' && meta.prompt) {
			promptStore.set(nodeId, meta.prompt);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodeId, meta.prompt]);
	const promptValue = nodeId
		? useSyncExternalStore(promptStore.subscribe, () => promptStore.get(nodeId), () => meta.prompt ?? '')
		: (meta.prompt ?? '');
	const commitPrompt = React.useCallback((next: string) => {
		if (nodeId) {
			promptStore.set(nodeId, next);
			window.dispatchEvent(new CustomEvent('wf-node-prompt', { detail: { nodeId, prompt: next } }));
		}
	}, [nodeId, promptStore]);

	// Inline parameter controls (workflow/resolution/…). Local state mirrors
	// meta.controls so the card stays responsive; edits bridge back to
	// node.properties via `wf-node-control`.
	const [controlDrafts, setControlDrafts] = React.useState<Record<string, unknown>>(() => {
		const init: Record<string, unknown> = {};
		for (const c of meta.controls ?? []) { init[c.name] = c.value; }
		return init;
	});
	const commitControl = React.useCallback((name: string, value: unknown) => {
		// ★ WeixinStickerCover：切换 exportTarget → 联动同步 size/custom_width/
		//   custom_height（微信素材规格预设）。用 commitControls 语义（一次 setState
		//   合并 + 逐字段 wf-node-control），避免 N 次渲染。
		if (meta.nodeType === 'Saros.WeixinStickerCover' && name === 'exportTarget') {
			const target = WEIXIN_EXPORT_TARGETS[value as string];
			if (target) {
				const patch: Record<string, unknown> = {
					exportTarget: value,
					size: `${target.w}x${target.h}`,
					custom_width: target.w,
					custom_height: target.h,
				};
				setControlDrafts(d => ({ ...d, ...patch }));
				if (nodeId) {
					for (const [n, v] of Object.entries(patch)) {
						window.dispatchEvent(new CustomEvent('wf-node-control', { detail: { nodeId, name: n, value: v } }));
					}
				}
				return;
			}
		}
		setControlDrafts(d => ({ ...d, [name]: value }));
		if (nodeId) {
			window.dispatchEvent(new CustomEvent('wf-node-control', { detail: { nodeId, name, value } }));
		}
	}, [nodeId, meta.nodeType]);
	// 批量提交（多字段编辑器：Crop 的 x/y/w/h、Mirror 的 h/v、Outpaint 的四边…）。
	// 必须一次 setState 合并，逐个调 commitControl 会产生多次渲染且 transform
	// 管线被触发多轮。语义 = commitControl 的 N 元版本。
	const commitControls = React.useCallback((patch: Record<string, unknown>) => {
		setControlDrafts(d => ({ ...d, ...patch }));
		if (nodeId) {
			for (const [name, value] of Object.entries(patch)) {
				window.dispatchEvent(new CustomEvent('wf-node-control', { detail: { nodeId, name, value } }));
			}
		}
	}, [nodeId]);
	// widget 值的**单一读取入口**（对齐 ComfyTV useWidgetModel 的 get）：
	// 本地草稿优先，回退到 meta.controls 的初始值，再回退到调用方 fallback。
	// 此前散落 17 处 `controlDrafts[x] ?? meta.controls?.find(...)?.value`，
	// 且部分编辑器只读 meta（改完不回读草稿）→ 重挂载后显示旧值。
	const ctl = React.useCallback(<T,>(name: string, fallback: T): T => {
		const draft = controlDrafts[name];
		if (draft !== undefined && draft !== null) { return draft as T; }
		const w = meta.controls?.find(c => c.name === name)?.value;
		if (w !== undefined && w !== null) { return w as T; }
		return fallback;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [controlDrafts, meta.controls]);

	// Crop 拖拽写回 x/y/width/height。Crop 是 transform variant，必须走
	// commitControls 才能让 useTransformPipeline 感知并自动重算。
	const commitCrop = React.useCallback((rect: { x: number; y: number; width: number; height: number }) => {
		commitControls({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
	}, [commitControls]);

	// ── 参数预设（对齐 ComfyTV useStagePresets）─────────────────────────────
	// 只对有内嵌编辑器的 stage 开放 —— 通用控件卡片本来就能直接看到所有字段，
	// 加一层预设反而增加噪声；有编辑器的（Rotate/Crop/ColorGrade/Material…）
	// 参数组合复杂，才真正需要「存下来一键套回」。
	const presetsRev = useSyncExternalStore(subscribePresets, getPresetsRevision);
	const presets = React.useMemo(
		// presetsRev 作为失效信号：任一卡片保存/删除后所有同类卡片重读列表。
		() => (hasInlineEditor ? listStagePresets(meta.nodeType) : []),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[hasInlineEditor, meta.nodeType, presetsRev],
	);
	/** 预设只记录「编辑器接管的字段」，排除运行时字段（force_run_token 等）。 */
	const presetFields = React.useMemo(() => {
		const s = new Set<string>();
		for (const f of hiddenFields) {
			if (!PRESET_EXCLUDED_FIELDS.has(f)) { s.add(f); }
		}
		return s;
	}, [hiddenFields]);
	/**
	 * 当前生效的预设（值完全匹配才算）。不匹配显示「自定义」。
	 * 这就是 ComfyTV 的 dirty tracking —— 但用**派生**而非监听控件事件实现：
	 * 值本身就是真源，比维护 selectedId + suppressDirty 状态机更不易出错。
	 */
	const activePreset = React.useMemo(() => {
		if (presets.length === 0) { return undefined; }
		return findMatchingPreset(controlDrafts, presets);
	}, [controlDrafts, presets]);
	const applyPreset = React.useCallback((p: StagePreset) => {
		// 一次批量提交：只触发一轮 transform 重算。
		commitControls({ ...p.values });
	}, [commitControls]);
	const saveCurrentAsPreset = React.useCallback(() => {
		if (!meta.nodeType || presetFields.size === 0) { return; }
		const name = globalThis.prompt?.('预设名称', `预设 ${presets.length + 1}`);
		if (!name) { return; }
		saveStagePreset(meta.nodeType, name, pickPresetValues(controlDrafts, presetFields));
	}, [meta.nodeType, presetFields, presets.length, controlDrafts]);
	// Outpaint 拖拽写回 pad_left/top/right/bottom + feathering。
	const commitOutpaint = React.useCallback((patch: Partial<{ left: number; top: number; right: number; bottom: number; feathering: number }>) => {
		const nameMap: Record<string, string> = { left: 'pad_left', top: 'pad_top', right: 'pad_right', bottom: 'pad_bottom', feathering: 'feathering' };
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(patch)) { out[nameMap[k] ?? k] = v; }
		commitControls(out);
	}, [commitControls]);

	// ── transform variant：改参数即自动出图（对齐 ComfyTV useTransformPipeline）──
	// Crop/Rotate/Mirror 等 transform stage 没有运行按钮；参数或上游图变化后
	// 200ms 防抖自动重算（内部复用 runInstantNode，与手动执行同一路径）。
	// 仅对 instant（浏览器本地可算）的 transform 启用；ColorGrade/Compare 等
	// 需要后端的 transform 暂不自动触发（isInstantNode 为唯一判据）。
	const transformEnabled = stageVariant === 'transform' && !!meta.nodeType && isInstantNode(meta.nodeType);
	// 解析当前活跃 runner 的 baseUrl：transform pipeline 要 fetch
	// `${runner.baseUrl}/view?…`（来自上游节点的输出快照），硬编码 8188 在用户
	// 用 8189 / remote / LAN IP 时会让 fetch 走错端口 → TypeError: Failed to
	// fetch → 变换永远不写 snapshotStore → 卡片 OUTPUT 区块始终空。baseUrl
	// 缺失（用户还没连 runner）时退化为 8188 默认值（runInstantNode 内部会因
	// 找不到 runner 而 early-return，不会发起 fetch）。
	const activeRunnerBase = React.useMemo(() => {
		try {
			const reg = getActiveRunnerRegistry();
			const r = reg?.resolve(getActiveRunnerPreference());
			return r?.baseUrl;
		} catch {
			return undefined;
		}
	}, []);
	// memo 化：createProxiedFetch() 每次调用都新建实例，不缓存会让 fetchImpl
	// 引用每帧变化（虽然管线把它放在 ref 里，稳定引用仍更安全）。
	const transformFetch = React.useMemo(
		() => createProxiedFetch(activeRunnerBase) as unknown as typeof fetch,
		[activeRunnerBase],
	);
	const transform = useTransformPipeline({
		nodeId: snapKey,
		nodeType: meta.nodeType,
		values: controlDrafts,
		upstreamImageRef,
		upstreamNodeIds,
		snapshotStore,
		enabled: transformEnabled,
		// 上游图是 ComfyUI view URL，webview 沙箱内必须走代理 fetch，
		// 否则跨源被拦 → TypeError: Failed to fetch。
		fetchImpl: transformFetch,
	});

	/**
	 * transform 单行状态（对齐 ComfyTV RotateStageCard / MirrorStageCard 的
	 * `computing / applied / adjustToApply` 三态小字，夹在预览与控件之间）。
	 *
	 * 文案按 mode 区分，与 ComfyTV 的 `rotate.applied` / `mirror.applied`
	 * 一致（"Rotation applied — ready for downstream" /
	 * "Mirror applied — ready for downstream"）。
	 */
	const transformStatus = React.useMemo((): { text: string; tone: 'muted' | 'success' | 'error' } => {
		if (transform.phase === 'error') {
			return { text: transform.error ?? '变换失败', tone: 'error' };
		}
		if (transform.phase === 'applied') {
			const what = meta.nodeType === 'ComfyTV.RotateStage'
				? 'Rotation applied'
				: meta.nodeType === 'ComfyTV.MirrorStage'
					? 'Mirror applied'
					: '已应用';
			return { text: `${what} — ready for downstream`, tone: 'success' };
		}
		return { text: transformPhaseLabel(transform.phase, !!upstreamImageRef), tone: 'muted' };
	}, [transform.phase, transform.error, meta.nodeType, upstreamImageRef]);

	// 生成节点（ImageStage 等）的 OUTPUT 区只显示**最新一次 run**的 batch（batch_size
	// 张），而非全部累积历史。ownSnapshots 累积了所有历史（每次 run 追加、index 递增），
	// 若直接渲染会「batch_size=1 却显示 5 张」（多次点击的历史累积，被误认为 batch_size
	// 失效）。picker pool 才累积显示全部历史，两者语义不同。取最后 batchSize 张。
	//
	// ★ EmojiStage 例外：它没有 `batch_size` widget（网格由 runEmojiStageGrid 循环
	//   驱动、每格 batch_size 固定 1），一次「生成全部」产出 rows×cols 张。若沿用
	//   `batch_size ?? 1` 会让 OUTPUT 只显示最后 1 张（用户实测 2×2 只见 1 图）。
	const batchSize = React.useMemo(() => {
		// 静态网格：batch = rows*cols；动态节点单产出，batch = 1。
		if (isEmojiStatic) {
			const r = Math.max(1, Number(controlDrafts['rows'] ?? 3) || 3);
			const c = Math.max(1, Number(controlDrafts['cols'] ?? 3) || 3);
			return Math.max(1, r * c);
		}
		// ★ 转动态表情包（逐格模式 2026-09-07）：每个上游格产出 1 张 GIF，
		//   batch = 上游格数（沿用 batch_size??1 会让 OUTPUT 只显示最后 1 张）。
		if (meta.nodeType === 'Saros.AnimatedEmoji') {
			return Math.max(1, upstreamImageRefs.length);
		}
		return Math.max(1, Number(controlDrafts['batch_size'] ?? 1) || 1);
	}, [isEmojiStatic, controlDrafts, upstreamImageRefs]);
	/**
	 * StatEmojiStage 的 workflow 模板名列表，透传给 StatEmojiStageEditor 自行渲染下拉。
	 * 直接复用 registry 已声明的 COMBO options（`workflowOptionsFor('emoji')`），
	 * 无需在此再 import 一次模板表。动态节点不使用模板下拉（单一绿幕流水线）。
	 */
	const emojiWorkflowOptions = React.useMemo(() => {
		if (!isEmojiStatic) { return undefined; }
		const c = (meta.controls ?? []).find(x => x.name === 'workflow');
		const opts = (c?.options ?? []).map(o => (typeof o === 'string' ? o : String(o?.value ?? o?.label ?? '')))
			.filter(s => s.length > 0);
		return opts.length > 0 ? opts : undefined;
	}, [isEmoji, meta.controls]);
	/**
	 * 输出是否为**批次**类型（决定 OUTPUT 用网格还是大图，见 SnapshotPreview）。
	 * 判据取第一个输出端口的类型是否为复数（`COMFYTV_IMAGES` / `*S`），
	 * 对齐 ComfyTV `ValuePreview` 的 type 分支。
	 */
	const isBatchOutput = React.useMemo(() => {
		const t = (meta.outputs?.[0]?.type ?? '').toUpperCase();
		return t.endsWith('IMAGES') || t.endsWith('VIDEOS') || t.endsWith('AUDIOS');
	}, [meta.outputs]);
	// ★ 选择逻辑抽到 `selectCardOutputs`（纯函数，可单测）—— 历史上两次「预览不
	//   更新」都出在这里（`slice(-batchSize)` 丢低位格 / 同格取到旧条目）。
	const latestOutputs = React.useMemo(
		() => selectCardOutputs(ownOutputs, { isAnimatedEmoji, batchSize }),
		[ownOutputs, batchSize, isAnimatedEmoji],
	);

	// ── Picker Pool（对齐 ComfyTV usePickerStage + mergeImagePool）──
	// pool 有两个来源：'upstream'（直接上游，默认，selected_index 相对上游
	// batch 索引）与 'all'（跨节点全部生成图，directRef 直接输出 ref）。对齐
	// ComfyTV 的 batch tab（上游）+ library tab（全局资产）双视图。
	const [poolScope, setPoolScope] = React.useState<'upstream' | 'all'>('upstream');
	// pickerOutputs（上方 usePickerSnapshots）是上游所有 entry 的聚合；这里再
	// merge 去重 + 新图在前，得到稳定的 pool（ComfyTV 的 pool 是 picker 自身
	// widget，本项目实时聚合上游，语义等价）。'all' 视图则聚合跨节点 image。
	// ★ `poolScope === 'all'` 视图去重时也别把「上游视图」和「全图视图」合并——
	//   跨节点 ref 串味会让"两张重复图"出现在 pool 中：
	//   场景：节点 A 生成了 imageX，节点 B 同时把 imageX 复制成了它自己的输出；
	//   合并视图下同一 ref 在 A、B 各被 put 一次 → 渲染两遍。这里每个视图内部
	//   各自去重，跨 ref 重复靠 store 分配 key 区分即可。
	const pickerPool = React.useMemo(
		() => (meta.isPicker ? mergeImagePool(poolScope === 'all' ? allImageOutputs : pickerOutputs) : []),
		[meta.isPicker, poolScope, pickerOutputs, allImageOutputs],
	);
	// ★ 实时订阅 store 的 node.data（2026-09-15 修「聊天卡勾选 picker 候选 → 画布节点
	//   不实时同步」）。`meta` 是**挂载期**由 `getNodeCardMeta(spec, props)` 冻结的快照，
	//   而外部写入（host canvas op `select_picker_refs` → `applyCanvasOpsToStore`）只写
	//   store 的 `node.data`、**不 remount 卡片** ⇒ 高亮永远停在旧值 ✗。订阅 store 后
	//   `setNodes` 立即触发重渲染（selector 返回标量，其余节点的写入不会误触发）。
	const livePickerSel = useWorkflowEditorStore(s => {
		const d = s.nodes.find(n => n.id === nodeId)?.data as Record<string, unknown> | undefined;
		const v = d?.['selected_indices'];
		return typeof v === 'string' ? v : undefined;
	});
	const livePickerRefs = useWorkflowEditorStore(s => {
		const d = s.nodes.find(n => n.id === nodeId)?.data as Record<string, unknown> | undefined;
		const v = d?.['directRefs'];
		return typeof v === 'string' ? v : undefined;
	});
	// ── picker 多选（2026-09-12 用户需求「多选图片时 UI 要有多选状态」）──────
	// 读取顺序：store node.data（**真源**，外部改选实时跟手）→ 本地草稿（刚点完的乐观值）
	// → meta 透传（重挂载后从 properties 恢复）→ 旧字段 `selected_index` / `directRef`
	// （**向后兼容**：老工作流只存了单张，按「单选 = 只选中那一张」解释）。
	// ⚠ store 值必须放在草稿**之前**：先画布点选（草稿有值）再由聊天卡改选时，草稿会
	//   一直压住新值 ⇒ 又变成"不同步" ✗。store 由两条写路径共同维护（画布 `wf-node-control`
	//   → `applyNodeControl`；外部 canvas op → `applyCanvasOpsToStore`），故它总是最新 ✓。
	const pickerSelIndicesRaw = (livePickerSel ?? controlDrafts['selected_indices'] ?? meta.pickerSelectedIndices ?? '') as string;
	const pickerDirectRefsRaw = (livePickerRefs ?? controlDrafts['directRefs'] ?? meta.pickerDirectRefs ?? '') as string;
	/** 当前选中项（ComfyTV selected_index，1-based）。执行器兜底 / 旧数据兼容用。 */
	const selectedIndex = React.useMemo(() => {
		if (!meta.isPicker) { return 1; }
		const v = controlDrafts['selected_index'];
		const n = Number(v);
		return Number.isInteger(n) && n >= 1 ? n : 1;
	}, [meta.isPicker, controlDrafts]);
	// 当前 directRef（'all' 视图主选，字符串 ref）。
	const directRef = React.useMemo(() => {
		const v = controlDrafts['directRef'];
		return typeof v === 'string' ? v : '';
	}, [controlDrafts]);
	/** 上游池视图的**全部**选中序号（0-based）；空则回退单选的 selected_index。 */
	const pickerSelectedIndices = React.useMemo<number[]>(() => {
		if (!meta.isPicker) { return []; }
		const arr = parsePickerIndexList(pickerSelIndicesRaw);
		return arr.length > 0 ? arr : [selectedIndex - 1];
	}, [meta.isPicker, pickerSelIndicesRaw, selectedIndex]);
	/** 「全部」视图的全部选中 ref；空则回退单选的 directRef。 */
	const pickerSelectedRefs = React.useMemo<string[]>(() => {
		const arr = parsePickerRefList(pickerDirectRefsRaw);
		return arr.length > 0 ? arr : (directRef ? [directRef] : []);
	}, [pickerDirectRefsRaw, directRef]);
	const pickerSelIndexSet = React.useMemo(() => new Set(pickerSelectedIndices), [pickerSelectedIndices]);
	const pickerSelRefSet = React.useMemo(() => new Set(pickerSelectedRefs), [pickerSelectedRefs]);
	/**
	 * ★ **点选即发布**（2026-09-12 修用户反馈「picker 多选图像，下游动态表情包中
	 *   参考图像没有更新」）。
	 *
	 * 根因：picker 是 **no-Run 节点**（`showRunButton = … && !meta.isPicker`，卡片
	 * 没有运行按钮）→ 点选此前只派发 `wf-node-control` 写 widget 值，**快照库完全
	 * 不动** ✗。而下游一律从 `store.byNode(pickerUid)` 取上游（动态表情包取参考图、
	 * 画布物化、`collectUpstreamValues`…）→ 拿到的永远是**上一次运行**的旧选择 ✗
	 * （日志实证：`workflow.nodeValuesChanged` 写了 selected_indices/directRefs，
	 * 但没有任何快照写入）。ComfyTV 原版 `usePickerStage` 是响应式发布（watch 选中
	 * 即写），本函数即该语义。
	 *
	 * ★ 传**新值**而非 `controlDrafts`：`setControlDrafts` 是异步的，此处 drafts
	 *   仍是旧值 → 会发布上一次的选择 ✗。
	 * ★ 失败静默：选中态已落盘，用户重跑 picker 仍可恢复；点选不该因发布失败弹错。
	 */
	const publishPickerSel = React.useCallback((values: Record<string, unknown>) => {
		if (!meta.isPicker || !snapshotStore || !nodeId) { return; }
		void publishPickerSelection({
			store: snapshotStore,
			snapKey: snapKey ?? nodeId,
			type: meta.nodeType ?? '',
			values,
			upstreams: upstreamNodeIds,
		}).catch(() => { /* 静默：见上 */ });
	}, [meta.isPicker, meta.nodeType, snapshotStore, nodeId, snapKey, upstreamNodeIds]);
	/**
	 * 点选第 N 张（0-based）—— **切换**语义（多选）：已选 → 取消；未选 → 追加。
	 * 同时写「数组字段」（多选真源）+「单值字段」（主选 = 第一张；旧调用方 / 执行器
	 * 兜底仍读它）。取消到空集 → 单值复位为第 1 张（执行器按第 1 张兜底，与 Clear 一致）。
	 */
	const pickImage = React.useCallback((poolIndexZeroBased: number) => {
		if (poolScope === 'all') {
			const e = pickerPool[poolIndexZeroBased];
			if (!e) { return; }
			const ref = e.media.ref;
			const next = pickerSelectedRefs.includes(ref)
				? pickerSelectedRefs.filter(r => r !== ref)
				: [...pickerSelectedRefs, ref];
			// ★ `directRefs` = **唯一真源**（ref 数组）：画布物化 / runPickerNode 只认它。
			//   'all' 视图下 `selected_indices` 无意义（跨节点 ref 不在上游池内，算不出
			//   序号）→ 清空，否则残留序号会被「上游」视图错误高亮到别的格子 ✗。
			const patch = {
				directRefs: next.length > 0 ? JSON.stringify(next) : '',
				directRef: next[0] ?? '',
				selected_indices: '',
				selected_index: 1,
			};
			commitControls(patch);
			// ★ 点选即发布（见 publishPickerSel 注释）：否则下游读到的还是旧快照 ✗
			publishPickerSel(patch);
			return;
		}
		const targetEntry = pickerPool[poolIndexZeroBased];
		const targetRef = targetEntry?.media.ref;
		const hasTargetRef = typeof targetRef === 'string' && targetRef.length > 0;
		// ★★ 「视觉选中」= **序号命中 ∪ ref 命中**（与网格 `isSelected` 同判据，2026-09-15）：
		//   外部同步（聊天卡勾选）写进来的 ref **可能解析不出池内序号**（池与候选不同源 /
		//   顺序不同 ⇒ `buildPickerSelectionPatch` 按「绝不猜序号」约定不写序号）⇒
		//   只比序号会让「点一下取消」**首次无效** ✗（用户实测：聊天卡选 9 张、画布只亮 3 个）。
		const visualSelected = pickerSelectedIndices.includes(poolIndexZeroBased)
			|| (hasTargetRef && pickerSelectedRefs.includes(targetRef));
		// ★★ 增删一律以 **ref 集合**为准（`directRefs` 才是下游唯一认的字段：画布物化 /
		//   runPickerNode；`selected_indices` 只是本视图的高亮辅助）——否则取消一张就会把
		//   「解析不出序号的那些 ref」整批丢掉（refs 缩水 ⇒ 下游只输出其中几张）✗。
		//   旧数据（只有 `selected_index`、没有 refs）先用「序号 → ref」补齐一次，否则
		//   refs 为空会让第一次点击被判成「未选中」→ 取消不掉 ✗。
		const baseRefs = pickerSelectedRefs.length > 0
			? pickerSelectedRefs
			: pickerSelectedIndices
				.map(i => pickerPool[i]?.media.ref)
				.filter((r): r is string => typeof r === 'string' && r.length > 0);
		const nextRefs = visualSelected
			? baseRefs.filter(r => r !== targetRef)
			: (hasTargetRef ? Array.from(new Set([...baseRefs, targetRef])) : [...baseRefs]);
		// 序号 = ref 在池内的下标（解析不出的 ref **不写序号**，与 canvasOps 同约定）
		const nextIndices = [...new Set(
			nextRefs.map(r => pickerPool.findIndex(e => e.media.ref === r)).filter(i => i >= 0),
		)].sort((a, b) => a - b);
		const firstRef = nextRefs[0] ?? '';
		const firstIdx = firstRef ? pickerPool.findIndex(e => e.media.ref === firstRef) : -1;
		const patch = {
			selected_indices: nextIndices.length > 0 ? JSON.stringify(nextIndices) : '',
			selected_index: firstIdx >= 0 ? firstIdx + 1 : 1,
			directRefs: nextRefs.length > 0 ? JSON.stringify(nextRefs) : '',
			directRef: firstRef,
		};
		commitControls(patch);
		// ★ 点选即发布（见 publishPickerSel 注释）：picker 无运行按钮，不在这里
		//   发布 → 下游（动态表情包参考图）永远停留在旧选择 ✗。
		publishPickerSel(patch);
	}, [poolScope, pickerPool, pickerSelectedRefs, pickerSelectedIndices, commitControls, publishPickerSel]);
	// 清空选择（对齐 ComfyTV Clear）：清 picker 自身输出 + 清空多选（含数组字段，
	// 否则 Clear 后网格仍高亮旧选中 ✗）。
	const clearPicker = React.useCallback(() => {
		if (!nodeId) { return; }
		snapshotStore?.clearNode(snapKey ?? nodeId);
		commitControls({ selected_index: 1, selected_indices: '', directRef: '', directRefs: '' });
	}, [nodeId, snapKey, snapshotStore, commitControls]);
	// 删除单张候选图（对齐 ComfyTV remove-pool-item）：从 store 移除该 entry。
	// ★★ **必须二次确认**（2026-09-12 用户需求「删除前，要有用户询问窗口，同意后
	//   才可以删除」）：`store.remove` 会连 IndexedDB 里的 ref + meta 一起删
	//   （不可恢复 ✗），而 × 是悬停才出现的小按钮，极易误触。故 × 只**发起**
	//   （记下 key + ref），确认框里点「删除」才真正执行。
	const [pendingPoolRemove, setPendingPoolRemove] = React.useState<{ key: string; ref: string } | null>(null);
	const requestPoolRemove = React.useCallback((key: string, ref: string) => {
		setPendingPoolRemove({ key, ref });
	}, []);
	const confirmPoolRemove = React.useCallback(() => {
		const pending = pendingPoolRemove;
		setPendingPoolRemove(null);
		if (!pending) { return; }
		// pool 实时聚合上游 entry，删除后立即从网格消失；同时清空选中避免序号越界。
		void snapshotStore?.remove(pending.key);
		// ★ 删图后清空**全部**选中字段（含 ref 数组）：否则 `directRefs` 残留已删 ref，
		//   物化 / runPickerNode 仍按它输出 → 下游「引用」区显示已被删除的图 ✗。
		commitControls({ selected_index: 1, selected_indices: '', directRef: '', directRefs: '' });
		// ★ 同时清掉 picker **自己已发布的输出**（2026-09-12，与点选即发布配套）：
		//   否则下游读到的还是上一次发布（含刚删掉的那张）→ 「删了但下游还在引用」✗。
		if (snapKey ?? nodeId) { void snapshotStore?.clearNode(snapKey ?? nodeId ?? ''); }
	}, [pendingPoolRemove, snapshotStore, commitControls, snapKey, nodeId]);

	// ComfyTV ACTIONS: which action's preset list is expanded (edit / preset / change).
	// 用模块级 Map 持久化，避免 graph.configure() → DOM widget 重建 → self-heal
	// remount NodeCard 时丢失 local state（Bug #5）。
	const [openActionId, setOpenActionIdLocal] = React.useState<string | null>(() => {
		return getOpenActionId(nodeId ?? '') ?? null;
	});
	// 对齐 ComfyTV StageCard：Actions / Context 标题栏可折叠，且**折叠态跨 remount
	// 与重启保留**（卡片随 syncOverlay 频繁挂卸，纯 useState 一滚动就重置）。
	const [actionsCollapsed, setActionsCollapsed] = useCollapsed('actions', nodeId, true);
	// CONTEXT 默认折叠（对齐截图 `> CONTEXT 1 image` 的收起态）。
	const [contextCollapsed, setContextCollapsed] = useCollapsed('context', nodeId, true);
	const setOpenActionId = React.useCallback((v: string | null) => {
		setOpenActionIdLocal(v);
		setOpenActionIdPersist(nodeId ?? '', v ?? undefined);
	}, [nodeId]);
	// Dispatch a follow-up spawn (create node + connect) to the canvas host.
	const dispatchAction = React.useCallback((actionId: string) => {
		if (nodeId) {
			window.dispatchEvent(new CustomEvent('wf-node-action', { detail: { nodeId, actionId } }));
		}
	}, [nodeId]);
	// GridSplit 写回 rows/cols/border/outer_border/selected_index。
	const commitGridSplit = React.useCallback((patch: Partial<{ rows: number; cols: number; border: number; outerBorder: boolean; selectedIndex: number }>) => {
		const nameMap: Record<string, string> = {
			rows: 'rows', cols: 'cols', border: 'border',
			outerBorder: 'outer_border', selectedIndex: 'selected_index',
		};
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(patch)) { out[nameMap[k] ?? k] = v; }
		commitControls(out);
	}, [commitControls]);
	// ColorGrade 写回 grade_state（JSON 字符串，由面板序列化；对齐 ComfyTV serializeGradeState）。
	const commitColorGrade = React.useCallback((gradeStateJson: string) => {
		commitControl('grade_state', gradeStateJson);
	}, [commitControl]);
	// Rotate 写回 angle。走 commitControl 而非裸 dispatch —— 否则 controlDrafts
	// 不更新，useTransformPipeline 看不到参数变化，「改参数即自动出图」失效。
	const commitAngle = React.useCallback((angle: number) => {
		commitControl('angle', angle);
	}, [commitControl]);
	// Mirror 写回 horizontal/vertical（一次批量提交，只触发一轮重算）。
	const commitMirrorFlip = React.useCallback((horizontal: boolean, vertical: boolean) => {
		commitControls({ horizontal, vertical });
	}, [commitControls]);

	// 文生图 provider 后端：激活 provider/model 自动选中 + 联动。
	//  - provider 值为空或已失效（被移除/未认证）→ 回退第一个激活（authenticated）provider；
	//  - model 值为空或不属于当前 provider → 回退该 provider 第一个支持文生图的模型；
	//  - 两者都写回 node.properties（wf-node-control）→ 执行时 runProviderImage 可读、保存持久化。
	// ★ 不再限定 schema：编排富卡片（Saros.Agent）的 provider/model 也要动态选项
	//   + 联动（与 ImageStage 的 provider 后端完全同一套逻辑）。
	const isProviderImageGen = (meta.kind === 'schema' || isOrchRich) && controlProviders.length > 0;
	/**
	 * 文生图 provider/model 的**自动回退**是否适用。
	 *
	 * ★ 必须与 `isProviderImageGen` 分开：后者含 orchRich（用 chatProviders 判定），
	 *   而下面的回退逻辑硬用 `imageGenProviders[0].id` —— orchRich 节点若所处环境
	 *   只有纯 LLM provider（无文生图模型），`imageGenProviders` 为空数组，
	 *   `[0].id` 直接抛 `TypeError: Cannot read properties of undefined`，
	 *   整张卡片崩成空白（正是「UI 缺失」的一种表现）。
	 *   且这套回退用的是 `provider`/`model` 键名（ComfyTV 文生图语义），
	 *   对 orchRich 的 `providerId`/`modelId` 本就不适用 —— 后者的联动在
	 *   ComboPopover 的 onChange 里处理。
	 */
	const isImageGenAutoFix = meta.kind === 'schema' && imageGenProviders.length > 0;
	const effectiveProviderId = React.useMemo(() => {
		if (!isImageGenAutoFix) { return ''; }
		const pid = typeof controlDrafts['provider'] === 'string' ? controlDrafts['provider'] : '';
		return imageGenProviders.some(p => p.id === pid) ? pid : imageGenProviders[0].id;
	}, [isImageGenAutoFix, imageGenProviders, controlDrafts]);
	React.useEffect(() => {
		if (!isImageGenAutoFix) { return; }
		const pid = typeof controlDrafts['provider'] === 'string' ? controlDrafts['provider'] : '';
		const mid = typeof controlDrafts['model'] === 'string' ? controlDrafts['model'] : '';
		const validPid = imageGenProviders.some(p => p.id === pid) ? pid : imageGenProviders[0].id;
		const prov = imageGenProviders.find(p => p.id === validPid);
		const validMid = (prov?.models ?? []).some(m => m.supportsImageGen && m.id === mid)
			? mid
			: (prov?.models.find(m => m.supportsImageGen)?.id ?? '');
		if (validPid !== pid) { commitControl('provider', validPid); }
		if (validMid && validMid !== mid) { commitControl('model', validMid); }
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isImageGenAutoFix, imageGenProviders, controlDrafts, commitControl]);

	// addDOMWidget height feedback: any render can change the content height
	// (progress bar / error banner / output preview appear, prompt grows).
	// Mark the node dirty so the canvas measures scrollHeight ONCE next frame
	// and feeds it back into LiteGraph's layout (setDomFormContentHeight).
	// No dep array → runs after every commit; renders only happen on store
	// changes, so this stays cheap.
	React.useEffect(() => {
		// ★ orchRich 也要参与高度反馈：它挂了 `__saros_form` widget（见
		//   LiteGraphCanvas 的 orchRich 分支），漏掉会让卡片停在 150px 估算值，
		//   下拉/textarea 被容器 overflow:hidden 截断。
		if (nodeId && (meta.kind === 'schema' || isFullEditor || isOrchRich)) { markFormHeightDirty(nodeId); }
	});

	// addDOMWidget: schema cards wrap their content exactly (max-content) —
	// LiteGraph's layout owns the area height (widget.computedHeight), so the
	// DOM must not stretch to the container: scrollHeight then reports the
	// true content height and the feedback loop converges. Non-schema cards
	// keep the legacy stretch-to-container behavior.
	// 内联编辑器节点（Crop/Rotate/Mirror/Panorama/Relight/Material）也需
	// max-content 以支持高度反馈增长（否则内容被容器 overflow:hidden 截断）。
	const isSchema = meta.kind === 'schema';
	// 有内嵌编辑器的非 schema 节点同样需要 max-content 才能参与高度反馈增长
	// （否则被容器 overflow:hidden 截断，表现为「只看到图像顶部一条」）。
	// 判据来自 stageCardRegistry，替代此前硬编码的 6 项 FULL_EDITOR_TYPES —— 顺带
	// 把 Outpaint/GridSplit/ColorGrade/Multiangle/KenBurns 也纳入（它们同样有
	// 大预览区，之前因不在白名单里而被截断）。
	const isFullEditor = !isSchema && hasInlineEditor;
	/** 卡片区块开关（对齐 ComfyTV STAGE_CARD_PROPS）。 */
	const cardFlags = stageCardFlags(meta.nodeType);
	// ── ★ 导演台全屏浮层（2026-09-13）──────────────────────────────────────────
	// 卡片内嵌导演台受两个硬约束：① 宽度 = 节点宽度（不自增）② 容器 overflow:hidden
	// 裁剪 —— 于是「左画布 + 右 BOARD 面板 + 底部时间线」在窄节点里被压缩。全屏浮层
	// 把整个 webview 视口交给它。
	// 复用 portal 模式（与表情格编辑器同因）：画布节点带 transform/缩放，普通 fixed
	// 会受 containing block 影响，只有 portal 到 document.body 才是真正的全屏浮层。
	const [directorFullscreen, setDirectorFullscreen] = React.useState(false);
	// 全屏时按视口尺寸渲染（resize 跟随）
	const [fullscreenViewport, setFullscreenViewport] = React.useState(() => ({
		w: typeof window === 'undefined' ? 1280 : window.innerWidth,
		h: typeof window === 'undefined' ? 720 : window.innerHeight,
	}));
	React.useEffect(() => {
		if (!directorFullscreen) { return; }
		const onResize = () => setFullscreenViewport({ w: window.innerWidth, h: window.innerHeight });
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	}, [directorFullscreen]);
	// Esc 关闭（与表情格编辑窗口同一交互约定）
	React.useEffect(() => {
		if (!directorFullscreen) { return; }
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDirectorFullscreen(false); } };
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [directorFullscreen]);
	// ★ P2（2026-09-13）：响应「独立 tab 打开 → 自动全屏」。
	//   独立 tab 的 webview 与本画布 tab 共用同一 App（panelType 仍是 'workflow-editor'），
	//   只是 initialData 多带 `focusNodeId`；浮层状态在卡片内部 → 由 WorkflowEditorPanel
	//   派发 window 事件通知（与既有 wf-node-* 事件同模式）。
	React.useEffect(() => {
		if (!isDirectorConsole) { return; }
		const onFullscreenRequest = (e: Event) => {
			const detail = (e as CustomEvent<{ nodeId?: string }>).detail;
			if (detail?.nodeId && detail.nodeId === nodeId) { setDirectorFullscreen(true); }
		};
		window.addEventListener('wf-node-fullscreen', onFullscreenRequest);
		return () => window.removeEventListener('wf-node-fullscreen', onFullscreenRequest);
	}, [isDirectorConsole, nodeId]);
	/**
	 * P2：把该节点的编辑器开成**独立 editor tab**（host 侧 WorkflowNodeEditorPane）。
	 *
	 * 独立 tab 与本画布 tab 并存（resource 不同：`saros-workflow-node:` vs
	 * `saros-workflow:`）；同一节点重复点击只会聚焦已有 tab（`matches()` 去重）。
	 * 标题取描述符的 title（host 侧不持有 kind 表）。
	 *
	 * 动态 import `sendRequest`：与 `nodeControlWrite.ts` 同一做法，避免在卡片模块
	 * 顶层引入 bridge 依赖。
	 */
	const handleOpenInTab = React.useCallback(async (inWindow = false) => {
		const wfId = useWorkflowEditorStore.getState().workflowId;
		if (!wfId || !nodeId) { return; }
		try {
			const { sendRequest } = await import('../../../bridge/messageClient.js');
			const r = await sendRequest('workflow.openNodeEditor', {
				workflowId: wfId,
				nodeId,
				nodeType: meta.nodeType,
				editorTitle: stageEditorDescriptor(meta.nodeType)?.title,
				// ★ P3（2026-09-13）：true → host 打开 tab 后再移入独立（辅助）窗口。
				//   命令不可用时 host 侧只告警，tab 仍在（可手动拖出成窗）。
				inWindow,
			}) as { ok?: boolean; error?: string };
			if (!r?.ok) {
				// eslint-disable-next-line no-console
				console.warn('[nodeCard] workflow.openNodeEditor failed:', r?.error);
			}
		} catch (err) {
			// eslint-disable-next-line no-console
			console.warn('[nodeCard] workflow.openNodeEditor error:', err);
		}
	}, [meta.nodeType, nodeId]);
	/**
	 * 导演台渲染（卡片内联 + 全屏浮层**共用**）。
	 *
	 * ★ 单一渲染函数：两处宿主只有 width/height 不同，初始值 / 写回通道 / runner
	 *   完全一致 → 「卡片里看到的」与「全屏里看到的」永远同一份状态（都走
	 *   `controlDrafts` + `commitControl('board_state')`），不需要任何额外同步。
	 *   （这也是「与卡片内联内容实时一致」的实现方式：不是同步，而是同一个数据源。）
	 */
	const renderDirectorConsole = (fullscreen: boolean) => {
		const registry = getActiveRunnerRegistry();
		const snapStore = snapshotStore;
		return (
			<LazyDirectorConsole
				initialState={(controlDrafts['board_state'] ?? '') as string}
				initialFountainText={storyboardFountainText || undefined}
				width={fullscreen ? Math.max(960, fullscreenViewport.w - 48) : clampDim(Number(controlDrafts['width']), 1280)}
				height={fullscreen ? Math.max(560, fullscreenViewport.h - 132) : clampDim(Number(controlDrafts['height']), 720)}
				runners={registry ?? undefined}
				preference={getActiveRunnerPreference()}
				onStateChange={(json) => commitControl('board_state', json)}
				onRenderUploaded={(url) => {
					if (!url || !snapStore) { return; }
					snapStore.put({
						nodeId: snapKey,
						port: 'output',
						key: `${snapKey}:output:0`,
						media: { kind: 'image', ref: url },
						index: 0,
					});
				}}
			/>
		);
	};

	/** 运行反馈片段（进度条 + 错误横幅）。抽成变量以便 showRun 真/假两条路径共用，
	 *  保证 picker/loader 等 no-Run 节点的错误同样可见（见下方两处引用）。 */
	const runFeedback = (
		<>
			{run.runState === 'running' && <RunProgress progress={run.progress} message={run.message} />}
			{run.runState === 'error' && <ErrorBanner message={run.errorMsg ?? '执行失败'} cancel={false} />}
			{run.runState === 'skipped' && (
				<div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px', fontSize: 11, color: 'var(--vscode-descriptionForeground, #8b8b8b)', background: 'rgba(128,128,128,0.08)', borderRadius: 4 }}>
					<span>⤼</span><span>分支未激活——本次运行已跳过</span>
				</div>
			)}
			{(meta.nodeType === 'Saros.Loop' || meta.nodeType === 'Saros.Parallel') && (run.runState === 'success' || run.runState === 'idle') && (() => {
				// W5b: Loop/Parallel 迭代徽章——从最新快照解析 {iterations, failed}
				const snap = ownSnapshots[ownSnapshots.length - 1];
				if (!snap || snap.media.meta?.loopNode !== '1') { return null; }
				try {
					const out = JSON.parse(snap.media.ref) as { iterations?: unknown[]; failed?: number };
					const n = Array.isArray(out.iterations) ? out.iterations.length : 0;
					return (
						<div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px', fontSize: 11, color: n > 0 && (out.failed ?? 0) === 0 ? '#3fb950' : '#d29922', background: 'rgba(63,185,80,0.08)', borderRadius: 4 }}>
							<span>{meta.nodeType === 'Saros.Loop' ? '🔁' : '⚡'}</span>
							<span>迭代 {n} 项{(out.failed ?? 0) > 0 ? ` · 失败 ${out.failed}` : ''}</span>
						</div>
					);
				} catch { return null; }
			})()}
		</>
	);
	return (
		<div
			className="wf-comfy-card"
			style={{
				position: 'relative',
				width: '100%',
				// ★ orchRich 同样要 max-content：它挂了 form widget 参与高度反馈，
				//   用 100% 会被容器（150px 估算值）拉伸并 overflow:hidden 截断，
				//   表现为「最后一个下拉只露一半」。
				height: (isSchema || isFullEditor || isOrchRich) ? 'max-content' : '100%',
				boxSizing: 'border-box',
				// Defensive: native <select>/<input> have an implicit
				// `min-width: max-content` that can blow the card out past the
				// node rect (the user reports "card wider than the node background"
				// even when both root + container are 100% width). Forcing
				// min-width:0 here makes the card shrink / clip instead.
				minWidth: 0,
				maxWidth: '100%',
				pointerEvents: 'none',
				userSelect: 'none',
				overflow: 'hidden',
				// ComfyTV StageCard uses NO border on the root (a border would sit
				// OUTSIDE the container's content box and visually overflow the node).
				// The accent edge is drawn as an inset box-shadow instead.
				boxShadow: `inset 0 0 0 ${awaitingInput ? 2 : 1.5}px ${awaitingInput ? edgeColor : `${kindColor}55`}`,
				color: 'var(--vscode-foreground, #ccc)',
				fontFamily: 'inherit',
				// ComfyTV StageCard cardClass：text-xs（12px）—— 真源 visual/comfyTvTruth.ts
				fontSize: 12,
				display: 'flex',
				flexDirection: 'column',
				}}
				>
				{/* ★ 「待配置」角标（2026-09-12 用户需求：聊天卡状态同步到画布）：
				    黄色描边之外再给一个**明确文案** —— 描边在缩小的节点上可能看不清，
				    角标保证「一眼看到在等用户操作」✓。 */}
				{awaitingInput && (
					<div style={{
						position: 'absolute', top: 2, right: 4, zIndex: 3,
						background: '#fbbf24', color: '#1e1e1e',
						fontSize: 9, fontWeight: 600, lineHeight: '14px',
						padding: '0 5px', borderRadius: 7,
					}}>待配置</div>
				)}
				{/* Inner content wrapper — opaque background. The container is
				already inset to LiteGraph's widget area by widgetBridge (left/
				right = BaseWidget.margin 15, top = title bar + port rows), so
				the port dots and labels are OUTSIDE the card and stay visible.
				★ token 对齐 ComfyTV StageCard cardClass（完全复刻，真源
				visual/comfyTvTruth.ts · ComfyTV src/components/stages/StageCard.vue）：
				background #1e1e1e（base-background，弃旧渐变 38,38,46→24,24,28）
				padding 8px（p-2，旧 4px 4px 6px）
				gap 8px（gap-2，旧 3px）
				★ boxShadow 改为 **inset**：原 `0 4px 18px rgba(0,0,0,.45)` 是
				外凸阴影，DOM 卡的视觉外缘（含 boxShadow）会凸出节点边界
				6-18 px，盖住 LiteGraph canvas 绘制的节点选中绿框（边缘高亮）。
				inset 阴影画在元素内部，不影响外缘 → 绿框完整显示。 */}
				<div style={{
				position: 'relative',
				background: '#1e1e1e',
				boxShadow: 'none',
				padding: '8px',
				display: 'flex',
				flexDirection: 'column',
				minWidth: 0,
				maxWidth: '100%',
				boxSizing: 'border-box',
				gap: 8,
				flex: 1,
				overflow: 'hidden',
				}}>
				{/* 缩放 Thumb 档（k<0.35）：纯图缩略（4:3 in-flow，见 zoomTier.ts CSS）。
				    ★ 不能用 absolute inset:0——兄弟全隐藏后包装层塌缩成 padding 高，
				    图会被压成细条（2026-09-02 实测）。in-flow + aspect-ratio 让高度
				    反馈把节点缩成真正的缩略卡。 */}
				<div data-zone="thumb" style={{ display: 'none', background: '#0b0c0e', overflow: 'hidden' }}>
					{(() => {
						for (let i = ownSnapshots.length - 1; i >= 0; i--) {
							const entry = ownSnapshots[i];
							if (entry.media.kind === 'image') {
								return <img key={entry.key} src={entry.media.ref} alt="" className="saros-zoom-thumb-img" draggable={false} />;
							}
						}
						return null;
					})()}
				</div>
			{/* Schema nodes: LiteGraph draws the title bar on the canvas, so
			    we DON'T render the title here. The card only covers the
			    widget content area. */}
			{/* 端口仅由 LiteGraph canvas 渲染（在上方「端口行」里带可连线的圆点），
			    DOM 不再重复绘制端口胶囊——避免 ImageStage 上方 canvas 端口和下方
			    DOM 端口 chip 同时显示。CONTEXT 折叠面板（语义摘要 "N images"）
			    仍独立显示在卡片底部，与连线锚点无关。 */}
			{/* Non-schema cards keep the legacy layout (they don't render ComfyTV-style).
			    Full-editor nodes (Crop/Rotate/Mirror/Panorama/Relight/Material) have
			    their own inline editor UI that replaces these metadata labels. */}
			{meta.kind !== 'schema' && !isFullEditor && meta.brand && (
				<div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
					<span style={{ fontSize: 8, letterSpacing: 1.5, textTransform: 'uppercase', opacity: .45, color: 'var(--vscode-descriptionForeground, #858585)' }}>
						{meta.brand}
					</span>
					{meta.schemaDetail && (
						<span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'Consolas, monospace' }}>
							{meta.schemaDetail}
						</span>
					)}
				</div>
			)}
			{meta.kind !== 'schema' && !isFullEditor && !meta.brand && meta.schemaDetail && (
				<div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'Consolas, monospace' }}>
					{meta.schemaDetail}
				</div>
			)}
			{/* ★ isOrchRich 时不渲染 widgetSummary：DOM 控件已把每个参数按行画出，
			    再叠一行 `toolName= · toolParams=[object Object]` 就是重复噪声
			    （截图里参数上方那行青色小字）。 */}
			{meta.kind !== 'schema' && !isFullEditor && !isOrchRich && meta.widgetSummary && !identityInfo && (
				<div style={{ fontSize: 9, color: '#9cdcfe', fontFamily: 'Consolas, monospace' }}>
					{meta.widgetSummary}
				</div>
			)}
			{/* ★ Agent/Skill/Tool 未配置引导：虚线占位「＋选择」，替代空白。
			    isOrchRich 时不渲染 —— agentId/skillName/toolName 下拉框已经承担
			    选择功能，再画一个「＋ 选择 Agent」虚线框是重复入口（且点它无反应）。 */}
			{meta.kind !== 'schema' && !isFullEditor && !isOrchRich && meta.identityType && !identityInfo && (
				<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '10px 8px', border: '1.5px dashed var(--vscode-panel-border)', borderRadius: 5, color: 'var(--vscode-descriptionForeground, #858585)', fontSize: 10 }}>
					<span style={{ color: '#79b8ff', fontWeight: 700 }}>＋</span>
					选择{meta.identityType === 'agent' ? 'Agent' : meta.identityType === 'skill' ? 'Skill' : 'Tool'}
				</div>
			)}
			{/* ★ Agent/Skill/Tool 富身份卡片：替代 `agentId=xxx` 碎片，展示
			    icon + name + role + description + 分类/技能/工具徽章（对齐
			    ComfyUI 节点信息密度）。未选中的节点不渲染（保持空白简洁）。 */}
			{meta.kind !== 'schema' && !isFullEditor && identityInfo && (
				<div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', marginTop: 1 }}>
					<span style={{ fontSize: 16, width: 22, height: 22, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, background: 'rgba(0,122,204,.16)', border: '1px solid rgba(0,122,204,.3)' }}>
						{identityInfo.icon}
					</span>
					<div style={{ flex: 1, minWidth: 0 }}>
						<div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--vscode-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
							{identityInfo.name}
						</div>
						{identityInfo.role && (
							<div style={{ fontSize: 9, color: '#79b8ff', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								{identityInfo.role}
							</div>
						)}
						{identityInfo.description && (
							<div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', marginTop: 2, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
								{identityInfo.description}
							</div>
						)}
						{(identityInfo.category || identityInfo.skills != null || identityInfo.tools != null) && (
							<div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
								{identityInfo.category && <span style={{ fontSize: 8, padding: '0 5px', borderRadius: 3, background: 'rgba(0,122,204,.18)', color: '#79b8ff' }}>{identityInfo.category}</span>}
								{identityInfo.skills != null && identityInfo.skills > 0 && <span style={{ fontSize: 8, padding: '0 5px', borderRadius: 3, background: 'rgba(255,255,255,.07)', color: 'var(--vscode-descriptionForeground, #858585)' }}>{identityInfo.skills} 技能</span>}
								{identityInfo.tools != null && identityInfo.tools > 0 && <span style={{ fontSize: 8, padding: '0 5px', borderRadius: 3, background: 'rgba(255,255,255,.07)', color: 'var(--vscode-descriptionForeground, #858585)' }}>{identityInfo.tools} 工具</span>}
							</div>
						)}
					</div>
				</div>
			)}

			{/* browser-local 编辑器节点：补「打开编辑器」入口（双击也能打开，但卡片
			    按钮让交互显式可见，对齐 ComfyTV 内嵌编辑器语义）。
			    ★ 不依赖 !showRun：纯弹窗式编辑器（StoryboardEditor/LayerEditor/
			    Poster/CornerPin/RotoMask/Scene3D）需按钮可见，即便被 LOCAL_EDITOR_NODE_TYPES
			    收录（showRun=true 放行控件渲染），否则 NodeCard 上没有任何编辑器入口。 */}
			{isEditorNode && (
				<button
					type="button"
					onClick={() => window.dispatchEvent(new CustomEvent('wf-node-edit', { detail: { nodeId } }))}
					style={{
						display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
						width: '100%', padding: '5px 8px', borderRadius: 4, marginTop: 3,
						cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
						border: '1px solid var(--vscode-panel-border)',
						background: 'var(--vscode-button-secondaryBackground, rgba(255,255,255,.08))',
						color: 'var(--vscode-foreground)', pointerEvents: 'auto',
					}}
				>
					<span style={{ fontSize: 12, lineHeight: 1 }}>✎</span> 打开编辑器
				</button>
			)}

			{/* Inline parameter controls (ComfyTVWidget equivalents). ComfyTV
				 renders every widget on its own full-width row so the label is
				 always readable; we follow that for schema nodes. Non-schema
				 cards keep the compact 2-column grid. */}
			{showRun && meta.controls && meta.controls.length > 0 && !hasInlineEditor && (
				<div style={{ display: 'grid', gridTemplateColumns: (meta.kind === 'schema' || isOrchRich) ? '1fr' : '1fr 1fr', gap: (meta.kind === 'schema' || isOrchRich) ? 6 : 3, width: '100%', boxSizing: 'border-box' }}>
					{meta.controls.map(c => {
						// 由内嵌编辑器接管的字段不再渲染通用控件（否则同一参数两套 UI）。
						// 单一数据源：stageCardRegistry.STAGE_HIDDEN_FIELDS，替代此前
						// 8 组 `isXxx && XXX_HIDDEN_FIELDS.has(name)` 硬编码判断。
						if (hiddenFields.has(c.name)) { return null; }
						const val = controlDrafts[c.name] ?? c.value;
						// ComfyTV gives every widget a full-width row with a
						// fixed label width so the input controls align. Smaller
						// label for the legacy 2-column grid on non-schema nodes.
						// ComfyTV CustomParamsSection: label `shrink-0 w-20 truncate`
						// (=80px fixed) + control `flex-1 min-w-0`.
						// ★ isOrchRich（Saros.Prompt/Agent）与 schema 共用宽 label 单列
						//   布局，保证 provider/model 行与 ImageStage 视觉一致。
						const isSchema = meta.kind === 'schema' || isOrchRich;
						const labelStyle = {
							color: 'var(--vscode-descriptionForeground, #858585)',
							width: isSchema ? 92 : 38,
							flexShrink: 0, overflow: 'hidden',
							textOverflow: 'ellipsis', whiteSpace: 'nowrap',
						} as const;
						const inputStyle = {
							flex: 1, padding: isSchema ? '5px 8px' : '1px 3px',
							borderRadius: 3, minWidth: 0, minHeight: isSchema ? 28 : 0,
							boxSizing: 'border-box',
							background: 'var(--vscode-input-background, rgba(255,255,255,.06))',
							color: 'var(--vscode-foreground, #e8e8e8)',
							border: '1px solid var(--vscode-input-border, rgba(255,255,255,.14))',
							fontSize: isSchema ? 12 : 9,
							fontFamily: 'inherit',
						} as const;
						if (c.type === 'COMBO') {
							// provider/model 等控件运行时从 provider store 解析选项；
							// 静态 widget（workflow 等）用注册时的 options。
							// 未显式选 provider 时按激活回退（effectiveProviderId），
							// 保证 model 下拉与当前有效 provider 联动。
							const effectiveDrafts = (isProviderImageGen && (c.name === 'provider' || c.name === 'model'))
								? { ...controlDrafts, provider: effectiveProviderId }
								: controlDrafts;
							const options = resolveControlOptions(c, effectiveDrafts, controlProviders, { agents, skills, tools });
							// Combos with options get a full row, otherwise they
							// would crowd the grid label.
							const wide = !options || options.length === 0;
							const optVal = typeof val === 'string' || typeof val === 'number' ? String(val) : '';
							// 当前值不在选项中（如节点为空的占位）→ 显示第一个激活选项，
							// 避免 select 空白；effect 会随后把有效值写回 properties。
							const displayVal = (() => {
								if (!options || options.length === 0) { return optVal; }
								const hit = options.some(o => (typeof o === 'string' ? o : o.value) === optVal);
								if (hit) { return optVal; }
								const first = options[0];
								return typeof first === 'string' ? first : first.value;
							})();
							return (
								<label key={c.name} style={{ gridColumn: wide ? '1 / -1' : 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: isSchema ? 11 : 9, minWidth: 0, width: '100%', boxSizing: 'border-box', pointerEvents: 'auto' }}>
									<span style={labelStyle}>{c.name}</span>
									{/* ComfyTV 深色下拉 + portal popover（对齐 ComfyTVSelect.vue） */}
									<ComboPopover
										id={`nc-${c.name}-combo`}
										ariaLabel={c.name}
										value={displayVal}
										options={(options ?? []).map(o => typeof o === 'string' ? { label: o, value: o } : o)}
										onChange={(v) => {
											commitControl(c.name, v);
											// provider 变更 → model 联动到该 provider 第一个可用模型。
											// 两套键名：文生图 provider→model（过滤 supportsImageGen）、
											// LLM providerId→modelId（不过滤，见 resolveControlOptions）。
											if (isProviderImageGen && (c.name === 'provider' || c.name === 'providerId')) {
												const llm = c.name === 'providerId';
												const p = controlProviders.find(x => x.id === v);
												const firstModel = (p?.models ?? []).find(m => llm || m.supportsImageGen)?.id;
												if (firstModel) { commitControl(llm ? 'modelId' : 'model', firstModel); }
											}
										}}
									/>
								</label>
							);
						}
						if (c.name === 'variant_count' && (c.type === 'INT' || c.type === 'FLOAT')) {
							// ImageVariations 的 variant_count：对齐 ComfyTV 1-25 slider，
							// 作为变体数量的直观预览。
							const v = typeof val === 'number' ? val : (c.min ?? 1);
							return (
								<label key={c.name} style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: isSchema ? 11 : 9, minWidth: 0, width: '100%', boxSizing: 'border-box', pointerEvents: 'auto' }}>
									<span style={labelStyle}>{c.name}</span>
									<input
										type="range"
										min={c.min ?? 1}
										max={c.max ?? 25}
										step={1}
										value={v}
										onChange={e => commitControl(c.name, Math.round(Number(e.target.value)))}
										style={{ flex: 1, pointerEvents: 'auto' }}
									/>
									<span style={{ minWidth: 18, textAlign: 'right', color: 'var(--vscode-descriptionForeground, #858585)' }}>{v}</span>
								</label>
							);
						}
						if (isKenBurns && (c.type === 'INT' || c.type === 'FLOAT')) {
						const step = c.step ?? (c.type === 'INT' ? 1 : 0.01);
						const numVal = typeof val === 'number' ? val : (c.min ?? 0);
						const commitNum = (v: number) => commitControl(c.name, c.type === 'INT' ? Math.round(v) : v);
						return (
							<label key={c.name} style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6 }}>
								<span style={labelStyle}>{c.name}</span>
								<input
									type="range"
									min={c.min ?? 0}
									max={c.max ?? 1}
									step={step}
									value={numVal}
									onChange={e => commitNum(Number(e.target.value))}
									style={{ flex: 1, pointerEvents: 'auto' }}
								/>
								<span style={{ minWidth: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>{numVal}</span>
							</label>
						);
					} else if (c.type === 'INT' || c.type === 'FLOAT') {
							// 参数 DOM 化后，补回 LiteGraph number widget 的 ± 步进按钮
							// （batch_size 等整数 ±1，FLOAT ±0.1），clamp 到 min/max。
							const step = c.type === 'INT' ? 1 : 0.1;
							const bump = (dir: number) => {
								const cur = Number(val ?? 0) || 0;
								const raw = cur + dir * step;
								const next = c.type === 'INT' ? Math.round(raw) : Math.round(raw * 100) / 100;
								if (c.min !== undefined && next < c.min) { return; }
								if (c.max !== undefined && next > c.max) { return; }
								commitControl(c.name, next);
							};
							const stepBtnStyle = {
								flexShrink: 0, width: 20, height: 20, borderRadius: 3, cursor: 'pointer',
								display: 'flex', alignItems: 'center', justifyContent: 'center',
								fontSize: 14, lineHeight: 1, padding: 0, boxSizing: 'border-box' as const,
								border: '1px solid var(--vscode-input-border, rgba(255,255,255,.14))',
								background: 'var(--vscode-button-secondaryBackground, rgba(255,255,255,.08))',
								color: 'var(--vscode-foreground, #e8e8e8)', fontFamily: 'inherit',
							};
							return (
								<label key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: isSchema ? 11 : 9, minWidth: 0, width: '100%', boxSizing: 'border-box', pointerEvents: 'auto' }}>
									<span style={labelStyle}>{c.name}</span>
									<button type="button" onClick={() => bump(-1)} style={stepBtnStyle} aria-label={`${c.name} 减`}>−</button>
									<input
										type="number"
										value={String(val ?? '')}
										min={c.min}
										max={c.max}
										onChange={e => commitControl(c.name, c.type === 'INT' ? Math.round(Number(e.target.value)) : Number(e.target.value))}
										style={{ ...inputStyle, textAlign: 'center' }}
									/>
									<button type="button" onClick={() => bump(1)} style={stepBtnStyle} aria-label={`${c.name} 加`}>+</button>
								</label>
							);
						}
						if (c.type === 'BOOLEAN') {
							return (
								<label key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, minWidth: 0, pointerEvents: 'auto' }}>
									<input
										type="checkbox"
										checked={!!val}
										onChange={e => commitControl(c.name, e.target.checked)}
									/>
									<span style={{ color: 'var(--vscode-descriptionForeground, #858585)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
								</label>
							);
						}
						if (c.type === 'TEXT') {
							// ★ 编排节点参数的 DOM 渲染（Start 的 args、IfElse 的
							//   evaluationTarget、Skill 的 task/skillArgs、Tool 的
							//   toolParams、Switch 的 cases、Loop/Parallel 的 items…）。
							//   样式沿用同一套 labelStyle/inputStyle（= ComfyTV 深色
							//   输入框），与 ImageStage 的参数行完全一致。
							//   JSON / 多值类字段用 textarea（可换行、等宽字体），
							//   其余用单行 input。
							const isJsonish = c.name === 'args' || c.name === 'skillArgs'
								|| c.name === 'toolParams' || c.name === 'cases'
								|| c.name === 'items' || c.name === 'options';
							// ★ 对象值必须 JSON 序列化：`String({})` 得到 "[object Object]"
							//   （截图里 toolParams / skillArgs 显示的就是它）。
							//   properties 里这些字段可能已被上游反序列化成对象。
							const textVal = typeof val === 'string'
								? val
								: val == null
									? ''
									: typeof val === 'object'
										? (() => { try { return JSON.stringify(val, null, isJsonish ? 2 : 0); } catch { return ''; } })()
										: String(val);
							return (
								<label key={c.name} style={{ gridColumn: '1 / -1', display: 'flex', alignItems: isJsonish ? 'flex-start' : 'center', gap: 6, fontSize: isSchema ? 11 : 9, minWidth: 0, width: '100%', boxSizing: 'border-box', pointerEvents: 'auto' }}>
									<span style={{ ...labelStyle, paddingTop: isJsonish ? 4 : 0 }}>{c.name}</span>
									{isJsonish ? (
										<textarea
											value={textVal}
											spellCheck={false}
											onChange={e => commitControl(c.name, e.target.value)}
											// 阻止冒泡：否则空格/方向键会被画布的快捷键吞掉
											onKeyDown={e => e.stopPropagation()}
											style={{
												...inputStyle,
												minHeight: 46, resize: 'vertical', lineHeight: 1.45,
												fontFamily: 'var(--vscode-editor-font-family, Consolas, monospace)',
												padding: '4px 6px',
											}}
										/>
									) : (
										<input
											type="text"
											value={textVal}
											spellCheck={false}
											onChange={e => commitControl(c.name, e.target.value)}
											onKeyDown={e => e.stopPropagation()}
											style={inputStyle}
										/>
									)}
								</label>
							);
						}
						return null;
					})}
				</div>
			)}

			{/* 上游图片引用缩略图区（对齐 ComfyTV Asset references：显示该节点
			    将使用的参考图，即上游连线传入的图片）。仅当有上游图片时显示。
			    ★ 表情包三节点纳入（isEmojiRefConsumer → needUpstreamImage）——
			    连线后用户可即时确认参考图已生效（此前连了线无任何可视化反馈，
			    正是「参考图丢失」 bug 的体验盲区）。 */}
			{showRun && (isGeneratorStage || isKenBurns || isEmojiRefConsumer) && upstreamImageRefs.length > 0 && (
				<div style={{ display: 'flex', gap: 5, alignItems: 'center', width: '100%', boxSizing: 'border-box', marginTop: 2 }}>
					<span style={{ flexShrink: 0, fontSize: 8, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground, #858585)' }}>引用</span>
					<div style={{ display: 'flex', gap: 4, overflowX: 'auto', flex: 1, minWidth: 0 }}>
						{upstreamImageRefs.map((ref, i) => (
							<div key={`${ref.slice(0, 48)}-${i}`} style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 4, overflow: 'hidden', border: '1px solid var(--vscode-panel-border)', background: 'var(--vscode-editor-background, transparent)' }}>
								<img src={ref} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
							</div>
						))}
					</div>
				</div>
			)}

			{/* Multiangle 3D 相机轨道编辑器（复刻 ComfyTV MultiangleStageCard） */}
			{showRun && isMultiangle && (
				<MultiangleEditor
					initialState={{
						azimuth: (controlDrafts['horizontal_angle'] ?? 0) as number,
						elevation: (controlDrafts['vertical_angle'] ?? 0) as number,
						distance: (controlDrafts['zoom'] ?? 5.0) as number,
						imageUrl: upstreamImageRef ?? null,
					}}
					onStateChange={(cs) => {
						commitControl('horizontal_angle', cs.azimuth);
						commitControl('vertical_angle', cs.elevation);
						commitControl('zoom', cs.distance);
						// 自动生成 prompt 并回写
						const widget = meta.controls?.find(c => c.name === 'prompt');
						if (widget) { commitPrompt(cs.azimuth !== 0 || cs.elevation !== 0 ? `<sks> ${widget.value}` : ''); }
					}}
					height={280}
				/>
			)}

			{/* Panorama 全景编辑器（复刻 ComfyTV PanoramaStageCard） */}
			{showRun && isPanorama && (
				<PanoramaEditor
					workflow={(controlDrafts['workflow'] ?? meta.controls?.find(c => c.name === 'workflow')?.value ?? '') as string}
					prompt={(controlDrafts['prompt'] ?? '') as string}
					upstreamImageUrl={upstreamImageRef ?? null}
					resultImageUrl={null}
					onWorkflowChange={(v) => commitControl('workflow', v)}
					onPromptChange={(v) => commitPrompt(v)}
					onPanoramaUpload={() => {}}
					onWorkflowUpload={() => {}}
					onLinkWorkflow={() => {}}
				/>
			)}

			{/* Relight 3D 灯光球编辑器（复刻 ComfyTV RelightStageCard：
			    Three.js 灯光球 + 预设芯片 + prompt 自动生成 + light_render 输出） */}
			{showRun && isRelight && (
				<RelightEditor
					initialLights={parseLightsData(meta.lightsData)}
					initialPrompt={(controlDrafts['main_prompt'] ?? meta.mainPrompt ?? 'soft studio lighting, gentle shadows') as string}
					runners={getActiveRunnerRegistry() ?? undefined}
					preference={getActiveRunnerPreference()}
					onLightsChange={(lightsJson, prompt) => {
						commitControls({ lights_data: lightsJson, main_prompt: prompt });
					}}
					onRenderUploaded={(url) => {
						if (url && snapshotStore) {
							snapshotStore.put({
								nodeId: snapKey,
								port: 'output',
								key: `${snapKey}:output:0`,
								media: { kind: 'image', ref: url },
								index: 0,
							});
						}
						commitControl('light_render_url', url);
					}}
				/>
			)}

			{/* Material PBR 材质球编辑器（复刻 ComfyTV MaterialStageCard：
			    Three.js MeshPhysicalMaterial + 预设芯片 + PBR 滑块 + Generate 按钮） */}
			{showRun && isMaterial && (() => {
				// runner registry / preference 走 runnerContext 单例（与内嵌 MaskPainter
				// 同款做法）。此前这里直接写 `runners={runners}` 引用了作用域里不存在的
				// 变量，一旦分支被执行就 ReferenceError → 整张卡片白屏。
				const registry = getActiveRunnerRegistry();
				return (
					<MaterialEditor
						initialState={(controlDrafts['material_state'] ?? '') as string}
						runners={registry ?? undefined}
						preference={getActiveRunnerPreference()}
						onStateChange={(json) => commitControl('material_state', json)}
						onRenderUploaded={(url) => {
							// ★ 修复：此前是空实现——MaterialEditor 内部 uploadRender 已把
							// 渲染图上传到 runner 拿到 url，但这里丢弃了 url，从未写入
							// MediaSnapshotStore → runMaterialNode 里 store.byNode(snapKey)
							// 永远找不到 image 快照 → 执行必报「请先在节点弹窗中编辑材质」。
							// 现在把预览图 url 归档为 image 快照，runMaterialNode 可正常
							// re-emit（runMaterialNode 取第一张 image + 材质 JSON）。
							if (!url || !snapshotStore) { return; }
							snapshotStore.put({
								nodeId: snapKey,
								port: 'output',
								key: `${snapKey}:output:0`,
								media: { kind: 'image', ref: url },
								index: 0,
							});
						}}
					/>
				);
			})()}

			{/* ★ DirectorConsoleEditor 内嵌（对齐 ComfyTV：storyboard workbench embed in node）。
			    替代原先「打开编辑器」弹窗（NodeEditorPopup）。数据走 controlDrafts/commitControl，
			    上游 Fountain 文本走 collectUpstreamTexts 自动解析成 boards。
			    用 LazyDirectorConsole 包装器延迟加载，避免 esbuild IIFE 的 TDZ 错误。 */}
			{showRun && isDirectorConsole && (
				<div
					style={{
						position: 'relative',
						width: '100%',
						height: '100%',
						minWidth: 0,
						minHeight: 0,
						/* ★ 突破 NodeCard 三层 pointer-events:none，恢复编辑器内按钮/input 可点击 */
						pointerEvents: 'auto',
						display: 'flex',
						flexDirection: 'column',
					}}
					/* ★ 阻止内部点击冒泡到 LiteGraphCanvas 的拖拽逻辑 */
					onPointerDown={e => e.stopPropagation()}
				>
					{/* ★ 全屏入口（2026-09-13）：卡片宽度 = 节点宽度且 overflow:hidden，
					    导演台的左右分栏 + 时间线在窄节点里被压缩 → 提供全屏浮层。
					    按钮浮在右上角，不占编辑器布局高度。 */}
					<button
						type="button"
						title="全屏编辑导演台（Esc 退出）"
						onClick={e => { e.stopPropagation(); setDirectorFullscreen(true); }}
						style={{
							position: 'absolute', top: 4, right: 6, zIndex: 5,
							padding: '2px 7px', fontSize: 10, lineHeight: 1.5, cursor: 'pointer',
							background: 'rgba(0,0,0,.55)', color: '#e6e6e6',
							border: '1px solid rgba(255,255,255,.22)', borderRadius: 5,
						}}
					>⛶ 全屏</button>
					{/* ★ 全屏时**卸载**卡片内联实例（而非隐藏）：编辑器在 mount 时读取
					    initialState，两个实例并存会各自持一份本地 state → 全屏里的编辑
					    无法反映到卡片、且双方副作用（自动写回）可能互相覆盖。卸载后关闭
					    全屏会重新挂载并读最新 `board_state`（全屏实例已 commitControl 写回）
					    → 天然一致。浮层本就覆盖整个视口，卡片此刻不可见，无观感损失。 */}
					{!directorFullscreen && renderDirectorConsole(false)}
				</div>
			)}

			{/* ★ 导演台全屏浮层：portal 到 document.body（脱离画布 transform/缩放，
			    与表情格编辑窗口同一模式）。与卡片内联**共用 renderDirectorConsole**
			    → 同一份 controlDrafts 状态，两处内容天然一致。 */}
			{showRun && isDirectorConsole && directorFullscreen && createPortal(
				<div
					style={{
						position: 'fixed', inset: 0, zIndex: 3000,
						background: 'rgba(0,0,0,.8)',
						display: 'flex', flexDirection: 'column',
					}}
					onPointerDown={e => e.stopPropagation()}
				>
					<div
						style={{
							display: 'flex', alignItems: 'center', gap: 8,
							padding: '6px 12px', flexShrink: 0,
							borderBottom: '1px solid var(--vscode-panel-border)',
							background: 'var(--vscode-editor-background, #1e1e1e)',
						}}
					>
						<span style={{ fontSize: 12, fontWeight: 600 }}>🎬 导演台 · 全屏</span>
						<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'Consolas, monospace' }}>
							{meta.nodeType}
						</span>
						<span style={{ flex: 1 }} />
						{/* ★ P2：独立 editor tab（可与画布并排）。
						    同一节点重复点击只聚焦已有 tab（host 侧 matches() 去重）。 */}
						<button
							type="button"
							title="在独立编辑器标签页中打开（可与画布并排；两处编辑实时同步）"
							onClick={() => { void handleOpenInTab(false); }}
							style={{
								padding: '3px 10px', fontSize: 11, cursor: 'pointer',
								background: 'rgba(34,211,238,.12)', color: 'var(--vscode-foreground, #e6e6e6)',
								border: '1px solid rgba(34,211,238,.45)', borderRadius: 5,
							}}
						>↗ 独立标签</button>
						{/* ★ P3（2026-09-13）：直接移入**独立窗口**（VS Code 辅助窗口）——
						    适合多显示器「画布一屏、编辑器一屏」。命令不可用时 host 只告警，
						    tab 仍在（可手动拖出成窗）。 */}
						<button
							type="button"
							title="在独立窗口中打开（可移到另一显示器；编辑器已开时重复点击会聚焦已有窗口）"
							onClick={() => { void handleOpenInTab(true); }}
							style={{
								padding: '3px 10px', fontSize: 11, cursor: 'pointer',
								background: 'rgba(167,139,250,.12)', color: 'var(--vscode-foreground, #e6e6e6)',
								border: '1px solid rgba(167,139,250,.45)', borderRadius: 5,
							}}
						>⬈ 新窗口</button>
						<button
							type="button"
							title="关闭全屏（Esc）"
							onClick={() => setDirectorFullscreen(false)}
							style={{
								padding: '3px 10px', fontSize: 11, cursor: 'pointer',
								background: 'rgba(255,255,255,.06)', color: 'var(--vscode-foreground, #e6e6e6)',
								border: '1px solid var(--vscode-panel-border)', borderRadius: 5,
							}}
						>✕ 关闭</button>
					</div>
					<div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', pointerEvents: 'auto' }}>
						{renderDirectorConsole(true)}
					</div>
				</div>,
				document.body,
			)}

			{/* Inline prompt editor (ComfyTV MainPromptInput equivalent).
			    ComfyTV 只在 generator variant 挂 main_prompt（useStageNode.ts:114），
			    transform/loader 没有 prompt。Multiangle/Panorama/Relight/Material/AnimatedEmoji 的
			    prompt 由各自编辑器自绘（hasInlineEditor 已抑制通用控件网格，但本
			    prompt 区独立门禁，须单独排除），不显示手动输入框。
			    ★ 2026-09-12 核对：`AnimatedEmoji` 此前**确实没有**自绘 prompt（原注释
			      与实现不符 ✗，用户报「视频生成 缺提示词字段」）—— 现已在
			      AnimatedEmojiEditor 阶段① 补上「提示词」textarea（写回 values.prompt），
			      本处继续排除 ✓（否则同一参数两套 UI）。 */}
			{showRun && stageVariant === 'generator' && meta.hasPrompt && !isMultiangle && !isPanorama && !isRelight && !isMaterial && editorKind !== 'animated-emoji' && (
				<MentionTextarea
					value={promptValue}
					onChange={commitPrompt}
					candidates={mentionCandidates}
					onPinAsset={pinMentionAsset}
					placeholder="提示词…（输入 @ 引用节点或选择文件）"
					rows={1}
				/>
			)}

			{/* 资产引用（Asset References，对齐 ComfyTV ImageStage）：钉住任意已生成
			    资产作为参考图，每条占一个 slot，执行时覆盖同 slot 的连线输入。 */}
			{showAssetRefs && (
				<AssetReferences
					refs={assetRefs}
					candidates={assetCandidates}
					onChange={setAssetRefs}
				/>
			)}

			{/* ComfyTV picker stage: Pool 状态栏 + 已选缩略图 + Clear（no-Run 节点）。 */}
			{meta.isPicker && (
				<>
					{/* Pool 状态条：显示去重后的候选总数 + 当前选中序号（对齐 ComfyTV）。 */}
					<div style={{
						display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, padding: '4px 6px',
						borderRadius: 4, border: '1px solid rgba(168,85,247,.35)', background: 'rgba(168,85,247,.08)',
						fontSize: 10, color: '#c4b5fd',
					}}>
						{/* 来源切换（对齐 ComfyTV batch tab / library tab）：上游 / 全部 */}
						<button
							type="button"
							onClick={() => setPoolScope(s => s === 'upstream' ? 'all' : 'upstream')}
							title={poolScope === 'upstream' ? '当前显示直接上游候选，点击切换为全部生成图' : '当前显示全部生成图，点击切换为直接上游候选'}
							style={{
								padding: '0 5px', borderRadius: 3, cursor: 'pointer', border: '1px solid rgba(255,255,255,.25)',
								background: poolScope === 'all' ? 'rgba(168,85,247,.28)' : 'transparent', color: '#c4b5fd',
								fontSize: 9, fontFamily: 'inherit', pointerEvents: 'auto', lineHeight: '16px',
							}}
						>
							{poolScope === 'upstream' ? '上游' : '全部'}
						</button>
						<span style={{ fontWeight: 700, letterSpacing: .5 }}>Pool {pickerPool.length}</span>
						<span style={{ opacity: .7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
							{pickerPool.length === 0
								? (poolScope === 'all' ? '… no images yet' : '… waiting for upstream')
								: (poolScope === 'all'
									// ★ 多选计数（2026-09-12）：旧文案 `· ${selectedIndex} selected`
									//   实际是「选中序号」（点第 7 张就写 7）→ 被误读成「已选 7 张」，
									//   而网格只有 1 格高亮。现改为真实**张数**。
									? (pickerSelectedRefs.length > 0 ? `· 已选 ${pickerSelectedRefs.length} 张` : '· 未选')
									: `· 已选 ${pickerSelectedIndices.length} 张`)}
						</span>
						{pickerPool.length > 0 && (
							<button
								type="button"
								onClick={clearPicker}
								title="清除选择"
								style={{
									marginLeft: 'auto', padding: '1px 6px', borderRadius: 3, cursor: 'pointer',
									border: '1px solid rgba(255,255,255,.2)', background: 'transparent', color: '#c4b5fd',
									fontSize: 9, fontFamily: 'inherit', pointerEvents: 'auto',
								}}
							>
								Clear
							</button>
						)}
					</div>
					{/* 空态：无候选时显示 no output yet。 */}
					{pickerPool.length === 0 && (
						<div style={{ marginTop: 4, padding: '6px', borderRadius: 4, fontSize: 10, color: 'var(--vscode-descriptionForeground, #858585)', textAlign: 'center', border: '1px dashed rgba(255,255,255,.12)' }}>
							no output yet
						</div>
					)}
					{/* Pool 网格：可点选（高亮 selected_index / directRef），对齐 ComfyTV batch+library tab。 */}
					{pickerPool.length > 0 && (
						<>
							<div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
								<span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground, #858585)' }}>Output</span>
								{primaryOutputType && (
									<span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1, padding: '1px 5px', borderRadius: 3, background: 'rgba(168,85,247,.18)', color: '#a855f7' }}>({primaryOutputType})</span>
								)}
							</div>
							{/* ★ 相对定位容器：删除确认框以 absolute 覆盖网格（见下）——
							    不用 `position:fixed`：卡片在 widgetBridge 的 transform:scale
							    容器内，fixed 会相对该容器定位 → 弹窗跑到画布别处 ✗。 */}
							<div style={{ position: 'relative' }}>
								{snapshotStore && <PickerPoolGrid entries={pickerPool} selectedIndices={pickerSelIndexSet} selectedRefs={pickerSelRefSet} poolScope={poolScope} onPick={pickImage} onRemove={requestPoolRemove} store={snapshotStore} />}
								{/* ── 删除确认（2026-09-12 用户需求「删除前要有用户询问窗口」）──
								    只覆盖网格区域（不遮挡卡片其它控件），显示待删图的缩略图
								    + 「删除 / 取消」，默认焦点在取消侧（误触 × 后直接回车不删）。 */}
								{pendingPoolRemove && pickerPool.some(e => e.key === pendingPoolRemove.key) && (
									<div style={{
										position: 'absolute', inset: 0, zIndex: 10, boxSizing: 'border-box',
										borderRadius: 6, background: 'rgba(10,10,12,.88)',
										border: '1px solid rgba(255,107,107,.55)',
										display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
										gap: 5, padding: 6, pointerEvents: 'auto',
									}}>
										<div style={{ fontSize: 10, fontWeight: 700, color: '#fff' }}>删除这张图？</div>
										<img
											src={pendingPoolRemove.ref} alt=""
											style={{ width: 46, height: 46, objectFit: 'contain', borderRadius: 4, background: '#1b1c20', border: '1px solid rgba(255,255,255,.2)' }}
										/>
										<div style={{ fontSize: 9, color: '#fca5a5', textAlign: 'center', lineHeight: 1.35 }}>
											将从候选池移除（含本地缓存），<br />删除后不可恢复
										</div>
										<div style={{ display: 'flex', gap: 6 }}>
											<button
												type="button"
												onClick={confirmPoolRemove}
												style={{ padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 10, fontWeight: 600, border: 'none', color: '#fff', background: '#b91c1c' }}
											>删除</button>
											<button
												type="button"
												onClick={() => setPendingPoolRemove(null)}
												title="取消（不删除）"
												style={{ padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 10, border: '1px solid rgba(255,255,255,.25)', color: '#e8e8e8', background: 'transparent' }}
											>取消</button>
										</div>
									</div>
								)}
							</div>
						</>
					)}
				</>
			)}

			{/* Erase / Inpaint 内嵌 mask 画笔编辑器（对齐 ComfyTV StageCard：卡片里
			    直接渲染画笔画布 + 工具，而非双击弹窗）。需 pointerEvents:auto 覆盖卡片
			    根的 none（否则无法涂抹）。写回通过 wf-node-control 事件（mask_data /
			    mask_ops / prompt）。 */}
			{isMaskEdit && (
				<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4 }}>
					{(() => {
						const registry = getActiveRunnerRegistry();
						if (!registry) { return null; }
						return (
							<MaskPainter
								imageRef={upstreamImageRef}
								initialOps={undefined}
								// prompt 由 NodeCard 上方的 inline prompt 编辑器负责（inpaint
								// 节点 hasPrompt=true 已显示 textarea），内嵌 MaskPainter 不再
								// 重复渲染 prompt textarea。
								showPrompt={false}
								runners={registry}
								preference={getActiveRunnerPreference()}
								onMaskChange={(annotated) => commitMaskField('mask_data', annotated)}
								onOpsChange={(opsJson) => commitMaskField('mask_ops', opsJson)}
							/>
						);
					})()}
				</div>
			)}

			{/* Crop 内嵌拖拽裁剪编辑器（对齐 ComfyTV CropStage 卡片内 canvas 交互，
			    替代纯数字 x/y/width/height）。写回通过 wf-node-control（commitCrop）。 */}
			{isCrop && (
				<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4 }}>
					<CropEditor
						initial={{
							x: Number(ctl('x', 0)),
							y: Number(ctl('y', 0)),
							width: Number(ctl('width', 512)),
							height: Number(ctl('height', 512)),
						}}
						imageRef={upstreamImageRef}
						onCropChange={commitCrop}
						/>
						</div>
						)}

						{/* Outpaint 内嵌方向拖拽 padding 编辑器（对齐 ComfyTV OutpaintStageCard：
						棋盘格画布 + 四向拖拽手柄 + 数字输入）。写回通过 wf-node-control（commitOutpaint）。 */}
						{isOutpaint && (
						<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4 }}>
						<OutpaintEditor
						initial={{
							left: Number(ctl('pad_left', 0)),
							top: Number(ctl('pad_top', 0)),
							right: Number(ctl('pad_right', 0)),
							bottom: Number(ctl('pad_bottom', 0)),
							feathering: Number(ctl('feathering', 0)),
						}}
						imageRef={upstreamImageRef}
						onCommit={commitOutpaint}
						/>
						</div>
						)}

			{/* GridSplit 内嵌网格编辑器（对齐 ComfyTV GridSplitStageCard：预设 + 行列 + Border +
			    外缘边距 + 可视化网格 + selected_index）。写回通过 wf-node-control（commitGridSplit）。 */}
			{isGridSplit && (
				<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4 }}>
					<GridSplitEditor
						initial={{
							rows: Number(ctl('rows', 2)),
							cols: Number(ctl('cols', 2)),
							border: Number(ctl('border', 0)),
							outerBorder: Boolean(ctl('outer_border', false)),
							selectedIndex: Number(ctl('selected_index', 1)),
						}}
						imageRef={upstreamImageRef}
						onCommit={commitGridSplit}
					/>
				</div>
			)}

			{/* LoadImage 内嵌预览（对齐 ComfyTV LoadImage：文件名 + 上传按钮 + 缩略图 + W×H）。
			    替代通用 OUTPUT 区（hideOutput+hideActions 已配置）。缩略图数据源（三选一）：
			    ① ownSnapshots 的 image entry（运行后 / 粘贴后写入）
			    ② controlDrafts['image']（上传按钮暂存的 data URL）
			    ③ properties['mediaAssetId']（素材库拖入/选中，渲染时 lazy 解析为 URL）——
			    否则只是 mediaAssetId 配置时（未运行）卡片仍空白。 */}
			{isImageLoader && (() => {
				const [assetUrl, setAssetUrl] = React.useState<string | null>(null);
				React.useEffect(() => {
					// ★★ 修复 `ReferenceError: properties is not defined`：
					//   NodeCard 的 props 没有 properties（ getNodeCardMeta 才有），
					//   这里改用 meta.mediaAssetId（ getNodeCardMeta 从 properties
					//   提取的正规通道）。旧代码 `properties['mediaAssetId']` 是
					//   自由变量 → Load 节点整卡渲染崩溃 → body 空白。
					const aid = meta.mediaAssetId ?? '';
					if (!aid) { setAssetUrl(null); return; }
					if (ownOutputs.find(s => s.media?.kind === 'image')) { return; }
					// ★ 复用 workflowRun 的解析（host mediaGet）+ renderer fallback
					resolveMediaAssetUrl(aid).then(url => setAssetUrl(url));
				}, [meta.mediaAssetId, ownSnapshots]);
				const storedImg = (() => {
					// ★★ MediaSnapshotEntry 的引用在 entry.media.ref（无顶层 ref），
					//   此前误写 first.ref → 恒 undefined → 选图后缩略图不显示。
					const first = ownOutputs.find(s => s.media?.kind === 'image');
					if (first) { return first.media.ref; }
					if (assetUrl) { return assetUrl; }
					// ★ LoadImage 弹窗选图值（properties.image）优先于内嵌上传草稿。
					if (meta.image) { return meta.image; }
					return (controlDrafts['image'] ?? '') as string;
				})();
				const inputRef = React.useRef<HTMLInputElement | null>(null);
				const [size, setSize] = React.useState<{ w: number; h: number } | null>(null);
				React.useEffect(() => {
					if (!storedImg) { setSize(null); return; }
					const img = new Image();
					img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight });
					img.onerror = () => setSize(null);
					img.src = comfyViewUrl(activeRunnerBase, storedImg);
				}, [storedImg]);
				const fileName = storedImg ? (() => {
					try {
						if (storedImg.startsWith('data:')) { return 'pasted image'; }
						const u = new URL(storedImg);
						return decodeURIComponent(u.pathname.split('/').pop() || storedImg);
					} catch { return storedImg.slice(0, 32); }
				})() : '';
				return (
					<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
						<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
							<input
								value={fileName}
								readOnly
								placeholder="（未选图）"
								style={{ flex: 1, minWidth: 0, padding: '4px 7px', fontSize: 11, background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: 4, outline: 'none', cursor: 'pointer' }}
								onClick={() => inputRef.current?.click()}
							/>
							<button type="button" title="上传本地图片" onClick={() => inputRef.current?.click()}
								style={{ height: 24, width: 26, border: '1px solid var(--vscode-input-border)', background: 'transparent', color: 'var(--vscode-foreground)', borderRadius: 4, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
								<svg width="13" height="13" viewBox="0 0 16 16" fill="none">
									<path d="M2 11v2.5A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
									<path d="M8 2v8.5m0 0L5 7.5M8 10.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
								</svg>
							</button>
							<input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }}
								onChange={e => {
									const f = e.target.files && e.target.files.length > 0 ? e.target.files[0] : null;
									if (!f) { return; }
									const reader = new FileReader();
									reader.onload = () => {
										const s = typeof reader.result === 'string' ? reader.result : '';
										if (s) { commitControl('image', s); }
									};
									reader.readAsDataURL(f);
									e.target.value = '';
								}} />
						</div>
						{storedImg && (
							<div style={{ background: 'var(--vscode-input-background)', border: '1px solid var(--vscode-input-border)', borderRadius: 4, padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
								<img src={storedImg} alt="" style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain' }} />
							</div>
						)}
						{size && (
							<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', textAlign: 'center', fontFamily: 'var(--monospace, monospace)' }}>{size.w} × {size.h}</div>
						)}
					</div>
				);
			})()}

			{/* StatEmojiStage 静态网格编辑器（m×n 透明贴纸 + 主题预设 + 全局 prompt）。
			    写回通过 wf-node-control（commitControls）。cellRefs 用本节点快照按 index 映射。 */}
			{isEmojiStatic && (
				<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4 }}>
					<StatEmojiStageEditor
						initial={{
							rows: Number(ctl('rows', 3)),
							cols: Number(ctl('cols', 3)),
							// ★ prompt/cells 是 TEXT widget，不进 meta.controls（toControls
							//   对 ComfyTV 只收 COMBO/INT/FLOAT/BOOLEAN）→ ctl 永远 fallback
							//   空值，重启后编辑器重新挂载会丢失已填内容。
							//   改用 meta.prompt / meta.cells 直接透传（见 NodeCardMeta）。
							prompt: String(meta.prompt ?? ctl('prompt', '')),
							cells: String(meta.cells ?? ctl('cells', '[]')),
							selectedIndex: Number(ctl('selected_index', 0)),
							stylePreset: String(ctl('style_preset', 'none') ?? 'none'),
							// 每格裁剪框（归一化 JSON）——「调整裁剪」拖拽/缩放写回
							cellCrops: cellCropsJson,
							// 生成渠道（2026-09-02）：ComfyUI / Provider 选项卡状态
							backend: ctl('backend', 'comfyui') === 'provider' ? 'provider' : 'comfyui',
							comfyModel: String(ctl('comfy_model', 'sd_xl_base_1.0.safetensors') ?? ''),
							providerId: String(ctl('provider', '') ?? ''),
							modelId: String(ctl('model', '') ?? ''),
							// 整版背景策略（auto|green|transparent|white，默认 auto = 跟随提示词）
							sheetBackground: String(ctl('sheet_background', 'auto') ?? 'auto') as 'white' | 'green' | 'transparent' | 'auto',
							// 切分抠图方式（none|chroma|flood，默认 none）
							cutoutMode: (() => { const m = String(ctl('cutout_mode', 'none') ?? 'none'); return m === 'chroma' || m === 'flood' ? m : 'none'; })() as 'none' | 'chroma' | 'flood',
							// 切分方式（grid|auto，默认 grid = 等分网格）
							cellCropMode: String(ctl('cell_crop_mode', 'grid') ?? 'grid') === 'auto' ? 'auto' as const : 'grid' as const,
							// 生成图像大小（2026-09-02）：整版图集分辨率 'WxH'
							size: String(ctl('size', '1024x1024') ?? '1024x1024'),
						}}
						// ★ LLM 原图缩略图（2026-09-03）：整图 ref + 归档时的 rows/cols（网格叠加）
						sheetRef={sheetFullEntry?.media.ref}
						sheetGrid={(() => {
							const { rows: r, cols: c } = sheetDimsOf(sheetFullEntry?.media.meta);
							return r > 0 && c > 0 ? { rows: r, cols: c } : undefined;
						})()}
						// ★ 调整后图集（2026-09-03）：单格编辑/裁剪保存后重拼的 image 口
						//   图集（meta.sheet='1'）——下游转动态节点实际读取的就是它。
						//   注意 latestRoundOf 优先 merged，此处独立反向扫描避免混入 sheetFull。
						rebuiltSheetRef={(() => {
							for (let i = ownSnapshots.length - 1; i >= 0; i--) {
								const e = ownSnapshots[i];
								if (e.media?.kind === 'image' && e.media?.meta?.sheet === '1') { return e.media.ref; }
							}
							return undefined;
						})()}
						rebuiltGrid={(() => {
							for (let i = ownSnapshots.length - 1; i >= 0; i--) {
								const e = ownSnapshots[i];
								if (e.media?.kind === 'image' && e.media?.meta?.sheet === '1') {
									const { rows: r, cols: c } = sheetDimsOf(e.media.meta);
									return r > 0 && c > 0 ? { rows: r, cols: c } : undefined;
								}
							}
							return undefined;
						})()}
						cellRefs={ownOutputs.map(e => ({
  ref: e.media.ref,
  kind: e.media.kind === 'video' ? 'video' : 'image',
  caption: typeof e.media.meta?.caption === 'string' ? e.media.meta.caption : undefined,
}))}
						// ★ workflow 下拉由编辑器自己渲染：通用控件网格有 `!hasInlineEditor`
						//   门禁，静态节点有内嵌编辑器 ⇒ 所有 widget 控件都不渲染，
						//   workflow 必须在此透传（见 registry 的 static workflow options）。
						workflowOptions={emojiWorkflowOptions}
						onCommit={commitControls}
						running={run.runState === 'running'}
						onCancelRequest={() => {
							if (nodeId) {
								window.dispatchEvent(new CustomEvent('wf-node-abort', { detail: { nodeId } }));
							}
						}}
						mentionCandidates={mentionCandidates}
						onPinAsset={pinMentionAsset}
						onCellEdit={(i) => setEditingEmojiCell(i)}
						// 双击 LLM 原图 → 整图编辑。-1 = 哨兵「整图模式」（cellIndex 恒 ≥0，无歧义）：
						// 复用同一 portal 弹窗与 MiniImageEditor，仅 onApply 目标不同（见弹窗内 EmojiSheetEditor 分支）。
						// ★ 直通预览禁编辑：写入路径（replaceByKey）落在 sheetFullEntry.key——
						//   直通时该 key 属于**上游节点**归档，编辑会污染上游数据。上游图
						//   要改请回上游节点处理；本节点生成自己的原图后编辑自动恢复。
						// ★ 仅「真图集直通」（meta.sheetFull='1'，cell_crops 坐标系有效）
						//   保持禁编辑；**上游普通图**（ImageLoader 等）直通时放行整图编辑——
						//   产物经 onApply 写**本节点**新 sheetFull 基底（不触碰上游归档），
						//   写入后 localSheetFull=YES 抢占逻辑自动切本地（2026-09-07）。
						onSheetEdit={(sheetFullEntryIsPassthrough && passthroughIsSheetFull) ? undefined : () => setEditingEmojiCell(-1)}
						// 🪄 一键去背景：本地 rembg → 透明 PNG 写入「调整后」图集口（原图归档不动；见 handleSheetRemoveBg）
						//   直通预览禁用（同 onSheetEdit：上游归档不可改写）。
						// ★ 去背景直通放行（2026-09-06）：写键恒为本节点 `snapKey:image:0`
					//   （「调整后」图集口），不触碰上游归档——此前误并入整图编辑的
					//   直通禁写（那才会 replaceByKey 落上游键）。放行后上游 ImageLoader
					//   等无去背景能力的节点不再卡死用户。
					onSheetRemoveBg={handleSheetRemoveBg}
												// ★ 去背景执行中（2026-09-08 补传）：此前漏传 → 按钮永远无
												//   「去背景中…」/禁用态，点击毫无视觉反馈（用户反馈实证）。
												sheetRemovingBg={sheetRemovingBg}
												// ★ sheet 直通预览标志（2026-09-06）：编辑器据此显示只读提示、禁用整图编辑。
						//   2026-09-07 收窄：仅「真图集直通」（meta.sheetFull='1'）只读；上游
						//   普通图直通可整图编辑（产物写本节点 sheetFull 基底）。
						isPassthroughSheet={sheetFullEntryIsPassthrough && passthroughIsSheetFull}
						sheetRemoveBgStage={sheetRemoveBgStage}
						sheetRemoveBgDoneTick={sheetRemoveBgDoneTick}
						sheetRemoveBgError={sheetRemoveBgError}
						onRunRequest={(cellIndex) => {
							// run_scope 决定执行范围（workflowRun.runEmojiStageGrid 消费）：
							//   cellIndex 有值 → 'cell'（只重生成该格，并同步 selected_index）
							//   cellIndex 缺省 → 'all'（生成全部格）
							if (cellIndex !== undefined) {
								commitControls({ selected_index: cellIndex, run_scope: 'cell' });
							} else {
								commitControls({ run_scope: 'all' });
							}
							if (nodeId) {
								window.dispatchEvent(new CustomEvent('wf-node-run', { detail: { nodeId } }));
							}
						}}
					/>
					{/* ★ 双击格进入的单格编辑器（v7）：拖拽/缩放裁剪框 + 橡皮擦。
					    应用 = cell_crops 写回 + recrop（跳过生成）；擦除 = 整图像素
					    replaceByKey 原地更新（port 'sheet'）。 */}
					{/* ★ 独立窗口（portal 到 body）：画布节点有 transform/缩放，内嵌或
					    普通 fixed 都会受 containing block 影响；用 createPortal 挂到
					    document.body 才是真正的居中模态窗口。 */}
					{editingEmojiCell !== null && createPortal(
						<div
							onClick={() => setEditingEmojiCell(null)}
							style={{
								position: 'fixed', inset: 0, zIndex: 3000,
								background: 'rgba(0,0,0,.55)',
								display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
							}}
						>
						<div
							onClick={(e) => e.stopPropagation()}
							style={{
								width: 'min(560px, 94vw)', maxHeight: '88vh', overflow: 'auto',
								borderRadius: 10, padding: 12, background: 'var(--vscode-editor-background, #1f1f23)',
								border: '1px solid rgba(255,255,255,.12)',
								boxShadow: '0 12px 48px rgba(0,0,0,.55)',
							}}
						>
							{/* ★ 无 LLM 原生整图（旧版产物）→ 降级为「只编辑本格」：
							    直接以该格切分图为基底（此时整图=这一格，不存在坐标系错位），
							    但隐藏整图裁剪类功能；顶部给一键重新生成入口补齐原图归档。 */}
							{(() => {
								// editingEmojiCell === -1 → 双击 LLM 原图进入的「整图编辑」模式：
								// 基底只能是原生整图（无单格回退），Save 替换 sheetFull 条目本身。
								const isSheetEdit = editingEmojiCell === -1;
								const cellFallbackRef = isSheetEdit ? '' : (ownOutputs[editingEmojiCell]?.media.ref ?? '');
								// ★ 双击单格基底优先「去背景后图集」（2026-09-07）：rembg 副本与
								//   原生整图**同尺寸**（去背景不改分辨率）→ 裁剪框坐标系有效。
								//   在抠像版上拖框/保存，单格产物即透明底贴纸；写回的 cell_crops
								//   对原生整图同样有效（同尺寸）。无去背景副本 → 回退原生整图。
								//   整图编辑（-1）不受影响：基底恒为原生整图本身。
								const baseRef = (() => {
									if (isSheetEdit) { return sheetFullEntry?.media.ref ?? cellFallbackRef; }
									for (let i = ownSnapshots.length - 1; i >= 0; i--) {
										const e = ownSnapshots[i];
										if (e.media?.kind === 'image' && e.media?.meta?.removeBg === '1') { return e.media.ref; }
									}
									return sheetFullEntry?.media.ref ?? cellFallbackRef;
								})();
								if (!baseRef) {
									return (
										<div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 2px' }}>
											<div style={{ fontSize: 11, color: '#fbbf24' }}>{isSheetEdit ? '⚠ 没有可编辑的 LLM 原图' : '⚠ 本格还没有可编辑的图片'}</div>
											<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', lineHeight: 1.6 }}>
												{isSheetEdit
													? '整图编辑需要生成时归档的原生整图（旧版产物没有归档）。请重新生成一次表情包后，再双击原图编辑。'
													: '请先生成表情包，再双击格子编辑。'}
											</div>
											<button
												onClick={() => setEditingEmojiCell(null)}
												style={{ padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 10, border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground, #e8e8e8)' }}
											>知道了</button>
										</div>
									);
								}
								return (
								<>
								{!isSheetEdit && !sheetFullEntry?.media.ref && (
									<div style={{
										fontSize: 10, lineHeight: 1.6, marginBottom: 6, padding: '6px 8px', borderRadius: 6,
										background: 'rgba(251,191,36,.12)', border: '1px solid rgba(251,191,36,.35)', color: '#fbbf24',
									}}>
										<div>⚠ 旧版产物：未找到 LLM 返回的原生整图，已按「本格图片」打开。</div>
										<div style={{ color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
											可正常擦除/绘制/文字；**整图自定义裁剪**需要原图——重新生成一次表情包后即可使用。
										</div>
										<button
											onClick={() => {
												if (nodeId) {
													window.dispatchEvent(new CustomEvent('wf-node-run', { detail: { nodeId } }));
												}
												setEditingEmojiCell(null);
											}}
											style={{ marginTop: 6, padding: '4px 9px', borderRadius: 5, cursor: 'pointer', fontSize: 10, border: '1px solid rgba(251,191,36,.5)', background: 'rgba(251,191,36,.18)', color: '#fbbf24' }}
										>↻ 重新生成表情包（补齐原图）</button>
									</div>
								)}
							<MiniImageEditor
								sheetOnly={!sheetFullEntry?.media.ref}
								sheetDataUrl={baseRef}
								cellKey={editingEmojiCell}
								// ★ AI 工具（消除/重绘/扩图）与节点同源：透传节点上配置的
								// provider/model，并**锁定**（preferred 不可用时报错而非回落
								// 其它 provider——「节点用 A、编辑器用 B」的出图差异极难排查）。
								preferredProviderId={String(ctl('provider', '') ?? '') || undefined}
								preferredModelId={String(ctl('model', '') ?? '') || undefined}
								lockProvider
								heading={editingEmojiCell === -1
									? (sheetFullEntryIsPassthrough
										? (passthroughIsSheetFull ? '查看原图（上游直通 · 只读）' : '编辑原图（上游普通图 · 存为本节点基底）')
										: '编辑原图（LLM 原生整图）')
									: undefined}
								// ★ 只读仅限「真图集直通」（上游归档不可改写）。普通图直通可编辑
								//   （产物写本节点本地，见 onApply 的普通图直通分支）。
								readOnly={sheetFullEntryIsPassthrough && passthroughIsSheetFull}
								crop={(() => {
									if (editingEmojiCell === -1) { return { x: 0, y: 0, w: 1, h: 1 }; }   // 整图编辑：裁剪框=全图
									const rows = Math.max(1, Number(ctl('rows', 3)) || 3);
									const cols = Math.max(1, Number(ctl('cols', 3)) || 3);
									let crops: CellCropRect[] | null = null;
									try {
										const arr = JSON.parse(cellCropsJson || 'null') as unknown;
										if (Array.isArray(arr) && arr.length === rows * cols
											&& arr.every(o => o && typeof o === 'object'
												&& typeof (o as CellCropRect).x === 'number' && typeof (o as CellCropRect).w === 'number')) {
											crops = arr as CellCropRect[];
										}
									} catch { /* fallthrough → 等分默认 */ }
									const cw = 1 / cols, chh = 1 / rows, ix = cw * EMOJI_SHEET_MARGIN_RATIO, iy = chh * EMOJI_SHEET_MARGIN_RATIO;
									const dflt: CellCropRect[] = [];
									for (let r = 0; r < rows; r++) { for (let cc = 0; cc < cols; cc++) { dflt.push({ x: cc * cw + ix, y: r * chh + iy, w: cw - ix * 2, h: chh - iy * 2 }); } }
									if (!sheetFullEntry?.media.ref) { return { x: 0, y: 0, w: 1, h: 1 }; }
								return (crops ?? dflt)[editingEmojiCell] ?? dflt[editingEmojiCell];
								})()}
								onApply={(crop, croppedDataUrl) => {
									// ── 整图编辑模式（editingEmojiCell === -1，双击 LLM 原图进入）──
									// Save = 用编辑后的图**替换 sheetFull 条目本身**
									//（meta.sheetFull='1' 原样保留 → 仍是后续单格编辑/重裁的合法基底）。
									// 格子产物不联动重裁——需要时双击格子按新原图重新裁剪即可。
									if (editingEmojiCell === -1) {
										if (!croppedDataUrl) {
											// eslint-disable-next-line no-console
											console.warn('[EmojiSheetEditor] apply skipped: croppedDataUrl 为空（buildCropped 失败）');
										} else if (!snapshotStore) {
											// eslint-disable-next-line no-console
											console.warn('[EmojiSheetEditor] apply skipped: snapshotStore 未注入');
										} else if (sheetFullEntryIsPassthrough && passthroughIsSheetFull) {
											// 真图集直通：基底归上游节点归档，改写会污染上游数据
											// eslint-disable-next-line no-console
											console.warn('[EmojiSheetEditor] apply skipped: 当前原图为真图集直通预览（上游归档只读）');
										} else if (sheetFullEntryIsPassthrough) {
											// ★ 上游普通图直通（isSheetFull=false）→ 编辑产物写**本节点**
											//   新 sheetFull 基底（port 'sheet'，meta.sheetFull='1'+rows/cols），
											//   不 replaceByKey（上游 ImageLoader 归档不可改写）。写入后
											//   localSheetFull=YES → 抢占逻辑自动切本地基底（直通普通图
											//   不再占位），重裁/单格编辑全解锁（2026-09-07）。
											const rowsN = String(ctl('rows', 2) ?? 2);
											const colsN = String(ctl('cols', 2) ?? 2);
											snapshotStore.put({
												nodeId: snapKey ?? nodeId ?? sheetFullEntry.nodeId,
												port: 'sheet',
												key: '',
												media: {
													kind: 'image',
													ref: croppedDataUrl,
													meta: { sheetFull: META_SHEET_FLAG, rows: rowsN, cols: colsN, fromUpstreamPlain: '1' },
												},
											}, true);
											// eslint-disable-next-line no-console
											console.log(`[EmojiSheetEditor] 上游普通图编辑 → 已写本节点 sheetFull 基底（rows=${rowsN} cols=${colsN} len=${croppedDataUrl.length}）`);
										} else if (!sheetFullEntry) {
											// eslint-disable-next-line no-console
											console.warn('[EmojiSheetEditor] apply skipped: sheetFull 条目不存在');
										} else {
											const ok = snapshotStore.replaceByKey(sheetFullEntry.key, { ...sheetFullEntry.media, ref: croppedDataUrl });
											if (!ok) {
												// key 失效兜底：追加新条目并保留 sheetFull 身份（meta 原样）
												snapshotStore.put({ nodeId: snapKey ?? nodeId ?? sheetFullEntry.nodeId, port: sheetFullEntry.port, key: '', media: { ...sheetFullEntry.media, ref: croppedDataUrl } }, true);
												// eslint-disable-next-line no-console
												console.warn('[EmojiSheetEditor] replaceByKey 失败（key 失效）→ 已追加为新条目');
											} else {
												// eslint-disable-next-line no-console
												console.log(`[EmojiSheetEditor] apply sheet replaced key=${sheetFullEntry.key} len=${croppedDataUrl.length}`);
											}
										}
										// ★ 联动重切（2026-09-03 用户需求）：整图被 AI 处理（消除/重绘/
										//   扩图/去背景）或手动编辑后，**单格产物必须按新整图重新切分**
										//   —— 否则格子里还是旧内容，用户以为编辑没生效。每格继承
										//   既有 meta（cellPrompt 等随格保留），裁剪框沿用 cell_crops。
										// ★ 直通时同样禁止联动重切：它会 clearNode(key0) 清空本节点归档再按上游
										//   整图重写格子，等于把上游数据实体化到本地（且 sheetFull 基底未同步
										//   写入 → 后续重裁无基底）。与上方 apply 同一只读语义。
										if (snapshotStore && sheetFullEntry && croppedDataUrl && !sheetFullEntryIsPassthrough) {
											const key0 = snapKey ?? nodeId ?? sheetFullEntry.nodeId;
											void (async () => {
												setSheetRemovingBg(true);
												try {
													const rowsR = Math.max(1, Number(ctl('rows', 3)) || 3);
													const colsR = Math.max(1, Number(ctl('cols', 3)) || 3);
													let cropsR: CellCropRect[] = [];
													try {
														const arr = JSON.parse(cellCropsJson || 'null') as unknown;
														if (Array.isArray(arr) && arr.length === rowsR * colsR) { cropsR = arr as CellCropRect[]; }
													} catch { /* 等分默认 */ }
													if (cropsR.length !== rowsR * colsR) {
														const cw = 1 / colsR, chh = 1 / rowsR, ix = cw * EMOJI_SHEET_MARGIN_RATIO, iy = chh * EMOJI_SHEET_MARGIN_RATIO;
														cropsR = [];
														for (let rr = 0; rr < rowsR; rr++) { for (let c2 = 0; c2 < colsR; c2++) { cropsR.push({ x: c2 * cw + ix, y: rr * chh + iy, w: cw - ix * 2, h: chh - iy * 2 }); } }
													}
													// 编辑产物是 data: URL → 裸 fetch（proxiedFetch 语义绑远程图）。
													const cellsOut = await splitStickerSheet(croppedDataUrl, rowsR, colsR, { marginRatio: EMOJI_SHEET_MARGIN_RATIO, cutoutBg: false, cellCrops: cropsR }, globalThis.fetch);
													// 旧格 meta 继承表（cellIndex 精确匹配，不信下标）
													const oldByCell = new Map<number, typeof sheetFullEntry.media>();
													for (const e of snapshotStore.byNode(key0)) {
														const ci = e.media.meta?.cellIndex;
														if (typeof ci === 'number') { oldByCell.set(ci, e.media); }
													}
													const sheetMedia = { ...sheetFullEntry.media, ref: croppedDataUrl };
													snapshotStore.clearNode(key0);
													for (let i = 0; i < cellsOut.length; i++) {
														const old = oldByCell.get(i);
														snapshotStore.put({
															nodeId: key0, port: 'output', key: '',
															media: {
																kind: 'image' as const,
																ref: cellsOut[i].dataUrl,
																meta: {
																	mime: 'image/png',
																	...(old?.meta?.cellPrompt ? { cellPrompt: old.meta.cellPrompt } : {}),
																	sheetMode: '1',
																	cellIndex: i,
																	cellSize: `${cellsOut[i].w}x${cellsOut[i].h}`,
																	cellRect: JSON.stringify(cropsR[i]),
																},
															},
														}, true);
													}
													snapshotStore.put({ nodeId: key0, port: 'sheet', key: '', media: sheetMedia }, true);
													// eslint-disable-next-line no-console
													console.log(`[EmojiSheetEditor] 整图已更新，联动重切 ${cellsOut.length} 格完成`);
												} catch (err) {
													// eslint-disable-next-line no-console
													console.error('[EmojiSheetEditor] 联动重切失败（整图已更新，可双击格子手动重裁）：', err);
												} finally {
													setSheetRemovingBg(false);
												}
											})();
										}
										setEditingEmojiCell(null);
										return;
									}
									const rows = Math.max(1, Number(ctl('rows', 3)) || 3);
									const cols = Math.max(1, Number(ctl('cols', 3)) || 3);
									let crops: CellCropRect[] = [];
									try {
										const arr = JSON.parse(cellCropsJson || 'null') as unknown;
										if (Array.isArray(arr) && arr.length === rows * cols) { crops = arr as CellCropRect[]; }
									} catch { /* keep empty → 全量等分重建 */ }
									if (crops.length !== rows * cols) {
										const cw = 1 / cols, chh = 1 / rows, ix = cw * EMOJI_SHEET_MARGIN_RATIO, iy = chh * EMOJI_SHEET_MARGIN_RATIO;
										crops = [];
										for (let rr = 0; rr < rows; rr++) { for (let ccc = 0; ccc < cols; ccc++) { crops.push({ x: ccc * cw + ix, y: rr * chh + iy, w: cw - ix * 2, h: chh - iy * 2 }); } }
									}
									crops[editingEmojiCell] = crop;
									// ★ 只记录裁剪框坐标（供下次打开对齐 / 生成时取景）。
									//   run_scope 显式重置 'all'：旧逻辑这里写的是 'recrop'，残留会让
									//   下次点「生成表情包」被判为重裁 → 跳过生成、直接切旧图。
									commitControls({ cell_crops: JSON.stringify(crops), run_scope: 'all' });
									// ★ 裁剪出的新图**直接替换本格产物**（ownOutputs）。
									//   原图（sheetFull）保持只读不变 → 其他格仍从原生整图裁剪。
									//   目标匹配：**优先 meta.cellIndex**（切分重放时写入）——部分格
									//   生成失败时 ownOutputs 会缺条目、数组下标与格号错位，用下标
									//   会替换到**错误的格子**（表现即「编辑后 output 没更新」）。
									const tgt = ownOutputs.find(e => Number(e.media?.meta?.cellIndex ?? -1) === editingEmojiCell)
										?? ownOutputs[editingEmojiCell];
									if (!croppedDataUrl) {
										// eslint-disable-next-line no-console
										console.warn('[EmojiCellEditor] apply skipped: croppedDataUrl 为空（buildCropped 失败）');
									} else if (!snapshotStore) {
										// eslint-disable-next-line no-console
										console.warn('[EmojiCellEditor] apply skipped: snapshotStore 未注入');
									} else if (!tgt) {
										// eslint-disable-next-line no-console
										console.warn(`[EmojiCellEditor] apply skipped: 找不到格 ${editingEmojiCell} 的产物条目（ownOutputs.length=${ownOutputs.length}）`);
									} else {
										const ok = snapshotStore.replaceByKey(tgt.key, { ...tgt.media, ref: croppedDataUrl });
										// eslint-disable-next-line no-console
										console.log(`[EmojiCellEditor] apply cell=${editingEmojiCell} key=${tgt.key} crop=${JSON.stringify(crop)} replaced=${ok ? 'yes' : 'NO'} len=${croppedDataUrl.length}`);
										if (!ok) {
											// 兜底：key 失效（编辑期间快照被重排）→ 以新条目补回该格，
											// 保证编辑结果不丢（代价是追加到序列尾）。
											snapshotStore.put({ nodeId: snapKey ?? nodeId ?? tgt.nodeId, port: 'output', key: '', media: { ...tgt.media, ref: croppedDataUrl } }, true);
											// eslint-disable-next-line no-console
											console.warn('[EmojiCellEditor] replaceByKey 失败（key 失效）→ 已追加为新条目');
										}
									}
									// ── 保存后自动重建 image 口合并图集（2026-09-03）────────────
									// 下游「转动态表情包」消费的是 port 'image'（meta.sheet='1'）的
									// 整版图集，而非单格条目——只替换单格的话下游永远拿旧图集。
									// 拼装算法与生成时完全同源（composeImageGridOnChroma：正方形
									// cell=max(各格max(w,h))、等比缩放居中 fit、透明底），单格尺寸
									// 不一由其标准化消化；重拼后下游等分切割契约不变。
									{
										const total = rows * cols;
										// 1) 收集各格最新 ref：cellIndex → ref（只信 cellIndex，宁缺毋错——
										//    旧数据无 cellIndex 时放弃重建并提示重新生成）
										const idxRefs = new Map<number, string>();
										for (const e of ownOutputs) {
											const ci = Number(e.media?.meta?.cellIndex ?? -1);
											if (ci >= 0 && ci < total && !idxRefs.has(ci)) { idxRefs.set(ci, e.media.ref); }
										}
										// 2) 刚保存的这张替位（onApply 闭包里的 ownOutputs 是旧值）
										idxRefs.set(editingEmojiCell, croppedDataUrl);
										// 3) 完整性检查：0..total-1 必须全有——composeImageGridOnChroma
										//    按输入顺序填格，中间缺格会让后续格**前移错位**（宁缺毋错）
										const missing: number[] = [];
										const refs: string[] = [];
										for (let i = 0; i < total; i++) {
											const r = idxRefs.get(i);
											if (r) { refs.push(r); } else { missing.push(i); }
										}
										if (missing.length > 0) {
											// eslint-disable-next-line no-console
											console.warn(`[EmojiCellEditor] sheet rebuild skipped: 缺格 ${missing.join(',')}（部分格未生成或旧数据无 cellIndex）→ image 口图集保持旧版，下游如需最新请重新生成`);
										} else {
											void (async () => {
												try {
													const sheetDataUrl = await composeImageGridOnChroma(refs, rows, cols, 0, null, fetch);
													// ★ 追加副本（2026-09-06）：与去背景同语义——重拼图集作为新条目
													//   put 进 image 口，不覆写既有 `image:0`（旧实现与去背景互相
													//   抹掉对方的产物）。读取方均取尾部最新 sheet='1' → 新副本生效。
													snapshotStore.put({
														nodeId: snapKey ?? nodeId ?? '',
														port: 'image',
														key: '',
														media: {
															kind: 'image' as const,
															ref: sheetDataUrl,
															meta: { mime: 'image/png', sheet: META_SHEET_FLAG, ...sheetDimsMeta(rows, cols), rebuilt: '1' },
														},
														index: 0,
													}, true);
													// eslint-disable-next-line no-console
													console.log(`[EmojiCellEditor] sheet rebuilt: ${sheetDataUrl.length}B（新副本追加至 image 口，下游转动态将取到编辑后图集）`);
												} catch (err) {
													// 重建失败不影响单格替换结果；下游仍可用旧图集或重新生成
													// eslint-disable-next-line no-console
													console.warn(`[EmojiCellEditor] sheet rebuild failed（不影响单格替换）: ${err instanceof Error ? err.message : String(err)}`);
												}
											})();
										}
									}
									setEditingEmojiCell(null);
								}}
								onClose={() => setEditingEmojiCell(null)}
							/>
								</>
								);
							})()}
						</div>
						</div>,
						document.body,
					)}
				</div>
			)}


			{/* AnimatedEmoji 转动态表情包（provider 图生视频 → 前端抠像 → 透明 GIF）。
			    纯 provider 后端（无需 ComfyUI runner）；editorKind='animated-emoji'
			    （stageCardRegistry 注册）→ hasInlineEditor=true 抑制通用控件网格，
			    全部参数由编辑器自绘，写回 commitControls → runAnimatedEmoji values。
			    ★ 2026-09-03：支持 comfyui/provider 双渠道——comfyui 渠道走本地视频
			    工作流（workflowOptionsFor('video')，I2V），产出视频后复用同一
			    抠像切分管线。 */}
			{editorKind === 'animated-emoji' && (
				<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4 }}>
					<AnimatedEmojiEditor
						initial={{
							// ★ 生成渠道（2026-09-03）：comfyui / provider 双渠道
							// （ctl 返回字面量收窄类型 → String 化后再比较）
							backend: String(ctl('backend', 'provider')) === 'comfyui' ? 'comfyui' : 'provider',
							workflow: String(ctl('workflow', '') ?? ''),
							seed: Number(ctl('seed', 0)) || 0,
							videoProvider: String(ctl('videoProvider', '') ?? ''),
							videoModel: String(ctl('videoModel', '') ?? ''),
							// ★ 提示词 / 动作描述（2026-09-12 用户需求「视频生成 增加提示词
							//   字段」）：`prompt` 是 TEXT widget → **不进 meta.controls** ✗，
							//   `ctl('prompt')` 恒 fallback ''（同 chroma_color / cells 的坑：
							//   用户填的动作描述重开面板即丢，且编辑器 onCommit 会把空串写回
							//   覆盖 ✗✗）⇒ 走 `meta.prompt` 直传；draft 优先（清空后不回弹
							//   旧值），meta 作兜底。
							prompt: String(ctl('prompt', meta.prompt ?? '') ?? ''),
							duration_s: Number(ctl('duration_s', 3)) || 3,
							fps: Number(ctl('fps', 12)) || 12,
							max_kb: Number(ctl('max_kb', 100)) || 100,
							// ★ 绿幕色走 meta 直传（STRING widget 不进 controls，见
							//   NodeCardMeta.chromaColor 注释）——否则用户调过的幕布色
							//   重开面板即丢。
							chromaColor: String(meta.chromaColor ?? ctl('chroma_color', '#00FF00') ?? '#00FF00'),
							chromaSimilarity: Number(ctl('chroma_similarity', 0.4)) || 0.4,
							chromaSmoothness: Number(ctl('chroma_smoothness', 0.1)) || 0.1,
							// ★ 绿幕抠像开关（2026-09-03）：非透明背景图像可关闭
							// （ctl 字面量收窄 → 一律 String 化比较）
							chromaEnable: String(ctl('chroma_enable', true)) !== 'false',
							// ★ 抠像开关（2026-09-08，与绿幕合成解耦）
							matteEnable: String(ctl('matte_enable', true)) !== 'false',
							// ★ GIF 输出开关（2026-09-08）：关 = 直接输出生成的视频
							gifEnable: String(ctl('gif_enable', true)) !== 'false',
							// ★ 抠像算法（2026-09-08）：rgb / flood / ycbcr
							chromaAlgo: String(ctl('chroma_algo', 'rgb') ?? 'rgb'),
							}}
							// ComfyUI 渠道可选视频工作流（registry workflowOptionsFor('video')，
							// 存于 meta.controls 的 workflow COMBO options——同 emojiWorkflowOptions 模式）
							workflowOptions={(() => {
							const c = (meta.controls ?? []).find(x => x.name === 'workflow');
							const opts = (c?.options ?? []).map(o => (typeof o === 'string' ? o : String(o?.value ?? o?.label ?? ''))).filter(s => s.length > 0);
							return opts.length > 0 ? opts : undefined;
							})()}
							// ★ cellRefs 用 latestOutputs（按 cellIndex 去重后的稳定序列）——
							//   ownOutputs 含历史累积条目会让网格取到旧数据。
							//   ★ 换批检测：过期产物（meta.srcSig ≠ 当前输入指纹）不送入预览。
							//   ★ 透传 cellIndex（2026-09-12）：latestOutputs 是「按 cellIndex
							//     排序」的**压缩序列**，数组下标只在「9 格齐全」时才等于格号；
							//     任一格产物缺失（失败 / 被上面的换批检测剔除）下标即整体
							//     前移 → ③ 预览第 i 格显示别人的 GIF ✗。带上 cellIndex 后
							//     编辑器按格号取值，与 ② 的 cellVideoRefs / cellMatteRefs
							//     同口径（三处预览同格同源）。
							cellRefs={latestOutputs.filter(e => !isStaleArtifact(e)).map(e => ({
							ref: e.media.ref,
							kind: e.media.kind === 'video' ? 'video' : 'image',
							...(Number.isInteger(Number(e.media.meta?.cellIndex))
								? { cellIndex: Number(e.media.meta?.cellIndex) }
								: {}),
							// ★ 重生成标识（2026-09-12）：`meta.gifStamp`（阶段③ 写入的时间戳）
							//   或条目 index —— 卡片用它作 `<img>` 的 React key。**必需**：
							//   参数/输入未变时 GIF 字节可能完全相同 → src 不变 → 浏览器不
							//   重解码 → 用户看到「点了 ③ 但预览没更新」✗（换 key 强制重挂
							//   `<img>`，动画重播 + 视觉上确实刷新了）。
							rev: String(e.media.meta?.gifStamp ?? e.index ?? ''),
							// ★ 该 GIF 依据的抠像参数签名（阶段③ 写入）：与当前 matte 的
							//   `matteSig` 不等 → 「② 之后 GIF 已过期」→ ③ 预览回落到新抠像
							//   结果并提示「待重转 GIF」（2026-09-12 用户实测反馈）。
							...(typeof e.media.meta?.gifFromMatteSig === 'string'
								? { fromMatteSig: e.media.meta.gifFromMatteSig }
								: {}),
							// ★ 该 GIF 依据的绿幕原片指纹：与当前 `cellVideoRefs` 的原片指纹
							//   不等 → ① 重跑过 → GIF 过期（参数/输入都没变也照样过期）。
							...(typeof e.media.meta?.gifFromVideoSig === 'string'
								? { fromVideoSig: e.media.meta.gifFromVideoSig }
								: {}),
							}))}
							// ★ 格级「原始视频/抠图 GIF」切换（2026-09-08）：绿幕原片在
							//   port='video'（归档键 cellN），output 只有 GIF——按 cellIndex
							//   取最新一条（与执行器 rematte 同语义）。
							cellVideoRefs={(() => {
								const byIdx = new Map<number, string>();
								for (const e of ownSnapshots) {
									if (e.port !== 'video' || e.media.kind !== 'video' || !e.media.ref) { continue; }
									if (isStaleArtifact(e)) { continue; }   // 换批检测：过期原片不显示
									const idx = Number(e.media.meta?.cellIndex ?? -1);
									if (idx >= 0) { byIdx.set(idx, e.media.ref); }
								}
								return [...byIdx.entries()].map(([ci, ref]) => ({ cellIndex: ci, ref }));
							})()}
							// ★ 阶段① 抠像结果（2026-09-11 两阶段拆分）：快照 port='matte'
							//   （执行器 archiveMatteResult 写入的透明 PNG + 抠像参数凭据）
							//   → 阶段① 预览窗口的静态兜底（本地序列帧未算完时显示）。
							cellMatteRefs={(() => {
								const byIdx = new Map<number, { ref: string; sig: string; stamp: number }>();
								for (const e of ownSnapshots) {
									if (e.port !== 'matte' || !e.media.ref) { continue; }
									if (isStaleArtifact(e)) { continue; }   // 换批检测：过期抠像结果不显示
									const idx = Number(e.media.meta?.cellIndex ?? -1);
									// ★ 带上 matteSig / matteStamp（2026-09-12）：③ 预览据此判断
									//   GIF 是否已过期（签名不等 = ② 换了参数；时间戳更晚 = ② 又
									//   跑过一次）→ 回落显示新抠像结果 + 「待重转 GIF」。
									const sig = typeof e.media.meta?.matteSig === 'string' ? e.media.meta.matteSig : '';
									const stamp = Number(e.media.meta?.matteStamp ?? 0);
									if (idx >= 0) {
										byIdx.set(idx, { ref: e.media.ref, sig, stamp: Number.isFinite(stamp) ? stamp : 0 });
									}
								}
								return [...byIdx.entries()].map(([ci, v]) => ({ cellIndex: ci, ref: v.ref, sig: v.sig, stamp: v.stamp }));
							})()}
						// ★ 换批提示（见上方 staleCells）：非空 → 编辑器显示一行「输入已更换」
						staleCells={[...staleCells]}
						// ★ 网格行列：跟随上游图集 meta（表情包图片网格 rows×cols）
						sheetGrid={upstreamSheetMeta.rows ? { rows: upstreamSheetMeta.rows, cols: upstreamSheetMeta.cols, margin: upstreamSheetMeta.margin } : undefined}
						upstreamCount={upstreamImageRefs.length}
						// ★ 格级「原图」来源（2026-09-08 三态切换）：上游逐格静态贴纸
						//   （上游 StatEmoji 产物 / 多张独立格）——与 executor jobs 同序。
						cellSourceRefs={upstreamImageRefs}
						onCommit={commitControls}
						running={run.runState === 'running'}
						onCancelRequest={() => {
							if (nodeId) {
								window.dispatchEvent(new CustomEvent('wf-node-abort', { detail: { nodeId } }));
							}
						}}
						// ★ 整图 ref（meta.sheetFull='1'）→「调整裁剪」画布来源
						sheetRef={sheetFullEntry?.media.ref}
						onApplyRecrop={() => {
							if (nodeId) {
								commitControls({ run_scope: 'recrop' });
								window.dispatchEvent(new CustomEvent('wf-node-run', { detail: { nodeId } }));
							}
						}}
						onRunRequest={() => {
							if (nodeId) {
								window.dispatchEvent(new CustomEvent('wf-node-run', { detail: { nodeId } }));
							}
						}}
						// ★ 单格 ⟳「重新抠图+GIF」按钮已移除（2026-09-12 用户需求）：
						//   单格重做改为「选中该格 → 阶段① 重新抠图 → 阶段② 生成 GIF」。
						//   执行器的 run_scope='rematte' 协议保留（脚本/后续入口仍可用），
						//   但 UI 不再有入口。
					/>
				</div>
			)}

			{/* ColorGrade 内嵌调色编辑器（对齐 ComfyTV ColorGradeStageCard：效果下拉 + 标量/整型/
			    布尔参数 + 曲线编辑器 + 重置）。写回通过 wf-node-control（commitColorGrade → grade_state JSON）。 */}
			{isColorGrade && (
				<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4 }}>
					<ColorGradeEditor
						initial={{
							effect: String(meta.controls?.find(c => c.name === 'grade_state')?.value ?? ''),
							all: safeParseGradeAll(meta.controls?.find(c => c.name === 'grade_state')?.value),
						}}
						onCommit={commitColorGrade}
					/>
				</div>
			)}

			{/* Rotate 内嵌变换编辑器（复刻 ComfyTV RotateStageCard：图像预览 + CSS rotate
			    实时预览 + 角度滑块 + 快捷预设按钮）。写回通过 wf-node-control（commitAngle）。 */}
			{isRotate && (
				<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4 }}>
					<TransformEditor
						mode="rotate"
						initial={{
							angle: Number(ctl('angle', 0)),
						}}
						imageRef={upstreamImageRef}
						onAngleChange={commitAngle}
						onResize={() => { if (nodeId) { markFormHeightDirty(nodeId); } }}
						status={transformStatus}
					/>
				</div>
			)}

			{/* Mirror 内嵌变换编辑器（复刻 ComfyTV MirrorStageCard：图像预览 + CSS scale
			    实时预览 + 水平/垂直翻转按钮）。写回通过 wf-node-control（commitMirrorFlip）。 */}
			{isMirror && (
				<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4 }}>
					<TransformEditor
						mode="mirror"
						initial={{
							horizontal: Boolean(ctl('horizontal', false)),
							vertical: Boolean(ctl('vertical', false)),
						}}
						imageRef={upstreamImageRef}
						onMirrorChange={commitMirrorFlip}
						onResize={() => { if (nodeId) { markFormHeightDirty(nodeId); } }}
						status={transformStatus}
					/>
				</div>
			)}

			{/* transform variant 三态提示（对齐 ComfyTV RotateStageCard 的
			    applying / applied / adjustToApply 居中小字）。
			    ★ Rotate/Mirror 已把这行**注入 TransformEditor 内部**（ComfyTV 的
			      版式是「预览 → 状态行 → 控件」，状态行夹在中间）；这里只为其余
			      transform 节点（Crop 等无 TransformEditor 的）兜底渲染，避免
			      Rotate/Mirror 出现上下两行重复状态。 */}
			{transformEnabled && !isRotate && !isMirror && (
				<div style={{
					fontSize: 9, textAlign: 'center', padding: '2px 0', letterSpacing: .3,
					fontFamily: 'Consolas, monospace',
					color: transformStatus.tone === 'success'
						? '#4ade80'
						: transformStatus.tone === 'error'
							? '#fca5a5'
							: 'var(--vscode-descriptionForeground, #858585)',
				}}>
					{transformStatus.text}
				</div>
			)}

			{/* 运行反馈（进度条 / 错误横幅）。
			    ★ 对 showRun=false 的卡片（picker / loader / 极简桥接节点）**也必须渲染** ——
			      runPickerNode 会返回「选择器没有上游候选」「媒体库资产不可用」等错误，
			      若只在 showRun 块内渲染，这些错误永远不可见（用户只看到 picker 毫无反应）。
			      showRun 为真时由块内的 {runFeedback} 渲染（保持原有视觉顺序：在运行按钮
			      下方、OUTPUT 上方）；为假时在此补渲染。
			    回归守护：visual/visual.spec.mjs 的 error-not-shown 规则。 */}
			{!showRun && runFeedback}

			{/* ComfyTV stage: run button + progress + error + output */}
			{showRun && (
				<>
					{/* 运行前校验提示（对齐 ComfyTV：点运行前就告知缺哪个输入，
					    而不是点了之后等后端返回一句无上下文的失败）。 */}
					{preRunWarning && (
						<div style={{
							marginTop: 4, padding: '3px 6px', borderRadius: 4,
							background: 'rgba(234,179,8,.12)', border: '1px solid rgba(234,179,8,.3)',
							fontSize: 9, color: '#eab308', fontFamily: 'Consolas, monospace',
						}}>
							{preRunWarning}
						</div>
					)}
					{showRunButton && (
					<button
						type="button"
						disabled={engineDisconnected}
						title={
							engineDisconnected ? '未连接 ComfyUI 引擎'
							: run.runState === 'running' ? '中止当前执行'
							: '运行此节点（双击也可打开编辑器）'
						}
						onClick={() => {
							if (!nodeId) { return; }
							// ★ 运行中 → 取消（dispatch abort 事件）；否则 → 触发运行
							if (run.runState === 'running') {
								// eslint-disable-next-line no-console
								console.warn('[nodeCard] abort clicked nodeId=' + nodeId);
								window.dispatchEvent(new CustomEvent('wf-node-abort', { detail: { nodeId } }));
								return;
							}
							// eslint-disable-next-line no-console
							console.warn('[nodeCard] run clicked ' + JSON.stringify({ nodeId, engineDisconnected, runnerReady: runnerStatus.ready, runState: run.runState }));
							// EmojiStage：卡片 RUN 按钮语义固定为「生成全部」，必须重置
							// run_scope，否则会沿用上次「生成此表情」留下的 'cell' 只跑一格。
							if (isEmoji) { commitControls({ run_scope: 'all' }); }
							// Bridge back to the canvas: opens the editor popup
							// (which owns the actual runner call). No longer
							// short-circuited by engineDisconnected — clicking
							// always yields feedback (run or explicit error).
							window.dispatchEvent(new CustomEvent('wf-node-run', { detail: { nodeId } }));
						}}
						style={{
							display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
							marginTop: 4, padding: '6px 10px', borderRadius: 6,
							border: 'none',
							cursor: engineDisconnected ? 'default' : 'pointer',
							pointerEvents: 'auto',
							background: engineDisconnected
								? 'rgba(255,255,255,.08)'
								: run.runState === 'error'
									? '#dc2626'
									: run.runState === 'running' ? '#b91c1c'
									: 'linear-gradient(180deg, #3b82f6, #2563eb)',
							color: engineDisconnected ? 'var(--vscode-descriptionForeground, #858585)' : '#fff',
							fontWeight: 600, fontSize: 11,
							width: '100%', boxSizing: 'border-box',
							fontFamily: 'inherit',
						}}
					>
						<span>{engineDisconnected ? '⏻' : run.runState === 'running' ? '⏹' : run.runState === 'success' ? '↻' : runLabel.icon}</span>
						<span>
							{engineDisconnected ? '未连接引擎'
								: run.runState === 'running' ? '取消'
								: run.runState === 'success' ? '重新运行'
								: run.runState === 'error' ? '重试'
								: runLabel.label}
						</span>
					</button>
					)}
					{showRunButton && engineDisconnected && (
						<div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', marginTop: 3, fontFamily: 'Consolas, monospace' }}>
							请先在 Runner 面板连接 ComfyUI/ComfyTV
						</div>
					)}
					{runFeedback}
					{/* ── 参数预设（对齐 ComfyTV useStagePresets）──────────────
					    把当前控件组合命名保存，一键套回同类节点。与 ACTIONS 里的
					    「动作预设」（换风格再生成）是两回事。
					    选中态由值匹配派生 → 手改任一参数立刻变「自定义」。
					    ★ transform variant 不显示：ComfyTV 的 `StagePresetBar`
					      是 `v-if="hasConfig"`，而 Rotate/Mirror/Crop 这类
					      instant stage 没有预设配置（参数只有 1~4 个，编辑器里
					      本来就一目了然），参考 UI 上确实没有这一行。此前无条件
					      渲染，导致 Rotate/Mirror 比参考实现多出「预设 / + 存为
					      预设」一行噪声。 */}
					{hasInlineEditor && stageVariant !== 'transform' && presetFields.size > 0 && (
						<div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 5, flexWrap: 'wrap' }}>
							<span style={{
								fontSize: 8, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase',
								color: 'var(--vscode-descriptionForeground, #858585)',
							}}>
								预设
							</span>
							{presets.map(p => {
								const active = activePreset?.id === p.id;
								return (
									<span key={p.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
										<button
											type="button"
											title={`套用预设：${p.name}`}
											onClick={() => applyPreset(p)}
											style={{
												fontSize: 9, padding: '2px 6px', borderRadius: 3,
												border: active ? '1px solid rgba(59,130,246,.7)' : '1px solid rgba(255,255,255,.12)',
												background: active ? 'rgba(59,130,246,.18)' : 'rgba(255,255,255,.04)',
												color: active ? '#93c5fd' : 'var(--vscode-foreground, #ccc)',
												cursor: 'pointer', pointerEvents: 'auto', fontFamily: 'inherit',
											}}
										>
											{p.name}
										</button>
										<button
											type="button"
											title="删除该预设"
											onClick={() => { if (meta.nodeType) { deleteStagePreset(meta.nodeType, p.id); } }}
											style={{
												fontSize: 9, padding: '2px 3px', marginLeft: -1, borderRadius: 3,
												border: 'none', background: 'none',
												color: 'var(--vscode-descriptionForeground, #858585)',
												cursor: 'pointer', pointerEvents: 'auto', fontFamily: 'inherit',
											}}
										>
											×
										</button>
									</span>
								);
							})}
							{/* 未匹配任何预设时明确显示「自定义」，避免用户误以为当前是某个预设 */}
							{presets.length > 0 && !activePreset && (
								<span style={{
									fontSize: 9, fontFamily: 'Consolas, monospace',
									color: 'var(--vscode-descriptionForeground, #858585)', opacity: .7,
								}}>
									自定义
								</span>
							)}
							<button
								type="button"
								title="把当前参数保存为预设"
								onClick={saveCurrentAsPreset}
								style={{
									marginLeft: 'auto', fontSize: 9, padding: '2px 6px', borderRadius: 3,
									border: '1px dashed rgba(255,255,255,.18)', background: 'none',
									color: 'var(--vscode-descriptionForeground, #858585)',
									cursor: 'pointer', pointerEvents: 'auto', fontFamily: 'inherit',
								}}
							>
								+ 存为预设
							</button>
						</div>
					)}
					{/* ── CONTEXT（对齐 ComfyTV StageCard 的 `> CONTEXT 1 image`）──
					    列出已连线的输入 slot，标题右侧是语义聚合摘要
					    （contextSummary 把 images.image0/image1 归并成 "2 images"）。
					    折叠态持久化，默认收起。 */}
					{contextSlots.length > 0 && (
						<>
							<button
								type="button"
								onClick={() => setContextCollapsed(!contextCollapsed)}
								style={{
									marginTop: 5, width: '100%', display: 'flex', alignItems: 'center', gap: 4,
									background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
									pointerEvents: 'auto',
								}}
							>
								<span style={{
									fontSize: 8, fontWeight: 700, letterSpacing: 1.2,
									color: 'var(--vscode-descriptionForeground, #858585)',
								}}>
									{contextCollapsed ? '▸' : '▾'}
								</span>
								<span style={{
									fontSize: 8, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase',
									color: 'var(--vscode-descriptionForeground, #858585)',
								}}>
									Context
								</span>
								<span style={{
									fontSize: 9, fontFamily: 'Consolas, monospace',
									color: 'var(--vscode-descriptionForeground, #858585)', opacity: .8,
								}}>
									{contextSummaryText}
								</span>
							</button>
							{!contextCollapsed && (
								<div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 12 }}>
									{contextSlots.map(s => (
										<div key={s} style={{
											fontSize: 9, fontFamily: 'Consolas, monospace',
											color: 'var(--vscode-descriptionForeground, #858585)',
										}}>
											{s}
										</div>
									))}
								</div>
							)}
						</>
					)}
					{showOutput && (
					<div data-zone="keep">
						{/* ComfyTV-style "OUTPUT (TYPE)" header: All-caps TYPE chip
						    following the Output label, matching the upstream UI. */}
							<div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
								<span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground, #858585)' }}>Output</span>
								{primaryOutputType && (
									<span style={{
										fontSize: 8, fontWeight: 700, letterSpacing: 1, padding: '1px 5px', borderRadius: 3,
										background: 'rgba(168, 85, 247, .18)', color: '#a855f7',
									}}>
										({primaryOutputType})
									</span>
								)}
								<span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'Consolas, monospace' }}>
									{duration}
								</span>
							</div>
							{snapshotStore && snapKey && <SnapshotPreview store={snapshotStore} nodeId={snapKey} entries={latestOutputs.filter(e => !isStaleArtifact(e))} batch={isBatchOutput} />}
							</div>
							)}
							{/* GridSplit 空态：对齐 ComfyTV GridSplitStageCard——OUTPUT (TYPE) 头 +
							BATCH 药丸 + "no output yet" 斜体占位（参考截图样式，2026-09-01）。 */}
							{isGridSplit && !showOutput && (
							<div data-zone="keep">
							<div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
								<span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground, #858585)' }}>Output</span>
								{primaryOutputType && (
									<span style={{
										fontSize: 8, fontWeight: 700, letterSpacing: 1, padding: '1px 5px', borderRadius: 3,
										background: 'rgba(168, 85, 247, .18)', color: '#a855f7',
									}}>
										({primaryOutputType})
									</span>
								)}
							</div>
							<div style={{ display: 'flex', marginTop: 5 }}>
								<span style={{
									marginLeft: 'auto', fontSize: 8, fontWeight: 700, letterSpacing: .6,
									padding: '1px 6px', borderRadius: 3,
									background: 'rgba(255,140,200,.25)', color: '#ffb0d8',
								}}>BATCH</span>
							</div>
							<div style={{
								marginTop: 10, marginBottom: 6, textAlign: 'center',
								fontSize: 10.5, fontStyle: 'italic', color: 'var(--vscode-descriptionForeground, #858585)',
							}}>
								no output yet
							</div>
							</div>
							)}
					{/* 对齐 ComfyTV StageCard：actions 仅在节点**有输出**后显示
						（ComfyTV 的 gate 是 `state.output`）；标题栏可折叠
						（actionsCollapsed）；preset 子面板用虚线边框 + 背景。
						★ gate 用 hasOutputContent 而非 showOutput —— 后者含
						  hideOutput 这个纯**版式**开关，混用会让 picker /
						  TextLoader 这类隐藏 OUTPUT 区的节点连 ACTIONS 一起消失。 */}
					{/* hideActions：loader 节点的产物已在 inline editor（ImageLoaderPreview）
					    完整展示，ACTIONS 完全冗余——与 hideOutput 同语义（版式开关），
					    仅 loader 家族开启（picker/TextLoader 的 meta.actions 本就空，无影响）。 */}
					{meta.actions && meta.actions.length > 0 && hasOutputContent
						&& !stageCardFlags(meta.nodeType, meta.isPicker).hideActions && (
						<>
							<button
								type="button"
								onClick={() => setActionsCollapsed(!actionsCollapsed)}
								style={{
									marginTop: 5, width: '100%', display: 'flex', alignItems: 'center', gap: 4,
									background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
									pointerEvents: 'auto',
								}}
							>
								<span style={{
									fontSize: 8, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase',
									color: 'var(--vscode-descriptionForeground, #858585)',
								}}>
									{actionsCollapsed ? '▸' : '▾'}
								</span>
								<span style={{
									fontSize: 8, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase',
									color: 'var(--vscode-descriptionForeground, #858585)',
								}}>
									Actions
								</span>
								<span style={{
									marginLeft: 'auto', fontSize: 8, fontFamily: 'Consolas, monospace',
									color: 'var(--vscode-descriptionForeground, #858585)',
								}}>
									{meta.actions.length}
								</span>
							</button>
							{!actionsCollapsed && (
								<>
									<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
										{meta.actions.map(a => {
											const hasPresets = !!(a.presets && a.presets.length);
											const expanded = openActionId === a.id;
											return (
												<button
													key={a.id}
													type="button"
													title={a.label}
													onClick={() => {
														// ComfyTV onActionClick: presets → toggle expand;
														// leaf action → spawn follow-up node immediately.
														if (hasPresets) {
															setOpenActionId(expanded ? null : a.id);
														} else {
															dispatchAction(a.id);
														}
													}}
													style={{
														pointerEvents: 'auto', cursor: 'pointer',
														padding: '2px 7px', borderRadius: 4,
														border: `1px solid ${expanded ? 'var(--vscode-focusBorder, #3b82f6)' : 'var(--vscode-panel-border, rgba(255,255,255,.14))'}`,
														background: expanded ? 'rgba(59,130,246,.18)' : 'transparent',
														color: 'var(--vscode-foreground, #e8e8e8)',
														fontSize: 9, fontFamily: 'inherit', fontWeight: 600,
														display: 'inline-flex', alignItems: 'center', gap: 4,
													}}
												>
													<span aria-hidden style={{ fontSize: 10, opacity: .8 }}>{a.icon}</span>
													<span>{a.label}</span>
													{hasPresets && <span style={{ fontSize: 8, opacity: .6 }}>{expanded ? '▾' : '▸'}</span>}
												</button>
											);
										})}
									</div>
									{/* Expanded preset list (ComfyTV onPresetClick → `${actionId}:${presetId}`).
										对齐 ComfyTV：虚线边框 + 半透明背景 + 圆角 + 内边距，网格列宽 110px。 */}
									{meta.actions.filter(a => a.id === openActionId && a.presets?.length).map(a => (
										<div key={`presets-${a.id}`} style={{
											display: 'grid',
											gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
											gap: 4,
											marginTop: 3, padding: 4, borderRadius: 4,
											border: '1px dashed rgba(59,130,246,.3)',
											background: 'rgba(59,130,246,.05)',
										}}>
											{(a.presets as ImagePreset[]).map(p => (
												<button
													key={p.id}
													type="button"
													title={(p as { label?: string }).label ?? p.id}
													onClick={() => { dispatchAction(`${a.id}:${p.id}`); setOpenActionId(null); }}
													style={{
														pointerEvents: 'auto', cursor: 'pointer',
														padding: '3px 8px', borderRadius: 4,
														border: '1px solid var(--vscode-panel-border, rgba(255,255,255,.14))',
														background: 'rgba(255,255,255,.04)',
														color: 'var(--vscode-foreground, #e8e8e8)',
														fontSize: 9, fontFamily: 'inherit',
														display: 'inline-flex', alignItems: 'center', gap: 5,
														justifyContent: 'flex-start',
														transition: 'background .12s ease',
													}}
													onPointerEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(59,130,246,.15)'; }}
													onPointerLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,.04)'; }}
												>
													<span aria-hidden style={{ fontSize: 10, opacity: .75 }}>{p.icon}</span>
													<span>{(p as { label?: string }).label ?? p.id}</span>
												</button>
											))}
										</div>
									))}
								</>
							)}
						</>
					)}
				</>
			)}
			{/* ComfyTV footer mark — matches the "ComfyTV" caption in the
			     reference UI; gives the card a clear visual owner.
			     不能只判 kind==='schema' —— Crop/Rotate/Mirror/Relight/Material 等
			     是手写 native 注册，它们同样是 ComfyTV stage，参考截图里也带这个标记。 */}
			{(meta.kind === 'schema' || (meta.nodeType ?? '').startsWith('ComfyTV.')) && (
				<div style={{ marginTop: 'auto', paddingTop: 4, fontSize: 7.5, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', opacity: .35, color: 'var(--vscode-descriptionForeground, #858585)', textAlign: 'left' }}>
					ComfyTV
				</div>
			)}
			</div>
		</div>
	);
}

/** Mount a card into an overlay container; returns an unmount function. */
export function createNodeCard(
	container: HTMLElement,
	meta: NodeCardMeta,
	options?: { snapshotStore?: MediaSnapshotStore; cardStateStore?: CardStateStore; nodeId?: string; stageUid?: string; upstreamNodeIds?: string[] },
): () => void {
	let root: Root | null = null;
	container.innerHTML = '';
	// createRoot on a fresh element avoids "already been rendered" warnings on re-mount.
	const host = document.createElement('div');
	// Schema cards (addDOMWidget) 或全编辑器原生卡片（Rotate/Mirror/Material 等）：
	// host 必须是内容高，syncOverlay 才能用 scrollHeight 测到真实的高度（不卡在
	// widgetBridge 容器固定高度内）。原生非全编辑器卡片保持 height:100% 走容器填充。
	// 之前仅 `meta.kind === 'schema'` 走 content-height，原生 fullEditor 节点
	//（Crop/Rotate/Mirror/Material/…）因 host 撑满容器 → scrollHeight 永远 ≤
	// widgetRect.height（fallbackY 100px） → 高度反馈循环被锁死，编辑器控件
	//（滑块 / 翻转 / Material PBR / Generate 按钮）全部被截断。
	//
	// ★★★ 编排富卡片（orchRich）也必须 content-height：截图里 Start 的 `args` 输入框
	//   被压在卡片底部（卡片固定 150px，args 框在内部错位）—— 同样原因，scrollHeight
	//   被容器高度锁死，反馈循环只能收敛到估算值。三类并列即可彻底覆盖。
	const hostIsContentHeight = meta.kind === 'schema'
		|| (!!meta.nodeType && hasStageEditor(meta.nodeType))
		|| ORCH_RICH_NODE_TYPES.has(meta.nodeType ?? '');
	host.style.cssText = hostIsContentHeight ? 'width:100%;' : 'width:100%;height:100%;';
	container.appendChild(host);
	// ★ 诊断：暂时挂在创建瞬间打印 emoji/panorama 等常见消失节点的 meta 概要。
	//   用户报告"表情包节点 UI 中的内容消失"——已知 syncOverlay 有 DOM-card self-heal
	//   （LiteGraphCanvas.tsx:1371），但重挂载仍空 ⇒ 怀疑渲染抛错被 React 静默吞掉。
	//   配合上方 diagnoseCardMeta 输出与 LiteGraphCanvas 的 [cardSelfHeal] 日志，
	//   下次复现时即可定位。
	diagnoseCardMeta(options?.nodeId ?? '', meta, (meta as { controls?: unknown[] }).controls instanceof Array ? ((meta as unknown as { controls: unknown[] }).controls.length) : -1);
	try {
		root = createRoot(host);
		root.render(
			<NodeCard
				meta={meta}
				snapshotStore={options?.snapshotStore}
				cardStateStore={options?.cardStateStore}
				nodeId={options?.nodeId}
				stageUid={options?.stageUid}
				upstreamNodeIds={options?.upstreamNodeIds}
			/>,
		);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn('[nodeCard] mount failed ' + JSON.stringify({ error: String(err), nodeId: options?.nodeId, metaKind: meta.kind, metaTitle: meta.title, nodeType: meta.nodeType }));
		container.textContent = meta.title;
	}
	const nodeIdForLog = options?.nodeId ?? '';
	return () => {
		// eslint-disable-next-line no-console
		console.warn('[nodeCard] unmount called ' + JSON.stringify({ nodeId: nodeIdForLog, hasRoot: !!root }));
		if (root) {
			root.unmount();
			root = null;
		}
		host.remove();
	};
}

/** Re-export run-state helpers so tests can build/assert states. */
export type { NodeRunState };
export { runStateIcon, runStateLabel } from './runState';

/**
 * 跨 remount 持久化 action 面板展开状态。
 *
 * 问题：点击 action 按钮 → spawnFollowUp → state.addNode/setEdges →
 * syncStoreToGraph → graph.configure() → DOM widget 重建 →
 * syncOverlay self-heal 检测到 container 空了 → unmount+remount NodeCard →
 * React local state（openActionId）丢失 → action UI 消失。
 *
 * 解法：把 openActionId 存在模块级 Map 里，remount 后从 Map 恢复。
 */
const _openActionMap = new Map<string, string>();
export function getOpenActionId(nodeId: string): string | undefined {
	return _openActionMap.get(nodeId);
}
export function setOpenActionIdPersist(nodeId: string, actionId: string | undefined): void {
	if (actionId) {
		_openActionMap.set(nodeId, actionId);
	} else {
		_openActionMap.delete(nodeId);
	}
}

/*
 * 折叠区块（CONTEXT / ACTIONS / OUTPUT）的展开状态持久化。
 *
 * 对齐 ComfyTV `composables/stages/useContextCollapsed.ts` —— 它用 localStorage
 * 按 nodeId 记录 4 组折叠态（`comfytv:stage:context-expanded` 等）。
 *
 * 为什么必须持久化：卡片随 `syncOverlay` 频繁挂载/卸载（滚动、缩放、
 * graph.configure 后的 self-heal remount 都会重建 React root），纯
 * `useState` 会在每次 remount 时重置 —— 用户展开 CONTEXT 后一滚动就收起。
 *
 * 用 localStorage 而非模块级 Map（openActionId 的做法）：折叠偏好是**跨会话**
 * 的用户习惯，重启后应保留；openActionId 是临时 UI 态，进程内保活即可。
 */
const COLLAPSE_NS = 'saros:stage:collapsed';

function collapseKey(group: string, nodeId: string): string {
	return `${COLLAPSE_NS}:${group}:${nodeId}`;
}

/** 读取折叠态。`defaultCollapsed` 在无记录时生效。纯读，异常安全。 */
export function getCollapsed(group: string, nodeId: string, defaultCollapsed: boolean): boolean {
	if (!nodeId) { return defaultCollapsed; }
	try {
		const raw = globalThis.localStorage?.getItem(collapseKey(group, nodeId));
		if (raw === '1') { return true; }
		if (raw === '0') { return false; }
	} catch {
		// localStorage 在部分嵌入环境不可用（隐私模式 / webview 限制）——静默回退。
	}
	return defaultCollapsed;
}

/** 写入折叠态。异常安全（写失败只是丢失偏好，不该影响渲染）。 */
export function setCollapsedPersist(group: string, nodeId: string, collapsed: boolean): void {
	if (!nodeId) { return; }
	try {
		globalThis.localStorage?.setItem(collapseKey(group, nodeId), collapsed ? '1' : '0');
	} catch {
		// 同上。
	}
}

/**
 * 折叠态 hook —— `useState` + localStorage 双写。
 * 初值惰性从 localStorage 读，remount 后自动恢复。
 */
export function useCollapsed(
	group: string,
	nodeId: string | undefined,
	defaultCollapsed: boolean,
): [boolean, (v: boolean) => void] {
	const id = nodeId ?? '';
	const [collapsed, setLocal] = React.useState(() => getCollapsed(group, id, defaultCollapsed));
	const set = React.useCallback((v: boolean) => {
		setLocal(v);
		setCollapsedPersist(group, id, v);
	}, [group, id]);
	return [collapsed, set];
}

/**
 * LoadImage 内嵌预览专属：把 mediaAssetId 解析为可加载 URL（已统一在 workflowRun.resolveMediaAssetUrl 导出，
 * 这里作为薄包装仅在卡片渲染阶段 lazy 解析；执行阶段 runLoaderNode 自己解析）。
 */
const resolveMediaAssetUrlForCard = resolveMediaAssetUrl;
