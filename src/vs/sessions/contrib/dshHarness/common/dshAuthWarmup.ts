/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IDshAuthConnection {
	readonly origin: string;
	readonly authUrl: string;
}

export interface IDshAuthCookie {
	readonly name: string;
	readonly value: string;
	readonly domain?: string;
	readonly path?: string;
	readonly secure?: boolean;
	readonly expirationDate?: number;
}

interface IAuthProof {
	readonly epoch: number;
	readonly validUntil: number;
	readonly cookies: readonly IDshAuthCookie[];
}

interface IAuthExchange {
	readonly epoch: number;
	readonly controller: AbortController;
	readonly promise: Promise<boolean>;
	force: boolean;
}

export interface IDshAuthWarmupOptions<S extends object> {
	readonly exchange: (session: S, connection: IDshAuthConnection, signal: AbortSignal) => Promise<boolean>;
	readonly cookies: (session: S, origin: string) => Promise<readonly IDshAuthCookie[]>;
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly timeoutMs?: number;
	readonly onEvent?: (event: 'cache-hit' | 'exchange' | 'failed' | 'timeout', elapsedMs: number) => void;
}

/** Compare credentials as well as authority; a new token on the same port is a new connection. */
export function sameAuthConnection(a: IDshAuthConnection | undefined, b: IDshAuthConnection | undefined): boolean {
	return a?.origin === b?.origin && a?.authUrl === b?.authUrl;
}

/** Session-scoped, short-lived proof of a successful exchange, with serialized credential replacement. */
export class DshAuthWarmup<S extends object> {
	private _connection: IDshAuthConnection | undefined;
	private _epoch = 0;
	private _disposed = false;
	private _proofs = new WeakMap<S, IAuthProof>();
	private readonly _exchanges = new Map<S, IAuthExchange>();

	constructor(private readonly _options: IDshAuthWarmupOptions<S>) { }

	get epoch(): number { return this._epoch; }

	setConnection(connection: IDshAuthConnection | undefined): void {
		if (sameAuthConnection(connection, this._connection)) {
			return;
		}
		this._connection = connection && { ...connection };
		this._epoch++;
		this._proofs = new WeakMap();
		for (const exchange of this._exchanges.values()) {
			exchange.controller.abort();
		}
	}

	isCurrent(connection: IDshAuthConnection, epoch = this._epoch): boolean {
		return !this._disposed && epoch === this._epoch && sameAuthConnection(connection, this._connection);
	}

	ensure(session: S, connection: IDshAuthConnection, force = false): Promise<boolean> {
		if (!this.isCurrent(connection)) {
			return Promise.resolve(false);
		}
		const previous = this._exchanges.get(session);
		if (force) {
			this._proofs.delete(session);
		}
		if (previous?.epoch === this._epoch) {
			previous.force ||= force;
			return previous.promise;
		}
		const controller = new AbortController();
		const epoch = this._epoch;
		const promise = (previous?.promise ?? Promise.resolve(false))
			.catch(() => false)
			.then(() => this._run(session, connection, entry))
			.finally(() => {
				if (this._exchanges.get(session) === entry) {
					this._exchanges.delete(session);
				}
			});
		const entry: IAuthExchange = { epoch, controller, promise, force };
		this._exchanges.set(session, entry);
		return promise;
	}

	private async _run(session: S, connection: IDshAuthConnection, entry: IAuthExchange): Promise<boolean> {
		if (!this.isCurrent(connection, entry.epoch) || entry.controller.signal.aborted) {
			return false;
		}
		const now = this._options.now ?? Date.now;
		const started = now();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			entry.controller.abort();
		}, this._options.timeoutMs ?? 15_000);
		const current = () => this.isCurrent(connection, entry.epoch) && !entry.controller.signal.aborted;
		try {
			const proof = this._proofs.get(session);
			if (!entry.force && proof?.epoch === entry.epoch && now() < proof.validUntil) {
				const cookies = await this._options.cookies(session, connection.origin);
				if (current() && !entry.force && now() < proof.validUntil
					&& proof.cookies.every(saved => cookies.some(cookie => this._sameCookie(saved, cookie) && this._liveCookie(cookie, now())))) {
					this._emit('cache-hit', now() - started);
					return true;
				}
			}
			this._proofs.delete(session);
			if (!current() || !await this._options.exchange(session, connection, entry.controller.signal) || !current()) {
				return false;
			}
			const cookies = (await this._options.cookies(session, connection.origin))
				.filter(cookie => cookie.name.startsWith('dsh-auth') && this._liveCookie(cookie, now()));
			if (!current() || !cookies.length) {
				return false;
			}
			const completed = now();
			this._proofs.set(session, {
				epoch: entry.epoch,
				validUntil: completed + (this._options.ttlMs ?? 30_000),
				cookies: cookies.map(cookie => ({ ...cookie })),
			});
			this._emit('exchange', completed - started);
			return true;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
			if (timedOut) {
				this._emit('timeout', now() - started);
			} else if (!this._proofs.has(session) && current()) {
				this._emit('failed', now() - started);
			}
		}
	}

	private _liveCookie(cookie: IDshAuthCookie, now: number): boolean {
		return !!cookie.value && (cookie.expirationDate === undefined || cookie.expirationDate * 1_000 > now + 1_000);
	}

	private _sameCookie(a: IDshAuthCookie, b: IDshAuthCookie): boolean {
		return a.name === b.name && a.value === b.value && a.domain === b.domain && a.path === b.path
			&& a.secure === b.secure && a.expirationDate === b.expirationDate;
	}

	private _emit(event: 'cache-hit' | 'exchange' | 'failed' | 'timeout', elapsedMs: number): void {
		try { this._options.onEvent?.(event, elapsedMs); } catch { /* Diagnostics must not change authentication. */ }
	}

	dispose(): void {
		this.setConnection(undefined);
		this._disposed = true;
	}
}
