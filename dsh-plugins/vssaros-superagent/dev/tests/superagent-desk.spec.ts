// VsSaros addition: the Runtime's supervisor desk and Bots asking SuperAgent for help, end to end on the fake Host.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DESK_FILE_BYTES } from '../src/app/desk-chat.ts'
import { deskReceiptStream, RECEIPT_CALL_PREFIX, RECEIPT_TOOL, receiptText, receiptView, ticketEndedNotice } from '../src/app/desk.ts'
import { deskFlow } from '../src/app/desk-flow.ts'
import type { Ticket } from '../src/core/index.ts'
import { GROUP_REFERENCE_WAIT_MS } from '../src/app/groupFastPath.ts'
import { DESK_PERSON, deskTrigger, SUPERAGENT_SOURCE } from '../src/sources/superagent.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const listSuperagent = (bots: { id: string }[] = []) => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy,
    sources: { ...settings.policy.sources, [SUPERAGENT_SOURCE]: { allowed: [{ ...DESK_PERSON }], bots, admission: {} } } } })
}
const reaches = (sessionId: string, triggerId: string) => h.deliveries.mock.calls.some(([call]) => call.sessionId === sessionId && call.text.includes(triggerId))
/** desk intake 只让以 @ 开头的消息等引用事件；测试要放过这个窗口。 */
const tick = (ms = 60) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** Where a desk message stands, as the desk's flow card reads it. */
const flowOf = (triggerId: string) => deskFlow({ store: h.runtime.store, proposal: () => undefined, team: () => undefined, approvals: () => [],
  route: id => h.runtime.groupRoutes.get(id) }, triggerId)

it('creates the supervisor desk with superagent_submit as its only own tool, and registers the superagent Source', () => {
  expect(h.agents.has(h.runtime.deskId)).toBe(true)
  // VsSaros addition (2026-11-06): and the ticket-end card's tool, which SuperAgent calls itself.
  expect([...h.tools.get(h.runtime.deskId)!.keys()]).toEqual(['superagent_submit', RECEIPT_TOOL])
  expect(h.runtime.sources.kind(SUPERAGENT_SOURCE)?.title.zh).toBe('SuperAgent 主管')
  expect(h.runtime.health[SUPERAGENT_SOURCE]?.state).toBe('ready')
})

// VsSaros addition (2026-11-06): a desk ticket's end shows in the desk, as DeepSeek-Bot's answer comes back to whoever asked.
it('tells the desk once when a ticket begun there ends, and the desk shows it with its end card and one line, without its model', async () => {
  listSuperagent()
  const desk = () => h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === h.runtime.deskId)
  const { ticket } = await h.acceptedTicket(deskTrigger({ session: h.runtime.deskId, messageId: 'desk-end-1', text: '做个番茄钟 H5', at: new Date().toISOString() }))
  h.deliveries.mockClear()
  h.runtime.engine.stopTicket(ticket.id, '不做了')
  await h.runtime.idle()
  await h.runtime.deskOutbox.flush()
  const ended = h.runtime.store.tickets.get(ticket.id)!.ended!
  const notice = `ticket-ended:${ticket.id}:${ended.at}`
  expect(desk()).toEqual([expect.objectContaining({ mode: 'queue', text: `[SuperAgent] 【工单结束】「${ticket.title}」已停止：不做了` })])
  expect(h.runtime.deskOutbox.entry(notice)?.state).toBe('recorded')
  // The desk's conversation names it by its DSH message id; the outbox says which ticket's end it is.
  expect(h.runtime.deskOutbox.messageOf(desk()[0]!.id)).toMatchObject({ id: notice, ticketId: ticket.id })
  // Its card's tool reads how the ticket ended.
  expect(await h.runTool(h.runtime.deskId, RECEIPT_TOOL, { ticket: ticket.id })).toMatchObject({ receipt: true, ticket: ticket.id,
    trigger: ticket.origin.triggerId, title: ticket.title, outcome: 'stopped', outcomeText: '已停止', summary: '不做了' })
  expect(await h.runTool(h.runtime.deskId, RECEIPT_TOOL, { ticket: 'no-such' })).toMatchObject({ found: false })
  // The same end is not told twice.
  h.runtime.outbox.send(ticketEndedNotice(h.runtime.store.tickets.get(ticket.id)!, ticket.channels[0])!)
  await h.runtime.idle()
  await h.runtime.deskOutbox.flush()
  expect(desk()).toHaveLength(1)
})

it('tells the desk only of tickets begun in the desk, and only once they ended', () => {
  const base = { id: 'tk-9', title: '番茄钟', origin: { triggerId: 'superagent:desk:m9' }, assignments: [], channels: [] } as unknown as Ticket
  const desk = { source: SUPERAGENT_SOURCE, thread: 'superagent:desk:d1', address: { kind: 'desk', session: 'd1' } }
  const ended = { ...base, ended: { at: '2026-11-06T10:00:00.000Z', by: 'human', outcome: 'completed' } } as Ticket
  expect(ticketEndedNotice(base, desk)).toBeUndefined()
  expect(ticketEndedNotice(ended, { source: 'feishu', thread: 'feishu:c:1', address: {} } as never)).toBeUndefined()
  expect(ticketEndedNotice(ended, undefined)).toBeUndefined()
  expect(ticketEndedNotice(ended, desk)).toMatchObject({ id: 'ticket-ended:tk-9:2026-11-06T10:00:00.000Z', kind: 'notice', ticketId: 'tk-9',
    text: '【工单结束】「番茄钟」已完成。' })
  expect(receiptText([receiptView(ended), undefined])).toBe('**工单已结束 · 已完成**　「番茄钟」\n\n这张工单的结束情况没读到，可以到 SuperAgent 工作台的「工作」页查看。')
})

it('answers only a turn of nothing but ticket-end notices in the desk: a call of the card\'s tool, then one line after its result', async () => {
  const drain = async (value: unknown) => { const out: Record<string, unknown>[] = []; for await (const chunk of value as AsyncIterable<Record<string, unknown>>) out.push(chunk); return out }
  const MODEL = Symbol('model')
  const ends: Record<string, string> = { 'm-end': 'tk-1', 'm-end-2': 'tk-2' }
  const stream = deskReceiptStream({ deskId: 'desk-1', ticketEndedOf: id => ends[id] }, () => 'u-1')
  const tools = [{ name: 'superagent_submit' }, { name: RECEIPT_TOOL }]
  const notice = (id: string) => ({ id, role: 'user', source: { kind: 'dsh-superagent' }, content: [{ type: 'text', text: '[SuperAgent] 【工单结束】…' }] })
  const context = { role: 'user', source: { kind: 'time-context' }, content: 'now' }
  const history = [{ role: 'user', source: { kind: 'user' } }, { role: 'assistant' }]
  // Another Session, a side request, a person's message, or another notice: the model, as before.
  expect(stream({ sessionId: 'other', messages: [...history, notice('m-end')], tools }, () => MODEL)).toBe(MODEL)
  expect(stream({ sessionId: 'desk-1', purpose: 'title', messages: [...history, notice('m-end')], tools }, () => MODEL)).toBe(MODEL)
  expect(stream({ sessionId: 'desk-1', messages: [...history, notice('m-end'), { role: 'user', source: { kind: 'user' } }], tools }, () => MODEL)).toBe(MODEL)
  expect(stream({ sessionId: 'desk-1', messages: [...history, notice('m-proposal')], tools }, () => MODEL)).toBe(MODEL)
  expect(stream({ sessionId: 'desk-1', messages: [...history, notice('m-end')], tools: [{ name: 'superagent_submit' }] }, () => MODEL)).toBe(MODEL)
  // Only ticket ends (two at once): one call each, no model.
  const calls = await drain(stream({ sessionId: 'desk-1', messages: [...history, notice('m-end'), context, notice('m-end-2')], tools }, () => { throw new Error('no model') }))
  expect(calls.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)).toEqual([
    { type: 'tool-call', id: `${RECEIPT_CALL_PREFIX}u1`, name: RECEIPT_TOOL, arguments: '{"ticket":"tk-1"}' },
    { type: 'tool-call', id: `${RECEIPT_CALL_PREFIX}u1`, name: RECEIPT_TOOL, arguments: '{"ticket":"tk-2"}' }])
  expect(calls.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  // After the results: the line that stays when the turn folds.
  const view = { receipt: true, ticket: 'tk-1', trigger: 't', title: '番茄钟', outcome: 'completed', outcomeText: '已完成', summary: '已上线', at: 'x' }
  const result = (text: string, isError = false) => ({ role: 'tool', toolCallId: `${RECEIPT_CALL_PREFIX}u1`, isError, content: [{ type: 'text', text }] })
  const line = await drain(stream({ sessionId: 'desk-1', messages: [...history, notice('m-end'), { role: 'assistant' }, result(JSON.stringify(view))], tools }, () => { throw new Error('no model') }))
  expect(line.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
  expect(line[1]!.text).toBe('**工单已结束 · 已完成**　「番茄钟」\n\n已上线')
  expect(line.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  // The result of another tool (superagent_submit) goes to the model.
  expect(stream({ sessionId: 'desk-1', messages: [...history, { role: 'tool', toolCallId: 'call-1', content: [] }], tools }, () => MODEL)).toBe(MODEL)
})

it('a listed person\'s desk message reaches the main Session as a request', async () => {
  listSuperagent()
  const trigger = deskTrigger({ session: h.runtime.deskId, messageId: 'desk-m1', text: '首页新手引导要上线，帮我组个团队', at: new Date().toISOString() })
  expect(h.runtime.receive(trigger)).toBe('stored')
  await h.runtime.idle()
  expect(reaches(h.runtime.masterId, trigger.id)).toBe(true)
})

it('with no superagent list, a desk message originates nothing', async () => {
  const trigger = deskTrigger({ session: h.runtime.deskId, messageId: 'desk-m2', text: '帮我做个需求', at: new Date().toISOString() })
  h.runtime.receive(trigger)
  await h.runtime.idle()
  expect(reaches(h.runtime.masterId, trigger.id)).toBe(false)
})

// VsSaros addition: the panel's Chat tab is the desk conversation.
it('takes a message from the panel\'s Chat tab as the desk\'s, and shows the conversation with replies to the desk', async () => {
  listSuperagent()
  const sent = await h.api('POST', 'desk/messages', { text: '  首页新手引导要上线  ' })
  expect(sent.body).toMatchObject({ result: 'stored' })
  await h.runtime.idle()
  const id = (sent.body as { id: string }).id
  expect(id).toMatch(/^superagent:desk:panel-/)
  expect(reaches(h.runtime.masterId, id)).toBe(true)
  // Recorded in the desk Session too, without waking it.
  expect(h.agents.get(h.runtime.deskId)!.inject).toHaveBeenCalled()
  // A reply to the desk is logged, also when the same message is delivered again.
  const reply = { id: 'm-ack', channel: { source: SUPERAGENT_SOURCE, thread: h.runtime.deskChat.thread, address: { kind: 'desk', session: h.runtime.deskId } },
    text: '已接单：「首页新手引导上线」。', kind: 'acknowledgement' as const }
  h.runtime.deskChat.logReply(reply, new Date(Date.now() + 1000).toISOString())
  h.runtime.deskChat.logReply({ ...reply, text: 'changed' })
  const shown = await h.api('GET', 'desk/messages')
  expect(shown.body).toMatchObject({ deskId: h.runtime.deskId, messages: [
    { id, role: 'person', text: '首页新手引导要上线' },
    { id: 'm-ack', role: 'superagent', text: '已接单：「首页新手引导上线」。', kind: 'acknowledgement' }] })
  expect((await h.api('POST', 'desk/messages', { text: '   ' })).status).toBeGreaterThanOrEqual(400)
})

it('shows why a desk message was not handed to the supervisor', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, [SUPERAGENT_SOURCE]: { enabled: true, config: { desk: false, bots: true } } } })
  const sent = await h.api('POST', 'desk/messages', { text: '帮我看下飞书群' })
  expect(sent.body).toMatchObject({ result: 'filtered' })
  const shown = await h.api('GET', 'desk/messages')
  expect(shown.body).toMatchObject({ messages: [{ role: 'person', text: '帮我看下飞书群', filtered: { code: 'superagent_desk_off' } }] })
})

// VsSaros addition: the composer's attachments and scheduled messages.
it('keeps an attached file in the state directory, under a safe name, and refuses one too large', async () => {
  const kept = await h.api('POST', 'desk/files', { name: '../报告:v1.txt', data: Buffer.from('进度').toString('base64') })
  expect(kept.status).toBe(200)
  const file = kept.body as { name: string; path: string; size: number }
  expect(file).toMatchObject({ name: '报告_v1.txt', size: 6 })
  expect(file.path.startsWith(join(h.runtime.machine.stateDir, 'desk-files'))).toBe(true)
  expect(readFileSync(file.path, 'utf8')).toBe('进度')
  expect(() => h.runtime.deskChat.attach('big.bin', Buffer.alloc(DESK_FILE_BYTES + 1))).toThrow(/at most 10 MB/)
})

it('sends a scheduled message when it is due, once, and moves a repeating one to its next time', async () => {
  listSuperagent()
  const now = new Date('2026-11-06T09:00:00')
  const once = h.runtime.deskChat.schedule({ text: '看下昨晚的构建', at: new Date('2026-11-06T09:30:00').toISOString(), repeat: 'none' }, now)
  const daily = h.runtime.deskChat.schedule({ text: '汇总进度', at: new Date('2026-11-06T08:00:00').toISOString(), repeat: 'weekdays' }, now)
  // A weekday schedule whose time passed today starts on the next working day (Friday → Monday).
  expect(new Date(daily.at).getDay()).toBe(1)
  expect(() => h.runtime.deskChat.schedule({ text: 'x', at: new Date('2026-11-05T09:00:00').toISOString(), repeat: 'none' }, now)).toThrow(/passed/)
  expect(await h.runtime.deskChat.runDue(new Date('2026-11-06T09:29:00'))).toBe(0)
  expect(await h.runtime.deskChat.runDue(new Date('2026-11-06T09:31:00'))).toBe(1)
  expect(await h.runtime.deskChat.runDue(new Date('2026-11-06T09:32:00'))).toBe(0)
  expect(h.runtime.deskChat.schedules().map(entry => entry.id)).toEqual([daily.id])
  expect(await h.runtime.deskChat.runDue(new Date('2026-11-09T08:01:00'))).toBe(1)
  expect(new Date(h.runtime.deskChat.schedules()[0]!.at)).toEqual(new Date('2026-11-10T08:00:00'))
  await h.runtime.idle()
  const sent = (await h.api('GET', 'desk/messages')).body as { messages: { text: string }[] }
  expect(sent.messages.map(message => message.text)).toEqual(['[定时任务] 看下昨晚的构建', '[定时任务] 汇总进度'])
  expect(reaches(h.runtime.masterId, `superagent:desk:`)).toBe(true)
  expect(once.repeat).toBe('none')
  expect((await h.api('POST', `desk/schedules/${daily.id}/delete`)).body).toEqual({ deleted: true })
  expect(h.runtime.deskChat.schedules()).toEqual([])
})

// VsSaros addition: the Chat tab shows the desk in DSH's own chat; what a person types there is the desk's at once.
it('takes a message typed in the desk\'s own chat box without waiting for the desk\'s model, once', async () => {
  listSuperagent()
  const event = { type: 'user/message', data: { id: 'dsh-m1', source: { kind: 'user' }, content: [{ type: 'text', text: '首页新手引导要上线' }] } }
  const emit = (h.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit.bind(h.ctx)
  emit('session/event', { id: h.runtime.deskId }, event)
  // A message the desk was told, such as a reply, is not the person's.
  emit('session/event', { id: h.runtime.deskId }, { type: 'user/message', data: { id: 'dsh-m2', source: { kind: 'plugin' }, content: [{ type: 'text', text: '[SuperAgent] 收到' }] } })
  await tick()
  await h.runtime.idle()
  expect(reaches(h.runtime.masterId, 'superagent:desk:dsh-m1')).toBe(true)
  expect(reaches(h.runtime.masterId, 'superagent:desk:dsh-m2')).toBe(false)
  // The desk's tool, called for the same message, finds it handed over.
  expect(h.runtime.receive(deskTrigger({ session: h.runtime.deskId, messageId: 'dsh-m1', text: '首页新手引导要上线', at: new Date().toISOString() })))
    .toBe('duplicate')
})

// VsSaros fix (2026-11-05): the supervisor's replies reach the person in the desk's conversation. They were injected, which
// DSH keeps in an idle desk's inbox out of sight, so a team proposal waited for an answer nobody had seen. Now what needs the
// person wakes the desk through its outbox; progress is only logged for the panel.
it('wakes today\'s desk only with what needs the person, and keeps it in the outbox until the desk\'s conversation has it', async () => {
  const channel = (session: string) => ({ source: SUPERAGENT_SOURCE, thread: `superagent:desk:${session}`, address: { kind: 'desk', session } })
  const desk = () => h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === h.runtime.deskId)
  // An acknowledgement is progress: logged for the panel, no model turn.
  h.runtime.outbox.send({ id: 'ack-1', channel: channel(h.runtime.deskId), kind: 'acknowledgement', ticketId: 't1', text: '正在组建开发团队。' })
  await h.runtime.idle()
  await h.runtime.deskOutbox.flush()
  expect(desk()).toEqual([])
  expect(h.runtime.deskOutbox.entry('ack-1')).toBeUndefined()
  expect(h.runtime.deskChat.messages().map(item => item.id)).toContain('ack-1')
  // A ticket begun at an earlier desk (the incubating plugin's) still answers in today's desk, the one the workbench shows.
  h.runtime.outbox.send({ id: 'team-proposal:t1:v1', channel: channel('desk-old'), kind: 'notice', ticketId: 't1', text: '【组队方案 v1】番茄钟 H5' })
  await h.runtime.idle()
  await h.runtime.deskOutbox.flush()
  expect(desk()).toEqual([expect.objectContaining({ mode: 'queue', text: '[SuperAgent] 【组队方案 v1】番茄钟 H5' })])
  expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === 'desk-old')).toBe(false)
  expect(h.agents.get(h.runtime.deskId)!.inject).not.toHaveBeenCalled()
  // The idle desk took it into a turn at once: its conversation has it.
  expect(h.runtime.deskOutbox.entry('team-proposal:t1:v1')?.state).toBe('recorded')
  // The desk is busy now: the next one waits in its inbox, pending, and the Session closes with it there.
  h.runtime.outbox.send({ id: 'reply-1', channel: channel(h.runtime.deskId), kind: 'reply', ticketId: 't1', text: '要用 Vue 还是原生？' })
  await h.runtime.idle()
  await h.runtime.deskOutbox.flush()
  expect(h.runtime.deskOutbox.entry('reply-1')?.state).toBe('pending')
  const agent = h.agents.get(h.runtime.deskId)!
  agent.inbox.nextTurn.length = 0
  agent.status = 'idle'
  await h.runtime.deskOutbox.flush()
  expect(desk().map(call => call.text)).toEqual(['[SuperAgent] 【组队方案 v1】番茄钟 H5', '[SuperAgent] 要用 Vue 还是原生？', '[SuperAgent] 要用 Vue 还是原生？'])
  expect(h.runtime.deskOutbox.pending()).toEqual([])
})

// VsSaros P0 (2026-11-05): a group request typed in the desk is made synchronously, not by the orchestrator model.
it('makes a group at desk intake, records ignore, and never relays the candidate to the main Session', async () => {
  listSuperagent()
  const key = Symbol.for('vssaros.team')
  const globals = globalThis as unknown as Record<symbol, unknown>
  const previous = globals[key]
  const createGroup = vi.fn(async () => ({
    id: 'room-fast', sessionId: 'room-fast', name: '番茄钟 H5 开发团队',
    members: [{ id: 'coder', name: 'Coder' }, { id: 'designer', name: 'Designer' }, { id: 'code-reviewer', name: 'Code Reviewer' }],
    admin: 'coder', mode: 'admin', notice: '', pinned: false, hidden: false, createdBy: 'superagent',
  }))
  globals[key] = {
    version: 1,
    available: () => true,
    listBots: async () => [
      { id: 'coder', name: 'Coder', description: '', skills: [], tools: [], delegatable: true, source: 'builtin' },
      { id: 'designer', name: 'Designer', description: '', skills: [], tools: [], delegatable: true, source: 'builtin' },
      { id: 'code-reviewer', name: 'Code Reviewer', description: '', skills: [], tools: [], delegatable: true, source: 'builtin' },
    ],
    delegate: async () => ({}), get: async () => undefined, cancel: async () => ({}), subscribe: () => () => undefined,
    createGroup,
  }
  try {
    const text = '创建开发团队，制作一个番茄钟 H5应用'
    const trigger = deskTrigger({ session: h.runtime.deskId, messageId: 'dsh-fast', text, at: new Date().toISOString() })
    const event = { type: 'user/message', data: { id: 'dsh-fast', source: { kind: 'user' }, content: [{ type: 'text', text }] } }
    const emit = (h.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit.bind(h.ctx)
    emit('session/event', { id: h.runtime.deskId }, event)
    await tick()
    await h.runtime.idle()
    await h.runtime.deskOutbox.flush()
    expect(createGroup).toHaveBeenCalledOnce()
    expect(createGroup).toHaveBeenCalledWith(expect.objectContaining({ originTriggerId: trigger.id, mode: 'admin' }))
    const decisions = h.runtime.store.db.prepare('SELECT value FROM decision WHERE value LIKE ?').all('%Synchronous group chat created%')
    expect(decisions).toHaveLength(1)
    expect(h.candidates()).not.toContain(trigger.id)
    expect((h.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM ticket').get() as { n: number }).n).toBe(0)
    expect(h.runtime.deskChat.messages().some(item => item.id === 'group-created:room-fast')).toBe(true)
    // The group, its ignore decision and its notice were committed together, and the desk card shows the group, not a refusal.
    expect(h.runtime.groupRoutes.get(trigger.id)).toMatchObject({ roomId: 'room-fast', roomName: '番茄钟 H5 开发团队', kind: 'created' })
    expect(flowOf(trigger.id)).toMatchObject({ state: 'group', group: { roomId: 'room-fast', kind: 'created' } })
  } finally {
    if (previous === undefined) { delete globals[key] } else { globals[key] = previous }
  }
})

// P0 batch 1: @existing group is routed by the agents plugin; SuperAgent must not spend a main-Session model evaluation.
it('records an @existing-group message as ignored at intake and never relays it to the main Session', async () => {
  listSuperagent()
  const key = Symbol.for('vssaros.team')
  const globals = globalThis as unknown as Record<symbol, unknown>
  const previous = globals[key]
  const createGroup = vi.fn(async () => { throw new Error('must not create another group') })
  const room = {
    id: 'room-existing', sessionId: 'room-existing', name: '番茄钟 H5 开发团队',
    members: [{ id: 'coder', name: 'Coder' }, { id: 'designer', name: 'Designer' }],
    admin: 'coder', mode: 'admin', notice: '', pinned: false, hidden: false, createdBy: 'superagent',
  }
  globals[key] = {
    version: 1,
    available: () => true,
    listBots: async () => [],
    delegate: async () => ({}), get: async () => undefined, cancel: async () => ({}), subscribe: () => () => undefined,
    createGroup, listGroups: async () => [room],
  }
  try {
    const text = '@番茄钟 H5 开发团队 开始制作番茄钟H5 应用'
    const trigger = deskTrigger({ session: h.runtime.deskId, messageId: 'dsh-ref', text, at: new Date().toISOString() })
    const emit = (h.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit.bind(h.ctx)
    emit('session/event', { id: h.runtime.deskId }, { type: 'user/message', data: {
      id: 'dsh-ref', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    emit('session/event', { id: h.runtime.deskId }, { type: 'user/message', data: {
      id: 'ref-dsh-ref', role: 'user', source: { kind: 'session-reference', form: 'recall', version: 1,
        references: [{ sessionId: 'room-existing', label: '番茄钟 H5 开发团队' }] },
      content: [{ type: 'text', text: '## Referenced sessions' }] } })
    await tick()
    await h.runtime.idle()
    const decisions = h.runtime.store.db.prepare('SELECT value FROM decision WHERE value LIKE ?').all('%Routed to existing group%')
    expect(decisions).toHaveLength(1)
    expect(createGroup).not.toHaveBeenCalled()
    expect(h.candidates()).not.toContain(trigger.id)
    expect((h.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM ticket').get() as { n: number }).n).toBe(0)
    expect(h.runtime.deskChat.messages().some(item => String(item.id).startsWith('group-created:'))).toBe(false)
    expect(h.runtime.groupRoutes.get(trigger.id)).toMatchObject({ roomId: 'room-existing', kind: 'routed', sourceMessageId: 'dsh-ref' })
    expect(flowOf(trigger.id)).toMatchObject({ state: 'group', group: { roomId: 'room-existing', kind: 'routed', sourceMessageId: 'dsh-ref' } })
  } finally {
    if (previous === undefined) { delete globals[key] } else { globals[key] = previous }
  }
})

// VsSaros fix (2026-11-06, real run): the desk is one Thread for every request. 28 minutes after a desk ticket ended, the
// person's 「@番茄钟 H5 开发团队 开发H5 番茄钟」 resumed it (its worker read it, said it had nothing to do and ended it again,
// telling the desk so), while the group took the message too and its ignore decision was refused (workerDecides).
it('resumes no ended ticket from the desk, still reaches a live one there, and gives an @group message to no ticket', async () => {
  listSuperagent()
  const key = Symbol.for('vssaros.team')
  const globals = globalThis as unknown as Record<symbol, unknown>
  const previous = globals[key]
  const room = { id: 'room-tomato', sessionId: 'room-tomato', name: '番茄钟 H5 开发团队', members: [{ id: 'coder', name: 'Coder' }],
    admin: 'coder', mode: 'admin', notice: '', pinned: false, hidden: false, createdBy: 'superagent' }
  globals[key] = { version: 1, available: () => true, listBots: async () => [], delegate: async () => ({}), get: async () => undefined,
    cancel: async () => ({}), subscribe: () => () => undefined, createGroup: vi.fn(), listGroups: async () => [room] }
  try {
    const desk = (messageId: string, text: string) => deskTrigger({ session: h.runtime.deskId, messageId, text, at: new Date().toISOString() })
    const done = await h.acceptedTicket(desk('desk-done', '读 README 写三句摘要'))
    await h.runTool(done.sessionId, 'orchestrator_report', { state: 'ready', summary: '摘要写好了' })
    expect(h.runtime.store.tickets.get(done.ticket.id)!.ended).toMatchObject({ by: 'executor' })
    // A new request on the desk is the supervisor's to assess, not the ended ticket's.
    const live = await h.acceptedTicket(desk('desk-live', '做一个番茄钟 H5'))
    expect(h.runtime.store.tickets.get(done.ticket.id)!.ended).toBeDefined()
    expect(h.runtime.store.triggers.disposition(live.trigger.id)!.fanout).toEqual([])
    // A message while a desk ticket works still reaches it (agreeing to its team, steering it, stopping it).
    const steer = desk('desk-steer', '番茄钟改成 25 分钟')
    h.runtime.receive(steer); await h.runtime.idle()
    expect(h.runtime.store.triggers.disposition(steer.id)!.fanout).toEqual([live.ticket.id])
    expect(h.runtime.store.tickets.get(done.ticket.id)!.ended).toBeDefined()
    // A message to a group reaches no ticket, and its ignore decision holds.
    h.deliveries.mockClear()
    const text = '@番茄钟 H5 开发团队 开发H5 番茄钟'
    const emit = (h.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit.bind(h.ctx)
    emit('session/event', { id: h.runtime.deskId }, { type: 'user/message', data: { id: 'dsh-group', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    emit('session/event', { id: h.runtime.deskId }, { type: 'user/message', data: { id: 'ref-dsh-group', role: 'user',
      source: { kind: 'session-reference', form: 'recall', version: 1, references: [{ sessionId: 'room-tomato', label: room.name }] },
      content: [{ type: 'text', text: '## Referenced sessions' }] } })
    await tick()
    await h.runtime.idle()
    const group = desk('dsh-group', text)
    expect(h.runtime.store.triggers.disposition(group.id)).toMatchObject({ fanout: [] })
    expect(reaches(live.sessionId, group.id)).toBe(false)
    expect(h.runtime.store.db.prepare('SELECT value FROM decision WHERE value LIKE ?').all(`%${group.id}%`)
      .map(row => JSON.parse(String(row.value)).kind)).toEqual(['ignore'])
    expect(flowOf(group.id)).toMatchObject({ state: 'group', group: { roomId: 'room-tomato', kind: 'routed' } })
    expect(h.runtime.store.tickets.get(done.ticket.id)!.ended).toBeDefined()
  } finally {
    if (previous === undefined) { delete globals[key] } else { globals[key] = previous }
  }
})

// 2026-11-06: the agents plugin pairs "message + session reference" within 15s. A reference that arrives after the desk's
// wait used to leave the message with the supervisor while the group took it too; now the desk settles it late as well.
it('settles an @existing-group message whose session reference arrives after the wait, so it is not handled twice', async () => {
  listSuperagent()
  const key = Symbol.for('vssaros.team')
  const globals = globalThis as unknown as Record<symbol, unknown>
  const previous = globals[key]
  const room = {
    id: 'room-late', sessionId: 'room-late', name: '番茄钟 H5 开发团队',
    members: [{ id: 'coder', name: 'Coder' }, { id: 'designer', name: 'Designer' }],
    admin: 'coder', mode: 'admin', notice: '', pinned: false, hidden: false, createdBy: 'superagent',
  }
  globals[key] = { version: 1, available: () => true, listBots: async () => [], delegate: async () => ({}), get: async () => undefined,
    cancel: async () => ({}), subscribe: () => () => undefined, createGroup: vi.fn(), listGroups: async () => [room] }
  try {
    const text = '@番茄钟 H5 开发团队 开始制作'
    const trigger = deskTrigger({ session: h.runtime.deskId, messageId: 'dsh-late', text, at: new Date().toISOString() })
    const emit = (h.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit.bind(h.ctx)
    emit('session/event', { id: h.runtime.deskId }, { type: 'user/message', data: { id: 'dsh-late', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    await tick(GROUP_REFERENCE_WAIT_MS + 200)
    await h.runtime.idle()
    expect(h.runtime.groupRoutes.get(trigger.id)).toBeUndefined()
    emit('session/event', { id: h.runtime.deskId }, { type: 'user/message', data: {
      id: 'ref-dsh-late', role: 'user', source: { kind: 'session-reference', form: 'recall', version: 1,
        references: [{ sessionId: 'room-late', label: '番茄钟 H5 开发团队' }] }, content: [{ type: 'text', text: '## Referenced sessions' }] } })
    await tick()
    await h.runtime.idle()
    const decisions = h.runtime.store.db.prepare('SELECT value FROM decision WHERE value LIKE ?').all('%late reference%')
    expect(decisions).toHaveLength(1)
    expect(h.runtime.groupRoutes.get(trigger.id)).toMatchObject({ roomId: 'room-late', kind: 'routed', sourceMessageId: 'dsh-late' })
    expect(flowOf(trigger.id).state).toBe('group')
    expect((h.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM ticket').get() as { n: number }).n).toBe(0)
  } finally {
    if (previous === undefined) { delete globals[key] } else { globals[key] = previous }
  }
})

it('takes a desk message that cannot be a group command (no leading @) at once, without waiting for a reference', async () => {
  listSuperagent()
  const text = '首页新手引导要上线，帮我看看'
  const trigger = deskTrigger({ session: h.runtime.deskId, messageId: 'dsh-now', text, at: new Date().toISOString() })
  const emit = (h.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit.bind(h.ctx)
  emit('session/event', { id: h.runtime.deskId }, { type: 'user/message', data: { id: 'dsh-now', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  await tick(5)
  expect(h.runtime.store.triggers.get(trigger.id)).toBeDefined()
})
