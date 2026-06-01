/*---------------------------------------------------------------------------------------------
 *  Memory Example Plugin - Agent Studio Capability Plugin
 *
 *  能力槽：Memory
 *  Provider ID：memory-example
 *  优先级：50（低于生产插件）
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../src/vs/base/common/lifecycle.js';
import { IAgentCapabilityPlugin, IAgentOSPluginContext, AgentCapability } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IAgentOSService } from '../../../src/vs/sessions/contrib/agentStudio/common/agentOS.js';
import { MemoryExampleProvider } from './memoryProvider.js';

export class MemoryExamplePlugin extends Disposable implements IAgentCapabilityPlugin {
	private readonly _provider: MemoryExampleProvider;

	constructor(
		@IAgentOSService private readonly _agentOS: IAgentOSService,
	) {
		super();
		this._provider = this._register(new MemoryExampleProvider());
	}

	async activate(context: IAgentOSPluginContext): Promise<void> {
		console.log('[MemoryExample] Activating memory-example provider...');
		this._agentOS.registerMemoryProvider(this._provider, 50);
		console.log('[MemoryExample] Registered memory-example provider (priority=50)');
	}

	async deactivate(): Promise<void> {
		console.log('[MemoryExample] Deactivating memory-example provider...');
		// OS 会自动移除已注册的 provider
	}
}

// 插件入口
export function activate(pluginContext: IAgentOSPluginContext): IAgentCapabilityPlugin {
	return new MemoryExamplePlugin(
		pluginContext.agentOS as any, // 类型转换，实际由 OS 注入
	);
}
