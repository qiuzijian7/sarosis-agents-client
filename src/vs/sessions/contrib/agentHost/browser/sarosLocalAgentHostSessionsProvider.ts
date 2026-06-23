/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { autorun } from '../../../../base/common/observable.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { LocalAgentHostSessionsProvider } from './localAgentHostSessionsProvider.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { IWorktreeCheckpointService } from '../../worktree/common/worktreeCheckpointService.js';
import { SAROS_LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISendRequestOptions } from '../../../services/sessions/common/sessionsProvider.js';

/**
 * Saros-enhanced local agent host sessions provider.
 *
 * Extends {@link LocalAgentHostSessionsProvider} with the following capabilities
 * ported from {@link CopilotChatSessionsProvider}:
 *
 * - **Worktree support**: Notifies the {@link IWorktreeService} of request
 *   start/complete so the worktree view and changes view stay in sync.
 * - **Checkpoint functionality**: Creates baseline + post-turn checkpoints via
 *   {@link IWorktreeCheckpointService}, enabling rollback to a previous state.
 * - **Isolation mode**: Inherits `SessionConfigKey.Isolation` support from the
 *   base class; the agent host creates a worktree when isolation is set to
 *   `'worktree'`.
 * - **Permission level**: Inherits `SessionConfigKey.AutoApprove` support from
 *   the base class; seeded from `chat.permissions.default` configuration.
 * - **GitHub integration**: Inherited from {@link BaseAgentHostSessionsProvider}
 *   via `IGitHubService` (PR detection, branch protection, etc.).
 *
 * This provider is registered as the **default** local sessions provider,
 * replacing the plain {@link LocalAgentHostSessionsProvider} for Saros
 environments
 * that need checkpoint/worktree orchestration on top of the agent host.
 */
export class SarosLocalAgentHostSessionsProvider extends LocalAgentHostSessionsProvider {

	/** Prefix used for worktree branches created by this provider. */
	static readonly SAROS_WORKTREE_PATTERN = 'saros-worktree-';

	override readonly id = SAROS_LOCAL_AGENT_HOST_PROVIDER_ID;

	private _checkpointsEnabled: boolean;

	constructor(
		@IAgentHostService agentHostService: IAgentHostService,
		@IChatSessionsService chatSessionsService: IChatSessionsService,
		@IChatService chatService: IChatService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ILabelService labelService: ILabelService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IGitHubService gitHubService: IGitHubService,
		@IWorktreeService private readonly _worktreeService: IWorktreeService,
		@IWorktreeCheckpointService private readonly _checkpointService: IWorktreeCheckpointService,
	) {
		super(
			agentHostService,
			chatSessionsService,
			chatService,
			chatWidgetService,
			languageModelsService,
			labelService,
			configurationService,
			logService,
			gitHubService,
		);

		this._checkpointsEnabled = configurationService.getValue<boolean>(ChatConfiguration.CheckpointsEnabled) ?? true;

		// React to checkpoint setting changes at runtime.
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatConfiguration.CheckpointsEnabled)) {
				this._checkpointsEnabled = configurationService.getValue<boolean>(ChatConfiguration.CheckpointsEnabled) ?? true;
			}
		}));
	}

	// ── Session lifecycle: checkpoint + worktree orchestration ──────────────

	/**
	 * Override of {@link BaseAgentHostSessionsProvider.sendAndCreateChat} that
	 * adds:
	 *
	 * 1. **Baseline checkpoint** — created as soon as the committed session's
	 *    worktree path is available (right after `super` returns). Captures the
	 *    initial state of the worktree so the user can roll back.
	 * 2. **Worktree notification** — tells {@link IWorktreeService} that a
	 *    request has started for this worktree.
	 * 3. **Post-turn checkpoint** — created when the session status transitions
	 *    from `InProgress` back to `Completed`/`Error`. Captures the state after
	 *    the agent's turn.
	 *
	 * The actual request sending, chat-widget opening, and session-commit
	 * waiting are all handled by `super.sendAndCreateChat` — this override only
	 * wraps it with checkpoint/worktree side effects.
	 */
	override async sendAndCreateChat(chatId: string, options: ISendRequestOptions): Promise<ISession> {
		// Delegate to the base class for the full send flow.
		const session = await super.sendAndCreateChat(chatId, options);

		// Extract the worktree path from the committed session's workspace.
		// The agent host creates the worktree (when isolation='worktree')
		// during session creation, so the path is only available after the
		// session is committed.
		const worktreePath = this._getWorktreePathFromSession(session);
		if (!worktreePath || !this._checkpointsEnabled) {
			return session;
		}

		// ── Baseline checkpoint + request-start notification ────────────
		// Created immediately after the session is committed. This captures
		// the worktree's initial state (cloned from the base branch). The
		// agent may have already begun working, but the baseline still
		// provides a useful rollback point for the first turn.
		await this._createBaselineCheckpoint(session.sessionId, worktreePath);
		await this._notifyRequestStart(session.sessionId, worktreePath);

		// ── Post-turn checkpoint on response completion ─────────────────
		// We watch the session's status observable for the InProgress →
		// Completed/Error transition. When detected, a post-turn checkpoint
		// is created and the worktree service is notified.
		this._setupPostTurnCheckpoint(session, worktreePath);

		return session;
	}

	/**
	 * Override of {@link BaseAgentHostSessionsProvider.deleteSession} that
	 * also cleans up all checkpoints associated with the session's worktree.
	 */
	override async deleteSession(sessionId: string): Promise<void> {
		// Clean up checkpoints before the session (and its worktree path) is
		// removed from the cache.
		const worktreePath = this._getWorktreePathBySessionId(sessionId);
		if (worktreePath) {
			await this._deleteSessionCheckpoints(sessionId, worktreePath).catch(e => {
				this._logError('Failed to delete session checkpoints', sessionId, e);
			});
		}

		await super.deleteSession(sessionId);
	}

	// ── Checkpoint helpers ──────────────────────────────────────────────────

	/**
	 * Extract the worktree (working directory) filesystem path from a session's
	 * workspace observable. Returns `undefined` when the session has no
	 * repository or no working directory (e.g. isolation mode is `'workspace'`
	 * rather than `'worktree'`).
	 */
	private _getWorktreePathFromSession(session: ISession): string | undefined {
		const workspace = session.workspace.get();
		const repository = workspace?.repositories[0];
		return repository?.workingDirectory?.fsPath;
	}

	/**
	 * Look up a cached session by its session ID and extract the worktree path.
	 * Used in {@link deleteSession} where the session may still be in the
	 * cache before deletion.
	 */
	private _getWorktreePathBySessionId(sessionId: string): string | undefined {
		// Iterate cached sessions to find the one matching the session ID.
		for (const s of this.getSessions()) {
			if (s.sessionId === sessionId) {
				return this._getWorktreePathFromSession(s);
			}
		}
		return undefined;
	}

	/** Create a baseline checkpoint for the session's worktree. */
	private async _createBaselineCheckpoint(sessionId: string, worktreePath: string): Promise<void> {
		try {
			await this._checkpointService.createBaselineCheckpoint(sessionId, worktreePath);
			this._logInfo('Baseline checkpoint created', sessionId);
		} catch (e) {
			this._logError('Failed to create baseline checkpoint', sessionId, e);
		}
	}

	/** Create a post-turn checkpoint after a request completes. */
	private async _createPostTurnCheckpoint(sessionId: string, worktreePath: string, requestId: string): Promise<void> {
		try {
			await this._checkpointService.createPostTurnCheckpoint(sessionId, worktreePath, requestId);
			this._logInfo(`Post-turn checkpoint created for request ${requestId}`, sessionId);
		} catch (e) {
			this._logError(`Failed to create post-turn checkpoint for request ${requestId}`, sessionId, e);
		}
	}

	/** Delete all checkpoints for a session (e.g. on session deletion). */
	private async _deleteSessionCheckpoints(sessionId: string, worktreePath: string): Promise<void> {
		await this._checkpointService.deleteSessionCheckpoints(sessionId, worktreePath);
		this._logInfo('Session checkpoints deleted', sessionId);
	}

	// ── Worktree notification helpers ───────────────────────────────────────

	/** Notify the worktree service that a request has started. */
	private async _notifyRequestStart(sessionId: string, worktreePath: string): Promise<void> {
		try {
			await this._worktreeService.notifyRequestStart(sessionId, worktreePath);
		} catch (e) {
			this._logError('Failed to notify request start', sessionId, e);
		}
	}

	/** Notify the worktree service that a request has completed. */
	private async _notifyRequestComplete(sessionId: string, worktreePath: string, requestId: string): Promise<void> {
		try {
			await this._worktreeService.notifyRequestComplete(sessionId, worktreePath, requestId);
		} catch (e) {
			this._logError('Failed to notify request complete', sessionId, e);
		}
	}

	// ── Post-turn checkpoint orchestration ──────────────────────────────────

	/**
	 * Set up a one-shot autorun that watches the session's status observable
	 * for the `InProgress` → `Completed`/`Error` transition. When detected:
	 *
	 * 1. A post-turn checkpoint is created (capturing the agent's changes).
	 * 2. The worktree service is notified of request completion.
	 *
	 * The autorun disposes itself after the first completed transition, so it
	 * does not leak across turns. Each subsequent turn (via a new
	 * `sendAndCreateChat` call) sets up a fresh watcher.
	 */
	private _setupPostTurnCheckpoint(session: ISession, worktreePath: string): void {
		const watcher = this._register(new DisposableStore());
		let wasInProgress = false;

		watcher.add(autorun(reader => {
			const status = session.status.read(reader);

			if (status === SessionStatus.InProgress) {
				wasInProgress = true;
				return;
			}

			if (!wasInProgress) {
				return;
			}

			// Status transitioned away from InProgress — request is done.
			wasInProgress = false;

			const requestId = generateUuid();
			const sessionId = session.sessionId;

			// Fire-and-forget: checkpoint creation must not block the UI.
			(async () => {
				await this._createPostTurnCheckpoint(sessionId, worktreePath, requestId);
				await this._notifyRequestComplete(sessionId, worktreePath, requestId);
			})();

			// One-shot: dispose the watcher after the first completion.
			watcher.dispose();
		}));
	}

	// ── Logging ─────────────────────────────────────────────────────────────

	private _logInfo(message: string, sessionId: string): void {
		this._logService.info(`[SarosLocalAgentHostSessionsProvider] ${message} (session=${sessionId})`);
	}

	private _logError(message: string, sessionId: string, error: unknown): void {
		this._logService.error(`[SarosLocalAgentHostSessionsProvider] ${message} (session=${sessionId}):`, error);
	}
}
