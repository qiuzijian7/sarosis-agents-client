/** Bounded opt-in metadata ledger for native and PTC tool calls. No raw parameters, results, scripts or error messages. */
import { createHmac, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'

export const TOOL_TRACE_ROWS = 10_000, TOOL_TRACE_DAYS = 7
export interface TraceOwner { role: 'master' | 'desk' | 'worker' | 'coordinator' | 'step' | 'subagent'; ticketId?: string; step?: string }
export interface TraceExecution { callId: string; rootCallId?: string; token: object; parent?: object; name: string; arguments: unknown;
  agent?: { id: string; session: { id: string; header?: { parentSession?: string } } }; signal: AbortSignal }
export interface ToolTraceRow extends TraceOwner {
  id: number; at: string; session: string; name: string; callId: string; rootCallId: string; parentCallId: string | null;
  durationMs: number | null; inputBytes: number | null; outputBytes: number | null; parameterDigest: string | null; isError: boolean; cancelled: boolean
}
export interface ToolTraceView {
  enabled: boolean; retentionDays: number; maxRows: number; nextCursor: number | null; items: ToolTraceRow[];
  summary: { sampled: number; rootCalls: number; nestedCalls: number; errors: number; sameInputRepeats: number }
}
export interface ToolTraceQuery { ticketId?: string; beforeId?: number; limit?: number }
interface Start { started: number; owner: TraceOwner; session: string; callId: string; rootCallId: string; name: string;
  parentCallId: string | null; inputBytes: number | null; parameterDigest: string | null }

/** Sort JSON keys for equality diagnostics; cap work and fail to unknown, never truncate-and-hash distinct inputs together. */
function encode(value: unknown): string | undefined {
  let visited = 0, chars = 0
  const walk = (current: unknown, depth: number): unknown => {
    if (++visited > 20_000 || depth > 30) throw new Error('too large')
    if (typeof current === 'string') { chars += current.length; if (chars > 1_000_000) throw new Error('too large'); return current }
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'number' && Number.isFinite(current)) return current
    if (Array.isArray(current)) return current.map(item => walk(item, depth + 1))
    if (current && typeof current === 'object') return Object.fromEntries(Object.keys(current).sort().map(key => {
      chars += key.length; if (chars > 1_000_000) throw new Error('too large')
      return [key, walk((current as Record<string, unknown>)[key], depth + 1)]
    }))
    throw new Error('not JSON')
  }
  try { return JSON.stringify(walk(value, 0)) } catch { return undefined }
}

/** Observes shared dispatch outcomes and persists bounded metadata without affecting tool decisions. */
export class ToolTrace {
  private readonly pending = new Map<object, Start>()
  private readonly tokens = new WeakMap<object, string>()
  private readonly completed = new WeakSet<object>()
  private readonly secret: string
  constructor(private readonly store: Pick<Store, 'db' | 'get' | 'set' | 'atomic'>, private readonly enabled: () => boolean,
    private readonly owner: (session: string, execution: TraceExecution) => TraceOwner | undefined, private readonly clock = Date.now) {
    this.secret = store.get(KV.trace.key) ?? randomBytes(32).toString('hex')
    store.atomic(() => {
      store.set(KV.trace.key, this.secret)
      store.db.exec('CREATE TABLE IF NOT EXISTS tool_trace (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, session TEXT NOT NULL, ticket TEXT, value TEXT NOT NULL)')
      store.db.exec('CREATE INDEX IF NOT EXISTS tool_trace_ticket ON tool_trace(ticket, id)')
      store.db.exec('CREATE INDEX IF NOT EXISTS tool_trace_at ON tool_trace(at)')
      this.prune()
    })
  }
  private capture(execution: TraceExecution): Start | undefined {
    const session = execution.agent?.session.id
    if (!session) return undefined
    const owner = this.owner(session, execution)
    if (!owner) return undefined
    const input = encode(execution.arguments)
    return { started: performance.now(), owner, session, callId: String(execution.callId), rootCallId: String(execution.rootCallId ?? execution.callId),
      name: execution.name, parentCallId: execution.parent ? this.tokens.get(execution.parent) ?? null : null,
      inputBytes: input === undefined ? null : Buffer.byteLength(input),
      parameterDigest: input === undefined ? null : createHmac('sha256', this.secret).update(input).digest('hex') }
  }
  start(execution: TraceExecution): void {
    if (!this.enabled() || this.pending.has(execution.token) || this.completed.has(execution.token)) return
    const start = this.capture(execution)
    if (!start) return
    this.tokens.set(execution.token, start.callId)
    if (this.pending.size >= 2048) this.pending.delete(this.pending.keys().next().value!)
    this.pending.set(execution.token, start)
  }
  finish(execution: TraceExecution, result: { isError: boolean; content: unknown }): void {
    const started = this.pending.get(execution.token)
    this.pending.delete(execution.token)
    if (!this.enabled() || this.completed.has(execution.token)) return
    const entry = started ?? this.capture(execution)
    if (!entry) return
    this.completed.add(execution.token)
    const content = encode(result.content)
    const value: Omit<ToolTraceRow, 'id'> = { at: new Date(this.clock()).toISOString(), session: entry.session, ...entry.owner,
      name: entry.name, callId: entry.callId, rootCallId: entry.rootCallId, parentCallId: entry.parentCallId,
      durationMs: started ? Math.max(0, Math.round(performance.now() - entry.started)) : null,
      inputBytes: entry.inputBytes, outputBytes: content === undefined ? null : Buffer.byteLength(content), parameterDigest: entry.parameterDigest,
      isError: result.isError, cancelled: execution.signal.aborted }
    this.store.atomic(() => {
      this.store.db.prepare('INSERT INTO tool_trace(at, session, ticket, value) VALUES (?,?,?,?)').run(value.at, value.session, value.ticketId ?? null, JSON.stringify(value))
      this.prune()
    })
  }
  install(ctx: Context): () => void {
    const events = ctx as unknown as {
      on(name: 'tools/pre-execute', listener: (execution: TraceExecution, next: () => Promise<unknown>) => Promise<unknown>, options: { global: boolean; prepend?: boolean }): () => void
      on(name: 'tools/result', listener: (execution: TraceExecution, result: { isError: boolean; content: unknown }) => undefined, options: { global: boolean }): () => void
    }
    const pre = events.on('tools/pre-execute', async (execution: TraceExecution, next: () => Promise<unknown>) => {
      try { this.start(execution) } catch { /* Observability must not change tool outcomes. */ }
      return next()
    }, { global: true, prepend: true })
    const post = events.on('tools/result', (execution: TraceExecution, result: { isError: boolean; content: unknown }) => {
      try { this.finish(execution, result) } catch { /* No payload is logged on observation failure. */ }
      return undefined
    }, { global: true })
    return () => { pre(); post(); this.pending.clear() }
  }
  private prune(): void {
    this.store.db.prepare('DELETE FROM tool_trace WHERE at < ?').run(new Date(this.clock() - TOOL_TRACE_DAYS * 86_400_000).toISOString())
    this.store.db.prepare('DELETE FROM tool_trace WHERE id <= (SELECT MAX(id) - ? FROM tool_trace)').run(TOOL_TRACE_ROWS)
  }
  view(query: ToolTraceQuery = {}): ToolTraceView {
    const limit = Math.max(1, Math.min(100, query.limit ?? 50))
    const rows = this.store.db.prepare('SELECT id,value FROM tool_trace WHERE (? IS NULL OR ticket=?) AND id < ? AND at >= ? ORDER BY id DESC LIMIT ?')
      .all(query.ticketId ?? null, query.ticketId ?? null, query.beforeId ?? Number.MAX_SAFE_INTEGER,
        new Date(this.clock() - TOOL_TRACE_DAYS * 86_400_000).toISOString(), limit + 1)
    const items = rows.slice(0, limit).map(row => ({ ...JSON.parse(String(row.value)), id: Number(row.id) }) as ToolTraceRow)
    const groups = new Set<string>()
    let sameInputRepeats = 0
    for (const item of items) {
      if (!item.parameterDigest || item.name === 'run_code') continue
      const key = JSON.stringify([item.session, item.name, item.parameterDigest])
      if (groups.has(key)) sameInputRepeats++; else groups.add(key)
    }
    return { enabled: this.enabled(), retentionDays: TOOL_TRACE_DAYS, maxRows: TOOL_TRACE_ROWS,
      nextCursor: rows.length > limit ? items.at(-1)!.id : null, items,
      summary: { sampled: items.length, rootCalls: items.filter(row => row.rootCallId === row.callId).length,
        nestedCalls: items.filter(row => row.rootCallId !== row.callId).length, errors: items.filter(row => row.isError).length, sameInputRepeats } }
  }
}
