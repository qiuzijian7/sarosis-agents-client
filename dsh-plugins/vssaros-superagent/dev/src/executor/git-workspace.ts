/** Project selection and managed Git worktrees; no network fetch, reset, or automatic cleanup. */
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { lock } from 'proper-lockfile'
import type { Execution, Trigger } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import { itemAddress } from '../sources/tapd-api.ts'
import { WorkspaceError } from './workspace.ts'

type Project = NonNullable<Execution['project']>
export type GitRunner = (argv: string[], cwd: string) => Promise<string>

/** Source IDs only select an operator-owned mapping; they never supply filesystem paths or commands. */
export function mappedProject(settings: Settings, origin?: Trigger, canonicalRepository?: string): Project | undefined {
  if (!origin) return undefined
  let source = origin.source, projectId = ''
  if (source === 'github') projectId = canonicalRepository ?? String(settings.sources.github?.config.repository ?? '')
  else if (source === 'gongfeng') {
    const configured = String(settings.sources.gongfeng?.config.project ?? '')
    if (origin.meta.project === configured) projectId = configured
  }
  else if (source === 'tapd') projectId = typeof origin.meta.workspace === 'string' ? origin.meta.workspace : ''
  else {
    const address = itemAddress(origin.url ?? '') ?? itemAddress(/https?:\/\/\S+/i.exec(origin.text)?.[0] ?? '')
    if (address && (source === 'superagent' || source === 'feishu')) { source = 'tapd'; projectId = address.workspace }
    else if (source === 'superagent' || source === 'feishu') projectId = 'local'
  }
  const mapping = settings.executor.projects.find(row => row.source === source && row.projectId.toLowerCase() === projectId.toLowerCase())
  return mapping ? { ...mapping, strategy: 'git-worktree' } : undefined
}

async function commonDirectory(repository: string, run: GitRunner): Promise<string> {
  if (!isAbsolute(repository)) throw new WorkspaceError('Git 项目必须配置本机绝对仓库路径。')
  const path = (await run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], repository)).trim()
  if (!isAbsolute(path)) throw new WorkspaceError('无法确定共享 Git 元数据目录；请检查本地仓库。')
  return realpath(path)
}

/** Locks the canonical common-dir across processes so linked worktrees share the same preparation lock. */
export async function prepareGitWorktree(project: Project, directory: string, name: string, run: GitRunner, signal: AbortSignal): Promise<void> {
  const common = await commonDirectory(project.repository, run)
  let compromised: Error | undefined
  const release = await lock(common, { realpath: true, stale: 120_000, update: 10_000,
    retries: { retries: 20, minTimeout: 100, maxTimeout: 1000 }, onCompromised: error => { compromised = error } })
  try {
    signal.throwIfAborted()
    await run(['git', 'check-ref-format', '--branch', `agent/${name}`], project.repository)
    const base = (await run(['git', 'rev-parse', '--verify', '--end-of-options', `${project.ref}^{commit}`], project.repository)).trim()
    if (!/^[a-f0-9]{40,64}$/i.test(base)) throw new WorkspaceError(`基线 ${project.ref} 未解析到本地 commit；请先同步仓库。`)
    signal.throwIfAborted()
    await mkdir(dirname(directory), { recursive: true })
    signal.throwIfAborted()
    if (compromised) throw compromised
    await run(['git', 'worktree', 'add', '-b', `agent/${name}`, directory, base], project.repository)
    if (compromised) throw compromised
  } finally { await release() }
}

/** Verify the checkout itself, not an ancestor repository; do not reset a dirty worktree on retry. */
export async function verifyGitWorktree(project: Project, directory: string, name: string, run: GitRunner): Promise<void> {
  const top = (await run(['git', 'rev-parse', '--show-toplevel'], directory)).trim()
  const [wanted, actual] = await Promise.all([realpath(directory), realpath(top)])
  if (wanted !== actual) throw new WorkspaceError('工单目录不是 Git checkout 顶层；不会在父仓库中执行。')
  const [sourceCommon, ticketCommon] = await Promise.all([commonDirectory(project.repository, run), commonDirectory(directory, run)])
  if (sourceCommon !== ticketCommon) throw new WorkspaceError('工单 checkout 不属于配置的共享 Git 仓库。')
  const branch = (await run(['git', 'branch', '--show-current'], directory)).trim()
  if (branch !== `agent/${name}`) throw new WorkspaceError('工单分支与准备记录不一致；请人工确认，不会自动 checkout/reset。')
}
