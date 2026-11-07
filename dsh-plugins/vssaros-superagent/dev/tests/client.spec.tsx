// @vitest-environment jsdom
import { act, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, caller, usePoll } from '../src/client/api.ts'
import { disposeFeed, feedState, subscribe } from '../src/client/feed.ts'
import { apply, RECEIPT_TOOL_NAME } from '../src/client/index.tsx'
import { RECEIPT_TOOL } from '../src/app/desk.ts'
import { zh } from '../src/client/locales.ts'
import { SettingsSchema } from '../src/policy.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; key?: string; order?: number; locale?: string; label?: () => string }; component: ComponentType<Record<string, unknown>> }
const t = ((key: keyof typeof zh) => zh[key] ?? key) as never
function fixture(listed: string[], workbenches?: { register: ReturnType<typeof vi.fn> }) {
  const entries: Entry[] = []
  const dictionaries: Record<string, unknown> = {}
  // What the plugin's effects leave to undo: DSH runs them when it disposes the plugin (as a reload does).
  const disposers: (() => void)[] = []
  const ctx = {
    // VsSaros addition: a slot entry can be withdrawn, as the sidebar entry is once the workbench host appears.
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], component: Entry['component']) => {
      const entry = { options, component }
      entries.push(entry)
      return () => { const at = entries.indexOf(entry); if (at >= 0) entries.splice(at, 1) }
    } },
    locale: { register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} }, bind: () => t },
    effect: (effect: () => unknown) => { const undo = effect(); if (typeof undo === 'function') disposers.push(undo as () => void) },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: Object.fromEntries(listed.map(id => [id, {}])) }) }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: vi.fn() },
    // Omit config form service so Deployment renders read-only; VsSaros's workbench host only when given.
    get: (name: string) => name === 'desktopWorkbenches' ? workbenches : undefined,
    // VsSaros addition: cordis runs an `inject` callback once its services exist.
    inject: (names: string[], callback: (child: unknown) => void) => { if (names.every(name => name === 'desktopWorkbenches' && workbenches)) callback({ ...ctx, desktopWorkbenches: workbenches }) },
  }
  apply(ctx as never)
  const entry = (name: string) => entries.find(item => item.options.name === name)!
  return { ctx, entries, dictionaries, main: entry('main'), nav: entry('sidebar.panellist'),
    dispose: () => { for (const undo of disposers.splice(0).reverse()) undo() } }
}
async function render(entry: Entry, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}
const openMaster = async (container: HTMLElement) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster || item.getAttribute('aria-label') === zh.openMaster)!
  await act(async () => { button.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const serve = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
  if (path === 'overview') return Response.json({ problems: [], person: [], executor: { running: 0, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, policyVersion: 'v' })
  if (path === 'state') return Response.json({ masterId: 'master', deskId: 'desk-1', settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
    setup: { machine: { stateDir: '/srv/state', worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
  if (path === 'desk/messages') return Response.json({ deskId: 'desk-1', messages: [] })
  return Response.json({ error: 'unavailable' }, { status: 503 })
}))
afterEach(() => { vi.unstubAllGlobals() })

it('registers a localized main panel, sidebar entry and Plugin Manager row page, and no settings section', () => {
  const { entries, dictionaries, main, nav } = fixture([])
  expect(entries.map(entry => entry.options.name)).toEqual(['main', 'sidebar.panellist', 'tool.call.toolview', 'tool.call.toolview', 'plugins.row.config'])
  // The desk's two tools: the hand-over, and (2026-11-06) the ticket-end card, named as the server names it.
  expect(entries.filter(entry => entry.options.name === 'tool.call.toolview').map(entry => (entry.options as { key?: string }).key))
    .toEqual(['superagent_submit', RECEIPT_TOOL])
  expect(RECEIPT_TOOL_NAME).toBe(RECEIPT_TOOL)
  expect(entries[4]!.options).toMatchObject({ key: '@vssaros/dsh-superagent#dsh-superagent', locale: 'dshSuperagent' })
  expect(Object.keys(dictionaries)).toEqual(['dshSuperagent'])
  expect(main.options).toMatchObject({ key: 'dsh-superagent', locale: 'dshSuperagent' })
  expect(nav.options).toMatchObject({ id: 'dsh-superagent', order: 10, locale: 'dshSuperagent' })
  expect(nav.options.label?.()).toBe('Superagent')
})

// VsSaros addition.
it('registers a whole-page workbench in VsSaros instead of the sidebar entry, which renders the panel', async () => {
  const unregister = vi.fn()
  const workbenches = { register: vi.fn(() => unregister) }
  const { entries } = fixture([], workbenches)
  expect(entries.map(entry => entry.options.name)).toEqual(['main', 'tool.call.toolview', 'tool.call.toolview', 'plugins.row.config'])
  expect(workbenches.register).toHaveBeenCalledTimes(1)
  const [descriptor, Panel] = workbenches.register.mock.calls[0] as unknown as [Record<string, unknown>, ComponentType<Record<string, unknown>>]
  // A VsSaros built-in workbench: its identity is vssaros:superagent, as its package's `vssaros.workbench` says.
  expect(descriptor).toMatchObject({ title: 'SuperAgent', repository: 'vssaros:superagent', icon: 'codicon:robot', customFrame: true, floatingActions: false })
  expect(descriptor).not.toHaveProperty('package')
  serve()
  const { container, dispose } = await render({ options: { name: 'workbench' }, component: Panel }, {})
  expect(container.querySelector('[data-vssaros-surface="workbench"] .dt-tabs')).not.toBeNull()
  // chat-surface's floating "sent to group" tip stays off over this workbench (it shows group runs itself).
  expect(container.querySelector('[data-vssaros-surface="workbench"]')?.getAttribute('data-vssaros-group-tip')).toBe('off')
  expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual([zh['tab.chat'], zh['tab.source'],
    zh['tab.trigger'], zh['tab.eval'], zh['tab.execution'], zh['tab.settings']])
  // Without the host's conversation, the Chat tab is the panel's own.
  expect(container.querySelector('[data-testid="native-chat"]')).toBeNull()
  expect(container.querySelector('.dt-composer')).not.toBeNull()
  dispose()
})

it('shows the supervisor desk in DSH\'s own chat that the workbench host docks in the Chat tab', async () => {
  const workbenches = { register: vi.fn(() => () => {}) }
  fixture([], workbenches)
  const [, Panel] = workbenches.register.mock.calls[0] as unknown as [unknown, ComponentType<Record<string, unknown>>]
  serve()
  const ensureSession = vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId)
  const { container, dispose } = await render({ options: { name: 'workbench' }, component: Panel },
    { service: { ensureSession }, active: true, conversation: <div data-testid="dsh-dock">DSH chat</div> })
  expect(ensureSession).toHaveBeenCalledWith({ sessionId: 'desk-1' })
  expect(container.querySelector('[data-testid="native-chat"] [data-testid="dsh-dock"]')?.textContent).toBe('DSH chat')
  expect(container.querySelector('.dt-composer')).toBeNull()
  dispose()
  // When the host cannot dock it, the panel's own chat says why.
  ensureSession.mockRejectedValueOnce(new Error('此会话已属于另一个工作台'))
  const again = await render({ options: { name: 'workbench' }, component: Panel },
    { service: { ensureSession }, active: true, conversation: <div data-testid="dsh-dock" /> })
  expect(again.container.querySelector('.dt-error')?.textContent).toContain('主管对话没能在这里打开')
  expect(again.container.querySelector('.dt-composer')).not.toBeNull()
  again.dispose()
})

it('opens a listed Session through the workspace from the main panel', async () => {
  serve()
  const { ctx, main } = fixture(['master'])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  view.dispose()
})

it('reports a Session missing from the catalog in the interface language', async () => {
  serve()
  const { ctx, main } = fixture([])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.sessionNotListed)
  view.dispose()
})

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(() => new Promise<string[]>(done => { calls.push({ limit, done }) }), [limit], 1000)
    shown = { ...data ? { data } : {}, limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(1)
  await act(async () => { calls[0]!.done(['a']) })
  expect(shown.data).toEqual(['a'])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toHaveLength(2)
  await act(async () => { setLimit(2) })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => { calls[2]!.done(['a', 'b']) })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => { calls[1]!.done(['stale']) })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { calls[3]!.done(['a', 'b']) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(5)
  act(() => { root.unmount() })
  vi.useRealTimers()
})

// VsSaros addition (2026-11-07): DSH's client has no `import.meta.hot`; a plugin reload disposes the plugin and loads a new copy
// of its modules. The old copy's change stream and its reconnect timer must end with the plugin, whatever views still listen.
it('ends the change stream and its reconnect timer when DSH disposes the client plugin', async () => {
  const streams: { signal: AbortSignal }[] = []
  let answer: 'stream' | 'down' = 'stream'
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (answer === 'down') return new Response(null, { status: 503 })
    streams.push({ signal: init!.signal! })
    return new Response(new ReadableStream<Uint8Array>({ start: controller => {
      init!.signal!.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')) } catch { /* closed */ } })
    } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }))
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
  const plugin = fixture([])
  // A view listens (as a card that never unmounted would): the stream opens.
  subscribe(() => {})
  await settle()
  expect(feedState()).toEqual({ connecting: true, retrying: false, listeners: 1 })
  plugin.dispose()
  await settle()
  expect(streams[0]!.signal.aborted).toBe(true)
  expect(feedState()).toEqual({ connecting: false, retrying: false, listeners: 0 })
  // A stream that is down waits to reconnect; disposing the plugin ends that wait too.
  const again = fixture([])
  answer = 'down'
  subscribe(() => {})
  await settle()
  expect(feedState()).toMatchObject({ connecting: false, retrying: true })
  again.dispose()
  expect(feedState()).toEqual({ connecting: false, retrying: false, listeners: 0 })
  // A view that unsubscribes after the plugin was disposed closes nothing of a newer listener's stream.
  answer = 'stream'
  const third = fixture([])
  const stale = subscribe(() => {})
  await settle()
  third.dispose()
  const fresh = subscribe(() => {})
  await settle()
  const opened = streams.at(-1)!
  stale()
  expect(opened.signal.aborted).toBe(false)
  expect(feedState()).toEqual({ connecting: true, retrying: false, listeners: 1 })
  fresh()
  expect(opened.signal.aborted).toBe(true)
  disposeFeed()
})

it('tells a dsh-superagent that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const messages = { offline: 'offline', notRunning: 'not running', serverError: (status: number) => `server ${status}`,
    requestFailed: (status: number) => `request ${status}`, setup: () => 'setup', user: ({ code }: { code: string }) => `user ${code}` }
  const call = caller(() => messages)
  const failure = async (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(answer))
    const error = await call('GET tickets/:id', { id: 't1' }).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(await failure(async () => { throw new TypeError('Failed to fetch') })).toEqual({ message: 'offline', status: 0, missing: false,
    unreachable: true })
  // DSH's web server answers an empty 404 while dsh-superagent's routes are unregistered.
  expect(await failure(async () => new Response(null, { status: 404 }))).toEqual({ message: 'not running', status: 404, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response(null, { status: 502 }))).toEqual({ message: 'server 502', status: 502, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response('<html>Bad request</html>', { status: 400 }))).toEqual({ message: 'request 400',
    status: 400, missing: false, unreachable: false })
  expect(await failure(async () => Response.json({ error: 'Unknown ticket', code: 'unknownTicket' }, { status: 404 }))).toEqual({
    message: 'user unknownTicket', status: 404, missing: true, unreachable: false })
})
