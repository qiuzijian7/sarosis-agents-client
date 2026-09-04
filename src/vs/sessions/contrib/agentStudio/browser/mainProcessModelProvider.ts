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
import { IModelDelta, IModelInfo, ModelAuthStatus, IChatMessage, IModelOptions, IChatContext, IImageGenParams, IImageGenResult } from '../common/providers.js';
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

	/**
	 * 文生图 / 图生图：构造 OpenAI 兼容 images 请求并经主进程 channel 执行。
	 *
	 * ★ img2img（2026-09-03）：params.imageInput 存在时走 **multipart /images/edits**
	 *   （主进程把 body.__imageDataUrl 解包成 FormData image 字段）。回退链：
	 *   edits 405 → /v1/edits → 仍失败 → **文生图兜底**（参考图降级忽略，保证出图，
	 *   与「无参考图」旧行为一致）。
	 */
	override async generateImage(params: IImageGenParams): Promise<IImageGenResult> {
		const apiKey = this._getApiKey();
		const baseUrl = this._getBaseUrl();
		if (!this._definition.apiKeyOptional && !apiKey) {
			throw new Error(`${this.name}: API key not configured`);
		}
		const imageInput = typeof params.imageInput === 'string' && params.imageInput ? params.imageInput : undefined;
		const imagePath = imageInput
			? (this._definition.imageEditEndpointPath || 'images/edits')
			: (this._definition.imageGenEndpointPath || 'images/generations');
		const imageMethod = this._definition.imageGenMethod || 'POST';
		const url = `${baseUrl.replace(/\/+$/, '')}/${imagePath.replace(/^\/+/, '')}`;
		const body: Record<string, unknown> = {
			model: params.modelId,
			prompt: params.prompt,
			n: params.numImages ?? 1,
		};
		if (params.width && params.height) {
			body['size'] = `${params.width}x${params.height}`;
		}
		if (params.negativePrompt) {
			body['negative_prompt'] = params.negativePrompt;
		}
		if (params.quality) {
			body['quality'] = params.quality;
		}
		if (imageInput) {
			// img2img 协议标记：主进程 imageGenerate 解包为 multipart（见 llmBridgeNode）
			body['__imageDataUrl'] = imageInput;
		}
		const callOnce = (u: string, m: string, b: Record<string, unknown> = body) =>
			this._channel.call<IImageGenResult>('imageGenerate', {
				url: u,
				apiKey,
				body: b,
				method: m,
				extraHeaders: {},
				apiKeyHeader: this._definition.apiKeyHeader,
			});

		this._logService.info(`[BYOK:${this.id}] MainProcessModelProvider: generateImage → ${imageMethod} ${url} (model=${params.modelId}${imageInput ? ', img2img' : ''})`);
		try {
			return await callOnce(url, imageMethod);
		} catch (e) {
			const msg = (e as Error)?.message ?? '';
			// 405 常见于 OpenAI 兼容代理只在 /v1 前缀下暴露 images 端点
			//（如 chatgpt2api）。自动回退到 /v1 前缀版本，免去手动配置。
			const alreadyV1 = /\/v1\//.test(url) || imagePath.startsWith('v1/');
			if (msg.includes('405') && !alreadyV1 && imageMethod === 'POST') {
				const v1Url = `${baseUrl.replace(/\/+$/, '')}/v1/${imagePath.replace(/^\/+/, '')}`;
				this._logService.info(`[BYOK:${this.id}] generateImage 405 → 自动回退 /v1 前缀: ${v1Url}`);
				try {
					return await callOnce(v1Url, imageMethod);
				} catch (e2) {
					this._logService.error(`[BYOK:${this.id}] MainProcessModelProvider: generateImage (/v1 回退) error:`, e2);
					if (!imageInput) { throw e2; }
					// img2img 全失败 → 继续走下方文生图兜底
				}
			}
			// ★ img2img 兜底：edits 端点不可用（404/405/422…）→ 退回**文生图**，
			//   参考图降级忽略——与「无参考图」旧行为一致，保证表情包链路仍能出图
			//   （否则 chatgpt2api 这类只暴露 generations 的代理会让整条链路报废）。
			if (imageInput) {
				const genPath = this._definition.imageGenEndpointPath || 'images/generations';
				const genUrl = `${baseUrl.replace(/\/+$/, '')}/${genPath.replace(/^\/+/, '')}`;
				const fallbackBody = { ...body };
				delete fallbackBody['__imageDataUrl'];
				this._logService.warn(`[BYOK:${this.id}] img2img 端点不可用（${msg.slice(0, 80)}）→ 回退文生图 ${genUrl}（参考图被忽略）`);
				return await callOnce(genUrl, 'POST', fallbackBody);
			}
			this._logService.error(`[BYOK:${this.id}] MainProcessModelProvider: generateImage error:`, e);
			throw e;
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
