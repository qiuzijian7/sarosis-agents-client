/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../src/vs/base/common/event.js';
import { Disposable } from '../../../src/vs/base/common/lifecycle.js';
import {
	IModelProvider, IModelInfo, IModelAgentInfo, ModelAuthStatus,
	IModelOptions, IModelDelta, IChatMessage, IChatContext,
	ModelCapability
} from '../../../src/vs/sessions/contrib/agentStudio/common/providers.js';
import { BaseProviderAdapter } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { HermesBridge } from './hermesBridge.js';

/**
 * Hermes Model Provider
 *
 * Bridges hermes-agent's 28+ model providers to the IModelProvider interface.
 * Each hermes provider (anthropic, openrouter, gemini, etc.) maps to a "model group",
 * and each model within a provider is an IModelInfo entry.
 *
 * The provider list is discovered by querying the hermes-agent bridge process,
 * which scans its plugin directory and environment variables.
 */

const HERMES_CONFIG_PREFIX = 'sessions.agentStudio.hermes';

export class HermesModelProvider extends BaseProviderAdapter<HermesBridge> implements IModelProvider {
	readonly id = 'hermes-agent';
	readonly name = 'Hermes Agent';
	readonly priority = 50;
	readonly supportsAgents = true; // Hermes has sub-agent support via delegate_task
	readonly settingsSearchQuery = HERMES_CONFIG_PREFIX;

	private readonly _onDidChangeModels = new Emitter<void>();
	readonly onDidChangeModels = this._onDidChangeModels.event;

	private readonly _onDidChangeAuthStatus = new Emitter<ModelAuthStatus>();
	readonly onDidChangeAuthStatus = this._onDidChangeAuthStatus.event;

	private readonly _onDidChangeAgents = new Emitter<void>();
	readonly onDidChangeAgents = this._onDidChangeAgents.event;

	private _authStatus: ModelAuthStatus = ModelAuthStatus.NotConfigured;
	private _models: IModelInfo[] = [];
	private _agents: IModelAgentInfo[] = [];
	private _bridge: HermesBridge | undefined;

	constructor(context: IAgentOSPluginContext) {
		super('hermes-agent', context);
	}

	// ─── IModelProvider ────────────────────────────────────────

	getAuthStatus(): ModelAuthStatus {
		return this._authStatus;
	}

	async listModels(): Promise<IModelInfo[]> {
		if (this._authStatus !== ModelAuthStatus.Authenticated) {
			return [];
		}
		return this._models;
	}

	async listAgents(): Promise<IModelAgentInfo[]> {
		if (this._authStatus !== ModelAuthStatus.Authenticated) {
			return [];
		}
		return this._agents;
	}

	async *chat(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): AsyncIterable<IModelDelta> {
		const bridge = await this.ensureConnected();

		// Convert messages to hermes format
		const hermesMessages = messages.map(m => ({
			role: m.role,
			content: m.content,
			...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
			...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
		}));

		// Use context to determine provider/agent
		const provider = context?.['provider'] as string | undefined;
		const sessionId = context?.sessionId;

		// Stream from hermes bridge
		const stream = bridge.streamChat({
			messages: hermesMessages,
			provider,
			model: modelId,
			systemPrompt: options.systemPrompt,
			temperature: options.temperature,
			maxTokens: options.maxTokens,
			sessionId,
		});

		for await (const event of stream) {
			switch (event.method) {
				case 'chat.delta': {
					const deltaType = event.params?.['deltaType'] as string;
					const content = event.params?.['content'] as string;
					if (deltaType === 'text' && content) {
						yield { type: 'text', content };
					} else if (deltaType === 'thinking' && content) {
						yield { type: 'thinking', content };
					}
					break;
				}
				case 'chat.tool_start': {
					yield {
						type: 'tool_call',
						toolCall: {
							id: event.params?.['toolCallId'] as string,
							name: event.params?.['toolName'] as string,
							arguments: '',
						},
					};
					break;
				}
				case 'chat.tool_args': {
					yield {
						type: 'tool_call',
						toolCall: {
							id: event.params?.['toolCallId'] as string,
							name: '',
							arguments: event.params?.['args'] as string,
						},
					};
					break;
				}
				case 'chat.done': {
					yield { type: 'done' };
					return;
				}
				case 'chat.error': {
					yield { type: 'error', content: event.params?.['error'] as string };
					return;
				}
			}
		}
	}

	// ─── BaseProviderAdapter ───────────────────────────────────

	protected async connectNativeAPI(): Promise<HermesBridge> {
		const config = this._readConfig();
		const bridge = new HermesBridge(config);
		this._bridge = bridge;

		await bridge.start();
		await this._refreshModels();

		return bridge;
	}

	override dispose(): void {
		this._bridge?.stop();
		this._bridge = undefined;
		super.dispose();
	}

	// ─── Public API ────────────────────────────────────────────

	async reloadConfiguration(): Promise<void> {
		if (this._bridge) {
			const config = this._readConfig();
			this._bridge.updateConfig(config);
			await this._bridge.restart();
			await this._refreshModels();
		} else {
			await this.ensureConnected();
		}
	}

	// ─── Internal ──────────────────────────────────────────────

	private _readConfig() {
		const config = this._context.configurationService;
		return {
			pythonPath: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.pythonPath`) || 'python3',
			hermesSourcePath: HermesBridge.resolveHermesSourcePath({
				hermesSourcePath: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.hermesSourcePath`) || '',
			}),
			hermesHome: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.hermesHome`) || '',
			provider: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.provider`) || '',
			model: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.model`) || '',
			apiKey: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.apiKey`) || '',
			baseUrl: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.baseUrl`) || '',
			enabledToolsets: config.getValue<string[]>(`${HERMES_CONFIG_PREFIX}.enabledToolsets`) || [],
			disabledToolsets: config.getValue<string[]>(`${HERMES_CONFIG_PREFIX}.disabledToolsets`) || [],
			maxIterations: config.getValue<number>(`${HERMES_CONFIG_PREFIX}.maxIterations`) || 90,
			memoryProvider: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.memoryProvider`) || '',
			timeout: config.getValue<number>('hermes.timeout') || 300000,
			streaming: config.getValue<boolean>('hermes.streaming') ?? true,
		};
	}

	private async _refreshModels(): Promise<void> {
		if (!this._bridge?.isRunning) {
			this._authStatus = ModelAuthStatus.NotConfigured;
			this._onDidChangeAuthStatus.fire(this._authStatus);
			return;
		}

		this._authStatus = ModelAuthStatus.Validating;
		this._onDidChangeAuthStatus.fire(this._authStatus);

		try {
			// Query hermes-agent for available providers and models
			const providers = await this._bridge.request('list_providers') as Array<{
				name: string;
				models: Array<{ id: string; name: string; context_window?: number }>;
			}>;

			this._models = [];
			this._agents = [];

			for (const provider of providers) {
				// Each provider is also an "agent group" in Hermes terminology
				const agentInfo: IModelAgentInfo = {
					id: provider.name,
					name: this._providerDisplayName(provider.name),
					description: `Hermes ${this._providerDisplayName(provider.name)} models`,
					models: provider.models.map(m => m.id),
				};
				this._agents.push(agentInfo);

				// Each model is an IModelInfo
				for (const model of provider.models) {
					this._models.push({
						id: model.id,
						name: model.name || model.id,
						description: `${this._providerDisplayName(provider.name)} — ${model.id}`,
						contextWindow: model.context_window,
						capabilities: [
							ModelCapability.Chat,
							ModelCapability.FunctionCalling,
						],
					});
				}
			}

			this._authStatus = ModelAuthStatus.Authenticated;
		} catch (err) {
			this._logService.error('[Hermes] Failed to refresh models:', err);
			this._authStatus = ModelAuthStatus.Failed;
		}

		this._onDidChangeAuthStatus.fire(this._authStatus);
		this._onDidChangeModels.fire();
		this._onDidChangeAgents.fire();
	}

	private _providerDisplayName(name: string): string {
		const displayNames: Record<string, string> = {
			anthropic: 'Anthropic Claude',
			openrouter: 'OpenRouter',
			gemini: 'Google Gemini',
			deepseek: 'DeepSeek',
			xai: 'xAI Grok',
			ollama_cloud: 'Ollama',
			ollama: 'Ollama',
			copilot: 'GitHub Copilot',
			bedrock: 'AWS Bedrock',
			nvidia: 'NVIDIA NIM',
			alibaba: 'Alibaba Qwen',
			huggingface: 'HuggingFace',
			nous: 'Nous Research',
			custom: 'Custom Endpoint',
		};
		return displayNames[name] || name.charAt(0).toUpperCase() + name.slice(1);
	}
}
