/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bundled Tools — 把 bundled-tools 定义库里未实现真实 handler 的工具注册为 stub。
 *
 * 从 builtinToolProvider.ts 的 _registerBundledTools 抽出，降低主文件体积。
 * 同时把 KANBAN_TOOLS_WITH_HANDLER / WORKFLOW_TOOLS_WITH_HANDLER 两个过滤集合
 * 一并搬入（本文件专用，主类不再持有）。
 */

import { BUNDLED_TOOL_DEFINITIONS } from '../../../common/bundled-tools/bundledTools.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

/** Kanban 工具中已实现真实 handler 的名字集合（由 _registerKanbanTools 注册） */
const KANBAN_TOOLS_WITH_HANDLER = new Set<string>([
	'kanban_create',
	'kanban_complete',
	'kanban_block',
	'kanban_unblock',
	'kanban_show',
	'kanban_list',
	'kanban_heartbeat',
	'kanban_comment',
	'kanban_link',
	'kanban_specify',
	'kanban_decompose',
	'kanban_swarm',
	'web_scrape_to_board',
	'web_recipe_create',
	'web_recipe_list',
	'web_recipe_remove',
]);

/** Workflow 工具中已实现真实 handler 的名字集合（由 _registerWorkflowTools 注册） */
const WORKFLOW_TOOLS_WITH_HANDLER = new Set<string>([
	'workflow_list',
	'workflow_get',
	'workflow_get_schema',
	'workflow_apply',
]);

export interface BundledToolContext {
	register(registration: IBuiltinToolRegistration): void;
	logService: ILogService;
	/** 判断某工具名是否已被主类注册（原生工具优先，不覆盖） */
	hasTool(name: string): boolean;
}

export function registerBundledTools(ctx: BundledToolContext): void {
	const source = 'saros.builtin-tools';
	ctx.logService.info(`[BuiltinTools] registerBundledTools: loading ${BUNDLED_TOOL_DEFINITIONS.length} bundled tool definitions`);
	for (const def of BUNDLED_TOOL_DEFINITIONS) {
		if (ctx.hasTool(def.name)) {
			// 原生工具优先，不覆盖
			continue;
		}
		// delegate_task 有真实 handler，不在 bundled 中注册 stub
		if (def.name === 'delegate_task') {
			continue;
		}
		// kanban_* 核心工具有真实 handler（见 _registerKanbanTools），不注册 stub
		if (KANBAN_TOOLS_WITH_HANDLER.has(def.name)) {
			continue;
		}
		// workflow_* 工具有真实 handler（见 _registerWorkflowTools），不注册 stub
		if (WORKFLOW_TOOLS_WITH_HANDLER.has(def.name)) {
			continue;
		}
		ctx.register({
			definition: { ...def, source },
			handler: async () => [{
				type: 'text' as const,
				text: `Tool "${def.name}" is defined but not yet implemented natively. ` +
					`Configure an MCP server that provides this tool, or it will be available ` +
					`when a matching provider is registered.`,
			}],
			isStub: true, // 标记为 stub — listTools 会跳过，防止 LLM 尝试调用
		});
	}
}
