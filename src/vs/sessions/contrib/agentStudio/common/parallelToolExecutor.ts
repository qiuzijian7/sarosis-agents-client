/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IToolCall, IToolResult } from '../common/providers.js';

/**
 * 并行工具执行管理器
 * 参考 Hermes-Agent 的 _should_parallelize_tool_batch() 实现
 * 智能判断工具调用是否可以并行执行
 */
export class ParallelToolExecutor {
	private readonly _nonParallelTools: Set<string> = new Set([
		'clarify',
		'sudo',
		'secret',
		'confirm',
		'approve',
		'reject',
	]);

	private readonly _maxParallelTools: number = 8;

	/**
	 * 判断工具调用批次是否可以并行执行
	 * @param toolCalls 工具调用列表
	 * @returns 是否可以并行执行
	 */
	shouldParallelize(toolCalls: IToolCall[]): boolean {
		// 1. 单条工具调用直接串行
		if (toolCalls.length <= 1) {
			return false;
		}

		// 2. 包含禁止并行工具直接串行
		const hasNonParallel = toolCalls.some(tc => this._nonParallelTools.has(tc.name));
		if (hasNonParallel) {
			return false;
		}

		// 3. 检查文件路径是否重叠（读写冲突）
		const filePaths = this._extractFilePaths(toolCalls);
		if (this._hasOverlappingPaths(filePaths)) {
			return false;
		}

		// 4. 并行工作线程上限
		if (toolCalls.length > this._maxParallelTools) {
			return false;
		}

		return true;
	}

	/**
	 * 执行工具调用（自动选择并行或串行）
	 */
	async executeTools(
		toolCalls: IToolCall[],
		executeTool: (toolCall: IToolCall) => Promise<IToolResult>,
	): Promise<IToolResult[]> {
		if (this.shouldParallelize(toolCalls)) {
			// 并行执行
			console.log(`[ParallelToolExecutor] Executing ${toolCalls.length} tools in parallel`);
			return await this._executeParallel(toolCalls, executeTool);
		} else {
			// 串行执行
			console.log(`[ParallelToolExecutor] Executing ${toolCalls.length} tools sequentially`);
			return await this._executeSequential(toolCalls, executeTool);
		}
	}

	/**
	 * 并行执行工具调用
	 */
	private async _executeParallel(
		toolCalls: IToolCall[],
		executeTool: (toolCall: IToolCall) => Promise<IToolResult>,
	): Promise<IToolResult[]> {
		const promises = toolCalls.map(async (toolCall, index) => {
			try {
				const result = await executeTool(toolCall);
				return result;
			} catch (error) {
				console.error(`[ParallelToolExecutor] Tool ${toolCall.name} failed:`, error);
				return this._createErrorResult(toolCall.id, error);
			}
		});

		return await Promise.all(promises);
	}

	/**
	 * 串行执行工具调用
	 */
	private async _executeSequential(
		toolCalls: IToolCall[],
		executeTool: (toolCall: IToolCall) => Promise<IToolResult>,
	): Promise<IToolResult[]> {
		const results: IToolResult[] = [];

		for (const toolCall of toolCalls) {
			try {
				const result = await executeTool(toolCall);
				results.push(result);
			} catch (error) {
				console.error(`[ParallelToolExecutor] Tool ${toolCall.name} failed:`, error);
				results.push(this._createErrorResult(toolCall.id, error));
			}
		}

		return results;
	}

	/**
	 * 从工具调用中提取文件路径
	 */
	private _extractFilePaths(toolCalls: IToolCall[]): string[] {
		const filePaths: string[] = [];

		for (const toolCall of toolCalls) {
			const args = toolCall.arguments;

			// 常见文件参数名
			const fileArgNames = ['path', 'file_path', 'filePath', 'filename', 'file', 'output', 'destination'];

			for (const argName of fileArgNames) {
				if (args[argName] && typeof args[argName] === 'string') {
					filePaths.push(args[argName] as string);
				}
			}
		}

		return filePaths;
	}

	/**
	 * 检查文件路径是否重叠（可能存在读写冲突）
	 */
	private _hasOverlappingPaths(paths: string[]): boolean {
		if (paths.length <= 1) {
			return false;
		}

		// 标准化路径（转小写，统一分隔符）
		const normalizedPaths = paths.map(p => p.toLowerCase().replace(/\\/g, '/'));

		// 检查是否有路径是另一个路径的前缀
		for (let i = 0; i < normalizedPaths.length; i++) {
			for (let j = i + 1; j < normalizedPaths.length; j++) {
				const a = normalizedPaths[i];
				const b = normalizedPaths[j];

				if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * 创建错误结果
	 */
	private _createErrorResult(toolCallId: string, error: unknown): IToolResult {
		return {
			toolCallId,
			success: false,
			content: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
