import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { itemOf, TapdConfigSchema, TapdOpenApi } from '../src/sources/tapd-api.ts'
import { applyOwnerOverride, FilterConditionSchema, PoolItemSchema, TapdFilterSchemeSchema } from '../src/sources/tapd-filter-schemes.ts'
import type { SourceContext } from '../src/sources/host.ts'

beforeEach(() => { vi.spyOn(TapdOpenApi.prototype, 'directoryMembers').mockResolvedValue([{ user: 'qiuzijian', name: 'qiuzijian', staffId: '123456' }]) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  const state = new Map<string, unknown>()
  registerHttp(ctx as never, { ready: Promise.resolve(), readTapdUser: async () => ({ signedIn: true, loginName: 'qiuzijian', userId: 'test-user', staffId: '123456' }),
    ...runtime, store: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value),
      ...(runtime.store as object ?? {}) } } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('provides bounded tool metadata queries behind the local API protection', async () => {
  const response = { enabled: false, retentionDays: 7, maxRows: 10000, items: [], nextCursor: null,
    summary: { sampled: 0, rootCalls: 0, nestedCalls: 0, errors: 0, sameInputRepeats: 0 } }
  const view = vi.fn(() => response), call = serve({ store: {}, toolTrace: { view } })
  expect(await call('GET', 'tools/trace?ticketId=t&limit=10')).toMatchObject({ status: 200, body: response })
  expect(view).toHaveBeenCalledWith({ ticketId: 't', limit: 10 })
  expect(await call('GET', 'tools/trace?limit=101')).toMatchObject({ status: 400 })
  expect(await call('GET', 'tools/trace', undefined, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
  expect(view).toHaveBeenCalledOnce()
})

it('exposes only a bounded read-only workspace preview under the existing local API protections', async () => {
  const response = { readOnly: true, checkedAt: '', retentionDays: 14, total: 0, offset: 0, nextOffset: null, items: [] }
  const inventory = vi.fn(async () => response)
  const call = serve({ store: {}, executor: { inventory } })
  expect(await call('GET', 'executor/workspaces?offset=0&limit=5')).toEqual({ status: 200, body: response })
  expect(inventory).toHaveBeenCalledWith(0, 5)
  for (const query of ['limit=100', 'offset=-1', 'limit=0', 'offset=bad']) {
    expect(await call('GET', `executor/workspaces?${query}`)).toMatchObject({ status: 400 })
  }
  expect(inventory).toHaveBeenCalledOnce()
  expect(await call('GET', 'executor/workspaces', undefined, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
  expect(await call('POST', 'executor/workspaces')).toMatchObject({ status: 404 })
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('TAPD manual execution reaches receive while auto is off, respects idempotency and rejects an inactive source', async () => {
  const values = new Map<string, unknown>()
  const tickets: { id: string; assignments: []; updatedAt: string; origin: { triggerIds: string[] }; ended?: { outcome: string; at: string } }[] = []
  const store = { settings: () => ({ sources: { tapd: { enabled: true, config } } }), tickets: { list: () => tickets },
    triggers: { get: () => undefined },
    get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) }
  const config = TapdConfigSchema.parse({ filterPool: { owner: 'qiuzijian', autoProcess: false,
    items: [PoolItemSchema.parse({ id: '123', kind: 'bug', enabled: true })] } })
  const receive = vi.fn(async (_trigger: { id: string }) => 'stored')
  const context = { atomic: (fn: () => unknown) => fn(), state: store, receive } as unknown as SourceContext
  const spy = vi.spyOn(TapdOpenApi.prototype, 'items').mockResolvedValue([itemOf('bug', {
    id: '123', workspace_id: config.workspace, title: '修复 HUD', current_owner: 'qiuzijian', modified: '2026-11-17 01:00:00' })])
  try {
    const call = serve({ store, context: () => context, configured: () => true })
    const result = await call('POST', 'sources/tapd/filter-schemes/run', { pool: config.filterPool })
    expect(result).toMatchObject({ status: 200, body: { dispatched: 1, pool: { items: [{ state: 'queued' }] } } })
    expect(receive).toHaveBeenCalledOnce()
    expect(await call('GET', 'sources/tapd/filter-schemes/pool')).toMatchObject({ body: { items: [{ state: 'queued' }] } })
    tickets.push({ id: 'ticket-1', assignments: [], updatedAt: '2026-11-17T05:00:00Z', origin: { triggerIds: [receive.mock.calls[0]![0].id] } })
    expect(await call('GET', 'sources/tapd/filter-schemes/pool')).toMatchObject({ body: { items: [{ state: 'processing' }] } })
    tickets[0]!.ended = { outcome: 'completed', at: '2026-11-17T06:00:00Z' }
    expect(await call('GET', 'sources/tapd/filter-schemes/pool')).toMatchObject({ body: { items: [{ state: 'done' }] } })
    expect(await call('POST', 'sources/tapd/filter-schemes/run', { pool: config.filterPool })).toMatchObject({ body: { dispatched: 0 } })
    const inactive = serve({ store, context: () => context, configured: () => false })
    expect(await inactive('POST', 'sources/tapd/filter-schemes/run', { pool: config.filterPool })).toMatchObject({ status: 400 })
  } finally { spy.mockRestore() }
})

it('TAPD preview uses unsaved conditions, applies local exclusions, and refuses missing schemes without an API call', async () => {
  const config = TapdConfigSchema.parse({})
  const scheme = TapdFilterSchemeSchema.parse({ name: 'b', kind: 'bug', url: 'https://example.test',
    conditions: applyOwnerOverride([FilterConditionSchema.parse({ field: '标题', op: '不包含 (Not Like)', value: ['排除'] })], 'qiuzijian') })
  const spy = vi.spyOn(TapdOpenApi.prototype, 'items').mockResolvedValue([
    itemOf('bug', { id: '1', workspace_id: config.workspace, current_owner: 'qiuzijian', title: '保留' }),
    itemOf('bug', { id: '2', workspace_id: config.workspace, current_owner: 'qiuzijian', title: '排除' })])
  const maps = vi.spyOn(TapdOpenApi.prototype, 'filterMaps').mockResolvedValue({ fieldNames: {}, statusCodes: {} })
  try {
    const call = serve({ store: { settings: () => ({ sources: { tapd: { config } } }) } })
    expect(await call('POST', 'sources/tapd/filter-schemes/preview', { kind: 'bug' })).toMatchObject({ status: 400 })
    expect(spy).not.toHaveBeenCalled()
    const result = await call('POST', 'sources/tapd/filter-schemes/preview', { kind: 'bug', scheme, maxPerRun: 20 })
    expect(result).toMatchObject({ status: 200, body: { total: 1, items: [{ id: '1', enabled: false }] } })
  } finally { spy.mockRestore(); maps.mockRestore() }
})

it('sync uses the Host browser without a CDP variable and preserves second-precision rendered values', async () => {
  vi.stubEnv('DSH_SUPERAGENT_TAPD_CDP', '')
  const readTapdFilterPage = vi.fn(async (kind: 'story' | 'bug') => [
    { field: '发布计划', op: '属于 (In)', values: ['PC-rushCBT3'], range: [], enabled: true },
    { field: '处理人', op: '属于 (In)', values: ['网页用户组'], range: [], enabled: true },
    { field: kind === 'story' ? '预计完成时间' : '创建时间', op: '介于 (Range)', values: [], range: ['2024-01-09T00:00', '2026-09-30T23:59:59'], enabled: true },
  ])
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const releases = vi.spyOn(TapdOpenApi.prototype, 'releases').mockResolvedValue([{ label: 'PC-rushCBT3', value: '123' }])
  const maps = vi.spyOn(TapdOpenApi.prototype, 'filterMaps').mockResolvedValue({ fieldNames: {}, statusCodes: {} })
  const items = vi.spyOn(TapdOpenApi.prototype, 'items').mockImplementation(async (kind, workspace) => [
    itemOf(kind, { id: kind === 'story' ? '1' : '2', workspace_id: workspace, current_owner: 'qiuzijian', owner: 'qiuzijian', title: '匹配单据' })])
  const call = serve({ readTapdFilterPage, store: { settings: () => ({ sources: {} }) } })
  const response = await call('POST', 'sources/tapd/filter-schemes/sync', { loginName: 'qiuzijian' })
  expect(response.status).toBe(200)
  expect(response.body.warnings).toEqual([])
  const schemes = response.body.schemes as { source: string; conditions: { field: string; value: unknown; locked: boolean }[] }[]
  expect(schemes).toHaveLength(2)
  expect(schemes.every(row => row.source === 'live')).toBe(true)
  expect(schemes[0]?.conditions.find(row => row.field === '预计完成时间')?.value)
    .toEqual({ from: '2024-01-09T00:00', to: '2026-09-30T23:59:59' })
  expect(schemes.every(row => row.conditions.find(condition => condition.field === '处理人')?.locked)).toBe(true)
  expect(response.body.pool).toMatchObject({ items: [expect.objectContaining({ id: '1', enabled: false }), expect.objectContaining({ id: '2', enabled: false })] })
  expect(response.body.results).toMatchObject([{ kind: 'story', added: 1 }, { kind: 'bug', added: 1 }])
  expect(items).toHaveBeenCalledTimes(2)
  expect(fetch).not.toHaveBeenCalled()
  releases.mockRestore(); maps.mockRestore(); items.mockRestore()
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
})

it('sync keeps a saved custom snapshot and reports the concrete browser failure, not a successful sync', async () => {
  vi.stubEnv('DSH_SUPERAGENT_TAPD_CDP', '')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  const previous = TapdFilterSchemeSchema.parse({ name: 'story', kind: 'story', url: 'https://example.test',
    conditions: applyOwnerOverride([FilterConditionSchema.parse({ field: '状态', op: '属于 (In)', value: ['自定义状态'] })], 'qiuzijian') })
  const call = serve({ readTapdFilterPage: async () => { throw new Error('Chrome not reachable') }, store: { settings: () => ({ sources: {} }) } })
  const response = await call('POST', 'sources/tapd/filter-schemes/sync', { scope: 'story', loginName: 'qiuzijian', schemes: [previous] })
  expect(response).toMatchObject({ status: 200, body: { schemes: [{ source: 'fallback', conditions: previous.conditions }] } })
  expect(String(response.body.warnings)).toContain('Chrome not reachable')
  expect(response.body.results).toEqual([])
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
})

it('automatic sync imports beyond the repair batch cap, preserves draft state and deduplicates while another source fails', async () => {
  vi.stubEnv('DSH_SUPERAGENT_TAPD_CDP', '')
  const api = vi.spyOn(TapdOpenApi.prototype, 'items').mockImplementation(async (kind, workspace) => {
    if (kind === 'bug') throw new Error('TAPD refused the account (HTTP 403)')
    return Array.from({ length: 25 }, (_, i) => itemOf(kind, { id: `s${i}`, workspace_id: workspace, owner: 'qiuzijian', title: '实时标题' }))
  })
  const maps = vi.spyOn(TapdOpenApi.prototype, 'filterMaps').mockResolvedValue({ fieldNames: {}, statusCodes: {} })
  const readTapdFilterPage = async () => [{ field: '处理人', op: 'in', values: ['原网页用户'], enabled: true }]
  const call = serve({ readTapdFilterPage, store: { settings: () => ({ sources: {} }) } })
  const pool = { owner: 'qiuzijian', maxPerRun: 1, items: [PoolItemSchema.parse({ id: 's0', kind: 'story', enabled: true, state: 'done' }),
    PoolItemSchema.parse({ id: 'old', kind: 'bug', enabled: true })] }
  try {
    const response = await call('POST', 'sources/tapd/filter-schemes/sync', { loginName: 'qiuzijian', pool })
    expect(response.body.results).toMatchObject([{ kind: 'story', total: 25, added: 24 }, { kind: 'bug', added: 0, error: expect.stringContaining('403') }])
    const result = response.body.pool as { items: { id: string; enabled: boolean; state: string; title: string }[]; maxPerRun: number }
    expect(result.items).toHaveLength(26)
    expect(result.items.find(item => item.id === 's0')).toMatchObject({ enabled: true, state: 'done', title: '实时标题' })
    expect(result.items.find(item => item.id === 'old')).toMatchObject({ enabled: true })
    expect(result.items.find(item => item.id === 's1')).toMatchObject({ enabled: false, state: 'pending' })
    expect(String(response.body.warnings)).toContain('自动入池失败')
    const second = await call('POST', 'sources/tapd/filter-schemes/sync', { loginName: 'qiuzijian', pool: response.body.pool, scope: 'story' })
    expect(second.body.results).toMatchObject([{ kind: 'story', added: 0 }])
    expect((second.body.pool as { items: unknown[] }).items).toHaveLength(26)
  } finally { api.mockRestore(); maps.mockRestore(); vi.unstubAllEnvs() }
})

it('automatic sync fails closed without an owner and reports the reason instead of querying all TAPD records', async () => {
  vi.stubEnv('DSH_SUPERAGENT_TAPD_CDP', '')
  const api = vi.spyOn(TapdOpenApi.prototype, 'items')
  const call = serve({ readTapdUser: async () => ({ signedIn: false, loginName: '' }),
    readTapdFilterPage: async () => [{ field: '状态', op: 'in', values: ['新建'] }], store: { settings: () => ({ sources: {} }) } })
  try {
    const response = await call('POST', 'sources/tapd/filter-schemes/sync', { scope: 'story' })
    expect(response.body.results).toMatchObject([{ kind: 'story', added: 0, error: expect.stringContaining('企业身份不可用') }])
    expect(api).not.toHaveBeenCalled()
  } finally { api.mockRestore(); vi.unstubAllEnvs() }
})

it('sync resolves the actual TOF alias and release label spelling before importing matched bugs', async () => {
  vi.stubEnv('DSH_SUPERAGENT_TAPD_CDP', '')
  const config = TapdConfigSchema.parse({ members: [{ alias: 'zijianqiu', name: '邱子鉴' }], filterPool: { owner: 'zijianqiu' } })
  const releases = vi.spyOn(TapdOpenApi.prototype, 'releases').mockResolvedValue([{ value: '123', label: 'PC-rushCBT3' }])
  const maps = vi.spyOn(TapdOpenApi.prototype, 'filterMaps').mockResolvedValue({ fieldNames: {}, statusCodes: {} })
  const items = vi.spyOn(TapdOpenApi.prototype, 'items').mockImplementation(async (kind, workspace, query) => {
    expect(query).toEqual({ release_id: '123', current_owner: 'USER_OR<邱子鉴>' })
    return [itemOf(kind, { id: 'matched', workspace_id: workspace, current_owner: '邱子鉴;', title: '真实口径候选' })]
  })
  const call = serve({ readTapdUser: async () => ({ signedIn: true, loginName: 'zijianqiu', userId: 'u-qiu' }),
    readTapdFilterPage: async () => [{ field: '发布计划', op: 'in', values: ['PC-RushCBT3'] },
    { field: '处理人', op: 'in', values: ['原组名'] }], store: { settings: () => ({ sources: { tapd: { enabled: true, config } } }) } })
  try {
    const response = await call('POST', 'sources/tapd/filter-schemes/sync', { scope: 'bug', loginName: 'zijianqiu' })
    expect(response).toMatchObject({ status: 200, body: { warnings: [], results: [{ kind: 'bug', total: 1, added: 1 }],
      pool: { owner: 'zijianqiu', items: [{ id: 'matched', enabled: false }] } } })
  } finally { releases.mockRestore(); maps.mockRestore(); items.mockRestore(); vi.unstubAllEnvs() }
})

it('identity auto matches once, projects no contacts and refuses client-supplied foreign accounts', async () => {
  vi.stubEnv('DSH_SUPERAGENT_TAPD_CDP', '')
  const directory = vi.mocked(TapdOpenApi.prototype.directoryMembers)
  directory.mockResolvedValue([{ user: '甲', name: '甲', staffId: '123456', email: 'private@example.test' }])
  const call = serve({ store: { settings: () => ({ sources: {} }) },
    readTapdFilterPage: async () => [{ field: '处理人', op: 'in', values: ['网页组名'] }] })
  const first = await call('GET', 'sources/tapd/identity')
  expect(first).toMatchObject({ status: 200, body: { source: 'automatic', tapdName: '甲', cached: false } })
  expect(JSON.stringify(first)).not.toContain('private@example.test')
  expect(await call('GET', 'sources/tapd/identity')).toMatchObject({ body: { cached: true } })
  expect(directory).toHaveBeenCalledOnce()
  const maps = vi.spyOn(TapdOpenApi.prototype, 'filterMaps').mockResolvedValue({ fieldNames: {}, statusCodes: {} })
  const items = vi.spyOn(TapdOpenApi.prototype, 'items').mockImplementation(async (kind, workspace, query) => {
    expect(query.current_owner).toBe('USER_OR<甲>')
    return [itemOf(kind, { id: '1', workspace_id: workspace, current_owner: '甲' })]
  })
  const synced = await call('POST', 'sources/tapd/filter-schemes/sync', { loginName: 'other-account', scope: 'bug' })
  expect(synced).toMatchObject({ body: { identity: { loginName: 'qiuzijian' }, pool: { owner: 'qiuzijian', items: [{ id: '1', enabled: false }] } } })
  maps.mockRestore(); items.mockRestore()
})

it('identity confirmation validates the workspace member, remembers it and rejects account/project switches', async () => {
  const directory = vi.mocked(TapdOpenApi.prototype.directoryMembers)
  directory.mockResolvedValue([{ user: 'TAPD甲', name: '甲' }])
  let loginName = 'qiuzijian'
  const call = serve({ store: { settings: () => ({ sources: {} }) }, readTapdUser: async () => ({ signedIn: true, loginName, userId: loginName }) })
  expect(await call('GET', 'sources/tapd/identity')).toMatchObject({ body: { status: 'unmatched' } })
  expect(await call('POST', 'sources/tapd/identity/confirm', { loginName, workspace: '68880148', name: '不存在' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'sources/tapd/identity/confirm', { loginName, workspace: '100', name: '甲' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'sources/tapd/identity/confirm', { loginName, workspace: '68880148', name: '甲' }))
    .toMatchObject({ status: 200, body: { source: 'confirmed', tapdName: 'TAPD甲' } })
  const reads = directory.mock.calls.length
  expect(await call('GET', 'sources/tapd/identity')).toMatchObject({ body: { source: 'confirmed', cached: true } })
  expect(directory.mock.calls.length).toBe(reads)
  loginName = 'bob'
  expect(await call('GET', 'sources/tapd/identity')).toMatchObject({ body: { loginName: 'bob', status: 'unmatched', tapdName: '' } })
  expect(await call('POST', 'sources/tapd/identity/confirm', { loginName: 'qiuzijian', workspace: '68880148', name: '甲' })).toMatchObject({ status: 400 })
})
