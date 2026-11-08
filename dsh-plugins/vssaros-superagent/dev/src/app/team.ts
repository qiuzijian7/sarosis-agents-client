/**
 * VsSaros addition: the supervisor's link to the VsSaros Bots, through the in-process team bus of vssaros-agents
 * (`Symbol.for('vssaros.team')`): the roster, the Bots the supervisor creates (a high-risk draft waits for a person), and
 * group chats of Bots.
 *
 * VsSaros change (2026-11-06, P1 · one track): the team plans this module also ran — work the main Session gave to Bots
 * without a person agreeing to a team — are retired. Team work runs only as a ticket's agreed team (`staffing.ts`,
 * `steps.ts`); the old plans are kept read-only in `team_archive` (`team-archive.ts`). This module keeps two tables:
 * `team_bot` (Bots the supervisor created, for quotas and the panel) and `team_approval` (drafts waiting for a person).
 */
import type { GroupState } from './group-tickets.ts'
import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'

/** At most this many Bots the supervisor may create for one ticket, and in total. */
export const TEAM_BOTS_PER_PLAN = 3
export const TEAM_BOTS_GLOBAL = 20
/** At most this many steps in one ticket's team. */
export const TEAM_STEPS_MAX = 12
/** Tool names whose draft needs a person's approval before the Bot is created. */
export const HIGH_RISK_TOOLS = /^(bash|pwsh|shell|exec|terminal|git|feishu|im|mail|email|webhook|http|fetch|network|credential|secret|write|deploy|publish|send)/i

/** A Bot as the team bus lists it. */
export interface BotCard {
  id: string; name: string; role?: string; description: string; skills: string[]; tools: string[]
  delegatable: boolean; source: 'builtin' | 'custom'; origin?: 'supervisor'
}
/** A draft the supervisor asks the Bots plugin to write into its roster. */
export interface BotDraft {
  id: string; name: string; description?: string; role?: string; skills?: string[]; tools?: string[]; persona: string
}
/** A Bot the supervisor created, kept in the team tables for quota and display. */
export interface CreatedBot extends BotDraft { planId?: string; preset: string; file: string; at: string }
/** A high-risk Bot draft waiting for a person in the panel. */
export interface BotApproval {
  id: string; planId?: string; draft: BotDraft; risk: string[]; state: 'pending' | 'approved' | 'rejected'; at: string; decidedAt?: string
}
/** The Bots plugin creates the Bot; unavailable in older versions of vssaros-agents. */
export interface CreatedBotView { id: string; name: string; preset: string; file: string }
/** One assignment of a step to a Bot, as the team bus reports it. */
export interface AssignmentView {
  id: string; botId: string; botName: string; sessionId: string
  status: 'running' | 'done' | 'cancelled'; report: string | null; error: string | null
}
/** The in-process team bus of vssaros-agents (0.2.319+); duck-typed so this package does not depend on the Bots package. */
export interface TeamBus {
  version: 1
  available(): boolean
  listBots(): Promise<BotCard[]>
  delegate(input: { bot: string; task: string; cwd?: string; fromName?: string }): Promise<AssignmentView>
  createBot?(input: { draft: BotDraft }): Promise<CreatedBotView>
  /** VsSaros addition: an external Bot in the Bots roster whose Session is owned by this plugin. */
  registerExternalBot?(spec: { id: string; name: string; role?: string; description?: string; icon?: string
    /** The Session a person opens to talk to it (the supervisor desk). */
    session?: string
    /** A Bot's `agent_message`: its message ID, its Session, and the Bot it belongs to when the Bots can tell. */
    onMessage: (message: { id?: string; from: string | null; fromBot?: string | null; fromName?: string | null; text: string; hop: number;
      session?: string }) => unknown }): () => void
  get(id: string): Promise<AssignmentView | undefined>
  cancel(id: string, reason?: string): Promise<AssignmentView>
  subscribe(listener: (view: AssignmentView) => void | Promise<void>): () => void
  /** VsSaros addition (2026-11-05, vssaros-agents 0.2.325+): a group chat of Bots, shown in the Bots tab of the sidebar. */
  createGroup?(input: GroupInput & { createdBy?: string; workspaceId?: string; cwd?: string }): Promise<GroupView>
  listGroups?(): Promise<GroupView[]>
  /**
   * VsSaros addition (2026-11-06, contract revision 2 of vssaros-agents 0.2.347+): `version` stays 1 for older consumers;
   * `revision` and `features` name what was added. `presetOf` is the Bots plugin's own preset naming, so this package need
   * not copy it; `describeBot` is a roster card with its model, preset and workspaces.
   */
  revision?: number
  features?: readonly string[]
  presetOf?(botId: string): string
  describeBot?(ref: string): Promise<(BotCard & { model?: string; preset?: string; workspaces?: { read: string[]; write: string[] } }) | undefined>
  /** VsSaros addition (2026-11-07, vssaros-agents 0.2.355+): what a group is doing now, for the ticket it runs. */
  groupState?(roomId: string): Promise<GroupState | undefined>
}
/** Whether the team bus has contract revision `revision` or later. */
export const busRevision = (bus: Partial<TeamBus> | undefined, revision: number): boolean => typeof bus?.revision === 'number' && bus.revision >= revision
/** A group chat of Bots as a person asked for it: Bots by id or name, the first its admin. */
export interface GroupInput {
  members: string[]; name?: string; notice?: string; mode?: 'admin' | 'everyone'
  /** 2026-11-05 P0: the SuperAgent trigger this group belongs to; the Bots plugin reuses a group with the same key. */
  originTriggerId?: string
}
/** A group chat as the Bots plugin reports it; its id is its DSH Session's. */
export interface GroupView {
  id: string; sessionId: string; name: string; members: { id: string; name: string }[]; admin: string | null
  mode: 'admin' | 'everyone'; notice: string; pinned: boolean; hidden: boolean; createdBy: string | null
  originTriggerId?: string
  /**
   * VsSaros addition (2026-11-06): a group of the same name existed, so the Bots plugin edited it (its members now the ones
   * asked for) instead of making a second one; `added` / `removed` name the members that changed.
   */
  reused?: true; added?: string[]; removed?: string[]
}
export const TEAM_BUS_KEY = Symbol.for('vssaros.team')
/** The subscription of the retired team plans; a Team disposes one an older version left in this process. */
const TEAM_SUBSCRIPTION_KEY = Symbol.for('vssaros.team.subscription')
/** The team bus when vssaros-agents runs in this Host, in the shape it publishes. */
export function sharedTeamBus(root: object = globalThis): TeamBus | undefined {
  const bus = (root as Record<symbol, Partial<TeamBus> | undefined>)[TEAM_BUS_KEY]
  return bus && bus.version === 1 && typeof bus.delegate === 'function' && typeof bus.subscribe === 'function'
    && typeof bus.available === 'function' ? bus as TeamBus : undefined
}

/** A request the Bots or the limits refuse; answered to the main Session with the reason. */
export class TeamError extends Error {}

const now = () => new Date().toISOString()

/** The two team tables in the orchestrator database; the Store opens the database and owns its transactions. */
export class TeamStore {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS team_bot (id TEXT PRIMARY KEY, plan TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_approval (id TEXT PRIMARY KEY, state TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_bot_plan ON team_bot(plan);
      CREATE INDEX IF NOT EXISTS team_approval_state ON team_approval(state, at);
    `)
  }
  saveBot(bot: CreatedBot): void {
    this.store.db.prepare('INSERT INTO team_bot VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(bot.id, bot.planId ?? '', JSON.stringify(bot), bot.at)
  }
  bot(id: string): CreatedBot | undefined {
    const row = this.store.db.prepare('SELECT value FROM team_bot WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as CreatedBot : undefined
  }
  botsIn(planId: string): CreatedBot[] {
    return this.store.db.prepare('SELECT value FROM team_bot WHERE plan=?').all(planId).map(row => JSON.parse(String(row.value)) as CreatedBot)
  }
  createdBots(): CreatedBot[] {
    return this.store.db.prepare('SELECT value FROM team_bot ORDER BY at').all().map(row => JSON.parse(String(row.value)) as CreatedBot)
  }
  saveApproval(approval: BotApproval): void {
    this.store.db.prepare('INSERT INTO team_approval VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, value=excluded.value')
      .run(approval.id, approval.state, JSON.stringify(approval), approval.at)
  }
  approval(id: string): BotApproval | undefined {
    const row = this.store.db.prepare('SELECT value FROM team_approval WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as BotApproval : undefined
  }
  approvals(state?: BotApproval['state']): BotApproval[] {
    const rows = state
      ? this.store.db.prepare('SELECT value FROM team_approval WHERE state=? ORDER BY at').all(state)
      : this.store.db.prepare('SELECT value FROM team_approval ORDER BY at').all()
    return rows.map(row => JSON.parse(String(row.value)) as BotApproval)
  }
}

/** What the Team needs from the Runtime. */
export interface TeamHost {
  readonly store: Pick<Store, 'db' | 'atomic'>
  /** The team bus; injected by tests. */
  bus?: () => TeamBus | undefined
  warn(message: string): void
}

/** The roster, the Bots the supervisor creates, and group chats, through the team bus. */
export class Team {
  readonly tables: TeamStore
  private readonly bus: () => TeamBus | undefined
  constructor(private readonly host: TeamHost) {
    this.tables = new TeamStore(host.store)
    this.bus = host.bus ?? (() => sharedTeamBus())
    // A hot reload from a version that still ran plans: its subscriber must not advance archived plans.
    const owner = globalThis as unknown as Record<symbol, (() => void) | undefined>
    owner[TEAM_SUBSCRIPTION_KEY]?.()
    delete owner[TEAM_SUBSCRIPTION_KEY]
  }
  /** Whether VsSaros Bots can take steps in this Host now. */
  available(): boolean { return !!this.bus()?.available() }
  /**
   * VsSaros addition (2026-11-06): a Bot's DSH preset as the Bots plugin names it (contract revision 2), or undefined on an
   * older Bots plugin, where the caller keeps its own copy of the naming (`botPreset`).
   */
  presetOf(botId: string): string | undefined {
    const bus = this.bus()
    if (!busRevision(bus, 2) || typeof bus?.presetOf !== 'function') return undefined
    try { return bus.presetOf(botId) || undefined } catch { return undefined }
  }

  /** The Bots the main Session may staff a team with, those matching `need` first. */
  async bots(need = ''): Promise<BotCard[]> {
    const bus = this.need()
    const words = need.toLowerCase().split(/[\s,，、;；/]+/).filter(word => word.length > 0)
    const score = (card: BotCard) => {
      const text = [card.name, card.role ?? '', card.description, ...card.skills].join(' ').toLowerCase()
      return words.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0) + (card.delegatable ? 0.5 : 0)
    }
    return (await bus.listBots()).map(card => ({ card, score: score(card) })).sort((a, b) => b.score - a.score).map(({ card }) => card)
  }

  /** The Bot drafts waiting for a person, newest last. */
  approvals(): BotApproval[] { return this.tables.approvals('pending') }

  /**
   * VsSaros addition (2026-11-05): a group chat of Bots a person asked for. The Bots plugin opens its Session, lists it in
   * the Bots tab of the sidebar, and runs it: the person writes in it, and the Bots called answer there.
   * @throws TeamError when the Bots are not in this Host, cannot make groups, or refuse the members or settings.
   */
  async createGroup(input: GroupInput): Promise<GroupView> {
    const bus = this.need()
    if (typeof bus.createGroup !== 'function') throw new TeamError('This Host\'s VsSaros Bots cannot make group chats; update @vssaros/dsh-agents to 0.2.325+')
    try {
      return await bus.createGroup({ ...input, createdBy: 'superagent' })
    } catch (error) {
      throw new TeamError(`Could not create the group: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /**
   * VsSaros addition (2026-11-07): what a group is doing now (see app/group-tickets.ts); undefined when the Bots are not
   * running here or are too old to tell, so the ticket waits for a later check.
   */
  async groupState(roomId: string): Promise<GroupState | undefined> {
    const bus = this.bus()
    if (!bus?.available() || typeof bus.groupState !== 'function') return undefined
    return await bus.groupState(roomId)
  }
  /** 已存在的群；desk 的 `@群` 快路径用它确认引用事件指向的是群，而不是普通会话。 */
  async groups(): Promise<GroupView[]> {
    const bus = this.need()
    if (typeof bus.listGroups !== 'function') return []
    return await bus.listGroups()
  }
  /** Bots the supervisor has created (for quotas and the panel). */
  createdBots(): CreatedBot[] { return this.tables.createdBots() }

  /**
   * Gives the supervisor a new Bot: an existing Bot with the same id or name is returned instead of a duplicate;
   * a draft asking for high-risk tools waits for a person; the rest is written into the Bots roster at once.
   */
  async createBot(input: { draft: BotDraft; planId?: string }): Promise<{ bot?: CreatedBotView; existing?: { id: string; name: string }; pending?: string }> {
    const bus = this.need()
    if (typeof bus.createBot !== 'function') throw new TeamError('This Host\'s VsSaros Bots cannot create a Bot; update @vssaros/dsh-agents to 0.2.320+')
    const draft = input.draft
    const duplicate = (await bus.listBots()).find(card => card.id === draft.id || card.name === draft.name)
    if (duplicate) return { existing: { id: duplicate.id, name: duplicate.name } }
    this.checkBotQuota(input.planId)
    const risk = (draft.tools ?? []).filter(tool => HIGH_RISK_TOOLS.test(tool))
    if (risk.length) {
      const approval: BotApproval = { id: `appr-${randomUUID().slice(0, 8)}`, draft, risk, state: 'pending', at: now(),
        ...input.planId ? { planId: input.planId } : {} }
      this.tables.saveApproval(approval)
      return { pending: approval.id }
    }
    return { bot: await this.commitBot(bus, draft, input.planId) }
  }

  /** Approves a draft waiting for a person; rechecks the quotas, then writes the Bot. */
  async approve(id: string): Promise<CreatedBotView> {
    const approval = this.tables.approval(id)
    if (!approval) throw new TeamError(`No Bot draft ${id}`)
    if (approval.state !== 'pending') throw new TeamError(`Bot draft ${id} is ${approval.state}`)
    const bus = this.need()
    if (typeof bus.createBot !== 'function') throw new TeamError('This Host\'s VsSaros Bots cannot create a Bot')
    this.checkBotQuota(approval.planId)
    const view = await this.commitBot(bus, approval.draft, approval.planId)
    this.tables.saveApproval({ ...approval, state: 'approved', decidedAt: now() })
    return view
  }

  /** Rejects a draft waiting for a person; no Bot is written. */
  reject(id: string): BotApproval {
    const approval = this.tables.approval(id)
    if (!approval) throw new TeamError(`No Bot draft ${id}`)
    if (approval.state !== 'pending') throw new TeamError(`Bot draft ${id} is ${approval.state}`)
    const rejected = { ...approval, state: 'rejected' as const, decidedAt: now() }
    this.tables.saveApproval(rejected)
    return rejected
  }

  /**
   * VsSaros addition (superagent v2): writes a Bot draft a person agreed to as part of a ticket's team proposal. The
   * agreement covers the risks the proposal listed, so no second approval is asked; an existing Bot with the same id or
   * name is returned instead, which makes agreeing again after a failure safe.
   */
  async createAgreed(draft: BotDraft, ticketId: string): Promise<{ id: string; name: string; created: boolean }> {
    const bus = this.need()
    if (typeof bus.createBot !== 'function') throw new TeamError('This Host\'s VsSaros Bots cannot create a Bot; update @vssaros/dsh-agents to 0.2.320+')
    const duplicate = (await bus.listBots()).find(card => card.id === draft.id || card.name === draft.name)
    if (duplicate) return { id: duplicate.id, name: duplicate.name, created: false }
    this.checkBotQuota(ticketId)
    const view = await this.commitBot(bus, draft, ticketId)
    return { id: view.id, name: view.name, created: true }
  }
  private checkBotQuota(planId?: string): void {
    if (planId && this.tables.botsIn(planId).length >= TEAM_BOTS_PER_PLAN) throw new TeamError(`This ticket already created ${TEAM_BOTS_PER_PLAN} Bots`)
    if (this.tables.createdBots().length >= TEAM_BOTS_GLOBAL) throw new TeamError(`The supervisor has created ${TEAM_BOTS_GLOBAL} Bots; no more without removing one`)
  }

  private async commitBot(bus: TeamBus, draft: BotDraft, planId?: string): Promise<CreatedBotView> {
    let view: CreatedBotView
    try { view = await bus.createBot!({ draft }) }
    catch (error) { throw new TeamError(`VsSaros Bots could not create ${draft.id}: ${error instanceof Error ? error.message : String(error)}`) }
    this.tables.saveBot({ ...draft, preset: view.preset, file: view.file, at: now(), ...planId ? { planId } : {} })
    return view
  }

  private need(): TeamBus {
    const bus = this.bus()
    if (!bus?.available()) throw new TeamError('VsSaros Bots are not running in this Host')
    return bus
  }
}
