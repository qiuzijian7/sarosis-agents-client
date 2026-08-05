/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Resilience primitives — 容错基础设施（对齐 LangGraph 的 RetryPolicy / TimeoutPolicy）。
 *
 * 提供：
 *  - RetryPolicy          — 指数退避 + 抖动 的重试策略定义
 *  - TimeoutPolicy        — run（硬墙钟）+ idle（无进度）双维超时定义
 *  - computeBackoffDelay  — 根据 attempt 计算下一次重试延迟（指数退避 + 有界 jitter）
 *  - shouldRetryOn        — 判定某错误是否可重试
 *  - sleepWithAbort       — 可被 AbortSignal 打断的延时
 *  - runWithRetry         — 通用「带退避重试」运行器（尊重 AbortSignal / retryOn）
 *  - runWithTimeoutPolicy — 通用「run + idle 双超时」运行器（心跳刷新 idle）
 *
 * 这是无依赖的纯模块（不引用 browser 能力），core 与 browser 均可 import。
 */

// ─── Policy types ───────────────────────────────────────────────────

/** 可重试判定：错误构造器、构造器数组、或谓词函数 */
export type RetryOn =
	| ErrorConstructor
	| Array<ErrorConstructor>
	| ((error: unknown) => boolean);

/**
 * 重试策略（对齐 LangGraph RetryPolicy @ types.py:416）。
 * 所有时间单位均为毫秒。
 */
export interface RetryPolicy {
	/** 首次重试延迟（基础间隔）。默认 500ms。 */
	initialInterval?: number;
	/** 退避系数（每次 ×factor）。默认 2.0。 */
	backoffFactor?: number;
	/** 延迟上限。默认 128_000ms（~2min）。 */
	maxInterval?: number;
	/** 最大尝试次数（含首次）。默认 3。 */
	maxAttempts?: number;
	/** 是否加入随机抖动（避免惊群 / 限流风暴）。默认 true。 */
	jitter?: boolean;
	/**
	 * 可重试判定。未指定时，所有抛出均重试（受 maxAttempts 限制）。
	 * 指定后，仅当判定通过才重试；否则立即上抛。
	 */
	retryOn?: RetryOn;
}

/**
 * 超时策略（对齐 LangGraph TimeoutPolicy @ types.py:450）。
 * 所有时间单位均为毫秒。
 */
export interface TimeoutPolicy {
	/** 硬墙钟超时：从开始到结束的总时长上限。默认不限制。 */
	runTimeout?: number;
	/**
	 * 无进度超时：超过该时长没有任何「进度心跳」则判定卡死。
	 * 需配合 runWithTimeoutPolicy 的 onProgress / refreshOn 使用。默认不限制。
	 */
	idleTimeout?: number;
	/**
	 * 首 token 宽限（流式专用）：流「尚未产出过任何 item」时使用的更长超时，
	 * 用于容忍重负载请求（如携带大量 tools 的大请求体）下模型推理 / 网关预处理的
	 * 慢启动。一旦首个 delta 到达，即切换到 `idleTimeout` 检测「流中途静默挂起」。
	 * 缺省回退到 `idleTimeout`，即首 token 前与中途共用同一阈值（保持旧行为）。
	 * 仅对 withStreamTimeout 生效。
	 */
	firstTokenTimeout?: number;
	/**
	 * 进度刷新方式：
	 *  - 'auto'   运行器在每次内部 await 点自动刷新（粗粒度）
	 *  - 'heartbeat' 由调用方通过 onProgress() 显式刷新（细粒度，推荐长任务）
	 */
	refreshOn?: 'auto' | 'heartbeat';
}

/** 默认重试策略（对齐 LangGraph 默认值） */
export const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = {
	initialInterval: 500,
	backoffFactor: 2.0,
	maxInterval: 128_000,
	maxAttempts: 3,
	jitter: true,
	retryOn: undefined as unknown as RetryOn,
};

/** 解析一个（可能部分的）策略为完整策略 */
export function resolveRetryPolicy(policy?: RetryPolicy): Required<RetryPolicy> {
	const base = policy ? { ...DEFAULT_RETRY_POLICY, ...policy } : DEFAULT_RETRY_POLICY;
	// retryOn 显式传 undefined 时应保留默认（undefined = 全部重试），上面展开已处理
	return base;
}

// ─── Backoff math ───────────────────────────────────────────────────

/**
 * 计算第 `attempt` 次失败后的重试延迟（毫秒）。
 * attempt 从 1 开始（第 1 次失败 → 第 2 次尝试的等待）。
 *
 * 公式：delay = min(initialInterval * backoffFactor^(attempt-1), maxInterval)
 * 启用 jitter 时：delay = delay * (0.5 .. 1.0) 的随机比例（上限不超过 maxInterval）。
 */
export function computeBackoffDelay(attempt: number, policy?: RetryPolicy): number {
	const p = resolveRetryPolicy(policy);
	const exp = Math.pow(p.backoffFactor, Math.max(0, attempt - 1));
	let delay = p.initialInterval * exp;
	if (delay > p.maxInterval) {
		delay = p.maxInterval;
	}
	if (p.jitter) {
		// 全抖动（full jitter）：在 [delay/2, delay] 间随机，避免同步重试
		delay = delay / 2 + Math.random() * (delay / 2);
	}
	return Math.floor(delay);
}

/** 判定某值是否为内置 Error 构造器（Error 及其标准子类）。用于区分「谓词函数」与「错误构造器」。 */
function isErrorConstructor(value: unknown): value is ErrorConstructor {
	return (
		value === Error ||
		value === TypeError ||
		value === RangeError ||
		value === ReferenceError ||
		value === SyntaxError ||
		value === URIError ||
		value === EvalError ||
		value === AggregateError
	);
}

/** 判定某错误是否匹配 retryOn 规则 */
export function shouldRetryOn(error: unknown, retryOn?: RetryOn): boolean {
	if (!retryOn) {
		return true; // 未指定 → 全部重试
	}
	// 注意：ErrorConstructor 也是 function，故 typeof === 'function' 无法区分「谓词」与「错误构造器」，
	// 必须先排除内置 Error 构造器，否则 retryOn(error) 会被当作 new Error(...) 调用而返回 Error 实例。
	if (typeof retryOn === 'function' && !isErrorConstructor(retryOn)) {
		try {
			return retryOn(error);
		} catch {
			return false;
		}
	}
	const ctors = Array.isArray(retryOn) ? retryOn : [retryOn as ErrorConstructor];
	if (!(error instanceof Error)) {
		// 非 Error 实例：仅当规则是谓词时才可能命中（已处理），否则不重试
		return ctors.length === 0;
	}
	return ctors.some(C => error instanceof C);
}

// ─── Abort-aware sleep ──────────────────────────────────────────────

/** 可被 AbortSignal 打断的延时；abort 时 reject 一个 DOMException('AbortError')。 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException('Aborted', 'AbortError'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException('Aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

// ─── Generic retry runner ───────────────────────────────────────────

export interface RunWithRetryOptions {
	/** 父级取消信号 */
	signal?: AbortSignal;
	/** 每次重试前回调（用于日志 / 上报）。delayMs 已是含 jitter 的最终值 */
	onRetry?: (info: { attempt: number; error: unknown; delayMs: number; willRetry: boolean }) => void;
	/** 日志回调（不强制依赖 ILogService，便于 core 复用） */
	log?: (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => void;
}

/**
 * 通用「带指数退避 + 抖动」重试运行器。
 *
 * - 最多尝试 `policy.maxAttempts` 次。
 * - 仅在 `shouldRetryOn(error, policy.retryOn)` 通过时重试；否则立即上抛。
 * - 每次重试前按 computeBackoffDelay 等待（尊重 AbortSignal）。
 * - signal abort 时立即 reject（AbortError），不再重试。
 */
export async function runWithRetry<T>(
	fn: (attempt: number) => Promise<T>,
	policy?: RetryPolicy,
	opts: RunWithRetryOptions = {},
): Promise<T> {
	const p = resolveRetryPolicy(policy);
	const { signal, onRetry, log } = opts;

	let lastError: unknown;
	for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
		if (signal?.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		try {
			return await fn(attempt);
		} catch (error) {
			lastError = error;
			const retryable = shouldRetryOn(error, p.retryOn);
			const hasMore = attempt < p.maxAttempts;
			if (!retryable || !hasMore) {
				if (!retryable) {
					log?.('warn', `[resilience] non-retryable error on attempt ${attempt}`, error);
				}
				throw error;
			}
			const delayMs = computeBackoffDelay(attempt, p);
			onRetry?.({ attempt, error, delayMs, willRetry: true });
			log?.('warn', `[resilience] attempt ${attempt} failed, retrying in ${delayMs}ms`, error);
			try {
				await sleepWithAbort(delayMs, signal);
			} catch (abortErr) {
				// 等待期间被取消 → 上抛 AbortError（携带最后一次错误上下文）
				throw abortErr;
			}
		}
	}
	// 理论上不可达（循环内已 throw），但保底
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ─── Timeout policy runner (run + idle) ─────────────────────────────

export interface RunWithTimeoutOptions {
	signal?: AbortSignal;
	/** 进度心跳回调：调用即刷新 idle 计时（refreshOn='heartbeat' 时必需） */
	onProgress?: () => void;
	/**
	 * 超时回调（被超时打断时调用，用于清理资源）。
	 * 注意：运行中的 promise 不会被强制终止，仅以拒绝形式通知调用方。
	 */
	onTimeout?: (kind: 'run' | 'idle') => void;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * 通用「run（硬墙钟）+ idle（无进度）双超时」运行器（对齐 LangGraph TimeoutPolicy）。
 *
 * - runTimeout：从开始到结束的总时长上限。
 * - idleTimeout：超过该时长无进度心跳（onProgress 未被调用）判定卡死。
 *   refreshOn='auto' 时运行器在每个 microtask 边界近似刷新（粗粒度）；
 *   refreshOn='heartbeat' 时仅在调用方显式 onProgress() 时刷新（细粒度）。
 * - idle 超时依赖调用方周期性调用 onProgress；若从不调用且 refreshOn='heartbeat'，
 *   则 idle 超时必然触发（用于检测静默卡死）。
 *
 * 返回 Promise：超时则以 DOMException('TimeoutError') reject；signal abort 则 AbortError。
 * 注意：超时仅通知，不会强制终止 fn 内部的异步工作（与 LangGraph 协作式取消一致）。
 */
export function runWithTimeoutPolicy<T>(
	fn: (progress: () => void) => Promise<T>,
	policy?: TimeoutPolicy,
	opts: RunWithTimeoutOptions = {},
): Promise<T> {
	const runTimeout = policy?.runTimeout;
	const idleTimeout = policy?.idleTimeout;
	const refreshOn = policy?.refreshOn ?? 'auto';
	const { signal, onProgress, onTimeout, log } = opts;

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let lastProgress = Date.now();
		const timers: ReturnType<typeof setTimeout>[] = [];

		const cleanup = () => {
			timers.forEach(clearTimeout);
			signal?.removeEventListener('abort', onAbort);
		};
		const onAbort = () => {
			if (settled) { return; }
			settled = true;
			cleanup();
			reject(new DOMException('Aborted', 'AbortError'));
		};
		if (signal) {
			if (signal.aborted) {
				reject(new DOMException('Aborted', 'AbortError'));
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}

		const refresh = () => {
			lastProgress = Date.now();
			onProgress?.();
		};

		if (runTimeout && runTimeout > 0) {
			timers.push(setTimeout(() => {
				if (settled) { return; }
				settled = true;
				cleanup();
				onTimeout?.('run');
				log?.('warn', `[resilience] run timeout after ${runTimeout}ms`);
				reject(new DOMException(`Run timeout after ${runTimeout}ms`, 'TimeoutError'));
			}, runTimeout));
		}

		if (idleTimeout && idleTimeout > 0) {
			const idleChecker = setInterval(() => {
				if (settled) { return; }
				const idle = Date.now() - lastProgress;
				if (idle >= idleTimeout) {
					settled = true;
					cleanup();
					onTimeout?.('idle');
					log?.('warn', `[resilience] idle timeout after ${idle}ms with no progress`);
					reject(new DOMException(`Idle timeout after ${idleTimeout}ms`, 'TimeoutError'));
				}
			}, Math.max(100, Math.floor(idleTimeout / 4)));
			// setInterval 需用 unref 类似机制避免阻止进程退出；这里用 cleanup 统一管理
			timers.push(idleChecker as unknown as ReturnType<typeof setTimeout>);
		}

		// auto 刷新：用微任务轮询近似（粗粒度，适合短任务）
		let autoTimer: ReturnType<typeof setInterval> | undefined;
		if (refreshOn === 'auto' && idleTimeout) {
			autoTimer = setInterval(refresh, Math.max(50, Math.floor(idleTimeout / 8)));
			timers.push(autoTimer as unknown as ReturnType<typeof setTimeout>);
		}

		const progressFn = refreshOn === 'heartbeat' ? refresh : () => { /* heartbeat 模式仅调用方刷新 */ };

		fn(progressFn).then(
			(result) => {
				if (settled) { return; }
				settled = true;
				cleanup();
				resolve(result);
			},
			(error) => {
				if (settled) { return; }
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

// ─── Streaming timeout (async-iterable aware) ──────────────────────

export interface StreamTimeoutOptions {
	signal?: AbortSignal;
	/** 超时回调（被超时打断时调用，用于日志 / 上报） */
	onTimeout?: (kind: 'run' | 'idle') => void;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * 自适应首 token 超时（方案 B）：按估算 prompt 大小放宽慢启动宽限。
 *
 * 背景：固定 45s 首 token 超时对「大 prompt + 冷缓存 prefill」场景过紧——
 * 实测 hy3-ioa 网关 34k tokens 冷缓存请求 TTFB 达 46.4s（同会话小 prompt 仅 5.8s），
 * 固定阈值会误杀一个仍存活（只是慢）的请求。prefill 耗时与 prompt 大小正相关，
 * 因此宽限随估算 token 数阶梯增长。
 *
 * 规则：base 以下不调整；超过 {@link ADAPTIVE_FIRST_TOKEN_THRESHOLD} 后每
 * {@link ADAPTIVE_FIRST_TOKEN_STEP_TOKENS} 增加 {@link ADAPTIVE_FIRST_TOKEN_STEP_MS}；
 * 上限 {@link ADAPTIVE_FIRST_TOKEN_CAP_MS}（不得 ≥ HTTP 层 120s 请求超时，否则
 * resilience 会在 HTTP 层之前误杀慢流）。
 *
 * 示例（base=45s）：16k→45s，24k→60s，32k→75s，40k→90s，≥72k→120s（封顶）。
 */
export const ADAPTIVE_FIRST_TOKEN_THRESHOLD = 16_000;
export const ADAPTIVE_FIRST_TOKEN_STEP_TOKENS = 8_000;
export const ADAPTIVE_FIRST_TOKEN_STEP_MS = 15_000;
export const ADAPTIVE_FIRST_TOKEN_CAP_MS = 115_000;

export function computeAdaptiveFirstTokenTimeout(
	estPromptTokens: number,
	baseMs: number,
): number {
	if (!Number.isFinite(estPromptTokens) || estPromptTokens <= ADAPTIVE_FIRST_TOKEN_THRESHOLD) {
		return baseMs;
	}
	const steps = Math.ceil((estPromptTokens - ADAPTIVE_FIRST_TOKEN_THRESHOLD) / ADAPTIVE_FIRST_TOKEN_STEP_TOKENS);
	return Math.min(baseMs + steps * ADAPTIVE_FIRST_TOKEN_STEP_MS, ADAPTIVE_FIRST_TOKEN_CAP_MS);
}

/**
 * 给一个异步可迭代流（如 LLM 流式响应）套上「run（硬墙钟）+ idle（无进度）双超时」
 * （对齐 LangGraph TimeoutPolicy，流式版）。
 *
 * - runTimeout：从开始迭代到结束的总时长上限。
 * - idleTimeout：超过该时长未产出下一个 item 则判定卡死（适合检测「静默挂起」的模型流）。
 *   每产出一个 item 即刷新 idle 计时 —— 这里的「进度心跳」= 流 delta 到达。
 * - 超时：以抛出 DOMException('TimeoutError') 形式通知消费方（for await 处会收到），
 *   同时调用底层迭代器的 return() 尝试协作式取消上游（如中止挂起的 HTTP 流）。
 * - signal abort：以 AbortError 抛出，并协作式取消上游。
 *
 * 与 runWithTimeoutPolicy 的区别：本函数作用在 async iterable 上，可在产出每个
 * item 的同时透传给消费方（不缓冲整段响应），因此适用于流式大模型输出。
 */
export async function* withStreamTimeout<T>(
	sourceLike: AsyncIterable<T> | Promise<AsyncIterable<T>>,
	policy?: TimeoutPolicy,
	opts: StreamTimeoutOptions = {},
): AsyncIterable<T> {
	const runTimeout = policy?.runTimeout;
	const idleTimeout = policy?.idleTimeout;
	/**
	 * 首 token 宽限：流「尚未产出过任何 item」时使用的更长超时，用于容忍重负载
	 * 下（如发送大量 tools 的大请求）模型推理 / 网关预处理的慢启动。一旦首个 delta
	 * 到达，即切换到严格的 idleTimeout 以检测「流中途静默挂起」。缺省回退到
	 * idleTimeout，保持既有行为（首 token 前与中途共用同一阈值）。
	 */
	const firstTokenTimeout = policy?.firstTokenTimeout;
	const { signal, onTimeout, log } = opts;

	const source = await sourceLike;
	const iterator = source[Symbol.asyncIterator]();
	let settled = false;
	let lastItem = Date.now();
	// 首 item 前窗口使用 firstTokenTimeout；首 item 后改用 idleTimeout。两者语义不同：
	// 前者容忍「慢启动」，后者检测「中途挂起」。
	let firstItemReceived = false;
	const timers: ReturnType<typeof setTimeout>[] = [];

	// 当前 in-flight next() 的 reject 句柄：让定时器能在 pending 期间注入超时错误。
	let nextReject: ((e: unknown) => void) | undefined;

	const cleanup = () => {
		timers.forEach(clearTimeout);
		signal?.removeEventListener('abort', onAbort);
	};
	const finish = (err?: unknown) => {
		if (settled) { return; }
		settled = true;
		cleanup();
		if (err) {
			nextReject?.(err);
		}
		nextReject = undefined;
		// 协作式取消上游流（如中止挂起的 HTTP 响应）
		void iterator.return?.();
	};
	const onAbort = () => finish(new DOMException('Aborted', 'AbortError'));

	if (signal) {
		if (signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		signal.addEventListener('abort', onAbort, { once: true });
	}

	if (runTimeout && runTimeout > 0) {
		timers.push(setTimeout(() => {
			if (settled) { return; }
			onTimeout?.('run');
			log?.('warn', `[resilience] stream run timeout after ${runTimeout}ms`);
			finish(new DOMException(`Stream run timeout after ${runTimeout}ms`, 'TimeoutError'));
		}, runTimeout));
	}

	// idle 与 first-token 两档超时共用一个检查器：尚未收到首 item 时用首 token 宽限
	// （默认回退 idleTimeout），收到后用严格 idleTimeout。任一档 >0 即启用检查器。
	if ((idleTimeout && idleTimeout > 0) || (firstTokenTimeout && firstTokenTimeout > 0)) {
		const firstTokenBudget = firstTokenTimeout ?? idleTimeout!;
		const tick = Math.max(100, Math.floor(Math.min(firstTokenBudget, idleTimeout ?? firstTokenBudget) / 4));
		const idleChecker = setInterval(() => {
			if (settled) { return; }
			const threshold = firstItemReceived ? (idleTimeout ?? 0) : firstTokenBudget;
			if (threshold > 0 && Date.now() - lastItem >= threshold) {
				const kind = firstItemReceived ? 'idle' : 'first-token';
				onTimeout?.('idle');
				log?.('warn', `[resilience] stream ${kind} timeout after ${threshold}ms (no delta)`);
				finish(new DOMException(`Stream ${kind} timeout after ${threshold}ms`, 'TimeoutError'));
			}
		}, tick);
		timers.push(idleChecker as unknown as ReturnType<typeof setTimeout>);
	}

	try {
		while (true) {
			const pending = iterator.next();
			const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
				nextReject = reject;
				pending.then(resolve, reject);
			});
			nextReject = undefined;
			if (result.done) {
				return;
			}
			lastItem = Date.now(); // 每产出一个 item 刷新 idle
			firstItemReceived = true; // 首 token 已到：后续改用严格 idle 阈值
			yield result.value;
		}
	} finally {
		finish();
	}
}
