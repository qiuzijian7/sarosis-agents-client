/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Readonly 策略 —— 只读收集模式（对齐 void gather / continue ask）。
 *
 * 范式特征：
 *  - preLoop: LLM 决策 + 并行 code-explorer 探索（与 HermesReAct 相同）
 *  - prepareIteration: hardPermission 拦截所有写类工具（file_write / delete / execute 等）
 *  - 无限迭代（无 budget 限制）：只读代理可通过工具循环反复探索直到无新发现
 *  - 自然终止：LLM 不再发起工具调用时结束（由主循环判定 effectiveToolCalls.length === 0）
 */

import type {
	IAgentLoopStrategy,
	PreLoopContext,
	IterationPlan,
	PreLoopResultMeta,
} from '../../common/agentLoopStrategy.js';
import type { IterationBudget } from '../../common/iterationBudget.js';
import type { IChatStreamDelta } from '../../common/providers.js';
import { buildPreLoopDeps, preLoopOrchestrate } from '../preLoopDeps.js';

/** 所有写类 / 修改类工具名（黑名单，只读代理一律拦截） */
const WRITE_TOOLS = new Set([
	'file_write', 'write_to_file', 'replace_in_file', 'edit_file',
	'delete_file', 'delete_files',
	'execute_command', 'terminal', 'bash', 'shell', 'run',
	'git_commit', 'git_push',
]);

export class ReadonlyStrategy implements IAgentLoopStrategy {
	readonly paradigm = 'readonly' as const;

	/** ReAct 前探索：与 HermesReAct 相同 —— LLM 自主判断 + 并行 explore + 任务规划 */
	async *preLoop(ctx: PreLoopContext): AsyncGenerator<IChatStreamDelta, PreLoopResultMeta> {
		const allUserMsgs = ((ctx.request as any).messages || []).filter((m: any) => m.role === 'user');
		const lastUserMsg = allUserMsgs[allUserMsgs.length - 1];
		const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
		if (!userText || !ctx.modelProvider || !ctx.modelId) {
			return { preExploreDone: false, planTasks: [] };
		}

		try {
			const deps = buildPreLoopDeps(
				ctx.host, ctx.modelProvider, ctx.modelId,
				ctx.request.agentId ?? 'default',
				ctx.signal,
			);
			const result = await preLoopOrchestrate(userText, deps);

			ctx.host._logService?.info?.(
				`[Readonly] preLoop: needsExploration=${result.assessment.needsExploration}, ` +
				`explorationAreas=${result.assessment.explorationAreas.length}, planTasks=${result.planTasks.length}`
			);

			return {
				preExploreDone: result.assessment.needsExploration,
				preExploreResult: result.findings,
				planTasks: result.planTasks,
				findings: result.findings,
			};
		} catch (err) {
			ctx.host._logService?.warn?.(
				`[Readonly] preLoop failed: ${err instanceof Error ? err.message : err} — fallback`
			);
			return { preExploreDone: false, planTasks: [] };
		}
	}

	/** 每轮 LLM 调用前：硬权限拦截所有写类工具，只保留只读工具 */
	prepareIteration(ctx: PreLoopContext, _budget: IterationBudget): IterationPlan {
		// 过滤出只读工具（不在 WRITE_TOOLS 黑名单中的）
		const readOnlyTools = (ctx.toolDefs || []).filter(
			(t: any) => !WRITE_TOOLS.has(t.name),
		);
		return {
			toolDefs: readOnlyTools,
			hardPermission: (tool: string) => WRITE_TOOLS.has(tool),
		};
	}

	/** 只读模式无限迭代：不基于预算终止（由 LLM 自然结束） */
	shouldTerminate(_ctx: PreLoopContext, _budget: IterationBudget): boolean {
		return false;
	}
}
