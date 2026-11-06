/**
 * VsSaros addition (plan C): where one message to the supervisor desk stands, for the card that shows it in the desk's own
 * (DSH) conversation: received, evaluated, declined or taken as a ticket; the ticket's team proposal while it waits for the
 * person; its team at work, with the requests that wait for the person; and how it ended. A message that reached a ticket
 * another message started says only which ticket it went to: the card of the message that started it holds the rest.
 */
import { latestAssignment, ticketStage, type Reason, type TicketStage } from '../core/index.ts'
import type { GroupRoute, GroupRouteKind } from './group-routes.ts'
import type { StaffingProposal } from './staffing.ts'
import type { StepApprovalView } from './step-approvals.ts'
import type { StepsView } from './steps.ts'
import type { Store } from './store.ts'

/** The group chat a desk message went to (VsSaros addition, 2026-11-06); the card follows the group's live run with it. */
export interface DeskFlowGroup { roomId: string; roomName: string; kind: GroupRouteKind; sourceMessageId?: string }

export interface DeskFlow {
  trigger: { id: string; text: string; at: string } | undefined
  /**
   * `unknown`: not received (yet); `filtered`: the desk Source is off; `declined`: Eval decided not to take it;
   * `group`: a group chat took it (made for it, or an `@group` command) — the supervisor stays out of it on purpose.
   */
  state: 'unknown' | 'filtered' | 'evaluating' | 'declined' | 'ticket' | 'group'
  /** Set with `group`, and on a ticket card when the same message also went to a group. */
  group?: DeskFlowGroup
  reasons?: Reason[]
  /** The decision was `unavailable`: Eval could not decide, and tries again. */
  unavailable?: true
  /** It reached a ticket another message started. */
  followup?: true
  ticket?: {
    id: string; title: string; stage: TicketStage
    ended?: { outcome: string; reason?: string | undefined }
    report?: { state: string; summary: string }
  }
  proposal?: Pick<StaffingProposal, 'version' | 'state' | 'roles' | 'steps' | 'budget' | 'risk' | 'at'>
  team?: StepsView
  approvals: StepApprovalView[]
}

export interface DeskFlowHost {
  store: Pick<Store, 'triggers' | 'tickets' | 'decisions'>
  proposal(ticketId: string): StaffingProposal | undefined
  team(ticketId: string): StepsView | undefined
  approvals(): StepApprovalView[]
  /** Which group chat the message went to, if any. */
  route?(triggerId: string): GroupRoute | undefined
}

/** Where the message `triggerId` stands now. */
export function deskFlow(host: DeskFlowHost, triggerId: string): DeskFlow {
  const { store } = host
  const trigger = store.triggers.get(triggerId)
  const disposition = store.triggers.disposition(triggerId)
  const base = { trigger: trigger && { id: trigger.id, text: trigger.text.slice(0, 400), at: trigger.at }, approvals: [] as StepApprovalView[] }
  const route = host.route?.(triggerId)
  const group: DeskFlowGroup | undefined = route && { roomId: route.roomId, roomName: route.roomName, kind: route.kind,
    ...route.sourceMessageId ? { sourceMessageId: route.sourceMessageId } : {} }
  const decision = disposition?.decisionId ? store.decisions.get(disposition.decisionId) : undefined
  const ticketId = disposition ? decision?.ticketId ?? disposition.fanout[0] : undefined
  const ticket = ticketId ? store.tickets.get(ticketId) : undefined
  // A group took it and no ticket did: show the group, not a refusal (the ignore decision is deliberate).
  if (group && !ticket) return { ...base, state: 'group', group }
  if (!disposition) return { ...base, state: 'unknown' }
  if (disposition.filtered) return { ...base, state: 'filtered', reasons: [disposition.filtered] }
  if (!ticket) {
    if (!decision) return { ...base, state: 'evaluating' }
    return { ...base, state: decision.kind === 'unavailable' ? 'evaluating' : 'declined', reasons: decision.reason,
      ...decision.kind === 'unavailable' ? { unavailable: true as const } : {} }
  }
  const report = latestAssignment(ticket)?.report
  const summary = { id: ticket.id, title: ticket.title, stage: ticketStage(ticket),
    ...ticket.ended ? { ended: { outcome: ticket.ended.outcome, reason: ticket.ended.reason } } : {},
    ...report ? { report: { state: report.state, summary: report.summary.slice(0, 600) } } : {} }
  if (ticket.origin.triggerId !== triggerId) return { ...base, state: 'ticket', followup: true, ticket: summary, ...group ? { group } : {} }
  const proposal = host.proposal(ticket.id)
  const team = host.team(ticket.id)
  return { ...base, state: 'ticket', ticket: summary, ...group ? { group } : {},
    ...proposal ? { proposal: { version: proposal.version, state: proposal.state, roles: proposal.roles, steps: proposal.steps,
      budget: proposal.budget, risk: proposal.risk, at: proposal.at } } : {},
    ...team ? { team } : {},
    approvals: host.approvals().filter(item => item.ticketId === ticket.id) }
}
