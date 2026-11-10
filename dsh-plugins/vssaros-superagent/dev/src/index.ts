/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { loadHostModules } from './infra/host.ts'
import { Config, machineOf, type DeploymentConfig, type Machine } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }

/**
 * ★ 2026-11-10（门禁红灯修复）：`apply` 只用到 Runtime 的这四个成员，把它做成可注入的工厂。
 *   真实 Host 调用 `apply(ctx, config)` 完全不变（默认构造真实 Runtime）；测试可传入轻量替身，
 *   不再依赖 `vi.mock` —— 本环境 Vitest 4.1.8 的 mock registry 实测不生效，导致 2 个用例
 *   拿到真实 Runtime 后在 `ctx.reflect.provide` 上崩掉。
 */
export interface AppliedRuntime {
  ready: Promise<void>
  configured(): boolean
  stop(): Promise<void> | void
  setupProblem?: { detail?: string }
}
export type RuntimeFactory = (ctx: Context, machine: Machine, restart: () => void) => AppliedRuntime

export async function apply(ctx: Context, config: DeploymentConfig,
  createRuntime: RuntimeFactory = (c, m, r) => new Runtime(c, m, r)): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // VsSaros addition (built-in packaging): the Host's own DSH modules that are read synchronously later (see infra/host.ts).
  const missing = await loadHostModules()
  if (missing.length) ctx.logger.warn('dsh-superagent: Host modules not found (%s); the main Session keeps every tool it has', missing.join(', '))
  const runtime = createRuntime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
