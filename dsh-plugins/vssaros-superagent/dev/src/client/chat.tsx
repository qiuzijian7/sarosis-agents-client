/**
 * VsSaros addition: the Chat tab, the supervisor desk's conversation. In a VsSaros workbench it is DSH's own chat for the desk
 * Session (its messages and composer), which the workbench host docks here: a message typed in it is the person talking to
 * SuperAgent, and goes through the same gate, Eval and tickets, so replying「同意」agrees to a team proposal. Elsewhere,
 * where no host docks a conversation, the panel draws the conversation itself: the desk's messages, quick replies on a
 * proposal that waits, and a composer after DeepSeek-Bot's (see `composer.tsx`).
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DeskMessage } from '../app/desk-chat.ts'
import { usePoll } from './api.ts'
import { DeskComposer, VoicePane } from './composer.tsx'
import { Button } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { useSide } from './side.tsx'
import { errorText, reasonLabel } from './text.ts'
import { Hint, LoadState, When } from './widgets.tsx'
import { ApprovalCard, StaffingList, useWork } from './work.tsx'

const PROPOSAL = /^【组队方案 v\d+】/

/** The proposal message that still waits for the person: the latest one with no message of theirs after it. */
export function waitingProposal(messages: readonly DeskMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'person') return undefined
    if (PROPOSAL.test(message.text)) return message.id
  }
  return undefined
}

/** DSH's own conversation, as the VsSaros workbench host gives a workbench that frames itself. */
export interface NativeConversation {
  /** The host's dock: DSH's chat of the Session docked in it. It may be mounted in one place only. */
  node: ReactNode
  /** Docks a Session there, binding it to this workbench the first time. */
  dock(sessionId: string): Promise<void>
  /** Whether this workbench is the one shown. */
  active: boolean
}
export const NativeContext = createContext<NativeConversation | undefined>(undefined)

/** The Chat tab: DSH's own chat for the desk where a host docks one, else the panel's. */
export function ChatTab() {
  const native = useContext(NativeContext)
  return native ? <NativeChat native={native} /> : <ChatPage />
}

/** DSH's chat of the desk Session; on failing to dock it, the panel's chat with why. */
function NativeChat({ native }: { native: NativeConversation }) {
  const { t } = usePanel()
  const { state } = usePanelData()
  const deskId = state?.deskId
  const [failure, setFailure] = useState('')
  const { dock, active } = native
  useEffect(() => {
    if (!deskId || !active) return undefined
    let live = true
    dock(deskId).then(() => { if (live) setFailure('') }, error => { if (live) setFailure(errorText(error)) })
    return () => { live = false }
  }, [deskId, active, dock])
  if (failure) return <><p className="dt-error" role="alert">{t('chat.nativeFailed', { error: failure })}</p><ChatPage /></>
  return <div className="dt-chat dt-native-chat" data-testid="native-chat">
    <ChatDock />
    <p className="dt-native-wait">{t('chat.nativeOpening')}</p>
    {native.node}
  </div>
}

/**
 * VsSaros fix (2026-11-05): what waits for the person, above the desk's conversation: a team to agree to and a step's
 * request. The desk's model tells the person of them in words, but the buttons here do not depend on what it says or on
 * whether it is up, and they act on the ticket whichever desk it began in.
 */
export function ChatDock() {
  const { t } = usePanel()
  const work = useWork()
  const teams = (work.proposals ?? []).filter(item => item.proposal)
  if (!teams.length && !work.approvals.length) return null
  return <section className="dt-chat-dock" aria-label={t('chat.dock')} data-testid="chat-dock">
    <h2 className="dt-chat-dock-title">{t('chat.dock')}</h2>
    {work.approvals.length > 0 && <div className="dt-approvals">{work.approvals.map(item => <ApprovalCard key={item.id} approval={item} />)}</div>}
    {teams.length > 0 && <StaffingList teams={teams} />}
  </section>
}

/**
 * `queued`: sent while an earlier message is still on its way. There is no local queue: every message is posted at once, and
 * the server relays each one into the supervisor's running turn (`sessions.ts` relays with `steer`), so a separate
 * "steer this now" action would do nothing. The label says that instead of offering a button that does not act.
 */
type SubmissionPlacement = 'transcript' | 'queued'
interface LocalSubmission {
  id: string; text: string; at: string
  placement: SubmissionPlacement; state: 'pending' | 'failed'
}
const placementLabel = (t: ReturnType<typeof usePanel>['t'], item: LocalSubmission): string =>
  item.state === 'failed' ? t('chat.sendFailed') : item.placement === 'queued' ? t('chat.queued') : t('chat.pending')

/** The panel's own drawing of the desk conversation, where no host docks DSH's. */
export function ChatPage() {
  const { t, call, notify } = usePanel()
  const { setOpen } = useSide()
  const [voice, setVoice] = useState(false)
  // Faster while voice chat waits for an answer to read aloud.
  const { data, error, reload } = usePoll(() => call('GET desk/messages'), [], voice ? 1500 : 3000)
  const end = useRef<HTMLDivElement>(null)
  // ★ 2026-11-05: DS Bot-like optimistic send. A person sees the message at once and may keep typing.
  const [locals, setLocals] = useState<LocalSubmission[]>([])
  const inFlight = useRef(0)
  const seq = useRef(0)
  const pending = locals.filter(item => item.state === 'pending')
  const count = (data?.messages.length ?? 0) + locals.length
  useEffect(() => { if (count) end.current?.scrollIntoView?.({ block: 'end' }) }, [count])
  const send = (body: string): Promise<boolean> => {
    const text = body.trim()
    if (!text) { return Promise.resolve(false) }
    const placement: SubmissionPlacement = inFlight.current > 0 ? 'queued' : 'transcript'
    const id = `local:${++seq.current}:${Date.now()}`
    const at = new Date().toISOString()
    inFlight.current += 1
    setLocals(items => [...items, { id, text, at, placement, state: 'pending' }])
    return (async () => {
      try {
        const result = await call('POST desk/messages', { body: { text } })
        if (result.result === 'filtered') notify(t('chat.filtered'))
        try { await reload() } catch { /* the local bubble stays until the regular poll catches up */ }
        setLocals(items => items.filter(item => item.id !== id))
        return true
      } catch (failure) {
        notify(errorText(failure))
        setLocals(items => items.map(item => item.id === id ? { ...item, state: 'failed' } : item))
        return false
      } finally {
        inFlight.current = Math.max(0, inFlight.current - 1)
      }
    })()
  }
  if (!data) return <LoadState error={error} loading />
  // Voice chat takes the place of the conversation, as in DeepSeek-Bot; what was said still lands in it.
  if (voice) return <div className="dt-chat"><VoicePane messages={data.messages} send={send} onClose={() => setVoice(false)} /></div>
  const waiting = waitingProposal(data.messages)
  return <div className="dt-chat">
    {error && <LoadState error={error} loading={false} />}
    <div className="dt-chat-log" role="log" aria-label={t('tab.chat')}>
      {!data.messages.length && !locals.length && <Hint>{t('chat.empty')}</Hint>}
      {data.messages.map(message => message.role === 'person'
        ? <div key={message.id} className="dt-msg dt-msg-person">
          <div className="dt-msg-bubble">{message.text}</div>
          <div className="dt-msg-meta"><When at={message.at} />
            {message.filtered && <span className="dt-msg-filtered">{t('chat.notHanded', { reason: reasonLabel(t, message.filtered) })}</span>}</div>
        </div>
        : <div key={message.id} className="dt-msg dt-msg-agent">
          <span className="dt-msg-avatar" aria-hidden="true">SA</span>
          <div className="dt-msg-main">
            <div className="dt-msg-who">{t('chat.supervisor')} · <When at={message.at} />
              {message.id === waiting && <span className="dt-tag" data-tone="warning">{t('chat.waiting')}</span>}</div>
            <div className="dt-msg-text">{message.text}</div>
            {message.id === waiting && <div className="dt-msg-actions">
              <Button variant="primary" size="sm" onClick={() => { void send(t('chat.agreeText')) }}>{t('chat.agree')}</Button>
              <Button variant="outline" size="sm" onClick={() => { void send(t('chat.refuseText')) }}>{t('chat.refuse')}</Button>
              <button type="button" className="dt-textlink" onClick={() => setOpen(true)}>{t('chat.viewOverview')}</button>
            </div>}
          </div>
        </div>)}
      {locals.map(item => <div key={item.id} className="dt-msg dt-msg-person dt-msg-local" data-testid="local-submission"
        data-placement={item.placement} data-state={item.state}>
        <div className="dt-msg-bubble">{item.text}</div>
        <div className="dt-msg-meta"><When at={item.at} /><span className="dt-msg-placement">{placementLabel(t, item)}</span></div>
      </div>)}
      {pending.length > 0 && <div className="dt-chat-activity" data-testid="chat-activity" role="status">
        <span className="dt-shimmer">{t('chat.activity')}</span>
        <span>{t('chat.queuedCount', { n: String(pending.length) })}</span>
      </div>}
      <div ref={end} />
    </div>
    <DeskComposer send={send} busy={pending.length > 0} queued={pending.length} onVoice={() => setVoice(true)} />
  </div>
}
