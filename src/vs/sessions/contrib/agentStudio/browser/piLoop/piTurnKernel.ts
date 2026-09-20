/*---------------------------------------------------------------------------------------------
 *  piTurnKernel.ts —— pi 内核的**真路径**轮驱动器（doc/agentloop-pi-core-redesign.md §5 的 P1 门控实现）。
 *
 *  与对拍入口（`hostBridge.installPiLoopDualRunGlobal`）的分工：
 *    · 对拍入口：独立最小链路（只读工具、不写会话）⇒ 验证内核的机械正确性；
 *    · 本驱动器：替换 `executeAgentTurnDirect` 的**内核**（模型流 → 工具执行 → 续跑），
 *      复用 legacy 的前置产物（`initTurnContext`：记忆注入/权限/工具门控都已生效）
 *      与工具执行链（`host._executeToolCalls`：审批/沙箱/图谱副作用全部保留）。
 *
 *  门控（默认 legacy，**双跑为准入**）：
 *    · `window.__SAROSIS_PI_KERNEL = true` 或 env `SAROSIS_PI_KERNEL=1`；
 *    · 不支持的形态**自动回落 legacy**（`piKernelSupports`）：plan 模式 / chatOnly /
 *      断点续跑（resumeFrom）/ 子代理（subAgent，带 softDeadlineMs 语义，pi 路径暂未接）。
 *
 *  ⚠ 已知缺口（翻转默认值前必须补齐或对拍豁免）：
 *    · 不写宿主 runState / checkpoint（断点续跑由 legacy 承担，resumeFrom ⇒ 回落；
 *      压缩段内部的 runState 是驱动器本地划痕，不落盘）；
 *    · `ToolGuardrailController` 的 no-progress 护栏（同签名+同结果）未接 ——
 *      已接的是 detectToolCallLoop（同签名重复 ≥3）+ ping-pong（A⇄B 交替且结果稳定）。
 *  已对齐 legacy 的 parity 项：记忆检索注入（executor:1123-1159）、Dashboard token
 *  计数（executor:1776-1816 口径）、工具循环护栏（executor:2862-2936）、
 *  `_setCurrentModel` 登记（executor:1119）、压缩四级阶梯（parts/turnContextCompaction
 *  同一实现，经 piLoop `transformContext` 缝接入并**写回权威 transcript** —— piLoop
 *  的 transformContext 默认只影响发送副本，而 legacy 压缩改写权威历史，故就地 splice）。
 *
 *  ⚠ 系统提示的送达：piLoop 的 `TranscriptContext` **没有** systemPrompt 通道
 *    （`normalizeTranscript` 只透传 messages）—— 系统提示必须以 `role:'system'` 消息
 *    随种子历史携带。legacy 的 `ctx.messages[0]` 正是它（agentTurnExecutor 在
 *    initTurnContext 里 prepend），故本驱动器**不再**单独设置 `context.systemPrompt`。
 *--------------------------------------------------------------------------------------------*/

import type { ILogService } from '../../../../../platform/log/common/log.js';
import type {
	IAgentTurnRequest,
	IChatStreamDelta,
	IMemoryProvider,
	IModelProvider,
	IModelSelection,
	IToolCall,
	IToolCallInfo,
	IToolDefinition,
} from '../../common/providers.js';
import {
	canonicalToolArgsHash,
	createInitialRunState,
	detectToolCallLoop,
	detectToolCallPingPong,
	hashToolResult,
	reduceRunState,
	RUN_STATE_LIMITS,
	type AgentAction,
	type AgentRunMessage,
} from '../../common/agentRunState.js';
import { classifyPingPong } from '../../common/turnStopGate.js';
import { ContextManager, RETRIEVAL_BUDGET_RATIO, RETRIEVAL_COMPACTION_ENABLED } from '../../common/contextManager.js';
import { buildLoopBlockFeedback } from '../toolCallUtils.js';
import {
	compactContextIfNeededImpl,
	type IContextCompactionDeps,
	type IContextCompactionHost,
	type IContextCompactionManager,
	type IContextCompactionState,
} from '../parts/turnContextCompaction.js';
import { estimateToolsSchemaTokens } from '../parts/turnHelpers.js';
import { runAgentLoop } from './agentLoop.js';
import { createPiStreamFn } from './streamAdapter.js';
import { toAgentTools, type ToolExecutor } from './toolAdapter.js';
import { createPiLoopEventMapper } from './eventAdapter.js';
import { piLoopConvertToLlm } from './hostBridge.js';
import type {
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AssistantContent,
	AssistantMessage,
	Model,
	ToolResultMessage,
} from './types.js';

// ─────────────────────────── 门控 ───────────────────────────

/**
 * pi 内核开关（**默认关** = legacy）。
 * 运行时切换：`window.__SAROSIS_PI_KERNEL = true`（devtools）或 env `SAROSIS_PI_KERNEL=1`。
 * 与 `[MainHeartbeat]`/`[RenderHeartbeat]` 同款运行时门控约定，无需重启 vs 需重启的取舍：
 * 该判定在**每个 turn 开始处**执行 ⇒ devtools 里翻转后立即对下一条消息生效。
 */
export function isPiKernelEnabled(): boolean {
	try {
		if ((globalThis as unknown as Record<string, unknown>)['__SAROSIS_PI_KERNEL'] === true) { return true; }
	} catch { /* ignore */ }
	try {
		const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
		if (proc?.env?.['SAROSIS_PI_KERNEL'] === '1') { return true; }
	} catch { /* ignore */ }
	return false;
}

/** pi 路径当前支持的 turn 形态；不支持 ⇒ 调用方回落 legacy（不报错、不打断）。 */
export function piKernelSupports(request: IAgentTurnRequest): boolean {
	if (request.resumeFrom) { return false; }   // 断点续跑：pi 路径不写/不读 checkpoint
	if (request.chatOnly) { return false; }     // chatOnly 的写工具过滤在门控点之后
	if (request.chatMode === 'plan') { return false; }  // plan 编排（plan_enter/exit）未接
	if (request.subAgent) { return false; }     // 子代理带 softDeadlineMs 超时语义，未接
	return true;
}

// ─────────────────────────── 宿主窄接口 ───────────────────────────

/**
 * 驱动器实际读到的宿主面（沿用 `turnHost.ts`/`turnIterationGate.ts` 的窄接口纪律：
 * 只声明用到的成员）。`host._executeToolCalls` 是 legacy 的工具执行总线 ——
 * 审批 / 沙箱 / 权限 / 图谱副作用全在里面，pi 路径**不重造**。
 */
export interface IPiKernelHost {
	readonly _logService: ILogService;
	readonly _loopAbortController?: AbortController | undefined;
	_executeToolCalls(
		toolCalls: IToolCallInfo[],
		agentId: string,
		worktreePath?: string,
		abortSignal?: AbortSignal,
		askRouting?: unknown,
		agentSessionId?: string,
	): Promise<Array<{ toolCallId: string; content: unknown; success: boolean; metadata?: Record<string, unknown> }>>;
	_observeToolResult?(
		agentId: string,
		toolResult: { toolCallId: string; content: unknown; success: boolean; toolName?: string },
		sessionId?: string,
	): void;

	// ── Dashboard token 计数（executor:1776-1816 同款累加，均见 ITurnHostCounters/Lifecycle）──
	_totalInputTokens: number;
	_totalOutputTokens: number;
	_totalCachedTokens: number;
	readonly _lastRealPromptTokensByAgent: Map<string, number>;
	readonly _lastAssistantAtByAgent: Map<string, number>;
	_turnKey(agentId: string | undefined, sessionId: string | undefined): string;
	_scheduleSave(): void;

	// ── 记忆检索注入（executor:1123-1159 同款 host 方法，见 ITurnHostExecution）──
	getActiveMemoryProvider(): IMemoryProvider | undefined;
	_setCurrentModel(provider: IModelProvider | undefined, modelId: string | undefined): void;
	_resolveContextWindow(provider: IModelProvider, modelId: string): Promise<number>;
	_storeTurnObservations(provider: IMemoryProvider, agentId: string, sessionId: string, messages: ReadonlyArray<unknown>): Promise<void>;
	_retrieveContextOnly(provider: IMemoryProvider, agentId: string, sessionId: string, middle: ReadonlyArray<unknown>, budget: number): Promise<{ context: string; tokens: number; source: string } | null>;
	_injectRetrievalSystemMessage(messages: unknown[], context: string, source: string): unknown[];

	// ── 压缩段（parts/turnContextCompaction 的 IContextCompactionHost 面）──
	_estimateMessagesTokens(messages: readonly unknown[]): number;
	_lastCompressionTime: number;
	_lastHardPruneBaselineTokens: number;
	_compressionCount: number;
	_compressionIneffectiveCount: number;
	_compressionBeforeTokens: number;
	_compressionAfterTokens: number;
	readonly _currentWorkspaceId: string | undefined;
	_retrieveCompactionContext(provider: IMemoryProvider, req: unknown): Promise<unknown>;
}

/** 一轮 turn 的前置产物（由 `initTurnContext` + executor 的工具门控产出）。 */
export interface PiKernelTurnDeps {
	readonly modelProvider: IModelProvider;
	readonly selection: IModelSelection;
	/** ⚠ 必须是 executor 过滤后的最终工具列表（plan-exclusive/chatOnly 门控已应用）。 */
	readonly enabledTools: readonly IToolDefinition[];
	/** 种子历史（含首条 `role:'system'` 的冻结前缀；形状 = legacy 循环消息）。 */
	readonly messages: readonly AgentRunMessage[];
	/** 压缩管理器工厂（默认 `new ContextManager(provider, modelId)`；测试注入 mock）。 */
	readonly contextManagerFactory?: () => IContextCompactionManager;
}

// ─────────────────────────── 主驱动 ───────────────────────────

/**
 * 用 piLoop 内核驱动一个 turn，产出与 legacy `executeAgentTurnDirect` **同一契约**的
 * `IChatStreamDelta` 流（UI/会话/审批零改动）。
 *
 * 实现要点：`runAgentLoop` 是 Promise + emit sink 风格，本函数用「缓冲 + 唤醒」桥成
 * async generator —— delta 随 emit 即时产出（流式 UI 不降级），loop 终结后退出。
 */
export async function* runPiKernelTurn(
	host: IPiKernelHost,
	request: IAgentTurnRequest,
	deps: PiKernelTurnDeps,
): AsyncGenerator<IChatStreamDelta, void> {
	const t0 = Date.now();
	const agentId = request.agentId ?? '';
	host._logService.info(
		`[PiKernel] turn 开始：agentId=${agentId} model=${deps.selection.modelId} ` +
		`tools=${deps.enabledTools.length} seed=${deps.messages.length}`,
	);

	// ── parity（executor:1119）：登记当前模型，供宿主实时查表上下文窗口 ──
	host._setCurrentModel(deps.modelProvider, deps.selection.modelId);

	// ── 记忆检索注入（与 executor:1123-1159 同一语义、同一批 host 方法）──────────
	// 在 **legacy 形状**的种子上操作（_retrieveContextOnly/_injectRetrievalSystemMessage
	// 都吃 legacy 消息），注入完成后再转 pi 形状。默认开启（AGENT_OS_RETRIEVAL_COMPACTION=0 关）。
	let seedMessages: readonly AgentRunMessage[] = deps.messages;
	if (RETRIEVAL_COMPACTION_ENABLED) {
		const rp = host.getActiveMemoryProvider();
		if (rp && typeof (rp as { recallFormatted?: unknown }).recallFormatted === 'function') {
			const retrievalAgentId = agentId || 'default';
			const retrievalSessionId = request.sessionId ?? '';
			// 与 legacy 相同：先亮「正在检索历史上下文」（32s 静默的教训，executor:1131）
			yield { type: 'phase_change', phase: 'retrieving' } as IChatStreamDelta;
			try {
				await host._storeTurnObservations(rp, retrievalAgentId, retrievalSessionId, seedMessages);
				const contextWindow = await host._resolveContextWindow(deps.modelProvider, deps.selection.modelId);
				const r = await host._retrieveContextOnly(rp, retrievalAgentId, retrievalSessionId, seedMessages, Math.floor(contextWindow * RETRIEVAL_BUDGET_RATIO));
				if (r && r.context.trim()) {
					seedMessages = host._injectRetrievalSystemMessage([...seedMessages], r.context, r.source) as AgentRunMessage[];
					host._logService.info(`[PiKernel][Retrieval] injected retrieved context at turn start (source=${r.source}, ~${Math.ceil(r.context.length / 3)} tokens)`);
					yield { type: 'memory_injected', content: `已检索注入历史上下文 (~${Math.ceil(r.context.length / 3)} tokens)` } as IChatStreamDelta;
				}
			} catch (err) {
				host._logService.warn(`[PiKernel][Retrieval] 检索注入失败（继续本轮）：${err instanceof Error ? err.message : String(err)}`);
			}
			yield { type: 'phase_change', phase: 'llm_streaming' } as IChatStreamDelta;
		}
	}

	const model = { id: deps.selection.modelId, name: deps.selection.modelId, api: 'openai-completions', provider: 'saros' } as unknown as Model;

	// ── 压缩段（四级阶梯，复用 parts/turnContextCompaction 的同一实现）──────────────
	// 缝在 piLoop `transformContext`（每次模型请求前，对齐 legacy 的每迭代开头调用点
	// executor:1367）。形态差：压缩模块吃 **legacy 形状**消息 ⇒ pi→legacy 转换 ⇒ 压缩 ⇒
	// legacy→pi 回转，且**写回权威 transcript** —— piLoop 的 transformContext 默认只影响
	// 发送副本，而 legacy 压缩改写权威历史 ⇒ 就地 splice（保持数组引用，loop 后续 push 的
	// assistant/toolResult 落在压缩后的历史上）。
	const compressionWindow = await host._resolveContextWindow(deps.modelProvider, deps.selection.modelId);
	let contextManager: IContextCompactionManager;
	if (deps.contextManagerFactory) {
		contextManager = deps.contextManagerFactory();
	} else {
		const cm = new ContextManager(deps.modelProvider, deps.selection.modelId);
		cm.setLogger({
			info: (msg: string) => host._logService.info(msg),
			warn: (msg: string) => host._logService.warn(msg),
			error: (msg: string, error?: unknown) => host._logService.error(msg, error),
			debug: (msg: string) => host._logService.debug(msg),
		});
		contextManager = cm;
	}
	// 本地 runState 划痕：pi 路径不挂宿主 runState；本对象只承担压缩段读取的
	// lastRealPromptTokens（真实值由 accumulateUsage 在每轮 message_end 回填）与 phase。
	let compactionRunState = createInitialRunState({
		lastRealPromptTokens: host._lastRealPromptTokensByAgent.get(host._turnKey(request.agentId, request.sessionId)) ?? 0,
	});
	const dispatchCompactionRunState = (action: AgentAction): void => { compactionRunState = reduceRunState(compactionRunState, action); };
	let hardPrunePending = false;
	const compactionDeps: IContextCompactionDeps = {
		host: host as unknown as IContextCompactionHost,
		request,
		contextManager,
		compressionWindow,
		enabledTools: () => deps.enabledTools,
		estimateToolsSchemaTokens,
	};

	const guardrails = makeGuardrailHooks(host);
	const context = {
		messages: loopMessagesToPiMessages(seedMessages),
		systemPrompt: '', // 见文件头：system 由种子历史携带，此字段在 piLoop 中无通道
		tools: toAgentTools(deps.enabledTools, makeHostToolExecutor(host, request)),
	};
	const config: AgentLoopConfig = {
		model,
		convertToLlm: piLoopConvertToLlm,
		// 迭代上限与 legacy 对齐（100）—— 护栏（beforeToolCall）之外的失控保险丝。
		maxTurns: RUN_STATE_LIMITS.MAX_TOOL_ITERATIONS,
		// 工具护栏（对齐 executor:2862-2936）：同签名重复 + ping-pong 交替 ⇒ 拦。
		beforeToolCall: guardrails.beforeToolCall,
		afterToolCall: guardrails.afterToolCall,
		transformContext: async (piMessages, _signal) => {
			let legacy = piMessagesToLoopMessages(piMessages);
			const state: IContextCompactionState = {
				messages: () => legacy,
				setMessages: next => { legacy = next; },
				// pi 路径的权威历史是 transcript 本身；runState.messages 在本路径无人读 ⇒ 无需同步
				syncMessages: () => { /* no-op（见上） */ },
				runState: () => compactionRunState,
				dispatchRunState: dispatchCompactionRunState,
				hardPrunePending: () => hardPrunePending,
				setHardPrunePending: next => { hardPrunePending = next; },
			};
			try {
				// emit 桥：压缩段的 phase_change / context_compacted 即时进 pending ——
				// transformContext 被 loop await，事件先于下一次模型请求上屏（背压兼容）。
				await compactContextIfNeededImpl(async delta => { pending.push(delta); notify(); }, compactionDeps, state);
			} catch (err) {
				host._logService.warn(`[PiKernel][Compaction] 压缩段异常（本轮按未压缩继续）：${err instanceof Error ? err.message : String(err)}`);
			}
			const compacted = loopMessagesToPiMessages(legacy);
			context.messages.splice(0, context.messages.length, ...compacted);
			return compacted;
		},
	};

	const mapEvent = createPiLoopEventMapper();
	const pending: IChatStreamDelta[] = [];
	let wake: (() => void) | undefined;
	const notify = (): void => { const w = wake; wake = undefined; w?.(); };
	const emit = async (event: AgentEvent): Promise<void> => {
		// Dashboard token 计数（executor:1776-1816 同款口径）：message_end 携带终态 usage。
		if (event.type === 'message_end') {
			accumulateUsage(host, request, (event as { message?: AssistantMessage }).message, dispatchCompactionRunState);
		}
		for (const delta of mapEvent(event)) { pending.push(delta); }
		notify();
	};

	let loopError: unknown;
	let loopSettled = false;
	const done = runAgentLoop(
		[], // prompts 为空：用户消息已在种子历史里（initTurnContext 已注入）
		context,
		config,
		emit,
		host._loopAbortController?.signal,
		createPiStreamFn(deps.modelProvider, { modelId: deps.selection.modelId }),
	).then(
		() => { loopSettled = true; notify(); },
		(err: unknown) => { loopError = err; loopSettled = true; notify(); },
	);

	// 单线程保证：`if (loopSettled) break` 与 `wake = resolve` 之间无交错窗口。
	while (!loopSettled || pending.length > 0) {
		while (pending.length > 0) { yield pending.shift()!; }
		if (loopSettled) { break; }
		await new Promise<void>(resolve => { wake = resolve; });
	}
	await done;
	if (loopError !== undefined && loopError !== null) { throw loopError; }
	host._logService.info(`[PiKernel] turn 完成（${Date.now() - t0}ms）`);
}

// ─────────────────────────── 种子历史转换 ───────────────────────────

/**
 * legacy 循环消息（`{role, content, reasoning?, toolCalls?}` / `{role:'tool', content, toolCallId}`）
 * → piLoop `AgentMessage[]`。
 *
 * 与 `hostBridge.chatMessagesToPiMessages` 的差别：那个吃 **UI 消息**（`IAgentChatMessage`，
 * `toolCalls[].result` 内嵌），这个吃**循环消息**（tool 结果独立成条、靠 `toolCallId` 回挂）。
 * toolResult 的 `toolName` 由前文 assistant 的 toolCalls 按 id 反查（legacy tool 消息不存名字）。
 * 孤儿 tool 消息（无 toolCallId）丢弃 —— 留着会在下一轮请求构成协议错误（executor:2242 同款教训）。
 */
export function loopMessagesToPiMessages(messages: readonly AgentRunMessage[]): AgentMessage[] {
	const toolNameById = new Map<string, string>();
	const out: AgentMessage[] = [];
	for (const m of messages) {
		if (!m || typeof m !== 'object') { continue; }
		const role = m.role;
		if (role === 'user' || role === 'system') {
			out.push({ role, content: asText(m.content), timestamp: Date.now() } as unknown as AgentMessage);
			continue;
		}
		if (role === 'assistant') {
			const content: AssistantContent[] = [];
			const reasoning = m['reasoning'];
			if (typeof reasoning === 'string' && reasoning) { content.push({ type: 'thinking', thinking: reasoning }); }
			const text = asText(m.content);
			if (text) { content.push({ type: 'text', text }); }
			const calls = m['toolCalls'];
			let callCount = 0;
			if (Array.isArray(calls)) {
				for (const raw of calls) {
					const tc = raw as { id?: unknown; name?: unknown; arguments?: unknown };
					const id = typeof tc?.id === 'string' ? tc.id : '';
					const name = typeof tc?.name === 'string' ? tc.name : '';
					if (!id || !name) { continue; }
					toolNameById.set(id, name);
					content.push({ type: 'toolCall', id, name, arguments: parseArgs(tc.arguments) });
					callCount++;
				}
			}
			out.push({
				role: 'assistant', content,
				stopReason: callCount > 0 ? 'toolUse' : 'stop',
			} as unknown as AssistantMessage as AgentMessage);
			continue;
		}
		if (role === 'tool') {
			const toolCallId = typeof m['toolCallId'] === 'string' ? m['toolCallId'] as string : '';
			if (!toolCallId) { continue; }
			out.push({
				role: 'toolResult', toolCallId,
				toolName: toolNameById.get(toolCallId) ?? 'unknown',
				content: [{ type: 'text', text: asText(m.content) }],
				isError: false, timestamp: Date.now(),
			} as ToolResultMessage as unknown as AgentMessage);
		}
	}
	return out;
}

/**
 * `loopMessagesToPiMessages` 的**逆转换**（pi → legacy）—— 压缩段的输入缝。
 *
 * 保真边界（压缩关注的字段全保真）：role / content 文本 / reasoning / toolCalls
 * （arguments 回 JSON 字符串）/ toolCallId。丢弃：timestamp / usage / stopReason /
 * toolResult 的 toolName（legacy tool 消息本就不存名字）与 isError、pi 自定义消息
 * （不进 LLM 的 UI-only 条目，`piLoopConvertToLlm` 同样过滤它们 ⇒ 口径一致）。
 */
export function piMessagesToLoopMessages(messages: readonly AgentMessage[]): AgentRunMessage[] {
	const out: AgentRunMessage[] = [];
	for (const m of messages) {
		if (!m || typeof m !== 'object') { continue; }
		const role = (m as { role?: unknown }).role;
		if (role === 'user' || role === 'system') {
			out.push({ role, content: asText((m as { content?: unknown }).content) });
			continue;
		}
		if (role === 'assistant') {
			const msg: AgentRunMessage = { role: 'assistant', content: '' };
			const texts: string[] = [];
			const thinkings: string[] = [];
			const toolCalls: IToolCallInfo[] = [];
			const content = (m as { content?: unknown }).content;
			if (typeof content === 'string') {
				texts.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content as Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }>) {
					if (block?.type === 'text' && typeof block.text === 'string') { texts.push(block.text); }
					else if (block?.type === 'thinking' && typeof block.thinking === 'string') { thinkings.push(block.thinking); }
					else if (block?.type === 'toolCall' && block.id && block.name) {
						toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.arguments ?? {}) });
					}
				}
			}
			msg.content = texts.join('');
			if (thinkings.length > 0) { msg['reasoning'] = thinkings.join(''); }
			if (toolCalls.length > 0) { msg['toolCalls'] = toolCalls; }
			out.push(msg);
			continue;
		}
		if (role === 'toolResult') {
			const tr = m as { toolCallId?: unknown; content?: unknown };
			const toolCallId = typeof tr.toolCallId === 'string' ? tr.toolCallId : '';
			if (!toolCallId) { continue; }
			out.push({ role: 'tool', content: asText(tr.content), toolCallId });
		}
		// 其余 role（customMessage 等 UI-only 条目）：与 piLoopConvertToLlm 同口径丢弃
	}
	return out;
}

// ─────────────────────────── 内部小件 ───────────────────────────

/** 把 piLoop 的工具调用路由进 legacy 工具执行总线（审批/沙箱/副作用全保留）。 */
function makeHostToolExecutor(host: IPiKernelHost, request: IAgentTurnRequest): ToolExecutor {
	let fallbackSeq = 0;
	return async (toolCall: IToolCall, signal, _onProgress) => {
		// IToolCall.arguments 是已解析对象；legacy 总线的 IToolCallInfo.arguments 是 JSON 字符串。
		const info: IToolCallInfo = {
			id: toolCall.id || `pi-call-${Date.now()}-${++fallbackSeq}`,
			name: toolCall.name,
			arguments: typeof toolCall.arguments === 'string'
				? toolCall.arguments
				: JSON.stringify(toolCall.arguments ?? {}),
		};
		let results;
		try {
			results = await host._executeToolCalls([info], request.agentId ?? '', undefined, signal, undefined, request.sessionId);
		} catch (err) {
			// 不抛回内核：编码为错误工具结果，让模型看到失败并自行恢复（与 legacy 一致）。
			return { content: `工具执行异常: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
		const r = results?.[0];
		if (!r) { return { content: '工具执行无结果（宿主返回空数组）', isError: true }; }
		try {
			host._observeToolResult?.(request.agentId ?? '', { toolCallId: r.toolCallId, content: r.content, success: r.success, toolName: toolCall.name }, request.sessionId);
		} catch { /* 观察副作用失败不影响主流程 */ }
		return { content: toolResultToText(r.content), isError: !r.success };
	};
}

/**
 * Dashboard token 计数（executor:1776-1816 同款口径）—— 每条 assistant 终态消息结算一次。
 * OpenAI 系 inputTokens 已含 cache；Anthropic 系不含 ⇒ `input >= cached` 判定归一。
 * （piLoop `Usage` 暂无 cacheWrite 字段；若将来补齐，应计入 cacheSum。）
 */
function accumulateUsage(
	host: IPiKernelHost,
	request: IAgentTurnRequest,
	message: AssistantMessage | undefined,
	dispatchRunState?: (action: AgentAction) => void,
): void {
	const u = message?.usage;
	if (!u) { return; }
	const cached = u.cacheRead ?? 0;
	const input = u.input ?? 0;
	const realPrompt = input >= cached ? input : input + cached;
	if (realPrompt > 0) {
		const key = host._turnKey(request.agentId, request.sessionId);
		host._lastRealPromptTokensByAgent.set(key, realPrompt);
		host._lastAssistantAtByAgent.set(key, Date.now());
		// 压缩段的压力判定以它为唯一真实来源（executor:592 的 runState.lastRealPromptTokens）
		dispatchRunState?.({ type: 'SET_LAST_PROMPT_TOKENS', value: realPrompt });
	}
	host._totalInputTokens += input;
	host._totalOutputTokens += u.output ?? 0;
	host._totalCachedTokens += cached;
	host._scheduleSave();
}

/**
 * 工具护栏钩子（对齐 executor:2862-2936）：
 *   · `detectToolCallLoop` —— 同签名（name+argsHash）在历史中已出现 ≥3 次 ⇒ 拦（第 4 次起）；
 *   · `detectToolCallPingPong` + `classifyPingPong` —— A⇄B 交替且两侧结果稳定 ⇒ 拦；
 *   · 拦截文案复用 `buildLoopBlockFeedback`（与 legacy 逐字一致）；
 *   · piLoop 的 `blocked` 语义 = 跳过执行并合成错误结果（与 legacy 的合成失败结果同构）。
 * 历史保存在驱动器本地（pi 路径不挂 runState）；resultHash 在 afterToolCall 回填
 * （对齐 RECORD_TOOL_RESULT，供 ping-pong 的 noProgressEvidence）。
 * ⚠ 未接 `ToolGuardrailController` 的 no-progress 护栏 —— 见文件头缺口清单。
 */
function makeGuardrailHooks(host: IPiKernelHost): {
	beforeToolCall: NonNullable<AgentLoopConfig['beforeToolCall']>;
	afterToolCall: NonNullable<AgentLoopConfig['afterToolCall']>;
} {
	const history: Array<{ name: string; argsHash: string; resultHash?: string }> = [];
	return {
		beforeToolCall: ({ toolCall, args }) => {
			const name = toolCall.name;
			const safeArgs = args ?? {};
			const pp = detectToolCallPingPong(history);
			const verdict = classifyPingPong(pp.pingPong, pp.noProgressEvidence);
			if (verdict.kind === 'block-batch') {
				host._logService.warn(
					`[PiKernel] Ping-pong loop: ${pp.toolA} <-> ${pp.toolB} ` +
					`(${pp.length} alternating calls, stable results both sides) — blocking`,
				);
				return {
					kind: 'blocked',
					reason: `Blocked: ping-pong loop between "${pp.toolA}" and "${pp.toolB}" (${pp.length} alternating calls) with identical results on both sides. Switching between these two calls is making no progress — the information you need is not here. Use a different tool or a different approach, or proceed with the results you already have.`,
				};
			}
			// 与 legacy 同序：先判定（历史不含本次），再无条件记录（executor:2917/2925）
			const { loop, count } = detectToolCallLoop(history, name, safeArgs);
			history.push({ name, argsHash: canonicalToolArgsHash(safeArgs) });
			if (loop) {
				host._logService.warn(`[PiKernel] Tool call loop detected: "${name}" called ${count} times with same args — blocking`);
				return { kind: 'blocked', reason: buildLoopBlockFeedback(name, JSON.stringify(safeArgs)) };
			}
			return { kind: 'allow' };
		},
		afterToolCall: ({ toolCall, result }) => {
			// 回填 resultHash（对齐 RECORD_TOOL_RESULT；ping-pong 的 noProgressEvidence 依赖它）
			for (let i = history.length - 1; i >= 0; i--) {
				const entry = history[i]!;
				if (entry.name === toolCall.name && entry.resultHash === undefined) {
					history[i] = { ...entry, resultHash: hashToolResult(toolResultToText((result as { content?: unknown }).content)) };
					break;
				}
			}
			return { kind: 'keep' };
		},
	};
}

/** 宿主工具结果（string / 内容块数组 / 任意对象）→ 供 LLM 消费的纯文本。 */
function toolResultToText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		const parts = content.map(b =>
			typeof b === 'string' ? b
				: (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') ? (b as { text: string }).text
					: '',
		).filter(Boolean);
		if (parts.length > 0) { return parts.join('\n'); }
	}
	if (content === undefined || content === null) { return ''; }
	try { return JSON.stringify(content); } catch { return String(content); }
}

/** 消息 content（string / 内容块数组）→ 纯文本。 */
function asText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content.map(b =>
			typeof b === 'string' ? b
				: (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') ? (b as { text: string }).text
					: '',
		).join('');
	}
	return content === undefined || content === null ? '' : String(content);
}

/** 工具参数（JSON 字符串或已解析对象）→ 对象；失败降级空对象。 */
function parseArgs(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) { return raw as Record<string, unknown>; }
	if (typeof raw !== 'string' || !raw) { return {}; }
	try {
		const v: unknown = JSON.parse(raw);
		return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
	} catch { return {}; }
}
