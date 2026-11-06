/**
 * VsSaros addition (2026-11-05): live group-chat runs in the Workbench and Execution tabs.
 *
 * The orchestrator's `GET state` / `GET tickets` / `GET team/steps` only describe Tickets, Steps and Executor slots.
 * A group chat relay lives in `vssaros-agents` and is broadcast by `vssaros-chat-surface`'s global activity dock as
 * `vssaros-group-progress`. This module is read-only: it does not change Ticket/Step semantics, SSE topics or host APIs.
 */
import { useEffect, useState } from 'react'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import type { T } from './text.ts'

export const GROUP_PROGRESS_EVENT = 'vssaros-group-progress'
/** Same value as vssaros-agents `ROUND_SCHEMA`: the cross-plugin group-run contract this panel understands. */
export const GROUP_ACTIVITY_SCHEMA = 1
export interface GroupRunEvent { kind?: string; name?: string; text?: string; at?: number }
export interface GroupRunReply { botId?: string; name?: string; text?: string; ms?: number; kind?: string }
export interface GroupRunFailure { botId?: string; name?: string; reason?: string }
export type GroupRoundStatus = 'sent' | 'replying' | 'done' | 'cut' | 'failed'
export interface GroupRun {
  schema?: number; callId?: string; roomId?: string; roomName?: string
  startedAt?: number; finishedAt?: number; done?: boolean; error?: string
  phase?: string; interrupted?: boolean; status?: GroupRoundStatus; statusLabel?: string
  /** Correlation with the SuperAgent trigger / the session the `@group` came from. */
  originTriggerId?: string; fromSession?: string; sourceMessageId?: string
  replies?: GroupRunReply[]; events?: GroupRunEvent[]
  speaking?: string[]; passed?: string[]; failed?: GroupRunFailure[]
}
type GroupRunState = 'running' | 'done' | 'error' | 'cut'
type GroupRunStatusKey = 'groupRuns.status.running' | 'groupRuns.status.replying' | 'groupRuns.status.done' | 'groupRuns.status.error'
  | 'groupRuns.status.cut'
type GroupRunMemberState = 'speaking' | 'replied' | 'passed' | 'failed' | 'waiting'
type GroupRunTextKey = GroupRunStatusKey | 'groupRuns.title' | 'groupRuns.replies' | 'groupRuns.elapsed'
  | 'groupRuns.failed' | 'groupRuns.member.speaking' | 'groupRuns.member.replied' | 'groupRuns.member.passed'
  | 'groupRuns.member.failed' | 'groupRuns.member.waiting'
interface GroupRunMember { name: string; state: GroupRunMemberState; labelKey: GroupRunTextKey }

const STATUSES: readonly GroupRoundStatus[] = ['sent', 'replying', 'done', 'cut', 'failed']
/**
 * The one state machine for a group run (verbatim copy of vssaros-agents `roundStatusOf`; the server's `status` wins).
 * Interrupted beats failed: a run cut by a restart carries an error too. check-bots-rooms.mjs pins all copies to one table.
 */
export function groupRoundStatus(run: GroupRun | null | undefined): GroupRoundStatus {
  const r = run && typeof run === 'object' ? run : {}
  if (r.status && STATUSES.includes(r.status)) { return r.status }
  const events = Array.isArray(r.events) ? r.events : []
  if (r.interrupted || r.phase === 'cut' || events.some(event => event && event.kind === 'cut')) { return 'cut' }
  if (!r.done) { return (Array.isArray(r.speaking) ? r.speaking.length : 0) > 0 ? 'replying' : 'sent' }
  return r.error ? 'failed' : 'done'
}
/** Drops malformed entries of a broadcast this panel does not own. */
export function normalizeGroupRuns(value: unknown): GroupRun[] {
  return (Array.isArray(value) ? value : []).filter((item): item is GroupRun =>
    !!item && typeof item === 'object' && typeof (item as GroupRun).roomId === 'string' && !!(item as GroupRun).roomId)
}

/** Initial snapshot left by the chat-surface activity dock; the event below keeps it current. */
function globalRuns(): GroupRun[] {
  if (typeof window === 'undefined') { return [] }
  return normalizeGroupRuns((window as unknown as { __vssarosGroupProgress?: unknown }).__vssarosGroupProgress)
}
/** The Bots plugin's list of running and recently ended group runs (what the chat-surface dock broadcasts). */
export const AGENTS_ROOMS_ACTIVE = '/x/agents/api/rooms?active=1'
/**
 * How long to wait for a broadcast before reading the list directly, and how often then. Without it the section stayed empty
 * whenever chat-surface was missing, loaded later, or ran in another webview. Tests may shorten it.
 */
export const groupRunsConfig = { fallbackMs: 5000 }
/**
 * One subscription per mounted tab. The chat-surface broadcast is the source; only while none has been heard does the tab
 * read the list itself, slowly, and it stops as soon as a broadcast arrives. No host API or SSE topic changes.
 */
export function useGroupRuns(): GroupRun[] {
  const [runs, setRuns] = useState<GroupRun[]>(globalRuns)
  useEffect(() => {
    if (typeof window === 'undefined') { return undefined }
    let alive = true
    let heard = Array.isArray((window as unknown as { __vssarosGroupProgress?: unknown }).__vssarosGroupProgress)
    let timer: ReturnType<typeof setTimeout> | undefined
    setRuns(globalRuns())
    const onProgress = (event: Event) => {
      heard = true
      const detail = (event as CustomEvent<{ active?: unknown; schema?: number }>).detail
      // A newer contract than this panel knows is still read field by field; only its shape is checked.
      setRuns(normalizeGroupRuns(detail?.active))
    }
    const poll = async () => {
      if (!alive || heard) { return }
      try {
        const response = await fetch(AGENTS_ROOMS_ACTIVE)
        const body = response.ok ? await response.json() as { active?: unknown } : undefined
        if (alive && !heard && Array.isArray(body?.active)) { setRuns(normalizeGroupRuns(body.active)) }
      } catch { /* the Bots plugin is not there: nothing to show */ }
      if (alive && !heard) { timer = setTimeout(() => { void poll() }, groupRunsConfig.fallbackMs) }
    }
    window.addEventListener(GROUP_PROGRESS_EVENT, onProgress)
    if (!heard) { timer = setTimeout(() => { void poll() }, groupRunsConfig.fallbackMs) }
    return () => { alive = false; clearTimeout(timer); window.removeEventListener(GROUP_PROGRESS_EVENT, onProgress) }
  }, [])
  return runs
}

export function groupRunState(run: GroupRun): GroupRunState {
  const status = groupRoundStatus(run)
  return status === 'failed' ? 'error' : status === 'cut' ? 'cut' : status === 'done' ? 'done' : 'running'
}
export function groupRunStatusKey(run: GroupRun): GroupRunStatusKey {
  const status = groupRoundStatus(run)
  return status === 'failed' ? 'groupRuns.status.error' : status === 'cut' ? 'groupRuns.status.cut'
    : status === 'done' ? 'groupRuns.status.done' : status === 'replying' ? 'groupRuns.status.replying' : 'groupRuns.status.running'
}
export function groupRunReplies(run: GroupRun): GroupRunReply[] {
  return (Array.isArray(run?.replies) ? run.replies : []).filter(reply => reply && !reply.kind)
}
export function groupRunElapsed(run: GroupRun, now = Date.now()): number {
  const started = Number(run?.startedAt ?? 0)
  if (!started) { return 0 }
  const ended = Number(run?.finishedAt ?? 0) || now
  return Math.max(0, Math.round((ended - started) / 1000))
}
export function groupRunLatestEvent(run: GroupRun): GroupRunEvent | undefined {
  const events = Array.isArray(run?.events) ? run.events : []
  return events.length ? events[events.length - 1] : undefined
}
const memberLabelKey = (state: GroupRunMemberState): GroupRunTextKey =>
  state === 'speaking' ? 'groupRuns.member.speaking' : state === 'replied' ? 'groupRuns.member.replied'
    : state === 'passed' ? 'groupRuns.member.passed' : state === 'failed' ? 'groupRuns.member.failed' : 'groupRuns.member.waiting'
/** Merge name-only `speaking/passed/events` with `replies/failed`, first state wins. */
export function groupRunMembers(run: GroupRun): GroupRunMember[] {
  const out: GroupRunMember[] = []
  const add = (value: unknown, state: GroupRunMemberState) => {
    const name = String(value ?? '').trim()
    if (!name || out.some(item => item.name === name)) { return }
    out.push({ name, state, labelKey: memberLabelKey(state) })
  }
  for (const item of Array.isArray(run?.failed) ? run.failed : []) { add(item?.name, 'failed') }
  for (const event of Array.isArray(run?.events) ? run.events : []) {
    if (event?.name && /^(failed|missed|cut)$/.test(String(event.kind ?? ''))) { add(event.name, 'failed') }
  }
  for (const name of Array.isArray(run?.speaking) ? run.speaking : []) { add(name, 'speaking') }
  for (const event of Array.isArray(run?.events) ? run.events : []) {
    if (!event?.name) { continue }
    add(event.name, /^(working|resumed)$/.test(String(event.kind ?? '')) ? 'speaking' : 'waiting')
  }
  for (const reply of groupRunReplies(run)) { add(reply?.name, 'replied') }
  for (const name of Array.isArray(run?.passed) ? run.passed : []) { add(name, 'passed') }
  return out
}

/** Where a run came from: an `@group` routed from another conversation, or the request that created the group. */
export function groupRunSource(run: GroupRun): 'post' | 'created' | undefined {
  if (run?.fromSession) { return 'post' }
  if (run?.originTriggerId) { return 'created' }
  return undefined
}

/**
 * The run a desk message's card follows. An `@group` command follows the run its own message started (the agents plugin
 * records the DSH message id as `sourceMessageId`), never another one in the same group; a new group follows its latest run.
 */
export function groupRunForFlow(runs: readonly GroupRun[], group: { roomId: string; kind: 'created' | 'routed' | 'updated'; sourceMessageId?: string }):
  GroupRun | undefined {
  const inRoom = (runs ?? []).filter(run => run?.roomId === group.roomId)
  if (group.kind === 'routed') return group.sourceMessageId ? inRoom.find(run => run.sourceMessageId === group.sourceMessageId) : undefined
  return [...inRoom].sort((a, b) => Number(b.startedAt ?? 0) - Number(a.startedAt ?? 0))[0]
}

/** Independent section; deliberately avoids `.dt-status-line`, `.dt-lv`, `.dt-stat`, `.dt-work-bar` and the ticket list. */
export function GroupRuns({ compact = false }: { compact?: boolean }) {
  const { t, openSession, notify } = usePanel()
  const runs = useGroupRuns()
  if (!runs.length) { return null }
  return <section className="dt-group-runs" data-vssaros-group-runs="1" data-testid="group-runs" aria-label={t('groupRuns.title')}>
    <div className="dt-group-runs-head"><b>{t('groupRuns.title')}</b><span>{runs.length}</span></div>
    {compact && <p className="dt-group-runs-note" data-testid="group-runs-note">{t('groupRuns.note')}</p>}
    <div className="dt-group-runs-list">
      {runs.slice(0, compact ? 3 : 5).map((run, index) => {
        const state = groupRunState(run)
        const statusKey = groupRunStatusKey(run)
        const replies = groupRunReplies(run)
        const members = groupRunMembers(run)
        const latest = groupRunLatestEvent(run)
        const roomName = String(run?.roomName || run?.roomId || '群聊')
        const failures = (Array.isArray(run?.failed) ? run.failed.length : 0)
        const source = groupRunSource(run)
        const roomId = String(run?.roomId || '')
        return <article className="dt-group-runs-card" key={String(run?.callId || run?.roomId || index)}
          data-vssaros-group-run={String(run?.callId || '')} data-vssaros-group-run-room={roomId}
          data-vssaros-group-run-state={state} data-vssaros-group-run-status={t(statusKey)}
          data-vssaros-group-run-round-status={groupRoundStatus(run)}
          data-vssaros-group-run-source={source ?? ''} data-vssaros-group-run-trigger={String(run?.originTriggerId || '')}
          data-vssaros-group-run-name={roomName} data-vssaros-group-run-replies={String(replies.length)}
          data-vssaros-group-run-elapsed={String(groupRunElapsed(run))} data-state={state}>
          <div className="dt-group-runs-title">
            <span className="dt-group-runs-dot" data-state={state} aria-hidden="true" />
            <b>{roomName}</b><span className="dt-group-runs-status">{t(statusKey)}</span>
            {roomId && <button type="button" className="dt-textlink dt-group-runs-open" data-act="open-group-run"
              onClick={() => { openSession(roomId).catch(failure => notify(errorText(failure))) }}>{t('groupRuns.open')}</button>}
          </div>
          <div className="dt-group-runs-meta">
            <span>{t('groupRuns.replies', { n: String(replies.length) })}</span>
            <span>{t('groupRuns.elapsed', { n: String(groupRunElapsed(run)) })}</span>
            {failures > 0 && <span>{t('groupRuns.failed', { n: String(failures) })}</span>}
            {source && <span className="dt-group-runs-source"
              title={run?.originTriggerId ? t('groupRuns.source.trigger', { id: run.originTriggerId }) : undefined}>
              {t(source === 'post' ? 'groupRuns.source.post' : 'groupRuns.source.created')}</span>}
          </div>
          {members.length > 0 && <div className="dt-group-runs-members">{members.slice(0, 8).map(member =>
            <span className="dt-group-runs-member" key={member.name} data-vssaros-group-run-member={member.name}
              data-vssaros-group-run-member-state={member.state} title={`${member.name} · ${t(member.labelKey)}`}>
              {member.name} · {t(member.labelKey)}</span>)}</div>}
          {latest?.text && <div className="dt-group-runs-latest">{String(latest.text).slice(0, 120)}</div>}
        </article>
      })}
    </div>
  </section>
}
