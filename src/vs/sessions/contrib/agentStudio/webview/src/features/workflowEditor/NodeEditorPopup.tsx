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
import { getNodeSpec } from './comfyHost/registry';
import { buildEditorFields, coerceEditorValue, buildSarosisEditorFields, sarosisDataToValues, sarosisValuesToData, type EditorField } from './comfyHost/nodeEditorForm';
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
import { sendRequest } from '../../bridge/messageClient';
import { useProviderStore, type ProviderInfo } from '../../store/useProviderStore';
import { useAgentStore } from '../../store/useAgentStore';
import { usePicklistStore } from './picklistStore';

/** ComfyUI 作为文生图 provider 的特殊 id（不选 model）。 */
export const COMFY_IMAGE_PROVIDER_ID = 'comfyui';

/** 判定该 schema 节点是否为文生图类（ImageStage / ImageBatchStage 等）。 */
export function isImageGenStage(spec: { kind?: string; comfyTV?: { stageKind?: string } } | undefined, nodeType: string): boolean {
	// Provider 文生图节点（kind='llm'，如 Sarosis.ModelImageGen）固定走 imagegen RPC。
	if (spec?.kind === 'llm') { return true; }
	if (spec?.kind !== 'schema') { return false; }
	const kind = spec.comfyTV?.stageKind ?? nodeType;
	return kind === 'image' || kind === 'image-batch';
}

export interface NodeEditorPopupProps {
	nodeId: string;
	nodeType: string;
	runners: ComfyRunnerRegistry;
	store: MediaSnapshotStore;
	/** card execution state store (cards under nodes re-render on run) */
	cardStateStore?: CardStateStore;
	/** current runner preference ('auto' | 'local' | 'remote:<id>') */
	preference?: string;
	/** persist coerced form values so the workflow Run button reuses them */
	onValuesCommit?: (nodeId: string, values: Record<string, unknown>) => void;
	/** persisted node.data for Sarosis (react) nodes — initial form values */
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

export function NodeEditorPopup({
	nodeId,
	nodeType,
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
	const spec = getNodeSpec(nodeType);
	const fields = React.useMemo(() => buildEditorFields(spec), [spec]);
	// Sarosis (react) orchestration nodes: parameter-only popup, no Comfy run.
	const isReactNode = spec?.kind === 'react';
	const reactFields = React.useMemo(() => (isReactNode ? buildSarosisEditorFields(nodeType) : []), [isReactNode, nodeType]);
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
	const fileRef = React.useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = React.useState(false);

	// P3 Relight: persist the light-ball state + register the uploaded render.
	const handleRelightChange = React.useCallback((lightsJson: string, prompt: string) => {
		onValuesCommit?.(nodeId, { lights_data: lightsJson, main_prompt: prompt });
	}, [nodeId, onValuesCommit]);

	const handleRelightRender = React.useCallback((url: string | null) => {
		if (!url) { return; }
		store.put({
			nodeId,
			port: 'output',
			key: `${nodeId}:output:0`,
			media: { kind: 'image', ref: url },
			index: 0,
		});
		onValuesCommit?.(nodeId, { light_render_url: url });
		cardStateStore?.set(nodeId, { runState: 'success', progress: 100 });
	}, [nodeId, store, onValuesCommit, cardStateStore]);

	// P3 Poster: persist the layout blob + register the composed render.
	const handlePosterLayout = React.useCallback((layoutJson: string) => {
		onValuesCommit?.(nodeId, { layout: layoutJson });
	}, [nodeId, onValuesCommit]);

	const handlePosterRender = React.useCallback((url: string | null) => {
		if (!url) { return; }
		store.put({
			nodeId,
			port: 'output',
			key: `${nodeId}:output:0`,
			media: { kind: 'image', ref: url },
			index: 0,
		});
		cardStateStore?.set(nodeId, { runState: 'success', progress: 100 });
	}, [nodeId, store, cardStateStore]);

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
			nodeId,
			port: 'output',
			key: `${nodeId}:output:0`,
			media: { kind: 'image', ref: url },
			index: 0,
		});
		cardStateStore?.set(nodeId, { runState: 'success', progress: 100 });
	}, [nodeId, store, cardStateStore]);

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
	const [values, setValues] = React.useState<Record<string, unknown>>(() => {
		const init: Record<string, unknown> = {};
		for (const f of fields) { init[f.key] = f.defaultValue; }
		// Sarosis nodes: seed the form from the persisted node.data.
		if (isReactNode && initialData) {
			Object.assign(init, sarosisDataToValues(nodeType, initialData));
		}
		return init;
	});
	const [state, setState] = React.useState<RunState>('idle');
	const [result, setResult] = React.useState<SingleNodeRunResult | null>(null);

	// live refresh when a snapshot lands for this node (generation completes)
	const preview = useMediaSnapshotRef(store, primarySnapshotKey(nodeId));

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

	// Provider (llm) 文生图节点不能选 ComfyUI —— 自动选中第一个 imagegen provider。
	React.useEffect(() => {
		if (spec?.kind === 'llm' && imageGenProviderId === COMFY_IMAGE_PROVIDER_ID && imageGenProviders.length > 0) {
			handleImageGenProviderChange(imageGenProviders[0].id);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [spec?.kind, imageGenProviderId, imageGenProviders]);

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
		// kind='llm'（如 Sarosis.ModelImageGen）固定走 provider，不允许回退 ComfyUI。
		if (isImageGen && (spec?.kind === 'llm' || imageGenProviderId !== COMFY_IMAGE_PROVIDER_ID)) {
			const r = await runProviderImage({
				runner: runners.resolve(preference)!,
				nodeId,
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
			const entry = { nodeId, port: 'output', key: `${nodeId}:output:0`, media: { kind: loaderMediaKind(nodeType), ref }, index: 0 };
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
				maxHeight: 'calc(100% - 80px)', overflowY: 'auto',
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

				{/* P3 Poster: embedded layout editor */}
				{isPoster && (
					<PosterEditor
						initialLayout={typeof values.layout === 'string' ? values.layout : ''}
						images={posterImages}
						runners={runners}
						preference={preference}
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

				{/* Generic form (non picker/loader/relight/poster/cornerpin/roto/layereditor/storyboard/material/scene3d) */}
				{!isPicker && !isLoader && !isRelight && !isPoster && !isCornerPin && !isRotoMask && !isLayerEditor && !isStoryboard && !isMaterial && !isScene3D && (
					<>
						{fields.length === 0 && !isReactNode && (
							<div style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 11 }}>
								该节点没有可编辑参数（动态上游端口）。
							</div>
						)}
						{fields.map(f => <FieldEditor key={f.key} field={f} value={values[f.key]} providerId={String(values.providerId ?? '')} onChange={v => setField(f.key, v)} />)}
					</>
				)}

				{/* Runner status / action */}
				{!isPicker && !isLoader && !isRelight && !isPoster && !isCornerPin && !isRotoMask && !isLayerEditor && !isStoryboard && !isMaterial && !isScene3D && (
					<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
						{isReactNode ? (
							<button
								onClick={() => {
									onValuesCommit?.(nodeId, sarosisValuesToData(nodeType, values));
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

function FieldEditor({ field, value, onChange, providerId }: { field: EditorField; value: unknown; onChange: (v: unknown) => void; providerId?: string }): React.JSX.Element {
	const labelStyle: React.CSSProperties = { fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginBottom: 2, display: 'block' };
	const inputStyle: React.CSSProperties = {
		width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: 11,
		background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)',
		border: '1px solid var(--vscode-input-border)', borderRadius: 4,
		fontFamily: 'inherit', outline: 'none',
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

	if (field.kind === 'agent' || field.kind === 'skill') {
		return <SearchableSelect
			field={field}
			value={String(value ?? '')}
			onChange={onChange}
			labelStyle={labelStyle}
			inputStyle={inputStyle}
		/>;
	}

	if (field.kind === 'textarea') {
		return (
			<div>
				<label style={labelStyle}>{field.label}</label>
				<textarea
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
	const options = React.useMemo(() => {
		if (field.kind === 'agent') {
			return agents.map(a => ({ value: a.id, label: `${a.name ?? a.id} (${a.id})` }));
		}
		return skills.map(s => ({ value: s.id, label: `${s.name ?? s.id} (${s.id})` }));
	}, [field.kind, agents, skills]);
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
				<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
					{current?.label ?? (value || field.placeholder || '请选择…')}
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
					<div style={{ maxHeight: 180, overflowY: 'auto' }}>
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
										padding: '5px 8px', fontSize: 11, cursor: 'pointer',
										background: selected ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,.08))' : 'transparent',
										color: 'var(--vscode-foreground)',
										overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
									}}
								>
									{o.label}
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
