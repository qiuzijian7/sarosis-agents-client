/**
 * VsSaros addition (superagent v2, P2): a ticket's team staffing. Every accepted ticket waits in `person/staffing` until a
 * person agrees to the team the main Session proposed: which Bots (existing ones, or drafts of new ones), which steps with
 * which dependencies and access, and the budget. Each proposal is a version with a fingerprint of its content, sent to the
 * conversation the ticket started in; only a listed person's own message on one of the ticket's Threads, written after
 * that version was sent, agrees to it or refuses it. Agreeing creates the drafted Bots and starts the worker with the
 * agreed team as its first note; refusing ends the ticket as `dropped`.
 */
import { createHash } from 'node:crypto'
import { liveTicket, reached, staffing, type Engine, type OutboundMessage, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, type Settings } from '../policy.ts'
import type { Store } from './store.ts'
import { HIGH_RISK_TOOLS, TEAM_BOTS_PER_PLAN, TEAM_STEPS_MAX, TeamError, type BotCard, type BotDraft, type Team } from './team.ts'

/** One role of a proposal: what it needs, and the existing Bot or the draft of a new Bot that fills it. */
/** VsSaros addition (2026-11-06): `bot.tools`, the Bot's own tools as the roster listed them, for its steps' tool set. */
export interface StaffingRole { key: string; need: string; bot?: { id: string; name: string; tools?: string[] }; draft?: BotDraft }
/** One step: the role that does it, the steps it waits for, and whether it writes in the ticket's directory. */
export interface StaffingStep { key: string; role: string; title: string; spec: string; after: string[]; access: 'read' | 'write'; phase?: string }
export interface StaffingBudget { tokens: number; turns: number; parallel: number }
export interface StaffingProposal {
  ticketId: string; version: number; fingerprint: string; goal: string
  roles: StaffingRole[]; steps: StaffingStep[]; budget: StaffingBudget
  risk: { newBots: number; highRiskTools: string[]; writeSteps: number }
  state: 'proposed' | 'superseded' | 'approved' | 'rejected'
  at: string; decidedBy?: string; decidedAt?: string; triggerId?: string; reason?: string
  /** P5: the saved workflow this team was prefilled from, which the ticket's end credits. */
  workflow?: { id: string; name: string; version: number }
}
/** What the main Session proposes; the Bots are named by id or name and resolved against the roster. */
export interface ProposalInput {
  ticketId: string
  roles: { key: string; need: string; bot?: string; draft?: BotDraft }[]
  steps: { key: string; role: string; title: string; spec: string; after?: string[]; access?: 'read' | 'write'; phase?: string }[]
  budget?: Partial<StaffingBudget>
  workflow?: { id: string; name: string; version: number }
}
export const DEFAULT_BUDGET: StaffingBudget = { tokens: 300_000, turns: 90, parallel: 3 }

const now = () => new Date().toISOString()
const KEY = /^[A-Za-z0-9_-]{1,24}$/
const fingerprintOf = (proposal: Pick<StaffingProposal, 'goal' | 'roles' | 'steps' | 'budget'>) =>
  `sha256:${createHash('sha256').update(JSON.stringify([proposal.goal, proposal.roles, proposal.steps, proposal.budget])).digest('hex').slice(0, 32)}`

/** Proposals by ticket and version in the orchestrator database. */
export class StaffingStore {
  constructor(private readonly store: Pick<Store, 'db'>) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS team_proposal (ticket TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
      value TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (ticket, version))`)
  }
  save(proposal: StaffingProposal): void {
    this.store.db.prepare('INSERT INTO team_proposal VALUES (?,?,?,?,?) ON CONFLICT(ticket, version) DO UPDATE SET state=excluded.state, value=excluded.value')
      .run(proposal.ticketId, proposal.version, proposal.state, JSON.stringify(proposal), proposal.at)
  }
  latest(ticketId: string): StaffingProposal | undefined {
    const row = this.store.db.prepare('SELECT value FROM team_proposal WHERE ticket=? ORDER BY version DESC LIMIT 1').get(ticketId)
    return row ? JSON.parse(String(row.value)) as StaffingProposal : undefined
  }
  versions(ticketId: string): StaffingProposal[] {
    return this.store.db.prepare('SELECT value FROM team_proposal WHERE ticket=? ORDER BY version').all(ticketId)
      .map(row => JSON.parse(String(row.value)) as StaffingProposal)
  }
}

export interface StaffingHost {
  store: Pick<Store, 'db' | 'tickets' | 'triggers' | 'threads' | 'settings' | 'atomic'>
  engine: Pick<Engine, 'staffingProposed' | 'approveStaffing' | 'rejectStaffing' | 'note'>
  team: Pick<Team, 'available' | 'bots' | 'createAgreed'>
  outbox: { send(message: OutboundMessage): void }
  /** P3: the team's steps, written in the transaction that agrees to it. */
  steps?: { plan(proposal: StaffingProposal): void }
}

/**
 * Proposes, agrees to and refuses a ticket's team. The main Session's tools and the panel call it; the consent rules are
 * enforced here, not by the model.
 */
export class Staffing {
  readonly tables: StaffingStore
  constructor(private readonly host: StaffingHost) { this.tables = new StaffingStore(host.store) }

  /** The current proposal of every open ticket that waits for its team, newest ticket first. */
  waiting(): { ticket: { id: string; title: string; state: string }; proposal?: StaffingProposal }[] {
    return this.host.store.tickets.open().filter(staffing)
      .map(ticket => ({ ticket: { id: ticket.id, title: ticket.title, state: ticket.team!.state }, proposal: this.tables.latest(ticket.id) }))
  }

  /**
   * Records version n+1 of a ticket's team, which supersedes every earlier one, sends it to the conversation the ticket
   * started in, and agrees to it at once only when a person switched auto-approval on and it is low-risk.
   * @throws TeamError for an invalid proposal (unknown Bot, cycle, too many steps or drafts) or a ticket that no longer waits.
   */
  async propose(input: ProposalInput): Promise<StaffingProposal> {
    const ticket = this.ticket(input.ticketId)
    const roster = this.host.team.available() ? await this.host.team.bots() : undefined
    const roles = input.roles.map(role => this.role(role, roster))
    const steps = this.steps(input.steps, roles)
    const budget = { ...DEFAULT_BUDGET, ...input.budget }
    const drafts = roles.filter(role => role.draft)
    if (drafts.length > TEAM_BOTS_PER_PLAN) throw new TeamError(`A ticket may create at most ${TEAM_BOTS_PER_PLAN} Bots`)
    const risk = { newBots: drafts.length, writeSteps: steps.filter(step => step.access === 'write').length,
      highRiskTools: [...new Set(drafts.flatMap(role => (role.draft!.tools ?? []).filter(tool => HIGH_RISK_TOOLS.test(tool))))] }
    const previous = this.tables.latest(ticket.id)
    const body = { goal: ticket.title, roles, steps, budget }
    const proposal: StaffingProposal = { ticketId: ticket.id, version: (previous?.version ?? 0) + 1, fingerprint: fingerprintOf(body),
      ...body, risk, state: 'proposed', at: now(), ...input.workflow ? { workflow: input.workflow } : {} }
    this.host.store.atomic(() => {
      for (const earlier of this.tables.versions(ticket.id)) if (earlier.state === 'proposed') this.tables.save({ ...earlier, state: 'superseded' })
      this.tables.save(proposal)
      this.host.engine.staffingProposed(ticket.id, proposal.version, proposal.fingerprint)
    })
    const settings = this.host.store.settings()
    const automatic = settings.executor.autoApprove && ticket.mandate.strength === 'explicit'
      && !risk.newBots && !risk.writeSteps && !risk.highRiskTools.length
      && budget.tokens <= DEFAULT_BUDGET.tokens && budget.turns <= DEFAULT_BUDGET.turns && budget.parallel <= DEFAULT_BUDGET.parallel
    this.send(ticket, proposal, automatic)
    return automatic ? await this.agree(ticket.id, proposal, 'auto') : proposal
  }

  /**
   * A listed person agreed in `triggerId` to version `version`: creates the drafted Bots, gives the worker the agreed team
   * and starts it.
   * @throws TeamError when the message cannot agree (see `consent`) or names an earlier version.
   */
  async confirm(ticketId: string, triggerId: string, version: number): Promise<StaffingProposal> {
    const ticket = this.ticket(ticketId)
    const proposal = this.current(ticket, version)
    const trigger = this.consent(ticket, proposal, triggerId)
    return this.agree(ticket.id, proposal, trigger.actor.id, trigger.id)
  }
  /** A person in the panel (the person at this machine) agreed to version `version`. */
  async approveFromPanel(ticketId: string, version: number): Promise<StaffingProposal> {
    const ticket = this.ticket(ticketId)
    return this.agree(ticket.id, this.current(ticket, version), 'panel')
  }
  /** A listed person refused the ticket's team in `triggerId`, or a person in the panel did: the ticket ends as `dropped`. */
  refuse(ticketId: string, by: { triggerId: string } | 'panel', reason?: string): StaffingProposal | undefined {
    const ticket = this.ticket(ticketId)
    const proposal = this.tables.latest(ticket.id)
    const trigger = by === 'panel' ? undefined : this.consent(ticket, proposal, by.triggerId)
    const why = reason?.trim() || 'a person refused the team'
    this.host.store.atomic(() => {
      if (proposal) this.tables.save({ ...proposal, state: 'rejected', decidedBy: trigger?.actor.id ?? 'panel', decidedAt: now(), reason: why,
        ...trigger ? { triggerId: trigger.id } : {} })
      this.host.engine.rejectStaffing(ticket.id, why)
    })
    return this.tables.latest(ticket.id)
  }

  private async agree(ticketId: string, proposal: StaffingProposal, by: string, triggerId?: string): Promise<StaffingProposal> {
    // Drafted Bots first: a failure leaves the ticket waiting, and agreeing again finds the Bots already created.
    const roles: StaffingRole[] = []
    for (const role of proposal.roles) {
      if (!role.draft) { roles.push(role); continue }
      const bot = await this.host.team.createAgreed(role.draft, ticketId)
      roles.push({ ...role, bot: { id: bot.id, name: bot.name } })
    }
    const agreed: StaffingProposal = { ...proposal, roles, state: 'approved', decidedBy: by, decidedAt: now(), ...triggerId ? { triggerId } : {} }
    this.host.store.atomic(() => {
      this.tables.save(agreed)
      // P3: the steps of the agreed team, which their Bots start once the ticket's lead runs.
      this.host.steps?.plan(agreed)
      this.host.engine.note(ticketId, teamNote(agreed))
      this.host.engine.approveStaffing(ticketId, proposal.version, proposal.fingerprint, by, triggerId)
    })
    return agreed
  }
  /**
   * The rules a message must meet to agree to or refuse a team: a person's (never a Bot's), on the Source's list, on one of
   * the ticket's Threads, and written after the proposal it answers was sent.
   */
  private consent(ticket: Ticket, proposal: StaffingProposal | undefined, triggerId: string): Trigger {
    const { store } = this.host
    const trigger = store.triggers.get(triggerId)
    const refuse = (why: string): never => { throw new TeamError(`Only a listed person's own message, sent on one of the ticket's threads after the proposal, can agree to or refuse a team; ${why}`) }
    if (!trigger) return refuse(`no message ${triggerId}`)
    if (!trigger.human) return refuse('this message is a bot\'s')
    if (!allowedSender(store.settings() as Settings, trigger.actor)) return refuse(`${trigger.actor.id} is not on the ${trigger.source} list`)
    if (!reached(ticket, trigger, key => store.threads.get(key), false)) return refuse('this message is not on the ticket\'s threads')
    // Compare on the host's clock: when the host received the message, not the time its Source stamped on it.
    const received = store.triggers.disposition(trigger.id)?.at ?? trigger.at
    if (proposal && Date.parse(received) < Date.parse(proposal.at)) return refuse(`it was received before version ${proposal.version} was sent`)
    return trigger
  }
  private current(ticket: Ticket, version: number): StaffingProposal {
    const proposal = this.tables.latest(ticket.id)
    if (!proposal || proposal.state !== 'proposed') throw new TeamError('This ticket has no team proposal waiting for a person')
    if (proposal.version !== version) throw new TeamError(`The current proposal is version ${proposal.version}; version ${version} no longer counts`)
    return proposal
  }
  private ticket(ticketId: string): Ticket {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) throw new TeamError(`No ticket ${ticketId}`)
    if (!liveTicket(ticket)) throw new TeamError(`Ticket ${ticketId} has ended`)
    if (!staffing(ticket)) throw new TeamError(`Ticket ${ticketId} does not wait for its team`)
    return ticket
  }
  private role(input: ProposalInput['roles'][number], roster: BotCard[] | undefined): StaffingRole {
    if (!KEY.test(input.key)) throw new TeamError(`Role key ${input.key}: letters, digits, _ or -, at most 24`)
    if (!!input.bot === !!input.draft) throw new TeamError(`Role ${input.key} needs exactly one of bot or draft`)
    if (input.draft) return { key: input.key, need: input.need, draft: input.draft }
    const name = input.bot!.trim()
    const card = roster?.find(item => item.id === name || item.name === name)
    if (roster && !card) throw new TeamError(`No Bot ${name} in the roster; read orchestrator_team_bots, or draft a new one`)
    return { key: input.key, need: input.need, bot: card ? { id: card.id, name: card.name, tools: [...card.tools ?? []] } : { id: name, name } }
  }
  private steps(input: ProposalInput['steps'], roles: StaffingRole[]): StaffingStep[] {
    if (!input.length || input.length > TEAM_STEPS_MAX) throw new TeamError(`A team has 1 to ${TEAM_STEPS_MAX} steps`)
    const keys = new Set<string>()
    const steps = input.map(step => {
      if (!KEY.test(step.key) || keys.has(step.key)) throw new TeamError(`Step key ${step.key} is invalid or repeated`)
      keys.add(step.key)
      if (!roles.some(role => role.key === step.role)) throw new TeamError(`Step ${step.key} names no role ${step.role}`)
      return { key: step.key, role: step.role, title: step.title, spec: step.spec, after: step.after ?? [], access: step.access ?? 'read',
        ...step.phase ? { phase: step.phase } : {} }
    })
    for (const step of steps) for (const after of step.after) if (!keys.has(after)) throw new TeamError(`Step ${step.key} waits for no step ${after}`)
    // Reject a cycle: every step must be reachable from those that wait for nothing.
    const done = new Set<string>()
    for (let round = 0; round < steps.length && done.size < steps.length; round += 1) {
      for (const step of steps) if (!done.has(step.key) && step.after.every(key => done.has(key))) done.add(step.key)
    }
    if (done.size < steps.length) throw new TeamError('The steps wait for each other in a cycle')
    return steps
  }
  /** Sends a proposal to the conversation the ticket started in, once per version. */
  private send(ticket: Ticket, proposal: StaffingProposal, automatic: boolean): void {
    const channel = this.host.store.triggers.get(ticket.origin.triggerId)?.channel ?? ticket.channels[0]
    if (!channel) return
    this.host.outbox.send({ id: `team-proposal:${ticket.id}:v${proposal.version}`, channel, kind: 'notice', ticketId: ticket.id,
      text: proposalText(proposal, automatic) })
  }
}

const roleLabel = (role: StaffingRole) => role.draft
  ? `${role.draft.name}（新建${role.draft.tools?.some(tool => HIGH_RISK_TOOLS.test(tool)) ? ` · 申请 ${role.draft.tools.filter(tool => HIGH_RISK_TOOLS.test(tool)).join('、')}` : ''}）`
  : `${role.bot?.name ?? role.key}（现有）`
const budgetLabel = (budget: StaffingBudget) => `${Math.round(budget.tokens / 10_000)} 万 tokens · ${budget.turns} 回合 · 并行 ${budget.parallel}`

/** The proposal as a person reads it in the conversation: one line for a one-step team, a short block otherwise. */
export function proposalText(proposal: StaffingProposal, automatic = false): string {
  const answer = automatic ? '已按设置自动同意（低风险）；要停止就回复「取消」。'
    : '回复「同意」开始执行；直接写修改意见会出新版本；回复「取消」放弃这张工单。'
  const from = proposal.workflow ? `按已保存的团队工作流「${proposal.workflow.name}」v${proposal.workflow.version} 预填。\n` : ''
  if (proposal.steps.length === 1 && proposal.roles.length === 1) {
    const [step] = proposal.steps, [role] = proposal.roles
    return `【组队方案 v${proposal.version}】由 ${roleLabel(role!)}处理：${proposal.goal} · ${step!.access === 'write' ? '写' : '只读'} · 预算 ${budgetLabel(proposal.budget)}。\n${from}${answer}`
  }
  const steps = proposal.steps.map(step => `${step.key} ${step.title}${step.access === 'write' ? '（写）' : ''}${step.after.length ? `（等 ${step.after.join('、')}）` : ''}`)
  return [`【组队方案 v${proposal.version}】${proposal.goal}`, ...from ? [from.trim()] : [], `成员：${proposal.roles.map(roleLabel).join('、')}`,
    `步骤：${steps.join(' → ')}`, `预算：${budgetLabel(proposal.budget)}`, answer].join('\n')
}

/** The agreed team as the lead's first note: the Bots do the steps in Sessions of their own; the lead integrates and reports. */
export function teamNote(proposal: StaffingProposal): string {
  const who = (key: string) => { const role = proposal.roles.find(item => item.key === key); return role?.bot?.name ?? role?.draft?.name ?? key }
  return [`A person agreed to team proposal v${proposal.version} for this ticket (${proposal.decidedBy}). You lead it: each step below is done by its Bot in a Session of its own, not by you.`,
    ...proposal.steps.map(step => `- ${step.key} ${step.title} · ${who(step.role)} · ${step.access}${step.after.length ? ` · after ${step.after.join(', ')}` : ''}: ${step.spec}`),
    'Each step\'s end reaches you as a note. Answer people, ask them what a step needs and pass their answer with orchestrator_step_message.',
    'Once every step finished, check the results and report the ticket with orchestrator_report; until then end your turns without doing the steps yourself.'].join('\n')
}
