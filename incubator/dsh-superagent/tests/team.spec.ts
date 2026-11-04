// VsSaros addition: the main Session's team plans, given to VsSaros Bots through the in-process team bus.
// Covers a real temporary orchestrator.sqlite, dependency scheduling, the parallel cap, reports, failed steps,
// a plan that ends, a stop, and the bus shape; the Bots side has its own test in dsh-plugins/vssaros-agents.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sharedTeamBus, TEAM_BOTS_PER_PLAN, TEAM_BUS_KEY, Team, TEAM_PARALLEL, TeamError, type AssignmentView, type BotCard, type TeamBus } from '../src/app/team.ts'
import { Retrospective } from '../src/app/retrospective.ts'
import { Store } from '../src/app/store.ts'
import { teamTools } from '../src/app/tools/team.ts'

let dir: string
let store: Store
let relays: { id: string; text: string }[]
let team: Team
let bus: FakeBus
let dispose: () => void

/** The bus vssaros-agents publishes, with its assignments kept so a test ends a turn by hand. */
class FakeBus implements TeamBus {
  version = 1 as const
  ready = true
  cards: BotCard[] = [
    { id: 'designer', name: '设计 bot', description: '交互稿', skills: ['figma'], tools: [], delegatable: true, source: 'custom' },
    { id: 'tester', name: '测试 bot', description: '回归测试', skills: ['playwright'], tools: [], delegatable: true, source: 'builtin' },
  ]
  assignments = new Map<string, AssignmentView>()
  listeners = new Set<(view: AssignmentView) => void | Promise<void>>()
  given: { bot: string; task: string; cwd?: string }[] = []
  cancelled: string[] = []
  created: { id: string; name: string; persona: string }[] = []
  private seq = 0
  available() { return this.ready }
  async listBots() { return this.cards }
  async createBot({ draft }: { draft: { id: string; name: string; persona: string } }) {
    this.created.push(draft)
    return { id: draft.id, name: draft.name, preset: `vssaros-${draft.id}`, file: `/fake/${draft.id}/.agent.md` }
  }
  async delegate(input: { bot: string; task: string; cwd?: string }) {
    this.given.push(input)
    const view: AssignmentView = { id: `a${++this.seq}`, botId: input.bot, botName: input.bot, sessionId: `s${this.seq}`,
      status: 'running', report: null, error: null, createdAt: '', updatedAt: '' } as AssignmentView
    this.assignments.set(view.id, view)
    return view
  }
  async get(id: string) { return this.assignments.get(id) }
  async cancel(id: string) {
    this.cancelled.push(id)
    const view = { ...this.assignments.get(id)!, status: 'cancelled' as const }
    this.assignments.set(id, view)
    return view
  }
  subscribe(listener: (view: AssignmentView) => void | Promise<void>) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Ends one Bot's turn and publishes the report, as assignments.js does. */
  async end(id: string, report = '完成') {
    const view = { ...this.assignments.get(id)!, status: 'done' as const, report }
    this.assignments.set(id, view)
    await Promise.all([...this.listeners].map(listener => listener(view)))
    return view
  }
}

const steps = (...items: { key: string; spec?: string; bot?: string; after?: string[]; title?: string }[]) =>
  items.map(item => ({ key: item.key, title: item.title ?? item.key, spec: item.spec ?? item.key, bot: item.bot ?? 'designer', after: item.after ?? [] }))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-team-'))
  store = new Store(join(dir, 'orchestrator.sqlite'))
  relays = []
  bus = new FakeBus()
  team = new Team({ store, relay: (id, text) => { relays.push({ id, text }) }, bus: () => bus, warn: () => {} })
  dispose = team.install()
})
afterEach(() => { dispose(); store.close(); rmSync(dir, { recursive: true, force: true }) })

describe('team bus shape', () => {
  it('reads only the shape vssaros-agents publishes', () => {
    const root: Record<symbol, unknown> = {}
    expect(sharedTeamBus(root)).toBeUndefined()
    expect(sharedTeamBus({ [TEAM_BUS_KEY]: { version: 2, delegate: () => {}, subscribe: () => {} } })).toBeUndefined()
    expect(sharedTeamBus({ [TEAM_BUS_KEY]: bus })).toBe(bus)
    expect(bus.available()).toBe(true)
  })
})

describe('team plans', () => {
  it('gives only ready steps and keeps the parallel cap', async () => {
    const plan = await team.plan({ goal: '首页引导', ticketId: 't1', cwd: dir, steps: steps(
      { key: 'T1', bot: 'designer' }, { key: 'T2', bot: 'tester', after: ['T1'] }, { key: 'T3', bot: 'tester', after: ['T1'] },
      { key: 'T4', bot: 'tester' }, { key: 'T5', bot: 'tester' }) })
    expect(bus.given).toHaveLength(TEAM_PARALLEL) // T1, T4, T5; T2 and T3 wait for T1
    expect(plan.steps.filter(step => step.state === 'running')).toHaveLength(3)
    expect(plan.exchanges.filter(ex => ex.kind === 'give')).toHaveLength(3)
    expect(bus.given[0]?.task).toContain('首页引导')
    expect(bus.given[0]?.cwd).toBe(dir)
  })
  it('runs the steps that waited, relays each report, and ends the plan for the main Session', async () => {
    const plan = await team.plan({ goal: 'g', steps: steps({ key: 'T1' }, { key: 'T2', after: ['T1'] }) })
    const first = [...bus.assignments.values()][0]!
    await bus.end(first.id, '交互稿 5 屏')
    expect(team.view(plan.id)?.steps.map(step => step.state)).toEqual(['done', 'running'])
    expect(relays.at(-1)?.text).toContain('"kind":"team_report"')
    expect(relays.at(-1)?.text).toContain('交互稿 5 屏')
    await bus.end([...bus.assignments.values()][1]!.id, '埋点表 v1')
    const ended = team.view(plan.id)!
    expect(ended.status).toBe('done')
    expect(ended.steps.map(step => step.report)).toEqual(['交互稿 5 屏', '埋点表 v1'])
    expect(relays.at(-1)?.text).toContain('"kind":"team_plan_end"')
    expect(relays.at(-1)?.text).toContain('"state":"done"')
    // The second step's prompt carried the first step's result.
    expect(bus.given[1]?.task).toContain('交互稿 5 屏')
  })
  it('skips what waits on a failed step, and says why the plan failed', async () => {
    const plan = await team.plan({ goal: 'g', steps: steps({ key: 'T1' }, { key: 'T2', after: ['T1'] }) })
    const failed = [...bus.assignments.values()][0]!
    // The Bots only report done/cancelled; a done turn with no text is a failed step here.
    const view: AssignmentView = { ...failed, status: 'done', report: null, error: 'turn produced no text' }
    bus.assignments.set(failed.id, view)
    await Promise.all([...bus.listeners].map(listener => listener(view)))
    const after = team.view(plan.id)!
    expect(after.status).toBe('failed')
    expect(after.steps.map(step => step.state)).toEqual(['failed', 'skipped'])
    expect(after.exchanges.some(ex => ex.kind === 'failed')).toBe(true)
  })
  it('refuses an unknown step, a cycle, more than 12 steps, and a plan that ended', async () => {
    await expect(team.plan({ goal: 'g', steps: steps({ key: 'T1', after: ['nope'] }) })).rejects.toThrow(TeamError)
    await expect(team.plan({ goal: 'g', steps: steps({ key: 'T1', after: ['T2'] }, { key: 'T2', after: ['T1'] }) })).rejects.toThrow(/cycle/)
    await expect(team.plan({ goal: 'g', steps: steps(...Array.from({ length: 13 }, (_, i) => ({ key: `T${i}` }))) })).rejects.toThrow(/at most 12/)
    const plan = await team.plan({ goal: 'g', steps: steps({ key: 'T1' }) })
    await team.stop(plan.id)
    await expect(team.plan({ planId: plan.id, steps: steps({ key: 'T2' }) })).rejects.toThrow(/has ended/)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM team_plan').get()).toEqual({ n: 1 })
  })
  it('stops a plan by cancelling the running assignment', async () => {
    const plan = await team.plan({ goal: 'g', steps: steps({ key: 'T1' }, { key: 'T2', after: ['T1'] }) })
    const first = [...bus.assignments.values()][0]!
    const result = await team.stop(plan.id, 'person asked')
    expect(bus.cancelled).toEqual([first.id])
    expect(result.status).toBe('cancelled')
    expect(result.steps.map(step => step.state)).toEqual(['cancelled', 'skipped'])
    expect(result.exchanges.some(ex => ex.kind === 'cancel' && ex.text === 'person asked')).toBe(true)
  })
  it('a report arriving before delegate returns is still taken', async () => {
    const early = new FakeBus()
    early.delegate = async (input) => {
      const view = await FakeBus.prototype.delegate.call(early, input)
      // The Bot's turn-stopping event can be published before the awaiting delegate() resolves.
      await Promise.all([...early.listeners].map(listener => listener({ ...view, status: 'done', report: 'done already' })))
      return view
    }
    const other = new Team({ store, relay: (id, text) => { relays.push({ id, text }) }, bus: () => early, warn: () => {} })
    const dispose = other.install()
    const plan = await other.plan({ goal: 'g', steps: steps({ key: 'T1' }) })
    expect(other.view(plan.id)?.status).toBe('done')
    expect(other.view(plan.id)?.steps[0]?.report).toBe('done already')
    dispose()
  })
  it('is refused when the Bots are not in this Host', async () => {
    bus.ready = false
    await expect(team.plan({ goal: 'g', steps: steps({ key: 'T1' }) })).rejects.toThrow(/not running/)
    expect(bus.given).toHaveLength(0)
  })
  it('the main Session tools list Bots, make a plan, read it, and stop it', async () => {
    const tools = teamTools({ team, retro: { match: () => [], run: (id: string) => { throw new Error(`unexpected workflow run ${id}`) } } })
    const byName = Object.fromEntries(tools.map(t => [t.name, t]))
    const signal = new AbortController().signal
    const bots = await byName.orchestrator_team_bots!.execute({ need: 'playwright' }, signal) as { bots: { id: string }[] }
    expect(bots.bots[0]?.id).toBe('tester')
    const plan = await byName.orchestrator_team_plan!.execute({ goal: 'g', steps: steps({ key: 'T1' }) }, signal) as { plan: string }
    expect(plan.plan).toMatch(/^plan-/)
    expect((await byName.orchestrator_team_status!.execute({ plan_id: plan.plan }, signal) as { running: number }).running).toBe(1)
    const stopped = await byName.orchestrator_team_stop!.execute({ plan_id: plan.plan }, signal) as { state: string }
    expect(stopped.state).toBe('cancelled')
  })
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
    const tools = Object.fromEntries(teamTools({ team, retro: { match: () => [], run: (id: string) => { throw new Error(`unexpected workflow run ${id}`) } } }).map(t => [t.name, t]))
    const signal = new AbortController().signal
    const answer = await tools.orchestrator_team_create_bot!.execute({ id: 'publisher', name: '发布 bot', persona: 'x', tools: ['feishu'] }, signal) as { pending: string }
    expect(answer.pending).toMatch(/^appr-/)
    expect(team.approvals()).toHaveLength(1)
  })
  it('an ended plan leaves skills and a workflow, and a new request reuses that workflow', async () => {
    const warnings: string[] = []
    let ended = 0
    const retro = new Retrospective({ store, skillsRoot: join(dir, 'skills'), warn: message => { warnings.push(message) } })
    const flow = new Team({ store, relay: (id, text) => { relays.push({ id, text }) }, bus: () => bus,
      onPlanEnd: async plan => { ended += 1; await retro.onPlanEnd(plan) }, warn: message => { warnings.push(message) } })
    const offFlow = flow.install()
    const plan = await flow.plan({ goal: '首页新手引导上线', steps: steps({ key: 'T1' }, { key: 'T2', after: ['T1'] }) })
    await bus.end([...bus.assignments.values()][0]!.id, '交互稿 5 屏')
    await bus.end([...bus.assignments.values()][1]!.id, '埋点表 v1')
    expect(flow.view(plan.id)?.status).toBe('done')
    expect(warnings).toEqual([])
    expect(ended).toBeGreaterThan(0)
    expect(retro.tables.skills().length).toBeGreaterThan(0)
    expect(retro.tables.workflows('draft')).toHaveLength(1)
    const [draft] = retro.tables.workflows('draft')
    retro.saveWorkflow(draft!.id)
    const tools = Object.fromEntries(teamTools({ team: flow, retro }).map(t => [t.name, t]))
    const signal = new AbortController().signal
    const reused = await tools.orchestrator_team_plan!.execute({ goal: '首页新手引导上线',
      steps: steps({ key: 'OTHER' }) }, signal) as { workflow?: { id: string; score: number }; plan: string }
    expect(reused.workflow?.id).toBe(draft!.id)
    expect(reused.workflow?.score).toBeGreaterThanOrEqual(70)
    expect(flow.view(reused.plan)?.steps.map(step => step.id)).toEqual(['T1', 'T2']) // workflow steps, not OTHER
    expect(retro.tables.workflow(draft!.id)?.runs).toBe(1)
    offFlow()
  })
  it('the four tables survive reopening the database', async () => {
    const plan = await team.plan({ goal: 'g', steps: steps({ key: 'T1' }) })
    store.close()
    store = new Store(join(dir, 'orchestrator.sqlite'))
    const reopened = new Team({ store, relay: () => {}, bus: () => bus, warn: () => {} })
    expect(reopened.view(plan.id)?.steps).toHaveLength(1)
  })
})
