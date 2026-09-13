/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `ComfyTV.DynEmojiStage`（动态表情包）的交互声明。
 *
 * 单独成文件与 `statEmojiStage.ts` 保持同构（同为 emoji 工作流节点，便于对照修改）。
 */
import type { INodeInteractionSchema } from '../nodeInteraction/types.js';

/** 动态表情包节点的卡片交互声明（配置型：确认后执行该节点）。 */
export const dynEmojiInteraction: INodeInteractionSchema = {
	title: '动态表情包设置',
	description: '动态表情按上游格子逐格生成视频；确认参数后继续。',
	submitLabel: '确认并生成',
	fields: [
		{ kind: 'number', key: 'duration_s', label: '时长（秒）', min: 2, max: 5, default: 3 },
		{ kind: 'number', key: 'fps', label: '帧率', min: 6, max: 15, default: 10 },
		{ kind: 'boolean', key: 'chroma_enable', label: '绿幕抠像', default: true },
	],
};
