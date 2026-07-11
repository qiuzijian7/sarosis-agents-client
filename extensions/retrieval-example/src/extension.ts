/*---------------------------------------------------------------------------------------------
 *  Retrieval Example Plugin
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../src/vs/base/common/lifecycle.js';
import { IAgentCapabilityPlugin, IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IRetrievalProvider, IRetrievalResult } from '../../../src/vs/sessions/contrib/agentStudio/common/providers.js';

export class RetrievalExampleProvider implements IRetrievalProvider {
	readonly id = 'retrieval-example';
	readonly name = 'Retrieval Example';

	async retrieve(query: string, options?: any): Promise<IRetrievalResult[]> {
		// Shell 实现：返回模拟结果
		return [{
			documentId: 'doc-1',
			content: `Retrieved content for: ${query}`,
			score: 0.95
		}];
	}

	async indexDocument(doc: any): Promise<void> {
		console.log('[RetrievalExample] Indexing document:', doc.id);
	}
}

export class RetrievalExamplePlugin extends Disposable implements IAgentCapabilityPlugin {
	private readonly _provider: RetrievalExampleProvider;
	private _agentOS: IAgentOSPluginContext['agentOSService'] | undefined;

	constructor() {
		super();
		this._provider = new RetrievalExampleProvider();
	}

	async activate(context: IAgentOSPluginContext): Promise<void> {
		console.log('[RetrievalExample] Activating...');
		// NOTE: do NOT inject IAgentOSService via constructor DI — plugin is a
		// separate module realm from the host bundle (see other example plugins).
		this._agentOS = context.agentOSService;
		this._agentOS.registerRetrievalProvider(this._provider, 50);
	}

	async deactivate(): Promise<void> {
		console.log('[RetrievalExample] Deactivating...');
	}
}

export function activate(pluginContext: IAgentOSPluginContext): IAgentCapabilityPlugin {
	const plugin = new RetrievalExamplePlugin();
	void plugin.activate(pluginContext);
	return plugin;
}
