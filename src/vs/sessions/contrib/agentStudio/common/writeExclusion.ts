/*---------------------------------------------------------------------------------------------
 *  writeExclusion — 多 Agent 协同的「写冲突互斥」机制（P0②）。
 *
 *  背景（2026-09-11 设计评审）：
 *   子代理**共享父 worktree**（无 worktree 隔离档、无合并步骤），因此两个**可写**子代理
 *   并发执行 = 必然的写冲突（同一文件互相覆盖 / patch 锚点失效）。而并行扇出
 *   （delegate_task / plan_explore / 画布并行层 / swarm workers）恰恰是本项目的核心用法。
 *
 *  设计取舍：
 *   1. 互斥点放在**所有执行路径的公共咽喉** —— 子代理调度层（UnifiedSubAgentDispatch），
 *      而不是画布 planner：这样画布并行层、脚本 parallel()、swarm、delegate_task 一次性全覆盖。
 *   2. 只读子代理**完全不占锁**（Explore / Scout，以及工具面里没有写工具的 General）——
 *      并行探索这个主用法零回归。
 *   3. 锁在**执行开始前**获取、**终态后**释放：排队等待不计入子代理的 timeout/duration
 *      （排队不是它的执行时间），父级 abort 时排队立即退出。
 *
 *  「什么算写工具」复用 chatModeConfig 的 DESTRUCTIVE_TOOL_PATTERNS（单一真源）。
 *--------------------------------------------------------------------------------------------*/

import { DESTRUCTIVE_TOOL_PATTERNS } from './chatModeConfig.js';

// ─── 写能力判定 ────────────────────────────────────────────────────────────

/**
 * 该工具是否会产生副作用（写文件 / 删文件 / 执行命令）。
 * 复用 `DESTRUCTIVE_TOOL_PATTERNS`（与 ask 模式过滤同一份真源，避免两套名单漂移）。
 */
export function isWriteTool(toolName: string): boolean {
	return DESTRUCTIVE_TOOL_PATTERNS.some(p => p.test(toolName));
}

/** 写能力判定输入：显式工具面优先，其次权限档，最后类型兜底。 */
export interface IWriteCapabilityInput {
	/** 子代理工具白名单（通常来自内置 Agent 的 tools）。存在时以它为准。 */
	readonly allowedTools?: readonly string[];
	/** 已排除工具（含编排工具隐藏、explore 禁用写工具等）。 */
	readonly excludedTools?: readonly string[];
	/** 权限档 canWrite（SUB_AGENT_PERMISSIONS[type].canWrite）。 */
	readonly canWrite?: boolean;
	/** 权限档 canExecute（terminal 也能改文件，故执行权同样计入写能力）。 */
	readonly canExecute?: boolean;
	/** 子代理类型（explore/general/scout），用于权限档缺失时兜底。 */
	readonly type?: string;
}

/**
 * 判定一个子代理是否**可能写**（保守方向：宁可串行，不可写冲突）。
 *
 * 判定优先级：
 *   ① `allowedTools` 非空 → 看它的**有效工具面**里有没有写工具。
 *      ★ 这条不能省：`data` 内置 agent 以 Explore 档派发，但工具面含 `terminal`
 *      （见 `_EXPLORE_REAL_TOOLS` 注释）→ 类型说只读、实际能写。
 *   ② 权限档 `canWrite || canExecute`（General=true，Explore/Scout=false）。
 *   ③ 显式 `canWrite===false && canExecute===false` → 只读。
 *   ④ 类型名兜底：explore/scout → 只读；未知类型 → **按可写处理**（保守）。
 */
export function hasWriteCapability(input: IWriteCapabilityInput): boolean {
	const excluded = new Set((input.excludedTools ?? []).map(t => t.toLowerCase()));
	const allowed = (input.allowedTools ?? []).filter(t => !excluded.has(t.toLowerCase()));

	if (allowed.length > 0) {
		return allowed.some(isWriteTool);
	}
	if (input.canWrite === true || input.canExecute === true) {
		return true;
	}
	if (input.canWrite === false && input.canExecute === false) {
		return false;
	}
	const type = (input.type ?? '').toLowerCase();
	if (type === 'explore' || type === 'scout') {
		return false;
	}
	return true;
}

// ─── 写互斥锁 ──────────────────────────────────────────────────────────────

/** 排队等待期间被取消（父 turn abort / 会话重置）时抛出。 */
export class WriteLockAbortedError extends Error {
	readonly _tag = 'WriteLockAbortedError';
	constructor(message = 'write lock acquire aborted') {
		super(message);
		this.name = 'WriteLockAbortedError';
	}
}

export interface IWriteLockAcquireOptions {
	/** 持有者标识（子代理 id）。同 owner 重入不阻塞（防自死锁）。 */
	readonly owner?: string;
	/** 排队期间 abort → 立即退出队列并抛 WriteLockAbortedError。 */
	readonly signal?: AbortSignal;
	/** 排队回调（诊断：前面还有几个写者）。 */
	readonly onWait?: (ahead: number) => void;
}

export interface IWriteLockStats {
	/** 成功获得锁的次数。 */
	readonly acquired: number;
	/** 排队次数（未立即获得）。 */
	readonly waits: number;
	readonly totalWaitMs: number;
	readonly maxWaitMs: number;
	/** 当前排队人数。 */
	readonly waiting: number;
	readonly held: boolean;
	readonly holder?: string;
}

export interface IWriteExclusionLock {
	/** 获取写互斥；返回**幂等**的 release。排队期间 abort → 抛 WriteLockAbortedError。 */
	acquire(options?: IWriteLockAcquireOptions): Promise<() => void>;
	/** 获取 → 执行 → 必然释放（含抛错路径）。 */
	withLock<T>(fn: () => Promise<T>, options?: IWriteLockAcquireOptions): Promise<T>;
	stats(): IWriteLockStats;
	/** 清空排队（会话重置/测试）；排队者以 WriteLockAbortedError 结束。 */
	reset(): void;
}

interface _Waiter {
	readonly owner?: string;
	readonly resolve: (release: () => void) => void;
	readonly reject: (err: unknown) => void;
	readonly enqueuedAt: number;
	readonly signal?: AbortSignal;
	onAbort?: () => void;
}

/**
 * FIFO 写互斥锁（公平：按到达顺序授予，避免写者饿死）。
 * 纯内存、无 IO、无定时器 → 可单测。
 */
export function createWriteExclusionLock(): IWriteExclusionLock {
	let held = false;
	let holder: string | undefined;
	/** 同 owner 重入计数：>0 时内层 release 只减计数，不真正释放。 */
	let reentry = 0;
	const queue: _Waiter[] = [];
	const counters = { acquired: 0, waits: 0, totalWaitMs: 0, maxWaitMs: 0 };

	const grant = (owner?: string): (() => void) => {
		held = true;
		holder = owner;
		counters.acquired++;
		let done = false;
		return () => {
			if (done) { return; } // release 幂等
			done = true;
			held = false;
			holder = undefined;
			pump();
		};
	};

	const grantReentrant = (): (() => void) => {
		reentry++;
		let done = false;
		return () => {
			if (done) { return; }
			done = true;
			reentry--;
		};
	};

	const detach = (w: _Waiter): void => {
		if (w.signal && w.onAbort) {
			w.signal.removeEventListener('abort', w.onAbort);
		}
	};

	function pump(): void {
		while (!held && reentry === 0 && queue.length > 0) {
			const w = queue.shift()!;
			detach(w);
			if (w.signal?.aborted) {
				w.reject(new WriteLockAbortedError());
				continue;
			}
			const waited = Date.now() - w.enqueuedAt;
			counters.totalWaitMs += waited;
			counters.maxWaitMs = Math.max(counters.maxWaitMs, waited);
			w.resolve(grant(w.owner));
		}
	}

	return {
		acquire(options: IWriteLockAcquireOptions = {}): Promise<() => void> {
			const { owner, signal, onWait } = options;
			if (signal?.aborted) {
				return Promise.reject(new WriteLockAbortedError());
			}
			if (!held) {
				return Promise.resolve(grant(owner));
			}
			// 同 owner 重入：不阻塞（否则持有者自己再取锁 = 死锁）
			if (owner !== undefined && holder === owner) {
				return Promise.resolve(grantReentrant());
			}
			counters.waits++;
			return new Promise<() => void>((resolve, reject) => {
				const w: _Waiter = { owner, resolve, reject, enqueuedAt: Date.now(), signal };
				if (signal) {
					w.onAbort = () => {
						const i = queue.indexOf(w);
						if (i >= 0) {
							queue.splice(i, 1);
							reject(new WriteLockAbortedError());
						}
					};
					signal.addEventListener('abort', w.onAbort, { once: true });
				}
				queue.push(w);
				onWait?.(queue.length - 1);
			});
		},

		async withLock<T>(fn: () => Promise<T>, options?: IWriteLockAcquireOptions): Promise<T> {
			const release = await this.acquire(options);
			try {
				return await fn();
			} finally {
				release();
			}
		},

		stats(): IWriteLockStats {
			return {
				acquired: counters.acquired,
				waits: counters.waits,
				totalWaitMs: counters.totalWaitMs,
				maxWaitMs: counters.maxWaitMs,
				waiting: queue.length,
				held,
				holder,
			};
		},

		reset(): void {
			const pending = queue.splice(0, queue.length);
			for (const w of pending) {
				detach(w);
				w.reject(new WriteLockAbortedError('write lock reset'));
			}
			held = false;
			holder = undefined;
			reentry = 0;
		},
	};
}
