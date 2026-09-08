/**
 * 视频抠图（ComfyTV.VideoMatteStage）—— 节点定义（2026-09-08）。
 *
 * spec + 执行器一体声明：新增本节点只需本文件 + nodes/index.ts 一行 import。
 *
 * 功能：上游任意视频（视频生成节点产物 / 上传视频）→ 本地抽帧 + chroma-key
 * 抠像（五道后处理 + 压缩迭代）→ 透明 GIF。与「视频转 GIF」的差异：本节点
 * 输出**透明背景** GIF（抠像），VideoToGif 输出保留原背景的普通 GIF。
 * 执行管线复用 videoToGifExecutor 的 convertVideoToTransparentGif。
 */
import { defineNode } from '../nodeDefinition.js';
import { runVideoMatteNode } from '../videoToGifExecutor.js';

export const videoMatteNode = defineNode({
	spec: {
		type: 'ComfyTV.VideoMatteStage',
		kind: 'schema',
		title: '视频抠图',
		category: 'comfyTV',
		inputs: [
			{ name: 'input', type: 'COMFYTV_VIDEO' },
		],
		outputs: [
			{ name: 'output', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			// ★ key 色默认 auto（首帧四边自动采样）——幕布绿漂移时比固定 hex 稳。
			{ name: 'chroma_color', type: 'STRING', default: 'auto' },
			{ name: 'chroma_algo', type: 'COMBO', default: 'rgb', options: [
				{ value: 'rgb', label: 'RGB 色距' },
				{ value: 'flood', label: '泛洪连通' },
				{ value: 'ycbcr', label: 'YCbCr 色度' },
			] },
			// 默认对齐静态表情包验证基准（sim=0.25/smooth=0.08）。
			{ name: 'chroma_similarity', type: 'FLOAT', default: 0.25, min: 0, max: 1, step: 0.05 },
			{ name: 'chroma_smoothness', type: 'FLOAT', default: 0.08, min: 0, max: 1, step: 0.05 },
			{ name: 'fps', type: 'INT', default: 12, min: 6, max: 15 },
			{ name: 'max_kb', type: 'INT', default: 500, min: 100, max: 2000 },
			{ name: 'start_s', type: 'FLOAT', default: 0, min: 0, max: 3600, step: 0.1 },
			// end_s = 0 表示「到视频结尾」（同 VideoToGif 的 0=末尾惯例）
			{ name: 'end_s', type: 'FLOAT', default: 0, min: 0, max: 3600, step: 0.1 },
		],
		color: '#22d3ee',
		comfyTV: { stageKind: 'video', workflowKind: 'video', variant: 'transform' },
	},
	run: runVideoMatteNode,
});
