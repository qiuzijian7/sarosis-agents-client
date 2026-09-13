/**
 * providerPickerNode — `Saros.ProviderPicker` 的声明式收编（2026-09-11，P0-2 第 1 项）。
 *
 * 迁移自 `runNodeOrStage` 的硬编码分支：
 *   `if (isProviderPickerNode(type)) { return runProviderPickerNode(input); }`
 * 收编后分发首位 `getNodeDefinition('Saros.ProviderPicker')` 命中即执行，
 * 该硬编码分支已删除 —— 新增/调整 picker 行为只需改本文件，不再触碰分发链。
 *
 * - spec 仍在 registrySaros.ts（`registerNodeSpec`，kind='react'），故用轻量形态
 *   `defineNodeRuntime`（与 localStageNodes.ts / fxAndLoadImageNodes.ts 同款）。
 * - 执行器来自 providerExecutors.ts，该模块**不回指 workflowRun.ts**（依赖方向单向），
 *   因此不会引入新的循环依赖。
 * - 节点语义：本地解析（无 RPC），输出 TEXT 配置 `provider:<providerId>:<modelId>`
 *   供 ModelImageGen 消费；缺省时经 `input.resolveImageGenDefaults()` 兜底。
 */
import { defineNodeRuntime } from '../nodeDefinition.js';
import { runProviderPickerNode } from '../providerExecutors.js';

export const providerPickerNode = defineNodeRuntime({
	type: 'Saros.ProviderPicker',
	run: runProviderPickerNode,
});
