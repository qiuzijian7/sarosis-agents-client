// VsSaros addition: the superagent Source (the supervisor desk and Bots asking for help) and the desk's one tool.
import { describe, expect, it } from 'vitest'
import type { OutboundMessage, Thread } from '../src/core/index.ts'
import { deliverReply, deskSessionId, deskTools, latestPersonMessage, DESK_PROMPT } from '../src/app/desk.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { botTrigger, deskTrigger, DESK_PERSON, makeSuperagentKind, SUPERAGENT_SOURCE, type SuperagentAddress } from '../src/sources/superagent.ts'

const thread = { subscriptions: [], context: [] } as unknown as Thread
const delivered: { address: SuperagentAddress; message: OutboundMessage }[] = []
const kind = makeSuperagentKind(async (address, message) => { delivered.push({ address, message }); return 'sent' })
const at = '2026-11-04T10:00:00.000Z'
function gateWith(part: Record<string, unknown> | undefined, mode: 'off' | 'observe' | 'auto' = 'auto', config?: Record<string, unknown>) {
  const settings = SettingsSchema.parse({ eval: { mode }, policy: { sources: part ? { [SUPERAGENT_SOURCE]: part } : {} },
    ...config ? { sources: { [SUPERAGENT_SOURCE]: { enabled: true, config } } } : {} })
  const registry = new SourceRegistry(() => settings)
  registry.register(kind)
  return { gate: settingsPolicy(settings, registry), registry }
}
const desk = (text = '首页新手引导要上线') => deskTrigger({ session: 'desk-1', messageId: 'm1', text, at })
const help = (bot: string | null = 'tester') => botTrigger({ id: 'u1', session: 'bot-s1', bot, name: '测试 bot', text: '帮我拆一下回归范围', hop: 1, at })

describe('the superagent Source', () => {
  it('receives the desk and Bots by switch, on their own admission rows', () => {
    const scope = (meta: Record<string, unknown>, config = {}) => kind.scope!({ meta }, kind.schema.parse(config))
    expect(scope({ from: 'desk' })).toEqual({ listened: true, observed: false, row: 'desk' })
    expect(scope({ from: 'bot' })).toEqual({ listened: true, observed: false, row: 'bots' })
    expect(scope({ from: 'desk' }, { desk: false })).toEqual({ listened: false, reason: 'superagent_desk_off' })
    expect(scope({ from: 'bot' }, { bots: false })).toEqual({ listened: false, reason: 'superagent_bots_off' })
    expect(scope({})).toMatchObject({ listened: false })
    expect(kind.policy!.rows!({}).map(row => row.id)).toEqual(['desk', 'bots'])
  })
  it('a desk message is a person\'s, addressed directly, on its desk Thread, and its reply goes back into the desk', () => {
    const trigger = desk()
    expect(trigger).toMatchObject({ id: 'superagent:desk:m1', human: true, addressed: 'direct',
      actor: { source: SUPERAGENT_SOURCE, id: DESK_PERSON.id }, threads: [{ source: SUPERAGENT_SOURCE, id: 'desk:desk-1' }],
      channel: { thread: 'superagent:desk:desk-1', address: { kind: 'desk', session: 'desk-1' } } })
    expect(deskTrigger({ session: 'desk-1', messageId: 'm1', text: '再说一遍', at }).id).toBe(trigger.id)
  })
  it('a Bot\'s request is a bot\'s, named by the Bot it belongs to, or by its Session when the Bots could not tell', () => {
    expect(help()).toMatchObject({ human: false, actor: { id: 'tester' }, threads: [{ id: 'bot:bot-s1' }],
      channel: { address: { kind: 'bot', session: 'bot-s1' } }, meta: { from: 'bot', hop: 1, bot: 'tester' } })
    expect(help(null).actor.id).toBe('session:bot-s1')
  })
  it('the person at this machine is listed by default, so the desk makes explicit requests', () => {
    const { gate, registry } = gateWith({ allowed: [{ ...DESK_PERSON }], bots: [] })
    expect(registry.policyPart(SUPERAGENT_SOURCE)?.allowed).toEqual([DESK_PERSON])
    expect(kind.policy!.schema.parse({}).allowed).toEqual([DESK_PERSON])
    expect(gate.gate(desk(), thread, [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'addressed' } })
  })
  it('without the person on the list, a desk message originates nothing', () => {
    const { gate } = gateWith({ allowed: [], bots: [] })
    expect(gate.gate(desk(), thread, [])).toMatchObject({ admissible: false })
  })
  it('a listed Bot is an inferred candidate at most; any other Bot is refused, and none while admission is off', () => {
    const { gate } = gateWith({ allowed: [{ ...DESK_PERSON }], bots: [{ id: 'tester' }] })
    expect(gate.gate(help(), thread, [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'bot' } })
    expect(gate.gate(help('stranger'), thread, [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(gate.gate(help(null), thread, [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(gateWith({ allowed: [], bots: [{ id: 'tester' }] }, 'off').gate.gate(help(), thread, [])).toMatchObject({ admissible: false })
  })
  it('the channel sends to a desk or a Bot, and refuses an address it cannot read', async () => {
    delivered.length = 0
    const message = (address: Record<string, string>): OutboundMessage => ({ id: 'r1', kind: 'reply', text: '收到',
      channel: { source: SUPERAGENT_SOURCE, thread: 'superagent:desk:desk-1', address } })
    expect(await kind.channel!.send({ commands: {} as never }, message({ kind: 'desk', session: 'desk-1' }))).toBe('sent')
    expect(await kind.channel!.send({ commands: {} as never }, message({ kind: 'mail', session: 'x' }))).toBe('gone')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.address).toEqual({ kind: 'desk', session: 'desk-1' })
    expect(kind.channel!.link({ kind: 'desk', session: 'desk-1' }, {}).label.zh).toBe('主管对话')
  })
})

describe('the supervisor desk', () => {
  const userMessage = (id: string, text: string, kind = 'user') => ({ type: 'user/message', data: { id, role: 'user', source: { kind }, content: [{ type: 'text', text }] } })
  it('hands over the person\'s latest message word for word, never the supervisor\'s own', () => {
    const events = [userMessage('m1', '第一句'), { type: 'assistant/message', data: {} }, userMessage('m2', '第二句'),
      userMessage('m3', '[SuperAgent] 方案 v1', 'dsh-superagent')]
    expect(latestPersonMessage(events)).toEqual({ id: 'm2', text: '第二句' })
    expect(latestPersonMessage([])).toBeUndefined()
  })
  it('its one tool takes no text and submits a desk Trigger once', async () => {
    const received: string[] = []
    const agent = { id: 'desk-1', session: { snapshotEvents: () => [userMessage('m9', '帮我把首页引导上线')] } }
    const [submit] = deskTools({ receive: trigger => { received.push(trigger.id); return received.length > 1 ? 'duplicate' : 'stored' } }, agent)
    expect(submit!.name).toBe('superagent_submit')
    expect(submit!.schema.safeParse({ text: 'reworded' }).success).toBe(false)
    const signal = new AbortController().signal
    expect(await submit!.execute({}, signal)).toMatchObject({ submitted: true, result: 'stored' })
    expect(await submit!.execute({}, signal)).toMatchObject({ submitted: false, result: 'duplicate' })
    expect(received).toEqual(['superagent:desk:m9', 'superagent:desk:m9'])
    const empty = deskTools({ receive: () => 'stored' }, { id: 'desk-1', session: { snapshotEvents: () => [] } })[0]!
    expect(await empty.execute({}, signal)).toMatchObject({ submitted: false })
  })
  it('replies are injected into the desk without waking it, steered into a Bot, and gone with the Session', async () => {
    const sent: { session: string; text: string; mode: unknown }[] = []
    const host = { prompt: async (session: string, _id: string, text: string, mode: unknown) => {
      if (session === 'missing') throw Object.assign(new Error('not found'), { code: 'session/not-found' })
      if (session === 'broken') throw new Error('network')
      sent.push({ session, text, mode })
    } }
    const message: OutboundMessage = { id: 'r1', kind: 'reply', text: '方案 v1 已发', channel: { source: SUPERAGENT_SOURCE, thread: 't', address: {} } }
    expect(await deliverReply(host, { kind: 'desk', session: 'desk-1' }, message)).toBe('sent')
    expect(await deliverReply(host, { kind: 'bot', session: 'bot-s1' }, message)).toBe('sent')
    // VsSaros fix (2026-11-05): queued, so it is written into the desk's conversation and wakes the desk to tell the person;
    // an injected one stayed in the idle desk's inbox, out of sight.
    expect(sent[0]).toMatchObject({ text: '[SuperAgent] 方案 v1 已发', mode: 'queue' })
    expect(sent[1]).toMatchObject({ mode: 'steer' })
    expect(sent[1]!.text).toContain('agent_message')
    expect(await deliverReply(host, { kind: 'desk', session: 'missing' }, message)).toBe('gone')
    await expect(deliverReply(host, { kind: 'desk', session: 'broken' }, message)).rejects.toThrow('network')
  })
  it('has a stable Session ID per state directory and a prompt that never does the work', () => {
    expect(deskSessionId('C:/a')).toBe(deskSessionId('C:/a'))
    expect(deskSessionId('C:/a')).not.toBe(deskSessionId('C:/b'))
    expect(DESK_PROMPT).toContain('superagent_submit')
    expect(DESK_PROMPT).toContain('never do the work')
    // The supervisor's news is told to the person, a proposal with how to agree to it.
    expect(DESK_PROMPT).toMatch(/\[SuperAgent\] are the supervisor's news for the person: never submit them\. Tell the person/)
    expect(DESK_PROMPT).toContain('同意')
  })
})
