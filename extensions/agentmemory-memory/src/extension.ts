/*---------------------------------------------------------------------------------------------
 *  AgentMemory — Agent OS capability plugin (third-party extension form).
 *
 *  Capability : memory
 *  Provider ID: agentmemory
 *  Priority   : 90 (above tdb-am-memory=80, SessionMemoryProvider=50)
 *
 *  Bridges saros IMemoryProvider → agentmemory REST API (port 3111).
 *  agentmemory server is started by the main process (startAgentMemoryGateway)
 *  as a child process running `npx @agentmemory/agentmemory`.
 *
 *  Context shape:
 *    saros injects `agentOSService` (or legacy `agentOS`) containing
 *    registerMemoryProvider(provider, priority).
 *--------------------------------------------------------------------------------------------*/

import { AgentMemoryProvider } from './memoryProvider.js';

interface AgentOSLike {
	registerMemoryProvider(provider: unknown, priority?: number): { dispose(): void };
}

interface PluginContext {
	agentOSService?: AgentOSLike;
	agentOS?: AgentOSLike;
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
	private _provider: AgentMemoryProvider | undefined;
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
			this._provider = new AgentMemoryProvider();
			this._registration = agentOS.registerMemoryProvider(this._provider, 90);
			console.log('[AgentMemory] registered (priority=90)');
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
