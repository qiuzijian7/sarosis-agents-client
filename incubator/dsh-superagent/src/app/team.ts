/**
 * VsSaros addition: team plans of the main Session (the supervisor). A plan is a goal split into steps, each given to a VsSaros Bot;
 * a step runs once the steps it waits for are done, at most `TEAM_PARALLEL` at a time per plan. The Bots run the steps through the
 * in-process team bus of vssaros-agents (`Symbol.for('vssaros.team')`), which reports each one when its Bot's turn ends; the report
 * reaches the main Session as a relay, so it can add steps, ask a person, or answer the request.
 *
 * Plans, steps, the Bots taking part, every exchange, the Bots the supervisor created and the drafts waiting for a person are
 * kept in `team_*` tables of the orchestrator database (prefixed so an old database's schema 6 `task` table is never reused).
 */
import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'

/** At most this many steps of one plan run at once. */
export const TEAM_PARALLEL = 3
/** At most this many Bots the supervisor may create for one plan, and in total. */
export const TEAM_BOTS_PER_PLAN = 3
export const TEAM_BOTS_GLOBAL = 20
/** At most this many steps in one plan, counting those added later. */
export const TEAM_STEPS_MAX = 12
/** Tool names whose draft needs a person's approval before the Bot is created. */
export const HIGH_RISK_TOOLS = /^(bash|pwsh|shell|exec|terminal|git|feishu|im|mail|email|webhook|http|fetch|network|credential|secret|write|deploy|publish|send)/i
/** An exchange chain of one step (give, report, give again…) stops at this many hops. */
export const TEAM_HOPS_MAX = 6
/** A report kept on a step and relayed to the main Session is cut at this many characters; the Bot's session has it all. */
const REPORT_KEEP = 2000

/** A Bot as the team bus lists it. */
export interface BotCard {
  id: string; name: string; role?: string; description: string; skills: string[]; tools: string[]
  delegatable: boolean; source: 'builtin' | 'custom'; origin?: 'supervisor'
}
/** A draft the supervisor asks the Bots plugin to write into its roster. */
export interface BotDraft {
  id: string; name: string; description?: string; role?: string; skills?: string[]; tools?: string[]; persona: string
}
/** A Bot the supervisor created, kept in the team tables for quota and display. */
export interface CreatedBot extends BotDraft { planId?: string; preset: string; file: string; at: string }
/** A high-risk Bot draft waiting for a person in the panel. */
export interface BotApproval {
  id: string; planId?: string; draft: BotDraft; risk: string[]; state: 'pending' | 'approved' | 'rejected'; at: string; decidedAt?: string
}
/** The Bots plugin creates the Bot; unavailable in older versions of vssaros-agents. */
export interface CreatedBotView { id: string; name: string; preset: string; file: string }
/** One assignment of a step to a Bot, as the team bus reports it. */
export interface AssignmentView {
  id: string; botId: string; botName: string; sessionId: string
  status: 'running' | 'done' | 'cancelled'; report: string | null; error: string | null
}
/** The in-process team bus of vssaros-agents (0.2.319+); duck-typed so this package does not depend on the Bots package. */
export interface TeamBus {
  version: 1
  available(): boolean
  listBots(): Promise<BotCard[]>
  delegate(input: { bot: string; task: string; cwd?: string; fromName?: string }): Promise<AssignmentView>
  createBot?(input: { draft: BotDraft }): Promise<CreatedBotView>
  /** VsSaros addition: an external Bot in the Bots roster whose Session is owned by this plugin. */
  registerExternalBot?(spec: { id: string; name: string; role?: string; description?: string; icon?: string
    onMessage: (message: { from: string | null; text: string; hop: number; session?: string }) => void | Promise<void> }): () => void
  get(id: string): Promise<AssignmentView | undefined>
  cancel(id: string, reason?: string): Promise<AssignmentView>
  subscribe(listener: (view: AssignmentView) => void | Promise<void>): () => void
}
export const TEAM_BUS_KEY = Symbol.for('vssaros.team')
/** Only one Team in a process may consume the bus's reports; a hot reload disposes the previous subscriber first. */
const TEAM_SUBSCRIPTION_KEY = Symbol.for('vssaros.team.subscription')
/** The team bus when vssaros-agents runs in this Host, in the shape it publishes. */
export function sharedTeamBus(root: object = globalThis): TeamBus | undefined {
  const bus = (root as Record<symbol, Partial<TeamBus> | undefined>)[TEAM_BUS_KEY]
  return bus && bus.version === 1 && typeof bus.delegate === 'function' && typeof bus.subscribe === 'function'
    && typeof bus.available === 'function' ? bus as TeamBus : undefined
}

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'
export interface TeamStep {
  id: string; planId: string; title: string; spec: string; bot: string; after: string[]; state: StepState
  hop: number; /** Attempts, when a step was given again after a failure. */ att?: number
  assignmentId?: string; sessionId?: string; botId?: string; botName?: string
  report?: string; error?: string; startedAt?: string; endedAt?: string
}
export type PlanStatus = 'running' | 'done' | 'failed' | 'cancelled'
export interface TeamPlan { id: string; goal: string; ticketId?: string; cwd?: string; status: PlanStatus; createdAt: string; endedAt?: string }
export type ExchangeKind = 'give' | 'report' | 'failed' | 'cancel' | 'system'
export interface TeamExchange { seq: number; planId: string; stepId?: string; hop: number; from: string; to: string; kind: ExchangeKind; text: string; at: string }
/** A plan with its steps, Bots and exchanges, as the panel and the main Session read it. */
export interface PlanView extends TeamPlan { steps: TeamStep[]; bots: string[]; exchanges: TeamExchange[]; running: number }
/** A step as the main Session describes it; `after` names other steps of the same call or of the plan by `key`. */
export interface StepInput { key: string; title: string; spec: string; bot: string; after?: string[] }

/** A plan the main Session cannot make or change as given; answered to it with the reason. */
export class TeamError extends Error {}

const now = () => new Date().toISOString()
const SUPERVISOR = 'SuperAgent'

/** The four team tables in the orchestrator database; the Store opens the database and owns its transactions. */
export class TeamStore {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS team_plan (id TEXT PRIMARY KEY, status TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_task (id TEXT PRIMARY KEY, plan TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_member (plan TEXT NOT NULL, bot TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (plan, bot));
      CREATE TABLE IF NOT EXISTS team_exchange (seq INTEGER PRIMARY KEY AUTOINCREMENT, plan TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_bot (id TEXT PRIMARY KEY, plan TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_approval (id TEXT PRIMARY KEY, state TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_task_plan ON team_task(plan);
      CREATE INDEX IF NOT EXISTS team_exchange_plan ON team_exchange(plan, seq);
      CREATE INDEX IF NOT EXISTS team_bot_plan ON team_bot(plan);
      CREATE INDEX IF NOT EXISTS team_approval_state ON team_approval(state, at);
    `)
  }
  atomic<T>(run: () => T): T { return this.store.atomic(run) }
  plan(id: string): TeamPlan | undefined {
    const row = this.store.db.prepare('SELECT value FROM team_plan WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as TeamPlan : undefined
  }
  savePlan(plan: TeamPlan): void {
    this.store.db.prepare('INSERT INTO team_plan VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, value=excluded.value')
      .run(plan.id, plan.status, JSON.stringify(plan))
  }
  /** Newest first. */
  plans(limit = 20): TeamPlan[] {
    return this.store.db.prepare('SELECT value FROM team_plan ORDER BY rowid DESC LIMIT ?').all(limit).map(row => JSON.parse(String(row.value)) as TeamPlan)
  }
  running(): TeamPlan[] {
    return this.store.db.prepare("SELECT value FROM team_plan WHERE status='running' ORDER BY rowid").all().map(row => JSON.parse(String(row.value)) as TeamPlan)
  }
  /** In the order they were added. */
  steps(planId: string): TeamStep[] {
    return this.store.db.prepare('SELECT value FROM team_task WHERE plan=? ORDER BY rowid').all(planId).map(row => JSON.parse(String(row.value)) as TeamStep)
  }
  saveStep(step: TeamStep): void {
    this.store.db.prepare('INSERT INTO team_task VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(`${step.planId}/${step.id}`, step.planId, JSON.stringify(step))
  }
  join(planId: string, bot: string): void { this.store.db.prepare('INSERT OR IGNORE INTO team_member VALUES (?,?,?)').run(planId, bot, now()) }
  bots(planId: string): string[] { return this.store.db.prepare('SELECT bot FROM team_member WHERE plan=? ORDER BY at').all(planId).map(row => String(row.bot)) }
  exchange(entry: Omit<TeamExchange, 'seq' | 'at'>): void {
    this.store.db.prepare('INSERT INTO team_exchange (plan, value) VALUES (?,?)').run(entry.planId, JSON.stringify({ ...entry, at: now() }))
  }
  exchanges(planId: string, limit = 200): TeamExchange[] {
    return this.store.db.prepare('SELECT seq, value FROM team_exchange WHERE plan=? ORDER BY seq DESC LIMIT ?').all(planId, limit)
      .map(row => ({ ...JSON.parse(String(row.value)) as Omit<TeamExchange, 'seq'>, seq: Number(row.seq) })).reverse()
  }
  saveBot(bot: CreatedBot): void {
    this.store.db.prepare('INSERT INTO team_bot VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(bot.id, bot.planId ?? '', JSON.stringify(bot), bot.at)
  }
  bot(id: string): CreatedBot | undefined {
    const row = this.store.db.prepare('SELECT value FROM team_bot WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as CreatedBot : undefined
  }
  botsIn(planId: string): CreatedBot[] {
    return this.store.db.prepare('SELECT value FROM team_bot WHERE plan=?').all(planId).map(row => JSON.parse(String(row.value)) as CreatedBot)
  }
  createdBots(): CreatedBot[] {
    return this.store.db.prepare('SELECT value FROM team_bot ORDER BY at').all().map(row => JSON.parse(String(row.value)) as CreatedBot)
  }
  saveApproval(approval: BotApproval): void {
    this.store.db.prepare('INSERT INTO team_approval VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, value=excluded.value')
      .run(approval.id, approval.state, JSON.stringify(approval), approval.at)
  }
  approval(id: string): BotApproval | undefined {
    const row = this.store.db.prepare('SELECT value FROM team_approval WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as BotApproval : undefined
  }
  approvals(state?: BotApproval['state']): BotApproval[] {
    const rows = state
      ? this.store.db.prepare('SELECT value FROM team_approval WHERE state=? ORDER BY at').all(state)
      : this.store.db.prepare('SELECT value FROM team_approval ORDER BY at').all()
    return rows.map(row => JSON.parse(String(row.value)) as BotApproval)
  }
}

/** What the Team needs from the Runtime. */
export interface TeamHost {
  readonly store: Pick<Store, 'db' | 'atomic'>
  /** Steers a durable relay into the main Session (the Sessions' `relay`). */
  relay(requestId: string, text: string): void
  /** The team bus; injected by tests. */
  bus?: () => TeamBus | undefined
  /** VsSaros addition: after a plan ends, the Retrospective saves its skills and reusable workflow. */
  onPlanEnd?: (plan: PlanView) => void | Promise<void>
  warn(message: string): void
}

/**
 * Runs the main Session's team plans: records them, gives ready steps to their Bots through the team bus, takes the Bots' reports,
 * and tells the main Session of each report and of the plan's end.
 */
export class Team {
  readonly tables: TeamStore
  private readonly bus: () => TeamBus | undefined
  /** Reports that arrived before their `delegate` call returned, by assignment ID. */
  private readonly early = new Map<string, AssignmentView>()
  /** Steps whose `delegate` call is in flight, by `<plan>/<step>`. */
  private readonly giving = new Set<string>()
  constructor(private readonly host: TeamHost) {
    this.tables = new TeamStore(host.store)
    this.bus = host.bus ?? (() => sharedTeamBus())
  }
  /** Whether VsSaros Bots can take steps in this Host now. */
  available(): boolean { return !!this.bus()?.available() }

  /**
   * Subscribes to the bus and reconciles steps that ended while nobody listened; returns the dispose.
   * The bus keeps subscriptions across a hot reload, so a new Team first disposes the previous one: two
   * subscribers sharing one Store would both advance the same plan, and one would end it without the
   * other ever running its retrospective.
   */
  install(): () => void {
    const owner = globalThis as unknown as Record<symbol, (() => void) | undefined>
    owner[TEAM_SUBSCRIPTION_KEY]?.()
    let unsubscribe: (() => void) | undefined
    const attach = () => {
      const bus = this.bus()
      if (!bus || unsubscribe) return
      // Return the promise: the bus's publish() observes rejections, and a test/driver can await the whole report.
      unsubscribe = bus.subscribe(view => this.settled(view).catch(error => { this.host.warn(`team report not recorded: ${String(error)}`) }))
      void this.reconcile()
    }
    attach()
    // The Bots may load after this package, or reload; look again, and catch reports published while nobody listened.
    const timer = setInterval(() => { attach(); void this.reconcile() }, 30_000)
    timer.unref?.()
    const dispose = () => {
      clearInterval(timer); unsubscribe?.()
      if (owner[TEAM_SUBSCRIPTION_KEY] === dispose) delete owner[TEAM_SUBSCRIPTION_KEY]
    }
    owner[TEAM_SUBSCRIPTION_KEY] = dispose
    return dispose
  }

  /** The Bots the main Session may give steps to, those matching `need` first. */
  async bots(need = ''): Promise<BotCard[]> {
    const bus = this.need()
    const words = need.toLowerCase().split(/[\s,，、;；/]+/).filter(word => word.length > 0)
    const score = (card: BotCard) => {
      const text = [card.name, card.role ?? '', card.description, ...card.skills].join(' ').toLowerCase()
      return words.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0) + (card.delegatable ? 0.5 : 0)
    }
    return (await bus.listBots()).map(card => ({ card, score: score(card) })).sort((a, b) => b.score - a.score).map(({ card }) => card)
  }

  /**
   * Starts a plan of `steps`, or adds them to the running plan `planId`; ready steps are given to their Bots at once.
   * @throws TeamError when the steps break a limit, name an unknown step, wait in a cycle, or the Bots are not in this Host.
   */
  async plan(input: { goal?: string; planId?: string; ticketId?: string; cwd?: string; steps: StepInput[] }): Promise<PlanView> {
    this.need()
    const plan = this.host.store.atomic(() => {
      const existing = input.planId ? this.tables.plan(input.planId) : undefined
      if (input.planId && !existing) throw new TeamError(`No plan ${input.planId}`)
      if (existing && existing.status !== 'running') throw new TeamError(`Plan ${existing.id} has ended (${existing.status}); start a new one`)
      const goal = input.goal?.trim() || existing?.goal || ''
      if (!goal) throw new TeamError('A new plan needs a goal')
      const plan: TeamPlan = existing ?? { id: `plan-${randomUUID().slice(0, 8)}`, goal, status: 'running', createdAt: now(),
        ...input.ticketId ? { ticketId: input.ticketId } : {}, ...input.cwd ? { cwd: input.cwd } : {} }
      const before = existing ? this.tables.steps(plan.id) : []
      if (before.length + input.steps.length > TEAM_STEPS_MAX) throw new TeamError(`A plan has at most ${TEAM_STEPS_MAX} steps`)
      const keys = new Set(before.map(step => step.id))
      for (const step of input.steps) {
        if (keys.has(step.key)) throw new TeamError(`Step key ${step.key} is used twice`)
        keys.add(step.key)
      }
      for (const step of input.steps) {
        for (const dep of step.after ?? []) if (!keys.has(dep) || dep === step.key) throw new TeamError(`Step ${step.key} waits for unknown step ${dep}`)
      }
      const steps = [...before, ...input.steps.map((step): TeamStep => ({ id: step.key, planId: plan.id, title: step.title.trim(), spec: step.spec.trim(),
        bot: step.bot.trim(), after: [...new Set(step.after ?? [])], state: 'pending', hop: 0 }))]
      if (cyclic(steps)) throw new TeamError('The steps wait for each other in a cycle')
      this.tables.savePlan(plan)
      for (const step of steps.slice(before.length)) this.tables.saveStep(step)
      this.tables.exchange({ planId: plan.id, hop: 0, from: SUPERVISOR, to: SUPERVISOR, kind: 'system',
        text: existing ? `Added ${input.steps.length} step(s)` : `Plan: ${goal}` })
      return plan
    })
    await this.advance(plan.id)
    return this.view(plan.id)!
  }

  /** Stops a running plan: cancels the steps that run and skips those that wait. */
  async stop(planId: string, reason = 'stopped'): Promise<PlanView> {
    const plan = this.tables.plan(planId)
    if (!plan) throw new TeamError(`No plan ${planId}`)
    if (plan.status === 'running') {
      const bus = this.bus()
      for (const step of this.tables.steps(planId)) {
        if (step.state === 'running' && step.assignmentId) await bus?.cancel(step.assignmentId, reason).catch(() => undefined)
      }
      this.host.store.atomic(() => {
        for (const step of this.tables.steps(planId)) {
          if (step.state !== 'running' && step.state !== 'pending') continue
          this.tables.saveStep({ ...step, state: step.state === 'running' ? 'cancelled' : 'skipped', endedAt: now() })
          if (step.state === 'running') this.tables.exchange({ planId, stepId: step.id, hop: step.hop + 1, from: SUPERVISOR, to: step.botName ?? step.bot, kind: 'cancel', text: reason })
        }
        this.tables.savePlan({ ...plan, status: 'cancelled', endedAt: now() })
      })
    }
    return this.view(planId)!
  }

  /** The Bot drafts waiting for a person, newest last. */
  approvals(): BotApproval[] { return this.tables.approvals('pending') }
  /** Bots the supervisor has created (for quotas and the panel). */
  createdBots(): CreatedBot[] { return this.tables.createdBots() }

  /**
   * Gives the supervisor a new Bot: an existing Bot with the same id or name is returned instead of a duplicate;
   * a draft asking for high-risk tools waits for a person; the rest is written into the Bots roster at once.
   */
  async createBot(input: { draft: BotDraft; planId?: string }): Promise<{ bot?: CreatedBotView; existing?: { id: string; name: string }; pending?: string }> {
    const bus = this.need()
    if (typeof bus.createBot !== 'function') throw new TeamError('This Host\'s VsSaros Bots cannot create a Bot; update @vssaros/dsh-agents to 0.2.320+')
    const draft = input.draft
    const duplicate = (await bus.listBots()).find(card => card.id === draft.id || card.name === draft.name)
    if (duplicate) return { existing: { id: duplicate.id, name: duplicate.name } }
    this.checkBotQuota(input.planId)
    const risk = (draft.tools ?? []).filter(tool => HIGH_RISK_TOOLS.test(tool))
    if (risk.length) {
      const approval: BotApproval = { id: `appr-${randomUUID().slice(0, 8)}`, draft, risk, state: 'pending', at: now(),
        ...input.planId ? { planId: input.planId } : {} }
      this.tables.saveApproval(approval)
      return { pending: approval.id }
    }
    return { bot: await this.commitBot(bus, draft, input.planId) }
  }

  /** Approves a draft waiting for a person; rechecks the quotas, then writes the Bot. */
  async approve(id: string): Promise<CreatedBotView> {
    const approval = this.tables.approval(id)
    if (!approval) throw new TeamError(`No Bot draft ${id}`)
    if (approval.state !== 'pending') throw new TeamError(`Bot draft ${id} is ${approval.state}`)
    const bus = this.need()
    if (typeof bus.createBot !== 'function') throw new TeamError('This Host\'s VsSaros Bots cannot create a Bot')
    this.checkBotQuota(approval.planId)
    const view = await this.commitBot(bus, approval.draft, approval.planId)
    this.tables.saveApproval({ ...approval, state: 'approved', decidedAt: now() })
    return view
  }

  /** Rejects a draft waiting for a person; no Bot is written. */
  reject(id: string): BotApproval {
    const approval = this.tables.approval(id)
    if (!approval) throw new TeamError(`No Bot draft ${id}`)
    if (approval.state !== 'pending') throw new TeamError(`Bot draft ${id} is ${approval.state}`)
    const rejected = { ...approval, state: 'rejected' as const, decidedAt: now() }
    this.tables.saveApproval(rejected)
    return rejected
  }

  private checkBotQuota(planId?: string): void {
    if (planId && this.tables.botsIn(planId).length >= TEAM_BOTS_PER_PLAN) throw new TeamError(`This plan already created ${TEAM_BOTS_PER_PLAN} Bots`)
    if (this.tables.createdBots().length >= TEAM_BOTS_GLOBAL) throw new TeamError(`The supervisor has created ${TEAM_BOTS_GLOBAL} Bots; no more without removing one`)
  }

  private async commitBot(bus: TeamBus, draft: BotDraft, planId?: string): Promise<CreatedBotView> {
    let view: CreatedBotView
    try { view = await bus.createBot!({ draft }) }
    catch (error) { throw new TeamError(`VsSaros Bots could not create ${draft.id}: ${error instanceof Error ? error.message : String(error)}`) }
    this.host.store.atomic(() => {
      this.tables.saveBot({ ...draft, preset: view.preset, file: view.file, at: now(), ...planId ? { planId } : {} })
      if (planId) this.tables.exchange({ planId, hop: 0, from: SUPERVISOR, to: SUPERVISOR, kind: 'system', text: `Created Bot ${view.name} (${view.id})` })
    })
    return view
  }

  view(planId: string): PlanView | undefined {
    const plan = this.tables.plan(planId)
    if (!plan) return undefined
    const steps = this.tables.steps(planId)
    return { ...plan, steps, bots: this.tables.bots(planId), exchanges: this.tables.exchanges(planId), running: steps.filter(step => step.state === 'running').length }
  }
  /** Newest first. */
  views(limit = 20): PlanView[] { return this.tables.plans(limit).map(plan => this.view(plan.id)!) }

  /** Takes an assignment the bus reports ended; one this Team did not give is not its own. */
  async settled(view: AssignmentView): Promise<void> {
    if (view.status === 'running') return
    const found = this.findStep(view.id)
    if (!found) { this.early.set(view.id, view); return }
    const { plan, step } = found
    if (step.state !== 'running') return
    const report = view.report ? (view.report.length > REPORT_KEEP ? `${view.report.slice(0, REPORT_KEEP)}…` : view.report) : undefined
    const ok = view.status === 'done' && !!report
    const ended: TeamStep = { ...step, state: ok ? 'done' : view.status === 'cancelled' ? 'cancelled' : 'failed', hop: step.hop + 1, endedAt: now(),
      ...report ? { report } : {}, ...!ok ? { error: view.error ?? (view.status === 'cancelled' ? 'cancelled' : 'no report') } : {} }
    this.host.store.atomic(() => {
      this.tables.saveStep(ended)
      this.tables.exchange({ planId: plan.id, stepId: step.id, hop: ended.hop, from: view.botName || step.bot, to: SUPERVISOR,
        kind: ok ? 'report' : 'failed', text: report ?? ended.error ?? '' })
      this.host.relay(`team:${plan.id}:${step.id}:${ended.hop}`, JSON.stringify({ kind: 'team_report', plan: plan.id, step: step.id, title: step.title,
        bot: view.botName || step.bot, state: ended.state, ...report ? { report } : {}, ...ended.error ? { error: ended.error } : {} }))
    })
    await this.advance(plan.id)
  }

  /** Gives every ready step of a running plan to its Bot, within `TEAM_PARALLEL`, and ends the plan once nothing is left. */
  async advance(planId: string): Promise<void> {
    const plan = this.tables.plan(planId)
    if (!plan || plan.status !== 'running') return
    const steps = this.tables.steps(planId)
    const state = new Map(steps.map(step => [step.id, step.state]))
    // A step whose wait cannot be met any more is skipped, which may skip the steps waiting for it in turn.
    let changed = true
    while (changed) {
      changed = false
      for (const step of steps) {
        if (state.get(step.id) !== 'pending') continue
        if (step.after.some(dep => ['failed', 'cancelled', 'skipped'].includes(state.get(dep) ?? ''))) {
          state.set(step.id, 'skipped'); changed = true
          this.tables.saveStep({ ...step, state: 'skipped', endedAt: now(), error: 'a step it waits for did not finish' })
        }
      }
    }
    const running = steps.filter(step => state.get(step.id) === 'running').length + [...this.giving].filter(id => id.startsWith(`${planId}/`)).length
    const ready = steps.filter(step => state.get(step.id) === 'pending' && !this.giving.has(`${planId}/${step.id}`)
      && step.after.every(dep => state.get(dep) === 'done'))
    for (const step of ready.slice(0, Math.max(0, TEAM_PARALLEL - running))) await this.give(plan, step)
    const now_ = this.tables.steps(planId)
    if (now_.some(step => step.state === 'pending' || step.state === 'running') || [...this.giving].some(id => id.startsWith(`${planId}/`))) return
    const status: PlanStatus = now_.every(step => step.state === 'done') ? 'done' : 'failed'
    this.host.store.atomic(() => {
      this.tables.savePlan({ ...plan, status, endedAt: now() })
      this.tables.exchange({ planId, hop: 0, from: SUPERVISOR, to: SUPERVISOR, kind: 'system', text: `Plan ${status}` })
      this.host.relay(`team:${planId}:end`, JSON.stringify({ kind: 'team_plan_end', plan: planId, goal: plan.goal, state: status,
        steps: now_.map(step => ({ step: step.id, title: step.title, bot: step.botName ?? step.bot, state: step.state })),
        note: 'Answer the request from the reports; read the plan with orchestrator_team_status for details.' }))
    })
    // VsSaros addition: the Retrospective is idempotent, so a second advance of the same end is harmless.
    try { await this.host.onPlanEnd?.(this.view(planId)!) }
    catch (error) { this.host.warn(`team retrospective failed for ${planId}: ${String(error)}`) }
  }

  private async give(plan: TeamPlan, step: TeamStep): Promise<void> {
    const key = `${plan.id}/${step.id}`
    const hop = step.hop + 1
    if (hop > TEAM_HOPS_MAX) {
      this.tables.saveStep({ ...step, state: 'failed', error: `more than ${TEAM_HOPS_MAX} hops`, endedAt: now() })
      return
    }
    this.giving.add(key)
    const done = this.tables.steps(plan.id).filter(other => step.after.includes(other.id) && other.report)
    const text = [`Team plan ${plan.id}: ${plan.goal}`, `Your step ${step.id}: ${step.title}`, step.spec,
      ...done.length ? ['Results of the steps before yours:', ...done.map(other => `- ${other.id} ${other.title}: ${other.report}`)] : [],
      'Work on this step only. End your turn with your result as the final answer; it is reported to the supervisor.'].join('\n\n')
    try {
      const view = await this.need().delegate({ bot: step.bot, task: text, ...plan.cwd ? { cwd: plan.cwd } : {}, fromName: SUPERVISOR })
      this.host.store.atomic(() => {
        this.tables.saveStep({ ...step, state: 'running', hop, assignmentId: view.id, sessionId: view.sessionId, botId: view.botId, botName: view.botName, startedAt: now() })
        this.tables.join(plan.id, view.botName || view.botId)
        this.tables.exchange({ planId: plan.id, stepId: step.id, hop, from: SUPERVISOR, to: view.botName || step.bot, kind: 'give', text: `${step.title}\n${step.spec}` })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.host.store.atomic(() => {
        this.tables.saveStep({ ...step, state: 'failed', hop, error: message, endedAt: now() })
        this.tables.exchange({ planId: plan.id, stepId: step.id, hop, from: SUPERVISOR, to: step.bot, kind: 'failed', text: message })
        this.host.relay(`team:${plan.id}:${step.id}:${hop}`, JSON.stringify({ kind: 'team_report', plan: plan.id, step: step.id, title: step.title,
          bot: step.bot, state: 'failed', error: `Not given: ${message}` }))
      })
    } finally {
      this.giving.delete(key)
    }
    const early = this.tables.steps(plan.id).find(other => other.id === step.id)?.assignmentId
    const waiting = early ? this.early.get(early) : undefined
    if (waiting) { this.early.delete(early!); void this.settled(waiting) }
  }

  /** Steps that run but whose assignments ended while nobody listened (a restart of either side). */
  private async reconcile(): Promise<void> {
    const bus = this.bus()
    if (!bus?.available()) return
    for (const plan of this.tables.running()) {
      for (const step of this.tables.steps(plan.id)) {
        if (step.state !== 'running' || !step.assignmentId) continue
        const view = await bus.get(step.assignmentId).catch(() => undefined)
        if (view && view.status !== 'running') await this.settled(view)
      }
      void this.advance(plan.id)
    }
  }

  private findStep(assignmentId: string): { plan: TeamPlan; step: TeamStep } | undefined {
    for (const plan of this.tables.running()) {
      const step = this.tables.steps(plan.id).find(other => other.assignmentId === assignmentId)
      if (step) return { plan, step }
    }
    return undefined
  }

  private need(): TeamBus {
    const bus = this.bus()
    if (!bus?.available()) throw new TeamError('VsSaros Bots are not running in this Host, so no plan can be given to them')
    return bus
  }
}

/** Whether the steps' waits form a cycle. */
function cyclic(steps: readonly TeamStep[]): boolean {
  const after = new Map(steps.map(step => [step.id, step.after]))
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false
    if (state.get(id) === 1) return true
    state.set(id, 1)
    if ((after.get(id) ?? []).some(visit)) return true
    state.set(id, 2)
    return false
  }
  return steps.some(step => visit(step.id))
}
