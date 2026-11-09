// 换行分隔 JSON-RPC 2.0 peer（P1）。
//
// 用于 ACP CLI 的 stdio：每行一个 JSON。三类入站消息：
//   · 带 id + result/error → 我方请求的应答
//   · 带 id + method      → CLI 的反向请求（session/request_permission）
//   · 带 method 无 id     → 通知（session/update）
// 零依赖；sendLine 由驱动接到 child.stdin，便于测试用内存双工替身。
import { EventQueue } from './queue.js';

export class JsonRpcPeer {
	constructor({ sendLine, onNotification, onRequest, timeoutMs = 120_000 } = {}) {
		this._sendLine = sendLine ?? (() => {});
		this._onNotification = onNotification ?? (() => {});
		this._onRequest = onRequest ?? (async () => { throw new Error('unsupported server request'); });
		this._timeoutMs = timeoutMs;
		this._seq = 0;
		this._pending = new Map();
		this.events = new EventQueue();
	}

	/** 处理 CLI 输出的一行。坏行静默跳过（CLI 常在首行打非 JSON 提示）。 */
	handleLine(line) {
		const text = typeof line === 'string' ? line.trim() : '';
		if (!text || text[0] !== '{') return;
		let message;
		try { message = JSON.parse(text); } catch { return; }
		if (!message || typeof message !== 'object') return;

		const hasId = message.id !== undefined && message.id !== null;
		const isResponse = hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'));
		if (isResponse) {
			const pending = this._pending.get(message.id);
			if (!pending) return;
			this._pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) {
				const error = new Error(String(message.error.message ?? 'JSON-RPC error'));
				error.code = message.error.code;
				pending.reject(error);
			} else {
				pending.resolve(message.result);
			}
			return;
		}
		if (hasId && typeof message.method === 'string') {
			void this._answerRequest(message);
			return;
		}
		if (typeof message.method === 'string') {
			try { this._onNotification(message.method, message.params ?? {}); }
			catch { /* 一个坏通知不该打死整轮 */ }
		}
	}

	async _answerRequest(message) {
		try {
			const result = await this._onRequest(message.method, message.params ?? {});
			this._sendLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result ?? {} }));
		} catch (error) {
			this._sendLine(JSON.stringify({
				jsonrpc: '2.0', id: message.id,
				error: { code: -32603, message: String(error?.message ?? error) },
			}));
		}
	}

	/** @param timeout 0 = 不设超时（整轮 prompt 用）。 */
	request(method, params, { timeout, signal } = {}) {
		const id = ++this._seq;
		const wait = timeout === undefined ? this._timeoutMs : timeout;
		return new Promise((resolve, reject) => {
			let timer;
			if (wait > 0) {
				timer = setTimeout(() => {
					this._pending.delete(id);
					reject(new Error(`JSON-RPC ${method} 超时（${wait}ms）`));
				}, wait);
			}
			const settle = (error) => {
				if (!this._pending.has(id)) return;
				this._pending.delete(id);
				clearTimeout(timer);
				signal?.removeEventListener?.('abort', onAbort);
				if (error) reject(error);
			};
			const onAbort = () => settle(new Error(`JSON-RPC ${method} 已取消`));
			this._pending.set(id, {
				timer,
				resolve: (value) => { settle(); resolve(value); },
				reject: (error) => { settle(); reject(error); },
			});
			signal?.addEventListener?.('abort', onAbort, { once: true });
			try {
				this._sendLine(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
			} catch (error) {
				settle();
				reject(error);
			}
		});
	}

	notify(method, params) {
		this._sendLine(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }));
	}

	/** 进程退出 / abort：所有在途请求以错误结算，事件队列收尾。 */
	failAll(error) {
		for (const [, pending] of this._pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this._pending.clear();
		this.events.close();
	}
}
