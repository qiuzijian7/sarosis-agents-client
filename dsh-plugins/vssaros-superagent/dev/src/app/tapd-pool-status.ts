/** Reconcile pool intake with durable decisions and tickets, including failures before a ticket was created. */
import { reasonText, threadKey, ticketStage, type Decision, type Ticket, type Trigger, type TriggerDisposition, type Thread } from '../core/index.ts'
import type { PoolIntakeStatus } from '../sources/tapd-filter-schemes.ts'
import { modelReportText } from './role-models.ts'
import { hostLegacyPoolReauthorization } from '../sources/tapd-pool-authorization.ts'
import type { Store } from './store.ts'

export interface PoolStatusStore extends Partial<Pick<Store, 'get' | 'settings'>> {
  triggers: { get(id: string): Trigger | undefined; disposition(id: string): TriggerDisposition | undefined }
  tickets: { list(): Ticket[] }
  decisions: { get(id: string): Decision | undefined }
  threads: { get(key: string): Thread | undefined }
}
export function poolIntakeStatus(store: PoolStatusStore, triggerId: string, deliveryError?: (evalId: string) => string | undefined): PoolIntakeStatus | undefined {
  const ticket = store.tickets.list().find(row => row.origin.triggerIds.includes(triggerId))
  if (ticket) {
    const stage = ticketStage(ticket)
    const ended = ticket.ended
    if (ended) return { state: ['completed', 'merged'].includes(ended.outcome) ? 'done' : 'failed', phase: 'ended', ticketId: ticket.id,
      detail: ended.reason || (ended.outcome === 'completed' && ticket.execution?.p4Delivery === 'pending' ? '已交付 pending CL；任务已结束，未提交，不等待编译、回归或审阅' : `工单已结束：${ended.outcome}`), retryable: false, at: ended.at }
    const details = { staffing: '等待批准组队方案', delivery: '工单消息投递失败', answer: '等待补充信息', review: '等待结果审阅', blocked: '执行受阻，请打开原工单处理', failed: '执行失败，请重试原工单' }
    return { state: 'processing', phase: stage.stage === 'person' ? 'person' : 'working', ticketId: ticket.id, retryable: false,
      detail: stage.stage === 'person' ? details[stage.action] : stage.stage === 'working' && stage.action === 'queued' ? '已建单，等待执行槽位' : '已建单，处理中', at: ticket.updatedAt }
  }
  const trigger = store.triggers.get(triggerId)
  if (!trigger) return undefined
  for (const ref of trigger.threads) {
    const thread = store.threads.get(threadKey(ref))
    if (thread?.evaluating?.triggerIds.includes(triggerId)) {
      const error = deliveryError?.(thread.evaluating.id)
      return { state: 'queued', phase: thread.evaluating.delivered ? 'evaluation' : 'delivery', retryable: false,
        detail: error ? modelReportText(error) : thread.evaluating.delivered ? '主管已收到候选，评估中' : '等待主管消费候选，尚未开始评估计时' }
    }
    if (thread?.pending.includes(triggerId)) return { state: 'queued', phase: 'evaluation', retryable: false, detail: '等待重新评估' }
  }
  const disposition = store.triggers.disposition(triggerId)
  if (disposition?.filtered) return { state: 'failed', phase: 'rejected', detail: reasonText([disposition.filtered]), retryable: false, at: disposition.at }
  const decision = disposition?.decisionId && store.decisions.get(disposition.decisionId)
  if (!decision) return { state: 'queued', phase: 'evaluation', retryable: false, detail: '已接收，等待主管评估' }
  if (decision.kind === 'unavailable') return { state: 'failed', phase: 'evaluation', detail: `评估不可用：${reasonText(decision.reason)}；可重新执行以重评原任务`, retryable: true, at: decision.at }
  if (decision.kind === 'ignore' && decision.strength === 'explicit' && !disposition?.fanout.length && store.get && store.settings
    && hostLegacyPoolReauthorization({ get: key => store.get!(key), settings: () => store.settings!() }, trigger))
    return { state: 'failed', phase: 'rejected', retryable: true, at: decision.at,
      detail: '旧版候选缺少修复授权说明；可点击开始执行重新确认并重评原任务，不会自动重派' }
  return { state: 'failed', phase: 'rejected', detail: decision.kind === 'accept' ? '已接单但关联工单缺失，请检查状态一致性' : `未接单：${reasonText(decision.reason)}`, retryable: false, at: decision.at }
}
