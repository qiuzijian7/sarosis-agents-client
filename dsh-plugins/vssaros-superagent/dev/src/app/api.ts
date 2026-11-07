/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { CliApplyAction, CliApplyResult, CliCheckResult } from './cli-check.ts'
import type { TapdCredentialKind, TapdCredentialStatus } from '../sources/tapd-auth.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { AuditEntry, Review } from './review.ts'
import type { BotApproval, BotCard, CreatedBot, CreatedBotView } from './team.ts'
import type { TeamWorkflow } from './retrospective.ts'
import type { PlanView, SkillRecord } from './team-archive.ts'
import type { StaffingProposal } from './staffing.ts'
import type { Distill } from './distill.ts'
import type { TeamflowExport } from './teamflow.ts'
import type { StepsView } from './steps.ts'
import type { ApprovalChoice, ApprovalRule, ApprovalTemplateId, StepApprovalView } from './step-approvals.ts'
import type { UsageSummary } from './usage.ts'
import type { Coexistence } from './coexist.ts'
import type { StewardView } from './steward.ts'
import type { DeskFlow } from './desk-flow.ts'
import type { DeskFile, DeskMessage, DeskSchedule } from './desk-chat.ts'
import type { ReceiveResult } from '../core/index.ts'
import type { FileDiff } from '../sources/p4-change.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  // VsSaros addition: local lark-cli diagnostics and confirmed maintenance for the Feishu Source.
  'POST sources/feishu/cli-check': { body: { update?: boolean }; response: CliCheckResult }
  'POST sources/feishu/cli-apply': { body: { action: CliApplyAction; confirm: true }; response: CliApplyResult }
  // VsSaros addition: TAPD Open API credentials, kept in the Host's credentials file; the response never carries a secret.
  'GET sources/tapd/credentials': { response: TapdCredentialStatus }
  'POST sources/tapd/credentials': { body: { kind?: TapdCredentialKind; id?: string; secret?: string; clear?: boolean }; response: TapdCredentialStatus }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
  // VsSaros addition: changelist reviews. These routes are the only way to submit to P4; no agent tool reaches them.
  'GET reviews': { response: { waiting: Review[]; audit: AuditEntry[] } }
  'GET tickets/:id/review': { response: { review: Review; diffs: FileDiff[]; submit: { mode: 'pipeline' | 'host'; tags: string } } | { review: null } }
  'POST tickets/:id/review/approve': { body: { fingerprint: string }; response: Review }
  'POST tickets/:id/review/reject': { body: { comment: string }; response: Review }
  'POST tickets/:id/review/discard': { response: Review }
  // VsSaros change (2026-11-06, P1 · one track): the retired team plans, read-only; nothing starts or stops one any more.
  'GET team/plans': { response: { available: boolean; archived: true; plans: PlanView[] } }
  'GET team/bots': { response: { available: boolean; bots: BotCard[] } }
  // VsSaros addition (superagent v2): tickets whose team waits for a person; the person at this machine agrees or refuses here.
  'GET team/proposals': { response: { waiting: { ticket: { id: string; title: string; state: string }; proposal?: StaffingProposal }[] } }
  'POST tickets/:id/team/approve': { body: { version: number }; response: StaffingProposal }
  'POST tickets/:id/team/reject': { body: { reason?: string }; response: { rejected: true } }
  // VsSaros addition (superagent v2, P4): team step evidence the memory system took, and the skill drafts it wrote.
  'GET team/distills': { response: { distills: Distill[] } }
  // VsSaros addition (superagent v2, P3): open team tickets and their steps.
  'GET team/steps': { response: { tickets: StepsView[]; approvals: StepApprovalView[] } }
  // VsSaros addition (plan C): a step's request answered by a person, remembered answers, and one step stopped.
  'POST steps/approvals/:id/answer': { body: { choice: ApprovalChoice }; response: StepApprovalView }
  'GET steps/rules': { response: { rules: ApprovalRule[]; templates: { id: ApprovalTemplateId; risk: string; heads: string[] }[] } }
  /** VsSaros addition (2026-11-06): a person gives a Bot a template's remembered answers. */
  'POST steps/rules/templates/:id/apply': { body: { botId: string; botName: string }; response: { added: number } }
  /** VsSaros addition (2026-11-06): the usage ledger of SuperAgent's Sessions (last day and week) and the steward's work. */
  'GET usage': { response: { day: UsageSummary; week: UsageSummary['total']; steward: StewardView[]; coexist: Coexistence; sideCalls: boolean } }
  'POST steps/rules/:id/delete': { response: { deleted: true } }
  'POST tickets/:id/steps/:key/stop': { response: { step: string; state: string } }
  /** VsSaros addition (2026-11-06): a person raises a team's budget (new caps above what is used). */
  'POST tickets/:id/steps/budget': { body: { tokens?: number; turns?: number }; response: NonNullable<StepsView['budget']> }
  /** VsSaros fix (2026-11-06): a person sends again a reply whose send's result is not known. */
  'POST replies/:id/redeliver': { response: { redelivered: boolean } }
  /** VsSaros fix (2026-11-06): a person lets a step blocked on its sandbox or permission run without a sandbox. */
  'POST tickets/:id/steps/:key/unsandboxed': { response: { step: string; state: string } }
  // VsSaros addition: the supervisor desk conversation, the panel's Chat tab.
  'GET desk/messages': { response: { deskId: string; messages: DeskMessage[] } }
  /** VsSaros addition (plan C): where one desk message stands, for its card in the desk's conversation. */
  'GET desk/flow/:id': { response: DeskFlow }
  'POST desk/messages': { body: { text: string }; response: { id: string; result: ReceiveResult } }
  'POST desk/files': { body: { name: string; data: string }; response: DeskFile }
  'GET desk/schedules': { response: { schedules: DeskSchedule[] } }
  'POST desk/schedules': { body: { text: string; at: string; repeat: DeskSchedule['repeat'] }; response: DeskSchedule }
  'POST desk/schedules/:id/delete': { response: { deleted: true } }
  'POST team/distills/:id/approve': { response: Distill }
  'POST team/distills/:id/reject': { response: Distill }
  // VsSaros addition: high-risk Bot drafts the supervisor cannot create without a person.
  'GET team/approvals': { response: { waiting: BotApproval[]; created: CreatedBot[]; perPlan: number; global: number } }
  'POST team/approvals/:id/approve': { response: CreatedBotView }
  'POST team/approvals/:id/reject': { response: { rejected: true } }
  // VsSaros addition: reusable team workflows; `skills` are the retired template skills, read-only (2026-11-06).
  'GET team/retrospective': { response: { skills: SkillRecord[]; workflows: TeamWorkflow[] } }
  'POST team/workflows/:id/save': { response: TeamWorkflow }
  /** VsSaros change (2026-11-06): runs a saved workflow as v2 — a desk request its team proposal is prefilled from. */
  'POST team/workflows/:id/run': { response: { sent: true; workflow: { id: string; name: string; version: number }; message: { id: string; result: ReceiveResult } } }
  // VsSaros addition (superagent v2, P5): the TeamFlow adapter; `cwd` is the TeamFlow workspace.
  'POST team/workflows/:id/teamflow': { body: { cwd: string }; response: TeamflowExport }
  'POST team/teamflow/import': { body: { cwd: string }; response: { imported: TeamWorkflow[] } }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
