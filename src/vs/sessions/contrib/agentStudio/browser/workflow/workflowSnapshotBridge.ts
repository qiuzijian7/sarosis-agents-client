/*---------------------------------------------------------------------------------------------
 *  workflowSnapshotBridge — dynamic workflow ⇄ workflow-editor webview 数据桥（M2）。
 *
 *  复刻 canvasOpsBridge 的解耦范式（工具层永不直接触碰 controller）：
 *    1. 引擎的 snapshotPort.get(query) → requestSnapshotOutput() 注册 pending
 *       promise 并 fire snapshotQueryEmitter。
 *    2. agentStudioWebviewController 订阅 emitter → 推送
 *       `workflow.snapshotQuery` 事件（queryId + stageUid/slot）到画布 webview。
 *    3. webview 查 mediaSnapshotStore（byNode 前缀合并天然处理 nodeId/uid 别名），
 *       物化为 PortValue（json 原值 / string / {kind:'media',url,mime}）后经
 *       `workflow.snapshotResult` request 回程（queryId + ok/value|error）。
 *    4. controller 收到回程调 resolveSnapshotOutput → 解 pending。
 *
 *  归档（写方向）：run completed 且调用方传 canvasAnchorUid 时，工具层调
 *  archiveWorkflowResult() → snapshotArchiveEmitter → `workflow.snapshotArchive`
 *  事件 → webview store.put SAROS_JSON（kind:'text' + meta.sarosJson，键=锚点 uid，
 *  走既有 nodeId↔uid 别名归档体系，绝不引入第三套键）。
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { WorkflowError } from '../../common/workflowError.js';
import type { IWorkflowNodeOutputQuery, IWorkflowStageRunRequest } from '../../common/workflow/protocol.js';
import type { IWorkflowSnapshotPort, IWorkflowStagePort } from './workflowEngine.js';

/** controller 转发给 webview 的查询事件载荷。 */
export interface SnapshotQueryRequest {
	readonly queryId: string;
	readonly stageUid: string;
	readonly slot?: number;
}

/** webview 回程载荷（workflow.snapshotResult request）。 */
export interface SnapshotResultPayload {
	readonly queryId: string;
	readonly ok: boolean;
	readonly value?: unknown;
	readonly error?: string;
}

/** 归档事件载荷（workflow.snapshotArchive）。 */
export interface SnapshotArchiveRequest {
	readonly anchorUid: string;
	/** workflow run 的 return value（plain JSON）。 */
	readonly value: unknown;
	readonly meta: { readonly name: string; readonly runId: string };
}

/** M4b 投影归档载荷（projection.workflow 落盘为可打开的投影工作流）。 */
export interface ProjectionArchiveRequest {
	readonly meta: { readonly name: string; readonly runId: string };
	/** buildWorkflowProjection 产物（layers/phases/edges/agentsStarted/stopReason）。 */
	readonly projection: unknown;
}

/** P0 controller 转发给 webview 的「执行画布节点」事件载荷（写方向）。 */
export interface StageRunRequest {
	readonly runId: string;
	readonly stageUid: string;
	readonly overrides?: Record<string, unknown>;
}

/** webview 回程载荷（workflow.stageRunResult request）。 */
export interface StageRunResultPayload {
	readonly runId: string;
	readonly ok: boolean;
	readonly value?: unknown;
	readonly error?: string;
}

/** webview → host：stage 执行过程中的实时进度（workflow.stageRunProgress）。 */
export interface StageRunProgressPayload {
	readonly runId: string;
	readonly progress: number;
	readonly message?: string;
	/** 本次新产出的格子（逐格媒体回流，2026-09-11：「输出一个就显示一个」）。 */
	readonly media?: IStageRunMedia;
}

/** 工具/引擎层 → controller：请把查询转发给画布 webview。 */
export const snapshotQueryEmitter = new Emitter<SnapshotQueryRequest>();
/** 工具层 → controller：请把归档转发给画布 webview。 */
export const snapshotArchiveEmitter = new Emitter<SnapshotArchiveRequest>();
/** M4b 工具层 → controller：把运行投影落盘为投影工作流。 */
export const projectionArchiveEmitter = new Emitter<ProjectionArchiveRequest>();
/** P0 引擎层 → controller：请让画布执行指定媒体节点（写方向）。 */
export const stageRunEmitter = new Emitter<StageRunRequest>();

/**
 * controller → 画布 webview：请**停止**某次 `stage()` 执行（2026-09-11）。
 * 与 `directStageRunCancelEmitter` 同构 —— 触发点同为 `PendingRegistry` 判定请求被放弃。
 */
export const stageRunCancelEmitter = new Emitter<{ runId: string }>();

/**
 * 逐格媒体回流（2026-09-11 用户需求「动态表情包节点，输出一个就显示一个」）：
 * 画布执行器**逐格归档**，本桥随进度消息把**最新一格**带到 host（增量：同一格只推一次），
 * 使聊天卡在节点**尚未结束**时就能逐个显示已产出的格子（此前只在 `subagent_end` 拿到整份
 * `snapshot` → 9 格全跑完才出图 ✗）。形状定义在 common 层（与 delegate 接口共用）。
 */
export type { IStageRunMedia };
import type { IStageRunMedia } from '../../common/comfyBridge.js';

interface PendingQuery {
	resolve: (v: unknown) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	/** stage run 专属：实时进度回调（ComfyUI 生成进度透传到 UI；media = 该次新产出的格子）。 */
	onProgress?: (progress: number, message?: string, media?: IStageRunMedia) => void;
	/** 空闲超时（毫秒）；<= 0 表示不限时。 */
	timeoutMs: number;
	/** 绝对上限时间戳：即使持续有进度也不超过它（防「伪进度」僵尸请求）。 */
	hardDeadline: number;
	/** 上次排定定时器的时间戳（续期节流用）。 */
	armedAt: number;
	/** 超时错误工厂。reason: 'idle' = 空闲超时；'cap' = 触达绝对上限。 */
	onTimeout: (reason: 'idle' | 'cap') => Error;
	/**
	 * 请求被放弃时的回调（2026-09-11）：直跑用它通知画布**停止执行** ——
	 * 否则 host 判死后画布仍在跑，稍后还可能出图（僵尸）✗。
	 */
	onAbandon?: (id: string) => void;
	/**
	 * 归属的 workflow executionId（2026-09-11）：`cancelExecution` 据此批量放弃 ——
	 * 用户取消工作流时能立即收尾，不必等超时。
	 */
	executionId?: string;
}

/**
 * ★ v40 泛型 pending 注册表（2026-09-09）：收敛三份同构的
 * `Map<id, {resolve,reject,timer,onProgress}>` 复制粘贴（snapshotQuery / stageRun /
 * directStageRun 三桥各自实现了一遍注册/超时/回程/进度）。对外 API 不变——
 * controller 消费的 resolve 与 progress 回调函数签名原样保留。
 */
export class PendingRegistry {
	/**
	 * 绝对上限 = 空闲额度的倍数（2026-09-11）：有进度可不断续期，但总时长不超过此倍数，
	 * 避免「持续上报伪进度」的僵尸请求永远挂着。
	 *
	 * 取 12（直跑 stage：720s × 12 = 2.4h）：真正判死的是**空闲**计时器（12 分钟没动静），
	 * 本上限只是「伪进度」的保险丝，故给足余量 —— 实测 9 格 AnimatedEmoji
	 * （逐格图生视频 + 抠像 + 拼 GIF）单节点就可能跑 20 分钟以上，6 倍（72 min）余量偏紧。
	 */
	static readonly HARD_CAP_FACTOR = 12;
	/**
	 * 续期节流比例：进度事件可能非常密集（ComfyUI 逐帧回调），无需每次都重排定时器；
	 * 但间隔必须**与空闲额度成比例** —— 固定值（如 1s）在空闲额度很小时等于「永不续期」
	 * （单测实测踩到：timeoutMs=60ms 时 1s 节流使续期完全失效）✗。
	 * 取空闲额度的 1/4：既避免逐帧重排，又保证在额度耗尽前必然续上。
	 */
	private static readonly REARM_FRACTION = 4;

	private readonly map = new Map<string, PendingQuery>();

	/** 注册 pending 并启动超时计时（timeoutMs <= 0 = 不限时）。返回 false = id 重复。 */
	register(
		id: string,
		resolve: (v: unknown) => void,
		reject: (err: Error) => void,
		timeoutMs: number,
		onTimeout: (reason: 'idle' | 'cap') => Error,
		onProgress?: (progress: number, message?: string, media?: IStageRunMedia) => void,
		extras?: {
			/** 放弃时回调（直跑用它通知画布停止执行）。 */
			onAbandon?: (id: string) => void;
			/** 归属的 executionId：`cancelExecution` 据此批量放弃。 */
			executionId?: string;
			/** 总时长上限（毫秒）；`Number.POSITIVE_INFINITY` = **不限总时长**（只保留空闲检测）。 */
			hardCapMs?: number;
		},
	): boolean {
		if (this.map.has(id)) { return false; }
		const now = Date.now();
		const hardCapMs = extras?.hardCapMs
			?? (timeoutMs > 0 ? timeoutMs * PendingRegistry.HARD_CAP_FACTOR : Number.POSITIVE_INFINITY);
		const pending: PendingQuery = {
			resolve, reject, onProgress, onTimeout, timeoutMs,
			onAbandon: extras?.onAbandon,
			executionId: extras?.executionId,
			hardDeadline: Number.isFinite(hardCapMs) ? now + hardCapMs : Number.POSITIVE_INFINITY,
			armedAt: now,
		};
		this.map.set(id, pending);
		this._arm(id, pending);
		return true;
	}

	/**
	 * 放弃指定 id 的 pending（2026-09-11）：清定时器 → 通知 `onAbandon`（让画布停止执行）
	 * → 以 `error` reject（让等待方立即收尾）。
	 *
	 * 用途：用户取消工作流时不必再等超时；也用于画布消失等异常收尾。
	 * 注意：工作流**取消**路径下，节点 delegate 抛错会被标 `Cancelled`（非 Failed，
	 * 不发红叉），见 workflowExecutionService 的 catch 分支 ✓。
	 */
	abandon(id: string, error: Error): boolean {
		const pending = this.map.get(id);
		if (!pending) { return false; }
		this.map.delete(id);
		if (pending.timer) { clearTimeout(pending.timer); }
		pending.onAbandon?.(id);
		pending.reject(error);
		return true;
	}

	/** 批量放弃某次工作流执行名下的所有 pending。返回放弃数量。 */
	abandonByExecution(executionId: string, error: Error): number {
		let n = 0;
		for (const [id, p] of [...this.map]) {
			if (p.executionId === executionId && this.abandon(id, error)) { n++; }
		}
		return n;
	}

	/**
	 * 排定（或重排）超时定时器：取「空闲额度」与「剩余绝对上限」的较小者。
	 *
	 * ★ 2026-09-11：**空闲超时语义** —— 由 `progress()` 在有进度时重排，故定时器
	 *   代表「这么久没有进度」而非「总共只能跑这么久」。
	 */
	private _arm(id: string, pending: PendingQuery): void {
		if (pending.timeoutMs <= 0) { return; }
		const remainingCap = pending.hardDeadline - Date.now();
		const wait = Math.min(pending.timeoutMs, Math.max(0, remainingCap));
		pending.armedAt = Date.now();
		pending.timer = setTimeout(() => {
			this.map.delete(id);
			// ★ 先通知「已放弃」再 reject（2026-09-11）：直跑据此让画布停止执行，
			//   消除「聊天报失败、画布仍在跑并在稍后出图」的僵尸 ✗。
			pending.onAbandon?.(id);
			pending.reject(pending.onTimeout(remainingCap <= pending.timeoutMs ? 'cap' : 'idle'));
		}, wait);
	}

	/** 回程结果：返回 false = 未知 id（已超时/已解决）。 */
	resolve(id: string, ok: boolean, value?: unknown, error?: string): boolean {
		const pending = this.map.get(id);
		if (!pending) { return false; }
		this.map.delete(id);
		if (pending.timer) { clearTimeout(pending.timer); }
		if (ok) {
			pending.resolve(value);
		} else {
			pending.reject(new Error(error ?? 'pending request failed'));
		}
		return true;
	}

	/** 进度回程：返回 false = 未知 id。`media` = 本次新产出的格子（增量，可缺省）。 */
	progress(id: string, progress: number, message?: string, media?: IStageRunMedia): boolean {
		const pending = this.map.get(id);
		if (!pending) { return false; }
		pending.onProgress?.(progress, message, media);
		// ★★ 续期（2026-09-11 修「长任务被固定墙钟误杀」）：有进度即证明 stage 仍活着。
		//   此前是**固定墙钟** —— AnimatedEmoji（9 格逐格生成 + 抠像 + 拼 GIF）这类长任务
		//   即使一直在正常上报进度，12 分钟一到就被判死（用户实测报障：`stage 执行超时
		//   （720s）：Saros.AnimatedEmoji`），而它当时仍在正常推进 ✗。
		this._renew(id, pending);
		return true;
	}

	/**
	 * **心跳**回程（2026-09-11）：只续期、不触碰 UI。
	 *
	 * 为什么需要它：`progress` 兼作活性信号有个隐患 —— **某个 stage 合法地长时间不上报
	 * 进度**（如一次很长的 ComfyUI 采样没有子进度回调）时会被空闲超时误杀 ✗。
	 * 心跳把「活性」与「进度」解耦：只要画布还在跑就持续续期，超时只反映**真的没消息**。
	 */
	heartbeat(id: string): boolean {
		const pending = this.map.get(id);
		if (!pending) { return false; }
		this._renew(id, pending);
		return true;
	}

	/**
	 * ★ 查询 pending 归属的 executionId（P0 修复，2026-09-13）。
	 *
	 * 用途：脚本内 `stage()` 的**进度回程**只回调了工具卡，script 节点卡没有进度条
	 * （质量评估实测缺口）。要把它归到「发起该 stage 的 script 节点」上，必须先知道
	 * 这条进度属于哪次工作流执行 —— 归属信息本就存在（`register` 的 extras.executionId，
	 * 供 `abandonByExecution` 用），这里只是把它暴露出来。
	 */
	executionIdOf(id: string): string | undefined {
		return this.map.get(id)?.executionId;
	}

	/**
	 * 重排超时定时器（节流：间隔 = 空闲额度 / REARM_FRACTION）。
	 * 节流间隔必须**与窗口成比例** —— 固定值（如 1s）在窗口很小时等于「永不续期」✗。
	 */
	private _renew(id: string, pending: PendingQuery): void {
		const rearmAfter = Math.max(1, Math.floor(pending.timeoutMs / PendingRegistry.REARM_FRACTION));
		if (pending.timer && Date.now() - pending.armedAt >= rearmAfter) {
			clearTimeout(pending.timer);
			pending.timer = undefined;
			this._arm(id, pending);
		}
	}
}

const pendingQueries = new PendingRegistry();
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * nodeOutput(stageUid, slot?) 的生产实现：向画布 webview 查询节点输出。
 * webview 不在/超时 → reject（引擎转 node-output-error，worker 侧 fatal fail-loud）。
 */
export function requestSnapshotOutput(query: IWorkflowNodeOutputQuery, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
	const queryId = `wfq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	return new Promise<unknown>((resolve, reject) => {
		pendingQueries.register(
			queryId, resolve, reject, timeoutMs,
			() => new Error(`nodeOutput: 画布未在 ${timeoutMs}ms 内响应（请确认已打开工作流画布且节点 uid="${query.stageUid}" 已运行）`),
		);
		snapshotQueryEmitter.fire({ queryId, stageUid: query.stageUid, ...(query.slot !== undefined ? { slot: query.slot } : {}) });
	});
}

/** controller 收到 webview 回程时调用。返回 false = 未知 queryId（已超时/已解决）。 */
export function resolveSnapshotOutput(payload: SnapshotResultPayload): boolean {
	return pendingQueries.resolve(payload.queryId, payload.ok, payload.value, payload.error);
}

/** run 结果归档到画布锚点节点（fire-and-forget；webview 不在时静默跳过——归档是增益不是前置）。 */
export function archiveWorkflowResult(anchorUid: string, value: unknown, meta: { name: string; runId: string }): void {
	snapshotArchiveEmitter.fire({ anchorUid, value, meta });
}

/**
 * 媒体快照写入请求（host → webview，2026-09-11）。
 *
 * 为什么需要：**不执行节点的交互型节点**（`apply:'snapshot'`，如 ImagePicker）此前把
 * 选中结果**只写进 host 侧 executionState**，而下游执行器（如 Saros.AnimatedEmoji
 * 逐格图生视频）是按 `store.byNode(上游节点 id)` / `latestRoundOf` 从 **webview 快照库**
 * 取上游参考图的 → 永远取不到 → 报「动态表情包制作需要上游参考图输入」。
 *
 * 本事件把选中媒体落进快照库，使「选择型节点」的输出对下游**与普通节点完全同构**。
 */
export interface SnapshotMediaPutRequest {
	/** 落库锚点（发起节点 id）—— 下游按 `store.byNode(该 id)` 取用。 */
	anchorUid: string;
	/** 端口名（用发起节点自身的输出口名，如 picker 的 'image'）。 */
	port: string;
	/**
	 * 媒体类型。★ `'text'`（2026-09-13 P1-2 产物部分）：Agent / Task 节点的**文本输出**
	 * 也能落进画布快照库 → 画布卡 OUTPUT 区可见（此前 host 驱动路径下画布完全没有产物，
	 * 而画布本地执行同节点时是有的 —— 同一个节点两处表现不一致 ✗）。
	 * webview 侧 `handleSnapshotMediaPutEvent` 不做 kind 校验、直接透传 ✓。
	 */
	kind: 'image' | 'video' | 'audio' | 'text';
	ref: string;
	/** 原样保留上游条目的 meta（图集标记等语义随之透传）。 */
	meta?: Record<string, unknown>;
}

export const snapshotMediaPutEmitter = new Emitter<SnapshotMediaPutRequest>();

/** 把媒体引用写入 webview 快照库（webview 不在时静默丢弃，属增益非前置）。 */
export function putWorkflowSnapshotMedia(req: SnapshotMediaPutRequest): void {
	snapshotMediaPutEmitter.fire(req);
}

/** M4b：运行投影落盘为投影工作流（fire-and-forget；失败由 controller 记日志）。 */
export function archiveWorkflowProjection(meta: { name: string; runId: string }, projection: unknown): void {
	projectionArchiveEmitter.fire({ meta, projection });
}

/** 引擎 deps 用的 IWorkflowSnapshotPort 生产实现。 */
export function createBridgeSnapshotPort(): IWorkflowSnapshotPort {
	return { get: query => requestSnapshotOutput(query) };
}

// ─── P0 stage() 桥（写方向：真正触发画布媒体节点执行）─────────────────────

const pendingStageRuns = new PendingRegistry();
/**
 * ★ v39 超时分级（2026-09-09）：旧值 600s 的最大问题是「画布未打开 / webview
 * 未加载时事件静默丢失 → 调用方卡满 10 分钟才拿到失败」。收敛为 90s：
 * 足够覆盖 webview 冷启动 + 执行初始化 + 媒体生成（快照查询类通常 <5s），
 * 同时让 agentDriver 的聊天进度不至于卡 10 分钟。真正的大批量采样仍由
 * native 侧 run/idle 超时（300s/120s）兜底。
 */
const DEFAULT_STAGE_TIMEOUT_MS = 90_000;

/**
 * stage(stageUid, overrides?) 的生产实现：让画布 webview 真正执行该媒体节点。
 * webview 不在/超时/执行失败 → reject（引擎转 stage-run-error，worker 侧 fatal）。
 */
export function requestStageRun(request: IWorkflowStageRunRequest, timeoutMs: number = DEFAULT_STAGE_TIMEOUT_MS, onProgress?: (progress: number, message?: string) => void, extras?: { executionId?: string }): Promise<unknown> {
	const runId = `wfs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	return new Promise<unknown>((resolve, reject) => {
		pendingStageRuns.register(
			runId, resolve, reject, timeoutMs,
			(reason) => new Error(reason === 'cap'
				? `stage(): 节点执行超过总时长上限（${Math.round(timeoutMs / 1000)}s × ${PendingRegistry.HARD_CAP_FACTOR}，期间一直在上报进度；uid="${request.stageUid}"）`
				: `stage(): 画布 ${Math.round(timeoutMs / 1000)}s 内无任何进度（uid="${request.stageUid}"；请确认画布未卡住且 ComfyUI 可达）`),
			onProgress,
			{
				// ★ 放弃时通知画布停止执行（2026-09-11，与直跑同构）：消除僵尸运行。
				onAbandon: (id) => stageRunCancelEmitter.fire({ runId: id }),
				...(extras?.executionId !== undefined ? { executionId: extras.executionId } : {}),
				// ★ 不限总时长（2026-09-11，与直跑同构）：只保留「空闲 + 心跳」活性检测；
				//   僵尸由取消链路（cancelExecution → abandonStageRunsForExecution）兜底。
				hardCapMs: Number.POSITIVE_INFINITY,
			},
		);
		stageRunEmitter.fire({
			runId,
			stageUid: request.stageUid,
			...(request.overrides !== undefined ? { overrides: request.overrides } : {}),
		});
	});
}

/** controller 收到 webview 回程时调用。返回 false = 未知 runId（已超时/已解决）。 */
export function resolveStageRun(payload: StageRunResultPayload): boolean {
	return pendingStageRuns.resolve(payload.runId, payload.ok, payload.value, payload.error);
}

/** controller 收到 webview 进度回程时调用。返回 false = 未知 runId。 */
export function onStageRunProgress(payload: StageRunProgressPayload): boolean {
	return pendingStageRuns.progress(payload.runId, payload.progress, payload.message);
}

/**
 * ★ 查询 `stage()` runId 归属的 workflow executionId（P0 修复，2026-09-13）。
 *
 * 用途：脚本内 `stage()` 的进度此前只喂工具卡，script 节点卡没有进度条。
 * controller 收到 `workflow.stageRunProgress` 时用它反查执行归属，
 * 再转交 `workflowExecutionService.reportScriptStageProgress` 归到节点卡。
 */
export function executionIdOfStageRun(runId: string): string | undefined {
	return runId ? pendingStageRuns.executionIdOf(runId) : undefined;
}

/** 媒体快照条目（与 `subagent_end.snapshot` / `IWorkflowNodeExecutionState.snapshot` 同构）。 */
export interface IStageRunSnapshotMedia {
	readonly port: string;
	readonly kind: 'image' | 'video' | 'audio' | 'text' | 'unknown';
	readonly ref: string;
	readonly meta?: Record<string, unknown>;
}

/**
 * ★ 从 `stage()` 回程的 `value` 里**安全**提取媒体快照数组（P1-1 修复，2026-09-13）。
 *
 * 背景：脚本内 `stage()` 的产物落在画布 webview 的快照库里，而 host 侧
 * `_executeScriptNode` 只写 `output`（文本）→ `subagent_end` 不带 snapshot →
 * **脚本节点在聊天卡上永远没有缩略图**（画布上却能看到）。
 *
 * `value` 是画布 runner 的返回值（`StageRunResultPayload.value: unknown`，
 * 结构类型且可能为任意值）→ 全程防御式读取，非法条目静默跳过（属增益非前置）。
 */
export function extractStageSnapshot(value: unknown): IStageRunSnapshotMedia[] {
	const arr = (value as { snapshot?: unknown } | null | undefined)?.snapshot;
	if (!Array.isArray(arr)) { return []; }
	const out: IStageRunSnapshotMedia[] = [];
	for (const item of arr) {
		const e = item as { port?: unknown; kind?: unknown; ref?: unknown; meta?: unknown } | null | undefined;
		if (!e || typeof e.ref !== 'string' || !e.ref) { continue; }
		out.push({
			port: typeof e.port === 'string' && e.port ? e.port : 'output',
			kind: (typeof e.kind === 'string' ? e.kind : 'unknown') as IStageRunSnapshotMedia['kind'],
			ref: e.ref,
			...(e.meta && typeof e.meta === 'object' ? { meta: e.meta as Record<string, unknown> } : {}),
		});
	}
	return out;
}

/**
 * `stage()` 心跳回程（2026-09-11，与直跑同构）：只续期、不触碰 UI。
 * 解耦「活性」与「进度」—— 脚本 `await stage()` 期间画布合法长时间无进度也不误杀。
 */
export function onStageRunHeartbeat(payload: { runId?: string }): boolean {
	if (!payload?.runId) { return false; }
	return pendingStageRuns.heartbeat(payload.runId);
}

/** 放弃单个 `stage()` 执行（画布面板 dispose 时用）。 */
export function abandonStageRun(runId: string, reason = '画布已关闭：stage() 已中止'): boolean {
	return pendingStageRuns.abandon(runId, new WorkflowError('NoCanvas', reason));
}

/**
 * 工作流执行被取消时调用（2026-09-11，与 `abandonDirectStageRunsForExecution` 同构）：
 * 放弃该执行名下所有 `stage()` pending —— 通知画布停止 + reject 让脚本立即收尾。
 *
 * @returns 实际放弃数量
 */
export function abandonStageRunsForExecution(executionId: string): number {
	return pendingStageRuns.abandonByExecution(
		executionId,
		new WorkflowError('Cancelled', '工作流已取消：stage() 已中止'),
	);
}

/** 引擎 deps 用的 IWorkflowStagePort 生产实现。 */
export function createBridgeStagePort(onProgress?: (progress: number, message?: string) => void, opts?: { executionId?: string }): IWorkflowStagePort {
	return {
		run: (request, progress) => requestStageRun(
			request, DEFAULT_STAGE_TIMEOUT_MS, progress ?? onProgress,
			opts?.executionId !== undefined ? { executionId: opts.executionId } : undefined,
		),
	};
}

// ─── Direct stage run 桥（存储工作流 ComfyStage → 画布，按 stageClass + values 直跑）───
//
// 与上面 stage() 桥（按 stageUid 定位画布节点）互补：存储工作流 DAG 的 ComfyStage 节点
// 没有画布 stageUid，只有 `data.comfy.stageClass`（如 `ComfyTV.EmojiStage`）。本桥把
// 「stageClass + 已解析 values + 参考图」发给画布 webview，由 webview 直接调
// runNodeOrStage 跑对应 stage（不经 stageUid 反查），解决「聊天触发存储工作流时
// 表情包节点被跳过」的缺口。

/** 直接 stage 执行请求（调用方入参）。 */
export interface DirectStageRunRequest {
	readonly stageClass: string;
	readonly values: Record<string, unknown>;
	/** 参考图引用（data URL / http / 纯文件名），webview 注入 upstream_image。 */
	readonly images?: string[];
	/** 原工作流节点 id（webview 侧作 snapKey 查快照库，命中节点上配置的默认素材）。 */
	readonly nodeId?: string;
	/**
	 * 发起执行的存储工作流 id（可选，2026-09-09 headless 轻量版）：
	 * 无画布挂起 → 自动开画布时按它打开**正确**的工作流（而非「最近一个」）。
	 */
	readonly workflowId?: string;
	/**
	 * 上游节点 id 列表（2026-09-11）：webview 侧经快照库按 id 取上游快照，
	 * 供「需要上游参考图」的 stage（Saros.AnimatedEmoji 逐格图生视频）消费。
	 */
	readonly upstreams?: string[];
	/** 工作流 session（2026-09-11）：webview 侧据此隔离快照库。 */
	readonly workflowSessionId?: string;
	/**
	 * 归属的 workflow executionId（2026-09-11）：用户取消该执行时，其名下直跑立即收尾
	 * （通知画布停止 + reject），不必再等空闲超时。
	 */
	readonly executionId?: string;
}

/** controller 转发给 webview 的事件载荷（workflow.stageDirectRun）。 */
export interface DirectStageRunPayload {
	readonly runId: string;
	readonly stageClass: string;
	/** 原工作流节点 id（webview 作 snapKey 查快照库，命中节点默认素材）。 */
	readonly nodeId?: string;
	/** 发起执行的存储工作流 id（可选；headless 自动开画布时定位正确工作流）。 */
	readonly workflowId?: string;
	readonly values: Record<string, unknown>;
	readonly images?: string[];
	/** 上游节点 id 列表（2026-09-11）：webview 侧按 id 取上游快照作参考图。 */
	readonly upstreams?: string[];
	/** 工作流 session（2026-09-11）：webview 侧据此隔离快照库。 */
	readonly workflowSessionId?: string;
}

const pendingDirectStageRuns = new PendingRegistry();

/** 工具层 → controller：请把「直接 stage 执行」转发给画布 webview。 */
export const directStageRunEmitter = new Emitter<DirectStageRunPayload>();

/**
 * controller → 画布 webview：请**停止**某次直跑（2026-09-11）。
 *
 * 触发点：`PendingRegistry` 判定该请求已被放弃（空闲超时 / 触达绝对上限）。
 * 目的：消除「聊天已报失败、画布仍在跑、稍后还可能出图」的**僵尸** ✗ ——
 * 此前 host 判死后无从通知画布，ComfyUI 白跑且用户看到「失败却仍出图」的矛盾状态。
 */
export const directStageRunCancelEmitter = new Emitter<{ runId: string }>();

// ── 无画布判定 + 重放（headless 轻量版地基，2026-09-09）────────────────────
// Emitter.fire 是**同步**分发：fire 前 flag 复位，controller listener 内 markHandled()；
// fire 返回后 flag 仍为 false ⇒ 当前**没有任何画布 controller 在听**（fire 静默丢失，
// pending 将干等 90s 超时）。此时把请求存入 unhandled 队列并 fire unhandled 事件——
// 由「自动打开画布」层消费；新 controller 就绪时 notifyDirectStageRunControllerReady()
// 会重放队列（controller 侧订阅即调）。pending 不 reject：90s 兜底仍在（用户拒绝打开
// 画布时自然超时报「请确认已打开工作流画布」）。
let _dsrHandled = false;
const unhandledDirectStageRuns = new Map<string, DirectStageRunPayload>();

/** controller listener 收到 directStageRun fire 时同步调用（ack）。 */
export function markDirectStageRunHandled(): void {
	_dsrHandled = true;
}

/** controller 建立订阅（即就绪）时调用：重放所有因无画布而挂起的请求。返回重放数。 */
export function notifyDirectStageRunControllerReady(): number {
	if (unhandledDirectStageRuns.size === 0) { return 0; }
	const list = [...unhandledDirectStageRuns.values()];
	unhandledDirectStageRuns.clear();
	for (const p of list) { directStageRunEmitter.fire(p); }
	return list.length;
}

/** 工具层/上层 UI：当前请求因无画布 controller 而未被接手（可据此自动打开画布）。 */
export interface DirectStageRunUnhandledEvent {
	readonly runId: string;
	readonly request: DirectStageRunPayload;
}
export const directStageRunUnhandledEmitter = new Emitter<DirectStageRunUnhandledEvent>();

// ★ 「自动开画布」全局互斥（2026-09-10）：unhandled 的消费者可能有多个宿主
//   （workflowExecutionService 常驻订阅 + AgentStudioWebviewController 订阅），
//   不互斥会双开画布。先 tryMark 成功者执行开画布，完成后 release。
let _openingCanvas = false;
export function tryMarkOpeningCanvas(): boolean {
	if (_openingCanvas) { return false; }
	_openingCanvas = true;
	return true;
}
export function releaseOpeningCanvas(): void {
	_openingCanvas = false;
}

/**
 * 按 stageClass + values 直接执行画布媒体节点（EmojiStage / TTSStage / …）。
 * 复用泛型 PendingRegistry（v40 收敛，超时 90s）；进度经 onProgress 透传。
 */
export function requestDirectStageRun(
	request: DirectStageRunRequest,
	timeoutMs: number = DEFAULT_STAGE_TIMEOUT_MS,
	onProgress?: (progress: number, message?: string, media?: IStageRunMedia) => void,
): Promise<unknown> {
	const runId = `wfsd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	return new Promise<unknown>((resolve, reject) => {
		pendingDirectStageRuns.register(
			runId, resolve, reject, timeoutMs,
			(reason) => new WorkflowError('Timeout', reason === 'cap'
				? `stage 执行超过总时长上限（${Math.round(timeoutMs / 1000)}s × ${PendingRegistry.HARD_CAP_FACTOR}，期间一直在上报进度）：${request.stageClass}`
				: `stage 空闲超时（${Math.round(timeoutMs / 1000)}s 内无任何进度）：${request.stageClass}；画布与 ComfyUI 可能已卡住（若画布仍显示「生成中」请查看 ComfyUI 队列）`),
			onProgress,
			{
				// ★ 放弃时通知画布停止执行（2026-09-11）：消除僵尸运行。
				onAbandon: (id) => directStageRunCancelEmitter.fire({ runId: id }),
				...(request.executionId !== undefined ? { executionId: request.executionId } : {}),
				// ★★ **不限总时长**（2026-09-11 用户要求）：直跑只受「空闲」约束 ——
				//   只要还在上报进度就永不判死（长任务如 9 格 AnimatedEmoji 可跑任意久）。
				//   伪进度僵尸由取消链路兜底：用户取消 → cancelExecution → abandonByExecution
				//   → 通知画布停止 + reject 收尾（见 abandonDirectStageRunsForExecution）。
				hardCapMs: Number.POSITIVE_INFINITY,
			},
		);
		const payload: DirectStageRunPayload = {
			runId,
			stageClass: request.stageClass,
			values: request.values,
			...(request.images !== undefined ? { images: request.images } : {}),
			...(request.nodeId !== undefined ? { nodeId: request.nodeId } : {}),
			...(request.workflowId !== undefined ? { workflowId: request.workflowId } : {}),
			...(request.upstreams !== undefined ? { upstreams: request.upstreams } : {}),
			...(request.workflowSessionId !== undefined ? { workflowSessionId: request.workflowSessionId } : {}),
		};
		_dsrHandled = false;
		directStageRunEmitter.fire(payload);
		if (!_dsrHandled) {
			// ★ 无画布 controller 接手（同步 ack 判定）：入 unhandled 队列等待自动开画布后重放。
			unhandledDirectStageRuns.set(runId, payload);
			directStageRunUnhandledEmitter.fire({ runId, request: payload });
		}
	});
}

/** controller 收到 webview 回程时调用。返回 false = 未知 runId（已超时/已解决）。 */
export function resolveDirectStageRun(payload: StageRunResultPayload): boolean {
	return pendingDirectStageRuns.resolve(payload.runId, payload.ok, payload.value, payload.error);
}

/**
 * webview 心跳回程（2026-09-11）：画布在跑直跑期间定时上报「我还活着」。
 * 只续期、不触碰 UI —— 把「活性」与「进度」解耦，避免「合法长时间无进度」被误杀。
 */
export function onDirectStageRunHeartbeat(payload: { runId?: string }): boolean {
	if (!payload?.runId) { return false; }
	return pendingDirectStageRuns.heartbeat(payload.runId);
}

/**
 * 放弃单个直跑（2026-09-11）：画布面板 `dispose()` 时调用 —— 面板没了就没人回程，
 * 立即收尾比等空闲超时更准确（也顺带通知画布停止，虽然它已消失）。
 */
export function abandonDirectStageRun(runId: string, reason = '画布已关闭：直跑已中止'): boolean {
	return pendingDirectStageRuns.abandon(runId, new WorkflowError('NoCanvas', reason));
}

/**
 * 工作流执行被取消时调用（2026-09-11）：放弃该执行名下的所有直跑 pending ——
 * ① 通知画布**停止执行**（消除僵尸：此前取消工作流后画布仍在跑、稍后还会出图 ✗）；
 * ② reject 让等待中的节点 delegate 立即收尾（此前只能等空闲超时才能解开 ✗）。
 *
 * 语义安全：取消路径下节点 delegate 抛错会被标 `Cancelled` 而非 Failed（不发红叉），
 * 见 workflowExecutionService 的 catch 分支 ✓。
 *
 * @returns 实际放弃的直跑数量（0 = 该执行没有在跑的直跑，正常情况）
 */
export function abandonDirectStageRunsForExecution(executionId: string): number {
	return pendingDirectStageRuns.abandonByExecution(
		executionId,
		new WorkflowError('Cancelled', '工作流已取消：画布直跑已中止'),
	);
}

/** controller 收到 webview 进度回程时调用。返回 false = 未知 runId。 */
export function onDirectStageRunProgress(payload: StageRunProgressPayload): boolean {
	return pendingDirectStageRuns.progress(payload.runId, payload.progress, payload.message, payload.media);
}
