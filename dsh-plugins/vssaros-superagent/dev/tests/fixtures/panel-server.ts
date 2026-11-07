/**
 * Typed fake management API server for panel tests. Implements every route in `src/app/api.ts` and records any
 * undeclared query parameter or body mismatch in `server.misuse`, which `usePanelServer` asserts is empty after each test.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { z } from 'zod'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Api, ApiResponse, RouteParams } from '../../src/app/api.ts'
import { SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInPart, builtInParts, composePrompt, composeSkill, defaultPrompts,
  environmentSection, policySection, promptParts } from '../../src/app/prompts.ts'
import type { DroppedReply, HistoryView, Problem, PromptsView, SetupView, SourceStatusRow, SourceView, StateView, ThreadPageView,
  ThreadRow, TicketPageView,
  TicketRow, TicketStage,
  TriggerRow } from '../../src/client/api.ts'
import { SETUP_FIELDS } from '../../src/deployment.ts'
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema } from '../../src/policy.ts'
import { SetupError, type SetupCode } from '../../src/setup.ts'
import { feishuChannel } from '../../src/sources/feishu-trigger.ts'
import { githubChannel } from '../../src/sources/github-trigger.ts'
import { feishuKind } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'
import type { Health } from '../../src/sources/host.ts'
import type { BotApproval, BotCard, CreatedBot } from '../../src/app/team.ts'
import type { PlanView, SkillRecord } from '../../src/app/team-archive.ts'
import type { StaffingProposal } from '../../src/app/staffing.ts'
import type { Distill } from '../../src/app/distill.ts'
import type { StepsView } from '../../src/app/steps.ts'
import { APPROVAL_TEMPLATES, type StepApprovalView } from '../../src/app/step-approvals.ts'
import type { DeskFlow } from '../../src/app/desk-flow.ts'

/** VsSaros addition (plan C): tells the open change streams that `topics` changed, as dsh-superagent does. */
export function pushChange(...topics: string[]): void {
  const frame = new TextEncoder().encode(`event: change\ndata: ${JSON.stringify({ topics })}\n\n`)
  for (const controller of server.streams) controller.enqueue(frame)
}
import type { DeskMessage, DeskSchedule } from '../../src/app/desk-chat.ts'
import type { TeamWorkflow } from '../../src/app/retrospective.ts'
import type { SourceKind } from '../../src/sources/kind.ts'
import { testDeployment } from './deployment.ts'

export const MEMBER = 'ou_alice'
const ALLOWED: Record<string, { id: string; name?: string }[]> = { feishu: [{ id: MEMBER, name: 'Alice' }], github: [{ id: 'alice' }] }
type Actor = TriggerRow['actor']
/** Resolve an actor display label using the fixture policy's allowed list or the source kind's unnamed fallback. */
export function actor(source: string, id: string, human = true): Actor {
  if (!id) return { source, id }
  const entry = ALLOWED[source]?.find(item => item.id.toLowerCase() === id.toLowerCase())
  const unnamed = source === 'feishu' ? feishuKind.policy?.unnamed : undefined
  const name = entry ? entry.name || entry.id : unnamed ? undefined : id
  return { source, id, name: name ? { zh: name, en: name } : human ? unnamed!.person : unnamed!.bot }
}
type TicketFields = Omit<TicketRow, 'stage' | 'action'>
const TICKET = {
  id: 't1', title: '修复回归', state: 'open', actions: { retry: false, stop: true }, strength: 'explicit', ended: undefined,
  attention: undefined, assignments: 1, inputs: 2, undelivered: 0, deliveryError: undefined, sessionId: 'worker-t1', directory: '/w/t1',
  summary: 'working on it', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
  threads: [{ key: 'github:42', source: 'github', title: '#42 Fix login', url: 'https://github.com/acme/widgets/pull/42',
    facts: { number: { value: '#42' }, ci: { label: { zh: 'CI 失败', en: 'CI failed' }, value: '1', problem: true } } }],
} satisfies TicketFields
export const ticketSummary = (fields: Partial<TicketFields> = {}, stage: TicketStage = { stage: 'working' }): TicketRow =>
  ({ ...TICKET, ...fields, ...stage })
export const threadSummary = (fields: Partial<ThreadRow> = {}): ThreadRow => ({
  key: 'feishu:oc_1:om_root', source: 'feishu', title: '这个文案好奇怪', stage: 'subscribed', latest: undefined, lastAt: '2026-09-23T00:00:00Z',
  createdAt: '2026-09-22T00:00:00Z', subscriptions: 1, tickets: [{ id: 't1', title: '修复回归', state: 'open' }], evaluating: undefined,
  pending: 0, pollError: undefined, url: undefined, facts: { chat: { value: '团队群' } }, ...fields,
})
type TriggerFields = Partial<Omit<TriggerRow, 'disposition' | 'actions'>> & { disposition?: Partial<TriggerRow['disposition']> }
/** Build a trigger row on the default thread and compute `actions.requeue` using the host's eligibility rules. */
export function trigger(id: string, at: string, { disposition, ...fields }: TriggerFields = {}): TriggerRow {
  const row = { id, source: 'feishu', actor: actor('feishu', MEMBER), human: true, at, text: `message ${id}`, preview: `message ${id}`,
    url: undefined, threads: ['feishu:oc_1:om_root'], ...fields,
    disposition: { queued: false, evaluating: false, delivered: false, filtered: undefined, fanout: [], handbacks: [], decision: undefined,
      ...disposition } }
  return { ...row, actions: { requeue: requeueable(row) } }
}
const requeueable = ({ human, disposition: d }: Pick<TriggerRow, 'human' | 'disposition'>) => human && !d.queued && !d.evaluating
  && (!!d.filtered || d.decision?.outcome === 'unavailable' || d.delivered || (d.fanout.length > 0 && !d.decision))
type SearchItem = ApiResponse<'GET search'>['items'][number]
export function found(id: string, at: string, { threadTitle, filtered,
  ...fields }: TriggerFields & { threadTitle?: string; filtered?: string } = {}): SearchItem {
  const { text: _text, ...result } = trigger(id, at, fields)
  return filtered === undefined ? { ...result, threadTitle } : { ...result, threadTitle: undefined, filtered }
}
export const promptVersion = (revision: number, config: PromptsView['current']['config']): PromptsView['current'] =>
  ({ revision, previousRevision: revision ? revision - 1 : null, savedAt: '', source: 'panel', config })
/** Build a dropped outbound reply fixture (`feishu` replies to `oc_1`/`om_root`; `github` comments on PR #42). */
export const droppedReply = (id: string, hoursAgo: number, source: 'feishu' | 'github', reason: DroppedReply['dropped']['reason'],
  { ticket, thread }: { ticket?: DroppedReply['ticket']; thread?: false } = {}): DroppedReply => ({
  id, preview: `Reply ${id}`, kind: 'reply',
  channel: source === 'feishu' ? feishuChannel('oc_1', 'om_root') : githubChannel(42),
  dropped: { at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), reason }, ...ticket ? { ticket } : {},
  ...thread === false ? {} : { thread: source === 'feishu' ? 'feishu:oc_1:om_root' : 'github:42' },
})
const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString()
export const problemOf = (code: SetupCode, values: Record<string, string> = {}) => new SetupError(code, values).problem
// The kinds' configurations differ, and the fake reads them only as the records the views carry.
const KINDS = [feishuKind, githubKind] as unknown as SourceKind[]
export const MACHINE = { stateDir: '/srv/dsh-superagent', promptMaxChars: 100000, admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000 }

type Settings = ReturnType<typeof SettingsSchema.parse>
export interface PanelServer {
  joined?: Record<string, string>; joining?: Record<string, string>
  joinError?: string
  settings: Settings; revisions: Record<string, number>
  prompts: PromptsView
  tickets: { open: TicketRow[]; ended: TicketRow[] }; ticketDetails: Record<string, TicketPageView>
  threads: ThreadRow[]
  threadPages: (key: string, query: { before?: string; around?: string }) => ThreadPageView | undefined
  person: TicketRow[]; search: Pick<ApiResponse<'GET search'>, 'items' | 'threads'>; history: HistoryView
  requests: { path: string; method: string; body?: unknown }[]
  /** Requests with undeclared query params or invalid body presence; asserted empty after each test. */
  misuse: string[]
  queued: Set<string>
  searching?: (query: string) => Promise<void>
  setup: SetupView
  health: Record<string, Health>
  /** When true, all API requests return an empty 404 to simulate the host plugin being stopped. */
  down: boolean
  /** Count of responses not yet consumed by the client. */
  pending: number
  form?: ConfigForm<Record<string, unknown>> | undefined
  opened: string[]
  dropped: DroppedReply[]
  uncertain: SourceStatusRow['uncertain']
  redelivered: string[]
  failing: Extract<Problem, { kind: 'outgoing' }>['outgoing'][]
  /** VsSaros addition: changelist reviews by ticket, their differences, and the files a refused approval names (when set). */
  reviews: Record<string, ReviewView>
  reviewChanged?: string[]
  /** VsSaros addition: the main Session's team plans. */
  plans: PlanView[]
  teamAvailable: boolean
  teamBots: BotCard[]
  /** VsSaros addition (superagent v2): tickets whose team waits for a person, and the panel's answers. */
  proposals: { ticket: { id: string; title: string; state: string }; proposal?: StaffingProposal }[]
  approvedTeam?: { ticketId: string; version: number }
  rejectedTeam?: string
  /** VsSaros addition (superagent v2, P4): team step evidence and the panel's decisions on its skill drafts. */
  distills: Distill[]
  decidedDistill?: { id: string; decision: 'approve' | 'reject' }
  /** VsSaros addition (superagent v2, P3): open team tickets and their steps. */
  teamSteps: StepsView[]
  /** VsSaros addition (plan C): steps' requests waiting for a person, the answers given, and the steps stopped. */
  stepApprovals: StepApprovalView[]
  stepAnswers: { id: string; choice: string }[]
  stoppedSteps: string[]
  unsandboxedSteps: string[]
  raisedBudget?: { id: string; tokens?: number; turns?: number }
  coexist: ApiResponse<'GET overview'>['coexist']
  approvalRules: ApiResponse<'GET steps/rules'>['rules']
  usage: ApiResponse<'GET usage'>
  /** VsSaros addition (plan C): where desk messages stand, by trigger; and the change stream, which answers 404 unless on. */
  deskFlows: Record<string, DeskFlow>
  streaming: boolean
  streams: ReadableStreamDefaultController<Uint8Array>[]
  /** VsSaros addition: the supervisor desk conversation the Chat tab shows, and what the panel sent to it. */
  deskMessages: DeskMessage[]
  deskSent: string[]
  /** Holds the next POST desk/messages, so a test can inspect the optimistic/queued composer UI. */
  deskSendHold?: Promise<void>
  /** The composer's attachments and scheduled messages. */
  deskFiles: { name: string; data: string }[]
  deskSchedules: DeskSchedule[]
  /** VsSaros addition: Bot drafts waiting for a person, and those already created. */
  approvals: BotApproval[]
  createdBots: CreatedBot[]
  approvedBot?: string
  rejectedBot?: string
  /** VsSaros addition: skills and workflows a finished plan leaves behind. */
  retroSkills: SkillRecord[]
  retroWorkflows: TeamWorkflow[]
  savedWorkflow?: string
  /** VsSaros addition (superagent v2, P5): the panel's TeamFlow export and import. */
  teamflowExport?: { id: string; cwd: string }
  teamflowImport?: string
  ranWorkflow?: string
}
type ReviewView = Extract<ApiResponse<'GET tickets/:id/review'>, { review: object }>
export let server: PanelServer

function resolved() {
  const accounts = server.setup.accounts
  return accounts ? testDeployment({ repository: accounts.repository, github: { cli: '/bin/false', login: accounts.agent, noreply: '' },
    ...accounts.feishu ? { feishu: { cli: '/bin/false', ...accounts.feishu } } : { feishu: undefined } }) : undefined
}
/** Default source health: paused during setup; Feishu defaults to `socket closed` unless overridden or paused by setup. */
function healthOf(name: string): Health {
  if (server.setup.problem) return { state: 'paused', detail: 'Waiting for setup', code: 'setupPending' }
  if (server.health[name]) return server.health[name]
  if (name !== 'feishu') return { state: 'ready', detail: '' }
  return server.setup.feishuProblem ? { state: 'paused', detail: server.setup.feishuProblem.detail } : { state: 'error',
    detail: 'socket closed' }
}
const problemOf_ = (id: string) => [server.setup.problem, server.setup.feishuProblem].find(item => item?.place === id) ?? undefined
function sourceSettings(): SourceView[] {
  return KINDS.map(kind => {
    const config = kind.schema.parse(server.settings.sources[kind.kind]?.config ?? {})
    const problem = problemOf_(kind.kind)
    const { admission: _admission, ...part } = server.settings.policy.sources[kind.kind] ?? { allowed: [], admission: {} }
    const sync = kind.policy?.sync && { label: kind.policy.sync.label, ready: kind.policy.sync.ready(kind.policy.schema.parse(part)),
      health: server.health[`sync:${kind.kind}`] }
    const policy = kind.policy && { fields: kind.policy.fields, explicit: kind.policy.explicit, ...kind.policy.rows
      ? { rows: kind.policy.rows(config) } : {}, ...sync ? { sync } : {} }
    return { id: kind.kind, kind: kind.kind, title: kind.title, description: kind.description, installed: true,
      value: { enabled: server.settings.sources[kind.kind]?.enabled ?? true, config },
        revision: server.revisions[`source:${kind.kind}`] ?? 0,
      restarts: SETUP_FIELDS[kind.kind] ?? [], fields: kind.fields, facts: kind.facts?.(resolved()) ?? {},
      labels: kind.kind === 'feishu' ? { oc_team: '团队群', oc_other: '另一个群', ...server.joined } : {}, ...problem ? { problem } : {},
      ...policy ? { policy } : {} }
  })
}
function sourceStatuses(): SourceStatusRow[] {
  return KINDS.map(kind => {
    const enabled = server.settings.sources[kind.kind]?.enabled ?? true
    const health = kind.health.map(name => ({ name, ...healthOf(name) }))
    const problem = problemOf_(kind.kind)
    const state = !enabled ? 'off' : problem || health.some(item => item.state === 'error') ? 'error' : server.setup.problem ? 'setup'
      : health.some(item => item.state === 'starting') ? 'starting' : health.some(item => item.state === 'paused') ? 'paused' : 'ready'
    const feishu = kind.kind === 'feishu'
    return { id: kind.kind, title: kind.title, installed: true, enabled, state, health, ...problem ? { problem } : {},
      stats: { received: feishu ? 12 : 0, filtered: feishu ? 2 : 0, lastAt: '2026-09-23T00:00:00Z' },
      filtered: feishu ? [] : [{ id: 'e9', at: '2026-09-23T00:02:00Z', actor: actor('github', 'someone'), preview: 'looks wrong',
        reason: { code: 'source_disabled' } }],
      dropped: server.dropped.filter(item => item.channel.source === kind.kind && item.dropped.at >= dayAgo()),
      uncertain: server.uncertain.filter(item => item.channel.source === kind.kind) }
  })
}
const stateView = (): StateView => ({
  setup: server.setup, load: { running: server.setup.problem ? 0 : 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers },
  masterId: 'master', deskId: 'desk-test', paused: server.settings.paused,
  // The panel does not read health; the service script does.
  health: {},
})
const settingsView = (): ApiResponse<'GET settings'> => ({
  policyVersion: 'abcdef1234567890',
  blocks: { policy: { value: server.settings.policy, revision: server.revisions.policy ?? 0 },
    eval: { value: server.settings.eval, revision: server.revisions.eval ?? 0 },
    executor: { value: server.settings.executor, revision: server.revisions.executor ?? 0 } },
  sources: sourceSettings(),
  environment: { root: '/srv/dsh-superagent/work', variables: [
    { owner: 'executor', enabled: true, variables: [{ key: 'DSH_SUPERAGENT_DIR', description: { zh: '工单的执行目录',
      en: 'The ticket directory' } },
      { key: 'DSH_SUPERAGENT_NAME', description: { zh: '工单短名', en: 'Short name' } }] },
    { owner: 'github', enabled: false, variables: [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '仓库',
      en: 'Repository' } }] }] },
})
const totals = (total = 0) => ({ calls: total ? 1 : 0, input: total, cacheRead: 0, cacheWrite: 0, output: 0, total })
/** No usage yet. */
export const emptyUsage = (): ApiResponse<'GET usage'> => ({ day: { since: '', total: totals(), byRole: { master: totals(), desk: totals(), worker: totals(),
  step: totals() }, byModel: [], byBot: [], byTicket: [], relays: { resent: 0, side: 0, sessions: [] } }, week: totals(), steward: [], coexist: {}, sideCalls: true })
const overviewView = (): ApiResponse<'GET overview'> => {
  const { problem, feishuProblem } = server.setup
  const setup = problem ?? feishuProblem
  return {
    problems: [...setup ? [{ kind: 'setup' as const, ...setup }] : [],
      ...KINDS.some(kind => server.settings.sources[kind.kind]?.enabled !== false) ? [] : [{ kind: 'no-source' as const }],
      ...feishuProblem || server.settings.sources.feishu?.enabled === false ? [] : [{ kind: 'source-error' as const, source: { id: 'feishu',
        title: { zh: '飞书', en: 'Feishu' },
        health: { name: 'feishu', state: 'error' as const, detail: 'socket closed' } } }],
      ...server.threads.filter(thread => thread.evaluating && thread.evaluating.deadline < new Date().toISOString())
        .map(thread => ({ kind: 'eval-overdue' as const, thread })),
      { kind: 'eval-unavailable' as const, decisionId: 'u1', thread: threadSummary(), reason: [{ code: 'timeout' }], triggerId: 'e3' },
      ...server.settings.paused ? [{ kind: 'executor-paused' as const }] : [],
      // As on the host, every entry in error that is not a Source's own, a Policy sync, or the individually listed unavailable Evals is a runtime-error.
      ...Object.entries(server.health).filter(([name, item]) => item.state === 'error' && !KINDS.some(kind => kind.health.includes(name))
        && !name.startsWith('sync:') && name !== 'evals')
        .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail })),
      ...Object.values(server.settings.policy.sources).some(part => part.allowed.length) ? [] : [{ kind: 'no-allowed' as const }],
      ...server.failing.map(outgoing => ({ kind: 'outgoing' as const, outgoing }))],
    person: server.person, executor: { running: 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers, idle: 1 },
    flow: { received: 12, filtered: 2, triggers: 10, judged: 5, accepted: 1, evaluating: 0,
      dropped: server.dropped.filter(item => item.dropped.at >= dayAgo()).length },
    policyVersion: 'abcdef1234567890',
    coexist: server.coexist,
  }
}
export const acceptDecision = (): NonNullable<TicketPageView['decision']> => ({ id: 'd1', kind: 'accept', outcome: 'accept',
  reason: [{ code: 'explicitRouted' }], at: '2026-09-22T00:00:00Z', strength: 'explicit', ticketId: undefined,
  triggerIds: ['e1'], thread: 'feishu:oc_1:om_root', rules: [], preview: '@bot 修一下', ticketTitle: undefined })
const ticketDetail = (): TicketPageView => ({
  ...ticketSummary(), paused: false, decision: acceptDecision(), threads: [threadSummary()], relays: { resent: 0, side: 0, sessions: [] }, coexist: {},
  mandate: { strength: 'explicit', policyVersion: 'abcdef1234567890', basis: { via: 'addressed', sender: 'Alice', addressed: 'mention' },
    actor: actor('feishu', MEMBER), scope: '修复登录页回归' },
  basis: { facts: [{ name: 'sender', value: 'Alice' }, { name: 'addressed', value: 'mention' }], legacy: false },
  environment: [{ key: 'DSH_SUPERAGENT_DIR', value: '/w/t1', description: { zh: '执行目录', en: 'Directory' }, owner: 'executor' },
    { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', value: '', description: { zh: '编号', en: 'Number' }, owner: 'github' }],
  channels: [{ source: 'feishu', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', label: { zh: '飞书消息',
    en: 'Feishu message' } },
    { source: 'github', url: 'https://github.com/acme/widgets/issues/42', label: { zh: 'GitHub #42', en: 'GitHub #42' } }],
  assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-22T00:00:00Z',
    startedAt: '2026-09-22T00:01:00Z',
    report: { state: 'progress', summary: 'working', at: '2026-09-22T00:02:00Z' } }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: false,
    trigger: { id: 'e2', actor: actor('feishu', MEMBER), human: true, preview: '顺便改标题', thread: 'feishu:oc_1:om_root' } },
  { id: 'i2', kind: 'policy-changed', at: '2026-09-22T00:04:00Z', delivered: true, from: 'aaaaaaaaaaaaaaaa', to: 'bbbbbbbbbbbbbbbb' }],
})
function threadPage(key: string, { before, around }: { before?: string; around?: string }): ThreadPageView | undefined {
  if (key !== threadSummary().key) return undefined
  const base = { ...threadSummary(), tickets: [ticketSummary()], correlated: [{ key: 'github:42', title: 'PR 42' }], decisions: [],
    url: 'https://example.test/thread', context: [] }
  const decision = { id: 'd1', outcome: 'accept' as const, reason: [{ code: 'said', values: { text: 'x' } }], ticketId: 't1' }
  if (before === 'cursor-1' || around === 'e1') return { ...base, timeline: [trigger('e1', '2026-09-20T00:00:00Z',
    { disposition: { decision } })], earlier: null }
  return { ...base, earlier: 'cursor-1', timeline: [trigger('e3', '2026-09-23T00:00:00Z', { disposition: { fanout: ['t1'] } }),
    trigger('e4', '2026-09-23T00:01:00Z', { disposition: { filtered: { code: 'not_a_member' } } })] }
}
function initial(): PanelServer {
  const settings = SettingsSchema.parse({
    policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' },
      github: { allowed: [{ id: 'alice' }] } },
      rules: [{ id: 'copy', name: '文案修改', enabled: true, instruction: '修正明确的文案错误' }] },
    sources: { feishu: { enabled: true, config: { cli: 'lark-bot', chats: [{ chatId: 'oc_team', listen: 'mentions' }],
      directMessages: true } },
      github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent' } } },
    executor: { blockedCommands: ['gh-personal'] },
  })
  const ended = ticketSummary({ id: 't0', title: '旧工单', state: 'ended', actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'human', reason: 'Human asked to stop', outcome: 'stopped' } }, { stage: 'ended' })
  const reply = { source: 'feishu', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', label: { zh: '飞书消息',
    en: 'Feishu message' } }
  const defaults = { revision: 0, previousRevision: null, savedAt: '', source: 'defaults' }
  return {
    health: {}, down: false, pending: 0, opened: [], requests: [], misuse: [], queued: new Set(), dropped: [], uncertain: [], redelivered: [], failing: [], reviews: {},
    plans: [], teamAvailable: true, teamBots: [], proposals: [], distills: [], teamSteps: [], stepApprovals: [], stepAnswers: [], stoppedSteps: [], unsandboxedSteps: [], coexist: {}, approvalRules: [], usage: emptyUsage(), deskFlows: {}, streaming: false, streams: [], deskMessages: [], deskSent: [], deskSendHold: undefined, deskFiles: [], deskSchedules: [], approvals: [], createdBots: [], retroSkills: [], retroWorkflows: [],
    setup: { machine: MACHINE, problem: null, feishuProblem: null,
      accounts: { repository: 'acme/widgets', agent: 'agent-bot', feishu: { appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot',
        name: 'Widgets Bot' } } },
    settings, revisions: { policy: 3, eval: 1, executor: 0 },
    prompts: { masterId: 'master', sections: TEAM_SECTIONS, skillName: SKILL_NAME.source, builtin: ['feishu', 'github'],
      skillPrefix: SKILL_PREFIX, revision: 0, current: { ...defaults, config: defaultPrompts() },
      defaults: defaultPrompts(), parts: Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) })),
      defaultChanged: [], revisions: [{ ...defaults, changed: [] }], sessions: [], notificationPending: false, next_offset: null },
    tickets: { open: [ticketSummary()], ended: [ended] }, ticketDetails: { t1: ticketDetail() },
    threads: [threadSummary()], threadPages: threadPage,
    person: [ticketSummary({ attention: { id: 'q1', question: '需要确认按钮颜色' }, note: { text: '需要确认按钮颜色', error: false }, reply },
      { stage: 'person', action: 'answer' }),
      ticketSummary({ id: 't4', title: '截图工具', actions: { retry: true, stop: true }, sessionId: 'worker-t4',
        summary: 'LlmError: no adapter registered for provider "provider-a"',
        note: { text: 'LlmError: no adapter registered for provider "provider-a"', error: true } }, { stage: 'person', action: 'failed' })],
    search: { items: [], threads: [] },
    history: { current: 3, policyVersion: 'abcdef1234567890', items: [
      { revision: 4, savedAt: '2026-09-23T00:00:00Z', source: 'panel', policyVersion: '9876543210fedcba', policyChanged: true, notified: [],
        block: 'source:feishu',
        changes: [{ code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_team'] }] },
      { revision: 3, savedAt: '2026-09-22T00:00:00Z', source: 'panel', policyVersion: 'abcdef1234567890', policyChanged: true,
        notified: [{ id: 't1', title: '修复回归' }], block: 'policy',
        changes: [{ code: 'mode', from: 'off', to: 'observe' }, { code: 'sourceField', source: 'feishu', field: 'directMessages',
          from: true, to: false },
          { code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_other', 'oc_new'] }] }] },
  }
}

/** A refusal response carrying the host's HTTP status code and JSON error body. Returned by route handlers when a request is rejected. */
class Refusal { constructor(readonly status: 400 | 404 | 409 | 500, readonly body: Record<string, unknown>) {} }
const refuse = (status: Refusal['status'], error: string, more: Record<string, unknown> = {}) => new Refusal(status, { error, ...more })
function decideDistill(id: string, decision: 'approve' | 'reject'): Distill | Refusal {
  const item = server.distills.find(entry => entry.id === id)
  if (!item?.result?.skill) return refuse(404, `No skill draft waits on ${id}`)
  server.decidedDistill = { id, decision }
  return { ...item, result: { ...item.result, skill: { ...item.result.skill, state: decision === 'approve' ? 'active' : 'rejected' } } }
}
type Query<K extends keyof Api> = Api[K] extends { query?: infer Q } ? keyof NonNullable<Q> & string : never
type Body<K extends keyof Api> = Api[K] extends { body: infer B } ? B : undefined
interface Request<K extends keyof Api> { params: RouteParams<K>; query: Partial<Record<Query<K>, string>>; body: Body<K> }
type Answer<K extends keyof Api> = ApiResponse<K> | Refusal
type Route<K extends keyof Api> = { query?: readonly Query<K>[]; answer: (request: Request<K>) => Answer<K> | Promise<Answer<K>> }
  & (Api[K] extends { body: unknown } ? { body: true } : { body?: never })
const page = <T>(items: T[]) => ({ items, total: items.length, next_offset: null })
const ticketOf = (id: string) =>
  [...server.tickets.open, ...server.person, ...server.tickets.ended].find(ticket => ticket.id === id) ?? server.ticketDetails[id]
const SourceSave = z.object({ enabled: z.boolean(), config: z.unknown() })

/** VsSaros addition: a team plan of two Bots, one reporting and one still working. */
export function teamPlan(): PlanView {
  const at = '2026-11-04T10:02:00.000Z'
  return { id: 'plan-1', goal: '首页新手引导上线', status: 'running', createdAt: at, running: 1, bots: ['设计 bot', '数据 bot'],
    steps: [
      { id: 'T1', planId: 'plan-1', title: '交互方案', spec: '出 5 步交互稿', bot: '设计 bot', after: [], state: 'done', hop: 2,
        botName: '设计 bot', report: '交互稿 5 屏。', startedAt: at, endedAt: at },
      { id: 'T2', planId: 'plan-1', title: '埋点方案', spec: '每步曝光/点击/跳过', bot: '数据 bot', after: ['T1'], state: 'running', hop: 1,
        botName: '数据 bot', sessionId: 's2', assignmentId: 'a2', startedAt: at },
    ],
    exchanges: [
      { seq: 1, planId: 'plan-1', hop: 0, from: 'SuperAgent', to: 'SuperAgent', kind: 'system', text: 'Plan: 首页新手引导上线', at },
      { seq: 2, planId: 'plan-1', stepId: 'T1', hop: 1, from: 'SuperAgent', to: '设计 bot', kind: 'give', text: '交互方案', at },
      { seq: 3, planId: 'plan-1', stepId: 'T1', hop: 2, from: '设计 bot', to: 'SuperAgent', kind: 'report', text: '交互稿 5 屏。', at },
    ] }
}

const ROUTES: { [K in keyof Api]: Route<K> } = {
  'GET state': { answer: stateView },
  'GET overview': { answer: overviewView },
  'GET search': { query: ['q'], answer: async ({ query }) => {
    const q = query.q ?? ''
    await server.searching?.(q)
    return { tickets: [], threads: server.search.threads, items: server.search.items.filter(item => item.preview.includes(q)) }
  } },
  'GET sources': { answer: sourceStatuses },
  'GET settings': { answer: settingsView },
  'POST sources/:id/labels': { answer: () => {
    // Label refresh failures come from the bot CLI and are returned verbatim.
    if (server.joinError) return refuse(500, server.joinError)
    const added = Object.values(server.joining ?? {}); server.joined = { ...server.joined, ...server.joining }; server.joining = undefined
    return { added }
  } },
  // VsSaros addition: the Feishu card's local CLI checks and confirmed maintenance.
  'POST sources/feishu/cli-check': { body: true, answer: ({ body }) => ({ found: true, command: 'lark-cli',
    resolved: 'C:\\fake\\lark-cli.cmd', version: '1.0.98', appId: 'cli_fake', botReady: true, botName: 'Test Bot', strictMode: 'bot',
    ...body.update ? { update: { currentVersion: '1.0.98', latestVersion: '1.0.98', action: 'already_up_to_date', ok: true,
      message: 'lark-cli 1.0.98 is already up to date' } } : {} }) },
  'POST sources/feishu/cli-apply': { body: true, answer: () => ({ ok: true, output: 'done' }) },
  // VsSaros addition: TAPD Open API credentials in the Host's credentials file; the stand-in never stores a secret.
  'GET sources/tapd/credentials': { answer: () => ({ configured: false, source: 'none' as const, file: 'C:\\fake\\dsh-home\\tapd.env', overridden: false }) },
  'POST sources/tapd/credentials': { body: true, answer: ({ body }) => body.clear
    ? { configured: false, source: 'none' as const, file: 'C:\\fake\\dsh-home\\tapd.env', overridden: false }
    : { configured: true, source: 'file' as const, file: 'C:\\fake\\dsh-home\\tapd.env', overridden: false,
      kind: body.kind ?? 'client', method: 'Basic TAPD_CLIENT_ID/SECRET (API account)', ...body.id ? { account: 'abc…yz' } : {} } },
  'GET threads': { query: ['filter', 'offset', 'limit'], answer: () => page(server.threads) },
  'GET threads/:key': { query: ['limit', 'before', 'around'], answer: ({ params, query }) => {
    const found = server.threadPages(params.key, query)
    if (!found) return refuse(404, 'Thread not found')
    // A Trigger sent to Eval again is queued and cannot be requeued.
    const queued = (item: TriggerRow) => ({ ...item, disposition: { ...item.disposition, queued: true }, actions: { requeue: false } })
    return { ...found, timeline: found.timeline.map(item => server.queued.has(item.id) ? queued(item) : item) }
  } },
  'POST threads/:key/unsubscribe': { answer: ({ params }) => {
    const removed = server.threads.length > 0
    server.threads = []
    return { removed, thread: params.key, context_delivery: 'injected' }
  } },
  'POST triggers/:id/requeue': { answer: ({ params }) => { server.queued.add(params.id); return { queued: true } } },
  'GET decisions': { query: ['kind', 'window', 'offset', 'limit'], answer: ({ query }) =>
    ({ items: query.kind === 'ignore' ? [] : [acceptDecision()], next_offset: null }) },
  'POST decisions/:id/dismiss': { answer: ({ params }) => params.id === 'u1' ? { dismissed: true } : refuse(404,
    'Unavailable Eval not found') },
  'GET tickets': { query: ['state', 'offset', 'limit'], answer: ({ query }) => page(server.tickets[query.state === 'ended' ? 'ended'
    : 'open']) },
  'GET tickets/:id': { answer: ({ params }) => server.ticketDetails[params.id] ?? refuse(404, 'Ticket not found') },
  'POST tickets/:id/retry': { answer: ({ params }) => {
    const ticket = ticketOf(params.id)
    if (!ticket) return refuse(404, 'Ticket not found')
    return ticket.actions.retry ? { retried: true } : refuse(400, 'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed',
      { code: 'notRetryable', values: {} })
  } },
  'POST tickets/:id/stop': { answer: ({ params }) => {
    if (!ticketOf(params.id)) return refuse(404, 'Ticket not found')
    server.tickets.open = []; server.person = server.person.filter(ticket => ticket.id !== params.id)
    return { stopped: true }
  } },
  'POST executor/pause': { body: true, answer: ({ body }) => {
    server.settings = { ...server.settings, paused: body.paused }
    server.revisions.pause = (server.revisions.pause ?? 0) + 1
    return { paused: body.paused }
  } },
  'PUT settings/:block': { body: true, answer: ({ params: { block }, body }) => {
    const source = block.startsWith('source:') ? KINDS.find(kind => `source:${kind.kind}` === block) : undefined
    if (!['policy', 'eval', 'executor'].includes(block) && !source) return block.startsWith('source:') ? refuse(404, 'Source not found')
      : refuse(400, 'Invalid settings: block')
    if (body.revision !== (server.revisions[block] ?? 0)) return refuse(409, 'Settings changed. Reload before saving.')
    let restarting = false
    if (block === 'policy') server.settings = { ...server.settings, policy: PolicyConfigSchema.parse(body.value) }
    else if (block === 'executor') server.settings = { ...server.settings, executor: ExecutorConfigSchema.parse(body.value) }
    else if (block === 'eval') server.settings = { ...server.settings, eval: EvalConfigSchema.parse(body.value) }
    else if (source) {
      const { enabled, config: value } = SourceSave.parse(body.value)
      const config = source.schema.parse(value)
      // As on the server, a changed CLI that fails its check refuses the save with the setup problem.
      if (config.cli === 'lark-broken') {
        const refused = new SetupError('feishuCliFailed', { output: 'lark-cli: app secret missing' })
        return refuse(400, refused.message, { setup: refused.problem })
      }
      restarting = (config.cli ?? '') !== (server.settings.sources[source.kind]?.config.cli ?? '')
      server.settings = { ...server.settings, sources: { ...server.settings.sources, [source.kind]: { enabled, config } } }
    }
    server.revisions[block] = (server.revisions[block] ?? 0) + 1
    return { restarting, revision: server.revisions[block] }
  } },
  'GET policy/history': { answer: () => server.history },
  'POST policy-sync/:id': { answer: ({ params }) => ({ policy: server.settings.policy.sources[params.id] }) },
  'POST setup/check': { answer: () => ({ restarting: true }) },
  'GET models': { answer: () => ({ default: { provider: 'host', model: 'default' }, routableProviders: [], failures: [],
    groups: [{ id: 'worker-provider', name: 'Worker provider', models: [{ id: 'worker-model', name: 'Worker model',
      reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] }) },
  'GET prompts': { query: ['revision', 'offset'], answer: () => server.prompts },
  'PUT prompts': { body: true, answer: ({ body }) => {
    const { revision } = server.prompts
    if (body.baseRevision !== revision) return refuse(409,
      `Prompt version changed to ${revision}; compare the latest version before saving`)
    // As the host does: a template keeps its placeholders, and no overrides are stored as none.
    const { overrides = {}, ...config } = body.config as PromptsView['current']['config']
    for (const [part, override] of Object.entries(overrides)) {
      if (!builtInPart(part)) return refuse(400, 'refused', { code: 'unknownPromptPart', values: { part } })
      const missing = (builtInPart(part)?.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      if (missing.length) return refuse(400, 'refused', { code: 'promptPlaceholders', values: { part, placeholders: missing.join(', ') } })
    }
    server.prompts.revision++
    server.prompts.current = promptVersion(server.prompts.revision, Object.keys(overrides).length ? { ...config, overrides } : config)
    return { revision: server.prompts.revision, context_delivery: 'injected' }
  } },
  'POST prompts/preview': { body: true, answer: ({ body }) => {
    const skills = [...server.setup.accounts?.feishu ? ['feishu'] : [], 'github', ...Object.keys(body.skills)].map(name => [name,
      composeSkill(body, name)])
    // The generated parts from their templates, without variables or rules.
    const environment = environmentSection(body, []), policy = policySection(SettingsSchema.parse({ policy: { rules: [] } }), body)
    return { parts: { orchestrator: promptParts(body, 'orchestrator', environment, policy), worker: promptParts(body, 'worker', environment) },
      skills: Object.fromEntries(skills),
      orchestrator: composePrompt(body, 'orchestrator'), worker: composePrompt(body, 'worker'), scope: '' }
  } },
  // VsSaros addition: the review routes, over `server.reviews`, as the host's Reviews decides them.
  'GET reviews': { answer: () => ({ waiting: Object.values(server.reviews).map(view => view.review).filter(review => review.state === 'waiting'), audit: [] }) },
  'GET tickets/:id/review': { answer: ({ params }) => server.reviews[params.id] ?? { review: null } },
  'POST tickets/:id/review/approve': { body: true, answer: ({ params, body }) => {
    const view = server.reviews[params.id]
    if (view?.review.state !== 'waiting') return refuse(409, 'This ticket has no changelist to review')
    if (server.reviewChanged) return refuse(409, 'The shelf changed after it was reviewed', { changed: server.reviewChanged })
    if (body.fingerprint !== view.review.fingerprint) return refuse(409, 'The review changed after you opened it; open it again')
    view.review = { ...view.review, state: view.submit.mode === 'pipeline' ? 'handed' : 'submitted', by: 'qiuzijian', ...view.submit.mode === 'host' ? { submittedAs: 507 } : {} }
    return view.review
  } },
  'POST tickets/:id/review/reject': { body: true, answer: ({ params, body }) => {
    const view = server.reviews[params.id]
    if (view?.review.state !== 'waiting') return refuse(409, 'This ticket has no changelist to review')
    view.review = { ...view.review, state: 'rejected', by: 'qiuzijian', comment: body.comment }
    return view.review
  } },
  'POST tickets/:id/review/discard': { answer: ({ params }) => {
    const view = server.reviews[params.id]
    if (view?.review.state !== 'waiting') return refuse(409, 'This ticket has no changelist to review')
    view.review = { ...view.review, state: 'discarded', by: 'qiuzijian' }
    return view.review
  } },
  'GET team/plans': { answer: () => ({ available: server.teamAvailable, archived: true as const, plans: server.plans }) },
  'GET team/bots': { answer: () => ({ available: server.teamAvailable, bots: server.teamBots }) },
  'GET team/approvals': { answer: () => ({ waiting: server.approvals, created: server.createdBots, perPlan: 3, global: 20 }) },
  'POST team/approvals/:id/approve': { answer: ({ params }) => {
    const draft = server.approvals.find(item => item.id === params.id)
    if (!draft) return refuse(404, `No Bot draft ${params.id}`)
    server.approvedBot = params.id
    return { id: draft.draft.id, name: draft.draft.name, preset: `vssaros-${draft.draft.id}`, file: `C:/fake/agents/${draft.draft.id}/.agent.md` }
  } },
  'POST team/approvals/:id/reject': { answer: ({ params }) => {
    if (!server.approvals.some(item => item.id === params.id)) return refuse(404, `No Bot draft ${params.id}`)
    server.rejectedBot = params.id
    return { rejected: true }
  } },
  'GET team/retrospective': { answer: () => ({ skills: server.retroSkills, workflows: server.retroWorkflows }) },
  'POST team/workflows/:id/teamflow': { body: true, answer: ({ params, body }) => {
    if (!server.retroWorkflows.some(item => item.id === params.id)) return refuse(404, `No workflow ${params.id}`)
    server.teamflowExport = { id: params.id, cwd: body.cwd }
    return { adapter: 'teamflow' as const, projectKey: 'ws-demo-12345678', teamId: `sa-${params.id}`, file: '/x/teams.json',
      runnable: false, lossy: ['T4 发版说明：TeamFlow 没有对应阶段'], at: '2026-11-05T10:00:00.000Z' }
  } },
  'POST team/teamflow/import': { body: true, answer: ({ body }) => {
    server.teamflowImport = body.cwd
    return { imported: [] }
  } },
  'POST team/workflows/:id/save': { answer: ({ params }) => {
    const workflow = server.retroWorkflows.find(item => item.id === params.id)
    if (!workflow) return refuse(404, `No workflow ${params.id}`)
    server.savedWorkflow = params.id
    return { ...workflow, state: 'saved' }
  } },
  'POST team/workflows/:id/run': { answer: ({ params }) => {
    const workflow = server.retroWorkflows.find(item => item.id === params.id)
    if (!workflow) return refuse(404, `No workflow ${params.id}`)
    server.ranWorkflow = params.id
    return { sent: true as const, workflow: { id: workflow.id, name: workflow.name, version: workflow.version },
      message: { id: 'desk-m-run', result: { kind: 'stored' } as never } }
  } },
  'GET team/proposals': { answer: () => ({ waiting: server.proposals }) },
  'GET team/distills': { answer: () => ({ distills: server.distills }) },
  'GET team/steps': { answer: () => ({ tickets: server.teamSteps, approvals: server.stepApprovals }) },
  'POST steps/approvals/:id/answer': { body: true, answer: ({ params, body }) => {
    const found = server.stepApprovals.find(item => item.id === params.id)
    if (!found) return refuse(400, 'This approval no longer waits')
    server.stepAnswers.push({ id: params.id, choice: body.choice })
    server.stepApprovals = server.stepApprovals.filter(item => item.id !== params.id)
    return found
  } },
  'GET steps/rules': { answer: () => ({ rules: server.approvalRules, templates: APPROVAL_TEMPLATES.map(item => ({ id: item.id, risk: item.risk, heads: [...item.heads] })) }) },
  'POST steps/rules/:id/delete': { answer: ({ params }) => {
    server.approvalRules = server.approvalRules.filter(rule => rule.id !== params.id)
    return { deleted: true as const }
  } },
  'POST steps/rules/templates/:id/apply': { body: true, answer: ({ params, body }) => {
    const template = APPROVAL_TEMPLATES.find(item => item.id === params.id)
    if (!template) return refuse(404, 'No such approval template')
    const rules = template.heads.map((head, i) => ({ id: `${params.id}-${i}`, bot: { id: body.botId, name: body.botName }, tool: 'pwsh', head,
      at: new Date().toISOString(), by: 'panel', template: template.id }))
    server.approvalRules = [...rules, ...server.approvalRules]
    return { added: rules.length }
  } },
  'GET usage': { answer: () => server.usage },
  'POST tickets/:id/steps/:key/stop': { answer: ({ params }) => {
    server.stoppedSteps.push(`${params.id}/${params.key}`)
    server.teamSteps = server.teamSteps.map(team => team.ticket.id !== params.id ? team
      : { ...team, steps: team.steps.map(step => step.key === params.key ? { ...step, state: 'stopped' as const } : step) })
    return { step: params.key, state: 'stopped' }
  } },
  'POST tickets/:id/steps/budget': { body: true, answer: ({ params, body }) => {
    server.raisedBudget = { id: params.id, ...body }
    return { tokens: 0, tokensCap: body.tokens ?? 0, turns: 0, turnsCap: body.turns ?? 0, stopped: false }
  } },
  'POST replies/:id/redeliver': { answer: ({ params }) => {
    const found = server.uncertain.some(item => item.id === params.id)
    if (!found) return refuse(404, 'No reply with that id waits to be redelivered')
    server.redelivered.push(params.id)
    server.uncertain = server.uncertain.filter(item => item.id !== params.id)
    return { redelivered: true }
  } },
  'POST tickets/:id/steps/:key/unsandboxed': { answer: ({ params }) => {
    server.unsandboxedSteps.push(`${params.id}/${params.key}`)
    server.teamSteps = server.teamSteps.map(team => team.ticket.id !== params.id ? team
      : { ...team, steps: team.steps.map(step => step.key === params.key ? { ...step, state: 'pending' as const, needs: undefined } : step) })
    return { step: params.key, state: 'pending' }
  } },
  'GET desk/flow/:id': { answer: ({ params }) => server.deskFlows[params.id] ?? { trigger: undefined, state: 'unknown', approvals: [] } },
  'GET desk/messages': { answer: () => ({ deskId: 'desk-test', messages: server.deskMessages }) },
  'POST desk/messages': { body: true, answer: async ({ body }) => {
    if (server.deskSendHold) await server.deskSendHold
    server.deskSent.push(body.text)
    const id = `superagent:desk:panel-${server.deskSent.length}`
    server.deskMessages = [...server.deskMessages, { id, role: 'person' as const, text: body.text, at: '2026-11-05T10:00:00.000Z' }]
    return { id, result: 'stored' as const }
  } },
  'POST desk/files': { body: true, answer: ({ body }) => {
    server.deskFiles.push(body)
    return { name: body.name, path: `/state/desk-files/${body.name}`, size: Buffer.from(body.data, 'base64').length }
  } },
  'GET desk/schedules': { answer: () => ({ schedules: server.deskSchedules }) },
  'POST desk/schedules': { body: true, answer: ({ body }) => {
    const entry = { id: `sched-${server.deskSchedules.length + 1}`, ...body, createdAt: '2026-11-05T10:00:00.000Z' }
    server.deskSchedules = [...server.deskSchedules, entry]
    return entry
  } },
  'POST desk/schedules/:id/delete': { answer: ({ params }) => {
    server.deskSchedules = server.deskSchedules.filter(entry => entry.id !== params.id)
    return { deleted: true as const }
  } },
  'POST team/distills/:id/approve': { answer: ({ params }) => decideDistill(params.id, 'approve') },
  'POST team/distills/:id/reject': { answer: ({ params }) => decideDistill(params.id, 'reject') },
  'POST tickets/:id/team/approve': { body: true, answer: ({ params, body }) => {
    const item = server.proposals.find(entry => entry.ticket.id === params.id)
    if (!item?.proposal) return refuse(409, `No team proposal for ${params.id}`)
    server.approvedTeam = { ticketId: params.id, version: body.version }
    return { ...item.proposal, state: 'approved' as const, decidedBy: 'panel' }
  } },
  'POST tickets/:id/team/reject': { body: true, answer: ({ params }) => {
    server.rejectedTeam = params.id
    return { rejected: true as const }
  } },
}

function match(method: string, segments: string[]) {
  for (const key of Object.keys(ROUTES) as (keyof Api)[]) {
    const [verb, path] = key.split(' ') as [string, string]
    const pattern = path.split('/')
    if (verb !== method || pattern.length !== segments.length || !pattern.every((part, index) => part.startsWith(':')
      || part === segments[index])) continue
    return { key, params: Object.fromEntries(pattern.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1),
      decodeURIComponent(segments[index]!)]] : [])) }
  }
  return undefined
}
async function run<K extends keyof Api>(key: K, params: Record<string, string>, query: URLSearchParams, body: unknown): Promise<Answer<K>> {
  const route: Route<K> = ROUTES[key]
  const read: readonly string[] = route.query ?? []
  for (const name of query.keys()) if (!read.includes(name)) server.misuse.push(`${key} with the query parameter ${name}`)
  if ((body !== undefined) !== !!route.body) server.misuse.push(`${key} ${body === undefined ? 'without' : 'with'} a body`)
  const values: Partial<Record<Query<K>, string>> = {}
  for (const name of route.query ?? []) { const value = query.get(name); if (value !== null) values[name] = value }
  return route.answer({ params: params as RouteParams<K>, query: values, body: body as Body<K> })
}
/**
 * Response wrapper that increments `server.pending` when constructed and decrements it when `.text()` is consumed.
 * Requests held back by `server.searching` are not constructed until `searching` resolves, so they do not count as pending early.
 */
class Reply extends Response {
  constructor(value: unknown, status: number) { super(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json' } }); server.pending++ }
  override async text() { server.pending--; return super.text() }
}

export function usePanelServer(cleanup: () => void) {
  beforeEach(() => {
    sessionStorage.clear()
    // VsSaros addition: page tests start with the side panel (the Overview) closed; Overview tests open it (`openSide`).
    localStorage.clear()
    localStorage.setItem('dsh-superagent/side', JSON.stringify({ open: false }))
    server = initial()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (server.down) return new Response(null, { status: 404 })
      const address = new URL(url, 'http://127.0.0.1:3082')
      const path = address.pathname.replace('/orchestrator/api/', '')
      // VsSaros addition (plan C): the change stream stays open until the page closes it; `pushChange` writes to it.
      if (path === 'stream') {
        if (!server.streaming) return new Response(null, { status: 404 })
        const signal = init?.signal
        return new Response(new ReadableStream<Uint8Array>({ start: controller => {
          server.streams.push(controller)
          signal?.addEventListener('abort', () => {
            server.streams = server.streams.filter(item => item !== controller)
            try { controller.close() } catch { /* closed */ }
          })
        } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
      server.requests.push({ path: decodeURIComponent(`${path}${address.search}`), method, ...body === undefined ? {} : { body } })
      const route = match(method, path.split('/'))
      if (!route) return new Reply({ error: 'Unknown operation' }, 404)
      const answer = await run(route.key, route.params, address.searchParams, body)
      return answer instanceof Refusal ? new Reply(answer.body, answer.status) : new Reply(answer, 200)
    }))
  })
  afterEach(() => {
    try { expect(server.misuse).toEqual([]) }
    finally { cleanup(); vi.unstubAllGlobals() }
  })
}

type Ops = Parameters<ConfigForm<Record<string, unknown>>['mutate']>[0]
/** Fake DSH host configuration form that records mutations and optionally applies them to its snapshot. */
export function fakeForm(writable = true, accept = true) {
  const listeners = new Set<() => void>()
  let snapshot: ConfigFormSnapshot<Record<string, unknown>> = { status: 'ready', value: { ...MACHINE }, base: undefined, user: undefined,
    revision: 1, writable,
    mode: 'host' }
  const notify = () => { for (const listener of listeners) listener() }
  const mutations: { ops: Ops; revision: number | undefined }[] = []
  const form: ConfigForm<Record<string, unknown>> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
      if (!accept || revision !== snapshot.revision) return false
      const value = { ...snapshot.value }
      for (const op of ops) { if (op.op === 'set') value[op.path[0]!] = op.value; else delete value[op.path[0]!] }
      snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
      notify()
      return true
    },
    set: async () => false, unset: async () => false,
  }
  const publish = (patch: Partial<ConfigFormSnapshot<Record<string, unknown>>>) => { snapshot = { ...snapshot, ...patch }; notify() }
  return { form, mutations, publish }
}
