/*---------------------------------------------------------------------------------------------
 *  Tool Example Plugin - Agent Studio Capability Plugin
 *
 *  能力槽：Tool
 *  Provider ID：tool-example
 *  优先级：50
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../src/vs/base/common/lifecycle.js';
import { IAgentCapabilityPlugin, IAgentOSPluginContext, AgentCapability } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { ToolExampleProvider } from './toolProvider.js';

export class ToolExamplePlugin extends Disposable implements IAgentCapabilityPlugin {
	private readonly _provider: ToolExampleProvider;
	private _agentOS: IAgentOSPluginContext['agentOSService'] | undefined;

	constructor() {
		super();
		this._provider = this._register(new ToolExampleProvider());
	}

	async activate(context: IAgentOSPluginContext): Promise<void> {
		console.log('[ToolExample] Activating tool-example provider...');
		// NOTE: do NOT inject IAgentOSService via constructor DI — this plugin is
		// loaded as a separate module realm from the host bundle, so its
		// service-identifier object differs from the one registered via
		// registerSingleton, causing "UNKNOWN service agentOSService".
		// Obtain the live service through context.agentOSService instead.
		this._agentOS = context.agentOSService;
		this._agentOS.registerToolProvider(this._provider, 50);
		console.log('[ToolExample] Registered tool-example provider (priority=50)');
	}

	async deactivate(): Promise<void> {
		console.log('[ToolExample] Deactivating tool-example provider...');
	}
}

export function activate(pluginContext: IAgentOSPluginContext): IAgentCapabilityPlugin {
	const plugin = new ToolExamplePlugin();
	void plugin.activate(pluginContext);
	return plugin;
}
