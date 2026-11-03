/**
 * VsSaros addition: the TAPD Source. The access layer is checked against TAPD's documented envelopes with a stand-in fetch
 * and a stand-in mcporter; the Source runs in the real runtime against a simulated TAPD. No test talks to TAPD.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Commands } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import { changeEndNotices } from '../src/sources/p4-change.ts'
import { commentTrigger, itemTrigger, makeTapdKind, mentions, pollComments, pollWatch, replyMarker, resolvedConfig, sendTapd, threadItem,
  watchFilter } from '../src/sources/tapd.ts'
import { itemAddress, itemOf, itemPage, nodeCli, plainText, records, TapdConfigSchema, TapdError, tapdConfigured, tapdInstant, TapdMcp, TapdOpenApi, tapdTime,
  watchWorkspace, type TapdApi, type TapdComment, type TapdItem, type TapdType } from '../src/sources/tapd-api.ts'
import { allMembers, cleanOwner, platformMembers, refreshPlatformMembers, resetPlatformMembers, resolveTapdName } from '../src/sources/tapd-members.ts'
import type { Ticket } from '../src/core/index.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const story = { id: '1168880148001000001', name: '登录页 4K 下错位', description: '<p>复现：<br/>4K 屏&nbsp;打开登录页</p>', status: 'open',
  owner: 'saros-bot;张三;', creator: '张三', created: '2026-11-03 10:00:00', modified: '2026-11-03 10:05:00', iteration_id: '77', workspace_id: '68880148' }

describe('the optional TAPD identity', () => {
  const watch = { name: 'w1', workspace: '68880148', type: 'story' as const, item: '', status: '', owner: '', iteration: '', mode: 'all' as const }
  it('needs a watch to be configured, not an identity name', () => {
    const config = TapdConfigSchema.parse({ watches: [watch] })
    expect(config.agent).toBe('')
    expect(tapdConfigured(config)).toBe(true)
    expect(tapdConfigured(TapdConfigSchema.parse({ agent: '邱子鉴' }))).toBe(false)
  })
  it('skips assignment and @ matching, and keeps every author human, when no identity is set', () => {
    const config = TapdConfigSchema.parse({})
    expect(mentions('@bot please look', config.agent)).toBe(false)
    const item: TapdItem = { type: 'story', workspace: '68880148', id: '1', title: '登录页错位', description: '@bot please look',
      status: 'open', owners: ['张三'], creator: '张三', created: '2026-11-03 10:00:00', modified: '2026-11-03 10:05:00', iteration: '' }
    const trigger = itemTrigger(item, 'item', config, watch)
    expect(trigger.addressed).toBeUndefined()
    expect(trigger.human).toBe(true)
  })
  it('observes an "assigned" watch in full when no identity is set, and keeps the old behaviour when one is', () => {
    const kind = makeTapdKind({ context: () => undefined })
    const meta = { meta: { kind: 'item', mode: 'assigned' } }
    expect(kind.scope!(meta, TapdConfigSchema.parse({}))).toMatchObject({ listened: true, observed: true })
    expect(kind.scope!(meta, TapdConfigSchema.parse({ agent: '邱子鉴' }))).toMatchObject({ listened: true, observed: false })
  })
})

describe('saroasis-platform alignment', () => {
  afterEach(() => resetPlatformMembers())

  it('defaults to the GR workspace and lets a watch inherit or override it', () => {
    const inherited = TapdConfigSchema.parse({ watches: [{ name: 'w', type: 'story' }] })
    expect(inherited.workspace).toBe('68880148')
    expect(inherited.watches[0]!.workspace).toBe('')
    expect(watchWorkspace(inherited, inherited.watches[0]!)).toBe('68880148')
    const own = TapdConfigSchema.parse({ watches: [{ name: 'w', type: 'bug', workspace: '123' }] })
    expect(watchWorkspace(own, own.watches[0]!)).toBe('123')
  })

  it('maps WeCom aliases to TAPD Chinese names and strips trailing semicolons', () => {
    expect(cleanOwner('邱子鉴;蒋小川;')).toBe('邱子鉴;蒋小川')
    expect(cleanOwner(' 张三； ')).toBe('张三')
    expect(resolveTapdName('zijianqiu', [{ alias: 'zijianqiu', name: '邱子鉴' }])).toBe('邱子鉴')
    expect(resolveTapdName('邱子鉴;', [])).toBe('邱子鉴')
    expect(resolveTapdName('nobody', [])).toBe('nobody')
    const config = TapdConfigSchema.parse({ agent: 'zijianqiu', members: [{ alias: 'zijianqiu', name: '邱子鉴' }],
      watches: [{ name: 'b', type: 'bug', owner: 'zijianqiu;' }, { name: 's', type: 'story', owner: '张三;' }] })
    const resolved = resolvedConfig(config)
    expect(resolved.agent).toBe('邱子鉴')
    expect(resolved.watches.map(watch => watch.owner)).toEqual(['邱子鉴', '张三'])
  })

  it('uses current_owner for bugs and owner for stories, both without semicolons', () => {
    const bug = TapdConfigSchema.parse({ watches: [{ name: 'b', type: 'bug', owner: '张三;' }] }).watches[0]!
    const story = TapdConfigSchema.parse({ watches: [{ name: 's', type: 'story', owner: '张三;' }] }).watches[0]!
    expect(watchFilter(bug)).toEqual({ current_owner: '张三' })
    expect(watchFilter(story)).toEqual({ owner: '张三' })
    expect(itemOf('bug', { current_owner: '张三；李四;' })).toMatchObject({ owners: ['张三', '李四'] })
  })

  it('caches the platform member table and merges it with static mappings', async () => {
    const base = 'http://platform.example:9999'
    const fetched = vi.fn(async () => ({ ok: true, json: async () => ({ groups: [{ members: [
      { user: '邱子鉴;', wecomAlias: 'zijianqiu' }, { user: '张三', wecomAlias: 'zhangsan' }] }] }) }))
    expect(platformMembers(base)).toBeUndefined()
    await refreshPlatformMembers(base, fetched as unknown as typeof fetch)
    expect(fetched).toHaveBeenCalledWith(base + '/api/tapd/members', expect.anything())
    expect(platformMembers(base)).toEqual([{ alias: 'zijianqiu', name: '邱子鉴' }, { alias: 'zhangsan', name: '张三' }])
    const config = TapdConfigSchema.parse({ memberApi: base, members: [{ alias: 'bot', name: '机器人' }], agent: 'zijianqiu' })
    expect(resolveTapdName(config.agent, allMembers(config))).toBe('邱子鉴')
  })

  it('rejects TAPD\'s Hello-world answer to an unknown API path', () => {
    expect(() => records({ status: 1, data: 'Hello world from TAPD API', info: 'success' })).toThrow(/API path does not exist/)
  })

  it('refuses offset because TAPD ignores it and always returns page 1', async () => {
    const api = new TapdOpenApi({ api: 'https://api.tapd.cn', environment: { DSH_SUPERAGENT_TAPD_BEARER: 'x' },
      fetch: async () => new Response('[]') })
    await expect(api.items('story', '68880148', { offset: '2' })).rejects.toThrow(/offset/)
  })
})

describe('TAPD data', () => {
  it('strips TAPD\'s envelope, an MCP result around it, and the one-key record wrapper', () => {
    const tapd = { status: 1, data: [{ Story: story }, { Story: { ...story, id: '2' } }], info: 'success' }
    expect(records(JSON.stringify(tapd)).map(record => record.id)).toEqual([story.id, '2'])
    expect(records({ content: [{ type: 'text', text: JSON.stringify(tapd) }] }).map(record => record.id)).toEqual([story.id, '2'])
    expect(records({ structuredContent: tapd }).map(record => record.name)).toEqual([story.name, story.name])
    expect(records({ status: 1, data: { Comment: { id: '9', description: 'x' } }, info: '' })).toEqual([{ id: '9', description: 'x' }])
    expect(() => records({ status: 0, data: '', info: 'workspace_id is required' })).toThrow('workspace_id is required')
    expect(() => records({ isError: true, content: [{ type: 'text', text: 'denied' }] })).toThrow(TapdError)
  })
  it('reads items, times, rich text and pages as TAPD writes them', () => {
    expect(tapdInstant('2026-11-03 10:05:00')).toBe('2026-11-03T02:05:00.000Z')
    expect(tapdTime('2026-11-03T02:05:00.000Z')).toBe('2026-11-03 10:05:00')
    expect(plainText('<p>a&amp;b</p><div>c<br>d</div>')).toBe('a&b\nc\nd')
    expect(itemOf('story', story)).toMatchObject({ type: 'story', workspace: '68880148', title: '登录页 4K 下错位', owners: ['saros-bot', '张三'],
      description: '复现：\n4K 屏 打开登录页', modified: '2026-11-03T02:05:00.000Z', iteration: '77' })
    expect(itemOf('bug', { id: '5', title: 'crash', current_owner: '李四', reporter: '王五' })).toMatchObject({ title: 'crash', owners: ['李四'], creator: '王五' })
    const bug = { type: 'bug' as const, workspace: '68880148', id: '1168880148001005905' }
    expect(itemPage('https://www.tapd.cn', bug)).toBe('https://www.tapd.cn/68880148/bugtrace/bugs/view/1168880148001005905')
    expect(itemAddress('https://www.tapd.cn/68880148/bugtrace/bugs/view/1168880148001005905?jump_count=1')).toEqual(bug)
    expect(itemAddress('https://tapd.woa.com/tapd_fe/123/prong/stories/view/456')).toEqual({ type: 'story', workspace: '123', id: '456' })
    expect(itemAddress('https://www.tapd.cn/68880148/s/5905586')).toBeUndefined()
    expect(threadItem('68880148:bug:5')).toEqual({ workspace: '68880148', type: 'bug', id: '5' })
    expect(threadItem('68880148:wiki:5')).toBeUndefined()
  })
})

describe('the Open API', () => {
  function stand(pages: unknown[][]) {
    const calls: { url: string; init: RequestInit }[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (init.method === 'POST') return new Response(JSON.stringify({ status: 1, data: { Comment: { id: '1' } }, info: '' }))
      const page = Number(new URL(url).searchParams.get('page'))
      return new Response(JSON.stringify({ status: 1, data: pages[page - 1] ?? [], info: 'success' }))
    }) as unknown as typeof globalThis.fetch
    return { calls, api: new TapdOpenApi({ api: 'https://api.tapd.cn', fetch, environment: { DSH_SUPERAGENT_TAPD_USER: 'u', DSH_SUPERAGENT_TAPD_PASSWORD: 'p' } }) }
  }
  it('reads every page with the account, oldest change first, and posts a comment as a form', async () => {
    const full = Array.from({ length: 200 }, (_, index) => ({ Bug: { id: String(index), title: 't' } }))
    const { calls, api } = stand([full, [{ Bug: { id: '200', title: 'last' } }]])
    const items = await api.items('bug', '68880148', { status: 'new', modified: '>2026-11-03 10:00:00' })
    expect(items).toHaveLength(201)
    expect(items[200]).toMatchObject({ id: '200', workspace: '68880148' })
    const first = new URL(calls[0]!.url)
    expect(first.pathname).toBe('/bugs')
    expect(Object.fromEntries(first.searchParams)).toEqual({ workspace_id: '68880148', status: 'new', modified: '>2026-11-03 10:00:00', limit: '200', page: '1', order: 'modified asc' })
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
    await api.comment('story', '68880148', '7', 'saros-bot', '<p>好</p>')
    const post = calls.at(-1)!
    expect(post.url).toBe('https://api.tapd.cn/comments')
    expect(Object.fromEntries(new URLSearchParams(String(post.init.body)))).toEqual({ workspace_id: '68880148', entry_type: 'stories', entry_id: '7', author: 'saros-bot', description: '<p>好</p>' })
  })
  it('names a refused account, a missing item and a missing configuration', async () => {
    const answer = (status: number) => (async () => new Response('{"status":0}', { status })) as unknown as typeof globalThis.fetch
    const env = { DSH_SUPERAGENT_TAPD_BEARER: 't' }
    await expect(new TapdOpenApi({ api: 'https://api.tapd.cn', fetch: answer(401), environment: env }).items('bug', '1', {})).rejects.toThrow('refused the account')
    await expect(new TapdOpenApi({ api: 'https://api.tapd.cn', fetch: answer(404), environment: env }).items('bug', '1', {})).rejects.toMatchObject({ gone: true })
    await expect(new TapdOpenApi({ api: 'https://api.tapd.cn', environment: {} }).items('bug', '1', {})).rejects.toThrow('DSH_SUPERAGENT_TAPD_USER')
  })
})

describe('the MCP server through mcporter-internal', () => {
  it('calls proxy_execute_tool with the tool and its arguments, and reads the result', async () => {
    const calls: string[][] = []
    const commands = { withSignal: () => commands, run: async (program: string, args: string[]) => {
      calls.push([program, ...args])
      return JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ status: 1, data: [{ Story: story }] }) }] })
    } } as unknown as Commands
    const items = await new TapdMcp(commands, ['node', 'cli.js'], 'tapd').items('story', '68880148', { id: story.id })
    expect(items.map(item => item.id)).toEqual([story.id])
    expect(calls[0]!.slice(0, 4)).toEqual(['node', 'cli.js', 'call', 'tapd.proxy_execute_tool'])
    const payload = JSON.parse(calls[0]![5]!) as { tool_name: string; tool_args: string }
    expect(payload.tool_name).toBe('stories_get')
    expect(JSON.parse(payload.tool_args)).toMatchObject({ workspace_id: '68880148', id: story.id, limit: '200', page: '1' })
    expect(calls[0]!.slice(6)).toEqual(['--output', 'json'])
  })
  it('runs an npm launcher\'s script under node, as Commands runs no .cmd', () => {
    expect(nodeCli('C:/tools/cli.js', '')).toEqual([process.execPath, 'C:/tools/cli.js'])
    const dir = mkdtempSync(join(tmpdir(), 'npm-bin-'))
    try {
      writeFileSync(join(dir, 'mc.cmd'), '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@tencent\\mcporter-internal\\dist\\cli.js" %*\r\n')
      if (process.platform === 'win32') expect(nodeCli('mc', dir, true)).toEqual([process.execPath, join(dir, 'node_modules', '@tencent', 'mcporter-internal', 'dist', 'cli.js')])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

/** A TAPD holding items and comments that a test changes, with the comments it was asked to post. */
class FakeTapd implements TapdApi {
  items_: TapdItem[] = []
  comments_ = new Map<string, TapdComment[]>()
  posted: { type: TapdType; workspace: string; id: string; author: string; html: string }[] = []
  queries: Record<string, string>[] = []
  async items(type: TapdType, workspace: string, filter: Record<string, string>): Promise<TapdItem[]> {
    this.queries.push(filter)
    const since = filter.modified?.slice(1)
    return this.items_.filter(item => item.type === type && item.workspace === workspace && (!filter.id || item.id === filter.id)
      && (!since || tapdTime(item.modified) > since)).sort((a, b) => a.modified.localeCompare(b.modified))
  }
  async comments(type: TapdType, workspace: string, id: string, since?: string): Promise<TapdComment[]> {
    return (this.comments_.get(`${workspace}:${type}:${id}`) ?? []).filter(comment => !since || comment.modified > since)
  }
  async comment(type: TapdType, workspace: string, id: string, author: string, html: string): Promise<void> {
    this.posted.push({ type, workspace, id, author, html })
    const key = `${workspace}:${type}:${id}`
    this.comments_.set(key, [...this.comments_.get(key) ?? [], { id: `c${this.posted.length}`, author, text: plainText(html), created: now(), modified: now() }])
  }
}
// TAPD's clock: each change is a minute after the last, from the real time on, as a live TAPD's would be.
let clock = Date.now()
const now = () => new Date(clock += 60_000).toISOString()
const item = (overrides: Partial<TapdItem> = {}): TapdItem => ({ type: 'bug', workspace: '68880148', id: '5001', title: '4K 下预览错位', description: '复现步骤……',
  status: 'new', owners: ['张三'], creator: '张三', created: now(), modified: now(), iteration: '', ...overrides })

describe('the TAPD Source in the runtime', () => {
  let h: Host
  let tapd: FakeTapd
  const kind = () => makeTapdKind({ context: () => h.runtime.context({ kind: 'tapd', health: ['tapd'] }), api: () => tapd })
  const ctx = () => h.runtime.context({ kind: 'tapd', health: ['tapd'] })
  function configure(watches: Record<string, unknown>[]) {
    const settings = h.runtime.store.settings()
    const config = TapdConfigSchema.parse({ agent: 'saros-bot', watches })
    h.runtime.store.saveSettings(SettingsSchema.parse({ ...settings, sources: { ...settings.sources, tapd: { enabled: true, config } },
      policy: { ...settings.policy, sources: { ...settings.policy.sources, tapd: { allowed: [{ id: '张三' }] } } } }))
    return config
  }
  beforeEach(async () => {
    h = await startRuntime()
    tapd = new FakeTapd()
    h.runtime.sources.register(kind())
  })
  afterEach(async () => { await h.stop() })

  it('leaves what a list holds when first read, then takes up an item assigned to the agent, and nothing else in assigned mode', async () => {
    const config = configure([{ name: 'bugs', workspace: '68880148', type: 'bug' }])
    tapd.items_.push(item({ id: '1', owners: ['saros-bot'] }))
    expect(await pollWatch(ctx(), tapd, config, config.watches[0]!)).toBe(0)
    tapd.items_.push(item({ id: '2', owners: ['李四'] }), item({ id: '3', owners: ['saros-bot'] }))
    expect(await pollWatch(ctx(), tapd, config, config.watches[0]!)).toBe(1)
    await h.runtime.idle()
    expect(h.candidates()).toHaveLength(1)
    const trigger = h.runtime.store.triggers.get(h.candidates()[0] as string)!
    expect(trigger).toMatchObject({ source: 'tapd', addressed: 'direct', threads: [{ source: 'tapd', id: '68880148:bug:3' }], meta: { kind: 'item', id: '3' } })
    // Reassigning item 2 to the agent takes it up too; its next read asks only for changes since the cursor.
    tapd.items_.find(entry => entry.id === '2')!.owners = ['saros-bot']
    tapd.items_.find(entry => entry.id === '2')!.modified = now()
    expect(await pollWatch(ctx(), tapd, config, config.watches[0]!)).toBe(1)
    expect(tapd.queries.at(-1)!.modified).toMatch(/^>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
  })
  it('takes up a single named item at once, and reads a list anew when its filters change', async () => {
    const config = configure([{ name: 'one', workspace: '68880148', type: 'bug', item: '5001' }])
    tapd.items_.push(item(), item({ id: '5002' }))
    expect(await pollWatch(ctx(), tapd, config, config.watches[0]!)).toBe(1)
    expect(tapd.queries.at(-1)).toEqual({ id: '5001' })
    const changed = configure([{ name: 'one', workspace: '68880148', type: 'bug', item: '5002' }])
    expect(await pollWatch(ctx(), tapd, changed, changed.watches[0]!)).toBe(1)
  })
  it('follows the comments of an accepted item, replies there once, and gives its Executor the item\'s variables', async () => {
    const config = configure([{ name: 'one', workspace: '68880148', type: 'bug', item: '5001' }])
    tapd.items_.push(item())
    await pollWatch(ctx(), tapd, config, config.watches[0]!)
    await h.runtime.idle()
    const [triggerId] = h.candidates() as string[]
    const result = await h.route({ kind: 'accept', trigger_id: triggerId, title: '修 4K 预览错位', worktree_name: 'fix-4k-preview', acknowledgement: '收到，开始修。' })
    await h.runtime.idle()
    await h.runtime.outbox.sent()
    expect(tapd.posted).toEqual([expect.objectContaining({ id: '5001', author: 'saros-bot', html: expect.stringContaining('收到，开始修。') })])
    // A retry of the same reply finds its marker and posts nothing.
    const ack = h.runtime.store.receipts.waiting()
    expect(ack).toEqual([])
    const ticket = h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    const thread = h.runtime.store.threads.get('tapd:68880148:bug:5001')!
    expect(thread.subscriptions).toEqual([ticket.id])
    expect(await pollComments(ctx(), tapd, config, thread)).toBe(0)
    tapd.comments_.set('68880148:bug:5001', [...tapd.comments_.get('68880148:bug:5001') ?? [], { id: 'h1', author: '张三', text: '@saros-bot 1080p 也看一下', created: now(), modified: now() }])
    expect(await pollComments(ctx(), tapd, config, thread)).toBe(1)
    await h.runtime.idle()
    expect(h.relays(`worker-${ticket.id}`).map(relay => relay.text).join('\n')).toContain('1080p 也看一下')
    const variables = Object.fromEntries(h.runtime.ticketEnvironment(ticket).map(variable => [variable.key, variable.value]))
    expect(variables).toMatchObject({ DSH_SUPERAGENT_TAPD_ITEM: 'bug:5001', DSH_SUPERAGENT_TAPD_BUG: '5001', DSH_SUPERAGENT_TAPD_WORKSPACE: '68880148',
      DSH_SUPERAGENT_TAPD_URL: 'https://www.tapd.cn/68880148/bugtrace/bugs/view/5001' })
  })
})

describe('replies and notices', () => {
  it('posts a reply once, ending with its marker, and treats a missing item as gone', async () => {
    const tapd = new FakeTapd()
    const config = TapdConfigSchema.parse({ agent: 'saros-bot' })
    const message = { id: 'm1', kind: 'reply' as const, text: '已修复 <a>\n见 CL 507', channel: { source: 'tapd', thread: 'tapd:1:bug:5', address: { workspace: '1', type: 'bug', id: '5' } } }
    expect(await sendTapd(tapd, config, message)).toBe('sent')
    expect(await sendTapd(tapd, config, message)).toBe('sent')
    expect(tapd.posted).toHaveLength(1)
    expect(tapd.posted[0]!.html).toBe(`已修复 &lt;a&gt;<br/>见 CL 507<br/><br/><span style="color:#999">${replyMarker('m1')}</span>`)
    const gone = { ...tapd, comments: async () => { throw new TapdError('HTTP 404', true) } } as unknown as TapdApi
    expect(await sendTapd(gone, config, { ...message, id: 'm2' })).toBe('gone')
  })
  it('builds Triggers that address the agent only when assigned, named, or @-mentioned', () => {
    const config = { agent: 'saros-bot', site: 'https://www.tapd.cn' }
    const list = { name: 'bugs', mode: 'assigned' as const, item: '' }
    expect(itemTrigger(item({ owners: ['李四'] }), 'item', config, list).addressed).toBeUndefined()
    expect(itemTrigger(item({ owners: ['Saros-Bot'] }), 'assigned', config, list).addressed).toBe('direct')
    expect(itemTrigger(item({ owners: ['李四'] }), 'item', config, { ...list, item: '5001' }).addressed).toBe('direct')
    expect(itemTrigger(item({ creator: 'saros-bot' }), 'status', config, list)).toMatchObject({ human: false, text: expect.stringContaining('状态变为「new」') })
    const comment = { id: '1', author: '王五', text: '请 @saros-bot 看看', created: '', modified: '2026-11-03T03:00:00.000Z' }
    expect(commentTrigger({ workspace: '1', type: 'bug', id: '5' }, comment, config)).toMatchObject({ addressed: 'mention', human: true, meta: { kind: 'comment' } })
  })
  it('tells a ticket\'s TAPD item once its CL was submitted, with the submitted number', () => {
    const channel = { source: 'tapd', thread: 'tapd:1:bug:5', address: { workspace: '1', type: 'bug', id: '5' } }
    const ticket = { id: 't1', ended: { outcome: 'merged', at: '' }, channels: [channel],
      follows: [{ thread: 'p4:501', own: true, closed: { at: '2026-11-03T03:00:00.000Z' } }] } as unknown as Ticket
    expect(changeEndNotices(ticket, () => ({ submittedAs: 507 }))).toEqual([expect.objectContaining({ channel, kind: 'notice', text: '已提交为 CL 507（审核的是 CL 501 的 shelve）。' })])
    expect(changeEndNotices({ ...ticket, ended: { outcome: 'closed', at: '' } } as unknown as Ticket, () => undefined)).toEqual([])
  })
})
