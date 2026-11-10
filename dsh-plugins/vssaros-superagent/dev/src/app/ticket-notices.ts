/**
 * ★ 2026-11-10（用户）：飞书发来的任务结束后，把结果发回飞书。
 *
 * 为什么放在 app 层而不是 core 的 Tickets.end()：core 不该知道 IM 文案与渠道白名单；
 * desk 的结束通知（desk.ts ticketEndedNotice）与 GitHub/P4 的终态通知也都在 runtime 的
 * `ticket.ended` 分支里发。这里只补 `feishu` 渠道 —— github / p4 各有更精确的终态通知
 * （pullEndNotices / changeEndNotices），重复发会刷两条。
 *
 * id 里带 `ended.at`，所以同一工单被复活后再次结束会再通知一次；同一 id 重复 send 由
 * Outbox 的 receipts 幂等吞掉。
 */
import type { OutboundMessage, Ticket } from '../core/index.ts'
import { receiptView } from './desk.ts'

/** The notice id prefix of a ticket's result sent back to its IM conversation. */
export const TICKET_RESULT_NOTICE = 'ticket-result'
const FEISHU = 'feishu'

/** The result line for one ended ticket: title, outcome and the worker's report summary (else the reason). */
export function ticketResultText(ticket: Ticket): string | undefined {
  const view = receiptView(ticket)
  if (!view) { return undefined }
  return `【工单结束】「${view.title}」${view.outcomeText}${view.summary ? `：${view.summary}` : '。'}`
}

/** One notice per Feishu conversation the ticket reached; empty for tickets that never touched Feishu. */
export function ticketResultNotices(ticket: Ticket): OutboundMessage[] {
  const view = receiptView(ticket)
  const text = ticketResultText(ticket)
  if (!view || !text) { return [] }
  return (ticket.channels ?? [])
    .filter(channel => channel.source === FEISHU)
    .map(channel => ({
      id: `${TICKET_RESULT_NOTICE}:${ticket.id}:${view.at}:${channel.thread}`,
      channel, kind: 'notice' as const, ticketId: ticket.id, text,
    }))
}
