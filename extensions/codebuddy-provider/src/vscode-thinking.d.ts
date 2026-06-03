/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Local ambient declaration for `LanguageModelThinkingPart`.
 *
 * Background:
 *   The vendored stable `@types/vscode@1.120.0` used by this extension does NOT ship the
 *   `LanguageModelThinkingPart` type (it lives behind the `languageModelThinkingPart` API
 *   proposal). However the VS Code runtime exposes the class *unconditionally* (see
 *   `src/vs/workbench/api/common/extHost.api.impl.ts` → `LanguageModelThinkingPart:
 *   extHostTypes.LanguageModelThinkingPart`), so it is always available at runtime.
 *
 *   Rather than switching this extension's tsconfig to pull in the full set of proposed
 *   `.d.ts` files (which conflicts with the stable typings for chatProvider et al.), we
 *   merge a minimal declaration of the class into the `vscode` module here.
 *
 * Note:
 *   The stable `LanguageModelResponsePart` union does NOT include this part, and a TS
 *   `type` alias cannot be extended via declaration merging. Therefore callers must cast
 *   the thinking part when reporting it through `Progress<LanguageModelResponsePart>`
 *   (the ExtHost layer accepts and converts it at runtime).
 */
declare module 'vscode' {

	/**
	 * A language model response part containing thinking/reasoning content.
	 * Thinking tokens represent the model's internal reasoning process that
	 * typically streams before the final response.
	 */
	export class LanguageModelThinkingPart {
		/** The thinking/reasoning text content. */
		value: string | string[];

		/** Optional unique identifier for this thinking sequence. */
		id?: string;

		/** Optional metadata associated with this thinking sequence. */
		metadata?: { readonly [key: string]: any };

		/**
		 * Construct a thinking part with the given content.
		 * @param value The thinking text content.
		 * @param id Optional unique identifier for this thinking sequence.
		 * @param metadata Optional metadata associated with this thinking sequence.
		 */
		constructor(value: string | string[], id?: string, metadata?: { readonly [key: string]: any });
	}
}
