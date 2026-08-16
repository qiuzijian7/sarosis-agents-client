/*---------------------------------------------------------------------------------------------
 *  Plan Mode Tools — plan_enter / plan_exit (MiMo-Code-inspired)
 *
 *  MiMo-Code uses `plan_enter`/`plan_exit` TOOLS to switch between plan and build
 *  modes, with user confirmation dialogs. This mirrors that design in Saros:
 *
 *  Flow:
 *    1. User sends message (craft mode)
 *    2. LLM calls plan_enter → user confirms → chatMode switches to 'plan'
 *    3. LLM follows 5-phase workflow (explore → design → review → write plan → plan_exit)
 *    4. LLM calls plan_exit → user confirms → chatMode switches to 'craft'
 *    5. LLM reads plan file and executes
 *
 *  The tools themselves are thin — they return a result message. The real logic
 *  (confirmation dialog, chatMode mutation, system-reminder injection) is intercepted
 *  in agentTurnExecutor.ts (same pattern as exit_plan_mode).
 *
 *  Tool schemas are ALWAYS present regardless of mode (MiMo alignment: no tool-list
 *  mutation on mode switch → prefix-cache stable).
 *--------------------------------------------------------------------------------------------*/

import type { IToolResultContent } from '../../../common/providers.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface PlanModeToolContext {
	register: (d: IBuiltinToolRegistration) => void;
	source: string;
}

export function registerPlanModeTools(ctx: PlanModeToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

	// ── plan_enter: switch INTO plan mode ──────────────────────────────
	// LLM calls this when the task is complex and would benefit from planning.
	// The agentTurnExecutor intercepts this call and shows a user confirmation
	// dialog. On approval, chatMode switches to 'plan' for subsequent iterations.
	ctx.register({
		definition: {
			name: 'plan_enter',
			displaySummary: 'Switch to plan mode for structured planning (user confirmation required).',
			replaySafe: true,
			description: [
				'Request to switch into plan mode for structured planning before implementation.',
				'',
				'This tool is always present regardless of current mode. It is only effective outside of plan mode.',
				'',
				'Call this tool when:',
				'- The user\'s request is complex and would benefit from planning first',
				'- You want to research and design before making changes',
				'- The task involves multiple files or significant architectural decisions',
				'',
				'Do NOT call this tool:',
				'- If you are already in plan mode',
				'- For simple, straightforward tasks',
				'- When the user explicitly wants immediate implementation',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					reason: {
						type: 'string',
						description: 'Brief explanation of why plan mode is recommended for this task.',
					},
				},
			},
			category: 'planning',
			source: ctx.source,
		},
		handler: async (args: Record<string, unknown>): Promise<IToolResultContent[]> => {
			// The actual confirmation + mode switch is handled by agentTurnExecutor
			// interception (same pattern as exit_plan_mode). This handler returns
			// a placeholder; the interceptor replaces it with the real result.
			const reason = String(args['reason'] ?? '');
			return text(`plan_enter requested${reason ? `: ${reason}` : ''}. Waiting for user confirmation...`);
		},
	});

	// ── plan_exit: switch OUT of plan mode ─────────────────────────────
	// LLM calls this after writing the plan file. The agentTurnExecutor
	// intercepts and shows a user confirmation dialog. On approval, chatMode
	// switches to 'craft' and BUILD_SWITCH reminder is injected.
	ctx.register({
		definition: {
			name: 'plan_exit',
			displaySummary: 'Exit plan mode and switch to craft mode for implementation (user confirmation required).',
			replaySafe: true,
			description: [
				'Exit plan mode — submit your structured plan for DAG-based parallel execution.',
				'',
				'IMPORTANT: Call this ONCE per plan batch, after ALL tasks are written.',
				'After plan_exit, the orchestration DAG dispatches tasks to sub-agents.',
				'You should STOP analyzing and WAIT for the orchestration results.',
				'This tool only works in plan mode (after plan_enter).',
				'',
				'Call this tool:',
				'- After you have written ALL tasks to the plan file (not one at a time)',
				'- After each task has concrete steps, dependency edges, and acceptance criteria',
				'- When you are confident the plan is complete and ready for execution',
				'',
				'Do NOT call this tool:',
				'- Incrementally — write ALL tasks then call ONCE',
				'- Outside plan mode — call plan_enter first',
				'- If tasks are still incomplete or ambiguous',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					plan_file: {
						type: 'string',
						description: 'Path to the plan file you wrote. Optional — auto-detected if omitted.',
					},
				},
			},
			category: 'planning',
			source: ctx.source,
		},
		handler: async (args: Record<string, unknown>): Promise<IToolResultContent[]> => {
			// The actual confirmation + mode switch is handled by agentTurnExecutor
			// interception. This handler returns a placeholder.
			const planFile = String(args['plan_file'] ?? '');
			return text(`plan_exit requested${planFile ? ` (plan: ${planFile})` : ''}. Waiting for user confirmation...`);
		},
	});
}
