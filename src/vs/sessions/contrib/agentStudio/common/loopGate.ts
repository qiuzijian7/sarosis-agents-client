/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 回合循环的门控纯函数。
 *
 * 从 `browser/agentTurnExecutor.ts` 下沉至此：这两个函数原本与主循环同文件，
 * 使得 `browser/turnIterationGate.ts`（抽取出的门控段）引用它们会形成循环依赖。
 * 下沉后两侧都从 common 层 import，依赖方向单向。
 *
 * 两者都是纯函数（无副作用、不读模块状态），可独立单测。
 *
 * @module agentStudio/loopGate
 */

import type { DeliveryQueue } from './deliveryQueue.js';

/** 注入结果：新消息数组 + 本轮注入条数。调用方必须用返回的数组覆盖原引用。 */
export interface SteeringInjectionResult<TMessage> {
	readonly messages: TMessage[];
	readonly injectedCount: number;
}

/**
 * 运行中消息注入 —— 从 steering 队列领取并在本轮 LLM 调用前追加。
 *
 * 抽出动机：原实现内联在 4112 行主循环里，只能靠「扫源码断言 lease 调用存在」
 * 间接守护，无法验证行为。此函数纯化后可直接单测。
 *
 * 租约语义（见 common/deliveryQueue.ts）：lease 领取 → 追加成功才 ack；
 * 追加抛错则 release 归还重试。未 release 的租约由 reclaimStale 超时回收。
 *
 * @returns 新的 messages 数组（**不修改入参**）与注入条数。
 */
export function injectSteeringMessages<TMessage>(
	steeringQueue: DeliveryQueue | undefined,
	agentId: string,
	iteration: number,
	leaseId: string,
	messages: ReadonlyArray<TMessage>,
	appendOne: (current: ReadonlyArray<TMessage>, content: string) => TMessage[],
	log: { info(msg: string): void; warn(msg: string): void },
): SteeringInjectionResult<TMessage> {
	if (!steeringQueue) {
		return { messages: messages as TMessage[], injectedCount: 0 };
	}

	const leasedItems = steeringQueue.lease(agentId, leaseId);
	if (leasedItems.length === 0) {
		return { messages: messages as TMessage[], injectedCount: 0 };
	}

	const acknowledgedIds: string[] = [];
	let nextMessages = messages as TMessage[];
	try {
		for (const item of leasedItems) {
			nextMessages = appendOne(nextMessages, item.content);
			acknowledgedIds.push(item.id);
		}
		steeringQueue.ack(acknowledgedIds);
		log.info(
			`[AgentOS] Steering: injected ${leasedItems.length} message(s) at iteration ${iteration} ` +
			`(ids=${acknowledgedIds.join(',')})`,
		);
		return { messages: nextMessages, injectedCount: leasedItems.length };
	} catch (steeringErr) {
		steeringQueue.release(leaseId);
		log.warn(
			'[AgentOS] Steering injection failed, lease released for retry: ' +
			(steeringErr instanceof Error ? steeringErr.message : String(steeringErr)),
		);
		// 失败时丢弃本轮的部分追加：释放租约后消息会回到 pending，
		// 若同时保留已追加的部分会造成下一轮重复注入。
		return { messages: messages as TMessage[], injectedCount: 0 };
	}
}

/** 预算门控裁决。 */
export type BudgetGateDecision = 'continue' | 'wrap-up' | 'stop';

/**
 * 预算门控 —— 预算耗尽时先转入收尾轮，收尾轮已跑过则硬停。
 *
 * 两段式语义的故障背景（原见 agentTurnExecutor.ts :2198-2204 注释）：此前撞上限
 * 直接结束，导致末轮发起的 delegate_task 成果 100% 丢弃（日志 1787214724132）。
 *
 * @returns 裁决结果；调用方据 'wrap-up' 置 forced 标志、据 'stop' 跳出循环。
 */
export function classifyBudgetGate(
	hasRemaining: boolean,
	isGraceArmed: boolean,
	wrapUpDone: boolean,
): BudgetGateDecision {
	if (hasRemaining || isGraceArmed) {
		return 'continue';
	}
	return wrapUpDone ? 'stop' : 'wrap-up';
}
