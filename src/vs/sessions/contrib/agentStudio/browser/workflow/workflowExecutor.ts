/*---------------------------------------------------------------------------------------------
 *  Dynamic Workflow — 可复用执行器（工具层 + host 直连共用）
 *
 *  把 workflowTool.ts handler 的执行核心抽成纯函数 executeWorkflowScript()，
 *  供两条路径复用：
 *   1. `workflow` 工具 handler（LLM 触发，模型提交 {meta,script,args}）
 *   2. `workflow.executeScript` RPC（画布「直接执行」，绕过 LLM 决策，确定性触发）
 *
 *  执行语义与工具层完全一致：createWorkflowChildPort → WorkflowEngine.start →
 *  前台 await run.result → 投影归档 + 画布锚点归档 + 子代理卡片旁路总线。
 *
 *  两条路径的**唯一**差异经显式选项声明（不再靠字段缺省值反推）：
 *   - archiveProjection：工具路径 true（投影是模型脚本的唯一可重放载体）；
 *     画布直连 false（用户已持源画布）。
 *   - parentToolCallId：画布直连传 host 合成的工具卡 id（子代理卡片直接挂载）。
 *  活性：引擎墙钟上限（maxDurationMs → maxRunDurationMs）保证 run 必定 settle，
 *  脚本死挂也不会让 `await run.result` 永久悬挂。
 *--------------------------------------------------------------------------------------------*/

import type { UnifiedSubAgentDispatch } from '../../common/unifiedSubAgentDispatch.js';
import type { IWorkflowMeta, WorkflowEngineEvent } from '../../common/workflow/types.js';
import { buildWorkflowProjection, renderProjectionSummary } from '../../common/workflow/projection.js';
import { WorkflowEngine } from './workflowEngine.js';
import { archiveWorkflowProjection, archiveWorkflowResult, createBridgeSnapshotPort, createBridgeStagePort } from './workflowSnapshotBridge.js';
import { createWorkflowChildPort, type IWorkflowAgentOSLike } from '../providers/tool/workflowChildPort.js';

export interface IExecuteWorkflowScriptDeps {
	readonly dispatch: UnifiedSubAgentDispatch;
	/** 子代理执行（executeAgentTurn）+ 卡片旁路总线（fireSubAgentTrace）。 */
	readonly agentOS: IWorkflowAgentOSLike & { fireSubAgentTrace(trace: unknown): void };
	/** 父 agent id（child 的 parentAgentId，画布直连用 canvas-agent-node）。 */
	readonly parentAgentId: string;
	readonly logService: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface IExecuteWorkflowScriptInput {
	readonly script: string;
	readonly meta: IWorkflowMeta;
	readonly args?: unknown;
	/** 画布锚点 uid：成功时 return value 归档到该节点 OUTPUT 卡（M2 写方向）。 */
	readonly canvasAnchorUid?: string;
	readonly signal?: AbortSignal;
	/**
	 * 父工具卡 id（子代理卡片挂载目标）。画布「直接执行」由 host 生成合成 workflow
	 * 工具卡（toolCallId），传入此字段让子代理卡片的 parentToolCallId 直接等于它，
	 * 命中 nativeChatEditorPane._remapAndAttachSubAgents 的直连分支（tc.id === pid）。
	 * 缺省则自生成（LLM 工具触发路径，靠 _lastDelegateToolCallId 兜底重映射）。
	 */
	readonly parentToolCallId?: string;
	/**
	 * 是否把运行投影落盘为可重放的投影工作流。
	 * 缺省按调用方推断（有外部父工具卡 = 画布直连 → 不落盘）；显式传值优先。
	 *
	 * 语义：LLM 触发（workflow 工具）→ true（模型产出的脚本只存在于本次对话，
	 * 投影是唯一可重放载体）；画布「直接执行」→ false（用户已持源画布，
	 * 投影冗余且会污染 workflow 列表）。
	 */
	readonly archiveProjection?: boolean;
	/**
	 * 本次 run 的墙钟上限（透传引擎 P4 活性防护）。缺省用引擎默认（30 分钟）。
	 * <=0 = 禁用。
	 */
	readonly maxDurationMs?: number;
	/**
	 * 实时进度回调（stage() 执行 ComfyUI 生成时透传，解决「卡住看不到进度」）。
	 * 画布直连时 host 把进度转发到聊天框工具卡。
	 */
	readonly onProgress?: (progress: number, message?: string, stageUid?: string) => void;
}

export interface IExecuteWorkflowScriptResult {
	readonly ok: boolean;
	readonly error?: string;
	readonly value?: unknown;
	readonly agentsStarted?: number;
	readonly projectionText?: string;
}

function stopReasonError(r: { stopReason: string; error?: string }): string | undefined {
	switch (r.stopReason) {
		case 'completed': return undefined;
		case 'cancelled': return `workflow run was cancelled${r.error !== undefined ? ` (${r.error})` : ''}`;
		case 'error': return `workflow run failed: ${r.error ?? 'unknown error'}`;
		default: return `workflow run ended abnormally`;
	}
}

/**
 * 执行一个动态工作流脚本（前台阻塞直到 run 终态）。
 * 非 completed → 返回 { ok:false, error }（调用方决定如何呈现）。
 */
export async function executeWorkflowScript(
	deps: IExecuteWorkflowScriptDeps,
	input: IExecuteWorkflowScriptInput,
): Promise<IExecuteWorkflowScriptResult> {
	const { dispatch, agentOS, parentAgentId, logService } = deps;
	const { script, meta, args, canvasAnchorUid, signal, parentToolCallId: externalParentTcId, maxDurationMs } = input;

	const childPort = createWorkflowChildPort({
		dispatch,
		agentOS,
		parentAgentId,
		groupId: `workflow-${meta.name}-${Date.now().toString(36)}`,
	});
	const engine = new WorkflowEngine(
		{
			childPort,
			snapshotPort: createBridgeSnapshotPort(),
			stagePort: createBridgeStagePort(),
			...(maxDurationMs !== undefined ? { maxRunDurationMs: maxDurationMs } : {}),
		},
		(lvl: 'info' | 'warn', msg: string) => {
			if (lvl === 'info') { logService.info(msg); } else { logService.warn(msg); }
		},
	);

	// 运行投影（波次 DAG，动态扇出可视）
	const events: WorkflowEngineEvent[] = [];
	// 子代理卡片旁路总线（skipSubAgentCard=true → 内嵌在 run 表面，不产生独立卡片）
	// 画布直连时用外部合成工具卡的 toolCallId（子代理直接挂载到该卡）；LLM 触发时自生成。
	const parentToolCallId = externalParentTcId ?? `workflow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	// 投影归档行为由调用方显式声明（缺省按「有外部父工具卡 = 画布直连」推断，保持旧行为）。
	const shouldArchiveProjection = input.archiveProjection ?? (externalParentTcId === undefined);
	const cards = new Map<number, { id: string; task: string; status: string; progress?: string; output?: string; error?: string; startedAt?: number; completedAt?: number }>();
	let cardTimer: ReturnType<typeof setInterval> | undefined;
	const flushCards = (force = false) => {
		try {
			if (cards.size === 0 && !force) { return; }
			agentOS.fireSubAgentTrace({
				groupId: parentToolCallId,
				subagentData: [...cards.values()].map(c => ({
					id: c.id, type: 'general', task: c.task, status: c.status,
					progress: c.progress, output: c.output, error: c.error,
					groupId: parentToolCallId, toolTraces: [],
					parentToolCallId, skipSubAgentCard: true,
					startedAt: c.startedAt, completedAt: c.completedAt,
				})),
			});
		} catch { /* sink errors are swallowed by design */ }
	};

	let run: ReturnType<WorkflowEngine['start']>;
	try {
		run = engine.start({
			script, meta,
			...(args !== undefined ? { args } : {}),
			signal,
			onEvent: ev => {
				events.push(ev);
				if (ev.type === 'agent-start') {
					cards.set(ev.info.seq, {
						id: `${parentToolCallId}-${ev.info.seq}`,
						task: ev.info.label,
						status: 'running',
						progress: ev.info.phase ? `phase: ${ev.info.phase}` : undefined,
						startedAt: Date.now(),
					});
				} else if (ev.type === 'agent-end') {
					const c = cards.get(ev.info.seq);
					if (c) {
						c.status = ev.info.outcome === 'completed' ? 'done' : ev.info.outcome === 'failed' ? 'error' : 'cancelled';
						c.completedAt = Date.now();
						if (ev.info.outcome !== 'completed') { c.error = `agent ${ev.info.outcome} → null（脚本可 filter(Boolean)）`; }
					}
				} else if (ev.type === 'stage-progress') {
					// ComfyUI 生成进度 → 调用方（画布直连 → 聊天工具卡实时进度）。
					input.onProgress?.(ev.progress, ev.message, ev.stageUid);
				}
			},
		});
		// 100ms 节流推送卡片状态
		cardTimer = setInterval(() => flushCards(), 100);
	} catch (e) {
		// worker 创建失败（CSP 拦截等）→ fail-loud，不降级主线程
		return { ok: false, error: `workflow unavailable: ${(e as Error).message}` };
	}

	logService.info(`[WorkflowExecutor] run ${run.id} "${meta.name}" started (parent=${parentAgentId})`);
	try {
		const result = await run.result;
		const err = stopReasonError(result);
		if (err !== undefined) {
			return { ok: false, error: err };
		}
		// 投影归档（fire-and-forget；画布直连不归档，避免污染 workflow 列表）
		const projection = buildWorkflowProjection(events);
		if (shouldArchiveProjection) {
			archiveWorkflowProjection({ name: meta.name, runId: run.id }, projection);
		}
		const projectionText = renderProjectionSummary(projection);
		// M2 画布锚点归档（fire-and-forget）
		const anchorUid = (canvasAnchorUid ?? '').trim();
		if (anchorUid) {
			archiveWorkflowResult(anchorUid, result.value, { name: meta.name, runId: run.id });
		}
		return { ok: true, value: result.value, agentsStarted: result.agentsStarted, projectionText };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	} finally {
		if (cardTimer !== undefined) { clearInterval(cardTimer); }
		flushCards(true); // 终态快照（含 cancelled/error 卡片）
		void run.dispose();
	}
}
