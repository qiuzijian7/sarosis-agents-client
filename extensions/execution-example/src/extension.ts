/*---------------------------------------------------------------------------------------------
 *  Execution Example Plugin
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../src/vs/base/common/lifecycle.js';
import { IAgentCapabilityPlugin, IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IExecutionProvider, IAgentTurnRequest, IChatStreamDelta } from '../../../src/vs/sessions/contrib/agentStudio/common/providers.js';

export class ExecutionExampleProvider implements IExecutionProvider {
	readonly id = 'execution-example';
	readonly name = 'Execution Example';

	async *runAgentLoop(
		request: IAgentTurnRequest,
		slots: any,
	): AsyncIterable<IChatStreamDelta> {
		// Shell 实现：简单回显
		yield {
			type: 'text',
			content: `[Execution] Processing: ${request.messages[request.messages.length - 1]?.content || ''}`
		};
		yield { type: 'done' };
	}
}

export class ExecutionExamplePlugin extends Disposable implements IAgentCapabilityPlugin {
	private readonly _provider: ExecutionExampleProvider;
	private _agentOS: IAgentOSPluginContext['agentOSService'] | undefined;

	constructor() {
		super();
		this._provider = new ExecutionExampleProvider();
	}

	async activate(context: IAgentOSPluginContext): Promise<void> {
		console.log('[ExecutionExample] Activating...');
		// NOTE: do NOT inject IAgentOSService via constructor DI. This plugin is
		// loaded as a separate module realm from the host bundle, so its
		// `IAgentOSService` service-identifier object differs from the one the
		// host registered via registerSingleton — causing createInstance() to
		// fail with "UNKNOWN service agentOSService". The host passes the live
		// service instance through IAgentOSPluginContext.agentOSService instead.
		this._agentOS = context.agentOSService;
		// Only register if no other ExecutionProvider is already registered.
		// This example is a shell/demo that simply echoes the user prompt back;
		// registering it at priority 50 unconditionally would shadow the real
		// ExecutionProvider and cause every task to "complete" with a stub
		// response (see MEMORY 2026-07-11).  When the real provider is present
		// (the common case in production builds), we skip registration entirely.
		const active = this._agentOS.getActiveExecutionProvider();
		if (active) {
			console.log(`[ExecutionExample] Skipping registration — active ExecutionProvider already present: ${active.id}`);
			return;
		}
		this._agentOS.registerExecutionProvider(this._provider, 50);
		console.log('[ExecutionExample] Registered shell ExecutionProvider at priority=50 (no other provider present)');
	}

	async deactivate(): Promise<void> {
		console.log('[ExecutionExample] Deactivating...');
	}
}

export function activate(pluginContext: IAgentOSPluginContext): IAgentCapabilityPlugin {
	const plugin = new ExecutionExamplePlugin();
	void plugin.activate(pluginContext);
	return plugin;
}
