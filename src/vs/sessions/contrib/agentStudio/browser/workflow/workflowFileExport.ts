/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作流文件导出 —— **纯函数层**（实体 → 可再导入的 JSON）。
 *
 * 与 `workflowFileImport.ts` 成对，共同构成「导出 / 导入」闭环：本模块的产物
 * 必须能被 `parseWorkflowImportFile` **无损**读回（round-trip 由
 * `test/browser/workflowFileExport.test.ts` 锁定）。
 *
 * 使用方：
 *  - 侧边栏工作流列表右键「导出 JSON 文件」→ host 侧弹保存对话框直接写盘；
 *  - 编辑器「⤴ 导出 → 工作流 JSON 文件」在 **webview** 内联实现 —— webview
 *    不能 import browser 侧模块（值 import 零先例），故两边各写一份，但
 *    **产出形状必须同构**，契约由上述 round-trip 测试统一守护。
 *
 * ★ 字段采用**白名单**而非整实体展开：`workspaceId` / `updatedAt` /
 * `createdAt` / `source`（builtin 标记）等**不应随文件迁移** —— 导入方是
 * 另一个工作区，且副本不该继承「内置」身份（否则列表会显示错误的内置角标）。
 */

import type { IStoredWorkflow } from '../../common/workflowStorage.js';

/** 导出文件后缀（导入侧只要求 `.json`，加前缀便于用户辨识）。 */
export const WORKFLOW_EXPORT_EXTENSION = '.workflow.json';

/**
 * 从落盘实体挑选导出字段（白名单，空值省略）。
 *
 * ★ 必须覆盖导入侧可识别的**全部**字段 —— 少一个就意味着「导出 → 导入」
 * 静默丢字段（`breakpoints` / `author` / `visibility` 曾正是如此，已补）。
 */
export function buildWorkflowExportPayload(wf: IStoredWorkflow): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: wf.id,
		name: wf.name,
		description: wf.description ?? '',
	};
	if (wf.presetId) { out.presetId = wf.presetId; }
	if (wf.agentId) { out.agentId = wf.agentId; }
	out.steps = wf.steps ?? [];
	if (wf.nodes) { out.nodes = wf.nodes; }
	if (wf.connections) { out.connections = wf.connections; }
	if (wf.breakpoints && wf.breakpoints.length > 0) { out.breakpoints = wf.breakpoints; }
	if (wf.version) { out.version = wf.version; }
	if (wf.category) { out.category = wf.category; }
	if (wf.author) { out.author = wf.author; }
	if (wf.visibility) { out.visibility = wf.visibility; }
	if (wf.tags && wf.tags.length > 0) { out.tags = wf.tags; }
	if (wf.useGuide) { out.useGuide = wf.useGuide; }
	return out;
}

/** 实体 → 导出 JSON 文本（2 空格缩进，便于人工 diff / 版本管理）。 */
export function buildWorkflowExportJson(wf: IStoredWorkflow): string {
	return JSON.stringify(buildWorkflowExportPayload(wf), null, 2);
}

/**
 * 导出文件名：`{清洗后的名称}.workflow.json`。
 *
 * 清洗 Windows 非法字符 `\ / : * ? " < > |`（与编辑器侧内联实现**同规则**）；
 * 中文名保留。清洗后为空 → 回落实体 id → 再兜底 `workflow`。
 *
 * ★ 必须**再去掉首尾连字符**：名称若整体由非法字符组成（如 `///`），只做字符
 * 替换会得到 `---.workflow.json` —— 既难看又毫无辨识度。实测由单测发现。
 */
export function workflowExportFileName(name: string, fallbackId?: string): string {
	const cleaned = (name ?? '')
		.trim()
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/^-+|-+$/g, '')
		.trim();
	const base = cleaned || (fallbackId ?? '').trim() || 'workflow';
	return `${base}${WORKFLOW_EXPORT_EXTENSION}`;
}
