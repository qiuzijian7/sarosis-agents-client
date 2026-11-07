// VsSaros addition (2026-11-07, P0 · co-install semantics): with DS Bot in the same Host, SuperAgent's own guarantees still
// hold — the only risk that exists because SuperAgent is made to live next to DS Bot. A fake DS Bot made the way ds-bot 0.2.7
// acts on every Session (tests/fixtures/ds-bot.ts) runs after SuperAgent, and:
//   ① each model call is counted once in usage_call (and in a team's token budget), whether DS Bot sent it again or read its
//     images on the side, and those calls are told apart and shown (GET usage, a ticket's page);
//   ② a team step's tool call is still decided by step_approval_rule (never by DS Bot's approval answerer, which hands on
//     every Session not its own), after DS Bot rewrote and sent again the request that made it;
//   ③ DS Bot's global skills reach DSH's skill catalog only: none of SuperAgent's prompt sections or skills, never the desk,
//     and a bounded addition to the catalog the main Session sees;
//   ④ team_distill's evidence is still the step that ran: its Session, its report and its turns, not DS Bot's extra calls.
// And the side effect can be turned off: `executor.sideCalls` off refuses DS Bot's OCR in SuperAgent's Sessions.
import { afterEach, expect, it, vi } from 'vitest'
import { MEMORY_BUS_KEY, type MemoryBus, type StepEvidence } from '../src/app/distill.ts'
import { stepSessionId } from '../src/app/steps.ts'
import type { UsageCall } from '../src/app/usage.ts'
import { waitUntil } from './fixtures/async.ts'
import { catalogLine, drain, DS_BOT_SKILLS, DSH_CATALOG_DESCRIPTION_MAX, fakeModel, installFakeDsBot, user, withImage } from './fixtures/ds-bot.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
let dsBot: ReturnType<typeof installFakeDsBot> | undefined
const root = globalThis as unknown as Record<symbol, unknown>
afterEach(async () => { dsBot?.dispose(); dsBot = undefined; await h?.stop(); h = undefined; delete root[MEMORY_BUS_KEY] })

const SECRET = 'sk-live-7f3a9c'
/** The most DS Bot's skills may add to a Session's skill catalog: its three lines (~600 characters) and a little room. */
const DS_BOT_CATALOG_CHARS = 800
let clock = 0
const reply = (id: string, text: string) => feishu(id, text, { mentions: [], root_id: 'om_1', create_time: String(Date.now() + 1000 + (clock += 1000)) })
/** A designer's read-only step and a builder's write step after it. */
const TEAM = {
  roles: [{ key: 'design', need: '交互稿', bot: 'designer' }, { key: 'build', need: '实现', bot: 'builder' }],
  steps: [{ key: 'T1', role: 'design', title: '交互稿', spec: '出稿' }, { key: 'T2', role: 'build', title: '实现浮层', spec: '写代码', after: ['T1'], access: 'write' }],
}
const loader = (names: string[]) => ({ *entries() { for (const name of names) yield { options: { name } } } })
/**
 * A Host with DS Bot, with a ticket whose team a person agreed to (its first step running). DS Bot runs after SuperAgent, or
 * `first`, as a plugin the Host loaded earlier: SuperAgent's listeners are `prepend`ed, so either way they come first.
 */
async function agreedWithDsBot(model = fakeModel(), first = false) {
  const install = (ctx: unknown) => { dsBot = installFakeDsBot(ctx, model.model, { secrets: [SECRET], own: ['ds-bot-session'] }) }
  h = await startRuntime(undefined, { staffing: true, ...first ? { before: install } : {} })
  h.ctx.reflect.provide('loader', loader(['vssaros-agents', 'ds-bot']) as never)
  if (!first) install(h.ctx)
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 首页新手引导要上线'))
  await h.runTool(h.runtime.masterId, 'orchestrator_team_propose', { ticket_id: ticket.id, ...TEAM })
  await new Promise(resolve => setTimeout(resolve, 5))
  const yes = reply('2', '同意'); h.runtime.receive(yes); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_team_confirm', { ticket_id: ticket.id, trigger_id: yes.id, version: 1 })
  await h.runtime.idle()
  await waitUntil(() => h!.runtime.steps.tables.get(ticket.id, 'T1')?.state === 'running')
  return { ticketId: ticket.id, model }
}
const callsOf = (session: string) => h!.runtime.store.db.prepare('SELECT value FROM usage_call WHERE session=? ORDER BY id').all(session)
  .map(row => JSON.parse(String(row.value)) as UsageCall)
/** One of a Session's requests, as DSH would send it; DS Bot's listeners act on it on the way. */
const ask = (sessionId: string, message = user('继续')) => drain(dsBot!.stream({ sessionId, provider: 'p', model: 'm', messages: [message] }))

it.each([['after', false], ['before', true]] as const)('① counts each model call once, with DS Bot (loaded %s SuperAgent) rewriting a request or reading its images on the side, and tells which', async (_order, first) => {
  const { ticketId, model } = await agreedWithDsBot(fakeModel(), first)
  const master = h!.runtime.masterId, t1 = stepSessionId(ticketId, 'T1')
  await ask(master)
  await ask(master, user(`部署用 ${SECRET}`))
  await ask(t1, withImage('照这张图出稿'))
  // The model got: the plain call, the rewritten one (never the secret), the OCR read and the text in place of the image.
  expect(model.calls.map(call => `${call.sessionId === master ? 'master' : 'T1'}/${call.model}`)).toEqual(['master/m', 'master/m', 'T1/ocr-vl', 'T1/m'])
  expect(JSON.stringify(model.calls)).not.toContain(SECRET)
  expect(model.calls[3]!.messages[0]!.content[1]!.text).toContain('图里是一个番茄钟')
  // One usage_call row a model call, told apart.
  expect(callsOf(master).map(call => call.relay ?? 'own')).toEqual(['own', 'resent'])
  expect(callsOf(t1).map(call => [call.model, call.relay, call.step])).toEqual([['ocr-vl', 'side', 'T1'], ['m', 'resent', 'T1']])
  // The team's token budget heard the step's two calls once each, as the ledger did.
  expect(h!.runtime.steps.tables.get(ticketId, 'T1')!.tokens).toBe(2 * 110)
  // Observable: GET usage and the ticket's page say how often, and that it is DS Bot.
  const usage = (await h!.api('GET', 'usage')).body as unknown as { day: { total: { calls: number }; relays: unknown }; coexist: unknown; sideCalls: boolean }
  expect(usage.day.total.calls).toBe(model.calls.length)
  expect(usage.day.relays).toEqual({ resent: 2, side: 1, sessions: expect.arrayContaining([
    { session: master, role: 'master', resent: 1, side: 0 }, { session: t1, role: 'step', ticketId, step: 'T1', resent: 1, side: 1 }]) })
  expect(usage.coexist).toEqual({ dsBot: { effects: ['secrets', 'images', 'skills'] } })
  expect(usage.sideCalls).toBe(true)
  const page = (await h!.api('GET', `tickets/${ticketId}`)).body as unknown as { relays: unknown; coexist: unknown }
  expect(page.relays).toEqual({ resent: 1, side: 1, sessions: [{ session: t1, role: 'step', ticketId, step: 'T1', resent: 1, side: 1 }] })
  expect(page.coexist).toEqual({ dsBot: { effects: ['secrets', 'images', 'skills'] } })
})

it('① with executor.sideCalls off, refuses DS Bot\'s OCR in SuperAgent\'s Sessions only, and still lets its secrets rewrite go', async () => {
  const { ticketId, model } = await agreedWithDsBot()
  const settings = h!.runtime.store.settings()
  h!.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, sideCalls: false } })
  const t1 = stepSessionId(ticketId, 'T1')
  await ask(t1, withImage(`照这张图出稿，密钥 ${SECRET}`))
  // No OCR call reached a model; DS Bot told the model the image could not be read, and its rewrite still went.
  expect(model.calls.map(call => call.model)).toEqual(['m'])
  expect(dsBot!.ocrFailures).toEqual([expect.stringContaining('executor.sideCalls is off')])
  expect(model.calls[0]!.messages[0]!.content.map(block => block.text).join(' ')).toMatch(/could not be read right now.*\[secret:1\]|\[secret:1\].*could not be read/s)
  expect(callsOf(t1).map(call => call.relay)).toEqual(['resent'])
  // A Session that is not SuperAgent's keeps DS Bot's OCR.
  await ask('ds-bot-session', withImage('看图'))
  expect(model.calls.slice(1).map(call => call.model)).toEqual(['ocr-vl', 'm'])
  expect((await h!.api('GET', 'usage')).body).toMatchObject({ sideCalls: false })
})

it.each([['after', false], ['before', true]] as const)('② decides a team step\'s tool call by step_approval_rule, never by DS Bot (loaded %s SuperAgent), after DS Bot rewrote the request that made it', async (_order, first) => {
  const { ticketId } = await agreedWithDsBot(fakeModel(), first)
  await h!.runTool(stepSessionId(ticketId, 'T1'), 'orchestrator_step_report', { state: 'ready', summary: '5 屏' })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.state === 'running')
  const t2 = stepSessionId(ticketId, 'T2')
  const agentOf = (sessionId: string, command: string) => ({ id: sessionId, session: { header: {},
    snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command }) } }] } })
  const approval = (sessionId: string, command: string) => (h!.ctx as unknown as { waterfall(name: string, request: unknown, next: () => unknown): Promise<string> })
    .waterfall('approval/request', { agent: agentOf(sessionId, command), toolName: 'pwsh', callId: 'c1' }, () => 'unavailable')
  // The step's request carried a saved value: DS Bot sent it again, rewritten, and the model asked for a command.
  await ask(t2, user(`装依赖，token ${SECRET}`))
  expect(callsOf(t2).map(call => call.relay)).toEqual(['resent'])
  const asked = approval(t2, 'pnpm add -D @floating-ui/react')
  const [pending] = h!.runtime.stepApprovals.list()
  expect(pending).toMatchObject({ ticketId, step: 'T2', bot: { id: 'builder' }, tool: 'pwsh' })
  h!.runtime.stepApprovals.answer(pending!.id, 'remember', 'panel')
  expect(await asked).toBe('allowed-once')
  // Rewritten again: the same Bot, tool and command head goes by the rule; another head asks; DS Bot answered none of them.
  await ask(t2, user(`再装一个，token ${SECRET}`))
  expect(await approval(t2, 'pnpm add zod')).toBe('allowed-once')
  void approval(t2, 'git push origin')
  expect(h!.runtime.stepApprovals.list()).toEqual([expect.objectContaining({ step: 'T2', detail: expect.objectContaining({ code: 'git push origin' }) })])
  expect(dsBot!.answered).toEqual([])
  // DS Bot still answers its own Bots' Sessions, which SuperAgent hands on.
  expect(await approval('ds-bot-session', 'rm -rf build')).toBe('approved')
  expect(dsBot!.answered).toEqual(['ds-bot-session'])
})

it('③ keeps DS Bot\'s global skills to DSH\'s skill catalog: out of SuperAgent\'s prompts and skills, out of the desk, bounded', async () => {
  await agreedWithDsBot()
  // As ds-bot registers them: a provider in the global skill registry (office-skills.js:77, goal-skills.js:47).
  const providers: unknown[] = []
  h!.ctx.reflect.provide('skills', { registerProvider: (create: unknown) => { providers.push(create); return () => {} } } as never)
  const registry = (h!.ctx as unknown as { skills: { registerProvider(create: unknown): () => void } }).skills
  registry.registerProvider(() => ({ list: async () => DS_BOT_SKILLS }))
  expect(providers).toHaveLength(1)
  const master = h!.runtime.masterId, desk = h!.runtime.deskId
  // Nothing of DS Bot in SuperAgent's own prompt sections or skills, which its prompt budget (model-surface.spec.ts) measures.
  const textOf = (sessionId: string) => (h!.sections.get(sessionId) ?? []).map(section => typeof section.text === 'function'
    ? String((section.text as (context: object) => unknown)({})) : String(section.text ?? '')).join('\n')
  for (const sessionId of [master, desk]) {
    const text = textOf(sessionId), own = (h!.skills.get(sessionId) ?? []).map(skill => skill.name)
    for (const skill of DS_BOT_SKILLS) {
      expect(text).not.toContain(skill.name)
      expect(own).not.toContain(skill.name)
    }
  }
  expect(textOf(master).length).toBeGreaterThan(1000)
  // The desk masks every tool, `skill` too, so DSH shows it no skill catalog at all.
  const restrict = (h!.agents.get(desk) as unknown as { ctx: { tools: { restrict: { mock: { calls: unknown[][] } } } } }).ctx.tools.restrict
  expect(restrict.mock.calls).toContainEqual([{ allow: [] }])
  // Real machine (2026-11-07): the desk's first step ran before that mask and its history kept the whole catalog (173 skills,
  // 72 KB, DS Bot's among them). No request of the desk carries one: the model gets the rest.
  const sent: unknown[][] = []
  const waterfall = (h!.ctx as unknown as { waterfall(name: string, options: unknown, next: () => unknown): unknown }).waterfall.bind(h!.ctx)
  const catalog = { id: 'cat-1', role: 'user', source: { kind: 'skill-catalog', form: 'catalog', entries: DS_BOT_SKILLS },
    content: [{ type: 'text', text: `<available_skills>\n${DS_BOT_SKILLS.map(catalogLine).join('\n')}\n</available_skills>` }] }
  const news = { id: 'news-1', role: 'user', source: { kind: 'dsh-superagent' }, content: [{ type: 'text', text: '[SuperAgent] 团队方案…' }] }
  for (const sessionId of [desk, master]) {
    const request = { sessionId, provider: 'p', model: 'm', messages: [catalog, news] }
    await drain(waterfall('llm/stream', request, () => { sent.push(request.messages); return fakeModel().model(request as never) }))
  }
  expect(sent).toEqual([[news], [catalog, news]])
  // What DS Bot adds to the catalog the main Session and steps see: three lines, each within DSH's description cap.
  for (const skill of DS_BOT_SKILLS) expect(skill.description.length).toBeLessThanOrEqual(DSH_CATALOG_DESCRIPTION_MAX)
  const added = DS_BOT_SKILLS.map(catalogLine).join('\n').length
  expect(added, `DS Bot adds ${added} characters to the skill catalog`).toBeLessThanOrEqual(DS_BOT_CATALOG_CHARS)
})

it('④ hands team_distill the evidence of the step that ran, whatever DS Bot sent again inside it', async () => {
  const given: StepEvidence[] = []
  root[MEMORY_BUS_KEY] = { version: 1, available: vi.fn(() => true),
    rememberStep: vi.fn(async (evidence: StepEvidence) => { given.push(evidence); return { fact: { ok: true, message: '已追加' } } }),
    decideSkillDraft: vi.fn(async (name: string) => ({ name, state: 'active' as const })) } satisfies MemoryBus
  const { ticketId } = await agreedWithDsBot()
  const t1 = stepSessionId(ticketId, 'T1'), t2 = stepSessionId(ticketId, 'T2')
  // T1 made three requests; DS Bot rewrote one and read the images of another on the side: five model calls in T1's Session.
  await ask(t1); await ask(t1, user(`读配置 ${SECRET}`)); await ask(t1, withImage('照这张图出稿'))
  expect(callsOf(t1)).toHaveLength(4)
  await h!.runTool(t1, 'orchestrator_step_report', { state: 'ready', summary: '交互稿 5 屏' })
  await waitUntil(() => h!.runtime.steps.tables.get(ticketId, 'T2')?.state === 'running')
  await ask(t2)
  await h!.runTool(t2, 'orchestrator_step_report', { state: 'ready', summary: '浮层已实现' })
  await waitUntil(() => given.length === 2)
  const step = h!.runtime.steps.tables.get(ticketId, 'T1')!
  expect(given.map(item => [item.stepKey, item.sessionId, item.botId, item.report])).toEqual([
    ['T1', t1, 'designer', '交互稿 5 屏'], ['T2', t2, 'builder', '浮层已实现']])
  // Its turns are the step's own (turn ends), not the model calls DS Bot added.
  expect(given[0]!.turns).toBe(step.turns)
  expect(given[0]!.turns).toBeLessThan(callsOf(t1).length)
  // The calls DS Bot added are recorded on the same step the evidence names.
  expect(callsOf(t1).filter(call => call.relay).every(call => call.ticketId === given[0]!.ticketId && call.step === given[0]!.stepKey)).toBe(true)
})
