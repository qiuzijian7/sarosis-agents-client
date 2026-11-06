// VsSaros addition (superagent runtime UI, plan C): what a team step may do, and the approvals it asks a person for.
import { afterEach, expect, it, vi } from 'vitest'
import { APPROVAL_EXPIRE_MS, APPROVAL_REMIND_MS, StepApprovals, approvalReply, callDetail, covers, doingOf, headOf, sandboxWorks, stepPermission, within,
  type ApprovalOutcome } from '../src/app/step-approvals.ts'
import { stepSessionId } from '../src/app/steps.ts'
import type { DeskFlow } from '../src/app/desk-flow.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { deskTrigger } from '../src/sources/superagent.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
let clock = 0
const reply = (id: string, text: string) =>
  feishu(id, text, { mentions: [], root_id: 'om_1', create_time: String(Date.now() + 1000 + (clock += 1000)) })
const TEAM = {
  roles: [{ key: 'design', need: '交互稿', bot: 'designer' }, { key: 'build', need: '实现', bot: 'builder' }],
  steps: [{ key: 'T1', role: 'design', title: '交互稿', spec: '出稿' }, { key: 'T2', role: 'build', title: '实现浮层', spec: '写代码', after: ['T1'], access: 'write' }],
}

/** A Feishu ticket whose team a person agreed to, its steps' permissions recorded. */
async function agreed() {
  h = await startRuntime(undefined, { staffing: true })
  const presets = vi.spyOn((h.ctx as unknown as { permissionPresets: { set(session: { id: string }, name: string): void } }).permissionPresets, 'set')
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 首页新手引导要上线'))
  await h.runTool(h.runtime.masterId, 'orchestrator_team_propose', { ticket_id: ticket.id, ...TEAM })
  await new Promise(resolve => setTimeout(resolve, 5))
  const yes = reply('2', '同意'); h.runtime.receive(yes); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_team_confirm', { ticket_id: ticket.id, trigger_id: yes.id, version: 1 })
  await h.runtime.idle()
  const permission = (key: string) => presets.mock.calls.filter(([session]) => session.id === stepSessionId(ticket.id, key)).at(-1)?.[1]
  return { ticketId: ticket.id, permission, presets }
}
/** Whether this machine can sandbox the ticket's directory, as the step scheduler hears it (the probe itself is tested above). */
function sandbox(works: boolean) {
  const host = (h!.runtime.steps as unknown as { host: { permission?: (step: { access: 'read' | 'write' }, directory: string) => Promise<unknown> } }).host
  host.permission = async step => stepPermission(step.access, works)
}
/** A step Session's agent, as DSH's approval request names it, with one tool call in its events. */
const agentOf = (sessionId: string, call: Record<string, unknown> = {}) => ({ id: sessionId, session: { header: {},
  snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify(call) } }] } }) as never
const next = vi.fn(async (): Promise<ApprovalOutcome> => 'unavailable')

it('reads replies, command heads, paths and calls as the approvals need them', () => {
  expect(approvalReply('@SuperAgent 同意 #ab12')).toEqual({ choice: 'allow', code: 'ab12' })
  expect(approvalReply('同意并记住')).toEqual({ choice: 'remember' })
  expect(approvalReply('拒绝 #AB12。')).toEqual({ choice: 'reject', code: 'ab12' })
  expect(approvalReply('同意，不过先等等')).toBeUndefined()
  expect(headOf('pnpm  add -D @floating-ui/react')).toBe('pnpm add')
  expect(headOf('C:\\Users\\me\\.npmrc')).toBe('C:\\Users\\me')
  expect(covers('pnpm add', 'pnpm add -D lodash')).toBe(true)
  expect(covers('pnpm add', 'pnpm addx')).toBe(false)
  expect(covers('C:\\Users\\me', 'c:\\users\\me\\.gitconfig')).toBe(true)
  expect(within('/work/t1', 'src/a.ts', 'linux')).toBe(true)
  expect(within('/work/t1', '/work/t10/a.ts', 'linux')).toBe(false)
  if (process.platform === 'win32') expect(within('C:\\Work\\T1', 'c:\\work\\t1\\a.ts', 'win32')).toBe(true)
  expect(stepPermission('read', false)).toEqual({ preset: 'read-only', sandboxed: true })
  expect(stepPermission('write', true)).toEqual({ preset: 'workspace-write', sandboxed: true })
  expect(stepPermission('write', false)).toEqual({ preset: 'danger-full-access', sandboxed: false })
  expect(callDetail([{ type: 'tool/call', data: { callId: 'c1', arguments: '{"command":"git push","justification":"publish"}' } }], 'c1'))
    .toEqual({ text: 'publish', code: 'git push' })
  expect(doingOf({ name: 'read', arguments: '{"file_path":"src/client/app.tsx"}' }, 'now')).toEqual({ tool: 'read', target: 'app.tsx', at: 'now' })
})

it('probes the Windows sandbox on a folder of its own in the directory, and needs no probe elsewhere', async () => {
  const run = vi.fn(async () => 5)
  expect(await sandboxWorks('/srv/work', 'linux', run)).toBe(true)
  expect(run).not.toHaveBeenCalled()
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'probe-'))
  expect(await sandboxWorks(directory, 'win32', run)).toBe(false)
  expect(run).toHaveBeenCalledWith('icacls', [expect.stringContaining('.vssaros-sandbox-probe-'), '/setintegritylevel', 'Low'])
  expect(await sandboxWorks(directory, 'win32', async () => 0)).toBe(true)
})

// VsSaros fix (2026-11-06): no silent fall back to full access.
it('blocks a write step this machine cannot sandbox until a person lets it run unsandboxed, and keeps saying it ran so', async () => {
  const { ticketId, permission } = await agreed()
  sandbox(false)
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T1')?.state === 'running')
  await h!.runTool(stepSessionId(ticketId, 'T1'), 'orchestrator_step_report', { state: 'ready', summary: '5 屏' })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.state === 'blocked')
  expect(h!.agents.has(stepSessionId(ticketId, 'T2'))).toBe(false)
  expect(permission('T2')).toBeUndefined()
  const view = () => h!.runtime.steps.view(ticketId)!.steps.find(step => step.key === 'T2')!
  expect(view()).toMatchObject({ state: 'blocked', needs: 'sandbox' })
  expect(h!.runtime.store.tickets.get(ticketId)!.inputs.some(input => input.kind === 'note' && /does not run with full access by itself/.test(input.text))).toBe(true)
  // A message from the lead does not start it; the person's decision does.
  await expect(h!.runtime.steps.message(ticketId, 'T2', 'go')).rejects.toThrow(/waits for a person to decide about its sandbox/)
  expect((await h!.api('POST', `tickets/${ticketId}/steps/T1/unsandboxed`)).status).toBeGreaterThanOrEqual(400)
  expect((await h!.api('POST', `tickets/${ticketId}/steps/T2/unsandboxed`)).body).toMatchObject({ step: 'T2' })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.state === 'running')
  expect(permission('T2')).toBe('danger-full-access')
  expect(h!.runtime.steps.tables.get(ticketId, 'T2')).toMatchObject({ unsandboxed: true, unsandboxedAllowed: { by: 'panel' } })
  // It stays marked after it ends.
  await h!.runTool(stepSessionId(ticketId, 'T2'), 'orchestrator_step_report', { state: 'ready', summary: '好了' })
  expect(view()).toMatchObject({ state: 'ready', unsandboxed: true })
  expect(view()).not.toHaveProperty('needs')
})

it('blocks a step whose permission DSH refuses, instead of running it with full access', async () => {
  const { ticketId, permission, presets } = await agreed()
  presets.mockImplementation((_session, name) => { if (name === 'read-only') throw new Error('no such preset') })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T1')?.state === 'blocked')
  expect(h!.runtime.steps.view(ticketId)!.steps[0]).toMatchObject({ needs: 'permission', report: expect.stringContaining('no such preset') })
  expect(permission('T1')).toBe('read-only')
  await h!.runtime.steps.allowUnsandboxed(ticketId, 'T1', 'panel')
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T1')?.state === 'running')
  expect(permission('T1')).toBe('danger-full-access')
  // Still read-only for its file tools.
  const guard = (h!.agents.get(stepSessionId(ticketId, 'T1')) as unknown as { ctx: { tools: { guard: { mock: { calls: [(execution: { name: string }) => unknown][] } } } } })
    .ctx.tools.guard.mock.calls.at(-1)![0]
  expect(guard({ name: 'write' })).toContain('read-only')
})

it('runs a read step read-only and a write step in its directory, and refuses what a read step asks for', async () => {
  const { ticketId, permission } = await agreed()
  sandbox(true)
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T1')?.state === 'running')
  expect(permission('T1')).toBe('read-only')
  const t1 = agentOf(stepSessionId(ticketId, 'T1'), { command: 'echo hi > a.txt' })
  expect(await h!.runtime.stepApprovals.decide({ agent: t1, toolName: 'pwsh', callId: 'c1' }, next)).toBe('rejected')
  // Another Session's request goes on to DSH.
  expect(await h!.runtime.stepApprovals.decide({ agent: agentOf('someone-else'), toolName: 'pwsh' }, next)).toBe('unavailable')
  expect(next).toHaveBeenCalledTimes(1)
  await h!.runTool(stepSessionId(ticketId, 'T1'), 'orchestrator_step_report', { state: 'ready', summary: '5 屏' })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.state === 'running')
  expect(permission('T2')).toBe('workspace-write')
  expect(h!.runtime.steps.tables.get(ticketId, 'T2')).not.toHaveProperty('unsandboxed')
})

it('asks a person for a write step\'s call beyond its directory, on Feishu too, and remembers an answer', async () => {
  const { ticketId } = await agreed()
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T1')?.state === 'running')
  await h!.runTool(stepSessionId(ticketId, 'T1'), 'orchestrator_step_report', { state: 'ready', summary: '5 屏' })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.state === 'running')
  const t2 = agentOf(stepSessionId(ticketId, 'T2'), { command: 'pnpm add -D @floating-ui/react', justification: '装浮层依赖' })
  const asked = h!.runtime.stepApprovals.decide({ agent: t2, toolName: 'pwsh', callId: 'c1', reason: 'escalate sandbox' }, next)
  const [pending] = h!.runtime.stepApprovals.list()
  expect(pending).toMatchObject({ ticketId, step: 'T2', bot: { id: 'builder' }, tool: 'pwsh', feishu: true,
    detail: { code: 'pnpm add -D @floating-ui/react', text: '装浮层依赖' } })
  expect(h!.runtime.steps.active()[0]!.steps.find(step => step.key === 'T2')).toMatchObject({ approval: pending!.id, botId: 'builder' })
  expect(h!.runtime.store.receipts.get(`step-approval:${pending!.id}`)?.text).toContain(`回复「同意 #${pending!.code}」允许一次`)
  h!.runtime.stepApprovals.answer(pending!.id, 'remember', 'panel')
  expect(await asked).toBe('allowed-once')
  expect(h!.runtime.stepApprovals.rules()).toMatchObject([{ bot: { id: 'builder' }, tool: 'pwsh', head: 'pnpm add' }])
  expect(h!.runtime.store.receipts.get(`step-approval-answer:${pending!.id}`)?.text).toContain('在面板里处理')
  // The same Bot, tool and command head is allowed without asking; another command asks again.
  expect(await h!.runtime.stepApprovals.decide({ agent: agentOf(stepSessionId(ticketId, 'T2'), { command: 'pnpm add zod' }), toolName: 'pwsh', callId: 'c1' }, next))
    .toBe('allowed-once')
  const other = h!.runtime.stepApprovals.decide({ agent: agentOf(stepSessionId(ticketId, 'T2'), { command: 'git push origin' }), toolName: 'pwsh', callId: 'c1' }, next)
  const [second] = h!.runtime.stepApprovals.list()
  // A listed person's reply on the ticket's Feishu thread answers it.
  h!.runtime.receive(reply('9', `拒绝 #${second!.code}`))
  await h!.runtime.idle()
  expect(await other).toBe('rejected')
  expect(h!.runtime.stepApprovals.list()).toEqual([])
  // A request whose turn is cancelled stops waiting.
  const controller = new AbortController()
  const cancelled = h!.runtime.stepApprovals.decide({ agent: agentOf(stepSessionId(ticketId, 'T2'), { command: 'rm -rf C:\\tmp' }), toolName: 'pwsh', callId: 'c1',
    signal: controller.signal }, next)
  controller.abort()
  expect(await cancelled).toBe('cancelled')
  expect(() => h!.runtime.stepApprovals.answer('gone', 'allow', 'panel')).toThrow(/no longer waits/)
})

// VsSaros fix (2026-11-06): a waiting request is written down, so after a restart it is still shown and answerable; and
// no request waits for ever.
it('keeps a waiting request through a restart: still listed, answerable, its allow passing the step\'s next same call once', async () => {
  const { ticketId } = await agreed()
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T1')?.state === 'running')
  await h!.runTool(stepSessionId(ticketId, 'T1'), 'orchestrator_step_report', { state: 'ready', summary: '5 屏' })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.state === 'running')
  void h!.runtime.stepApprovals.decide({ agent: agentOf(stepSessionId(ticketId, 'T2'), { command: 'pnpm add -D vitest' }), toolName: 'pwsh', callId: 'c1' }, next)
  const [before] = h!.runtime.stepApprovals.list()
  expect(before).toMatchObject({ step: 'T2', expiresAt: new Date(Date.parse(before!.at) + APPROVAL_EXPIRE_MS).toISOString() })
  expect(before).not.toHaveProperty('restored')
  // The restarted process reads the same database.
  const messages: string[] = []
  const restarted = () => new StepApprovals({ context: h!.ctx as never, store: h!.runtime.store, outbox: h!.runtime.outbox, engine: h!.runtime.engine,
    warn: () => {}, steps: { step: id => h!.runtime.steps.step(id), get: (t, k) => h!.runtime.steps.tables.get(t, k),
      message: async (_t, _k, text) => { messages.push(text) } } })
  const after = restarted()
  expect(after.list()).toEqual([{ ...before, restored: true }])
  expect(after.of(ticketId, 'T2')?.id).toBe(before!.id)
  after.answer(before!.id, 'allow', 'panel')
  expect(after.list()).toEqual([])
  expect(messages).toEqual([expect.stringContaining('A person allowed your request to run pnpm add -D vitest')])
  // The Bot runs it again: allowed once, without asking; the next time asks again.
  const again = agentOf(stepSessionId(ticketId, 'T2'), { command: 'pnpm add -D vitest' })
  expect(await after.decide({ agent: again, toolName: 'pwsh', callId: 'c1' }, next)).toBe('allowed-once')
  void after.decide({ agent: again, toolName: 'pwsh', callId: 'c1' }, next)
  expect(after.list()).toHaveLength(1)
  // Neither the old answer nor the new request is lost on a second restart; a refusal is told to the Bot.
  const third = restarted()
  expect(third.list()).toHaveLength(1)
  third.answer(third.list()[0]!.id, 'reject', 'panel')
  expect(messages.at(-1)).toContain('A person refused your request')
  expect(restarted().list()).toEqual([])
})

it('reminds the person of a request after 30 minutes, once, and refuses it when it expires', async () => {
  const { ticketId } = await agreed()
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T1')?.state === 'running')
  await h!.runTool(stepSessionId(ticketId, 'T1'), 'orchestrator_step_report', { state: 'ready', summary: '5 屏' })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.state === 'running')
  let clockNow = Date.now()
  const approvals = new StepApprovals({ context: h!.ctx as never, store: h!.runtime.store, outbox: h!.runtime.outbox, engine: h!.runtime.engine,
    warn: () => {}, steps: { step: id => h!.runtime.steps.step(id) }, now: () => clockNow })
  const asked = approvals.decide({ agent: agentOf(stepSessionId(ticketId, 'T2'), { command: 'git push origin' }), toolName: 'pwsh', callId: 'c1' }, next)
  const [pending] = approvals.list()
  approvals.sweep()
  expect(approvals.list()[0]).not.toHaveProperty('remindedAt')
  clockNow += APPROVAL_REMIND_MS
  approvals.sweep(); approvals.sweep()
  expect(approvals.list()[0]!.remindedAt).toBeDefined()
  expect(h!.runtime.store.receipts.get(`step-approval-remind:${pending!.id}`)?.text).toContain(`【还在等你批准 #${pending!.code}】`)
  clockNow = Date.parse(pending!.expiresAt)
  approvals.sweep()
  expect(await asked).toBe('rejected')
  expect(approvals.list()).toEqual([])
  expect(h!.runtime.store.receipts.get(`step-approval-answer:${pending!.id}`)?.text).toMatch(/60 分钟没人批，已按拒绝处理/)
  expect(h!.runtime.store.tickets.get(ticketId)!.inputs.some(input => input.kind === 'note' && /No one answered step T2's request/.test(input.text))).toBe(true)
})

it('lets a person stop one step from the panel, which skips the steps that wait for it', async () => {
  const { ticketId } = await agreed()
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T1')?.state === 'running')
  const stopped = await h!.api('POST', `tickets/${ticketId}/steps/T1/stop`)
  expect(stopped.body).toEqual({ step: 'T1', state: 'stopped' })
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(h!.runtime.steps.tables.of(ticketId).map(step => `${step.key}:${step.state}`)).toEqual(['T1:stopped', 'T2:skipped'])
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.state === 'skipped')
  expect((await h!.api('POST', `tickets/${ticketId}/steps/T1/stop`)).status).toBeGreaterThanOrEqual(400)
  const view = (await h!.api('GET', 'team/steps')).body as { approvals: unknown[] }
  expect(view.approvals).toEqual([])
})

// VsSaros addition (plan C): the key-node card of the message that started a ticket, and the change stream.
it('tells where the message that started a team ticket stands, and pushes each step change to open pages', async () => {
  const { ticketId } = await agreed()
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T1')?.state === 'running')
  const origin = h!.runtime.store.tickets.get(ticketId)!.origin.triggerId
  const flow = (await h!.api('GET', `desk/flow/${encodeURIComponent(origin)}`)).body as unknown as DeskFlow
  expect(flow).toMatchObject({ state: 'ticket', ticket: { id: ticketId }, proposal: { version: 1, state: 'approved' },
    team: { steps: [{ key: 'T1', state: 'running', botId: 'designer' }, { key: 'T2', state: 'pending' }] }, approvals: [] })
  expect(flow.followup).toBeUndefined()
  expect(((await h!.api('GET', 'desk/flow/nothing')).body as unknown as DeskFlow).state).toBe('unknown')
  // An open page hears that steps changed once, shortly after T1 reports.
  const res = { text: '', writeHead() { return this }, write(chunk: string) { this.text += chunk; return true }, on() { return this }, end() {} }
  h!.runtime.feed.attach({ on: () => undefined } as never, res as never)
  await h!.runTool(stepSessionId(ticketId, 'T1'), 'orchestrator_step_report', { state: 'ready', summary: '5 屏' })
  await waitUntil(() => res.text.includes('event: change'))
  expect(res.text).toMatch(/data: \{"topics":\[[^\]]*"steps"/)
  h!.runtime.feed.close()
})

// VsSaros fix (2026-11-05): a desk ticket's step request is sent to the supervisor desk too, whose model tells the person.
it('sends a desk ticket\'s step request to the desk, which wakes for it, and only tells the desk once it is answered', async () => {
  const { ticketId } = await agreed()
  // The ticket began in the supervisor desk.
  const started = deskTrigger({ session: h!.runtime.deskId, messageId: 'desk-m1', text: '首页新手引导要上线', at: new Date().toISOString() })
  h!.runtime.receive(started)
  await h!.runtime.idle()
  const ticket = h!.runtime.store.tickets.get(ticketId)!
  h!.runtime.store.tickets.save({ ...ticket, origin: { ...ticket.origin, triggerId: started.id } })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T1')?.state === 'running')
  await h!.runTool(stepSessionId(ticketId, 'T1'), 'orchestrator_step_report', { state: 'ready', summary: '5 屏' })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.state === 'running')
  const asked = h!.runtime.stepApprovals.decide({ agent: agentOf(stepSessionId(ticketId, 'T2'), { command: 'pnpm add -D vitest' }), toolName: 'pwsh', callId: 'c1' }, next)
  const [pending] = h!.runtime.stepApprovals.list()
  expect(pending).toMatchObject({ ticketId, feishu: false })
  expect(pending).not.toHaveProperty('posted')
  await h!.runtime.idle()
  await h!.runtime.deskOutbox.flush()
  expect(h!.runtime.deskOutbox.entry(`step-approval:${pending!.id}`)).toBeDefined()
  const desk = () => h!.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === h!.runtime.deskId).map(call => call.text)
  expect(desk().some(text => text.startsWith(`[SuperAgent] 【需要你批准 #${pending!.code}】`))).toBe(true)
  h!.runtime.stepApprovals.answer(pending!.id, 'allow', 'panel')
  expect(await asked).toBe('allowed-once')
  await h!.runtime.idle()
  await h!.runtime.deskOutbox.flush()
  // That it was answered is progress: logged, without waking the desk.
  expect(h!.runtime.deskChat.messages().map(item => item.id)).toContain(`step-approval-answer:${pending!.id}`)
  expect(h!.runtime.deskOutbox.entry(`step-approval-answer:${pending!.id}`)).toBeUndefined()
})
