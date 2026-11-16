import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SettingsSchema, ProjectMappingSchema } from '../src/policy.ts'
import type { Trigger, Execution } from '../src/core/index.ts'
import { mappedProject, prepareGitWorktree, verifyGitWorktree, type GitRunner } from '../src/executor/git-workspace.ts'
import { ticketExecution } from '../src/executor/dsh.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
const run: GitRunner = async (argv, cwd) => (await exec(argv[0]!, argv.slice(1), { cwd, env: gitEnv(), timeout: 15000 })).stdout
let root: string, repository: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'superagent-git-')); repository = join(root, 'repo') })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const origin = (source: string, meta: Record<string, unknown> = {}, text = ''): Trigger => ({ id: 'origin', source, threads: [],
  actor: { source, id: 'human' }, human: true, at: '', text, meta })
const mapping = () => ({ id: 'project', source: 'tapd' as const, projectId: '68880148', repository, ref: 'HEAD' })
const project = (): NonNullable<Execution['project']> => ({ ...mapping(), strategy: 'git-worktree' })
async function init() {
  await mkdir(repository)
  await run(['git', 'init', '-b', 'main'], repository)
  await run(['git', 'config', 'user.name', 'Test'], repository)
  await run(['git', 'config', 'user.email', 'test@example.invalid'], repository)
  await writeFile(join(repository, 'code.txt'), 'baseline')
  await run(['git', 'add', 'code.txt'], repository)
  await run(['git', '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline'], repository)
}

it('adds no projects to historical settings and rejects duplicate or unsafe mappings', () => {
  expect(SettingsSchema.parse({}).executor.projects).toEqual([])
  expect(ProjectMappingSchema.parse({ ...mapping(), ref: '' }).ref).toBe('HEAD')
  expect(() => ProjectMappingSchema.parse({ ...mapping(), repository: '../relative' })).toThrow()
  expect(() => ProjectMappingSchema.parse({ ...mapping(), ref: '--help' })).toThrow()
  expect(() => SettingsSchema.parse({ executor: { projects: [mapping(), { ...mapping(), id: 'other' }] } })).toThrow('must be unique')
})

it('matches source identities and TAPD links without accepting a path from incoming metadata', () => {
  const settings = SettingsSchema.parse({ executor: { projects: [mapping()] } })
  expect(mappedProject(settings, origin('tapd', { workspace: '68880148', repository: '/untrusted' }))).toEqual(project())
  expect(mappedProject(settings, origin('feishu', {}, '修复 https://www.tapd.cn/68880148/bugtrace/bugs/view/1168880148001272696'))).toEqual(project())
  expect(mappedProject(settings, origin('tapd', { workspace: 'other' }))).toBeUndefined()
  expect(mappedProject(settings, origin('github', { workspace: '68880148' }))).toBeUndefined()
})

it('freezes the selected project at ticket acceptance without changing a previous ticket after settings change', () => {
  const settings = SettingsSchema.parse({ executor: { projects: [mapping()] } })
  const trigger = origin('tapd', { workspace: '68880148' })
  const ticket: Parameters<typeof ticketExecution>[0] = { id: 'ticket-1234567890', title: 'Fix', decisionId: 'decision',
    origin: { triggerId: 'origin', triggerIds: [] }, channels: [], inputs: [], assignments: [], undelivered: [], createdAt: '', updatedAt: '',
    mandate: { strength: 'explicit', policyVersion: '', basis: { source: 'tapd', via: 'addressed', addressed: 'direct' },
      actor: { source: 'tapd', id: 'person' }, scope: '' } }
  const execution = ticketExecution(ticket,
    { kind: 'accept', name: 'fix', title: 'Fix', scope: 'fix', reason: 'r' }, settings, root, trigger)
  expect(execution.project).toEqual(project())
  settings.executor.projects[0]!.repository = join(root, 'new-repo')
  expect(execution.project?.repository).toBe(repository)
  expect(execution.directory).toBe(join(root, 'work', 'fix-ticket-12345'))
})

it('selects GitHub projects from configured repository rather than arbitrary URL metadata', () => {
  const settings = SettingsSchema.parse({ sources: { github: { config: { repository: 'owner/repo' } } }, executor: {
    projects: [{ ...mapping(), source: 'github', projectId: 'OWNER/REPO' }],
  } })
  expect(mappedProject(settings, origin('github', { repository: 'other/repo' }))?.id).toBe('project')
  settings.sources.github!.config.repository = 'old/name'
  expect(mappedProject(settings, origin('github'), 'owner/repo')?.id).toBe('project')
})

it('creates real independent worktrees concurrently, preserving the source checkout and retry modifications', async () => {
  await init()
  const first = join(root, 'work', 'first'), second = join(root, 'work', 'second')
  const signal = new AbortController().signal
  await Promise.all([prepareGitWorktree(project(), first, 'first', run, signal), prepareGitWorktree(project(), second, 'second', run, signal)])
  await verifyGitWorktree(project(), first, 'first', run)
  await verifyGitWorktree(project(), second, 'second', run)
  await writeFile(join(first, 'code.txt'), 'changed')
  await verifyGitWorktree(project(), first, 'first', run)
  expect(await readFile(join(repository, 'code.txt'), 'utf8')).toBe('baseline')
  expect(await readFile(join(second, 'code.txt'), 'utf8')).toBe('baseline')
  expect(await readFile(join(first, 'code.txt'), 'utf8')).toBe('changed')
})

it('rejects a child directory that merely discovers its parent Git repository', async () => {
  await init()
  const nested = join(repository, 'nested'); await mkdir(nested)
  await expect(verifyGitWorktree(project(), nested, 'first', run)).rejects.toThrow('不是 Git checkout 顶层')
})

it('fails an unavailable local baseline without fetching or touching the source worktree', async () => {
  await init()
  const argv: string[][] = []
  const record: GitRunner = async (args, cwd) => { argv.push(args); return run(args, cwd) }
  await expect(prepareGitWorktree({ ...project(), ref: 'does-not-exist' }, join(root, 'missing'), 'missing', record, new AbortController().signal)).rejects.toThrow()
  expect(argv.some(args => args.includes('fetch') || args.includes('push') || args.includes('reset'))).toBe(false)
  expect(await readFile(join(repository, 'code.txt'), 'utf8')).toBe('baseline')
})

it('does not create a worktree or parent directory if cancelled while resolving the local revision', async () => {
  await init()
  const cancel = new AbortController(), calls: string[][] = []
  const record: GitRunner = async (argv, cwd) => {
    calls.push(argv)
    const result = await run(argv, cwd)
    if (argv.includes('--verify')) cancel.abort()
    return result
  }
  const parent = join(root, 'cancelled')
  await expect(prepareGitWorktree(project(), join(parent, 'ticket'), 'cancelled', record, cancel.signal)).rejects.toThrow()
  expect(calls.some(argv => argv.includes('add'))).toBe(false)
  await expect(stat(parent)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects branch switching instead of resetting the worker checkout', async () => {
  await init()
  const directory = join(root, 'worker')
  await prepareGitWorktree(project(), directory, 'first', run, new AbortController().signal)
  await run(['git', 'switch', '-c', 'different'], directory)
  await expect(verifyGitWorktree(project(), directory, 'first', run)).rejects.toThrow('分支与准备记录不一致')
})
