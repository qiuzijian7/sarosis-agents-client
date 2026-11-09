/**
 * VsSaros addition: the TAPD Source kind and its Cordis plugin entry (`dsh-superagent/tapd-watch`). It watches single
 * stories, bugs or tasks and lists of them by workspace/type/filters, turns their changes into Triggers, follows the
 * comments of the items tickets subscribe to, and replies with comments. An optional TAPD identity name recognises
 * what is assigned to SuperAgent or @s it; it is never a query parameter.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage, type Thread, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { cursorAt, pause, pollThreads } from './poll.ts'
import { itemAddress, itemPage, TAPD_SOURCE, TAPD_TYPES, TapdConfigSchema, tapdConfigured, TapdError, tapdApi, tapdTime, watchWorkspace,
  type TapdApi, type TapdComment, type TapdConfig, type TapdItem, type TapdType, type TapdWatch } from './tapd-api.ts'
import { cleanOwner, resolveTapdName } from './tapd-members.ts'

const TapdPolicySchema = z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1) }).strict()).default([]) }).strict()

export interface TapdWatchState { signature: string; since: string; items: Record<string, { owners: string[]; status: string }> }
const TYPE_LABEL: Record<TapdType, string> = { story: '需求', bug: '缺陷', task: '任务' }
const DESCRIPTION_MAX = 8000
/** The Thread of an item: `tapd:<workspace>:<type>:<id>`. */
export const itemThread = (item: Pick<TapdItem, 'workspace' | 'type' | 'id'>): string => `${item.workspace}:${item.type}:${item.id}`
export function threadItem(id: string): Pick<TapdItem, 'workspace' | 'type' | 'id'> | undefined {
  const [workspace, type, item] = id.split(':')
  return workspace && item && (TAPD_TYPES as readonly string[]).includes(type ?? '') ? { workspace, type: type as TapdType, id: item } : undefined
}
const channelOf = (item: Pick<TapdItem, 'workspace' | 'type' | 'id'>): ChannelRef =>
  ({ source: TAPD_SOURCE, thread: `${TAPD_SOURCE}:${itemThread(item)}`, address: { workspace: item.workspace, type: item.type, id: item.id } })
export const mentions = (text: string, name: string): boolean => !!name && new RegExp(`@${escapeRegExp(name)}(?![\\w-])`, 'i').test(text)
const assignedTo = (item: Pick<TapdItem, 'owners'>, agent: string): boolean => item.owners.some(owner => sameName(owner, agent))
/** The visible line every reply ends with, by which a retry finds a reply that already went out. */
export const replyMarker = (messageId: string): string => `dsh-superagent · ${createHash('sha256').update(messageId).digest('hex').slice(0, 10)}`

export type ItemEvent = 'item' | 'assigned' | 'status'
/** A Trigger for an item that came into a watch (`item`), was assigned to the configured identity (`assigned`), or changed status (`status`). */
export function itemTrigger(item: TapdItem, event: ItemEvent, config: Pick<TapdConfig, 'agent' | 'site'>, watch: Pick<TapdWatch, 'name' | 'mode' | 'item'>): Trigger {
  const assigned = assignedTo(item, config.agent)
  // The operator named a single item in the Source, which is as explicit as assigning it.
  const addressed = assigned || (event === 'item' && !!watch.item) || mentions(item.description, config.agent)
  const head = event === 'status' ? `${TYPE_LABEL[item.type]}状态变为「${item.status}」：${item.title}` : `[${TYPE_LABEL[item.type]}] ${item.title}`
  const description = item.description.length > DESCRIPTION_MAX ? `${item.description.slice(0, DESCRIPTION_MAX)}…` : item.description
  return { id: key('tapd', event, item.workspace, item.type, item.id, item.modified, event === 'status' ? item.status : ''), source: TAPD_SOURCE,
    threads: [{ source: TAPD_SOURCE, id: itemThread(item) }], actor: { source: TAPD_SOURCE, id: item.creator },
    human: !!item.creator && !sameName(item.creator, config.agent), ...addressed ? { addressed: 'direct' as const } : {},
    at: item.modified || new Date().toISOString(),
    text: [head, `状态：${item.status || '—'} · 处理人：${item.owners.join('、') || '—'}${item.iteration ? ` · 迭代 ${item.iteration}` : ''}`,
      event === 'status' ? '' : description].filter(Boolean).join('\n\n'),
    channel: channelOf(item), url: itemPage(config.site, item),
    meta: { kind: event, workspace: item.workspace, type: item.type, id: item.id, watch: watch.name, mode: watch.mode, status: item.status, owners: item.owners } }
}
export function commentTrigger(item: Pick<TapdItem, 'workspace' | 'type' | 'id'>, comment: TapdComment, config: Pick<TapdConfig, 'agent' | 'site'>): Trigger {
  return { id: key('tapd-comment', itemThread(item), comment.id, comment.modified), source: TAPD_SOURCE,
    threads: [{ source: TAPD_SOURCE, id: itemThread(item) }], actor: { source: TAPD_SOURCE, id: comment.author },
    human: !!comment.author && !sameName(comment.author, config.agent), ...mentions(comment.text, config.agent) ? { addressed: 'mention' as const } : {},
    at: comment.modified || comment.created, text: comment.text, channel: channelOf(item), url: itemPage(config.site, item),
    meta: { kind: 'comment', workspace: item.workspace, type: item.type, id: item.id, commentId: comment.id } }
}

/** The query fields of a watch's filters, as TAPD's list APIs take them. */
export function watchFilter(watch: TapdWatch): Record<string, string> {
  const owner = cleanOwner(watch.owner)
  // saroasis-platform: a bug's owner field is `current_owner`; passing `owner` is silently ignored
  // and returns the whole project. Stories/tasks use `owner`. Trailing semicolons find fewer items.
  return { ...watch.item ? { id: watch.item } : {}, ...watch.status ? { status: watch.status } : {},
    ...owner ? { [watch.type === 'bug' ? 'current_owner' : 'owner']: owner } : {}, ...watch.iteration ? { iteration_id: watch.iteration } : {} }
}
/** A watch's state is reused only while the workspace and query filters it was read with still hold. */
export const signatureOf = (config: TapdConfig, watch: TapdWatch): string =>
  JSON.stringify([watchWorkspace(config, watch), watch.type, watchFilter(watch)])
/** Resolve WeCom aliases to TAPD Chinese names before any owner comparison or query is made. */
export function resolvedConfig(config: TapdConfig): TapdConfig {
  const members = config.members
  return { ...config, agent: resolveTapdName(config.agent, members),
    watches: config.watches.map(watch => ({ ...watch, owner: resolveTapdName(watch.owner, members) })) }
}
const changeFilter = (since: string): Record<string, string> => ({ modified: `>${tapdTime(cursorAt(since))}` })

/**
 * Reads one watch's changes and receives their Triggers. The first read of a list (or of a list whose filters changed)
 * only records what is there: work already in the list is not taken up (D4). A single item is taken up at once.
 */
export async function pollWatch(ctx: SourceContext, api: TapdApi, config: TapdConfig, watch: TapdWatch, signal?: AbortSignal): Promise<number> {
  const stored = ctx.state.get(KV.tapd.watch(watch.name))
  const state = stored?.signature === signatureOf(config, watch) ? stored : undefined
  const filter = { ...watchFilter(watch), ...state ? changeFilter(state.since) : {} }
  const items = await api.items(watch.type, watchWorkspace(config, watch), filter, signal)
  // The cursor follows TAPD's own `modified` times, so the Host's clock never decides what is missed; an empty first read
  // starts from now.
  const next: TapdWatchState = { signature: signatureOf(config, watch), since: state?.since ?? (items.length ? '' : new Date().toISOString()), items: { ...state?.items } }
  let received = 0
  for (const item of items) {
    const before = state?.items[item.id]
    const events: ItemEvent[] = []
    if (!state) { if (watch.item) events.push('item') }
    else if (!before) events.push('item')
    else {
      if (assignedTo(item, config.agent) && !before.owners.some(owner => sameName(owner, config.agent))) events.push('assigned')
      if (before.status !== item.status) events.push('status')
    }
    const subscribed = (ctx.threads.get(`${TAPD_SOURCE}:${itemThread(item)}`)?.subscriptions.length ?? 0) > 0
    for (const event of events) {
      const trigger = itemTrigger(item, event, config, watch)
      // `assigned` mode takes in only what addresses the agent, and what happens on items tickets already follow.
      // Without an identity name nothing can be "assigned/@", so every watch's changes reach the Policy.
      if (config.agent && watch.mode === 'assigned' && !trigger.addressed && !subscribed) continue
      await ctx.receive(trigger)
      received++
    }
    next.items[item.id] = { owners: item.owners, status: item.status }
    if (item.modified > next.since) next.since = item.modified
  }
  ctx.state.set(KV.tapd.watch(watch.name), next)
  return received
}
/** Reads the new comments on a subscribed item, skipping the agent's own replies. */
export async function pollComments(ctx: SourceContext, api: TapdApi, config: TapdConfig, thread: Thread, signal?: AbortSignal): Promise<number> {
  const item = threadItem(thread.ref.id)
  if (!item) return 0
  const cursor = ctx.state.get(KV.tapd.comments(thread.key))
  // A Thread read for the first time starts from now: its item's description already reached the ticket.
  if (!cursor) { ctx.state.set(KV.tapd.comments(thread.key), new Date().toISOString()); return 0 }
  let since = cursor, received = 0
  for (const comment of await api.comments(item.type, item.workspace, item.id, cursorAt(cursor), signal)) {
    if (!comment.text.includes('dsh-superagent · ')) { await ctx.receive(commentTrigger(item, comment, config)); received++ }
    if (comment.modified > since) since = comment.modified
  }
  ctx.state.set(KV.tapd.comments(thread.key), since)
  return received
}
/** One polling round: every watch, then the comments of every subscribed item. */
export async function pollRound(ctx: SourceContext, api: TapdApi, config: TapdConfig, signal?: AbortSignal): Promise<number> {
  // Identity aliases come only from the static `members` mapping in the settings; no network lookup.
  const resolved = resolvedConfig(config)
  let received = 0
  const failures: string[] = []
  for (const watch of resolved.watches) {
    if (signal?.aborted) return received
    try { received += await pollWatch(ctx, api, resolved, watch, signal) } catch (error) { failures.push(`${watch.name}: ${String(error)}`) }
  }
  await pollThreads(ctx, TAPD_SOURCE, () => !!signal?.aborted, async thread => { received += await pollComments(ctx, api, resolved, thread, signal) })
  if (failures.length) throw new Error(failures.join('; '))
  return received
}

const html = (text: string): string => text.split('\n').map(line => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br/>')
/** Posts a reply as a comment on its item once: a retry that finds the reply's marker sends nothing. */
export async function sendTapd(api: TapdApi, config: TapdConfig, message: OutboundMessage, signal?: AbortSignal): Promise<'sent' | 'gone'> {
  const { workspace, type, id } = message.channel.address
  if (!workspace || !id || !(TAPD_TYPES as readonly string[]).includes(type ?? '')) throw new Error('Missing TAPD reply target')
  const marker = replyMarker(message.id)
  try {
    if ((await api.comments(type as TapdType, workspace, id, undefined, signal)).some(comment => comment.text.includes(marker))) return 'sent'
    await api.comment(type as TapdType, workspace, id, resolveTapdName(config.agent, config.members) || 'dsh-superagent',
      `${html(message.text)}<br/><br/><span style="color:#999">${marker}</span>`, signal)
    return 'sent'
  } catch (error) {
    if (error instanceof TapdError && error.gone) return 'gone'
    throw error
  }
}

/** An error health once `failures` consecutive rounds fail, so one network blip stays quiet. */
const pollFailure = (failures: number, threshold: number, error: unknown): Health | undefined =>
  failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined

export interface TapdKindOptions {
  /** The TAPD Source's context, once its plugin started; replies wait (throw) until then. */
  context(): SourceContext | undefined
  /** How the Source reaches TAPD; tests pass a fake. */
  api?(config: TapdConfig, ctx: SourceContext): TapdApi
}
export function makeTapdKind(options: TapdKindOptions): SourceKind<TapdConfig> {
  const apiOf = (config: TapdConfig, ctx: SourceContext) => options.api?.(config, ctx) ?? tapdApi(config)
  const kind: SourceKind<TapdConfig> = {
    kind: TAPD_SOURCE,
    title: { zh: 'TAPD', en: 'TAPD' },
    description: { zh: '按接收项从 TAPD 拉取需求、缺陷和任务的变化，跟进已订阅单子的评论，并以评论回复。', en: 'Reads changes to TAPD stories, bugs and tasks selected by each watch, follows the comments of subscribed items, and replies with comments.' },
    schema: TapdConfigSchema,
    fields: [
      { key: 'workspace', type: 'text', label: { zh: '项目 ID', en: 'Workspace ID' }, pattern: '\\d+',
        chooseFrom: 'workspace', choose: { zh: '从 TAPD 项目里选', en: 'Choose a TAPD project' },
        hint: { zh: '默认 GR 项目 68880148（TAPD 的 workspace_id）。下拉候选来自 TAPD「我参与的项目」，点接收项的「读取 TAPD 选项」刷新。接收项不填项目 ID 时继承这里的值。',
          en: 'Defaults to the GR project 68880148 (TAPD workspace_id). Dropdown options come from TAPD projects the account participates in; refresh them with the watches button. A watch with no workspace ID inherits this value.' } },
      { key: 'agent', type: 'text', label: { zh: 'TAPD 身份名', en: 'TAPD identity name' },
        chooseFrom: 'agent', choose: { zh: '从 TAPD 单据里的人选', en: 'Choose a TAPD person' },
        hint: { zh: '可选。填 TAPD 账号体系里的名字（中文人名、机器人账号名，或企微账号——会按下面的成员映射解析成中文名），不是智能体的名字：单子指派给它、或评论里 @ 它，才算发给 SuperAgent，回评论也以它署名。它不参与取数。留空则不识别指派/@，回复署名 dsh-superagent；此时请把接收项设为「全部变化」，由策略的接收表决定。下拉候选来自 TAPD 单据的处理人/创建人聚合（TAPD Open API 没有成员名单接口）与静态成员映射。',
          en: 'Optional. A name in TAPD\'s account system (a person\'s Chinese name or a robot account), not an agent name: only items assigned to it or comments that @ it address SuperAgent, and replies are signed with it. It is not a query parameter. Leave it empty to skip identity matching and sign replies as dsh-superagent; then set watches to "All changes" and let the Policy admission table decide. Options come from owners/creators of fetched TAPD items (TAPD has no member-list endpoint) plus the static member mapping.' } },
      { key: 'watches', type: 'rows', label: { zh: '接收项', en: 'Watches' },
        hint: { zh: '项目 ID 留空就继承上面的默认项目；填了“单号”就只盯这一个单子，保存后立即接下；不填就是列表，按状态、处理人、迭代筛选，第一次保存时已在列表里的单子不处理，只看之后的变化。“仅指派/@”只接收指派给上面身份名或 @ 它的（未填身份名时只收点名的单子）；“全部变化”由策略的接收表决定。', en: 'With an item ID a watch follows that item alone and takes it up on saving; without one it is a list, filtered by status, owner and iteration, and items already in it when first saved are left alone. "Assigned/@ only" receives what is assigned to the identity name or @s it (with no identity name, only named items); "All changes" leaves it to the Policy\'s admission table.' },
        columns: [
          { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, pattern: '[\\w.\\-]{1,40}', refresh: { zh: '读取 TAPD 选项', en: 'Read TAPD options' } },
          { key: 'workspace', type: 'text', label: { zh: '项目 ID', en: 'Workspace ID' }, pattern: '\\d*', optional: true, chooseFrom: 'workspace' },
          { key: 'type', type: 'select', label: { zh: '类型', en: 'Type' }, options: [{ value: 'story', label: { zh: '需求', en: 'Story' } },
            { value: 'bug', label: { zh: '缺陷', en: 'Bug' } }, { value: 'task', label: { zh: '任务', en: 'Task' } }] },
          { key: 'item', type: 'text', label: { zh: '单号', en: 'Item ID' }, pattern: '\\d*', optional: true },
          { key: 'status', type: 'text', label: { zh: '状态', en: 'Status' }, optional: true, chooseFrom: 'status' },
          { key: 'owner', type: 'text', label: { zh: '处理人', en: 'Owner' }, optional: true },
          { key: 'iteration', type: 'text', label: { zh: '迭代 ID', en: 'Iteration ID' }, pattern: '\\d*', optional: true, chooseFrom: 'iteration' },
          { key: 'mode', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'assigned', label: { zh: '仅指派/@', en: 'Assigned/@ only' } },
            { value: 'all', label: { zh: '全部变化', en: 'All changes' } }] }] },
      { key: 'site', type: 'text', label: { zh: 'TAPD 站点', en: 'TAPD site' }, hint: { zh: '单子链接的前缀，例如 https://www.tapd.cn。', en: 'The prefix of item links, such as https://www.tapd.cn.' } },
      { key: 'api', type: 'text', advanced: true, group: { zh: '连接与凭据', en: 'Connection & credentials' },
        label: { zh: 'Open API 地址', en: 'Open API address' },
        hint: { zh: '默认 https://api.tapd.cn，只有私有化部署才需要改。凭据在卡片下方的「接入检查」区管理；MCP 通道已下线。',
          en: 'Defaults to https://api.tapd.cn; change only for a private deployment. Credentials are managed in the setup checklist below; the MCP transport was retired.' } },
      { key: 'members', type: 'rows', advanced: true, group: { zh: '接收范围', en: 'Reception scope' },
        label: { zh: '企微账号 → TAPD 中文名', en: 'WeCom alias → TAPD name' },
        hint: { zh: '唯一的身份映射表（静态）。身份名和接收项的「处理人」都可以填企微账号，按这里换成 TAPD 中文名后再比较或查询；没配映射的别名会按原文匹配，容易漏单。已下线的内网成员表接口不再读取。',
          en: 'The only identity mapping (static). The identity name and each watch owner may be a WeCom alias; it is turned into the TAPD Chinese name before comparing or querying. An unlisted alias is matched literally and can miss items. The retired intranet member endpoint is no longer read.' },
        columns: [
          { key: 'alias', type: 'text', label: { zh: '企微账号', en: 'WeCom alias' } },
          { key: 'name', type: 'text', label: { zh: 'TAPD 中文名', en: 'TAPD name' } }] },
      { key: 'webhook', type: 'switch', advanced: true, group: { zh: '连接与凭据', en: 'Connection & credentials' },
        label: { zh: 'TAPD Webhook（可选）', en: 'TAPD Webhook (optional)' },
        hint: { zh: '默认关闭。TAPD 后台把事件 POST 到本机 /orchestrator/webhook/tapd，内容类型选 application/json，secret 填下面的验证密码（「网关 Token」不用填）。Host 只监听 127.0.0.1，云端 TAPD 需要内网网关或反向代理。它只是轮询之外的加速通道：事件只带单号，会回读并按接收项匹配；评论仍由轮询跟进。',
          en: 'Off by default. Point TAPD at the local /orchestrator/webhook/tapd, choose application/json and set the secret below (ignore the gateway Token). The Host listens on 127.0.0.1 only, so cloud TAPD needs an intranet gateway or reverse proxy. This is only a fast lane on top of polling: events carry IDs, are reread and matched against watches, and comments still come from polling.' } },
      { key: 'webhookSecret', type: 'text', advanced: true, group: { zh: '连接与凭据', en: 'Connection & credentials' },
        label: { zh: 'Webhook 验证密码', en: 'Webhook shared secret' },
        hint: { zh: '与 TAPD 后台一致（POST body，或 x-tapd-secret 头 / secret 查询参数）。开启却留空会报错并让所有推送返回 503。明文保存在本机状态目录，不要复用其它系统的密码；轮换时同步改 TAPD 后台。',
          en: 'The same value as in TAPD (POST body, x-tapd-secret header or secret query). Empty while enabled reports an error and answers 503. Stored in plain text in the local state directory; do not reuse another password and update TAPD when rotating.' } },
      { key: 'pollSeconds', type: 'number', advanced: true, group: { zh: '运维参数', en: 'Operations' },
        min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
      { key: 'failuresBeforeError', type: 'number', advanced: true, group: { zh: '运维参数', en: 'Operations' },
        min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    ],
    scope: ({ meta }, config) => {
      const row = meta.kind === 'comment' ? 'comments' : meta.kind === 'status' ? 'status' : 'items'
      // With no identity to address, "assigned/@ only" cannot filter anything; observe the whole watch instead.
      return { listened: true, observed: !config.agent || meta.mode === 'all', row }
    },
    health: [TAPD_SOURCE],
    channel: {
      send: async (_host, message) => {
        const ctx = options.context()
        const config = ctx?.config<TapdConfig>(TAPD_SOURCE)
        if (!ctx || !config) throw new Error('The TAPD Source is not running')
        return sendTapd(apiOf(config, ctx), config, message)
      },
      link: address => {
        const config = options.context()?.config<TapdConfig>(TAPD_SOURCE)
        const type = address.type as TapdType
        const label = `TAPD ${TYPE_LABEL[type] ?? ''} ${address.id ?? ''}`.trim()
        return { url: config && address.workspace && address.id ? itemPage(config.site, { type, workspace: address.workspace, id: address.id }) : '', label: { zh: label, en: label } }
      },
    },
    find: query => {
      const address = itemAddress(query)
      return { threads: address ? [`${TAPD_SOURCE}:${itemThread(address)}`] : [], terms: [] }
    },
    policy: {
      schema: TapdPolicySchema,
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 TAPD 用户', en: 'TAPD users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'TAPD 名字', en: 'TAPD name' } }] }],
      explicit: { zh: '名单里的人创建的单子指派给上面设置的 TAPD 身份名、在评论里 @ 它，或运维在来源里点名了这个单子。', en: 'An item created by someone on the list is assigned to the configured TAPD identity, a comment @s it, or the operator named the item in the Source.' },
      rows(stored) {
        const config = TapdConfigSchema.partial().parse(stored)
        const all = !config.agent || (config.watches ?? []).some(watch => watch.mode === 'all')
        const note = all ? { zh: '有“全部变化”的接收项', en: 'Some watches receive all changes' } : { zh: '仅指派/@', en: 'Assigned/@ only' }
        return [
          { id: 'items', label: { zh: '新单子与指派', en: 'New and assigned items' }, note, cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } },
          { id: 'status', label: { zh: '状态变化', en: 'Status changes' }, note, cells: { listedUnaddressed: all, unlistedAddressed: false, unlistedUnaddressed: all } },
          { id: 'comments', label: { zh: '已订阅单子的评论', en: 'Comments on subscribed items' }, note: { zh: '仅 @', en: '@ only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }]
      },
    },
    refreshLabels: async (host, signal) => {
      const ctx = sourceContext(host, kind)
      const config = ctx.config<TapdConfig>(TAPD_SOURCE)
      if (!config) return {}
      const api = apiOf(config, ctx)
      const resolved = resolvedConfig(config)
      const labels: Record<string, string> = {}
      // Namespaces keep the dropdown candidates apart from the watch-title labels (the first rows column).
      const put = (prefix: string, value: string, name: string) => { if (value) labels[`${prefix}:${value}`] = name }
      if (api.choices) {
        for (const [kindName, prefix] of [['workspace', 'workspace'], ['status', 'status'], ['iteration', 'iteration']] as const) {
          try {
            for (const choice of await api.choices(kindName, resolved.workspace, signal)) put(prefix, choice.value, choice.label)
          } catch { /* one failing lookup must not hide the others */ }
        }
      }
      // TAPD Open API has no member-list endpoint (the old one was the retired intranet platform):
      // identity candidates are the static mapping plus owners/creators of the items read below.
      for (const member of resolved.members) put('agent', member.name, member.alias ? `${member.name}（${member.alias}）` : member.name)
      const owners = new Set<string>()
      for (const watch of resolved.watches) {
        try {
          const items = await api.items(watch.type, watchWorkspace(resolved, watch), watchFilter(watch), signal)
          labels[watch.name] = watch.item ? (items[0] ? `#${items[0].id} ${items[0].title} · ${items[0].status}` : `#${watch.item} 不存在或无权读取`) : `${items.length} 个${TYPE_LABEL[watch.type]}`
          for (const item of items) {
            for (const owner of item.owners) { if (owner) owners.add(cleanOwner(owner)) }
            if (item.creator) owners.add(cleanOwner(item.creator))
          }
        } catch (error) { labels[watch.name] = `读取失败：${String(error).slice(0, 120)}` }
      }
      for (const owner of owners) if (!labels[`agent:${owner}`]) put('agent', owner, owner)
      // A saved value must stay selectable even when TAPD did not return it in this refresh.
      if (!labels[`workspace:${resolved.workspace}`]) put('workspace', resolved.workspace, `${resolved.workspace}（当前）`)
      if (resolved.agent && !labels[`agent:${resolved.agent}`]) put('agent', resolved.agent, `${resolved.agent}（当前）`)
      for (const watch of resolved.watches) {
        if (watch.status && !labels[`status:${watch.status}`]) put('status', watch.status, `${watch.status}（当前）`)
        if (watch.iteration && !labels[`iteration:${watch.iteration}`]) put('iteration', watch.iteration, `${watch.iteration}（当前）`)
        if (watch.workspace && !labels[`workspace:${watch.workspace}`]) put('workspace', watch.workspace, `${watch.workspace}（当前）`)
      }
      ctx.state.set(KV.sources.labels(TAPD_SOURCE), labels)
      return labels
    },
    environment: {
      variables: [
        { key: 'DSH_SUPERAGENT_TAPD_ITEM', description: { zh: '接下工单的 TAPD 单子，写作 <类型>:<单号>，例如 bug:1001；工单不是从 TAPD 来的时为空', en: 'The TAPD item that started the ticket, as <type>:<id> such as bug:1001; empty when it did not start on TAPD' } },
        { key: 'DSH_SUPERAGENT_TAPD_WORKSPACE', description: { zh: '这个单子所在的 TAPD 项目 ID', en: 'The TAPD workspace ID of that item' } },
        { key: 'DSH_SUPERAGENT_TAPD_URL', description: { zh: '这个单子的页面', en: 'The page of that item' } },
        { key: 'DSH_SUPERAGENT_TAPD_BUG', description: { zh: '单子是缺陷时的单号；写 P4 CL 描述时以 --bug=<它> 关联', en: 'The ID when the item is a bug; link a P4 CL description to it with --bug=<it>' } },
      ],
      values: ({ config, trigger }) => {
        const meta = trigger?.source === TAPD_SOURCE ? trigger.meta : undefined
        const type = typeof meta?.type === 'string' ? meta.type as TapdType : undefined
        const id = typeof meta?.id === 'string' ? meta.id : '', workspace = typeof meta?.workspace === 'string' ? meta.workspace : ''
        return { DSH_SUPERAGENT_TAPD_ITEM: type && id ? `${type}:${id}` : '', DSH_SUPERAGENT_TAPD_WORKSPACE: workspace,
          DSH_SUPERAGENT_TAPD_URL: type && id && workspace ? itemPage(config.site, { type, workspace, id }) : '', DSH_SUPERAGENT_TAPD_BUG: type === 'bug' ? id : '' }
      },
    },
  }
  return kind
}

export const name = 'dsh-superagent-tapd'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  const kindRef = { kind: TAPD_SOURCE, health: [TAPD_SOURCE] }
  let source: SourceContext | undefined
  const kind = makeTapdKind({ context: () => source })
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'tapd: source kind')
  ctx.effect(() => {
    source = sourceContext(ctx.orchestrator, kindRef)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as source health instead.
    const running = watch(source, controller.signal, config => tapdApi(config))
      .catch((error: unknown) => { source?.report(TAPD_SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running; source = undefined }
  })
}
export async function watch(ctx: SourceContext, signal: AbortSignal, apiOf: (config: TapdConfig) => TapdApi): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report(TAPD_SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<TapdConfig>(TAPD_SOURCE)
    try {
      if (!config) ctx.report(TAPD_SOURCE, health('paused', 'sourceOff'))
      else if (!tapdConfigured(config)) ctx.report(TAPD_SOURCE, health('paused', 'tapdUnset'))
      else {
        await pollRound(ctx, apiOf(config), config, signal)
        // A Webhook with no shared secret refuses every delivery; do not report a misleading "ready".
        ctx.report(TAPD_SOURCE, config.webhook && !config.webhookSecret
          ? health('error', 'tapdWebhookUnset') : { state: 'ready', detail: '' })
      }
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report(TAPD_SOURCE, failed)
    }
    await pause((ctx.config<TapdConfig>(TAPD_SOURCE)?.pollSeconds ?? 120) * 1000, signal)
  }
}
