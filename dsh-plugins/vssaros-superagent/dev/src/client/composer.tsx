/**
 * VsSaros addition: the Chat tab's composer, after DeepSeek-Bot's (ds-bot/src/client/composer.js and voice.js, Copyright 2026
 * Fei2411 and the DS Bot contributors, Apache License 2.0; see NOTICE): one rounded
 * row with a "+" (add files, reference a chat, schedule a message), the draft, a dictation microphone, and the voice-chat
 * button, which the send button takes the place of once there is something to send. Voice chat listens, sends what the
 * person said, reads SuperAgent's answer aloud and listens again.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { DeskMessage, DeskSchedule } from '../app/desk-chat.ts'
import type { ThreadListView } from '../app/views/threads.ts'
import { Button, Modal } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText, fullTime } from './text.ts'
import { When } from './widgets.tsx'

export const MAX_FILES = 5
export const MAX_FILE_BYTES = 10 * 1024 * 1024

// Icons, drawn as DeepSeek-Bot draws them (20×20).
const line = (paths: string[]) => function LineIcon() {
  return <svg width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">{paths.map(d => <path key={d} d={d} />)}</svg>
}
const PlusIcon = () => <svg width={14} height={14} viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v13M3.5 10h13" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /></svg>
const PaperclipIcon = line(['M15.5 9.5l-5.6 5.6a3.4 3.4 0 0 1-4.8-4.8l6.1-6.1a2.25 2.25 0 0 1 3.2 3.2l-6 6a1.1 1.1 0 0 1-1.6-1.6l5.5-5.5'])
const ChatsIcon = line(['M3.5 5.5A1.5 1.5 0 0 1 5 4h7a1.5 1.5 0 0 1 1.5 1.5V10A1.5 1.5 0 0 1 12 11.5H8L5 14v-2.5A1.5 1.5 0 0 1 3.5 10z',
  'M13.5 7.5H15A1.5 1.5 0 0 1 16.5 9v4.5A1.5 1.5 0 0 1 15 15v2l-2.5-2h-3A1.5 1.5 0 0 1 8 13.5V13'])
const ClockIcon = line(['M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z', 'M10 6.5V10l2.5 1.5'])
const BackIcon = line(['M12 5l-5 5 5 5'])
const CloseIcon = line(['M5.5 5.5l9 9M14.5 5.5l-9 9'])
const MicIcon = () => <svg width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
  <rect x={7} y={2.5} width={6} height={10} rx={3} fill="currentColor" stroke="none" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" /></svg>
const WaveIcon = ({ size = 16 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
  {[[3, 7.5, 5], [6.5, 4.5, 11], [10, 2.5, 15], [13.5, 5.5, 9], [17, 8, 4]].map(([x, y, height]) => <rect key={x} x={x! - 1} y={y} width={2} height={height} rx={1} />)}</svg>
const SendIcon = () => <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5" /></svg>

/** Keeps the draft focused when a composer button is pressed. */
const keepFocus = (event: { preventDefault(): void }) => event.preventDefault()

// Speech: the browser's (Chromium's) speech recognition and synthesis, as DeepSeek-Bot uses them without DSH's Voice Input.
interface Recognition {
  lang: string; interimResults: boolean; continuous: boolean
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}
export const speechApi = (): (new () => Recognition) | undefined => {
  const scope = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}
/** The note for a recognition error, or none for one that only means nothing was said. */
export function speechNote(error: string): 'composer.micBlocked' | 'composer.dictationOffline' | 'composer.notHeard' | undefined {
  if (error === 'aborted' || error === 'no-speech') return undefined
  if (error === 'not-allowed' || error === 'service-not-allowed' || error === 'audio-capture') return 'composer.micBlocked'
  if (error === 'network') return 'composer.dictationOffline'
  return 'composer.notHeard'
}

/** Dictation into the draft: `onText` gets interim text (`final` false) and each final phrase. */
export function useDictation(onText: (text: string, final: boolean) => void) {
  const { t } = usePanel()
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const engine = useRef<Recognition | undefined>(undefined)
  const latest = useRef(onText)
  latest.current = onText
  useEffect(() => () => engine.current?.abort(), [])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timer)
  }, [note])
  const start = (options: { continuous?: boolean; onEnd?: (heard: boolean) => void; onError?: (note: string) => void } = {}) => {
    const Api = speechApi()
    if (!Api) { setNote(t('composer.dictationUnavailable')); return false }
    const recognition = new Api()
    let heard = false
    recognition.lang = navigator.language || 'zh-CN'
    recognition.interimResults = true
    recognition.continuous = options.continuous ?? true
    recognition.onresult = event => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]!
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) { if (text.trim()) { heard = true; latest.current(text, true) } } else interim += text
      }
      if (interim) latest.current(interim, false)
    }
    recognition.onerror = event => {
      const key = speechNote(event.error)
      if (!key) return
      setNote(t(key))
      options.onError?.(t(key))
    }
    recognition.onend = () => { setListening(false); engine.current = undefined; options.onEnd?.(heard) }
    engine.current = recognition
    try { recognition.start(); setListening(true); return true } catch { setNote(t('composer.notHeard')); return false }
  }
  const stop = () => engine.current?.stop()
  const abort = () => { if (engine.current) { engine.current.onend = null; engine.current.abort(); engine.current = undefined; setListening(false) } }
  return { listening, note, start, stop, abort }
}

/** A file as base64, for `POST desk/files`. */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'))
    reader.readAsDataURL(file)
  })
}
const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** The composer: the draft and its attachments, and the "+" menu. `send` gets the whole message, attachments named in it. */
export function DeskComposer({ send, busy, onVoice, queued = 0 }: {
  send: (text: string) => Promise<boolean>; busy: boolean; onVoice: () => void; queued?: number
}) {
  const { t, call, notify } = usePanel()
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [menu, setMenu] = useState<'root' | 'reference'>()
  const [scheduling, setScheduling] = useState(false)
  const [uploading, setUploading] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const card = useRef<HTMLDivElement>(null)
  // Inserts text at the caret, as a dictated phrase or a reference lands where the person was typing.
  const insert = (text: string) => {
    const box = input.current
    const start = box?.selectionStart ?? draft.length, end = box?.selectionEnd ?? draft.length
    const next = draft.slice(0, start) + text + draft.slice(end)
    setDraft(next)
    setTimeout(() => { box?.focus(); box?.setSelectionRange(start + text.length, start + text.length) }, 0)
  }
  const dictation = useDictation((text, final) => { if (final) insert(text) })
  useEffect(() => {
    if (!menu) return undefined
    const down = (event: MouseEvent) => { if (!card.current?.contains(event.target as Node)) setMenu(undefined) }
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(undefined) } }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true) }
  }, [menu])
  const addFiles = (picked: FileList | null) => {
    const list = [...picked ?? []]
    const fits = list.filter(file => { if (file.size <= MAX_FILE_BYTES) return true; notify(t('composer.fileTooBig', { name: file.name })); return false })
    const next = [...files, ...fits]
    if (next.length > MAX_FILES) notify(t('composer.tooManyFiles', { count: String(MAX_FILES) }))
    setFiles(next.slice(0, MAX_FILES))
    if (picker.current) picker.current.value = ''
    input.current?.focus()
  }
  const empty = !draft.trim() && !files.length
  const submit = async () => {
    const body = draft.trim()
    const captured = files
    if (!body && !captured.length) return
    // DS Bot / official DSH composer: clear on submit, keep the composer usable while the send is running.
    setDraft(''); setFiles([])
    const restore = () => {
      setDraft(previous => previous.trim() ? previous : body)
      setFiles(previous => previous.length ? previous : captured)
    }
    let text = body
    if (captured.length) {
      setUploading(true)
      try {
        const kept = []
        for (const file of captured) kept.push(await call('POST desk/files', { body: { name: file.name, data: await readBase64(file) } }))
        text = [body, `${t('composer.attachmentsHeader')}\n${kept.map(file => `- ${file.name}（${sizeLabel(file.size)}）：${file.path}`).join('\n')}`]
          .filter(Boolean).join('\n\n')
      } catch (failure) { notify(errorText(failure)); restore(); return } finally { setUploading(false) }
    }
    if (!await send(text)) restore()
  }
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.nativeEvent.getModifierState?.('AltGraph')
    if (event.key !== 'Enter' || event.shiftKey || composing) return
    event.preventDefault()
    void submit()
  }
  return <div className="dt-composer-dock">
    <div ref={card} className="dt-composer" data-tall={files.length > 0 || draft.includes('\n') || undefined}>
      {menu && <div className="dt-menu" role="menu" aria-label={t('composer.add')}>
        {menu === 'root' ? <>
          <button type="button" role="menuitem" onClick={() => { setMenu(undefined); picker.current?.click() }}><PaperclipIcon /><span>{t('composer.addFiles')}</span></button>
          <button type="button" role="menuitem" onMouseDown={keepFocus} onClick={() => setMenu('reference')}><ChatsIcon /><span>{t('composer.reference')}</span></button>
          <button type="button" role="menuitem" onClick={() => { setMenu(undefined); setScheduling(true) }}><ClockIcon /><span>{t('composer.schedule')}</span></button>
        </> : <ReferenceList onBack={() => setMenu('root')} onPick={(title, key) => { setMenu(undefined); insert(t('composer.referenceText', { title, key })) }} />}
      </div>}
      {files.length > 0 && <div className="dt-composer-files">{files.map((file, index) => <span key={`${file.name}-${index}`} className="dt-composer-file">
        <PaperclipIcon /><span className="dt-composer-file-name">{file.name}</span><span className="dt-composer-file-size">{sizeLabel(file.size)}</span>
        <button type="button" aria-label={t('composer.removeFile', { name: file.name })} title={t('composer.removeFile', { name: file.name })}
          onClick={() => setFiles(files.filter((_, at) => at !== index))}><CloseIcon /></button></span>)}</div>}
      <button type="button" className="dt-composer-plus" aria-label={t('composer.add')} title={t('composer.add')} aria-haspopup="menu"
        aria-expanded={!!menu} onMouseDown={keepFocus} onClick={() => setMenu(menu ? undefined : 'root')}><PlusIcon /></button>
      <input ref={picker} type="file" multiple hidden aria-hidden="true" tabIndex={-1} onChange={event => addFiles(event.target.files)} />
      <textarea ref={input} className="dt-composer-input" rows={1} value={draft} aria-label={t('chat.label')}
        placeholder={t('chat.placeholder')}
        aria-busy={busy || uploading || undefined} onChange={event => setDraft(event.target.value)} onKeyDown={keys} />
      <div className="dt-composer-trailing">
        {empty
          ? <button type="button" className="dt-composer-voice" aria-label={t('composer.voiceStart')} title={t('composer.voiceTitle')}
            onMouseDown={keepFocus} onClick={onVoice}><WaveIcon size={18} /></button>
          : <button type="button" className="dt-composer-send" aria-label={t('chat.send')} title={t('chat.send')} aria-busy={busy || uploading || undefined}
            onMouseDown={keepFocus} onClick={() => { void submit() }}><SendIcon /></button>}
        <button type="button" className="dt-composer-mic" aria-pressed={dictation.listening}
          aria-label={t(dictation.listening ? 'composer.stopDictation' : 'composer.dictate')} title={t(dictation.listening ? 'composer.stopDictation' : 'composer.dictate')}
          onMouseDown={keepFocus} onClick={() => { if (dictation.listening) dictation.stop(); else dictation.start() }}><MicIcon /></button>
      </div>
      {(dictation.note || uploading || queued > 0) && <span className="dt-composer-note" data-testid="composer-queue-note" role="status">
        {uploading ? t('composer.uploading') : dictation.note || t('composer.queued', { n: String(queued) })}</span>}
    </div>
    <ScheduleDialog open={scheduling} draft={draft} onClose={() => setScheduling(false)} onScheduled={used => { if (used) setDraft('') }} />
  </div>
}

/** The chats a message may reference: the Threads of dsh-superagent, newest first, without the desk itself. */
function ReferenceList({ onBack, onPick }: { onBack: () => void; onPick: (title: string, key: string) => void }) {
  const { t, call } = usePanel()
  const [threads, setThreads] = useState<ThreadListView['items']>()
  const [failure, setFailure] = useState('')
  useEffect(() => {
    let live = true
    call('GET threads', { query: { filter: 'all', limit: 20 } })
      .then(list => { if (live) setThreads(list.items.filter(item => !item.key.startsWith('superagent:desk:'))) },
        error => { if (live) setFailure(errorText(error)) })
    return () => { live = false }
  }, [call])
  return <>
    <button type="button" className="dt-menu-head" onMouseDown={keepFocus} onClick={onBack}><BackIcon /><span>{t('composer.referenceTitle')}</span></button>
    {failure ? <p className="dt-menu-note">{failure}</p> : !threads ? <p className="dt-menu-note">{t('loading')}</p>
      : !threads.length ? <p className="dt-menu-note">{t('composer.referenceEmpty')}</p>
        : <div className="dt-menu-list">{threads.map(item => <button key={item.key} type="button" role="menuitem" onMouseDown={keepFocus}
          onClick={() => onPick(item.title, item.key)}><ChatsIcon /><span className="dt-menu-label">{item.title}</span>
          <span className="dt-menu-hint"><When at={item.lastAt} /></span></button>)}</div>}
  </>
}

/** The next whole hour, as a `datetime-local` value. */
export function nextHourLocal(now = new Date()): string {
  const next = new Date(now)
  next.setMinutes(0, 0, 0)
  next.setHours(next.getHours() + 1)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`
}

/** Schedules a message to the supervisor, and lists and removes the ones scheduled before. */
function ScheduleDialog({ open, draft, onClose, onScheduled }: { open: boolean; draft: string; onClose: () => void; onScheduled: (usedDraft: boolean) => void }) {
  const { t, call, notify } = usePanel()
  const [text, setText] = useState('')
  const [at, setAt] = useState('')
  const [repeat, setRepeat] = useState<DeskSchedule['repeat']>('none')
  const [list, setList] = useState<DeskSchedule[]>()
  const [busy, setBusy] = useState(false)
  const load = () => call('GET desk/schedules').then(value => setList(value.schedules), failure => notify(errorText(failure)))
  useEffect(() => {
    if (!open) return
    setText(draft.trim()); setAt(nextHourLocal()); setRepeat('none'); void load()
  }, [open])
  const save = async () => {
    if (!text.trim() || !at || busy) return
    setBusy(true)
    try {
      const saved = await call('POST desk/schedules', { body: { text: text.trim(), at: new Date(at).toISOString(), repeat } })
      notify(t('schedule.saved', { when: fullTime(saved.at, t('lang')) }))
      onScheduled(!!draft.trim() && text.trim() === draft.trim())
      onClose()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    try { await call('POST desk/schedules/:id/delete', { id }); await load() } catch (failure) { notify(errorText(failure)) }
  }
  return <Modal open={open} onClose={onClose} title={t('schedule.title')} closeLabel={t('schedule.close')} description={t('schedule.description')}
    footer={<><Button variant="ghost" onClick={onClose}>{t('schedule.close')}</Button>
      <Button variant="primary" disabled={busy || !text.trim() || !at} onClick={() => { void save() }}>{t('schedule.save')}</Button></>}>
    <div className="dt-form dt-schedule">
      <label className="dt-field"><span>{t('schedule.text')}</span>
        <textarea className="dt-textarea" rows={3} value={text} onChange={event => setText(event.target.value)} /></label>
      <div className="dt-schedule-when">
        <label className="dt-field"><span>{t('schedule.at')}</span>
          <input className="dt-select" type="datetime-local" value={at} onChange={event => setAt(event.target.value)} /></label>
        <label className="dt-field"><span>{t('schedule.repeat')}</span>
          <select className="dt-select" value={repeat} onChange={event => setRepeat(event.target.value as DeskSchedule['repeat'])}>
            {(['none', 'daily', 'weekdays'] as const).map(value => <option key={value} value={value}>{t(`schedule.${value}`)}</option>)}
          </select></label>
      </div>
      <div className="dt-field"><span>{t('schedule.list')}</span>
        {!list?.length ? <p className="dt-hint">{t('schedule.empty')}</p>
          : <ul className="dt-list" data-testid="desk-schedules">{list.map(item => <li key={item.id} className="dt-row">
            <div className="dt-row-main"><div className="dt-row-title">{item.text}</div>
              <div className="dt-row-meta"><span>{fullTime(item.at, t('lang'))}</span><span>{t(`schedule.${item.repeat}`)}</span></div></div>
            <div className="dt-row-actions"><Button variant="outline" size="sm" onClick={() => { void remove(item.id) }}>{t('schedule.delete')}</Button></div>
          </li>)}</ul>}
      </div>
    </div>
  </Modal>
}

/** Markdown and headers read aloud as plain words. */
export const plainSpeech = (text: string) => text.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[*_`#>|~]+/g, ' ').replace(/\s+/g, ' ').trim()

type VoicePhase = 'listening' | 'thinking' | 'speaking' | 'paused' | 'unsupported'
/**
 * Voice chat with SuperAgent: listens, sends what the person said, reads the answer aloud, and listens again, until the
 * person pauses or ends it. An answer that takes long is left to the conversation, and listening goes on.
 */
export function VoicePane({ messages, send, onClose }: { messages: readonly DeskMessage[]; send: (text: string) => Promise<boolean>; onClose: () => void }) {
  const { t } = usePanel()
  const [phase, setPhaseState] = useState<VoicePhase>(speechApi() ? 'listening' : 'unsupported')
  const [caption, setCaption] = useState('')
  const [note, setNote] = useState(speechApi() ? '' : t('voice.unsupported'))
  const heardText = useRef('')
  const known = useRef<Set<string>>(new Set())
  const closed = useRef(false)
  const current = useRef({ phase, messages })
  current.current = { phase: current.current.phase, messages }
  const setPhase = (next: VoicePhase) => { current.current.phase = next; setPhaseState(next) }
  const dictation = useDictation((text, final) => { if (final) heardText.current += text; setCaption(final ? heardText.current : heardText.current + text) })
  const listen = () => {
    if (closed.current) return
    heardText.current = ''
    setCaption('')
    setPhase('listening')
    dictation.start({ continuous: false, onError: message => { setNote(message); setPhase('unsupported') }, onEnd: () => {
      if (closed.current || current.current.phase !== 'listening') return
      const said = heardText.current.trim()
      // Nothing was said: listen again.
      if (!said) { setTimeout(listen, 300); return }
      known.current = new Set(current.current.messages.filter(message => message.role === 'superagent').map(message => message.id))
      setPhase('thinking')
      void send(said).then(ok => { if (!ok && !closed.current) listen() })
    } })
  }
  const speak = (text: string) => {
    setCaption(text)
    const synth = typeof window.speechSynthesis === 'undefined' ? undefined : window.speechSynthesis
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') { setTimeout(listen, 1500); return }
    setPhase('speaking')
    const utterance = new SpeechSynthesisUtterance(plainSpeech(text).slice(0, 1200))
    utterance.lang = navigator.language || 'zh-CN'
    utterance.onend = () => { if (!closed.current) listen() }
    synth.cancel()
    synth.speak(utterance)
  }
  useEffect(() => { if (phase === 'listening') listen(); return () => { closed.current = true; dictation.abort(); window.speechSynthesis?.cancel() } }, [])
  // SuperAgent's first answer after what the person said is read aloud.
  useEffect(() => {
    if (phase !== 'thinking') return
    const answer = messages.find(message => message.role === 'superagent' && !known.current.has(message.id))
    if (answer) speak(answer.text)
  }, [messages, phase])
  useEffect(() => {
    if (phase !== 'thinking') return undefined
    const timer = setTimeout(() => { setNote(t('voice.slow')); listen() }, 120_000)
    return () => clearTimeout(timer)
  }, [phase])
  const pause = () => { dictation.abort(); window.speechSynthesis?.cancel(); setPhase('paused') }
  const end = () => { closed.current = true; dictation.abort(); window.speechSynthesis?.cancel(); onClose() }
  const button = (label: string, onClick: () => void, children: ReactNode, className = 'dt-voice-btn') =>
    <button type="button" className={className} aria-label={label} title={label} onClick={onClick}>{children}</button>
  return <div className="dt-voice" role="dialog" aria-label={t('composer.voiceTitle')}>
    <div className="dt-voice-stage" data-phase={phase}>
      <div className="dt-voice-orb"><span className="dt-voice-ring" /><span className="dt-voice-mark" aria-hidden="true"><WaveIcon size={34} /></span></div>
      <div className="dt-voice-name">{t('chat.supervisor')}</div>
      <div className="dt-voice-status" role="status">{t(`voice.${phase}`)}</div>
      {caption && <div className="dt-voice-caption">{caption}</div>}
      {note && <div className="dt-voice-note">{note}</div>}
    </div>
    <div className="dt-voice-bar">
      {phase === 'paused' || phase === 'unsupported'
        ? phase === 'paused' && button(t('voice.resume'), () => { setNote(''); listen() }, <MicIcon />)
        : button(t('voice.pause'), pause, <MicIcon />)}
      {button(t('voice.end'), end, <CloseIcon />, 'dt-voice-btn dt-voice-end')}
    </div>
  </div>
}
