/**
 * 动态表情包制作（Saros.AnimatedEmoji）—— 节点定义（2026-09-07 框架化范例）。
 *
 * spec + 执行器 + popup 通道 + 引擎豁免 **一体声明**：新增本节点只需本文件 +
 * nodes/index.ts 一行 import，不再触碰 runNodeOrStage 分发链 / NodeEditorPopup /
 * nodeCard 等接缝。
 *
 * 功能：透明贴纸单格 → provider 图生视频（逐格独立）→ chroma-key 抠像 →
 * 透明 GIF（微信表情规范 240×240/≤500KB/≤3s）。
 * ★ 三阶段可独立执行（2026-09-12 用户需求）：① 生成视频（run_scope='video'）→
 *   ② 视频抠像（'matte'）→ ③ GIF 输出（'gif'）；'all'/'cell' 一键跑全流程。
 *   详见 animatedEmojiExecutor.ts 文件头。
 */
import { defineNode } from '../nodeDefinition.js';
import { runAnimatedEmoji } from '../animatedEmojiExecutor.js';
import { workflowOptionsFor } from '../registry.js';

export const animatedEmojiNode = defineNode({
	spec: {
		type: 'Saros.AnimatedEmoji',
		kind: 'schema',
		title: '动态表情包制作',
		category: 'saros',
		inputs: [
			{ name: 'images', type: 'COMFYTV_IMAGE' },
			{ name: 'texts', type: 'COMFYTV_TEXT' },
		],
		outputs: [
			{ name: 'images', type: 'COMFYTV_IMAGES' },
			{ name: 'animations', type: 'COMFYTV_VIDEO' },
		],
		widgets: [
			{ name: 'backend', type: 'COMBO', default: 'provider', options: ['comfyui', 'provider'] },
			{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('video')[0] ?? '', options: workflowOptionsFor('video') },
			// ★ seed（comfyui 渠道；2026-09-11 补声明）：此前**未在 spec 声明** →
			//   `toControls` 收不到 → 编辑器 ctl('seed') 恒回退默认 → 用户设的
			//   seed 重开面板即丢（编辑器 onCommit 还会把默认值写回 properties）。
			{ name: 'seed', type: 'INT', default: 0, min: 0, max: 2147483647 },
			{ name: 'videoProvider', type: 'COMBO', default: '', options: [] },
			{ name: 'videoModel', type: 'COMBO', default: '', options: [] },
			{ name: 'prompt', type: 'TEXT', default: '' },
			// ★ 每格动作描述（逐格模式）：JSON 数组按格序存独立动作，空串 = 未填。
			{ name: 'cell_actions', type: 'TEXT', default: '[]' },
			// ★ 三阶段执行协议（2026-09-12，见 animatedEmojiExecutor 文件头）：
			//   run_scope: 'all' | 'cell' | 'video'（仅①生成视频）| 'matte'（仅②抠像）
			//            | 'gif'（仅③转 GIF）| 'rematte'（②+③）
			//   cell_indices: 选格（JSON 数组，0-based）；selected_index: 旧单格协议（1-based）
			{ name: 'run_scope', type: 'TEXT', default: 'all' },
			{ name: 'cell_indices', type: 'TEXT', default: '' },
			{ name: 'selected_index', type: 'INT', default: 0, min: 0, max: 35 },
			{ name: 'duration_s', type: 'COMBO', default: '3', options: [
				{ value: '2', label: '2 秒' },
				{ value: '3', label: '3 秒' },
				{ value: '4', label: '4 秒' },
				{ value: '5', label: '5 秒' },
			]},
			{ name: 'fps', type: 'INT', default: 12, min: 6, max: 15 },
			// ★ 首尾回环混合（2026-09-08）：尾部 4 帧与首帧线性插值，GIF 循环播放
			//   无缝（视频模型无循环约束，尾帧跳回首帧会突兀）。大动作表情可关。
			{ name: 'loop_blend', type: 'BOOLEAN', default: true },
			// ★ 微信表情规范（2026-09-08）：单张动态 GIF ≤500KB——默认 500 让压缩
			//   迭代落在 L1（128 色 @ 8fps、18 帧），颜色零偏差；旧默认 100 连
			//   24 色 4fps 保底档都超限（172KB overLimit）。
			{ name: 'max_kb', type: 'INT', default: 500, min: 100, max: 2000 },
			{ name: 'chroma_enable', type: 'BOOLEAN', default: true },
			// ★ 抠像开关（2026-09-08，与绿幕合成解耦）——2026-09-11 补声明（同 seed）。
			{ name: 'matte_enable', type: 'BOOLEAN', default: true },
			// ★ GIF 输出开关（2026-09-08）——2026-09-11 补声明（同 seed）。
			{ name: 'gif_enable', type: 'BOOLEAN', default: true },
			{ name: 'chroma_color', type: 'STRING', default: '#00FF00' },
			// ★ 抠像算法（2026-09-08）——2026-09-11 补声明（同 seed）。
			{ name: 'chroma_algo', type: 'COMBO', default: 'rgb', options: ['rgb', 'flood', 'ycbcr'] },
			{ name: 'chroma_similarity', type: 'FLOAT', default: 0.4, min: 0, max: 1, step: 0.05 },
			{ name: 'chroma_smoothness', type: 'FLOAT', default: 0.1, min: 0, max: 1, step: 0.05 },
		],
		backendKind: 'provider',
		providerCaps: 'videoGen',
		color: '#8a3fd0',
		comfyTV: { stageKind: 'video', workflowKind: 'video' },
	},
	run: runAnimatedEmoji,
	providerBackendExempt: true,
	popupChannel: 'videoGen',
});
