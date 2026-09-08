/**
 * 节点定义（2026-09-07 框架化收编）：执行器/弹窗通道/引擎豁免声明式注册。
 * spec 注册仍在 registry（历史位置）；新节点请用 defineNode 全量形态（spec+run 同文件）。
 */
import { defineNodeRuntime } from '../nodeDefinition.js';
import { runProviderModel3D } from '../workflowRun.js';

export const model3DGenNode = defineNodeRuntime({
	type: 'Saros.Model3DGen',
	run: runProviderModel3D,
	popupChannel: 'model3DGen',
	providerBackendExempt: true,
});
