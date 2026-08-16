/*---------------------------------------------------------------------------------------------
 *  runnerContext — 全局 runner registry / preference 单例。
 *
 *  NodeCard 是 presentational 组件，通过 `createNodeCard(container, meta, opts)` 一次性
 *  挂载（在 LiteGraphCanvas 的 syncOverlay rAF 循环里），没有 React props 传 runners。
 *  但内嵌编辑器（MaskPainter 的「应用 mask」要 resolve runner 上传）需要访问
 *  ComfyRunnerRegistry + preference。用模块级单例桥接：
 *    - WorkflowEditorPanel 初始化 / preference 变化时 setActiveRunnerRegistry /
 *      setActiveRunnerPreference
 *    - NodeCard 内嵌编辑器读 getActiveRunnerRegistry() / getActiveRunnerPreference()
 *
 *  比给 LiteGraphCanvas → createNodeCard → NodeCard 三层传 prop 更简洁，且 preference
 *  可动态读（用户切换 runner 后，已挂载的卡片无需重挂载即生效）。
 *--------------------------------------------------------------------------------------------*/

import type { ComfyRunnerRegistry } from './comfyRunner.js';

let activeRegistry: ComfyRunnerRegistry | null = null;
let activePreference = 'auto';

export function setActiveRunnerRegistry(registry: ComfyRunnerRegistry | null): void {
	activeRegistry = registry;
}

export function getActiveRunnerRegistry(): ComfyRunnerRegistry | null {
	return activeRegistry;
}

export function setActiveRunnerPreference(preference: string): void {
	activePreference = preference;
}

export function getActiveRunnerPreference(): string {
	return activePreference;
}
