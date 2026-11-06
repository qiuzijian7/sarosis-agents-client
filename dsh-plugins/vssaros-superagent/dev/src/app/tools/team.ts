/** VsSaros addition: main Session tools for VsSaros Bots — the roster, group chats, and a ticket's team (see `../staffing.ts`). */
import { z } from 'zod'
import { UserError } from '../../core/index.ts'
import { TEAM_STEPS_MAX, TeamError, type Team } from '../team.ts'
import type { Retrospective } from '../retrospective.ts'
import type { Staffing, StaffingProposal } from '../staffing.ts'
import type { Store } from '../store.ts'
import { TEAMFLOW_PHASES } from '../teamflow.ts'
import { groupMadeNotice } from '../groupFastPath.ts'
import { tool, type Tool } from './tool.ts'

export interface TeamToolsHost {
  readonly team: Pick<Team, 'bots' | 'createBot' | 'createGroup'>
  readonly retro: Pick<Retrospective, 'match'>
  /** VsSaros addition (superagent v2, P5): the ticket whose request saved workflows are matched against. */
  readonly store?: Pick<Store, 'tickets' | 'triggers'>
  /** VsSaros addition (2026-11-05): tells the conversation a trigger came from, once per `id` (a notice through the Outbox). */
  tellTrigger?(triggerId: string, id: string, text: string): boolean
}

const KEY = z.string().trim().regex(/^[A-Za-z0-9_-]{1,24}$/, 'letters, digits, _ or -, at most 24')
/** Answers a refused request to the model instead of failing the call. */
async function refusing<T>(run: () => Promise<T>): Promise<T | { refused: string }> {
  try { return await run() }
  catch (error) { if (error instanceof TeamError || error instanceof UserError) return { refused: error.message }; throw error }
}

/** The team tools of the main Session. */
export function teamTools(host: TeamToolsHost): Tool[] {
  return [
    tool({
      name: 'orchestrator_team_bots',
      description: 'List the VsSaros Bots that can take a step, matching need first; with ticket_id, also saved workflows fitting it.',
      schema: z.object({ need: z.string().trim().max(200).optional(), ticket_id: z.string().trim().optional() }).strict(),
      execute: async ({ need, ticket_id }) => {
        // VsSaros addition (superagent v2, P5): saved workflows whose steps fit the ticket's request (≥70%), also when the
        // roster cannot be read.
        const ticket = ticket_id ? host.store?.tickets.get(ticket_id) : undefined
        const request = ticket ? `${ticket.title} ${host.store?.triggers.get(ticket.origin.triggerId)?.text ?? ''}` : ''
        const workflows = request ? host.retro.match(request).slice(0, 3) : []
        const matched = workflows.length ? { workflows, note: 'Pass workflow_id to orchestrator_team_propose to prefill its team.' } : {}
        const roster = await refusing(async () => (await host.team.bots(need ?? '')).slice(0, 15)
          .map(bot => ({ id: bot.id, name: bot.name, ...bot.role ? { role: bot.role } : {}, description: bot.description.slice(0, 160), skills: bot.skills })))
        return 'refused' in roster ? { ...roster, ...matched } : { bots: roster, ...matched }
      },
    }),
    // VsSaros addition (2026-11-05): a group chat of Bots, which a person asked for; it appears in the Bots tab of the sidebar.
    // The Bots plugin checks names, counts and lengths; its first Bot is the admin.
    tool({
      name: 'orchestrator_team_create_group',
      description: 'Make the group chat of Bots a person asked for (建群). bots: 2+ names from orchestrator_team_bots, the first is admin. mode admin: the admin answers and @-calls others; everyone: all answer in turn. An existing group of that name is edited instead: bots become its list (reused, added, removed).',
      schema: z.object({ bots: z.array(z.string()).min(2), name: z.string().optional(), notice: z.string().optional(),
        mode: z.enum(['admin', 'everyone']).optional(), trigger_id: z.string().optional() }).strict(),
      execute: async ({ trigger_id, bots, ...input }) => refusing(async () => {
        const group = await host.team.createGroup({ members: bots, ...input, ...(trigger_id ? { originTriggerId: trigger_id } : {}) })
        const names = group.members.map(bot => bot.name)
        const admin = group.members.find(bot => bot.id === group.admin)?.name
        const notice = trigger_id ? groupMadeNotice(group, trigger_id) : undefined
        const told = trigger_id && notice ? host.tellTrigger?.(trigger_id, notice.id, notice.text) ?? false : false
        return { group: { id: group.id, name: group.name, bots: names, admin: admin ?? null, mode: group.mode,
          ...group.reused ? { reused: true, added: group.added ?? [], removed: group.removed ?? [] } : {} }, told }
      }),
    }),
    tool({
      name: 'orchestrator_team_create_bot',
      description: 'Create a Bot when none fits. Low-risk tools are created at once; high-risk ones wait for a person. Returns existing, pending, or bot.',
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
  ]
}

/**
 * VsSaros addition (superagent v2): a tool the main Session does not get: a Bot is created only as part of a ticket's team
 * a person agreed to (`orchestrator_team_propose`). VsSaros change (2026-11-06): the team plan tools (`orchestrator_team_plan`,
 * `_status`, `_stop`) are removed with the plans themselves (`team-archive.ts`).
 */
export const CONSENTLESS_TOOLS = new Set(['orchestrator_team_create_bot'])

export interface StaffingToolsHost {
  readonly staffing: Pick<Staffing, 'propose' | 'confirm' | 'refuse'>
  /** P5: saved workflows that prefill a proposal. */
  readonly workflows?: Pick<Retrospective, 'prefill'>
}
const DraftSchema = z.object({
  id: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(80), description: z.string().trim().max(200).optional(),
  skills: z.array(z.string().max(80)).max(20).optional(), tools: z.array(z.string().max(80)).max(20).optional(),
  persona: z.string().trim().min(1).max(4000),
}).strict()
const proposalBrief = (proposal: StaffingProposal) => ({ ticket_id: proposal.ticketId, version: proposal.version, state: proposal.state,
  risk: proposal.risk, roles: proposal.roles.map(role => ({ role: role.key, bot: role.bot?.name ?? role.draft?.name, new: !!role.draft })),
  ...proposal.workflow ? { workflow: proposal.workflow.id } : {} })

/**
 * The main Session's tools for a ticket's team: propose a version, and record a person's agreement or refusal. A proposal
 * runs on the default budget (`DEFAULT_BUDGET`); the multi-Bot executor (P3) is where a budget becomes adjustable.
 * VsSaros addition (P5): `workflow_id` prefills the roles and steps a proposal leaves out from a saved workflow.
 */
export function staffingTools(host: StaffingToolsHost): Tool[] {
  return [
    tool({
      name: 'orchestrator_team_propose',
      description: 'Propose, or revise, the team of a ticket in person/staffing: each role is an existing bot or a new bot draft; workflow_id prefills what you omit. The person must agree.',
      schema: z.object({
        ticket_id: z.string().trim().min(1),
        workflow_id: z.string().trim().optional(),
        roles: z.array(z.object({ key: KEY, need: z.string().trim().min(1).max(200), bot: z.string().trim().min(1).max(120).optional(),
          draft: DraftSchema.optional() }).strict()).min(1).max(TEAM_STEPS_MAX).optional(),
        steps: z.array(z.object({ key: KEY, role: KEY, title: z.string().trim().min(1).max(120), spec: z.string().trim().min(1).max(4000),
          after: z.array(KEY).max(TEAM_STEPS_MAX).optional(), access: z.enum(['read', 'write']).optional(),
          phase: z.enum(TEAMFLOW_PHASES).optional() }).strict()).min(1).max(TEAM_STEPS_MAX).optional(),
      }).strict(),
      execute: async ({ ticket_id, workflow_id, roles, steps }) => refusing(async () => {
        const prefilled = workflow_id ? host.workflows?.prefill(workflow_id) : undefined
        if (workflow_id && !prefilled) throw new TeamError('Saved workflows are not available here')
        const chosen = { roles: roles ?? prefilled?.roles, steps: steps ?? prefilled?.steps }
        if (!chosen.roles || !chosen.steps) throw new TeamError('Give roles and steps, or a workflow_id that prefills them')
        const unstaffed = chosen.roles.filter(role => !role.bot && !('draft' in role && role.draft)).map(role => role.key)
        if (unstaffed.length) throw new TeamError(`Roles ${unstaffed.join(', ')} have no Bot yet; pass roles with a bot or draft for each`)
        const proposal = await host.staffing.propose({ ticketId: ticket_id, roles: chosen.roles, steps: chosen.steps,
          ...prefilled ? { workflow: prefilled.workflow } : {} })
        return { ...proposalBrief(proposal), note: proposal.state === 'approved' ? 'Agreed automatically under the low-risk setting; the worker starts.'
          : 'Sent to the person. Their reply comes to you as a follow_up: agree with orchestrator_team_confirm, refuse with orchestrator_team_refuse, or propose again.' }
      }),
    }),
    tool({
      name: 'orchestrator_team_confirm',
      description: 'Record a listed person\'s agreement in trigger_id to this version of a ticket\'s team; drafted Bots are created and the worker starts.',
      schema: z.object({ ticket_id: z.string().trim().min(1), trigger_id: z.string().trim().min(1), version: z.number().int().min(1) }).strict(),
      execute: async ({ ticket_id, trigger_id, version }) => refusing(async () => proposalBrief(await host.staffing.confirm(ticket_id, trigger_id, version))),
    }),
    tool({
      name: 'orchestrator_team_refuse',
      description: 'Record a listed person\'s refusal in trigger_id of a ticket\'s team; the ticket ends as dropped.',
      schema: z.object({ ticket_id: z.string().trim().min(1), trigger_id: z.string().trim().min(1), reason: z.string().trim().max(200).optional() }).strict(),
      execute: async ({ ticket_id, trigger_id, reason }) => refusing(async () => {
        const proposal = host.staffing.refuse(ticket_id, { triggerId: trigger_id }, reason)
        return { ticket_id, state: 'dropped', ...proposal ? { version: proposal.version } : {} }
      }),
    }),
  ]
}
