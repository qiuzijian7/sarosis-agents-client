/**
 * VsSaros addition: the review gate in front of every P4 submit, driven through the panel's real management routes against
 * a simulated P4 server. No test here talks to a real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandError, Commands } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import { fingerprint, parseDiffs, P4ConfigSchema, type ChangeFile } from '../src/sources/p4-change.ts'
import { p4Kind, pollChanges } from '../src/sources/p4.ts'
import { newChange, Reviews, withDescription } from '../src/app/review.ts'
import { Store } from '../src/app/store.ts'
import { join } from 'node:path'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

interface FakeChange { status: 'pending' | 'submitted'; client: string; user: string; desc: string; shelved: ChangeFile[]; files?: ChangeFile[]; submittedAs?: number }
/** A P4 server holding changelists, answering the commands dsh-superagent runs and recording each with its account and workspace. */
class FakeP4 {
  changes = new Map<number, FakeChange>()
  calls: { user?: string; client?: string; args: string[]; input?: string }[] = []
  next = 900
  run(args: string[], input?: string): string {
    const call: FakeP4['calls'][number] = { args: [] }
    let tagged = false, json = false
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!
      if (arg === '-p') index++
      else if (arg === '-u') call.user = args[++index]
      else if (arg === '-c' && !call.args.length) call.client = args[++index]
      else if (arg === '-Mj' && !call.args.length) json = true
      else if (arg === '-ztag' && !call.args.length) tagged = true
      else call.args.push(arg)
    }
    if (input !== undefined) call.input = input
    this.calls.push(call)
    const line = (record: object) => `${JSON.stringify(record)}\n`
    const [command, ...rest] = call.args
    const number = Number(rest.at(-1))
    const change = this.changes.get(number)
    const files = (list: ChangeFile[]) => Object.fromEntries(list.flatMap((file, i) => [[`depotFile${i}`, file.depotFile], [`action${i}`, file.action],
      [`rev${i}`, file.rev], [`type${i}`, file.type], [`digest${i}`, file.digest ?? '']]))
    if (command === 'describe' && rest.includes('-du')) {
      return change ? change.shelved.map(file => `==== ${file.depotFile}#${file.rev} (${file.type}) ====\n\n@@ -1 +1 @@\n-old\n+new ${file.digest}\n`).join('\n') : ''
    }
    if (command === 'describe') {
      if (!change) return line({ data: `Change ${number} unknown.\n`, generic: 2, severity: 3 })
      const head = { change: String(change.submittedAs ?? number), status: change.status, client: change.client, user: change.user, desc: change.desc, time: '1793678561' }
      return line({ ...head, ...files(rest.includes('-S') ? change.shelved : change.files ?? []) })
    }
    if (command === 'change' && rest[0] === '-o') return `Change:\t${number}\n\nClient:\t${change!.client}\n\nUser:\t${change!.user}\n\nStatus:\tpending\n\nDescription:\n${change!.desc.split('\n').map(text => `\t${text}`).join('\n')}\n`
    if (command === 'change' && rest[0] === '-i') {
      const description = /Description:\n((?:\t.*\n?)*)/.exec(input ?? '')?.[1]?.split('\n').map(text => text.slice(1)).join('\n').trimEnd() ?? ''
      if (/^Change:\tnew/m.test(input ?? '')) {
        const created = this.next++
        this.changes.set(created, { status: 'pending', client: call.client!, user: call.user!, desc: description, shelved: [] })
        return line({ data: `Change ${created} created.`, generic: 0, severity: 0 })
      }
      const updated = Number(/^Change:\t(\d+)/m.exec(input ?? '')?.[1])
      this.changes.get(updated)!.desc = description
      return line({ data: `Change ${updated} updated.`, generic: 0, severity: 0 })
    }
    if (command === 'unshelve') { this.changes.get(Number(rest[3]))!.shelved = [...this.changes.get(Number(rest[1]))!.shelved]; return line({ depotFile: 'x', action: 'edit' }) }
    if (command === 'submit') {
      const submitted = this.next++
      Object.assign(this.changes.get(Number(rest[1]))!, { status: 'submitted', submittedAs: submitted })
      return line({ change: rest[1] }) + line({ submittedChange: String(submitted) })
    }
    if (command === 'shelve' && rest[0] === '-d') { this.changes.get(number)!.shelved = []; return line({ change: String(number) }) }
    if (command === 'revert') return line({ data: 'reverted', generic: 0, severity: 0 })
    if (command === 'change' && rest[0] === '-d') { this.changes.delete(number); return line({ data: `Change ${number} deleted.`, generic: 0, severity: 0 }) }
    return json || tagged ? line({ data: `unexpected p4 ${call.args.join(' ')}`, generic: 1, severity: 3 }) : ''
  }
}

const EXEC = 'saros-bot'
// These tests exercise the legacy submit flow; pending-only is the default now.
const base = { port: 'ssl:p4.example.com:1666', user: EXEC, paths: [{ path: '//GR/main/Source/...' }], submit: 'pipeline' }
const SHELF: ChangeFile[] = [{ depotFile: '//GR/main/Source/A.cpp', action: 'edit', rev: '3', type: 'text', digest: 'AB' },
  { depotFile: '//GR/main/Source/B.h', action: 'add', rev: '1', type: 'text', digest: 'CD' }]
let h: Host
let server: FakeP4
function configure(config: Record<string, unknown> = {}) {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings(SettingsSchema.parse({ ...settings, sources: { ...settings.sources, p4: { enabled: true, config: { ...base, ...config } } } }))
}
beforeEach(async () => {
  h = await startRuntime()
  h.runtime.sources.register(p4Kind)
  configure()
  server = new FakeP4()
  const run = vi.mocked(Commands.prototype.run)
  const other = run.getMockImplementation()
  run.mockImplementation(async (program, args, cwd, input) => {
    if (program !== 'p4') return other ? other.call(Commands.prototype, program, args, cwd, input) : '{"ok":true,"data":{}}'
    const output = server.run(args, input)
    if (output.includes('"severity":3')) throw commandError(Object.assign(new Error('p4 exited with code 1'), { code: 1, stdout: output, stderr: '' }), 'p4')
    return output
  })
})
afterEach(async () => { await h.stop() })

/** An accepted ticket whose Executor shelved CL 501 in its workspace, and reported it ready. */
async function shelvedTicket(shelved = SHELF) {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下 4K 下的预览'))
  const name = h.runtime.store.tickets.get(ticket.id)!.execution!.name
  server.changes.set(501, { status: 'pending', client: `superagent-${name}`, user: EXEC, desc: '[SuperAgent] fix preview', shelved })
  return { ticket, sessionId, client: `superagent-${name}` }
}
const report = (sessionId: string) => h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'shelved CL 501', changelist: 501 })
const writes = () => server.calls.filter(call => !['describe'].includes(call.args[0]!) && !(call.args[0] === 'change' && call.args[1] === '-o'))

describe('pending pool handoff', () => {
  async function readyPool() {
    const result = await shelvedTicket()
    const store = h.runtime.store
    store.tickets.save({ ...store.tickets.get(result.ticket.id)!, execution: { ...store.tickets.get(result.ticket.id)!.execution!, p4Delivery: 'submit' } })
    await report(result.sessionId)
    const { TapdConfigSchema } = await import('../src/sources/tapd-api.ts')
    const { poolItemKey, PoolItemSchema } = await import('../src/sources/tapd-filter-schemes.ts')
    const { KV } = await import('../src/kv.ts')
    const triggerId = 'tapd-pool:68880148:alice:bug:1:1', item = PoolItemSchema.parse({ kind: 'bug', id: '1', enabled: true })
    const trigger = { id: triggerId, source: 'tapd', addressed: 'direct' as const, human: false, actor: { source: 'tapd', id: '' },
      threads: [{ source: 'tapd', id: '68880148:bug:1' }], at: new Date().toISOString(), text: '症状',
      meta: { workspace: '68880148', type: 'bug', id: '1', owners: ['甲'], filterPool: 'filter-pool-1', filterSweep: 'filter-pool-1' } }
    store.triggers.save(trigger)
    store.tickets.save({ ...store.tickets.get(result.ticket.id)!, origin: { triggerId, triggerIds: [triggerId] } })
    const settings = store.settings(), config = TapdConfigSchema.parse({ members: [{ alias: 'alice', name: '甲' }], filterPool: { owner: 'alice', items: [item] } })
    store.saveSettings({ ...settings, sources: { ...settings.sources, tapd: { enabled: true, config } } })
    store.set(KV.tapd.pool('filter-pool-1'), { lastRun: '', runIds: [], dispatched: 1, at: '', records: {
      [poolItemKey(config.workspace, 'alice', item)]: { state: 'processing', triggerId, runId: 'r', attempts: 1, lastRunAt: '', item,
        authorization: { authority: 'host_pool', action: 'repair', invocation: 'manual', workspace: config.workspace,
          pool: 'filter-pool-1', itemType: 'bug', itemId: '1', loginName: 'alice', tapdOwner: '甲', runId: 'r', authorizedAt: new Date().toISOString() } }
    } })
    server.calls.length = 0
    return result
  }
  it('completes the ready pool delivery without compile, review or submit, preserves the CL and is idempotent', async () => {
    const { ticket } = await readyPool()
    const finger = h.runtime.reviews.get(ticket.id)!.fingerprint
    await h.runtime.reviews.completeReadyPoolDeliveries()
    const outcome = h.runtime.reviews.get(ticket.id)!
    expect(outcome.state).toBe('delivered_pending')
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
    expect(h.runtime.store.tickets.get(ticket.id)?.execution?.p4Delivery).toBe('pending')
    expect(h.runtime.reviews.held(ticket.id)).toBe(false)
    expect(h.runtime.effects.pending('reportCloud')).toBe(true)
    expect(server.changes.get(501)).toMatchObject({ status: 'pending', shelved: SHELF })
    expect(writes()).toEqual([])
    const entries = h.runtime.reviews.audit().length
    await h.runtime.reviews.completePending(ticket.id, finger)
    expect(h.runtime.reviews.audit()).toHaveLength(entries)
  })
  it('refuses non-pool tickets without P4 side effects', async () => {
    const ordinary = await shelvedTicket(); await report(ordinary.sessionId)
    await expect(h.runtime.reviews.completePending(ordinary.ticket.id, h.runtime.reviews.get(ordinary.ticket.id)!.fingerprint)).rejects.toThrow('TAPD pool')
    expect(writes()).toEqual([])
  })
  it('refuses changed shelves without P4 side effects', async () => {
    const { ticket } = await readyPool()
    const finger = h.runtime.reviews.get(ticket.id)!.fingerprint
    server.changes.get(501)!.shelved = [{ ...SHELF[0]!, digest: 'CHANGED' }]
    await expect(h.runtime.reviews.completePending(ticket.id, finger)).rejects.toThrow('shelf changed')
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    expect(writes()).toEqual([])
  })
})

describe('requesting a review', () => {
  it.each([undefined, null])('keeps the P4 delivery gate after a refused CL, even when the next ready omits it (%s)', async changelist => {
    const { ticket, sessionId } = await shelvedTicket()
    configure({ paths: [] })
    await expect(report(sessionId)).rejects.toThrow(/allowed paths/)
    expect(h.runtime.store.get<number>(`p4-required:${ticket.id}`)).toBe(501)
    await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done without binding', changelist }))
      .rejects.toThrow(/requires a P4 changelist/)
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
    expect(h.runtime.reviews.get(ticket.id)).toBeUndefined()
    await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'P4 paths are not configured', human_action: 'Configure allowed P4 paths' })
    configure()
    expect(await report(sessionId)).toMatchObject({ review: { changelist: 501, state: 'waiting' } })
    expect(writes()).toEqual([])
  })
  it('keeps the gate when P4 is disabled or the reported CL is unknown', async () => {
    const { ticket, sessionId } = await shelvedTicket()
    server.changes.delete(501)
    await expect(report(sessionId)).rejects.toThrow(/does not exist/)
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, p4: { enabled: false, config: base } } })
    await expect(report(sessionId)).rejects.toThrow(/P4 Source is off/)
    await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'no CL' })).rejects.toThrow(/requires a P4 changelist/)
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  })
  it('does not require a CL for a local-only report merely because P4 is enabled with empty paths', async () => {
    configure({ paths: [] })
    const { ticket, sessionId } = await h.acceptedTicket(feishu('local', '@bot 只分析问题，不修改代码'))
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'analysis only' })
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'completed' })
    expect(server.calls).toEqual([])
  })
  it('refuses ready when an opened file is missing from the shelf, but permits a shelf after revert', async () => {
    const { ticket, sessionId } = await shelvedTicket()
    const change = server.changes.get(501)!
    change.files = [...SHELF, { ...SHELF[0]!, depotFile: '//GR/main/Source/Unshelved.cpp' }]
    await expect(report(sessionId)).rejects.toThrow(/not shelved/)
    expect(h.runtime.store.tickets.get(ticket.id)!.follows ?? []).toEqual([])
    change.files = []
    expect(await report(sessionId)).toMatchObject({ review: { changelist: 501, files: SHELF, client: change.client } })
  })
  it('refuses a ready CL without a shelf, and records one with a shelf as waiting, which the review route shows with its differences', async () => {
    const { ticket, sessionId } = await shelvedTicket([])
    // A CL with nothing shelved (here not even opened files) cannot be reviewed.
    await expect(report(sessionId)).rejects.toThrow(/has no files|shelve it before reporting it ready/)
    server.changes.get(501)!.shelved = SHELF
    expect(await report(sessionId)).toMatchObject({ review: { changelist: 501, state: 'waiting' } })
    const { status, body } = await h.api('GET', `tickets/${ticket.id}/review`)
    expect(status).toBe(200)
    expect(body).toMatchObject({ review: { change: 501, state: 'waiting', fingerprint: fingerprint(SHELF) },
      diffs: [{ depotFile: '//GR/main/Source/A.cpp', lines: ['@@ -1 +1 @@', '-old', '+new AB'] }, { depotFile: '//GR/main/Source/B.h' }] })
    expect((await h.api('GET', 'reviews')).body).toMatchObject({ waiting: [{ ticketId: ticket.id }], audit: [{ action: 'requested' }] })
    // Asking for the same shelf again records nothing new.
    await report(sessionId)
    expect(((await h.api('GET', 'reviews')).body.audit as unknown[])).toHaveLength(1)
    expect(writes()).toEqual([])
  })
  it('restores a failed CL delivery requirement from SQLite in a new review service', async () => {
    const { ticket, sessionId } = await shelvedTicket()
    configure({ paths: [] })
    await expect(report(sessionId)).rejects.toThrow(/allowed paths/)
    const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
    try {
      const restored = new Reviews({ store: reopened, engine: h.runtime.engine, p4: h.runtime.context(p4Kind) })
      expect(restored.requiredChangelist(ticket.id)).toBe(501)
      expect(restored.get(ticket.id)).toBeUndefined()
    } finally { reopened.close() }
  })
  it('returns line statistics from the actual shelf differences, including truncation', async () => {
    const { ticket, sessionId } = await shelvedTicket()
    await report(sessionId)
    const view = await h.api('GET', `tickets/${ticket.id}/review`)
    expect(view.body).toMatchObject({ diffSummary: { files: 2, added: 2, removed: 2, hunks: 2, complete: true } })
    const run = vi.mocked(Commands.prototype.run)
    const other = run.getMockImplementation()!
    run.mockImplementation(async (program, args, cwd, input) => args.includes('-du')
      ? `==== ${SHELF[0]!.depotFile}#3 (text) ====\n--- old\n+++ new\n@@ -1 +1 @@\n${'+new\n'.repeat(2100)}`
      : other.call(Commands.prototype, program, args, cwd, input))
    const truncated = await h.api('GET', `tickets/${ticket.id}/review`)
    expect(truncated.body).toMatchObject({ diffSummary: { files: 2, added: 1997, removed: 0, hunks: 1, complete: false } })
  })
  it('gives no agent a tool that approves, rejects, discards or submits', async () => {
    const { sessionId } = await shelvedTicket()
    const names = [...h.tools.get(h.runtime.masterId)!.keys(), ...h.tools.get(sessionId)!.keys()]
    expect(names.filter(name => /approve|reject|discard|submit|review/i.test(name))).toEqual([])
  })
})

describe('approving', () => {
  it('refuses an approval of another fingerprint, and of a shelf that changed since it was reviewed, naming the files, and submits nothing', async () => {
    const { ticket, sessionId } = await shelvedTicket()
    await report(sessionId)
    expect(await h.api('POST', `tickets/${ticket.id}/review/approve`, { fingerprint: '0'.repeat(16) })).toMatchObject({ status: 409, body: { error: expect.stringContaining('open it again') } })
    server.changes.get(501)!.shelved = [SHELF[0]!, { ...SHELF[1]!, digest: 'CE' }]
    const refused = await h.api('POST', `tickets/${ticket.id}/review/approve`, { fingerprint: fingerprint(SHELF) })
    expect(refused).toMatchObject({ status: 409, body: { changed: ['//GR/main/Source/B.h'] } })
    expect(writes()).toEqual([])
    expect(h.runtime.reviews.get(ticket.id)).toMatchObject({ state: 'waiting' })
    expect(h.runtime.reviews.audit().map(entry => entry.action)).toEqual(['requested', 'refused', 'requested'])
  })
  it('hands an approved CL to the server\'s automation by tagging its description as the execution account, and ends the ticket once it is submitted', async () => {
    const { ticket, sessionId } = await shelvedTicket()
    await report(sessionId)
    const { status, body } = await h.api('POST', `tickets/${ticket.id}/review/approve`, { fingerprint: fingerprint(SHELF) })
    expect(status).toBe(200)
    expect(body).toMatchObject({ state: 'handed' })
    expect(writes()).toEqual([expect.objectContaining({ user: EXEC, args: ['change', '-i'] })])
    expect(server.changes.get(501)!.desc).toBe('[SuperAgent] fix preview\n #review #ShelveForSubmit')
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
    // The automation submits it; the p4 Source sees the submit and ends the ticket.
    Object.assign(server.changes.get(501)!, { status: 'submitted', submittedAs: 507 })
    await pollChanges(h.runtime.context(p4Kind), P4ConfigSchema.parse(base))
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'merged' })
  })
  it('submits an approved CL itself in host mode, as the submit account from its workspace, deletes the shelf, and ends the ticket', async () => {
    configure({ submit: 'host', submitUser: 'qiuzijian', submitClient: 'qiuzijian-submit' })
    const { ticket, sessionId, client } = await shelvedTicket()
    await report(sessionId)
    const { body } = await h.api('POST', `tickets/${ticket.id}/review/approve`, { fingerprint: fingerprint(SHELF) })
    expect(body).toMatchObject({ state: 'submitted', submittedAs: 901 })
    expect(writes().map(call => [call.user, call.client, ...call.args])).toEqual([
      ['qiuzijian', 'qiuzijian-submit', 'change', '-i'],
      ['qiuzijian', 'qiuzijian-submit', 'unshelve', '-s', '501', '-c', '900'],
      ['qiuzijian', 'qiuzijian-submit', 'submit', '-c', '900'],
      [EXEC, client, 'shelve', '-d', '-c', '501'],
      [EXEC, client, 'change', '-d', '501'],
    ])
    expect(server.changes.get(900)).toMatchObject({ status: 'submitted', desc: '[SuperAgent] fix preview' })
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'merged' })
    expect(h.runtime.reviews.audit().map(entry => entry.action)).toEqual(['submitted', 'approved', 'requested'])
  })
  it('keeps the review waiting and submits nothing when host mode has no submit account', async () => {
    configure({ submit: 'host' })
    const { ticket, sessionId } = await shelvedTicket()
    await report(sessionId)
    const failed = await h.api('POST', `tickets/${ticket.id}/review/approve`, { fingerprint: fingerprint(SHELF) })
    expect(failed).toMatchObject({ status: 409, body: { error: expect.stringContaining('submit account') } })
    expect(writes()).toEqual([])
    expect(h.runtime.reviews.get(ticket.id)).toMatchObject({ state: 'waiting', error: expect.stringContaining('submit account') })
  })
})

describe('rejecting and discarding', () => {
  it('sends a rejected CL back to the Executor with the comment, and reviews its next shelf anew', async () => {
    const { ticket, sessionId } = await shelvedTicket()
    await report(sessionId)
    expect(await h.api('POST', `tickets/${ticket.id}/review/reject`, { comment: '测试也覆盖 1x 缩放' })).toMatchObject({ status: 200, body: { state: 'rejected' } })
    const inputs = h.runtime.store.tickets.get(ticket.id)!.inputs
    expect(inputs.at(-1)).toMatchObject({ kind: 'note', text: expect.stringContaining('测试也覆盖 1x 缩放') })
    expect(await h.api('POST', `tickets/${ticket.id}/review/approve`, { fingerprint: fingerprint(SHELF) })).toMatchObject({ status: 409 })
    server.changes.get(501)!.shelved = [...SHELF, { depotFile: '//GR/main/Source/Test.cpp', action: 'add', rev: '1', type: 'text', digest: 'EE' }]
    await report(sessionId)
    expect(h.runtime.reviews.get(ticket.id)).toMatchObject({ state: 'waiting', files: expect.arrayContaining([expect.objectContaining({ depotFile: '//GR/main/Source/Test.cpp' })]) })
    expect(writes()).toEqual([])
  })
  it('discards a CL by deleting its shelf, reverting its files and deleting it as the execution account, and stops the ticket', async () => {
    const { ticket, sessionId, client } = await shelvedTicket()
    await report(sessionId)
    expect(await h.api('POST', `tickets/${ticket.id}/review/discard`)).toMatchObject({ status: 200, body: { state: 'discarded' } })
    expect(writes().map(call => [call.user, call.client, ...call.args])).toEqual([
      [EXEC, client, 'shelve', '-d', '-c', '501'], [EXEC, client, 'revert', '-c', '501', '//...'], [EXEC, client, 'change', '-d', '501']])
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
  })
})

describe('holding the ticket while it is reviewed', () => {
  const followup = (id: string, text: string) => feishu(id, text, { mentions: [], root_id: 'om_1', parent_id: 'om_1' })
  /** Everything delivered to the Session, JSON cards and plain notes alike. */
  const delivered = (sessionId: string) => h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId).map(call => call.text)
  it('keeps a person\'s message from the worker while the CL waits for review, and delivers it with the comment once rejected', async () => {
    const { ticket, sessionId } = await shelvedTicket()
    await report(sessionId)
    h.deliveries.mockClear()
    h.runtime.receive(followup('2', '顺便把标题也改了'))
    await h.runtime.idle()
    expect(delivered(sessionId)).toEqual([])
    expect(h.runtime.store.tickets.get(ticket.id)!.undelivered).toHaveLength(1)
    await h.api('POST', `tickets/${ticket.id}/review/reject`, { comment: '标题一起改' })
    await h.runtime.idle()
    expect(delivered(sessionId).join('\n')).toContain('顺便把标题也改了')
    expect(delivered(sessionId).join('\n')).toContain('标题一起改')
    expect(h.runtime.store.tickets.get(ticket.id)!.undelivered).toEqual([])
  })
  it('lets messages through again once an approved CL is handed to the server\'s automation', async () => {
    const { ticket, sessionId } = await shelvedTicket()
    await report(sessionId)
    h.deliveries.mockClear()
    h.runtime.receive(followup('2', '提交前再看一下日志'))
    await h.runtime.idle()
    expect(delivered(sessionId)).toEqual([])
    await h.api('POST', `tickets/${ticket.id}/review/approve`, { fingerprint: fingerprint(SHELF) })
    await h.runtime.idle()
    expect(delivered(sessionId).join('\n')).toContain('提交前再看一下日志')
  })
  it('asks for a fresh review of a shelf that changed during the review, which can then be approved', async () => {
    const { ticket, sessionId } = await shelvedTicket()
    await report(sessionId)
    const changed = [SHELF[0]!, { ...SHELF[1]!, digest: 'CE' }]
    server.changes.get(501)!.shelved = changed
    expect(await h.api('POST', `tickets/${ticket.id}/review/approve`, { fingerprint: fingerprint(SHELF) })).toMatchObject({ status: 409 })
    expect(h.runtime.reviews.get(ticket.id)).toMatchObject({ state: 'waiting', fingerprint: fingerprint(changed) })
    expect(await h.api('POST', `tickets/${ticket.id}/review/approve`, { fingerprint: fingerprint(changed) })).toMatchObject({ status: 200, body: { state: 'handed' } })
  })
})

describe('forms and differences', () => {
  it('replaces the Description of a changelist form, and writes a new changelist\'s form', () => {
    const form = 'Change:\t501\n\nClient:\tc\n\nUser:\tu\n\nStatus:\tpending\n\nDescription:\n\tfix\n\tmore\n\nJobs:\n\tjob1\n'
    expect(withDescription(form, 'fix\n #review')).toBe('Change:\t501\n\nClient:\tc\n\nUser:\tu\n\nStatus:\tpending\n\nDescription:\n\tfix\n\t #review\n\nJobs:\n\tjob1\n')
    expect(newChange('ws', 'me', 'a\nb')).toBe('Change:\tnew\n\nClient:\tws\n\nUser:\tme\n\nStatus:\tnew\n\nDescription:\n\ta\n\tb\n')
  })
  it('splits `p4 describe -S -du` into files, as the real server prints it, and cuts a long one', () => {
    const text = 'Change 1 by u@c on 2026/11/03 *pending*\n\n\tfix\n\nShelved files ...\n\n... //GR/main/Source/A.cpp#10 edit\n\nDifferences ...\n\n'
      + '==== //GR/main/Source/A.cpp#10 (unicode) ====\n\n@@ -57,7 +57,8 @@\n );\n+static int32 G = 0;\n\n==== //GR/main/Content/M.uasset#2 (binary+F) ====\n\n'
    expect(parseDiffs(text)).toEqual([{ depotFile: '//GR/main/Source/A.cpp', rev: '10', type: 'unicode', lines: ['@@ -57,7 +57,8 @@', ' );', '+static int32 G = 0;'] },
      { depotFile: '//GR/main/Content/M.uasset', rev: '2', type: 'binary+F', lines: [] }])
    expect(parseDiffs('==== //a#1 (text) ====\n+1\n+2\n+3\n', 2)).toEqual([{ depotFile: '//a', rev: '1', type: 'text', lines: ['+1', '+2'], truncated: true }])
  })
})
