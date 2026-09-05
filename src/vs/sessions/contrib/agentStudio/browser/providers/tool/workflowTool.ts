/*---------------------------------------------------------------------------------------------
 *  Dynamic Workflow — the model-facing `workflow` tool (Consumer)
 *
 *  对齐 dsh `tool-workflow`：模型提交 { meta, script, args }，引擎执行脚本
 *  （agent/parallel/pipeline/phase/log/args hooks），前台 await run.result，
 *  非 completed → isError 工具结果（模型可读原因后改脚本重调）。
 *
 *  注册（builtinToolProvider._registerWorkflowTool）：
 *   - toolsetConfig：workflow toolset exactNames 加 'workflow'
 *   - toolExecutionGuard：ORCHESTRATION_TOOLS 加 'workflow'（工具层无墙钟超时，
 *     活性由子代理 stallWatchdog + 引擎墙钟上限 maxRunDurationMs + grace 兜底）
 *   - toolCallUtils：NEVER_PARALLEL_TOOLS 加 'workflow'（自管并发）
 *  设计文档：doc/Dynamic-Workflow-Integration-Design.md §3.2.6。
 *--------------------------------------------------------------------------------------------*/

import type { UnifiedSubAgentDispatch } from '../../../common/unifiedSubAgentDispatch.js';
import type { IAgentTurnRequest, IChatStreamDelta, IToolResultContent } from '../../../common/providers.js';
import { validateWorkflowMeta, type IWorkflowMeta } from '../../../common/workflow/types.js';
import { executeWorkflowScript } from '../../workflow/workflowExecutor.js';
import type { IWorkflowAgentOSLike } from './workflowChildPort.js';

export interface IWorkflowToolContext {
	register: (d: { definition: { name: string; description: string; inputSchema: Record<string, unknown>; category?: string; source: string }; handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[]> }) => void;
	id: string;
	agentOS: IWorkflowAgentOSLike & {
		executeAgentTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta>;
		/** 子代理卡片数据通道（delegate_task 同款；skipSubAgentCard 内嵌 workflow 卡）。 */
		fireSubAgentTrace(trace: unknown): void;
	};
	orchestrationService: { subAgentDispatch?: UnifiedSubAgentDispatch };
	logService: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

/**
 * 脚本编写契约（模型可见 spec）。对齐 dsh DESCRIPTION：
 * hook 语义 / schema 子集 / fatal 语义 / 前台执行声明。
 */
const DESCRIPTION = [
	'Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification — where you write the orchestration as a script instead of delegating turn by turn.',
	'',
	"The workflow's identity rides the `meta` parameter as JSON: required `name` (short kebab-case) and `description` strings, optional `whenToUse` and `phases` array ({title, detail?}). The `script` parameter is the plain JavaScript body ONLY (NOT TypeScript, NO `export const meta` statement), running with top-level await; end with `return <value>` — the value must be JSON-serializable and is this tool result. Avoid unbounded synchronous loops (while(true)) — they cannot be interrupted softly.",
	'',
	'Script-body hooks:',
	'- `agent(prompt, opts?): Promise<any>` — run one subagent to completion. Without `opts.schema` it resolves to the child final text; with `opts.schema` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf — no pattern/format/numeric bounds) it resolves to the extracted JSON object. Resolves `null` when the child fails (filter with `.filter(Boolean)`). Other opts: `label` (display), `phase` (progress group), `agentId` (builtin agent identity, e.g. "code-explorer" for read-only exploration). Anything else (effort/isolation/agentType/provider/model) is rejected loudly.',
	'- `pipeline(items, ...stages): Promise<any[]>` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives `(prev, item, index)`. An ordinary stage throw drops that ITEM to `null` and skips its remaining stages. Recommended pattern: `if (prev === null) return null` at stage top to keep array indices aligned.',
	'- `parallel(thunks): Promise<any[]>` — run zero-argument functions concurrently and await ALL of them (a barrier). A throwing thunk resolves to `null`.',
	'- `phase(title)` — start a progress phase; `log(message)` — narrate progress; `args` — the tool call args input, verbatim.',
	'',
	'Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) throw errors that ALWAYS kill the script — they never dissolve into a per-item `null`.',
	'',
	'Constraints: concurrency (5) and total-agent (1000) caps apply; no filesystem, network, timers, or Node APIs — the agents do the work, the script only coordinates them. The run executes in the foreground: this call returns when the whole script finishes.',
].join('\n');

const MAX_RESULT_CHARS = 50_000;

function renderResult(name: string, agentsStarted: number, value: unknown): string {
	const rendered = JSON.stringify(value, null, 2) ?? 'null';
	const clipped = rendered.length > MAX_RESULT_CHARS
		? `${rendered.slice(0, MAX_RESULT_CHARS)}\n… [truncated: ${rendered.length - MAX_RESULT_CHARS} more characters]`
		: rendered;
	return `workflow "${name}" completed (${agentsStarted} agent${agentsStarted === 1 ? '' : 's'}).\nReturn value:\n${clipped}`;
}

export function registerWorkflowTool(ctx: IWorkflowToolContext): void {
	ctx.register({
		definition: {
			name: 'workflow',
			description: DESCRIPTION,
			inputSchema: {
				type: 'object',
				properties: {
					script: { type: 'string', description: 'The plain-JS workflow script body (top-level await allowed; NO `export const meta` statement; end with `return <json-value>`).' },
					meta: {
						type: 'object',
						description: 'The workflow identity block (plain JSON — never code).',
						properties: {
							name: { type: 'string', description: 'Short kebab-case workflow name.' },
							description: { type: 'string', description: 'One-line description of what the workflow does.' },
							whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies.' },
							phases: {
								type: 'array',
								description: 'Optional phase declarations matched by phase() calls.',
								items: {
									type: 'object',
									properties: {
										title: { type: 'string', description: 'Exact title phase() calls match.' },
										detail: { type: 'string', description: 'One-line phase description.' },
									},
								},
							},
						},
						required: ['name', 'description'],
					},
					// additionalProperties: true 已删（2026-09-05，日志 1788596740459/1788674…）：
				// 它是 [CodeBuddy][sanitize] "workflow additionalProperties stripped at depth 2"
				// 每请求告警的唯一来源。JSON Schema 默认即允许额外属性，删掉语义不变；
				// args 的自由输入由 description 声明即可。
				args: { type: 'object', description: 'Optional free-form JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]})' },
					canvasAnchorUid: { type: 'string', description: 'Optional canvas stageUid: on success the return value is archived as a SAROS_JSON snapshot on that canvas node (its OUTPUT card shows the JSON); enables nodeOutput() round-trips on later runs.' },
				},
				required: ['script', 'meta'],
			},
			category: 'planning',
			source: ctx.id,
		},
		handler: async (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string): Promise<IToolResultContent[]> => {
			// ── meta 校验失败同步抛 → isError 结果，模型可纠正（dsh 同款回路）──
			let meta: IWorkflowMeta;
			try {
				meta = validateWorkflowMeta(args['meta']);
			} catch (e) {
				return [{ type: 'text', text: `workflow tool: ${(e as Error).message}` }];
			}
			const script = typeof args['script'] === 'string' ? args['script'] : '';
			if (!script) {
				return [{ type: 'text', text: 'workflow tool: "script" must be a non-empty string (the plain-JS body).' }];
			}
			const dispatch = ctx.orchestrationService.subAgentDispatch;
			if (!dispatch || !agentId) {
				return [{ type: 'text', text: 'workflow tool: orchestration service or calling agent unavailable — cannot attribute children. Fall back to delegate_task.' }];
			}

			const r = await executeWorkflowScript(
				{
					dispatch,
					agentOS: ctx.agentOS,
					parentAgentId: agentId,
					logService: ctx.logService,
				},
				{
					script, meta,
					...(args['args'] !== undefined ? { args: args['args'] } : {}),
					...(typeof args['canvasAnchorUid'] === 'string' ? { canvasAnchorUid: args['canvasAnchorUid'].trim() } : {}),
					signal,
					// 模型产出的脚本只存在于本次对话 → 投影是唯一可重放载体，必须落盘。
					archiveProjection: true,
				},
			);
			if (!r.ok) {
				return [{ type: 'text', text: `workflow tool: ${r.error}` }];
			}
			return [{ type: 'text', text: `${renderResult(meta.name, r.agentsStarted ?? 0, r.value)}\n\n${r.projectionText ?? ''}` }];
		},
	});
	ctx.logService.info('[BuiltinTools] _registerWorkflowTool: registered dynamic workflow tool');
}
