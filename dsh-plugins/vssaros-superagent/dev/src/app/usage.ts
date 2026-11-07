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
/**
 * VsSaros addition (2026-11-07, P0 · co-install observability): how another plugin's listener made a call while one of this
 * Session's calls was under way. DS Bot does both on every Session (`coexist.ts`):
 * - `resent`: the same model, the request sent again as a new call (its `secrets` rewrite, its `images` text instead of images);
 * - `side`: another model, called on the side (its OCR reading the request's images).
 */
export type UsageRelay = 'resent' | 'side'
export interface UsageCall extends UsageOwner, UsageTokens {
  at: string; session: string; provider: string; model: string
  /** DSH's purpose of an auxiliary call (`compaction`, `title`, …); unset for a conversation turn. */
  purpose?: string
  /** Set on a call another listener made inside one of this Session's calls. */
  relay?: UsageRelay
}
export interface UsageTotals extends UsageTokens { calls: number; total: number }
/** Calls another listener made inside a Session's calls: `resent` and `side` counts, by Session. */
export interface UsageRelays {
  resent: number; side: number
  sessions: ({ session: string; role: UsageRole; ticketId?: string; step?: string; resent: number; side: number })[]
}
export interface UsageSummary {
  since: string
  total: UsageTotals
  byRole: Record<UsageRole, UsageTotals>
  byModel: ({ provider: string; model: string } & UsageTotals)[]
  byBot: ({ bot: string } & UsageTotals)[]
  byTicket: ({ ticketId: string } & UsageTotals)[]
  relays: UsageRelays
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
 *
 * VsSaros addition (2026-11-07): it tells a call another listener made inside one of the Session's calls (`UsageRelay`): one
 * that starts while a call of the same Session and purpose runs. Registered first (`prepend`), it is the outermost listener,
 * so a listener that sends a request again through the whole waterfall, as DS Bot's do, passes through it again. A `side`
 * call `refuse` names a reason for is refused (its stream throws); DS Bot then tells the model the image could not be read.
 */
export function meteredStream(own: (sessionId: string) => boolean,
  onUsage: (options: StreamOptions & { sessionId: string; relay?: UsageRelay }, usage: Record<string, number | undefined>) => void,
  hooks: { refuse?(options: StreamOptions & { sessionId: string }): string | undefined } = {}) {
  const counted = new WeakSet<object>()
  /** The calls under way, by Session and purpose, outermost first. */
  const active = new Map<string, StreamOptions[]>()
  const keyOf = (options: StreamOptions) => `${options.sessionId}\u0000${options.purpose ?? ''}`
  const relayOf = (options: StreamOptions): UsageRelay | undefined => {
    const outer = active.get(keyOf(options))?.[0]
    if (!outer) return undefined
    return (outer.provider ?? '') === (options.provider ?? '') && (outer.model ?? '') === (options.model ?? '') ? 'resent' : 'side'
  }
  const refusal = (options: StreamOptions & { sessionId: string }) => relayOf(options) === 'side' ? hooks.refuse?.(options) : undefined
  const refused = (reason: string) => (async function* (): AsyncGenerator<never> { throw new Error(reason) })()
  return (options: StreamOptions | undefined, next: () => unknown): unknown => {
    const sessionId = options?.sessionId
    if (!sessionId || !own(sessionId)) return next()
    // A side call that starts while the Session's call streams (DS Bot's OCR) is known here, before the model is asked.
    const early = refusal({ ...options, sessionId })
    if (early) return refused(early)
    const result = next()
    const iterate = async function* (stream: AsyncIterable<UsageChunk>) {
      // A request sent again at once (DS Bot's secrets) is known only once its stream is read, inside the outer one.
      const relay = relayOf(options)
      const late = refusal({ ...options, sessionId })
      if (late) throw new Error(late)
      const key = keyOf(options), stack = active.get(key) ?? []
      stack.push(options)
      active.set(key, stack)
      try {
        for await (const chunk of stream) {
          if (chunk?.type === 'usage' && chunk.usage && !counted.has(chunk)) {
            counted.add(chunk)
            try { onUsage({ ...options, sessionId, ...relay ? { relay } : {} }, chunk.usage) } catch { /* metering never breaks a turn */ }
          }
          yield chunk
        }
      } finally {
        stack.splice(stack.lastIndexOf(options), 1)
        if (!stack.length) active.delete(key)
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
/** The relayed calls among `calls`, counted by Session (the 20 with the most). */
export function relaysOf(calls: readonly UsageCall[]): UsageRelays {
  const sessions = new Map<string, UsageRelays['sessions'][number]>()
  let resent = 0, side = 0
  for (const call of calls) {
    if (!call.relay) continue
    if (call.relay === 'resent') resent += 1; else side += 1
    const item = sessions.get(call.session) ?? sessions.set(call.session, { session: call.session, role: call.role,
      ...call.ticketId ? { ticketId: call.ticketId } : {}, ...call.step ? { step: call.step } : {}, resent: 0, side: 0 }).get(call.session)!
    item[call.relay] += 1
  }
  return { resent, side, sessions: [...sessions.values()].sort((a, b) => b.resent + b.side - a.resent - a.side).slice(0, 20) }
}
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
  /**
   * The `llm/stream` listener; `also` hears each counted call too (the team's token budget). `refuse` names why a `side`
   * call of a Session is refused (`executor.sideCalls` off), or undefined to let it run.
   */
  listener(also?: (call: UsageCall) => void, refuse?: (sessionId: string) => string | undefined) {
    return meteredStream(id => this.owner(id) !== undefined, (options, usage) => {
      const call = this.record(options, usage)
      if (call) also?.(call)
    }, { refuse: options => refuse?.(options.sessionId) })
  }
  /** Records one call's usage. @returns the call, or undefined when its Session is not SuperAgent's or it used nothing. */
  record(options: StreamOptions & { sessionId: string; relay?: UsageRelay }, usage: Record<string, number | undefined>): UsageCall | undefined {
    const owner = this.owner(options.sessionId)
    const tokens = tokensOf(usage)
    if (!owner || !totalOf(tokens)) return undefined
    const call: UsageCall = { at: new Date(this.now()).toISOString(), session: options.sessionId, ...owner, provider: options.provider ?? '',
      model: options.model ?? '', ...options.purpose ? { purpose: options.purpose } : {}, ...options.relay ? { relay: options.relay } : {}, ...tokens }
    this.db.prepare('INSERT INTO usage_call (at, session, value) VALUES (?,?,?)').run(call.at, call.session, JSON.stringify(call))
    return call
  }
  /** The latest conversation call of a Session (no auxiliary purpose, not another model's side call): what its context held then. */
  last(sessionId: string): UsageCall | undefined {
    for (const row of this.db.prepare('SELECT value FROM usage_call WHERE session=? ORDER BY id DESC LIMIT 20').all(sessionId)) {
      const call = JSON.parse(String(row.value)) as UsageCall
      if (!call.purpose && call.relay !== 'side') return call
    }
    return undefined
  }
  /** VsSaros addition (2026-11-07): the calls other listeners made inside a ticket's Sessions (its worker and its steps), kept days. */
  relaysOf(ticketId: string): UsageRelays {
    const rows = this.db.prepare('SELECT value FROM usage_call WHERE session = ? OR session LIKE ?').all(`worker-${ticketId}`, `step-${ticketId}-%`)
    return relaysOf(rows.map(row => JSON.parse(String(row.value)) as UsageCall))
  }
  /** Totals since `since` (ISO), by role, model, Bot and ticket (the 20 largest of each). */
  summary(since: string): UsageSummary {
    const total = empty(), byRole = { master: empty(), desk: empty(), worker: empty(), step: empty() } as Record<UsageRole, UsageTotals>
    const models = new Map<string, { provider: string; model: string } & UsageTotals>(), bots = new Map<string, { bot: string } & UsageTotals>()
    const tickets = new Map<string, { ticketId: string } & UsageTotals>()
    const calls: UsageCall[] = []
    for (const row of this.db.prepare('SELECT value FROM usage_call WHERE at >= ?').all(since)) {
      const call = JSON.parse(String(row.value)) as UsageCall
      calls.push(call)
      add(total, call)
      add(byRole[call.role] ??= empty(), call)
      const modelKey = `${call.provider}/${call.model}`
      add(models.get(modelKey) ?? models.set(modelKey, { provider: call.provider, model: call.model, ...empty() }).get(modelKey)!, call)
      if (call.bot) add(bots.get(call.bot) ?? bots.set(call.bot, { bot: call.bot, ...empty() }).get(call.bot)!, call)
      if (call.ticketId) add(tickets.get(call.ticketId) ?? tickets.set(call.ticketId, { ticketId: call.ticketId, ...empty() }).get(call.ticketId)!, call)
    }
    const top = <T extends UsageTotals>(map: Map<string, T>) => [...map.values()].sort((a, b) => b.total - a.total).slice(0, 20)
    return { since, total, byRole, byModel: top(models), byBot: top(bots), byTicket: top(tickets), relays: relaysOf(calls) }
  }
  /** Drops calls older than `USAGE_KEEP_DAYS`. */
  prune(): void {
    this.db.prepare('DELETE FROM usage_call WHERE at < ?').run(new Date(this.now() - USAGE_KEEP_DAYS * 86_400_000).toISOString())
  }
}
