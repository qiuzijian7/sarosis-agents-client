/**
 * VsSaros addition (2026-11-07, user request「@群 时也同时建一张工单，群聊做完把结果回写到工单」).
 *
 * A desk message `@已有群 …` used to be recorded as `ignore` and left entirely to the Bots plugin's group chat, so SuperAgent
 * never knew whether the work finished. Now the same intake accepts it as a ticket that the group runs (`Ticket.group`): no
 * worker starts, no Thread is followed, and the group's state is checked here, from the Bots plugin's `groupState`, until it
 * settles. Then the ticket gets the report a worker would have given: `ready` (ends it, with the group's last replies or its
 * goal's summary), `waiting` (the group waits for the person: a choice card, or a goal that is not done), or `dropped`
 * (the group was deleted, or its goal was stopped).
 *
 * "Settled" is the Bots plugin's `idle` (no round running, no member working in the background, nothing queued, no
 * approval waiting) for at least `GROUP_SETTLE_MS`, and a member said something since the ticket began: a message that has
 * not reached the group yet leaves nothing to report.
 */
import type { Ticket } from '../core/index.ts'

/** How long the group must have been still before its state is taken as the ticket's result. */
export const GROUP_SETTLE_MS = 5000
/** How often open group tickets are checked. */
export const GROUP_CHECK_MS = 10_000
/** The summary's length limit; the desk notice and the flow card shorten it further. */
const SUMMARY_LIMIT = 1800

/** One line of the group's log, as the Bots plugin gives it. */
export interface GroupLogLine { at: number; who: string; botId?: string; kind?: string; late?: boolean; text: string }
/** What the Bots plugin tells about a group (`TeamBus.groupState`, vssaros-agents 0.2.355+). */
export interface GroupState {
  roomId: string
  roomName?: string
  /** The group was deleted. */
  missing?: true
  idle?: boolean
  /** When the group last did something (its last log line, or its latest round's start or end). */
  activeAt?: number
  asks?: { name: string; botId?: string; at: number; headline: string; questions: number }[]
  goal?: { title: string; status: 'active' | 'paused' | 'complete' | 'stopped'; idle: boolean; summary: string; completedAt?: number; updatedAt?: number } | null
  log?: GroupLogLine[]
}
export interface GroupReport { state: 'ready' | 'waiting' | 'dropped'; summary: string }

const clip = (text: string, limit = SUMMARY_LIMIT) => text.length > limit ? `${text.slice(0, limit)}…` : text
const since = (ticket: Pick<Ticket, 'createdAt'>) => Date.parse(ticket.createdAt) || 0

/**
 * The report a group ticket gets from its group's state, or none while the group works or has not started on it.
 * Pure: the runtime compares it with the ticket's latest report and only writes a change.
 */
export function groupTicketReport(ticket: Pick<Ticket, 'createdAt' | 'group'>, state: GroupState | undefined, now: number): GroupReport | undefined {
  const name = state?.roomName || ticket.group?.roomName || '群聊'
  if (!state) return undefined
  if (state.missing) return { state: 'dropped', summary: `群「${name}」已经删除，这张工单没有结果。` }
  if (!state.idle) return undefined
  if (state.activeAt && now - state.activeAt < GROUP_SETTLE_MS) return undefined
  const from = since(ticket)
  const lines = (state.log ?? []).filter(line => line.at >= from && line.who !== '用户' && line.kind !== 'ask-answer' && line.text?.trim())
  const goal = state.goal
  const goalChanged = !!goal && (goal.updatedAt ?? 0) >= from
  if (!lines.length && !goalChanged) return undefined
  const asks = (state.asks ?? []).filter(ask => ask.at >= from || lines.length)
  if (asks.length) {
    return { state: 'waiting', summary: `群「${name}」等你在群里选择：${asks.map(ask => `${ask.name}（${ask.headline}）`).join('；')}` }
  }
  if (goal && goalChanged && goal.status === 'complete') {
    return { state: 'ready', summary: clip(`群「${name}」完成了目标「${goal.title}」${goal.summary ? `：${goal.summary}` : '。'}`) }
  }
  if (goal && goalChanged && goal.status === 'stopped') return { state: 'dropped', summary: `群「${name}」停止了目标「${goal.title}」。` }
  if (goal && (goal.status === 'active' || goal.status === 'paused')) {
    return { state: 'waiting', summary: `群「${name}」的目标「${goal.title}」还没完成，在等你在群里回复。` }
  }
  const last = lines.filter(line => line.kind !== 'ask').slice(-2).map(line => `${line.who}：${line.text.trim()}`)
  if (!last.length) return undefined
  return { state: 'ready', summary: clip(`群「${name}」这次的结果（${lines.length} 条回复）：\n\n${last.join('\n\n')}`) }
}

/** The ticket title for a message to a group: the message without the `@群名` it starts with. */
export function groupTicketTitle(text: string, roomName: string): string {
  const escaped = roomName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = String(text ?? '').trim()
    .replace(new RegExp(`^@\\[${escaped}\\]\\([^)]*\\)`), '')
    .replace(new RegExp(`^@\\[?${escaped}\\]?`), '')
    .trim()
  const title = body || String(text ?? '').trim()
  return title.length > 80 ? `${title.slice(0, 80)}…` : title
}
