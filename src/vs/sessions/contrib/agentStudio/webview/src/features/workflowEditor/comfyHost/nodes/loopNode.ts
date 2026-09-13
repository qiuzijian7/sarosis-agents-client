/**
 * 节点定义（2026-09-07 框架化收编）：执行器/弹窗通道/引擎豁免声明式注册。
 * spec 注册仍在 registry（历史位置）；新节点请用 defineNode 全量形态（spec+run 同文件）。
 *
 * ★ 缺陷修复（2026-09-09 W7）：原来只注册了 `Saros.Loop`，漏了 `Saros.Parallel`
 *   —— 二者共用 `runLoopNodeExecutor`（`isLoopNodeType` 同时认这两个 type），
 *   但节点定义查表是**精确匹配**，漏注册的 `Saros.Parallel` 会掉到
 *   `runSingleNode` 当成 ComfyUI 原生节点执行 → 并发迭代节点必失败。
 */
import { defineNodeRuntime } from '../nodeDefinition.js';
import { runLoopNodeExecutor } from '../graphNodeExecutors.js';

/** `Saros.Loop` — 串行迭代子图容器（items 逐项跑 body）。 */
export const loopNode = defineNodeRuntime({
	type: 'Saros.Loop',
	run: runLoopNodeExecutor,
});

/** `Saros.Parallel` — 并发迭代子图容器（同 body 语义，concurrency 默认更高）。 */
export const parallelNode = defineNodeRuntime({
	type: 'Saros.Parallel',
	run: runLoopNodeExecutor,
});
