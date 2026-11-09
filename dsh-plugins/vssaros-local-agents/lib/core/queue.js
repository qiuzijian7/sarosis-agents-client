// 驱动 → adapter 的事件队列（P1）。
//
// 为什么需要：ACP 的一轮 prompt 会跨多次 `stream()` 调用 —— 第一次发文本后遇到
// tools/call 就 `finish(tool-calls)` 返回，dsh loop 执行工具后再调 `stream()`，
// 此时 CLI 还在同一轮里继续说话。事件必须留在 live 上，不能随单次 stream 销毁。
export class EventQueue {
	constructor() {
		this._items = [];
		this._waiters = [];
		this._closed = false;
	}

	push(event) {
		if (this._closed) return;
		const waiter = this._waiters.shift();
		if (waiter) waiter.resolve({ done: false, value: event });
		else this._items.push(event);
	}

	close() {
		this._closed = true;
		for (const waiter of this._waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
	}

	get size() { return this._items.length; }

	/** 与 AbortSignal 协作的等待：abort 时返回 { done:true }，不会挂住回合。 */
	wait(signal) {
		if (signal?.aborted) return Promise.resolve({ done: true, value: undefined });
		if (this._items.length) return Promise.resolve({ done: false, value: this._items.shift() });
		if (this._closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve) => {
			const waiter = { resolve };
			this._waiters.push(waiter);
			const onAbort = () => {
				const at = this._waiters.indexOf(waiter);
				if (at >= 0) this._waiters.splice(at, 1);
				signal?.removeEventListener?.('abort', onAbort);
				resolve({ done: true, value: undefined });
			};
			signal?.addEventListener?.('abort', onAbort, { once: true });
		});
	}

	[Symbol.asyncIterator]() {
		return {
			next: (signal) => this.wait(signal),
			[Symbol.asyncIterator]() { return this; },
		};
	}
}
