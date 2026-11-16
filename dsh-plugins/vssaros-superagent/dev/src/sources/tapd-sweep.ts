/**
 * Daily sweeps of an imported TAPD bug filter. Unlike `pollWatch` (which listens for changes), a sweep
 * actively fetches items matching the operator's saved filter and turns the new ones into Triggers.
 * It is bounded in three independent ways: a modified-time window, the API's 2000-record page limit,
 * and `maxPerRun`; a bounded `seen` list prevents the same bug from being dispatched every day.
 */
import type { SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { itemTrigger } from './tapd.ts'
import { TAPD_SOURCE, tapdTime, type TapdApi, type TapdConfig } from './tapd-api.ts'
import { localDay, matchesLocal, SEEN_LIMIT, sweepDue, type TapdSweepState } from './tapd-filters.ts'

export interface SweepResult { name: string; scanned: number; matched: number; dispatched: number; capped: boolean; error?: string }

/** Runs every due schedule once. Failures are reported to Source health rather than silently swallowed. */
export async function runFilterSweeps(ctx: SourceContext, api: TapdApi, config: TapdConfig,
  now = new Date(), signal?: AbortSignal): Promise<SweepResult[]> {
  const results: SweepResult[] = []
  for (const schedule of config.filterSchedules) {
    const stateKey = KV.tapd.sweep(schedule.name)
    const state = ctx.state.get(stateKey)
    if (!sweepDue(schedule, now, state?.lastRun)) continue
    const since = new Date(now.getTime() - schedule.windowDays * 86_400_000)
    const filter = { ...schedule.query, modified: `>${tapdTime(since.toISOString())}` }
    let result: SweepResult
    try {
      const scannedItems = await api.items('bug', config.workspace, filter, signal)
      const matchedItems = scannedItems.filter(item => matchesLocal(item, schedule.local))
      const seen = new Set(state?.seen ?? [])
      const fresh = matchedItems.filter(item => !seen.has(item.id)).slice(0, schedule.maxPerRun)
      let dispatched = 0
      for (const item of fresh) {
        const watch = { name: schedule.name, mode: 'all' as const, item: '' }
        const base = itemTrigger(item, 'item', config, watch)
        // This is an operator-authorized intake, not a human message: `machineGate` recognises the
        // filterSweep marker and admits it explicitly. The id stays the item's own, so two schedules
        // hitting the same bug still produce only one ticket.
        const received = await ctx.receive({ ...base,
          human: false, actor: { source: TAPD_SOURCE, id: '' }, addressed: 'direct' as const,
          meta: { ...base.meta, mode: 'all', filterSweep: schedule.name } })
        if (received === 'stored') dispatched++
        seen.add(item.id)
      }
      const next: TapdSweepState = { lastRun: localDay(now), seen: [...seen].slice(-SEEN_LIMIT),
        scanned: scannedItems.length, matched: matchedItems.length, dispatched, at: now.toISOString() }
      ctx.state.set(stateKey, next)
      result = { name: schedule.name, scanned: scannedItems.length, matched: matchedItems.length, dispatched,
        capped: scannedItems.length >= 2000 || fresh.length >= schedule.maxPerRun }
    } catch (error) {
      // Do not mark the day as run: the next poll retries, so a transient TAPD outage loses nothing.
      result = { name: schedule.name, scanned: 0, matched: 0, dispatched: 0, capped: false, error: String(error).slice(0, 300) }
    }
    results.push(result)
  }
  return results
}
