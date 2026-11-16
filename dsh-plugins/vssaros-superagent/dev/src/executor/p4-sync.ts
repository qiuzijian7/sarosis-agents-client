/** Host-owned P4 pre-work sync and automatic resolve. Never exposed to workers, whose p4 guard refuses `sync`. */
import type { P4Config } from '../sources/p4-change.ts'
import { ignoredDepotFile } from './p4-pending.ts'
import type { GitRunner } from './git-workspace.ts'
import { WorkspaceError } from './workspace.ts'

/** A sync/merge conflict that must stop the ticket without reverting or overwriting the operator's workspace. */
export class P4ConflictError extends WorkspaceError {
  constructor(message: string, readonly files: readonly string[]) { super(message) }
}

/**
 * Brings the allowed depot paths to head for the ticket's frozen client, automatically merges files that need resolve,
 * and refuses to proceed when a local unopened edit would be clobbered or a merge conflict remains.
 *
 * The preview is deliberate: this client commonly has `allwrite clobber`, so a plain `p4 sync` could silently overwrite
 * generated artifacts or a person's edits. Only files the preview says will actually change are compared with `diff -se`;
 * an up-to-date workspace therefore triggers no full-tree difference scan.
 *
 * Off by default. A UE client whose `sync -n` previews thousands of updates makes that `diff -se` walk the whole tree,
 * which exceeded the Host's 10-minute timeout and prevented any worker session from being created. Enable it only after
 * narrowing `paths`; the operator then owns keeping the workspace at head.
 */
export async function syncP4Workspace(config: P4Config, client: string, root: string, run: GitRunner): Promise<void> {
  if (!config.syncBeforeWork) return
  const paths = config.paths.map(item => item.path)
  if (!paths.length || !client) return
  const base = [config.cli || 'p4', '-p', config.port, '-u', config.user, '-c', client, '-Mj', '-ztag']
  const records = async (args: string[]): Promise<Record<string, string>[]> => {
    let output: string
    try { output = await run([...base, ...args], root) }
    catch (error) {
      const message = String(error)
      if (/No file\(s\) to resolve|file\(s\) not opened on this client|up-to-date/i.test(message)) return []
      if (/conflict|resolve|clobber/i.test(message)) throw new P4ConflictError(`P4 合并冲突或覆盖风险：${message.slice(0, 300)}；工单已停止，请人工处理。`, [])
      throw new WorkspaceError(`P4 同步/合并失败：${message.slice(0, 300)}`, error)
    }
    const result: Record<string, string>[] = []
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue
      const record = JSON.parse(line) as Record<string, string>
      if (record.severity !== undefined) {
        if (Number(record.severity) >= 3) throw new WorkspaceError(`P4 同步/合并失败：${String(record.data ?? '').slice(0, 250)}`)
        continue
      }
      result.push(record)
    }
    return result
  }
  // 1. Preview what sync would change. No -f: head revisions only, never a forced refresh of writable files.
  const ignores = config.reconcileIgnore
  const usable = (file: string | undefined): file is string => !!file && !ignoredDepotFile(file, ignores)
  const planned = new Set((await records(['sync', '-n', ...paths])).map(file => file.depotFile).filter(usable))
  if (planned.size) {
    // 2. Only now inspect unopened local edits, and only for files sync is about to overwrite.
    const dirty = (await records(['diff', '-se', ...paths])).map(file => file.depotFile).filter(usable)
    const overlap = [...planned].filter(file => dirty.includes(file))
    if (overlap.length) throw new P4ConflictError(`P4 同步冲突：${overlap.length} 个将更新的文件存在未签出的本地修改，例如 ${overlap.slice(0, 8).join('、')}；工单已停止，不会覆盖。`, overlap)
  }
  // 3. Update to head only within the operator's allowed depot paths.
  await records(['sync', '-q', ...paths])
  // 4. Automatic merge, skipping files with real conflicts (-am, never -af/-at/-ay which could discard edits).
  await records(['resolve', '-am', ...paths])
  // 5. Anything unresolved is a conflict. Leave the workspace as-is for a person to resolve.
  const unresolved = (await records(['fstat', '-Ru', '-T', 'depotFile,clientFile', ...paths])).map(file => file.depotFile).filter(Boolean) as string[]
  if (unresolved.length) throw new P4ConflictError(`P4 合并冲突：${unresolved.length} 个文件未能自动 resolve，例如 ${unresolved.slice(0, 8).join('、')}；工单已停止，请人工 resolve。`, unresolved)
}
