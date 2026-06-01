/*---------------------------------------------------------------------------------------------
 *  Retrieval Example Plugin
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../src/vs/base/common/lifecycle.js';
import { IAgentCapabilityPlugin, IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IAgentOSService } from '../../../src/vs/sessions/contrib/agentStudio/common/agentOS.js';
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

	constructor(
		@IAgentOSService private readonly _agentOS: IAgentOSService,
	) {
		super();
		this._provider = new RetrievalExampleProvider();
	}

	async activate(context: IAgentOSPluginContext): Promise<void> {
		console.log('[RetrievalExample] Activating...');
		this._agentOS.registerRetrievalProvider(this._provider, 50);
	}

	async deactivate(): Promise<void> {
		console.log('[RetrievalExample] Deactivating...');
	}
}

export function activate(pluginContext: IAgentOSPluginContext): IAgentCapabilityPlugin {
	return new RetrievalExamplePlugin(pluginContext.agentOS as any);
}
