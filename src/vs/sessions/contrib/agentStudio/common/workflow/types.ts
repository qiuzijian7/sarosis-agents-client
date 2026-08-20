/*---------------------------------------------------------------------------------------------
 *  Dynamic Workflow — Service Definition (types only)
 *
 *  对齐 deepseek-harness `workflow/types.ts` 与 Claude Code dynamic-workflows 范式：
 *  模型写一段纯 JS 编排脚本，脚本内用 agent()/parallel()/pipeline() 扇出子代理，
 *  return 的 JSON 即工具结果。脚本无 fs/网络/timer —— 子代理干活，脚本只协调。
 *
 *  本文件是 seam 的词汇表：run/result/事件/错误分级/caps。零运行时依赖
 *  （除 WorkflowError 与校验工厂），host 引擎、worker 源码、工具层、UI 共享。
 *
 *  设计文档：doc/Dynamic-Workflow-Integration-Design.md §3.2.1
 *--------------------------------------------------------------------------------------------*/

/** 标识一次 workflow run。crypto.randomUUID() 铸造；测试可注入 fixture。 */
export type WorkflowRunId = string;

/** meta.phases 的一项（进度词汇，不施加执行结构）。 */
export interface IWorkflowPhase {
	readonly title: string;
	readonly detail?: string;
}

/**
 * 脚本的身份块，作为工具参数（JSON）随调用传入，引擎在跑脚本体前校验。
 * 字段词汇对齐 Claude Code dynamic-workflows meta block。
 */
export interface IWorkflowMeta {
	/** 短 kebab-case 名称（显示 + 归档键）。必填。 */
	readonly name: string;
	/** 一行描述。必填。 */
	readonly description: string;
	/** 何时适用的提示（可选）。 */
	readonly whenToUse?: string;
	/** phase 声明（phase() 按精确标题匹配；可选）。 */
	readonly phases?: readonly IWorkflowPhase[];
}

/** run 为何收敛。CLOSED union，消费方可穷尽。 */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error';

/** run 的终态。value 仅在 completed 时有意义。 */
export interface IWorkflowResult {
	/** 脚本 return 的物化值（plain JSON；脚本无 return → null）。 */
	readonly value: unknown;
	readonly stopReason: WorkflowStopReason;
	/** 失败消息（stopReason !== 'completed' 时存在）。 */
	readonly error?: string;
	/** 整个 run 生命周期内接受的 agent() 调用数。 */
	readonly agentsStarted: number;
}

/** 一次 agent() 调用的身份（`workflow/agent-start` 事件载荷）。 */
export interface IWorkflowAgentInfo {
	/** run 内 1-based 序号。 */
	readonly seq: number;
	/** 显示标签（label 选项或 prompt 首行截断）。 */
	readonly label: string;
	/** 所属 phase（phase 选项或当前 phase() 标题）。 */
	readonly phase?: string;
	/** 子代理在 dispatch 侧的 id。 */
	readonly childId: string;
}

/** agent() 调用如何收敛。 */
export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled';

/** 一次 agent() 调用的收敛（`workflow/agent-end` 事件载荷）。 */
export interface IWorkflowAgentEndInfo extends IWorkflowAgentInfo {
	readonly outcome: WorkflowAgentOutcome;
}

// ─── 失败分级（设计文档 §1.5 / §3.4）───────────────────────────────────────

/** 引擎/契约错误码。全部 fatal（穿透组合子，杀死脚本）。 */
export type WorkflowErrorCode =
	| 'SCRIPT_PARSE'            // 脚本体语法错（new Function 编译失败）
	| 'META_INVALID'            // meta 块缺字段/非法
	| 'INVALID_ARGUMENT'        // hook 参数类型错（agent(42) 等）
	| 'UNSUPPORTED_OPTION'      // agent() 未知选项（含 deferred：effort/isolation/agentType 外部词汇）
	| 'UNSUPPORTED_SCHEMA'      // schema 超出受限子集
	| 'AGENT_CAP'               // 超单 run 总 agent 上限（runaway 兜底）
	| 'ITEM_CAP'                // parallel/pipeline 单次条目超限
	| 'AGENT_START'             // 子代理启动失败（基建故障）
	| 'AGENT_RESULT'            // 子代理 result reject（基建故障——区别于子代理自身失败）
	| 'CANCELLED'               // run 被取消
	| 'RESULT_UNSERIALIZABLE';  // return 值不是 plain JSON

/**
 * fatal 编排错误。worker 侧组合子（parallel/pipeline）用 instanceof 判定 fatality：
 * 本类在宿主 realm 构造（worker 脚本无法伪造 instanceof），普通子代理失败不构造本类
 * → 落为 per-item null。这与 dsh WorkflowError 的信任模型一致。
 */
export class WorkflowError extends Error {
	constructor(message: string, readonly code: WorkflowErrorCode) {
		super(`[${code}] ${message}`);
		this.name = 'WorkflowError';
	}
}

/** 判定 unknown 是否 fatal WorkflowError（instanceof —— 脚本无法伪造）。 */
export function isFatalWorkflowError(e: unknown): e is WorkflowError {
	return e instanceof WorkflowError;
}

// ─── Caps（worker 侧执行上限；host 侧另持 disposeGraceMs）──────────────────

export interface IWorkflowLimits {
	/** 并发 agent() 上限（FIFO 排队）。≥1。 */
	readonly maxConcurrentAgents: number;
	/** 单 run 总 agent() 上限（runaway 兜底）。≥1。 */
	readonly maxTotalAgents: number;
	/** parallel()/pipeline() 单次条目上限。≥1。 */
	readonly maxItemsPerCall: number;
}

export const DEFAULT_WORKFLOW_LIMITS: Readonly<IWorkflowLimits> = Object.freeze({
	maxConcurrentAgents: 5,      // 对齐 dispatch DEFAULT_MAX_CONCURRENCY
	maxTotalAgents: 1000,
	maxItemsPerCall: 4096,
});

/** run 句柄（引擎唯一对外输出面）。result 永不 reject。 */
export interface IWorkflowRunHandle {
	readonly id: WorkflowRunId;
	readonly meta: IWorkflowMeta;
	/** 收敛时 resolve（永不 reject）—— 所有失败映射为非 completed stopReason。 */
	readonly result: Promise<IWorkflowResult>;
	/** 取消：worker hooks 在下一个边界抛 CANCELLED，children 中断，grace 内强收。幂等。 */
	cancel(reason?: string): void;
	/** 有界收敛（grace 内），worker terminate、children dispose。幂等。 */
	dispose(): Promise<void>;
}

/** 引擎事件（UI/recorder/画布桥共用的单一事件面）。 */
export type WorkflowEngineEvent =
	| { readonly type: 'start'; readonly id: WorkflowRunId; readonly meta: IWorkflowMeta }
	| { readonly type: 'phase'; readonly id: WorkflowRunId; readonly title: string }
	| { readonly type: 'log'; readonly id: WorkflowRunId; readonly message: string }
	| { readonly type: 'agent-start'; readonly id: WorkflowRunId; readonly info: IWorkflowAgentInfo }
	| { readonly type: 'agent-end'; readonly id: WorkflowRunId; readonly info: IWorkflowAgentEndInfo }
	| { readonly type: 'stage-progress'; readonly id: WorkflowRunId; readonly stageUid: string; readonly progress: number; readonly message?: string }
	| { readonly type: 'end'; readonly id: WorkflowRunId; readonly stopReason: WorkflowStopReason; readonly error?: string; readonly agentsStarted: number };

// ─── meta 校验（host start() 同步调用 → 工具 isError，模型可纠正）──────────

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 校验 meta 块。违规抛 WorkflowError('META_INVALID')（fatal，同步抛出工具层）。 */
export function validateWorkflowMeta(meta: unknown): IWorkflowMeta {
	if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
		throw new WorkflowError('meta must be a JSON object', 'META_INVALID');
	}
	const m = meta as Record<string, unknown>;
	if (typeof m['name'] !== 'string' || m['name'].length === 0 || m['name'].length > 64) {
		throw new WorkflowError('meta.name must be a non-empty string (≤64 chars)', 'META_INVALID');
	}
	if (!KEBAB_RE.test(m['name'])) {
		throw new WorkflowError(`meta.name must be kebab-case (got "${m['name']}")`, 'META_INVALID');
	}
	if (typeof m['description'] !== 'string' || m['description'].length === 0) {
		throw new WorkflowError('meta.description must be a non-empty string', 'META_INVALID');
	}
	if (m['whenToUse'] !== undefined && typeof m['whenToUse'] !== 'string') {
		throw new WorkflowError('meta.whenToUse must be a string', 'META_INVALID');
	}
	let phases: readonly IWorkflowPhase[] | undefined;
	if (m['phases'] !== undefined) {
		if (!Array.isArray(m['phases'])) { throw new WorkflowError('meta.phases must be an array', 'META_INVALID'); }
		phases = (m['phases'] as unknown[]).map(p => {
			if (typeof p !== 'object' || p === null || Array.isArray(p)) {
				throw new WorkflowError('meta.phases[] items must be objects', 'META_INVALID');
			}
			const ph = p as Record<string, unknown>;
			if (typeof ph['title'] !== 'string' || ph['title'].length === 0) {
				throw new WorkflowError('meta.phases[].title must be a non-empty string', 'META_INVALID');
			}
			if (ph['detail'] !== undefined && typeof ph['detail'] !== 'string') {
				throw new WorkflowError('meta.phases[].detail must be a string', 'META_INVALID');
			}
			return { title: ph['title'], ...(ph['detail'] !== undefined ? { detail: ph['detail'] as string } : {}) };
		});
	}
	return {
		name: m['name'],
		description: m['description'],
		...(m['whenToUse'] !== undefined ? { whenToUse: m['whenToUse'] as string } : {}),
		...(phases !== undefined ? { phases } : {}),
	};
}
