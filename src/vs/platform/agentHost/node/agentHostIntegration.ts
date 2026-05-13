/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { IAgentService } from '../common/agentService.js';
import { IContextCompressionService } from '../common/contextCompression.js';
import { IMemoryService } from '../common/memoryService.js';
import { ILogService } from '../../log/common/log.js';

/**
 * Agent Host Integration module that wires together:
 * - IAgentService (event source)
 * - IContextCompressionService (auto-compression on turn complete)
 * - IMemoryService (memory sync on turn complete, prefetch on message send)
 *
 * This is the main integration point for the Session & Context Enhancement framework.
 *
 * Usage:
 * ```typescript
 * const integration = new AgentHostIntegration(
 *   agentService,
 *   contextCompressionService,
 *   memoryService,
 *   logService,
 *   sessionStore,
 * );
 * // Automatically listens to events and triggers compression/memory operations
 * ```
 */
export class AgentHostIntegration extends Disposable {
	constructor(
		@IAgentService private readonly agentService: IAgentService,
		@IContextCompressionService private readonly compressionService: IContextCompressionService,
		@IMemoryService private readonly memoryService: IMemoryService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._registerListeners();
		this.logService.info('[AgentHostIntegration] Initialized');
	}

	// ── Event Listeners ──────────────────────────────────────────────

	private _registerListeners(): void {
		// Listen for actions from the agent service
		this._register(
			this.agentService.onDidAction((envelope) => {
				this._handleAction(envelope).catch(err => {
					this.logService.error('[AgentHostIntegration] Error handling action', err);
				});
			})
		);

		// Listen for notifications (session added/removed/etc.)
		this._register(
			this.agentService.onDidNotification((notification) => {
				this._handleNotification(notification).catch(err => {
					this.logService.error('[AgentHostIntegration] Error handling notification', err);
				});
			})
		);

		this.logService.debug('[AgentHostIntegration] Event listeners registered');
	}

	private async _handleAction(envelope: unknown): Promise<void> {
		const action = (envelope as any).action;
		const sessionUri = action?.session?.toString();

		if (!sessionUri) {
			return;
		}

		// Extract session ID from URI (format: provider:/sessionId)
		const sessionId = sessionUri.split('/').pop() ?? sessionUri;

		switch (action.type) {
			case 'session/turnComplete':
			case 'turnComplete':
				await this._onTurnComplete(sessionId, action);
				break;

			case 'session/ready':
			case 'sessionReady':
				await this._onSessionReady(sessionId);
				break;

			case 'session/closed':
			case 'sessionClosed':
				await this._onSessionClosed(sessionId);
				break;

			default:
				// Ignore other actions
				break;
		}
	}

	private async _handleNotification(notification: unknown): Promise<void> {
		const kind = (notification as any).kind;
		const sessionUri = (notification as any).session?.toString();

		if (!sessionUri) {
			return;
		}

		const sessionId = sessionUri.split('/').pop() ?? sessionUri;

		switch (kind) {
			case 'sessionAdded':
				await this._onSessionReady(sessionId);
				break;

			case 'sessionRemoved':
				await this._onSessionClosed(sessionId);
				break;

			default:
				break;
		}
	}

	// ── Event Handlers ────────────────────────────────────────────

	private async _onSessionReady(sessionId: string): Promise<void> {
		this.logService.debug('[AgentHostIntegration] Session ready', sessionId);

		try {
			await this.memoryService.initialize(sessionId);
		} catch (err) {
			this.logService.error('[AgentHostIntegration] Failed to initialize memory service', err);
		}
	}

	private async _onTurnComplete(sessionId: string, action: Record<string, unknown>): Promise<void> {
		this.logService.debug('[AgentHostIntegration] Turn complete', sessionId);

		// Run compression check and memory sync in parallel
		await Promise.all([
			this._maybeCompress(sessionId),
			this._syncMemory(sessionId, action),
		]);
	}

	private async _maybeCompress(sessionId: string): Promise<void> {
		try {
			if (await this.compressionService.shouldCompress(sessionId)) {
				this.logService.info('[AgentHostIntegration] Starting compression', sessionId);
				const result = await this.compressionService.compress(sessionId);

				if (result.success) {
					this.logService.info(
						`[AgentHostIntegration] Compression complete: ${result.turnsCompressed} turns compressed, ${result.savingsPercent}% savings`
					);
				} else {
					this.logService.warn('[AgentHostIntegration] Compression failed', result.error);
				}
			}
		} catch (err) {
			this.logService.error('[AgentHostIntegration] Compression error', err);
		}
	}

	private async _syncMemory(sessionId: string, action: Record<string, unknown>): Promise<void> {
		try {
			// Extract user message and assistant response from the action
			const userMessage = this._extractUserMessage(action);
			const assistantResponse = this._extractAssistantResponse(action);

			if (userMessage && assistantResponse) {
				await this.memoryService.syncTurn(sessionId, userMessage, assistantResponse);
			}
		} catch (err) {
			this.logService.error('[AgentHostIntegration] Memory sync failed', err);
		}
	}

	private async _onSessionClosed(sessionId: string): Promise<void> {
		this.logService.debug('[AgentHostIntegration] Session closed', sessionId);

		try {
			await this.memoryService.onSessionSwitch('');
			// Also reset compression state
			this.compressionService.resetState(sessionId);
		} catch (err) {
			this.logService.error('[AgentHostIntegration] Failed to handle session close', err);
		}
	}

	// ── Public API for Prefetch (call before sending message) ─────────

	/**
	 * Call this before sending a message to inject memory context.
	 * Returns the memory context string to prepend to the message.
	 */
	async prefetchMemoryContext(sessionId: string, userMessage: string): Promise<string> {
		try {
			return await this.memoryService.prefetch(sessionId, userMessage);
		} catch (err) {
			this.logService.error('[AgentHostIntegration] Prefetch failed', err);
			return '';
		}
	}

	/**
	 * Queue prefetch for the next turn (non-blocking).
	 */
	queuePrefetch(sessionId: string, userMessage: string): void {
		this.memoryService.queuePrefetch(sessionId, userMessage);
	}

	// ── Private Helpers ─────────────────────────────────────────

	private _extractUserMessage(action: Record<string, unknown>): string | undefined {
		// Try to extract user message from action
		// This depends on the actual action structure
		const turns = action['turns'] as Array<{ role: string; content: string }> | undefined;
		if (turns) {
			const userTurn = turns.reverse().find(t => t.role === 'user');
			return userTurn?.content;
		}
		return undefined;
	}

	private _extractAssistantResponse(action: Record<string, unknown>): string | undefined {
		// Try to extract assistant response from action
		const turns = action['turns'] as Array<{ role: string; content: string }> | undefined;
		if (turns) {
			const assistantTurn = turns.reverse().find(t => t.role === 'assistant');
			return assistantTurn?.content;
		}
		return undefined;
	}
}
