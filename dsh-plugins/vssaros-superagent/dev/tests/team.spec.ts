// VsSaros addition: the supervisor's link to VsSaros Bots through the in-process team bus — the bus shape, the Bots it
// creates (a high-risk draft waits for a person), and group chats. The team plans this file also covered were retired on
// 2026-11-06 (P1 · one track); their archive is covered in retrospective.spec.ts. The Bots side has its own test in
// dsh-plugins/vssaros-agents.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sharedTeamBus, TEAM_BOTS_PER_PLAN, TEAM_BUS_KEY, Team, type AssignmentView, type BotCard, type TeamBus } from '../src/app/team.ts'
import { Retrospective } from '../src/app/retrospective.ts'
import { Store } from '../src/app/store.ts'
import { CONSENTLESS_TOOLS, teamTools } from '../src/app/tools/team.ts'

let dir: string
let store: Store
let team: Team
let bus: FakeBus

/** The bus vssaros-agents publishes. */
class FakeBus implements TeamBus {
  version = 1 as const
  ready = true
  cards: BotCard[] = [
    { id: 'designer', name: '设计 bot', description: '交互稿', skills: ['figma'], tools: [], delegatable: true, source: 'custom' },
    { id: 'tester', name: '测试 bot', description: '回归测试', skills: ['playwright'], tools: [], delegatable: true, source: 'builtin' },
  ]
  created: { id: string; name: string; persona: string }[] = []
  given: unknown[] = []
  available() { return this.ready }
  async listBots() { return this.cards }
  async createBot({ draft }: { draft: { id: string; name: string; persona: string } }) {
    this.created.push(draft)
    return { id: draft.id, name: draft.name, preset: `vssaros-${draft.id}`, file: `/fake/${draft.id}/.agent.md` }
  }
  async delegate(input: unknown): Promise<AssignmentView> { this.given.push(input); throw new Error('nothing delegates through the bus any more') }
  async get() { return undefined }
  async cancel(): Promise<AssignmentView> { throw new Error('unused') }
  subscribe() { return () => {} }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-team-'))
  store = new Store(join(dir, 'orchestrator.sqlite'))
  bus = new FakeBus()
  team = new Team({ store, bus: () => bus, warn: () => {} })
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

describe('one track (2026-11-06)', () => {
  it('gives the main Session no plan tools, keeps two team tables, and disposes a subscription an older version left', () => {
    const names = teamTools({ team, retro: { match: () => [] } }).map(item => item.name)
    expect(names).toEqual(['orchestrator_team_bots', 'orchestrator_team_create_group', 'orchestrator_team_create_bot'])
    expect([...CONSENTLESS_TOOLS]).toEqual(['orchestrator_team_create_bot'])
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'team_%' ORDER BY name").all().map(row => String(row.name))
    expect(tables).toEqual(['team_approval', 'team_bot'])
    let disposed = 0
    const key = Symbol.for('vssaros.team.subscription'), owner = globalThis as unknown as Record<symbol, unknown>
    owner[key] = () => { disposed += 1 }
    new Team({ store, bus: () => bus, warn: () => {} })
    expect([disposed, owner[key]]).toEqual([1, undefined])
    expect(bus.given).toEqual([])
  })
})

describe('team bus shape', () => {
  it('reads only the shape vssaros-agents publishes', () => {
    const root: Record<symbol, unknown> = {}
    expect(sharedTeamBus(root)).toBeUndefined()
    expect(sharedTeamBus({ [TEAM_BUS_KEY]: { version: 2, delegate: () => {}, subscribe: () => {} } })).toBeUndefined()
    expect(sharedTeamBus({ [TEAM_BUS_KEY]: bus })).toBe(bus)
    expect(bus.available()).toBe(true)
  })
})

describe('Bots the supervisor creates', () => {
  it('a low-risk Bot is created at once; the same id or name returns the existing one', async () => {
    const draft = { id: 'writer', name: '文档 bot', persona: '写版本说明', tools: ['read'] }
    const result = await team.createBot({ draft, planId: 'p1' })
    expect(result.bot?.id).toBe('writer')
    expect(bus.created).toHaveLength(1)
    expect(team.createdBots()[0]).toMatchObject({ id: 'writer', planId: 'p1', preset: 'vssaros-writer' })
    const again = await team.createBot({ draft: { id: 'different-id', name: '设计 bot', persona: 'x' }, planId: 'p1' })
    expect(again.existing).toEqual({ id: 'designer', name: '设计 bot' }) // the name already exists
    expect(bus.created).toHaveLength(1)
  })
  it('a high-risk draft waits for a person; approve creates it, reject does not', async () => {
    const draft = { id: 'publisher', name: '发布 bot', persona: '发通知', tools: ['feishu', 'git'] }
    const asked = await team.createBot({ draft })
    expect(asked.pending).toMatch(/^appr-/)
    expect(bus.created).toHaveLength(0)
    expect(team.approvals()).toHaveLength(1)
    expect(team.approvals()[0]?.risk).toEqual(['feishu', 'git'])
    const approved = await team.approve(asked.pending!)
    expect(approved.id).toBe('publisher')
    expect(bus.created).toHaveLength(1)
    expect(team.approvals()).toHaveLength(0)
    const other = await team.createBot({ draft: { ...draft, id: 'sender' } })
    expect(team.reject(other.pending!).state).toBe('rejected')
    expect(bus.created).toHaveLength(1)
    await expect(team.approve(other.pending!)).rejects.toThrow(/rejected/)
  })
  it('refuses more than three Bots for one plan, and reports a Bots plugin that cannot create them', async () => {
    for (let i = 0; i < TEAM_BOTS_PER_PLAN; i += 1) await team.createBot({ draft: { id: `bot${i}`, name: `bot${i}`, persona: 'x' }, planId: 'p1' })
    await expect(team.createBot({ draft: { id: 'one-more', name: 'one-more', persona: 'x' }, planId: 'p1' })).rejects.toThrow(/3 Bots/)
    bus.createBot = undefined as never
    await expect(team.createBot({ draft: { id: 'x', name: 'x', persona: 'x' } })).rejects.toThrow(/cannot create a Bot/)
  })
  it('the create_bot tool returns a pending draft for a person', async () => {
    const tools = Object.fromEntries(teamTools({ team, retro: { match: () => [] } }).map(t => [t.name, t]))
    const signal = new AbortController().signal
    const answer = await tools.orchestrator_team_create_bot!.execute({ id: 'publisher', name: '发布 bot', persona: 'x', tools: ['feishu'] }, signal) as { pending: string }
    expect(answer.pending).toMatch(/^appr-/)
    expect(team.approvals()).toHaveLength(1)
  })
})

// VsSaros addition (2026-11-05): a person asks the supervisor for a group chat of Bots; it appears in the Bots tab.
describe('group chats', () => {
  const groupTool = (tell?: (triggerId: string, id: string, text: string) => boolean) => teamTools({ team,
    retro: new Retrospective({ store, warn: () => {} }),
    ...tell ? { tellTrigger: tell } : {} }).find(item => item.name === 'orchestrator_team_create_group')!
  it('makes the group through the Bots plugin and tells the conversation the request came from where it is', async () => {
    const made: unknown[] = []
    Object.assign(bus, { createGroup: async (input: Record<string, unknown>) => {
      made.push(input)
      return { id: 'room-1', sessionId: 'room-1', name: String(input.name), members: [{ id: 'designer', name: '设计 bot' }, { id: 'tester', name: '测试 bot' }],
        admin: 'designer', mode: 'admin', notice: '', pinned: false, hidden: false, createdBy: 'superagent' }
    } })
    const told: { triggerId: string; id: string; text: string }[] = []
    const result = await groupTool((triggerId, id, text) => { told.push({ triggerId, id, text }); return true })
      .execute({ bots: ['设计 bot', 'tester'], name: '番茄钟 H5', trigger_id: 'superagent:desk:m1' }, {} as never) as Record<string, unknown>
    expect(made).toEqual([{ members: ['设计 bot', 'tester'], name: '番茄钟 H5', originTriggerId: 'superagent:desk:m1', createdBy: 'superagent' }])
    expect(result).toEqual({ group: { id: 'room-1', name: '番茄钟 H5', bots: ['设计 bot', '测试 bot'], admin: '设计 bot', mode: 'admin' }, told: true })
    expect(told).toEqual([{ triggerId: 'superagent:desk:m1', id: 'group-created:room-1',
      text: expect.stringMatching(/^已建群「番茄钟 H5」：设计 bot、测试 bot，管理员 设计 bot。在左侧栏「Bots」页签里点开它/) }])
  })
  it('answers a refusal instead of failing: Bots that cannot make groups, or Bots it refuses', async () => {
    expect(await groupTool().execute({ bots: ['designer', 'tester'] }, {} as never)).toEqual({ refused: expect.stringMatching(/cannot make group chats/) })
    Object.assign(bus, { createGroup: async () => { throw new Error('没有叫「nobody」的 Bot') } })
    expect(await groupTool().execute({ bots: ['designer', 'nobody'] }, {} as never)).toEqual({ refused: 'Could not create the group: 没有叫「nobody」的 Bot' })
  })
  it('is a main Session tool, and its notice wakes the desk', async () => {
    const { wakesDesk } = await import('../src/app/desk-outbox.ts')
    expect(wakesDesk({ id: 'group-created:room-1', kind: 'notice' })).toBe(true)
    const { CONSENTLESS_TOOLS } = await import('../src/app/tools/team.ts')
    expect(CONSENTLESS_TOOLS.has('orchestrator_team_create_group')).toBe(false)
  })
})
