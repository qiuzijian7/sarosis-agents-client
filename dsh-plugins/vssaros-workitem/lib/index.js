// @vssaros/dsh-workitem — 「活（work item）」内核：loop 与群聊共用的**唯一判据层**。
//
// 形态与 `@vssaros/dsh-foundation` 同款：**纯服务插件**，不注册工具、不碰磁盘、没有 UI。
// 消费方（vssaros-loop / vssaros-agents）用 `ctx.inject(['vssarosWorkItems'], …)` 拿它。
//
// 为什么必须独立成一个插件而不是"复制一份到两边"：
// 插件之间不能互相 import（profile 里没有跨包解析路径），而复制 ⇒ 迟早分叉：
// loop 说"做过了"、群聊说"没做过"，这种不一致没有任何报错，只会表现为重复劳动。
//
// 为什么不放进 foundation：foundation 是"数据根/页面壳/写锁/工作区上下文"这类
// **基础设施**，work item 是**业务语义**。混进去会让底座变成业务服务（用户 2026-10-31 拍板）。

import {
	LEDGER_VERSION, createLedger, entryOf, markBlocked, markDone, markFailed, markRunning,
	normalizeLedger, recoverOnStart, skipReasonOf, summarizeLedger,
} from './core/ledger.js';
import { BUDGET_DEFAULTS, budgetVerdict, pruneEvents } from './core/budget.js';
import { outcomeOf, parseItemMarker, pickItems } from './core/pick.js';
import { isSystemMessage, notifyPayload, renderNotify, SYSTEM_KIND } from './core/systemMessage.js';
import { describeTaskTags, hasTaskTag, normalizeTaskKey, parseTaskTags, TASK_TAG_RE } from './core/taskTag.js';

export const name = 'vssaros-workitem';
// 底座：自己谁都不等（与 foundation 同口径）。
export const inject = [];

/** 免 cordis 的工厂：探针/单测直接 `bindWorkItems(createWorkItemService())`，不必起 Host。 */
export function createWorkItemService() {
	return {
		// ── 账本状态机 ──────────────────────────────────────────────
		LEDGER_VERSION,
		createLedger,
		normalizeLedger,
		entryOf,
		skipReasonOf,
		markRunning,
		markDone,
		markFailed,
		markBlocked,
		recoverOnStart,
		summarizeLedger,
		// ── 挑活与完成契约 ──────────────────────────────────────────
		pickItems,
		parseItemMarker,
		outcomeOf,
		// ── 群聊侧：#task 标签 / 预算 / 回环闸门 ─────────────────────
		TASK_TAG_RE,
		parseTaskTags,
		hasTaskTag,
		normalizeTaskKey,
		describeTaskTags,
		BUDGET_DEFAULTS,
		budgetVerdict,
		pruneEvents,
		SYSTEM_KIND,
		isSystemMessage,
		notifyPayload,
		renderNotify,
	};
}

export function apply(ctx) {
	const service = createWorkItemService();
	// tracker 约定与 bridge/foundation 一致（cordis 注入时挂上真实 ctx）。
	Object.defineProperty(service, Symbol.for('cordis.tracker'), {
		value: { property: 'ctx', noShadow: true },
		enumerable: false,
	});
	ctx.provide('vssarosWorkItems', service);
}
