/**
 * VsSaros addition (2026-11-06, P2 · context governance, after DS Bot's steward): the main Session and the supervisor desk are
 * the two Sessions SuperAgent never replaces, so their context only grows. DSH's compaction shrinks it at a step boundary once
 * it passes its pressure line (80% of the usable window) — which may be in the middle of evaluating a new message. The
 * steward compacts them while they are idle instead, once their context passes a lower check line (`STEWARD_CHECK_RATIO`
 * of the usable window), through DSH's own `compactNow`.
 *
 * Taken from DS Bot: the check line under the hard line, and acting when the Session goes idle. Not taken: DS Bot's choice
 * between compacting and switching to a new Session part with a handoff note, as these two Sessions keep their ids (the
 * main Session's is `masterId`), and its own checkpoint summarizer (DSH's summary stays).
 *
 * The context is read from the usage ledger's last conversation call of the Session; the window from DSH's model info. A
 * model whose window DSH does not know is left to DSH. After a compaction or a failed one, a Session waits
 * `STEWARD_COOLDOWN_MS` before the next.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UsageCall } from './usage.ts'

export const STEWARD_CHECK_RATIO = 0.6
/** The output a model is assumed to keep room for when DSH gives no default. */
export const STEWARD_OUTPUT_RESERVE = 32_000
export const STEWARD_COOLDOWN_MS = 10 * 60_000
export const STEWARD_TIMEOUT_MS = 180_000

export type StewardOutcome = 'compacted' | 'below' | 'unknown' | 'cooldown' | 'busy' | 'unavailable' | 'nothing' | 'failed'
export type StewardRole = 'master' | 'desk'
export interface StewardView { session: string; role: StewardRole; at: string; outcome: StewardOutcome; context?: number; line?: number; detail?: string }
interface Compactor { compactNow(agent: Agent, signal: AbortSignal): Promise<unknown> }
export interface StewardHost {
  /** Which of the Sessions it looks after this one is, or undefined. */
  watched(sessionId: string): StewardRole | undefined
  last(sessionId: string): UsageCall | undefined
  /** The model's window and its default output cap, when DSH knows them. */
  modelWindow(provider: string, model: string): Promise<{ window: number; maxOutput?: number } | undefined>
  compactor(agent: Agent): Compactor | undefined
  info(message: string): void
  warn(message: string): void
  now?(): number
}

/** The check line of a window: `STEWARD_CHECK_RATIO` of what is left once the output's room is kept. */
export function checkLineOf(window: number, maxOutput = STEWARD_OUTPUT_RESERVE): number {
  const usable = Math.max(window / 2, window - Math.max(0, maxOutput))
  return Math.floor(usable * STEWARD_CHECK_RATIO)
}
/** What a call left in the context for the next one: its whole input and its answer. */
export const contextOf = (call: UsageCall) => call.input + call.cacheRead + call.cacheWrite + call.output

/** Compacts the Sessions it looks after while they are idle, once past their check line (see the module comment). */
export class ContextSteward {
  private readonly views = new Map<string, StewardView>()
  private readonly waitUntil = new Map<string, number>()
  private readonly running = new Set<string>()
  private readonly now: () => number
  constructor(private readonly host: StewardHost) { this.now = host.now ?? Date.now }

  /** What it last did for each Session it looks after, for the panel. */
  list(): StewardView[] { return [...this.views.values()] }

  /** Looks at a Session that just went idle; compacts it when its context passed the check line. */
  async consider(agent: Agent): Promise<StewardOutcome> {
    const id = agent.id
    if (!this.host.watched(id) || this.running.has(id)) return 'busy'
    this.running.add(id)
    try {
      const outcome = await this.decide(agent)
      return outcome
    } finally { this.running.delete(id) }
  }
  private async decide(agent: Agent): Promise<StewardOutcome> {
    const id = agent.id, at = this.now(), role = this.host.watched(id)!
    const say = (outcome: StewardOutcome, extra: Partial<StewardView> = {}) => {
      this.views.set(id, { session: id, role, at: new Date(at).toISOString(), outcome, ...extra })
      return outcome
    }
    const last = this.host.last(id)
    if (!last) return say('unknown')
    const known = await this.host.modelWindow(last.provider, last.model).catch(() => undefined)
    if (!known?.window) return say('unknown', { context: contextOf(last) })
    const context = contextOf(last), line = checkLineOf(known.window, known.maxOutput)
    if (context < line) return say('below', { context, line })
    if ((this.waitUntil.get(id) ?? 0) > at) return say('cooldown', { context, line })
    if (agent.status !== 'idle') return say('busy', { context, line })
    const compactor = this.host.compactor(agent)
    if (typeof compactor?.compactNow !== 'function') return say('unavailable', { context, line })
    this.waitUntil.set(id, at + STEWARD_COOLDOWN_MS)
    try {
      const result = await compactor.compactNow(agent, AbortSignal.timeout(STEWARD_TIMEOUT_MS))
      if (!result) return say('nothing', { context, line })
      this.host.info(`dsh-superagent: compacted ${id} while idle (${context} tokens of context, check line ${line})`)
      return say('compacted', { context, line })
    } catch (error) {
      const detail = String((error as Error)?.message ?? error).slice(0, 300)
      this.host.warn(`dsh-superagent: idle compaction of ${id} failed: ${detail}`)
      return say('failed', { context, line, detail })
    }
  }
}
