// VsSaros fix (2026-11-05): the supervisor's messages to the desk, written down first and delivered until the desk has them.
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { DeskOutbox, wakesDesk, type DeskOutboxHost } from '../src/app/desk-outbox.ts'
import type { OutboundMessage } from '../src/core/index.ts'

const channel = { source: 'superagent', thread: 'superagent:desk:desk-1', address: { kind: 'desk', session: 'desk-1' } }
const message = (id: string, kind: OutboundMessage['kind'] = 'notice', text = id): OutboundMessage => ({ id, channel, kind, text })

/** A desk whose conversation records a delivered message when `take` runs, as a turn taking it from the inbox does. */
function desk() {
  const ctx = new Context()
  const db = new DatabaseSync(':memory:')
  const conversation = new Set<string>(), inbox: string[] = []
  let gone = false, failing = false
  const emit = (id: string) => { (ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('session/event', { id: 'desk-1' }, { type: 'user/message', data: { id } }) }
  const take = () => { for (const id of inbox.splice(0)) { conversation.add(id); emit(id) } }
  const deliver = vi.fn(async (item: OutboundMessage) => {
    if (gone) return 'gone' as const
    if (failing) throw new Error('network')
    const id = `m:${item.id}`
    if (!conversation.has(id) && !inbox.includes(id)) inbox.push(id)
    return 'sent' as const
  })
  const host: DeskOutboxHost = { store: { db } as never, context: ctx, deskId: 'desk-1', deliver, closing: () => false, warn: vi.fn(),
    messageIdOf: item => `m:${item.id}`, recorded: async item => conversation.has(`m:${item.id}`) }
  const outbox = new DeskOutbox(host)
  return { ctx, outbox, deliver, take, inbox, conversation, emit, host,
    close: () => { inbox.length = 0; (ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('agent/disposed', { agent: { id: 'desk-1' } }) },
    set gone(value: boolean) { gone = value }, set failing(value: boolean) { failing = value } }
}
afterEach(() => { vi.useRealTimers() })

it('wakes the desk only for what needs the person\'s answer', () => {
  expect(wakesDesk(message('team-proposal:t1:v2'))).toBe(true)
  expect(wakesDesk(message('step-approval:a1'))).toBe(true)
  expect(wakesDesk(message('step-approval-which:x'))).toBe(true)
  expect(wakesDesk(message('r1', 'reply'))).toBe(true)
  expect(wakesDesk(message('ack1', 'acknowledgement'))).toBe(false)
  expect(wakesDesk(message('step-approval-answer:a1'))).toBe(false)
  expect(wakesDesk(message('pr-terminal'))).toBe(false)
  // VsSaros addition (2026-11-06): a desk ticket's end.
  expect(wakesDesk(message('ticket-ended:t1:2026-11-06T10:00:00.000Z'))).toBe(true)
})

it('writes a message down before delivering it, and counts it delivered once the desk\'s conversation has it', async () => {
  const d = desk()
  const stop = d.outbox.install()
  d.outbox.post(message('team-proposal:t1:v1'))
  await d.outbox.flush()
  expect(d.deliver).toHaveBeenCalledTimes(1)
  // Delivered to the inbox is not delivered yet.
  expect(d.outbox.entry('team-proposal:t1:v1')).toMatchObject({ state: 'pending', tries: 0 })
  d.take()
  expect(d.outbox.entry('team-proposal:t1:v1')?.state).toBe('recorded')
  expect(d.outbox.pending()).toEqual([])
  // Posting it again changes nothing.
  d.outbox.post(message('team-proposal:t1:v1'))
  await d.outbox.flush()
  expect(d.deliver).toHaveBeenCalledTimes(1)
  stop()
})

it('delivers again, oldest first, what the desk Session dropped with its inbox, on a start and after it closes', async () => {
  vi.useFakeTimers()
  const d = desk()
  d.outbox.post(message('a', 'reply'), '2026-11-05T10:00:00.000Z')
  d.outbox.post(message('b', 'reply'), '2026-11-05T10:00:01.000Z')
  await d.outbox.flush()
  expect(d.inbox).toEqual(['m:a', 'm:b'])
  // The Host stops: the inbox is gone, the outbox is not. The next start delivers both again, in order.
  d.inbox.length = 0
  const next = new DeskOutbox(d.host)
  const stop = next.install()
  await next.flush()
  expect(d.inbox).toEqual(['m:a', 'm:b'])
  d.take()
  expect(next.pending()).toEqual([])
  // One the conversation recorded before a restart is not delivered again; one still pending when the desk closes is.
  next.post(message('c', 'reply'))
  await next.flush()
  const before = d.deliver.mock.calls.length
  d.close()
  expect(d.inbox).toEqual([])
  await vi.advanceTimersByTimeAsync(1100)
  await next.flush()
  expect(d.inbox).toEqual(['m:c'])
  expect(new Set(d.deliver.mock.calls.slice(before).map(([item]) => item.id))).toEqual(new Set(['c']))
  stop()
})

it('keeps a message pending when its delivery fails, and stops there so later ones do not overtake it', async () => {
  const d = desk()
  d.failing = true
  d.outbox.post(message('a', 'reply'), '2026-11-05T10:00:00.000Z')
  d.outbox.post(message('b', 'reply'), '2026-11-05T10:00:01.000Z')
  await d.outbox.flush()
  expect(d.outbox.entry('a')).toMatchObject({ state: 'pending', error: 'Error: network' })
  expect(d.outbox.entry('a')!.tries).toBeGreaterThan(0)
  expect(d.deliver.mock.calls.every(([item]) => item.id === 'a')).toBe(true)
  d.failing = false
  d.gone = true
  await d.outbox.flush()
  expect(d.outbox.entry('a')?.error).toContain('does not exist')
  d.gone = false
  await d.outbox.flush()
  expect(d.inbox).toEqual(['m:a', 'm:b'])
  expect(d.host.warn).toHaveBeenCalled()
})
