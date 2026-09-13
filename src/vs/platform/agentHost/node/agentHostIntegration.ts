/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { IAgentService } from '../common/agentService.js';
import { IContextCompressionService } from '../common/contextCompression.js';
import { ILogService } from '../../log/common/log.js';

/**
 * Agent Host Integration module that wires together:
 * - IAgentService (event source)
 * - IContextCompressionService (auto-compression on turn complete)
 *
 * P2-12（2026-09-09）：IMemoryService 已删除（agentHost 记忆栈从未接入主链路，
 * 产品记忆由 sessions/agentStudio 的 AgentMemory 网关承担——见
 * sessions/contrib/agentStudio/browser/agentMemoryInjection.ts）。
 * 本类收敛为「自动压缩触发器」单一职责。
 */
export class AgentHostIntegration extends Disposable {
	constructor(
		@IAgentService private readonly agentService: IAgentService,
		@IContextCompressionService private readonly compressionService: IContextCompressionService,
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
				await this._onTurnComplete(sessionId);
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
		// P2-12: memory initialize 已随 agentHost 记忆栈删除
	}

	private async _onTurnComplete(sessionId: string): Promise<void> {
		this.logService.debug('[AgentHostIntegration] Turn complete', sessionId);
		await this._maybeCompress(sessionId);
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

	private async _onSessionClosed(sessionId: string): Promise<void> {
		this.logService.debug('[AgentHostIntegration] Session closed', sessionId);

		try {
			// Reset compression state
			this.compressionService.resetState(sessionId);
		} catch (err) {
			this.logService.error('[AgentHostIntegration] Failed to handle session close', err);
		}
	}
}
