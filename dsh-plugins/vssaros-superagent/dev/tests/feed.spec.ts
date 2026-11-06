// VsSaros addition (plan C): changes pushed to open pages over one event stream.
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { Feed } from '../src/app/feed.ts'

class Res extends EventEmitter {
  head?: { status: number; headers: Record<string, string> }
  text = ''
  ended = false
  writeHead(status: number, headers: Record<string, string>) { this.head = { status, headers }; return this }
  write(chunk: string) { this.text += chunk; return true }
  end() { this.ended = true; this.emit('close') }
}
const open = (feed: Feed) => { const req = new EventEmitter(), res = new Res(); feed.attach(req as never, res as never); return { req, res } }
afterEach(() => { vi.useRealTimers() })

it('streams change events, gathering the topics that changed in one moment, and keeps the stream open', () => {
  vi.useFakeTimers()
  const feed = new Feed(100, 20_000)
  feed.changed('steps')
  const { req, res } = open(feed)
  expect(res.head).toMatchObject({ status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform' } })
  expect(res.text).toBe('retry: 3000\n: open\n\n')
  feed.changed('steps'); feed.changed('tickets', 'steps'); feed.changed('steps')
  vi.advanceTimersByTime(99)
  expect(res.text).not.toContain('event:')
  vi.advanceTimersByTime(1)
  expect(res.text.split('event: change').length - 1).toBe(1)
  expect(res.text).toContain('data: {"topics":["steps","tickets"]}\n\n')
  vi.advanceTimersByTime(20_000)
  expect(res.text).toContain(': ping\n\n')
  // A closed page stops hearing; with none left, nothing is gathered.
  req.emit('close')
  expect(feed.size).toBe(0)
  feed.changed('desk')
  vi.advanceTimersByTime(200)
  expect(res.text).not.toContain('desk')
})

it('ends every stream when dsh-superagent stops', () => {
  const feed = new Feed()
  const one = open(feed), two = open(feed)
  expect(feed.size).toBe(2)
  feed.close()
  expect([one.res.ended, two.res.ended, feed.size]).toEqual([true, true, 0])
})
