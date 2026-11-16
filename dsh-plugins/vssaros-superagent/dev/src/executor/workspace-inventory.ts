/** On-demand, bounded workspace inventory and manual cleanup preview. Never prepares, archives or deletes files. */
import { lstat, opendir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Store } from '../app/store.ts'
import { liveTicket, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import { verifyGitWorktree, type GitRunner } from './git-workspace.ts'

export const WORKSPACE_PREVIEW_RETENTION_DAYS = 14
export type WorkspaceBlocker = 'live' | 'recent' | 'end-unknown' | 'pending-input' | 'awaiting-person' | 'open-follow' | 'team-history'
  | 'p4-history' | 'preparation-unknown' | 'preparation-failed' | 'external-directory' | 'missing' | 'filesystem-unknown'
  | 'incomplete-size' | 'symbolic-links' | 'git-unknown' | 'git-dirty' | 'git-ahead' | 'no-upstream' | 'runtime-active'
  | 'activity-unknown' | 'shared-directory' | 'path-mismatch'
export interface WorkspaceRow {
  ticketId: string
  title: string
  directory: string
  checkedAt: string
  endedAt: string | null
  preparation: 'preparing' | 'ready' | 'failed' | 'unknown'
  exists: boolean | null
  bytes: number | null
  files: number
  blockers: WorkspaceBlocker[]
  disposition: 'retain' | 'manual-review'
}
export interface WorkspaceInventory {
  readOnly: true
  checkedAt: string
  retentionDays: number
  total: number
  offset: number
  nextOffset: number | null
  items: WorkspaceRow[]
}
interface InventoryHost {
  store: Pick<Store, 'tickets' | 'get'>
  activity(ticketId: string): Promise<WorkspaceBlocker[]>
  git: GitRunner
  signal?: AbortSignal
}

/** Logical file bytes, not allocated disk space; limits and links produce unknown totals instead of a false zero. */
async function linkedAncestor(directory: string, signal?: AbortSignal): Promise<boolean> {
  for (let path = resolve(directory);; path = dirname(path)) {
    signal?.throwIfAborted()
    if ((await lstat(path)).isSymbolicLink()) return true
    if (dirname(path) === path) return false
  }
}

async function measure(directory: string, signal?: AbortSignal): Promise<Pick<WorkspaceRow, 'exists' | 'bytes' | 'files'> & { blockers: WorkspaceBlocker[] }> {
  let bytes = 0, files = 0, visited = 0
  const blockers = new Set<WorkspaceBlocker>()
  const deadline = Date.now() + 2000
  try {
    signal?.throwIfAborted()
    const root = await lstat(directory)
    if (root.isSymbolicLink() || await linkedAncestor(directory, signal)) return { exists: true, bytes: null, files: 0, blockers: ['symbolic-links'] }
    if (!root.isDirectory()) return { exists: null, bytes: null, files: 0, blockers: ['filesystem-unknown'] }
    const walk = async (path: string, depth: number): Promise<void> => {
      signal?.throwIfAborted()
      if (depth > 12 || Date.now() >= deadline || visited >= 2000) { blockers.add('incomplete-size'); return }
      const before = await lstat(path)
      if (before.isSymbolicLink()) { blockers.add('symbolic-links'); return }
      if (!before.isDirectory()) { blockers.add('filesystem-unknown'); return }
      const handle = await opendir(path)
      try {
        signal?.throwIfAborted()
        const after = await lstat(path)
        if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
          blockers.add('filesystem-unknown'); return
        }
        for await (const entry of handle) {
          signal?.throwIfAborted()
          if (Date.now() >= deadline || visited++ >= 2000) { blockers.add('incomplete-size'); return }
          const child = join(path, entry.name), info = await lstat(child)
          if (info.isSymbolicLink()) blockers.add('symbolic-links')
          else if (info.isDirectory()) await walk(child, depth + 1)
          else if (info.isFile()) { files++; bytes += info.size }
          else blockers.add('filesystem-unknown')
        }
      } finally {
        await handle.close().catch((error: unknown) => {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ERR_DIR_CLOSED')) throw error
        })
      }
    }
    await walk(directory, 0)
    return { exists: true, bytes: blockers.size ? null : bytes, files, blockers: [...blockers] }
  } catch {
    signal?.throwIfAborted()
    return { exists: null, bytes: null, files, blockers: ['filesystem-unknown'] }
  }
}

async function inspect(host: InventoryHost, ticket: Ticket, tickets: Ticket[], now: number): Promise<WorkspaceRow> {
  const directory = ticket.execution!.directory
  const record = host.store.get(KV.executor.workspace(ticket.id))
  const blockers = new Set<WorkspaceBlocker>()
  if (liveTicket(ticket)) blockers.add('live')
  else {
    const ended = Date.parse(ticket.ended!.at)
    if (!Number.isFinite(ended)) blockers.add('end-unknown')
    else if (now - ended < WORKSPACE_PREVIEW_RETENTION_DAYS * 86_400_000) blockers.add('recent')
  }
  if (ticket.undelivered.length) blockers.add('pending-input')
  if (ticket.attention) blockers.add('awaiting-person')
  if (ticket.follows?.some(follow => !follow.closed)) blockers.add('open-follow')
  if (ticket.team) blockers.add('team-history')
  if (ticket.follows?.some(follow => follow.thread.startsWith('p4:')) || host.store.get(KV.reviews.review(ticket.id))
    || host.store.get(KV.reviews.required(ticket.id))) blockers.add('p4-history')
  if (!record) blockers.add('preparation-unknown')
  else {
    if (record.state !== 'ready') blockers.add('preparation-failed')
    if (record.origin !== 'prepared') blockers.add('external-directory')
    if (isAbsolute(directory) && resolve(directory) !== record.directory) blockers.add('path-mismatch')
  }
  if (!ticket.execution!.project) blockers.add('external-directory')
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  if (tickets.some(other => other.id !== ticket.id && other.execution?.directory && normalize(other.execution.directory) === normalize(directory))) blockers.add('shared-directory')
  host.signal?.throwIfAborted()
  try { for (const reason of await host.activity(ticket.id)) blockers.add(reason) } catch {
    host.signal?.throwIfAborted(); blockers.add('activity-unknown')
  }
  let size: Awaited<ReturnType<typeof measure>>
  if (!isAbsolute(directory)) size = { exists: null, bytes: null, files: 0, blockers: ['path-mismatch'] }
  else {
    try {
      await lstat(directory)
      size = await measure(directory, host.signal)
    } catch (error) {
      host.signal?.throwIfAborted()
      const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      size = { exists: missing ? false : null, bytes: null, files: 0, blockers: [missing ? 'missing' : 'filesystem-unknown'] }
    }
  }
  for (const reason of size.blockers) blockers.add(reason)
  if (size.exists && ticket.execution!.project && !size.blockers.includes('symbolic-links')) {
    try {
      await verifyGitWorktree(ticket.execution!.project, directory, ticket.execution!.name, host.git)
      const status = await host.git(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'], directory)
      if (status.trim()) blockers.add('git-dirty')
      try {
        const upstream = (await host.git(['git', 'rev-parse', '--symbolic-full-name', '@{upstream}'], directory)).trim()
        if (!upstream.startsWith('refs/remotes/')) blockers.add('no-upstream')
        else {
          const ahead = (await host.git(['git', 'rev-list', '--count', '@{upstream}..HEAD'], directory)).trim()
          if (!/^\d+$/.test(ahead)) blockers.add('git-unknown')
          else if (Number(ahead) > 0) blockers.add('git-ahead')
        }
      } catch { host.signal?.throwIfAborted(); blockers.add('no-upstream') }
    } catch { host.signal?.throwIfAborted(); blockers.add('git-unknown') }
  }
  host.signal?.throwIfAborted()
  return { ticketId: ticket.id, title: ticket.title, directory, checkedAt: new Date(now).toISOString(), endedAt: ticket.ended?.at ?? null,
    preparation: record?.state ?? 'unknown', exists: size.exists, bytes: size.bytes, files: size.files,
    blockers: [...blockers], disposition: blockers.size ? 'retain' : 'manual-review' }
}

/** Page limits bound one explicit request; this is not a deletion authorization or a scan of orphan directories. */
export async function workspaceInventory(host: InventoryHost, offset = 0, limit = 10): Promise<WorkspaceInventory> {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid workspace inventory page')
  host.signal?.throwIfAborted()
  const now = Date.now()
  const tickets = host.store.tickets.list().filter(ticket => ticket.execution?.directory)
  const page = tickets.slice(offset, offset + limit)
  const items: WorkspaceRow[] = []
  for (const ticket of page) {
    host.signal?.throwIfAborted()
    items.push(await inspect(host, ticket, tickets, Date.now()))
  }
  return { readOnly: true, checkedAt: new Date(now).toISOString(), retentionDays: WORKSPACE_PREVIEW_RETENTION_DAYS,
    total: tickets.length, offset, nextOffset: offset + limit < tickets.length ? offset + limit : null, items }
}
