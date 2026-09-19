/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turn delta dispatch — 模型流 delta 的**纯函数**分类层。
 *
 * 背景：`agentTurnExecutor.ts` 的流消费循环里，`delta.type` 这个 7 值联合被**三处
 * 独立重复判定**：
 *   1. 诊断字符串化    `String(delta.type ?? 'unknown')`
 *   2. 业务分派        `if (delta.type === 'text') ... else if (... 'thinking') ...`
 *   3. 日志预览        `if (delta.type === 'text' && delta.content) ... else if (... )`
 *
 * 三处判定分散在同一循环的不同行段（相距 100+ 行），任何联合类型变更都要同时
 * 改动三处，且漏改时 TS 不会报错（因为都是字符串字面量比较，非穷尽 switch）。
 * 本模块把"delta 是什么"收敛为单一事实源。
 *
 * 设计约束：
 *  - 全部为纯函数，无 IO、无闭包状态、无 Date.now() —— 可独立单测。
 *  - 不持有 delta 内容，只做**分类判定**（返回布尔/枚举），把内容读取留给调用方，
 *    避免引入对 IModelUsage / IToolCallInfo 等结构的深拷贝开销。
 */

import { IModelDelta } from '../common/providers.js';

/**
 * 收窄后的 delta 形态：`type` 已知且**载荷必存在**。
 *
 * 用作 {@link isTextDelta} 等判定函数的返回类型谓词，使调用点在 `if` 分支内
 * 直接获得非可选的 `content` / `toolCall` / `usage` —— 这是把内联
 * `delta.type === 'text' && delta.content` 抽成函数后**必须**补上的能力，
 * 否则 TS 无法跨函数边界收窄，会在每个使用点报 TS18048/TS2345。
 */
type TextDelta = IModelDelta & { type: 'text'; content: string };
type ThinkingDelta = IModelDelta & { type: 'thinking'; content: string };
type ToolCallDelta = IModelDelta & { type: 'tool_call'; toolCall: NonNullable<IModelDelta['toolCall']> };
type UsageDelta = IModelDelta & { type: 'usage'; usage: NonNullable<IModelDelta['usage']> };

/** delta 的语义分类——与 `IModelDelta.type` 一一对应，用于穷尽分派。 */
export type TurnDeltaKind =
	| 'text'
	| 'thinking'
	| 'tool_call'
	| 'done'
	| 'error'
	| 'usage'
	| 'tool_progress'
	| 'unknown';

/**
 * 把任意 delta 归一为 {@link TurnDeltaKind}。
 *
 * 这是原先 `String(delta.type ?? 'unknown')` 的类型安全替代：当 provider 返回
 * 契约外的 type（历史事故：网关透传了未在联合中声明的值）时降级为 `'unknown'`
 * 而非把原始字符串泄漏进日志与判定分支。
 */
export function classifyTurnDelta(delta: Pick<IModelDelta, 'type'> | undefined | null): TurnDeltaKind {
	const rawType = delta?.type;
	if (!rawType) {
		return 'unknown';
	}
	switch (rawType) {
		case 'text':
		case 'thinking':
		case 'tool_call':
		case 'done':
		case 'error':
		case 'usage':
		case 'tool_progress':
			return rawType;
		default:
			return 'unknown';
	}
}

/**
 * 该 delta 是否携带**正文文本**内容。
 *
 * 原实现在分派与预览两处各写一遍 `delta.type === 'text' && delta.content`，
 * 且预览分支多加了对 `thinking` 的 `(delta as any).content` 强转——此处一并消除。
 */
export function isTextDelta(delta: IModelDelta): delta is TextDelta {
	return delta.type === 'text' && !!delta.content;
}

/**
 * 该 delta 是否携带**思考（reasoning）**内容。
 *
 * 注意：`IModelDelta.content` 是可选字段且不区分 text/thinking，
 * 因此必须同时校验 `type`，不能只看 `content` 是否存在。
 */
export function isThinkingDelta(delta: IModelDelta): delta is ThinkingDelta {
	return delta.type === 'thinking' && !!delta.content;
}

/**
 * 该 delta 是否携带**增量 token 用量**。
 *
 * `usage` 字段仅在 `type === 'usage'` 时有意义——其他 delta 上同名字段
 * 即使存在也应忽略，避免把 provider 的杂散字段计入统计。
 */
export function isUsageDelta(delta: IModelDelta): delta is UsageDelta {
	return delta.type === 'usage' && !!delta.usage;
}

/**
 * 该 delta 是否是可进入**工具装配**的 tool_call 分片。
 *
 * 注意与 `type === 'tool_call'` 的区别：`tool_progress` 也会携带
 * `toolName`/`bytes`/`partialArgs`，但按契约**严禁**参与工具完成判定
 * （见 `providers.ts` 的 IModelDelta 注释：完成判定唯一来源是 tool_start）。
 * 本函数显式排除 tool_progress，把该契约固化为可测断言。
 */
export function isToolCallDelta(delta: IModelDelta): delta is ToolCallDelta {
	return delta.type === 'tool_call' && !!delta.toolCall;
}

/**
 * 该 delta 是否携带**结束原因**（finish_reason / stop_reason）。
 *
 * 用于 agent loop 判定"未完成轮"；非 done 类型的 delta 上即使有
 * `finishReason` 也一律忽略。
 */
export function isDoneWithFinishReason(delta: IModelDelta): boolean {
	return delta.type === 'done' && !!delta.finishReason;
}

/**
 * 该 delta 是否为**错误**信号。
 *
 * 首个 delta 即 error 意味着请求被本地/网关即时拒绝（历史事故：模型不在
 * 网关 allow-list，连败 3 轮但日志只有光秃秃的 `type=error`）。
 */
export function isErrorDelta(delta: IModelDelta): boolean {
	return delta.type === 'error';
}

/**
 * 该 delta 是否应**续命 idle 计时器**。
 *
 * `tool_progress` 是 provider 在参数流式生成期间上报的轻量心跳，不产生正文
 * 也不进入工具装配，但表明连接仍活跃——若不计入续命，长参数生成的工具
 * 会被 idle 超时误杀。
 */
export function isLivenessDelta(delta: IModelDelta): boolean {
	return delta.type === 'tool_progress';
}
