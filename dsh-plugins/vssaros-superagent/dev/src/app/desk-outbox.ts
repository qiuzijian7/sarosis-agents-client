/**
 * VsSaros addition (2026-11-05): the supervisor's messages to the desk, written down before they are delivered and counted
 * delivered only once the desk Session's conversation has them.
 *
 * Delivering queues a message into the desk Session (`followup`), which DSH keeps in the Session's inbox until a turn takes
 * it; a Session that closes first (a Host restart, a reload) drops its inbox. So the outbox keeps each message `pending`
 * until the desk's `user/message` event with its id says the conversation has it, and delivers what is pending again: on
 * every start, when the desk Session closes, and before each new message, oldest first. Delivery is once per id, so a
 * message still in the inbox, or already in the conversation, is not delivered twice (as DeepSeek-Bot's resend of its
 * queued deliveries does, host/resume.js).
 *
 * Only a message that needs the person's answer wakes the desk, whose model then tells the person: a team proposal, a step's
 * request, the supervisor's question, an answer or a ticket's result. The rest, such as acknowledgements and progress
 * notices, are only logged for the panel's own drawing, the Workbench and the side panel, which spends no model turn.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OutboundMessage } from '../core/index.ts'
import type { Store } from './store.ts'

/**
 * Notices that ask the person for something, or answer what they asked (other notices tell of progress). VsSaros addition
 * (2026-11-06): a desk ticket's end (`ticket-ended:`), which the desk shows as a card without its model (desk.ts).
 */
const ASKING_NOTICES = /^(team-proposal|step-approval|step-approval-which|group-created|group-updated|ticket-ended):/
/**
 * Whether a message to the desk needs the person's answer, and so wakes the desk: every `reply` (an answer, a result, the
 * supervisor's question for the person), a team proposal, a step's request or the question which request a reply meant,
 * and (2026-11-05) the group chat the person asked for.
 */
export function wakesDesk(message: Pick<OutboundMessage, 'id' | 'kind'>): boolean {
  return message.kind === 'reply' || (message.kind === 'notice' && ASKING_NOTICES.test(message.id))
}

/** One message in the desk outbox. */
export interface DeskOutboxEntry {
  id: string; at: string; state: 'pending' | 'recorded'
  /** Delivery attempts that failed, and the last failure. */
  tries: number; error?: string
}

export interface DeskOutboxHost {
  store: Pick<Store, 'db'>
  context: Pick<Context, 'on'>
  deskId: string
  /** Queues the message into the desk Session, once per message; `'gone'` when there is no desk Session. */
  deliver(message: OutboundMessage): Promise<'sent' | 'gone'>
  /** The id of the DSH message delivery writes, which the desk's `user/message` event carries. */
  messageIdOf(message: OutboundMessage): string
  /** Whether the desk Session's conversation has the message (not merely its inbox). */
  recorded(message: OutboundMessage): Promise<boolean>
  closing(): boolean
  warn(message: string): void
}

/** How long after the desk Session closed its messages are delivered again, so a Session being replaced is not raced. */
const AFTER_CLOSE_MS = 1000

/** The supervisor's messages that wake the desk: written down, delivered in order, and kept until the desk has them. */
export class DeskOutbox {
  private running: Promise<void> | undefined
  private again = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly host: DeskOutboxHost) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS desk_outbox (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, state TEXT NOT NULL,
      at TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, error TEXT, value TEXT NOT NULL)`)
  }

  /** Writes a message down as pending, then delivers what is pending; writing the same message again changes nothing. */
  post(message: OutboundMessage, at = new Date().toISOString()): void {
    this.host.store.db.prepare('INSERT OR IGNORE INTO desk_outbox (id, message_id, state, at, value) VALUES (?,?,?,?,?)')
      .run(message.id, this.host.messageIdOf(message), 'pending', at, JSON.stringify(message))
    void this.flush()
  }
  /** One message's entry, if it was posted. */
  entry(id: string): DeskOutboxEntry | undefined {
    const row = this.host.store.db.prepare('SELECT id, state, at, tries, error FROM desk_outbox WHERE id=?').get(id)
    return row ? toEntry(row) : undefined
  }
  /** The messages the desk does not have yet, oldest first. */
  pending(): DeskOutboxEntry[] {
    return this.host.store.db.prepare("SELECT id, state, at, tries, error FROM desk_outbox WHERE state='pending' ORDER BY at, rowid").all().map(toEntry)
  }
  /** The message posted under DSH message id `messageId` (what the desk's conversation names it by), if any. */
  messageOf(messageId: string): OutboundMessage | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM desk_outbox WHERE message_id=?').get(messageId)
    try { return row ? JSON.parse(String(row.value)) as OutboundMessage : undefined } catch { return undefined }
  }
  /** Delivers what is pending, oldest first, one run at a time; a run asked for during one follows it. Never throws. */
  flush(): Promise<void> {
    if (this.running) { this.again = true; return this.running }
    const run = (async () => {
      do {
        this.again = false
        await this.deliverPending()
      } while (this.again && !this.host.closing())
    })()
    this.running = run.finally(() => { this.running = undefined })
    return this.running
  }
  /** Marks messages delivered as the desk's conversation records them, and delivers what is pending now and after the desk closes. */
  install(): () => void {
    const { context, deskId } = this.host
    const offEvent = context.on('session/event', (session, event) => {
      if (session.id !== deskId || event.type !== 'user/message') return
      const id = (event.data as { id?: unknown } | undefined)?.id
      if (typeof id === 'string') this.host.store.db.prepare("UPDATE desk_outbox SET state='recorded', error=NULL WHERE message_id=? AND state='pending'").run(id)
    })
    const offDisposed = context.on('agent/disposed', ({ agent }) => {
      if (agent.id !== deskId || this.host.closing() || !this.pending().length) return
      clearTimeout(this.timer)
      this.timer = setTimeout(() => { if (!this.host.closing()) void this.flush() }, AFTER_CLOSE_MS)
      this.timer.unref?.()
    })
    void this.flush()
    return () => { offEvent(); offDisposed(); clearTimeout(this.timer) }
  }

  private async deliverPending(): Promise<void> {
    const { db } = this.host.store
    const rows = db.prepare("SELECT id, value FROM desk_outbox WHERE state='pending' ORDER BY at, rowid").all()
    for (const row of rows) {
      if (this.host.closing()) return
      const id = String(row.id), message = JSON.parse(String(row.value)) as OutboundMessage
      try {
        // Delivered before a restart and taken into a turn since: the conversation has it.
        if (await this.host.recorded(message)) { this.mark(id); continue }
        if (await this.host.deliver(message) === 'gone') { this.failed(id, 'the desk Session does not exist'); return }
        if (await this.host.recorded(message)) this.mark(id)
      } catch (error) {
        this.failed(id, String(error))
        // A later message would overtake this one; the next flush tries from here again.
        return
      }
    }
  }
  private mark(id: string): void {
    this.host.store.db.prepare("UPDATE desk_outbox SET state='recorded', error=NULL WHERE id=?").run(id)
  }
  private failed(id: string, error: string): void {
    this.host.store.db.prepare('UPDATE desk_outbox SET tries=tries+1, error=? WHERE id=?').run(error.slice(0, 500), id)
    this.host.warn(`a supervisor message to the desk is not delivered yet (${id}): ${error}`)
  }
}

function toEntry(row: Record<string, unknown>): DeskOutboxEntry {
  return { id: String(row.id), at: String(row.at), state: row.state === 'recorded' ? 'recorded' : 'pending', tries: Number(row.tries),
    ...row.error ? { error: String(row.error) } : {} }
}
