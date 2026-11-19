import { expect, it } from 'vitest'
import { Engine, MemoryRepositories, type Policy, type Trigger } from '../src/core/index.ts'
import { poolIntakeStatus } from '../src/app/tapd-pool-status.ts'

const trigger: Trigger = { id: 't', source: 'tapd', threads: [{ source: 'tapd', id: 'bug:1' }], actor: { source: 'tapd', id: '' },
  at: '2026-11-18T08:00:00Z', human: false, addressed: 'direct', text: '修复单据', meta: { filterPool: 'p' } }
function fixture() {
  const repo = new MemoryRepositories()
  const policy: Policy = { version: 'p', paused: false, evalTimeoutMs: 120000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'followup' } }), revalidate: () => true, admitsInferred: () => true }
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: true }) },
    assessor: { request: () => {} }, executor: { start: async () => {}, deliver: async () => {}, stop: async () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  engine.receive(trigger); engine.evaluateDue()
  return { repo, engine }
}
it('separates not-consumed delivery and model errors from human approval', () => {
  const h = fixture()
  expect(poolIntakeStatus(h.repo, 't')).toMatchObject({ state: 'queued', phase: 'delivery', retryable: false })
  const errored = poolIntakeStatus(h.repo, 't', () => 'UNKNOWN_MODEL: no configured model hy3-ioa')!
  expect(errored.detail).toContain('模型未配置'); expect(errored.detail).not.toContain('审批')
  h.engine.candidateDelivered(h.engine.candidate('t')!.evalId)
  expect(poolIntakeStatus(h.repo, 't')).toMatchObject({ state: 'queued', phase: 'evaluation' })
})
it('reports timeout before ticket creation and requeues the original trigger without a second ticket', () => {
  const h = fixture(), thread = h.repo.threads.get('tapd:bug:1')!
  h.repo.threads.save({ ...thread, expired: 2, evaluating: { ...thread.evaluating!, delivered: '2000-01-01T00:00:00Z', deadline: '2000-01-01T00:00:00Z' } })
  h.engine.evaluateDue()
  expect(poolIntakeStatus(h.repo, 't')).toMatchObject({ state: 'failed', phase: 'evaluation', retryable: true })
  expect(h.engine.reevaluate('t')).toBe(true)
  expect(poolIntakeStatus(h.repo, 't')).toMatchObject({ state: 'queued', retryable: false })
  h.engine.evaluateDue()
  h.engine.decide('t', { kind: 'accept', title: '修复', scope: '单据1', reason: 'explicit', acknowledgement: 'received', name: 'fix-ticket' })
  expect(poolIntakeStatus(h.repo, 't')).toMatchObject({ state: 'processing', retryable: false })
  h.engine.reevaluate('t'); h.engine.evaluateDue()
  expect(h.repo.tickets.list()).toHaveLength(1)
})
it('does not auto retry policy ignores or mark them as completed', () => {
  const h = fixture()
  h.engine.decide('t', { kind: 'ignore', reason: 'scope rejected' })
  expect(poolIntakeStatus(h.repo, 't')).toMatchObject({ state: 'failed', phase: 'rejected', retryable: false })
})
