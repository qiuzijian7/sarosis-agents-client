/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天卡「节点描述符」推导：**图标 + 副标题**（2026-09-13 质量评估 P0-1/P0-2）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  为什么单独成模块（从 `workflowExecutionService` 移出）
 * ════════════════════════════════════════════════════════════════════════════
 *  ① **可单测** —— 原先是 service 的模块私有函数，无法加护栏；
 *  ② **护栏需求**（本次实测暴露）：`iconForStageKind` 按 kind **子串**匹配，
 *     新增一类 stage kind 时若忘记补规则，该节点图标会静默退化成引擎兜底 ⚙️。
 *     实测 `COMFYTV_STAGE_META` 的 14 种 kind 里有 4 种（material / model /
 *     storyboard / timeline）未命中 —— 已补；`cardDescriptor.test.ts` 现在会
 *     遍历全部 kind 断言「必须命中」，新增 kind 时测试直接失败 → 强制补规则 ✓。
 *
 *  ⚠ 数据源**只有一份**：`COMFYTV_STAGE_META`（自动生成）—— 画布侧
 *    （`registry.ts` 的 `comfyTVMetaFor`）与聊天卡侧读的是同一份，不新增按 type 索引的表。
 * ════════════════════════════════════════════════════════════════════════════
 */

import { COMFYTV_STAGE_META } from '../../webview/src/features/workflowEditor/comfyHost/comfyTVStageMeta.generated.js';

/**
 * `stage 全名 → { kind, workflowKind }`。
 *
 * 与 `workflowExecutionService` 的 `STAGE_TITLE_BY_TYPE`（title）**同源** ——
 * 同一份生成数据的另一种投影，用于生成与画布 nodeCard 的 `schemaDetail`
 * （`stage: {kind} · wf: {workflowKind}`）**完全一致**的副标题。
 */
export const STAGE_META_BY_TYPE: ReadonlyMap<string, { kind: string; workflowKind?: string }> = new Map(
	COMFYTV_STAGE_META.map(m => [
		m.nodeId,
		{ kind: m.kind, ...(m.workflowKind ? { workflowKind: m.workflowKind } : {}) },
	]),
);

/**
 * stage `kind` → 图标（**子串匹配**）。
 *
 * 为什么用子串而不是枚举全表：`kind` 取值随 ComfyTV 演进，枚举必然漏。
 * 子串匹配把维度从「节点类型数（约 230）」降到「产物语义（约 12）」——
 * 新增 stage 只要复用已有语义词就自动命中。
 *
 * ⚠ **新增 kind 时必须在此补规则**：`cardDescriptor.test.ts` 会遍历
 * `COMFYTV_STAGE_META` 的全部 kind 断言「必须命中」，否则测试失败 ✓。
 */
export function iconForStageKind(kind: string): string | undefined {
	const k = (kind || '').toLowerCase();
	if (k.includes('picker')) { return '🎯'; }
	if (k.includes('emoji')) { return '😀'; }
	if (k.includes('video')) { return '🎬'; }
	if (k.includes('audio') || k.includes('speech') || k.includes('music')) { return '🎵'; }
	if (k.includes('text')) { return '📝'; }
	// ★ 2026-09-13 补齐（实测未命中的 4 种 kind）：
	if (k.includes('material')) { return '🧱'; }
	if (k.includes('model')) { return '🧊'; }
	if (k.includes('storyboard')) { return '🎞️'; }
	if (k.includes('timeline')) { return '⏱️'; }
	if (k.includes('image')) { return '🖼️'; }
	if (k.includes('panorama')) { return '🌐'; }
	if (k.includes('project')) { return '📁'; }
	return undefined;
}

/** 引擎类型 → 图标（无 stage 元数据时兜底；语义维度 = 引擎枚举，固定约 12 项）。 */
export const CARD_ICON_BY_ENGINE: Readonly<Record<string, string>> = Object.freeze({
	agent: '🤖', prompt: '📝', skill: '⚡', tool: '🔧', task: '📋',
	script: '📜', comfyStage: '⚙️', comfy: '⚙️',
	ifElse: '🔀', switch: '🔀', end: '🏁', start: '▶️', askUser: '❓',
});

/**
 * 引擎类型 → 副标题（无 stage 元数据时的兜底）。
 *
 * ★ 关键：**绝不回退成机器名**。此前 `task: node.type` 让用户在工作流卡上看到
 * `comfyStage` / `script` / `end` 这类内部枚举值，而画布上同一节点显示的是
 * 「裁剪」/「Emoji Stage」。这里给的是人类可读的中文标签。
 */
export const CARD_SUBTITLE_BY_ENGINE: Readonly<Record<string, string>> = Object.freeze({
	agent: 'Agent 节点', prompt: '提示词', skill: '技能', tool: '工具', task: '任务',
	script: '脚本节点', ifElse: '条件分支', switch: '分支选择',
	end: '流程结束', start: '流程开始', askUser: '询问用户',
	comfyStage: 'ComfyTV 阶段', comfy: 'ComfyUI 节点',
});

/** 无任何元数据时的图标兜底（宁可有图标，不要空）。 */
export const CARD_ICON_FALLBACK = '⚙️';

/**
 * 推导一个节点在聊天卡里的图标与副标题。
 *
 * @param rawType   节点**原始全名**（画布持久化的 `data.stageClass`，如 `ComfyTV.CropStage`）——
 *                  用于命中 stage 元数据表（必须用全名，归一化后的 `comfyStage` 查不到）。
 * @param engineType 归一化后的引擎类型（`node.type`，如 `comfyStage` / `script`）——
 *                  用于无 stage 元数据时的兜底。
 */
export function describeCardNode(rawType: string, engineType: string): { icon: string; subtitle: string } {
	const meta = STAGE_META_BY_TYPE.get(rawType);
	const icon = (meta ? iconForStageKind(meta.kind) : undefined)
		?? CARD_ICON_BY_ENGINE[engineType]
		?? CARD_ICON_FALLBACK;
	const subtitle = meta
		? `stage: ${meta.kind}${meta.workflowKind ? ` · wf: ${meta.workflowKind}` : ''}`
		: (CARD_SUBTITLE_BY_ENGINE[engineType] ?? rawType);
	return { icon, subtitle };
}
