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
import type { BotApproval, BotCard, CreatedBot, CreatedBotView, PlanView, StepInput } from './team.ts'
import type { SkillRecord, TeamWorkflow } from './retrospective.ts'
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
  // VsSaros addition: the main Session's team plans given to VsSaros Bots; a person may inspect and start one.
  'GET team/plans': { response: { available: boolean; plans: PlanView[] } }
  'GET team/bots': { response: { available: boolean; bots: BotCard[] } }
  'POST team/plans': { body: { goal: string; ticketId?: string; steps: StepInput[] }; response: PlanView }
  'POST team/plans/:id/stop': { response: PlanView }
  // VsSaros addition: high-risk Bot drafts the supervisor cannot create without a person.
  'GET team/approvals': { response: { waiting: BotApproval[]; created: CreatedBot[]; perPlan: number; global: number } }
  'POST team/approvals/:id/approve': { response: CreatedBotView }
  'POST team/approvals/:id/reject': { response: { rejected: true } }
  // VsSaros addition: skills and reusable workflows a finished team plan leaves behind.
  'GET team/retrospective': { response: { skills: SkillRecord[]; workflows: TeamWorkflow[] } }
  'POST team/skills/:id/approve': { response: SkillRecord }
  'POST team/skills/:id/reject': { response: SkillRecord }
  'POST team/workflows/:id/save': { response: TeamWorkflow }
  'POST team/workflows/:id/run': { response: PlanView }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
