/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../base/common/event.js';

// ── Service Identifier ─────────────────────────────────────────────────────────

export const IContextCompressionService = createDecorator<IContextCompressionService>('contextCompressionService');

// ── Configuration Interface ───────────────────────────────────────────────────

export interface ICompressionConfig {
	/** Trigger compression when token usage reaches this percentage (default: 0.50) */
	readonly thresholdPercent: number;

	/** Number of messages to protect at the head (default: 3) */
	readonly headProtectCount: number;

	/** Tail budget as ratio of total tokens (default: 0.20) */
	readonly tailBudgetRatio: number;

	/** Maximum tokens for summary generation (default: 12000) */
	readonly summaryTokenLimit: number;

	/** Minimum tokens for summary (default: 2000) */
	readonly summaryTokenMin: number;

	/** Max summary as ratio of context length (default: 0.05) */
	readonly summaryContextRatio: number;

	/** Truncate tool outputs to this length (default: 500) */
	readonly toolOutputTruncateLength: number;

	/** Anti-thrashing threshold - skip if savings < this for consecutive runs (default: 0.10) */
	readonly antiThrashingThreshold: number;

	/** Cooldown on failure in ms (default: 60000) */
	readonly cooldownOnFailure: number;

	/** Cooldown when no provider available in ms (default: 600000) */
	readonly cooldownNoProvider: number;

	/** Enable/disable the service (default: true) */
	readonly enabled: boolean;
}

// ── Compression Options ───────────────────────────────────────────────────────

export interface ICompressionOptions {
	/** Focus topic: prioritize content related to this topic in summary */
	readonly focusTopic?: string;

	/** Force compression ignoring threshold check */
	readonly force?: boolean;

	/** Override model for summary generation */
	readonly modelOverride?: string;
}

// ── Structured Summary ────────────────────────────────────────────────────────

export interface IStructuredSummary {
	readonly activeTask: string;
	readonly goal: string;
	readonly constraints: readonly string[];
	readonly completedActions: readonly string[];
	readonly activeState: string;
	readonly inProgress: readonly string[];
	readonly blocked: readonly string[];
	readonly keyDecisions: readonly string[];
	readonly resolvedQuestions: readonly string[];
	readonly pendingQuestions: readonly string[];
	readonly relevantFiles: readonly string[];
	readonly remainingWork: readonly string[];
	readonly criticalContext: readonly string[];
}

// ── Compression Result ───────────────────────────────────────────────────────

export interface ICompressionResult {
	readonly success: boolean;
	readonly sessionId: string;
	readonly turnsCompressed: number;
	readonly turnsPreserved: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly savingsPercent: number;
	readonly summary?: IStructuredSummary;
	readonly error?: string;
}

// ── Compression Event ────────────────────────────────────────────────────────

export interface ICompressionEvent {
	readonly sessionId: string;
	readonly result: ICompressionResult;
	readonly timestamp: number;
}

// ── Turn Message (for compression pipeline) ─────────────────────────────────

export interface ITurnMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly tokenCount?: number;
}

// ── Context Compression Service Interface ────────────────────────────────────

export interface IContextCompressionService {
	readonly _serviceBrand: undefined;
	dispose(): void;

	/**
	 * Fired when compression occurs, with result information.
	 */
	readonly onDidCompress: Event<ICompressionEvent>;

	/**
	 * Check if a session needs compression.
	 * Based on current token usage ratio and thresholds.
	 */
	shouldCompress(sessionId: string): Promise<boolean>;

	/**
	 * Compress the specified session.
	 * @param sessionId - Target session
	 * @param options - Optional compression parameters
	 * @returns Compression result
	 */
	compress(sessionId: string, options?: ICompressionOptions): Promise<ICompressionResult>;

	/**
	 * Stage 1 only: prune tool outputs without calling LLM.
	 * Can be used as a low-cost preprocessing step anytime.
	 */
	pruneToolOutputs(messages: ITurnMessage[]): ITurnMessage[];

	/**
	 * Get compression history for a session.
	 */
	getCompressionHistory(sessionId: string): Promise<ICompressionLogEntry[]>;

	/**
	 * Reset compression state for a session (anti-thrashing counter, cooldown timer).
	 */
	resetState(sessionId: string): void;
}

// ── Compression Log Entry (re-exported from enhancedSessionStore) ────────────

export interface ICompressionLogEntry {
	readonly id?: number;
	readonly sessionId: string;
	readonly compressedAt: string;
	readonly strategy: 'auto' | 'manual' | 'focused';
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly turnsCompressed: number;
	readonly turnsPreserved: number;
	readonly savingsPercent?: number;
	readonly summaryPreview?: string;
}

// ── Default Configuration ───────────────────────────────────────────────────

export const DEFAULT_COMPRESSION_CONFIG: ICompressionConfig = {
	thresholdPercent: 0.50,
	headProtectCount: 3,
	tailBudgetRatio: 0.20,
	summaryTokenLimit: 12000,
	summaryTokenMin: 2000,
	summaryContextRatio: 0.05,
	toolOutputTruncateLength: 500,
	antiThrashingThreshold: 0.10,
	cooldownOnFailure: 60000,
	cooldownNoProvider: 600000,
	enabled: true,
};
