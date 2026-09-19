/*---------------------------------------------------------------------------------------------
 *  每轮迭代末尾的后处理段 —— 由 `agentTurnExecutor.ts` 迁出（2026-09-17 Part 化期 3）。
 *
 *  执行顺序（与迁出前逐行等价）：
 *    delegation ledger 更新 → after_tool hook → orphan tool reconcile →
 *    批次停止裁决（无效工具名 / 全批 terminate / clarify）→ codebase 操作事件 →
 *    per-iteration memory capture → budget consume → checkpoint 持久化。
 *
 *  返回 'done' 表示本 turn 应提前结束；undefined 表示继续下一轮。
 *--------------------------------------------------------------------------------------------*/

import { findClarifySignal } from '../../common/turnSignals.js';
import { classifyBatchStop, isWholeBatchTerminate } from '../../common/turnStopGate.js';
import {
	limitToolResultSize,
	safeStringifyToolResult,
	MAX_INVALID_TOOL_RETRIES,
} from '../toolCallUtils.js';
import { sanitizeToolResultText } from '../../common/assistantVisibleText.js';
import type { IChatStreamDelta } from '../../common/providers.js';
import type { AgentAction, AgentRunState, AgentRunStateSnapshot } from '../../common/agentRunState.js';
import type { AgentRunMessage } from '../../common/agentRunState.js';
import type { BudgetSnapshot } from '../../common/iterationBudget.js';
import type { AgentParadigm } from '../../common/agentLoopStrategy.js';

/**
 * codebase-memory 系列工具 → 前端系统消息面板展示用的操作分类。
 * 迁出前为函数内联字面量，语义不变。
 */
const CODEBASE_OPERATION_BY_TOOL: Record<string, string> = {
	index_repository: 'index',
	search_graph: 'graph',
	search_code: 'search',
	trace_path: 'trace',
	get_architecture: 'graph',
	detect_changes: 'changes',
	list_projects: 'index',
	get_code_snippet: 'search',
	index_status: 'index',
};

/** 触发 codebase_operation 事件的工具名特征。 */
const CODEBASE_TOOL_NAME_MARKERS: readonly string[] = [
	'codebase',
	'index_repository',
	'search_graph',
	'search_code',
	'trace_path',
	'get_architecture',
	'detect_changes',
	'list_projects',
];

/** 单条 memory observe 内容的截断上限（迁出前为内联 2000）。 */
const OBSERVE_CONTENT_MAX_CHARS = 2000;

/** checkpoint 落盘频率：每 N 轮一次（迁出前为内联 `iteration % 3 === 0`）。 */
const CHECKPOINT_PERSIST_INTERVAL = 3;

/** 宿主能力的窄接口 —— 只声明本段实际调用的成员，便于测试 stub。 */
export interface IPostIterationHost {
	readonly _logService: {
		info(message: string): void;
		warn(message: string): void;
	};
	readonly _subagentLimitMw: {
		isDelegationCall(toolCall: unknown): boolean;
	};
	readonly _delegationLedger: {
		markCompleted(toolCallId: string, resultText: string): void;
		markFailed(toolCallId: string, resultText: string): void;
		getAllEntries(): unknown[];
	};
	readonly _durableContext: {
		updateFromLedger(entries: unknown[]): void;
	};
	getActiveMemoryProvider(): IPostIterationMemoryProvider | undefined;
}

/** memory provider 的窄接口（observe 为可选能力）。 */
export interface IPostIterationMemoryProvider {
	observe?(agentId: string, payload: {
		sessionId: string;
		hookType: string;
		timestamp: string;
		data: Record<string, unknown>;
	}): Promise<unknown>;
}

/** hook 总线的窄接口。 */
export interface IPostIterationHookBus {
	has(hookName: string): boolean;
	runWithGate(hookName: string, payload: Record<string, unknown>): Promise<{ terminate?: boolean } | undefined>;
}

/** 迭代预算的窄接口。 */
export interface IPostIterationBudget {
	consume(count: number): void;
	refund(count: number): void;
	snapshot(): BudgetSnapshot;
}

/**
 * 长生命周期依赖（跨迭代不变的宿主、总线、请求上下文与共用纯函数）。
 *
 * `buildCheckpointSnapshot` 经 deps 注入而非直接 import：它的真源在
 * `agentTurnExecutor.ts`，Part 反向 import 会形成循环依赖。
 */
export interface IPostIterationDeps {
	readonly host: IPostIterationHost;
	readonly hookBus: IPostIterationHookBus;
	readonly request: {
		readonly agentId: string;
		readonly sessionId?: string;
		readonly checkpointSink?: (snapshot: AgentRunStateSnapshot) => void | Promise<void>;
	};
	readonly budget: IPostIterationBudget;
	readonly strategy: { takeDelegationRound?(): boolean } | undefined;
	readonly resolvedParadigm: AgentParadigm;
	readonly buildCheckpointSnapshot: (
		runState: AgentRunState,
		budgetSnapshot: BudgetSnapshot,
		messages: AgentRunMessage[],
		paradigm: AgentParadigm,
		iteration: number,
	) => AgentRunStateSnapshot;
}

/**
 * 可变状态桥接 —— `messages` / `runState` 在主循环中会被重新绑定，
 * 故经 getter/setter 访问而非值快照。
 */
export interface IPostIterationState {
	messages(): unknown[];
	runState(): AgentRunState;
	dispatchRunState(action: AgentAction): void;
}

/** 本段所需的单轮局部输入。 */
export interface IPostIterationInput {
	readonly toolResults: Array<{
		toolCallId: string;
		success: boolean;
		content: unknown;
	}>;
	readonly localExecutedCalls: Array<{ id: string; name: string }>;
	readonly effectiveToolCalls: Array<{ name: string; arguments: unknown }>;
	readonly startedToolIds: Set<string>;
	readonly endedToolIds: Set<string>;
	readonly trimmedAssistantContent: string;
	readonly iteration: number;
}

/**
 * 把工具结果归一化为可写入 ledger 的文本。
 * 迁出前为内联三元链，语义逐字保持。
 */
function extractResultText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	const record = content as { text?: string; error?: string } | null | undefined;
	if (record?.text !== undefined) {
		return record.text;
	}
	if (record?.error) {
		return `Error: ${record.error}`;
	}
	return JSON.stringify(content ?? '');
}

/** 解析工具入参为前端展示用的摘要串（单值超 100 字符截断）。 */
function summarizeToolArguments(rawArguments: unknown): string {
	try {
		const parsed = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
		if (!parsed) {
			return '';
		}
		const parts: string[] = [];
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			const valueText = typeof value === 'string' ? value : JSON.stringify(value);
			parts.push(`${key}: ${valueText.length > 100 ? valueText.slice(0, 100) + '...' : valueText}`);
		}
		return parts.join(', ');
	} catch {
		return '';
	}
}

/** 该工具名是否应触发 codebase_operation 事件。 */
function isCodebaseTool(toolName: string): boolean {
	return CODEBASE_TOOL_NAME_MARKERS.some(marker => toolName.includes(marker));
}

/** 工具名 → 操作分类（首个命中的键胜出，与迁出前的 for-break 一致）。 */
function resolveCodebaseOperation(toolName: string): string {
	for (const [key, operation] of Object.entries(CODEBASE_OPERATION_BY_TOOL)) {
		if (toolName.includes(key)) {
			return operation;
		}
	}
	return 'search';
}

/**
 * 每轮迭代末尾的后处理。
 *
 * @returns 'done' 表示应提前结束本 turn；undefined 表示继续。
 */
export async function* runPostIterationCleanup(
	deps: IPostIterationDeps,
	state: IPostIterationState,
	input: IPostIterationInput,
): AsyncGenerator<IChatStreamDelta, 'done' | undefined> {
	const { host, hookBus, request, budget, strategy, resolvedParadigm } = deps;
	const {
		toolResults,
		localExecutedCalls,
		effectiveToolCalls,
		startedToolIds,
		endedToolIds,
		trimmedAssistantContent,
		iteration,
	} = input;

	// ─── Update Delegation Ledger with tool results（借鉴 deer-flow）──────
	for (const toolResult of toolResults) {
		const toolCall = localExecutedCalls.find(call => call.id === toolResult.toolCallId);
		if (!toolCall || !host._subagentLimitMw.isDelegationCall(toolCall)) {
			continue;
		}

		const resultText = extractResultText(toolResult.content);
		if (toolResult.success) {
			host._delegationLedger.markCompleted(toolCall.id, resultText);
		} else {
			host._delegationLedger.markFailed(toolCall.id, resultText);
		}
	}

	// Persist updated ledger into durable context so it survives
	// summarization compression on the next round.
	host._durableContext.updateFromLedger(host._delegationLedger.getAllEntries());

	// ── Hook: after_tool（经总线分发；provider 的 post_tool_use /
	//    post_tool_failure 由 turnHookWiring 按 isError 二选一转发）────
	// after_tool 是 best-effort：handler 抛错只上报，不打断本轮清理。
	if (hookBus.has('after_tool')) {
		for (const toolResult of toolResults) {
			const toolCall = localExecutedCalls.find(call => call.id === toolResult.toolCallId);
			const afterToolResult = await hookBus.runWithGate('after_tool', {
				toolCallId: toolResult.toolCallId,
				toolName: toolCall?.name ?? '',
				content: toolResult.content,
				isError: !toolResult.success,
			});
			// terminate 是单调信号（任一 handler 置真即整批终止）。当前无 handler
			// 会返回它，但不能静默丢弃 —— 否则将来接入 TaskGate 类 handler 时，
			// 「要求终止」会变成无声无息的空操作。
			if (afterToolResult?.terminate === true) {
				host._logService.info('[AgentOS] after_tool hook requested batch termination');
				return 'done';
			}
		}
	}

	// ─── Reconcile: emit synthetic tool_end for any orphaned tool_start ──
	// IDs that received tool_start but never tool_end (lost via dedup,
	// phantom filter, missing provider, or any other early-return path)
	// must be terminated, otherwise their webview tool cards will spin
	// forever. We emit success=false so users can see they did not run.
	for (const orphanId of startedToolIds) {
		if (endedToolIds.has(orphanId)) {
			continue;
		}
		host._logService.warn(
			`[AgentOS] Orphaned tool_start without tool_end: ${orphanId} — emitting synthetic tool_result + tool_end (success=false)`
		);
		const orphanResultStr = sanitizeToolResultText(
			limitToolResultSize(safeStringifyToolResult({ note: '工具未执行（可能已被过滤、去重或无匹配的 provider）' }))
		);
		yield {
			type: 'tool_result',
			content: orphanResultStr,
			toolCallId: orphanId,
		} as IChatStreamDelta;
		yield {
			type: 'tool_end',
			toolCallId: orphanId,
			success: false,
		} as IChatStreamDelta;
		endedToolIds.add(orphanId);
	}

	// ─── 批次停止裁决（decision point 2）───────────────────────────────
	// 三条判据（全批工具名不存在 / 全批 terminate / clarify）已收口到
	// `common/turnStopGate.ts` 的 `classifyBatchStop`，语义由
	// `test/common/turnStopGate.test.ts` 锁定（每条 every/some 均有用例）。
	// 此处只保留三件副作用：reducer 递增、日志、yield done —— 裁决本身不产生
	// 副作用，故可单测；副作用留在这里，故可观测。
	//
	// ⚠ `failedCount === toolResults.length` 前置条件**必须**保留在裁决之外：
	// `isAllInvalidToolName` 只检查结果文本含 `does not exist` / `not available`，
	// 而**成功**工具完全可能正常返回这类文本（例如 file_read 读到一段讨论
	// 「工具不存在」的注释，或 search 报告某符号 not available）。少了这个
	// 前置，那种批次会被误计为无效工具名重试，最终误停 turn。
	const failedCount = toolResults.filter(result => !result.success).length;
	const allToolsFailed = toolResults.length > 0 && failedCount === toolResults.length;

	const batchStop = classifyBatchStop(
		{
			// 仅在「全批失败」时才把结果交给无效工具名判据（见上方前置条件说明）。
			// 传空数组会让 classifyBatchStop 直接返回 continue，因此
			// terminate / clarify 两条判据必须在下方用完整批次单独跑。
			toolResults: (allToolsFailed ? toolResults : []) as never,
			resolveToolName: (id: string) => localExecutedCalls.find(call => call.id === id)?.name,
			invalidToolNameCount: state.runState().invalidToolNameCount,
		},
		{ maxInvalidToolRetries: MAX_INVALID_TOOL_RETRIES },
	);
	if (batchStop.shouldCountInvalidToolName) {
		state.dispatchRunState({ type: 'INVALID_TOOL_NAME' });
	}
	// ⚠ 只消费 `invalid-tool-name-retries` 这一个 reason，**不可**写成
	// `if (decision.kind === 'stop')`：本调用传入的批次已被 `allToolsFailed`
	// 前置过滤，但「全批失败」与「全批 terminate」/「含 clarify」可以同时成立，
	// 此时 `classifyBatchStop` 会先返回 terminate / clarify 的 reason。若在这里
	// 一律当无效工具名处理，clarify 就会跳过下方的 `SET_PHASE idle` +
	// `phase_change`（UI 依赖它读终态），terminate 也会打错日志。
	// 那两条判据各自的分支在下方保持原样，由它们负责。
	if (
		batchStop.decision.kind === 'stop'
		&& batchStop.decision.reason === 'invalid-tool-name-retries'
	) {
		host._logService.warn(
			`[AgentOS] Too many invalid tool name attempts (${state.runState().invalidToolNameCount}), ending loop`
		);
		yield { type: 'done' } as IChatStreamDelta;
		return 'done';
	}

	// ─── shouldTerminateToolBatch（借鉴 OpenClaw）──────────────
	// 所有工具返回 terminate=true 时提前结束 agent loop。
	// 当前 Saros 的 IToolResult 没有 terminate 字段，但预留接口
	// 为将来扩展（如 "任务已完成" 信号工具）做准备。
	// 判据见 turnStopGate.isWholeBatchTerminate（`every` + 空批次前置）。
	if (isWholeBatchTerminate(toolResults as never)) {
		host._logService.info(
			`[AgentOS] All ${toolResults.length} tool results signaled terminate — ending loop early`
		);
		yield { type: 'done' } as IChatStreamDelta;
		return 'done';
	}

	// ─── clarify 信号：问题已抛给用户，必须结束 turn 等回答 ──────────
	// P0（2026-08-21，日志 1787289570191）：`clarify` 的闭环此前**只有两端**——
	// 工具注册（coreTools.ts）+ UI 澄清卡片（agentChatPanel.toolCards.ts，
	// 提交后经 onClarifySubmit → _sendMessageInternal 作为新消息开启下一 turn），
	// 而 agent loop 对 clarify 零引用 → 模型提问后 loop 继续跑，但用户回答
	// 尚未到达，模型只能空转：该日志 14 轮里 5 轮（36%）纯浪费，最后模型
	// 自救 "I'll stop here rather than loop on..."。
	//
	// ⚠ 用 `some`（findClarifySignal 命中即终止）而非上面 terminate 的 `every`：
	// 问题一旦渲染，本 turn 已失去继续意义 —— 同批次其他工具结果模型也用不上。
	// 要求"全部工具都 terminate"会让 `clarify + file_read` 混合批次继续空转，
	// 正是本次事故形态。
	//
	// 终止方式与「无工具调用」路径一致（yield done + return 'done'）：turn 正常
	// 收尾，用户看到澄清卡片，回答后自然开启新 turn。不用 abort/error ——
	// 这是**预期内**的协作暂停，不是异常。
	if (toolResults.length > 0) {
		const clarifySignal = findClarifySignal(
			toolResults as never,
			(id: string) => localExecutedCalls.find(call => call.id === id)?.name,
		);
		if (clarifySignal) {
			host._logService.info(
				`[AgentOS] clarify signal detected (toolCallId=${clarifySignal.toolCallId}, ` +
				`questions=${clarifySignal.questionCount}) — ending turn to await the user's answer`
			);
			// 与结束路径对齐：显式置 idle，供 checkpoint / UI 读取正确终态
			state.dispatchRunState({ type: 'SET_PHASE', phase: 'idle' });
			yield { type: 'phase_change', phase: state.runState().phase } as IChatStreamDelta;
			yield { type: 'done' } as IChatStreamDelta;
			return 'done';
		}
	}

	// ─── codebase memory 工具调用检测 ──────────────────────────────────
	// 当 LLM 调用 codebase-memory MCP 工具时，yield codebase_operation 事件
	// 供前端系统消息面板显示
	for (const toolCall of effectiveToolCalls) {
		if (!isCodebaseTool(toolCall.name)) {
			continue;
		}
		yield {
			type: 'codebase_operation',
			content: toolCall.name,
			metadata: {
				operation: resolveCodebaseOperation(toolCall.name),
				toolName: toolCall.name,
				args: summarizeToolArguments(toolCall.arguments),
			},
		} as unknown as IChatStreamDelta;
	}

	// ─── per-iteration memory capture（W1，2026-07-26 §16 日志实证修复）───
	// 此前每迭代 writeMemory(type=working) 直写长期层：子代理 40+ 迭代即
	// 洪泛 40+ 条过程性内容进 core memory（§11 分层改造的漏网通道）。
	// 改道 observe 会话暂存层（mem:obs，便宜 KV set + 滑动窗口 + 阈值压缩）——
	// 保留中断安全的增量捕获，不再污染长期层；assistant 消息本体由
	// storeTurnObservations 在 turn 边界捕获（含去重）。同时删除每迭代的
	// 「Working 写入中」噪音 UI 卡片。
	const memoryProvider = host.getActiveMemoryProvider();
	if (memoryProvider && (trimmedAssistantContent || toolResults.length > 0)) {
		const iterationContent = (trimmedAssistantContent || 'Tool execution completed')
			+ (toolResults.length > 0
				? ` [工具: ${effectiveToolCalls.map(call => call.name).join(', ')}]`
				: '');
		void memoryProvider.observe?.(request.agentId, {
			sessionId: request.sessionId || '',
			hookType: 'turn_observation',
			timestamp: new Date().toISOString(),
			data: {
				content: iterationContent.slice(0, OBSERVE_CONTENT_MAX_CHARS),
				role: 'assistant',
				toolCalls: effectiveToolCalls.length,
				toolResults: toolResults.length,
				iteration,
			},
		}).catch(() => { /* fire-and-forget */ });
	}

	// ─── 预算消耗（Hermes 范式：每轮 consume；委托轮 refund 不耗父预算）──
	if (strategy?.takeDelegationRound?.()) {
		budget.refund(1);
	} else {
		budget.consume(1);
	}

	// ─── V3: 每轮持久化 checkpoint（单 agent 断点续跑）──
	// 在 budget consume 后立即落盘，确保中断恢复时 budget 状态为最新。
	// checkpointSink 由 agentDriverService 注入（workspace storage），异步 fire-and-forget 不阻塞循环。
	if (request.checkpointSink && iteration % CHECKPOINT_PERSIST_INTERVAL === 0) {
		try {
			// 归约链见 buildCheckpointSnapshot（纯函数，已被单测覆盖）。
			// iteration 由 while 维护、不进 runState —— 这是**有意豁免**（非遗漏）：
			// 它对齐 LangGraph 的 step 语义，属 graph runtime 步进计数器，不是 state schema 的一部分。
			// 持久化走显式透传、恢复走 `restored.iteration`，名字与字段始终一致。
			// ⚠ 不要"顺手收口"它：74 处使用点、零行为收益，且极易重蹈 loopMessages 那种
			//   「调用点改了、字段没改」的隐蔽分叉。
			const snapshot = deps.buildCheckpointSnapshot(
				state.runState(),
				budget.snapshot(),
				state.messages() as AgentRunMessage[],
				resolvedParadigm,
				iteration,
			);
			void (async () => {
				try {
					await request.checkpointSink!(snapshot);
				} catch (checkpointError) {
					host._logService.warn('' + (checkpointError instanceof Error ? checkpointError.message : checkpointError));
				}
			})();
		} catch (snapshotError) {
			host._logService.warn(
				'[AgentOS] Checkpoint snapshot failed: '
				+ (snapshotError instanceof Error ? snapshotError.message : String(snapshotError))
			);
		}
	}
	return undefined;
}
