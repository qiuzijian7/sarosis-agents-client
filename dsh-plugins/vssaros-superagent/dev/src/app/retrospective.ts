/**
 * VsSaros addition: reusable team workflows. A ticket whose agreed team succeeded leaves a draft workflow; a person saves it,
 * and a later request it fits prefills a new team proposal from it (superagent v2, P5). Workflows also go to and come from
 * TeamFlow.
 *
 * VsSaros change (2026-11-06, P1 · one track): the skills a finished team plan wrote by template (`onPlanEnd`,
 * `team_skill`) are retired with the plans; skills are written only through `team_distill` → the VsSaros memory system
 * (`distill.ts`). The old records are kept read-only in `team_archive` (`team-archive.ts`).
 */
import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'
import { TeamError } from './team.ts'
import type { Ticket } from '../core/index.ts'
import type { StaffingProposal } from './staffing.ts'
import { exportToTeamflow, importFromTeamflow, type TeamflowExport, type TeamflowPlace } from './teamflow.ts'

/** A saved workflow is reused when this much of the new request's words its name and steps cover. */
export const WORKFLOW_MATCH_THRESHOLD = 0.7
const now = () => new Date().toISOString()

export interface WorkflowParam { key: string; label: string; value?: string }
/**
 * A step of a workflow. VsSaros addition (superagent v2, P5): a workflow from a ticket's agreed team also names the step's
 * role, its access, and the TeamFlow phase it maps to.
 */
export interface WorkflowStep { key: string; title: string; spec: string; bot: string; after: string[]; role?: string; access?: 'read' | 'write'; phase?: string }
/** A role of a workflow from a ticket's team: what it needs, and the Bot that filled it, which a new team may change. */
export interface WorkflowRole { key: string; need: string; bot?: { id: string; name: string } }
export interface TeamWorkflow {
  id: string; name: string; version: number; fromPlanId: string; goal: string; state: 'draft' | 'saved'
  params: WorkflowParam[]; steps: WorkflowStep[]; gates: string[]; budget: { tokens: number; turns: number; parallel: number }
  triggers: string[]; runs: number; ok: number; at: string
  /** VsSaros addition (superagent v2, P5): where it came from (a team plan, a ticket's agreed team, or TeamFlow). */
  source?: 'plan' | 'ticket' | 'teamflow'
  fromTicketId?: string
  roles?: WorkflowRole[]
  /** Its exports into TeamFlow workspaces, newest last. */
  exports?: TeamflowExport[]
  /** The tickets whose agreed teams reused it, already counted in `runs` and `ok`. */
  creditedTickets?: string[]
}
/** How well a saved workflow fits a new request. */
export interface WorkflowMatch { id: string; name: string; version: number; score: number }

/** Words of a string: latin/digit runs and Chinese bigrams, so either language can be compared. */
export function words(text: string): string[] {
  const lower = String(text ?? '').toLowerCase()
  const latin = lower.match(/[a-z0-9_-]{2,}/g) ?? []
  const han = lower.match(/[\u3400-\u9fff]/g) ?? []
  const grams = han.slice(1).map((ch, i) => han[i] + ch)
  return [...new Set([...latin, ...grams])]
}
/** How much of `a` is covered by `b` (0..1); a short request against a long workflow name still scores fairly. */
export function coverage(a: string, b: string): number {
  const left = words(a), right = new Set(words(b))
  if (!left.length || !right.size) return 0
  return left.filter(word => right.has(word)).length / left.length
}

/** The `team_workflow` table this module owns. */
export class RetroStore {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS team_workflow (id TEXT PRIMARY KEY, state TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_workflow_state ON team_workflow(state, at);
    `)
  }
  saveWorkflow(workflow: TeamWorkflow): void {
    this.store.db.prepare('INSERT INTO team_workflow VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, value=excluded.value')
      .run(workflow.id, workflow.state, JSON.stringify(workflow), workflow.at)
  }
  workflow(id: string): TeamWorkflow | undefined { return this.row('team_workflow', id) as TeamWorkflow | undefined }
  workflows(state?: TeamWorkflow['state']): TeamWorkflow[] { return this.rows('team_workflow', state) as TeamWorkflow[] }
  private row(table: string, id: string): unknown {
    const found = this.store.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id)
    return found ? JSON.parse(String(found.value)) : undefined
  }
  private rows(table: string, state?: string): unknown[] {
    const found = state
      ? this.store.db.prepare(`SELECT value FROM ${table} WHERE state=? ORDER BY at`).all(state)
      : this.store.db.prepare(`SELECT value FROM ${table} ORDER BY at`).all()
    return found.map(row => JSON.parse(String(row.value)))
  }
}

/** What the Retrospective needs from the Runtime. */
export interface RetroHost {
  readonly store: Pick<Store, 'db' | 'atomic'>
  warn(message: string): void
}

/**
 * Keeps reusable team workflows: drafts from tickets' agreed teams, saved by a person, matched against new requests and
 * turned into proposals, exported to and imported from TeamFlow.
 */
export class Retrospective {
  readonly tables: RetroStore
  constructor(private readonly host: RetroHost) { this.tables = new RetroStore(host.store) }

  /** A person confirms the draft; only saved workflows are matched against new requests. */
  saveWorkflow(id: string): TeamWorkflow {
    const workflow = this.tables.workflow(id)
    if (!workflow) throw new TeamError(`No workflow ${id}`)
    const saved = { ...workflow, state: 'saved' as const, version: Math.max(1, workflow.version) }
    this.tables.saveWorkflow(saved)
    return saved
  }
  /** Workflows whose names and steps cover the new request, best first. */
  match(request: string): WorkflowMatch[] {
    return this.tables.workflows('saved').map(workflow => ({ id: workflow.id, name: workflow.name, version: workflow.version,
      score: Math.round(coverage(request, `${workflow.name} ${workflow.goal} ${workflow.steps.map(step => step.title).join(' ')}`) * 100) }))
      .filter(hit => hit.score >= WORKFLOW_MATCH_THRESHOLD * 100).sort((a, b) => b.score - a.score)
  }
  // VsSaros addition (superagent v2, P5): workflows of tickets' agreed teams.

  /**
   * A ticket with an agreed team ended. A team that came from a saved workflow credits that workflow with the run and
   * whether it succeeded; any other team that succeeded (completed or merged) leaves a draft workflow a person may save.
   * Idempotent per ticket.
   */
  onTicketEnd(ticket: Ticket, proposal: StaffingProposal | undefined, request?: string): TeamWorkflow | undefined {
    if (!ticket.ended || !proposal || proposal.state !== 'approved') return undefined
    const success = ticket.ended.outcome === 'completed' || ticket.ended.outcome === 'merged'
    if (proposal.workflow) {
      const used = this.tables.workflow(proposal.workflow.id)
      if (!used || used.creditedTickets?.includes(ticket.id)) return used
      const runs = used.runs + 1
      const credited = { ...used, runs, ok: Math.round((used.ok * used.runs + (success ? 100 : 0)) / runs),
        creditedTickets: [...(used.creditedTickets ?? []), ticket.id].slice(-50) }
      this.tables.saveWorkflow(credited)
      return credited
    }
    if (!success || this.tables.workflows().some(workflow => workflow.fromTicketId === ticket.id)) return undefined
    const roles = proposal.roles.map(role => ({ key: role.key, need: role.need,
      ...role.bot ? { bot: role.bot } : role.draft ? { bot: { id: role.draft.id, name: role.draft.name } } : {} }))
    // The request it was made for is what a later request is matched against; the title alone is too short to match on.
    const goal = (request?.trim() || ticket.title).slice(0, 500)
    const draft: TeamWorkflow = { id: `wf-${randomUUID().slice(0, 8)}`, name: ticket.title.slice(0, 60), version: 1, fromPlanId: '',
      source: 'ticket', fromTicketId: ticket.id, goal, state: 'draft', params: [{ key: 'goal', label: '目标' }],
      roles, steps: proposal.steps.map(step => ({ key: step.key, title: step.title, spec: step.spec, after: step.after, role: step.role,
        access: step.access, bot: roles.find(role => role.key === step.role)?.bot?.name ?? step.role, ...step.phase ? { phase: step.phase } : {} })),
      gates: [], budget: proposal.budget, triggers: ['manual'], runs: 1, ok: 100, at: now() }
    this.tables.saveWorkflow(draft)
    return draft
  }
  /**
   * A saved workflow as the roles and steps of a new proposal. A role keeps the Bot that filled it last time; a role with
   * none (as from TeamFlow) comes back without one, for the main Session to staff.
   */
  prefill(id: string): { workflow: { id: string; name: string; version: number }
    roles: { key: string; need: string; bot?: string }[]; steps: { key: string; role: string; title: string; spec: string; after: string[]; access: 'read' | 'write'; phase?: string }[] } {
    const workflow = this.tables.workflow(id)
    if (!workflow) throw new TeamError(`No workflow ${id}`)
    if (workflow.state !== 'saved') throw new TeamError(`Workflow ${id} is a draft; a person saves it before it is reused`)
    const roles = workflow.roles?.length ? workflow.roles.map(role => ({ key: role.key, need: role.need, ...role.bot ? { bot: role.bot.id } : {} }))
      : [...new Set(workflow.steps.map(step => step.bot))].map((bot, i) => ({ key: `r${i + 1}`, need: bot, ...bot ? { bot } : {} }))
    const roleOf = (step: WorkflowStep) => step.role ?? roles.find(role => role.bot === step.bot)?.key ?? roles[0]!.key
    return { workflow: { id: workflow.id, name: workflow.name, version: workflow.version }, roles,
      steps: workflow.steps.map(step => ({ key: step.key, role: roleOf(step), title: step.title, spec: step.spec, after: step.after,
        access: step.access ?? 'read', ...step.phase ? { phase: step.phase } : {} })) }
  }
  /** Writes a workflow into a TeamFlow workspace as the team `sa-<id>`, and records the export on it. */
  exportTeamflow(id: string, place: TeamflowPlace): TeamflowExport {
    const workflow = this.tables.workflow(id)
    if (!workflow) throw new TeamError(`No workflow ${id}`)
    let record: TeamflowExport
    try { record = exportToTeamflow(workflow, place) } catch (error) { throw new TeamError((error as Error).message) }
    this.tables.saveWorkflow({ ...workflow, exports: [...(workflow.exports ?? []), record].slice(-10) })
    return record
  }
  /** TeamFlow's teams in a workspace as draft workflows; a team imported before is not imported again. */
  importTeamflow(place: TeamflowPlace): TeamWorkflow[] {
    let seeds: TeamWorkflow[]
    try { seeds = importFromTeamflow(place).seeds } catch (error) { throw new TeamError((error as Error).message) }
    const added = seeds.filter(seed => !this.tables.workflow(seed.id))
    for (const seed of added) this.tables.saveWorkflow(seed)
    return added
  }
}
