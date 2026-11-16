import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { ToolTrace, type TraceExecution } from '../src/app/tool-trace.ts'
import { KV } from '../src/kv.ts'

let root: string, store: Store, enabled: boolean, now: number, trace: ToolTrace
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superagent-trace-')); store = new Store(join(root, 'state.sqlite'))
  enabled = true; now = Date.now()
  trace = new ToolTrace(store, () => enabled, session => session === 'worker-t' ? { role: 'worker', ticketId: 't' } : undefined, () => now)
})
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
const call = (name = 'read', args: unknown = { path: '秘密.txt' }, extra: Partial<TraceExecution> = {}): TraceExecution => ({
  name, arguments: args, callId: 'call', token: {}, agent: { id: 'worker-t', session: { id: 'worker-t' } },
  signal: new AbortController().signal, ...extra,
})
const result = { isError: false, content: [{ type: 'text', text: 'secret-output' }] }

it('is off by default and excludes foreign sessions', () => {
  enabled = false
  trace.start(call()); trace.finish(call(), result)
  enabled = true
  trace.finish(call('read', {}, { agent: { id: 'foreign', session: { id: 'foreign' } } }), result)
  expect(trace.view().items).toEqual([])
})

it('records HMAC metadata with UTF-8 byte lengths and normalized parameter equality, never raw values', () => {
  const first = call('read', { token: 'secret-key', path: '秘密.txt' }), second = call('read', { path: '秘密.txt', token: 'secret-key' }, { callId: 'next' })
  trace.start(first); trace.finish(first, result); trace.finish(first, result)
  trace.start(second); trace.finish(second, result)
  const view = trace.view()
  expect(view.items).toHaveLength(2)
  expect(view.items[0]!.parameterDigest).toBe(view.items[1]!.parameterDigest)
  expect(view.items[0]!.inputBytes).toBe(Buffer.byteLength(JSON.stringify(first.arguments)))
  expect(view.items[0]!.outputBytes).toBe(Buffer.byteLength(JSON.stringify(result.content)))
  expect(view.summary.sameInputRepeats).toBe(1)
  const saved = JSON.stringify(store.db.prepare('SELECT value FROM tool_trace').all())
  for (const secret of ['secret-key', '秘密.txt', 'secret-output']) expect(saved).not.toContain(secret)
  expect(JSON.stringify(view)).not.toContain(store.get(KV.trace.key))
})

it('correlates outer and nested calls and records error/cancellation once', () => {
  const parent = call('run_code', { code: 'private program' }, { callId: 'root', rootCallId: 'root' })
  const cancel = new AbortController()
  const child = call('grep', {}, { callId: 'child', rootCallId: 'root', parent: parent.token, signal: cancel.signal })
  trace.start(parent); trace.start(child); cancel.abort()
  trace.finish(child, { isError: true, content: [] }); trace.finish(parent, result)
  expect(trace.view().items).toEqual(expect.arrayContaining([expect.objectContaining({ callId: 'child', parentCallId: 'root', cancelled: true })]))
  expect(trace.view().summary).toMatchObject({ rootCalls: 1, nestedCalls: 1, errors: 1 })
})

it('does not give undefined or non-finite invalid inputs the same fingerprint as JSON null', () => {
  for (const arguments_ of [undefined, NaN, Infinity]) {
    const execution = call('read', {}, { arguments: arguments_ })
    trace.finish(execution, { isError: true, content: [] })
    expect(trace.view().items[0]).toMatchObject({ inputBytes: null, parameterDigest: null })
  }
  trace.finish(call('read', null), result)
  expect(trace.view().items[0]!.inputBytes).toBe(4)
  expect(trace.view().items[0]!.parameterDigest).not.toBeNull()
})

it('supports final failures that never reached pre-execute without inventing a duration', () => {
  trace.finish(call(), { isError: true, content: [] })
  expect(trace.view().items[0]!.durationMs).toBeNull()
})

it('keeps fingerprints stable across Store reopen and honors cursor/ticket filters', () => {
  trace.finish(call(), result)
  const digest = trace.view().items[0]!.parameterDigest
  store.close(); store = new Store(join(root, 'state.sqlite'))
  trace = new ToolTrace(store, () => true, () => ({ role: 'worker', ticketId: 't' }))
  trace.finish(call(), result)
  const page = trace.view({ limit: 1, ticketId: 't' })
  expect(page.items[0]!.parameterDigest).toBe(digest)
  expect(trace.view({ limit: 1, beforeId: page.nextCursor! }).items).toHaveLength(1)
  expect(trace.view({ ticketId: 'other' }).items).toEqual([])
})

it('prunes row and age limits continuously and treats huge inputs as unknown, not truncated fingerprints', () => {
  const insert = store.db.prepare('INSERT INTO tool_trace(at,session,ticket,value) VALUES (?,?,?,?)')
  store.atomic(() => { for (let i = 0; i < 10005; i++) insert.run(new Date(now).toISOString(), 'worker-t', 't', '{}') })
  trace.finish(call('read', { huge: 'x'.repeat(1_000_001) }), result)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM tool_trace').get()!.n).toBe(10000)
  expect(trace.view({ limit: 1 }).items[0]).toMatchObject({ inputBytes: null, parameterDigest: null })
  now += 8 * 86_400_000
  trace.finish(call(), result)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM tool_trace').get()!.n).toBe(1)
})

it('observes shared pipeline events without changing the next decision, and detaches on disposal', async () => {
  const ctx = new Context()
  const release = trace.install(ctx), execution = call()
  const events = ctx as unknown as { waterfall(name: string, ...args: unknown[]): Promise<unknown>; emit(name: string, ...args: unknown[]): void }
  const decision = { kind: 'allow' }
  expect(await events.waterfall('tools/pre-execute', execution, async () => decision)).toEqual(decision)
  events.emit('tools/result', execution, result)
  expect(trace.view().items).toHaveLength(1)
  release()
  events.emit('tools/result', call(), result)
  expect(trace.view().items).toHaveLength(1)
})
