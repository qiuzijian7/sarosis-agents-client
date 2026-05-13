/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { ILogService } from '../../log/common/log.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnhancedSessionStore, ICompressionLogEntry } from '../common/enhancedSessionStore.js';
import {
	IContextCompressionService,
	ICompressionConfig,
	ICompressionOptions,
	ICompressionResult,
	ICompressionEvent,
	IStructuredSummary,
	ITurnMessage,
	DEFAULT_COMPRESSION_CONFIG,
} from '../common/contextCompression.js';
import { ICopilotApiService } from './shared/copilotApiService.js';
import type { Anthropic } from '@anthropic-ai/sdk';

// ── Summary Generation Prompt ───────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `You are a context compression assistant. Your job is to analyze a conversation history and produce a structured summary.

Return a JSON object with the following fields:
- activeTask: string (what the user is currently trying to accomplish)
- goal: string (the explicit or implicit goal)
- constraints: string[] (limitations, requirements, or constraints mentioned)
- completedActions: string[] (actions already completed)
- activeState: string (current state of the work - what's happening right now)
- inProgress: string[] (tasks explicitly marked as in progress)
- blocked: string[] (tasks or operations that are blocked)
- keyDecisions: string[] (important decisions made during the conversation)
- resolvedQuestions: string[] (questions that have been answered)
- pendingQuestions: string[] (open questions or ambiguities)
- relevantFiles: string[] (files mentioned or modified)
- remainingWork: string[] (work remaining to complete the task)
- criticalContext: string[] (any other critical context that would be needed to continue)

IMPORTANT: Return ONLY the JSON object, no markdown formatting, no code blocks.`;

const SUMMARY_USER_PROMPT_PREFIX = `Please summarize the following conversation history. This is a coding/development conversation.

Focus on:
1. What task is being worked on
2. What has been completed
3. What is currently in progress
4. Any important decisions or context needed to continue

Conversation history:
`;

// ── Context Compression Service ─────────────────────────────────────────────

/**
 * Context Compression Service that implements the 5-stage compression pipeline
 * ported from Hermes Agent's context_compressor.py.
 *
 * Stage 1: Tool output pruning (no LLM call)
 * Stage 2: Head protection (protect first N messages)
 * Stage 3: Tail token budget protection (protect recent ~20K tokens)
 * Stage 4: Structured LLM summary generation
 * Stage 5: Iterative update (update existing summary, don't regenerate)
 */
export class ContextCompressionService extends Disposable implements IContextCompressionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidCompress = this._register(new Emitter<ICompressionEvent>());
	readonly onDidCompress = this._onDidCompress.event;

	// ── Per-session state for anti-thrashing and cooldown ──────────────

	private readonly _consecutiveLowSavings = new Map<string, number>();
	private readonly _cooldownUntil = new Map<string, number>();
	private readonly _lastSummary = new Map<string, IStructuredSummary>();
	private readonly _config: ICompressionConfig;

	constructor(
		@IEnhancedSessionStore private readonly sessionStore: IEnhancedSessionStore,
		@IConfigurationService private readonly configService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@ICopilotApiService private readonly copilotApiService: ICopilotApiService,
	) {
		super();
		this._config = this._loadConfig();
		this._registerListeners();
	}

	// ── Public API ─────────────────────────────────────────────────────

	async shouldCompress(sessionId: string): Promise<boolean> {
		// Check if enabled
		if (!this._config.enabled) {
			return false;
		}

		// Check cooldown
		if (this._isInCooldown(sessionId)) {
			this.logService.debug('[ContextCompression] Skipping - in cooldown', sessionId);
			return false;
		}

		// Get session messages and check token usage
		const messages = await this._getSessionMessages(sessionId);
		if (messages.length === 0) {
			return false;
		}

		const totalTokens = this._estimateTokens(messages);
		const threshold = totalTokens * this._config.thresholdPercent;

		// Check if we've exceeded the threshold
		const currentUsage = this._estimateTokens(messages);
		return currentUsage >= threshold;
	}

	async compress(sessionId: string, options?: ICompressionOptions): Promise<ICompressionResult> {
		try {
			// 1. Cooldown check
			if (this._isInCooldown(sessionId) && !options?.force) {
				return {
					success: false,
					sessionId,
					turnsCompressed: 0,
					turnsPreserved: 0,
					inputTokens: 0,
					outputTokens: 0,
					savingsPercent: 0,
					error: 'In cooldown period',
				};
			}

			// 2. Get session messages
			const messages = await this._getSessionMessages(sessionId);
			if (messages.length === 0) {
				return {
					success: false,
					sessionId,
					turnsCompressed: 0,
					turnsPreserved: 0,
					inputTokens: 0,
					outputTokens: 0,
					savingsPercent: 0,
					error: 'No messages to compress',
				};
			}

			// 3. Stage 1: Tool output pruning
			const pruned = this.pruneToolOutputs(messages);

			// 4. Stage 2: Head protection
			const head = pruned.slice(0, this._config.headProtectCount);
			const remaining = pruned.slice(this._config.headProtectCount);

			// 5. Stage 3: Tail token budget protection
			const { tail, middle } = this._splitByTailBudget(remaining);

			if (middle.length === 0) {
				return {
					success: false,
					sessionId,
					turnsCompressed: 0,
					turnsPreserved: head.length + tail.length,
					inputTokens: 0,
					outputTokens: 0,
					savingsPercent: 0,
					error: 'Nothing to compress (all messages protected)',
				};
			}

			// 6. Stage 4: Structured LLM summary generation
			const previousSummary = this._lastSummary.get(sessionId);
			const summary = await this._generateStructuredSummary(
				middle,
				previousSummary,
				options?.focusTopic
			);

			// 7. Stage 5: Persist compression
			await this._persistCompression(sessionId, summary, middle, tail);

			// 8. Update state
			this._lastSummary.set(sessionId, summary);

			// 9. Anti-thrashing check
			const savings = this._calculateSavings(middle, summary);
			this._updateAntiThrashing(sessionId, savings);

			// 10. Create result
			const result: ICompressionResult = {
				success: true,
				sessionId,
				turnsCompressed: middle.length,
				turnsPreserved: head.length + tail.length,
				inputTokens: this._estimateTokens(middle),
				outputTokens: this._estimateTokensFromSummary(summary),
				savingsPercent: savings,
				summary,
			};

			// 11. Fire event
			this._onDidCompress.fire({
				sessionId,
				result,
				timestamp: Date.now(),
			});

			// 12. Log to session store
			this.sessionStore.logCompression({
				sessionId,
				strategy: options?.focusTopic ? 'focused' : (options?.force ? 'manual' : 'auto'),
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				turnsCompressed: result.turnsCompressed,
				turnsPreserved: result.turnsPreserved,
				savingsPercent: result.savingsPercent,
				summaryPreview: this._summaryPreview(summary),
			});

			return result;
		} catch (err) {
			// Set cooldown on failure
			this._setCooldown(sessionId, this._config.cooldownOnFailure);

			this.logService.error('[ContextCompression] Compression failed', err);

			return {
				success: false,
				sessionId,
				turnsCompressed: 0,
				turnsPreserved: 0,
				inputTokens: 0,
				outputTokens: 0,
				savingsPercent: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	pruneToolOutputs(messages: ITurnMessage[]): ITurnMessage[] {
		return messages.map((msg, index) => {
			if (msg.role !== 'tool') {
				return msg;
			}

			// Only prune tools not in the protected head
			if (index < this._config.headProtectCount) {
				return msg;
			}

			// Generate a one-line summary of the tool result
			const summary = this._makeToolSummary(msg);
			return {
				...msg,
				content: summary,
				// Mark as pruned for debugging
				toolName: msg.toolName ? `${msg.toolName} [pruned]` : msg.toolName,
			};
		});
	}

	async getCompressionHistory(sessionId: string): Promise<ICompressionLogEntry[]> {
		return this.sessionStore.getCompressionHistory(sessionId);
	}

	resetState(sessionId: string): void {
		this._consecutiveLowSavings.delete(sessionId);
		this._cooldownUntil.delete(sessionId);
		this._lastSummary.delete(sessionId);
	}

	// ── Private: Stage Implementation ─────────────────────────────────────

	private _makeToolSummary(msg: ITurnMessage): string {
		const content = msg.content;
		const toolName = msg.toolName ?? 'unknown';

		// Truncate long outputs
		const truncated = content.length > this._config.toolOutputTruncateLength
			? content.substring(0, this._config.toolOutputTruncateLength) + '...'
			: content;

		// Identify common tool types and create informative summaries
		if (toolName.includes('terminal') || toolName.includes('shell')) {
			const lines = content.split('\n').length;
			const exitMatch = content.match(/exit code: (\d+)/);
			const exitCode = exitMatch ? exitMatch[1] : '?';
			return `[terminal] ran command → exit ${exitCode}, ${lines} lines`;
		}

		if (toolName.includes('read') || toolName.includes('file_read')) {
			const lines = content.split('\n').length;
			return `[file_read] read ${lines} lines`;
		}

		if (toolName.includes('write') || toolName.includes('file_write')) {
			const lines = content.split('\n').length;
			return `[file_write] wrote ${lines} lines`;
		}

		if (toolName.includes('search')) {
			const results = (content.match(/result/gi) || []).length;
			return `[search] found ${results} results`;
		}

		// Default summary
		return `[${toolName}] ${truncated}`;
	}

	private _splitByTailBudget(messages: ITurnMessage[]): { tail: ITurnMessage[]; middle: ITurnMessage[] } {
		const tailBudget = this._config.tailBudgetRatio;
		const totalTokens = this._estimateTokens(messages);

		// Start from the end and accumulate until we hit the tail budget
		let accumulatedTokens = 0;
		let tailCount = 0;

		for (let i = messages.length - 1; i >= 0; i--) {
			const msgTokens = messages[i].tokenCount ?? this._estimateTokens([messages[i]]);
			if (accumulatedTokens + msgTokens > totalTokens * tailBudget && tailCount > 0) {
				break;
			}
			accumulatedTokens += msgTokens;
			tailCount++;
		}

		const tail = messages.slice(messages.length - tailCount);
		const middle = messages.slice(0, messages.length - tailCount);

		return { tail, middle };
	}

	private async _generateStructuredSummary(
		middle: ITurnMessage[],
		previous?: IStructuredSummary,
		focusTopic?: string
	): Promise<IStructuredSummary> {
		try {
			// Build the conversation text for the LLM
			const conversationText = middle.map(msg => {
				const role = msg.role;
				const content = msg.content.substring(0, 2000); // Limit each message
				return `${role}: ${content}`;
			}).join('\n\n');

			// Build the user prompt
			let userPrompt = SUMMARY_USER_PROMPT_PREFIX + conversationText;
			if (previous) {
				userPrompt += '\n\nPrevious summary context:\n' + JSON.stringify(previous, null, 2);
			}
			if (focusTopic) {
				userPrompt += '\n\nFocus particularly on: ' + focusTopic;
			}

			// Get GitHub token (this is a placeholder - in real implementation,
			// we'd get this from the auth service)
			const githubToken = await this._getGitHubToken();
			if (!githubToken) {
				this.logService.warn('[ContextCompression] No GitHub token available for LLM call');
				return this._fallbackSummary(middle, previous);
			}

			// Call LLM via Copilot API
			const request: Anthropic.MessageCreateParamsNonStreaming = {
				model: 'claude-3.5-sonnet', // TODO: make configurable
				max_tokens: this._config.summaryTokenLimit,
				system: SUMMARY_SYSTEM_PROMPT,
				messages: [
					{
						role: 'user',
						content: userPrompt,
					},
				],
			};

			const response = await this.copilotApiService.messages(
				githubToken,
				request,
			);

			// Parse the response
			const content = response.content[0];
			if (content.type !== 'text') {
				throw new Error('Expected text response from LLM');
			}

			const summary = JSON.parse(content.text) as IStructuredSummary;
			return summary;
		} catch (err) {
			this.logService.error('[ContextCompression] LLM summary generation failed', err);
			// Fallback to basic summary
			return this._fallbackSummary(middle, previous);
		}
	}

	private async _persistCompression(
		sessionId: string,
		summary: IStructuredSummary,
		compressed: ITurnMessage[],
		tail: ITurnMessage[]
	): Promise<void> {
		try {
			// Store the summary in the session store
			// This creates a checkpoint that can be used to restore context
			const summaryText = JSON.stringify(summary, null, 2);

			// TODO: Implement actual persistence logic
			// Options:
			// 1. Store as a special turn in the session
			// 2. Store in a separate compression_checkpoints table
			// 3. Update the session's state to reference the compressed summary

			this.logService.info('[ContextCompression] Persisting compression', {
				sessionId,
				summaryPreview: this._summaryPreview(summary),
				compressedTurns: compressed.length,
			});

			// For now, we store the summary as a memory entry
			// This allows it to be retrieved later via memory search
			this.sessionStore.insertMemory({
				sessionId,
				category: 'general',  // 'summary' is not a valid category, use 'general'
				content: `Compression Summary:\n${summaryText}`,
				importance: 0.9, // High importance for summaries
				source: 'auto',  // 'compression' is not a valid source, use 'auto'
			});
		} catch (err) {
			this.logService.error('[ContextCompression] Failed to persist compression', err);
			throw err;
		}
	}

	private _calculateSavings(middle: ITurnMessage[], summary: IStructuredSummary): number {
		const inputTokens = this._estimateTokens(middle);
		const outputTokens = this._estimateTokensFromSummary(summary);

		if (inputTokens === 0) {
			return 0;
		}

		return Math.max(0, (inputTokens - outputTokens) / inputTokens);
	}

	private _updateAntiThrashing(sessionId: string, savings: number): void {
		if (savings < this._config.antiThrashingThreshold) {
			const current = this._consecutiveLowSavings.get(sessionId) ?? 0;
			this._consecutiveLowSavings.set(sessionId, current + 1);

			if (current + 1 >= 2) {
				// Two consecutive low-savings compressions → cooldown
				this._setCooldown(sessionId, this._config.cooldownOnFailure);
				this.logService.info('[ContextCompression] Anti-thrashing triggered', sessionId);
			}
		} else {
			// Reset on good savings
			this._consecutiveLowSavings.delete(sessionId);
		}
	}

	// ── Private: Helpers ──────────────────────────────────────────────

	private _registerListeners(): void {
		// Event listeners are registered by AgentHostIntegration
		// This method is kept for future use
		this.logService.debug('[ContextCompression] Listeners registered');
	}

	private _isInCooldown(sessionId: string): boolean {
		const until = this._cooldownUntil.get(sessionId);
		if (!until) {
			return false;
		}
		return Date.now() < until;
	}

	private _setCooldown(sessionId: string, durationMs: number): void {
		this._cooldownUntil.set(sessionId, Date.now() + durationMs);
	}

	private _estimateTokens(messages: ITurnMessage[]): number {
		// Rough estimation: ~4 characters per token
		const totalChars = messages.reduce((sum, msg) => sum + msg.content.length, 0);
		return Math.ceil(totalChars / 4);
	}

	private _estimateTokensFromSummary(summary: IStructuredSummary): number {
		const fullSummary = [
			summary.activeTask,
			summary.goal,
			...summary.constraints,
			...summary.completedActions,
			summary.activeState,
			...summary.inProgress,
			...summary.blocked,
			...summary.keyDecisions,
			...summary.resolvedQuestions,
			...summary.pendingQuestions,
			...summary.relevantFiles,
			...summary.remainingWork,
			...summary.criticalContext,
		].join('\n');

		return Math.ceil(fullSummary.length / 4);
	}

	private _summaryPreview(summary: IStructuredSummary): string {
		const preview = [
			`Task: ${summary.activeTask}`,
			`Goal: ${summary.goal}`,
			`Decisions: ${summary.keyDecisions.length}`,
		].join(' | ');

		return preview.substring(0, 200);
	}

	private _loadConfig(): ICompressionConfig {
		const config = this.configService.getValue<Partial<ICompressionConfig>>('sarosis.session.compression');
		return {
			...DEFAULT_COMPRESSION_CONFIG,
			...config,
		};
	}

	private async _getSessionMessages(sessionId: string): Promise<ITurnMessage[]> {
		// TODO: Implement getting messages from SessionStore or SessionDatabase
		// This is a placeholder - needs actual implementation
		this.logService.warn('[ContextCompression] _getSessionMessages not yet implemented');
		return [];
	}

	private async _getGitHubToken(): Promise<string | undefined> {
		// TODO: Implement getting GitHub token from auth service
		// This is a placeholder - needs actual implementation
		this.logService.warn('[ContextCompression] _getGitHubToken not yet implemented');
		return undefined;
	}

	private _fallbackSummary(
		middle: ITurnMessage[],
		previous?: IStructuredSummary
	): IStructuredSummary {
		// Create a basic summary without LLM
		const firstUserMsg = middle.find(m => m.role === 'user');
		const lastAssistantMsg = [...middle].reverse().find(m => m.role === 'assistant');

		return {
			activeTask: firstUserMsg?.content.substring(0, 100) ?? 'Unknown task',
			goal: '',
			constraints: [],
			completedActions: [],
			activeState: lastAssistantMsg?.content.substring(0, 200) ?? '',
			inProgress: [],
			blocked: [],
			keyDecisions: [],
			resolvedQuestions: [],
			pendingQuestions: [],
			relevantFiles: [],
			remainingWork: [],
			criticalContext: [],
		};
	}
}
