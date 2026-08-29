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
import { ORCH_RICH_NODE_TYPES } from './registry.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore';
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
import { buildSarosEditorFields } from './nodeEditorForm';
import { ComboPopover } from './ComboPopover';
import { resolveMediaAssetUrl, collectUpstreamTexts } from './workflowRun.js';
import { useProviderStore } from '../../../store/useProviderStore';
import { useAgentStore } from '../../../store/useAgentStore';
import { usePicklistStore } from '../picklistStore';
import { ACTIONS_BY_KIND, actionKeyFor, type StageAction, type ImagePreset } from './actionSpawn';
import { MaskPainter } from '../MaskPainter';
import { CropEditor } from '../CropEditor';
import { OutpaintEditor } from '../OutpaintEditor';
import { GridSplitEditor } from '../GridSplitEditor';
import { ColorGradeEditor } from '../ColorGradeEditor';
import { TransformEditor } from '../TransformEditor';
import { StatEmojiStageEditor } from '../StatEmojiStageEditor';
import { DynEmojiStageEditor } from '../DynEmojiStageEditor';
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
		console.warn('[DC-DEBUG] render error:', err && (err.stack || String(err)));
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
	// eslint-disable-next-line no-console
	console.warn('[DC-DEBUG] LazyDirectorConsole mounted');
	const [Comp, setComp] = React.useState<React.ComponentType<typeof props> | null>(null);
	React.useEffect(() => {
		import('../DirectorConsoleEditor')
			.then(m => {
				try {
					const C = m.DirectorConsoleEditor;
					// eslint-disable-next-line no-console
					console.warn('[DC-DEBUG] component ref OK');
					setComp(() => C);
				} catch (e) {
					// eslint-disable-next-line no-console
					console.warn('[DC-DEBUG] access FAIL', e && (e.stack || String(e)));
				}
			})
			.catch(e => { console.warn('[DC-DEBUG] import FAIL', String(e)); });
	}, []);
	if (!Comp) return <div style={{ minHeight: 560, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>加载导演台…</div>;
	return <DCEErrorBoundary><Comp {...props} /></DCEErrorBoundary>;
}
import { getActiveRunnerRegistry, getActiveRunnerPreference } from './runnerContext';
import { useTransformPipeline, transformPhaseLabel } from './useTransformPipeline';
import { isInstantNode } from './instantNodes';
import { stageEditorKind, stageHiddenFields, stageMinHeight, stageCardFlags, contextSummary, hasStageEditor } from './stageCardRegistry';
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
	inputs: PortSpec[];
	outputs: PortSpec[];
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
	providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; supportsImageGen?: boolean }> }>,
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
		const summary = buildSarosEditorFields(spec?.type ?? '').map(f => {
			const v = properties[f.key];
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
	const interesting = ['ComfyTV.EmojiStaticStage', 'ComfyTV.EmojiAnimatedStage', 'ComfyTV.PanoramaStage', 'ComfyTV.RotateStage', 'ComfyTV.MaterialStage', 'ComfyTV.RelightStage'];
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

/** Thin ComfyTV-style progress bar (h-1.5, gradient fill + mono caption). */
function RunProgress({ progress }: { progress: number }): React.JSX.Element {
	// NaN 必须显式拦：`Math.min(100, NaN)` 仍是 NaN，会让 width 变成 "NaN%"
	// （CSS 视为非法 → 进度条整条不渲染）。上游 value/max 的除零已在
	// comfyRunner / taskStatus 处防住，这里是纵深防御（对齐 ComfyTV
	// progressPercentOf 的 `if (!progress || !progress.max) return 0`）。
	const safe = Number.isFinite(progress) ? progress : 0;
	const clamped = Math.max(0, Math.min(100, safe));
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
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
	);
}

/** ComfyTV-style error banner. */
function ErrorBanner({ message, cancel }: { message: string; cancel: boolean }): React.JSX.Element | null {
	if (!message) { return null; }
	const color = cancel ? '#f59e0b' : '#ef4444';
	return (
		<div
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

/** Derive a friendly download filename from a snapshot ref (URL or key). */
function snapshotFileName(entry: MediaSnapshotEntry): string {
	const m = /[^/?#]+\.[A-Za-z0-9]{2,5}(?:[?#]|$)/.exec(entry.media.ref);
	if (m) { return m[0].replace(/[?#].*$/, ''); }
	const safe = entry.key.replace(/[^A-Za-z0-9_.-]/g, '_');
	const ext = entry.media.kind === 'image' ? '.png' : entry.media.kind === 'video' ? '.mp4' : '.bin';
	return `${safe}${ext}`;
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
	a.download = snapshotFileName(entry);
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
	const images = entries.filter(e => e.media.kind === 'image');
	const others = entries.filter(e => e.media.kind !== 'image');
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
	if (images.length > 0) {
		return (
			<div style={{ marginTop: 4 }}>
				{/* BATCH 徽标：对齐 ComfyTV 的粉色 `BATCH` 药丸（右对齐于网格上方）。 */}
				{images.length > 1 && (
					<div style={{ display: 'flex', marginBottom: 3 }}>
						<span style={{
							marginLeft: 'auto', fontSize: 8, fontWeight: 700, letterSpacing: .6,
							padding: '1px 5px', borderRadius: 3,
							background: 'rgba(255,140,200,.25)', color: '#ffb0d8',
						}}>BATCH {images.length}</span>
					</div>
				)}
				{/* ctv-batch-grid：自适应列宽的方格网（每格 object-cover + #N 角标）。 */}
				<div style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
					gap: 4,
				}}>
				{images.map((e, i) => (
					<div key={e.key} style={{
						position: 'relative', aspectRatio: '1 / 1', borderRadius: 4, overflow: 'hidden',
						border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.03)',
						// thumbnails are interactive (download) even though the
						// overlay container is pointer-events:none
						pointerEvents: 'auto',
					}}>
						<img
							key={e.key}
							src={bustedSrc(e.media.ref, e.index, storeVersion)}
							alt="preview"
							onLoad={() => { markFormHeightDirty(nodeId); }}
							style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
						/>
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
								position: 'absolute', right: 2, bottom: 2, width: 16, height: 16,
								display: 'flex', alignItems: 'center', justifyContent: 'center',
								fontSize: 9, lineHeight: 1, cursor: 'pointer',
								background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none', borderRadius: 3,
								opacity: 0, transition: 'opacity .12s',
							}}
							onMouseEnter={ev => { ev.currentTarget.style.opacity = '1'; }}
							onMouseLeave={ev => { ev.currentTarget.style.opacity = '0'; }}
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
 * 缩略图 + 可点选 + 单张下载 + 单张删除。选中判定支持两种视图：
 *   - scope='upstream'：selectedIndex（1-based，相对上游 batch）
 *   - scope='all'      ：directRef（字符串 ref，跨节点直接输出）
 * 选中写回由 onPick 负责（上游→selected_index；全部→directRef）。
 */
function PickerPoolGrid({ entries, selectedIndex, directRef, poolScope, onPick, onRemove, store }: {
	entries: MediaSnapshotEntry[];
	selectedIndex: number;
	directRef: string;
	poolScope: 'upstream' | 'all';
	onPick: (zeroBasedIndex: number) => void;
	onRemove: (key: string) => void;
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
				const isSelected = poolScope === 'all'
					? (directRef !== '' && e.media.ref === directRef)
					: ((i + 1) === selectedIndex);
				return (
					<div
						key={e.key}
						onClick={() => onPick(i)}
						title={isSelected ? `已选第 ${i + 1} 张` : `选第 ${i + 1} 张`}
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
								onClick={(ev) => { ev.stopPropagation(); onRemove(e.key); }}
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

export function NodeCard({ meta, snapshotStore, cardStateStore, nodeId, stageUid, upstreamNodeIds }: NodeCardProps): React.JSX.Element {
	/**
	 * 媒体快照的归档键。优先用持久 uid，未提供时回退 nodeId（向后兼容：
	 * 老工作流 / 单测 / 尚未迁移的调用方）。见 NodeCardProps.stageUid 注释。
	 */
	const snapKey = stageUid ?? nodeId;
	const kindColor = KIND_COLOR[meta.kind] ?? '#888';
	const run = useNodeCardState(cardStateStore, nodeId);
	const runLabel = RUN_LABEL[meta.stageKind ?? ''] ?? { label: '运行', icon: '▶' };
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
	const showRunButton = stageVariant === 'generator' && !meta.isPicker && !isOrchRich;
	// P2 engine-ready gate: schema/native nodes need a live ComfyUI runner.
	// When none is connected, show a "disconnected" placeholder + disable the
	// run button instead of an executable (but doomed) control.
	const runnerStatus = useRunnerStatus();
	const needsRunner = meta.kind === 'schema' || meta.kind === 'native';
	const engineDisconnected = needsRunner && !runnerStatus.ready;
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
	/** 该卡片控件应使用的 provider 列表（Agent=LLM，其余=文生图）。 */
	const controlProviders = isOrchRich ? chatProviders : imageGenProviders;
	// ★ 编排富卡片诊断打点：只在关键判定变化时输出（不刷屏）。
	//   ⚠ 必须放在 providers/agents/skills/tools **全部声明之后** —— 依赖数组在
	//   渲染时求值，提前引用 `const` 会触发 TDZ ReferenceError 把整张卡打崩。
	//   排障顺序：
	//     1. 有 `[syncOverlay] orch node skipped` → 该类型没登记进 ORCH_RICH_NODE_TYPES；
	//     2. 无 `[orchForm] attached`            → DOM 通路/form widget 没建立；
	//     3. 这里 controls=[] → registry spec 缺 widgets 声明；
	//     4. controls 有但下拉空 → 对应 store 数据源为空（未登录 provider / 无 agent）。
	React.useEffect(() => {
		if (!isOrchRich) { return; }
		// eslint-disable-next-line no-console
		console.warn('[orchCard] ' + JSON.stringify({
			nodeType: meta.nodeType,
			kind: meta.kind,
			controls: (meta.controls ?? []).map(c => `${c.name}:${c.type}`),
			hasPrompt: meta.hasPrompt,
			providersAll: providers.length,
			providersUsed: controlProviders.length,
			agents: agents.length,
			skills: skills.length,
			tools: tools.length,
		}));
	}, [isOrchRich, meta.nodeType, meta.kind, meta.controls, meta.hasPrompt,
		providers.length, controlProviders.length, agents.length, skills.length, tools.length]);
	// ★★ 下拉框为空的**真因修复**：这三个 store 都是**懒加载**（`loadXxx()`
	//   幂等、需显式调用）。原先只有 `NodeEditorPopup`（双击弹窗）会触发加载，
	//   画布卡片直接读 store → 永远是空数组 → 所有下拉显示 `—`。
	//   日志实证：`[orchCard] {...,"providersAll":0,"agents":0,"skills":0,"tools":0}`
	//   而 controls 与 orchForm 都正常 —— 通路没问题，纯粹是数据源没拉。
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
		|| ownSnapshots.length > 0
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
			const ref = e.media.ref;
			if (!ref || seen.has(ref)) { continue; }
			seen.add(ref);
			out.push({ ref, kind: e.media.kind, label: `${e.port || e.media.kind} · ${ref.slice(-12)}` });
			if (out.length >= 40) { break; }
		}
		return out;
	}, [allImageOutputs]);
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
	const isEmojiDynamic = editorKind === 'emoji-dynamic';
	const isEmoji = isEmojiStatic || isEmojiDynamic;
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
	const needUpstreamImage = isMaskEdit || isCrop || isGeneratorStage || isEraseStage || isOutpaint || isGridSplit || isColorGrade || isKenBurns || isRotate || isMirror || isMultiangle || isPanorama || isRelight || isMaterial;
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
	if (snapshotStore && upstreamNodeIds?.length) {
		for (const uid of upstreamNodeIds) {
			for (const e of snapshotStore.byNode(uid)) {
				if (e.media.kind === 'image' && !upstreamImageRefs.includes(e.media.ref)) { upstreamImageRefs.push(e.media.ref); }
			}
		}
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
		setControlDrafts(d => ({ ...d, [name]: value }));
		if (nodeId) {
			window.dispatchEvent(new CustomEvent('wf-node-control', { detail: { nodeId, name, value } }));
		}
	}, [nodeId]);
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
		return Math.max(1, Number(controlDrafts['batch_size'] ?? 1) || 1);
	}, [isEmojiStatic, controlDrafts]);
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
	const latestOutputs = React.useMemo(() => {
		// ★ 去重：executor 内部已 put 过一次，WorkflowEditorPanel 成功分支又对
		//   `r.entries` 再 put 一次（见该文件注释）——同一张图会产生**两条**
		//   index 不同、ref 相同的条目。不去重会让 BATCH 计数翻倍，且
		//   `slice(-batchSize)` 取到的其实是同一张图的副本。
		//   保留**最后一次**出现（index 最大 = 最新），顺序按首次出现位置。
		//   去重键用 mediaDedupeKey（locator 优先）：同一张图一次物化成 data:、
		//   另一次保留 /view URL 时 ref 不同但 locator 相同，仍应视为一张。
		const seen = new Map<string, MediaSnapshotEntry>();
		for (const e of ownSnapshots) { seen.set(mediaDedupeKey(e.media), e); }
		return Array.from(seen.values()).slice(-batchSize);
	}, [ownSnapshots, batchSize]);

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
	// 当前选中项（ComfyTV selected_index，1-based）。picker 后端用该 widget 从
	// batch 输入中选一张输出；前端高亮选中缩略图。仅 'upstream' 视图使用
	// selected_index 高亮；'all' 视图用 directRef 匹配。
	const selectedIndex = React.useMemo(() => {
		if (!meta.isPicker) { return 1; }
		const v = controlDrafts['selected_index'];
		const n = Number(v);
		return Number.isInteger(n) && n >= 1 ? n : 1;
	}, [meta.isPicker, controlDrafts]);
	// 当前 directRef（'all' 视图选中项，字符串 ref）。用于高亮跨节点选中的图。
	const directRef = React.useMemo(() => {
		const v = controlDrafts['directRef'];
		return typeof v === 'string' ? v : '';
	}, [controlDrafts]);
	// 点选第 N 张（0-based）。'upstream' 视图 → selected_index；'all' 视图 →
	// directRef（直接输出该 ref，跨节点无需上游 batch 索引）。
	const pickImage = React.useCallback((poolIndexZeroBased: number) => {
		if (poolScope === 'all') {
			const e = pickerPool[poolIndexZeroBased];
			if (e) { commitControl('directRef', e.media.ref); }
			return;
		}
		commitControl('selected_index', poolIndexZeroBased + 1);
	}, [poolScope, pickerPool, commitControl]);
	// 清空选择（对齐 ComfyTV Clear）：清 picker 自身输出 + 重置选中到第 1 张。
	// 走 commitControl 同步 local state，确保前端高亮即时重置。
	const clearPicker = React.useCallback(() => {
		if (!nodeId) { return; }
		snapshotStore?.clearNode(snapKey ?? nodeId);
		commitControl('selected_index', 1);
		commitControl('directRef', '');
	}, [nodeId, snapKey, snapshotStore, commitControl]);
	// 删除单张候选图（对齐 ComfyTV remove-pool-item）：从 store 移除该 entry。
	// pool 实时聚合上游 entry，删除后立即从网格消失；同时重置选中到第 1 张
	// 避免 selected_index 越界。
	const removePoolImage = React.useCallback((key: string) => {
		void snapshotStore?.remove(key);
		commitControl('selected_index', 1);
	}, [snapshotStore, commitControl]);

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
	/** 运行反馈片段（进度条 + 错误横幅）。抽成变量以便 showRun 真/假两条路径共用，
	 *  保证 picker/loader 等 no-Run 节点的错误同样可见（见下方两处引用）。 */
	const runFeedback = (
		<>
			{run.runState === 'running' && <RunProgress progress={run.progress} />}
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
				boxShadow: `inset 0 0 0 1.5px ${kindColor}55`,
				color: 'var(--vscode-foreground, #ccc)',
				fontFamily: 'inherit',
				// ComfyTV StageCard cardClass：text-xs（12px）—— 真源 visual/comfyTvTruth.ts
				fontSize: 12,
				display: 'flex',
				flexDirection: 'column',
				}}
				>
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
			    将使用的参考图，即上游连线传入的图片）。仅当有上游图片时显示。 */}
			{showRun && (isGeneratorStage || isKenBurns) && upstreamImageRefs.length > 0 && (
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
			{showRun && isDirectorConsole && (() => {
				const registry = getActiveRunnerRegistry();
				const snapStore = snapshotStore;
				return (
					<div
						style={{
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
						<LazyDirectorConsole
							initialState={(controlDrafts['board_state'] ?? '') as string}
							initialFountainText={storyboardFountainText || undefined}
							width={clampDim(Number(controlDrafts['width']), 1280)}
							height={clampDim(Number(controlDrafts['height']), 720)}
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
					</div>
				);
			})()}

			{/* Inline prompt editor (ComfyTV MainPromptInput equivalent).
			    ComfyTV 只在 generator variant 挂 main_prompt（useStageNode.ts:114），
			    transform/loader 没有 prompt。Multiangle/Panorama/Relight/Material 的
			    prompt 由各自编辑器自动生成，不显示手动输入框。 */}
			{showRun && stageVariant === 'generator' && meta.hasPrompt && !isMultiangle && !isPanorama && !isRelight && !isMaterial && (
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
								: (poolScope === 'all' ? (directRef ? '· 已选' : '· 未选') : `· ${selectedIndex} selected`)}
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
							{snapshotStore && <PickerPoolGrid entries={pickerPool} selectedIndex={selectedIndex} directRef={directRef} poolScope={poolScope} onPick={pickImage} onRemove={removePoolImage} store={snapshotStore} />}
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
					if (ownSnapshots.find(s => s.media?.kind === 'image')) { return; }
					// ★ 复用 workflowRun 的解析（host mediaGet）+ renderer fallback
					resolveMediaAssetUrl(aid).then(url => setAssetUrl(url));
				}, [meta.mediaAssetId, ownSnapshots]);
				const storedImg = (() => {
					// ★★ MediaSnapshotEntry 的引用在 entry.media.ref（无顶层 ref），
					//   此前误写 first.ref → 恒 undefined → 选图后缩略图不显示。
					const first = ownSnapshots.find(s => s.media?.kind === 'image');
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
						}}
						cellRefs={ownSnapshots.map(e => ({
  ref: e.media.ref,
  kind: e.media.kind === 'video' ? 'video' : 'image',
  caption: typeof e.media.meta?.caption === 'string' ? e.media.meta.caption : undefined,
}))}
						// ★ workflow 下拉由编辑器自己渲染：通用控件网格有 `!hasInlineEditor`
						//   门禁，静态节点有内嵌编辑器 ⇒ 所有 widget 控件都不渲染，
						//   workflow 必须在此透传（见 registry 的 static workflow options）。
						workflowOptions={emojiWorkflowOptions}
						onCommit={commitControls}
						mentionCandidates={mentionCandidates}
						onPinAsset={pinMentionAsset}
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
				</div>
			)}

			{/* DynEmojiStage 动态编辑器（参考图 → 绿幕视频 → 前端抠图 → GIF）。
			    写回通过 wf-node-control（commitControls）。参考图走上游 image 端口，
			    编辑器只管 prompt / 时长 / 绿幕抠图参数。 */}
			{isEmojiDynamic && (
				<div style={{ pointerEvents: 'auto', userSelect: 'none', marginTop: 4 }}>
					<DynEmojiStageEditor
						initial={{
							// ★ prompt 是 TEXT widget，不进 meta.controls → 改用 meta.prompt 透传。
							prompt: String(meta.prompt ?? ctl('prompt', '')),
							duration_s: Number(ctl('duration_s', 3)),
							chromaColor: String(ctl('chroma_color', '#00FF00') ?? '#00FF00'),
							chromaSimilarity: Number(ctl('chroma_similarity', 10)),
							chromaSmoothness: Number(ctl('chroma_smoothness', 10)),
						}}
						cellRefs={ownSnapshots.map(e => ({
	  ref: e.media.ref,
	  kind: e.media.kind === 'video' ? 'video' : 'image',
	  caption: typeof e.media.meta?.caption === 'string' ? e.media.meta.caption : undefined,
	}))}
						onCommit={commitControls}
						mentionCandidates={mentionCandidates}
						onPinAsset={pinMentionAsset}
						onRunRequest={() => {
							// 动态节点无网格：卡片 RUN 固定「整段生成」。
							commitControls({ run_scope: 'all' });
							if (nodeId) {
								window.dispatchEvent(new CustomEvent('wf-node-run', { detail: { nodeId } }));
							}
						}}
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
						<>
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
							{snapshotStore && snapKey && <SnapshotPreview store={snapshotStore} nodeId={snapKey} entries={latestOutputs} batch={isBatchOutput} />}
						</>
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
