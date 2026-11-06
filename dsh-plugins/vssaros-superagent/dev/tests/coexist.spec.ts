// VsSaros addition (2026-11-06, P3 · co-install): DS Bot in the same Host is found and said, and a request it sends again
// is metered once.
import { afterEach, expect, it } from 'vitest'
import { coexistenceOf, DS_BOT_EFFECTS } from '../src/app/coexist.ts'
import { stepUsageStream } from '../src/app/steps.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const loader = (entries: { name: string; disabled?: boolean }[]) => ({ *entries() { for (const { name, disabled } of entries) yield { options: { name, disabled } } } })

it('finds an enabled ds-bot loader entry, and nothing in a Host without a loader or with ds-bot off', () => {
  expect(coexistenceOf(undefined)).toEqual({})
  expect(coexistenceOf({})).toEqual({})
  expect(coexistenceOf(loader([{ name: 'vssaros-agents' }]))).toEqual({})
  expect(coexistenceOf(loader([{ name: 'ds-bot', disabled: true }]))).toEqual({})
  expect(coexistenceOf(loader([{ name: 'vssaros-agents' }, { name: 'ds-bot' }]))).toEqual({ dsBot: { effects: [...DS_BOT_EFFECTS] } })
  expect(coexistenceOf({ entries() { throw new Error('not ready') } })).toEqual({})
})

it('meters a step call once when another listener sends it again as a new call, as DS Bot\'s secrets and images listeners do', async () => {
  const metered: number[] = []
  const meter = stepUsageStream((_id, usage) => { metered.push(usage.inputTokens ?? 0) })
  const model = async function* () { yield { type: 'text-delta', text: 'x' }; yield { type: 'usage', usage: { inputTokens: 7 } } }
  // The waterfall: this listener, then one that sends the request again through the whole waterfall (this listener too).
  const waterfall = (options: { sessionId: string; again?: boolean }): AsyncIterable<unknown> =>
    meter(options, () => options.again ? model() : waterfall({ ...options, again: true })) as AsyncIterable<unknown>
  const chunks: unknown[] = []
  for await (const chunk of waterfall({ sessionId: 'step-abc-T1' })) chunks.push(chunk)
  expect(chunks).toHaveLength(2)
  expect(metered).toEqual([7])
  // Two separate calls are two.
  for await (const _ of waterfall({ sessionId: 'step-abc-T1' })) { /* drain */ }
  expect(metered).toEqual([7, 7])
})

it('shows on the overview that DS Bot shares the Host, once it is in the loader', async () => {
  h = await startRuntime()
  const overview = async () => (await h!.api('GET', 'overview')).body as unknown as { coexist: unknown }
  expect((await overview()).coexist).toEqual({})
  h.ctx.reflect.provide('loader', loader([{ name: 'ds-bot' }]) as never)
  expect((await overview()).coexist).toEqual({ dsBot: { effects: ['secrets', 'images', 'skills'] } })
})
