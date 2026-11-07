/**
 * VsSaros addition: the supervisor desk, a DSH Session where a person talks to SuperAgent directly. The desk does no work
 * itself: its one tool hands the person's latest message, word for word, to the `superagent` Source, so the request goes
 * through the same gate, Eval and tickets as one from Feishu, GitHub or TAPD. Replies come back into the desk.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { key, latestAssignment, type ChannelRef, type OutboundMessage, type ReceiveResult, type Ticket, type TicketOutcome, type Trigger } from '../core/index.ts'
import { deskTrigger, SUPERAGENT_SOURCE, type SuperagentAddress } from '../sources/superagent.ts'
// Type only: tools/tool.ts reaches the executor through resources.ts, which would make the Sessions import a cycle.
import type { Tool } from './tools/tool.ts'

/** The desk's Session ID for a state directory (stable, as the main Session's is). */
/**
 * The desk Session's id, one per state directory. VsSaros change: a desk opened in a workbench belongs to that workbench for
 * good, and the built-in workbench (`vssaros:superagent`) is not the incubating one (`local:dsh-superagent`), so the
 * built-in's desk is a Session of its own.
 */
export const deskSessionId = (stateDir: string): string => `desk-${key('superagent-desk:vssaros', stateDir)}`

/** The desk's whole system prompt: it hands messages over, relays the supervisor's news, and never does the work itself. */
export const DESK_PROMPT = [
  'You are the desk of SuperAgent, the supervisor of the VsSaros Bots on this machine. You never do the work yourself.',
  'Every message the person types here reaches the supervisor by itself as it arrives. When the person sends a request, a question for the',
  'supervisor, or an answer to the supervisor (such as agreeing to a proposal), call superagent_submit once, then tell them in one short',
  'sentence that the supervisor has it.',
  'Messages that start with [SuperAgent] are the supervisor\'s news for the person: never submit them. Tell the person what it says in a',
  'few short lines in their language, keeping every name, number, code and step. Only news that needs the person comes here (progress',
  'is shown in the SuperAgent workbench). For a team proposal, list its members and steps, then say they can reply 同意 to start, write',
  'changes for a new version, or reply 取消. For a step\'s request (【需要你批准 #code】), say which Bot wants to run what, and that they',
  'can reply 同意 #code, 同意并记住 #code or 拒绝 #code. The buttons above this conversation do the same. For a question from the',
  'supervisor, ask it as it is. A ticket\'s end (【工单结束】) is shown by SuperAgent itself; if one comes with the person\'s message, say',
  'in one line how it ended, then answer the person.',
].join(' ')

/** What the desk's tool needs: the Runtime's intake of a Trigger, and (for a ticket's end) its tickets. */
export interface DeskHost { receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>; ticket?(id: string): Ticket | undefined }
/** The part of a Session event the desk reads; DSH records each person's message as `user/message` from source `user`. */
type DeskEvent = { type: string; data?: unknown }

/** The person's latest message in a Session's events, or undefined when there is none. */
export function latestPersonMessage(events: readonly DeskEvent[]): { id: string; text: string } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'user/message') continue
    const message = event.data as { id?: unknown; source?: { kind?: unknown }; content?: readonly { type?: unknown; text?: unknown }[] } | undefined
    if (message?.source?.kind !== 'user' || typeof message.id !== 'string') continue
    const text = (message.content ?? []).flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
    if (text) return { id: message.id, text }
  }
  return undefined
}

/** The desk's tool: it takes no text, so the model cannot reword what the person asked. */
export function deskTools(host: DeskHost, agent: { id: string; session: { snapshotEvents(): readonly DeskEvent[] } }): Tool[] {
  const schema = z.object({}).strict()
  const submit: Tool<typeof schema> = {
    name: 'superagent_submit',
    description: 'Hand the person\'s latest message to the SuperAgent supervisor, word for word. Takes no arguments; call it once per message.',
    schema,
    execute: async () => {
      const latest = latestPersonMessage(agent.session.snapshotEvents())
      if (!latest) return { submitted: false, note: 'No message from the person to hand over.' }
      const trigger = deskTrigger({ session: agent.id, messageId: latest.id, text: latest.text, at: new Date().toISOString() })
      const result = await host.receive(trigger)
      // `trigger` names the message for the card that shows, in the desk's conversation, where it stands.
      return { submitted: result === 'stored', result, trigger: trigger.id,
        note: result === 'duplicate' ? 'The supervisor has this message already (it was handed over as it arrived); tell the person in one short sentence.'
          : result === 'filtered' ? 'The supervisor desk is switched off in the superagent Source; tell the person.'
          : 'The supervisor has it; its answer comes into this conversation.' }
    },
  }
  const tools = [submit as unknown as Tool]
  const lookup = host.ticket
  if (lookup) {
    const receiptSchema = z.object({ ticket: z.string().min(1) }).strict()
    const receipt: Tool<typeof receiptSchema> = {
      name: RECEIPT_TOOL,
      description: 'Shows how a ticket ended, as a card. SuperAgent calls it by itself for its 【工单结束】 notices; do not call it.',
      schema: receiptSchema,
      execute: async ({ ticket: id }) => {
        const ticket = lookup(id)
        return (ticket && receiptView(ticket)) ?? { found: false, ticket: id, note: 'No ended ticket with this id.' }
      },
    }
    tools.push(receipt as unknown as Tool)
  }
  return tools
}

/** What delivering a reply needs: the Sessions' once-per-request delivery. */
export interface ReplyHost { prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }): Promise<void> }

/** The request id a supervisor's message is delivered under, once per message. */
export const deskRequestId = (messageId: string): string => `superagent-reply:${messageId}`

/**
 * Writes a reply into the Session it belongs to: queued into the desk as a message of its own, which wakes the desk to tell
 * the person, or steered into the asking Bot's Session as `agent_message` would. A Session that no longer exists can never
 * receive it.
 *
 * VsSaros fix (2026-11-05): the desk's replies were injected (`agent.inject`), which DSH keeps in the idle desk's next-step
 * inbox without writing it into the conversation or waking the desk: the person never saw the team proposal they had to
 * agree to, and the inbox was dropped when the Session closed. A queued message is written into the Session's log, shows in
 * DSH's chat, and wakes the desk, as DeepSeek-Bot delivers one Bot's reply to another (`followup`, its host/delivery.js).
 * The Runtime delivers to the desk only through its outbox (desk-outbox.ts), and only what needs the person's answer.
 */
export async function deliverReply(host: ReplyHost, address: SuperagentAddress, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const text = address.kind === 'desk' ? `[SuperAgent] ${message.text}`
    : `[SuperAgent 主管回复]\n${message.text}\n\n要继续找主管，用 agent_message 发给 SuperAgent。`
  try {
    await host.prompt(address.session, deskRequestId(message.id), text, address.kind === 'desk' ? 'queue' : 'steer')
    return 'sent'
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === 'session/not-found') return 'gone'
    throw error
  }
}

/*
 * VsSaros addition (2026-11-06): a ticket's end in the desk's conversation.
 *
 * Before, a desk ticket's end showed only on the card of the turn that handed the message over (its key-node card), which DSH
 * folds into "已完成，用时 …" as soon as the person writes again; the main Session heard of the end, but nothing reached the
 * desk unless its model chose to send a result. Now, as DeepSeek-Bot sends a Bot's answer back to whoever asked it
 * (host/turns.js `finish`), the Runtime tells the desk itself: a `ticket-ended:` notice through the desk outbox (once, kept
 * until the desk has it). The desk answers it with no model turn: `deskReceiptStream` makes that turn a call of
 * `superagent_ticket_result`, drawn as the ticket's end card, then one line that stays visible when the turn folds.
 */

/** The notice id prefix of a ticket's end in the desk. */
export const TICKET_ENDED_NOTICE = 'ticket-ended'
/** The desk's tool that shows how a ticket ended (called by `deskReceiptStream`, not by the model). */
export const RECEIPT_TOOL = 'superagent_ticket_result'
/** Tool-call ids of the turns `deskReceiptStream` makes, so it knows its own results. */
export const RECEIPT_CALL_PREFIX = 'toolu_superagent_receipt_'
const OUTCOME_TEXT: Record<TicketOutcome, string> = {
  completed: '已完成', merged: 'PR 已合并', closed: 'PR 已关闭（未合并）', dropped: '无需处理', stopped: '已停止',
}
const SUMMARY_CHARS = 600
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text

/** How a ticket ended, as its end card and the desk's line read it. */
export interface ReceiptView { receipt: true; ticket: string; trigger: string; title: string; outcome: TicketOutcome; outcomeText: string; summary: string; at: string }
/** The ended ticket's view: its title, outcome and report summary (else the reason it ended); undefined while it is open. */
export function receiptView(ticket: Ticket): ReceiptView | undefined {
  const ended = ticket.ended
  if (!ended) return undefined
  const summary = (latestAssignment(ticket)?.report?.summary ?? '').trim() || (ended.reason ?? '').trim()
  return { receipt: true, ticket: ticket.id, trigger: ticket.origin.triggerId, title: ticket.title, outcome: ended.outcome,
    outcomeText: OUTCOME_TEXT[ended.outcome] ?? ended.outcome, summary: clip(summary, SUMMARY_CHARS), at: ended.at }
}

/**
 * The desk's notice of a ticket's end, for a ticket begun in the desk; undefined for any other ticket, or an open one.
 * Its id names the end (`at`), so a ticket resumed and ended again tells the desk again.
 */
export function ticketEndedNotice(ticket: Ticket, origin: ChannelRef | undefined): OutboundMessage | undefined {
  const view = receiptView(ticket)
  const address = origin?.address as { kind?: unknown } | undefined
  if (!view || origin?.source !== SUPERAGENT_SOURCE || address?.kind !== 'desk') return undefined
  return { id: `${TICKET_ENDED_NOTICE}:${ticket.id}:${view.at}`, channel: origin, kind: 'notice', ticketId: ticket.id,
    text: `【工单结束】「${view.title}」${view.outcomeText}${view.summary ? `：${view.summary}` : '。'}` }
}

/** The desk's line for ended tickets: it stays in the conversation when DSH folds the turn's card away. */
export function receiptText(views: readonly (ReceiptView | undefined)[]): string {
  const lines = views.map(view => view
    ? `**工单已结束 · ${view.outcomeText}**　「${view.title}」${view.summary ? `\n\n${view.summary}` : ''}`
    : '这张工单的结束情况没读到，可以到 SuperAgent 工作台的「工作」页查看。')
  return lines.join('\n\n')
}

/** The part of a model request the desk's stream reads. */
interface StreamMessage { id?: unknown; role?: unknown; source?: { kind?: unknown }; toolCallId?: unknown; content?: unknown; isError?: unknown }
interface StreamOptions { sessionId?: unknown; purpose?: unknown; messages?: readonly StreamMessage[]; tools?: readonly { name?: unknown }[] }
/** What the desk's stream needs: the desk's id, and which ticket's end a delivered message tells (desk outbox). */
export interface DeskStreamHost {
  deskId: string
  ticketEndedOf(messageId: string): string | undefined
  /**
   * VsSaros addition (2026-11-07): resolves once the person's message (by its DSH message id) was handed over as it arrived
   * (or after a bounded wait), so the turn's own `superagent_submit` finds it handed over and never races the group paths.
   * Without it, a turn of the person's messages goes to the desk's model as before.
   */
  handedOver?(messageId: string): Promise<void>
  /** The desk's one line for a `superagent_submit` result: where the message went. */
  submitLine?(result: SubmitResult): Promise<string>
}
/** What `superagent_submit` returns, as the desk's line reads it. */
export interface SubmitResult { submitted?: boolean; result?: string; trigger?: string }
/** Tool-call ids of the `superagent_submit` calls `deskReceiptStream` makes, so it knows its own results. */
export const SUBMIT_CALL_PREFIX = 'toolu_superagent_submit_'
const SUBMIT_TOOL = 'superagent_submit'

/** Where a desk message went, as the desk's line reads it. */
export interface SubmitView { result?: string; route?: { roomName: string; kind: 'created' | 'routed' | 'updated' }; filtered?: boolean; tickets?: readonly string[] }
/** The desk's line for a message it handed over (no model): the flow card above it shows the rest. */
export function submitText(view: SubmitView | undefined): string {
  if (!view?.result) return '这条消息没能交给主管，可以再发一次。'
  if (view.result === 'filtered' || view.filtered) return '这条消息没交给主管：主管台在 superagent 来源里没有放行，可以到 SuperAgent 设置里查看。'
  if (view.route) {
    const name = `「${view.route.roomName}」`
    return view.route.kind === 'created' ? `已建群${name}，群里的 Bots 接着做。` : view.route.kind === 'updated' ? `已更新群${name}。` : `已转给群${name}。`
  }
  if (view.tickets?.length) return `已转给正在做的工单${view.tickets.map(title => `「${title}」`).join('、')}。`
  return '主管收到了，需要你回复的消息会发到这里。'
}

const textOf = (message: StreamMessage): string => {
  const content = message.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('') : ''
}
const parseView = (message: StreamMessage): ReceiptView | undefined => {
  if (message.isError === true) return undefined
  try {
    const value = JSON.parse(textOf(message).trim()) as Partial<ReceiptView>
    return value?.receipt === true && typeof value.title === 'string' ? value as ReceiptView : undefined
  } catch { return undefined }
}

/**
 * `llm/stream` for the desk: when everything new in the desk since its last step is SuperAgent's 【工单结束】 notices, the turn
 * calls `superagent_ticket_result` for each (no model), and after their results says how they ended. Any other turn, such as
 * one with the person's message or another notice, goes to the desk's model as before.
 */
export function deskReceiptStream(host: DeskStreamHost, uuid: () => string = randomUUID) {
  return (options: StreamOptions | undefined, next: () => unknown): unknown => {
    if (!options || options.sessionId !== host.deskId || options.purpose !== undefined) return next()
    const messages = options.messages ?? []
    let last = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant' || messages[index]?.role === 'tool') { last = index; break }
    }
    const fresh = messages.slice(last + 1).filter(message => message?.role === 'user'
      && (message.source?.kind === 'user' || message.source?.kind === 'dsh-superagent'))
    if (last >= 0 && messages[last]?.role === 'tool') {
      // The results of this turn's receipt calls: say how the tickets ended.
      let start = last
      while (start > 0 && messages[start - 1]?.role === 'tool') start -= 1
      const results = messages.slice(start, last + 1)
      const callOf = (prefix: string) => results.every(message => typeof message.toolCallId === 'string' && message.toolCallId.startsWith(prefix))
      if (fresh.length) return next()
      if (callOf(SUBMIT_CALL_PREFIX) && host.submitLine) {
        const line = host.submitLine
        const parsed = (() => { try { return JSON.parse(textOf(results.at(-1)!).trim()) as SubmitResult } catch { return {} } })()
        return (async function* submitted() { yield* say(await line(results.at(-1)!.isError === true ? {} : parsed)) })()
      }
      if (!callOf(RECEIPT_CALL_PREFIX)) return next()
      return say(receiptText(results.map(parseView)))
    }
    // VsSaros addition (2026-11-07): a turn of nothing but the person's own messages hands them over with no model (each was
    // handed over as it arrived already; the call keeps the flow card), then says where it went. 6.8万 tokens a message before.
    if (fresh.length && fresh.every(message => message.source?.kind === 'user')) {
      const latest = fresh.at(-1)!
      if (!host.handedOver || typeof latest.id !== 'string' || !(options.tools ?? []).some(tool => tool?.name === SUBMIT_TOOL)) return next()
      const handedOver = host.handedOver, messageId = latest.id
      const id = `${SUBMIT_CALL_PREFIX}${uuid().replace(/-/g, '')}`
      return (async function* submitCall() {
        await handedOver(messageId)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: SUBMIT_TOOL, argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: SUBMIT_TOOL, arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    }
    if (!fresh.length || fresh.some(message => message.source?.kind === 'user')) return next()
    const tickets = fresh.map(message => typeof message.id === 'string' ? host.ticketEndedOf(message.id) : undefined)
    if (tickets.some(ticket => !ticket)) return next()
    if (!(options.tools ?? []).some(tool => tool?.name === RECEIPT_TOOL)) return next()
    const calls = [...new Set(tickets as string[])].map(ticket => ({ id: `${RECEIPT_CALL_PREFIX}${uuid().replace(/-/g, '')}`,
      arguments: JSON.stringify({ ticket }) }))
    return (async function* receiptCalls() {
      for (const [index, call] of calls.entries()) {
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: call.id, name: RECEIPT_TOOL, argumentsDelta: call.arguments }
        yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: RECEIPT_TOOL, arguments: call.arguments } }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  }
}

/**
 * VsSaros fix (2026-11-07, real machine, found by `dev/scripts/e2e-dsb-coexist.mjs`): the desk masks every tool, `skill` too,
 * but its first step ran before the mask, so DSH's `dsh-tool-skill` put the profile's whole skill catalog into its history
 * (173 skills, 72 KB, DS Bot's among them) and every later desk call carried it. The desk uses no skill: this `llm/stream`
 * listener drops skill catalog messages from every request of the desk, the one already in its history too.
 */
export function deskWithoutCatalog(deskId: string) {
  const catalog = (message: unknown) => (message as { source?: { kind?: unknown } } | undefined)?.source?.kind === 'skill-catalog'
  return (options: { sessionId?: unknown; messages?: readonly unknown[] } | undefined, next: () => unknown): unknown => {
    if (options?.sessionId === deskId && Array.isArray(options.messages) && options.messages.some(catalog)) {
      try { (options as { messages: unknown[] }).messages = options.messages.filter(message => !catalog(message)) } catch { /* frozen: sent as it is */ }
    }
    return next()
  }
}

function say(text: string): AsyncGenerator<Record<string, unknown>> {
  return (async function* line() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}
