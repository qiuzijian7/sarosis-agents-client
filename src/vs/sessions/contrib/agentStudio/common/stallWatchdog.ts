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

	constructor(opts: IStallWatchdogOptions) {
		this._opts = opts;
		this._lastActivity = this._now();
		this._schedule();
	}

	/** Record activity — resets the idle clock. Call on every meaningful delta. */
	tick(): void {
		if (this._disposed) { return; }
		this._lastActivity = this._now();
		this._schedule();
	}

	/**
	 * Evaluate idle right now; fires onStall if idle exceeded. Re-arms so a still-stalled
	 * agent keeps firing every idleTimeoutMs. Safe to call manually (used by tests with an
	 * injected clock) — production calls it from the internal setTimeout.
	 */
	pump(): void {
		if (this._disposed) { return; }
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
