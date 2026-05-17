/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentChatService } from '../common/agentStudio.js';
import type { IChatStreamDelta, IChatSendOptions } from '../common/agentStudio.js';
import { IAgentDriverService } from '../common/agentDriver.js';
import type { ChatMessage } from '../common/types.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { AGENT_STUDIO_DATA_PATH_SETTING, DATA_FILE_CHAT_HISTORY } from '../common/constants.js';

/**
 * AgentChatService implements Knot AG-UI protocol translation with 16ms frame throttling.
 * Migrated from sarosis-webui's /api/chat/knot/route.ts
 *
 * Phase 2: Refactored to delegate to AgentDriverService.
 * sendMessage() now delegates to driverService.executeFromChatOptions().
 *
 * Chat history is persisted to disk (chat-history.json) and also cached in memory
 * for fast lookups without repeated file I/O.
 */
export class AgentChatService extends Disposable implements IAgentChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _activeStreams = new Map<string, AbortController>();
	private readonly logService: ILogService;
	private readonly driverService: IAgentDriverService;
	private readonly fileService: IFileService;
	private readonly environmentService: IEnvironmentService;
	private readonly configurationService: IConfigurationService;

	/** In-memory cache: compositeKey (employeeId or employeeId::sessionId) → messages */
	private readonly _historyCache = new Map<string, ChatMessage[]>();
	/** Whether the history file has been loaded from disk */
	private _historyLoaded = false;
	/** Global data URI (lazy) */
	private _globalDataUri: URI | undefined;

	constructor(
		@ILogService logService: ILogService,
		@IAgentDriverService driverService: IAgentDriverService,
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		this.logService = logService;
		this.driverService = driverService;
		this.fileService = fileService;
		this.environmentService = environmentService;
		this.configurationService = configurationService;
	}

	// ─── Data Directory ─────────────────────────────────────────────────────

	private _getGlobalDataUri(): URI {
		if (!this._globalDataUri) {
			const customPath = this.configurationService.getValue<string>(AGENT_STUDIO_DATA_PATH_SETTING);
			if (customPath) {
				this._globalDataUri = URI.file(customPath);
			} else {
				this._globalDataUri = URI.joinPath(this.environmentService.userRoamingDataHome, 'agent-studio');
			}
		}
		return this._globalDataUri;
	}

	private _getHistoryFileUri(): URI {
		return URI.joinPath(this._getGlobalDataUri(), DATA_FILE_CHAT_HISTORY);
	}

	// ─── Persistence ────────────────────────────────────────────────────────

	private async _ensureHistoryLoaded(): Promise<void> {
		if (this._historyLoaded) {
			return;
		}
		this._historyLoaded = true;
		try {
			const uri = this._getHistoryFileUri();
			const exists = await this.fileService.exists(uri);
			if (!exists) {
				this.logService.debug('[AgentChatService] No history file found, starting fresh');
				return;
			}
			const content = await this.fileService.readFile(uri);
			const data = JSON.parse(content.value.toString()) as Record<string, ChatMessage[]>;
			for (const [employeeId, messages] of Object.entries(data)) {
				this._historyCache.set(employeeId, messages);
			}
			const totalMessages = [...this._historyCache.values()].reduce((sum, m) => sum + m.length, 0);
			this.logService.info(`[AgentChatService] Loaded chat history: ${this._historyCache.size} employees, ${totalMessages} messages`);
		} catch (err) {
			this.logService.error('[AgentChatService] Failed to load chat history:', err);
			// Non-fatal — start with empty cache
		}
	}

	private async _persistHistory(): Promise<void> {
		try {
			const uri = this._getHistoryFileUri();
			const data: Record<string, ChatMessage[]> = {};
			for (const [employeeId, messages] of this._historyCache) {
				data[employeeId] = messages;
			}
			const content = VSBuffer.fromString(JSON.stringify(data, null, 2));
			await this.fileService.writeFile(uri, content);
		} catch (err) {
			this.logService.error('[AgentChatService] Failed to persist chat history:', err);
		}
	}

	/** Build the composite cache key for history lookups. */
	private _cacheKey(employeeId: string, sessionId?: string): string {
		return sessionId ? `${employeeId}::${sessionId}` : employeeId;
	}

	/** Append a message to the history for the given employee and persist. */
	async appendMessage(employeeId: string, message: ChatMessage): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(employeeId, message.agentSessionId);
		let messages = this._historyCache.get(key);
		if (!messages) {
			messages = [];
			this._historyCache.set(key, messages);
		}
		messages.push(message);
		// Fire-and-forget persistence
		this._persistHistory().catch(err =>
			this.logService.error('[AgentChatService] Background persist failed:', err),
		);
	}

	// ─── Chat ───────────────────────────────────────────────────────────────

	async sendMessage(
		employeeId: string,
		message: string,
		options: IChatSendOptions,
		onDelta: (delta: IChatStreamDelta) => void,
	): Promise<ChatMessage> {
		// Build composite stream key for cancellation (session-safe)
		const streamKey = options.agentSessionId ? `${employeeId}::${options.agentSessionId}` : employeeId;

		// Cancel any existing stream for this employee+session
		this.cancelStream(streamKey);

		const controller = new AbortController();
		this._activeStreams.set(streamKey, controller);

		let fullContent = '';
		let fullThinking = '';
		let toolCalls: ChatMessage['toolCalls'];

		try {
			// Delegate to Driver Service
			this.logService.info(`[AgentChatService] Delegating to driverService.executeFromChatOptions, employeeId=${employeeId}`);
			const stream = this.driverService.executeFromChatOptions(employeeId, message, options);

			let deltaCount = 0;
			for await (const delta of stream) {
				deltaCount++;
				this.logService.info(`[AgentChatService] Received delta #${deltaCount}: type=${delta.type}, contentLen=${delta.content?.length ?? 0}`);

				// Check cancellation
				if (controller.signal.aborted) {
					this.logService.info(`[AgentChatService] Stream aborted at delta #${deltaCount}`);
					break;
				}

				// Accumulate content for final ChatMessage
				if (delta.type === 'text' && delta.content) {
					fullContent += delta.content;
				}
				if (delta.type === 'thinking' && delta.content) {
					fullThinking += delta.content;
				}
				// Accumulate tool calls
				if (delta.type === 'tool_start' && delta.toolCallId && delta.toolName) {
					if (!toolCalls) { toolCalls = []; }
					toolCalls.push({ id: delta.toolCallId, name: delta.toolName, arguments: '', result: undefined });
				}
				if (delta.type === 'tool_args' && delta.toolCallId && delta.content && toolCalls) {
					const tc = toolCalls.find(t => t.id === delta.toolCallId);
					if (tc) { tc.arguments += delta.content!; }
				}
				if (delta.type === 'tool_result' && delta.toolCallId && toolCalls) {
					const tc = toolCalls.find(t => t.id === delta.toolCallId);
					if (tc) { tc.result = delta.content; }
				}

				// Forward delta to UI
				onDelta(delta);
			}
			this.logService.info(`[AgentChatService] Stream ended, totalDeltas=${deltaCount}, contentLen=${fullContent.length}`);

			// Build final ChatMessage
			const chatMessage: ChatMessage = {
				id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
				role: 'assistant',
				content: fullContent,
				employeeId,
				agentSessionId: options.agentSessionId,
				thinking: fullThinking || undefined,
				toolCalls: toolCalls || undefined,
				timestamp: new Date().toISOString(),
			};

			// Persist the assistant message
			this.appendMessage(employeeId, chatMessage).catch(err =>
				this.logService.error('[AgentChatService] Failed to persist assistant message:', err),
			);

			return chatMessage;

		} catch (error) {
			this.logService.error(`[AgentChatService] sendMessage failed for ${employeeId}:`, error);
			onDelta({ type: 'error', content: String(error) });
			throw error;
		} finally {
			this._activeStreams.delete(streamKey);
		}
	}

	async getHistory(employeeId: string, sessionId?: string): Promise<ChatMessage[]> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(employeeId, sessionId);
		const messages = this._historyCache.get(key) || [];
		this.logService.info(`[AgentChatService] getHistory: ${messages.length} messages for key ${key}`);
		return messages;
	}

	async clearHistory(employeeId: string, sessionId?: string): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(employeeId, sessionId);
		this._historyCache.delete(key);
		await this._persistHistory();
		this.logService.info(`[AgentChatService] clearHistory: cleared for key ${key}`);
	}

	cancelStream(employeeId: string): void {
		const controller = this._activeStreams.get(employeeId);
		if (controller) {
			controller.abort();
			this._activeStreams.delete(employeeId);
		}
	}
}
