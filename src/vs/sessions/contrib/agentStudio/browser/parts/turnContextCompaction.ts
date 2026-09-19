/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 上下文压缩段 —— 每轮迭代开头把消息历史压到窗口以内。
 *
 * ## 四级阶梯
 *
 * 由轻到重，前一级省下的 token 让后一级可能整轮跳过：
 *   1. **廉价剪枝**（无 LLM、不丢消息）—— 截断/清除最近 N 条之外的旧 tool 输出
 *   2. **结果去重** —— 历史中内容完全相同的 tool 结果，更早那条换成引用标记
 *   3. **消息数硬上限** —— 超 60 条只挂 pending，优先让第 4 级消化
 *   4. **三段式压缩**（LLM 摘要 + checkpoint 重建兜底）
 *
 * ## KV 缓存门控是本段的核心纪律
 *
 * 前两级都**原地改写历史前缀**，会让已付费的 prompt cache 从改写点起整段失效。
 * 所以它们被 `pressure >= 2 || cacheCold` 门控：缓存还热且压力不高时，去重省下
 * 的 token 远不抵前缀失效的损失（实测尾段连续 4 次去重对应命中率 55%）。
 * 第 3 级的删头兜底额外带 rearm runway —— 自上次删头以来 token 增量须达
 * 20k，否则「长回 63 → 删到 61」会每轮滑动头部，前缀反复断链。
 *
 * ## force 参数
 *
 * 仅溢出恢复路径（HTTP 400 context overflow）使用。服务端 `maxInputTokens` 可能
 * 小于本地 `window × 0.3`，常规触发判定会误判为「无需压缩」而 skip，导致重试
 * 必然再次溢出。`force=true` 绕过阈值/消息数/冷却/防抖判定强制压缩。
 *
 * ## 迁出说明（期 2）
 *
 * 原为 `agentTurnExecutor.ts:1412-1878` 的内联闭包（~467 行），捕获
 * `messages` / `runState` / `loopState` / `enabledTools` / `compressionWindow` /
 * `contextManager` / `host` / `request`。迁出时把捕获显式化为 `deps` + `state`，
 * 行为逐行保持不变。
 *
 * @module agentStudio/parts/turnContextCompaction
 */

import type { IAgentTurnRequest, IChatStreamDelta, IToolDefinition } from '../../common/providers.js';
import type { AgentAction, AgentRunMessage, AgentRunState } from '../../common/agentRunState.js';
import { asGenerator } from '../../common/turnEmit.js';
import type { TurnEventSink } from '../../common/turnEmit.js';
import { compactMessages, stripSyntheticSidecars } from '../../common/agentRunState.js';
import { COMPRESSION_COOLDOWN_MS } from '../../common/turnLoopConstants.js';
import { ContextManager } from '../../common/contextManager.js';
import type { ChatMessage } from '../../common/types.js';
import type { ITurnPartLog } from '../../common/turnKernel/turnPartContext.js';

/** 消息数硬上限 —— 超过后挂 pending，优先交给三段式压缩消化。 */
const HARD_MAX_MESSAGES = 60;

/**
 * 删头兜底的 rearm runway（token）。
 *
 * 对齐 Hermes「等 prompt 长满一个 trigger 规模增量才允许下次裁剪」：约为压缩
 * 阈值的 1/3，杜绝逐轮头部滑动导致的前缀反复断链。
 */
const HARD_PRUNE_REARM_TOKENS = 20000;

/** 去重时保留的内容预览长度。 */
const MAX_TOOL_RESULT_SNIPPET = 200;

/** 压缩前后文本快照的长度上限（供详情编辑器 diff 显示）。 */
const MAX_SNAPSHOT_TEXT_LEN = 50000;

/** 值得去重的 tool 结果最小长度 —— 更短的省不下 token。 */
const MIN_DEDUP_CONTENT_LEN = 50;

/** 记忆注入预算：占已省 token 的比例、占窗口的比例、绝对上限。 */
const INJECT_BUDGET_SAVED_RATIO = 0.1;
const INJECT_BUDGET_MIN = 500;
const INJECT_BUDGET_WINDOW_RATIO = 0.05;
const INJECT_BUDGET_MAX = 2000;

/** 压缩节省率低于此值计为「无效压缩」（Dashboard 指标）。 */
const INEFFECTIVE_SAVING_RATIO = 0.1;

/** checkpoint 重建的触发水位 —— 压缩后仍占窗口 85% 以上。 */
const CHECKPOINT_PRESSURE_RATIO = 0.85;

/** 记忆提供方的最小形状（本段只用这三个成员）。 */
interface ICompactionMemoryProvider {
	onPreCompact?(
		agentId: string,
		sessionId: string,
		messages: Array<{ role: string; content: string; timestamp: number }>,
		budget: number,
	): unknown;
	writeMemory(agentId: string, entry: unknown): Promise<void>;
	recallFormatted?: unknown;
}

/**
 * 本段用到的 host 面。
 *
 * `_lastCompressionTime` / `_lastHardPruneBaselineTokens` / `_compression*` 是
 * **可写字段**：冷却期与 rearm 基线必须跨 turn 持久化，故直接写在 host 实例上
 * 而非经 state 回传。
 */
export interface IContextCompactionHost {
	_logService: ITurnPartLog;

	_estimateMessagesTokens(messages: readonly unknown[]): number;
	_turnKey(agentId: string, sessionId: string | undefined): string;
	_lastAssistantAtByAgent: Map<string, number>;

	/** 压缩冷却期基线（跨 turn 持久化）。 */
	_lastCompressionTime: number;
	/** 删头 rearm 基线（跨 turn 持久化）。 */
	_lastHardPruneBaselineTokens: number;

	_compressionCount: number;
	_compressionIneffectiveCount: number;
	_compressionBeforeTokens: number;
	_compressionAfterTokens: number;
	_scheduleSave(): void;

	_currentWorkspaceId: string | undefined;
	getActiveMemoryProvider(): ICompactionMemoryProvider | undefined;
	_retrieveCompactionContext(provider: ICompactionMemoryProvider, request: unknown): unknown;
}

/**
 * 压缩管理器的最小形状。
 *
 * `willAttemptCompression` 与 `compressContext` 共用同一判据（唯一真源），
 * 两处**必须传相同参数**，否则 UI 门控与实际压缩行为会漂移。
 */
export interface IContextCompactionManager {
	willAttemptCompression(
		messages: ReadonlyArray<ChatMessage>,
		reserved: undefined,
		compressionWindow: number,
		lastRealPromptTokens: number,
		toolsSchemaTokens: number | undefined,
		force: boolean | undefined,
	): boolean;

	compressContext(
		messages: ReadonlyArray<ChatMessage>,
		reserved: undefined,
		compressionWindow: number,
		lastRealPromptTokens: number,
		preCompactInject: unknown,
		retrieveContext: unknown,
		toolsSchemaTokens: number | undefined,
		force: boolean | undefined,
	): Promise<ICompressionResult>;

	compressCheckpoint(
		messages: ReadonlyArray<ChatMessage>,
		compressionWindow: number,
	): Promise<ICompressionResult>;
}

/** 压缩结果（`ContextManager` 返回形状的本段视图）。 */
interface ICompressionResult {
	originalMessageCount: number;
	compressedMessageCount: number;
	summary: string;
	compressedMessages: ReadonlyArray<ChatMessage>;
	metadata?: Record<string, unknown>;
}

/** 本段不变的依赖。 */
export interface IContextCompactionDeps {
	readonly host: IContextCompactionHost;
	readonly request: IAgentTurnRequest;
	readonly contextManager: IContextCompactionManager;
	/** 模型真实上下文窗口（token），压缩阈值的分母。 */
	readonly compressionWindow: number;
	/**
	 * 当前启用工具 —— 必须是 getter。
	 *
	 * 主循环每轮迭代都会重新收集工具（MCP 可能中途就绪），快照会让 schema
	 * token 估算停留在首轮口径，使压缩触发判定偏低。
	 */
	enabledTools(): ReadonlyArray<IToolDefinition>;

	/** 工具 schema token 粗估 —— 与请求发出点的诊断共用同一实现。 */
	readonly estimateToolsSchemaTokens: EstimateToolsSchemaTokens;
}

/** 本段读写的可变状态面。 */
export interface IContextCompactionState {
	messages(): AgentRunMessage[];
	setMessages(next: AgentRunMessage[]): void;
	/** 改写 messages 后必须调用，把 loopMessages 同步进 runState。 */
	syncMessages(): void;

	runState(): AgentRunState;
	dispatchRunState(action: AgentAction): void;

	/** 消息数超限标记 —— 第 3 级挂起、第 4 级消化或兜底删头。 */
	hardPrunePending(): boolean;
	setHardPrunePending(next: boolean): void;
}

/**
 * 工具 schema 的固定 token 开销粗估 —— 由主文件提供，**不在本段重新实现**。
 *
 * 压缩触发判定与请求发出点的 promptOverhead 诊断共用同一函数，另写一份必然
 * 漂移成两套口径。
 */
export type EstimateToolsSchemaTokens = (tools: ReadonlyArray<IToolDefinition>) => number;

/** 取消息的单块文本表示（压缩前后快照用）。 */
function formatMessageBlock(message: AgentRunMessage): string {
	const role = (message as { role?: string }).role ?? 'unknown';
	const rawContent = (message as { content?: unknown }).content;
	const text = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? '');
	return `[${role}] ${text.slice(0, 300)}`;
}

/** 顺序拼接直到预算耗尽 —— 压缩后消息少，无需头尾保留。 */
function formatMessagesSequential(messages: readonly AgentRunMessage[]): string {
	const blocks: string[] = [];
	let totalLength = 0;
	for (const message of messages) {
		const block = formatMessageBlock(message);
		if (totalLength + block.length + 2 > MAX_SNAPSHOT_TEXT_LEN && blocks.length > 0) {
			break;
		}
		blocks.push(block);
		totalLength += block.length + 2;
	}
	return blocks.join('\n\n');
}

/**
 * 头尾保留 + 中间截断。
 *
 * 压缩前可能有 400+ 条消息。从头截断会丢掉尾部，使 `_computeStructuredDiff`
 * 的公共后缀匹配失败 —— 详情面板的 diff 会整段错位。
 */
function formatMessagesHeadTail(messages: readonly AgentRunMessage[]): string {
	const allBlocks: string[] = [];
	let totalLength = 0;
	for (const message of messages) {
		const block = formatMessageBlock(message);
		allBlocks.push(block);
		totalLength += block.length + 2;
	}
	if (totalLength <= MAX_SNAPSHOT_TEXT_LEN) {
		return allBlocks.join('\n\n');
	}

	const halfBudget = Math.floor(MAX_SNAPSHOT_TEXT_LEN / 2);
	const headBlocks: string[] = [];
	let headLength = 0;
	for (const block of allBlocks) {
		if (headLength + block.length + 2 > halfBudget && headBlocks.length > 0) {
			break;
		}
		headBlocks.push(block);
		headLength += block.length + 2;
	}

	const tailBlocks: string[] = [];
	let tailLength = 0;
	for (let index = allBlocks.length - 1; index >= headBlocks.length; index--) {
		const block = allBlocks[index];
		if (tailLength + block.length + 2 > halfBudget && tailBlocks.length > 0) {
			break;
		}
		tailBlocks.unshift(block);
		tailLength += block.length + 2;
	}

	const omittedCount = allBlocks.length - headBlocks.length - tailBlocks.length;
	const parts = [...headBlocks];
	if (omittedCount > 0) {
		parts.push(`[... 省略 ${omittedCount} 条消息 ...]`);
	}
	parts.push(...tailBlocks);
	return parts.join('\n\n');
}

/**
 * 第 1-2 级：廉价剪枝 + 工具结果去重。
 *
 * 两者都原地改写历史前缀，故共用同一道 KV 缓存门控。
 */
function applyCachePrefixRewrites(
	deps: IContextCompactionDeps,
	state: IContextCompactionState,
	pressure: number,
	isCacheCold: boolean,
): void {
	if (pressure < 2 && !isCacheCold) {
		return;
	}
	const { host } = deps;

	// 第 1 级：对齐 MiMo prune.ts —— 累积预算保护 + 受保护工具白名单 +
	// 压力 >= 2 时硬清除（占位符）而非仅截断。
	const pruned = ContextManager.pruneOldToolOutputs(
		state.messages() as unknown as ReadonlyArray<ChatMessage>,
		ContextManager.CHEAP_PRUNE_RECENT_KEEP,
		pressure,
	) as unknown as AgentRunMessage[];
	state.setMessages(pruned);
	state.syncMessages();

	// 第 2 级：ReAct 循环中同一文件/搜索常被多轮重复读取，相同 tool 结果在历史
	// 中反复出现。保留最近一次，更早的替换为引用标记。
	const messages = state.messages();
	let dedupCount = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== 'tool' || !message.toolCallId) {
			continue;
		}
		const content = typeof message.content === 'string'
			? message.content
			: JSON.stringify(message.content);
		if (!content || content.length < MIN_DEDUP_CONTENT_LEN) {
			continue;
		}
		for (let earlier = index - 1; earlier >= 0; earlier--) {
			const previous = messages[earlier];
			if (previous?.role !== 'tool' || !previous.toolCallId) {
				continue;
			}
			if (previous.toolCallId === message.toolCallId) {
				continue;
			}
			const previousContent = typeof previous.content === 'string'
				? previous.content
				: JSON.stringify(previous.content);
			if (previousContent !== content) {
				continue;
			}
			const snippet = content.substring(0, MAX_TOOL_RESULT_SNIPPET);
			messages[earlier] = {
				...previous,
				content: `[Same tool result as call ${message.toolCallId} — content identical, deduplicated. Preview: ${snippet}...]`,
			};
			dedupCount++;
			break; // 只替换最近一个重复
		}
	}
	if (dedupCount > 0) {
		host._logService.info(`[AgentOS][Dedup] Replaced ${dedupCount} duplicate tool results with references`);
	}
}

/**
 * 第 3 级：消息数硬上限 —— 只挂 pending，不立即删。
 *
 * 旧版超 60 条即刻从头删：消息数上限先于 token 压缩阈值触发时（60 条仅 40-50k
 * token，未到 60k 压缩线），每轮「长回 63 → 删到 61」头部滑动，前缀反复断链
 * （实测命中率 98% → 6.7%，约 280k miss tokens）。
 *
 * 新版对齐 opencode/deepseek-harness 的纯 token 驱动：超限优先交给三段式压缩
 * —— 压缩是显式接受的一次性断链，且带 cooldown/防抖，一个会话只做一次。
 */
function markHardPruneIfOverCap(
	deps: IContextCompactionDeps,
	state: IContextCompactionState,
): void {
	const messages = state.messages();

	// ⚠ 发送副本纪律（对齐 Hermes agent_runtime_helpers.py:1372「Runs on the
	// per-call api_messages copy only. The stored conversation history is never
	// mutated」）：synthetic sidecar 的剥离**只用于计数**，绝不回写权威 messages。
	//
	// 此前这里写的是 `messages = stripSyntheticSidecars(messages)`，回写把控制流
	// 分支（reflect / plan-queue / TaskGate nudge）刚 append 到末尾的 synthetic
	// user 边界在下一轮开头删除，导致 messages 以 assistant 结尾 → IOA 网关 400
	// code 11133 invalid_parameter_value。
	//
	// 真正的剥离统一由发送线收口层完成（common/adapters/wireMessagePipeline.ts
	// buildWireMessages），那里同时保护尾部 sidecar 并保证 user/tool 结尾。
	const effectiveMessageCount = stripSyntheticSidecars(messages).length;
	if (effectiveMessageCount <= HARD_MAX_MESSAGES) {
		return;
	}
	state.setHardPrunePending(true);
	deps.host._logService.info(
		`[AgentOS][HardPrune] pending: messages=${effectiveMessageCount} `
		+ `(excl. synthetic sidecars; raw=${messages.length}) > cap=${HARD_MAX_MESSAGES} `
		+ `— deferring to compression (cache prefix preserved this turn)`
	);
}

/**
 * 第 3 级兜底：压缩未执行时，rearm 门控下的删头。
 *
 * 压缩成功时条数必然大幅下降，pending 自然消化；压缩被 cooldown/阈值/防抖拒绝
 * 时，仅在 token 压力 >= 1 且通过 rearm runway 时才删头。低压力说明条数多源于
 * 消息碎而非 token 大，删头得不偿失。
 */
function applyHardPruneFallback(
	deps: IContextCompactionDeps,
	state: IContextCompactionState,
	pressure: number,
): void {
	const { host } = deps;
	const currentTokens = state.runState().lastRealPromptTokens
		|| host._estimateMessagesTokens(state.messages());
	const sinceLastPrune = currentTokens - host._lastHardPruneBaselineTokens;
	const isRearmReady = host._lastHardPruneBaselineTokens === 0
		|| sinceLastPrune >= HARD_PRUNE_REARM_TOKENS;

	if (!isRearmReady) {
		host._logService.info(
			`[AgentOS][HardPrune] rearm-gated: token delta ${sinceLastPrune} < ${HARD_PRUNE_REARM_TOKENS} `
			+ `since last prune — skipping head drop (cache prefix preserved)`
		);
		return;
	}
	if (pressure < 1) {
		host._logService.info(
			`[AgentOS][HardPrune] skipped: pressure=${pressure} < 1 — token 远未到压缩线，`
			+ `条数超限源于消息碎，保留完整前缀（cache preserved）`
		);
		return;
	}

	const messages = state.messages();
	const systemMessages = messages.filter(message => message.role === 'system');
	const nonSystemMessages = messages.filter(message => message.role !== 'system');
	const keepCount = HARD_MAX_MESSAGES - systemMessages.length;
	if (nonSystemMessages.length <= keepCount || keepCount <= 0) {
		return;
	}

	const beforePruneCount = messages.length;
	const dropped = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
	const kept = nonSystemMessages.slice(nonSystemMessages.length - keepCount);
	const placeholder = {
		role: 'system',
		content: `[Context truncated: ${dropped.length} earlier messages removed to fit context window. `
			+ `The conversation contained ${dropped.filter(message => message.role === 'user').length} user messages, `
			+ `${dropped.filter(message => message.role === 'assistant').length} assistant responses, `
			+ `${dropped.filter(message => message.role === 'tool').length} tool results.]`,
	} as AgentRunMessage;

	state.setMessages([...systemMessages, placeholder, ...kept]);
	state.syncMessages();
	host._lastHardPruneBaselineTokens = currentTokens;
	host._logService.warn(
		`[AgentOS][HardPrune] messages ${beforePruneCount} → ${state.messages().length} `
		+ `(dropped ${dropped.length} oldest, hard cap=${HARD_MAX_MESSAGES}, `
		+ `pressure=${pressure}, rearm baseline=${currentTokens})`
	);
}

/** 构造「未压缩」的结果对象（冷却期 / 异常兜底共用）。 */
function buildSkippedResult(
	messages: readonly AgentRunMessage[],
	skipped: string,
	extra?: Record<string, unknown>,
): ICompressionResult {
	return {
		originalMessageCount: messages.length,
		compressedMessageCount: messages.length,
		summary: '',
		compressedMessages: [...messages] as unknown as ReadonlyArray<ChatMessage>,
		metadata: { compressionRatio: 1.0, skipped, ...extra },
	};
}

/** 把压缩摘要落盘为 Episodic 记忆（fire-and-forget，失败不阻断本轮）。 */
function writeSummaryToMemory(
	deps: IContextCompactionDeps,
	result: ICompressionResult,
	tokensSaved: number,
	savePercent: number,
): void {
	const { host, request } = deps;
	if (!result.summary || result.summary.length <= 10) {
		return;
	}
	const memoryProvider = host.getActiveMemoryProvider();
	if (!memoryProvider) {
		return;
	}

	const summaryTimestamp = Date.now();
	void (async () => {
		try {
			await memoryProvider.writeMemory(request.agentId, {
				id: `compression-${summaryTimestamp}`,
				type: 'fact',
				content: `[Context Compressed] ${result.summary}`,
				metadata: {
					memoryType: 'fact',
					source: 'context_compression',
					originalCount: result.originalMessageCount,
					compressedCount: result.compressedMessageCount,
					tokensSaved,
					savePercent,
					workspaceId: host._currentWorkspaceId,
					sessionId: request.sessionId,
					noticeId: `compression-${summaryTimestamp}`,
				},
				timestamp: summaryTimestamp,
			});
			host._logService.info(
				`[AgentOS][Compression] Summary written to memory: ${result.summary.length} chars`
			);
		} catch (error) {
			host._logService.warn(
				`[AgentOS][Compression] Failed to write summary to memory: `
				+ `${error instanceof Error ? error.message : String(error)}`
			);
		}
	})();
}

/**
 * Checkpoint 无损重建（极端压力兜底）。
 *
 * 压缩后仍占窗口 85% 以上时，比常规压缩更激进：不调 LLM，复用既有摘要作为
 * 检查点，丢弃全部旧消息只保留极短尾段。
 */
async function rebuildCheckpointIfExtreme(
	deps: IContextCompactionDeps,
	state: IContextCompactionState,
): Promise<void> {
	const { host, contextManager, compressionWindow } = deps;
	const postCompressTokens = host._estimateMessagesTokens(state.messages());
	const postPressure = ContextManager.getPressureLevel(postCompressTokens, compressionWindow);
	if (postPressure < 3 || postCompressTokens <= compressionWindow * CHECKPOINT_PRESSURE_RATIO) {
		return;
	}

	host._logService.warn(
		`[AgentOS][Checkpoint] EXTREME pressure `
		+ `(${(postCompressTokens / compressionWindow * 100).toFixed(0)}%), `
		+ `trying checkpoint rebuild (no LLM, aggressive cut)`
	);
	const checkpointResult = await contextManager.compressCheckpoint(
		state.messages() as unknown as ReadonlyArray<ChatMessage>,
		compressionWindow,
	);
	const checkpointMeta = checkpointResult.metadata ?? {};

	if (checkpointResult.compressedMessageCount >= checkpointResult.originalMessageCount) {
		host._logService.warn(
			`[AgentOS][Checkpoint] SKIPPED: ${checkpointMeta.skipped ?? 'no_saving'}`
		);
		return;
	}

	state.setMessages(compactMessages(
		state.messages(),
		checkpointResult.compressedMessages as unknown as AgentRunMessage[],
	) as AgentRunMessage[]);
	state.syncMessages();
	host._logService.warn(
		`[AgentOS][Checkpoint] REBUILT: `
		+ `from ${checkpointResult.originalMessageCount}→${checkpointResult.compressedMessageCount} messages, `
		+ `saved ${checkpointMeta.tokensSaved ?? 'n/a'} tokens, no LLM`
	);
}

/**
 * 按需压缩本轮上下文。
 *
 * ⚠ 形态说明（turnEmit 采用 — 首个样本）
 * ────────────────────────────────────────────────────────────────────────────
 * 本函数原为 `async function*`，体内 3 处裸 `yield` 直接发射 `IChatStreamDelta`。
 * 现改为**回调解耦形态**：主体是普通 `async function`，事件经注入的 `emit`
 * 发射 —— 与 pi 的 `runLoop(..., emit: AgentEventSink, ...) => Promise<void>`
 * 同形（见 `common/turnEmit.ts` 头注释）。
 *
 * 收益：主体不再是生成器，可直接 `export` 单测并断言事件序列，无需驱动整条
 * 主循环。既有调用方经下方 `compactContextIfNeeded` 的 `asGenerator` 包装
 * 零改动 —— 事件保序与背压语义由 `asGenerator` 保证。
 *
 * @param emit 事件接收端。**必须 await**（背压依赖它，见 turnEmit 语义保证 2）。
 * @param force 溢出恢复专用 —— 绕过阈值/消息数/冷却/防抖判定强制压缩。
 */
export async function compactContextIfNeededImpl(
	emit: TurnEventSink,
	deps: IContextCompactionDeps,
	state: IContextCompactionState,
	force?: boolean,
): Promise<void> {
	const { host, request, contextManager, compressionWindow } = deps;

	// ── 压力与 KV 缓存状态（第 1-4 级共用）──
	// cacheCold：距上次 assistant 响应超过 PRUNE_CACHE_TTL_MS(5min) 视为缓存已冷，
	// 此后改写历史前缀不再浪费已付费的 prompt cache；pressure >= 2 时防溢出优先。
	const estimatedTokens = host._estimateMessagesTokens(state.messages());
	const pressure = ContextManager.getPressureLevel(
		state.runState().lastRealPromptTokens || estimatedTokens,
		compressionWindow,
	);
	const lastAssistantAt = host._lastAssistantAtByAgent
		.get(host._turnKey(request.agentId, request.sessionId)) ?? 0;
	const isCacheCold = lastAssistantAt === 0
		|| (Date.now() - lastAssistantAt) > ContextManager.PRUNE_CACHE_TTL_MS;

	applyCachePrefixRewrites(deps, state, pressure, isCacheCold);
	markHardPruneIfOverCap(deps, state);

	// ── 第 4 级：Hermes 三段式压缩 ──
	const compressionStartTime = Date.now();
	const originalMessageCount = state.messages().length;
	const originalEstimatedTokens = host._estimateMessagesTokens(state.messages());
	host._logService.info(
		`[AgentOS][Compression] BEFORE: messages=${originalMessageCount}, `
		+ `estimatedTokens=${originalEstimatedTokens}, compressionWindow=${compressionWindow}, `
		+ `lastRealPromptTokens=${state.runState().lastRealPromptTokens}`
	);

	let compressionResult: ICompressionResult;
	// 本轮是否真的把 UI 切进过 'compressing'（决定末尾是否需要切回 llm_streaming）
	let enteredCompressingPhase = false;

	// ⚠ 必须在冷却分支**之前**算：UI 门控（willAttemptCompression）与实际压缩
	// （compressContext）都要用它，且两处必须传同一值，否则门控与判定漂移。
	// 纯计算无副作用，提前算不改变行为。
	const toolsSchemaTokens = deps.estimateToolsSchemaTokens(deps.enabledTools());

	const cooldownElapsed = host._lastCompressionTime > 0
		? Date.now() - host._lastCompressionTime
		: Infinity;

	if (cooldownElapsed < COMPRESSION_COOLDOWN_MS) {
		host._logService.info(
			`[AgentOS][Compression] COOLDOWN: `
			+ `${Math.round((COMPRESSION_COOLDOWN_MS - cooldownElapsed) / 1000)}s remaining, skipping`
		);
		compressionResult = buildSkippedResult(state.messages(), 'cooldown');
	} else {
		// UI 门控必须在 await 之前发出：摘要 LLM 挂起恰好发生在 compressContext
		// 内部，若把 phase 发在压缩完成后，那行在挂起时永远执行不到，用户看到的
		// 仍是「正在思考中」，无法判断该等还是该停。
		//
		// 但必须**先确认本轮真会压缩** —— 冷却期只是众多前置条件之一。曾把 phase
		// 发在「冷却期已过」分支里，而实际 12 轮全部 skipped=below_token_threshold，
		// 却每轮都闪一次「正在压缩上下文...」。（_ensurePhaseIndicator 是立即 DOM
		// 操作，不经 delta 缓冲，用户能看见每一次闪烁。）
		const willCompress = contextManager.willAttemptCompression(
			state.messages() as unknown as ReadonlyArray<ChatMessage>,
			undefined,
			compressionWindow,
			state.runState().lastRealPromptTokens,
			toolsSchemaTokens > 0 ? toolsSchemaTokens : undefined,
			force === true ? true : undefined,
		);
		if (willCompress) {
			enteredCompressingPhase = true;
			state.dispatchRunState({ type: 'SET_PHASE', phase: 'compressing' });
			await emit({ type: 'phase_change', phase: state.runState().phase } as IChatStreamDelta);
		}

		try {
			// Pre-compact 注入回调 —— 传进 compressContext，让注入的记忆成为压缩
			// 结果的一部分（而非压缩后再追加，那样会立刻推高 token）。
			const memoryProvider = host.getActiveMemoryProvider();
			const preCompactInject = memoryProvider?.onPreCompact
				? (ctx: {
					agentId: string;
					sessionId: string;
					messages: Array<{ role: string; content: string; timestamp: number }>;
					tokensSaved: number;
					contextWindow: number;
				}) => {
					const injectBudget = Math.min(
						Math.max(Math.floor(ctx.tokensSaved * INJECT_BUDGET_SAVED_RATIO), INJECT_BUDGET_MIN),
						Math.floor(ctx.contextWindow * INJECT_BUDGET_WINDOW_RATIO),
						INJECT_BUDGET_MAX,
					);
					return memoryProvider.onPreCompact!(ctx.agentId, ctx.sessionId, ctx.messages, injectBudget);
				}
				: undefined;

			// 检索式上下文回调（对齐 agentmemory mem::context）：从记忆系统取回
			// 相关上下文替代同步 LLM 摘要。仅在 AgentMemory 可用时提供，否则
			// compressContext 回退到原有 LLM 摘要路径（零行为变更）。
			const retrieveContext = (memoryProvider && memoryProvider.recallFormatted)
				? (retrieveRequest: unknown) => host._retrieveCompactionContext(memoryProvider, retrieveRequest)
				: undefined;

			compressionResult = await contextManager.compressContext(
				state.messages() as unknown as ReadonlyArray<ChatMessage>,
				undefined,
				compressionWindow,
				state.runState().lastRealPromptTokens,
				preCompactInject,
				retrieveContext,
				toolsSchemaTokens > 0 ? toolsSchemaTokens : undefined,
				force === true ? true : undefined,
			);
		} catch (compressionError) {
			host._logService.error(
				`[AgentOS][Compression] EXCEPTION during compressContext: `
				+ `${compressionError instanceof Error ? compressionError.message : String(compressionError)}`,
				compressionError,
			);
			compressionResult = buildSkippedResult(state.messages(), 'exception', {
				error: String(compressionError),
			});
		}
	}

	const didCompress = compressionResult.compressedMessageCount < compressionResult.originalMessageCount;
	const compressionDurationMs = Date.now() - compressionStartTime;
	const compressionMeta = compressionResult.metadata ?? {};

	if (state.hardPrunePending() && !didCompress) {
		applyHardPruneFallback(deps, state, pressure);
	}

	// 日志分级：didCompress=true（成功动作）与 below_* 常态跳过 → info；其他 skip
	// 原因（anti_thrashing 等防抖）→ warn（真信号）。此前 skip 一律 warn，
	// below_token_threshold 每轮刷 WARN，用户误判为异常。
	const skippedReason = String(compressionMeta.skipped ?? '');
	const logCompression = (!didCompress && !skippedReason.startsWith('below_'))
		? host._logService.warn.bind(host._logService)
		: host._logService.info.bind(host._logService);
	logCompression(
		`[AgentOS][Compression] didCompress=${didCompress} `
		+ `skipped=${JSON.stringify(compressionMeta.skipped ?? null)} `
		+ `tokenSource=${compressionMeta.tokenSource ?? 'n/a'} `
		+ `effectiveTokens=${compressionMeta.effectiveTokens ?? 'n/a'} `
		+ `realPromptTokens=${compressionMeta.realPromptTokens ?? 'n/a'} `
		+ `estimatedTokens=${compressionMeta.estimatedTokens ?? 'n/a'} `
		+ `toolsSchemaTokens=${compressionMeta.toolsSchemaTokens ?? 'n/a'} `
		+ `thresholdTokens=${compressionMeta.thresholdTokens ?? 'n/a'} `
		+ `effectiveWindow=${compressionMeta.effectiveWindow ?? 'n/a'} `
		+ `compressionWindow=${compressionWindow} `
		+ `messageCount=${compressionMeta.messageCount ?? state.messages().length} `
		+ `minMessagesToCompress=${compressionMeta.minMessagesToCompress ?? 'n/a'} `
		+ `ineffectiveCompressionCount=${compressionMeta.ineffectiveCompressionCount ?? 'n/a'} `
		+ `compressionThreshold=${compressionMeta.compressionThreshold ?? 'n/a'}`
	);

	if (didCompress) {
		// ── Dashboard 统计 ──
		host._compressionCount++;
		const beforeTokens = (compressionMeta.estimatedTokens as number) ?? 0;
		const afterTokens = (compressionMeta.estimatedTokensAfter as number) ?? 0;
		const savingRatio = beforeTokens > 0 ? (beforeTokens - afterTokens) / beforeTokens : 0;
		if (savingRatio < INEFFECTIVE_SAVING_RATIO) {
			host._compressionIneffectiveCount++;
		}
		host._compressionBeforeTokens += beforeTokens;
		host._compressionAfterTokens += afterTokens;
		host._scheduleSave();

		host._lastCompressionTime = Date.now();
		// phase='compressing' 已在 await 之前发出，此处不再重复 yield ——
		// 本段末尾会按 enteredCompressingPhase 切回 'llm_streaming'。

		const beforeText = formatMessagesHeadTail(state.messages());
		// 收口到 compactMessages reducer（不可变换底），保留单点便于后续加
		// size guard / token 计费。
		state.setMessages(compactMessages(
			state.messages(),
			compressionResult.compressedMessages as unknown as AgentRunMessage[],
		) as AgentRunMessage[]);
		state.syncMessages();

		const compressedEstimatedTokens = host._estimateMessagesTokens(state.messages());
		const tokensSaved = originalEstimatedTokens - compressedEstimatedTokens;
		const savePercent = originalEstimatedTokens > 0
			? Math.round(tokensSaved / originalEstimatedTokens * 100)
			: 0;
		host._logService.info(
			`[AgentOS][Compression] AFTER: messages=${compressionResult.compressedMessageCount}, `
			+ `estimatedTokens=${compressedEstimatedTokens}, saved=${tokensSaved} (${savePercent}%), `
			+ `duration=${compressionDurationMs}ms`
		);

		writeSummaryToMemory(deps, compressionResult, tokensSaved, savePercent);
		await rebuildCheckpointIfExtreme(deps, state);

		const afterText = formatMessagesSequential(state.messages());
		await emit({
			type: 'context_compacted',
			compactedInputTokens: host._estimateMessagesTokens(state.messages()),
			compressionOriginalCount: originalMessageCount,
			compressionCompressedCount: compressionResult.compressedMessageCount,
			compressionTokensSaved: tokensSaved,
			compressionDurationMs,
			compressionBeforeText: beforeText,
			compressionAfterText: afterText,
			compressionSummary: compressionResult.summary || '',
		} as IChatStreamDelta);

		// ⚠ 行为等价性注记（期 2 迁出时发现的既有缺陷，**刻意保持原样**）：
		//
		// 这段切回逻辑在原实现（agentTurnExecutor.ts:1873）里因缩进错位落在
		// `if (didCompress)` 块内，而其上方注释的意图显然是与 didCompress 平级。
		// 后果：`willCompress=true` 但 `didCompress=false`（anti_thrashing 拒绝、
		// 压缩无效、compressContext 抛异常）时，phase 停在 'compressing' 永不切回，
		// UI 持续显示「正在压缩上下文」。
		//
		// 本次迁出以「逐行等价」为门槛，不在搬迁中夹带语义修复 —— 修复应作为
		// 独立变更，附带一条覆盖「进入 compressing 但未压缩」的回归测试。
		if (enteredCompressingPhase) {
			state.dispatchRunState({ type: 'SET_PHASE', phase: 'llm_streaming' });
			await emit({ type: 'phase_change', phase: state.runState().phase } as IChatStreamDelta);
		}
	}
}

/**
 * 既有调用方的零改动入口 —— 把上面回调解耦的主体适配回 `AsyncGenerator`。
 *
 * 事件保序/背压/返回值透传由 `asGenerator` 保证（见 `common/turnEmit.ts`）。
 * 需要单测主体逻辑时，直接调 `compactContextIfNeededImpl` 并注入 mock emit，
 * 断言事件序列即可 —— 不必经由本包装、更不必驱动主循环。
 */
export function compactContextIfNeeded(
	deps: IContextCompactionDeps,
	state: IContextCompactionState,
	force?: boolean,
): AsyncGenerator<IChatStreamDelta> {
	return asGenerator<void>(emit => compactContextIfNeededImpl(emit, deps, state, force));
}

