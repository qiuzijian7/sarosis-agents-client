/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TRANSFER_TO_AGENT_TOOL } from '../../../common/agentGraph.js';
import { IToolDefinition, IToolResultContent, ToolSecurityLevel } from '../../../common/providers.js';

/** handoff 工具描述符形状（结构与 BuiltinToolProvider 的 IToolDescriptor 兼容）。 */
export interface IHandoffToolDescriptor {
	readonly definition: IToolDefinition;
	readonly handler: (args: Record<string, unknown>) => Promise<IToolResultContent[]>;
}

export interface HandoffToolContext {
	/** 注册描述符（来自 BuiltinToolProvider.register）。 */
	register: (descriptor: IHandoffToolDescriptor) => void;
	/** provider id，用作 tool `source`。 */
	id: string;
}

/**
 * 注册 supervisor 交接工具 `transfer_to_agent`（Step B，设计 §3.3）。
 *
 * 该工具由 agentOSService 的 loop 在工具分发阶段拦截（不真正执行），
 * 生成 AgentCommand 路由到下一节点。仅多节点图模式（`request.agentGraph`
 * 节点 ≥ 2）才暴露给模型（由 `_getEnabledTools` 过滤），单 agent 模式不可见。
 *
 * handler 是安全兜底：理论上不会被真正执行；若误达此处（拦截缺失 / 单 agent
 * 误调），返回明确错误提示而非崩溃。
 */
export function registerHandoffTools(ctx: HandoffToolContext): void {
	ctx.register({
		definition: {
			name: TRANSFER_TO_AGENT_TOOL,
			description: [
				'Transfer control to another agent node in the current multi-agent graph.',
				'Call this only when the current task phase is finished and another agent should take over.',
				'`node_id` MUST be one of the known graph node ids; `summary` is a short handoff note',
				'for the next agent. Not available in single-agent mode.',
			].join(' '),
			inputSchema: {
				type: 'object',
				properties: {
					node_id: { type: 'string', description: 'Target graph node id to hand off to (must be a known node)' },
					summary: { type: 'string', description: 'Brief summary of work done / context for the next agent' },
				},
				required: ['node_id', 'summary'],
			},
			category: 'handoff',
			source: ctx.id,
			securityLevel: ToolSecurityLevel.Safe,
			toolset: 'utility',
		},
		handler: async (args: Record<string, unknown>) => {
			const nodeId = String(args['node_id'] ?? '');
			return [{
				type: 'text',
				text: JSON.stringify({
					success: false,
					error: `transfer_to_agent("${nodeId}") was not intercepted by the runtime. This tool is only valid inside a multi-agent graph run.`,
				}),
			}];
		},
	});
}
