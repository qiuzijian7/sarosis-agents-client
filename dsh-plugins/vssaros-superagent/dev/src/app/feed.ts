/**
 * VsSaros addition (plan C): what changed, pushed to the panel and to the cards in the supervisor desk's conversation as it
 * happens, instead of their polling. One `text/event-stream` response per open page: each `change` event names the topics
 * that changed in the last moment (`steps`: team steps, their Bots' work and requests; `tickets`: tickets, proposals and
 * decisions; `desk`: the desk conversation), and the page reads those again. A comment line every 20 seconds keeps the
 * connection open; a page that loses it reconnects and reads everything again.
 *
 * After DS Bot's live feed (ds-bot/src/host/feed.js, Copyright 2026 Fei2411 and the DS Bot contributors, Apache License 2.0;
 * see NOTICE): a Server-Sent Events stream of what changed, kept open by a comment line, read again by the page.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export const FEED_TOPICS = ['steps', 'tickets', 'desk'] as const
export type FeedTopic = typeof FEED_TOPICS[number]

/** The open streams, and the changes gathered for the next event. */
export class Feed {
  private readonly clients = new Set<ServerResponse>()
  private readonly pending = new Set<FeedTopic>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private beat: ReturnType<typeof setInterval> | undefined
  constructor(private readonly delayMs = 120, private readonly heartbeatMs = 20_000) {}

  /** Open streams now. */
  get size(): number { return this.clients.size }
  /** Marks topics changed; the open streams hear of them once, shortly after, however often they change meanwhile. */
  changed(...topics: FeedTopic[]): void {
    if (!this.clients.size) return
    for (const topic of topics) this.pending.add(topic)
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.delayMs)
    this.timer.unref?.()
  }
  /** Answers a request with a stream of change events until the page closes it. */
  attach(req: Pick<IncomingMessage, 'on'>, res: ServerResponse): void {
    // `no-transform` keeps a compressing web server from buffering the stream; `flush` sends what one buffered anyway.
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive',
      'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' })
    res.write('retry: 3000\n: open\n\n')
    this.clients.add(res)
    if (!this.beat) {
      this.beat = setInterval(() => { this.write(': ping\n\n') }, this.heartbeatMs)
      this.beat.unref?.()
    }
    const close = () => { this.drop(res) }
    req.on('close', close)
    res.on('close', close)
  }
  /** Ends every stream, as when dsh-superagent stops. */
  close(): void {
    clearTimeout(this.timer); this.timer = undefined
    for (const res of [...this.clients]) { this.drop(res); try { res.end() } catch { /* already closed */ } }
  }
  private flush(): void {
    this.timer = undefined
    if (!this.pending.size) return
    const topics = FEED_TOPICS.filter(topic => this.pending.has(topic))
    this.pending.clear()
    this.write(`event: change\ndata: ${JSON.stringify({ topics })}\n\n`)
  }
  private write(text: string): void {
    for (const res of [...this.clients]) {
      try { res.write(text); (res as { flush?: () => void }).flush?.() } catch { this.drop(res) }
    }
  }
  private drop(res: ServerResponse): void {
    this.clients.delete(res)
    if (!this.clients.size && this.beat) { clearInterval(this.beat); this.beat = undefined }
  }
}
