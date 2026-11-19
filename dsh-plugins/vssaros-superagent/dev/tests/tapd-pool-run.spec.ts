import { describe, expect, it, vi } from 'vitest'
import { itemOf, TapdConfigSchema, tapdConfigured, type TapdApi } from '../src/sources/tapd-api.ts'
import { PoolItemSchema, poolWithRuntime } from '../src/sources/tapd-filter-schemes.ts'
import { runPoolDaily } from '../src/sources/tapd-filter-pool-run.ts'
import { resolveTapdIdentity } from '../src/sources/tapd-identity.ts'
import { KV } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'

function fixture() {
  const values = new Map<string, unknown>()
  const receive = vi.fn(async () => 'stored' as const)
  const ctx = { state: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) },
    atomic: (fn: () => unknown) => fn(), receive } as unknown as SourceContext
  const api = { items: vi.fn(async (kind: 'bug' | 'story', workspace: string, query: Record<string, string>) => [itemOf(kind,
    { id: query.id!, workspace_id: workspace, title: '修复 HUD', current_owner: '邱子鉴;', owner: '邱子鉴;', modified: '2026-11-17 01:00:00' })]) } as unknown as TapdApi
  const config = TapdConfigSchema.parse({ members: [{ alias: 'qiuzijian', name: '邱子鉴' }],
    filterPool: { owner: 'qiuzijian', autoProcess: true, maxPerRun: 1, items: [
      PoolItemSchema.parse({ id: '1', kind: 'bug', enabled: true }), PoolItemSchema.parse({ id: '2', kind: 'story', enabled: true }),
      PoolItemSchema.parse({ id: '3', kind: 'bug', enabled: false })] } })
  return { ctx, api, config, receive, values }
}
const at = (day = 17, hour = 2) => new Date(2026, 10, day, hour, 0)

describe('real pool intake', () => {
  it('manual run dispatches while auto is off and before 02:00; receipt is queued, not done', async () => {
    const h = fixture(); h.config.filterPool.autoProcess = false
    const result = await runPoolDaily(h.ctx, h.api, h.config, at(17, 1), undefined, true)
    expect(result.dispatched).toBe(1)
    expect(h.receive).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringContaining('tapd-pool:'),
      addressed: 'direct', human: false, meta: expect.objectContaining({ filterPool: 'filter-pool-1' }) }))
    const pool = poolWithRuntime(h.config.filterPool, h.config.workspace, h.ctx.state.get(KV.tapd.pool('filter-pool-1')))
    expect(pool.items[0]!.state).toBe('queued'); expect(pool.processedToday).toBe(0)
  })
  it('runs with only a pool, skips disabled items and dispatched items across days/restarts', async () => {
    const h = fixture()
    expect(tapdConfigured(h.config)).toBe(true)
    expect((await runPoolDaily(h.ctx, h.api, h.config, at(17, 1))).dispatched).toBe(0)
    expect((await runPoolDaily(h.ctx, h.api, h.config, at())).dispatched).toBe(1)
    expect((await runPoolDaily(h.ctx, h.api, h.config, at())).dispatched).toBe(0)
    expect((await runPoolDaily(h.ctx, h.api, h.config, at(18))).dispatched).toBe(1)
    expect((await runPoolDaily(h.ctx, h.api, h.config, at(19))).dispatched).toBe(0)
    expect(h.receive).toHaveBeenCalledTimes(2)
  })
  it('records per-item failures and retries a transient outage without closing the day', async () => {
    const h = fixture()
    vi.mocked(h.api.items).mockRejectedValueOnce(new Error('offline'))
    expect((await runPoolDaily(h.ctx, h.api, h.config, at())).error).toContain('offline')
    expect(h.ctx.state.get(KV.tapd.pool('filter-pool-1'))!.lastRun).toBe('')
    expect((await runPoolDaily(h.ctx, h.api, h.config, at())).dispatched).toBe(1)
  })
  it('refuses missing identities and changed owners, instead of inventing records from stale snapshots', async () => {
    const h = fixture()
    h.config.filterPool.owner = ''
    expect((await runPoolDaily(h.ctx, h.api, h.config, at())).error).toContain('身份不可用')
    expect(h.api.items).not.toHaveBeenCalled()
    h.config.filterPool.owner = 'someone-else'
    expect((await runPoolDaily(h.ctx, h.api, h.config, at())).error).toContain('身份未解析')
    h.config.members.push({ alias: 'someone-else', name: '其他人' })
    expect((await runPoolDaily(h.ctx, h.api, h.config, at())).error).toContain('处理人已变更')
    expect(h.receive).not.toHaveBeenCalled()
  })
  it('atomically claims items so simultaneous manual/automatic runs do not double-dispatch', async () => {
    const h = fixture()
    h.config.filterPool.items = h.config.filterPool.items.slice(0, 1)
    await Promise.all([runPoolDaily(h.ctx, h.api, h.config, at()), runPoolDaily(h.ctx, h.api, h.config, at(), undefined, true)])
    expect(h.receive).toHaveBeenCalledTimes(1)
  })
  it('uses a remembered confirmation for daily runs and pauses safely when that mapping expires', async () => {
    const h = fixture(); h.config.members = []
    await resolveTapdIdentity(h.config, { directoryMembers: async () => [{ user: '邱子鉴', name: '邱子鉴' }] }, h.ctx.state,
      { signedIn: true, loginName: 'qiuzijian', userId: 'u1' }, { confirmName: '邱子鉴', now: at() })
    expect((await runPoolDaily(h.ctx, h.api, h.config, at())).dispatched).toBe(1)
    expect((await runPoolDaily(h.ctx, h.api, h.config, new Date(2027, 0, 1, 2))).error).toContain('缓存已过期')
    expect(h.receive).toHaveBeenCalledOnce()
  })
  it('retries a failed evaluation using the original trigger ID, preserving concurrency and ownership checks', async () => {
    const h = fixture(); h.config.filterPool.items = h.config.filterPool.items.slice(0, 1)
    await runPoolDaily(h.ctx, h.api, h.config, at(), undefined, true)
    const before = h.ctx.state.get(KV.tapd.pool('filter-pool-1'))!, original = Object.values(before.records!)[0]!.triggerId
    let failed = true
    const requeue = vi.fn(() => { failed = false; return true })
    h.ctx.intake = { status: () => failed ? { state: 'failed', phase: 'evaluation', detail: 'timeout', retryable: true }
      : { state: 'queued', phase: 'evaluation', detail: 'queued', retryable: false }, requeue }
    await Promise.all([runPoolDaily(h.ctx, h.api, h.config, at(), undefined, true), runPoolDaily(h.ctx, h.api, h.config, at(), undefined, true)])
    expect(requeue).toHaveBeenCalledOnce(); expect(requeue).toHaveBeenCalledWith(original)
    expect(h.receive).toHaveBeenCalledOnce()
    expect(Object.values(h.ctx.state.get(KV.tapd.pool('filter-pool-1'))!.records!)[0]?.triggerId).toBe(original)
  })
  it('does not redispatch an ignored task or an already created ticket', async () => {
    const h = fixture(); h.config.filterPool.items = h.config.filterPool.items.slice(0, 1)
    await runPoolDaily(h.ctx, h.api, h.config, at(), undefined, true)
    h.ctx.intake = { status: () => ({ state: 'failed', phase: 'rejected', detail: 'Policy rejected', retryable: false }), requeue: vi.fn(() => true) }
    const result = await runPoolDaily(h.ctx, h.api, h.config, at(), undefined, true)
    expect(result.dispatched).toBe(0); expect(h.ctx.intake.requeue).not.toHaveBeenCalled(); expect(h.receive).toHaveBeenCalledOnce()
  })
  it('does not mark an aborted day as completed', async () => {
    const h = fixture(), controller = new AbortController(); controller.abort()
    const result = await runPoolDaily(h.ctx, h.api, h.config, at(), controller.signal)
    expect(result.error).toContain('中止'); expect(h.receive).not.toHaveBeenCalled()
    expect(h.ctx.state.get(KV.tapd.pool('filter-pool-1'))?.lastRun).toBe('')
  })
})
