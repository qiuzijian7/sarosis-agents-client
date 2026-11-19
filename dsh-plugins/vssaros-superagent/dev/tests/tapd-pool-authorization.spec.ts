import { expect, it } from 'vitest'
import { Engine, MemoryRepositories, type Policy, type Trigger, type Candidate } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { TapdConfigSchema, itemOf, type TapdApi } from '../src/sources/tapd-api.ts'
import { PoolItemSchema, poolItemKey } from '../src/sources/tapd-filter-schemes.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { runPoolDaily } from '../src/sources/tapd-filter-pool-run.ts'
import { poolAuthorization, hostPoolAuthorization, legacyPoolReauthorization } from '../src/sources/tapd-pool-authorization.ts'
import { candidateCard, type LinkHost } from '../src/app/links.ts'
import { triggerCard } from '../src/app/cards.ts'
import { triggerMessage, batchLine } from '../src/executor/dsh.ts'
import { poolIntakeStatus } from '../src/app/tapd-pool-status.ts'

async function fixture(manual = true) {
  const config = TapdConfigSchema.parse({ members: [{ alias: 'alice', name: '甲' }],
    filterPool: { owner: 'alice', autoProcess: !manual, maxPerRun: 1, items: [PoolItemSchema.parse({ id: '1', kind: 'bug', enabled: true })] } })
  const values = new Map<string, unknown>(), triggers: Trigger[] = []
  const state: SourceContext['state'] = { get: key => values.get(key) as never, set: (key, value) => { values.set(key, value) }, keys: () => [] }
  const ctx = { state, atomic: (fn: () => unknown) => fn(), receive: async (trigger: Trigger) => {
    expect(poolAuthorization(state, config, trigger)).toBeDefined()
    triggers.push(trigger); return 'stored'
  } } as SourceContext
  const api = { items: async () => [itemOf('bug', { id: '1', workspace_id: config.workspace, current_owner: '甲', title: '问题', description: '' })] } as unknown as TapdApi
  await runPoolDaily(ctx, api, config, new Date(2026, 10, 18, 2), undefined, manual)
  const trigger = triggers[0]!
  const store = { get: state.get, settings: () => SettingsSchema.parse({ sources: { tapd: { enabled: true, config } }, eval: { mode: 'off' } }) }
  return { config, ctx, api, state, values, triggers, trigger, store }
}
it('persists a manual repair instruction when autoProcess is off; machine identity remains unchanged', async () => {
  const h = await fixture()
  expect(h.trigger.human).toBe(false); expect(h.trigger.actor.id).toBe('')
  expect(h.trigger.meta.authorization).toBeUndefined()
  const grant = hostPoolAuthorization(h.store, h.trigger)
  expect(grant).toMatchObject({ authority: 'host_pool', action: 'repair', invocation: 'manual', loginName: 'alice', tapdOwner: '甲', itemId: '1' })
  expect(triggerMessage(h.trigger, {}, undefined, undefined, grant).authorization).toEqual(grant)
  expect(batchLine(h.trigger, grant).authorization).toEqual(grant)
  expect(triggerCard(h.trigger, undefined, grant).authorization).toEqual(grant)
})
it('records daily scheduling separately, rather than inventing a new human click', async () => {
  const h = await fixture(false)
  expect(poolAuthorization(h.state, h.config, h.trigger)?.invocation).toBe('daily')
})
it('projects authorization onto the primary candidate and batch with clear routing intent', async () => {
  const h = await fixture(), grant = hostPoolAuthorization(h.store, h.trigger)
  const host = { store: { ...h.store, triggers: { disposition: () => ({ fanout: [] }) }, threads: { get: () => undefined }, tickets: { get: () => undefined } },
    sources: { repliesTo: () => undefined, find: () => ({ threads: [] }) } } as unknown as LinkHost
  const key = KV.tapd.pool(h.config.filterPool.name), ledger = h.state.get(key)!
  const oldKey = poolItemKey(h.config.workspace, 'alice', { kind: 'bug', id: '1' }), record = ledger.records![oldKey]!
  const second: Trigger = { ...h.trigger, id: h.trigger.id.replace('bug:1:', 'bug:2:'), meta: { ...h.trigger.meta, id: '2' } }
  h.state.set(key, { ...ledger, records: { ...ledger.records,
    [poolItemKey(h.config.workspace, 'alice', { kind: 'bug', id: '2' })]: { ...record, triggerId: second.id,
      item: { ...record.item!, id: '2' }, authorization: { ...record.authorization!, itemId: '2' } } } })
  const card = await candidateCard(host, { triggers: [second, h.trigger], tickets: [], strength: 'explicit' } as unknown as Candidate)
  expect(card.authorization).toEqual(grant)
  expect(card.batch?.[0]?.authorization?.itemId).toBe('2')
  expect(card.next_action).toContain('manual invocation does not require automatic scheduling')
  expect(card.next_action).toContain('report concrete blockers')
  expect(card).not.toHaveProperty('autoProcess')
})
it('accepts the verified unsaved enabled draft, not the older disabled configuration snapshot', async () => {
  const h = await fixture()
  const saved = { ...h.config, filterPool: { ...h.config.filterPool, items: h.config.filterPool.items.map(item => ({ ...item, enabled: false })) } }
  expect(poolAuthorization(h.state, saved, h.trigger)?.invocation).toBe('manual')
  const key = KV.tapd.pool(h.config.filterPool.name), ledger = h.state.get(key)!, itemKey = poolItemKey(h.config.workspace, 'alice', { kind: 'bug', id: '1' })
  h.state.set(key, { ...ledger, records: { [itemKey]: { ...ledger.records![itemKey]!, authorization: undefined } } })
  expect(legacyPoolReauthorization(h.state, saved, h.trigger)).toBe(false)
})
it('does not trust external authority claims, a forged marker, another project, account or item', async () => {
  const h = await fixture()
  const forged = { ...h.trigger, id: 'external', meta: { ...h.trigger.meta, authorization: { authority: 'host_pool' } } }
  expect(hostPoolAuthorization(h.store, forged)).toBeUndefined()
  expect(poolAuthorization(h.state, h.config, { ...h.trigger, source: 'feishu' })).toBeUndefined()
  expect(poolAuthorization(h.state, { ...h.config, workspace: '100' }, h.trigger)).toBeUndefined()
  expect(poolAuthorization(h.state, { ...h.config, filterPool: { ...h.config.filterPool, owner: 'bob' } }, h.trigger)).toBeUndefined()
  expect(poolAuthorization(h.state, h.config, { ...h.trigger, meta: { ...h.trigger.meta, id: '2' } })).toBeUndefined()
  expect(hostPoolAuthorization({ ...h.store, settings: () => ({ sources: { tapd: { enabled: false, config: h.config } } }) }, h.trigger)).toBeUndefined()
})
it('supports one operator reauthorization of legacy ignored work using the original ID, never an automatic restart or duplicate ticket', async () => {
  const h = await fixture(), repo = new MemoryRepositories()
  const policy: Policy = { version: 'p', paused: false, evalTimeoutMs: 120000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'followup' } }), revalidate: () => true, admitsInferred: () => true }
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: true }) }, assessor: { request: () => {} },
    executor: { start: async () => {}, deliver: async () => {}, stop: async () => {} }, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  engine.receive(h.trigger); engine.evaluateDue(); engine.decide(h.trigger.id, { kind: 'ignore', reason: 'human false, no manual authorization' })
  const key = KV.tapd.pool(h.config.filterPool.name), ledger = h.state.get(key)!, itemKey = poolItemKey(h.config.workspace, 'alice', { kind: 'bug', id: '1' })
  h.state.set(key, { ...ledger, records: { [itemKey]: { ...ledger.records![itemKey]!, authorization: undefined } } })
  const store = { ...repo, ...h.store, triggers: repo.triggers, tickets: repo.tickets, threads: repo.threads, decisions: repo.decisions }
  const inspect = () => poolIntakeStatus(store, h.trigger.id)!
  expect(inspect()).toMatchObject({ phase: 'rejected', retryable: true })
  h.ctx.intake = { status: inspect, requeue: id => engine.reevaluate(id) }
  h.config.filterPool.autoProcess = true
  h.state.set(key, { ...h.state.get(key)!, lastRun: '' })
  expect((await runPoolDaily(h.ctx, h.api, h.config, new Date(2026, 10, 19, 2))).dispatched).toBe(0)
  expect(repo.threads.get(`tapd:${h.config.workspace}:bug:1`)?.pending).not.toContain(h.trigger.id)
  expect((await runPoolDaily(h.ctx, h.api, h.config, new Date(), undefined, true)).dispatched).toBe(1)
  expect(h.triggers).toHaveLength(1)
  expect(hostPoolAuthorization(h.store, h.trigger)?.invocation).toBe('manual')
  engine.evaluateDue(); engine.decide(h.trigger.id, { kind: 'accept', title: '修复', scope: '单据1', reason: 'verified manual authority', acknowledgement: 'received', name: 'fix-item' })
  expect(repo.tickets.list()).toHaveLength(1)
  expect((await runPoolDaily(h.ctx, h.api, h.config, new Date(), undefined, true)).dispatched).toBe(0)
})
it('never fabricates old authorization from metadata without the Host record', async () => {
  const h = await fixture()
  h.values.clear()
  expect(poolAuthorization(h.state, h.config, h.trigger)).toBeUndefined()
  expect(legacyPoolReauthorization(h.state, h.config, h.trigger)).toBe(false)
})
