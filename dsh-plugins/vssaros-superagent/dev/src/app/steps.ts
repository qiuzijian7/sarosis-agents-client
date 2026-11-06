/**
 * VsSaros addition (superagent v2, P3): the steps of a ticket's agreed team, each done by one VsSaros Bot in a Session of
 * its own (`step-<ticket>-<key>`) that runs under the Bot's preset, so the Bot works with its own persona, tools and model,
 * plus `orchestrator_step_report`. The ticket's own worker Session stays its lead: it holds the Assignment, talks to people
 * and reports the ticket's result; each step's end reaches it as a note, and it may not report `ready` while a step is
 * unfinished. The host schedules the steps: by their dependencies, at most `parallel` at once, one writing step at a time,
 * a failed step tried once more, and each step's turns counted for the skill distillation that follows (P4).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { liveTicket, runningAssignment, staffing, type Engine, type Ticket } from '../core/index.ts'
import { StepPermissionError, type Sessions } from './sessions.ts'
import type { StaffingProposal } from './staffing.ts'
import type { StepPermission } from './step-approvals.ts'
import type { Store } from './store.ts'
import { meteredStream } from './usage.ts'
// Type only: tools/tool.ts reaches the executor through resources.ts, which would make importing this module a cycle.
import type { Tool } from './tools/tool.ts'

export const STEP_ATTEMPTS = 2
/**
 * VsSaros addition (2026-11-06): how many times one step may be sent back for rework. A step whose result a later step
 * found wrong (a tester's bugs for the developer) is reopened with what to fix; past this a later step reports failed or
 * blocked instead, so a team cannot loop on one step for ever.
 */
export const STEP_REWORKS = 3
const REPORT_CHARS = 1200, REQUEST_CHARS = 2000, KICK_MS = 30_000
const now = () => new Date().toISOString()
/** The preset VsSaros Bots register for a Bot (`presetIdOf` in @vssaros/dsh-agents). */
export const botPreset = (botId: string): string =>
  `vssaros-${String(botId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'}`
export const stepSessionId = (ticketId: string, key: string): string => `step-${ticketId}-${key}`
/** The ticket and step of a step Session; ticket IDs are hex, so the first dash after the prefix ends the ticket ID. */
export function stepOfSession(sessionId: string): { ticketId: string; key: string } | undefined {
  if (!sessionId.startsWith('step-')) return undefined
  const rest = sessionId.slice(5), at = rest.indexOf('-')
  return at > 0 && at < rest.length - 1 ? { ticketId: rest.slice(0, at), key: rest.slice(at + 1) } : undefined
}

export type StepState = 'pending' | 'running' | 'ready' | 'blocked' | 'failed' | 'skipped' | 'stopped'
export interface TeamStep {
  ticketId: string; key: string; role: string; title: string; spec: string; after: string[]; access: 'read' | 'write'
  /**
   * The Bot doing it. VsSaros addition (2026-11-06): `tools`, its own tools as the roster listed them when the team was
   * agreed; its Session may use `WORK_TOOLS ∪ tools` (sessions.ts). Unset on steps agreed before: only its preset limits it.
   */
  bot: { id: string; name: string; tools?: string[] }; preset: string
  state: StepState; attempts: number; turns: number; failures: string[]
  report?: string; implicit?: true
  parallel: number; turnsCap: number
  /**
   * VsSaros addition (2026-11-06, token budget): the tokens this step's Session used (input, cache reads and writes, and
   * output), and the team's cap (the agreed budget's `tokens`, the same on every step). At 90% of the cap the lead is told
   * once (`budgetWarnedAt` on the first step); at the cap no new step starts and running steps may only report.
   */
  tokens?: number
  tokensCap?: number
  budgetWarnedAt?: string
  budgetStoppedAt?: string
  promptedAt?: string; reportedAt?: string; startedAt?: string; endedAt?: string
  /** On the first step only: when the lead was told that every step finished. */
  summarizedAt?: string
  /**
   * A write step this machine could not sandbox: it ran unsandboxed, its file tools kept inside its directory. VsSaros fix
   * (2026-11-06): once set it stays set, so the panel keeps showing that the step ran without a sandbox.
   */
  unsandboxed?: true
  /**
   * VsSaros fix (2026-11-06): what the blocked step needs a person to decide before it runs: `sandbox`, this machine cannot
   * sandbox its directory; `permission`, DSH refused its permission preset. It no longer runs with full access by itself.
   */
  needs?: 'sandbox' | 'permission'
  /** A person let the step run without a sandbox. */
  unsandboxedAllowed?: { by: string; at: string }
  /**
   * VsSaros addition (2026-11-06): the step was reopened because a later step sent work back. `by` sent it, `target` is
   * the step sent back (this one, or one it waits for), `text` what to fix. Cleared when the step reports again.
   */
  reopened?: { by: string; target: string; text: string; round: number }
  /** How many times this step was sent back (at most `STEP_REWORKS`). */
  reworks?: number
  /** `attempts` when the step was last reopened: a failure is tried once more per round, not once per ticket. */
  attemptBase?: number
}
const FINAL: readonly StepState[] = ['ready', 'failed', 'skipped', 'stopped']
/** An open team ticket as the panel shows it. */
export interface StepsView {
  ticket: { id: string; title: string; updatedAt: string }
  /** VsSaros addition (2026-11-06): what the team used of its agreed budget. */
  budget?: { tokens: number; tokensCap: number; turns: number; turnsCap: number; stopped: boolean }
  steps: {
    key: string; title: string; bot: string; botId: string; access: 'read' | 'write'; state: StepState; turns: number; attempts: number
    after: string[]; report?: string; failures?: string[]
    /** When the current attempt started, while it runs. */
    since?: string
    /** What its Bot does now, while it runs. */
    doing?: { tool: string; target?: string; note?: string; at: string }
    /** The id of its request waiting for a person. */
    approval?: string
    unsandboxed?: true
    /** VsSaros fix (2026-11-06): what the blocked step needs a person to decide. */
    needs?: 'sandbox' | 'permission'
    /** VsSaros addition (2026-11-06): times sent back for rework, and the latest reason. */
    reworks?: number
    reworkNote?: string
  }[]
}
const final = (step: TeamStep) => FINAL.includes(step.state)
/** The steps `key` waits for, directly or through others. */
export function upstreamOf(steps: readonly Pick<TeamStep, 'key' | 'after'>[], key: string): Set<string> {
  const out = new Set<string>(), queue = [...steps.find(step => step.key === key)?.after ?? []]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (out.has(next)) continue
    out.add(next)
    queue.push(...steps.find(step => step.key === next)?.after ?? [])
  }
  return out
}
/** The steps that wait for `key`, directly or through others. */
export function downstreamOf(steps: readonly Pick<TeamStep, 'key' | 'after'>[], key: string): Set<string> {
  const out = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const step of steps) {
      if (!out.has(step.key) && step.after.some(item => item === key || out.has(item))) { out.add(step.key); grew = true }
    }
  }
  return out
}

/** Team steps by ticket and key in the orchestrator database, in the order of their proposal. */
class StepStore {
  constructor(private readonly store: Pick<Store, 'db'>, private readonly changed: () => void = () => {}) {
    store.db.exec('CREATE TABLE IF NOT EXISTS team_step (ticket TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ticket, key))')
  }
  save(step: TeamStep, seq = 0): void {
    this.store.db.prepare('INSERT INTO team_step VALUES (?,?,?,?) ON CONFLICT(ticket, key) DO UPDATE SET value=excluded.value')
      .run(step.ticketId, step.key, seq, JSON.stringify(step))
    this.changed()
  }
  of(ticketId: string): TeamStep[] {
    return this.store.db.prepare('SELECT value FROM team_step WHERE ticket=? ORDER BY seq').all(ticketId).map(row => JSON.parse(String(row.value)) as TeamStep)
  }
  get(ticketId: string, key: string): TeamStep | undefined {
    const row = this.store.db.prepare('SELECT value FROM team_step WHERE ticket=? AND key=?').get(ticketId, key)
    return row ? JSON.parse(String(row.value)) as TeamStep : undefined
  }
  tickets(): string[] {
    return this.store.db.prepare('SELECT DISTINCT ticket FROM team_step').all().map(row => String(row.ticket))
  }
}

export interface StepsHost {
  context: Context
  store: Pick<Store, 'db' | 'tickets' | 'triggers' | 'atomic'>
  engine: Pick<Engine, 'note'>
  sessions: Pick<Sessions, 'ensure' | 'prompt'>
  /** The preset a step Session falls back to when its Bot's preset cannot be used. */
  fallbackPreset: string
  closing(): boolean
  paused(): boolean
  warn(message: string): void
  /** P4: a step ended ready or failed for good; its evidence goes to the memory system. */
  ended?(step: TeamStep): void
  /** Plan C: the DSH permission a step runs under in its directory. */
  permission?(step: TeamStep, directory: string): Promise<StepPermission>
  /** Plan C: what a step Session does now, and a step's request waiting for a person. */
  doing?(sessionId: string): StepsView['steps'][number]['doing']
  approval?(ticketId: string, key: string): string | undefined
  /** Plan C: a step changed; open pages hear of it. */
  changed?(): void
  /** VsSaros addition (2026-11-06): a Bot's preset as the Bots plugin names it (team bus revision 2), else `botPreset`. */
  presetOf?(botId: string): string | undefined
}

/**
 * Schedules and records an agreed team's steps: writes them when a person agrees, starts each in its Bot's Session once the
 * lead runs, records the Bots' reports and turn ends, retries, skips and stops steps, and tells the lead with notes.
 */
export class TeamSteps {
  readonly tables: StepStore
  private readonly kicking = new Map<string, Promise<void>>()
  private readonly disposers: (() => void)[] = []
  constructor(private readonly host: StepsHost) { this.tables = new StepStore(host.store, () => { host.changed?.() }) }

  /** Writes the steps of an agreed proposal; called in the transaction that agrees to it. */
  plan(proposal: StaffingProposal): void {
    if (this.tables.of(proposal.ticketId).length) return
    proposal.steps.forEach((step, seq) => {
      const role = proposal.roles.find(item => item.key === step.role)
      const bot = role?.bot ?? { id: role?.draft?.id ?? step.role, name: role?.draft?.name ?? step.role, ...role?.draft ? { tools: role.draft.tools ?? [] } : {} }
      this.tables.save({ ticketId: proposal.ticketId, key: step.key, role: step.role, title: step.title, spec: step.spec, after: step.after,
        access: step.access, bot, preset: this.host.presetOf?.(bot.id) ?? botPreset(bot.id), state: 'pending', attempts: 0, turns: 0, failures: [],
        parallel: Math.max(1, Math.min(3, proposal.budget.parallel)), turnsCap: proposal.budget.turns, tokens: 0, tokensCap: proposal.budget.tokens }, seq)
    })
  }
  steps(ticketId: string): TeamStep[] { return this.tables.of(ticketId) }

  // ── VsSaros addition (2026-11-06): the token budget, a hard gate ────────────────────────────────────────────────
  /** What the team used of its budget: tokens and turns over all steps, the caps, and whether the token cap is reached. */
  budget(ticketId: string): StepsView['budget'] | undefined {
    const steps = this.tables.of(ticketId)
    if (!steps.length) return undefined
    const tokens = steps.reduce((sum, step) => sum + (step.tokens ?? 0), 0), tokensCap = steps[0]!.tokensCap ?? 0
    return { tokens, tokensCap, turns: steps.reduce((sum, step) => sum + step.turns, 0), turnsCap: steps[0]!.turnsCap,
      stopped: tokensCap > 0 && tokens >= tokensCap }
  }
  /** Whether the team of `ticketId` used its token budget up: no new step starts and running steps may only report. */
  overBudget(ticketId: string): boolean { return !!this.budget(ticketId)?.stopped }
  /**
   * A step Session's model call used tokens (DSH's `usage` chunk; billable input is input + cache reads + cache writes).
   * Counted on the step; the lead is told once at 90% of the cap, and once when the cap is reached.
   */
  meter(sessionId: string, usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
    const ref = stepOfSession(sessionId)
    const step = ref && this.tables.get(ref.ticketId, ref.key)
    if (!step) return
    const used = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
      .reduce<number>((sum, value) => sum + (Number.isFinite(value) && value! > 0 ? value! : 0), 0)
    if (!used) return
    this.tables.save({ ...step, tokens: (step.tokens ?? 0) + used }, this.seq(step))
    const budget = this.budget(step.ticketId)!, first = this.tables.of(step.ticketId)[0]!
    if (!budget.tokensCap) return
    if (budget.stopped && !first.budgetStoppedAt) {
      this.tables.save({ ...first, budgetStoppedAt: now(), budgetWarnedAt: first.budgetWarnedAt ?? now() }, 0)
      this.note(step.ticketId, `The team used its token budget (${budget.tokens} of ${budget.tokensCap}): no new step starts, and running steps may only report. `
        + 'Ask the person whether to go on; they raise the budget in the panel.')
    } else if (!budget.stopped && budget.tokens >= budget.tokensCap * 0.9 && !first.budgetWarnedAt) {
      this.tables.save({ ...first, budgetWarnedAt: now() }, 0)
      this.note(step.ticketId, `The team used 90% of its token budget (${budget.tokens} of ${budget.tokensCap}). Tell the person; at the cap no new step starts.`)
    }
  }
  /**
   * A person raises the team's budget (new caps, each above what is used); the steps that waited may start.
   * @throws Error when the ticket has no team or a cap is not above what is used.
   */
  async raiseBudget(ticketId: string, caps: { tokens?: number; turns?: number }): Promise<NonNullable<StepsView['budget']>> {
    const budget = this.budget(ticketId)
    if (!budget) throw new Error('This ticket has no team steps')
    if (caps.tokens !== undefined && caps.tokens <= budget.tokens) throw new Error(`The token budget must be above the ${budget.tokens} tokens used`)
    if (caps.turns !== undefined && caps.turns <= budget.turns) throw new Error(`The turn budget must be above the ${budget.turns} turns used`)
    this.host.store.atomic(() => {
      this.tables.of(ticketId).forEach((step, seq) => {
        const { budgetWarnedAt: _warned, budgetStoppedAt: _stopped, ...rest } = step
        this.tables.save({ ...seq === 0 ? rest : step, ...caps.tokens !== undefined ? { tokensCap: caps.tokens } : {},
          ...caps.turns !== undefined ? { turnsCap: caps.turns } : {} }, this.seq(step))
      })
    })
    this.note(ticketId, `A person raised the team's budget to ${caps.tokens ?? budget.tokensCap} tokens and ${caps.turns ?? budget.turnsCap} turns; the steps that waited may start.`)
    await this.kick(ticketId)
    return this.budget(ticketId)!
  }
  step(sessionId: string): TeamStep | undefined {
    const ref = stepOfSession(sessionId)
    return ref && this.tables.get(ref.ticketId, ref.key)
  }
  /** The steps of a ticket that have not finished; its lead may not report ready until none is left. */
  unfinished(ticketId: string): TeamStep[] { return this.tables.of(ticketId).filter(step => !final(step)) }
  /** For the panel: every open ticket with a team, newest first, with its steps' Bot, state, turns and attempts. */
  active(): StepsView[] {
    const views: StepsView[] = []
    for (const ticketId of this.tables.tickets()) {
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) continue
      const view = this.view(ticketId)
      if (view) views.push(view)
    }
    return views.sort((a, b) => b.ticket.updatedAt.localeCompare(a.ticket.updatedAt))
  }
  /** One ticket's team as the panel shows it, open or ended; none when the ticket has no team. */
  view(ticketId: string): StepsView | undefined {
    const ticket = this.host.store.tickets.get(ticketId)
    const steps = this.tables.of(ticketId)
    if (!ticket || !steps.length) return undefined
    const budget = this.budget(ticketId)
    return { ticket: { id: ticket.id, title: ticket.title, updatedAt: ticket.updatedAt }, ...budget ? { budget } : {},
      steps: steps.map(step => {
        const running = step.state === 'running', doing = running ? this.host.doing?.(stepSessionId(ticketId, step.key)) : undefined
        const approval = running ? this.host.approval?.(ticketId, step.key) : undefined
        return { key: step.key, title: step.title, bot: step.bot.name, botId: step.bot.id, access: step.access,
          state: step.state, turns: step.turns, attempts: step.attempts, after: step.after,
          ...step.report ? { report: step.report.slice(0, 200) } : {}, ...step.failures.length ? { failures: step.failures.map(text => text.slice(0, 200)) } : {},
          ...running && step.promptedAt ? { since: step.promptedAt } : {}, ...doing ? { doing } : {}, ...approval ? { approval } : {},
          ...step.unsandboxed ? { unsandboxed: true as const } : {}, ...step.needs && step.state === 'blocked' ? { needs: step.needs } : {},
          ...step.reworks ? { reworks: step.reworks } : {}, ...step.reopened && step.reopened.target === step.key ? { reworkNote: step.reopened.text.slice(0, 200) } : {} }
      }) }
  }

  /** Starts the steps that may run now. Idempotent and serialized per ticket. */
  kick(ticketId: string): Promise<void> {
    const previous = this.kicking.get(ticketId) ?? Promise.resolve()
    const next = previous.then(() => this.schedule(ticketId)).catch(error => { this.host.warn(`team steps of ${ticketId}: ${String(error)}`) })
    this.kicking.set(ticketId, next)
    return next
  }

  /**
   * A step's Bot reported. `ready` ends the step with its result; `blocked` keeps it waiting for the lead's message with a
   * person's answer; `failed` tries it once more, then ends it, which skips the steps that wait for it.
   */
  async report(ticketId: string, key: string, state: 'ready' | 'blocked' | 'failed', summary: string, implicit = false): Promise<TeamStep & { retried?: true }> {
    const step = this.tables.get(ticketId, key)
    if (!step) throw new Error(`No step ${key} on this ticket`)
    if (step.state !== 'running') throw new Error(`Step ${key} is ${step.state}; it takes no report now`)
    const at = now(), text = summary.trim().slice(0, REPORT_CHARS)
    const retried = state === 'failed' && step.attempts - (step.attemptBase ?? 0) < STEP_ATTEMPTS
    if (retried) {
      this.tables.save({ ...step, state: 'pending', failures: [...step.failures, text], reportedAt: at }, this.seq(step))
      this.note(ticketId, `Step ${key} (${step.bot.name}) failed and is tried once more: ${text}`)
    } else {
      const { reopened: _done, ...rest } = step
      const ended: TeamStep = { ...(state === 'blocked' ? step : rest), state, report: text, reportedAt: at, ...state === 'failed' ? { failures: [...step.failures, text] } : {},
        ...implicit ? { implicit: true as const } : {}, ...state === 'blocked' ? {} : { endedAt: at } }
      this.tables.save(ended, this.seq(step))
      this.note(ticketId, state === 'blocked'
        ? `Step ${key} (${step.bot.name}) needs a person: ${text}\nAsk the person; send their answer with orchestrator_step_message.`
        : `Step ${key} (${step.bot.name}) ${state}: ${text}`)
    }
    await this.kick(ticketId)
    const recorded = this.tables.get(ticketId, key)!
    if (recorded.state === 'ready' || recorded.state === 'failed') this.host.ended?.(recorded)
    return { ...recorded, ...retried ? { retried: true as const } : {} }
  }
  /**
   * VsSaros addition (2026-11-06): a running step sends a step it waits for (directly or not) back for rework, such as a
   * tester sending the developer's step back with the bugs it found. The target and every finished step after it,
   * including the sender, are reopened: the target runs again with what to fix, then the steps after it run again on its
   * new result (the sender checks again). A step may be sent back `STEP_REWORKS` times.
   * @throws Error when the sender is not running, the target is not a finished step it waits for, or it was sent back enough.
   */
  async rework(ticketId: string, key: string, target: string, summary: string): Promise<TeamStep & { reopened: NonNullable<TeamStep['reopened']> }> {
    const steps = this.tables.of(ticketId)
    const sender = steps.find(item => item.key === key)
    if (!sender) throw new Error(`No step ${key} on this ticket`)
    if (sender.state !== 'running') throw new Error(`Step ${key} is ${sender.state}; it takes no report now`)
    const before = upstreamOf(steps, key)
    const sent = steps.find(item => item.key === target)
    if (!sent || !before.has(target)) {
      throw new Error(`Step ${key} can send back only a step it waits for: ${[...before].join(', ') || 'none'}`)
    }
    if (sent.state !== 'ready') throw new Error(`Step ${target} is ${sent.state}; only a ready step can be sent back`)
    const round = (sent.reworks ?? 0) + 1
    if (round > STEP_REWORKS) {
      throw new Error(`Step ${target} was sent back ${STEP_REWORKS} times already; report failed, or blocked with a question for a person`)
    }
    const text = summary.trim().slice(0, REPORT_CHARS)
    const after = downstreamOf(steps, target)
    const reopened = { by: key, target, text, round }
    const at = now()
    this.host.store.atomic(() => {
      for (const item of steps) {
        if (item.key !== target && !after.has(item.key)) continue
        if (item.key !== target && item.key !== key && item.state !== 'ready' && item.state !== 'skipped') continue
        const { endedAt: _ended, ...rest } = item
        this.tables.save({ ...rest, state: 'pending', reopened, attemptBase: item.attempts,
          ...item.key === target ? { reworks: round } : {}, ...item.key === key ? { reportedAt: at } : {} }, this.seq(item))
      }
      const first = this.tables.of(ticketId)[0]!
      if (first.summarizedAt) { const { summarizedAt: _told, ...rest } = first; this.tables.save(rest, 0) }
    })
    this.note(ticketId, `Step ${key} (${sender.bot.name}) sent step ${target} (${sent.bot.name}) back for rework (${round}/${STEP_REWORKS}): ${text}`)
    await this.kick(ticketId)
    return { ...this.tables.get(ticketId, target)!, reopened }
  }
  /**
   * VsSaros fix (2026-11-06): a person lets a step blocked on its sandbox or permission run without a sandbox (full access,
   * its file tools kept inside its directory). The step runs again; the panel shows it ran unsandboxed.
   * @throws Error when the step does not wait for that decision.
   */
  async allowUnsandboxed(ticketId: string, key: string, by: string): Promise<TeamStep> {
    const step = this.tables.get(ticketId, key)
    if (!step) throw new Error(`No step ${key} on this ticket`)
    if (step.state !== 'blocked' || !step.needs) throw new Error(`Step ${key} does not wait for a decision about its sandbox`)
    this.tables.save({ ...step, state: 'pending', unsandboxedAllowed: { by, at: now() } }, this.seq(step))
    this.note(ticketId, `A person let step ${key} (${step.bot.name}) run without a sandbox; it starts again.`)
    await this.kick(ticketId)
    return this.tables.get(ticketId, key)!
  }
  /** A step that cannot start safely waits for a person: blocked, with what it needs; the lead and the panel hear of it. */
  private block(step: TeamStep, needs: 'sandbox' | 'permission', cause = ''): void {
    const report = needs === 'sandbox'
      ? '这台机器不能给工作目录加沙箱：不加沙箱运行时命令不受限制。需要人决定：允许不加沙箱运行，或停止这一步。'
      : `DSH 不接受这一步的权限设置（${cause.slice(0, 200)}）。需要人决定：允许不加沙箱运行，或停止这一步。`
    this.tables.save({ ...step, state: 'blocked', needs, report }, this.seq(step))
    this.note(step.ticketId, `Step ${step.key} (${step.bot.name}) needs a person: ${needs === 'sandbox' ? 'this machine cannot sandbox its directory' : `its permission could not be set (${cause.slice(0, 200)})`}. `
      + 'It does not run with full access by itself: the person lets it run without a sandbox, or stops it, in the panel.')
  }
  /** The lead sends a step's Bot a message, such as a person's answer to its question; a blocked step runs again. */
  async message(ticketId: string, key: string, text: string): Promise<TeamStep> {
    const step = this.tables.get(ticketId, key)
    if (!step) throw new Error(`No step ${key} on this ticket`)
    if (step.state !== 'running' && step.state !== 'blocked') throw new Error(`Step ${key} is ${step.state}; it takes no message`)
    if (step.state === 'blocked' && step.needs) throw new Error(`Step ${key} waits for a person to decide about its sandbox, in the panel; a message does not start it`)
    const at = now()
    this.tables.save({ ...step, state: 'running', promptedAt: at }, this.seq(step))
    await this.host.sessions.prompt(stepSessionId(ticketId, key), `step-message:${ticketId}:${key}:${at}`,
      JSON.stringify({ from: 'lead', step: key, text, rules: 'Go on with your step, then report with orchestrator_step_report.' }),
      step.state === 'running' ? 'steer' : 'queue')
    return this.tables.get(ticketId, key)!
  }
  /** The ticket ended: every step that has not finished stops, and its Session's turn is cancelled. */
  stopAll(ticketId: string, reason: string): void {
    for (const step of this.tables.of(ticketId)) {
      if (final(step)) continue
      this.tables.save({ ...step, state: 'stopped', report: step.report ?? reason, endedAt: now() }, this.seq(step))
      this.host.context.agents.get(stepSessionId(ticketId, step.key) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
    }
  }
  /**
   * Plan C: a person stops one step. Its turn is cancelled (which cancels a request of it waiting for a person), the steps
   * that wait for it are skipped, and the lead is told.
   * @throws Error when the step does not exist or has already finished.
   */
  async stop(ticketId: string, key: string): Promise<TeamStep> {
    const step = this.tables.get(ticketId, key)
    if (!step) throw new Error(`No step ${key} on this ticket`)
    if (final(step)) throw new Error(`Step ${key} is ${step.state} already`)
    this.tables.save({ ...step, state: 'stopped', report: step.report ?? 'Stopped by a person', endedAt: now() }, this.seq(step))
    this.host.context.agents.get(stepSessionId(ticketId, key) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
    this.note(ticketId, `A person stopped step ${key} (${step.bot.name}); the steps that wait for it are skipped.`)
    await this.kick(ticketId)
    return this.tables.get(ticketId, key)!
  }

  /** Subscribes to step Sessions' turn ends and errors, and looks again periodically, as for a pause that ended. */
  install(): () => void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || this.host.closing() || !stepOfSession(agent.id)) return
      void this.idle(agent).catch(error => { this.host.warn(`team step turn end not recorded: ${String(error)}`) })
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const ref = stepOfSession(agent.id)
      if (!ref || this.host.closing()) return
      void this.report(ref.ticketId, ref.key, 'failed', `The Bot's turn failed: ${String(error).slice(0, 300)}`)
        .catch(() => { /* the step was not running */ })
    }))
    const timer = setInterval(() => { for (const id of this.tables.tickets()) void this.kick(id) }, KICK_MS)
    timer.unref?.()
    this.disposers.push(() => { clearInterval(timer) })
    return () => { for (const dispose of this.disposers.splice(0)) dispose() }
  }
  /** After a restart, a step that ran is told to go on; the others start when their ticket's lead runs. */
  async resume(): Promise<void> {
    for (const ticketId of this.tables.tickets()) {
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) continue
      for (const step of this.tables.of(ticketId).filter(item => item.state === 'running')) {
        await this.host.sessions.prompt(stepSessionId(ticketId, step.key), `step-resume:${ticketId}:${step.key}:${now()}`,
          JSON.stringify({ step: step.key, resumed: true, rules: 'dsh-superagent restarted. Go on with your step where it stopped, then report with orchestrator_step_report.' }), 'queue')
          .catch(error => { this.host.warn(`team step ${step.key} not resumed: ${String(error)}`) })
      }
      void this.kick(ticketId)
    }
  }

  /** A step Session's turn ended: one more turn, and a step that ended its turn without reporting is ready with its last words. */
  private async idle(agent: Agent): Promise<void> {
    await agent.whenIdle()
    const ref = stepOfSession(agent.id)!
    const step = this.tables.get(ref.ticketId, ref.key)
    if (!step || agent.status !== 'idle') return
    const counted = { ...step, turns: step.turns + 1 }
    this.tables.save(counted, this.seq(step))
    if (step.state !== 'running' || (step.reportedAt && step.promptedAt && step.reportedAt >= step.promptedAt)) { await this.kick(ref.ticketId); return }
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    await this.report(ref.ticketId, ref.key, 'ready', text || '(The Bot ended its turn without a report.)', true)
  }
  private async schedule(ticketId: string): Promise<void> {
    const { store } = this.host
    if (this.host.closing() || this.host.paused()) return
    const ticket = store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) { this.stopAll(ticketId, 'the ticket ended'); return }
    // The lead runs first: its launch prepared the ticket's directory, where the steps work.
    if (staffing(ticket) || !runningAssignment(ticket)) return
    const directory = ticket.execution?.directory ?? ''
    if (!directory || !await stat(directory).then(() => true, () => false)) return
    let steps = this.tables.of(ticketId)
    if (!steps.length) return
    // Skip the steps that wait for one that failed, was skipped or stopped.
    for (const step of steps) {
      if (step.state === 'pending' && step.after.some(key => ['failed', 'skipped', 'stopped'].includes(steps.find(item => item.key === key)?.state ?? ''))) {
        this.tables.save({ ...step, state: 'skipped', report: 'A step it waits for did not finish', endedAt: now() }, this.seq(step))
        this.note(ticketId, `Step ${step.key} (${step.bot.name}) skipped: a step it waits for did not finish.`)
      }
    }
    steps = this.tables.of(ticketId)
    const turns = steps.reduce((sum, step) => sum + step.turns, 0), cap = steps[0]!.turnsCap
    const running = steps.filter(step => step.state === 'running')
    const ready = steps.filter(step => step.state === 'pending' && step.after.every(key => steps.find(item => item.key === key)?.state === 'ready'))
    if (turns >= cap && ready.length) {
      this.note(ticketId, `The team used ${turns} of its ${cap} turns; steps ${ready.map(step => step.key).join(', ')} wait. Ask the person whether to go on; they raise the budget in the panel.`)
      return
    }
    // VsSaros addition (2026-11-06): the token budget is a hard gate too (meter() told the lead when it was reached).
    if (ready.length && this.overBudget(ticketId)) return
    let writing = running.some(step => step.access === 'write')
    let slots = steps[0]!.parallel - running.length
    for (const step of ready) {
      if (slots <= 0) break
      if (step.access === 'write' && writing) continue
      await this.start(ticket, step, steps)
      slots -= 1
      writing ||= step.access === 'write'
    }
    if (steps.every(final) && !steps[0]!.summarizedAt) this.summarize(ticketId)
  }
  private async start(ticket: Ticket, step: TeamStep, steps: TeamStep[]): Promise<void> {
    const at = now(), attempt = step.attempts + 1
    const sessionId = stepSessionId(ticket.id, step.key), directory = ticket.execution!.directory
    // Plan C: a read step is read-only, a write step writes its directory.
    // VsSaros fix (2026-11-06): a write step this machine cannot sandbox no longer runs with full access by itself: it is
    // blocked until a person lets it run without a sandbox (`allowUnsandboxed`) or stops it.
    let permission = await this.host.permission?.(step, directory)
    if (permission && !permission.sandboxed && !step.unsandboxedAllowed) { this.block(step, 'sandbox'); return }
    if (step.unsandboxedAllowed && step.needs === 'permission') permission = { preset: 'danger-full-access', sandboxed: false }
    const { needs: _needed, ...rest } = step
    const started: TeamStep = { ...rest, state: 'running', attempts: attempt, promptedAt: at, startedAt: step.startedAt ?? at,
      ...permission && !permission.sandboxed ? { unsandboxed: true as const } : {} }
    this.tables.save(started, this.seq(step))
    const title = `${ticket.title} · ${step.key} ${step.bot.name}`
    try {
      try { await this.host.sessions.ensure(sessionId, directory, title, 'step', step.preset, permission?.preset) }
      catch (error) {
        if (error instanceof StepPermissionError) throw error
        // A Bot whose preset this Host cannot use, such as one just created whose preset is not registered yet, runs as the fallback.
        this.host.warn(`team step ${step.key}: preset ${step.preset} unusable (${String(error)}); using ${this.host.fallbackPreset}`)
        this.tables.save({ ...started, preset: this.host.fallbackPreset }, this.seq(step))
        await this.host.sessions.ensure(sessionId, directory, title, 'step', this.host.fallbackPreset, permission?.preset)
      }
    } catch (error) {
      if (!(error instanceof StepPermissionError)) throw error
      this.host.warn(`team step ${step.key}: ${error.message}`)
      this.block({ ...step, attempts: step.attempts }, 'permission', error.message)
      return
    }
    const source = this.host.store.triggers.get(ticket.origin.triggerId)
    const upstream = step.after.map(key => steps.find(item => item.key === key)!).map(item => ({ step: item.key, title: item.title, bot: item.bot.name, report: item.report ?? '' }))
    const before = upstreamOf(steps, step.key)
    // VsSaros addition (2026-11-06): a reopened step learns why — what to fix, or that a step before it was redone.
    const reopened = step.reopened
    const rework = reopened ? reopened.target === step.key
      ? { sent_back_by: reopened.by, round: reopened.round, fix: reopened.text, ...step.report ? { your_previous_report: step.report } : {} }
      : { redone: reopened.target, after_feedback_of: reopened.by, feedback: reopened.text, round: reopened.round,
        note: reopened.by === step.key ? 'You sent it back: check again whether it is fixed now.' : 'Do your step again on its new result.' }
      : undefined
    const sendBack = before.size ? ' If a step you wait for must be redone, report rework with step (one of the steps you wait for) and, in summary, what to fix and how to reproduce it.' : ''
    const text = JSON.stringify({
      ticket_id: ticket.id, step: step.key, title: step.title, spec: step.spec, access: step.access, directory,
      ...source ? { request: source.text.slice(0, REQUEST_CHARS) } : {},
      team: steps.map(item => ({ step: item.key, title: item.title, bot: item.bot.name })),
      ...upstream.length ? { upstream } : {},
      ...rework ? { rework } : {},
      ...step.failures.length && step.attempts - (step.attemptBase ?? 0) > 0 ? { previous_attempt_failed: step.failures.at(-1) } : {},
      rules: (step.access === 'read'
        ? 'Do only this step. It is read-only: you cannot change files, by your shell either. Report with orchestrator_step_report: ready with your result, blocked with one question for a person, failed with why.'
        : 'Do only this step, in the directory above, where you may change files freely; anything outside it asks a person first. Report with orchestrator_step_report: ready with your result, blocked with one question for a person, failed with why.') + sendBack,
    })
    await this.host.sessions.prompt(sessionId, `step:${ticket.id}:${step.key}:${attempt}`, text, 'queue')
  }
  private summarize(ticketId: string): void {
    const steps = this.tables.of(ticketId)
    const lines = steps.map(step => `- ${step.key} ${step.title} · ${step.bot.name} · ${step.state}${step.report ? `: ${step.report.slice(0, 400)}` : ''}`)
    this.note(ticketId, ['All steps of the team finished:', ...lines,
      'Check their results in the directory, then report the ticket with orchestrator_report (ready, blocked or failed).'].join('\n'))
    // Recorded on the first step's row, so the lead is told once, also across a restart.
    this.tables.save({ ...steps[0]!, summarizedAt: now() }, 0)
  }
  private note(ticketId: string, text: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return
    try { this.host.engine.note(ticketId, text) } catch (error) { this.host.warn(`team step note not given: ${String(error)}`) }
  }
  private seq(step: TeamStep): number { return Math.max(0, this.tables.of(step.ticketId).findIndex(item => item.key === step.key)) }
}

/** A tool literal, typed by its schema, as `tool` in tools/tool.ts makes one. */
const tool = <S extends z.ZodType>(definition: { name: string; description: string; schema: S; execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown> }): Tool =>
  definition as unknown as Tool
/**
 * VsSaros addition (2026-11-06): DSH's `llm/stream` waterfall listener that counts the tokens of team step Sessions' model
 * calls (compaction included) through `meter`; every other call, and every chunk, passes through unchanged.
 */
export function stepUsageStream(meter: (sessionId: string, usage: Record<string, number | undefined>) => void) {
  // VsSaros fix (2026-11-06, co-install): a listener that sends a request again as a new call (DS Bot's secrets and image
  // listeners do) passes that call's chunks up through this listener twice, once in each call; a usage chunk is counted once
  // (`meteredStream`). The runtime meters steps through the usage ledger's listener, the same code.
  return meteredStream(sessionId => !!stepOfSession(sessionId), (options, usage) => { meter(options.sessionId, usage) })
}

/** The tools of a step Session: its Bot's report. */
export function stepTools(steps: Pick<TeamSteps, 'report' | 'rework'>, step: Pick<TeamStep, 'ticketId' | 'key'>): Tool[] {
  return [tool({
    name: 'orchestrator_step_report',
    description: 'Report this team step: ready with your result, blocked with one question for a person, failed with why, or rework with step to send a step you wait for back with what to fix. Report once, at the end of the step.',
    schema: z.object({ state: z.enum(['ready', 'blocked', 'failed', 'rework']), summary: z.string().trim().min(1).max(4000),
      step: z.string().trim().min(1).max(24).optional() }).strict(),
    execute: async ({ state, summary, step: target }) => {
      if (state === 'rework') {
        if (!target) throw new Error('rework needs step: the step you wait for that must be redone')
        const sent = await steps.rework(step.ticketId, step.key, target, summary)
        return { step: step.key, state: 'rework', sent_back: sent.key, round: sent.reopened.round,
          note: 'That step runs again with what to fix; then you get your step again to check its new result.' }
      }
      const recorded = await steps.report(step.ticketId, step.key, state, summary)
      // VsSaros fix (2026-11-06, real-machine run): a ready step that went on working (a message steered in after it
      // reported) ran its tools again; it is told to stop here, and its Session's guard refuses tools until it is sent back.
      return { step: recorded.key, state: recorded.state, ...recorded.retried ? { retried: true, note: 'Tried once more: you get the step again.' }
        : recorded.state === 'ready' ? { next: 'Your step is done: end your turn now and call no more tools. If it is sent back, you get it again.' } : {} }
    },
  })]
}
/** The lead's tool on a ticket with a team: send a step's Bot a message, such as a person's answer. */
export function leadTools(steps: Pick<TeamSteps, 'message'>, ticketId: string): Tool[] {
  return [tool({
    name: 'orchestrator_step_message',
    description: 'Send the Bot of one of this ticket\'s team steps a message, such as a person\'s answer to its question; a blocked step runs again.',
    schema: z.object({ step: z.string().trim().min(1).max(24), text: z.string().trim().min(1).max(4000) }).strict(),
    execute: async ({ step, text }) => { const sent = await steps.message(ticketId, step, text); return { step: sent.key, state: sent.state } },
  })]
}
