/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `ComfyTV.StatEmojiStage`（静态表情包）的交互声明与**节点私有数据**。
 *
 * 为什么单独成文件（2026-09-11 拆分）：它带 38 行节点私有常量
 * （风格选项 + 24 条提示词预设），放在通用框架文件里会让「机制文件」被
 * 节点文案污染；也超过「内联进 nodeCatalog」的规模阈值。
 * 阈值规则见 `../nodeCatalog.ts` 头注释。
 */
import type { INodeInteractionSchema } from '../nodeInteraction/types.js';

/** 静态表情包可选风格（与画布 emoji 工作流的 style_preset 对应）。 */
export const EMOJI_STYLE_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
	{ label: 'Q版', value: 'Q版' },
	{ label: '写实', value: '写实' },
	{ label: '像素', value: '像素' },
	{ label: '手绘', value: '手绘' },
	{ label: '3D 渲染', value: '3D' },
];

/**
 * 默认表情提示词预设（2026-09-11 用户需求）：空格子按序套用，覆盖常见聊天表情。
 * 超过预设数量时循环复用（配合 m×n 最多 64 格）。
 */
export const EMOJI_PROMPT_PRESETS: ReadonlyArray<string> = [
	'点赞，微笑',
	'鼓掌，开心',
	'比心，眨眼',
	'大笑，前仰后合',
	'大哭，流泪',
	'生气，皱眉',
	'惊讶，张大嘴',
	'思考，手托下巴',
	'挥手打招呼',
	'OK 手势，微笑',
	'竖大拇指',
	'抱拳，感谢',
	'无奈摊手',
	'得意，坏笑',
	'害羞，捂脸',
	'困倦，打哈欠',
	'加油，握拳',
	'比耶，开心',
	'委屈，瘪嘴',
	'爱心眼，花痴',
	'睡觉，闭眼',
	'鼓掌欢呼',
	'疑问，歪头',
	'鞠躬，抱歉',
];

/** 静态表情包节点的卡片交互声明（配置型：确认后执行该节点）。 */
export const statEmojiInteraction: INodeInteractionSchema = {
	title: '静态表情包设置',
	description: '选择参考图、行列数与风格，并填写每格提示词；确认后开始生成，随后继续下游节点。',
	submitLabel: '确认并生成',
	fields: [
		// ★ 参考图像（2026-09-11 用户需求）：默认取**上游连线的图像**（执行侧在节点未钉
		//   资产时自动填充），没有上游图时用户可点「选择图像」从上游候选里挑。
		//   写入 `values.comfytv_image_refs` → 执行侧 applyAssetRefOverrides 覆盖上游连线，
		//   作为 img2img 参考图（见 emojiExecutor 的 upstreamImageRef）。
		{ kind: 'image-ref', key: 'comfytv_image_refs', label: '参考图像', slot: 0, description: '可选：作为图生图参考。默认使用上游连线的图像。' },
		{ kind: 'grid-size', key: 'grid', label: '表情格数', rowsKey: 'rows', colsKey: 'cols', min: 1, max: 8, defaultRows: 3, defaultCols: 3 },
		{ kind: 'select', key: 'style_preset', label: '表情包风格', options: EMOJI_STYLE_OPTIONS, default: 'Q版' },
		{
			kind: 'list', key: 'cells', label: '每格提示词', countFrom: 'grid',
			itemFields: [{ kind: 'text', key: 'prompt', label: '提示词', placeholder: '如：点赞，微笑' }],
			preset: EMOJI_PROMPT_PRESETS,
		},
	],
};
