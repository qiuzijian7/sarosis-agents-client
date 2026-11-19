/** Explicit loopback CDP override. Default discovery/launch is owned by the Host browser service. */
import { CDP_DOM_EXPRESSION } from './tapd-filter-schemes.ts'
import { tapdFilterRowsReady } from '../../../../vssaros-browser/lib/core/tapdFilters.js'

interface Socket {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
}
type SocketConstructor = new (url: string) => Socket
interface CdpReply { id?: number; error?: { message?: string }; result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } } }

export async function scrapeConditionsViaCdp(base: string, url: string, timeoutMs = 25_000): Promise<unknown> {
  const endpoint = new URL(base)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !['http:', 'https:'].includes(endpoint.protocol))
    throw new Error('CDP endpoint must be a loopback HTTP address')
  const root = base.replace(/\/$/, ''), deadline = Date.now() + timeoutMs
  const created = await fetch(`${root}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(timeoutMs) })
  if (!created.ok) throw new Error(`CDP /json/new: HTTP ${created.status}`)
  const target = await created.json() as { webSocketDebuggerUrl?: string; id?: string }
  let ws: Socket | undefined
  const pending = new Map<number, { resolve: (reply: CdpReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  try {
    if (!target.webSocketDebuggerUrl) throw new Error('CDP target has no webSocketDebuggerUrl')
    const WS = (globalThis as unknown as { WebSocket?: SocketConstructor }).WebSocket
    if (!WS) throw new Error('WebSocket is unavailable in this Host')
    ws = new WS(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), Math.max(1, deadline - Date.now()))
      ws!.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws!.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed')) })
    })
    let nextId = 0
    ws.addEventListener('message', event => {
      let reply: CdpReply
      try { reply = JSON.parse(String(event.data ?? '{}')) as CdpReply } catch { return }
      if (reply.id === undefined) return
      const task = pending.get(reply.id)
      if (!task) return
      pending.delete(reply.id); clearTimeout(task.timer)
      if (reply.error) task.reject(new Error(reply.error.message ?? 'CDP command failed'))
      else task.resolve(reply)
    })
    const command = (method: string, params: Record<string, unknown> = {}) => new Promise<CdpReply>((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timeout`)) }, Math.max(1, deadline - Date.now()))
      pending.set(id, { resolve, reject, timer })
      ws!.send(JSON.stringify({ id, method, params }))
    })
    await command('Page.enable')
    do {
      const reply = await command('Runtime.evaluate', { expression: CDP_DOM_EXPRESSION, returnByValue: true })
      if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.text ?? 'CDP page read failed')
      const raw = reply.result?.result?.value
      const rows: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (tapdFilterRowsReady(rows)) return rows
      await new Promise(resolve => setTimeout(resolve, 200))
    } while (Date.now() < deadline)
    throw new Error('Platform filter values not ready before timeout')
  } finally {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP collector closed')) }
    ws?.close()
    if (target.id) await fetch(`${root}/json/close/${target.id}`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined)
  }
}
