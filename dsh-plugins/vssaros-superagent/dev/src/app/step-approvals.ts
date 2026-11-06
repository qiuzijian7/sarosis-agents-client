/**
 * VsSaros addition (superagent runtime UI, plan C): what a team step may do, and the approvals it asks a person for.
 * Its answerer follows DS Bot's (ds-bot/src/host/approvals.js: answering ahead of DSH with prepend; `doingOf` follows
 * ds-bot/src/host/turns.js), Copyright 2026 Fei2411 and the DS Bot contributors, Apache License 2.0; see NOTICE.
 *
 * A read step runs `read-only`: it changes no file, by its shell either. A write step runs `workspace-write`: it changes its
 * ticket's directory without asking, and only a call that reaches beyond it asks (DSH's sandbox escalation). superagent
 * answers those requests itself, ahead of DSH's own answerer, which would hold a hidden step Session's request unseen: a
 * read step's is refused; a write step's is allowed when a person remembered the same Bot, tool and command; otherwise it
 * waits for a person, in the panel, and in the conversation the ticket started in when that is its Feishu thread or the
 * supervisor desk, where a listed person's reply answers it.
 *
 * On Windows, `workspace-write` writes an integrity label on the directory before each command; where this machine refuses
 * that (some volumes do), every command would fail, so such a write step runs unsandboxed with its file tools kept inside the
 * directory instead, and the panel says so.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { liveTicket, reached, type ChannelRef, type Engine, type OutboundMessage, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, type Settings } from '../policy.ts'
import { stepOfSession, type TeamStep } from './steps.ts'
import type { Store } from './store.ts'

/** DSH's answers to an approval request; `allowed-once` is the only grant. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
/** The part of DSH's approval request superagent reads. */
export interface ApprovalRequest { agent: Agent; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }
/** A person's answer: once, once and remember it, or no. */
export type ApprovalChoice = 'allow' | 'remember' | 'reject'

/**
 * VsSaros fix (2026-11-06): a request no one answers no longer waits for ever. After `APPROVAL_REMIND_MS` the person is
 * reminded once; after `APPROVAL_EXPIRE_MS` it is refused, as if a person said no.
 */
export const APPROVAL_REMIND_MS = 30 * 60_000
export const APPROVAL_EXPIRE_MS = 60 * 60_000
/** How often waiting requests are looked at for their reminder and expiry. */
const SWEEP_MS = 60_000

/** A step's request waiting for a person, as the panel shows it. */
export interface StepApprovalView {
  id: string; code: string; ticketId: string; ticketTitle: string; step: string; stepTitle: string
  bot: { id: string; name: string }; tool: string; reason: string; detail: { text?: string; code?: string }; at: string
  /** The request was also sent to the ticket's Feishu thread. */
  feishu: boolean
  /** VsSaros fix (2026-11-06): when it is refused if no one answers. */
  expiresAt: string
  /** When the person was reminded of it. */
  remindedAt?: string
  /**
   * It was waiting when SuperAgent restarted, so the call that asked is gone: an answer is told to the step's Bot, and
   * an allow lets that call through once when the Bot makes it again.
   */
  restored?: true
}
/** A remembered answer: this Bot's calls of this tool whose command or path begins with `head` are allowed. */
export interface ApprovalRule { id: string; bot: { id: string; name: string }; tool: string; head: string; at: string; by: string
  /** VsSaros addition (2026-11-06): the template it came from. */
  template?: ApprovalTemplateId }
/** VsSaros fix (2026-11-06): a restored request a person allowed: the step's next call of that tool and subject passes once. */
interface ApprovalGrant { id: string; ticketId: string; step: string; tool: string; subject: string; at: string }

/**
 * `posted`: the request was sent to the conversation the ticket started in, where a person's reply answers it: its Feishu
 * thread, or (VsSaros, 2026-11-05) the supervisor desk, whose model tells the person and takes the answer. `settle` is
 * the waiting call's; a restored request has none.
 */
interface Pending extends StepApprovalView { posted: boolean; settle?(outcome: ApprovalOutcome): void }
const viewOf = ({ settle: _settle, posted: _posted, ...view }: Pending): StepApprovalView => view
/** Whether a Channel is the supervisor desk's conversation. */
const isDesk = (channel: ChannelRef | undefined): boolean =>
  channel?.source === 'superagent' && (channel.address as { kind?: unknown } | undefined)?.kind === 'desk'

/** The DSH permission preset a step runs under, and whether its sandbox holds. */
export interface StepPermission { preset: 'read-only' | 'workspace-write' | 'danger-full-access'; sandboxed: boolean }
/** A read step is read-only; a write step writes its directory, sandboxed when this machine can sandbox it. */
export const stepPermission = (access: TeamStep['access'], sandboxWorks: boolean): StepPermission => access === 'read'
  ? { preset: 'read-only', sandboxed: true }
  : sandboxWorks ? { preset: 'workspace-write', sandboxed: true } : { preset: 'danger-full-access', sandboxed: false }

/**
 * Whether DSH's `workspace-write` sandbox can work in `directory`: always off Windows; on Windows, whether this machine lets
 * a process write a Low integrity label there (the half of DSH's ACL grant some machines refuse), tried on a folder of its own.
 */
export async function sandboxWorks(directory: string, platform = process.platform,
  run: (file: string, args: string[]) => Promise<number> = runCode): Promise<boolean> {
  if (platform !== 'win32') return true
  let probe: string | undefined
  try {
    probe = await mkdtemp(join(directory, '.vssaros-sandbox-probe-'))
    return await run('icacls', [probe, '/setintegritylevel', 'Low']) === 0
  } catch { return false } finally { if (probe) await rm(probe, { recursive: true, force: true }).catch(() => undefined) }
}
const runCode = (file: string, args: string[]) => new Promise<number>(done => {
  execFile(file, args, { windowsHide: true, timeout: 15_000 }, error => { done(error ? (typeof error.code === 'number' ? error.code : 1) : 0) })
})

/** Whether `path` is `directory` or inside it (case-insensitively on Windows). */
export function within(directory: string, path: string, platform = process.platform): boolean {
  const fold = (value: string) => platform === 'win32' ? value.toLowerCase() : value
  const root = fold(resolve(directory)), target = fold(resolve(directory, path))
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** What a remembered answer keys on: a command's first two words, or a path's folder. */
export function headOf(subject: string): string {
  const text = subject.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (!text.includes(' ') && /[\\/]/.test(text)) return text.replace(/[\\/][^\\/]*$/, '') || text
  return text.split(' ').slice(0, 2).join(' ')
}
/**
 * VsSaros fix (2026-11-06): what makes one command line run more than its first command, or write a file: a remembered
 * head never covers such a line (`git status; rm -rf x` is not `git status`).
 */
const CHAINED = /[;&|`\n\r<>]|\$\(/
/** Whether a remembered head covers `subject`: the same command words, or a path in the same folder; never a chained line. */
export function covers(head: string, subject: string): boolean {
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()
  const h = norm(head), s = norm(subject)
  if (!h || CHAINED.test(subject)) return false
  return s === h || s.startsWith(`${h} `) || s.startsWith(`${h}/`) || s.startsWith(`${h}\\`)
}

/**
 * VsSaros addition (2026-11-06, P2 · approval templates): ready-made sets of remembered answers a person gives a Bot at
 * once, for the shell tools (`bash`, `pwsh`). Each head is matched as a remembered one (`covers`): the same first words, and
 * never a chained line. `risk` is what the panel says of it.
 */
export const APPROVAL_TEMPLATES = [
  { id: 'git-read', risk: 'low', heads: ['git status', 'git diff', 'git log', 'git show', 'git branch', 'git rev-parse'] },
  { id: 'tests', risk: 'low', heads: ['npm test', 'pnpm test', 'npx vitest', 'pnpm vitest', 'pytest', 'go test', 'cargo test', 'dotnet test'] },
  { id: 'build', risk: 'low', heads: ['npm run build', 'npm run lint', 'pnpm build', 'pnpm lint', 'npx tsc', 'go build', 'cargo build'] },
  { id: 'install', risk: 'medium', heads: ['npm install', 'npm ci', 'pnpm install', 'pip install', 'go mod download'] },
] as const
export type ApprovalTemplateId = typeof APPROVAL_TEMPLATES[number]['id']
const SHELL_TOOLS = ['bash', 'pwsh'] as const

/** What a call is about: its own description, and the command, path or address it acts on (as DeepSeek-Bot's `callDetail`). */
export function callDetail(events: readonly { type: string; data?: unknown }[], callId: string | undefined): { text?: string; code?: string } {
  if (!callId) return {}
  const call = events.find(event => event.type === 'tool/call' && (event.data as { callId?: unknown } | undefined)?.callId === callId)
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(String((call?.data as { arguments?: unknown } | undefined)?.arguments ?? '{}')) as Record<string, unknown> } catch { args = {} }
  const first = (keys: string[]) => keys.map(key => args[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const text = first(['description', 'justification']), code = first(['command', 'cmd', 'file_path', 'path', 'url', 'query'])
  return { ...text ? { text: text.trim().slice(0, 300) } : {}, ...code ? { code: code.trim().slice(0, 400) } : {} }
}

/** A Feishu reply that answers an approval: 同意 / 同意并记住 / 拒绝, with the request's code when several wait. */
export function approvalReply(text: string): { choice: ApprovalChoice; code?: string } | undefined {
  const plain = text.replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim()
  const match = /^(同意并记住|允许并记住|同意|允许|拒绝|不同意)\s*#?([0-9a-z]{4})?\s*[。.!！]?$/i.exec(plain)
  if (!match) return undefined
  const word = match[1]!
  const choice: ApprovalChoice = word.endsWith('记住') ? 'remember' : word === '拒绝' || word === '不同意' ? 'reject' : 'allow'
  return { choice, ...match[2] ? { code: match[2].toLowerCase() } : {} }
}

export interface StepApprovalsHost {
  context: Context
  store: Pick<Store, 'db' | 'tickets' | 'triggers' | 'threads' | 'settings'>
  steps: {
    step(sessionId: string): TeamStep | undefined
    /** A step's own Session gets a message (a restored request's answer); the steps' `message`. */
    message?(ticketId: string, key: string, text: string): Promise<unknown>
    /** A step by ticket and key. */
    get?(ticketId: string, key: string): TeamStep | undefined
  }
  outbox: { send(message: OutboundMessage): void }
  engine: Pick<Engine, 'note'>
  warn(message: string): void
  /** A request started or stopped waiting; open pages hear of it. */
  changed?(): void
  now?(): number
}

/**
 * Answers team steps' approval requests: by their access, by remembered answers, or by a person in the panel or on Feishu.
 * VsSaros fix (2026-11-06): waiting requests are written to SQLite (`step_approval_pending`), so after a restart they are
 * still shown and answerable, and each one is reminded of once and refused when it expires.
 */
export class StepApprovals {
  private readonly pending = new Map<string, Pending>()
  private readonly now: () => number
  constructor(private readonly host: StepApprovalsHost) {
    this.now = host.now ?? Date.now
    host.store.db.exec('CREATE TABLE IF NOT EXISTS step_approval_rule (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    host.store.db.exec('CREATE TABLE IF NOT EXISTS step_approval_pending (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    host.store.db.exec('CREATE TABLE IF NOT EXISTS step_approval_grant (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    // What waited when SuperAgent stopped: its call is gone, so it waits as a restored request.
    for (const row of host.store.db.prepare('SELECT value FROM step_approval_pending').all()) {
      try {
        const item = JSON.parse(String(row.value)) as Pending
        // Older rows (none before this fix) or a lost expiry: an hour from when it was asked.
        const expiresAt = item.expiresAt ?? new Date(Date.parse(item.at) + APPROVAL_EXPIRE_MS).toISOString()
        const { settle: _lost, ...kept } = item
        this.pending.set(item.id, { ...kept, expiresAt, restored: true })
      } catch { /* an unreadable row is dropped below */ }
    }
    host.store.db.prepare(`DELETE FROM step_approval_pending WHERE id NOT IN (${[...this.pending.keys()].map(() => '?').join(',') || "''"})`).run(...this.pending.keys())
  }

  /** Answers step Sessions' requests ahead of DSH's own answerer; any other Session's go on to it. Reminds and expires them. */
  install(): () => void {
    const on = this.host.context.on as unknown as (name: string, listener: (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>,
      options: { prepend: boolean }) => () => void
    const off = on.call(this.host.context, 'approval/request', (request, next) => this.decide(request, next), { prepend: true })
    this.sweep()
    const timer = setInterval(() => { this.sweep() }, SWEEP_MS)
    timer.unref?.()
    return () => { clearInterval(timer); off() }
  }

  /**
   * Reminds the person of each request waiting past `APPROVAL_REMIND_MS`, once, and refuses each one past its expiry.
   * Runs every minute; tests call it with their own clock.
   */
  sweep(): void {
    const at = this.now()
    for (const item of [...this.pending.values()]) {
      // A restored request of a step or ticket that has ended asks no one any more.
      if (!item.settle) {
        const ticket = this.host.store.tickets.get(item.ticketId), step = this.host.steps.get?.(item.ticketId, item.step)
        if (!ticket || !liveTicket(ticket) || (step && ['ready', 'stopped', 'skipped', 'failed'].includes(step.state))) {
          this.pending.delete(item.id); this.unsave(item.id); this.host.changed?.(); continue
        }
      }
      if (Date.parse(item.expiresAt) <= at) { this.expire(item); continue }
      if (!item.remindedAt && Date.parse(item.at) + APPROVAL_REMIND_MS <= at) this.remind(item, at)
    }
  }

  /** Decides a request: the step's, or `next` for one that is not a team step's. */
  async decide(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const step = this.stepOf(request.agent)
    if (!step) return next()
    const ticket = this.host.store.tickets.get(step.ticketId)
    if (!ticket || !liveTicket(ticket) || ['stopped', 'skipped', 'failed'].includes(step.state)) return 'rejected'
    // A read step is read-only: what it asks for is a change, which it may not make.
    if (step.access === 'read') return 'rejected'
    const detail = callDetail(request.agent.session.snapshotEvents() as never, request.callId)
    const subject = detail.code ?? request.reason ?? ''
    if (this.rules().some(rule => rule.bot.id === step.bot.id && rule.tool === request.toolName && covers(rule.head, subject))) return 'allowed-once'
    if (this.takeGrant(step, request.toolName, subject)) return 'allowed-once'
    if (request.signal?.aborted) return 'cancelled'
    return this.ask(request, step, ticket, detail)
  }

  /** The requests waiting for a person, oldest first. */
  list(): StepApprovalView[] {
    return [...this.pending.values()].map(viewOf).sort((a, b) => a.at.localeCompare(b.at))
  }
  /** A step's waiting request, if any. */
  of(ticketId: string, key: string): StepApprovalView | undefined { return this.list().find(item => item.ticketId === ticketId && item.step === key) }

  /** A person answers a waiting request. @throws Error when it no longer waits. */
  answer(id: string, choice: ApprovalChoice, by: string, from: 'panel' | 'thread' | 'expired' = 'panel'): StepApprovalView {
    const pending = this.pending.get(id)
    if (!pending) throw new Error('This approval no longer waits; the step may have stopped or been answered')
    if (choice === 'remember') this.remember(pending, by)
    const outcome: ApprovalOutcome = choice === 'reject' ? 'rejected' : 'allowed-once'
    if (pending.settle) pending.settle(outcome)
    else this.answerRestored(pending, outcome)
    const word = choice === 'reject' ? '拒绝了' : choice === 'remember' ? '允许了（以后同类命令不再问）' : '允许了'
    const what = `${pending.bot.name} 的「${pending.detail.code ?? pending.tool}」`
    if (pending.posted) {
      const channel = this.channelOf(pending.ticketId)
      if (channel) this.host.outbox.send({ id: `step-approval-answer:${id}`, channel, kind: 'notice', ticketId: pending.ticketId,
        text: from === 'expired' ? `#${pending.code} ${Math.round(APPROVAL_EXPIRE_MS / 60_000)} 分钟没人批，已按拒绝处理：${what}`
          : `#${pending.code} 已${word.replace(/了/, '')}：${what}${from === 'panel' ? '（在面板里处理）' : ''}` })
    }
    if (from === 'thread') this.note(pending.ticketId, `A person's reply in the ticket's conversation answered step ${pending.step}'s request to run ${pending.detail.code ?? pending.tool}: ${choice}. It needs nothing from you.`)
    if (from === 'expired') this.note(pending.ticketId, `No one answered step ${pending.step}'s request to run ${pending.detail.code ?? pending.tool} within ${Math.round(APPROVAL_EXPIRE_MS / 60_000)} minutes, so it was refused.`)
    return viewOf(pending)
  }

  /** The remembered answers, newest first. */
  rules(): ApprovalRule[] {
    return this.host.store.db.prepare('SELECT value FROM step_approval_rule').all().map(row => JSON.parse(String(row.value)) as ApprovalRule)
      .sort((a, b) => b.at.localeCompare(a.at))
  }
  forget(id: string): void { this.host.store.db.prepare('DELETE FROM step_approval_rule WHERE id=?').run(id) }
  /**
   * VsSaros addition (2026-11-06): a person gives a Bot a template's remembered answers; heads it already has are kept.
   * @returns the rules added.
   * @throws Error when there is no such template.
   */
  applyTemplate(templateId: string, bot: { id: string; name: string }, by: string): ApprovalRule[] {
    const template = APPROVAL_TEMPLATES.find(item => item.id === templateId)
    if (!template) throw new Error(`No approval template ${templateId}`)
    const existing = this.rules()
    const added: ApprovalRule[] = []
    for (const tool of SHELL_TOOLS) for (const head of template.heads) {
      if (existing.some(rule => rule.bot.id === bot.id && rule.tool === tool && rule.head.toLowerCase() === head)) continue
      const rule: ApprovalRule = { id: randomUUID(), bot, tool, head, at: new Date(this.now()).toISOString(), by, template: template.id }
      this.host.store.db.prepare('INSERT INTO step_approval_rule VALUES (?,?)').run(rule.id, JSON.stringify(rule))
      added.push(rule)
    }
    return added
  }

  /**
   * A message that reached a ticket: when it is a listed person's 同意 / 同意并记住 / 拒绝 on the ticket's thread, written
   * after the request was sent there, it answers that request. Called inside the transaction that received it, so the
   * answer runs after it.
   */
  fromMessage(trigger: Trigger): void {
    const reply = approvalReply(trigger.text)
    if (!reply || !trigger.human || !allowedSender(this.host.store.settings() as Settings, trigger.actor)) return
    const received = Date.parse(this.host.store.triggers.disposition(trigger.id)?.at ?? trigger.at)
    const candidates = [...this.pending.values()].filter(item => {
      const ticket = this.host.store.tickets.get(item.ticketId)
      return item.posted && ticket && reached(ticket, trigger, key => this.host.store.threads.get(key), false) && received >= Date.parse(item.at)
    })
    const chosen = reply.code ? candidates.filter(item => item.code === reply.code) : candidates
    if (chosen.length === 1) {
      const id = chosen[0]!.id
      queueMicrotask(() => { try { this.answer(id, reply.choice, trigger.actor.id, 'thread') } catch { /* answered meanwhile */ } })
    } else if (chosen.length > 1) {
      const channel = this.channelOf(chosen[0]!.ticketId)
      if (channel) this.host.outbox.send({ id: `step-approval-which:${trigger.id}`, channel, kind: 'notice', ticketId: chosen[0]!.ticketId,
        text: `有 ${chosen.length} 个请求在等你批准，回复时带上编号，例如「同意 #${chosen[0]!.code}」：${chosen.map(item => `#${item.code} ${item.bot.name}`).join('、')}` })
    }
  }

  private ask(request: ApprovalRequest, step: TeamStep, ticket: Ticket, detail: { text?: string; code?: string }): Promise<ApprovalOutcome> {
    const id = randomUUID(), code = randomBytes(2).toString('hex')
    const channel = this.channelOf(ticket.id)
    const feishu = channel?.source === 'feishu'
    const posted = !!channel && (feishu || isDesk(channel))
    return new Promise<ApprovalOutcome>(done => {
      const settle = (outcome: ApprovalOutcome) => {
        if (!this.pending.delete(id)) return
        this.unsave(id)
        request.signal?.removeEventListener('abort', aborted)
        this.host.changed?.()
        done(outcome)
      }
      const aborted = () => { settle('cancelled') }
      const at = this.now()
      const item: Pending = { id, code, ticketId: ticket.id, ticketTitle: ticket.title, step: step.key, stepTitle: step.title, bot: step.bot,
        tool: request.toolName, reason: (request.reason ?? '').slice(0, 500), detail, at: new Date(at).toISOString(), feishu, posted,
        expiresAt: new Date(at + APPROVAL_EXPIRE_MS).toISOString(), settle }
      this.pending.set(id, item)
      this.save(item)
      this.host.changed?.()
      request.signal?.addEventListener('abort', aborted, { once: true })
      if (posted && channel) {
        this.host.outbox.send({ id: `step-approval:${id}`, channel, kind: 'notice', ticketId: ticket.id, text: [
          `【需要你批准 #${code}】步骤 ${step.key}「${step.title}」（${step.bot.name}）要越出工作目录运行：`,
          detail.code ?? request.toolName, ...detail.text ? [`理由：${detail.text}`] : [],
          `回复「同意 #${code}」允许一次，「同意并记住 #${code}」以后同类命令不再问，「拒绝 #${code}」拒绝。`].join('\n') })
      }
    })
  }
  private save(item: Pending): void {
    this.host.store.db.prepare('INSERT INTO step_approval_pending VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(item.id, JSON.stringify({ ...viewOf(item), posted: item.posted }))
  }
  private unsave(id: string): void { this.host.store.db.prepare('DELETE FROM step_approval_pending WHERE id=?').run(id) }
  /**
   * A restored request answered (its call was lost in a restart): it stops waiting, an allow lets the step's next call of
   * the same tool and subject through once, and the step's Bot is told either way, when the step still goes on.
   */
  private answerRestored(pending: Pending, outcome: ApprovalOutcome): void {
    this.pending.delete(pending.id)
    this.unsave(pending.id)
    this.host.changed?.()
    const subject = pending.detail.code ?? pending.reason
    if (outcome === 'allowed-once') {
      const grant: ApprovalGrant = { id: randomUUID(), ticketId: pending.ticketId, step: pending.step, tool: pending.tool, subject, at: new Date(this.now()).toISOString() }
      this.host.store.db.prepare('INSERT INTO step_approval_grant VALUES (?,?)').run(grant.id, JSON.stringify(grant))
    }
    const step = this.host.steps.get?.(pending.ticketId, pending.step)
    if (!step || !['running', 'blocked'].includes(step.state) || !this.host.steps.message) return
    const text = outcome === 'allowed-once'
      ? `A person allowed your request to run ${subject} (it was waiting when SuperAgent restarted, so that call ended). Run it again now; it is allowed once.`
      : `A person refused your request to run ${subject} (it was waiting when SuperAgent restarted). Do not run it; do the step another way, or report blocked with a question.`
    void this.host.steps.message(pending.ticketId, pending.step, text).catch(error => { this.host.warn(`restored approval answer not told: ${String(error)}`) })
  }
  /** Takes the one-shot grant for this step's call, if a person allowed it after a restart. */
  private takeGrant(step: TeamStep, tool: string, subject: string): boolean {
    const grants = this.host.store.db.prepare('SELECT value FROM step_approval_grant').all().map(row => JSON.parse(String(row.value)) as ApprovalGrant)
    const grant = grants.find(item => item.ticketId === step.ticketId && item.step === step.key && item.tool === tool
      && item.subject.replace(/\s+/g, ' ').trim() === subject.replace(/\s+/g, ' ').trim())
    if (!grant) return false
    this.host.store.db.prepare('DELETE FROM step_approval_grant WHERE id=?').run(grant.id)
    return true
  }
  /** Refuses a request no one answered in time, as a person's no. */
  private expire(item: Pending): void {
    try { this.answer(item.id, 'reject', 'timeout', 'expired') } catch { /* answered meanwhile */ }
  }
  /** Reminds the person once of a request still waiting. */
  private remind(item: Pending, at: number): void {
    item.remindedAt = new Date(at).toISOString()
    this.save(item)
    this.host.changed?.()
    const left = Math.max(1, Math.round((Date.parse(item.expiresAt) - at) / 60_000))
    const what = `步骤 ${item.step}（${item.bot.name}）要运行「${item.detail.code ?? item.tool}」`
    const channel = item.posted ? this.channelOf(item.ticketId) : undefined
    if (channel) this.host.outbox.send({ id: `step-approval-remind:${item.id}`, channel, kind: 'notice', ticketId: item.ticketId,
      text: `【还在等你批准 #${item.code}】${what}，已经等了 ${Math.round(APPROVAL_REMIND_MS / 60_000)} 分钟；${left} 分钟内没人批就按拒绝处理。回复「同意 #${item.code}」或「拒绝 #${item.code}」。` })
    this.note(item.ticketId, `Step ${item.step}'s request to run ${item.detail.code ?? item.tool} has waited ${Math.round(APPROVAL_REMIND_MS / 60_000)} minutes for a person; it is refused in ${left} minutes. Remind the person if you talk with them.`)
  }
  private remember(pending: Pending, by: string): void {
    const head = headOf(pending.detail.code ?? pending.reason)
    if (!head) return
    const rule: ApprovalRule = { id: randomUUID(), bot: pending.bot, tool: pending.tool, head, at: new Date().toISOString(), by }
    this.host.store.db.prepare('INSERT INTO step_approval_rule VALUES (?,?)').run(rule.id, JSON.stringify(rule))
  }
  /** The team step a Session, or one of its subagents, does. */
  private stepOf(agent: Agent): TeamStep | undefined {
    let id: string | undefined = agent.id
    for (let depth = 0; id !== undefined && depth < 8; depth += 1) {
      if (stepOfSession(id)) return this.host.steps.step(id)
      id = (depth === 0 ? agent : this.host.context.agents.get(id as SessionId))?.session.header.parentSession
    }
    return undefined
  }
  private channelOf(ticketId: string) {
    const ticket = this.host.store.tickets.get(ticketId)
    return ticket ? this.host.store.triggers.get(ticket.origin.triggerId)?.channel ?? ticket.channels[0] : undefined
  }
  private note(ticketId: string, text: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return
    try { this.host.engine.note(ticketId, text) } catch (error) { this.host.warn(`approval note not given: ${String(error)}`) }
  }
}

/** What a step is doing now: its latest tool call, as DeepSeek-Bot's `doingOf` reads it. */
export interface StepDoing { tool: string; target?: string; note?: string; at: string }
/** The latest call of each step Session (or its subagents), until its turn ends. */
export class StepActivity {
  private readonly doing = new Map<string, StepDoing>()
  constructor(private readonly context: Context, private readonly changed: () => void = () => {}) {}
  install(): () => void {
    const ctx = this.context
    const offEvent = ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/call') return
      const owner = this.ownerOf(session.id)
      if (!owner) return
      this.doing.set(owner, doingOf(event.data as { name?: unknown; arguments?: unknown }))
      this.changed()
    })
    const offStatus = ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && stepOfSession(agent.id) && this.doing.delete(agent.id)) this.changed()
    })
    return () => { offEvent(); offStatus() }
  }
  of(sessionId: string): StepDoing | undefined { return this.doing.get(sessionId) }
  private ownerOf(sessionId: string): string | undefined {
    let id: string | undefined = sessionId
    for (let depth = 0; id !== undefined && depth < 8; depth += 1) {
      if (stepOfSession(id)) return id
      id = this.context.agents.get(id as SessionId)?.session.header.parentSession
    }
    return undefined
  }
}
/** A tool call as a short line: the tool, the file, query or site it acts on, and its own description. */
export function doingOf(call: { name?: unknown; arguments?: unknown }, at = new Date().toISOString()): StepDoing {
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(String(call.arguments ?? '{}')) as Record<string, unknown> } catch { args = {} }
  const first = (keys: string[]) => keys.map(key => args[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '')
    ?.replace(/\s+/g, ' ').trim()
  const note = first(['description', 'justification']), path = first(['file_path', 'path']), url = first(['url'])
  let site: string | undefined
  try { site = url ? new URL(url).host : undefined } catch { site = undefined }
  const target = path?.split(/[\\/]/).filter(Boolean).at(-1) ?? first(['query', 'pattern']) ?? site ?? first(['command'])?.slice(0, 60)
  return { tool: String(call.name ?? ''), ...target ? { target: target.slice(0, 80) } : {}, ...note ? { note: note.slice(0, 120) } : {}, at }
}
