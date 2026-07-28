/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import type { IFileService } from '../../../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IAgentOSService } from '../../../common/agentOS.js';
import { IToolResultContent } from '../../../common/providers.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';
import type { ParsedPlanTask } from '../../../common/workMode.js';
import { getPlanQueueHandle } from '../../../common/planQueueRegistry.js';
import { formatCurrentTaskReminder } from '../../../common/preLoopOrchestrator.js';
import type { AgentParadigm } from '../../../common/agentLoopStrategy.js';
import { setParadigmOverride, getParadigmOverride, clearParadigmOverride, SWITCHABLE_PARADIGMS } from '../../../common/paradigmOverride.js';

export interface CompatToolContext {
	register: (d: IBuiltinToolRegistration) => void;
	agentOS: IAgentOSService;
	fileService: IFileService;
	logService: ILogService;
	id: string;
	resolveAndCheckWorkspacePath: (agentId: string | undefined, p: string, requireInWorkspace?: boolean) => Promise<string>;
}

/**
 * _registerCompatibilityTools — 从 builtinToolProvider 抽取（source 硬编码 'saros.builtin-tools'）。
 */
export function registerCompatibilityTools(ctx: CompatToolContext): void {
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

		// read_skill / list_skills 已在 _registerSkillTools 中注册

	// ── switch_paradigm: 运行时切换 AgentLoop 范式（turn 边界生效）─────────
	// 写入 per-agent 范式覆盖；主循环每次 resolve 策略与注入策略提示词时优先
	// 读取覆盖值。切换只在下一 turn 生效（策略/预算本就 per-turn 创建，无中间态）。
	ctx.register({
		definition: {
			name: 'switch_paradigm',
			description: 'Switch the agent-loop paradigm for subsequent turns. Use "mimo" for task-gated execution (DB-truth stop gate: the loop checks the task board before finishing), "budgeted-react" for the default Hermes-style loop. The switch takes effect on the NEXT turn — the current turn keeps its current paradigm. Pass paradigm="default" to clear the override and fall back to the agent configuration.',
			inputSchema: {
				type: 'object',
				properties: {
					paradigm: {
						type: 'string',
						enum: [...SWITCHABLE_PARADIGMS, 'default'],
						description: 'budgeted-react (Hermes: budget gate + delegation) | mimo (MiMo-Code: budgeted-react + task-board stop gate) | react | plan-explore | readonly | delegation | default (clear override)',
					},
				},
				required: ['paradigm'],
			},
			category: 'utility', source: ctx.id,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) {
				return text('Error: switch_paradigm requires an active agent context.');
			}
			const target = String(args['paradigm'] ?? '');
			if (target === 'default') {
				clearParadigmOverride(agentId);
				return text('✅ Paradigm override cleared — the agent configuration takes effect from the next turn.');
			}
			if (!SWITCHABLE_PARADIGMS.includes(target as AgentParadigm)) {
				return text(`Error: unknown paradigm "${target}". Allowed: ${[...SWITCHABLE_PARADIGMS, 'default'].join(' | ')}`);
			}
			const previous = getParadigmOverride(agentId);
			setParadigmOverride(agentId, target as AgentParadigm);
			const notes: string[] = [];
			if (target === 'mimo') {
				notes.push('MiMo mode: the loop will check the task board (kanban) before finishing — unfinished session tasks trigger re-entry (max 3). Create/complete tasks with kanban_create/kanban_complete so the gate has ground truth.');
			}
			return text(
				`✅ Paradigm switch scheduled: ${previous ? `${previous} → ` : ''}${target} (effective from your NEXT turn). ` +
				`Note: the system prompt strategy section changes with the paradigm, so the prompt cache rebuilds once on the next turn (one-time cost).` +
				(notes.length > 0 ? `\n\n${notes.join('\n')}` : ''),
			);
		},
	});

	// ── plan_register: 注册有序任务队列（方案1：调研 → 拆任务 → 依次执行）────
	// 与 update_plan 的区别：update_plan 是软追踪（仅 UI 卡片，不回读）；
	// plan_register 把任务写入当前 turn 的执行队列 —— 主循环在每轮无工具调用时
	// 自动推进队列并注入 CURRENT TASK 提醒，形成强引导的依次执行。
	ctx.register({
		definition: {
			name: 'plan_register',
			description: 'Register an ordered task queue for sequential execution in this turn. Use AFTER research/exploration (delegate_task/plan_explore) when the goal decomposes into multiple ordered steps: the system injects a CURRENT TASK reminder per task and auto-advances the queue when you finish a task and stop calling tools. Tasks execute in THIS agent turn (not delegated); for parallel independent work use delegate_task instead.',
			inputSchema: {
				type: 'object',
				properties: {
					tasks: {
						type: 'array',
						description: 'Ordered tasks (2-8). They execute strictly in order — put blocking/foundational steps first.',
						items: {
							type: 'object',
							properties: {
								title: { type: 'string', description: 'Short imperative title, e.g. "Add retry logic to fetcher"' },
								description: { type: 'string', description: 'What to do, including key findings from prior research relevant to this task' },
								deliverable: { type: 'string', description: 'Expected output of this task (optional)' },
								files: { type: 'array', items: { type: 'string' }, description: 'Priority files to touch (optional)' },
							},
							required: ['title', 'description'],
						},
					},
				},
				required: ['tasks'],
			},
			category: 'planning', source: ctx.id,
		},
		handler: async (args, _signal, agentId) => {
			const rawTasks = Array.isArray(args['tasks']) ? args['tasks'] as Array<Record<string, unknown>> : [];
			const tasks: ParsedPlanTask[] = rawTasks
				.map(t => ({
					title: String(t?.['title'] ?? '').trim(),
					description: String(t?.['description'] ?? '').trim(),
					deliverable: typeof t?.['deliverable'] === 'string' ? String(t['deliverable']) : undefined,
					files: Array.isArray(t?.['files']) ? (t['files'] as unknown[]).map(String) : undefined,
				}))
				.filter(t => t.title.length > 0);
			if (tasks.length === 0) {
				return text('Error: plan_register requires at least 1 task with a non-empty title.');
			}
			const handle = agentId ? getPlanQueueHandle(agentId) : undefined;
			if (!handle) {
				// 无活动 turn 队列（如非 agent loop 上下文）—— 降级为文本指引，不阻塞流程。
				return text(`No active execution queue for this agent — execute the following tasks in order manually:\n${tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')}`);
			}
			handle.setPlan(tasks);
			const reminder = formatCurrentTaskReminder(tasks[0], 0, tasks.length);
			return text(`✅ Registered ${tasks.length} tasks for sequential execution. The queue auto-advances when you finish each task and stop calling tools.\n\n${reminder}`);
		},
	});

	// ── update_plan: LLM 自主规划（对齐 OpenClaw update_plan）─────────
	// 极简模型：LLM 传入完整步骤列表（替换语义），系统仅校验约束。
	// 步骤状态：pending | in_progress | completed
	// 约束：最多一个 in_progress（对齐 OpenClaw PLAN_STEP_STATUSES）
	// 2026-07-04: 替代旧的 todo 工具（CRUD 式 task list），
	// 对齐 OpenClaw 的交织式规划：update_plan → 执行工具 → update_plan（更新状态）
	ctx.register({
		definition: {
			name: 'update_plan',
			displaySummary: 'Track short work plan.',
			replaySafe: true,
			description: 'Update current run plan. ' +
				'Use for non-trivial multi-step work; keep plan current while executing. ' +
				'Short steps; max one in_progress; skip for simple one-step work.',
			inputSchema: {
				type: 'object',
				properties: {
					plan: {
						type: 'array',
						description: 'Ordered list of steps (replaces previous plan).',
						minItems: 1,
						items: {
							type: 'object',
							properties: {
								step: { type: 'string', description: 'Short step description.' },
								status: {
									type: 'string',
									enum: ['pending', 'in_progress', 'completed'],
									description: 'pending | in_progress | completed.',
								},
							},
					required: ['step', 'status'],
				},
					},
					explanation: {
						type: 'string',
						description: 'Optional short note explaining what changed.',
					},
				},
				required: ['plan'],
			},
			category: 'todo', source: ctx.id,
		},
		handler: async (args) => {
			const plan = args['plan'];
			if (!Array.isArray(plan) || plan.length === 0) {
				return text('update_plan error: "plan" must be a non-empty array of steps');
			}
			// 校验约束：最多一个 in_progress（对齐 OpenClaw）
			const inProgressCount = plan.filter(
				(s: any) => s?.status === 'in_progress'
			).length;
			if (inProgressCount > 1) {
				return text(`update_plan error: at most one step may be in_progress (found ${inProgressCount})`);
			}
			// 校验每个步骤
			for (const s of plan) {
				if (!s || typeof s.step !== 'string' || !s.step.trim()) {
					return text('update_plan error: each step must have a non-empty "step" string');
				}
				if (!['pending', 'in_progress', 'completed'].includes(s.status)) {
					return text(`update_plan error: invalid status "${s.status}" for step "${s.step}"`);
				}
			}
			const explanation = args['explanation'] as string | undefined;
			// 对齐 OpenClaw: content: [] — LLM 不重复看到计划文本
			// details 供 UI 渲染结构化计划卡片（进度条 + 步骤状态）
			return {
				content: [] as IToolResultContent[],
				details: {
					status: 'updated' as const,
					plan: plan as Array<{ step: string; status: string }>,
					...(explanation ? { explanation } : {}),
				},
			};
		},
	});

		// ── patch: 基础文件补丁 ──────────────────────────────────
		ctx.register({
			definition: {
				name: 'patch',
				description: 'Apply a patch to a file by searching for text and replacing it. Safer than file_write for targeted edits.',
				inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path to patch' }, search: { type: 'string', description: 'Text to search for' }, replace: { type: 'string', description: 'Replacement text' }, replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' } }, required: ['path', 'search', 'replace'] },
				category: 'file', source: ctx.id,
			},
			handler: async (args, _signal, agentId) => {
				const filePath = String(args['path'] ?? '');
				const search = String(args['search'] ?? '');
				const replace = String(args['replace'] ?? '');
				const replaceAll = Boolean(args['replace_all']);
				if (!filePath || !search) { return text('Error: path and search are required'); }
				try {
					const resolved = await ctx.resolveAndCheckWorkspacePath(agentId, filePath);
					const fileUri = URI.file(resolved);
					const buf = await ctx.fileService.readFile(fileUri);
					let content = buf.value.toString();
					if (replaceAll) {
						content = content.split(search).join(replace);
					} else {
						const idx = content.indexOf(search);
						if (idx === -1) { return text(`Search text not found in ${filePath}`); }
						content = content.slice(0, idx) + replace + content.slice(idx + search.length);
					}
					await ctx.fileService.writeFile(fileUri, VSBuffer.fromString(content));
					return text(`Patched ${filePath} (${replaceAll ? 'all occurrences' : 'first occurrence'})`);
				} catch (e) {
					return text(`Error patching ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
				}
			},
		});

		// ── process / session_search / execute_code ─────────────────
		// 平台不适用 — 返回友好提示（web_search/web_extract 已有真实 handler，不在此注册 stub）
		for (const [name, desc, msg] of [
			['process', 'Manage background processes.', 'Process management is not natively available. Use the terminal tool to launch commands. For long-running processes, use the timeout parameter to control execution duration.'],
			['session_search', 'Search past conversation sessions.', 'Session search is not yet available. Past conversations are stored in ~/.saros/sessions/.'],
			['execute_code', 'Execute a Python script in a sandbox.', 'Code execution sandbox is not available. Use the terminal tool to run scripts.'],
		] as const) {
			ctx.register({
				definition: { name, description: desc, inputSchema: { type: 'object', properties: { _no_params: { type: 'boolean', description: 'No parameters needed' } } }, category: 'utility', source: ctx.id },
				handler: async () => text(msg),
			});
		}

		ctx.logService.info('[BuiltinTools] _registerCompatibilityTools: registered aliases + missing core tools');
}
