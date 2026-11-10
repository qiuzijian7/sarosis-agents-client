/** Feishu background loops: live event stream consumer, chat/topic history backfill, chat name refresh, and subscribed thread polling. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey, type Thread, type Trigger } from '../core/index.ts'
import { feishuChatLink } from './feishu-channel.ts'
import { larkArgv, type FeishuBot } from '../deployment.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { readFeishu, type FeishuRef } from './feishu-read.ts'
import { busTaken, feishuAppHolder, FeishuConsumerExit, listensShared, sharedEvent, sharedFeishuEvents, type SharedFeishuEvents }
  from './feishu-share.ts'
import { feishuRef, feishuTime, feishuTrigger, HistoricalMessageSchema, historyEvent, HistoryPageSchema, SOURCE, topicEvent }
  from './feishu-trigger.ts'
import { health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, POLL_HORIZON_MS, polled, pollThreads as pollEach } from './poll.ts'
import type { FeishuConfig } from './feishu.ts'

export const runFeishu = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch, backfillLoop, chatNamesLoop].map(loop => loop(ctx, signal)))
const enabled = (ctx: SourceContext): FeishuConfig | undefined => ctx.config<FeishuConfig>(SOURCE)
const bot = (ctx: SourceContext): FeishuBot => {
  const resolved = ctx.deployment.feishu
  if (!resolved) throw new Error('The Feishu Source has no working bot CLI')
  return resolved
}
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId) return
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { url: chatLink(ctx, chatId), facts: { chat } })
}
const chatLink = (ctx: SourceContext, chatId: string): string => feishuChatLink(ctx.deployment.feishu?.brand ?? 'feishu', chatId)
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.feishu) return true
  const waiting = health('paused', ctx.configured() ? 'feishuCliUnset' : 'setupPending')
  ctx.report('feishu', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** Runs the live event consumer only while the Source is enabled; disabling it stops the consumer within five seconds. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the bot; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report('feishu', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const appId = bot(ctx).appId
    // VsSaros addition: Feishu delivers each event to one connection of an app only. When the Bots in this Host
    // hold that connection, listen through it; when another process holds it, say so and look again shortly.
    if (listensShared(sharedFeishuEvents(), appId, feishuAppHolder(appId))) {
      await listenShared(ctx, sharedFeishuEvents()!, signal)
      retry = undefined
      continue
    }
    const holder = feishuAppHolder(appId)
    if (holder) {
      ctx.report('feishu', health('error', 'feishuAppShared', { app: holder.appId, holder: `pid ${holder.pid} (${holder.dataRoot})` }))
      await delay(30_000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    // Yield within five seconds when the Bots take the same app later (e.g. after VsSaros restarts), in this process
    // (then listen through them) or in another one.
    const check = setInterval(() => {
      if (!enabled(ctx) || feishuAppHolder(appId) || sharedFeishuEvents()?.active(appId)) running.abort()
    }, 5000)
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try { await consume(ctx, running.signal) }
    catch (error) {
      if (!running.signal.aborted) {
        ctx.report('feishu', error instanceof FeishuConsumerExit && busTaken(error.code, error.diagnostic)
          ? health('error', 'feishuBusBusy', { app: appId }) : { state: 'error', detail: String(error) })
      }
    }
    finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    if (running.signal.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
/**
 * VsSaros addition: receives the app's events through the Bots connection in this Host until that connection goes away
 * or the Source is turned off, then returns so the loop falls back to its own consumer.
 */
async function listenShared(ctx: SourceContext, bus: SharedFeishuEvents, signal: AbortSignal): Promise<void> {
  const appId = bot(ctx).appId
  const running = new AbortController()
  const stop = () => running.abort()
  signal.addEventListener('abort', stop, { once: true })
  let chain = Promise.resolve()
  const unsubscribe = bus.subscribe(appId, payload => {
    const event = sharedEvent(payload)
    if (!event) return
    chain = chain.then(() => take(ctx, event)).catch(error => { ctx.report('feishu', { state: 'error', detail: String(error) }) })
  })
  ctx.report('feishu', { ...health('ready', 'feishuShared', { app: appId }), at: new Date().toISOString() })
  const check = setInterval(() => {
    if (!enabled(ctx) || !listensShared(bus, appId, feishuAppHolder(appId))) running.abort()
  }, 5000)
  try { await new Promise<void>(resolve => running.signal.aborted ? resolve() : running.signal.addEventListener('abort', () => resolve(), { once: true })) }
  finally { clearInterval(check); unsubscribe(); signal.removeEventListener('abort', stop); await chain }
}
/** Takes in one event in the `event consume` shape, from either path; events read while the Source is off are dropped. */
async function take(ctx: SourceContext, input: unknown): Promise<void> {
  const trigger = feishuTrigger(input, bot(ctx).botId, bot(ctx).appId)
  if (!trigger || !enabled(ctx)) return
  const chats = ctx.state.get(KV.feishu.chats) ?? {}
  chats[String(trigger.meta.chatId)] = trigger.meta.direct === true
  ctx.state.set(KV.feishu.chats, chats)
  await receive(ctx, trigger)
}
/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)
async function consume(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  // VsSaros patch (Windows): windowsHide keeps the long-running consumer from opening a console window.
  // VsSaros patch (Windows): `bot.cli` may resolve to a `.cmd` launcher, which Node cannot spawn without a shell.
  // VsSaros addition: the argv also selects the bot's lark-cli profile when the Source names an app.
  const [program, ...prefix] = larkArgv(bot(ctx))
  const child = spawn(program!, [...prefix, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  const stdout = createInterface({ input: child.stdout }); const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve(); let diagnostic = ''; let ready = false
  const stop = (): void => { child.stdin.end(); child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(() => { diagnostic = 'Feishu event consumer did not become ready within 45 seconds'; stop() }, 45_000)
  stderr.on('line', (line: string) => {
    diagnostic = line.slice(0, 4000)
    if (line.startsWith('[event] ready')) {
      ready = true; clearTimeout(timeout)
      ctx.report('feishu', { state: 'ready', detail: 'Listening for bot events', at: new Date().toISOString() })
    } else if (/WARN|drop|error/.test(line)) ctx.report('feishu', { state: 'error', detail: diagnostic })
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(async () => {
      if (line.length > 1_048_576) throw new Error('Feishu event exceeds 1 MiB')
      await take(ctx, JSON.parse(line))
    }).catch(error => { ctx.report('feishu', { state: 'error', detail: String(error) }) })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => signal.aborted ? resolve() : reject(new FeishuConsumerExit(code, ready, diagnostic)))
    })
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}

/** Refreshes the map of joined chats (`chat_id -> name`); throws on failure so the previously stored list remains intact. */
export async function refreshChatNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  /* ★ 2026-11-10：display-only 下不读群列表。内置应用没有 `im:chat:readonly` /
     `im:chat` / `im:chat.group_info:readonly` / `im:chat:read` scope，手动点面板的
     「刷新群列表」会报 99991672（前端显示「读取失败，列表保持不变」）。
     ⚠ 判断必须放在这里：`chatNamesLoop` 是自动入口，而 `feishuKind.refreshLabels`
       是面板按钮的另一条入口，只改 loop 挡不住手动刷新。
     ⇒ 直接返回已存 labels，不打 lark 命令；列表保持不变，前端显示「列表已是最新」。 */
  if (ctx.config<FeishuConfig>(SOURCE)?.displayOnly) {
    return ctx.state.get(KV.sources.labels(SOURCE)) ?? {}
  }
  const commands = ctx.commands.withSignal(signal)
  const result = z.looseObject({ chats: z.array(z.looseObject({ chat_id: z.string(), name: z.string().nullish() })).optional() })
    .parse(await commands.lark(['im', '+chat-list', '--page-all', '--page-size', '100']))
  const names = Object.fromEntries((result.chats ?? []).filter(chat => chat.name).map(chat => [chat.chat_id, chat.name!]))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
/** Rereads the chat list every minute independently of history backfill (whose rounds can take much longer), so newly joined chats appear within a minute. */
async function chatNamesLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  while (!signal.aborted) {
    const config = enabled(ctx)
    /* ★ 2026-11-10：display-only 不需要群名，也不该每分钟打 `im +chat-list`
       （内置应用没有相应 scope，会持续产生权限错误）。 */
    if (config && !config.displayOnly) {
      try { await refreshChatNames(ctx, signal) }
      catch { /* Names are a display aid; the stored list stays until a later read succeeds. */ }
    }
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
export async function backfillLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) { ctx.report('history', health('paused', 'feishuBotMissing')); return }
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('history', health('paused', 'sourceOff'))
      await delay(60_000, undefined, { signal }).catch(() => {})
      continue
    }
    /* ★ 2026-11-10：display-only 模式跳过整轮历史补收（backfillChat / pollThreads）。
       ① Chat 气泡只读 `trigger` 表，而 trigger 由实时 WS 事件经 Intake 的 filtered 分支
          落库 ⇒ 关掉补收不丢消息；补收的停机窗口历史反而不该进「只显示」的对话。
       ② `GET /open-apis/im/v1/messages` / `+messages-mget` 等需要
          `im:message.history:readonly` / `im:message:readonly` / `im:message`，
          内置应用未申请 ⇒ 每 60s 报 99991672 并把 history 写成 error（持久化、重启仍在）。
       ③ 主动 report 成 paused，覆盖 health_entry 里遗留的旧 error。
       ⚠ 不动 watch / listenShared / take / receive ⇒ 实时事件链路完全保留。 */
    if (config.displayOnly) {
      ctx.report('history', { state: 'paused', detail: 'Display-only: history recovery is off', at: new Date().toISOString() })
      await delay(60_000, undefined, { signal }).catch(() => {})
      continue
    }
    const seen = ctx.state.get(KV.feishu.chats) ?? {}
    const known = Object.entries(seen).filter(([, direct]) => direct && config.directMessages)
    const chats = { ...Object.fromEntries(config.chats.map(chat => [chat.chatId, false])), ...Object.fromEntries(known) }
    const errors: string[] = []
    const tally = { skipped: 0 }
    for (const [chatId, direct] of Object.entries(chats)) {
      if (signal.aborted) break
      const started = new Date().toISOString()
      const cursorKey = KV.feishu.history(chatId)
      const since = ctx.state.get(cursorKey)
      if (since === undefined) { ctx.state.set(cursorKey, started); continue }
      try {
        await backfillChat(ctx, chatId, direct, since, started, signal, tally)
        if (!signal.aborted) ctx.state.set(cursorKey, cursorAt(started))
      } catch (error) { if (!signal.aborted) errors.push(`${chatId}: ${String(error)}`) }
    }
    await pollThreads(ctx, signal, tally)
    const skipped = tally.skipped ? `; ${tally.skipped} unreadable messages skipped` : ''
    if (!signal.aborted) ctx.report('history', errors.length
      ? { state: 'error', detail: errors.join('\n') }
      : { state: 'ready', detail: `Configured groups and known direct chats recovered${skipped}`, at: new Date().toISOString() })
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
/**
 * Backfills chat messages and active topic replies between `since` and `until` before the caller advances the chat cursor.
 * Topics are stored as `{ id: lastSeenAt }`, and unsubscribed topics older than the polling horizon are pruned.
 */
export async function backfillChat(ctx: SourceContext, chatId: string, direct: boolean, since: string, until: string,
  signal: AbortSignal, tally: Tally = { skipped: 0 }): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  const topicsKey = KV.feishu.topics(chatId)
  const topics = { ...ctx.state.get(topicsKey) }
  const scan = async (kind: 'chat' | 'thread', id: string): Promise<void> => {
    let page: string | undefined
    const pages = new Set<string>()
    do {
      if (signal.aborted) throw signal.reason
      const seconds = (time: string) => String(Math.floor(Date.parse(time) / 1000))
      const parameters = { container_id_type: kind, container_id: id, start_time: seconds(since), end_time: seconds(until),
        sort_type: 'ByCreateTimeAsc', page_size: 50, ...(page ? { page_token: page } : {}) }
      const request = ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(parameters)]
      const result = HistoryPageSchema.parse(await commands.lark(request))
      for (const message of validItems(HistoricalMessageSchema, result.items, tally)) {
        const outside = message.chat_id !== chatId || (kind === 'thread' && message.thread_id !== id)
        if (outside) throw new Error('Feishu history returned a message outside the requested chat or thread')
        if (message.deleted) continue
        const at = feishuTime(message.create_time)
        if (message.thread_id && !(Date.parse(topics[message.thread_id] ?? '') >= Date.parse(at))) topics[message.thread_id] = at
        const trigger = feishuTrigger(historyEvent(message, chatId, direct), bot(ctx).botId, bot(ctx).appId)
        if (trigger) await receive(ctx, trigger)
      }
      const stuck = result.has_more && (!result.page_token || pages.has(result.page_token))
      if (stuck) throw new Error('Feishu history pagination did not advance')
      page = result.has_more ? result.page_token : undefined
      if (page) pages.add(page)
    } while (page)
  }
  await scan('chat', chatId)
  // A quiet topic is forgotten unless a subscribed Thread that is still polled follows it.
  const followed = new Set(ctx.threads.subscribed(SOURCE).filter(thread => polled(ctx, thread))
    .map(thread => String(thread.meta.threadId ?? ctx.triggers.latest(thread.key)?.meta.threadId ?? '')))
  for (const [id, seen] of Object.entries(topics)) {
    if (!followed.has(id) && Date.parse(until) - Date.parse(seen) >= POLL_HORIZON_MS) delete topics[id]
  }
  ctx.state.set(topicsKey, topics)
  for (const id of Object.keys(topics)) await scan('thread', id)
  ctx.state.set(topicsKey, topics)
}

/** Resolves the retained source message reference for polling a subscribed thread. */
export function threadRef(ctx: SourceContext, thread: Thread): FeishuRef | undefined {
  const meta = thread.meta as { sourceTriggerId?: string; chatId?: string; messageId?: string }
  if (meta.chatId && meta.messageId && meta.sourceTriggerId) {
    return { triggerId: meta.sourceTriggerId, chatId: meta.chatId, messageId: meta.messageId }
  }
  const trigger = ctx.triggers.latest(thread.key)
  return trigger ? feishuRef(trigger) : undefined
}
/** Polls subscribed Feishu threads within the polling horizon so replies missed by the live stream become triggers. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, tally?: Tally): Promise<void> {
  await pollEach(ctx, SOURCE, () => !!signal?.aborted, thread => pollThread(ctx, thread, signal, tally))
}
async function pollThread(ctx: SourceContext, thread: Thread, signal?: AbortSignal, tally?: Tally): Promise<void> {
  const ref = threadRef(ctx, thread)
  if (!ref) throw new Error('Subscribed thread has no retained source message')
  const config = enabled(ctx)
  // The Source was turned off; the next round polls again.
  if (!config) return
  const commands = ctx.commands.withSignal(signal)
  const pageSize = config.readPageSize
  const checkpoint = KV.feishu.seen(thread.key)
  const known = new Set(ctx.state.get(checkpoint) ?? [])
  const initialized = ctx.state.get(KV.feishu.initialized(thread.key))
  if (!initialized) {
    // Mark root and parent messages as seen on first poll so historical context is not ingested as new triggers.
    for (const section of ['root', 'parent']) {
      const result = await readFeishu(commands, ref, `feishu/${ref.triggerId}/${section}`, pageSize)
      if ('message' in result && result.message) known.add(result.message.message_id)
    }
    ctx.state.set(checkpoint, [...known])
  }
  const direct = ctx.state.get(KV.feishu.chats)?.[ref.chatId] === true
  const since = Date.parse(thread.createdAt)
  const root = thread.ref.id.slice(thread.ref.id.indexOf(':') + 1)
  let resource: string | null = `feishu/${ref.triggerId}/thread`
  while (resource) {
    if (signal?.aborted) return
    const result = await readFeishu(commands, ref, resource, pageSize, 'desc')
    if (!('messages' in result)) throw new Error('Expected Feishu thread messages')
    if (tally && 'skipped' in result) tally.skipped += result.skipped ?? 0
    if ('thread_id' in result && result.thread_id && thread.meta.threadId !== result.thread_id) {
      ctx.threads.patch(thread.key, { threadId: result.thread_id })
    }
    const encounteredKnown = result.messages.some(message => known.has(message.message_id))
    const { botId, appId } = bot(ctx)
    for (const message of result.messages.filter(item => !known.has(item.message_id) && !item.deleted).reverse()) {
      if (signal?.aborted) return
      const trigger = feishuTrigger(topicEvent(message, ref.chatId, direct, root), botId, appId)
      // Ignore messages older than the thread subscription on initial poll.
      if (!trigger || (!initialized && Date.parse(trigger.at) < since)) continue
      await receive(ctx, trigger)
    }
    result.messages.forEach(message => known.add(message.message_id))
    ctx.state.set(checkpoint, [...known])
    if (initialized && encounteredKnown) break
    resource = result.next_resource
  }
  ctx.state.set(KV.feishu.initialized(thread.key), true)
}
