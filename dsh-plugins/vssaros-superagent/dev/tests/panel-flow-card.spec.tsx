// @vitest-environment jsdom
// VsSaros addition (plan C): the key-node card in the desk's DSH conversation, the Bots' marks, and the change stream.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { DeskFlow } from '../src/app/desk-flow.ts'
import { FlowCard, triggerOfResult } from '../src/client/flow-card.tsx'
import { groupRunForFlow } from '../src/client/group-runs.tsx'
import { parseFrame } from '../src/client/feed.ts'
import { lookOf } from '../src/client/characters.ts'
import { stepMarkState, toolState } from '../src/client/mark.tsx'
import { CardProvider } from '../src/client/provider.tsx'
import { zh } from '../src/client/locales.ts'
import { all, click, find, mount, settle, tab, translator, usePanel } from './fixtures/panel.tsx'
import { pushChange, server } from './fixtures/panel-server.ts'

usePanel()
const TRIGGER = 'superagent:desk:dsh-m1'
const ticket = { id: 'tk-1', title: '首页新手引导上线', stage: { stage: 'person' as const, action: 'staffing' as const } }
const proposal: NonNullable<DeskFlow['proposal']> = { version: 1, state: 'proposed', at: '2026-11-05T10:00:00.000Z',
  roles: [{ key: 'design', need: '交互稿', bot: { id: 'designer', name: '设计' } }, { key: 'qa', need: '测试', draft: { id: 'qa', name: '测试' } as never }],
  steps: [{ key: 'T1', role: 'design', title: '交互稿', spec: '', after: [], access: 'read' }, { key: 'T2', role: 'qa', title: '回归测试', spec: '', after: ['T1'], access: 'write' }],
  budget: { tokens: 300_000, turns: 90, parallel: 2 }, risk: { newBots: 1, highRiskTools: [], writeSteps: 1 } }
const team = { ticket: { id: 'tk-1', title: ticket.title, updatedAt: '2026-11-05T10:00:00.000Z' }, steps: [
  { key: 'T1', title: '交互稿', bot: '设计', botId: 'designer', access: 'read' as const, state: 'ready' as const, turns: 3, attempts: 1, after: [] },
  { key: 'T2', title: '回归测试', bot: '测试', botId: 'qa', access: 'write' as const, state: 'running' as const, turns: 1, attempts: 1, after: ['T1'],
    since: new Date().toISOString(), doing: { tool: 'pwsh', target: 'pnpm test', at: new Date().toISOString() } }] }

async function renderCard(trigger: string, receipt = false) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<CardProvider t={translator(zh)}><FlowCard triggerId={trigger} receipt={receipt} /></CardProvider>) })
  await settle()
  return { container, text: () => container.textContent ?? '', dispose: () => { act(() => { root.unmount() }); container.remove() } }
}

// VsSaros addition (2026-11-06): the desk's turn for a ticket's end shows only how it ended.
it('draws a ticket\'s end card in the desk: title, outcome, the team\'s steps and the summary, with no proposal or stop buttons', async () => {
  server.stepApprovals = []
  server.deskFlows[TRIGGER] = { trigger: undefined, state: 'ticket', approvals: [], proposal: { ...proposal, state: 'approved' },
    ticket: { ...ticket, stage: { stage: 'ended' } as never, ended: { outcome: 'completed' }, report: { state: 'ready', summary: '番茄钟 H5 已上线，测试全过。' } },
    team: { ...team, steps: team.steps.map(step => ({ ...step, state: 'ready' as const })) } }
  const card = await renderCard(TRIGGER, true)
  const root = card.container.querySelector('[data-testid="flow-card"]')
  expect(root?.getAttribute('data-receipt')).toBe('ended')
  expect(root?.getAttribute('data-outcome')).toBe('completed')
  expect(card.text()).toContain(zh['flow.receipt'].replace('{title}', ticket.title))
  expect(card.text()).toContain('番茄钟 H5 已上线，测试全过。')
  expect(card.container.querySelector('.dt-mini-flow')).not.toBeNull()
  expect(card.text()).not.toContain('组队方案 v1')
  expect(card.container.querySelectorAll('.dt-fc button')).toHaveLength(0)
  card.dispose()
  // An open ticket (resumed after its end) is drawn as the full card again.
  server.deskFlows[TRIGGER] = { trigger: undefined, state: 'ticket', approvals: [], ticket: { ...ticket, stage: { stage: 'working' } } }
  const open = await renderCard(TRIGGER, true)
  expect(open.container.querySelector('[data-receipt]')).toBeNull()
  open.dispose()
})

it('reads the trigger from the hand-over result, stream frames, and marks from what a Bot does', () => {
  expect(triggerOfResult([{ type: 'text', text: JSON.stringify({ submitted: true, result: 'stored', trigger: TRIGGER }) }])).toBe(TRIGGER)
  expect(triggerOfResult([{ type: 'text', text: 'not json' }])).toBeUndefined()
  expect(parseFrame('event: change\ndata: {"topics":["steps","bogus"]}')).toEqual(['steps'])
  expect(parseFrame(': ping')).toBeUndefined()
  expect([toolState('read'), toolState('pwsh'), toolState('orchestrator_step_report'), toolState('web_search')]).toEqual(['searching', 'working', 'sending', 'searching'])
  expect(stepMarkState({ state: 'running', approval: 'ap-1' })).toBe('alert')
  expect(stepMarkState({ state: 'running' })).toBe('thinking')
  expect(stepMarkState({ state: 'pending' })).toBe('waiting')
  // A Bot's look comes from its id, the same every time.
  expect(lookOf('designer')).toEqual(lookOf('designer'))
})

it('shows a message being evaluated, then the ticket and its proposal to agree to, live from the change stream', async () => {
  server.streaming = true
  server.deskFlows[TRIGGER] = { trigger: undefined, state: 'evaluating', approvals: [] }
  const card = await renderCard(TRIGGER)
  expect(card.text()).toContain(zh['flow.evaluating'])
  expect(card.container.querySelector('.dt-bm[data-shape="whale"]')?.getAttribute('data-state')).toBe('thinking')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(server.streams).toHaveLength(1)
  server.deskFlows[TRIGGER] = { trigger: undefined, state: 'ticket', ticket, proposal, approvals: [] }
  pushChange('tickets')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  await settle()
  expect(card.text()).toContain('首页新手引导上线')
  expect(card.text()).toContain('组队方案 v1')
  expect(card.text()).toContain('交互稿 → 回归测试')
  expect(card.text()).toContain('新建 1 个 bot · 1 个写步骤')
  expect(all('.dt-fc-node').map(node => node.getAttribute('data-state'))).toEqual(['done', 'active'])
  await click(find(zh['team.staffingAgree'], '.dt-fc button'))
  expect(server.requests.some(request => request.path === 'tickets/tk-1/team/approve' && request.method === 'POST')).toBe(true)
  card.dispose()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  // The stream closes with its last listener.
  expect(server.streams).toHaveLength(0)
})

it('shows the team at work with each Bot\'s mark and work, the requests to approve, and how the ticket ended', async () => {
  const approval = { id: 'ap-1', code: 'ab12', ticketId: 'tk-1', ticketTitle: ticket.title, step: 'T2', stepTitle: '回归测试', bot: { id: 'qa', name: '测试' },
    tool: 'pwsh', reason: '', detail: { code: 'pnpm add -D vitest' }, at: '2026-11-05T10:01:00.000Z', feishu: false, expiresAt: '2026-11-05T11:01:00.000Z' }
  server.stepApprovals = [approval]
  server.deskFlows[TRIGGER] = { trigger: undefined, state: 'ticket', ticket: { ...ticket, stage: { stage: 'working' } },
    proposal: { ...proposal, state: 'approved' }, team: { ...team, steps: [team.steps[0]!, { ...team.steps[1]!, approval: 'ap-1' }] }, approvals: [approval] }
  const card = await renderCard(TRIGGER)
  expect(card.text()).toContain('团队执行 · 1/2 完成')
  expect(card.container.querySelector('.dt-mini-flow')).not.toBeNull()
  expect(card.container.querySelector('[data-testid="step-approval"]')?.textContent).toContain('pnpm add -D vitest')
  const marks = all('.dt-members .dt-bm').map(mark => mark.getAttribute('data-state'))
  expect(marks).toEqual(['idle', 'alert'])
  expect(card.container.querySelector('.dt-members .dt-bm[data-state="alert"] .dt-bm-badge')?.textContent).toBe('?')
  await click(find(zh['work.allow'], '.dt-fc button'))
  expect(server.stepAnswers).toEqual([{ id: 'ap-1', choice: 'allow' }])
  card.dispose()
  server.deskFlows[TRIGGER] = { trigger: undefined, state: 'ticket', ticket: { ...ticket, stage: { stage: 'ended' }, ended: { outcome: 'completed' },
    report: { state: 'ready', summary: '引导上线，回归 42 例全过' } }, proposal: { ...proposal, state: 'approved' },
    team: { ...team, steps: team.steps.map(step => ({ ...step, state: 'ready' as const })) }, approvals: [] }
  const ended = await renderCard(TRIGGER)
  expect(ended.text()).toContain('结束：已完成')
  expect(ended.text()).toContain('引导上线，回归 42 例全过')
  expect(ended.container.querySelector('.dt-members')).toBeNull()
  ended.dispose()
})

it('says which ticket a later message went to, or why the supervisor did not take one', async () => {
  server.deskFlows['f'] = { trigger: undefined, state: 'ticket', followup: true, ticket, approvals: [] }
  server.deskFlows['d'] = { trigger: undefined, state: 'declined', reasons: [{ code: 'not_addressed' } as never], approvals: [] }
  const followup = await renderCard('f')
  expect(followup.text()).toContain('已转给工单「首页新手引导上线」')
  followup.dispose()
  const declined = await renderCard('d')
  expect(declined.text()).toContain(zh['flow.declined'])
  declined.dispose()
})

// 2026-11-06: a message a group chat took is recorded as ignore on purpose; the card must say where it went, not "not taken".
it('shows a message a group took as handed to that group, follows its own run live, and opens the group', async () => {
  const win = window as unknown as { __vssarosGroupProgress?: unknown }
  const run = (extra: Record<string, unknown>) => ({ callId: 'c-1', roomId: 'room-1', roomName: '番茄钟', startedAt: Date.now() - 3000, finishedAt: 0, done: false,
    replies: [], events: [], speaking: [], failed: [], passed: [], ...extra })
  // Another run in the same group, started by a different message: the card must not follow it.
  win.__vssarosGroupProgress = [run({ callId: 'c-other', sourceMessageId: 'dsh-other', status: 'done', done: true })]
  server.deskFlows[TRIGGER] = { trigger: undefined, state: 'group', approvals: [],
    group: { roomId: 'room-1', roomName: '番茄钟', kind: 'routed', sourceMessageId: 'dsh-m1' } }
  const opened: string[] = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<CardProvider t={translator(zh)} openSession={async id => { opened.push(id) }}><FlowCard triggerId={TRIGGER} /></CardProvider>)
    })
    await settle()
    const card = () => container.querySelector('[data-testid="flow-card"]')!
    expect(card().getAttribute('data-state')).toBe('group')
    expect(card().textContent).toContain('已交给群「番茄钟」')
    expect(card().textContent).not.toContain(zh['flow.declined'])
    expect(card().textContent).toContain(zh['flow.groupNote'])
    expect(card().getAttribute('data-group-run-status')).toBe('')
    await act(async () => {
      window.dispatchEvent(new CustomEvent('vssaros-group-progress', { detail: { schema: 1, active: [
        run({ callId: 'c-other', sourceMessageId: 'dsh-other', status: 'done', done: true }),
        run({ callId: 'c-mine', sourceMessageId: 'dsh-m1', status: 'replying', speaking: ['Coder'], replies: [{ name: 'Designer', text: 'ok' }] }),
      ] } }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(card().getAttribute('data-group-run-status')).toBe('replying')
    expect(card().textContent).toContain(zh['groupRuns.status.replying'])
    expect(card().textContent).toContain('1 条回复')
    await act(async () => { (container.querySelector('[data-act="open-flow-group"]') as HTMLButtonElement).click() })
    expect(opened).toEqual(['room-1'])
  } finally {
    act(() => { root.unmount() }); container.remove()
    delete win.__vssarosGroupProgress
  }
  // A ticket card for a message that also went to a group says so.
  server.deskFlows['tg'] = { trigger: undefined, state: 'ticket', ticket, proposal, approvals: [],
    group: { roomId: 'room-2', roomName: '另一群', kind: 'routed' } }
  const withTicket = await renderCard('tg')
  expect(withTicket.container.querySelector('[data-testid="flow-card-group"]')?.textContent).toContain('也交给了群「另一群」')
  withTicket.dispose()
})

it('matches a desk message to its own group run only', () => {
  const runs = [{ roomId: 'r', sourceMessageId: 'a', startedAt: 1 }, { roomId: 'r', sourceMessageId: 'b', startedAt: 2 }, { roomId: 'x', startedAt: 3 }]
  expect(groupRunForFlow(runs, { roomId: 'r', kind: 'routed', sourceMessageId: 'a' })?.sourceMessageId).toBe('a')
  expect(groupRunForFlow(runs, { roomId: 'r', kind: 'routed' })).toBeUndefined()
  expect(groupRunForFlow(runs, { roomId: 'r', kind: 'created' })?.sourceMessageId).toBe('b')
  expect(groupRunForFlow(runs, { roomId: 'none', kind: 'created' })).toBeUndefined()
})

it('reads the teams again as soon as the stream says steps changed', async () => {
  server.streaming = true
  await mount()
  await click(tab(zh['tab.work']))
  expect(document.querySelector('.dt-work')?.textContent).toContain(zh['work.empty'])
  server.teamSteps = [team]
  const before = server.requests.filter(request => request.path === 'team/steps').length
  pushChange('steps')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  await settle()
  expect(server.requests.filter(request => request.path === 'team/steps').length).toBeGreaterThan(before)
  expect(all('.dt-flow-node')).toHaveLength(2)
  expect(all('.dt-flow-node .dt-bm').map(mark => mark.getAttribute('data-state'))).toEqual(['idle', 'working'])
})
