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
 * Extract the model name from a full model ID by stripping the vendor prefix.
 * e.g. "codebuddy-claude-4.5" → "claude-4.5"
 *      "codebuddy/claude-4.5" → "claude-4.5"
 */
export function extractModelName(modelId: string, vendorPrefix: string): string {
	let cleaned = modelId;
	// Handle "vendor/" prefix
	if (cleaned.startsWith(`${vendorPrefix}/`)) {
		cleaned = cleaned.slice(`${vendorPrefix}/`.length);
	}
	// Handle "vendor-" prefix
	if (cleaned.startsWith(`${vendorPrefix}-`)) {
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
	const systemMessage = messages.find(m => m.role === SystemRole);
	const conversationMessages = messages.filter(m => m.role !== SystemRole);

	return {
		systemText: systemMessage ? extractText(systemMessage) : undefined,
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

/**
 * Get extension version from package.json.
 */
export function getExtensionVersion(extensionId: string): string {
	const extension = vscode.extensions.getExtension(extensionId);
	return extension?.packageJSON?.version ?? '1.0.0';
}
