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

/**
 * AgentChatService implements Knot AG-UI protocol translation with 16ms frame throttling.
 * Migrated from sarosis-webui's /api/chat/knot/route.ts
 *
 * Phase 2: Refactored to delegate to AgentDriverService.
 *sendMessage() now delegates to driverService.executeFromChatOptions().
 */
export class AgentChatService extends Disposable implements IAgentChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _activeStreams = new Map<string, AbortController>();
	private readonly logService: ILogService;
	private readonly driverService: IAgentDriverService;

	constructor(
		@ILogService logService: ILogService,
		@IAgentDriverService driverService: IAgentDriverService,
	) {
		super();
		this.logService = logService;
		this.driverService = driverService;
	}

	async sendMessage(
		employeeId: string,
		message: string,
		options: IChatSendOptions,
		onDelta: (delta: IChatStreamDelta) => void,
	): Promise<ChatMessage> {
		// Phase 2: Delegate to AgentDriverService
		// The Driver orchestrates the full turn: Planning → Memory → Model → Tool → Memory

		// Cancel any existing stream for this employee
		this.cancelStream(employeeId);

		const controller = new AbortController();
		this._activeStreams.set(employeeId, controller);

		let fullContent = '';
		let fullThinking = '';

		try {
			// Delegate to Driver Service
			const stream = this.driverService.executeFromChatOptions(employeeId, message, options);

			for await (const delta of stream) {
				// Check cancellation
				if (controller.signal.aborted) {
					break;
				}

				// Accumulate content for final ChatMessage
				if (delta.type === 'text' && delta.content) {
					fullContent += delta.content;
				}
				if (delta.type === 'thinking' && delta.content) {
					fullThinking += delta.content;
				}

				// Forward delta to UI
				onDelta(delta);
			}

			// Build final ChatMessage
			const chatMessage: ChatMessage = {
				id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
				role: 'assistant',
				content: fullContent,
				employeeId,
				thinking: fullThinking || undefined,
				timestamp: new Date().toISOString(),
			};

			return chatMessage;

		} catch (error) {
			this.logService.error(`[AgentChatService] sendMessage failed for ${employeeId}:`, error);
			onDelta({ type: 'error', content: String(error) });
			throw error;
		} finally {
			this._activeStreams.delete(employeeId);
		}
	}

	async getHistory(_employeeId: string, _sessionId?: string): Promise<ChatMessage[]> {
		// TODO: Read from persisted chat history
		return [];
	}

	async clearHistory(_employeeId: string, _sessionId?: string): Promise<void> {
		// TODO: Clear persisted chat history
	}

	cancelStream(employeeId: string): void {
		const controller = this._activeStreams.get(employeeId);
		if (controller) {
			controller.abort();
			this._activeStreams.delete(employeeId);
		}
	}
}
