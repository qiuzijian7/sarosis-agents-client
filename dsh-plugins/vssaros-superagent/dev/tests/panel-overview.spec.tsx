// @vitest-environment jsdom
// The overview, which lives in the side panel.
import { beforeEach, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, text, type, openSide } from './fixtures/panel.tsx'
import { server, droppedReply, threadSummary, teamPlan } from './fixtures/panel-server.ts'
import type { BotApproval, BotCard } from '../src/app/team.ts'
import type { TeamWorkflow } from '../src/app/retrospective.ts'
import type { SkillRecord } from '../src/app/team-archive.ts'

usePanel()
beforeEach(openSide)
// VsSaros addition (2026-11-06): DS Bot in the same Host is said, with what it does to SuperAgent's Sessions.
it('says on the overview when DS Bot shares the Host, and how it reaches SuperAgent\'s Sessions', async () => {
  await mount()
  expect(document.querySelector('[data-testid="coexist-ds-bot"]')).toBeNull()
  server.coexist = { dsBot: { effects: ['secrets', 'images', 'skills'] } }
  await remount()
  const hint = document.querySelector('[data-testid="coexist-ds-bot"]')!
  expect(hint.textContent).toContain(zh.coexistDsBot)
  for (const effect of ['secrets', 'images', 'skills'] as const) expect(hint.textContent).toContain(zh[`coexistEffect.${effect}`])
})

it('leads the overview with the pending Tickets, then problems, the last day and the Executor, each linking to its stage', async () => {
  await mount()
  expect(tab(zh['tab.chat']).getAttribute('aria-selected')).toBe('true')
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['对话', '来源', '触发', '评估', '执行', '设置'])
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual(['待处理工单2', '系统问题2', '过去 24 小时详情 ›', '执行器详情 ›'])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual(['待回答', '待处理失败'])
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  // Actions sit below the title and Threads, apart from the stage, each with its icon.
  expect(all('.dt-ticket').every(row => row.querySelector('.dt-ticket-stage button, .dt-ticket-stage a') === null
    && [...row.querySelectorAll('.dt-ticket-actions button, .dt-ticket-actions a')].every(action => action.querySelector('svg')))).toBe(true)
  expect(text()).toContain('来源会在每次轮询时自动重试')
  expect(text()).toContain('需要确认按钮颜色')
  expect(all('.dt-stat').map(stat => stat.textContent)).toEqual(['到达12', '被过滤2', '已评估5', '接单或续做1', '执行中2 / 3', '排队0', '等待新触发1'])
  expect(all('.dt-chip').map(chip => chip.textContent)[0]).toBe('GitHub#42CI 失败1')
  expect(document.querySelector('.dt-chip-problem')?.textContent).toBe('CI 失败1')
  expect(document.querySelector<HTMLAnchorElement>('a.dt-chip-link')?.href).toBe('https://github.com/acme/widgets/pull/42')
  await click(all('.dt-more-link').at(-1)!)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
})

it('lists the skill drafts the memory system wrote for team steps, and approves one', async () => {
  const evidence = { requestId: 'd1', botId: 'tester', botName: '测试 bot', ticketId: 'tk-1', ticketTitle: '修复首页回归', stepKey: 'T2',
    stepTitle: '回归测试', spec: '跑回归', outcome: 'ready' as const, mode: 'skill' as const, turns: 4, attempts: 2, failures: ['超时'],
    report: '换成 data-testid 后通过', at: '2026-11-04T10:00:00.000Z' }
  server.distills = [{ id: 'distill:tk-1:T2', ticketId: 'tk-1', stepKey: 'T2', botId: 'tester', botName: '测试 bot', stepTitle: '回归测试',
    mode: 'skill', reasons: ['4 turns'], state: 'sent', attempts: 1, evidence, at: evidence.at,
    result: { fact: { ok: true, message: '已追加' }, skill: { name: 'bot-tester-abcd1234', path: '/x', created: true, state: 'draft' } } }]
  await mount()
  expect(all('.dt-section-title').map(title => title.textContent)).toContain(`${zh['team.distillPending']}1`)
  expect(document.querySelector('[data-testid="team-distills"]')?.textContent).toContain('bot-tester-abcd1234')
  await click(zh['team.skillApprove'])
  expect(server.decidedDistill).toEqual({ id: 'distill:tk-1:T2', decision: 'approve' })
})

it('lets the person at this machine agree to a ticket\'s team proposal from the Overview', async () => {
  server.proposals = [{ ticket: { id: 'tk-1', title: '修复首页回归', state: 'proposed' }, proposal: { ticketId: 'tk-1', version: 2,
    fingerprint: 'sha256:x', goal: '修复首页回归', roles: [{ key: 'fix', need: '修复', bot: { id: 'fixer', name: '修复 bot' } }],
    steps: [{ key: 'T1', role: 'fix', title: '修复回归', spec: '修', after: [], access: 'read' }],
    budget: { tokens: 300_000, turns: 90, parallel: 3 }, risk: { newBots: 0, highRiskTools: [], writeSteps: 0 }, state: 'proposed', at: '2026-11-04T10:00:00.000Z' } }]
  await mount()
  expect(all('.dt-section-title').map(title => title.textContent)).toContain(`${zh['team.staffing']}1`)
  expect(document.querySelector('[data-testid="team-staffing"]')?.textContent).toContain('修复 bot')
  await click(zh['team.staffingAgree'])
  expect(server.approvedTeam).toEqual({ ticketId: 'tk-1', version: 2 })
})

// VsSaros change (2026-11-06, P1 · one track): no plan is started by hand, and the template skills are only counted.
// ★ 2026-11-09（用户要求）：「团队工作流」UI 区块移除 —— 即使 Host 仍返回 workflows，面板也不得展示，
//   也不得出现保存/运行入口。保留归档技能计数与「不能手工开计划」这两条原有契约。
it('offers no way to start a team plan, counts the archived template skills, and shows no team-workflow UI', async () => {
  const card: BotCard = { id: 'tester', name: '测试 bot', description: '回归测试', skills: [], tools: [],
    delegatable: true, source: 'builtin' }
  server.teamBots = [card]
  const skill: SkillRecord = { id: 'sk-1', name: 'team-plan-1-t2', title: '回归测试 · 测试 bot', description: '回归测试经验',
    scope: 'bot:tester', origin: 'plan-1 · T2', evidence: 'step T2 hop 4', risk: 'medium', state: 'draft', version: 1,
    body: '运行 npx playwright test', planId: 'plan-1', file: 'C:/fake/.drafts/SKILL.md', at: '2026-11-04T12:00:00.000Z' }
  const workflow: TeamWorkflow = { id: 'wf-1', name: '首页新手引导上线', version: 1, fromPlanId: 'plan-1',
    goal: '首页新手引导上线', state: 'draft', params: [{ key: 'chat', label: '通知群' }],
    steps: [{ key: 'T1', title: '交互方案', spec: '出稿', bot: '设计 bot', after: [] }], gates: [],
    budget: { tokens: 300_000, turns: 90, parallel: 3 }, triggers: ['manual'], runs: 0, ok: 100, at: '2026-11-04T12:00:00.000Z' }
  server.retroSkills = [skill]
  server.retroWorkflows = [workflow]
  await mount()
  expect(document.querySelector('[data-testid="team-new"]')).toBeNull()
  expect(text()).toContain(zh['team.skillsArchived'].replace('{count}', '1'))
  expect(all('button').some(button => button.textContent === zh['team.skillApprove'])).toBe(false)
  // 工作流数据仍在（Host 侧组队匹配要用），但面板不再渲染这个区块
  expect(document.querySelector('[data-testid="team-teamflow"]')).toBeNull()
  expect(document.querySelector('[data-testid="team-workflow-run"]')).toBeNull()
  expect(text()).not.toContain('团队工作流')
  expect(text()).not.toContain('首页新手引导上线')
  expect(all('button').some(button => /保存为 v1|运行|导出到 TeamFlow/.test(button.textContent ?? ''))).toBe(false)
  expect(server.savedWorkflow).toBeUndefined()
  expect(server.ranWorkflow).toBeUndefined()
})

it('shows each open team ticket\'s steps with their Bot, state, turns and attempts', async () => {
  server.teamSteps = [{ ticket: { id: 'tk-1', title: '首页新手引导上线', updatedAt: '2026-11-05T10:00:00.000Z' }, steps: [
    { key: 'T1', title: '交互稿', bot: '设计 bot', botId: 'designer', access: 'read', state: 'ready', turns: 2, attempts: 1, after: [], report: '5 屏' },
    { key: 'T2', title: '回归测试', bot: '测试 bot', botId: 'tester', access: 'write', state: 'running', turns: 3, attempts: 2, after: ['T1'],
      since: new Date(Date.now() - 65_000).toISOString(), doing: { tool: 'pwsh', target: 'pnpm test', at: new Date().toISOString() } }] }]
  await mount()
  expect(all('.dt-section-title').map(title => title.textContent)).toContain(`${zh['team.steps']}1`)
  const row = document.querySelector('[data-testid="team-steps"]')!.textContent
  expect(row).toContain('1/2 完成')
  expect(row).toContain('设计 bot T1 交互稿完成 · 5 屏')
  expect(row).toMatch(/测试 bot T2 回归测试写运行命令 · pnpm test · 1m \d+s/)
  // A step that has not finished can be stopped by itself.
  expect(all('[data-testid="team-steps"] button').map(button => button.getAttribute('aria-label'))).toContain('停止步骤 T2')
  await click(find('停止步骤 T2'))
  expect(server.stoppedSteps).toEqual(['tk-1/T2'])
})

// ★ 2026-11-09（用户要求）：TeamFlow 导入/导出的 UI 一并移除。
//   Host 侧 `team/teamflow/*` 路由与适配器保留（其它消费者仍可用），但面板上不得再有输入框/按钮。
it('shows no TeamFlow import/export controls even when workflows exist', async () => {
  server.retroWorkflows = [{ id: 'wf-1', name: '首页新手引导上线', version: 1, fromPlanId: '', source: 'ticket', goal: '首页新手引导上线',
    state: 'saved', params: [], steps: [{ key: 'T1', title: '交互稿', spec: '出稿', bot: '设计 bot', after: [] }], gates: [],
    budget: { tokens: 300_000, turns: 90, parallel: 3 }, triggers: ['manual'], runs: 1, ok: 100, at: '2026-11-05T00:00:00.000Z' }]
  await mount()
  expect(document.querySelector('[data-testid="team-teamflow"]')).toBeNull()
  expect(document.querySelector('[data-testid="team-teamflow-result"]')).toBeNull()
  expect(all('button').some(button => /TeamFlow|导出|导入/.test(button.textContent ?? ''))).toBe(false)
  expect(all('input').some(input => /TeamFlow/i.test(input.getAttribute('placeholder') ?? ''))).toBe(false)
  expect(text()).not.toContain('TeamFlow')
  expect(server.teamflowExport).toBeUndefined()
  expect(server.teamflowImport).toBeUndefined()
})

it('asks a person to approve or reject a high-risk Bot draft', async () => {
  const approval: BotApproval = { id: 'appr-1', state: 'pending', at: '2026-11-04T10:00:00.000Z', risk: ['feishu', 'git'],
    draft: { id: 'publisher', name: '发布 bot', description: '版本说明与通知', persona: '发通知', tools: ['feishu', 'git'] } }
  server.approvals = [approval]
  await mount()
  expect(all('.dt-section-title').map(title => title.textContent)).toContain(`${zh['team.approval']}1`)
  expect(text()).toContain('发布 bot')
  expect(text()).toContain('feishu, git')
  await click(zh['team.approve'])
  expect(server.approvedBot).toBe('appr-1')
})

it('rejects a high-risk Bot draft without creating the Bot', async () => {
  server.approvals = [{ id: 'appr-2', state: 'pending', at: '2026-11-04T10:00:00.000Z', risk: ['feishu'],
    draft: { id: 'publisher', name: '发布 bot', persona: '发通知', tools: ['feishu'] } }]
  await mount()
  await click(zh['team.reject'])
  expect(server.rejectedBot).toBe('appr-2')
})

it('shows an archived team plan with its steps, read-only', async () => {
  server.plans = [teamPlan()]
  await mount()
  expect(all('.dt-section-title').map(title => title.textContent)).toContain(`${zh['team.archivedPlans']}1`)
  const plans = document.querySelector('[data-testid="team-archived-plans"]')!
  expect(plans.textContent).toContain('T1 交互方案')
  expect(plans.textContent).toContain('交互稿 5 屏。')
  expect(plans.querySelector('button')).toBeNull()
  expect(text()).toContain(zh['team.archivedPlansHint'])
})

it('re-evaluates or dismisses an unjudged Eval from the problem list', async () => {
  await mount()
  await click(zh.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
  await click(zh.dismiss)
  expect(server.requests.some(request => request.path === 'decisions/u1/dismiss' && request.method === 'POST')).toBe(true)
  expect(server.requests.filter(request => request.path === 'overview').length).toBeGreaterThan(2)
})

it('opens the Thread of an unjudged Eval at its Trigger from the problem list', async () => {
  await mount()
  await click('评估未完成：这个文案好奇怪')
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e3')
})

it('follows the last day\'s counts to the status of each stage', async () => {
  await mount()
  // Arrived Triggers include filtered ones, which have no Thread, so no list has that count to link to.
  expect(all('.dt-stat button').map(button => button.textContent)).toEqual(['2', '1'])
  await click(all('.dt-stat button')[0]!)
  expect(tab(zh['tab.source']).getAttribute('aria-selected')).toBe('true')
  await click(zh.sourceFilteredTitle)
  expect(text()).toContain('looks wrong')
  expect(text()).toContain(zh['reason.source_disabled'])
})

it('offers each Ticket that needs a person its actions on the overview: answer in its Channel, retry or open a failed worker, and stop',
  async () => {
  await mount()
  expect(all('.dt-ticket-actions a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  expect(all('.dt-ticket-note').map(note => note.textContent)).toContain('LlmError: no adapter registered for provider "provider-a"')
  await click(zh.retry)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/retry' && request.method === 'POST')).toBe(true)
  await click(all('.dt-ticket-actions button').find(button => button.textContent === '打开 Session')!)
  expect(server.opened).toEqual(['worker-t4'])
  await click(all('.dt-ticket-actions button').filter(button => button.textContent === '停止').at(-1)!)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/stop' && request.method === 'POST')).toBe(true)
  expect(text()).not.toContain('截图工具')
})

// ★ 2026-11-09 真机 bug：superagent 主管对话的 reply.url 是空串，旧的 <a href="" target="_blank">
//   被解析成当前 DSH Web UI 的 127.0.0.1 页面，宿主 shell.openExternal ⇒ 在系统浏览器开一个网页。
it('answers a SuperAgent desk question in the app instead of opening a blank external link', async () => {
  const person = server.person[0]!
  server.person = [{ ...person, reply: { source: 'superagent', url: '', label: { zh: '主管对话', en: 'Supervisor desk' } } }]
  await mount()
  const links = all('.dt-ticket-actions a')
  // 没有空 href、也没有指向 loopback 的链接
  expect(links.map(link => link.getAttribute('href'))).not.toContain('')
  expect(links.some(link => /127\.0\.0\.1|localhost/.test(link.getAttribute('href') ?? ''))).toBe(false)
  // 变成应用内按钮，文案说明去「主管对话」
  const button = all('[data-vssaros-in-app-action="1"]').find(el => /主管对话/.test(el.textContent ?? ''))!
  expect(button).toBeTruthy()
  expect(button.tagName).toBe('BUTTON')
  expect(button.hasAttribute('disabled')).toBe(false)
  await click(button)
  expect(tab(zh['tab.chat']).getAttribute('aria-selected')).toBe('true')
})

it('shows paused processing as a system problem with its resume action, and says so on the Policy records', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  expect(text()).toContain(zh.problemPaused)
  await click(zh['tab.eval'])
  expect(text()).toContain(zh.evalRecordsPaused)
  await click(zh.resumeWhere)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  await click(zh['tab.chat'])
  await click(find(zh.resumeProcessing, '.dt-att button'))
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: false } })
})

it('offers the step that fixes a settings problem as a button on the overview', async () => {
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: { feishu: { allowed: [], admission: {} },
    github: { allowed: [], admission: {} } } } }
  await mount()
  expect(text()).toContain(zh.problemNoAllowed)
  await click(zh.actionAddAllowed)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
})

it('counts the messages not sent in the last day, linking to the Source status, and shows nothing when there are none', async () => {
  await mount()
  expect(all('.dt-stat-label').map(label => label.textContent)).not.toContain(zh.flowDroppedLabel)
  server.dropped = [droppedReply('m2', 1, 'feishu', 'channelGone'), droppedReply('m1', 2, 'github', 'channelIgnored'), droppedReply('m0',
    30, 'feishu', 'channelGone')]
  await remount()
  const stat = all('.dt-stat').find(item => item.querySelector('.dt-stat-label')?.textContent === zh.flowDroppedLabel)!
  expect(stat.textContent).toBe(`${zh.flowDroppedLabel}2`)
  await click(stat.querySelector('button')!)
  expect(tab(zh['tab.source'])?.getAttribute('aria-selected')).toBe('true')
})

it('names a failing part of dsh-superagent itself by its label', async () => {
  server.health = { launch: { state: 'error', detail: 'spawn failed' }, relay: { state: 'ready', detail: 'Nothing waiting' } }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toContain(zh.problemRuntime.replace('{name}', zh['health.launch']))
  expect(text()).toContain('spawn failed')
})

it('words a refused retry in the interface language by its code', async () => {
  await mount()
  // Simulate another user retrying the ticket after the overview loaded.
  server.person = server.person.map(ticket => ticket.id === 't4' ? { ...ticket, actions: { ...ticket.actions, retry: false } } : ticket)
  await click(find(zh.retry, '.dt-ticket-actions button'))
  await click(zh.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh['userError.notRetryable'])
  expect(text()).not.toContain('Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed')
})

it('shows the overview in English', async () => {
  await mount(en)
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${en.pendingTickets}2`, `${en.problems}2`,
    `${en.lastDay}${en.details}`, `${en['term.executor']}${en.details}`])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual([en['stage.answer'], en['stage.failed']])
  expect(all('.dt-stat-label').map(label => label.textContent)).toEqual([en.flowReceivedLabel, en.flowFilteredLabel, en.flowJudgedLabel,
    en.flowAcceptedLabel, en.executingLabel, en.queuedLabel, en.idleLabel])
})

it('lists the unavailable Evals one by one, without the health entry that counts them as a failure of dsh-superagent', async () => {
  server.health.evals = { state: 'error', detail: '1 Eval(s) unavailable in the last hour without a later judgement' }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  expect(text()).not.toContain(zh['health.evals'])
})

it('says when no Source is on, an Eval is past its deadline or a message keeps failing, each with the way to it', async () => {
  for (const kind of ['feishu', 'github']) server.settings.sources[kind] = { ...server.settings.sources[kind]!, enabled: false }
  server.threads = [threadSummary({ key: 'github:9', title: '#9 迟迟未决', stage: 'evaluating',
    evaluating: { id: 'v9', triggers: 1, strength: 'inferred', startedAt: '2026-08-31T23:58:00Z', deadline: '2026-09-01T00:00:00Z' } })]
  server.failing = [{ id: 'm1', channel: { source: 'github', thread: 'github:42', address: { number: '42' } },
    text: '已修复', attempts: 4,
    error: 'HTTP 502 from GitHub' }]
  await mount()
  const titles = () => all('.dt-cards .dt-att-what').map(item => item.textContent)
  // The Feishu Source is off, so its error is no problem any more.
  expect(titles()).toEqual([zh.problemNoSource, '评估超时未决定：#9 迟迟未决', '评估未完成：这个文案好奇怪', 'GitHub 回复发送失败（已重试 4 次）'])
  expect(text()).toContain('HTTP 502 from GitHub')
  await click(zh.actionOpenSources)
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.source'])
  await click(tab(zh['tab.chat']))
  await click('评估超时未决定：#9 迟迟未决')
  expect(server.requests.some(request => request.path.startsWith('threads/github:9'))).toBe(true)
})
