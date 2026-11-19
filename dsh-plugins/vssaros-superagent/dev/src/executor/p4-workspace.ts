/** Read-only preflight for operator-prepared P4 ticket workspaces; never syncs, edits or changes a client. */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { Ticket } from '../core/index.ts'
import { changesOf, filesOf, fingerprint, inPath, ticketClient, type P4Config } from '../sources/p4-change.ts'
import type { GitRunner } from './git-workspace.ts'
import { WorkspaceError } from './workspace.ts'
import type { RetainedChange } from './p4-retained.ts'

export async function verifyP4Workspace(ticket: Ticket, config: P4Config, run: GitRunner, retained: readonly RetainedChange[] = []): Promise<string> {
  const directory = ticket.execution?.directory
  if (!directory || !config.port || !config.user || !config.paths.length) throw new WorkspaceError('请配置 P4 服务器、执行账号和允许路径。')
  const base = [config.cli || 'p4', '-p', config.port, '-u', config.user, '-Mj', '-ztag']
  const records = async (args: string[], cwd = directory): Promise<Record<string, string>[]> => {
    const output = await run([...base, ...args], cwd).catch(error => { throw new WorkspaceError('P4 登录、映射或只读查询失败；请核对执行账号和本单 client。', error) })
    return output.split(/\r?\n/).filter(line => line.trim()).flatMap(line => {
      const record = JSON.parse(line) as Record<string, string>
      if (record.severity !== undefined) {
        if (Number(record.severity) >= 3) throw new WorkspaceError(`P4 预检失败：${String(record.data ?? '').slice(0, 250)}`)
        return []
      }
      return [record]
    })
  }
  const shared = ticket.execution?.p4Workspace
  if (shared && (shared.port !== config.port || shared.user !== config.user || shared.client !== config.executionClient || shared.root !== config.workspaceRoot || config.workspaceMode !== 'current')) throw new WorkspaceError('当前 P4 配置已改变；请人工确认，不能迁移已有工单。')
  if (shared && ticket.team) throw new WorkspaceError('当前 P4 工作区只支持单 worker 串行执行；请使用单工单流程。')
  const clients = shared ? [{ client: shared.client }] : (await records(['clients', '-u', config.user])).filter(client => ticketClient(ticket, client.client ?? ''))
  if (clients.length !== 1 || !clients[0]?.client) throw new WorkspaceError('未找到唯一的本工单 P4 client；请配置执行工作区或准备独立 client。')
  const name = clients[0]!.client!
  const spec = (await records(['client', '-o', name]))[0]
  if (!spec || spec.Owner !== config.user || spec.Client !== name || !isAbsolute(spec.Root ?? '')) throw new WorkspaceError('P4 client 账号或根目录不符，请人工核对。')
  const root = await realpath(spec.Root!), parent = await realpath(directory)
  const rel = relative(parent, root)
  if (rel !== '') throw new WorkspaceError('本工单 P4 Root 必须等于执行目录，worker 才能在正确源码目录工作；不会使用共享主目录。')
  const login = await records(['-c', name, 'login', '-s'], root)
  if (!login.length) throw new WorkspaceError('P4 执行账号登录状态无法确认，请在 Host 用户环境登录。')
  if (shared) {
    const own = new Set(changesOf(ticket, true).map(String))
    const opened = await records(['-c', name, 'opened'], root)
    const preserved = new Map(retained.map(change => [String(change.change), change]))
    if (opened.some(file => !own.has(file.change ?? '') && !preserved.get(file.change ?? '')?.files.some(known => known.depotFile === file.depotFile && known.action === file.action)))
      throw new WorkspaceError('当前工作区已有未归属本单的 opened 文件；请先保存并人工处理，不会自动 revert 或接管。')
    for (const previous of retained.filter(change => opened.some(file => file.change === String(change.change)))) {
      const description = (await records(['-c', name, 'describe', '-s', '-S', String(previous.change)], root))[0]
      if (!description || description.status !== 'pending' || description.client !== name || description.user !== config.user
        || !description.desc?.split(/\s+/).includes(`[dsh-superagent:${previous.ticketId}]`) || fingerprint(filesOf(description)) !== previous.fingerprint) throw new WorkspaceError('前序pending交付已改变，不能接管其修改。')
    }
    // Unopened differences are generated constantly by UE/Python tooling in an allwrite client; scanning every
    // launch blocked unrelated build artifacts. Strict mode is an explicit operator choice, off by default.
    if (config.checkUnopenedDiffs) {
      const dirty: string[] = []
      for (const allowed of config.paths) {
        for (const file of await records(['-c', name, 'diff', '-se', allowed.path], root)) {
          if (file.depotFile && !dirty.includes(file.depotFile)) dirty.push(file.depotFile)
        }
      }
      if (dirty.length) {
        const generated = dirty.filter(file => /(?:\/__pycache__\/|\/Binaries\/|\/Intermediate\/|\/Saved\/|\.(?:pyc|dll|pdb|lib|exe|obj|o)(?:$|\s))/i.test(file))
        const source = dirty.filter(file => !generated.includes(file))
        throw new WorkspaceError(`严格预检：${dirty.length} 个未签出差异（生成物 ${generated.length}、源码/资源 ${source.length}），例如 ${dirty.slice(0, 8).join('、')}；请先人工处理，不会覆盖。`)
      }
    }
  }
  let have: Record<string, string> | undefined
  for (const allowed of config.paths) {
    have = (await records(['-c', name, 'fstat', '-Rh', '-m', '1', '-T', 'depotFile,clientFile,haveRev', allowed.path], root))[0]
    if (have?.clientFile && Number(have.haveRev) > 0) break
  }
  if (!have?.clientFile || Number(have.haveRev) <= 0 || !have.depotFile || !config.paths.some(item => inPath(have!.depotFile!, item.path))) throw new WorkspaceError('P4 工作区没有允许范围内的已同步文件，请准备并同步本单源码后重试。')
  const file = await realpath(have.clientFile), fileRel = relative(root, file)
  if (fileRel === '..' || fileRel.startsWith(`..${sep}`) || isAbsolute(fileRel) || !(await stat(file)).isFile()) throw new WorkspaceError('P4 have 记录对应源码文件不存在或位于工作区外。')
  return name
}
