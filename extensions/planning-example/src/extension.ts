/*---------------------------------------------------------------------------------------------
 *  Planning Example Plugin
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../src/vs/base/common/lifecycle.js';
import { IAgentCapabilityPlugin, IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IPlanningProvider, IPlan, IPlanStep, ITask } from '../../../src/vs/sessions/contrib/agentStudio/common/providers.js';

export class PlanningExampleProvider implements IPlanningProvider {
	readonly id = 'planning-example';
	readonly name = 'Planning Example';

	async analyzeIntent(message: string, context: any): Promise<IPlan> {
		return {
			id: `plan-${Date.now()}`,
			intent: message,
			steps: [{ id: 'step-1', description: 'Analyze intent' }],
			estimatedComplexity: 'low'
		};
	}

	async composeTasks(plan: IPlan): Promise<ITask[]> {
		return plan.steps.map(step => ({
			id: step.id,
			description: step.description,
			status: 'pending'
		}));
	}
}

export class PlanningExamplePlugin extends Disposable implements IAgentCapabilityPlugin {
	private readonly _provider: PlanningExampleProvider;
	private _agentOS: IAgentOSPluginContext['agentOSService'] | undefined;

	constructor() {
		super();
		this._provider = new PlanningExampleProvider();
	}

	async activate(context: IAgentOSPluginContext): Promise<void> {
		console.log('[PlanningExample] Activating...');
		// NOTE: do NOT inject IAgentOSService via constructor DI — plugin is a
		// separate module realm from the host bundle (see other example plugins).
		this._agentOS = context.agentOSService;
		this._agentOS.registerPlanningProvider(this._provider, 50);
	}

	async deactivate(): Promise<void> {
		console.log('[PlanningExample] Deactivating...');
	}
}

export function activate(pluginContext: IAgentOSPluginContext): IAgentCapabilityPlugin {
	const plugin = new PlanningExamplePlugin();
	void plugin.activate(pluginContext);
	return plugin;
}
