/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '../infra/host.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dirname } from 'node:path'
import { z } from 'zod'
import { assignmentRole, key, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import { DESK_PROMPT } from './desk.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import { within } from './step-approvals.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[]
  /** VsSaros addition: the supervisor desk's Session ID, and its only tools (see `src/app/desk.ts`). */
  readonly deskId?: string
  deskTools?(agent: Agent): Tool[]
  /**
   * VsSaros addition (superagent v2, P3): the team step a Session does (see `src/app/steps.ts`), with its Bot's preset, and
   * the tools such a Session gets beside its Bot's own.
   */
  step?(sessionId: string): StepBinding | undefined
  stepTools?(agent: Agent, step: StepBinding): Tool[]
  /** VsSaros addition (2026-11-06): whether a ticket's team used its token budget up, and how many of its steps are unfinished. */
  overBudget?(ticketId: string): boolean
  unfinishedSteps?(ticketId: string): number
}
/** VsSaros fix (2026-11-06): DSH refused the permission preset a team step should run under. */
export class StepPermissionError extends Error {
  constructor(readonly preset: string, readonly cause: string) { super(`Permission ${preset} could not be set: ${cause}`) }
}
/** What Sessions needs to know of a team step's Session. */
export interface StepBinding { ticketId: string; key: string; access: 'read' | 'write'; preset: string; state: string; unsandboxed?: true
  /** VsSaros addition (2026-11-06): the Bot's own tools (exact names or `*` patterns); unset on steps agreed before. */
  tools?: string[] }
/**
 * VsSaros addition (2026-11-06, P1 · one execution model): the tools a team step's Session may use: the work tools every
 * worker has, its Bot's own tools, and the step's tools (its report). A Bot tool may be a `*` pattern (`mcp__github__*`).
 * Unset `botTools` (a step agreed before 2026-11-06) leaves only the Bot's preset limiting it.
 */
export function stepToolAllowed(name: string, botTools: readonly string[] | undefined, own: readonly string[]): boolean {
  if (!botTools || own.includes(name) || WORK_TOOLS.includes(name)) return true
  return botTools.some(pattern => pattern === name || (pattern.includes('*')
    && new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name)))
}
/** The section of a coordinator's Session (core `AssignmentRole`). */
const COORDINATOR_PROMPT = [
  'You coordinate this ticket\'s team; you do not do its steps. Each step is done by its Bot in a Session of its own.',
  '- A blocked step needs a person: ask them, then pass the answer with orchestrator_step_message.',
  '- Each step already gets the reports of the steps it waits for: do not relay them. Message a step only to pass on what a person said.',
  '- While a step is unfinished you change no file and run no command (those tools are refused); end your turns until you hear of the steps.',
  '- Once every step finished, check the results (you may read, run the tests and fix small things then), and report the ticket with orchestrator_report.',
].join('\n')
/** The coordinator's tools refused while a step is unfinished: the steps' Bots do that work (core `AssignmentRole`). */
export const COORDINATOR_REFUSED = ['write', 'edit', 'bash', 'pwsh']

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: it refuses a bash command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash' || name === 'pwsh') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = sessionId === this.host.masterId || sessionId === this.host.deskId ? ROUTER_PRESET
          : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : this.host.step?.(sessionId)?.preset
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /**
   * Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, sets `danger-full-access` permissions, and renames it to `title`.
   * VsSaros addition: the supervisor desk (`'desk'`) runs under the router preset with the Eval model; it is left with its one tool.
   * A team step (`'step'`) runs under its Bot's `preset` and keeps the Bot's model, with the `permission` its access allows
   * (plan C: `read-only` or `workspace-write`; `danger-full-access` when this machine cannot sandbox it).
   */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker' | 'desk' | 'step', preset?: string, permission?: string): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml), or a team step's Bot's.
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'step' ? preset ?? WORKER_PRESET : role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    const settings = this.host.store.settings()
    if (role !== 'step') await initializeRoleModel(ctx, result.agent, role === 'worker' ? settings.executor.model : settings.eval.model)
    await this.decorate(result.agent)
    const wanted = role === 'step' && permission ? permission : 'danger-full-access'
    try { ctx.permissionPresets.set(result.agent.session, wanted) } catch (error) {
      // VsSaros fix (2026-11-06): a step whose permission cannot be set no longer runs with full access in silence; the
      // step is blocked for a person to decide (steps.ts). Other Sessions run with full access, so they fail as before.
      if (role === 'step') throw new StepPermissionError(wanted, String(error))
      throw error
    }
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** VsSaros addition: whether the message `prompt` delivered under `requestId` is in the Session's conversation, not just its inbox. */
  async recorded(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    return this.agentDelivery.recorded(result.agent, key(requestId))
  }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    if (host.deskId !== undefined && agent.id === host.deskId) { this.decorateDesk(agent); return }
    const step = host.step?.(agent.id)
    if (step) { this.decorateStep(agent, step); return }
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    // VsSaros patch: `dispose()` need not return a promise, and `.catch` of undefined hid release failures.
    binding.disposers.push(() => { Promise.resolve(skillScope.dispose()).catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      // VsSaros patch (Windows): restrict refuses a tool name the installation does not have, and there is no `bash`
      // where the shell is PowerShell, so name only what the preset really provides.
      const parent = scopeParentOf(agent)
      const allow = ['skill', 'bash', 'pwsh', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'].filter(name => agent.ctx.tools.get(name, parent))
      binding.disposers.push(agent.ctx.tools.restrict({ allow }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
      // VsSaros addition (2026-11-06, P1 · one execution model): a ticket with an agreed team is coordinated, not worked on, by
      // its Assignment (core `AssignmentRole`): its section says so, and while a step is unfinished it changes no file and
      // runs no command; afterwards it may check the results.
      // A team ticket's worker starts only once its team is agreed, so its role is known here and does not change.
      const ticketId = ticket!.id
      if (assignmentRole(ticket!) === 'coordinator') {
        binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-coordinator', order: 9998, interpolate: false, text: () => COORDINATOR_PROMPT }),
          agent.ctx.tools.guard(({ name }) => {
            if (!COORDINATOR_REFUSED.includes(name)) return undefined
            const open = host.unfinishedSteps?.(ticketId) ?? 0
            return open ? `You coordinate this ticket's team: its ${open} unfinished step(s) are done by their Bots. Relay answers with orchestrator_step_message; check the results once every step finished.` : undefined
          }))
      }
    }
  }
  /**
   * VsSaros addition (superagent v2, P3): a team step's Session keeps its Bot's persona, tools, skills and model; it gets a
   * short section on the step, its report tool, and a guard: no tool once the ticket ended or the step stopped, and none that
   * writes a file on a read-only step (its shell can still write, which its section forbids).
   */
  private decorateStep(agent: Agent, step: StepBinding): void {
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    const ticket = this.host.store.tickets.get(step.ticketId)
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-step', order: 9999, interpolate: false,
      text: () => [`You are doing step ${step.key} of a dsh-superagent ticket as a member of its team. Do only your step and report it with orchestrator_step_report.`,
        step.access === 'read' ? 'This step is read-only: change no file.' : 'This step may change files in its directory.',
        ticket ? mandateInstructions(ticket.mandate) : ''].filter(Boolean).join('\n') }))
    const register = this.registerTool(agent, binding)
    const own = (this.host.stepTools?.(agent, step) ?? []).map(tool => { register(tool.name, tool.description, tool.schema, tool.execute); return tool.name })
    // VsSaros addition (2026-11-06): WORK_TOOLS ∪ the Bot's tools, explicitly. DSH can mask only exact names it knows and
    // cannot list tools, so the mask is set when the Bot names its tools exactly; the guard below enforces it in every case.
    if (step.tools && !step.tools.some(name => name.includes('*'))) {
      const parent = scopeParentOf(agent)
      const allow = [...new Set([...WORK_TOOLS, ...step.tools])].filter(name => agent.ctx.tools.get(name, parent))
      if (allow.length) binding.disposers.push(agent.ctx.tools.restrict({ allow }))
    }
    binding.disposers.push(agent.ctx.tools.guard(({ name, arguments: args }) => {
      const current = this.host.store.tickets.get(step.ticketId), now = this.host.step?.(agent.id)
      if (!current || !liveTicket(current)) return 'Ticket ended; this step takes no more work'
      if (now && ['stopped', 'skipped', 'failed'].includes(now.state)) return `This step is ${now.state}`
      // VsSaros fix (2026-11-06, real-machine run): a step that reported ready does no more work until it is sent back
      // (rework makes it pending again); a message steered in after its report woke it to run its tools again.
      if (now?.state === 'ready') return 'This step already reported ready: end your turn now, calling no tools'
      if (!stepToolAllowed(name, step.tools, own)) return `${name} is neither a work tool nor one of this Bot's tools`
      // The token budget is a hard gate: once used up, a step may only report.
      if (!own.includes(name) && this.host.overBudget?.(step.ticketId)) return 'The team used its token budget: report now with orchestrator_step_report (blocked if unfinished)'
      if (step.access === 'read' && (name === 'write' || name === 'edit')) return 'This step is read-only: change no file'
      // Plan C: a write step this machine could not sandbox keeps its file tools inside its directory.
      const directory = current.execution?.directory, path = (args as { file_path?: unknown; path?: unknown } | undefined)
      const target = typeof path?.file_path === 'string' ? path.file_path : typeof path?.path === 'string' ? path.path : undefined
      if (now?.unsandboxed && directory && target && (name === 'write' || name === 'edit') && !within(directory, target)) {
        return `This step may change files only in ${directory}`
      }
      return undefined
    }))
  }
  /**
   * VsSaros addition: the supervisor desk gets its own complete system prompt and its tools only; every tool of the preset
   * is masked, so it can hand a message over but never work on it.
   */
  private decorateDesk(agent: Agent): void {
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-desk', order: 9999, interpolate: false,
      text: () => DESK_PROMPT, complete: true }))
    const register = this.registerTool(agent, binding)
    for (const tool of this.host.deskTools?.(agent) ?? []) register(tool.name, tool.description, tool.schema, tool.execute)
    binding.disposers.push(agent.ctx.tools.restrict({ allow: [] }))
  }
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
