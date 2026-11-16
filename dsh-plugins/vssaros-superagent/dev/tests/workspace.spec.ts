import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { TicketWorkspaces, ticketDirectory } from '../src/executor/workspace.ts'

let root: string, directory: string, store: Store, workspaces: TicketWorkspaces
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'superagent-workspace-'))
  directory = join(root, 'ticket')
  store = new Store(join(root, 'state.sqlite'))
  workspaces = new TicketWorkspaces(store)
})
afterEach(async () => { vi.restoreAllMocks(); store.close(); await rm(root, { recursive: true, force: true }) })
const prepare = () => mkdir(directory, { recursive: true }).then(() => {})
const verify = async () => {}
const origin = (source: string, workspace: string): Trigger => ({
  id: 'origin', source, threads: [], actor: { source, id: 'person' }, human: true, at: '', text: '', meta: { workspace },
})

it('uses configured roots, never a TAPD ID or untrusted metadata path', () => {
  const settings = SettingsSchema.parse({ executor: { directory: root }, sources: { superagent: { config: { workspace: join(root, 'local') } } } })
  for (const value of ['68880148', '../escape', join(root, 'untrusted')]) {
    expect(ticketDirectory(settings, root, 'fix-123', origin('tapd', value))).toBe(join(root, 'fix-123'))
    expect(ticketDirectory(settings, root, 'fix-123', origin('feishu', value))).toBe(join(root, 'fix-123'))
  }
  expect(ticketDirectory(settings, root, 'fix-123', origin('superagent', 'ignored'))).toBe(join(root, 'local', 'fix-123'))
  expect(ticketDirectory(SettingsSchema.parse({}), root, 'fix-123')).toBe(join(root, 'work', 'fix-123'))
  const windows = SettingsSchema.parse({ sources: { superagent: { config: { workspace: 'F:\\S1Game' } } } })
  expect(ticketDirectory(windows, root, 'fix-123', origin('superagent', ''))).toBe(win32.join('F:\\S1Game', 'fix-123'))
  expect(() => ticketDirectory(SettingsSchema.parse({ sources: { superagent: { config: { workspace: '68880148' } } } }), root, 'fix', origin('superagent', ''))).toThrow('工作区未配置')
})

it('records preparation before side effects and preserves user changes across retries and Store reopen', async () => {
  const create = vi.fn(async () => {
    expect(store.get(KV.executor.workspace('t'))?.state).toBe('preparing')
    await prepare()
  })
  const check = vi.fn(verify)
  await workspaces.ensure('t', directory, 'prepare', create, check)
  await writeFile(join(directory, 'user-change.txt'), 'keep')
  store.close(); store = new Store(join(root, 'state.sqlite')); workspaces = new TicketWorkspaces(store)
  await workspaces.ensure('t', directory, 'new prepare command', create, check)
  expect(create).toHaveBeenCalledOnce()
  expect(check).toHaveBeenCalledTimes(2)
  expect(await readFile(join(directory, 'user-change.txt'), 'utf8')).toBe('keep')
  expect(store.get(KV.executor.workspace('t'))).toMatchObject({ directory, state: 'ready', origin: 'prepared' })
})

it('does not treat non-empty failed preparation as a legacy ready workspace, even after restart', async () => {
  const create = vi.fn(async () => { await prepare(); await writeFile(join(directory, 'partial.txt'), 'keep'); throw new Error('prepare broke') })
  const check = vi.fn(verify)
  await expect(workspaces.ensure('t', directory, 'prepare', create, check)).rejects.toThrow('prepare broke')
  store.close(); store = new Store(join(root, 'state.sqlite')); workspaces = new TicketWorkspaces(store)
  await expect(workspaces.ensure('t', directory, 'prepare', create, check)).rejects.toThrow('上次准备失败或中断')
  expect(create).toHaveBeenCalledOnce(); expect(check).not.toHaveBeenCalled()
  expect(await readFile(join(directory, 'partial.txt'), 'utf8')).toBe('keep')
  expect(store.get(KV.executor.workspace('t'))).toMatchObject({ state: 'failed', failurePhase: 'prepare' })
})

it('allows explicit retry after failed preparation left no directory', async () => {
  const create = vi.fn(prepare).mockRejectedValueOnce(new Error('no directory created'))
  await expect(workspaces.ensure('t', directory, 'old', create, verify)).rejects.toThrow('no directory created')
  await workspaces.ensure('t', directory, 'new', create, verify)
  expect(create).toHaveBeenCalledTimes(2)
  expect(store.get(KV.executor.workspace('t'))?.state).toBe('ready')
})

it('adopts legacy directories by verification only, without executing prepare or changing files', async () => {
  await prepare(); await writeFile(join(directory, 'existing.txt'), 'keep')
  const create = vi.fn(prepare), check = vi.fn(verify)
  await workspaces.ensure('t', directory, 'destructive prepare', create, check)
  expect(create).not.toHaveBeenCalled(); expect(check).toHaveBeenCalledOnce()
  expect(await readFile(join(directory, 'existing.txt'), 'utf8')).toBe('keep')
  expect(store.get(KV.executor.workspace('t'))).toMatchObject({ state: 'ready', origin: 'existing' })
})

it('marks validation failures and rechecks repaired directories without rerunning prepare', async () => {
  await prepare()
  const create = vi.fn(prepare), check = vi.fn(verify).mockRejectedValueOnce(new Error('unsafe git configuration'))
  await expect(workspaces.ensure('t', directory, '', create, check)).rejects.toThrow('unsafe git configuration')
  expect(store.get(KV.executor.workspace('t'))).toMatchObject({ state: 'failed', failurePhase: 'verify' })
  await workspaces.ensure('t', directory, '', create, check)
  expect(create).not.toHaveBeenCalled(); expect(check).toHaveBeenCalledTimes(2)
  expect(store.get(KV.executor.workspace('t'))?.state).toBe('ready')
})

it('wraps local verification failures as workspace errors even when their text looks transient', async () => {
  await prepare()
  const failure = new Error('unsafe local configuration in /projects/503')
  await expect(workspaces.ensure('t', directory, '', prepare, async () => { throw failure })).rejects.toMatchObject({
    name: 'WorkspaceError', cause: failure,
  })
})

it('refuses to replace a lost ready workspace with an empty directory', async () => {
  const create = vi.fn(prepare)
  await workspaces.ensure('t', directory, '', create, verify)
  await rm(directory, { recursive: true })
  await expect(workspaces.ensure('t', directory, '', create, verify)).rejects.toThrow('原工作区已丢失')
  expect(create).toHaveBeenCalledOnce()
})

it('does not re-prepare or rebind interrupted or moved workspaces', async () => {
  store.set(KV.executor.workspace('t'), { directory, state: 'preparing', configuration: 'old', origin: 'prepared', at: '' })
  const create = vi.fn(prepare)
  await expect(workspaces.ensure('t', directory, '', create, verify)).rejects.toThrow('上次准备失败或中断')
  await expect(workspaces.ensure('t', join(root, 'other'), '', create, verify)).rejects.toThrow('目录与准备记录不一致')
  expect(create).not.toHaveBeenCalled()
})

it('rejects files, relative paths, and prepare commands that did not create a directory', async () => {
  await writeFile(directory, 'not a directory')
  const create = vi.fn(prepare)
  await expect(workspaces.ensure('t', directory, '', create, verify)).rejects.toThrow('目标不是目录')
  await expect(workspaces.ensure('t', '../relative', '', create, verify)).rejects.toThrow('本机绝对路径')
  await rm(directory)
  await expect(workspaces.ensure('t', directory, '', async () => {}, verify)).rejects.toThrow('未生成目录')
  expect(create).not.toHaveBeenCalled()
})

it.each(['EACCES', 'EIO'])('reports %s rather than treating it as a missing directory', async code => {
  workspaces = new TicketWorkspaces(store, async () => { throw Object.assign(new Error(code), { code }) })
  const create = vi.fn(prepare)
  await expect(workspaces.ensure('t', directory, '', create, verify)).rejects.toThrow(code)
  expect(create).not.toHaveBeenCalled()
})

it('does not prepare a missing directory during delivery or worker recreation', async () => {
  const create = vi.fn(prepare)
  await expect(workspaces.ensure('t', directory, '', create, verify, false)).rejects.toThrow('消息投递不会重新运行准备命令')
  expect(create).not.toHaveBeenCalled()
})

it('serializes concurrent preparation for the same ticket and checks both callers', async () => {
  const create = vi.fn(prepare), check = vi.fn(verify)
  await Promise.all([workspaces.ensure('t', directory, '', create, check), workspaces.ensure('t', directory, '', create, check)])
  expect(create).toHaveBeenCalledOnce(); expect(check).toHaveBeenCalledTimes(2)
})
