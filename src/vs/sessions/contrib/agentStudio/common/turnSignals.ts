/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turn 终止信号（Turn Signals）—— 2026-08-21，日志 1787289570191
 *
 * ## 背景
 *
 * `clarify` 工具（`coreTools.ts`）的语义是「向用户提问并**等待回答**」：
 *  - 工具 handler 返回 `[{type:'text', text:'{"__clarify__":true, questions:[...]}'}]`
 *  - UI（`agentChatPanel.toolCards.ts`）渲染成带选项/输入框/提交按钮的澄清卡片
 *  - 用户提交 → `onClarifySubmit` → `_sendMessageInternal(answer)` → **作为新消息**开启下一 turn
 *
 * 闭环本身是完整的，但 **agent loop 侧对 clarify 零引用**（本次修复前 grep
 * `agentTurnExecutor.ts` / `agentOSService.ts` 均为 0 处命中）。后果：
 * 模型调用 clarify 把问题抛给用户后，loop 毫不知情继续跑下一轮 —— 而此时
 * 用户的回答还没到，模型只能空转。
 *
 * 日志 1787289570191 实证（14 轮迭代）：
 *   iteration 9  → clarify（正确行为：模型发现「右键连线其实已有断开菜单」与
 *                  用户描述矛盾，主动澄清而非盲改代码）
 *   iteration 10 → tool_search（短路，无产出）
 *   iteration 11 → toolCalls=0，模型自陈 "I've asked for clarification"
 *   iteration 12 → toolCalls=0
 *   iteration 13 → toolCalls=0
 *   iteration 14 → toolCalls=0，模型自救 "I'll stop here rather than loop on..."
 * 即 14 轮中 5 轮（36%）纯浪费，约 1468 输出 token + 4 次 ~38000 prompt token 往返。
 *
 * ## 设计
 *
 * `agentTurnExecutor.ts:1532` 早已预留 `shouldTerminateToolBatch` 接口，注释写着
 * 「预留接口，为将来扩展（如"任务已完成"信号工具）做准备」，但从无工具使用它 ——
 * 又一处「接口齐全 ≠ 已接线」。本模块即为该预留点提供第一个真实信号实现。
 *
 * ⚠ 与 `shouldTerminateToolBatch` 的 `every` 语义**刻意不同**：clarify 用 `some`。
 * 理由：问题一旦渲染给用户，本 turn 就已失去继续的意义 —— 同批次其他工具的结果
 * 模型也用不上（它在等回答）。要求「全部工具都 terminate」会让
 * `clarify + file_read` 这种混合批次继续空转，正是本次事故形态。
 */

/** 一个已完成的工具结果（结构对齐 agentTurnExecutor 的 `toolResults` 元素）。 */
export interface ITurnSignalToolResult {
	readonly toolCallId: string;
	/**
	 * 工具返回内容。形状随执行路径而异，本模块必须全部容纳：
	 *  - `[{type:'text', text:'...'}]`（正常工具执行路径，最常见）
	 *  - `{error: '...'}`（hardPermission 拦截路径）
	 *  - `'...'`（部分 provider 直接返回字符串）
	 */
	readonly content: unknown;
	readonly success?: boolean;
}

/** clarify 载荷的判定结果。 */
export interface IClarifySignal {
	/** 触发 clarify 的工具调用 ID（日志用） */
	readonly toolCallId: string;
	/** 问题数量（单问题模式记为 1；仅用于日志，不参与判定） */
	readonly questionCount: number;
}

/** clarify 工具名（与 `coreTools.ts` 的注册名保持一致）。 */
export const CLARIFY_TOOL_NAME = 'clarify';

/** clarify 载荷的标记字段（与 `coreTools.ts` handler 及 UI 解析保持一致）。 */
const CLARIFY_MARKER = '__clarify__';

/**
 * 把任意形状的工具 content 归一为可检查的字符串。
 *
 * 不用 `JSON.stringify` 一把梭的原因：content 里可能含循环引用（provider 返回的
 * 富对象），stringify 会抛异常。这里逐层浅取文本，异常一律降级为空串
 * ——**判定失败必须回退到"不是信号"**，绝不能让判定异常影响 loop 正常运行。
 */
function contentToText(content: unknown): string {
	try {
		if (typeof content === 'string') { return content; }
		if (Array.isArray(content)) {
			return content
				.map(part => {
					if (typeof part === 'string') { return part; }
					const text = (part as { text?: unknown } | null)?.text;
					return typeof text === 'string' ? text : '';
				})
				.join('\n');
		}
		if (content && typeof content === 'object') {
			const text = (content as { text?: unknown }).text;
			if (typeof text === 'string') { return text; }
		}
	} catch {
		/* 判定不可抛 —— 见上方注释 */
	}
	return '';
}

/**
 * content 是否是**真正的** clarify 载荷。
 *
 * 必须区分「成功提问」与「参数错误」：`clarify` 在缺少 question/questions 时返回
 * `'Error: question or questions[] parameter is required'`（普通文本，无 marker）。
 * 那种情况**不能**终止 turn —— 否则模型一次参数写错就直接结束，用户什么也看不到。
 * 因此判据是「含 `__clarify__` marker」而非「工具名是 clarify」。
 *
 * @returns 问题数量（>0 表示确认是 clarify 载荷）；0 表示不是
 */
function parseClarifyQuestionCount(content: unknown): number {
	const text = contentToText(content);
	// 先做廉价的字符串预检，避免对每个工具结果都尝试 JSON.parse
	if (!text || !text.includes(CLARIFY_MARKER)) { return 0; }
	try {
		const parsed = JSON.parse(text) as {
			__clarify__?: unknown;
			question?: unknown;
			questions?: unknown;
		};
		if (parsed?.__clarify__ !== true) { return 0; }
		if (Array.isArray(parsed.questions)) {
			return parsed.questions.length > 0 ? parsed.questions.length : 0;
		}
		return typeof parsed.question === 'string' && parsed.question.trim() ? 1 : 0;
	} catch {
		// marker 在但 JSON 不合法：宁可**不**终止（漏拦一轮空转，
		// 好过误终止把正常 turn 掐掉）。
		return 0;
	}
}

/**
 * 在一批工具结果中查找 clarify 信号。
 *
 * @param toolResults 本轮已完成的工具结果
 * @param resolveToolName 由 toolCallId 反查工具名（executor 侧用 localExecutedCalls 查）
 * @returns 命中的 clarify 信号；未命中返回 undefined
 *
 * 双重判据（缺一不可）：
 *  1. 工具名 === 'clarify' —— 防止普通文件内容里恰好含 `__clarify__` 字样被误判
 *     （例如本模块自身的源码被 file_read 读出来时！）
 *  2. content 含合法 `__clarify__` 载荷 —— 防止把参数错误当成成功提问
 */
export function findClarifySignal(
	toolResults: ReadonlyArray<ITurnSignalToolResult>,
	resolveToolName: (toolCallId: string) => string | undefined,
): IClarifySignal | undefined {
	for (const tr of toolResults) {
		if (resolveToolName(tr.toolCallId) !== CLARIFY_TOOL_NAME) { continue; }
		const questionCount = parseClarifyQuestionCount(tr.content);
		if (questionCount > 0) {
			return { toolCallId: tr.toolCallId, questionCount };
		}
	}
	return undefined;
}
