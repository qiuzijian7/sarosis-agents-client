/**
 * Local HTML and native editable Feishu reports from immutable ticket-ending facts.
 * Cloud creation is a separate durable effect for all sources; IM delivery remains opt-in.
 * Both paths reuse one document cache and creation lock. Unconfirmed remote creation is
 * surfaced for reconciliation rather than blindly retried, so a crash cannot silently duplicate reports.
 * No file or CLI work runs inside ticket.ended, and report failures do not hold worker slots.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { latestAssignment, type ChannelRef, type Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

/** Directory under the state directory that holds generated report files and the document cache. */
export const REPORT_DIR = 'reports'
/** The effect kind that writes and sends one report. */
export const REPORT_EFFECT = 'ticketReport'
export const CLOUD_REPORT_EFFECT = 'reportCloud'
type CloudState = 'not-requested' | 'queued' | 'created' | 'creation-uncertain' | 'failed'
interface ReportPayload { ticketId: string; at: string; view?: TicketReportView }
interface CreationRecord { ticketId: string; at: string; state: 'creating' | 'created' | 'creation-uncertain' | 'failed'; error?: string }
/** Feishu rejects idempotency keys longer than 50 characters. */
const idempotencyKey = (value: string): string => `sa-${createHash('sha256').update(value).digest('hex').slice(0, 30)}`
/** Keeps the short IM notice well inside the 100-word transport limit. */
const NOTICE_TITLE_CHARS = 60

/** Escapes every untrusted value before it is placed in a document. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

/** A report's facts, all plain data so rendering stays a pure function. */
export interface TicketReportView {
  id: string
  title: string
  outcome: string
  summary: string
  request: string
  reason: string
  createdAt: string
  endedAt: string
  endedBy: string
  channels: { source: string; thread: string }[]
  assignments: { id: string; state: string; at: string; summary: string }[]
  execution: string
}

const OUTCOME_TEXT: Record<string, string> = {
  completed: '已完成', merged: 'PR 已合并', closed: 'PR 已关闭（未合并）', dropped: '无需处理', stopped: '已停止',
  blocked: '受阻，等待人工', failed: '执行失败', ready: '等待交付审核',
}

/** The facts of an ended ticket, or undefined while it is open; untrusted text is escaped only when rendered. */
export function ticketReportView(ticket: Ticket, request: string): TicketReportView | undefined {
  const ended = ticket.ended
  const report = latestAssignment(ticket)?.report
  if (!ended && (!report || !['blocked', 'failed', 'ready'].includes(report.state))) return undefined
  const result = ended ?? { outcome: report!.state, reason: ticket.attention?.question ?? '', at: report!.at, by: 'executor' }
  return {
    id: ticket.id, title: ticket.title,
    outcome: ended?.outcome === 'completed' && ticket.execution?.p4Delivery === 'pending' ? '已交付 pending CL（未提交，验证状态见报告）' : OUTCOME_TEXT[result.outcome] ?? result.outcome,
    summary: (report?.summary ?? '').trim() || (result.reason ?? '').trim(),
    request: request.trim(), reason: (result.reason ?? '').trim(),
    createdAt: ticket.createdAt, endedAt: result.at, endedBy: result.by,
    channels: (ticket.channels ?? []).map(channel => ({ source: channel.source, thread: channel.thread })),
    assignments: ticket.assignments.map(assignment => ({ id: assignment.id, state: assignment.state,
      at: assignment.report?.at ?? assignment.endedAt ?? assignment.createdAt,
      summary: (assignment.report?.summary ?? '').trim() || (assignment.endedReason ?? '').trim() })),
    execution: ticket.execution ? `${ticket.execution.name} · ${ticket.execution.directory}` : '',
  }
}

/** Renders a standalone HTML document with inline styling and no external resources. */
export function renderTicketReport(view: TicketReportView): string {
  const rows = view.assignments.map((assignment, index) => `<tr>
      <td>${index + 1}</td><td class="mono">${escapeHtml(assignment.state)}</td>
      <td class="mono">${escapeHtml(assignment.at)}</td><td>${escapeHtml(assignment.summary) || '<span class="muted">—</span>'}</td>
    </tr>`).join('')
  const channels = view.channels.map(channel => `<li><span class="mono">${escapeHtml(channel.source)}</span> · ${escapeHtml(channel.thread)}</li>`).join('')
  const block = (label: string, value: string) => `<section><h2>${escapeHtml(label)}</h2><div class="body">${value}</div></section>`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(view.title)} · SuperAgent 工单报告</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px 20px 64px; font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1f2329; background: #f7f8fa; }
  main { max-width: 880px; margin: 0 auto; background: #fff; border: 1px solid #e5e6eb; border-radius: 12px; padding: 32px 36px 40px; }
  h1 { font-size: 24px; line-height: 1.4; margin: 12px 0 20px; }
  h2 { font-size: 14px; font-weight: 600; letter-spacing: .04em; color: #646a73; margin: 0 0 10px; }
  section { border-top: 1px solid #eff0f1; padding: 22px 0 0; margin-top: 22px; }
  .eyebrow { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #8f959e; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; background: #e8f3ff; color: #1456b8; font-size: 13px; font-weight: 600; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px 24px; margin: 0; }
  .meta div { min-width: 0; }
  .meta dt { font-size: 12px; color: #8f959e; }
  .meta dd { margin: 2px 0 0; font-size: 14px; overflow-wrap: anywhere; }
  .body { white-space: pre-wrap; overflow-wrap: anywhere; }
  .muted { color: #8f959e; }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #eff0f1; vertical-align: top; }
  th { color: #8f959e; font-weight: 600; font-size: 12px; }
  ul { margin: 0; padding-left: 20px; }
  footer { max-width: 880px; margin: 16px auto 0; color: #8f959e; font-size: 12px; }
</style>
</head>
<body>
<main>
  <div class="eyebrow">SuperAgent · 工单报告</div>
  <h1>${escapeHtml(view.title)}</h1>
  <span class="badge">${escapeHtml(view.outcome)}</span>
  <dl class="meta" style="margin-top:24px">
    <div><dt>工单 ID</dt><dd class="mono">${escapeHtml(view.id)}</dd></div>
    <div><dt>结束时间</dt><dd class="mono">${escapeHtml(view.endedAt)}</dd></div>
    <div><dt>创建时间</dt><dd class="mono">${escapeHtml(view.createdAt)}</dd></div>
    <div><dt>结束者</dt><dd>${escapeHtml(view.endedBy)}</dd></div>
  </dl>
  ${block('原始需求', escapeHtml(view.request) || '<span class="muted">—</span>')}
  ${block('结果摘要', escapeHtml(view.summary) || '<span class="muted">—</span>')}
  ${view.reason ? block('结束原因', escapeHtml(view.reason)) : ''}
  ${view.execution ? block('执行环境', `<span class="mono">${escapeHtml(view.execution)}</span>`) : ''}
  ${rows ? `<section><h2>执行轨迹</h2><table><thead><tr><th>#</th><th>状态</th><th>时间</th><th>报告</th></tr></thead><tbody>${rows}</tbody></table></section>` : ''}
  ${channels ? block('关联会话', `<ul>${channels}</ul>`) : ''}
</main>
<footer>本文件由 SuperAgent 自动生成，内容来自本机工单记录；请勿在外部转发包含内部信息的报告。</footer>
</body>
</html>
`
}

/** A safe ASCII file name; lark-cli only accepts cwd-relative paths without `..` for local resources. */
export const reportFileName = (ticketId: string): string => `report-${ticketId.replace(/[^A-Za-z0-9_-]/g, '') || 'ticket'}.html`

/** DocxXML whose file block makes Feishu render the local `.html` artifact as a page preview. */
export const reportDocXml = (file: string): string => `<figure view-type="Preview"><source path="@./${file}" name="${file}"/></figure>\n`

/** Native editable document blocks; no executable HTML or external resources are imported. */
export function renderTicketDocXml(view: TicketReportView): string {
  const text = (value: string) => escapeHtml(value).replace(/\r?\n/g, '<br/>')
  const section = (title: string, value: string) => `<h1>${text(title)}</h1><p>${text(value) || '—'}</p>`
  return `<title>${text(view.title)} · 工单报告</title>\n<p><b>${text(view.outcome)}</b></p>\n`
    + section('工单信息', `工单：${view.id}\n创建：${view.createdAt}\n结束：${view.endedAt}\n结束者：${view.endedBy}`)
    + section('原始需求', view.request) + section('结果与验证记录', view.summary)
    + section('结束原因', view.reason) + section('执行环境', view.execution)
    + section('执行轨迹', view.assignments.map((item, i) => `${i + 1}. ${item.state} · ${item.at}\n${item.summary}`).join('\n\n'))
    + section('关联来源', view.channels.map(item => `${item.source} · ${item.thread}`).join('\n'))
    + '<p>内容来自工单记录；未执行或未完成的检查仍为未验证，交付不等于已发布或已通过回归。请勿对外转发内部信息。</p>\n'
}

/** The cloud document's address from `docs +create` (`data.document.url` in lark-cli 1.0.98). */
export function documentUrl(data: unknown): string {
  const document = (data as { document?: { url?: unknown; document_id?: unknown } } | null)?.document
  if (typeof document?.url === 'string' && /^https?:\/\//.test(document.url)) return document.url
  const id = typeof document?.document_id === 'string' ? document.document_id : ''
  return id ? `https://feishu.cn/docx/${id}` : ''
}

/** The short IM notice: a person clicks through to the cloud document; no HTML file is attached. */
export function reportNoticeText(view: TicketReportView, url: string): string {
  const title = view.title.length > NOTICE_TITLE_CHARS ? `${view.title.slice(0, NOTICE_TITLE_CHARS)}…` : view.title
  return `【工单报告】「${title}」${view.outcome}\n${url}`
}

/** Feishu channels that carry the message id needed to reply in the original topic. */
function feishuTargets(ticket: Ticket): ChannelRef[] {
  return (ticket.channels ?? []).filter(channel => channel.source === 'feishu'
    && typeof channel.address.messageId === 'string' && channel.address.messageId.length > 0)
}

/** Cached address of the cloud document created for one ticket ending. */
interface ReportDocument { ticketId: string; at: string; url: string; documentId: string }

export interface TicketReportsHost {
  readonly store: Pick<Store, 'tickets' | 'triggers'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'pending'>
  readonly commands: Commands
  readonly stateDir: string
  /** Automatic delivery is off unless a person enabled it; a manual send bypasses this. */
  enabled(): boolean
  /** Document creation is independent of IM notification and applies to every ended ticket. */
  documentsEnabled?(): boolean
  warn(message: string): void
}

/** Generates, stores and sends ticket reports; one durable effect per ticket ending. */
export class TicketReports {
  private readonly creating = new Map<string, Promise<ReportDocument>>()
  constructor(private readonly host: TicketReportsHost) {
    host.effects.handle(REPORT_EFFECT, (payload: { ticketId: string; at: string }, key) => this.deliver(payload, key),
      { retry: [5000, 300_000] })
    host.effects.handle('reportLocal', payload => this.generate(payload), { retry: [5000, 300_000] })
    host.effects.handle(CLOUD_REPORT_EFFECT, (payload: ReportPayload) => this.createCloud(payload), { retry: [5000, 300_000] })
  }
  private get directory(): string { return join(this.host.stateDir, REPORT_DIR) }
  private version(ticket: Ticket): string { return ticket.ended?.at ?? latestAssignment(ticket)?.report?.at ?? '' }
  private key(ticket: Ticket): string { return `${ticket.id}:${this.version(ticket)}` }
  /** Local generation is unconditional for a recorded outcome; external sending remains opt-in. */
  queue(ticket: Ticket): boolean {
    if (ticketReportView(ticket, '')) this.host.effects.enqueue('reportLocal', ticket.id, { ticketId: ticket.id, at: this.version(ticket) })
    const cloud = ticket.ended && this.host.documentsEnabled?.() ? this.queueDocument(ticket) : false
    const notify = this.host.enabled() ? this.enqueue(ticket) : false
    return cloud || notify
  }
  /** A person's explicit request creates a document even for tickets without a Feishu conversation. */
  sendNow(ticket: Ticket): boolean { return feishuTargets(ticket).length ? this.enqueue(ticket) : this.queueDocument(ticket) }
  queueDocument(ticket: Ticket): boolean {
    const view = ticketReportView(ticket, this.host.store.triggers.get(ticket.origin.triggerId)?.text ?? '')
    if (!ticket.ended || !view) return false
    const key = this.key(ticket)
    if (!this.host.effects.pending(CLOUD_REPORT_EFFECT, key)) this.host.effects.enqueue(CLOUD_REPORT_EFFECT, key, {
      ticketId: ticket.id, at: this.version(ticket), view,
    })
    return true
  }
  private enqueue(ticket: Ticket): boolean {
    if (!ticketReportView(ticket, '') || !feishuTargets(ticket).length) return false
    this.host.effects.enqueue(REPORT_EFFECT, this.key(ticket), { ticketId: ticket.id, at: this.version(ticket) })
    return true
  }
  /** The artifact, the cached cloud-document address, and whether a delivery is still waiting. */
  status(ticket: Ticket): { file: string; path?: string; docUrl?: string; queued: boolean; generated: boolean; generationQueued: boolean; cloudState: CloudState; cloudError?: string; deliveryState: 'not-requested' | 'queued' | 'sent' | 'target-gone' | 'partial' } {
    const file = reportFileName(ticket.id)
    const path = join(this.directory, this.snapshotFile(ticket.id, this.version(ticket)))
    const cache = path.replace(/\.html$/, '.doc.json')
    let docUrl: string | undefined
    if (existsSync(cache)) {
      try {
        const saved = JSON.parse(readFileSync(cache, 'utf8')) as ReportDocument
        if (saved.ticketId === ticket.id && saved.at === this.version(ticket) && typeof saved.url === 'string') docUrl = saved.url
      } catch (error) { this.host.warn(`report ${file}: unreadable document cache: ${String(error)}`) }
    }
    const queued = this.host.effects.pending(REPORT_EFFECT, this.key(ticket))
    let deliveryState: 'sent' | 'target-gone' | 'partial' | undefined
    const receipt = path.replace(/\.html$/, '.delivery.json')
    try {
      const saved = JSON.parse(readFileSync(receipt, 'utf8')) as { at?: string; state?: typeof deliveryState }
      if (saved.at === this.version(ticket) && ['sent', 'target-gone', 'partial'].includes(saved.state ?? '')) deliveryState = saved.state
    } catch { /* No verified receipt. */ }
    const cloudQueued = this.host.effects.pending(CLOUD_REPORT_EFFECT, this.key(ticket))
    let creation: CreationRecord | undefined
    try { creation = JSON.parse(readFileSync(path.replace(/\.html$/, '.creation.json'), 'utf8')) } catch { /* No creation record. */ }
    const uncertain = creation?.state === 'creation-uncertain' || creation?.state === 'creating' && !this.creating.has(this.key(ticket))
    const cloudState: CloudState = docUrl ? 'created' : uncertain ? 'creation-uncertain' : creation?.state === 'failed' ? 'failed' : cloudQueued ? 'queued' : 'not-requested'
    return { file, cloudState, ...(!docUrl && creation?.error ? { cloudError: creation.error } : {}), ...existsSync(path) ? { path } : {}, ...docUrl ? { docUrl } : {}, generated: existsSync(path),
      generationQueued: this.host.effects.pending('reportLocal', ticket.id), queued,
      deliveryState: queued ? 'queued' : deliveryState ?? 'not-requested' }
  }
  /** Reads only the generated artifact for this ticket; never generates or sends on GET. */
  async content(ticket: Ticket): Promise<{ file: string; html: string }> {
    const file = reportFileName(ticket.id)
    const html = await readFile(join(this.directory, this.snapshotFile(ticket.id, this.version(ticket))), 'utf8')
    if (Buffer.byteLength(html, 'utf8') > 2_000_000) throw new Error('Report exceeds download limit; use the local artifact')
    return { file, html }
  }
  private async writeAtomically(directory: string, name: string, content: string): Promise<void> {
    // A temporary file plus rename keeps a partially written artifact from being uploaded by a concurrent send.
    const temporary = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, join(directory, name))
  }
  private async cachedDoc(cacheFile: string): Promise<ReportDocument | undefined> {
    const path = join(this.directory, cacheFile)
    if (!existsSync(path)) return undefined
    const doc = await readFile(path, 'utf8').then(text => JSON.parse(text) as ReportDocument, () => undefined)
    return doc && typeof doc.url === 'string' && /^https?:\/\//.test(doc.url) ? doc : undefined
  }
  private snapshotFile(id: string, at: string): string {
    return reportFileName(id).replace(/\.html$/, `-${createHash('sha256').update(at).digest('hex').slice(0, 12)}.html`)
  }
  private current(payload: { ticketId: string; at: string }): boolean {
    const ticket = this.host.store.tickets.get(payload.ticketId)
    return !!ticket && this.version(ticket) === payload.at
  }
  private async generate(payload: { ticketId: string; at: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(payload.ticketId)
    if (!ticket || this.version(ticket) !== payload.at) return
    const view = ticketReportView(ticket, this.host.store.triggers.get(ticket.origin.triggerId)?.text ?? '')
    if (!view) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const html = renderTicketReport(view)
    await this.writeAtomically(this.directory, this.snapshotFile(ticket.id, payload.at), html)
    if (this.current(payload)) await this.writeAtomically(this.directory, reportFileName(ticket.id), html)
  }
  private async createCloud(payload: ReportPayload): Promise<void> {
    const ticket = this.host.store.tickets.get(payload.ticketId)
    const view = payload.view ?? (ticket && this.current(payload) ? ticketReportView(ticket, this.host.store.triggers.get(ticket.origin.triggerId)?.text ?? '') : undefined)
    if (!view || view.id !== payload.ticketId || view.endedAt !== payload.at) return
    await this.ensureDocument(payload, view)
  }
  private ensureDocument(payload: ReportPayload, view: TicketReportView): Promise<ReportDocument> {
    const key = `${payload.ticketId}:${payload.at}`, existing = this.creating.get(key)
    if (existing) return existing
    const creating = this.createDocument(payload, view).finally(() => { if (this.creating.get(key) === creating) this.creating.delete(key) })
    this.creating.set(key, creating)
    return creating
  }
  private async createDocument(payload: ReportPayload, view: TicketReportView): Promise<ReportDocument> {
    const file = this.snapshotFile(payload.ticketId, payload.at), directory = this.directory
    const cacheFile = file.replace(/\.html$/, '.doc.json'), intentFile = file.replace(/\.html$/, '.creation.json')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const cached = await this.cachedDoc(cacheFile)
    if (cached?.ticketId === payload.ticketId && cached.at === payload.at) return cached
    let previous: CreationRecord | undefined
    if (existsSync(join(directory, intentFile))) previous = JSON.parse(await readFile(join(directory, intentFile), 'utf8'))
    if (previous && previous.state !== 'failed') throw new Error('飞书文档创建结果待确认；请查回已有文档，未自动重复创建')
    const html = renderTicketReport(view)
    await this.writeAtomically(directory, file, html)
    if (this.current(payload)) await this.writeAtomically(directory, reportFileName(payload.ticketId), html)
    const xmlFile = file.replace(/\.html$/, '.doc.xml')
    await this.writeAtomically(directory, xmlFile, renderTicketDocXml(view))
    const intent: CreationRecord = { ticketId: payload.ticketId, at: payload.at, state: 'creating' }
    await this.writeAtomically(directory, intentFile, JSON.stringify(intent))
    try {
      const created = await this.host.commands.lark<{ document?: { url?: unknown; document_id?: unknown } }>(
        ['docs', '+create', '--title', view.title.replace(/[\r\n\t]/g, ' ').slice(0, 200), '--doc-format', 'xml', '--content', `@./${xmlFile}`], directory)
      const url = documentUrl(created)
      if (!url) throw new Error('Feishu returned no document address')
      const doc: ReportDocument = { ticketId: payload.ticketId, at: payload.at, url,
        documentId: typeof created.document?.document_id === 'string' ? created.document.document_id : '' }
      await this.writeAtomically(directory, cacheFile, JSON.stringify(doc))
      await this.writeAtomically(directory, intentFile, JSON.stringify({ ...intent, state: 'created' }))
      return doc
    } catch (error) {
      const localFailure = /The Feishu Source has no working bot CLI/.test(String(error))
      const message = localFailure ? '飞书机器人CLI未配置，报告保留待重试；不影响下一条任务' : '文档创建响应未确认；请核对飞书权限及已创建文档，不会自动重复创建'
      await this.writeAtomically(directory, intentFile, JSON.stringify({ ...intent, state: localFailure ? 'failed' : 'creation-uncertain', error: message }))
      throw new Error(message, { cause: error })
    }
  }
  private async deliver(payload: { ticketId: string; at: string }, key: string): Promise<void> {
    const { store, commands, warn } = this.host
    const ticket = store.tickets.get(payload.ticketId)
    if (!ticket || this.version(ticket) !== payload.at) return
    const targets = feishuTargets(ticket)
    if (!targets.length) return
    const view = ticketReportView(ticket, store.triggers.get(ticket.origin.triggerId)?.text ?? '')
    if (!view) return
    const directory = this.directory
    const file = this.snapshotFile(ticket.id, payload.at)
    if (!this.current(payload)) return
    const doc = await this.ensureDocument(payload, view)
    const text = reportNoticeText(view, doc.url)
    let sent = 0, gone = 0
    for (const channel of targets) {
      if (!this.current(payload)) return
      const messageId = channel.address.messageId
      if (!messageId) continue
      try {
        await commands.lark(['im', '+messages-reply', '--message-id', messageId, '--markdown', text,
          '--reply-in-thread', '--idempotency-key', idempotencyKey(`${key}:${channel.thread}`)])
        sent++
      } catch (error) {
        // A recalled or deleted target can never receive the notice; retrying forever only hides the fact.
        if (/230011|withdrawn|not found/i.test(String(error))) { gone++; warn(`report ${file}: Feishu message ${messageId} is gone`); continue }
        throw error
      }
    }
    await this.writeAtomically(directory, file.replace(/\.html$/, '.delivery.json'), JSON.stringify({ at: payload.at,
      state: gone ? sent ? 'partial' : 'target-gone' : 'sent' }))
  }
}
