/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turn 钩子总线（Hook Bus）。
 *
 * ## 为什么需要本模块
 *
 * claw 侧的变化点此前是「策略接口 + 内联注释标记」的混合形态：
 * `IAgentLoopStrategy` 有 5 个钩子，但**没有注册链** —— 主循环在 3 处用注释
 * 标出「策略钩子接线」，各自手写调用、各自决定异常怎么处理、返回值要不要消费。
 * 后果是 4 个字段事实上是**死字段**（声明了、实现了、但没人消费）：
 *
 * | 字段 | 声明 | 实现 | 消费 | 2026-09 结局 |
 * |---|---|---|---|---|
 * | `shouldTerminate` | `agentLoopStrategy.ts:145` | 4 个策略 | **无** | **已删除**（职责归 `turnStopGate.classifyIterationStop`） |
 * | `PreLoopResultMeta.skipMainLoop` | `:106` | `graphStrategy.ts:39` | **无**（bug） | 已接线 `agentTurnExecutor.ts:1146` |
 * | `IterationPlan.hardPermission` | `:92` | `readonlyStrategy.ts:81` | **无**（bug） | 已接线（`turnLoopState.iterationHardPermission` → `isToolCallDeniedByTurnPolicy`，2026-09-17） |
 * | `interceptToolCall` 返回值 | `:139` | — | **无** | **已删除**（契约收窄为 `void` 观测钩子，2026-09-17） |
 *
 * ⚠ 上表是**历史问题台账**（记录形态缺陷从何而来），不是当前待办清单。
 *
 * pi 的做法（`harness/agent-harness.ts:430` `HookMap` + `harness/hooks.ts:44`
 * `runWithGate`）是把钩子做成**命名注册表**：钩子名是 `HookMap` 的 key，事件与
 * 返回值类型由同一张表约束，聚合语义按钩子名在一处集中定义（`hooks.ts:89`
 * `aggregate` 的 switch）。调用方只说「跑 before_tool」，不关心有几个 handler、
 * 异常怎么收敛。
 *
 * ## 聚合语义（逐条固化，对齐 pi）
 *
 * - **`before_tool` fail-closed**：handler 抛错必须让工具**不执行**。这是唯一
 *   不能 best-effort 的钩子 —— 权限判定抛错却放行工具，等于权限形同虚设。
 *   对齐 pi `hooks.ts:94` 对 `before_drive` 用 `invokeAllFailClosed` 的同一取舍。
 * - **其余全部 best-effort**：handler 抛错只记录、不打断主循环（对齐 pi
 *   `hooks.ts:144-151` `beforeRun` 的 try/catch + `reportError`）。一个观测
 *   钩子挂了不该让整个 turn 失败。
 * - **`block` 优先于 `patch`**：同一钩子多个 handler，任一 block 即整体 block。
 *
 * @module agentStudio/turnHookBus
 */

/**
 * **接线状态：工具级钩子已接线（2026-09-17 拍板「总线是唯一分发面」）**
 *
 * 生产分发链：`browser/turnHookWiring.ts` 把 `IMemoryProvider.triggerHook`
 * 注册成总线 handler，`agentTurnExecutor.ts` 只认识本总线，不再直接摸 provider。
 *
 * | 总线钩子 | provider 钩子 | executor 调用点 |
 * |---|---|---|
 * | `before_tool` | `pre_tool_use` | `agentTurnExecutor.ts` 工具执行前（fail-closed） |
 * | `after_tool` | `post_tool_use` / `post_tool_failure` | `_postIterationCleanup` 内 |
 *
 * ### 为什么 handler 同步返回 `undefined`
 *
 * `runWithGate` 会 await 每个 handler，而 `triggerHook` 的实现多为跨进程代理
 * （`agentMemoryProviderProxy.ts`）。若真的 await，等于给每个工具调用加一次 IPC
 * 往返 —— 这正是原实现刻意 `.catch(() => { })` 不 await 的原因。
 *
 * 因此 wiring 层的 handler **同步返回 `undefined`**（总线视为「无意见」），内部
 * fire-and-forget 转发。「是否 await」由此降级为 handler 的实现细节，总线的
 * 聚合语义与 provider 的性能约束互不牵扯。
 *
 * ⚠ 改这里前先读 `test/browser/agentSteeringContract.test.ts` 的
 * 「钩子分发面收口契约」——它守护五件事：executor 不得直接调 `triggerHook`、
 * 两个钩子必须经 `runWithGate` 分发、`finally` 必须解绑、wiring 层不得 await
 * 转发、会话级钩子不得塞进 turn 总线。
 *
 * ### 职责边界：只管工具级钩子
 *
 * 两类钩子**刻意不经总线**，否则同一语义会有两条并行分发链：
 *
 *  - **策略级**（每 turn 一次、由范式决定）：`before_run` 的 `skipMainLoop` 由
 *    策略 `preLoop` 承担、`before_request` 的 `hardPermission` 直接接线、
 *    `before_run_end` 由 `beforeTerminate` 承担。
 *  - **会话级**（跨 turn 生命周期）：`session_start` / `prompt_submit`
 *    （`browser/agentMemoryInjection.ts`）、`stop` / `session_end`
 *    （`browser/agentOSService.ts`）—— 本总线实例随 turn 创建销毁，装不下它们。
 */

/** 钩子名 —— 对齐 pi `HookMap`（`harness/agent-harness.ts:430-500`）的命名。 */
export type TurnHookName =
	| 'before_run'
	| 'transform_context'
	| 'before_request'
	| 'after_response'
	| 'before_tool'
	| 'after_tool'
	| 'before_run_end';

/** `before_run` 事件：可追加注入消息。 */
export interface IBeforeRunEvent {
	readonly iteration: number;
	readonly messageCount: number;
}

/** `before_run` 结果：注入的消息（多 handler 累加）。 */
export interface IBeforeRunResult {
	readonly injectedMessages?: readonly unknown[];
	/** true=本轮无需进入主循环（承接 `PreLoopResultMeta.skipMainLoop`）。 */
	readonly skipMainLoop?: boolean;
}

/** `transform_context` 事件：改写本轮上下文。 */
export interface ITransformContextEvent {
	readonly messages: readonly unknown[];
	readonly systemPrompt: string;
}

export interface ITransformContextResult {
	readonly messages?: readonly unknown[];
	readonly systemPrompt?: string;
}

/** `before_request` 事件：改写本轮工具面 / 注入提醒 / 硬权限。 */
export interface IBeforeRequestEvent {
	readonly iteration: number;
	readonly toolNames: readonly string[];
}

export interface IBeforeRequestResult {
	/** 覆盖本轮工具面。 */
	readonly toolNames?: readonly string[];
	/** 注入的 `<system-reminder>`。 */
	readonly reminderMessage?: string;
	/**
	 * 工具级硬权限：返回 true 表示拦截。
	 *
	 * 承接原 `IterationPlan.hardPermission`（`agentLoopStrategy.ts:92`，此前
	 * 零消费）。当前仍无生产消费者：`agentTurnExecutor.ts` 的硬权限判据是批次级
	 * 内联段（含计划文件豁免），与本字段的「单工具名 → bool」形状不匹配。
	 * `prepareToolCall` 曾计划消费它，该函数已于 2026-09-17 删除。
	 */
	readonly hardPermission?: (toolName: string) => boolean;
}

/** `after_response` 事件：观测本轮流式结果。 */
export interface IAfterResponseEvent {
	readonly iteration: number;
	readonly stopReason: string | undefined;
	readonly toolCallCount: number;
}

/** `before_tool` 事件：工具执行前的权限 / 参数改写点。 */
export interface IBeforeToolEvent {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
}

export interface IBeforeToolResult {
	/** 改写后的参数。 */
	readonly args?: unknown;
	/** 拦截该工具调用。 */
	readonly block?: { readonly reason: string; readonly terminate?: boolean };
}

/** `after_tool` 事件：工具结果后处理点。 */
export interface IAfterToolEvent {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: unknown;
	readonly isError: boolean;
}

export interface IAfterToolResult {
	readonly content?: unknown;
	readonly isError?: boolean;
	/** 整批终止。 */
	readonly terminate?: boolean;
}

/** `before_run_end` 事件：即将正常结束（TaskGate 挂载点）。 */
export interface IBeforeRunEndEvent {
	readonly iteration: number;
	readonly hasPendingWork: boolean;
}

/** `before_run_end` 结果：`followUp` 非空则注入并续跑。 */
export interface IBeforeRunEndResult {
	readonly followUp?: string;
}

/** 钩子名 → { 事件, 结果 } 的映射表（对齐 pi `HookMap`）。 */
export interface TurnHookMap {
	before_run: { event: IBeforeRunEvent; result: IBeforeRunResult | undefined };
	transform_context: { event: ITransformContextEvent; result: ITransformContextResult | undefined };
	before_request: { event: IBeforeRequestEvent; result: IBeforeRequestResult | undefined };
	after_response: { event: IAfterResponseEvent; result: void };
	before_tool: { event: IBeforeToolEvent; result: IBeforeToolResult | undefined };
	after_tool: { event: IAfterToolEvent; result: IAfterToolResult | undefined };
	before_run_end: { event: IBeforeRunEndEvent; result: IBeforeRunEndResult | undefined };
}

/** 单个钩子处理器。 */
export type TurnHookHandler<TName extends TurnHookName> = (
	event: TurnHookMap[TName]['event'],
) => Promise<TurnHookMap[TName]['result']> | TurnHookMap[TName]['result'];

/** 错误上报口（best-effort 钩子抛错时调用）。 */
export type TurnHookErrorReporter = (hookName: TurnHookName, error: Error) => void;

/**
 * `before_tool` 抛错时用的哨兵错误。
 *
 * 独立类型使调用方能区分「工具被策略主动 block」与「权限钩子自身崩了」——
 * 两者都必须阻止执行，但日志与用户提示不同。
 */
export class TurnHookGateError extends Error {
	constructor(readonly hookName: TurnHookName, override readonly cause: Error) {
		super(`Hook "${hookName}" failed closed: ${cause.message}`);
		this.name = 'TurnHookGateError';
	}
}

/**
 * 判定某钩子是否 fail-closed。
 *
 * 只有 `before_tool` 是 fail-closed：它是权限判定点，handler 抛错却放行工具
 * 等于权限形同虚设。其余钩子都是观测 / 改写性质，抛错不该打断整个 turn。
 */
export function isFailClosedHook(hookName: TurnHookName): boolean {
	return hookName === 'before_tool';
}

/**
 * 钩子总线 —— 命名注册 + 按钩子名固化的聚合语义。
 *
 * 对齐 pi `harness/hooks.ts` 的 `Hooks` 类：注册表按名分桶，`runWithGate`
 * 统一入口，聚合逻辑集中在一处而非散落调用点。
 */
export class TurnHookBus {
	private readonly registrations = new Map<TurnHookName, Array<TurnHookHandler<TurnHookName>>>();

	constructor(private readonly reportError?: TurnHookErrorReporter) { }

	/** 注册一个钩子处理器；返回取消注册的函数。 */
	register<TName extends TurnHookName>(hookName: TName, handler: TurnHookHandler<TName>): () => void {
		// 注册表按名分桶存储，桶内元素类型只能是「某个」钩子的 handler；TS 无法
		// 证明 TName 与 TurnHookName 双向可比较，故经 unknown 中转。
		// 运行时安全由 registrations 的 key 保证：桶里的 handler 一定与桶名同源。
		const erasedHandler = handler as unknown as TurnHookHandler<TurnHookName>;
		const bucket = this.registrations.get(hookName) ?? [];
		bucket.push(erasedHandler);
		this.registrations.set(hookName, bucket);
		return () => {
			const current = this.registrations.get(hookName);
			if (!current) {
				return;
			}
			const index = current.indexOf(erasedHandler);
			if (index >= 0) {
				current.splice(index, 1);
			}
		};
	}

	/** 该钩子是否有注册者（调用方可据此跳过事件构造开销）。 */
	has(hookName: TurnHookName): boolean {
		return (this.registrations.get(hookName)?.length ?? 0) > 0;
	}

	private handlersFor<TName extends TurnHookName>(hookName: TName): Array<TurnHookHandler<TName>> {
		return (this.registrations.get(hookName) ?? []).slice() as unknown as Array<TurnHookHandler<TName>>;
	}

	/**
	 * 运行某钩子的全部处理器并按语义聚合 —— 对齐 pi `runWithGate`。
	 *
	 * @throws TurnHookGateError 仅当 fail-closed 钩子（`before_tool`）的 handler 抛错。
	 */
	async runWithGate<TName extends TurnHookName>(
		hookName: TName,
		event: TurnHookMap[TName]['event'],
	): Promise<TurnHookMap[TName]['result']> {
		const handlers = this.handlersFor(hookName);
		if (handlers.length === 0) {
			return undefined as TurnHookMap[TName]['result'];
		}

		// transform_context 是**链式**而非折叠：后一个 handler 必须看到前一个的
		// 改写结果。若按其余钩子那样「各自拿原始 event、末位非空者胜」，两个都
		// 注入消息的 handler 会互相覆盖 —— 前者的注入被静默丢弃。
		if (hookName === 'transform_context') {
			return await this.runTransformContextChain(
				handlers as unknown as Array<TurnHookHandler<'transform_context'>>,
				event as ITransformContextEvent,
			) as TurnHookMap[TName]['result'];
		}

		const results: Array<NonNullable<TurnHookMap[TName]['result']>> = [];
		for (const handler of handlers) {
			try {
				const result = await handler(event);
				if (result !== undefined && result !== null) {
					results.push(result as NonNullable<TurnHookMap[TName]['result']>);
				}
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				if (isFailClosedHook(hookName)) {
					throw new TurnHookGateError(hookName, normalized);
				}
				this.reportError?.(hookName, normalized);
			}
		}

		return this.aggregate(hookName, results);
	}

	/**
	 * 链式运行 `transform_context`：每个 handler 的输出成为下一个的输入。
	 *
	 * best-effort —— 某个 handler 抛错时保留此前累积的改写并继续后续 handler，
	 * 因为上下文注入是增量的，丢弃全部累积结果比丢弃单个 handler 的贡献更糟。
	 */
	private async runTransformContextChain(
		handlers: ReadonlyArray<TurnHookHandler<'transform_context'>>,
		event: ITransformContextEvent,
	): Promise<ITransformContextResult | undefined> {
		let messages = event.messages;
		let systemPrompt = event.systemPrompt;
		let changed = false;

		for (const handler of handlers) {
			try {
				const result = await handler({ messages, systemPrompt });
				if (!result) {
					continue;
				}
				if (result.messages !== undefined) {
					messages = result.messages;
					changed = true;
				}
				if (result.systemPrompt !== undefined) {
					systemPrompt = result.systemPrompt;
					changed = true;
				}
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				this.reportError?.('transform_context', normalized);
			}
		}

		return changed ? { messages, systemPrompt } : undefined;
	}

	/**
	 * 按钩子名聚合多 handler 结果。
	 *
	 * 对齐 pi `hooks.ts:89` 的 `aggregate` switch：聚合策略是**钩子的属性**，
	 * 不是调用点的自由裁量 —— 这正是收口前 3 处内联接线各自为政的根因。
	 */
	private aggregate<TName extends TurnHookName>(
		hookName: TName,
		results: ReadonlyArray<NonNullable<TurnHookMap[TName]['result']>>,
	): TurnHookMap[TName]['result'] {
		if (results.length === 0) {
			return undefined as TurnHookMap[TName]['result'];
		}

		switch (hookName) {
			case 'before_run': {
				const typed = results as ReadonlyArray<IBeforeRunResult>;
				const injectedMessages = typed.flatMap(r => r.injectedMessages ?? []);
				const skipMainLoop = typed.some(r => r.skipMainLoop === true);
				const merged: IBeforeRunResult = {
					...(injectedMessages.length > 0 ? { injectedMessages } : {}),
					...(skipMainLoop ? { skipMainLoop: true } : {}),
				};
				return (injectedMessages.length === 0 && !skipMainLoop
					? undefined
					: merged) as TurnHookMap[TName]['result'];
			}

			// transform_context 不走 aggregate：链式语义见 runTransformContextChain。

			case 'before_request': {
				// 最后一个非空声明生效；hardPermission 合成为「任一拦截即拦截」。
				const typed = results as ReadonlyArray<IBeforeRequestResult>;
				let toolNames: readonly string[] | undefined;
				const reminders: string[] = [];
				const permissionChecks: Array<(toolName: string) => boolean> = [];
				for (const result of typed) {
					toolNames = result.toolNames ?? toolNames;
					if (result.reminderMessage) {
						reminders.push(result.reminderMessage);
					}
					if (result.hardPermission) {
						permissionChecks.push(result.hardPermission);
					}
				}
				const merged: IBeforeRequestResult = {
					...(toolNames ? { toolNames } : {}),
					...(reminders.length > 0 ? { reminderMessage: reminders.join('\n\n') } : {}),
					...(permissionChecks.length > 0
						? { hardPermission: (toolName: string) => permissionChecks.some(check => check(toolName)) }
						: {}),
				};
				return merged as TurnHookMap[TName]['result'];
			}

			case 'before_tool': {
				// block 优先于 args 改写：任一 handler 拦截即整体拦截。
				const typed = results as ReadonlyArray<IBeforeToolResult>;
				const blocked = typed.find(r => r.block !== undefined);
				if (blocked) {
					return { block: blocked.block } as TurnHookMap[TName]['result'];
				}
				let args: unknown;
				for (const result of typed) {
					args = result.args ?? args;
				}
				return (args === undefined ? undefined : { args }) as TurnHookMap[TName]['result'];
			}

			case 'after_tool': {
				const typed = results as ReadonlyArray<IAfterToolResult>;
				let content: unknown;
				let isError: boolean | undefined;
				let terminate: boolean | undefined;
				for (const result of typed) {
					content = result.content ?? content;
					isError = result.isError ?? isError;
					// terminate 一旦被任一 handler 置真便不可撤销（整批终止是单调信号）。
					terminate = result.terminate === true ? true : terminate;
				}
				return { content, isError, terminate } as TurnHookMap[TName]['result'];
			}

			case 'before_run_end': {
				// 最后一个非空 followUp 生效（对齐 pi hooks.ts:96-108 的覆盖语义）。
				const typed = results as ReadonlyArray<IBeforeRunEndResult>;
				let followUp: string | undefined;
				for (const result of typed) {
					followUp = result.followUp ?? followUp;
				}
				return (followUp === undefined ? undefined : { followUp }) as TurnHookMap[TName]['result'];
			}

			case 'after_response':
			default:
				return undefined as TurnHookMap[TName]['result'];
		}
	}
}
