/**
 * VsSaros addition: the supervisor desk as the panel's Chat tab. The conversation is the desk's Thread
 * (`superagent:desk:<deskId>`): a person's messages are its Triggers, whether typed in the panel or in the desk Session,
 * and SuperAgent's replies are logged as they are delivered to the desk. A message sent from the panel is a desk Trigger
 * like one the desk Session hands over, so it goes through the same gate, Eval and tickets, and can agree to a team.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { threadKey, type OutboundMessage, type Reason, type ReceiveResult, type Trigger } from '../core/index.ts'
import { deskTrigger, SUPERAGENT_SOURCE } from '../sources/superagent.ts'
import type { Store } from './store.ts'

export const DESK_MESSAGE_CHARS = 20_000
/** One message of the desk conversation, oldest first. */
export interface DeskMessage {
  id: string; role: 'person' | 'superagent'; text: string; at: string
  /** A person's message the gate did not admit, and why. */
  filtered?: Reason
  ticketId?: string; kind?: OutboundMessage['kind']
  /** ★ 2026-11-10: read-only projection of an IM source message (Feishu) into the Chat bubbles.
      It never lives in the desk Thread; `chatId` only labels where the message came from. */
  source?: 'feishu'
  chatId?: string
}

export interface DeskChatHost {
  store: Pick<Store, 'db' | 'triggers'>
  deskId: string
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  /** Records a panel message in the desk Session too, without waking it; best effort. */
  echo?(requestId: string, text: string): Promise<void>
  /** Where attached files are kept, in the state directory. */
  filesDir?: string
  warn?(message: string): void
}

/** The desk conversation: its messages, a person's message sent from the panel, its attachments and scheduled messages. */
export class DeskChat {
  constructor(private readonly host: DeskChatHost) {
    host.store.db.exec('CREATE TABLE IF NOT EXISTS desk_log (id TEXT PRIMARY KEY, at TEXT NOT NULL, value TEXT NOT NULL)')
    host.store.db.exec('CREATE TABLE IF NOT EXISTS desk_schedule (id TEXT PRIMARY KEY, at TEXT NOT NULL, value TEXT NOT NULL)')
  }
  get thread(): string { return threadKey({ source: SUPERAGENT_SOURCE, id: `desk:${this.host.deskId}` }) }

  /** Records a reply SuperAgent delivers to the desk; recording the same message again changes nothing. */
  logReply(message: OutboundMessage, at = new Date().toISOString()): void {
    const entry: DeskMessage = { id: message.id, role: 'superagent', text: message.text, at, kind: message.kind,
      ...message.ticketId ? { ticketId: message.ticketId } : {} }
    this.host.store.db.prepare('INSERT OR IGNORE INTO desk_log VALUES (?,?,?)').run(entry.id, entry.at, JSON.stringify(entry))
  }
  /** The last `limit` messages of the conversation, oldest first. */
  messages(limit = 100): DeskMessage[] {
    const { db } = this.host.store
    const people = db.prepare(`SELECT t.value FROM trigger_thread tt JOIN trigger t ON t.id = tt.id WHERE tt.thread = ?
      ORDER BY tt.at DESC LIMIT ?`).all(this.thread, limit).map(row => {
      const trigger = JSON.parse(String(row.value)) as Trigger
      const filtered = this.host.store.triggers.disposition(trigger.id)?.filtered
      return { id: trigger.id, role: 'person' as const, text: trigger.text, at: trigger.at, ...filtered ? { filtered } : {} }
    })
    const replies = db.prepare('SELECT value FROM desk_log ORDER BY at DESC LIMIT ?').all(limit)
      .map(row => JSON.parse(String(row.value)) as DeskMessage)
    /* ★ 2026-11-10: show Feishu source text directly in the Chat bubbles (read-only projection).
       Feishu Triggers live in `feishu:<chatId>:<rootId>` Threads; the Chat tab used to read only the desk Thread.
       We map `source:'feishu'` Triggers to person messages at read time: no trigger_thread / desk_log writes,
       no Intake, no Eval kick ⇒ the supervisor is NOT woken and no reply loop can form. Display-only
       Triggers are stored by Intake's filtered branch (`intake.ts:58`), so the text stays visible;
       the filtered reason is deliberately NOT projected — display-only is the product, not a rejection. */
    const feishu = db.prepare(`SELECT value FROM trigger WHERE json_extract(value,'$.source') = 'feishu'
      ORDER BY at DESC LIMIT ?`).all(limit).map(row => {
      const trigger = JSON.parse(String(row.value)) as Trigger & { meta?: { chatId?: string } }
      return { id: trigger.id, role: 'person' as const, text: trigger.text, at: trigger.at,
        source: 'feishu' as const, ...(trigger.meta?.chatId ? { chatId: trigger.meta.chatId } : {}) }
    })
    const seen = new Set<string>()
    return [...people, ...feishu, ...replies]
      .filter(message => { if (seen.has(message.id)) return false; seen.add(message.id); return true })
      .sort((a, b) => a.at.localeCompare(b.at) || (a.role === 'person' ? -1 : 1)).slice(-limit)
  }
  /** A person's message from the panel, as a desk Trigger. */
  async send(text: string): Promise<{ id: string; result: ReceiveResult }> {
    const body = text.trim()
    if (!body) throw new Error('The message is empty')
    if (body.length > DESK_MESSAGE_CHARS) throw new Error(`A message has at most ${DESK_MESSAGE_CHARS} characters`)
    const messageId = `panel-${randomUUID()}`
    const trigger = deskTrigger({ session: this.host.deskId, messageId, text: body, at: new Date().toISOString() })
    const result = await this.host.receive(trigger)
    await this.host.echo?.(`desk-panel:${messageId}`, `[本机用户 · 面板] ${body}`).catch(() => undefined)
    return { id: trigger.id, result }
  }

  // Attachments: a file the person adds in the composer is kept in the state directory, and the message names its path.

  /** Keeps a file the person attached; its path goes into the message, where the supervisor and the workers read it. */
  attach(name: string, data: Buffer): DeskFile {
    if (!this.host.filesDir) throw new Error('This desk keeps no files')
    if (data.length > DESK_FILE_BYTES) throw new Error(`A file has at most ${DESK_FILE_BYTES / 1024 / 1024} MB`)
    const safe = basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file'
    const dir = join(this.host.filesDir, `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, safe)
    writeFileSync(path, data)
    return { name: safe, path, size: data.length }
  }

  // Scheduled tasks: a message the person asks to send later, once or on every day or working day at that time.

  /** The scheduled messages, soonest first. */
  schedules(): DeskSchedule[] {
    return this.host.store.db.prepare('SELECT value FROM desk_schedule ORDER BY at').all()
      .map(row => JSON.parse(String(row.value)) as DeskSchedule)
  }
  /** Schedules a message. @throws Error when the text is empty or too long, or the time is not a time. */
  schedule(input: { text: string; at: string; repeat: DeskSchedule['repeat'] }, now = new Date()): DeskSchedule {
    const text = input.text.trim()
    if (!text) throw new Error('The message is empty')
    if (text.length > DESK_MESSAGE_CHARS) throw new Error(`A message has at most ${DESK_MESSAGE_CHARS} characters`)
    const first = new Date(input.at)
    if (Number.isNaN(first.getTime())) throw new Error('The time is not a time')
    if (input.repeat === 'none' && first.getTime() < now.getTime() - 60_000) throw new Error('The time has passed')
    const at = input.repeat === 'none' ? first : nextRun(first, input.repeat, now, true)
    const entry: DeskSchedule = { id: `sched-${randomUUID().slice(0, 8)}`, text, at: at.toISOString(), repeat: input.repeat, createdAt: now.toISOString() }
    this.saveSchedule(entry)
    return entry
  }
  unschedule(id: string): void { this.host.store.db.prepare('DELETE FROM desk_schedule WHERE id=?').run(id) }
  /** Sends every scheduled message that is due, and moves a repeating one to its next time. */
  async runDue(now = new Date()): Promise<number> {
    let sent = 0
    for (const entry of this.schedules()) {
      if (new Date(entry.at).getTime() > now.getTime()) break
      // Moved (or removed) before it is sent, so a failure or a restart never sends it twice.
      if (entry.repeat === 'none') this.unschedule(entry.id)
      else this.saveSchedule({ ...entry, at: nextRun(new Date(entry.at), entry.repeat, now, false).toISOString() })
      try { await this.send(`[定时任务] ${entry.text}`); sent += 1 } catch (failure) { this.host.warn?.(`scheduled message ${entry.id}: ${(failure as Error).message}`) }
    }
    return sent
  }
  /** Checks for due scheduled messages every half minute. */
  install(): () => void {
    const timer = setInterval(() => { void this.runDue() }, 30_000)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }
  private saveSchedule(entry: DeskSchedule): void {
    this.host.store.db.prepare('INSERT OR REPLACE INTO desk_schedule VALUES (?,?,?)').run(entry.id, entry.at, JSON.stringify(entry))
  }
}

export const DESK_FILE_BYTES = 10 * 1024 * 1024
/** A file the person attached to a message. */
export interface DeskFile { name: string; path: string; size: number }
/** A message the person scheduled. */
export interface DeskSchedule { id: string; text: string; at: string; repeat: 'none' | 'daily' | 'weekdays'; createdAt: string }

/** The next time a repeating message runs after `now`, at the same local time of day; `from` itself counts when `inclusive`. */
export function nextRun(from: Date, repeat: 'daily' | 'weekdays', now: Date, inclusive: boolean): Date {
  const next = new Date(from)
  const fits = (date: Date) => repeat === 'daily' || (date.getDay() !== 0 && date.getDay() !== 6)
  const ahead = (date: Date) => inclusive ? date.getTime() >= now.getTime() - 60_000 : date.getTime() > now.getTime()
  if (!inclusive) next.setDate(next.getDate() + 1)
  for (let guard = 0; guard < 4000 && !(ahead(next) && fits(next)); guard += 1) next.setDate(next.getDate() + 1)
  return next
}
