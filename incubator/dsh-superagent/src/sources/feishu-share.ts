/**
 * VsSaros addition: tells the Feishu Source when its app is already receiving events elsewhere on this machine.
 *
 * Feishu's long connection is a cluster, not a broadcast: with two connections for one app each event reaches only
 * one of them at random. VsSaros Bots (`dsh-plugins/vssaros-agents`) hold their inbound connections under locks in
 * the home directory (one per app, `~/.vssaros-im-feishu-<appId>.lock`, plus the legacy `~/.vssaros-im-feishu.lock`
 * for the default app; pid + heartbeat, shared by the dev and release clients) and keep the default app ID in
 * `<dataRoot>/agent-im-accounts.json`. Reading them lets the Source refuse to open a second connection
 * for the same app and say which client holds it, instead of silently losing half the messages or exiting with
 * lark-cli's code 2. The check is read-only: it never takes or writes the Bots' lock.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Mirrors `IM_LOCK_STALE_MS` in vssaros-agents' `imInboundLock.js`. */
export const BOTS_LOCK_STALE_MS = 90_000
export interface FeishuHolder { pid: number; dataRoot: string; appId: string }

const json = (file: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}
const alive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** The app ID the Bots in `dataRoot` connect with, if their credentials file names one. */
export function botsFeishuApp(dataRoot: string): string | undefined {
  const accounts = json(join(dataRoot, 'agent-im-accounts.json'))?.accounts as Record<string, { appId?: unknown }> | undefined
  const appId = accounts?.feishu?.appId
  return typeof appId === 'string' && appId.trim() ? appId.trim() : undefined
}
/**
 * The secret VsSaros Bots keep for `appId` (their default app or one of their extra apps), read where the Bots read it:
 * `VSSAROS_DATA_ROOT`, which the IDE gives the Host, else `~/.vssaros`. It only ever goes to lark-cli's stdin.
 */
export function botsAppSecret(appId: string, env: Record<string, string | undefined> = process.env, home = homedir()): string | undefined {
  const root = env.VSSAROS_DATA_ROOT?.trim() || join(home, '.vssaros')
  const accounts = json(join(root, 'agent-im-accounts.json'))?.accounts as Record<string, any> | undefined
  const secretOf = (entry: unknown): string | undefined => {
    const value = (entry as { appSecret?: unknown } | undefined)?.appSecret
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  if (!appId || !accounts) return undefined
  if (accounts.feishu?.appId === appId) return secretOf(accounts.feishu)
  const extra = accounts.feishuApps && typeof accounts.feishuApps === 'object' ? accounts.feishuApps[appId] : undefined
  return secretOf(extra)
}

/**
 * The live Bots inbound connection that uses `appId`, or undefined when there is none, the lock is stale, or the
 * holder uses another app. An unreadable app ID is not treated as a conflict, so a misread never blocks the Source.
 * vssaros-agents 0.2.317+ holds one lock per app (`~/.vssaros-im-feishu-<appId>.lock`) and writes `appId` into the
 * legacy platform lock; older versions hold only the legacy lock, whose app is then read from the holder's data root.
 */
export function feishuAppHolder(appId: string, options: { home?: string; now?: number; isAlive?: (pid: number) => boolean } = {}):
  FeishuHolder | undefined {
  const home = options.home ?? homedir()
  const now = options.now ?? Date.now()
  const isAlive = options.isAlive ?? alive
  const live = (lock: Record<string, unknown> | undefined): lock is Record<string, unknown> => {
    if (!lock) return false
    const heartbeat = Number(lock.heartbeatAt)
    return Number.isFinite(heartbeat) && now - heartbeat < BOTS_LOCK_STALE_MS && isAlive(Number(lock.pid))
  }
  const rootOf = (lock: Record<string, unknown>) => typeof lock.dataRoot === 'string' && lock.dataRoot ? lock.dataRoot : join(home, '.vssaros')
  const id = String(appId ?? '').trim()
  if (/^cli_[A-Za-z0-9]+$/.test(id)) {
    const own = json(join(home, `.vssaros-im-feishu-${id.toLowerCase()}.lock`))
    if (live(own)) return { pid: Number(own.pid), dataRoot: rootOf(own), appId: id }
  }
  const lock = json(join(home, '.vssaros-im-feishu.lock'))
  if (!live(lock)) return undefined
  const dataRoot = rootOf(lock)
  const held = typeof lock.appId === 'string' && lock.appId.trim() ? lock.appId.trim() : botsFeishuApp(dataRoot)
  return held && held === id ? { pid: Number(lock.pid), dataRoot, appId: id } : undefined
}

/** lark-cli exits with 2 when another event bus is already connected for the app. */
export const busTaken = (code: number | null, diagnostic: string): boolean =>
  code === 2 && /another bus|already connected|bus .*(connected|running)/i.test(diagnostic)

/**
 * The in-process Feishu event bus of vssaros-agents (0.2.318+), when the Bots run in this Host. Its connection for an app
 * is the only one Feishu feeds, so the Source subscribes to it instead of opening its own. Duck-typed on purpose: the
 * Source must not depend on the Bots package, and the bus survives a hot reload of either side.
 */
export interface SharedFeishuEvents {
  version: 1
  active(appId: string): boolean
  subscribe(appId: string, listener: (payload: unknown) => void): () => void
}
export const FEISHU_EVENTS_KEY = Symbol.for('vssaros.feishuEvents')
export function sharedFeishuEvents(root: object = globalThis): SharedFeishuEvents | undefined {
  const bus = (root as Record<symbol, Partial<SharedFeishuEvents> | undefined>)[FEISHU_EVENTS_KEY]
  return bus && bus.version === 1 && typeof bus.active === 'function' && typeof bus.subscribe === 'function'
    ? bus as SharedFeishuEvents : undefined
}
/**
 * Whether the Source should listen through the Bots' connection: the bus is here and either the Bots connection for
 * the app is up, or the Bots in this very process hold the app's lock (reconnecting, so events will come through it).
 */
export function listensShared(bus: SharedFeishuEvents | undefined, appId: string, holder: FeishuHolder | undefined,
  pid = process.pid): boolean {
  return !!bus && (bus.active(appId) || holder?.pid === pid)
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
/**
 * A raw Feishu v2 `im.message.receive_v1` event (`{ header, event }`, as the Bots receive it) in the shape `lark-cli event
 * consume` prints, so both paths make the same Trigger. Content is decoded the way history messages are; a sender
 * without an ID cannot be told apart from this bot, so such an event is dropped rather than guessed at.
 */
export function sharedEvent(payload: unknown): Record<string, unknown> | undefined {
  const raw = payload as { header?: { event_type?: unknown }; event?: { sender?: Record<string, any>; message?: Record<string, any> } }
  if (raw?.header?.event_type !== 'im.message.receive_v1') return undefined
  const message = raw.event?.message ?? {}, sender = raw.event?.sender ?? {}
  const senderId = text(sender.sender_id?.open_id) ?? text(sender.sender_id?.user_id) ?? text(sender.sender_id?.union_id)
  if (!senderId || !text(message.message_id) || !text(message.chat_id)) return undefined
  let content: unknown
  try { content = JSON.parse(String(message.content ?? '')) } catch { content = message.content ?? '' }
  const plain = content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string'
    ? (content as { text: string }).text : undefined
  const mentions = (Array.isArray(message.mentions) ? message.mentions : []).flatMap((mention: Record<string, any>) => {
    const id = text(mention?.id?.open_id) ?? text(mention?.id?.user_id) ?? text(typeof mention?.id === 'string' ? mention.id : undefined)
    return id ? [{ id, ...text(mention.key) ? { key: mention.key } : {}, ...text(mention.name) ? { name: mention.name } : {} }] : []
  })
  return { message_id: message.message_id, chat_id: message.chat_id, chat_type: message.chat_type === 'p2p' ? 'p2p' : 'group',
    create_time: String(message.create_time ?? ''), sender_id: senderId, sender_type: sender.sender_type === 'user' ? 'user' : 'bot',
    content: typeof content === 'string' ? content : plain ?? JSON.stringify(content), mentions,
    ...text(message.root_id) ? { root_id: message.root_id } : {}, ...text(message.parent_id) ? { parent_id: message.parent_id } : {},
    ...text(message.thread_id) ? { thread_id: message.thread_id } : {} }
}

/** A consumer run that ended on its own, with its exit code and last stderr line. */
export class FeishuConsumerExit extends Error {
  constructor(readonly code: number | null, readonly ready: boolean, readonly diagnostic: string) {
    super(`Feishu event consumer exited (${code}, ready=${ready}): ${diagnostic}`)
  }
}
