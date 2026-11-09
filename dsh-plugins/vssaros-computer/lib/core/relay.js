// 主进程「发现文件 + loopback WebSocket」的 Host 侧客户端（P0）。
//
// 端点由主进程写入 `<runDir>/desktop-control.json`，含每次启动随机的 token。
// 本模块不持有 token 之外的任何凭据；协议是极简 JSON-RPC：
//   → { id, method, params }   ← { id, result } | { id, error: { code, message } }
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ENDPOINT_FILE = 'desktop-control.json';
export const ENDPOINT_PATH = '/desktop-control/vssaros/';
const WS_URL = /^ws:\/\/127\.0\.0\.1:\d+\/desktop-control\/vssaros\/[0-9a-f]{48}$/;

export function defaultEndpointPath() {
	const root = process.env.VSSAROS_DATA_ROOT || join(homedir(), '.vssaros');
	return join(root, 'dsh-run', ENDPOINT_FILE);
}

export function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 校验发现文件：结构、wsUrl 形状、主进程是否还活着。任何一项不过都不连。 */
export function parseEndpoint(text, { isPidAlive = pidAlive } = {}) {
	let value;
	try { value = JSON.parse(text); } catch { return { ok: false, error: '发现文件不是合法 JSON' }; }
	if (!value || value.version !== 1) return { ok: false, error: '发现文件版本不符' };
	if (!Number.isInteger(value.pid) || !isPidAlive(value.pid)) return { ok: false, error: '主进程已不在，忽略陈旧发现文件' };
	if (typeof value.wsUrl !== 'string' || !WS_URL.test(value.wsUrl)) return { ok: false, error: 'wsUrl 形状非法（必须 loopback + token 路径）' };
	return { ok: true, endpoint: value };
}

export function readEndpoint(file = defaultEndpointPath(), options = {}) {
	const read = options.read ?? readFileSync;
	try { return parseEndpoint(read(file, 'utf8'), options); }
	catch (error) { return { ok: false, error: `读不到发现文件：${String(error?.message ?? error)}` }; }
}

/** 供测试注入：不依赖 `ws` 包，也不依赖真机主进程。 */
export class DesktopRelayClient {
	constructor({
		endpointPath = defaultEndpointPath(),
		WebSocketImpl = globalThis.WebSocket,
		isPidAlive = pidAlive,
		timeoutMs = 15_000,
		read = readFileSync,
	} = {}) {
		this.endpointPath = endpointPath;
		this._WebSocketImpl = WebSocketImpl;
		this._isPidAlive = isPidAlive;
		this._timeoutMs = timeoutMs;
		this._read = read;
		this._socket = undefined;
		this._pending = new Map();
		this._seq = 0;
		this._disposed = false;
	}

	async connect() {
		if (this._socket && this._socket.readyState === 1) return;
		if (this._disposed) throw new Error('客户端已释放');
		const found = readEndpoint(this.endpointPath, { read: this._read, isPidAlive: this._isPidAlive });
		if (!found.ok) throw new Error(found.error);
		const Socket = this._WebSocketImpl;
		if (typeof Socket !== 'function') throw new Error('此环境没有 WebSocket 实现');
		const socket = new Socket(found.endpoint.wsUrl);
		this._socket = socket;
		await new Promise((resolve, reject) => {
			const done = (error) => {
				if (error) { this._socket = undefined; reject(error); } else resolve();
			};
			if (typeof socket.addEventListener === 'function') {
				socket.addEventListener('open', () => done(), { once: true });
				socket.addEventListener('error', () => done(new Error('桌面中继连接失败')), { once: true });
			} else {
				socket.onopen = () => done();
				socket.onerror = () => done(new Error('桌面中继连接失败'));
			}
		});
		if (typeof socket.addEventListener === 'function') {
			socket.addEventListener('message', (event) => this._onMessage(event.data));
		} else {
			socket.onmessage = (event) => this._onMessage(event.data);
		}
	}

	async command(method, params = {}) {
		await this.connect();
		if (!this._socket || typeof this._socket.send !== 'function') throw new Error('桌面中继未连接');
		const id = ++this._seq;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`桌面中继 ${method} 超时（${this._timeoutMs}ms）`));
			}, this._timeoutMs);
			this._pending.set(id, { resolve, reject, timer });
			try {
				this._socket.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				clearTimeout(timer);
				this._pending.delete(id);
				reject(error);
			}
		});
	}

	_onMessage(raw) {
		let message;
		try { message = JSON.parse(String(raw)); } catch { return; }
		const pending = this._pending.get(message?.id);
		if (!pending) return;
		this._pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error) {
			const error = new Error(String(message.error.message ?? '桌面中继拒绝该调用'));
			error.code = message.error.code;
			pending.reject(error);
		} else {
			pending.resolve(message.result);
		}
	}

	dispose() {
		this._disposed = true;
		for (const [, pending] of this._pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error('桌面中继客户端已释放'));
		}
		this._pending.clear();
		try { this._socket?.close?.(); } catch { /* closed */ }
		this._socket = undefined;
	}
}

