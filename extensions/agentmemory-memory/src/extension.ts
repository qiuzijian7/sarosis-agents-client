/*---------------------------------------------------------------------------------------------
 *  AgentMemory — Agent OS capability plugin (third-party extension form).
 *
 *  Capability : memory
 *  Provider ID: agentmemory
 *  Priority   : 1000 (above SessionMemoryProvider=50)
 *
 *  Bridges saros IMemoryProvider → agentmemory REST API (port 3111).
 *  agentmemory server is started by the main process (startAgentMemoryGateway)
 *  as a child process running `npx @agentmemory/agentmemory`.
 *
 *  Context shape:
 *    saros injects `agentOSService` (or legacy `agentOS`) containing
 *    registerMemoryProvider(provider, priority).
 *--------------------------------------------------------------------------------------------*/

import { AgentMemoryProviderProxy } from './agentMemoryProviderProxy.js';

interface AgentOSLike {
	registerMemoryProvider(provider: unknown, priority?: number): { dispose(): void };
}

interface PluginContext {
	agentOSService?: AgentOSLike;
	agentOS?: AgentOSLike;
	/** 宿主注入的日志服务（可选）——存在时记忆运行日志进 VS Code 日志文件 */
	logService?: {
		info?(msg: string): void;
		warn?(msg: string): void;
		error?(msg: string): void;
	};
	[key: string]: unknown;
}

interface RegisteredHandle {
	dispose(): void;
}

function resolveAgentOS(context: PluginContext): AgentOSLike | undefined {
	if (context.agentOSService && typeof context.agentOSService.registerMemoryProvider === 'function') {
		return context.agentOSService;
	}
	if (context.agentOS && typeof context.agentOS.registerMemoryProvider === 'function') {
		return context.agentOS;
	}
	return undefined;
}

export class AgentMemoryPlugin {
	// Opt1: renderer 侧只承载薄代理；真实 Provider 引擎在网关主进程运行。
	private _provider: AgentMemoryProviderProxy | undefined;
	private _registration: RegisteredHandle | undefined;

	async activate(context: PluginContext): Promise<void> {
		try {
			const keys = Object.keys(context ?? {}).join(', ');
			console.log(`[AgentMemory] activate; context keys=[${keys}]`);
		} catch {
			console.log('[AgentMemory] activate; context inspect failed');
		}

		const agentOS = resolveAgentOS(context);
		if (!agentOS) {
			console.error('[AgentMemory] activate failed: cannot find agentOSService in plugin context.');
			return;
		}

		try {
			// R9（2026-09-10）：注入宿主 logService，使记忆运行日志进 VS Code 日志文件
			//（此前全走 console，用户日志里只有激活行、无运行时行，故障不可诊断）。
			this._provider = new AgentMemoryProviderProxy(context.logService);
			this._registration = agentOS.registerMemoryProvider(this._provider, 1000);
			console.log('[AgentMemory] registered (priority=1000)');
			// 启动探活：无论是否有记忆调用，都打一行网关可达性（+ 故障排查指引）
			this._provider.probeGateway();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[AgentMemory] registerMemoryProvider error: ${msg}`);
			this._provider?.dispose();
			this._provider = undefined;
			this._registration = undefined;
		}
	}

	async deactivate(): Promise<void> {
		console.log('[AgentMemory] deactivate');
		try {
			this._registration?.dispose();
		} catch { /* best-effort */ }
		this._provider?.dispose();
		this._registration = undefined;
		this._provider = undefined;
	}
}

export default AgentMemoryPlugin;
