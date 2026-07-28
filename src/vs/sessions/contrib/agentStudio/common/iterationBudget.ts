/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 迭代预算控制器 - 防止 Agent 无限循环
 * 参考 Hermes-Agent 的 IterationBudget 实现
 */
/** 预算快照——用于 turn 中断后的恢复（对齐 Hermes-Agent 的 checkpoint 思路） */
export interface BudgetSnapshot {
	readonly maxIterations: number;
	readonly remaining: number;
	readonly consumed: number;
	readonly graceCall: boolean;
	readonly graceUsed: boolean;
}

export class IterationBudget {
	private _remaining: number;
	private readonly _maxIterations: number;
	private readonly _parentBudget?: IterationBudget;
	private _consumed: number = 0;
	/** grace call 标志：预算耗尽后允许再跑一轮无工具总结（对齐 Hermes `_budget_grace_call`） */
	private _graceCall = false;
	/** grace call 是否已消耗 */
	private _graceUsed = false;

	constructor(maxIterations: number = 90, parentBudget?: IterationBudget, opts?: { graceCall?: boolean }) {
		this._maxIterations = maxIterations;
		this._remaining = maxIterations;
		this._parentBudget = parentBudget;
		this._graceCall = opts?.graceCall ?? false;
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

	/** 是否启用了 grace call（预算耗尽后允许再跑一轮无工具总结，对齐 Hermes `_budget_grace_call`） */
	get graceCall(): boolean { return this._graceCall; }

	/** 是否已消耗过 grace call */
	isGraceUsed(): boolean { return this._graceUsed; }

	/** 启用 grace call（预算即将耗尽时由主循环调用） */
	armGraceCall(): void {
		this._graceCall = true;
	}

	/** 标记 grace call 已消耗（主循环跑完最后一圈后调用，避免重复） */
	consumeGrace(): void {
		this._graceCall = false;
		this._graceUsed = true;
	}

	/** grace call 是否就绪（已 arm 且未用）——主循环据此判断还能再跑一轮 */
	isGraceArmed(): boolean {
		return this._graceCall && !this._graceUsed;
	}

	/** 序列化预算状态（用于 turn 快照/恢复，跨中断持久化） */
	snapshot(): BudgetSnapshot {
		return {
			maxIterations: this._maxIterations,
			remaining: this._remaining,
			consumed: this._consumed,
			graceCall: this._graceCall,
			graceUsed: this._graceUsed,
		};
	}

	/** 从快照恢复预算实例（恢复中断的 turn 时调用） */
	static restore(s: BudgetSnapshot, parentBudget?: IterationBudget): IterationBudget {
		const b = new IterationBudget(s.maxIterations, parentBudget);
		b._remaining = s.remaining;
		b._consumed = s.consumed;
		b._graceCall = s.graceCall;
		b._graceUsed = s.graceUsed;
		return b;
	}

	/** 获取预算状态摘要 */
	getSummary(): string {
		return `Budget: ${this._consumed}/${this._maxIterations} (${this.usagePercentage.toFixed(1)}%)`;
	}
}
