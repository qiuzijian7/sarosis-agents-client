/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Outbox } from './outbox.ts'
import type { Coexistence } from './coexist.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import { ReviewRefused, type Reviews } from './review.ts'
import type { CliCheck } from './cli-check.ts'
import { TAPD_SOURCE } from '../sources/tapd-api.ts'
import { saveTapdCredential, TapdCredentialError, tapdCredentialStatus } from '../sources/tapd-auth.ts'
import { TEAM_BOTS_GLOBAL, TEAM_BOTS_PER_PLAN, TeamError, type Team } from './team.ts'
import type { TeamArchive } from './team-archive.ts'
import type { Retrospective } from './retrospective.ts'
import type { Staffing } from './staffing.ts'
import type { Distiller } from './distill.ts'
import type { TeamSteps } from './steps.ts'
import { APPROVAL_TEMPLATES, type StepApprovals } from './step-approvals.ts'
import type { UsageLedger } from './usage.ts'
import type { ContextSteward } from './steward.ts'
import type { Feed } from './feed.ts'
import type { DeskFlow } from './desk-flow.ts'
import type { DeskChat } from './desk-chat.ts'
import { handleTapdWebhook, TAPD_WEBHOOK_PATH, type TapdWebhookResult } from './tapd-webhook.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  /** VsSaros addition. */
  readonly reviews: Pick<Reviews, 'waiting' | 'audit' | 'view' | 'approve' | 'reject' | 'discard'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  /** VsSaros addition (2026-11-06): other Bot plugins in this Host (read when asked, as plugins come and go). */
  coexist?(): Coexistence
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
  /** VsSaros addition: local lark-cli diagnostics and confirmed maintenance. */
  readonly cli: Pick<CliCheck, 'check' | 'apply'>
  /** VsSaros addition: the main Session's team plans and the Bot drafts waiting for a person. */
  readonly team: Pick<Team, 'available' | 'approvals' | 'createdBots' | 'approve' | 'reject' | 'bots'>
  /** VsSaros change (2026-11-06): the retired team plans and template skills, read-only. */
  readonly archive: Pick<TeamArchive, 'plans' | 'skills'>
  /** VsSaros addition: skills and workflows a finished plan leaves behind. */
  readonly retro: Retrospective
  /** VsSaros addition (superagent v2): a ticket's team, agreed or refused by the person at this machine in the panel. */
  readonly staffing: Pick<Staffing, 'waiting' | 'approveFromPanel' | 'refuse'>
  /** VsSaros addition (superagent v2, P4): team step evidence handed to the memory system, and its skill drafts. */
  readonly distiller: Pick<Distiller, 'list' | 'decide'>
  /** VsSaros addition (superagent v2, P3): open team tickets and their steps. */
  readonly steps: Pick<TeamSteps, 'active' | 'stop' | 'allowUnsandboxed' | 'raiseBudget'>
  /** VsSaros addition (plan C): team steps' requests waiting for a person, and remembered answers. */
  readonly stepApprovals: Pick<StepApprovals, 'list' | 'answer' | 'rules' | 'forget' | 'applyTemplate'>
  /** VsSaros addition (2026-11-06): the usage ledger and the context steward. */
  readonly usage: Pick<UsageLedger, 'summary'>
  readonly steward: Pick<ContextSteward, 'list'>
  /** VsSaros addition (plan C): changes pushed to open pages, and where one desk message stands. */
  readonly feed: Pick<Feed, 'attach' | 'close'>
  deskFlow(triggerId: string): DeskFlow
  /** VsSaros addition: the desk conversation the panel's Chat tab shows and sends to. */
  readonly deskId: string
  readonly deskChat: Pick<DeskChat, 'messages' | 'send' | 'attach' | 'schedules' | 'schedule' | 'unschedule'>
  /** VsSaros fix (2026-11-06): replies whose result is not known, redelivered only by a person. */
  readonly outbox: Pick<Outbox, 'redeliver'>
}
/** VsSaros addition: the Feishu app the saved Feishu Source names, or '' for lark-cli's active profile. */
function feishuAppOf(runtime: Pick<HttpHost, 'store'>): string {
  const config = runtime.store.settings().sources.feishu?.config as { appId?: unknown } | undefined
  return typeof config?.appId === 'string' ? config.appId : ''
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof TapdCredentialError) return [400, { error: error.message }]
  if (error instanceof TeamError) return [400, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  // VsSaros addition: a review the CL as it is now cannot take, with the files that changed since it was read.
  if (error instanceof ReviewRefused) return [409, { error: error.message, changed: error.changed }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository ?? '', agent: resolved.github?.login ?? '', feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, deskId: runtime.deskId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
/** VsSaros addition (superagent v2, P5): the TeamFlow workspace an export or import goes to. */
const TeamflowPlaceSchema = z.object({ cwd: z.string().trim().min(1).max(1000) }).strict()
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem, runtime.coexist?.()),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    // VsSaros addition: read-only local checks, and write actions that the panel must confirm first. Both work on the
    // lark-cli profile of the app the Feishu Source names (its saved `appId`), or the active profile when it names none.
    'POST sources/feishu/cli-check': async ({ body }) =>
      runtime.cli.check(z.object({ update: z.boolean().optional() }).parse(await body()).update ?? false, feishuAppOf(runtime)),
    'POST sources/feishu/cli-apply': async ({ body }) => {
      const request = z.object({ action: z.enum(['strict-bot', 'update']), confirm: z.literal(true) }).parse(await body())
      return runtime.cli.apply(request.action, request.confirm, feishuAppOf(runtime))
    },
    'GET sources/tapd/credentials': () => tapdCredentialStatus(),
    'POST sources/tapd/credentials': async ({ body }) => saveTapdCredential(z.object({
      kind: z.enum(['client', 'user', 'token']).optional(), id: z.string().max(512).optional(),
      secret: z.string().max(512).optional(), clear: z.boolean().optional(),
    }).strict().parse(await body(4096))),
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
    'GET reviews': () => ({ waiting: runtime.reviews.waiting(), audit: runtime.reviews.audit() }),
    'GET tickets/:id/review': async ({ params }) => (await runtime.reviews.view(ticket(params.id))) ?? { review: null },
    'POST tickets/:id/review/approve': async ({ params, body }) =>
      runtime.reviews.approve(ticket(params.id), z.object({ fingerprint: z.string().regex(/^[0-9a-f]{16}$/) }).parse(await body()).fingerprint),
    'POST tickets/:id/review/reject': async ({ params, body }) =>
      runtime.reviews.reject(ticket(params.id), z.object({ comment: z.string().trim().min(1).max(4000) }).parse(await body()).comment),
    'POST tickets/:id/review/discard': ({ params }) => runtime.reviews.discard(ticket(params.id)),
    // VsSaros change (2026-11-06, P1 · one track): the retired team plans, read-only.
    'GET team/plans': () => ({ available: runtime.team.available(), archived: true as const, plans: runtime.archive.plans(20) }),
    'GET team/bots': async () => ({ available: runtime.team.available(), bots: await runtime.team.bots() }),
    'GET team/proposals': () => ({ waiting: runtime.staffing.waiting() }),
    'GET team/distills': () => ({ distills: runtime.distiller.list(undefined, 50) }),
    'GET team/steps': () => ({ tickets: runtime.steps.active(), approvals: runtime.stepApprovals.list() }),
    // VsSaros addition (plan C): a person answers a step's request, forgets a remembered answer, or stops one step.
    'POST steps/approvals/:id/answer': async ({ params, body }) => {
      const { choice } = z.object({ choice: z.enum(['allow', 'remember', 'reject']) }).strict().parse(await body())
      return runtime.stepApprovals.answer(params.id, choice, 'panel')
    },
    'GET steps/rules': () => ({ rules: runtime.stepApprovals.rules(), templates: APPROVAL_TEMPLATES.map(item => ({ id: item.id, risk: item.risk, heads: [...item.heads] })) }),
    'POST steps/rules/templates/:id/apply': async ({ params, body }) => {
      const bot = z.object({ botId: z.string().min(1).max(200), botName: z.string().min(1).max(200) }).strict().parse(await body())
      if (!APPROVAL_TEMPLATES.some(item => item.id === params.id)) throw new RouteError(404, 'No such approval template')
      return { added: runtime.stepApprovals.applyTemplate(params.id, { id: bot.botId, name: bot.botName }, 'panel').length }
    },
    'GET usage': () => {
      const day = new Date(Date.now() - 86_400_000).toISOString(), week = new Date(Date.now() - 7 * 86_400_000).toISOString()
      return { day: runtime.usage.summary(day), week: runtime.usage.summary(week).total, steward: runtime.steward.list() }
    },
    'POST steps/rules/:id/delete': ({ params }) => { runtime.stepApprovals.forget(params.id); return { deleted: true as const } },
    'POST tickets/:id/steps/:key/stop': async ({ params }) => {
      const stopped = await runtime.steps.stop(ticket(params.id), params.key)
      return { step: stopped.key, state: stopped.state }
    },
    // VsSaros addition (2026-11-06): the token and turn budget are hard gates; only a person raises them.
    'POST tickets/:id/steps/budget': async ({ params, body }) => {
      const caps = z.object({ tokens: z.number().int().positive().max(100_000_000).optional(), turns: z.number().int().positive().max(10_000).optional() })
        .strict().refine(value => value.tokens !== undefined || value.turns !== undefined, 'Give tokens or turns').parse(await body())
      return runtime.steps.raiseBudget(ticket(params.id), caps)
    },
    // VsSaros fix (2026-11-06): only a person sends again a reply that may have gone out already.
    'POST replies/:id/redeliver': ({ params }) => {
      if (!runtime.outbox.redeliver(params.id)) throw new UserError('notUnknownReply')
      return { redelivered: true }
    },
    // VsSaros fix (2026-11-06): a person lets a step blocked on its sandbox or permission run without a sandbox.
    'POST tickets/:id/steps/:key/unsandboxed': async ({ params }) => {
      const allowed = await runtime.steps.allowUnsandboxed(ticket(params.id), params.key, 'panel')
      return { step: allowed.key, state: allowed.state }
    },
    'GET desk/messages': () => ({ deskId: runtime.deskId, messages: runtime.deskChat.messages(100) }),
    'GET desk/flow/:id': ({ params }) => runtime.deskFlow(params.id),
    'POST desk/messages': async ({ body }) => {
      const { text } = z.object({ text: z.string().trim().min(1).max(20_000) }).strict().parse(await body())
      return runtime.deskChat.send(text)
    },
    // VsSaros addition: the composer's attachments and scheduled messages.
    'POST desk/files': async ({ body }) => {
      const { name, data } = z.object({ name: z.string().trim().min(1).max(255), data: z.string().max(15_000_000) }).strict()
        .parse(await body(15 * 1024 * 1024))
      return runtime.deskChat.attach(name, Buffer.from(data, 'base64'))
    },
    'GET desk/schedules': () => ({ schedules: runtime.deskChat.schedules() }),
    'POST desk/schedules': async ({ body }) => runtime.deskChat.schedule(z.object({ text: z.string().trim().min(1).max(20_000),
      at: z.string().trim().min(1).max(40), repeat: z.enum(['none', 'daily', 'weekdays']) }).strict().parse(await body())),
    'POST desk/schedules/:id/delete': ({ params }) => { runtime.deskChat.unschedule(params.id); return { deleted: true as const } },
    'POST team/distills/:id/approve': async ({ params }) => runtime.distiller.decide(params.id, 'approve'),
    'POST team/distills/:id/reject': async ({ params }) => runtime.distiller.decide(params.id, 'reject'),
    'POST tickets/:id/team/approve': async ({ params, body }) => runtime.staffing.approveFromPanel(ticket(params.id),
      z.object({ version: z.number().int().min(1) }).strict().parse(await body()).version),
    'POST tickets/:id/team/reject': async ({ params, body }) => {
      const { reason } = z.object({ reason: z.string().trim().max(200).optional() }).strict().parse(await body())
      runtime.staffing.refuse(ticket(params.id), 'panel', reason ?? 'refused by a person in the panel')
      return { rejected: true as const }
    },
    'GET team/approvals': () => ({ waiting: runtime.team.approvals(), created: runtime.team.createdBots(),
      perPlan: TEAM_BOTS_PER_PLAN, global: TEAM_BOTS_GLOBAL }),
    'POST team/approvals/:id/approve': ({ params }) => runtime.team.approve(params.id),
    'POST team/approvals/:id/reject': ({ params }) => { runtime.team.reject(params.id); return { rejected: true as const } },
    'GET team/retrospective': () => ({ skills: runtime.archive.skills(), workflows: runtime.retro.tables.workflows() }),
    'POST team/workflows/:id/save': ({ params }) => runtime.retro.saveWorkflow(params.id),
    'POST team/workflows/:id/teamflow': async ({ params, body }) =>
      runtime.retro.exportTeamflow(params.id, TeamflowPlaceSchema.parse(await body())),
    'POST team/teamflow/import': async ({ body }) => ({ imported: runtime.retro.importTeamflow(TeamflowPlaceSchema.parse(await body())) }),
    // VsSaros change (2026-11-06): a saved workflow runs as v2 — a request in the supervisor desk, which becomes a ticket
    // whose team the main Session proposes prefilled from the workflow (`workflow_id`), and a person agrees to. Its run is
    // credited when that ticket ends (`Retrospective.onTicketEnd`).
    'POST team/workflows/:id/run': async ({ params }) => {
      const prefilled = runtime.retro.prefill(params.id)
      const workflow = runtime.retro.tables.workflow(params.id)!
      const text = `按已保存的团队工作流「${workflow.name}」v${workflow.version}（workflow_id: ${workflow.id}）开工：${workflow.goal}\n`
        + `提出团队时把 workflow_id 传给 orchestrator_team_propose，用它预填角色与步骤（共 ${prefilled.steps.length} 步）。`
      return { sent: true as const, workflow: prefilled.workflow, message: await runtime.deskChat.send(text) }
    },
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // VsSaros addition: a TAPD Webhook is a server-to-server POST authenticated by its own shared secret, not a
      // same-origin browser call, so it gets a separate ingress before the management API's origin check.
      if (url.pathname === TAPD_WEBHOOK_PATH) {
        let result: TapdWebhookResult
        try {
          result = await handleTapdWebhook(req, { context: () => ctx.orchestrator.context({ kind: TAPD_SOURCE, health: [TAPD_SOURCE] }) })
        } catch (error) { result = { status: 500, body: { error: error instanceof Error ? error.message : String(error) } } }
        json(res, result.status, result.body)
        return
      }
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      // VsSaros addition (plan C): the change stream stays open, so it answers outside the JSON route table.
      if (url.pathname === '/orchestrator/api/stream' && (req.method ?? 'GET') === 'GET') { runtime.feed.attach(req, res); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose(); runtime.feed.close() }
}
