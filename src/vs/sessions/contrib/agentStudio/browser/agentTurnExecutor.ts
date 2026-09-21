import {
	IModelProvider, IModelSelection, IModelOptions,
	IModelDelta,
	IMemoryProvider,
	IAgentTurnRequest, IChatStreamDelta,
	IToolDefinition, IToolCallInfo,
	ISandboxViolationInfo,
} from '../common/providers.js';
import { isToolCallDeniedByTurnPolicy } from '../common/toolPermission.js';
import type { DeliveryQueue } from '../common/deliveryQueue.js';
import { isPiKernelEnabled, piKernelSupports, runPiKernelTurn } from './piLoop/piTurnKernel.js';
import { runPiKernelTurnInProc } from './piLoop/proc/runPiKernelTurnInProc.js';
import { getKernelProcTransportFactory } from './piLoop/proc/procTransportRegistry.js';
import { runIterationGate, computeForkContext } from './turnIterationGate.js';
import { handlePlanModeTools } from './parts/turnPlanModeTools.js';
import type { IPlanModeToolsHost } from './parts/turnPlanModeTools.js';
import { compactContextIfNeeded } from './parts/turnContextCompaction.js';
import {
	TRIVIAL_BLOCKED_TOOLS,
	extractUserText,
	getToolFailureRecoveryHint,
	isTrivialRequest,
} from './parts/turnRequestTriage.js';
import { runPostIterationCleanup } from './parts/turnPostIteration.js';
import type {
	IPostIterationDeps,
	IPostIterationHookBus,
	IPostIterationHost,
	IPostIterationState,
} from './parts/turnPostIteration.js';
import type {
	IContextCompactionDeps,
	IContextCompactionHost,
	IContextCompactionManager,
	IContextCompactionState,
} from './parts/turnContextCompaction.js';
import type { ITurnHost, ITurnInitHost } from './turnHost.js';
import type { Agent } from '../../../common/agentStudioTypes.js';
import {
	COMPRESSION_COOLDOWN_MS,
	DEFAULT_BUDGET_MAX,
	FILE_MODIFICATION_TOOLS,
	MAX_CONSECUTIVE_TOOL_FAILURES,
	MAX_REFLECT_ITERATIONS,
	MAX_TEXT_SEARCH_STREAK,
	MAX_TEXT_SEARCH_STREAK_HARD,
	MAX_TOOL_ITERATIONS,
	TOOL_USE_ENFORCEMENT_GUIDANCE,
} from '../common/turnLoopConstants.js';
import { buildTurnLlmStream, handleTurnStreamError } from './turnLlmStream.js';
import {
	classifyTurnDelta,
	isDoneWithFinishReason,
	isErrorDelta,
	isTextDelta,
	isThinkingDelta,
	isToolCallDelta,
	isUsageDelta,
} from './turnDeltaDispatch.js';
import { classifyAllBlockedStreak, classifyPingPong } from '../common/turnStopGate.js';
import { failToolCallsFromTruncatedMessage, isTruncatedByOutputLimit, finalizeToolCall } from './turnToolExecution.js';
import type {
	ITurnToolCall, ITurnToolResult, ISandboxResolution, IToolFinalizationDeps,
} from './turnToolExecution.js';
import { TurnHookBus } from '../common/turnHookBus.js';
import { registerMemoryProviderHooks } from './turnHookWiring.js';
import { isPlanFileWriteCall } from '../common/planFile.js';
import { filterPlanExclusiveTools } from '../common/chatModeConfig.js';
import { join as pathJoin } from '../../../../base/common/path.js';
import {
	createInitialWorkState,
	resolveRequestWorkMode,
	type ParsedPlanTask,
} from '../common/workMode.js';
import {
	appendMessages,
	insertMessages,
	createInitialRunState,
	reduceRunState,
	type AgentGuardrailCounters,
	type AgentWrapUpState,
	type AgentRetryCounters,
	detectToolCallLoop,
	classifyIncompleteTurn,
	detectTruncatedTail,
	resolveIncompleteTurnRetryInstruction,
	incompleteTurnDiscardReason,
	incompleteTurnRetryLimit,
	incompleteTurnUserNotice,
	type AgentRunMessage,
	type AgentRunState,
	detectXmlToolCallLeak,
	canonicalToolArgsHash,
	hashToolResult,
	detectToolCallPingPong,
	detectArgumentChurn,
	RUN_STATE_LIMITS,
	locateTaggedIdXmlTags,
	stripTaggedIdXmlTags,
	type AgentAction,
} from '../common/agentRunState.js';
import {
	computeStreakKey,
	detectReasonStreak,
	reasonStreakReminder,
	REASON_STREAK_TRIGGER_COUNT,
} from '../common/reasonStreak.js';
import {
	AgentCommand,
	TRANSFER_TO_AGENT_TOOL,
	buildHandoffCommand,
	applyCommandToState,
} from '../common/agentGraph.js';
// 工具结果里的图像项：剥离出来改走 role:'user'（tool 消息的 contentParts 三家 provider 都不读）
import {
	splitToolResultImages, buildToolImageMessage, toolImageOmittedNote, resolveSupportsImages,
} from '../common/toolResultImages.js';
import { deriveAskRoutingContext } from '../common/askRouting.js';
import { isBridgeTool } from '../common/toolsetConfig.js';
import { needsToolUseEnforcement, detectModelFamily } from '../common/modelFamilyPrompt.js';
import { formatEnrichmentLog } from '../common/promptDiagnostics.js';
import {
	isShellToolWithCommandArg,
	detectAntiGuidanceCommand,
	formatAntiGuidanceLog,
	tryRewriteLeadingCd,
	formatLeadingCdRewriteLog,
	tryClampLeadingSleep,
	formatSleepClampLog,
} from '../common/shellCommandSafety.js';
import {
	formatGuardrailFiredLog,
	type IToolCallRecord,
} from '../common/toolAuditReport.js';
import {
	formatCurrentTaskReminder,
	formatExplorationFindings,
} from '../common/preLoopOrchestrator.js';
import {
	toolConsecutiveFailureReminder,
	terminalEmptyOutputReminder,
	textWithoutToolsReminder,
	allToolCallsBlockedReminder,
	allBlockedWrapUpReminder,
	ALL_BLOCKED_ESCALATE_AT,
	ALL_BLOCKED_WRAPUP_AT,
	preferGraphSearchReminder,
	stopSearchingReportReminder,
	textSearchLoopWrapUpReminder,
	advanceSingleToolStreak,
	batchReadOnlyToolsReminder,
	xmlToolCallLeakReminder,
	argumentChurnReminder,
} from '../common/loopReminders.js';
import {
	ToolGuardrailController,
	appendToolGuardGuidance,
	type IToolGuardrailDecision,
} from './toolGuardrailController.js';
import {
	STRUCTURAL_SEARCH_TOOL_NAMES,
	TEXT_SEARCH_TOOL_NAMES,
} from '../common/searchToolGroups.js';
import {
	logToolAuditSummary,
	storeTurnObservationsAtEnd,
} from './parts/turnFinalization.js';
import {
	emitPromptBudgetReport,
	logToolsSentToLlm,
} from './parts/turnRequestDiagnostics.js';

import {
	deduplicateToolCalls,
	buildLoopBlockFeedback,
	limitToolResultSize,
	safeStringifyToolResult,
	shouldParallelizeToolBatch,
	splitDelegateParallelBatch,
	StreamingToolCallAssembler,
	PHANTOM_TOOL_NAMES,
	repairToolName,
	MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES,
	isParallelSafeReadOnlyTool,
} from './toolCallUtils.js';
import {
	sanitizeToolResultText,
	isEntirelyToolCallContent,
} from '../common/assistantVisibleText.js';
import { buildDurableContextSystemMessage } from '../common/durableContextMiddleware.js';
import { AGUIChatMessageBuilder } from '../common/adapters/aguiAdapter.js';
import { ContextManager, RETRIEVAL_COMPACTION_ENABLED, RETRIEVAL_BUDGET_RATIO } from '../common/contextManager.js';
import { injectMemoryContext, isMemoryInjectionEnabled } from './agentMemoryInjection.js';
import { getLastMcpServerStats } from './agentToolAssembly.js';
import { IterationBudget } from '../common/iterationBudget.js';
import { createTurnLoopState } from '../common/turnLoopState.js';
import { AgentLoopStrategyFactory } from './agentLoopStrategyFactory.js';
import type { PreLoopContext, AgentParadigm } from '../common/agentLoopStrategy.js';
import {
	sanitizeWithTrace,
	tagTraceScanRequest,
	tagTraceScanToolResult,
	isMultiTargetChurnTool,
	estimateToolsSchemaTokens,
	groupToolSchemaCosts,
	buildCheckpointSnapshot,
} from './parts/turnHelpers.js';

/**
 * 转导出（barrel re-export）。
 *
 * `test/browser/agentTurnExecutorHelpers.test.ts` 从**本文件**路径 import
 * `buildCheckpointSnapshot` 并有 6 个断言，直接搬走会断链。此处保住原有测试
 * 入口，不是重复实现。
 */
export { buildCheckpointSnapshot };

/**
 * 范式 → 策略的解析工厂，模块级单例。
 *
 * 语义等价于此前的 `host._strategyFactory` 懒挂（`if (!host._strategyFactory) …`）：
 * `host` 是进程内单例服务，那次懒挂实际就是「一个进程一个工厂」。改为模块常量
 * 后行为不变，但少了一处往 `any` 宿主上凭空写字段的操作 —— `_strategyFactory`
 * 在 `AgentOSService` 上**从未声明过**，仅靠 `host: any` 才没被 tsc 拦下。
 *
 * 工厂本身持有可变状态（`register()` 可覆盖某范式的实现），故必须复用同一实例，
 * 不能每轮 new。而**策略实例**仍是 per-turn 的：`resolve()` 每次调用都 new 一个，
 * 多聊天框/多 session 的预算与循环状态因此天然隔离。
 */
const strategyFactory = new AgentLoopStrategyFactory();

/**
 * 已对「API 请求中 0 个 MCP 工具」警告过的会话（2026-09-05）。
 * 未配置/未连接 MCP 是稳态而非逐轮异常——同会话只 warn 一次，后续降级 info，
 * 避免日志刷屏（实测单会话 23 条重复警告）。
 */
const _noMcpWarnedSessions = new Set<string>();






// MCP 工具不直发 schema（会导致 API 400），仅通过 tool_search 桥接发现。
// 系统提示词（agentDriverService.ts）中已有 MCP 工具摘要指引。

// ─── Agent OS Service Implementation ────────────────────────────────────

/** Turn setup context — produced by _initTurnContext, consumed by the agent loop. */
interface ITurnContext {
	modelProvider: IModelProvider;
	selection: IModelSelection;
	enabledTools: IToolDefinition[];
	messages: any[];
	memoryProvider: IMemoryProvider | undefined;
	/** 实际作为第一条 system 消息发送的冻结前缀（含 model 相关的 enforcement 追加）。
	 * fork 前缀指纹与 modelOptions.systemPrompt 均基于本值，保证缓存对齐一致。 */
	effectiveSystemPrompt: string | undefined;
}






	/**
	 * 带 Fallback 的直接模型调用（含工具执行循环）
	 *
	 * 实现完整的 Agent Loop：
	 *   1. 获取启用的工具列表
	 *   2. 将工具定义传递给模型
	 *   3. 收集模型返回的 tool_calls
	 *   4. 执行工具调用，将结果反馈给模型
	 *   5. 循环直到模型不再调用工具或达到最大迭代次数
	 */

	/**
	 * 按 `agentId` 从 Agent 注册表取当前 Agent 配置。
	 *
	 * 修复历史缺陷：此处原为 `host._currentAgent`，但该成员在 `AgentOSService` 上
	 * **从未声明过**，仅靠 `host: any` 才没被 tsc 拦下 —— 运行时恒为 `undefined`，
	 * 导致 `enrichWithStats` 的 `ctx.agent` 一直为空，
	 * `SystemReminderTagProvider`（`builtinTagProviders.ts:319`）永远无法给只读
	 * agent 追加「This is a read-only agent」提醒。
	 *
	 * 静默降级路径与注册表本身一致：`_studioService` 未注入 / 查不到 id 时返回
	 * `undefined`，与 `ctx.agent?: Agent` 的可选语义吻合，调用方无需额外判空。
	 */
	function resolveCurrentAgent(host: ITurnInitHost, agentId: string | undefined): Agent | undefined {
		if (!agentId) { return undefined; }
		try {
			const agents = host._configReaderDeps.getAgentsSync();
			return agents?.find((candidate: Agent) => candidate.id === agentId);
		} catch {
			// 注册表读取失败不应打断整轮富化 —— 退化为「无 agent 上下文」。
			return undefined;
		}
	}

	/**
	 * Turn setup — model provider check, tool collection, message init, memory injection.
	 * Yields memory_injected deltas. Returns undefined to signal early exit.
	 */
	async function* initTurnContext(host: ITurnInitHost, request: IAgentTurnRequest): AsyncGenerator<IChatStreamDelta, ITurnContext | undefined> {
		const modelProvider = host._getActiveModelProvider();
		if (!modelProvider) {
			host._logService.warn('[AgentOS] No ModelProvider available');
			yield* host._fallbackToDirectChat(request);
			return undefined;
		}

		const selection = host.getActiveModelSelection();
		host._logService.info(`[AgentOS] Using ModelProvider directly: ${modelProvider.id}, modelId=${selection?.modelId}`);

		if (!selection || !selection.modelId) {
			host._logService.error('[AgentOS] No active model selection or modelId is empty');
			yield { type: 'error', content: 'No model selected. Please select a model from the toolbar.' };
			return undefined;
		}

		// ─── 1. 收集启用的工具（含 MCP 工具等待）─────────────────────
		// MCP 服务器连接和工具枚举是异步的：McpToolProvider 的 autorun 在
		// server.tools observable 变化后才填充 _routes。如果用户在 workbench
		// 启动后立即发消息，MCP 工具可能尚未就绪。这里在首次执行时做一次短轮询等待。
		let enabledTools = await host._getEnabledTools(request.agentId, request.agentGraph, request.toolsetsOverride, host._resolveHardPermission(request), request.excludedTools, request.allowedTools);
		host._logService.info(`[AgentOS] Direct mode: initial ${enabledTools.length} enabled tools for agent ${request.agentId}`);

		// 仅首次执行时，如果初始没有 MCP 工具，等待最多 3 秒让 MCP 服务器完成连接
		const mcpToolCount0 = enabledTools.filter((t: any) => t.category?.startsWith('mcp:')).length;
		if (mcpToolCount0 === 0 && !host._mcpToolsInitialWaitDone) {
			host._mcpToolsInitialWaitDone = true;
			host._logService.info(`[AgentOS] No MCP tools found initially (first turn), waiting for MCP servers to connect...`);
			enabledTools = await host._waitForMcpTools(request.agentId, enabledTools, 3000);
		}
		// 诊断日志：列出所有工具名（特别标注 MCP 工具）
		const mcpToolNames = enabledTools.filter((t: any) => t.category?.startsWith('mcp:')).map((t: any) => t.name);
		const builtinToolNames = enabledTools.filter((t: any) => !t.category?.startsWith('mcp:')).map((t: any) => t.name);
		host._logService.info(`[AgentOS] Direct mode tools: ${enabledTools.length} total (${mcpToolNames.length} MCP: [${mcpToolNames.join(', ')}], ${builtinToolNames.length} builtin: [${builtinToolNames.slice(0, 10).join(', ')}${builtinToolNames.length > 10 ? '...' : ''}])`);

		// ─── 2. 初始化消息历史 ─────────────────────────────────────
		// 对齐 Hermes TOOL_USE_ENFORCEMENT_GUIDANCE + MiMo beast.txt：
		// 对 DeepSeek 等需要显式引导的模型族，自动在 system prompt 末尾注入
		// 工具使用强制指令——"说了要做就必须在同一轮发出 tool_call，否则不要停"。
		//
		// ⚠ 判据真源 = `common/modelFamilyPrompt.needsToolUseEnforcement()`（2026-08-22）。
		// 改前这里内联 `TOOL_USE_ENFORCEMENT_MODELS.some(m => modelId.includes(m))`，
		// 与 driver 侧「按族分发工具调用格式指令」构成**两套独立的模型族判断** ——
		// 本项目已多次因两份判据漂移而踩坑，故统一到同一函数。
		// （`TOOL_USE_ENFORCEMENT_MODELS` 常量仍保留在 agentOSService 供参考/回溯，
		//   但**不再是判据** —— 不要改它来调整行为，改 FAMILY_PROFILES。）
		let effectiveSystemPrompt = request.systemPrompt;
		if (effectiveSystemPrompt) {
			const needsEnforcement = needsToolUseEnforcement(selection?.modelId);
			if (needsEnforcement && !effectiveSystemPrompt.includes('TOOL_USE_ENFORCEMENT')) {
				effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${TOOL_USE_ENFORCEMENT_GUIDANCE}`;
				host._logService.info(`[AgentOS] Appended tool-use enforcement guidance for model ${selection.modelId} (family=${detectModelFamily(selection?.modelId)})`);
			}
			// Plan 模式强制指令已移至 per-iteration <system-reminder> 注入（下方 agent loop 内）。
			// 旧的 PLAN_MODE_TOOL_ENFORCEMENT 常量已被移除（与 system-reminder 语义重叠）。
		}

	// ─── 系统提示词体量护栏（非破坏性）─────────────────────────────
	// 历史实现曾把 101K+ 的 blob 用「保留头 35% + 尾 65%」粗暴裁剪到 15K，
	// 腰斩 persona 且每次裁剪 marker 不同 → 彻底打破 provider 前缀缓存。
	// P0 已将工具/技能清单移出 system 文本（改走结构化 tools 字段 + tool_search
	// 桥接），driver 现按 stable/context/volatile 分层组装，system 文本回归自然体量。
	// 这里只保留一个非破坏性的体量告警，不再做任何裁剪。
	const SYSTEM_PROMPT_WARN_CHARS = 40000;
	if (effectiveSystemPrompt && effectiveSystemPrompt.length > SYSTEM_PROMPT_WARN_CHARS) {
		host._logService.warn(`[AgentOS] systemPrompt unusually large (${effectiveSystemPrompt.length} chars) — check for context bloat; NOT trimming (tiered assembly preserves prefix cache)`);
	}

	let messages: any[];
	if (effectiveSystemPrompt) {
		// 去重（2026-09-04，用户导出「压缩上下文（部分）.txt」实证）：上游 driver 分层组装
		// 可能已把完整系统提示放进 request.messages 头部，此处再 prepend 会得到两条
		// **相邻且逐字相同**的 system 消息（该导出里两份 300 行系统提示，纯浪费 ~18k
		// tokens/turn）。规则：首条已是 system 则**替换**为 effectiveSystemPrompt
		// （executor 是 system 唯一真源——enforcement 追加也只发生在这里）；其后的
		// 历史消息中与 effectiveSystemPrompt 完全相同的副本一并剔除。
		const head = (request.messages as any[])[0];
		let body = request.messages as any[];
		if (head?.role === 'system') {
			body = (request.messages as any[]).slice(1);
			if (head.content !== effectiveSystemPrompt) {
				host._logService.info(`[AgentOS] Replaced upstream system message (${head.content.length} chars) with effectiveSystemPrompt (${effectiveSystemPrompt.length} chars)`);
			}
		}
		body = body.filter((m: any) => !(m?.role === 'system' && m.content === effectiveSystemPrompt));
		messages = [
			{ role: 'system', content: effectiveSystemPrompt },
			...body,
		];
		host._logService.info(`[AgentOS] Prepended frozen system prefix (${effectiveSystemPrompt.length} chars) as system message`);

		// ── 完整系统提示词 dump 到日志（分块，避免单行截断）─────────
		{
			const SYS_DUMP_CHUNK = 8000;
			const total = effectiveSystemPrompt.length;
			const parts = Math.max(1, Math.ceil(total / SYS_DUMP_CHUNK));
			host._logService.info(`[AgentOS][systemPrompt DUMP START] total=${total} chars, parts=${parts}`);
			for (let p = 0; p < parts; p++) {
				const chunk = effectiveSystemPrompt.slice(p * SYS_DUMP_CHUNK, (p + 1) * SYS_DUMP_CHUNK);
				host._logService.info(`[AgentOS][systemPrompt DUMP ${p + 1}/${parts}]\n${chunk}`);
			}
			host._logService.info(`[AgentOS][systemPrompt DUMP END] total=${total} chars`);
		}
	} else {
		messages = request.messages as any[];
	}

	// ─── 注入 volatile 层（独立 system 消息，置于冻结前缀之后）─────────
	// Persona Memory + 本轮激活技能。每轮可变，不进冻结前缀指纹，其变化不打断前缀缓存。
	const volatileContent = (request.systemPromptVolatile ?? '').trim();
	if (volatileContent) {
		let volatileInsertIdx = 0;
		for (let i = 0; i < messages.length; i++) {
			if (messages[i]?.role === 'system') { volatileInsertIdx = i + 1; } else { break; }
		}
		messages = insertMessages(messages, volatileInsertIdx, { role: 'system', content: volatileContent });
		host._logService.info(`[AgentOS] Injected volatile tier (${volatileContent.length} chars) after frozen prefix`);
	}

	// ─── P8 Recently Touched Files（volatile 层，2026-07-25 修复死代码）───
	// 「最近触碰」是每轮可变语义，与 volatile 层天然匹配；此前挂在一次性策展
	// 注入块内且 stash 每轮末清空，从未生效（doc §12 F3）。stash 现按会话
	// 生命周期保留，turn 开始时消费上一轮工具执行收集的文件路径。
	if (isMemoryInjectionEnabled()) {
		const touchedFiles = host._consumeStashedFiles(request.agentId);
		if (touchedFiles.length > 0) {
			let filesContent = `## Recently Touched Files\n${touchedFiles.slice(0, 10).join('\n')}`;

			// mem::enrich 复刻（高价值部分）：触碰文件的历史 bug 记忆提示——
			// 「即将编辑这些文件 → 这些文件过去踩过的坑」。type=bug ∩ isLatest
			// ∩ files 路径重叠，updatedAt 倒序 top3；失败静默降级。
			try {
				const provider = host.getActiveMemoryProvider();
				const bugMemories: Array<{ id: string; title: string; content: string }> =
					await provider?.bugMemoriesForFiles?.(request.agentId, touchedFiles) ?? [];
				if (bugMemories.length > 0) {
					filesContent += `\n\n<agentmemory-past-errors>\n${bugMemories.map((m: { title: string; content: string }) => `- ${m.title}: ${m.content}`).join('\n')}\n</agentmemory-past-errors>`;
				}
			} catch { /* best effort，不阻断 turn */ }

			let filesInsertIdx = 0;
			for (let i = 0; i < messages.length; i++) {
				if (messages[i]?.role === 'system') { filesInsertIdx = i + 1; } else { break; }
			}
			messages = insertMessages(messages, filesInsertIdx, { role: 'system', content: filesContent });
			host._logService.info(`[AgentOS] Injected recently-touched files (${touchedFiles.length} paths) as volatile tier`);
		}
	}

		// ─── 加载 Memory 上下文并注入 system prompt（冻结快照模式）──────
		// 委托到 agentMemoryInjection.ts 的 injectMemoryContext async generator。
		const memoryProvider = host.getActiveMemoryProvider();
		const memResult = yield* injectMemoryContext({
			logService: host._logService,
			getActiveMemoryProvider: () => memoryProvider,
			injectedSessions: host._injectedSessions,
			metaInjectedSessions: host._metaInjectedSessions,
		}, request, messages);
		messages = memResult.messages;

		// ─── Inject Durable Context（借鉴 deer-flow DurableContextMiddleware）────
		// Durable context survives summarization compression and keeps the LLM
		// aware of prior sub-agent delegations, active goals, and critical skill
		// context even when older messages have been dropped.
		const durableCtxMsg = buildDurableContextSystemMessage(host._durableContext);
		if (durableCtxMsg) {
			// 替换式注入（2026-09-04，用户导出实证）：上一轮注入的 durable system 若
			// 残留在 request.messages 历史里，此处再插入就会每轮多一份（该导出里
			// durable_context_data 快照两份相邻、290 行重复）。按内容前缀识别并移除
			// 旧副本，只保留本次注入的最新一份。
			const durableHead = durableCtxMsg.content.slice(0, 40);
			const beforeCount = messages.length;
			messages = messages.filter((m: any) =>
				!(m?.role === 'system' && typeof m.content === 'string' && m.content.slice(0, 40) === durableHead));
			if (messages.length !== beforeCount) {
				host._logService.info(`[AgentOS] Removed ${beforeCount - messages.length} stale durable-context system message(s) before re-injection`);
			}
			// Inject right after system prompt, before user messages
			let insertIdx = 0;
			for (let i = 0; i < messages.length; i++) {
				if (messages[i]?.role === 'system') {
					insertIdx = i + 1;
				} else {
					break;
				}
			}
			messages = insertMessages(messages, insertIdx, durableCtxMsg);
			host._logService.info(
				`[AgentOS] Injected durable context (${durableCtxMsg.content.length} chars, ` +
				`ledger entries: ${host._delegationLedger.getAllEntries().length})`
			);
		}

		// 重复注入检测（2026-09-04）：正常 composition = 主 system 1 + volatile 0/1 +
		// durable 0/1。超过 3 条说明某处仍在重复 push——每条冗余副本每个 turn 都全额
		// 计费（系统提示体量 ~18k tokens），必须当场暴露而不是等用户导出消息文件。
		const _sysCount = messages.filter((m: any) => m?.role === 'system').length;
		if (_sysCount > 3) {
			host._logService.warn(`[AgentOS] ${_sysCount} system messages in outgoing request — likely duplicated prompt injection; each stale copy burns full tokens every turn`);
		}

		// ─── User Message XML Tag Enrichment ────────────────────────────
		// 找最后一条 user 消息，用 XML 标签包裹环境上下文信息（对齐 CodeBuddy 格式）。
		// 仅当 enricher 已初始化时才执行（首次预热后）。
		if (host._userMessageEnricher) {
			let lastUserIdx = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i]?.role === 'user') { lastUserIdx = i; break; }
			}
			if (lastUserIdx >= 0 && typeof messages[lastUserIdx].content === 'string') {
				try {
					// 2026-08-06：enrich 前从 agentmemory 记忆系统读取策展上下文
					// 只读注入 working_memory_content 标签（数据源为 MemoryProvider，
					// 非 .codebuddy/memory/ 文件）
					await host._refreshWorkingMemoryContent?.(request.agentId, request.sessionId);
					// kb_overview 标签：L1 常驻目录摘要（TTL 60s + 1.5s 超时 + 预算截断，内部不抛）
					await host._refreshKbOverviewContent?.();
					// ⚠ 必须在替换**之前**取原长度（2026-08-22 修，日志 1787368358120）：
					// 早前在替换后才读 `messages[lastUserIdx].content`，那时它已经是 enriched
					// 本身，`enriched.length - origLen` 恒为 0 → 日志永远打印
					// "(0 chars added)"，让人误判「8 个标签全空、富化系统空转」。
					// 富化本身一直是正常的，坏的只是这行统计。
					const origLen = (messages[lastUserIdx].content as string).length;
					// enrichWithStats：拿逐标签统计（2026-08-22）。改前 provider 抛错走
					// `catch {}` 静默吞掉 → 某标签没出现时无法区分「本轮真无内容」与
					// 「provider 坏了」，8 个标签任一失效都是无声的。
					const enrichResult = await host._userMessageEnricher.enrichWithStats(
						messages[lastUserIdx].content as string,
						{ request, agent: resolveCurrentAgent(host, request.agentId) },
					);
					const enriched = enrichResult.enriched;
					messages = messages.slice(); // shallow copy 后修改，避免污染 request.messages 引用
					const enrichedMsg = { ...messages[lastUserIdx], content: enriched };
					if (lastUserIdx === messages.length - 1) {
						messages = [...messages.slice(0, lastUserIdx), enrichedMsg];
					} else {
						messages = [...messages.slice(0, lastUserIdx), enrichedMsg, ...messages.slice(lastUserIdx + 1)];
					}
					// 逐标签明细：emitted（含各标签字符数，降序）/ empty（合法留白）/
					// FAILED（每条单独一行，失败是缺陷信号不做折叠）。
					const enrichLog = formatEnrichmentLog(enrichResult.stats, origLen, enriched.length);
					if (enrichLog.level === 'warn') {
						host._logService.warn(enrichLog.text);
					} else {
						host._logService.info(enrichLog.text);
					}
				} catch (err) {
					host._logService.warn(`[AgentOS] User message enrichment failed: ${err}`);
				}
			}
		}

	return { modelProvider, selection, enabledTools, messages, memoryProvider, effectiveSystemPrompt };
}

// ─── 模块级纯函数：见 `parts/turnHelpers.ts` ─────
// sanitizeWithTrace / tagTraceScanRequest / tagTraceScanToolResult /
// isMultiTargetChurnTool / estimateToolsSchemaTokens / buildCheckpointSnapshot /
// groupToolSchemaCosts —— 全部迁至 `parts/turnHelpers.ts`（不捕获闭包上文，可单测）。










	export async function* executeAgentTurnDirect(host: ITurnHost, request: IAgentTurnRequest, steeringQueue?: DeliveryQueue): AsyncGenerator<IChatStreamDelta, AgentCommand | undefined> {
		// chatOnly 开关：开启时禁用写文件工具，React 范式下额外禁用 delegate_task
		const chatOnly = !!request.chatOnly;
		// ── 本 turn 缓存命中率基线（2026-08-21，日志 1787315962316）──────────────
		// `host._totalInputTokens` / `_totalCachedTokens` 是 Dashboard 的**持久化**
		// 累计计数器（跨会话，`_scheduleSave`）。要打「本次会话命中率」必须在 turn
		// 起点取基线后相减，否则打出来的是账号生命周期数字（实测 4.69 亿/5.82 亿，
		// 多轮采样恒为 80.6%，毫无诊断价值）。
		const _turnCacheBaselineInput = host._totalInputTokens ?? 0;
		const _turnCacheBaselineCached = host._totalCachedTokens ?? 0;
		// ── [PromptBudget] 上报节流基线（turn 局部）────────────────────────────
		// 声明在 turn 函数体内而非 host 字段：天然实现「每 turn 首次必打」，
		// 无需额外的重置逻辑，也不会跨 turn 泄漏状态。
		// 刻意**不收口**进 runState —— 见 agentRunState.ts「runState 收口边界」。
		// 诊断：软预算收尾提醒是否送达（日志 1785325929739 子代理 404s 超时未触发）
		if (request.subAgent?.background) {
			host._logService.info(
				`[AgentOS] executeAgentTurnDirect(subAgent): agentId=${request.agentId} ` +
				`softDeadlineMs=${request.softDeadlineMs ?? 'unset'} ` +
				`timeout(budget)=${request.softDeadlineMs ? Math.round(request.softDeadlineMs / 1000) + 's' : 'none'}`,
			);
		}
		// 统一推导入口（resolveRequestWorkMode）：显式 workMode 优先（跨 turn 由
	// agentDriverService 按 session 恢复），缺失时按 chatMode==='plan' fallback。
	// 与 agentOSService._resolveHardPermission 共用 —— 权限层与状态机永不分裂。
		// Plan state is mirrored into AgentRunState for checkpoint compatibility.
		//
		// ⚠ 声明位置上移（2026-09-16，workState 收口）：`runState` 此前声明在下方约 80 行处，
		// 但 planFilePath 与 preLoop 上下文（loopCtx.workState）都在更早的前置阶段就要读它。
		// workState 闭包变量删除后，那些读点必须指向这里，故本声明提前到其首位读点之前。
		// 此前靠闭包 `let workState` 与 runState.work 各存一份绕开了顺序问题 —— 那正是双写分叉的来源。
		let runState: AgentRunState = createInitialRunState({
			lastRealPromptTokens: host._lastRealPromptTokensByAgent.get(host._turnKey(request.agentId, request.sessionId)) ?? 0,
			workState: createInitialWorkState(resolveRequestWorkMode(request.chatMode, request.workMode)),
			// messages 种子留空：真实种子在上下文构建完成后写入（见下方 `let messages = ...` 处），
			// 因为此处 ctx / checkpoint 恢复值都尚未就绪，强行读取会引入声明顺序问题。
		});
		let planFilePath: string | undefined = runState.work.planFilePath;
		let planEnterCalled = false;
		let planExitCalled = false;

	const ctx = yield* initTurnContext(host, request);
	if (!ctx) { return undefined; }
	const { modelProvider, selection, memoryProvider } = ctx;
	// ─── 钩子总线（2026-09-17：拍板「总线是唯一分发面」后接线）─────────────
	// 此前本 turn 的钩子分发有两套：策略钩子（IAgentLoopStrategy）+ 未类型化的
	// `memoryProvider.triggerHook`（裸 string 钩子名，散落 4 个文件）。总线统一
	// 工具级钩子的分发：调用点只认识 TurnHookName 联合类型，拼错即编译失败。
	// provider 转发的 fire-and-forget 语义由 turnHookWiring 保持（不阻塞主循环）。
	const hookBus = new TurnHookBus((hookName, error) => {
		host._logService.warn(`[AgentOS] Hook "${hookName}" failed: ${error.message}`);
	});
	const disposeMemoryHooks = registerMemoryProviderHooks(
		hookBus,
		memoryProvider,
		{ agentId: request.agentId, sessionId: request.sessionId || '' },
		message => host._logService.warn(message),
	);
	// 实际发送的冻结前缀（含 model 相关 enforcement）——fork 指纹与 modelOptions 统一基于本值
	const effectiveSystemPrompt = ctx.effectiveSystemPrompt;
	let enabledTools = ctx.enabledTools;
		// ─── Plan 专属工具门控（2026-08-21）：仅 Plan 模式可用 ──────────────
		// plan_enter/plan_exit/plan_explore 原挂在 core toolset（Always 优先级）→
		// 所有模式都可见 → 模型会在用户没要求时自行 plan_enter 转入规划
		// （日志 1787294819356：iteration 24 自主进 plan）。
		// 判据用 request.chatMode（用户在输入框下拉框选定的稳定 UI 策略），
		// **不用** workMode —— workMode 是 plan_enter 之后的运行时阶段，
		// 用它判断会形成「只有已经进了 plan 才能调 plan_enter」的死循环。
		{
			const beforeCount = enabledTools.length;
			enabledTools = filterPlanExclusiveTools(enabledTools as ReadonlyArray<{ name: string }>, request.chatMode) as typeof enabledTools;
			if (enabledTools.length !== beforeCount) {
				host._logService.info(
					`[AgentOS] plan-exclusive tools filtered (chatMode=${request.chatMode ?? 'unset'}): ` +
					`${beforeCount} → ${enabledTools.length}`
				);
			}
		}
		// chatOnly 模式：禁用写文件工具（只保留只读 + 查询类工具）
		if (chatOnly) {
			const WRITE_TOOLS = new Set([
				'file_write', 'write_to_file', 'replace_in_file', 'edit_file',
				'delete_file', 'delete_files',
				'execute_command', 'terminal', 'bash', 'shell', 'run',
			]);
			enabledTools = enabledTools.filter((t: any) => !WRITE_TOOLS.has(t.name));
			host._logService.info(`[AgentOS] chatOnly: filtered write tools (enabledTools=${enabledTools.length})`);
		}
		// 轻量请求快速通道：对明显非任务的简短消息（如 "test1"/问候/确认），
		// 阻止进入代码库深度探索，也不触发图谱构建/重索引 —— 直接回答即可。
		const trivialRequest = isTrivialRequest(extractUserText(request));
		if (trivialRequest) {
			host._logService.info('[AgentOS] trivial request detected — will restrict exploration tools');
		}
		// ─── pi 内核门控分流（2026-09-20 E2 已翻转：默认 piLoop 内核驱动）──────────────
		// 全形态（plan/resume/subAgent/chatOnly）当日均已接入 ⇒ 正常请求一律走 pi 内核，
		// 输出契约不变（IChatStreamDelta）⇒ UI/会话/审批零改动。
		// 显式回落 legacy：`window.__SAROSIS_PI_KERNEL = false` 或 env SAROSIS_PI_KERNEL=0
		// （排障逃生门；legacy 主循环代码仍保留在下方）。
		// 插入点刻意选在「initTurnContext 成功 + 工具门控（plan-exclusive/chatOnly/trivial）
		// 已应用」之后：pi 路径直接消费最终 enabledTools 与已注入记忆的 ctx.messages。
		if (isPiKernelEnabled() && piKernelSupports(request)) {
			// 进程隔离档（P1）：子代理声明 isolation_level='process' ⇒ 内核跑隔离体，
			// 工具/模型经 RPC 回本进程（审批链不断）。传输未注册（无头/测试环境）⇒
			// 回落进程内档 + warn，不报错不打断。
			const wantProc = request.subAgent?.isolationLevel === 'process';
			const procFactory = wantProc ? getKernelProcTransportFactory() : undefined;
			if (procFactory) {
				// ⚠ 只包裹「取隔离体」：fork 失败（产物缺失/权限/FD 耗尽）在此捕获后回落进程内档
				// （此前直接 yield* 会让整 turn 崩）。**绝不把 yield* 包进 try** —— 那会连流中途的
				// 真错误一起吞掉并回落，已上屏的 delta 会被重复产出。
				let transport: Awaited<ReturnType<typeof procFactory>> | undefined;
				try {
					transport = await procFactory();
				} catch (procErr) {
					host._logService.warn(
						'[AgentOS] process 隔离体启动失败 ⇒ 回落进程内档：'
						+ (procErr instanceof Error ? procErr.message : String(procErr)),
					);
				}
				if (transport) {
					host._logService.info(`[AgentOS] pi-kernel gate ON（process 隔离档）：agentId=${request.agentId}`);
					yield* runPiKernelTurnInProc(host, request, { modelProvider, selection, enabledTools, messages: ctx.messages, steeringQueue }, { transport });
					return undefined;
				}
			}
			if (wantProc) {
				host._logService.warn('[AgentOS] isolation_level=process 但传输工厂未注册 ⇒ 回落进程内档');
			}
			host._logService.info(`[AgentOS] pi-kernel gate ON：本 turn 由 piLoop 内核驱动（agentId=${request.agentId}）`);
			yield* runPiKernelTurn(host, request, { modelProvider, selection, enabledTools, messages: ctx.messages, steeringQueue });
			return undefined;
		}
		/**
		 * checkpoint 恢复的 loop messages；作为 runState.messages 的种子（优先于 ctx.messages）。
		 *
		 * ⚠ 求值必须发生在下方 `let messages = (restoredMessages ?? ctx.messages)` 之前。
		 * 2026-09-17 修：此前该变量在 :824 声明、:831 被消费，而真正的赋值在约 190 行
		 * 之后的 resumeFrom 恢复块里 —— 消费时恒为 undefined，断点续跑**静默丢弃**
		 * 全部恢复出来的历史消息（不报错，模型直接失忆），恢复日志却照常打印
		 * "restored N messages"，使故障从日志上完全不可见。
		 * 现改为在消费点之前就地求值，`restoredMessages` 成为 const。
		 */
		const restoredMessages: AgentRunMessage[] | undefined = ((): AgentRunMessage[] | undefined => {
			// 优先 state.messages，回落 state.loopMessages：
			//   · 新快照（P0-a-2 之后）—— runState.messages 已是真相源，由 snapshotRunState 一并落盘。
			//   · 旧快照（P0-a-2 之前）—— runState.messages 从未被写入（恒为空数组），
			//     真实消息只在 loopMessages 里，故必须保留该回落分支，否则旧断点续跑会丢全部历史。
			const resumeState = request.resumeFrom;
			const persisted = (resumeState?.messages && resumeState.messages.length > 0)
				? resumeState.messages
				: resumeState?.loopMessages;
			if (!persisted || persisted.length === 0) { return undefined; }
			const source = (resumeState?.messages && resumeState.messages.length > 0) ? 'messages' : 'loopMessages(legacy)';
			host._logService.info(`[AgentOS] Resume: restored ${persisted.length} messages (from ${source})`);
			return [...persisted];
		})();
	// messages 的唯一真相源是 runState.messages（P0-a-2 收口）。
	// ⚠ 复核实录：SET_LOOP_MESSAGES 过去只写 state.loopMessages，导致 runState.messages
	// 恒为空数组 —— 调用点名字改了、字段没改，属隐蔽分叉。该 action 已修正为写 messages
	// 并同步镜像 loopMessages（见 agentRunState.ts reducer）。
	// 此处是**种子写入点**：checkpoint 恢复 > 上下文构建结果。
	// `messages` 局部变量只是别名，不是独立存储 —— 每次重绑定后由 syncMessages() 回写 runState。
	let messages = (restoredMessages ?? ctx.messages) as AgentRunMessage[];
	runState = reduceRunState(runState, { type: 'SET_LOOP_MESSAGES', messages });
	/**
	 * 把 messages 的当前值同步回 runState（单一真相源）。
	 * 每处 `messages = <expr>` 之后调用一次。
	 *
	 * 采用「赋值 + 同步」而非 setMessages(expr) 包装：本文件有大量跨行 appendMessages 调用
	 * （`messages = appendMessages(messages, {` … `});`），包成函数调用需在正确的收尾行补右括号，
	 * 机械改写极易错位；追加一行调用则是无歧义、可逐处 review 的。
	 */
	const syncMessages = (): void => {
		runState = reduceRunState(runState, { type: 'SET_LOOP_MESSAGES', messages });
	};

	/** 读护栏计数（P0-a-3：跨轮状态单一真相源在 runState.guardrails）。 */
	const guardrails = (): AgentGuardrailCounters => runState.guardrails;

	/**
	 * 部分更新护栏计数。用 patch 语义（而非整对象覆盖）确保调用点只表达
	 * 「我改了哪个计数」，避免漏字段把其它计数静默清零。
	 */
	const patchGuardrails = (patch: Partial<AgentGuardrailCounters>): void => {
		runState = reduceRunState(runState, { type: 'PATCH_GUARDRAILS', patch });
	};

	/** 读收尾门控（P0-a-5：单一真相源在 runState.wrapUp）。 */
	const wrapUp = (): AgentWrapUpState => runState.wrapUp;

	/** 部分更新收尾门控；patch 语义同 patchGuardrails（未提及字段保持原值）。 */
	const patchWrapUp = (patch: Partial<AgentWrapUpState>): void => {
		runState = reduceRunState(runState, { type: 'PATCH_WRAP_UP', patch });
	};

	/** 读轮次重试预算（P0-b：单一真相源在 runState.retry）。 */
	const retry = (): AgentRetryCounters => runState.retry;

	/** 部分更新重试预算；patch 语义同 patchGuardrails（未提及字段保持原值）。 */
	const patchRetry = (patch: Partial<AgentRetryCounters>): void => {
		runState = reduceRunState(runState, { type: 'PATCH_RETRY', patch });
	};

				// ─── 3. Agent Loop（带工具执行） ─────────────────────────
		// 复用 executeAgentTurn 建立的 per-turn AbortController（多窗口取消隔离）。
		// 兜底：若不存在（理论上 executeAgentTurn 一定已建）则就地新建并登记。
		const turnKey = host._turnKey(request.agentId, request.sessionId);
		let turnController = host._activeTurnControllers.get(turnKey);
		if (!turnController) {
			turnController = new AbortController();
			host._activeTurnControllers.set(turnKey, turnController);
		}
		host._loopAbortController = turnController;
		// 本 turn 的取消信号 —— 沿调用链传给工具执行方法，避免并发窗口读到被覆盖的 this 字段。
		const turnAbortSignal = turnController.signal;
		host._approvalService.reset(); // 新会话重置审批记忆
		// 子代理（background）不限轮数（2026-07-25 用户决策：子代理只受 180s 工具活动
	// 超时约束）；主代理保持 MAX_TOOL_ITERATIONS 兜底。1000 仅为失控保险丝。
	const maxToolIterations = request.subAgent?.background
		? 1000
		: MAX_TOOL_ITERATIONS;
	// ─── AgentLoop 策略 + 预算门控（默认 Hermes-ReAct 范式）──
	// 策略实例 per-turn 创建（resolve 每次 new），保证多聊天框/多 session 预算与状态隔离。
	// ─── V3(R3): resume 复用 checkpoint 范式 —— ★ 2026-09-21 改为**纯局部解析** ──
	// 解析链（与 driver 侧 guidance 同形）：`request.resumeFrom?.paradigm ?? request.paradigm`
	//
	// 历史与下线理由：`switch_paradigm` 工具退役后，`paradigmOverride` 注册表只剩「resume 回填」
	// 一个写入者（见 common/paradigmOverride.ts 删除记录）。而该注册表是**进程级、跨 turn** 的，
	// 且生产代码里**没有任何 clear 调用方** ⇒ 一旦某个 session resume 过，该 agentId 在**本进程
	// 剩余生命周期内永久**钉在 checkpoint 范式上（strategy 与 guidance 双双如此）：用户之后改
	// Agent 配置范式**不生效**，直到重启应用，且日志只留一句 "Paradigm override active" ——
	// 与模块头注释声明的「覆盖在 turn 边界生效」自相矛盾。就地解析后：
	//   · 带 resumeFrom 的那一轮仍用 checkpoint 范式（R3 意图不变 ✓）；
	//   · 后续 turn 回到配置值（不再有跨 turn 粘滞，配置变更立即可见）。
	const resumeParadigm = request.resumeFrom?.paradigm;
	const resolvedParadigm = (resumeParadigm ?? request.paradigm) as AgentParadigm;
	const strategy = strategyFactory.resolve(
		request,
		resolvedParadigm,
	);
	if (resumeParadigm && request.paradigm && resumeParadigm !== request.paradigm) {
		host._logService.info(
			`[AgentOS] Resume paradigm: ${resumeParadigm} (config: ${request.paradigm}) — this turn only`);
	}
		const budgetMaxTotal = request.budgetMaxTotal ?? DEFAULT_BUDGET_MAX;
		let budget = new IterationBudget(budgetMaxTotal);
		const loopState = createTurnLoopState();

	// ─── 编排前置层：策略 preLoop（LLM 决策 explore → 并行探索 → 计划队列）──
	// 由 AgentLoop 策略的 preLoop 钩子接管，范式差异由策略实现（budgeted-react=LLM 决策+并行探索，
	// plan-explore=plan_enter 等）。主循环只负责接收计划队列与探索结果并注入 messages。
	let planTasks: ParsedPlanTask[] = [];
	let currentTaskIdx = 0;

	// ─── 策略请求跳过 ReAct 主循环 ────────────────────────────────────────
	// 由 preLoop 返回的 `PreLoopResultMeta.skipMainLoop` 置位（消费点见 :1055）。
	// 语义：该范式（当前唯一使用者为 GraphStrategy）自己已完成全部执行，
	// 主循环不应再发起任何 provider 迭代，直接进入收尾。
	let strategySkipMainLoop = false;

	// ─── 本 turn 执行队列：**注册句柄已随 `planQueueRegistry` 下线**（2026-09-21）────
	// 历史：`plan_register` 工具注册后，主循环用「无工具调用轮推进 + 每轮注入 CURRENT TASK 提醒」
	// 依次执行任务。该工具与其门控已于 2026-09-21 正式退役（pi 路径不消费 legacy 计划队列），
	// 于是 `planQueueRegistry` 的**唯一生产者消失** ⇒ 本模块注册的句柄再也无人写入 ⇒
	// 机制与 UI 卡片一同彻底下线（见 `planQueueRegistry.ts` 的删除记录）。
	// ⚠ 保留的相邻能力：`planTasks` / `currentTaskIdx` 与「推进 + CURRENT TASK 提醒」逻辑**仍然活着**，
	//   因为 **strategy `preLoop` 的 `meta.planTasks`** 是另一条独立写入路径（见下方 `meta.planTasks ?? []`）。
	//   若要重新引入工具驱动的队列，请按 **pi 契约**接线，不要再复活一个 module 级注册表。

	// ─── [ToolAudit] 工具调用合理性审计容器（2026-08-22）────────────────────────
	// ⚠ **必须声明在下面这个 `try` 之前**：SUMMARY 在配对的 `finally` 里输出，而
	// `try` 块内的 `const/let` 对 `finally` 块**不可见**（两者是兄弟作用域，不是
	// 父子）。放进 try 内会得到一串 TS2304 —— 本次就是这么踩到的。
	//
	// 为什么用单一容器对象而非多个散变量：finally 只需依赖 `_audit` 一个名字，
	// 阈值随水位一起记（`threshold` 进 watermark），避免把 MAX_* 常量也全部上提。
	const _audit = {
		records: [] as IToolCallRecord[],
		/** 各闸门本 turn 达到过的**最高**计数（计数器会清零，最终值恒为 0）。 */
		watermarks: new Map<string, { max: number; fired: number; threshold: number; hot?: string }>(),
		maxSingleToolStreak: 0,
		streakNames: new Set<string>(),
		/** toolCallId → 入参指纹（仅只读工具登记），供「同参数重复调用」统计。 */
		argsKeyById: new Map<string, string>(),
		startedAt: Date.now(),
		iterations: 0,
		singleToolStreakThreshold: 0,
	};
	/** 记录闸门水位。threshold 一并存入，供 finally 直接出报告。 */
	const _auditMark = (name: string, count: number, threshold: number, hot?: string): void => {
		const w = _audit.watermarks.get(name) ?? { max: 0, fired: 0, threshold };
		w.threshold = threshold;
		if (count > w.max) { w.max = count; if (hot) { w.hot = hot; } }
		_audit.watermarks.set(name, w);
	};
	const _auditFired = (name: string, threshold: number): void => {
		const w = _audit.watermarks.get(name) ?? { max: 0, fired: 0, threshold };
		w.fired++;
		_audit.watermarks.set(name, w);
	};
	/**
	 * 登记本批次入参指纹。**只对只读工具**做 dup 判定 —— patch 反复改同一文件是
	 * 合法迭代，计入 dup 会大量误报（判据复用 isParallelSafeReadOnlyTool）。
	 */
	const _auditRegisterArgs = (calls: ReadonlyArray<{ id: string; name: string; arguments?: unknown }>): void => {
		for (const c of calls) {
			if (!c?.id || !isParallelSafeReadOnlyTool(c.name)) { continue; }
			try {
				let key = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {});
				// 规范化键序：键顺序不同但语义相同的入参应视为同一次重复。
				try {
					const parsed = typeof c.arguments === 'string' ? JSON.parse(c.arguments) : c.arguments;
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						const obj = parsed as Record<string, unknown>;
						key = JSON.stringify(Object.keys(obj).sort().map(k => [k, obj[k]]));
					}
				} catch { /* 解析失败则保持原始串 */ }
				_audit.argsKeyById.set(c.id, key);
			} catch { /* 指纹取不到就不参与 dup 统计（宁可漏报不误报） */ }
		}
	};

	try {

	// V3: preExplore 结果临时变量（runState 在下方约 80 行后声明，此处只暂存）
	let _preExploreResultStr: string | undefined;

	// ─── V3: resumeFrom — 断点续跑恢复（budget / iteration）────────
	// 从上次落盘的 checkpoint 恢复 budget 和 iteration；messages/preExplore
	// 恢复在 runState 初始化之后（需要 runState 对象）。
	const restored = request.resumeFrom;
	let resumePreExploreDone = false;
	let resumePreExploreResult: string | undefined;
	if (restored?.budgetSnapshot) {
		budget = IterationBudget.restore(restored.budgetSnapshot);
		host._logService.info(`[AgentOS] Resume: restored budget (consumed=${restored.budgetSnapshot.consumed}/${restored.budgetSnapshot.maxIterations})`);
	}
	// checkpoint 消息恢复已上移至 `restoredMessages` 的声明处（约 :833）——
	// 它必须在 `let messages = (restoredMessages ?? ctx.messages)` 之前求值，
	// 留在这里会晚于消费点、恢复结果被静默丢弃。
	if (typeof restored?.iteration === 'number' && restored.iteration > 0) {
		loopState.iteration = restored.iteration;
		host._logService.info(`[AgentOS] Resume: restored iteration=${loopState.iteration}`);
	}
	if (restored?.preExploreDone) {
		resumePreExploreDone = true;
		resumePreExploreResult = restored.preExploreResult;
		host._logService.info('[AgentOS] Resume: preExplore already done, will skip preLoop');
	}
	// ⚠ 这里**故意不恢复 `restored.phase`** —— 快照里有该字段，但它对续跑不可用。
	// checkpoint 每 3 轮才落盘（`:2383` 的 `iteration % 3 === 0`），故恢复出的 phase
	// 最多陈旧 3 轮，无法回答「这批工具究竟执行了没有」。若据 phase === 'tool_executing'
	// 跳过 LLM 直接执行工具，会**重复执行副作用工具**（写文件 / 跑命令 / 发请求）。
	// 现状「重跑整轮」只多烧 token、无正确性损失，是有意的安全取舍。
	// 要改必须先让 checkpoint 每轮落盘并记录工具批次的 settled 状态 ——
	// 见 `.design/agentloop-pi-alignment-refactor.md` 阶段 5（已评估并否决）。
	// 守护：`test/browser/turnHostContract.test.ts` 断言本块不出现 `restored.phase`。

	// ⚠️ 仅顶层 turn 触发（subagent 的 agentId 以 'subagent-' 开头），避免递归触发 preLoop → 又派 subagent → 爆炸
	if (resumePreExploreDone) {
		// 已完成的 preExplore：等待 runState 初始化后再回填
		// （runState 在下方约 80 行后声明，此处只标记）
	} else if (strategy.preLoop && !request.agentId.startsWith('subagent-')) {
		try {
			const loopCtx: PreLoopContext = {
				host, request, chatMode: chatOnly ? 'chatOnly' : '', modelProvider,
				modelId: selection?.modelId ?? '', selection,
				messages, signal: turnAbortSignal, budget, workState: runState.work,
				toolDefs: enabledTools, iteration: 0,
			};
			const meta = yield* strategy.preLoop(loopCtx);
			// ⚠ 策略写 messages 靠 loopCtx.messages 引用；但 preLoop 前刚做过 `let messages = ctx.messages`，
			// 此时 messages 与 ctx.messages 仍是同一数组 —— 策略的原地 push 对双方可见。
			// 收口后必须在策略返回后显式重新对齐一次，否则本文件后续的 messages 重绑定
			// （compactMessages / sanitizeToolPairs 等）会静默丢弃策略追加的消息。
			// P0-a-2 改造后循环内不再原地 push，此处是唯一的「策略原地写」入口。
			if (loopCtx.messages !== messages) {
				messages = loopCtx.messages as typeof messages;
				syncMessages();
			}
			if (meta) {
				planTasks = meta.planTasks ?? [];
				// ─── skipMainLoop 消费（2026-09-16 修：此前声明即死字段）──────────
				// `PreLoopResultMeta.skipMainLoop`（agentLoopStrategy.ts:106）由
				// GraphStrategy.preLoop（graphStrategy.ts:39）返回 true，语义是
				// 「本范式已完成全部工作，不进 ReAct 循环」。但此处原先只读
				// planTasks / findings，该字段**从未被消费** —— graph 范式因此照样
				// 跑完整 ReAct 主循环，与策略声明直接矛盾。
				// 现落实为：置标志 → 跳过 while 主循环 → 直接走收尾。
				if (meta.skipMainLoop === true) {
					strategySkipMainLoop = true;
					host._logService.info('[AgentOS] Strategy preLoop requested skipMainLoop — bypassing ReAct loop');
				}
				if (meta.findings) {
					messages = appendMessages(messages, { role: 'system', content: formatExplorationFindings(meta.findings) });
					syncMessages();
				}
				if (planTasks.length > 0) {
					host._logService.info(`[AgentOS] Strategy preLoop: ${planTasks.length} tasks planned`);
					messages = appendMessages(messages, { role: 'system', content: formatCurrentTaskReminder(planTasks[0], 0, planTasks.length) });
					syncMessages();
				}
			}
		} catch (err) {
			host._logService.warn(`[AgentOS] Strategy preLoop failed: ${err instanceof Error ? err.message : err} — fallback to direct loop`);
		}
		// 暂存 preExplore 完成状态（runState 在下方约 80 行后声明，此时只存临时变量）
		const findingsMsg = messages.find((m: any) => m.role === 'system' && typeof m.content === 'string' && (m.content as string).includes('Exploration Results'));
		_preExploreResultStr = findingsMsg ? String(findingsMsg.content) : undefined;
	}

	// ─── 未完成轮安全续跑计数器（对齐 OpenClaw attempt-scoped 重试）──────
	// P0-b：重试预算已收口进 runState.retry（跨 iteration 状态单一真相源）。
	// 读写经由 retry() / patchRetry()。语义见 AgentRetryCounters 定义处注释。
	// 本轮 provider 结束原因（finish_reason / stop_reason），每轮迭代重置。
	let lastFinishReason: string | undefined;

	// ─── 工具失败连续计数（对齐 Hermes-Agent `_tool_failure_recovery_hint` 的增强版）──
	/*

	// ─── 工具失败连续计数（对齐 Hermes-Agent `_tool_failure_recovery_hint` 的增强版）──		const FIRST_TOKEN_TIMEOUT_MAX_RETRIES = 1;
		const FIRST_TOKEN_TIMEOUT_RETRY_DELAY_MS = 500;
	*/

	// ─── 工具失败连续计数（对齐 Hermes-Agent `_tool_failure_recovery_hint` 的增强版）──
	// 追踪同一工具的连续失败次数。达到阈值时注入 <system-reminder> 引导 LLM
		// 仔细阅读错误消息并换策略，避免盲目重试消耗迭代（详见日志：skill_create 名称缺失×3）。
		// 按工具名分组；任意工具成功后或调用 change 时全局清零。
		const _toolConsecutiveFailures = new Map<string, number>();

		// ─── terminal 连续空输出计数（(no output) 不是工具错误，不会进入 _toolConsecutiveFailures）──
		// 刻意**不收口**进 runState：语义是「本轮内连续」，跨 turn 恢复会带着上轮计数继续累计。
		const MAX_TERMINAL_EMPTY_OUTPUT = 3;

		// ─── 软预算收尾提醒（wall-clock，周期重复）──────────────────────────
		// 子代理等带 softDeadlineMs 的请求：耗时超过软预算即注入
		// 「立即整理发现并收尾」提醒——不打断执行，引导长探索任务在硬超时前
		// 主动收敛产出（日志 1785224874547：Explore 子代理 78 轮线性探索
		// 撞 600s 硬超时、零产出交接）。
		// 原为一次性注入；日志 1785231958842 显示模型会无视首次提醒继续空转
		// （300s 首次提醒后仍空转到 434s 才 salvage），故超阈值后按周期重复提醒。
		const _turnStartedAt = Date.now();
		// 下一次允许注入软预算提醒的 elapsedMs 阈值（0 = 首次超预算即触发）。
		// 刻意**不收口**进 runState：锚在本轮 _turnStartedAt 的墙钟阈值，
		// 跨 turn 恢复会让新 turn 的 elapsed 与上一轮的阈值比较，节流失效。
		// 软预算提醒重复注入周期（ms）——避免每轮刷屏，只在超预算后周期性重提。
		const SOFT_BUDGET_REMINDER_REFIRE_MS = 60_000;

		// ─── 文本搜索连击（search_graph 引导，数据驱动分组见 searchToolGroups）──
		// 连续使用 search_files（grep 类）成功而未触及结构搜索工具时注入一次
		// 引导；结构工具一用即清零，注入后也清零避免每轮刷屏。
		// P0-a-3：计数已收口进 runState.guardrails（跨轮状态单一真相源），
		// 此处仅保留阈值常量。读写经由 guardrails() / patchGuardrails()。
		// 阈值（软/硬）来自 common/turnLoopConstants.ts，见文件顶部 import。
		// 软上限提醒只注入一次（避免每轮刷屏）；streak 不在此清零，以便硬上限仍可达。
		// P0-a-3：已收口进 runState.guardrails.textSearchSoftReminderSent。

		// ─── 单只读工具连击（批量并行引导，2026-08-21 日志 1787302409958）──────
		// 连续多轮「每轮只请求 1 个只读工具」→ 注入批量并行提醒。实测该会话
		// ITER 20-36 连续 17 轮单工具串行，浪费约 11 轮 LLM 往返（每轮重传
		// 27k-60k tokens prompt，是最贵的开销，而这些搜索仅需 100-800ms）。
		// P0-a-3：singleToolStreak 已收口进 runState.guardrails。
		// 最近连击轮次实际用到的工具名（去重，保序），让提醒具体可信。
		const _singleToolStreakNames: string[] = [];
		const MAX_SINGLE_TOOL_STREAK = 4;
		// [ToolAudit] 阈值登记（容器声明在外层 try 之前，见其注释）。
		_audit.singleToolStreakThreshold = MAX_SINGLE_TOOL_STREAK;

		// ── 零进展空转治理（2026-08-22，日志 1787377582459）────────────────────
		// 「整轮工具调用全部被循环检测拦下」的连续轮数。达阈值后升级干预：
		// 先注入强提醒，再强制收尾轮。见 loopReminders.ALL_BLOCKED_* 常量。
		// P0-a-3：allBlockedStreak / allBlockedReminderSent 已收口进 runState.guardrails。

		// ─── XML 文本工具调用泄漏（模型未走 native function call）──────────────
		// 模型把工具调用写成 XML 纯文本（<tool_calls:xxx> / <arg_key:xxx>）时，本系统
		// 按设计不执行它；而 `classifyIncompleteTurn` 会因「有可见文本」判为 complete
		// ——既不续跑也不报错，模型便以为调用没生效而反复输出同样的 XML 试探，
		// 实测表现为聊天框堆满工具解析错误 UI。
		// 对策：上限内丢弃泄漏文本 + 注入「该格式不执行」指令并续跑，让模型改用
		// native function call；超限则交回常规 incomplete-turn 流程收尾，避免无限重试。
		// 刻意**不收口**进 runState：这是「本轮重试预算」，跨轮累计会让新 turn 一开局即超限。
		/** 与其他 incomplete-turn 重试上限对齐（见 agentRunState 的 DEFAULT_*_RETRY_LIMIT）。 */
		const XML_TOOL_LEAK_RETRY_LIMIT = 2;

		// ─── Hermes 工具循环护栏（接入主循环；此前该类是死代码）────────────────
		// 直译自 Hermes-Agent `agent/tool_guardrails.py`。本循环此前只有两把粗粒度
		// 尺子：`detectToolCallLoop`（同签名重复即阻止，不分成败）与
		// `MAX_CONSECUTIVE_TOOL_FAILURES`（连续失败计数）。缺的是**结果维度的无进展**判断。
		//
		// 阈值刻意让 block/halt **只由 no_progress 触发**，理由（避免双重拦截）：
		//   · exact_failure block  → 交给 detectToolCallLoop（它已在同签名重复时阻止）
		//   · same_tool_failure halt → 交给 MAX_CONSECUTIVE_TOOL_FAILURES + 收尾轮机制
		// 若两者叠加，同一次调用会被两套独立规则判定，行为不可预测且难调参。
		// 于是 exact/same_tool 在此**只提供 warn 信号**（追加到 tool result 让模型自纠），
		// 而 block 这一硬手段留给主循环缺失的 no_progress。
		//
		// ⚠ noProgressBlockAfter = 2（而非默认 3）是与 detectToolCallLoop 的**分工**设计：
		// detectToolCallLoop 只看签名、**不分成败也不看结果**，第 3 次同签名即阻止；
		// 若 no_progress 也设 3，它要到第 4 次才触发，会被 detectToolCallLoop 完全遮蔽
		// （永远轮不到，等于没接）。设 2 后两者同在第 3 次触发，而 beforeCall 代码在
		// detectToolCallLoop 之前执行，于是形成清晰分工：
		//   · 同签名 **且** 同结果 → 护栏先拦（文案点明「结果无变化」，误伤更小）
		//   · 同签名 但 结果不同 → 放行给 detectToolCallLoop 拦（文案点明「参数重复」）
		//
		// 生命周期：本 controller 在 executeAgentTurnDirect 内 new，天然 per-turn 重置
		// （while 迭代间**跨轮累积**——这正是检测跨轮循环所需要的）。
		const _toolGuardrail = new ToolGuardrailController({
			warningsEnabled: true,
			hardStopEnabled: true,
			exactFailureWarnAfter: 2,
			// 同 (name+args) 失败 5 次 → block 后续同签名调用（对齐 Hermes 默认 5）。
			// 设 5 而非 Hermes 的 3：detectToolCallLoop 已在同签名第 3 次触发，
			// 本门设更低会被它完全遮蔽（永远轮不到）；设 5 保留「detectToolCallLoop
			// 拦签名、本门兜更长期的重放」这条分工，两条规则各自可达。
			exactFailureBlockAfter: 5,
			sameToolFailureWarnAfter: 3,
			// 同名工具（非失败容忍名单）失败 8 次 → halt 退出主循环（对齐 Hermes 默认 8）。
			// ⚠ 此前为 Number.MAX_SAFE_INTEGER（永不 halt），导致 same_tool_failure 只
			// 剩 MAX_CONSECUTIVE_TOOL_FAILURES 的 warn 兜底 —— 责任链断裂，模型可无限
			// 反复试探同一工具而不被叫停（日志实证：consecutiveFail 3/3 FIRED 后仍续跑
			// 到 4/3）。恢复真实阈值后，该信号重新具备硬停能力。
			sameToolFailureHaltAfter: 8,
			noProgressWarnAfter: 2,
			noProgressBlockAfter: 2,                            // 与 detectToolCallLoop(3) 分工，见上
		});
		/** beforeCall 判定为 block 的调用，记录其 decision 文案以便回填合成结果。 */
		const _guardrailBlocked = new Map<string, IToolGuardrailDecision>();

		// ─── AgentRunState（reducer 化 Step 3）────────────────────────────────
		// ⚠ 本处原为 `runState` 的声明点，已上移至 turn 起点（约 :692）——
		// planFilePath 与 preLoop 上下文都在此处之前就要读 runState.work。
		// 此处只保留说明；iteration 作为 while 循环步进计数器仍为 loop 局部
		// （对齐 LangGraph：step 计数属 graph runtime，不进 state schema）。
		// 真实 prompt token 按 agentId::sessionId 双键隔离，避免同 agent 多 session
		// 并行时压缩触发估算互相污染。

		// ─── V3: 回填 resume preExplore / 本轮 preExplore 状态到 runState ──
		if (resumePreExploreDone) {
			runState = reduceRunState(runState, { type: 'SET_PRE_EXPLORE', done: true, result: resumePreExploreResult });
			if (resumePreExploreResult) {
				messages = appendMessages(messages, { role: 'system', content: formatExplorationFindings(resumePreExploreResult) });
				syncMessages();
			}
		} else if (_preExploreResultStr !== undefined) {
			runState = reduceRunState(runState, { type: 'SET_PRE_EXPLORE', done: true, result: _preExploreResultStr });
		}

		// ─── 工具失败恢复提示（借鉴 Hermes-Agent `_tool_failure_recovery_hint`）──
		// Hermes-Agent: 工具失败后注入针对性恢复建议，引导 LLM 换方案而非盲目重试。
		// 不对成功结果注入任何提示。


		// ─── Plan-Execute-Reflect 反思阶段跟踪 ───────────────────
		// 当 LLM 完成工具调用并给出最终回复后，注入反思提示让它检查是否有遗漏。
		// 参考 OpenSearch ML Commons 的 PLAN_EXECUTE_AND_REFLECT 模式。
		// 反思开关与文件修改类工具名集合来自 common/turnLoopConstants.ts（见顶部 import）。

		// ─── 上下文压缩初始化（对齐 ExecutionProvider Path 2）──────────
		// Direct Mode 之前完全没有压缩，消息数一路增长直到撑爆上下文窗口。
		// 这里复用 ContextManager.compressContext 做 Hermes 三段式压缩，
		// 与 ExecutionProvider 保持一致的触发阈值和诊断日志。
		const contextManager = new ContextManager(modelProvider, selection.modelId);
		contextManager.setLogger({
			info: (msg: string) => host._logService.info(msg),
			warn: (msg: string) => host._logService.warn(msg),
			error: (msg: string, error?: unknown) => host._logService.error(msg, error),
			debug: (msg: string) => host._logService.debug(msg),
		});
		// 设置当前 model（用于 _getEnabledTools 实时查表 context window）
		// 对齐 Hermes-Agent `model_tools._resolve_active_context_length()` 每次实时查表
		host._setCurrentModel(modelProvider, selection.modelId);
		// 解析模型真实上下文窗口（token），用于计算压缩阈值
		const compressionWindow = await host._resolveContextWindow(modelProvider, selection.modelId);

		// ─── 检索式上下文：每轮 turn 开始前独立注入（对齐 agentmemory mem::context）──
		// 把记忆检索从「仅压缩时」提前到每轮 llm_streaming 前：turn 开始时即检索相关
		// 对话上下文并作为独立 system 消息注入，使 LLM 每轮都能拿到历史记忆；同时把
		// 当前消息增量外置到记忆（含本 turn 新到的 user 消息），保证首轮压缩也有数据、
		// 彻底去除首次 37s。仅在 RETRIEVAL_COMPACTION_ENABLED 开启时执行。
		if (RETRIEVAL_COMPACTION_ENABLED) {
			const rp = host.getActiveMemoryProvider();
			if (rp && (rp as any).recallFormatted) {
				// ★ P2（2026-08-21，日志 1787289570191）：先把 UI 切到「正在检索历史上下文」。
				// 该日志 `sendMessage FIRST_DELTA elapsed=31966ms type=memory_injected`
				// —— 用户点发送后 **32 秒**才看到任何反应，全花在下面的外置 + 检索上，
				// 期间界面完全静默，体感等同卡死。
				// 与 'compressing' 完全同构：phase 进 runState 供 checkpoint/UI 读取。
				const _phaseBeforeRetrieval = runState.phase;
				runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'retrieving' });
				yield { type: 'phase_change', phase: runState.phase };
				try {
					// 1) 增量外置：先把当前 messages（含本 turn 新到的 user 消息 + 历史）
					//    写进记忆（await 保证落盘），保证本 turn 内触发压缩时 recallFormatted
					//    已有数据可取，彻底去除首次 37s。
					await host._storeTurnObservations(rp, request.agentId ?? 'default', request.sessionId ?? '', messages);
					// 2) 检索相关上下文并注入为独立 system 消息（前缀与 contextManager
					//    INJECTED_CONTEXT_PREFIX 一致，压缩时会被剥离，避免与摘要重复）。
					const r = await host._retrieveContextOnly(
						rp, request.agentId ?? 'default', request.sessionId ?? '', messages,
						Math.floor(compressionWindow * RETRIEVAL_BUDGET_RATIO),
					);
					if (r && r.context.trim()) {
						messages = host._injectRetrievalSystemMessage(messages, r.context, r.source);
						syncMessages();
						host._logService.info(
							`[AgentOS][Retrieval] injected retrieved context at turn start ` +
							`(source=${r.source}, ~${Math.ceil(r.context.length / 3)} tokens) for agent ${request.agentId}`
						);
						yield {
							type: 'memory_injected',
							content: `已检索注入历史上下文 (~${Math.ceil(r.context.length / 3)} tokens)`,
							metadata: { source: r.source, retrieval: true },
						} as any;
					}
				} catch (reErr) {
					host._logService.warn(
						`[AgentOS][Retrieval] turn-start retrieval failed: ` +
						`${reErr instanceof Error ? reErr.message : String(reErr)}`
					);
				} finally {
					// 恢复检索前的 phase（无论成功/失败/无结果都必须复位，
					// 否则 UI 会一直停在「正在检索历史上下文」）。
					// 用 finally 而非在 try 末尾：上面的 catch 是"失败开放"的，
					// 复位逻辑必须覆盖所有出口。
					runState = reduceRunState(runState, { type: 'SET_PHASE', phase: _phaseBeforeRetrieval });
					yield { type: 'phase_change', phase: runState.phase };
				}
			}
		}

		// 策略可覆盖的「本轮工具面」：delegation 范式会把主循环限制为
		// supervisor 工具（delegate_task / new_agent / plan…），所有执行工具交由
		// sub-agent。该覆盖在每轮「重新收集工具」之后再次应用，避免被全量列表冲掉。

		// P1: 上一轮 LLM 响应回传的真实 prompt token（provider usage，含 cache）。
		// compressContext 优先用它判定，取代低估的 char/4 粗估。首轮=0 自动退回粗估。
		// 上一轮真实 prompt token 由 runState.lastRealPromptTokens 承载（初始值取自实例字段，
		// 跨 turn 持久化，不再每轮归零）。

	// ─── 上下文压缩段（已迁出 → parts/turnContextCompaction.ts）─────────────
	// 每轮迭代开头执行的四级阶梯：廉价剪枝 → 工具结果去重 → 消息数硬上限 →
	// Hermes 三段式压缩。此处仅保留把闭包捕获变量桥接为 deps/state 的薄委托。
	//
	// force（P0-1 溢出恢复）：溢出 400 时服务端 maxInputTokens 可能小于本地
	// window×0.3，常规触发判定会误 skip；force=true 绕过阈值/消息数/冷却/防抖
	// 判定强制压缩（仅溢出恢复路径使用）。
	async function* _compressContextIfNeeded(force?: boolean): AsyncGenerator<IChatStreamDelta> {
		const deps: IContextCompactionDeps = {
			host: host as unknown as IContextCompactionHost,
			request,
			contextManager: contextManager as unknown as IContextCompactionManager,
			compressionWindow,
			// getter：MCP 工具可能中途就绪，快照会让 schema token 估算停留在首轮口径。
			enabledTools: () => enabledTools,
			estimateToolsSchemaTokens,
		};
		const state: IContextCompactionState = {
			messages: () => messages,
			setMessages: next => { messages = next; },
			syncMessages,
			runState: () => runState,
			dispatchRunState: action => { runState = reduceRunState(runState, action); },
			hardPrunePending: () => loopState.hardPrunePending,
			setHardPrunePending: next => { loopState.hardPrunePending = next; },
		};
		yield* compactContextIfNeeded(deps, state, force);
	}

	// ─── Plan 模式处理闭包（2026-07-27 自主循环提取，~225 行）──────────────────
	// plan_explore / plan_enter / plan_exit 拦截器：工作模式切换 + 计划文件管理 +
	// 用户审批 + DAG 编排。参数传递循环局部变量（effectiveToolCalls/toolResults/endedToolIds），
	// 闭包捕获 messages/runState/workState/planFilePath/planEnterCalled/planExitCalled/host/request。
	// 返回 'done' 表示 plan_exit 编排完成（主循环应 return）；undefined 表示继续。
	/**
	 * Plan 模式控制工具拦截 —— 实现已迁至 `parts/turnPlanModeTools.ts`。
	 *
	 * 这里保留一层薄委托而非让调用点直接引用 Part：Part 需读写 5 个 turn 局部
	 * 可变量（`runState` / `messages` / `planFilePath` / `planEnterCalled` /
	 * `planExitCalled`），闭包是当前唯一能同时读到它们最新值、又能把新值写回的
	 * 位置。getter/setter 形式的 state 面把这份耦合显式化，等 L2 驱动层落地后
	 * 由 `ITurnPartContext` 统一承载。
	 */
	async function* _handlePlanModeTools(
		effectiveToolCalls: any[],
		toolResults: any[],
		endedToolIds: Set<string>,
	): AsyncGenerator<IChatStreamDelta, 'done' | undefined> {
		return yield* handlePlanModeTools(
			{ host: host as unknown as IPlanModeToolsHost, request },
			{
				messages: () => messages,
				setMessages: (next: AgentRunMessage[]) => { messages = next; },
				syncMessages,
				runState: () => runState,
				dispatchRunState: (action: AgentAction) => { runState = reduceRunState(runState, action); },
				planFilePath: () => planFilePath,
				setPlanFilePath: (next: string | undefined) => { planFilePath = next; },
				planEnterCalled: () => planEnterCalled,
				setPlanEnterCalled: (next: boolean) => { planEnterCalled = next; },
				planExitCalled: () => planExitCalled,
				setPlanExitCalled: (next: boolean) => { planExitCalled = next; },
			},
			effectiveToolCalls,
			toolResults,
			endedToolIds,
		);
	}


	// ─── 后处理段（已迁出 → parts/turnPostIteration.ts）────────────────────
	// 每轮迭代末尾执行：delegation ledger 更新 → memory hooks → orphan tool reconcile →
	// guardrail（all tools failed）→ shouldTerminateToolBatch → codebase memory 工具检测 →
	// memory capture → budget consume → checkpoint 持久化。
	// 返回 'done' 表示提前结束；undefined 表示继续。
	//
	// `buildCheckpointSnapshot` 经 deps 注入而非由 Part 直接 import：其真源在本文件，
	// Part 反向 import 会形成循环依赖。
	async function* _postIterationCleanup(
		toolResults: any[],
		localExecutedCalls: any[],
		effectiveToolCalls: any[],
		startedToolIds: Set<string>,
		endedToolIds: Set<string>,
		trimmedAssistantContent: string,
		memoryProvider: any,
		iteration: number,
	): AsyncGenerator<IChatStreamDelta, 'done' | undefined> {
		const deps: IPostIterationDeps = {
			host: host as unknown as IPostIterationHost,
			hookBus: hookBus as unknown as IPostIterationHookBus,
			request,
			budget,
			strategy: strategy as unknown as { takeDelegationRound?(): boolean } | undefined,
			resolvedParadigm,
			buildCheckpointSnapshot,
		};
		const state: IPostIterationState = {
			messages: () => messages,
			runState: () => runState,
			dispatchRunState: action => { runState = reduceRunState(runState, action); },
		};
		return yield* runPostIterationCleanup(deps, state, {
			toolResults,
			localExecutedCalls,
			effectiveToolCalls,
			startedToolIds,
			endedToolIds,
			trimmedAssistantContent,
			iteration,
		});
	}

	// P0-1（2026-08-11，日志 1786432061200）：上下文溢出反应式压缩重试标志。
	// 流调用抛 HTTP 400 code 11133 / invalid_parameter_value 时，仅允许触发一次
	// 「强制压缩 + 自动重试」；重试后仍失败则走原有 error 路径结束（防死循环）。

	// ─── 迭代硬上限 / 预算耗尽的「收尾轮」（2026-08-20）────────────────────────
	// 此前撞上限只 `yield done` 就结束，导致：末轮发起的工具调用（尤其 delegate_task）
	// 结果 append 进 messages 后再无轮次消费 → 成果 100% 丢弃、回答停在承诺句
	// （日志 1787214724132：第 50/50 轮起 delegate_task，子代理跑 23 轮/6min 后主循环已退出）。
	// 现额外允许跑一轮「禁用工具、仅输出结论」的收尾轮：循环上限 +1，该轮把
	// _iterationToolDefs 置空并注入 hardLimitWrapUpReminder（该 reminder 早已写好但
	// 一直无生产引用，仅测试在用）。预算耗尽路径同样先转收尾轮再硬停。
	const HARD_STOP_ITERATIONS = maxToolIterations + 1;
	// P0-a-5：收尾门控（done / forced / reasonReminderInjected /
	// hardLimitReminderInjected / budgetLowWarned）
	// 已收口进 runState.wrapUp，经 wrapUp() / patchWrapUp() 读写。
	// ⚠ done 与 forced 的语义区分见 AgentWrapUpState 定义处注释，不可合并。
	/** 剩余轮次 <= 该值时注入临近预算预警（够模型收一次尾，又不至于过早悲观）。 */
	const BUDGET_LOW_REMAINING_THRESHOLD = 3;

	while (!strategySkipMainLoop && loopState.iteration < HARD_STOP_ITERATIONS) {
		loopState.iteration++;
		// ─── 每轮门控段（abort / steering / 预算 / 收尾 / 策略 prepareIteration）──
		// 抽出至 turnIterationGate.ts：本段内 messages 重绑定 6 次、enabledTools 2 次，
		// 且策略会原地改写 messages 数组，故经「回调 + accessor」回写而非返回值。
		// 返回 shouldBreak=true 时对应原 break（abort 或预算硬停）。
		const _gate = runIterationGate(
			{
				host, request, loopState, budget, strategy, steeringQueue, turnAbortSignal,
				modelProvider, selection, chatOnly, trivialRequest, workState: runState.work,
				turnStartedAt: _turnStartedAt,
			},
			{
				messages: () => messages,
				setMessages: (next) => { messages = next; syncMessages(); },
				enabledTools: () => enabledTools,
				setEnabledTools: (next) => { enabledTools = next; },
				wrapUp,
				patchWrapUp,
			},
			maxToolIterations,
			SOFT_BUDGET_REMINDER_REFIRE_MS,
			BUDGET_LOW_REMAINING_THRESHOLD,
		);
		if (_gate.shouldBreak) { break; }

			// 每轮迭代重置上一轮的 finishReason（仅当前轮有效）
			lastFinishReason = undefined;
		// 每轮进入 LLM 推理前显式置 phase=llm_streaming（对齐 UI 广播，
		// phase 进 runState 供 Step 5 checkpoint 读取）。压缩块内会切到
		// 'compressing' 再切回 'llm_streaming'，runState.phase 跟随。
		runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'llm_streaming' });
		// 广播 phase_change=llm_streaming：在多轮 AgentLoop 中，所有轮次复用同一条
		// assistant 消息（_streamingAssistantId 不重置），第 1 轮 text delta 到达后
		// isThinking 已被置 false。此处广播使 UI 在「LLM 结束 → 下次 LLM 发起前」将
		// 气泡重新置为「思考中」（isThinking=true、thinking 文本为空），首个 text delta
		// 到达后由 nativeChatEditorPane 的 text case 置 isThinking=false 自动隐藏。
		// 这是「下一轮 LLM 发起前显示思考中」的核心触发点（压缩恢复处 line ~868
		// 已同类广播一次，此处覆盖所有正常轮次）。
		yield { type: 'phase_change', phase: runState.phase };
			// Yield to the event loop every 5 iterations to prevent UI freeze
			// during long-running agent loops (P2-6 fix).
			if (loopState.iteration % 5 === 0) {
				await new Promise<void>(r => setTimeout(r, 0));
			}
			host._logService.info(`[AgentOS] Direct mode iteration ${loopState.iteration}/${maxToolIterations}`);

			yield* _compressContextIfNeeded();


			// ─── 每轮迭代重新收集工具 ──────────────────────────────────
			// MCP 服务器可能在 agent loop 进行中才完成连接并暴露工具。
			// 每轮迭代重新收集确保新可用的 MCP 工具被纳入 LLM 请求。
			// 首轮使用循环前已收集（含等待）的 enabledTools；后续轮次刷新。
			if (loopState.iteration > 1) {
				const refreshed = await host._getEnabledTools(request.agentId, request.agentGraph, request.toolsetsOverride,
					host._resolveHardPermissionForWorkMode?.(runState.work.mode) ?? host._resolveHardPermission(request), request.excludedTools, request.allowedTools);
				if (refreshed.length !== enabledTools.length) {
					const newMcp = refreshed.filter((t: any) => t.category?.startsWith('mcp:')).map((t: any) => t.name);
					host._logService.info(`[AgentOS] Iteration ${loopState.iteration}: tools refreshed ${enabledTools.length} → ${refreshed.length} (MCP: [${newMcp.join(', ')}])`);
				}
				enabledTools = refreshed;
			}

			// 策略工具面覆盖（delegation 范式：主循环仅 supervisor 工具）。
			// 必须在「每轮重新收集工具」之后应用，否则会被全量工具列表冲掉。
			if (loopState.iterationToolDefs) {
				enabledTools = loopState.iterationToolDefs;
			}

			// trivial 请求：每轮剔除重探索/委托/技能类工具，避免无意义深度探索与图谱构建
			// （必须在「每轮重新收集工具」之后应用，否则会被全量工具列表冲掉）
			if (trivialRequest) {
				const _before = enabledTools.length;
				enabledTools = enabledTools.filter((t: any) => !TRIVIAL_BLOCKED_TOOLS.some((b) => String(t.name).includes(b)));
				if (enabledTools.length !== _before) {
					host._logService.info(`[AgentOS] trivial request: restricted exploration tools (${_before} → ${enabledTools.length})`);
				}
			}

			// ── Fork 前缀缓存（请求构造端接 ForkContext）─────────────────────────
			// 计算本请求自身的冻结前缀（system + tools），并与父级 ForkContext 比对对齐。
			// 对齐时请求构造端（MessageFormatConverter + BYOK provider）会在该前缀边界
			// 注入 cache_control 断点 → 命中父级已写入的 prompt cache（而非重计费稳定大前缀）。
		// 抽出至 turnIterationGate.ts：纯计算 + 一次 map 写入 + 一条诊断日志，
		// 返回 parentFork 供下方请求构建回填（含「先读旧值再写新值」的顺序约束）。
		const parentFork = computeForkContext(
			host,
			request,
			effectiveSystemPrompt,
			enabledTools,
		);

		// 构建模型选项（注入工具 + ForkContext）
		const modelOptions: IModelOptions = {
			temperature: request.options?.temperature ?? 0.7,
			maxTokens: request.options?.maxTokens ?? 4096,
			systemPrompt: effectiveSystemPrompt,
				tools: enabledTools.length > 0 ? enabledTools : undefined,
				// 收尾轮双保险（2026-08-20，对齐 MiMo-Code prompt.ts:4090 的
				// `toolChoice: isLastStep ? "none" : ...`）：
				//   ① tools 已被置空（上方 _iterationToolDefs=[] → enabledTools=[] →
				//      这里传 undefined）——物理上没有可调用的工具；
				//   ② 再显式 toolChoice:'none' ——协议层禁止调用。
				// 只靠 ① 的隐患：provider 对「tools 字段缺失」的行为未定义（有的忽略、
				// 有的仍按上一轮缓存的工具面推理）；'none' 是 OpenAI/Anthropic 都明确
				// 支持的语义，模型侧收到的是「禁止调用」而非「没有可调用的」。
				toolChoice: _gate.isWrapUpRound ? 'none' : undefined,
				stop: request.options?.stop,
				// 思考/推理配置：由聊天输入框 thinking UI 控件透传至此，
				// 各 model provider 据此映射到原生 API 参数（thinking/thinkingConfig/reasoning_effort）。
				// P0（2026-08-17，日志 1786937164284 对话半途停止）：Agent 内部循环中，用户
				// 未在聊天框显式开 thinking 时 request.options?.reasoning === undefined。此前
				// undefined 直接透传 → 扩展侧落回「模型能力字段」→ reasoning-capable 模型
				// 默认开启且 effort 命中 server-default。若 catalog 推荐 effort=high（如
				// hy3-ioa / 部分 reasoning 模型），会触发 fake-completion：模型把工具调用意图
				// 完整"想"在 reasoning_content 里，visible content 只输出半句话就 finishReason=stop
				// 且 toolCalls=0 → AgentOS 判「无工具调用」提前结束对话。
				// 修复：Agent 循环场景 reasoning 未显式设置时强制关闭（enabled:false），
				// 用户显式开启（enabled:true）仍原样透传、尊重用户。多轮工具迭代不依赖
				// 每轮长 thinking，关闭后无行为损失，反而规避 high 的 fake-completion。
				reasoning: request.options?.reasoning ?? { enabled: false },
				// Fork 前缀缓存：透传父级 ForkContext（含迭代级回填）给请求构造端判对齐 + 打 cache 断点。
				forkContext: parentFork,
			};

			// 调用模型
			// 注意：抓包对齐的三个独立 id（不可混用）：
			//   conversationId  会话级稳定（同一 sessionId 复用同一个）→ X-Conversation-ID
			//   requestId       请求级，每轮 iteration 都重新生成      → X-Conversation-Request-ID
			//   previousResponseId  上一轮响应流的 id（链式衔接）        → 请求体 previous_response_id
			// 历史串台 bug：仅用单一 sessionId 当所有 id，服务端 KV 缓存按 conversation-id
			// 跨会话碰撞 → 命中旧上下文、忽略本地 priorMessages。此处分离三 id 杜绝碰撞。
			//
			// ⚠ prevRespId 读不到值是**预期的**，不是缺陷（2026-08-21 排查日志
			// 1787301913662 时曾据此误判为「链式衔接失效」，特此记录避免重复踩坑）：
			//   · 本 Map 只由 `delta.responseId` 喂（见下方 usage 捕获处），而 responseId
			//     仅在 **BYOK / llmBridgeNode** 路径可得（它们直接解析原始 SSE 的 `parsed.id`）；
			//   · **扩展 provider 路径（codebuddy-provider）自己维护 session→id 映射并直接
			//     注入请求体 `previous_response_id`**（含 400 stale-id 回退重试），根本不读
			//     这里传下去的 `context.previousResponseId` —— 链式衔接一直是生效的
			//     （该次日志实测 31/32 次请求都带上了 previous_response_id）。
			// 故此处显示 `(none/provider-managed)` 表示「由 provider 自行链式衔接」。
			const conversationId = host._getOrCreateConversationId(request.sessionId);
			const requestId = host._generateHexId();
			const previousResponseId = request.sessionId
				? host._lastResponseIdBySession.get(request.sessionId)
				: undefined;
			const context: { agentId?: string; sessionId?: string; conversationId?: string; requestId?: string; previousResponseId?: string } = {};
			if (request.agentId) {
				context.agentId = request.agentId;
			}
			if (request.sessionId) {
				context.sessionId = request.sessionId;
			}
			context.conversationId = conversationId;
			context.requestId = requestId;
			if (previousResponseId) {
				context.previousResponseId = previousResponseId;
			}

			// ── promptOverhead 快照（2026-08-21 修，日志 1787315962316）────────────
			// 在**请求发出的这一刻**记录粗估，供该请求自己的 usage 回来后配对相减：
			//     promptOverhead = realPrompt − estAtRequest − toolsSchemaAtRequest
			// ⚠ 口径澄清（2026-08-22 修正原注释的错误结论）：`messages` **已包含**
			// 冻结前缀等全部 system 消息（见本文件上方「Prepended frozen system prefix」），
			// 因此 promptOverhead **不是** system prompt 的体量，而是
			// 「真实 tokenizer 与 CJK 加权粗估的偏差 + 请求体固定结构开销」。
			// 结论不变的是它的用法：**突然抬高即表示有内容进了请求体却没进
			// `_estimateTokens` 口径**（压缩阈值与收益投影全建在粗估上）。
			// 想知道「谁在吃 context」请看下方 [PromptBudget] 预算表，别用这个残差猜。
			// ⚠ 绝不能改回「用下一轮的 est 减上一轮的 real」：那样会被轮间消息增长
			// 淹没，实测出现 -9166 这类大负值（est 11204→21985 增长 10781，real=28649：
			// 用本轮 est 得 -9166，用同一请求的 est 得 +1615 才是真实开销）。
			const _estAtRequest = contextManager.estimateMessagesTokens(messages as any);
			const _toolsSchemaAtRequest = estimateToolsSchemaTokens(enabledTools as ReadonlyArray<any>);

			// ── [PromptBudget] 提示词预算表（P1，对齐 Hermes `prompt-size`）──────────
			// 实现已迁出至 parts/turnRequestDiagnostics.ts（纯日志，失败不阻断请求）。
			emitPromptBudgetReport({
				logService: host._logService,
				messages,
				messagesTokens: _estAtRequest,
				toolsSchemaTokens: _toolsSchemaAtRequest,
				frozenPrefixSegments: request.promptSegments,
				contextWindow: compressionWindow,
				enabledTools: enabledTools as ReadonlyArray<unknown>,
				groupToolSchemaCosts: (tools) => groupToolSchemaCosts(tools as ReadonlyArray<any>),
				lastPromptBudgetTotal: loopState.lastPromptBudgetTotal,
				onReported: (totalTokens) => { loopState.lastPromptBudgetTotal = totalTokens; },
				isToolCallConfirmationEnabled: typeof host._isToolCallConfirmationEnabled === 'function'
					? host._isToolCallConfirmationEnabled()
					: true,
			});

			// ─── [TagTrace] `<tag:id>` 伪标签溯源 · 请求侧扫描 ──────────────
			// 二分定位的决定性切面：发给模型的请求里**是否已经存在**这类标签。
			//   · 请求侧**有** → PRIMING：模型看见了才模仿，源头在工具结果 / 历史
			//     消息 / 记忆注入 / skill 内容，应去治理那个内容源；
			//   · 请求侧**无**、响应侧才有 → 模型自发输出（训练格式残留），
			//     只能靠提醒 + 剥离兜底。
			// 两种成因治理方式完全不同，不分清就会一直治标。故此处逐条消息扫描并
			// 报出**首次出现的位置与角色**，直接指向源头。
			tagTraceScanRequest(messages, loopState.iteration, host);

			host._logService.info(`[AgentOS] Calling modelProvider.chat(modelId=${selection.modelId}, messages=${messages.length}, tools=${enabledTools.length}) convId=${conversationId} reqId=${requestId} prevRespId=${previousResponseId ?? '(none/provider-managed)'}`);

			// ─── 诊断：列出实际发送给 LLM 的所有工具名 ──────────────────
			// 实现（含「无 MCP 工具」的子代理/首次/后续三分叉）已迁出至
			// parts/turnRequestDiagnostics.ts。
			logToolsSentToLlm({
				logService: host._logService,
				enabledTools: enabledTools as ReadonlyArray<{ name?: string; category?: string }>,
				isSubAgent: !!request.subAgent,
				agentId: request.agentId,
				sessionId: request.sessionId,
				noMcpWarnedSessions: _noMcpWarnedSessions,
				getLastMcpServerStats,
			});
			// 收集模型响应
			let assistantContent = '';
			let thinkingContent = '';
			// 诊断：保留最后一个 usage delta 供 try-catch 外的 Model response 日志输出
			let _lastUsageDelta: any = null;
			// P0-leak-fix: accumulate streamed text in chunk arrays and join ONCE
			// after the stream. Per-delta `assistantContent += delta.content` built a
			// V8 ConsString rope (one node per delta) that ballooned heap usage.
			const _assistantChunks: string[] = [];
			const _thinkingChunks: string[] = [];
			const assistantToolCalls: IToolCallInfo[] = [];
			// Streaming tool call assembly using OpenClaw-inspired assembler
			// Provides: incremental argument buffering, size limits, partial JSON parsing
			const toolCallAssembler = new StreamingToolCallAssembler();
			// ─── Track all tool_start IDs we yield this iteration ──────────────
			// Any ID that gets a tool_start MUST eventually get a tool_end, otherwise
			// the webview's tool card will spin forever. Tool calls can be lost between
			// tool_start and tool_end via:
			//   1. Deduplication (`deduplicateToolCalls`) — duplicate name+args dropped
			//   2. Phantom filter (render_type=None && default_show=false)
			//   3. Provider not found (executed=false in _executeToolCalls)
			//   4. Any execution exception that bypasses results.push()
			// We track started IDs and emit a synthetic tool_end with success=false
			// for any ID that did not get a real tool_end before the iteration ends.
			const chatMessageStream = new AGUIChatMessageBuilder();
			const startedToolIds = new Set<string>();
			const endedToolIds = new Set<string>();

			try {
				host._logService.info(`[AgentOS] modelProvider.chat: creating stream...`);
				// ─── 发送前 tool 配对守卫（治本对抗 IOA 网关 HTTP 400 code 11133）─────
				// 压缩(head/tail 切割)、冷却期跳过压缩、或历史回灌都可能留下
				// 「assistant 发起 tool_call 但缺对应 tool 结果」的悬空调用。
				// OpenAI/IOA 网关强制 tool_call 必须被对应 tool 结果应答，失配即
				// 整轮 400。这里在真正发请求前把序列修成协议合法形态（纯函数，
				// 无失配时保持等价，不改变正常流程）。
				const _beforePairGuard = messages.length;
				messages = ContextManager.sanitizeToolPairs(messages);
				syncMessages();
				if (messages.length !== _beforePairGuard) {
					host._logService.warn(`[AgentOS] Tool-pair guard: dropped ${_beforePairGuard - messages.length} orphan/dangling tool message(s) before send (${_beforePairGuard} → ${messages.length})`);
				}
				const t0_modelCall = Date.now();
				// ─── 诊断：pre-call 快照（帮助定位"突然中断"）────────────
				// 记录发出请求时的完整上下文状态：消息数、估算 token、真实 token、
				// 压力等级（≥3 即 ≥85% 窗口，会触发 P4 checkpoint 重建）、
				// 上次压缩距今时间、上次响应 id。事后可对照"中断时刻"的这些值。
				{
					const _est = host._estimateMessagesTokens(messages);
					const _real = runState.lastRealPromptTokens ?? 0;
					const _pressure = ContextManager.getPressureLevel(_real || _est, compressionWindow);
					const _sinceCompress = host._lastCompressionTime > 0
						? Math.round((Date.now() - host._lastCompressionTime) / 1000)
						: -1;
				host._logService.debug(
					`[AgentOS][Diag] PRE-CHAT snapshot | ` +
						`iter=${loopState.iteration} model=${selection.modelId} convId=${conversationId} reqId=${requestId} | ` +
						`msgs=${messages.length} enabledTools=${enabledTools.length} | ` +
						`estTokens=${_est} realPromptTokens=${_real} compressionWindow=${compressionWindow} | ` +
						`pressure=${_pressure}/3 (${compressionWindow > 0 ? Math.round((_real || _est) / compressionWindow * 100) : 0}%) | ` +
						`lastCompressionAt=${_sinceCompress >= 0 ? _sinceCompress + 's ago' : 'never'} | ` +
						`prevRespId=${previousResponseId ?? '(none/provider-managed)'} | ` +
						`abortSignal=${host._loopAbortController?.signal?.aborted ? 'ABORTED' : 'active'}`
					);
				}
				// ─── Plan 阶段 per-iteration reminder（P0 2026-08-18 接线）──────────
			// buildPlanSystemReminder（5 阶段规划工作流指引）此前生产代码零调用——
			// plan 阶段无任何工作流指引注入，只有 plan_exit 后的 buildBuildSwitchReminder
			// 还活着。现按其设计意图（chatModeConfig 注释：per-iteration injection）
			// 每轮 LLM 调用前注入到**发送副本**：
			//   - 不写入 messages 本体 → 长循环不堆积重复 reminder（压缩/checkpoint 亦不受污染）
			//   - 末尾追加 system 消息（与 buildBuildSwitchReminder 同 role），不破坏
			//     system 前缀缓存（fork 指纹基于首条 system + tools，不受末尾消息影响）
			// 仅主代理注入：plan 子代理（explore）继承的是只读权限天花板，
			// 不应收到「写计划文件 + plan_exit」的 5 阶段指令。
			const { stream } = buildTurnLlmStream({
				host,
				modelProvider,
				selection,
				modelOptions,
				context,
				isSubAgent: !!request.subAgent,
				workMode: runState.work.mode,
				planFilePath,
				messages: () => messages,
				lastRealPromptTokens: runState.lastRealPromptTokens,
			});
			let _firstDeltaReceived = false;
			// ─── 诊断：per-delta 类型追踪 + heartbeat ─────────────────────
			// 区分 text/reasoning/tool_call/usage/done 等 delta 类型并分别计数，
			// 追踪"上一次文本 delta 距今多久"（流式 idle 监测），
			// 定期 heartbeat 帮助事后还原"中断时刻"的流进度。
			let _totalDeltas = 0;
			let _textDeltas = 0;
			let _textBytes = 0;
			let _reasoningDeltas = 0;
			let _reasoningBytes = 0;
			let _toolCallDeltas = 0;
			let _usageDeltas = 0;
			let _otherDeltas = 0;
			let _lastTextDeltaAt = 0;
			let _lastReasoningDeltaAt = 0;
			let _lastDeltaType = '';
			let _lastHeartbeatAt = Date.now();
			const _heartbeatMs = 5000;
			// ── 诊断：per-delta 时间线（定位"46s 空窗"类问题）─────────────────
			// 记录每个 delta 的时间戳 + 类型 + 内容预览，用于事后还原流的节奏。
			// 完整记录（不截断数量），仅在 stream-end 时输出，避免逐 delta 打日志。
			const _deltaTimeline: string[] = [];
			let _prevDeltaAt = 0;
			for await (const delta of stream as AsyncIterable<IModelDelta>) {
					_lastDeltaType = classifyTurnDelta(delta);
					const _deltaAt = Date.now();
					// ── GAP 检测：>10s 的 delta 间空窗（定位"模型在等什么"）──
					if (_prevDeltaAt > 0 && _deltaAt - _prevDeltaAt > 10_000) {
				host._logService.debug(
						`[AgentOS][Diag] DELTA GAP | ${_deltaAt - _prevDeltaAt}ms between delta #${_totalDeltas - 1} → #${_totalDeltas} | ` +
							`elapsed=${Math.round((_deltaAt - t0_modelCall) / 1000)}s`
						);
					}
					_prevDeltaAt = _deltaAt;
					if (!_firstDeltaReceived) {
						_firstDeltaReceived = true;
						host._logService.info(
							`[AgentOS] modelProvider.chat: first delta received in ${Date.now() - t0_modelCall}ms ` +
							`(type=${_lastDeltaType})`
						);
						// 2026-08-29（日志 1787969405928）：首个 delta 若就是 error，意味着请求被
						// 本地/网关**即时拒绝**（实测 0-1ms 返回，根本没走网络往返）。
						// 事故实例：模型 `hy4-dev` 不在网关 allow-list → 连败 3 轮、每轮
						// `textLen=0, toolCalls=0`，用户侧只看到"发消息完全没反应"，而日志里
						// 只有一个光秃秃的 `type=error`，没有任何原因，排查只能靠模型 A/B 对比。
						// 故此处必须把 error 内容完整落盘（截断以防超大 payload）。
						if (isErrorDelta(delta)) {
							let _errDump = '';
							try {
								_errDump = JSON.stringify(delta).slice(0, 1000);
							} catch {
								_errDump = String(delta);
							}
							host._logService.error(
								`[AgentOS] modelProvider.chat: FIRST delta is ERROR (after ${Date.now() - t0_modelCall}ms) — ` +
								`request rejected before any content; raw=${_errDump}`
							);
						}
					}
					// ── 诊断：per-delta 时间线条目 ──
					{
						const _elapsed = _deltaAt - t0_modelCall;
						let _preview = '';
						if (isTextDelta(delta)) {
							_preview = `"${String(delta.content).slice(0, 80)}"`;
						} else if (isThinkingDelta(delta)) {
							_preview = `"${String(delta.content).slice(0, 80)}"`;
						} else if (isToolCallDelta(delta)) {
							_preview = `name=${delta.toolCall.name ?? '(cont)'}`;
						} else if (isUsageDelta(delta)) {
							const u = delta.usage;
							_preview = `in=${u.inputTokens ?? 0} out=${u.outputTokens ?? 0} cached=${u.cachedTokens ?? 0}`;
							_lastUsageDelta = u; // 保留供 POST-CHAT 输出
							// ── 关键诊断：usage delta 到达时立即记录（尤其 outputTokens）──
							// outputTokens 高 → 模型生成了大量 token 但未被捕获为 text/reasoning
							// outputTokens 低 → 模型确实只生成了极少内容
						host._logService.debug(
							`[AgentOS][Diag] USAGE delta | inputTokens=${u.inputTokens ?? 0} outputTokens=${u.outputTokens ?? 0} ` +
								`cached=${u.cachedTokens ?? 0} cacheWrite=${u.cacheWriteTokens ?? 0} | ` +
								`textSoFar=${_textDeltas}(${_textBytes}B) reasoningSoFar=${_reasoningDeltas}(${_reasoningBytes}B) | ` +
								`elapsed=${Math.round(_elapsed / 1000)}s`
							);
						} else if (isDoneWithFinishReason(delta)) {
							_preview = `finishReason=${delta.finishReason ?? '(none)'}`;
							// ── 关键诊断：done delta 到达时立即记录 finishReason ──
						host._logService.debug(
							`[AgentOS][Diag] DONE delta | finishReason=${delta.finishReason ?? '(none)'} | ` +
								`elapsed=${Math.round(_elapsed / 1000)}s | ` +
								`text=${_textDeltas}(${_textBytes}B) reasoning=${_reasoningDeltas}(${_reasoningBytes}B) toolCall=${_toolCallDeltas}`
							);
						}
						_deltaTimeline.push(`#${_totalDeltas} t=${_elapsed}ms type=${_lastDeltaType} ${_preview}`);
					}
					// 按 delta 类型分类计数 + 时间戳
					// IChatStreamDelta.type 联合：'text' | 'thinking' | 'tool_call' | 'usage' | 'error' | 'done'
					if (isTextDelta(delta)) {
						_textDeltas++;
						_textBytes += (delta.content as string).length;
						_lastTextDeltaAt = Date.now();
					} else if (isThinkingDelta(delta)) {
						_reasoningDeltas++;
						_reasoningBytes += String(delta.content).length;
						_lastReasoningDeltaAt = Date.now();
					} else if (isToolCallDelta(delta)) {
						_toolCallDeltas++;
					} else if (isUsageDelta(delta)) {
						_usageDeltas++;
					} else {
						_otherDeltas++;
					}
					// Heartbeat：每 5s 输出一次（除非刚刚有文本/推理 delta，否则会重复出现）
					const _now = Date.now();
					if (_now - _lastHeartbeatAt >= _heartbeatMs) {
						const _sinceText = _lastTextDeltaAt > 0 ? Math.round((_now - _lastTextDeltaAt) / 1000) : -1;
						const _sinceReasoning = _lastReasoningDeltaAt > 0 ? Math.round((_now - _lastReasoningDeltaAt) / 1000) : -1;
				host._logService.debug(
						`[AgentOS][Diag] MID-STREAM heartbeat | ` +
							`elapsed=${Math.round((_now - t0_modelCall) / 1000)}s | ` +
							`totalDeltas=${_totalDeltas} text=${_textDeltas}(${_textBytes}B) ` +
							`reasoning=${_reasoningDeltas}(${_reasoningBytes}B) ` +
							`toolCall=${_toolCallDeltas} usage=${_usageDeltas} other=${_otherDeltas} | ` +
							`lastDeltaType=${_lastDeltaType} | ` +
							`sinceText=${_sinceText >= 0 ? _sinceText + 's' : 'none'} ` +
							`sinceReasoning=${_sinceReasoning >= 0 ? _sinceReasoning + 's' : 'none'} | ` +
							`abortSignal=${host._loopAbortController?.signal?.aborted ? 'ABORTED' : 'active'}`
						);
						_lastHeartbeatAt = _now;
					}
					// ─── 捕获响应流 id（抓包对齐）──────────────────────────────
					// 抓包证据：响应流每个 chunk 的 id 相同，且 = 下一次请求的
					// previous_response_id。任意 delta 携带 responseId 即记下，供下一轮
					// （或下一条用户消息）作 previousResponseId 链式衔接。
					if (delta.responseId && request.sessionId) {
						host._lastResponseIdBySession.set(request.sessionId, delta.responseId);
					}
					// ─── P1: 截获真实 prompt token，供下一轮 compressContext 优先判定 ──
					// 完整 prompt = inputTokens + 缓存读 + 缓存写（缓存 token 同样占窗口）。
					// 捕获后同步写入实例字段，跨 turn 持久化；下一轮 L1390 直接读取。
					if (isUsageDelta(delta)) {
						const u = delta.usage;
						// 真实 prompt token 口径归一（2026-08-17，日志 1786981850420）：
						// OpenAI / DeepSeek 语义下 `prompt_tokens` 已是**完整输入量**，
						// `prompt_cache_hit_tokens` / `cached_tokens` 只是其中的子集
						// （实证：total_tokens 31345 = prompt_tokens 30951 + completion 394），
						// 此时再加 cached 会把输入量算成约两倍（30951+30592=61543），
						// 导致压缩阈值被虚假触发、压力等级失真。
						// Anthropic 语义相反：`input_tokens` **不含** cache_read/cache_creation，
						// 必须相加才是完整输入量。
						// 判定：inputTokens 已 ≥ cached+cacheWrite 视为「已包含」（OpenAI 系），
						// 否则视为「不含」（Anthropic 系）再相加。
						const _cacheSum = (u.cachedTokens ?? 0) + (u.cacheWriteTokens ?? 0);
						const _input = u.inputTokens ?? 0;
						const _inputAlreadyIncludesCache = _input >= _cacheSum;
						const realPrompt = _inputAlreadyIncludesCache ? _input : _input + _cacheSum;
						if (realPrompt > 0) {
							runState = reduceRunState(runState, { type: 'SET_LAST_PROMPT_TOKENS', value: realPrompt });
							host._lastRealPromptTokensByAgent.set(host._turnKey(request.agentId, request.sessionId), realPrompt);
							// P1(cache-cold): 记录本次 assistant 响应时间，供下一轮剪枝的缓存冷热判定
							host._lastAssistantAtByAgent.set(host._turnKey(request.agentId, request.sessionId), Date.now());
							// ── 前缀缓存命中率（2026-08-21，日志 1787301913662 / 1787315962316）──
							// 单轮 hit% 很好用（实测 98.2/99.0/29.9/98.7，29.9% 那次正是压缩后）。
							// ⚠ 累计值必须用**本 turn 基线**相减：`host._totalInputTokens` /
							// `_totalCachedTokens` 是 Dashboard 计数器，会 `_scheduleSave` 持久化，
							// 是**账号生命周期累计**。早前直接拿它算 cumHit，实测打出
							// `cumHit=80.6% (469006984/581977168)`（4.69 亿/5.82 亿），多轮采样
							// 一动不动，完全无法反映本次会话 —— 故改为 turn 内累计。
							// 分母用归一后的 realPrompt（OpenAI 系 == inputTokens，Anthropic 系
							// == input+cache），两种语义下口径一致。
							const _cachedTokens = u.cachedTokens ?? 0;
							const _hitPct = realPrompt > 0 ? (_cachedTokens / realPrompt) * 100 : 0;
							// Dashboard 计数器在本 if 之后才累加，故这里手动加上本轮再减基线。
							const _turnInput = (host._totalInputTokens + (u.inputTokens ?? 0)) - _turnCacheBaselineInput;
							const _turnCached = (host._totalCachedTokens + _cachedTokens) - _turnCacheBaselineCached;
							const _turnHitPct = _turnInput > 0 ? (_turnCached / _turnInput) * 100 : 0;
							// 请求体开销残差：与**发出该请求时**快照的 est 配对（不是与下一轮的 est）
							const _promptOverhead = realPrompt - _estAtRequest - _toolsSchemaAtRequest;
							host._logService.info(
								`[AgentOS][Compression] captured real prompt usage: inputTokens=${_input} ` +
								`cached=${_cachedTokens} cacheWrite=${u.cacheWriteTokens ?? 0} ` +
								`hit=${_hitPct.toFixed(1)}% miss=${Math.max(0, realPrompt - _cachedTokens)} | ` +
								`turnHit=${_turnHitPct.toFixed(1)}% (${_turnCached}/${_turnInput}) | ` +
								`estAtRequest=${_estAtRequest} toolsSchema=${_toolsSchemaAtRequest} ` +
								`promptOverhead=${_promptOverhead} | ` +
								`inputIncludesCache=${_inputAlreadyIncludesCache} → lastRealPromptTokens=${runState.lastRealPromptTokens}`
							);
						}
						// ─── Dashboard 统计：累积 Token 用量 ──
						host._totalInputTokens += (u.inputTokens ?? 0);
						host._totalOutputTokens += (u.outputTokens ?? 0);
						host._totalCachedTokens += (u.cachedTokens ?? 0);
						host._scheduleSave();
						// ─── P5: Cache hit rate monitoring — persist cache metrics to memory observation ──
						// Aligns with agentmemory: cache_read/cache_write tokens become first-class memory observations.
						// W3（2026-07-26 §16）：writeMemory(type=working) → observe（mem:obs 暂存层）。
						// 此前遥测噪音直写长期 core memory；现按注释原意成为真正的「观察」
						// （hookType=cache_metric，importance 启发式=3，不进入注入面）。
						if ((u.cachedTokens ?? 0) > 0 || (u.cacheWriteTokens ?? 0) > 0) {
							const memProvider = host.getActiveMemoryProvider();
							if (memProvider) {
								void memProvider.observe?.(request.agentId, {
									sessionId: request.sessionId || '',
									hookType: 'cache_metric',
									timestamp: new Date().toISOString(),
									data: {
										cacheReadTokens: u.cachedTokens ?? 0,
										cacheWriteTokens: u.cacheWriteTokens ?? 0,
										inputTokens: u.inputTokens ?? 0,
										outputTokens: u.outputTokens ?? 0,
									},
								}).catch((err: any) => {
									host._logService.warn(`[AgentOS][CacheMetrics] failed to observe cache metric: ${err}`);
								});
							}
						}
					}
					// 收集完整的助手消息数据
					// ─── 捕获 provider 本轮结束原因（finish_reason / stop_reason）──
					// 供后续"未完成轮"结构判定（对齐 OpenClaw，无文本意图识别）。
					if (isDoneWithFinishReason(delta)) {
						lastFinishReason = delta.finishReason;
					}
					if (isTextDelta(delta)) {
						_assistantChunks.push(delta.content);
					} else if (isThinkingDelta(delta)) {
						_thinkingChunks.push(delta.content);
					} else if (isToolCallDelta(delta)) {
						const tc = delta.toolCall;
						if (tc.name) {
							// New tool call (first chunk) — finalize previous if any
							if (toolCallAssembler.isActive) {
								assistantToolCalls.push(toolCallAssembler.finalize());
							}
							toolCallAssembler.start(tc.id, tc.name, tc.arguments || '', {
								displayName: tc.displayName,
								renderType: tc.renderType,
								defaultShow: tc.defaultShow,
								serverExecuted: tc.serverExecuted,
							});
						} else {
							// Continuation chunk — append arguments with buffer size check
							const appended = toolCallAssembler.appendArgs(tc.arguments || '');
							if (!appended) {
								host._logService.warn(`[AgentOS] Tool call argument buffer overflow (>${MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES} bytes), finalizing early`);
								assistantToolCalls.push(toolCallAssembler.finalize());
							}
						}
					}

					// 将 delta 适配并 yield 给调用者
					// 同时更新统一 ChatMessage 格式（AG-UI → ChatMessage）
					if (chatMessageStream) {
						chatMessageStream.handlePart(delta as any);
					}
					const adapted = host._adaptModelDelta(delta);
					if (adapted) {
						// Track tool_start IDs for end-of-iteration reconciliation
						if ((adapted as any).type === 'tool_start' && (adapted as any).toolCallId) {
							startedToolIds.add((adapted as any).toolCallId);
						}
						yield adapted;
						// ── Forward tool arguments alongside a single-shot tool_call ──
						// Some model providers (e.g. CodeBuddy / hy3-preview-ioa) emit the
						// whole tool call in ONE delta (name + arguments together) rather
						// than streaming the name first and arguments in follow-up chunks.
						// _adaptModelDelta maps such a delta to a `tool_start` ONLY (it can
						// return a single chunk), so the arguments would be dropped and the
						// webview card would never receive `params` → the title would show
						// no file name / command. Detect this case and emit the matching
						// `tool_args` right after the `tool_start` so the card can render
						// the italic description (e.g. "读取文件 README.md").
						//
						// ⚠⚠ 2026-08-22（日志 1787373914386，实测 58 次调用几乎全部中招）：
						// 原条件只认 `typeof arguments === 'string'`，而 codebuddy-provider
						// 在 extension.ts:1630 报的是
						//     new vscode.LanguageModelToolCallPart(id, name, params)
						// 其中 `params = JSON.parse(acc.arguments)` —— **是对象**。
						// 于是本补救分支恒不成立 → tool_args 从不发出 → 渲染层 `tc.args`
						// 恒为 ''，终端族卡片显示「（无命令）」、文件卡显示「(路径未解析)」，
						// 而**执行层完全正常**（它读的是已解析对象，日志 args=[query,...]）。
						// 这正是本项目铁律的又一次实证：渲染层拿的是 tool_args 累加的
						// 原始字符串，执行层拿的是 provider 已解析对象，**两条独立链路** ——
						// 工具执行成功 ≠ 卡片能渲染。
						// 故这里必须同时接受字符串与对象（对象则序列化后下发）。
						if (
							(adapted as any).type === 'tool_start' &&
							isToolCallDelta(delta) &&
							delta.toolCall.name
						) {
							const _rawArgs = delta.toolCall.arguments;
							let _argsStr = '';
							if (typeof _rawArgs === 'string') {
								_argsStr = _rawArgs;
							} else if (_rawArgs && typeof _rawArgs === 'object') {
								// 对象形态（本项目默认 provider 的实际形态）：序列化下发。
								// 失败不阻断工具执行 —— 仅退化为卡片无参数展示。
								try { _argsStr = JSON.stringify(_rawArgs); } catch { _argsStr = ''; }
							}
							if (_argsStr.length > 0 && _argsStr !== '{}') {
								yield {
									type: 'tool_args' as any,
									content: _argsStr,
									toolCallId: delta.toolCall.id,
								};
							}
						}
					}
				}
				host._logService.info(
					`[AgentOS] modelProvider.chat: stream ended after ${Date.now() - t0_modelCall}ms (firstDelta=${_firstDeltaReceived ? 'yes' : 'no'})`
				);
				// ─── 诊断：stream-end 详细快照 ────────────────────────────
				// 记录流结束时所有 delta 的分类统计 + "最后文本 delta 距今多久"，
				// 配合 POST-CHAT 后的"为什么空响应"分析，定位流是被谁中断的。
				{
					const _now = Date.now();
					const _sinceText = _lastTextDeltaAt > 0 ? Math.round((_now - _lastTextDeltaAt) / 1000) : -1;
					const _sinceReasoning = _lastReasoningDeltaAt > 0 ? Math.round((_now - _lastReasoningDeltaAt) / 1000) : -1;
					const _outTokens = _lastUsageDelta?.outputTokens ?? 'n/a';
				host._logService.debug(
					`[AgentOS][Diag] POST-CHAT stream-end | ` +
						`elapsed=${Math.round((_now - t0_modelCall) / 1000)}s | ` +
						`totalDeltas=${_totalDeltas} ` +
						`text=${_textDeltas}(${_textBytes}B) ` +
						`reasoning=${_reasoningDeltas}(${_reasoningBytes}B) ` +
						`toolCall=${_toolCallDeltas} usage=${_usageDeltas} other=${_otherDeltas} | ` +
						`lastDeltaType=${_lastDeltaType || '(none)'} ` +
						`finishReason=${lastFinishReason ?? '(none)'} ` +
						`outputTokens=${_outTokens} | ` +
						`sinceText=${_sinceText >= 0 ? _sinceText + 's' : 'none'} ` +
						`sinceReasoning=${_sinceReasoning >= 0 ? _sinceReasoning + 's' : 'none'} | ` +
						`assistantContentLen=${assistantContent.length} toolCallsSoFar=${assistantToolCalls.length} | ` +
						`abortSignal=${host._loopAbortController?.signal?.aborted ? 'ABORTED' : 'active'}`
					);
					// ── 诊断：per-delta 时间线（定位空窗/异常节奏）──
					// 输出全部 delta 的时间戳+类型+预览，最多 50 条避免日志爆炸
					if (_deltaTimeline.length > 0) {
						const _tl = _deltaTimeline.length > 50
							? [..._deltaTimeline.slice(0, 25), `... (${_deltaTimeline.length - 50} more) ...`, ..._deltaTimeline.slice(-25)]
							: _deltaTimeline;
				host._logService.debug(
						`[AgentOS][Diag] DELTA TIMELINE (${_deltaTimeline.length} deltas):\n${_tl.join('\n')}`
						);
					}
				}
			} catch (error) {
				const _catchDisposition = yield* handleTurnStreamError(error, {
					host,
					request,
					loopState,
					messages: () => messages,
					setMessages: next => { messages = next; },
					syncMessages,
					retry,
					patchRetry,
					compressContext: _compressContextIfNeeded,
					startedToolIds,
					endedToolIds,
					setPhaseError: () => { runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'error' }); },
				});
				if (_catchDisposition.kind === 'retry') {
					continue;
				}
				break;
			}

			// Finalize the last pending tool call from streaming assembly
			if (toolCallAssembler.isActive) {
				assistantToolCalls.push(toolCallAssembler.finalize());
			}

			// ─── Flatten accumulated streamed text exactly once (O(n), no ConsString ropes).
			// MUST happen before any diagnostic log / empty-response check that reads
			// assistantContent — otherwise the join hasn't run yet and textLen is always 0
			// even when hundreds of text deltas were received (diagnostic false-positive).
			assistantContent = _assistantChunks.join('');
			thinkingContent = _thinkingChunks.join('');

			host._logService.info(
				`[AgentOS] Model response: textLen=${assistantContent.length}, toolCalls=${assistantToolCalls.length}` +
				`, finishReason=${lastFinishReason ?? 'n/a'}, outputTokens=${_lastUsageDelta?.outputTokens ?? 'n/a'}`
			);

			// ─── [TagTrace] `<tag:id>` 伪标签溯源 · 响应侧扫描 ──────────────
			// 与请求侧配对判读：请求侧无 + 响应侧有 = 模型自发；两侧都有 = priming。
			// 额外记录 `toolsSent`：收尾轮 tools=0 是已知高发场景，需要它在日志里可见。
			{
				const _respHits = locateTaggedIdXmlTags(assistantContent, 3);
				if (_respHits.length > 0) {
					host._logService.warn(
						`[AgentOS][TagTrace] RESPONSE-SIDE tags iter=${loopState.iteration} textLen=${assistantContent.length} ` +
						`toolsSent=${enabledTools.length} finishReason=${lastFinishReason ?? 'n/a'} ` +
						`hits=[${_respHits.map(h => `${h.tag}:${h.id}@${h.index}`).join(', ')}] ` +
						`snippet=${JSON.stringify(_respHits[0].snippet).slice(0, 240)}`
					);
				}
			}

			if (assistantContent.length === 0 && assistantToolCalls.length === 0) {
				// 诊断：空响应时刻的完整上下文快照（关键定位信息）
				const _est = host._estimateMessagesTokens(messages);
				const _real = runState.lastRealPromptTokens ?? 0;
				const _pressure = ContextManager.getPressureLevel(_real || _est, compressionWindow);
				const _sinceCompress = host._lastCompressionTime > 0
					? Math.round((Date.now() - host._lastCompressionTime) / 1000)
					: -1;
				host._logService.warn(
					`[AgentOS] Model returned empty response — no text and no tool calls. ` +
					`Snapshot: iter=${loopState.iteration} msgs=${messages.length} estTokens=${_est} ` +
					`realPromptTokens=${_real} compressionWindow=${compressionWindow} ` +
					`pressure=${_pressure}/3 (${compressionWindow > 0 ? Math.round((_real || _est) / compressionWindow * 100) : 0}%) ` +
					`lastCompressionAt=${_sinceCompress >= 0 ? _sinceCompress + 's ago' : 'never'} ` +
					`maxTokens=${(modelOptions as any)?.maxTokens ?? 'n/a'} ` +
					`abortSignal=${host._loopAbortController?.signal?.aborted ? 'ABORTED' : 'active'}`
				);
			}

			// ─── 诊断日志：记录原生 tool calls 的名称 ──────────────────────
			if (assistantToolCalls.length > 0) {
				host._logService.info(`[AgentOS] Native tool calls from API: ${assistantToolCalls.map((tc: any) => tc.name).join(', ')}`);
			}

			// ─── 检查是否需要执行工具（含文本解析兜底）──────────────────
			let effectiveToolCalls = assistantToolCalls;
			if (effectiveToolCalls.length === 0 && assistantContent) {
				// 尝试从纯文本中解析工具调用（兼容不严格遵循 OpenAI 格式的模型）
				// 传入 enabledTools 以支持从纯参数 JSON 推断工具名
				const extracted = host._tryExtractToolCallsFromText(assistantContent, thinkingContent, enabledTools);

				// ─── 无论提取是否成功，都必须 sanitize ──────────────────────
				// 日志 1788016519843 实证：白名单守卫（待办 2）阻止了提取（extracted=[]），
				// 但也**连带跳过了整个 sanitize 分支**（3043-3057），导致含伪 XML 标签的
				// 文本原封不动进入 UI 显示路径 —— 用户在聊天框中直接看到 `<tool_calls:HEXID>` 等。
				// 故 sanitize 必须无条件执行，与提取结果解耦。
				const hasXmlShape = /<\s*(?:tool_calls?|function_calls?|tool_use|invoke|tool|arg_key|arg_value|parameter|tool_sep)\b[^>]*>/i.test(assistantContent)
					|| locateTaggedIdXmlTags(assistantContent, 1).length > 0;
				if (hasXmlShape) {
					if (isEntirelyToolCallContent(assistantContent)) {
						assistantContent = '';
						host._logService.info(`[AgentOS] Cleared assistantContent (was entirely tool-call content, extraction skipped)`);
					} else {
						const beforeLen = assistantContent.length;
						const cleaned = sanitizeWithTrace(assistantContent, host);
						assistantContent = cleaned.length < 5 ? '' : cleaned;
						host._logService.info(`[AgentOS] Sanitized assistantContent (extraction skipped), remaining: ${assistantContent.length} chars (was ${beforeLen})`);
					}
					yield { type: 'content_replace', content: assistantContent };
				}

				if (extracted.length > 0) {
					host._logService.info(`[AgentOS] Extracted ${extracted.length} tool calls from text output: [${extracted.map((tc: any) => tc.name).join(', ')}]`);
					effectiveToolCalls = extracted;

					// ── Clean assistantContent using the unified sanitizer pipeline
					// (OpenClaw-style multi-stage strip: JSON objects, code blocks, XML, brackets, etc.)
					if (isEntirelyToolCallContent(assistantContent)) {
						assistantContent = '';
						host._logService.info(`[AgentOS] Cleared assistantContent (was entirely tool-call content)`);
					} else {
						const beforeLen = assistantContent.length;
						const cleaned = sanitizeWithTrace(assistantContent, host);
						assistantContent = cleaned.length < 5 ? '' : cleaned;
						host._logService.info(`[AgentOS] Sanitized assistantContent, remaining: ${assistantContent.length} chars (was ${beforeLen})`);
					}

					// Notify downstream (agentChatService + webview) to replace accumulated text
					// content with the cleaned version. This prevents the UI from showing
					// the raw JSON that was already extracted into tool cards.
					yield { type: 'content_replace', content: assistantContent };

					// 向 UI 发送 tool_start 事件（前端需要 tool_start 才能渲染工具卡片）
					for (const tc of extracted) {
						startedToolIds.add(tc.id);
						yield {
							type: 'tool_start',
							toolCallId: tc.id,
							toolName: tc.name,
							displayName: tc.displayName,
							renderType: tc.renderType,
							defaultShow: tc.defaultShow,
						};
					}
				}
			}

			// ─── 白名单过滤原生工具调用 ──────────────────────────────────────
			// 模型可能在 agent 定义 / system prompt 中知晓某个工具（如 new_agent），
			// 但它被 tool_search 桥接归入 deferred 池、未直接下发到 API tools 参数中。
			// 此时模型直接调用该工具属于合法行为，不应被当作幻觉调用过滤掉。
			// 因此白名单检查须基于全量已启用工具（不受 MAX_VISIBLE_TOOLS 截断影响），
			// 而非仅可见工具子集（enabledTools）。
			if (effectiveToolCalls.length > 0 && host._lastAllEnabledToolNames.size > 0) {
				// ─── 废弃工具名归一化（白名单过滤前）──────────────────────────
				// 模型可能从历史 system prompt / 旧会话残留中读到已废弃的工具名
				// （如 search_code，现注册名为 grep）。先尝试用 repairToolName
				// 把废弃名归一到当前 enabled 工具集里的真实名，避免被白名单当成
				// "幻觉调用" 误杀。仅在目标名确实 enabled 时才重写，保证安全。
				// 注：tc.name 为 readonly，故用 map 产生新对象覆盖，而非原地赋值。
				effectiveToolCalls = effectiveToolCalls.map(tc => {
					if (host._lastAllEnabledToolNames.has(tc.name)) { return tc; }
					if (isBridgeTool(tc.name) || PHANTOM_TOOL_NAMES.has(tc.name)) { return tc; }
					const repaired = repairToolName(tc.name, Array.from(host._lastAllEnabledToolNames));
					if (repaired && repaired !== tc.name) {
						host._logService.info(`[AgentOS] Repaired deprecated tool name: "${tc.name}" → "${repaired}"`);
						return { ...tc, name: repaired };
					}
					return tc;
				});
				const validCalls = effectiveToolCalls.filter(tc => {
					if (host._lastAllEnabledToolNames.has(tc.name)) { return true; }
					// 2026-07-03: 统一单套桥接 — 接受所有桥接工具调用（tool_search/tool_describe/tool_call）
					if (isBridgeTool(tc.name)) { return true; }
					if (PHANTOM_TOOL_NAMES.has(tc.name)) { return true; }
					host._logService.warn(`[AgentOS] Filtered out hallucinated tool call: "${tc.name}" (not in enabled tools)`);
					return false;
				});
				if (validCalls.length < effectiveToolCalls.length) {
					host._logService.info(`[AgentOS] Whitelist filtered native tool calls: ${effectiveToolCalls.length} → ${validCalls.length}`);
					// 为被过滤的幻觉调用补 tool_result + tool_end，防止卡片永远转圈
					// 同时回写可用工具示例，让模型知道该用什么工具名（而非凭空猜测）。
					const availableToolSample = Array.from(host._lastAllEnabledToolNames).slice(0, 10).join(', ');
					for (const tc of effectiveToolCalls) {
						if (validCalls.includes(tc)) { continue; }
						yield { type: 'tool_result', content: `工具 "${tc.name}" 不在可用列表中（可能为幻觉调用）。可用工具示例：[${availableToolSample}]。请只使用列表中真实存在的工具名重发。`, toolCallId: tc.id };
						yield { type: 'tool_end', toolCallId: tc.id, success: false };
						endedToolIds.add(tc.id);
					}
					effectiveToolCalls = validCalls;
				}
			}

			// Deduplicate tool calls
			const beforeDedup = effectiveToolCalls;
			effectiveToolCalls = deduplicateToolCalls(effectiveToolCalls);
			if (effectiveToolCalls.length < beforeDedup.length) {
				host._logService.info(`[AgentOS] Deduplicated: ${beforeDedup.length} → ${effectiveToolCalls.length}`);
				// 为被去重的工具补 tool_result + tool_end
				for (const tc of beforeDedup) {
					if (effectiveToolCalls.includes(tc)) { continue; }
					yield { type: 'tool_result', content: `工具 "${tc.name}" 已去重（与其它调用重复）`, toolCallId: tc.id };
					yield { type: 'tool_end', toolCallId: tc.id, success: false };
					endedToolIds.add(tc.id);
				}
			}

			// ─── Filter out phantom tool calls (render_type="None", default_show=false) ─────
			// These are UI indicator tools (e.g., "task_planning" showing "任务规划中")
			// that should NOT be executed as real tools. Executing them causes confusing
			// "not yet implemented" errors that derail the conversation.
			//
			// 双重判定（缺一不可的兜底）：
			//   A) 元数据明示：renderType==="None" && defaultShow===false
			//      —— Knot server 在 _meta 里正确标注时走这条
			//   B) 名称白名单：PHANTOM_TOOL_NAMES.has(name)
			//      —— Knot server 漏发 _meta 字段时的兜底（实测会发生，
			//         否则就会进入 repairToolName 失败 → tool not found
			//         → 模型生成一大段"我尝试调用了不存在的工具"道歉的循环）
			const realToolCalls = effectiveToolCalls.filter(tc => {
				const isPhantomByMeta = tc.renderType === 'None' && tc.defaultShow === false;
				const isPhantomByName = PHANTOM_TOOL_NAMES.has(tc.name);
				const isPhantom = isPhantomByMeta || isPhantomByName;
				if (isPhantom) {
					const reason = isPhantomByMeta ? 'meta(render_type=None,default_show=false)' : 'name-whitelist';
					host._logService.info(`[AgentOS] Skipping phantom tool call: ${tc.name} (${reason})`);
				}
				return !isPhantom;
			});
			if (realToolCalls.length < effectiveToolCalls.length) {
				host._logService.info(`[AgentOS] Filtered phantom tool calls: ${effectiveToolCalls.length} → ${realToolCalls.length}`);
				// 为被过滤的 phantom 工具补 tool_result + tool_end
				for (const tc of effectiveToolCalls) {
					if (realToolCalls.includes(tc)) { continue; }
					yield { type: 'tool_result', content: `工具 "${tc.name}" 为 UI 指示器，已跳过`, toolCallId: tc.id };
					yield { type: 'tool_end', toolCallId: tc.id, success: true };
					endedToolIds.add(tc.id);
				}
				effectiveToolCalls = realToolCalls;
			}

			// ─── [DIAG] 工具调用来源诊断 ────────────────────────────────────────
		// 区分三种情况：① native tool_calls(API 层返回) ② 文本提取(extracted) ③ 零(纯文本/泄漏)
		// 截图 iteration 12 的 XML 泄漏属于情况 ③ —— 模型输出伪 XML 但提取器不认。
		const _toolSource = assistantToolCalls.length > 0
			? `native(${assistantToolCalls.length})`
			: effectiveToolCalls.length > 0
				? `extracted(${effectiveToolCalls.length})`
				: 'none';
		host._logService.info(
			`[AgentOS][Diag] iter=${loopState.iteration} toolSource=${_toolSource} ` +
			`native=${assistantToolCalls.length} extracted=${effectiveToolCalls.length - (assistantToolCalls.length > 0 ? 0 : effectiveToolCalls.length)} ` +
			`final=${effectiveToolCalls.length} names=[${effectiveToolCalls.map((tc: any) => tc.name).join(',')}]`,
		);

		// ─── Supervisor handoff: 拦截 transfer_to_agent（来源 A, 设计 §3.3）────
			// 多 agent 图模式下节点借 builtin 交接工具发出路由指令；此处拦截、不真正
			// 执行，生成 AgentCommand 让 runAgentGraph（Step C）路由到下一节点。
			// 单 agent 模式该工具已被 _getEnabledTools 过滤（不会到达此处）→ 零行为变更。
			const handoffCall = effectiveToolCalls.find((tc: any) => tc.name === TRANSFER_TO_AGENT_TOOL);
			if (handoffCall) {
				let parsed: Record<string, unknown> = {};
				try {
					parsed = typeof handoffCall.arguments === 'string'
						? JSON.parse(handoffCall.arguments)
						: (handoffCall.arguments as Record<string, unknown>) ?? {};
				} catch { parsed = {}; }
				const command = buildHandoffCommand(parsed, request.agentGraph);
				// 标记结束，避免 UI 孤儿 tool_start 转圈
				if (startedToolIds.has(handoffCall.id)) {
					yield { type: 'tool_end', toolCallId: handoffCall.id, success: !!command };
					endedToolIds.add(handoffCall.id);
				}
				if (command) {
					runState = applyCommandToState(runState, command);
					host._logService.info(`[AgentOS] Handoff → goto=${JSON.stringify(command.goto)}, summary=${(command.summary ?? '').slice(0, 80)}`);
					runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'idle' });
					yield { type: 'done' };
					return command;
				}
			// 无法生成 command（graph 缺失或 node_id 非法）：移除该 call，继续正常流程
			host._logService.warn(`[AgentOS] transfer_to_agent present but no valid command (graph=${request.agentGraph ? 'present' : 'absent'}) — dropping handoff call`);
			effectiveToolCalls = effectiveToolCalls.filter(tc => tc.name !== TRANSFER_TO_AGENT_TOOL);
		}

		// ─── 策略钩子接线：interceptToolCall（纯观测）───────────────────────
		// 策略在此追踪每个即将执行的工具调用 —— HermesReAct 用它做委托记账
		// （_delegationRound → 循环末 refund）与探索调用计数（超阈值注入强制
		// 委托提醒）。钩子返回 void：策略**不能**消费或阻断调用。
		//
		// 契约曾是 `InterceptResult { handled, terminate }`，2026-09-17 收窄为
		// void。`handled: true` 跳过执行器就没有 tool 消息回填，历史里会留下
		// 孤儿 tool_call_id，下一轮请求即协议错误；要阻断工具请用
		// `prepareIteration` 在调用生成**之前**收窄工具面。
		if (strategy?.interceptToolCall && effectiveToolCalls.length > 0) {
			for (const tc of effectiveToolCalls) {
				let parsedArgs: any;
				try {
					parsedArgs = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
				} catch { parsedArgs = undefined; }
				yield* strategy.interceptToolCall({
					host, request, chatMode: String(chatOnly), modelProvider,
					modelId: selection?.modelId ?? '', selection,
					messages, signal: turnAbortSignal, budget, workState: runState.work,
					toolDefs: enabledTools, iteration: loopState.iteration,
				}, { name: tc.name, args: parsedArgs });
			}
		}

		// 将助手消息添加到消息历史
			// 注意用 trim() 判定：被 sanitize 清洗后可能残留纯空白（'   ' / '\n'），
			// 若原样 push 进历史，下一轮会把这条"空白 assistant 消息"再喂回 LLM
			// （即用户看到的"发送空消息给 llm"）。纯空白且无工具调用时不入历史。
			const trimmedAssistantContent = assistantContent.trim();
			// ─── [DIAG] assistant 文本诊断（定位 XML 泄漏 / 纯文本无工具调用 / 提取失败）──
			// 截图显示 iteration 12 出现 `<tool_calls:HEXID>` 等伪 XML 标签但日志中完全无痕迹，
			// 说明此前日志粒度不够：没有记录 assistant 原始文本、XML 检测结果、提取器输出。
			const _diagTextPreview = trimmedAssistantContent.length > 120
				? trimmedAssistantContent.slice(0, 60) + '…[' + trimmedAssistantContent.length + 'c]…' + trimmedAssistantContent.slice(-40)
				: trimmedAssistantContent;
			host._logService.info(
				`[AgentOS][Diag] iter=${loopState.iteration} assistant textLen=${trimmedAssistantContent.length} ` +
				`toolCalls=${effectiveToolCalls.length} preview=${JSON.stringify(_diagTextPreview).slice(0, 200)}`,
			);
			// ─── XML 文本工具调用泄漏判定 ──────────────────────────────────────
			// 模型把工具调用写成 XML 纯文本（<tool_calls:xxx> / <arg_key:xxx>）而非
			// native function call。此时本轮文本是「未被执行的调用意图」而非有效产出：
			// 若原样入历史，下一轮模型会看到自己刚输出的 XML 并继续模仿，形成自我强化
			// （这正是聊天框反复堆出同类解析错误 UI 的成因）。
			// 故判定为泄漏时**不入库**，交由下方分支注入纠正指令后重试。
			const xmlToolLeak = effectiveToolCalls.length === 0 && detectXmlToolCallLeak(trimmedAssistantContent);
			if (xmlToolLeak) {
				host._logService.warn(
					`[AgentOS][Diag] ⚠ XML-TOOL-LEAK detected iter=${loopState.iteration} ` +
					`textLen=${trimmedAssistantContent.length} attempt=${loopState.xmlToolLeakAttempts}/${XML_TOOL_LEAK_RETRY_LIMIT} ` +
					`preview=${JSON.stringify(_diagTextPreview).slice(0, 200)}`,
				);
			}
			if ((trimmedAssistantContent || effectiveToolCalls.length > 0) && !xmlToolLeak) {
				const assistantMessage: any = {
					role: 'assistant',
					// 落库用 trim 后的内容，杜绝纯空白污染历史
					content: trimmedAssistantContent,
				};
				// ReAct: 将 native thinking 注入 reasoning 字段。
				// messageFormatConverter 会在转 OpenAI/Anthropic/Gemini 格式时
				// 将其合并到 content 中（<thinking>...</thinking> 前缀），使模型在
				// 下一轮迭代中能"看见"自己的思考过程。
				if (thinkingContent) {
					assistantMessage.reasoning = thinkingContent;
				}
				if (effectiveToolCalls.length > 0) {
					assistantMessage.toolCalls = effectiveToolCalls;
				}
				messages = appendMessages(messages, assistantMessage);
				syncMessages();

				// ─── Hermes-style 消息边界事件（治本根因修复）─────────────────
				// 把"本 iteration 的 assistant 边界"显式告知下游持久化层，让 chatService
				// 不再 `fullContent += delta` 把多轮文本压扁成一条。content 为本轮权威
				// 文本（已 sanitize+trim），toolCallIds 为本轮工具调用 id。后续 tool_result
				// 仍按 id 跨事件回填，因此这里只需声明归属关系。
				yield {
					type: 'assistant_turn' as any,
					content: trimmedAssistantContent,
					metadata: {
						turnIndex: loopState.iteration,
						toolCallIds: effectiveToolCalls.map((tc: any) => tc.id),
					},
				};
			}

			if (effectiveToolCalls.length === 0) {
				// ─── XML 文本工具调用泄漏 → 显式告知模型「该格式不执行」并续跑 ─────
				// 必须抢在 classifyIncompleteTurn 之前判定：该函数对「有可见文本」一律判
				// 'complete'，而 XML 泄漏恰恰表现为有可见文本 —— 若放其后则永远漏判，
				// 模型得不到任何反馈，只会反复输出同样的 XML 试探。
				// 处置（对齐 openclaw「显式告知不执行」而非静默丢弃）：
				//   上限内 —— 丢弃泄漏文本（已在上方跳过入库）+ 注入纠正指令 + 续跑纠正；
				//   超限   —— 说明该模型不会用 native function call，交回常规 incomplete-turn 收尾。
				if (xmlToolLeak) {
					if (loopState.xmlToolLeakAttempts < XML_TOOL_LEAK_RETRY_LIMIT) {
						loopState.xmlToolLeakAttempts++;
						host._logService.warn(
							`[AgentOS] ⚠ XML-TOOL-LEAK: model emitted tool call as XML text, which is NOT executed ` +
							`(attempt=${loopState.xmlToolLeakAttempts}/${XML_TOOL_LEAK_RETRY_LIMIT}, textLen=${trimmedAssistantContent.length}) — ` +
							`discarding leaked text and instructing native function call`,
						);
						// 通知 UI 清掉已流式渲染出的泄漏文本（webview 收到后清空 buffer）
						yield { type: 'discard_prior_text', metadata: { reason: 'xml-tool-call-leak' } };
						// 注入纠正指令作为下一轮 user 边界
						messages = appendMessages(messages, { role: 'user', content: xmlToolCallLeakReminder() });
						syncMessages();
						continue;
					}
					host._logService.warn(
						`[AgentOS] ⚠ XML-TOOL-LEAK: retries exhausted (${XML_TOOL_LEAK_RETRY_LIMIT}) — ` +
						`model does not emit native function calls; ending turn`,
					);
					// 重试用尽：这段文本既不能执行也无参考价值，丢弃后走常规结束路径，
					// 避免把泄漏 XML 留在 UI 上冒充"回答"。
					yield { type: 'discard_prior_text', metadata: { reason: 'xml-tool-call-leak-exhausted' } };
				}

				// ─── 未完成轮安全续跑（对齐 OpenClaw stopReason 结构判定，无文本意图识别）──
				// 仅当本轮"无可见文本 + 无工具调用"才可能是未完成轮：
				//   - 'reasoning-only'：只有思考块、无可见答案（模型想做但没落地）
				//   - 'empty'：全空（既无文本也无思考、无工具调用）
				//   - 'length'：被 token 上限截断（finishReason=length）
				// 命中则在次数上限内注入续跑指令 + discard_prior_text（防历史污染），然后续跑；
				// 超限则丢弃空/幻觉文本后正常结束。有可见文本（正常终轮）不触发。
				const hasVisibleText = trimmedAssistantContent.length > 0;
				const hasThinking = !!thinkingContent && thinkingContent.trim().length > 0;
				let incompleteKind = classifyIncompleteTurn({
					finishReason: lastFinishReason,
					hasVisibleText,
					hasThinking,
					hasToolCalls: false,
				});
				// ─── 尾部结构截断补位（2026-09-18，用户报「llm 显示的信息尾部被截断」）──
				// `finishReason=stop` 也可能是**上游提前收尾**：模型写到一半就停，provider 却报
				// stop（实证：文本停在 `## 剩`、outputTokens=345 远低于上限，provider SSE 抓包
				// 确认 stop 紧跟最后一个内容块）⇒ `classifyIncompleteTurn` 只能判 complete，
				// 用户看到半句话而我方不做任何动作。此处用**结构**判据补位（不读语义，
				// 与 XML 泄漏检测同姿态：都在 classifyIncompleteTurn 之外、之前/之后补）。
				let _tailTruncation: string | null = null;
				if (incompleteKind === 'complete' && hasVisibleText) {
					_tailTruncation = detectTruncatedTail(trimmedAssistantContent);
					if (_tailTruncation) { incompleteKind = 'truncated-text'; }
				}
				const used =
					incompleteKind === 'reasoning-only' ? retry().reasoningOnly
						: incompleteKind === 'length' ? retry().lengthTruncated
							: incompleteKind === 'truncated-text' ? retry().truncatedText
								: incompleteKind === 'tool-call-lost' ? retry().toolCallLost
									: retry().emptyResponse;
				// 维度 2+4：按 attempt 获取升级阶梯指令（L1 soft remind / L2 final chance）
				const retryInstruction = resolveIncompleteTurnRetryInstruction(incompleteKind, used + 1);
				if (retryInstruction && incompleteKind !== 'complete') {
					const limit = incompleteTurnRetryLimit(incompleteKind);
					if (used < limit) {
							if (incompleteKind === 'reasoning-only') { patchRetry({ reasoningOnly: retry().reasoningOnly + 1 }); }
						else if (incompleteKind === 'length') { patchRetry({ lengthTruncated: retry().lengthTruncated + 1 }); }
						else if (incompleteKind === 'truncated-text') { patchRetry({ truncatedText: retry().truncatedText + 1 }); }
						else if (incompleteKind === 'tool-call-lost') { patchRetry({ toolCallLost: retry().toolCallLost + 1 }); }
						else { patchRetry({ emptyResponse: retry().emptyResponse + 1 }); }
						host._logService.warn(
							`[AgentOS] Incomplete turn detected (kind=${incompleteKind}, finishReason=${lastFinishReason ?? 'n/a'}, attempt=${used + 1}/${limit}` +
							`${_tailTruncation ? `, tailTruncation=${_tailTruncation}` : ''}` +
							`${hasVisibleText ? `, partialTextLen=${trimmedAssistantContent.length} (kept, not discarded)` : ''}) — safe retry`,
						);
						if (incompleteKind === 'tool-call-lost') {
							// 协议层缺陷信号：模型声明发了工具调用但一个都没送达。
							// 单独打点便于统计发生率与定位 provider 映射问题。
							//
							// ★ 2026-08-31：补上 outputTokens 判据（对齐 L2637 usage delta 注释
							// 的既有诊断意图）。这是区分「真丢失」与「模型误报」的关键：
							//   outputTokens 远高于文本量 → 模型确实生成了内容却没被捕获
							//                              （provider→renderer 映射丢失，日志实证
							//                               outputTokens=5503 / textLen=306 / 63 个
							//                               tool_progress delta / thinking 0 字符）
							//   outputTokens 与文本量相当 → 模型只是说了句「我接下来要…」就结束，
							//                              finish_reason 报 tool_calls 属模型侧误报
							// 两者对策不同：前者该换 provider/模型，后者重试即可。
							const _outTok = _lastUsageDelta?.outputTokens;
							host._logService.warn(
								`[AgentOS] ⚠ TOOL-CALL-LOST: finish_reason=tool_calls but 0 tool calls received ` +
								`(assistantTextLen=${trimmedAssistantContent.length}, outputTokens=${_outTok ?? 'n/a'}). ` +
								`outputTokens 远高于文本量 ⇒ 真丢失（provider→renderer 映射）；两者相当 ⇒ ` +
								`模型侧误报（只说了句意图就结束）。The tool call was dropped ` +
								`in the provider→renderer mapping — check codebuddy-provider SSE delta handling.`,
							);
						}
						// 丢弃本轮空/幻觉文本，避免污染历史（对齐 discard_prior_text 基础设施）。
						// ⚠ `incompleteTurnDiscardReason` 对 `length` / `truncated-text` 返回
						// undefined = **刻意保留**（半截文本是有效产物；丢弃会让模型重写整段、
						// 并把用户眼前已显示的内容清空）。见该函数注释。
						const _discardRetry = incompleteTurnDiscardReason(incompleteKind);
						if (_discardRetry) {
							yield { type: 'discard_prior_text', metadata: { reason: _discardRetry } };
						}
						// ─── 上下文压力 >90% 时空回复 → 冷却旁路，强制下轮压缩 ───
						// fetch failed / HTTP 400 导致 empty response 时，超大 prompt(>90% window)
						// 会被 cooldown 锁住无法压缩。重复用相同过大 prompt 重试必再次失败。
						// 此时重置 _lastCompressionTime=0，下轮 iteration 开头压缩即报通过。
						{
							const estTokens = host._estimateMessagesTokens(messages);
							const effectiveTokens = runState.lastRealPromptTokens ?? estTokens;
							if (compressionWindow > 0 && effectiveTokens > compressionWindow * 0.9) {
								const cooldownMs = host._lastCompressionTime > 0
									? Date.now() - host._lastCompressionTime : Infinity;
								if (cooldownMs < COMPRESSION_COOLDOWN_MS) {
									host._logService.warn(
										`[AgentOS] Incomplete turn + high pressure (${Math.round(effectiveTokens / compressionWindow * 100)}%): ` +
										`bypassing compression cooldown (${Math.round(cooldownMs / 1000)}s elapsed, needed ${COMPRESSION_COOLDOWN_MS / 1000}s)`
									);
									host._lastCompressionTime = 0;
								}
							}
						}
						// 注入续跑指令作为下一轮 user 边界，让模型产出可见答案 / 真正动手
						messages = appendMessages(messages, { role: 'user', content: retryInstruction });
						syncMessages();
						continue;
					}
					host._logService.warn(
						`[AgentOS] Incomplete turn retries exhausted (kind=${incompleteKind}, finishReason=${lastFinishReason ?? 'n/a'}` +
						`, outputTokens=${_lastUsageDelta?.outputTokens ?? 'n/a'}, textLen=${trimmedAssistantContent.length}) — ending conversation`,
						);
						// 2026-08-29（日志 1787985475999）：标记本轮为「空/失败结束」，
						// 透传给 executeAgentTurn 的 finally —— 抑制「✅ 任务执行完毕」成功通知，
						// 避免对无有效产出的 turn 误报完成。
						if (request.turnOutcome) { request.turnOutcome.incompleteExhausted = true; }
						// 超限：丢弃空/幻觉文本后正常结束，避免把污染内容喂回模型。
						// ⚠ 同上一分支：`length` / `truncated-text` 返回 undefined ⇒ 保留半截文本，
						// 只补一条可见说明（下面的 notice），用户至少能看到「为什么这里是半句」。
						const _discardExhausted = incompleteTurnDiscardReason(incompleteKind);
						if (_discardExhausted) {
							yield { type: 'discard_prior_text', metadata: { reason: _discardExhausted } };
						}
					// 2026-08-29（日志 1787969405928）：重试用尽后此前是**完全静默**地结束 ——
					// UI 只剩一个空的 assistant 气泡，用户主观感受就是「发消息没反应 / 卡住」。
					// 实测事故：模型 hy4-dev 不在网关 allow-list，首个 delta 即 type=error，
					// 连败 3 轮、每轮 textLen=0，而界面与日志都没有任何可读原因。
					// 这里补一条可见说明（必须在 discard_prior_text 之后 yield，才不会被清掉），
					// 让用户能立刻判断是模型/网络问题，而不是以为应用卡死。
					{
						const notice = incompleteTurnUserNotice(incompleteKind, lastFinishReason);
						if (notice) {
							yield { type: 'text', content: notice };
						}
					}
				}

				// ─── Text-without-tools in retry context（结构化信号，非文本意图识别）──
				// 场景：上一轮空响应触发 retry（emptyResponseRetryAttempts > 0），retry 后模型
				// 产出了可见文本但仍无 tool_call。对编码 Agent，这通常是"描述了计划但没动手"。
				// 结构信号：hasVisibleText && !hasToolCalls && emptyResponseRetryAttempts > 0
				// ——不分析文本内容，仅凭"retry 上下文 + 有文无工具"判定。
				// 复用 emptyResponseRetryAttempts 计数器，受 incompleteTurnRetryLimit('empty') 上限保护。
				// 不 discard_prior_text：保留模型计划文本作上下文，让模型在下一轮看到自己的计划并执行。
				if (
					incompleteKind === 'complete' &&
					hasVisibleText &&
					retry().emptyResponse > 0 &&
					retry().emptyResponse < incompleteTurnRetryLimit('empty')
				) {
					patchRetry({ emptyResponse: retry().emptyResponse + 1 });
					host._logService.warn(
						`[AgentOS] Text-without-tools in retry context (emptyRetryAtt=${retry().emptyResponse}/${incompleteTurnRetryLimit('empty')}, textLen=${trimmedAssistantContent.length}) — injecting tool-action reminder`,
					);
					messages = appendMessages(messages, { role: 'user', content: textWithoutToolsReminder() });
					syncMessages();
					continue;
				}

				// 没有工具调用 — 检查是否需要反思阶段
				// ─── Plan-Execute-Reflect 模式 ──────────────────────────
				// 当 LLM 执行过工具并给出最终回复后，注入反思提示让它自查是否有遗漏。
				// 参考 OpenSearch ML Commons 的 PLAN_EXECUTE_AND_REFLECT Agent 类型。
				if (runState.hasModifiedFiles && runState.reflectCount < MAX_REFLECT_ITERATIONS && trimmedAssistantContent) {
					runState = reduceRunState(runState, { type: 'REFLECT' });
					host._logService.info(`[AgentOS] Entering reflect phase (${runState.reflectCount}/${MAX_REFLECT_ITERATIONS})`);
					// Reconcile orphaned tool_starts before reflect
					for (const orphanId of startedToolIds) {
						if (!endedToolIds.has(orphanId)) {
							const orphanResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ note: '工具在反思阶段已跳过' })));
							yield { type: 'tool_result', content: orphanResultStr, toolCallId: orphanId };
							yield { type: 'tool_end', toolCallId: orphanId, success: false };
							endedToolIds.add(orphanId);
						}
					}
					// 注入反思提示，让 LLM 检查工作是否有遗漏
					yield { type: 'text', content: '\n\n---\n**[Reflection Phase]** Reviewing completed work...' };
					messages = appendMessages(messages, {
						role: 'user',
						content:
							'Before finalizing, please review your completed work:\n' +
							'1. Did you modify all necessary files? Are there missing imports or references?\n' +
							'2. Are there any compilation errors or lint warnings you should fix?\n' +
							'3. Did you handle edge cases and error paths?\n' +
							'4. Are your changes complete, consistent, and tested?\n\n' +
							'If you find issues, fix them now using the appropriate tools.\n' +
							// 事故（日志 1785144785309）：旧措辞 "provide your final summary" 诱导模型
							// 把上一轮已经完整给过的总结原样/近似重写一遍，在聊天框里表现为"结论文本重复显示"
							// （_streamingParts 忠实记录了两段几乎相同的 text part，非渲染层 bug）。
							// 改为要求"简短确认"，明确禁止重复完整总结。
							'If everything is correct, reply with a SHORT confirmation only ' +
							'(e.g. "Reviewed, no issues found.") — do NOT repeat or restate the summary ' +
							'you already gave in your previous turn.',
						synthetic: true,
						sidecar: 'reflection',
					});
					syncMessages();
					continue; // 进入反思迭代
				}

			// ─── 计划队列推进（新范式：主 agent loop 依次执行计划任务）──
			// 无工具调用且（反思已完成或无需反思）时，若 planTasks 队列还有后续任务，
			// 推进到下一任务并注入其 reminder，而非结束 loop。
			if (planTasks.length > 0 && currentTaskIdx < planTasks.length - 1) {
				currentTaskIdx++;
				host._logService.info(`[AgentOS] Plan queue: advancing to task ${currentTaskIdx + 1}/${planTasks.length} "${planTasks[currentTaskIdx].title}"`);
				messages = appendMessages(messages, {
					role: 'user',
					content: formatCurrentTaskReminder(planTasks[currentTaskIdx], currentTaskIdx, planTasks.length),
					synthetic: true,
					sidecar: 'plan',
				});
				syncMessages();
				continue;
			}

			// ─── 策略钩子：beforeTerminate（MiMo 主会话 TaskGate 挂载点）────────
			// 无工具调用且计划队列已空 → 结束前问策略。默认 allow（Hermes 行为）；
			// MiMo 范式查任务板 DB 真相，有未完成会话任务时注入重入提醒继续（有界）。
			if (strategy?.beforeTerminate) {
				try {
					const term = await strategy.beforeTerminate({
					host, request, chatMode: String(chatOnly), modelProvider,
					modelId: selection?.modelId ?? '', selection,
					messages, signal: turnAbortSignal, budget, workState: runState.work,
					toolDefs: enabledTools, iteration: loopState.iteration, trivialRequest,
				}, budget);
					if (!term.allow && term.nudgeMessage) {
						host._logService.info('[AgentOS] beforeTerminate veto: injecting reentry nudge and continuing');
						messages = appendMessages(messages, { role: 'user', content: term.nudgeMessage, synthetic: true, sidecar: 'nudge' });
						syncMessages();
						continue;
					}
				} catch (gateErr) {
					// 失败开放：门控异常绝不阻塞 loop 结束
					host._logService.warn(`[AgentOS] beforeTerminate error (fail-open, ending): ${gateErr instanceof Error ? gateErr.message : String(gateErr)}`);
				}
			}

			// 反思已完成或无需反思 — 真正结束
			host._logService.info('[AgentOS] No tool calls, ending conversation' + (runState.reflectCount > 0 ? ` (after ${runState.reflectCount} reflect phase(s))` : ''));
				// Reconcile orphaned tool_starts before ending (e.g., phantom tools
				// that were filtered out had a tool_start but no execution path).
				for (const orphanId of startedToolIds) {
					if (!endedToolIds.has(orphanId)) {
						host._logService.warn(`[AgentOS] Orphaned tool_start at end-of-conversation: ${orphanId} — emitting synthetic tool_result + tool_end`);
						const orphanResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ note: '工具未执行（对话已结束）' })));
						yield { type: 'tool_result', content: orphanResultStr, toolCallId: orphanId };
						yield { type: 'tool_end', toolCallId: orphanId, success: false };
						endedToolIds.add(orphanId);
					}
				}
				// 真正结束前显式置 phase=idle（对齐 UI 结束态，phase 进 runState 供 checkpoint 读取）
				runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'idle' });
				yield { type: 'done' };
				break;
			}

			// ─── 分离 serverExecuted 工具（服务端已执行，跳过本地执行）──────────
			// Knot AG-UI 等服务端 Agent 会在服务端执行工具并标记 server_executed=true。
			// 这些工具不需要（也不应该）在客户端再次执行——本地没有对应的 provider，
			// 强行执行只会报 "No provider available" 错误，导致 tool card 显示"错误详情"。
			// 标记是否使用了文件修改类工具（用于反思阶段判断）
			if (effectiveToolCalls.length > 0) {
				for (const tc of effectiveToolCalls) {
					if (FILE_MODIFICATION_TOOLS.has(tc.name)) { runState = reduceRunState(runState, { type: 'MARK_FILE_MODIFIED' }); break; }
				}
			}
			//
			// 对于 serverExecuted 的工具：
			//   - 发送 tool_result（占位成功结果）+ tool_end(success=true)
			//   - 不添加到 messages 历史中的 tool 消息（服务端已将结果融入后续文本）
			//   - 标记 endedToolIds 避免孤儿检测重复发送
			//
			// [Saros] Server-executed tool detection:
			// 由 IModelProvider.isServerSideProvider 决定（不再硬编码 providerId）。
			// - Knot AG-UI: provider 内部封装了完整 agent 循环，chat() 流中
			//   包含 tool execution + response → isServerSideProvider = true。
			// - CodeBuddy API: 仅返回 tool call，需客户端本地执行 → false。
			// - 其他 BYOK provider: 默认 false。
			// - Individual tool calls may also carry explicit tc.serverExecuted flag.
			//
			// 🔧 2026-06-10 修复：原来的 isDirectMode 将所有直连模式的工具都视为
			// server-executed，导致 CodeBuddy API 返回的工具调用被跳过，agent loop
			// 一轮即结束（用户反馈："发一条消息就结束了"）。
			// 改为读取 provider 自身的 isServerSideProvider 属性。
			const activeProvider = host._getActiveModelProvider();
			const isServerSideProvider = activeProvider?.isServerSideProvider === true;
			const serverExecutedCalls = effectiveToolCalls.filter(tc =>
				tc.serverExecuted === true || isServerSideProvider
			);
		let localExecutedCalls = isServerSideProvider
			? []
			: effectiveToolCalls.filter(tc => tc.serverExecuted !== true);

			// ─── 输出上限截断保护（2026-09-17 接线）─────────────────────────
			// assistant 消息撞输出 token 上限（finishReason=length/max_tokens）时仍可能
			// 带出工具调用：流式参数由「尽力而为」的 JSON 抢救解析器收尾，因此这些调用
			// 的参数**可能解析通过、校验通过，但内容静默不完整** —— 例如 patch 的
			// `replace` 被截掉后半段、execute_code 的 command 少了尾部管道。执行它们
			// 会造成真实的错误写入，比不执行严重得多。
			//
			// 判据与失败结果构造复用 `turnToolExecution.ts`（provider 对该 reason 的
			// 拼写不统一，`length` / `max_tokens` 都表示同一件事，判据必须只有一处）。
			//
			// 位置约束：必须在 `serverExecutedCalls` 处理与白名单/去重过滤**之前**，
			// 即所有执行路径的唯一上游。放在 `:3835` 之后会漏掉控制工具分支。
			if (isTruncatedByOutputLimit(lastFinishReason) && localExecutedCalls.length > 0) {
				host._logService.warn(
					`[AgentOS] Response truncated by output limit (finishReason=${lastFinishReason}) with `
					+ `${localExecutedCalls.length} tool call(s) — failing them all instead of executing `
					+ `possibly-truncated arguments: ${localExecutedCalls.map((c: any) => c.name).join(', ')}`,
				);
				for (const outcome of failToolCallsFromTruncatedMessage(localExecutedCalls)) {
					// `createErrorToolResult` 的 content 已是纯 string（turnToolExecution.ts:109），
					// 故只做长度限制与净化，**不过** `safeStringifyToolResult` —— 那会把字符串
					// 再 JSON 编码一层，模型读到的就是带转义引号的 `"..."`。
					const truncatedText = sanitizeToolResultText(
						limitToolResultSize(String(outcome.result.content)),
					);
					messages = appendMessages(messages, {
						role: 'tool',
						content: truncatedText,
						toolCallId: outcome.call.id,
					});
					yield { type: 'tool_result', content: truncatedText, toolCallId: outcome.call.id };
					yield { type: 'tool_end', toolCallId: outcome.call.id, success: false };
					// 登记到 endedToolIds：`:2142` 的孤儿补偿会为「有 tool_start 却无
					// tool_end」的 ID 再补一次合成事件。不登记就会重复发 tool_end
					// （实测本用例曾断言到 2 次），UI 侧计数与卡片状态都会错。
					endedToolIds.add(outcome.call.id);
				}
				syncMessages();
				// 不 break：模型需要看到这批失败原因，才能在下一轮用完整参数重发。
				// 清空后续执行面，跳过本轮所有实际执行路径。
				localExecutedCalls = [];
			}


			/**
			 * 将工具失败恢复提示追加到结果文本中。
			 * 借鉴 Hermes-Agent: 工具失败后告诉 LLM "试试别的方案"，而非让它盲目重试。
			 */
			const appendRecoveryHint = (resultStr: string, toolCallId: string): string => {
				const tc = localExecutedCalls.find((c: any) => c.id === toolCallId);
				if (!tc) { return resultStr; }
				const hint = getToolFailureRecoveryHint(tc.name);
				if (!hint) { return resultStr; }
				return resultStr + `\n\n[Hint: ${hint}]`;
			}

			if (serverExecutedCalls.length > 0) {
				host._logService.info(`[AgentOS] ${serverExecutedCalls.length} tool calls were server-executed (skipping local execution): ${serverExecutedCalls.map((tc: any) => tc.name).join(', ')}`);
				for (const tc of serverExecutedCalls) {
					const serverResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({
						ok: true,
						serverExecuted: true,
						note: 'Tool was executed on the server side; result incorporated into subsequent model response.',
					})));
					// 添加 tool message 到历史（即使结果是占位的），确保 messages 中
					// 每个 assistant toolCall 都有对应的 tool result，否则模型可能困惑。
					// 但如果所有工具都是 serverExecuted 且即将 break，则无需添加
					// （因为不会再有下一轮迭代）。
					if (localExecutedCalls.length > 0) {
						messages = appendMessages(messages, {
							role: 'tool',
							content: serverResultStr,
							toolCallId: tc.id,
						});
						syncMessages();
					}
					yield {
						type: 'tool_result',
						content: serverResultStr,
						toolCallId: tc.id,
					};
					yield {
						type: 'tool_end',
						toolCallId: tc.id,
						success: true,
					};
					endedToolIds.add(tc.id);
				}

				// 如果所有工具都是服务端执行的，不需要继续 agent loop —
				// 服务端 Agent（如 Knot）会在同一次 chat() 流中完成所有工具
				// 调用循环并返回后续文本，客户端不应再发起新一轮 LLM 请求。
				if (localExecutedCalls.length === 0) {
					host._logService.info('[AgentOS] All tool calls were server-executed — ending local agent loop (server handles the loop)');
					yield { type: 'done' };
					break;
				}
			}

			// ─── 执行工具调用（仅本地需要执行的）────────────────────────
			// Wrap in try/catch so any provider/internal exception cannot break the
			// generator before we have a chance to yield tool_end + done.
			//
			// CRITICAL FIX (用户反馈："工具一直在转圈，明明已经完成任务了还在执行"):
			// We previously did `await Promise.all(...)` then yielded tool_end for each
			// tool. This means a fast tool (file_read, 60ms) would have its tool_end
			// blocked for 60+ seconds waiting for a slow sibling (search_files timing
			// out at 60s). The UI saw all spinners spinning for the whole duration of
			// the slowest tool — the user's exact complaint.
			//
			// Fix: stream results as each individual tool finishes, so each tool_end
			// flushes to the UI at its real completion time. We collect into
			// `toolResults` for the message history while streaming.
			let canParallel = shouldParallelizeToolBatch(localExecutedCalls);
			// 防止沙箱确认重提示死循环：同一 toolCallId 在一个迭代内只提示一次，
			// 重执行后若仍被拦截（如持久化失败）则不再提示，直接保留失败。
			const handledSandboxIds = new Set<string>();
			const toolResults: Array<{ toolCallId: string; content: any; success: boolean }> = [];

		// ─── Runtime hardPermission interception (MiMo alignment) ──────────
		// Tools remain in the schema (prefix-cache stable), but write/execute
		// tools are BLOCKED at runtime in plan mode. The LLM sees the tool,
		// tries to call it, gets a clear "blocked" error — learns not to retry.
		// Exception: writes to plan files (plans/*.md) are allowed.
		// WorkMode is mutable via plan_enter/plan_exit; ChatMode remains stable.
		const hardPerm = host._resolveHardPermissionForWorkMode?.(runState.work.mode) ?? host._resolveHardPermission(request);
		// 策略级硬权限谓词（`IterationPlan.hardPermission`，由 turnIterationGate 每轮捕获）。
		// 与 hardPerm 是**两个独立来源**：前者按 workMode（plan），后者按范式
		// （readonly 的写工具黑名单）。二者形状不同，统一判据见
		// `isToolCallDeniedByTurnPolicy`；任一拦截即拦截。
		const strategyPerm = loopState.iterationHardPermission;

		// ─── Control tools (plan_enter/plan_exit): skip normal handler ───
		// These are intercepted below; running the placeholder handler + the
		// interceptor produces dual tool results for the same toolCallId.
		const controlToolNames = new Set(['plan_enter', 'plan_exit']);
		// Remove control tools from local execution — will be processed by interceptors below
		localExecutedCalls = localExecutedCalls.filter(tc => !controlToolNames.has(tc.name));

		if ((hardPerm || strategyPerm) && localExecutedCalls.length > 0) {
			const deniedCalls: any[] = [];
			const allowedCalls: any[] = [];
			const denialReasons = new Map<string, { reason: string; source: 'policy' | 'strategy' }>();
			for (const tc of localExecutedCalls) {
				const denial = isToolCallDeniedByTurnPolicy(tc.name, hardPerm, strategyPerm);
				if (denial.denied) {
					// 计划文件豁免：写 <sarosRoot>/plans/*.md 是 plan 模式的本职动作。
					// ⚠ 2026-08-21（日志 1787294819356）此处原先手写工具名列表
					// （file_write/file_edit/write/edit）**漏了 `patch`**，而模型在
					// file_write 走不通时的自然退路正是 patch → 两条路都断 → 计划写不进
					// 文件 → plan_exit 恒因 tasks=0 被拒 → 死锁（模型最终 clarify 求助）。
					// 现统一走 isPlanFileWriteCall（含 patch + planRoot 三重安全校验），
					// 与审批层共用同一判据，避免两处各写一份必然漂移。
					//
					// ⚠ 豁免只对 policy（plan 模式）来源成立：readonly 范式的语义是
					// 「什么都不写」，写计划文件同样必须拦 —— 否则策略拦截被豁免绕过。
					let isPlanFileWrite = false;
					if (denial.source === 'policy') {
						try {
							const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
							const planRoot = pathJoin(host._getSarosRoot?.() ?? '', 'plans');
							isPlanFileWrite = isPlanFileWriteCall(tc.name, args, planRoot);
						} catch { /* parse failure → not a plan file */ }
					}
					if (isPlanFileWrite) {
						allowedCalls.push(tc);
					} else {
						deniedCalls.push(tc);
						denialReasons.set(tc.id, {
							reason: denial.reason ?? 'denied by hard permission',
							source: denial.source ?? 'policy',
						});
					}
				} else {
					allowedCalls.push(tc);
				}
			}
			if (deniedCalls.length > 0) {
				host._logService.info(`[AgentOS] hardPermission blocked ${deniedCalls.length} tool(s) in workMode=${runState.work.mode}: ${deniedCalls.map((tc: any) => tc.name).join(', ')}`);
				for (const tc of deniedCalls) {
					// 文案按来源分流：plan 模式给「写计划文件 → plan_exit」的出路；
					// 策略拦截（readonly 范式）没有出路可给，只能说明范式限制 ——
					// 沿用 plan 文案会诱导模型反复重试写文件，制造无进展循环。
					const denialInfo = denialReasons.get(tc.id);
					const blockMsg = denialInfo?.source === 'strategy'
						? `Tool "${tc.name}" is blocked: ${denialInfo.reason}. This agent runs in a read-only paradigm — write/execute tools are unavailable for the whole turn. Report findings instead of attempting modifications.`
						: `Tool "${tc.name}" is blocked: ${denialInfo?.reason ?? hardPerm?.reason}. In plan work mode, you can only read files and write the plan file. Complete the structured plan, then call plan_exit.`;
					toolResults.push({
						toolCallId: tc.id,
						content: { error: blockMsg },
						success: false,
					});
					messages = appendMessages(messages, {
						role: 'tool',
						content: blockMsg,
						toolCallId: tc.id,
					});
					syncMessages();
					yield { type: 'tool_result', content: blockMsg, toolCallId: tc.id };
					yield { type: 'tool_end', toolCallId: tc.id, success: false };
					endedToolIds.add(tc.id);
				}
				localExecutedCalls = allowedCalls;
			}
		}
			// If all tool calls were server-executed, skip the local execution block entirely.
			if (localExecutedCalls.length > 0) {
				// ── Tool Call Loop Detection（借鉴 OpenClaw `detectToolCallLoop`）──────
				// 在执行前检测同一工具+相同参数的重复调用
				// ─── Ping-pong 检测（A→B→A→B 交替，对齐 openclaw）────────────────
				// detectToolCallLoop 只看「同一签名重复」；ping-pong 是两个不同调用来回切换，
				// 单看每个签名都不重复 → 被完全漏检。故在此对本批**整批判定一次**。
				// 仅当 noProgressEvidence（两侧结果各自稳定）才拦截；结果在变说明仍在推进。
				//
				// 判定收口到 `turnStopGate.classifyPingPong`（纯函数，三出口 none /
				// allow-changing / block-batch）；此处只负责文案与日志两个副作用。
				let _pingPongMsg: string | undefined;
				const _pingPong = detectToolCallPingPong(runState.toolCallHistory);
				const _pingPongVerdict = classifyPingPong(_pingPong.pingPong, _pingPong.noProgressEvidence);
				if (_pingPongVerdict.kind === 'block-batch') {
					_pingPongMsg =
						`Blocked: ping-pong loop between "${_pingPong.toolA}" and "${_pingPong.toolB}" ` +
						`(${_pingPong.length} alternating calls) with identical results on both sides. ` +
						`Switching between these two calls is making no progress — the information you need is not here. ` +
						`Use a different tool or a different approach, or proceed with the results you already have.`;
					host._logService.warn(
						`[AgentOS] Ping-pong loop: ${_pingPong.toolA} <-> ${_pingPong.toolB} ` +
						`(${_pingPong.length} alternating calls, stable results both sides) — blocking entire batch`,
					);
				} else if (_pingPongVerdict.kind === 'allow-changing') {
					host._logService.warn(
						`[AgentOS] Ping-pong pattern: ${_pingPong.toolA} <-> ${_pingPong.toolB} ` +
						`(${_pingPong.length} calls) but results still changing — allowing`,
					);
				}

				const filteredCalls = localExecutedCalls.filter(tc => {
					// ping-pong 是**整批**的模式而非单个调用的属性，命中则本批全部拦截
					if (_pingPongMsg) { return false; }
					const rawArgs = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
					let args: Record<string, unknown>;
					try { args = JSON.parse(rawArgs) as Record<string, unknown>; } catch { args = {}; }
					// 必须与 detectToolCallLoop 内部共用同一规范化函数，否则存入 history 的
					// 签名与比对时的签名算法不一致 → 永远匹配不上 → 循环检测静默失效。
					const argsHash = canonicalToolArgsHash(args);

					// Hermes 护栏 before_call：只读工具「同签名 + 同结果」反复返回 → 判定无进展。
					// 只采纳 no_progress_block（exact/same_tool 的 block 已由配置关闭，见护栏声明处）。
					const _before = _toolGuardrail.beforeCall(tc.name, args);
					if (_before.action === 'block') {
						if (_before.code === 'idempotent_no_progress_block') {
							_guardrailBlocked.set(tc.id, _before);
							host._logService.warn(
								`[AgentOS] Guardrail no-progress block: "${tc.name}" returned identical result ` +
								`${_before.count} times with identical args — blocking`,
							);
							return false;
						}
						// 其余 block 类型理论上不可达（配置已关闭）。记录后放行，宁可放过也不误伤。
						host._logService.warn(`[AgentOS] Guardrail unexpected block code=${_before.code} — allowing`);
					}

					const { loop, count } = detectToolCallLoop(runState.toolCallHistory, tc.name, args);
					// 无论是否 loop，都记录到历史（对齐原内联函数无条件 push）。
					// streakKey 是「整轮」签名（以 thinking 为主键，见 common/reasonStreak.ts），
					// 同轮多个工具算出相同的 key —— 这正是「工具漂移仍算同一 streak」的实现方式。
					const _roundStreakKey = computeStreakKey({
						reasoning: thinkingContent,
						toolCalls: [{ name: tc.name, argsHash }],
					});
					runState = reduceRunState(runState, {
						type: 'RECORD_TOOL_CALL',
						name: tc.name,
						argsHash,
						streakKey: _roundStreakKey,
					});
					if (loop) {
						host._logService.warn(`[AgentOS] Tool call loop detected: "${tc.name}" called ${count} times with same args — blocking`);
						return false;  // 阻止执行
					}
					return true;
				});
				if (filteredCalls.length < localExecutedCalls.length) {
					// 为被阻止的工具生成错误结果
					const blockedCalls = localExecutedCalls.filter(tc => !filteredCalls.includes(tc));
					host._logService.info(
						`[AgentOS][Diag] iter=${loopState.iteration} blockSummary: total=${localExecutedCalls.length} ` +
						`allowed=${filteredCalls.length} blocked=${blockedCalls.length} ` +
						`reasons={pingPong=${!!_pingPongMsg},loop=${blockedCalls.length - (!!_pingPongMsg ? 0 : (blockedCalls.length > 0 ? 1 : 0))},guardrail=${_guardrailBlocked.size}} ` +
						`blockedNames=[${blockedCalls.map((tc: any) => tc.name).join(',')}]`,
					);
					for (const tc of blockedCalls) {
						// 护栏（no-progress）拦截的调用用其专属文案，否则沿用循环检测文案。
						// 取后即删：decision 一次性，避免跨轮误用与 Map 无限增长。
						const _guardDecision = _guardrailBlocked.get(tc.id);
						_guardrailBlocked.delete(tc.id);
						const _blockMsg = _pingPongMsg
						?? _guardDecision?.message
						?? buildLoopBlockFeedback(tc.name, tc.arguments);
						toolResults.push({
							toolCallId: tc.id,
							content: [{ type: 'text', text: _blockMsg }],
							success: false,
						});
						// ⚠⚠ 2026-08-22（日志 1787377582459，实测 37 次）：**只在该 id 从未
						// 发过 tool_start 时才补发**。这些调用是模型正常发出的，adapter 早已
						// 在 delta 阶段 yield 过 tool_start（并登记进 startedToolIds）——
						// 无条件再补一次会让 renderer **重复建卡**（`case 'tool_start'` 是裸
						// `toolCalls.push()`，对同 id 无去重），且这张重复卡：
						//   · `content: ''` 无参数；
						//   · 后到的 `tool_args` 用 `find(tc => tc.id === ...)` 只命中**第一张**，
						//     所以它永远拿不到参数 → 显示「读取未知文件」/ execute_code 空白卡。
						// 实测每轮 `tool_start=4` 而 `tool_result=2 tool_end=2 tool_args=2`，
						// 多出的 2 个就是这里补的；37 轮累计 74 张幽灵卡，同时把 parts 从 48
						// 推到 223（每轮 +5 而真实只需 +3），是 UI 抖动的主要放大器。
						// 判据复用既有的 startedToolIds（本文件 2543 / 2776 登记），不新建状态。
						if (!startedToolIds.has(tc.id)) {
							startedToolIds.add(tc.id);
							yield { type: 'tool_start', content: '', toolCallId: tc.id, toolName: tc.name };
						}
						yield { type: 'tool_result', content: _blockMsg, toolCallId: tc.id };
						yield { type: 'tool_end', toolCallId: tc.id, success: false };
						endedToolIds.add(tc.id);
					}
					if (filteredCalls.length === 0) {
						// ── 全部被阻止 → 零进展空转，必须升级干预（2026-08-22）────────
						// 原实现直接 `continue`，等于每轮白烧一次完整 prompt。日志
						// 1787377582459 实测连续 37 轮 `All 2 tool calls blocked`，模型每轮
						// 输出**逐字节相同**的 229 个 delta，完全无视「已被跳过」的 tool
						// result，一路空转到迭代上限（30k+ token × 5–8s × 37）。
						// 分三档升级（阈值集中在 loopReminders.ts，便于据日志调参）：
						//   ① 首次/第 1 次   —— 仅回填 tool result（保持原行为，给模型自纠机会）
						//   ② 连续 ≥2 次     —— 注入「整轮无进展」强提醒（单工具级提醒此时已被忽略）
						//   ③ 连续 ≥4 次     —— 禁用工具 + 强制收尾轮，避免烧到 100 轮
						patchGuardrails({ allBlockedStreak: guardrails().allBlockedStreak + 1 });
						const _allBlockedStreak = guardrails().allBlockedStreak;
						host._logService.warn(
							`[AgentOS] All ${localExecutedCalls.length} tool calls blocked by loop detection ` +
							`(consecutive zero-progress turns: ${_allBlockedStreak})`,
						);
						_auditMark('allToolCallsBlocked', _allBlockedStreak, ALL_BLOCKED_WRAPUP_AT,
							localExecutedCalls[0]?.name);
						for (const tr of toolResults) {
							messages = appendMessages(messages, { role: 'tool', content: (tr.content[0] as any)?.text ?? '', toolCallId: tr.toolCallId });
							syncMessages();
						}
						const _blockedNames = [...new Set(localExecutedCalls.map(tc => tc.name))].join(', ');
						// 三档升级的**判定**收口到 turnStopGate（classifyAllBlockedStreak）；
						// 日志 / 审计 / 消息注入 / patchWrapUp 等副作用保留原地。
						// ⚠ 不可换成聚合的 classifyGuardrailStreak：它的 textSearch 硬上限
						// 分支排在最前，此处 textSearchStreak 可能非零 → reason/hint 会跑偏。
						const _allBlockedVerdict = classifyAllBlockedStreak(
							_allBlockedStreak,
							guardrails().allBlockedReminderSent,
							{ reminderAfter: ALL_BLOCKED_ESCALATE_AT, wrapUpAfter: ALL_BLOCKED_WRAPUP_AT },
						);
						if (_allBlockedVerdict.decision.kind === 'wrap-up') {
							// ③ 强制收尾：**复用既有的 wrap-up 机制**（wrapUp().forced
							// 行同一开关），它已经做齐三重保障：`_iterationToolDefs = []` →
							// enabledTools 置空 → 再叠加 `toolChoice: 'none'`。
							// ⚠ 不要另造一个「禁工具」标志 —— 那必然与这套漂移。
							// 文案单列（allBlockedWrapUpReminder）：撞迭代上限是「跑了很多**有效**
							// 轮」，这里是零进展空转，必须明确点出「工具已被禁用」，否则模型会
							// 继续尝试调用、白烧最后一轮。
							host._logService.warn(`[AgentOS] Zero-progress streak hit ${_allBlockedStreak} — forcing wrap-up round (tools disabled)`);
							_auditFired('allToolCallsBlocked', ALL_BLOCKED_WRAPUP_AT);
							messages = appendMessages(messages, { role: 'system', content: allBlockedWrapUpReminder(_allBlockedStreak) });
							syncMessages();
							patchWrapUp({ reasonReminderInjected: true, forced: true });
						} else if (_allBlockedVerdict.reminders.includes('all-blocked-strong')) {
							// ② 强提醒只注入一次 —— 反复注入会污染前缀缓存且被模型进一步忽略。
							patchGuardrails({ allBlockedReminderSent: true });
							messages = appendMessages(messages, { role: 'system', content: allToolCallsBlockedReminder(_allBlockedStreak, _blockedNames) });
							syncMessages();
						}
						continue;
					}
					// 有工具真正执行 → 零进展连击清零（与其它 streak 计数器同姿态）。
					patchGuardrails({ allBlockedStreak: 0, allBlockedReminderSent: false });
					localExecutedCalls = filteredCalls;
				}
				// ── Hook: before_tool（经总线分发；provider 的 pre_tool_use 由
				//    turnHookWiring 注册为 handler 并保持 fire-and-forget）──────
				// ⚠ before_tool 是 fail-closed 钩子：handler 抛错 → TurnHookGateError
				// → 该工具不得执行。当前唯一 handler（memory 转发）绝不抛错，故实际
				// 走不到拦截分支；此处仍完整处理，避免将来新增 handler 时静默放行。
				if (hookBus.has('before_tool')) {
					const blockedCallIds = new Set<string>();
					for (const tc of localExecutedCalls) {
						try {
							const gate = await hookBus.runWithGate('before_tool', {
								toolCallId: tc.id, toolName: tc.name, args: tc.arguments,
							});
							if (gate?.block) {
								blockedCallIds.add(tc.id);
								host._logService.warn(
									`[AgentOS] Tool "${tc.name}" blocked by before_tool hook: ${gate.block.reason}`,
								);
							}
						} catch (error) {
							// TurnHookGateError = 权限钩子自身崩了。fail-closed 语义要求
							// 拒绝执行，而非当作「无意见」放行。
							blockedCallIds.add(tc.id);
							host._logService.error(
								`[AgentOS] before_tool gate failed for "${tc.name}" — refusing execution: ${String(error)}`,
							);
						}
					}
					if (blockedCallIds.size > 0) {
						localExecutedCalls = localExecutedCalls.filter(
							(tc: any) => !blockedCallIds.has(tc.id),
						);
					}
				}
				// 进入工具执行前显式置 phase=tool_executing（对齐 UI 广播，phase 进 runState 供 checkpoint 读取）
				runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'tool_executing' });
				// ⚠️ 并行 tool_calls 相邻性保护（2026-08-17，日志 1786981850420 HTTP 400 code 11133）：
				// OpenAI 兼容协议硬性要求「assistant.tool_calls=N 之后必须紧跟连续 N 条 tool 消息」，
				// 中间不得插入任何其它 role。此前 _processToolResult 在 append tool result **之前**
				// 直接注入护栏 reminder（role:'user'），并行批次下会把 tool result 序列劈开：
				//   [assistant tool_calls=4] [tool c0] [tool c1] [tool c2] [user reminder] [tool c3]
				// → 服务端判定消息序列非法 → 400 invalid_parameter_value（与 token 用量无关，
				//   实测仅占窗口 6%）。且 sanitizeToolPairs 只校验「配对存在性」不校验相邻性，
				//   normalizeMessages 也只合并连续 user，两道守卫都放行了这种畸形。
				// 修复：循环内只收集 reminder，待整批 tool result 全部 append 完成后统一 flush，
				// 保证 tool 序列连续紧邻。声明在 try 外，供 catch 之后的 flush 点可见。
				const _pendingBatchReminders: string[] = [];

				// ── MiMo-Code reasoning streak（P1）────────────────────────────
				// 与 per-call 的 detectToolCallLoop 互补：后者只看「同一工具 + 同一参数」，
				// 抓不到「thinking 内容不变、工具不断漂移」这一主流卡死形态。本判定以
				// thinking 为主键（reasonStreak.ts），工具漂移仍算同一 streak。
				//
				// 纯检测 + 强引导注入，**不阻断执行**：streakKey 来自上一轮已落库的
				// history（本轮调用在下方过滤循环中才写入），故这里评估的是「截至上一轮」
				// 的连续情况，天然滞后一轮 —— 这是刻意的，避免把本轮尚未执行的调用算进去。
				// reminder 走 _pendingBatchReminders 延迟通道（与 consecutiveFail 同款），
				// 保证 tool result 序列紧邻不被 user 消息劈开。
				{
					const _streakHistory = runState.toolCallHistory
						.map((entry) => entry.streakKey ?? '')
						.filter((key) => key.length > 0);
					const _reasonStreak = detectReasonStreak(_streakHistory);
					if (_reasonStreak >= REASON_STREAK_TRIGGER_COUNT) {
						host._logService.warn(
							`[AgentOS] Reasoning streak detected: identical thinking for ${_reasonStreak} consecutive rounds ` +
							`(iter=${loopState.iteration}) — injecting recovery guidance`,
						);
						_auditFired('reasonStreak', REASON_STREAK_TRIGGER_COUNT);
						_pendingBatchReminders.push(reasonStreakReminder(_reasonStreak));
					}
				}

				// ── openclaw argument_churn（P3）───────────────────────────────
				// 与上面三者互补的第四种形态：**同一工具、参数每次都不一样、连续反复**。
				// loop（同参）与 ping-pong（两工具交替）都要求签名重复或交替，天然漏检
				// 这种「不断微调参数再试一次」的偏执。纯检测 + 引导注入，**不阻断执行**：
				// 连续读不同文件 / 跑不同命令在形态上完全一致，误报面大，故只提醒不定罪。
				{
					const _churn = detectArgumentChurn(runState.toolCallHistory);
					if (_churn.churn) {
						const _churnTool = _churn.toolName ?? 'tool';
						if (isMultiTargetChurnTool(_churnTool)) {
							// ★ 2026-09-16：多目标工具只留痕、不注入引导（判据与理由见
							// `isMultiTargetChurnTool`）。刻意用 info 且**不** `_auditFired` ——
							// 审计水位只登记「真的出手过」的护栏，否则报告里的 argumentChurn
							// 会显示成「触发了却没生效」。
							host._logService.info(
								`[AgentOS][Diag] Argument churn (multi-target tool, guidance suppressed): "${_churnTool}" ` +
								`called ${_churn.length} times in a row with ${_churn.distinctArgs} different arguments (iter=${loopState.iteration})`,
							);
						} else {
							host._logService.warn(
								`[AgentOS] Argument churn detected: "${_churnTool}" called ${_churn.length} times ` +
								`in a row with ${_churn.distinctArgs} different arguments (iter=${loopState.iteration}) — injecting recovery guidance`,
							);
							_auditFired('argumentChurn', RUN_STATE_LIMITS.ARGUMENT_CHURN_THRESHOLD);
							_pendingBatchReminders.push(argumentChurnReminder(_churnTool, _churn.length));
						}
					}
				}

				// [ToolAudit] 登记本批次入参指纹（供 dup 统计）。放在连击检测之前，
				// 保证串行/并行/delegate-split 三条执行路径都已覆盖。
				_auditRegisterArgs(effectiveToolCalls as ReadonlyArray<{ id: string; name: string; arguments?: unknown }>);

				// ─── [AntiGuidance] 违反自身 description 明确指引的调用（2026-08-22）──
				// 背景（日志 1787384463685）：已把「哪些形态会触发审批 / 查行数该用
				// file_read」写进 execute_code + terminal 的 description，实测
				// toolsSchemaTokens 13509→13912 证明确已送达且未被截断，但模型仍发出
				// `powershell -NoProfile -Command "(Get-Content x).Count"` —— 同时违反
				// 「别包解释器」与「查行数用 file_read」两条。
				// 此前无法区分：① 没送达 ② 被截断 ③ 送达且完整、模型不听。
				// 这条日志把 ③ 变成可计量事实（命中哪条规则 + description 原话 + 正确做法），
				// 据此才能决定下一步是改文案还是升级为硬拦截。
				// **只记录不拦截** —— 先观察频率；计入 ToolAudit 水位便于跨 turn 统计。
				for (const _tc of effectiveToolCalls as ReadonlyArray<{ name: string; arguments?: unknown }>) {
					if (!isShellToolWithCommandArg(_tc.name)) { continue; }
					try {
						const _isStrArgs = typeof _tc.arguments === 'string';
						const _a = _isStrArgs ? JSON.parse(_tc.arguments as string) : _tc.arguments;
						const _cmd = typeof (_a as any)?.command === 'string' ? (_a as any).command : '';
						if (!_cmd) { continue; }
						// ★ 2026-09-06 方案 B：leading-cd 是**确定性可无损改写**的形态
						// （dir 与 rest 的切分不依赖语义）——执行前直接规范化成
						// cwd + command，本次执行即为正确形态（不再带 `&&`、不再
						// 依赖 shell 的 cd 副作用）；仍打 INFO 回灌以承担教育职能。
						// 不可安全改写（含变量/命令替换等）时回落原告警路径。
						const _rw = tryRewriteLeadingCd(
							_cmd,
							typeof (_a as any)?.cwd === 'string' ? (_a as any).cwd : undefined,
						);
						if (_rw) {
							// ★★ 2026-09-19：cd 改写之后**接着**夹长 sleep —— 真机那条病根命令正是
							// `cd <repo> && sleep 200; …`（两种形态叠在一起 ✗），只做 cd 改写会**漏掉**它 ✗。
							const _rwSleep = tryClampLeadingSleep(_rw.command);
							const _nextArgs = { ...(_a as any), command: _rwSleep ? _rwSleep.command : _rw.command, cwd: _rw.cwd };
							// arguments 可能是 string（协议层）或 object（内部），分别写回；
							// tc 字段为 readonly → map 产生新对象覆盖（同废弃名归一化写法）。
							effectiveToolCalls = effectiveToolCalls.map(t => t === _tc
								? { ...t, arguments: _isStrArgs ? JSON.stringify(_nextArgs) : _nextArgs }
								: t);
							host._logService.info(formatLeadingCdRewriteLog(_tc.name, _rw));
							if (_rwSleep) {
								// 日志里保留**完整原始命令**（含被去掉的 cd 前缀）⇒ 与 AntiGuidance 的 before 同口径 ✓
								host._logService.info(formatSleepClampLog(_tc.name, { ..._rwSleep, original: _rw.original }));
							}
							_auditMark('antiGuidanceRewritten', (_audit.watermarks.get('antiGuidanceRewritten')?.max ?? 0) + 1, 0, _tc.name);
							continue;
						}
						// ★★ 2026-09-19（②「长任务等待」第一刀）：**长 leading sleep 夹短**。
						// 真机证据（外部日志 `vscode-app-1789813310143.log`）：agent 用 `sleep 200; …` **轮询**
						// 等长任务，9 轮撞满 1800s 工具超时 ⇒ **一个 turn 白等 30 分钟** ✗✗。
						// 夹到 15s 后**语义不变**（还是"等一下再看"✓），但 wall-time 从 30min 降到分钟级、
						// 且轮询更密 ⇒ 长任务一完成就能被看到 ✓✓。详见 `tryClampLeadingSleep` 的说明。
						const _sl = tryClampLeadingSleep(_cmd);
						if (_sl) {
							const _slArgs = { ...(_a as any), command: _sl.command };
							effectiveToolCalls = effectiveToolCalls.map(t => t === _tc
								? { ...t, arguments: _isStrArgs ? JSON.stringify(_slArgs) : _slArgs }
								: t);
							host._logService.info(formatSleepClampLog(_tc.name, _sl));
							_auditMark('antiGuidanceRewritten', (_audit.watermarks.get('antiGuidanceRewritten')?.max ?? 0) + 1, 0, _tc.name);
							continue;
						}
						const _findings = detectAntiGuidanceCommand(_cmd);
						if (_findings.length > 0) {
							host._logService.warn(formatAntiGuidanceLog(_tc.name, _cmd, _findings));
							_auditMark('antiGuidanceCall', (_audit.watermarks.get('antiGuidanceCall')?.max ?? 0) + 1, 0, _tc.name);
						}
					} catch { /* 参数解析失败不影响执行 */ }
				}

				// ─── 单只读工具连击检测（批量并行引导）────────────────────────
				// 在批次执行前判定：本轮是否「只请求 1 个工具且该工具只读安全」。
				// 达阈值时把提醒交给 _pendingBatchReminders 延迟注入（保证 tool
				// result 序列与 assistant.tool_calls 相邻，见上方 400 事故说明）。
				{
					const _onlyOne = effectiveToolCalls.length === 1;
					const _soleName = _onlyOne ? effectiveToolCalls[0]?.name : undefined;
					const _isSingleReadOnly = !!_soleName && isParallelSafeReadOnlyTool(_soleName);
					const _adv = advanceSingleToolStreak(guardrails().singleToolStreak, _isSingleReadOnly, MAX_SINGLE_TOOL_STREAK);
					patchGuardrails({ singleToolStreak: _adv.streak });
					const _singleToolStreak = _adv.streak;
					if (_isSingleReadOnly && _soleName) {
						if (!_singleToolStreakNames.includes(_soleName)) { _singleToolStreakNames.push(_soleName); }
					} else {
						_singleToolStreakNames.length = 0;
					}
					if (_adv.shouldGuide) {
						// ⚠ 2026-08-22：原为 `debug` 级 → 生产日志默认看不见。而「17 轮
						// 单工具串行浪费 11 轮 LLM 往返」是明确缺陷（每轮重传 27k–60k
						// token，却只为一次 100–800ms 的搜索），必须 warn 级可见。
						host._logService.warn(
							`[AgentOS][Diag] single read-only tool streak reached ${_singleToolStreak} — injecting batch-parallel guidance (tools: ${_singleToolStreakNames.join(', ')})`,
						);
						_auditFired('singleToolStreak', MAX_SINGLE_TOOL_STREAK);
						_pendingBatchReminders.push(
							batchReadOnlyToolsReminder(_singleToolStreak, _singleToolStreakNames.join(', ')),
						);
					}
					// 审计水位：连击变量达阈值后会清零，故最高值需单独留痕。
					if (_singleToolStreak > _audit.maxSingleToolStreak) {
						_audit.maxSingleToolStreak = _singleToolStreak;
					}
					if (_isSingleReadOnly && _soleName) { _audit.streakNames.add(_soleName); }
					_auditMark('singleToolStreak', _singleToolStreak, MAX_SINGLE_TOOL_STREAK, _soleName);
				}
		try {
			// P1: 审批路由上下文（MiMo decideAskRouting）。在工具执行循环所在闭包内派生，
			// 因为 request.subAgent 在该作用域可见；若放在外层块声明则无法穿透到此处（TS2304）。
			const askRouting = deriveAskRoutingContext(request.subAgent, undefined, runState.work.mode);

			// ★★ 2026-09-13：主模型是否支持**图片输入** —— 必须在闭包**外**解析：
			// `_processToolResult` 是**同步** generator（不能用 `await`），能力值由闭包捕获。
			// 用途：工具结果里的图像项改走 `role:'user'` 消息前**必须**门控它 ——
			// 对不支持图片的模型发图会让 provider 直接 400（Claude Code 的 `Read` 踩过）。
			// 解析结果按 provider::model 缓存（见 `toolResultImages.resolveSupportsImages`），
			// 故每轮一次的成本可忽略；失败一律 false（fail-closed：不发图）。
			const _turnSupportsImages = await resolveSupportsImages(modelProvider, selection?.modelId);

			// ─── 沙箱确认 → 收尾（三条路径共用，2026-09-17 收口到 turnToolExecution）──
			// 原先 headSerial（`:4593`）与 serial（`:4660`）各内联约 25 行逐字重复的
			// 「违规判定 → 弹卡片 → 等决策 → 重执行」，而**并行路径完全没有这段** ——
			// 同一个沙箱违规走并行路径时用户拿不到确认卡片，工具直接失败。这是名单式
			// 重复实现必然产生的行为分叉，现由 `finalizeToolCall` 单点承载。
			//
			// `_resolveSandbox` 是 async generator 而非 async 函数：必须先把确认卡片
			// yield 给 UI，**再**阻塞等用户点按钮。若返回 Promise，卡片只会在决策之后
			// 才到达 UI，用户面对的是一个永远等不到卡片的暂停。
			async function* _resolveSandbox(
				call: ITurnToolCall,
				result: ITurnToolResult,
			): AsyncGenerator<IChatStreamDelta, ISandboxResolution, void> {
				const violation = (result as { metadata?: { sandboxViolation?: ISandboxViolationInfo } })
					.metadata!.sandboxViolation!;
				const confirmationId = `sandbox-${result.toolCallId}-${Date.now().toString(36)}`;
				const card = host._buildSandboxConfirmationCard(call.name, violation);
				card.id = confirmationId;
				// 关联工具调用 ID：写文件等工具卡片内嵌询问按钮时匹配用
				card.toolCallId = result.toolCallId;
				yield { type: 'confirmation', confirmationData: card };
				const decision = await host._awaitSandboxConfirmation(confirmationId);
				yield {
					type: 'confirmation_resolved',
					confirmationId,
					confirmationStatus: host._mapDecisionToCardStatus(decision),
				};
				// 重执行必须拿到**原始调用**（含真实 arguments）。配不回原调用时
				// 一律不重执行、保留原失败结果 —— 与原三条路径的 `if (tc)` 同义。
				// 绝不可用兜底造的空 `arguments` 去重执行：那会以空参数真实调用工具，
				// 比不重执行危险得多。
				const original = _findCall(result.toolCallId);
				const reExecuted = original
					? await host._reExecuteAfterSandbox(
						original, request.agentId, request.worktreePath,
						turnAbortSignal, decision, violation,
					)
					: undefined;
				return { decision, reExecuted };
			}

			// 三条路径共用的收尾依赖。`observe` 归位到此处，保证并行路径与串行路径的
			// 观测口完全一致（原先三处各自拼一次 toolName 反查）。
			const _finalizeDeps: IToolFinalizationDeps<IChatStreamDelta> = {
				isSandboxViolation: r => !r.success && host._isSandboxViolation(r as any),
				resolveSandbox: _resolveSandbox,
				observe: (call, result) => host._observeToolResult(
					request.agentId, { ...result, toolName: call.name }, request.sessionId,
				),
			};

			/** 按 toolCallId 配回原始调用；配不上返回 undefined（不伪造）。 */
			function _findCall(toolCallId: string): IToolCallInfo | undefined {
				return localExecutedCalls.find((c: any) => c.id === toolCallId);
			}

			/**
			 * 供 observe / 后处理使用的调用视图 —— 只需要 `name`。
			 *
			 * 配不回原调用时退化为以 toolCallId 充当名字：与原三条路径的
			 * `?? 'unknown'` / `?? toolResult.toolCallId` 兜底同义。
			 * ⚠ 此兜底**不可**用于沙箱重执行（`arguments` 是空的），见 `_resolveSandbox`。
			 */
			function _callOf(result: { toolCallId: string }): ITurnToolCall {
				return _findCall(result.toolCallId) ?? {
					id: result.toolCallId, name: result.toolCallId, arguments: {},
				};
			}

			// 消息追加、tool_result/tool_end yield。闭包捕获 messages / _toolConsecutiveFailures /
			// _terminalEmptyOutputCount / endedToolIds，返回更新后的 messages。
			function* _processToolResult(toolResult: { toolCallId: string; content: any; success: boolean; metadata?: { executionTimeMs?: number } }, toolName: string): Generator<IChatStreamDelta> {
				// ─── [TagTrace] 切面 3：工具结果扫描 ──────────────────────────
				// 工具输出是 priming 最常见的载体：模型读到文件/日志里含 `<tag:id>`
				// 后会在下一轮模仿。必须先于 success 分支处理 —— 失败结果同样会回灌
				// 给模型，同样是潜在的 priming 源。
				{
					const _trRaw = toolResult.content && typeof toolResult.content === 'string'
						? toolResult.content
						: safeStringifyToolResult(toolResult.content);
					tagTraceScanToolResult(_trRaw, toolName, loopState.iteration, host);
				}
				// ─── 切断跨会话传播：剥离伪标签后再回灌 ──────────────────────
				// 工具结果是这类标签**跨会话扩散的载体**（日志 1788011997897 实证）：
				// SubAgent 的 delegate_task 结果带着 `tool_calls:6124c78e` 回灌主会话后，
				// 会驻留在 `msg[7](role=tool)` 里，此后**每一轮**都随请求重新发给模型
				// （iter=2..7 次次命中 PRIMING suspected），污染持续放大。
				// 故必须在回灌前剥离 —— 放在扫描之后，保证 TagTrace 仍能记录原始情况。
				//
				// ⚠ 2026-09-16 修正（日志 20260916T130827）：剥离**下移到 `rawStr` 构造处**。
				// 原实现在此处只处理 `typeof content === 'string'`，而内建工具（`coreTools.ts`
				// 的 `text()` ⇒ `IToolResultContent[]`）与 MCP 工具返回的都是**内容块数组**
				// ⇒ 该条件恒 false ⇒ 本护栏对**几乎所有工具是空操作**：日志里
				// `<tool_calls:HEXID>` 于 iter=2 被 TagTrace 记下后，iter=3 仍原样出现在
				// `msg[9](role=tool)@1515`，且全日志**无一条** "stripped tagged-id" info。
				// 只在「最终回灌字符串」上剥离，才能同时覆盖字符串与数组两种 content 形态。
				if (!toolResult.success) {
					_toolConsecutiveFailures.set(toolName, (_toolConsecutiveFailures.get(toolName) ?? 0) + 1);
					_auditMark('consecutiveFail', _toolConsecutiveFailures.get(toolName) ?? 0, MAX_CONSECUTIVE_TOOL_FAILURES, toolName);
					if ((_toolConsecutiveFailures.get(toolName) ?? 0) >= MAX_CONSECUTIVE_TOOL_FAILURES) {
						host._logService.warn(
							formatGuardrailFiredLog('consecutiveFail', _toolConsecutiveFailures.get(toolName) ?? 0, MAX_CONSECUTIVE_TOOL_FAILURES, `tool=${toolName}`),
						);
						_auditFired('consecutiveFail', MAX_CONSECUTIVE_TOOL_FAILURES);
						// 延迟注入（见上方 _pendingBatchReminders 声明处的相邻性保护说明）
						_pendingBatchReminders.push(toolConsecutiveFailureReminder(toolName, MAX_CONSECUTIVE_TOOL_FAILURES));
					}
				} else {
					_toolConsecutiveFailures.clear();
					// terminal 空输出连续检测（terminal 返回 (no output) 时 exit code 0 → success=true，
					// 不走失败追踪，需单独检测"连续空输出浪费迭代"模式）。
					if (toolName === 'terminal') {
						const rawText = toolResult.content && typeof toolResult.content === 'string'
							? toolResult.content
							: safeStringifyToolResult(toolResult.content);
						if (rawText === '(no output)' || rawText.trim() === '') {
							loopState.terminalEmptyOutputCount++;
							_auditMark('terminalEmptyOutput', loopState.terminalEmptyOutputCount, MAX_TERMINAL_EMPTY_OUTPUT, 'terminal');
							if (loopState.terminalEmptyOutputCount >= MAX_TERMINAL_EMPTY_OUTPUT) {
								host._logService.warn(
									formatGuardrailFiredLog('terminalEmptyOutput', loopState.terminalEmptyOutputCount, MAX_TERMINAL_EMPTY_OUTPUT, 'terminal returned (no output) consecutively'),
								);
								_auditFired('terminalEmptyOutput', MAX_TERMINAL_EMPTY_OUTPUT);
								// 延迟注入（保证 tool result 序列连续紧邻）
								_pendingBatchReminders.push(terminalEmptyOutputReminder());
							}
						} else {
							loopState.terminalEmptyOutputCount = 0;
						}
					}
					// 文本/文件名搜索连击护栏：
					//  • 结构搜索工具一用即清零（表明已切换到有效路径），并复位软提醒标记。
					//  • 纯文本搜索连击累计。软上限（MAX_TEXT_SEARCH_STREAK）注入一次强引导
					//    （停止搜索 / 改用结构工具 / 直接汇报），**不在此清零**以便硬上限可达。
					//  • 硬上限（MAX_TEXT_SEARCH_STREAK_HARD）连击失控：强制收尾轮
					//    （复用 wrap-up 机制：禁用工具，模型必须基于已收集信息产出结论）。
					if (STRUCTURAL_SEARCH_TOOL_NAMES.has(toolName)) {
						patchGuardrails({ textSearchStreak: 0, textSearchSoftReminderSent: false });
					} else if (TEXT_SEARCH_TOOL_NAMES.has(toolName)) {
						patchGuardrails({ textSearchStreak: guardrails().textSearchStreak + 1 });
						const _textSearchStreak = guardrails().textSearchStreak;
						_auditMark('textSearchStreak', _textSearchStreak, MAX_TEXT_SEARCH_STREAK, toolName);
						if (_textSearchStreak >= MAX_TEXT_SEARCH_STREAK_HARD) {
							// ③ 硬上限：打断纯搜索死循环，强制收尾轮。
							host._logService.warn(
								formatGuardrailFiredLog('textSearchStreak', _textSearchStreak, MAX_TEXT_SEARCH_STREAK_HARD, 'hard cap reached — forcing wrap-up round (stop searching)'),
							);
							_auditFired('textSearchStreak', MAX_TEXT_SEARCH_STREAK_HARD);
							messages = appendMessages(messages, { role: 'system', content: textSearchLoopWrapUpReminder(_textSearchStreak) });
							syncMessages();
							patchWrapUp({ reasonReminderInjected: true, forced: true });
							patchGuardrails({ textSearchStreak: 0 });
						} else if (_textSearchStreak >= MAX_TEXT_SEARCH_STREAK && !guardrails().textSearchSoftReminderSent) {
							// ① 软上限：注入一次强引导。结构工具可用则推结构工具，否则要求直接停搜汇报。
							const _structuralAvailable = enabledTools
								.filter(t => STRUCTURAL_SEARCH_TOOL_NAMES.has(t.name))
								.map(t => t.name);
							host._logService.warn(
								formatGuardrailFiredLog('textSearchStreak', _textSearchStreak, MAX_TEXT_SEARCH_STREAK, `structural tools available: ${_structuralAvailable.join(', ') || '(none)'}`),
							);
							_auditFired('textSearchStreak', MAX_TEXT_SEARCH_STREAK);
							// 延迟注入（本次 400 的直接触发点：并行 4×search_files 时该 reminder
							// 曾插在第 3、4 条 tool result 之间劈开序列）
							_pendingBatchReminders.push(
								_structuralAvailable.length > 0
									? preferGraphSearchReminder(_textSearchStreak, _structuralAvailable.join(', '))
									: stopSearchingReportReminder(_textSearchStreak),
							);
							patchGuardrails({ textSearchSoftReminderSent: true });
						}
					}
				}
				// ── [ToolAudit] 逐次记账（只读已有数据，不新增采集）──────────────
				// 空结果判定与上面 terminal / search 的既有口径一致：文本为空、
				// `(no output)`、或搜索类工具返回「无匹配」提示。
				{
					const _auditText = typeof toolResult.content === 'string'
						? toolResult.content
						: safeStringifyToolResult(toolResult.content);
					const _trimmed = _auditText.trim();
					const _isEmpty = toolResult.success && (
						_trimmed === '' ||
						_trimmed === '(no output)' ||
						_trimmed === '[]' ||
						/^(?:no matches found|found 0 match|no results)/i.test(_trimmed)
					);
					_audit.records.push({
						name: toolName,
						iteration: loopState.iteration,
						ok: toolResult.success,
						ms: toolResult.metadata?.executionTimeMs ?? 0,
						outputBytes: _auditText.length,
						empty: _isEmpty,
						argsKey: _audit.argsKeyById.get(toolResult.toolCallId),
					});
					_audit.iterations = loopState.iteration;
				}
				// ★★ 2026-09-13：工具结果里的**图像项**必须与文本分开处理。
				//
				// 此前它们被 `safeStringifyToolResult` 一起 JSON 化，再按
				// `MAX_TOOL_RESULT_CHARS`(100K) 截断 → **base64 被切断损坏**；而
				// `messageFormatConverter` 的 `role:'tool'` 分支只读字符串（三家皆然），
				// 所以图像**从来没有**以图像形式到达模型（`mcpToolProvider` / `image_generate`
				// 返回的 image 项同样如此 —— 这是个既存缺陷）。
				//
				// 处置：图像项剥离出来，改走下方 `role:'user'` 消息（唯一可移植的位置），
				// 且**门控主模型的 `supportsImages`**（否则 provider 直接 400）。
				// 详见 `common/toolResultImages` 头注释。
				const _imgSplit = splitToolResultImages(toolResult.content);
				const _imgSupported = _imgSplit.images.length > 0 && _turnSupportsImages;
				// [TagTrace] 回灌前剥离 `<tag:id>` 伪标签 —— 这里是**唯一**同时覆盖
				// 「字符串 content」与「内容块数组 content」的位置（见上方修正说明）。
				const _payloadText = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult(_imgSplit.text)));
				const _payloadStripped = stripTaggedIdXmlTags(_payloadText);
				if (_payloadStripped !== _payloadText) {
					host._logService.info(
						`[AgentOS][TagTrace] stripped tagged-id XML from tool result ` +
						`(tool=${toolName}, iter=${loopState.iteration}) before feeding it back to the model`,
					);
				}
				const rawStr = _payloadStripped
					// 不支持图片时，**必须让模型知道「有图但没附上」**（静默削弱是本项目一贯要避免的）
					+ (_imgSplit.images.length > 0 && !_imgSupported
						? toolImageOmittedNote(toolName, _imgSplit.images.length)
						: '');

				// Hermes 护栏 after_call：用本轮结果推进计数并取回决策（warn / halt）。
				// args 经 toolCallId 反查 —— 本函数是闭包，可直接访问 localExecutedCalls；
				// 三个调用点都只拿得到 toolResult + toolName，改签名成本高且易漏改。
				const _guardTc = localExecutedCalls.find((c: any) => c.id === toolResult.toolCallId);
				let _guardArgs: Record<string, unknown> = {};
				if (_guardTc) {
					const _guardRawArgs = typeof _guardTc.arguments === 'string'
						? _guardTc.arguments
						: JSON.stringify(_guardTc.arguments ?? {});
					try { _guardArgs = JSON.parse(_guardRawArgs) as Record<string, unknown>; } catch { _guardArgs = {}; }
				}
				const _after = _toolGuardrail.afterCall(toolName, _guardArgs, rawStr, { failed: !toolResult.success });
				if (_after.action === 'warn' || _after.action === 'halt') {
					host._logService.warn(
						`[AgentOS] Guardrail ${_after.action}: ${_after.code} (tool=${toolName}, count=${_after.count})`,
					);
				}
				// halt = 「退出主循环」的信号（见 toolGuardrailController.ts:19 契约）。
				// 复用既有 wrap-up 收尾机制（同 4198 行 textSearchStreak 的处理）：
				// 置位后本轮禁工具、强制模型基于已收集信息产出结论，避免同工具被无限重试。
				// 此前仅记 warn 日志而不置位，halt 决策形同虚设 —— 这正是
				// same_tool_failure 信号「检出却不生效」的最后一处断点。
				if (_after.action === 'halt') {
					patchWrapUp({ forced: true });
					_auditFired('guardrailHalt', _after.count ?? 0);
				}

				// 回填结果哈希（易失字段已剥离）供 ping-pong 等跨调用检测使用。
				// RECORD_TOOL_CALL 是执行前派发的（那时无结果），故结果只能在此时回填。
				runState = reduceRunState(runState, {
					type: 'RECORD_TOOL_RESULT',
					name: toolName,
					argsHash: canonicalToolArgsHash(_guardArgs),
					resultHash: hashToolResult(rawStr),
				});

				// 顺序：先套失败恢复提示，再套护栏引导 —— 护栏引导放末尾，对模型更醒目。
				const resultStr = appendToolGuardGuidance(
					!toolResult.success ? appendRecoveryHint(rawStr, toolResult.toolCallId) : rawStr,
					_after,
				);
				messages = appendMessages(messages, {
					role: 'tool',
					content: resultStr,
					toolCallId: toolResult.toolCallId,
				});
				syncMessages();
				// 图像另走一条 `role:'user'` 消息（只有该分支读 `contentParts`，
				// 三家 provider 都会转成各自的图像格式）。**只在主模型支持图片时发**，
				// 否则会 400；不支持时上面已用文本说明「有图但没附上」。
				if (_imgSupported) {
					const _imgMsg = buildToolImageMessage(_imgSplit.images, toolName);
					// `appendMessages` 的形参是 `AgentRunMessage`（`common/agentRunState` 的窄化类型），
					// 而 `toolResultImages` 只依赖 `common/providers` 的 `IChatMessage` ——
					// 两者结构兼容，此处显式收窄即可（不把窄化类型反向引入公共模块）。
					if (_imgMsg) { messages = appendMessages(messages, _imgMsg as unknown as AgentRunMessage); }
					syncMessages();
				}
				yield { type: 'tool_result', content: resultStr, toolCallId: toolResult.toolCallId };
				yield { type: 'tool_end', toolCallId: toolResult.toolCallId, success: toolResult.success };
				endedToolIds.add(toolResult.toolCallId);
			}

			// ─── delegate 分区并行（2026-07-28，日志 1785237386145）─────────────────
			// 批次含 ≥2 个 delegate_task 但混有非并行安全工具（如 update_plan）时，整批
			// 回退串行：首个 delegate 的内联子 agent 阻塞、其余 delegate 排队 → 多张
			// delegate 卡片只有首张有内容。这里把非 delegate 工具（update_plan /
			// index_status / read_skill 等）先行串行执行，再把 delegate_task 子集交给
			// 下方并行路径并发执行，使各 delegate 卡片同时呈现其子 agent 进展。
			const _delegateSplit = splitDelegateParallelBatch(localExecutedCalls);
			let _parallelCalls = localExecutedCalls;
			if (!canParallel && _delegateSplit) {
				const _headCalls = _delegateSplit.head;
				const _delegateSubset = _delegateSplit.delegates;
				host._logService.info(`[AgentOS] [parallel] delegate split: ${_headCalls.length} serial + ${_delegateSubset.length} delegate_task parallel`);
				// 先行串行执行非 delegate 工具（复用串行路径的沙箱确认 + 结果后处理逻辑）。
				host._clearSandboxBypassRoots(); // fresh-dispatch 边界：清空上一批次遗留的 AllowOnce 放行根，避免重执行放行泄漏到本批工具调用
				const headSerial = await host._executeToolCalls(_headCalls, request.agentId, request.worktreePath, turnAbortSignal, askRouting, request.sessionId);
				for (const toolResult of headSerial) {
					const outcome = yield* finalizeToolCall(
						{ call: _callOf(toolResult), result: toolResult as unknown as ITurnToolResult },
						_finalizeDeps,
						handledSandboxIds,
					);
					toolResults.push(outcome.result as any);
					yield* _processToolResult(outcome.result as any, outcome.call.name);
				}
				// 剩余 delegate_task 子集交给下方并行路径并发执行。
				_parallelCalls = _delegateSubset;
				canParallel = true;
			}

			if (canParallel) {
						// P0: 并行执行可能被中断（abort/异常），导致部分 tool_end 未发出。
						// 用 try-finally 保证所有 tool_start 都有对应 tool_end，
						// 未完成的 tool 用 success=false 标记（对齐 OpenCode Deferred settle 模式）。
						const _executedToolIds = new Set<string>();
						try {
					host._clearSandboxBypassRoots(); // fresh-dispatch 边界：清空上一批次遗留的 AllowOnce 放行根，避免重执行放行泄漏到本批工具调用
					for await (const toolResult of host._executeToolCallsParallelStreaming(_parallelCalls, request.agentId, request.worktreePath, turnAbortSignal, askRouting, request.sessionId)) {
					_executedToolIds.add(toolResult.toolCallId);
					// 2026-09-17：本路径此前**没有**沙箱确认段 —— 并行批次里的写工具
					// 撞沙箱时用户拿不到确认卡片，工具直接失败；同样的调用走串行路径
					// 却会弹卡片。经 finalizeToolCall 收口后三条路径行为一致。
					const outcome = yield* finalizeToolCall(
						{ call: _callOf(toolResult), result: toolResult as unknown as ITurnToolResult },
						_finalizeDeps,
						handledSandboxIds,
					);
					toolResults.push(outcome.result as any);
							// ── 工具结果后处理（连续失败追踪 + terminal 空输出 + 消息追加 + tool_result/tool_end）──
							yield* _processToolResult(outcome.result as any, outcome.call.name);
						}
						} finally {
							// P0: 无论并行执行是否被中断，确保所有 tool_start 都有对应 tool_end。
							// 未完成的 tool 用 success=false 标记，防止 UI 工具卡片永远转圈。
						for (const tc of _parallelCalls) {
							if (startedToolIds.has(tc.id) && !_executedToolIds.has(tc.id) && !endedToolIds.has(tc.id)) {
								host._logService.warn(`[AgentOS] Parallel tool execution incomplete: ${tc.name}(${tc.id}) — emitting synthetic tool_end (success=false)`);
									yield { type: 'tool_result', content: `工具 "${tc.name}" 执行被中断或超时`, toolCallId: tc.id };
									yield { type: 'tool_end', toolCallId: tc.id, success: false };
									endedToolIds.add(tc.id);
								}
							}
						}
					} else {
						// Serial path: keep old behavior (each tool naturally finishes
						// sequentially so head-of-line blocking is not an issue here).
						host._clearSandboxBypassRoots(); // fresh-dispatch 边界：清空上一批次遗留的 AllowOnce 放行根，避免重执行放行泄漏到本批工具调用
						const serial = await host._executeToolCalls(localExecutedCalls, request.agentId, request.worktreePath, turnAbortSignal, askRouting, request.sessionId);
						for (const toolResult of serial) {
							// ─── 沙箱确认（完整暂停等待）──────────────────────────
							// 工具因安全沙箱限制失败时，暂停 agent loop，向原生 chat
							// 弹出确认卡片，等待用户决策（允许本次 / 允许此工作区 /
							// 改用建议路径 / 取消），再按决策重执行或保留失败。
							// 实现见 `_resolveSandbox` + `finalizeToolCall`（三路径共用）。
							const outcome = yield* finalizeToolCall(
								{ call: _callOf(toolResult), result: toolResult as unknown as ITurnToolResult },
								_finalizeDeps,
								handledSandboxIds,
							);
						toolResults.push(outcome.result as any);
							// ── 工具结果后处理（连续失败追踪 + terminal 空输出 + 消息追加 + tool_result/tool_end）──
							yield* _processToolResult(outcome.result as any, outcome.call.name);
						}
					}
				} catch (execErr) {
					host._logService.error(`[AgentOS] Tool execution batch threw unexpectedly:`, execErr);
					// Synthesize failed results for every tool that did NOT yet emit tool_end.
					// This guarantees every started tool_call is terminated on the wire.
					for (const tc of localExecutedCalls) {
						if (endedToolIds.has(tc.id)) { continue; }
						const errResult = {
							toolCallId: tc.id,
							content: { error: `Tool execution failed: ${execErr instanceof Error ? execErr.message : String(execErr)}` },
							success: false,
						};
						toolResults.push(errResult);
						const resultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult(errResult.content)));
						messages = appendMessages(messages, {
							role: 'tool',
							content: resultStr,
							toolCallId: tc.id,
						});
						syncMessages();
						yield { type: 'tool_result', content: resultStr, toolCallId: tc.id };
						yield { type: 'tool_end', toolCallId: tc.id, success: false };
						endedToolIds.add(tc.id);
					}
				}
				// ── flush 本批延迟的护栏 reminder ────────────────────────────
				// 此时本批所有 tool result（含 catch 兜底合成的失败结果）都已 append，
				// tool 序列已连续紧邻 assistant.tool_calls，可安全追加 user reminder。
				if (_pendingBatchReminders.length > 0) {
					host._logService.debug(
						`[AgentOS][Diag] flushing ${_pendingBatchReminders.length} deferred batch reminder(s) after tool results (adjacency-safe)`,
					);
					for (const _rem of _pendingBatchReminders) {
						messages = appendMessages(messages, { role: 'user', content: _rem });
						syncMessages();
					}
					_pendingBatchReminders.length = 0;
				}
			} // end if (localExecutedCalls.length > 0)
			const planResult = yield* _handlePlanModeTools(effectiveToolCalls, toolResults, endedToolIds);
			if (planResult === 'done') { return undefined; }
			const postResult = yield* _postIterationCleanup(toolResults, localExecutedCalls, effectiveToolCalls, startedToolIds, endedToolIds, trimmedAssistantContent, memoryProvider, loopState.iteration);
			if (postResult === 'done') { break; }
		} // end while

		// ─── 每轮 turn 结束：把本轮新增对话增量外置到记忆 ──────────────────
		// 实现已迁出至 parts/turnFinalization.ts（fire-and-forget，绝不阻塞收尾）。
		storeTurnObservationsAtEnd({
			retrievalCompactionEnabled: RETRIEVAL_COMPACTION_ENABLED,
			getActiveMemoryProvider: () => host.getActiveMemoryProvider(),
			storeTurnObservations: (provider, agentId, sessionId, msgs) =>
				host._storeTurnObservations(provider as any, agentId, sessionId, msgs as any[]),
			agentId: request.agentId,
			sessionId: request.sessionId,
			messages,
		});

		if (loopState.iteration >= maxToolIterations) {
			host._logService.warn(
				`[AgentOS] Reached max tool iterations (${maxToolIterations})` +
				`${wrapUp().done ? ' — final wrap-up round was executed (model had a tool-free round to conclude)' : ' — WITHOUT a wrap-up round (aborted or errored out early)'}`
			);
			yield { type: 'done' };
		}
	} finally {
	// ★ 2026-09-21：`_unregisterPlanQueue()` 调用随 planQueueRegistry 一并删除（见上方注册块注释）。

		// 注销本 turn 注册的钩子 handler。放在 finally 的姿态与原先的计划队列句柄一致
		// （★ 2026-09-21：该句柄已随 `planQueueRegistry` 下线 —— 见上方注册块的删除说明）。
		// 闭包持有 memoryProvider 引用，abort / 异常路径下显式解绑更可预期。
		disposeMemoryHooks();

		// ── [ToolAudit] SUMMARY（2026-08-22）──────────────────────────────────
		// 放在 finally：**必须覆盖 abort / 异常 / generator return 全部退出路径** ——
		// 「工具用得不合理」的 turn 恰恰最常以中断收尾（撞硬超时、用户取消），
		// 只在正常结束处打就会漏掉最该看的那些。
		// 实现（含探索/只读判据的实证注释）已迁出至 parts/turnFinalization.ts。
		logToolAuditSummary({
			audit: _audit,
			logService: host._logService,
			turnId: request.sessionId,
		});
	}
		// 显式 return undefined：generator TReturn = AgentCommand | undefined，
		// 覆盖函数末尾自然结束路径（对齐 TS7030 要求所有路径返回值）。
		return undefined;
	}

