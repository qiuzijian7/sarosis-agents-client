/*---------------------------------------------------------------------------------------------
 *  AgentOS — AgentRunState（LangGraph 对齐的 state-schema + channel reducer）
 *
 *  本模块是「reducer 化」改造（见 doc/agentos-reducer-design.md）的 Step 1：
 *  - 纯类型 + 纯 reducer 函数 + 初始 state 工厂 + 控制逻辑纯函数
 *  - 零运行时副作用、零行为变更，可独立编译与单测
 *  - 后续 Step 2~4 才接入 agentOSService.ts 的 loop；Step 5 才接 checkpoint
 *
 *  设计原则（对齐 LangGraph）：
 *  - AgentRunState 是一个纯 JSON 可序列化对象（无函数 / 类实例），便于 snapshot/restore。
 *  - 每个 channel 的合并语义由纯 reducer 表达；reduceRunState 整体不可变（返回新对象）。
 *  - 流式累加缓冲（_assistantChunks 等）刻意**不**纳入 state，保持原样。
 *--------------------------------------------------------------------------------------------*/

import { StreamPhase } from './providers.js';
import { AgentGraph, createInitialGraphRunState } from './agentGraph.js';
import { AgentWorkState, AgentWorkEvent, createInitialWorkState, reduceWorkState } from './workMode.js';
import type { BudgetSnapshot } from './iterationBudget.js';
import type { AgentParadigm } from './agentLoopStrategy.js';

/** 全部受支持的 agent 范式（用于 checkpoint 恢复的范式校验，避免范式漂移 R3）。 */
const KNOWN_PARADIGMS: readonly AgentParadigm[] = [
	'budgeted-react',
	'plan-explore',
	'react',
	'readonly',
	'delegation',
	'graph',
	'mimo',
];


// ─── 消息类型 ──────────────────────────────────────────────────────
// 与 loop 内现有 `messages: any[]` 兼容；用宽松结构而非 IChatMessage，
// 避免与既有合成消息（带额外字段）耦合，也便于 Step 2 直接传入现有数组。
export type AgentRunMessage = {
	role: string;
	content?: unknown;
	[key: string]: unknown;
};

// ─── 可复用阈值（对齐 agentOSService.ts loop 内现有本地常量）─────────
// 集中导出，避免 Step 2/3 接入时与 loop 内字面量漂移。
export const RUN_STATE_LIMITS = {
	/** 单 turn 最大工具迭代次数（loop 内 MAX_TOOL_ITERATIONS） */
	MAX_TOOL_ITERATIONS: 50,
	/** 工具循环检测窗口（loop 内 TOOL_LOOP_WINDOW） */
	TOOL_LOOP_WINDOW: 10,
	/** 工具循环检测阈值（loop 内 TOOL_LOOP_THRESHOLD） */
	TOOL_LOOP_THRESHOLD: 3,
	/** 反思阶段最大次数（loop 内 MAX_REFLECT_ITERATIONS） */
	MAX_REFLECT_ITERATIONS: 1,
} as const;

/** AgentOS reducer 化灰度开关默认值（Step 4）。
 * 当前已全量落地 reducer 路径（Step 1~3 把 messages 写入与控制变量全部收口进 reduceRunState），
 * 故默认 'reducer'。回滚 = 翻此常量回 'legacy' 并恢复对应 legacy 代码
 * （legacy 路径已在 Step 2/3 收口后移除，仅留此开关位作为可观测 / 回滚锚点）。
 * 未来若需 per-session 覆盖，可在 IAgentTurnRequest 增加 reducerMode 字段并经此透传。 */
export const AGENT_OS_DEFAULT_REDUCER_MODE: 'legacy' | 'reducer' = 'reducer';

/** 文件修改类工具名集合（loop 内 FILE_MODIFICATION_TOOLS，触发反思阶段） */
export const FILE_MODIFICATION_TOOLS = new Set([
	'file_write', 'write_to_file', 'replace_in_file', 'edit_file', 'delete_file',
]);

// ─── Graph 子状态（supervisor / AgentCommand(goto) 设计，Step A）─────
// 多 agent 图运行时把"当前节点 / 各节点消息线程 / 共享黑板 / handoff 摘要 /
// 节点状态"统一收进 AgentRunState，使整图可被 Step 5 snapshot/restore 序列化。
// 单 agent 模式 graph 为 undefined，loop 不派发下列 action（保持零行为变更）。
export type AgentGraphNodeExecutionStatus = 'pending' | 'running' | 'done' | 'error';

export interface AgentGraphRunState {
	/** 当前所在节点 id（单 agent 模式为 undefined） */
	currentNodeId?: string;
	/** 各节点已运行的消息线程（节点退出时落地，进入时加载），key=nodeId */
	nodeThreads: Record<string, AgentRunMessage[]>;
	/** 跨节点共享黑板（等价 WorkflowExecutionService.sharedMemory） */
	sharedMemory: Record<string, unknown>;
	/** 最近一次 handoff 摘要（进入下一节点的首条上下文） */
	handoffSummary?: string;
	/** 节点执行状态（供 UI / resume 读取） */
	nodeStatus: Record<string, AgentGraphNodeExecutionStatus>;
}

// ─── State schema ──────────────────────────────────────────────────
export interface AgentRunState {
	/** 主对话线程（reducer: append / compact） */
	messages: AgentRunMessage[];
	/** 当前迭代计数（从 0 开始，每次 BUMP_ITERATION +1） */
	iteration: number;
	/** 显式阶段机（对齐 providers.ts StreamPhase；loop 内部与 UI 广播同源） */
	phase: StreamPhase;
	/** 非法工具名尝试次数（invalid-tool 熔断） */
	invalidToolNameCount: number;
	/** 反思阶段已触发次数 */
	reflectCount: number;
	/** 是否执行过文件修改类工具（触发反思的前提） */
	hasModifiedFiles: boolean;
	/** 工具调用签名历史（带窗口裁剪，用于循环检测） */
	toolCallHistory: ReadonlyArray<{ name: string; argsHash: string }>;
	/** 已发起但未结束的工具调用 id（孤儿对账） */
	startedToolIds: string[];
	/** 已结束的工具调用 id（孤儿对账） */
	endedToolIds: string[];
	/** 上一轮真实 prompt token（跨 turn 持久化的压缩判定依据） */
	lastRealPromptTokens: number;
	/** 灰度模式标记 */
	reducerMode: 'legacy' | 'reducer';
	/** ChatMode-independent mutable plan/work runtime state. */
	work: AgentWorkState;
	/** 多 agent 图运行时子状态（supervisor / AgentCommand(goto)）。单 agent 为 undefined。 */
	graph?: AgentGraphRunState;
	// ─── V3: 单 agent 断点续跑 ──────────────────────────────────────
	/** IterationBudget 快照（resume 时用于重建预算实例，直接对齐 BudgetSnapshot） */
	budgetSnapshot?: BudgetSnapshot;
	/** pre-explore 是否已完成（resume 时跳过 preLoop） */
	preExploreDone: boolean;
	/** pre-explore 结果文本（resume 时回填 messages） */
	preExploreResult?: string;
	/** 循环快照时 messages 数组的完整副本（resume 时作为初始 messages） */
	loopMessages?: AgentRunMessage[];
	/** V3: 本次运行使用的范式（resume 时据此重建同一策略，避免范式漂移 R3） */
	paradigm?: AgentParadigm;
}

// ─── Action（动作联合类型）─────────────────────────────────────────
export type AgentAction =
	| { type: 'APPEND_MESSAGES'; messages: AgentRunMessage[] }
	| { type: 'COMPACT_MESSAGES'; messages: AgentRunMessage[] }
	| { type: 'BUMP_ITERATION'; by?: number }
	| { type: 'SET_PHASE'; phase: StreamPhase }
	| { type: 'RECORD_TOOL_CALL'; name: string; argsHash: string }
	| { type: 'RECONCILE_ORPHANS'; endedIds: string[] }
	| { type: 'INVALID_TOOL_NAME' }
	| { type: 'REFLECT' }
	| { type: 'SET_LAST_PROMPT_TOKENS'; value: number }
	| { type: 'MARK_FILE_MODIFIED' }
	| { type: 'WORK_EVENT'; event: AgentWorkEvent }
	// ─── V3: 单 agent 断点续跑 ────────────────────────────────────
	| { type: 'SAVE_BUDGET'; snapshot: BudgetSnapshot }
	| { type: 'SET_PRE_EXPLORE'; done: boolean; result?: string }
	| { type: 'SET_LOOP_MESSAGES'; messages: AgentRunMessage[] }
	| { type: 'SET_PARADIGM'; paradigm: AgentParadigm }
	// ─── 图运行时 action（supervisor / AgentCommand(goto)，Step A）───
	| { type: 'ENTER_NODE'; nodeId: string }
	| { type: 'EXIT_NODE'; nodeId: string; messages: AgentRunMessage[] }
	| { type: 'SET_NODE_STATUS'; nodeId: string; status: AgentGraphNodeExecutionStatus }
	| { type: 'WRITE_SHARED_MEMORY'; patch: Record<string, unknown> }
	| { type: 'SET_HANDOFF'; summary?: string }
	/** 路由后更新当前节点 id（Step D checkpoint/resume：落盘续跑点） */
	| { type: 'SET_CURRENT_NODE'; nodeId: string };

// ─── 初始 state 工厂 ───────────────────────────────────────────────
export interface CreateInitialRunStateRequest {
	readonly systemPrompt?: string;
	/** 主线程消息（可选）。Step 3 起由 loop 局部 `let messages` 管理、Step 5 才并入 state；
	 *  此处保留 messages 字段仅为 state schema 完整，loop 当前传空数组。 */
	readonly messages?: ReadonlyArray<AgentRunMessage>;
	/** 跨 turn 持久化的上一轮真实 prompt token（可选，默认 0） */
	readonly lastRealPromptTokens?: number;
	readonly reducerMode?: 'legacy' | 'reducer';
	readonly workState?: AgentWorkState;
	/** 多 agent 图运行时初始子状态（可选：图模式由 Step C 解释器注入，单 agent 省略 → undefined） */
	readonly graphRunState?: AgentGraphRunState;
	/** V3: 本次运行使用的范式（可选，落盘续跑时重建同一策略） */
	readonly paradigm?: AgentParadigm;
}

export function createInitialRunState(request: CreateInitialRunStateRequest): AgentRunState {
	const seed: AgentRunMessage[] = [];
	if (request.systemPrompt) {
		seed.push({ role: 'system', content: request.systemPrompt });
	}
	seed.push(...(request.messages ?? []));

	return {
		messages: seed,
		iteration: 0,
		phase: 'idle',
		invalidToolNameCount: 0,
		reflectCount: 0,
		hasModifiedFiles: false,
		toolCallHistory: [],
		startedToolIds: [],
		endedToolIds: [],
		lastRealPromptTokens: request.lastRealPromptTokens ?? 0,
		reducerMode: request.reducerMode ?? AGENT_OS_DEFAULT_REDUCER_MODE,
		work: request.workState ?? createInitialWorkState(),
		graph: request.graphRunState,
		// V3 defaults
		budgetSnapshot: undefined,
		preExploreDone: false,
		preExploreResult: undefined,
		loopMessages: undefined,
		paradigm: request.paradigm,

	};
}

// ─── Channel reducers（纯函数，不可变）──────────────────────────────

/** messages append（对齐 LangGraph addMessages） */
export function appendMessages(prev: AgentRunMessage[], ...added: AgentRunMessage[]): AgentRunMessage[] {
	return [...prev, ...added];
}

/** messages 指定位置插入（对齐 loop 内 memory / durable-context 注入的 splice） */
export function insertMessages(
	prev: AgentRunMessage[],
	at: number,
	...inserted: AgentRunMessage[]
): AgentRunMessage[] {
	const idx = Math.max(0, Math.min(at, prev.length));
	return [...prev.slice(0, idx), ...inserted, ...prev.slice(idx)];
}

/** messages 压缩替换（纯换底，保留不可变语义） */
export function compactMessages(_prev: AgentRunMessage[], compressed: AgentRunMessage[]): AgentRunMessage[] {
	return [...compressed];
}

/**
 * 注入顺序约定（canonical injection order，保障 system 前缀字节稳定 → provider prompt cache 命中）：
 *   ① frozen prefix（stable + context）        → 第 1 条 system 消息（不可变，进缓存前缀）
 *   ② volatile（Persona Memory + 激活技能）      → 第 2 条独立 system 消息（每轮可变，不进前缀指纹）
 *   ③ Agent Memory `<agentmemory-context>`      → system 消息（session 级幂等，injectedSessions）
 *   ④ Retrieval `## Preserved Context`          → system 消息（INJECTED_CONTEXT_PREFIX，压缩按前缀剥离）
 *   ⑤ Durable Context `<durable_context_data>`  → system 消息（checkpoint 持久化）
 *   ⑥ 策略 reminder / TaskGate nudge / 反思 / 计划提醒 / 技能激活 → user 角色 synthetic sidecar
 *        （仅存在于发送副本，压缩与持久化前由 stripSyntheticSidecars 剥离，不污染干净 transcript）
 * 设计对齐 Hermes 的 `api_content` sidecar（干净 transcript 永不改写）与 MiMo-Code 的 `synthetic: true`。
 */
/**
 * 剥离 synthetic sidecar 消息（技能/策略/控制流临时注入），用于压缩与持久化前清理，
 * 避免污染干净 transcript（对齐 Hermes api_content / MiMo synthetic:true）。
 * 仅移除标记为 synthetic 的消息；memory/durable/retrieval 等未标记，不受影响。
 */
export function stripSyntheticSidecars(messages: AgentRunMessage[]): AgentRunMessage[] {
	return messages.filter(m => !(m && (m as { synthetic?: boolean }).synthetic === true));
}

/**
 * 消息归一化（OpenAI 兼容网关收口层）。
 *
 * 修复两类非法 role 顺序，否则网关返回 HTTP 400 invalid_parameter：
 *   1. 连续两条 role:'user' → 合并为一条（拼接 content）
 *   2. assistant 带 tool_calls 后未紧跟 role:'tool' → 为每个 tool_call_id
 *      插入空 tool 结果占位，保证 tool_calls→tool 的配对约束
 *
 * 对齐 hermes-agent / mimo-code / CodeBuddy IDE 的 normalize/coalesce 逻辑。
 * 纯函数，无副作用。
 */
export function normalizeMessages(messages: AgentRunMessage[]): AgentRunMessage[] {
	if (messages.length < 2) { return messages; }

	const result: AgentRunMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const prev = result[result.length - 1];

		// ── 规则 1：合并相邻 user ──
		if (msg.role === 'user' && prev?.role === 'user') {
			// 拼接 content（string 或 array of parts）
			const prevContent = prev.content ?? '';
			const currContent = msg.content ?? '';
			const merged =
				typeof prevContent === 'string' && typeof currContent === 'string'
					? prevContent + '\n\n' + currContent
					: currContent; // array parts 场景取后者
			result[result.length - 1] = { ...prev, content: merged };
			continue;
		}

		// ── 规则 2：orphaned tool_calls 补 tool 占位 ──
		if (
			prev?.role === 'assistant' &&
			Array.isArray((prev as any).tool_calls) &&
			(prev as any).tool_calls.length > 0 &&
			msg.role !== 'tool'
		) {
			const toolCalls = (prev as any).tool_calls as Array<{ id: string }>;
			for (const tc of toolCalls) {
				result.push({
					role: 'tool',
					tool_call_id: tc.id,
					content: '[Result omitted — turn was interrupted before tool execution]',
				} as any);
			}
		}

		result.push(msg);
	}

	// 尾部 orphaned tool_calls（最后一条是 assistant+tool_calls）
	const last = result[result.length - 1];
	if (
		last?.role === 'assistant' &&
		Array.isArray((last as any).tool_calls) &&
		(last as any).tool_calls.length > 0
	) {
		for (const tc of (last as any).tool_calls as Array<{ id: string }>) {
			result.push({
				role: 'tool',
				tool_call_id: tc.id,
				content: '[Result omitted — turn was interrupted before tool execution]',
			} as any);
		}
	}

	return result;
}

/** 工具调用历史追加 + 窗口裁剪（对齐 loop 内 _toolCallHistory） */
export function appendToolHistory(
	prev: ReadonlyArray<{ name: string; argsHash: string }>,
	entry: { name: string; argsHash: string },
	window: number = RUN_STATE_LIMITS.TOOL_LOOP_WINDOW,
): Array<{ name: string; argsHash: string }> {
	const next = [...prev, entry];
	if (next.length > window) {
		next.shift();
	}
	return next;
}

/** 组合 reducer：返回新 state，不修改入参 */
export function reduceRunState(state: AgentRunState, action: AgentAction): AgentRunState {
	switch (action.type) {
		case 'APPEND_MESSAGES':
			return { ...state, messages: appendMessages(state.messages, ...action.messages) };

		case 'COMPACT_MESSAGES':
			return { ...state, messages: compactMessages(state.messages, action.messages) };

		case 'BUMP_ITERATION':
			return { ...state, iteration: state.iteration + (action.by ?? 1) };

		case 'SET_PHASE':
			return { ...state, phase: action.phase };

		case 'RECORD_TOOL_CALL':
			return {
				...state,
				toolCallHistory: appendToolHistory(state.toolCallHistory, { name: action.name, argsHash: action.argsHash }),
			};

		case 'RECONCILE_ORPHANS':
			return { ...state, endedToolIds: [...state.endedToolIds, ...action.endedIds] };

		case 'INVALID_TOOL_NAME':
			return { ...state, invalidToolNameCount: state.invalidToolNameCount + 1 };

		case 'REFLECT':
			return { ...state, reflectCount: state.reflectCount + 1 };

		case 'SET_LAST_PROMPT_TOKENS':
			return { ...state, lastRealPromptTokens: action.value };

		case 'MARK_FILE_MODIFIED':
			return { ...state, hasModifiedFiles: true };

		case 'WORK_EVENT':
			return { ...state, work: reduceWorkState(state.work, action.event) };

		// ─── V3: 单 agent 断点续跑 ──────────────────────────────────
		case 'SAVE_BUDGET':
			return { ...state, budgetSnapshot: { ...action.snapshot } };

		case 'SET_PRE_EXPLORE':
			return {
				...state,
				preExploreDone: action.done,
				preExploreResult: action.result,
			};

		case 'SET_LOOP_MESSAGES':
			return { ...state, loopMessages: [...action.messages] };

		case 'SET_PARADIGM':
			return { ...state, paradigm: action.paradigm };

		// ─── 图运行时 action（supervisor / AgentCommand(goto)，Step A）───
		// 单 agent 模式 graph 为 undefined：下列 action 全部 no-op，零行为变更。
		case 'ENTER_NODE': {
			if (!state.graph) { return state; }
			return {
				...state,
				graph: {
					...state.graph,
					currentNodeId: action.nodeId,
					nodeStatus: { ...state.graph.nodeStatus, [action.nodeId]: 'running' },
				},
			};
		}

		case 'EXIT_NODE': {
			if (!state.graph) { return state; }
			return {
				...state,
				graph: {
					...state.graph,
					nodeStatus: { ...state.graph.nodeStatus, [action.nodeId]: 'done' },
					nodeThreads: { ...state.graph.nodeThreads, [action.nodeId]: [...action.messages] },
				},
			};
		}

		case 'SET_NODE_STATUS': {
			if (!state.graph) { return state; }
			return {
				...state,
				graph: { ...state.graph, nodeStatus: { ...state.graph.nodeStatus, [action.nodeId]: action.status } },
			};
		}

		case 'WRITE_SHARED_MEMORY': {
			if (!state.graph) { return state; }
			return {
				...state,
				graph: { ...state.graph, sharedMemory: { ...state.graph.sharedMemory, ...action.patch } },
			};
		}

		case 'SET_HANDOFF': {
			if (!state.graph) { return state; }
			return { ...state, graph: { ...state.graph, handoffSummary: action.summary } };
		}

		case 'SET_CURRENT_NODE': {
			if (!state.graph) { return state; }
			return { ...state, graph: { ...state.graph, currentNodeId: action.nodeId } };
		}

		default:
			return state;
	}
}

// ─── 控制逻辑纯函数（可单测，Step 3 接入 loop）──────────────────────

/**
 * 工具循环检测（对齐 loop 内 detectToolCallLoop）：
 * 基于 state.toolCallHistory 判断 (name, argsHash) 是否构成重复循环。
 * 纯函数：不修改 state，只读取并返回判定结果；调用方据此派发 RECORD_TOOL_CALL。
 */
export function detectToolCallLoop(
	history: ReadonlyArray<{ name: string; argsHash: string }>,
	name: string,
	args: Record<string, unknown>,
	threshold: number = RUN_STATE_LIMITS.TOOL_LOOP_THRESHOLD,
): { loop: boolean; count: number } {
	const argsHash = JSON.stringify(args ?? {}).slice(0, 200);
	const signature = `${name}:${argsHash}`;
	let count = 0;
	for (const h of history) {
		if (`${h.name}:${h.argsHash}` === signature) {
			count++;
		}
	}
	return { loop: count >= threshold, count: count + 1 };
}

/** 是否达到反思上限 */
export function reachedReflectLimit(
	count: number,
	limit: number = RUN_STATE_LIMITS.MAX_REFLECT_ITERATIONS,
): boolean {
	return count >= limit;
}

// ─── 未完成轮判定（对齐 OpenClaw incomplete-turn，stopReason 驱动、无文本意图识别）──
// 移植目标：用 provider 的 finishReason + 内容块结构（可见文本 / 思考块 / 工具调用）
// 判定"模型这一轮是不是没说完"，而非对自然语言做关键词匹配（写/保存/输出…）。
// 命中未完成轮时由 loop 安全续跑（注入续跑指令 + discard_prior_text 防污染），带次数上限。
// 对齐 MiMo classifyAssistantStep + empty-step-detection 恢复阶梯 + prompt.ts 增量注入。

/** reasoning-only（只有思考、无可见答案）续跑次数上限 */
export const DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2;
/** 空响应（既无文本也无思考、无工具调用）续跑次数上限。对齐 MiMo EMPTY_STEP_MAX_RECOVERY。 */
export const DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT = 2;
/** 输出被截断（length）续跑次数上限 */
export const DEFAULT_LENGTH_TRUNCATED_RETRY_LIMIT = 2;

/**
 * 恢复阶梯：根据 kind + attempt 返回第1次(soft remind)或第2次(final chance)的注入文本。
 * 第3次及以上由调用方 hard halt（不再注入指令，直接超限结束）。
 * attempt 从 1 开始（第1次=used+1）。
 */
export function resolveRecoveryInstruction(kind: 'length' | 'reasoning-only' | 'empty', attempt: number): string {
	// ── Soft remind (attempt 1: L1，对齐 MiMo EMPTY_STEP_RECOVERY_REMIND) ──
	const soft = (kind === 'empty')
		? [
			'<system-reminder>',
			'NO PROGRESS: your previous step produced no user-visible text and issued no tool call.',
			'You MUST do exactly ONE of these now:',
			'- Issue a valid tool call with COMPLETE, non-empty arguments, or',
			'- Reply to the user directly with plain text.',
			'Do NOT emit another empty or content-free response.',
			'</system-reminder>',
		].join('\n')
		: (kind === 'reasoning-only')
		? [
			'<system-reminder>',
			'NO PROGRESS: your previous step recorded reasoning but produced no user-visible answer and no tool call.',
			'You MUST do exactly ONE of these now:',
			'- Issue a valid tool call with COMPLETE arguments, or',
			'- Reply to the user directly with plain text.',
			'Do NOT emit another reasoning-only response without a visible answer or tool call.',
			'</system-reminder>',
		].join('\n')
		: [
			'<system-reminder>',
			'NO PROGRESS: your previous response was cut off by the output token limit before it could finish.',
			'You MUST either:',
			'- Issue a valid tool call with COMPLETE arguments if the result was interrupted, or',
			'- Give the user a plain-text summary of what was being completed.',
			'Continue from where you stopped — do NOT restart from scratch.',
			'</system-reminder>',
		].join('\n');

	// ── Final chance (attempt >= 2: L2，对齐 MiMo EMPTY_STEP_RECOVERY_REPLAN) ──
	if (attempt >= 2) {
		return (kind === 'empty')
			? [
				'<system-reminder>',
				'STILL NO PROGRESS: you are repeating empty/no-op responses after a reminder.',
				'This is your LAST CHANCE before the turn is terminated. You MUST either:',
				'1. Send a single valid tool call whose arguments are fully populated, or',
				'2. Give the user a plain-text response explaining the result or the blocker.',
				'Any further empty or argument-less response will end this turn immediately.',
				'</system-reminder>',
			].join('\n')
			: (kind === 'reasoning-only')
			? [
				'<system-reminder>',
				'STILL NO PROGRESS: you are repeating reasoning-only responses after a reminder.',
				'This is your LAST CHANCE. You MUST either:',
				'1. Send a valid tool call with complete, non-empty arguments, or',
				'2. Give the user a plain-text response explaining the result.',
				'Any further reasoning-only or empty response will terminate this turn.',
				'</system-reminder>',
			].join('\n')
			: [
				'<system-reminder>',
				'STILL NO PROGRESS: the output was cut off again by the token limit.',
				'FINAL CHANCE: produce a concise tool call or plain-text result summary NOW.',
				'Any further incomplete output will end this turn.',
				'</system-reminder>',
			].join('\n');
	}
	return soft;
}

/**
 * 兼容旧 API：返回静态续跑指令（不带 attempt 升级）。
 * @deprecated 新调用方应使用 resolveRecoveryInstruction(kind, attempt)
 */
export const REASONING_ONLY_RETRY_INSTRUCTION = resolveRecoveryInstruction('reasoning-only', 1);
export const EMPTY_RESPONSE_RETRY_INSTRUCTION = resolveRecoveryInstruction('empty', 1);
export const LENGTH_TRUNCATED_RETRY_INSTRUCTION = resolveRecoveryInstruction('length', 1);

/**
 * 流超时/网络瞬态错误重试配置（维度 3：对齐 MiMo persistentRetrySchedule）。
 * 指数退避 1s×2，最多 3 次，单次上限 10s。
 */
export const TRANSIENT_ERROR_MAX_RETRIES = 3;
export const TRANSIENT_ERROR_BASE_DELAY_MS = 1000;
export const TRANSIENT_ERROR_BACKOFF_FACTOR = 2;
export const TRANSIENT_ERROR_MAX_DELAY_MS = 10000;

/** 识别流/网络的瞬态可重试错误（对齐 MiMo isRetryableTransientError） */
export function isTransientStreamError(error: unknown): boolean {
	if (!(error instanceof Error)) { return false; }
	const msg = error.message;
	// SSE 超时（provider 层 chunk-timeout 触发）
	if (msg.includes('SSE read timed out') || msg.includes('socket hang up')) { return true; }
	// HTTP 429 / 5xx / 529
	const status = (error as { status?: number }).status ?? (error as { statusCode?: number }).statusCode;
	if (typeof status === 'number') {
		if (status === 429 || (status >= 500 && status <= 599) || status === 529) { return true; }
	}
	// 网络错误码
	const code = (error as { code?: string }).code;
	if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') { return true; }
	// 上游代理错
	if (msg.includes('upstream_error') || msg.includes('EOF')) { return true; }
	return false;
}

/** 未完成轮分类结果。对齐 MiMo StepClassification + classifyAssistantStep。 */
export type IncompleteTurnKind = 'complete' | 'length' | 'reasoning-only' | 'empty' | 'filtered' | 'failed';

export interface ClassifyIncompleteTurnParams {
	/** provider 本轮结束原因（finish_reason / stop_reason），可能缺省 */
	readonly finishReason?: string | null;
	/** 是否有用户可见文本（trim 后非空） */
	readonly hasVisibleText: boolean;
	/** 是否有 thinking / 思考块内容 */
	readonly hasThinking: boolean;
	/** 是否有（有效）工具调用——工具调用路径会续跑，不在此判定 */
	readonly hasToolCalls: boolean;
}

/**
 * 判定本轮 assistant 是否为"未完成轮"。
 * 纯结构驱动，对齐 MiMo classifyAssistantStep / Openclaw stopReason / Hermes finish_reason。
 * 不分析文本内容——信任 finishReason 作为模型"是否完成"的权威信号。
 */
export function classifyIncompleteTurn(params: ClassifyIncompleteTurnParams): IncompleteTurnKind {
	if (params.hasToolCalls) { return 'complete'; }
	if (params.hasVisibleText) { return 'complete'; }
	const fr = params.finishReason;
	if (fr === 'content_filter' || fr === 'content-filter') { return 'filtered'; }
	if (fr === 'error') { return 'failed'; }
	if (fr === 'length' || fr === 'max_tokens' || fr === 'max_completion_tokens') { return 'length'; }
	if (params.hasThinking) { return 'reasoning-only'; }
	return 'empty';
}

/**
 * 根据未完成轮类型 + attempt 返回续跑注入指令。
 * 对齐 MiMo 的 recover ladder：attempt=1 → soft remind，attempt=2 → final chance。
 * @param kind 分类
 * @param attempt 当前是第几次尝试（1-based，调用方用 used+1 传入）
 */
export function resolveIncompleteTurnRetryInstruction(kind: IncompleteTurnKind, attempt?: number): string | null {
	switch (kind) {
		case 'length': return resolveRecoveryInstruction('length', attempt ?? 1);
		case 'reasoning-only': return resolveRecoveryInstruction('reasoning-only', attempt ?? 1);
		case 'empty': return resolveRecoveryInstruction('empty', attempt ?? 1);
		case 'filtered': case 'failed': return null;
		default: return null;
	}
}

export function incompleteTurnDiscardReason(kind: IncompleteTurnKind): 'unfinished-intent' | 'empty-recovery' | 'filtered' | 'failed' {
	switch (kind) {
		case 'filtered': return 'filtered';
		case 'failed': return 'failed';
		case 'reasoning-only': return 'empty-recovery';
		default: return 'unfinished-intent';
	}
}

export function incompleteTurnRetryLimit(kind: IncompleteTurnKind): number {
	switch (kind) {
		case 'reasoning-only': return DEFAULT_REASONING_ONLY_RETRY_LIMIT;
		case 'empty': return DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT;
		case 'length': return DEFAULT_LENGTH_TRUNCATED_RETRY_LIMIT;
		default: return 0;
	}
}

// ─── Snapshot / Restore（Step 5：checkpoint 地基）─────────────────
// AgentRunState 是纯 JSON 对象（无函数 / 类实例），故可直接序列化。
// 这里提供带版本的快照封装 + 恢复时的安全校验 / 缺省填充，使 Step D 的
// checkpoint/resume 与未来 forward-compat 有统一入口（对齐 reducer 设计 §3.5）。

/** 快照格式版本（forward-compat：restore 拒绝未知 / 过高版本）。
 *  v2: 初始版本（graph checkpoint + work state）
 *  v3: 新增 budgetSnapshot / preExploreDone / preExploreResult / loopMessages（单 agent 断点续跑）
 *      含可选 paradigm 字段（R3：resume 时重建同一策略，避免范式漂移） */
export const AGENT_RUN_STATE_VERSION = 3;

export interface AgentRunStateSnapshot {
	/** 快照格式版本 */
	readonly version: number;
	/** 纯 JSON 状态（深拷贝，调用方持有不影响原对象） */
	readonly state: AgentRunState;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 深拷贝（保留 undefined；structuredClone 在 Electron / Node 全局可用）。 */
function cloneRunState(state: AgentRunState): AgentRunState {
	return structuredClone(state);
}

/** 生成可持久化快照（深拷贝，不修改入参）。 */
export function snapshotRunState(state: AgentRunState): AgentRunStateSnapshot {
	return { version: AGENT_RUN_STATE_VERSION, state: cloneRunState(state) };
}

/**
 * 从任意输入安全恢复为一个合法的 AgentRunState（**永不抛错**）。
 * 接受两种形态（容错）：
 *  ① 快照 `{ version, state }` —— checkpoint 落盘的 AgentRunStateSnapshot
 *  ② 裸 `AgentRunState` —— resumeFrom 直接持有原始 state，或测试传入 partial state
 * - 快照形态下未知 / 过高 version → 回退初始（forward-compat 留口）。
 * - 部分字段缺失 / 类型不符 → 用 createInitialRunState 默认值补全，保证返回可安全消费。
 */
function extractRawState(input: unknown): Record<string, unknown> | undefined {
	if (!isPlainObject(input)) { return undefined; }
	// 快照形态 { version, state }
	if (isPlainObject((input as Record<string, unknown>).state)) {
		const v = (input as Partial<AgentRunStateSnapshot>).version;
		if (typeof v === 'number' && v > AGENT_RUN_STATE_VERSION) {
			return undefined; // 未知 / 过高版本 → 拒绝
		}
		return (input as Record<string, unknown>).state as Record<string, unknown>;
	}
	// 裸 AgentRunState（或 partial state）
	return input as Record<string, unknown>;
}

export function restoreRunState(input: unknown): AgentRunState {
	const raw = extractRawState(input);
	if (!raw) { return createInitialRunState({}); }
	return normalizeRunState(raw as Partial<AgentRunState>);
}

const VALID_PHASES: ReadonlyArray<StreamPhase> = [
	'idle', 'llm_streaming', 'tool_executing', 'awaiting_approval', 'compressing', 'error',
];

function normalizeGraphRunState(raw: Partial<AgentGraphRunState>): AgentGraphRunState {
	return {
		currentNodeId: typeof raw.currentNodeId === 'string' ? raw.currentNodeId : undefined,
		nodeThreads: isPlainObject(raw.nodeThreads)
			? (raw.nodeThreads as Record<string, AgentRunMessage[]>)
			: {},
		sharedMemory: isPlainObject(raw.sharedMemory)
			? (raw.sharedMemory as Record<string, unknown>)
			: {},
		handoffSummary: typeof raw.handoffSummary === 'string' ? raw.handoffSummary : undefined,
		nodeStatus: isPlainObject(raw.nodeStatus)
			? (raw.nodeStatus as Record<string, AgentGraphNodeExecutionStatus>)
			: {},
	};
}

/** 用 createInitialRunState 的默认值为 partial 状态补齐全字段，保证返回合法 AgentRunState。 */
function normalizeRunState(raw: Partial<AgentRunState>): AgentRunState {
	const base = createInitialRunState({});
	const phase: StreamPhase = VALID_PHASES.includes(raw.phase as StreamPhase)
		? (raw.phase as StreamPhase)
		: 'idle';
	const graph = raw.graph ? normalizeGraphRunState(raw.graph) : undefined;
	return {
		...base,
		...raw,
		messages: Array.isArray(raw.messages) ? (raw.messages as AgentRunMessage[]) : base.messages,
		iteration: typeof raw.iteration === 'number' ? raw.iteration : base.iteration,
		phase,
		invalidToolNameCount: typeof raw.invalidToolNameCount === 'number' ? raw.invalidToolNameCount : base.invalidToolNameCount,
		reflectCount: typeof raw.reflectCount === 'number' ? raw.reflectCount : base.reflectCount,
		hasModifiedFiles: typeof raw.hasModifiedFiles === 'boolean' ? raw.hasModifiedFiles : base.hasModifiedFiles,
		toolCallHistory: Array.isArray(raw.toolCallHistory) ? (raw.toolCallHistory as AgentRunState['toolCallHistory']) : base.toolCallHistory,
		startedToolIds: Array.isArray(raw.startedToolIds) ? raw.startedToolIds : base.startedToolIds,
		endedToolIds: Array.isArray(raw.endedToolIds) ? raw.endedToolIds : base.endedToolIds,
		lastRealPromptTokens: typeof raw.lastRealPromptTokens === 'number' ? raw.lastRealPromptTokens : base.lastRealPromptTokens,
		reducerMode: raw.reducerMode === 'legacy' || raw.reducerMode === 'reducer' ? raw.reducerMode : base.reducerMode,
		work: isPlainObject(raw.work)
			? {
				mode: raw.work.mode === 'plan' ? 'plan' : 'work',
				planFilePath: typeof raw.work.planFilePath === 'string' ? raw.work.planFilePath : undefined,
				approvalStatus: ['none', 'pending', 'approved', 'rejected'].includes(String(raw.work.approvalStatus))
					? raw.work.approvalStatus as AgentWorkState['approvalStatus'] : 'none',
				executionStatus: ['idle', 'dispatching', 'running', 'completed', 'failed'].includes(String(raw.work.executionStatus))
					? raw.work.executionStatus as AgentWorkState['executionStatus'] : 'idle',
			}
			: base.work,
		graph,
		// V3 fields
		budgetSnapshot: isPlainObject(raw.budgetSnapshot) && typeof (raw.budgetSnapshot as any).maxIterations === 'number'
			? raw.budgetSnapshot as BudgetSnapshot
			: undefined,
		preExploreDone: typeof raw.preExploreDone === 'boolean' ? raw.preExploreDone : false,
		preExploreResult: typeof raw.preExploreResult === 'string' ? raw.preExploreResult : undefined,
		loopMessages: Array.isArray(raw.loopMessages) ? (raw.loopMessages as AgentRunMessage[]) : undefined,
		// V3 paradigm：仅接受已知范式，否则丢弃（resume 时回退到 request/agent 配置）
		paradigm: KNOWN_PARADIGMS.includes(raw.paradigm as AgentParadigm) ? (raw.paradigm as AgentParadigm) : undefined,

	};
}

// ─── Resume 起点（Step D：checkpoint/resume）──────────────────────

export interface ResumePlan {
	readonly runState: AgentRunState;
	readonly startNodeId: string;
}

/**
 * 计算多 agent 图续跑的起点（Step D）。
 * - restored 含 graph 且 currentNodeId 合法 → 从该节点续跑（v1 语义：重启该节点，
 *   因节点边界即 checkpoint 边界，无法从节点中途续跑；节点重启在 worker 侧通常为幂等读取）。
 * - restored 无 graph / currentNodeId 缺失或非法 → 回退到 entry 节点从头跑。
 * 返回已 normalize + 深拷贝的 runState，调用方直接用于 executeAgentGraph。
 */
export function prepareResumeRunState(graph: AgentGraph, restored: AgentRunState | undefined): ResumePlan {
	if (!restored?.graph) {
		return {
			runState: createInitialRunState({ graphRunState: createInitialGraphRunState(graph) }),
			startNodeId: graph.entryNodeId,
		};
	}
	const runState = restoreRunState(restored);
	const startNodeId =
		runState.graph?.currentNodeId && graph.nodes[runState.graph.currentNodeId]
			? runState.graph.currentNodeId
			: graph.entryNodeId;
	return { runState, startNodeId };
}
