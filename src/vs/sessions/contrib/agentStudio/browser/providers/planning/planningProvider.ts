/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPlanningProvider, IPlan, IPlanStep, ITask, IMemoryContext } from '../../../common/providers.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';

/**
 * Planning Provider 实现
 *
 * 分析用户意图并分解任务。
 * 支持基于关键词的简单意图分析和基于步骤的任务分解。
 */
export class PlanningProvider implements IPlanningProvider {

	readonly id: string = 'default-planning-provider';
	readonly name: string = 'Default Planning Provider';

	private readonly _logService: ILogService;

	/** 复杂度关键词映射 */
	private static readonly COMPLEXITY_KEYWORDS: { pattern: RegExp; complexity: 'low' | 'medium' | 'high' }[] = [
		{ pattern: /\b(refactor|restructure|migrate|redesign|overhaul)\b/i, complexity: 'high' },
		{ pattern: /\b(implement|create|build|develop|integrate)\b/i, complexity: 'medium' },
		{ pattern: /\b(fix|update|add|change|modify|remove)\b/i, complexity: 'low' },
	];

	constructor(
		@ILogService logService: ILogService,
	) {
		this._logService = logService;
	}

	async analyzeIntent(message: string, _context?: IMemoryContext): Promise<IPlan> {
		this._logService.debug('[PlanningProvider] analyzeIntent called');

		const intent = this._extractIntent(message);
		const complexity = this._estimateComplexity(message);
		const steps = this._generateSteps(message, complexity);

		return {
			id: `plan-${Date.now()}`,
			intent,
			steps,
			estimatedComplexity: complexity,
		};
	}

	async decomposeTasks(plan: IPlan): Promise<ITask[]> {
		this._logService.debug('[PlanningProvider] decomposeTasks called');

		if (plan.steps.length === 0) {
			return [{
				id: `${plan.id}-task-0`,
				description: plan.intent,
				status: 'pending',
			}];
		}

		return plan.steps.map((step, index) => ({
			id: `${plan.id}-task-${index}`,
			description: step.description,
			dependencies: index > 0 ? [`${plan.id}-task-${index - 1}`] : undefined,
			status: 'pending' as const,
		}));
	}

	// ─── 私有方法 ─────────────────────────────────────

	private _extractIntent(message: string): string {
		// 简单意图提取：取第一句话
		const firstSentence = message.split(/[.!?。！？]/)[0].trim();
		return firstSentence.length > 100
			? firstSentence.substring(0, 100) + '...'
			: firstSentence;
	}

	private _estimateComplexity(message: string): 'low' | 'medium' | 'high' {
		for (const { pattern, complexity } of PlanningProvider.COMPLEXITY_KEYWORDS) {
			if (pattern.test(message)) {
				return complexity;
			}
		}

		// 根据消息长度估算
		if (message.length > 200) return 'medium';
		return 'low';
	}

	private _generateSteps(message: string, complexity: 'low' | 'medium' | 'high'): IPlanStep[] {
		if (complexity === 'low') {
			return [{
				id: `step-0`,
				description: `Execute: ${this._extractIntent(message)}`,
			}];
		}

		if (complexity === 'medium') {
			return [
				{ id: 'step-0', description: 'Analyze requirements' },
				{ id: 'step-1', description: 'Implement the solution' },
				{ id: 'step-2', description: 'Verify the result' },
			];
		}

		// High complexity
		return [
			{ id: 'step-0', description: 'Analyze requirements and constraints' },
			{ id: 'step-1', description: 'Design the solution approach' },
			{ id: 'step-2', description: 'Implement core functionality' },
			{ id: 'step-3', description: 'Handle edge cases and error scenarios' },
			{ id: 'step-4', description: 'Test and verify the implementation' },
		];
	}
}
