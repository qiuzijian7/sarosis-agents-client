/*---------------------------------------------------------------------------------------------
 *  服务器配置 — HTTP KV
 *
 *  agentmemory 通过本地 HTTP KV server (AGENTMEMORY_URL，默认 127.0.0.1:3111)
 *  持久化状态。iii-engine WebSocket 主通道已放弃：iii-sdk 依赖 Node-only 的
 *  `ws` 模块，无法被 esbuild 打进 capability-plugin 的 browser ESM bundle。
 *--------------------------------------------------------------------------------------------*/

const DEFAULT_HTTP_URL = 'http://127.0.0.1:3111';
export const REQUEST_TIMEOUT_MS = 5000;

/** HTTP KV server 地址 */
export function serverBase(): string {
	const envUrl = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.['AGENTMEMORY_URL'];
	if (typeof envUrl === 'string' && envUrl.length > 0) return envUrl.replace(/\/+$/, '');
	return DEFAULT_HTTP_URL;
}

/** 健康检查 */
export async function checkHealth(): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 3000);
		const resp = await fetch(`${serverBase()}/health`, { signal: ctrl.signal });
		clearTimeout(timer);
		return resp.ok;
	} catch {
		return false;
	}
}
