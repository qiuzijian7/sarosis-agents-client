/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 本地 ambient 声明，补齐 stable `@types/vscode` 未提供的两项 API。
 * 两者在 VS Code 运行期均无条件可用（见 extHost.api.impl.ts），仅类型不在稳定包里。
 *
 * - `LanguageModelThinkingPart`：位于 `languageModelThinkingPart` proposal 之后，
 *   运行期始终暴露；`LanguageModelResponsePart` 联合类型不含它，故上报时需 cast。
 * - `LanguageModelChatMessageRole.System`：位于 `languageModelSystem` proposal，
 *   运行期枚举值为 3。TS 支持 enum 声明合并，故此处追加 System = 3。
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

declare module 'vscode' {

	export enum LanguageModelChatMessageRole {
		/** The system role, e.g. developer-provided instructions. */
		System = 3
	}
}
