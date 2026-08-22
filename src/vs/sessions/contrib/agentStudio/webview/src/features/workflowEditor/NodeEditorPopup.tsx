/*---------------------------------------------------------------------------------------------
 *  NodeEditorPopup — per-node editor overlay opened on double-click.
 *
 *  Closes the "click a ComfyTV node → type a prompt → generate an image" loop:
 *   1. derive form fields from the node spec (prompt textarea + params),
 *   2. run the single-node api.json through the resolved ComfyUI runner,
 *   3. store media snapshots → the node card under it shows the thumbnail.
 *
 *  Framework: React overlay positioned by the parent; no LiteGraph DOM hooks.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useWorkflowEditorStore } from './store';
import { getNodeSpec } from './comfyHost/registry';
import { buildEditorFields, coerceEditorValue, buildSarosEditorFields, sarosDataToValues, sarosValuesToData, isSarosJsonField, type EditorField } from './comfyHost/nodeEditorForm';
import { type SingleNodeRunResult } from './comfyHost/nodeExecutor';
import { runNodeOrStage, runProviderImage, isPickerNode, isLoaderNode, collectUpstreamCandidates, resolveFirstImageGenDefaults } from './comfyHost/workflowRun';
import { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import type { MediaSnapshotStore } from './comfyHost/mediaSnapshotStore';
import { mediaList, resolveAssetUrl, type MediaAsset } from './mediaAssets';
import type { MediaKind } from './comfyHost/mediaSnapshot';
import { useMediaSnapshotRef } from './comfyHost/useMediaSnapshot';
import { primarySnapshotKey } from './comfyHost/mediaSnapshot';
import { getPromptStore } from './comfyHost/nodeCard';
import type { CardStateStore } from './comfyHost/cardState';
import { isRelightNode, parseLightsData } from './comfyHost/relightEditor';
import { RelightEditor } from './RelightEditor';
import { isPosterNode } from './comfyHost/posterEditor';
import { PosterEditor } from './PosterEditor';
import { isCornerPinNode } from './comfyHost/cornerPinEditor';
import { CornerPinEditor } from './CornerPinEditor';
import { isRotoMaskNode } from './comfyHost/rotoMaskEditor';
import { RotoMaskEditor } from './RotoMaskEditor';
import { isLayerEditorNode } from './comfyHost/layerEditor';
import { LayerEditor } from './LayerEditor';
import { isStoryboardEditorNode } from './comfyHost/storyboardEditor';
import { StoryboardEditor } from './StoryboardEditor';
import { isMaterialNode } from './comfyHost/materialEditor';
import { MaterialEditor } from './MaterialEditor';
import { isScene3DNode } from './comfyHost/scene3dEditor';
import { Scene3DEditor } from './Scene3DEditor';
import { CropEditor } from './CropEditor';
import { MaskPainter } from './MaskPainter';
import { sendRequest } from '../../bridge/messageClient';
import { useProviderStore, type ProviderInfo } from '../../store/useProviderStore';
import { useAgentStore } from '../../store/useAgentStore';
import { usePicklistStore } from './picklistStore';

/** ComfyUI 作为文生图 provider 的特殊 id（不选 model）。 */
export const COMFY_IMAGE_PROVIDER_ID = 'comfyui';

/** 判定该 schema 节点是否为文生图类（ImageStage / ImageBatchStage 等）。 */
export function isImageGenStage(spec: { kind?: string; backendKind?: string; comfyTV?: { stageKind?: string } } | undefined, nodeType: string): boolean {
	// Provider 文生图节点（kind='llm' 或 schema+backendKind='provider'，
	// 如 Saros.ModelImageGen）固定走 imagegen RPC。
	if (spec?.kind === 'llm' || (spec?.kind === 'schema' && spec?.backendKind === 'provider')) { return true; }
	if (spec?.kind !== 'schema') { return false; }
	const kind = spec.comfyTV?.stageKind ?? nodeType;
	return kind === 'image' || kind === 'image-batch';
}

export interface NodeEditorPopupProps {
	nodeId: string;
	nodeType: string;
	/**
	 * 快照归档键（= stageUid）。缺省回退 nodeId。
	 *
	 * ★ 弹窗里的本地渲染（Relight/Poster/Layer 的 render、Loader 上传）都要按
	 *   这个键写入，否则「弹窗写 nodeId、卡片读 stageUid」→ 画好的图不显示，
	 *   而且 run 时 executor 按归档键查不到 → 误报「请先在节点弹窗中绘制」。
	 */
	snapshotKey?: string;
	runners: ComfyRunnerRegistry;
	store: MediaSnapshotStore;
	/** card execution state store (cards under nodes re-render on run) */
	cardStateStore?: CardStateStore;
	/** current runner preference ('auto' | 'local' | 'remote:<id>') */
	preference?: string;
	/** persist coerced form values so the workflow Run button reuses them */
	onValuesCommit?: (nodeId: string, values: Record<string, unknown>) => void;
	/** persisted node.data for Saros (react) nodes — initial form values */
	initialData?: Record<string, unknown>;
	/** upstream node ids (picker candidates are collected from their snapshots) */
	upstreams?: string[];
	onClose: () => void;
	onSelectRunner?: () => void;
}

function loaderMediaKind(type: string): MediaKind {
	if (type.includes('Video')) { return 'video'; }
	if (type.includes('Audio')) { return 'audio'; }
	if (type.includes('Text')) { return 'text'; }
	return 'image';
}

type RunState = 'idle' | 'running' | 'success' | 'error';

/**
 * W4b: 收集 prompt textarea 可插入的占位符令牌（点选菜单数据源）。
 * 顺序：{{input}} → 上游节点 label → Start 节点 args key。
 * 依赖 useWorkflowEditorStore.getState() 读取画布真源（nodes/edges）。
 */
function collectInsertTokens(nodeId: string): Array<{ label: string; token: string }> {
	const tokens: Array<{ label: string; token: string }> = [{ label: '上游输出', token: '{{input}}' }];
	try {
		const s = useWorkflowEditorStore.getState();
		const nodes = (s.nodes ?? []) as Array<{ id: string; type: string; data?: Record<string, unknown> }>;
		const edges = (s.edges ?? []) as Array<{ source: string; target: string }>;
		const upIds = new Set(edges.filter(e => e.target === nodeId).map(e => e.source));
		for (const n of nodes) {
			if (!upIds.has(n.id)) { continue; }
			const label = (n.data?.label as string | undefined) ?? n.type;
			if (!label) { continue; }
			tokens.push({ label: `${label}（上游）`, token: `{{${label}}}` });
		}
		for (const n of nodes) {
			if (n.type !== 'Saros.Start') { continue; }
			const raw = n.data?.args;
			let args: Record<string, unknown> = {};
			if (typeof raw === 'string') { try { args = JSON.parse(raw) as Record<string, unknown>; } catch { /* 非法 JSON 忽略 */ } }
			else if (raw && typeof raw === 'object') { args = raw as Record<string, unknown>; }
			for (const k of Object.keys(args)) {
				tokens.push({ label: `参数 ${k}`, token: `{{args.${k}}}` });
			}
		}
		// P0: 本节点 variables 局部变量 → {{变量名}} 可点选插入。
		//   variables 在 node.data 里可能是对象（sarosValuesToData 已 JSON.parse）
		//   或字符串（非法 JSON 回退），两种都兼容。
		const self = nodes.find(n => n.id === nodeId);
		const rawVars = self?.data?.variables;
		let vars: Record<string, unknown> = {};
		if (typeof rawVars === 'string') { try { vars = JSON.parse(rawVars) as Record<string, unknown>; } catch { /* 非法 JSON 忽略 */ } }
		else if (rawVars && typeof rawVars === 'object') { vars = rawVars as Record<string, unknown>; }
		for (const k of Object.keys(vars)) {
			tokens.push({ label: `变量 ${k}`, token: `{{${k}}}` });
		}
	} catch { /* store 不可用时仅提供 {{input}} */ }
	return tokens;
}

export function NodeEditorPopup({
	nodeId,
	nodeType,
	snapshotKey,
	runners,
	store,
	cardStateStore,
	preference = 'auto',
	onValuesCommit,
	initialData,
	upstreams,
	onClose,
	onSelectRunner,
}: NodeEditorPopupProps): React.JSX.Element {
	// 快照归档键：与卡片读侧（stageUid）一致，缺省回退 nodeId。
	const snapKey = snapshotKey ?? nodeId;
	const spec = getNodeSpec(nodeType);
	const fields = React.useMemo(() => buildEditorFields(spec), [spec]);
	// Saros (react) orchestration nodes: parameter-only popup, no Comfy run.
	const isReactNode = spec?.kind === 'react';
	const reactFields = React.useMemo(() => (isReactNode ? buildSarosEditorFields(nodeType) : []), [isReactNode, nodeType]);
	// Agent / Skill dropdown picklists. Agents come from the app-wide agent
	// store (lazily loaded on first workflow open); skills are fetched once via
	// the module-wide picklist store.
	const agents = useAgentStore(s => s.agents);
	const loadAgents = useAgentStore(s => s.loadAgents);
	const skills = usePicklistStore(s => s.skills);
	const loadSkills = usePicklistStore(s => s.loadSkills);
	React.useEffect(() => {
		if (!isReactNode) { return; }
		if (agents.length === 0) { void loadAgents(); }
		void loadSkills();
	}, [isReactNode, agents.length, loadAgents, loadSkills]);
	const isPicker = isPickerNode(nodeType);
	const isLoader = isLoaderNode(nodeType);
	const isRelight = isRelightNode(nodeType);
	const isPoster = isPosterNode(nodeType);
	const isCornerPin = isCornerPinNode(nodeType);
	const isRotoMask = isRotoMaskNode(nodeType);
	const isLayerEditor = isLayerEditorNode(nodeType);
	const isStoryboard = isStoryboardEditorNode(nodeType);
	const isMaterial = isMaterialNode(nodeType);
	const isScene3D = isScene3DNode(nodeType);
	const isCrop = nodeType === 'ComfyTV.CropStage';
	const isErase = nodeType === 'ComfyTV.EraseStage';
	const isInpaint = nodeType === 'ComfyTV.InpaintStage';
	const isMaskEdit = isErase || isInpaint;
	const candidates = React.useMemo(
		() => (isPicker ? collectUpstreamCandidates(store, upstreams) : []),
		[isPicker, store, upstreams],
	);
	// 媒体库历史资产（生成图片管理 P2 复用入口）：按 picker 节点类型过滤
	const pickerKind = isPicker
		? (nodeType.includes('Video') ? 'video' : nodeType.includes('Audio') ? 'audio' : 'image')
		: undefined;
	const [libAssets, setLibAssets] = React.useState<MediaAsset[]>([]);
	React.useEffect(() => {
		if (!pickerKind) { setLibAssets([]); return; }
		let done = false;
		void mediaList({ kind: pickerKind, limit: 60 })
			.then(r => { if (!done) { setLibAssets(r.items); } })
			.catch(() => {});
		return () => { done = true; };
	}, [pickerKind]);
	const posterImages = React.useMemo(
		() => (isPoster ? collectUpstreamCandidates(store, upstreams).filter(c => c.media.kind === 'image').map(c => ({ ref: c.media.ref })) : []),
		[isPoster, store, upstreams],
	);
	const cornerVideoRef = React.useMemo(
		() => (isCornerPin ? collectUpstreamCandidates(store, upstreams).find(c => c.media.kind === 'video')?.media.ref : undefined),
		[isCornerPin, store, upstreams],
	);
	const rotoVideoRef = React.useMemo(
		() => (isRotoMask ? collectUpstreamCandidates(store, upstreams).find(c => c.media.kind === 'video')?.media.ref : undefined),
		[isRotoMask, store, upstreams],
	);
	const cropImageRef = React.useMemo(
		() => (isCrop ? collectUpstreamCandidates(store, upstreams).find(c => c.media.kind === 'image')?.media.ref : undefined),
		[isCrop, store, upstreams],
	);
	const maskImageRef = React.useMemo(
		() => (isMaskEdit ? collectUpstreamCandidates(store, upstreams).find(c => c.media.kind === 'image')?.media.ref : undefined),
		[isMaskEdit, store, upstreams],
	);
	const fileRef = React.useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = React.useState(false);

	// P3 Relight: persist the light-ball state + register the uploaded render.
	const handleRelightChange = React.useCallback((lightsJson: string, prompt: string) => {
		onValuesCommit?.(nodeId, { lights_data: lightsJson, main_prompt: prompt });
	}, [nodeId, onValuesCommit]);

	const handleRelightRender = React.useCallback((url: string | null) => {
		if (!url) { return; }
		// entry.nodeId 决定归档前缀（store.put 忽略传入 key）→ 必须用 snapKey。
		store.put({
			nodeId: snapKey,
			port: 'output',
			key: `${snapKey}:output:0`,
			media: { kind: 'image', ref: url },
			index: 0,
		});
		onValuesCommit?.(nodeId, { light_render_url: url });
		cardStateStore?.set(nodeId, { runState: 'success', progress: 100 });
	}, [nodeId, snapKey, store, onValuesCommit, cardStateStore]);

	// P3 Poster: persist the layout blob + register the composed render.
	const handlePosterLayout = React.useCallback((layoutJson: string) => {
		onValuesCommit?.(nodeId, { layout: layoutJson });
	}, [nodeId, onValuesCommit]);

	// P3 Poster: size preset → 写回 width/height widget。
	const handlePosterSize = React.useCallback((w: number, h: number) => {
		setValues(v => ({ ...v, width: w, height: h }));
		onValuesCommit?.(nodeId, { width: w, height: h });
	}, [nodeId, onValuesCommit]);

	const handlePosterRender = React.useCallback((url: string | null) => {
		if (!url) { return; }
		store.put({
			nodeId: snapKey,
			port: 'output',
			key: `${snapKey}:output:0`,
			media: { kind: 'image', ref: url },
			index: 0,
		});
		cardStateStore?.set(nodeId, { runState: 'success', progress: 100 });
	}, [nodeId, snapKey, store, cardStateStore]);

	// P3 Corner Pin: persist the four corners JSON into the node values.
	const handleCornersChange = React.useCallback((json: string) => {
		onValuesCommit?.(nodeId, { corners: json });
	}, [nodeId, onValuesCommit]);

	// P3 Roto Mask: persist spline keyframes + feather/invert into the values.
	const handleRotoChange = React.useCallback((shapeKeysJson: string, feather: number, invert: boolean) => {
		onValuesCommit?.(nodeId, { shape_keys: shapeKeysJson, feather, invert });
	}, [nodeId, onValuesCommit]);

	// P3 Layer Editor: persist the document JSON + register the composite render.
	const handleLayerChange = React.useCallback((docJson: string) => {
		onValuesCommit?.(nodeId, { layer_state: docJson });
	}, [nodeId, onValuesCommit]);

	const handleLayerRender = React.useCallback((url: string | null) => {
		if (!url) { return; }
		store.put({
			nodeId: snapKey,
			port: 'output',
			key: `${snapKey}:output:0`,
			media: { kind: 'image', ref: url },
			index: 0,
		});
		cardStateStore?.set(nodeId, { runState: 'success', progress: 100 });
	}, [nodeId, snapKey, store, cardStateStore]);

	// P3 Storyboard Editor: persist board_state + register the cover render.
	const handleStoryboardState = React.useCallback((json: string) => {
		onValuesCommit?.(nodeId, { board_state: json });
	}, [nodeId, onValuesCommit]);

	// P3 Material: persist the PBR state + register the ball preview.
	const handleMaterialState = React.useCallback((json: string) => {
		onValuesCommit?.(nodeId, { material_state: json });
	}, [nodeId, onValuesCommit]);

	// P3 Scene3D: persist scene_state + register the capture composite.
	const handleSceneState = React.useCallback((json: string) => {
		onValuesCommit?.(nodeId, { scene_state: json });
	}, [nodeId, onValuesCommit]);

	// P3 Crop（交互式裁剪）：拖拽裁剪框 → 持久化像素 x/y/width/height。
	// 同时同步 values state，保证点「生成」时 handleRun 读到最新裁剪矩形。
	const handleCropChange = React.useCallback((rect: { x: number; y: number; width: number; height: number }) => {
		setValues(v => ({ ...v, x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
		onValuesCommit?.(nodeId, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
	}, [nodeId, onValuesCommit]);

	// P3 Mask（交互式擦除/内绘）：mask 上传成功 → 持久化 mask_data（annotated path）。
	const handleMaskChange = React.useCallback((annotated: string) => {
		setValues(v => ({ ...v, mask_data: annotated }));
		onValuesCommit?.(nodeId, { mask_data: annotated });
	}, [nodeId, onValuesCommit]);

	const handleMaskOpsChange = React.useCallback((opsJson: string) => {
		setValues(v => ({ ...v, mask_ops: opsJson }));
		onValuesCommit?.(nodeId, { mask_ops: opsJson });
	}, [nodeId, onValuesCommit]);

	const handleMaskPromptChange = React.useCallback((prompt: string) => {
		setValues(v => ({ ...v, prompt, main_prompt: prompt }));
		onValuesCommit?.(nodeId, { prompt, main_prompt: prompt });
	}, [nodeId, onValuesCommit]);
	const [values, setValues] = React.useState<Record<string, unknown>>(() => {
		const init: Record<string, unknown> = {};
		for (const f of fields) { init[f.key] = f.defaultValue; }
		// Saros nodes: seed the form from the persisted node.data.
		if (isReactNode && initialData) {
			Object.assign(init, sarosDataToValues(nodeType, initialData));
		}
		return init;
	});
	const [state, setState] = React.useState<RunState>('idle');
	const [result, setResult] = React.useState<SingleNodeRunResult | null>(null);

	// live refresh when a snapshot lands for this node (generation completes)
	const preview = useMediaSnapshotRef(store, primarySnapshotKey(snapKey));

	const setField = React.useCallback((key: string, value: unknown) => {
		setValues(v => ({ ...v, [key]: value }));
	}, []);

	// ── 文生图 Provider/Model 选择（ImageStage 等 image 类 schema 节点）─────
	// ComfyUI 是特殊 provider（不选 model）；其他为已认证且含文生图模型的
	// LLM providers（OpenAI 兼容 /images/generations）。
	const isImageGen = isImageGenStage(spec, nodeType);
	const providers = useProviderStore(s => s.providers);
	const loadProviders = useProviderStore(s => s.loadProviders);
	React.useEffect(() => {
		if (isImageGen && providers.length === 0) {
			void loadProviders();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isImageGen]);

	/** 已认证且模型列表含文生图模型的 provider（不含 ComfyUI）。 */
	const imageGenProviders = React.useMemo(() => {
		return (providers ?? [])
			.filter(p => p.authStatus === 'authenticated' && (p.models ?? []).some(m => m.supportsImageGen));
	}, [providers]);

	/** 当前文生图 provider id（默认 ComfyUI）。 */
	const [imageGenProviderId, setImageGenProviderId] = React.useState<string>(COMFY_IMAGE_PROVIDER_ID);
	/** 当前文生图 model id（仅非 ComfyUI 时使用）。 */
	const [imageGenModelId, setImageGenModelId] = React.useState<string>('');

	const imageGenProviderModels = React.useMemo(() => {
		const p = imageGenProviders.find(x => x.id === imageGenProviderId);
		return p?.models?.filter(m => m.supportsImageGen) ?? [];
	}, [imageGenProviders, imageGenProviderId]);

	const handleImageGenProviderChange = React.useCallback((pid: string) => {
		setImageGenProviderId(pid);
		if (pid === COMFY_IMAGE_PROVIDER_ID) {
			setImageGenModelId('');
			return;
		}
		const p = imageGenProviders.find(x => x.id === pid);
		const first = p?.models?.find(m => m.supportsImageGen);
		setImageGenModelId(first?.id ?? '');
	}, [imageGenProviders]);

	// Provider (llm 或 schema+backendKind='provider') 文生图节点不能选 ComfyUI
	// —— 自动选中第一个 imagegen provider。
	const isProviderImageGen = spec?.kind === 'llm' || (spec?.kind === 'schema' && spec?.backendKind === 'provider');
	React.useEffect(() => {
		if (isProviderImageGen && imageGenProviderId === COMFY_IMAGE_PROVIDER_ID && imageGenProviders.length > 0) {
			handleImageGenProviderChange(imageGenProviders[0].id);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isProviderImageGen, imageGenProviderId, imageGenProviders]);

	// 首次出现 image 类节点时若默认是 LLM provider 则补选 model
	React.useEffect(() => {
		if (isImageGen && imageGenProviderId !== COMFY_IMAGE_PROVIDER_ID && !imageGenModelId) {
			const p = imageGenProviders.find(x => x.id === imageGenProviderId);
			const first = p?.models?.find(m => m.supportsImageGen);
			if (first) { setImageGenModelId(first.id); }
		}
	}, [isImageGen, imageGenProviderId, imageGenModelId, imageGenProviders]);

	const handleRun = React.useCallback(async () => {
		const coerced: Record<string, unknown> = {};
		for (const f of fields) { coerced[f.key] = coerceEditorValue(values[f.key], f); }
		onValuesCommit?.(nodeId, coerced);
		// Keep the inline canvas prompt editor in sync with the popup's text.
		if (typeof coerced.prompt === 'string') {
			getPromptStore().set(nodeId, coerced.prompt);
			window.dispatchEvent(new CustomEvent('wf-node-prompt', { detail: { nodeId, prompt: coerced.prompt } }));
		}
		setState('running');
		setResult(null);
		cardStateStore?.set(nodeId, { runState: 'running', progress: 5 });

		// 文生图节点选择非 ComfyUI provider → 走统一的 Provider 文生图执行器
		// （runProviderImage：自动路由 provider/model + img2img 上游 IMAGE 注入）。
		// Provider 后端节点（kind='llm' 或 schema+backendKind='provider'）固定走
		// provider，不允许回退 ComfyUI。
		if (isImageGen && (isProviderImageGen || imageGenProviderId !== COMFY_IMAGE_PROVIDER_ID)) {
			const r = await runProviderImage({
				runner: runners.resolve(preference)!,
				nodeId,
				snapshotKey: snapKey,
				type: nodeType,
				getSpec: (t) => getNodeSpec(t),
				values: {
					...coerced,
					providerId: imageGenProviderId,
					modelId: imageGenModelId,
					prompt: typeof values.prompt === 'string' ? values.prompt : '',
					negativePrompt: typeof values.negative_prompt === 'string' ? values.negative_prompt : undefined,
					numImages: 1,
				},
				upstreams,
				store,
				onProgress: (p) => {
					cardStateStore?.set(nodeId, { runState: 'running', progress: p.progress ?? p.value ?? 50 });
				},
				// 弹窗路径：provider/model 已在 UI 下拉选择，仍注入 RPC 以备 llm 节点缺省。
				sendImageGen: (payload) => sendRequest<Record<string, unknown>, { images: Array<{ url?: string; b64?: string }> }>('imagegen.generate', payload, 180_000),
				resolveImageGenDefaults: async () => resolveFirstImageGenDefaults(imageGenProviders),
			});
			setResult(r);
			if (r.status === 'success') {
				setState('success');
				cardStateStore?.set(nodeId, { runState: 'success', progress: 100 });
			} else {
				setState('error');
				cardStateStore?.set(nodeId, { runState: 'error', progress: 0, errorMsg: r.error ?? '图片生成失败' });
			}
			return;
		}

		const runner = runners.resolve(preference);
		if (!runner) {
			setState('error');
			setResult({ promptId: '', status: 'error', error: '未找到可用的 ComfyUI Runner。请先在 Runner 面板连接。', entries: [] });
			cardStateStore?.set(nodeId, { runState: 'error', progress: 0, errorMsg: '未找到可用的 ComfyUI Runner' });
			return;
		}
		const r = await runNodeOrStage({
			runner,
			nodeId,
			snapshotKey: snapKey,
			type: nodeType,
			getSpec: (t) => getNodeSpec(t),
			values: coerced,
			store,
			onProgress: (p) => {
				cardStateStore?.set(nodeId, { runState: 'running', progress: p.progress ?? p.value ?? 50 });
			},
		});
		setResult(r);
		if (r.status === 'success') {
			setState('success');
			cardStateStore?.set(nodeId, {
				runState: 'success',
				progress: 100,
				durationMs: r.durationMs,
			});
		} else {
			setState('error');
			cardStateStore?.set(nodeId, {
				runState: 'error',
				progress: 0,
				errorMsg: r.error ?? '执行失败',
			});
		}
	}, [runners, preference, fields, values, nodeId, nodeType, store, cardStateStore, onValuesCommit,
		isImageGen, imageGenProviderId, imageGenModelId]);

	// P2 picker: choose one candidate upstream snapshot → emit it locally.
	const handlePick = React.useCallback(async (idx: number) => {
		const runner = runners.resolve(preference);
		if (!runner) {
			setState('error');
			setResult({ promptId: '', status: 'error', error: '未找到可用的 ComfyUI Runner。', entries: [] });
			return;
		}
		onValuesCommit?.(nodeId, { selected_index: idx + 1 });
		setState('running');
		setResult(null);
		cardStateStore?.set(nodeId, { runState: 'running', progress: 50 });
		const r = await runNodeOrStage({
			runner,
			nodeId,
			snapshotKey: snapKey,
			type: nodeType,
			getSpec: (t) => getNodeSpec(t),
			values: { selected_index: idx + 1 },
			store,
			upstreams,
			onProgress: () => {},
		});
		setResult(r);
		setState(r.status === 'success' ? 'success' : 'error');
		cardStateStore?.set(nodeId, r.status === 'success'
			? { runState: 'success', progress: 100 }
			: { runState: 'error', progress: 0, errorMsg: r.error ?? '执行失败' });
	}, [runners, preference, nodeId, nodeType, store, upstreams, onValuesCommit, cardStateStore]);

	// P2 picker + 媒体库：选择历史生成资产 → 经 runNodeOrStage 输出（mediaAssetId 被
	// runPickerNode 优先解析，整图执行时同样生效）。
	const handlePickAsset = React.useCallback(async (asset: MediaAsset) => {
		const runner = runners.resolve(preference);
		if (!runner) {
			setState('error');
			setResult({ promptId: '', status: 'error', error: '未找到可用的 ComfyUI Runner。', entries: [] });
			return;
		}
		onValuesCommit?.(nodeId, { mediaAssetId: asset.id, selected_index: 0 });
		setState('running');
		setResult(null);
		cardStateStore?.set(nodeId, { runState: 'running', progress: 50 });
		const r = await runNodeOrStage({
			runner,
			nodeId,
			snapshotKey: snapKey,
			type: nodeType,
			getSpec: (t) => getNodeSpec(t),
			values: { mediaAssetId: asset.id, selected_index: 0 },
			store,
			upstreams,
			onProgress: () => {},
		});
		setResult(r);
		setState(r.status === 'success' ? 'success' : 'error');
		cardStateStore?.set(nodeId, r.status === 'success'
			? { runState: 'success', progress: 100 }
			: { runState: 'error', progress: 0, errorMsg: r.error ?? '执行失败' });
	}, [runners, preference, nodeId, nodeType, store, upstreams, onValuesCommit, cardStateStore]);

	// P2 loader: upload the local file to ComfyUI input/ → register a snapshot.
	const handleFile = React.useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = '';
		if (!file) { return; }
		const runner = runners.resolve(preference);
		if (!runner) {
			setState('error');
			setResult({ promptId: '', status: 'error', error: '未找到可用的 ComfyUI Runner。', entries: [] });
			return;
		}
		if (!runner.fetchApi) {
			setState('error');
			setResult({ promptId: '', status: 'error', error: '该 Runner 不支持文件上传。', entries: [] });
			return;
		}
		setUploading(true);
		setState('running');
		setResult(null);
		cardStateStore?.set(nodeId, { runState: 'running', progress: 30 });
		try {
			const form = new FormData();
			form.append('image', file);
			const resp = await runner.fetchApi('/upload/image', { method: 'POST', body: form });
			const data = await resp.json();
			const name = String(data?.name ?? '');
			const subfolder = String(data?.subfolder ?? '');
			const type = String(data?.type ?? 'output');
			const ref = `${runner.baseUrl}/view?filename=${encodeURIComponent(name)}${subfolder ? '&subfolder=' + encodeURIComponent(subfolder) : ''}&type=${type}`;
			const entry = { nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, media: { kind: loaderMediaKind(nodeType), ref }, index: 0 };
			store.put(entry);
			onValuesCommit?.(nodeId, { uploaded: { name, subfolder, type } });
			setState('success');
			setResult({ promptId: '', status: 'success', entries: [entry] });
			cardStateStore?.set(nodeId, { runState: 'success', progress: 100 });
		} catch (err) {
			setState('error');
			setResult({ promptId: '', status: 'error', error: String(err), entries: [] });
			cardStateStore?.set(nodeId, { runState: 'error', progress: 0, errorMsg: String(err) });
		} finally {
			setUploading(false);
		}
	}, [runners, preference, nodeId, nodeType, store, onValuesCommit, cardStateStore]);

	const statusColor = state === 'running' ? '#3b82f6' : state === 'success' ? '#22c55e' : state === 'error' ? '#ef4444' : 'var(--vscode-descriptionForeground)';

	return (
		<div
			style={{
				position: 'absolute', top: 60, right: 12, zIndex: 40, width: 340,
				// P2-fix: calc(100% - 80px) 在 webview 父链高度未定义时退化为 0 导致内容被截。
				// 用 viewport 单位兜底，确保 popup 始终能滚动展示完整内容。
				maxHeight: 'min(calc(100% - 80px), calc(100vh - 100px), 760px)',
				overflowY: 'auto',
				borderRadius: 8, background: 'var(--vscode-sideBar-background)',
				border: '1px solid var(--vscode-panel-border)',
				boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
				fontFamily: 'inherit', fontSize: 12,
				color: 'var(--vscode-foreground)',
			}}
		>
			{/* Header */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--vscode-panel-border)' }}>
				<span style={{ fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
					{spec?.title ?? nodeType}
				</span>
				<span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{nodeType}
				</span>
				<button
					onClick={onClose}
					title="关闭"
					style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--vscode-foreground)', cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}
				>✕</button>
			</div>

			{/* Form */}
			<div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
				{/* P2 picker: candidate grid → click to emit the selected snapshot */}
				{isPicker && (
					<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
						<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
							上游候选 {candidates.length} 个（点击选择即输出）
						</div>
						{candidates.length === 0 && (
							<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>
								暂无候选：请先连接上游生成节点并执行。
							</div>
						)}
						<div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
							{candidates.map((c, i) => (
								<button
									key={c.key}
									onClick={() => void handlePick(i)}
									title={c.media.ref}
									style={{
										display: 'flex', gap: 8, alignItems: 'center', padding: 4, borderRadius: 5, cursor: 'pointer',
										background: Number(values.selected_index) === i + 1 ? 'rgba(59,130,246,.18)' : 'rgba(255,255,255,.04)',
										border: '1px solid rgba(255,255,255,.12)', color: 'var(--vscode-foreground)', textAlign: 'left', fontFamily: 'inherit',
									}}
								>
									<span style={{ fontSize: 10, width: 22, color: 'var(--vscode-descriptionForeground)', flexShrink: 0 }}>#{i + 1}</span>
									{c.media.kind === 'image' && c.media.ref.startsWith('http') ? (
										<img src={c.media.ref} alt="" style={{ width: 40, height: 26, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }} />
									) : (
										<span style={{ fontSize: 9, fontFamily: 'monospace', color: 'var(--vscode-descriptionForeground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.media.ref}</span>
									)}
									<span style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.media.kind}</span>
								</button>
							))}
						</div>
						{/* 媒体库历史资产（生成图片管理 P2 复用入口） */}
						<div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
							<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
								媒体库（历史生成图，点击即输出）
							</div>
							<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 132, overflowY: 'auto' }}>
								{libAssets.length === 0 ? (
									<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>暂无媒体库资产，运行工作流生成图片后会自动收录。</span>
								) : (
									libAssets.map(a => (
										<LibraryThumb key={a.id} asset={a} onClick={() => void handlePickAsset(a)} />
									))
								)}
							</div>
						</div>
					</div>
				)}

				{/* P3 Relight: embedded light-ball editor */}
				{isRelight && (
					<RelightEditor
						initialLights={parseLightsData(values.lights_data)}
						initialPrompt={typeof values.main_prompt === 'string' ? values.main_prompt : ''}
						runners={runners}
						preference={preference}
						onLightsChange={handleRelightChange}
						onRenderUploaded={handleRelightRender}
					/>
				)}

				{/* P3 Corner Pin: four-corner drag editor */}
				{isCornerPin && (
					<CornerPinEditor
						initialCorners={typeof values.corners === 'string' ? values.corners : ''}
						videoRef={cornerVideoRef}
						onCornersChange={handleCornersChange}
					/>
				)}

				{/* P3 Roto Mask: spline editor */}
				{isRotoMask && (
					<RotoMaskEditor
						initialShapeKeys={typeof values.shape_keys === 'string' ? values.shape_keys : ''}
						videoRef={rotoVideoRef}
						initialFeather={Number(values.feather ?? 0)}
						initialInvert={Boolean(values.invert)}
						onShapeChange={handleRotoChange}
					/>
				)}

				{/* P3 Layer Editor: artboard */}
				{isLayerEditor && (
					<LayerEditor
						initialDoc={typeof values.layer_state === 'string' ? values.layer_state : ''}
						width={Number(values.width) || 1024}
						height={Number(values.height) || 1024}
						runners={runners}
						preference={preference}
						onDocChange={handleLayerChange}
						onRenderUploaded={handleLayerRender}
					/>
				)}

				{/* P3 Storyboard Editor: multi-board artboard */}
				{isStoryboard && (
					<StoryboardEditor
						initialState={typeof values.board_state === 'string' ? values.board_state : ''}
						width={Number(values.width) || 1280}
						height={Number(values.height) || 720}
						runners={runners}
						preference={preference}
						onStateChange={handleStoryboardState}
						onRenderUploaded={handleLayerRender}
					/>
				)}

				{/* P3 Material: PBR ball editor */}
				{isMaterial && (
					<MaterialEditor
						initialState={typeof values.material_state === 'string' ? values.material_state : ''}
						runners={runners}
						preference={preference}
						onStateChange={handleMaterialState}
						onRenderUploaded={handleLayerRender}
					/>
				)}

				{/* P3 Scene3D: isometric scene editor */}
				{isScene3D && (
					<Scene3DEditor
						initialState={typeof values.scene_state === 'string' ? values.scene_state : ''}
						runners={runners}
						preference={preference}
						onStateChange={handleSceneState}
						onRenderUploaded={handleLayerRender}
					/>
				)}

				{/* P3 Crop: interactive drag-crop editor (增强：替代纯数字 x/y/width/height) */}
				{isCrop && (
					<CropEditor
						initial={{
							x: Number(values.x ?? 0),
							y: Number(values.y ?? 0),
							width: Number(values.width ?? 512),
							height: Number(values.height ?? 512),
						}}
						imageRef={cropImageRef}
						onCropChange={handleCropChange}
					/>
				)}

				{/* P3 Mask: interactive erase/inpaint mask painter（增强：替代纯 mask_data 字符串） */}
				{isMaskEdit && (
					<MaskPainter
						imageRef={maskImageRef}
						initialOps={typeof values.mask_ops === 'string' ? values.mask_ops : undefined}
						showPrompt={isInpaint}
						initialPrompt={typeof values.prompt === 'string' ? values.prompt : ''}
						onPromptChange={handleMaskPromptChange}
						runners={runners}
						preference={preference}
						onMaskChange={handleMaskChange}
						onOpsChange={handleMaskOpsChange}
					/>
				)}

				{/* P3 Poster: embedded layout editor */}
				{isPoster && (
					<PosterEditor
						initialLayout={typeof values.layout === 'string' ? values.layout : ''}
						images={posterImages}
						runners={runners}
						preference={preference}
						width={typeof values.width === 'number' ? values.width : 1240}
						height={typeof values.height === 'number' ? values.height : 1754}
						onSizeChange={handlePosterSize}
						onLayoutChange={handlePosterLayout}
						onRenderUploaded={handlePosterRender}
					/>
				)}

				{/* P2 loader: pick a local file → upload to ComfyUI input/ → snapshot */}
				{isLoader && (
					<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
						<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
							从本地选择文件并上传到 ComfyUI input 目录。
						</div>
						<button
							onClick={() => fileRef.current?.click()}
							disabled={uploading || state === 'running'}
							style={{
								padding: '6px 10px', borderRadius: 4, cursor: 'pointer',
								background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
								border: 'none', fontWeight: 600, fontSize: 12, fontFamily: 'inherit',
							}}
						>
							{uploading ? '上传中…' : '📂 选择文件'}
						</button>
						<input ref={fileRef} type="file" hidden onChange={(e) => void handleFile(e)} />
						{preview && preview.kind !== 'text' && preview.ref.startsWith('http') && (
							<div style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(255,255,255,.15)' }}>
								{preview.kind === 'image'
									? <img src={preview.ref} alt="已选文件" style={{ width: '100%', display: 'block' }} />
									: <div style={{ fontSize: 10, padding: 6, color: 'var(--vscode-descriptionForeground)' }}>{preview.ref}</div>}
							</div>
						)}
					</div>
				)}

				{/* 文生图 Provider/Model 选择（ComfyUI 为特殊 provider，不选 model） */}
				{isImageGen && (
					<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
						<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
							<label style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', width: 52, flexShrink: 0 }}>Provider</label>
							<select
								value={imageGenProviderId}
								onChange={e => handleImageGenProviderChange(e.target.value)}
								style={{
									flex: 1, padding: '4px 6px', borderRadius: 4, background: 'var(--vscode-input-background)',
									color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-input-border)', fontSize: 11, fontFamily: 'inherit',
								}}
							>
								<option value={COMFY_IMAGE_PROVIDER_ID}>ComfyUI</option>
								{imageGenProviders.map(p => (
									<option key={p.id} value={p.id}>{p.name}</option>
								))}
							</select>
						</div>
						{imageGenProviderId !== COMFY_IMAGE_PROVIDER_ID && (
							<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
								<label style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', width: 52, flexShrink: 0 }}>Model</label>
								<select
									value={imageGenModelId}
									onChange={e => setImageGenModelId(e.target.value)}
									style={{
										flex: 1, padding: '4px 6px', borderRadius: 4, background: 'var(--vscode-input-background)',
										color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-input-border)', fontSize: 11, fontFamily: 'inherit',
									}}
								>
									{imageGenProviderModels.length === 0 && <option value="">（该 Provider 无文生图模型）</option>}
									{imageGenProviderModels.map(m => (
										<option key={m.id} value={m.id}>{m.name}</option>
									))}
								</select>
							</div>
						)}
					</div>
				)}

				{/* Generic form (non picker/loader/relight/poster/cornerpin/roto/layereditor/storyboard/material/scene3d/crop/mask) */}
				{!isPicker && !isLoader && !isRelight && !isPoster && !isCornerPin && !isRotoMask && !isLayerEditor && !isStoryboard && !isMaterial && !isScene3D && !isCrop && !isMaskEdit && (
					<>
						{fields.length === 0 && !isReactNode && (
							<div style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 11 }}>
								该节点没有可编辑参数（动态上游端口）。
							</div>
						)}
						{/* ★ Agent 节点主次分层：主选择区（agentId + prompt）+ 「高级：覆盖模型」
						   折叠（providerId/modelId）。agentId 是主选择、provider/model 是可选
						   覆盖配置（存 agentConfig 子对象），平铺会让用户分不清主次。 */}
						{nodeType === 'Saros.Agent' ? (
							<>
								{fields.filter(f => f.key === 'agentId').map(f => <FieldEditor key={f.key} field={f} value={values[f.key]} providerId={String(values.providerId ?? '')} nodeId={nodeId} onChange={v => setField(f.key, v)} />)}
								{fields.filter(f => f.key === 'prompt').map(f => <FieldEditor key={f.key} field={f} value={values[f.key]} providerId={String(values.providerId ?? '')} nodeId={nodeId} onChange={v => setField(f.key, v)} />)}
								<details style={{ marginTop: 6, borderTop: '1px solid var(--vscode-panel-border)', paddingTop: 6 }}>
									<summary style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', cursor: 'pointer', listStyle: 'none', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
										<span style={{ transition: 'transform .15s', display: 'inline-block' }}>▸</span> 高级：覆盖模型配置
									</summary>
									<div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
										{fields.filter(f => f.key === 'providerId' || f.key === 'modelId').map(f => <FieldEditor key={f.key} field={f} value={values[f.key]} providerId={String(values.providerId ?? '')} nodeId={nodeId} onChange={v => setField(f.key, v)} />)}
									</div>
								</details>
							</>
						) : (
							fields.map(f => <FieldEditor key={f.key} field={f} value={values[f.key]} providerId={String(values.providerId ?? '')} nodeId={nodeId} onChange={v => setField(f.key, v)} />)
						)}
					</>
				)}

				{/* Runner status / action */}
				{!isPicker && !isLoader && !isRelight && !isPoster && !isCornerPin && !isRotoMask && !isLayerEditor && !isStoryboard && !isMaterial && !isScene3D && (
					<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
						{isReactNode ? (
							<button
								onClick={() => {
									onValuesCommit?.(nodeId, sarosValuesToData(nodeType, values));
									onClose();
								}}
								style={{
									flex: 1, padding: '6px 10px', borderRadius: 4, cursor: 'pointer',
									background: 'var(--vscode-button-background)',
									color: 'var(--vscode-button-foreground)', border: 'none', fontWeight: 600, fontSize: 12,
									fontFamily: 'inherit',
								}}
							>
								💾 保存参数
							</button>
						) : (
							<>
								<button
									onClick={() => void handleRun()}
									disabled={state === 'running'}
									style={{
										flex: 1, padding: '6px 10px', borderRadius: 4, cursor: state === 'running' ? 'wait' : 'pointer',
										background: state === 'running' ? 'var(--vscode-button-secondaryBackground)' : 'var(--vscode-button-background)',
										color: 'var(--vscode-button-foreground)', border: 'none', fontWeight: 600, fontSize: 12,
										fontFamily: 'inherit',
									}}
								>
									{state === 'running' ? '生成中…' : '▶ 生成'}
								</button>
								{!runners.resolve(preference) && (
									<button
										onClick={onSelectRunner}
										title="打开 Runner 面板"
										style={{ padding: '6px 8px', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--vscode-textLink-foreground)', border: '1px solid var(--vscode-panel-border)', fontSize: 11, fontFamily: 'inherit' }}
									>
										🖥 Runner
									</button>
								)}
							</>
						)}
					</div>
				)}

				{/* Status + result */}
				{state !== 'idle' && (
					<div style={{ fontSize: 11, color: statusColor, padding: '4px 6px', background: 'rgba(255,255,255,.04)', borderRadius: 4 }}>
						{state === 'running' ? '正在执行…' : state === 'success' ? `${result?.entries.length ?? 0} 个输出` : `执行失败：${result?.error ?? '未知错误'}`}
					</div>
				)}

				{/* Preview (non picker/loader/relight/poster/cornerpin/roto/layereditor/storyboard/material/scene3d — those embed their own) */}
				{state !== 'idle' && !isPicker && !isLoader && !isRelight && !isPoster && !isCornerPin && !isRotoMask && !isLayerEditor && !isStoryboard && !isMaterial && !isScene3D && preview && preview.kind === 'image' && (
					<div style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(255,255,255,.15)', background: 'rgba(0,0,0,.4)' }}>
						<img src={preview.ref} alt="生成结果" style={{ width: '100%', display: 'block', objectFit: 'contain' }} />
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * 复刻 ComfyTV LoadImage 编辑器：文件名 input（短展示）+ 本地上传按钮 +
 * 缩略图（按比例渲染）+ 尺寸文字 `W × H`（HTMLImageElement.naturalWidth）。
 * value 存 data:image/... data URL 或 http URL（兼容剪贴板粘贴/Picker 选中）。
 * 缩略图 + 尺寸由 useEffect 异步测量，依赖 URL 变化触发重算。
 */
function ImageFieldEditor({ label, value, onChange, inputStyle }: { label: string; value: string; onChange: (v: unknown) => void; inputStyle: React.CSSProperties }): React.JSX.Element {
	const inputRef = React.useRef<HTMLInputElement | null>(null);
	const [size, setSize] = React.useState<{ w: number; h: number } | null>(null);
	const labelStyle: React.CSSProperties = { fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginBottom: 2, display: 'block' };
	React.useEffect(() => {
		if (!value) { setSize(null); return; }
		const img = new Image();
		img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight });
		img.onerror = () => {
			console.warn('[ImageFieldEditor] thumbnail measure failed to load, value=', value?.slice(0, 120));
			setSize(null);
		};
		img.src = value;
	}, [value]);
	const fileName = value ? (() => {
		try {
			if (value.startsWith('data:')) { return 'pasted image'; }
			const u = new URL(value);
			return decodeURIComponent(u.pathname.split('/').pop() || value);
		} catch { return value.slice(0, 32); }
	})() : '';
	return (
		<div>
			<label style={labelStyle}>{label}</label>
			<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
				<input
					value={fileName}
					readOnly
					placeholder="（未选图）"
					style={{ ...inputStyle, flex: 1, cursor: 'pointer', minWidth: 0 }}
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
							if (s) { onChange(s); }
						};
						reader.readAsDataURL(f);
						e.target.value = '';
					}} />
			</div>
			{value && (
				<div style={{ background: 'var(--vscode-input-background)', border: '1px solid var(--vscode-input-border)', borderRadius: 4, padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
					<img
						src={value}
						alt=""
						style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain' }}
						onError={() => console.warn('[ImageFieldEditor] thumbnail <img> failed to render, value=', value?.slice(0, 120))}
					/>
				</div>
			)}
			{size && (
				<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginTop: 3, textAlign: 'center', fontFamily: 'var(--monospace, monospace)' }}>
					{size.w} × {size.h}
				</div>
			)}
		</div>
	);
}

/**
 * P1: JSON 对象字段的结构化 KV 编辑器（variables / skillArgs / toolParams / options）。
 * 扁平对象 → 每行 key/value 输入 + 类型徽章 + 删除；「+ 添加键」追加；
 * 语法错误 → 红框提示；非扁平对象（嵌套/数组）→ 回退文本编辑。
 * 受控组件：值完全由 value 派生，编辑即 onChange(序列化 JSON)。
 */
function JsonKeyValueField({ field, value, onChange, labelStyle, inputStyle }: { field: EditorField; value: unknown; onChange: (v: unknown) => void; labelStyle: React.CSSProperties; inputStyle: React.CSSProperties }): React.JSX.Element {
	const [textMode, setTextMode] = React.useState(false);
	const raw = String(value ?? '');
	let parsed: unknown;
	let parseError: string | undefined;
	try { parsed = JSON.parse(raw || '{}'); } catch (e) { parseError = e instanceof Error ? e.message : String(e); }
	const isFlatObj = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
		&& Object.values(parsed as Record<string, unknown>).every(v => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
	const entries: Array<[string, unknown]> = isFlatObj ? Object.entries(parsed as Record<string, unknown>) : [];

	const smallInput: React.CSSProperties = { ...inputStyle, padding: '3px 6px', fontSize: 11 };
	const toggleBtn: React.CSSProperties = { fontSize: 10, cursor: 'pointer', border: '1px solid var(--vscode-panel-border)', background: 'transparent', color: 'var(--vscode-descriptionForeground)', borderRadius: 4, padding: '1px 7px', marginLeft: 6, fontFamily: 'inherit' };

	// P1: 显式类型下拉——输入框编辑时**保持当前类型**（不再自动推断），
	// 类型由右侧 select 显式控制。
	const coerceKeepType = (s: string, cur: unknown): unknown => {
		if (cur === null) { return null; }
		if (typeof cur === 'number') { const n = Number(s); return Number.isNaN(n) ? s : n; }
		if (typeof cur === 'boolean') { return s === 'true'; }
		return s;
	};
	const typeOf = (v: unknown): string => v === null ? 'null' : typeof v;
	const setEntries = (next: Array<[string, unknown]>) => {
		const obj: Record<string, unknown> = {};
		for (const [k, v] of next) { if (k) { obj[k] = v; } }
		onChange(JSON.stringify(obj, null, 2));
	};
	const setRowType = (i: number, t: string) => {
		const next = entries.slice();
		const [k, v] = next[i];
		const s = v === null ? '' : String(v);
		if (t === 'string') { next[i] = [k, s]; }
		else if (t === 'number') { const n = Number(s); next[i] = [k, Number.isNaN(n) ? 0 : n]; }
		else if (t === 'boolean') { next[i] = [k, s === 'true']; }
		else if (t === 'null') { next[i] = [k, null]; }
		setEntries(next);
	};

	if (parseError) {
		return (
			<div>
				<label style={labelStyle}>{field.label}</label>
				<div style={{ fontSize: 10, color: 'var(--vscode-errorForeground, #f48771)', marginBottom: 3 }}>JSON 语法错误：{parseError}</div>
				<textarea rows={4} value={raw} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, resize: 'vertical', borderColor: 'var(--vscode-errorForeground)' }} />
			</div>
		);
	}

	if (textMode || !isFlatObj) {
		return (
			<div>
				<label style={labelStyle}>{field.label}{isFlatObj && <button type="button" onClick={() => setTextMode(false)} style={toggleBtn}>切换到表单编辑</button>}</label>
				<textarea rows={4} value={raw} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.4 }} />
			</div>
		);
	}

	return (
		<div>
			<label style={labelStyle}>{field.label}<button type="button" onClick={() => setTextMode(true)} style={toggleBtn}>切换为文本</button></label>
			{entries.map(([k, v], i) => (
				<div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
					<input
						value={k}
						placeholder="key"
						onChange={e => { const next = entries.slice(); next[i] = [e.target.value, v]; setEntries(next); }}
						style={{ ...smallInput, flex: '0 0 38%' }}
					/>
					<input
						value={v === null ? '' : String(v)}
						placeholder={v === null ? 'null' : 'value（支持 {{input}}）'}
						disabled={v === null}
						onChange={e => { const next = entries.slice(); next[i] = [k, coerceKeepType(e.target.value, v)]; setEntries(next); }}
						style={{ ...smallInput, flex: 1, opacity: v === null ? 0.5 : 1 }}
					/>
					<select
						value={typeOf(v)}
						title="值类型"
						onChange={e => setRowType(i, e.target.value)}
						style={{ fontSize: 9, fontFamily: 'var(--monospace, monospace)', color: 'var(--vscode-descriptionForeground)', background: 'var(--vscode-input-background)', border: '1px solid var(--vscode-input-border)', borderRadius: 3, padding: '1px 2px', flexShrink: 0, cursor: 'pointer' }}
					>
						<option value="string">string</option>
						<option value="number">number</option>
						<option value="boolean">boolean</option>
						<option value="null">null</option>
					</select>
					<button type="button" title="删除此键" onClick={() => setEntries(entries.filter((_, idx) => idx !== i))} style={{ fontSize: 12, cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--vscode-descriptionForeground)', padding: '0 4px' }}>✕</button>
				</div>
			))}
			<button type="button" onClick={() => setEntries([...entries, ['', '']])} style={{ fontSize: 10, cursor: 'pointer', border: '1px dashed var(--vscode-panel-border)', background: 'transparent', color: 'var(--vscode-descriptionForeground)', borderRadius: 4, padding: '2px 10px', marginTop: 2, fontFamily: 'inherit' }}>+ 添加键</button>
		</div>
	);
}

function FieldEditor({ field, value, onChange, providerId, nodeId }: { field: EditorField; value: unknown; onChange: (v: unknown) => void; providerId?: string; nodeId?: string }): React.JSX.Element {
	const labelStyle: React.CSSProperties = { fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginBottom: 2, display: 'block' };
	const inputStyle: React.CSSProperties = {
		width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: 11,
		background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)',
		border: '1px solid var(--vscode-input-border)', borderRadius: 4,
		fontFamily: 'inherit', outline: 'none',
	};

	// W4b: prompt textarea 的「插入占位符」点选——hooks 必须无条件调用，故提至顶层。
	const [insertOpen, setInsertOpen] = React.useState(false);
	const taRef = React.useRef<HTMLTextAreaElement | null>(null);
	const insertTokens = (field.kind === 'textarea' && field.key === 'prompt' && nodeId)
		? collectInsertTokens(nodeId)
		: [];
	const insertToken = (token: string) => {
		const ta = taRef.current;
		const cur = String(value ?? '');
		if (!ta) { onChange(cur + token); setInsertOpen(false); return; }
		const start = ta.selectionStart ?? cur.length;
		const end = ta.selectionEnd ?? start;
		onChange(cur.slice(0, start) + token + cur.slice(end));
		setInsertOpen(false);
		requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + token.length; });
	};

	if (field.kind === 'provider') {
		return <ProviderModelSelect
			mode="provider"
			value={String(value ?? '')}
			providerId={String(value ?? '')}
			onChange={onChange}
			labelStyle={labelStyle}
			inputStyle={inputStyle}
		/>;
	}

	if (field.kind === 'providerModel') {
		return <ProviderModelSelect
			mode="model"
			value={String(value ?? '')}
			providerId={providerId ?? ''}
			onChange={onChange}
			labelStyle={labelStyle}
			inputStyle={inputStyle}
		/>;
	}

	// P1: Agent 节点的 LLM provider/model 下拉——列出所有已认证 provider 的
	// 全部聊天模型（不过滤 supportsImageGen，区别于 ProviderPicker 的文生图）。
	if (field.kind === 'agentProvider') {
		return <AgentProviderModelSelect
			mode="provider"
			label={field.label}
			value={String(value ?? '')}
			providerId={String(value ?? '')}
			onChange={onChange}
			labelStyle={labelStyle}
			inputStyle={inputStyle}
		/>;
	}
	if (field.kind === 'agentModel') {
		return <AgentProviderModelSelect
			mode="model"
			label={field.label}
			value={String(value ?? '')}
			providerId={providerId ?? ''}
			onChange={onChange}
			labelStyle={labelStyle}
			inputStyle={inputStyle}
		/>;
	}

	if (field.kind === 'agent' || field.kind === 'skill' || field.kind === 'tool') {
		return <SearchableSelect
			field={field}
			value={String(value ?? '')}
			onChange={onChange}
			labelStyle={labelStyle}
			inputStyle={inputStyle}
		/>;
	}

	if (field.kind === 'image') {
		return <ImageFieldEditor label={field.label} value={String(value ?? '')} onChange={onChange} inputStyle={inputStyle} />;
	}

	if (field.kind === 'textarea') {
		// P1: JSON 对象字段（variables/skillArgs/toolParams/options/args）用 KV 结构化
		// 编辑器替代裸 textarea——语法错误即时红框提示、无需手写 JSON。嵌套/数组自动回退文本。
		if (isSarosJsonField(field.key) || field.key === 'args') {
			return <JsonKeyValueField field={field} value={value} onChange={onChange} labelStyle={labelStyle} inputStyle={inputStyle} />;
		}
		return (
			<div>
				<label style={labelStyle}>{field.label}</label>
				{insertTokens.length > 0 && (
					<div style={{ position: 'relative', display: 'inline-block', marginBottom: 3 }}>
						<button
							type="button"
							title="插入变量占位符（{{input}} / 上游节点 / Start 参数 / 本节点变量）"
							onClick={() => setInsertOpen(v => !v)}
							style={{ fontSize: 10, cursor: 'pointer', border: '1px solid var(--vscode-panel-border)', background: 'transparent', color: 'var(--vscode-descriptionForeground)', borderRadius: 4, padding: '1px 7px', fontFamily: 'inherit' }}
						>
							⌁ 插入
						</button>
						{insertOpen && (
							<div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 20, minWidth: 200, background: 'var(--vscode-menu-background)', border: '1px solid var(--vscode-menu-border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.4)', padding: 4 }}>
								{insertTokens.map(t => (
									<button
										key={t.token}
										type="button"
										onClick={() => insertToken(t.token)}
										style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 11, background: 'none', border: 'none', color: 'var(--vscode-foreground)', cursor: 'pointer', borderRadius: 4, fontFamily: 'inherit' }}
										onMouseEnter={e => { e.currentTarget.style.background = 'var(--vscode-menu-selectionBackground)'; }}
										onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
									>
										<span style={{ opacity: 0.65, fontSize: 10 }}>{t.label}</span>
										<span style={{ fontFamily: 'var(--monospace, monospace)', marginLeft: 'auto', fontSize: 10.5, opacity: 0.85 }}>{t.token}</span>
									</button>
								))}
							</div>
						)}
					</div>
				)}
				<textarea
					ref={taRef}
					rows={3}
					value={String(value ?? '')}
					placeholder={field.placeholder}
					onChange={e => onChange(e.target.value)}
					style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.4 }}
				/>
			</div>
		);
	}
	if (field.kind === 'select') {
		return (
			<div>
				<label style={labelStyle}>{field.label}</label>
				<select
					value={String(value ?? '')}
					onChange={e => onChange(e.target.value)}
					style={{ ...inputStyle, cursor: 'pointer' }}
				>
					{(field.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
				</select>
			</div>
		);
	}
	return (
		<div>
			<label style={labelStyle}>{field.label}</label>
			<input
				type={field.kind === 'number' ? 'number' : 'text'}
				value={String(value ?? '')}
				placeholder={field.placeholder}
				onChange={e => onChange(field.kind === 'number' ? Number(e.target.value) : e.target.value)}
				style={inputStyle}
			/>
		</div>
	);
}

/* ── Provider / Model 联动下拉（ProviderPicker 节点）────────────────────
 * provider：列出所有已认证且有文生图模型的 provider；model：联动当前
 * provider 的 supportsImageGen 模型。value 为空时自动选中第一个可用项。 */
function ProviderModelSelect({ mode, value, providerId, onChange, labelStyle, inputStyle }: {
	mode: 'provider' | 'model';
	value: string;
	providerId: string;
	onChange: (v: unknown) => void;
	labelStyle: React.CSSProperties;
	inputStyle: React.CSSProperties;
}): React.JSX.Element {
	const providers = useProviderStore(s => s.providers);
	const imageGenProviders = React.useMemo(
		() => providers.filter(p => p.authStatus === 'authenticated' && p.models.some(m => m.supportsImageGen)),
		[providers],
	);
	const models = React.useMemo(() => {
		const p = imageGenProviders.find(x => x.id === providerId);
		return (p?.models ?? []).filter(m => m.supportsImageGen);
	}, [imageGenProviders, providerId]);

	if (mode === 'provider') {
		const effective = value || imageGenProviders[0]?.id || '';
		return (
			<div>
				<label style={labelStyle}>Provider</label>
				<select value={effective} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
					{imageGenProviders.length === 0 && <option value="">（无已认证的文生图 Provider）</option>}
					{imageGenProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
				</select>
			</div>
		);
	}
	const effective = value || models[0]?.id || '';
	return (
		<div>
			<label style={labelStyle}>Model</label>
			<select value={effective} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
				{models.length === 0 && <option value="">（该 Provider 无文生图模型）</option>}
				{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
			</select>
		</div>
	);
}

/* ── Agent 节点 LLM Provider / Model 下拉（P1）────────────────────────────
 * 列出所有已认证 provider 的全部聊天模型（不做 supportsImageGen 过滤——
 * Agent 需要的是 LLM chat 模型，而非 ProviderPicker 的文生图模型）。 */
function AgentProviderModelSelect({ mode, label, value, providerId, onChange, labelStyle, inputStyle }: {
	mode: 'provider' | 'model';
	label: string;
	value: string;
	providerId: string;
	onChange: (v: unknown) => void;
	labelStyle: React.CSSProperties;
	inputStyle: React.CSSProperties;
}): React.JSX.Element {
	const providers = useProviderStore(s => s.providers);
	const loadProviders = useProviderStore(s => s.loadProviders);
	React.useEffect(() => { if (providers.length === 0) { void loadProviders(); } }, [providers.length, loadProviders]);
	const chatProviders = React.useMemo(
		() => providers.filter(p => p.authStatus === 'authenticated'),
		[providers],
	);
	const models = React.useMemo(() => {
		const p = chatProviders.find(x => x.id === providerId);
		return p?.models ?? [];
	}, [chatProviders, providerId]);

	if (mode === 'provider') {
		const effective = value || chatProviders[0]?.id || '';
		return (
			<div>
				<label style={labelStyle}>{label}</label>
				<select value={effective} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
					{chatProviders.length === 0 && <option value="">（无已认证的 Provider）</option>}
					{chatProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
				</select>
			</div>
		);
	}
	const effective = value || models[0]?.id || '';
	return (
		<div>
			<label style={labelStyle}>{label}</label>
			<select value={effective} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
				{models.length === 0 && <option value="">（该 Provider 无模型）</option>}
				{models.map(m => <option key={m.id} value={m.id}>{m.name}{m.supportsToolCall ? ' · 工具' : ''}</option>)}
			</select>
		</div>
	);
}

/* ── Searchable dropdown (Agent / Skill fields) ────────────────────────────
 * Renders a filterable combobox populated with every current agent / skill.
 * The filter input appears when the list is open; click an item to pick.
 * Also lets the user keep the previously persisted value even when it's not
 * in the current list (e.g. an agent was deleted). */
/** 媒体库资产缩略（懒解析可加载 URL）。 */
function LibraryThumb({ asset, onClick }: { asset: MediaAsset; onClick: () => void }): React.JSX.Element {
	const [url, setUrl] = React.useState<string | null>(null);
	React.useEffect(() => {
		let done = false;
		void resolveAssetUrl(asset).then(u => { if (!done) { setUrl(u); } }).catch(() => {});
		return () => { done = true; };
	}, [asset]);
	return (
		<button
			onClick={onClick}
			title={asset.fileName ?? asset.ref}
			style={{
				width: 56, height: 56, borderRadius: 5, overflow: 'hidden', padding: 0, cursor: 'pointer',
				border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.04)',
			}}
		>
			{asset.kind === 'image' && url ? (
				<img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
			) : (
				<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', fontSize: 9, color: 'var(--vscode-descriptionForeground)' }}>
					{asset.kind}
				</div>
			)}
		</button>
	);
}

function SearchableSelect({ field, value, onChange, labelStyle, inputStyle }: {
	field: EditorField;
	value: string;
	onChange: (v: unknown) => void;
	labelStyle: React.CSSProperties;
	inputStyle: React.CSSProperties;
}): React.JSX.Element {
	const agents = useAgentStore(s => s.agents);
	const skills = usePicklistStore(s => s.skills);
	const tools = usePicklistStore(s => s.tools);
	const loadSkills = usePicklistStore(s => s.loadSkills);
	const loadTools = usePicklistStore(s => s.loadTools);
	React.useEffect(() => {
		if (field.kind === 'skill' && skills.length === 0) { void loadSkills(); }
		if (field.kind === 'tool' && tools.length === 0) { void loadTools(); }
	}, [field.kind, skills.length, tools.length, loadSkills, loadTools]);
	// ★ 富选项：agent/skill/tool 不再只回显 `name (id)`，而是携带 icon /
	//   description / 分类 / 技能·工具数徽章，选项渲染成富卡片（对齐 ComfyUI
	//   节点搜索框的选项信息密度）。filtered/current 仍按 value+label 匹配。
	const options = React.useMemo(() => {
		if (field.kind === 'agent') {
			return agents.map(a => ({
				value: a.id,
				label: a.name ?? a.id,
				id: a.id,
				icon: a.icon || '🤖',
				description: a.description || '',
				category: a.category,
				skills: a.skills?.length ?? 0,
				tools: a.tools?.length ?? 0,
			}));
		}
		if (field.kind === 'tool') {
			return tools.map(t => ({
				value: t.id,
				label: t.name,
				id: t.id,
				icon: '🔧',
				description: t.description || '',
			}));
		}
		return skills.map(s => ({
			value: s.id,
			label: s.name ?? s.id,
			id: s.id,
			icon: '⚡',
			description: s.description || '',
			category: s.category || s.activation,
		}));
	}, [field.kind, agents, skills, tools]);
	const [open, setOpen] = React.useState(false);
	const [query, setQuery] = React.useState('');
	const wrapRef = React.useRef<HTMLDivElement | null>(null);

	// Close on outside click / Escape.
	React.useEffect(() => {
		if (!open) { return; }
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) { setOpen(false); }
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { setOpen(false); }
		};
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);

	const current = options.find(o => o.value === value);
	const q = query.trim().toLowerCase();
	const filtered = q
		? options.filter(o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
		: options;

	return (
		<div ref={wrapRef} style={{ position: 'relative' }}>
			<label style={labelStyle}>{field.label}</label>
			<button
				type="button"
				onClick={() => { setOpen(o => !o); setQuery(''); }}
				style={{
					...inputStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
					gap: 6, cursor: 'pointer', textAlign: 'left',
				}}
			>
				<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, display: 'flex', alignItems: 'center', gap: 5 }}>
					{current?.icon && <span style={{ fontSize: 13, flexShrink: 0 }}>{current.icon}</span>}
					<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
						{current?.label ?? (value || field.placeholder || '请选择…')}
					</span>
				</span>
				<span style={{ opacity: .55, fontSize: 9 }}>▾</span>
			</button>
			{open && (
				<div
					style={{
						position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 60, marginTop: 2,
						background: 'var(--vscode-dropdown-background, #252526)',
						border: '1px solid var(--vscode-input-border)', borderRadius: 4,
						boxShadow: '0 6px 18px rgba(0,0,0,.5)', overflow: 'hidden',
					}}
				>
					<input
						autoFocus
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder="过滤…"
						style={{ ...inputStyle, border: 'none', borderBottom: '1px solid var(--vscode-input-border)', borderRadius: 0 }}
					/>
					<div style={{ maxHeight: 240, overflowY: 'auto' }}>
						{filtered.length === 0 && (
							<div style={{ padding: '6px 8px', fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>无匹配项</div>
						)}
						{filtered.map(o => {
							const selected = o.value === value;
							return (
								<div
									key={o.value}
									onClick={() => { onChange(o.value); setOpen(false); }}
									onMouseEnter={e => { e.currentTarget.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,.08))'; }}
									onMouseLeave={e => { e.currentTarget.style.background = selected ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,.08))' : 'transparent'; }}
									style={{
										display: 'flex', gap: 8, alignItems: 'flex-start',
										padding: '6px 8px', fontSize: 11, cursor: 'pointer',
										background: selected ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,.08))' : 'transparent',
										color: 'var(--vscode-foreground)',
										borderRadius: 3,
									}}
								>
									<span style={{ fontSize: 15, width: 20, textAlign: 'center', flexShrink: 0, lineHeight: 1.3 }}>{o.icon}</span>
									<div style={{ flex: 1, minWidth: 0 }}>
										<div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
											<span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
											{o.id && o.id !== o.label && (
												<span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)', fontFamily: 'Consolas, monospace', flexShrink: 0 }}>{o.id}</span>
											)}
										</div>
										{o.description && (
											<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginTop: 2, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
												{o.description}
											</div>
										)}
										{(o.category || o.skills != null || o.tools != null) && (
											<div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
												{o.category && <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: 'rgba(0,122,204,.18)', color: '#79b8ff' }}>{o.category}</span>}
												{o.skills != null && o.skills > 0 && <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: 'rgba(255,255,255,.07)', color: 'var(--vscode-descriptionForeground)' }}>{o.skills} 技能</span>}
												{o.tools != null && o.tools > 0 && <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: 'rgba(255,255,255,.07)', color: 'var(--vscode-descriptionForeground)' }}>{o.tools} 工具</span>}
											</div>
										)}
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
