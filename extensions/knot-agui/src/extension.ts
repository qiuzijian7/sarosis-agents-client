/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Knot AG-UI — third-party VS Code chat model provider.
 *
 * Architecture:
 *   - lives entirely in the ExtensionHost (no `import '../../../src/vs/...'`)
 *   - declares vendor/displayName via `contributes.languageModelChatProviders` in package.json
 *   - registers itself via `vscode.lm.registerLanguageModelChatProvider("knot", provider)`
 *
 * The renderer-side `LanguageModelsToAgentOSBridge` automatically reflects this
 * provider into IAgentOSService.getModelProviders(), so the chat box's provider
 * picker shows "Knot" with one model per configured agent — no main-repo coupling.
 */

import * as vscode from 'vscode';

const VENDOR = 'knot';
const OUTPUT_NAME = 'Knot AG-UI';

/**
 * Separator used inside `LanguageModelChatInformation.id` to encode (agentId, modelName) pairs.
 * Chosen because Knot agent ids are hex strings and Knot model names use only alphanumerics +
 * hyphens — `::` is collision-free for both.
 */
const ID_SEP = '::';

interface KnotAgentConfig {
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
	readonly models?: string[];
}

class KnotChatProvider implements vscode.LanguageModelChatProvider {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(private readonly _output: vscode.OutputChannel) { }

	dispose(): void {
		this._onDidChange.dispose();
	}

	notifyModelsChanged(): void {
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		const agents = this._getAgents();

		if (agents.length === 0) {
			this._output.appendLine('[Knot] provideLanguageModelChatInformation -> no agents configured. Run "Knot: Open Settings" and add at least one agent under "knot.agents".');
			return [];
		}

		// Each Knot agent maps to one or more (agent, model) tuples. We expand them into
		// individual LanguageModelChatInformation entries so the chat picker can render a
		// proper hierarchical "agent ➜ model" selector.
		//
		// Encoding contract used by the bridge (renderer-side LanguageModelsToAgentOSBridge):
		//   - `family`  is the agent id (the bridge groups models by family to build an agent picker)
		//   - `tooltip` is the agent's human-readable name (the bridge uses it as the agent label)
		//   - `id`      is `${agent.id}::${modelName}` (or just `${agent.id}` when the agent has no
		//                explicit model list); we round-trip the model name back out of the id in
		//                provideLanguageModelChatResponse below so the backend gets the real values.
		//   - `name`    is the model's display name (or "default" for agents without a model list)
		const result: vscode.LanguageModelChatInformation[] = [];
		for (const agent of agents) {
			const agentName = agent.name?.trim() ? agent.name.trim() : agent.id;
			const models = (Array.isArray(agent.models) ? agent.models : [])
				.map(s => (typeof s === 'string' ? s.trim() : ''))
				.filter(s => s.length > 0);

			if (models.length === 0) {
				result.push({
					id: agent.id,
					name: 'default',
					family: agent.id,
					version: '1',
					maxInputTokens: 32_000,
					maxOutputTokens: 4_096,
					tooltip: agentName,
					detail: agent.description,
					capabilities: {},
				});
				continue;
			}

			for (const model of models) {
				result.push({
					id: `${agent.id}${ID_SEP}${model}`,
					name: model,
					family: agent.id,
					version: '1',
					maxInputTokens: 32_000,
					maxOutputTokens: 4_096,
					tooltip: agentName,
					detail: agent.description,
					capabilities: {},
				});
			}
		}

		this._output.appendLine(`[Knot] provideLanguageModelChatInformation -> ${result.length} (agent×model) entries from ${agents.length} agent(s)`);
		return result;
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		// 从 settings 读取配置（与 sarosis-webui 一致）
		const config = vscode.workspace.getConfiguration('knot');
		const endpoint = config.get<string>('endpoint') ?? 'https://knot.woa.com';
		const token_ = config.get<string>('token') ?? '';
		const user = config.get<string>('user') ?? '';

		if (!token_) {
			throw new Error('Knot token is not configured. Run command "Knot: Open Settings" and set "knot.token".');
		}

		// Decode the (agentId, modelName) tuple that provideLanguageModelChatInformation encoded.
		// `family` is the source-of-truth for the agent id; the suffix after ID_SEP in `id` (if any)
		// is the model name selected by the user from the picker.
		const agentId = model.family || model.id;
		const sepIdx = model.id.indexOf(ID_SEP);
		const selectedModel = sepIdx > -1 ? model.id.slice(sepIdx + ID_SEP.length) : undefined;

		// 正确的 Knot AG-UI API URL（与 sarosis-webui 一致）
		const url = `${endpoint}/apigw/api/v1/agents/agui/${encodeURIComponent(agentId)}`;

		// 提取用户消息（取最后一条用户消息）
		const lastUser = [...messages].reverse().find(m => m.role === vscode.LanguageModelChatMessageRole.User);
		const userMessage = lastUser ? this._extractText(lastUser) : '';

		// 提取系统提示（如有）
		const systemMsgs: vscode.LanguageModelChatRequestMessage[] = [];
		const systemPrompt = systemMsgs.map(m => this._extractText(m)).join('\n').trim() || undefined;

		// 构建正确的请求 body（与 sarosis-webui 的 knot_agui.py 一致）
		const bodyObj: Record<string, unknown> = {
			input: {
				message: userMessage,
				conversation_id: "",  // TODO: 从 session 中恢复 conversation_id
				stream: true,
				enable_web_search: false,
				chat_extra: {},
			},
		};
		if (selectedModel) {
			(bodyObj.input as Record<string, unknown>).model = selectedModel;
		}
		if (systemPrompt) {
			((bodyObj.input as Record<string, unknown>).chat_extra as Record<string, unknown>).system_prompt = systemPrompt;
		}
		const body = JSON.stringify(bodyObj);

		this._output.appendLine(`[Knot] -> ${url}  agent=${agentId}  model=${selectedModel ?? '<default>'}  msg_len=${userMessage.length}`);

		// 正确的 headers（与 sarosis-webui 一致）
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'text/event-stream',
			'x-knot-api-token': token_,
		};
		if (user) {
			headers['x-knot-api-user'] = user;
		}

		try {
			// 创建 AbortController 来桥接 CancellationToken 到 AbortSignal
			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());

			const response = await fetch(url, {
				method: 'POST',
				headers,
				body,
				signal: controller.signal,
			});

			if (!response.ok) {
				const errText = await response.text().catch(() => response.statusText);
				throw new Error(`HTTP ${response.status}: ${errText}`);
			}

			// 解析 SSE 流（与 sarosis-webui 的 knot_agui.py 一致）
			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error('Knot response has no body stream');
			}

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				if (token.isCancellationRequested) {
					break;
				}
				const { done, value } = await reader.read();
				if (done) { break; }
				
				buffer += decoder.decode(value, { stream: true });
				let idx;
				while ((idx = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, idx).trim();
					buffer = buffer.slice(idx + 1);

					if (!line || line.startsWith(':')) { continue; }
					
					// 移除 "data:" 前缀（支持 "data:" 和 "data: "）
					let rawData = line;
					if (line.startsWith('data:')) {
						rawData = line.slice(5).trim();
					}
					if (line.startsWith('data: ')) {
						rawData = line.slice(6).trim();
					}
					if (rawData === '[DONE]') { return; }

					if (!rawData) { continue; }

					try {
						const event = JSON.parse(rawData);
						const delta = this._translateEvent(event);
						if (delta) {
							progress.report(delta);
						}
					} catch {
						// 非 JSON keep-alive — 忽略
					}
				}
			}
		} catch (err) {
			if (token.isCancellationRequested) {
				throw new Error('Cancelled');
			}
			throw err instanceof Error ? err : new Error(String(err));
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		// Heuristic fallback (~4 chars/token). Backends with proper tokenizer
		// support can replace this with a real /tokenize call later.
		const raw = typeof text === 'string' ? text : this._extractText(text);
		return Math.max(1, Math.ceil(raw.length / 4));
	}

	// ---- helpers -----------------------------------------------------------

	private _getAgents(): KnotAgentConfig[] {
		const cfg = vscode.workspace.getConfiguration('knot');
		const raw = cfg.get<KnotAgentConfig[]>('agents');
		if (!Array.isArray(raw)) { return []; }
		return raw.filter(a => a && typeof a.id === 'string' && a.id.length > 0);
	}

	private _extractText(msg: vscode.LanguageModelChatRequestMessage): string {
		const parts: string[] = [];
		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				parts.push(part.value);
			}
		}
		return parts.join('');
	}

	private _translateEvent(event: Record<string, unknown>): vscode.LanguageModelResponsePart | undefined {
		const eventType = String(event.type ?? event.event_type ?? '');
		if (!eventType) {
			this._output.appendLine(`[Knot] _translateEvent: no type, keys=${Object.keys(event).join(',')}`);
			return undefined;
		}

		// 获取 rawEvent（AG-UI 协议的内容在 rawEvent 中）
		const rawEvent = (event.rawEvent ?? {}) as Record<string, unknown>;

		// 归一化事件类型：同时兼容 PascalCase 和 UPPER_SNAKE_CASE
		const normalized = eventType.toUpperCase().replace(/-/g, '_');

		// 从 rawEvent 中获取内容（AG-UI 协议标准位置）
		let content: string = '';
		if (rawEvent.content != null) {
			content = String(rawEvent.content);
		} else if (event.delta != null) {
			content = String(event.delta);
		}

		this._output.appendLine(`[Knot] _translateEvent: type="${eventType}" normalized="${normalized}" content_len=${content.length}`);

		switch (normalized) {
			case 'TEXT_MESSAGE_CONTENT':
			case 'TEXTMESSAGECONTENT':  // 防止 PascalCase 被意外处理
				if (content) {
					return new vscode.LanguageModelTextPart(content);
				}
				return undefined;
			case 'THINKING_TEXT_MESSAGE_CONTENT':
			case 'THINKINGTEXTMESSAGECONTENT':
				// 思考内容：通过额外的标记返回（VS Code LM API 可能不支持思考事件）
				// 暂时作为普通文本返回，前端会处理
				if (content) {
					return new vscode.LanguageModelTextPart(content);
				}
				return undefined;
			case 'TOOL_CALL_START':
			case 'TOOLCALLSTART':
				// 工具调用开始：记录到日志，但不返回内容
				const toolName = rawEvent.name ?? 'unknown_tool';
				this._output.appendLine(`[Knot] Tool call started: ${toolName}`);
				return undefined;
			case 'TOOL_CALL_ARGS':
			case 'TOOLCALLARGS':
				// 工具参数：增量接收，不返回内容
				return undefined;
			case 'TOOL_CALL_END':
			case 'TOOLCALLEND':
				// 工具调用结束
				this._output.appendLine(`[Knot] Tool call ended`);
				return undefined;
			case 'TEXT_MESSAGE_START':
			case 'TEXTMESSAGESTART':
			case 'TEXT_MESSAGE_END':
			case 'TEXTMESSAGEEND':
			case 'THINKING_TEXT_MESSAGE_START':
			case 'THINKINGTEXTMESSAGESTART':
			case 'THINKING_TEXT_MESSAGE_END':
			case 'THINKINGTEXTMESSAGEEND':
				// 生命周期事件：忽略
				return undefined;
			default:
				this._output.appendLine(`[Knot] _translateEvent: unhandled type="${eventType}"`);
				// 宽松处理：如果有 content 也尝试返回
				if (content && content.length > 0 && content !== '{}') {
					return new vscode.LanguageModelTextPart(content);
				}
				return undefined;
		}
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel(OUTPUT_NAME);
	context.subscriptions.push(output);

	const provider = new KnotChatProvider(output);
	context.subscriptions.push(provider);

	const registration = vscode.lm.registerLanguageModelChatProvider(VENDOR, provider);
	context.subscriptions.push(registration);

	// Re-broadcast model list when the user edits knot.agents / token / endpoint.
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('knot')) {
			provider.notifyModelsChanged();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('knot.openSettings', () => {
		void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:sarosis.sarosis-knot-agui');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('knot.refreshAgents', () => {
		provider.notifyModelsChanged();
		void vscode.window.showInformationMessage('Knot agent list refreshed.');
	}));

	output.appendLine(`[Knot] activate() — registered chat provider, vendor="${VENDOR}"`);
}

export function deactivate(): void {
	// nothing — context.subscriptions disposes resources
}
