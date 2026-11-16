/** Ticket HTML reports: escaping, cloud-document creation, and the address-only Feishu notice. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { REPORT_DIR, documentUrl, escapeHtml, renderTicketReport, reportDocXml, reportFileName,
  reportNoticeText, ticketReportView } from '../src/app/ticket-report.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const DOC_URL = 'https://example.feishu.cn/docx/doc1'

const ticket = (overrides: Record<string, unknown> = {}): Ticket => JSON.parse(JSON.stringify({
  id: 't1', title: '修复按钮', decisionId: 'd1', mandate: {},
  channels: [{ source: 'feishu', thread: 'feishu:oc_1:om_1', address: { chatId: 'oc_1', messageId: 'om_1' } }],
  ended: { at: '2026-11-13T10:00:00.000Z', by: 'executor', outcome: 'completed' },
  assignments: [{ id: 'a1', state: 'done', createdAt: '2026-11-13T09:00:00.000Z',
    report: { state: 'ready', summary: '按钮已改好', at: '2026-11-13T09:59:00.000Z' } }],
  inputs: [], undelivered: [], createdAt: '2026-11-13T09:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z',
  origin: { triggerId: 'tr1', triggerIds: ['tr1'] },
  execution: { name: 'widget', directory: '/work/widget' },
  ...overrides,
})) as Ticket

const hosts: Host[] = []
afterEach(async () => { for (const host of hosts) await host.stop(); hosts.length = 0; vi.restoreAllMocks() })

/** Seeds one ended ticket into the real SQLite store so the effect can read it back. */
const runtimeWithTicket = async (record = ticket()) => {
  const host = await startRuntime(store => {
    store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(record.id, JSON.stringify(record))
  })
  hosts.push(host)
  host.runtime.effects.start()
  return host
}

/** `docs +create` returns a cloud-document address; every other lark call succeeds quietly. */
const withDocument = () => vi.mocked(Commands.prototype.lark).mockImplementation(async (args: string[]) =>
  args[1] === '+create' ? { document: { url: DOC_URL, document_id: 'doc1' } } : {})

describe('renderTicketReport', () => {
  it('escapes every untrusted field and stays self-contained', () => {
    const html = renderTicketReport(ticketReportView(ticket({ title: '<script>alert(1)</script> & "x"',
      channels: [{ source: 'feishu', thread: '<img src=x>', address: { messageId: 'om_1' } }] }), '需求 <b>加粗</b>')!)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;b&gt;加粗&lt;/b&gt;')
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).toContain('按钮已改好')
    expect(html).toContain('已完成')
  })

  it('escapes quotes and apostrophes, and has no view for an open ticket', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    expect(ticketReportView(ticket({ ended: undefined, assignments: [] }), '需求')).toBeUndefined()
    expect(ticketReportView(ticket({ ended: undefined }), '需求')?.outcome).toBe('等待交付审核')
    expect(reportFileName('t1')).toBe('report-t1.html')
    expect(reportFileName('../evil/../../x')).toBe('report-evilx.html')
  })

  it('never imports the 100-word reply validator or the outbox, and sends no file attachment', () => {
    const source = readFileSync(new URL('../src/app/ticket-report.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('checkedImText')
    expect(source).not.toContain("from './outbox.ts'")
    expect(source).toContain("'+create'")
    expect(source).not.toContain("'--file'")
  })
})

describe('cloud document delivery', () => {
  it('builds a Preview file block, reads the address, and keeps the notice short', () => {
    expect(reportDocXml('report-t1.html')).toContain('<figure view-type="Preview"><source path="@./report-t1.html"')
    expect(documentUrl({ document: { url: DOC_URL } })).toBe(DOC_URL)
    expect(documentUrl({ document: { document_id: 'doc1' } })).toBe('https://feishu.cn/docx/doc1')
    expect(documentUrl({ document: { url: 'javascript:alert(1)' } })).toBe('')
    expect(documentUrl({})).toBe('')
    const notice = reportNoticeText(ticketReportView(ticket({ title: '标'.repeat(120) }), '需求')!, DOC_URL)
    expect(notice).toContain(DOC_URL)
    expect(notice).toContain('…')
    expect(notice.length).toBeLessThan(200)
  })
})

describe('TicketReports', () => {
  it('stays off by default, and a person\'s explicit send bypasses the switch', async () => {
    const h = await runtimeWithTicket()
    const record = ticket()
    expect(h.runtime.reports.queue(record)).toBe(false)
    expect(h.runtime.effects.pending('ticketReport')).toBe(false)
    expect(h.runtime.reports.sendNow(record)).toBe(true)
    expect(h.runtime.effects.pending('ticketReport', 't1:2026-11-13T10:00:00.000Z')).toBe(true)
  })

  it('queues on ticket end only when the switch is on, and only for Feishu threads with a message id', async () => {
    const h = await runtimeWithTicket()
    vi.spyOn(h.runtime.store, 'settings').mockReturnValue({ ...h.runtime.store.settings(),
      executor: { ...h.runtime.store.settings().executor, feishuReport: true } })
    expect(h.runtime.reports.queue(ticket())).toBe(true)
    expect(h.runtime.reports.queue(ticket({ channels: [] }))).toBe(false)
    expect(h.runtime.reports.queue(ticket({ channels: [{ source: 'feishu', thread: 'x', address: {} }] }))).toBe(false)
    expect(h.runtime.reports.queue(ticket({ ended: undefined, assignments: [] }))).toBe(false)
  })

  it('creates one cloud document and sends only its address to the original Feishu topic', async () => {
    const h = await runtimeWithTicket()
    const lark = withDocument()
    expect(h.runtime.reports.sendNow(ticket())).toBe(true)
    await h.runtime.effects.idle('ticketReport')
    const dir = join(h.directory, REPORT_DIR)
    expect(readFileSync(join(dir, 'report-t1.html'), 'utf8')).toContain('修复按钮')
    const snapshot = h.runtime.reports.status(ticket()).path!
    expect(readFileSync(snapshot.replace(/\.html$/, '.doc.xml'), 'utf8')).toContain('<figure view-type="Preview">')
    const created = lark.mock.calls.filter(call => call[0]?.[1] === '+create')
    expect(created).toHaveLength(1)
    expect(created[0]![0]).toEqual(['docs', '+create', '--title', '修复按钮', '--doc-format', 'xml',
      '--content', expect.stringMatching(/^@\.\/report-t1-[0-9a-f]{12}\.doc\.xml$/)])
    expect(created[0]![1]).toBe(dir)
    const replies = lark.mock.calls.filter(call => call[0]?.[1] === '+messages-reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]![0]).toEqual(['im', '+messages-reply', '--message-id', 'om_1', '--markdown',
      expect.stringContaining(DOC_URL), '--reply-in-thread', '--idempotency-key', expect.stringMatching(/^sa-[0-9a-f]{30}$/)])
    expect(replies[0]![0]).not.toContain('--file')
    expect(h.runtime.reports.status(ticket()).docUrl).toBe(DOC_URL)
  })

  it('reuses the cached document on a retry, so no second cloud document appears', async () => {
    const h = await runtimeWithTicket()
    const lark = withDocument()
    h.runtime.reports.sendNow(ticket())
    await h.runtime.effects.idle('ticketReport')
    h.runtime.reports.sendNow(ticket())
    await h.runtime.effects.idle('ticketReport')
    expect(lark.mock.calls.filter(call => call[0]?.[1] === '+create')).toHaveLength(1)
    const replies = lark.mock.calls.filter(call => call[0]?.[1] === '+messages-reply')
    expect(replies).toHaveLength(2)
    expect(replies[1]![0]).toEqual(replies[0]![0])
  })

  it('sends nothing when the document has no address, and skips a target message that is gone', async () => {
    const h = await runtimeWithTicket()
    const lark = vi.mocked(Commands.prototype.lark).mockImplementation(async () => ({}))
    h.runtime.reports.sendNow(ticket())
    await expect(h.runtime.effects.idle('ticketReport')).resolves.toBeUndefined()
    expect(lark.mock.calls.filter(call => call[0]?.[1] === '+messages-reply')).toHaveLength(0)
    expect(h.runtime.reports.status(ticket()).docUrl).toBeUndefined()

    const second = await runtimeWithTicket()
    vi.mocked(Commands.prototype.lark).mockImplementation(async (args: string[]) => {
      if (args[1] === '+create') return { document: { url: DOC_URL, document_id: 'doc1' } }
      throw new Error('Feishu 230011: message not found')
    })
    second.runtime.reports.sendNow(ticket())
    await expect(second.runtime.effects.idle('ticketReport')).resolves.toBeUndefined()
    expect(second.runtime.effects.pending('ticketReport')).toBe(false)
  })

  it.each(['blocked', 'failed', 'ready'])('generates an open %s report locally with external delivery disabled and no ticket mutation', async state => {
    const record = ticket({ ended: undefined, channels: [], assignments: [{ id: 'a1', state: 'running', createdAt: '2026-11-13T09:00:00Z',
      report: { state, summary: 'P4 source unavailable', at: '2026-11-13T10:00:00Z' } }] })
    const h = await runtimeWithTicket(record), lark = withDocument()
    const before = h.runtime.store.tickets.get('t1')
    expect(h.runtime.reports.queue(record)).toBe(false)
    await h.runtime.effects.idle('reportLocal')
    const status = h.runtime.reports.status(record)
    expect(status).toMatchObject({ generated: true, queued: false, deliveryState: 'not-requested' })
    const content = await h.runtime.reports.content(record)
    expect(content.html).toContain('P4 source unavailable')
    expect(lark.mock.calls.filter(([args]) => args[1] === '+create' || args[1] === '+messages-reply')).toEqual([])
    expect(h.runtime.store.tickets.get('t1')).toEqual(before)
    const response = await h.api('GET', 'tickets/t1/report/content')
    expect(response.status).toBe(200)
    expect(lark.mock.calls.filter(([args]) => args[1] === '+create' || args[1] === '+messages-reply')).toEqual([])
  })

  it('does not infer delivered status from a created document when message delivery failed', async () => {
    const h = await runtimeWithTicket()
    vi.mocked(Commands.prototype.lark).mockImplementation(async args => {
      if (args[1] === '+create') return { document: { url: DOC_URL, document_id: 'doc1' } }
      throw new Error('network unavailable')
    })
    h.runtime.reports.sendNow(ticket())
    await h.runtime.effects.idle('ticketReport')
    expect(h.runtime.reports.status(ticket())).toMatchObject({ generated: true, docUrl: DOC_URL, queued: true, deliveryState: 'queued' })
  })

  it('keeps upload snapshots immutable and does not send stale results after a report changes', async () => {
    const h = await runtimeWithTicket(), record = ticket()
    const changed = ticket({ ended: { at: '2026-11-14T01:00:00Z', by: 'executor', outcome: 'completed' } })
    changed.assignments[0]!.report!.summary = 'new result'
    const lark = vi.mocked(Commands.prototype.lark).mockImplementation(async (args, cwd) => {
      if (args[1] !== '+create') return {}
      const xml = readFileSync(join(cwd!, args.at(-1)!.slice(3)), 'utf8')
      const uploadFile = /path="@\.\/(.*?)"/.exec(xml)![1]!
      h.runtime.store.tickets.save(changed)
      h.runtime.reports.queue(changed)
      await h.runtime.effects.idle('reportLocal')
      expect(readFileSync(join(cwd!, uploadFile), 'utf8')).toContain('按钮已改好')
      expect(h.runtime.reports.status(changed).docUrl).toBeUndefined()
      return { document: { url: DOC_URL, document_id: 'doc1' } }
    })
    h.runtime.reports.sendNow(record)
    await h.runtime.effects.idle('ticketReport')
    expect(lark.mock.calls.filter(([args]) => args[1] === '+messages-reply')).toEqual([])
    expect(h.runtime.reports.status(changed)).toMatchObject({ generated: true, deliveryState: 'not-requested' })
    expect(h.runtime.reports.status(changed).docUrl).toBeUndefined()
    expect((await h.runtime.reports.content(changed)).html).toContain('new result')
  })

  it('queues nothing when the ticket has no Feishu conversation', async () => {
    const h = await runtimeWithTicket(ticket({ channels: [{ source: 'github', thread: '42', address: {} }] }))
    const record = h.runtime.store.tickets.get('t1')!
    expect(h.runtime.reports.sendNow(record)).toBe(false)
    expect(h.runtime.effects.pending('ticketReport')).toBe(false)
  })
})
