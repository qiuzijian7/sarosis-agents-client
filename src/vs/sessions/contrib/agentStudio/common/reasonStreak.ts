/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reasoning 循环检测（直译自 MiMo-Code `session/prompt/loop-streak.ts`，2026-09-13）。
 *
 * 动机：既有的 `detectToolCallLoop` / ping-pong / Hermes 护栏全部以**工具签名**为主键，
 * 于是漏掉了一类最主流的中毒形态 —— **模型在 thinking 里原地打转、工具只是轻微漂移**
 * （参数变一点点、路径换一个），签名每次不同，所有签名类检测器都不触发。
 *
 * MiMo-Code 的实测数据（本地 DB 统计）：相同 reasoning 开头出现 621 次、最长连续 661；
 * 相同工具签名 3469 次、最长连续 628 —— 两者量级相当，但**只有前者能覆盖漂移**。
 *
 * 本模块只做「判定」，不做裁剪（crop 属 P2，需与 PromptFingerprint 缓存机制一并评审）。
 * 设计契约：
 *   · 纯函数、无副作用、**零依赖** —— 与 `toolGuardrailController` 同一风格，便于单测与复用；
 *   · reasoning 为主键、工具签名兜底 —— 与 MiMo-Code `streakKey` 一致；
 *   · 归一化必须先于摘要 —— 否则「Let me check…」与「let me check…」会漏判。
 */

/** 连续相同的 reasoning 达到该次数即判定为循环（对齐 MiMo-Code LOOP_STREAK_TRIGGER_COUNT）。 */
export const REASON_STREAK_TRIGGER_COUNT = 3;

/**
 * 归一化 reasoning 文本，消除「表面不同、实质重复」的措辞差异。
 *
 * 处理项（逐条对齐 MiMo-Code `normalizeReasoningForStreak`）：
 *   1. 去首尾空白、转小写、折叠内部连续空白为单个空格；
 *   2. 剥掉开场的引导语（let me / i'll / i will / let's）—— 模型每轮复述同一计划时，
 *      往往只在这几个词上有微小差异。
 */
export function normalizeReasoningForStreak(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/^(let me |i'll |i will |let's )/i, '');
}

/**
 * 计算文本的稳定摘要（16 位十六进制）。
 *
 * 采用 FNV-1a 32 位双通道（两个不同 offset basis 并行），而非 `node:crypto`：
 * 本模块位于 `common/` 层，需同时被 browser（渲染进程，无 Node 内置模块）与
 * Node 侧复用 —— 引 `node:crypto` 会让 browser 打包直接失败。这里只做**相等性**
 * 判定（不做安全用途），32 位碰撞概率对「连续 3 轮完全相同」的场景可忽略。
 *
 * 返回空串表示「无可用文本」——调用方据此降级，**绝不能**把空串当作有效摘要
 * 参与相等比较（否则所有无 thinking 的轮次会被误判为「同一个循环」）。
 */
export function reasonHash(reasoningText: string | undefined | null): string {
	if (!reasoningText) {
		return '';
	}
	const normalized = normalizeReasoningForStreak(reasoningText);
	if (!normalized) {
		return '';
	}
	return fnv1aHex(normalized, 0x811c9dc5) + fnv1aHex(normalized, 0x01000193);
}

/**
 * FNV-1a 32 位散列，返回 8 位十六进制。
 *
 * 用 `Math.imul` 保证 32 位整数乘法语义（普通 `*` 会因 IEEE-754 精度丢高位），
 * `>>> 0` 把结果归一到无符号 32 位。
 */
function fnv1aHex(text: string, offsetBasis: number): string {
	let hash = offsetBasis >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/** 一次迭代的循环签名：thinking 为主键、工具调用为辅键。 */
export interface IStreakKeyParts {
	/** 本轮 assistant 的 reasoning / thinking 全文（可为空）。 */
	readonly reasoning?: string;
	/** 本轮发起的工具调用（name + 规范化参数）。 */
	readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly argsHash: string }>;
}

/**
 * 计算循环签名键。
 *
 * 优先级与 MiMo-Code `streakKey` 一致：
 *   1. 有 reasoning → `reason:<hash>`（**工具漂移也算同一 streak**，这是本模块的核心价值）；
 *   2. 无 reasoning → `tool:<signature>`（thinking-less 轮次的兜底）；
 *   3. 两者皆无 → 空串（不参与判定）。
 */
export function computeStreakKey(parts: IStreakKeyParts): string {
	const reason = reasonHash(parts.reasoning);
	if (reason) {
		return `reason:${reason}`;
	}
	if (!parts.toolCalls || parts.toolCalls.length === 0) {
		return '';
	}
	const signature = parts.toolCalls
		.map((call) => `tool:${call.name}:${call.argsHash}`)
		.join('\n');
	return signature ? `tool:${signature}` : '';
}

/**
 * 判定历史尾部是否构成 reasoning 循环。
 *
 * @param history 按时间正序的签名键列表（尾部为最新）
 * @returns 连续相同键的长度；未达阈值返回 0
 */
export function detectReasonStreak(
	history: ReadonlyArray<string>,
	triggerCount: number = REASON_STREAK_TRIGGER_COUNT,
): number {
	if (triggerCount < 2 || history.length < triggerCount) {
		return 0;
	}
	const tailKey = history[history.length - 1];
	// 空键代表「本轮无 reasoning 也无工具」，不参与判定 —— 否则连续多轮空产出会误报。
	if (!tailKey) {
		return 0;
	}
	let length = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i] !== tailKey) {
			break;
		}
		length++;
	}
	return length >= triggerCount ? length : 0;
}

/**
 * 构造注入模型的强引导文案。
 *
 * 与既有护栏文案（`toolConsecutiveFailureReminder` 等）保持同一 `<system-reminder>` 形态，
 * 便于复用现有的 appendMessages 通道与 UI 渲染。
 */
export function reasonStreakReminder(streakLength: number): string {
	return [
		'<system-reminder>',
		`Your reasoning has repeated the same plan ${streakLength} times in a row (even if the wording or tool arguments drifted slightly).`,
		'You are stuck in a thinking loop: re-reading the same idea will not produce a new result.',
		'STOP re-planning and take a DIFFERENT action:',
		'  · If a tool kept failing, read its error message and change the approach — not just the arguments.',
		'  · If you lack information, ask the user instead of re-deriving it.',
		'  · If you already have enough to answer, deliver the conclusion now.',
		'</system-reminder>',
	].join('\n');
}
