// VsSaros addition (superagent v2, P4): finished team steps' evidence handed to the VsSaros memory system.
import { afterEach, expect, it, vi } from 'vitest'
import { distillMode, MEMORY_BUS_KEY, type MemoryBus, type StepEvidence } from '../src/app/distill.ts'
import { stepSessionId } from '../src/app/steps.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'

let h: Host | undefined
const root = globalThis as unknown as Record<symbol, unknown>
afterEach(async () => { await h?.stop(); h = undefined; delete root[MEMORY_BUS_KEY] })

/** A memory bus as @vssaros/dsh-agents provides it, recording what it was given. */
function fakeBus(options: { available?: boolean; fail?: number } = {}) {
  const given: StepEvidence[] = []
  let failures = options.fail ?? 0
  const bus = {
    version: 1, available: vi.fn(() => options.available ?? true),
    rememberStep: vi.fn(async (evidence: StepEvidence) => {
      if (failures > 0) { failures -= 1; throw Object.assign(new Error('bot memory is being written'), { status: 409 }) }
      given.push(evidence)
      return { fact: { ok: true, message: '已追加' }, ...evidence.mode === 'skill'
        ? { skill: { name: `bot-${evidence.botId}-abcd1234`, path: '/x/SKILL.md', created: true, state: 'draft' as const } } : {} }
    }),
    decideSkillDraft: vi.fn(async (name: string, decision: 'approve' | 'reject') => ({ name, state: decision === 'approve' ? 'active' : 'rejected' })),
  } satisfies MemoryBus
  root[MEMORY_BUS_KEY] = bus
  return { bus, given, set available(value: boolean) { options.available = value } }
}
let clock = 0
const reply = (id: string, text: string) => feishu(id, text, { mentions: [], root_id: 'om_1', create_time: String(Date.now() + 1000 + (clock += 1000)) })
const TEAM = { roles: [{ key: 'design', need: '交互稿', bot: 'designer' }, { key: 'test', need: '回归测试', bot: 'tester' }],
  steps: [{ key: 'T1', role: 'design', title: '交互稿', spec: '出 5 屏' }, { key: 'T2', role: 'test', title: '回归测试', spec: '跑回归' }] }
async function agreed() {
  h = await startRuntime(undefined, { staffing: true })
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 首页新手引导要上线'))
  await h.runTool(h.runtime.masterId, 'orchestrator_team_propose', { ticket_id: ticket.id, ...TEAM })
  await new Promise(resolve => setTimeout(resolve, 5))
  const yes = reply('2', '同意'); h.runtime.receive(yes); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_team_confirm', { ticket_id: ticket.id, trigger_id: yes.id, version: 1 })
  await h.runtime.idle()
  await waitUntil(() => h!.runtime.steps.tables.get(ticket.id, 'T2')?.state === 'running')
  return ticket.id
}
const report = (ticketId: string, key: string, state: string, summary: string) =>
  h!.runTool(stepSessionId(ticketId, key), 'orchestrator_step_report', { state, summary })

it('distills a step that took 3 turns, failed or was given again, and only records facts of any other', () => {
  expect(distillMode({ turns: 2, failures: [], attempts: 1 })).toEqual({ mode: 'facts', reasons: [] })
  expect(distillMode({ turns: 3, failures: [], attempts: 1 })).toEqual({ mode: 'skill', reasons: ['3 turns'] })
  expect(distillMode({ turns: 1, failures: ['x'], attempts: 2 })).toEqual({ mode: 'skill', reasons: ['1 failed attempt(s)', 'given 2 times'] })
})

it('hands each finished step\'s evidence to the memory system once, as facts or as a skill by the thresholds', async () => {
  const { given } = fakeBus()
  const ticketId = await agreed()
  await report(ticketId, 'T1', 'ready', '交互稿 5 屏')
  await report(ticketId, 'T2', 'failed', '选择器超时')
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.attempts === 2)
  await report(ticketId, 'T2', 'ready', '换成 data-testid 后通过')
  await waitUntil(() => given.length === 2)
  expect(given.map(item => [item.stepKey, item.mode, item.botId, item.outcome])).toEqual([['T1', 'facts', 'designer', 'ready'], ['T2', 'skill', 'tester', 'ready']])
  expect(given[1]).toMatchObject({ attempts: 2, failures: ['选择器超时'], report: '换成 data-testid 后通过', request: '@bot 首页新手引导要上线',
    ticketTitle: expect.any(String), stepTitle: '回归测试', spec: '跑回归' })
  const records = h!.runtime.distiller.list()
  expect(records.map(item => [item.stepKey, item.state, item.mode])).toEqual(expect.arrayContaining([['T1', 'sent', 'facts'], ['T2', 'sent', 'skill']]))
  expect(records.find(item => item.stepKey === 'T2')!.reasons).toEqual(['1 failed attempt(s)', 'given 2 times'])
  // A step ended again (as after a restart) is not handed over twice.
  await h!.runtime.distiller.stepEnded(h!.runtime.steps.tables.get(ticketId, 'T1')!)
  expect(given).toHaveLength(2)
})

it('keeps evidence the memory system cannot take yet and delivers it later; a stopped ticket\'s unfinished steps leave none', async () => {
  const memory = fakeBus({ available: false })
  const ticketId = await agreed()
  await report(ticketId, 'T1', 'ready', '交互稿 5 屏')
  await waitUntil(() => h!.runtime.distiller.list().length === 1)
  expect(h!.runtime.distiller.list()[0]).toMatchObject({ state: 'pending', attempts: 0 })
  memory.available = true
  memory.bus.rememberStep.mockImplementationOnce(async () => { throw new Error('bot memory is being written') })
  await h!.runtime.distiller.deliverPending()
  expect(h!.runtime.distiller.list()[0]).toMatchObject({ state: 'pending', attempts: 1, error: 'bot memory is being written' })
  await h!.runtime.distiller.deliverPending()
  expect(h!.runtime.distiller.list()[0]).toMatchObject({ state: 'sent', attempts: 2 })
  h!.runtime.engine.stopTicket(ticketId, '不做了')
  await h!.runtime.idle()
  expect(h!.runtime.distiller.list().map(item => item.stepKey)).toEqual(['T1'])
})

it('relays a person\'s decision on a skill draft to the memory system, from the panel', async () => {
  const { bus } = fakeBus()
  const ticketId = await agreed()
  await report(ticketId, 'T2', 'failed', '选择器超时')
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.attempts === 2)
  await report(ticketId, 'T2', 'ready', '通过')
  await waitUntil(() => h!.runtime.distiller.list().some(item => item.result?.skill))
  const id = `distill:${ticketId}:T2`
  expect((await h!.api('GET', 'team/distills')).body).toMatchObject({ distills: [{ id, result: { skill: { state: 'draft' } } }] })
  expect((await h!.api('POST', `team/distills/${id}/approve`)).body).toMatchObject({ result: { skill: { state: 'active' } } })
  expect(bus.decideSkillDraft).toHaveBeenCalledWith('bot-tester-abcd1234', 'approve')
  expect((await h!.api('POST', `team/distills/${id}/reject`)).status).toBeGreaterThanOrEqual(400)
})
