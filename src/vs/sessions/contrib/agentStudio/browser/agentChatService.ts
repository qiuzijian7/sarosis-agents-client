/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import {
	IAgentChatService,
	IAgentStudioService,
} from "../common/agentStudio.js";
import type {
	IChatStreamDelta,
	IChatSendOptions,
} from "../common/agentStudio.js";
import { IAgentDriverService } from "../common/agentDriver.js";
import type { ChatMessage } from "../common/types.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IEnvironmentService } from "../../../../platform/environment/common/environment.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { URI } from "../../../../base/common/uri.js";
import { VSBuffer } from "../../../../base/common/buffer.js";
import {
	AGENT_STUDIO_DATA_PATH_SETTING,
	DATA_FILE_CHAT_HISTORY,
	WORKSPACE_DATA_DIR,
	AGENTS_DIR,
} from "../common/constants.js";

// ─── Agent Session Index ────────────────────────────────────────────────────

/**
 * Metadata for one agent-level session.
 * Stored in agents/{slug}/sessions.json as an array.
 */
export interface AgentSessionMeta {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** External provider session ID (e.g. Knot AG-UI threadId). Captured from stream metadata. */
	providerSessionId?: string;
}

// ─── Service ────────────────────────────────────────────────────────────────

/**
 * AgentChatService — chat history persistence + agent session management.
 *
 * Storage layout (simplified, per-agent):
 *   agents/{slug}/sessions.json          ← session index (array of AgentSessionMeta)
 *   agents/{slug}/sessions/default.json  ← messages for default session
 *   agents/{slug}/sessions/{id}.json     ← messages for other sessions
 *
 * Global fallback (for agents without workspace path):
 *   {userRoamingDataHome}/agent-studio/chat-history.json
 */
export class AgentChatService extends Disposable implements IAgentChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _activeStreams = new Map<string, AbortController>();
	private readonly logService: ILogService;
	private readonly driverService: IAgentDriverService;
	private readonly fileService: IFileService;
	private readonly environmentService: IEnvironmentService;
	private readonly configurationService: IConfigurationService;
	private readonly studioService: IAgentStudioService;

	/** In-memory cache: compositeKey → messages */
	private readonly _historyCache = new Map<string, ChatMessage[]>();
	private _historyLoaded = false;
	private _globalDataUri: URI | undefined;

	private readonly _onDidChangeAgentSessionsEmitter = this._register(
		new Emitter<{ employeeId: string }>(),
	);
	readonly onDidChangeAgentSessions: Event<{ employeeId: string }> =
		this._onDidChangeAgentSessionsEmitter.event;

	constructor(
		@ILogService logService: ILogService,
		@IAgentDriverService driverService: IAgentDriverService,
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IConfigurationService configurationService: IConfigurationService,
		@IAgentStudioService studioService: IAgentStudioService,
	) {
		super();
		this.logService = logService;
		this.driverService = driverService;
		this.fileService = fileService;
		this.environmentService = environmentService;
		this.configurationService = configurationService;
		this.studioService = studioService;
	}

	// ─── Path helpers ────────────────────────────────────────────────────────

	private _getGlobalDataUri(): URI {
		if (!this._globalDataUri) {
			const customPath = this.configurationService.getValue<string>(
				AGENT_STUDIO_DATA_PATH_SETTING,
			);
			this._globalDataUri = customPath
				? URI.file(customPath)
				: URI.joinPath(
					this.environmentService.userRoamingDataHome,
					"agent-studio",
				);
		}
		return this._globalDataUri;
	}

	private _getHistoryFileUri(): URI {
		return URI.joinPath(this._getGlobalDataUri(), DATA_FILE_CHAT_HISTORY);
	}

	/**
	 * Resolve agent's sessions directory URI + sessions.json index URI.
	 * Returns null if agent/workspace has no disk path.
	 */
	private async _resolveAgentPaths(employeeId: string): Promise<{
		sessionsDirUri: URI;
		indexUri: URI;
	} | null> {
		const employee = await this.studioService.getEmployee(employeeId);
		if (!employee?.agentDir || !employee.workspaceId) {
			return null;
		}
		const workspace = await this.studioService.getWorkspace(
			employee.workspaceId,
		);
		if (!workspace?.path) {
			return null;
		}
		const agentUri = URI.joinPath(
			URI.file(workspace.path),
			WORKSPACE_DATA_DIR,
			AGENTS_DIR,
			employee.agentDir,
		);
		return {
			sessionsDirUri: URI.joinPath(agentUri, "sessions"),
			indexUri: URI.joinPath(agentUri, "sessions.json"),
		};
	}

	private _sessionFileUri(sessionsDirUri: URI, sessionId: string): URI {
		return URI.joinPath(sessionsDirUri, `${sessionId}.json`);
	}

	private _cacheKey(employeeId: string, sessionId?: string): string {
		return sessionId ? `${employeeId}::${sessionId}` : employeeId;
	}

	// ─── Global history (fallback) ───────────────────────────────────────────

	private async _ensureHistoryLoaded(): Promise<void> {
		if (this._historyLoaded) {
			return;
		}
		this._historyLoaded = true;
		try {
			const uri = this._getHistoryFileUri();
			if (!(await this.fileService.exists(uri))) {
				return;
			}
			const content = await this.fileService.readFile(uri);
			const data = JSON.parse(content.value.toString()) as Record<
				string,
				ChatMessage[]
			>;
			for (const [key, messages] of Object.entries(data)) {
				this._historyCache.set(key, messages);
			}
			this.logService.info(
				`[AgentChatService] Loaded global history: ${this._historyCache.size} keys`,
			);
		} catch (err) {
			this.logService.error(
				"[AgentChatService] Failed to load global history:",
				err,
			);
		}
	}

	private async _persistGlobalHistory(): Promise<void> {
		try {
			const dirUri = this._getGlobalDataUri();
			if (!(await this.fileService.exists(dirUri))) {
				await this.fileService.createFolder(dirUri);
			}
			const data: Record<string, ChatMessage[]> = {};
			for (const [key, messages] of this._historyCache) {
				data[key] = messages;
			}
			await this.fileService.writeFile(
				this._getHistoryFileUri(),
				VSBuffer.fromString(JSON.stringify(data, null, 2)),
			);
		} catch (err) {
			this.logService.error(
				"[AgentChatService] Failed to persist global history:",
				err,
			);
		}
	}

	// ─── Per-agent session file persistence ──────────────────────────────────

	private async _persistToSessionFile(
		employeeId: string,
		sessionId: string | undefined,
		messages: ChatMessage[],
	): Promise<void> {
		if (!sessionId) {
			return;
		} // No session assigned yet — skip per-file persist
		try {
			const paths = await this._resolveAgentPaths(employeeId);
			if (!paths) {
				return;
			}
			const { sessionsDirUri } = paths;
			if (!(await this.fileService.exists(sessionsDirUri))) {
				await this.fileService.createFolder(sessionsDirUri);
			}
			const fileUri = this._sessionFileUri(sessionsDirUri, sessionId);
			await this.fileService.writeFile(
				fileUri,
				VSBuffer.fromString(JSON.stringify(messages, null, 2)),
			);
			await this._updateSessionIndex(employeeId, sessionId, messages.length);
		} catch (err) {
			this.logService.error(
				"[AgentChatService] _persistToSessionFile failed:",
				err,
			);
		}
	}

	private async _loadFromSessionFile(
		employeeId: string,
		sessionId?: string,
	): Promise<ChatMessage[]> {
		if (!sessionId) {
			return [];
		} // No session specified — nothing to load
		try {
			const paths = await this._resolveAgentPaths(employeeId);
			if (!paths) {
				return [];
			}
			const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
			if (!(await this.fileService.exists(fileUri))) {
				return [];
			}
			const content = await this.fileService.readFile(fileUri);
			return JSON.parse(content.value.toString()) as ChatMessage[];
		} catch {
			return [];
		}
	}

	// ─── Session Index (sessions.json) ───────────────────────────────────────

	private async _readSessionIndex(
		employeeId: string,
	): Promise<AgentSessionMeta[]> {
		try {
			const paths = await this._resolveAgentPaths(employeeId);
			if (!paths) {
				return [];
			}
			if (!(await this.fileService.exists(paths.indexUri))) {
				return [];
			}
			const content = await this.fileService.readFile(paths.indexUri);
			return JSON.parse(content.value.toString()) as AgentSessionMeta[];
		} catch {
			return [];
		}
	}

	private async _writeSessionIndex(
		employeeId: string,
		index: AgentSessionMeta[],
	): Promise<void> {
		try {
			const paths = await this._resolveAgentPaths(employeeId);
			if (!paths) {
				return;
			}
			await this.fileService.writeFile(
				paths.indexUri,
				VSBuffer.fromString(JSON.stringify(index, null, 2)),
			);
		} catch (err) {
			this.logService.error(
				"[AgentChatService] Failed to write session index:",
				err,
			);
		}
	}

	/**
	 * Ensure a session exists in the index; update messageCount + updatedAt.
	 * If the session doesn't exist yet, auto-create it (supports first-message auto-create).
	 */
	private async _updateSessionIndex(
		employeeId: string,
		sessionId: string,
		messageCount: number,
	): Promise<void> {
		const index = await this._readSessionIndex(employeeId);
		const now = new Date().toISOString();
		let entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			entry = {
				id: sessionId,
				name: `新对话`,
				createdAt: now,
				updatedAt: now,
				messageCount,
			};
			index.push(entry);
		} else {
			entry.messageCount = messageCount;
			entry.updatedAt = now;
		}
		await this._writeSessionIndex(employeeId, index);
		this._onDidChangeAgentSessionsEmitter.fire({ employeeId });
	}

	// ─── Public: appendMessage ───────────────────────────────────────────────

	async appendMessage(employeeId: string, message: ChatMessage): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(employeeId, message.agentSessionId);
		let messages = this._historyCache.get(key);
		if (!messages) {
			messages = [];
			this._historyCache.set(key, messages);
		}
		messages.push(message);

		// Dual-write: global fallback + per-agent session file
		this._persistGlobalHistory().catch((err) =>
			this.logService.error("[AgentChatService] Global persist failed:", err),
		);
		this._persistToSessionFile(
			employeeId,
			message.agentSessionId,
			messages,
		).catch((err) =>
			this.logService.error(
				"[AgentChatService] Session file persist failed:",
				err,
			),
		);
	}

	// ─── Public: getHistory / clearHistory ────────────────────────────────────

	async getHistory(
		employeeId: string,
		sessionId?: string,
	): Promise<ChatMessage[]> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(employeeId, sessionId);
		let messages = this._historyCache.get(key);

		if (!messages || messages.length === 0) {
			messages = await this._loadFromSessionFile(employeeId, sessionId);
			if (messages.length > 0) {
				this._historyCache.set(key, messages);
			}
		}

		// When a sessionId is specified, also include messages stored with
		// agentSessionId=undefined (e.g. task orchestration system messages).
		// These messages belong to the agent globally, not to any specific session,
		// so they should appear regardless of which session is active.
		if (sessionId) {
			const noSessionKey = this._cacheKey(employeeId, undefined);
			let noSessionMessages = this._historyCache.get(noSessionKey);
			if (!noSessionMessages || noSessionMessages.length === 0) {
				noSessionMessages = await this._loadFromSessionFile(employeeId, undefined);
			}
			if (noSessionMessages && noSessionMessages.length > 0) {
				// Merge and deduplicate by message id, sorted by timestamp
				const existingIds = new Set((messages || []).map(m => m.id));
				const merged = [
					...(messages || []),
					...noSessionMessages.filter(m => !existingIds.has(m.id)),
				].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
				messages = merged;
			}
		}

		this.logService.info(
			`[AgentChatService] getHistory: ${(messages || []).length} msgs for ${key}`,
		);
		return messages || [];
	}

	async clearHistory(employeeId: string, sessionId?: string): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(employeeId, sessionId);
		this._historyCache.delete(key);
		await this._persistGlobalHistory();
		if (sessionId) {
			try {
				const paths = await this._resolveAgentPaths(employeeId);
				if (paths) {
					const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
					if (await this.fileService.exists(fileUri)) {
						await this.fileService.writeFile(
							fileUri,
							VSBuffer.fromString("[]"),
						);
					}
				}
			} catch {
				/* ignore */
			}
		}
	}

	async deleteMessagesAfter(
		employeeId: string,
		sessionId: string | undefined,
		messageId: string,
	): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(employeeId, sessionId);
		let messages = this._historyCache.get(key);

		if (!messages || messages.length === 0) {
			messages = await this._loadFromSessionFile(employeeId, sessionId);
		}
		if (!messages || messages.length === 0) {
			this.logService.info(`[AgentChatService] deleteMessagesAfter: no messages found for ${key}`);
			return;
		}

		const targetIdx = messages.findIndex(m => m.id === messageId);
		if (targetIdx < 0) {
			this.logService.warn(`[AgentChatService] deleteMessagesAfter: message ${messageId} not found in ${key}`);
			return;
		}

		// Keep messages up to and including targetIdx
		const updatedMessages = messages.slice(0, targetIdx + 1);
		this._historyCache.set(key, updatedMessages);

		this.logService.info(
			`[AgentChatService] deleteMessagesAfter: kept ${updatedMessages.length} messages (removed ${messages.length - updatedMessages.length}) for ${key}`,
		);

		// Persist: global + session file
		this._persistGlobalHistory().catch((err) =>
			this.logService.error("[AgentChatService] Global persist failed:", err),
		);
		this._persistToSessionFile(
			employeeId,
			sessionId,
			updatedMessages,
		).catch((err) =>
			this.logService.error("[AgentChatService] Session file persist failed:", err),
		);
	}

	// ─── Public: sendMessage ─────────────────────────────────────────────────

	async sendMessage(
		employeeId: string,
		message: string,
		options: IChatSendOptions,
		onDelta: (delta: IChatStreamDelta) => void,
	): Promise<ChatMessage> {
		this.logService.info(
			`[CoderTrace] AgentChatService.sendMessage: employeeId=${employeeId}, messageLen=${message.length}, model=${options.model}, chatMode=${options.chatMode}, explicitSkillIds=${JSON.stringify(options.explicitSkillIds)}`,
		);

		const streamKey = options.agentSessionId
			? `${employeeId}::${options.agentSessionId}`
			: employeeId;
		this.cancelStream(streamKey);

		const controller = new AbortController();
		this._activeStreams.set(streamKey, controller);

		let fullContent = "";
		let fullThinking = "";
		let toolCalls: ChatMessage["toolCalls"];
		// Accumulators for new card data (VS Code Copilot Chat pattern)
		let references: ChatMessage["references"];
		let progress: ChatMessage["progress"];
		let confirmation: ChatMessage["confirmation"];
		let todos: ChatMessage["todos"];
		let tips: ChatMessage["tips"];
		let questions: ChatMessage["questions"];
		// KV Cache: accumulated token usage across the turn.
		let usageInput = 0;
		let usageOutput = 0;
		let usageCached = 0;
		let usageCacheWrite = 0;
		let usageCredit = 0;
		let usageTotalReported = 0; // total_tokens as reported by the gateway (preferred over input+output)
		let usageSeen = false;

		try {
			// Persist user message (fire-and-forget, don't block AI response)
			// Defensive: check if an identical user message was already persisted
			// in the last 5 seconds (e.g. by the webview controller or another caller).
			const key = this._cacheKey(employeeId, options.agentSessionId);
			const existingMessages = this._historyCache.get(key) || [];
			const now = Date.now();
			const alreadyPersisted = existingMessages.some(m =>
				m.role === 'user' &&
				m.content === message &&
				m.agentSessionId === options.agentSessionId &&
				(now - new Date(m.timestamp).getTime()) < 5000
			);

			if (!alreadyPersisted) {
				const userMessage: ChatMessage = {
					id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					role: 'user',
					content: message,
					employeeId,
					agentSessionId: options.agentSessionId,
					timestamp: new Date().toISOString(),
				};
				this.appendMessage(employeeId, userMessage).catch(err =>
					this.logService.error('[AgentChatService] Failed to persist user message:', err)
				);
			} else {
				this.logService.info(`[AgentChatService] Skipping duplicate user message persist: "${message.substring(0, 40)}..."`);
			}

			const stream = this.driverService.executeFromChatOptions(
				employeeId,
				message,
				options,
			);
			for await (const delta of stream) {
				if (controller.signal.aborted) {
					break;
				}
				if (delta.type === "text" && delta.content) {
					fullContent += delta.content;
				}
				if (delta.type === "thinking" && delta.content) {
					fullThinking += delta.content;
				}
				// content_replace: upstream extracted tool calls from text and wants
				// to replace the accumulated fullContent with the cleaned version.
				if (delta.type === "content_replace") {
					fullContent = delta.content ?? "";
				}
				if (delta.type === "tool_start" && delta.toolCallId && delta.toolName) {
					if (!toolCalls) {
						toolCalls = [];
					}
					toolCalls.push({
						id: delta.toolCallId,
						name: delta.toolName,
						arguments: "",
						result: undefined,
						displayName: delta.displayName,
						renderType: delta.renderType,
						defaultShow: delta.defaultShow,
						serverExecuted: (delta as any).serverExecuted,
					});
				}
				if (
					delta.type === "tool_args" &&
					delta.toolCallId &&
					delta.content &&
					toolCalls
				) {
					const tc = toolCalls.find((t) => t.id === delta.toolCallId);
					if (tc) {
						tc.arguments += delta.content;
					}
				}
				if (delta.type === "tool_result" && delta.toolCallId && toolCalls) {
					const tc = toolCalls.find((t) => t.id === delta.toolCallId);
					if (tc) {
						tc.result = delta.content;
						// Mark finished so the persisted card restores in a
						// completed (not loading) state after a window refresh.
						// Without this, the webview's mapPhase sees no status and
						// defaults to 'pending' → renders the loading title forever.
						tc.status = 'done';
					}
				}
				// Handle new card data delta types (VS Code Copilot Chat pattern)
				if (delta.type === 'references' && delta.references) {
					references = delta.references as unknown as ChatMessage['references'];
				}
				if (delta.type === 'progress' && delta.progressData) {
					progress = delta.progressData as unknown as ChatMessage['progress'];
				}
				if (delta.type === 'confirmation' && delta.confirmationData) {
					confirmation = delta.confirmationData as unknown as ChatMessage['confirmation'];
				}
				if (delta.type === 'todos' && delta.todosData) {
					todos = delta.todosData as unknown as ChatMessage['todos'];
				}
				if (delta.type === 'tips' && delta.tipsData) {
					tips = delta.tipsData as unknown as ChatMessage['tips'];
				}
				if (delta.type === 'questions' && delta.questionsData) {
					questions = delta.questionsData as unknown as ChatMessage['questions'];
				}
				// KV Cache: aggregate per-chunk usage so the persisted ChatMessage
				// carries the final token totals (BYOK providers may emit usage on
				// either the streaming chunk path or the fallback non-streaming path,
				// so we sum defensively rather than overwrite).
				if (delta.type === 'usage' && delta.usage) {
					usageSeen = true;
					if (typeof delta.usage.inputTokens === 'number') { usageInput += delta.usage.inputTokens; }
					if (typeof delta.usage.outputTokens === 'number') { usageOutput += delta.usage.outputTokens; }
					if (typeof delta.usage.cachedTokens === 'number') { usageCached += delta.usage.cachedTokens; }
					if (typeof delta.usage.cacheWriteTokens === 'number') { usageCacheWrite += delta.usage.cacheWriteTokens; }
					if (typeof delta.usage.totalTokens === 'number') { usageTotalReported += delta.usage.totalTokens; }
					if (typeof delta.usage.credit === 'number') { usageCredit += delta.usage.credit; }
				}
				onDelta(delta);
			}

			// Finalization safety net: the stream has fully completed, so any
			// tool call still lacking a status must have finished. Mark it 'done'
			// so the persisted card restores in a completed state rather than the
			// loading title after a window refresh.
			if (toolCalls) {
				for (const tc of toolCalls) {
					if (!tc.status) {
						tc.status = 'done';
					}
				}
			}

			const chatMessage: ChatMessage = {
				id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
				role: "assistant",
				content: fullContent,
				employeeId,
				agentSessionId: options.agentSessionId,
				thinking: fullThinking || undefined,
				toolCalls: toolCalls || undefined,
				timestamp: new Date().toISOString(),
				// New card data fields (VS Code Copilot Chat pattern)
				references: references || undefined,
				progress: progress || undefined,
				confirmation: confirmation || undefined,
				todos: todos || undefined,
				tips: tips || undefined,
				questions: questions || undefined,
				// KV Cache: persist token usage so the webview footer can render the
				// total + cache-hit badge (only emitted when the provider reported usage).
				tokenUsage: usageSeen
					? {
						input: usageInput,
						output: usageOutput,
						// Prefer the gateway-reported total_tokens when present (it may
						// account for tokens not split into input/output); otherwise derive.
						total: usageTotalReported > 0 ? usageTotalReported : usageInput + usageOutput,
						cached: usageCached > 0 ? usageCached : undefined,
						cacheWrite: usageCacheWrite > 0 ? usageCacheWrite : undefined,
						credit: usageCredit > 0 ? usageCredit : undefined,
					}
					: undefined,
			};

			this.appendMessage(employeeId, chatMessage).catch((err) =>
				this.logService.error(
					"[AgentChatService] Failed to persist assistant message:",
					err,
				),
			);

			return chatMessage;
		} catch (error) {
			this.logService.error(
				`[AgentChatService] sendMessage failed for ${employeeId}:`,
				error,
			);
			onDelta({ type: "error", content: String(error) });
			throw error;
		} finally {
			this._activeStreams.delete(streamKey);
		}
	}

	cancelStream(employeeId: string, agentSessionId?: string): void {
		// The stream is stored under a composite key when agentSessionId exists
		// (see sendMessage line ~297).  We must look up the same key to abort it.
		const streamKey = agentSessionId
			? `${employeeId}::${agentSessionId}`
			: employeeId;
		const controller = this._activeStreams.get(streamKey);
		if (controller) {
			controller.abort();
			this._activeStreams.delete(streamKey);
		}
	}

	// ─── Agent Session CRUD (Root mode) ──────────────────────────────────────

	/**
	 * List all sessions for an agent.
	 * Reads from sessions.json index (fast, no file scanning).
	 */
	async listAgentSessions(employeeId: string): Promise<AgentSessionMeta[]> {
		const index = await this._readSessionIndex(employeeId);
		index.sort(
			(a, b) =>
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		);
		return index;
	}

	/**
	 * Create a new session. Returns the full AgentSessionMeta.
	 */
	async createAgentSession(
		employeeId: string,
		name?: string,
	): Promise<AgentSessionMeta> {
		const paths = await this._resolveAgentPaths(employeeId);
		if (!paths) {
			throw new Error("Agent has no workspace directory");
		}

		const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
		const now = new Date().toISOString();
		const meta: AgentSessionMeta = {
			id: sessionId,
			name: name || "新对话",
			createdAt: now,
			updatedAt: now,
			messageCount: 0,
		};

		if (!(await this.fileService.exists(paths.sessionsDirUri))) {
			await this.fileService.createFolder(paths.sessionsDirUri);
		}
		await this.fileService.writeFile(
			this._sessionFileUri(paths.sessionsDirUri, sessionId),
			VSBuffer.fromString("[]"),
		);

		const index = await this._readSessionIndex(employeeId);
		index.push(meta);
		await this._writeSessionIndex(employeeId, index);

		this.logService.info(
			`[AgentChatService] Created session ${sessionId} for ${employeeId}`,
		);
		this._onDidChangeAgentSessionsEmitter.fire({ employeeId });
		return meta;
	}

	/**
	 * Rename a session.
	 */
	async renameAgentSession(
		employeeId: string,
		sessionId: string,
		newName: string,
	): Promise<void> {
		const index = await this._readSessionIndex(employeeId);
		const entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			throw new Error(`Session ${sessionId} not found`);
		}
		entry.name = newName;
		entry.updatedAt = new Date().toISOString();
		await this._writeSessionIndex(employeeId, index);
		this._onDidChangeAgentSessionsEmitter.fire({ employeeId });
	}

	/**
	 * Delete a session. If it's the last one, it can still be deleted
	 * (user will get a new session auto-created on next message).
	 */
	async deleteAgentSession(
		employeeId: string,
		sessionId: string,
	): Promise<void> {
		const paths = await this._resolveAgentPaths(employeeId);
		if (paths) {
			const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
			try {
				await this.fileService.del(fileUri);
			} catch {
				/* ignore */
			}
		}

		const index = await this._readSessionIndex(employeeId);
		const filtered = index.filter((s) => s.id !== sessionId);
		await this._writeSessionIndex(employeeId, filtered);

		// Remove from memory cache
		const key = this._cacheKey(employeeId, sessionId);
		this._historyCache.delete(key);
		await this._persistGlobalHistory();

		this.logService.info(
			`[AgentChatService] Deleted session ${sessionId} for ${employeeId}`,
		);
		this._onDidChangeAgentSessionsEmitter.fire({ employeeId });
	}

	/**
	 * Get the most recently active session for an agent.
	 * If no sessions exist, auto-create one (first conversation).
	 * Returns the AgentSessionMeta of the active session.
	 */
	async getOrCreateActiveSession(
		employeeId: string,
		name?: string,
	): Promise<AgentSessionMeta> {
		const index = await this._readSessionIndex(employeeId);
		if (index.length > 0) {
			index.sort(
				(a, b) =>
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			);
			return index[0];
		}
		return this.createAgentSession(employeeId, name || "新对话");
	}

	/**
	 * Store the external provider's session ID (e.g. Knot AG-UI threadId)
	 * into the agent session metadata so it can be sent on subsequent requests.
	 */
	async updateProviderSessionId(
		employeeId: string,
		sessionId: string,
		providerSessionId: string,
	): Promise<void> {
		const index = await this._readSessionIndex(employeeId);
		const entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			return;
		}
		if (entry.providerSessionId === providerSessionId) {
			return;
		}
		entry.providerSessionId = providerSessionId;
		entry.updatedAt = new Date().toISOString();
		await this._writeSessionIndex(employeeId, index);
		this.logService.info(
			`[AgentChatService] Stored providerSessionId=${providerSessionId} for session ${sessionId}`,
		);
	}
}
