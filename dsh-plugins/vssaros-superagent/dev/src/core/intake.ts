/** Trigger ingestion, thread correlation, subscription fan-out, and evaluation queuing. */
import { key } from './ids.ts'
import { isoTime, liveTicket, threadKey, waitsForPerson } from './model.ts'
import type { Ticket, Trigger } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/**
 * ★ 2026-11-09（真机）：主管台所有消息共用同一个 desk Thread，工单创建时订阅它，
 *   于是一条**全新的请求**也会被扇出给「待人回答」的旧工单，回执先说「已转给正在做的工单…」，
 *   worker 之后才用 handback 退回重评。用户看到的就是「转给了一个不相关的旧工单」。
 *
 *   这里只把「看起来像回答」的消息投给待人回答的工单，明显的新请求留给 Eval 重新分诊。
 *   待人回答有两种形态：worker 报了 blocked/failed 等人（`waitsForPerson`），
 *   或主管直接挂了一个未回答的提问（`ticket.attention`）——真机那张 cartoon.hml 工单是后者。
 */
export const awaitingAnswer = (ticket: Ticket): boolean =>
  !ticket.ended && (!!ticket.attention || waitsForPerson(ticket))

/** 明确的新工作：以创建/添加/实现等动词开头，或整句在建群/组队。保守——其余一律当成回答，避免误伤真回答。 */
const NEW_WORK = /^(?:(?:请|帮我|麻烦|顺便|再|又|另外|还有)\s*)*(?:创建|新建|组建|成立|添加|新增|增加|生成|实现|开发|开始|启动|拉个|拉一?个|做(?:一)?个|写(?:一)?个)/u
const GROUP_REQUEST = /(?:建|拉|创建|组建|成立)[^，,。！!？?]{0,48}(?:群|团队)|群聊/u

export function looksLikeAnswer(text: string): boolean {
  const body = String(text ?? '').trim()
  if (!body) return true
  if (body.startsWith('@')) return false          // @群名 是发给已有群的命令
  if (NEW_WORK.test(body)) return false
  if (GROUP_REQUEST.test(body)) return false
  return true
}

/**
 * Ingests incoming triggers from Sources, deduplicating and filtering them against SourceScope before recording thread correlations.
 * Fans listened triggers out to subscribed tickets via Tickets and queues for Eval, on its primary thread, every trigger no
 * ticket's worker decides (see `followupOwners`).
 * Engine delegates trigger reception to this part.
 */
export class Intake extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  /**
   * @param options.tickets VsSaros addition (2026-11-06): `false` for a message addressed elsewhere (to a group of Bots), which
   *   is recorded on its Threads but reaches no ticket; it goes to Eval, where its caller decides it at once.
   */
  receive(received: Trigger, options: { tickets?: boolean } = {}): ReceiveResult {
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    const trigger = { ...received, at: isoTime(received.at) }
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    const filter = this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger); this.repo.triggers.saveDisposition(trigger.id, { filtered: { code: filter.reason }, fanout: [], at })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // Track reached tickets and whether they were reached only via context threads (a ticket's own thread makes `context` false).
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    for (const ref of trigger.threads) {
      const thread = this.thread(ref)
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
      // VsSaros addition (2026-11-06): see `EngineOptions.conversation` and `options.tickets`.
      const conversation = !!this.options.conversation?.(thread.key)
      for (const ticketId of options.tickets === false ? [] : thread.subscriptions) {
        const ticket = this.repo.tickets.get(ticketId)
        // Only a person's message on a non-context thread resumes an ended ticket; bots and CI do not (the Executor re-reads
        // threads when it resumes), and a human-stopped ticket receives nothing because its Mandate was withdrawn.
        const followed = !!thread.context?.includes(ticketId)
        // VsSaros fix (2026-11-06, real run): on the desk, a group command 28 minutes after a ticket ended resumed it.
        const resumes = trigger.human && ticket?.ended?.by !== 'human' && !followed && !conversation
        if (!ticket || (!liveTicket(ticket) && !resumes)) continue
        // ★ 2026-11-09：待人回答的工单只接回答。人的新请求不进 fanout ⇒ owners 为空 ⇒ 下面
        //   `queueForEval` 会把它交给主 Session 重新评估（可另起工单/建群），而不是先塞给旧 worker。
        //   只对 human 生效：bot/CI 的后续消息照旧投递，避免影响自动化链路。
        if (trigger.human && !followed && awaitingAnswer(ticket) && !looksLikeAnswer(trigger.text)) continue
        reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
      }
      this.repo.threads.save(thread)
    }
    for (const [ticketId, { ticket, context: followed }] of reached) {
      this.tickets.addInput(ticket, { id: key('input', ticketId, 'trigger', trigger.id), kind: 'trigger', triggerId: trigger.id, at,
        ...trigger.human ? { human: true } : {}, ...followed ? { context: true } : {} })
    }
    const fanout = [...reached.keys()], context = fanout.filter(id => reached.get(id)!.context)
    const disposition = { fanout, ...context.length ? { context } : {}, at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // A person's message that no ticket decides, such as one that reached only tickets a person stopped or that follow the
    // Thread for context, and every bot's, goes to Eval.
    if (!this.owners(trigger).length) this.queueForEval(trigger)
    for (const ticketId of fanout) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }
}
