/** Worker-only official PTC pilot. Mode is frozen per ticket; no in-turn switching or host eval. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Settings } from '../policy.ts'
import { loadHostPtc } from '../infra/host.ts'

export const WORKER_PTC_TIMEOUT_MS = 30_000
interface BatchInput { calls: readonly unknown[]; signal: AbortSignal; agent?: Agent; toolSet?: unknown; maxParallelToolCalls?: number; log?: { turn: number; step: number } }
interface OfficialExecutor {
  sections?: readonly { name: string; order: number; interpolate?: boolean; text: string | ((tools: readonly ToolDefinition[]) => string) }[]
  describe(tools: readonly ToolDefinition[]): unknown
  execute(input: BatchInput): Promise<unknown>
}
export interface OfficialPtcModule { PtcExecutor: new (ctx: Context, config: { maxSubCallsPerMinute: number; maxParallelSubCalls: number }, parallel: () => number) => OfficialExecutor }
interface RuntimeCapability { language: string; isolation: string; sandboxMode?: string; timeout?: { maxMs: number }; ctx: Context }

/** Join only this worker to its preset's isolated runtime; preserve the executor's Agent scope. */
export function bindPresetPtcRuntime(agent: Agent): () => void {
  const ctx = agent.ctx
  const presets = ctx.get('agentPresets') as { serviceFor?: (agent: Agent, name: string) => RuntimeCapability | undefined } | undefined
  const runtime = presets?.serviceFor?.(agent, 'ptcRuntime')
  if (!runtime) throw new Error('Worker preset PTC runtime unavailable; no native fallback was applied.')
  const key = Symbol.for('cordis.isolate')
  const target = ctx as unknown as Record<symbol, Record<string, symbol>>
  const source = runtime.ctx as unknown as Record<symbol, Record<string, symbol>>
  const label = source[key]?.ptcRuntime
  if (!label) throw new Error('Worker PTC runtime must be isolated in its preset.')
  const previous = target[key]
  const joined = (ctx as unknown as { isolate(name: string, label: symbol): Record<symbol, Record<string, symbol>> }).isolate('ptcRuntime', label)[key]!
  target[key] = joined
  return () => { if (target[key] === joined) target[key] = previous! }
}
interface Policy { resolve(input: { session: Agent['session'] }): { mode: string } }

/** Checks every outer program; SDK subcalls are still independently guarded by the official pipeline. */
export function ptcDenial(name: string, args: unknown, mode: string | undefined, p4Configured: boolean): string | undefined {
  if (name !== 'run_code') return undefined
  if (p4Configured) return 'PTC pilot does not run with configured P4 execution; use a native worker so changelist policy cannot be bypassed by direct program I/O.'
  if (mode !== 'workspace-write' && mode !== 'read-only') return 'PTC requires a confined file policy; danger-full-access is not supported by this pilot.'
  const value = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  if (value.sandbox_permissions !== undefined || value.justification !== undefined) return 'PTC pilot does not permit program permission escalation.'
  if (typeof value.timeoutMs !== 'number' || !Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0 || value.timeoutMs > WORKER_PTC_TIMEOUT_MS) {
    return 'Set timeoutMs explicitly to a positive value no greater than 30000 in each run_code call.'
  }
  return undefined
}

export async function installWorkerPtc(agent: Agent, settings: () => Settings,
  load: () => Promise<OfficialPtcModule | undefined> = loadHostPtc, active: () => boolean = () => true): Promise<() => void> {
  const ctx = agent.ctx
  const runtime = ctx.get('ptcRuntime') as RuntimeCapability | undefined
  if (!runtime || runtime.language !== 'typescript' || runtime.isolation !== 'process' || !runtime.timeout || runtime.sandboxMode === undefined) {
    throw new Error('Worker PTC unavailable: the Host must provide the official confined Node PTC process runtime. No native fallback was applied.')
  }
  const policy = ctx.get('sandboxPolicy') as Policy | undefined
  if (!policy || !ctx.get('workingDirectory')) throw new Error('Worker PTC requires sandboxPolicy and workingDirectory services.')
  const p4 = () => {
    const source = settings().sources.p4
    return !!source?.enabled && typeof source.config.port === 'string' && !!source.config.port.trim()
  }
  const denied = ptcDenial('run_code', { timeoutMs: WORKER_PTC_TIMEOUT_MS }, policy.resolve({ session: agent.session }).mode, p4())
  if (denied) throw new Error(denied)
  const module = await load()
  if (!active()) throw new Error('Worker PTC setup cancelled: agent binding was released.')
  if (!module) throw new Error('Worker PTC unavailable: official dsh-tool-executor-ptc was not resolved from the Host. No bundled substitute was applied.')
  const executor = new module.PtcExecutor(ctx, { maxSubCallsPerMinute: 64, maxParallelSubCalls: 4 }, () => 1)
  const tools = ctx.tools as unknown as { setExecutor(executor: OfficialExecutor): () => void }
  if (typeof tools.setExecutor !== 'function') throw new Error('Worker PTC requires the rc.2 scoped tool executor API.')
  const releases: (() => void)[] = []
  try {
    releases.push(ctx.tools.guard(({ name, arguments: args }) => ptcDenial(name, args, policy.resolve({ session: agent.session }).mode, p4())))
    releases.push(tools.setExecutor({
      sections: [...executor.sections ?? [], { name: 'superagent-worker-ptc', order: 9997, interpolate: false,
        text: 'PTC pilot: use run_code with explicit timeoutMs <= 30000; at most 32 SDK calls per 30-second run and 4 concurrency-safe subcalls overlap. Batch independent reads, filter intermediate results, return only a summary. Do not poll without a state change or blindly retry writes. Use SDK tools rather than raw file/network/process I/O. File policy does not isolate network or process visibility. This pilot does not support P4 or permission escalation. Completed side effects are not rolled back on script failure.' }],
      describe: tools => executor.describe(tools),
      execute: input => executor.execute({ ...input, maxParallelToolCalls: 1 }),
    }))
  } catch (error) { for (const release of releases.reverse()) release(); throw error }
  return () => { for (const release of releases.reverse()) release() }
}
