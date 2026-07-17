/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IAgentOSService } from '../../../common/agentOS.js';
import type { ITaskOrchestrationService } from '../../../../../common/agentStudioService.js';
import type { IAgentStudioService } from '../../../../../common/agentStudioService.js';
import { ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent, IModelSelection, IAgentTurnRequest, IChatStreamDelta } from '../../../common/providers.js';
import { SubAgentType, SubAgentResult, UnifiedSubAgentDispatch } from '../../../common/unifiedSubAgentDispatch.js';
import { IterationBudget } from '../../../common/iterationBudget.js';
import { AgentType } from '../../../../../common/agentStudioTypes.js';
import type { Agent } from '../../../../../common/agentStudioTypes.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface DelegationToolContext {
	register: (d: IBuiltinToolRegistration) => void;
	id: string;
	agentOS: IAgentOSService;
	orchestrationService: ITaskOrchestrationService;
	getParentWorktreePath: () => string | undefined;
	studioService: IAgentStudioService;
	logService: ILogService;
}



// ─── new_agent 工具 — 独立导出函数，便于 TDD 测试 ────────────────────────────

// ─── new_agent 工具 — 独立导出函数，便于 TDD 测试 ────────────────────────────

/**
 * 将 agent 名称转换为 URL 友好的 slug 格式。
 *
 * 规则：
 *   - 小写字母、数字、连字符
 *   - 空格/下划线 → 连字符
 *   - 移除其他特殊字符
 *   - 去除首尾连字符
 *   - 最多 40 字符
 *
 * 示例：
 *   "Code Reviewer"   → "code-reviewer"
 *   "My Coding Agent"  → "my-coding-agent"
 *   "UI/UX Designer"   → "uiux-designer"
 *
 * 导出为独立函数以便单元测试。
 */
export function slugifyAgentName(name: string): string {
	let slug = name
		.toLowerCase()
		.trim()
		// 先将非 ASCII 空格类字符（全角空格、中文逗号等）替换为半角
		.replace(/[\u3000\u2000-\u200F\u2028-\u202F\u205F\u00A0]/g, ' ')
		.replace(/[^a-z0-9\s_-]/g, '')   // 移除特殊字符（含中文）
		.replace(/[\s_]+/g, '-')          // 空格/下划线 → 连字符
		.replace(/-+/g, '-')              // 去重连字符
		.replace(/^-|-$/g, '')            // 去首尾连字符
		.slice(0, 40);                    // 限制长度

	// 纯中文/Unicode 名称导致 slug 为空时，使用时间戳生成可用的 id
	if (!slug) {
		slug = `agent-${Date.now().toString(36)}`;
	}
	return slug;
}

/**
 * handleNewAgentTool — 创建持久化 Agent 定义。
 *
 * 与 delegate_task 的区别：
 *   - delegate_task 创建一次性子代理，执行完即销毁
 *   - new_agent 创建持久化 Agent，保存到 ~/.saros/agents/{id}/，可被后续复用
 *
 * Agent 命名规则：
 *   - 名称自动转为 slug 格式（小写、连字符分隔，如 "Code Reviewer" → "code-reviewer"）
 *   - id 与 slug 名称一致，无随机后缀（确保可读性和可预测性）
 *
 * 导出为独立函数以便单元测试（避免实例化整个 BuiltinToolProvider）。
 *
 * @param args LLM 传入的工具参数
 * @param studioService Agent Studio 服务（提供 createAgent）
 * @returns IToolResultContent[] — JSON 格式的创建结果
 */
export async function handleNewAgentTool(
	args: Record<string, unknown>,
	studioService: Pick<IAgentStudioService, 'createAgent'>,
): Promise<IToolResultContent[]> {
	const rawName = args['name'] as string | undefined;
	const role = args['role'] as string | undefined;
	const description = args['description'] as string | undefined;

	// 1. 验证必填字段
	const missing: string[] = [];
	if (!rawName?.trim()) { missing.push('name'); }
	if (!role?.trim()) { missing.push('role'); }
	if (!description?.trim()) { missing.push('description'); }
	if (missing.length > 0) {
		return [{ type: 'text', text: JSON.stringify({
			success: false,
			error: `Missing required parameter(s): ${missing.join(', ')}`,
		}) }];
	}

	// 2. Slug 化名称并对齐 _generateId 的 slug 逻辑（但去掉随机后缀）
	const slugName = slugifyAgentName(rawName!);
	const displayName = rawName!.trim();

	// 3. 构建 Partial<Agent> — displayName 保留用户原始输入，id 使用 slug
	const trimmedRole = role!.trim();
	const trimmedDesc = description!.trim();
	const agentData: Partial<Agent> = {
		id: slugName,
		name: displayName,
		role: trimmedRole,
		description: trimmedDesc,
		source: 'custom',
	};
	// systemPrompt: 用户提供则使用，否则基于 role + description 自动生成
	agentData.systemPrompt = args['systemPrompt']
		? (args['systemPrompt'] as string)
		: `You are a ${trimmedRole}. ${trimmedDesc}`;
	if (args['model']) { agentData.model = args['model'] as string; }
	if (args['tools']) { agentData.tools = args['tools'] as string[]; }
	if (args['skills']) { agentData.skills = args['skills'] as string[]; }
	if (args['category']) { agentData.category = args['category'] as string; }
	if (args['agentType']) {
		agentData.agentType = (args['agentType'] === 'planner')
			? AgentType.Planner
			: AgentType.Worker;
	}

	// 4. 调用 studioService.createAgent
	try {
		const agent = await studioService.createAgent(agentData);
		return [{ type: 'text', text: JSON.stringify({
			success: true,
			id: agent.id,
			name: agent.name,
			role: agent.role,
			description: agent.description,
			agentType: agent.agentType ?? 'worker',
			category: agent.category,
			systemPrompt: agent.systemPrompt || '(auto-generated)',
			message: `Agent "${agent.name}" created successfully. Use delegate_task to assign tasks to it.`,
		}) }];
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return [{ type: 'text', text: JSON.stringify({
			success: false,
			error: `Failed to create agent: ${msg}`,
		}) }];
	}
}

/**
 * _registerDelegationTools — 从 builtinToolProvider 抽取（source 硬编码 'saros.builtin-tools'）。
 */
export function registerDelegationTools(ctx: DelegationToolContext): void {
		// delegate_task — LLM 自主委派任务给子代理
		ctx.register({
			definition: {
			name: 'delegate_task',
			displaySummary: 'Delegate to sub-agent(s) for parallel execution.',
			description:
				'Delegate a task (or multiple independent tasks) to a sub-agent that runs in an isolated context and returns its result. ' +
				'\n\n' +
				'**PREFER BATCH MODE** (tasks: [...]) when you have 2+ INDEPENDENT investigations — they run in parallel and results are aggregated. ' +
				'Use single mode (task: "...") for one focused job that benefits from its own context. ' +
				'\n\n' +
				'**WHEN TO USE**\n' +
				'- 2+ independent investigations / analyses / file searches → BATCH (tasks: [...])\n' +
				'- A single job is complex enough to benefit from a dedicated context (deep code exploration, independent review, reading 10+ files, root-cause tracing)\n' +
				'- Slow or expensive work that would otherwise block your own context\n' +
				'\n\n' +
				'**WHEN NOT TO USE**\n' +
				'- Trivial single-file lookup, or the answer is already in your context\n' +
				'- Simple enough to finish in one turn with your own tools\n' +
				'- You must keep continuous context across sequential steps (do it yourself)\n' +
				'- You are already at maximum spawn depth\n' +
				'\n\n' +
				'**CRITICAL: each sub-agent starts BLANK** — it cannot see this conversation. Write the task as a self-contained briefing ' +
				'(GOAL + what you already know/ruled out + ACCEPTANCE CRITERIA + output limits). ' +
				'Batch tasks must be mutually independent; sequence dependent steps inside a single task string.',
			inputSchema: {
				type: 'object',
				properties: {
					task: { type: 'string', description: 'Single task description to delegate. Write it as a self-contained briefing — the sub-agent cannot see this conversation.' },
					tasks: { type: 'array', items: { type: 'string' }, description: 'Multiple INDEPENDENT task descriptions to delegate in parallel. Each must be self-contained; dependent steps go inside one task string.' },
					type: {
						type: 'string',
						enum: ['General', 'Explore', 'Scout'],
						description: 'Sub-agent role. General (default, can read+write+execute) for build/edit/review work; ' +
							'Explore (read-only) for investigation/search; Scout (read-only) for external library/docs research. ' +
							'Batch tasks default to Explore — set General if a batched task needs to write files.',
					},
				context: {
					type: 'string',
					description: 'Optional background context to inject into the sub-agent (e.g. a summary of prior steps, ' +
						'relevant findings, or decisions already made). The sub-agent cannot see this conversation, so pass ' +
						'any facts it needs here. In batch mode this context is shared across all tasks.',
				},
				toolsets: {
					type: 'array',
					items: { type: 'string' },
					description: 'Optional toolset scope for the sub-agent (e.g. ["core"] for read-only work). ' +
						'When set, the sub-agent may ONLY use tools from the listed toolsets — a way to constrain ' +
						'what the delegated work is allowed to do. Defaults to no restriction.',
				},
				model: {
					type: 'string',
					description: 'Optional model for the sub-agent. Accepts "providerId/modelId" (e.g. ' +
						'"knot-agui/gpt-4o-mini") or just "modelId" (reuses the session\'s current provider). ' +
						'When set, the sub-agent runs with this model instead of the session default.',
				},
				},
				required: [],
			},
				category: 'delegation',
				source: ctx.id,
			},
		handler: async (args, _signal, agentId) => {
			const task = args['task'] as string | undefined;
			const tasks = args['tasks'] as string[] | undefined;
			const typeArg = args['type'] as string | undefined;
			const contextArg = args['context'] as string | undefined;
			const toolsetsArg = args['toolsets'] as string[] | undefined;
			const modelArg = args['model'] as string | undefined;

			// Resolve the requested sub-agent role. LLM passes a string; map it to
			// the SubAgentType enum (defaults to General for single tasks).
			const resolveType = (v?: string): SubAgentType => {
				switch (v) {
					case 'Explore': return SubAgentType.Explore;
					case 'Scout': return SubAgentType.Scout;
					case 'General':
					default: return SubAgentType.General;
				}
			};
			const subAgentType = resolveType(typeArg);

			// Resolve the optional model override. Accept "providerId/modelId"
			// or a bare "modelId" (reuses the session's current provider).
			const resolveModelArg = (v?: string): IModelSelection | undefined => {
				if (!v) { return undefined; }
				const slash = v.indexOf('/');
				if (slash > 0) {
					return { providerId: v.slice(0, slash), modelId: v.slice(slash + 1) };
				}
				const active = ctx.agentOS.getActiveModelSelection?.();
				return { providerId: active?.providerId ?? 'knot-agui', modelId: v };
			};
			const modelSelection = resolveModelArg(modelArg);

			if (!task && (!tasks || tasks.length === 0)) {
				throw new Error('delegate_task: either "task" or "tasks" must be provided');
			}

			// v17: inherit the parent agent's worktree so the subagent tree
			// operates in the same working directory.
			const inheritedWorktree = ctx.getParentWorktreePath();

			// Build executeFn that delegates to AgentOS
			const executeFn = (request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> => {
				return ctx.agentOS.executeAgentTurn(request);
			};

			try {
				if (task) {
					// Single task mode — use dispatch()
					const result = await (ctx.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch).dispatch(
						agentId ?? 'unknown',
						task,
						executeFn,
						{ type: subAgentType, worktreePath: inheritedWorktree, context: contextArg, toolsets: toolsetsArg, model: modelSelection },
					);
					if (result.success) {
						return [{ type: 'text', text: result.output ?? '(no output)' }];
					} else {
						return [{ type: 'text', text: `Sub-agent failed: ${result.error ?? 'unknown error'}` }];
					}
				} else {
					// Batch tasks mode — use dispatchParallelExplore()
					// v17: per-task worktree inherited from the parent agent.
					// Honor an explicit type (e.g. General for parallel writes);
					// otherwise each batched task defaults to Explore (read-only).
					const perTaskOptions = (inheritedWorktree || typeArg || toolsetsArg || modelArg)
						? tasks!.map(() => ({
							type: subAgentType,
							...(inheritedWorktree ? { worktreePath: inheritedWorktree } : {}),
							...(toolsetsArg ? { toolsets: toolsetsArg } : {}),
							...(modelSelection ? { model: modelSelection } : {}),
						}))
						: undefined;
					const results = await (ctx.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch).dispatchParallelExplore(
						agentId ?? 'unknown',
						tasks!,
						executeFn,
						contextArg, // shared context injected into every batched sub-agent
					perTaskOptions,
					undefined, // eventSink
					);
						const lines = results.map((r: SubAgentResult, i: number) => [
							`Task ${i + 1}: ${r.success ? 'SUCCESS' : 'FAILED'}`,
							r.success ? `  Output: ${r.output ?? '(empty)'}` : `  Error: ${r.error ?? 'unknown'}`,
						].join('\n'));
						return [{ type: 'text', text: lines.join('\n\n') }];
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `delegate_task error: ${msg}` }];
				}
			},
			descriptionBuilder: (agentId: string) => {
				try {
					const dispatch = ctx.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch;
				const config = dispatch.getConfig();
				return `Delegate a task (or multiple tasks) to a sub-agent. ` +
					`The sub-agent runs independently and returns its result. ` +
					`Use this when the task can be decomposed into independent parallel subtasks, ` +
					`or when the task requires a separate context window. ` +
					`Supports both single task (task) and batch tasks (tasks). ` +
					`You can run up to ${config.maxConcurrent} sub-agents in parallel ` +
					`(max ${config.maxSpawnDepth} levels deep). ` +
					`\n\n` +
					`## CRITICAL — the sub-agent starts BLANK:\n` +
					`It cannot see this conversation. Write every task as a self-contained briefing:\n` +
					`- GOAL: what to accomplish and why\n` +
					`- CONTEXT: what you already know / have ruled out\n` +
					`- ACCEPTANCE: how to know it is done, plus output limits (e.g. "report in <200 words")\n` +
					`Batch tasks must be mutually independent; sequence dependent steps inside one task string.\n` +
					`\n\n` +
					`## Choose a role with \`type\`:\n` +
					`- General (default): read+write+execute — build, edit, review\n` +
					`- Explore (read-only): investigation / code search — also the batch-mode default\n` +
					`- Scout (read-only): external library / docs research\n` +
				`Set type: General for batch tasks that must write files.\n` +
				`\n\n` +
				`## Pass context with \`context\`:\n` +
				`- The sub-agent is BLANK, so anything it needs from this conversation must be passed here (prior steps, findings, decisions).\n` +
				`- Keep it a concise summary — do not paste the whole transcript. In batch mode the same context is shared by all tasks.\n` +
				`\n\n` +
				`## Scope the sub-agent (optional):\n` +
				`- \`toolsets\`: restrict which toolsets the sub-agent may use, e.g. ["core"] for read-only investigation. Omit for no restriction.\n` +
				`- \`model\`: run the sub-agent on a specific model, e.g. "knot-agui/gpt-4o-mini" or just "gpt-4o-mini" (reuses the session provider). Use a cheaper model for trivial fan-out to save cost.\n` +
				`\n\n` +
				`## When to use:\n` +
					`- The task can be decomposed into 2+ independent subtasks\n` +
					`- You need to run multiple independent investigations simultaneously\n` +
					`- The subtask is complex enough to benefit from a dedicated context\n` +
					`\n\n` +
					`## When NOT to use:\n` +
					`- The task is simple and can be completed in one turn\n` +
					`- You need to maintain ongoing context/memory across steps\n` +
					`- You are already at maximum spawn depth\n`;
				} catch {
					return 'Delegate a task (or multiple tasks) to a sub-agent. ' +
						'The sub-agent runs independently and returns its result. ' +
						'Use this when a task can be performed in parallel or requires a separate context. ' +
						'Supports both single task (task) and batch tasks (tasks).';
				}
			},
		});
		ctx.logService.info('[BuiltinTools] _registerDelegationTools: delegate_task registered');

		// ── new_agent — 创建持久化 Agent 定义 ──────────────────────────────
		// 与 delegate_task 的区别：new_agent 创建可复用的持久化 Agent，
		// 而 delegate_task 创建一次性子代理。详见 handleNewAgentTool 文档。
		ctx.register({
			definition: {
				name: 'new_agent',
				description: [
					'Create a new persistent agent definition that can be reused for future tasks.',
					'',
					'The created agent is saved to ~/.saros/agents/{agentId}/ and becomes available',
					'for delegation (delegate_task), orchestration plans, and manual invocation.',
					'',
					'## When to use:',
					'- You need a specialized agent that does not exist yet',
					'- A task requires a role/toolset combination not covered by existing agents',
					'- You want to create a reusable team member for ongoing work',
					'',
					'## When NOT to use:',
					'- For a one-off task (use delegate_task instead)',
					'- The agent already exists (use delegate_task to invoke it)',
				].join('\n'),
				inputSchema: {
					type: 'object',
					properties: {
						name: { type: 'string', description: 'Human-readable agent name (e.g. "Code Reviewer")' },
						role: { type: 'string', description: 'Agent role/specialty (e.g. "Reviewer", "Researcher", "Developer")' },
						description: { type: 'string', description: 'What this agent does and when to use it' },
						systemPrompt: { type: 'string', description: 'Custom system prompt for the agent' },
						model: { type: 'string', description: 'LLM model (default: inherits workspace default)' },
						tools: {
							type: 'array',
							items: { type: 'string' },
							description: 'Enabled tool names (default: all core tools)',
						},
						skills: {
							type: 'array',
							items: { type: 'string' },
							description: 'Skill names to enable',
						},
						category: { type: 'string', description: 'Category label (default: "General")' },
						agentType: {
							type: 'string',
							enum: ['planner', 'worker'],
							description: 'planner = can orchestrate sub-tasks; worker = executes tasks (default: worker)',
						},
					},
					required: ['name', 'role', 'description'],
				},
				category: 'delegation',
				source: ctx.id,
				securityLevel: ToolSecurityLevel.Cautious,
			},
			handler: async (args) => {
				return handleNewAgentTool(args, ctx.studioService);
			},
		});
		ctx.logService.info('[BuiltinTools] _registerDelegationTools: new_agent registered');}
