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
 *
 * ★ 2026-11-16（日志）：终态报告本身也要通知。工单可能因等待人工审核/提交而不结束
 * （真实事故：report ready 后停在 `stage=person/review`，`ticket.ended` 永不触发，飞书
 * 一条状态都没有）。ticketStatusNotices 由 Host 在 `assignment.reported` 直接发，不依赖
 * 主会话模型是否决定外发，也不与 ticketResultNotices 重复（已结束工单跳过）。
 */
import { latestReport, type OutboundMessage, type Ticket } from '../core/index.ts'
import { IM_WORDS, wordCount } from '../infra/text.ts'
import { receiptView } from './desk.ts'

/** The notice id prefix of a ticket's result sent back to its IM conversation. */
export const TICKET_RESULT_NOTICE = 'ticket-result'
const FEISHU = 'feishu'

/** Clip to the IM word budget; never split a notice into multiple messages (infra/text.ts). */
const withinImWords = (text: string): string => {
  if (wordCount(text) <= IM_WORDS) { return text }
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (wordCount(`${text.slice(0, mid)}…`) <= IM_WORDS) { lo = mid } else { hi = mid - 1 }
  }
  return `${text.slice(0, lo)}…`
}

/** The result line for one ended ticket: title, outcome and the worker's report summary (else the reason). */
export function ticketResultText(ticket: Ticket): string | undefined {
  const view = receiptView(ticket)
  if (!view) { return undefined }
  return withinImWords(`【工单结束】「${view.title}」${view.outcomeText}${view.summary ? `：${view.summary}` : '。'}`)
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

/** Notice id prefix of a terminal worker report sent back to the IM conversation while the ticket is still open. */
export const TICKET_STATUS_NOTICE = 'ticket-status'
/** Reports that mean the worker has stopped with a result; `progress`/`waiting` are not terminal. */
const TERMINAL_STATES: Record<string, string> = { ready: '修复完成', blocked: '处理受阻', failed: '执行失败', dropped: '无需处理' }

/**
 * A deterministic status notice for a terminal worker report on a ticket that has not ended. This is the
 * missing half of `ticketResultNotices`: a `ready` report may leave a ticket waiting for a person's CL
 * review or submit, so `ticket.ended` never fires and the Feishu conversation hears nothing. Only the
 * Host sends this — the main Session's relay is a steering notice, not a guaranteed IM delivery.
 */
export function ticketStatusText(ticket: Ticket): string | undefined {
  // A blocked report that asks the person a question already has its own attention message; do not double it.
  if (ticket.ended || ticket.attention) return undefined
  const report = latestReport(ticket)
  const label = report && TERMINAL_STATES[report.state]
  if (!label) return undefined
  return withinImWords(`【${label}】「${ticket.title}」${report.summary ? `：${report.summary}` : '。'}`)
}

/** One notice per Feishu conversation; the report's `at` makes the id stable across repeated events. */
export function ticketStatusNotices(ticket: Ticket): OutboundMessage[] {
  const report = latestReport(ticket)
  const text = ticketStatusText(ticket)
  if (!report || !text) return []
  return (ticket.channels ?? [])
    .filter(channel => channel.source === FEISHU)
    .map(channel => ({
      id: `${TICKET_STATUS_NOTICE}:${ticket.id}:${report.at}:${channel.thread}`,
      channel, kind: 'notice' as const, ticketId: ticket.id, text,
    }))
}
