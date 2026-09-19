/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ambient type declarations for `jsdom`.
 *
 * `jsdom` ships without bundled types and the repo does not depend on
 * `@types/jsdom`. It is only used by DOM-level unit tests, which need a small
 * subset of the API (constructing a document and reading `window`), so the
 * surface is declared here instead of pulling in a new devDependency.
 */
declare module 'jsdom' {

	export interface IJSDOMOptions {
		readonly url?: string;
		readonly referrer?: string;
		readonly contentType?: string;
		readonly pretendToBeVisual?: boolean;
		readonly runScripts?: 'dangerously' | 'outside-only';
	}

	export class JSDOM {
		constructor(html?: string, options?: IJSDOMOptions);
		readonly window: Window & typeof globalThis;
		serialize(): string;
	}
}
