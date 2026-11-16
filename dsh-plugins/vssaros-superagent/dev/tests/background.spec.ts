/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { stopBackground, stopSubagents, untilQuiet, workerErrorDetail } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForChildren: (agent: Agent) => Promise<boolean>, drainChildren: () => Promise<void> = async () => {}) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const subagents = { waitForChildren: vi.fn(waitForChildren), listChildren: async () => [{ id: 'child-1' }], drainChildren: vi.fn(drainChildren) }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const ctx = { get: (name: string) => services[name], agents: { get: () => agent } } as unknown as Context
  return { ctx, agent, jobs, subagents }
}

function rc2Setup() {
  const { ctx, agent, jobs } = setup(async () => false)
  const subagents = {
    waitForTreeWork: vi.fn(async () => false), drainDescendants: vi.fn(async (_roots: readonly Agent[]) => {}),
    listDescendants: vi.fn(async (_root: string, _signal?: AbortSignal): Promise<{ id: string; kind: 'child' | 'diagnostic' }[]> => []),
    interrupt: vi.fn((_id: string, _authority: { kind: 'ancestor'; agent: Agent }) => {}),
  }
  const context = { ...ctx, get: (name: string) => name === 'subagents' ? subagents : ctx.get(name) } as unknown as Context
  return { ctx: context, agent, jobs, subagents }
}

it('reproduces the removed-method failure against the shipped rc.2 service and stops an empty tree with its real methods', async () => {
  const url = new URL('../../../../dsh-runtime/0.2.2-rc.2/node_modules/@deepseek-ai/dsh-subagent/lib/index.js', import.meta.url)
  const { SubagentRuntime } = await import(url.href)
  const service = Object.create(SubagentRuntime.prototype)
  expect(service.listChildren).toBeUndefined()
  expect(() => service.listChildren('worker-t1')).toThrow(TypeError)
  const { ctx, agent } = setup(async () => false)
  const context = { ...ctx, get: (name: string) => name === 'subagents' ? service : ctx.get(name) } as unknown as Context
  expect(await untilQuiet(context, agent, new AbortController().signal)).toBe(true)
  await expect(stopBackground(context, agent.id, 'completed', false, true)).resolves.toBeUndefined()
})

it('uses rc.2 tree wait and terminal drain with no legacy listChildren method or live child', async () => {
  const { ctx, agent, subagents } = rc2Setup()
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(true)
  await stopBackground(ctx, agent.id, 'ticket completed', false, true)
  expect(subagents.waitForTreeWork).toHaveBeenCalledWith(agent)
  expect(subagents.drainDescendants).toHaveBeenCalledWith([agent])
  expect(subagents.listDescendants).not.toHaveBeenCalled()
})

it('interrupts descendants under the exact ancestor authority on retries without closing admission', async () => {
  const { ctx, agent, subagents } = rc2Setup()
  subagents.listDescendants.mockResolvedValue([{ id: 'child', kind: 'child' }, { id: 'grandchild', kind: 'child' }])
  await stopBackground(ctx, agent.id, 'retry', true)
  expect(subagents.drainDescendants).not.toHaveBeenCalled()
  expect(subagents.interrupt.mock.calls).toEqual([['child', { kind: 'ancestor', agent }], ['grandchild', { kind: 'ancestor', agent }]])
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  expect(subagents.waitForTreeWork).toHaveBeenCalledWith(agent)
})

it('keeps true cleanup errors nested and still attempts subagent cleanup when jobs failed', async () => {
  const { ctx, agent, jobs, subagents } = rc2Setup()
  jobs.service.list.mockImplementation(() => { throw new Error('job registry unavailable') })
  subagents.drainDescendants.mockRejectedValue(new TypeError('descendant stop failed'))
  try { await stopBackground(ctx, agent.id, 'completed', false, true); expect.unreachable() }
  catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    expect(workerErrorDetail(error)).toContain('job registry unavailable')
    expect(workerErrorDetail(error)).toContain('descendant stop failed')
  }
  expect(subagents.drainDescendants).toHaveBeenCalledOnce()
})

it('reports bounded rc.2 cleanup timeout instead of claiming successful stop', async () => {
  const { ctx, agent, subagents } = rc2Setup()
  subagents.drainDescendants.mockImplementation(() => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const stopped = expect(stopSubagents(ctx, agent, false, true)).rejects.toThrow('cleanup is unverified')
    await vi.advanceTimersByTimeAsync(10000)
    await stopped
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalled()
})

it('bounds cyclic aggregate diagnostics and redacts credential assignments', () => {
  const error = new AggregateError([new Error('token=private password:secret')], 'stop failed')
  error.errors.push(error)
  const detail = workerErrorDetail(error)
  expect(detail).toContain('[redacted]')
  expect(detail).not.toMatch(/private|:secret/)
  expect(detail.length).toBeLessThanOrEqual(1200)
})

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup(async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); (agent as { status: string }).status = 'running'
    return false
  })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup(() => { joining(); return new Promise(() => {}) })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForChildren).toHaveBeenCalledTimes(1)
})

it('gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke', async () => {
  const { ctx, agent } = setup(async () => false, () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let stopped = false
    const stopping = stopSubagents(ctx, agent).then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})
