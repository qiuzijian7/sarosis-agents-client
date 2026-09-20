/*---------------------------------------------------------------------------------------------
 * toolAdapter.ts —— **Tool 适配器**（六件套之一，doc §3.2）。
 *
 * 把我方工具（53 builtin + MCP）映射成 pi 的 `AgentTool`。
 *
 * 关键决策（已核实）：
 *   · pi `Tool.parameters` 是 typebox `TSchema`（**运行时就是 JSON Schema**）⇒ 我方工具的
 *     JSON Schema 直接透传（cast），零转换；
 *   · pi `execute(toolCallId, params, signal?, onUpdate?)` ⇒ 委托给我方执行器（**审批 /
 *     toolExecutionGuard / hardline 护栏全在我方执行器里，原样保留**）；
 *   · pi 语义「**失败用 throw**，而不是把错误编码进 content」⇒ 我方 `isError=true` 的结果
 *     在这里转成 throw（pi 的 executeToolCall 会把异常转成 error tool result 回喂模型 ✓，
 *     正好对齐「错误回喂模型」）；
 *   · `terminate: true` ⇒ 我方 `plan_exit` / `plan_approval` 的提前终止语义；
 *   · `executionMode: 'sequential'` ⇒ 我方「多目标 churn 工具串行」（`_isMultiTargetChurnTool`）。
 *--------------------------------------------------------------------------------------------*/

import type { AgentTool, AgentToolResult } from './piCoreTypes.js';

/** 我方工具的最小结构（P0 骨架用结构化输入，P1 再接我方真实的 IToolDefinition）。 */
export interface ISarosToolSpec {
	readonly name: string;
	readonly description?: string;
	/** UI 展示名（缺省 = name）。 */
	readonly label?: string;
	/** JSON Schema（透传给 pi；运行时就是 JSON Schema）。 */
	readonly parameters?: Record<string, unknown>;
	/** 串行/并行执行覆盖（多目标 churn 工具用 'sequential'）。 */
	readonly executionMode?: 'sequential' | 'parallel';
	/** 崩溃恢复策略（写类工具用 'safe' 表示可重放）。 */
	readonly replay?: 'never' | 'safe';
}

/** 我方工具执行器（由宿主注入 ⇒ 审批/护栏全在其中，原样保留）。 */
export type SarosToolExecute = (
	toolName: string,
	args: Record<string, unknown>,
	onUpdate: (partialText: string) => void,
	signal: AbortSignal | undefined,
) => Promise<{ content: string; isError?: boolean; terminate?: boolean }>;

/** 我方工具 → pi `AgentTool`。 */
export function toPiAgentTool(spec: ISarosToolSpec, exec: SarosToolExecute): AgentTool {
	const result: AgentTool = {
		name: spec.name,
		label: spec.label ?? spec.name,
		description: spec.description ?? '',
		parameters: (spec.parameters ?? { type: 'object', properties: {} }) as never,
		...(spec.executionMode ? { executionMode: spec.executionMode } : {}),
		...(spec.replay ? { replay: spec.replay } : {}),
		execute: async (toolCallId, params, signal, onUpdate) => {
			const r = await exec(
				spec.name,
				(params ?? {}) as Record<string, unknown>,
				(text) => onUpdate?.({ content: [{ type: 'text', text }], details: {} }),
				signal,
			);
			// pi 语义：失败用 throw（异常会被转成 error tool result 回喂模型）
			if (r.isError) { throw new Error(r.content); }
			const out: AgentToolResult<Record<string, unknown>> = {
				content: [{ type: 'text', text: r.content }],
				details: {},
				...(r.terminate === true ? { terminate: true } : {}),
			};
			return out;
		},
	};
	return result;
}
