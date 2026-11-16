import { expect, it, vi } from 'vitest'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { bindPresetPtcRuntime, ptcDenial, installWorkerPtc } from '../src/app/worker-ptc.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

it('refuses missing confinement, configured P4, escalation and absent/excessive timeouts', () => {
  expect(ptcDenial('read', {}, undefined, false)).toBeUndefined()
  expect(ptcDenial('run_code', { timeoutMs: 30000 }, 'workspace-write', false)).toBeUndefined()
  expect(ptcDenial('run_code', { timeoutMs: 30000 }, 'danger-full-access', false)).toContain('confined')
  expect(ptcDenial('run_code', { timeoutMs: 30000 }, 'workspace-write', true)).toContain('P4')
  expect(ptcDenial('run_code', { timeoutMs: 30000, sandbox_permissions: 'danger-full-access' }, 'workspace-write', false)).toContain('escalation')
  for (const timeoutMs of [undefined, 0, 30001, Infinity]) expect(ptcDenial('run_code', { timeoutMs }, 'workspace-write', false)).toContain('timeoutMs')
})

it('fails closed when official services are missing instead of installing a fallback', async () => {
  const agent = { ctx: { get: () => undefined } } as unknown as Agent
  const loader = vi.fn(async () => undefined)
  await expect(installWorkerPtc(agent, () => SettingsSchema.parse({}), loader)).rejects.toThrow('No native fallback')
  expect(loader).not.toHaveBeenCalled()
})

/** Use actual installed rc.2 dispatchers, not the alpha dev copy or fixture direct tool.execute helper. */
async function official() {
  const base = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../dsh-runtime/0.2.2-rc.2/node_modules/@deepseek-ai')
  const module = (name: string) => import(pathToFileURL(resolve(base, name, 'lib/index.js')).href)
  const [cordis, tools, ptc] = await Promise.all([module('cordis'), module('dsh-tools'), module('dsh-tool-executor-ptc')])
  return { cordis, tools, ptc }
}

it('binds the worker to its own preset runtime realm without changing router or root services', async () => {
  const { cordis } = await official()
  const root = new cordis.Context()
  const preset = root.isolate('ptcRuntime')
  const runtime = { ctx: preset, language: 'typescript' }
  preset.reflect.provide('ptcRuntime', runtime)
  root.reflect.provide('agentPresets', { serviceFor: () => runtime })
  const worker = root.extend({}), router = root.extend({})
  expect(worker.get('ptcRuntime')).toBeUndefined()
  const restore = bindPresetPtcRuntime({ ctx: worker } as Agent)
  expect(worker.get('ptcRuntime')?.language).toBe('typescript')
  expect(router.get('ptcRuntime')).toBeUndefined()
  expect(root.get('ptcRuntime')).toBeUndefined()
  restore()
  expect(worker.get('ptcRuntime')).toBeUndefined()
})

it('does not install an executor after the worker binding was released during module loading', async () => {
  const setExecutor = vi.fn(), guard = vi.fn()
  const services: Record<string, unknown> = { ptcRuntime: { language: 'typescript', isolation: 'process', sandboxMode: 'workspace-write', timeout: { maxMs: 30000 } },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, workingDirectory: {} }
  const agent = { ctx: { get: (name: string) => services[name], tools: { setExecutor, guard } }, session: {} } as unknown as Agent
  await expect(installWorkerPtc(agent, () => SettingsSchema.parse({}), async () => undefined, () => false)).rejects.toThrow('setup cancelled')
  expect(setExecutor).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled()
})

it('runs nested SDK calls through the real official guard pipeline and refuses denied calls before their bodies', async () => {
  const { cordis, tools: module, ptc } = await official()
  const ctx = new cordis.Context()
  ctx.reflect.provide('systemPrompt', { tools: () => {}, getSectionOrder: () => 10, section: () => () => {} })
  const tools = new module.ToolsService(ctx)
  const body = vi.fn(async () => 'result')
  tools.register({ name: 'read', description: 'read', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] }, execute: body })
  const pending: { name: string; parent?: object }[] = []
  ctx.on('tools/pre-execute', async (execution: { name: string; parent?: object }, next: () => Promise<unknown>) => { pending.push(execution); return next() })
  let denied = true
  tools.guard((execution: { name: string }) => denied && execution.name === 'read' ? 'ticket permission denied' : undefined)
  ctx.reflect.provide('ptcRuntime', {
    language: 'typescript', programFormat: 'async-function-body', retainsState: false, timeout: { defaultMs: 30000, maxMs: 30000 },
    executionInstructions: '', resolve: (request: Record<string, unknown>) => ({ ...request, cwd: process.cwd(), timeoutMs: 30000 }),
    run: async (spec: { bindings: { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) => {
      try { await spec.bindings[0]!.functions.read!({}) } catch { return { logs: [], value: 'caught' } }
      return { logs: [], value: 'unexpected' }
    }, release: async () => {},
  })
  const executor = new ptc.PtcExecutor(ctx, { maxSubCallsPerMinute: 64, maxParallelSubCalls: 4 })
  const result = await executor.execute({ calls: [{ type: 'tool_call', id: 'root', name: 'run_code', arguments: { code: 'SDK program', description: 'test', timeoutMs: 30000 } }], signal: new AbortController().signal })
  expect(result.results[0]?.result.isError).toBe(false)
  expect(body).not.toHaveBeenCalled()
  expect(pending.find(execution => execution.name === 'read')?.parent).toBeDefined()
  const native = await executor.execute({ calls: [{ type: 'tool_call', id: 'native', name: 'read', arguments: {} }], signal: new AbortController().signal })
  expect(native.results[0]?.result.isError).toBe(true)
  expect(body).not.toHaveBeenCalled()
  denied = false
  const allowed = await executor.execute({ calls: [{ type: 'tool_call', id: 'allowed', name: 'run_code', arguments: { code: 'SDK program', description: 'test', timeoutMs: 30000 } }], signal: new AbortController().signal })
  expect(allowed.results[0]?.result.isError).toBe(false)
  expect(body).toHaveBeenCalledOnce()
})
