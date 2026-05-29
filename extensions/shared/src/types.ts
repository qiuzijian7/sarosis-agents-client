/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared type definitions for Sarosis chat model providers.
 */

import * as vscode from 'vscode';

/** Common credential data stored in globalState */
export interface ICredentialData {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number; // ms epoch
}

/** Model token limits */
export interface IModelTokenLimits {
	maxInputTokens: number;
	maxOutputTokens: number;
	/** Maximum allowed context size (input + output) */
	maxAllowedSize?: number;
}

/** SSE event parsed from stream — protocol-agnostic intermediate representation */
export interface ISSETextEvent {
	/** Extracted text content to report to VS Code */
	text: string;
	/** Whether this is a terminal event (e.g. [DONE]) */
	done?: boolean;
}

/** Protocol adapter interface for translating between API protocols and VS Code chat */
export interface IProtocolAdapter {
	/** Build the HTTP request (URL, method, headers, body) for the given messages */
	buildRequest(
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		model: string,
		accessToken: string,
		options: {
			gateway: string;
			extensionVersion: string;
		},
	): { url: string; init: RequestInit };

	/** Parse a single SSE data event into text or null */
	parseSSEEvent(data: any): ISSETextEvent | null;

	/** Extract the model name from the full model ID (e.g. "codebuddy-claude-4.5" → "claude-4.5") */
	extractModelName(modelId: string, vendorPrefix: string): string;
}

/** Auth status type */
export type AuthStatus = 'logged-in' | 'logged-out';

/** Token source for debugging */
export type TokenSource = 'local_storage' | 'cli_external_link' | 'env_var' | 'api_key_helper' | 'credentials_file' | 'oauth';
