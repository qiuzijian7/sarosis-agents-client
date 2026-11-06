/**
 * VsSaros addition: the side panel beside the page, with the Overview in it. It opens and closes from the header, keeps its
 * width (dragged from its left edge) and open state across panel loads, and opens by itself when the supervisor starts new
 * work: a new version of a team proposal, a team ticket whose steps begin, or a step asking the person to approve a call
 * beyond its directory (plan C). Closing it by hand is respected: the same work progressing does not open it again, only new
 * work does.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Button, Icon } from './controls.tsx'
import { OverviewPage } from './overview.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { useWork } from './work.tsx'

const SIDE_KEY = 'dsh-superagent/side'
const SEEN_KEY = 'dsh-superagent/side-seen'
export const SIDE_WIDTH = { min: 320, max: 560, initial: 400 } as const
const clampWidth = (value: number) => Math.round(Math.min(SIDE_WIDTH.max, Math.max(SIDE_WIDTH.min, value)))

function readStored<T>(key: string): T | undefined {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') as T ?? undefined } catch { return undefined }
}
function writeStored(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch (failure) { void failure /* Panel memory is a convenience. */ }
}

interface Side { open: boolean; width: number; setOpen(open: boolean): void; setWidth(width: number): void }
const SideContext = createContext<Side | undefined>(undefined)
export function useSide(): Side {
  const value = useContext(SideContext)
  if (!value) throw new Error('dsh-superagent side panel used outside its provider')
  return value
}

/** What the supervisor is working on, one signature per piece of new work; a step's request for the person counts as new work. */
export function workSignatures(proposals: readonly { ticket: { id: string }; proposal?: { version: number } }[],
  teams: readonly { ticket: { id: string } }[], approvals: readonly { id: string }[] = []): string[] {
  return [...proposals.flatMap(item => item.proposal ? [`proposal:${item.ticket.id}:v${item.proposal.version}`] : []),
    ...teams.map(item => `steps:${item.ticket.id}`), ...approvals.map(item => `approval:${item.id}`)]
}

/** Holds the side panel's state and opens it when the supervisor starts new work or a step asks the person. */
export function SideProvider({ children }: { children: ReactNode }) {
  const { t, notify } = usePanel()
  const work = useWork()
  const stored = useMemo(() => readStored<{ open?: boolean; width?: number }>(SIDE_KEY) ?? {}, [])
  const [open, setOpenState] = useState(stored.open ?? true)
  const [width, setWidthState] = useState(clampWidth(stored.width ?? SIDE_WIDTH.initial))
  const latest = useRef({ open, width })
  latest.current = { open, width }
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    writeStored(SIDE_KEY, { ...latest.current, open: next })
  }, [])
  const setWidth = useCallback((next: number) => {
    const value = clampWidth(next)
    setWidthState(value)
    writeStored(SIDE_KEY, { ...latest.current, width: value })
  }, [])

  const seen = useRef<Set<string> | undefined>(undefined)
  useEffect(() => {
    if (!work.loaded || !work.proposals) return
    const now = workSignatures(work.proposals, work.teams, work.approvals)
    // The first look only records what is there: opening the panel is not news.
    if (!seen.current) {
      const remembered = readStored<string[]>(SEEN_KEY)
      seen.current = new Set(remembered ?? now)
      if (!remembered) { writeStored(SEEN_KEY, now); return }
    }
    const fresh = now.filter(signature => !seen.current!.has(signature))
    if (!fresh.length) return
    for (const signature of fresh) seen.current.add(signature)
    writeStored(SEEN_KEY, [...seen.current].slice(-200))
    if (!latest.current.open) {
      setOpen(true)
      notify(t(fresh.some(signature => signature.startsWith('approval:')) ? 'side.autoOpenedApproval' : 'side.autoOpened'))
    }
  }, [work.loaded, work.proposals, work.teams, work.approvals, setOpen, notify, t])

  const value = useMemo(() => ({ open, width, setOpen, setWidth }), [open, width, setOpen, setWidth])
  return <SideContext.Provider value={value}>{children}</SideContext.Provider>
}

/** The side panel itself: a tab strip with the main Session and close buttons, and the Overview. */
export function SidePanel({ masterId }: { masterId: string | undefined }) {
  const { t, openSession, notify } = usePanel()
  const { open, width, setOpen, setWidth } = useSide()
  const [dragging, setDragging] = useState(false)
  if (!open) return null
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const grip = event.currentTarget, start = event.clientX, from = width
    grip.setPointerCapture?.(event.pointerId)
    setDragging(true)
    const move = (next: globalThis.PointerEvent) => setWidth(from + start - next.clientX)
    const up = () => { grip.removeEventListener('pointermove', move); setDragging(false) }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up, { once: true })
  }
  return <aside className="dt-side" data-dragging={dragging || undefined} aria-label={t('tab.overview')}
    style={{ ['--dt-side-width' as string]: `${width}px` }}>
    <div className="dt-side-grip" role="separator" aria-orientation="vertical" aria-label={t('side.resize')} aria-valuemin={SIDE_WIDTH.min}
      aria-valuemax={SIDE_WIDTH.max} aria-valuenow={width} tabIndex={0} onPointerDown={drag}
      onKeyDown={event => { if (event.key === 'ArrowLeft') setWidth(width + 16); if (event.key === 'ArrowRight') setWidth(width - 16) }} />
    <div className="dt-side-strip">
      <span className="dt-side-tab">{t('tab.overview')}</span>
      <div className="dt-side-tools">
        <Button variant="ghost" size="sm" icon={<Icon name="session" size={15} />} aria-label={t('openMaster')} title={t('openMaster')}
          disabled={!masterId} onClick={() => { if (masterId) openSession(masterId).catch(failure => notify(errorText(failure))) }} />
        <Button variant="ghost" size="sm" icon={<Icon name="panel" size={15} />} aria-label={t('side.close')} title={t('side.close')}
          onClick={() => setOpen(false)} />
      </div>
    </div>
    <div className="dt-side-body"><OverviewPage /></div>
  </aside>
}
