import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { P4ConfigSchema } from '../src/sources/p4-change.ts'
import { verifyP4Workspace } from '../src/executor/p4-workspace.ts'
let directory = ''
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = '' })
it('does not scan unopened differences by default, while still protecting foreign opened files', async () => {
  directory = await mkdtemp(join(tmpdir(), 'p4-no-diff-scan-'))
  const file = join(directory, 'A.cpp'); await writeFile(file, 'source')
  const config = P4ConfigSchema.parse({ port: 'ssl:p4.test:1666', user: 'bot', paths: [{ path: '//GR/main/...' }],
    workspaceMode: 'current', executionClient: 'main', workspaceRoot: directory })
  expect(config.checkUnopenedDiffs).toBe(false)
  const ticket = { id: 't1', execution: { name: 'fix', directory, delivery: 'p4',
    p4Workspace: { client: 'main', root: directory, port: config.port, user: config.user } }, follows: [] } as unknown as Ticket
  const run = vi.fn(async (args: string[]) => {
    if (args.includes('client')) return JSON.stringify({ Client: 'main', Owner: 'bot', Root: directory })
    if (args.includes('login')) return JSON.stringify({ User: 'bot' })
    if (args.includes('opened')) return ''
    if (args.includes('diff')) return JSON.stringify({ depotFile: '//GR/main/Generated.pyc' })
    if (args.includes('fstat')) return JSON.stringify({ depotFile: '//GR/main/A.cpp', clientFile: file, haveRev: '1' })
    throw new Error('unexpected call')
  })
  await verifyP4Workspace(ticket, config, run)
  expect(run.mock.calls.some(([args]) => args.includes('diff'))).toBe(false)
  const strict = { ...config, checkUnopenedDiffs: true }
  await expect(verifyP4Workspace(ticket, strict, run)).rejects.toThrow(/1 个未签出差异.*生成物 1.*Generated\.pyc/)
  expect(run.mock.calls.some(([args]) => args.includes('diff') && args.includes('-se'))).toBe(true)
  run.mockClear()
  run.mockImplementation(async (args: string[]) => {
    if (args.includes('client')) return JSON.stringify({ Client: 'main', Owner: 'bot', Root: directory })
    if (args.includes('login')) return JSON.stringify({ User: 'bot' })
    if (args.includes('opened')) return JSON.stringify({ depotFile: '//GR/main/A.cpp', change: '777' })
    return ''
  })
  await expect(verifyP4Workspace(ticket, strict, run)).rejects.toThrow('未归属本单')
  expect(run.mock.calls.some(([args]) => args.includes('diff'))).toBe(false)
})

it('accepts the explicitly configured current client without a ticket suffix, but protects existing edits', async () => {
  directory = await mkdtemp(join(tmpdir(), 'p4-current-'))
  const file = join(directory, 'A.cpp'); await writeFile(file, 'source')
  const config = P4ConfigSchema.parse({ port: 'ssl:p4.test:1666', user: 'bot', paths: [{ path: '//GR/main/...' }],
    workspaceMode: 'current', executionClient: 'main', workspaceRoot: directory })
  const ticket = { id: 't1', execution: { name: 'fix', directory, delivery: 'p4',
    p4Workspace: { client: 'main', root: directory, port: config.port, user: config.user } }, follows: [] } as unknown as Ticket
  let opened = '', dirty = ''
  const run = vi.fn(async (args: string[]) => {
    if (args.includes('client')) return JSON.stringify({ Client: 'main', Owner: 'bot', Root: directory })
    if (args.includes('login')) return JSON.stringify({ User: 'bot' })
    if (args.includes('opened')) return opened
    if (args.includes('diff')) return dirty
    if (args.includes('fstat')) return JSON.stringify({ depotFile: '//GR/main/A.cpp', clientFile: file, haveRev: '1' })
    throw new Error('unexpected call')
  })
  await verifyP4Workspace(ticket, config, run)
  expect(run.mock.calls.some(([args]) => args.includes('clients') || args.includes('sync') || args.includes('edit'))).toBe(false)
  opened = JSON.stringify({ depotFile: '//GR/main/A.cpp', change: '777' })
  await expect(verifyP4Workspace(ticket, config, run)).rejects.toThrow('未归属本单')
  ticket.follows = [{ thread: 'p4:777', own: true }]
  await verifyP4Workspace(ticket, config, run)
  dirty = JSON.stringify({ depotFile: '//GR/main/B.cpp' })
  await verifyP4Workspace(ticket, config, run)
  await expect(verifyP4Workspace(ticket, { ...config, checkUnopenedDiffs: true }, run)).rejects.toThrow('未签出差异')
  await expect(verifyP4Workspace(ticket, { ...config, executionClient: 'other' }, run)).rejects.toThrow('配置已改变')
})

it('permits only verified earlier pending delivery files without adopting or reverting them', async () => {
  const { fingerprint } = await import('../src/sources/p4-change.ts')
  directory = await mkdtemp(join(tmpdir(), 'p4-retained-'))
  const file = join(directory, 'B.cpp'); await writeFile(file, 'source')
  const config = P4ConfigSchema.parse({ port: 'ssl:p4.test:1666', user: 'bot', paths: [{ path: '//GR/main/...' }],
    workspaceMode: 'current', executionClient: 'main', workspaceRoot: directory })
  const ticket = { id: 'next', execution: { name: 'fix', directory, delivery: 'p4', p4Workspace: { client: 'main', root: directory, port: config.port, user: config.user } }, follows: [] } as unknown as Ticket
  const files = [{ depotFile: '//GR/main/A.cpp', action: 'edit', rev: '1', type: 'text', digest: 'AB' }]
  const retained = [{ ticketId: 'previous', change: 501, files, fingerprint: fingerprint(files) }]
  let change = '501', digest = 'AB'
  const run = vi.fn(async (args: string[]) => {
    if (args.includes('client')) return JSON.stringify({ Client: 'main', Owner: 'bot', Root: directory })
    if (args.includes('login')) return JSON.stringify({ User: 'bot' })
    if (args.includes('opened')) return JSON.stringify({ depotFile: '//GR/main/A.cpp', change, action: 'edit' })
    if (args.includes('describe')) return JSON.stringify({ status: 'pending', client: 'main', user: 'bot', desc: '[dsh-superagent:previous]', depotFile0: '//GR/main/A.cpp', action0: 'edit', rev0: '1', type0: 'text', digest0: digest })
    if (args.includes('fstat')) return JSON.stringify({ depotFile: '//GR/main/B.cpp', clientFile: file, haveRev: '1' })
    throw new Error('unexpected command')
  })
  await verifyP4Workspace(ticket, config, run, retained)
  expect(run.mock.calls.some(([args]) => args.some(arg => ['revert', 'reopen', 'sync', 'submit'].includes(arg)))).toBe(false)
  change = '777'; await expect(verifyP4Workspace(ticket, config, run, retained)).rejects.toThrow('未归属本单')
  change = '501'; digest = 'CHANGED'; await expect(verifyP4Workspace(ticket, config, run, retained)).rejects.toThrow('前序pending交付已改变')
})

it('requires a unique own client, matching root/login and a real synchronized file without P4 writes', async () => {
  directory = await mkdtemp(join(tmpdir(), 'p4-preflight-'))
  const root = directory
  const file = join(root, 'A.cpp'); await writeFile(file, 'source')
  const ticket = { execution: { name: 'fix', directory } } as Ticket
  const config = P4ConfigSchema.parse({ port: 'ssl:p4.test:1666', user: 'bot', paths: [{ path: '//GR/main/...' }] })
  let client = 'isolated-fix', owner = 'bot', have = true
  const run = vi.fn(async (argv: string[]) => {
    if (argv.includes('clients')) return JSON.stringify({ client })
    if (argv.includes('client')) return JSON.stringify({ Client: client, Owner: owner, Root: root })
    if (argv.includes('login')) return JSON.stringify({ User: 'bot', TicketExpiration: '100' })
    if (argv.includes('fstat')) { expect(argv).toEqual(expect.arrayContaining(['-Rh', '-m', '1'])); return have ? JSON.stringify({ depotFile: '//GR/main/A.cpp', clientFile: file, haveRev: '1' }) : '' }
    throw new Error('unexpected command')
  })
  await verifyP4Workspace(ticket, config, run)
  expect(run.mock.calls.every(([args]) => !args.some(arg => ['sync', 'edit', 'reconcile', 'submit', 'unshelve'].includes(arg)))).toBe(true)
  client = 'main'; await expect(verifyP4Workspace(ticket, config, run)).rejects.toThrow('唯一')
  client = 'isolated-fix'; owner = 'other'; await expect(verifyP4Workspace(ticket, config, run)).rejects.toThrow('账号')
  owner = 'bot'; have = false; await expect(verifyP4Workspace(ticket, config, run)).rejects.toThrow('已同步文件')
})
