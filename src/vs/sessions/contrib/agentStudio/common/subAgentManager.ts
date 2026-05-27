/*---------------------------------------------------------------------------------------------
 *  SubAgentManager — thin facade over UnifiedSubAgentDispatch
 *
 *  Backward-compatible wrapper that delegates to the unified dispatch.
 *  Existing code that imports SubAgentManager continues to work,
 *  but new code should use UnifiedSubAgentDispatch directly.
 *--------------------------------------------------------------------------------------------*/

import { UnifiedSubAgentDispatch, SubAgentType } from './unifiedSubAgentDispatch.js';
import { IterationBudget } from './iterationBudget.js';
import type { IAgentTurnRequest, IChatStreamDelta } from './providers.js';

/**
 * SubAgentManager — backward-compatible facade.
 * @deprecated Use UnifiedSubAgentDispatch directly for new code.
 */
export class SubAgentManager {
	private readonly _dispatch: UnifiedSubAgentDispatch;

	constructor(parentBudget?: IterationBudget) {
		this._dispatch = new UnifiedSubAgentDispatch(parentBudget);
	}

	/** Access the underlying unified dispatch */
	get dispatch(): UnifiedSubAgentDispatch { return this._dispatch; }

	createSubAgent(
		parentAgentId: string,
		task: string,
		options?: {
			maxIterations?: number;
			timeout?: number;
			priority?: 'low' | 'medium' | 'high';
		},
	): string {
		return this._dispatch.createSubAgent(parentAgentId, task, {
			type: SubAgentType.General,
			...options,
		});
	}

	async executeSubAgent(
		subAgentId: string,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
	): Promise<void> {
		await this._dispatch.executeSubAgent(subAgentId, executeFn);
	}

	async executeMultipleSubAgents(
		subAgentIds: string[],
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
	): Promise<Map<string, SubAgentResult>> {
		const resultMap = await this._dispatch.executeMultipleSubAgents(subAgentIds, executeFn);
		// Convert to the old Map format
		const results = new Map<string, SubAgentResult>();
		for (const [id, result] of resultMap) {
			results.set(id, result);
		}
		return results;
	}

	getSubAgentStatus(subAgentId: string): SubAgentStatus | undefined {
		const status = this._dispatch.getSubAgentStatus(subAgentId);
		if (!status) { return undefined; }
		return {
			id: status.id,
			status: status.status,
			task: status.task,
			createdAt: status.createdAt,
			budget: status.budget,
		};
	}

	getAllSubAgents(): SubAgentStatus[] {
		return this._dispatch.getAllSubAgents().map(sa => ({
			id: sa.id,
			status: sa.status,
			task: sa.task,
			createdAt: sa.createdAt,
			budget: sa.budget,
		}));
	}

	cancelSubAgent(subAgentId: string): boolean {
		return this._dispatch.cancelSubAgent(subAgentId);
	}

	cleanup(): void {
		this._dispatch.cleanup();
	}
}

/**
 * SubAgent result (backward compat export)
 */
export interface SubAgentResult {
	success: boolean;
	output?: string;
	error?: string;
	completedAt: number;
}

/**
 * SubAgent status (backward compat export)
 */
export interface SubAgentStatus {
	id: string;
	status: string;
	task: string;
	createdAt: number;
	budget: string;
}
