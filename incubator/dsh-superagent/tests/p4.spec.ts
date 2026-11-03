/** VsSaros addition: the p4 Source's changelist rules, with records shaped as the real server's `p4 -Mj -ztag` prints them. */
import { describe, expect, it } from 'vitest'
import { commandError, type Commands } from '../src/infra/commands.ts'
import { claimChangelist, fingerprint, filesOf, inPath, observeChange, p4, P4ConfigSchema, p4Configured, readChange, type Change }
  from '../src/sources/p4-change.ts'
import { p4Kind } from '../src/sources/p4.ts'
import type { SourceContext } from '../src/sources/host.ts'

const config = P4ConfigSchema.parse({ port: 'ssl:p4.example.com:1666', user: 'saros-bot', paths: [{ path: '//GR/main/Source/...' }, { path: '//GR/main/Config/*.ini' }] })
/** A Commands stand-in answering `p4 -Mj -ztag <args>` by the subcommand and its arguments. */
function commands(answer: (args: string[]) => string, calls: string[][] = []): Commands {
  return { run: async (program: string, args: string[]) => { calls.push([program, ...args]); return answer(args.slice(args.indexOf('-ztag') + 1)) } } as unknown as Commands
}
const line = (record: object) => `${JSON.stringify(record)}\n`
const unknown = (number: number) => Object.assign(new Error('p4 exited with code 1'), { code: 1, stderr: '', stdout: line({ data: `Change ${number} unknown.\n`, generic: 2, severity: 3 }) })

describe('p4 records', () => {
  it('passes the server and account, and returns data records without the messages', async () => {
    const calls: string[][] = []
    const records = await p4(commands(() => line({ change: '7' }) + line({ data: 'a note', severity: 1 }) + line({ change: '8' }), calls), config, ['changes'])
    expect(records).toEqual([{ change: '7' }, { change: '8' }])
    expect(calls[0]).toEqual(['p4', '-p', 'ssl:p4.example.com:1666', '-u', 'saros-bot', '-Mj', '-ztag', 'changes'])
  })
  it('fails with the server\'s message, which `p4 -Mj` prints on stdout with nothing on stderr', async () => {
    await expect(p4(commands(() => line({ data: 'Your session has expired, please login again.\n', severity: 3 })), config, ['info'])).rejects.toThrow('Your session has expired')
    expect(commandError(unknown(9), 'p4').message).toBe('Change 9 unknown.')
  })
  it('numbers the files of a describe record as the server does', () => {
    expect(filesOf({ change: '1', depotFile0: '//GR/main/Source/A.cpp', action0: 'edit', rev0: '10', type0: 'unicode', digest0: '0990', depotFile1: '//GR/main/Source/B.h', action1: 'add', rev1: '1', type1: 'text' }))
      .toEqual([{ depotFile: '//GR/main/Source/A.cpp', action: 'edit', rev: '10', type: 'unicode', digest: '0990' }, { depotFile: '//GR/main/Source/B.h', action: 'add', rev: '1', type: 'text' }])
  })
})

describe('changelists', () => {
  it('reads a pending CL with its shelf, a submitted one by the number it had, and none for an unknown number', async () => {
    const pending = commands(args => args.includes('-S')
      ? line({ change: '501', status: 'pending', client: 'superagent-fix', user: 'saros-bot', desc: 'fix', time: '1', depotFile0: '//GR/main/Source/A.cpp', action0: 'edit', rev0: '3', type0: 'text', digest0: 'AB' })
      : line({ change: '501', status: 'pending', client: 'superagent-fix', user: 'saros-bot', desc: 'fix', time: '1' }))
    expect(await readChange(pending, config, 501)).toMatchObject({ number: 501, current: 501, status: 'pending', shelved: [{ depotFile: '//GR/main/Source/A.cpp', digest: 'AB' }] })
    const submitted = commands(() => line({ change: '507', oldChange: '501', status: 'submitted', client: 'superagent-fix', user: 'saros-bot', desc: 'fix', time: '1793678561' }))
    expect(await readChange(submitted, config, 501)).toMatchObject({ number: 501, current: 507, status: 'submitted' })
    const gone = { run: async () => { throw commandError(unknown(501), 'p4') } } as unknown as Commands
    expect(await readChange(gone, config, 501)).toBeUndefined()
  })
  it('matches depot paths with ... and *', () => {
    expect(inPath('//GR/main/Source/Editor/A.cpp', '//GR/main/Source/...')).toBe(true)
    expect(inPath('//GR/main/Config/Game.ini', '//GR/main/Config/*.ini')).toBe(true)
    expect(inPath('//GR/main/Config/Sub/Game.ini', '//GR/main/Config/*.ini')).toBe(false)
    expect(inPath('//GR/main/SourceX/A.cpp', '//GR/main/Source/...')).toBe(false)
    expect(inPath('//gr/main/source/A.cpp', '//GR/main/Source/...')).toBe(false)
    expect(inPath('//gr/main/source/A.cpp', '//GR/main/Source/...', false)).toBe(true)
  })
  it('fingerprints a shelf by its files, actions and contents, in any order', () => {
    const a = { depotFile: '//GR/main/Source/A.cpp', action: 'edit', rev: '3', type: 'text', digest: 'AB' }
    const b = { depotFile: '//GR/main/Source/B.h', action: 'add', rev: '1', type: 'text', digest: 'CD' }
    expect(fingerprint([a, b])).toBe(fingerprint([b, a]))
    expect(fingerprint([a, { ...b, digest: 'CE' }])).not.toBe(fingerprint([a, b]))
    expect(fingerprint([a, { ...b, action: 'edit' }])).not.toBe(fingerprint([a, b]))
    expect(fingerprint([a])).toMatch(/^[0-9a-f]{16}$/)
  })
  it('counts the Source as set up only with a server, an execution account and a path', () => {
    expect(p4Configured(config)).toBe(true)
    expect(p4Configured(P4ConfigSchema.parse({ port: 'p4:1666', user: 'saros-bot' }))).toBe(false)
    expect(p4Kind.find?.('CL 501')).toEqual({ threads: ['p4:501'], terms: [] })
    expect(p4Kind.find?.('501')).toEqual({ threads: [], terms: [] })
  })
})

describe('binding a changelist to a ticket', () => {
  interface FakeTicket { id: string; execution: { name: string }; follows: { thread: string; own?: boolean; closed?: { at: string } }[]; ended?: { outcome: string } }
  function host(tickets: FakeTicket[]) {
    const closed: unknown[] = []
    const ctx = {
      atomic: <T>(work: () => T) => work(),
      tickets: {
        get: (id: string) => tickets.find(item => item.id === id),
        open: () => tickets.filter(item => !item.ended),
        bindThread: (id: string, thread: { source: string; id: string }, own: boolean) => { tickets.find(item => item.id === id)!.follows.push({ thread: `${thread.source}:${thread.id}`, own }) },
        threadClosed: (...args: unknown[]) => { closed.push(args) },
      },
      threads: { patch: () => {}, describe: () => {} },
    } as unknown as SourceContext
    return { ctx, closed }
  }
  const change = (overrides: Partial<Change> = {}): Change => ({ number: 501, current: 501, status: 'pending', client: 'superagent-fix-dpi', user: 'saros-bot', description: 'fix', time: '1793678561',
    files: [], shelved: [{ depotFile: '//GR/main/Source/A.cpp', action: 'edit', rev: '3', type: 'text', digest: 'AB' }], ...overrides })
  it('binds the execution account\'s pending CL from the ticket\'s workspace as the ticket\'s own Thread', () => {
    const ticket: FakeTicket = { id: 't1', execution: { name: 'fix-dpi' }, follows: [] }
    const { ctx } = host([ticket])
    expect(claimChangelist(ctx, config, 't1', change())).toBeUndefined()
    expect(ticket.follows).toEqual([{ thread: 'p4:501', own: true }])
    // Reporting it again binds nothing more.
    expect(claimChangelist(ctx, config, 't1', change())).toBeUndefined()
    expect(ticket.follows).toHaveLength(1)
  })
  it('refuses a CL that is not pending, not the execution account\'s, from another workspace, outside the paths, empty, or another ticket\'s', () => {
    const ticket: FakeTicket = { id: 't1', execution: { name: 'fix-dpi' }, follows: [] }
    const other: FakeTicket = { id: 't2', execution: { name: 'other' }, follows: [{ thread: 'p4:777', own: true }] }
    const { ctx } = host([ticket, other])
    expect(claimChangelist(ctx, config, 't1', change({ status: 'submitted' }))).toContain('is submitted')
    expect(claimChangelist(ctx, config, 't1', change({ user: 'qiuzijian' }))).toContain('belongs to qiuzijian')
    expect(claimChangelist(ctx, config, 't1', change({ client: 'GR_qiuzijian_main' }))).toContain('ends with -fix-dpi')
    expect(claimChangelist(ctx, config, 't1', change({ shelved: [{ depotFile: '//GR/main/Content/Map.umap', action: 'edit', rev: '1', type: 'binary' }] }))).toContain('outside the allowed paths: //GR/main/Content/Map.umap')
    expect(claimChangelist(ctx, config, 't1', change({ shelved: [] }))).toContain('has no files')
    expect(claimChangelist(ctx, config, 't1', change({ number: 777 }))).toContain('another active ticket')
    expect(ticket.follows).toEqual([])
  })
  it('reports a submitted CL as merged and a deleted one as closed to the tickets following it, and a pending one not at all', () => {
    const ticket: FakeTicket = { id: 't1', execution: { name: 'fix-dpi' }, follows: [{ thread: 'p4:501', own: true }] }
    const { ctx, closed } = host([ticket])
    expect(observeChange(ctx, 501, change())).toBe(false)
    expect(observeChange(ctx, 501, change({ status: 'submitted', current: 507 }))).toBe(true)
    expect(closed).toEqual([[{ source: 'p4', id: '501' }, 'merged', new Date(1793678561_000).toISOString()]])
    expect(observeChange(ctx, 501, undefined)).toBe(true)
    expect((closed.at(-1) as unknown[]).slice(0, 2)).toEqual([{ source: 'p4', id: '501' }, 'closed'])
  })
})
