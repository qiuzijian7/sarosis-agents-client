// VsSaros addition (superagent v2, P3): an agreed team's steps, each done by its Bot in a Session of its own.
import { afterEach, expect, it } from 'vitest'
import { botPreset, stepOfSession, stepSessionId, stepUsageStream } from '../src/app/steps.ts'
import { COORDINATOR_REFUSED, stepToolAllowed } from '../src/app/sessions.ts'
import { assignmentRole } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
let clock = 0
const reply = (id: string, text: string) =>
  feishu(id, text, { mentions: [], root_id: 'om_1', create_time: String(Date.now() + 1000 + (clock += 1000)) })
const TEAM = {
  roles: [{ key: 'design', need: '交互稿', bot: 'designer' }, { key: 'test', need: '回归测试', bot: 'tester' }, { key: 'doc', need: '说明', bot: 'writer' }],
  steps: [
    { key: 'T1', role: 'design', title: '交互稿', spec: '出 5 屏交互稿' },
    { key: 'T2', role: 'test', title: '回归测试', spec: '跑回归', after: ['T1'], access: 'write' },
    { key: 'T3', role: 'doc', title: '发版说明', spec: '写发版说明' },
  ],
}

/** A ticket whose team a person agreed to, with its lead running. */
async function agreed(team: Record<string, unknown> = TEAM) {
  h = await startRuntime(undefined, { staffing: true })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 首页新手引导要上线'))
  await h.runTool(h.runtime.masterId, 'orchestrator_team_propose', { ticket_id: ticket.id, ...team })
  await new Promise(resolve => setTimeout(resolve, 5))
  const yes = reply('2', '同意'); h.runtime.receive(yes); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_team_confirm', { ticket_id: ticket.id, trigger_id: yes.id, version: 1 })
  await h.runtime.idle()
  return { ticketId: ticket.id, lead: sessionId }
}
const step = (ticketId: string, key: string) => h!.runtime.steps.tables.get(ticketId, key)!
const notes = (ticketId: string) => h!.runtime.store.tickets.get(ticketId)!.inputs.flatMap(input => input.kind === 'note' ? [input.text] : [])
const report = (ticketId: string, key: string, state: string, summary: string) =>
  h!.runTool(stepSessionId(ticketId, key), 'orchestrator_step_report', { state, summary })

// ── VsSaros addition (2026-11-06, P1 · one execution model) ──────────────────────────────────────────────────────
/** The first denial of every guard a Session registered, as DSH evaluates them. */
const guarded = (sessionId: string, name: string, args: unknown = {}) => {
  const guards = (h!.agents.get(sessionId) as unknown as { ctx: { tools: { guard: { mock: { calls: [(execution: { name: string; arguments: unknown }) => string | undefined][] } } } } })
    .ctx.tools.guard.mock.calls.map(([guard]) => guard)
  for (const guard of guards) { const reason = guard({ name, arguments: args }); if (reason) return reason }
  return undefined
}
/** The Bots plugin's roster, with each Bot's own tools, as the team bus lists it. */
function roster(cards: { id: string; tools: string[] }[], revision2 = false) {
  const key = Symbol.for('vssaros.team'), owner = globalThis as unknown as Record<symbol, unknown>
  owner[key] = { version: 1, available: () => true, delegate: async () => { throw new Error('unused') }, subscribe: () => () => {}, get: async () => undefined,
    // VsSaros addition (2026-11-06): contract revision 2 names a Bot's preset itself.
    ...revision2 ? { revision: 2, features: ['presetOf'], presetOf: (id: string) => `bots-own-${id}` } : {},
    cancel: async () => { throw new Error('unused') },
    listBots: async () => cards.map(card => ({ id: card.id, name: card.id, description: '', skills: [], tools: card.tools, delegatable: true, source: 'custom' })) }
  return () => { delete owner[key] }
}

it('allows a step Session WORK_TOOLS ∪ its Bot\'s own tools (patterns too), and only those', async () => {
  expect(stepToolAllowed('agent_open_session', undefined, [])).toBe(true) // a step agreed before keeps only its preset's limit
  expect(stepToolAllowed('pwsh', ['browser'], [])).toBe(true)
  expect(stepToolAllowed('mcp__figma__export', ['mcp__figma__*'], [])).toBe(true)
  expect(stepToolAllowed('mcp__github__push', ['mcp__figma__*'], [])).toBe(false)
  expect(stepToolAllowed('orchestrator_step_report', [], ['orchestrator_step_report'])).toBe(true)
  const off = roster([{ id: 'designer', tools: ['browser', 'mcp__figma__*'] }, { id: 'tester', tools: [] }, { id: 'writer', tools: ['read'] }], true)
  try {
    const { ticketId } = await agreed()
    await waitUntil(() => step(ticketId, 'T1')?.state === 'running')
    expect(step(ticketId, 'T1').bot).toEqual({ id: 'designer', name: 'designer', tools: ['browser', 'mcp__figma__*'] })
    // Team bus revision 2: the preset is the Bots plugin's own name for it, not this package's copy of the rule.
    expect(step(ticketId, 'T1').preset).toBe('bots-own-designer')
    const t1 = stepSessionId(ticketId, 'T1')
    for (const name of ['read', 'pwsh', 'browser', 'mcp__figma__export', 'orchestrator_step_report']) expect(guarded(t1, name)).toBeUndefined()
    expect(guarded(t1, 'agent_open_session')).toMatch(/neither a work tool nor one of this Bot's tools/)
    expect(guarded(t1, 'mcp__github__push')).toMatch(/neither a work tool/)
  } finally { off() }
})

it('meters step tokens, tells the lead at 90%, stops new steps at the cap, lets running ones only report, and a person raises it', async () => {
  // The stream listener counts only step Sessions' usage chunks and passes every chunk on.
  const metered: [string, unknown][] = []
  const listen = stepUsageStream((id, usage) => { metered.push([id, usage]) })
  const chunks = async function* () { yield { type: 'text-delta', text: 'x' }; yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } } }
  const seen: unknown[] = []
  for await (const chunk of listen({ sessionId: 'step-abc-T1' }, chunks) as AsyncIterable<unknown>) seen.push(chunk)
  expect(seen).toHaveLength(2)
  expect(metered).toEqual([['step-abc-T1', { inputTokens: 5, outputTokens: 2 }]])
  const other = chunks()
  expect(listen({ sessionId: 'worker-abc' }, () => other)).toBe(other)
  const { ticketId, lead } = await agreed()
  await waitUntil(() => step(ticketId, 'T1')?.state === 'running')
  const t1 = stepSessionId(ticketId, 'T1')
  expect(h!.runtime.steps.budget(ticketId)).toMatchObject({ tokens: 0, tokensCap: 300_000, stopped: false })
  h!.runtime.steps.meter(t1, { inputTokens: 200_000, cacheReadTokens: 60_000, outputTokens: 10_000 })
  expect(notes(ticketId)).toContainEqual(expect.stringContaining('The team used 90% of its token budget (270000 of 300000)'))
  h!.runtime.steps.meter(t1, { inputTokens: 10_000 })
  expect(notes(ticketId).filter(text => text.includes('90% of its token budget'))).toHaveLength(1)
  h!.runtime.steps.meter(t1, { inputTokens: 25_000, cacheWriteTokens: 1_000 })
  expect(h!.runtime.steps.budget(ticketId)).toMatchObject({ tokens: 306_000, stopped: true })
  expect(notes(ticketId)).toContainEqual(expect.stringContaining('The team used its token budget (306000 of 300000): no new step starts'))
  // Running: it may only report. The lead may not report ready either.
  expect(guarded(t1, 'read')).toMatch(/used its token budget: report now/)
  expect(guarded(t1, 'orchestrator_step_report')).toBeUndefined()
  await report(ticketId, 'T1', 'ready', '5 屏')
  await h!.runtime.steps.kick(ticketId)
  expect(step(ticketId, 'T2').state).toBe('pending')
  await expect(h!.runTool(lead, 'orchestrator_report', { state: 'ready', summary: '好了' })).rejects.toThrow(/Team steps still unfinished/)
  // A person raises it: the steps that waited start.
  expect((await h!.api('POST', `tickets/${ticketId}/steps/budget`, { tokens: 100 })).status).toBeGreaterThanOrEqual(400)
  expect((await h!.api('POST', `tickets/${ticketId}/steps/budget`, {})).status).toBeGreaterThanOrEqual(400)
  expect((await h!.api('POST', `tickets/${ticketId}/steps/budget`, { tokens: 450_000 })).body).toMatchObject({ tokensCap: 450_000, stopped: false })
  await waitUntil(() => step(ticketId, 'T2').state === 'running')
  expect(h!.runtime.steps.view(ticketId)!.budget).toMatchObject({ tokens: 306_000, tokensCap: 450_000 })
  expect(step(ticketId, 'T1')).not.toHaveProperty('budgetStoppedAt')
})

// VsSaros fix (2026-11-06, real-machine run): a lead's message steered in after a step reported ready woke it to run its
// tools and report again (3 more model calls, ~160k tokens).
it('ends a step that reported ready: it is told to stop, and calls no tool until it is sent back', async () => {
  const { ticketId } = await agreed()
  await waitUntil(() => step(ticketId, 'T1')?.state === 'running')
  const t1 = stepSessionId(ticketId, 'T1')
  expect(guarded(t1, 'read')).toBeUndefined()
  expect(await report(ticketId, 'T1', 'ready', '5 屏')).toMatchObject({ state: 'ready', next: expect.stringContaining('end your turn now') })
  for (const name of ['read', 'pwsh', 'orchestrator_step_report']) expect(guarded(t1, name)).toMatch(/already reported ready/)
  // Sent back by a later step: it works again.
  await waitUntil(() => step(ticketId, 'T2')?.state === 'running')
  await h!.runTool(stepSessionId(ticketId, 'T2'), 'orchestrator_step_report', { state: 'rework', step: 'T1', summary: '第 3 屏按钮看不清，加深颜色' })
  await waitUntil(() => step(ticketId, 'T1').state === 'running')
  expect(guarded(t1, 'read')).toBeUndefined()
})

it('makes a team ticket\'s Assignment its coordinator: it changes no file and runs no command while a step is unfinished', async () => {
  const { ticketId, lead } = await agreed({ roles: TEAM.roles, steps: [{ key: 'T1', role: 'design', title: '交互稿', spec: '出稿' }] })
  expect(assignmentRole(h!.runtime.store.tickets.get(ticketId)!)).toBe('coordinator')
  expect(assignmentRole({ team: undefined })).toBe('worker')
  expect(assignmentRole({ team: { state: 'proposed', version: 1, at: '' } })).toBe('worker')
  await waitUntil(() => step(ticketId, 'T1')?.state === 'running')
  for (const name of COORDINATOR_REFUSED) expect(guarded(lead, name)).toMatch(/You coordinate this ticket's team: its 1 unfinished step/)
  expect(guarded(lead, 'read')).toBeUndefined()
  expect(guarded(lead, 'orchestrator_step_message')).toBeUndefined()
  await report(ticketId, 'T1', 'ready', '出好了')
  // Every step finished: the coordinator checks the results.
  for (const name of ['write', 'pwsh']) expect(guarded(lead, name)).toBeUndefined()
})

it('names step Sessions and Bot presets as the Bots plugin does', () => {
  const id = 'b6f98de968462770d18350254faed9a0'
  expect(stepOfSession(stepSessionId(id, 'T1-a'))).toEqual({ ticketId: id, key: 'T1-a' })
  expect(stepOfSession(`worker-${id}`)).toBeUndefined()
  expect(botPreset('Test Bot')).toBe('vssaros-test-bot')
  expect(botPreset('测试')).toBe('vssaros-agent')
})

it('starts the steps that wait for nothing, each in a Session under its Bot\'s preset, once the lead runs', async () => {
  const { ticketId, lead } = await agreed()
  await waitUntil(() => h!.agents.has(stepSessionId(ticketId, 'T1')) && h!.agents.has(stepSessionId(ticketId, 'T3')))
  expect(h!.agents.has(lead)).toBe(true)
  expect(h!.agents.has(stepSessionId(ticketId, 'T2'))).toBe(false)
  const presets = h!.controller.create.mock.calls.map(([call]) => call as { sessionId: string; agentPreset: string })
    .filter(call => call.sessionId.startsWith('step-')).map(call => call.agentPreset)
  expect(presets.sort()).toEqual(['vssaros-designer', 'vssaros-writer'])
  expect(step(ticketId, 'T1')).toMatchObject({ state: 'running', attempts: 1, bot: { id: 'designer' } })
  expect(h!.relays(stepSessionId(ticketId, 'T1'))[0]).toMatchObject({ step: 'T1', spec: '出 5 屏交互稿', access: 'read',
    request: '@bot 首页新手引导要上线', team: expect.arrayContaining([{ step: 'T2', title: '回归测试', bot: 'tester' }]) })
  expect([...h!.tools.get(stepSessionId(ticketId, 'T1'))!.keys()]).toEqual(['orchestrator_step_report'])
  expect([...h!.tools.get(lead)!.keys()]).toContain('orchestrator_step_message')
  // A read-only step's Bot writes no file; the lead may not report ready while steps run.
  const guard = (h!.agents.get(stepSessionId(ticketId, 'T1')) as unknown as { ctx: { tools: { guard: { mock: { calls: [(execution: { name: string }) => unknown][] } } } } })
    .ctx.tools.guard.mock.calls.at(-1)![0]
  expect(guard({ name: 'write' })).toContain('read-only')
  expect(guard({ name: 'read' })).toBeUndefined()
  await expect(h!.runTool(lead, 'orchestrator_report', { state: 'ready', summary: '好了' })).rejects.toThrow(/Team steps still unfinished: T1 running, T2 pending, T3 running/)
})

it('starts a step once those it waits for are ready, gives it their reports, tries a failed step once more, and tells the lead each end', async () => {
  const { ticketId, lead } = await agreed()
  await waitUntil(() => step(ticketId, 'T1')?.state === 'running')
  await report(ticketId, 'T1', 'ready', '交互稿 5 屏，见 design/onboarding.fig')
  await waitUntil(() => h!.agents.has(stepSessionId(ticketId, 'T2')))
  expect(h!.relays(stepSessionId(ticketId, 'T2'))[0]).toMatchObject({ access: 'write',
    upstream: [{ step: 'T1', title: '交互稿', bot: 'designer', report: '交互稿 5 屏，见 design/onboarding.fig' }] })
  expect(notes(ticketId)).toContainEqual(expect.stringContaining('Step T1 (designer) ready: 交互稿 5 屏'))

  expect(await report(ticketId, 'T2', 'failed', '选择器超时')).toMatchObject({ retried: true })
  await waitUntil(() => step(ticketId, 'T2').state === 'running' && step(ticketId, 'T2').attempts === 2)
  expect(h!.relays(stepSessionId(ticketId, 'T2')).at(-1)).toMatchObject({ previous_attempt_failed: '选择器超时' })
  await report(ticketId, 'T2', 'failed', '还是超时')
  expect(step(ticketId, 'T2')).toMatchObject({ state: 'failed', failures: ['选择器超时', '还是超时'] })

  // T3 ends its turn without a report: it is ready with its last words, and its turn counts.
  const writer = h!.agents.get(stepSessionId(ticketId, 'T3'))! as unknown as { status: string }
  writer.status = 'idle'
  h!.ctx.emit('agent/status', { agent: writer, status: 'idle' } as never)
  await waitUntil(() => step(ticketId, 'T3').state === 'ready')
  expect(step(ticketId, 'T3')).toMatchObject({ implicit: true, turns: 1 })
  await waitUntil(() => notes(ticketId).some(text => text.startsWith('All steps of the team finished')))
  expect(notes(ticketId).filter(text => text.startsWith('All steps of the team finished'))).toHaveLength(1)
  expect(h!.runtime.steps.unfinished(ticketId)).toEqual([])
  expect(await h!.runTool(lead, 'orchestrator_report', { state: 'blocked', summary: '回归测试两次超时', human_action: '要不要先跳过回归？' }))
    .toMatchObject({ reported: true })
})

it('runs one writing step at a time in the ticket\'s directory, while reading steps run beside it', async () => {
  const { ticketId } = await agreed({ roles: TEAM.roles, steps: [
    { key: 'W1', role: 'design', title: '改页面', spec: '改首页', access: 'write' },
    { key: 'W2', role: 'test', title: '改测试', spec: '改用例', access: 'write' },
    { key: 'R1', role: 'doc', title: '读代码', spec: '列出入口' }] })
  await waitUntil(() => step(ticketId, 'W1')?.state === 'running' && step(ticketId, 'R1')?.state === 'running')
  expect(step(ticketId, 'W2').state).toBe('pending')
  expect(h!.runtime.steps.active()).toMatchObject([{ ticket: { id: ticketId }, steps: [
    { key: 'W1', state: 'running', access: 'write', bot: 'designer' }, { key: 'W2', state: 'pending' }, { key: 'R1', state: 'running' }] }])
  expect((await h!.api('GET', 'team/steps')).body).toMatchObject({ tickets: [{ ticket: { id: ticketId } }] })
  await report(ticketId, 'W1', 'ready', '首页已改')
  await waitUntil(() => step(ticketId, 'W2').state === 'running')
})

// VsSaros addition (2026-11-06): a tester sends the developer's step back with the bugs; the developer redoes it, then the
// tester checks again — up to STEP_REWORKS times.
it('lets a step send a step it waits for back for rework: that step reruns with what to fix, then the sender checks again', async () => {
  const { ticketId, lead } = await agreed({ roles: TEAM.roles, steps: [
    { key: 'D', role: 'design', title: '开发', spec: '写番茄钟', access: 'write' },
    { key: 'T', role: 'test', title: '测试', spec: '浏览器点测', after: ['D'] },
    { key: 'R', role: 'doc', title: '说明', spec: '写说明', after: ['T'] },
    { key: 'X', role: 'doc', title: '无关', spec: '与开发无关' }] })
  await waitUntil(() => step(ticketId, 'D')?.state === 'running')
  await report(ticketId, 'D', 'ready', '写好了')
  await waitUntil(() => step(ticketId, 'T')?.state === 'running')
  // Only a step it waits for, and only with step.
  await expect(h!.runTool(stepSessionId(ticketId, 'T'), 'orchestrator_step_report', { state: 'rework', summary: 'x' })).rejects.toThrow(/rework needs step/)
  await expect(h!.runTool(stepSessionId(ticketId, 'T'), 'orchestrator_step_report', { state: 'rework', step: 'X', summary: 'x' }))
    .rejects.toThrow(/can send back only a step it waits for: D/)
  const sent = await h!.runTool(stepSessionId(ticketId, 'T'), 'orchestrator_step_report', { state: 'rework', step: 'D', summary: '开始按钮点了没反应；复现：打开首页点开始' })
  expect(sent).toMatchObject({ state: 'rework', sent_back: 'D', round: 1 })
  expect(notes(ticketId)).toContainEqual(expect.stringContaining('Step T (tester) sent step D (designer) back for rework (1/3): 开始按钮点了没反应'))
  await waitUntil(() => step(ticketId, 'D').state === 'running' && step(ticketId, 'D').attempts === 2)
  expect(step(ticketId, 'T').state).toBe('pending')
  expect(h!.relays(stepSessionId(ticketId, 'D')).at(-1)).toMatchObject({ rework: { sent_back_by: 'T', round: 1, fix: '开始按钮点了没反应；复现：打开首页点开始', your_previous_report: '写好了' } })
  expect(h!.relays(stepSessionId(ticketId, 'D')).at(-1)).not.toHaveProperty('previous_attempt_failed')
  expect(h!.runtime.steps.view(ticketId)!.steps.find(item => item.key === 'D')).toMatchObject({ reworks: 1, reworkNote: expect.stringContaining('开始按钮') })
  await expect(h!.runTool(lead, 'orchestrator_report', { state: 'ready', summary: '好了' })).rejects.toThrow(/Team steps still unfinished/)
  // The fix: the tester gets its step again, told what was redone, and passes it.
  await report(ticketId, 'D', 'ready', '修好了，开始按钮绑定了 tap')
  await waitUntil(() => step(ticketId, 'T').state === 'running')
  expect(h!.relays(stepSessionId(ticketId, 'T')).at(-1)).toMatchObject({ upstream: [{ step: 'D', report: '修好了，开始按钮绑定了 tap' }],
    rework: { redone: 'D', after_feedback_of: 'T', round: 1, note: expect.stringMatching(/check again/) } })
  expect(step(ticketId, 'D')).not.toHaveProperty('reopened')
  // Twice more, then a fourth time is refused.
  for (const round of [2, 3]) {
    await h!.runTool(stepSessionId(ticketId, 'T'), 'orchestrator_step_report', { state: 'rework', step: 'D', summary: `还有问题 ${round}` })
    await waitUntil(() => step(ticketId, 'D').state === 'running')
    await report(ticketId, 'D', 'ready', `修了 ${round}`)
    await waitUntil(() => step(ticketId, 'T').state === 'running')
  }
  await expect(h!.runTool(stepSessionId(ticketId, 'T'), 'orchestrator_step_report', { state: 'rework', step: 'D', summary: '还有' }))
    .rejects.toThrow(/sent back 3 times already/)
  await report(ticketId, 'T', 'ready', '复测通过')
  await waitUntil(() => step(ticketId, 'R').state === 'running')
  expect(step(ticketId, 'X').attempts).toBe(1)
})

it('reopens the finished steps after the redone one, and a failure is tried once more in each round', async () => {
  const { ticketId } = await agreed({ roles: TEAM.roles, steps: [
    { key: 'D', role: 'design', title: '开发', spec: '写', access: 'write' },
    { key: 'R', role: 'doc', title: '评审', spec: '评', after: ['D'] },
    { key: 'T', role: 'test', title: '测试', spec: '测', after: ['R'] }] })
  await waitUntil(() => step(ticketId, 'D')?.state === 'running')
  await report(ticketId, 'D', 'ready', 'v1')
  await waitUntil(() => step(ticketId, 'R')?.state === 'running')
  await report(ticketId, 'R', 'ready', '评审通过')
  await waitUntil(() => step(ticketId, 'T')?.state === 'running')
  // The tester sends back the developer's step, two steps up: the review is reopened too.
  await h!.runTool(stepSessionId(ticketId, 'T'), 'orchestrator_step_report', { state: 'rework', step: 'D', summary: '计时不准' })
  expect(step(ticketId, 'R')).toMatchObject({ state: 'pending', reopened: { by: 'T', target: 'D' } })
  await waitUntil(() => step(ticketId, 'D').state === 'running')
  expect(await report(ticketId, 'D', 'failed', '改不动')).toMatchObject({ retried: true })
  await waitUntil(() => step(ticketId, 'D').state === 'running')
  await report(ticketId, 'D', 'ready', 'v2')
  await waitUntil(() => step(ticketId, 'R').state === 'running')
  expect(h!.relays(stepSessionId(ticketId, 'R')).at(-1)).toMatchObject({ rework: { redone: 'D', note: expect.stringMatching(/again on its new result/) } })
})

it('skips the steps that wait for a failed one, lets the lead answer a blocked step, and stops every step when the ticket ends', async () => {
  const { ticketId, lead } = await agreed({ roles: TEAM.roles.slice(0, 2), steps: TEAM.steps.slice(0, 2) })
  await waitUntil(() => step(ticketId, 'T1')?.state === 'running')
  await report(ticketId, 'T1', 'blocked', '要几屏？')
  expect(notes(ticketId)).toContainEqual(expect.stringContaining('orchestrator_step_message'))
  expect(await h!.runTool(lead, 'orchestrator_step_message', { step: 'T1', text: '5 屏' })).toMatchObject({ state: 'running' })
  expect(h!.relays(stepSessionId(ticketId, 'T1')).at(-1)).toMatchObject({ text: expect.stringContaining('5 屏') })
  await report(ticketId, 'T1', 'failed', '设计稿工具不可用')
  await report(ticketId, 'T1', 'failed', '仍不可用')
  await waitUntil(() => step(ticketId, 'T2').state === 'skipped')
  expect(h!.agents.has(stepSessionId(ticketId, 'T2'))).toBe(false)

  await h!.stop(); h = undefined
  const second = await agreed()
  await waitUntil(() => step(second.ticketId, 'T1')?.state === 'running')
  h!.runtime.engine.stopTicket(second.ticketId, '不做了')
  expect(step(second.ticketId, 'T1').state).toBe('stopped')
  expect(step(second.ticketId, 'T2').state).toBe('stopped')
  expect((h!.agents.get(stepSessionId(second.ticketId, 'T1')) as unknown as { cancel: { mock: { calls: unknown[] } } }).cancel.mock.calls.length).toBeGreaterThan(0)
  await expect(report(second.ticketId, 'T3', 'ready', 'x')).rejects.toThrow(/stopped/)
})
