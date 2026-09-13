/**
 * 节点上下文装配 —— **拒绝式（default-deny）**依赖注入。
 *
 * ## 问题（本项目现状）
 *
 * 画布 `runAgentNodeExecutor` 构造 prompt 时取 `resolveUpstreamSnapshotText(store, upstreams)`
 * ——**第一个**上游快照的全文。多个上游时其余全部丢失；而 headless 路径则相反，
 * 默认把**共享会话全量历史**喂给每个 agent（见 `docs/workflow-agent-context-analysis.md`）。
 * 两种极端都会出问题：前者信息不足，后者上下文爆炸（多 agent 时 token 成本按
 * 节点数×历史长度增长）。
 *
 * ## 设计（来源：open-multi-agent `orchestrator/task-execution.ts:1789 buildTaskPrompt`）
 *
 * 默认**只注入直接上游的已完成结果**，其余一律不注入：
 *   - 非 `completed` 的依赖**直接跳过**（不给下游看半成品/失败内容）；
 *   - 需要更广视野时按任务 opt-in：`memoryScope='all'` 才注入共享黑板摘要；
 *   - 依赖 payload 形态可选 `output`（原文）/ `structured`（结构化值）/ `both`；
 *   - 单条 payload 有**硬上限**（默认 64KB），超限**抛错而非静默截断**——静默截断
 *     会让模型基于半截 JSON 推理，比失败更难排查。
 *
 * 这套语义直接对应「画布节点间连线」：连了哪几条边就注入哪几个上游的产物，
 * 与用户在图上的心智模型一致。
 */

export interface DependencyResult {
	/** 上游任务/节点 id。 */
	taskId: string;
	title: string;
	assignee?: string;
	/** 原文输出。 */
	output?: string;
	/** 结构化输出（若上游产出 schema 化结果）。 */
	structured?: unknown;
	status: 'completed' | 'failed' | 'skipped' | 'pending' | 'in_progress';
}

export type DependencyPayloadMode = 'output' | 'structured' | 'both';
export type MemoryScope = 'dependencies' | 'all';

export interface ContextAssemblyOptions {
	/** 默认 'dependencies'（拒绝式）；'all' 才注入 sharedSummary。 */
	memoryScope?: MemoryScope;
	/** 依赖 payload 形态，默认 'output'。 */
	dependencyPayload?: DependencyPayloadMode;
	/** 单条 payload 字节上限（默认 64KB，对齐 open-multi-agent）。 */
	maxPayloadBytes?: number;
	/** 共享黑板摘要（仅 memoryScope='all' 时注入）。 */
	sharedSummary?: string;
	/** agent 间消息（消息总线语义，恒注入）。 */
	messages?: ReadonlyArray<{ from: string; content: string }>;
	/** 团队上下文块（可选，注入在最前）。 */
	revealContext?: string;
}

export interface ContextAssemblyResult {
	text: string;
	/** 实际注入的依赖 id（便于观测/断言）。 */
	included: string[];
	/** 被跳过（非 completed / 缺结构化值）的依赖 id。 */
	skipped: string[];
}

/** payload 超限错误（不静默截断）。 */
export class DependencyPayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DependencyPayloadError';
	}
}

export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

/** 稳定序列化：对象 key 排序，保证同一结构产出同一字符串（缓存/比对友好）。 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') { return JSON.stringify(value) ?? String(value); }
	if (Array.isArray(value)) { return `[${value.map(stableStringify).join(',')}]`; }
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function byteLength(text: string): number {
	// Node 与浏览器都有 TextEncoder；退化时按 UTF-16 估算（保守偏大）
	const enc = (globalThis as { TextEncoder?: new () => { encode(s: string): Uint8Array } }).TextEncoder;
	if (enc) { return new enc().encode(text).length; }
	return text.length * 2;
}

/**
 * 装配一个节点的上下文文本。
 *
 * @param self 当前任务信息（标题/描述/prompt 主体）
 * @param deps 直接上游结果（调用方按图的入边收集）
 */
export function assembleNodeContext(
	self: { id: string; title: string; description: string },
	deps: readonly DependencyResult[],
	opts: ContextAssemblyOptions = {},
): ContextAssemblyResult {
	const memoryScope = opts.memoryScope ?? 'dependencies';
	const payloadMode = opts.dependencyPayload ?? 'output';
	const maxBytes = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
	const lines: string[] = [];
	const included: string[] = [];
	const skipped: string[] = [];

	if (opts.revealContext) { lines.push(opts.revealContext, ''); }
	lines.push(`# Task: ${self.title}`, '', self.description);

	if (memoryScope === 'all' && opts.sharedSummary) {
		lines.push('', '## Shared memory summary', '', opts.sharedSummary);
	}

	// ── 拒绝式：只注入**直接依赖**且状态为 completed 的结果 ────────────────────
	const blocks: string[] = [];
	for (const dep of deps) {
		if (dep.status !== 'completed') { skipped.push(dep.taskId); continue; }
		const heading = `### ${dep.title} (by ${dep.assignee ?? 'unknown'})`;
		let payload: string;
		if (payloadMode === 'output') {
			if (!dep.output) { skipped.push(dep.taskId); continue; }
			payload = `${heading}\n${dep.output}`;
		} else if (payloadMode === 'structured') {
			if (dep.structured === undefined) {
				throw new DependencyPayloadError(`DEPENDENCY_STRUCTURED_RESULT_MISSING: ${dep.taskId}`);
			}
			payload = `${heading}\n${stableStringify(dep.structured)}`;
		} else {
			if (dep.structured === undefined) {
				throw new DependencyPayloadError(`DEPENDENCY_STRUCTURED_RESULT_MISSING: ${dep.taskId}`);
			}
			payload = `${heading}\n${dep.output ?? ''}\n\nValidated structured result:\n${stableStringify(dep.structured)}`;
		}
		const size = byteLength(payload);
		if (size > maxBytes) {
			throw new DependencyPayloadError(
				`DEPENDENCY_PAYLOAD_TOO_LARGE: ${dep.taskId} 产出 ${size} 字节，超过上限 ${maxBytes}（请让上游输出摘要或结构化结果）`,
			);
		}
		blocks.push(payload);
		included.push(dep.taskId);
	}
	if (blocks.length > 0) {
		lines.push('', '## Context from prerequisite tasks', '', blocks.join('\n\n'));
	}

	// ── 消息总线：恒注入（对齐 open-multi-agent）───────────────────────────────
	if (opts.messages && opts.messages.length > 0) {
		lines.push('', '## Messages from team members');
		for (const m of opts.messages) { lines.push(`- **${m.from}**: ${m.content}`); }
	}

	return { text: lines.join('\n'), included, skipped };
}
