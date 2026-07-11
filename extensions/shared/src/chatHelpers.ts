/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared chat helper utilities for Sarosis chat model providers.
 */

import * as vscode from 'vscode';

/**
 * Extract plain text content from a LanguageModelChatRequestMessage.
 */
export function extractText(msg: vscode.LanguageModelChatRequestMessage): string {
	const parts: string[] = [];
	for (const part of msg.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			parts.push(part.value);
		}
	}
	return parts.join('');
}

/**
 * OpenAI Chat Completions multimodal content part.
 *   • text  → { type: 'text', text }
 *   • image → { type: 'image_url', image_url: { url: 'data:<mime>;base64,<b64>' } }
 */
export type OpenAIContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

/**
 * Extract OpenAI-style content from a chat message, preserving image attachments.
 *
 * VS Code delivers image attachments to a chat provider as
 * `LanguageModelDataPart` instances (the exthost converts the internal
 * `image_url` part into a data part with `.mimeType` + binary `.data`). The
 * legacy {@link extractText} drops those parts entirely, so any model behind an
 * OpenAI-compatible endpoint never receives the image and reports it cannot see
 * it.
 *
 * This helper returns:
 *   • a plain `string` when the message is text-only (keeps the request body
 *     identical to before for non-image turns — maximum back-compat), or
 *   • an `OpenAIContentPart[]` when one or more image data parts are present,
 *     mirroring OpenAI's multimodal `content` array (a leading text part, then
 *     each image as an `image_url` data URL).
 *
 * Image bytes are base64-encoded back into a `data:` URL (OpenAI's expected
 * transport); non-image data parts are ignored.
 */
export function extractMessageContent(
	msg: vscode.LanguageModelChatRequestMessage,
): string | OpenAIContentPart[] {
	const textParts: string[] = [];
	const imageParts: OpenAIContentPart[] = [];

	for (const part of msg.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			textParts.push(part.value);
		} else if (part instanceof vscode.LanguageModelDataPart) {
			const mime = part.mimeType || '';
			if (mime.startsWith('image/')) {
				const base64 = Buffer.from(part.data).toString('base64');
				imageParts.push({
					type: 'image_url',
					image_url: { url: `data:${mime};base64,${base64}` },
				});
			}
		}
	}

	// Text-only → keep the simple string form (unchanged request shape).
	if (imageParts.length === 0) {
		return textParts.join('');
	}

	// Multimodal → OpenAI content array: text first (if any), then images.
	const out: OpenAIContentPart[] = [];
	const text = textParts.join('');
	if (text) {
		out.push({ type: 'text', text });
	}
	out.push(...imageParts);
	return out;
}

/**
 * Extract the model name from a full model ID by stripping the vendor prefix.
 * Handles multiple prefix layers (e.g. "codebuddy-codebuddy-deepseek-v4-pro-ioa" → "deepseek-v4-pro-ioa").
 * e.g. "codebuddy-claude-4.5" → "claude-4.5"
 *      "codebuddy/claude-4.5" → "claude-4.5"
 *      "codebuddy-codebuddy-deepseek-v4-pro-ioa" → "deepseek-v4-pro-ioa"
 */
export function extractModelName(modelId: string, vendorPrefix: string): string {
	let cleaned = modelId;
	// Strip ALL "vendor/" prefixes (server models may carry the prefix in their id)
	while (cleaned.startsWith(`${vendorPrefix}/`)) {
		cleaned = cleaned.slice(`${vendorPrefix}/`.length);
	}
	// Strip ALL "vendor-" prefixes (createModelInfo may double-prefix)
	while (cleaned.startsWith(`${vendorPrefix}-`)) {
		cleaned = cleaned.slice(`${vendorPrefix}-`.length);
	}
	return cleaned;
}

/**
 * Estimate token count for a text or message.
 * Uses a simple heuristic: ~4 chars per token.
 */
export function estimateTokenCount(
	text: string | vscode.LanguageModelChatRequestMessage,
	extractTextFn: (msg: vscode.LanguageModelChatRequestMessage) => string = extractText,
): number {
	const raw = typeof text === 'string' ? text : extractTextFn(text);
	return Math.max(1, Math.ceil(raw.length / 4));
}

/**
 * Separate system messages from conversation messages in VS Code chat format.
 * Returns { systemText, conversationMessages }.
 */
export function separateSystemMessage(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): {
	systemText: string | undefined;
	conversationMessages: readonly vscode.LanguageModelChatRequestMessage[];
} {
	const SystemRole = 3 as vscode.LanguageModelChatMessageRole;
	// 对齐 Continue：拼接所有 system 消息，而非只取第一条。
	// agentOSService 可能注入多条 system 消息（base prompt + memory context），
	// 旧逻辑 `find()` 只保留第一条，后续的 memory/技能注入被静默丢弃。
	const systemTexts = messages
		.filter(m => m.role === SystemRole)
		.map(m => extractText(m))
		.filter(t => t && t.trim().length > 0);
	const conversationMessages = messages.filter(m => m.role !== SystemRole);

	return {
		systemText: systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined,
		conversationMessages,
	};
}

/**
 * Convert conversation messages to simple {role, content} pairs.
 */
export function toRoleContentPairs(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
	return messages.map(msg => ({
		role: msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' as const : 'user' as const,
		content: extractText(msg),
	}));
}

// ─── Token estimation helpers (aligned with Continue countTokens.ts) ───────

/** Minimum output tokens reserved for model response (never pruned away). */
const MIN_RESPONSE_TOKENS = 1000;
/** Safety buffer as proportion of context length (2%). */
const TOKEN_SAFETY_PROPORTION = 0.02;
/** Cap on safety buffer. */
const MAX_TOKEN_SAFETY_BUFFER = 1000;
/** Base token overhead per message (role tags, delimiters). */
const BASE_TOKENS_PER_MSG = 4;
/** Extra tokens for a tool_calls field on assistant messages. */
const TOOL_CALL_EXTRA_TOKENS = 10;
/** Extra tokens for a tool message (tool_call_id + role overhead). */
const TOOL_OUTPUT_EXTRA_TOKENS = 10;
/** Base tokens for the tools array itself. */
const BASE_TOOL_TOKENS = 12;

/**
 * Estimate token count for a string using the ~4 chars/token heuristic.
 * This is intentionally simple — a real tokenizer (tiktoken) would be more
 * accurate but adds a heavy dependency. The heuristic errs on the side of
 * over-estimating, which is safe for pruning (we prune earlier than needed).
 */
function estStringTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Estimate tokens for a single OpenAI-format message.
 * Aligned with Continue's `countChatMessageTokens`:
 *   4 base + content + tool_calls extra + tool output extra
 */
function estMessageTokens(msg: Record<string, unknown>): number {
	let tokens = BASE_TOKENS_PER_MSG;
	// Content (string or array of parts)
	const content = msg.content;
	if (typeof content === 'string') {
		tokens += estStringTokens(content);
	} else if (Array.isArray(content)) {
		for (const part of content) {
			if (typeof part === 'object' && part !== null) {
				const p = part as Record<string, unknown>;
				if (typeof p.text === 'string') { tokens += estStringTokens(p.text); }
				if (typeof p.image_url === 'object' && p.image_url !== null) { tokens += 85; } // image ~85 tokens
			}
		}
	}
	// Tool calls on assistant messages
	const toolCalls = msg.tool_calls;
	if (Array.isArray(toolCalls)) {
		tokens += toolCalls.length * TOOL_CALL_EXTRA_TOKENS;
		for (const tc of toolCalls) {
			if (typeof tc === 'object' && tc !== null) {
				const fn = (tc as Record<string, unknown>).function as Record<string, unknown> | undefined;
				if (fn) {
					if (typeof fn.name === 'string') { tokens += estStringTokens(fn.name); }
					if (typeof fn.arguments === 'string') { tokens += estStringTokens(fn.arguments); }
				}
			}
		}
	}
	// Tool message extra
	if (msg.role === 'tool') {
		tokens += TOOL_OUTPUT_EXTRA_TOKENS;
	}
	return tokens;
}

/**
 * Estimate tokens for an OpenAI-format tools array.
 * Aligned with Continue's `countToolsTokens`:
 *   12 base + per-tool (name + description + parameters JSON)
 */
function estToolsTokens(tools: Array<Record<string, unknown>> | undefined): number {
	if (!tools || tools.length === 0) { return 0; }
	let tokens = BASE_TOOL_TOKENS;
	for (const tool of tools) {
		const fn = tool.function as Record<string, unknown> | undefined;
		if (!fn) { continue; }
		if (typeof fn.name === 'string') { tokens += estStringTokens(fn.name); }
		if (typeof fn.description === 'string') { tokens += estStringTokens(fn.description); }
		if (fn.parameters) {
			tokens += estStringTokens(JSON.stringify(fn.parameters));
		}
	}
	return tokens;
}

/**
 * Calculate the token counting safety buffer.
 * `Math.min(MAX_TOKEN_SAFETY_BUFFER, contextLength * TOKEN_SAFETY_PROPORTION)`.
 */
function getTokenSafetyBuffer(contextLength: number): number {
	return Math.min(MAX_TOKEN_SAFETY_BUFFER, Math.floor(contextLength * TOKEN_SAFETY_PROPORTION));
}

export interface IPruneOptions {
	/** Model name (for context length lookup if maxInputTokens not given). */
	modelName?: string;
	/** Maximum input tokens the model accepts. */
	maxInputTokens: number;
	/** Maximum output tokens reserved for the response. */
	maxOutputTokens: number;
	/** System text that will be prepended as a system message (not in messages array). */
	systemText?: string;
	/** OpenAI-format tools array (function definitions). */
	tools?: Array<Record<string, unknown>>;
}

export interface IPruneResult {
	/** Pruned messages array (same format as input). */
	messages: Array<Record<string, unknown>>;
	/** Whether any messages were pruned. */
	didPrune: boolean;
	/** Number of messages removed. */
	prunedCount: number;
	/** Estimated total input tokens (system + tools + messages). */
	estimatedInputTokens: number;
	/** Context usage percentage (0-1). */
	contextPercentage: number;
}

/**
 * Prune conversation messages to fit within the model's context window.
 *
 * Aligned with Continue's `compileChatMessages`:
 * 1. System message + tools + last message are **non-negotiable** (never pruned).
 * 2. If non-negotiable items alone exceed context → prunes aggressively but
 *    still sends (best-effort, better than 400).
 * 3. Otherwise, removes oldest messages from the front until under limit.
 * 4. Tool messages without a matching assistant tool_call are also removed
 *    (orphaned tool results cause API errors).
 *
 * @param messages OpenAI-format messages (role/content/tool_calls/tool_call_id)
 * @param options Pruning options
 */
export function pruneMessagesForContext(
	messages: Array<Record<string, unknown>>,
	options: IPruneOptions,
): IPruneResult {
	const { maxInputTokens, maxOutputTokens, systemText, tools } = options;

	// ── Token budgets ──
	const safetyBuffer = getTokenSafetyBuffer(maxInputTokens);
	const minOutput = Math.min(MIN_RESPONSE_TOKENS, maxOutputTokens);
	const systemTokens = systemText ? estStringTokens(systemText) + BASE_TOKENS_PER_MSG : 0;
	const toolTokens = estToolsTokens(tools);

	// Available tokens for conversation history
	let availableForHistory = maxInputTokens;
	availableForHistory -= safetyBuffer;
	availableForHistory -= minOutput;
	availableForHistory -= systemTokens;
	availableForHistory -= toolTokens;

	// ── Extract the last message (non-negotiable — user's current input) ──
	const msgsCopy = [...messages];
	const lastMsg = msgsCopy.pop();
	if (!lastMsg) {
		return {
			messages: [],
			didPrune: false,
			prunedCount: 0,
			estimatedInputTokens: systemTokens + toolTokens,
			contextPercentage: 0,
		};
	}
	const lastMsgTokens = estMessageTokens(lastMsg);
	availableForHistory -= lastMsgTokens;

	// ── Count tokens for each historical message ──
	const historyWithTokens = msgsCopy.map(msg => ({
		msg,
		tokens: estMessageTokens(msg),
	}));
	let currentTotal = historyWithTokens.reduce((sum, h) => sum + h.tokens, 0);

	// ── Prune from front until under limit ──
	let didPrune = false;
	while (historyWithTokens.length > 0 && currentTotal > availableForHistory) {
		const removed = historyWithTokens.shift()!;
		currentTotal -= removed.tokens;
		didPrune = true;

		// If we removed an assistant message that had tool_calls, the following
		// tool result messages become orphaned → remove them too (API rejects
		// tool messages without a preceding assistant tool_calls).
		const removedHadToolCalls = Array.isArray((removed.msg as Record<string, unknown>).tool_calls)
			&& ((removed.msg as Record<string, unknown>).tool_calls as unknown[]).length > 0;
		if (removedHadToolCalls) {
			while (historyWithTokens.length > 0 && historyWithTokens[0].msg.role === 'tool') {
				const orphan = historyWithTokens.shift()!;
				currentTotal -= orphan.tokens;
			}
		}

		// If the next message is a tool result (orphaned), skip it too
		while (historyWithTokens.length > 0 && historyWithTokens[0].msg.role === 'tool') {
			// Check if there's a preceding assistant with matching tool_call_id
			const prevIsAssistant = historyWithTokens.length > 1
				&& historyWithTokens[1].msg.role === 'assistant'
				&& Array.isArray(historyWithTokens[1].msg.tool_calls);
			if (!prevIsAssistant) {
				const orphan = historyWithTokens.shift()!;
				currentTotal -= orphan.tokens;
				didPrune = true;
			} else {
				break;
			}
		}
	}

	// ── Reassemble ──
	const prunedMessages = [
		...historyWithTokens.map(h => h.msg),
		lastMsg,
	];

	const totalInputTokens = currentTotal + lastMsgTokens + systemTokens + toolTokens;
	const availableTotal = maxInputTokens - safetyBuffer - minOutput;
	const contextPercentage = availableTotal > 0 ? totalInputTokens / availableTotal : 1;

	if (didPrune) {
		console.warn(
			`[pruneMessagesForContext] Pruned ${messages.length - prunedMessages.length} message(s) ` +
			`to fit context (model=${options.modelName ?? '?'}, maxInput=${maxInputTokens}, ` +
			`system=${systemTokens}t, tools=${toolTokens}t, history=${currentTotal + lastMsgTokens}t, ` +
			`total=${totalInputTokens}t, ${Math.round(contextPercentage * 100)}% of context)`,
		);
	}

	return {
		messages: prunedMessages,
		didPrune,
		prunedCount: messages.length - prunedMessages.length,
		estimatedInputTokens: totalInputTokens,
		contextPercentage,
	};
}

/**
 * Get extension version from package.json.
 */
export function getExtensionVersion(extensionId: string): string {
	const extension = vscode.extensions.getExtension(extensionId);
	return extension?.packageJSON?.version ?? '1.0.0';
}
