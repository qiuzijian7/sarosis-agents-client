/** VsSaros addition: main Session tools that give work to VsSaros Bots as a team plan (see `../team.ts`). */
import { z } from 'zod'
import { UserError } from '../../core/index.ts'
import { TEAM_PARALLEL, TEAM_STEPS_MAX, TeamError, type PlanView, type StepInput, type Team } from '../team.ts'
import type { Retrospective } from '../retrospective.ts'
import { tool, type Tool } from './tool.ts'

export interface TeamToolsHost {
  readonly team: Pick<Team, 'bots' | 'plan' | 'stop' | 'view' | 'views' | 'createBot'>
  readonly retro: Pick<Retrospective, 'match' | 'run'>
}

const KEY = z.string().trim().regex(/^[A-Za-z0-9_-]{1,24}$/, 'letters, digits, _ or -, at most 24')
const StepSchema = z.object({
  key: KEY,
  title: z.string().trim().min(1).max(120),
  spec: z.string().trim().min(1).max(4000),
  bot: z.string().trim().min(1).max(120),
  after: z.array(KEY).max(TEAM_STEPS_MAX).optional(),
}).strict()

/** A plan as the main Session reads it: no exchanges, reports shortened. */
function brief(plan: PlanView) {
  return { plan: plan.id, goal: plan.goal, state: plan.status, running: plan.running,
    steps: plan.steps.map(step => ({ step: step.id, title: step.title, bot: step.botName ?? step.bot, state: step.state, after: step.after,
      ...step.report ? { report: step.report.length > 400 ? `${step.report.slice(0, 400)}…` : step.report } : {},
      ...step.error ? { error: step.error } : {} })) }
}
/** Answers a refused plan to the model instead of failing the call. */
async function refusing<T>(run: () => Promise<T>): Promise<T | { refused: string }> {
  try { return await run() }
  catch (error) { if (error instanceof TeamError || error instanceof UserError) return { refused: error.message }; throw error }
}

/** The team tools of the main Session. */
export function teamTools(host: TeamToolsHost): Tool[] {
  return [
    tool({
      name: 'orchestrator_team_bots',
      description: 'List the VsSaros Bots that can take a step, matching need first.',
      schema: z.object({ need: z.string().trim().max(200).optional() }).strict(),
      execute: async ({ need }) => refusing(async () => ({ bots: (await host.team.bots(need ?? '')).slice(0, 15)
        .map(bot => ({ id: bot.id, name: bot.name, ...bot.role ? { role: bot.role } : {}, description: bot.description.slice(0, 160), skills: bot.skills })) })),
    }),
    tool({
      name: 'orchestrator_team_create_bot',
      description: 'Create a Bot for a plan when none fits. Low-risk tools are created at once; high-risk ones wait for a person. Returns existing, pending, or bot.',
      schema: z.object({
        id: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(200).optional(), role: z.string().trim().max(40).optional(),
        skills: z.array(z.string().max(80)).max(20).optional(), tools: z.array(z.string().max(80)).max(20).optional(),
        persona: z.string().trim().min(1).max(4000), plan_id: z.string().trim().optional(),
      }).strict(),
      execute: async ({ plan_id, ...draft }) => refusing(async () => {
        const result = await host.team.createBot({ draft, ...plan_id ? { planId: plan_id } : {} })
        return { ...result, ...result.pending ? { note: 'A person must approve this draft in the panel before the Bot can take steps' } : {} }
      }),
    }),
    tool({
      name: 'orchestrator_team_plan',
      description: `Give work that needs several roles to VsSaros Bots as a plan of steps (at most ${TEAM_PARALLEL} at once). A saved workflow matching goal is reused. after names steps this one waits for; results come back as team_report. plan_id adds steps to a running plan.`,
      schema: z.object({
        goal: z.string().trim().max(500).optional(),
        plan_id: z.string().trim().optional(),
        ticket_id: z.string().trim().optional(),
        steps: z.array(StepSchema).min(1).max(TEAM_STEPS_MAX),
      }).strict(),
      execute: async args => refusing(async () => {
        // VsSaros addition: a request that fits a saved workflow skips planning; its steps run with the saved parameters.
        const hit = args.goal && !args.plan_id ? host.retro.match(args.goal)[0] : undefined
        const workflow = hit ? host.retro.run(hit.id) : undefined
        let steps: StepInput[] = args.steps
        if (workflow) {
          const values = Object.fromEntries(workflow.params.map(param => [param.key, param.value ?? args.goal ?? '']))
          steps = workflow.steps.map(step => ({ ...step, spec: step.spec.replace(/\{\{\s*([\w.-]+)\s*\}\}/g,
            (_match, key: string) => values[key] ?? '') }))
        }
        const plan = await host.team.plan({ steps, ...(workflow ? { goal: workflow.goal } : args.goal ? { goal: args.goal } : {}),
          ...args.plan_id ? { planId: args.plan_id } : {}, ...args.ticket_id ? { ticketId: args.ticket_id } : {} })
        return { ...brief(plan), ...workflow ? { workflow: { id: workflow.id, name: workflow.name, version: workflow.version, score: hit!.score } } : {} }
      }),
    }),
    tool({
      name: 'orchestrator_team_status',
      description: 'Read a plan and its steps, or the latest plans.',
      schema: z.object({ plan_id: z.string().trim().optional() }).strict(),
      execute: async ({ plan_id }) => {
        if (!plan_id) return { plans: host.team.views(5).map(brief) }
        const plan = host.team.view(plan_id)
        return plan ? brief(plan) : { refused: `No plan ${plan_id}` }
      },
    }),
    tool({
      name: 'orchestrator_team_stop',
      description: 'Stop a running plan on a person\'s request; running steps are cancelled.',
      schema: z.object({ plan_id: z.string().trim(), reason: z.string().trim().max(200).optional() }).strict(),
      execute: async ({ plan_id, reason }) => refusing(async () => brief(await host.team.stop(plan_id, reason || 'stopped by the supervisor'))),
    }),
  ]
}
