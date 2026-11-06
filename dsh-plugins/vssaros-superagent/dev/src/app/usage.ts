/**
 * VsSaros addition (2026-11-06, P2 · usage ledger, after DS Bot's `usage.js`): every model call of SuperAgent's own Sessions —
 * the main Session, the supervisor desk, each ticket's worker (or coordinator) and each team step — with its tokens, kept in
 * `usage_call` for `USAGE_KEEP_DAYS` days. One `llm/stream` listener feeds it and the team's token budget (`TeamSteps.meter`),
 * so a call is counted once in both. A call another listener sends again as a new call (DS Bot does) is counted once too.
 *
 * Billable input is input + cache reads + cache writes (DSH's `TokenUsage` counts them apart).
 */
import type { DatabaseSync } from 'node:sqlite'

export const USAGE_KEEP_DAYS = 30
export type UsageRole = 'master' | 'desk' | 'worker' | 'step'
/** Whose a Session is: its role, and its ticket, step and Bot when it has them. */
export interface UsageOwner { role: UsageRole; ticketId?: string; step?: string; bot?: string }
export interface UsageTokens { input: number; cacheRead: number; cacheWrite: number; output: number }
export interface UsageCall extends UsageOwner, UsageTokens {
  at: string; session: string; provider: string; model: string
  /** DSH's purpose of an auxiliary call (`compaction`, `title`, …); unset for a conversation turn. */
  purpose?: string
}
export interface UsageTotals extends UsageTokens { calls: number; total: number }
export interface UsageSummary {
  since: string
  total: UsageTotals
  byRole: Record<UsageRole, UsageTotals>
  byModel: ({ provider: string; model: string } & UsageTotals)[]
  byBot: ({ bot: string } & UsageTotals)[]
  byTicket: ({ ticketId: string } & UsageTotals)[]
}
/** What the ledger reads of DSH's stream options. */
export interface StreamOptions { sessionId?: string; provider?: string; model?: string; purpose?: string }
type UsageChunk = { type?: string; usage?: Record<string, number | undefined> }

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
/** DSH's usage chunk as this ledger's tokens. */
export function tokensOf(usage: Record<string, number | undefined>): UsageTokens {
  return { input: count(usage.inputTokens), cacheRead: count(usage.cacheReadTokens), cacheWrite: count(usage.cacheWriteTokens), output: count(usage.outputTokens) }
}
const totalOf = (tokens: UsageTokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output

/**
 * DSH's `llm/stream` waterfall listener that hands each usage chunk of the Sessions `own` accepts to `onUsage`, once, and
 * passes every chunk on unchanged. Every other call passes through untouched.
 */
export function meteredStream(own: (sessionId: string) => boolean, onUsage: (options: StreamOptions & { sessionId: string }, usage: Record<string, number | undefined>) => void) {
  const counted = new WeakSet<object>()
  return (options: StreamOptions | undefined, next: () => unknown): unknown => {
    const sessionId = options?.sessionId
    if (!sessionId || !own(sessionId)) return next()
    const result = next()
    const iterate = async function* (stream: AsyncIterable<UsageChunk>) {
      for await (const chunk of stream) {
        if (chunk?.type === 'usage' && chunk.usage && !counted.has(chunk)) {
          counted.add(chunk)
          try { onUsage({ ...options, sessionId }, chunk.usage) } catch { /* metering never breaks a turn */ }
        }
        yield chunk
      }
    }
    if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') return iterate(result as AsyncIterable<never>)
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (async function* () { yield* iterate(await (result as Promise<AsyncIterable<never>>)) })()
    }
    return result
  }
}

const empty = (): UsageTotals => ({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 })
const add = (into: UsageTotals, call: UsageTokens) => {
  into.calls += 1; into.input += call.input; into.cacheRead += call.cacheRead; into.cacheWrite += call.cacheWrite; into.output += call.output
  into.total += totalOf(call)
}

/** The ledger. `owner` says whose a Session is, or undefined for one that is not SuperAgent's. */
export class UsageLedger {
  constructor(private readonly db: DatabaseSync, readonly owner: (sessionId: string) => UsageOwner | undefined, private readonly now: () => number = Date.now) {
    db.exec('CREATE TABLE IF NOT EXISTS usage_call (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, session TEXT NOT NULL, value TEXT NOT NULL)')
    db.exec('CREATE INDEX IF NOT EXISTS usage_call_at ON usage_call (at)')
    db.exec('CREATE INDEX IF NOT EXISTS usage_call_session ON usage_call (session, id)')
    this.prune()
  }
  /** The `llm/stream` listener; `also` hears each counted call too (the team's token budget). */
  listener(also?: (call: UsageCall) => void) {
    return meteredStream(id => this.owner(id) !== undefined, (options, usage) => {
      const call = this.record(options, usage)
      if (call) also?.(call)
    })
  }
  /** Records one call's usage. @returns the call, or undefined when its Session is not SuperAgent's or it used nothing. */
  record(options: StreamOptions & { sessionId: string }, usage: Record<string, number | undefined>): UsageCall | undefined {
    const owner = this.owner(options.sessionId)
    const tokens = tokensOf(usage)
    if (!owner || !totalOf(tokens)) return undefined
    const call: UsageCall = { at: new Date(this.now()).toISOString(), session: options.sessionId, ...owner, provider: options.provider ?? '',
      model: options.model ?? '', ...options.purpose ? { purpose: options.purpose } : {}, ...tokens }
    this.db.prepare('INSERT INTO usage_call (at, session, value) VALUES (?,?,?)').run(call.at, call.session, JSON.stringify(call))
    return call
  }
  /** The latest conversation call of a Session (no auxiliary purpose): what its context held then. */
  last(sessionId: string): UsageCall | undefined {
    for (const row of this.db.prepare('SELECT value FROM usage_call WHERE session=? ORDER BY id DESC LIMIT 20').all(sessionId)) {
      const call = JSON.parse(String(row.value)) as UsageCall
      if (!call.purpose) return call
    }
    return undefined
  }
  /** Totals since `since` (ISO), by role, model, Bot and ticket (the 20 largest of each). */
  summary(since: string): UsageSummary {
    const total = empty(), byRole = { master: empty(), desk: empty(), worker: empty(), step: empty() } as Record<UsageRole, UsageTotals>
    const models = new Map<string, { provider: string; model: string } & UsageTotals>(), bots = new Map<string, { bot: string } & UsageTotals>()
    const tickets = new Map<string, { ticketId: string } & UsageTotals>()
    for (const row of this.db.prepare('SELECT value FROM usage_call WHERE at >= ?').all(since)) {
      const call = JSON.parse(String(row.value)) as UsageCall
      add(total, call)
      add(byRole[call.role] ??= empty(), call)
      const modelKey = `${call.provider}/${call.model}`
      add(models.get(modelKey) ?? models.set(modelKey, { provider: call.provider, model: call.model, ...empty() }).get(modelKey)!, call)
      if (call.bot) add(bots.get(call.bot) ?? bots.set(call.bot, { bot: call.bot, ...empty() }).get(call.bot)!, call)
      if (call.ticketId) add(tickets.get(call.ticketId) ?? tickets.set(call.ticketId, { ticketId: call.ticketId, ...empty() }).get(call.ticketId)!, call)
    }
    const top = <T extends UsageTotals>(map: Map<string, T>) => [...map.values()].sort((a, b) => b.total - a.total).slice(0, 20)
    return { since, total, byRole, byModel: top(models), byBot: top(bots), byTicket: top(tickets) }
  }
  /** Drops calls older than `USAGE_KEEP_DAYS`. */
  prune(): void {
    this.db.prepare('DELETE FROM usage_call WHERE at < ?').run(new Date(this.now() - USAGE_KEEP_DAYS * 86_400_000).toISOString())
  }
}
