import {
	IModelProvider, IModelSelection, IModelOptions,
	IMemoryProvider,
	IAgentTurnRequest, IChatStreamDelta,
	IToolDefinition, IToolCallInfo,
	ISandboxViolationInfo,
} from '../common/providers.js';
import { withStreamTimeout, computeAdaptiveFirstTokenTimeout } from '../common/resilience.js';
import { buildBuildSwitchReminder } from '../common/chatModeConfig.js';
import { isToolCallDeniedByHardPermission } from '../common/toolPermission.js';
import { generatePlanPath, isPlanFilePath } from '../common/planFile.js';
import {
	createInitialWorkState,
	parsePlanDocument,
	planExitRequiresApproval,
	reduceWorkState,
	type ParsedPlanTask,
} from '../common/workMode.js';
import {
	appendMessages,
	insertMessages,
	compactMessages,
	stripSyntheticSidecars,
	createInitialRunState,
	reduceRunState,
	snapshotRunState,
	detectToolCallLoop,
	classifyIncompleteTurn,
	resolveIncompleteTurnRetryInstruction,
	incompleteTurnDiscardReason,
	incompleteTurnRetryLimit,
	isTransientStreamError,
	TRANSIENT_ERROR_MAX_RETRIES,
	TRANSIENT_ERROR_BASE_DELAY_MS,
	TRANSIENT_ERROR_BACKOFF_FACTOR,
	TRANSIENT_ERROR_MAX_DELAY_MS,
	type AgentRunMessage,
	type AgentRunState,
} from '../common/agentRunState.js';
import {
	AgentCommand,
	TRANSFER_TO_AGENT_TOOL,
	buildHandoffCommand,
	applyCommandToState,
} from '../common/agentGraph.js';
import { buildForkContext, prefixCacheAligned } from '../common/forkContext.js';
import { deriveAskRoutingContext } from '../common/askRouting.js';
import { isBridgeTool } from '../common/toolsetConfig.js';
import {
	formatCurrentTaskReminder,
	formatExplorationFindings,
} from '../common/preLoopOrchestrator.js';
import { registerPlanQueueHandle } from '../common/planQueueRegistry.js';
import { getParadigmOverride, setParadigmOverride } from '../common/paradigmOverride.js';
import {
	toolConsecutiveFailureReminder,
	terminalEmptyOutputReminder,
	textWithoutToolsReminder,
	softBudgetWrapUpReminder,
	preferGraphSearchReminder,
} from '../common/loopReminders.js';
import {
	STRUCTURAL_SEARCH_TOOL_NAMES,
	TEXT_SEARCH_TOOL_NAMES,
} from '../common/searchToolGroups.js';

import {
	deduplicateToolCalls,
	limitToolResultSize,
	safeStringifyToolResult,
	shouldParallelizeToolBatch,
	splitDelegateParallelBatch,
	StreamingToolCallAssembler,
	PHANTOM_TOOL_NAMES,
	repairToolName,
	MAX_INVALID_TOOL_RETRIES,
	MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES,
} from './toolCallUtils.js';
import {
	sanitizeAssistantVisibleText,
	sanitizeToolResultText,
	isEntirelyToolCallContent,
} from '../common/assistantVisibleText.js';
import { buildDurableContextSystemMessage } from '../common/durableContextMiddleware.js';
import { AGUIChatMessageBuilder } from '../common/adapters/aguiAdapter.js';
import { ContextManager, RETRIEVAL_COMPACTION_ENABLED, RETRIEVAL_BUDGET_RATIO } from '../common/contextManager.js';
import { injectMemoryContext, isMemoryInjectionEnabled } from './agentMemoryInjection.js';
import type { ChatMessage } from '../common/types.js';
import { IterationBudget } from '../common/iterationBudget.js';
import { AgentLoopStrategyFactory } from './agentLoopStrategyFactory.js';
import type { PreLoopContext, AgentParadigm } from '../common/agentLoopStrategy.js';

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

	/** 工具失败恢复提示（借鉴 Hermes-Agent _tool_failure_recovery_hint）。 */
	function getToolFailureRecoveryHint(host: any, toolName: string): string | null {
		const hints: Record<string, string> = {
			terminal: 'For terminal failures, try a diagnostic command first (e.g., `pwd && ls`), ' +
				'then use an absolute path, a simpler command, or a different tool such as file_read/patch.',
			search_files: 'Search returned no results. Try a narrower directory, a simpler pattern, ' +
				'or use search_graph / query_graph to explore code by structure instead of by text.',
			file_read: 'File read failed. Check the path exists with file_list, or try search_graph ' +
				'to locate the file by its function/class names.',
			file_write: 'File write failed. Verify the parent directory exists, check write permissions, ' +
				'or try patch for targeted edits instead of full rewrites.',
			patch: 'Patch failed. The search text may not match exactly — try reading the file first ' +
				'to verify the current content, then use a smaller or more unique search string.',
			file_list: 'Directory listing failed. Check the path exists with `pwd` or an absolute path.',
			index_repository: 'Indexing failed. The workspace may already have a graph loaded — ' +
				'check index_status first, or try a different mode (fast/moderate/full).',
			search_graph: 'Graph search returned no results. Try a wider name pattern, a different label filter, ' +
				'or check index_status to verify the graph is loaded.',
		};
		return hints[toolName] ?? null;
	}

	/**
	 * 轻量/会话型请求快速判定：用于阻止对明显非任务消息（"test1"、问候、纯确认）
	 * 触发代码库深度探索与图谱构建。仅匹配明确的问候/测试/确认短语，并额外排除含
	 * 代码/任务信号的消息，避免误伤真实任务。
	 */
	const TRIVIAL_BLOCKED_TOOLS = [
		'search_graph', 'query_graph', 'search_code', 'get_architecture',
		'trace_path', 'get_code_snippet', 'index_repository',
		'search_files', 'read_skill', 'list_skills',
		'delegate_task', 'transfer_to_agent', 'plan_explore',
	];

	function _extractUserText(request: any): string {
		const msgs = request?.messages || [];
		const userMsgs = msgs.filter((m: any) => m?.role === 'user');
		const last = userMsgs[userMsgs.length - 1];
		if (!last) { return ''; }
		return typeof last.content === 'string' ? last.content : '';
	}

	function _isTrivialRequest(raw: string): boolean {
		if (!raw) { return true; }
		// 去掉可能的 agent 选择前缀（如 "gr test1" → "test1"）
		let text = raw.trim();
		const stripped = text.replace(/^[A-Za-z0-9_\-]+\s+/, '');
		if (stripped.length > 0 && stripped.length < text.length) {
			text = stripped;
		}
		if (text.length === 0 || text.length > 40) { return false; }
		const trivialPatterns = [
			/^test\d*$/i,
			/^测试\d*$/i,
			/^(hi|hello|hey|yo|hiya)\b/i,
			/^(你好|您好|在吗|在不在|有人吗)\b/,
			/^(ok|okay|好的|收到|明白|了解|谢谢|thanks|thank you|thx)\b/i,
			/^(t|t1|t2|t3)\b/i,
		];
		if (!trivialPatterns.some(p => p.test(text))) { return false; }
		// 含代码/任务信号 → 不是 trivial
		const codeSignals = /\b(gc|bug|fix|impl|implement|optim|优化|修复|实现|分析|analyze|refactor|函数|function|class|模块|module|代码|code|文件|file|读|read|写|write|查|search|搜索|图谱|graph|原理|怎么|如何|why|how|deploy|构建|build|运行|run|创建|create|添加|add|更新|update|删除|delete|生成|generate|配置|config|初始化|init|安装|install|设置|set|启动|start|停止|stop|显示|show|列出|list|获取|get)\b/i;
		if (codeSignals.test(text)) { return false; }
		// 含路径/扩展名 → 不是 trivial
		if (/[\\/]|\.\w{1,6}\b/.test(text)) { return false; }
		return true;
	}

	/**
	 * Turn setup — model provider check, tool collection, message init, memory injection.
	 * Yields memory_injected deltas. Returns undefined to signal early exit.
	 */
	async function* initTurnContext(host: any, request: IAgentTurnRequest): AsyncGenerator<IChatStreamDelta, ITurnContext | undefined> {
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
		let effectiveSystemPrompt = request.systemPrompt;
		if (effectiveSystemPrompt) {
			const modelId = (selection?.modelId ?? '').toLowerCase();
			const needsEnforcement = host.constructor.TOOL_USE_ENFORCEMENT_MODELS.some((m: string) => modelId.includes(m));
			if (needsEnforcement && !effectiveSystemPrompt.includes('TOOL_USE_ENFORCEMENT')) {
				effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${host.constructor.TOOL_USE_ENFORCEMENT_GUIDANCE}`;
				host._logService.info(`[AgentOS] Appended tool-use enforcement guidance for model ${selection.modelId}`);
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
		messages = [
			{ role: 'system', content: effectiveSystemPrompt },
			...request.messages,
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
		}, request, messages);
		messages = memResult.messages;

		// ─── Inject Durable Context（借鉴 deer-flow DurableContextMiddleware）────
		// Durable context survives summarization compression and keeps the LLM
		// aware of prior sub-agent delegations, active goals, and critical skill
		// context even when older messages have been dropped.
		const durableCtxMsg = buildDurableContextSystemMessage(host._durableContext);
		if (durableCtxMsg) {
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
					const enriched = await host._userMessageEnricher.enrich(
						messages[lastUserIdx].content as string,
						{ request, agent: host._currentAgent },
					);
					messages = messages.slice(); // shallow copy 后修改，避免污染 request.messages 引用
					const enrichedMsg = { ...messages[lastUserIdx], content: enriched };
					if (lastUserIdx === messages.length - 1) {
						messages = [...messages.slice(0, lastUserIdx), enrichedMsg];
					} else {
						messages = [...messages.slice(0, lastUserIdx), enrichedMsg, ...messages.slice(lastUserIdx + 1)];
					}
					const origLen = (messages[lastUserIdx].content as string).length;
					host._logService.info(
						`[AgentOS] Enriched user message with XML tags (${enriched.length - origLen} chars added)`,
					);
				} catch (err) {
					host._logService.warn(`[AgentOS] User message enrichment failed: ${err}`);
				}
			}
		}

	return { modelProvider, selection, enabledTools, messages, memoryProvider, effectiveSystemPrompt };
}


	export async function* executeAgentTurnDirect(host: any, request: IAgentTurnRequest): AsyncGenerator<IChatStreamDelta, AgentCommand | undefined> {
		// chatOnly 开关：开启时禁用写文件工具，React 范式下额外禁用 delegate_task
		const chatOnly = !!request.chatOnly;
		// 诊断：软预算收尾提醒是否送达（日志 1785325929739 子代理 404s 超时未触发）
		if (request.subAgent?.background) {
			host._logService.info(
				`[AgentOS] executeAgentTurnDirect(subAgent): agentId=${request.agentId} ` +
				`softDeadlineMs=${request.softDeadlineMs ?? 'unset'} ` +
				`timeout(budget)=${request.softDeadlineMs ? Math.round(request.softDeadlineMs / 1000) + 's' : 'none'}`,
			);
		}
		let workState = createInitialWorkState(request.workMode);

		// Plan state is mirrored into AgentRunState for checkpoint compatibility.
		let planFilePath: string | undefined = workState.planFilePath;
		let planEnterCalled = false;
		let planExitCalled = false;

	const ctx = yield* initTurnContext(host, request);
	if (!ctx) { return undefined; }
	const { modelProvider, selection, memoryProvider } = ctx;
	// 实际发送的冻结前缀（含 model 相关 enforcement）——fork 指纹与 modelOptions 统一基于本值
	const effectiveSystemPrompt = ctx.effectiveSystemPrompt;
	let enabledTools = ctx.enabledTools;
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
		const trivialRequest = _isTrivialRequest(_extractUserText(request));
		if (trivialRequest) {
			host._logService.info('[AgentOS] trivial request detected — will restrict exploration tools');
		}
		let messages = ctx.messages;

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
	const MAX_TOOL_ITERATIONS = request.subAgent?.background
		? 1000
		: host.constructor.MAX_TOOL_ITERATIONS;
	// ─── AgentLoop 策略 + 预算门控（默认 Hermes-ReAct 范式）──
	// 策略实例 per-turn 创建（resolve 每次 new），保证多聊天框/多 session 预算与状态隔离。
	// 范式解析链：运行时覆盖（switch_paradigm 工具写入，turn 边界生效）> request.paradigm（Agent 配置）
	if (!host._strategyFactory) { host._strategyFactory = new AgentLoopStrategyFactory(); }
	// ─── V3: resume 时从 checkpoint 重建范式覆盖（R3：避免范式漂移）──
	// 新进程/新会话下 paradigmOverride 内存注册表为空，需从落盘 checkpoint.paradigm
	// 回填，使 resume 复用中断前完全一致的范式，而非回退到 agent 配置/默认。
	if (request.resumeFrom?.paradigm && !getParadigmOverride(request.agentId)) {
		setParadigmOverride(request.agentId, request.resumeFrom.paradigm);
		host._logService.info(`[AgentOS] Resume: restored paradigm override (${request.resumeFrom.paradigm})`);
	}
	const paradigmOverride = getParadigmOverride(request.agentId);
	const resolvedParadigm = (paradigmOverride ?? request.paradigm) as AgentParadigm;
	const strategy = host._strategyFactory.resolve(
		request,
		resolvedParadigm,
	);
	if (paradigmOverride && paradigmOverride !== request.paradigm) {
		host._logService.info(`[AgentOS] Paradigm override active: ${paradigmOverride} (config: ${String(request.paradigm ?? 'unset')})`);
	}
		const budgetMaxTotal = request.budgetMaxTotal ?? (host.constructor.DEFAULT_BUDGET_MAX ?? 90);
		let budget = new IterationBudget(budgetMaxTotal);
		let iteration = 0;

	// ─── 编排前置层：策略 preLoop（LLM 决策 explore → 并行探索 → 计划队列）──
	// 由 AgentLoop 策略的 preLoop 钩子接管，范式差异由策略实现（budgeted-react=LLM 决策+并行探索，
	// plan-explore=plan_enter 等）。主循环只负责接收计划队列与探索结果并注入 messages。
	let planTasks: ParsedPlanTask[] = [];
	let currentTaskIdx = 0;

	// ─── 计划队列工具注册（方案1：plan_register → 本 turn 执行队列）────────
	// LLM 在调研后调用 plan_register 把有序任务列表写入本队列（闭包直接改写
	// planTasks/currentTaskIdx）；主循环现有的"无工具调用轮推进 + 每轮注入
	// CURRENT TASK 提醒"逻辑驱动依次执行。try/finally 保证句柄在 turn 结束
	// （正常/异常/中断 return）时注销，不泄漏到下一个 turn。
	const _unregisterPlanQueue = registerPlanQueueHandle(request.agentId, {
		setPlan: (tasks) => {
			planTasks = tasks.map(t => ({ ...t }));
			currentTaskIdx = 0;
			host._logService.info(`[AgentOS] plan_register: ${planTasks.length} tasks enqueued for sequential execution`);
		},
		getPlan: () => ({ tasks: planTasks, currentIndex: currentTaskIdx }),
	});

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
	if (restored?.loopMessages && restored.loopMessages.length > 0) {
		messages = [...restored.loopMessages];
		host._logService.info(`[AgentOS] Resume: restored ${messages.length} loop messages`);
	}
	if (typeof restored?.iteration === 'number' && restored.iteration > 0) {
		iteration = restored.iteration;
		host._logService.info(`[AgentOS] Resume: restored iteration=${iteration}`);
	}
	if (restored?.preExploreDone) {
		resumePreExploreDone = true;
		resumePreExploreResult = restored.preExploreResult;
		host._logService.info('[AgentOS] Resume: preExplore already done, will skip preLoop');
	}

	// ⚠️ 仅顶层 turn 触发（subagent 的 agentId 以 'subagent-' 开头），避免递归触发 preLoop → 又派 subagent → 爆炸
	if (resumePreExploreDone) {
		// 已完成的 preExplore：等待 runState 初始化后再回填
		// （runState 在下方约 80 行后声明，此处只标记）
	} else if (strategy.preLoop && !request.agentId.startsWith('subagent-')) {
		try {
			const loopCtx: PreLoopContext = {
				host, request, chatMode: chatOnly ? 'chatOnly' : '', modelProvider,
				modelId: selection?.modelId ?? '', selection,
				messages, signal: turnAbortSignal, budget, workState,
				toolDefs: enabledTools, iteration: 0,
			};
			const meta = yield* strategy.preLoop(loopCtx);
			if (meta) {
				planTasks = meta.planTasks ?? [];
				if (meta.findings) {
					messages.push({ role: 'system', content: formatExplorationFindings(meta.findings) });
				}
				if (planTasks.length > 0) {
					host._logService.info(`[AgentOS] Strategy preLoop: ${planTasks.length} tasks planned`);
					messages.push({ role: 'system', content: formatCurrentTaskReminder(planTasks[0], 0, planTasks.length) });
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
		// 声明为 loop 局部：单次 turn 内跨 iteration 累计，达到上限即放弃续跑。
		// 不进 runState（与 iteration 同为 graph runtime 局部量），但受次数上限保护，
		// 不会形成无限循环。
		let reasoningOnlyRetryAttempts = 0;
		let emptyResponseRetryAttempts = 0;
		let lengthTruncatedRetryAttempts = 0;
		// 维度 3：瞬态错误（SSE 超时/网络/429/5xx）重试计数器，单次 turn 内累计
		let transientErrorRetries = 0;
		// 本轮 provider 结束原因（finish_reason / stop_reason），每轮迭代重置。
		let lastFinishReason: string | undefined;

		// ─── 工具失败连续计数（对齐 Hermes-Agent `_tool_failure_recovery_hint` 的增强版）──
		// 追踪同一工具的连续失败次数。达到阈值时注入 <system-reminder> 引导 LLM
		// 仔细阅读错误消息并换策略，避免盲目重试消耗迭代（详见日志：skill_create 名称缺失×3）。
		// 按工具名分组；任意工具成功后或调用 change 时全局清零。
		const _toolConsecutiveFailures = new Map<string, number>();
		const MAX_CONSECUTIVE_TOOL_FAILURES = host.constructor.MAX_CONSECUTIVE_TOOL_FAILURES;

		// ─── terminal 连续空输出计数（(no output) 不是工具错误，不会进入 _toolConsecutiveFailures）──
		let _terminalEmptyOutputCount = 0;
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
		let _softBudgetNextReminderAtMs = 0;
		// 软预算提醒重复注入周期（ms）——避免每轮刷屏，只在超预算后周期性重提。
		const SOFT_BUDGET_REMINDER_REFIRE_MS = 60_000;

		// ─── 文本搜索连击（search_graph 引导，数据驱动分组见 searchToolGroups）──
		// 连续使用 search_files（grep 类）成功而未触及结构搜索工具时注入一次
		// 引导；结构工具一用即清零，注入后也清零避免每轮刷屏。
		let _textSearchStreak = 0;
		const MAX_TEXT_SEARCH_STREAK = host.constructor.MAX_TEXT_SEARCH_STREAK;

		// ─── AgentRunState（reducer 化 Step 3）────────────────────────────────
		// 跨 iteration 的业务状态（非法工具名计数 / 续跑计数 / 反思计数 / 文件修改标记 /
		// 强制 tool_choice 标志 / 工具调用历史 等）统一收口进不可变 reducer，
		// 取代原先散落的 `let` 控制变量。messages 仍由 loop 局部 `let messages` 管理
		// （Step 2 已收口写入），将在 Step 5 并入此 state 做 snapshot。
		// iteration 作为 while 循环步进计数器保留为 loop 局部（对齐 LangGraph：
		// step 计数属 graph runtime，不进 state schema）。
		// 真实 prompt token 按 agentId::sessionId 双键隔离，避免同 agent 多 session
		// 并行时压缩触发估算互相污染。
		let runState: AgentRunState = createInitialRunState({
			lastRealPromptTokens: host._lastRealPromptTokensByAgent.get(host._turnKey(request.agentId, request.sessionId)) ?? 0,
			workState,
		});

		// ─── V3: 回填 resume preExplore / 本轮 preExplore 状态到 runState ──
		if (resumePreExploreDone) {
			runState = reduceRunState(runState, { type: 'SET_PRE_EXPLORE', done: true, result: resumePreExploreResult });
			if (resumePreExploreResult) {
				messages.push({ role: 'system', content: formatExplorationFindings(resumePreExploreResult) });
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
		const MAX_REFLECT_ITERATIONS = host.constructor.MAX_REFLECT_ITERATIONS;
		// 文件修改类工具名集合 — 仅在这些工具被使用后才触发反思
		const FILE_MODIFICATION_TOOLS = host.constructor.FILE_MODIFICATION_TOOLS;

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
				}
			}
		}

		// 策略可覆盖的「本轮工具面」：delegation 范式会把主循环限制为
		// supervisor 工具（delegate_task / new_agent / plan…），所有执行工具交由
		// sub-agent。该覆盖在每轮「重新收集工具」之后再次应用，避免被全量列表冲掉。
		let _iterationToolDefs: any[] | undefined;

		// P1: 上一轮 LLM 响应回传的真实 prompt token（provider usage，含 cache）。
		// compressContext 优先用它判定，取代低估的 char/4 粗估。首轮=0 自动退回粗估。
		// 上一轮真实 prompt token 由 runState.lastRealPromptTokens 承载（初始值取自实例字段，
		// 跨 turn 持久化，不再每轮归零）。

	// ─── 上下文压缩闭包（2026-07-27 自主循环提取，~360 行）──────────────────
	// 每轮迭代开头执行：廉价剪枝 → 工具结果去重 → 消息数硬上限 → Hermes 三段式压缩。
	// 闭包捕获 messages/runState/host/compressionWindow/contextManager/turnAbortSignal，
	// 通过 yield 发出 phase_change / context_compacted delta。
	async function* _compressContextIfNeeded(): AsyncGenerator<IChatStreamDelta> {
		// P3: 廉价逐轮剪枝（无 LLM、不丢消息）—— 仅对最近 CHEAP_PRUNE_RECENT_KEEP 条之外的
		// 旧 tool 输出做处理。对齐 MiMo prune.ts：累积预算保护(PRUNE_PROTECT=40K) +
		// 受保护工具白名单(skill/memory/...) + 压力>=2 时硬清除(占位符)而非仅截断。
		// P1(cache-cold 门控，对齐 MiMo isCacheCold)：低/中压力(<2)时若距上次
		// assistant 响应 < PRUNE_CACHE_TTL_MS（KV 缓存仍热），跳过剪枝——改写历史
		// 前缀会使已付费的 prompt cache 失效；高压(>=2)防溢出优先，强制剪枝。
		{
			const _estTok = host._estimateMessagesTokens(messages);
			const _pressure = ContextManager.getPressureLevel(
				runState.lastRealPromptTokens || _estTok, compressionWindow);
			const _lastAssistantAt = host._lastAssistantAtByAgent.get(host._turnKey(request.agentId, request.sessionId)) ?? 0;
			const _cacheCold = _lastAssistantAt === 0
				|| (Date.now() - _lastAssistantAt) > ContextManager.PRUNE_CACHE_TTL_MS;
			if (_pressure >= 2 || _cacheCold) {
				messages = ContextManager.pruneOldToolOutputs(
					messages as unknown as ReadonlyArray<ChatMessage>,
					ContextManager.CHEAP_PRUNE_RECENT_KEEP,
					_pressure
				) as unknown as typeof messages;
			}
		}

		// ── P4: 工具结果去重（Layer 4 修复）──────────────────────
		// ReAct 循环中同一文件/搜索常被多轮重复读取，相同 tool 结果
		// 在对话历史中反复出现。此处对连续的相同 tool 结果做去重：
		// 保留最近一次，更早的替换为简短引用标记。
		{
			const MAX_TOOL_RESULT_SNIPPET = 200;
			let dedupCount = 0;
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (msg?.role !== 'tool' || !msg.toolCallId) continue;
				const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
				if (!content || content.length < 50) continue; // 太短不值得去重
				// 向前查找相同内容的更早 tool 结果（同一 toolCallId 不重复）
				for (let j = i - 1; j >= 0; j--) {
					const prev = messages[j];
					if (prev?.role !== 'tool' || !prev.toolCallId) continue;
					if (prev.toolCallId === msg.toolCallId) continue;
					const prevContent = typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content);
					if (prevContent === content) {
						// 找到相同结果：替换更早的为引用标记
						const snippet = content.substring(0, MAX_TOOL_RESULT_SNIPPET);
						messages[j] = {
							...prev,
							content: `[Same tool result as call ${msg.toolCallId} — content identical, deduplicated. Preview: ${snippet}...]`,
						};
						dedupCount++;
						break; // 只替换最近一个重复
					}
				}
			}
			if (dedupCount > 0) {
				host._logService.info(`[AgentOS][Dedup] Replaced ${dedupCount} duplicate tool results with references`);
			}
		}

		// ── P5: 历史消息数量硬上限（Layer 3 修复）────────────────
		// 即使 token 压缩未触发，消息数过多也会导致 context 膨胀。
		// 保留 system 消息 + 最近 N 条消息，其余折叠为占位摘要。
		{
			// 先剥离 synthetic sidecar（技能/策略/控制流临时注入），避免其占用硬上限名额
			// 或污染持久化 transcript（对齐 Hermes api_content / MiMo synthetic:true）。
			messages = stripSyntheticSidecars(messages);
			const HARD_MAX_MESSAGES = 60;
			const beforePruneCount = messages.length;
			if (beforePruneCount > HARD_MAX_MESSAGES) {
				const systemMsgs = messages.filter((m: any) => m.role === 'system');
				const nonSystem = messages.filter((m: any) => m.role !== 'system');
				const keepCount = HARD_MAX_MESSAGES - systemMsgs.length;
				if (nonSystem.length > keepCount && keepCount > 0) {
					const dropped = nonSystem.slice(0, nonSystem.length - keepCount);
					const kept = nonSystem.slice(nonSystem.length - keepCount);
					const placeholder: any = {
						role: 'system',
						content: `[Context truncated: ${dropped.length} earlier messages removed to fit context window. ` +
							`The conversation contained ${dropped.filter((m: any) => m.role === 'user').length} user messages, ` +
							`${dropped.filter((m: any) => m.role === 'assistant').length} assistant responses, ` +
							`${dropped.filter((m: any) => m.role === 'tool').length} tool results.]`,
					};
					messages = [...systemMsgs, placeholder, ...kept] as typeof messages;
					host._logService.warn(
						`[AgentOS][HardPrune] messages ${beforePruneCount} → ${messages.length} ` +
						`(dropped ${dropped.length} oldest, hard cap=${HARD_MAX_MESSAGES})`
					);
				}
			}
		}

		// ─── Hermes 三段式压缩（LLM 摘要 + checkpoint 重建兜底）──────────
		{
			const compressionStartTime = Date.now();
			const originalMessageCount = messages.length;
			const originalEstimatedTokens = host._estimateMessagesTokens(messages);
			host._logService.info(
				`[AgentOS][Compression] BEFORE: messages=${originalMessageCount}, ` +
				`estimatedTokens=${originalEstimatedTokens}, compressionWindow=${compressionWindow}, ` +
				`lastRealPromptTokens=${runState.lastRealPromptTokens}`
			);

			// 跨消息冷却期检查（ContextManager 每次新建，冷却期需在 AgentOSService 层持久化）
			let compressionResult;
			const cooldownElapsed = host._lastCompressionTime > 0
				? Date.now() - host._lastCompressionTime
				: Infinity;
			if (cooldownElapsed < host.constructor.COMPRESSION_COOLDOWN_MS) {
				host._logService.info(
					`[AgentOS][Compression] COOLDOWN: ${Math.round((host.constructor.COMPRESSION_COOLDOWN_MS - cooldownElapsed) / 1000)}s remaining, skipping`
				);
				compressionResult = {
					originalMessageCount: messages.length,
					compressedMessageCount: messages.length,
					summary: '',
					compressedMessages: [...messages] as unknown as ChatMessage[],
					metadata: { compressionRatio: 1.0, skipped: 'cooldown' },
				};
			} else {
				try {
					// Pre-compact injection callback — passed into compressContext
					// so injected memories are part of the compressed result.
					const memProviderForInject = host.getActiveMemoryProvider();
					const preCompactInject = memProviderForInject?.onPreCompact
						? (ctx: { agentId: string; sessionId: string; messages: Array<{ role: string; content: string; timestamp: number }>; tokensSaved: number; contextWindow: number }) => {
							const injectBudget = Math.min(
								Math.max(Math.floor(ctx.tokensSaved * 0.1), 500),
								Math.floor(ctx.contextWindow * 0.05),
								2000,
							);
							return memProviderForInject.onPreCompact!(ctx.agentId, ctx.sessionId, ctx.messages, injectBudget);
						}
						: undefined;
					// 检索式上下文回调（对齐 agentmemory mem::context）：从记忆系统
					// 取回相关上下文替代同步 LLM 摘要。仅在 AgentMemory 可用时提供，
					// 否则 compressContext 回退到原有 LLM 摘要路径（零行为变更）。
					const memProviderForRetrieve = memProviderForInject;
					const retrieveContext = (memProviderForRetrieve && (memProviderForRetrieve as any).recallFormatted)
						? (r: any) => host._retrieveCompactionContext(memProviderForRetrieve as any, r)
						: undefined;
					compressionResult = await contextManager.compressContext(
						messages as unknown as ReadonlyArray<ChatMessage>,
						undefined,
						compressionWindow,
						runState.lastRealPromptTokens,
						preCompactInject as any,
						retrieveContext as any
					);
				} catch (compressionError) {
					host._logService.error(
						`[AgentOS][Compression] EXCEPTION during compressContext: ` +
						`${compressionError instanceof Error ? compressionError.message : String(compressionError)}`,
						compressionError
					);
					compressionResult = {
						originalMessageCount: messages.length,
						compressedMessageCount: messages.length,
						summary: '',
						compressedMessages: [...messages] as unknown as ChatMessage[],
						metadata: { compressionRatio: 1.0, skipped: 'exception', error: String(compressionError) },
					};
				}
			}
			const didCompress = compressionResult.compressedMessageCount < compressionResult.originalMessageCount;
			const compressionDurationMs = Date.now() - compressionStartTime;
			const cmpMeta = compressionResult.metadata ?? {};
			const logFn = didCompress
				? host._logService.info.bind(host._logService)
				: host._logService.warn.bind(host._logService);
			logFn(
				`[AgentOS][Compression] didCompress=${didCompress} ` +
				`skipped=${JSON.stringify(cmpMeta.skipped ?? null)} ` +
				`tokenSource=${cmpMeta.tokenSource ?? 'n/a'} ` +
				`effectiveTokens=${cmpMeta.effectiveTokens ?? 'n/a'} ` +
				`realPromptTokens=${cmpMeta.realPromptTokens ?? 'n/a'} ` +
				`estimatedTokens=${cmpMeta.estimatedTokens ?? 'n/a'} ` +
				`thresholdTokens=${cmpMeta.thresholdTokens ?? 'n/a'} ` +
				`effectiveWindow=${cmpMeta.effectiveWindow ?? 'n/a'} ` +
				`compressionWindow=${compressionWindow} ` +
				`messageCount=${cmpMeta.messageCount ?? messages.length} ` +
				`minMessagesToCompress=${cmpMeta.minMessagesToCompress ?? 'n/a'} ` +
				`ineffectiveCompressionCount=${cmpMeta.ineffectiveCompressionCount ?? 'n/a'} ` +
				`compressionThreshold=${cmpMeta.compressionThreshold ?? 'n/a'}`
			);
			// ─── Dashboard 统计：压缩指标累积 ──
			if (didCompress) {
				host._compressionCount++;
				const before = (cmpMeta.estimatedTokens as number) ?? 0;
				const after = (cmpMeta.estimatedTokensAfter as number) ?? 0;
				const savingRatio = before > 0 ? (before - after) / before : 0;
				if (savingRatio < 0.1) {
					host._compressionIneffectiveCount++;
				}
				host._compressionBeforeTokens += before;
				host._compressionAfterTokens += after;
				host._scheduleSave();
			}
			if (didCompress) {
				host._lastCompressionTime = Date.now();
				// 显式置 phase 后再广播，确保 loop 内部 phase 与 UI 同源（设计 §3.4）
				runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'compressing' });
				yield { type: 'phase_change', phase: runState.phase };
				// 捕获压缩前后文本（用于详情编辑器对比显示）
				// 消息级别截断：只在消息边界截断，避免在消息块中间切断导致公共后缀匹配失败
				const fmtBlock = (m: any) => `[${m.role ?? 'unknown'}] ${(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).slice(0, 300)}`;
				const MAX_TEXT_LEN = 50000;
				// afterText：压缩后消息数少，直接顺序拼接即可
				const fmtListSequential = (msgs: any[]): string => {
					const blocks: string[] = [];
					let totalLen = 0;
					for (const m of msgs) {
						const block = fmtBlock(m);
						if (totalLen + block.length + 2 > MAX_TEXT_LEN && blocks.length > 0) { break; }
						blocks.push(block);
						totalLen += block.length + 2;
					}
					return blocks.join('\n\n');
				};
				// beforeText：原始消息可能很多（400+条），必须用"头尾保留+中间截断"策略
				// 否则从头截断会丢失尾部消息，导致 _computeStructuredDiff 公共后缀匹配失败
				const fmtListBefore = (msgs: any[]): string => {
					const allBlocks: string[] = [];
					let totalLen = 0;
					for (const m of msgs) {
						const block = fmtBlock(m);
						allBlocks.push(block);
						totalLen += block.length + 2;
					}
					// 未超限则直接返回
					if (totalLen <= MAX_TEXT_LEN) { return allBlocks.join('\n\n'); }
					// 超限时：保留头尾，截断中间
					// 头部占一半预算，尾部占一半预算
					const halfBudget = Math.floor(MAX_TEXT_LEN / 2);
					const headBlocks: string[] = [];
					let headLen = 0;
					for (const block of allBlocks) {
						if (headLen + block.length + 2 > halfBudget && headBlocks.length > 0) { break; }
						headBlocks.push(block);
						headLen += block.length + 2;
					}
					const tailBlocks: string[] = [];
					let tailLen = 0;
					for (let i = allBlocks.length - 1; i >= headBlocks.length; i--) {
						const block = allBlocks[i];
						if (tailLen + block.length + 2 > halfBudget && tailBlocks.length > 0) { break; }
						tailBlocks.unshift(block);
						tailLen += block.length + 2;
					}
					const omitted = allBlocks.length - headBlocks.length - tailBlocks.length;
					const parts = [...headBlocks];
					if (omitted > 0) {
						parts.push(`[... 省略 ${omitted} 条消息 ...]`);
					}
					parts.push(...tailBlocks);
					return parts.join('\n\n');
				};
				const beforeText = fmtListBefore(messages);
				// 收口到 compactMessages reducer（不可变换底），保留单点便于后续加 size guard / token 计费
				messages = compactMessages(messages, compressionResult.compressedMessages as unknown as AgentRunMessage[]) as any[];

				// Calculate compression metrics (needed by P4 injection budget and P0 summary write)
				const compressedEstimatedTokens = host._estimateMessagesTokens(messages);
				const tokensSaved = originalEstimatedTokens - compressedEstimatedTokens;
				const savePercent = originalEstimatedTokens > 0
					? Math.round(tokensSaved / originalEstimatedTokens * 100)
					: 0;
				host._logService.info(
					`[AgentOS][Compression] AFTER: messages=${compressionResult.compressedMessageCount}, ` +
					`estimatedTokens=${compressedEstimatedTokens}, saved=${tokensSaved} (${savePercent}%), ` +
					`duration=${compressionDurationMs}ms`
				);

				// ── P0: 压缩摘要写入记忆 ──────────────────────────────────────
				// 压缩摘要是宝贵的 Episodic (L1) 记忆，记录了"这段对话讲了什么"，
				// 应该持久化到 memory 中供后续会话召回。
				if (didCompress && compressionResult.summary && compressionResult.summary.length > 10) {
					const memProviderForSummary = host.getActiveMemoryProvider();
					if (memProviderForSummary) {
						const summaryTs = Date.now();
						void (async () => {
							try {
							await memProviderForSummary.writeMemory(request.agentId, {
								id: `compression-${summaryTs}`,
								type: 'fact',
								content: `[Context Compressed] ${compressionResult.summary}`,
								metadata: {
									memoryType: 'fact',
									source: 'context_compression',
										originalCount: compressionResult.originalMessageCount,
										compressedCount: compressionResult.compressedMessageCount,
										tokensSaved,
										savePercent,
										workspaceId: host._currentWorkspaceId,
										sessionId: request.sessionId,
										noticeId: `compression-${summaryTs}`,
									},
									timestamp: summaryTs,
								});
								host._logService.info(
									`[AgentOS][Compression] Summary written to memory: ${compressionResult.summary.length} chars`
								);
							} catch (e) {
								host._logService.warn(`[AgentOS][Compression] Failed to write summary to memory: ${e instanceof Error ? e.message : String(e)}`);
							}
						})();
					}
				}

				// ── P4: Checkpoint 无损重建（极端压力兜底）────────────────────
				// 当压力 ≥85% 窗口时，检查点重建比常规压缩更激进：
				// 不调 LLM，复用既有摘要作为"检查点"，丢弃全部旧消息，只保留极短尾段。
				{
					const postCompressTokens = host._estimateMessagesTokens(messages);
					const postPressure = ContextManager.getPressureLevel(postCompressTokens, compressionWindow);
					if (postPressure >= 3 && postCompressTokens > compressionWindow * 0.85) {
						host._logService.warn(
							`[AgentOS][Checkpoint] EXTREME pressure (${(postCompressTokens / compressionWindow * 100).toFixed(0)}%), ` +
							`trying checkpoint rebuild (no LLM, aggressive cut)`
						);
						const checkpointResult = await contextManager.compressCheckpoint(
							messages as unknown as ReadonlyArray<ChatMessage>,
							compressionWindow,
						);
						const ckMeta = checkpointResult.metadata ?? {};
						if (checkpointResult.compressedMessageCount < checkpointResult.originalMessageCount) {
							messages = compactMessages(messages, checkpointResult.compressedMessages as unknown as AgentRunMessage[]) as any[];
							host._logService.warn(
								`[AgentOS][Checkpoint] REBUILT: ` +
								`from ${checkpointResult.originalMessageCount}→${checkpointResult.compressedMessageCount} messages, ` +
								`saved ${ckMeta.tokensSaved ?? 'n/a'} tokens, no LLM`
							);
						} else {
							host._logService.warn(
								`[AgentOS][Checkpoint] SKIPPED: ${ckMeta.skipped ?? 'no_saving'}`
							);
						}
					}
				}

				const afterText = fmtListSequential(messages);
				const finalEstimatedTokens = host._estimateMessagesTokens(messages);
				yield {
					type: 'context_compacted',
					compactedInputTokens: finalEstimatedTokens,
					compressionOriginalCount: originalMessageCount,
					compressionCompressedCount: compressionResult.compressedMessageCount,
					compressionTokensSaved: tokensSaved,
					compressionDurationMs,
					compressionBeforeText: beforeText,
					compressionAfterText: afterText,
					compressionSummary: compressionResult.summary || '',
				} as IChatStreamDelta;
				// 压缩恢复后显式置 phase 再广播，与 SET_PHASE('compressing') 同源
			runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'llm_streaming' });
			yield { type: 'phase_change', phase: runState.phase };
		}
	}
}

	// ─── Plan 模式处理闭包（2026-07-27 自主循环提取，~225 行）──────────────────
	// plan_explore / plan_enter / plan_exit 拦截器：工作模式切换 + 计划文件管理 +
	// 用户审批 + DAG 编排。参数传递循环局部变量（effectiveToolCalls/toolResults/endedToolIds），
	// 闭包捕获 messages/runState/workState/planFilePath/planEnterCalled/planExitCalled/host/request。
	// 返回 'done' 表示 plan_exit 编排完成（主循环应 return）；undefined 表示继续。
	async function* _handlePlanModeTools(
		effectiveToolCalls: any[],
		toolResults: any[],
		endedToolIds: Set<string>,
	): AsyncGenerator<IChatStreamDelta, 'done' | undefined> {
		// ─── plan_explore + subagent card injection ──
		const planExploreCall = effectiveToolCalls.find(tc => tc.name === 'plan_explore');
		if (planExploreCall) {
			// P1: enforce that plan_explore only runs in plan workMode.
			// If the LLM calls plan_explore without plan_enter, auto-enter.
			if (workState.mode !== 'plan') {
					host._logService.info(`[AgentOS] plan_explore auto-entering plan workMode (enforcement)`);
					workState = reduceWorkState(workState, { type: 'ENTER_PLAN' });
					runState = reduceRunState(runState, { type: 'WORK_EVENT', event: { type: 'ENTER_PLAN' } });
					yield { type: 'work_mode_changed', workMode: 'plan' };
					// Generate plan file path if not set
					if (!planFilePath) {
						const sarosRoot = host._getSarosRoot?.() ?? '';
						const allUserMsgs = (request.messages || []).filter((m: any) => m.role === 'user');
						const lastUserMsg = allUserMsgs[allUserMsgs.length - 1];
						const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
						planFilePath = generatePlanPath(sarosRoot, userText);
						workState = reduceWorkState(workState, { type: 'SET_PLAN_FILE', planFilePath });
						runState = reduceRunState(runState, { type: 'WORK_EVENT', event: { type: 'SET_PLAN_FILE', planFilePath } });
						try {
							await host._writePlanFile(planFilePath, `# Plan\n*Auto-created by plan_explore enforcement*\n\n## Goal\n\n\n## Tasks\n\n`);
						} catch { /* best-effort */ }
					}
				}
			host._logService.info(`[AgentOS] plan_explore called — parallel exploration launched`);

				// Extract subagent data from tool result for chat panel SubAgentCards
				const exploreResult = toolResults.find(r => r.toolCallId === planExploreCall.id);
				if (exploreResult?.content) {
					try {
						const contentText = Array.isArray(exploreResult.content)
							? exploreResult.content.map((c: any) => c.text || '').join('')
							: String(exploreResult.content);
						const parsed = JSON.parse(contentText);
						if (parsed.subagentData && Array.isArray(parsed.subagentData)) {
							yield {
								type: 'subagent_batch' as any,
								subagentData: parsed.subagentData,
								toolCallId: planExploreCall.id,
							};
						}
					} catch { /* parse failure — subagent data not available */ }
						}
		}

		// ─── plan_enter: enter the internal read-only WorkMode ─────────────
		// Both Plan and Craft policies may enter planning;
		// their only behavioral difference is the approval gate at plan_exit.
		const planEnterCall = effectiveToolCalls.find((tc: any) => tc.name === 'plan_enter');
		if (planEnterCall && !planEnterCalled) {
			planEnterCalled = true;
			workState = reduceWorkState(workState, { type: 'ENTER_PLAN' });
			runState = reduceRunState(runState, { type: 'WORK_EVENT', event: { type: 'ENTER_PLAN' } });
			yield { type: 'work_mode_changed', workMode: 'plan' };

			const sarosRoot = host._getSarosRoot?.() ?? '';
			const allUserMsgs = (request.messages || []).filter((m: any) => m.role === 'user');
			const lastUserMsg = allUserMsgs[allUserMsgs.length - 1];
			const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
			planFilePath = generatePlanPath(sarosRoot, userText);
			workState = reduceWorkState(workState, { type: 'SET_PLAN_FILE', planFilePath });
			runState = reduceRunState(runState, { type: 'WORK_EVENT', event: { type: 'SET_PLAN_FILE', planFilePath } });

			try {
				const initialContent = `# Plan: ${(userText || 'Untitled').slice(0, 80)}\n\n` +
					`*Created: ${new Date().toISOString()}*\n\n` +
					`## Goal\n\n` +
					`## Exploration Findings\n\n` +
					`## Tasks\n\n` +
					`### Task 1: <title>\n` +
					`- Description: <self-contained implementation task and acceptance criteria>\n` +
					`- Files: <comma-separated paths>\n` +
					`- Dependencies: none\n` +
					`- Complexity: medium\n\n` +
					`## Verification\n`;
				await host._writePlanFile(planFilePath, initialContent);
				host._logService.info(`[AgentOS] plan_enter — workMode=plan, plan file created at ${planFilePath}`);
			} catch (createErr) {
				host._logService.warn(`[AgentOS] plan_enter could not create plan file: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
			}

			messages = appendMessages(messages, {
				role: 'tool',
				content: `Entered internal plan work mode. Plan file: ${planFilePath}. Follow: explore → design → review → write structured tasks → plan_exit.`,
				toolCallId: planEnterCall.id,
			});
			// P0: 拦截器必须显式 yield tool_result + tool_end，否则 UI 端 tool_start 无对应 end → 触发 orphan 清理
			yield {
				type: 'tool_result',
				content: sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({
					note: `Entered internal plan work mode. Plan file: ${planFilePath}.`,
				}))),
				toolCallId: planEnterCall.id,
			};
			yield { type: 'tool_end', toolCallId: planEnterCall.id, success: true };
			endedToolIds.add(planEnterCall.id);
		}

		// ─── plan_exit: policy gate → WorkMode switch → DAG subagent fan-out ──
		const planExitCall = effectiveToolCalls.find((tc: any) => tc.name === 'plan_exit');
		if (planExitCall && workState.mode === 'plan' && !planExitCalled) {
			try {
				const exitArgs = typeof planExitCall.arguments === 'string'
					? JSON.parse(planExitCall.arguments) : planExitCall.arguments;
				if (exitArgs?.plan_file) { planFilePath = String(exitArgs.plan_file); }
			} catch { /* use the path established by plan_enter */ }

			let planMarkdown = '';
			if (planFilePath) {
				planMarkdown = await host._readPlanFile(planFilePath);
			}
			const parsedPlan = parsePlanDocument(planMarkdown);
			const executableTasks = parsedPlan.tasks.filter(task => task.title !== '<title>' && !task.title.includes('<'));
			if (!planFilePath || !planMarkdown.trim() || executableTasks.length === 0) {
				const invalidResult = !planFilePath
					? 'Plan exit blocked: no plan file is associated with this work cycle. Call plan_enter first.'
					: `Plan exit blocked: ${planFilePath} must contain at least one structured task under "## Tasks".`;
				host._logService.warn(`[AgentOS] plan_exit rejected invalid plan: file=${planFilePath ?? '(none)'}, tasks=${executableTasks.length}`);
				messages = appendMessages(messages, { role: 'tool', content: invalidResult, toolCallId: planExitCall.id });
				yield { type: 'tool_result', content: sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ note: invalidResult }))), toolCallId: planExitCall.id };
				yield { type: 'tool_end', toolCallId: planExitCall.id, success: false };
				endedToolIds.add(planExitCall.id);
				return undefined;
			}

			const shouldAskUser = planExitRequiresApproval();
			host._logService.info(`[AgentOS] plan_exit — approval=${shouldAskUser}, tasks=${executableTasks.length}`);
			let approved = !shouldAskUser;
			if (shouldAskUser) {
				workState = reduceWorkState(workState, { type: 'REQUEST_APPROVAL' });
				runState = reduceRunState(runState, { type: 'WORK_EVENT', event: { type: 'REQUEST_APPROVAL' } });
				const confirmationId = `plan-exit-${request.sessionId ?? 's'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
				yield {
					type: 'confirmation',
					confirmationData: {
						id: confirmationId,
						type: 'plan-approval' as const,
						title: 'Plan Complete — Execute in Parallel?',
						message: `The plan contains ${executableTasks.length} task(s). Approve parallel subagent execution?`,
						detail: `Plan file: ${planFilePath}`,
						planSummary: parsedPlan.summary,
						tasks: executableTasks,
						buttons: [
							{ id: 'approve', label: 'Approve & Execute', primary: true },
							{ id: 'reject', label: 'Keep Planning', danger: true },
						],
						status: 'pending' as const,
					} as any,
				};
				const decision = await host._awaitPlanApproval(confirmationId);
				approved = decision === 'approved';
				yield {
					type: 'confirmation_resolved',
					confirmationId,
					confirmationStatus: approved ? 'approved' : 'rejected',
				};
			}

			if (!approved) {
				workState = reduceWorkState(workState, { type: 'REJECT_PLAN' });
				runState = reduceRunState(runState, { type: 'WORK_EVENT', event: { type: 'REJECT_PLAN' } });
				messages = appendMessages(messages, {
					role: 'tool',
					content: 'The user rejected execution. Stay in plan work mode and refine the existing plan.',
					toolCallId: planExitCall.id,
				});
				yield { type: 'tool_result', content: sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ note: 'User rejected execution. Stay in plan work mode.' }))), toolCallId: planExitCall.id };
				yield { type: 'tool_end', toolCallId: planExitCall.id, success: false };
				endedToolIds.add(planExitCall.id);
				return undefined;
			}

			planExitCalled = true;
			// P0: reset planEnterCalled so subsequent plan_explore calls can auto-enter again.
			// Without this, plan_enter auto-enter (line 2015) only fires once per turn.
			planEnterCalled = false;
			workState = reduceWorkState(workState, shouldAskUser ? { type: 'APPROVE_PLAN' } : { type: 'START_DISPATCH' });
			runState = reduceRunState(runState, {
				type: 'WORK_EVENT',
				event: shouldAskUser ? { type: 'APPROVE_PLAN' } : { type: 'START_DISPATCH' },
			});
			yield { type: 'work_mode_changed', workMode: 'work' };
			messages = appendMessages(messages, { role: 'system', content: buildBuildSwitchReminder(planFilePath) });
			messages = appendMessages(messages, {
				role: 'tool',
				content: `${shouldAskUser ? 'User approved' : 'Craft policy auto-approved'} the plan. Dispatching ${executableTasks.length} task(s) through the orchestration DAG.`,
				toolCallId: planExitCall.id,
			});

			workState = reduceWorkState(workState, { type: 'START_EXECUTION' });
			runState = reduceRunState(runState, { type: 'WORK_EVENT', event: { type: 'START_EXECUTION' } });
			// P1: idempotency key prevents duplicate Plan creation on replay/retry.
			const idempotencyKey = `plan-exit-${request.sessionId ?? 's'}-${planExitCall.id}`;
			yield* host._orchestratePlan(
				request,
				{ plan_summary: parsedPlan.summary, next_mode: 'work', idempotencyKey },
				executableTasks,
				planExitCall.id,
			);
			// P0: 拦截器必须显式 yield tool_result + tool_end，否则 UI 端 tool_start 无对应 end → 触发 orphan 清理
			yield {
				type: 'tool_result',
				content: sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({
					note: `${shouldAskUser ? 'User approved' : 'Craft policy auto-approved'} the plan. Dispatching ${executableTasks.length} task(s).`,
				}))),
				toolCallId: planExitCall.id,
			};
			yield { type: 'tool_end', toolCallId: planExitCall.id, success: true };
			endedToolIds.add(planExitCall.id);
			yield { type: 'done' };
			return 'done';
		} else if (planExitCall) {
			// P0: plan_exit called outside plan mode → return clear error instead of
			// silently ignoring (which caused the LLM to retry 56+ times per turn).
			const reason = planExitCalled
				? 'plan_exit was already processed this turn. Tasks are being dispatched — wait for results.'
				: 'plan_exit only works in plan mode (after plan_enter). Call plan_enter first to enter plan mode, then plan_explore, then plan_exit ONCE.';
			messages = appendMessages(messages, {
				role: 'tool',
				content: reason,
				toolCallId: planExitCall.id,
			});
			yield { type: 'tool_result', content: sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ note: reason }))), toolCallId: planExitCall.id };
			yield { type: 'tool_end', toolCallId: planExitCall.id, success: false };
			endedToolIds.add(planExitCall.id);
		}
		return undefined;
	}

	// ─── 后处理闭包（2026-07-28 自主循环提取，~170 行）──────────────────
	// 每轮迭代末尾执行：delegation ledger 更新 → memory hooks → orphan tool reconcile →
	// guardrail（all tools failed）→ shouldTerminateToolBatch → codebase memory 工具检测 →
	// memory capture → budget consume → checkpoint 持久化。
	// 参数传递循环局部变量（toolResults/localExecutedCalls/effectiveToolCalls/startedToolIds/endedToolIds/
	// trimmedAssistantContent/memoryProvider/iteration），闭包捕获 messages/runState/host/request/
	// strategy/budget/resolvedParadigm。
	// 返回 'done' 表示提前结束（all tools failed 或 terminate=true）；undefined 表示继续。
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
		// ─── Update Delegation Ledger with tool results（借鉴 deer-flow）──────
		for (const tr of toolResults) {
			const tc = localExecutedCalls.find((c: any) => c.id === tr.toolCallId);
			if (!tc || !host._subagentLimitMw.isDelegationCall(tc)) { continue; }

			const resultText = typeof tr.content === 'string'
				? tr.content
				: (tr.content?.text ?? (tr.content?.error ? `Error: ${tr.content.error}` : JSON.stringify(tr.content ?? '')));

			if (tr.success) {
				host._delegationLedger.markCompleted(tc.id, resultText);
			} else {
				host._delegationLedger.markFailed(tc.id, resultText);
			}
		}

		// Persist updated ledger into durable context so it survives
		// summarization compression on the next round.
		host._durableContext.updateFromLedger(host._delegationLedger.getAllEntries());

		// ── Hook: post_tool_use / post_tool_failure ───────────────────
		if (memoryProvider?.triggerHook) {
			for (const tr of toolResults) {
				const tc = localExecutedCalls.find((c: any) => c.id === tr.toolCallId);
				memoryProvider.triggerHook(tr.success ? 'post_tool_use' : 'post_tool_failure', {
					agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
					toolName: tc?.name ?? '', toolCallId: tr.toolCallId,
					toolResult: typeof tr.content === 'string' ? tr.content.slice(0, 2000) : JSON.stringify(tr.content ?? '').slice(0, 2000),
					error: tr.success ? undefined : (typeof tr.content === 'string' ? tr.content.slice(0, 2000) : JSON.stringify(tr.content ?? '').slice(0, 2000)),
				}).catch(() => { });
			}
		}

		// ─── Reconcile: emit synthetic tool_end for any orphaned tool_start ──
		// IDs that received tool_start but never tool_end (lost via dedup,
		// phantom filter, missing provider, or any other early-return path)
		// must be terminated, otherwise their webview tool cards will spin
		// forever. We emit success=false so users can see they did not run.
		for (const orphanId of startedToolIds) {
			if (!endedToolIds.has(orphanId)) {
				host._logService.warn(`[AgentOS] Orphaned tool_start without tool_end: ${orphanId} — emitting synthetic tool_result + tool_end (success=false)`);
				const orphanResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ note: '工具未执行（可能已被过滤、去重或无匹配的 provider）' })));
				yield {
					type: 'tool_result',
					content: orphanResultStr,
					toolCallId: orphanId,
				};
				yield {
					type: 'tool_end',
					toolCallId: orphanId,
					success: false,
				};
				endedToolIds.add(orphanId);
			}
		}

		// ─── Guardrail: too many failed tool calls → break ──────
		const failedCount = toolResults.filter(r => !r.success).length;
		if (failedCount === toolResults.length && toolResults.length > 0) {
			// All tools failed — check if they are "tool not found" errors
			const allNotFound = toolResults.every(r => {
				const content = JSON.stringify(r.content);
				return content.includes('does not exist') || content.includes('not available');
			});
			if (allNotFound) {
				runState = reduceRunState(runState, { type: 'INVALID_TOOL_NAME' });
				if (runState.invalidToolNameCount >= MAX_INVALID_TOOL_RETRIES) {
					host._logService.warn(`[AgentOS] Too many invalid tool name attempts (${runState.invalidToolNameCount}), ending loop`);
					yield { type: 'done' };
					return 'done';
				}
			}
		}

		// ─── shouldTerminateToolBatch（借鉴 OpenClaw）──────────────
		// 所有工具返回 terminate=true 时提前结束 agent loop
		// 当前 Sarosis 的 IToolResult 没有 terminate 字段，但预留接口
		// 为将来扩展（如 "任务已完成"信号工具）做准备
		if (toolResults.length > 0 && toolResults.every(r => (r as any).terminate === true)) {
			host._logService.info(`[AgentOS] All ${toolResults.length} tool results signaled terminate — ending loop early`);
			yield { type: 'done' };
			return 'done';
		}

		// ─── codebase memory 工具调用检测 ──────────────────────────────────
		// 当 LLM 调用 codebase-memory MCP 工具时，yield codebase_operation 事件
		// 供前端系统消息面板显示
		for (const tc of effectiveToolCalls) {
			if (tc.name.includes('codebase') || tc.name.includes('index_repository') ||
				tc.name.includes('search_graph') || tc.name.includes('search_code') ||
				tc.name.includes('trace_path') || tc.name.includes('get_architecture') ||
				tc.name.includes('detect_changes') || tc.name.includes('list_projects')) {
				const opMap: Record<string, string> = {
					index_repository: 'index', search_graph: 'graph', search_code: 'search',
					trace_path: 'trace', get_architecture: 'graph', detect_changes: 'changes',
					list_projects: 'index', get_code_snippet: 'search', index_status: 'index',
				};
				let op = 'search';
				for (const [key, val] of Object.entries(opMap)) {
					if (tc.name.includes(key)) { op = val; break; }
				}
				// 解析工具参数，供前端显示详细内容
				let argsSummary = '';
				try {
					const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
					if (args) {
						const parts: string[] = [];
						for (const [k, v] of Object.entries(args)) {
							const valStr = typeof v === 'string' ? v : JSON.stringify(v);
							parts.push(`${k}: ${valStr.length > 100 ? valStr.slice(0, 100) + '...' : valStr}`);
						}
						argsSummary = parts.join(', ');
					}
				} catch { /* ignore parse errors */ }
				yield {
					type: 'codebase_operation' as any,
					content: tc.name,
					metadata: { operation: op, toolName: tc.name, args: argsSummary },
				} as any;
			}
		}

		// ─── per-iteration memory capture（W1，2026-07-26 §16 日志实证修复）───
		// 此前每迭代 writeMemory(type=working) 直写长期层：子代理 40+ 迭代即
		// 洪泛 40+ 条过程性内容进 core memory（§11 分层改造的漏网通道）。
		// 改道 observe 会话暂存层（mem:obs，便宜 KV set + 滑动窗口 + 阈值压缩）——
		// 保留中断安全的增量捕获，不再污染长期层；assistant 消息本体由
		// storeTurnObservations 在 turn 边界捕获（含去重）。同时删除每迭代的
		// 「Working 写入中」噪音 UI 卡片。
		const memProvider = host.getActiveMemoryProvider();
		if (memProvider && (trimmedAssistantContent || toolResults.length > 0)) {
			const iterContent = (trimmedAssistantContent || 'Tool execution completed') + (toolResults.length > 0
				? ` [工具: ${effectiveToolCalls.map((tc: any) => tc.name).join(', ')}]`
				: '');
			void memProvider.observe?.(request.agentId, {
				sessionId: request.sessionId || '',
				hookType: 'turn_observation',
				timestamp: new Date().toISOString(),
				data: {
					content: iterContent.slice(0, 2000),
					role: 'assistant',
					toolCalls: effectiveToolCalls.length,
					toolResults: toolResults.length,
					iteration,
				},
			}).catch(() => { /* fire-and-forget */ });
		}

		// ─── 预算消耗（Hermes 范式：每轮 consume；委托轮 refund 不耗父预算）──
		if (strategy && (strategy as any).takeDelegationRound && (strategy as any).takeDelegationRound()) {
			budget.refund(1);
		} else {
			budget.consume(1);
		}

		// ─── V3: 每轮持久化 checkpoint（单 agent 断点续跑）──
		// 在 budget consume 后立即落盘，确保中断恢复时 budget 状态为最新。
		// checkpointSink 由 agentDriverService 注入（workspace storage），异步 fire-and-forget 不阻塞循环。
		if (request.checkpointSink && iteration % 3 === 0) {
			try {
				const budgetSnap = budget.snapshot();
				const snapState = reduceRunState(runState, { type: 'SAVE_BUDGET', snapshot: budgetSnap });
				const snapWithMessages = reduceRunState(snapState, { type: 'SET_LOOP_MESSAGES', messages: messages as AgentRunMessage[] });
				const snapWithParadigm = reduceRunState(snapWithMessages, { type: 'SET_PARADIGM', paradigm: resolvedParadigm });
				const snapFull = { ...snapWithParadigm, iteration }; // iteration 由 while 维护，不经 runState reducer
				const snapshot = snapshotRunState(snapFull);
				void (async () => {
					try { await request.checkpointSink!(snapshot); }
					catch (ckErr) { host._logService?.warn?.('' + (ckErr instanceof Error ? ckErr.message : ckErr)); }
				})();
			} catch (snapshotErr) {
				host._logService?.warn?.('[AgentOS] Checkpoint snapshot failed: ' + (snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)));
			}
		}
		return undefined;
	}

	while (iteration < MAX_TOOL_ITERATIONS) {
		iteration++;
		// ─── V3: 显式 abort 检查点（每轮顶检查，不在迭代间隙期等待）──
		if (turnAbortSignal.aborted) {
			host._logService.warn(`[AgentOS] Turn aborted at iteration ${iteration} — stopping loop`);
			break;
		}
		// ─── 预算门控（Hermes 范式核心：IterationBudget）──
		// 预算耗尽且无 grace 余量 → 终止主循环（对齐 Hermes 末次宽限后的硬停）。
		if (!budget.hasRemaining() && !budget.isGraceArmed()) {
			host._logService.warn(`[AgentOS] Iteration budget exhausted (${budget.getSummary()}) — stopping loop`);
			break;
		}
		// ─── 软预算收尾提醒（超阈值首次注入；之后每 REFIRE 周期重复，不打断执行）──
		if (request.softDeadlineMs && request.softDeadlineMs > 0) {
			const _elapsedMs = Date.now() - _turnStartedAt;
			if (_elapsedMs >= request.softDeadlineMs && _elapsedMs >= _softBudgetNextReminderAtMs) {
				_softBudgetNextReminderAtMs = _elapsedMs + SOFT_BUDGET_REMINDER_REFIRE_MS;
				const agentTag = request.subAgent?.background ? `[subAgent:${request.agentId}]` : '[main]';
				host._logService.warn(
					`[AgentOS] ${agentTag} Soft budget exceeded (${Math.round(_elapsedMs / 1000)}s >= ${Math.round(request.softDeadlineMs / 1000)}s) — injecting wrap-up reminder`
				);
				messages.push({
					role: 'user',
					content: softBudgetWrapUpReminder(Math.round(_elapsedMs / 1000), Math.round(request.softDeadlineMs / 1000)),
				});
			}
		} else if (request.subAgent?.background && iteration === 1) {
			// 诊断：子代理首轮却无 softDeadlineMs — 说明 unifiedSubAgentDispatch 链路未送达
			host._logService.warn(
				`[AgentOS] [subAgent:${request.agentId}] softDeadlineMs is NOT set — ` +
				`wrap-up reminder will NOT be injected. Check unifiedSubAgentDispatch request construction.`,
			);
		}
		// ─── 策略：本轮准备（预算低时注入「整理总结」提醒）──
		{
			let _strategyReminder: string | undefined;
			if (strategy?.prepareIteration) {
				const sp = strategy.prepareIteration({
					host, request, chatMode: String(chatOnly), modelProvider, modelId: selection?.modelId, selection,
					messages, signal: turnAbortSignal, budget, workState, toolDefs: enabledTools, iteration,
				}, budget);
				_strategyReminder = sp.reminderMessage;
				// 捕获策略对本轮工具面的覆盖（如 delegation 范式限制 supervisor 工具）。
				// 仅当策略显式返回 toolDefs 时才覆盖；其余范式返回 undefined → 沿用全工具。
				if (sp.toolDefs) { _iterationToolDefs = sp.toolDefs; }
			}
			// MiMo-Code 处理方式：策略级 reminder 统一作为 user 消息注入
			// （synthetic user part），而非 system 角色 —— 避免破坏 system 前缀缓存，
			// 与 beforeTerminate 的 nudgeMessage（亦为 user 角色）保持一致。
			if (_strategyReminder) { messages.push({ role: 'user', content: _strategyReminder }); }
		}
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
			if (iteration % 5 === 0) {
				await new Promise<void>(r => setTimeout(r, 0));
			}
			host._logService.info(`[AgentOS] Direct mode iteration ${iteration}/${MAX_TOOL_ITERATIONS}`);

			yield* _compressContextIfNeeded();


			// ─── 每轮迭代重新收集工具 ──────────────────────────────────
			// MCP 服务器可能在 agent loop 进行中才完成连接并暴露工具。
			// 每轮迭代重新收集确保新可用的 MCP 工具被纳入 LLM 请求。
			// 首轮使用循环前已收集（含等待）的 enabledTools；后续轮次刷新。
			if (iteration > 1) {
				const refreshed = await host._getEnabledTools(request.agentId, request.agentGraph, request.toolsetsOverride,
					host._resolveHardPermissionForWorkMode?.(workState.mode) ?? host._resolveHardPermission(request), request.excludedTools, request.allowedTools);
				if (refreshed.length !== enabledTools.length) {
					const newMcp = refreshed.filter((t: any) => t.category?.startsWith('mcp:')).map((t: any) => t.name);
					host._logService.info(`[AgentOS] Iteration ${iteration}: tools refreshed ${enabledTools.length} → ${refreshed.length} (MCP: [${newMcp.join(', ')}])`);
				}
				enabledTools = refreshed;
			}

			// 策略工具面覆盖（delegation 范式：主循环仅 supervisor 工具）。
			// 必须在「每轮重新收集工具」之后应用，否则会被全量工具列表冲掉。
			if (_iterationToolDefs) {
				enabledTools = _iterationToolDefs;
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
		// 冻结前缀指纹统一基于 effectiveSystemPrompt（实际发送的第一条 system 消息，
		// 含 model 相关 enforcement）——保证指纹、缓存断点、modelOptions 三者字节一致。
		const currentFork = buildForkContext(effectiveSystemPrompt ?? '', enabledTools);
		if (request.sessionId) {
			host._lastForkContextBySession.set(request.sessionId, currentFork);
		}
		const forkAligned = prefixCacheAligned(request.forkContext, effectiveSystemPrompt ?? '', enabledTools);
		host._logService.info(
			`[AgentOS] Fork prefix-cache: aligned=${forkAligned} ` +
			`parentFp=${request.forkContext?.toolsFingerprint ?? '(none)'} ` +
			`childFp=${currentFork.toolsFingerprint} session=${request.sessionId ?? '(none)'}`,
		);

		// 构建模型选项（注入工具 + ForkContext）
		const modelOptions: IModelOptions = {
			temperature: request.options?.temperature ?? 0.7,
			maxTokens: request.options?.maxTokens ?? 4096,
			systemPrompt: effectiveSystemPrompt,
				tools: enabledTools.length > 0 ? enabledTools : undefined,
				stop: request.options?.stop,
				// 思考/推理配置：由聊天输入框 thinking UI 控件透传至此，
				// 各 model provider 据此映射到原生 API 参数（thinking/thinkingConfig/reasoning_effort）。
				reasoning: request.options?.reasoning,
				// Fork 前缀缓存：透传父级 ForkContext 给请求构造端判对齐 + 打 cache 断点。
				forkContext: request.forkContext,
			};

			// 调用模型
			// 注意：抓包对齐的三个独立 id（不可混用）：
			//   conversationId  会话级稳定（同一 sessionId 复用同一个）→ X-Conversation-ID
			//   requestId       请求级，每轮 iteration 都重新生成      → X-Conversation-Request-ID
			//   previousResponseId  上一轮响应流的 id（链式衔接）        → 请求体 previous_response_id
			// 历史串台 bug：仅用单一 sessionId 当所有 id，服务端 KV 缓存按 conversation-id
			// 跨会话碰撞 → 命中旧上下文、忽略本地 priorMessages。此处分离三 id 杜绝碰撞。
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

			host._logService.info(`[AgentOS] Calling modelProvider.chat(modelId=${selection.modelId}, messages=${messages.length}, tools=${enabledTools.length}) convId=${conversationId} reqId=${requestId} prevRespId=${previousResponseId ?? '(none)'}`);

			// ─── 诊断：列出实际发送给 LLM 的所有工具名 ──────────────────
			if (enabledTools.length > 0) {
				const mcpToolsSent = enabledTools.filter((t: any) => t.category?.startsWith('mcp:'));
				const builtinToolsSent = enabledTools.filter((t: any) => !t.category?.startsWith('mcp:'));
				host._logService.info(
					`[AgentOS] TOOLS SENT TO LLM: ${enabledTools.length} total\n` +
					`  MCP tools (${mcpToolsSent.length}): [${mcpToolsSent.map((t: any) => t.name).join(', ')}]\n` +
					`  Builtin tools (${builtinToolsSent.length}): [${builtinToolsSent.map((t: any) => t.name).join(', ')}]`
				);
				if (mcpToolsSent.length === 0) {
					host._logService.warn(`[AgentOS] ⚠ NO MCP TOOLS in API request! MCP server may not be connected.`);
				}
			} else {
				host._logService.warn(`[AgentOS] ⚠ NO TOOLS at all in API request!`);
			}

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
						`iter=${iteration} model=${selection.modelId} convId=${conversationId} reqId=${requestId} | ` +
						`msgs=${messages.length} enabledTools=${enabledTools.length} | ` +
						`estTokens=${_est} realPromptTokens=${_real} compressionWindow=${compressionWindow} | ` +
						`pressure=${_pressure}/3 (${compressionWindow > 0 ? Math.round((_real || _est) / compressionWindow * 100) : 0}%) | ` +
						`lastCompressionAt=${_sinceCompress >= 0 ? _sinceCompress + 's ago' : 'never'} | ` +
						`prevRespId=${previousResponseId ?? '(none)'} | ` +
						`abortSignal=${host._loopAbortController?.signal?.aborted ? 'ABORTED' : 'active'}`
					);
				}
				const rawStream = modelProvider.chat(selection.modelId, messages, modelOptions, context);
				// 流式 idle 超时：模型静默挂起（无 delta 心跳超过阈值）时抛 TimeoutError，
				// 由下方 catch 重新抛出并触发 _executeWithFallback 的备用模型切换（对齐 LangGraph TimeoutPolicy）。
				// ─── 自适应首 token 超时（方案 B）────────────────────────────
				// 固定 45s 对大 prompt 冷缓存请求过紧（实测 hy3-ioa 34k tokens TTFB 46.4s，
				// 被误杀后 1.4s 网关实际正常返回）。prefill 耗时与 prompt 大小正相关，
				// 按估算 token 数阶梯放宽（>16k 每 8k +15s，封顶 115s < HTTP 120s）。
				// 取本轮粗估与上轮真实 prompt_tokens 的较大者，避免粗估低估导致宽限不足。
				const _estPromptTok = Math.max(
					host._estimateMessagesTokens(messages),
					runState.lastRealPromptTokens ?? 0,
				);
				const _baseFirstTok = host._modelStreamTimeoutPolicy.firstTokenTimeout ?? 45_000;
				const _adaptiveFirstTok = computeAdaptiveFirstTokenTimeout(_estPromptTok, _baseFirstTok);
				const _callTimeoutPolicy = _adaptiveFirstTok !== _baseFirstTok
					? { ...host._modelStreamTimeoutPolicy, firstTokenTimeout: _adaptiveFirstTok }
					: host._modelStreamTimeoutPolicy;
				if (_adaptiveFirstTok !== _baseFirstTok) {
					host._logService.info(
						`[AgentOS] Adaptive first-token timeout: ${_baseFirstTok}ms → ${_adaptiveFirstTok}ms (estPromptTokens=${_estPromptTok})`,
					);
				}
				const stream = withStreamTimeout(rawStream, _callTimeoutPolicy, {
					signal: host._loopAbortController?.signal,
					log: (lvl, msg) => {
						if (lvl === 'error') { host._logService.error(msg); }
						else if (lvl === 'warn') { host._logService.warn(msg); }
						else { host._logService.info(msg); }
					},
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
				for await (const delta of stream) {
					_totalDeltas++;
					_lastDeltaType = String(delta.type ?? 'unknown');
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
					}
					// ── 诊断：per-delta 时间线条目 ──
					{
						const _elapsed = _deltaAt - t0_modelCall;
						let _preview = '';
						if (delta.type === 'text' && delta.content) {
							_preview = `"${String(delta.content).slice(0, 80)}"`;
						} else if (delta.type === 'thinking' && (delta as any).content) {
							_preview = `"${String((delta as any).content).slice(0, 80)}"`;
						} else if (delta.type === 'tool_call' && delta.toolCall) {
							_preview = `name=${delta.toolCall.name ?? '(cont)'}`;
						} else if (delta.type === 'usage' && delta.usage) {
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
						} else if (delta.type === 'done') {
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
					if (delta.type === 'text' && delta.content) {
						_textDeltas++;
						_textBytes += (delta.content as string).length;
						_lastTextDeltaAt = Date.now();
					} else if (delta.type === 'thinking' && (delta as any).content) {
						_reasoningDeltas++;
						_reasoningBytes += String((delta as any).content).length;
						_lastReasoningDeltaAt = Date.now();
					} else if (delta.type === 'tool_call') {
						_toolCallDeltas++;
					} else if (delta.type === 'usage') {
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
					if (delta.type === 'usage' && delta.usage) {
						const u = delta.usage;
						const realPrompt = (u.inputTokens ?? 0) + (u.cachedTokens ?? 0) + (u.cacheWriteTokens ?? 0);
						if (realPrompt > 0) {
							runState = reduceRunState(runState, { type: 'SET_LAST_PROMPT_TOKENS', value: realPrompt });
							host._lastRealPromptTokensByAgent.set(host._turnKey(request.agentId, request.sessionId), realPrompt);
							// P1(cache-cold): 记录本次 assistant 响应时间，供下一轮剪枝的缓存冷热判定
							host._lastAssistantAtByAgent.set(host._turnKey(request.agentId, request.sessionId), Date.now());
							host._logService.info(
								`[AgentOS][Compression] captured real prompt usage: inputTokens=${u.inputTokens ?? 0} ` +
								`cached=${u.cachedTokens ?? 0} cacheWrite=${u.cacheWriteTokens ?? 0} → lastRealPromptTokens=${runState.lastRealPromptTokens}`
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
					if (delta.type === 'done' && delta.finishReason) {
						lastFinishReason = delta.finishReason;
					}
					if (delta.type === 'text' && delta.content) {
						_assistantChunks.push(delta.content);
					} else if (delta.type === 'thinking' && delta.content) {
						_thinkingChunks.push(delta.content);
					} else if (delta.type === 'tool_call' && delta.toolCall) {
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
						if (
							(adapted as any).type === 'tool_start' &&
							delta.type === 'tool_call' &&
							delta.toolCall &&
							delta.toolCall.name &&
							typeof delta.toolCall.arguments === 'string' &&
							delta.toolCall.arguments.length > 0
						) {
							yield {
								type: 'tool_args' as any,
								content: delta.toolCall.arguments,
								toolCallId: delta.toolCall.id,
							};
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
				// 模型调用失败：显式置 phase=error（进 runState，供异常路径 checkpoint 读取）
				runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'error' });
				// ── 维度 3：瞬态错误重试（对齐 MiMo persistentRetrySchedule）────────
				// SSE 超时 / 网络中断 / HTTP 429/5xx 等瞬态错误用指数退避重试，
				// 避免 1 次瞬时抖动就中止整轮对话。TimeoutError 仍向上抛（触发 fallback 模型切换）。
				const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
				if (!isTimeout && isTransientStreamError(error) && transientErrorRetries < TRANSIENT_ERROR_MAX_RETRIES) {
					transientErrorRetries++;
					const delay = Math.min(
						TRANSIENT_ERROR_BASE_DELAY_MS * Math.pow(TRANSIENT_ERROR_BACKOFF_FACTOR, transientErrorRetries - 1),
						TRANSIENT_ERROR_MAX_DELAY_MS
					);
					host._logService.warn(
						`[AgentOS] Transient stream error on iteration ${iteration}, ` +
						`retrying in ${delay}ms (attempt ${transientErrorRetries}/${TRANSIENT_ERROR_MAX_RETRIES}): ` +
						`${error instanceof Error ? error.message : String(error)}`
					);
					await new Promise(r => setTimeout(r, delay));
					continue;  // 回到 while loop 重试
				}
				host._logService.error(`[AgentOS] Model call failed on iteration ${iteration}:`, error);
				// 流式 idle 超时（模型静默挂起）：作为硬失败向上抛出，
				// 经由 runAgentLoop → _executeWithFallback 切换到备用模型（对齐 LangGraph TimeoutPolicy）。
				if (isTimeout) {
					throw error;
				}
				// 如果是第一次迭代失败，尝试 fallback
				if (iteration === 1) {
					yield { type: 'error', content: `Model call failed: ${error instanceof Error ? error.message : String(error)}` };
				}
				// Reconcile any tool_start that was emitted during streaming before
				// the model call failed — webview must not be left with spinners.
				for (const orphanId of startedToolIds) {
					if (!endedToolIds.has(orphanId)) {
						host._logService.warn(`[AgentOS] Orphaned tool_start after model error: ${orphanId} — emitting synthetic tool_result + tool_end`);
						const orphanResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ error: 'Model call failed before tool could execute' })));
						yield { type: 'tool_result', content: orphanResultStr, toolCallId: orphanId };
						yield { type: 'tool_end', toolCallId: orphanId, success: false };
						endedToolIds.add(orphanId);
					}
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
					`Snapshot: iter=${iteration} msgs=${messages.length} estTokens=${_est} ` +
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
				if (extracted.length > 0) {
					host._logService.info(`[AgentOS] Extracted ${extracted.length} tool calls from text output: [${extracted.map((tc: any) => tc.name).join(', ')}]`);
					effectiveToolCalls = extracted;

					// ── Clean assistantContent using the unified sanitizer pipeline
					// (OpenClaw-style multi-stage strip: JSON objects, code blocks, XML, brackets, etc.)
					if (isEntirelyToolCallContent(assistantContent)) {
						assistantContent = '';
						host._logService.info(`[AgentOS] Cleared assistantContent (was entirely tool-call content)`);
					} else {
						const cleaned = sanitizeAssistantVisibleText(assistantContent, 'streaming');
						assistantContent = cleaned.length < 5 ? '' : cleaned;
						host._logService.info(`[AgentOS] Sanitized assistantContent, remaining: ${assistantContent.length} chars`);
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
					for (const tc of effectiveToolCalls) {
						if (validCalls.includes(tc)) { continue; }
						yield { type: 'tool_result', content: `工具 "${tc.name}" 不在可用列表中（可能为幻觉调用）`, toolCallId: tc.id };
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

		// ─── 策略钩子接线：interceptToolCall（观测语义）─────────────────────
		// 原休眠钩子：策略在此追踪每个工具调用 —— HermesReAct 用它做委托记账
		// （_delegationRound → 循环末 refund）与探索调用计数（超阈值注入强制
		// 委托提醒）。当前仅支持观测语义（handled=false），返回值不消费；
		// 若未来需要"策略消费工具调用"（handled=true / terminate），需在此
		// 补齐 tool 消息回填后再跳过执行，避免历史中留下孤儿 tool_call。
		if (strategy?.interceptToolCall && effectiveToolCalls.length > 0) {
			for (const tc of effectiveToolCalls) {
				let parsedArgs: any;
				try {
					parsedArgs = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
				} catch { parsedArgs = undefined; }
				yield* strategy.interceptToolCall({
					host, request, chatMode: String(chatOnly), modelProvider,
					modelId: selection?.modelId ?? '', selection,
					messages, signal: turnAbortSignal, budget, workState,
					toolDefs: enabledTools, iteration,
				}, { name: tc.name, args: parsedArgs });
			}
		}

		// 将助手消息添加到消息历史
			// 注意用 trim() 判定：被 sanitize 清洗后可能残留纯空白（'   ' / '\n'），
			// 若原样 push 进历史，下一轮会把这条"空白 assistant 消息"再喂回 LLM
			// （即用户看到的"发送空消息给 llm"）。纯空白且无工具调用时不入历史。
			const trimmedAssistantContent = assistantContent.trim();
			if (trimmedAssistantContent || effectiveToolCalls.length > 0) {
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

				// ─── Hermes-style 消息边界事件（治本根因修复）─────────────────
				// 把"本 iteration 的 assistant 边界"显式告知下游持久化层，让 chatService
				// 不再 `fullContent += delta` 把多轮文本压扁成一条。content 为本轮权威
				// 文本（已 sanitize+trim），toolCallIds 为本轮工具调用 id。后续 tool_result
				// 仍按 id 跨事件回填，因此这里只需声明归属关系。
				yield {
					type: 'assistant_turn' as any,
					content: trimmedAssistantContent,
					metadata: {
						turnIndex: iteration,
						toolCallIds: effectiveToolCalls.map((tc: any) => tc.id),
					},
				};
			}

			if (effectiveToolCalls.length === 0) {
				// ─── 未完成轮安全续跑（对齐 OpenClaw stopReason 结构判定，无文本意图识别）──
				// 仅当本轮"无可见文本 + 无工具调用"才可能是未完成轮：
				//   - 'reasoning-only'：只有思考块、无可见答案（模型想做但没落地）
				//   - 'empty'：全空（既无文本也无思考、无工具调用）
				//   - 'length'：被 token 上限截断（finishReason=length）
				// 命中则在次数上限内注入续跑指令 + discard_prior_text（防历史污染），然后续跑；
				// 超限则丢弃空/幻觉文本后正常结束。有可见文本（正常终轮）不触发。
				const hasVisibleText = trimmedAssistantContent.length > 0;
				const hasThinking = !!thinkingContent && thinkingContent.trim().length > 0;
				const incompleteKind = classifyIncompleteTurn({
					finishReason: lastFinishReason,
					hasVisibleText,
					hasThinking,
					hasToolCalls: false,
				});
				const used =
					incompleteKind === 'reasoning-only' ? reasoningOnlyRetryAttempts
						: incompleteKind === 'length' ? lengthTruncatedRetryAttempts
							: emptyResponseRetryAttempts;
				// 维度 2+4：按 attempt 获取升级阶梯指令（L1 soft remind / L2 final chance）
				const retryInstruction = resolveIncompleteTurnRetryInstruction(incompleteKind, used + 1);
				if (retryInstruction && incompleteKind !== 'complete') {
					const limit = incompleteTurnRetryLimit(incompleteKind);
					if (used < limit) {
						if (incompleteKind === 'reasoning-only') { reasoningOnlyRetryAttempts++; }
						else if (incompleteKind === 'length') { lengthTruncatedRetryAttempts++; }
						else { emptyResponseRetryAttempts++; }
						host._logService.warn(
							`[AgentOS] Incomplete turn detected (kind=${incompleteKind}, finishReason=${lastFinishReason ?? 'n/a'}, attempt=${used + 1}/${limit}) — safe retry`,
						);
						// 丢弃本轮空/幻觉文本，避免污染历史（对齐 discard_prior_text 基础设施）
						yield { type: 'discard_prior_text', metadata: { reason: incompleteTurnDiscardReason(incompleteKind) } };
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
								if (cooldownMs < host.constructor.COMPRESSION_COOLDOWN_MS) {
									host._logService.warn(
										`[AgentOS] Incomplete turn + high pressure (${Math.round(effectiveTokens / compressionWindow * 100)}%): ` +
										`bypassing compression cooldown (${Math.round(cooldownMs / 1000)}s elapsed, needed ${host.constructor.COMPRESSION_COOLDOWN_MS / 1000}s)`
									);
									host._lastCompressionTime = 0;
								}
							}
						}
						// 注入续跑指令作为下一轮 user 边界，让模型产出可见答案 / 真正动手
						messages = appendMessages(messages, { role: 'user', content: retryInstruction });
						continue;
					}
					host._logService.warn(
						`[AgentOS] Incomplete turn retries exhausted (kind=${incompleteKind}, finishReason=${lastFinishReason ?? 'n/a'}) — ending conversation`,
					);
					// 超限：丢弃空/幻觉文本后正常结束，避免把污染内容喂回模型
					yield { type: 'discard_prior_text', metadata: { reason: incompleteTurnDiscardReason(incompleteKind) } };
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
					emptyResponseRetryAttempts > 0 &&
					emptyResponseRetryAttempts < incompleteTurnRetryLimit('empty')
				) {
					emptyResponseRetryAttempts++;
					host._logService.warn(
						`[AgentOS] Text-without-tools in retry context (emptyRetryAtt=${emptyResponseRetryAttempts}/${incompleteTurnRetryLimit('empty')}, textLen=${trimmedAssistantContent.length}) — injecting tool-action reminder`,
					);
					messages = appendMessages(messages, { role: 'user', content: textWithoutToolsReminder() });
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
					messages, signal: turnAbortSignal, budget, workState,
					toolDefs: enabledTools, iteration, trivialRequest,
				}, budget);
					if (!term.allow && term.nudgeMessage) {
						host._logService.info('[AgentOS] beforeTerminate veto: injecting reentry nudge and continuing');
						messages = appendMessages(messages, { role: 'user', content: term.nudgeMessage, synthetic: true, sidecar: 'nudge' });
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
			// [Sarosis] Server-executed tool detection:
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


			/**
			 * 将工具失败恢复提示追加到结果文本中。
			 * 借鉴 Hermes-Agent: 工具失败后告诉 LLM "试试别的方案"，而非让它盲目重试。
			 */
			const appendRecoveryHint = (resultStr: string, toolCallId: string): string => {
				const tc = localExecutedCalls.find((c: any) => c.id === toolCallId);
				if (!tc) { return resultStr; }
				const hint = getToolFailureRecoveryHint(host, tc.name);
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
		const hardPerm = host._resolveHardPermissionForWorkMode?.(workState.mode) ?? host._resolveHardPermission(request);

		// ─── Control tools (plan_enter/plan_exit): skip normal handler ───
		// These are intercepted below; running the placeholder handler + the
		// interceptor produces dual tool results for the same toolCallId.
		const controlToolNames = new Set(['plan_enter', 'plan_exit']);
		// Remove control tools from local execution — will be processed by interceptors below
		localExecutedCalls = localExecutedCalls.filter(tc => !controlToolNames.has(tc.name));

		if (hardPerm && localExecutedCalls.length > 0) {
			const deniedCalls: any[] = [];
			const allowedCalls: any[] = [];
			for (const tc of localExecutedCalls) {
				const denial = isToolCallDeniedByHardPermission(tc.name, hardPerm);
				if (denial.denied) {
					// Check plan file exception: file_write/file_edit to plan files is allowed
					let isPlanFileWrite = false;
					if (tc.name === 'file_write' || tc.name === 'file_edit' || tc.name === 'write' || tc.name === 'edit') {
						try {
							const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
							const filePath = args?.file_path || args?.path || args?.filePath || '';
							isPlanFileWrite = isPlanFilePath(filePath);
						} catch { /* parse failure → not a plan file */ }
					}
					if (isPlanFileWrite) {
						allowedCalls.push(tc);
					} else {
						deniedCalls.push(tc);
					}
				} else {
					allowedCalls.push(tc);
				}
			}
			if (deniedCalls.length > 0) {
				host._logService.info(`[AgentOS] hardPermission blocked ${deniedCalls.length} tool(s) in workMode=${workState.mode}: ${deniedCalls.map((tc: any) => tc.name).join(', ')}`);
				for (const tc of deniedCalls) {
					const blockMsg = `Tool "${tc.name}" is blocked: ${hardPerm.reason}. In plan work mode, you can only read files and write the plan file. Complete the structured plan, then call plan_exit.`;
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
				const filteredCalls = localExecutedCalls.filter(tc => {
					const rawArgs = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
					let args: Record<string, unknown>;
					try { args = JSON.parse(rawArgs) as Record<string, unknown>; } catch { args = {}; }
					const argsHash = JSON.stringify(args ?? {}).slice(0, 200);
					const { loop, count } = detectToolCallLoop(runState.toolCallHistory, tc.name, args);
					// 无论是否 loop，都记录到历史（对齐原内联函数无条件 push）
					runState = reduceRunState(runState, { type: 'RECORD_TOOL_CALL', name: tc.name, argsHash });
					if (loop) {
						host._logService.warn(`[AgentOS] Tool call loop detected: "${tc.name}" called ${count} times with same args — blocking`);
						return false;  // 阻止执行
					}
					return true;
				});
				if (filteredCalls.length < localExecutedCalls.length) {
					// 为被阻止的工具生成错误结果
					const blockedCalls = localExecutedCalls.filter(tc => !filteredCalls.includes(tc));
					for (const tc of blockedCalls) {
						toolResults.push({
							toolCallId: tc.id,
							content: [{ type: 'text', text: `Error: Tool "${tc.name}" was called too many times with the same arguments. This looks like a loop — try a different approach or provide more specific arguments.` }],
							success: false,
						});
						yield { type: 'tool_start', content: '', toolCallId: tc.id, toolName: tc.name };
						yield { type: 'tool_result', content: `工具 "${tc.name}" 因重复调用已被跳过（疑似循环）`, toolCallId: tc.id };
						yield { type: 'tool_end', toolCallId: tc.id, success: false };
						endedToolIds.add(tc.id);
					}
					if (filteredCalls.length === 0) {
						// 全部被阻止 → 跳过执行，直接进入下一轮
						host._logService.warn(`[AgentOS] All ${localExecutedCalls.length} tool calls blocked by loop detection`);
						for (const tr of toolResults) {
							messages = appendMessages(messages, { role: 'tool', content: (tr.content[0] as any)?.text ?? '', toolCallId: tr.toolCallId });
						}
						continue;
					}
					localExecutedCalls = filteredCalls;
				}
				// ── Hook: pre_tool_use ────────────────────────────────────────
				if (memoryProvider?.triggerHook) {
					for (const tc of localExecutedCalls) {
						memoryProvider.triggerHook('pre_tool_use', {
							agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
							toolName: tc.name, toolCallId: tc.id,
						}).catch(() => { });
					}
				}
				// 进入工具执行前显式置 phase=tool_executing（对齐 UI 广播，phase 进 runState 供 checkpoint 读取）
				runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'tool_executing' });
		try {
			// P1: 审批路由上下文（MiMo decideAskRouting）。在工具执行循环所在闭包内派生，
			// 因为 request.subAgent 在该作用域可见；若放在外层块声明则无法穿透到此处（TS2304）。
			const askRouting = deriveAskRoutingContext(request.subAgent, undefined, workState.mode);

			// ─── 工具结果后处理（并行/串行共用，2026-07-27 消除 ~80 行重复）──
			// 从 toolResult 提取公共逻辑：连续失败追踪、terminal 空输出检测、
			// 消息追加、tool_result/tool_end yield。闭包捕获 messages / _toolConsecutiveFailures /
			// _terminalEmptyOutputCount / endedToolIds，返回更新后的 messages。
			function* _processToolResult(toolResult: { toolCallId: string; content: any; success: boolean }, toolName: string): Generator<IChatStreamDelta> {
				if (!toolResult.success) {
					_toolConsecutiveFailures.set(toolName, (_toolConsecutiveFailures.get(toolName) ?? 0) + 1);
					if ((_toolConsecutiveFailures.get(toolName) ?? 0) >= MAX_CONSECUTIVE_TOOL_FAILURES) {
						host._logService.debug(
							`[AgentOS][Diag] Tool "${toolName}" failed ${MAX_CONSECUTIVE_TOOL_FAILURES}+ times consecutively — injecting system-reminder`,
						);
						messages = appendMessages(messages, { role: 'user', content: toolConsecutiveFailureReminder(toolName, MAX_CONSECUTIVE_TOOL_FAILURES) });
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
							_terminalEmptyOutputCount++;
							if (_terminalEmptyOutputCount >= MAX_TERMINAL_EMPTY_OUTPUT) {
								host._logService.debug(
									`[AgentOS][Diag] Terminal returned (no output) ${_terminalEmptyOutputCount} times consecutively — injecting system-reminder`,
								);
								messages = appendMessages(messages, { role: 'user', content: terminalEmptyOutputReminder() });
							}
						} else {
							_terminalEmptyOutputCount = 0;
						}
					}
					// search_graph 引导：结构搜索工具一用即清零；文本搜索连击达到
					// 阈值且结构工具在当前工具面可用时注入一次引导（注入后清零）。
					if (STRUCTURAL_SEARCH_TOOL_NAMES.has(toolName)) {
						_textSearchStreak = 0;
					} else if (TEXT_SEARCH_TOOL_NAMES.has(toolName)) {
						_textSearchStreak++;
						if (_textSearchStreak >= MAX_TEXT_SEARCH_STREAK) {
							const _structuralAvailable = enabledTools
								.filter(t => STRUCTURAL_SEARCH_TOOL_NAMES.has(t.name))
								.map(t => t.name);
							if (_structuralAvailable.length > 0) {
								host._logService.debug(
									`[AgentOS][Diag] text-search streak reached ${MAX_TEXT_SEARCH_STREAK} without structural tools — injecting search_graph guidance`,
								);
								messages = appendMessages(messages, { role: 'user', content: preferGraphSearchReminder(_textSearchStreak, _structuralAvailable.join(', ')) });
								_textSearchStreak = 0;
							}
						}
					}
				}
				const rawStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult(toolResult.content)));
				const resultStr = !toolResult.success
					? appendRecoveryHint(rawStr, toolResult.toolCallId)
					: rawStr;
				messages = appendMessages(messages, {
					role: 'tool',
					content: resultStr,
					toolCallId: toolResult.toolCallId,
				});
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
				const headSerial = await host._executeToolCalls(_headCalls, request.agentId, request.worktreePath, turnAbortSignal, askRouting);
				for (const toolResult of headSerial) {
					const sr = toolResult as unknown as { toolCallId: string; content: any; success: boolean; metadata?: { sandboxViolation?: ISandboxViolationInfo } };
					let finalResult = toolResult;
					if (!sr.success && host._isSandboxViolation(sr) && !handledSandboxIds.has(sr.toolCallId)) {
						handledSandboxIds.add(sr.toolCallId);
						const v = sr.metadata!.sandboxViolation!;
						const tc = localExecutedCalls.find((c: any) => c.id === toolResult.toolCallId);
						const toolName = tc?.name ?? toolResult.toolCallId;
						const confirmationId = `sandbox-${toolResult.toolCallId}-${Date.now().toString(36)}`;
						const cf = host._buildSandboxConfirmationCard(toolName, v);
						cf.id = confirmationId;
						yield { type: 'confirmation', confirmationData: cf };
						const decision = await host._awaitSandboxConfirmation(confirmationId);
						yield {
							type: 'confirmation_resolved',
							confirmationId,
							confirmationStatus: host._mapDecisionToCardStatus(decision),
						};
						if (tc) {
							finalResult = await host._reExecuteAfterSandbox(tc, request.agentId, request.worktreePath, turnAbortSignal, decision, v);
						}
					}
					toolResults.push(finalResult);
					host._observeToolResult(request.agentId, { ...finalResult, toolName: localExecutedCalls.find((c: any) => c.id === finalResult.toolCallId)?.name }, request.sessionId);
					const _hname = localExecutedCalls.find((c: any) => c.id === finalResult.toolCallId)?.name ?? 'unknown';
					yield* _processToolResult(finalResult, _hname);
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
					for await (const toolResult of host._executeToolCallsParallelStreaming(_parallelCalls, request.agentId, request.worktreePath, turnAbortSignal, askRouting)) {
					_executedToolIds.add(toolResult.toolCallId);
					toolResults.push(toolResult);
					// R1: per-tool-call observe (对齐 agentmemory PostToolUse Hook → mem::observe)
					host._observeToolResult(request.agentId, { ...toolResult, toolName: localExecutedCalls.find((c: any) => c.id === toolResult.toolCallId)?.name }, request.sessionId);
							// ── 工具结果后处理（连续失败追踪 + terminal 空输出 + 消息追加 + tool_result/tool_end）──
							const _tname = localExecutedCalls.find((c: any) => c.id === toolResult.toolCallId)?.name ?? 'unknown';
							yield* _processToolResult(toolResult, _tname);
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
						const serial = await host._executeToolCalls(localExecutedCalls, request.agentId, request.worktreePath, turnAbortSignal, askRouting);
						for (const toolResult of serial) {
							// ─── 沙箱确认（完整暂停等待）──────────────────────────
							// 工具因安全沙箱限制失败时，暂停 agent loop，向原生 chat
							// 弹出确认卡片，等待用户决策（允许本次 / 允许此工作区 /
							// 改用建议路径 / 取消），再按决策重执行或保留失败。
							const sr = toolResult as unknown as { toolCallId: string; content: any; success: boolean; metadata?: { sandboxViolation?: ISandboxViolationInfo } };
							let finalResult = toolResult;
							if (!sr.success && host._isSandboxViolation(sr) && !handledSandboxIds.has(sr.toolCallId)) {
								handledSandboxIds.add(sr.toolCallId);
								const v = sr.metadata!.sandboxViolation!;
								const tc = localExecutedCalls.find((c: any) => c.id === toolResult.toolCallId);
								const toolName = tc?.name ?? toolResult.toolCallId;
								const confirmationId = `sandbox-${toolResult.toolCallId}-${Date.now().toString(36)}`;
								const cf = host._buildSandboxConfirmationCard(toolName, v);
								cf.id = confirmationId;
								// 渲染确认卡片（原生 pane 的 _processDelta 处理 confirmation delta）
								yield { type: 'confirmation', confirmationData: cf };
								const decision = await host._awaitSandboxConfirmation(confirmationId);
								yield {
									type: 'confirmation_resolved',
									confirmationId,
									confirmationStatus: host._mapDecisionToCardStatus(decision),
								};
								if (tc) {
									finalResult = await host._reExecuteAfterSandbox(
										tc, request.agentId, request.worktreePath, turnAbortSignal, decision, v,
									);
								}
							}
						toolResults.push(finalResult);
						// R1: per-tool-call observe
						host._observeToolResult(request.agentId, { ...finalResult, toolName: localExecutedCalls.find((c: any) => c.id === finalResult.toolCallId)?.name }, request.sessionId);
							// ── 工具结果后处理（连续失败追踪 + terminal 空输出 + 消息追加 + tool_result/tool_end）──
							const _stname = localExecutedCalls.find((c: any) => c.id === finalResult.toolCallId)?.name ?? 'unknown';
							yield* _processToolResult(finalResult, _stname);
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
						yield { type: 'tool_result', content: resultStr, toolCallId: tc.id };
						yield { type: 'tool_end', toolCallId: tc.id, success: false };
						endedToolIds.add(tc.id);
					}
				}
			} // end if (localExecutedCalls.length > 0)
			const planResult = yield* _handlePlanModeTools(effectiveToolCalls, toolResults, endedToolIds);
			if (planResult === 'done') { return undefined; }
			const postResult = yield* _postIterationCleanup(toolResults, localExecutedCalls, effectiveToolCalls, startedToolIds, endedToolIds, trimmedAssistantContent, memoryProvider, iteration);
			if (postResult === 'done') { break; }
		} // end while

		// ─── 每轮 turn 结束：把本轮新增对话增量外置到记忆（延续检索式上下文，
		// 而非只在压缩时才外置），供后续 turn 检索取回，逐步累积历史上下文。──
		// fire-and-forget：写入供「后续」turn 使用，绝不应阻塞本 turn 收尾——
		// 多迭代 turn（如 22 步子代理）会产生 ~40 条增量消息，串行 await 网关写
		// （IPC 往返 50-500ms/条）会在 turn 末造成数秒~分钟级卡死；网关不可达时
		// 更糟（2026-07-25 日志实证：turn 末 writeMemory 洪泛 300+ 条阻塞收尾）。
		// 注意：storeTurnObservations 内部先 seen.add(hash) 再写，后台写入期间
		// 下一 turn 的 turn-start 外置不会重复写同内容。
		if (RETRIEVAL_COMPACTION_ENABLED) {
			const rpEnd = host.getActiveMemoryProvider();
			if (rpEnd && (rpEnd as any).recallFormatted) {
				void host._storeTurnObservations(rpEnd, request.agentId ?? 'default', request.sessionId ?? '', messages)
					.catch(() => { /* 单条失败已在内部吞掉；此处兜底防 unhandled rejection */ });
			}
		}

		if (iteration >= MAX_TOOL_ITERATIONS) {
			host._logService.warn(`[AgentOS] Reached max tool iterations (${MAX_TOOL_ITERATIONS})`);
			yield { type: 'done' };
		}
	} finally {
		// 注销计划队列句柄（覆盖正常结束/异常/generator return 全部退出路径）。
		_unregisterPlanQueue();
	}
		// 显式 return undefined：generator TReturn = AgentCommand | undefined，
		// 覆盖函数末尾自然结束路径（对齐 TS7030 要求所有路径返回值）。
		return undefined;
	}

