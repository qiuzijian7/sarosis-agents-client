/*---------------------------------------------------------------------------------------------
 *  Stall Watchdog (MiMo-Code-inspired, T40)
 *
 *  Background / long-running sub-agents can get stuck (model hangs, a tool never returns a
 *  result delta, network stall). MiMo-Code scans running sub-agents and aborts any that
 *  show no progress for a threshold (T40 = 45s).
 *
 *  `StallWatchdog` measures IDLE time: the gap between now and the last `tick()` (any
 *  meaningful activity — a streamed delta, a tool start/end). If idle exceeds
 *  `idleTimeoutMs`, `onStall` fires once per idle window.
 *
 *  Designed for dependency-free unit testing: pass an injectable `now()` clock and call
 *  `pump()` to evaluate idle synchronously (no real timer needed in tests). A real
 *  `setTimeout` backs the production path.
 *--------------------------------------------------------------------------------------------*/

export interface IStallWatchdogOptions {
	readonly idleTimeoutMs: number;
	readonly onStall: (idleMs: number) => void;
	/** Injectable clock for testing (defaults to Date.now). */
	readonly now?: () => number;
}

export class StallWatchdog {
	private _lastActivity: number;
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private readonly _opts: IStallWatchdogOptions;
	private _disposed = false;
	/**
	 * 暂停计数（2026-07-26 P0：工具执行盲区修复）。tool_start→pause / tool_end→resume。
	 * tool_start 全部在模型流式装配期到达、tool_end 在执行完成后到达，计数 >0 的
	 * 整段窗口恰好覆盖「参数流式 + 全部工具执行」——期间看门狗解除武装，杜绝
	 * 「await 长工具（嵌套 delegate_task 可达数分钟）期间无 delta」导致的误判停滞。
	 * 工具执行本身由 toolExecutionGuard 兜底（编排工具 630s），无需看门狗重复计时。
	 */
	private _pauseCount = 0;

	constructor(opts: IStallWatchdogOptions) {
		this._opts = opts;
		this._lastActivity = this._now();
		this._schedule();
	}

	/**
	 * Record activity — resets the idle clock. Call on every meaningful delta.
	 * 暂停期间仍记录活动（tool_args 流式是模型活动），但不重新武装计时器。
	 */
	tick(): void {
		if (this._disposed) { return; }
		this._lastActivity = this._now();
		if (this._pauseCount === 0) {
			this._schedule();
		}
	}

	/** 解除武装（工具执行窗口开始）。可嵌套，需与 resume 配对。 */
	pause(): void {
		if (this._disposed) { return; }
		this._pauseCount++;
		this._clear();
	}

	/** 重新武装（最后一个在飞工具完成）并从当前时刻重置空闲时钟。 */
	resume(): void {
		if (this._disposed || this._pauseCount === 0) { return; }
		this._pauseCount--;
		if (this._pauseCount === 0) {
			this._lastActivity = this._now();
			this._schedule();
		}
	}

	/**
	 * Evaluate idle right now; fires onStall if idle exceeded. Re-arms so a still-stalled
	 * agent keeps firing every idleTimeoutMs. Safe to call manually (used by tests with an
	 * injected clock) — production calls it from the internal setTimeout.
	 */
	pump(): void {
		if (this._disposed || this._pauseCount > 0) { return; }
		const idle = this._now() - this._lastActivity;
		if (idle >= this._opts.idleTimeoutMs) {
			this._opts.onStall(idle);
			this._lastActivity = this._now();
			this._schedule();
		}
	}

	dispose(): void {
		this._disposed = true;
		this._clear();
	}

	private _now(): number {
		return this._opts.now ? this._opts.now() : Date.now();
	}

	private _schedule(): void {
		this._clear();
		if (this._disposed) { return; }
		this._timer = setTimeout(() => this.pump(), this._opts.idleTimeoutMs);
	}

	private _clear(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}
}
