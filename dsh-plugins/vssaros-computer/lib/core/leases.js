// 应用 / 前台租约（P1）。同一个应用同一时间只给一个 Bot；空闲 60s 自动释放。
// 只读调用不占租约。内存态、进程内，不跨 Host 重启（与 DS Bot 同口径）。
export const LEASE_IDLE_MS = 60_000;

export class LeaseTable {
	constructor({ idleMs = LEASE_IDLE_MS, now = () => Date.now() } = {}) {
		this._idleMs = idleMs;
		this._now = now;
		this._leases = new Map(); // kind -> { owner, at }
	}

	/** @returns { ok:true } | { ok:false, holder } */
	acquire(kind, owner) {
		this.sweep();
		const held = this._leases.get(kind);
		if (held && held.owner !== owner) return { ok: false, holder: held.owner };
		this._leases.set(kind, { owner, at: this._now() });
		return { ok: true };
	}

	touch(kind, owner) {
		const held = this._leases.get(kind);
		if (held?.owner === owner) held.at = this._now();
	}

	release(kind, owner) {
		if (this._leases.get(kind)?.owner === owner) this._leases.delete(kind);
	}

	/** 回合结束 / stop / takeover：放开该 owner 的全部租约。 @returns 放开的数量 */
	releaseOwner(owner) {
		let count = 0;
		for (const [kind, held] of [...this._leases]) {
			if (held.owner === owner) { this._leases.delete(kind); count++; }
		}
		return count;
	}

	sweep() {
		const cutoff = this._now() - this._idleMs;
		for (const [kind, held] of [...this._leases]) {
			if (held.at < cutoff) this._leases.delete(kind);
		}
	}

	clear() { this._leases.clear(); }

	get size() { return this._leases.size; }
}
