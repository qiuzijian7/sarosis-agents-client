/**
 * Host-owned delivery of a P4 ticket as ONE named pending changelist. No submit, no unshelve.
 * A person decides in P4V if and when the CL is submitted.
 */
import { inPath, type P4Config } from '../sources/p4-change.ts'

/** A p4 -Mj -ztag command returning its data records; the caller pins server, account and client. */
export type P4Records = (args: string[]) => Promise<Record<string, string>[]>
/** Explicit file arguments are batched so a long file list cannot exceed the OS command-line limit. */
const BATCH = 100

/**
 * Whether a depot or local path is excluded. A bare name matches any path segment (a directory name or file name);
 * `*.ext` matches a file suffix; a `//depot/...` pattern matches depot paths only.
 */
export function ignoredDepotFile(path: string, ignores: readonly { path: string }[]): boolean {
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  const leaf = segments.at(-1) ?? ''
  return ignores.some(({ path: rule }) => {
    if (!rule) return false
    if (rule.startsWith('//')) return normalized.startsWith('//') && inPath(normalized, rule, false)
    if (rule.startsWith('*.')) return leaf.toLowerCase().endsWith(rule.slice(1).toLowerCase())
    return segments.some(segment => segment.toLowerCase() === rule.toLowerCase())
  })
}

/** Renders the pending CL name, always keeping the ticket marker the delivery gate requires. */
export function pendingName(config: P4Config, ticketId: string, title: string): string {
  const marker = `[dsh-superagent:${ticketId}]`
  const rendered = config.pendingName.replaceAll('{ticket}', ticketId).replaceAll('{title}', title).trim().slice(0, 200)
  return rendered.includes(marker) ? rendered : `${rendered} ${marker}`.trim()
}

/** A plain depot file path, never a wildcard; only such paths may reach `p4 reconcile`. */
const explicit = (path: string): boolean => path.startsWith('//') && !path.includes('...') && !path.includes('*')

export interface Consolidated {
  /** Files passed to the optional explicit-file reconcile fallback (empty when it is off). */
  reconciled: string[]
  /** Files moved from the default or another CL into the ticket's CL. */
  reopened: string[]
  /** Opened files skipped because they matched the ignore list. */
  ignored: number
  /** Total files belonging to the delivered CL after consolidation. */
  files: number
}

/**
 * Puts every opened file of this client into `target`, leaving a single named pending CL.
 * The default path is a single `p4 opened` metadata read plus `p4 reopen`: no tree walk, no wildcard,
 * no `reconcile -n` preview. A worker must `p4 edit` before editing, so opened files are the delivery.
 * Only when `reconcileFallback` is explicitly enabled does it run `reconcile -e -a -d -c` on the exact
 * (non-ignored, in-scope) files `p4 opened` reported, in batches; it never passes a wildcard path.
 */
export async function consolidatePending(config: P4Config, target: number, records: P4Records): Promise<Consolidated> {
  const ignores = config.reconcileIgnore
  const opened = await records(['opened'])
  const pathOf = (record: Record<string, string>) => record.depotFile ?? record.clientFile ?? ''
  const candidates = opened.map(pathOf).filter(Boolean)
  // `p4 opened` already lists only this client's checked-out files. Depot paths must also be in scope;
  // a clientFile-only record has no depot path yet, so only the ignore list applies to it.
  const inScope = (record: Record<string, string>) => !record.depotFile
    || config.paths.some(allowed => inPath(record.depotFile!, allowed.path))
  const allowed = opened.filter(record => inScope(record) && !ignoredDepotFile(pathOf(record), ignores))
  const kept = [...new Set(allowed.map(pathOf).filter(Boolean))]
  const ignored = candidates.length - kept.length

  let reconciled: string[] = []
  if (config.reconcileFallback) {
    const exact = kept.filter(explicit)
    for (let at = 0; at < exact.length; at += BATCH) {
      await records(['reconcile', '-e', '-a', '-d', '-c', String(target), ...exact.slice(at, at + BATCH)])
    }
    reconciled = exact
  }
  const move = [...new Set(allowed.filter(record => record.change !== String(target))
    .map(pathOf).filter(Boolean))]
  for (let at = 0; at < move.length; at += BATCH) {
    await records(['reopen', '-c', String(target), ...move.slice(at, at + BATCH)])
  }
  return { reconciled, reopened: move, ignored, files: kept.length }
}

/** A `p4 change -o` form with its Description replaced, tab-indented as p4 writes it. */
export function withPendingName(form: string, name: string): string {
  const lines = form.split(/\r?\n/)
  const start = lines.findIndex(line => /^Description:/.test(line))
  const text = name.split(/\r?\n/).map(line => `\t${line}`)
  if (start < 0) return `${form.trimEnd()}\n\nDescription:\n${text.join('\n')}\n`
  let end = start + 1
  while (end < lines.length && (lines[end]!.startsWith('\t') || lines[end] === '' && lines[end + 1]?.startsWith('\t'))) end++
  return [...lines.slice(0, start), 'Description:', ...text, ...lines.slice(end)].join('\n')
}

export interface PendingHost {
  /** `p4 -Mj -ztag` returning data records. */
  records: P4Records
  /** Raw p4 form read/write (no -Mj), with optional stdin for `change -i`. */
  form: (args: string[], input?: string) => Promise<string>
}

/** Consolidates, names, and re-shelves the ticket's pending CL. Never submits or unshelves. */
export async function finalizePending(config: P4Config, target: number, ticketId: string, title: string,
  host: PendingHost): Promise<Consolidated & { name: string }> {
  const consolidated = await consolidatePending(config, target, host.records)
  const name = pendingName(config, ticketId, title)
  const form = await host.form(['change', '-o', String(target)])
  await host.form(['change', '-i'], withPendingName(form, name))
  await host.records(['shelve', '-c', String(target)])
  return { ...consolidated, name }
}
