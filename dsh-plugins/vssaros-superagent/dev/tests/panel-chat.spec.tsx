// @vitest-environment jsdom
// VsSaros addition: the Chat tab (the supervisor desk) and the side panel with the Overview.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { ChatDock, waitingProposal } from '../src/client/chat.tsx'
import { CardProvider } from '../src/client/provider.tsx'
import { WorkProvider } from '../src/client/work.tsx'
import { workSignatures } from '../src/client/side.tsx'
import { all, click, find, mount, remount, settle, tab, text, translator, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const proposalText = '【组队方案 v1】首页新手引导上线\n成员：设计 bot（现有）、测试 bot（现有）\n回复「同意」开始执行'
const proposal = { ticket: { id: 'tk-1', title: '首页新手引导上线', state: 'proposed' }, proposal: { ticketId: 'tk-1', version: 1,
  fingerprint: 'sha256:x', goal: '首页新手引导上线', roles: [{ key: 'design', need: '交互稿', bot: { id: 'designer', name: '设计 bot' } }],
  steps: [{ key: 'T1', role: 'design', title: '交互稿', spec: '出稿', after: [], access: 'read' as const }],
  budget: { tokens: 300_000, turns: 90, parallel: 3 }, risk: { newBots: 0, highRiskTools: [], writeSteps: 0 }, state: 'proposed' as const,
  at: '2026-11-05T10:03:00.000Z' } }
const composer = () => document.querySelector<HTMLTextAreaElement>('.dt-composer-input')!

it('opens on the Chat tab with the Overview in the side panel, and the header opens the panel and toggles it', async () => {
  // A first visit: nothing remembered, so the side panel is open.
  localStorage.clear()
  await mount()
  expect(tab(zh['tab.chat']).getAttribute('aria-selected')).toBe('true')
  expect(all('[role="tab"]').map(item => item.textContent)).toEqual(['对话', '工作台', '来源', '触发', '评估', '执行', '设置'])
  expect(text()).toContain(zh['chat.empty'])
  const side = () => document.querySelector('.dt-side')
  expect(side()?.textContent).toContain(zh.pendingTickets)
  // The header button that opened the main Session now opens the overview panel; the main Session opens from the panel's strip.
  expect(all('.dt-head button').some(button => button.textContent === zh.openMaster)).toBe(false)
  await click(find(zh.openMaster, '.dt-side button'))
  expect(server.opened).toEqual(['master'])
  await click(find(zh['side.close'], '.dt-side button'))
  expect(side()).toBeNull()
  await click(zh.openOverview)
  expect(side()).not.toBeNull()
  await click(find(zh['side.close'], '.dt-head button'))
  expect(side()).toBeNull()
  expect(find(zh['side.open'], '.dt-head button').getAttribute('aria-pressed')).toBe('false')
  // The panel stays closed across loads, and keeps its width.
  await remount()
  expect(side()).toBeNull()
  localStorage.setItem('dsh-superagent/side', JSON.stringify({ open: true, width: 999 }))
  await remount()
  expect(side()?.getAttribute('style')).toContain('--dt-side-width: 560px')
})

it('shows the desk conversation and sends a message to the supervisor, with quick replies on the proposal that waits', async () => {
  server.deskMessages = [
    { id: 'p1', role: 'person', text: '帮我看下飞书群', at: '2026-11-05T09:12:00.000Z', filtered: { code: 'superagent_desk_off' } },
    { id: 'p2', role: 'person', text: '首页新手引导要上线', at: '2026-11-05T10:02:00.000Z' },
    { id: 'r1', role: 'superagent', text: '已接单：「首页新手引导上线」。', at: '2026-11-05T10:02:30.000Z', kind: 'acknowledgement' },
    { id: 'r2', role: 'superagent', text: proposalText, at: '2026-11-05T10:03:00.000Z', kind: 'notice', ticketId: 'tk-1' },
  ]
  await mount()
  expect(all('.dt-msg-bubble').map(item => item.textContent)).toEqual(['帮我看下飞书群', '首页新手引导要上线'])
  expect(text()).toContain(zh['chat.notHanded'].replace('{reason}', zh['reason.superagent_desk_off']))
  expect(all('.dt-msg-text').map(item => item.textContent)).toEqual(['已接单：「首页新手引导上线」。', proposalText])
  await click(zh['chat.agree'])
  expect(server.deskSent).toEqual(['同意'])
  // Once the person answered, the proposal no longer offers quick replies.
  expect(all('.dt-msg-actions')).toHaveLength(0)
  await type(composer(), '  顺便把截图也附上  ')
  await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
  expect(server.deskSent).toEqual(['同意', '顺便把截图也附上'])
  expect(composer().value).toBe('')
  // Shift+Enter is a new line, not a send.
  await type(composer(), '第一行')
  await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })) })
  await settle()
  expect(server.deskSent).toHaveLength(2)
})

it('replicates DS Bot send UI: optimistic bubble, usable composer, and an honest note for messages still on their way', async () => {
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  server.deskSendHold = hold
  try {
    await mount()
    await type(composer(), '第一条任务')
    await act(async () => {
      composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    const locals = () => all('[data-testid="local-submission"]')
    expect(locals()).toHaveLength(1)
    expect(locals()[0]!.textContent).toContain('第一条任务')
    expect(locals()[0]!.getAttribute('data-placement')).toBe('transcript')
    expect(composer().value).toBe('')
    expect(document.querySelector('[data-testid="chat-activity"]')).not.toBeNull()
    // DS Bot keeps the composer usable while a turn runs.
    await type(composer(), '第二条任务')
    expect(document.querySelector('.dt-composer-send')?.hasAttribute('disabled')).toBe(false)
    await click(find(zh['chat.send']))
    await act(async () => { await Promise.resolve() })
    expect(locals()).toHaveLength(2)
    expect(locals()[1]!.getAttribute('data-placement')).toBe('queued')
    expect(locals()[1]!.textContent).toContain(zh['chat.queued'])
    expect(document.querySelector('[data-testid="composer-queue-note"]')?.textContent).toContain('自动并入当前回合')
    // The server already relays every message into the supervisor's running turn, so an empty Enter has nothing to do:
    // it neither sends an empty message nor relabels a bubble as if it had steered.
    await act(async () => {
      composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(locals()).toHaveLength(2)
    expect(locals().map(item => item.getAttribute('data-placement'))).toEqual(['transcript', 'queued'])
    release()
    server.deskSendHold = undefined
    await settle()
    expect(server.deskSent).toEqual(['第一条任务', '第二条任务'])
    expect(locals()).toHaveLength(0)
  } finally {
    release()
    server.deskSendHold = undefined
  }
})

it('finds the proposal that still waits for the person', () => {
  const at = '2026-11-05T10:00:00.000Z'
  expect(waitingProposal([{ id: 'a', role: 'superagent', text: proposalText, at }])).toBe('a')
  expect(waitingProposal([{ id: 'a', role: 'superagent', text: proposalText, at }, { id: 'b', role: 'person', text: '同意', at }])).toBeUndefined()
  expect(waitingProposal([{ id: 'a', role: 'superagent', text: proposalText, at }, { id: 'c', role: 'superagent', text: '收到', at }])).toBe('a')
  expect(waitingProposal([{ id: 'c', role: 'superagent', text: '收到', at }])).toBeUndefined()
})

it('opens the side panel by itself when the supervisor starts new work, but not for work it already showed', async () => {
  expect(workSignatures([proposal], [{ ticket: { id: 'tk-2' } }])).toEqual(['proposal:tk-1:v1', 'steps:tk-2'])
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    await mount()
    expect(document.querySelector('.dt-side')).toBeNull()
    // A new team proposal: the panel opens and says why.
    server.proposals = [proposal]
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
    await settle()
    expect(document.querySelector('.dt-side')).not.toBeNull()
    expect(document.querySelector('.dt-toast')?.textContent).toBe(zh['side.autoOpened'])
    // Closed by hand, the same work does not open it again.
    await click(find(zh['side.close'], '.dt-side button'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
    await settle()
    expect(document.querySelector('.dt-side')).toBeNull()
    // A team ticket whose steps begin is new work.
    server.teamSteps = [{ ticket: { id: 'tk-1', title: '首页新手引导上线', updatedAt: '2026-11-05T10:05:00.000Z' }, steps: [] }]
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
    await settle()
    expect(document.querySelector('.dt-side')).not.toBeNull()
    // Reloading the panel is not news: the work it already showed does not open it.
    await click(find(zh['side.close'], '.dt-side button'))
    await remount()
    expect(document.querySelector('.dt-side')).toBeNull()
  } finally { vi.useRealTimers() }
})

// VsSaros fix (2026-11-05): above the desk's DSH conversation, what waits for the person, whatever the desk's model says.
it('shows a team waiting for the person above the desk\'s conversation, and agrees to it from there', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const t = translator(zh)
  await act(async () => { root.render(<CardProvider t={t}><WorkProvider><ChatDock /></WorkProvider></CardProvider>) })
  await settle()
  expect(host.querySelector('[data-testid="chat-dock"]')).toBeNull()
  server.proposals = [proposal]
  await act(async () => { root.render(<CardProvider t={t}><WorkProvider key="again"><ChatDock /></WorkProvider></CardProvider>) })
  await settle()
  const dock = host.querySelector<HTMLElement>('[data-testid="chat-dock"]')!
  expect(dock.textContent).toContain(zh['chat.dock'])
  expect(dock.textContent).toContain(proposal.ticket.title)
  await act(async () => { [...dock.querySelectorAll('button')].find(button => button.textContent === zh['team.staffingAgree'])!.click() })
  await settle()
  expect(server.approvedTeam).toEqual({ ticketId: proposal.ticket.id, version: proposal.proposal!.version })
  act(() => { root.unmount() })
  host.remove()
})
