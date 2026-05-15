/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Hermes Bridge — JSON-RPC over stdio bridge to hermes-agent Python process.
 *
 * Architecture:
 *   TypeScript (Plugin) ←→ stdio JSON-RPC ←→ Python (hermes_bridge_server.py)
 *                                                      ↓
 *                                               AIAgent + ToolRegistry + Providers
 *
 * The Python bridge server is a thin JSON-RPC layer that:
 *   - Instantiates AIAgent with configured provider/model/tools
 *   - Exposes methods: list_providers, list_models, chat, list_tools, execute_tool, etc.
 *   - Streams chat responses as newline-delimited JSON events
 */

export interface HermesBridgeConfig {
	pythonPath?: string;
	hermesSourcePath: string;
	hermesHome?: string;
	provider?: string;
	model?: string;
	apiKey?: string;
	baseUrl?: string;
	enabledToolsets?: string[];
	disabledToolsets?: string[];
	maxIterations?: number;
	memoryProvider?: string;
	timeout?: number;
	streaming?: boolean;
}

export interface BridgeRequest {
	jsonrpc: '2.0';
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

export interface BridgeResponse {
	jsonrpc: '2.0';
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface BridgeEvent {
	jsonrpc: '2.0';
	method: string;
	params?: Record<string, unknown>;
}

export type BridgeEventHandler = (event: BridgeEvent) => void;

export class HermesBridge {
	private _process: ChildProcess | undefined;
	private _requestId = 0;
	private _pendingRequests = new Map<number, {
		resolve: (value: unknown) => void;
		reject: (reason: unknown) => void;
		timeout: ReturnType<typeof setTimeout>;
	}>();
	private _eventHandlers = new Map<string, Set<BridgeEventHandler>>();
	private _buffer = '';
	private _startPromise: Promise<void> | undefined;
	private _config: HermesBridgeConfig;
	private _isRunning = false;

	constructor(config: HermesBridgeConfig) {
		this._config = config;
	}

	get isRunning(): boolean {
		return this._isRunning && !!this._process && !this._process.killed;
	}

	// ─── Lifecycle ─────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.isRunning) { return; }

		this._startPromise = this._doStart();
		return this._startPromise;
	}

	private async _doStart(): Promise<void> {
		const bridgeScript = this._resolveBridgeScript();
		if (!bridgeScript) {
			throw new Error(`Hermes bridge script not found. Expected at ${this._config.hermesSourcePath}/hermes_bridge_server.py or bundled location.`);
		}

		const env: Record<string, string> = { ...process.env as Record<string, string> };

		// Set HERMES_HOME if configured
		if (this._config.hermesHome) {
			env.HERMES_HOME = this._config.hermesHome;
		}

		// Pass config as environment variables for the bridge server
		if (this._config.provider) { env.HERMES_PROVIDER = this._config.provider; }
		if (this._config.model) { env.HERMES_MODEL = this._config.model; }
		if (this._config.apiKey) { env.HERMES_API_KEY = this._config.apiKey; }
		if (this._config.baseUrl) { env.HERMES_BASE_URL = this._config.baseUrl; }
		if (this._config.maxIterations) { env.HERMES_MAX_ITERATIONS = String(this._config.maxIterations); }
		if (this._config.memoryProvider) { env.HERMES_MEMORY_PROVIDER = this._config.memoryProvider; }
		if (this._config.enabledToolsets?.length) { env.HERMES_ENABLED_TOOLSETS = this._config.enabledToolsets.join(','); }
		if (this._config.disabledToolsets?.length) { env.HERMES_DISABLED_TOOLSETS = this._config.disabledToolsets.join(','); }

		// Ensure hermes-agent source is on PYTHONPATH
		const hermesSource = this._config.hermesSourcePath;
		if (hermesSource) {
			env.PYTHONPATH = hermesSource + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : '');
		}

		this._process = spawn(this._config.pythonPath || 'python3', [bridgeScript], {
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: hermesSource || undefined,
		});

		this._process!.on('error', (err) => {
			console.error('[Hermes-Bridge] Process error:', err);
			this._isRunning = false;
		});

		this._process!.on('exit', (code, signal) => {
			console.error(`[Hermes-Bridge] Process exited: code=${code}, signal=${signal}`);
			this._isRunning = false;
			this._rejectAllPending(new Error(`Bridge process exited with code ${code}`));
		});

		// Read stdout
		this._process!.stdout!.on('data', (chunk: Buffer) => {
			this._onStdoutData(chunk.toString());
		});

		// Log stderr
		this._process!.stderr!.on('data', (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) {
				console.warn('[Hermes-Bridge stderr]', text);
			}
		});

		// Wait for the bridge to be ready (it sends a 'ready' event)
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('Bridge startup timeout (30s)'));
			}, 30000);

			const handler: BridgeEventHandler = (event) => {
				if (event.method === 'ready') {
					clearTimeout(timeout);
					this._eventHandlers.get('ready')?.delete(handler);
					this._isRunning = true;
					resolve();
				}
			};

			this.on('ready', handler);
		});
	}

	async stop(): Promise<void> {
		if (!this._process) { return; }

		// Send shutdown request
		try {
			await this.request('shutdown', {}, 5000);
		} catch {
			// Ignore — process may already be dead
		}

		this._process.kill('SIGTERM');
		this._process = undefined;
		this._isRunning = false;
		this._rejectAllPending(new Error('Bridge stopped'));
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	// ─── JSON-RPC ──────────────────────────────────────────────

	request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this._process || this._process.killed) {
				reject(new Error('Bridge process not running'));
				return;
			}

			const id = ++this._requestId;
			const request: BridgeRequest = {
				jsonrpc: '2.0',
				id,
				method,
				params: params || {},
			};

			const timeout = setTimeout(() => {
				this._pendingRequests.delete(id);
				reject(new Error(`Request timeout: ${method} (id=${id})`));
			}, timeoutMs || this._config.timeout || 300000);

			this._pendingRequests.set(id, { resolve, reject, timeout });

			const data = JSON.stringify(request) + '\n';
			this._process.stdin!.write(data);
		});
	}

	/**
	 * Send a streaming chat request. Returns an async generator that yields events.
	 */
	async *streamChat(params: {
		messages: Array<{ role: string; content: string }>;
		provider?: string;
		model?: string;
		systemPrompt?: string;
		temperature?: number;
		maxTokens?: number;
		maxIterations?: number;
		sessionId?: string;
	}): AsyncGenerator<BridgeEvent> {
		const eventQueue: BridgeEvent[] = [];
		let resolveNext: ((value: boolean) => void) | undefined;
		let done = false;

		const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;

		const handler: BridgeEventHandler = (event) => {
			if (event.params?.['streamId'] === streamId || event.method === 'chat.done' || event.method === 'chat.error') {
				eventQueue.push(event);
				if (resolveNext) {
					resolveNext(true);
					resolveNext = undefined;
				}
			}
		};

		// Register for stream events
		this.on('chat.delta', handler);
		this.on('chat.thinking', handler);
		this.on('chat.tool_start', handler);
		this.on('chat.tool_args', handler);
		this.on('chat.tool_end', handler);
		this.on('chat.tool_result', handler);
		this.on('chat.done', handler);
		this.on('chat.error', handler);

		try {
			// Initiate the streaming request
			await this.request('chat.stream', { ...params, streamId });

			// Yield events as they arrive
			while (!done) {
				if (eventQueue.length > 0) {
					const event = eventQueue.shift()!;
					if (event.method === 'chat.done' || event.method === 'chat.error') {
						done = true;
					}
					yield event;
				} else {
					// Wait for next event
					const hasEvent = await new Promise<boolean>((resolve) => {
						resolveNext = resolve;
						// Timeout after 5 minutes
						setTimeout(() => {
							done = true;
							resolve(false);
						}, this._config.timeout || 300000);
					});
					if (!hasEvent) { break; }
				}
			}
		} finally {
			// Cleanup handlers
			this.off('chat.delta', handler);
			this.off('chat.thinking', handler);
			this.off('chat.tool_start', handler);
			this.off('chat.tool_args', handler);
			this.off('chat.tool_end', handler);
			this.off('chat.tool_result', handler);
			this.off('chat.done', handler);
			this.off('chat.error', handler);
		}
	}

	// ─── Event Handling ────────────────────────────────────────

	on(method: string, handler: BridgeEventHandler): void {
		if (!this._eventHandlers.has(method)) {
			this._eventHandlers.set(method, new Set());
		}
		this._eventHandlers.get(method)!.add(handler);
	}

	off(method: string, handler: BridgeEventHandler): void {
		this._eventHandlers.get(method)?.delete(handler);
	}

	// ─── Internal ──────────────────────────────────────────────

	private _onStdoutData(data: string): void {
		this._buffer += data;
		const lines = this._buffer.split('\n');
		this._buffer = lines.pop() || '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) { continue; }
			try {
				const msg = JSON.parse(trimmed);

				if ('id' in msg && !('method' in msg)) {
					// This is a response
					this._handleResponse(msg as BridgeResponse);
				} else if ('method' in msg) {
					// This is an event/notification
					this._handleEvent(msg as BridgeEvent);
				}
			} catch {
				// Skip malformed JSON
			}
		}
	}

	private _handleResponse(response: BridgeResponse): void {
		const pending = this._pendingRequests.get(response.id);
		if (!pending) { return; }

		clearTimeout(pending.timeout);
		this._pendingRequests.delete(response.id);

		if (response.error) {
			pending.reject(new Error(response.error.message));
		} else {
			pending.resolve(response.result);
		}
	}

	private _handleEvent(event: BridgeEvent): void {
		const handlers = this._eventHandlers.get(event.method);
		if (handlers) {
			for (const handler of handlers) {
				try {
					handler(event);
				} catch (err) {
					console.error('[Hermes-Bridge] Event handler error:', err);
				}
			}
		}
	}

	private _rejectAllPending(reason: Error): void {
		for (const [, pending] of this._pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(reason);
		}
		this._pendingRequests.clear();
	}

	private _resolveBridgeScript(): string | undefined {
		// 1. Check if hermesSourcePath has the bridge script
		if (this._config.hermesSourcePath) {
			const candidate = path.join(this._config.hermesSourcePath, 'hermes_bridge_server.py');
			if (fs.existsSync(candidate)) { return candidate; }
		}

		// 2. Check extension's bundled hermes/ directory
		const extRoot = path.resolve(__dirname, '..');
		const bundled = path.join(extRoot, 'hermes', 'hermes_bridge_server.py');
		if (fs.existsSync(bundled)) { return bundled; }

		// 3. Check for bridge script in the extension's src directory
		const srcBridge = path.join(extRoot, 'src', 'hermes_bridge_server.py');
		if (fs.existsSync(srcBridge)) { return srcBridge; }

		return undefined;
	}

	/**
	 * Update configuration and restart bridge if needed
	 */
	updateConfig(config: Partial<HermesBridgeConfig>): void {
		Object.assign(this._config, config);
	}

	getConfig(): HermesBridgeConfig {
		return { ...this._config };
	}

	/**
	 * Resolve the hermes source path — either from config or embedded
	 */
	static resolveHermesSourcePath(config: HermesBridgeConfig): string {
		if (config.hermesSourcePath) {
			return config.hermesSourcePath;
		}
		// Default to the embedded hermes/ directory
		return path.resolve(__dirname, '..', 'hermes');
	}
}
