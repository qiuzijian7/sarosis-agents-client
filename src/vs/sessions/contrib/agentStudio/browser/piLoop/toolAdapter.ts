/*---------------------------------------------------------------------------------------------
 *  piLoop/toolAdapter.ts — 本仓 IToolDefinition ⟷ pi AgentTool 的适配
 *
 *  两边的工具契约形状不同：
 *
 *    pi 侧    AgentTool { name, description, inputSchema: TSchema, executionMode?, execute() }
 *             —— 工具**自带执行体**，pi loop 直接 await tool.execute()
 *
 *    本仓侧   IToolDefinition { name, description, inputSchema: Record<string,unknown>, … }
 *             —— 只有**声明**，没有执行体；执行统一经 provider 桥接
 *                （见 agentTurnExecutor 的 _executeToolCalls → provider.executeTool）
 *
 *  设计要点：
 *  1. pi loop 要求工具自执行，本仓工具不自执行 —— 故适配层接受一个**执行委托**
 *     （`ToolExecutor`），把「工具名 + 参数」交回宿主，由宿主决定走哪条执行路径
 *     （本地 registry / provider 桥接 / MCP）。
 *  2. `inputSchema` 在本仓是裸 JSON Schema，pi 期望 typebox `TSchema`。此处**不做**
 *     typebox 转换 —— pi loop 实际只用 schema 做参数校验与声明，且本仓已有自己的
 *     校验链。直接把 JSON Schema 原样透传，避免引入 typebox 运行时依赖。
 *  3. 本仓特有的 `category` / `toolset` / `securityLevel` 等元信息不进入 pi 契约，
 *     需要时由宿主在外层过滤（`toAgentTools` 支持传入已过滤的列表）。
 *--------------------------------------------------------------------------------------------*/

import type { IToolCall, IToolDefinition } from '../../common/providers.js';
import type { AgentTool, AgentToolResult, ToolExecutionMode } from './types.js';

/**
 * 工具执行委托 —— 由宿主提供，决定工具实际怎么跑。
 *
 * 本仓的工具定义是「声明式」的，执行归属宿主（本地工具注册表 / provider 桥接 / MCP）。
 * 适配层不关心具体路径，只负责把调用转交出去。
 */
export type ToolExecutor = (
	toolCall: IToolCall,
	signal: AbortSignal | undefined,
	onProgress: ((message: string) => void) | undefined,
) => Promise<ToolExecutionOutcome>;

/** 工具执行结果（宿主侧返回）。 */
export interface ToolExecutionOutcome {
	/** 供 LLM 消费的文本内容。 */
	readonly content: string;
	/** 是否为错误结果。 */
	readonly isError?: boolean;
	/** 结构化详情（供 UI 渲染，不发给 LLM）。 */
	readonly details?: unknown;
	/** 是否终止同批剩余工具。 */
	readonly terminate?: boolean;
}

/** 把本仓工具定义转为 pi `AgentTool` 时的可选配置。 */
export interface ToAgentToolOptions {
	/** 单工具强制串行执行（覆盖全局 toolExecution 策略）。 */
	readonly executionMode?: ToolExecutionMode;
}

/**
 * 将单个本仓工具定义转为 pi 的 `AgentTool`。
 *
 * @param definition 本仓工具定义（仅声明）
 * @param executor   宿主提供的执行委托
 * @param options    可选的执行模式覆盖
 */
export function toAgentTool(
	definition: IToolDefinition,
	executor: ToolExecutor,
	options: ToAgentToolOptions = {},
): AgentTool<Record<string, unknown>, unknown> {
	return {
		name: definition.name,
		description: definition.description,
		// 裸 JSON Schema 原样透传：pi 侧只用它做声明与校验，本仓已有独立校验链。
		inputSchema: definition.inputSchema,
		executionMode: options.executionMode,
		async execute(
			toolCallId: string,
			args: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate,
		): Promise<AgentToolResult<unknown>> {
			const toolCall: IToolCall = {
				id: toolCallId,
				name: definition.name,
				arguments: args,
			};

			const onProgress = onUpdate
				? (message: string): void => {
					void onUpdate({ content: [{ type: 'text', text: message }] });
				}
				: undefined;

			const outcome = await executor(toolCall, signal, onProgress);

			return {
				content: [{ type: 'text', text: outcome.content }],
				details: outcome.details,
				terminate: outcome.terminate,
				// 错误标记经 details 传给 loop：pi 的 AgentToolResult 无 isError 字段，
				// 由 finalizeExecutedToolCall 的 detectToolResultError 读取。
				...(outcome.isError ? { details: { ...toDetailsObject(outcome.details), isError: true } } : {}),
			};
		},
	};
}

/** 把任意 details 收敛为对象形态，便于附加 isError 标记。 */
function toDetailsObject(details: unknown): Record<string, unknown> {
	if (details && typeof details === 'object' && !Array.isArray(details)) {
		return details as Record<string, unknown>;
	}
	return {};
}

/**
 * 批量把本仓工具定义转为 pi `AgentTool`。
 *
 * @param definitions 已按工具集/权限过滤后的定义列表（过滤属宿主职责）
 * @param executor    宿主提供的执行委托
 * @param executionModeFor 按工具名决定执行模式；缺省全部走 pi 的并行策略
 */
export function toAgentTools(
	definitions: readonly IToolDefinition[],
	executor: ToolExecutor,
	executionModeFor?: (toolName: string) => ToolExecutionMode | undefined,
): AgentTool<Record<string, unknown>, unknown>[] {
	return definitions.map((definition) => {
		const mode = executionModeFor?.(definition.name);
		return mode ? toAgentTool(definition, executor, { executionMode: mode }) : toAgentTool(definition, executor);
	});
}

/**
 * 从 pi `AgentTool` 反查本仓工具定义名。
 *
 * 用于把 pi 的事件（`tool_execution_start` 等）映射回本仓的 UI 渲染路径。
 */
export function extractToolName(tool: AgentTool<unknown, unknown>): string {
	return tool.name;
}
