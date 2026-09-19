/*---------------------------------------------------------------------------------------------
 *  服务器配置 — HTTP KV
 *
 *  agentmemory 通过本地 HTTP KV server 持久化状态。iii-engine WebSocket 主通道已放弃：
 *  iii-sdk 依赖 Node-only 的 `ws` 模块，无法被 esbuild 打进 capability-plugin 的 browser ESM bundle。
 *
 *  ★ 端口隔离（2026-09-16 用户裁决 / 09-19 落地）：
 *    「安装版（~/.vssaros）」与「dev（~/.vssaros-dev）」是两个 app 形态、各有一份数据目录，
 *    端口此前都写死 3111 ⇒ 后启动的一方 `EADDRINUSE` 崩溃，且会**静默复用对方的网关**
 *    （dev 的记忆读写落进生产库）。现规则：**安装版 3111 / dev 3112**。
 *    ⚠ 本文件的端口规则必须与主进程 `CodeApplication._resolveAgentMemoryPort()` **保持一致**；
 *      主进程是唯一真源，两个工程的代码无法共享 ⇒ 改一处必须改另一处。
 *--------------------------------------------------------------------------------------------*/

const DEFAULT_HTTP_URL = 'http://127.0.0.1:3111';
/** dev 形态的默认端口（见文件头「端口隔离」）。 */
const DEV_HTTP_URL = 'http://127.0.0.1:3112';
export const REQUEST_TIMEOUT_MS = 5000;

/** 探测成功后锁定的基址（优先级最高）。 */
let _resolvedBase: string | null = null;

/**
 * 实测探测成功时锁定基址（由 `probeGateway()` 调用）。
 * 这是**最强兜底** —— 即便渲染侧读不到任何环境变量，只要有一个网关在监听，就能用对地址。
 */
export function setResolvedServerBase(url: string): void {
	_resolvedBase = url.replace(/\/+$/, '');
}

/**
 * HTTP KV server 地址。优先级：
 *   ⓪ 实测探测锁定的地址（最强证据）
 *   ① `AGENTMEMORY_URL` —— 主进程注入（`electron-main/app.ts` 的 `_initAgentMemoryEndpoint()`
 *      在**窗口创建前**写 `process.env`，渲染进程继承；读不到时自动落下一级）
 *   ② 按 `VSCODE_DEV` 自行推导（与主进程 `isBuilt` 同源）
 *   ③ 3111（安装版默认）
 */
export function serverBase(): string {
	if (_resolvedBase) return _resolvedBase;
	const env = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env;
	const envUrl = env?.['AGENTMEMORY_URL'];
	if (typeof envUrl === 'string' && envUrl.length > 0) return envUrl.replace(/\/+$/, '');
	if (env?.['VSCODE_DEV']) return DEV_HTTP_URL;
	return DEFAULT_HTTP_URL;
}

/**
 * 候选基址（按可信度排序，已去重）：供探测失败时逐个尝试。
 *
 * ⚠ **显式配置时只返回它自己**：`AGENTMEMORY_URL` 一旦被设置（主进程注入，或测试/用户指定），
 * 说明地址是明确给定的 ⇒ 绝不再去猜别的端口 —— 否则会连到**另一个形态**的网关
 * （dev 窗口连上安装版的库 = 跨环境串味，正是端口隔离要解决的问题）。
 * 只有在「没有任何显式配置」时才用推导值 + 另一个端口兜底。
 */
export function serverBaseCandidates(): string[] {
	const env = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env;
	const explicit = env?.['AGENTMEMORY_URL'];
	if (typeof explicit === 'string' && explicit.length > 0) return [explicit.replace(/\/+$/, '')];
	return [...new Set([serverBase(), DEV_HTTP_URL, DEFAULT_HTTP_URL])];
}

/**
 * 健康检查。
 * @param base 可选基址；缺省用 `serverBase()`（探测场景需要显式传候选地址）。
 */
export async function checkHealth(base?: string): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 3000);
		const resp = await fetch(`${base ?? serverBase()}/health`, { signal: ctrl.signal });
		clearTimeout(timer);
		return resp.ok;
	} catch {
		return false;
	}
}
