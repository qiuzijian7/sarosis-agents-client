// VsSaros addition (superagent v2, P2): every accepted ticket waits in person/staffing until a person agrees to its team.
import { afterEach, expect, it, vi } from 'vitest'
import { latestAssignment, ticketStage } from '../src/core/index.ts'
import { ticketCard } from '../src/app/cards.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
let clock = 0
/** A message on the ticket's thread, written now (after any proposal sent so far). */
const reply = (id: string, text: string, overrides: Record<string, unknown> = {}) =>
  feishu(id, text, { mentions: [], root_id: 'om_1', create_time: String(Date.now() + 1000 + (clock += 1000)), ...overrides })
const ONE_ROLE = { roles: [{ key: 'fix', need: '修复回归', bot: '修复 bot' }],
  steps: [{ key: 'T1', role: 'fix', title: '修复回归', spec: '定位并修复首页回归' }] }

async function staffed(options: { autoApprove?: boolean } = {}) {
  h = await startRuntime(undefined, { staffing: true })
  if (options.autoApprove) {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, autoApprove: true } })
  }
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  return { ticket: h.runtime.store.tickets.get(ticket.id)!, sessionId }
}
const propose = (ticketId: string, body: Record<string, unknown> = ONE_ROLE) =>
  h!.runTool(h!.runtime.masterId, 'orchestrator_team_propose', { ticket_id: ticketId, ...body })
const receive = async (trigger: ReturnType<typeof reply>) => { h!.runtime.receive(trigger); await h!.runtime.idle(); return trigger }

it('an accepted ticket waits for its team: no worker Session, a pending Assignment, and a card that says what comes next', async () => {
  const { ticket, sessionId } = await staffed()
  expect(ticket.team).toMatchObject({ state: 'proposing', version: 0 })
  expect(ticketStage(ticket)).toEqual({ stage: 'person', action: 'staffing' })
  expect(latestAssignment(ticket)?.state).toBe('pending')
  expect(h!.agents.has(sessionId)).toBe(false)
  expect(ticketCard(ticket)).toMatchObject({ state: 'person/staffing', team: { next: 'orchestrator_team_propose' } })
  // A person's message meanwhile waits on the ticket and still starts nothing.
  await receive(reply('2', '顺便看看标题'))
  expect(h!.agents.has(sessionId)).toBe(false)
  expect(h!.relays(h!.runtime.masterId).filter(item => item.kind === 'follow_up').at(-1))
    .toMatchObject({ note: expect.stringContaining('orchestrator_team_confirm') })
})

it('sends the proposal to the conversation and starts the worker only on a listed person\'s later agreement to the current version', async () => {
  const { ticket, sessionId } = await staffed()
  const early = await receive(reply('2', '同意'))
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(await propose(ticket.id)).toMatchObject({ version: 1, state: 'proposed', risk: { newBots: 0, writeSteps: 0 } })
  expect(h!.runtime.store.receipts.get(`team-proposal:${ticket.id}:v1`)?.text).toMatch(/【组队方案 v1】由 修复 bot（现有）处理/)
  const confirm = (triggerId: string, version: number) =>
    h!.runTool(h!.runtime.masterId, 'orchestrator_team_confirm', { ticket_id: ticket.id, trigger_id: triggerId, version })
  // Received before the proposal was sent (whatever time its Source stamped on it), by a Bot, by someone off the list: none agrees.
  expect(await confirm(early.id, 1)).toMatchObject({ refused: expect.stringContaining('before version 1') })
  const fromBot = { ...reply('3', '同意'), id: 'bot-agrees', human: false }
  await receive(fromBot)
  expect(await confirm(fromBot.id, 1)).toMatchObject({ refused: expect.stringContaining('bot') })
  const stranger = await receive(reply('4', '同意', { sender_id: 'ou_mallory' }))
  expect(await confirm(stranger.id, 1)).toMatchObject({ refused: expect.stringContaining('not on the feishu list') })
  // A person asked for a change: version 2 supersedes version 1, whose agreement no longer counts.
  const v2 = { roles: [...ONE_ROLE.roles, { key: 'test', need: '回归测试', bot: '测试 bot' }],
    steps: [...ONE_ROLE.steps, { key: 'T2', role: 'test', title: '回归测试', spec: '跑首页回归', after: ['T1'] }] }
  expect(await propose(ticket.id, v2)).toMatchObject({ version: 2 })
  expect(h!.runtime.store.receipts.get(`team-proposal:${ticket.id}:v2`)?.text).toContain('步骤：T1 修复回归 → T2 回归测试（等 T1）')
  const yes = await receive(reply('5', '同意'))
  expect(await confirm(yes.id, 1)).toMatchObject({ refused: expect.stringContaining('version 2') })
  expect(h!.agents.has(sessionId)).toBe(false)
  expect(await confirm(yes.id, 2)).toMatchObject({ version: 2, state: 'approved' })
  await h!.runtime.idle()
  const current = h!.runtime.store.tickets.get(ticket.id)!
  expect(current.team).toMatchObject({ state: 'approved', version: 2, decidedBy: 'ou_alice', triggerId: yes.id })
  expect(ticketStage(current).stage).toBe('working')
  expect(h!.agents.has(sessionId)).toBe(true)
  expect(current.inputs.some(input => input.kind === 'note' && input.text.includes('team proposal v2'))).toBe(true)
  expect(await confirm(yes.id, 2)).toMatchObject({ refused: expect.stringContaining('does not wait for its team') })
})

it('a listed person\'s refusal ends the ticket as dropped by a person, and the panel can agree for the person at this machine', async () => {
  const { ticket } = await staffed()
  await propose(ticket.id)
  const no = await receive(reply('2', '取消'))
  expect(await h!.runTool(h!.runtime.masterId, 'orchestrator_team_refuse', { ticket_id: ticket.id, trigger_id: no.id, reason: '不做了' }))
    .toMatchObject({ state: 'dropped' })
  expect(h!.runtime.store.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'human', outcome: 'dropped', reason: '不做了' })

  const second = await h!.acceptedTicket(feishu('10', '@bot 再修一个', { message_id: 'om_10' }))
  await propose(second.ticket.id)
  expect((await h!.api('GET', 'team/proposals')).body).toMatchObject({ waiting: [{ ticket: { id: second.ticket.id }, proposal: { version: 1 } }] })
  expect((await h!.api('POST', `tickets/${second.ticket.id}/team/approve`, { version: 1 })).body).toMatchObject({ state: 'approved', decidedBy: 'panel' })
  await h!.runtime.idle()
  expect(h!.agents.has(second.sessionId)).toBe(true)
})

it('creates a drafted Bot only once the team is agreed, and auto-approves only a low-risk team when a person switched it on', async () => {
  const { ticket } = await staffed()
  const created = vi.spyOn(h!.runtime.team, 'createAgreed').mockResolvedValue({ id: 'tester', name: '测试 bot', created: true })
  const draft = { id: 'tester', name: '测试 bot', persona: '你负责回归测试', tools: ['bash'] }
  expect(await propose(ticket.id, { roles: [{ key: 'test', need: '回归测试', draft }],
    steps: [{ key: 'T1', role: 'test', title: '回归测试', spec: '跑回归', access: 'write' }] }))
    .toMatchObject({ risk: { newBots: 1, writeSteps: 1, highRiskTools: ['bash'] }, state: 'proposed' })
  expect(created).not.toHaveBeenCalled()
  expect(h!.runtime.store.receipts.get(`team-proposal:${ticket.id}:v1`)?.text).toContain('测试 bot（新建 · 申请 bash）')
  const yes = await receive(reply('2', '同意'))
  await h!.runTool(h!.runtime.masterId, 'orchestrator_team_confirm', { ticket_id: ticket.id, trigger_id: yes.id, version: 1 })
  expect(created).toHaveBeenCalledWith(draft, ticket.id)
  await h!.stop(); h = undefined

  const auto = await staffed({ autoApprove: true })
  expect(await propose(auto.ticket.id)).toMatchObject({ state: 'approved' })
  expect(h!.runtime.store.receipts.get(`team-proposal:${auto.ticket.id}:v1`)?.text).toContain('已按设置自动同意')
  await h!.runtime.idle()
  expect(h!.agents.has(auto.sessionId)).toBe(true)
})

it('rejects a proposal whose steps wait in a cycle or name a missing role, and keeps auto-approval off by default', async () => {
  const { ticket } = await staffed()
  expect(h!.runtime.store.settings().executor).toMatchObject({ staffing: true, autoApprove: false })
  expect(await propose(ticket.id, { roles: ONE_ROLE.roles, steps: [
    { key: 'A', role: 'fix', title: 'a', spec: 'a', after: ['B'] }, { key: 'B', role: 'fix', title: 'b', spec: 'b', after: ['A'] }] }))
    .toMatchObject({ refused: expect.stringContaining('cycle') })
  expect(await propose(ticket.id, { roles: ONE_ROLE.roles, steps: [{ key: 'A', role: 'nobody', title: 'a', spec: 'a' }] }))
    .toMatchObject({ refused: expect.stringContaining('no role nobody') })
  expect(h!.runtime.store.tickets.get(ticket.id)?.team?.state).toBe('proposing')
})
