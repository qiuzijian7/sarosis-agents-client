/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 钩子总线接线层 —— 把既有的 `IMemoryProvider.triggerHook` 收编为总线 handler。
 *
 * ## 为什么需要这一层
 *
 * 2026-09-17 拍板「**总线是唯一分发面**」。落地时遇到的真实障碍不是「总线不好用」，
 * 而是生产中已存在第二套未类型化的分发机制：`IMemoryProvider.triggerHook(type:
 * string, ctx: Record<string, unknown>)`（`common/providers.ts:712`），散落 4 个文件
 * 9 个钩子名，且全部 fire-and-forget（`.catch(() => { })`）。
 *
 * 直接把调用点改成 `bus.runWithGate(...)` 会引入一个**性能回归**：`runWithGate` 是
 * `async` 且 await 每个 handler，而 memory provider 往往是跨进程代理
 * （`extensions/agentmemory-memory/src/agentMemoryProviderProxy.ts`）——
 * 每个工具调用都要等一次 IPC 往返。原实现刻意不 await 正是为此。
 *
 * 本层的解法是**把「是否 await」变成 handler 的内部实现细节**：
 * handler 同步返回 `undefined`（总线视为「无意见」），内部 fire-and-forget 转发给
 * provider。于是：
 *
 *   - 分发面唯一 —— 调用点只认识 `TurnHookBus`，不再直接摸 `memoryProvider`；
 *   - 零延迟回归 —— provider 调用仍不阻塞主循环；
 *   - 钩子名类型化 —— 调用点用 `TurnHookName` 联合类型，拼错即编译失败。
 *
 * ## 钩子名映射
 *
 * 两套命名并非一一对应。总线 7 个钩子对齐 pi `HookMap`，provider 9 个钩子是
 * claw 自有的会话级生命周期。只有**工具级**的两对语义重叠，故本层只映射这两对：
 *
 * | 总线钩子 | provider 钩子 | 说明 |
 * |---|---|---|
 * | `before_tool` | `pre_tool_use` | 逐个工具调用触发 |
 * | `after_tool` | `post_tool_use` / `post_tool_failure` | 按 `isError` 二选一 |
 *
 * 其余 provider 钩子（`session_start` / `prompt_submit` / `pre_compact` / `stop` /
 * `session_end` / `task_completed`）是**会话级**而非 turn 级，生命周期比一个 turn
 * 长，不属于 `TurnHookBus` 的职责范围 —— 它们留在 `agentMemoryInjection.ts` 与
 * `agentOSService.ts` 的原位，不强行塞进 turn 总线。
 *
 * ⚠ `before_tool` 是 fail-closed 钩子（`isFailClosedHook`）：handler 抛错会让整个
 * 工具调用被拒。本层的 handler 因此**绝不抛错** —— provider 转发失败只记日志，
 * 不能让「记忆系统不可用」升级成「工具全部无法执行」。
 */

import type { IMemoryProvider } from '../common/providers.js';
import type {
	IAfterToolEvent,
	IBeforeToolEvent,
	TurnHookBus,
} from '../common/turnHookBus.js';

/** 转发 provider 钩子时附带的会话标识。 */
export interface IHookForwardIdentity {
	readonly agentId: string;
	readonly sessionId: string;
}

/** 记录转发失败的日志口（注入以避免本模块依赖 host）。 */
export type HookForwardErrorLogger = (message: string) => void;

/** provider 侧工具结果文本的截断上限，与原内联实现一致。 */
const TOOL_RESULT_TRUNCATE_LIMIT = 2000;

/**
 * 把工具结果内容规范化为 provider 期望的截断字符串。
 *
 * 与原内联实现（`agentTurnExecutor.ts:2160` 附近）逐字对齐：字符串直接截断，
 * 其余走 `JSON.stringify` 后截断，`null` / `undefined` 归一为空串。
 */
export function truncateToolResultForHook(content: unknown): string {
	const text = typeof content === 'string'
		? content
		: JSON.stringify(content ?? '');
	return text.slice(0, TOOL_RESULT_TRUNCATE_LIMIT);
}

/**
 * 把 `IMemoryProvider.triggerHook` 注册为总线的 `before_tool` / `after_tool` handler。
 *
 * @returns 取消注册函数；provider 缺失或不支持 `triggerHook` 时返回空操作函数。
 */
export function registerMemoryProviderHooks(
	bus: TurnHookBus,
	memoryProvider: IMemoryProvider | undefined,
	identity: IHookForwardIdentity,
	logError: HookForwardErrorLogger,
): () => void {
	const triggerHook = memoryProvider?.triggerHook;
	if (!triggerHook || !memoryProvider) {
		return () => { };
	}

	/**
	 * fire-and-forget 转发。
	 *
	 * 刻意不 await：provider 多为跨进程代理，await 会给每个工具调用增加一次 IPC
	 * 往返（这正是原内联实现不 await 的原因）。失败只记日志 —— 见文件头关于
	 * `before_tool` fail-closed 的警告。
	 */
	const forward = (hookType: string, context: Record<string, unknown>): void => {
		try {
			const pending = triggerHook.call(memoryProvider, hookType, {
				agentId: identity.agentId,
				sessionId: identity.sessionId,
				timestamp: Date.now(),
				...context,
			});
			pending?.catch((error: unknown) => {
				logError(`[AgentOS] memory hook "${hookType}" rejected: ${String(error)}`);
			});
		} catch (error) {
			logError(`[AgentOS] memory hook "${hookType}" threw synchronously: ${String(error)}`);
		}
	};

	const disposeBeforeTool = bus.register('before_tool', (event: IBeforeToolEvent) => {
		forward('pre_tool_use', { toolName: event.toolName, toolCallId: event.toolCallId });
		// 返回 undefined = 「无意见」：本 handler 只观测，不拦截也不改写参数。
		return undefined;
	});

	const disposeAfterTool = bus.register('after_tool', (event: IAfterToolEvent) => {
		const resultText = truncateToolResultForHook(event.content);
		forward(event.isError ? 'post_tool_failure' : 'post_tool_use', {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			toolResult: resultText,
			error: event.isError ? resultText : undefined,
		});
		return undefined;
	});

	return () => {
		disposeBeforeTool();
		disposeAfterTool();
	};
}
