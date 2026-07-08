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
import { IAgentOSService } from '../../../common/agentOS.js';
import { IPlaywrightService } from '../../../../../../platform/browserView/common/playwrightService.js';
import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
import { ISessionsManagementService } from '../../../../../../sessions/services/sessions/common/sessionsManagement.js';
import { BrowserEditorInput } from '../../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IKanbanRecipeService, IKanbanRecipe } from './kanbanRecipeService.js';

export interface KanbanToolContext {
	register(definition: { definition: any; handler: any }): void;
	studioService: IAgentStudioService;
	taskBoardService: IAgentTaskBoardService;
	orchestrationService: ITaskOrchestrationService;
	swarmService: ISwarmService;
	triageService: any;
	logService: ILogService;
	/** Integrated-browser page reader (used by web_scrape_to_board). */
	playwrightService: IPlaywrightService;
	/** Editor service, to locate the focused/open browser page (pageId = editor.id). */
	editorService: IEditorService;
	/** Session management, to resolve the playwright sessionId for the active session. */
	sessionsManagement: ISessionsManagementService;
	/** Active model provider, used to parse the page snapshot into structured tasks. */
	agentOS: IAgentOSService;
	/** Persistent URL-matched extraction recipes for web_scrape_to_board. */
	recipeService: IKanbanRecipeService;
}

export function registerKanbanTools(ctx: KanbanToolContext): void {
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
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, _agentId?: string) => {
			const title = args['title'] as string | undefined;
			if (!title || !title.trim()) {
				throw new Error('kanban_create: "title" is required');
			}
		const description = args['description'] as string | undefined;
		const assignee = args['assignee'] as string | undefined;

		const workspaceId = ctx.studioService.getActiveWorkspaceId();
		if (!workspaceId) {
			return [{ type: 'text', text: 'kanban_create error: could not resolve a workspace for the current agent.' }];
		}
		try {
			const task = await ctx.taskBoardService.createTask({
				title: title.trim(),
				description,
				status: TaskBoardStatus.Triage,
				source: TaskSource.Manual,
				workspaceId: workspaceId,
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

	// ─── web_scrape_to_board ──────────────────────────────────────────
	// ─── web_recipe_create ─────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'web_recipe_create',
			description: 'Save a reusable scraping "recipe" that binds a URL pattern (regex) to a Playwright ' +
				'extraction function. Once saved, opening a matching page and calling web_scrape_to_board will ' +
				'extract tasks deterministically via the function instead of the LLM. Ideal for fixed sites ' +
				'(TAPD / Jira / GitHub Issues). extract_fn must be a JS function of the form ' +
				'async (page, args) => ({ boardName, sourceUrl, tasks: [{ title, description?, priority?, assignee?, sourceUrl? }] }) ' +
				'or a bare array of task objects. `page` is the Playwright Page; args[0] is the page URL. ' +
				'Return value must be JSON-serializable.',
			inputSchema: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Unique recipe name (used to reference it later).' },
					url_pattern: { type: 'string', description: 'Regex (source string) matched against the browser page URL.' },
					url_flags: { type: 'string', description: 'Optional regex flags, e.g. "i" (default empty).' },
					extract_fn: { type: 'string', description: 'JS function string: async (page, args) => ({ boardName, sourceUrl, tasks }) or a bare task array.' },
					board_name: { type: 'string', description: 'Optional fixed board name (overrides function output).' },
					max_tasks: { type: 'number', description: 'Optional per-recipe task cap (default 30, hard cap 100).' },
				},
				required: ['name', 'url_pattern', 'extract_fn'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
			const name = args['name'] as string | undefined;
			const urlPattern = args['url_pattern'] as string | undefined;
			const extractFn = args['extract_fn'] as string | undefined;
			if (!name || !name.trim()) {
				return [{ type: 'text', text: 'web_recipe_create error: "name" is required.' }];
			}
			if (!urlPattern || !urlPattern.trim()) {
				return [{ type: 'text', text: 'web_recipe_create error: "url_pattern" is required.' }];
			}
			if (!extractFn || !extractFn.trim()) {
				return [{ type: 'text', text: 'web_recipe_create error: "extract_fn" is required.' }];
			}
			const recipe: IKanbanRecipe = {
				name: name.trim(),
				urlPattern: urlPattern,
				urlFlags: typeof args['url_flags'] === 'string' && args['url_flags'].trim() ? args['url_flags'].trim() : undefined,
				extractFn,
				boardName: typeof args['board_name'] === 'string' && args['board_name'].trim() ? args['board_name'].trim() : undefined,
				maxTasks: typeof args['max_tasks'] === 'number' ? args['max_tasks'] as number : undefined,
			};
			try {
				ctx.recipeService.addRecipe(recipe);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `web_recipe_create error: ${msg}` }];
			}
			return [{ type: 'text', text: `Saved recipe "${recipe.name}" (pattern: /${recipe.urlPattern}/${recipe.urlFlags ?? ''}). ` +
				`Next time a page matching this URL is open, call web_scrape_to_board — it will use this recipe automatically, or pass recipe="${recipe.name}" to force it.` }];
		},
	});

	// ─── web_recipe_list ──────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'web_recipe_list',
			description: 'List all saved web-scraping recipes (name, URL pattern, optional board name and task cap).',
			inputSchema: {
				type: 'object',
				properties: {},
				required: [],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async () => {
			const recipes = ctx.recipeService.getRecipes();
			if (recipes.length === 0) {
				return [{ type: 'text', text: 'No web-scraping recipes saved. Use web_recipe_create to add one.' }];
			}
			const lines = recipes.map(r =>
				`  • ${r.name}  —  /${r.urlPattern}/${r.urlFlags ?? ''}` +
				(r.boardName ? `  (board: ${r.boardName})` : '') +
				(r.maxTasks ? `  (cap: ${r.maxTasks})` : ''),
			);
			return [{ type: 'text', text: `${recipes.length} recipe(s):\n${lines.join('\n')}` }];
		},
	});

	// ─── web_recipe_remove ────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'web_recipe_remove',
			description: 'Delete a saved web-scraping recipe by name.',
			inputSchema: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Recipe name to delete.' },
				},
				required: ['name'],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			const name = args['name'] as string | undefined;
			if (!name || !name.trim()) {
				return [{ type: 'text', text: 'web_recipe_remove error: "name" is required.' }];
			}
			const removed = ctx.recipeService.removeRecipe(name.trim());
			return [{ type: 'text', text: removed ? `Deleted recipe "${name.trim()}".` : `web_recipe_remove: no recipe named "${name.trim()}" found.` }];
		},
	});

	// ─── web_scrape_to_board ──────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'web_scrape_to_board',
			description: 'Scrape the currently focused/open browser page and automatically create a kanban board ' +
				'populated with the tasks found on that page. If a saved recipe matches the page URL (or `recipe` ' +
				'is given), extraction runs via that recipe\'s Playwright function for deterministic results; ' +
				'otherwise the page snapshot is parsed by the LLM. Use for issue/backlog lists, planning docs, ' +
				'or TODO lists.',
			inputSchema: {
				type: 'object',
				properties: {
					board_name: { type: 'string', description: 'Optional board name (defaults to the page title / recipe board name).' },
					max_tasks: { type: 'number', description: 'Maximum number of tasks to create (default 30, hard cap 100).' },
					recipe: { type: 'string', description: 'Force a specific recipe by name (skips URL auto-matching).' },
					auto_match: { type: 'boolean', description: 'Auto-select a saved recipe by URL match (default true). Set false to always use LLM parsing.' },
				},
				required: [],
			},
			category: 'kanban',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, _agentId?: string) => {
			const page = _findActiveBrowserPage(ctx);
			if (!page) {
				return [{ type: 'text', text: 'web_scrape_to_board error: no browser page is open/focused. Open the target web page in the integrated browser first.' }];
			}
			return scrapeWebPageToBoard(ctx, {
				pageId: page.pageId,
				pageUrl: page.url,
				boardName: typeof args['board_name'] === 'string' ? (args['board_name'] as string) : undefined,
				maxTasks: typeof args['max_tasks'] === 'number' ? (args['max_tasks'] as number) : undefined,
				recipe: typeof args['recipe'] === 'string' ? (args['recipe'] as string) : undefined,
				autoMatch: args['auto_match'] === undefined ? undefined : Boolean(args['auto_match']),
			});
		},
	});
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

// ─── web_scrape_to_board helpers ──────────────────────────────────────

interface IScrapedTask {
	title: string;
	description?: string;
	priority?: 'low' | 'medium' | 'high';
	assignee?: string;
	dueDate?: string;
	tags?: string[];
	sourceUrl?: string;
}

interface IScrapeResult {
	boardName: string;
	sourceUrl: string;
	tasks: IScrapedTask[];
}

/**
 * Find the currently focused/open browser page. Returns its pageId
 * (= BrowserEditorInput.id, the Playwright view id) and URL. Prefers a visible
 * browser editor; falls back to any open one.
 */
function _findActiveBrowserPage(ctx: KanbanToolContext): { pageId: string; url: string | undefined } | undefined {
	const visible = new Set(ctx.editorService.visibleEditors);
	let fallback: { pageId: string; url: string | undefined } | undefined;
	for (const editor of ctx.editorService.editors) {
		if (editor instanceof BrowserEditorInput) {
			const candidate = { pageId: editor.id, url: editor.url };
			if (visible.has(editor)) {
				return candidate;
			}
			if (!fallback) {
				fallback = candidate;
			}
		}
	}
	return fallback;
}

/**
 * Parse a page snapshot (ARIA tree text) into structured tasks using the
 * active LLM. Mirrors the LLM plumbing used by LlmTriageService, returning a
 * best-effort result (empty tasks on parse failure — never throws for bad JSON).
 */
async function _parsePageIntoTasks(ctx: KanbanToolContext, pageContent: string): Promise<IScrapeResult> {
	const system = 'You are a meticulous extraction assistant. You read a web page snapshot (an accessibility/ARIA tree) and turn visible, actionable items (issues, tickets, todos, backlog items, list entries) into structured kanban tasks. Ignore navigation, ads, and chrome.';
	const user = [
		'Below is a snapshot of a web page. Extract the tasks/items it lists and return ONLY a JSON object inside a ```json code fence with this exact shape:',
		'{',
		'  "boardName": "short board name derived from the page (e.g. its title or project name)",',
		'  "sourceUrl": "the page URL if present, else empty string",',
		'  "tasks": [',
		'    { "title": "short imperative title", "description": "1-2 sentence detail if available", "priority": "low|medium|high (omit if unknown)", "assignee": "assignee name if shown (omit if unknown)", "dueDate": "due date if shown (omit if unknown)", "tags": ["tag1"] }',
		'  ]',
		'}',
		'Only include items that are genuinely tasks or list entries. If the page has no extractable tasks, return {"boardName":"","sourceUrl":"","tasks":[]}.',
		'',
		'PAGE SNAPSHOT:',
		pageContent,
	].join('\n');

	const raw = await _runLlm(ctx, system, user);
	const json = _extractJson(raw);
	if (!json) {
		return { boardName: '', sourceUrl: '', tasks: [] };
	}
	try {
		const obj = JSON.parse(json) as { boardName?: unknown; sourceUrl?: unknown; tasks?: unknown };
		const tasks: IScrapedTask[] = Array.isArray(obj.tasks)
			? (obj.tasks as unknown[])
				.filter((t: any) => t && typeof t.title === 'string' && t.title.trim())
				.map((t: any) => ({
					title: t.title.trim(),
					description: typeof t.description === 'string' ? t.description.trim() : undefined,
					priority: t.priority === 'low' || t.priority === 'medium' || t.priority === 'high' ? t.priority : undefined,
					assignee: typeof t.assignee === 'string' && t.assignee.trim() ? t.assignee.trim() : undefined,
					dueDate: typeof t.dueDate === 'string' ? t.dueDate : undefined,
					tags: Array.isArray(t.tags) ? t.tags.filter((x: any) => typeof x === 'string') : undefined,
				}))
			: [];
		return {
			boardName: typeof obj.boardName === 'string' ? obj.boardName : '',
			sourceUrl: typeof obj.sourceUrl === 'string' ? obj.sourceUrl : '',
			tasks,
		};
	} catch {
		return { boardName: '', sourceUrl: '', tasks: [] };
	}
}

/** Single non-streaming LLM completion via the active model provider. */
async function _runLlm(ctx: KanbanToolContext, systemPrompt: string, userPrompt: string): Promise<string> {
	const selection = ctx.agentOS.getActiveModelSelection();
	if (!selection || !selection.providerId || !selection.modelId) {
		throw new Error('no active model selection available');
	}
	const providers = ctx.agentOS.getModelProviders();
	const provider = providers.find(p => p.id === selection.providerId);
	if (!provider) {
		throw new Error(`model provider "${selection.providerId}" not found`);
	}

	const messages: any[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt },
	];

	let text = '';
	const stream = provider.chat(
		selection.modelId,
		messages,
		{ temperature: 0.2, systemPrompt },
		selection.agentId ? { agentId: selection.agentId } : undefined,
	);
	for await (const delta of stream) {
		if (delta.type === 'text' && delta.content) {
			text += delta.content;
		} else if (delta.type === 'error') {
			throw new Error(delta.error || 'model returned an error');
		} else if (delta.type === 'done') {
			break;
		}
	}
	return text.trim();
}

/** Extract the first JSON code-fence (or bare JSON) from an LLM response. */
function _extractJson(raw: string): string | undefined {
	const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence && fence[1]) {
		return fence[1].trim();
	}
	const firstObj = raw.indexOf('{');
	const firstArr = raw.indexOf('[');
	const start = (firstArr === -1) ? firstObj : (firstObj === -1 ? firstArr : Math.min(firstObj, firstArr));
	if (start === -1) {
		return undefined;
	}
	const lastObj = raw.lastIndexOf('}');
	const lastArr = raw.lastIndexOf(']');
	const end = Math.max(lastObj, lastArr);
	if (end <= start) {
		return undefined;
	}
	return raw.slice(start, end + 1).trim();
}

// ─── web_scrape_to_board: Recipe-mode helpers ────────────────────────

/**
 * Scrape the page using a saved recipe's Playwright extraction function.
 * Runs `recipe.extractFn` in the page context via IPlaywrightService.invokeFunctionRaw
 * (which awaits completion and returns the serialized result), then builds the
 * board + tasks from the structured output.
 */
async function _scrapeWithRecipe(
	ctx: KanbanToolContext,
	recipe: IKanbanRecipe,
	sessionId: string,
	pageId: string,
	pageUrl: string | undefined,
	workspaceId: string,
	args: Record<string, unknown>,
): Promise<{ type: 'text'; text: string }[]> {
	let raw: unknown;
	try {
		// invokeFunctionRaw signature: (sessionId, pageId, fnDef, ...args)
		// Inside the function `args` is the array, so args[0] === pageUrl.
		raw = await ctx.playwrightService.invokeFunctionRaw<unknown>(sessionId, pageId, recipe.extractFn, pageUrl);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return [{ type: 'text', text: `web_scrape_to_board error: recipe "${recipe.name}" extraction failed (${msg}). Check the extraction function and that the page finished loading.` }];
	}

	const parsed = _normalizeRecipeResult(raw, pageUrl);
	if (parsed.tasks.length === 0) {
		return [{ type: 'text', text: `web_scrape_to_board: recipe "${recipe.name}" returned no tasks from the page.` }];
	}

	const boardNameArg = (typeof args['board_name'] === 'string' && (args['board_name'] as string).trim())
		? (args['board_name'] as string).trim()
		: recipe.boardName;
	const maxTasksArg = typeof args['max_tasks'] === 'number'
		? (args['max_tasks'] as number)
		: recipe.maxTasks;
	const boardId = typeof args['board_id'] === 'string' ? (args['board_id'] as string) : undefined;
	return _createBoardFromScrape(ctx, workspaceId, parsed, pageId, boardNameArg, maxTasksArg, boardId);
}

/**
 * Normalize a recipe extraction result into IScrapeResult. The function may
 * return either a bare array of task specs or an object { boardName, sourceUrl, tasks }.
 */
function _normalizeRecipeResult(raw: unknown, pageUrl: string | undefined): IScrapeResult {
	let tasks: IScrapedTask[] = [];
	let boardName = '';
	let sourceUrl = pageUrl ?? '';

	if (Array.isArray(raw)) {
		tasks = raw.map(_sanitizeScrapedTask).filter((t): t is IScrapedTask => t !== undefined);
	} else if (raw && typeof raw === 'object') {
		const o = raw as Record<string, unknown>;
		if (Array.isArray(o['tasks'])) {
			tasks = (o['tasks'] as unknown[]).map(_sanitizeScrapedTask).filter((t): t is IScrapedTask => t !== undefined);
		}
		if (typeof o['boardName'] === 'string') {
			boardName = o['boardName'];
		}
		if (typeof o['sourceUrl'] === 'string' && (o['sourceUrl'] as string).trim()) {
			sourceUrl = o['sourceUrl'] as string;
		}
	}
	return { boardName, sourceUrl, tasks };
}

/** Coerce an arbitrary task-like object into a well-formed IScrapedTask. */
function _sanitizeScrapedTask(t: unknown): IScrapedTask | undefined {
	if (!t || typeof t !== 'object') {
		return undefined;
	}
	const o = t as Record<string, unknown>;
	if (typeof o['title'] !== 'string' || !(o['title'] as string).trim()) {
		return undefined;
	}
	return {
		title: (o['title'] as string).trim(),
		description: typeof o['description'] === 'string' ? (o['description'] as string).trim() : undefined,
		priority: o['priority'] === 'low' || o['priority'] === 'medium' || o['priority'] === 'high' ? o['priority'] : undefined,
		assignee: typeof o['assignee'] === 'string' && (o['assignee'] as string).trim() ? (o['assignee'] as string).trim() : undefined,
		dueDate: typeof o['dueDate'] === 'string' ? (o['dueDate'] as string) : undefined,
		tags: Array.isArray(o['tags']) ? (o['tags'] as unknown[]).filter((x: unknown) => typeof x === 'string') as string[] : undefined,
		sourceUrl: typeof o['sourceUrl'] === 'string' && (o['sourceUrl'] as string).trim() ? (o['sourceUrl'] as string).trim() : undefined,
	};
}

/**
 * Create a board and its tasks from a normalized scrape result. Shared by the
 * LLM path and the recipe path. `sourceId` is the browser pageId (used to
 * de-dupe / trace the origin of the tasks).
 */
async function _createBoardFromScrape(
	ctx: KanbanToolContext,
	workspaceId: string,
	parsed: IScrapeResult,
	sourceId: string,
	boardNameArg?: unknown,
	maxTasksArg?: unknown,
	boardId?: string,
): Promise<{ type: 'text'; text: string }[]> {
	// When a target board is supplied (e.g. the board-link "创建任务" action),
	// append the scraped tasks to that existing board instead of making a new one.
	if (boardId) {
		return _addTasksFromScrape(ctx, workspaceId, parsed, sourceId, boardId, maxTasksArg);
	}
	const maxTasks = Math.min(Math.max(1, typeof maxTasksArg === 'number' ? maxTasksArg : 30), 100);
	const boardName = (typeof boardNameArg === 'string' && boardNameArg.trim())
		? boardNameArg.trim()
		: (parsed.boardName?.trim() || '网页导入看板');
	try {
		const board = await ctx.taskBoardService.createBoard(boardName, workspaceId);
		const created: { id: string; title: string }[] = [];
		for (const t of parsed.tasks.slice(0, maxTasks)) {
			const task = await ctx.taskBoardService.createTask({
				title: t.title,
				description: t.description,
				status: TaskBoardStatus.Todo,
				source: TaskSource.Web,
				sourceId,
				sourceUrl: t.sourceUrl ?? parsed.sourceUrl,
				workspaceId,
				priority: t.priority,
				assigneeName: t.assignee,
			});
			created.push({ id: task.id, title: task.title });
		}
		return [{ type: 'text', text: `Created board "${board.name}" with ${created.length} task(s) scraped from the open page (source: web). First tasks: ${created.slice(0, 5).map(c => `#${c.id.slice(-6)} ${c.title}`).join('; ')}` }];
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return [{ type: 'text', text: `web_scrape_to_board error: failed to create board/tasks (${msg}).` }];
	}
}

/**
 * Append scraped tasks to an existing board (the "创建任务" board-link action).
 * Mirrors the task-creation loop of {@link _createBoardFromScrape} but targets
 * `boardId` directly and reports how many were added to its 待办 column.
 */
async function _addTasksFromScrape(
	ctx: KanbanToolContext,
	workspaceId: string,
	parsed: IScrapeResult,
	sourceId: string,
	boardId: string,
	maxTasksArg?: unknown,
): Promise<{ type: 'text'; text: string }[]> {
	const maxTasks = Math.min(Math.max(1, typeof maxTasksArg === 'number' ? maxTasksArg : 30), 100);
	let boardName = boardId;
	try {
		const boards = await ctx.taskBoardService.listBoards(workspaceId);
		const board = boards.find(b => b.id === boardId);
		if (board?.name) { boardName = board.name; }
	} catch {
		// Best-effort name lookup; fall back to the raw id for the message.
	}
	try {
		const created: { id: string; title: string }[] = [];
		for (const t of parsed.tasks.slice(0, maxTasks)) {
			const task = await ctx.taskBoardService.createTask({
				title: t.title,
				description: t.description,
				status: TaskBoardStatus.Todo,
				source: TaskSource.Web,
				sourceId,
				sourceUrl: t.sourceUrl ?? parsed.sourceUrl,
				workspaceId,
				boardId,
				priority: t.priority,
				assigneeName: t.assignee,
			});
			created.push({ id: task.id, title: task.title });
		}
		return [{ type: 'text', text: `Added ${created.length} task(s) to board "${boardName}" from the open page (source: web). First tasks: ${created.slice(0, 5).map(c => `#${c.id.slice(-6)} ${c.title}`).join('; ')}` }];
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return [{ type: 'text', text: `web_scrape_to_board error: failed to add tasks to board (${msg}).` }];
	}
}

// ─── Shared scrape entry point (tool + browser context menu) ───────────

/** Options for {@link scrapeWebPageToBoard}. `pageId` is the BrowserEditorInput.id / Playwright view id. */
export interface IScrapeToBoardOptions {
	pageId: string;
	pageUrl?: string;
	boardName?: string;
	maxTasks?: number;
	recipe?: string;
	autoMatch?: boolean;
	/**
	 * When set, the scraped tasks are appended to this existing board's 待办
	 * column instead of creating a new board. Used by the board-link "创建任务"
	 * action; the `web_scrape_to_board` tool leaves it undefined to get a board.
	 */
	boardId?: string;
}

/**
 * Core implementation behind both the `web_scrape_to_board` agent tool and the
 * integrated browser's "Create Kanban Tasks" right-click action.
 *
 * Resolves the active workspace + playwright session, picks a recipe (explicit
 * name, or URL auto-match), then either runs the recipe's Playwright extraction
 * function or parses the page's ARIA snapshot with the LLM, and finally builds a
 * board populated with the extracted tasks.
 *
 * Kept as a single shared function so the two call sites never drift apart.
 */
/**
 * The built-in default agent used when scraping data without an active session.
 * Per product requirement ("默认使用 Saros Claw 进行抓取数据"), when no agent
 * session is focused we fall back to Saros Claw so `web_scrape_to_board` still
 * works from a standalone integrated-browser page.
 */
export const SAROS_CLAW_AGENT_ID = 'saros-claw';
const DEFAULT_SCRAPE_SESSION_ID = SAROS_CLAW_AGENT_ID;

/**
 * Resolve the Playwright `sessionId` used to read/scrape a browser page.
 *
 * The active agent session is preferred. When none is active (e.g. the
 * integrated browser was opened standalone, or the agent chat is not focused),
 * we default to the Saros Claw agent. This is safe because the Playwright
 * service keeps page tracking **global** and replays tracked pages into every
 * session group, so any valid `sessionId` can read a tracked page.
 *
 * @returns a non-empty sessionId, or `undefined` only if even the fallback
 *          cannot be determined (should not happen with the constant fallback).
 */
export function resolveScrapeSessionId(ctx: KanbanToolContext): string | undefined {
	const active = ctx.sessionsManagement.activeSession.read(undefined);
	if (active?.resource) {
		return active.resource.toString();
	}
	// Fallback: prefer a session owned by the Saros Claw agent if one exists.
	for (const s of ctx.sessionsManagement.getSessions()) {
		const type = s.sessionType;
		const path = s.resource?.toString().toLowerCase() ?? '';
		const title = s.title.get()?.toLowerCase() ?? '';
		if (type === SAROS_CLAW_AGENT_ID || path.includes(SAROS_CLAW_AGENT_ID) || title.includes('saros claw')) {
			return s.resource.toString();
		}
	}
	// Final fallback: a constant session id for Saros Claw so the Playwright
	// service can still create a session and read the globally-tracked page.
	return DEFAULT_SCRAPE_SESSION_ID;
}

export async function scrapeWebPageToBoard(
	ctx: KanbanToolContext,
	opts: IScrapeToBoardOptions,
): Promise<{ type: 'text'; text: string }[]> {
	// Resolve the workspace that the tasks are created in.
	let workspaceId: string | undefined;
	try {
		workspaceId = ctx.studioService.getActiveWorkspaceId();
	} catch {
		workspaceId = undefined;
	}
	if (!workspaceId) {
		return [{ type: 'text', text: 'web_scrape_to_board error: no active workspace. Open a workspace first.' }];
	}

	// Resolve the playwright sessionId (defaults to Saros Claw when no
	// active session is focused).
	const sessionId = resolveScrapeSessionId(ctx);
	if (!sessionId) {
		return [{ type: 'text', text: 'web_scrape_to_board error: no active session found.' }];
	}

	const pageId = opts.pageId;
	const pageUrl = opts.pageUrl;

	// Integrated-browser views (e.g. a board hyperlink opened via the
	// "创建看板任务" context menu) are only tracked by Playwright when the
	// user explicitly shares them with the agent — otherwise getSummary /
	// invokeFunctionRaw cannot find the page and silently fail. Track it here
	// so the scrape works regardless of share state. startTrackingPage is
	// idempotent (guarded by the global tracked-pages set) and safe to call
	// for pages already opened via openPage.
	try {
		await ctx.playwrightService.startTrackingPage(pageId);
		ctx.logService.info(`[BuiltinTools] web_scrape_to_board: tracked page ${pageId} for scraping`);
	} catch (err) {
		ctx.logService.warn(`[BuiltinTools] web_scrape_to_board: failed to track page ${pageId}:`, err);
	}

	// Resolve a recipe: explicit name wins; otherwise auto-match by URL.
	let recipe: IKanbanRecipe | undefined;
	const recipeName = opts.recipe;
	if (recipeName && recipeName.trim()) {
		recipe = ctx.recipeService.getRecipe(recipeName.trim());
		if (!recipe) {
			return [{ type: 'text', text: `web_scrape_to_board error: recipe "${recipeName.trim()}" not found. Use web_recipe_list to see saved recipes.` }];
		}
	} else {
		const autoMatch = opts.autoMatch === undefined ? true : Boolean(opts.autoMatch);
		if (autoMatch && pageUrl) {
			recipe = ctx.recipeService.matchRecipe(pageUrl);
		}
	}

	// Recipe path → deterministic extraction via Playwright function.
	if (recipe) {
		ctx.logService.info(`[BuiltinTools] web_scrape_to_board: using recipe "${recipe.name}" for ${pageUrl ?? pageId}`);
		return _scrapeWithRecipe(ctx, recipe, sessionId, pageId, pageUrl, workspaceId, { board_name: opts.boardName, max_tasks: opts.maxTasks, board_id: opts.boardId } as Record<string, unknown>);
	}

	// LLM path → read ARIA snapshot and parse with the active model.
	let summary: string;
	try {
		summary = await ctx.playwrightService.getSummary(sessionId, pageId);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return [{ type: 'text', text: `web_scrape_to_board error: failed to read the page (${msg}). Make sure the page finished loading.` }];
	}
	if (!summary || !summary.trim()) {
		return [{ type: 'text', text: 'web_scrape_to_board error: the page returned no readable content.' }];
	}
	let parsed: IScrapeResult;
	try {
		parsed = await _parsePageIntoTasks(ctx, summary);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return [{ type: 'text', text: `web_scrape_to_board error: failed to parse page content (${msg}).` }];
	}
	if (parsed.tasks.length === 0) {
		return [{ type: 'text', text: 'web_scrape_to_board: no tasks could be extracted from the page.' }];
	}
	return _createBoardFromScrape(ctx, workspaceId, parsed, pageId, opts.boardName, opts.maxTasks, opts.boardId);
}
