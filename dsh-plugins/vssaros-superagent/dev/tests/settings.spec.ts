/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { afterEach, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }

it('reserves disabling the P4 delivery policy to the operator panel', async () => {
  h = await startRuntime()
  const { store, settings } = h.runtime
  const { p4Kind } = await import('../src/sources/p4.ts')
  h.runtime.sources.register(p4Kind)
  await expect(settings.save('source:p4', { enabled: false, config: { requireDelivery: false } }, store.blockRevision('source:p4'), 'tool')).rejects.toThrow('management panel')
})

it('keeps explicit-file reconcile fallback off by default, panel-only, and records who enabled it', async () => {
  h = await startRuntime()
  const { store, settings } = h.runtime
  const { p4Kind } = await import('../src/sources/p4.ts')
  h.runtime.sources.register(p4Kind)
  const base = store.settings().sources.p4?.config ?? {}
  expect((await import('../src/sources/p4-change.ts')).P4ConfigSchema.parse(base).reconcileFallback).toBe(false)
  await expect(settings.save('source:p4', { enabled: true, config: { ...base, reconcileFallback: true } },
    store.blockRevision('source:p4'), 'tool')).rejects.toThrow('management panel')
  expect(store.settings().sources.p4?.config.reconcileFallback).toBeFalsy()
  await settings.save('source:p4', { enabled: true, config: { ...base, reconcileFallback: true } },
    store.blockRevision('source:p4'), 'panel')
  expect(store.settings().sources.p4?.config.reconcileFallback).toBe(true)
  const history = await h.api('GET', 'policy/history')
  expect(JSON.stringify(history.body)).toContain('reconcileFallback')
  expect((history.body as { items: { source: string }[] }).items[0]?.source).toBe('panel')
})

it('keeps strict unopened-diff scanning off by default, panel-only, and records who enabled it', async () => {
  h = await startRuntime()
  const { store, settings } = h.runtime
  const { p4Kind } = await import('../src/sources/p4.ts')
  h.runtime.sources.register(p4Kind)
  const base = store.settings().sources.p4?.config ?? {}
  expect((await import('../src/sources/p4-change.ts')).P4ConfigSchema.parse(base).checkUnopenedDiffs).toBe(false)
  await expect(settings.save('source:p4', { enabled: true, config: { ...base, checkUnopenedDiffs: true } },
    store.blockRevision('source:p4'), 'tool')).rejects.toThrow('management panel')
  expect(store.settings().sources.p4?.config.checkUnopenedDiffs).toBeFalsy()
  const revision = store.blockRevision('source:p4')
  await settings.save('source:p4', { enabled: true, config: { ...base, checkUnopenedDiffs: true } }, revision, 'panel')
  expect(store.settings().sources.p4?.config.checkUnopenedDiffs).toBe(true)
  const history = await h.api('GET', 'policy/history')
  expect(JSON.stringify(history.body)).toContain('checkUnopenedDiffs')
  expect((history.body as { items: { source: string }[] }).items[0]?.source).toBe('panel')
})

it('keeps PTC and tool metadata tracing opt-in and panel-only', async () => {
  h = await startRuntime()
  const { store, settings } = h.runtime
  expect(store.settings().executor).toMatchObject({ workerPtc: false, toolTrace: false })
  for (const field of ['workerPtc', 'toolTrace']) {
    await expect(settings.save('executor', { ...store.settings().executor, [field]: true }, store.blockRevision('executor'), 'tool')).rejects.toThrow('management panel')
  }
  await settings.save('executor', { ...store.settings().executor, workerPtc: true, toolTrace: true }, store.blockRevision('executor'), 'panel')
  expect(store.settings().executor).toMatchObject({ workerPtc: true, toolTrace: true })
})

it('allows only the panel to change trusted project mappings', async () => {
  h = await startRuntime()
  const { store, settings } = h.runtime
  const projects = [{ id: 'github', source: 'github', projectId: 'acme/widgets', repository: h.directory, ref: 'HEAD' }]
  const executor = { ...store.settings().executor, projects }
  await expect(settings.save('executor', executor, store.blockRevision('executor'), 'tool')).rejects.toThrow('management panel')
  expect(store.settings().executor.projects).toEqual([])
  await settings.save('executor', executor, store.blockRevision('executor'), 'panel')
  expect(store.settings().executor.projects).toEqual(projects)
})

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})
