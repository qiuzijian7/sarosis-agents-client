/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IModelProvider, IModelInfo, ModelAuthStatus, IChatMessage, IModelOptions, IModelDelta, ModelCapability } from '../common/providers.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { AGENT_STUDIO_KNOT_TOKEN_SETTING, AGENT_STUDIO_KNOT_AGENT_ID_SETTING, AGENT_STUDIO_KNOT_MODELS_SETTING, AGENT_STUDIO_KNOT_USER_SETTING } from '../common/constants.js';

const KNOT_API_BASE = 'https://knot.woa.com/apigw/api/v1/agents/agui';

/**
 * Knot AG-UI Model Provider
 * 实现 IModelProvider 接口，连接 Knot AG-UI 服务
 * 
 * API 文档: https://knot.woa.com/apigw/api/v1/agents/agui/{agent_id}
 * SSE 事件类型（兼容 UPPER_SNAKE_CASE 和 PascalCase）:
 * - TEXT_MESSAGE_START/CONTENT/END → text delta
 * - THINKING_TEXT_MESSAGE_START/CONTENT/END → thinking delta
 * - TOOL_CALL_START/ARGS/END/RESULT → tool events
 * - STEP_STARTED/STEP_FINISHED → step events
 * - RUN_STARTED/RUN_FINISHED/RUN_ERROR → run events
 */
export class KnotModelProvider extends Disposable implements IModelProvider {

	declare readonly _serviceBrand: undefined;

	readonly id = 'knot-agui';
	readonly name = 'Knot AG-UI';
	readonly priority = 100; // 高优先级

	private readonly _onDidChangeModels = this._register(new Emitter<void>());
	readonly onDidChangeModels = this._onDidChangeModels.event;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<ModelAuthStatus>());
	readonly onDidChangeAuthStatus = this._onDidChangeAuthStatus.event;

	private _logService: ILogService = console as unknown as ILogService;
	private _configurationService: IConfigurationService | undefined;
	private _authStatus: ModelAuthStatus = ModelAuthStatus.NotConfigured;
	private _cachedModels: IModelInfo[] = [];

	constructor() {
		super();
	}

	setLogService(logService: ILogService): void {
		this._logService = logService;
	}

	setConfigurationService(configurationService: IConfigurationService): void {
		this._configurationService = configurationService;
		this._checkAuthStatus();
	}

	// ─── IModelProvider 实现 ───────────────────────────────

	getAuthStatus(): ModelAuthStatus {
		return this._authStatus;
	}

	async listModels(): Promise<IModelInfo[]> {
		const currentStatus = this._authStatus;
		if (currentStatus !== ModelAuthStatus.Authenticated) {
			await this._checkAuthStatus();
			if (this._authStatus !== ModelAuthStatus.Authenticated) {
				return [];
			}
		}

		// 从配置中读取模型列表
		// 配置格式: sessions.agentStudio.knot.models = ["model1", "model2", ...]
		const configModels = this._configurationService?.getValue<string[]>(AGENT_STUDIO_KNOT_MODELS_SETTING);
		
		if (configModels && Array.isArray(configModels) && configModels.length > 0) {
			this._cachedModels = configModels.map(modelId => ({
				id: modelId,
				name: modelId,
				capabilities: [ModelCapability.Chat, ModelCapability.Code],
			}));
			return this._cachedModels;
		}

		// 如果配置中没有模型列表，返回默认模型
		if (this._cachedModels.length === 0) {
			this._cachedModels = [
				{
					id: 'hy3-preview',
					name: 'HY3 Preview',
					description: 'Default Knot AG-UI model',
					capabilities: [ModelCapability.Chat, ModelCapability.Code],
				},
			];
		}

		return this._cachedModels;
	}

	async *chat(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
	): AsyncIterable<IModelDelta> {
		if (this._authStatus !== ModelAuthStatus.Authenticated) {
			throw new Error('KnotModelProvider: Not authenticated. Please configure Knot token.');
		}

		const token = this._configurationService?.getValue<string>(AGENT_STUDIO_KNOT_TOKEN_SETTING);
		const agentId = this._configurationService?.getValue<string>(AGENT_STUDIO_KNOT_AGENT_ID_SETTING);
		
		if (!agentId) {
			throw new Error('KnotModelProvider: No agent ID configured. Please set sessions.agentStudio.knot.agentId');
		}

		this._logService.info(`[KnotModelProvider] chat: agentId=${agentId}, modelId=${modelId}, messages=${messages.length}`);

		// 构建 API URL
		const apiUrl = `${KNOT_API_BASE}/${agentId}`;

		// 获取最后一条用户消息
		const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
		const messageText = lastUserMessage?.content || '';

		// 构建请求体
		const chatBody: any = {
			input: {
				message: messageText,
				conversation_id: '',
				model: modelId,
				stream: true,
				enable_web_search: false,
				chat_extra: {},
			},
		};

		// 注入 system_prompt（如果有）
		if (options.systemPrompt) {
			chatBody.input.chat_extra.system_prompt = options.systemPrompt;
		}

		// 构建请求头
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'x-knot-api-token': token || '',
		};

		const apiUser = this._configurationService?.getValue<string>(AGENT_STUDIO_KNOT_USER_SETTING);
		if (apiUser) {
			headers['x-knot-api-user'] = apiUser;
		}

		this._logService.info(`[KnotModelProvider] Calling Knot API: ${apiUrl}`);

		// 调用 Knot API 并 yield delta
		yield* this._streamFromKnotApi(apiUrl, chatBody, headers);
	}

	// ─── 私有方法 ─────────────────────────────────────

	private async _checkAuthStatus(): Promise<void> {
		if (!this._configurationService) {
			this._authStatus = ModelAuthStatus.NotConfigured;
			return;
		}

		const token = this._configurationService.getValue<string>(AGENT_STUDIO_KNOT_TOKEN_SETTING);
		if (!token) {
			this._authStatus = ModelAuthStatus.NotConfigured;
			this._onDidChangeAuthStatus.fire(this._authStatus);
			return;
		}

		this._authStatus = ModelAuthStatus.Validating;
		this._onDidChangeAuthStatus.fire(this._authStatus);

		try {
			// 简单验证：检查 token 格式（Knot token 通常是非空字符串）
			if (token.length < 10) {
				throw new Error('Token too short');
			}

			// TODO: 可以调用 Knot API 验证 token 有效性
			// 例如：GET https://knot.woa.com/apigw/api/v1/agents 并检查响应
			
			this._authStatus = ModelAuthStatus.Authenticated;
			this._logService.info('[KnotModelProvider] Authenticated successfully');
			this._onDidChangeModels.fire();
		} catch (error) {
			this._authStatus = ModelAuthStatus.Failed;
			this._logService.error('[KnotModelProvider] Authentication failed', error);
		}

		this._onDidChangeAuthStatus.fire(this._authStatus);
	}

	/**
	 * 从 Knot API 获取 SSE 流并转换为 AsyncIterable<IModelDelta>
	 */
	private async *_streamFromKnotApi(
		apiUrl: string,
		chatBody: any,
		headers: Record<string, string>,
	): AsyncGenerator<IModelDelta, void, unknown> {
		// 使用类型断言绕过 TypeScript 类型检查（Electron 环境支持 fetch）
		const fetchImpl = (globalThis as any).fetch || fetch;
		let response: Response;
		
		try {
			response = await fetchImpl(apiUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify(chatBody),
			});
		} catch (error) {
			this._logService.error('[KnotModelProvider] Failed to call Knot API', error);
			throw new Error(`Knot API request failed: ${error}`);
		}

		if (!response.ok) {
			const errorText = await response.text();
			this._logService.error(`[KnotModelProvider] Knot API error ${response.status}: ${errorText}`);
			
			if (response.status === 401 || response.status === 403) {
				this._authStatus = ModelAuthStatus.Failed;
				this._onDidChangeAuthStatus.fire(this._authStatus);
				throw new Error(`Knot API auth failed (${response.status}): ${errorText}`);
			}
			
			throw new Error(`Knot API error (${response.status}): ${errorText}`);
		}

		if (!response.body) {
			throw new Error('Knot API response has no body');
		}

		// 解析 SSE 流
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					// SSE 格式: "data: {...}"
					let dataStr = trimmed;
					if (dataStr.startsWith('data:')) {
						dataStr = dataStr.slice(5).trim();
					} else if (dataStr.startsWith('event:')) {
						// 事件类型行，跳过
						continue;
					}

					if (dataStr === '[DONE]') {
						yield { type: 'done' };
						return;
					}

					try {
						const msg = JSON.parse(dataStr);
						const msgType = msg.type || '';
						const rawEvent = msg.rawEvent || {};

						// 处理错误响应（没有 type 字段）
						if (!msgType) {
							if (msg.code || msg.error || msg.msg) {
								const errorMsg = msg.msg || msg.error || JSON.stringify(msg);
								yield { type: 'error', content: `Knot API error (${msg.code || 'unknown'}): ${errorMsg}` };
								return;
							}
							continue;
						}

						// 转换 AG-UI 事件为 IModelDelta
						for (const delta of this._convertAguiEventToDelta(msgType, rawEvent, msg)) {
							yield delta;
						}
					} catch (parseError) {
						// JSON 解析失败，跳过
						this._logService.warn('[KnotModelProvider] Failed to parse SSE data', parseError);
					}
				}
			}
		} catch (error) {
			this._logService.error('[KnotModelProvider] Stream error', error);
			yield { type: 'error', content: `Stream error: ${error}` };
		} finally {
			try { reader.releaseLock(); } catch { /* ignore */ }
		}

		// 确保最后发送 done 事件
		yield { type: 'done' };
	}

	/**
	 * 将 AG-UI 事件转换为 IModelDelta
	 * 兼容 UPPER_SNAKE_CASE 和 PascalCase 两种格式
	 */
	private *_convertAguiEventToDelta(
		msgType: string,
		rawEvent: any,
		msg: any,
	): Generator<IModelDelta, void, unknown> {
		// 辅助函数：匹配事件类型（兼容两种格式）
		const matchEvent = (pascalCase: string, upperSnakeCase: string): boolean => {
			return msgType === pascalCase || msgType === upperSnakeCase;
		};

		// ─── Text Message Events ──────────────────────────────────
		if (matchEvent('TextMessageContent', 'TEXT_MESSAGE_CONTENT')) {
			const text = rawEvent.content || msg.delta || '';
			if (text && !this._isEmptyLikeContent(text)) {
				yield { type: 'text', content: text };
			}
		} else if (matchEvent('TextMessageStart', 'TEXT_MESSAGE_START')) {
			// 消息开始，暂不产生 delta（可以扩展 IModelDelta 支持）
		} else if (matchEvent('TextMessageEnd', 'TEXT_MESSAGE_END')) {
			// 消息结束，暂不产生 delta
		}

		// ─── Thinking Message Events ──────────────────────────────
		else if (matchEvent('ThinkingTextMessageContent', 'THINKING_TEXT_MESSAGE_CONTENT')) {
			const text = rawEvent.content || msg.delta || '';
			if (text && !this._isEmptyLikeContent(text)) {
				yield { type: 'thinking', content: text };
			}
		} else if (matchEvent('ThinkingTextMessageStart', 'THINKING_TEXT_MESSAGE_START')) {
			// 思考开始
		} else if (matchEvent('ThinkingTextMessageEnd', 'THINKING_TEXT_MESSAGE_END')) {
			// 思考结束
		}

		// ─── Tool Call Events ─────────────────────────────────────
		else if (matchEvent('ToolCallStart', 'TOOL_CALL_START')) {
			const toolName = rawEvent.name || 'unknown_tool';
			const toolCallId = rawEvent.tool_call_id || '';
			yield {
				type: 'tool_call',
				content: '',
				toolCall: {
					id: toolCallId,
					name: toolName,
					arguments: JSON.stringify(rawEvent.args || {}),
				},
			};
		} else if (matchEvent('ToolCallArgs', 'TOOL_CALL_ARGS')) {
			// 工具参数增量，暂不处理（可以扩展 IModelDelta 支持）
		} else if (matchEvent('ToolCallEnd', 'TOOL_CALL_END')) {
			// 工具调用结束
		} else if (matchEvent('ToolCallResult', 'TOOL_CALL_RESULT')) {
			// 工具结果，暂不处理（可以扩展 IModelDelta 支持）
		}

		// ─── Run Events ───────────────────────────────────────────
		else if (matchEvent('RunFinished', 'RUN_FINISHED')) {
			yield { type: 'done' };
		} else if (matchEvent('RunError', 'RUN_ERROR')) {
			const tipOption = rawEvent.tip_option || {};
			const errorMsg = (typeof tipOption === 'object' ? tipOption.content : '') || 'Agent execution error';
			yield { type: 'error', content: errorMsg };
		}

		// ─── Step Events ──────────────────────────────────────────
		else if (matchEvent('StepFinished', 'STEP_FINISHED')) {
			// 步骤完成，可以记录 token 用量等
			const tokenUsage = rawEvent.token_usage || {};
			if (tokenUsage.input_tokens || tokenUsage.output_tokens) {
				this._logService.info(`[KnotModelProvider] Token usage: input=${tokenUsage.input_tokens}, output=${tokenUsage.output_tokens}`);
			}
		}
	}

	/**
	 * 过滤空外观 token：某些模型在 tool_calls 前发送 content="{}" / "{" / "}" 等
	 */
	private _isEmptyLikeContent(text: string): boolean {
		if (!text) return true;
		return /^[\s{}\[\]"]+$/.test(text.trim());
	}
}
