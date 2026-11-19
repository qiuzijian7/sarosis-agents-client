/** Shared immediate/daily intake. Admission is recorded per item; receipt never means repair completed. */
import type { SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { itemTrigger, resolvedConfig } from './tapd.ts'
import { TAPD_SOURCE, type TapdApi, type TapdConfig } from './tapd-api.ts'
import { cleanOwner } from './tapd-members.ts'
import { scheduledTapdName } from './tapd-identity.ts'
import { localDay, planPoolRun, poolDue, poolItemKey, poolWithRuntime, reconcilePoolState, type PoolRunState } from './tapd-filter-schemes.ts'

export interface PoolRunResult { planned: number; dispatched: number; runId: string; error?: string }

export async function runPoolDaily(ctx: SourceContext, api: TapdApi, config: TapdConfig,
  now = new Date(), signal?: AbortSignal, manual = false): Promise<PoolRunResult> {
  const stateKey = KV.tapd.pool(config.filterPool.name)
  let initial = ctx.state.get(stateKey)
  if (ctx.intake) ctx.atomic(() => {
    const saved = ctx.state.get(stateKey)
    if (saved) { initial = reconcilePoolState(saved, id => ctx.intake!.status(id), now); ctx.state.set(stateKey, initial) }
  })
  const pool = poolWithRuntime(config.filterPool, config.workspace, initial)
  const empty = { planned: 0, dispatched: 0, runId: '' }
  if (!manual && !poolDue({ ...pool, lastRun: initial?.lastRun ?? '' }, now)) return empty
  if (!pool.owner.trim()) return { ...empty, error: '当前用户身份不可用，未派发任何任务' }
  const run = planPoolRun(pool, now)
  const resolved = resolvedConfig(config)
  const owner = await scheduledTapdName(config, api, ctx.state, pool.owner, now)
  if (!owner) return { ...empty, error: 'TAPD 身份未解析或缓存已过期，请在设置页重新读取并确认身份' }
  let dispatched = 0
  let error: string | undefined
  const state = (): PoolRunState => ctx.state.get(stateKey) ?? { lastRun: '', runIds: [], dispatched: 0, at: '', records: {} }
  for (const item of run.items) {
    if (signal?.aborted) { error = '运行已中止，未派发条目保留待处理'; break }
    const key = poolItemKey(config.workspace, pool.owner, item)
    let claimed = false
    let triggerId = ''
    let requeue = false
    ctx.atomic(() => {
      const saved = state(), known = saved.records?.[key]
      const intake = known && ctx.intake?.status(known.triggerId)
      if (known && (known.state === 'done' || known.state === 'processing' || known.state === 'queued')) return
      if (intake && (!intake.retryable || intake.phase === 'rejected' && !manual)) return
      if ((known?.attempts ?? 0) >= 3) return
      const attempts = (known?.attempts ?? 0) + 1
      requeue = !!intake?.retryable
      triggerId = requeue ? known!.triggerId : `tapd-pool:${key}:${attempts}`
      const record = { state: 'processing' as const, runId: run.runId, triggerId, lastRunAt: now.toISOString(), attempts, item, dispatching: true }
      ctx.state.set(stateKey, { ...saved, records: { ...saved.records, [key]: record } })
      claimed = true
    })
    if (!claimed) continue
    try {
      const fresh = await api.items(item.kind, config.workspace, { id: item.id }, signal)
      const record = fresh.find(row => row.id === item.id && row.workspace === config.workspace)
      if (!record) throw new Error(`${item.id} 无法读取，未用过期快照代替`)
      if (!record.owners.some(name => cleanOwner(name).toLowerCase() === owner.toLowerCase()))
        throw new Error(`${item.id} 处理人已变更，拒绝派发`)
      const base = itemTrigger(record, 'item', resolved, { name: pool.name, mode: 'all', item: item.id })
      ctx.atomic(() => {
        const saved = state(), previous = saved.records?.[key]
        if (previous?.triggerId !== triggerId || !previous.dispatching) throw new Error('池任务领取已失效，未派发')
        ctx.state.set(stateKey, { ...saved, records: { ...saved.records, [key]: { ...previous, authorization: {
          authority: 'host_pool', action: 'repair', invocation: manual ? 'manual' : 'daily', workspace: config.workspace,
          pool: pool.name, itemType: item.kind, itemId: item.id, loginName: pool.owner, tapdOwner: owner,
          runId: run.runId, authorizedAt: now.toISOString(),
        } } } })
      })
      const received = requeue
        ? ctx.intake!.requeue(triggerId) ? 'stored' : 'duplicate'
        : await ctx.receive({ ...base, id: triggerId, at: now.toISOString(), human: false,
          actor: { source: TAPD_SOURCE, id: '' }, addressed: 'direct',
          meta: { ...base.meta, mode: 'all', filterSweep: pool.name, filterPool: pool.name, runId: run.runId } })
      if (received !== 'stored' && received !== 'duplicate') throw new Error(`${item.id} 被接收规则拒绝：${received}`)
      ctx.atomic(() => {
        const saved = state(), previous = saved.records?.[key]
        if (previous?.triggerId === triggerId) ctx.state.set(stateKey, { ...saved,
          records: { ...saved.records, [key]: { ...previous, state: 'queued', dispatching: false } } })
      })
      if (received === 'stored') dispatched++
    } catch (failure) {
      error = String(failure).slice(0, 300)
      ctx.atomic(() => {
        const saved = state(), previous = saved.records?.[key]
        if (previous?.triggerId === triggerId) ctx.state.set(stateKey, { ...saved,
          records: { ...saved.records, [key]: { ...previous, state: 'failed', dispatching: false } } })
      })
    }
  }
  ctx.atomic(() => {
    const saved = state()
    ctx.state.set(stateKey, { ...saved, lastRun: !error && !manual ? localDay(now) : saved.lastRun,
      runIds: [...new Set([...saved.runIds, run.runId])].slice(-30), dispatched,
      at: now.toISOString() })
  })
  return { planned: run.items.length, dispatched, runId: run.runId, ...error ? { error } : {} }
}
