/*---------------------------------------------------------------------------------------------
 *  Effect Runtime — minimal Effect-TS-model primitives for structured concurrency.
 *
 *  Self-contained, zero-dependency implementation of the core Effect-TS execution
 *  model (as used by OpenCode), adapted to this codebase's constraints: src/vs/**
 *  cannot import npm packages (esbuild single-file transpile + browser ESM has no
 *  bare-specifier resolution), so the primitives are vendored here.
 *
 *  Primitives:
 *  - Deferred<A>      — settle-once async cell (OpenCode's ToolCall+Deferred pattern)
 *  - InterruptSignal  — cooperative cancellation with a typed reason
 *  - Scope            — structured resource ownership; finalizers run LIFO on close,
 *                       child scopes cascade (no leaked timers / listeners / watchdogs)
 *  - Fiber<A>         — independent logical execution unit: join / exit / interrupt
 *  - fork / timeout / sleep / retry / forEachPar — composable combinators
 *
 *  NOTE: fibers are cooperative units on the single JS thread (identical to
 *  Effect-TS semantics). They provide isolation, supervision, deterministic
 *  cleanup and declarative retry/timeout — NOT OS-thread parallelism.
 *--------------------------------------------------------------------------------------------*/

// ─── Interruption ────────────────────────────────────────────────────────

/** Why a fiber was interrupted. Open string union so callers can add domain reasons. */
export type InterruptReason = 'user' | 'parent' | 'stall' | 'timeout' | (string & {});

/** Typed error raised at interruption points inside a fiber. */
export class FiberInterrupt extends Error {
	readonly _tag = 'FiberInterrupt';
	constructor(readonly reason: InterruptReason = 'user') {
		super(`Fiber interrupted (${reason})`);
		this.name = 'FiberInterrupt';
	}
}

export function isFiberInterrupt(error: unknown): error is FiberInterrupt {
	return error instanceof FiberInterrupt;
}

/**
 * Cooperative cancellation token with a sticky, typed reason.
 * The first interrupt wins; listeners registered after interruption fire immediately
 * (Effect semantics — interruption is a persistent state, not an event).
 */
export class InterruptSignal {
	private _reason: InterruptReason | undefined;
	private readonly _listeners = new Set<(reason: InterruptReason) => void>();

	get interrupted(): boolean { return this._reason !== undefined; }
	get reason(): InterruptReason | undefined { return this._reason; }

	/** Sets the interrupted state. Returns false when already interrupted. */
	interrupt(reason: InterruptReason = 'user'): boolean {
		if (this._reason !== undefined) { return false; }
		this._reason = reason;
		for (const listener of [...this._listeners]) {
			try { listener(reason); } catch { /* listener errors must not break interruption */ }
		}
		return true;
	}

	/** Registers a listener; fires immediately when already interrupted. Returns an unsubscribe fn. */
	onInterrupt(listener: (reason: InterruptReason) => void): () => void {
		if (this._reason !== undefined) {
			try { listener(this._reason); } catch { /* swallow */ }
			return () => { };
		}
		this._listeners.add(listener);
		return () => { this._listeners.delete(listener); };
	}

	/** Interruption point — throws FiberInterrupt when interrupted. */
	throwIfInterrupted(): void {
		if (this._reason !== undefined) { throw new FiberInterrupt(this._reason); }
	}

	/**
	 * Bridges a DOM AbortSignal into this signal (reason defaults to 'parent').
	 * A pre-aborted source interrupts immediately. Returns an unlink fn.
	 */
	linkAbortSignal(source: AbortSignal | undefined, reason: InterruptReason = 'parent'): () => void {
		if (!source) { return () => { }; }
		if (source.aborted) {
			this.interrupt(reason);
			return () => { };
		}
		const onAbort = () => this.interrupt(reason);
		source.addEventListener('abort', onAbort);
		return () => source.removeEventListener('abort', onAbort);
	}
}

// ─── Deferred ────────────────────────────────────────────────────────────

/**
 * Settle-once async cell (OpenCode's ToolCall+Deferred settle pattern).
 * The first succeed/fail wins; subsequent settle attempts return false.
 */
export class Deferred<A> {
	private readonly _promise: Promise<A>;
	private _resolve!: (value: A) => void;
	private _reject!: (error: unknown) => void;
	private _settled = false;

	constructor() {
		this._promise = new Promise<A>((resolve, reject) => {
			this._resolve = resolve;
			this._reject = reject;
		});
	}

	get promise(): Promise<A> { return this._promise; }
	get isSettled(): boolean { return this._settled; }

	succeed(value: A): boolean {
		if (this._settled) { return false; }
		this._settled = true;
		this._resolve(value);
		return true;
	}

	fail(error: unknown): boolean {
		if (this._settled) { return false; }
		this._settled = true;
		this._reject(error);
		return true;
	}
}

// ─── Scope ───────────────────────────────────────────────────────────────

export type ScopeFinalizer = () => void | Promise<void>;

/**
 * Structured resource ownership. Finalizers run LIFO on close; child scopes
 * close before their parent (cascade). Close is idempotent and swallows
 * finalizer errors — cleanup must never break the control flow.
 */
export class Scope {
	private _finalizers: ScopeFinalizer[] = [];
	private _closed = false;
	private readonly _children = new Set<Scope>();
	private readonly _parent: Scope | undefined;

	constructor(parent?: Scope) {
		this._parent = parent;
		if (parent) {
			if (parent._closed) { throw new Error('Cannot create a child scope of a closed scope'); }
			parent._children.add(this);
		}
	}

	get isClosed(): boolean { return this._closed; }

	/** Creates a child scope that closes when this scope closes. */
	child(): Scope {
		return new Scope(this);
	}

	addFinalizer(finalizer: ScopeFinalizer): void {
		if (this._closed) { throw new Error('Cannot add a finalizer to a closed scope'); }
		this._finalizers.push(finalizer);
	}

	async close(): Promise<void> {
		if (this._closed) { return; }
		this._closed = true;
		this._parent?._children.delete(this);
		// Children first (more specific resources), then own finalizers LIFO.
		for (const child of [...this._children]) {
			try { await child.close(); } catch { /* finalizer errors are swallowed */ }
		}
		this._children.clear();
		for (let i = this._finalizers.length - 1; i >= 0; i--) {
			try { await this._finalizers[i](); } catch { /* finalizer errors are swallowed */ }
		}
		this._finalizers = [];
	}

	/** Runs fn with a child scope that is guaranteed to close afterwards. */
	async use<A>(fn: (scope: Scope) => Promise<A>): Promise<A> {
		const child = this.child();
		try {
			return await fn(child);
		} finally {
			await child.close();
		}
	}
}

// ─── Fiber ───────────────────────────────────────────────────────────────

export type FiberStatus = 'running' | 'done' | 'failed' | 'interrupted';

export type FiberExit<A> =
	| { readonly _tag: 'success'; readonly value: A }
	| { readonly _tag: 'failure'; readonly error: unknown }
	| { readonly _tag: 'interrupt'; readonly reason: InterruptReason };

export interface IFiberContext {
	readonly fiberId: string;
	readonly signal: InterruptSignal;
	readonly scope: Scope;
}

export interface IForkOptions {
	/**
	 * Parent scope — the fiber's scope becomes a child, and a supervision
	 * finalizer is registered on the parent: closing the parent scope
	 * interrupts this fiber (structured supervision tree).
	 */
	readonly parentScope?: Scope;
	/** External interrupt signal to share instead of creating a fresh one. */
	readonly signal?: InterruptSignal;
}

let _nextFiberId = 1;

/**
 * Independent logical execution unit. The task starts synchronously (up to its
 * first await). The exit settles only AFTER all scope finalizers have run, so
 * joiners never observe a half-cleaned execution.
 *
 * Interruption is sticky: if the signal is set while the task is finishing,
 * interruption wins over a produced value (Effect semantics).
 */
export class Fiber<A> {
	readonly id: string;
	readonly signal: InterruptSignal;
	readonly scope: Scope;
	private readonly _deferred = new Deferred<FiberExit<A>>();
	private _exit: FiberExit<A> | undefined;

	constructor(task: (ctx: IFiberContext) => Promise<A>, options?: IForkOptions) {
		this.id = `fiber-${_nextFiberId++}`;
		this.signal = options?.signal ?? new InterruptSignal();
		this.scope = options?.parentScope ? options.parentScope.child() : new Scope();
		if (options?.parentScope) {
			// Supervision: closing the parent scope interrupts this fiber.
			options.parentScope.addFinalizer(() => { this.signal.interrupt('parent'); });
		}
		void this._run(task);
	}

	get status(): FiberStatus {
		if (this._exit) {
			return this._exit._tag === 'success' ? 'done' : this._exit._tag === 'failure' ? 'failed' : 'interrupted';
		}
		return this.signal.interrupted ? 'interrupted' : 'running';
	}

	/** Resolves with the fiber's exit (never rejects). */
	get exit(): Promise<FiberExit<A>> { return this._deferred.promise; }

	/** Awaits the result; rethrows failure / FiberInterrupt. */
	async join(): Promise<A> {
		const exit = await this._deferred.promise;
		if (exit._tag === 'success') { return exit.value; }
		if (exit._tag === 'interrupt') { throw new FiberInterrupt(exit.reason); }
		throw exit.error;
	}

	/** Cooperative interruption: sets the signal; returns the eventual exit. */
	interrupt(reason: InterruptReason = 'user'): Promise<FiberExit<A>> {
		this.signal.interrupt(reason);
		return this.exit;
	}

	private async _run(task: (ctx: IFiberContext) => Promise<A>): Promise<void> {
		const ctx: IFiberContext = { fiberId: this.id, signal: this.signal, scope: this.scope };
		let exit: FiberExit<A>;
		try {
			const value = await task(ctx);
			// Sticky interruption wins over a normally produced value.
			exit = this.signal.interrupted
				? { _tag: 'interrupt', reason: this.signal.reason ?? 'user' }
				: { _tag: 'success', value };
		} catch (error) {
			if (isFiberInterrupt(error)) {
				exit = { _tag: 'interrupt', reason: error.reason };
			} else if (this.signal.interrupted) {
				exit = { _tag: 'interrupt', reason: this.signal.reason ?? 'user' };
			} else {
				exit = { _tag: 'failure', error };
			}
		}
		// Structured cleanup runs before the exit settles.
		try { await this.scope.close(); } catch { /* close() already swallows finalizer errors */ }
		this._exit = exit;
		this._deferred.succeed(exit);
	}
}

/** Spawns an independent fiber executing task. */
export function fork<A>(task: (ctx: IFiberContext) => Promise<A>, options?: IForkOptions): Fiber<A> {
	return new Fiber<A>(task, options);
}

// ─── Combinators ─────────────────────────────────────────────────────────

/** Interruptible sleep — rejects with FiberInterrupt when the signal fires. */
export function sleep(ms: number, signal?: InterruptSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.interrupted) {
			reject(new FiberInterrupt(signal.reason ?? 'user'));
			return;
		}
		const timer = setTimeout(() => { unlink?.(); resolve(); }, ms);
		const unlink = signal?.onInterrupt(reason => {
			clearTimeout(timer);
			reject(new FiberInterrupt(reason));
		});
	});
}

/**
 * Races a promise against a hard timeout AND an interrupt signal.
 * Unlike a hand-rolled `Promise.race([p, new Promise(...setTimeout)])`, the
 * timer and the signal listener are ALWAYS cleared once the race settles —
 * no dangling timers outliving the winner.
 *
 * Note: a losing `promise` is not cancelled (JS promises are not cancellable);
 * callers that need active cancellation should wire the signal themselves.
 */
export async function timeout<A>(
	promise: Promise<A>,
	ms: number,
	makeError: () => Error,
	signal?: InterruptSignal,
): Promise<A> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unlink: (() => void) | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(makeError()), ms);
		if (signal) {
			if (signal.interrupted) {
				reject(new FiberInterrupt(signal.reason ?? 'user'));
			} else {
				unlink = signal.onInterrupt(reason => reject(new FiberInterrupt(reason)));
			}
		}
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer !== undefined) { clearTimeout(timer); }
		unlink?.();
	}
}

export interface IRetryOptions {
	/** Extra attempts after the first one (Schedule.recurs semantics). */
	readonly times: number;
	/** Decides whether an error is retryable (defaults to always). */
	readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
	/** Invoked before each retry with the error and the upcoming attempt number (1-based). */
	readonly onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * Declarative retry (Effect's Schedule.recurs). The retried unit is re-invoked
 * from scratch, so each attempt gets fresh per-attempt state.
 */
export async function retry<A>(fn: (attempt: number) => Promise<A>, options: IRetryOptions): Promise<A> {
	let attempt = 0;
	for (; ;) {
		try {
			return await fn(attempt);
		} catch (error) {
			const canRetry = attempt < options.times && (options.shouldRetry?.(error, attempt) ?? true);
			if (!canRetry) { throw error; }
			attempt++;
			options.onRetry?.(error, attempt);
		}
	}
}

export type SettledResult<B> =
	| { readonly status: 'fulfilled'; readonly value: B }
	| { readonly status: 'rejected'; readonly reason: unknown };

/**
 * Semaphore-bounded parallel map with allSettled semantics (Effect's
 * `Effect.forEach(..., { concurrency })` + `Effect.either`). A rolling window
 * keeps at most `concurrency` invocations in flight; one item's failure does
 * NOT abort the rest. Results preserve input order.
 */
export async function forEachPar<A, B>(
	items: readonly A[],
	concurrency: number,
	f: (item: A, index: number) => Promise<B>,
): Promise<ReadonlyArray<SettledResult<B>>> {
	const limit = Math.max(1, concurrency);
	const results = new Array<SettledResult<B>>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor++;
			try {
				results[index] = { status: 'fulfilled', value: await f(items[index], index) };
			} catch (reason) {
				results[index] = { status: 'rejected', reason };
			}
		}
	});
	await Promise.all(workers);
	return results;
}
