// @vitest-environment jsdom
// VsSaros addition (superagent runtime UI, plan C): what waits for the person in the side panel, the teams' members, and
// the Workbench tab's flow, board and list.
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { elapsedLabel, layoutSteps } from '../src/client/work.tsx'
import { AGENTS_ROOMS_ACTIVE, groupRoundStatus, groupRunSource, groupRunsConfig, normalizeGroupRuns } from '../src/client/group-runs.tsx'
import { all, at, click, find, mount, settle, tab, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import type { StepsView } from '../src/app/steps.ts'

usePanel()
const team = (): StepsView => ({ ticket: { id: 'tk-1', title: '首页新手引导上线', updatedAt: '2026-11-05T10:00:00.000Z' }, steps: [
  { key: 'T1', title: '交互稿', bot: '设计', botId: 'designer', access: 'read', state: 'ready', turns: 3, attempts: 1, after: [], report: '5 屏' },
  { key: 'T2', title: '实现浮层', bot: '前端', botId: 'frontend', access: 'write', state: 'running', turns: 2, attempts: 1, after: ['T1'],
    since: new Date().toISOString(), approval: 'ap-1' },
  { key: 'T3', title: '文案埋点', bot: '产品', botId: 'pm', access: 'read', state: 'running', turns: 1, attempts: 1, after: ['T1'],
    since: new Date().toISOString(), doing: { tool: 'grep', target: 'analytics', at: new Date().toISOString() } },
  { key: 'T4', title: '回归测试', bot: '测试', botId: 'qa', access: 'write', state: 'pending', turns: 0, attempts: 2, after: ['T2', 'T3'],
    failures: ['跳过按钮在 4K 下被遮挡'] }] })
const approval = { id: 'ap-1', code: 'ab12', ticketId: 'tk-1', ticketTitle: '首页新手引导上线', step: 'T2', stepTitle: '实现浮层',
  bot: { id: 'frontend', name: '前端' }, tool: 'pwsh', reason: 'escalate sandbox', detail: { code: 'pnpm add -D @floating-ui/react', text: '装浮层依赖' },
  at: '2026-11-05T10:01:00.000Z', feishu: true, expiresAt: '2026-11-05T11:01:00.000Z', restored: true as const }

it('lays a team out by its dependencies and counts time as DeepSeek-Bot does', () => {
  expect(Object.fromEntries(layoutSteps(team().steps))).toEqual({ T1: { col: 0, row: 0 }, T2: { col: 1, row: 0 }, T3: { col: 1, row: 1 }, T4: { col: 2, row: 0 } })
  const now = Date.parse('2026-11-05T10:00:00Z')
  expect([5_000, 125_000, 3_725_000].map(ms => elapsedLabel(new Date(now - ms).toISOString(), now))).toEqual(['5s', '2m 5s', '1h 2m'])
})

it('opens the side panel for a step\'s request, puts it first, and answers it there', async () => {
  await mount()
  expect(document.querySelector('.dt-side')).toBeNull()
  server.teamSteps = [team()]
  server.stepApprovals = [approval]
  // The next poll (every 5 seconds while no step runs) finds the request.
  await new Promise(resolve => setTimeout(resolve, 5200))
  await settle()
  expect(document.querySelector('.dt-side')).not.toBeNull()
  expect(text()).toContain(zh['side.autoOpenedApproval'])
  const titles = all('.dt-side .dt-section-title').map(title => title.textContent)
  expect(titles[0]).toBe(`${zh['work.needsYou']}1`)
  const card = document.querySelector('[data-testid="step-approvals"]')!.textContent
  expect(card).toContain('前端 想越出工作目录（T2）')
  expect(card).toContain('pnpm add -D @floating-ui/react')
  expect(card).toContain('「同意 #ab12」')
  // VsSaros fix (2026-11-06): when it is refused if no one answers, and that it waited through a restart.
  expect(card).toContain(zh['work.approvalExpires'].replace('{time}', new Date('2026-11-05T11:01:00.000Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))
  expect(card).toContain(zh['work.approvalRestored'])
  // The member waiting for the person says so; another says what it does.
  const members = document.querySelector('[data-testid="team-steps"]')!.textContent
  expect(members).toContain('前端 T2 实现浮层写等你批准')
  expect(members).toContain('查找文件 · analytics')
  await click(find(zh['work.remember'], '[data-testid="step-approvals"] button'))
  expect(server.stepAnswers).toEqual([{ id: 'ap-1', choice: 'remember' }])
  expect(document.querySelector('[data-testid="step-approvals"]')).toBeNull()
}, 10_000)

it('shows a team in the Workbench tab as a flow, a board and a list, with a step\'s details beside them', async () => {
  server.teamSteps = [team()]
  server.stepApprovals = [approval]
  // VsSaros change (2026-11-07): the Workbench is no longer a tab; its page is still a route (the flow links open it).
  at({ page: 'work' })
  await mount()
  expect(all('[role="tab"]').map(item => item.textContent)).not.toContain(zh['tab.work'])
  const nodes = () => all('.dt-flow-node')
  expect(nodes().map(node => node.getAttribute('data-state'))).toEqual(['ready', 'alert', 'running', 'pending'])
  expect(nodes()[3]!.textContent).toContain('↻2')
  expect(all('.dt-flow-edge')).toHaveLength(4)
  expect(document.querySelector('.dt-work [data-testid="step-approval"]')).not.toBeNull()
  // A step's details: its attempts, and a way into its Bot's Session.
  await click(nodes()[3]!)
  const detail = () => document.querySelector('.dt-step-detail')?.textContent ?? ''
  expect(detail()).toContain('第 1 次 跳过按钮在 4K 下被遮挡')
  await click(find(zh['work.openSession'], '.dt-step-detail button'))
  expect(server.opened).toEqual(['step-tk-1-T4'])
  await click(find(zh['work.stop'], '.dt-step-detail button'))
  expect(server.stoppedSteps).toEqual(['tk-1/T4'])
  await click(find(zh['work.zoomIn']))
  expect(document.querySelector('.dt-flow-zoom span')?.textContent).toBe('116%')
  await click(tab(zh['work.view.board']))
  expect(all('.dt-board-col h3').map(head => head.textContent)).toEqual(['等待0', '进行中1', '待人处理1', '完成1', '未完成结束1'])
  await click(tab(zh['work.view.list']))
  expect(all('.dt-step-table tbody tr').map(row => row.textContent)).toContain('T3 文案埋点产品T1只读进行中1')
})

it('says when no team is at work', async () => {
  at({ page: 'work' })
  await mount()
  expect(text()).toContain(zh['work.empty'])
})

it('reads group runs itself while no chat-surface broadcast is heard, and stops once one arrives', async () => {
  const saved = groupRunsConfig.fallbackMs
  groupRunsConfig.fallbackMs = 20
  const panelFetch = globalThis.fetch
  const agentsCalls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/x/agents/')) {
      agentsCalls.push(String(url))
      return new Response(JSON.stringify({ ok: true, active: [{ schema: 1, callId: 'c-fb', roomId: 'room-fb', roomName: '兜底群', status: 'replying',
        statusLabel: '正在回答', done: false, startedAt: Date.now() - 1000, finishedAt: 0, replies: [], events: [], speaking: ['Coder'], passed: [], failed: [] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return panelFetch(url, init)
  }))
  try {
    at({ page: 'work' })
    await mount()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
    expect(agentsCalls[0]).toBe(AGENTS_ROOMS_ACTIVE)
    expect(document.querySelector('[data-vssaros-group-run="c-fb"]')?.getAttribute('data-vssaros-group-run-round-status')).toBe('replying')
    await act(async () => {
      window.dispatchEvent(new CustomEvent('vssaros-group-progress', { detail: { schema: 1, seq: 1, active: [] } }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const heardAt = agentsCalls.length
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(agentsCalls.length).toBe(heardAt)
    expect(document.querySelector('[data-testid="group-runs"]')).toBeNull()
  } finally {
    groupRunsConfig.fallbackMs = saved
  }
})

it('reads the one group-run state machine: the server status wins, interrupted beats failed', () => {
  expect([
    groupRoundStatus({ done: false, speaking: [] }),
    groupRoundStatus({ done: false, speaking: ['Coder'] }),
    groupRoundStatus({ done: true }),
    groupRoundStatus({ done: true, error: 'x' }),
    groupRoundStatus({ done: true, error: '执行被重启打断', interrupted: true }),
    groupRoundStatus({ done: true, events: [{ kind: 'cut' }] }),
    groupRoundStatus({ done: true, error: 'x', status: 'done' }),
    groupRoundStatus(null),
  ]).toEqual(['sent', 'replying', 'done', 'failed', 'cut', 'cut', 'done', 'sent'])
  expect(normalizeGroupRuns([{ roomId: 'r' }, { bogus: true }, null, 'x']).map(run => run.roomId)).toEqual(['r'])
  expect([groupRunSource({ fromSession: 'd', originTriggerId: 't' }), groupRunSource({ originTriggerId: 't' }), groupRunSource({})])
    .toEqual(['post', 'created', undefined])
})

it('refreshes live group-chat runs in the Workbench from the chat-surface progress event', async () => {
  const win = window as unknown as { __vssarosGroupProgress?: unknown }
  const active = [{
    callId: 'call-1', roomId: 'room-1', roomName: '番茄钟 H5 开发团队', startedAt: Date.now() - 1500, finishedAt: 0,
    done: false, error: '', speaking: ['Designer'], replies: [{ botId: 'coder', name: 'Coder', text: '已实现', ms: 1200 }],
    events: [{ kind: 'working', name: 'Coder', text: 'Coder 开始做了…' }], failed: [], passed: [],
  }]
  win.__vssarosGroupProgress = active
  try {
    at({ page: 'work' })
    await mount()
    const section = document.querySelector('[data-testid="group-runs"]')
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain('番茄钟 H5 开发团队')
    expect(section!.textContent).toContain(zh['groupRuns.title'])
    expect(section!.querySelector('[data-vssaros-group-run-state="running"]')).not.toBeNull()
    expect(section!.querySelector('[data-vssaros-group-run-member="Designer"][data-vssaros-group-run-member-state="speaking"]')).not.toBeNull()
    // Tied back to where it came from, and one click away from the group's own conversation.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('vssaros-group-progress', { detail: { schema: 1, active: [
        { ...active[0], originTriggerId: 'superagent:desk:m-1', fromSession: 'desk-1' },
      ] } }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const card = document.querySelector('[data-vssaros-group-run="call-1"]')!
    expect(card.getAttribute('data-vssaros-group-run-source')).toBe('post')
    expect(card.getAttribute('data-vssaros-group-run-trigger')).toBe('superagent:desk:m-1')
    expect(card.textContent).toContain(zh['groupRuns.source.post'])
    await act(async () => { (card.querySelector('[data-act="open-group-run"]') as HTMLButtonElement).click() })
    expect(server.opened).toContain('room-1')
    await act(async () => {
      window.dispatchEvent(new CustomEvent('vssaros-group-progress', { detail: { active: [
        { ...active[0], done: true, finishedAt: Date.now(), speaking: [], events: [{ kind: 'done', text: '群聊本轮完成' }] },
      ] } }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.querySelector('[data-vssaros-group-run-state="done"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="group-runs"]')!.textContent).toContain(zh['groupRuns.status.done'])
    await act(async () => {
      window.dispatchEvent(new CustomEvent('vssaros-group-progress', { detail: { active: [] } }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.querySelector('[data-testid="group-runs"]')).toBeNull()
  } finally {
    delete win.__vssarosGroupProgress
  }
})
