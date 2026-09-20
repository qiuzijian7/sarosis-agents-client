/*---------------------------------------------------------------------------------------------
 *  pi 内核驱动器 —— 工具护栏钩子族（2026-09-20 自 piTurnKernel.ts 拆出）。
 *
 *  承载全部「失控防护 + 边界引导」语义，与 legacy 逐点对齐：
 *    · 判定链：ping-pong → no-progress 护栏 → 同签名循环检测（executor:2862-2936 同序）；
 *    · ToolGuardrailController（executor 同款显式配置）：no-progress 第 3 次拦 / halt 8 次；
 *    · 引导六件：reasonStreak / 连败熔断 / terminal 空输出 / 文本搜索连击（软硬）/
 *      argument_churn / 单只读工具连击 / 全批拦截三档；
 *    · 子代理软预算提醒（wall-clock，60s 重提）。
 *  提醒投递双通道：afterToolCall `replace` 追加进工具结果（默认）/ shouldStopAfterTurn
 *  直写 transcript（全批拦截轮 —— 被拦调用走 immediate 路径不过 afterToolCall）。
 *--------------------------------------------------------------------------------------------*/

import type { IToolDefinition } from '../../common/providers.js';
import {
	canonicalToolArgsHash,
	detectArgumentChurn,
	detectToolCallLoop,
	detectToolCallPingPong,
	hashToolResult,
} from '../../common/agentRunState.js';
import { classifyAllBlockedStreak, classifyPingPong } from '../../common/turnStopGate.js';
import {
	MAX_CONSECUTIVE_TOOL_FAILURES,
	MAX_TEXT_SEARCH_STREAK,
	MAX_TEXT_SEARCH_STREAK_HARD,
} from '../../common/turnLoopConstants.js';
import { STRUCTURAL_SEARCH_TOOL_NAMES, TEXT_SEARCH_TOOL_NAMES } from '../../common/searchToolGroups.js';
import {
	computeStreakKey,
	detectReasonStreak,
	reasonStreakReminder,
	REASON_STREAK_TRIGGER_COUNT,
} from '../../common/reasonStreak.js';
import {
	advanceSingleToolStreak,
	allBlockedWrapUpReminder,
	ALL_BLOCKED_ESCALATE_AT,
	ALL_BLOCKED_WRAPUP_AT,
	allToolCallsBlockedReminder,
	argumentChurnReminder,
	batchReadOnlyToolsReminder,
	preferGraphSearchReminder,
	softBudgetWrapUpReminder,
	stopSearchingReportReminder,
	terminalEmptyOutputReminder,
	textSearchLoopWrapUpReminder,
	toolConsecutiveFailureReminder,
} from '../../common/loopReminders.js';
import { buildLoopBlockFeedback, isParallelSafeReadOnlyTool } from '../toolCallUtils.js';
import { ToolGuardrailController } from '../toolGuardrailController.js';
import { isMultiTargetChurnTool } from '../parts/turnHelpers.js';
import { toolResultToText } from './kernelUtils.js';
import type { AgentLoopConfig, AgentMessage, AssistantMessage } from './types.js';
import type { IPiKernelHost } from './piTurnKernel.js';

/**
 * 工具护栏钩子（对齐 executor:2862-2936 + 护栏控制器，2026-09-20 补齐 no-progress/halt）：
 *   判定链顺序与 legacy 逐字一致：ping-pong → **no-progress 护栏** → 同签名循环检测。
 *   · `detectToolCallPingPong` + `classifyPingPong` —— A⇄B 交替且两侧结果稳定 ⇒ 拦；
 *   · `ToolGuardrailController`（executor 同款显式配置）—— 只采纳 `idempotent_no_progress_block`
 *     （同签名+同结果反复 ⇒ 拦，比 detectToolCallLoop 更早：第 3 次即拦，executor:2902-2916）；
 *     其余 block code ⇒ 记录后放行（"宁可放过也不误伤"）；`halt`（同名工具失败 8 次）⇒
 *     经 `shouldStopAfterTurn` 收尾整轮后退出主循环；
 *   · `detectToolCallLoop` —— 同签名历史 ≥3 ⇒ 第 4 次拦；
 *   · 拦截文案：no-progress 用护栏 decision.message，循环检测用 `buildLoopBlockFeedback`（逐字一致）；
 *   · piLoop 的 `blocked` 语义 = 跳过执行并合成错误结果（与 legacy 的合成失败结果同构）。
 * 历史与控制器都保存在驱动器本地（pi 路径不挂 runState；控制器 per-turn 生命周期与 legacy
 * "在 executeAgentTurnDirect 内 new" 同构 —— 本函数每次 runPiKernelTurn 调用新建）。
 */
export function makeGuardrailHooks(host: IPiKernelHost, enabledTools: readonly IToolDefinition[], opts?: { readonly softDeadlineMs?: number }): {
	beforeToolCall: NonNullable<AgentLoopConfig['beforeToolCall']>;
	afterToolCall: NonNullable<AgentLoopConfig['afterToolCall']>;
	shouldStopAfterTurn: NonNullable<AgentLoopConfig['shouldStopAfterTurn']>;
	/** 每条 assistant 终态消息上调用（工具轮）：reasonStreak 追踪（executor:3088-3106）。 */
	onAssistantMessageEnd: (message: AssistantMessage) => void;
	/** 强制收尾轮请求（文本搜索连击硬上限等；对齐 legacy `wrapUp.forced`）。一次性消费。 */
	requestWrapUp: () => string | undefined;
} {
	const history: Array<{ name: string; argsHash: string; resultHash?: string }> = [];
	// ── 提醒延迟投递（对齐 legacy `_pendingBatchReminders` 语义）──────────────────
	// 提醒只随工具批次投递：追加进**下一条工具结果**的文本尾部（afterToolCall replace），
	// 模型可见且不劈开 tool result 序列；模型停手（无更多工具轮）时自然不注入 ——
	// 与 legacy「stale 提醒不注入」一致（避免借 steering 通道把本该结束的轮次续跑）。
	const pendingReminders: string[] = [];
	// reasonStreak：每轮（仅工具轮）computeStreakKey 落历史，连击 ≥3 ⇒ 排提醒
	const streakHistory: string[] = [];
	// 连续失败：同名工具失败计数（成功清零），≥3 ⇒ 排提醒（executor:3352-3363）
	const consecutiveFailures = new Map<string, number>();
	// terminal 空输出连击（executor:3365-3385；阈值 3 与 executor:982 的局部常量对齐）
	const MAX_TERMINAL_EMPTY = 3;
	let terminalEmptyStreak = 0;
	// 文本搜索连击（executor:3395-3430）：结构工具清零；软上限提醒一次；硬上限强制收尾轮
	let textSearchStreak = 0;
	let textSearchSoftSent = false;
	let forcedWrapUpText: string | undefined;
	// argument_churn（executor:3110-3135）：同工具参数各异连击 ≥5 ⇒ 提醒（每段连击只提醒一次）
	let churnReminded = false;
	// 单只读工具连击（executor:3211-3240）：每轮「只请求 1 个并行安全只读工具」连击 ≥4 ⇒
	// 批量并行引导提醒一次（交付走 pendingReminders —— 该轮的工具**被执行**，afterToolCall 可达）
	const MAX_SINGLE_TOOL_STREAK = 4; // executor:1014 的局部常量对齐
	let singleToolStreak = 0;
	let singleToolStreakNames: string[] = [];
	// 全批拦截连击（executor:2980-3031）：一轮全部调用被护栏拦 ⇒ 三档升级
	// （① 仅回填错误结果 ② ≥2 强提醒一次 ③ ≥4 强制收尾轮）。
	// ⚠ 被拦调用走 piLoop 'immediate' 路径、**不过 afterToolCall** ⇒ 提醒不能走
	// pendingReminders（无人投递），改为在 shouldStopAfterTurn 直写 transcript
	// （legacy 同款：system-reminder 直接 appendMessages）。
	let allBlockedStreak = 0;
	let allBlockedReminderSent = false;
	let roundAttemptedCalls = 0;
	let roundAttemptedNames: string[] = [];
	let roundBlockedIds = new Set<string>();
	// 子代理软预算（turnIterationGate:256-268）：wall-clock 超 softDeadlineMs ⇒ 注入
	// 「立即整理发现并收尾」提醒，超阈值后每 60s 重提（模型会无视首次提醒继续空转的实证）。
	// 墙钟锚在工厂创建时刻（= runPiKernelTurn 起点，对齐 legacy `_turnStartedAt` 语义：
	// 刻意不收口进 runState，跨 turn 恢复会节流失效）。
	const turnStartedAt = Date.now();
	const softDeadlineMs = opts?.softDeadlineMs && opts.softDeadlineMs > 0 ? opts.softDeadlineMs : undefined;
	let softBudgetNextReminderAtMs = 0;
	// executor 的显式配置逐字复刻（agentTurnExecutor.ts 护栏声明处）：
	// 「只让 no_progress 触发 block」，exact/same_tool 的 block 关闭（由 detectToolCallLoop/
	// MAX_CONSECUTIVE 分工承担）；halt 阈值 8（同名失败，Hermes 对齐）。
	const guardrail = new ToolGuardrailController({
		warningsEnabled: true,
		hardStopEnabled: true,
		exactFailureWarnAfter: 2,
		exactFailureBlockAfter: 5,
		sameToolFailureWarnAfter: 3,
		sameToolFailureHaltAfter: 8,
		noProgressWarnAfter: 2,
		noProgressBlockAfter: 2,
	});
	let halted = false;
	return {
		beforeToolCall: ({ toolCall, args }) => {
			// 子代理软预算提醒（turnIterationGate:256-268）：超预算 ⇒ 周期性注入收尾引导
			// （不打断执行；投递走 pendingReminders ⇒ 随本批工具结果送达，模型停手则不注入）。
			if (softDeadlineMs !== undefined) {
				const elapsedMs = Date.now() - turnStartedAt;
				if (elapsedMs >= softDeadlineMs && elapsedMs >= softBudgetNextReminderAtMs) {
					softBudgetNextReminderAtMs = elapsedMs + 60_000;
					host._logService.warn(`[PiKernel] Soft budget exceeded (${Math.round(elapsedMs / 1000)}s >= ${Math.round(softDeadlineMs / 1000)}s) — injecting wrap-up guidance`);
					pendingReminders.push(softBudgetWrapUpReminder(Math.round(elapsedMs / 1000), Math.round(softDeadlineMs / 1000)));
				}
			}
			const name = toolCall.name;
			const safeArgs = args ?? {};
			const pp = detectToolCallPingPong(history);
			const verdict = classifyPingPong(pp.pingPong, pp.noProgressEvidence);
			if (verdict.kind === 'block-batch') {
				host._logService.warn(
					`[PiKernel] Ping-pong loop: ${pp.toolA} <-> ${pp.toolB} ` +
					`(${pp.length} alternating calls, stable results both sides) — blocking`,
				);
				roundBlockedIds.add(toolCall.id);
				return {
					kind: 'blocked',
					reason: `Blocked: ping-pong loop between "${pp.toolA}" and "${pp.toolB}" (${pp.length} alternating calls) with identical results on both sides. Switching between these two calls is making no progress — the information you need is not here. Use a different tool or a different approach, or proceed with the results you already have.`,
				};
			}
			// no-progress 护栏（executor:2902-2916）：只采纳 idempotent_no_progress_block；
			// 被它拦的调用**不进**循环检测历史（legacy 在 2904 先于 2918 的记录返回 false，同序）。
			const before = guardrail.beforeCall(name, safeArgs);
			if (before.action === 'block') {
				if (before.code === 'idempotent_no_progress_block') {
					host._logService.warn(
						`[PiKernel] Guardrail no-progress block: "${name}" returned identical result ` +
						`${before.count} times with identical args — blocking`,
					);
					roundBlockedIds.add(toolCall.id);
					return { kind: 'blocked', reason: before.message };
				}
				// 其余 block 类型理论上不可达（配置已关闭）。记录后放行，宁可放过也不误伤。
				host._logService.warn(`[PiKernel] Guardrail unexpected block code=${before.code} — allowing`);
			}
			// 与 legacy 同序：先判定（历史不含本次），再无条件记录（executor:2917/2925）
			const { loop, count } = detectToolCallLoop(history, name, safeArgs);
			history.push({ name, argsHash: canonicalToolArgsHash(safeArgs) });
			if (loop) {
				host._logService.warn(`[PiKernel] Tool call loop detected: "${name}" called ${count} times with same args — blocking`);
				roundBlockedIds.add(toolCall.id);
				return { kind: 'blocked', reason: buildLoopBlockFeedback(name, JSON.stringify(safeArgs)) };
			}
			return { kind: 'allow' };
		},
		afterToolCall: ({ toolCall, args, result, isError }) => {
			const text = toolResultToText((result as { content?: unknown }).content);
			// 回填 resultHash（对齐 RECORD_TOOL_RESULT；ping-pong 的 noProgressEvidence 依赖它）
			for (let i = history.length - 1; i >= 0; i--) {
				const entry = history[i]!;
				if (entry.name === toolCall.name && entry.resultHash === undefined) {
					history[i] = { ...entry, resultHash: hashToolResult(text) };
					break;
				}
			}
			// 护栏结果登记（executor:3494）：失败计数/no-progress 结果哈希都在这里喂
			const after = guardrail.afterCall(toolCall.name, args ?? {}, text, { failed: isError });
			if (after.action === 'halt') {
				halted = true;
				host._logService.warn(`[PiKernel] Guardrail halt: ${after.message}`);
			} else if (after.action === 'warn') {
				host._logService.warn(`[PiKernel] Guardrail warn: ${after.message}`);
			}
			// 连续失败熔断（executor:3352-3363）：同名工具失败计数（任一成功清零）≥3 ⇒ 排提醒
			if (isError) {
				const n = (consecutiveFailures.get(toolCall.name) ?? 0) + 1;
				consecutiveFailures.set(toolCall.name, n);
				if (n >= MAX_CONSECUTIVE_TOOL_FAILURES) {
					host._logService.warn(`[PiKernel] consecutiveFail ${n}/${MAX_CONSECUTIVE_TOOL_FAILURES} FIRED tool=${toolCall.name}`);
					pendingReminders.push(toolConsecutiveFailureReminder(toolCall.name, MAX_CONSECUTIVE_TOOL_FAILURES));
				}
			} else {
				consecutiveFailures.clear();
				// terminal 空输出连击（executor:3365-3385）：'(no output)'/空 ⇒ 计数（exit 0 不走失败追踪）
				if (toolCall.name === 'terminal') {
					const t = text.trim();
					if (t === '' || t === '(no output)') {
						terminalEmptyStreak++;
						if (terminalEmptyStreak >= MAX_TERMINAL_EMPTY) {
							host._logService.warn(`[PiKernel] terminalEmptyOutput ${terminalEmptyStreak}/${MAX_TERMINAL_EMPTY} FIRED`);
							pendingReminders.push(terminalEmptyOutputReminder());
						}
					} else {
						terminalEmptyStreak = 0;
					}
				}
			}
			// 文本搜索连击（executor:3395-3430）：结构工具一用即清零；软上限提醒一次；硬上限强制收尾轮
			if (STRUCTURAL_SEARCH_TOOL_NAMES.has(toolCall.name)) {
				textSearchStreak = 0;
				textSearchSoftSent = false;
			} else if (TEXT_SEARCH_TOOL_NAMES.has(toolCall.name)) {
				textSearchStreak++;
				if (textSearchStreak >= MAX_TEXT_SEARCH_STREAK_HARD) {
					host._logService.warn(`[PiKernel] textSearchStreak ${textSearchStreak}/${MAX_TEXT_SEARCH_STREAK_HARD} FIRED — forcing wrap-up round`);
					forcedWrapUpText = textSearchLoopWrapUpReminder(textSearchStreak);
					textSearchStreak = 0;
				} else if (textSearchStreak >= MAX_TEXT_SEARCH_STREAK && !textSearchSoftSent) {
					const structural = enabledTools.filter(t => STRUCTURAL_SEARCH_TOOL_NAMES.has(t.name)).map(t => t.name);
					host._logService.warn(`[PiKernel] textSearchStreak ${textSearchStreak}/${MAX_TEXT_SEARCH_STREAK} FIRED (structural: ${structural.join(', ') || '(none)'})`);
					pendingReminders.push(structural.length > 0
						? preferGraphSearchReminder(textSearchStreak, structural.join(', '))
						: stopSearchingReportReminder(textSearchStreak));
					textSearchSoftSent = true;
				}
			}
			// argument_churn（executor:3110-3135）：同工具、参数各异、连击 ≥5 ⇒ 提醒；
			// 多目标工具（file_read 等多文件场景）只留痕不注入；每段连击只提醒一次。
			const churn = detectArgumentChurn(history);
			if (churn.churn) {
				const churnTool = churn.toolName ?? 'tool';
				if (isMultiTargetChurnTool(churnTool)) {
					host._logService.info(`[PiKernel][Diag] Argument churn (multi-target, suppressed): "${churnTool}" ×${churn.length} with ${churn.distinctArgs} distinct args`);
				} else if (!churnReminded) {
					churnReminded = true;
					host._logService.warn(`[PiKernel] Argument churn: "${churnTool}" ×${churn.length} with ${churn.distinctArgs} distinct args — injecting recovery guidance`);
					pendingReminders.push(argumentChurnReminder(churnTool, churn.length));
				}
			} else {
				churnReminded = false;
			}
			// 延迟提醒投递：追加进本结果的文本尾部（见 pendingReminders 声明处注释）
			if (pendingReminders.length > 0) {
				const extra = pendingReminders.splice(0).join('\n\n');
				const content = (result as { content?: unknown }).content;
				const appended = Array.isArray(content)
					? [...content, { type: 'text', text: '\n\n' + extra }]
					: [{ type: 'text', text: text + '\n\n' + extra }];
				return { kind: 'replace', result: { ...(result as object), content: appended } as typeof result, isError };
			}
			return { kind: 'keep' };
		},
		// halt ⇒ 本轮跑完后退出主循环（legacy「halt 退出主循环」语义；本轮同批剩余工具已执行完）
		// + 全批拦截连击（executor:2980-3031）：本轮所有调用都被拦 ⇒ 三档升级
		// （① 仅回填错误结果 ② ≥2 强提醒直写 transcript ③ ≥4 强制收尾轮经 requestWrapUp）。
		shouldStopAfterTurn: (ctx) => {
			if (roundAttemptedCalls > 0) {
				if (roundBlockedIds.size >= roundAttemptedCalls) {
					allBlockedStreak++;
					host._logService.warn(`[PiKernel] All ${roundAttemptedCalls} tool calls blocked (consecutive zero-progress turns: ${allBlockedStreak})`);
					const verdict = classifyAllBlockedStreak(allBlockedStreak, allBlockedReminderSent, { reminderAfter: ALL_BLOCKED_ESCALATE_AT, wrapUpAfter: ALL_BLOCKED_WRAPUP_AT });
					if (verdict.decision.kind === 'wrap-up') {
						host._logService.warn(`[PiKernel] Zero-progress streak hit ${allBlockedStreak} — forcing wrap-up round (tools disabled)`);
						forcedWrapUpText = allBlockedWrapUpReminder(allBlockedStreak);
					} else if (verdict.reminders.includes('all-blocked-strong')) {
						allBlockedReminderSent = true;
						// 被拦调用走 immediate 路径、不过 afterToolCall ⇒ pendingReminders 无人投递，
						// 直写 transcript（legacy 同款：appendMessages system-reminder；user 角色携带，
						// 与 steering/nudge 的既定通道一致）。
						(ctx.messages as AgentMessage[]).push({
							role: 'user',
							content: allToolCallsBlockedReminder(allBlockedStreak, roundAttemptedNames.join(', ')),
							timestamp: Date.now(),
						} as AgentMessage);
					}
				} else {
					// 有工具真正执行 → 零进展连击清零（legacy 同姿态）
					allBlockedStreak = 0;
					allBlockedReminderSent = false;
				}
			}
			return halted;
		},
		// reasonStreak（executor:3088-3106）：仅工具轮评估；先判定（历史不含本轮，刻意滞后一轮）
		// 再记录本轮 —— 与 legacy「streakKey 来自上一轮已落库的 history」同序。不阻断，只排提醒。
		onAssistantMessageEnd: (message) => {
			const toolCalls = message.content.filter(b => (b as { type?: string }).type === 'toolCall');
			if (toolCalls.length === 0) { return; }
			// ── 轮边界记账（全批拦截连击 + 单工具连击的输入）────────────────
			roundAttemptedCalls = toolCalls.length;
			roundAttemptedNames = toolCalls.map(tc => (tc as { name?: string }).name ?? '');
			roundBlockedIds = new Set();
			// 单只读工具连击（executor:3211-3240）：本轮只请求 1 个并行安全只读工具 ⇒ 连击
			const soleName = toolCalls.length === 1 ? (toolCalls[0] as { name?: string }).name : undefined;
			const isSingleReadOnly = !!soleName && isParallelSafeReadOnlyTool(soleName);
			const adv = advanceSingleToolStreak(singleToolStreak, isSingleReadOnly, MAX_SINGLE_TOOL_STREAK);
			singleToolStreak = adv.streak;
			if (isSingleReadOnly && soleName) {
				if (!singleToolStreakNames.includes(soleName)) { singleToolStreakNames.push(soleName); }
			} else {
				singleToolStreakNames = [];
			}
			if (adv.shouldGuide) {
				host._logService.warn(`[PiKernel] single read-only tool streak ${singleToolStreak} — injecting batch-parallel guidance (tools: ${singleToolStreakNames.join(', ')})`);
				pendingReminders.push(batchReadOnlyToolsReminder(singleToolStreak, singleToolStreakNames.join(', ')));
			}
			let thinking = '';
			for (const b of message.content) {
				if ((b as { type?: string }).type === 'thinking') {
					thinking += ((b as { thinking?: string }).thinking ?? '') + '\n';
				}
			}
			const streak = detectReasonStreak(streakHistory, REASON_STREAK_TRIGGER_COUNT);
			if (streak >= REASON_STREAK_TRIGGER_COUNT) {
				host._logService.warn(`[PiKernel] Reasoning streak: identical thinking for ${streak} consecutive rounds — injecting recovery guidance`);
				pendingReminders.push(reasonStreakReminder(streak));
			}
			streakHistory.push(computeStreakKey({
				reasoning: thinking,
				toolCalls: toolCalls.map(tc => {
					const t = tc as { name?: string; arguments?: unknown };
					// ⚠ pi-ai 的 AgentToolCall.arguments 是**对象**（非 JSON 字符串）——
					// 只按 string 解析会全部落成 {} ⇒ 所有轮 argsHash 相同 ⇒ reasonStreak 误报。
					let parsed: Record<string, unknown> = {};
					if (typeof t.arguments === 'string') {
						try { parsed = JSON.parse(t.arguments) as Record<string, unknown>; } catch { /* */ }
					} else if (t.arguments && typeof t.arguments === 'object') {
						parsed = t.arguments as Record<string, unknown>;
					}
					return { name: t.name ?? '', argsHash: canonicalToolArgsHash(parsed) };
				}),
			}));
		},
		// 一次性消费（runLoop 的 wrapUpDone 已保证单发；这里自清避免悬挂请求）
		requestWrapUp: () => { const t = forcedWrapUpText; forcedWrapUpText = undefined; return t; },
	};
}
