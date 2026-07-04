/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Kanban Tools — task board management tools for the LLM.
 * Extracted from builtinToolProvider.ts for maintainability.
 */

import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IAgentStudioService, IAgentTaskBoardService, ITaskOrchestrationService } from '../../../../../common/agentStudioService.js';
import { TaskBoardStatus, TaskSource } from '../../../common/types.js';
import { SwarmWorkerSpec } from '../../../common/swarmService.js';
import type { ISwarmService } from '../../../common/swarmService.js';

export interface KanbanToolContext {
	register(definition: { definition: any; handler: any }): void;
	studioService: IAgentStudioService;
	taskBoardService: IAgentTaskBoardService;
	orchestrationService: ITaskOrchestrationService;
	swarmService: ISwarmService;
	triageService: any;
	logService: ILogService;
}

export function registerKanbanTools(ctx: KanbanToolContext): void {
	// 辅助：从 agentId 解析当前 agent 及其运行 workspaceId
	// （agent 是全局定义，运行 workspace 取自 getActiveWorkspaceId）。
	const resolveWorkspaceId = async (agentId: string | undefined): Promise<{ workspaceId: string; assigneeId?: string; assigneeName?: string } | undefined> => {
		if (!agentId) { return undefined; }
		try {
			const workspaceId = ctx.studioService.getActiveWorkspaceId();
			if (workspaceId) {
				const agent = await ctx.studioService.getAgent(agentId);
				return { workspaceId, assigneeId: agent?.id ?? agentId, assigneeName: agent?.name };
			}
		} catch (err) {
			ctx.logService.warn(`[BuiltinTools] kanban: failed to resolve workspace for agent ${agentId}:`, err);
		}
		return undefined;
	};

	// ─── kanban_create ────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_create',
			description: 'Create a new kanban task card. The task starts in the "triage" column ' +
				'(awaiting decomposition/refinement). Use this to break down work into trackable cards. ' +
				'Optionally assign to a named agent.',
			inputSchema: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Task title' },
					description: { type: 'string', description: 'Task description (optional)' },
					assignee: { type: 'string', description: 'Assignee name (optional)' },
				},
				required: ['title'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const title = args['title'] as string | undefined;
			if (!title || !title.trim()) {
				throw new Error('kanban_create: "title" is required');
			}
			const description = args['description'] as string | undefined;
			const assignee = args['assignee'] as string | undefined;

			const workspaceId = await resolveWorkspaceId(agentId);
			if (!workspaceId) {
				return [{ type: 'text', text: 'kanban_create error: could not resolve a workspace for the current agent.' }];
			}
			try {
				const task = await ctx.taskBoardService.createTask({
					title: title.trim(),
					description,
					status: TaskBoardStatus.Triage,
					source: TaskSource.Manual,
					workspaceId: workspaceId.workspaceId,
					assigneeName: assignee,
				});
				return [{ type: 'text', text: `Created kanban task #${task.id.slice(-6)} "${task.title}" (status: triage).` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_create error: ${msg}` }];
			}
		},
	});

	// ─── kanban_complete ──────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_complete',
			description: 'Mark a kanban task as completed, with an optional result summary. ' +
				'Moves the task to the "done" column.',
			inputSchema: {
				type: 'object',
				properties: {
					task_id: { type: 'string', description: 'Task ID to complete (full ID or last-6 short ID)' },
					result: { type: 'string', description: 'Result summary (optional)' },
				},
				required: ['task_id'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const taskId = args['task_id'] as string | undefined;
			if (!taskId) {
				throw new Error('kanban_complete: "task_id" is required');
			}
			const result = args['result'] as string | undefined;
			try {
				const resolvedId = await _resolveKanbanTaskId(ctx, taskId, agentId);
				if (!resolvedId) {
					return [{ type: 'text', text: `kanban_complete error: task "${taskId}" not found.` }];
				}
				await ctx.taskBoardService.updateTask(resolvedId, {
					status: TaskBoardStatus.Done,
					...(result ? { description: result } : {}),
				});
				return [{ type: 'text', text: `Completed kanban task #${resolvedId.slice(-6)}.` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_complete error: ${msg}` }];
			}
		},
	});

	// ─── kanban_block ─────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_block',
			description: 'Block a kanban task, indicating it is waiting on a dependency or needs human input. ' +
				'Moves the task to the "blocked" status. A reason is required.',
			inputSchema: {
				type: 'object',
				properties: {
					task_id: { type: 'string', description: 'Task ID to block (full ID or last-6 short ID)' },
					reason: { type: 'string', description: 'Reason for blocking' },
				},
				required: ['task_id', 'reason'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const taskId = args['task_id'] as string | undefined;
			const reason = args['reason'] as string | undefined;
			if (!taskId) {
				throw new Error('kanban_block: "task_id" is required');
			}
			if (!reason || !reason.trim()) {
				throw new Error('kanban_block: "reason" is required');
			}
			try {
				const resolvedId = await _resolveKanbanTaskId(ctx, taskId, agentId);
				if (!resolvedId) {
					return [{ type: 'text', text: `kanban_block error: task "${taskId}" not found.` }];
				}
				const existing = await ctx.taskBoardService.getTask(resolvedId);
				const note = `[BLOCKED] ${reason.trim()}`;
				const newDesc = existing?.description ? `${existing.description}\n${note}` : note;
				await ctx.taskBoardService.updateTask(resolvedId, {
					status: TaskBoardStatus.Blocked,
					description: newDesc,
				});
				return [{ type: 'text', text: `Blocked kanban task #${resolvedId.slice(-6)}: ${reason.trim()}` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_block error: ${msg}` }];
			}
		},
	});

	// ─── kanban_unblock ───────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_unblock',
			description: 'Unblock a kanban task that was previously blocked. Moves it back to the "todo" column.',
			inputSchema: {
				type: 'object',
				properties: {
					task_id: { type: 'string', description: 'Task ID to unblock (full ID or last-6 short ID)' },
				},
				required: ['task_id'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const taskId = args['task_id'] as string | undefined;
			if (!taskId) {
				throw new Error('kanban_unblock: "task_id" is required');
			}
			try {
				const resolvedId = await _resolveKanbanTaskId(ctx, taskId, agentId);
				if (!resolvedId) {
					return [{ type: 'text', text: `kanban_unblock error: task "${taskId}" not found.` }];
				}
				await ctx.taskBoardService.updateTask(resolvedId, { status: TaskBoardStatus.Todo });
				return [{ type: 'text', text: `Unblocked kanban task #${resolvedId.slice(-6)} (status: todo).` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_unblock error: ${msg}` }];
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerKanbanTools: kanban_create/complete/block/unblock registered');

	// ─── kanban_show ──────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_show',
			description: 'Show the full details of a single kanban task: title, description, status, ' +
				'assignee, priority, dependencies, and timestamps.',
			inputSchema: {
				type: 'object',
				properties: {
					task_id: { type: 'string', description: 'Task ID to show (full ID or last-6 short ID)' },
				},
				required: ['task_id'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const taskId = args['task_id'] as string | undefined;
			if (!taskId) {
				throw new Error('kanban_show: "task_id" is required');
			}
			try {
				const resolvedId = await _resolveKanbanTaskId(ctx, taskId, agentId);
				if (!resolvedId) {
					return [{ type: 'text', text: `kanban_show error: task "${taskId}" not found.` }];
				}
				const task = await ctx.taskBoardService.getTask(resolvedId);
				if (!task) {
					return [{ type: 'text', text: `kanban_show error: task "${taskId}" not found.` }];
				}
				const lines = [
					`Task #${task.id.slice(-6)} (${task.id})`,
					`  title:        ${task.title}`,
					`  status:       ${task.status}`,
					`  priority:     ${task.priority ?? '(none)'}`,
					`  assignee:     ${task.assigneeName ?? '(unassigned)'}`,
					`  source:       ${task.source}${task.sourceId ? ` (${task.sourceId})` : ''}`,
					`  dependencies: ${task.dependencies && task.dependencies.length ? task.dependencies.map(d => `#${d.slice(-6)}`).join(', ') : '(none)'}`,
					`  createdAt:    ${task.createdAt}`,
					`  updatedAt:    ${task.updatedAt}`,
					...(task.completedAt ? [`  completedAt:  ${task.completedAt}`] : []),
					``,
					`  description:`,
					task.description ? task.description.split('\n').map(l => `    ${l}`).join('\n') : '    (empty)',
				];
				return [{ type: 'text', text: lines.join('\n') }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_show error: ${msg}` }];
			}
		},
	});

	// ─── kanban_list ──────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_list',
			description: 'List kanban tasks in the current workspace, optionally filtered by status. ' +
				'Returns a compact one-line-per-task summary. Use status="triage|todo|ready|running|blocked|done|cancelled|archived".',
			inputSchema: {
				type: 'object',
				properties: {
					status: { type: 'string', description: 'Filter by status (optional). One of: triage, todo, ready, running, blocked, done, cancelled, archived.' },
					limit: { type: 'number', description: 'Max number of tasks to return (default 50)' },
				},
				required: [],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const statusFilter = args['status'] as string | undefined;
			const limit = typeof args['limit'] === 'number' ? args['limit'] as number : 50;
			try {
				const workspaceId = await _resolveKanbanWorkspaceId(ctx, agentId);
				const tasks = await ctx.taskBoardService.getTasks(workspaceId || undefined);
				let filtered = tasks;
				if (statusFilter) {
					const wanted = statusFilter.trim().toLowerCase();
					filtered = tasks.filter((t: any) => t.status === wanted);
				}
				filtered = filtered.slice(0, Math.max(1, limit));
				if (filtered.length === 0) {
					return [{ type: 'text', text: statusFilter ? `No kanban tasks with status "${statusFilter}".` : 'No kanban tasks found.' }];
				}
				const header = `${filtered.length} task(s)${statusFilter ? ` (status=${statusFilter})` : ''}:`;
				const rows = filtered.map(t => {
					const assignee = t.assigneeName ? ` @${t.assigneeName}` : '';
					const prio = t.priority ? ` [${t.priority}]` : '';
					return `  #${t.id.slice(-6)} ${t.status.padEnd(9)}${prio}${assignee} — ${t.title}`;
				});
				return [{ type: 'text', text: [header, ...rows].join('\n') }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_list error: ${msg}` }];
			}
		},
	});

	// ─── kanban_heartbeat ─────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_heartbeat',
			description: 'Signal that work on a task is still actively progressing. Refreshes the task\'s ' +
				'last-active timestamp so diagnostics do not flag it as stuck or stranded. Call periodically ' +
				'during long-running work.',
			inputSchema: {
				type: 'object',
				properties: {
					task_id: { type: 'string', description: 'Task ID to heartbeat (full ID or last-6 short ID)' },
					note: { type: 'string', description: 'Optional short progress note (appended as a comment)' },
				},
				required: ['task_id'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const taskId = args['task_id'] as string | undefined;
			if (!taskId) {
				throw new Error('kanban_heartbeat: "task_id" is required');
			}
			const note = args['note'] as string | undefined;
			try {
				const resolvedId = await _resolveKanbanTaskId(ctx, taskId, agentId);
				if (!resolvedId) {
					return [{ type: 'text', text: `kanban_heartbeat error: task "${taskId}" not found.` }];
				}
				if (note && note.trim()) {
					// Append a heartbeat comment; updateTask refreshes updatedAt anyway.
					const existing = await ctx.taskBoardService.getTask(resolvedId);
					const stamp = new Date().toISOString();
					const line = `[HEARTBEAT ${stamp}] ${note.trim()}`;
					const newDesc = existing?.description ? `${existing.description}\n${line}` : line;
					await ctx.taskBoardService.updateTask(resolvedId, { description: newDesc });
				} else {
					// No-content touch: re-write title to bump updatedAt without semantic change.
					const existing = await ctx.taskBoardService.getTask(resolvedId);
					await ctx.taskBoardService.updateTask(resolvedId, { title: existing?.title ?? '' });
				}
				return [{ type: 'text', text: `Heartbeat recorded for kanban task #${resolvedId.slice(-6)}.` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_heartbeat error: ${msg}` }];
			}
		},
	});

	// ─── kanban_comment ───────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_comment',
			description: 'Add a comment to a kanban task. The comment is appended to the task description ' +
				'with an author + timestamp prefix. Use this to record progress, findings, or blackboard updates.',
			inputSchema: {
				type: 'object',
				properties: {
					task_id: { type: 'string', description: 'Task ID to comment on (full ID or last-6 short ID)' },
					body: { type: 'string', description: 'Comment text' },
				},
				required: ['task_id', 'body'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const taskId = args['task_id'] as string | undefined;
			const body = args['body'] as string | undefined;
			if (!taskId) {
				throw new Error('kanban_comment: "task_id" is required');
			}
			if (!body || !body.trim()) {
				throw new Error('kanban_comment: "body" is required');
			}
			try {
				const resolvedId = await _resolveKanbanTaskId(ctx, taskId, agentId);
				if (!resolvedId) {
					return [{ type: 'text', text: `kanban_comment error: task "${taskId}" not found.` }];
				}
				await _resolveKanbanWorkspaceId(ctx, agentId); // resolve workspace for context
				let authorName = 'agent';
				if (agentId) {
					try {
						const agent = await ctx.studioService.getAgent(agentId);
						if (agent?.name) { authorName = agent.name; }
					} catch { /* ignore */ }
				}
				void ctx;
				const existing = await ctx.taskBoardService.getTask(resolvedId);
				const stamp = new Date().toISOString();
				const line = `[COMMENT ${authorName} ${stamp}] ${body.trim()}`;
				const newDesc = existing?.description ? `${existing.description}\n${line}` : line;
				await ctx.taskBoardService.updateTask(resolvedId, { description: newDesc });
				return [{ type: 'text', text: `Comment added to kanban task #${resolvedId.slice(-6)}.` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_comment error: ${msg}` }];
			}
		},
	});

	// ─── kanban_link ──────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_link',
			description: 'Create a dependency link between two kanban tasks: the child task depends on the ' +
				'parent task (the parent must complete before the child can start). Used to express task ordering.',
			inputSchema: {
				type: 'object',
				properties: {
					parent_id: { type: 'string', description: 'Parent task ID — must complete first (full or short ID)' },
					child_id: { type: 'string', description: 'Child task ID — depends on the parent (full or short ID)' },
				},
				required: ['parent_id', 'child_id'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const parentArg = args['parent_id'] as string | undefined;
			const childArg = args['child_id'] as string | undefined;
			if (!parentArg) {
				throw new Error('kanban_link: "parent_id" is required');
			}
			if (!childArg) {
				throw new Error('kanban_link: "child_id" is required');
			}
			try {
				const parentId = await _resolveKanbanTaskId(ctx, parentArg, agentId);
				if (!parentId) {
					return [{ type: 'text', text: `kanban_link error: parent task "${parentArg}" not found.` }];
				}
				const childId = await _resolveKanbanTaskId(ctx, childArg, agentId);
				if (!childId) {
					return [{ type: 'text', text: `kanban_link error: child task "${childArg}" not found.` }];
				}
				if (parentId === childId) {
					return [{ type: 'text', text: 'kanban_link error: a task cannot depend on itself.' }];
				}
				const child = await ctx.taskBoardService.getTask(childId);
				const deps = new Set<string>(child?.dependencies ?? []);
				if (deps.has(parentId)) {
					return [{ type: 'text', text: `kanban_link: #${childId.slice(-6)} already depends on #${parentId.slice(-6)}.` }];
				}
				deps.add(parentId);
				await ctx.taskBoardService.updateTask(childId, { dependencies: Array.from(deps) });
				return [{ type: 'text', text: `Linked: kanban task #${childId.slice(-6)} now depends on #${parentId.slice(-6)}.` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_link error: ${msg}` }];
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerKanbanTools: 9 kanban tools registered (create/complete/block/unblock/show/list/heartbeat/comment/link)');

	// ─── kanban_specify ───────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_specify',
			description: 'Refine a rough kanban task into a structured specification (Goal / Approach / ' +
				'Acceptance criteria / Out of scope) using an LLM, then move it from triage to todo.',
			inputSchema: {
				type: 'object',
				properties: {
					task_id: { type: 'string', description: 'Task ID to specify (full or last-6 short ID)' },
				},
				required: ['task_id'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const taskId = args['task_id'] as string | undefined;
			if (!taskId) {
				throw new Error('kanban_specify: "task_id" is required');
			}
			try {
				const resolvedId = await _resolveKanbanTaskId(ctx, taskId, agentId);
				if (!resolvedId) {
					return [{ type: 'text', text: `kanban_specify error: task "${taskId}" not found.` }];
				}
				const updated = await ctx.triageService.specify(resolvedId);
				return [{ type: 'text', text: `Specified kanban task #${resolvedId.slice(-6)} (status: ${updated.status}).\n\n${updated.description ?? ''}` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_specify error: ${msg}` }];
			}
		},
	});

	// ─── kanban_decompose ─────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_decompose',
			description: 'Decompose a kanban task into 2-N concrete subtasks using an LLM, creating child ' +
				'tasks with parent dependencies. fanout=true → independent/parallel subtasks; false → sequential.',
			inputSchema: {
				type: 'object',
				properties: {
					task_id: { type: 'string', description: 'Parent task ID to decompose (full or last-6 short ID)' },
					fanout: { type: 'boolean', description: 'true=parallel/independent subtasks (default), false=sequential' },
					max_subtasks: { type: 'number', description: 'Maximum number of subtasks (default 6, hard cap 12)' },
					assignee: { type: 'string', description: 'Default assignee for created subtasks (optional)' },
				},
				required: ['task_id'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const taskId = args['task_id'] as string | undefined;
			if (!taskId) {
				throw new Error('kanban_decompose: "task_id" is required');
			}
			const fanout = typeof args['fanout'] === 'boolean' ? args['fanout'] as boolean : undefined;
			const maxSubTasks = typeof args['max_subtasks'] === 'number' ? args['max_subtasks'] as number : undefined;
			const assignee = args['assignee'] as string | undefined;
			try {
				const resolvedId = await _resolveKanbanTaskId(ctx, taskId, agentId);
				if (!resolvedId) {
					return [{ type: 'text', text: `kanban_decompose error: task "${taskId}" not found.` }];
				}
				const children = await ctx.triageService.decompose(resolvedId, { fanout, maxSubTasks, assignee });
				const list = children.map((c: any) => `  #${c.id.slice(-6)} — ${c.title}`).join('\n');
				return [{ type: 'text', text: `Decomposed kanban task #${resolvedId.slice(-6)} into ${children.length} subtask(s):\n${list}` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_decompose error: ${msg}` }];
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerKanbanTools: kanban_specify/decompose registered (LLM triage)');

	// ─── kanban_swarm ─────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'kanban_swarm',
			description: 'Spawn a multi-agent swarm: build a kanban topology (root → parallel workers → ' +
				'verifier → synthesizer), run workers in parallel as sub-agents, then verify and synthesize ' +
				'their outputs into a final result. Use for complex goals that benefit from parallel specialized agents.',
			inputSchema: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Swarm title (becomes the root task title)' },
					goal: { type: 'string', description: 'Overall goal, injected into every worker context' },
					workers: {
						type: 'array',
						description: 'Worker specs (at least 1)',
						items: {
							type: 'object',
							properties: {
								title: { type: 'string', description: 'Worker card title' },
								body: { type: 'string', description: 'What this worker should do' },
								profile: { type: 'string', description: 'Worker role/persona (optional)' },
								priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Scheduling priority' },
							},
							required: ['title', 'body'],
						},
					},
					enable_verifier: { type: 'boolean', description: 'Enable verifier stage (default true when >=2 workers)' },
					enable_synthesizer: { type: 'boolean', description: 'Enable synthesizer stage (default true)' },
				},
				required: ['title', 'workers'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const title = args['title'] as string | undefined;
			const rawWorkers = args['workers'] as Array<Record<string, unknown>> | undefined;
			if (!title) {
				throw new Error('kanban_swarm: "title" is required');
			}
			if (!Array.isArray(rawWorkers) || rawWorkers.length === 0) {
				throw new Error('kanban_swarm: "workers" must be a non-empty array');
			}
			const workers: SwarmWorkerSpec[] = [];
			for (const w of rawWorkers) {
				const wTitle = w['title'] as string | undefined;
				const wBody = w['body'] as string | undefined;
				if (!wTitle || !wBody) { continue; }
				const priority = w['priority'] as 'low' | 'medium' | 'high' | undefined;
				workers.push({
					title: wTitle,
					body: wBody,
					profile: w['profile'] as string | undefined,
					priority,
				});
			}
			if (workers.length === 0) {
				throw new Error('kanban_swarm: no valid workers (each needs title + body)');
			}
			try {
				const workspaceId = await _resolveKanbanWorkspaceId(ctx, agentId);
				const swarmId = await ctx.swarmService.createSwarm({
					title,
					goal: args['goal'] as string | undefined,
					workspaceId,
					workers,
					enableVerifier: typeof args['enable_verifier'] === 'boolean' ? args['enable_verifier'] as boolean : undefined,
					enableSynthesizer: typeof args['enable_synthesizer'] === 'boolean' ? args['enable_synthesizer'] as boolean : undefined,
				});
				return [{ type: 'text', text: `Swarm "${title}" started (${swarmId}) with ${workers.length} worker(s). The topology is on the board; workers run in parallel, then verify + synthesize.` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `kanban_swarm error: ${msg}` }];
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerKanbanTools: kanban_swarm registered (multi-agent collaboration)');
}

async function _resolveKanbanTaskId(ctx: KanbanToolContext, taskId: string, agentId: string | undefined): Promise<string | undefined> {
	// 1. 精确匹配
	const exact = await ctx.taskBoardService.getTask(taskId);
	if (exact) { return exact.id; }

	// 2. 短 ID（末 6 位）后缀匹配，限定在当前 workspace 内
	// （agent 全局，运行 workspace 取自 getActiveWorkspaceId）。
	let workspaceId: string | undefined;
	if (agentId) {
		try {
			workspaceId = ctx.studioService.getActiveWorkspaceId();
		} catch { /* ignore */ }
	}
	const all = await ctx.taskBoardService.getTasks(workspaceId || undefined);
	const normalized = taskId.replace(/^#/, '');
	const matches = all.filter((t: any) => t.id.endsWith(normalized));
	if (matches.length === 1) { return matches[0].id; }
	return undefined;
}

async function _resolveKanbanWorkspaceId(ctx: KanbanToolContext, agentId: string | undefined): Promise<string | undefined> {
	if (!agentId) { return undefined; }
	try {
		// agent 是全局定义；运行 workspace 取自 getActiveWorkspaceId。
		return ctx.studioService.getActiveWorkspaceId();
	} catch {
		return undefined;
	}
}
