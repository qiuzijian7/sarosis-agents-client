/**
 * VsSaros addition: the optional TAPD Webhook ingress, a fast lane on top of the TAPD Source's polling.
 *
 * TAPD's Open Platform POSTs a flat event record (`event`, `workspace_id`, `id`, `event_id`/`queue_id`, `secret`) to
 * `/orchestrator/webhook/tapd` in JSON or x-www-form-urlencoded form; automation rules may nest the record under
 * `event` instead. The event carries IDs only, so the item is reread through `TapdApi`, matched against the configured
 * watches, and only then received. Deletions, comments and every event outside a watch are ignored; polling still owns
 * comment follow-up and read cursors, so it must stay on.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from '../sources/host.ts'
import { itemThread, itemTrigger, resolvedConfig, signatureOf } from '../sources/tapd.ts'
import { TAPD_SOURCE, TAPD_TYPES, tapdApi, watchWorkspace,
  type TapdApi, type TapdConfig, type TapdItem, type TapdType, type TapdWatch } from '../sources/tapd-api.ts'
import { cleanOwner } from '../sources/tapd-members.ts'

/** Fixed path on the loopback Web server; TAPD needs an intranet gateway or reverse proxy to reach it. */
export const TAPD_WEBHOOK_PATH = '/orchestrator/webhook/tapd'
const MAX_BODY = 128 * 1024
const MAX_SEEN = 512

const text = (value: unknown): string => value === undefined || value === null ? '' : String(value)
const first = (...values: unknown[]): string => {
  for (const value of values) { const as = text(value); if (as) return as }
  return ''
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** An ignorable delivery, or an item/status event whose IDs are complete enough to reread the item. */
export type TapdWebhookEvent =
  | { kind: 'ignored'; eventId: string; secret: string; reason: string }
  | { kind: 'item' | 'status'; eventId: string; secret: string; reason: ''; workspace: string; type: TapdType; id: string }

/**
 * Reads the shapes TAPD documents (and the nested shape of an automation rule) without trusting the event body: only
 * a story, bug or task ID in a numeric workspace reaches the Source. Duplicate keys are `event_id`, else `queue_id`,
 * else a digest of the record so a replay without either is still idempotent.
 */
export function parseTapdWebhook(payload: unknown): TapdWebhookEvent | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const raw = payload as Record<string, unknown>
  const nested = raw.event && typeof raw.event === 'object' && !Array.isArray(raw.event)
    ? raw.event as Record<string, unknown> : undefined
  const name = typeof raw.event === 'string' ? raw.event : ''
  const [objectName, action = ''] = name.split('::')
  const object = first(objectName, nested?.object_type)
  const workspace = first(raw.workspace_id, nested?.workspace_id)
  const id = first(raw.id, nested?.id,
    nested?.new && typeof nested.new === 'object' ? (nested.new as Record<string, unknown>).id : undefined)
  const secret = first(raw.secret, nested?.secret)
  const eventId = first(raw.event_id, raw.queue_id, nested?.event_id, nested?.queue_id)
    || createHash('sha256').update([name, object, workspace, id, text(raw.created), text(raw.current_user)].join('\u0000')).digest('hex').slice(0, 32)

  const type = (TAPD_TYPES as readonly string[]).includes(object) ? object as TapdType : undefined
  // TAPD documents comment, attachment, iteration and many other events. Polling follows comments; none of these
  // bypass the watches, so answer 200 instead of letting TAPD retry a delivery it cannot use.
  const ignored = (reason: string): TapdWebhookEvent => ({ kind: 'ignored', eventId, secret, reason })
  if (!type || action === 'delete') return ignored(!type ? `unsupported object ${object || '(none)'}` : 'deleted item')
  if (!/^\d+$/.test(workspace) || !/^\d+$/.test(id)) return undefined
  if (action && !['create', 'update', 'status_change'].includes(action)) return ignored(`unsupported event ${name}`)
  const kind = action === 'status_change' || /(^|,)status(,|$)/.test(text(raw.change_fields)) ? 'status' : 'item'
  return { kind, eventId, secret, reason: '', workspace, type, id }
}

/** Constant-time comparison of the configured secret with the body field, a header or a query parameter. */
export function secretMatches(expected: string, ...given: (string | undefined)[]): boolean {
  if (!expected) return false
  const wanted = Buffer.from(expected, 'utf8')
  return given.some(candidate => {
    const bytes = Buffer.from(candidate ?? '', 'utf8')
    return bytes.length === wanted.length && timingSafeEqual(bytes, wanted)
  })
}

/** A Webhook event is received only when the reread item still falls inside one of the watches' filters. */
export function watchMatches(config: TapdConfig, watch: TapdWatch,
  event: { workspace: string; type: TapdType; id: string }, item: TapdItem): boolean {
  if (watchWorkspace(config, watch) !== event.workspace || watch.type !== event.type) return false
  if (watch.item && watch.item !== event.id) return false
  if (watch.status && watch.status !== item.status) return false
  const owner = cleanOwner(watch.owner)
  if (owner && !item.owners.some(candidate => sameName(candidate, owner))) return false
  if (watch.iteration && watch.iteration !== item.iteration) return false
  return true
}

/** TAPD defaults to form data, so a body that is not JSON is read as `x-www-form-urlencoded`. */
async function readWebhookBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY) throw new Error(`Webhook body exceeds ${MAX_BODY} bytes`)
    chunks.push(bytes)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  // TAPD's developer console probes the URL with an empty body; treat it as an empty record rather than bad JSON.
  if (!body.trim()) return {}
  try { return JSON.parse(body) as unknown }
  catch {
    if (/json/i.test(text(req.headers['content-type']))) throw new Error('The Webhook body is not JSON')
    return Object.fromEntries(new URLSearchParams(body)) as unknown
  }
}

export interface TapdWebhookDeps {
  /** The TAPD Source's context; the management route builds it through `SourceHost.context`. */
  context(): SourceContext
  /** How the item is reread; tests pass a stand-in. */
  api?(config: TapdConfig, ctx: SourceContext): TapdApi
}
export interface TapdWebhookResult { status: number; body: Record<string, unknown> }

/**
 * Verifies the shared secret, deduplicates `event_id`/`queue_id`, rereads the item and receives one Trigger. Nothing
 * is stored until the item was read and received, so a failed reread can be retried by TAPD without losing the event.
 */
export async function handleTapdWebhook(req: IncomingMessage, deps: TapdWebhookDeps): Promise<TapdWebhookResult> {
  const ctx = deps.context()
  const config = ctx.config<TapdConfig>(TAPD_SOURCE)
  // The endpoint does not exist while off; a half-configured Webhook refuses every delivery rather than accepting it.
  if (!config || !config.webhook) return { status: 404, body: { error: 'TAPD Webhook is off' } }
  if (!config.webhookSecret) return { status: 503, body: { error: 'TAPD Webhook secret is not set' } }
  // The developer console checks the URL's reachability before saving it. A GET/HEAD or an empty POST carries no
  // event and no secret: answer it without reading the Source. Any delivery with event fields below still needs the
  // secret, so a probe cannot be used to push a change into the orchestrator.
  if (req.method === 'GET' || req.method === 'HEAD') return { status: 200, body: { ok: true } }
  let payload: unknown
  try { payload = await readWebhookBody(req) }
  catch (error) { return { status: 400, body: { error: message(error) } } }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return { status: 400, body: { error: 'Unrecognised TAPD Webhook payload' } }
  const fields = payload as Record<string, unknown>
  if (!fields.event && !fields.id && !fields.workspace_id && !fields.secret)
    return { status: 200, body: { ok: true } }
  const url = new URL(req.url ?? TAPD_WEBHOOK_PATH, 'http://localhost')
  if (!secretMatches(config.webhookSecret, first(fields.secret), first(req.headers['x-tapd-secret']),
    url.searchParams.get('secret') ?? undefined)) return { status: 401, body: { error: 'Invalid TAPD Webhook secret' } }

  const event = parseTapdWebhook(payload)
  if (!event) return { status: 400, body: { error: 'Unrecognised TAPD Webhook payload' } }
  if (event.kind === 'ignored') return { status: 200, body: { ignored: event.reason } }
  await ctx.ready
  if ((ctx.state.get(KV.tapd.webhookSeen) ?? []).includes(event.eventId))
    return { status: 200, body: { duplicate: true } }

  let item: TapdItem | undefined
  try {
    const api = deps.api?.(config, ctx) ?? tapdApi(config)
    item = (await api.items(event.type, event.workspace, { id: event.id })).find(row => row.id === event.id)
  } catch (error) { return { status: 502, body: { error: `TAPD item reread failed: ${message(error)}` } } }
  // A deleted item, or one the account may not read: polling decides what to do with it.
  if (!item) return { status: 200, body: { ignored: 'item not found' } }

  // Identity aliases come from the static `members` mapping in the settings; no network lookup.
  const resolved = resolvedConfig(config)
  const watch = resolved.watches.find(candidate => watchMatches(resolved, candidate, event, item!))
  if (!watch) return { status: 200, body: { ignored: 'no matching watch' } }
  const trigger = itemTrigger(item, event.kind, resolved, watch)
  const subscribed = (ctx.threads.get(`${TAPD_SOURCE}:${itemThread(item)}`)?.subscriptions.length ?? 0) > 0
  // The same admission rule as pollWatch: an "assigned/@ only" watch takes in no unaddressed changes.
  if (resolved.agent && watch.mode === 'assigned' && !trigger.addressed && !subscribed)
    return { status: 200, body: { ignored: 'not addressed' } }

  const outcome = await ctx.receive(trigger)
  ctx.atomic(() => {
    // Remember the item only when a watch state already exists: creating one here would make the next poll treat
    // every other item in the list as new. The cursor itself is left to polling, which must not skip a change.
    const state = ctx.state.get(KV.tapd.watch(watch.name))
    if (state?.signature === signatureOf(resolved, watch)) {
      ctx.state.set(KV.tapd.watch(watch.name),
        { ...state, items: { ...state.items, [item!.id]: { owners: item!.owners, status: item!.status } } })
    }
    const seen = ctx.state.get(KV.tapd.webhookSeen) ?? []
    ctx.state.set(KV.tapd.webhookSeen, [...seen, event.eventId].slice(-MAX_SEEN))
  })
  return { status: 200, body: { received: outcome, event: event.kind, watch: watch.name, item: item.id } }
}
