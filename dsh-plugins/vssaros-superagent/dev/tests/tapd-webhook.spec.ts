/**
 * VsSaros addition: the optional TAPD Webhook ingress. Every case uses a stand-in request, SourceContext and TapdApi;
 * none talks to TAPD or starts a Web server. Polling and its comment follow-up are deliberately left out of scope.
 */
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleTapdWebhook, parseTapdWebhook, secretMatches, TAPD_WEBHOOK_PATH, watchMatches } from '../src/app/tapd-webhook.ts'
import type { Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { TapdConfigSchema, type TapdApi, type TapdConfig, type TapdItem } from '../src/sources/tapd-api.ts'
import { resetPlatformMembers } from '../src/sources/tapd-members.ts'

const story: TapdItem = { type: 'story', workspace: '68880148', id: '1168880148001000001', title: '登录页 4K 下错位',
  description: '4K 屏打开登录页会错位。', status: 'open', owners: ['张三'], creator: '张三', iteration: '77',
  created: '2026-11-03T02:00:00.000Z', modified: '2026-11-03T02:05:00.000Z' }

const config = (overrides: Record<string, unknown> = {}): TapdConfig => TapdConfigSchema.parse({
  webhook: true, webhookSecret: 's3cret', watches: [{ name: 'w1', type: 'story', mode: 'all' }], ...overrides })

const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: 'story::create', event_from: 'web', workspace_id: '68880148', current_user: '张三', id: story.id,
  secret: 's3cret', queue_id: '130662', event_id: '42079', created: '2026-11-03 10:05:00', ...overrides })

function request(body: unknown, options: { form?: boolean; headers?: Record<string, string>; url?: string; method?: string } = {}): IncomingMessage {
  const text = options.form ? new URLSearchParams(body as Record<string, string>).toString()
    : typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method: options.method ?? 'POST', url: options.url ?? TAPD_WEBHOOK_PATH,
    headers: { 'content-type': options.form ? 'application/x-www-form-urlencoded' : 'application/json', ...options.headers },
    async *[Symbol.asyncIterator]() { yield Buffer.from(text) },
  } as unknown as IncomingMessage
}

function context(of: TapdConfig) {
  const values = new Map<string, unknown>()
  const received: Trigger[] = []
  const ctx = {
    ready: Promise.resolve(), commands: {}, config: () => of, threads: { get: () => undefined },
    state: { get: (name: string) => values.get(name), set: (name: string, value: unknown) => {
      if (value === undefined) values.delete(name); else values.set(name, value) }, keys: () => [] },
    atomic: <T>(work: () => T): T => work(),
    receive: (trigger: Trigger) => { received.push(trigger); return 'stored' },
  } as unknown as SourceContext
  return { ctx, values, received }
}
function apiOf(items: TapdItem[] = [story]) {
  const itemsOf = vi.fn(async () => items)
  const api = { items: itemsOf, comments: async () => [], comment: async () => {} } as unknown as TapdApi
  return { api, itemsOf }
}
/** One delivery with a stand-in Source and file read. */
async function deliver(body: unknown, of = config(), items: TapdItem[] = [story], options: Parameters<typeof request>[1] = {}) {
  const source = context(of)
  const file = apiOf(items)
  const result = await handleTapdWebhook(request(body, options), { context: () => source.ctx, api: () => file.api })
  return { ...result, ...source, ...file }
}

afterEach(() => resetPlatformMembers())

describe('the TAPD Webhook event record', () => {
  it('reads the flat record TAPD documents, including a numeric workspace', () => {
    expect(parseTapdWebhook(payload({ workspace_id: 68880148 }))).toMatchObject({
      kind: 'item', eventId: '42079', secret: 's3cret', workspace: '68880148', type: 'story', id: story.id })
    expect(parseTapdWebhook(payload({ event: 'bug::status_change' }))).toMatchObject({ kind: 'status', type: 'bug' })
    expect(parseTapdWebhook(payload({ event: 'task::update', change_fields: 'name,status,due' }))).toMatchObject({ kind: 'status', type: 'task' })
    expect(parseTapdWebhook(payload({ event: 'story::update' }))).toMatchObject({ kind: 'item' })
  })
  it('falls back to queue_id and then to a stable digest for replay deduplication', () => {
    expect(parseTapdWebhook(payload({ event_id: '' }))).toMatchObject({ eventId: '130662' })
    const bare = payload({ event_id: '', queue_id: '' })
    const one = parseTapdWebhook(bare), two = parseTapdWebhook({ ...bare, referer: 'ignored' })
    expect(one?.eventId).toMatch(/^[0-9a-f]{32}$/)
    expect(two?.eventId).toBe(one?.eventId)
  })
  it('accepts the nested record of an automation rule', () => {
    expect(parseTapdWebhook({ workspace_id: '68880148', secret: 's3cret',
      event: { workspace_id: '68880148', user: '张三', object_type: 'story', id: story.id, new: { id: story.id } } }))
      .toMatchObject({ kind: 'item', type: 'story', id: story.id, workspace: '68880148' })
  })
  it('ignores deletions, comments and other objects instead of asking TAPD to retry', () => {
    expect(parseTapdWebhook(payload({ event: 'story::delete' }))).toMatchObject({ kind: 'ignored', reason: 'deleted item' })
    expect(parseTapdWebhook(payload({ event: 'story_comment::add' }))).toMatchObject({ kind: 'ignored' })
    expect(parseTapdWebhook(payload({ event: 'iteration::update' }))).toMatchObject({ kind: 'ignored' })
    expect(parseTapdWebhook(payload({ event: 'story::publish' }))).toMatchObject({ kind: 'ignored' })
  })
  it('refuses a record without a numeric workspace and item ID', () => {
    expect(parseTapdWebhook({ event: 'story::create' })).toBeUndefined()
    expect(parseTapdWebhook({ event: 'story::create', workspace_id: 'x', id: story.id })).toBeUndefined()
    expect(parseTapdWebhook(null)).toBeUndefined()
  })
  it('compares the shared secret in constant time and never accepts an empty one', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true)
    expect(secretMatches('s3cret', '', undefined, 's3cret')).toBe(true)
    expect(secretMatches('s3cret', 's3creT', 'x')).toBe(false)
    expect(secretMatches('', '')).toBe(false)
  })
})

describe('matching a delivery to a watch', () => {
  const event = { workspace: '68880148', type: 'story' as const, id: story.id }
  it('keeps the workspace, type and every filter of the watch', () => {
    const of = config()
    expect(watchMatches(of, of.watches[0]!, event, story)).toBe(true)
    expect(watchMatches(of, of.watches[0]!, { ...event, workspace: '123' }, story)).toBe(false)
    expect(watchMatches(of, { ...of.watches[0]!, type: 'bug' }, event, story)).toBe(false)
    expect(watchMatches(of, { ...of.watches[0]!, item: '999' }, event, story)).toBe(false)
    expect(watchMatches(of, { ...of.watches[0]!, status: 'resolved' }, event, story)).toBe(false)
    expect(watchMatches(of, { ...of.watches[0]!, owner: '李四;' }, event, story)).toBe(false)
    expect(watchMatches(of, { ...of.watches[0]!, iteration: '88' }, event, story)).toBe(false)
    expect(watchMatches(of, { ...of.watches[0]!, owner: '张三;', iteration: '77', status: 'open' }, event, story)).toBe(true)
  })
})

describe('the Webhook endpoint', () => {
  it('does not exist while off, and refuses every delivery when the secret is unset', async () => {
    expect((await deliver(payload(), config({ webhook: false }))).status).toBe(404)
    expect((await deliver(payload(), config({ webhookSecret: '' }))).status).toBe(503)
  })
  it('answers the developer console URL probe without weakening delivery authentication', async () => {
    const get = await deliver('', config(), [story], { method: 'GET' })
    expect(get).toMatchObject({ status: 200, body: { ok: true } })
    expect((await deliver('', config(), [story], { method: 'HEAD' })).status).toBe(200)
    // An empty POST is a probe too, even when the console declares a JSON content type.
    expect((await deliver('', config(), [story], { headers: { 'content-type': 'application/json' } })))
      .toMatchObject({ status: 200, body: { ok: true } })
    expect(get.received).toHaveLength(0)
    expect(get.itemsOf).not.toHaveBeenCalled()
    expect(get.values.get(KV.tapd.webhookSeen)).toBeUndefined()
    // Anything carrying event fields still needs the shared secret.
    expect((await deliver(payload({ secret: '' }))).status).toBe(401)
  })
  it('checks the secret in the body, a header or the URL before parsing the event', async () => {
    expect((await deliver(payload({ secret: 'wrong' }))).status).toBe(401)
    expect((await deliver(payload({ secret: '' }), config(), [story], { headers: { 'x-tapd-secret': 's3cret' } })).status).toBe(200)
    expect((await deliver(payload({ secret: '' }), config(), [story], { url: `${TAPD_WEBHOOK_PATH}?secret=s3cret` })).status).toBe(200)
  })
  it('reads TAPD\'s default form body as well as JSON, and rejects a malformed JSON body', async () => {
    expect((await deliver(payload(), config(), [story], { form: true })).status).toBe(200)
    expect((await deliver('{not json', config(), [story], { headers: { 'content-type': 'application/json' } })).status).toBe(400)
  })
  it('rereads the item and receives one Trigger carrying the watch and the item page', async () => {
    const result = await deliver(payload())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ received: 'stored', event: 'item', watch: 'w1', item: story.id })
    expect(result.itemsOf).toHaveBeenCalledWith('story', '68880148', { id: story.id })
    expect(result.received).toHaveLength(1)
    expect(result.received[0]).toMatchObject({ source: 'tapd', threads: [{ source: 'tapd', id: `68880148:story:${story.id}` }],
      meta: { kind: 'item', watch: 'w1', mode: 'all', workspace: '68880148', type: 'story', id: story.id } })
    expect(String(result.received[0]!.url)).toContain(story.id)
    expect(result.values.get(KV.tapd.webhookSeen)).toEqual(['42079'])
  })
  it('is idempotent on event_id and queue_id replays', async () => {
    const first = await deliver(payload())
    const source = first.ctx
    const file = apiOf()
    const again = await handleTapdWebhook(request(payload()), { context: () => source, api: () => file.api })
    expect(again).toMatchObject({ status: 200, body: { duplicate: true } })
    expect(first.received).toHaveLength(1)
    expect(file.itemsOf).not.toHaveBeenCalled()
    const byQueue = await deliver(payload({ event_id: '' }))
    expect(byQueue.values.get(KV.tapd.webhookSeen)).toEqual(['130662'])
  })
  it('leaves events outside every watch, comments and deletions to polling', async () => {
    expect((await deliver(payload({ workspace_id: '123' }))).status).toBe(200)
    const unseen = await deliver(payload({ event: 'story::delete' }))
    expect(unseen.body).toMatchObject({ ignored: 'deleted item' })
    expect(unseen.received).toHaveLength(0)
    const comment = await deliver(payload({ event: 'story_comment::add' }))
    expect(comment.body.ignored).toBeTruthy()
    expect(comment.received).toHaveLength(0)
  })
  it('keeps the "assigned/@ only" admission rule of the polling watch', async () => {
    const assigned = config({ agent: '机器人', watches: [{ name: 'w1', type: 'story', mode: 'assigned' }] })
    expect((await deliver(payload(), assigned)).body).toMatchObject({ ignored: 'not addressed' })
    const named = config({ agent: '机器人', watches: [{ name: 'w1', type: 'story', mode: 'assigned', item: story.id }] })
    expect((await deliver(payload(), named)).body).toMatchObject({ received: 'stored' })
  })
  it('does not consume an event whose reread failed, and ignores a deleted or unreadable item', async () => {
    const source = context(config())
    const broken = { items: async () => { throw new Error('TAPD timeout') } } as unknown as TapdApi
    const failed = await handleTapdWebhook(request(payload()), { context: () => source.ctx, api: () => broken })
    expect(failed.status).toBe(502)
    expect(source.values.get(KV.tapd.webhookSeen)).toBeUndefined()
    const recovered = await handleTapdWebhook(request(payload()), { context: () => source.ctx, api: () => apiOf().api })
    expect(recovered.status).toBe(200)
    expect((await deliver(payload(), config(), [])).body).toMatchObject({ ignored: 'item not found' })
  })
  it('records the item in an existing watch state without advancing the poll cursor', async () => {
    const of = config()
    const source = context(of)
    const signature = JSON.stringify(['68880148', 'story', {}])
    source.values.set(KV.tapd.watch('w1'), { signature, since: '2026-11-03T01:00:00.000Z', items: {} })
    await handleTapdWebhook(request(payload()), { context: () => source.ctx, api: () => apiOf().api })
    expect(source.values.get(KV.tapd.watch('w1'))).toMatchObject({ since: '2026-11-03T01:00:00.000Z',
      items: { [story.id]: { owners: ['张三'], status: 'open' } } })
  })
})
