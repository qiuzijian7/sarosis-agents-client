/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 迭代预算控制器 - 防止 Agent 无限循环
 * 参考 Hermes-Agent 的 IterationBudget 实现
 */
export class IterationBudget {
	private _remaining: number;
	private readonly _maxIterations: number;
	private readonly _parentBudget?: IterationBudget;
	private _consumed: number = 0;

	constructor(maxIterations: number = 90, parentBudget?: IterationBudget) {
		this._maxIterations = maxIterations;
		this._remaining = maxIterations;
		this._parentBudget = parentBudget;
	}

	/** 消耗指定次数的迭代预算 */
	consume(count: number = 1): void {
		this._remaining = Math.max(0, this._remaining - count);
		this._consumed += count;

		// 如果有父预算，也同步消耗
		if (this._parentBudget) {
			this._parentBudget.consume(count);
		}
	}

	/** 退还迭代预算（用于工具调用失败时） */
	refund(count: number = 1): void {
		this._remaining = Math.min(this._remaining + count, this._maxIterations);
		this._consumed = Math.max(0, this._consumed - count);
	}

	/** 检查是否还有剩余预算 */
	hasRemaining(): boolean {
		return this._remaining > 0;
	}

	/** 获取剩余预算 */
	get remaining(): number {
		return this._remaining;
	}

	/** 获取已消耗的迭代次数 */
	get consumed(): number {
		return this._consumed;
	}

	/** 获取最大迭代次数 */
	get maxIterations(): number {
		return this._maxIterations;
	}

	/** 创建子预算（用于子Agent） */
	createChildBudget(maxIterations?: number): IterationBudget {
		const childMax = maxIterations ?? Math.min(50, Math.floor(this._remaining * 0.6));
		return new IterationBudget(childMax, this);
	}

	/** 获取预算使用百分比 */
	get usagePercentage(): number {
		return ((this._maxIterations - this._remaining) / this._maxIterations) * 100;
	}

	/** 检查预算是否即将耗尽（小于10%） */
	isRunningLow(): boolean {
		return this._remaining / this._maxIterations < 0.1;
	}

	/** 重置预算 */
	reset(): void {
		this._remaining = this._maxIterations;
		this._consumed = 0;
	}

	/** 获取预算状态摘要 */
	getSummary(): string {
		return `Budget: ${this._consumed}/${this._maxIterations} (${this.usagePercentage.toFixed(1)}%)`;
	}
}
