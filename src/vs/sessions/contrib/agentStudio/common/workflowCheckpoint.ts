/*---------------------------------------------------------------------------------------------
 *  workflowCheckpoint — 工作流断点（checkpoint）的**存取契约**与**崩溃一致性判定**。
 *
 *  背景（2026-09-11）：`WorkflowExecutionService._saveCheckpoint()` 一直在写
 *  `{workspace}/.sarosworkspace/checkpoints/{executionId}.json`，但**没有任何 load 通路**
 *  ——「只写不读」= 断点续跑实际不可用，且**存/取两侧没有共享契约**（写入格式内联在服务里，
 *  改字段时不会有任何编译期/测试期提示）。
 *
 *  本模块把三件事抽成纯函数（可单测，DOM/IO 无关）：
 *    ① `buildWorkflowCheckpoint` —— 写出格式（唯一真源，服务侧改为调用它）
 *    ② `parseWorkflowCheckpoint` —— 读入校验（磁盘内容不可信：手改 / 旧版本 / 半截写）
 *    ③ `planWorkflowResume` —— ★崩溃一致性判定：哪些节点可复用、哪些必须重跑
 *
 *  ★ 崩溃一致性规则（为什么不能简单「跳过所有已完成节点」）：
 *    - `completed` → 可复用（产出已落盘，且其 output 会回填 nodeStates 供下游 {{ref}} 取用）
 *    - `running`   → **必须重跑**：崩溃时正在执行，副作用可能只做了一半
 *                    （文件写了一半 / 图生成到一半），当成成功会产出**错误的下游输入**
 *    - `failed` / `cancelled` / `skipped` / `pending` → 重跑（用户 resume 的意图就是重试；
 *      skipped 是上游失败的级联产物，上游重跑成功后它应重新参与）
 *    - 未知状态 / checkpoint 里没有的新节点（图改过）→ 重跑（保守）
 *--------------------------------------------------------------------------------------------*/

// ─── 契约类型 ──────────────────────────────────────────────────────────────

/** checkpoint 里的单节点状态（全部字段都做过可序列化归一）。 */
export interface IWorkflowCheckpointNodeState {
	readonly status: string;
	readonly output?: string | null;
	readonly error?: string | null;
	readonly startTime?: string | null;
	readonly endTime?: string | null;
}

/** checkpoint 文件结构（= 磁盘上的 JSON 形状）。 */
export interface IWorkflowCheckpoint {
	readonly executionId: string;
	readonly workflowId: string;
	readonly status?: string;
	readonly timestamp?: string;
	readonly nodeStates: Record<string, IWorkflowCheckpointNodeState>;
	/** 运行上下文：值已被逐键 JSON.stringify（写入侧做，避免循环引用炸 stringify）。 */
	readonly context?: Record<string, string>;
	readonly sharedMemory?: ReadonlyArray<readonly [string, string]>;
}

/** 写入侧输入（服务内部结构的最小投影）。 */
export interface ICheckpointBuildInput {
	readonly executionId: string;
	readonly workflowId: string;
	readonly status?: string;
	readonly timestamp?: string;
	readonly nodeStates: Iterable<readonly [string, {
		readonly status: string;
		readonly output?: string;
		readonly error?: string;
		readonly startTime?: string;
		readonly endTime?: string;
	}]>;
	readonly context?: Record<string, unknown>;
	readonly sharedMemory?: Iterable<readonly [string, string]>;
}

// ─── ① 写出 ────────────────────────────────────────────────────────────────

/** 单个 context 值的安全序列化（循环引用 / BigInt / 函数 → 退化为 String）。 */
function sanitizeContextValue(value: unknown): string {
	try {
		const json = JSON.stringify(value);
		return json === undefined ? String(value) : json;
	} catch {
		return String(value);
	}
}

/**
 * 构造 checkpoint 对象（**写出格式的唯一真源**）。
 * 与 `parseWorkflowCheckpoint` 成对：两者的往返由测试保证（round-trip）。
 */
export function buildWorkflowCheckpoint(input: ICheckpointBuildInput): IWorkflowCheckpoint {
	const nodeStates: Record<string, IWorkflowCheckpointNodeState> = {};
	for (const [nodeId, ns] of input.nodeStates) {
		nodeStates[nodeId] = {
			status: ns.status,
			output: ns.output ?? null,
			error: ns.error ?? null,
			startTime: ns.startTime ?? null,
			endTime: ns.endTime ?? null,
		};
	}
	const context: Record<string, string> = {};
	for (const [key, value] of Object.entries(input.context ?? {})) {
		context[key] = sanitizeContextValue(value);
	}
	return {
		executionId: input.executionId,
		workflowId: input.workflowId,
		status: input.status,
		timestamp: input.timestamp ?? new Date().toISOString(),
		nodeStates,
		context,
		sharedMemory: [...(input.sharedMemory ?? [])].map(([k, v]) => [k, v] as const),
	};
}

// ─── ② 读入校验 ────────────────────────────────────────────────────────────

export type ParseCheckpointResult =
	| { readonly ok: true; readonly checkpoint: IWorkflowCheckpoint }
	| { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/**
 * 解析并校验 checkpoint（磁盘内容不可信：手改、旧版本、写入被中断）。
 *
 * 校验原则：**结构性字段缺失即失败**（executionId / workflowId / nodeStates），
 * 其余字段**尽力归一**（缺失 → 缺省；类型不符 → 丢弃该字段），避免一个坏字段
 * 让整次恢复不可用。
 */
export function parseWorkflowCheckpoint(raw: string): ParseCheckpointResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `checkpoint JSON 解析失败: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!isRecord(parsed)) {
		return { ok: false, error: 'checkpoint 不是对象' };
	}
	const executionId = asOptionalString(parsed.executionId);
	const workflowId = asOptionalString(parsed.workflowId);
	if (!executionId) { return { ok: false, error: 'checkpoint 缺少 executionId' }; }
	if (!workflowId) { return { ok: false, error: 'checkpoint 缺少 workflowId' }; }
	if (!isRecord(parsed.nodeStates)) { return { ok: false, error: 'checkpoint 缺少 nodeStates' }; }

	const nodeStates: Record<string, IWorkflowCheckpointNodeState> = {};
	for (const [nodeId, rawState] of Object.entries(parsed.nodeStates)) {
		if (!isRecord(rawState)) { continue; }
		const status = asOptionalString(rawState.status);
		if (!status) { continue; } // 无状态的条目无意义 → 丢弃（该节点会被判为「需重跑」）
		nodeStates[nodeId] = {
			status,
			output: asOptionalString(rawState.output) ?? null,
			error: asOptionalString(rawState.error) ?? null,
			startTime: asOptionalString(rawState.startTime) ?? null,
			endTime: asOptionalString(rawState.endTime) ?? null,
		};
	}

	const context: Record<string, string> = {};
	if (isRecord(parsed.context)) {
		for (const [key, value] of Object.entries(parsed.context)) {
			const str = asOptionalString(value);
			if (str !== undefined) { context[key] = str; }
		}
	}

	const sharedMemory: Array<readonly [string, string]> = [];
	if (Array.isArray(parsed.sharedMemory)) {
		for (const entry of parsed.sharedMemory) {
			if (!Array.isArray(entry) || entry.length < 2) { continue; }
			const [k, v] = entry as unknown[];
			if (typeof k === 'string' && typeof v === 'string') { sharedMemory.push([k, v]); }
		}
	}

	return {
		ok: true,
		checkpoint: {
			executionId,
			workflowId,
			status: asOptionalString(parsed.status),
			timestamp: asOptionalString(parsed.timestamp),
			nodeStates,
			context,
			sharedMemory,
		},
	};
}

// ─── ③ 崩溃一致性判定 ──────────────────────────────────────────────────────

/** 为什么必须重跑（用于日志/UI 解释「为什么没跳过这个节点」）。 */
export type ResumeRerunReason = 'running' | 'failed' | 'cancelled' | 'skipped' | 'pending' | 'unknown';

export interface IResumePlan {
	/** 可复用（跳过执行）的节点：产出回填后供下游 `{{nodeId.output}}` 取用。 */
	readonly reusable: ReadonlyArray<{ readonly nodeId: string; readonly output?: string }>;
	/** 必须执行的节点 id（按传入的图顺序，含新增节点）。 */
	readonly toRun: readonly string[];
	/** `toRun` 每个节点的重跑原因。 */
	readonly reasons: Readonly<Record<string, ResumeRerunReason>>;
	/** `toRun` 的子集：checkpoint 里不存在（图在崩溃后被改过）。 */
	readonly added: readonly string[];
	/** 面向日志/UI 的一行摘要。 */
	readonly summary: string;
}

/**
 * 依据 checkpoint 判定「哪些节点可复用、哪些必须重跑」。
 *
 * @param checkpoint 已校验的 checkpoint
 * @param nodeIds    当前工作流的节点 id（**按执行顺序**；与 checkpoint 可能不同 —— 图被改过）
 */
export function planWorkflowResume(
	checkpoint: IWorkflowCheckpoint,
	nodeIds: readonly string[],
): IResumePlan {
	const reusable: Array<{ nodeId: string; output?: string }> = [];
	const toRun: string[] = [];
	const reasons: Record<string, ResumeRerunReason> = {};
	const added: string[] = [];

	for (const nodeId of nodeIds) {
		const state = checkpoint.nodeStates[nodeId];
		if (!state) {
			// 图在崩溃后被改过（新增节点）→ 必须执行
			toRun.push(nodeId);
			reasons[nodeId] = 'pending';
			added.push(nodeId);
			continue;
		}
		if (state.status === 'completed') {
			reusable.push(state.output != null ? { nodeId, output: state.output } : { nodeId });
			continue;
		}
		toRun.push(nodeId);
		reasons[nodeId] = toRerunReason(state.status);
	}

	const summary = `断点恢复：可复用 ${reusable.length} 个已完成节点，需重跑 ${toRun.length} 个`
		+ (added.length > 0 ? `（其中 ${added.length} 个为 checkpoint 之后新增的节点）` : '');

	return { reusable, toRun, reasons, added, summary };
}

function toRerunReason(status: string): ResumeRerunReason {
	switch (status) {
		case 'running': return 'running';
		case 'failed': return 'failed';
		case 'cancelled': return 'cancelled';
		case 'skipped': return 'skipped';
		case 'pending': return 'pending';
		default: return 'unknown';
	}
}
