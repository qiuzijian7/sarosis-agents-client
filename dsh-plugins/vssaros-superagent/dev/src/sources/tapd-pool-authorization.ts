/** Pool authority is derived from the Host's dispatch ledger, never from external text or arbitrary trigger metadata. */
import type { Trigger } from '../core/index.ts'
import { KV, type Key } from '../kv.ts'
import { TapdConfigSchema, type TapdConfig } from './tapd-api.ts'
import { cachedTapdName } from './tapd-identity.ts'
import { cleanOwner } from './tapd-members.ts'
import { poolItemKey } from './tapd-filter-schemes.ts'

export interface PoolAuthorization {
  authority: 'host_pool'; action: 'repair'; invocation: 'manual' | 'daily'
  workspace: string; pool: string; itemType: 'story' | 'bug'; itemId: string
  loginName: string; tapdOwner: string; runId: string; authorizedAt: string
}
interface State { get<T>(key: Key<T>): T | undefined }
const same = (a: string, b: string) => cleanOwner(a).toLowerCase() === cleanOwner(b).toLowerCase()
function dispatchRecord(state: State, config: TapdConfig, trigger: Trigger) {
  const { workspace, type, id, filterPool, filterSweep, owners } = trigger.meta
  if (trigger.source !== 'tapd' || trigger.addressed !== 'direct' || !trigger.id.startsWith('tapd-pool:')
    || workspace !== config.workspace || filterPool !== config.filterPool.name || filterSweep !== filterPool
    || (type !== 'story' && type !== 'bug') || typeof id !== 'string') return undefined
  const ledger = state.get(KV.tapd.pool(config.filterPool.name))
  const record = ledger?.records?.[poolItemKey(config.workspace, config.filterPool.owner, { kind: type, id })]
  if (!record || record.triggerId !== trigger.id || !record.item?.enabled || record.item.id !== id || record.item.kind !== type) return undefined
  const current = config.filterPool.items.find(item => item.kind === type && item.id === id)
  const owner = cachedTapdName(config, state, config.filterPool.owner)
  if (!owner || !Array.isArray(owners) || !owners.some(value => typeof value === 'string' && same(value, owner))) return undefined
  return { record, current, owner, type, id }
}
export function poolAuthorization(state: State, config: TapdConfig, trigger: Trigger): PoolAuthorization | undefined {
  const found = dispatchRecord(state, config, trigger), grant = found?.record.authorization
  if (!found || !grant || grant.authority !== 'host_pool' || grant.action !== 'repair' || !['manual', 'daily'].includes(grant.invocation)
    || grant.workspace !== config.workspace || grant.pool !== config.filterPool.name || grant.itemType !== found.type || grant.itemId !== found.id
    || !same(grant.loginName, config.filterPool.owner) || !same(grant.tapdOwner, found.owner)
    || grant.runId !== found.record.runId || !Number.isFinite(Date.parse(grant.authorizedAt))) return undefined
  return grant
}
/** A legacy ignore can be reconsidered only by another operator click, while the original item is still explicitly enabled. */
export function legacyPoolReauthorization(state: State, config: TapdConfig, trigger: Trigger): boolean {
  const found = dispatchRecord(state, config, trigger)
  return !!found && !found.record.authorization && found.current?.enabled === true
}
type HostStore = State & { settings(): { sources: Record<string, { enabled?: boolean; config?: unknown } | undefined> } }
export function hostLegacyPoolReauthorization(store: HostStore, trigger: Trigger): boolean {
  if (trigger.source !== 'tapd' || typeof trigger.meta.filterPool !== 'string') return false
  const source = store.settings().sources.tapd
  if (!source?.enabled) return false
  const parsed = TapdConfigSchema.safeParse(source.config)
  return parsed.success && legacyPoolReauthorization(store, parsed.data, trigger)
}
export function hostPoolAuthorization(store: HostStore, trigger: Trigger) {
  if (trigger.source !== 'tapd' || typeof trigger.meta.filterPool !== 'string') return undefined
  const source = store.settings().sources.tapd
  if (!source?.enabled) return undefined
  const parsed = TapdConfigSchema.safeParse(source.config)
  return parsed.success ? poolAuthorization(store, parsed.data, trigger) : undefined
}
