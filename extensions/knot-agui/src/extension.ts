/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
// allow-any-unicode-next-line
 * Knot AG-UI — third-party VS Code chat model provider.
 *
 * Architecture:
 *   - lives entirely in the ExtensionHost (no `import '../../../src/vs/...'`)
 *   - declares vendor/displayName via `contributes.languageModelChatProviders` in package.json
 *   - registers itself via `vscode.lm.registerLanguageModelChatProvider('knot', provider)`
 *
 * The renderer-side `LanguageModelsToAgentOSBridge` automatically reflects this
 * provider into IAgentOSService.getModelProviders(), so the chat box's provider
// allow-any-unicode-next-line
 * picker shows 'Knot' with one model per configured agent — no main-repo coupling.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const VENDOR = 'knot';

/**
 * Tool names that are phantom / UI-indicator tools (render_type="none").
 * These tools signal a state change (e.g., "planning in progress") but
 * should NOT be rendered as visible tool-call cards in the chat UI.
 * The Knot server may not always send the correct render_type in its
 * _meta, so we maintain this client-side canonical list.
 */
const PHANTOM_TOOL_NAMES = new Set([
	'task_planning',
	'taskplanning',
	'plan_task',
	'plan_tasks',
	'task_plan',
	'planning',
]);

/**
 * Separator used inside `LanguageModelChatInformation.id` to encode (agentId, modelName) pairs.
 * Chosen because Knot agent ids are hex strings and Knot model names use only alphanumerics +
// allow-any-unicode-next-line
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

	/** Accumulated in-progress tool calls (keyed by toolCallId) */
	private _pendingToolCalls = new Map<string, { name: string; argsBuffer: string }>();

	constructor(
		private readonly _globalState: any, // vscode.GlobalState not available in this API version
	) { }

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
			// Check if knot.models is configured as fallback
			const defaultModels = this._getDefaultModels();
			if (defaultModels.length > 0) {
				console.log(
					`[Knot] provideLanguageModelChatInformation -> no agents configured, using ${defaultModels.length} default models from knot.models`,
				);
				return defaultModels;
			}

			console.log(
				`[Knot] provideLanguageModelChatInformation -> no agents configured. Run 'Knot: Open Settings' and add at least one agent under 'knot.agents'.`,
			);
			return [];
		}

		// Each Knot agent maps to one or more (agent, model) tuples. We expand them into
		// individual LanguageModelChatInformation entries so the chat picker can render a
		// allow-any-unicode-next-line
		// proper hierarchical 'agent ➜ model' selector.
		//
		// Encoding contract used by the bridge (renderer-side LanguageModelsToAgentOSBridge):
		//   - `family`  is the agent id (the bridge groups models by family to build an agent picker)
		//   - `tooltip` is the agent's human-readable name (the bridge uses it as the agent label)
		//   - `id`      is `${agent.id}::${modelName}` (or just `${agent.id}` when the agent has no
		//                explicit model list); we round-trip the model name back out of the id in
		//                provideLanguageModelChatResponse below so the backend gets the real values.
		//   - `name`    is the model's display name (or 'default' for agents without a model list)
		const result: vscode.LanguageModelChatInformation[] = [];
		for (const agent of agents) {
			const agentName = agent.name?.trim() ? agent.name.trim() : agent.id;
			const models = (Array.isArray(agent.models) ? agent.models : [])
				.map((s) => (typeof s === 'string' ? s.trim() : ''))
				.filter((s) => s.length > 0);

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

		console.log(
			// allow-any-unicode-next-line
			`[Knot] provideLanguageModelChatInformation -> ${result.length} (agent×model) entries from ${agents.length} agent(s)`,
		);
		return result;
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		// allow-any-unicode-next-line
		// 从 settings 读取配置（与 sarosis-webui 一致）
		const config = vscode.workspace.getConfiguration('knot');
		const endpoint = config.get<string>('endpoint') ?? 'https://knot.woa.com';
		const token_ = config.get<string>('token') ?? '';
		const user = config.get<string>('user') ?? '';

		if (!token_) {
			throw new Error(
				`Knot token is not configured. Run command 'Knot: Open Settings' and set 'knot.token'.`,
			);
		}

		// Decode the (agentId, modelName) tuple that provideLanguageModelChatInformation encoded.
		// `family` is the source-of-truth for the agent id; the suffix after ID_SEP in `id` (if any)
		// is the model name selected by the user from the picker.
		const agentId = model.family || model.id;
		const sepIdx = model.id.indexOf(ID_SEP);
		const selectedModel =
			sepIdx > -1 ? model.id.slice(sepIdx + ID_SEP.length) : undefined;

		console.log(
			`[Knot] provideLanguageModelChatResponse: agentId=${agentId}, selectedModel=${selectedModel}`,
		);

		// allow-any-unicode-next-line
		// 正确的 Knot AG-UI API URL（与 sarosis-webui 一致）
		const url = `${endpoint}/apigw/api/v1/agents/agui/${encodeURIComponent(agentId)}`;

		// allow-any-unicode-next-line
		// 提取用户消息（取最后一条用户消息）
		const lastUser = [...messages]
			.reverse()
			.find((m) => m.role === vscode.LanguageModelChatMessageRole.User);
		const userMessage = lastUser ? this._extractText(lastUser) : '';

		console.log(`[Knot] userMessage length=${userMessage.length}`);

		// allow-any-unicode-next-line
		// 提取系统提示（从 messages 中过滤系统角色消息）
		// allow-any-unicode-next-line
		// LanguageModelChatMessageRole.System = 3（在 proposed API languageModelSystem 中定义）
		const systemMsgs = messages.filter((m) => (m.role as number) === 3);
		const baseSystemPrompt =
			systemMsgs
				.map((m) => this._extractText(m))
				.join('\n')
				.trim() || undefined;

		console.log(
			`[Knot] baseSystemPrompt length=${baseSystemPrompt?.length ?? 0}`,
		);

		// allow-any-unicode-next-line
		// 注入 agent 实例的技能清单到系统提示（让 knot agent 知道可用技能及其路径）
		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		console.log(`[Knot] workspacePath=${workspacePath ?? 'null'}`);

		let systemPrompt = baseSystemPrompt;
		if (workspacePath && agentId) {
			console.log(`[Knot] Calling _getAgentSkillsManifest...`);
			const skillsManifest = await this._getAgentSkillsManifest(
				workspacePath,
				agentId,
			);
			console.log(
				`[Knot] _getAgentSkillsManifest returned, length=${skillsManifest.length}`,
			);
			if (skillsManifest) {
				systemPrompt = systemPrompt
					? `${systemPrompt}\n\n---\n\n${skillsManifest}`
					: skillsManifest;
			}
		} else {
			console.log(
				`[Knot] Skipped _getAgentSkillsManifest: workspacePath=${workspacePath}, agentId=${agentId}`,
			);
		}

		// allow-any-unicode-next-line
		// 构建正确的请求 body（与 sarosis-webui 的 knot_agui.py 一致）
		// allow-any-unicode-next-line
		// 获取 agent_client_uuid（仅从 knot-cli 获取真实 connection_uuid，不可用时省略该字段）
		const agentClientUuid = await this._tryGetConnectionUuid();
		const chatExtra: Record<string, unknown> = {};
		if (agentClientUuid) {
			chatExtra.agent_client_uuid = agentClientUuid;
		}
		console.log(
			`[Knot] agent_client_uuid: ${agentClientUuid ?? '<not available>'}`,
		);
		const bodyObj: Record<string, unknown> = {
			input: {
				message: userMessage,
				// allow-any-unicode-next-line
				conversation_id: '', // TODO: 从 session 中恢复 conversation_id
				stream: true,
				enable_web_search: false,
				chat_extra: chatExtra,
			},
		};
		if (selectedModel) {
			(bodyObj.input as Record<string, unknown>).model = selectedModel;
		}
		if (systemPrompt) {
			// allow-any-unicode-next-line
			// Knot AG-UI 协议不支持向 LLM 注入 system_prompt，
			// 使用 background_knowledge 字段传递上下文信息（技能清单等），
			// 其效果与 system prompt 类似但不会覆盖 agent 自身的系统提示。
			(
				(bodyObj.input as Record<string, unknown>).chat_extra as Record<
					string,
					unknown
				>
			).background_knowledge = systemPrompt;
		}
		const body = JSON.stringify(bodyObj);

		console.log(
			`[Knot] -> ${url}  agent=${agentId}  model=${selectedModel ?? '<default>'}  msg_len=${userMessage.length}`,
		);

		// allow-any-unicode-next-line
		// 正确的 headers（与 sarosis-webui 一致）
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			'x-knot-api-token': token_,
		};
		if (user) {
			headers['x-knot-api-user'] = user;
		}

		try {
			// allow-any-unicode-next-line
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

			// allow-any-unicode-next-line
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
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				let idx;
				while ((idx = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, idx).trim();
					buffer = buffer.slice(idx + 1);

					if (!line || line.startsWith(':')) {
						continue;
					}

					// allow-any-unicode-next-line
					// 移除 'data:' 前缀（支持 'data:' 和 'data: '）
					let rawData = line;
					if (line.startsWith('data:')) {
						rawData = line.slice(5).trim();
					}
					if (line.startsWith('data: ')) {
						rawData = line.slice(6).trim();
					}
					if (rawData === '[DONE]') {
						return;
					}

					if (!rawData) {
						continue;
					}

					try {
						const event = JSON.parse(rawData);
						// allow-any-unicode-next-line
						// 在调用 _translateEvent 之前，先处理工具调用相关事件
						// AG-UI 协议的工具调用分为三步：START → ARGS → END
						// 需要跨事件累积参数，在 END 时才发射完整的 LanguageModelToolCallPart
						const eventType = String(event.type ?? event.event_type ?? '').toUpperCase().replace(/-/g, '_');

						if (this._handleToolCallEvent(eventType, event, progress)) {
							// allow-any-unicode-next-line
							// 工具调用事件已处理，跳过 _translateEvent
						} else if (this._isLifecycleOrHeartbeat(eventType)) {
							// allow-any-unicode-next-line
							// 生命周期/心跳事件，静默忽略
						} else {
							const delta = this._translateEvent(event);
							if (delta) {
								progress.report(delta);
							}
						}
					} catch {
						// allow-any-unicode-next-line
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

	/**
	 * Try to obtain a real `connection_uuid` from knot-cli.
// allow-any-unicode-next-line
	 * Returns `undefined` if knot-cli is not installed or the call fails —
	 * in that case `agent_client_uuid` will NOT be sent, which is safe
	 * because the backend only validates the UUID when it is present.
	 */
	private async _tryGetConnectionUuid(): Promise<string | undefined> {
		// 1. Already have a real (non-local) value in globalState?
		const existing = this._globalState.get('knot.connection_uuid') as
			| string
			| undefined;
		if (existing && !existing.startsWith('local-')) {
			return existing;
		}

		// 2. On-demand fetch from knot-cli
		try {
			const status = await getKnotClientStatus();
			const uuid = status.connection_uuid;
			await this._globalState.update('knot.connection_uuid', uuid);
			console.log(`[Knot] on-demand fetch connection_uuid -> ${uuid}`);
			return uuid;
		} catch (err) {
			console.log(
				`[Knot] on-demand fetch connection_uuid failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// allow-any-unicode-next-line
		// 3. No real UUID available — return undefined (agent_client_uuid will be omitted)
		return undefined;
	}

	private _getAgents(): KnotAgentConfig[] {
		const cfg = vscode.workspace.getConfiguration('knot');
		const raw = cfg.get<KnotAgentConfig[]>('agents');
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.filter((a) => a && typeof a.id === 'string' && a.id.length > 0);
	}

	/** Parse models configuration (comma-separated string) and return model names */
	private _parseModelsConfig(modelsConfig: string): string[] {
		if (!modelsConfig) {
			return [];
		}
		const modelNames = modelsConfig.split(',').map(m => m.trim()).filter(m => m.length > 0);
		return modelNames;
	}

	/** Get default models from knot.models configuration */
	private _getDefaultModels(): vscode.LanguageModelChatInformation[] {
		const config = vscode.workspace.getConfiguration('knot');
		const modelsConfig = config.get<string>('models') ?? '';
		const modelNames = this._parseModelsConfig(modelsConfig);

		if (modelNames.length === 0) {
			return [];
		}

		// Create virtual "default" agent with these models
		// The agentId will be 'default' - the server must have a "default" agent or the chat will fail
		console.log(`[Knot] _getDefaultModels: returning ${modelNames.length} models from knot.models: [${modelNames.join(', ')}]`);
		return modelNames.map(modelName => ({
			id: `default::${modelName}`,
			name: modelName,
			family: 'default',
			version: '1',
			maxInputTokens: 32_000,
			maxOutputTokens: 4_096,
			tooltip: 'Default',
			detail: `Default model: ${modelName}`,
			capabilities: {},
		}));
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

	/**
	 * Handle AG-UI tool call events (TOOL_CALL_START / ARGS / END / RESULT).
	 * Accumulates tool call data across events and emits LanguageModelToolCallPart
	 * at TOOL_CALL_END, with _meta.server_executed=true so the client knows
	 * not to re-execute the tool.
	 *
	 * @returns true if the event was handled (caller should skip _translateEvent)
	 */
	private _handleToolCallEvent(
		normalizedType: string,
		event: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	): boolean {
		const rawEvent = (event.rawEvent ?? {}) as Record<string, unknown>;

		switch (normalizedType) {
			case 'TOOL_CALL_START':
			case 'TOOLCALLSTART': {
				// AG-UI spec: toolCallId, toolCallName; also accept Knot-specific aliases
				const callId = String(
					rawEvent.toolCallId ?? rawEvent.tool_call_id ?? rawEvent.id
					?? event.toolCallId ?? event.tool_call_id ?? `tc_${Date.now()}`
				);
				const toolName = String(
					rawEvent.toolCallName ?? rawEvent.name ?? rawEvent.tool_name
					?? event.toolCallName ?? event.tool_name ?? 'unknown_tool'
				);
				this._pendingToolCalls.set(callId, { name: toolName, argsBuffer: '' });
				console.log(`[Knot] Tool call started: ${toolName} (id=${callId})`);
				return true;
			}
			case 'TOOL_CALL_ARGS':
			case 'TOOLCALLARGS': {
				const callId = String(
					rawEvent.toolCallId ?? rawEvent.tool_call_id ?? rawEvent.id
					?? event.toolCallId ?? event.tool_call_id ?? ''
				);
				const pending = callId ? this._pendingToolCalls.get(callId) : undefined;
				if (pending) {
					const argsDelta = String(
						rawEvent.delta ?? rawEvent.args ?? rawEvent.arguments
						?? event.delta ?? ''
					);
					pending.argsBuffer += argsDelta;
				}
				return true;
			}
			case 'TOOL_CALL_END':
			case 'TOOLCALLEND': {
				const callId = String(
					rawEvent.toolCallId ?? rawEvent.tool_call_id ?? rawEvent.id
					?? event.toolCallId ?? event.tool_call_id ?? ''
				);
				const pending = callId ? this._pendingToolCalls.get(callId) : undefined;
				if (pending) {
					// Parse accumulated arguments
					let parameters: any = {};
					try {
						parameters = JSON.parse(pending.argsBuffer || '{}');
					} catch {
						parameters = { _raw_args: pending.argsBuffer };
					}

					// Add _meta so the bridge can extract display metadata and server_executed flag
					if (typeof parameters === 'object' && parameters !== null) {
						// Phantom/indicator tools have render_type="none" — they are UI signals
						// (e.g., "task_planning" showing "任务规划中") that should NOT render
						// as visible tool cards.  All other tools default to "CodeApply".
						const isPhantom = PHANTOM_TOOL_NAMES.has(pending.name);
						parameters._meta = {
							server_executed: true,
							display_name: pending.name,
							render_type: isPhantom ? 'none' : 'CodeApply',
							default_show: !isPhantom,
						};
					}

					progress.report(new vscode.LanguageModelToolCallPart(callId, pending.name, parameters));
					this._pendingToolCalls.delete(callId);
					console.log(`[Knot] Tool call emitted: ${pending.name} (id=${callId}, argsLen=${pending.argsBuffer.length})`);
				} else {
					console.log(`[Knot] Tool call ended (no pending call for id=${callId})`);
				}
				return true;
			}
			case 'TOOL_CALL_RESULT':
			case 'TOOLCALLRESULT': {
				// Server-side tool result — the Knot backend already incorporated this
				// into subsequent text responses. Just log it.
				const callId = String(
					rawEvent.toolCallId ?? rawEvent.tool_call_id ?? rawEvent.id
					?? event.toolCallId ?? event.tool_call_id ?? ''
				);
				console.log(`[Knot] Tool call result received for id=${callId}`);
				return true;
			}
			default:
				return false;
		}
	}

	/**
	 * Check if an event type is a lifecycle or heartbeat event that should be silently ignored.
	 */
	private _isLifecycleOrHeartbeat(normalizedType: string): boolean {
		switch (normalizedType) {
			case 'HEARTBEAT':
			case 'STEP_STARTED':
			case 'STEPSTARTED':
			case 'STEP_FINISHED':
			case 'STEPFINISHED':
			case 'RUN_STARTED':
			case 'RUNSTARTED':
			case 'RUN_FINISHED':
			case 'RUNFINISHED':
			case 'RUN_ERROR':
			case 'RUNERROR':
				return true;
			default:
				return false;
		}
	}

	private _translateEvent(
		event: Record<string, unknown>,
	): vscode.LanguageModelResponsePart | undefined {
		const eventType = String(event.type ?? event.event_type ?? '');
		if (!eventType) {
			console.log(
				`[Knot] _translateEvent: no type, keys=${Object.keys(event).join(',')}`,
			);
			return undefined;
		}

		// allow-any-unicode-next-line
		// 获取 rawEvent（AG-UI 协议的内容在 rawEvent 中）
		const rawEvent = (event.rawEvent ?? {}) as Record<string, unknown>;

		// allow-any-unicode-next-line
		// 归一化事件类型：同时兼容 PascalCase 和 UPPER_SNAKE_CASE
		const normalized = eventType.toUpperCase().replace(/-/g, '_');

		// allow-any-unicode-next-line
		// 从 rawEvent 中获取内容（AG-UI 协议标准位置）
		let content: string = '';
		if (rawEvent.content !== null) {
			content = String(rawEvent.content);
		} else if (event.delta !== null) {
			content = String(event.delta);
		}

		switch (normalized) {
			case 'TEXT_MESSAGE_CONTENT':
			// allow-any-unicode-next-line
			case 'TEXTMESSAGECONTENT': // 防止 PascalCase 被意外处理
				if (content) {
					return new vscode.LanguageModelTextPart(content);
				}
				return undefined;
			case 'THINKING_TEXT_MESSAGE_CONTENT':
			case 'THINKINGTEXTMESSAGECONTENT':
				// allow-any-unicode-next-line
				// 思考内容：通过额外的标记返回（VS Code LM API 可能不支持思考事件）
				// allow-any-unicode-next-line
				// 暂时作为普通文本返回，前端会处理
				if (content) {
					return new vscode.LanguageModelTextPart(content);
				}
				return undefined;
			case 'TEXT_MESSAGE_START':
			case 'TEXTMESSAGESTART':
			case 'TEXT_MESSAGE_END':
			case 'TEXTMESSAGEEND':
			case 'THINKING_TEXT_MESSAGE_START':
			case 'THINKINGTEXTMESSAGESTART':
			case 'THINKING_TEXT_MESSAGE_END':
			case 'THINKINGTEXTMESSAGEEND':
				// allow-any-unicode-next-line
				// 文本消息生命周期事件：忽略
				return undefined;
			default:
				// allow-any-unicode-next-line
				// 工具调用事件 (TOOL_CALL_START/ARGS/END/RESULT) 和生命周期事件
				// (HEARTBEAT/STEP_STARTED/STEP_FINISHED/RUN_*) 已在调用方处理，不应到达此处。
				// 如果到达，说明是未知事件类型。
				console.log(`[Knot] _translateEvent: unhandled type='${eventType}'`);
				// allow-any-unicode-next-line
				// 宽松处理：如果有 content 也尝试返回
				if (content && content.length > 0 && content !== '{}') {
					return new vscode.LanguageModelTextPart(content);
				}
				return undefined;
		}
	}

	/**
// allow-any-unicode-next-line
	 * 读取 agent 实例配置的技能清单，生成注入到 system prompt 的文本。
// allow-any-unicode-next-line
	 * 读取 `.sarosisworkspace/employees.json` 找到 agentDir，然后读取
// allow-any-unicode-next-line
	 * `.agents/skills/` 和 `.sarosisworkspace/agents/<agentDir>/skills/` 目录下的技能。
	 */
	private async _getAgentSkillsManifest(
		workspacePath: string,
		agentId: string,
	): Promise<string> {
		try {
			// 1. Read employees.json to find agentDir for agentId
			const employeesPath = path.join(
				workspacePath,
				'.sarosisworkspace',
				'employees.json',
			);
			if (!fs.existsSync(employeesPath)) {
				console.log(
					`[Knot] _getAgentSkillsManifest: employees.json not found at ${employeesPath}`,
				);
				return '';
			}

			const employeesContent = fs.readFileSync(employeesPath, 'utf-8');
			const employees = JSON.parse(employeesContent) as Array<{
				id: string;
				agentDir: string;
				[key: string]: unknown;
			}>;
			const employee = employees.find((e) => e.id === agentId);
			if (!employee) {
				console.log(
					`[Knot] _getAgentSkillsManifest: agent ${agentId} not found in employees.json`,
				);
				return '';
			}

			const agentDir = employee.agentDir;
			if (!agentDir) {
				console.log(
					`[Knot] _getAgentSkillsManifest: agent ${agentId} has no agentDir`,
				);
				return '';
			}

			// 2. Read .agents/skills/ and .sarosisworkspace/agents/<agentDir>/skills/ to get skills
			const workspaceSkillsDir = path.join(workspacePath, '.agents', 'skills');
			const agentSkillsDir = path.join(workspacePath, '.sarosisworkspace', 'agents', agentDir, 'skills');
			
			// Collect skill entries from both locations: {name, basePath}
			const skillEntries: Array<{name: string, basePath: string}> = [];
			
			// Read workspace skills directory (.agents/skills/)
			if (fs.existsSync(workspaceSkillsDir)) {
				const dirs = fs.readdirSync(workspaceSkillsDir, { withFileTypes: true })
					.filter((d) => d.isDirectory())
					.map((d) => d.name);
				for (const dir of dirs) {
					skillEntries.push({ name: dir, basePath: workspaceSkillsDir });
				}
			} else {
				console.log(`[Knot] _getAgentSkillsManifest: workspace skills dir not found at ${workspaceSkillsDir}`);
			}
			
			// Read agent skills directory (.sarosisworkspace/agents/<agentDir>/skills/)
			if (fs.existsSync(agentSkillsDir)) {
				const dirs = fs.readdirSync(agentSkillsDir, { withFileTypes: true })
					.filter((d) => d.isDirectory())
					.map((d) => d.name);
				for (const dir of dirs) {
					skillEntries.push({ name: dir, basePath: agentSkillsDir });
				}
			} else {
				console.log(`[Knot] _getAgentSkillsManifest: agent skills dir not found at ${agentSkillsDir}`);
			}
			
			if (skillEntries.length === 0) {
				console.log(`[Knot] _getAgentSkillsManifest: no skill directories found`);
				return '';
			}

			// 3. Format as <available_skills> with paths
			const lines: string[] = [
				'',
				'## Skills',
				'',
				`Scan <available_skills> below. If one clearly applies to the user's task, use the \`read_skill\` tool with the skill id to load its full instructions, then follow them.`,
				'If several apply, choose the most specific. If none clearly apply, read none.',
				'One skill at a time max. Never guess/fabricate skill content.',
				'',
				'<available_skills>',
			];

			for (const entry of skillEntries) {
				const skillMdPath = path.join(entry.basePath, entry.name, 'SKILL.md');
				let name = entry.name;
				let description = '';
				if (fs.existsSync(skillMdPath)) {
					try {
						const content = fs.readFileSync(skillMdPath, 'utf-8');
						// Extract frontmatter to get name and description
						const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
						if (frontmatterMatch) {
							const frontmatter = frontmatterMatch[1];
							const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
							if (nameMatch) {
								name = nameMatch[1].trim();
							}
							const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
							if (descMatch) {
								description = descMatch[1].trim();
							}
						}
					} catch {
						// ignore
					}
				}

				// Generate relative path for knot-cli
				const relativePath = entry.basePath.includes('.agents/skills') 
					? `.agents/skills/${entry.name}/`
					: `.sarosisworkspace/agents/${agentDir}/skills/${entry.name}/`;
				const skillPath = relativePath;
				lines.push('  <skill>');
				lines.push(`    <name>${name}</name>`);
				lines.push(`    <description>${description}</description>`);
				lines.push(`    <id>${entry.name}</id>`);
				lines.push(`    <path>${skillPath}</path>`);
				lines.push('  </skill>');
			}

		lines.push('</available_skills>');
			lines.push('');
			lines.push(`(${skillEntries.length} skills total)`);
			lines.push('');
			
			const result = lines.join('\n');
			console.log(
				`[Knot] _getAgentSkillsManifest: found ${skillEntries.length} skill(s), manifest length=${result.length}`,
			);
			return result;
		} catch (err) {
			console.log(
				`[Knot] _getAgentSkillsManifest error: ${err instanceof Error ? err.message : String(err)}`,
			);
			return '';
		}
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new KnotChatProvider(context.globalState);
	context.subscriptions.push(provider);

	const registration = vscode.lm.registerLanguageModelChatProvider(
		VENDOR,
		provider,
	);
	context.subscriptions.push(registration);

	// Re-broadcast model list when the user edits knot.agents / token / endpoint.
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('knot')) {
				provider.notifyModelsChanged();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('knot.openSettings', () => {
			void vscode.commands.executeCommand(
				'workbench.action.openSettings',
				'@ext:sarosis.sarosis-knot-agui',
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('knot.refreshAgents', () => {
			provider.notifyModelsChanged();
			void vscode.window.showInformationMessage('Knot agent list refreshed.');
		}),
	);

	// allow-any-unicode-next-line
	// ─── CLI lifecycle commands ──────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'knot.checkCli',
			async (): Promise<KnotCliStatus> => {
				const status = await detectKnotCli();
				console.log(
					`[Knot] knot.checkCli -> installed=${status.installed} version='${status.version ?? ''}' path='${status.path ?? ''}'`,
				);
				return status;
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'knot.installCli',
			async (rawToken?: unknown): Promise<KnotInstallResult> => {
				const token =
					typeof rawToken === 'string' && rawToken.trim().length > 0
						? rawToken.trim()
						: (
							vscode.workspace
								.getConfiguration('knot')
								.get<string>('token') ?? ''
						).trim();
				if (!token) {
					const msg =
						// allow-any-unicode-next-line
						'Knot token is empty. 请先在 Configuration 中填写并保存 Token，再点击安装。';
					void vscode.window.showErrorMessage(msg);
					return { ok: false, message: msg };
				}
				try {
					await runKnotCliInstall(token);
					return {
						ok: true,
						// allow-any-unicode-next-line
						message: 'Install command sent to terminal. 请在终端中查看进度。',
					};
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.log(`[Knot] install failed: ${msg}`);
					return { ok: false, message: msg };
				}
			},
		),
	);

	// allow-any-unicode-next-line
	// ─── Workspace lifecycle bridge ──────────────────────────────────────
	// Two halves:
	//   1) Public commands `knot.workspace.add` / `knot.workspace.remove` /
	// allow-any-unicode-next-line
	//      `knot.workspace.list` — direct CLI operations callable by anyone.
	// allow-any-unicode-next-line
	//   2) Hidden commands `knot.workspaceSync` / `knot.workspaceUnsync` —
	//      consumed by the host's IWorkspaceLifecycleService when an Agent
	//      Studio workspace is created / deleted. They merely guard on
	//      'token configured + CLI installed' before delegating to (1).

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'knot.workspace.list',
			async (): Promise<KnotWorkspaceCliResult> => {
				return runKnotWorkspaceCli(['workspace', '--action', 'list']);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'knot.workspace.add',
			async (workspacePath?: unknown): Promise<KnotWorkspaceCliResult> => {
				const p = normalizeWorkspacePath(workspacePath);
				if (!p) {
					return { ok: false, message: 'workspace path is empty' };
				}
				return runKnotWorkspaceCli([
					'workspace',
					'--action',
					'add',
					'--path',
					p,
				]);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'knot.workspace.remove',
			async (workspacePath?: unknown): Promise<KnotWorkspaceCliResult> => {
				const p = normalizeWorkspacePath(workspacePath);
				if (!p) {
					return { ok: false, message: 'workspace path is empty' };
				}
				return runKnotWorkspaceCli([
					'workspace',
					'--action',
					'remove',
					'--path',
					p,
				]);
			},
		),
	);

	// Bridge command for IWorkspaceLifecycleService (Created event).
	// Payload shape comes from src/vs/sessions/contrib/agentStudio/common/workspaceLifecycle.ts:
	//   { id, name, path?, timestamp }
	// We only act if (a) token is set, (b) CLI is installed, and (c) path is non-empty.
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'knot.workspaceSync',
			async (payload?: unknown): Promise<KnotWorkspaceCliResult> => {
				const ws = payload as
					| { id?: string; name?: string; path?: string }
					| undefined;
				const wsPath = normalizeWorkspacePath(ws?.path);
				if (!wsPath) {
					console.log(
						`[Knot] workspaceSync skipped: empty path (workspace=${ws?.id ?? '?'} name=${ws?.name ?? '?'})`,
					);
					return {
						ok: false,
						skipped: true,
						message: 'workspace has no filesystem path',
					};
				}
				if (!isKnotConfigured()) {
					console.log(`[Knot] workspaceSync skipped: knot.token is empty`);
					return {
						ok: false,
						skipped: true,
						message: 'knot.token is not configured',
					};
				}
				const cliStatus = await detectKnotCli();
				if (!cliStatus.installed) {
					console.log(
						`[Knot] workspaceSync skipped: knot-cli is not installed`,
					);
					return {
						ok: false,
						skipped: true,
						message: 'knot-cli is not installed',
					};
				}
				console.log(
					`[Knot] workspaceSync -> add path='${wsPath}' (workspace=${ws?.id ?? '?'} name=${ws?.name ?? '?'})`,
				);
				const result = await runKnotWorkspaceCli([
					'workspace',
					'--action',
					'add',
					'--path',
					wsPath,
				]);
				if (result.ok) {
					// After successfully adding workspace, fetch connection_uuid
					try {
						const clientStatus = await getKnotClientStatus();
						context.globalState.update(
							'knot.connection_uuid',
							clientStatus.connection_uuid,
						);
						console.log(
							`[Knot] workspaceSync: updated connection_uuid=${clientStatus.connection_uuid}`,
						);
					} catch (err) {
						console.log(
							`[Knot] workspaceSync: failed to get connection_uuid: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				return result;
			},
		),
	);

	// Bridge command for IWorkspaceLifecycleService (Deleted event).
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'knot.workspaceUnsync',
			async (payload?: unknown): Promise<KnotWorkspaceCliResult> => {
				const ws = payload as
					| { id?: string; name?: string; path?: string }
					| undefined;
				const wsPath = normalizeWorkspacePath(ws?.path);
				if (!wsPath) {
					console.log(
						`[Knot] workspaceUnsync skipped: empty path (workspace=${ws?.id ?? '?'})`,
					);
					return {
						ok: false,
						skipped: true,
						message: 'workspace has no filesystem path',
					};
				}
				if (!isKnotConfigured()) {
					console.log(`[Knot] workspaceUnsync skipped: knot.token is empty`);
					return {
						ok: false,
						skipped: true,
						message: 'knot.token is not configured',
					};
				}
				const cliStatus = await detectKnotCli();
				if (!cliStatus.installed) {
					console.log(
						`[Knot] workspaceUnsync skipped: knot-cli is not installed`,
					);
					return {
						ok: false,
						skipped: true,
						message: 'knot-cli is not installed',
					};
				}
				console.log(
					`[Knot] workspaceUnsync -> remove path='${wsPath}' (workspace=${ws?.id ?? '?'})`,
				);
				return runKnotWorkspaceCli([
					'workspace',
					'--action',
					'remove',
					'--path',
					wsPath,
				]);
			},
		),
	);

	// Self-register into the host's lifecycle bus. Best-effort: silently no-op
	// when the host command is not available (e.g. running inside vanilla VS Code
	// without the agentStudio contribution).
	void registerWorkspaceLifecycleHook();

	// Auto-check CLI on activation (best-effort, fire-and-forget).
	void detectKnotCli().then((status) => {
		console.log(
			`[Knot] auto-check on activate -> installed=${status.installed} version='${status.version ?? ''}'`,
		);
	});

	// Clean up any stale `local-` prefixed UUIDs that were saved by a previous version.
	// These are not valid Knot connection_uuids and cause 400 errors when sent to the backend.
	const staleUuid = context.globalState.get('knot.connection_uuid') as
		| string
		| undefined;
	if (staleUuid && staleUuid.startsWith('local-')) {
		void context.globalState.update('knot.connection_uuid', undefined);
		console.log(`[Knot] cleaned up stale local- prefixed UUID: ${staleUuid}`);
	}

	// Auto-fetch connection_uuid on activation (best-effort, fire-and-forget).
	// This saves the connection_uuid to globalState so it can be used in chat_extra.agent_client_uuid.
	// allow-any-unicode-next-line
	// If knot-cli is not available, we simply skip — agent_client_uuid will be omitted from requests.
	void getKnotClientStatus()
		.then(async (clientStatus) => {
			await context.globalState.update(
				'knot.connection_uuid',
				clientStatus.connection_uuid,
			);
			console.log(
				`[Knot] auto-fetch connection_uuid on activate -> ${clientStatus.connection_uuid}`,
			);
			console.log(`[Knot] connection_uuid: ${clientStatus.connection_uuid}`);
		})
		.catch((err) => {
			console.log(
				`[Knot] auto-fetch connection_uuid failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			console.log(
				`[Knot] connection_uuid: <not available> (${err instanceof Error ? err.message : String(err)})`,
			);
		});

	console.log(
		// allow-any-unicode-next-line
		`[Knot] activate() — registered chat provider, vendor='${VENDOR}'`,
	);

	// Auto-add local resources directory to knot-cli workspace on activation (fire-and-forget).
	void autoAddLocalResourcesDirToKnotWorkspace();
}

/**
 * Find the AgentStudio app's resources directory by trying multiple candidate paths.
 * This ensures the function works in both development and production environments.
 *
 * Returns the `resources/` directory path (e.g. `/path/to/resources`),
 * which contains `.agents/skills/` and other app resources.
 */
async function findResourcesDir(): Promise<string | undefined> {
	const candidates: string[] = [];

	// 1. Development environment: project root directory (check if package.json exists to verify)
	const projectRootCandidate = path.join(process.cwd(), 'resources');
	if (fs.existsSync(projectRootCandidate) && fs.existsSync(path.join(process.cwd(), 'package.json'))) {
		console.log(`[Knot] findResourcesDir: found at project root ${projectRootCandidate}`);
		return projectRootCandidate;
	}
	candidates.push(projectRootCandidate);

	// 2. Development environment: walk up from __dirname to find project root
	//    Stop when we find a directory that contains 'resources'
	let currentDir = __dirname;
	for (let i = 0; i < 10; i++) {
		const candidate = path.join(currentDir, 'resources');
		// Check if this is likely the project root (has package.json or .git)
		const likelyProjectRoot = fs.existsSync(path.join(currentDir, 'package.json')) || fs.existsSync(path.join(currentDir, '.git'));
		if (fs.existsSync(candidate) && likelyProjectRoot) {
			console.log(`[Knot] findResourcesDir: found at project root ${candidate}`);
			return candidate;
		}
		candidates.push(candidate);
		currentDir = path.dirname(currentDir);
		if (currentDir === path.dirname(currentDir)) {
			// Reached root
			break;
		}
	}

	// 3. Production environment: app install directory
	const appInstallDir = getAppInstallDir();
	candidates.push(path.join(appInstallDir, 'resources'));

	// 4. macOS .app bundle: Contents/Resources/
	if (process.platform === 'darwin') {
		candidates.push(path.join(appInstallDir, 'Contents', 'Resources'));
	}

	// Try each candidate, verify that resources exists
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			console.log(`[Knot] findResourcesDir: found at ${candidate}`);
			return candidate;
		}
	}

	console.log(`[Knot] findResourcesDir: not found. Candidates tried: ${candidates.join(', ')}`);
	return undefined;
}

/**
 * Automatically add the AgentStudio app's resources directory to knot-cli workspace on activation.
 * This ensures that knot agents can access the built-in skills and other resources of the AgentStudio app.
 *
 * Steps:
 *   1. Find the resources directory using multiple candidate paths
 *   2. Check if knot-cli is installed
 *   3. Get knot client status to see if the resources directory is already in workspace paths
 *   4. If not, add it using `knot-cli workspace --action add --path <path>`
 */
async function autoAddLocalResourcesDirToKnotWorkspace(): Promise<void> {
	try {
		// 1. Find the resources directory
		const resourcesDir = await findResourcesDir();
		if (!resourcesDir) {
			console.log('[Knot] autoAddLocalResourcesDirToKnotWorkspace: resources directory not found, skipping');
			return;
		}

		console.log(`[Knot] autoAddLocalResourcesDirToKnotWorkspace: checking resources directory: ${resourcesDir}`);

		// 2. Check if knot-cli is installed
		const cliStatus = await detectKnotCli();
		if (!cliStatus.installed) {
			console.log('[Knot] autoAddLocalResourcesDirToKnotWorkspace: knot-cli is not installed, skipping');
			return;
		}

		// 3. Get knot client status to see if the resources directory is already in workspace paths
		let clientStatus: KnotClientStatus;
		try {
			clientStatus = await getKnotClientStatus();
		} catch (err) {
			console.log(`[Knot] autoAddLocalResourcesDirToKnotWorkspace: failed to get client status: ${err instanceof Error ? err.message : String(err)}, skipping`);
			return;
		}

		// Normalize paths for comparison (handle trailing slashes and backslashes)
		const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
		const normalizedResourcesDir = normalizePath(resourcesDir);

		// Check if the resources directory is already in the workspace paths
		const isAlreadyAdded = clientStatus.path.some((p) => normalizePath(p) === normalizedResourcesDir);

		if (isAlreadyAdded) {
			console.log(`[Knot] autoAddLocalResourcesDirToKnotWorkspace: resources directory is already in knot-cli workspace, skipping`);
			return;
		}

		// 4. Add it using `knot-cli workspace --action add --path <path>`
		console.log(`[Knot] autoAddLocalResourcesDirToKnotWorkspace: adding resources directory to knot-cli workspace: ${resourcesDir}`);
		const addResult = await runKnotWorkspaceCli([
			'workspace',
			'--action',
			'add',
			'--path',
			resourcesDir,
		]);

		if (addResult.ok) {
			console.log(`[Knot] autoAddLocalResourcesDirToKnotWorkspace: successfully added resources directory to knot-cli workspace`);
		} else {
			console.log(`[Knot] autoAddLocalResourcesDirToKnotWorkspace: failed to add resources directory: ${addResult.message ?? 'unknown error'}`);
		}
	} catch (err) {
		console.log(`[Knot] autoAddLocalResourcesDirToKnotWorkspace error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export function deactivate(): void {
	// Best-effort: unregister our lifecycle hooks so the host doesn't keep
	// dispatching events to a dead command. Safe to no-op when the host bus
	// is unavailable. We can't await here per VS Code API contract, so we
	// just kick off the calls.
	try {
		void vscode.commands.executeCommand(
			'agentStudio.workspaceLifecycle.unregister',
			'knot-agui',
		);
	} catch {
		// allow-any-unicode-next-line
		// ignore — host may already be torn down
	}
	try {
		void vscode.commands.executeCommand(
			'agentStudio.skillLifecycle.unregister',
			'knot-agui-skill',
		);
	} catch {
		// ignore
	}
	// context.subscriptions disposes the rest of our resources (terminal, commands).
}

// allow-any-unicode-next-line
// ─── Knot CLI: detection & install helpers ─────────────────────────────────

interface KnotCliStatus {
	readonly installed: boolean;
	readonly version?: string;
	readonly path?: string;
	readonly error?: string;
}

interface KnotInstallResult {
	readonly ok: boolean;
	readonly message: string;
}

/**
 * Detect whether `knot-cli` is available. Strategy:
 *   1. `knot-cli --version` on PATH (works if user already opened a fresh shell after install).
 *   2. Fall back to common install locations (`~/.knot/bin/knot-cli[.exe]`, `/usr/local/bin/knot-cli`).
 */
async function detectKnotCli(): Promise<KnotCliStatus> {
	// 1) PATH lookup
	const onPath = await tryRunVersion('knot-cli');
	if (onPath.installed) {
		return onPath;
	}

	// 2) Common locations
	const candidates = getCommonCliCandidates();
	for (const candidate of candidates) {
		try {
			if (!fs.existsSync(candidate)) {
				continue;
			}
			const result = await tryRunVersion(candidate);
			if (result.installed) {
				return { ...result, path: candidate };
			}
		} catch {
			// ignore individual candidate errors
		}
	}

	console.log(
		`[Knot] detectKnotCli: not found. Candidates checked: ${candidates.join(', ')}`,
	);
	return { installed: false, error: onPath.error };
}

function getCommonCliCandidates(): string[] {
	const home = os.homedir();
	const list: string[] = [];
	if (process.platform === 'win32') {
		list.push(path.join(home, '.knot', 'bin', 'knot-cli.exe'));
		list.push(path.join(home, '.knot', 'bin', 'knot-cli'));
	} else {
		list.push(path.join(home, '.knot', 'bin', 'knot-cli'));
		list.push('/usr/local/bin/knot-cli');
		list.push('/opt/homebrew/bin/knot-cli');
	}
	return list;
}

function tryRunVersion(executable: string): Promise<KnotCliStatus> {
	return new Promise<KnotCliStatus>((resolve) => {
		try {
			const child = cp.spawn(executable, ['--version'], {
				windowsHide: true,
				shell: false,
			});
			let stdout = '';
			let stderr = '';
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				try {
					child.kill();
				} catch {
					/* noop */
				}
				resolve({ installed: false, error: 'timeout' });
			}, 5000);

			child.stdout.on('data', (d: Buffer) => {
				stdout += d.toString();
			});
			child.stderr.on('data', (d: Buffer) => {
				stderr += d.toString();
			});

			child.on('error', (err) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve({ installed: false, error: err.message });
			});

			child.on('close', (code) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (code === 0) {
					const text = (stdout || stderr).trim();
					const version = text.split(/\r?\n/)[0]?.trim();
					resolve({ installed: true, version, path: executable });
				} else {
					resolve({
						installed: false,
						error: stderr.trim() || `exit code ${code}`,
					});
				}
			});
		} catch (err) {
			resolve({
				installed: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});
}

/**
 * Derive the IDE application install directory.
 *
 * `process.execPath` points to the electron binary (e.g.
 *   - Windows: `C:\Users\x\AppData\Local\Programs\SarosisIDE\sarosis.exe`
 *   - macOS:   `/Applications/SarosisIDE.app/Contents/MacOS/Electron`
 *   - Linux:   `/opt/sarosis/sarosis`
 * )
 * We walk up to the application root directory (the folder that contains
 * the executable or `.app` bundle) and use that as the `--workspace` value
 * for the knot install script, so that knot stores its agent data alongside
 * the running IDE installation.
 */
function getAppInstallDir(): string {
	const execDir = path.dirname(process.execPath);
	if (process.platform === 'darwin') {
		// allow-any-unicode-next-line
		// On macOS the execPath is inside Foo.app/Contents/MacOS/ — go up 3 levels
		// to reach the directory *containing* the .app bundle.
		const contentsIdx = execDir.indexOf('.app/Contents');
		if (contentsIdx !== -1) {
			return path.dirname(execDir.substring(0, contentsIdx + '.app'.length));
		}
	}
	// Windows / Linux: the executable sits at the top-level install dir.
	return execDir;
}

/**
 * Run the official Knot CLI install script in an integrated terminal so the
 * user can watch progress and react to prompts.
 *
 * Platform strategy:
 *   - **Windows**: uses the PowerShell install script (`install.ps1`).
 *   - **macOS/Linux**: uses the Bash install script (`install.sh` via curl).
 *
 * The `--workspace` parameter points to the IDE application install directory
 * (derived from `process.execPath`) so knot stores agent data relative to
 * the running IDE instance rather than `$HOME`.
 */
async function runKnotCliInstall(token: string): Promise<void> {
	const isWindows = process.platform === 'win32';
	const workspaceDir = getAppInstallDir();

	console.log(
		`[Knot] runKnotCliInstall: platform=${process.platform} workspace='${workspaceDir}'`,
	);

	if (isWindows) {
		// PowerShell-based install (no Git Bash dependency).
		// Command breakdown:
		//   1. Download install.ps1 to $env:TEMP
		//   2. Unblock the downloaded file
		//   3. Execute with -ExecutionPolicy Bypass
		const psCmd = [
			`Invoke-WebRequest -Uri 'https://mirrors.tencent.com/repository/generic/knot-cli/install.ps1' -OutFile '$env:TEMP\\install-agent.ps1'`,
			`Unblock-File '$env:TEMP\\install-agent.ps1'`,
			`PowerShell -ExecutionPolicy Bypass -File '$env:TEMP\\install-agent.ps1' --token ${psQuote(token)} --origin knot --workspace ${psQuote(workspaceDir)}`,
		].join('; ');

		const terminal = vscode.window.createTerminal({
			name: 'Knot CLI Install',
			shellPath: 'powershell.exe',
			// Use -NoExit so the terminal stays open after the install finishes
			// allowing the user to see results.
		});
		terminal.show(true);
		terminal.sendText(psCmd, true);
	} else {
		// Bash-based install (macOS / Linux).
		const installCmd =
			`curl -fsSL 'https://mirrors.tencent.com/repository/generic/knot-cli/install.sh' ` +
			`| bash -s -- --token ${shellQuote(token)} --origin knot --workspace ${shellQuote(workspaceDir)}`;

		const terminal = vscode.window.createTerminal({ name: 'Knot CLI Install' });
		terminal.show(true);
		terminal.sendText(installCmd, true);
		terminal.sendText(`echo ''`, true);
		terminal.sendText(
			// allow-any-unicode-next-line
			`echo '[Knot] 如安装成功，请执行: source ~/.bashrc 或新开终端使用 knot-cli。'`,
			true,
		);
	}

	console.log(`[Knot] runKnotCliInstall: launched in terminal`);

	// Re-detect after a short delay so the UI can reflect status updates.
	setTimeout(() => {
		void vscode.commands.executeCommand('knot.checkCli');
	}, 8000);
}

/**
// allow-any-unicode-next-line
 * Quote a value for PowerShell — wraps in single quotes, escaping embedded single quotes.
 */
function psQuote(value: string): string {
	return `'${value.replace(/'/g, `''`)}'`;
}

function shellQuote(value: string): string {
	// Single-quote and escape any embedded single quotes for POSIX shell.
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

// allow-any-unicode-next-line
// ─── Knot CLI: workspace sub-command helpers ───────────────────────────────

interface KnotWorkspaceCliResult {
	readonly ok: boolean;
	/** True when the call deliberately did nothing (e.g. token missing, CLI absent). */
	readonly skipped?: boolean;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exitCode?: number;
	readonly message?: string;
}

// allow-any-unicode-next-line
/** Knot CLI client-status 命令的输出格式 */
interface KnotClientStatus {
	readonly arch: string;
	readonly branch: string;
	readonly command: string;
	readonly commit: string;
	readonly connection_uuid: string;
	readonly host_user: string;
	readonly host_user_group: string;
	readonly instance_id: string;
	readonly ip: string;
	readonly last_active_time: string;
	readonly last_ask_time: string;
	readonly origin: string;
	readonly os: string;
	readonly path: readonly string[];
	readonly pid: number;
	readonly server_port: number;
	readonly status: string;
	readonly user: string;
	readonly uuid: string;
	readonly version: string;
}

function isKnotConfigured(): boolean {
	const cfg = vscode.workspace.getConfiguration('knot');
	const token = (cfg.get<string>('token') ?? '').trim();
	return token.length > 0;
}

function normalizeWorkspacePath(raw: unknown): string {
	if (typeof raw !== 'string') {
		return '';
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return '';
	}
	// allow-any-unicode-next-line
	// Best-effort normalization — keep absolute paths as-is. We do NOT resolve
	// relative paths because the CLI itself accepts them and the host has
	// already canonicalized via VS Code workspace folder.
	return trimmed;
}

/**
 * Run `knot-cli <args...>` non-interactively and capture stdout/stderr.
 * Used by `knot.workspace.{list,add,remove}` and the lifecycle bridge.
 *
 * The executable is located via the same strategy as `detectKnotCli` so the
 * sub-commands work even if `knot-cli` was just installed and is not yet on
 * PATH (e.g. before the user runs `source ~/.bashrc`).
 */
async function runKnotWorkspaceCli(
	args: string[],
): Promise<KnotWorkspaceCliResult> {
	const cliStatus = await detectKnotCli();
	if (!cliStatus.installed) {
		return { ok: false, skipped: true, message: 'knot-cli is not installed' };
	}
	const executable = cliStatus.path ?? 'knot-cli';
	console.log(`[Knot] runKnotWorkspaceCli: ${executable} ${args.join(' ')}`);

	return new Promise<KnotWorkspaceCliResult>((resolve) => {
		try {
			// Inherit env so the CLI picks up KNOT_TOKEN / config file like a
			// normal shell invocation. We also forward HOME / USERPROFILE
			// implicitly through `process.env`.
			const child = cp.spawn(executable, args, {
				windowsHide: true,
				shell: false,
				env: process.env,
			});

			let stdout = '';
			let stderr = '';
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				try {
					child.kill();
				} catch {
					/* noop */
				}
				resolve({
					ok: false,
					message: 'knot-cli call timed out after 30s',
					stdout,
					stderr,
				});
			}, 30_000);

			child.stdout.on('data', (d: Buffer) => {
				stdout += d.toString();
			});
			child.stderr.on('data', (d: Buffer) => {
				stderr += d.toString();
			});

			child.on('error', (err) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				console.log(`[Knot] runKnotWorkspaceCli error: ${err.message}`);
				resolve({ ok: false, message: err.message, stdout, stderr });
			});

			child.on('close', (code) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				const ok = code === 0;
				console.log(
					`[Knot] runKnotWorkspaceCli exit=${code} stdout_len=${stdout.length} stderr_len=${stderr.length}`,
				);
				if (!ok && stderr.trim()) {
					console.log(`[Knot] runKnotWorkspaceCli stderr: ${stderr.trim()}`);
				}
				resolve({
					ok,
					exitCode: code ?? undefined,
					stdout,
					stderr,
					message: ok
						? undefined
						: stderr.trim() || `knot-cli exited with code ${code}`,
				});
			});
		} catch (err) {
			resolve({
				ok: false,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	});
}

/**
 * Run `knot-cli client-status` and parse the JSON output to get connection_uuid.
 * Returns the parsed KnotClientStatus or throws an error.
 */
async function getKnotClientStatus(): Promise<KnotClientStatus> {
	const cliStatus = await detectKnotCli();
	if (!cliStatus.installed) {
		throw new Error('knot-cli is not installed');
	}
	const executable = cliStatus.path ?? 'knot-cli';
	console.log(`[Knot] getKnotClientStatus: ${executable} client-status`);

	return new Promise<KnotClientStatus>((resolve, reject) => {
		try {
			const child = cp.spawn(executable, ['client-status'], {
				windowsHide: true,
				shell: false,
				env: process.env,
			});

			let stdout = '';
			let stderr = '';
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				try {
					child.kill();
				} catch {
					/* noop */
				}
				reject(new Error(`knot-cli client-status timed out after 30s`));
			}, 30_000);

			child.stdout.on('data', (d: Buffer) => {
				stdout += d.toString();
			});
			child.stderr.on('data', (d: Buffer) => {
				stderr += d.toString();
			});

			child.on('error', (err) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				reject(err);
			});

			child.on('close', (code) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);

				if (code === 0) {
					try {
						// allow-any-unicode-next-line
						// knot-cli may output a status prefix like '✅ success\n' before the JSON payload.
						// Extract the JSON portion by finding the first '{' (or '[') and parsing from there.
						const raw = stdout.trim();
						const jsonStart = raw.indexOf('{');
						const jsonStartAlt = raw.indexOf('[');
						const firstJson =
							jsonStart === -1
								? jsonStartAlt
								: jsonStartAlt === -1
									? jsonStart
									: Math.min(jsonStart, jsonStartAlt);
						if (firstJson === -1) {
							throw new Error(
								`No JSON object found in output: ${raw.slice(0, 200)}`,
							);
						}
						const status: KnotClientStatus = JSON.parse(raw.slice(firstJson));
						console.log(
							`[Knot] getKnotClientStatus: connection_uuid=${status.connection_uuid}`,
						);
						resolve(status);
					} catch (parseErr) {
						reject(
							new Error(
								`Failed to parse client-status output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
							),
						);
					}
				} else {
					reject(
						new Error(
							`knot-cli client-status exited with code ${code}: ${stderr.trim()}`,
						),
					);
				}
			});
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

/**
 * Subscribe this extension's `knot.workspaceSync` / `knot.workspaceUnsync`
 * commands to the host's IWorkspaceLifecycleService (registered by the
 * agentStudio contribution).
 *
 * The host exposes the registration as a plain VS Code command, so we are
 * not coupled to any internal host type. If the command is unavailable
// allow-any-unicode-next-line
 * (e.g. running on stock VS Code), we silently no-op — the chat provider
 * still works, only the CLI workspace mirroring is disabled.
 */
async function registerWorkspaceLifecycleHook(): Promise<void> {
	try {
		const allCommands = await vscode.commands.getCommands(true);
		if (!allCommands.includes('agentStudio.workspaceLifecycle.register')) {
			console.log(
				// allow-any-unicode-next-line
				'[Knot] workspace lifecycle bus not available — skipping hook registration.',
			);
			return;
		}
		await vscode.commands.executeCommand(
			'agentStudio.workspaceLifecycle.register',
			{
				id: 'knot-agui',
				onCreated: 'knot.workspaceSync',
				onDeleted: 'knot.workspaceUnsync',
			},
		);
		console.log(
			'[Knot] registered workspace lifecycle hook (id=knot-agui, onCreated=knot.workspaceSync, onDeleted=knot.workspaceUnsync)',
		);
	} catch (err) {
		console.log(
			`[Knot] registerWorkspaceLifecycleHook failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
