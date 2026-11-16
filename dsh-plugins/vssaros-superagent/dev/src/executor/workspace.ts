/** Durable preparation and non-destructive validation of each ticket's execution directory. */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import type { Store } from '../app/store.ts'
import type { Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import { executionRoot } from '../app/execution-environment.ts'

export interface WorkspacePreparation {
  directory: string
  state: 'preparing' | 'ready' | 'failed'
  configuration: string
  origin: 'prepared' | 'existing'
  at: string
  error?: string
  failurePhase?: 'prepare' | 'verify'
}

/** Only the operator's local Source config may override the execution root; incoming meta.workspace is not a path. */
export function ticketDirectory(settings: Settings, stateDir: string, name: string, origin?: Trigger): string {
  const configured = origin?.source === 'superagent' ? settings.sources.superagent?.config.workspace : undefined
  const root = typeof configured === 'string' && configured.trim() ? configured.trim() : executionRoot(settings, stateDir)
  if (!isAbsolute(root) && !win32.isAbsolute(root)) throw new Error('工作区未配置：执行根必须是绝对路径，请在「设置 → 执行」或本地来源设置中配置。')
  return win32.isAbsolute(root) && !isAbsolute(root) ? win32.join(root, name) : join(root, name)
}

/** A directory failure must wait for operator repair, rather than retrying a destructive prepare command blindly. */
export class WorkspaceError extends Error {
  constructor(message: string, cause?: unknown) { super(`工作区未就绪：${message}`, { cause }); this.name = 'WorkspaceError' }
}

type DirectoryStat = (directory: string) => Promise<{ isDirectory(): boolean }>

async function directoryExists(directory: string, inspect: DirectoryStat): Promise<boolean> {
  try {
    const info = await inspect(directory)
    if (!info.isDirectory()) throw new WorkspaceError(`目标不是目录：${directory}`)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    if (error instanceof WorkspaceError) throw error
    throw new WorkspaceError(`无法访问 ${directory}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Serializes preparation for a ticket within the state-locked Runtime; it is not a lock for shared Git/P4 repositories. */
export class TicketWorkspaces {
  private readonly pending = new Map<string, Promise<void>>()
  constructor(private readonly store: Pick<Store, 'get' | 'set'>, private readonly inspect: DirectoryStat = stat) {}

  ensure(ticketId: string, path: string, command: string, prepare: () => Promise<void>, verify: () => Promise<void>, allowPrepare = true): Promise<void> {
    const active = this.pending.get(ticketId)
    if (active) return active.then(() => this.ensure(ticketId, path, command, prepare, verify, allowPrepare))
    const operation = this.check(ticketId, path, command, prepare, verify, allowPrepare)
    this.pending.set(ticketId, operation)
    return operation.finally(() => { if (this.pending.get(ticketId) === operation) this.pending.delete(ticketId) })
  }

  private async check(ticketId: string, path: string, command: string, prepare: () => Promise<void>, verify: () => Promise<void>, allowPrepare: boolean): Promise<void> {
    if (!path || !isAbsolute(path)) throw new WorkspaceError('执行目录必须是本机绝对路径；请检查项目映射，不会自动迁移已有工单。')
    const directory = resolve(path)
    const key = KV.executor.workspace(ticketId)
    const previous = this.store.get(key)
    if (previous && previous.directory !== directory) throw new WorkspaceError('工单目录与准备记录不一致；请核对现场，不会自动重绑定或覆盖。')
    const exists = await directoryExists(directory, this.inspect)
    if (!exists && (previous?.state === 'ready' || previous?.failurePhase === 'verify')) throw new WorkspaceError(`原工作区已丢失：${directory}。请恢复现场；不会创建空目录代替。`)
    if (previous?.state === 'preparing') throw new WorkspaceError(`上次准备失败或中断：${directory}。准备结果不确定，请人工核对现场和准备记录后恢复；不会自动重跑命令。`)
    if (exists && previous?.state === 'failed' && previous.failurePhase !== 'verify') throw new WorkspaceError(`上次准备失败或中断，现场保留：${directory}。请检查并恢复现场，或在备份后移走残留再重试。${previous.error ? ` 原因：${previous.error}` : ''}`)
    if (!exists && !allowPrepare) throw new WorkspaceError(`执行目录不存在：${directory}。请恢复现场；消息投递不会重新运行准备命令。`)
    const configuration = exists && previous ? previous.configuration : createHash('sha256').update(command).digest('hex')
    const origin = previous?.origin ?? (exists ? 'existing' : 'prepared')
    let phase: 'prepare' | 'verify' = exists ? 'verify' : 'prepare'
    const save = (state: WorkspacePreparation['state'], error?: string) => this.store.set(key, {
      directory, configuration, origin, state, at: new Date().toISOString(), ...(error ? { error, failurePhase: phase } : {}),
    })
    if (!exists) save('preparing')
    try {
      if (!exists) await prepare()
      if (!await directoryExists(directory, this.inspect)) throw new WorkspaceError(`准备命令未生成目录：${directory}`)
      phase = 'verify'
      await verify()
      save('ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      save('failed', message)
      throw error instanceof WorkspaceError ? error : new WorkspaceError(message, error)
    }
  }
}
