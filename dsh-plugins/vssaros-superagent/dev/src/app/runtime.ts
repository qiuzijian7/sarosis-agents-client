/** Application composition root and lifecycle manager for dsh-superagent. */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '../infra/host.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { acquireStateLock } from './state-lock.ts'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, ticketOfSession, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { changeEndNotices } from '../sources/p4-change.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions, WORKER_PRESET } from './sessions.ts'
import { Settings } from './settings.ts'
import { Reviews } from './review.ts'
import { Retrospective } from './retrospective.ts'
import { TeamArchive } from './team-archive.ts'
import { sharedTeamBus, Team } from './team.ts'
import { Staffing } from './staffing.ts'
import { stepOfSession, stepTools, TeamSteps } from './steps.ts'
import { UsageLedger } from './usage.ts'
import { ContextSteward } from './steward.ts'
import { coexistenceOf, type Coexistence } from './coexist.ts'
import { Distiller } from './distill.ts'
import { deliverReply, deskReceiptStream, deskRequestId, deskSessionId, deskTools, latestPersonMessage, TICKET_ENDED_NOTICE, ticketEndedNotice } from './desk.ts'
import { DeskChat } from './desk-chat.ts'
import { DeskOutbox, wakesDesk } from './desk-outbox.ts'
import { GROUP_REFERENCE_KIND, GROUP_REFERENCE_LATE_MS, GROUP_REFERENCE_WAIT_MS, handleDeskGroupCommand, handleDeskMessage, mayBeGroupCommand,
  type GroupSettlement } from './groupFastPath.ts'
import { GroupRoutes } from './group-routes.ts'
import { sandboxWorks, StepActivity, StepApprovals, stepPermission } from './step-approvals.ts'
import { Feed } from './feed.ts'
import { deskFlow, type DeskFlow } from './desk-flow.ts'
import { botTrigger, DESK_PERSON, deskTrigger, makeSuperagentKind, SUPERAGENT_HOPS_MAX, SUPERAGENT_SOURCE } from '../sources/superagent.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  /** VsSaros addition: changelist reviews, which alone submit to P4. */
  readonly reviews: Reviews
  /** VsSaros addition: the main Session's team plans, given to VsSaros Bots. */
  readonly team: Team
  /** VsSaros addition: skills and team workflows a finished plan leaves behind. */
  readonly retro: Retrospective
  /** VsSaros change (2026-11-06): the retired team track, read-only. */
  readonly archive: TeamArchive
  /** VsSaros addition (superagent v2): a ticket's team, which a person agrees to before any worker starts. */
  readonly staffing: Staffing
  /** VsSaros addition (superagent v2, P3): the steps of agreed teams, each done by its Bot. */
  readonly steps: TeamSteps
  /** VsSaros addition (superagent v2, P4): team step evidence handed to the VsSaros memory system. */
  readonly distiller: Distiller
  /** VsSaros addition (plan C): team steps' approval requests and what their Bots do now. */
  readonly stepApprovals: StepApprovals
  readonly stepActivity: StepActivity
  /** VsSaros addition (plan C): changes pushed to open pages. */
  readonly feed = new Feed()
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  /** VsSaros addition (2026-11-06): the usage ledger of SuperAgent's Sessions. */
  usage!: UsageLedger
  steward!: ContextSteward
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  /** VsSaros addition: the supervisor desk's Session, where a person talks to SuperAgent (the `superagent` Source). */
  readonly deskId: string
  /** VsSaros addition: the desk conversation, which the panel's Chat tab shows and sends to. */
  readonly deskChat: DeskChat
  /** VsSaros fix (2026-11-05): the supervisor's messages that wake the desk, written down before they are delivered. */
  readonly deskOutbox: DeskOutbox
  /** VsSaros addition (2026-11-06): which group chat a desk message went to (the link between Triggers and group runs). */
  readonly groupRoutes: GroupRoutes
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    // The sync lock API cannot retry, so the helper reclaims locks a killed Host left behind and lets an
    // in-process rebuild (HMR) hand the lock over instead of failing with "Lock file is already being held".
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = acquireStateLock(machine.stateDir, compromised)
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const deskId = this.deskId = deskSessionId(machine.stateDir)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      // VsSaros fix (2026-11-06): health entries survive a restart (an error stays shown until its part reports again).
      board.persist(store.db)
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      // VsSaros addition: the `superagent` Source belongs to the Runtime, which owns the Sessions its replies go into.
      // VsSaros addition: the desk conversation the panel's Chat tab shows; a reply to the desk is logged before it is delivered,
      // so the panel shows it even when the desk Session is gone.
      const deskChat = this.deskChat = new DeskChat({ store, deskId, receive: trigger => this.passes.receive(trigger),
        echo: (requestId, text) => this.sessions.prompt(deskId, requestId, text, { inject: '本机用户' }),
        filesDir: join(machine.stateDir, 'desk-files'), warn: message => { ctx.logger.warn('dsh-superagent: %s', message) } })
      this.disposers.push(sources.register(makeSuperagentKind(async (address, message) => {
        if (address.kind !== 'desk') return deliverReply(this.sessions, address, message)
        // VsSaros fix (2026-11-05): a desk reply goes to today's desk, which the workbench shows, even for a ticket begun at
        // an earlier desk (the built-in's desk is a new Session; the incubating one's stays bound to its old workbench).
        // Every reply is logged for the panel; one that needs the person's answer is written to the desk outbox, which wakes
        // the desk with it and keeps it until the desk's conversation has it (desk-outbox.ts). The Source's part is done once
        // it is written down.
        deskChat.logReply(message)
        this.feed.changed('desk')
        if (wakesDesk(message)) this.deskOutbox.post({ ...message, channel: { ...message.channel, address: { kind: 'desk', session: deskId } } })
        return 'sent'
      })))
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent),
        deskId, deskTools: agent => deskTools({ receive: trigger => this.passes.receive(trigger), ticket: id => store.tickets.get(id) }, agent),
        // VsSaros addition (superagent v2, P3): a team step's Session, under its Bot's preset.
        step: sessionId => {
          const step = runtime.steps?.step(sessionId)
          return step && { ticketId: step.ticketId, key: step.key, access: step.access, preset: step.preset, state: step.state,
            ...step.unsandboxed ? { unsandboxed: true as const } : {}, ...step.bot.tools ? { tools: step.bot.tools } : {} }
        },
        stepTools: (_agent, step) => stepTools(runtime.steps, step),
        // VsSaros addition (2026-11-06): the token budget's hard gate, and the coordinator's guard.
        overBudget: ticketId => runtime.steps?.overBudget(ticketId) ?? false,
        unfinishedSteps: ticketId => runtime.steps?.unfinished(ticketId).length ?? 0 })
      // VsSaros fix (2026-11-05): the supervisor's messages that wake the desk, kept until its conversation has them.
      const deskAddress = { kind: 'desk' as const, session: deskId }
      this.groupRoutes = new GroupRoutes(store.db)
      this.deskOutbox = new DeskOutbox({ store, context: ctx, deskId, closing: () => this.closing(),
        deliver: message => deliverReply(sessions, deskAddress, message),
        messageIdOf: message => sessions.promptedId(deskRequestId(message.id)),
        recorded: message => sessions.recorded(deskId, deskRequestId(message.id)),
        warn: message => { ctx.logger.warn('dsh-superagent: %s', message) } })
      // VsSaros addition (2026-11-06): the desk answers a ticket's end with its end card and one line, without its model.
      const llmEvents = ctx as unknown as { on(name: 'llm/stream', listener: ReturnType<typeof deskReceiptStream>): () => void }
      this.disposers.push(llmEvents.on('llm/stream', deskReceiptStream({ deskId, ticketEndedOf: messageId => {
        const message = this.deskOutbox.messageOf(messageId)
        return message?.id.startsWith(`${TICKET_ENDED_NOTICE}:`) ? message.ticketId : undefined
      } })))
      // VsSaros addition (2026-11-06): the usage ledger of SuperAgent's Sessions; its one listener also meters team steps'
      // tokens for the team's token budget (a hard gate), so both count each call once.
      this.usage = new UsageLedger(store.db, sessionId => {
        if (sessionId === masterId) return { role: 'master' }
        if (sessionId === deskId) return { role: 'desk' }
        const worker = ticketOfSession(sessionId)
        if (worker) return { role: 'worker', ticketId: worker }
        const ref = stepOfSession(sessionId)
        if (!ref) return undefined
        const step = runtime.steps?.step(sessionId)
        return { role: 'step', ticketId: ref.ticketId, step: ref.key, ...step ? { bot: step.bot.name } : {} }
      })
      this.disposers.push((ctx as unknown as { on(name: 'llm/stream', listener: ReturnType<UsageLedger['listener']>): () => void })
        .on('llm/stream', this.usage.listener(call => {
          if (call.role === 'step') runtime.steps?.meter(call.session, { inputTokens: call.input, outputTokens: call.output, cacheReadTokens: call.cacheRead, cacheWriteTokens: call.cacheWrite })
        })))
      // VsSaros addition (2026-11-06): the main Session and the desk are compacted while idle, past their check line.
      const ledger = this.usage, windows = new Map<string, Promise<{ window: number; maxOutput?: number } | undefined>>()
      this.steward = new ContextSteward({ watched: id => id === masterId ? 'master' : id === deskId ? 'desk' : undefined, last: id => ledger.last(id),
        modelWindow: (provider, model) => {
          const key = `${provider}/${model}`
          if (!windows.has(key)) windows.set(key, (async () => {
            const llm = ctx.llm as unknown as { resolveModelInfo?(p: string, m: string): Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number }> }
            const info = await llm.resolveModelInfo?.(provider, model)
            return info?.context?.contextWindow ? { window: info.context.contextWindow, ...info.defaultMaxTokens ? { maxOutput: info.defaultMaxTokens } : {} } : undefined
          })().catch(() => undefined))
          return windows.get(key)!
        },
        compactor: agent => {
          try {
            const presets = ctx.get('agentPresets') as { serviceFor?(agent: unknown, name: string): unknown } | undefined
            return (presets?.serviceFor?.(agent, 'compaction') ?? ctx.get('compaction')) as never
          } catch { return undefined }
        },
        info: message => { ctx.logger.info(message) }, warn: message => { ctx.logger.warn(message) } })
      const steward = this.steward
      this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle' && (agent.id === masterId || agent.id === deskId) && !this.closing()) void steward.consider(agent as never)
      }))
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger),
        // VsSaros addition: a ticket whose CL a person reviews keeps its inputs until the review ends.
        held: ticketId => runtime.reviews.held(ticketId),
        // VsSaros addition (superagent v2, P3): the lead of a team runs; its steps may start.
        launched: ticketId => { void runtime.steps?.kick(ticketId) } })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate), db: store.db })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome),
        // VsSaros addition (superagent v2): a new ticket waits for a person to agree to its team.
        staffing: () => store.settings().executor.staffing,
        // VsSaros fix (2026-11-06, real run): the desk is one conversation for every request, so a later message there must
        // not resume a ticket that ended; it reaches only live ones (agreeing to a team, steering, stopping).
        conversation: key => key === deskChat.thread, emit: event => {
          // VsSaros addition (plan C): open pages read tickets, proposals and decisions again.
          runtime.feed.changed('tickets')
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // VsSaros addition (plan C): a listed person's 同意 / 拒绝 on the ticket's Feishu thread answers a step's request.
          const received = event.type === 'trigger.received' ? store.triggers.get(event.data.triggerId) : undefined
          if (received) runtime.stepApprovals?.fromMessage(received)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured() && setup.deployment.repository) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message) // VsSaros patch: only with a GitHub repository
          }
          // VsSaros addition: a ticket that ended with its CL submitted tells its conversations, such as its TAPD item.
          if (ended) for (const message of changeEndNotices(ended, thread => store.threads.get(thread)?.meta)) outbox.send(message)
          // VsSaros addition (2026-11-06): a ticket begun in the desk tells the desk how it ended (see desk.ts).
          const receipt = ended ? ticketEndedNotice(ended, store.triggers.get(ended.origin.triggerId)?.channel) : undefined
          if (receipt) outbox.send(receipt)
          // VsSaros addition (superagent v2, P3): its team's unfinished steps stop with it.
          if (ended) runtime.steps?.stopAll(ended.id, ended.ended?.reason ?? ended.ended?.outcome ?? 'the ticket ended')
          // VsSaros addition (superagent v2, P5): its agreed team leaves a workflow draft, or credits the workflow it reused.
          if (ended?.team) {
            const agreed = runtime.staffing?.tables.versions(ended.id).find(proposal => proposal.state === 'approved')
            runtime.retro?.onTicketEnd(ended, agreed, store.triggers.get(ended.origin.triggerId)?.text)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      // VsSaros addition: the review gate in front of every P4 submit, reachable only from the panel's routes.
      const reviews = this.reviews = new Reviews({ store, engine, get p4() { return runtime.context({ kind: 'p4', health: ['p4'] }) },
        release: ticketId => { this.executor.release(ticketId) } })
      // VsSaros addition: reusable team workflows (skills are written only by the memory system, from team_distill).
      const retro = this.retro = new Retrospective({ store, warn: message => { ctx.logger.warn('dsh-superagent: %s', message) } })
      // VsSaros change (2026-11-06, P1 · one track): the retired team plans and template skills, read-only.
      this.archive = new TeamArchive(store)
      // VsSaros addition: the roster, Bots the supervisor creates, and group chats.
      const team = this.team = new Team({ store, warn: message => { ctx.logger.warn('dsh-superagent: %s', message) } })
      // VsSaros addition (superagent v2, P4): each finished step's evidence goes to the VsSaros memory system.
      const distiller = this.distiller = new Distiller({ store, warn: message => { ctx.logger.warn('dsh-superagent: %s', message) } })
      // VsSaros addition (superagent v2, P3): the steps of an agreed team, each done by its Bot in a Session of its own.
      // Plan C: a read step is read-only and a write step writes its directory, sandboxed where this machine can.
      const sandbox = new Map<string, Promise<boolean>>()
      const stepActivity = this.stepActivity = new StepActivity(ctx, () => { this.feed.changed('steps') })
      const steps = this.steps = new TeamSteps({ context: ctx, store, engine, sessions, fallbackPreset: WORKER_PRESET,
        presetOf: botId => this.team.presetOf(botId),
        closing: () => this.closing(), paused: () => this.paused(), warn: message => { ctx.logger.warn('dsh-superagent: %s', message) },
        ended: step => { void distiller.stepEnded(step) }, changed: () => { this.feed.changed('steps') },
        permission: async (step, directory) => {
          if (step.access === 'read') return stepPermission('read', true)
          if (!sandbox.has(directory)) sandbox.set(directory, machine.sandboxProbe ? machine.sandboxProbe(directory) : sandboxWorks(directory))
          const works = await sandbox.get(directory)!
          if (!works) ctx.logger.warn('dsh-superagent: this machine cannot sandbox %s; write steps there run unsandboxed', directory)
          return stepPermission('write', works)
        },
        doing: sessionId => stepActivity.of(sessionId),
        approval: (ticketId, key) => runtime.stepApprovals?.of(ticketId, key)?.id })
      this.stepApprovals = new StepApprovals({ context: ctx, store, outbox, engine, changed: () => { this.feed.changed('steps') },
        steps: { step: id => steps.step(id), get: (ticketId, key) => steps.tables.get(ticketId, key), message: (ticketId, key, text) => steps.message(ticketId, key, text) },
        warn: message => { ctx.logger.warn('dsh-superagent: %s', message) } })
      // VsSaros addition (superagent v2): a ticket's team, proposed by the main Session and agreed by a person.
      const staffing = this.staffing = new Staffing({ store, engine, team, outbox, steps })
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources, team, retro, staffing, steps, workflows: retro,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        // VsSaros addition (p4 Source).
        get p4() { return runtime.context({ kind: 'p4', health: ['p4'] }) }, reviews,
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        // VsSaros addition (2026-11-05): the supervisor tells the conversation a request came from (a group chat it made).
        tellTrigger: (triggerId, id, text) => {
          const channel = store.triggers.get(triggerId)?.channel
          if (!channel) return false
          outbox.send({ id, channel, kind: 'notice', text })
          return true
        },
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    // VsSaros addition: take the Bots' reports from here on, and those that ended while dsh-superagent was down.
    // VsSaros addition (superagent v2, P3): team steps' turn ends and errors.
    this.disposers.push(this.steps.install())
    // VsSaros addition (superagent v2, P4): evidence the memory system has not taken yet.
    this.disposers.push(this.distiller.install())
    // VsSaros addition: the desk's scheduled messages.
    this.disposers.push(this.deskChat.install())
    // VsSaros addition (plan C): team steps' approvals, answered here ahead of DSH, and what their Bots do now.
    this.disposers.push(this.stepApprovals.install(), this.stepActivity.install())
    // VsSaros addition: a message typed in the desk's own (DSH) chat box is the desk's at once, without waiting for the desk's
    // model to hand it over; its tool, which may still be called, then finds it handed over already.
    const warnFastPath = (message: string) => { this.ctx.logger.warn('dsh-superagent: %s', message) }
    // VsSaros addition (2026-11-06): the group a Trigger went to, its ignore decision and the "group made" notice commit in one
    // transaction. A decision that cannot be recorded (the Trigger was decided already) is warned about; the route still holds.
    const settle = (triggerId: string, settlement: GroupSettlement) => this.store.atomic(() => {
      this.groupRoutes.record({ triggerId, ...settlement.route, at: now() })
      try { this.engine.decide(triggerId, { kind: 'ignore', reason: settlement.reason }) } catch (error) {
        warnFastPath(`group intake could not record the ignore decision for ${triggerId}: ${String(error)}`)
      }
      if (settlement.notice) this.toolHost.tellTrigger?.(triggerId, settlement.notice.id, settlement.notice.text)
    })
    // VsSaros fix (2026-11-06, real run): a message the group paths take (`@群 …`, or one that makes a group) is the group's,
    // so it reaches no ticket of the desk; before, a live or ended desk ticket took it too and the ignore decision was refused.
    const groupFastHost = {
      receive: (t: Trigger) => this.engine.receive(t, { tickets: false }),
      settle,
      requestPass: () => this.passes.request(),
      bots: async () => (await this.team.bots()).map(bot => ({ id: bot.id, name: bot.name, delegatable: bot.delegatable })),
      createGroup: (input: Parameters<Team['createGroup']>[0]) => this.team.createGroup(input),
      warn: warnFastPath,
      fallback: (t: Trigger) => { void this.passes.receive(t) },
    }
    const groupCommandHost = {
      receive: (t: Trigger) => this.engine.receive(t, { tickets: false }),
      settle,
      requestPass: () => this.passes.request(),
      listGroups: async () => {
        try { return await this.team.groups() } catch (error) { warnFastPath(`group command could not list groups: ${String(error)}`); return [] }
      },
      warn: warnFastPath,
    }
    // DSH 把「真消息」和「引用会话」拆成两条 user/message。只有以 @ 开头的消息才可能是群命令：它最多等
    // GROUP_REFERENCE_WAIT_MS 让引用事件到；其它消息立刻走常规路径。引用事件晚于窗口到达时，仍在
    // GROUP_REFERENCE_LATE_MS（与 agents 插件同一窗口）内补记为 @群，结束主管那次评估，不让两边都处理同一条消息。
    type DeskItem = { trigger: Trigger; text: string; messageId: string }
    let pendingDeskMessage: (DeskItem & { timer: ReturnType<typeof setTimeout> }) | null = null
    let recentAddressed: (DeskItem & { at: number }) | null = null
    const normal = (item: DeskItem) => {
      if (this.closing()) return
      void handleDeskMessage(groupFastHost, item.trigger, item.text).catch(error => {
        warnFastPath(`group fast path crashed: ${String(error)}`)
        void this.passes.receive(item.trigger)
      })
    }
    const flushPending = () => {
      const item = pendingDeskMessage
      if (!item) return
      pendingDeskMessage = null
      clearTimeout(item.timer)
      recentAddressed = { trigger: item.trigger, text: item.text, messageId: item.messageId, at: Date.now() }
      normal(item)
    }
    const clearPending = () => {
      const item = pendingDeskMessage
      pendingDeskMessage = null
      if (item) clearTimeout(item.timer)
    }
    this.disposers.push(() => clearPending())
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      if (session.id !== this.deskId || event.type !== 'user/message' || this.closing()) return
      const sourceKind = (event as { data?: { source?: { kind?: unknown } } })?.data?.source?.kind
      if (sourceKind === GROUP_REFERENCE_KIND) {
        const item = pendingDeskMessage
        if (item) {
          pendingDeskMessage = null
          clearTimeout(item.timer)
          void handleDeskGroupCommand(groupCommandHost, item.trigger, item.text, event, { sourceMessageId: item.messageId }).then(result => {
            if (result === 'fallback') normal(item)
          }).catch(error => {
            warnFastPath(`group command fast path crashed: ${String(error)}`)
            normal(item)
          })
          return
        }
        const late = recentAddressed
        recentAddressed = null
        if (!late || Date.now() - late.at > GROUP_REFERENCE_LATE_MS) return
        void handleDeskGroupCommand(groupCommandHost, late.trigger, late.text, event, { sourceMessageId: late.messageId, late: true })
          .catch(error => { warnFastPath(`late group command crashed: ${String(error)}`) })
        return
      }
      const person = latestPersonMessage([event as never])
      if (!person) return
      if (pendingDeskMessage) flushPending()
      recentAddressed = null
      const trigger = deskTrigger({ session: this.deskId, messageId: person.id, text: person.text, at: now() })
      const item = { trigger, text: person.text, messageId: person.id }
      if (!mayBeGroupCommand(person.text)) { normal(item); return }
      pendingDeskMessage = { ...item, timer: setTimeout(flushPending, GROUP_REFERENCE_WAIT_MS) }
    }))
    // VsSaros fix (2026-11-05): the desk outbox delivers what the desk's conversation does not have yet (a closed Session
    // drops its inbox), and marks each message as the conversation records it.
    this.disposers.push(this.deskOutbox.install())
    // VsSaros addition: appear in the Bots roster as the supervisor. A Bot's agent_message to it becomes a Trigger of the
    // `superagent` Source, which the gate admits only from a Bot on that Source's list, and its answer goes back to the Bot.
    const withdraw = sharedTeamBus()?.registerExternalBot?.({
      id: 'superagent', name: 'SuperAgent', role: '主管', session: this.deskId,
      description: '主管：评估需求、找或建 bot、组团执行任务；可用 agent_message 找它求助',
      onMessage: async ({ id, from, fromBot, fromName, text, hop }) => {
        if (!from) throw new Error('SuperAgent answers a Bot in its own Session; this message has no sender Session')
        if (hop > SUPERAGENT_HOPS_MAX) throw new Error(`This relay already passed ${SUPERAGENT_HOPS_MAX} hops; answer the person instead`)
        const result = await this.passes.receive(botTrigger({ id: id ?? key('bot-help', from, String(hop), text),
          session: from, bot: fromBot ?? null, name: fromName ?? null, text, hop, at: now() }))
        return { received: result }
      },
    })
    if (withdraw) this.disposers.push(withdraw)
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    // VsSaros addition: the supervisor desk, and the person at this machine on its Source's list.
    await this.sessions.ensure(this.deskId, this.machine.stateDir, 'SuperAgent · 主管对话', 'desk')
    await this.listDeskPerson()
    this.context({ kind: SUPERAGENT_SOURCE, health: [SUPERAGENT_SOURCE] })
      .report(SUPERAGENT_SOURCE, { state: 'ready', detail: `Supervisor desk ${this.deskId}` })
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    void this.steps.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  /**
   * VsSaros addition: the gate reads a Source's list from the stored Policy, so the person at this machine is written onto
   * the `superagent` list once, when the Policy has no part for it yet; a person may remove them later in the Policy.
   */
  private async listDeskPerson(): Promise<void> {
    const current = this.store.settings()
    if (current.policy.sources[SUPERAGENT_SOURCE] || allowedSender(current, { source: SUPERAGENT_SOURCE, id: DESK_PERSON.id })) return
    const policy = { ...current.policy, sources: { ...current.policy.sources, [SUPERAGENT_SOURCE]: { allowed: [{ ...DESK_PERSON }], bots: [] } } }
    // Saved as the Runtime's own change ('tool'), so the main Session gets no settings notice for it: no person changed anything.
    await this.settings.save('policy', policy, this.store.blockRevision('policy'), 'tool')
      .catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent: could not list the desk person: %s', String(error)) })
  }
  private coexistLogged = false
  /** VsSaros addition (2026-11-06): other Bot plugins in this Host; said once in the log when one is found. */
  coexistence(): Coexistence {
    let loader: unknown
    try { loader = (this.ctx as unknown as { get(name: string): unknown }).get('loader') } catch { loader = undefined }
    const found = coexistenceOf(loader)
    if (found.dsBot && !this.coexistLogged) {
      this.coexistLogged = true
      this.ctx.logger.info('dsh-superagent: DS Bot runs in this Host too; its secrets redaction, image reading and skills also reach SuperAgent\'s Sessions')
    }
    return found
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes, reviews, team, retro, staffing, distiller, steps, deskChat, deskId, stepApprovals, feed } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, reviews, team, retro, staffing, distiller, steps, deskChat, deskId, stepApprovals, feed,
      outbox: this.outbox, archive: this.archive,
      coexist: () => this.coexistence(), usage: this.usage, steward: this.steward,
      deskFlow: (triggerId: string): DeskFlow => deskFlow({ store, proposal: ticketId => staffing.tables.latest(ticketId), team: ticketId => steps.view(ticketId),
        approvals: () => stepApprovals.list(), route: id => this.groupRoutes.get(id) }, triggerId),
      // VsSaros addition: local lark-cli diagnostics and confirmed maintenance for the Feishu Source.
      cli: setup.cli,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
