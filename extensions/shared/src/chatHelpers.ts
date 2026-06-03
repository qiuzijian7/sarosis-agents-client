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
