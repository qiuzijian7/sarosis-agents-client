/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Hermes Agent Provider — sample 3rd-party LLM Chat Provider extension.
 *
 * This extension demonstrates the *correct* shape of a chat provider extension:
 *   - lives entirely in the ExtensionHost (no `import '../../../src/vs/...'`)
 *   - declares `enabledApiProposals: ["chatProvider"]` in package.json
 *   - registers itself via `vscode.lm.registerLanguageModelChatProvider(vendor, provider)`
 *
 * The actual inference happens via HTTP calls to a Python backend (hermes-webui-studio).
 * The renderer-side bridge (LanguageModelsToAgentOSBridge) automatically reflects this
 * provider into IAgentOSService.getModelProviders() — no main-repo coupling.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

const VENDOR = 'hermes';
const OUTPUT_NAME = 'Hermes Provider';

interface HermesModelInfo {
	id: string;
	name: string;
	contextWindow?: number;
	description?: string;
}

class HermesChatProvider implements vscode.LanguageModelChatProvider {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private _modelsCache: HermesModelInfo[] | undefined;

	constructor(private readonly _output: vscode.OutputChannel) { }

	dispose(): void {
		this._onDidChange.dispose();
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		const models = await this._listModels(token);
		const result: vscode.LanguageModelChatInformation[] = models.map(m => ({
			id: m.id,
			name: m.name,
			family: VENDOR,
			version: '1',
			maxInputTokens: m.contextWindow ?? 32_000,
			maxOutputTokens: 4_096,
			tooltip: m.description,
			capabilities: {},
			isDefault: false,
			isUserSelectable: true,
		}));
		this._output.appendLine(`[Hermes] provideLanguageModelChatInformation -> ${result.length} models`);
		return result;
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const endpoint = this._getEndpoint();
		const apiKey = this._getApiKey();

		const body = JSON.stringify({
			model: model.id,
			stream: true,
			messages: messages.map(m => ({
				role: m.role === vscode.LanguageModelChatMessageRole.User ? 'user'
					: m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant'
						: 'system',
				content: this._extractText(m),
			})),
		});

		this._output.appendLine(`[Hermes] -> ${endpoint}/v1/chat/completions  model=${model.id}  msgs=${messages.length}`);

		await this._streamSse(`${endpoint}/v1/chat/completions`, body, apiKey, token, chunk => {
			// Expect OpenAI-compatible SSE: { choices: [{ delta: { content: "..." } }] }
			try {
				const data = JSON.parse(chunk);
				const piece = data?.choices?.[0]?.delta?.content;
				if (typeof piece === 'string' && piece.length > 0) {
					progress.report(new vscode.LanguageModelTextPart(piece));
				}
			} catch {
				// non-JSON keep-alive line — ignore
			}
		});
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		// Heuristic fallback: ~4 chars per token. Backends with proper tokenizer support
		// can replace this with a real /v1/tokenize call later.
		const raw = typeof text === 'string' ? text : this._extractText(text);
		return Math.max(1, Math.ceil(raw.length / 4));
	}

	private async _listModels(_token: vscode.CancellationToken): Promise<HermesModelInfo[]> {
		if (this._modelsCache) {
			return this._modelsCache;
		}

		const endpoint = this._getEndpoint();
		const apiKey = this._getApiKey();
		try {
			const raw = await this._httpGet(`${endpoint}/v1/models`, apiKey);
			const json = JSON.parse(raw);
			const list: HermesModelInfo[] = (json?.data ?? []).map((m: { id: string; name?: string; context_window?: number; description?: string }) => ({
				id: m.id,
				name: m.name ?? m.id,
				contextWindow: m.context_window,
				description: m.description,
			}));
			this._modelsCache = list;
			return list;
		} catch (err) {
			this._output.appendLine(`[Hermes] _listModels failed, falling back to defaults: ${String(err)}`);
			return [
				{ id: 'hermes-default', name: 'Hermes Default', contextWindow: 32_000 },
			];
		}
	}

	private _extractText(msg: vscode.LanguageModelChatRequestMessage): string {
		const out: string[] = [];
		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				out.push(part.value);
			}
		}
		return out.join('');
	}

	private _getEndpoint(): string {
		const cfg = vscode.workspace.getConfiguration('hermes.provider');
		return (cfg.get<string>('endpoint') ?? 'http://127.0.0.1:8765').replace(/\/+$/, '');
	}

	private _getApiKey(): string {
		const cfg = vscode.workspace.getConfiguration('hermes.provider');
		return cfg.get<string>('apiKey') ?? '';
	}

	private _httpGet(urlStr: string, apiKey: string): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const u = new URL(urlStr);
			const lib = u.protocol === 'https:' ? https : http;
			const req = lib.request({
				method: 'GET',
				hostname: u.hostname,
				port: u.port || (u.protocol === 'https:' ? 443 : 80),
				path: u.pathname + u.search,
				headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
			}, res => {
				const chunks: Buffer[] = [];
				res.on('data', c => chunks.push(c));
				res.on('end', () => {
					const body = Buffer.concat(chunks).toString('utf8');
					if (res.statusCode && res.statusCode >= 400) {
						reject(new Error(`HTTP ${res.statusCode}: ${body}`));
					} else {
						resolve(body);
					}
				});
			});
			req.on('error', reject);
			req.end();
		});
	}

	private _streamSse(
		urlStr: string,
		body: string,
		apiKey: string,
		token: vscode.CancellationToken,
		onChunk: (jsonChunk: string) => void,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const u = new URL(urlStr);
			const lib = u.protocol === 'https:' ? https : http;
			const req = lib.request({
				method: 'POST',
				hostname: u.hostname,
				port: u.port || (u.protocol === 'https:' ? 443 : 80),
				path: u.pathname + u.search,
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'text/event-stream',
					...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
				},
			}, res => {
				if (res.statusCode && res.statusCode >= 400) {
					const chunks: Buffer[] = [];
					res.on('data', c => chunks.push(c));
					res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`)));
					return;
				}

				let buffer = '';
				res.setEncoding('utf8');
				res.on('data', (text: string) => {
					buffer += text;
					let idx;
					while ((idx = buffer.indexOf('\n')) !== -1) {
						const line = buffer.slice(0, idx).trim();
						buffer = buffer.slice(idx + 1);
						if (!line || line.startsWith(':')) continue;
						if (line.startsWith('data: ')) {
							const payload = line.slice(6).trim();
							if (payload === '[DONE]') return;
							onChunk(payload);
						}
					}
				});
				res.on('end', () => resolve());
				res.on('error', reject);
			});

			token.onCancellationRequested(() => {
				try { req.destroy(); } catch { /* noop */ }
				reject(new Error('Cancelled'));
			});

			req.on('error', reject);
			req.write(body);
			req.end();
		});
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel(OUTPUT_NAME);
	context.subscriptions.push(output);

	const provider = new HermesChatProvider(output);
	context.subscriptions.push(provider);

	const registration = vscode.lm.registerLanguageModelChatProvider(VENDOR, provider);
	context.subscriptions.push(registration);

	output.appendLine(`[Hermes] activate() — registered chat provider, vendor="${VENDOR}"`);
}

export function deactivate(): void {
	// nothing — context.subscriptions disposes resources
}
