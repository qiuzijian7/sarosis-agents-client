/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentChatService } from '../common/agentStudio.js';
import { IWorkflowStorageService, IStoredWorkflow, WorkflowNodeType, WorkflowGraphNode } from '../common/workflowStorage.js';
import type { IComfyExecutionDelegate, ComfyExecutionInput, ComfyExecutionResult } from '../common/comfyBridge.js';
import { ISkillRegistry, ISkillDefinition } from '../common/skills.js';
import { IWorkflowExecutionService, WorkflowExecutionStatus, WorkflowNodeExecutionStatus, type IScriptExecutionDelegate } from '../common/workflowExecutionService.js';
import type { IWorkflowExecutionState, IWorkflowExecutionOptions, IWorkflowNodeExecutionState, IWorkflowTraceEvent, IAskUserOption, IAskUserField, IAskUserQuestion } from '../common/workflowExecutionService.js';
import { buildWorkflowCheckpoint, parseWorkflowCheckpoint, planWorkflowResume, type IWorkflowCheckpoint } from '../common/workflowCheckpoint.js';
import { validateStructuredRefs } from './workflow/structuredRefs.js';
import { CARD_TEXT_LIMITS, isCardEligibleNodeType, isNodeVisibleOnCard } from './workflow/cardVisibility.js';
// ★ 聊天卡描述符（图标 + 副标题）推导 —— 2026-09-13 从本文件移出以便单测（含 kind 覆盖率护栏）。
import { describeCardNode } from './workflow/cardDescriptor.js';
import { resolveNodeDisplayName } from './workflow/nodeDisplayName.js';
import { buildInteractionInitialValues, applyInteractionValues, buildImageRefDefaults, collectImageRefCandidates } from './workflow/nodeInteraction/index.js';
import type { INodeInteractionField } from './workflow/nodeInteraction/types.js';
import { catalogInteraction, catalogTitle, findNodeCatalogEntry, findCatalogByAlias } from './workflow/nodeCatalog.js';
// ★ 画布 stage 标题表（2026-09-10）：comfyTVStageMeta.generated.ts 是**纯数据文件**
//   （无 vscode/浏览器依赖，自动生成），跨层 import 仅取「stage 全名 → 画布可读标题」
//   映射，使卡片阶段名与画布 nodeCard 显示一致（spec.title）。
import { COMFYTV_STAGE_META } from '../webview/src/features/workflowEditor/comfyHost/comfyTVStageMeta.generated.js';
import { createComfyStageDelegate } from './workflow/comfyStageBridge.js';
import { directStageRunUnhandledEmitter, tryMarkOpeningCanvas, releaseOpeningCanvas, putWorkflowSnapshotMedia, abandonDirectStageRunsForExecution, abandonStageRunsForExecution } from './workflow/workflowSnapshotBridge.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceRegistry } from '../common/agentWorkspace.js';
import { substituteHostVariables, buildRuntimeValueMap, collectWorkflowVariables, parseSharedPublishKeys } from './utils/templateUtils.js';

/**
 * 节点类型别名 → 引擎运行时枚举（小写形态，与 WorkflowNodeType 一致）。
 *
 * 背景：workflow_apply 等 LLM 工具对外宣称的节点类型集合与引擎实际支持的枚举
 * 并不完全一致（例如工具文档里的 `branch`），画布侧又会持久化成命名空间形态
 * （`Saros.IfElse`）。若不做归一化，这类 type 会落进 _executeNodeRecursive 的
 * `default` 分支：只打一条 warn 日志，然后走**所有**下游边——条件节点退化成
 * 顺序执行，分支判断静默失效，且没有任何用户可见的错误。
 */
const NODE_TYPE_ALIASES: Readonly<Record<string, WorkflowNodeType>> = Object.freeze({
	branch: WorkflowNodeType.IfElse,
	condition: WorkflowNodeType.IfElse,
	ifelse: WorkflowNodeType.IfElse,
});

/**
 * 编排引擎 switch 实际处理的节点类型集合（_executeNodeRecursive 的 case 清单）。
 * Saros.* 归一后不在此集合的类型 = 媒体 stage 节点（Saros.AnimatedEmoji /
 * Saros.EmojiStage / Saros.RelightStage…）→ 归一成 comfyStage 走 Comfy 执行分支。
 */
const ORCHESTRATION_TYPES: ReadonlySet<string> = new Set([
	'start', 'end', 'task', 'prompt', 'agent', 'skill', 'tool', 'ifElse',
	'switch', 'askUser', 'comfy', 'comfyStage', 'script', 'picker',
]);

/**
 * ComfyTV Picker 家族（画布持久化全名）—— 调试预览节点，无 Run 行为。
 * 未连线时不执行、不报错；有上游连线时汇总上游媒体快照供卡片预览。
 * 用正则匹配（而非枚举全名）以便同时覆盖 `ComfyTV.ImagePickerStage` 与
 * `Saros.ImagePickerStage` 两种前缀写法。
 */
const PICKER_STAGE_RE = /(?:^|\.)(?:Image|Video|Audio)PickerStage$/;

/**
 * ComfyTV stage 全名 → 画布 nodeCard 显示的可读标题（`spec.title`）。
 * 用于卡片阶段名回退：节点名为机器名时显示「Emoji Stage」等，与画布所见一致。
 */
const STAGE_TITLE_BY_TYPE: ReadonlyMap<string, string> = new Map(
	COMFYTV_STAGE_META.map(m => [m.nodeId, m.title]),
);

// ★ 聊天卡描述符（图标 + 副标题推导）已移至 `./workflow/cardDescriptor.ts`（2026-09-13）。
//   移出原因：① 原先是本文件的模块私有函数 → 无法单测；② 实测暴露护栏需求 ——
//   `iconForStageKind` 按 kind 子串匹配，新增一类 stage kind 时若忘记补规则，图标会
//   **静默退化**为引擎兜底 ⚙️（实测 14 种 kind 里有 4 种未命中：material / model /
//   storyboard / timeline，已补）。现在由 `cardDescriptor.test.ts` 遍历全部 kind 守卫 ✓。
//   本文件仍保留 `STAGE_TITLE_BY_TYPE`（标题维度）—— 同源同一份生成数据。

/**
 * Agent / Task 文本输出落进画布快照库时的**长度上限**（P1-2 产物部分，2026-09-13）。
 *
 * 为什么需要：`nodeState.output` 存的是 **LLM 全量回复**（可数万字），而快照库会把它
 * 写进 IndexedDB（`saveMeta`）→ 不限制会让工作流的快照库体积失控 ✗。
 * 8000 字符足够覆盖正常摘要/报告；超出部分在画布卡的 OUTPUT 区本就显示不下。
 */
const AGENT_OUTPUT_SNAPSHOT_MAX = 8000;

/**
 * `ComfyTV.Asset*` 前缀的资产加载节点（webview `isLoaderNode` 的 startsWith 分支）。
 * 注：Loader 家族（ImageLoaderStage 等）**故意不在此列**——它们必须走 comfyStage
 * → delegate → webview `runLoaderNode`（no-Run 本地产出快照），否则参考图丢失；
 * Asset* 未在 localStageNodes 注册本地执行器，归 Picker 走预览分支避免报错。
 */
const ASSET_STAGE_RE = /(?:^|\.)Asset[A-Za-z]*Stage$|^ComfyTV\.Asset/;

/**
 * 引擎无执行 case 的**非媒体**类型（布局分组/控制容器）：保持归一原值落
 * default「skipping」是**正确**行为（它们本就不是可执行节点）。
 * 除此之外的 Saros.* 未知名 = 媒体 stage → 归 comfyStage。
 */
const NON_EXECUTING_TYPES: ReadonlySet<string> = new Set(['group', 'loop', 'parallel']);

/**
 * 把任意形态的 node.type 归一化成引擎枚举（小写驼峰）。
 * 幂等：已是合法枚举值则原样返回。未知类型原样返回（Comfy.* 等第三方类型走这条）。
 */
export function normalizeRuntimeNodeType(type: string | undefined): string {
	if (!type) { return ''; }
	// ★ 节点清单优先（2026-09-11 框架完善：新增节点只改 nodeCatalog.ts）：
	//   清单里声明了 type/aliases + engineType 的节点直接归一，无需再改本函数的
	//   别名表或前缀规则。
	const catEntry = findNodeCatalogEntry(type) ?? findCatalogByAlias(type);
	if (catEntry?.engineType) { return catEntry.engineType; }
	const direct = NODE_TYPE_ALIASES[type];
	if (direct) { return direct; }
	// ★ Picker 家族特判（2026-09-10 用户需求）：ImagePicker 是**调试预览节点**，
	//   未连线时不应执行也不应报错 —— 必须在下方的 `ComfyTV.` 通配（→ comfyStage →
	//   真跑 ComfyUI）之前拦截，否则会被当成可执行 stage 走 Comfy 分支而失败。
	//
	//   ⚠ Loader 家族**不在此列**（2026-09-10 参考图丢失实锤）：ImageLoader 必须走
	//   comfyStage → delegate → webview `runLoaderNode` 才能把「节点弹窗选定的图 /
	//   mediaAssetId 资产」物化成快照返回（webview 侧 `isLocalStage` 已识别
	//   `/(LoaderStage|PickerStage)$/` → 无需 ComfyUI runner，纯本地产出）。此前把
	//   Loader 也归 Picker → 只汇总**上游**（loader 是源节点，无上游）→ 快照永远为空
	//   → 下游 StatEmojiStage 的参考图（input.images）丢失。
	// Picker 家族走 **comfyStage**（由 _executeComfyNode 的交互段 apply:'snapshot' 接管，
	// 不真跑 ComfyUI）—— 单链路改造（2026-09-11）：不再有独立的 Picker 执行分支。
	if (PICKER_STAGE_RE.test(type) || ASSET_STAGE_RE.test(type)) {
		return WorkflowNodeType.ComfyStage;
	}
	// 命名空间形态（Saros.IfElse）→ 去前缀并还原驼峰首字母小写。
	if (type.startsWith('Saros.')) {
		const bare = type.slice('Saros.'.length);
		const decap = bare.charAt(0).toLowerCase() + bare.slice(1);
		const aliased = NODE_TYPE_ALIASES[decap] ?? NODE_TYPE_ALIASES[bare.toLowerCase()] ?? decap;
		// ★ 媒体 stage 归一（2026-09-10 日志实锤）：Saros.AnimatedEmoji 等媒体节点
		//   decap 后不在编排枚举集合 → 此前落 default 被静默跳过（表情包工作流
		//   只跑 start→end 的实测根因）→ 统一归 comfyStage 走 Comfy 执行分支。
		//   Group/Loop/Parallel（布局/容器，非媒体）保持原值——default 跳过是正确行为。
		if (!ORCHESTRATION_TYPES.has(aliased) && !NON_EXECUTING_TYPES.has(aliased)) {
			return WorkflowNodeType.ComfyStage;
		}
		return aliased;
	}
	// ★ Comfy 家族前缀（2026-09-10 修复）：画布持久化的媒体节点是 `ComfyTV.EmojiStage`
	//   等全名（actionSpawn/state.addNode 证实），此前不归一 → 全部落 default
	//   「Unknown node type, skipping」被**静默跳过** —— 聊天触发的存储工作流
	//   只跑 start→end（进度卡只剩两个胶囊的实测根因）。
	if (type.startsWith('ComfyTV.')) { return WorkflowNodeType.ComfyStage; }
	if (type.startsWith('Comfy.')) { return WorkflowNodeType.Comfy; }
	return type;
}

export class WorkflowExecutionService extends Disposable implements IWorkflowExecutionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidExecutionStatusChange = this._register(new Emitter<IWorkflowExecutionState>());
	readonly onDidExecutionStatusChange: Event<IWorkflowExecutionState> = this._onDidExecutionStatusChange.event;

	private readonly _onDidNodeExecutionStatusChange = this._register(new Emitter<{ executionId: string; nodeState: IWorkflowNodeExecutionState }>());
	readonly onDidNodeExecutionStatusChange: Event<{ executionId: string; nodeState: IWorkflowNodeExecutionState }> = this._onDidNodeExecutionStatusChange.event;

	private readonly _onDidChangeBreakpoints = this._register(new Emitter<{ executionId: string; nodeIds: string[] }>());
	readonly onDidChangeBreakpoints: Event<{ executionId: string; nodeIds: string[] }> = this._onDidChangeBreakpoints.event;

	private readonly _onDidExecutionTrace = this._register(new Emitter<IWorkflowTraceEvent>());
	readonly onDidExecutionTrace: Event<IWorkflowTraceEvent> = this._onDidExecutionTrace.event;

	private _executions = new Map<string, IWorkflowExecutionState>();
	/**
	 * ★ 当前正在执行的 script 节点（executionId → nodeId，P0 修复 2026-09-13）。
	 *
	 * 脚本内 `stage()` 的进度回程只带 runId/executionId（无 nodeId），靠这张表归到
	 * 具体的 script 节点卡 —— 否则该节点在聊天卡上永远没有进度条（质量评估实测缺口）。
	 * 工作流按拓扑**串行**执行 → 同一 executionId 至多一个活跃 script 节点 ✓。
	 *
	 * 同时缓存 `nodeName`（`node_progress` 的必填字段）—— 报告进度时只有 executionId，
	 * 无法回头再查 workflow 里的节点，故登记时一次算好。
	 */
	private readonly _activeScriptNodes = new Map<string, { nodeId: string; nodeName: string }>();
	/**
	 * ★ 脚本执行期间累积的 `stage()` 产物（executionId → snapshot 条目，P1-1 修复 2026-09-13）。
	 *
	 * 脚本内 `stage()` 的产物只落在画布快照库，host 侧此前不收集 → 脚本节点在聊天卡上
	 * 没有缩略图。这里按执行累积，脚本结束时写入 `nodeState.snapshot`（与 Comfy 节点同通道）。
	 */
	private readonly _scriptStageSnapshots = new Map<string, NonNullable<IWorkflowNodeExecutionState['snapshot']>>();
	/**
	 * ★ 断点恢复态的执行 id（2026-09-11）：只有这些执行会**跳过已 Completed 的节点**。
	 * 为什么不在正常路径也跳：正常执行由 `visited` + 递归保证不会重入已完成节点，
	 * 无条件跳过反而会掩盖「节点被重复调度」这类潜在 bug。
	 */
	private _resumedExecutions = new Set<string>();
	private _pauseResolvers = new Map<string, (value: string | string[]) => void>();
	/** sessionId cache: key=`${agentId}:${executionId}`, value=agentSessionId */
	private _sessionCache = new Map<string, string>();
	/** Per-execution session info (owner agent + new session id + workflow name) */
	private _executionSession = new Map<string, { workflowAgentId: string; sessionId: string; workflowName: string }>();
	/**
	 * Per-execution pending AskUser entries (v4). Keyed by `${executionId}:${nodeId}` so we
	 * can re-fire the trace event if a webview subscribes late. The entry also lets us
	 * detect "ghost" pauses (resolver leaked) on cancel.
	 */
	private _pendingAskUser = new Map<string, {
		executionId: string; sessionId: string; nodeId: string; nodeName: string;
		question: string; options: IAskUserOption[]; multiSelect: boolean;
	/** D4：动态参数字段（多字段输入表单）。 */
	}>();

	/** v6: resolvers for pre-execution variable collection (keyed by executionId). */
	private _variableResolvers = new Map<string, (values: Record<string, string>) => void>();

	/**
	 * v21: per-execution active stream tracker so `cancelExecution` can abort
	 * the in-flight LLM call instead of waiting for it to finish. Keyed by
	 * `executionId`. Each entry stores the (agentId, agentSessionId) pair that
	 * identifies the active stream inside `agentChatService._activeStreams`
	 * (the stream key is `${agentId}::${agentSessionId}`).
	 *
	 * Why this exists: previously `cancelExecution` only flipped the execution
	 * status to `Cancelled` and resolved pending AskUser / variable resolvers.
	 * The actual `agentChatService.sendMessage()` await inside a node executor
	 * kept running until the model finished its response — so clicking Cancel
	 * during a long agent turn had no visible effect for the entire LLM
	 * generation latency, and the next node's recursive call would only bail
	 * out at the *next* status check. With this tracker, cancel synchronously
	 * aborts the active stream so the node executor returns almost immediately.
	 */
	private _activeStreams = new Map<string, { agentId: string; agentSessionId: string; nodeId: string }>();

	/** P3: 当前执行链中正在运行的 workflowId 集合，用于递归环检测。 */
	private readonly _activeWorkflowChain = new Set<string>();

	/** Comfy 执行委托（懒注入，避免构造期 DI 环）。未设置时 Comfy 节点跳过。 */
	private _comfyDelegate: IComfyExecutionDelegate | undefined;

	setComfyExecutionDelegate(delegate: IComfyExecutionDelegate | undefined): void {
		this._comfyDelegate = delegate;
	}

	/** 脚本执行委托（P1-4：Dynamic Workflow 脚本作为 DAG 节点；懒注入避免 DI 环，仿 Comfy）。 */
	private _scriptDelegate: IScriptExecutionDelegate | undefined;

	setScriptExecutionDelegate(delegate: IScriptExecutionDelegate | undefined): void {
		this._scriptDelegate = delegate;
	}

	/**
	 * P1-4：执行 Script 节点（Dynamic Workflow 脚本作为 DAG 节点）。
	 * 复用 executeWorkflowScript 委托（由 agentDriverService 懒注入，仿 Comfy delegate）。
	 * 结果物化 nodeState.output/status；失败标 Failed（级联由上游调用方按 status 处理）。
	 */
	private async _executeScriptNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		const nodeState = executionState.nodeStates.get(node.id);
		const data = (node.data ?? {}) as { script?: string; name?: string; args?: unknown };
		const fail = (msg: string): void => {
			this.logService.warn(`[WorkflowExecution] Script node ${node.id} FAILED: ${msg}`);
			// ★ 级联（与 Comfy fail-loud 一致）：标 Failed + 跳过下游，独立分支不受影响。
			const failed: IWorkflowNodeExecutionState = {
				nodeId: node.id,
				status: WorkflowNodeExecutionStatus.Failed,
				error: msg,
				startTime: nodeState?.startTime ?? new Date().toISOString(),
				endTime: new Date().toISOString(),
				...(nodeState?.output !== undefined ? { output: nodeState.output } : {}),
			};
			executionState.nodeStates.set(node.id, failed);
			this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...failed } });
			const adjLocal = new Map<string, { targetId: string; fromPort?: string }[]>();
			for (const c of (workflow.connections ?? [])) {
				const list = adjLocal.get(c.from) ?? [];
				list.push({ targetId: c.to, fromPort: c.fromPort });
				adjLocal.set(c.from, list);
			}
			this._cascadeSkipDownstream(executionState, node.id, adjLocal);
		};
		if (!this._scriptDelegate) { fail('no script execution delegate registered'); return; }
		if (!data.script) { fail('Script node missing "script"'); return; }
		// ★ P0 修复（2026-09-13）：登记「当前正在执行的 script 节点」—— 脚本内 `stage()`
		//   的进度回程只带 executionId（无 nodeId），靠这张表把进度归到本节点卡。
		//   否则该节点在聊天卡上永远只有 spinner、没有进度条（质量评估实测缺口）。
		this._activeScriptNodes.set(executionState.executionId, {
			nodeId: node.id,
			nodeName: this._nodeDisplayName(node),
		});
		try {
			const r = await this._scriptDelegate.execute({
				script: data.script,
				meta: { name: data.name ?? 'script' },
				args: data.args,
				// ★ 归属执行 id（2026-09-11）：脚本内 `stage()` 的 pending 归它名下 ——
				//   用户取消该执行时，`cancelExecution` 才能一并中止（与直跑同构）。
				executionId: executionState.executionId,
			});
			if (r.ok) {
				if (nodeState) {
					nodeState.status = WorkflowNodeExecutionStatus.Completed;
					nodeState.output = typeof r.value === 'string' ? r.value : (r.value !== undefined ? JSON.stringify(r.value) : '');
					// ★ P1-1 修复（2026-09-13）：把脚本内 `stage()` 产出的媒体挂到本节点
					//   → `subagent_end` 带上 snapshot → 聊天卡显示缩略图。
					//   此前只写 output（文本）→ 脚本节点在聊天卡上永远没有缩略图，
					//   而同一产物在画布上可见（用户可感知的不一致）。
					const snaps = this._scriptStageSnapshots.get(executionState.executionId);
					if (snaps && snaps.length > 0) { nodeState.snapshot = snaps; }
				}
			} else {
				fail(r.error ?? 'script failed');
			}
		} catch (e) {
			fail((e as Error).message);
		} finally {
			// 串行执行下不会被覆盖；仍加身份校验保证幂等（异常路径也不会残留）。
			if (this._activeScriptNodes.get(executionState.executionId)?.nodeId === node.id) {
				this._activeScriptNodes.delete(executionState.executionId);
			}
			// 产物累积同理清理（成功分支已写入 nodeState，无需保留）。
			this._scriptStageSnapshots.delete(executionState.executionId);
		}
	}

	/**
	 * ★ 脚本内 `stage()` 的进度 → 归到发起它的 script 节点卡（P0 修复，2026-09-13）。
	 *
	 * 数据来源：controller 收到 `workflow.stageRunProgress` 时，经
	 * `executionIdOfStageRun(runId)` 反查归属后转交本方法（见接口注释）。
	 *
	 * 语义：脚本可连续调用多个 stage，进度会随 stage 切换**回退**（80% → 0%）。
	 * 这是有意取舍 —— 比「完全没有反馈」更接近真实状态；`message` 加「脚本 · 」
	 * 前缀让用户明白这是脚本内某一步，而非整个节点重新开始。
	 */
	reportScriptStageProgress(executionId: string, progress: number, message?: string): void {
		const active = this._activeScriptNodes.get(executionId);
		// 非脚本路径（画布直跑 / 工具卡）→ 忽略：那些进度已有自己的消费方。
		if (!active || !Number.isFinite(progress)) { return; }
		const owner = this._executionSession.get(executionId);
		if (!owner) { return; }
		const pct = Math.max(0, Math.min(100, progress));
		const ns = this._executions.get(executionId)?.nodeStates.get(active.nodeId);
		if (ns) { ns.progress = pct; }
		this._onDidExecutionTrace.fire({
			kind: 'node_progress',
			executionId,
			sessionId: owner.sessionId,
			nodeId: active.nodeId,
			nodeName: active.nodeName,
			progress: pct,
			message: message ? `脚本 · ${message}` : '脚本执行中',
		});
	}

	/**
	 * ★ 脚本内 `stage()` 产物累积（P1-1 修复，2026-09-13）。见接口注释。
	 *
	 * 去重：同一产物可能被多个 stage 透传（如「选择型」节点把上游原样传出）→
	 * 按 (port, ref) 去重，避免聊天卡里出现一串相同的图。
	 */
	collectScriptStageSnapshot(executionId: string, snapshot: ReadonlyArray<{
		port: string;
		kind: 'image' | 'video' | 'audio' | 'text' | 'unknown';
		ref: string;
		meta?: Record<string, unknown>;
	}>): void {
		// 非脚本路径（画布直跑 / 工具卡）→ 忽略：那些产物已有自己的展示通道。
		if (!this._activeScriptNodes.has(executionId)) { return; }
		const acc = this._scriptStageSnapshots.get(executionId) ?? [];
		for (const m of snapshot) {
			if (!m || typeof m.ref !== 'string' || !m.ref) { continue; }
			if (acc.some(x => x.port === m.port && x.ref === m.ref)) { continue; }
			acc.push({
				port: m.port || 'output',
				kind: m.kind,
				ref: m.ref,
				...(m.meta ? { meta: m.meta } : {}),
			});
		}
		if (acc.length > 0) { this._scriptStageSnapshots.set(executionId, acc); }
	}

	constructor(
		@ILogService private readonly logService: ILogService,
		@IAgentChatService private readonly agentChatService: IAgentChatService,
		@IWorkflowStorageService private readonly workflowStorage: IWorkflowStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceRegistry private readonly workspaceRegistry: IWorkspaceRegistry,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super();
		// ★ 默认 Comfy 委托在此注册（2026-09-10 日志实锤）：此前由
		//   AgentStudioWebviewController 构造时注入——native 聊天触发存储工作流时
		//   该 controller 可能尚未创建 → delegate 缺失 → 所有 ComfyStage 节点
		//   「no Comfy execution delegate registered」FAILED + 级联跳过整条下游
		//   （表情包工作流第三次卡死的根因）。createComfyStageDelegate 无 UI 依赖：
		//   走 bridge 模块级 requestDirectStageRun + headless unhandled 链路
		//   （无画布时自动开画布/离屏池），在服务构造期注册即可。controller 的
		//   setComfyExecutionDelegate 调用注入同款实现，幂等。
		this._comfyDelegate = createComfyStageDelegate(this.logService);

		// ★ headless 兜底「自动开画布」下沉到本服务（2026-09-10 日志实锤）：
		//   unhandled 的消费者此前只在 AgentStudioWebviewController——native 聊天
		//   触发时无 controller → direct stage 请求永远挂起（ImageLoader spinner
		//   卡死，最终 join 死锁 fail-loud）。本服务在 native 场景必然存在（它就是
		//   执行器本身）。开画布经 bridge 全局互斥，与 controller 的订阅（webview
		//   场景还有离屏池路径）不双开。
		this._register(
			directStageRunUnhandledEmitter.event((e) => {
				if (!tryMarkOpeningCanvas()) { return; }
				const { runId } = e;
				void (async () => {
					try {
						const wfId = e.request.workflowId;
						let wf = wfId ? await this.workflowStorage.getWorkflow(wfId).catch(() => undefined) : undefined;
						if (!wf) {
							const wfs = await this.workflowStorage.listWorkflows().catch(() => []);
							wf = wfs[0];
						}
						if (!wf) {
							this.logService.warn(`[WorkflowExecution] ${runId} 无画布且无存储工作流 → 保持挂起（90s 超时兜底）`);
							return;
						}
						const input = new WorkflowEditorInput(wf);
						const existing = this._editorService.findEditors(input);
						if (existing.length > 0) { await this._editorService.openEditor(existing[0].editor, { pinned: true, preserveFocus: true }); }
						else { await this._editorService.openEditor(input, { pinned: true, preserveFocus: true }); }
						this.logService.info(`[WorkflowExecution] ${runId} 无画布 → 已自动打开工作流「${String((wf as { name?: string }).name ?? wf.id)}」${wfId ? '(按 workflowId)' : '(回退最近)'}，controller 就绪后自动重放`);
					} finally {
						releaseOpeningCanvas();
					}
				})();
			}),
		);
	}

	// --------------------------------------------------------------------------------------------
	// Public API
	// --------------------------------------------------------------------------------------------

	/**
	 * v38: 同 executeWorkflow，但**可 await 终态**。
	 * 旧接口 fire-and-forget（立即返回 executionId），调用方（测试/脚本/agentDriver）
	 * 只能轮询 onDidExecutionStatusChange 才能拿到终态——可测试性差。
	 * 本方法在内部仍立即返回语义上不阻塞外部（executeWorkflow 本身仍 fire-and-forget），
	 * 只是把「等终态」封装成可 await 的 Promise。返回终态状态与错误信息。
	 */
	async executeWorkflowAndWait(
		workflowId: string,
		options?: IWorkflowExecutionOptions,
	): Promise<{ executionId: string; status: WorkflowExecutionStatus; error?: string }> {
		const executionId = await this.executeWorkflow(workflowId, options);
		const state = this._executions.get(executionId);
		if (!state) {
			return { executionId, status: WorkflowExecutionStatus.Failed, error: 'execution state missing' };
		}
		if (state.status !== WorkflowExecutionStatus.Running) {
			return { executionId, status: state.status, error: state.error };
		}
		await new Promise<void>(resolve => {
			const sub = this.onDidExecutionStatusChange(s => {
				if (s.executionId === executionId && s.status !== WorkflowExecutionStatus.Running) {
					sub.dispose();
					resolve();
				}
			});
		});
		const final = this._executions.get(executionId);
		return { executionId, status: final?.status ?? WorkflowExecutionStatus.Failed, error: final?.error };
	}

	async executeWorkflow(workflowId: string, options?: IWorkflowExecutionOptions): Promise<string> {
		this.logService.info(`[WorkflowExecution] executeWorkflow: workflowId=${workflowId}`);

		// Load workflow
		const workflow = await this.workflowStorage.getWorkflow(workflowId);
		if (!workflow) {
			throw new Error(`Workflow not found: ${workflowId}`);
		}

		// ★ $ref 静态预检（2026-09-10 阶段 2）：执行前一次性列出所有结构化引用问题
		//   （节点 id 悬空 / 对非契约节点写 path / $ref 缺 node）——否则引用写错只有
		//   跑到那个节点时才逐条 warn，排查成本高。预检不阻断执行（保持容错），
		//   只把问题集中到日志首部。
		try {
			const refProblems = validateStructuredRefs((workflow.nodes ?? []) as unknown as Parameters<typeof validateStructuredRefs>[0]);
			for (const p of refProblems) {
				const line = `[WorkflowExecution] $ref 预检 ${p.severity}: 节点 ${p.nodeId} 的 binding '${p.bindingKey}' → ${p.message}`;
				if (p.severity === 'error') { this.logService.error(line); }
				else { this.logService.warn(line); }
			}
			if (refProblems.length > 0) {
				this.logService.info(`[WorkflowExecution] $ref 预检共 ${refProblems.length} 个问题（error=${refProblems.filter(p => p.severity === 'error').length}）`);
			}
		} catch (e) {
			this.logService.warn(`[WorkflowExecution] $ref 预检跳过：${e instanceof Error ? e.message : String(e)}`);
		}

		// Create execution state. v5a: copy workflow-level breakpoints into the
		// execution state so the per-node pause check picks them up.
		const executionId = `wf_exec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

		// P3: 环检测 —— 防止 workflow 经 skill 节点递归调用自身形成无限循环。
		// 若同一 workflowId 已在当前执行链中，直接抛错，由嵌套调用方（_executeWorkflowAndAwait）捕获。
		if (this._activeWorkflowChain.has(workflowId)) {
			this.logService.warn(`[WorkflowExecution] Cyclic workflow invocation detected: ${workflowId} already in execution chain; aborting to prevent infinite recursion`);
			throw new Error(`Cyclic workflow invocation: ${workflowId}`);
		}
		this._activeWorkflowChain.add(workflowId);
		// 终态时从链中移除（无论完成/失败/取消），避免跨执行泄漏。
		const chainSub = this.onDidExecutionStatusChange(state => {
			if (state.executionId === executionId && (state.status === WorkflowExecutionStatus.Completed || state.status === WorkflowExecutionStatus.Failed || state.status === WorkflowExecutionStatus.Cancelled)) {
				chainSub.dispose();
				this._activeWorkflowChain.delete(workflowId);
			}
		});

		const executionState: IWorkflowExecutionState = {
			executionId,
			workflowId,
			status: WorkflowExecutionStatus.Running,
			nodeStates: new Map<string, IWorkflowNodeExecutionState>(),
			startTime: new Date().toISOString(),
			context: options?.context ?? {},
			breakpoints: new Set<string>(workflow.breakpoints ?? []),
			options,  // v31: store options for per-node access (maxHistoryMessages, etc.)
			sharedMemory: new Map<string, string>(),  // v32: inter-agent shared memory
		};

		this._executions.set(executionId, executionState);
		this._onDidExecutionStatusChange.fire(executionState);

		// P4: Create a fresh session on the workflow's owner agent (workflow.agentId)
		// BEFORE returning so that `_handleWorkflowExecute` can include sessionInfo
		// in the `workflow.execute` response. Session creation is fast (in-memory +
		// single file write), so this won't block the response.
		// v34: 不再一对一绑定专用 agent——调用者指定的 agent（/workflow 传当前聊天 agent、
		// 画布 Run 传 saros-claw）优先于 workflow.agentId 历史绑定。任何 agent 都能触发工作流。
		const workflowAgentId = options?.agentId || workflow.agentId;
		let ownerSessionId: string | undefined;
		let ownerAgentId: string | undefined;

		if (options?.sessionId && workflowAgentId) {
			// P4: 复用发起会话（如 /wf 命令所在的聊天会话），AskUser 交互卡片与
			// subagent 进度卡片直接显示在用户正看着的会话中，而非另开的「▶ 工作流名」会话。
			// 跳过 trigger anchor 消息——发起会话中已有用户的 /wf 消息作为锚点。
			ownerSessionId = options.sessionId;
			ownerAgentId = workflowAgentId;
			this._executionSession.set(executionId, {
				workflowAgentId,
				sessionId: options.sessionId,
				workflowName: workflow.name || workflowId,
			});
			this._sessionCache.set(`${workflowAgentId}:${executionId}`, options.sessionId);
			this.logService.info(
				`[WorkflowExecution] Reusing caller session ${options.sessionId} for ${workflowAgentId} (execution=${executionId})`,
			);
		} else if (workflowAgentId) {
			try {
				const meta = await this.agentChatService.createAgentSession(
					workflowAgentId,
					`▶ ${workflow.name || workflowId}`,
				);
				ownerSessionId = meta.id;
				ownerAgentId = workflowAgentId;
				this._executionSession.set(executionId, {
					workflowAgentId,
					sessionId: meta.id,
					workflowName: workflow.name || workflowId,
				});
				this._sessionCache.set(`${workflowAgentId}:${executionId}`, meta.id);

				// Post trigger user message so the owner chat has a visible anchor.
				await this.agentChatService.appendMessage(workflowAgentId, {
					id: `wf_trigger_${executionId}`,
					role: 'user',
					content: `▶ Run workflow: **${workflow.name || workflowId}**\n\n${workflow.description ?? ''}`,
					timestamp: new Date().toISOString(),
					agentSessionId: meta.id,
				} as any);

				this.logService.info(
					`[WorkflowExecution] Created owner-agent session ${meta.id} for ${workflowAgentId} (execution=${executionId})`,
				);
			} catch (err) {
				this.logService.warn(
					`[WorkflowExecution] Failed to create owner-agent session (continuing without chat trace): ${err instanceof Error ? err.message : err}`,
				);
			}
		} else {
			this.logService.warn(
				`[WorkflowExecution] Workflow has no agentId; will fire __workflow__ with fallback session.`,
			);
		}

		// ★ 工作流 Session（2026-09-11 用户需求：工作流画布 session 隔离 + 与聊天
		//   session 对应）：解析「聊天 session ↔ 工作流 session」绑定 —— 同一聊天
		//   session 复用同一工作流 session；切换聊天 session 时自动新建一个，隔离
		//   各自生成的内容。记入 executionState 供后续「快照/产物按 session 隔离」
		//   使用（存储位于 `{workflowsDir}/{workflowId}/sessions.json`）。
		try {
			const wfSession = await this.workflowStorage.getOrCreateWorkflowSession(workflowId, ownerSessionId);
			executionState.workflowSessionId = wfSession.id;
			this.logService.info(
				`[WorkflowExecution] 工作流 session: wf=${workflowId} sid=${wfSession.id} ` +
				`chat=${ownerSessionId ?? '-'} name=${wfSession.name} runs=${wfSession.runCount}`,
			);
		} catch (e) {
			this.logService.warn(
				`[WorkflowExecution] 工作流 session 解析失败（继续执行）：${e instanceof Error ? e.message : String(e)}`,
			);
		}

		// v7: ALWAYS fire __workflow__ so the webview can create a live container.
		// Without this, subagent cards never render because the container is never
		// created. If we have an owner session, use it; otherwise fire with a
		// fallback so the webview's fallback-container logic can kick in.
		const wfSessionId = ownerSessionId || options?.context?.sessionId || 'unknown';
		console.log(`[WorkflowExecution] Firing __workflow__ trace: execId=${executionId} session=${wfSessionId} agent=${ownerAgentId ?? '(none)'}`);
		this._onDidExecutionTrace.fire({
			kind: 'subagent_start',
			executionId,
			workflowAgentId: ownerAgentId,
			sessionId: wfSessionId,
			nodeId: '__workflow__',
			nodeName: workflow.name || workflowId,
			nodeType: 'workflow',
			// ★ P0 修复（2026-09-13）：容器卡图标（与节点卡同一套推导语义）。
			icon: '🌊',
			ask: workflow.description || `Run workflow: ${workflow.name || workflowId}`,
		} as any);

		// ── FIX: kick off variable collection + execution asynchronously.
		//     Variable collection uses `await` (waiting for user input), which would
		//     block the `workflow.execute` request/response and cause a 30 s timeout.
		//     By firing this asynchronously, `executeWorkflow` returns immediately
		//     with the executionId (and sessionInfo), unblocking the response.
		this._collectVariablesAndExecute(executionId, executionState, workflow, options).catch(err => {
			this.logService.error(`[WorkflowExecution] Execution failed for ${executionId}:`, err);
			executionState.status = WorkflowExecutionStatus.Failed;
			executionState.error = err instanceof Error ? err.message : String(err);
			executionState.endTime = new Date().toISOString();
			this._onDidExecutionStatusChange.fire(executionState);
			const ownerSession = this._executionSession.get(executionId);
			if (ownerSession) {
				this._onDidExecutionTrace.fire({
					kind: 'execution_end',
					executionId,
					sessionId: ownerSession.sessionId,
					status: 'failed',
					// ★ P2-2（2026-09-13）：异常收尾也带统计（endTime 已在上方写入）。
					...this._executionStats(executionState),
				});
			}
		});

		return executionId;
	}

	/**
	 * Async: collect template variables (if any), then start workflow execution.
	 * Run fire-and-forget from `executeWorkflow` so the request returns immediately.
	 */
	private async _collectVariablesAndExecute(
		executionId: string,
		executionState: IWorkflowExecutionState,
		workflow: any,
		options?: IWorkflowExecutionOptions,
	): Promise<void> {
		// v6: Collect template variables from agent/prompt nodes before execution.
		const variables = WorkflowExecutionService._collectTemplateVariables(workflow);
		const ownerSession = this._executionSession.get(executionId);
		if (variables.length > 0 && ownerSession) {
			// v40: skip variable collection card when pre-filled from context (e.g. task board)
			if (options?.skipVariableCollection) {
				this.logService.info(
					`[WorkflowExecution] Skipping variable collection card (skipVariableCollection=true), ` +
					`auto-resolving ${variables.length} variable(s) from context`,
				);
				const autoValues: Record<string, string> = {};
				const ctx = options.context ?? {};
				for (const v of variables) {
					autoValues[v.name] = String(ctx[v.name] ?? v.defaultValue ?? '');
				}
				WorkflowExecutionService._substituteVariables(workflow, autoValues);
			} else {
				this.logService.info(
					`[WorkflowExecution] Found ${variables.length} template variable(s): ` +
					variables.map(v => v.name).join(', '),
				);
				this._onDidExecutionTrace.fire({
					kind: 'collect_variables',
					executionId,
					sessionId: ownerSession.sessionId,
					variables,
				});

				// Wait for the user to fill in variable values via the webview card.
				try {
					const values = await new Promise<Record<string, string>>((resolve) => {
						this._variableResolvers.set(executionId, resolve);
					});
					this.logService.info(
						`[WorkflowExecution] Variables collected: ${JSON.stringify(values)}`,
					);
					WorkflowExecutionService._substituteVariables(workflow, values);
					this._onDidExecutionTrace.fire({
						kind: 'collect_variables_end',
						executionId,
						sessionId: ownerSession.sessionId,
						status: 'submitted',
					});
				} catch {
					this._onDidExecutionTrace.fire({
						kind: 'collect_variables_end',
						executionId,
						sessionId: ownerSession.sessionId,
						status: 'skipped',
					});
				}
			} // end else (skipVariableCollection)
		}

		// Start execution (fire-and-forget)
		await this._executeWorkflowAsync(executionState, workflow, options);
	}

	async pauseExecution(executionId: string, nodeId: string, question: string, options: IAskUserOption[]): Promise<string | string[]> {
		this.logService.info(`[WorkflowExecution] pauseExecution: executionId=${executionId}, nodeId=${nodeId}`);
		
		const state = this._executions.get(executionId);
		if (!state) {
			throw new Error(`Execution not found: ${executionId}`);
		}

		// 设置状态为暂停
		state.status = WorkflowExecutionStatus.Paused;
		state.currentNodeId = nodeId;
		// ★ 等待用户配置（2026-09-12 用户需求：聊天卡状态实时同步到画布节点 UI）：
		//   把**当前节点**标为 `AwaitingInput` → 画布显示「待配置」（黄色描边 + 角标）✓。
		//   覆盖 AskUser / node_interaction / picker_select —— 三者本质都是「暂停等用户」✓。
		//   若不区分，画布会一直显示 Running，用户以为"在跑"、实际在等他操作 ✗。
		const waiting = state.nodeStates.get(nodeId);
		if (waiting) {
			waiting.status = WorkflowNodeExecutionStatus.AwaitingInput;
			this._onDidNodeExecutionStatusChange.fire({ executionId, nodeState: { ...waiting } });
		}
		this._onDidExecutionStatusChange.fire(state);

		// 创建延迟 Promise，等待用户恢复
		return new Promise<string | string[]>((resolve) => {
			this._pauseResolvers.set(executionId, resolve);
		});
	}

	async resumeExecution(executionId: string, userInput: string | string[]): Promise<void> {
		this.logService.info(`[WorkflowExecution] resumeExecution: executionId=${executionId}`);
		
		const resolver = this._pauseResolvers.get(executionId);
		if (!resolver) {
			throw new Error(`No pending pause for execution: ${executionId}`);
		}

		// 恢复执行（调用 resolver）
		resolver(userInput);
		this._pauseResolvers.delete(executionId);

		// 更新状态为运行中
		const state = this._executions.get(executionId);
		if (state) {
			state.status = WorkflowExecutionStatus.Running;
			// ★ 清除「待配置」（2026-09-12）：用户已提交 → 当前节点回到 Running ✓
			//   （节点 id 用 pauseExecution 写入的 `currentNodeId` —— resume 没有 nodeId 参数 ✗）。
			const waitingId = state.currentNodeId;
			const ns = waitingId ? state.nodeStates.get(waitingId) : undefined;
			if (ns && ns.status === WorkflowNodeExecutionStatus.AwaitingInput) {
				ns.status = WorkflowNodeExecutionStatus.Running;
				this._onDidNodeExecutionStatusChange.fire({ executionId, nodeState: { ...ns } });
			}
			this._onDidExecutionStatusChange.fire(state);
		}
	}

	async cancelExecution(executionId: string): Promise<void> {
		this.logService.info(`[WorkflowExecution] cancelExecution: executionId=${executionId}`);
		const state = this._executions.get(executionId);
		if (!state) {
			throw new Error(`Execution not found: ${executionId}`);
		}
		state.status = WorkflowExecutionStatus.Cancelled;
		state.endTime = new Date().toISOString();
		this._onDidExecutionStatusChange.fire(state);

		// v21: abort the in-flight LLM stream so the node executor's
		// `await sendMessage(...)` returns within ms instead of waiting for
		// the model to finish. Without this, clicking Cancel during a long
		// agent turn has no visible effect until the next model completion
		// (could be many seconds). Must run BEFORE the AskUser/variable
		// resolvers because they only unblock *future* awaits.
		this._abortActiveStream(executionId);

		// v4: resolve any pending AskUser pauses so the host's pauseExecution
		// promise doesn't leak. Also fire ask_user_end so the webview card
		// flips to "cancelled" state.
		this._cancelPendingAskUserForExecution(executionId, 'cancelled');

		// ★ 中止本执行名下的「画布直跑」（2026-09-11）：
		//   ① 通知画布**停止生成**（此前取消后画布仍在跑、稍后还会出图 ✗ 僵尸）；
		//   ② reject 让等待中的节点 delegate 立即收尾（此前只能等空闲超时才解开 ✗）。
		//   必须在 status=Cancelled **之后**（L654 已设）：节点 delegate 抛错时 catch 分支
		//   据此把节点标 Cancelled 而非 Failed（不发红叉）✓。
		const abandoned = abandonDirectStageRunsForExecution(executionId);
		// ★ 脚本路径的 `stage()` 同样收尾（2026-09-11，与直跑同构）：
		//   否则取消后脚本会一直等到空闲超时 ✗。
		const abandonedStage = abandonStageRunsForExecution(executionId);
		if (abandoned > 0 || abandonedStage > 0) {
			this.logService.info(`[WorkflowExecution] cancelExecution: abandoned ${abandoned} direct stage run(s) + ${abandonedStage} stage() run(s)`);
		}

		// v6: resolve any pending variable collection so executeWorkflow doesn't hang.
		const varResolver = this._variableResolvers.get(executionId);
		if (varResolver) {
			this._variableResolvers.delete(executionId);
			// Reject by calling with empty values — executeWorkflow will see empty and skip.
			varResolver({});
			const ownerSession = this._executionSession.get(executionId);
			if (ownerSession) {
				this._onDidExecutionTrace.fire({
					kind: 'collect_variables_end',
					executionId,
					sessionId: ownerSession.sessionId,
					status: 'skipped',
				});
			}
		}
	}

	/**
	 * v4 helper: fire ask_user_end('cancelled') for every still-pending AskUser on
	 * this execution and clean up the resolver. Called from cancelExecution().
	 */
	private _cancelPendingAskUserForExecution(
		executionId: string,
		status: 'cancelled',
	): void {
		for (const [key, entry] of this._pendingAskUser.entries()) {
			if (entry.executionId !== executionId) { continue; }
			this._pendingAskUser.delete(key);
			this._onDidExecutionTrace.fire({
				kind: 'ask_user_end',
				executionId,
				sessionId: entry.sessionId,
				nodeId: entry.nodeId,
				status,
			});
		}
		// If the resolver for this execution is still parked (AskUser pause was
		// never answered), resolve it with empty string so pauseExecution() unblocks.
		const resolver = this._pauseResolvers.get(executionId);
		if (resolver) {
			resolver('');
			this._pauseResolvers.delete(executionId);
		}
	}

	/**
	 * ★ 取消短路（2026-09-11 修复「点击取消后工作流工具卡片进度条不终止」）。
	 *
	 * 场景：执行停在**交互类暂停**（AskUser 选项 / 节点配置表单 node_interaction）
	 * 时用户点取消 —— `cancelExecution` 会把 `_pauseResolvers` 以空值 resolve（见
	 * `_cancelPendingAskUserForExecution`），于是 `pauseExecution` **正常返回**而非
	 * 抛错。若调用方不检查状态就继续往下走，就会出现「用户已取消但节点仍在跑」：
	 *   ① 节点继续执行 → 真实发起生成（消耗算力、产出用户已放弃的图）；
	 *   ② 节点被标 Completed、发 `subagent_end('done')` → 卡片 spinner 继续转；
	 *   ③ `execution_end` 要等整个节点（含 headless 开画布 90s 兜底）跑完才发
	 *      → 卡片长时间停在「运行中」，用户感知即「取消无效」。
	 *
	 * 本方法在所有「可能被取消打断的 await 之后」调用，做三件事并返回 true：
	 *   - 节点状态标 `Cancelled`（不发 Failed 的红叉，UI 显示「已取消」）；
	 *   - 发 `subagent_end(cancelled)` 让卡片 spinner 立刻停止（与 catch 分支
	 *     的 L1340 同因：失败/取消也必须发 subagent_end）；
	 *   - 幂等：同节点重复调用只收尾一次（短路点有多个，避免重复 trace）。
	 *
	 * AskUser 节点不在此发 subagent_end —— 它有专属交互卡，与既有规则一致
	 * （见 `_executeNodeRecursive` 的 subagent_end 排除列表）。
	 */
	private _bailOutIfCancelled(
		executionState: IWorkflowExecutionState,
		node: WorkflowGraphNode,
	): boolean {
		if (executionState.status !== WorkflowExecutionStatus.Cancelled) { return false; }
		const existing = executionState.nodeStates.get(node.id);
		if (existing?.status === WorkflowNodeExecutionStatus.Cancelled) { return true; }
		const nodeState: IWorkflowNodeExecutionState = existing ?? {
			nodeId: node.id,
			status: WorkflowNodeExecutionStatus.Cancelled,
			startTime: new Date().toISOString(),
		};
		nodeState.status = WorkflowNodeExecutionStatus.Cancelled;
		nodeState.endTime = new Date().toISOString();
		executionState.nodeStates.set(node.id, nodeState);
		this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });
		const owner = this._executionSession.get(executionState.executionId);
		// ★ 规则单点化（2026-09-13 P2-6）：类型排除收敛到 `cardVisibility`。
		//   此处**不做** FLOW 链判断 —— 本方法只在节点**执行中途**被取消时触发，
		//   而能执行到中途的节点必然已发过 `subagent_start`（必在 FLOW 链上）✓。
		if (owner && isCardEligibleNodeType(node.type)) {
			this._onDidExecutionTrace.fire({
				kind: 'subagent_end',
				executionId: executionState.executionId,
				sessionId: owner.sessionId,
				nodeId: node.id,
				status: 'cancelled',
				output: '',
			});
		}
		this.logService.info(`[WorkflowExecution] Node ${node.id} (${node.type}) 已被取消 → 短路，不再执行`);
		return true;
	}

	getExecutionState(executionId: string): IWorkflowExecutionState | undefined {
		return this._executions.get(executionId);
	}

	getExecutionSession(executionId: string): { workflowAgentId: string; sessionId: string; workflowName: string } | undefined {
		return this._executionSession.get(executionId);
	}

	getActiveExecutions(): IWorkflowExecutionState[] {
		return Array.from(this._executions.values()).filter(s =>
			s.status === WorkflowExecutionStatus.Running ||
			s.status === WorkflowExecutionStatus.Paused
		);
	}

	setBreakpoint(executionId: string, nodeId: string): void {
		this.logService.info(`[WorkflowExecution] setBreakpoint: executionId=${executionId}, nodeId=${nodeId}`);
		const state = this._executions.get(executionId);
		if (!state) {
			throw new Error(`Execution not found: ${executionId}`);
		}
		if (!state.breakpoints) {
			state.breakpoints = new Set<string>();
		}
		state.breakpoints.add(nodeId);
		this._onDidChangeBreakpoints.fire({ executionId, nodeIds: Array.from(state.breakpoints) });
	}

	clearBreakpoint(executionId: string, nodeId: string): void {
		this.logService.info(`[WorkflowExecution] clearBreakpoint: executionId=${executionId}, nodeId=${nodeId}`);
		const state = this._executions.get(executionId);
		if (!state) {
			throw new Error(`Execution not found: ${executionId}`);
		}
		if (state.breakpoints) {
			state.breakpoints.delete(nodeId);
			this._onDidChangeBreakpoints.fire({ executionId, nodeIds: Array.from(state.breakpoints) });
		}
	}

	getBreakpoints(executionId: string): string[] {
		const state = this._executions.get(executionId);
		if (!state || !state.breakpoints) {
			return [];
		}
		return Array.from(state.breakpoints);
	}

	// ─── v5a: Workflow-level breakpoints (persist across runs) ───────────

	/**
	 * Set a breakpoint at the workflow level. Persists to the workflow JSON
	 * via the storage service. If `executionId` is provided, also applies to
	 * the running execution for immediate effect.
	 */
	async setWorkflowBreakpoint(workflowId: string, nodeId: string, executionId?: string): Promise<void> {
		this.logService.info(`[WorkflowExecution] setWorkflowBreakpoint: workflowId=${workflowId}, nodeId=${nodeId}, executionId=${executionId ?? 'none'}`);
		const workflow = await this.workflowStorage.getWorkflow(workflowId);
		if (!workflow) {
			throw new Error(`Workflow not found: ${workflowId}`);
		}
		const current = new Set(workflow.breakpoints ?? []);
		if (current.has(nodeId)) { return; } // already set, no-op
		current.add(nodeId);
		await this.workflowStorage.updateWorkflow(workflowId, { breakpoints: Array.from(current) });
		// Apply to running execution if any.
		if (executionId) {
			try { this.setBreakpoint(executionId, nodeId); } catch { /* execution may have ended */ }
		}
	}

	async clearWorkflowBreakpoint(workflowId: string, nodeId: string, executionId?: string): Promise<void> {
		this.logService.info(`[WorkflowExecution] clearWorkflowBreakpoint: workflowId=${workflowId}, nodeId=${nodeId}, executionId=${executionId ?? 'none'}`);
		const workflow = await this.workflowStorage.getWorkflow(workflowId);
		if (!workflow) {
			throw new Error(`Workflow not found: ${workflowId}`);
		}
		const current = new Set(workflow.breakpoints ?? []);
		if (!current.has(nodeId)) { return; }
		current.delete(nodeId);
		await this.workflowStorage.updateWorkflow(workflowId, { breakpoints: Array.from(current) });
		if (executionId) {
			try { this.clearBreakpoint(executionId, nodeId); } catch { /* execution may have ended */ }
		}
	}

	async getWorkflowBreakpoints(workflowId: string): Promise<string[]> {
		const workflow = await this.workflowStorage.getWorkflow(workflowId);
		if (!workflow) { return []; }
		return workflow.breakpoints ?? [];
	}

	// --------------------------------------------------------------------------------------------
	// Execution Engine
	// --------------------------------------------------------------------------------------------

	private async _executeWorkflowAsync(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Starting execution ${executionState.executionId}`);

		// 归一化节点 type：LLM 工具产出的 'branch'、画布持久化的 'Saros.IfElse'
		// 在此统一成引擎枚举的小写形态，避免落进 default 分支导致条件判断失效。
		const nodes = (workflow.nodes ?? []).map(n => {
			const normalized = normalizeRuntimeNodeType(n.type);
			// ★ 原始 type 注入（2026-09-10 日志实锤「缺少 stageClass」）：媒体节点归一后
			//   type='comfyStage'，**原始全名**（ComfyTV.ImageLoaderStage / Saros.AnimatedEmoji）
			//   正是 ComfyUI 需要的 stageClass。必须在此处（原始 type 尚在）注入
			//   data.stageClass —— 下游 _executeNodeRecursive 拿到的 rawNode.type 已被本
			//   map 归一化（= 'comfyStage' 占位名），在那里注入只会写入占位名 → 被
			//   resolveStageClass 过滤 → 「缺少 stageClass」。
			const out = (normalized === n.type ? n : { ...n, type: normalized }) as WorkflowGraphNode;
			if (normalized === WorkflowNodeType.ComfyStage) {
				const d = (out.data ?? {}) as Record<string, unknown>;
				const cur = typeof d['stageClass'] === 'string' ? d['stageClass'] : '';
				if (!cur || cur === 'comfyStage' || cur === 'comfy') {
					out.data = { ...d, stageClass: n.type };
				}
			}
			if (normalized !== n.type) {
				this.logService.info(`[WorkflowExecution] Normalized node "${n.id}" type "${n.type}" → "${normalized}"`);
			}
			return out;
		});
		const connections = workflow.connections ?? [];

		// Build adjacency list
		const adj = new Map<string, { targetId: string; fromPort?: string }[]>();
		for (const conn of connections) {
			const list = adj.get(conn.from) ?? [];
			list.push({ targetId: conn.to, fromPort: conn.fromPort });
			adj.set(conn.from, list);
		}

		// Find start node
		const startNode = nodes.find(n => n.type === WorkflowNodeType.Start);
		if (!startNode) {
			throw new Error('Workflow has no Start node');
		}
		// W7: Start 输入契约（args）注入 —— 打通「画布 Start 参数」与「聊天框/Agent
		// 触发」两套变量通道。此前 `{{args.x}}` 只在 webview 画布路径生效
		// （collectStartArgs / startArgsOverride），headless 执行时该占位符永远
		// 解析不到（静默留字面量）。这里把 Start 节点的 args 展平成 `args.<key>`
		// 写入 executionState.context —— `_buildEvalContext` 会把 context 里的
		// string 项暴露给 `_replaceVariables`，于是 prompt/binding 里的
		// `{{args.key}}` 在两条路径下语义一致。
		// 优先级对齐画布侧（运行时覆盖 > 节点默认）：聊天触发传入的同名 context
		// 项（variables / input）覆盖 Start 节点里的默认值。
		this._injectStartArgs(executionState, nodes);

		// v31: visited set prevents diamond-pattern re-execution and infinite
		// loops from accidental cycles. maxDepth protects against stack
		// overflow on pathological graphs. Both are scoped to a single
		// execution run.
		const visited = new Set<string>();
		const MAX_DEPTH = 500;
		// v38: 入度表（join 语义）—— 每个节点被多少条边指向。后继入度归零才执行。
		// 旧 DFS 在菱形（A→B→D, A→C→D）中 B 完成后立即执行 D，C 的产出丢失；
		// 入度归零保证 D 等到全部前驱完成（真 join）。不可达子图入度永不归零，
		// 自动跳过（与旧「只从 Start DFS」行为一致）；环同理被跳过而非死循环。
		const inDeg = new Map<string, number>();
		for (const conn of connections) {
			inDeg.set(conn.to, (inDeg.get(conn.to) ?? 0) + 1);
		}
		// W7: 起跑集解析 —— 正常情况就是 [Start]（严格「从 Start 开始」）。
		// Start 未编排（无出边 / 出边只到 End）时退化为「全部根节点」，与画布侧
		// resolveStartScope 的 degraded 分支保持同一语义：同一张图在画布 ▶ 运行
		// 与聊天框调用下跑同样的节点集（否则聊天里「什么都没发生」）。
		const entryNodes = this._resolveEntryNodes(nodes, connections, startNode, inDeg);
		// ★ 递归使用「归一化 + stageClass 注入后」的 nodes 副本（2026-09-10 日志实锤）：
		//   递归内查找下游节点用 `workflow.nodes.find(...)`——若传原始 workflow，
		//   下游媒体节点拿到的仍是**未注入**的原始 data（无 stageClass）→ StatEmoji
		//   等报「缺少 stageClass」；而入口节点（来自上面归一化数组）正常（ImageLoader
		//   通过、StatEmoji 失败的不一致现象正源于此）。
		const execWorkflow: IStoredWorkflow = { ...workflow, nodes };
		for (const entry of entryNodes) {
			if (executionState.status === WorkflowExecutionStatus.Cancelled) { break; }
			if (visited.has(entry.id)) { continue; }
			await this._executeNodeRecursive(executionState, execWorkflow, entry, adj, options, visited, 0, MAX_DEPTH, inDeg);
		}

		// Mark execution as completed (or failed if any node failed)
		if (executionState.status === WorkflowExecutionStatus.Running) {
			// ★ join 死锁 fail-loud（2026-09-10 卡死实锤）：主循环结束仍有节点
			//   入度 > 0 且从未被递归（!visited）→ 它们永远不会执行。此前直接标
			//   completed——「Execution completed」假象，出图节点从未跑。
			const stuck = nodes.filter(n =>
				(inDeg.get(n.id) ?? 0) > 0
				&& !visited.has(n.id)
				&& executionState.nodeStates.get(n.id)?.status !== WorkflowNodeExecutionStatus.Skipped);
			const hasFailed = [...executionState.nodeStates.values()]
				.some(s => s.status === WorkflowNodeExecutionStatus.Failed);
			if (stuck.length > 0) {
				const detail = stuck.map(n => {
					const pending = connections
						.filter(c => c.to === n.id && !visited.has(c.from))
						.map(c => c.from);
					return `${n.id}（等待未执行的上游: ${pending.join(', ') || '?'}）`;
				}).join('; ');
				this.logService.error(
					`[WorkflowExecution] Execution ${executionState.executionId} DEADLOCK: ` +
					`${stuck.length} node(s) stuck on join — ${detail}`,
				);
				executionState.status = WorkflowExecutionStatus.Failed;
				executionState.error = `${stuck.length} 个节点等待从未执行的上游（join 死锁）：${detail}`;
			} else {
				executionState.status = hasFailed
					? WorkflowExecutionStatus.Failed
					: WorkflowExecutionStatus.Completed;
			}
			executionState.endTime = new Date().toISOString();
			this._onDidExecutionStatusChange.fire(executionState);
			this.logService.info(`[WorkflowExecution] Execution ${executionState.executionId} ${executionState.status === WorkflowExecutionStatus.Failed ? (executionState.error ? 'failed (deadlock)' : 'failed (some nodes failed)') : 'completed'}`);
		}

		// P4: fire execution_end so the owner chat can commit the final assistant message.
		const ownerSession = this._executionSession.get(executionState.executionId);
		if (ownerSession) {
			const finalStatus: 'completed' | 'failed' | 'cancelled' =
				executionState.status === WorkflowExecutionStatus.Cancelled
					? 'cancelled'
					: executionState.status === WorkflowExecutionStatus.Failed
						? 'failed'
						: 'completed';
			this._onDidExecutionTrace.fire({
				kind: 'execution_end',
				executionId: executionState.executionId,
				sessionId: ownerSession.sessionId,
				status: finalStatus,
				// ★ P2-2（2026-09-13）：真实统计（耗时 + 成功/失败/取消/跳过节点数）。
				...this._executionStats(executionState),
			});
		}
	}

	private async _executeNodeRecursive(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		rawNode: WorkflowGraphNode,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		options: IWorkflowExecutionOptions | undefined,
		visited: Set<string>,
		depth: number,
		maxDepth: number,
		inDeg: Map<string, number>,
	): Promise<void> {
		// ★ 全名化归一（2026-09-10 修复）：画布持久化的是 `Saros.AskUser` 等全名，
		//   而 switch (node.type) 的 case 匹配引擎枚举（`askUser`）——不归一化时
		//   所有编排节点落入 default「Unknown node type, skipping」被静默跳过，
		//   下游 join 入度永不归零 → 执行卡死（实测 wf-emoji-workflow 卡死根因）。
		const normalizedType = normalizeRuntimeNodeType(rawNode.type);
		const node: WorkflowGraphNode = { ...rawNode, type: normalizedType as WorkflowNodeType };
		// 注：媒体节点的 stageClass 注入已前移至 executeWorkflow 的归一化入口
		// （_executeWorkflowAsync 开头）——那里原始 type 尚在；此处 rawNode.type 已被
		// 入口归一化，注入只会写入 'comfyStage' 占位名（2026-09-10 实测「缺少
		// stageClass」的成因），故移除。
		// Check if execution was cancelled
		if (executionState.status === WorkflowExecutionStatus.Cancelled) {
			return;
		}

		// v38: 级联 Skipped 的节点不再执行（_cascadeSkipDownstream 已标记）。
		// 但仍要继续向下递归：后继可能因 join 未达而尚未被级联标记到。
		// ★ 先标 visited 防菱形重入（两个前驱都归零会递归两次 → 入度被双重递减）。
		if (executionState.nodeStates.get(node.id)?.status === WorkflowNodeExecutionStatus.Skipped) {
			visited.add(node.id);
			this.logService.info(`[WorkflowExecution] Node ${node.id} is Skipped (cascade), propagating without executing`);
			const succs2 = (adj.get(node.id) ?? []).map(e => e.targetId);
			for (const nextNodeId of succs2) {
				const d = (inDeg.get(nextNodeId) ?? 1) - 1;
				inDeg.set(nextNodeId, d);
				if (d > 0) { continue; }
				const nextNode = workflow.nodes?.find(n => n.id === nextNodeId);
				if (nextNode && !visited.has(nextNodeId)) {
					await this._executeNodeRecursive(executionState, workflow, nextNode, adj, options, visited, depth + 1, maxDepth, inDeg);
				}
			}
			return;
		}

		// ★ 断点恢复（2026-09-11）：checkpoint 里已 Completed 的节点**复用产出、不重跑**，
		//   但必须照常向下推进入度（与上面的 Skipped 分支同构）——否则下游 join 永不归零，
		//   恢复后的执行会卡住。产出已在 nodeStates 里（resumeFromCheckpoint 回填）→
		//   下游 `{{nodeId.output}}` 替换照常取到值。
		//   仅对「恢复态」执行生效（见 `_resumedExecutions` 字段注释）。
		if (this._resumedExecutions.has(executionState.executionId)
			&& executionState.nodeStates.get(node.id)?.status === WorkflowNodeExecutionStatus.Completed) {
			visited.add(node.id);
			this.logService.info(`[WorkflowExecution] Node ${node.id} reused from checkpoint (already completed), propagating`);
			const succs3 = (adj.get(node.id) ?? []).map(e => e.targetId);
			for (const nextNodeId of succs3) {
				const d = (inDeg.get(nextNodeId) ?? 1) - 1;
				inDeg.set(nextNodeId, d);
				if (d > 0) { continue; }
				const nextNode = workflow.nodes?.find(n => n.id === nextNodeId);
				if (nextNode && !visited.has(nextNodeId)) {
					await this._executeNodeRecursive(executionState, workflow, nextNode, adj, options, visited, depth + 1, maxDepth, inDeg);
				}
			}
			return;
		}

		// v31: cycle detection — if this node has already been visited in the
		// current execution run, skip it. This prevents:
		//   1. Infinite loops from accidental cycles in the graph
		//   2. Diamond-pattern nodes being executed multiple times (once per
		//      incoming path, which would cause double-work and inconsistent state)
		if (visited.has(node.id)) {
			this.logService.info(
				`[WorkflowExecution] Node ${node.id} already visited (cycle/diamond), skipping`,
			);
			return;
		}
		visited.add(node.id);

		// v31: max depth guard — prevent stack overflow on deep/recursive graphs.
		if (depth >= maxDepth) {
			this.logService.error(
				`[WorkflowExecution] Max depth ${maxDepth} exceeded at node ${node.id}. ` +
				`Possible infinite loop or excessively deep workflow. Halting execution.`,
			);
			executionState.status = WorkflowExecutionStatus.Failed;
			executionState.error = `Workflow exceeded maximum depth of ${maxDepth} nodes. Possible infinite loop.`;
			executionState.endTime = new Date().toISOString();
			this._onDidExecutionStatusChange.fire(executionState);
			return;
		}

		// Mark node as running
		executionState.currentNodeId = node.id;
		const nodeState: IWorkflowNodeExecutionState = {
			nodeId: node.id,
			status: WorkflowNodeExecutionStatus.Running,
			startTime: new Date().toISOString(),
		};
		executionState.nodeStates.set(node.id, nodeState);
		this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });

		// ★ 节点级 trace（2026-09-10 修复）：此前只有 Agent 节点（_executeAgentNode）
		//   fire subagent_start —— 聊天进度卡的业务节点全部缺位，用户只看到
		//   start→end 两个胶囊（截图实测）。这里对所有节点统一发卡片事件；
		//   Agent 节点跳过（其 executor 已发带 task/输出的更丰富版本）；
		//   AskUser 跳过（用户反馈 2026-09-10：专属交互卡已展示选择结果，
		//   节点卡重复同一信息 → 双卡）。
		const nodeOwner = this._executionSession.get(executionState.executionId);
		// ★ 规则单点化（2026-09-13 P2-6）：类型排除 + FLOW 链筛选收敛到 `cardVisibility`
		//   （唯一规则表；新增节点类型时「是否出卡」有单点可查，避免各处漂移）。
		if (nodeOwner && isNodeVisibleOnCard(workflow.connections, node)) {
			// ★ P0 修复（2026-09-13）：副标题不再塞机器名 `node.type`，改用节点描述符
			//   （stage kind/workflowKind，与画布 nodeCard 的 schemaDetail 一致）；
			//   同时带上 host 推导的图标（渲染层不再按 nodeType 猜）。
			const desc = this._nodeCardDescriptor(node);
			this._onDidExecutionTrace.fire({
				kind: 'subagent_start',
				executionId: executionState.executionId,
				workflowAgentId: nodeOwner.workflowAgentId,
				sessionId: nodeOwner.sessionId,
				nodeId: node.id,
				nodeName: this._nodeDisplayName(node),
				nodeType: node.type,
				task: desc.subtitle,
				icon: desc.icon,
			});
		}

		// v23: substitute upstream node outputs and the `$prev` alias in
		// `data.prompt` / `data.skillArgs[*]` / `data.toolParams[*]` BEFORE
		// any node executor runs. The pre-execution `_substituteVariables`
		// pass (called once when the workflow starts, see line ~181) only
		// resolved user-supplied variables — at that point upstream nodes
		// hadn't run yet, so `{{$prev.output}}` and `{{someNodeId.output}}`
		// remained as literal text and were never replaced.
		//
		// We re-substitute here, *now* that the upstream nodeStates map
		// contains the actual outputs of previously-completed nodes. The
		// value map built by `buildRuntimeValueMap` exposes BOTH the
		// `<nodeId>` and `<nodeId>.output` keys (and the same for `$prev`),
		// so users can write `{{myNode}}` or `{{myNode.output}}`
		// interchangeably. Cancellation / failed upstream nodes contribute
		// empty strings (with a warn log) so the prompt stays coherent
		// instead of leaving a literal `{{myNode.output}}` placeholder.
		//
		// Note: Start / End / AskUser nodes have no `data.prompt` and we
		// also short-circuit pure routing nodes to avoid mutating data on
		// them. The mutation goes back into `data` (same object the
		// downstream `_execute*Node` reads from), so it propagates
		// naturally to all four executors that use `data.prompt`.
		this._substituteUpstreamVariables(executionState, workflow, node);

		try {
			// 检查断点（P2 调试功能）
			if (executionState.breakpoints?.has(node.id)) {
				this.logService.info(`[WorkflowExecution] Breakpoint hit at node ${node.id}`);
				await this.pauseExecution(
					executionState.executionId,
					node.id,
					`断点暂停: ${node.name || node.id}`,
					[],
				);
			}

			// v31: Retry loop — wraps node execution with configurable
			// exponential backoff. Canceled executions are never retried.
			const nodeData = node.data ?? {};
			const retryMaxAttempts = (nodeData.retryMaxAttempts as number) ?? 0;
			const retryInitialMs = (nodeData.retryInitialDelayMs as number) ?? 1000;
			const retryMultiplier = (nodeData.retryBackoffMultiplier as number) ?? 2;
			const retryMaxMs = (nodeData.retryMaxDelayMs as number) ?? 30000;

		let nextNodeIds: string[] = [];

			for (let attempt = 0; attempt <= retryMaxAttempts; attempt++) {
				// Reset nextNodeIds before each attempt
				nextNodeIds = [];
				try {
					// Execute node based on type
					switch (node.type) {
						case WorkflowNodeType.Start:
							nextNodeIds = this._getNextNodes(node.id, adj);
							break;

						case WorkflowNodeType.End:
							nodeState.status = WorkflowNodeExecutionStatus.Completed;
							nodeState.endTime = new Date().toISOString();
							executionState.nodeStates.set(node.id, nodeState);
							this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });
							return;

						case WorkflowNodeType.Task:
							await this._executeTaskNode(executionState, workflow, node, options);
							nextNodeIds = this._getNextNodes(node.id, adj);
							break;

						case WorkflowNodeType.Prompt:
							await this._executePromptNode(executionState, workflow, node, options);
							nextNodeIds = this._getNextNodes(node.id, adj);
							break;

						case WorkflowNodeType.Agent:
							await this._executeAgentNode(executionState, workflow, node, options);
							nextNodeIds = this._getNextNodes(node.id, adj);
							break;

						case WorkflowNodeType.Skill:
							await this._executeSkillNode(executionState, workflow, node, options);
							nextNodeIds = this._getNextNodes(node.id, adj);
							break;

						case WorkflowNodeType.Tool:
							await this._executeToolNode(executionState, workflow, node, options);
							nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				case WorkflowNodeType.IfElse:
				case WorkflowNodeType.Switch:
					// Control flow: evaluate condition and follow branch
					nextNodeIds = await this._executeIfElseNode(executionState, workflow, node, adj, options);
					break;


				case WorkflowNodeType.AskUser:
				// AskUser node: pause and wait for user input
				const userInput = await this._executeAskUserNode(executionState, workflow, node, adj);
				// 将用户输入存储到上下文
				executionState.context['userInput'] = userInput;

				// v30: port-based routing. Each ask_user option maps to an
				// edge whose `fromPort` is 'option-0' / 'option-1' / ...
				// Only follow edges matching the user's selection(s), so
				// "暂不提交" doesn't accidentally flow into the git-commit
				// agent branch. Fall back to all edges when no port-specific
				// edges exist (backward compat for old workflows).
				{
					const askData = node.data ?? {};
					const askOptions = (askData.options as IAskUserOption[]) ?? [];
					const selections = Array.isArray(userInput) ? userInput : [userInput];
					const selectedIndices: number[] = [];
					for (const sel of selections) {
						const idx = askOptions.findIndex(opt => opt.label === sel);
						if (idx >= 0) { selectedIndices.push(idx); }
					}
					if (selectedIndices.length > 0) {
						nextNodeIds = this._getAskUserNextNodes(node.id, adj, selectedIndices);
						if (nextNodeIds.length === 0) {
							this.logService.warn(`[WorkflowExecution] AskUser ${node.id}: no edges matched selected options [${selectedIndices.join(',')}], falling back to all edges`);
							nextNodeIds = this._getNextNodes(node.id, adj);
						}
					} else {
						nextNodeIds = this._getNextNodes(node.id, adj);
					}
				}
				break;

				case WorkflowNodeType.Comfy:
				case WorkflowNodeType.ComfyStage:
					await this._executeComfyNode(executionState, workflow, node, options);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				case WorkflowNodeType.Picker:
					// ⚠ 已废弃（2026-09-11 单链路改造）：Picker 家族现归一为 comfyStage，
					//   由 _executeComfyNode 的交互段（catalog apply:'snapshot'）接管。
					//   保留此 case 仅防御历史数据里显式 type='picker' 的节点。
					await this._executeComfyNode(executionState, workflow, node, options);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				case WorkflowNodeType.Script:
					// ★ P1-4：动态工作流脚本作为 DAG 节点（复用 executeWorkflowScript 委托）。
					await this._executeScriptNode(executionState, workflow, node, options);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				default:
					this.logService.warn(`[WorkflowExecution] Unknown node type: ${node.type}, skipping`);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;
			}
					// Success — exit the retry loop.
					break;
			} catch (innerErr) {
				// Never retry cancelled executions.
					if ((executionState.status as string) === 'cancelled') {
						throw innerErr;
					}
					// Last attempt — re-throw to the outer catch handler.
					if (attempt >= retryMaxAttempts) {
						throw innerErr;
					}
					// Calculate exponential backoff delay with jitter.
					const baseDelay = Math.min(
						retryMaxMs,
						retryInitialMs * Math.pow(retryMultiplier, attempt),
					);
					// Add ±20% jitter to avoid thundering herd.
					const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
					const delay = Math.round(baseDelay + jitter);
					this.logService.warn(
						`[WorkflowExecution] Node ${node.id} failed (attempt ${attempt + 1}/${retryMaxAttempts + 1}), ` +
						`retrying in ${delay}ms: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
					);
					// Reset node state for retry.
					nodeState.status = WorkflowNodeExecutionStatus.Running;
					nodeState.error = undefined;
					nodeState.endTime = undefined;
					executionState.nodeStates.set(node.id, nodeState);
					this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });
					await new Promise(resolve => setTimeout(resolve, delay));
				}
			}

			// ★ 取消短路（2026-09-11）：节点执行期间被取消（交互暂停被解开 / delegate
			//   执行中取消）→ 节点内已标 Cancelled 并发过 subagent_end(cancelled)。
			//   此处必须 return：否则会无条件把状态覆盖回 Completed 并发
			//   subagent_end('done') —— 卡片 spinner 继续转、状态与「已取消」自相矛盾，
			//   下游也会被继续递归（直到各自的入口检查才停）。
			if (this._bailOutIfCancelled(executionState, node)) { return; }

			// Mark node as completed
			nodeState.status = WorkflowNodeExecutionStatus.Completed;
			nodeState.endTime = new Date().toISOString();
			// v30: AskUser nodes store the selected labels as their output
			if (node.type === WorkflowNodeType.AskUser && nodeState.output === undefined) {
				const ctxInput = executionState.context['userInput'];
				if (ctxInput !== undefined) {
					nodeState.output = Array.isArray(ctxInput) ? (ctxInput as string[]).join(', ') : (ctxInput as string);
				}
			}
			// v37: Prompt nodes store their (already-substituted) prompt text
			// as output so downstream nodes can reference it via {{$prev.output}}.
			// Without this, _collectUpstreamOutputs finds no output for the
			// prompt node, causing {{$prev.output}} to resolve to empty in the
			// downstream agent node — which then falls back to workflow
			// description instead of the user's actual input.
			if (node.type === WorkflowNodeType.Prompt && nodeState.output === undefined) {
				const promptText = (node.data as { prompt?: string })?.prompt;
				if (promptText) {
					nodeState.output = promptText;
					this.logService.info(
						`[WorkflowExecution] Prompt node ${node.id}: stored output (len=${promptText.length}) for downstream {{$prev.output}}`,
					);
				}
			}
			executionState.nodeStates.set(node.id, nodeState);
			this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });

			// ★ 节点级 trace 收尾（2026-09-10）：与上方统一 subagent_start 配对。
			//   output 截断到 400 字符（媒体节点 output 是 data URL/ref，卡片不需要全文）。
			//   AskUser 跳过（与 start 侧同因：专属交互卡已展示，双卡去重）。
			// ★ 规则单点化（2026-09-13 P2-6）：与 start 侧同一规则表。
			if (nodeOwner && isNodeVisibleOnCard(workflow.connections, node)) {
				this._onDidExecutionTrace.fire({
					kind: 'subagent_end',
					executionId: executionState.executionId,
					sessionId: nodeOwner.sessionId,
					nodeId: node.id,
					status: 'done',
					// ★ P2-5 收敛（2026-09-13）：长度上限统一到 CARD_TEXT_LIMITS（值不变）。
					output: nodeState.output !== undefined ? String(nodeState.output).substring(0, CARD_TEXT_LIMITS.nodeOutput) : '',
					// ★ 媒体快照透传（2026-09-10）：媒体节点（StatEmojiStage 等）的
					//   output 只是引用文本，卡片要渲染缩略图必须有 snapshot
					//   （port/kind/ref）——节点卡展示生成结果的直接来源。
					...(nodeState.snapshot && nodeState.snapshot.length > 0 ? { snapshot: nodeState.snapshot } : {}),
				});
			}

			// v32: write node output to SharedMemory for cross-node communication.
			// ★ 2026-09-11 补齐读路径：此前 sharedMemory **只写不读**（全服务无消费点）
			//   → 注释承诺的「Any downstream node can read this」从未成立。现在两条通路：
			//   ① 键 = nodeId → 下游 `{{<nodeId>}}` / `{{<nodeId>.output}}`（与 nodeStates 等价）；
			//   ② 节点声明 `data.publishes`（语义名，字符串或数组）→ 下游 `{{shared.<key>}}`
			//      —— **下游无需知道是哪个节点产出的**，这是多 Agent 协同里按语义引用的关键。
			//   `parseSharedPublishKeys` 会丢弃无法被 `{{shared.<key>}}` 替换的键（防静默失效）。
			if (nodeState.output !== undefined) {
				const outputText = String(nodeState.output);
				executionState.sharedMemory.set(node.id, outputText);
				for (const key of parseSharedPublishKeys((node.data as Record<string, unknown> | undefined)?.publishes)) {
					executionState.sharedMemory.set(key, outputText);
				}
			}

			// v32: save checkpoint after node success
			this._saveCheckpoint(executionState).catch(() => { /* best-effort */ });

			// Execute next nodes —— ★ v38 join 语义：入度归零才执行（等待全部前驱）。
			for (const nextNodeId of nextNodeIds) {
				const d = (inDeg.get(nextNodeId) ?? 1) - 1;
				inDeg.set(nextNodeId, d);
				if (d > 0) {
					this.logService.info(`[WorkflowExecution] Node ${nextNodeId} waiting for ${d} more upstream node(s) (join)`);
					continue;
				}
				const nextNode = workflow.nodes?.find(n => n.id === nextNodeId);
				if (nextNode) {
					await this._executeNodeRecursive(executionState, workflow, nextNode, adj, options, visited, depth + 1, maxDepth, inDeg);
				}
			}
		} catch (err) {
			// v21: distinguish cancellation from real failures. When the user
			// clicks Cancel, _abortActiveStream() flips the AbortController, the
			// stream loop breaks, and _sendAndTrackStream's `finally` cleans up.
			// sendMessage() returns with whatever was accumulated so the node
			// executor usually does NOT throw — the cancel propagates as a normal
			// return. But if a node was already mid-await when cancel fired and
			// throws (e.g. inner network error from the abort), we should NOT
			// mark the whole execution as Failed — the user explicitly cancelled
			// it. Detect by status flag instead of by error message to keep
			// semantics independent of error wording.
			// Note: use string comparison rather than enum equality here —
			// the early `if (status === Cancelled) return` above narrows the
			// status type inside the try block, which the catch block inherits,
			// so a direct enum comparison would be flagged TS2367 (no overlap).
			if ((executionState.status as string) === 'cancelled') {
				// Mark this node as cancelled (not failed) and let the natural
				// `_executeWorkflowAsync` end-of-loop `execution_end` fire.
				nodeState.status = WorkflowNodeExecutionStatus.Cancelled;
				nodeState.endTime = new Date().toISOString();
				executionState.nodeStates.set(node.id, nodeState);
				this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });
				// ★ 失败/取消也必须发 subagent_end trace（2026-09-10 实测卡只显示 spinner
				//   不显示错误信息）：success 分支 L1163 发硬编码 done；失败/取消路径
				//   此前不发 → WorkflowTraceController._handleSubagentEnd 永远收不到 →
				//   subAgent.status 永远 running → 节点卡 spinner 永转 + error 不可见。
				const cancelOwner = this._executionSession.get(executionState.executionId);
				// ★ 规则单点化（2026-09-13 P2-6）：与成功分支同一规则表 ——
				//   此前此处漏了 FLOW 筛选（过滤不对称），导致非 FLOW 节点取消时发出
				//   没有对应卡片的 end 事件 → controller 静默丢弃 ✗。收敛后结构上不可能再漏。
				if (cancelOwner && isNodeVisibleOnCard(workflow.connections, node)) {
					this._onDidExecutionTrace.fire({
						kind: 'subagent_end',
						executionId: executionState.executionId,
						sessionId: cancelOwner.sessionId,
						nodeId: node.id,
						status: 'cancelled',
						output: '',
					});
				}
				return;
			}
			// v32: Cascade failure — instead of immediately failing the entire
			// execution, mark this node as Failed and recursively skip all
			// downstream nodes (they cannot run without upstream output).
			// Other independent branches continue normally. The execution
			// is marked Failed at the end only if any node actually failed.
			nodeState.status = WorkflowNodeExecutionStatus.Failed;
			nodeState.error = err instanceof Error ? err.message : String(err);
			nodeState.endTime = new Date().toISOString();
			executionState.nodeStates.set(node.id, nodeState);
			this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });
			// ★ 失败原因必须落日志（2026-09-10）：此前 error 只存 nodeState——
			//   排查「缺少阶段」时日志里只有 Cascade skipped，看不到根因。
			this.logService.error(
				`[WorkflowExecution] Node ${this._nodeDisplayName(node)} (${node.id}, ${node.type}) FAILED: ${nodeState.error}` +
				(err instanceof Error && err.stack ? `\n${err.stack}` : ''),
			);

			// ★ 失败也必须发 subagent_end trace（2026-09-10）：success 分支硬编码
			//   status='done'，失败路径不补 → 节点卡 status 永远 running → spinner
			//   永转 + 错误不可见（用户反馈）。
			const failOwner = this._executionSession.get(executionState.executionId);
			// ★ 规则单点化（2026-09-13 P2-6）：与成功/取消分支同一规则表。
			if (failOwner && isNodeVisibleOnCard(workflow.connections, node)) {
				this._onDidExecutionTrace.fire({
					kind: 'subagent_end',
					executionId: executionState.executionId,
					sessionId: failOwner.sessionId,
					nodeId: node.id,
					status: 'error',
					output: nodeState.error ?? '',
					error: nodeState.error ?? '',
				});
			}

			// Collect all downstream node IDs reachable from this failed node.
			this._cascadeSkipDownstream(executionState, node.id, adj);
			// Do NOT throw — let the execution continue for other branches.
			return;
		}
	}

	/**
	 * v32: Cascade failure — recursively mark all downstream nodes reachable
	 * from a failed node as Skipped. This prevents the execution engine from
	 * trying to execute nodes that depend on missing upstream output.
	 * Independent parallel branches are unaffected.
	 */
	private _cascadeSkipDownstream(
		executionState: IWorkflowExecutionState,
		failedNodeId: string,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		visited = new Set<string>(),
	): void {
		if (visited.has(failedNodeId)) { return; }
		visited.add(failedNodeId);

		const downstream = adj.get(failedNodeId);
		if (!downstream) { return; }

		for (const { targetId } of downstream) {
			if (visited.has(targetId)) { continue; }
			// Only skip nodes that haven't already started/run/failed.
			// If a node already Failed (its own error, not cascade), don't overwrite with Skipped.
			const existingState = executionState.nodeStates.get(targetId);
			if (existingState && (
				existingState.status === WorkflowNodeExecutionStatus.Completed ||
				existingState.status === WorkflowNodeExecutionStatus.Running ||
				existingState.status === WorkflowNodeExecutionStatus.Failed
			)) { continue; }

			const skippedState: IWorkflowNodeExecutionState = {
				nodeId: targetId,
				status: WorkflowNodeExecutionStatus.Skipped,
				output: undefined,
				error: `Upstream node "${failedNodeId}" failed`,
				startTime: new Date().toISOString(),
				endTime: new Date().toISOString(),
			};
			executionState.nodeStates.set(targetId, skippedState);
			this._onDidNodeExecutionStatusChange.fire({
				executionId: executionState.executionId,
				nodeState: { ...skippedState },
			});
			this.logService.info(
				`[WorkflowExecution] Cascade: skipped node ${targetId} because upstream ${failedNodeId} failed`,
			);
			// Recurse to skip this node's downstream too.
			this._cascadeSkipDownstream(executionState, targetId, adj, visited);
		}
	}

	// --------------------------------------------------------------------------------------------
	// Node Executors
	// --------------------------------------------------------------------------------------------

	private async _executeTaskNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Task node: ${node.id}`);
		// ★ P1-2 修复（2026-09-13）：与 Agent 节点同因 —— Task 节点此前**不 fire 节点状态
		//   变化** → 画布卡片停在 idle（`onDidNodeExecutionStatusChange` → `sendFullStateFor`
		//   是画布卡状态的唯一来源）。补齐前/后 fire。
		const taskNodeState = executionState.nodeStates.get(node.id)
			?? { nodeId: node.id, status: WorkflowNodeExecutionStatus.Running, startTime: new Date().toISOString() };
		taskNodeState.status = WorkflowNodeExecutionStatus.Running;
		taskNodeState.startTime = taskNodeState.startTime ?? new Date().toISOString();
		executionState.nodeStates.set(node.id, taskNodeState);
		this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...taskNodeState } });
		const data = node.data ?? {};
		// v9: prefer data.prompt (configured via PropertyPanel), then data.label, then node.name.
		// Never use hardcoded fallbacks that could cause the agent to call unrelated skills.
		const taskDescription = (data.prompt as string) || (data.label as string) || node.name || '';

		// 获取 agent ID（优先使用 options 中的，否则使用 workflow 的 agentId）
		const agentId = _options?.agentId || workflow.agentId;
		if (!agentId) {
			throw new Error(`Task node ${node.id}: No agent ID available (workflow.agentId is empty and no options.agentId)`);
		}

		try {
			// 发送任务描述给 Agent
			this.logService.info(`[WorkflowExecution] Sending task to agent ${agentId}: ${taskDescription}`);
			// v21: route through _sendAndTrackStream so cancelExecution can abort
			// the in-flight LLM call. Previously the bare `sendMessage` await
			// kept running even after status flipped to Cancelled, so the UI
			// button had no effect during long agent turns.
			// 获取或创建 agent session，避免消息被 cross-session leakage guard 丢弃
			const taskSessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
			const taskSessionId = await this._getOrCreateAgentSession(
				agentId,
				executionState.executionId,
				taskSessionName,
			);
			const message = await this._sendAndTrackStream(
				executionState,
				node,
				agentId,
				taskDescription,
				taskSessionId,
				(delta) => {
					// 可选：转发流式响应
					this.logService.debug(`[WorkflowExecution] Task ${node.id} delta: ${delta.content?.substring(0, 50)}`);
				},
			);

			// 记录执行结果
			const nodeState = executionState.nodeStates.get(node.id);
			if (nodeState) {
				nodeState.output = message.content || '';
				// ★ P1-2（2026-09-13）：终态 fire → 画布卡翻到「完成 / 已取消」。
				const wasCancelledNow = (executionState.status as string) === 'cancelled';
				nodeState.status = wasCancelledNow
					? WorkflowNodeExecutionStatus.Cancelled
					: WorkflowNodeExecutionStatus.Completed;
				nodeState.endTime = new Date().toISOString();
				this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });
				// ★ P1-2 产物部分（2026-09-13）：Task 的文本输出写进画布快照库
				//   （与 Agent 节点同款；meta 用 text/plain，不冒充 sarosJson）。
				if (!wasCancelledNow && typeof nodeState.output === 'string' && nodeState.output) {
					putWorkflowSnapshotMedia({
						anchorUid: node.id,
						port: 'output',
						kind: 'text',
						ref: nodeState.output.substring(0, AGENT_OUTPUT_SNAPSHOT_MAX),
						meta: { taskNode: '1', mime: 'text/plain' },
					});
				}
			}

			this.logService.info(`[WorkflowExecution] Task ${node.id} completed: ${message.content?.substring(0, 100)}`);
		} catch (err) {
			// ★ P1-2（2026-09-13）：失败也 fire 状态 → 画布卡显示红叉（与 Agent 节点同）。
			const taskNsFail = executionState.nodeStates.get(node.id);
			if (taskNsFail) {
				taskNsFail.status = WorkflowNodeExecutionStatus.Failed;
				taskNsFail.error = err instanceof Error ? err.message : String(err);
				taskNsFail.endTime = new Date().toISOString();
				executionState.nodeStates.set(node.id, taskNsFail);
				this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...taskNsFail } });
			}
			this.logService.error(`[WorkflowExecution] Task ${node.id} failed:`, err);
			throw err;
		}
	}

	private async _executePromptNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Prompt node: ${node.id}`);
		const data = node.data ?? {};
		const promptText = (data.prompt as string) || '';

		if (!promptText) {
			this.logService.warn(`[WorkflowExecution] Prompt node ${node.id} has empty prompt`);
			return;
		}

		// 获取 agent ID
		const agentId = _options?.agentId || workflow.agentId;
		if (!agentId) {
			throw new Error(`Prompt node ${node.id}: No agent ID available`);
		}

		try {
			// Get or create a session for this workflow execution to avoid cross-session leakage.
			const sessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
			const agentSessionId = await this._getOrCreateAgentSession(
				agentId,
				executionState.executionId,
				sessionName,
			);

			// 将提示作为用户消息追加到聊天历史
			this.logService.info(`[WorkflowExecution] Appending prompt to agent ${agentId} (session=${agentSessionId}): ${promptText.substring(0, 100)}`);
			await this.agentChatService.appendMessage(agentId, {
				id: `prompt_${node.id}_${Date.now()}`,
				role: 'user',
				content: promptText,
				timestamp: new Date().toISOString(),
				agentSessionId,
			} as any);

			this.logService.info(`[WorkflowExecution] Prompt ${node.id} appended successfully`);
		} catch (err) {
			this.logService.error(`[WorkflowExecution] Prompt ${node.id} failed:`, err);
			throw err;
		}
	}

	private async _executeAgentNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Agent node: ${node.id}`);
		// ★ P1-2 修复（2026-09-13）：Agent 节点此前**不 fire 节点状态变化** → 画布卡片
		//   停在 idle（既无「运行中」也无「完成」），而同一工作流里的 Comfy 节点是正常的 ✗。
		//   host 的 `onDidNodeExecutionStatusChange` → `sendFullStateFor` 是**画布卡状态的
		//   唯一来源**（见 agentStudioWebviewController 的注册处）→ 这里补齐前/后两次 fire。
		const agentNodeState = executionState.nodeStates.get(node.id)
			?? { nodeId: node.id, status: WorkflowNodeExecutionStatus.Running, startTime: new Date().toISOString() };
		agentNodeState.status = WorkflowNodeExecutionStatus.Running;
		agentNodeState.startTime = agentNodeState.startTime ?? new Date().toISOString();
		executionState.nodeStates.set(node.id, agentNodeState);
		this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...agentNodeState } });
		const data = node.data ?? {};
		const agentId = (data.agentId as string) || options?.agentId;
		const ownerSession = this._executionSession.get(executionState.executionId);

		if (!agentId) {
			throw new Error(`Agent node ${node.id} has no agentId`);
		}

		// v10: build prompt from node config, with task context as fallback.
		// Only the FIRST agent node receives the taskDescription — once consumed,
		// we clear it so subsequent nodes must use their own data.prompt.
		//
		// v32: _substituteUpstreamVariables mutates data.prompt in-place before
		// we reach here. If the original prompt was a variable template like
		// {{$prev.output}} and the upstream output was empty, data.prompt is
		// now '' — which looks like "no prompt configured". We must distinguish
		// "user didn't write a prompt" from "user wrote a template that resolved
		// to empty because the upstream node didn't produce output".
		// To do this, check whether the ORIGINAL node data has a non-empty
		// prompt property BEFORE substitution happened. We use the node's own
		// data (via the workflow.nodes) since data.prompt has been mutated.
		const workflowNode = workflow.nodes?.find(n => n.id === node.id);
		const originalPrompt = (workflowNode?.data?.prompt as string) || '';
		const hadExplicitPrompt = !!originalPrompt;

		let nodePrompt = (data.prompt as string) || '';
		if (!nodePrompt && !hadExplicitPrompt) {
			const ctx = executionState.context;
			const consumed = (ctx?._taskConsumed as boolean) || false;
			const taskDesc = consumed ? undefined : (ctx?.taskDescription as string | undefined);
			if (taskDesc) {
				nodePrompt = taskDesc;
				// Mark the task context as consumed so subsequent agent nodes
				// don't accidentally pick it up.
				ctx!['_taskConsumed'] = true;
				this.logService.info(
					`[WorkflowExecution] Agent node ${node.id} (FIRST) using task context: "${taskDesc.substring(0, 80)}"`,
				);
			}
		}

		if (!nodePrompt && !hadExplicitPrompt) {
			// No explicit prompt — build a sensible fallback from workflow description
			// or node label instead of skipping execution.
			// v32: only fall back when the user genuinely didn't configure a prompt
			// (not when a {{$prev.output}} variable resolved to empty).
			const fallback = (workflow.description || '').trim() ||
				`Run the "${(data.label as string) || node.name || node.id}" agent with default instructions.`;
			nodePrompt = fallback;
			this.logService.info(
				`[WorkflowExecution] Agent node ${node.id} ("${node.name || ''}") has no explicit prompt — ` +
				`using fallback: "${fallback.substring(0, 80)}"`,
			);
		}

		// v32: when a variable template was configured but resolved to empty
		// (upstream didn't produce output), provide a clear diagnostic message
		// instead of sending empty instructions.
		if (!nodePrompt && hadExplicitPrompt) {
			nodePrompt = `The upstream node's output is empty — no content to work with. ` +
				`Original prompt template: <template>${originalPrompt}</template>. ` +
				`This agent node was supposed to receive upstream output but none was produced. ` +
				`Please check the upstream node's execution logs.`;
			this.logService.warn(
				`[WorkflowExecution] Agent node ${node.id} ("${node.name || ''}") prompt resolved to empty ` +
				`after variable substitution (original template: "${originalPrompt}"). ` +
				`Using diagnostic fallback.`,
			);
		}

		// P4: fire subagent_start so the workflow owner chat opens a subagent card
		if (ownerSession) {
			this._onDidExecutionTrace.fire({
				kind: 'subagent_start',
				executionId: executionState.executionId,
				workflowAgentId: ownerSession.workflowAgentId,
				sessionId: ownerSession.sessionId,
				nodeId: node.id,
				nodeName: (data.label as string) || node.name || node.id,
				nodeType: 'agent',
				task: nodePrompt.substring(0, CARD_TEXT_LIMITS.subtitle),
				// ★ P0 修复（2026-09-13）：Agent 节点图标（此前渲染层恰好命中旧表，
				//   现在统一由 host 给出，保证与其它节点同一套推导路径）。
				icon: '🤖',
			});
		} else {
			this.logService.warn(
				`[WorkflowExecution] _executeAgentNode: ownerSession not found for executionId=${executionState.executionId}, ` +
				`subagent_start event not fired — subagent cards will not show in chat. ` +
				`Check that workflow.agentId is set and executeWorkflow() successfully created the owner session.`,
			);
		}

		try {
			// 使用指定 agent 执行（发送一个继续的提示）
			const continuePrompt = nodePrompt;

			// v31: contextScope — controls how much conversation context the
			// agent node receives. Default 'session' keeps the old behaviour
			// (shared session with full history).
			const scope = ((data.contextScope as string) || 'session') as 'session' | 'upstream-only' | 'fresh';
			let agentSessionId: string;
			let extraOpts: { systemPrompt?: string } | undefined;

			if (scope === 'fresh') {
				// Fresh: fully isolated — new session, no upstream context.
				const sessionName = `${WorkflowExecutionService._buildSessionName(executionState, workflow)}_${node.id}`;
				const meta = await this.agentChatService.createAgentSession(agentId, sessionName);
				agentSessionId = meta.id;
				this.logService.info(`[WorkflowExecution] Agent node ${node.id}: contextScope=fresh, new session=${agentSessionId}`);
			} else if (scope === 'upstream-only') {
				// Upstream-only: new session with only upstream node outputs
				// injected as a system message — no prior conversation history.
				const sessionName = `${WorkflowExecutionService._buildSessionName(executionState, workflow)}_${node.id}`;
				const meta = await this.agentChatService.createAgentSession(agentId, sessionName);
				agentSessionId = meta.id;

				// Build upstream context as a system prompt from completed node outputs.
				const upstreamOutputs = this._collectUpstreamOutputs(executionState);
				const upstreamEntries = Object.entries(upstreamOutputs);
				if (upstreamEntries.length > 0) {
					const sections = upstreamEntries.map(([nid, out]) =>
						`<upstream_node id="${nid}">\n${out || '(empty output)'}\n</upstream_node>`,
					);
					extraOpts = {
						systemPrompt: [
							'You are executing a step in a workflow. Below are the outputs from ' +
							'previously completed steps. Use them as context for your task.',
							'',
							...sections,
						].join('\n'),
					};
				}
				this.logService.info(
					`[WorkflowExecution] Agent node ${node.id}: contextScope=upstream-only, ` +
					`new session=${agentSessionId}, upstream nodes=${upstreamEntries.length}`,
				);
			} else {
				// Session (default): shared session for this agent+execution,
				// full conversation history available.
				const sessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
				agentSessionId = await this._getOrCreateAgentSession(
					agentId,
					executionState.executionId,
					sessionName,
				);
			}

			this.logService.info(`[WorkflowExecution] Sending to agent ${agentId} (session=${agentSessionId}, scope=${scope}): ${continuePrompt}`);

			// v21: route through _sendAndTrackStream so cancelExecution can abort
			// the in-flight LLM call.
			const nodeData = data as Record<string, any>;
			const timeoutConfig = {
				runTimeoutMs: nodeData.timeoutRunMs as number | undefined,
				idleTimeoutMs: nodeData.timeoutIdleMs as number | undefined,
			};
			const message = await this._sendAndTrackStream(
				executionState,
				node,
				agentId,
				continuePrompt,
				agentSessionId,
				(delta) => {
					this.logService.debug(`[WorkflowExecution] Agent ${node.id} delta: ${delta.content?.substring(0, 50)}`);

					// P4: forward delta to owner chat as subagent progress.
					// Strip non-serializable fields if any (delta.content is fine; metadata may be omitted).
					if (ownerSession) {
						this._onDidExecutionTrace.fire({
							kind: 'delta',
							executionId: executionState.executionId,
							sessionId: ownerSession.sessionId,
							nodeId: node.id,
							delta: this._sanitizeDelta(delta),
						});
					}
				},
				extraOpts,
				timeoutConfig,
			);

			// 记录执行结果
			const nodeState = executionState.nodeStates.get(node.id);
			if (nodeState) {
				nodeState.output = message.content || '';
				// ★ P1-2 修复（2026-09-13）：终态也要 fire → 画布卡从「运行中」翻到
				//   「完成 / 已取消」（此前只改 output、不通知 → 画布卡永远停在 idle ✗）。
				const wasCancelledNow = (executionState.status as string) === 'cancelled';
				nodeState.status = wasCancelledNow
					? WorkflowNodeExecutionStatus.Cancelled
					: WorkflowNodeExecutionStatus.Completed;
				nodeState.endTime = new Date().toISOString();
				this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });
				// ★ P1-2 产物部分（2026-09-13）：Agent 的**文本输出**写进画布快照库
				//   → 画布卡 OUTPUT 区可见（此前 host 驱动路径下画布完全没有产物，
				//   而画布本地执行同一节点时是有的 —— 同一节点两处表现不一致 ✗）。
				//   形态与画布本地执行 Agent（graphNodeExecutors）一致（kind:'text'）；
				//   但 meta 用 text/plain —— **不冒充** `sarosJson`（那会被下游当作
				//   SAROS_JSON 归档解析 ✗）。长度上限见 AGENT_OUTPUT_SNAPSHOT_MAX。
				if (!wasCancelledNow && typeof nodeState.output === 'string' && nodeState.output) {
					putWorkflowSnapshotMedia({
						anchorUid: node.id,
						port: 'output',
						kind: 'text',
						ref: nodeState.output.substring(0, AGENT_OUTPUT_SNAPSHOT_MAX),
						meta: { agentNode: '1', mime: 'text/plain' },
					});
				}
			}

			// v21: if the execution was cancelled mid-stream, fire subagent_end
			// with status 'cancelled' so the webview card flips to the cancelled
			// badge instead of the "done" success badge. The sendMessage await
			// returns with partial content (no throw) when AbortController is
			// tripped, so we have to detect cancel via the execution status.
			const wasCancelled = (executionState.status as string) === 'cancelled';
			if (ownerSession) {
				this._onDidExecutionTrace.fire({
					kind: 'subagent_end',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					status: wasCancelled ? 'cancelled' : 'done',
					output: message.content?.substring(0, CARD_TEXT_LIMITS.agentOutput) || '',
				});
			}

			this.logService.info(`[WorkflowExecution] Agent ${node.id} completed`);
		} catch (err) {
			// P4: surface errors to owner chat too.
			if (ownerSession) {
				this._onDidExecutionTrace.fire({
					kind: 'subagent_end',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					status: 'error',
					error: err instanceof Error ? err.message : String(err),
				});
			}
			// ★ P1-2（2026-09-13）：失败也 fire 状态 → 画布卡显示红叉，而不是一直「运行中」。
			const nsFail = executionState.nodeStates.get(node.id);
			if (nsFail) {
				nsFail.status = WorkflowNodeExecutionStatus.Failed;
				nsFail.error = err instanceof Error ? err.message : String(err);
				nsFail.endTime = new Date().toISOString();
				executionState.nodeStates.set(node.id, nsFail);
				this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nsFail } });
			}
			this.logService.error(`[WorkflowExecution] Agent ${node.id} failed:`, err);
			throw err;
		}
	}

	/**
	 * Strip a streaming delta of any non-serializable fields before sending
	 * it through the structured-clone boundary (host→webview). The delta has
	 * a few well-known fields: type, content, toolCallId, toolName, etc.
	 */
	private _sanitizeDelta(delta: any): Record<string, unknown> {
		if (!delta || typeof delta !== 'object') { return {}; }
		const out: Record<string, unknown> = {};
		const copyKeys = [
			'type', 'content', 'toolCallId', 'toolName', 'displayName', 'renderType',
			'defaultShow', 'arguments', 'metadata', 'progressData', 'confirmationData',
			'todosData', 'tipsData', 'questionsData', 'references', 'usage',
		];
		for (const k of copyKeys) {
			if (k in delta) { out[k] = delta[k]; }
		}
		return out;
	}

	/**
	 * v11: build a human-readable session name for the workflow execution.
	 * If the execution was triggered from a task, use "执行任务: {taskTitle}".
	 * Otherwise fall back to "workflow-{name}".
	 */
	private static _buildSessionName(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
	): string {
		const taskTitle = executionState.context?.taskTitle as string | undefined;
		if (taskTitle) {
			// Truncate long task titles to keep the session name readable.
			const short = taskTitle.length > 50 ? taskTitle.substring(0, 50) + '…' : taskTitle;
			return `执行任务: ${short}`;
		}
		return `workflow-${workflow.name || workflow.id}`;
	}

	/**
	 * Get or create an agent session for a workflow execution.
	 * Cached by (agentId, executionId) so all nodes in the same execution
	 * for the same agent share one session.
	 */
	private async _getOrCreateAgentSession(
		agentId: string,
		executionId: string,
		sessionName: string,
	): Promise<string> {
		const key = `${agentId}:${executionId}`;
		const cached = this._sessionCache.get(key);
		if (cached) {
			return cached;
		}

		const meta = await this.agentChatService.createAgentSession(agentId, sessionName);
		this._sessionCache.set(key, meta.id);
		this.logService.info(`[WorkflowExecution] Created agent session ${meta.id} for ${agentId} (execution=${executionId})`);
		return meta.id;
	}

	/**
	 * 阶段 1：从 AskUser 的字段定义与回答中收集**媒体资产**（kind='image'）。
	 * 约定：image 类型字段的值是**资产引用**（MediaSnapshotStore 的 ref / 快照引用），
	 * 不内联 data URL——避免 JSON 膨胀、支持复用与懒加载。非 image 字段不进 assets。
	 */
	/**
	 * 阶段 2：解析结构化引用 `{ node, path }`。
	 * 数据源 = 目标节点的 output（若是 AskUser 契约 JSON 则按路径取子值，
	 * 否则整段作为文本）。路径支持 `params.x` / `assets.x` / `labels.0`；
	 * 空 path = 整段 output。解析不到 → warn + undefined（调用方回落模板/default）。
	 */
	private _resolveStructuredRef(
		executionState: IWorkflowExecutionState,
		nodeId: string,
		path: string,
		bindingKey: string,
	): unknown {
		const ns = executionState.nodeStates.get(nodeId);
		if (!ns || ns.output === undefined) {
			this.logService.warn(`[WorkflowExecution] $ref 悬空：节点 ${nodeId} 无输出（binding=${bindingKey}）`);
			return undefined;
		}
		const raw = ns.output;
		// 契约 JSON（AskUser 等数据源节点）→ 按路径取值
		if (typeof raw === 'string' && raw.trim().startsWith('{')) {
			try {
				const obj = JSON.parse(raw) as unknown;
				if (obj && typeof obj === 'object') {
					if (!path) { return obj; }
					const value = path.split('.').reduce<unknown>((acc, seg) => {
						if (acc && typeof acc === 'object') {
							return (acc as Record<string, unknown>)[seg];
						}
						return undefined;
					}, obj);
					if (value === undefined) {
						this.logService.warn(`[WorkflowExecution] $ref 路径不存在：${nodeId}.${path}（binding=${bindingKey}）`);
						return undefined;
					}
					return value;
				}
			} catch { /* 非 JSON → 整段文本 */ }
		}
		return raw;
	}

	private static _collectAskUserAssets(
		fields: IAskUserField[],
		params: Record<string, string>,
	): Record<string, string> {
		const out: Record<string, string> = {};
		for (const f of fields) {
			if (f.kind !== 'image') { continue; }
			const v = typeof params[f.key] === 'string' ? (params[f.key] as string).trim() : '';
			if (v) { out[f.key] = v; }
		}
		return out;
	}

	/**
	 * 解析 `data.questions`（多问题，2026-09-11）。返回空数组 = 走旧的单问题路径。
	 *
	 * 容错：非法 JSON / 非数组 → 空数组（回落旧字段，不让节点因配置脏数据而失败）；
	 * 每问题 key 缺省 `q{i+1}`、text 缺省空、mode 缺省 options；options 支持字符串
	 * 简写（`["A","B"]`）；无内容（无 text/options/params）的问题被丢弃。
	 */
	private static _parseAskUserQuestions(data: Record<string, unknown>): IAskUserQuestion[] {
		const raw = data.questions;
		let arr: unknown = raw;
		if (typeof raw === 'string') {
			if (!raw.trim()) { return []; }
			try { arr = JSON.parse(raw); } catch { return []; }
		}
		if (!Array.isArray(arr)) { return []; }
		const out: IAskUserQuestion[] = [];
		arr.forEach((item, i) => {
			const q = (item ?? {}) as Record<string, unknown>;
			const key = String(q.key ?? '').trim() || `q${i + 1}`;
			const text = String(q.text ?? '').trim();
			const mode: 'options' | 'params' = q.mode === 'params' ? 'params' : 'options';
			const options = Array.isArray(q.options)
				? (q.options as unknown[])
					.map(o => typeof o === 'string' ? { label: o } : (o as IAskUserOption))
					.filter(o => o && typeof o.label === 'string' && o.label.trim())
				: [];
			const params = Array.isArray(q.params)
				? (q.params as unknown[])
					.map(p => p as IAskUserField)
					.filter(p => p && typeof p.key === 'string' && p.key.trim())
				: [];
			if (!text && options.length === 0 && params.length === 0) { return; }
			out.push({
				key, text, mode,
				required: q.required === true,
				options, params,
				multiSelect: q.multiSelect === true,
				allowCustom: q.allowCustom === true,
				customLabel: typeof q.customLabel === 'string' ? q.customLabel : undefined,
			});
		});
		return out;
	}

	private async _executeAskUserNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_adj: Map<string, { targetId: string; fromPort?: string }[]>,
	): Promise<string | string[]> {
		this.logService.info(`[WorkflowExecution] Executing AskUser node: ${node.id}`);
		const data = node.data ?? {};
		let question = (data.question as string) || '请提供更多输入';
		let options = (data.options as IAskUserOption[]) || [];
		// ★ multiSelect / allowCustom 兼容双形态（2026-09-10）：画布表单历史上把它们
		//   当**字符串**存（'yes'/'no'，nodeEditorForm kind:'text'），而这里按 boolean
		//   读 —— `'yes' as boolean` 只是类型断言、运行时仍是字符串，靠 truthy 侥幸
		//   可用；用户填 'Yes'/'true' 之外的任何词（如 'Y'）都静默失效。改为显式归一，
		//   字符串/布尔都认（表单已同步改为 yes/no 下拉，减少手填出错面）。
		const truthyFlag = (v: unknown): boolean => v === true
			|| (typeof v === 'string' && ['yes', 'true', '1', 'on'].includes(v.trim().toLowerCase()));
		const multiSelect = truthyFlag(data.multiSelect);
		const allowCustom = truthyFlag(data.allowCustom);
		const customLabel = (data.customLabel as string) || '其他（请输入）';
		// ★ 多问题（2026-09-11）：data.questions 非空 → 多问题模式。每问题独立
		//   模式（options / params）；空则回落旧的单问题字段（零迁移）。
		const questions = WorkflowExecutionService._parseAskUserQuestions(data);
		// ★ D4：动态参数表单（多字段输入）。fields 定义同 options 一样支持动态覆盖。
		let fields = (data.fields as IAskUserField[]) || [];
		const ownerSession = this._executionSession.get(executionState.executionId);

		// ★ D2 动态参数（2026-09-10）：上游节点输出 SAROS_JSON 形状
		//   `{ question?, options?: [{label, description?}] }` 时**字段级覆盖**静态配置
		//   （借鉴 LangGraph interrupt 载荷模式）——Agent（LLM 运行时生成选项）与
		//   Script 节点可动态出题。静态 data 永远作回落，旧行为 100% 兼容。
		const upstreamIds = (workflow.connections ?? []).filter(c => c.to === node.id).map(c => c.from);
		for (const uid of upstreamIds) {
			const upState = executionState.nodeStates.get(uid);
			if (!upState || upState.status !== WorkflowNodeExecutionStatus.Completed || !upState.output) { continue; }
			try {
				const parsed = JSON.parse(upState.output) as { question?: unknown; options?: unknown; fields?: unknown } | null;
				if (!parsed || typeof parsed !== 'object') { continue; }
				if (typeof parsed.question === 'string' && parsed.question.trim()) { question = parsed.question; }
				// D4：动态字段定义（[{key,label,kind,default}]）——与 options 同级覆盖。
				if (Array.isArray(parsed.fields)) {
					const dynFields = (parsed.fields as unknown[])
						.map(f => f as IAskUserField)
						.filter(f => f && typeof f.key === 'string' && f.key.trim());
					if (dynFields.length > 0) { fields = dynFields; }
				}
				if (Array.isArray(parsed.options)) {
					const dyn = (parsed.options as unknown[])
						.map(o => typeof o === 'string' ? { label: o } : (o as IAskUserOption))
						.filter(o => o && typeof o.label === 'string' && o.label.trim());
					if (dyn.length > 0) {
						options = dyn as IAskUserOption[];
						this.logService.info(`[WorkflowExecution] AskUser ${node.id}: 动态选项覆盖（来自上游 ${uid}，${dyn.length} 项）`);
					} else {
						this.logService.warn(`[WorkflowExecution] AskUser ${node.id}: 上游动态 options 为空数组，回落静态配置`);
					}
				}
			} catch { /* 上游输出非 JSON → 静默回落静态配置（T4 容错） */ }
		}

		try {
			// v4: fire ask_user trace event BEFORE pausing so the webview can render
			// an interactive card in the workflow owner agent's chat. The card will
			// send `workflow.resume` (RPC) when the user picks an option.
			if (ownerSession) {
				const nodeName = this._nodeDisplayName(node);
				// ★ 环节点日志（2026-09-10 卡死排查）：ask_user fire 无日志时无法区分
				//   「fire 未发生（ownerSession 缺失）」与「面板渲染断链」。
				this.logService.info(`[WorkflowExecution] AskUser ${node.id}: firing ask_user trace → session=${ownerSession.sessionId}, options=${options.length}, fields=${fields?.length ?? 0}`);
				this._pendingAskUser.set(`${executionState.executionId}:${node.id}`, {
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					nodeName,
					question,
					options,
					multiSelect,
				});
				this._onDidExecutionTrace.fire({
					kind: 'ask_user',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					nodeName,
					question,
					options,
					multiSelect,
					allowCustom,
					customLabel,
					fields,
					// ★ 多问题（2026-09-11）：非空 → 卡片按单页渲染全部问题
					...(questions.length > 0 ? { questions } : {}),
				});
			}

			// 暂停执行并等待用户输入
			this.logService.info(`[WorkflowExecution] Pausing for user input: ${question}`);
			const userInput = await this.pauseExecution(
				executionState.executionId,
				node.id,
				question,
				options,
			);

			// ★ 取消短路（2026-09-11）：AskUser 暂停期间用户点取消 → `cancelExecution`
			//   已 resolve 本 pause（返回 ''）并发出 ask_user_end('cancelled')，交互卡
			//   已是「已取消」。此处若不检查，会把空字符串当**用户回答**继续处理
			//   （标节点 Completed、发 ask_user_end('answered') 覆盖取消态、按空答案
			//   路由下游）→ 卡片显示「已回答」而用户明明取消了。
			if (this._bailOutIfCancelled(executionState, node)) { return ''; }

			// v4: fire ask_user_end so the webview card flips to "answered" state.
			if (ownerSession) {
				this._pendingAskUser.delete(`${executionState.executionId}:${node.id}`);
				this._onDidExecutionTrace.fire({
					kind: 'ask_user_end',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					status: 'answered',
					selection: userInput,
				});
			}

			this.logService.info(`[WorkflowExecution] User input received: ${JSON.stringify(userInput)}`);

			// ★ D4：对象态回答 = { __askUserAnswer:1, labels, params }。
			//   labels 走既有链路（context.userInput + port 路由按 label 匹配，零影响）；
			//   params 另存 context.askUserParams[nodeId]，不污染既有 consumer。
			// 对象态可能以 JSON 字符串抵达（resume 通道保持 string|string[] 签名）。
			let answerObject: { __askUserAnswer?: number; labels?: unknown; params?: unknown; multiSelect?: boolean } | undefined;
			if (typeof userInput === 'string' && userInput.startsWith('{')) {
				try { answerObject = JSON.parse(userInput); } catch { /* 普通文本回答 */ }
			} else if (userInput && typeof userInput === 'object' && !Array.isArray(userInput)) {
				answerObject = userInput as typeof answerObject;
			}
			if (answerObject) {
				const ans = answerObject;
				// ★ 多问题（2026-09-11）：`{ __askUserAnswer:1, answers:{ q1:…, q2:{…} } }`
				//   输出契约 `{ __askUser:1, answers, labels, params, assets }` —— answers
				//   按问题 key 组织（选项模式 = 文案/数组；参数模式 = {字段:值}），
				//   下游 `{{input.q1}}` / `{{input.q2.topic}}` 消费；同时把参数模式
				//   的值**并入 params**（保持既有 `askUserParams` / 模板链路可用）。
				const multiAnswers = (ans as { answers?: unknown }).answers;
				if (multiAnswers && typeof multiAnswers === 'object' && !Array.isArray(multiAnswers)) {
					const answers = multiAnswers as Record<string, unknown>;
					const mergedParams: Record<string, string> = {};
					const mergedAssets: Record<string, string> = {};
					for (const q of questions) {
						const v = answers[q.key];
						if (q.mode === 'params' && v && typeof v === 'object' && !Array.isArray(v)) {
							const fields = q.params ?? [];
							const collected = WorkflowExecutionService._collectAskUserAssets(fields, v as Record<string, string>);
							for (const [k, val] of Object.entries(collected)) { mergedAssets[`${q.key}.${k}`] = val; }
							for (const [k, val] of Object.entries(v as Record<string, string>)) {
								if (collected[k] === undefined && typeof val === 'string') { mergedParams[`${q.key}.${k}`] = val; }
							}
						}
					}
					const contract: Record<string, unknown> = {
						__askUser: 1,
						answers,
						...(Object.keys(mergedParams).length > 0 ? { params: mergedParams } : {}),
						...(Object.keys(mergedAssets).length > 0 ? { assets: mergedAssets } : {}),
					};
					const nodeState = executionState.nodeStates.get(node.id);
					if (nodeState) {
						nodeState.output = JSON.stringify(contract);
						const snaps = Object.entries(mergedAssets).map(([key, ref]) => ({
							port: 'output', kind: 'image' as const, ref, meta: { askUserAsset: key },
						}));
						if (snaps.length > 0) { nodeState.snapshot = snaps; }
						this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });
					}
					if (Object.keys(mergedParams).length > 0) {
						const bag = ((executionState.context['askUserParams'] as Record<string, Record<string, string>> | undefined) ?? {});
						bag[node.id] = mergedParams;
						executionState.context['askUserParams'] = bag;
					}
					if (Object.keys(mergedAssets).length > 0) {
						const abag = ((executionState.context['askUserAssets'] as Record<string, Record<string, string>> | undefined) ?? {});
						abag[node.id] = mergedAssets;
						executionState.context['askUserAssets'] = abag;
						const prevImages = Array.isArray(executionState.context['images']) ? executionState.context['images'] as string[] : [];
						executionState.context['images'] = [...prevImages, ...Object.values(mergedAssets)];
					}
					this.logService.info(`[WorkflowExecution] AskUser ${node.id}: 多问题作答 ${Object.keys(answers).length} 项（params=${Object.keys(mergedParams).length}, assets=${Object.keys(mergedAssets).length}）`);
					// 返回值供 port 路由（labels 语义）：多问题取首个非空答案的文本
					const firstText = Object.values(answers).map(v => typeof v === 'string' ? v : '').find(s => s);
					return firstText ?? JSON.stringify(answers);
				}
				if (ans.__askUserAnswer === 1) {
					const labels = Array.isArray(ans.labels) ? (ans.labels as string[]).filter(l => typeof l === 'string') : [];
					const params = (ans.params && typeof ans.params === 'object' && !Array.isArray(ans.params))
						? ans.params as Record<string, string>
						: {};
					// ★ 数据契约（2026-09-10 阶段 1）：AskUser 作为**数据源节点**，
					//   输出结构化契约（labels / params / assets）供下游 $ref 引用，
					//   而非只把选项文本塞进 $prev（媒体与多字段此前完全丢失）。
					const assets = WorkflowExecutionService._collectAskUserAssets(fields, params);
					// ★ params 只留**文本/数字**：media 字段（base64 data URL，可达数 MB）
					//   必须从 params 剥离——否则下游 `{{askUserParams.<id>.<key>}}` 之类
					//   模板合成会把整段 base64 塞进 prompt（涨 token 且污染模型输入）。
					//   媒体统一走 assets → context.images / snapshot 通道。
					const textParams: Record<string, string> = { ...params };
					for (const k of Object.keys(assets)) { delete textParams[k]; }
					const contract = {
						__askUser: 1,
						labels,
						params: textParams,
						...(Object.keys(assets).length > 0 ? { assets } : {}),
					};
					const nodeState = executionState.nodeStates.get(node.id);
					if (nodeState) {
						nodeState.output = JSON.stringify(contract);
						// 媒体进 snapshot —— 供聊天卡渲染 + 下游媒体端口消费。
						const snaps = Object.entries(assets).map(([key, ref]) => ({
							port: 'output',
							kind: 'image' as const,
							ref,
							meta: { askUserAsset: key },
						}));
						if (snaps.length > 0) { nodeState.snapshot = snaps; }
						this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });
					}

					if (Object.keys(textParams).length > 0) {
						const bag = ((executionState.context['askUserParams'] as Record<string, Record<string, string>> | undefined) ?? {});
						bag[node.id] = textParams;
						executionState.context['askUserParams'] = bag;
						this.logService.info(`[WorkflowExecution] AskUser ${node.id}: 动态参数 ${Object.keys(textParams).length} 项已入 context.askUserParams`);
					}
					if (Object.keys(assets).length > 0) {
						const abag = ((executionState.context['askUserAssets'] as Record<string, Record<string, string>> | undefined) ?? {});
						abag[node.id] = assets;
						executionState.context['askUserAssets'] = abag;
						// ★ 同时并入 context.images——下游媒体节点（EmojiStage 等）
						//   在无显式 binding 时回落消费 context.images（既有链路）。
						const prevImages = Array.isArray(executionState.context['images']) ? executionState.context['images'] as string[] : [];
						executionState.context['images'] = [...prevImages, ...Object.values(assets)];
						this.logService.info(`[WorkflowExecution] AskUser ${node.id}: 媒体资产 ${Object.keys(assets).length} 项已入 context.askUserAssets + context.images`);
					}
					return ans.multiSelect ? labels : (labels[0] ?? '');
				}
			}
			return userInput;
		} catch (err) {
			// v4: mark the pending ask_user as expired so the card shows "failed" state.
			if (ownerSession) {
				this._pendingAskUser.delete(`${executionState.executionId}:${node.id}`);
				this._onDidExecutionTrace.fire({
					kind: 'ask_user_end',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					status: 'expired',
				});
			}
			this.logService.error(`[WorkflowExecution] AskUser ${node.id} failed:`, err);
			throw err;
		}
	}

	private async _executeSkillNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Skill node: ${node.id}`);
		const data = node.data ?? {};
		const skillName = (data.skillName as string) || (data.skillId as string) || '';
		const skillInput = (data.prompt as string) || '';
		const skillArgs = (data.skillArgs as Record<string, string>) ?? {};

		const agentId = _options?.agentId || workflow.agentId;

		if (!skillName) {
			throw new Error(`Skill node ${node.id} has no skillName`);
		}

		// P2: 双向打通 —— 若 skillName 解析到 workflow 来源的可执行 skill，
		// 则确定性硬调用该工作流（而非软触发 prompt），把最终输出作为本节点输出。
		const wfSkill = this._resolveWorkflowSkill(skillName);
		if (wfSkill?.executor?.kind === 'workflow') {
			this.logService.info(`[WorkflowExecution] Skill node ${node.id} resolves to workflow ${wfSkill.executor.workflowId} — executing deterministically`);
			const finalOutput = await this._executeWorkflowAndAwait(wfSkill.executor.workflowId, {
				context: { input: skillInput },
				agentId,
				skipVariableCollection: true,
			});
			const nodeState = executionState.nodeStates.get(node.id);
			if (nodeState) {
				nodeState.output = finalOutput ?? '';
			}
			return;
		}

		if (!agentId) {
			throw new Error(`Skill node ${node.id}: No agent ID available`);
		}

		// Build skill execution prompt
		const argsStr = Object.entries(skillArgs)
			.map(([k, v]) => `  - ${k}: ${v}`)
			.join('\n');
		const promptParts: string[] = [
			`Execute the following skill: **${skillName}**`,
			skillInput ? `\nInput: ${skillInput}` : '',
			argsStr ? `\nArguments:\n${argsStr}` : '',
		];
		const executionPrompt = promptParts.filter(Boolean).join('\n');

		this.logService.info(`[WorkflowExecution] Skill ${node.id}: executing "${skillName}"`);
		// v21: route through _sendAndTrackStream so cancelExecution can abort
		// the in-flight LLM call. The bare `sendMessage` await previously
		// ignored the Cancelled status, so cancel had no effect during
		// long-running skill executions.
		// 获取或创建 agent session，避免消息被 cross-session leakage guard 丢弃
		const skillSessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
		const skillSessionId = await this._getOrCreateAgentSession(
			agentId,
			executionState.executionId,
			skillSessionName,
		);
		const message = await this._sendAndTrackStream(
			executionState,
			node,
			agentId,
			executionPrompt,
			skillSessionId,
			() => { /* noop onDelta */ },
		);

		const nodeState = executionState.nodeStates.get(node.id);
		if (nodeState) {
			nodeState.output = message.content || '';
		}
	}

	// ─── P2/P3: workflow 型 skill 节点的确定性硬调用 ─────────────────────

	/**
	 * 解析一个 skill 名称是否为 workflow 来源的可执行 skill。
	 * 大小写不敏感匹配；返回第一个 source==='workflow' 的 skill 定义。
	 */
	private _resolveWorkflowSkill(skillName: string): ISkillDefinition | undefined {
		const name = skillName.toLowerCase();
		for (const s of this.skillRegistry.getSkills()) {
			if (s.source === 'workflow' && s.name.toLowerCase() === name && s.executor?.kind === 'workflow') {
				return s;
			}
		}
		return undefined;
	}

	/**
	 * 嵌套执行一个工作流并等待其完成，返回最终输出（供 Skill 节点作为本节点输出）。
	 * - 环检测由 executeWorkflow 入口统一处理（递归调用会抛错），此处捕获并返回空。
	 * - 通过订阅 onDidExecutionStatusChange 等待目标 executionId 进入终态。
	 */
	private async _executeWorkflowAndAwait(workflowId: string, options?: IWorkflowExecutionOptions): Promise<string | undefined> {
		let executionId: string;
		try {
			executionId = await this.executeWorkflow(workflowId, options);
		} catch (err) {
			this.logService.warn(`[WorkflowExecution] nested workflow execution skipped (likely cyclic): ${workflowId}`, err);
			return undefined;
		}
		return new Promise<string | undefined>((resolve) => {
			const sub = this.onDidExecutionStatusChange(state => {
				if (state.executionId !== executionId) { return; }
				if (state.status === WorkflowExecutionStatus.Completed
					|| state.status === WorkflowExecutionStatus.Failed
					|| state.status === WorkflowExecutionStatus.Cancelled) {
					sub.dispose();
					resolve(this._extractFinalOutput(state));
				}
			});
		});
	}

	/** 从执行状态中提取最终输出（最后一个 completed 且有 output 的节点）。 */
	private _extractFinalOutput(state: IWorkflowExecutionState): string {
		let last = '';
		for (const ns of state.nodeStates.values()) {
			if (ns.status === WorkflowNodeExecutionStatus.Completed && ns.output) {
				last = ns.output;
			}
		}
		return last;
	}

	private async _executeToolNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Tool node: ${node.id}`);
		const data = node.data ?? {};
		const toolName = (data.toolName as string) || '';
		const toolParams = (data.toolParams ?? data.params ?? {}) as Record<string, unknown>;

		if (!toolName) {
			throw new Error(`Tool node ${node.id} has no toolName`);
		}

		const agentId = _options?.agentId || workflow.agentId;
		if (!agentId) {
			throw new Error(`Tool node ${node.id}: No agent ID available`);
		}

		// Build tool execution prompt
		const paramsStr = typeof toolParams === 'string'
			? toolParams as string
			: JSON.stringify(toolParams, null, 2);
		const executionPrompt = paramsStr && Object.keys(toolParams).length > 0
			? `Execute tool **${toolName}** with parameters:\n\`\`\`json\n${paramsStr}\n\`\`\``
			: `Execute tool **${toolName}**`;

		this.logService.info(`[WorkflowExecution] Tool ${node.id}: executing "${toolName}"`);
		// v21: route through _sendAndTrackStream so cancelExecution can abort
		// the in-flight LLM call (cancel previously had no effect while a
		// tool's agent turn was streaming).
		// 获取或创建 agent session，避免消息被 cross-session leakage guard 丢弃
		const toolSessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
		const toolSessionId = await this._getOrCreateAgentSession(
			agentId,
			executionState.executionId,
			toolSessionName,
		);
		const message = await this._sendAndTrackStream(
			executionState,
			node,
			agentId,
			executionPrompt,
			toolSessionId,
			() => { /* noop onDelta */ },
		);

		const nodeState = executionState.nodeStates.get(node.id);
		if (nodeState) {
			nodeState.output = message.content || '';
		}
	}

	// ★ `_nodeOnFlowChain` 已移除（2026-09-13 质量评估 P2-6）：FLOW 链 + 类型排除的
	//   判定收敛到 `workflow/cardVisibility.ts` 的 `isNodeVisibleOnCard` —— **唯一规则表**，
	//   结构上杜绝各处漂移（catch 分支曾漏掉 FLOW 筛选，导致非 FLOW 节点的 subagent_end
	//   没有对应卡片、被 controller 静默丢弃 ✗）。原注释（端口约定 / 保守视为 FLOW）
	//   随之迁移到 `flowChain.ts` 与 `cardVisibility.ts`。

	/**
	 * Execute a ComfyUI-compatible node (WorkflowNodeType.Comfy / ComfyStage).
	 * The actual Comfy invocation is delegated to an injected
	 * `IComfyExecutionDelegate` (set via setComfyExecutionDelegate), so the
	 * executor stays decoupled from the webview HTTP client. When no delegate is
	 * configured the node is skipped with a warning (same as unknown types).
	 */
	private async _executeComfyNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Comfy node: ${node.id} (${node.type})`);
		const data = node.data ?? {};
		const comfy = (data.comfy ?? {}) as { mode?: 'workflow' | 'stage'; stageClass?: string; workflowId?: string };

		// ★ 选择型/纯配置型节点（catalog 声明 apply:'snapshot'|'skip'）**不需要 ComfyUI
		//   delegate** —— 它们由下方交互段处理并直接 return（不执行节点）。此前 delegate
		//   检查在交互段之前，会让这类节点在未开画布时被误判 Failed（Picker 家族单链路
		//   改造，2026-09-11）。
		const interactionSchemaEarly = catalogInteraction(
			typeof data['stageClass'] === 'string' ? data['stageClass'] : undefined,
		);
		const skipsExecution = interactionSchemaEarly?.apply === 'snapshot' || interactionSchemaEarly?.apply === 'skip';

		if (!this._comfyDelegate && !skipsExecution) {
			// ★ v39 fail-loud（与脚本域 stagePort 缺省 fail-loud 语义一致）：
			//   旧版静默 return —— 节点状态缺失 → 终态可能误判 Completed、级联不触发、
			//   下游拿到空输入。现在标 Failed + 级联跳过下游，独立分支不受影响。
			const msg = 'no Comfy execution delegate registered. ' +
				'Open the workflow canvas (which registers the delegate via setComfyExecutionDelegate) to enable ComfyUI execution.';
			this.logService.warn(`[WorkflowExecution] Comfy node ${node.id} FAILED: ${msg}`);
			const nodeState: IWorkflowNodeExecutionState = {
				nodeId: node.id,
				status: WorkflowNodeExecutionStatus.Failed,
				error: msg,
				startTime: new Date().toISOString(),
				endTime: new Date().toISOString(),
			};
			executionState.nodeStates.set(node.id, nodeState);
			this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...nodeState } });
			const adjLocal = new Map<string, { targetId: string; fromPort?: string }[]>();
			for (const c of (workflow.connections ?? [])) {
				const list = adjLocal.get(c.from) ?? [];
				list.push({ targetId: c.to, fromPort: c.fromPort });
				adjLocal.set(c.from, list);
			}
			this._cascadeSkipDownstream(executionState, node.id, adjLocal);
			return;
		}

		// Collect resolved binding values: read the node's bindings + defaults and
		// resolve template variables against upstream node outputs (shared memory).
		const bindings = (data.bindings ?? {}) as Record<string, string>;
		const defaults = (data.defaults ?? {}) as Record<string, unknown>;
		const values: Record<string, unknown> = {};

		// ★ 节点顶层配置透传（2026-09-10 用户反馈「动态表情包参数报错」）：
		//   画布把节点配置（`videoProvider` / `videoModel` / `provider` / `model` /
		//   `duration_s` / `fps` / `chroma_*` / `selected_index` / `cell_indices` …）
		//   存在 **data 顶层**，而 host 此前只组装 bindings + defaults → webview
		//   `runAnimatedEmoji` 收不到 `videoProvider`/`videoModel` → 直接抛
		//   「请先在节点设置中选择 Provider 和视频生成模型」（日志实锤：画布 data 里
		//   明明配了 lm:lightai / video_minimax_h3）。这里先把 data 顶层标量/数组铺进
		//   values；bindings 在其后覆盖（显式引用优先），defaults 仅在两者都没有时兜底。
		const DATA_INTERNAL_KEYS = new Set([
			'bindings', 'defaults', 'label', 'stageClass', 'comfy',
			'__sarosStageUid', 'hasBreakpoint', 'position', 'style',
		]);
		for (const [k, v] of Object.entries(data)) {
			if (DATA_INTERNAL_KEYS.has(k) || v === undefined || v === null) { continue; }
			const t = typeof v;
			if (t === 'string' || t === 'number' || t === 'boolean' || Array.isArray(v)) {
				values[k] = v;
			}
		}

		for (const [key, binding] of Object.entries(bindings)) {
			// ★ 阶段 2（2026-09-10）：binding 支持**结构化引用**
			//   `{ "$ref": { "node": "<nodeId>", "path": "params.x" | "assets.x" | "labels.0" } }`
			//   ——数据传参保类型、可校验、重命名可追踪；`{{}}` 仅保留给文本合成。
			if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
				const ref = (binding as { $ref?: { node?: unknown; path?: unknown } }).$ref;
				if (ref && typeof ref.node === 'string') {
					const refValue = this._resolveStructuredRef(executionState, ref.node, typeof ref.path === 'string' ? ref.path : '', key);
					if (refValue !== undefined) { values[key] = refValue; continue; }
				}
			}
			const resolved = WorkflowExecutionService._replaceVariables(
				typeof binding === 'string' ? binding : String(binding),
				this._buildEvalContext(executionState),
			);
			if (resolved !== undefined && resolved !== '') {
				values[key] = resolved;
			} else if (defaults[key] !== undefined) {
				values[key] = defaults[key];
			}
		}
		// Include the node's own label/description as a fallback context — but only
		// when no binding (e.g. `label: '{{n-prompt.output}}'`) already filled it.
		if (values['label'] === undefined) {
			values['label'] = data.label ?? node.name ?? node.id;
		}

		// 参考图：工作流执行 context.images（聊天附件 data URL）注入 `images` 端口。
		// EmojiStage 等媒体节点经它消费参考图（若无显式 binding 引用 {{images}}）。
		const ctxImages = executionState.context?.['images'];
		if (values['images'] === undefined && Array.isArray(ctxImages) && ctxImages.length > 0) {
			values['images'] = ctxImages;
		}

		// ★ 上游连线参考图（2026-09-10 用户反馈「静态表情包的参考图未生效」）：
		//   画布上 `ImageLoader --images--> StatEmojiStage` 这类**数据连线**，此前
		//   host 只认 bindings 与 context.images，**从不读连线** → 上游 loader 经
		//   webview runLoaderNode 物化出的快照（nodeState.snapshot）从未注入下游的
		//   images 端口 → 参考图丢失（生成结果与参考图无关）。
		//   这里按入边汇总上游 image 快照；显式 binding / 聊天附件优先（不覆盖）。
		if (values['images'] === undefined) {
			const upstreamImages: string[] = [];
			for (const c of (workflow.connections ?? [])) {
				if (c.to !== node.id) { continue; }
				const upState = executionState.nodeStates.get(c.from);
				for (const m of (upState?.snapshot ?? [])) {
					if (m.kind === 'image' && typeof m.ref === 'string' && m.ref) {
						upstreamImages.push(m.ref);
					}
				}
			}
			if (upstreamImages.length > 0) {
				values['images'] = upstreamImages;
				this.logService.info(`[WorkflowExecution] ${node.id}: 上游连线注入参考图 ${upstreamImages.length} 张`);
			}
		}

		// ★ 节点交互 UI（2026-09-11 用户需求：**通用框架**）：命中 schema 的节点在
		//   执行前**暂停**，卡片按 schema 动态渲染表单（如静态表情包的 m×n 格数 /
		//   每格提示词 / 表情包风格），用户提交后把值合并进 values 再执行 —— 实现
		//   「用户配置完成才进入下一阶段」。与 AskUser / ImagePicker 共用 pause/resume；
		//   提交值以 JSON 字符串回传（同 D4 约定，避免扩展 pause 签名）。
		// 交互声明：**唯一来源 = nodeCatalog**（新增节点只改 nodeCatalog.ts，schema 较大时
		// 放 catalogNodes/<node>.ts）。2026-09-11 已删除与之并存的历史表
		// NODE_INTERACTION_SCHEMAS（两张表会导致「生产走新表、测试验旧表」的静默漂移）。
		const interactionSchema = catalogInteraction(
			typeof data['stageClass'] === 'string' ? data['stageClass'] : undefined,
		);
		if (interactionSchema) {
			const owner = this._executionSession.get(executionState.executionId);
			// 行为模式（schema 声明驱动，2026-09-11 框架完善）：
			//   values   → 提交值合并进 values，随后正常执行（配置型）
			//   snapshot → 提交值 = 媒体 refs，直接作为节点输出，**不执行节点**（选择型）
			//   skip     → 只收集配置，不执行不产出
			const applyMode = interactionSchema.apply ?? 'values';
			// snapshot 模式的候选媒体（卡片据此渲染缩略图网格）。
			const candidates: NonNullable<ComfyExecutionResult['snapshot']> = [];
			if (applyMode === 'snapshot') {
				const fromSelf = interactionSchema.snapshotSource === 'self';
				// ★ 去重（2026-09-11 用户反馈「ImagePicker 候选里大量重复图像」）：
				//   ① `connections` 是**按边**记录的（含 fromPort/toPort）—— 同一上游节点
				//      若有多条边连入（多端口各连一条）会在 sourceIds 里出现多次，
				//      于是它的**整份快照被重复收集**（实测：上游 11 条 → 候选 22 条）。
				//   ② 同一 ref 可能同时存在于多个端口/条目：sheet 口与 image 口可能指向
				//      同一张合成图；单格重新生成的「历史保留」项与当前项也可能同文件。
				//   去重键取 `ref` —— 同一张图在候选里出现两次对用户没有意义。
				const sourceIds = [...new Set(
					fromSelf ? [node.id] : (workflow.connections ?? []).filter(c => c.to === node.id).map(c => c.from),
				)];
				const seenCandidateRefs = new Set<string>();
				for (const sid of sourceIds) {
					const st = executionState.nodeStates.get(sid);
					for (const m of (st?.snapshot ?? [])) {
						if (m.kind !== 'image' && m.kind !== 'video' && m.kind !== 'audio') { continue; }
						if (!m.ref || seenCandidateRefs.has(m.ref)) { continue; }
						seenCandidateRefs.add(m.ref);
						candidates.push(m);
					}
				}
			}
			// ★ 参考图像字段（2026-09-11 用户需求）：schema 声明 kind='image-ref' 时，
			//   把**上游图像**作为默认值（用户不选也能直接用上游图），并把上游候选带给
			//   卡片供「选择图像」。
			//   ⚠ 不能复用 `__candidates` —— 那个键会让卡片**整卡**切到 ImagePicker
			//   候选网格模式（见 _createNodeInteractionCard 开头分支），表单就不渲染了。
			const imageRefFields = interactionSchema.fields.filter(
				(f): f is Extract<INodeInteractionField, { kind: 'image-ref' }> => f.kind === 'image-ref',
			);
			const assetCandidates: Array<{ ref: string; label?: string }> = [];
			let upstreamRefs: string[] = [];
			if (imageRefFields.length > 0) {
				// ★ 候选分两组（2026-09-11 用户报障「表情包的参考图像无法进行选择」）：
				//   上游 = 默认值来源；上游 + 本工作流其它节点 = 网格候选。
				//   原本只取**直接上游** → 表情包节点（上游只有 start，不产图）候选为空 →
				//   卡片按「无候选不渲染按钮」连「选择图像」都不给 → 用户完全无法指定参考图 ✗。
				const picked = collectImageRefCandidates(
					workflow.connections,
					executionState.nodeStates,
					node.id,
					(sid) => {
						const n = (workflow.nodes ?? []).find(x => x.id === sid);
						return n ? this._nodeDisplayName(n) : undefined;
					},
				);
				upstreamRefs = picked.upstream.map(c => c.ref);
				assetCandidates.push(...picked.all);
			}
			const baseInitialValues = buildInteractionInitialValues(interactionSchema, values);
			// 节点未钉住资产（初值为空）且有上游图像 → 用第一张作**默认参考图**。
			// 纯函数抽出（可单测）：见 nodeInteraction/helpers.buildImageRefDefaults。
			// ⚠ 只传**上游**（不传 all）：否则会把无关节点的图自动钉成默认参考图 ✗。
			const imageRefDefaults = buildImageRefDefaults(
				interactionSchema, baseInitialValues, upstreamRefs);
			if (owner) {
				this._onDidExecutionTrace.fire({
					kind: 'node_interaction',
					executionId: executionState.executionId,
					sessionId: owner.sessionId,
					nodeId: node.id,
					nodeName: this._nodeDisplayName(node),
					stageClass: typeof data['stageClass'] === 'string' ? data['stageClass'] : undefined,
					title: interactionSchema.title,
					...(interactionSchema.description !== undefined ? { description: interactionSchema.description } : {}),
					...(interactionSchema.submitLabel !== undefined ? { submitLabel: interactionSchema.submitLabel } : {}),
					fields: interactionSchema.fields as unknown as Array<Record<string, unknown>>,
					initialValues: {
						...baseInitialValues,
						...imageRefDefaults,
						// 参考图像候选（上游图像）—— 供卡片「选择图像」按钮。
						...(assetCandidates.length > 0 ? { __assetCandidates: assetCandidates } : {}),
						// 选择型：把候选媒体随初值带给卡片（卡片渲染缩略图网格 + 多选）。
						...(applyMode === 'snapshot'
							? { __candidates: candidates, __multiSelect: interactionSchema.multiSelect !== false }
							: {}),
					},
				});
			}
			let submitted: Record<string, unknown> | undefined;
			try {
				const raw = await this.pauseExecution(executionState.executionId, node.id, interactionSchema.title, []);
				if (typeof raw === 'string' && raw.trim().startsWith('{')) {
					submitted = JSON.parse(raw) as Record<string, unknown>;
				} else if (Array.isArray(raw)) {
					// 选择型：卡片可能直接回传 refs 数组
					submitted = { __refs: raw };
				}
			} catch (e) {
				this.logService.warn(`[WorkflowExecution] 节点交互 ${node.id}: pause 失败（${e instanceof Error ? e.message : String(e)}）→ 用现有配置执行`);
			}
			if (owner) {
				this._onDidExecutionTrace.fire({
					kind: 'node_interaction_end',
					executionId: executionState.executionId,
					sessionId: owner.sessionId,
					nodeId: node.id,
					status: submitted ? 'submitted' : 'skipped',
					...(submitted ? { values: submitted } : {}),
				});
			}

			// ★ 取消短路（2026-09-11）：交互暂停期间用户点了取消 → pause 以空值返回
			//   （不是抛错）→ 必须在此停住，否则会带着「用户已取消」继续执行节点：
			//   真实发起生成（消耗算力）、节点标 Completed、卡片 spinner 继续转、
			//   execution_end 迟迟不发（用户感知「取消后进度条不终止」）。
			//   交互卡已在上方收到 node_interaction_end(skipped) → 显示为已跳过。
			if (this._bailOutIfCancelled(executionState, node)) { return; }

			// ── 按模式处理提交值 ─────────────────────────────────────────────
			if (applyMode === 'snapshot') {
				const rawRefs = submitted?.['__refs'];
				const refs = Array.isArray(rawRefs)
					? rawRefs.filter((r): r is string => typeof r === 'string')
					: (candidates.map(c => c.ref));   // 未提交/取消 → 兜底全选（不阻断下游）
				const allowed = new Set(candidates.map(c => c.ref));
				const chosen = candidates.filter(c => allowed.has(c.ref) && refs.includes(c.ref));
				const finalMedia = chosen.length > 0 ? chosen : candidates;
				// ★ 落进 **webview 快照库**（2026-09-11 修 bug）：选择型节点**不执行**，其选中
				//   结果此前只存在 host 侧 executionState —— 而下游执行器（如
				//   Saros.AnimatedEmoji 逐格图生视频）是按 `store.byNode(上游 id)` /
				//   `latestRoundOf` 从 **webview 快照库**取上游参考图的 → 永远取不到 →
				//   报「动态表情包制作需要上游参考图输入」。落库后 picker 的输出对下游
				//   与普通节点**完全同构**（原样透传 meta，图集标记等语义随之保留）。
				//   port 用 picker 自身的输出口名（'image'）；下游按边的 sourceHandle 决定
				//   语义，与该 port 无关，故此处不影响既有消费方。
				for (const m of finalMedia) {
					putWorkflowSnapshotMedia({
						anchorUid: node.id,
						port: 'image',
						kind: m.kind === 'video' ? 'video' : m.kind === 'audio' ? 'audio' : 'image',
						ref: m.ref,
						...(m.meta ? { meta: m.meta } : {}),
					});
				}
				const ns = executionState.nodeStates.get(node.id) ?? {
					nodeId: node.id,
					status: WorkflowNodeExecutionStatus.Running,
					startTime: new Date().toISOString(),
				};
				ns.status = WorkflowNodeExecutionStatus.Completed;
				ns.endTime = new Date().toISOString();
				ns.snapshot = finalMedia;
				ns.output = `已选择 ${finalMedia.length}/${candidates.length} 项输出给下游`;
				executionState.nodeStates.set(node.id, ns);
				this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...ns } });
				this.logService.info(`[WorkflowExecution] 节点交互 ${node.id}: snapshot 模式选择 ${finalMedia.length}/${candidates.length} 项（节点不执行）`);
				return;   // ★ 选择型：不执行节点
			}
			if (applyMode === 'skip') {
				const ns = executionState.nodeStates.get(node.id) ?? {
					nodeId: node.id,
					status: WorkflowNodeExecutionStatus.Running,
					startTime: new Date().toISOString(),
				};
				ns.status = WorkflowNodeExecutionStatus.Completed;
				ns.endTime = new Date().toISOString();
				ns.output = '仅配置（skip 模式，不执行）';
				executionState.nodeStates.set(node.id, ns);
				this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState: { ...ns } });
				return;
			}
			// 默认 values 模式：合并后继续执行
			if (submitted) {
				Object.assign(values, applyInteractionValues(interactionSchema, values, submitted));
				this.logService.info(`[WorkflowExecution] 节点交互 ${node.id}: 用户提交 ${Object.keys(submitted).length} 项配置 → 合并后执行`);
			} else {
				this.logService.info(`[WorkflowExecution] 节点交互 ${node.id}: 未提交（跳过）→ 用节点现有配置执行`);
			}
		}

		const input: ComfyExecutionInput = {
			values,
			defaults,
			// ★ headless 轻量版：透传当前工作流 id —— 无画布时自动开画布可定位正确工作流。
			workflowId: (executionState as { workflowId?: string }).workflowId,
			// ★ 上游节点 id（2026-09-11）：webview `runStageByClass` 需要它从快照库取
			//   上游快照 —— 逐格图生视频类 stage（Saros.AnimatedEmoji）的参考图正是
			//   上游 StatEmojiStage 的格子快照，此前 webview 侧硬编码 `upstreams: []`
			//   → 报「动态表情包制作需要上游参考图输入」。
			upstreams: (workflow.connections ?? []).filter(c => c.to === node.id).map(c => c.from),
			// ★ 工作流 session（2026-09-11）：webview 侧据此隔离快照库（不同聊天会话
			//   生成的内容互不可见）。
			...(executionState.workflowSessionId ? { workflowSessionId: executionState.workflowSessionId } : {}),
		};
		const ownerSession = this._executionSession.get(executionState.executionId);
		const nodeName = this._nodeDisplayName(node);
		// 上方检查已保证：需要执行的节点此时必有 delegate（选择型/纯配置型已 return）。
		const delegate = this._comfyDelegate;
		if (!delegate) {
			throw new Error(`Comfy node ${node.id}: delegate 缺失（不应到达此处）`);
		}
		const result = await delegate.execute(node, input, {
			executionId: executionState.executionId,
			// 逐格/逐帧进度透传：更新 nodeState.progress + 发 node_progress trace（聊天卡进度条）。
			onProgress: (progress, message, media) => {
				const ns = executionState.nodeStates.get(node.id);
				if (ns) { ns.progress = progress; }
				this._onDidExecutionTrace.fire({
					kind: 'node_progress',
					executionId: executionState.executionId,
					sessionId: ownerSession?.sessionId ?? 'unknown',
					nodeId: node.id,
					nodeName,
					progress,
					...(message !== undefined ? { message } : {}),
					// ★ 逐格媒体回流（2026-09-11 用户需求「输出一个就显示一个」）：节点**尚未结束**
					//   时就把新产出的格子带给卡片。此前 snapshot 只在 subagent_end 下发 →
					//   9 格必须全跑完聊天卡才出图 ✗（画布侧早已逐格显示 ✓）。
					//   增量语义（画布侧保证同格只报一次）→ 卡片侧**合并**而非替换。
					...(media ? { media } : {}),
				});
			},
		});

		// ★ 取消短路（2026-09-11）：执行**期间**（已提交 ComfyUI / 等画布 90s 兜底
		//   期间）用户点了取消 → 结果不可信（可能是超时兜底的半成品），不应写
		//   output/snapshot，否则卡片会把「已取消」渲染成一次成功产出。
		if (this._bailOutIfCancelled(executionState, node)) { return; }

		const nodeState = executionState.nodeStates.get(node.id);
		if (nodeState) {
			nodeState.output = result.summary ?? JSON.stringify(result.outputs);
			nodeState.progress = 100;
			// 媒体快照（image/video/audio 引用）随节点状态透传，供聊天卡渲染输出。
			if (result.snapshot) {
				nodeState.snapshot = result.snapshot;
			}
		}
		this.logService.info(
			`[WorkflowExecution] Comfy node ${node.id} completed (mode=${comfy.mode ?? 'workflow'}, outputs=${Object.keys(result.outputs).length})`,
		);
	}

	/**
	 * 节点显示名（2026-09-10 用户要求「阶段名称要显示为工作流中的节点的名字」）。
	 *
	 * 画布上 ComfyTV stage 的标题栏文字是**自动生成的机器名**
	 * （`ComfyTV.StatEmojiStage-1788782920357-1`，保存在 node.name / data.label），
	 * 而用户在画布 nodeCard 上看到的是 `spec.title`（「Emoji Stage」「ImagePicker」）。
	 * 此前候选链第一个非空即返回 → 命中机器名 → 卡片与画布所见不符。
	 *
	 * 现交由纯函数 resolveNodeDisplayName：用户命名优先 → 机器名则查 stage 标题表
	 * （画布 nodeCard 的 spec.title，与画布一致）→ 最后兜底。
	 */
	private _nodeDisplayName(node: WorkflowGraphNode): string {
		const d = (node.data ?? {}) as Record<string, unknown>;
		const stageClass = typeof d['stageClass'] === 'string' ? d['stageClass'] : undefined;
		const rawType = stageClass ?? node.type;
		// ★ 节点清单优先（2026-09-11 框架完善：新增节点只改 nodeCatalog.ts 的 title），
		//   回退画布 stage 标题表（COMFYTV_STAGE_META）。
		const catTitle = catalogTitle(rawType);
		return resolveNodeDisplayName({
			candidates: [d['label'], d['title'], (node as { title?: unknown }).title, node.name],
			rawType,
			normalizedType: node.type,
			titleByType: catTitle ? new Map([[rawType, catTitle]]) : STAGE_TITLE_BY_TYPE,
			fallback: node.name || node.id,
		});
	}

	/**
	 * ★ 聊天卡展示描述符（P0 修复，2026-09-13）：图标 + 副标题。
	 *
	 * 修复的问题（质量评估实测）：聊天卡的图标是渲染层**4 项硬编码表**
	 * （agent🤖 / prompt📝 / skill⚡ / tool🔧），其余一律 🤖；副标题则直接塞
	 * `node.type` 机器名（`comfyStage` / `script` / `end`）→ 同一节点在画布上显示
	 * 「裁剪」（spec.title），在聊天卡上显示 🤖 + `comfyStage` —— 用户可感知的不一致。
	 *
	 * 现在由 host 统一推导，数据源**全部复用既有表**（不新增按 type 索引的表）：
	 *   · 图标   ：stage `kind`（子串匹配，耐用）→ 引擎类型 → ⚙️ 兜底
	 *   · 副标题 ：stage `kind`/`workflowKind`（与画布 nodeCard 的 `schemaDetail` 同款文案）
	 *              → 引擎类型中文标签（**不回退机器名**）
	 *
	 * 与 `_nodeDisplayName`（标题）配套：两者共同保证「聊天卡看到的 = 画布看到的」。
	 */
	private _nodeCardDescriptor(node: WorkflowGraphNode): { icon: string; subtitle: string } {
		const d = (node.data ?? {}) as Record<string, unknown>;
		const stageClass = typeof d['stageClass'] === 'string' ? d['stageClass'] : undefined;
		// 推导逻辑集中在 `cardDescriptor.describeCardNode`（可单测 + 有护栏：新增 stage kind
		// 未补图标规则时 `cardDescriptor.test.ts` 会失败）。rawType 必须是**原始全名**
		// （stage meta 表按全名索引；归一化后的 `comfyStage` 查不到）。
		return describeCardNode(stageClass ?? node.type ?? '', node.type ?? '');
	}

	/**
	 * ★ 执行统计（P2-2 修复，2026-09-13）：真实耗时 + 各状态节点数。
	 *
	 * 供 `execution_end` 携带 → 聊天卡显示「12.3s · 3 成功 / 1 失败」。
	 *
	 * 修复的问题：此前 `execution_end` 只有 status，聊天卡的耗时由 controller 用
	 * `Date.now()` 现场取（起止同一时刻）→ **恒显示 0.0s** ✗；节点计数完全缺失，
	 * 「这次跑了多久、几个节点失败」无法回答。
	 *
	 * 耗时用 `state.startTime`/`endTime`（ISO 字符串，host 在开始时写入）✓。
	 */
	private _executionStats(state: IWorkflowExecutionState): {
		durationMs?: number; doneCount: number; errorCount: number; cancelledCount: number; skippedCount: number;
	} {
		let doneCount = 0;
		let errorCount = 0;
		let cancelledCount = 0;
		let skippedCount = 0;
		for (const ns of state.nodeStates.values()) {
			switch (ns.status) {
				case WorkflowNodeExecutionStatus.Completed: doneCount++; break;
				case WorkflowNodeExecutionStatus.Failed: errorCount++; break;
				case WorkflowNodeExecutionStatus.Cancelled: cancelledCount++; break;
				case WorkflowNodeExecutionStatus.Skipped: skippedCount++; break;
				default: break;   // Pending / Running / AwaitingInput
			}
		}
		const start = state.startTime ? Date.parse(state.startTime) : NaN;
		const end = state.endTime ? Date.parse(state.endTime) : NaN;
		const durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
		return {
			...(durationMs !== undefined ? { durationMs } : {}),
			doneCount, errorCount, cancelledCount, skippedCount,
		};
	}

	private async _executeIfElseNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		_options?: IWorkflowExecutionOptions,
	): Promise<string[]> {
		this.logService.info(`[WorkflowExecution] Executing IfElse/Switch node: ${node.id}`);
		const data = node.data ?? {};
		const branches: Array<{ id: string; label: string; condition: string; isDefault?: boolean }> =
			(data.branches as any[]) || [{ id: '0', label: 'True', condition: '' }, { id: '1', label: 'False', condition: '' }];

		const agentId = _options?.agentId || workflow.agentId;
		const isSwitch = node.type === WorkflowNodeType.Switch;

		// v31: resolve the default branch index. The isDefault flag marks the
		// catch-all branch that should be taken when no condition matches.
		// prefer it as the ultimate fallback over hardcoded branch-0.
		const defaultBranchIndex = (() => {
			const idx = branches.findIndex(b => b.isDefault);
			return idx >= 0 ? idx : 0;
		})();

		// ═══════════════════════════════════════════════════════════════════
		// v31: Code-level deterministic condition evaluation.
		// Before calling the LLM (expensive + non-deterministic), try to
		// evaluate conditions with deterministic rules. For Switch nodes,
		// match the resolved evaluationTarget against branch labels and
		// condition text. For IfElse nodes, parse simple `==`, `contains`,
		// `startsWith` / `endsWith` patterns from condition strings.
		// Only fall back to LLM when no deterministic rule fires.
		// ═══════════════════════════════════════════════════════════════════
		const evalTargetRaw = (data.evaluationTarget as string) || '';
		const resolvedEvalTarget = evalTargetRaw
			? WorkflowExecutionService._replaceVariables(evalTargetRaw, this._buildEvalContext(executionState))
			: '';
		let branchIndex = -1; // -1 = not yet determined, requires LLM fallback

		// ---- Switch: deterministic label/value matching ----
		if (isSwitch && resolvedEvalTarget) {
			const targetLower = resolvedEvalTarget.trim().toLowerCase();
			this.logService.info(
				`[WorkflowExecution] Switch ${node.id}: deterministic eval on ` +
				`target="${targetLower}" against ${branches.length} branches`,
			);
			for (let i = 0; i < branches.length; i++) {
				const labelLower = (branches[i].label || '').toLowerCase();
				const condLower = (branches[i].condition || '').toLowerCase();
				if (
					labelLower === targetLower ||
					condLower === targetLower ||
					labelLower.includes(targetLower) ||
					condLower.includes(targetLower)
				) {
					branchIndex = i;
					this.logService.info(
						`[WorkflowExecution] Switch ${node.id}: ` +
						`deterministic match → branch ${branchIndex} ("${branches[i].label}")`,
					);
					break;
				}
			}
			// If no direct match, check for a numeric evaluationTarget that maps to branch index
			if (branchIndex === -1) {
				const num = parseInt(resolvedEvalTarget, 10);
				if (!isNaN(num) && num >= 0 && num < branches.length) {
					branchIndex = num;
					this.logService.info(
						`[WorkflowExecution] Switch ${node.id}: ` +
						`numeric target → branch ${branchIndex}`,
					);
				}
			}
		}

		// ---- IfElse: deterministic condition parsing ----
		if (!isSwitch && branchIndex === -1) {
			for (let i = 0; i < branches.length; i++) {
				const cond = (branches[i].condition || '').trim();
				if (!cond) { continue; }
				const resolved = WorkflowExecutionService._replaceVariables(
					cond,
					this._buildEvalContext(executionState),
				);
				if (this._evaluateSimpleCondition(resolved, executionState)) {
					branchIndex = i;
					this.logService.info(
						`[WorkflowExecution] IfElse ${node.id}: ` +
						`deterministic match → branch ${branchIndex} ("${branches[i].label}") ` +
						`condition="${cond}"`,
					);
					break;
				}
			}
		}

		// ---- LLM fallback (only when deterministic eval didn't decide) ----
		if (branchIndex === -1 && agentId) {
			// Build prompt to ask agent to evaluate conditions
			const branchList = branches.map((b, i) =>
				`${i}. **${b.label}**: ${b.condition || (b.isDefault ? '(default)' : '(no condition)')}`
			).join('\n');

			// v31: for Switch nodes, include the resolved evaluationTarget in
			// the prompt so the LLM knows what value to switch on. Previously
			// evaluationTarget was only stored in node data but never passed
			// to the agent, making Switch nodes behave identically to IfElse.
			const switchOnLine = (isSwitch && resolvedEvalTarget)
				? `\n**Switching on:** "${resolvedEvalTarget}"\n`
				: '';

			const evaluationPrompt = [
				'You are at a decision point in the workflow. Evaluate the following branches and decide which one to follow.',
				'',
				'**Branches:**',
				branchList,
				switchOnLine,
				'Based on the context of all previous steps, which branch should be followed?',
				'Respond with ONLY the branch number (e.g., "0") on the first line.',
			].join('\n');

		try {
			this.logService.info(`[WorkflowExecution] IfElse/Switch ${node.id}: asking agent to evaluate`);
			const t0_eval = Date.now();
			// 获取或创建 agent session，避免消息被 cross-session leakage guard 丢弃
			const sessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
			const ifElseSessionId = await this._getOrCreateAgentSession(
				agentId,
				executionState.executionId,
				sessionName,
			);
			const message = await this._sendAndTrackStream(
				executionState,
				node,
				agentId,
				evaluationPrompt,
				ifElseSessionId,
				() => { /* noop onDelta */ },
			);
				this.logService.info(`[WorkflowExecution] IfElse/Switch ${node.id}: evaluation returned in ${Date.now() - t0_eval}ms, contentLen=${message?.content?.length ?? 0}`);

				// v31: robust parsing — scan the first non-empty line for a
				// standalone integer, falling back to the old /\b([0-9]+)\b/
				// for backward compatibility.
				const content = message.content || '';
				const lines = content.split('\n').map((l: string) => l.trim()).filter(Boolean);
				let parsed = false;
				for (const line of lines) {
					const m = line.match(/^(\d+)\b/);
					if (m) {
						const idx = parseInt(m[1], 10);
						if (idx >= 0 && idx < branches.length) {
							branchIndex = idx;
							parsed = true;
							break;
						}
					}
				}
				if (!parsed) {
					// fallback: old-style regex across entire content
					const match = content.match(/\b([0-9]+)\b/);
					if (match) {
						const idx = parseInt(match[1], 10);
						if (idx >= 0 && idx < branches.length) {
							branchIndex = idx;
						}
					}
				}
				if (branchIndex === -1) {
					this.logService.warn(
						`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
						`could not parse branch index from agent response "${content.substring(0, 100)}"`,
					);
				}
			} catch (err) {
				this.logService.warn(
					`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
					`condition evaluation failed: ${err instanceof Error ? err.message : err}`,
				);
			}
		}

		// ---- Ultimate fallback: use default branch ----
		if (branchIndex === -1) {
			branchIndex = defaultBranchIndex;
			this.logService.info(
				`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
				`no match found (agentId=${agentId || '<none>'}), ` +
				`using default branch ${branchIndex} ("${branches[branchIndex]?.label}")`,
			);
		}

		// Clamp to valid range (safety net)
		if (branchIndex < 0 || branchIndex >= branches.length) {
			branchIndex = defaultBranchIndex;
		}

		this.logService.info(`[WorkflowExecution] IfElse/Switch ${node.id}: selected branch ${branchIndex} ("${branches[branchIndex]?.label}")`);

		// Store the decision + upstream output in execution context.
		// v38: The node output must carry the actual upstream data, not just
		// the branch metadata. Otherwise {{$prev.output}} in downstream nodes
		// resolves to "Selected branch 0: 通过（无报错）" and the agent has
		// no real input to work with. We concatenate: upstream output first
		// (the data), then the branch decision (metadata separator).
		const nodeState = executionState.nodeStates.get(node.id);
		if (nodeState) {
			const upstreamOutputs = this._collectUpstreamOutputs(executionState);
			const upstreamEntries = Object.entries(upstreamOutputs)
				.filter(([, val]) => val.trim())
				.map(([, val]) => val.trim());
			const upstreamBlob = upstreamEntries.join('\n\n');
			const branchMeta = `Selected branch ${branchIndex}: ${branches[branchIndex]?.label}`;
			nodeState.output = upstreamBlob
				? `${upstreamBlob}\n\n---\nBranch decision: ${branchMeta}`
				: branchMeta;
		}

		// Return the selected branch's next nodes
		const connections = adj.get(node.id) ?? [];
		// v31: port-based routing. Match against branch-{branchIndex}.
		const matching = connections.filter(c => c.fromPort === `branch-${branchIndex}`);
		if (matching.length > 0) {
			return matching.map(c => c.targetId);
		}
		// v31: port mismatch — fall back to the default branch's port instead
		// of returning ALL downstream nodes (which would bypass branching
		// semantics and silently execute every branch).
		const defaultMatch = connections.filter(c => c.fromPort === `branch-${defaultBranchIndex}`);
		if (defaultMatch.length > 0) {
			this.logService.warn(
				`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
				`no edge matched port "branch-${branchIndex}", ` +
				`falling back to default port "branch-${defaultBranchIndex}"`,
			);
			return defaultMatch.map(c => c.targetId);
		}
		// Ultimate last resort: return first branch's matches
		const firstMatch = connections.filter(c => c.fromPort === `branch-0`);
		if (firstMatch.length > 0) {
			this.logService.warn(
				`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
				`no edge matched any specific port, using branch-0`,
			);
			return firstMatch.map(c => c.targetId);
		}
		// No port-specific edges at all — return all (backward compat for old
		// workflows that don't have fromPort on connections behind control-flow nodes)
		this.logService.warn(
			`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
			`no port-specific edges found, falling back to all downstream (backward compat)`,
		);
		return connections.map(c => c.targetId);
	}

	/**
	 * v31: Build a context map for variable resolution inside condition text.
	 * Resolves upstream node outputs so that `{{previewStatus.output}}` and
	 * similar references evaluate to actual values.
	 */
	private _buildEvalContext(executionState: IWorkflowExecutionState): Record<string, string> {
		const ctx: Record<string, string> = {};
		for (const [nodeId, ns] of executionState.nodeStates) {
			if (ns.output !== undefined) {
				ctx[nodeId] = ns.output;
				ctx[`${nodeId}.output`] = ns.output;
			}
		}
		// Also expose direct context entries
		for (const [k, v] of Object.entries(executionState.context)) {
			if (typeof v === 'string') { ctx[k] = v; }
		}
		return ctx;
	}

	/**
	 * v31: Evaluate a simple condition string (after variable substitution)
	 * against the current execution context. Supports:
	 *   - `value == "literal"` or `value === "literal"`
	 *   - `value != "literal"` or `value !== "literal"`
	 *   - `value contains "substring"`
	 *   - `value startsWith "prefix"` / `value endsWith "suffix"`
	 *   - plain boolean truthiness: non-empty string = true, empty = false
	 *
	 * Returns true if the condition evaluates to true, false otherwise.
	 * Returns false for conditions that can't be parsed (safe fail: defer to LLM).
	 */
	private _evaluateSimpleCondition(condition: string, _executionState: IWorkflowExecutionState): boolean {
		const text = condition.trim();
		if (!text) { return false; }

		// Pattern: `"something"` or `'something'` → plain truthiness check.
		// Non-empty quoted literal → true (means this branch fires).
		// But a bare quoted string without an operator has no meaning, skip.
		if (/^["'].*["']$/.test(text)) {
			// A condition that's just a quoted literal is unusual — treat as truthy.
			return text.length > 2; // at least one char inside quotes
		}

		// Try `value == "literal"` / `value === "literal"`
		const eqMatch = text.match(/^(.+?)\s*[=!]==?\s*["'](.+?)["']$/);
		if (eqMatch) {
			const lhs = eqMatch[1].trim();
			const op = text.includes('!=') || text.includes('!==') ? '!=' : '==';
			const rhs = eqMatch[2];
			return op === '==' ? lhs === rhs : lhs !== rhs;
		}

		// Try `value contains "substring"`
		const containsMatch = text.match(/^(.+?)\s+contains\s+["'](.+?)["']$/i);
		if (containsMatch) {
			return containsMatch[1].trim().toLowerCase().includes(containsMatch[2].toLowerCase());
		}

		// Try `value startsWith "prefix"` / `value endsWith "suffix"`
		const startsMatch = text.match(/^(.+?)\s+startsWith\s+["'](.+?)["']$/i);
		if (startsMatch) {
			return startsMatch[1].trim().toLowerCase().startsWith(startsMatch[2].toLowerCase());
		}
		const endsMatch = text.match(/^(.+?)\s+endsWith\s+["'](.+?)["']$/i);
		if (endsMatch) {
			return endsMatch[1].trim().toLowerCase().endsWith(endsMatch[2].toLowerCase());
		}

		// Try `value matches /regex/`
		const regexMatch = text.match(/^(.+?)\s+matches\s+\/(.+?)\/$/i);
		if (regexMatch) {
			try {
				return new RegExp(regexMatch[2], 'i').test(regexMatch[1].trim());
			} catch {
				return false;
			}
		}

		// Cannot parse — defer to LLM (return false = no deterministic decision,
		// caller falls through to LLM evaluation)
		return false;
	}

	// --------------------------------------------------------------------------------------------
	// Helper Methods
	// --------------------------------------------------------------------------------------------

	private _getNextNodes(nodeId: string, adj: Map<string, { targetId: string; fromPort?: string }[]>): string[] {
		const connections = adj.get(nodeId) ?? [];
		return connections.map(c => c.targetId);
	}

	/**
	 * v30: AskUser port-aware routing. Unlike `_getNextNodes` which
	 * returns ALL downstream nodes unconditionally, this method only
	 * returns nodes whose edge's `fromPort` matches one of the selected
	 * option indices (formatted as 'option-N'). This prevents
	 * "暂不提交" / "取消操作" selections from accidentally flowing into
	 * the git-commit agent branch.
	 *
	 * When no edges carry a matching fromPort, callers should fall back
	 * to `_getNextNodes` for backward compatibility with old workflows
	 * that don't have port-specific edges behind AskUser nodes.
	 */
	private _getAskUserNextNodes(
		nodeId: string,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		selectedIndices: number[],
	): string[] {
		const connections = adj.get(nodeId) ?? [];
		const ports = new Set(selectedIndices.map(i => `option-${i}`));
		return connections
			.filter(c => c.fromPort && ports.has(c.fromPort))
			.map(c => c.targetId);
	}

	// ─── v6: Variable collection helpers ───────────────────────────────────

	/**
	 * Scan all agent/prompt/skill/tool nodes in the workflow for `{{variable}}` patterns
	 * in their `data.prompt`, `data.skillArgs` (Record<string,string>), or
	 * `data.toolParams` (Record<string,string>) fields. Returns deduplicated
	 * variable names with optional default values. Built-in variables
	 * (`{{input}}`, `{{$prev.output}}`, etc.) are skipped — they're auto-resolved
	 * by the runtime value map.
	 */
	private static _collectTemplateVariables(workflow: IStoredWorkflow): Array<{ name: string; defaultValue?: string }> {
		// 委托给纯函数 collectWorkflowVariables（templateUtils.ts），与 composer 参数表单
		// 共用同一实现，避免前后端变量列表漂移。
		return collectWorkflowVariables(workflow.nodes);
	}

	/**
	 * Substitute variable values into all node `data.prompt`, `data.skillArgs`,
	 * and `data.toolParams` fields in the workflow graph (in-place mutation).
	 */
	private static _substituteVariables(workflow: IStoredWorkflow, values: Record<string, string>): void {
		const nodes = workflow.nodes;
		if (!nodes) { return; }

		for (const node of nodes) {
			const data = node.data as Record<string, unknown>;
			if (!data) { continue; }

			// Substitute in prompt (string).
			if (typeof data.prompt === 'string') {
				data.prompt = WorkflowExecutionService._replaceVariables(data.prompt, values);
			}
			// Substitute in skillArgs values (Record<string, string>).
			if (data.skillArgs && typeof data.skillArgs === 'object') {
				const sa = data.skillArgs as Record<string, string>;
				for (const k of Object.keys(sa)) {
					if (typeof sa[k] === 'string') {
						sa[k] = WorkflowExecutionService._replaceVariables(sa[k], values);
					}
				}
			}
			// Substitute in toolParams values (Record<string, string>).
			if (data.toolParams && typeof data.toolParams === 'object') {
				const tp = data.toolParams as Record<string, string>;
				for (const k of Object.keys(tp)) {
					if (typeof tp[k] === 'string') {
						tp[k] = WorkflowExecutionService._replaceVariables(tp[k], values);
					}
				}
			}
		}
	}

	/**
	 * W7: 解析本次执行的起跑节点集合。
	 *
	 *  - 常规：`[startNode]` —— 严格「从 Start 开始」，Start 不可达的子图靠入度
	 *    永不归零自动跳过（v38 语义）。
	 *  - 退化：Start **未编排**（没有出边，或出边只指向 End/另一个 Start）时，
	 *    返回 Start + 所有入度为 0 的其它根节点 ≈ 全图执行。
	 *    与 webview `resolveStartScope().degraded` 同语义 —— 让「只摆了 Start→End
	 *    而业务链独立」的存量图在聊天框触发时不会一个业务节点都不跑。
	 */
	private _resolveEntryNodes(
		nodes: readonly WorkflowGraphNode[],
		connections: readonly { from: string; to: string }[],
		startNode: WorkflowGraphNode,
		inDeg: ReadonlyMap<string, number>,
	): WorkflowGraphNode[] {
		const typeById = new Map(nodes.map(n => [n.id, n.type]));
		const isTerminalTarget = (id: string): boolean => {
			const t = typeById.get(id);
			return t === WorkflowNodeType.End || t === WorkflowNodeType.Start;
		};
		const startIds = new Set(nodes.filter(n => n.type === WorkflowNodeType.Start).map(n => n.id));
		const orchestrated = connections.some(c => startIds.has(c.from) && !isTerminalTarget(c.to));
		if (orchestrated) {
			// ★ 孤儿根节点并入起跑集（2026-09-10 卡死实锤）：表情包工作流的
			//   ImageLoaderStage 不挂 Start 链（独立素材加载起点），此前被「严格从
			//   Start 开始」设计性跳过 → 下游 StatEmojiStage 的 join 入度永不归零 →
			//   「Execution completed」假象 + 出图节点从未执行。入度 0 的非 Start
			//   节点 = 画布上独立摆放的执行起点（多源 DAG），必须并入起跑集。
			const orphanRoots = nodes.filter(n =>
				n.type !== WorkflowNodeType.Start &&
				n.type !== WorkflowNodeType.End &&
				(inDeg.get(n.id) ?? 0) === 0);
			if (orphanRoots.length > 0) {
				this.logService.info(
					`[WorkflowExecution] ${orphanRoots.length} orphan root node(s) outside the Start chain ` +
					`added to entry set: ${orphanRoots.map(n => `${n.id}(${n.type})`).join(', ')}`,
				);
				return [startNode, ...orphanRoots];
			}
			return [startNode];
		}
		const roots = nodes.filter(n => n.id !== startNode.id && (inDeg.get(n.id) ?? 0) === 0);
		if (roots.length === 0) {
			return [startNode];
		}
		this.logService.warn(
			`[WorkflowExecution] Start node "${startNode.id}" is not wired to any business node ` +
			`— degrading to whole-graph execution (${roots.length} extra root node(s)). ` +
			`Connect Start → first node to control the entry point precisely.`,
		);
		return [startNode, ...roots];
	}

	/**
	 * W7: 把 Start 节点的 `data.args` 展平成 `args.<key>` 注入执行上下文。
	 *
	 * 语义与 webview 侧 `collectStartArgs`（comfyHost/workflowRunShared.ts）对齐：
	 *  - args 支持 JSON 字符串或对象两种形态（非法 JSON 静默忽略）；
	 *  - 多个 Start 浅合并，后者覆盖前者；
	 *  - **已存在的 context 同名项优先**（聊天/Agent 触发传入的 variables / input
	 *    是运行时覆盖，语义等价画布侧 `startArgsOverride`）。
	 * 值统一 String 化：`_buildEvalContext` 只把 string 项暴露给模板替换。
	 */
	private _injectStartArgs(
		executionState: IWorkflowExecutionState,
		nodes: readonly WorkflowGraphNode[],
	): void {
		const merged: Record<string, unknown> = {};
		for (const n of nodes) {
			if (n.type !== WorkflowNodeType.Start) { continue; }
			const raw = (n.data as Record<string, unknown> | undefined)?.args;
			if (typeof raw === 'string') {
				try {
					const parsed = JSON.parse(raw) as unknown;
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						Object.assign(merged, parsed as Record<string, unknown>);
					}
				} catch {
					this.logService.warn(`[WorkflowExecution] Start node ${n.id}: data.args is not valid JSON, ignored`);
				}
			} else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
				Object.assign(merged, raw as Record<string, unknown>);
			}
		}
		const keys = Object.keys(merged);
		if (keys.length === 0) { return; }
		for (const [k, v] of Object.entries(merged)) {
			const contextKey = `args.${k}`;
			// 运行时覆盖优先：context 已有同名 key（触发方显式传入）→ 不动；
			// 否则若 context 有裸 key（如 variables 里的 `topic`）→ 用它覆盖默认值。
			if (executionState.context[contextKey] !== undefined) { continue; }
			const override = executionState.context[k];
			const value = override !== undefined ? override : v;
			executionState.context[contextKey] = typeof value === 'object' && value !== null
				? JSON.stringify(value)
				: String(value ?? '');
		}
		this.logService.info(`[WorkflowExecution] Injected Start args into context: ${keys.map(k => `args.${k}`).join(', ')}`);
	}

	private static _replaceVariables(template: string, values: Record<string, string>): string {
		// v23: delegate to the shared `substituteHostVariables` so both the
		// pre-execution pass and the per-node pass use the SAME regex
		// (which now supports `.output` and other `.field` suffixes).
		// Previously this inlined `/\{\{(\$?\w+)\}\}/g` which silently
		// failed on `{{$prev.output}}` because `\w+` doesn't match `.`.
		return substituteHostVariables(template, values);
	}

	// ─── v23: per-node upstream variable substitution ───────────────────

	/**
	 * Build an `upstreamOutputs` map by reading the final `output` field of
	 * every node in `executionState.nodeStates` that has finished (Completed,
	 * Failed, Skipped, or Cancelled — anything with a terminal status).
	 *
	 * Why include all finished nodes, not just immediate topological
	 * predecessors: workflow authors usually write prompts referencing
	 * upstream nodes by their stable ReactFlow `node.id` (e.g.
	 * `{{printerNode.output}}`), and that id can be several hops back. We
	 * intentionally don't enforce a graph-walk because:
	 *   1. The graph adjacency isn't always available inside this method
	 *      (we'd have to thread `adj: Map<...>` from the caller, which is
	 *      fragile — `adj` is built per-execution and is per-direction).
	 *   2. The value map is keyed by `nodeId`, so as long as the user
	 *      references a node by its id, lookup works regardless of topology.
	 *   3. Failed / cancelled nodes contribute empty strings (with a
	 *      one-line warn) so the substitution result is still a coherent
	 *      prompt instead of leaving a `{{nodeId.output}}` literal.
	 *
	 * For the `$prev` alias we use the most recently *finished* node (by
	 * its `endTime`), which is what the workflow author intuitively means
	 * by "the previous node's output" — typically the immediate predecessor
	 * in the run order.
	 */
	private _collectUpstreamOutputs(
		executionState: IWorkflowExecutionState,
	): Record<string, string> {
		const upstream: Record<string, string> = {};
		let lastEndTime: number | undefined;
		let lastId: string | undefined;
		let lastOut: string | undefined;
		for (const [nodeId, state] of executionState.nodeStates.entries()) {
			const isTerminal = state.status === WorkflowNodeExecutionStatus.Completed
				|| state.status === WorkflowNodeExecutionStatus.Failed
				|| state.status === WorkflowNodeExecutionStatus.Skipped
				|| state.status === WorkflowNodeExecutionStatus.Cancelled;
			if (!isTerminal) { continue; }
			upstream[nodeId] = state.output ?? '';
			const end = state.endTime ? Date.parse(state.endTime) : undefined;
			if (end !== undefined && (lastEndTime === undefined || end > lastEndTime)) {
				lastEndTime = end;
				lastId = nodeId;
				lastOut = state.output ?? '';
			}
		}
		// `$prev` = the most recently finished node. We do NOT inject it
		// into the map here — `buildRuntimeValueMap` reads `args.upstreamOutputs`
		// and inserts the alias itself (it picks the last key in the
		// object iteration, which roughly matches "most recently added"
		// in modern V8 for string keys). Passing an explicit lastId as a
		// synthetic key is brittle, so we leave the alias logic to the
		// helper. If authors complain `$prev` resolves to the wrong node
		// we can revisit.
		if (lastId && lastOut !== undefined) {
			this.logService.debug(
				`[WorkflowExecution] upstream: last finished node = ${lastId} ` +
				`(endTime=${new Date(lastEndTime!).toISOString()}, outputLen=${lastOut.length})`,
			);
		}
		return upstream;
	}

	/**
	 * Per-node substitution pass. Called at the start of `_executeNodeRecursive`,
	 * *after* the node is marked Running but *before* any of the per-type
	 * executors run. Builds a runtime value map from the execution context,
	 * the node's own `data.variables` overrides, and the `upstreamOutputs` of
	 * every previously-finished node; then mutates `node.data.prompt` (and
	 * `node.data.skillArgs[*]` / `node.data.toolParams[*]` if present) in place
	 * with the substituted strings.
	 *
	 * Why mutate: the four per-type executors (`_executeTaskNode`,
	 * `_executeAgentNode`, `_executeSkillNode`, `_executeToolNode`) all
	 * read `data.prompt` directly, so in-place mutation guarantees the
	 * substituted prompt reaches them without plumbing a return value
	 * through 4 call sites.
	 *
	 * Why this is safe: the pre-execution `_substituteVariables` pass has
	 * already replaced user-supplied variables; the only references that
	 * survive that pass are `{{$prev.output}}` / `{{$prev}}` / `{{nodeId.output}}`
	 * (which were undefined at pre-execution time because no upstream
	 * nodes had finished). So this second pass is a strict superset and
	 * no variable gets double-substituted.
	 */
	private _substituteUpstreamVariables(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
	): void {
		const data = node.data as Record<string, unknown> | undefined;
		if (!data) { return; }
		// Start / End / AskUser / control-flow nodes have no prompt to
		// substitute; short-circuit to avoid logging "0 substitutions"
		// noise.
		if (node.type === WorkflowNodeType.Start || node.type === WorkflowNodeType.End) {
			return;
		}

		const upstreamOutputs = this._collectUpstreamOutputs(executionState);
		const values = buildRuntimeValueMap({
			context: executionState.context as Record<string, unknown>,
			nodeVariables: (data.variables as Record<string, string> | undefined) ?? undefined,
			upstreamOutputs,
			workflowName: workflow.name || '',
			// ★ 共享内存读路径（2026-09-11）：`{{shared.<key>}}`。此前 sharedMemory
			//   只写不读 → 文档承诺的「所有节点可见」从未生效。
			sharedMemory: executionState.sharedMemory,
		});

		let didReplace = false;
		if (typeof data.prompt === 'string' && data.prompt.includes('{{')) {
			const next = substituteHostVariables(data.prompt, values);
			if (next !== data.prompt) {
				this.logService.info(
					`[WorkflowExecution] v23 substituted upstream vars in node ${node.id} prompt ` +
					`(len ${data.prompt.length} → ${next.length})`,
				);
				data.prompt = next;
				didReplace = true;
			}
		}
		// Also substitute in skillArgs (Record<string, string>) — the
		// values may contain `{{$prev.output}}` references too.
		if (data.skillArgs && typeof data.skillArgs === 'object') {
			const sa = data.skillArgs as Record<string, string>;
			for (const k of Object.keys(sa)) {
				if (typeof sa[k] === 'string' && sa[k].includes('{{')) {
					const next = substituteHostVariables(sa[k], values);
					if (next !== sa[k]) {
						sa[k] = next;
						didReplace = true;
					}
				}
			}
		}
		// And toolParams (Record<string, string | unknown>) — we only
		// touch string values, leaving complex object params alone.
		if (data.toolParams && typeof data.toolParams === 'object') {
			const tp = data.toolParams as Record<string, unknown>;
			for (const k of Object.keys(tp)) {
				if (typeof tp[k] === 'string' && (tp[k] as string).includes('{{')) {
					const next = substituteHostVariables(tp[k] as string, values);
					if (next !== tp[k]) {
						tp[k] = next;
						didReplace = true;
					}
				}
			}
		}
		if (didReplace) {
			this.logService.debug(
				`[WorkflowExecution] v23 node ${node.id} (${node.type}) prompt/args substituted; ` +
				`upstream keys: [${Object.keys(upstreamOutputs).join(', ')}]`,
			);
		}
	}

	// ─── v6: submitWorkflowVariables ────────────────────────────────────────

	async submitWorkflowVariables(executionId: string, values: Record<string, string>): Promise<void> {
		this.logService.info(`[WorkflowExecution] submitWorkflowVariables: executionId=${executionId}, keys=${Object.keys(values).join(',')}`);
		const resolver = this._variableResolvers.get(executionId);
		if (!resolver) {
			throw new Error(`No pending variable collection for execution: ${executionId}`);
		}
		this._variableResolvers.delete(executionId);
		resolver(values);
	}

	// ─── v21: Active stream tracking for cancel ──────────────────────────

	/**
	 * Abort the in-flight chat stream for a given execution, if any. Called
	 * by `cancelExecution` so the node executor's `await sendMessage(...)`
	 * returns within a few ms instead of waiting for the LLM to finish its
	 * full response. Idempotent — safe to call when no stream is active.
	 */
	private _abortActiveStream(executionId: string): void {
		const stream = this._activeStreams.get(executionId);
		if (!stream) { return; }
		this._activeStreams.delete(executionId);
		this.logService.info(
			`[WorkflowExecution] aborting active stream for executionId=${executionId} ` +
			`(agentId=${stream.agentId}, agentSessionId=${stream.agentSessionId || '<none>'}, nodeId=${stream.nodeId})`,
		);
		try {
			// agentChatService stores the stream under `${agentId}::${agentSessionId}`
			// when sessionId is set, or just `${agentId}` when not. cancelStream
			// handles both shapes; pass undefined sessionId to use the latter form.
			if (stream.agentSessionId) {
				this.agentChatService.cancelStream(stream.agentId, stream.agentSessionId);
			} else {
				this.agentChatService.cancelStream(stream.agentId);
			}
		} catch (err) {
			this.logService.warn(
				`[WorkflowExecution] cancelStream failed (continuing with status-only cancel): ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	/**
	 * Run a node's `agentChatService.sendMessage(...)` call with the execution's
	 * active stream registered so `cancelExecution` can abort it. Throws
	 * `WorkflowCancelledError` if the execution has already been cancelled
	 * (defense in depth — combined with the abort in `_abortActiveStream`,
	 * the node executor returns within milliseconds of a cancel click).
	 *
	 * Use this from every node executor that calls `sendMessage` (task / agent
	 * / skill / tool / ifElse). The `try/finally` guarantees the stream entry
	 * is removed when sendMessage returns, regardless of success or error.
	 */
	private async _sendAndTrackStream(
		executionState: IWorkflowExecutionState,
		node: WorkflowGraphNode,
		agentId: string,
		prompt: string,
		agentSessionId: string | undefined,
		onDelta: (delta: any) => void,
		extraOptions?: { systemPrompt?: string },
		timeoutConfig?: { runTimeoutMs?: number; idleTimeoutMs?: number },
	): Promise<any> {
		if (executionState.status === WorkflowExecutionStatus.Cancelled) {
			throw new Error(`Workflow execution ${executionState.executionId} was cancelled`);
		}

		// v31: trim history if maxHistoryMessages is set.
		if (executionState.options?.maxHistoryMessages && agentSessionId) {
			const history = await this.agentChatService.getHistory(agentId, agentSessionId);
			if (history.length > executionState.options.maxHistoryMessages) {
				const excess = history.length - executionState.options.maxHistoryMessages;
				await this.agentChatService.clearHistory(agentId, agentSessionId);
				const kept = history.slice(-executionState.options.maxHistoryMessages);
				// ★ 2026-09-11：改为批量落盘（原为逐条 `await appendMessage`）。
				// `appendMessage` 每次都会**全量重写**会话文件与全局历史，逐条调用
				// `maxHistoryMessages` 次（常见 50–100）会造成 O(N × 会话大小) 的
				// 同步阻塞 —— 与 finalization 那次「app 卡死」同源（日志 20260911T193945）。
				await this.agentChatService.appendMessagesBatch(agentId, kept);
				this.logService.info(
					`[WorkflowExecution] Trimmed ${excess} old messages from session ${agentSessionId} ` +
					`for node ${node.id} (kept ${kept.length})`,
				);
			}
		}

		this._activeStreams.set(executionState.executionId, {
			agentId,
			agentSessionId: agentSessionId ?? '',
			nodeId: node.id,
		});

		let idleHandle: any;

	try {
		// v31/v32: timeout protection via Promise.race.
		const runTimeoutMs = timeoutConfig?.runTimeoutMs ?? 300_000; // default 5 min
		// v40: default idle timeout 120s — if no delta received within 120s,
		// the stream is likely stuck (e.g. model call hanging, executeTurn
		// blocked on an await). Without this, the UI freezes indefinitely.
		const idleTimeoutMsVal = timeoutConfig?.idleTimeoutMs ?? 120_000;

			const promises: Promise<any>[] = [];

			// Set up delta callback (may be wrapped with idle reset)
			let deltaCallback = onDelta;

			if (idleTimeoutMsVal && idleTimeoutMsVal > 0) {
				let idleReject: ((reason: any) => void) | undefined;
				const idleTimeoutPromise = new Promise<never>((_, reject) => {
					idleReject = reject;
				});
				promises.push(idleTimeoutPromise);

				const resetIdle = () => {
					if (idleHandle) { clearTimeout(idleHandle); }
					idleHandle = setTimeout(() => {
						try {
							if (agentSessionId) {
								this.agentChatService.cancelStream(agentId, agentSessionId);
							} else {
								this.agentChatService.cancelStream(agentId);
							}
						} catch { /* best effort */ }
						idleReject?.(new Error(
							`Node ${node.id} timed out after ${idleTimeoutMsVal}ms (idle timeout — ` +
							`no token received for ${idleTimeoutMsVal}ms). The stream has been cancelled.`,
						));
					}, idleTimeoutMsVal);
				};

				deltaCallback = (delta: any) => {
					resetIdle();
					onDelta(delta);
				};

				resetIdle();
			}

			// ── Run timeout (total wall-clock) ───────────────────────────
			if (runTimeoutMs > 0) {
				promises.push(new Promise<never>((_, reject) => {
					setTimeout(() => {
						try {
							if (agentSessionId) {
								this.agentChatService.cancelStream(agentId, agentSessionId);
							} else {
								this.agentChatService.cancelStream(agentId);
							}
						} catch { /* best effort */ }
						reject(new Error(
							`Node ${node.id} timed out after ${runTimeoutMs}ms (run timeout). ` +
							`The stream has been cancelled.`,
						));
					}, runTimeoutMs);
				}));
			}

			// Create sendPromise with (possibly wrapped) deltaCallback
			// v39: forward node-level provider/model config into sendMessage
			// options so the global active model selection is overridden for
			// this specific workflow node.
			const nodeData = node.data as Record<string, any>;
			const agentConfig = nodeData?.agentConfig as { providerId?: string; modelId?: string } | undefined;
			this.logService.info(`[WorkflowExecution] _sendAndTrackStream: calling sendMessage (agentId=${agentId}, promptLen=${prompt.length}, sessionId=${agentSessionId ?? 'none'})`);
			const t0_send = Date.now();
			const sendPromise = this.agentChatService.sendMessage(
				agentId,
				prompt,
				{
					workspaceId: undefined,
					agentSessionId,
					systemPrompt: extraOptions?.systemPrompt,
					providerId: agentConfig?.providerId,
					model: agentConfig?.modelId,
				},
				deltaCallback,
			);
			promises.push(sendPromise);

			this.logService.info(`[WorkflowExecution] _sendAndTrackStream: awaiting Promise.race (${promises.length} promises, node=${node.id})`);
			const result = await Promise.race(promises);
			this.logService.info(`[WorkflowExecution] _sendAndTrackStream: Promise.race resolved in ${Date.now() - t0_send}ms (node=${node.id})`);

			return result;
		} finally {
			const cur = this._activeStreams.get(executionState.executionId);
			if (cur && cur.nodeId === node.id) {
				this._activeStreams.delete(executionState.executionId);
			}
			if (idleHandle) {
				clearTimeout(idleHandle);
			}
		}

	}

	/**
	 * v32: Save a checkpoint snapshot of the current execution state.
	 * Checkpoints are saved after each node completes (success or failure)
	 * to `{workspace}/.sarosworkspace/checkpoints/{executionId}.json`.
	 * This enables resumption from the last checkpoint after a crash.
	 */
		private async _saveCheckpoint(executionState: IWorkflowExecutionState): Promise<void> {
		try {
			// ★ 写出格式统一走 `buildWorkflowCheckpoint`（与 `parseWorkflowCheckpoint` 成对，
			//   往返由 workflowCheckpoint 测试保证）。此前格式**内联在此处**、读入侧根本不存在
			//   → 改字段无任何提示，且「只写不读」使断点续跑实际不可用。
			const checkpoint = buildWorkflowCheckpoint({
				executionId: executionState.executionId,
				workflowId: executionState.workflowId,
				status: executionState.status,
				nodeStates: executionState.nodeStates.entries(),
				context: executionState.context,
				sharedMemory: executionState.sharedMemory?.entries() ?? [],
			});

			const workspaces = this.workspaceRegistry.getWorkspaces();
			const activeWorkspace = workspaces.find(w => w.isActive);
			if (activeWorkspace?.path) {
				const checkpointsDir = URI.joinPath(
					URI.file(activeWorkspace.path),
					'.sarosworkspace',
					'checkpoints',
				);
				await this.fileService.createFolder(checkpointsDir);
				const fileUri = URI.joinPath(checkpointsDir, `${executionState.executionId}.json`);
				await this.fileService.writeFile(
					fileUri,
					VSBuffer.fromString(JSON.stringify(checkpoint, null, 2)),
				);
			}
		} catch (err) {
			this.logService.warn(
				`[WorkflowExecution] Checkpoint save failed: ` +
				`${err instanceof Error ? err.message : err}`,
			);
		}
	}

	/**
	 * 读取并校验 checkpoint（磁盘内容**不可信**：手改 / 旧版本 / 写入被中断
	 * → 必须经 `parseWorkflowCheckpoint` 校验，坏文件不能让恢复流程炸掉）。
	 *
	 * 返回 `undefined` = 没有可恢复的断点（文件不存在 / 校验失败 / 无活动工作区）。
	 */
	private async _loadCheckpoint(executionId: string): Promise<IWorkflowCheckpoint | undefined> {
		try {
			const workspaces = this.workspaceRegistry.getWorkspaces();
			const activeWorkspace = workspaces.find(w => w.isActive);
			if (!activeWorkspace?.path) { return undefined; }
			const fileUri = URI.joinPath(
				URI.file(activeWorkspace.path),
				'.sarosworkspace',
				'checkpoints',
				`${executionId}.json`,
			);
			const content = await this.fileService.readFile(fileUri);
			const parsed = parseWorkflowCheckpoint(content.value.toString());
			if (!parsed.ok) {
				this.logService.warn(`[WorkflowExecution] Checkpoint 校验失败（${executionId}）：${parsed.error}`);
				return undefined;
			}
			return parsed.checkpoint;
		} catch (err) {
			this.logService.info(
				`[WorkflowExecution] 无可用 checkpoint（${executionId}）：` +
				`${err instanceof Error ? err.message : err}`,
			);
			return undefined;
		}
	}

	/**
	 * ★ 断点续跑（2026-09-11 补齐「只写不读」的另一半）。
	 *
	 * 语义（崩溃一致性）：`completed` 节点**复用产出**（output 回填 nodeStates，下游
	 * `{{nodeId.output}}` 照常取用），其余节点（含崩溃时处于 `running` 的）**全部重跑**。
	 * 判定规则见 `planWorkflowResume` —— 关键点是**绝不把 `running` 当成功**（崩溃时
	 * 正在执行的节点副作用可能只做了一半）。
	 *
	 * 调用方：`workflow.resume`（webview 侧「恢复」按钮）在**没有 pending 交互暂停**时
	 * 回退到本方法。
	 */
	async resumeFromCheckpoint(executionId: string): Promise<string> {
		const checkpoint = await this._loadCheckpoint(executionId);
		if (!checkpoint) {
			throw new Error(`没有可恢复的断点: ${executionId}`);
		}
		const workflow = await this.workflowStorage.getWorkflow(checkpoint.workflowId);
		if (!workflow) {
			throw new Error(`断点对应的工作流不存在: ${checkpoint.workflowId}`);
		}

		const nodeIds = (workflow.nodes ?? []).map(n => n.id);
		const plan = planWorkflowResume(checkpoint, nodeIds);
		this.logService.info(`[WorkflowExecution] resumeFromCheckpoint ${executionId}: ${plan.summary}`);

		const reusableByNode = new Map(plan.reusable.map(r => [r.nodeId, r]));
		const nodeStates = new Map<string, IWorkflowNodeExecutionState>();
		for (const nodeId of nodeIds) {
			const reusable = reusableByNode.get(nodeId);
			nodeStates.set(nodeId, reusable
				? {
					nodeId,
					status: WorkflowNodeExecutionStatus.Completed,
					output: reusable.output,
					endTime: checkpoint.timestamp,
				}
				: { nodeId, status: WorkflowNodeExecutionStatus.Pending });
		}

		const sharedMemory = new Map<string, string>(checkpoint.sharedMemory ?? []);
		const context: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(checkpoint.context ?? {})) {
			try { context[key] = JSON.parse(value); } catch { context[key] = value; }
		}

		const state: IWorkflowExecutionState = {
			executionId: checkpoint.executionId,
			workflowId: checkpoint.workflowId,
			status: WorkflowExecutionStatus.Running,
			nodeStates,
			startTime: new Date().toISOString(),
			context,
			sharedMemory,
		};
		this._executions.set(executionId, state);
		// ★ 标记「本次执行是断点恢复」：`_executeNodeRecursive` 只对恢复态跳过已 Completed
		//   节点（正常执行不会重入已完成节点，加跳过反而会掩盖潜在 bug）。
		this._resumedExecutions.add(executionId);
		this._onDidExecutionStatusChange.fire(state);
		await this._executeWorkflowAsync(state, workflow, undefined);
		return executionId;
	}
}
