/**
 * VsSaros addition: the review gate in front of every P4 submit. An Executor shelves a ticket's CL and reports it ready;
 * a person reads its differences in the panel and approves the exact content they read (its fingerprint), and only then
 * does dsh-superagent submit it, or hand it to the server's own submit automation. Nothing here is an agent tool: the
 * panel's management routes are the only callers (see `tests/review.spec.ts`).
 */
import { userInfo } from 'node:os'
import { liveTicket, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from '../sources/host.ts'
import { changesOf, fingerprint, inPath, P4_SOURCE, p4, p4Messages, readChange, shelfDiffs, type Change, type ChangeFile, type FileDiff, type P4Config }
  from '../sources/p4-change.ts'
import type { Store } from './store.ts'

export type ReviewState = 'waiting' | 'submitting' | 'handed' | 'submitted' | 'rejected' | 'discarded' | 'failed'
export interface Review {
  ticketId: string
  change: number
  /** Fingerprint of the shelf the Executor asked to be reviewed; an approval names the one its person read. */
  fingerprint: string
  files: ChangeFile[]
  description: string
  client: string
  state: ReviewState
  requestedAt: string
  decidedAt?: string
  /** Who approved, rejected or discarded it. */
  by?: string
  comment?: string
  error?: string
  /** The submitted CL number, once submitted. */
  submittedAs?: number
}
export type AuditAction = 'requested' | 'approved' | 'refused' | 'rejected' | 'discarded' | 'handed' | 'submitted' | 'failed'
export interface AuditEntry { at: string; action: AuditAction; ticketId: string; change: number; fingerprint: string; by?: string; detail?: string }
const AUDIT_LIMIT = 500

export interface ReviewHost {
  readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'tickets'>
  readonly engine: Pick<EngineForPeople, 'stopTicket'> & { note(ticketId: string, text: string): Ticket }
  /** The p4 Source's context, whose commands and thread rules the reviews use. */
  readonly p4: SourceContext
  /** The person acting in the panel; the Host's OS account, as the panel is reachable only from this machine. */
  readonly person?: () => string
  /** Delivers the inputs a ticket kept while its review held it (`DshExecutor.release`). */
  readonly release?: (ticketId: string) => void
}
/** A person's review decision that the CL as it is now cannot take; the panel shows `message` and the changed files. */
export class ReviewRefused extends Error { constructor(message: string, readonly changed: string[] = []) { super(message) } }

/**
 * Keeps each ticket's latest changelist review and the audit of review decisions in the Store, and carries out a person's
 * decision on the P4 server: approve (submit or hand over), reject (back to the Executor) or discard.
 */
export class Reviews {
  constructor(private readonly host: ReviewHost) {}
  private get config(): P4Config {
    const config = this.host.p4.config<P4Config>(P4_SOURCE)
    if (!config) throw new ReviewRefused('The P4 Source is off')
    return config
  }
  private get commands(): Commands { return this.host.p4.commands }
  private person(): string { return this.host.person?.() ?? userInfo().username }
  get(ticketId: string): Review | undefined { return this.host.store.get(KV.reviews.review(ticketId)) }
  /**
   * Whether the ticket's inputs wait undelivered: while its CL waits for a person or is being submitted, its worker must
   * not change the shelf. A message that arrives meanwhile reaches the worker once the review ends.
   */
  held(ticketId: string): boolean {
    const state = this.get(ticketId)?.state
    return state === 'waiting' || state === 'submitting'
  }
  /** Reviews waiting for a person, oldest first. */
  waiting(): Review[] {
    return this.host.store.keys(KV.reviews.review).flatMap(key => this.host.store.get(key) ?? [])
      .filter(review => review.state === 'waiting').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  }
  audit(limit = 100): AuditEntry[] { return (this.host.store.get(KV.reviews.audit) ?? []).slice(-limit).reverse() }
  private save(review: Review): void { this.host.store.set(KV.reviews.review(review.ticketId), review) }
  private log(review: Review, action: AuditAction, detail?: string, by?: string): void {
    const entries = [...this.host.store.get(KV.reviews.audit) ?? [], { at: new Date().toISOString(), action, ticketId: review.ticketId,
      change: review.change, fingerprint: review.fingerprint, ...by ? { by } : {}, ...detail ? { detail } : {} }]
    this.host.store.set(KV.reviews.audit, entries.slice(-AUDIT_LIMIT))
  }
  /**
   * Records the ticket's shelved CL as waiting for review, replacing an earlier request of the ticket (a new shelf after a
   * rejection is reviewed anew). Called with the CL the Executor's ready report bound to the ticket.
   */
  request(ticketId: string, change: Change): Review {
    if (!change.shelved.length) throw new Error(`Changelist ${change.number} has no shelved files; shelve it before reporting it ready`)
    const review: Review = { ticketId, change: change.number, fingerprint: fingerprint(change.shelved), files: change.shelved,
      description: change.description, client: change.client, state: 'waiting', requestedAt: new Date().toISOString() }
    const earlier = this.get(ticketId)
    if (earlier?.state === 'waiting' && earlier.change === review.change && earlier.fingerprint === review.fingerprint) return earlier
    this.save(review)
    this.log(review, 'requested')
    return review
  }
  /** The review with each shelved file's difference, read from the server now, and how an approval submits. */
  async view(ticketId: string): Promise<{ review: Review; diffs: FileDiff[]; submit: { mode: P4Config['submit']; tags: string } } | undefined> {
    const review = this.get(ticketId)
    if (!review) return undefined
    const config = this.host.p4.config<P4Config>(P4_SOURCE)
    const diffs = review.state === 'waiting' && config ? await shelfDiffs(this.commands, config, review.change) : []
    return { review, diffs, submit: { mode: config?.submit ?? 'pipeline', tags: config?.pipelineTags ?? '' } }
  }
  private waitingReview(ticketId: string): Review {
    const review = this.get(ticketId)
    if (!review) throw new ReviewRefused('This ticket has no changelist to review')
    if (review.state !== 'waiting') throw new ReviewRefused(`This review is ${review.state}`)
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) throw new ReviewRefused('This ticket has ended')
    if (!changesOf(ticket, true).includes(review.change)) throw new ReviewRefused(`Changelist ${review.change} is no longer this ticket's`)
    return review
  }
  /**
   * Approves the shelf whose fingerprint the person read, and submits it (or hands it to the server's automation).
   * The shelf is read again first: any change since it was shown refuses the approval and names the files that changed.
   */
  async approve(ticketId: string, read: string): Promise<Review> {
    const review = this.waitingReview(ticketId)
    const config = this.config
    const by = this.person()
    if (read !== review.fingerprint) throw new ReviewRefused('The review changed after you opened it; open it again')
    const now = await readChange(this.commands, config, review.change)
    if (!now || now.status !== 'pending') throw this.refuse(review, `Changelist ${review.change} is ${now?.status ?? 'gone'}`, by)
    const current = fingerprint(now.shelved)
    if (current !== review.fingerprint) {
      const before = new Map(review.files.map(file => [file.depotFile, `${file.action}\t${file.digest ?? ''}`]))
      const after = new Map(now.shelved.map(file => [file.depotFile, `${file.action}\t${file.digest ?? ''}`]))
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)).sort()
      const refused = this.refuse(review, `The shelf changed after it was reviewed: ${changed.length} file(s); review it again`, by, changed)
      // What was read can no longer be approved: the shelf as it is now waits for a review of its own.
      if (now.shelved.length) {
        const again: Review = { ...review, fingerprint: current, files: now.shelved, description: now.description, requestedAt: new Date().toISOString() }
        this.save(again); this.log(again, 'requested', 'the shelf changed during the review')
      }
      throw refused
    }
    const outside = now.shelved.map(file => file.depotFile).filter(file => !config.paths.some(item => inPath(file, item.path)))
    if (outside.length) throw this.refuse(review, `The shelf has files outside the allowed paths: ${outside.slice(0, 5).join(', ')}`, by)
    this.log(review, 'approved', undefined, by)
    const approved = { ...review, state: 'submitting' as const, decidedAt: new Date().toISOString(), by }
    this.save(approved)
    try {
      if (config.submit === 'pipeline') {
        await this.hand(config, now)
        const handed = { ...approved, state: 'handed' as const }
        this.save(handed); this.log(handed, 'handed', config.pipelineTags, by)
        // The automation may refuse it (such as a failed Swarm review), so the ticket hears messages again meanwhile.
        this.host.release?.(ticketId)
        return handed
      }
      const submittedAs = await this.submit(config, now)
      const submitted = { ...approved, state: 'submitted' as const, submittedAs }
      this.save(submitted); this.log(submitted, 'submitted', `CL ${submittedAs}`, by)
      // The ticket's own Thread is the shelved CL, which is deleted next, so the submit itself ends the ticket.
      this.host.p4.atomic(() => {
        this.host.p4.tickets.threadClosed({ source: P4_SOURCE, id: String(review.change) }, 'merged', new Date().toISOString())
        this.host.p4.threads.patch(`${P4_SOURCE}:${review.change}`, { submittedAs })
      })
      await this.clean(config, now).catch((error: unknown) => { this.log(submitted, 'failed', `clean-up: ${String(error)}`, by) })
      return submitted
    } catch (error) {
      const failed = { ...approved, state: 'waiting' as const, error: String(error) }
      this.save(failed); this.log(failed, 'failed', String(error), by)
      throw new ReviewRefused(`Submitting failed; the approval was not used: ${String(error)}`)
    }
  }
  private refuse(review: Review, message: string, by: string, changed: string[] = []): ReviewRefused {
    this.log(review, 'refused', message, by)
    return new ReviewRefused(message, changed)
  }
  /** Pipeline mode: adds the submit tags to the CL's description, as its account, so the server's automation submits it. */
  private async hand(config: P4Config, change: Change): Promise<void> {
    const tags = config.pipelineTags.split(/\s+/).filter(Boolean)
    const missing = tags.filter(tag => !change.description.split(/\s+/).includes(tag))
    if (!missing.length) return
    const form = (await this.commands.run(config.cli || 'p4', [...config.port ? ['-p', config.port] : [], '-u', config.user, 'change', '-o', String(change.number)]))
    await p4Messages(this.commands, config, ['change', '-i'], { input: withDescription(form, `${change.description.trimEnd()}\n ${missing.join(' ')}`) })
  }
  /** Host mode: unshelves the CL into a new CL of the submit account's workspace and submits that. @returns its number. */
  private async submit(config: P4Config, change: Change): Promise<number> {
    if (!config.submitUser || !config.submitClient) throw new Error('Set the submit account and its workspace in the P4 Source')
    const as = { user: config.submitUser, client: config.submitClient }
    const created = (await p4Messages(this.commands, config, ['change', '-i'], { ...as, input: newChange(config.submitClient, config.submitUser, change.description) }))
      .map(message => /^Change (\d+) created/.exec(message)?.[1]).find(Boolean)
    if (!created) throw new Error('p4 did not name the changelist it created')
    await p4(this.commands, config, ['unshelve', '-s', String(change.number), '-c', created], as)
    const records = await p4(this.commands, config, ['submit', '-c', created], as)
    const submitted = records.map(record => record.submittedChange).find(Boolean)
    if (!submitted) throw new Error(`p4 submit of changelist ${created} named no submitted changelist`)
    return Number(submitted)
  }
  /** Deletes the reviewed shelf and its now empty pending CL, as the execution account in the ticket's workspace. */
  private async clean(config: P4Config, change: Change): Promise<void> {
    const as = { client: change.client }
    await p4(this.commands, config, ['shelve', '-d', '-c', String(change.number)], as)
    if (!change.files.length) await p4Messages(this.commands, config, ['change', '-d', String(change.number)], as)
  }
  /** Sends the CL back to the Executor with the person's comment; the ticket goes on, and its next ready report asks again. */
  reject(ticketId: string, comment: string): Review {
    const review = this.waitingReview(ticketId)
    const by = this.person()
    // The review ends before the note is given, so the note and the messages the review held reach the worker.
    const rejected = { ...review, state: 'rejected' as const, decidedAt: new Date().toISOString(), by, comment }
    this.save(rejected); this.log(rejected, 'rejected', comment, by)
    this.host.engine.note(ticketId, `Review of changelist ${review.change} sent it back (${by}): ${comment}\nChange the files, shelve the changelist again, and report it ready with the same changelist.`)
    this.host.release?.(ticketId)
    return rejected
  }
  /** Drops the change: deletes the shelf, reverts the opened files and the CL, as the execution account, and stops the ticket. */
  async discard(ticketId: string): Promise<Review> {
    const review = this.waitingReview(ticketId)
    const config = this.config
    const by = this.person()
    const as = { client: review.client }
    await p4(this.commands, config, ['shelve', '-d', '-c', String(review.change)], as)
    await p4Messages(this.commands, config, ['revert', '-c', String(review.change), '//...'], as)
    await p4Messages(this.commands, config, ['change', '-d', String(review.change)], as)
    const discarded = { ...review, state: 'discarded' as const, decidedAt: new Date().toISOString(), by }
    this.save(discarded); this.log(discarded, 'discarded', undefined, by)
    this.host.engine.stopTicket(ticketId, `The reviewer discarded changelist ${review.change}`)
    return discarded
  }
}

/** A changelist form (`p4 change -o`) with its Description replaced; each description line is tab-indented, as p4 writes it. */
export function withDescription(form: string, description: string): string {
  const lines = form.split(/\r?\n/)
  const start = lines.findIndex(line => /^Description:/.test(line))
  const text = description.split(/\r?\n/).map(line => `\t${line}`)
  if (start < 0) return `${form.trimEnd()}\n\nDescription:\n${text.join('\n')}\n`
  let end = start + 1
  while (end < lines.length && (lines[end]!.startsWith('\t') || lines[end] === '' && lines[end + 1]?.startsWith('\t'))) end++
  return [...lines.slice(0, start), 'Description:', ...text, ...lines.slice(end)].join('\n')
}
/** The form of a new, empty changelist of `client` and `user`. */
export const newChange = (client: string, user: string, description: string): string =>
  `Change:\tnew\n\nClient:\t${client}\n\nUser:\t${user}\n\nStatus:\tnew\n\nDescription:\n${description.split(/\r?\n/).map(line => `\t${line}`).join('\n')}\n`
