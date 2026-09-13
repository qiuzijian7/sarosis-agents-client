/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 节点私有交互声明（schema 较大、或带节点私有常量/预设时放这里）。
 *
 * 使用方式：在 `../nodeCatalog.ts` 的对应条目上写
 *   `interaction: statEmojiInteraction`
 * 小的 schema（≤ ~25 行且无私有常量）**直接内联在 nodeCatalog 条目里**即可，
 * 不要为它单独建文件。阈值规则见 `../nodeCatalog.ts` 头注释。
 */
export { statEmojiInteraction, EMOJI_STYLE_OPTIONS, EMOJI_PROMPT_PRESETS } from './statEmojiStage.js';
export { dynEmojiInteraction } from './dynEmojiStage.js';
