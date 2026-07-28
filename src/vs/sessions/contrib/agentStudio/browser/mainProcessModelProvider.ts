/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IModelDelta, IModelInfo, ModelAuthStatus, IChatMessage, IModelOptions, IChatContext } from '../common/providers.js';
import { VSSAROS_LLM_CHANNEL, type ISarosisLlmChatRequest } from '../common/llmBridge.js';
import { BuiltInBYOKModelProvider, type IBYOKProviderDefinition } from './builtInBYOKModelProvider.js';

/**
 * 把 LLM 网络调用委派到 electron-main 的 `vssaros-llm` channel。
 *
 * 复用 `BuiltInBYOKModelProvider` 的认证/模型/健康度逻辑，仅覆写 `chat()` 与
 * `listModels()`：请求体仍在 renderer 构造（provider 差异逻辑集中于此），
 * 真实 fetch + SSE 解析在主进程执行，流式 delta 经 IPC `listen('chat')` 回传。
 *
 * web/remote 等无主进程 channel 的环境，`BYOKProviderContribution` 会回退到
 * 原 `BuiltInBYOKModelProvider`（renderer 直连）。
 */
export class MainProcessModelProvider extends BuiltInBYOKModelProvider {

	private readonly _channel: IChannel;

	constructor(
		definition: IBYOKProviderDefinition,
		configurationService: IConfigurationService,
		logService: ILogService,
		environmentService: IEnvironmentService,
		mainProcessService: IMainProcessService,
	) {
		super(definition, configurationService, logService, environmentService);
		this._channel = mainProcessService.getChannel(VSSAROS_LLM_CHANNEL);
	}

	override chat(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): AsyncIterable<IModelDelta> {
		return this._streamViaMain(modelId, messages, options, context);
	}

	override async listModels(): Promise<IModelInfo[]> {
		if (this.getAuthStatus() !== ModelAuthStatus.Authenticated) {
			return [];
		}
		// 有静态模型且无模型发现端点 → 直接返回，无需 IPC 往返
		if (this._definition.staticModels && !this._definition.modelsEndpointPath) {
			return [...this._definition.staticModels];
		}
		try {
			const models = await this._channel.call<IModelInfo[]>('discoverModels', {
				baseUrl: this._getBaseUrl(),
				apiKey: this._getApiKey(),
				definition: this._definition,
			});
			return models ?? (this._definition.staticModels ?? []);
		} catch {
			return this._definition.staticModels ?? [];
		}
	}

	private async *_streamViaMain(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): AsyncGenerator<IModelDelta> {
		const apiKey = this._getApiKey();
		const baseUrl = this._getBaseUrl();

		if (!this._definition.apiKeyOptional && !apiKey) {
			this._logService.error(`[BYOK:${this.id}] MainProcessModelProvider: API key not configured`);
			yield { type: 'error', error: `${this.name}: API key not configured` };
			return;
		}

		const chatPath = this._definition.chatEndpointPath || 'chat/completions';
		const url = `${baseUrl.replace(/\/+$/, '')}/${chatPath.replace(/^\/+/, '')}`;

		const body = this._buildRequestBody(modelId, messages, options, context);

		const idHeaders: Record<string, string> = {};
		if (context?.conversationId ?? context?.sessionId) {
			idHeaders['X-Conversation-ID'] = (context?.conversationId ?? context?.sessionId) as string;
		}
		if (context?.requestId) {
			idHeaders['X-Conversation-Request-ID'] = context.requestId;
		}

		const requestId = generateUuid();
		const req: ISarosisLlmChatRequest = {
			requestId,
			url,
			apiKey,
			body,
			extraHeaders: idHeaders,
			responseFormat: this._definition.responseFormat,
			apiKeyHeader: this._definition.apiKeyHeader,
			anthropicVersion: this._definition.anthropicVersion,
		};

		this._logService.info(`[BYOK:${this.id}] MainProcessModelProvider: forwarding chat to electron-main (url=${url}, model=${modelId})`);

		const onDelta = this._channel.listen<IModelDelta>('chat', req);
		const queue: IModelDelta[] = [];
		let notify: (() => void) | undefined;
		let settled = false;
		const store = new DisposableStore();
		store.add(onDelta(delta => {
			queue.push(delta);
			notify?.();
		}));

		try {
			while (true) {
				while (queue.length === 0) {
					if (settled) { return; }
					await new Promise<void>(resolve => { notify = resolve; });
				}
				const delta = queue.shift()!;
				yield delta;
				if (delta.type === 'done' || delta.type === 'error') { return; }
			}
		} catch (e) {
			this._logService.error(`[BYOK:${this.id}] MainProcessModelProvider: stream error:`, e);
			yield { type: 'error', error: `${this.name}: Main process chat error — ${e}` };
		} finally {
			settled = true;
			store.dispose();
			// best-effort：通知主进程中止残留请求
			this._channel.call('abort', requestId).catch(() => { /* ignore */ });
		}
	}
}
