/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../src/vs/base/common/event.js';
import { IModelProvider, IModelInfo, ModelAuthStatus, IModelOptions, IModelDelta, IChatMessage } from '../../../src/vs/sessions/contrib/agentStudio/common/providers.js';
import { BaseProviderAdapter } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';

/**
 * Knot AG-UI Model Provider
 * 
 * 实现 IModelProvider 接口，将 Knot AG-UI 远程 Agent 作为模型提供者。
 * 每个 Knot Agent 对应一个"模型"，用户可在模型选择器中切换。
 */

interface KnotModelProviderOptions {
	token: string;
	endpoint: string;
	defaultAgent: string;
	configurationService: any; // IConfigurationService
	logService: any; // ILogService
}

export class KnotAGUIModelProvider extends BaseProviderAdapter<any> implements IModelProvider {
	readonly id = 'knot-agui';
	readonly name = 'Knot AG-UI';
	readonly priority = 100; // 高优先级 → 默认选中
	readonly icon?: any; // TODO: 添加 Knot 图标 URI

	private readonly _onDidChangeModels = new Event<void>();
	readonly onDidChangeModels = this._onDidChangeModels.event;

	private readonly _onDidChangeAuthStatus = new Event<ModelAuthStatus>();
	readonly onDidChangeAuthStatus = this._onDidChangeAuthStatus.event;

	private _authStatus: ModelAuthStatus = ModelAuthStatus.NotConfigured;
	private _agents: IModelInfo[] = [];
	private _client: any = null;

	constructor(private readonly _options: KnotModelProviderOptions) {
		super('knot-agui', {
			extensionPath: '',
			globalStoragePath: '',
			workspaceStoragePath: '',
			configurationService: _options.configurationService,
			logService: _options.logService,
			notificationService: console as any,
			instantiationService: null as any,
			agentOSService: null as any,
		});
		this._validateAndLoadModels();
	}

	getAuthStatus(): ModelAuthStatus {
		return this._authStatus;
	}

	async listModels(): Promise<IModelInfo[]> {
		if (this._authStatus !== ModelAuthStatus.Authenticated) {
			return [];
		}
		return this._agents;
	}

	async chat(modelId: string, messages: IChatMessage[], options: IModelOptions): AsyncIterable<IModelDelta> {
		// modelId = agentId in Knot context
		const agentId = modelId;
		const client = await this._getAGUIClient();
		return client.streamRun(agentId, {
			messages: this._convertMessages(messages),
			...options,
		});
	}

	async reloadConfiguration(): Promise<void> {
		await this._validateAndLoadModels();
	}

	// ─── 内部方法 ─────────────────────────────────────────

	protected async connectNativeAPI(): Promise<any> {
		// Knot 使用 HTTP API，无需持久连接
		// 返回一个轻量客户端对象
		return {
			streamRun: (agentId: string, opts: any) => this._createStreamGenerator(agentId, opts),
		};
	}

	private async _validateAndLoadModels(): Promise<void> {
		const token = this._options.configurationService.getValue<string>('knot.auth.token');
		if (!token) {
			this._authStatus = ModelAuthStatus.NotConfigured;
			this._onDidChangeAuthStatus.fire(this._authStatus);
			return;
		}

		this._authStatus = ModelAuthStatus.Validating;
		this._onDidChangeAuthStatus.fire(this._authStatus);

		try {
			const agents = await this._fetchAvailableAgents(token);
			this._agents = agents.map(agent => ({
				id: agent.id,
				name: agent.name,
				description: agent.description,
				contextWindow: agent.contextWindow,
				capabilities: agent.capabilities,
			}));
			this._authStatus = ModelAuthStatus.Authenticated;
			this._onDidChangeModels.fire();
		} catch (err) {
			this._authStatus = ModelAuthStatus.Failed;
			this._logService.error('[Knot-AGUI] Failed to load agents:', err);
		}
		this._onDidChangeAuthStatus.fire(this._authStatus);
	}

	private async _fetchAvailableAgents(token: string): Promise<any[]> {
		const endpoint = this._options.endpoint || 'https://knot.woa.com/api/v1';
		const response = await fetch(`${endpoint}/agents`, {
			headers: {
				'Authorization': `Bearer ${token}`,
			},
		});
		if (!response.ok) throw new Error(`Failed to fetch agents: ${response.status}`);
		const data = await response.json();
		return data.agents || [];
	}

	private async *_createStreamGenerator(agentId: string, opts: any): AsyncGenerator<IModelDelta> {
		const token = this._options.configurationService.getValue<string>('knot.auth.token');
		const endpoint = this._options.endpoint || 'https://knot.woa.com/api/v1';
		const url = `${endpoint}/agents/${agentId}/chat`;

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${token}`,
			},
			body: JSON.stringify({
				message: opts.messages?.[opts.messages.length - 1]?.content || '',
				model: opts.model,
				systemPrompt: opts.systemPrompt,
				temperature: opts.temperature,
				stream: true,
			}),
		});

		if (!response.ok) {
			yield { type: 'error', content: `Knot API error: ${response.status} ${response.statusText}` };
			return;
		}

		const reader = response.body?.getReader();
		if (!reader) {
			yield { type: 'error', content: 'No response body' };
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';
		const pushDelta: IModelDelta[] = [];
		let flushTimer: ReturnType<typeof setInterval> | undefined;

		const flush = () => {
			for (const delta of pushDelta) {
				yield delta;
			}
			pushDelta.length = 0;
		};

		flushTimer = setInterval(flush, 16);

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6).trim();
					if (data === '[DONE]') continue;
					try {
						const event = JSON.parse(data);
						const normalized = (event.type || event.event_type || '').toUpperCase().replace(/([A-Z])/g, '_$1').replace(/^_/, '').replace(/__/g, '_');
						const content = (event.content || event.text || event.delta || '') as string;
						switch (normalized) {
							case 'TEXT_MESSAGE_START':
							case 'TEXT_MESSAGE_CONTENT':
								if (content) pushDelta.push({ type: 'text', content });
								break;
							case 'THINKING_TEXT_MESSAGE_START':
							case 'THINKING_TEXT_MESSAGE_CONTENT':
								if (content) pushDelta.push({ type: 'thinking', content });
								break;
							case 'TOOL_CALL_START':
								pushDelta.push({ type: 'tool_call', toolCall: { id: event.tool_call_id || event.id, name: event.tool_name || event.name, arguments: '' } });
								break;
							case 'TOOL_CALL_ARGS':
								pushDelta.push({ type: 'tool_call', toolCall: { id: event.tool_call_id || event.id, name: '', arguments: content } });
								break;
							case 'TOOL_CALL_END':
								break;
							case 'TOOL_CALL_RESULT':
								pushDelta.push({ type: 'done' });
								break;
							case 'RUN_ERROR':
								pushDelta.push({ type: 'error', content: event.error || 'Unknown error' });
								break;
						}
					} catch {
						// Skip malformed JSON
					}
				}
			}
		} finally {
			if (flushTimer) clearInterval(flushTimer);
			flush();
			yield { type: 'done' };
		}
	}

	private _convertMessages(messages: IChatMessage[]): any[] {
		return messages.map(m => ({
			role: m.role,
			content: m.content,
		}));
	}
}
