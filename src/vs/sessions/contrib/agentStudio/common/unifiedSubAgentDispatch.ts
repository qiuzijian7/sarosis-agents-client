/*---------------------------------------------------------------------------------------------
 *  Unified SubAgent Dispatch
 *
 *  Unifies the three previous dispatch paths into a single coherent architecture:
 *  1. SubAgentManager (common/) — lightweight budget-aware execution
 *  2. TaskOrchestrationService (browser/) — DAG-based orchestration
 *  3. delegate_task tool — LLM autonomous delegation (was a stub)
 *
 *  Design principles (inspired by OpenCode):
 *  - SubAgentType determines tool permissions (explore=readonly, general=readwrite, scout=external)
 *  - IterationBudget from SubAgentManager is retained for resource control
 *  - TaskOrchestrationService delegates actual execution here
 *  - delegate_task tool routes through TaskOrchestrationService.createPlan()
 *
 *  Execution model (Effect-TS-style, see ./effectRuntime.ts):
 *  - Each sub-agent runs as a forked Fiber with a per-instance InterruptSignal
 *    (created in createSubAgent, so interruptSubAgent works pre/post start).
 *  - Timeout / retry / parallel fan-out use the timeout / retry / forEachPar
 *    combinators instead of hand-rolled Promise.race + retry maps + batching.
 *  - Watchdog disposal and parent-abort unlistening are Scope finalizers —
 *    deterministic cleanup, no manual finally blocks, no dangling timers.
 *--------------------------------------------------------------------------------------------*/

import { IterationBudget } from './iterationBudget.js';
import { fork, retry, timeout, forEachPar, FiberInterrupt, InterruptSignal, isFiberInterrupt, type FiberExit, type IFiberContext } from './effectRuntime.js';
import type { IAgentTurnRequest, IChatStreamDelta, IChatMessage, IModelSelection } from './providers.js';
import { SubagentTokenCollector, type SubagentTokenUsage } from './subagentTokenCollector.js';
import { GLOBAL_SYSTEM_SUFFIX, GLOBAL_SYSTEM_PREFIX_SUBAGENT } from './chatModeConfig.js';
import { composeFrozenPrefix, joinSections } from './systemPromptComposer.js';
import { buildResponseLanguageDirective } from './responseLanguage.js';
import { gateResult, extractAcceptanceCriteria, type ISubAgentStructuredResult, type ICompletionGateContext } from './completionGate.js';
import { injectReturnFormatIntoTask } from './subAgentReturnFormat.js';
import { wrapUserQuery } from './userQuery.js';
import { decideTaskGate, MAX_TASK_GATE_SUBAGENT_REACT, type IIncompleteTask, type TaskGateDecision } from './taskGate.js';
import { StallWatchdog } from './stallWatchdog.js';
import { defaultPostStopDecision, type ISubAgentPostStopHook } from './subAgentHooks.js';
import { type IForkContext } from './forkContext.js';

// ─── SubAgent Types (inspired by OpenCode's agent types) ──────────────────

/**
 * SubAgent type determines the permission profile and tool access.
 * Aligned with OpenCode's explore/general/scout pattern.
 */
export const enum SubAgentType {
	/** Read-only codebase explorer — can search_code/glob/read, cannot edit or execute */
	Explore = 'explore',
	/** General-purpose agent — can read and write, but cannot spawn sub-agents */
	General = 'general',
	/** External research agent — can clone repos and fetch web, read-only */
	Scout = 'scout',
}

/**
 * B：探索型子代理的「真正探索类工具」集合（ground-truth 判定依据）。
 * 覆盖 3 个只读 explore agent 的实际工作面：
 *   - code-explorer：代码图谱/文件/搜索工具
 *   - researcher：web 搜索/抓取
 *   - data：代码执行
 * 不含 index_repository / index_status 等索引管理工具，以及 memory/task 等元工具——
 * explore 子代理只调用了这些，视为"未真正探索"（_buildGateContext 据此降级）。
 */
const _EXPLORE_REAL_TOOLS: ReadonlySet<string> = new Set([
	// code-explorer — 代码图谱结构化检索
	'search_graph', 'query_graph', 'get_code_snippet', 'trace_path',
	'get_architecture', 'get_graph_schema', 'check_index_coverage',
	// code-explorer — 文件/文本检索
	'search_files', 'file_read', 'search_code',
	// researcher — web 检索
	'web_search', 'web_extract',
	// data — 代码执行（terminal 是真实实现；execute_code 是 stub 占位）
	'terminal',
]);

/**
 * Tool permission profile for each SubAgent type.
 * Inspired by OpenCode's permission system.
 */
export const SUB_AGENT_PERMISSIONS: Record<SubAgentType, {
	readonly canRead: boolean;
	readonly canWrite: boolean;
	readonly canExecute: boolean;
	readonly canWebFetch: boolean;
	readonly canWebSearch: boolean;
	readonly canCloneRepo: boolean;
	readonly canSpawnSubAgent: boolean;
	readonly allowedToolPatterns: readonly string[];
	readonly deniedToolPatterns: readonly string[];
}> = {
	[SubAgentType.Explore]: {
		canRead: true,
		canWrite: false,
		canExecute: false,
		canWebFetch: true,
		canWebSearch: true,
		canCloneRepo: false,
		canSpawnSubAgent: false,
		allowedToolPatterns: ['search_code', 'glob', 'list', 'read', 'webfetch', 'websearch', 'repo_overview'],
		deniedToolPatterns: ['*'],
	},
	[SubAgentType.General]: {
		canRead: true,
		canWrite: true,
		canExecute: true,
		canWebFetch: true,
		canWebSearch: true,
		canCloneRepo: false,
		canSpawnSubAgent: false,  // P0: 禁止 subagent 嵌套调 subagent
		allowedToolPatterns: ['*'],
		deniedToolPatterns: ['todowrite'],
	},
	[SubAgentType.Scout]: {
		canRead: true,
		canWrite: false,
		canExecute: false,
		canWebFetch: true,
		canWebSearch: true,
		canCloneRepo: true,
		canSpawnSubAgent: false,
		allowedToolPatterns: ['search_code', 'glob', 'list', 'read', 'webfetch', 'websearch', 'repo_overview', 'repo_clone'],
		deniedToolPatterns: ['*'],
	},
};

// ─── SubAgent Type Labels（delegate_task schema 的单一来源 — P2c 动态枚举）──
// 之前 delegate_task 的 inputSchema.type.enum 与 resolveType 各自硬编码了
// ['General','Explore','Scout'] 字面量，新增子 agent 类型（如 Critic/Planner）
// 时极易漏改导致 schema 与运行时漂移。此处集中为唯一来源：
//   - delegate_task 的 enum / 描述由这里动态生成
//   - handler 的 label→SubAgentType 反查也由这里完成
// 新增类型只需在数组追加一项，schema 与路由自动同步。
export interface ISubAgentTypeLabel {
	readonly value: SubAgentType;
	/** 暴露给 LLM 的显示标签（首字母大写，与历史 schema 兼容） */
	readonly label: string;
	/** 该角色的权限/用途简述，拼进 schema description */
	readonly description: string;
}

export const SUB_AGENT_TYPE_LABELS: ReadonlyArray<ISubAgentTypeLabel> = [
	{ value: SubAgentType.General, label: 'General', description: 'General-purpose (default) — can read+write+execute for build/edit/review work.' },
	{ value: SubAgentType.Explore, label: 'Explore', description: 'Read-only investigation / code search — also the batch-mode default.' },
	{ value: SubAgentType.Scout, label: 'Scout', description: 'Read-only external research — clone repos and fetch web/docs.' },
];

/** label（大小写不敏感）→ SubAgentType；未知/缺省回退 General。P2c 动态枚举反查。 */
export function resolveSubAgentTypeLabel(label?: string): SubAgentType {
	const hit = SUB_AGENT_TYPE_LABELS.find(
		(t) => t.label.toLowerCase() === (label ?? '').trim().toLowerCase(),
	);
	return hit?.value ?? SubAgentType.General;
}

// ─── SubAgent Isolation Level (P2b 显式两档隔离模型) ─────────────────────
// 之前系统只有一种隐式的「层级委派」模型——delegate_task / swarm worker 都复用
// 同一 dispatch，父 turn 的 AbortSignal 无差别级联取消子代 (P3)。但在 multi-agent
// safety 语境下应显式区分两种隔离档位 (对应 MiMo/AG2 supervisor-subagent vs swarm peer):
//
//  - 'subagent' (默认): 层级受控。继承父 worktree、父可注入上下文、父 turn abort
//    级联取消 (P3)。单向数据流，父完全掌控子生命周期。
//  - 'peer': 对等独立。peer 之间互不信任，只通过显式注入的 context (blackboard /
//    SharedMemory) 通信，**不**继承父的敏感上下文/worktree；更重要的是，父自己的
//    turn 结束 (abort) **不**级联取消 peer —— 父只是派了个对等协作者出去，其生命周期
//    独立，只有显式的 interruptSubAgent / swarm.cancelSwarm 才能停它。
//
// 两档在类型系统与安全契约上显式区分；未来新增隔离档位 (如 'sandbox') 只需在此追加。
export type SubAgentIsolationLevel = 'subagent' | 'peer';

/** label（大小写不敏感）→ SubAgentIsolationLevel；未知/缺省回退 'subagent'。P2b。 */
export function resolveIsolationLevel(label?: string): SubAgentIsolationLevel {
	const v = (label ?? '').trim().toLowerCase();
	return v === 'peer' ? 'peer' : 'subagent';
}

// ─── 结构化预览（工具 args/result 的卡片展示）─────────────────────────────

/** 解包 [{"type":"text","text":"…"}] 内容包装 → 拼接内层文本；非包装原样返回。 */
function unwrapTextWrapper(text: string): string {
	const t = text.trim();
	if (!t.startsWith('[')) { return text; }
	try {
		const parsed = JSON.parse(t);
		if (Array.isArray(parsed) && parsed.length > 0
			&& parsed.every(e => e !== null && typeof e === 'object'
				&& (e as { type?: unknown }).type === 'text'
				&& typeof (e as { text?: unknown }).text === 'string')) {
			return parsed.map(e => (e as { text: string }).text).join('\n');
		}
	} catch { /* not JSON */ }
	return text;
}

/**
 * 结构化预览截断（模块级导出以便单测；trace 事件的 argsPreview/resultPreview 共用）。
 * 规则：
 * 1. 先解 [{"type":"text","text":…}] 内容包装——否则 >maxLen 的数组结果会走顶层
 *    key 预算，产出 {"0":"{\"type\":\"text\"…}"} 的索引键垃圾，UI 显示成 "0"
 *    （2026-07-26 子代理卡片"搜索内容显示 0"事故）。
 * 2. search_code 类信封（{results:[…]}/{files:[…]}）→ 语义摘要（"N 命中: a.cpp:10, …"）。
 *    2026-07-27 事故：results 数组超预算被折叠成字符串 "[object]"（`[${typeof val}]`
 *    对数组 typeof==='object'），且最终 JSON.stringify 可能超 maxLen 被硬切成无效 JSON，
 *    下游 parse 失败退化为原始乱码——卡片同时出现 4 种样式。
 * 3. 对象 → 顶层 key 保留，value 按预算截断；超预算值类型感知占位
 *    （数组 [N 项]、对象 {M keys}，绝不产出 "[object]"）。
 * 4. 非 text 包装数组 → 元素摘要（前 3 项 + 项数），不泄露索引键。
 * 5. 非 JSON → 纯文本截断。
 */
export function previewStructured(text: string, maxLen: number): string {
	if (!text) { return text; }
	const unwrapped = unwrapTextWrapper(text);
	// search_code 类信封优先（短负载也摘要——可读性优于原始 JSON）
	const semantic = _trySummarizeSearchEnvelope(unwrapped, maxLen);
	if (semantic !== undefined) { return semantic; }
	if (unwrapped.length <= maxLen) { return unwrapped.trim(); }
	try {
		const parsed: unknown = JSON.parse(unwrapped);
		if (Array.isArray(parsed)) {
			const parts = parsed.slice(0, 3).map(e => {
				const s = typeof e === 'string' ? e : JSON.stringify(e);
				return s.length > 60 ? s.slice(0, 60) + '…' : s;
			});
			let out = parts.join(', ');
			if (parsed.length > 3) { out += `, …(${parsed.length} 项)`; }
			return out.length > maxLen ? out.slice(0, maxLen) + '…' : out;
		}
		if (typeof parsed === 'object' && parsed !== null) {
			const keys = Object.keys(parsed);
			const preview: Record<string, unknown> = {};
			let budget = maxLen - 2;
			for (const key of keys) {
				const val = (parsed as Record<string, unknown>)[key];
				const valStr = typeof val === 'string' ? val : JSON.stringify(val);
				if (budget <= 0) { preview[key] = '…'; break; }
				if (valStr.length <= budget) {
					preview[key] = val;
					budget -= valStr.length;
				} else {
					// 类型感知占位（旧实现 `[${typeof val}]` 对数组产出 "[object]" 垃圾）
					if (Array.isArray(val)) { preview[key] = `[${val.length} 项]`; }
					else if (val !== null && typeof val === 'object') { preview[key] = `{${Object.keys(val as Record<string, unknown>).length} keys}`; }
					else if (typeof val === 'string') { preview[key] = valStr.slice(0, budget) + '…'; }
					else { preview[key] = val; }
					budget = 0;
				}
			}
			const result = JSON.stringify(preview);
			if (result.length > maxLen) {
				// 不输出硬切的无效 JSON（下游 parse 失败会退化为原始乱码）——降级紧凑 k=v 文本
				const flat = Object.entries(preview).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
				return flat.length > maxLen ? flat.slice(0, maxLen - 1) + '…' : flat;
			}
			return result;
		}
	} catch { /* not JSON, fall through */ }
	return unwrapped.trim().slice(0, maxLen) + '…';
}

/**
 * search_code 类结果信封 → 单行语义摘要；非信封返回 undefined。
 * 支持 {results:[{filePath,path,name,lineNo}], total/total_grep_matches} 与
 * {files:[...], total_files} 两种信封（compact/full/files 各 mode 输出）。
 */
function _trySummarizeSearchEnvelope(text: string, maxLen: number): string | undefined {
	const t = text.trim();
	if (!t.startsWith('{')) { return undefined; }
	let parsed: unknown;
	try { parsed = JSON.parse(t); } catch { return undefined; }
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { return undefined; }
	const obj = parsed as Record<string, unknown>;
	// 路径压缩：保留末两段（UE 路径极长，全路径单项即爆预算）
	const shortPath = (p: string): string => {
		const n = p.replace(/\\/g, '/');
		const parts = n.split('/');
		return parts.length > 2 ? parts.slice(-2).join('/') : n;
	};
	const clip = (out: string): string => out.length > maxLen ? out.slice(0, Math.max(0, maxLen - 1)) + '…' : out;
	if (Array.isArray(obj['results'])) {
		const arr = obj['results'] as unknown[];
		// total_grep_matches（底层命中总数）优先于 total（本次返回条数）——摘要信息量更高
		const total = typeof obj['total_grep_matches'] === 'number' ? obj['total_grep_matches'] as number
			: typeof obj['total'] === 'number' ? obj['total'] as number : arr.length;
		const head = arr.slice(0, 3).map(r => {
			if (r !== null && typeof r === 'object') {
				const rec = r as Record<string, unknown>;
				const fp = rec['filePath'] ?? rec['path'] ?? rec['name'];
				if (typeof fp === 'string') {
					return typeof rec['lineNo'] === 'number' ? `${shortPath(fp)}:${rec['lineNo']}` : shortPath(fp);
				}
			}
			return typeof r === 'string' ? r : '';
		}).filter(Boolean).join(', ');
		return clip(`${total} 命中${head ? `: ${head}` : ''}${arr.length > 3 || total > arr.length ? ', …' : ''}`);
	}
	if (Array.isArray(obj['files'])) {
		const arr = obj['files'] as unknown[];
		const total = typeof obj['total_files'] === 'number' ? obj['total_files'] as number : arr.length;
		const head = arr.slice(0, 3).map(f => typeof f === 'string' ? shortPath(f) : '').filter(Boolean).join(', ');
		return clip(`${total} 个文件${head ? `: ${head}` : ''}${arr.length > 3 || total > arr.length ? ', …' : ''}`);
	}
	return undefined;
}

// ─── SubAgent Instance Types ─────────────────────────────────────────────

export interface SubAgentOptions {
	/** SubAgent type — determines tool permissions */
	readonly type?: SubAgentType;
	/** Max iterations for this sub-agent (default: derived from parent budget) */
	readonly maxIterations?: number;
	/**
	 * 总时长上限（ms，默认 600_000 = 10min，对齐 MiMo actor timeout_ms）。
	 * 超时语义（2026-07-26 规则）：走 salvage 部分完成（保留产出 + P1 总结），
	 * 而非硬失败；0 = 禁用限时（回到「不限总时长」旧规则）。
	 */
	readonly timeout?: number;
	/**
	 * 软预算（wall-clock，ms）：耗时超过该值时主循环注入一次收尾提醒（不打断
	 * 执行）。缺省按 timeout×SUBAGENT_SOFT_BUDGET_RATIO 推导；timeout=0 时禁用。
	 */
	readonly softDeadlineMs?: number;
	/** Priority for scheduling (low/medium/high) */
	readonly priority?: 'low' | 'medium' | 'high';
	/** Parent's stable ChatMode policy. */
	readonly parentChatMode?: string;
	/** Parent's mutable WorkMode; plan subagents inherit the read-only ceiling. */
	readonly parentWorkMode?: 'plan' | 'work';
	/** Additional context to inject (e.g., repo_overview output) */
	readonly context?: string;
	/** Whether this is a background sub-agent (non-blocking) */
	readonly background?: boolean;
	/** Parent session ID for context isolation */
	readonly parentSessionId?: string;
	/**
	 * v17: per-subagent worktree path override. Inherited from the parent
	 * agent's execution context (set by builtinToolProvider before dispatching
	 * delegate_task). When set, the subagent's working directory is locked
	 * to this path (matches `IAgentTurnRequest.worktreePath` semantics).
	 */
	readonly worktreePath?: string;
	/**
	 * v17: per-subagent toolset scope override. When set, the sub-agent's enabled
	 * tools are narrowed to ONLY the listed toolsets (plus bridge tools). Lets a
	 * parent constrain what a delegated sub-agent may do — e.g. an Explore
	 * sub-agent scoped to ['core'] for read-only investigation. Undefined → no
	 * narrowing (current behavior preserved).
	 */
	readonly toolsets?: string[];
	/**
	 * Per-subagent tool-name exclusion — unconditionally hides the listed tools
	 * from the sub-agent regardless of toolset. E.g. an Explore sub-agent must NOT
	 * see `index_repository`: the parent pre-builds the graph itself, and letting
	 * the sub-agent call it makes it stop after "index started" (the "只索引即停"
	 * premature-stop failure). Flows through to `IAgentTurnRequest.excludedTools`.
	 */
	readonly excludedTools?: readonly string[];
	/**
	 * v17: per-subagent model override. When set, the sub-agent runs with this
	 * model selection instead of the session default (matches
	 * `IAgentTurnRequest.modelOverride` semantics).
	 */
	readonly model?: IModelSelection;
	/**
	 * P3（2026-07-26，对齐 MiMo output_schema）：要求子代理最终结论为符合该
	 * JSON Schema 的结构化对象。设置后主执行完成追加一轮禁工具结构化输出
	 * （轻量校验 required 键，1 次重试），validated 对象序列化为 output；
	 * 失败回退自由文本（best effort）。
	 */
	readonly outputSchema?: Record<string, unknown>;
	/**
	 * postStop self-verification hook (MiMo preStop/postStop ReAct). After the main
	 * execution + Completion Gate, if the result is not a clean success-with-acceptance,
	 * a verification prompt is appended and one more bounded turn runs.
	 */
	readonly postStop?: ISubAgentPostStopHook;
		/**
		 * Fork prefix-cache context (MiMo ForkContext). When set, the sub-agent reuses the
		 * parent's frozen system prompt verbatim so the LLM provider's prompt cache hits.
		 */
		readonly forkContext?: IForkContext;
		/**
		 * P2b 隔离档位。默认 'subagent'（层级受控，父 turn abort 级联取消、继承父 worktree）。
		 * 设为 'peer' 表示对等独立 agent：父 turn abort 不级联取消、且不应继承父的敏感
		 * worktree/上下文（由调用方在 delegationTools / swarm 层据此约束最小权限）。
		 */
		readonly isolationLevel?: SubAgentIsolationLevel;
	/**
	 * 内置 Agent 身份 id（如 'code-explorer' / 'researcher' / 'data'）。设置后子代理以
	 * 该内置 Agent 的真实 systemPrompt / tools / model 实例化，而非通用 Explore 折中提示词。
	 * 由 delegationTools（delegate_task type）/ plan_explore / pre-loop 探索解析后写入。
	 */
	readonly agentId?: string;
	/**
	 * 子代理系统提示词覆盖。设置后 `_buildSystemPrompt` 用它替换按 `type` 选取的默认提示词
	 * （仍会拼接全局子代理前后缀）。通常来自内置 Agent 的 `systemPrompt`。
	 */
	readonly systemPrompt?: string;
	/**
	 * 子代理工具白名单（tool 名集合，通常来自内置 Agent 的 `tools`）。设置后子代理可见工具
	 * 收敛为「白名单 ∩ 其余门控结果」，作为对内置 Agent 工具面的忠实还原。
	 * 流向 `IAgentTurnRequest.allowedTools`。
	 */
	readonly allowedTools?: readonly string[];
	}

export interface SubAgentInstance {
	readonly id: string;
	readonly parentAgentId: string;
	readonly type: SubAgentType;
	readonly task: string;
	status: SubAgentStatus;
	readonly budget: IterationBudget;
	readonly createdAt: number;
	readonly timeout: number;
	readonly priority: 'low' | 'medium' | 'high';
	readonly options: SubAgentOptions;
	/** P2b 隔离档位（从 options 解析，默认 'subagent'），供 TaskBoard/UI 与中断逻辑区分两档。 */
	readonly isolationLevel: SubAgentIsolationLevel;
	result?: SubAgentResult;
	/** Per-sub-agent token usage collector (inspired by deer-flow SubagentTokenCollector). */
	readonly tokenCollector: SubagentTokenCollector;
}

export type SubAgentStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface SubAgentResult {
	readonly success: boolean;
	readonly output?: string;
	readonly error?: string;
	readonly completedAt: number;
	/** Execution duration in milliseconds */
	readonly durationMs?: number;
	/** Number of API (LLM) calls made */
	readonly apiCalls?: number;
	/** Token usage (if available from the LLM response) */
	readonly tokensUsed?: { input: number; output: number };
	/** Detailed per-turn token usage (inspired by deer-flow SubagentTokenCollector). */
	readonly tokenUsage?: SubagentTokenUsage;
	/** Why the sub-agent stopped executing */
	readonly exitReason?: SubAgentExitReason;
	/** Tool call trace — list of tools invoked with their status */
	readonly toolTrace?: ReadonlyArray<SubAgentToolTraceEntry>;
	/** Files modified by this sub-agent (for file change coordination) */
	readonly filesModified?: readonly string[];
	/** Structured Completion-Gate verdict (MiMo TaskGate) — reliable contract for the parent. */
	readonly structured?: ISubAgentStructuredResult;
	}

/** A single tool call trace entry, inspired by Hermes tool_trace. */
export interface SubAgentToolTraceEntry {
	readonly toolName: string;
	readonly status: 'ok' | 'error';
	/** Approximate size of tool arguments in bytes */
	readonly argsSizeBytes?: number;
	/** Approximate size of tool result in bytes */
	readonly resultSizeBytes?: number;
	/** Error message (if status === 'error') */
	readonly error?: string;
}

/** Internal execution result from _executeWithBudget, carrying metadata for SubAgentResult. */
interface _ExecResult {
	readonly output: string;
	readonly apiCallCount: number;
	readonly budgetExhausted: boolean;
	readonly tokensUsed?: { input: number; output: number };
	readonly toolTrace: SubAgentToolTraceEntry[];
	/** Files that were modified (written/created) by this sub-agent */
	readonly filesModified: string[];
	/** Whether the sub-agent stalled (no progress for idleTimeoutMs) and was aborted. */
	readonly stalled?: boolean;
	/** Whether the sub-agent was interrupted (manual interrupt or parent AbortSignal — P3). */
	readonly interrupted?: boolean;
}

/** Result of a full sub-agent program (execution + completion gates), settled by the fiber. */
interface _ProgramResult {
	readonly execResult: _ExecResult;
	readonly structured: ISubAgentStructuredResult;
}

/** Event emitter pre-bound to a specific sub-agent (identity fields filled in). */
type _BoundEmit = (event: Omit<SubAgentEvent, 'subAgentId' | 'subAgentType' | 'task' | 'parentId' | 'timestamp'> & { type: SubAgentEventType }) => void;

/**
 * Tagged error raised when a sub-agent exceeds its hard timeout cap.
 * A distinct class (not a message substring) so retry policies can match it
 * reliably — timeout is NOT retryable.
 */
class SubAgentTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`SubAgent timeout after ${timeoutMs}ms`);
		this.name = 'SubAgentTimeoutError';
	}
}

/**
 * Per-attempt execution control passed to _executeWithBudget.
 * The watchdog and stall flag are attempt-local (a retry gets a fresh set);
 * the interrupt signal is fiber-scoped (shared across attempts).
 */
interface _AttemptControl {
	readonly watchdog: StallWatchdog;
	readonly signal: InterruptSignal;
	readonly isStalled: () => boolean;
}

/**
 * 看门狗计活的内容级 delta 类型（2026-07-26 P1，对齐 MiMo chunkTimeout 语义）：
 * 模型产出的任何内容（文本/思考/工具调用装配/工具结果）都算活动；
 * usage/done/phase_change/memory_injected 等帧外事件不算（keep-alive 只证明
 * 连接活着，不证明模型在产出）。
 */
const _STALL_CONTENT_DELTA_TYPES: ReadonlySet<string> = new Set([
	'text', 'thinking', 'tool_start', 'tool_args', 'tool_result', 'tool_end',
	// tool_progress（2026-07-26 治本）：工具参数流式生成的进度信号——
	// 子代理 file_write 写大文件（10k+ tokens 参数）期间同样续命，
	// 与主 agent 的 resilience 修复对齐（事故 1785049332701）。
	'tool_progress',
]);

/**
 * 子代理软预算比例（2026-07-28）：wall-clock 超过 timeout×该比例时，主循环
 * 注入一次「立即整理发现并收尾」的 system-reminder（不打断执行）。
 * 目的：让长探索任务在硬超时前主动收敛产出（日志 1785224874547：Explore
 * 子代理 78 轮线性探索撞 600s 硬超时、零产出交接）。0.5 = 半程提醒，
 * 给总结留出足够余量。options.softDeadlineMs 可显式覆盖。
 */
const SUBAGENT_SOFT_BUDGET_RATIO = 0.5;

/**
 * P1 停滞强制总结的用户消息（2026-07-26，对齐 MiMo max-steps.txt 模板语义）：
 * 禁工具（excludedTools:['*']），仅基于已完成工作输出「已完成/未完成/建议」。
 * 保持通用表述（不含项目/场景特化内容）。
 */
const _STALL_SUMMARY_PROMPT = [
	'系统检测到执行已停滞（长时间无响应），本轮执行已被终止。',
	'禁止调用任何工具。请仅基于你目前已经完成的工作，立即输出最终总结：',
	'1. 已完成的部分：关键发现、结论、涉及的文件/位置；',
	'2. 未完成的部分：原计划中尚未完成的事项；',
	'3. 建议的下一步：如果由他人接手，应该怎么做。',
	'直接输出总结文本。',
].join('\n');

/**
 * P3 辅助：从模型输出中提取首个 JSON 对象（容忍 markdown 围栏与前后杂文）。
 * 仅接受对象（非数组/标量）；失败返回 undefined。
 */
function _tryParseJsonObject(text: string): Record<string, unknown> | undefined {
	let s = text.trim();
	// 剥 markdown 代码围栏（```json ... ``` / ``` ... ```）
	const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fence) { s = fence[1].trim(); }
	// 截取首个 { 到末个 }（容忍结论前后多余的说明文字）
	const start = s.indexOf('{');
	const end = s.lastIndexOf('}');
	if (start < 0 || end <= start) { return undefined; }
	try {
		const parsed: unknown = JSON.parse(s.slice(start, end + 1));
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch { /* not JSON */ }
	return undefined;
}

/** P3 辅助：轻量 schema 校验——仅检查 schema.required 声明的键齐全。 */
function _matchesRequiredKeys(obj: Record<string, unknown>, schema: Record<string, unknown>): boolean {
	const required = (schema as { required?: unknown }).required;
	if (!Array.isArray(required)) { return true; }
	return required.every(k => typeof k === 'string' && k in obj);
}

// ─── SubAgent Event System (inspired by Hermes DelegateEvent) ───────────

/**
 * Fine-grained sub-agent event types, inspired by Hermes-Agent's DelegateEvent enum.
 * These provide detailed observability into sub-agent execution lifecycle.
 *
 * Hermes DelegateEvent has 7 types: TASK_SPAWNED, TASK_PROGRESS, TASK_COMPLETED,
 * TASK_FAILED, TASK_THINKING, TASK_TOOL_STARTED, TASK_TOOL_COMPLETED.
 * We align with that set and add 'interrupted' for our interrupt mechanism.
 */
export const enum SubAgentEventType {
	/** Sub-agent has been spawned and is about to start execution */
	Spawned = 'spawned',
	/** Sub-agent is thinking (LLM inference in progress) */
	Thinking = 'thinking',
	/** Sub-agent has started a tool call */
	ToolStarted = 'tool_started',
	/** Sub-agent has completed a tool call */
	ToolCompleted = 'tool_completed',
	/** General progress update (e.g., batch progress summary) */
	Progress = 'progress',
	/** Sub-agent completed successfully */
	Completed = 'completed',
	/** Sub-agent failed with an error */
	Failed = 'failed',
	/** Sub-agent was interrupted by user or parent */
	Interrupted = 'interrupted',
	/** Live LLM text delta (streaming output, for real-time card rendering) */
	TextDelta = 'text_delta',
}

/**
 * Sub-agent event emitted during execution.
 * Inspired by Hermes-Agent's DelegateEvent — provides fine-grained
 * observability into the sub-agent lifecycle.
 *
 * The event sink receives these so the caller (e.g. the webview controller)
 * can translate them into IChatStreamDelta deltas and forward to the WebView.
 */
export interface SubAgentEvent {
	/** Fine-grained event type (inspired by Hermes DelegateEvent) */
	readonly type: SubAgentEventType;
	readonly subAgentId: string;
	readonly subAgentType: SubAgentType;
	readonly task: string;
	readonly parentId: string;
	readonly timestamp: number;

	// ── Type-specific payloads ──

	/** Tool name (for ToolStarted / ToolCompleted) */
	readonly toolName?: string;
	/** Tool call arguments preview (for ToolStarted, truncated) */
	readonly toolArgsPreview?: string;
	/** Tool result preview (for ToolCompleted, truncated) */
	readonly toolResultPreview?: string;
	/** Tool execution status (for ToolCompleted) */
	readonly toolStatus?: 'ok' | 'error';
	/** Thinking text (for Thinking) */
	readonly thinkingText?: string;
	/** Human-readable progress note (for Progress) */
	readonly progressNote?: string;
	/** Progress metrics: tool calls completed so far */
	readonly toolsCompleted?: number;
	/** Final output text (for Completed) */
	readonly output?: string;
	/** Live text delta chunk (for TextDelta, accumulates into streamingOutput on the card) */
	readonly textDelta?: string;
	/** Error message (for Failed / Interrupted) */
	readonly error?: string;
	/** Duration in ms (for Completed / Failed) */
	readonly durationMs?: number;
	/** Token usage (for Completed) */
	readonly tokensUsed?: { input: number; output: number };
	/** Exit reason (for Completed / Failed / Interrupted) */
	readonly exitReason?: SubAgentExitReason;
	/** Group id to cluster parallel sub-agents into one card */
	readonly groupId?: string;
}

/** Why a sub-agent stopped executing. */
export type SubAgentExitReason =
	| 'completed'       // Task finished normally
	| 'partial'         // Finished its loop but self-reported partial/blocked (findings salvaged, not a failure)
	| 'max_iterations'  // Hit iteration budget
	| 'timeout'         // Exceeded time limit
	| 'interrupted'     // Interrupted by user or parent
	| 'error';          // Unhandled exception

/** Sink that receives sub-agent events. Errors thrown here are swallowed. */
export type SubAgentEventSink = (event: SubAgentEvent) => void;

// ─── Backward-compatible legacy aliases ─────────────────────────────────

/**
 * @deprecated Use SubAgentEvent instead. Kept for backward compatibility
 * with existing callers that reference SubAgentLifecycleEvent.
 */
export type SubAgentLifecycleEvent = SubAgentEvent;

export interface SubAgentStatusReport {
	readonly id: string;
	readonly type: SubAgentType;
	readonly status: SubAgentStatus;
	readonly task: string;
	readonly createdAt: number;
	readonly budget: string;
}

// ─── Unified SubAgent Dispatch ────────────────────────────────────────────

/**
 * UnifiedSubAgentDispatch — the single entry point for all sub-agent operations.
 *
 * Replaces the three previous paths:
 * - SubAgentManager → now a thin wrapper delegating here
 * - TaskOrchestrationService._executeTask() → delegates execution here
 * - delegate_task tool → routes through TaskOrchestrationService which uses this
 *
 * Key improvements over previous SubAgentManager:
 * 1. SubAgentType-based permission profiles (like OpenCode)
 * 2. Context injection (repo_overview, upstream results)
 * 3. Background execution support
 * 4. Permission-aware tool filtering
 */
export class UnifiedSubAgentDispatch {
	private readonly _activeSubAgents = new Map<string, SubAgentInstance>();
	private readonly _parentBudget: IterationBudget;
	private readonly _maxConcurrent: number;
	private readonly _maxSpawnDepth: number;
	/** 内容停滞阈值 (ms)：模型流内超过此时长无任何内容级 delta → 判停滞。 */
	private _stallTimeoutMs: number;
	/**
	 * P2d: 可选的异步 task 查询回调（完成门 DB 真相）。由调用方（agentOSService）
	 * 注入具体实现 —— 查 IAgentTaskBoardService 的非终态任务（triage/todo/ready/running，
	 * 排除 blocked）并按 owner 过滤。undefined → 退化为现状（不查 DB，gateResult 仅靠
	 * 输出标记推断）。对齐 MiMo-Code TaskGate（在 actor/spawn.ts 调用层查 DB）。
	 */
	private readonly _taskLookup?: (input: { ownerAgentId: string; parentSessionId?: string }) => Promise<readonly IIncompleteTask[]>;
	/** Optional logger for sub-agent stream diagnostics (heartbeat / DELTA GAP / handover). */
	private _log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
	/**
	 * Per-instance InterruptSignal (Effect model: cooperative cancellation).
	 * Created in createSubAgent so interruptSubAgent() works whether the
	 * sub-agent is pending or already running — a pre-start interrupt persists
	 * and the fiber observes it as soon as execution begins (replaces the old
	 * `_interruptedSubAgents` Set). Stall state is per-attempt local state now
	 * (replaces `_stalledSubAgents`); retries use the retry() combinator
	 * (replaces `_subagentRetryMap`).
	 */
	private readonly _interruptSignals = new Map<string, InterruptSignal>();

	// ─── Global registry (inspired by Hermes _active_subagents) ───────
	/**
	 * Static registry of all active UnifiedSubAgentDispatch instances,
	 * keyed by workspace/session ID. This enables cross-dispatch queries
	 * and UI integration (TaskBoard can enumerate all running sub-agents).
	 *
	 * Inspired by Hermes-Agent's module-level `_active_subagents` dict
	 * which supports TUI queries and interrupt propagation.
	 */
	private static readonly _globalRegistry = new Map<string, UnifiedSubAgentDispatch>();

	/** Register this dispatch instance in the global registry. */
	registerGlobal(sessionId: string): void {
		UnifiedSubAgentDispatch._globalRegistry.set(sessionId, this);
	}

	/** Unregister this dispatch instance from the global registry. */
	unregisterGlobal(sessionId: string): void {
		UnifiedSubAgentDispatch._globalRegistry.delete(sessionId);
	}

	/**
	 * Look up a sub-agent across all dispatch instances.
	 * Useful for UI (TaskBoard) or interrupt propagation across sessions.
	 */
	static findSubAgentGlobal(subAgentId: string): SubAgentInstance | undefined {
		for (const dispatch of UnifiedSubAgentDispatch._globalRegistry.values()) {
			const agent = dispatch._activeSubAgents.get(subAgentId);
			if (agent) { return agent; }
		}
		return undefined;
	}

	/**
	 * Interrupt a sub-agent by ID across all dispatch instances.
	 * Inspired by Hermes interrupt_subagent() which uses module-level lookup.
	 */
	static interruptSubAgentGlobal(subAgentId: string): boolean {
		for (const dispatch of UnifiedSubAgentDispatch._globalRegistry.values()) {
			if (dispatch._activeSubAgents.has(subAgentId)) {
				return dispatch.interruptSubAgent(subAgentId);
			}
		}
		return false;
	}

	/**
	 * Get all running sub-agents across all sessions.
	 * Useful for TaskBoard to show global sub-agent status.
	 */
	static getAllRunningGlobal(): SubAgentStatusReport[] {
		const results: SubAgentStatusReport[] = [];
		for (const dispatch of UnifiedSubAgentDispatch._globalRegistry.values()) {
			results.push(...dispatch.getAllSubAgents());
		}
		return results;
	}

	constructor(
		parentBudget?: IterationBudget,
		maxConcurrent: number = 3,
		maxSpawnDepth: number = 1,  // P0: 禁止 subagent 嵌套（root depth=0, subagent depth=1≥1 → 抛异常）
		// 停滞超时（2026-07-26 MiMo 对齐重构）：模型流期间内容级 delta 计活
		// （text/thinking/tool_*），工具执行窗口看门狗暂停（toolExecutionGuard
		// 兜底）；「阈值内无任何内容产出」才判停滞。单响应软上限见
		// responseSoftCapMs。旧语义「仅工具活动计活」已废弃（误杀长答案与
		// 嵌套委派等待，事故 1785037741973）。
		stallTimeoutMs: number = 180_000,
		/** P2d: 可选异步 task 查询回调（完成门 DB 真相）。 */
		taskLookup?: (input: { ownerAgentId: string; parentSessionId?: string }) => Promise<readonly IIncompleteTask[]>,
	) {
		this._parentBudget = parentBudget || new IterationBudget(90);
		this._maxConcurrent = maxConcurrent;
		this._maxSpawnDepth = maxSpawnDepth;
		this._stallTimeoutMs = stallTimeoutMs;
		this._taskLookup = taskLookup;
	}

	/** Inject a logger for sub-agent stream diagnostics (heartbeat / DELTA GAP / handover). */
	public setLogger(log: (level: 'info' | 'warn' | 'error', msg: string) => void): void {
		this._log = log;
	}

	// ─── delegate_task 子代理会话复用（2026-07-26 用户决策：
	// 「一个 subagent 执行完毕所有任务」——后续单任务委派 follow-up 续跑，
	// 不再每次新起冷启动子代理）─────────────────────────────────────────

	/** 最近完成的单任务子代理索引：`${parentAgentId}::${type}` → {subAgentId, completedAt}。 */
	private readonly _reusableSubAgents = new Map<string, { subAgentId: string; completedAt: number }>();

	/** 复用窗口（默认 15 分钟；同轮连续委派间隔实测 ~3 分钟）。测试可改写。 */
	public reuseWindowMs = 15 * 60_000;

	/**
	 * 单响应软上限（默认 480s，对齐 MiMo-Code chunkTimeout）：连续模型响应段
	 * （两次工具边界之间的内容流）超此上限 → 判停滞中止。防「空谈永动」；
	 * 健康长答案（实测 80s 级）充分放行。测试可改写。
	 */
	public responseSoftCapMs = 480_000;

	/**
	 * 查找可复用的子代理：同父 agent + 同类型 + 窗口内完成 + 实例未在运行。
	 * 复用其会话（sessionId=subAgent.id 不变 → 网关 previous_response_id 链式
	 * 衔接，子代理保留全部探索上下文，避免冷启动 + 上下文丢失）。
	 */
	findReusableSubAgent(parentAgentId: string, type: SubAgentType): SubAgentInstance | undefined {
		const key = `${parentAgentId}::${type}`;
		const rec = this._reusableSubAgents.get(key);
		if (!rec) { return undefined; }
		if (Date.now() - rec.completedAt > this.reuseWindowMs) {
			this._reusableSubAgents.delete(key);
			return undefined;
		}
		const subAgent = this._activeSubAgents.get(rec.subAgentId);
		if (!subAgent || subAgent.status === 'running' || subAgent.status === 'pending') {
			return undefined;
		}
		return subAgent;
	}

	/** 完成时登记可复用（done/error 均登记——会话上下文仍有价值）。 */
	private _markReusable(subAgent: SubAgentInstance): void {
		this._reusableSubAgents.set(`${subAgent.parentAgentId}::${subAgent.type}`, {
			subAgentId: subAgent.id,
			completedAt: Date.now(),
		});
	}

	/**
	 * Follow-up 续跑：复用既有子代理会话执行新任务。
	 * 与新建的本质差异：sessionId（=subAgent.id）不变 → 网关把请求当同一会话
	 * 续轮（previous_response_id 链式衔接），子代理带着此前全部探索上下文
	 * 继续工作；消息层只发增量（新任务），卡片经 Spawned 事件自然重置过程数据。
	 */
	async dispatchFollowUp(
		subAgentId: string,
		newTask: string,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		eventSink?: SubAgentEventSink,
		abortSignal?: AbortSignal,
	): Promise<SubAgentResult> {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) {
			throw new Error(`dispatchFollowUp: sub-agent ${subAgentId} not found`);
		}
		this._log?.('info', `[FollowUp] reusing ${subAgentId} for new task: ${newTask.slice(0, 60)}`);
		// 重置生命周期：executeSubAgent 要求 pending 起始态；旧 result 清除，
		// 会话（sessionId/budget/depth 链）保留不变。task 为 readonly，经可变视图更新。
		(subAgent as { task: string }).task = newTask;
		subAgent.status = 'pending';
		subAgent.result = undefined;
		return this.executeSubAgent(subAgent.id, executeFn, eventSink, undefined, abortSignal);
	}

	/** 获取当前配置（供 delegate_task 动态描述使用） */
	getConfig() {
		return {
			maxConcurrent: this._maxConcurrent,
			maxSpawnDepth: this._maxSpawnDepth,
		};
	}

	/**
	 * 计算子代理的最终 excludedTools：用户显式排除 + 对所有子代理隐藏编排工具。
	 * 2026-07-26 用户模型「一个 subagent 执行完毕所有任务」：委派是主代理专属
	 * 能力（后续任务走 follow-up 会话复用续跑同一子代理），子代理（depth≥1）
	 * 不应再嵌套委派——线上事故 1785037741973：explore 子代理受提示词中
	 * 「PARALLEL WORK GOES THROUGH SUB-AGENTS」段落诱导，递归发出 6 个
	 * delegate_task，父代理阻塞等待 depth-2 子代理期间被看门狗误杀。
	 * 从工具面直接隐藏（而非仅靠提示词约束），杜绝该事故链。
	 */
	private _effectiveExcludedTools(subAgent: SubAgentInstance): readonly string[] | undefined {
		const base = subAgent.options.excludedTools;
		const depth = this._getAgentDepth(subAgent.id);
		if (depth >= 1) {
			const orchestration = ['delegate_task', 'plan_explore', 'subagent_batch'];
			return base ? [...new Set([...base, ...orchestration])] : orchestration;
		}
		return base;
	}

	/**
	 * 计算指定 agent 的深度（从 root 到该 agent 的层数，root = 0）
	 */
	private _getAgentDepth(agentId: string): number {
		let depth = 0;
		let currentId: string | undefined = agentId;

		while (currentId) {
			const agent = this._activeSubAgents.get(currentId);
			if (!agent) {
				// Reached root agent (not in _activeSubAgents)
				break;
			}
			depth++;
			currentId = agent.parentAgentId;
		}

		return depth;
	}

	/**
	 * Create a sub-agent instance.
	 * Does NOT start execution — call executeSubAgent() separately.
	 */
	createSubAgent(
		parentAgentId: string,
		task: string,
		options?: SubAgentOptions,
	): string {
		// Check spawn depth limit
		const parentDepth = this._getAgentDepth(parentAgentId);
		if (parentDepth >= this._maxSpawnDepth) {
			throw new Error(`Cannot spawn sub-agent: maximum spawn depth (${this._maxSpawnDepth}) reached. Parent agent depth: ${parentDepth}`);
		}

		const subAgentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
		const type = options?.type ?? SubAgentType.General;
		// 子代理不限轮数（2026-07-25 用户决策）：默认独立大额预算，工具消耗只记账
		// 不熔断；唯一时间约束是「工具活动 180s 超时」（StallWatchdog）。
		// 显式 options.maxIterations 仍生效（测试/特殊场景）。注意不能用
		// createChildBudget——它会按父预算剩余 60% 钳制（90 → 54 次，曾致
		// max_iterations 误杀，产出全丢）。
		const budget = options?.maxIterations !== undefined
			? this._parentBudget.createChildBudget(options.maxIterations)
			: new IterationBudget(1_000_000);
		const isolationLevel = options?.isolationLevel ?? 'subagent';

		const subAgent: SubAgentInstance = {
			id: subAgentId,
			parentAgentId,
			type,
			isolationLevel,
			task,
			status: 'pending',
			budget,
			createdAt: Date.now(),
			// 总时长上限（2026-07-26 规则变更：要求限时，MiMo 对齐）：默认 600s
			// = MiMo actor 工具 timeout_ms 默认值。关键语义差异（对齐 MiMo
			// 「timeout 状态照交结果」）：超时**不是失败**——在 _executeWithBudget
			// 的 delta 检查点走 stalled/salvage 路径，保留产出 + P1 禁工具总结；
			// 仅「完全零 delta 挂起」的极端场景才由 timeout() 组合器硬杀
			// （此时本无产出可保，failure 可接受）。
			timeout: options?.timeout ?? 600_000,
			priority: options?.priority ?? 'medium',
			options: options ?? {},
			result: undefined,
			tokenCollector: new SubagentTokenCollector(),
		};

		this._activeSubAgents.set(subAgentId, subAgent);
		// Effect model: the per-instance InterruptSignal exists from creation, so
		// interruptSubAgent() marks the instance even before its fiber starts.
		this._interruptSignals.set(subAgentId, new InterruptSignal());
		return subAgentId;
	}

	/**
	 * Execute a previously created sub-agent.
	 * The executeFn is provided by the caller (typically AgentOSService).
	 *
	 * @param eventSink Optional sink receiving start/progress/end lifecycle events.
	 *                  This is the channel that drives the WebView SubAgentCard.
	 * @param groupId   Optional group id to cluster parallel sub-agents into one card.
	 */
	async executeSubAgent(
		subAgentId: string,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		eventSink?: SubAgentEventSink,
		groupId?: string,
		/** P3: 父→子取消传播。传入父 turn 的 AbortSignal；abort 时自动 interrupt 本子 agent（递归取消子代）。 */
		abortSignal?: AbortSignal,
	): Promise<SubAgentResult> {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) {
			throw new Error(`SubAgent ${subAgentId} not found`);
		}

		if (subAgent.status !== 'pending') {
			throw new Error(`SubAgent ${subAgentId} is not in pending state (current: ${subAgent.status})`);
		}

		subAgent.status = 'running';
		const startedAt = Date.now();

		// P2b + P3: 父→子取消传播仅对 subagent 档生效。
		// peer 档为对等独立 agent,父 turn 的 abort 不应级联取消它 (其生命周期独立,
		// 只有显式 interruptSubAgent / swarm.cancelSwarm 才能停)。故 peer 档把父
		// abortSignal 降级为 undefined —— 不桥接到 fiber 的 InterruptSignal。
		const effectiveAbortSignal = (subAgent.options.isolationLevel === 'peer')
			? undefined
			: abortSignal;

		// Effect model: per-instance InterruptSignal（createSubAgent 时创建）。
		// interruptSubAgent() 在 pending/running 任意时刻调用都有效；信号是粘性的，
		// pre-start interrupt 会在 fiber 启动后的第一个中断点生效。
		const signal = this._interruptSignals.get(subAgentId) ?? new InterruptSignal();
		this._interruptSignals.set(subAgentId, signal);

		// Emit spawned event — sub-agent has been created and is about to run.
		this._emit(eventSink, {
			type: SubAgentEventType.Spawned,
			subAgentId: subAgent.id,
			subAgentType: subAgent.type,
			task: subAgent.task,
			parentId: subAgent.parentAgentId,
			timestamp: startedAt,
			groupId,
		});

		try {
			// Build the request with context injection
			const messages = this._buildMessages(subAgent);

			const request: IAgentTurnRequest = {
				agentId: subAgent.id,
				// P0: 每个 subagent 必须有唯一 sessionId。
				// 否则 request.sessionId 为 undefined → agentOSService._getOrCreateConversationId
				// 把所有 subagent 归到 '__nosession__' 桶、复用同一个 conversationId，
				// 而该 conversationId 即网关的 X-Conversation-Id（extension.ts:1279），
				// previous_response_id 也按同一 key 复用（agentOSService.ts:243）。
				// 多个并行 subagent 共享同一 X-Conversation-Id → 网关把它们当成同一服务端
				// 会话的并发续轮，复用父会话上下文，subagent 自己的 task 被忽略，
				// 只回开场白即被判 success（见 2026-07-23 日志 1784806388723）。
				// 用 subAgent.id（唯一且跨 retry 稳定）作为 sessionId，使每个 subagent
				// 拥有独立 conversationId / previous_response_id，且自身多轮链式衔接正常。
				sessionId: subAgent.id,
				messages,
				systemPrompt: this._buildSystemPrompt(subAgent),
				// v17: propagate the parent agent's worktree so the subagent's
				// tools (file_read, file_write, terminal_cmd, etc.) all run
				// inside the same worktree the parent was operating in.
				worktreePath: subAgent.options.worktreePath,
				// Stable ChatMode policy + mutable WorkMode permission ceiling.
				chatMode: subAgent.options.parentChatMode as 'craft' | 'plan' | 'ask' | undefined,
				workMode: subAgent.options.parentWorkMode,
			// v17: delegate_task may constrain the sub-agent's toolset scope
			// (e.g. an Explore sub-agent limited to ['core']) and/or pin a
			// specific model. Both flow through to agentOSService.
		toolsetsOverride: subAgent.options.toolsets,
		excludedTools: this._effectiveExcludedTools(subAgent),
		// agentId 驱动（2026-07-27）：内置 Agent 的 `tools` 作为白名单，使子代理可见工具
		// 忠实收敛到该 Agent 定义的工具面（与 toolsetsOverride/excludedTools 叠加取交集）。
		allowedTools: subAgent.options.allowedTools,
		modelOverride: subAgent.options.model,
			// 软预算：默认按 timeout×比例推导（显式 options.softDeadlineMs 优先）；
			// 主循环耗时超过即注入一次收尾提醒，引导子代理在硬超时前收敛产出。
			softDeadlineMs: subAgent.options.softDeadlineMs
				?? (subAgent.timeout > 0 ? Math.floor(subAgent.timeout * SUBAGENT_SOFT_BUDGET_RATIO) : undefined),
			// Fork 前缀缓存：子 agent 携带父级冻结 ForkContext，使其 (system+tools)
			// 前缀与父级对齐 → 请求构造端在该前缀边界打 cache 断点，命中父级 prompt cache。
			forkContext: subAgent.options.forkContext,
			// P1: 后台子 agent 标记 —— 使工具审批闸门（decideAskRouting）对该 turn
			// 走「继承父授权（非交互放行）」，而非弹交互确认阻塞父级 loop。
			// subAgent.type 的值即 SubAgentType 字符串（explore/general/scout）。
			subAgent: { type: subAgent.type, background: true },
		};

			const emitWrapped: _BoundEmit = (event) =>
				this._emit(eventSink, {
					...event,
					subAgentId: subAgent.id,
					subAgentType: subAgent.type,
					task: subAgent.task,
					parentId: subAgent.parentAgentId,
					timestamp: Date.now(),
					groupId,
				});

			// ── Effect model: the whole lifecycle runs as a forked fiber ──
			// - fork: independent execution unit sharing the per-instance InterruptSignal
			// - the parent AbortSignal is bridged into the fiber (P3); unlinking the
			//   listener is a scope finalizer (no manual finally, no leaked listener)
			// - fiber.exit never rejects; the exit is mapped to a SubAgentResult below
			const fiber = fork(async (ctx) => {
				ctx.scope.addFinalizer(ctx.signal.linkAbortSignal(effectiveAbortSignal, 'parent'));
				return this._executeSubAgentProgram(ctx, subAgent, executeFn, request, emitWrapped);
			}, { signal });

			const exit = await fiber.exit;
			return this._settleSubAgentResult(subAgent, exit, eventSink, groupId, startedAt);

		} catch (error) {
			// Defensive: only synchronous programming errors above land here
			// (message/prompt building, fork). The fiber program itself never
			// throws past fiber.exit — execution failures are failure exits.
			const errMsg = error instanceof Error ? error.message : String(error);
			subAgent.result = {
				success: false,
				error: errMsg,
				completedAt: Date.now(),
				durationMs: Date.now() - startedAt,
				tokenUsage: subAgent.tokenCollector.getUsage(),
				exitReason: 'error',
			};
			subAgent.status = 'error';
			this._emit(eventSink, {
				type: SubAgentEventType.Failed,
				subAgentId: subAgent.id,
				subAgentType: subAgent.type,
				task: subAgent.task,
				parentId: subAgent.parentAgentId,
				timestamp: Date.now(),
				error: errMsg,
				durationMs: Date.now() - startedAt,
				exitReason: 'error',
				groupId,
			});
			return subAgent.result;
		}
	}

	/**
	 * The retryable sub-agent program (Effect model): one attempt = one bounded
	 * execution + completion gates, inside a per-attempt child scope.
	 *
	 * - Retry uses the retry() combinator (Schedule.recurs(1)) — replaces the old
	 *   `_subagentRetryMap`. The retried unit is re-invoked from scratch, fixing
	 *   the old hand-rolled retry which rebuilt the request WITHOUT forkContext /
	 *   toolsetsOverride / modelOverride and never emitted Completed/Failed events.
	 * - The stall watchdog is attempt-local state owned by the attempt scope
	 *   (auto-disposed) — replaces the old `_stalledSubAgents` Set.
	 * - The hard timeout cap uses the timeout() combinator — its timer is always
	 *   cleared when the race settles (the old Promise.race leaked the timer).
	 * - Interruption unwinds via FiberInterrupt (skips all gate re-entry on cancel).
	 */
	private async _executeSubAgentProgram(
		ctx: IFiberContext,
		subAgent: SubAgentInstance,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		request: IAgentTurnRequest,
		emitWrapped: _BoundEmit,
	): Promise<_ProgramResult> {
		return retry(async () => ctx.scope.use(async (attemptScope) => {
			// Per-attempt stall state + watchdog (MiMo T40).
			let stalled = false;
			const watchdog = new StallWatchdog({
				idleTimeoutMs: this._stallTimeoutMs,
				onStall: () => { stalled = true; },
			});
			attemptScope.addFinalizer(() => watchdog.dispose());
			const control: _AttemptControl = { watchdog, signal: ctx.signal, isStalled: () => stalled };

			// 总时长双层（2026-07-26 MiMo 对齐）：①循环内 wall-clock 检查（同值）——
		// 超时走 stalled/salvage（保产出+总结，主路径）；②timeout() 组合器
		// +1s 余量——竞态必须让①先触发（实测同值时组合器在下一 delta 到达前
		// 先杀，salvage 路径被旁路）；仅在限后 1s 内完全零 delta 的挂起场景
		// 才由组合器硬杀（无产出可保，failure 可接受）。
		const runOnce = (req: IAgentTurnRequest) => subAgent.timeout > 0
			? timeout(
				this._executeWithBudget(executeFn, req, subAgent.budget, subAgent.tokenCollector, emitWrapped, control, subAgent.timeout),
				subAgent.timeout + 1_000,
				() => new SubAgentTimeoutError(subAgent.timeout),
				ctx.signal,
			)
			: this._executeWithBudget(executeFn, req, subAgent.budget, subAgent.tokenCollector, emitWrapped, control, 0);

		// ── Main execution ──
		let execResult = await runOnce(request);
		// P3: 被取消时直接以 FiberInterrupt 展开（跳过所有门控复核，不对已取消的
		// 子 agent 空耗 token），由 fiber exit 统一映射为 cancelled 结果。
		if (execResult.interrupted) { throw new FiberInterrupt(ctx.signal.reason ?? 'user'); }

		// 全新看门狗的补充轮执行器（P1 停滞总结 / P3 结构化输出共用）。
		// attempt 级 stalled 标志不可逆（tick 不清），任何补充轮都必须用全新
		// watchdog/control，否则首个 delta 检查即沿用旧停滞状态误判。
		const runFreshRound = async (req: IAgentTurnRequest): Promise<_ExecResult> => {
			let roundStalled = false;
			const roundWatchdog = new StallWatchdog({
				idleTimeoutMs: this._stallTimeoutMs,
				onStall: () => { roundStalled = true; },
			});
			attemptScope.addFinalizer(() => roundWatchdog.dispose());
			const roundControl: _AttemptControl = { watchdog: roundWatchdog, signal: ctx.signal, isStalled: () => roundStalled };
			return subAgent.timeout > 0
				? timeout(
					this._executeWithBudget(executeFn, req, subAgent.budget, subAgent.tokenCollector, emitWrapped, roundControl, subAgent.timeout),
					subAgent.timeout + 1_000, // 同 runOnce：+1s 余量让循环内 wall-clock salvage 先触发
					() => new SubAgentTimeoutError(subAgent.timeout),
					ctx.signal,
				)
				: this._executeWithBudget(executeFn, req, subAgent.budget, subAgent.tokenCollector, emitWrapped, roundControl, 0);
		};

		// ── P1: 停滞时「禁工具强制总结」（2026-07-26，对齐 MiMo max-steps）──
		// 旧行为：停滞 → output=原始片段+静态 [部分完成] 头。新行为：若有有效工具
		// 产出（与 salvage 同资格），先用同一 session 复跑一轮禁工具总结
		// （excludedTools:['*']，对齐 MiMo toolChoice:"none"），让模型自己梳理
		// 「已完成/未完成/建议」作为交接正文；总结轮也失败（模型真死/再停滞）
		// → 回退原始片段。salvage 头仍在 settle 路径统一添加（见 _settleSubAgentResult）。
		if (execResult.stalled && execResult.toolTrace.some(t => t.status === 'ok')) {
			try {
				const summaryResult = await runFreshRound({
					...request,
					messages: [...request.messages, { role: 'user', content: _STALL_SUMMARY_PROMPT }],
					excludedTools: ['*'],
				});
				if (summaryResult.interrupted) { throw new FiberInterrupt(ctx.signal.reason ?? 'user'); }
				if (!summaryResult.stalled && summaryResult.output.trim().length > 0) {
					execResult = {
						...execResult,
						output: summaryResult.output,
						// 保留原 toolTrace/filesModified/stalled：停滞事实与打捞轨迹不变
					};
				}
			} catch (summaryErr) {
				if (summaryErr instanceof FiberInterrupt) { throw summaryErr; }
				// 总结轮失败（模型真死/超时）——best effort，回退原始片段
				this._log?.('warn', `[SubAgent] stall summary round failed, falling back to raw partial output: ${summaryErr}`);
			}
		}

			// ── Completion Gate (MiMo TaskGate) ──
			// P2d: 首轮 gateResult 注入 DB 真相（若有 taskLookup）。无 taskLookup → undefined，退化为现状。
			const firstIncomplete = await this._queryIncompleteTasks(subAgent);
			let structured = gateResult(execResult.output, this._buildGateContext(subAgent, execResult, firstIncomplete?.map(t => t.id)));

			// ── postStop self-verification round (MiMo preStop/postStop ReAct) ──
			const postStop = subAgent.options.postStop;
			const maxRounds = postStop?.maxRounds ?? 1;
			let postStopRound = 0;
			while (postStop && postStopRound < maxRounds) {
				const decision = defaultPostStopDecision({ structured }, postStopRound, maxRounds);
				if (decision.kind === 'return') { break; }
				execResult = await runOnce({
					...request,
					messages: [...request.messages, { role: 'user', content: decision.followUpMessage }],
				});
				if (execResult.interrupted) { throw new FiberInterrupt(ctx.signal.reason ?? 'user'); }
				const postStopIncomplete = await this._queryIncompleteTasks(subAgent);
				structured = gateResult(execResult.output, this._buildGateContext(subAgent, execResult, postStopIncomplete?.map(t => t.id)));
				postStopRound++;
			}

			// ── P2d: TaskGate ReAct (DB-truth completion gate, MiMo-Code task/gate.ts) ──
			// cap=MAX_TASK_GATE_SUBAGENT_REACT(2)，对齐 MiMo-Code。失败开放（_queryIncompleteTasks
			// 内 catch → undefined → break，DB 错误不困住 agent）。
			let taskGateRound = 0;
			while (this._taskLookup && taskGateRound < MAX_TASK_GATE_SUBAGENT_REACT) {
				const incomplete = await this._queryIncompleteTasks(subAgent);
				if (!incomplete || incomplete.length === 0) { break; }
				const gateDecision: TaskGateDecision = decideTaskGate({
					incompleteTasks: incomplete,
					reactCount: taskGateRound,
					maxReact: MAX_TASK_GATE_SUBAGENT_REACT,
					mode: 'subagent',
				});
				if (!gateDecision.needReentry) { break; }
				execResult = await runOnce({
					...request,
					messages: [...request.messages, { role: 'user', content: gateDecision.reentryText }],
				});
			if (execResult.interrupted) { throw new FiberInterrupt(ctx.signal.reason ?? 'user'); }
			structured = gateResult(execResult.output, this._buildGateContext(subAgent, execResult, incomplete.map(t => t.id)));
			taskGateRound++;
		}

		// ── P3: output_schema 结构化交接（2026-07-26，对齐 MiMo output_schema）──
		// 主执行正常结束（未停滞）且委派方指定 outputSchema 时，追加禁工具结构化轮：
		// 要求模型把最终结论整理为符合 schema 的 JSON 对象；轻量校验（可解析 +
		// schema.required 键齐全），不合格重试 1 次；成功则 output=序列化对象，
		// 失败回退自由文本（best effort，不硬失败）。
		if (subAgent.options.outputSchema && !execResult.stalled) {
			const schemaText = JSON.stringify(subAgent.options.outputSchema);
			for (let schemaAttempt = 0; schemaAttempt < 2; schemaAttempt++) {
				try {
					const prompt = schemaAttempt === 0
						? `请把最终结论整理为符合以下 JSON Schema 的 JSON 对象并输出。禁止调用任何工具；只输出 JSON 对象本体，不要输出其他文字或 markdown 代码块：\n${schemaText}`
						: `上次输出不符合要求。请只输出符合以下 JSON Schema 的 JSON 对象本体（不要输出其他文字，不要用 markdown 代码块包裹）：\n${schemaText}`;
					const schemaResult = await runFreshRound({
						...request,
						messages: [...request.messages, { role: 'user', content: prompt }],
						excludedTools: ['*'],
					});
					if (schemaResult.interrupted) { throw new FiberInterrupt(ctx.signal.reason ?? 'user'); }
					if (schemaResult.stalled) { continue; }
					const parsed = _tryParseJsonObject(schemaResult.output);
					if (parsed && _matchesRequiredKeys(parsed, subAgent.options.outputSchema)) {
						execResult = { ...execResult, output: JSON.stringify(parsed) };
						break;
					}
				} catch (schemaErr) {
					if (schemaErr instanceof FiberInterrupt) { throw schemaErr; }
					this._log?.('warn', `[SubAgent] output_schema round ${schemaAttempt + 1} failed: ${schemaErr}`);
				}
			}
		}

		return { execResult, structured };
		}), {
			times: 1,
			// 仅重试非超时的瞬态失败；中断/超时/已取消信号不重试（对齐旧语义）。
			shouldRetry: (error) => !isFiberInterrupt(error) && !(error instanceof SubAgentTimeoutError) && !ctx.signal.interrupted,
			onRetry: (error) => {
				const errMsg = error instanceof Error ? error.message : String(error);
				const retryErrorMsg = errMsg.length > 100 ? errMsg.slice(0, 100) + '…' : errMsg;
				emitWrapped({
					type: SubAgentEventType.Progress,
					progressNote: `🔄 自动重试 (1/1): ${retryErrorMsg}`,
				});
			},
		});
	}

	/**
	 * Maps a fiber exit to the SubAgentResult contract (never throws):
	 * - interrupt → cancelled result + Interrupted event
	 * - failure   → error result + Failed event (timeout cap → exitReason 'timeout')
	 * - success   → Completion-Gate verdict applied + Completed event
	 */
	private _settleSubAgentResult(
		subAgent: SubAgentInstance,
		exit: FiberExit<_ProgramResult>,
		eventSink: SubAgentEventSink | undefined,
		groupId: string | undefined,
		startedAt: number,
	): SubAgentResult {
		const completedAt = Date.now();
		const durationMs = completedAt - startedAt;

		// P3: 被父级/用户取消 → 标记为 cancelled（不落入 success 路径，
		// 避免把已中断的子 agent 误报为成功，也不覆盖 interruptSubAgent 设置的 status）。
		if (exit._tag === 'interrupt') {
			subAgent.status = 'cancelled';
			subAgent.result = {
				success: false,
				error: 'Interrupted by user or parent agent',
				completedAt,
				durationMs,
				tokenUsage: subAgent.tokenCollector.getUsage(),
				exitReason: 'interrupted',
			};
			this._emit(eventSink, {
				type: SubAgentEventType.Interrupted,
				subAgentId: subAgent.id,
				subAgentType: subAgent.type,
				task: subAgent.task,
				parentId: subAgent.parentAgentId,
				timestamp: completedAt,
				error: 'Interrupted by user or parent agent',
				durationMs,
				exitReason: 'interrupted',
				groupId,
			});
			return subAgent.result;
		}

		if (exit._tag === 'failure') {
			const error = exit.error;
			const errMsg = error instanceof Error ? error.message : String(error);
			const exitReason: SubAgentExitReason = error instanceof SubAgentTimeoutError ? 'timeout' : 'error';
			subAgent.result = {
				success: false,
				error: errMsg,
				completedAt,
				durationMs,
				tokenUsage: subAgent.tokenCollector.getUsage(),
				exitReason,
			};
			subAgent.status = 'error';
			// 异常失败同样登记会话复用（「一个 subagent 执行完毕所有任务」）：
			// 失败前的探索上下文仍在会话中，后续单任务 delegate_task follow-up
			// 续跑同一 sessionId，避免冷启动丢失上下文。interrupted 不登记——
			// 父 turn 已取消，不会再有后续委派。
			this._markReusable(subAgent);
			this._emit(eventSink, {
				type: SubAgentEventType.Failed,
				subAgentId: subAgent.id,
				subAgentType: subAgent.type,
				task: subAgent.task,
				parentId: subAgent.parentAgentId,
				timestamp: completedAt,
				error: errMsg,
				durationMs,
				exitReason,
				groupId,
			});
			return subAgent.result;
		}

		// ── Success path: apply the Completion Gate verdict ──
		const { execResult, structured } = exit.value;
		// Determine exit reason (idle stall → timeout)
		const exitReason: SubAgentExitReason = execResult.stalled
			? 'timeout'
			: (execResult.budgetExhausted ? 'max_iterations' : 'completed');

		const gateSuccess = exitReason === 'completed' && (!structured || structured.status === 'success');
		// ── Salvage（优雅收尾）：停滞超时/预算耗尽但已有真实探索产出时，
		// 降级为「部分成功」——output 透传给父代理。formatDelegationResult 对
		// failed 只透传 error，会把 N 轮迭代收集的发现全盘丢弃（2026-07-25 线上：
		// 21 轮迭代 40+ 工具调用的结果被 exitReason 一句话否决）。
		const okToolCalls = execResult.toolTrace.filter(t => t.status === 'ok').length;
		// (b) 正常收尾但自报 partial/blocked（2026-07-27 线上：子代理跑满 15 轮、
		//     产出 9249 字符结构化发现，仅因诚实自报「部分假设与实际有出入」而被
		//     判 failed，result.output 被 formatDelegationResult 整个丢弃）。这类
		//     runs exitReason='completed'（既非 timeout 也非 max_iterations），此前
		//     不在 salvage 覆盖内 → success=false → 发现报告全盘蒸发。打捞条件：
		//     有真实工具产出 + 做了实质工作，保留 output、标 RESULT: partial（非 failed）。
		//     ⚠ 护栏：Explore 型必须**真正调用过探索工具**才打捞——否则 noRealExploration
		//     门控降级的「空洞 partial」（只调 index_repository 就交差）会被误打捞。
		//     真正的 failed（gate status==='failed' 或 errored）不打捞，仍透传 error。
		const usedRealExploration = execResult.toolTrace.some(t => _EXPLORE_REAL_TOOLS.has(t.toolName));
		const substantiveWork = subAgent.type === SubAgentType.Explore ? usedRealExploration : okToolCalls > 0;
		const completedPartial = exitReason === 'completed'
			&& !!structured
			&& (structured.status === 'partial' || structured.status === 'blocked')
			&& okToolCalls > 0
			&& substantiveWork;
		const salvageable = !gateSuccess
			&& (exitReason === 'timeout' || exitReason === 'max_iterations')
			&& okToolCalls > 0;
		const effectiveSuccess = gateSuccess || salvageable || completedPartial;
		const resultError = effectiveSuccess ? undefined : (
			structured
				? `Completion Gate: ${structured.status} — ${structured.reason}`
				: exitReason === 'timeout' ? 'Task timed out' : 'Task did not meet completion criteria'
		);
		subAgent.result = {
			success: effectiveSuccess,
			output: salvageable
				? `[部分完成 — ${exitReason === 'timeout' ? '模型响应停滞超时' : '预算/迭代耗尽'}，子代理未完成全部计划；以下为已获取的部分结果（${okToolCalls} 次工具调用）]\n\n${execResult.output}`
				: completedPartial
					? `[部分完成 — 子代理正常结束但自报 ${structured!.status}（如任务假设的文件/位置与实际有出入）；以下为已收集的发现（${okToolCalls} 次工具调用）]\n\n${execResult.output}`
					: execResult.output,
			error: resultError,
			completedAt,
			durationMs,
			apiCalls: execResult.apiCallCount,
			tokensUsed: execResult.tokensUsed,
			tokenUsage: subAgent.tokenCollector.getUsage(),
			// salvage 保留原 exitReason（父代理可见 partial 性质），gate 成功才归一 completed；
			// completedPartial 归一为 'partial'，让 formatDelegationResult 标 RESULT: partial。
			exitReason: gateSuccess ? 'completed' : (completedPartial ? 'partial' : exitReason),
		toolTrace: execResult.toolTrace,
		filesModified: execResult.filesModified.length > 0 ? execResult.filesModified : undefined,
		structured,
	};
	subAgent.status = effectiveSuccess ? 'done' : 'error';
	// 登记会话复用（done/error 均可被后续单任务 delegate_task follow-up 续跑）
	this._markReusable(subAgent);

	// P3：output_schema 结构化交接成功时，RESULT body 保持纯净 JSON——
	// 跳过 files-modified NOTE 与 COMPLETION GATE footer（对齐 MiMo
	// output_schema「schema requested ⇒ structured only, never prose」；
	// 校验：output 可解析为对象且 schema.required 键齐全）。
	const _cleanSchemaHandover = (() => {
		if (!subAgent.options.outputSchema) { return false; }
		const parsed = _tryParseJsonObject(subAgent.result.output ?? '');
		return !!parsed && _matchesRequiredKeys(parsed, subAgent.options.outputSchema);
	})();

	if (!_cleanSchemaHandover) {
		// ── File change coordination (inspired by Hermes file_state) ──
		// If the sub-agent modified files, append a warning to the output
		// so the parent agent knows to re-read those files.
		if (execResult.filesModified.length > 0) {
			const fileList = execResult.filesModified.join(', ');
			subAgent.result = {
				...subAgent.result,
				output: (subAgent.result.output ?? '') +
					`\n\n[NOTE: subagent modified files — re-read before editing: ${fileList}]`,
			};
		}
		// Append the Completion Gate verdict so the parent agent gets a reliable contract.
		subAgent.result = {
			...subAgent.result,
			output: (subAgent.result.output ?? '') +
				`\n\n[COMPLETION GATE] status=${structured.status} acceptanceMet=${structured.acceptanceMet} — ${structured.reason}`,
		};
	}

		this._emit(eventSink, {
			type: SubAgentEventType.Completed,
			subAgentId: subAgent.id,
			subAgentType: subAgent.type,
			task: subAgent.task,
			parentId: subAgent.parentAgentId,
			timestamp: Date.now(),
			output: execResult.output,
			durationMs,
			tokensUsed: execResult.tokensUsed,
			toolsCompleted: execResult.apiCallCount,
			exitReason,
			groupId,
		});

		return subAgent.result;
	}

	/**
	 * Build the Completion-Gate context from a sub-agent's task + execution result.
	 * Ground truth: files actually modified, whether it errored/truncated, and the
	 * acceptance criteria the parent spelled out in the task briefing (ACCEPTANCE clause).
	 */
	private _buildGateContext(subAgent: SubAgentInstance, exec: _ExecResult, incompleteTasks?: readonly string[]): ICompletionGateContext {
		const acceptance = extractAcceptanceCriteria(subAgent.task);
		// B：探索型子代理 ground-truth — 该子代理调用了工具、但没有任何真正的探索类工具。
		// 纯代码事实判定（toolTrace 是真实执行记录，不依赖 LLM 自述）：
		//   - toolTrace.length > 0：要求子代理确实执行过工具（排除零工具调用场景——
		//     零工具可能是合理的"从上下文直接作答"，也是重试测试的合法形态，不应误降级）。
		//   - !usedRealExploration：但所有调用都不属于探索类工具（如只调用了索引/元工具），
		//     说明子代理"看似忙了，实际没探索"，由 gateResult 把 status 降级为 partial。
		const usedRealExploration = exec.toolTrace.some(t => _EXPLORE_REAL_TOOLS.has(t.toolName));
		const noRealExploration = subAgent.type === SubAgentType.Explore
			&& exec.toolTrace.length > 0
			&& !usedRealExploration;
		return {
			filesTouched: exec.filesModified,
			errored: false,
			truncated: exec.budgetExhausted || !!exec.stalled,
			acceptanceCriteria: acceptance.length > 0 ? acceptance : undefined,
			incompleteTasks,
			noRealExploration,
		};
	}

	/**
	 * P2d: Query the DB TaskBoard for non-terminal tasks owned by this sub-agent.
	 * Returns undefined when no taskLookup is configured (caller did not wire DB
	 * access — gateResult falls back to output-marker inference only). On query
	 * failure, returns undefined (fail-open — a transient DB error must NEVER
	 * trap the agent in the gate, mirrors MiMo-Code's orElseSucceed(() => [])).
	 */
	private async _queryIncompleteTasks(subAgent: SubAgentInstance): Promise<readonly IIncompleteTask[] | undefined> {
		if (!this._taskLookup) { return undefined; }
		try {
			return await this._taskLookup({
				ownerAgentId: subAgent.id,
				parentSessionId: subAgent.options.parentSessionId,
			});
		} catch {
			return undefined;
		}
	}

	/**
	 * Execute multiple sub-agents in parallel (respecting maxConcurrent).
	 * Inspired by OpenCode's parallel explore pattern.
	 *
	 * Uses Promise.allSettled so that one sub-agent failure does NOT
	 * abort the entire batch. Failed sub-agents produce a SubAgentResult
	 * with success=false, and the caller can inspect each result individually.
	 */
	async executeMultipleSubAgents(
		subAgentIds: string[],
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		eventSink?: SubAgentEventSink,
		groupId?: string,
		/** P3: 父→子取消传播。同一父 turn 信号，扇出给每个并行子 agent。 */
		abortSignal?: AbortSignal,
		/**
		 * Per-call concurrency override. When provided, batches use this limit
		 * instead of the instance-level _maxConcurrent (e.g. plan_explore wants
		 * all N areas truly parallel, not throttled to the global default of 3).
		 */
		maxConcurrent?: number,
	): Promise<Map<string, SubAgentResult>> {
		const results = new Map<string, SubAgentResult>();
		const limit = Math.max(1, maxConcurrent ?? this._maxConcurrent);

		// Effect model: semaphore-bounded rolling window (forEachPar) replaces
		// hand-rolled batching — as soon as one sub-agent finishes, the next starts.
		// allSettled semantics are preserved: one sub-agent failure does NOT abort
		// the rest, and results map 1:1 to subAgentIds.
		const settled = await forEachPar(subAgentIds, limit, (subAgentId) =>
			this.executeSubAgent(subAgentId, executeFn, eventSink, groupId, abortSignal)
		);

		settled.forEach((outcome, i) => {
			const subAgentId = subAgentIds[i];
			if (outcome.status === 'fulfilled') {
				results.set(subAgentId, outcome.value);
			} else {
				// executeSubAgent itself never rejects (fiber exit → failed
				// SubAgentResult) — this branch is a safety net for truly
				// exceptional cases (e.g. precondition throws).
				results.set(subAgentId, {
					success: false,
					error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
					completedAt: Date.now(),
				});
			}
		});

		return results;
	}

	/**
	 * Convenience: create and execute in one call.
	 */
	async dispatch(
		parentAgentId: string,
		task: string,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		options?: SubAgentOptions,
		eventSink?: SubAgentEventSink,
		/** P3: 父→子取消传播。传入父 turn 的 AbortSignal。 */
		abortSignal?: AbortSignal,
	): Promise<SubAgentResult> {
		const subAgentId = this.createSubAgent(parentAgentId, task, options);
		return this.executeSubAgent(subAgentId, executeFn, eventSink, undefined, abortSignal);
	}

	/**
	 * Convenience: dispatch multiple explore agents in parallel.
	 * Inspired by OpenCode's Phase 1: parallel explore.
	 *
	 * @param perTaskOptions Optional per-task options override. If not provided,
	 *                       defaults to { type: Explore, priority: high, context }.
	 *                       v17: also accepts `worktreePath` for per-task worktree.
	 */
	async dispatchParallelExplore(
		parentAgentId: string,
		tasks: string[],
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		context?: string,
		perTaskOptions?: Array<Pick<SubAgentOptions, 'priority' | 'maxIterations' | 'timeout' | 'worktreePath' | 'type' | 'toolsets' | 'model' | 'parentChatMode' | 'parentWorkMode' | 'excludedTools' | 'agentId' | 'systemPrompt' | 'allowedTools'>>,

		eventSink?: SubAgentEventSink,
		/** P3: 父→子取消传播。传入父 turn 的 AbortSignal。 */
		abortSignal?: AbortSignal,
		/** Per-call concurrency override; defaults to the instance _maxConcurrent. */
		maxConcurrent?: number,
	): Promise<SubAgentResult[]> {
		const subAgentIds = tasks.map((task, idx) =>
			this.createSubAgent(parentAgentId, task, {
				// Default to Explore (read-only investigate) for parallel fan-out,
				// but honor an explicit per-task type (e.g. General for parallel writes).
				type: perTaskOptions?.[idx]?.type ?? SubAgentType.Explore,
				context,
				priority: perTaskOptions?.[idx]?.priority ?? 'high',
				maxIterations: perTaskOptions?.[idx]?.maxIterations,
				timeout: perTaskOptions?.[idx]?.timeout,
				// v17: propagate worktree to each parallel explore subagent.
				worktreePath: perTaskOptions?.[idx]?.worktreePath,
				// v17: propagate per-task toolset scope + model override.
				toolsets: perTaskOptions?.[idx]?.toolsets,
				model: perTaskOptions?.[idx]?.model,
				parentChatMode: perTaskOptions?.[idx]?.parentChatMode,
				parentWorkMode: perTaskOptions?.[idx]?.parentWorkMode,
				// A：只读探索子代理隐藏索引管理工具（防"只索引即停"）。
				excludedTools: perTaskOptions?.[idx]?.excludedTools,
				// agentId 驱动（2026-07-27）：并行探索默认解析到内置 code-explorer，
				// 携带其真实 systemPrompt / tools 白名单实例化子代理。
				agentId: perTaskOptions?.[idx]?.agentId,
				systemPrompt: perTaskOptions?.[idx]?.systemPrompt,
				allowedTools: perTaskOptions?.[idx]?.allowedTools,
			})
		);

		// Cluster all parallel explore agents under one group so the UI can render
		// them as a single grouped SubAgentCard.
		const groupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const resultMap = await this.executeMultipleSubAgents(subAgentIds, executeFn, eventSink, groupId, abortSignal, maxConcurrent);
		// Preserve 1:1 index alignment with `tasks` (callers rely on results[i] ≡ tasks[i]).
		// A missing entry (should never happen — executeMultipleSubAgents sets every id)
		// is replaced by a failed placeholder rather than filtered out, which would shift
		// all subsequent indices and desynchronize titles/cards.
		return subAgentIds.map(id => resultMap.get(id) ?? {
			success: false,
			error: `sub-agent result missing for ${id}`,
			completedAt: Date.now(),
		});
	}

	// ─── Status & Management ─────────────────────────────────────────────

	/** 当前运行中的子代理数量（供 delegate_task 并发截断保护使用）。 */
	get activeSubAgentCount(): number {
		let count = 0;
		for (const agent of this._activeSubAgents.values()) {
			if (agent.status === 'running') { count++; }
		}
		return count;
	}

	getSubAgentStatus(subAgentId: string): SubAgentStatusReport | undefined {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) { return undefined; }
		return {
			id: subAgent.id,
			type: subAgent.type,
			status: subAgent.status,
			task: subAgent.task,
			createdAt: subAgent.createdAt,
			budget: subAgent.budget.getSummary(),
		};
	}

	getAllSubAgents(): SubAgentStatusReport[] {
		return Array.from(this._activeSubAgents.values()).map(sa => ({
			id: sa.id,
			type: sa.type,
			status: sa.status,
			task: sa.task,
			createdAt: sa.createdAt,
			budget: sa.budget.getSummary(),
		}));
	}

	/**
	 * Get the permission profile for a sub-agent type.
	 */
	getPermissions(type: SubAgentType) {
		return SUB_AGENT_PERMISSIONS[type];
	}

	/**
	 * Check if a tool is allowed for a given sub-agent.
	 */
	isToolAllowed(type: SubAgentType, toolName: string): boolean {
		const perms = SUB_AGENT_PERMISSIONS[type];
		// If there's an explicit allow list that's not '*', check against it
		if (perms.allowedToolPatterns.length > 0 && !perms.allowedToolPatterns.includes('*')) {
			const matchesAllow = perms.allowedToolPatterns.some(pattern => {
				if (pattern === toolName) { return true; }
				if (pattern.endsWith('*') && toolName.startsWith(pattern.slice(0, -1))) { return true; }
				return false;
			});
			if (!matchesAllow) { return false; }
		}
		// Check deny list
		if (perms.deniedToolPatterns.includes(toolName) || perms.deniedToolPatterns.includes('*')) {
			// Deny '*' means deny all except explicitly allowed
			if (perms.deniedToolPatterns.includes('*') && perms.allowedToolPatterns.includes(toolName)) {
				return true; // Explicitly allowed overrides deny-all
			}
			return false;
		}
		return true;
	}

	/**
	 * Interrupt a running sub-agent.
	 * Inspired by Hermes-Agent's interrupt signal propagation:
	 * 1. Marks the sub-agent as interrupted so _executeWithBudget breaks out
	 * 2. Recursively interrupts any child sub-agents spawned by this one
	 * 3. Sets status to 'cancelled'
	 *
	 * @returns true if the sub-agent was found and interrupted, false otherwise
	 */
	interruptSubAgent(subAgentId: string): boolean {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) { return false; }

		// Effect model: cooperative cancellation via the per-instance InterruptSignal.
		// The signal is sticky — if the sub-agent is still pending, its fiber will
		// observe the interruption at the first interruption point once it starts.
		this._interruptSignals.get(subAgentId)?.interrupt('user');
		subAgent.status = 'cancelled';

		// Recursively interrupt all child sub-agents (inspired by Hermes)
		for (const [id, agent] of this._activeSubAgents.entries()) {
			if (agent.parentAgentId === subAgentId && agent.status === 'running') {
				this.interruptSubAgent(id);
			}
		}

		return true;
	}

	/**
	 * Cancel a sub-agent (legacy — now delegates to interruptSubAgent).
	 * @deprecated Use interruptSubAgent instead for recursive propagation.
	 */
	cancelSubAgent(subAgentId: string): boolean {
		return this.interruptSubAgent(subAgentId);
	}

	/**
	 * Interrupt ALL running sub-agents.
	 * Useful when the parent agent itself is interrupted and needs to
	 * clean up all child agents.
	 */
	interruptAll(): void {
		for (const [id, agent] of this._activeSubAgents.entries()) {
			if (agent.status === 'running') {
				this.interruptSubAgent(id);
			}
		}
	}

	cleanup(): void {
		for (const [id, subAgent] of this._activeSubAgents.entries()) {
			if (subAgent.status === 'done' || subAgent.status === 'error' || subAgent.status === 'cancelled') {
				this._activeSubAgents.delete(id);
				this._interruptSignals.delete(id);
			}
		}
	}

	get parentBudget(): IterationBudget { return this._parentBudget; }

	// ─── Private Helpers ─────────────────────────────────────────────────

	/**
	 * Build messages array for the sub-agent.
	 * Injects context (e.g., repo_overview) if provided.
	 */
	private _buildMessages(subAgent: SubAgentInstance): IChatMessage[] {
		const messages: IChatMessage[] = [];

		// MiMo RETURN_FORMAT 契约（2026-07-23）：非 forkContext 子代理的任务消息
		// 注入强制返回格式（**Status**/**Summary** 头）。契约随任务消息下发，
		// 系统提示词保持不变（冻结前缀缓存不受影响）；完成门据此优先采信
		// 模型自报状态（parseReturnHeader），无头时回退推断。
		// forkContext（peer/plan，主 agent 级角色）不注入 —— 保持父级语义。
		const task = subAgent.options.forkContext
			? subAgent.task
			: injectReturnFormatIntoTask(subAgent.task);

		// Inject context as a system-like user message prefix
		// task 用 <user_query>...</user_query> 包装，使子 agent 明确区分「用户真实指令」
		// 与注入的 codebase 上下文。
		if (subAgent.options.context) {
			messages.push({
				role: 'user',
				content: `## Codebase Context\n\n${subAgent.options.context}\n\n---\n\n## Task\n\n${wrapUserQuery(task)}`,
			});
		} else {
			messages.push({
				role: 'user',
				content: wrapUserQuery(task),
			});
		}

		return messages;
	}

	/**
	 * Build system prompt based on SubAgentType.
	 * Inspired by OpenCode's per-agent prompt files.
	 */
	private _buildSystemPrompt(subAgent: SubAgentInstance): string {
		// Fork prefix-cache alignment (MiMo): reuse the parent's frozen system
		// prompt verbatim so the LLM provider's prompt cache hits.
		if (subAgent.options.forkContext) {
			return subAgent.options.forkContext.systemPrompt;
		}
		const typePrompts: Record<SubAgentType, string> = {
			[SubAgentType.Explore]: `You are a code-explorer sub-agent. You excel at thoroughly navigating and understanding codebases.

## TOOL CALL BUDGET (strictly enforced):
| Tool | Max Calls | Purpose |
|------|-----------|---------|
| search_graph | 5 | Find symbols, classes, functions by name |
| search_code | 5 | Grep content patterns across ALL files |
| search_files | 10 | List file names matching a pattern ONLY |
| file_read | 15 | Read specific files you ALREADY identified |
| get_code_snippet | 3 | Get full code for a specific symbol |
TOTAL BUDGET: ~30 calls. Exceeding this wastes time and LLM tokens.

## MANDATORY WORKFLOW (follow this exact sequence):
1. **search_graph** — Find key symbols/classes/functions related to the task (3-5 calls)
2. **search_code** — Grep for content patterns if search_graph didn't find them (2-3 calls)
3. **search_files** — ONLY to verify file names exist (5-10 calls max)
4. **file_read** — Read ONLY the files you identified as relevant (10-15 calls)
5. **get_code_snippet** — Get full code for 2-3 most critical symbols
6. **STOP** — You now have enough information. Produce your output.

## ANTI-PATTERNS (never do these):
- ❌ Calling search_files 20+ times to scan a directory — use search_code instead
- ❌ Repeating the same search_files query — if it returned no results, it won't magically work
- ❌ Reading files you haven't verified are relevant — read only after search confirms relevance
- ❌ Searching for the same pattern in different directories — search_code searches ALL files at once
- ❌ Continuing to search after finding the key files — STOP and START reading

## CRITICAL TOOL DISTINCTION:
- **search_code** = grep. Searches file CONTENTS for a pattern across ALL files. Use this to find where a variable/function is used.
- **search_files** = file listing. Searches file NAMES matching a pattern. Use this ONLY when you need to know what files exist, not what's inside them.
- **search_graph** = structural search. Finds symbols, callers, dependencies. Use this FIRST.

## Rules:
- DO NOT edit/modify any files — you are in read-only mode
- NEVER call delegate_task recursively (you ARE a sub-agent)
- Always use search_graph as your FIRST tool
- When you have found the key files (usually after 15-20 tool calls), STOP searching and START reading
- Report findings in a clear structured format`,

			[SubAgentType.General]: `You are a general-purpose agent. You can read, write, and execute commands.
- Complete the task described by the user
- You CAN spawn sub-agents using delegate_task when the task can be decomposed into independent parallel subtasks
- Report your results clearly
- If you encounter errors, explain what went wrong

## When to use delegate_task:
- The task can be decomposed into 2+ independent subtasks
- You need to run multiple independent investigations simultaneously
- The subtask is complex enough to benefit from a dedicated context

## When NOT to use delegate_task:
- The task is simple and can be completed in one turn
- You need to maintain ongoing context/memory across steps
- You are already at maximum spawn depth (check parent agent constraints)

## Writing a good delegated task (CRITICAL):
- The sub-agent you spawn starts BLANK — it has no access to your conversation.
- Write each task as a self-contained briefing:
  GOAL (what to accomplish + why), CONTEXT (what you already know / ruled out),
  ACCEPTANCE (how to know it is done + output limits, e.g. "report in <200 words").
- Batch tasks (tasks: [...]) must be mutually independent; sequence dependent steps inside one task string.
- Pick a role with \`type\`: General (read+write), Explore (read-only investigate), Scout (read-only research).
  Batch tasks default to Explore — set General if the batched task must write files.`,

			[SubAgentType.Scout]: `You are a research agent for external libraries, dependency source, and documentation.
- Use repo_clone first when the task involves a GitHub repository
- After cloning, use Glob, Search Code, Read to inspect the cloned repository
- Use WebFetch for official documentation pages
- Use WebSearch to find relevant documentation
- DO NOT edit any files — you are in read-only mode
- Focus on understanding architecture, patterns, and key abstractions`,
		};

	// 经统一 composer 组装（stable-only：子 agent 无 context/volatile 膨胀），
	// 保证与主 loop 相同的 \n\n 分节与前缀指纹口径（P4 单源构造器）。
	// 子代理用 GLOBAL_SYSTEM_PREFIX_SUBAGENT（2026-07-26）：去除委派导向段落，
	// 杜绝子代理被诱导嵌套委派（事故 1785037741973）。
	// agentId 驱动（2026-07-27）：委派 / plan_explore / pre-loop 解析到内置 Agent 后，
	// 直接用其真实 systemPrompt 作为 stable 主体，替代按 type 选取的通用折中提示词。
	const stablePrompt = subAgent.options.systemPrompt || typePrompts[subAgent.type] || typePrompts[SubAgentType.General];
	// 回答语言限制（与父代理一致，Hermes 风格）：子代理默认跟随操作系统当前语言。
	// 子代理无 configurationService，统一走 'auto'（OS 检测）；父代理显式覆盖场景经
	// forkContext 路径复用父 frozen prompt 已含该指令。
	const responseLangDirective = buildResponseLanguageDirective(undefined);
	return composeFrozenPrefix({
		stable: joinSections(
			stablePrompt,
			GLOBAL_SYSTEM_PREFIX_SUBAGENT,
			GLOBAL_SYSTEM_SUFFIX,
			responseLangDirective,
		),
			context: '',
			volatile: '',
		});
	}

	/**
	 * Format bytes into a human-readable string (e.g., "1.5 KB", "2.3 MB").
	 */
	private _formatBytes(bytes: number): string {
		if (bytes < 1024) { return `${bytes} B`; }
		const units = ['KB', 'MB', 'GB'];
		let i = 0;
		let size = bytes / 1024;
		while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
		return `${size.toFixed(1)} ${units[i]}`;
	}

	/**
	 * Execute the sub-agent with budget tracking and fine-grained event emission.
	 *
	 * Budget consumption is the SOLE responsibility of this method.
	 * The executeFn receives the budget object for read-only checks only
	 * (e.g., budget.hasRemaining()) — it must NOT call budget.consume().
	 * This avoids double-counting when tool_end and tool_result fire
	 * for the same tool invocation.
	 *
	 * Inspired by Hermes-Agent's _run_single_child which tracks:
	 * - api_calls count
	 * - tool_trace (tool name, args/result size, status)
	 * - token usage (input/output)
	 */
	private async _executeWithBudget(
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		request: IAgentTurnRequest,
		budget: IterationBudget,
		tokenCollector: SubagentTokenCollector,
		emitEvent?: _BoundEmit,
		/** P3: 中断信号源（fiber InterruptSignal）+ attempt 级 stall watchdog。 */
		control?: _AttemptControl,
		/** 总时长上限（ms，2026-07-26 MiMo 对齐）：>0 时超限时走 stalled/salvage 路径（保产出），0=禁用。 */
		wallClockTimeoutMs: number = 0,
	): Promise<_ExecResult> {
		// 用分块数组累积，末尾一次性 join，避免流式 `+=` 产生 ConsString 绳索串
		// （output 最终进入 subAgent.result.output 长期留存，是最危险的泄漏点之一）
		let outputChunks: string[] = [];
		let apiCallCount = 0;
		let budgetExhausted = false;
		let stalled = false;
		let interrupted = false;
		let tokensUsed: { input: number; output: number } | undefined;
		const toolTrace: SubAgentToolTraceEntry[] = [];
		const filesModified: string[] = [];
		let currentToolName: string | undefined;
		let currentToolArgsSize = 0;
		let currentToolArgs: Record<string, unknown> | undefined;
		// Raw JSON string accumulated from streamed `tool_args` deltas. The main
		// execution path does NOT populate `tool_start.metadata`, so the only
		// reliable source of tool arguments is the `tool_args` content stream.
		// We concatenate every chunk (handles both single-shot and streamed
		// argument deltas) and JSON.parse it at `tool_end`.
		let currentToolArgsRawChunks: string[] = [];
		// Size and (on error) text of the most recent tool_result, used to fill
		// SubAgentToolTraceEntry.resultSizeBytes / error at the following tool_end.
		let currentToolResultSize = 0;
			let currentToolResultText: string | undefined;

	// ── 流式追踪（定位 "subagent 草草结束/无输出" 类 bug）──
	const _t0Stream = Date.now();
	let _deltaCount = 0;
	let _textDeltaCount = 0;
	let _textBytes = 0;
	let _lastTextPreview = '';
	let _prevDeltaAt = 0;
	// P1: 单响应软上限计时（2026-07-26）。0 = 等待新响应开始；首个内容 delta 起表。
	// tool_end/'done'（模型流结束标记）归零——工具执行时间不计入响应窗口
	// （执行自有 toolExecutionGuard 兜底，嵌套 delegate 可达 630s）。
	let _responseStartAt = 0;
	// ── 收敛检测：search_files 调用限制 + 无新文件发现计数 ──
	// 2026-07-26 分析日志 1785068621468：subagent 在 UE5 大代码库上做线性扫描
	// （127 次 search_files + 74 次 file_read 其中 21 次重复），15min 超时。
	// 限制 search_files 调用次数，并在连续 N 次迭代无新文件发现时注入收敛提示。
	const _searchFilesCount = { value: 0 };
	const _SEARCH_FILES_LIMIT = 30;
	const _CONVERGENCE_THRESHOLD = 5;
	let _consecutiveNoNewFiles = 0;
	const _uniqueFilesFound = new Set<string>();
		const stream = executeFn(request, budget);
		// Effect model — hung-stream escape hatch: if the fiber is interrupted
		// while the stream produces no further deltas, actively return() the
		// generator so the for-await loop unwinds (the loop's post-check then
		// reports the interruption). Only registered for LIVE interrupts — a
		// pre-interrupted signal is handled by the first delta's interruption
		// point, guaranteeing the stream always starts (start-then-cancel order).
		const iterator = stream[Symbol.asyncIterator]();
		let unlinkInterrupt: (() => void) | undefined;
		if (control && !control.signal.interrupted) {
			unlinkInterrupt = control.signal.onInterrupt(() => {
				iterator.return?.().catch(() => { /* best-effort unwind */ });
			});
		}
		try {
		for await (const delta of stream) {
				_deltaCount++;
				const _now = Date.now();
				// DELTA GAP 检测：>10s 空窗（定位"模型在等什么"）
				if (_prevDeltaAt > 0 && _now - _prevDeltaAt > 10_000) {
					this._log?.('warn', `[SubAgent stream] DELTA GAP | ${_now - _prevDeltaAt}ms delta#${_deltaCount - 1}→#${_deltaCount} elapsed=${Math.round((_now - _t0Stream) / 1000)}s agent=${request.agentId}`);
				}
				_prevDeltaAt = _now;
				// ── Text accumulation + heartbeat ──
				if (delta.type === 'text' && delta.content) {
					outputChunks.push(delta.content);
					// 实时文本滚动：text delta 发 TextDelta 事件，inlineTraceSink 累积到 card.streamingOutput
					if (emitEvent) {
						emitEvent({ type: SubAgentEventType.TextDelta, textDelta: delta.content });
					}
					_textDeltaCount++;
					_textBytes += delta.content.length;
					_lastTextPreview = delta.content.length > 80 ? delta.content.slice(0, 80) + '…' : delta.content;
					if (_textDeltaCount % 10 === 0) {
						this._log?.('info', `[SubAgent stream] text heartbeat | delta#${_deltaCount} textDeltas=${_textDeltaCount} textBytes=${_textBytes} elapsed=${Math.round((_now - _t0Stream) / 1000)}s last="${_lastTextPreview}" agent=${request.agentId}`);
					}
				}

			// ── Thinking (inspired by Hermes TASK_THINKING) ──
			if (delta.type === 'thinking' && emitEvent) {
				const text = typeof delta.content === 'string' ? delta.content : '';
				if (text) {
					emitEvent({
						type: SubAgentEventType.Thinking,
						thinkingText: text.slice(0, 200),
					});
				}
			}

			// ── Tool started ──
			// 子代理 tool_start/tool_end 通过 fireSubAgentTrace 旁路总线实时推送到
			// SubAgentCard（不走 agentTurnExecutor 的 delta 流，不会触发 orphan 检测）。
			if (delta.type === 'tool_start') {
				currentToolName = delta.toolName || 'unknown';
				currentToolArgsSize = 0;
				currentToolArgs = undefined;
				currentToolArgsRawChunks = [];
				currentToolResultSize = 0;
				currentToolResultText = undefined;
				if (delta.metadata) {
					try {
						currentToolArgsSize = JSON.stringify(delta.metadata).length;
						currentToolArgs = delta.metadata;
					} catch { /* ignore */ }
				}
				this._log?.('info', `[SubAgent stream] tool_start | ${currentToolName} (argsSize~${currentToolArgsSize}B) delta#${_deltaCount} elapsed=${Math.round((Date.now() - _t0Stream) / 1000)}s agent=${request.agentId}`);
				if (emitEvent) {
					let argsPreview: string | undefined;
					if (delta.metadata) {
						try { argsPreview = JSON.stringify(delta.metadata).slice(0, 200); } catch { /* ignore */ }
					}
					emitEvent({
						type: SubAgentEventType.ToolStarted,
						toolName: currentToolName,
						toolArgsPreview: argsPreview,
						toolsCompleted: apiCallCount,
					});
				}
			}

			// ── Tool arguments streaming ──
			if (delta.type === 'tool_args' && delta.content) {
				currentToolArgsSize += delta.content.length;
				// Accumulate the raw argument JSON so it can be parsed at tool_end.
				// This is the primary source of args for file-change detection,
				// since tool_start.metadata is empty on the main execution path.
				currentToolArgsRawChunks.push(delta.content);
			}

			// ── Tool result (captured for trace size / error text) ──
			if (delta.type === 'tool_result' && typeof delta.content === 'string') {
				currentToolResultSize = delta.content.length;
				currentToolResultText = delta.content;
			}

			// ── Tool completed (inspired by Hermes TASK_TOOL_COMPLETED) ──
			if (delta.type === 'tool_end') {
				apiCallCount++;
				const toolStatus: 'ok' | 'error' = delta.success === false ? 'error' : 'ok';
				// 在此将分块累积的 raw args 拼成最终字符串（仅末尾 join 一次，不产生绳索串）
				const currentToolArgsRaw = currentToolArgsRawChunks.join('');

				// Resolve tool arguments: prefer the accumulated `tool_args` JSON
				// stream (authoritative on the main path); fall back to metadata
				// seeded at tool_start. Without this, file-change detection never
				// fires because tool_start carries no parameters.
				if (!currentToolArgs && currentToolArgsRaw) {
					try {
						const parsed = JSON.parse(currentToolArgsRaw);
						if (parsed && typeof parsed === 'object') {
							currentToolArgs = parsed as Record<string, unknown>;
						}
					} catch { /* incomplete or non-JSON args — ignore */ }
				}
				if (currentToolArgsRaw && !currentToolArgsSize) {
					currentToolArgsSize = currentToolArgsRaw.length;
				}

				const traceEntry: SubAgentToolTraceEntry = {
					toolName: currentToolName || 'unknown',
					status: toolStatus,
					argsSizeBytes: currentToolArgsSize || undefined,
					resultSizeBytes: currentToolResultSize || undefined,
					error: toolStatus === 'error' ? (currentToolResultText?.slice(0, 500) || undefined) : undefined,
				};
				toolTrace.push(traceEntry);
				this._log?.('info', `[SubAgent stream] tool_end | ${currentToolName} status=${toolStatus} resultSize=${currentToolResultSize}B apiCalls=${apiCallCount} delta#${_deltaCount} elapsed=${Math.round((Date.now() - _t0Stream) / 1000)}s agent=${request.agentId}`);

				// ── File change coordination (inspired by Hermes file_state) ──
				// Track files modified by file-writing tools so the parent agent
				// can be warned that its cached file reads may be stale.
				if (currentToolName && currentToolArgs && toolStatus === 'ok') {
					const filePath = this._extractModifiedFile(currentToolName, currentToolArgs);
					if (filePath && !filesModified.includes(filePath)) {
						filesModified.push(filePath);
					}
				}

			// 通过 fireSubAgentTrace 旁路总线实时推送工具完成事件到 SubAgentCard
			if (emitEvent) {
				// P4: 结构化截断（previewStructured 模块级实现：先解内容包装，
				// 对象保留顶层 key 截断 value，数组给元素摘要，不产生索引键垃圾）
				let resultPreview: string | undefined;
				if (currentToolResultText !== undefined) {
					resultPreview = previewStructured(currentToolResultText, 500);
				} else if (currentToolResultSize > 0) {
					resultPreview = `[result: ${this._formatBytes(currentToolResultSize)}]`;
				}
				let argsPreview: string | undefined;
				if (currentToolArgsRaw) {
					argsPreview = previewStructured(currentToolArgsRaw, 200);
				} else if (currentToolArgs) {
						try { argsPreview = JSON.stringify(currentToolArgs); } catch { /* ignore */ }
						if (argsPreview && argsPreview.length > 200) { argsPreview = argsPreview.slice(0, 200) + '…'; }
					}
					emitEvent({
						type: SubAgentEventType.ToolCompleted,
						toolName: currentToolName || 'unknown',
						toolStatus,
						toolsCompleted: apiCallCount,
						toolResultPreview: resultPreview,
						toolArgsPreview: argsPreview,
					});
				}

				// ── search_files 调用限制 + search_code 引导 ──
				if (currentToolName === 'search_files') {
					_searchFilesCount.value++;
					// 在达到限制前，先引导使用 search_code
					if (_searchFilesCount.value === 8) {
						this._log?.('info', `[SubAgent convergence] search_files count 8, suggesting search_code agent=${request.agentId}`);
						outputChunks.push(`\n\n[SYSTEM] You have called search_files ${_searchFilesCount.value} times. If you are looking for content patterns (variable usage, function calls, text matches), use search_code instead — it searches ALL file contents at once. search_files only lists file NAMES, not content.`);
					}
					if (_searchFilesCount.value > _SEARCH_FILES_LIMIT) {
						this._log?.('warn', `[SubAgent convergence] search_files limit reached (${_SEARCH_FILES_LIMIT}), injecting stop hint agent=${request.agentId}`);
						outputChunks.push(`\n\n[SYSTEM] You have called search_files ${_searchFilesCount.value} times (limit: ${_SEARCH_FILES_LIMIT}). STOP searching and START reading the files you have already found. If you have enough information, produce your final output NOW.`);
					}
				}

				// ── search_code 未使用检测 ──
				// 如果 search_files 被频繁调用但 search_code 从未被调用，引导使用 search_code
				if (currentToolName === 'search_files' && _searchFilesCount.value === 5) {
					const searchCodeCalls = toolTrace.filter(t => t.toolName === 'search_code').length;
					if (searchCodeCalls === 0) {
						this._log?.('info', `[SubAgent convergence] search_files used ${_searchFilesCount.value}x but search_code never used, suggesting search_code agent=${request.agentId}`);
						outputChunks.push(`\n\n[SYSTEM] HINT: You are using search_files repeatedly. If you need to find WHERE a pattern appears in file CONTENTS (not just file names), use search_code with a regex pattern. Example: search_code(pattern="CollectGarbage", filePattern="*.cpp")`);
					}
				}

				// ── file_read 重复读取检测 ──
				if (currentToolName === 'file_read' && currentToolArgs) {
					const filePath = String(currentToolArgs['path'] ?? currentToolArgs['file_path'] ?? '');
					if (filePath && _uniqueFilesFound.has(filePath)) {
						// 文件已在 search_files 中发现过，正常读取
					} else if (filePath) {
						// 检查是否已读过（简单路径匹配）
						const readFiles = toolTrace.filter(t => t.toolName === 'file_read').length;
						if (readFiles > 20) {
							this._log?.('warn', `[SubAgent convergence] file_read count ${readFiles} exceeds 20, may be reading too many files agent=${request.agentId}`);
						}
					}
				}

				// ── 收敛检测：跟踪新文件发现 ──
				// search_files 结果中的文件路径提取（简单启发式：匹配含 / 或 \ 的路径片段）
				if (currentToolName === 'search_files' && currentToolResultText) {
					const beforeSize = _uniqueFilesFound.size;
					const pathMatches = currentToolResultText.match(/[A-Za-z]:[\\/][^\s"',;|]+\.(cpp|h|hpp|cs|ts|js|py|rs|java|go|rb|c|cc|cxx|hxx|inl|md|txt|json|xml|yaml|yml|toml|cfg|ini|bat|sh|ps1)/gi);
					if (pathMatches) {
						for (const p of pathMatches) { _uniqueFilesFound.add(p); }
					}
					if (_uniqueFilesFound.size === beforeSize) {
						_consecutiveNoNewFiles++;
					} else {
						_consecutiveNoNewFiles = 0;
					}
					if (_consecutiveNoNewFiles >= _CONVERGENCE_THRESHOLD) {
						this._log?.('warn', `[SubAgent convergence] ${_consecutiveNoNewFiles} consecutive iterations with no new files, injecting convergence hint agent=${request.agentId}`);
						outputChunks.push(`\n\n[SYSTEM] You have not discovered any new files in the last ${_consecutiveNoNewFiles} search iterations. The files you need are likely already found. STOP searching and START reading/analyzing them. If you have enough information, produce your final output NOW.`);
						_consecutiveNoNewFiles = 0; // Reset to avoid spamming hints
					}
				}

				budget.consume(1);
				if (!budget.hasRemaining()) {
					outputChunks.push('\n\n[Budget exhausted — sub-agent stopped]');
					budgetExhausted = true;
					break;
				}
			}

			// ── Usage/token tracking ──
			if (delta.type === 'usage' && delta.usage) {
				// Accumulate across multiple usage events (one per LLM turn) rather
				// than overwriting, so multi-iteration sub-agents report total cost.
				const inTok = delta.usage.inputTokens ?? 0;
				const outTok = delta.usage.outputTokens ?? 0;
				if (!tokensUsed) {
					tokensUsed = { input: inTok, output: outTok };
				} else {
					tokensUsed.input += inTok;
					tokensUsed.output += outTok;
				}
				// Record to SubagentTokenCollector for detailed per-turn tracking
				// (inspired by deer-flow SubagentTokenCollector)
				tokenCollector.recordUsage({
					inputTokens: inTok,
					outputTokens: outTok,
					cacheHitTokens: delta.usage.cachedTokens,
					cacheWriteTokens: delta.usage.cacheWriteTokens,
				});
			}

		// ── Terminal events ──
		// ⚠ 'done' 不能作为终止信号：executeAgentTurn 会在「每个迭代的 provider 流结束」
		// 透传一个 done（languageModelsBridge 流尾统一 yield done，executor 经
		// _adaptModelDelta 原样转发，见 agentChatService L1894 注释「agent loop 中每次
		// LLM turn 结束都会 yield done」）。若在 done 处 break，for-await 会 return() 掉
		// executor 生成器 —— 本轮工具调用尚未执行、后续迭代全部夭折，子代理带着
		// 「开场白」文本空转返回（2026-07-25 线上事故：3 个 code-explorer 子代理各自
		// 仅 1 次 LLM 调用、0 次工具执行、4s 内"成功"返回）。
		// 正确做法：done 只是迭代边界事件，继续消费；executeAgentTurn 在真正的轮末
		// yield 自己的 done 后生成器自然 return，for-await 随之结束。
		if (delta.type === 'error') {
			break;
		}

		// ── Interruption point (Effect model): user interrupt or parent abort (P3) ──
		try {
			control?.signal.throwIfInterrupted();
		} catch (e) {
			if (!isFiberInterrupt(e)) { throw e; }
			outputChunks.push('\n\n[Interrupted by user or parent agent]');
			interrupted = true;
			if (emitEvent) {
				emitEvent({
					type: SubAgentEventType.Interrupted,
					exitReason: 'interrupted',
				});
			}
			break;
		}

	// ── Stall watchdog（2026-07-26 MiMo-Code 分层超时对齐重构，attempt-local）──
	// 活动语义（P1）：模型流期间「内容级 delta」计活——长最终答案的持续流式输出
	// 是健康状态，不再误判停滞（旧语义仅 tool_start/tool_end 计活：线上事故
	// 1785037741973 中，子代理阻塞等待嵌套 delegate 子代理 150.8s，看门狗在
	// 子代理完成前 37ms 误杀父代理；>阈值的最终答案流同理会误杀）。
	// usage/done/phase_change/memory_injected 等帧外事件不计活（对齐 MiMo：
	// keep-alive 只证明连接活着，不证明模型在产出）。
	// 工具执行窗口（P0）：tool_start→pause / tool_end→resume（引用计数），
	// 覆盖「参数流式 + 全部在飞工具执行」整段盲区；工具执行由 toolExecutionGuard
	// 兜底（编排工具 630s）。tool_args 虽处暂停窗口仍是模型活动 → tick 记录。
	if (delta.type === 'tool_start') {
		control?.watchdog.pause();
	} else if (delta.type === 'tool_end') {
		control?.watchdog.resume();
	}
	if (_STALL_CONTENT_DELTA_TYPES.has(delta.type)) {
		control?.watchdog.tick();
	}
	if (control?.isStalled()) {
		outputChunks.push('\n\n[Stalled — no progress for too long, aborted]');
		stalled = true;
		break;
	}
	// Wall-clock 总时长上限（2026-07-26 规则变更：要求限时，MiMo 对齐）——
	// 与停滞看门狗同一 delta 检查点：超时走 stalled/salvage 路径（保留产出 +
	// P1 禁工具总结），对齐 MiMo「timeout 状态照交结果」而非硬失败。
	// 注：完全零 delta 的极端挂起不经过此点，由外层 timeout() 组合器硬杀。
	if (wallClockTimeoutMs > 0 && _now - _t0Stream > wallClockTimeoutMs) {
		outputChunks.push(`\n\n[总时长上限 ${Math.round(wallClockTimeoutMs / 1000)}s 已到，保留已完成结果并收尾]`);
		stalled = true;
		break;
	}
	// ── P1: 单响应软上限（对齐 MiMo chunkTimeout=480s）──
	// 连续模型响应段（两次工具边界之间的内容流）超过 responseSoftCapMs → 判停滞，
	// 防止「空谈永动」（无限文本流从不调用工具）。tool_end/'done' 归零：
	// 工具执行时间不计入响应窗口。健康长答案（实测 80s 级）充分放行。
	if (delta.type === 'tool_end' || delta.type === 'done') {
		_responseStartAt = 0;
	} else if (_STALL_CONTENT_DELTA_TYPES.has(delta.type)) {
		if (_responseStartAt === 0) {
			_responseStartAt = _now;
		} else if (_now - _responseStartAt > this.responseSoftCapMs) {
			outputChunks.push(`\n\n[Stalled — single response exceeded soft cap (${Math.round(this.responseSoftCapMs / 1000)}s), aborted]`);
			stalled = true;
			break;
		}
	}
		}
		} finally {
			unlinkInterrupt?.();
		}
	// The generator may have been unwound externally (hung-stream escape hatch)
	// without passing an interruption point — still report the interruption.
	if (!interrupted && control?.signal.interrupted && !stalled) {
		outputChunks.push('\n\n[Interrupted by user or parent agent]');
		interrupted = true;
	}
	// ── 交接日志：子 agent 结束时的完整总结（定位"为什么 output 这么少"）──
	const _duration = Date.now() - _t0Stream;
	this._log?.('info', `[SubAgent handover] DONE | agent=${request.agentId} duration=${_duration}ms totalDeltas=${_deltaCount} textDeltas=${_textDeltaCount} textBytes=${_textBytes} toolCalls=${apiCallCount} tokens=${tokensUsed ? `in=${tokensUsed.input}/out=${tokensUsed.output}` : 'n/a'} stalled=${stalled} interrupted=${interrupted} budgetExhausted=${budgetExhausted} outputLen=${outputChunks.join('').length} lastTextPreview="${_lastTextPreview}"`);

	// ── 弱输出兜底：LLM 只产生极短文本（如"I'll start"这类占位语，无实质内容）
	// 或完全无 text delta（只有 tool calls）时，若不干预，gateResult('') /
	// gateResult('I'll start') 会默认判 success（无错误/无截断），最终父 agent
	// 只看到一句空话，看不到子代理实际做了什么——这正是"subagent 不干活"的
	// 表现之一（子代理其实调用了工具，但输出内容空洞，父 agent 误判为无产出）。
	// 从 tool traces 合成结构化摘要追加到弱输出之后，确保父 agent 始终能看到
	// 子代理实际执行的工具轨迹，即使模型没有生成有意义的文字总结。
	const _rawOutput = outputChunks.join('');
	const _isEmptyOutput = _rawOutput.trim().length === 0;
	// 弱输出阈值：短于 40 字符且非空——大概率是"I'll start..."/"Let me..."之类的
	// 未完成占位语，而非真正的分析结论。
	const _isWeakOutput = !_isEmptyOutput && _rawOutput.trim().length < 40;
	if ((_isEmptyOutput || _isWeakOutput) && toolTrace.length > 0) {
		// 探测"只调用了 index_repository（建索引）就自然结束"这种典型的过早终止——
		// LLM 把索引启动的确认信息误当成任务完成信号，未继续调用 search_graph 等
		// 真正的探索工具。这是本次日志问题 2 的具体根因，显式标注便于父 agent
		// 及排障人员识别，而不是简单认为「探索完成但无发现」。
		const _exploreToolNames = new Set(['search_graph', 'query_graph', 'get_code_snippet', 'trace_path', 'get_architecture', 'search_files', 'file_read']);
		const _onlyIndexed = toolTrace.length > 0 && toolTrace.every(t => t.toolName === 'index_repository') && !toolTrace.some(t => _exploreToolNames.has(t.toolName));
		const summaryLines: string[] = [];
		if (_onlyIndexed) {
			// 用 'partial'（SubAgentGateStatus 合法值）而非自造状态词，确保
			// parseReturnHeader 能正确解析并让 Completion Gate 按「未完成」处理，
			// 而不是被默认判定为 success。
			summaryLines.push(`**Status**: partial`);
			summaryLines.push(`**Summary**: Sub-agent only called \`index_repository\` (index build) and then stopped ` +
				`without performing any actual exploration (search_graph/query_graph/get_code_snippet/etc). ` +
				`No real findings were produced — this looks like a premature stop after indexing. ` +
				`The parent agent should re-delegate this task or perform the exploration directly.`);
		} else if (_isWeakOutput) {
			// 保留模型原始（弱）文本作为上下文，避免信息丢失。
			summaryLines.push(`**Status**: success`);
			summaryLines.push(`**Summary**: Model output was too short ("${_rawOutput.trim()}") to be a real finding. ` +
				`Falling back to tool execution trace below — the parent agent should treat this as a ` +
				`potentially incomplete exploration and verify or re-delegate if the trace looks insufficient.`);
		} else {
			summaryLines.push(`**Status**: success`);
			summaryLines.push(`**Summary**: Executed ${apiCallCount} tool call(s) — no text summary was generated by the model.`);
		}
		summaryLines.push('', '**Tool execution trace**:');
		for (const t of toolTrace) {
			const statusIcon = t.status === 'ok' ? '✅' : '❌';
			const argsPreview = t.argsSizeBytes ? ` (${t.argsSizeBytes}B args)` : '';
			const resultPreview = t.resultSizeBytes ? ` → ${t.resultSizeBytes}B result` : '';
			summaryLines.push(`- ${statusIcon} \`${t.toolName}\`${argsPreview}${resultPreview}`);
		}
		if (filesModified.length > 0) {
			summaryLines.push('', `**Files touched**: ${filesModified.join(', ')}`);
		}
		outputChunks.push('\n\n' + summaryLines.join('\n'));
		this._log?.('info', `[SubAgent handover] synthesized output from ${toolTrace.length} tool traces ` +
			`(${_isEmptyOutput ? 'empty' : 'weak'} LLM text, rawLen=${_rawOutput.trim().length}) agent=${request.agentId}`);
	}

	return { output: outputChunks.join(''), apiCallCount, budgetExhausted, tokensUsed, toolTrace, filesModified, stalled, interrupted };
}

	/** Safely deliver a lifecycle event to the sink, swallowing any sink errors. */
	private _emit(sink: SubAgentEventSink | undefined, event: SubAgentLifecycleEvent): void {
		if (!sink) { return; }
		try {
			sink(event);
		} catch {
			// Event delivery must never break sub-agent execution.
		}
	}

	/**
	 * Extract a file path from a tool call if the tool is a file-modifying tool.
	 * Inspired by Hermes-Agent's file_state coordination which tracks which files
	 * sub-agents read/write to warn the parent about stale cache.
	 */
	private _extractModifiedFile(toolName: string, args: Record<string, unknown>): string | undefined {
		// File-writing tools and their argument key containing the file path
		const FILE_WRITE_TOOLS: Record<string, string> = {
			'write_to_file': 'path',
			'apply_diff': 'path',
			'create_file': 'path',
			'edit_file': 'path',
			'write': 'path',
			'edit': 'path',
			'rename_file': 'path',
			'delete_file': 'path',
			'file_write': 'path',
			'file_edit': 'path',
		};

		const pathKey = FILE_WRITE_TOOLS[toolName];
		if (!pathKey) { return undefined; }

		const filePath = args[pathKey];
		if (typeof filePath === 'string' && filePath.length > 0) {
			return filePath;
		}

		return undefined;
	}
}
