/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import { claimGongfengMr } from '../../sources/gongfeng.ts'
import { GongfengOpenApi, type GongfengConfig, type GongfengApi } from '../../sources/gongfeng-api.ts'
import { claimChangelist, p4 as p4Records, P4ConfigSchema, P4_SOURCE, readChange, type P4Config } from '../../sources/p4-change.ts'
import { finalizePending } from '../../executor/p4-pending.ts'
import { hostPoolAuthorization } from '../../sources/tapd-pool-authorization.ts'
import type { Settings } from '../../policy.ts'
import { KV } from '../../kv.ts'
import { itemAddress, tapdApi, type TapdApi, type TapdConfig } from '../../sources/tapd-api.ts'
import type { Reviews } from '../review.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { leadTools, type TeamSteps } from '../steps.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  /** VsSaros addition: p4 Source context whose changelist rules govern claiming a reported CL. */
  readonly p4: SourceContext
  readonly gongfeng?: SourceContext
  gongfengApi?(config: GongfengConfig): GongfengApi
  /** VsSaros addition: where a ready CL waits for a person's review. */
  readonly reviews: Pick<Reviews, 'request' | 'requireChangelist' | 'requiredChangelist'> & Partial<Pick<Reviews, 'deliveredPending'>>
  /** VsSaros addition (superagent v2, P3): the steps of a ticket's team, which its worker leads. */
  readonly steps?: Pick<TeamSteps, 'unfinished' | 'message'>
  sendReplies(): Promise<void>
}

/**
 * ★ 2026-11-11（用户）：TAPD 操作走 SuperAgent 设置里配置的 Open API，不用浏览器网页。
 *   凭据只存在于 Host 侧（tapd-auth.ts / tapd.env / 随包账号），这里只读非密钥配置
 *   （api 地址、workspace），且只把单据与评论返回给 worker，绝不返回 authorization。
 *   apiOf 可注入，便于单测用假实现，不触碰真实网络。
 */
export interface TapdIntakeHost {
  store: Pick<Store, 'tickets' | 'triggers' | 'read' | 'get'>
  ticketId: string
  settings(): Settings
}

/** Exact same-item references for the same human and receiving conversation; never exports another ticket's content. */
export function tapdIntakeContext(host: TapdIntakeHost, address: NonNullable<ReturnType<typeof itemAddress>>) {
  const settings = host.settings(), source = settings.sources.p4
  const parsed = P4ConfigSchema.safeParse(source?.config ?? {})
  const config = parsed.success ? parsed.data : undefined
  const missing = [...(!source?.enabled ? ['enabled'] : []), ...(!config?.port ? ['port'] : []),
    ...(!config?.user ? ['user'] : []), ...(!config?.paths.length ? ['paths'] : []), ...(!parsed.success ? ['invalid-config'] : [])]
  const current = host.store.tickets.get(host.ticketId)
  const trigger = current && host.store.triggers.get(current.origin.triggerId)
  const identity = (value: NonNullable<typeof trigger>) => value.source === 'tapd'
    ? { workspace: value.meta.workspace, type: value.meta.type, id: value.meta.id }
    : itemAddress(/https?:\/\/\S+/i.exec(value.text)?.[0] ?? value.url ?? '')
  const same = (value: ReturnType<typeof identity>) => value?.workspace === address.workspace && value?.type === address.type && value?.id === address.id
  const references = new Map<number, { changelist: number; recordedState: string; at: string }>()
  if (current && trigger?.human && trigger.actor.id && trigger.channel?.thread && same(identity(trigger))) {
    for (const old of host.store.read.priorActorTickets(trigger.source, trigger.actor.source, trigger.actor.id, current.createdAt)) {
      const origin = host.store.triggers.get(old.origin.triggerId)
      if (!origin || origin.channel?.source !== trigger.channel.source || origin.channel?.thread !== trigger.channel.thread || !same(identity(origin))) continue
      const review = host.store.get(KV.reviews.review(old.id))
      const changes = [review?.change,
        ...old.follows?.filter(follow => follow.own && follow.thread.startsWith('p4:')).map(follow => Number(follow.thread.slice(3))) ?? []]
      for (const change of changes) if (change && Number.isSafeInteger(change) && change > 0 && !references.has(change)) {
        references.set(change, { changelist: change, recordedState: review?.change === change ? review.state : 'reported-unverified', at: old.updatedAt })
      }
      if (references.size >= 3) break
    }
  }
  return { p4Readiness: { configured: missing.length === 0, missing, serverChecked: false }, priorDelivery: [...references.values()].slice(0, 3),
    priorDeliveryScope: 'Up to 3 review/owned-thread references matched to this conversation and exact TAPD item among the last 100 earlier tickets by this human/source. Not exhaustive or server-verified; does not transfer CL ownership or authorize reuse, unshelve, or reading another ticket directory.' }
}

export function tapdItemTool(configOf: () => TapdConfig,
  apiOf: (config: TapdConfig) => TapdApi = tapdApi, intake?: TapdIntakeHost): Tool {
  return tool({
    name: 'orchestrator_tapd_item',
    description: 'Read a TAPD bug/story/task (detail and comments) through the TAPD Open API configured in SuperAgent settings. '
      + 'Use this instead of a browser or the TAPD web page; the Host keeps the credentials.',
    schema: z.object({
      url: z.string().trim().min(1).describe('The TAPD item URL from the person\'s request.'),
      comments: z.number().int().min(0).max(50).default(20).describe('How many recent comments to include.'),
    }).strict(),
    execute: async (args, signal) => {
      const config = configOf()
      // 请求消息常是「修复 bug 单：https://…」，先把链接摘出来再解析。
      const url = /https?:\/\/\S+/i.exec(args.url)?.[0] ?? args.url
      const address = itemAddress(url)
      if (!address) throw new Error('Not a TAPD item URL; pass the link from the request.')
      const workspace = address.workspace || config.workspace
      const api = apiOf(config)
      signal.throwIfAborted()
      const started = performance.now()
      const items = await api.items(address.type, workspace, { id: address.id }, signal)
      const item = items.find(value => value.id === address.id && value.workspace === workspace && value.type === address.type)
      if (!item) throw new Error('TAPD item not found, or the configured account cannot read it.')
      const detailMs = Math.round(performance.now() - started)
      const commentsStarted = performance.now()
      const thread = args.comments ? api.recentComments
        ? await api.recentComments(address.type, workspace, address.id, args.comments, signal)
        : (await api.comments(address.type, workspace, address.id, undefined, signal)).slice(-args.comments).reverse() : []
      signal.throwIfAborted()
      return { api: config.api, workspace, item, comments: thread.slice(0, args.comments),
        readTiming: { detailMs, commentsMs: Math.round(performance.now() - commentsStarted), totalMs: Math.round(performance.now() - started) },
        progressNote: 'Requested detail/comments have returned. After extracting the symptom and keywords, update todo_write before source/evidence investigation. API timing is not the todo phase duration.',
        ...(intake ? tapdIntakeContext(intake, { ...address, workspace }) : {}) }
    },
  })
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github?.login ?? "the agent's GitHub account"} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        // VsSaros addition (p4 Source).
        changelist: z.number().int().positive().nullish().describe('The ticket\'s pending P4 CL, shelved in its authorized workspace. Current-client CLs require this ticket marker in the description. Never submit; a person approves.'),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
        ...(host.gongfeng?.config<GongfengConfig>('gongfeng')?.project ? {
          mr_iid: z.number().int().positive().optional().describe('Gongfeng MR IID (not global ID); source MR or this ticket branch only.'),
        } : {}),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        if (current.execution?.delivery === 'p4' && (args.state === 'dropped' || (args.state === 'ready' && args.changelist == null))) {
          throw new Error('P4 delivery required: report a verified shelved changelist, or blocked with a human action. Another ticket\'s CL or omitted changelist is not completion.')
        }
        if (args.changelist != null) host.reviews.requireChangelist(ticketId, args.changelist)
        if (args.state === 'ready' && args.changelist == null && host.reviews.requiredChangelist(ticketId) !== undefined) {
          throw new Error('This ticket requires a P4 changelist: report ready with its shelved CL, or report blocked; omitting changelist cannot bypass review')
        }
        // VsSaros addition: a team's ticket is ready only once every step finished.
        const open = args.state === 'ready' ? host.steps?.unfinished(ticketId) ?? [] : []
        if (open.length) throw new Error(`Team steps still unfinished: ${open.map(step => `${step.key} ${step.state}`).join(', ')}; wait for their reports`)
        const gongfeng = host.gongfeng
        const iid = args.mr_iid === undefined ? undefined : z.number().int().positive().safe().parse(args.mr_iid)
        const origin = host.resources.store.triggers.get(current.origin.triggerId)
        const requiresMr = origin?.source === 'gongfeng' || current.execution?.project?.source === 'gongfeng'
        if (args.state === 'ready' && requiresMr && iid === undefined) throw new Error('Gongfeng delivery requires mr_iid; report blocked when no verified MR is available')
        const gfConfig = iid !== undefined ? gongfeng?.config<GongfengConfig>('gongfeng') : undefined
        if (iid !== undefined && (!gongfeng || !gfConfig?.project || !gfConfig.agent)) throw new Error('Configure the Gongfeng project/account first')
        const gfApi = gfConfig ? host.gongfengApi?.(gfConfig) ?? new GongfengOpenApi(gfConfig) : undefined
        const gfIdentity = gfApi && gfConfig ? await gfApi.verify(gfConfig.agent, signal) : undefined
        const mr = gfApi && iid !== undefined ? await gfApi.mr(iid, signal) : undefined
        signal.throwIfAborted()
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        const p4 = args.changelist != null ? host.p4.config<P4Config>(P4_SOURCE) : undefined
        if (args.changelist != null && !p4) throw new Error('The P4 Source is off; report blocked and ask a person to enable it')
        if (p4 && !p4.paths.length) throw new Error('Configure allowed paths in P4 settings before reporting a changelist; report blocked, not ready without a CL')
        let change = p4 && args.changelist != null ? await readChange(host.p4.commands.withSignal(signal), p4, args.changelist) : undefined
        if (args.changelist != null && !change) throw new Error(`Changelist ${args.changelist} does not exist on the P4 server`)
        // Pending delivery: the Host consolidates every changed file into ONE named pending CL, names it and
        // re-shelves it. No review, no submit, no unshelve; a person decides in P4V when to submit.
        const poolDelivery = !!origin && !!hostPoolAuthorization(host.resources.store, origin)
        const protectedFiles = current.execution?.protectedP4Files ?? []
        if (change && [...change.files, ...change.shelved].some(file => protectedFiles.includes(file.depotFile))) throw new Error('Reported CL contains earlier delivered files; do not adopt another ticket modification')
        let pending: { change: number; name: string; files: number; ignored: number } | undefined
        if (args.state === 'ready' && p4 && change && current.execution?.p4Delivery === 'pending') {
          const refusal = claimChangelist(host.p4, p4, ticketId, change)
          if (refusal) throw new Error(refusal)
          const commands = host.p4.commands.withSignal(signal)
          const { client, number } = change
          const globals = [...p4.port ? ['-p', p4.port] : [], '-u', p4.user, '-c', client]
          const finalized = await finalizePending(p4, number, ticketId, current.title ?? '', {
            records: async argv => p4Records(commands, p4, argv, { client }),
            form: (argv, input) => commands.run(p4.cli || 'p4', [...globals, ...argv], undefined, input),
          }, poolDelivery || protectedFiles.length > 0)
          pending = { change: change.number, name: finalized.name, files: finalized.files, ignored: finalized.ignored }
          // Re-read after rename/re-shelve so the delivery gate sees the final description and shelf.
          change = await readChange(commands, p4, change.number)
          if (!change) throw new Error(`Changelist ${pending.change} disappeared after finalizing`)
        }
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          signal.throwIfAborted()
          if (gfConfig && JSON.stringify(gongfeng?.config<GongfengConfig>('gongfeng')) !== JSON.stringify(gfConfig)) throw new Error('Gongfeng configuration changed before report')
          const refused = (pull && claimPull(host.github, ticketId, pull)) || (p4 && change && claimChangelist(host.p4, p4, ticketId, change))
            || (gongfeng && gfConfig && mr && gfIdentity && claimGongfengMr(gongfeng, gfConfig, ticketId, mr, gfIdentity.path))
          if (refused) throw new Error(refused)
          // Only the legacy submit flow needs a review; a pending CL is the delivery itself.
          const review = args.state === 'ready' && change && !pending ? host.reviews.request(ticketId, change) : undefined
          if (pending && change) host.reviews.deliveredPending?.(ticketId, change, poolDelivery ? '池任务交付即结束，不等待编译、回归或审阅；未提交。' : 'Pending CL delivered, not submitted.')
          const summary = pending ? `${args.summary}\n\nP4 pending CL ${pending.change}：${pending.name}（归集 ${pending.files} 个文件，忽略 ${pending.ignored} 个）；未提交，请在 P4V 审阅后自行提交。` : args.summary
          const report = { state: args.state, summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}),
            ...pending ? { pending: { ...pending, note: 'A single named pending CL is the delivery. It is not submitted; a person decides in P4V.' } } : {},
            ...review ? { review: { changelist: review.change, state: review.state, client: review.client, files: review.files,
              note: 'Shelved files are verified; build/test claims in the summary are not verified by the Host. A person reviews it in the panel; do not submit it, and keep its shelf as it is until the review ends.' } } : {} }
        })
      },
    }),
    ...(host.gongfeng?.config<GongfengConfig>('gongfeng')?.project ? [tool({
      name: 'orchestrator_gongfeng_mr',
      description: 'Read or create a Gongfeng MR in the configured project. Create only on this ticket branch; no merge or automatic retry.',
      schema: z.object({ action: z.enum(['read', 'create']), iid: z.number().int().positive().optional(),
        title: z.string().min(1).max(300).optional(), description: z.string().max(20000).optional(), target_branch: z.string().min(1).max(200).optional() }).strict(),
      execute: async (args, signal) => {
        const ctx = host.gongfeng!, config = ctx.config<GongfengConfig>('gongfeng')
        const current = host.store.tickets.get(ticketId)
        if (!config?.project || !config.agent || !current || !liveTicket(current)) throw new Error('Gongfeng is not configured or ticket ended')
        const api = host.gongfengApi?.(config) ?? new GongfengOpenApi(config)
        const identity = await api.verify(config.agent, signal)
        signal.throwIfAborted()
        if (args.action === 'read') {
          if (!args.iid) throw new Error('Read requires MR IID')
          const origin = ctx.triggers.get(current.origin.triggerId)
          if (!(origin?.source === 'gongfeng' && origin.meta.project === config.project && origin.meta.iid === args.iid)
            && !current.follows?.some(follow => follow.thread === `gongfeng:${config.project}:${args.iid}`)) throw new Error('MR is not reachable by this ticket')
          const mr = await api.mr(args.iid, signal)
          const notes = await api.notes(mr.id, 1, signal)
          return { iid: mr.iid, state: mr.state, title: mr.title, description: mr.description, source_branch: mr.source_branch,
            target_branch: mr.target_branch, notes: notes.items, next: notes.next ? `gongfeng/${config.project}/${mr.iid}/notes/${notes.next}` : null }
        }
        if (!identity.canPush || !args.title || !args.target_branch || !current.execution?.name) throw new Error('Create needs verified developer access, title, target branch and ticket branch')
        if (current.follows?.some(follow => !follow.closed && follow.thread.startsWith('gongfeng:'))) throw new Error('This ticket already follows an open MR; reuse it')
        const branch = `agent/${current.execution.name}`
        for (let page: number | null = 1; page !== null;) {
          const existing = await api.mrs(page, signal)
          if (existing.items.some(mr => mr.source_branch === branch && ['opened', 'reopened'].includes(mr.state))) throw new Error('MR already exists on this branch; inspect before retrying')
          page = existing.next
          if (page !== null && page > 10) throw new Error('Cannot finish duplicate-MR check; creation refused')
        }
        signal.throwIfAborted()
        const stored = host.store.tickets.get(ticketId)
        if (!stored || !liveTicket(stored) || stored.execution?.name !== current.execution.name) throw new Error('Ticket ended or changed before MR creation')
        if (JSON.stringify(ctx.config<GongfengConfig>('gongfeng')) !== JSON.stringify(config)) throw new Error('Gongfeng configuration changed before creation')
        const record = KV.gongfeng.creation(config.project, ticketId)
        if (ctx.state.get(record)) throw new Error('An MR creation was already attempted; inspect its result before retrying')
        ctx.state.set(record, { branch })
        const mr = await api.create({ title: args.title, description: args.description ?? '', source_branch: branch, target_branch: args.target_branch }, signal)
        ctx.state.set(record, { branch, iid: mr.iid })
        signal.throwIfAborted()
        if (JSON.stringify(ctx.config<GongfengConfig>('gongfeng')) !== JSON.stringify(config)) throw new Error(`MR !${mr.iid} created but configuration changed; do not repeat creation`)
        const refused = host.store.atomic(() => claimGongfengMr(ctx, config, ticketId, mr, identity.path))
        if (refused) throw new Error(`MR created as !${mr.iid}, but binding refused: ${refused}; do not retry creation`)
        return { iid: mr.iid, bound: true, url: `${new URL(config.api).origin}/${identity.path}/merge_requests/${mr.iid}`, merge: 'human-only' }
      },
    })] : []),
    // VsSaros addition (superagent v2, P3): the lead of a ticket's team may message a step's Bot.
    ...ticket.team && host.steps ? leadTools(host.steps, ticketId) : [],
  ]
}
