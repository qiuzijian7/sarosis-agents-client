/*---------------------------------------------------------------------------------------------
 *  StateKV — HTTP KV client
 *
 *  KV 存储通过本地 HTTP 服务（默认 127.0.0.1:3111，可用 AGENTMEMORY_URL 覆盖）。
 *
 *  说明：之前尝试引入 iii-sdk WebSocket 主通道，但 iii-sdk 依赖 Node-only 的
 *  `ws` 模块以及 `child_process`，无法被 esbuild 打进 browser ESM bundle。
 *  该扩展经由 capability-plugin 路径以 ESM 加载，故任何顶层引用 iii-sdk 的
 *  代码都会导致 primary bundle 失败并触发退化 CJS 加载路径（与 ESM import()
 *  不兼容）。因此本文件回到纯 HTTP 实现；iii-engine 的存储集成留待 worker
 *  进程侧另行接入。
 *
 *  接口不变（get/set/delete/list/listKeys），调用方无需修改。
 *--------------------------------------------------------------------------------------------*/

import { serverBase, REQUEST_TIMEOUT_MS } from './serverConfig.js';

export class StateKV {
	private _baseUrl: string;

	constructor(engineUrl?: string) {
		// 仅接受 http(s):// URL；其它 URL（如残留的 ws://）静默回退到默认 KV server。
		if (engineUrl && /^https?:\/\//.test(engineUrl)) {
			this._baseUrl = engineUrl.replace(/\/+$/, '');
		} else {
			this._baseUrl = serverBase();
		}
	}

	/** 兼容旧调用（HTTP 模式下无长连接需要初始化） */
	async ensureConnected(): Promise<void> { /* noop */ }

	// ─── Public API ─────────────────────────────────────────────────────────

	async get<T = unknown>(scope: string, key: string): Promise<T | null> {
		const url = `${this._baseUrl}/kv/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
		try {
			const resp = await fetch(url, { signal: ctrl.signal });
			if (!resp.ok) return null;
			const text = await resp.text();
			return (text === 'null' || text === '') ? null : JSON.parse(text) as T;
		} catch { return null; }
		finally { clearTimeout(timer); }
	}

	async set<T = unknown>(scope: string, key: string, value: T): Promise<void> {
		const url = `${this._baseUrl}/kv/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
		try {
			await fetch(url, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(value),
				signal: ctrl.signal,
			});
		} finally { clearTimeout(timer); }
	}

	async delete(scope: string, key: string): Promise<void> {
		const url = `${this._baseUrl}/kv/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
		try { await fetch(url, { method: 'DELETE', signal: ctrl.signal }); }
		finally { clearTimeout(timer); }
	}

	async list<T = unknown>(scope: string): Promise<T[]> {
		const url = `${this._baseUrl}/kv/${encodeURIComponent(scope)}?values=true`;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
		try {
			const resp = await fetch(url, { signal: ctrl.signal });
			if (!resp.ok) return [];
			const obj = await resp.json() as Record<string, string>;
			const results: T[] = [];
			for (const val of Object.values(obj)) {
				try { results.push(JSON.parse(val) as T); } catch {}
			}
			return results;
		} catch { return []; }
		finally { clearTimeout(timer); }
	}

	async listKeys(scope: string): Promise<string[]> {
		const url = `${this._baseUrl}/kv/${encodeURIComponent(scope)}`;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
		try {
			const resp = await fetch(url, { signal: ctrl.signal });
			if (!resp.ok) return [];
			const data = await resp.json();
			return Array.isArray(data) ? data : [];
		} catch { return []; }
		finally { clearTimeout(timer); }
	}

	/** 列出以 prefix 开头的所有 scope（用于跨 agent 枚举，Opt1 进程内 / 网关 /scopes） */
	async listScopes(prefix: string): Promise<string[]> {
		const url = `${this._baseUrl}/scopes?prefix=${encodeURIComponent(prefix)}`;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
		try {
			const resp = await fetch(url, { signal: ctrl.signal });
			if (!resp.ok) return [];
			const data = await resp.json();
			return Array.isArray(data) ? data : [];
		} catch { return []; }
		finally { clearTimeout(timer); }
	}

	async clearScope(scope: string): Promise<void> {
		const keys = await this.listKeys(scope);
		await Promise.all(keys.map(k => this.delete(scope, k)));
	}

	dispose(): void { /* noop */ }
}
