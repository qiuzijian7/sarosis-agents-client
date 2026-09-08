/**
 * 节点定义（2026-09-07 框架化收编）：视频转 GIF（浏览器本地抽帧 + GIF89a 编码）。
 */
import { defineNodeRuntime } from '../nodeDefinition.js';
import { runVideoToGifNode } from '../videoToGifExecutor.js';

export const videoToGifNode = defineNodeRuntime({
	type: 'ComfyTV.VideoToGifStage',
	run: runVideoToGifNode,
});
