/** Gongfeng Source: scoped MR intake, comment replies, and independent delivery lifecycle (no automatic merge). */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { key, liveTicket, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind, ContextPart } from './kind.ts'
import { pause, polled } from './poll.ts'
import { GongfengConfigSchema, GongfengOpenApi, GONGFENG_SOURCE, gongfengPage,
  type GongfengApi, type GongfengConfig, type GongfengMr, type GongfengNote } from './gongfeng-api.ts'

export interface GongfengWatch { initializedAt: string; signature: string; seen: Record<string, string> }
export const gongfengThread = (project: string, iid: number): string => `${project}:${iid}`
export function gongfengRef(thread: string): { project: string; iid: number } | undefined {
  const match = /^(\d+):(\d+)$/.exec(thread)
  const iid = Number(match?.[2])
  return match && Number.isSafeInteger(iid) && iid > 0 ? { project: match[1]!, iid } : undefined
}
const address = (config: GongfengConfig, mr: GongfengMr) => ({ project: config.project, iid: String(mr.iid) })
const mentions = (text: string, agent: string): boolean => !!agent && new RegExp(`(?:^|\\s)@${agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s.,:;!?，。])`, 'i').test(text)
export function gongfengTrigger(config: GongfengConfig, mr: GongfengMr, path: string, note?: GongfengNote): Trigger | undefined {
  if (String(mr.project_id) !== config.project || note?.system) return undefined
  const author = note?.author ?? mr.author
  if (author.username === config.agent) return undefined
  const text = note?.body ?? `${mr.title}\n${mr.description ?? ''}`
  const bot = author.bot === true || config.bots.some(row => row.id === author.username)
  const addressed = mentions(text, config.agent)
  return { id: key(GONGFENG_SOURCE, config.project, String(mr.iid), note ? `note:${note.id}:${note.updated_at ?? note.created_at}` : `mr:${mr.updated_at}`),
    source: GONGFENG_SOURCE, threads: [{ source: GONGFENG_SOURCE, id: gongfengThread(config.project, mr.iid) }],
    actor: { source: GONGFENG_SOURCE, id: author.username }, human: !bot, ...(addressed ? { addressed: 'mention' as const } : {}),
    at: note?.updated_at ?? note?.created_at ?? mr.updated_at, text,
    channel: { source: GONGFENG_SOURCE, thread: `${GONGFENG_SOURCE}:${gongfengThread(config.project, mr.iid)}`, address: address(config, mr) },
    url: gongfengPage(config, mr, path), meta: { project: config.project, iid: mr.iid, mrId: mr.id, kind: note ? 'comment' : 'mr', addressed,
      ...(note ? { noteId: note.id } : {}) } }
}
/** A source MR or verified same-project agent branch only; never steals another ticket's MR. */
export function claimGongfengMr(ctx: SourceContext, config: GongfengConfig, ticketId: string, mr: GongfengMr, path: string): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended'
  if (String(mr.project_id) !== config.project || String(mr.target_project_id ?? mr.project_id) !== config.project) return 'MR project differs from the configured project'
  const origin = ctx.triggers.get(ticket.origin.triggerId)
  const started = origin?.source === GONGFENG_SOURCE && origin.meta.project === config.project && origin.meta.iid === mr.iid
  const opened = !!config.agent && mr.author.username === config.agent && String(mr.source_project_id ?? '') === config.project
    && !!ticket.execution?.name && mr.source_branch === `agent/${ticket.execution.name}`
  if (!started && !opened) return 'MR does not belong to this ticket; use its source MR or the execution account and ticket branch in this project'
  if (ctx.tickets.open().some(other => other.id !== ticketId && other.follows?.some(follow => !follow.closed && follow.thread === `${GONGFENG_SOURCE}:${gongfengThread(config.project, mr.iid)}`))) return 'MR already belongs to another active ticket'
  if (mr.state !== 'opened' && mr.state !== 'reopened') return 'MR is not open; do not report it as ready'
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: GONGFENG_SOURCE, id: gongfengThread(config.project, mr.iid) }, opened || started)
    ctx.threads.patch(`${GONGFENG_SOURCE}:${gongfengThread(config.project, mr.iid)}`, { project: config.project, iid: mr.iid, mrId: mr.id, projectPath: path })
    ctx.threads.describe(`${GONGFENG_SOURCE}:${gongfengThread(config.project, mr.iid)}`, { label: `MR !${mr.iid}: ${mr.title}`, url: gongfengPage(config, mr, path) })
  })
  return undefined
}
export function observeGongfengMr(ctx: SourceContext, config: GongfengConfig, mr: GongfengMr): void {
  if (String(mr.project_id) !== config.project) return
  if (mr.state === 'closed' || mr.state === 'merged') {
    ctx.tickets.threadClosed({ source: GONGFENG_SOURCE, id: gongfengThread(config.project, mr.iid) }, mr.state === 'merged' ? 'merged' : 'closed',
      mr.merged_at ?? mr.closed_at ?? mr.updated_at)
  } else {
    const thread = `${GONGFENG_SOURCE}:${gongfengThread(config.project, mr.iid)}`
    for (const ticket of ctx.tickets.open()) {
      const follow = ticket.follows?.find(item => item.thread === thread)
      if (follow?.closed) ctx.tickets.bindThread(ticket.id, { source: GONGFENG_SOURCE, id: gongfengThread(config.project, mr.iid) }, follow.own)
    }
  }
}
async function allNotes(api: GongfengApi, id: number, signal?: AbortSignal): Promise<GongfengNote[]> {
  const out: GongfengNote[] = []
  for (let page: number | null = 1; page !== null;) {
    const got = await api.notes(id, page, signal); out.push(...got.items); page = got.next
    if (page !== null && page > 10) throw new Error('Gongfeng comment page limit reached')
  }
  return out
}
/** Baselines pre-existing history, deterministic event IDs, and advances cursors only after successful ingestion. */
export async function pollGongfeng(ctx: SourceContext, config: GongfengConfig, api: GongfengApi, signal?: AbortSignal): Promise<void> {
  const identity = await api.verify(config.agent, signal)
  const signature = JSON.stringify([config.api, config.project, config.agent, config.observeMrs, config.observeComments, config.bots])
  const previous = ctx.state.get(KV.gongfeng.watch(config.project))
  const now = new Date().toISOString()
  const state = previous?.signature === signature ? previous : { initializedAt: now, signature, seen: {} }
  const mrs = new Map<number, GongfengMr>()
  for (let page: number | null = 1; page !== null;) {
    const got = await api.mrs(page, signal)
    for (const mr of got.items) { if (String(mr.project_id) !== config.project) throw new Error('Gongfeng MR list project mismatch'); mrs.set(mr.iid, mr) }
    page = got.next
    if (page !== null && page > 10) throw new Error('Gongfeng MR page limit reached')
  }
  for (const thread of ctx.threads.subscribed(GONGFENG_SOURCE)) {
    const ref = gongfengRef(thread.key.slice(`${GONGFENG_SOURCE}:`.length))
    if (ref?.project === config.project && polled(ctx, thread) && !mrs.has(ref.iid)) mrs.set(ref.iid, await api.mr(ref.iid, signal))
  }
  const check = () => {
    signal?.throwIfAborted()
    if (JSON.stringify(ctx.config<GongfengConfig>(GONGFENG_SOURCE)) !== JSON.stringify(config)) throw new Error('Gongfeng configuration changed during polling')
  }
  check()
  const seen: Record<string, string> = {}
  for (const mr of mrs.values()) {
    signal?.throwIfAborted()
    const content = createHash('sha256').update(JSON.stringify([mr.title, mr.description])).digest('hex')
    const prior = state.seen[String(mr.iid)]
    if (previous?.signature === signature && content !== prior && Date.parse(mr.updated_at) >= Date.parse(state.initializedAt)) {
      let trigger = gongfengTrigger(config, mr, identity.path)
      if (trigger && (prior !== undefined || Date.parse(mr.created_at) < Date.parse(state.initializedAt))) {
        trigger = { ...trigger, human: false, addressed: undefined, meta: { ...trigger.meta, addressed: false, updaterUnknown: true } }
      }
      check()
      if (trigger && (config.observeMrs || trigger.addressed)) await ctx.receive(trigger)
    }
    observeGongfengMr(ctx, config, mr)
    const notes = await allNotes(api, mr.id, signal)
    const cursorKey = KV.gongfeng.notes(config.project, mr.iid)
    const cursor = ctx.state.get(cursorKey)
    for (const note of notes) {
      const at = note.updated_at ?? note.created_at
      if (Date.parse(at) < Date.parse(cursor?.signature === signature ? cursor.at : state.initializedAt)) continue
      const trigger = gongfengTrigger(config, mr, identity.path, note)
      check()
      if (trigger && (config.observeComments || trigger.addressed)) await ctx.receive(trigger)
    }
    check()
    ctx.state.set(cursorKey, { signature, at: new Date(notes.reduce((last, note) => Math.max(last, Date.parse(note.updated_at ?? note.created_at)),
      Date.parse(cursor?.signature === signature ? cursor.at : state.initializedAt))).toISOString() })
    seen[String(mr.iid)] = content
  }
  check()
  ctx.state.set(KV.gongfeng.watch(config.project), { initializedAt: state.initializedAt, signature, seen })
}
export function makeGongfengKind(context: () => SourceContext | undefined, apiOf: (config: GongfengConfig) => GongfengApi = config => new GongfengOpenApi(config)): SourceKind<GongfengConfig> {
  const active = () => context()?.config<GongfengConfig>(GONGFENG_SOURCE)
  return { kind: GONGFENG_SOURCE, title: { zh: '工蜂', en: 'Gongfeng' },
    description: { zh: '独立工蜂 API v3：接收 MR 与评论，报告并跟踪工单 MR。首次启用只建立历史基线，不自动处理存量 MR；不会自动合并。', en: 'Independent Gongfeng API v3 MR/comment intake and delivery tracking; baselines existing history on activation, never merges automatically.' },
    schema: GongfengConfigSchema, health: [GONGFENG_SOURCE], fields: [
      { key: 'project', type: 'text', label: { zh: '工蜂项目 ID', en: 'Gongfeng project ID' }, pattern: '\\d+', hint: { zh: '填数字项目 ID，不是 GitHub owner/name 或本机目录。', en: 'Numeric project ID, not a GitHub name or local directory.' } },
      { key: 'agent', type: 'text', label: { zh: '执行账号用户名', en: 'Execution username' }, hint: { zh: '须与 API Token 账号一致；Host 环境变量 DSH_SUPERAGENT_GONGFENG_TOKEN，或本机 gongfeng.env 保存同名键。密钥不进设置。', en: 'Must match the token account. Host DSH_SUPERAGENT_GONGFENG_TOKEN or the same key in local gongfeng.env; no secret in settings.' } },
      { key: 'observeMrs', type: 'switch', label: { zh: '接收未 @ 的 MR 变化', en: 'Observe unaddressed MR changes' } },
      { key: 'observeComments', type: 'switch', label: { zh: '接收未 @ 的评论', en: 'Observe unaddressed comments' } },
      { key: 'bots', type: 'rows', label: { zh: '机器人账号（不得作为人工授权）', en: 'Bot accounts (never human authority)' }, columns: [{ key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' } }] },
      { key: 'api', type: 'text', advanced: true, label: { zh: '工蜂 API v3 地址', en: 'Gongfeng API v3 URL' } },
      { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / seconds' } },
      { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败阈值', en: 'Failure threshold' } },
    ], scope: ({ meta }, config) => {
      if (meta.project !== config.project || (meta.kind !== 'mr' && meta.kind !== 'comment')) return { listened: false, reason: 'gongfeng_project_mismatch' }
      return { listened: true, observed: !meta.addressed, row: meta.kind === 'comment' ? 'comments' : 'mrs' }
    },
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().optional() })).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '可发起工作的工蜂账号', en: 'Gongfeng users allowed to request work' }, columns: [{ key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' } }] }],
      explicit: { zh: '名单中的人，在 MR 或评论里 @ 执行账号。机器人不产生人工授权。', en: 'An allowed human mentions the execution account in an MR/note; bots never authorize work.' },
      rows: () => ['mrs', 'comments'].map(id => ({ id, label: id === 'mrs' ? 'MR' : { zh: '评论', en: 'Comments' }, note: { zh: '按配置接收', en: 'Configured intake' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } })) },
    channel: { allowed: (addr, config) => addr.project === config.project && !!gongfengRef(`${addr.project}:${addr.iid}`),
      send: async (_host, message) => {
        const config = active(); if (!config) throw new Error('Gongfeng Source is disabled')
        const ref = gongfengRef(`${message.channel.address.project}:${message.channel.address.iid}`)
        if (!ref || ref.project !== config.project) throw new Error('Gongfeng reply project mismatch')
        const ctx = context()!, api = apiOf(config)
        await api.verify(config.agent)
        const mr = await api.mr(ref.iid)
        const marker = `<!-- dsh-superagent:${key('gongfeng-reply', message.id)} -->`
        const record = KV.gongfeng.reply(config.project, message.id)
        const found = (await allNotes(api, mr.id)).some(note => note.author.username === config.agent && note.body.includes(marker))
        if (JSON.stringify(active()) !== JSON.stringify(config)) throw new Error('Gongfeng configuration changed before reply')
        if (found || ctx.state.get(record) === 'sent') { ctx.state.set(record, 'sent'); return 'sent' }
        if (ctx.state.get(record) === 'pending') throw new Error('Previous Gongfeng reply outcome is uncertain; inspect the MR before any manual retry')
        if (mr.state === 'closed' || mr.state === 'merged') return 'gone'
        ctx.state.set(record, 'pending')
        await api.note(mr.id, `${message.text}\n\n${marker}`)
        ctx.state.set(record, 'sent'); return 'sent'
      }, link: addr => {
        const config = active(), path = context()?.threads.get(`${GONGFENG_SOURCE}:${addr.project}:${addr.iid}`)?.meta.projectPath
        return { url: config && typeof path === 'string' ? gongfengPage(config, { iid: Number(addr.iid) }, path) : '', label: { zh: `工蜂 MR !${addr.iid}`, en: `Gongfeng MR !${addr.iid}` } }
      } },
    threadContext: { messageId: trigger => String(trigger.meta.noteId ?? `mr:${trigger.meta.iid}`),
      read: async (_commands, trigger, part, cursor, config): Promise<ContextPart> => {
        if (trigger.meta.project !== config.project) throw new Error('Gongfeng context project mismatch')
        const api = apiOf(config), mr = await api.mr(Number(trigger.meta.iid))
        if (part === 'parent') return { messages: [], body: {}, status: 'No parent-note identity is available' }
        if (part === 'root') return { messages: [{ id: `mr:${mr.iid}`, from: mr.author.username, at: mr.created_at, text: `${mr.title}\n${mr.description ?? ''}`, ...(mr.author.bot ? { bot: true as const } : {}) }], body: { iid: mr.iid, state: mr.state } }
        const page = cursor ? Number(cursor) : 1, notes = await api.notes(mr.id, page)
        return { messages: notes.items.filter(note => !note.system).map(note => ({ id: String(note.id), from: note.author.username, at: note.created_at, text: note.body,
          ...(note.author.bot || config.bots.some(bot => bot.id === note.author.username) ? { bot: true as const } : {}) })), body: { iid: mr.iid, state: mr.state }, ...(notes.next ? { next: String(notes.next) } : {}) }
      } },
  }
}
export const name = 'dsh-superagent-gongfeng'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  let source: SourceContext | undefined
  const kind = makeGongfengKind(() => source)
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'gongfeng: source kind')
  ctx.effect(() => {
    source = sourceContext(ctx.orchestrator, kind)
    const cancel = new AbortController(), current = source
    const running = watchGongfeng(current, cancel.signal).catch(error => { if (!cancel.signal.aborted) current.report(GONGFENG_SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { cancel.abort(); await running; source = undefined }
  })
}
export async function watchGongfeng(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<GongfengConfig>(GONGFENG_SOURCE)
    try {
      if (!config || !config.project || !config.agent || !ctx.configured()) ctx.report(GONGFENG_SOURCE, { state: 'paused', detail: !config ? 'Off' : 'Configure Gongfeng project ID, execution username and Host token; existing history is not ingested' })
      else { await pollGongfeng(ctx, config, new GongfengOpenApi(config), signal); ctx.report(GONGFENG_SOURCE, { state: 'ready', detail: 'MR/comment polling ready; no automatic merge' }) }
      failures = 0
    } catch (error) { if (!signal.aborted && ++failures >= (config?.failuresBeforeError ?? 1)) ctx.report(GONGFENG_SOURCE, { state: 'error', detail: String(error) }) }
    await pause((config?.pollSeconds ?? 120) * 1000, signal)
  }
}
