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
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

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

	// ─── CLI lifecycle commands ──────────────────────────────────────────
	context.subscriptions.push(vscode.commands.registerCommand('knot.checkCli', async (): Promise<KnotCliStatus> => {
		const status = await detectKnotCli(output);
		output.appendLine(`[Knot] knot.checkCli -> installed=${status.installed} version="${status.version ?? ''}" path="${status.path ?? ''}"`);
		return status;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('knot.installCli', async (rawToken?: unknown): Promise<KnotInstallResult> => {
		const token = typeof rawToken === 'string' && rawToken.trim().length > 0
			? rawToken.trim()
			: (vscode.workspace.getConfiguration('knot').get<string>('token') ?? '').trim();
		if (!token) {
			const msg = 'Knot token is empty. 请先在 Configuration 中填写并保存 Token，再点击安装。';
			void vscode.window.showErrorMessage(msg);
			return { ok: false, message: msg };
		}
		try {
			await runKnotCliInstall(token, output);
			return { ok: true, message: 'Install command sent to terminal. 请在终端中查看进度。' };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			output.appendLine(`[Knot] install failed: ${msg}`);
			return { ok: false, message: msg };
		}
	}));

	// ─── Workspace lifecycle bridge ──────────────────────────────────────
	// Two halves:
	//   1) Public commands `knot.workspace.add` / `knot.workspace.remove` /
	//      `knot.workspace.list` — direct CLI operations callable by anyone.
	//   2) Hidden commands `knot.workspaceSync` / `knot.workspaceUnsync` —
	//      consumed by the host's IWorkspaceLifecycleService when an Agent
	//      Studio workspace is created / deleted. They merely guard on
	//      "token configured + CLI installed" before delegating to (1).

	context.subscriptions.push(vscode.commands.registerCommand('knot.workspace.list', async (): Promise<KnotWorkspaceCliResult> => {
		return runKnotWorkspaceCli(['workspace', '--action', 'list'], output);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('knot.workspace.add', async (workspacePath?: unknown): Promise<KnotWorkspaceCliResult> => {
		const p = normalizeWorkspacePath(workspacePath);
		if (!p) {
			return { ok: false, message: 'workspace path is empty' };
		}
		return runKnotWorkspaceCli(['workspace', '--action', 'add', '--path', p], output);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('knot.workspace.remove', async (workspacePath?: unknown): Promise<KnotWorkspaceCliResult> => {
		const p = normalizeWorkspacePath(workspacePath);
		if (!p) {
			return { ok: false, message: 'workspace path is empty' };
		}
		return runKnotWorkspaceCli(['workspace', '--action', 'remove', '--path', p], output);
	}));

	// Bridge command for IWorkspaceLifecycleService (Created event).
	// Payload shape comes from src/vs/sessions/contrib/agentStudio/common/workspaceLifecycle.ts:
	//   { id, name, path?, timestamp }
	// We only act if (a) token is set, (b) CLI is installed, and (c) path is non-empty.
	context.subscriptions.push(vscode.commands.registerCommand('knot.workspaceSync', async (payload?: unknown): Promise<KnotWorkspaceCliResult> => {
		const ws = payload as { id?: string; name?: string; path?: string } | undefined;
		const wsPath = normalizeWorkspacePath(ws?.path);
		if (!wsPath) {
			output.appendLine(`[Knot] workspaceSync skipped: empty path (workspace=${ws?.id ?? '?'} name=${ws?.name ?? '?'})`);
			return { ok: false, skipped: true, message: 'workspace has no filesystem path' };
		}
		if (!isKnotConfigured()) {
			output.appendLine(`[Knot] workspaceSync skipped: knot.token is empty`);
			return { ok: false, skipped: true, message: 'knot.token is not configured' };
		}
		const cliStatus = await detectKnotCli(output);
		if (!cliStatus.installed) {
			output.appendLine(`[Knot] workspaceSync skipped: knot-cli is not installed`);
			return { ok: false, skipped: true, message: 'knot-cli is not installed' };
		}
		output.appendLine(`[Knot] workspaceSync -> add path="${wsPath}" (workspace=${ws?.id ?? '?'} name=${ws?.name ?? '?'})`);
		return runKnotWorkspaceCli(['workspace', '--action', 'add', '--path', wsPath], output);
	}));

	// Bridge command for IWorkspaceLifecycleService (Deleted event).
	context.subscriptions.push(vscode.commands.registerCommand('knot.workspaceUnsync', async (payload?: unknown): Promise<KnotWorkspaceCliResult> => {
		const ws = payload as { id?: string; name?: string; path?: string } | undefined;
		const wsPath = normalizeWorkspacePath(ws?.path);
		if (!wsPath) {
			output.appendLine(`[Knot] workspaceUnsync skipped: empty path (workspace=${ws?.id ?? '?'})`);
			return { ok: false, skipped: true, message: 'workspace has no filesystem path' };
		}
		if (!isKnotConfigured()) {
			output.appendLine(`[Knot] workspaceUnsync skipped: knot.token is empty`);
			return { ok: false, skipped: true, message: 'knot.token is not configured' };
		}
		const cliStatus = await detectKnotCli(output);
		if (!cliStatus.installed) {
			output.appendLine(`[Knot] workspaceUnsync skipped: knot-cli is not installed`);
			return { ok: false, skipped: true, message: 'knot-cli is not installed' };
		}
		output.appendLine(`[Knot] workspaceUnsync -> remove path="${wsPath}" (workspace=${ws?.id ?? '?'})`);
		return runKnotWorkspaceCli(['workspace', '--action', 'remove', '--path', wsPath], output);
	}));

	// Self-register into the host's lifecycle bus. Best-effort: silently no-op
	// when the host command is not available (e.g. running inside vanilla VS Code
	// without the agentStudio contribution).
	void registerWorkspaceLifecycleHook(output);

	// ─── Skill lifecycle bridge ──────────────────────────────────────────
	// When knot is configured (token + CLI), agent skill changes trigger a
	// sync of all workspace skills to the `.agents/skills/` directory so that
	// knot-cli can discover them (knot uses `.agents/` as its skill root,
	// whereas the host uses `.sarosisworkspace/agents/<dir>/skills/`).

	context.subscriptions.push(vscode.commands.registerCommand('knot.skillSync', async (payload?: unknown): Promise<KnotSkillSyncResult> => {
		return runKnotSkillSync(payload, output);
	}));

	// Register the skill lifecycle hook so the host's ISkillLifecycleService
	// routes skill events to `knot.skillSync`.
	void registerSkillLifecycleHook(output);

	// Auto-check CLI on activation (best-effort, fire-and-forget).
	void detectKnotCli(output).then(status => {
		output.appendLine(`[Knot] auto-check on activate -> installed=${status.installed} version="${status.version ?? ''}"`);
	});

	output.appendLine(`[Knot] activate() — registered chat provider, vendor="${VENDOR}"`);
}

export function deactivate(): void {
	// Best-effort: unregister our lifecycle hooks so the host doesn't keep
	// dispatching events to a dead command. Safe to no-op when the host bus
	// is unavailable. We can't await here per VS Code API contract, so we
	// just kick off the calls.
	try {
		void vscode.commands.executeCommand('agentStudio.workspaceLifecycle.unregister', 'knot-agui');
	} catch {
		// ignore — host may already be torn down
	}
	try {
		void vscode.commands.executeCommand('agentStudio.skillLifecycle.unregister', 'knot-agui-skill');
	} catch {
		// ignore
	}
	// context.subscriptions disposes the rest of our resources (output, terminal, commands).
}

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
async function detectKnotCli(output: vscode.OutputChannel): Promise<KnotCliStatus> {
	// 1) PATH lookup
	const onPath = await tryRunVersion('knot-cli');
	if (onPath.installed) {
		return onPath;
	}

	// 2) Common locations
	const candidates = getCommonCliCandidates();
	for (const candidate of candidates) {
		try {
			if (!fs.existsSync(candidate)) { continue; }
			const result = await tryRunVersion(candidate);
			if (result.installed) {
				return { ...result, path: candidate };
			}
		} catch {
			// ignore individual candidate errors
		}
	}

	output.appendLine(`[Knot] detectKnotCli: not found. Candidates checked: ${candidates.join(', ')}`);
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
	return new Promise<KnotCliStatus>(resolve => {
		try {
			const child = cp.spawn(executable, ['--version'], {
				windowsHide: true,
				shell: false,
			});
			let stdout = '';
			let stderr = '';
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) { return; }
				settled = true;
				try { child.kill(); } catch { /* noop */ }
				resolve({ installed: false, error: 'timeout' });
			}, 5000);

			child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
			child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

			child.on('error', err => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				resolve({ installed: false, error: err.message });
			});

			child.on('close', code => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				if (code === 0) {
					const text = (stdout || stderr).trim();
					const version = text.split(/\r?\n/)[0]?.trim();
					resolve({ installed: true, version, path: executable });
				} else {
					resolve({ installed: false, error: stderr.trim() || `exit code ${code}` });
				}
			});
		} catch (err) {
			resolve({ installed: false, error: err instanceof Error ? err.message : String(err) });
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
async function runKnotCliInstall(token: string, output: vscode.OutputChannel): Promise<void> {
	const isWindows = process.platform === 'win32';
	const workspaceDir = getAppInstallDir();

	output.appendLine(`[Knot] runKnotCliInstall: platform=${process.platform} workspace="${workspaceDir}"`);

	if (isWindows) {
		// PowerShell-based install (no Git Bash dependency).
		// Command breakdown:
		//   1. Download install.ps1 to $env:TEMP
		//   2. Unblock the downloaded file
		//   3. Execute with -ExecutionPolicy Bypass
		const psCmd = [
			`Invoke-WebRequest -Uri 'https://mirrors.tencent.com/repository/generic/knot-cli/install.ps1' -OutFile "$env:TEMP\\install-agent.ps1"`,
			`Unblock-File "$env:TEMP\\install-agent.ps1"`,
			`PowerShell -ExecutionPolicy Bypass -File "$env:TEMP\\install-agent.ps1" --token ${psQuote(token)} --origin knot --workspace ${psQuote(workspaceDir)}`,
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
		terminal.sendText('echo ""', true);
		terminal.sendText('echo "[Knot] 如安装成功，请执行: source ~/.bashrc 或新开终端使用 knot-cli。"', true);
	}

	output.appendLine(`[Knot] runKnotCliInstall: launched in terminal`);

	// Re-detect after a short delay so the UI can reflect status updates.
	setTimeout(() => { void vscode.commands.executeCommand('knot.checkCli'); }, 8000);
}

/**
 * Quote a value for PowerShell — wraps in single quotes, escaping embedded single quotes.
 */
function psQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function shellQuote(value: string): string {
	// Single-quote and escape any embedded single quotes for POSIX shell.
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

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

function isKnotConfigured(): boolean {
	const cfg = vscode.workspace.getConfiguration('knot');
	const token = (cfg.get<string>('token') ?? '').trim();
	return token.length > 0;
}

function normalizeWorkspacePath(raw: unknown): string {
	if (typeof raw !== 'string') { return ''; }
	const trimmed = raw.trim();
	if (!trimmed) { return ''; }
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
async function runKnotWorkspaceCli(args: string[], output: vscode.OutputChannel): Promise<KnotWorkspaceCliResult> {
	const cliStatus = await detectKnotCli(output);
	if (!cliStatus.installed) {
		return { ok: false, skipped: true, message: 'knot-cli is not installed' };
	}
	const executable = cliStatus.path ?? 'knot-cli';
	output.appendLine(`[Knot] runKnotWorkspaceCli: ${executable} ${args.join(' ')}`);

	return new Promise<KnotWorkspaceCliResult>(resolve => {
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
				if (settled) { return; }
				settled = true;
				try { child.kill(); } catch { /* noop */ }
				resolve({ ok: false, message: 'knot-cli call timed out after 30s', stdout, stderr });
			}, 30_000);

			child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
			child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

			child.on('error', err => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				output.appendLine(`[Knot] runKnotWorkspaceCli error: ${err.message}`);
				resolve({ ok: false, message: err.message, stdout, stderr });
			});

			child.on('close', code => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				const ok = code === 0;
				output.appendLine(`[Knot] runKnotWorkspaceCli exit=${code} stdout_len=${stdout.length} stderr_len=${stderr.length}`);
				if (!ok && stderr.trim()) {
					output.appendLine(`[Knot] runKnotWorkspaceCli stderr: ${stderr.trim()}`);
				}
				resolve({
					ok,
					exitCode: code ?? undefined,
					stdout,
					stderr,
					message: ok ? undefined : (stderr.trim() || `knot-cli exited with code ${code}`),
				});
			});
		} catch (err) {
			resolve({ ok: false, message: err instanceof Error ? err.message : String(err) });
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
 * (e.g. running on stock VS Code), we silently no-op — the chat provider
 * still works, only the CLI workspace mirroring is disabled.
 */
async function registerWorkspaceLifecycleHook(output: vscode.OutputChannel): Promise<void> {
	try {
		const allCommands = await vscode.commands.getCommands(true);
		if (!allCommands.includes('agentStudio.workspaceLifecycle.register')) {
			output.appendLine('[Knot] workspace lifecycle bus not available — skipping hook registration.');
			return;
		}
		await vscode.commands.executeCommand('agentStudio.workspaceLifecycle.register', {
			id: 'knot-agui',
			onCreated: 'knot.workspaceSync',
			onDeleted: 'knot.workspaceUnsync',
		});
		output.appendLine('[Knot] registered workspace lifecycle hook (id=knot-agui, onCreated=knot.workspaceSync, onDeleted=knot.workspaceUnsync)');
	} catch (err) {
		output.appendLine(`[Knot] registerWorkspaceLifecycleHook failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ─── Knot: Skill sync (.agents/skills/) ──────────────────────────────────

interface KnotSkillSyncResult {
	readonly ok: boolean;
	readonly syncedCount?: number;
	readonly removedCount?: number;
	readonly message?: string;
}

/**
 * Sync all agent skills from the sarosis workspace agent directories
 * to the knot-compatible `.agents/skills/` directory.
 *
 * Knot CLI discovers skills from `.agents/skills/` (flat structure), while
 * the host stores them per-agent under the sarosis workspace agents directory.
 * This function mirrors the union of all agents' skills into the flat directory.
 *
 * Idempotent: removes stale entries that no longer correspond to any agent skill.
 */
async function runKnotSkillSync(payload: unknown, output: vscode.OutputChannel): Promise<KnotSkillSyncResult> {
	// Guard: only sync when knot is configured
	if (!isKnotConfigured()) {
		output.appendLine('[Knot] skillSync skipped: knot.token is empty');
		return { ok: false, message: 'knot.token is not configured' };
	}

	// Extract workspace path from the payload (sent by ISkillLifecycleService)
	const p = payload as { workspacePath?: string; workspaceId?: string; agentId?: string; agentDir?: string; skillIds?: string[]; skillId?: string } | undefined;
	let workspacePath = p?.workspacePath?.trim();

	// Fallback: try to infer from VS Code workspace folders
	if (!workspacePath) {
		const folders = vscode.workspace.workspaceFolders;
		if (folders && folders.length > 0) {
			workspacePath = folders[0].uri.fsPath;
		}
	}

	if (!workspacePath) {
		output.appendLine('[Knot] skillSync skipped: cannot determine workspace path');
		return { ok: false, message: 'cannot determine workspace path' };
	}

	output.appendLine(`[Knot] skillSync: workspace="${workspacePath}" trigger=${p?.skillId ?? 'batch'}`);

	try {
		const sarosisSkillsDir = path.join(workspacePath, '.sarosisworkspace', 'agents');
		const agentsSkillsDir = path.join(workspacePath, '.agents', 'skills');

		// 1) Collect all unique skills across all agent instances
		const skillMap = new Map<string, string>(); // skillDirName -> absolute path to SKILL.md

		if (fs.existsSync(sarosisSkillsDir)) {
			const agentDirs = fs.readdirSync(sarosisSkillsDir, { withFileTypes: true })
				.filter(d => d.isDirectory());

			for (const agentDir of agentDirs) {
				const agentSkillsPath = path.join(sarosisSkillsDir, agentDir.name, 'skills');
				if (!fs.existsSync(agentSkillsPath)) { continue; }

				const skillDirs = fs.readdirSync(agentSkillsPath, { withFileTypes: true })
					.filter(d => d.isDirectory());

				for (const skillDir of skillDirs) {
					const skillMdPath = path.join(agentSkillsPath, skillDir.name, 'SKILL.md');
					if (fs.existsSync(skillMdPath)) {
						// Later agents' skills overwrite earlier (same merge policy as the host)
						skillMap.set(skillDir.name, skillMdPath);
					}
				}
			}
		}

		// 2) Ensure .agents/skills/ directory exists
		fs.mkdirSync(agentsSkillsDir, { recursive: true });

		// 3) Write all discovered skills to .agents/skills/<id>/SKILL.md
		let syncedCount = 0;
		for (const [dirName, srcPath] of skillMap) {
			const targetDir = path.join(agentsSkillsDir, dirName);
			const targetFile = path.join(targetDir, 'SKILL.md');

			fs.mkdirSync(targetDir, { recursive: true });

			try {
				const content = fs.readFileSync(srcPath, 'utf-8');
				fs.writeFileSync(targetFile, content, 'utf-8');
				syncedCount++;
			} catch (err) {
				output.appendLine(`[Knot] skillSync: failed to copy ${srcPath} -> ${targetFile}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// 4) Remove stale entries in .agents/skills/ that are not in skillMap
		let removedCount = 0;
		try {
			const existingDirs = fs.readdirSync(agentsSkillsDir, { withFileTypes: true })
				.filter(d => d.isDirectory());

			for (const existing of existingDirs) {
				if (!skillMap.has(existing.name)) {
					const staleDir = path.join(agentsSkillsDir, existing.name);
					try {
						fs.rmSync(staleDir, { recursive: true, force: true });
						removedCount++;
						output.appendLine(`[Knot] skillSync: removed stale skill dir: ${existing.name}`);
					} catch (err) {
						output.appendLine(`[Knot] skillSync: failed to remove stale dir ${existing.name}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
		} catch (err) {
			output.appendLine(`[Knot] skillSync: failed to scan .agents/skills/ for cleanup: ${err instanceof Error ? err.message : String(err)}`);
		}

		output.appendLine(`[Knot] skillSync: done — synced=${syncedCount} removed=${removedCount}`);
		return { ok: true, syncedCount, removedCount };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		output.appendLine(`[Knot] skillSync failed: ${msg}`);
		return { ok: false, message: msg };
	}
}

/**
 * Register the `knot.skillSync` command as a skill lifecycle hook with the
 * host's `ISkillLifecycleService`. This allows the host to route skill
 * add/remove/sync events to our sync command, which mirrors skills to
 * `.agents/skills/` for knot-cli discovery.
 */
async function registerSkillLifecycleHook(output: vscode.OutputChannel): Promise<void> {
	try {
		const allCommands = await vscode.commands.getCommands(true);
		if (!allCommands.includes('agentStudio.skillLifecycle.register')) {
			output.appendLine('[Knot] skill lifecycle bus not available — skipping hook registration.');
			return;
		}
		await vscode.commands.executeCommand('agentStudio.skillLifecycle.register', {
			id: 'knot-agui-skill',
			onAdded: 'knot.skillSync',
			onRemoved: 'knot.skillSync',
			onSynced: 'knot.skillSync',
		});
		output.appendLine('[Knot] registered skill lifecycle hook (id=knot-agui-skill, all events -> knot.skillSync)');
	} catch (err) {
		output.appendLine(`[Knot] registerSkillLifecycleHook failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
