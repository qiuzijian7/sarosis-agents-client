/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared HTTP utilities for Sarosis chat model providers.
 */

/**
 * Fetch with timeout and basic retry logic.
 *
 * @param url - Request URL
 * @param options - Fetch options
 * @param timeoutMs - Request timeout in milliseconds (default 30s)
 * @param retries - Number of retries for server errors (5xx), default 1
 */
export async function fetchWithRetry(
	url: string,
	options: RequestInit,
	timeoutMs: number = 30_000,
	retries: number = 1,
): Promise<Response> {
	for (let attempt = 0; attempt <= retries; attempt++) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

		// Merge external signal with our timeout signal
		const externalSignal = options.signal;
		if (externalSignal) {
			externalSignal.addEventListener('abort', () => controller.abort());
		}

		try {
			const response = await fetch(url, {
				...options,
				signal: controller.signal,
			});

			if (response.ok) {
				return response;
			}

			// 401/403 — authentication errors, no point retrying
			if (response.status === 401 || response.status === 403) {
				const errText = await response.text().catch(() => response.statusText);
				console.error(`[HTTP] Authentication failed: status=${response.status}, body=${errText}, url=${url}`);
				throw new HttpError(response.status, errText, url);
			}

			// 4xx — client errors, no point retrying
			if (response.status >= 400 && response.status < 500) {
				const errText = await response.text().catch(() => response.statusText);
				throw new HttpError(response.status, errText, url);
			}

			// 5xx — server error, retry
			if (attempt < retries) {
				console.warn(`[HTTP] ${response.status} on attempt ${attempt + 1}, retrying...`);
				await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
				continue;
			}

			const errText = await response.text().catch(() => response.statusText);
			throw new HttpError(response.status, errText, url);
		} catch (err) {
			if (err instanceof HttpError) { throw err; }
			if (attempt < retries && !(err instanceof DOMException && err.name === 'AbortError')) {
				console.warn(`[HTTP] Network error on attempt ${attempt + 1}, retrying...`, err);
				await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
				continue;
			}
			throw err;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	throw new Error(`HTTP request failed after ${retries + 1} attempts: ${url}`);
}

/**
 * Custom HTTP error with status code and response body.
 */
export class HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string,
		public readonly url: string,
	) {
		super(`HTTP ${status}: ${body}`);
		this.name = 'HttpError';
	}
}
