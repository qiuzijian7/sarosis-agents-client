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
// ★ Loop/Parallel body 递归执行需要 runNodeOrStage——与 workflowRun.ts 构成循环依赖，
//   但调用发生在运行时（非模块初始化期）+ 函数声明提升 → esbuild bundle 下安全。
import { runNodeOrStage } from './workflowRun.js';
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
	AskUserParam,
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

// ★ 编排节点执行器（agent/skill/tool/askUser/prompt/gate/merge/end/loop）。

function resolveUpstreamSnapshotText(store: MediaSnapshotStore, upstreams: string[] | undefined): string {
	for (const up of upstreams ?? []) {
		const entries = store.byNode(up);
		if (entries.length === 0) { continue; }
		const m = entries[0].media;
		if (m.meta?.['sarosJson'] === '1' || m.meta?.['sarosJson'] === 1) {
			return m.ref; // ref 已是 JSON 串
		}
		if (m.kind === 'text') { return m.ref; }
	}
	return '';
}

/**
 * M3: `Saros.Agent` node executor. Prompt = node's `prompt` value with
 * `{{input}}` replaced by the first upstream SAROS_JSON/TEXT snapshot
 * (JSON-stringified); the subagent's final text is archived as a
 * `{kind:'text', meta.sarosJson:'1'}` snapshot so downstream nodes and the
 * M2 nodeOutput() bridge read the same value under the same key system.
 */
export async function runAgentNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, type, values, upstreams, store, onProgress, signal, runAgentNode } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	if (!runAgentNode) {
		return { ...empty, error: '画布未连接 Agent 执行通道（runAgentNode 未注入）' };
	}
	const node = (input.nodes ?? []).find(n => n.id === nodeId);
	void node;
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	const template = typeof values.prompt === 'string' ? values.prompt : '';
	// W1/W4: {{input}} + {{args.*}} + {{label.field}}；无占位符时上游 JSON 附在尾部（兼容）
	const prompt = template.includes('{{')
		? resolveTemplateVars(template, { input: upstreamJson, args: input.args, named: input.resolveNamed })
		: (template + (upstreamJson ? `\n\n上游输出：\n${upstreamJson}` : ''));
	if (!prompt.trim()) {
		return { ...empty, error: 'Saros.Agent 节点缺少提示词（编辑节点填写 prompt，或连接上游输入）' };
	}
	const agentCfg = (values.agentConfig as { modelId?: string } | undefined) ?? {};
	const agentId = typeof values.agentId === 'string' && values.agentId ? values.agentId : undefined;
	const model = agentCfg.modelId ? agentCfg.modelId : undefined;
	const label = (input.nodes ?? []).find(n => n.id === nodeId)?.data?.label ?? type;
	onProgress?.({ progress: 15 });
	try {
		const r = await runAgentNode({ prompt, ...(agentId ? { agentId } : {}), ...(model ? { model } : {}), label }, 600_000);
		signal?.throwIfAborted();
		onProgress?.({ progress: 90 });
		if (!r.ok) {
			return { ...empty, error: r.error ?? 'Agent 子代理执行失败' };
		}
		const snapKey = input.snapshotKey ?? nodeId;
		const ref = JSON.stringify({ output: r.output ?? '' });
		const entry: MediaSnapshotEntry = {
			nodeId: snapKey,
			port: 'output',
			key: `${snapKey}:output:0`,
			index: 0,
			media: { kind: 'text', ref, meta: { sarosJson: '1', mime: 'application/json', agentNode: '1' } },
		};
		store.put(entry, true);
		return { promptId: '', status: 'success', entries: [entry] };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * P0: `Saros.Skill` node executor —— 让子代理（默认 saros-claw）加载并执行
 * 指定技能。复用 runAgentNode 通道（workflow.runAgentNode RPC），零新增 RPC。
 * prompt = 「请使用技能 X 执行任务」+ 技能参数（skillArgs 内 {{input}}/{{args.*}}
 * 已解析）+ 上游输入。归档 meta.skillNode='1'。
 */
export async function runSkillNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, store, onProgress, signal, runAgentNode } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	if (!runAgentNode) {
		return { ...empty, error: '画布未连接 Agent 执行通道（runAgentNode 未注入）' };
	}
	const skillName = typeof values.skillName === 'string' ? values.skillName.trim() : '';
	if (!skillName) {
		return { ...empty, error: 'Saros.Skill 节点缺少技能名（编辑节点选择 Skill）' };
	}
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	const argsRaw = typeof values.skillArgs === 'string' ? values.skillArgs : '{}';
	const argsText = argsRaw.includes('{{')
		? resolveTemplateVars(argsRaw, { input: upstreamJson, args: input.args, named: input.resolveNamed })
		: argsRaw;
	const taskHint = typeof values.task === 'string' && values.task.trim() ? values.task.trim() : '';
	const prompt = [
		`请使用技能「${skillName}」执行任务。`,
		taskHint ? `任务说明：${taskHint}` : '',
		`技能参数：\n${argsText}`,
		upstreamJson && !argsRaw.includes('{{input}}') ? `\n\n上游输入：\n${upstreamJson}` : '',
	].filter(Boolean).join('\n');
	const label = (input.nodes ?? []).find(n => n.id === nodeId)?.data?.label ?? 'Saros.Skill';
	onProgress?.({ progress: 15 });
	try {
		const r = await runAgentNode({ prompt, label }, 600_000);
		signal?.throwIfAborted();
		onProgress?.({ progress: 90 });
		if (!r.ok) {
			return { ...empty, error: r.error ?? '技能执行失败' };
		}
		const snapKey = input.snapshotKey ?? nodeId;
		const entry: MediaSnapshotEntry = {
			nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, index: 0,
			media: { kind: 'text', ref: JSON.stringify({ output: r.output ?? '' }), meta: { sarosJson: '1', mime: 'application/json', skillNode: '1' } },
		};
		store.put(entry, true);
		return { promptId: '', status: 'success', entries: [entry] };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * P0: `Saros.Tool` node executor —— 让子代理调用指定工具并返回结果（复用
 * runAgentNode 通道，零新增 RPC）。prompt = 「请调用工具 X」+ 参数 JSON +
 * 上游输入；明确要求只返回工具执行结果、不加额外说明。归档 meta.toolNode='1'。
 */
export async function runToolNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, store, onProgress, signal, runAgentNode } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	if (!runAgentNode) {
		return { ...empty, error: '画布未连接 Agent 执行通道（runAgentNode 未注入）' };
	}
	const toolName = typeof values.toolName === 'string' ? values.toolName.trim() : '';
	if (!toolName) {
		return { ...empty, error: 'Saros.Tool 节点缺少工具名（编辑节点填写 Tool 名称）' };
	}
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	const paramsRaw = typeof values.toolParams === 'string' ? values.toolParams : '{}';
	const paramsText = paramsRaw.includes('{{')
		? resolveTemplateVars(paramsRaw, { input: upstreamJson, args: input.args, named: input.resolveNamed })
		: paramsRaw;
	const prompt = [
		`请调用工具「${toolName}」，参数如下，直接执行并返回工具结果，不要添加额外说明。`,
		`工具参数：\n${paramsText}`,
		upstreamJson && !paramsRaw.includes('{{input}}') ? `\n\n上游输入：\n${upstreamJson}` : '',
	].filter(Boolean).join('\n');
	const label = (input.nodes ?? []).find(n => n.id === nodeId)?.data?.label ?? 'Saros.Tool';
	onProgress?.({ progress: 15 });
	try {
		const r = await runAgentNode({ prompt, label }, 600_000);
		signal?.throwIfAborted();
		onProgress?.({ progress: 90 });
		if (!r.ok) {
			return { ...empty, error: r.error ?? '工具调用失败' };
		}
		const snapKey = input.snapshotKey ?? nodeId;
		const entry: MediaSnapshotEntry = {
			nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, index: 0,
			media: { kind: 'text', ref: JSON.stringify({ output: r.output ?? '' }), meta: { sarosJson: '1', mime: 'application/json', toolNode: '1' } },
		};
		store.put(entry, true);
		return { promptId: '', status: 'success', entries: [entry] };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * P1: `Saros.AskUser` 交互节点 executor。暂停图执行，弹窗收集用户选择
 * （renderer 侧 askUser 回调，返回 string 或 string[]），结果归档为
 * `{answer}` SAROS_JSON 快照（meta.askUserNode='1'）。question/options 内
 * {{input}}/{{args.*}} 已解析。
 */
export async function runAskUserNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, store, onProgress, signal, askUser } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	if (!askUser) {
		return { ...empty, error: '画布未连接 AskUser 交互通道（askUser 未注入）' };
	}
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	let question = typeof values.questionText === 'string' && values.questionText.trim() ? values.questionText : '请选择';
	if (question.includes('{{')) {
		question = resolveTemplateVars(question, { input: upstreamJson, args: input.args, named: input.resolveNamed });
	}
	// options：数组或 JSON 字符串（[{label, description}]）
	let options: Array<{ label: string; description?: string }> = [];
	const rawOptions = values.options;
	if (Array.isArray(rawOptions)) {
		options = (rawOptions as unknown[]).map(o => {
			const oo = o as { label?: string; description?: string };
			return { label: String(oo?.label ?? ''), ...(oo?.description ? { description: String(oo.description) } : {}) };
		}).filter(o => o.label);
	} else if (typeof rawOptions === 'string' && rawOptions.trim()) {
		try {
			const arr: unknown = JSON.parse(rawOptions);
			if (Array.isArray(arr)) {
				options = (arr as Array<{ label?: string; description?: string }>).map(o => ({ label: String(o?.label ?? ''), ...(o?.description ? { description: String(o.description) } : {}) })).filter(o => o.label);
			}
		} catch {
			return { ...empty, error: 'AskUser 选项不是合法 JSON 数组' };
		}
	}
	if (options.length === 0) {
		// ★ params 模式下选项可空（卡片渲染输入框而非选项按钮）
		const hasParams = typeof values.params === 'string' && values.params.trim() && values.params.trim() !== '[]';
		if (!hasParams) {
			return { ...empty, error: 'AskUser 节点缺少选项（编辑节点填写 options，或配置 params 动态参数）' };
		}
	}
	// ★ 动态参数表单（params widget，JSON 数组 [{key,label,type?}]）：非空时
	//   交互卡片渲染输入框，用户填写后以 Record<key,value> 反馈（answer = 键值对象），
	//   下游经 SAROS_JSON 快照消费。非法 JSON → 明确报错（与 options 惯例一致）。
	let params: AskUserParam[] | undefined;
	const rawParams = values.params;
	if (typeof rawParams === 'string' && rawParams.trim() && rawParams.trim() !== '[]') {
		try {
			const arr: unknown = JSON.parse(rawParams);
			if (!Array.isArray(arr)) {
				return { ...empty, error: 'AskUser params 不是合法 JSON 数组' };
			}
			params = (arr as Array<{ key?: unknown; label?: unknown; type?: unknown }>)
				.map(p => ({
					key: String(p?.key ?? '').trim(),
					label: String(p?.label ?? '').trim(),
					// ★ image 加入白名单（2026-09-10）：此前只认 number/textarea，
					//   其余一律归一 text —— image 字段会退化成文本框，用户无法上传参考图。
					type: (p?.type === 'number' || p?.type === 'textarea' || p?.type === 'image' ? p.type : 'text') as AskUserParam['type'],
				}))
				.filter(p => p.key)
				.map(p => ({ key: p.key, label: p.label || p.key, type: p.type }));
			if (params.length === 0) { params = undefined; }
		} catch {
			return { ...empty, error: 'AskUser params 不是合法 JSON 数组' };
		}
	}
	const multiSelect = values.multiSelect === 'yes' || values.multiSelect === true;
	onProgress?.({ progress: 30 });
	try {
		const answer = await askUser(
			params ? { nodeId, question, options, multiSelect, params } : { nodeId, question, options, multiSelect },
			600_000,
		);
		signal?.throwIfAborted();
		onProgress?.({ progress: 95 });
		const snapKey = input.snapshotKey ?? nodeId;
		// params 模式 answer 是键值对象（跳过 = 空对象）；选项模式是 string/string[]。
		// 两者都以 JSON 文本落快照（SAROS_JSON），下游 {{input}}/Agent 消费语义不变。
		const answerValue: unknown = (answer && typeof answer === 'object' && !Array.isArray(answer))
			? answer
			: answer;
		const entry: MediaSnapshotEntry = {
			nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, index: 0,
			media: { kind: 'text', ref: JSON.stringify({ answer: answerValue }), meta: { sarosJson: '1', mime: 'application/json', askUserNode: '1' } },
		};
		store.put(entry, true);
		return { promptId: '', status: 'success', entries: [entry] };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * M3: `Saros.Prompt` node executor — pure text materialization (no backend
 * call). The widget text with `{{input}}` substituted by the first upstream
 * snapshot lands as a TEXT snapshot; downstream Agent / media nodes read it
 * through the same key system.
 */
export async function runPromptNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, store } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const template = typeof values.prompt === 'string' ? values.prompt : '';
	if (!template.trim()) {
		return { ...empty, error: 'Saros.Prompt 节点缺少文本（编辑节点填写 prompt）' };
	}
	const upstreamText = resolveUpstreamSnapshotText(store, upstreams);
	// P0: 解析 variables 局部变量，合并进命名空间（{{变量名}} 可引用）。
	//   W1/W4: {{input}} + {{args.*}} + {{label.field}}；无占位符时原样（纯静态文本）
	const variables = resolvePromptVariables(values.variables, { input: upstreamText, args: input.args, named: input.resolveNamed });
	const named = makeNamedWithVariables(variables, input.resolveNamed);
	const text = template.includes('{{')
		? resolveTemplateVars(template, { input: upstreamText, args: input.args, named })
		: template;
	// P2b: 检测未解析占位符（引用不存在的 label / args 路径 / input 路径 / 变量）。
	//   非阻断：物化文本原样保留（兼容「延迟解析」给下游 Agent 的语义），但
	//   ① console.warn 供 devtools 排查；② meta.unresolvedPlaceholders 标记供卡片
	//   展示 warning（区别于「一切正常」的纯 promptNode 快照）。
	const unresolved = findUnresolvedPlaceholders(text);
	if (unresolved.length > 0) {
		// eslint-disable-next-line no-console
		console.warn(`[Saros.Prompt] nodeId=${nodeId} 未解析占位符: ${unresolved.map(u => `{{${u}}}`).join(', ')}`);
	}
	const snapKey = input.snapshotKey ?? nodeId;
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: {
			kind: 'text',
			ref: text,
			meta: { promptNode: '1', ...(unresolved.length > 0 ? { unresolvedPlaceholders: unresolved } : {}) },
		},
	};
	store.put(entry, true);
	return { promptId: '', status: 'success', entries: [entry] };
}

/**
 * M3→W2: `Saros.IfElse` / `Saros.Switch` gate-node executor. Reads the upstream
 * SAROS_JSON and evaluates the `evaluationTarget` dot-path for truthiness,
 * then archives `{verdict, branch, value}` as a SAROS_JSON snapshot.
 *
 * W2 端口感知路由：结果带 `branch`（'true'/'false'）返回给调度器——出边
 * sourceHandle 与 branch 匹配才激活（真路由，不匹配分支不再执行）；
 * verdict 快照行为保留（旧模板 `{{input}}.verdict` 兼容）。
 * W2b: Switch 多 case——widget `cases`（JSON 数组或逗号分隔，≤4 路）定义每路
 * 匹配值；probe 的 String 值命中第 i 路 → branch='case-i'，无命中 → 'default'。
 */
export async function runGateNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, type, values, upstreams, store } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	if (!upstreamJson) {
		return { ...empty, error: 'IfElse/Switch 节点无上游输出（请先运行上游节点）' };
	}
	let parsed: unknown;
	try { parsed = JSON.parse(upstreamJson); } catch {
		return { ...empty, error: 'IfElse/Switch 上游输出不是合法 JSON（上游应为 SAROS_JSON 节点）' };
	}
	let target = typeof values.evaluationTarget === 'string' ? values.evaluationTarget.trim() : '';
	// 兼容两种写法：裸点路径 `value` / `a.b.c`，或模板写法 `{{input.value}}`。
	// （旧 placeholder 误导用户填 {{input.value}}，此处 strip 前缀让两种都可用。）
	if (target === '{{input}}') { target = ''; }
	else if (target.startsWith('{{input.')) { target = target.slice('{{input.'.length).replace(/}}$/, ''); }
	// 点路径求值（a.b.c）；空路径 = 直接对上游值本身做 truthy 判定。
	let probe: unknown = parsed;
	if (target) {
		for (const seg of target.split('.')) {
			if (typeof probe !== 'object' || probe === null) { probe = undefined; break; }
			probe = (probe as Record<string, unknown>)[seg];
		}
	}
	const verdict = Boolean(probe);
	let branch = verdict ? 'true' : 'false';
	if (type === 'Saros.Switch') {
		// W2b: 解析 cases（JSON 数组或逗号分隔）→ String(probe) 精确匹配第 i 路
		const rawCases = values.cases;
		let cases: string[] = [];
		if (typeof rawCases === 'string' && rawCases.trim()) {
			try {
				const arr = JSON.parse(rawCases) as unknown;
				cases = Array.isArray(arr) ? arr.map(String) : String(arr).split(',').map(s => s.trim());
			} catch {
				cases = rawCases.split(',').map(s => s.trim());
			}
		} else if (Array.isArray(rawCases)) {
			cases = (rawCases as unknown[]).map(String);
		}
		const hit = cases.findIndex(c => c === String(probe));
		branch = hit >= 0 && hit < 4 ? `case-${hit + 1}` : 'default';
	}
	const snapKey = input.snapshotKey ?? nodeId;
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: {
			kind: 'text',
			ref: JSON.stringify({ verdict, branch, value: parsed, ...(type.includes('Switch') ? { nodeType: type } : {}) }),
			meta: { sarosJson: '1', mime: 'application/json', gateNode: '1' },
		},
	};
	store.put(entry, true);
	// W2/W2b 真路由：IfElse 与 Switch（case-N/default）都把 branch 交给调度器做端口激活
	return { promptId: '', status: 'success', entries: [entry], branch };
}

/**
 * W3/W3b: `Saros.Merge` 汇聚节点。按入边 targetHandle 分桶读取各上游快照
 * （无 handle 兼容：按 upstreams 顺序 inA/inB）。widget `mode`：
 *   all   → 聚合 `{inA, inB}`（桶可为 null=分支未激活，模板可判空）
 *   any   → 首个非空桶值直接透传（OR 合流；全空 → null）
 *   order → `[inA, inB]` 数组（null 占位保持端口下标对齐）
 */
export async function runMergeNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, inbound, store } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const readSnapshot = (id: string | undefined): unknown => {
		if (!id) { return null; }
		const text = resolveUpstreamSnapshotText(store, [id]);
		if (!text) { return null; }
		try { return JSON.parse(text); } catch { return text; }
	};
	let inA: unknown;
	let inB: unknown;
	if (inbound && inbound.length > 0) {
		inA = readSnapshot(inbound.find(e => e.targetHandle === 'inA')?.source);
		inB = readSnapshot(inbound.find(e => e.targetHandle === 'inB')?.source);
	} else {
		inA = readSnapshot(upstreams?.[0]);
		inB = readSnapshot(upstreams?.[1]);
	}
	const mode = values.mode === 'any' || values.mode === 'order' ? values.mode : 'all';
	let out: unknown;
	if (mode === 'any') {
		out = inA ?? inB ?? null;
	} else if (mode === 'order') {
		out = [inA, inB];
	} else {
		out = { inA, inB };
	}
	const snapKey = input.snapshotKey ?? nodeId;
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: {
			kind: 'text',
			ref: JSON.stringify(out),
			meta: { sarosJson: '1', mime: 'application/json', mergeNode: '1', mergeMode: mode },
		},
	};
	store.put(entry, true);
	return { promptId: '', status: 'success', entries: [entry] };
}

/**
 * P0: `Saros.End` 工作流输出标记。透传上游快照（JSON 原文）并归档到自身，
 * meta.endNode='1' 标记为图最终输出。无输出端口——语义是「最终返回 = 本快照」，
 * 宿主/调用方读 GraphRunResult 后据此取结果。
 */
export async function runEndNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, upstreams, store } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	if (!upstreamJson) {
		return { ...empty, error: 'End 节点无上游输出（请先连接上游节点）' };
	}
	const snapKey = input.snapshotKey ?? nodeId;
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: { kind: 'text', ref: upstreamJson, meta: { sarosJson: '1', mime: 'application/json', endNode: '1' } },
	};
	store.put(entry, true);
	return { promptId: '', status: 'success', entries: [entry] };
}

/**
 * W5: `Saros.Loop` / `Saros.Parallel` 迭代子图容器执行器。
 *
 * body 存 `data.loopBody`（SubflowDefinition 同构；刻意**不走 flattenSubflows**——
 * 这是执行时语义容器，展平会导致 body 节点在主 plan 里重复执行）。
 *
 * 语义：
 *   * items = widget `items`（JSON 数组）或 `{{input}}` 时取上游数组快照；
 *   * 每个 item：当前项写入 `${snapKey}:item:${idx}` 快照 → body entry 节点
 *     的 `{{input}}` 读到它；body 按拓扑序逐节点 runNodeOrStage（迭代键
 *     `${id}#it${idx}`，不污染主图同名节点快照史）；
 *   * 失败 item → null 并继续（对齐脚本域 parallel() 的 null 语义）；
 *   * 输出 = `{iterations: [exitOutputs], failed: n}` 归档到 Loop 节点；
 *   * Loop=串行逐项；Parallel=简单并发池（concurrency widget，1–16）。
 */
export async function runLoopNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, type, values, upstreams, store, nodes } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const loopNode = nodes?.find(n => n.id === nodeId);
	const body = (loopNode?.data as Record<string, unknown> | undefined)?.loopBody as SubflowDefinition | undefined;
	if (!body || !Array.isArray(body.nodes) || body.nodes.length === 0) {
		return { ...empty, error: 'Loop/Parallel 节点缺少循环体（data.loopBody，可经画布「封装」操作生成）' };
	}
	// items 解析：widget JSON 数组 > {{input}} 上游数组快照
	let items: unknown[] = [];
	const rawItems = values.items;
	if (typeof rawItems === 'string' && rawItems.trim() && rawItems.trim() !== '{{input}}') {
		try {
			const arr: unknown = JSON.parse(rawItems);
			items = Array.isArray(arr) ? arr : [arr];
		} catch {
			return { ...empty, error: `items 不是合法 JSON 数组：${String(rawItems).slice(0, 64)}` };
		}
	} else {
		const up = resolveUpstreamSnapshotText(store, upstreams);
		if (up) {
			try { const arr: unknown = JSON.parse(up); items = Array.isArray(arr) ? arr : [up]; } catch { items = [up]; }
		}
	}
	if (items.length === 0) {
		const entry0: MediaSnapshotEntry = { nodeId: input.snapshotKey ?? nodeId, port: 'output', key: `${input.snapshotKey ?? nodeId}:output:0`, index: 0, media: { kind: 'text', ref: JSON.stringify({ iterations: [], failed: 0 }), meta: { sarosJson: '1', mime: 'application/json', loopNode: '1', empty: '1' } } };
		store.put(entry0, true);
		return { promptId: '', status: 'success', entries: [entry0] };
	}
	const mode = type === 'Saros.Parallel' ? 'parallel' : 'serial';
	const conc = Math.max(1, Math.min(16, Number(values.concurrency) || (mode === 'parallel' ? 4 : 1)));
	const snapKey = input.snapshotKey ?? nodeId;
	const order = computeExecutionOrder(body.nodes as ExecutionNodeLike[], body.edges as ExecutionEdgeLike[]).order;
	const entryIds = new Set(body.entryIds ?? []);
	const exitId = body.exitIds?.[0] ?? order[order.length - 1];

	const runItem = async (item: unknown, idx: number): Promise<unknown> => {
		// 当前项快照：body entry 节点 {{input}} 的数据源
		store.put({ nodeId: `${snapKey}:item:${idx}`, port: 'output', key: `${snapKey}:item:${idx}:output:0`, index: 0, media: { kind: 'text', ref: JSON.stringify(item), meta: { sarosJson: '1', loopItem: '1' } } }, true);
		const keyOf = (id: string) => `${id}#it${idx}`;
		for (const id of order) {
			const bn = body.nodes.find(n => n.id === id);
			if (!bn) { continue; }
			const ups = [
				...(entryIds.has(id) ? [`${snapKey}:item:${idx}`] : []),
				...body.edges.filter(e => e.target === id).map(e => keyOf(e.source)),
			];
			const r = await runNodeOrStage({
				...input,
				nodeId: id,
				type: bn.type,
				snapshotKey: keyOf(id),
				values: bn.data ?? {},
				upstreams: ups,
				inbound: body.edges.filter(e => e.target === id).map(e => ({ source: keyOf(e.source), targetHandle: e.targetHandle })),
				nodes: body.nodes,
				onProgress: undefined, // 迭代内进度不冒泡到主卡片
			}).catch(() => null); // 迭代内异常也按失败处理（null 语义）
			if (!r || r.status !== 'success') { return null; }
		}
		const text = resolveUpstreamSnapshotText(store, [keyOf(exitId)]);
		if (!text) { return null; }
		try { return JSON.parse(text); } catch { return text; }
	};

	const iterations: Array<unknown> = new Array(items.length).fill(null);
	let failed = 0;
	if (mode === 'serial') {
		for (let i = 0; i < items.length; i++) {
			if (input.signal?.aborted) { break; }
			iterations[i] = await runItem(items[i], i);
			if (iterations[i] === null) { failed++; }
			input.onProgress?.(Math.round(((i + 1) / items.length) * 100), `迭代 ${i + 1}/${items.length}`);
		}
	} else {
		// 简单并发池（concurrency 上限）
		let next = 0;
		const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
			for (;;) {
				const i = next++;
				if (i >= items.length) { return; }
				if (input.signal?.aborted) { return; }
				iterations[i] = await runItem(items[i], i);
				if (iterations[i] === null) { failed++; }
			}
		});
		await Promise.all(workers);
	}
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: {
			kind: 'text',
			ref: JSON.stringify({ iterations, failed }),
			meta: { sarosJson: '1', mime: 'application/json', loopNode: '1', loopMode: mode, itemCount: items.length },
		},
	};
	store.put(entry, true);
	return { promptId: '', status: 'success', entries: [entry] };
}

/* ==================================================================== *
 * EmojiStage —— m×n 表情包网格循环调度
 * ==================================================================== */

/** 静态网格表情节点（透明贴纸 m×n）：原 EmojiStage 的静态能力继承者。 */
