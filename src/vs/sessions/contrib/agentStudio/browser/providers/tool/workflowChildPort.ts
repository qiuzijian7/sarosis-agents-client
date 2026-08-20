/*---------------------------------------------------------------------------------------------
 *  Dynamic Workflow — child port bridge (engine ⇄ UnifiedSubAgentDispatch)
 *
 *  引擎的 IWorkflowChildPort 实现：把 agent() 的 child-start RPC 桥到
 *  UnifiedSubAgentDispatch（复用 fiber/预算/权限档/stallWatchdog）。
 *
 *  设计决策（设计文档 §3.2.5）：
 *   - 复用 createSubAgent + executeSubAgent；不建私有子代理池
 *   - schema 输出：dispatch 的 options.outputSchema 走 completionGate（gate 判定），
 *     不是脚本要的「按 schema 的 JSON 对象」→ 桥内自实现：task 尾注入 JSON 输出
 *     指令 + 完成后从 output 提取（fenced block / 首个平衡对象）；解析失败 →
 *     success=false → 脚本见 null（dsh 契约：子代理失败不杀脚本）
 *   - 绕过 completionGate（脚本是更可靠的消费者：schema + 自定重试）
 *   - dispose = interruptSubAgent（粘性信号，pending/running 均有效，递归取消子代）
 *--------------------------------------------------------------------------------------------*/

import type { UnifiedSubAgentDispatch, SubAgentResult } from '../../../common/unifiedSubAgentDispatch.js';
import type { IAgentTurnRequest, IChatStreamDelta } from '../../../common/providers.js';
import type { IterationBudget } from '../../../common/iterationBudget.js';
import type { IWorkflowChildStartRequest } from '../../../common/workflow/protocol.js';
import type { IWorkflowChildHandle, IWorkflowChildPort } from '../../workflow/workflowEngine.js';

/** 最小 agentOS 面（executeAgentTurn；planExploreTool 同款注入）。 */
export interface IWorkflowAgentOSLike {
	executeAgentTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta>;
}

export interface IWorkflowChildPortOptions {
	readonly dispatch: UnifiedSubAgentDispatch;
	readonly agentOS: IWorkflowAgentOSLike;
	/** 父 agent id（child 的 parentAgentId）。 */
	readonly parentAgentId: string;
	/** 并行卡片组 id（batchGroup；缺省按 run 生成）。 */
	readonly groupId?: string;
	/** 子代理超时 ms（缺省 600_000 = dispatch 默认；0=禁用）。 */
	readonly timeoutMs?: number;
}

const JSON_OUTPUT_INSTRUCTION = (schemaJson: string): string => [
	'',
	'',
	'# REQUIRED OUTPUT FORMAT',
	'Your FINAL message must be a single fenced JSON code block (```json ... ```) and NOTHING else after it.',
	'The JSON object MUST conform to this JSON Schema exactly:',
	'```json',
	schemaJson,
	'```',
	'Do not wrap it in any other text, do not add commentary after the block.',
].join('\n');

/** 从子代理输出提取 JSON 对象（fenced ```json 块优先，回退首个平衡 {...}）。 */
export function extractStructuredOutput(output: string): unknown | undefined {
	if (!output) { return undefined; }
	const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/m.exec(output);
	const candidates: string[] = [];
	if (fenced?.[1]) { candidates.push(fenced[1]); }
	const first = _firstBalancedObject(output);
	if (first !== undefined) { candidates.push(first); }
	for (const c of candidates) {
		try {
			const parsed: unknown = JSON.parse(c);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) { return parsed; }
		} catch { /* try next */ }
	}
	return undefined;
}

function _firstBalancedObject(s: string): string | undefined {
	const start = s.indexOf('{');
	if (start === -1) { return undefined; }
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (esc) { esc = false; continue; }
		if (ch === '\\') { esc = true; continue; }
		if (ch === '"') { inStr = !inStr; continue; }
		if (inStr) { continue; }
		if (ch === '{') { depth++; }
		else if (ch === '}') {
			depth--;
			if (depth === 0) { return s.slice(start, i + 1); }
		}
	}
	return undefined;
}

/** 把 SubAgentResult 映射为引擎 child 终态。 */
export function toChildResult(r: SubAgentResult, schemaRequested: boolean): import('../../../common/workflow/protocol.js').IWorkflowChildResult {
	const completed = r.success && (r.exitReason === undefined || r.exitReason === 'completed');
	if (!completed) {
		return { success: false, stopReason: r.exitReason ?? 'failed', ...(r.output !== undefined ? { output: r.output } : {}) };
	}
	if (schemaRequested) {
		const structured = extractStructuredOutput(r.output ?? '');
		if (structured === undefined) {
			// 子代理完成了但没产出合法 JSON → 子代理级失败（脚本见 null），不杀 run
			return { success: false, stopReason: 'failed', ...(r.output !== undefined ? { output: r.output } : {}) };
		}
		return { success: true, stopReason: 'completed', structured };
	}
	return { success: true, stopReason: 'completed', output: r.output ?? '' };
}

export function createWorkflowChildPort(opts: IWorkflowChildPortOptions): IWorkflowChildPort {
	const executeFn = (request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> =>
		opts.agentOS.executeAgentTurn(request);

	return {
		start(request: IWorkflowChildStartRequest, signal: AbortSignal): Promise<IWorkflowChildHandle> {
			const schemaJson = request.schema !== undefined ? JSON.stringify(request.schema) : undefined;
			const task = schemaJson !== undefined
				? `${request.prompt}${JSON_OUTPUT_INSTRUCTION(schemaJson)}`
				: request.prompt;
			// ★ 内置 Agent 身份（agentId）直传 dispatch（走该 agent 的 systemPrompt/
			// tools/toolsets）；model 覆写 M1 暂不接（需父 providerId 上下文，见设计文档）。
			const subAgentId = opts.dispatch.createSubAgent(opts.parentAgentId, task, {
				agentId: request.agentId,
				timeout: opts.timeoutMs ?? 600_000,
				background: true,
			});
			const resultP = (async () => {
				const r = await opts.dispatch.executeSubAgent(
					subAgentId, executeFn, undefined, opts.groupId, signal,
				);
				return toChildResult(r, request.schema !== undefined);
			})();
			// 防未处理拒绝（引擎随后消费；这里只兜底）
			resultP.catch(() => { /* consumed by engine */ });
			return Promise.resolve({
				id: subAgentId,
				result: resultP,
				dispose: async () => { opts.dispatch.interruptSubAgent(subAgentId); },
			});
		},
	};
}
