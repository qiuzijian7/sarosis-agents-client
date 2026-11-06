/**
 * VsSaros addition (superagent v2, P4): hands each finished team step's evidence to the VsSaros memory system, which
 * distills it (`@vssaros/dsh-agents` lib/stepMemory.js; 2026-11-06: with a model, a similar skill becoming a new version,
 * its risk graded — lib/core/skillDistill.js). superagent only sends evidence: it writes no skill itself. superagent decides only how deep: a step that took at least
 * `SKILL_TURNS` turns, failed once or was given again is `skill` (a fact and a skill draft owned by its Bot, which a person
 * approves); any other is `facts` (one line in its Bot's memory, no model call, no skill). Each handover is recorded in
 * `team_distill` and retried until the memory system takes it, so a Host that starts the Bots later loses nothing.
 */
import type { Store } from './store.ts'
import { stepSessionId, type TeamStep } from './steps.ts'

export const SKILL_TURNS = 3
const RETRY_MS = 60_000, ATTEMPTS = 5
export const MEMORY_BUS_KEY = Symbol.for('vssaros.memory')

export interface StepEvidence {
  requestId: string; botId: string; botName: string; ticketId: string; ticketTitle: string; stepKey: string; stepTitle: string
  spec: string; outcome: 'ready' | 'failed'; mode: 'skill' | 'facts'; turns: number; attempts: number; failures: string[]
  report: string; request?: string; at: string
  /** VsSaros addition (2026-11-06): the step's Session, whose model the memory system distills the skill with. */
  sessionId?: string
}
/**
 * VsSaros change (2026-11-06, v2 §7): the memory system distills a skill with a model, makes a similar one a new version
 * of it (`updates`), and grades its risk; `distilled: false` (with `distillError`) when no model could, and the draft is
 * the evidence put together by template.
 */
export interface RememberResult {
  fact: { ok: boolean; message: string; duplicate?: boolean }
  skill?: { name: string; path: string; created: boolean; state: 'draft' | 'active' | 'rejected'
    version?: number; risk?: 'low' | 'medium' | 'high'; riskReasons?: string[]; distilled?: boolean; updates?: 'active' | 'draft'
    model?: string; distillError?: string }
}
/** The memory bus of `@vssaros/dsh-agents` (lib/memoryBus.js), when that plugin runs in this process. */
export interface MemoryBus {
  version: number
  available(): boolean
  rememberStep(evidence: StepEvidence): Promise<RememberResult>
  decideSkillDraft(name: string, decision: 'approve' | 'reject'): Promise<{ name: string; state: string }>
}
export const sharedMemoryBus = (): MemoryBus | undefined => {
  const bus = (globalThis as unknown as Record<symbol, MemoryBus | undefined>)[MEMORY_BUS_KEY]
  return bus && bus.version >= 1 ? bus : undefined
}

export interface Distill {
  id: string; ticketId: string; stepKey: string; botId: string; botName: string; stepTitle: string
  mode: 'skill' | 'facts'; reasons: string[]
  state: 'pending' | 'sent' | 'failed'; attempts: number; error?: string
  result?: RememberResult; evidence: StepEvidence; at: string; sentAt?: string
}

/** How deep a step's evidence is distilled, and why (the thresholds the person set: ≥3 turns, a failure, or a retry). */
export function distillMode(step: Pick<TeamStep, 'turns' | 'failures' | 'attempts'>): { mode: 'skill' | 'facts'; reasons: string[] } {
  const reasons = [...step.turns >= SKILL_TURNS ? [`${step.turns} turns`] : [], ...step.failures.length ? [`${step.failures.length} failed attempt(s)`] : [],
    ...step.attempts > 1 ? [`given ${step.attempts} times`] : []]
  return { mode: reasons.length ? 'skill' : 'facts', reasons }
}

export interface DistillerHost {
  store: Pick<Store, 'db' | 'tickets' | 'triggers'>
  bus?: () => MemoryBus | undefined
  warn(message: string): void
}

/** Records and delivers team step evidence to the memory system, and relays a person's decision on a skill draft. */
export class Distiller {
  private delivering = false
  constructor(private readonly host: DistillerHost) {
    host.store.db.exec('CREATE TABLE IF NOT EXISTS team_distill (id TEXT PRIMARY KEY, ticket TEXT NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL)')
  }
  private bus(): MemoryBus | undefined { return (this.host.bus ?? sharedMemoryBus)() }

  /** A step ended ready or failed for good: record its evidence once, and deliver it. Stopped and skipped steps leave none. */
  async stepEnded(step: TeamStep): Promise<Distill | undefined> {
    if (step.state !== 'ready' && step.state !== 'failed') return undefined
    const id = `distill:${step.ticketId}:${step.key}`
    if (this.get(id)) return this.get(id)
    const ticket = this.host.store.tickets.get(step.ticketId)
    const request = ticket ? this.host.store.triggers.get(ticket.origin.triggerId)?.text : undefined
    const { mode, reasons } = distillMode(step)
    const at = new Date().toISOString()
    const evidence: StepEvidence = { requestId: id, botId: step.bot.id, botName: step.bot.name, ticketId: step.ticketId,
      ticketTitle: ticket?.title ?? step.ticketId, stepKey: step.key, stepTitle: step.title, spec: step.spec, outcome: step.state,
      mode, turns: step.turns, attempts: step.attempts, failures: step.failures, report: step.report ?? '', ...request ? { request: request.slice(0, 2000) } : {}, at,
      sessionId: stepSessionId(step.ticketId, step.key) }
    this.save({ id, ticketId: step.ticketId, stepKey: step.key, botId: step.bot.id, botName: step.bot.name, stepTitle: step.title, mode, reasons,
      state: 'pending', attempts: 0, evidence, at })
    await this.deliver(id)
    return this.get(id)
  }
  /** Delivers every pending record, oldest first; one that keeps failing is marked failed after `ATTEMPTS` tries. */
  async deliverPending(): Promise<void> {
    if (this.delivering) return
    this.delivering = true
    try { for (const record of this.list('pending').reverse()) await this.deliver(record.id) } finally { this.delivering = false }
  }
  /** A person approved or rejected the skill draft a record produced; the memory system moves or deletes it. */
  async decide(id: string, decision: 'approve' | 'reject'): Promise<Distill> {
    const record = this.get(id)
    if (!record?.result?.skill || record.result.skill.state !== 'draft') throw new Error(`No skill draft waits on ${id}`)
    const bus = this.bus()
    if (!bus?.available()) throw new Error('The VsSaros memory system is not running in this Host')
    const decided = await bus.decideSkillDraft(record.result.skill.name, decision)
    const state = decided.state === 'active' ? 'active' : 'rejected'
    // Other records that pointed at the same draft follow the decision.
    for (const other of this.list()) {
      if (other.result?.skill?.name === record.result.skill.name && other.result.skill.state === 'draft') {
        this.save({ ...other, result: { ...other.result, skill: { ...other.result.skill, state } } })
      }
    }
    return this.get(id)!
  }
  /** Retries pending records periodically; returns the dispose. */
  install(): () => void {
    void this.deliverPending()
    const timer = setInterval(() => { void this.deliverPending() }, RETRY_MS)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }
  get(id: string): Distill | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM team_distill WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as Distill : undefined
  }
  /** Records, newest first, optionally of one state. */
  list(state?: Distill['state'], limit = 200): Distill[] {
    const rows = state ? this.host.store.db.prepare('SELECT value FROM team_distill WHERE state=? ORDER BY at DESC LIMIT ?').all(state, limit)
      : this.host.store.db.prepare('SELECT value FROM team_distill ORDER BY at DESC LIMIT ?').all(limit)
    return rows.map(row => JSON.parse(String(row.value)) as Distill)
  }
  private async deliver(id: string): Promise<void> {
    const record = this.get(id)
    if (!record || record.state !== 'pending') return
    const bus = this.bus()
    if (!bus?.available()) return
    try {
      const result = await bus.rememberStep(record.evidence)
      this.save({ ...record, state: 'sent', attempts: record.attempts + 1, result, sentAt: new Date().toISOString() })
    } catch (error) {
      const attempts = record.attempts + 1, message = String((error as Error)?.message ?? error).slice(0, 300)
      this.save({ ...record, attempts, error: message, state: attempts >= ATTEMPTS ? 'failed' : 'pending' })
      this.host.warn(`team step ${record.stepKey} evidence not taken by the memory system (${attempts}/${ATTEMPTS}): ${message}`)
    }
  }
  private save(record: Distill): void {
    this.host.store.db.prepare('INSERT INTO team_distill VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, value=excluded.value')
      .run(record.id, record.ticketId, record.state, JSON.stringify(record), record.at)
  }
}
