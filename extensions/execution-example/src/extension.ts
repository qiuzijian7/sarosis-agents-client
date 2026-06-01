/*---------------------------------------------------------------------------------------------
 *  Execution Example Plugin
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../src/vs/base/common/lifecycle.js';
import { IAgentCapabilityPlugin, IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IAgentOSService } from '../../../src/vs/sessions/contrib/agentStudio/common/agentOS.js';
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

	constructor(
		@IAgentOSService private readonly _agentOS: IAgentOSService,
	) {
		super();
		this._provider = new ExecutionExampleProvider();
	}

	async activate(context: IAgentOSPluginContext): Promise<void> {
		console.log('[ExecutionExample] Activating...');
		this._agentOS.registerExecutionProvider(this._provider, 50);
	}

	async deactivate(): Promise<void> {
		console.log('[ExecutionExample] Deactivating...');
	}
}

export function activate(pluginContext: IAgentOSPluginContext): IAgentCapabilityPlugin {
	return new ExecutionExamplePlugin(pluginContext.agentOS as any);
}
