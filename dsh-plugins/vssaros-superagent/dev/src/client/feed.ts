/**
 * VsSaros addition (plan C): the change stream from dsh-superagent (`/orchestrator/api/stream`), shared by every view on
 * the page: one connection while anything listens, none after. Views read their data again when a topic they show changes,
 * and fall back to polling while the stream is down; after a reconnect every view reads again, since changes may have been
 * missed. The stream is read with `fetch`, as `EventSource` cannot send the same-origin header the API requires.
 */
import { useEffect, useRef, useState } from 'react'
import { usePoll } from './api.ts'

export type FeedTopic = 'steps' | 'tickets' | 'desk'
type Listener = (topics: readonly FeedTopic[] | 'all') => void
const listeners = new Set<Listener>()
const watchers = new Set<(live: boolean) => void>()
let live = false
let connected = false
let current: AbortController | undefined
let retry: ReturnType<typeof setTimeout> | undefined
let failures = 0

const emit = (topics: readonly FeedTopic[] | 'all') => { for (const listener of [...listeners]) listener(topics) }
function setLive(next: boolean) {
  if (live === next) return
  live = next
  for (const watch of [...watchers]) watch(next)
}
/** One SSE frame: its `change` event names the topics that changed. */
export function parseFrame(frame: string): readonly FeedTopic[] | undefined {
  let event = 'message', data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (event !== 'change' || !data) return undefined
  try {
    const topics = (JSON.parse(data) as { topics?: unknown }).topics
    return Array.isArray(topics) ? topics.filter((topic): topic is FeedTopic => topic === 'steps' || topic === 'tickets' || topic === 'desk') : undefined
  } catch { return undefined }
}
async function connect(): Promise<void> {
  const run = current = new AbortController()
  try {
    const response = await fetch('/orchestrator/api/stream', { headers: { 'x-orchestrator-request': '1', accept: 'text/event-stream' }, signal: run.signal })
    if (!response.ok || !response.body) throw new Error(`stream ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    failures = 0
    setLive(true)
    // Changes made while the stream was down were missed.
    if (connected) emit('all')
    connected = true
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        const topics = parseFrame(buffer.slice(0, at))
        buffer = buffer.slice(at + 2)
        if (topics?.length) emit(topics)
      }
    }
  } catch { /* down: polled until it is back */ }
  if (run !== current) return
  current = undefined
  setLive(false)
  failures += 1
  retry = setTimeout(() => { if (listeners.size) void connect() }, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)))
}
/** Listens to the stream's changes; the stream opens with the first listener and closes with the last. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  if (!current && !retry) void connect()
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    clearTimeout(retry); retry = undefined
    const run = current
    current = undefined
    run?.abort()
    setLive(false)
  }
}
/** Whether the stream is open now. */
export function useFeedLive(): boolean {
  const [value, setValue] = useState(live)
  useEffect(() => { watchers.add(setValue); setValue(live); return () => { watchers.delete(setValue) } }, [])
  return value
}

/**
 * Loads data and keeps it current: read again whenever one of `topics` changes, and polled every `intervalMs` while the
 * stream is down (every `liveMs` while it is up, a safety net).
 */
export function useLive<T>(load: () => Promise<T>, deps: readonly unknown[], topics: readonly FeedTopic[], intervalMs = 5000, liveMs = 60_000) {
  const isLive = useFeedLive()
  const poll = usePoll(load, deps, isLive ? liveMs : intervalMs)
  const reload = useRef(poll.reload)
  reload.current = poll.reload
  const wanted = topics.join(',')
  useEffect(() => subscribe(changed => {
    if (changed === 'all' || changed.some(topic => wanted.split(',').includes(topic))) void reload.current()
  }), [wanted])
  return { ...poll, live: isLive }
}
