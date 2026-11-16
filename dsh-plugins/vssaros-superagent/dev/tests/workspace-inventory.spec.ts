import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareGitWorktree, type GitRunner } from '../src/executor/git-workspace.ts'
import { gitEnv } from './fixtures/git.ts'
import type { Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { workspaceInventory } from '../src/executor/workspace-inventory.ts'

let root: string, directory: string, common: string, store: Store
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'superagent-inventory-'))
  directory = join(root, 'work'); common = join(root, 'common')
  await mkdir(directory); await mkdir(common)
  store = new Store(join(root, 'state.sqlite'))
})
afterEach(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
function ticket(id = 't'): Ticket {
  return { id, title: 'Workspace', decisionId: 'decision', channels: [], assignments: [], inputs: [], undelivered: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', origin: { triggerId: 'trigger', triggerIds: [] },
    mandate: { strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' }, policyVersion: '', scope: '', actor: { source: 'feishu', id: 'human' } },
    ended: { at: '2026-01-02T00:00:00Z', outcome: 'completed', by: 'executor' },
    execution: { name: 'name', directory, assignment: '', project: { id: 'project', source: 'feishu', projectId: 'local',
      repository: root, ref: 'HEAD', strategy: 'git-worktree' } } }
}
function seed(value = ticket()) {
  store.tickets.save(value)
  store.set(KV.executor.workspace(value.id), { directory: value.execution!.directory, configuration: '', origin: 'prepared', state: 'ready', at: '' })
}
function host(status = '', ahead = '0', upstream = 'refs/remotes/origin/main') {
  return { store, activity: vi.fn(async () => []), git: vi.fn(async (argv: string[]) => {
    if (argv.includes('--show-toplevel')) return directory
    if (argv.includes('--git-common-dir')) return common
    if (argv.includes('--show-current')) return 'agent/name'
    if (argv.includes('status')) return status
    if (argv.includes('--symbolic-full-name')) return upstream
    if (argv.includes('--count')) return ahead
    throw new Error('unexpected Git command')
  }) }
}

it('shows logical bytes and only a manual-review candidate; it never prepares, mutates the Store or deletes files', async () => {
  seed(); await writeFile(join(directory, 'code.txt'), 'keep')
  const before = store.get(KV.executor.workspace('t'))
  const view = await workspaceInventory(host())
  expect(view).toMatchObject({ readOnly: true, total: 1, nextOffset: null, retentionDays: 14 })
  expect(view.items[0]).toMatchObject({ exists: true, bytes: 4, files: 1, blockers: [], disposition: 'manual-review' })
  expect(store.get(KV.executor.workspace('t'))).toEqual(before)
  expect(await readFile(join(directory, 'code.txt'), 'utf8')).toBe('keep')
})

it('keeps ignored user files in a real worktree and does not write its index during preview', async () => {
  const exec = promisify(execFile)
  const run: GitRunner = async (argv, cwd) => (await exec(argv[0]!, argv.slice(1), { cwd, env: gitEnv(), timeout: 15000 })).stdout
  const repository = join(root, 'repo'); await mkdir(repository)
  await run(['git', 'init', '-b', 'main'], repository)
  await writeFile(join(repository, '.gitignore'), 'ignored.txt\n')
  await run(['git', 'add', '.gitignore'], repository)
  await run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline'], repository)
  await rm(directory, { recursive: true })
  const value = ticket(); value.execution!.project!.repository = repository
  await prepareGitWorktree(value.execution!.project!, directory, 'name', run, new AbortController().signal)
  seed(value)
  await writeFile(join(directory, 'ignored.txt'), 'keep')
  const gitdir = (await run(['git', 'rev-parse', '--absolute-git-dir'], directory)).trim()
  const index = join(gitdir, 'index'), before = await readFile(index)
  const result = await workspaceInventory({ store, activity: async () => [], git: run })
  expect(result.items[0]?.blockers).toEqual(expect.arrayContaining(['git-dirty', 'no-upstream']))
  expect(await readFile(index)).toEqual(before)
  expect(await readFile(join(directory, 'ignored.txt'), 'utf8')).toBe('keep')
})

it.each([['?? new.txt\n', '0', 'git-dirty'], [' M code.txt\n', '0', 'git-dirty'], ['', '2', 'git-ahead']])(
  'retains local dirty/untracked files and unpushed commits (%s, %s)', async (status, ahead, reason) => {
    seed()
    expect((await workspaceInventory(host(status, ahead))).items[0]?.blockers).toContain(reason)
  })

it('does not consider a local-branch upstream evidence of pushed work', async () => {
  seed()
  const item = (await workspaceInventory(host('', '0', 'refs/heads/main'))).items[0]!
  expect(item.blockers).toContain('no-upstream'); expect(item.disposition).toBe('retain')
})

it('retains live, recent, team, follow-up and P4 histories even when local Git appears clean', async () => {
  const value = ticket(); delete value.ended
  value.undelivered = ['message']; value.attention = { id: 'attention', question: '?' }
  value.team = { state: 'approved', version: 1, at: '' }
  value.follows = [{ thread: 'p4:1', own: true }]
  seed(value)
  expect((await workspaceInventory(host())).items[0]?.blockers).toEqual(expect.arrayContaining(['live', 'pending-input', 'awaiting-person', 'team-history', 'open-follow', 'p4-history']))
  value.ended = { by: 'human', outcome: 'stopped', at: new Date().toISOString() }; store.tickets.save(value)
  expect((await workspaceInventory(host())).items[0]?.blockers).toContain('recent')
})

it('retains interrupted, external and unknown preparation without adopting a directory', async () => {
  const value = ticket(); delete value.execution!.project; store.tickets.save(value)
  const probes = host()
  const view = await workspaceInventory(probes)
  expect(view.items[0]?.blockers).toEqual(expect.arrayContaining(['preparation-unknown', 'external-directory']))
  expect(probes.git).not.toHaveBeenCalled()
  expect(store.get(KV.executor.workspace(value.id))).toBeUndefined()
  seed()
  store.set(KV.executor.workspace('t'), { directory, configuration: '', origin: 'prepared', state: 'preparing', at: '' })
  expect((await workspaceInventory(host())).items[0]?.blockers).toContain('preparation-failed')
})

it('reports missing and non-directory targets as unknown size, never zero or a new empty directory', async () => {
  seed(); await rm(directory, { recursive: true })
  expect((await workspaceInventory(host())).items[0]).toMatchObject({ exists: false, bytes: null, disposition: 'retain' })
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(directory, 'file')
  expect((await workspaceInventory(host())).items[0]).toMatchObject({ exists: null, bytes: null, blockers: expect.arrayContaining(['filesystem-unknown']) })
})

it('does not follow directory links or count their external files', async () => {
  seed()
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'outside')
  await symlink(outside, join(directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const item = (await workspaceInventory(host())).items[0]!
  expect(item.bytes).toBeNull(); expect(item.files).toBe(0); expect(item.blockers).toContain('symbolic-links')
})

it('uses depth limits and marks partial scans unknown', async () => {
  seed()
  let nested = directory
  for (let i = 0; i < 14; i++) { nested = join(nested, 'd'); await mkdir(nested) }
  await writeFile(join(nested, 'file.txt'), 'unmeasured')
  const item = (await workspaceInventory(host())).items[0]!
  expect(item.bytes).toBeNull(); expect(item.blockers).toContain('incomplete-size')
})

it('retains runtime activity, shared directories, failed Git checks and missing upstream', async () => {
  seed(); seed(ticket('other'))
  const probes = host()
  probes.activity.mockResolvedValue(['runtime-active'] as never)
  probes.git.mockRejectedValue(new Error('not available'))
  const row = (await workspaceInventory(probes)).items[0]!
  expect(row.blockers).toEqual(expect.arrayContaining(['runtime-active', 'shared-directory', 'git-unknown']))
})

it('retains an isolated P4 required record and uses explicit read-only submodule-aware Git probes', async () => {
  seed(); store.set(KV.reviews.required('t'), 123)
  const probes = host()
  const row = (await workspaceInventory(probes)).items[0]!
  expect(row.blockers).toContain('p4-history')
  const status = probes.git.mock.calls.find(([argv]) => argv.includes('status'))![0]
  expect(status).toEqual(expect.arrayContaining(['--no-optional-locks', 'core.fsmonitor=false', '--ignore-submodules=none']))
})

it('rejects ancestor links without scanning their children', async () => {
  const value = ticket()
  const parent = join(root, 'alias')
  await symlink(directory, parent, process.platform === 'win32' ? 'junction' : 'dir')
  const nested = join(directory, 'child'); await mkdir(nested); await writeFile(join(nested, 'data.txt'), 'outside')
  value.execution!.directory = join(parent, 'child'); seed(value)
  const row = (await workspaceInventory(host())).items[0]!
  expect(row.blockers).toContain('symbolic-links'); expect(row.bytes).toBeNull(); expect(row.files).toBe(0)
})

it('ends a cancelled request instead of scanning further tickets, and rejects unbounded internal pages', async () => {
  seed(); seed(ticket('other'))
  const probes = host(), cancel = new AbortController()
  probes.activity.mockImplementation(async () => { cancel.abort(); return [] })
  await expect(workspaceInventory({ ...probes, signal: cancel.signal })).rejects.toThrow()
  expect(probes.activity).toHaveBeenCalledOnce()
  expect(probes.git).not.toHaveBeenCalled()
  await expect(workspaceInventory(host(), 0, 100)).rejects.toThrow('Invalid workspace inventory page')
})

it('paginates only ticket-bound directories, excluding group tickets and orphan folders', async () => {
  seed(); seed(ticket('second'))
  const group = ticket('group'); delete group.execution; store.tickets.save(group)
  await mkdir(join(root, 'orphan'))
  const probes = host()
  const page = await workspaceInventory(probes, 0, 1)
  expect(page).toMatchObject({ total: 2, offset: 0, nextOffset: 1 }); expect(page.items).toHaveLength(1)
  expect((await workspaceInventory(probes, 1, 1)).nextOffset).toBeNull()
})
