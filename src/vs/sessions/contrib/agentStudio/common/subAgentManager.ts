/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IterationBudget } from './iterationBudget.js';
import { IAgentTurnRequest, IChatStreamDelta } from './providers.js';

/**
 * 子Agent管理器
 * 参考 Hermes-Agent 的子Agent委派机制
 * 支持任务分解和并行子Agent执行
 */
export class SubAgentManager {
	private readonly _activeSubAgents = new Map<string, SubAgentInstance>();
	private readonly _parentBudget: IterationBudget;

	constructor(parentBudget?: IterationBudget) {
		this._parentBudget = parentBudget || new IterationBudget(90);
	}

	/**
	 * 创建子Agent
	 * @param parentAgentId 父Agent ID
	 * @param task 任务描述
	 * @param options 可选配置
	 * @returns 子Agent ID
	 */
	createSubAgent(
		parentAgentId: string,
		task: string,
		options?: {
			maxIterations?: number;
			timeout?: number;
			priority?: 'low' | 'medium' | 'high';
		},
	): string {
		const subAgentId = `subagent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		const budget = this._parentBudget.createChildBudget(options?.maxIterations);

		const subAgent: SubAgentInstance = {
			id: subAgentId,
			parentAgentId,
			task,
			status: 'pending',
			budget,
			createdAt: Date.now(),
			timeout: options?.timeout ?? 300000, // 默认5分钟
			priority: options?.priority ?? 'medium',
			result: undefined,
		};

		this._activeSubAgents.set(subAgentId, subAgent);
		console.log(`[SubAgentManager] Created subAgent ${subAgentId} for task: ${task.substring(0, 50)}...`);

		return subAgentId;
	}

	/**
	 * 执行子Agent任务
	 * @param subAgentId 子Agent ID
	 * @param executeFn 执行函数（由ExecutionProvider提供）
	 */
	async executeSubAgent(
		subAgentId: string,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
	): Promise<void> {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) {
			throw new Error(`SubAgent ${subAgentId} not found`);
		}

		subAgent.status = 'running';
		console.log(`[SubAgentManager] Starting subAgent ${subAgentId}`);

		try {
			// 构建请求
			const request: IAgentTurnRequest = {
				agentId: subAgent.id,
				messages: [{ role: 'user', content: subAgent.task }],
			};

			// 执行（带超时）
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('SubAgent timeout')), subAgent.timeout);
			});

			const executionPromise = this._executeWithBudget(executeFn, request, subAgent.budget);

			const result = await Promise.race([executionPromise, timeoutPromise]);

			subAgent.result = {
				success: true,
				output: result,
				completedAt: Date.now(),
			};
			subAgent.status = 'done';

			console.log(`[SubAgentManager] SubAgent ${subAgentId} completed successfully`);

		} catch (error) {
			subAgent.result = {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				completedAt: Date.now(),
			};
			subAgent.status = 'error';

			console.error(`[SubAgentManager] SubAgent ${subAgentId} failed:`, error);
		}
	}

	/**
	 * 并行执行多个子Agent
	 */
	async executeMultipleSubAgents(
		subAgentIds: string[],
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
	): Promise<Map<string, SubAgentResult>> {
		const results = new Map<string, SubAgentResult>();

		// 并行执行所有子Agent
		const promises = subAgentIds.map(async (subAgentId) => {
			await this.executeSubAgent(subAgentId, executeFn);
			const subAgent = this._activeSubAgents.get(subAgentId);
			if (subAgent?.result) {
				results.set(subAgentId, subAgent.result);
			}
		});

		await Promise.all(promises);

		return results;
	}

	/**
	 * 获取子Agent状态
	 */
	getSubAgentStatus(subAgentId: string): SubAgentStatus | undefined {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) {
			return undefined;
		}

		return {
			id: subAgent.id,
			status: subAgent.status,
			task: subAgent.task,
			createdAt: subAgent.createdAt,
			budget: subAgent.budget.getSummary(),
		};
	}

	/**
	 * 获取所有子Agent状态
	 */
	getAllSubAgents(): SubAgentStatus[] {
		return Array.from(this._activeSubAgents.values()).map(sa => ({
			id: sa.id,
			status: sa.status,
			task: sa.task,
			createdAt: sa.createdAt,
			budget: sa.budget.getSummary(),
		}));
	}

	/**
	 * 取消子Agent
	 */
	cancelSubAgent(subAgentId: string): boolean {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) {
			return false;
		}

		subAgent.status = 'cancelled';
		console.log(`[SubAgentManager] Cancelled subAgent ${subAgentId}`);
		return true;
	}

	/**
	 * 清理已完成的子Agent
	 */
	cleanup(): void {
		for (const [id, subAgent] of this._activeSubAgents.entries()) {
			if (subAgent.status === 'done' || subAgent.status === 'error' || subAgent.status === 'cancelled') {
				this._activeSubAgents.delete(id);
				console.log(`[SubAgentManager] Cleaned up subAgent ${id}`);
			}
		}
	}

	/**
	 * 使用预算执行
	 */
	private async _executeWithBudget(
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		request: IAgentTurnRequest,
		budget: IterationBudget,
	): Promise<string> {
		let output = '';

		const stream = executeFn(request, budget);
		for await (const delta of stream) {
			if (delta.type === 'text' && delta.content) {
				output += delta.content;
			}
			if (delta.type === 'done' || delta.type === 'error') {
				break;
			}
		}

		return output;
	}
}

/**
 * 子Agent实例
 */
interface SubAgentInstance {
	id: string;
	parentAgentId: string;
	task: string;
	status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	budget: IterationBudget;
	createdAt: number;
	timeout: number;
	priority: 'low' | 'medium' | 'high';
	result?: SubAgentResult;
}

/**
 * 子Agent结果
 */
export interface SubAgentResult {
	success: boolean;
	output?: string;
	error?: string;
	completedAt: number;
}

/**
 * 子Agent状态（公开）
 */
export interface SubAgentStatus {
	id: string;
	status: string;
	task: string;
	createdAt: number;
	budget: string;
}
