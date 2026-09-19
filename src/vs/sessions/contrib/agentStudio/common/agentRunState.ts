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
	/**
	 * 单 turn 最大工具迭代次数（须与 agentOSService.MAX_TOOL_ITERATIONS 保持一致）。
	 * 2026-08-20：50 → 100，同时那边撞上限后会额外跑一轮禁工具收尾轮（实际 100+1）。
	 */
	MAX_TOOL_ITERATIONS: 100,
	/** 工具循环检测窗口（loop 内 TOOL_LOOP_WINDOW） */
	TOOL_LOOP_WINDOW: 10,
	/** 工具循环检测阈值（loop 内 TOOL_LOOP_THRESHOLD） */
	TOOL_LOOP_THRESHOLD: 3,
	/** 反思阶段最大次数（loop 内 MAX_REFLECT_ITERATIONS） */
	MAX_REFLECT_ITERATIONS: 1,
	/**
	 * 参数抖动检测阈值（openclaw `argument_churn`）：同一工具、**参数各不相同**、
	 * 连续达到该次数即判定为「在参数上反复试探」。
	 *
	 * 为什么单列而不复用 TOOL_LOOP_THRESHOLD：loop 判定的是「完全相同」，
	 * 只有 3 次即可确信；抖动判定的是「每次都不同」，误报面更大（正常的
	 * 连续 file_read 读不同文件、连续 terminal 跑不同命令都长这样），
	 * 故阈值刻意更高，只在明显偏执的形态下才触发。
	 */
	ARGUMENT_CHURN_THRESHOLD: 5,
} as const;

/** AgentOS 运行时状态由纯 reducer（reduceRunState）驱动。
 * Step 1~3 已把 messages 写入与控制变量全部收口进 reduceRunState，
 * legacy（闭包直写）路径随之移除，不再保留双模开关 —— 任何「翻开关回滚」
 * 都是假的安全网，因为被回滚到的代码已不存在。回滚只能靠 git。
 * 未来若需 per-session 覆盖，应重新引入显式字段并经 createInitialRunState 透传。 */

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

// ─── 工具调用历史条目 ────────────────────────────────────────────────
/**
 * 一次工具调用的历史记录。
 *
 * `resultHash` 在**工具执行后**由 `RECORD_TOOL_RESULT` 回填，执行前为 undefined
 * —— 因为 `RECORD_TOOL_CALL` 是在调度执行**之前**派发的，那一刻还没有结果。
 *
 * 可选字段保证向后兼容：旧的 checkpoint / 序列化数据只有 name+argsHash，
 * 反序列化后 resultHash 为 undefined，ping-pong 检测会自动降级（无进展证据不足时不升级）。
 */
export interface IToolCallHistoryEntry {
	readonly name: string;
	readonly argsHash: string;
	/** 结果哈希（易失字段已剥离）。执行后回填。 */
	readonly resultHash?: string;
	/**
	 * 本轮的**循环签名键**（`reason:<hash>` 或 `tool:<signature>`，见 `common/reasonStreak.ts`）。
	 *
	 * 与 `resultHash` 同样保持可选：旧的 checkpoint / 序列化数据没有该字段，
	 * 反序列化后为 undefined，reasoning 循环检测自动降级（不判定），不影响既有逻辑。
	 *
	 * 为什么不复用 `name`/`argsHash`：那两者是**单个工具**的签名；streakKey 是
	 * **整轮**的概念（以 thinking 为主键，工具漂移仍算同一轮），粒度不同。
	 */
	readonly streakKey?: string;
}

/**
 * 跨轮护栏计数（P0-a-3 收口）。
 *
 * 三组「连续 N 轮出现同一退化行为」的计数，各自带一个「提醒已发」的 latch。
 * latch 存在的意义是避免每轮重复注入 —— 反复注入既污染 provider 前缀缓存，
 * 又会被模型忽略（见 agentTurnExecutor 内各处注释记录的事故日志）。
 */
export interface AgentGuardrailCounters {
	/** 连续只用文本搜索（未触及结构搜索工具）的轮数 */
	textSearchStreak: number;
	/** 文本搜索软上限提醒是否已注入（注入后 streak 不清零，硬上限仍可达） */
	textSearchSoftReminderSent: boolean;
	/** 连续「每轮只请求 1 个只读工具」的轮数 */
	singleToolStreak: number;
	/** 连续「整轮工具调用全被循环检测拦下」的轮数 */
	allBlockedStreak: number;
	/** 零进展强提醒是否已注入（同 latch 语义：只发一次） */
	allBlockedReminderSent: boolean;
}

/**
 * 收尾轮门控状态（P0-a-5 收口）。
 *
 * 与 AgentGuardrailCounters 的区别：后者是「连续 N 轮」的计数，本组是
 * 「本轮是否已进入/已执行收尾」的布尔门控。二者语义不同，不可合并。
 *
 * ⚠ done 与 forced 不可合并（原代码注释已强调）：
 *   · forced —— **指令意图**：「要求进入收尾轮」。由循环体多处触发
 *     （零进展 / 文本搜索硬上限 / 迭代硬上限），循环头读取后据此禁工具。
 *   · done   —— **事实记录**：「收尾轮已执行过」。循环头在收尾轮结束时置位，
 *     仅用于循环尾的诊断日志，说明模型确实获得了无工具的一轮来收尾。
 * 合并会导致「本轮没强制收尾」与「收尾轮尚未执行」被混为一谈。
 *
 * 为什么必须收进 state：forced 是**循环体写、循环头读**的跨阶段状态。
 * 循环体一旦抽成独立函数（P0-b 目标），闭包共享即断，故需显式承载。
 */
export interface AgentWrapUpState {
	/** 已执行过收尾轮（事实记录，仅用于收尾日志） */
	done: boolean;
	/** 要求进入收尾轮（指令意图，循环头据此禁用工具） */
	forced: boolean;
	/** 因零进展 / 文本搜索触发的「原因专属」收尾提醒已注入 */
	reasonReminderInjected: boolean;
	/** 因撞迭代硬上限触发的收尾提醒已注入（与上一项语义不同，不可合并） */
	hardLimitReminderInjected: boolean;
	/** 预算低位预警已注入 */
	budgetLowWarned: boolean;
}

/** 收尾门控的初始值。 */
export function createInitialWrapUpState(): AgentWrapUpState {
	return {
		done: false,
		forced: false,
		reasonReminderInjected: false,
		hardLimitReminderInjected: false,
		budgetLowWarned: false,
	};
}

/**
 * 轮次重试预算（P0-b 从 agentTurnExecutor 闭包收口而来）。
 *
 * 这 5 个计数器原先散落为 turn 级闭包 `let`，语义都是「单次 turn 内累计的上限额度」——
 * 与 guardrails（模型行为倾向）不同，它们是**执行层重试预算**：达到上限即放弃续跑。
 *
 * ⚠ 收口理由与 guardrails 相同：这些计数是**循环体写、后续轮次读**的跨 iteration 状态。
 * 一旦把循环体抽成独立函数（P0-b 目标），闭包共享即断，故需显式承载。
 * 它们与「turn 级节流器」的区别：节流器（如 _lastPromptBudgetTotal）跨 turn 存活会
 * 造成语义错位，故刻意不收口；而重试预算本就是「单次 turn 内」语义，随 runState 落盘
 * 只是把它显式化，不改变生命周期（runState 每个 turn 重建）。
 */
export interface AgentRetryCounters {
	/** 只出推理无正文，续跑次数（上限见 DEFAULT_REASONING_ONLY_RETRY_LIMIT）。 */
	reasoningOnly: number;
	/** 空响应（无文本无工具）续跑次数。 */
	emptyResponse: number;
	/** 输出被 length 截断续跑次数。 */
	lengthTruncated: number;
	/** 尾部结构截断（finishReason=stop 但末行没写完）续写次数（上限见 DEFAULT_TRUNCATED_TEXT_RETRY_LIMIT）。 */
	truncatedText: number;
	/**
	 * 工具调用在协议层丢失（finish_reason=tool_calls 但 0 tool call）续跑次数。
	 *
	 * ⚠ 语义：只增不减，**重试成功后不重置** —— 上限是「单次 turn 内总额度」，
	 * 而非「连续失败次数」。例：丢失→重试成功→再丢失，第二次的 attempt 是 2 而非 1。
	 */
	toolCallLost: number;
	/** 瞬态错误（SSE 超时 / 网络 / 429 / 5xx）重试次数。 */
	transientError: number;
	/** 首 token 超时（冷启动）有界重试次数（预热优化）。 */
	firstTokenTimeout: number;
}

/** 轮次重试预算初始值（全部归零）。 */
export function createInitialRetryCounters(): AgentRetryCounters {
	return {
		reasoningOnly: 0,
		emptyResponse: 0,
		lengthTruncated: 0,
		truncatedText: 0,
		toolCallLost: 0,
		transientError: 0,
		firstTokenTimeout: 0,
	};
}

/**
 * 从 checkpoint 的原始值窄化重试预算：逐字段校验类型与有限性，非法字段回落到 base。
 * 与 normalizeGuardrailCounters 同姿态 —— 旧快照缺字段或字段写坏都不应崩。
 * 额外校验 Number.isFinite：NaN / Infinity 会让 `count >= LIMIT` 判定失真。
 */
export function normalizeRetryCounters(raw: unknown, base: AgentRetryCounters): AgentRetryCounters {
	if (!isPlainObject(raw)) { return { ...base }; }
	const source = raw as Record<string, unknown>;
	const num = (v: unknown, fallback: number): number =>
		(typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : fallback;
	return {
		reasoningOnly: num(source.reasoningOnly, base.reasoningOnly),
		emptyResponse: num(source.emptyResponse, base.emptyResponse),
		lengthTruncated: num(source.lengthTruncated, base.lengthTruncated),
		truncatedText: num(source.truncatedText, base.truncatedText),
		toolCallLost: num(source.toolCallLost, base.toolCallLost),
		transientError: num(source.transientError, base.transientError),
		firstTokenTimeout: num(source.firstTokenTimeout, base.firstTokenTimeout),
	};
}

/**
 * 从 checkpoint 的原始值窄化收尾门控：逐字段校验类型，非法字段回落到 base。
 * 与 normalizeGuardrailCounters 同姿态 —— 旧快照缺字段或字段写坏都不应崩。
 */
export function normalizeWrapUpState(raw: unknown, base: AgentWrapUpState): AgentWrapUpState {
	if (!isPlainObject(raw)) { return { ...base }; }
	const source = raw as Record<string, unknown>;
	return {
		done: typeof source.done === 'boolean' ? source.done : base.done,
		forced: typeof source.forced === 'boolean' ? source.forced : base.forced,
		reasonReminderInjected: typeof source.reasonReminderInjected === 'boolean' ? source.reasonReminderInjected : base.reasonReminderInjected,
		hardLimitReminderInjected: typeof source.hardLimitReminderInjected === 'boolean' ? source.hardLimitReminderInjected : base.hardLimitReminderInjected,
		budgetLowWarned: typeof source.budgetLowWarned === 'boolean' ? source.budgetLowWarned : base.budgetLowWarned,
	};
}

/** 护栏计数的初始值（全部归零）。 */
export function createInitialGuardrailCounters(): AgentGuardrailCounters {
	return {
		textSearchStreak: 0,
		textSearchSoftReminderSent: false,
		singleToolStreak: 0,
		allBlockedStreak: 0,
		allBlockedReminderSent: false,
	};
}
/**
 * 从 checkpoint 的原始值窄化护栏计数：逐字段校验类型，非法字段回落到 base。
 * 旧版本 checkpoint 不含该字段（raw 为 undefined）时整体回落。
 */
export function normalizeGuardrailCounters(
	raw: unknown,
	base: AgentGuardrailCounters,
): AgentGuardrailCounters {
	if (!isPlainObject(raw)) { return { ...base }; }
	const source = raw as Record<string, unknown>;
	return {
		textSearchStreak: typeof source.textSearchStreak === 'number' ? source.textSearchStreak : base.textSearchStreak,
		textSearchSoftReminderSent: typeof source.textSearchSoftReminderSent === 'boolean' ? source.textSearchSoftReminderSent : base.textSearchSoftReminderSent,
		singleToolStreak: typeof source.singleToolStreak === 'number' ? source.singleToolStreak : base.singleToolStreak,
		allBlockedStreak: typeof source.allBlockedStreak === 'number' ? source.allBlockedStreak : base.allBlockedStreak,
		allBlockedReminderSent: typeof source.allBlockedReminderSent === 'boolean' ? source.allBlockedReminderSent : base.allBlockedReminderSent,
	};
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
	/**
	 * 跨轮护栏计数（P0-a-3 从 agentTurnExecutor 闭包收口而来）。
	 *
	 * 这些计数原先散落为循环内 `let`，跨 iteration 累积：
	 *   · textSearchStreak —— 连续只用文本搜索、未触及结构搜索工具
	 *   · singleToolStreak —— 连续多轮「每轮只请求 1 个只读工具」
	 *   · allBlockedStreak —— 连续多轮「整轮工具调用全被循环检测拦下」
	 * 收进 state 后，护栏判定可在快照上复现与单测，不再依赖闭包存活期。
	 *
	 * ── runState 收口边界（P0-a 结论，新增字段前必读）──────────────
	 * 判据：该状态跨 turn 存活后语义是否仍然成立。
	 *
	 * 【应收口】跨 turn 有意义的「模型行为倾向」——某个模型在持续做错事，
	 * 这个倾向不因新 turn 开始而消失。例如 guardrails 各计数、wrapUp 门控、
	 * work、messages。
	 *
	 * 【不应收口】节流器与重试预算 —— 其语义边界就是「当前这一次执行」，
	 * 跨 turn 存活会造成语义错位（比闭包双写更隐蔽）：
	 *   · _lastPromptBudgetTotal     —— 收口后次 turn 首次上报被吞掉
	 *   · _terminalEmptyOutputCount  —— 带着上轮计数继续累计，误触发收尾
	 *   · _softBudgetNextReminderAtMs—— 锚在上轮 _turnStartedAt，节流失效
	 *   · _xmlToolLeakAttempts       —— 跨轮累计使新 turn 一开局即超限
	 *   · _wrapUpInsertIdx           —— 纯轮内临时值，每次注入前重算
	 * 这些留在 executeAgentTurnDirect 的 turn 级闭包中，天然每 turn 重置。
	 */
	guardrails: AgentGuardrailCounters;
	/** 收尾轮门控（P0-a-5 收口）。 */
	wrapUp: AgentWrapUpState;
	/** 轮次重试预算（P0-b 收口）。 */
	retry: AgentRetryCounters;
	/** 反思阶段已触发次数 */
	reflectCount: number;
	/** 是否执行过文件修改类工具（触发反思的前提） */
	hasModifiedFiles: boolean;
	/** 工具调用签名历史（带窗口裁剪，用于循环检测 / ping-pong 检测） */
	toolCallHistory: ReadonlyArray<IToolCallHistoryEntry>;
	/** 已发起但未结束的工具调用 id（孤儿对账） */
	startedToolIds: string[];
	/** 已结束的工具调用 id（孤儿对账） */
	endedToolIds: string[];
	/** 上一轮真实 prompt token（跨 turn 持久化的压缩判定依据） */
	lastRealPromptTokens: number;
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
	/**
	 * 循环消息的**兼容镜像**（与 `messages` 同步写入，见 reducer 的 `SET_LOOP_MESSAGES`）。
	 *
	 * 历史：P0-a-2 之前本字段是循环消息的唯一真实载体，`messages` 恒为空数组。
	 * P0-a-2 的调用点迁移只改了名字（`messages.push` → `syncMessages()`），底层仍在写
	 * 本字段 —— 形成「名字写 messages、实际写 loopMessages」的隐蔽分叉，直到复核才被发现。
	 * 现已重定向：`messages` 为真相源，本字段同步镜像。
	 *
	 * 保留原因：`executeAgentTurnDirect` 的恢复分支需读取它来兼容历史旧快照，
	 * 否则旧断点续跑会丢失全部对话历史。
	 *
	 * 删除条件（需同时满足，缺一不可）：
	 *   1. 无残留旧快照 —— 检查用户 workspace storage 中 `agentStudio.turnCheckpoint.*`
	 *      是否仍存在 `messages === []` 且 `loopMessages` 非空的条目；
	 *   2. 已加版本门槛 —— `restoreRunState` 对旧版本快照显式丢弃或迁移，
	 *      使旧快照不再进入恢复路径。
	 * ⚠ 在此之前删除会导致旧断点续跑**静默丢失全部对话历史**（不报错，模型直接失忆）。
	 *
	 * 另注：快照落盘是节流的（每 3 轮一次），且存储无 TTL —— 旧格式条目不会自行消亡，
	 * 故第 1 条无法靠"等一段时间"自然满足。
	 */
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
	| { type: 'RECORD_TOOL_CALL'; name: string; argsHash: string; streakKey?: string }
	/** 工具执行后回填结果哈希（供 ping-pong / no-progress 等跨调用检测使用） */
	| { type: 'RECORD_TOOL_RESULT'; name: string; argsHash: string; resultHash: string }
	| { type: 'RECONCILE_ORPHANS'; endedIds: string[] }
	| { type: 'INVALID_TOOL_NAME' }
	| { type: 'REFLECT' }
	| { type: 'SET_LAST_PROMPT_TOKENS'; value: number }
	| { type: 'MARK_FILE_MODIFIED' }
	| { type: 'WORK_EVENT'; event: AgentWorkEvent }
	/**
	 * 护栏计数更新（P0-a-3）：按 patch 做部分覆盖，未提及的字段保持原值。
	 * 用 patch 而非整对象替换，是为了让调用点只表达「我改了哪个计数」，
	 * 避免整对象覆盖时漏字段导致计数被静默清零。
	 */
	| { type: 'PATCH_GUARDRAILS'; patch: Partial<AgentGuardrailCounters> }
	/** 收尾门控部分更新（P0-a-5）；语义同 PATCH_GUARDRAILS。 */
	| { type: 'PATCH_WRAP_UP'; patch: Partial<AgentWrapUpState> }
	/** 轮次重试预算部分更新（P0-b）；语义同 PATCH_GUARDRAILS。 */
	| { type: 'PATCH_RETRY'; patch: Partial<AgentRetryCounters> }
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
		guardrails: createInitialGuardrailCounters(),
		wrapUp: createInitialWrapUpState(),
		reflectCount: 0,
		hasModifiedFiles: false,
		toolCallHistory: [],
		startedToolIds: [],
		endedToolIds: [],
		lastRealPromptTokens: request.lastRealPromptTokens ?? 0,
		work: request.workState ?? createInitialWorkState(),
		retry: createInitialRetryCounters(),
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
 *
 * ⚠ 尾部保护（2026-08-19 修 HTTP 400 code 11133，日志 1787104763200）：
 * **尾部连续的 synthetic 消息不剥离**。reflect / plan-queue / TaskGate nudge 等
 * 控制流分支的模式是「append 一条 synthetic user 到末尾 → continue 下一轮」，
 * 而 agentTurnExecutor 每轮迭代开头会调用本函数并**回写 messages**——若连尾部
 * 一起剥离，刚注入的 user 边界当轮即被删除，messages 变成以 assistant 结尾，
 * IOA 网关直接返回 400 invalid_parameter_value（param 为空）。实测证据：
 * 同一会话中「以 assistant 结尾」的请求 400，safe-retry 追加非 synthetic 的
 * retryInstruction 后（末尾变 user）立即 200。
 *
 * 尾部 sidecar 的语义正是「本轮要让模型回应的 user 边界」，理应保留；一旦模型
 * 回应（其后出现 assistant 消息），它不再位于尾部，下一轮即被正常剥离——
 * 因此不会累积，仍满足「不污染干净 transcript」的原始设计意图。
 */
export function stripSyntheticSidecars(messages: AgentRunMessage[]): AgentRunMessage[] {
	const isSynthetic = (m: AgentRunMessage): boolean =>
		!!m && (m as { synthetic?: boolean }).synthetic === true;
	// 尾部连续 synthetic 区间起点（保护区）
	let tailStart = messages.length;
	while (tailStart > 0 && isSynthetic(messages[tailStart - 1])) { tailStart--; }
	return messages.filter((m, i) => i >= tailStart || !isSynthetic(m));
}

/**
 * 消息归一化（OpenAI 兼容网关收口层）。
 *
 * 修复三类非法 role 顺序，否则网关返回 HTTP 400 invalid_parameter：
 *   1. 连续两条 role:'user' → 合并为一条（拼接 content）
 *   2. assistant 带 tool_calls 后未紧跟 role:'tool' → 为每个 tool_call_id
 *      插入空 tool 结果占位，保证 tool_calls→tool 的配对约束
 *   3. 消息数组以 assistant（无 tool_calls）结尾 → 追加 continuation user 边界
 *      （2026-08-19 新增；IOA 网关要求最后一条必须是 user/tool，否则
 *      400 invalid_parameter_value 且 param 为空，无从定位）
 *
 * 对齐 hermes-agent / mimo-code / CodeBuddy IDE 的 normalize/coalesce 逻辑。
 * 纯函数，无副作用。
 */
/**
 * 读取消息上的 tool_calls —— 统一 snake_case / camelCase 两种命名。
 *
 * LLM 线协议（LMBridge、OpenAI 请求体）用 `tool_calls`；
 * IChatMessage 统一格式（MessageFormatConverter 入口、AgentOS transcript）用 `toolCalls`。
 * 只判一种会在另一侧漏判 → 给「assistant + 工具调用」结尾的合法序列错误追加
 * user 边界，破坏 tool_calls→tool 配对约束。
 */
function readToolCalls(m: AgentRunMessage | undefined): Array<{ id: string }> {
	const src = m as { tool_calls?: unknown; toolCalls?: unknown } | undefined;
	const snake = Array.isArray(src?.tool_calls) ? src.tool_calls : undefined;
	const camel = Array.isArray(src?.toolCalls) ? src.toolCalls : undefined;
	return ((snake ?? camel ?? []) as Array<{ id: string }>);
}

/** 中断时的 tool 结果占位（同时写入两种命名的 id 字段，兼容双侧下游） */
function interruptedToolPlaceholder(id: string): AgentRunMessage {
	return {
		role: 'tool',
		tool_call_id: id,
		toolCallId: id,
		content: '[Result omitted — turn was interrupted before tool execution]',
	} as unknown as AgentRunMessage;
}

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
		if (prev?.role === 'assistant' && msg.role !== 'tool') {
			for (const tc of readToolCalls(prev)) {
				result.push(interruptedToolPlaceholder(tc.id));
			}
		}

		result.push(msg);
	}

	// 尾部 orphaned tool_calls（最后一条是 assistant+tool_calls）
	const last = result[result.length - 1];
	if (last?.role === 'assistant') {
		for (const tc of readToolCalls(last)) {
			result.push(interruptedToolPlaceholder(tc.id));
		}
	}

	// ── 规则 3：末尾 assistant（无 tool_calls）→ 追加 continuation user 边界 ──
	return ensureTrailingUserBoundary(result);
}

/**
 * 末尾 user 边界守卫（OpenAI 兼容网关最后一道收口，2026-08-19 修 HTTP 400 code 11133）。
 *
 * IOA 网关（copilot.tencent.com /v2/chat/completions）要求 messages 最后一条为
 * user 或 tool；以 assistant 结尾直接返回 400 invalid_parameter_value 且 param 为空
 * （无从定位）。实测证据（日志 1787104763200 + http-debug）：同一会话中
 * 「以 assistant 结尾」的请求 400，safe-retry 追加 retryInstruction 使末尾变 user 后
 * 立即 200——同构请求仅此一处差异。
 *
 * 已知触发路径：
 *   ① reflect / plan-queue / TaskGate nudge 注入的 synthetic user 被
 *      stripSyntheticSidecars 连尾剥离（已在该函数加尾部保护，此处兜底）
 *   ② turn 被中断 / 首字超时后残留的 assistant 消息
 *   ③ discard_prior_text 清空文本后保留的 assistant 壳
 *   ④ sanitizeToolPairs 移除失配 tool 消息后，末尾重新暴露出 assistant
 *      （故本守卫必须在 sanitize **之后**再跑一次，见 languageModelsBridge）
 *
 * ⚠ 追加的 continuation 标记 synthetic:true，**只应作用于发送副本**，不得回写
 * 干净 transcript（否则每轮累积并破坏 prompt cache 前缀稳定性）。
 * 纯函数，无副作用。
 */
export function ensureTrailingUserBoundary(messages: AgentRunMessage[]): AgentRunMessage[] {
	const tail = messages[messages.length - 1];
	// readToolCalls 统一识别 snake_case / camelCase 两种命名（见其注释）
	if (tail?.role !== 'assistant' || readToolCalls(tail).length > 0) {
		return messages;
	}
	return [
		...messages,
		{
			role: 'user',
			content: 'Continue from where you left off. If the task is already complete, give your final answer directly — do not repeat your previous message.',
			synthetic: true,
			sidecar: 'reminder',
		} as any,
	];
}

/** 工具调用历史追加 + 窗口裁剪（对齐 loop 内 _toolCallHistory） */
export function appendToolHistory(
	prev: ReadonlyArray<IToolCallHistoryEntry>,
	entry: IToolCallHistoryEntry,
	window: number = RUN_STATE_LIMITS.TOOL_LOOP_WINDOW,
): Array<IToolCallHistoryEntry> {
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
				toolCallHistory: appendToolHistory(state.toolCallHistory, {
					name: action.name,
					argsHash: action.argsHash,
					streakKey: action.streakKey,
				}),
			};

		case 'RECORD_TOOL_RESULT': {
			// 回填**最近一条**「同 name + 同 argsHash 且尚无 resultHash」的条目。
			// 并行执行时同一签名可能有多条在飞，取最近的未填条目；同签名并发本就罕见，
			// 万一错位也只是让某条结果的哈希归属相邻调用，不影响聚合判定的整体趋势。
			let idx = -1;
			for (let i = state.toolCallHistory.length - 1; i >= 0; i--) {
				const h = state.toolCallHistory[i];
				if (h.name === action.name && h.argsHash === action.argsHash && h.resultHash === undefined) {
					idx = i;
					break;
				}
			}
			if (idx === -1) { return state; }
			const nextHistory = state.toolCallHistory.slice();
			nextHistory[idx] = { ...nextHistory[idx], resultHash: action.resultHash };
			return { ...state, toolCallHistory: nextHistory };
		}

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

		case 'PATCH_GUARDRAILS':
			return { ...state, guardrails: { ...state.guardrails, ...action.patch } };

		case 'PATCH_WRAP_UP':
			return { ...state, wrapUp: { ...state.wrapUp, ...action.patch } };

		case 'PATCH_RETRY':
			return { ...state, retry: { ...state.retry, ...action.patch } };

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
			// P0-a-2 修正：过去此处只写 loopMessages，导致 runState.messages 恒为空数组 ——
			// 表现为「名字写 messages、实际写 loopMessages」的隐蔽分叉，快照里的 messages
			// 一直是空壳。现在 messages 是真身，loopMessages 仅作旧快照恢复用的兼容镜像。
			return {
				...state,
				messages: [...action.messages],
				loopMessages: [...action.messages],
			};

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

/** 稳定序列化：object key 递归排序，数组保序。 */
function stableStringifyArgs(value: unknown): string {
	if (value === null || value === undefined) { return 'null'; }
	if (typeof value !== 'object') { return JSON.stringify(value) ?? 'null'; }
	if (Array.isArray(value)) { return '[' + value.map(stableStringifyArgs).join(',') + ']'; }
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringifyArgs(obj[k])).join(',') + '}';
}

/**
 * 工具调用参数的规范化哈希 —— 循环检测签名的**唯一**来源。
 *
 * ⚠ 必须由「签名比对」与「写入 toolCallHistory」**两处共用**。若调用方各自用
 * `JSON.stringify` 计算，两边算法不一致会导致签名永远匹配不上，循环检测静默失效。
 *
 * 相比裸 `JSON.stringify`：对 object key 排序，使 `{a:1,b:2}` 与 `{b:2,a:1}`
 * 得到同一签名 —— 模型输出参数的 key 顺序抖动不应被误判为不同调用（否则漏检循环）。
 */
export function canonicalToolArgsHash(args: unknown, maxLen: number = 200): string {
	return stableStringifyArgs(args ?? {}).slice(0, maxLen);
}

/**
 * 工具循环检测（对齐 loop 内 detectToolCallLoop）：
 * 基于 state.toolCallHistory 判断 (name, argsHash) 是否构成重复循环。
 * 纯函数：不修改 state，只读取并返回判定结果；调用方据此派发 RECORD_TOOL_CALL。
 */
export function detectToolCallLoop(
	history: ReadonlyArray<IToolCallHistoryEntry>,
	name: string,
	args: Record<string, unknown>,
	threshold: number = RUN_STATE_LIMITS.TOOL_LOOP_THRESHOLD,
): { loop: boolean; count: number } {
	const argsHash = canonicalToolArgsHash(args);
	const signature = `${name}:${argsHash}`;
	let count = 0;
	for (const h of history) {
		if (`${h.name}:${h.argsHash}` === signature) {
			count++;
		}
	}
	return { loop: count >= threshold, count: count + 1 };
}

// ─── 易失字段剥离（对齐 openclaw VOLATILE_SEND_RESULT_KEYS）──────────────────
/**
 * 工具结果中**每次调用都不同**的字段。若参与结果哈希，「重复调用」将永远检测不到 ——
 * 例如发消息类工具每次返回新的 messageId/ts，即便发送内容与实质结果完全相同，
 * 哈希也不同 → 无进展类检测全部失效（openclaw issue #89090 正是此问题）。
 *
 * 刻意**不含**裸 `id`：它常是有意义的值（文件 id / 任务 id），移除会造成误判。
 * 只收录明确的「时间戳 / 消息回执 / 请求标识 / 耗时」类字段。
 */
const VOLATILE_RESULT_KEYS: ReadonlySet<string> = new Set([
	// 时间戳类
	'ts', 'timestamp', 'createdAt', 'created_at', 'updatedAt', 'updated_at',
	'date', 'time', 'startTime', 'endTime', 'finishedAt',
	// 消息 / 请求标识类
	'messageId', 'message_id', 'msgId', 'msg_id',
	'receipt', 'receiptId', 'receipt_id',
	'requestId', 'request_id', 'traceId', 'trace_id',
	'uuid', 'nonce', 'sessionId',
	// 耗时类
	'elapsed', 'elapsedMs', 'duration', 'durationMs', 'executionTimeMs', 'tookMs',
]);

/** 递归剥离易失字段（对象按 key 剔除，数组逐元素处理）。深度上限防病态嵌套。 */
function stripVolatileFields(value: unknown, depth: number = 0): unknown {
	if (depth > 6 || value === null || typeof value !== 'object') { return value; }
	if (Array.isArray(value)) {
		return value.map(v => stripVolatileFields(v, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (VOLATILE_RESULT_KEYS.has(k)) { continue; }
		out[k] = stripVolatileFields(v, depth + 1);
	}
	return out;
}

/**
 * 结果哈希 —— 先剥离易失字段再哈希，使「实质相同、仅时间戳/ID 不同」的两次调用
 * 得到同一哈希，从而能被 no-progress / ping-pong 等无进展类检测识别。
 */
export function hashToolResult(result: string | null | undefined, maxLen: number = 200): string {
	if (!result) { return stableStringifyArgs(null); }
	try {
		const parsed = JSON.parse(result);
		return stableStringifyArgs(stripVolatileFields(parsed)).slice(0, maxLen);
	} catch {
		// 非 JSON：直接对原文哈希（无法剥离，退化为精确匹配）
		return stableStringifyArgs(result).slice(0, maxLen);
	}
}

// ─── Ping-pong 检测（A→B→A→B 交替，对齐 openclaw）───────────────────────────
export interface IPingPongDetection {
	/** 尾部是否存在严格的两签名交替序列 */
	readonly pingPong: boolean;
	/**
	 * 两侧**结果各自稳定**（同一侧所有调用的 resultHash 相同且均已回填）。
	 * openclaw 要求此为真才升级为 critical —— 只有「来回换工具但结果都不变」
	 * 才是真的无进展；若结果在变，说明仍在推进，不应拦截。
	 */
	readonly noProgressEvidence: boolean;
	/** 交替序列长度（条数） */
	readonly length: number;
	/** 交替的两个工具名，便于日志与提示文案具体化 */
	readonly toolA?: string;
	readonly toolB?: string;
}

/**
 * 检测 A→B→A→B 式交替调用。
 *
 * 与 `detectToolCallLoop` 的区别：后者只看「同一签名重复」，而 ping-pong 是
 * **两个不同调用来回切换** —— 单独看每个签名都不重复，因此会被完全漏检。
 */
export function detectToolCallPingPong(
	history: ReadonlyArray<IToolCallHistoryEntry>,
	minLength: number = 4,
): IPingPongDetection {
	const n = history.length;
	if (n < minLength) { return { pingPong: false, noProgressEvidence: false, length: 0 }; }

	const sigAt = (i: number): string => `${history[i].name}:${history[i].argsHash}`;
	const lastSig = sigAt(n - 1);

	// 自倒数第二条往前找第一个不同于末条的签名，作为交替的另一侧
	let otherSig = '';
	for (let i = n - 2; i >= 0; i--) {
		const s = sigAt(i);
		if (s !== lastSig) { otherSig = s; break; }
	}
	if (!otherSig) { return { pingPong: false, noProgressEvidence: false, length: 0 }; }

	// 自尾部向前收集严格交替序列：末条为 lastSig，往前依次 other / last / other ...
	const seq: number[] = [n - 1];
	let expectOther = true;
	for (let i = n - 2; i >= 0; i--) {
		const want = expectOther ? otherSig : lastSig;
		if (sigAt(i) !== want) { break; }
		seq.push(i);
		expectOther = !expectOther;
	}
	if (seq.length < minLength) {
		return { pingPong: false, noProgressEvidence: false, length: seq.length };
	}

	// 两侧结果各自是否稳定（同侧 resultHash 唯一且都已回填）
	const sideStable = (sig: string): boolean => {
		let hash: string | undefined;
		for (const i of seq) {
			if (sigAt(i) !== sig) { continue; }
			const rh = history[i].resultHash;
			if (rh === undefined) { return false; }  // 结果未回填 → 证据不足，不升级
			if (hash === undefined) { hash = rh; }
			else if (hash !== rh) { return false; }
		}
		return hash !== undefined;
	};
	const noProgressEvidence = sideStable(lastSig) && sideStable(otherSig);

	return {
		pingPong: true,
		noProgressEvidence,
		length: seq.length,
		toolA: history[n - 1].name,
		toolB: history[seq[1]].name,
	};
}

// ─── 参数抖动检测（同一工具、参数各异、连续反复，对齐 openclaw argument_churn）────
export interface IArgumentChurnDetection {
	/** 尾部是否存在「同一工具 + 参数全不相同」的连续长串 */
	readonly churn: boolean;
	/** 该连续串的长度（条数） */
	readonly length: number;
	/** 抖动发生的工具名，便于日志与提示文案具体化 */
	readonly toolName?: string;
	/**
	 * 该串中不同参数的个数。等于 `length` 才说明「每次都换了参数」；
	 * 若小于 `length`，说明中间有重复 —— 那是 loop 的领域，本检测已让位（churn=false）。
	 */
	readonly distinctArgs: number;
}

/**
 * 检测「同一工具、参数各不相同、连续反复」的偏执试探形态。
 *
 * 与既有三种检测的分工（**互不重叠**）：
 *   · `detectToolCallLoop`    —— 同一签名重复（同工具 + 同参数）；
 *   · `detectToolCallPingPong`—— 两个不同签名严格交替；
 *   · 本函数                   —— **同一工具，参数每次都不一样**。
 *
 * 典型病灶：模型在 `terminal` 上反复微调命令（加个 `-la`、换个路径、改个引号），
 * 或对同一文件反复换参数 `file_read`，每次签名都不同，前两者全部漏检。
 *
 * ⚠ 误报防护：连续读**不同**文件、连续跑**不同**命令都是合法推进，形态上与本病灶
 * 完全一致。因此本函数只做**判定**，由调用方决定是注入引导还是拦截；
 * 且阈值（ARGUMENT_CHURN_THRESHOLD=5）刻意高于 loop 阈值，只在明显偏执时才触发。
 */
export function detectArgumentChurn(
	history: ReadonlyArray<IToolCallHistoryEntry>,
	threshold: number = RUN_STATE_LIMITS.ARGUMENT_CHURN_THRESHOLD,
): IArgumentChurnDetection {
	const none: IArgumentChurnDetection = { churn: false, length: 0, distinctArgs: 0 };
	// 阈值参数非法时不判定；但**不提前返回**，仍统计 length/distinctArgs ——
	// 这两个字段是诊断信息（调用方与测试依赖），只有在历史为空时才真的无从统计。
	if (threshold < 2) {
		return none;
	}
	if (history.length === 0) {
		return none;
	}

	const tailName = history[history.length - 1].name;
	// 自尾部向前收集「同一工具」的连续串；一遇到别的工具立即停止。
	// 只看工具名（不看参数）—— 参数正是本检测要观察的变量。
	const argsHashes = new Set<string>();
	let length = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].name !== tailName) {
			break;
		}
		argsHashes.add(history[i].argsHash);
		length++;
	}

	if (length < threshold) {
		return { ...none, length };
	}
	// 参数必须**两两不同**：出现重复说明存在 loop，交由 detectToolCallLoop 处理，
	// 本检测主动让位，避免同一现象被两个检测器重复上报。
	if (argsHashes.size !== length) {
		return { churn: false, length, distinctArgs: argsHashes.size, toolName: tailName };
	}

	return { churn: true, length, distinctArgs: argsHashes.size, toolName: tailName };
}

// ─── XML 文本工具调用泄漏检测 ────────────────────────────────────────────────
// 部分模型会把结构化工具调用写成 XML 纯文本（<tool_calls:xxx> / <arg_key:xxx>）
// 而非 native function call。本系统按设计不执行 XML 工具调用，且此时
// `classifyIncompleteTurn` 会因「有可见文本」判为 complete —— 既不续跑也不报错，
// 模型以为调用没生效而反复输出同样的 XML，最终聊天框堆满解析错误 UI。
// 只认**强特征**，避免把用户正常讨论代码的文本误判为泄漏。

/** 带冒号ID的伪XML标签（模型泄漏的标志性特征，正常代码几乎不可能出现） */
const XML_LEAK_TAGGED_ID_RE =
	/<\s*(?:tool_calls?|arg_key|arg_value|function_calls?|function_response|tool_use|invoke)\s*:\s*[\w-]+\s*>/i;
/** 成对的标准工具标签（要求开闭标签齐备，避免只出现单个 `<tool_call>` 字样即误判） */
const XML_LEAK_PAIRED_RE =
	/<\s*(tool_calls?|function_calls?|tool_use|invoke)\b[^>]*>[\s\S]{0,4000}?<\s*\/\s*\1\s*>/i;

/**
 * 检测 assistant 文本是否为「模型用 XML 纯文本写工具调用」的泄漏。
 * 纯函数：只读判定，无副作用。
 */
export function detectXmlToolCallLeak(text: string | undefined | null): boolean {
	if (!text) { return false; }
	return XML_LEAK_TAGGED_ID_RE.test(text) || XML_LEAK_PAIRED_RE.test(text);
}

/**
 * `<tag:id>` 形状伪标签的一次命中（**溯源诊断用**）。
 */
export interface ITaggedIdXmlHit {
	/** 标签名，如 `tool_calls` / `arg_key` / `tool_sep`。 */
	readonly tag: string;
	/** 冒号后的 ID，如 `6124c78e`。 */
	readonly id: string;
	/** 命中在原文本中的字符偏移。 */
	readonly index: number;
	/** 命中处前后各 40 字符的上下文（空白已折叠），用于人工判读来源。 */
	readonly snippet: string;
}

/**
 * 扫描 `<tag:id>` 形状的伪标签，**不限定标签名**。
 *
 * 与 `XML_LEAK_TAGGED_ID_RE` 的区别（刻意不同，别合并）：
 *   · 后者是**判定**用的白名单（只认已知的几个标签名），求**不误判**；
 *   · 本函数是**溯源**用的宽扫描（认任何 `<名称:ID>` 形状），求**不漏**——
 *     已知变体只有 tool_calls/arg_key/arg_value/tool_sep，但不能假设只有这些，
 *     溯源阶段漏掉未知变体等于白扫。
 * 二者用途相反：**宽扫描的结果不得直接当作「已确认泄漏」**（它认任何 `<名称:ID>` 形状）。
 *
 * ⚠ 2026-09-16 更正：原注释有两处与实现不符，按事实改写 ——
 *   ① 原文称 ID 限定为「6+ 位十六进制 / 纯数字」**可滤掉** `http:8080` 之类正常文本：
 *      **不成立** —— `http` 是合法标签名、`8080` 命中 `\d+` ⇒ 它会被匹配；
 *   ② 原文称本「不可用于改写」：实际紧随其后的 `stripTaggedIdXmlTags` 就是用它改写，
 *      且 `assistantVisibleText` 的展示清洗**刻意**按形态整体剥离（其注释：逐个枚举
 *      标签名永远追不上模型的新变体，`tool_sep` 正是漏掉的那个）。
 *   ⇒ **保留宽剥离是刻意的**：形状本身就是 priming 源（模型模仿的是形状，不是某个名字），
 *      ToolResult 回灌路径（2026-09-16）与助手文本展示路径都按此口径。已知代价 =
 *      极少数 `<名称:数字>` 正常文本也会被换成占位符；可接受，因为占位符明确写着
 *      「此处有一段 XML 形式的工具调用写法，已移除」，属可见替换而非静默篡改。
 */
const TAGGED_ID_SCAN_RE = /<\s*\/?\s*([A-Za-z_][\w.-]*)\s*:\s*([0-9a-fA-F]{6,}|\d+)\s*>/g;

/**
 * 把文本中所有 `<tag:id>` 形状伪标签替换为一句**不含标签名**的说明。
 *
 * 用于切断跨会话传播：日志 1788011997897 实证，SubAgent 通过 `delegate_task`
 * 回灌的 6772c 结果里带着 `tool_calls:6124c78e`，进入主会话 `msg[7](role=tool)`
 * 后，**后续每一轮**都被重新发给模型（iter=2..7 次次命中 PRIMING suspected），
 * 形成持续污染。故工具结果在回灌前必须先剥离。
 *
 * 替换文本刻意**不保留标签名与 ID** —— 占位符里若仍写着 `tool_calls:6124c78e`，
 * 等于把格式原样再喂一遍，priming 风险并未消除；但也不直接删空，否则模型看到
 * 内容无故缺失会困惑。故统一替换为一句中性说明。
 *
 * 纯函数，不改动入参。
 */
/** 一段 Markdown 代码区（围栏块或行内代码）的字符区间。 */
export interface ICodeRegion {
	readonly start: number;
	readonly end: number;
}

/** 围栏代码块的起始行：行首至多 3 空格 + 3 个以上反引号或波浪号。 */
const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*/gm;
/** 行内代码：N 个反引号开始，直到同样 N 个反引号结束。 */
const INLINE_CODE_RE = /(`+)(?!`)[\s\S]*?\1/g;

/**
 * 找出文本中所有 Markdown 代码区（围栏块 + 行内代码）。
 *
 * 用途：sanitize 时**跳过**代码区内的命中。模型在回答里**举例讨论**工具调用
 * 语法（例如对比几个项目的提示词格式）是正当的技术讨论，用户要看的就是这段
 * 内容；若连代码块里的示例一起抹掉，等于把用户想看的答案删了。
 * 参照 openclaw `src/shared/text/code-regions.ts` 的同名机制
 * （其测试明确验证 "preserves ... inside inline and fenced code"）。
 *
 * 纯函数、不改动入参。返回的区间按 start 升序且不重叠（围栏优先，行内补漏）。
 */
export function findCodeRegions(text: string): ICodeRegion[] {
	if (!text) { return []; }
	const regions: ICodeRegion[] = [];

	// ─── 1. 围栏代码块：成对配对，未闭合的算到文本末尾 ──────────────────
	// CommonMark 规定结束围栏需同字符且长度 ≥ 开始围栏。逐个扫描标记行再配对，
	// 比一个正则惰性匹配更可靠（惰性 + `$` 会提前匹配空串，导致区间失效）。
	const open: { start: number; char: string; len: number }[] = [];
	FENCE_LINE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FENCE_LINE_RE.exec(text)) !== null) {
		const char = m[1].charAt(0);
		const len = m[1].length;
		const last = open[open.length - 1];
		if (last && last.char === char && len >= last.len) {
			open.pop();
			regions.push({ start: last.start, end: m.index + m[0].length });
		} else {
			open.push({ start: m.index, char, len });
		}
	}
	for (const o of open) {
		regions.push({ start: o.start, end: text.length });
	}

	// ─── 2. 行内代码：仅补在未被围栏覆盖的位置 ──────────────────────────
	INLINE_CODE_RE.lastIndex = 0;
	while ((m = INLINE_CODE_RE.exec(text)) !== null) {
		if (m[0].length === 0) { INLINE_CODE_RE.lastIndex++; continue; }
		const start = m.index;
		if (isInsideCode(start, regions)) { continue; }
		regions.push({ start, end: start + m[0].length });
	}

	regions.sort((a, b) => a.start - b.start);
	return regions;
}

/** 判断字符偏移是否落在任一代码区内。 */
export function isInsideCode(pos: number, regions: readonly ICodeRegion[]): boolean {
	return regions.some(r => pos >= r.start && pos < r.end);
}

export function stripTaggedIdXmlTags(
	text: string | undefined | null,
	replacement: string = '[此处有一段 XML 形式的工具调用写法，已移除]',
): string {
	if (!text) { return text ?? ''; }
	TAGGED_ID_SCAN_RE.lastIndex = 0;
	return text.replace(TAGGED_ID_SCAN_RE, replacement);
}

/**
 * 定位文本中所有 `<tag:id>` 形状伪标签，返回前 `maxHits` 个命中。
 * 纯函数、无副作用；注意内部正则带 `g` 标志，每次调用会重置 lastIndex。
 */
export function locateTaggedIdXmlTags(
	text: string | undefined | null,
	maxHits: number = 3,
): ITaggedIdXmlHit[] {
	if (!text) { return []; }
	const hits: ITaggedIdXmlHit[] = [];
	TAGGED_ID_SCAN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TAGGED_ID_SCAN_RE.exec(text)) !== null) {
		const start = Math.max(0, m.index - 40);
		hits.push({
			tag: m[1],
			id: m[2],
			index: m.index,
			snippet: text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' '),
		});
		if (hits.length >= maxHits) { break; }
	}
	return hits;
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
 * 工具调用在协议层丢失（finish_reason=tool_calls 但 0 tool call）续跑次数上限。
 *
 * ★ 2026-08-31：2 → 3。
 * 依据（日志 1788153924357）：本类是**传输层瞬时故障**（provider→renderer 映射丢包），
 * 重试成功率高 —— 实测 3 次丢失中重试救回 2 次（67%）。而 reasoning-only / empty /
 * length 属于模型行为问题，重试价值低，故保持 2 不动。
 *
 * ⚠ 语义（重要）：本上限是**单次 turn 内跨 iteration 累计**，重试成功后**不重置**
 * —— 见 agentTurnExecutor.ts 计数器声明处注释（「单次 turn 内跨 iteration 累计，
 * 达到上限即放弃续跑」，刻意设计）。即：一个 turn 内总共最多续跑 3 次，而**不是**
 * 「连续失败 3 次才放弃」。日志佐证：第一次 `attempt=1/2` 重试成功后，第二次丢失
 * 直接就是 `attempt=2/2`，而非回到 `1/2`。
 *
 * ⚠ 阶梯复用：resolveRecoveryInstruction 只有两级（attempt<2 → L1 soft remind，
 * attempt>=2 → L2 final chance）。故 attempt=2 与 attempt=3 **共用 L2 文案**，
 * 而 L2 写着「LAST CHANCE … will end this turn immediately」。换言之第 2 次就会
 * 告知模型「最后机会」，但实际还剩 1 次。副作用可接受（更早施加压力，且不会
 * 让模型以为可以无限空转）；若要严格对齐需把 limit 传进阶梯函数并拆出 L3。
 */
export const DEFAULT_TOOL_CALL_LOST_RETRY_LIMIT = 3;

/**
 * 尾部**结构**截断（finishReason=stop 但末行明显没写完）续写次数上限。
 *
 * 取 1（其他类是 2）：本判据是**结构启发式**，存在误判可能（见 `detectTruncatedTail`
 * 的「已知代价」）⇒ 只给一次机会，误判时最多多花一轮；而 `length` 是 provider 的
 * 权威信号（模型确实被输出上限截住），保留 2 次。
 */
export const DEFAULT_TRUNCATED_TEXT_RETRY_LIMIT = 1;

/**
 * 尾部「明显没写完」的结构判据（2026-09-18）。
 *
 * ## 为什么需要
 * 上游会**在没有截断信号的情况下提前收尾**。实证（用户报「llm 显示的信息尾部被截断」，
 * 会话 `sess_mu3n6ll4_kahic6` 的 msg `…_4_4x2yz`）：
 *   · 落盘与 UI 的文本都停在 `…防止下一轮再按陈旧计划做重复劳动。\n\n## 剩`；
 *   · 我方剥离前的原始 delta 也停在同一处（`[AgentDriver] RAW model output … tail="…## 剩"`）；
 *   · provider 侧 SSE 抓包 `[345] finish_reason:"stop"` 紧跟最后一个内容块
 *     （`outputTokens=345`，离输出上限极远）。
 * ⇒ 三方一致：**上游自己停了**，不是我方丢包/渲染截断。而 `classifyIncompleteTurn`
 * 对这种轮次只能判 `complete`（有可见文本 + stop）⇒ 用户看到半句话，我方不做任何补救。
 *
 * ## 判据的性质（务必保持）
 * 只看**结构**：末尾是不是「刚开始写就断了」的 Markdown 片段。刻意**不**做
 * 「像不像是总结/承诺/未完成的意图」这类自然语言语义判断（本模块既有纪律）。
 *
 * ## 规则（任一命中即视为截断）
 *   1. `unclosed-code-fence` —— ``` / ~~~ 围栏计数为奇数（开了没关）；
 *   2. `dangling-heading`     —— 末行是 `#{1,6}` + 至多 1 个可见字符（如 `## 剩`）；
 *   3. `dangling-list-marker` —— 末行只有列表/引用标记（`-` / `1.` / `>` …）；
 *   4. `dangling-table-rule`  —— 末行是表格分隔行（`|---|`）—— 表头写了、行还没写。
 *
 * ## 已知代价（刻意接受，故上限只有 1 次）
 * 极少数「完整答复的末行恰好是 1 字标题 / 空列表项 / 未闭合围栏示例」会被误判 ⇒
 * 触发**一次**续写；续写指令明确要求「不要重写已有内容」。相比「半句话静默交付」，可接受。
 */
export type TruncatedTailReason =
	| 'unclosed-code-fence'
	| 'dangling-heading'
	| 'dangling-list-marker'
	| 'dangling-table-rule';

export function detectTruncatedTail(text: string): TruncatedTailReason | null {
	if (!text) { return null; }
	const body = text.replace(/\s+$/, '');
	if (!body) { return null; }
	const lines = body.split('\n');

	// ① 未闭合围栏：整段计数（截断可能把闭合围栏切掉，或只留下半个标记）
	let fences = 0;
	for (const line of lines) {
		if (/^\s{0,3}(?:```|~~~)/.test(line)) { fences++; }
	}
	if (fences % 2 === 1) { return 'unclosed-code-fence'; }

	// 末行判据：取最后一个非空行
	let last = '';
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim().length > 0) { last = lines[i].trim(); break; }
	}
	if (!last) { return null; }
	// ② 悬空标题：`##` 后至多 1 个字符（本次事故正是 `## 剩`）
	if (/^#{1,6}[ \t]*\S?$/.test(last)) { return 'dangling-heading'; }
	// ③ 悬空列表 / 引用标记
	if (/^(?:[-*+]|\d{1,3}[.)]|>)[ \t]*$/.test(last)) { return 'dangling-list-marker'; }
	// ④ 表格分隔行（`|---|` / `|:--:|`）落在末行 = 表格还没开始写
	if (last.includes('|') && /^\|?[\s:|-]*-[\s:|-]*\|?$/.test(last)) { return 'dangling-table-rule'; }
	return null;
}

/**
 * 尾部截断的**续写**指令（刻意不复用 `resolveRecoveryInstruction` 那套「无进展」阶梯）。
 *
 * 与前四类的本质差别：那几类要模型**换一种做法**（去调工具 / 给结论），文案以
 * 「NO PROGRESS … you MUST …」开头；本类是「你写得好，只是被中断了」——若照搬那套文案，
 * 模型会以为自己做错了而**重来一遍**，结果是把半截答复丢掉、整段重写
 * （用户看到的仍是「同一段内容被重放」，与 2026-08 那次 reflect 措辞事故同族）。
 * 故此处明确三条：从中断处继续 / 不要重写 / 若其实已写完就回一行 DONE（可自证结束）。
 */
export function resolveTruncatedTextContinuationInstruction(attempt: number = 1): string {
	const lines = [
		'<system-reminder>',
		'Your previous reply was cut off mid-way — the text stops in the middle of a structure',
		'(e.g. right after a heading marker, or inside an unclosed code fence).',
		'Continue EXACTLY from where it stopped:',
		'- Do NOT restart, and do NOT repeat or re-summarize anything you already wrote.',
		'- Do NOT apologize or explain what happened; just resume the remaining content.',
		'- Keep the same formatting/structure you were using.',
		'If the reply was in fact already complete, reply with the single short line: DONE',
		'</system-reminder>',
	];
	if (attempt >= 2) {
		lines.splice(
			lines.length - 1, 0,
			'LAST CHANCE — another incomplete reply ends this turn immediately.',
		);
	}
	return lines.join('\n');
}

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

/**
 * 上下文溢出错误检测（对齐 OpenClaw `isContextOverflow`）。
 * HTTP 400 code 11133 / invalid_parameter_value / context_length_exceeded /
 * token overflow 等均判定为「输入超服务端 maxInputTokens」或「消息结构非法」。
 * 供 agentTurnExecutor 在流失败后触发「反应式压缩 + 自动重试」（P0-1）。
 */
export function isContextOverflowError(error: unknown): boolean {
	if (!(error instanceof Error)) { return false; }
	const msg = error.message;
	// IOA 网关溢出：code 11133 / invalid_parameter_value（contextManager 注释确认二者即溢出）
	if (msg.includes('11133') || msg.includes('invalid_parameter_value')) { return true; }
	// OpenAI 风格
	if (msg.includes('context_length_exceeded') || msg.includes('maximum context length')) { return true; }
	// Anthropic 风格 / 通用 token 溢出
	if (msg.includes('prompt is too long') || msg.includes('token overflow') || msg.includes('too many tokens')) { return true; }
	return false;
}

/** 未完成轮分类结果。对齐 MiMo StepClassification + classifyAssistantStep。
 *
 * `tool-call-lost`（2026-08-28 新增）：协议异常——provider 上报 finish_reason=
 * 'tool_calls'（模型声明已发出工具调用），但本轮实际未收到任何 tool call。
 * 典型成因见 extensions/codebuddy-provider 的 delta.content 提前 return 遮蔽同帧
 * tool_calls（日志 1787882646767）。此时模型意图未完成，必须续跑而非判 complete。 */
/**
 * `truncated-text`（2026-09-18 新增，判据见 `detectTruncatedTail`）：**有可见文本**
 * 但末行处于「刚开始写就断了」的 Markdown 结构 —— 上游以 `finish_reason=stop` 提前收尾
 * 的典型形态（实证见 `detectTruncatedTail` 注释）。与前几类的关键差别：本轮文本是
 * **有效产物**（不是空响应/幻觉/过渡话术）⇒ 续写时**不得** `discard_prior_text`，
 * 指令是「从中断处接着写」而非「换个做法」（见 `resolveTruncatedTextContinuationInstruction`）。
 */
export type IncompleteTurnKind = 'complete' | 'length' | 'tool-call-lost' | 'truncated-text' | 'reasoning-only' | 'empty' | 'filtered' | 'failed';

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
	// ── 协议一致性检查（2026-08-28，日志 1787882646767）──────────────────
	// finish_reason='tool_calls' 是模型「已发出工具调用」的权威声明。若此时
	// 一个 tool call 都没收到，说明工具调用在 provider→renderer 映射中丢失
	// （而非模型真的只想说话）。必须**先于** hasVisibleText 判定：此类轮次
	// 恰恰伴随「我来看一下/让我确认」这类意图文本（模型边说边发），若被
	// hasVisibleText 短路成 complete，agent loop 就会在任务中途静默结束。
	if (params.finishReason === 'tool_calls' && !params.hasToolCalls) {
		return 'tool-call-lost';
	}
	// ── finishReason 权威信号（★ 2026-09-18 顺序修正）────────────────────
	// `length` / `max_tokens` 是 provider 明确宣告「模型没写完、被输出上限截住」。
	// 它必须**先于** hasVisibleText 判定 —— 旧顺序把「有可见文本」一律当完成，
	// 于是「写了半篇就被截断」这种最典型的截断永远判 complete：
	// `DEFAULT_LENGTH_TRUNCATED_RETRY_LIMIT` 那套续跑阶梯成了死代码，而
	// `languageModelsBridge` 里捕获 finish_reason 的注释写明用途正是
	// 「使 classifyIncompleteTurn 能检测 length 截断」⇒ 注释承诺被实现顺序废掉。
	// ⚠ 调用方约束：`length` **可能伴随可见文本** ⇒ 续写时不得 `discard_prior_text`
	//   （见 `incompleteTurnDiscardReason`），否则半篇答复会被丢掉让模型重写。
	const fr = params.finishReason;
	if (fr === 'length' || fr === 'max_tokens' || fr === 'max_completion_tokens') { return 'length'; }
	if (params.hasVisibleText) { return 'complete'; }
	if (fr === 'content_filter' || fr === 'content-filter') { return 'filtered'; }
	if (fr === 'error') { return 'failed'; }
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
	// 尾部截断：**不是**「无进展」阶梯（那套文案会让模型重写整段），见该函数注释。
	case 'truncated-text': return resolveTruncatedTextContinuationInstruction(attempt ?? 1);
		case 'reasoning-only': return resolveRecoveryInstruction('reasoning-only', attempt ?? 1);
		case 'empty': return resolveRecoveryInstruction('empty', attempt ?? 1);
		// 工具调用丢失：模型声明要调工具但一个都没送达 → 语义等同「未推进」，
		// 复用 empty 阶梯（要求立刻给出工具调用或可见结论）。
		case 'tool-call-lost': return resolveRecoveryInstruction('empty', attempt ?? 1);
		case 'filtered': case 'failed': return null;
		default: return null;
	}
}

export function incompleteTurnDiscardReason(
	kind: IncompleteTurnKind,
): 'unfinished-intent' | 'empty-recovery' | 'filtered' | 'failed' | undefined {
	switch (kind) {
		// ★ 2026-09-18：`length` / `truncated-text` 一律**保留**本轮文本（返回 undefined）。
		// 这两类的可见文本是**有效产物**（只是没写完）：丢弃会让模型把整段重写完
		// （用户看到同一段内容被重放），并把用户眼前已显示的内容清空；而它们的续跑
		// 指令本就写着「从中断处继续、不要从头再来」。
		case 'length':
		case 'truncated-text':
			return undefined;
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
		case 'truncated-text': return DEFAULT_TRUNCATED_TEXT_RETRY_LIMIT;
		case 'tool-call-lost': return DEFAULT_TOOL_CALL_LOST_RETRY_LIMIT;
		default: return 0;
	}
}

/**
 * 重试用尽后展示给用户的可见说明（2026-08-29，日志 1787969405928）。
 *
 * 背景：续跑次数耗尽时，执行器只 `discard_prior_text` 后**静默结束** —— 界面上
 * 只剩一个空的 assistant 气泡，用户完全不知道发生了什么，主观感受就是「发消息
 * 没反应 / 卡住了」，而真实原因常常是模型侧不可用（实测事故：模型 `hy4-dev` 不在
 * 网关 allow-list，首个 delta 即 `type=error`，连败 3 轮、每轮 `textLen=0`）。
 *
 * 返回 null 表示无需打扰用户（例如内容被安全策略过滤这类预期内情况）。
 */
export function incompleteTurnUserNotice(
	kind: IncompleteTurnKind,
	finishReason?: string | null,
): string | null {
	switch (kind) {
		case 'empty':
			return '⚠️ 本次请求未获得模型返回内容（已自动重试至上限）。\n\n' +
				'常见原因：当前模型暂时不可用或不被网关允许、网络/网关异常。\n\n' +
				'建议：切换到其他模型后重试；详情见输出面板日志（搜索 `FIRST delta is ERROR`）。' +
				(finishReason ? `\n\n（finishReason=${finishReason}）` : '');
		case 'tool-call-lost':
			return '⚠️ 模型声明要调用工具，但工具调用在传输过程中丢失（已自动重试至上限）。\n\n' +
				'这通常是 provider 协议映射问题，建议切换模型或稍后重试。' +
				(finishReason ? `\n\n（finishReason=${finishReason}）` : '');
		case 'length':
			return '⚠️ 回复被长度上限截断，且续写至上限后仍不完整。\n\n建议：精简问题或拆分任务后重试。' +
				(finishReason ? `\n\n（finishReason=${finishReason}）` : '');
		case 'truncated-text':
			return '⚠️ 上一条回复在写到一半时被上游提前结束（模型侧 stop，非长度上限），' +
				'已自动接着写但仍未补全。\n\n建议：回一句「继续」让它接着写，或把问题拆小后重问。' +
				(finishReason ? `\n\n（finishReason=${finishReason}）` : '');
		case 'reasoning-only':
			return '⚠️ 模型只产出了思考过程、未给出可见答复（已自动重试至上限）。\n\n建议：换个说法重试，或切换模型。' +
				(finishReason ? `\n\n（finishReason=${finishReason}）` : '');
		case 'filtered':
		case 'failed':
		default:
			return null;
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

/**
 * 恢复失败的分类（供调用方决策：记日志、丢弃、还是按新会话继续）。
 *
 * 之所以返回**分类**而不是布尔：调用方需要区分「没有 checkpoint」与
 * 「checkpoint 存在但格式不可用」—— 前者是常态（新会话），后者是数据问题，
 * 静默吞掉会让旧格式快照永久滞留且无人知晓。
 */
export type AgentRunStateRestoreFailure =
	/** 不是对象 / 无 state 字段 */
	| 'malformed'
	/** version 高于本版本（未来格式，拒绝） */
	| 'version-too-new';

export interface AgentRunStateRestoreResult {
	readonly state: AgentRunState;
	/** 成功时为 undefined；失败时为分类，调用方据此决定是否记日志 / 清理 */
	readonly failure?: AgentRunStateRestoreFailure;
	/** 失败时携带原始 version（仅诊断用），无法解析时为 undefined */
	readonly sourceVersion?: number;
}

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
function extractRawState(input: unknown): { raw?: Record<string, unknown>; failure?: AgentRunStateRestoreFailure; sourceVersion?: number } {
	if (!isPlainObject(input)) { return { failure: 'malformed' }; }
	// 快照形态 { version, state }
	if (isPlainObject((input as Record<string, unknown>).state)) {
		const v = (input as Partial<AgentRunStateSnapshot>).version;
		if (typeof v === 'number' && v > AGENT_RUN_STATE_VERSION) {
			return { failure: 'version-too-new', sourceVersion: v }; // 未知 / 过高版本 → 拒绝
		}
		return { raw: (input as Record<string, unknown>).state as Record<string, unknown>, sourceVersion: v };
	}
	// 裸 AgentRunState（或 partial state）
	return { raw: input as Record<string, unknown> };
}

export function restoreRunState(input: unknown): AgentRunState {
	return restoreRunStateDetailed(input).state;
}

/**
 * 同 `restoreRunState`，但额外返回失败分类（见 `AgentRunStateRestoreFailure`）。
 * 需要区分「无 checkpoint」与「checkpoint 格式不可用」的调用方用这个版本。
 * 两者共用同一实现，保证行为一致 —— 不要各自复制一份解析逻辑。
 */
export function restoreRunStateDetailed(input: unknown): AgentRunStateRestoreResult {
	const { raw, failure, sourceVersion } = extractRawState(input);
	if (!raw) {
		return { state: createInitialRunState({}), failure: failure ?? 'malformed', sourceVersion };
	}
	return { state: normalizeRunState(raw as Partial<AgentRunState>), sourceVersion };
}

const VALID_PHASES: ReadonlyArray<StreamPhase> = [
	'idle', 'llm_streaming', 'tool_executing', 'awaiting_approval', 'retrieving', 'compressing', 'error',
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
		// 逐字段窄化而非整体 `...raw.guardrails`：旧 checkpoint 无此字段（须回落默认），
		// 且部分字段写坏的快照不应污染其余计数。
		guardrails: normalizeGuardrailCounters(raw.guardrails, base.guardrails),
		// 同姿态：旧 checkpoint 无 wrapUp 字段，须回落默认而非透传 undefined。
		wrapUp: normalizeWrapUpState(raw.wrapUp, base.wrapUp),
		// 同姿态：旧 checkpoint 无 retry 字段，须回落默认而非透传 undefined。
		retry: normalizeRetryCounters(raw.retry, base.retry),
		reflectCount: typeof raw.reflectCount === 'number' ? raw.reflectCount : base.reflectCount,
		hasModifiedFiles: typeof raw.hasModifiedFiles === 'boolean' ? raw.hasModifiedFiles : base.hasModifiedFiles,
		toolCallHistory: Array.isArray(raw.toolCallHistory) ? (raw.toolCallHistory as AgentRunState['toolCallHistory']) : base.toolCallHistory,
		startedToolIds: Array.isArray(raw.startedToolIds) ? raw.startedToolIds : base.startedToolIds,
		endedToolIds: Array.isArray(raw.endedToolIds) ? raw.endedToolIds : base.endedToolIds,
		lastRealPromptTokens: typeof raw.lastRealPromptTokens === 'number' ? raw.lastRealPromptTokens : base.lastRealPromptTokens,
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
