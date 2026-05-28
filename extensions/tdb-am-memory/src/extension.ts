/*---------------------------------------------------------------------------------------------
 *  TDB-AM Memory — Agent OS capability plugin (third-party extension form).
 *
 *  Capability : memory
 *  Provider ID: tdb-am-memory
 *  Priority   : 80 (above memory-example=50)
 *
 *  Loaded by sarosis at runtime via `import(mainModule)` then locating an
 *  exported class whose name ends with "Plugin". We avoid importing any
 *  sarosis internal source path so that this extension stays a clean,
 *  marketplace-installable artifact. All host APIs are accessed via duck
 *  typing on the injected pluginContext.
 *
 *  Context shape：
 *    sarosis 当前注入的 plugin context 字段名为 `agentOSService`（见
 *    src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts
 *    的 `_createPluginContext`）。早期版本曾使用 `agentOS`，因此保留向下兼容。
 *--------------------------------------------------------------------------------------------*/

import { TdbAmMemoryProvider } from './memoryProvider.js';

interface AgentOSLike {
	registerMemoryProvider(provider: unknown, priority?: number): { dispose(): void };
}

interface PluginContext {
	// 当前字段名（sarosis ≥ 2026/05 的 _createPluginContext 实现）
	agentOSService?: AgentOSLike;
	// 旧字段名 / 兼容
	agentOS?: AgentOSLike;
	// 透传字段（不强制类型）
	[key: string]: unknown;
}

interface RegisteredHandle {
	dispose(): void;
}

/** 从 plugin context 安全解析 agentOS 服务，兼容多种字段名。 */
function resolveAgentOS(context: PluginContext): AgentOSLike | undefined {
	if (context.agentOSService && typeof context.agentOSService.registerMemoryProvider === 'function') {
		return context.agentOSService;
	}
	if (context.agentOS && typeof context.agentOS.registerMemoryProvider === 'function') {
		return context.agentOS;
	}
	return undefined;
}

export class TdbAmMemoryPlugin {
	private _provider: TdbAmMemoryProvider | undefined;
	private _registration: RegisteredHandle | undefined;

	async activate(context: PluginContext): Promise<void> {
		// 启动诊断：把 context 里的字段全部打出来，方便定位 sarosis 接口变化。
		try {
			const keys = Object.keys(context ?? {}).join(', ');
			console.log(`[TdbAmMemory] activate; context keys=[${keys}]`);
		} catch {
			console.log('[TdbAmMemory] activate; context inspect failed');
		}

		const agentOS = resolveAgentOS(context);
		if (!agentOS) {
			console.error('[TdbAmMemory] ❌ activate 失败：plugin context 中找不到 agentOSService 也找不到 agentOS（含 registerMemoryProvider 方法的对象）。'
				+ ' 这意味着 sarosis 注入的 context 字段名再次变化，需要更新 resolveAgentOS()。');
			return;
		}

		try {
			this._provider = new TdbAmMemoryProvider();
			this._registration = agentOS.registerMemoryProvider(this._provider, 80);
			console.log('[TdbAmMemory] ✅ registered (priority=80)');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[TdbAmMemory] ❌ registerMemoryProvider 抛错: ${msg}`);
			// 清理半成品状态，避免 deactivate 时再次抛错
			this._provider?.dispose();
			this._provider = undefined;
			this._registration = undefined;
		}
	}

	async deactivate(): Promise<void> {
		console.log('[TdbAmMemory] deactivate');
		try {
			this._registration?.dispose();
		} catch {
			// best-effort
		}
		this._provider?.dispose();
		this._registration = undefined;
		this._provider = undefined;
	}
}

// Optional default export — sarosis loader looks for either a *Plugin class
// or a default export.
export default TdbAmMemoryPlugin;
