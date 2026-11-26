/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Monotonic, credential-free phase timings; logging failures never affect startup. */
export class DshStartupTrace {
	private readonly _started: number;
	private _finished = false;

	constructor(
		readonly id: string,
		private readonly _log: (line: string) => void,
		private readonly _now: () => number = () => performance.now(),
	) {
		this._started = this._now();
		this.mark('begin');
	}

	mark(phase: string): void {
		this._emit({ phase, elapsedMs: this._elapsed() });
	}

	async measure<T>(phase: string, operation: () => T | Promise<T>): Promise<T> {
		const started = this._now();
		let outcome = 'error';
		this._emit({ phase, event: 'begin', elapsedMs: this._elapsed() });
		try {
			const result = await operation();
			outcome = 'ok';
			return result;
		} finally {
			this._emit({ phase, event: 'end', outcome, durationMs: Math.max(0, Math.round(this._now() - started)), elapsedMs: this._elapsed() });
		}
	}

	finish(outcome: string): void {
		if (!this._finished) {
			this._emit({ phase: 'finish', outcome, elapsedMs: this._elapsed() });
			this._finished = true;
		}
	}

	private _elapsed(): number {
		return Math.max(0, Math.round(this._now() - this._started));
	}

	private _emit(record: { phase: string; event?: string; outcome?: string; durationMs?: number; elapsedMs: number }): void {
		if (!this._finished) {
			try { this._log(`[dsh-startup] ${JSON.stringify({ startupId: this.id, ...record })}`); } catch { /* Keep diagnostics non-blocking. */ }
		}
	}
}
