/*---------------------------------------------------------------------------------------------
 *  Dynamic Workflow — host-side engine
 *
 *  移植自 dsh `workflow-worker-thread/host.ts`（WorkerRun），适配本项目的
 *  blob Web Worker 与 renderer 侧子代理生态：
 *   - spawn：createBlobWorker(WORKER_SOURCE)（注入可替换 —— 测试传 MockWorker）
 *   - child 桥：IWorkflowChildPort（依赖注入；生产 = dispatch 桥，测试 = Fake）
 *   - 账本：liveAgents 保证每个 agent-start 恰好一个 agent-end（死亡路径合成 cancelled）
 *   - cancel：worker hooks 在下一个边界抛 CANCELLED + children 中断 + grace 强收 + terminate
 *   - quiescence：dispose 等 pending starts + children 收敛（上限 grace），幂等
 *   - result 永不 reject；死亡（onerror）是逻辑投递屏障
 *
 *  设计文档：doc/Dynamic-Workflow-Integration-Design.md §3.2.4。
 *--------------------------------------------------------------------------------------------*/

import { createBlobWorker } from '../shared/workerPoolManager.js';
import { WORKER_SOURCE } from './workflowWorkerMain.source.js';
import {
	HostToWorkerType, WorkerToHostType,
	type IWorkflowChildResult, type IWorkflowChildStartRequest,
	type HostToWorkerMessage, type IWorkflowNodeOutputQuery, type IWorkflowStageRunRequest, type IWorkflowWorkerInit, type WorkerToHostMessage,
} from '../../common/workflow/protocol.js';
import {
	DEFAULT_WORKFLOW_LIMITS, WorkflowError,
	type IWorkflowAgentEndInfo, type IWorkflowAgentInfo, type IWorkflowLimits, type IWorkflowMeta,
	type IWorkflowResult, type IWorkflowRunHandle, type WorkflowEngineEvent,
} from '../../common/workflow/types.js';

/** host 侧对一个已启动子代理的句柄（桥实现；dispatch 或 Fake）。 */
export interface IWorkflowChildHandle {
	readonly id: string;
	/** resolve = 子代理终态（success=false → 脚本见 null）；reject 仅基建故障。 */
	readonly result: Promise<IWorkflowChildResult>;
	dispose(): Promise<void>;
}

/** child 桥接口：引擎经此启动子代理（cancel signal 共享给所有 child）。 */
export interface IWorkflowChildPort {
	start(request: IWorkflowChildStartRequest, signal: AbortSignal): Promise<IWorkflowChildHandle>;
}

/**
 * 快照查询桥（M2 画布数据桥，读方向）。nodeOutput(stageUid,slot) 经此物化：
 * SAROS_JSON → json 原值 / TEXT → string / IMAGE·VIDEO → {kind:'media',url,mime}。
 * 查无 uid / slot 越界 → reject（引擎转 node-output-error，worker 侧 fatal fail-loud）。
 */
export interface IWorkflowSnapshotPort {
	get(query: IWorkflowNodeOutputQuery): Promise<unknown>;
}

/** 缺省实现：无画布上下文时 nodeOutput 一律 fail-loud（禁用而非静默）。 */
export function createUnavailableSnapshotPort(reason: string): IWorkflowSnapshotPort {
	return {
		async get() { throw new Error(`nodeOutput unavailable: ${reason}`); },
	};
}

/**
 * 画布节点执行桥（P0 画布桥，**写方向**）。stage(stageUid, overrides) 经此
 * 真正触发画布媒体节点执行（复用 webview 的 runSingleSchemaNode → runNodeOrStage
 * → ComfyUI），执行完成后返回该节点的物化输出（与 nodeOutput 同构）。
 *
 * 这是打通「脚本域 ↔ 画布域」割裂的关键 —— 之前导出脚本里媒体节点只能是 null 占位，
 * 脚本无法驱动图像生成，只能读取画布上手动 Run 留下的旧快照。
 */
export interface IWorkflowStagePort {
	/**
	 * 执行画布媒体节点。
	 * `onProgress` 为可选进度回调（0-100 + 人类可读阶段），用于把 ComfyUI 生成
	 * 进度透传到 UI（否则脚本 `await stage()` 期间用户看到的是「卡住」）。
	 */
	run(request: IWorkflowStageRunRequest, onProgress?: (progress: number, message?: string) => void): Promise<unknown>;
}

/** 缺省实现：无画布上下文时 stage() 一律 fail-loud。 */
export function createUnavailableStagePort(reason: string): IWorkflowStagePort {
	return {
		async run() { throw new Error(`stage() unavailable: ${reason}`); },
	};
}

/** worker 抽象（生产=Web Worker 适配；测试=Mock）。 */
export interface IWorkflowWorkerLike {
	postMessage(message: unknown): void;
	terminate(): void;
	onmessage: (ev: { data: unknown }) => void;
	onerror: (err: unknown) => void;
}

/** 默认 worker 工厂：blob worker；CSP 拦截返回 null → 引擎同步抛（工具 fail-loud）。 */
export type WorkflowWorkerFactory = (source: string, init: unknown) => IWorkflowWorkerLike | null;

function defaultWorkerFactory(source: string, init: unknown): IWorkflowWorkerLike | null {
	const worker = createBlobWorker(source, { ...(init ? { } : { }) });
	if (!worker) { return null; }
	// workerData 等价：Web Worker 无 workerData，init 经首条 go 消息携带（见 ready→go 握手）。
	const adapter: IWorkflowWorkerLike = {
		postMessage: m => worker.postMessage(m),
		terminate: () => { void worker.terminate(); },
		onmessage: () => { },
		onerror: () => { },
	};
	// Worker 用 addEventListener；适配到属性句柄（引擎只挂一次）。
	let msgHandler: ((ev: MessageEvent) => void) | undefined;
	let errHandler: ((ev: ErrorEvent) => void) | undefined;
	Object.defineProperty(adapter, 'onmessage', {
		get: () => msgHandler, set: (h: ((ev: { data: unknown }) => void) | undefined) => {
			if (msgHandler) { worker.removeEventListener('message', msgHandler); }
			msgHandler = h ? (ev: MessageEvent) => h(ev) : undefined;
			if (msgHandler) { worker.addEventListener('message', msgHandler); }
		},
	});
	Object.defineProperty(adapter, 'onerror', {
		get: () => errHandler, set: (h: ((err: unknown) => void) | undefined) => {
			if (errHandler) { worker.removeEventListener('error', errHandler); }
			errHandler = h ? (ev: ErrorEvent) => h(ev) : undefined;
			if (errHandler) { worker.addEventListener('error', errHandler); }
		},
	});
	return adapter;
}

export interface IWorkflowEngineDeps {
	readonly childPort: IWorkflowChildPort;
	/** M2 快照查询桥（缺省 = 不可用 fail-loud port，nodeOutput 显式报错）。 */
	readonly snapshotPort?: IWorkflowSnapshotPort;
	/** P0 画布节点执行桥（缺省 = 不可用 fail-loud port，stage() 显式报错）。 */
	readonly stagePort?: IWorkflowStagePort;
	/** 每 run 的并发/总数/条目上限（缺省 DEFAULT_WORKFLOW_LIMITS）。 */
	readonly limits?: IWorkflowLimits;
	/** 取消后的强制收敛窗口。缺省 5000。 */
	readonly disposeGraceMs?: number;
	/**
	 * 单个 run 的墙钟上限（P4 活性防护）。缺省 {@link DEFAULT_MAX_RUN_DURATION_MS}；
	 * <=0 = 禁用（仅测试/特殊场景）。
	 *
	 * 为什么必须有：cancel 后的 grace 强收只在**有人 cancel** 时才 arm。若脚本自身
	 * 死挂（`while(true){}` / `await new Promise(()=>{})` / 忘记回程的自定义 hook），
	 * 没有任何一方会 cancel → worker 永不回 result → 前台 `await run.result` 永久
	 * 挂起（工具卡永远「执行中」、worker 线程泄漏）。到点自动 cancel → 走既有
	 * cancel→grace→terminate 路径，保证账本闭合与 worker 回收。
	 */
	readonly maxRunDurationMs?: number;
	/** worker 工厂（测试注入 Mock；缺省 blob worker）。 */
	readonly workerFactory?: WorkflowWorkerFactory;
}

/** 单 run 墙钟上限缺省值（30 分钟：容纳多批次 ComfyUI 采样，又不至于无限挂）。 */
export const DEFAULT_MAX_RUN_DURATION_MS = 1_800_000;

export interface IWorkflowStartContext {
	readonly script: string;
	readonly meta: IWorkflowMeta;
	readonly args?: unknown;
	/** 外部取消信号（turn abort；引擎桥接到 run.cancel）。 */
	readonly signal?: AbortSignal;
	/** 事件宿主监听器列表（run 生命周期内有效）。 */
	readonly onEvent?: (ev: WorkflowEngineEvent) => void;
}

/** host 侧一个 run 的全部状态与状态机（不对外；经 IWorkflowRunHandle 暴露）。 */
class WorkflowRun implements IWorkflowRunHandle {
	readonly id: string;
	readonly meta: IWorkflowMeta;
	readonly result: Promise<IWorkflowResult>;

	private _settled = false;
	private _terminalClaimed = false;
	private _workerDeathObserved = false;
	private _cancelReason: string | undefined;
	private _graceTimer: ReturnType<typeof setTimeout> | undefined;
	private _wallClockTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _worker: IWorkflowWorkerLike;
	private readonly _childPort: IWorkflowChildPort;
	private readonly _snapshotPort: IWorkflowSnapshotPort;
	private readonly _stagePort: IWorkflowStagePort;
	private readonly _limits: IWorkflowLimits;
	private readonly _disposeGraceMs: number;
	private readonly _emit: (ev: WorkflowEngineEvent) => void;
	private readonly _log: (level: 'info' | 'warn', msg: string) => void;
	private readonly _init: IWorkflowWorkerInit;
	private readonly _controller = new AbortController();
	private readonly _children = new Map<number, { run: IWorkflowChildHandle; disposal?: Promise<void> }>();
	private readonly _pendingStarts = new Set<Promise<void>>();
	private readonly _liveAgents = new Map<number, IWorkflowAgentInfo>();
	private readonly _quiescenceWaiters: (() => void)[] = [];
	private _hostStarted = 0;
	private _inputSignal: AbortSignal | undefined;
	private _inputAbort: (() => void) | undefined;
	private _disposed: Promise<void> | undefined;
	private _settleResolve: ((r: IWorkflowResult) => void) | undefined;

	constructor(
		id: string, meta: IWorkflowMeta, ctx: IWorkflowStartContext,
		deps: { childPort: IWorkflowChildPort; snapshotPort: IWorkflowSnapshotPort; stagePort: IWorkflowStagePort; limits: IWorkflowLimits; disposeGraceMs: number; maxRunDurationMs: number },
		log: (level: 'info' | 'warn', msg: string) => void,
		workerFactory: WorkflowWorkerFactory,
	) {
		this.id = id;
		this.meta = meta;
		this._childPort = deps.childPort;
		this._snapshotPort = deps.snapshotPort;
		this._stagePort = deps.stagePort;
		this._limits = deps.limits;
		this._disposeGraceMs = deps.disposeGraceMs;
		this._log = log;
		const listeners = ctx.onEvent ? [ctx.onEvent] : [];
		this._emit = ev => { for (const l of listeners) { try { l(ev); } catch { /* listener 隔离 */ } } };
		this.result = new Promise<IWorkflowResult>(resolve => { this._settleResolve = resolve; });

		this._init = { meta, body: ctx.script, ...(ctx.args !== undefined ? { args: ctx.args } : {}), limits: this._limits };

		const worker = workerFactory(WORKER_SOURCE, undefined);
		if (!worker) {
			throw new WorkflowError('workflow worker could not be created (blob worker blocked by CSP?)', 'AGENT_START');
		}
		this._worker = worker;
		this._worker.onmessage = ev => { this._onMessage(ev.data); };
		this._worker.onerror = (err: ErrorEvent | unknown) => {
			// worker 的 onerror 收到的是 ErrorEvent（DOM 事件对象，非 Error），
			// 其 .message 才是 worker 内未捕获异常的真实信息。
			// 之前 String(err) 对 ErrorEvent 只会得到 "[object ErrorEvent]"，掩盖了根因。
			let msg: string;
			if (err instanceof Error) {
				msg = err.message;
			} else if (err && typeof err === 'object' && 'message' in err) {
				const raw = (err as ErrorEvent).message;
				msg = typeof raw === 'string' ? raw : JSON.stringify(raw);
				const fn = (err as ErrorEvent).filename;
				const ln = (err as ErrorEvent).lineno;
				if (fn || ln !== undefined) { msg += ` (at ${fn ?? '<unknown>'}:${ln ?? '?'})`; }
			} else {
				msg = String(err);
			}
			this._onWorkerDeath(`workflow worker failed: ${msg}`);
		};

		if (ctx.signal?.aborted) {
			this._armCancel('workflow start signal already aborted');
		} else if (ctx.signal) {
			const onAbort = () => { this._detachInputSignal(); this.cancel('parent turn aborted'); };
			this._inputSignal = ctx.signal;
			this._inputAbort = onAbort;
			ctx.signal.addEventListener('abort', onAbort, { once: true });
		}
		// P4 活性防护：墙钟上限到点自动 cancel（脚本死挂时唯一的收敛保证）。
		if (deps.maxRunDurationMs > 0) {
			this._wallClockTimer = setTimeout(() => {
				this._wallClockTimer = undefined;
				this._log('warn', `[WorkflowEngine] run ${this.id} exceeded max duration ${deps.maxRunDurationMs}ms — cancelling`);
				this.cancel(`workflow exceeded max duration (${Math.round(deps.maxRunDurationMs / 1000)}s)`);
			}, deps.maxRunDurationMs);
			this._unref(this._wallClockTimer);
		}
		this._emit({ type: 'start', id, meta });
	}

	// ── 对外 API ──────────────────────────────────────────────────

	cancel(reason?: string): void {
		if (this._settled || this._terminalClaimed || this._cancelReason !== undefined) { return; }
		this._armCancel(reason ?? 'workflow cancelled');
	}

	dispose(): Promise<void> {
		if (this._disposed !== undefined) { return this._disposed; }
		const claimed = new Promise<void>(resolve => { this._disposed_resolve = resolve; });
		this._disposed = claimed;
		void (async () => {
			this._detachInputSignal();
			this.cancel('workflow disposed');
			this._reapChildren();
			await Promise.race([
				(async () => { await this.result; await this._childQuiescence(); })(),
				this._sleep(this._disposeGraceMs),
			]);
			this._worker.terminate();
			this._reapChildren();
		})().then(() => this._disposed_resolve?.(), () => this._disposed_resolve?.());
		return this._disposed;
	}
	private _disposed_resolve?: () => void;

	// ── worker 消息循环 ────────────────────────────────────────────

	private _post(m: HostToWorkerMessage): void {
		if (this._workerDeathObserved) { return; }
		try { this._worker.postMessage(m); } catch (e) { this._log('warn', `[WorkflowEngine] postMessage failed: ${String(e)}`); }
	}

	private _onMessage(raw: unknown): void {
		if (this._workerDeathObserved) { return; }
		const m = raw as WorkerToHostMessage;
		if (!m || typeof m.type !== 'string') { return; }
		switch (m.type) {
			case WorkerToHostType.Ready:
				this._post({ type: HostToWorkerType.Go, init: this._init });
				break;
			case WorkerToHostType.Phase:
				if (this._cancelReason === undefined) { this._emit({ type: 'phase', id: this.id, title: m.title }); }
				break;
			case WorkerToHostType.Log:
				if (this._cancelReason === undefined) { this._emit({ type: 'log', id: this.id, message: m.message }); }
				break;
			case WorkerToHostType.AgentStart:
				this._liveAgents.set(m.info.seq, m.info);
				this._emit({ type: 'agent-start', id: this.id, info: m.info });
				break;
			case WorkerToHostType.AgentEnd:
				this._endAgent({ ...m.info });
				break;
			case WorkerToHostType.ChildStart:
				this._onChildStart(m.callId, m.request);
				break;
			case WorkerToHostType.ChildDispose:
				this._onChildDispose(m.callId);
				break;
			case WorkerToHostType.NodeOutput:
				this._onNodeOutput(m.callId, m.query);
				break;
			case WorkerToHostType.StageRun:
				this._onStageRun(m.callId, m.request);
				break;
			case WorkerToHostType.Result:
				this._onResult(m.result);
				break;
			default:
				this._log('warn', `[WorkflowEngine] unknown worker message type: ${(m as { type: string }).type}`);
				break;
		}
	}

	// ── child RPC（host 侧执行）────────────────────────────────────

	private _admissionFailure(): { rendered: string } | undefined {
		if (this._cancelReason !== undefined) { return { rendered: `workflow run cancelled: ${this._cancelReason}` }; }
		if (this._workerDeathObserved) { return { rendered: 'workflow worker is no longer available' }; }
		if (this._terminalClaimed) { return { rendered: 'workflow run already settled' }; }
		return undefined;
	}

	private _onChildStart(callId: number, request: IWorkflowChildStartRequest): void {
		const refusal = this._admissionFailure();
		if (refusal) {
			this._post({ type: HostToWorkerType.ChildStartError, callId, rendered: refusal.rendered });
			return;
		}
		this._hostStarted += 1;
		const task = this._startChild(callId, request);
		this._pendingStarts.add(task);
		void task.then(() => this._finishPendingStart(task), () => this._finishPendingStart(task));
	}

	private async _startChild(callId: number, request: IWorkflowChildStartRequest): Promise<void> {
		let run: IWorkflowChildHandle;
		try {
			run = await this._childPort.start(request, this._controller.signal);
		} catch (e) {
			const refusal = this._admissionFailure();
			this._post({ type: HostToWorkerType.ChildStartError, callId, rendered: refusal?.rendered ?? renderThrown(e) });
			return;
		}
		const refusal = this._admissionFailure();
		if (refusal) {
			this._post({ type: HostToWorkerType.ChildStartError, callId, rendered: refusal.rendered });
			try { await run.dispose(); } catch (e) { this._log('warn', `[WorkflowEngine] refused child dispose failed: ${renderThrown(e)}`); }
			return;
		}
		this._children.set(callId, { run });
		const forwardResult = run.result.then(
			result => () => { this._post({ type: HostToWorkerType.ChildSettled, callId, result }); },
			err => () => { this._post({ type: HostToWorkerType.ChildFailed, callId, rendered: renderThrown(err) }); },
		);
		this._post({ type: HostToWorkerType.ChildStarted, callId, childId: run.id });
		void forwardResult.then(forward => { forward(); });
	}

	private _onChildDispose(callId: number): void {
		const record = this._children.get(callId);
		if (!record) {
			this._post({ type: HostToWorkerType.ChildDisposed, callId });
			return;
		}
		void this._disposeChild(callId, record).then(() => this._post({ type: HostToWorkerType.ChildDisposed, callId }));
	}

	private _disposeChild(callId: number, record: { run: IWorkflowChildHandle; disposal?: Promise<void> }): Promise<void> {
		if (record.disposal !== undefined) { return record.disposal; }
		record.disposal = Promise.resolve()
			.then(() => record.run.dispose())
			.catch(e => { this._log('warn', `[WorkflowEngine] child dispose failed: ${renderThrown(e)}`); })
			.then(() => { this._children.delete(callId); this._notifyQuiescence(); });
		return record.disposal;
	}

	private _finishPendingStart(task: Promise<void>): void {
		this._pendingStarts.delete(task);
		this._notifyQuiescence();
	}

	private _notifyQuiescence(): void {
		if (this._children.size !== 0 || this._pendingStarts.size !== 0) { return; }
		for (const w of this._quiescenceWaiters.splice(0)) { w(); }
	}

	private _childQuiescence(): Promise<void> {
		if (this._children.size === 0 && this._pendingStarts.size === 0) { return Promise.resolve(); }
		return new Promise(resolve => { this._quiescenceWaiters.push(resolve); });
	}

	private _reapChildren(): void {
		if (!this._controller.signal.aborted) { this._controller.abort(this._cancelReason ?? 'workflow disposed'); }
		for (const [callId, record] of [...this._children]) { void this._disposeChild(callId, record); }
	}

	// ── nodeOutput RPC（M2 画布桥，读方向）────────────────────────

	private _onNodeOutput(callId: number, query: IWorkflowNodeOutputQuery): Promise<void> {
		const refusal = this._admissionFailure();
		if (refusal) {
			this._post({ type: HostToWorkerType.NodeOutputError, callId, rendered: refusal.rendered });
			return Promise.resolve();
		}
		const task = this._snapshotPort.get(query).then(
			value => { this._post({ type: HostToWorkerType.NodeOutputResult, callId, result: { value } }); },
			err => { this._post({ type: HostToWorkerType.NodeOutputError, callId, rendered: renderThrown(err) }); },
		);
		task.catch(() => { /* 已转发 */ });
		return task;
	}

	// ── stage RPC（P0 画布桥，写方向：真正触发媒体节点执行）──────────

	private _onStageRun(callId: number, request: IWorkflowStageRunRequest): Promise<void> {
		const refusal = this._admissionFailure();
		if (refusal) {
			this._post({ type: HostToWorkerType.StageRunError, callId, rendered: refusal.rendered });
			return Promise.resolve();
		}
		// 进度透传：ComfyUI 生成进度 → 宿主（stage-progress 事件，UI 可据此刻画实时进度）。
		const onProgress = (progress: number, message?: string): void => {
			this._emit({
				type: 'stage-progress',
				id: this.id,
				stageUid: request.stageUid,
				progress,
				...(message !== undefined ? { message } : {}),
			});
		};
		const task = this._stagePort.run(request, onProgress).then(
			value => { this._post({ type: HostToWorkerType.StageRunResult, callId, result: { value } }); },
			err => { this._post({ type: HostToWorkerType.StageRunError, callId, rendered: renderThrown(err) }); },
		);
		task.catch(() => { /* 已转发 */ });
		return task;
	}

	// ── 终态裁决 ───────────────────────────────────────────────────

	private _onResult(result: IWorkflowResult): void {
		if (this._terminalClaimed) { return; }
		const cancellationWasRequested = this._cancelReason !== undefined;
		this._terminalClaimed = true;
		this._reapChildren();
		if (!cancellationWasRequested) {
			this._settle(result);
			return;
		}
		if (result.stopReason !== 'cancelled') {
			this._settle({ value: null, stopReason: 'cancelled', error: `workflow run cancelled: ${this._cancelReason}`, agentsStarted: result.agentsStarted });
			return;
		}
		this._settle(result);
	}

	private _onWorkerDeath(message: string): void {
		if (this._workerDeathObserved) { return; }
		this._workerDeathObserved = true;
		const outcomeWasClaimed = this._terminalClaimed;
		const cancellationWasRequested = this._cancelReason !== undefined;
		if (!outcomeWasClaimed) { this._terminalClaimed = true; }
		if (this._children.size > 0 || this._pendingStarts.size > 0) { this._reapChildren(); }
		this._endStrandedAgents();
		if (!outcomeWasClaimed) {
			if (cancellationWasRequested) {
				this._settle({ value: null, stopReason: 'cancelled', error: `workflow run cancelled: ${this._cancelReason}`, agentsStarted: this._hostStarted });
			} else {
				this._settle({ value: null, stopReason: 'error', error: message, agentsStarted: this._hostStarted });
			}
		}
	}

	private _endAgent(end: IWorkflowAgentEndInfo): void {
		if (!this._liveAgents.delete(end.seq)) { return; }
		this._emit({ type: 'agent-end', id: this.id, info: end });
	}

	private _endStrandedAgents(): void {
		for (const info of [...this._liveAgents.values()]) {
			this._endAgent({ ...info, outcome: 'cancelled' });
		}
	}

	private _armCancel(reason: string): void {
		this._cancelReason = reason;
		this._post({ type: HostToWorkerType.Cancel, reason });
		if (!this._controller.signal.aborted) { this._controller.abort(reason); }
		this._graceTimer = setTimeout(() => {
			this._terminalClaimed = true;
			this._endStrandedAgents();
			this._settle({ value: null, stopReason: 'cancelled', error: `workflow run cancelled: ${this._cancelReason}`, agentsStarted: this._hostStarted });
			this._worker.terminate();
		}, this._disposeGraceMs);
		this._unref(this._graceTimer);
	}

	private _settle(result: IWorkflowResult): void {
		if (this._settled) { return; }
		this._terminalClaimed = true;
		this._settled = true;
		this._detachInputSignal();
		if (this._graceTimer !== undefined) { clearTimeout(this._graceTimer); this._graceTimer = undefined; }
		if (this._wallClockTimer !== undefined) { clearTimeout(this._wallClockTimer); this._wallClockTimer = undefined; }
		this._settleResolve?.(result);
		this._emit({ type: 'end', id: this.id, stopReason: result.stopReason, ...(result.error !== undefined ? { error: result.error } : {}), agentsStarted: result.agentsStarted });
	}

	/** node 环境下让计时器不阻塞进程退出（浏览器无 unref，静默跳过）。 */
	private _unref(timer: ReturnType<typeof setTimeout>): void {
		if (typeof timer === 'object' && timer !== null && 'unref' in timer) { (timer as { unref(): void }).unref?.(); }
	}

	private _detachInputSignal(): void {
		if (!this._inputSignal || !this._inputAbort) { return; }
		this._inputSignal.removeEventListener('abort', this._inputAbort);
		this._inputSignal = undefined;
		this._inputAbort = undefined;
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise(resolve => {
			const t = setTimeout(resolve, ms);
			this._unref(t);
		});
	}
}

function renderThrown(e: unknown): string {
	try { return e instanceof Error ? e.message : String(e); } catch { return '[unrenderable thrown value]'; }
}

/**
 * 引擎（多 run 容器）。
 * 生命周期：每个 start() 一个 WorkflowRun；引擎不持有全局状态（caps 由调用方
 * 按配置传入）。事件经 start 的 onEvent 订阅（run 生命周期内有效）。
 */
export class WorkflowEngine {
	private _runSeq = 0;
	private readonly _deps: IWorkflowEngineDeps;
	private readonly _log: (level: 'info' | 'warn', msg: string) => void;

	constructor(deps: IWorkflowEngineDeps, log: (level: 'info' | 'warn', msg: string) => void) {
		this._deps = deps;
		this._log = log;
	}

	start(ctx: IWorkflowStartContext): IWorkflowRunHandle {
		const id = `wf-${Date.now().toString(36)}-${(++this._runSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		return new WorkflowRun(
			id, ctx.meta, ctx,
			{
				childPort: this._deps.childPort,
				snapshotPort: this._deps.snapshotPort ?? createUnavailableSnapshotPort('no canvas snapshot bridge in this context'),
				stagePort: this._deps.stagePort ?? createUnavailableStagePort('no canvas stage bridge in this context'),
				limits: this._deps.limits ?? DEFAULT_WORKFLOW_LIMITS,
				disposeGraceMs: this._deps.disposeGraceMs ?? 5000,
				maxRunDurationMs: this._deps.maxRunDurationMs ?? DEFAULT_MAX_RUN_DURATION_MS,
			},
			this._log,
			this._deps.workerFactory ?? defaultWorkerFactory,
		);
	}
}
