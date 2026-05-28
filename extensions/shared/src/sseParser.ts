/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generic SSE stream parser for VS Code Language Model chat providers.
 *
 * Handles the common SSE line-splitting, `data:` prefix extraction, and JSON parsing,
 * delegating protocol-specific event interpretation to a callback.
 */

import * as vscode from 'vscode';

/**
 * Parse an SSE stream from a fetch Response and report text parts to VS Code progress.
 *
 * @param response - The fetch Response with a ReadableStream body
 * @param progress - VS Code progress reporter
 * @param cancellationToken - Cancellation token
 * @param parseEvent - Callback that receives a parsed JSON object and returns text to report, or null to skip.
 *                     Return `{ text: string, done: true }` to stop early (e.g. on `[DONE]`).
 * @param logTag - Tag for console.log messages
 */
export async function parseSSEStream(
	response: Response,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	cancellationToken: vscode.CancellationToken,
	parseEvent: (event: any) => { text: string; done?: boolean } | null,
	logTag: string = 'SSE',
): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error(`${logTag}: response has no body stream`);
	}

	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		if (cancellationToken.isCancellationRequested) { break; }

		const { done, value } = await reader.read();
		if (done) { break; }

		buffer += decoder.decode(value, { stream: true });

		let idx: number;
		while ((idx = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);

			// Skip empty lines and SSE comments
			if (!line || line.startsWith(':')) { continue; }

			// Extract data payload
			let rawData = line;
			if (line.startsWith('data: ')) {
				rawData = line.slice(6);
			} else if (line.startsWith('data:')) {
				rawData = line.slice(5).trim();
			}

			// Skip empty data
			if (!rawData) { continue; }

			// Check for [DONE] signal
			if (rawData === '[DONE]') { return; }

			try {
				const event = JSON.parse(rawData);
				const result = parseEvent(event);
				if (result) {
					progress.report(new vscode.LanguageModelTextPart(result.text));
					if (result.done) { return; }
				}
			} catch {
				// Non-JSON keep-alive or malformed — ignore
			}
		}
	}
}
