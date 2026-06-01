/*---------------------------------------------------------------------------------------------
 *  Tool Example Plugin - Agent Studio Capability Plugin
 *
 *  能力槽：Tool
 *  Provider ID：tool-example
 *  优先级：50
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../src/vs/base/common/lifecycle.js';
import { IAgentCapabilityPlugin, IAgentOSPluginContext, AgentCapability } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IAgentOSService } from '../../../src/vs/sessions/contrib/agentStudio/common/agentOS.js';
import { ToolExampleProvider } from './toolProvider.js';

export class ToolExamplePlugin extends Disposable implements IAgentCapabilityPlugin {
	private readonly _provider: ToolExampleProvider;

	constructor(
		@IAgentOSService private readonly _agentOS: IAgentOSService,
	) {
		super();
		this._provider = this._register(new ToolExampleProvider());
	}

	async activate(context: IAgentOSPluginContext): Promise<void> {
		console.log('[ToolExample] Activating tool-example provider...');
		this._agentOS.registerToolProvider(this._provider, 50);
		console.log('[ToolExample] Registered tool-example provider (priority=50)');
	}

	async deactivate(): Promise<void> {
		console.log('[ToolExample] Deactivating tool-example provider...');
	}
}

export function activate(pluginContext: IAgentOSPluginContext): IAgentCapabilityPlugin {
	return new ToolExamplePlugin(
		pluginContext.agentOS as any,
	);
}
