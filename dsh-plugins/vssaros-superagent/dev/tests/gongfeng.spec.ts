import { afterEach, describe, expect, it, vi } from 'vitest'
import { GongfengConfigSchema, GongfengOpenApi, type GongfengApi, type GongfengMr, type GongfengNote } from '../src/sources/gongfeng-api.ts'
import { claimGongfengMr, gongfengTrigger, makeGongfengKind, observeGongfengMr, pollGongfeng } from '../src/sources/gongfeng.ts'
import { KV } from '../src/kv.ts'
import { key } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { mappedProject } from '../src/executor/git-workspace.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const config = GongfengConfigSchema.parse({ project: '123', agent: 'bot' })
const mr = (overrides: Partial<GongfengMr> = {}): GongfengMr => ({ id: 700, iid: 5, project_id: 123, source_project_id: 123, target_project_id: 123,
  title: '@bot fix', description: 'MR body', author: { id: 1, username: 'alice' }, state: 'opened', source_branch: 'feature', target_branch: 'main',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...overrides })
const note = (overrides: Partial<GongfengNote> = {}): GongfengNote => ({ id: 9, body: '@bot review', author: { id: 1, username: 'alice' },
  created_at: '2026-01-01T00:00:00Z', system: false, ...overrides })
let h: Host | undefined
const apiStand = (current = mr()): GongfengApi => ({ verify: async () => ({ project: '123', path: 'group/repo', username: 'bot', canPush: true }),
  mrs: async () => ({ items: [current], next: null }), mr: async () => current,
  notes: async () => ({ items: [], next: null }), note: vi.fn(async () => {}), create: vi.fn(async () => current) })
afterEach(async () => { await h?.stop(); h = undefined; vi.unstubAllGlobals() })

describe('independent Gongfeng API v3', () => {
  it('resolves IID to internal MR ID for detail and notes; never uses GitHub endpoints', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init: init! })
      const data = url.includes('/notes') ? [note()] : url.includes('?iid=') ? [mr()] : mr()
      return Response.json(data, { headers: { 'x-next-page': '' } })
    }) as typeof globalThis.fetch
    const api = new GongfengOpenApi(config, { token: () => 'secret', fetch })
    expect(await api.mr(5)).toMatchObject({ id: 700, iid: 5 })
    expect(await api.notes(700, 1)).toMatchObject({ items: [{ id: 9 }], next: null })
    expect(calls[0]!.url).toContain('/api/v3/projects/123/merge_requests?iid=5')
    expect(calls[1]!.url).toBe('https://git.woa.com/api/v3/projects/123/merge_requests/700')
    expect(calls[2]!.url).toContain('/merge_requests/700/notes')
    expect(calls.every(call => call.init.redirect === 'error')).toBe(true)
    expect(calls[0]!.init.headers).toMatchObject({ 'PRIVATE-TOKEN': 'secret' })
    expect(JSON.stringify(await api.mr(5))).not.toContain('secret')
  })
  it('checks account/project permissions and fails closed on wrong identities and malformed envelopes', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => Response.json(String(input).endsWith('/user')
      ? { id: 2, username: 'bot' } : { id: 123, path_with_namespace: 'group/repo', permissions: { project_access: { access_level: 30 } } })) as typeof globalThis.fetch
    const api = new GongfengOpenApi(config, { fetch, token: () => 'secret' })
    expect(await api.verify('bot')).toMatchObject({ canPush: true, path: 'group/repo' })
    await expect(api.verify('different')).rejects.toThrow('differs')
    const broken = new GongfengOpenApi(config, { token: () => 'secret', fetch: async () => Response.json({ data: [mr()] }) })
    await expect(broken.mrs(1)).rejects.toThrow('schema')
  })
  it('enforces paging, cancellation, missing credentials and redacted failures without write retries', async () => {
    const fetch = vi.fn(async () => new Response('secret-details', { status: 403 }))
    const api = new GongfengOpenApi(config, { token: () => 'secret', fetch })
    await expect(api.note(700, 'reply')).rejects.toThrow('HTTP 403')
    expect(fetch).toHaveBeenCalledOnce()
    try { await api.mr(5) } catch (error) { expect(String(error)).not.toContain('secret-details') }
    await expect(api.mrs(11)).rejects.toThrow('Page')
    const cancel = new AbortController(); cancel.abort()
    fetch.mockClear(); await expect(api.mrs(1, cancel.signal)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled()
    await expect(new GongfengOpenApi(config, { token: () => undefined, fetch }).mrs(1)).rejects.toThrow('GONGFENG_TOKEN')
    expect(fetch).not.toHaveBeenCalled()
    const capped = new GongfengOpenApi(config, { token: () => 'secret', fetch: async () => Response.json(Array.from({ length: 50 }, () => mr())) })
    await expect(capped.mrs(10)).rejects.toThrow('Pagination limit')
  })
})

it('rejects unsupported credential targets and does not accept a mismatched creation response', async () => {
  for (const api of ['https://other.test/api/v3', 'http://git.woa.com/api/v3', 'https://git.woa.com/api/v4', 'https://user:password@git.woa.com/api/v3']) {
    expect(GongfengConfigSchema.safeParse({ api }).success).toBe(false)
  }
  const fetch = vi.fn(async () => Response.json(mr({ author: { id: 2, username: 'bot' }, source_branch: 'other' })))
  const api = new GongfengOpenApi(config, { token: () => 'secret', fetch })
  await expect(api.create({ source_branch: 'agent/current', target_branch: 'main', title: 't', description: '' })).rejects.toThrow('inspect the project')
  expect(fetch).toHaveBeenCalledOnce()
})

it('distinguishes human/bot/self and isolates project IDs and mention boundaries', () => {
  expect(gongfengTrigger(config, mr(), 'group/repo')).toMatchObject({ source: 'gongfeng', human: true, addressed: 'mention', meta: { iid: 5, mrId: 700 } })
  expect(gongfengTrigger(config, mr({ author: { id: 2, username: 'bot' } }), 'group/repo')).toBeUndefined()
  expect(gongfengTrigger(config, mr({ project_id: 999 }), 'group/repo')).toBeUndefined()
  expect(gongfengTrigger(config, mr(), 'group/repo', note({ system: true }))).toBeUndefined()
  const botConfig = { ...config, bots: [{ id: 'ci' }] }
  expect(gongfengTrigger(botConfig, mr(), 'group/repo', note({ author: { id: 3, username: 'ci' } }))).toMatchObject({ human: false })
  expect(gongfengTrigger(config, mr({ title: '@bot-other' }), 'group/repo')?.addressed).toBeUndefined()
})

it('registers independent Source settings, protects account changes and selects trusted local project mappings', async () => {
  h = await startRuntime()
  h.runtime.sources.register(makeGongfengKind(() => h!.runtime.context({ kind: 'gongfeng', health: ['gongfeng'] })))
  const store = h.runtime.store, old = store.settings().sources.github
  await expect(h.runtime.settings.save('source:gongfeng', { enabled: true, config }, store.blockRevision('source:gongfeng'), 'tool')).rejects.toThrow('panel')
  await h.runtime.settings.save('source:gongfeng', { enabled: true, config }, store.blockRevision('source:gongfeng'), 'panel')
  expect(store.settings().sources.github).toEqual(old)
  expect(h.runtime.sources.instances().find(row => row.id === 'gongfeng')).toMatchObject({ installed: true })
  const trigger = gongfengTrigger(config, mr(), 'group/repo')!
  const settings = SettingsSchema.parse({ sources: { gongfeng: { enabled: true, config } }, executor: { projects: [
    { id: 'work', source: 'gongfeng', projectId: '123', repository: h.directory, ref: 'main' },
  ] } })
  expect(mappedProject(settings, trigger)).toMatchObject({ source: 'gongfeng', strategy: 'git-worktree' })
  expect(mappedProject(settings, { ...trigger, meta: { ...trigger.meta, project: '999' } })).toBeUndefined()
})

it('baselines existing MRs, deduplicates restart reads, and advances only after successful ingestion', async () => {
  h = await startRuntime()
  const received: string[] = []
  const source = h.runtime.context({ kind: 'superagent', health: [] })
  const current = mr(), api = apiStand(current), watchConfig = { ...config, observeMrs: true }
  const ctx = { ...source, threads: source.threads, tickets: source.tickets, state: source.state, config: () => watchConfig,
    receive: vi.fn(async (trigger) => { expect(trigger.human).toBe(false); expect(trigger.addressed).toBeUndefined(); received.push(trigger.id); return { triggers: [] } }) } as unknown as typeof source
  await pollGongfeng(ctx, watchConfig, api)
  expect(received).toEqual([])
  current.updated_at = new Date(Date.now() + 1000).toISOString(); current.description = 'changed'
  await pollGongfeng(ctx, watchConfig, api)
  expect(received).toHaveLength(1)
  await pollGongfeng(ctx, watchConfig, api)
  expect(received).toHaveLength(1)
  const before = source.state.get(KV.gongfeng.watch('123'))
  current.description = 'next'; current.updated_at = new Date(Date.now() + 2000).toISOString()
  ctx.receive = vi.fn(async () => { throw new Error('inbox unavailable') })
  await expect(pollGongfeng(ctx, watchConfig, api)).rejects.toThrow('inbox unavailable')
  expect(source.state.get(KV.gongfeng.watch('123'))).toEqual(before)
})

it('binds only the source or verified ticket MR, refuses cross-ticket/fork claims, and tracks terminal state', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix'))
  h.runtime.sources.register(makeGongfengKind(() => h!.runtime.context({ kind: 'gongfeng', health: ['gongfeng'] })))
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), sources: { ...h.runtime.store.settings().sources, gongfeng: { enabled: true, config } } })
  const ctx = h.runtime.context({ kind: 'gongfeng', health: ['gongfeng'] })
  const own = mr({ author: { id: 2, username: 'bot' }, source_branch: `agent/${ticket.execution!.name}` })
  expect(claimGongfengMr(ctx, config, ticket.id, { ...own, source_project_id: 999 }, 'group/repo')).toContain('does not belong')
  expect(claimGongfengMr(ctx, config, ticket.id, own, 'group/repo')).toBeUndefined()
  expect(h.runtime.store.tickets.get(ticket.id)?.follows).toContainEqual(expect.objectContaining({ thread: 'gongfeng:123:5', own: true }))
  const { ticket: other } = await h.acceptedTicket(feishu('2', '@bot another'))
  expect(claimGongfengMr(ctx, config, other.id, { ...own, source_branch: `agent/${other.execution!.name}` }, 'group/repo')).toContain('another active ticket')
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'ready', summary: 'verified' })
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  observeGongfengMr(ctx, config, { ...own, state: 'merged', merged_at: new Date().toISOString() })
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('merged')
})

it('requires a source MR on ready, keeps rejected reports atomic, and does not execute GitHub API calls', async () => {
  h = await startRuntime()
  h.runtime.sources.register(makeGongfengKind(() => h!.runtime.context({ kind: 'gongfeng', health: ['gongfeng'] })))
  const store = h.runtime.store, saved = store.settings()
  store.saveSettings({ ...saved, sources: { ...saved.sources, gongfeng: { enabled: true, config } },
    policy: { ...saved.policy, sources: { ...saved.policy.sources, gongfeng: { allowed: [{ id: 'alice' }] } } } })
  const source = gongfengTrigger(config, mr(), 'group/repo')!
  const { ticket } = await h.acceptedTicket(source)
  const api = apiStand()
  const toolHost = Reflect.get(h.runtime, 'toolHost') as ExecutorToolsHost
  const report = executorTools({ ...toolHost, gongfengApi: () => api }, ticket).find(tool => tool.name === 'orchestrator_report')!
  const signal = new AbortController().signal
  await expect(report.execute({ state: 'ready', summary: 'tested' }, signal)).rejects.toThrow('requires mr_iid')
  const before = store.tickets.get(ticket.id)
  api.mr = async () => mr({ iid: 6 })
  await expect(report.execute({ state: 'ready', summary: 'tested', mr_iid: 6 }, signal)).rejects.toThrow('does not belong')
  expect(store.tickets.get(ticket.id)).toEqual(before)
  api.mr = async () => mr()
  expect(await report.execute({ state: 'ready', summary: 'tested', mr_iid: 5 }, signal)).toMatchObject({ reported: true })
  expect(store.tickets.get(ticket.id)?.follows).toContainEqual(expect.objectContaining({ thread: 'gongfeng:123:5' }))
  expect(store.tickets.get(ticket.id)?.ended).toBeUndefined()
})

it('finds duplicate MRs beyond page one and persists unknown creation outcomes before any retry', async () => {
  h = await startRuntime()
  h.runtime.sources.register(makeGongfengKind(() => h!.runtime.context({ kind: 'gongfeng', health: ['gongfeng'] })))
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), sources: { ...h.runtime.store.settings().sources, gongfeng: { enabled: true, config } } })
  const { ticket } = await h.acceptedTicket(feishu('create', '@bot create a fix'))
  const api = apiStand(), branch = `agent/${ticket.execution!.name}`
  api.mrs = async page => page === 1 ? { items: [], next: 2 } : { items: [mr({ source_branch: branch })], next: null }
  const toolHost = Reflect.get(h.runtime, 'toolHost') as ExecutorToolsHost
  const tool = executorTools({ ...toolHost, gongfengApi: () => api }, ticket).find(tool => tool.name === 'orchestrator_gongfeng_mr')!
  const args = { action: 'create', title: 'fix', target_branch: 'main' }, signal = new AbortController().signal
  await expect(tool.execute(args, signal)).rejects.toThrow('already exists')
  expect(api.create).not.toHaveBeenCalled()
  api.mrs = async () => ({ items: [], next: null })
  api.create = vi.fn(async () => { throw new Error('outcome unknown') })
  await expect(tool.execute(args, signal)).rejects.toThrow('outcome unknown')
  await expect(tool.execute(args, signal)).rejects.toThrow('already attempted')
  expect(api.create).toHaveBeenCalledOnce()
  expect(h.runtime.store.get(KV.gongfeng.creation('123', ticket.id))).toEqual({ branch })
})

it('does not trust another author\'s reply marker or automatically resend an uncertain write', async () => {
  const records = new Map<string, unknown>(), api = apiStand()
  const ctx = { config: () => config, state: { get: (key: string) => records.get(key), set: (key: string, value: unknown) => records.set(key, value) } } as unknown as ReturnType<Host['runtime']['context']>
  const kind = makeGongfengKind(() => ctx, () => api)
  api.note = vi.fn(async () => { throw new Error('outcome unknown') })
  const message = { id: 'unknown', channel: { source: 'gongfeng', thread: 'gongfeng:123:5', address: { project: '123', iid: '5' } }, text: 'reply', kind: 'notice' } as const
  api.notes = async () => ({ items: [note({ body: `<!-- dsh-superagent:${key('gongfeng-reply', message.id)} -->` })], next: null })
  await expect(kind.channel!.send({ commands: {} } as never, message)).rejects.toThrow('outcome unknown')
  await expect(kind.channel!.send({ commands: {} } as never, message)).rejects.toThrow('uncertain')
  expect(api.note).toHaveBeenCalledOnce()
})

it('reads notes idempotently before posting replies, and never retries a failed POST', async () => {
  let current = mr(), notes: GongfengNote[] = []
  const api = apiStand(current)
  api.notes = async () => ({ items: notes, next: null })
  api.note = vi.fn(async (_id, body) => { notes.push(note({ body })) })
  const records = new Map<string, unknown>()
  const fakeContext = { config: () => config, state: { get: (key: string) => records.get(key), set: (key: string, value: unknown) => records.set(key, value) } } as unknown as ReturnType<Host['runtime']['context']>
  const kind = makeGongfengKind(() => fakeContext, () => api)
  const message = { id: 'reply-1', channel: { source: 'gongfeng', thread: 'gongfeng:123:5', address: { project: '123', iid: '5' } }, text: 'reply', kind: 'notice' } as const
  expect(await kind.channel!.send({ commands: {} } as never, message)).toBe('sent')
  expect(await kind.channel!.send({ commands: {} } as never, message)).toBe('sent')
  expect(api.note).toHaveBeenCalledOnce()
  current = { ...current, state: 'merged' }; api.mr = async () => current
  expect(await kind.channel!.send({ commands: {} } as never, { ...message, id: 'new' })).toBe('gone')
})
