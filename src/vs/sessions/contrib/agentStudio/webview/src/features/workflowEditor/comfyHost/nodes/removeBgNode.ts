/**
 * 节点定义（2026-09-07 框架化收编）：去背景（浏览器直连本地 rembg 服务）。
 */
import { defineNodeRuntime } from '../nodeDefinition.js';
import { runRemoveBgNode } from '../removeBgExecutor.js';

export const removeBgNode = defineNodeRuntime({
	type: 'Saros.RemoveBg',
	run: runRemoveBgNode,
});
