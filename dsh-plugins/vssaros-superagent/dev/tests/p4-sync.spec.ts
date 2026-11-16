import { describe, expect, it, vi } from 'vitest'
import { P4ConfigSchema } from '../src/sources/p4-change.ts'
import { P4ConflictError, syncP4Workspace } from '../src/executor/p4-sync.ts'
import { WorkspaceError } from '../src/executor/workspace.ts'

// These cases exercise the opt-in sync itself; the source default is off (asserted below).
const config = (overrides: Record<string, unknown> = {}) => P4ConfigSchema.parse({
  cli: 'p4', port: 'ssl:p4.test:1666', user: 'bot', paths: [{ path: '//GR/main/Engine/...' }, { path: '//GR/main/Game/...' }],
  syncBeforeWork: true, ...overrides,
})
const line = (record: Record<string, unknown>) => JSON.stringify(record)
const info = (data: string) => line({ data, generic: 17, severity: 2 })

/** Simulates p4 -Mj -ztag output for the four commands; `calls` records argv minus the frozen global flags. */
function stand(answers: Partial<Record<'preview' | 'diff' | 'sync' | 'resolve' | 'fstat', string>> = {}) {
  const calls: string[][] = []
  const run = vi.fn(async (argv: string[], cwd: string) => {
    expect(cwd).toBe('F:\\ws')
    expect(argv.slice(0, 9)).toEqual(['p4', '-p', 'ssl:p4.test:1666', '-u', 'bot', '-c', 'main', '-Mj', '-ztag'])
    const rest = argv.slice(9)
    calls.push(rest)
    if (rest[0] === 'sync' && rest.includes('-n')) return answers.preview ?? info('file(s) up-to-date.\n')
    if (rest[0] === 'diff') return answers.diff ?? ''
    if (rest[0] === 'sync') return answers.sync ?? ''
    if (rest[0] === 'resolve') return answers.resolve ?? info('No file(s) to resolve.\n')
    return answers.fstat ?? info('file(s) not opened on this client.\n')
  })
  return { run, calls }
}

const invoke = (run: ReturnType<typeof stand>['run'], overrides: Record<string, unknown> = {}) =>
  syncP4Workspace(config(overrides), 'main', 'F:\\ws', run)

describe('Host-owned P4 pre-work sync', () => {
  it('syncs only allowed paths to head and auto-merges, without force or accept flags', async () => {
    const { run, calls } = stand({ preview: line({ depotFile: '//GR/main/Engine/A.cpp', action: 'updated', clientFile: 'F:\\ws\\A.cpp' }),
      diff: '', fstat: '' })
    await invoke(run)
    expect(calls.map(args => args[0])).toEqual(['sync', 'diff', 'sync', 'resolve', 'fstat'])
    expect(calls[0]).toEqual(['sync', '-n', '//GR/main/Engine/...', '//GR/main/Game/...'])
    expect(calls[2]).toEqual(['sync', '-q', '//GR/main/Engine/...', '//GR/main/Game/...'])
    expect(calls[3]).toEqual(['resolve', '-am', '//GR/main/Engine/...', '//GR/main/Game/...'])
    expect(calls[4]).toEqual(['fstat', '-Ru', '-T', 'depotFile,clientFile', '//GR/main/Engine/...', '//GR/main/Game/...'])
    expect(calls.flat()).not.toEqual(expect.arrayContaining(['-f', '-af', '-at', '-ay']))
  })

  it('does not run diff -se when the workspace is already up to date', async () => {
    const { run, calls } = stand()
    await invoke(run)
    expect(calls.map(args => args[0])).not.toContain('diff')
    expect(calls[0]).toContain('-n')
  })

  it('stops before overwriting an unopened local edit that sync would clobber', async () => {
    const { run, calls } = stand({ preview: line({ depotFile: '//GR/main/Engine/A.cpp', action: 'updated' }),
      diff: line({ depotFile: '//GR/main/Engine/A.cpp', clientFile: 'F:\\ws\\A.cpp' }) })
    const error: P4ConflictError = await invoke(run).then(() => { throw new Error('expected a conflict') }, reason => reason as P4ConflictError)
    expect(error).toBeInstanceOf(P4ConflictError)
    expect(error.message).toContain('A.cpp')
    expect(error.files).toEqual(['//GR/main/Engine/A.cpp'])
    expect(calls.map(args => args[0])).toEqual(['sync', 'diff'])
  })

  it('stops with the unresolved files when an automatic merge leaves conflicts', async () => {
    const { run } = stand({ fstat: line({ depotFile: '//GR/main/Game/B.cpp', clientFile: 'F:\\ws\\B.cpp' }) })
    await expect(invoke(run)).rejects.toThrow(/合并冲突.*B\.cpp/)
  })

  it('turns a clobber/resolve error into a conflict and reports other failures as workspace errors', async () => {
    expect(config().syncBeforeWork).toBe(true)
    const clobber = vi.fn(async () => { throw new Error('can\'t clobber writable file B.cpp') })
    await expect(invoke(clobber)).rejects.toBeInstanceOf(P4ConflictError)
    const broken = vi.fn(async () => { throw new Error('connection refused') })
    await expect(invoke(broken)).rejects.toBeInstanceOf(WorkspaceError)
    await expect(invoke(broken)).rejects.not.toBeInstanceOf(P4ConflictError)
    const severity = vi.fn(async () => info('ok') + '\n' + line({ data: 'access denied', severity: 3 }))
    await expect(invoke(severity)).rejects.toThrow('access denied')
  })

  it('runs no p4 command when the operator disabled pre-work sync', async () => {
    const { run } = stand()
    await invoke(run, { syncBeforeWork: false })
    expect(run).not.toHaveBeenCalled()
  })

  it('defaults pre-work sync to off, so a fresh deployment never walks the tree', async () => {
    expect(P4ConfigSchema.parse({}).syncBeforeWork).toBe(false)
    const { run } = stand()
    await syncP4Workspace(P4ConfigSchema.parse({ port: 'ssl:p4.test:1666', user: 'bot',
      paths: [{ path: '//GR/main/Engine/...' }] }), 'main', 'F:\\ws', run)
    expect(run).not.toHaveBeenCalled()
  })
})
