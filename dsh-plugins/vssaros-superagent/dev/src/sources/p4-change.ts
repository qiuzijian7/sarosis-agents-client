/**
 * VsSaros addition: Perforce changelists as Threads. A ticket's pending CL binds to it the way its PR does on GitHub
 * (`github-pull.ts`): the CL is the ticket's own Thread, and its submit ends the ticket as `merged`, its deletion as `closed`.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { key, liveTicket, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'

export const P4_SOURCE = 'p4'
/** Default generated-file exclusions, shared by the config schema and the settings panel. */
export const DEFAULT_RECONCILE_IGNORE = [
  { path: 'Binaries' }, { path: 'Intermediate' }, { path: 'DerivedDataCache' }, { path: 'Saved' },
  { path: '__pycache__' }, { path: 'Logs' }, { path: '.vs' }, { path: 'obj' },
  { path: '*.pyc' }, { path: '*.pdb' }, { path: '*.obj' }, { path: '*.ilk' }, { path: '*.exp' },
]
export const P4ConfigSchema = z.object({
  cli: z.string().trim().default('p4'),
  port: z.string().trim().default(''),
  user: z.string().trim().regex(/^[^\s@#%*]*$/).default(''),
  paths: z.array(z.object({ path: z.string().trim().regex(/^\/\/[^\s]+$/) }).strict()).default([]),
  requireDelivery: z.boolean().default(true),
  /** Opt-in strict preflight: refuse to start when `p4 diff -se` finds unopened local differences. */
  checkUnopenedDiffs: z.boolean().default(false),
  /**
   * Host-owned pre-work sync to head. Off by default: on a large UE client the required `diff -se` over
   * the two full allowed paths exceeded the Host's 10-minute timeout, so a ticket never reached its worker.
   * Operators can opt in after narrowing the allowed paths; worker commands never gain `sync` permission.
   */
  syncBeforeWork: z.boolean().default(false),
  /** Directory/file names excluded from reconcile (also accepts a full `//depot/...` pattern). */
  reconcileIgnore: z.array(z.object({ path: z.string().trim().min(1) }).strict())
    .default(() => DEFAULT_RECONCILE_IGNORE.map(item => ({ ...item }))),
  /**
   * Opt-in fallback: also run `p4 reconcile` on the exact files `p4 opened` reported, in batches.
   * Off by default: a UE tree makes any wildcard reconcile exceed the command timeout, and a worker
   * already opens its files with `p4 edit`, so `p4 opened` covers the delivery. Never passes `...`/`*`.
   */
  reconcileFallback: z.boolean().default(false),
  workspaceMode: z.enum(['ticket', 'current']).default('ticket'),
  executionClient: z.string().trim().regex(/^[^\s@#%*]*$/).default(''),
  workspaceRoot: z.string().trim().default(''),
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  /**
   * What happens after a person reviews a CL. `pending` (default) never submits: the named pending CL is the delivery,
   * and a person decides if/when to submit it in P4V. `pipeline`/`host` are the legacy submit paths.
   */
  submit: z.enum(['pending', 'pipeline', 'host']).default('pending'),
  /** Name template for the pending CL. `{ticket}` is the short ticket id and `{title}` its title. */
  pendingName: z.string().trim().min(1).max(200).default('[dsh-superagent:{ticket}] {title}'),
  pipelineTags: z.string().trim().default('#review #ShelveForSubmit'),
  submitUser: z.string().trim().regex(/^[^\s@#%*]*$/).default(''),
  submitClient: z.string().trim().regex(/^[^\s@#%*]*$/).default(''),
}).strict()
export type P4Config = z.infer<typeof P4ConfigSchema>
export const p4Configured = (config: P4Config): boolean => !!config.port && !!config.user && config.paths.length > 0

/** Who a p4 command runs as and with what: another account or workspace than the Source's, and the form on stdin. */
export interface P4Call { user?: string; client?: string; input?: string }
const globals = (config: Pick<P4Config, 'port' | 'user'>, call: P4Call): string[] => {
  const user = call.user ?? config.user
  return [...config.port ? ['-p', config.port] : [], ...user ? ['-u', user] : [], ...call.client ? ['-c', call.client] : []]
}
/** Runs `p4 -Mj -ztag` with the Source's server and execution account and returns its data records (messages dropped). */
export async function p4(commands: Commands, config: Pick<P4Config, 'cli' | 'port' | 'user'>, args: string[], call: P4Call = {}): Promise<Record<string, string>[]> {
  const output = await commands.run(config.cli || 'p4', [...globals(config, call), '-Mj', '-ztag', ...args], undefined, call.input)
  return output.split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return []
    const record = JSON.parse(line) as Record<string, unknown>
    if (typeof record.severity === 'number') {
      if (record.severity >= 3) throw new Error(String(record.data ?? 'p4 failed').trim())
      return []
    }
    return [Object.fromEntries(Object.entries(record).map(([name, value]) => [name, String(value)]))]
  })
}
/** Runs `p4 -Mj` (no tagged fields) and returns its info messages, such as `Change 12 created.`. */
export async function p4Messages(commands: Commands, config: Pick<P4Config, 'cli' | 'port' | 'user'>, args: string[], call: P4Call = {}): Promise<string[]> {
  const output = await commands.run(config.cli || 'p4', [...globals(config, call), '-Mj', ...args], undefined, call.input)
  return output.split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return []
    const record = JSON.parse(line) as { data?: unknown; severity?: unknown }
    if (typeof record.severity === 'number' && record.severity >= 3) throw new Error(String(record.data ?? 'p4 failed').trim())
    return typeof record.data === 'string' ? [record.data] : []
  })
}

/** One file's change in a shelf as `p4 describe -S -du` prints it; `binary` when the server prints no text difference. */
export interface FileDiff { depotFile: string; rev: string; type: string; lines: string[]; truncated?: true }
const DIFF_HEADER = /^==== (\/\/.+?)#(\d+|none) \((.+)\) ====$/
/** Splits the text of `p4 describe -S -du` into each file's unified difference, at most `maxLines` lines per file. */
export function parseDiffs(text: string, maxLines = 2000): FileDiff[] {
  const diffs: FileDiff[] = []
  let current: FileDiff | undefined
  for (const line of text.split(/\r?\n/)) {
    const header = DIFF_HEADER.exec(line)
    if (header) { current = { depotFile: header[1]!, rev: header[2]!, type: header[3]!, lines: [] }; diffs.push(current); continue }
    if (!current) continue
    if (current.lines.length >= maxLines) { current.truncated = true; continue }
    if (current.lines.length || line) current.lines.push(line)
  }
  for (const diff of diffs) while (diff.lines.at(-1) === '') diff.lines.pop()
  return diffs
}
export interface ShelfDiffSummary { files: number; added: number; removed: number; hunks: number; complete: boolean }
/** Counts only unified hunk lines; binary files count as files, and missing or truncated differences are explicitly incomplete. */
export function summarizeShelfDiffs(files: readonly ChangeFile[], diffs: readonly FileDiff[]): ShelfDiffSummary {
  const summary: ShelfDiffSummary = { files: files.length, added: 0, removed: 0, hunks: 0,
    complete: diffs.length === files.length && files.every(file => diffs.some(diff => diff.depotFile === file.depotFile)) && !diffs.some(diff => diff.truncated) }
  for (const diff of diffs) {
    let inHunk = false
    for (const line of diff.lines) {
      if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) { summary.hunks++; inHunk = true }
      else if (inHunk && line.startsWith('+')) summary.added++
      else if (inHunk && line.startsWith('-')) summary.removed++
    }
  }
  return summary
}
/** Reads the unified differences of a CL's shelf. */
export async function shelfDiffs(commands: Commands, config: P4Config, change: number): Promise<FileDiff[]> {
  const global = globals(config, {})
  return parseDiffs(await commands.run(config.cli || 'p4', [...global, 'describe', '-S', '-du', String(change)]))
}

export interface ChangeFile { depotFile: string; action: string; rev: string; type: string; digest?: string }
export interface Change {
  /** The number the CL was created with: Threads keep it after a submit renumbers the CL. */
  number: number
  /** The number the CL has now: its submitted number once it is submitted. */
  current: number
  status: 'pending' | 'submitted' | 'shelved'
  client: string; user: string; description: string; time: string
  /** Files opened in the CL; for a pending CL, `shelved` holds the files of its shelf. */
  files: ChangeFile[]
  shelved: ChangeFile[]
}
/** Opened files absent from the shelf or with a different action, type or known content digest. An empty opened list is valid after revert. */
export function unshelvedFiles(change: Change): string[] {
  const shelf = new Map(change.shelved.map(file => [file.depotFile, file]))
  return change.files.filter(file => {
    const saved = shelf.get(file.depotFile)
    return !saved || file.action !== saved.action || (file.type && saved.type && file.type !== saved.type)
      || (file.digest && saved.digest && file.digest !== saved.digest)
  }).map(file => file.depotFile)
}
/** Files of a `describe` record, which numbers them `depotFile0`, `action0`, … */
export function filesOf(record: Record<string, string>): ChangeFile[] {
  const files: ChangeFile[] = []
  for (let index = 0; record[`depotFile${index}`] !== undefined; index++) {
    const digest = record[`digest${index}`]
    files.push({ depotFile: record[`depotFile${index}`]!, action: record[`action${index}`] ?? '', rev: record[`rev${index}`] ?? '',
      type: record[`type${index}`] ?? '', ...digest ? { digest } : {} })
  }
  return files
}
/**
 * Reads a CL by the number it was created with (`-O` follows a submit's renumbering), and for a pending CL its shelf.
 * @returns undefined when the server knows no such CL, as after it was deleted.
 */
export async function readChange(commands: Commands, config: P4Config, number: number): Promise<Change | undefined> {
  let record: Record<string, string> | undefined
  try { record = (await p4(commands, config, ['describe', '-s', '-O', String(number)]))[0] }
  catch (error) { if (/\bunknown\b/i.test(String(error))) return undefined; throw error }
  if (!record) return undefined
  const status = record.status === 'submitted' ? 'submitted' : record.status === 'shelved' ? 'shelved' : 'pending'
  const shelf = status === 'submitted' ? undefined : (await p4(commands, config, ['describe', '-S', '-s', record.change ?? String(number)]))[0]
  return { number, current: Number(record.change) || number, status, client: record.client ?? '', user: record.user ?? '',
    description: record.desc ?? '', time: record.time ?? '', files: filesOf(record), shelved: shelf ? filesOf(shelf) : [] }
}

/** Matches a depot path against a Perforce path pattern: `...` is any text, `*` any text within one directory. */
export function inPath(depotFile: string, pattern: string, caseSensitive = true): boolean {
  const source = pattern.split(/(\.\.\.|\*)/).map(part => part === '...' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^${source}$`, caseSensitive ? '' : 'i').test(depotFile)
}
/** The shelf's content fingerprint a person approves: it changes when any file, its action or its content changes. */
export function fingerprint(files: readonly ChangeFile[]): string {
  const lines = files.map(file => `${file.depotFile}\t${file.action}\t${file.type}\t${file.digest ?? ''}`).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}
/** The workspace a ticket's CL must belong to: its name ends with the ticket's short name, such as `superagent-<name>`. */
export const ticketClient = (ticket: Pick<Ticket, 'execution'>, client: string): boolean =>
  ticket.execution?.p4Workspace ? !!ticket.execution.p4Workspace.client && client === ticket.execution.p4Workspace.client
    : !!ticket.execution?.name && (client === ticket.execution.name || client.endsWith(`-${ticket.execution.name}`))

const changeNumber = (thread: string): number | undefined => thread.startsWith(`${P4_SOURCE}:`) ? Number(thread.slice(P4_SOURCE.length + 1)) : undefined
export const changesOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => changeNumber(item.thread) ?? [])

/**
 * Binds a pending CL to the ticket as its own Thread when the CL is the execution account's, belongs to the ticket's
 * workspace, and touches only files under the Source's allowed paths; one CL binds to at most one open ticket.
 * @returns why the CL was refused, or undefined once it is bound.
 */
export function claimChangelist(ctx: SourceContext, config: P4Config, ticketId: string, change: Change): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended; do not report a changelist for it'
  if (change.status !== 'pending') return `Changelist ${change.number} is ${change.status}; report a pending changelist`
  if (config.user && change.user !== config.user) return `Changelist ${change.number} belongs to ${change.user}, not to the execution account ${config.user}`
  if (!ticketClient(ticket, change.client)) {
    return `Changelist ${change.number} is in workspace ${change.client}; use ${ticket.execution?.p4Workspace?.client ?? `a workspace whose name ends with -${ticket.execution?.name ?? 'DSH_SUPERAGENT_NAME'}`}`
  }
  const shared = ticket.execution?.p4Workspace
  if (shared && (shared.port !== config.port || shared.user !== config.user)) return 'Configured P4 account/server changed; do not rebind the ticket'
  if (shared && !change.description.split(/\s+/).includes(`[dsh-superagent:${ticketId}]`)) return 'Current-workspace CL must carry this ticket marker; existing or default CLs are not this ticket delivery'
  const files = [...change.files, ...change.shelved]
  if (!files.length) return `Changelist ${change.number} has no files`
  const outside = [...new Set(files.map(file => file.depotFile).filter(file => !config.paths.some(item => inPath(file, item.path))))]
  if (outside.length) return `Changelist ${change.number} has files outside the allowed paths: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''}`
  const owner = ctx.tickets.open().find(item => changesOf(item, true).includes(change.number))
  if (owner && owner.id !== ticketId) return `Changelist ${change.number} already belongs to another active ticket`
  const follow = ticket.follows?.find(item => item.thread === `${P4_SOURCE}:${change.number}`)
  if (!follow || follow.closed || !follow.own) {
    ctx.atomic(() => {
      ctx.tickets.bindThread(ticketId, { source: P4_SOURCE, id: String(change.number) }, true)
      ctx.threads.patch(`${P4_SOURCE}:${change.number}`, { change: change.number, client: change.client })
    })
  }
  ctx.threads.describe(`${P4_SOURCE}:${change.number}`, { label: `CL ${change.number}` })
  return undefined
}
/**
 * The notices a ticket that ended with its CL submitted sends to its conversations, such as a comment on its TAPD item,
 * once per CL and conversation. `meta` reads a Thread's meta, where a submit records its submitted number.
 */
export function changeEndNotices(ticket: Ticket, meta: (thread: string) => Record<string, unknown> | undefined): OutboundMessage[] {
  if (ticket.ended?.outcome !== 'merged') return []
  const follow = (ticket.follows ?? []).filter(item => item.own && item.closed && changeNumber(item.thread) !== undefined)
    .sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  if (!follow) return []
  const number = changeNumber(follow.thread)!
  const submitted = Number(meta(follow.thread)?.submittedAs) || number
  const text = submitted !== number ? `已提交为 CL ${submitted}（审核的是 CL ${number} 的 shelve）。` : `CL ${number} 已提交。`
  return ticket.channels.filter(channel => channel.source !== P4_SOURCE).map(channel => ({
    id: key('cl-submitted', String(number), channel.source, JSON.stringify(channel.address)), channel, text, kind: 'notice', ticketId: ticket.id }))
}
/**
 * Reports a submitted or deleted CL once to the open tickets that follow it, whose end the core decides.
 * @returns whether the CL has ended.
 */
export function observeChange(ctx: SourceContext, number: number, change: Change | undefined): boolean {
  const ended = !change || change.status === 'submitted'
  if (!ended) return false
  if (ctx.tickets.open().some(ticket => changesOf(ticket, true).includes(number))) {
    const at = change?.time ? new Date(Number(change.time) * 1000).toISOString() : new Date().toISOString()
    ctx.tickets.threadClosed({ source: P4_SOURCE, id: String(number) }, change ? 'merged' : 'closed', at)
  }
  if (change && change.current !== number) ctx.threads.patch(`${P4_SOURCE}:${number}`, { submittedAs: change.current })
  return true
}
