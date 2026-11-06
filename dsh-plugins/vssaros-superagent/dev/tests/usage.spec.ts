// VsSaros addition (2026-11-06, P2): the usage ledger of SuperAgent's Sessions, the context steward that compacts the two
// long-lived ones while idle, and approval rule templates.
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { checkLineOf, ContextSteward, STEWARD_COOLDOWN_MS, type StewardHost } from '../src/app/steward.ts'
import { stepSessionId } from '../src/app/steps.ts'
import { APPROVAL_TEMPLATES, covers } from '../src/app/step-approvals.ts'
import { USAGE_KEEP_DAYS, UsageLedger, type UsageCall } from '../src/app/usage.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
let clock = 0
const reply = (id: string, text: string) => feishu(id, text, { mentions: [], root_id: 'om_1', create_time: String(Date.now() + 1000 + (clock += 1000)) })
/** A ticket whose team (one step, `designer`'s) a person agreed to, with its lead running. */
async function agreed() {
  h = await startRuntime(undefined, { staffing: true })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 首页新手引导要上线'))
  await h.runTool(h.runtime.masterId, 'orchestrator_team_propose', { ticket_id: ticket.id,
    roles: [{ key: 'design', need: '交互稿', bot: 'designer' }], steps: [{ key: 'T1', role: 'design', title: '交互稿', spec: '出稿' }] })
  await new Promise(resolve => setTimeout(resolve, 5))
  const yes = reply('2', '同意'); h.runtime.receive(yes); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_team_confirm', { ticket_id: ticket.id, trigger_id: yes.id, version: 1 })
  await h.runtime.idle()
  return { ticketId: ticket.id, lead: sessionId }
}
const model = (usage: Record<string, number>) => async function* () { yield { type: 'text-delta', text: 'x' }; yield { type: 'usage', usage } }
const drain = async (stream: unknown) => { for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ } }

it('records the calls of SuperAgent\'s own Sessions only, sums them by role, model, Bot and ticket, and keeps 30 days', async () => {
  let now = Date.parse('2026-11-06T10:00:00.000Z')
  const db = new DatabaseSync(':memory:')
  const ledger = new UsageLedger(db, id => id === 'master' ? { role: 'master' } : id.startsWith('step-') ? { role: 'step', ticketId: 't1', step: 'T1', bot: '设计' } : undefined, () => now)
  const listen = ledger.listener()
  await drain(listen({ sessionId: 'master', provider: 'p', model: 'm1' }, model({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 20 })))
  await drain(listen({ sessionId: 'master', provider: 'p', model: 'm1', purpose: 'compaction' }, model({ inputTokens: 50, outputTokens: 5 })))
  await drain(listen({ sessionId: 'step-t1-T1', provider: 'p', model: 'm2' }, model({ inputTokens: 10, outputTokens: 1 })))
  const other = model({ inputTokens: 7 })()
  expect(listen({ sessionId: 'someone-else' }, () => other)).toBe(other)
  expect(ledger.record({ sessionId: 'master' }, { inputTokens: 0 })).toBeUndefined()
  // The last conversation call is the one before the compaction.
  expect(ledger.last('master')).toMatchObject({ input: 100, cacheRead: 900, output: 20 })
  const day = ledger.summary('2026-11-05T10:00:00.000Z')
  expect(day.total).toEqual({ calls: 3, input: 160, cacheRead: 900, cacheWrite: 0, output: 26, total: 1086 })
  expect(day.byRole.master.total).toBe(1075)
  expect(day.byRole.step).toMatchObject({ calls: 1, total: 11 })
  expect(day.byModel.map(item => [item.model, item.total])).toEqual([['m1', 1075], ['m2', 11]])
  expect(day.byBot).toMatchObject([{ bot: '设计', total: 11 }])
  expect(day.byTicket).toMatchObject([{ ticketId: 't1', total: 11 }])
  now += (USAGE_KEEP_DAYS + 1) * 86_400_000
  new UsageLedger(db, () => undefined, () => now)
  expect(db.prepare('SELECT COUNT(*) AS n FROM usage_call').get()?.n).toBe(0)
})

it('feeds the ledger and the team\'s token budget from one listener on the Host, counting a step call once', async () => {
  const { ticketId } = await agreed()
  const t1 = stepSessionId(ticketId, 'T1')
  const waterfall = (h!.ctx as unknown as { waterfall(name: string, options: unknown, next: () => unknown): unknown }).waterfall.bind(h!.ctx)
  const call = (sessionId: string, usage: Record<string, number>) => drain(waterfall('llm/stream', { sessionId, provider: 'p', model: 'm' }, model(usage)))
  await call(t1, { inputTokens: 1000, outputTokens: 200 })
  await call(h!.runtime.masterId, { inputTokens: 5000 })
  expect(h!.runtime.steps.tables.get(ticketId, 'T1')!.tokens).toBe(1200)
  const usage = (await h!.api('GET', 'usage')).body as unknown as { day: { byRole: Record<string, { total: number }>; byBot: { bot: string; total: number }[] }; week: { total: number } }
  expect(usage.day.byRole.step!.total).toBe(1200)
  expect(usage.day.byRole.master!.total).toBe(5000)
  expect(usage.day.byBot).toMatchObject([{ bot: 'designer', total: 1200 }])
  expect(usage.week.total).toBe(6200)
})

const stewardHost = (over: Partial<StewardHost> = {}) => {
  const compactNow = vi.fn(async () => ({ ok: true }))
  const last: UsageCall = { at: '', session: 'master', role: 'master', provider: 'p', model: 'm', input: 1000, cacheRead: 60_000, cacheWrite: 0, output: 2000 }
  let now = 0
  const host: StewardHost = { watched: id => id === 'master' ? 'master' : undefined, last: () => last,
    modelWindow: async () => ({ window: 128_000, maxOutput: 8000 }), compactor: () => ({ compactNow }), info: () => {}, warn: () => {}, now: () => now, ...over }
  return { host, compactNow, last, advance: (ms: number) => { now += ms } }
}
const agent = (status = 'idle') => ({ id: 'master', status }) as never

it('compacts the main Session while idle once its context passes the check line, then waits; leaves unknown windows to DSH', async () => {
  expect(checkLineOf(128_000, 8000)).toBe(72_000)
  expect(checkLineOf(1_000_000)).toBe(580_800)
  const s = stewardHost()
  const steward = new ContextSteward(s.host)
  expect(await steward.consider(agent())).toBe('below')
  s.last.cacheRead = 80_000
  expect(await steward.consider(agent('running'))).toBe('busy')
  expect(await steward.consider(agent())).toBe('compacted')
  expect(s.compactNow).toHaveBeenCalledTimes(1)
  expect(steward.list()).toMatchObject([{ session: 'master', role: 'master', outcome: 'compacted', context: 83_000, line: 72_000 }])
  expect(await steward.consider(agent())).toBe('cooldown')
  s.advance(STEWARD_COOLDOWN_MS)
  s.compactNow.mockRejectedValueOnce(new Error('busy'))
  expect(await steward.consider(agent())).toBe('failed')
  expect(await steward.consider({ id: 'worker-x', status: 'idle' } as never)).toBe('busy')
  expect(await new ContextSteward(stewardHost({ modelWindow: async () => undefined }).host).consider(agent())).toBe('unknown')
  expect(await new ContextSteward(stewardHost({ last: () => undefined }).host).consider(agent())).toBe('unknown')
  const none = stewardHost({ compactor: () => undefined }); none.last.cacheRead = 80_000
  expect(await new ContextSteward(none.host).consider(agent())).toBe('unavailable')
})

it('never lets a remembered head cover a chained or redirected line, and gives a Bot a template\'s rules once', async () => {
  expect(covers('git status', 'git status --short')).toBe(true)
  for (const line of ['git status; rm -rf x', 'git status && curl x', 'git status | sh', 'git status > out', 'git status `id`', 'git status $(id)', 'git status\nrm x'])
    expect(covers('git status', line)).toBe(false)
  const { ticketId } = await agreed()
  const added = h!.runtime.stepApprovals.applyTemplate('git-read', { id: 'designer', name: 'designer' }, 'panel')
  expect(added).toHaveLength(APPROVAL_TEMPLATES[0].heads.length * 2)
  expect(new Set(added.map(rule => rule.tool))).toEqual(new Set(['bash', 'pwsh']))
  expect(h!.runtime.stepApprovals.applyTemplate('git-read', { id: 'designer', name: 'designer' }, 'panel')).toEqual([])
  expect(() => h!.runtime.stepApprovals.applyTemplate('nope', { id: 'designer', name: 'designer' }, 'panel')).toThrow(/No approval template/)
  expect((await h!.api('POST', 'steps/rules/templates/nope/apply', { botId: 'designer', botName: 'designer' })).status).toBe(404)
  expect((await h!.api('POST', 'steps/rules/templates/tests/apply', { botId: 'designer', botName: 'designer' })).body).toEqual({ added: APPROVAL_TEMPLATES[1].heads.length * 2 })
  const rules = (await h!.api('GET', 'steps/rules')).body as unknown as { rules: { template?: string }[]; templates: { id: string }[] }
  expect(rules.templates.map(item => item.id)).toEqual(['git-read', 'tests', 'build', 'install'])
  expect(rules.rules.every(rule => rule.template === 'git-read' || rule.template === 'tests')).toBe(true)
  expect(ticketId).toBeTruthy()
})
