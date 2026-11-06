/**
 * VsSaros addition (plan C): a Bot's mark, after DS Bot's (ds-bot/src/client/mark.js, Apache License 2.0; see NOTICE). Its
 * character moves for what the Bot does: thinks, searches, works, sends, waits for teammates, hops when it waits for the
 * person, and settles with a squash when its step ends. Marks in lists (`live`) also blink and fidget at rest, each Bot at
 * its own moment; marks inside the conversation stay still so a long chat does not run dozens of animations.
 */
import { useEffect, useRef, useState } from 'react'
import { characterMarkup, fnv1a, lookOf, MASK_ID, SUPERVISOR_LOOK, type Look } from './characters.ts'

export const MARK_STATES = ['idle', 'thinking', 'searching', 'working', 'sending', 'waiting', 'alert', 'done'] as const
export type MarkState = typeof MARK_STATES[number]
const FIDGETS = ['hop', 'sway', 'stretch', 'look'] as const

/** What a tool call looks like on a mark: searching for reads and lookups, sending for messages and reports, working otherwise. */
export function toolState(name: string): MarkState {
  if (/^(orchestrator_step_report|orchestrator_step_message|agent_message|superagent_submit)$/.test(name)) return 'sending'
  return /search|fetch|browse|read|grep|glob|list|recall|web/i.test(name) ? 'searching' : 'working'
}
/** A team step's mark: hops while it waits for the person, moves for its latest tool call while it runs, waits for its upstream. */
export function stepMarkState(step: { state: string; approval?: string | undefined; doing?: { tool: string } | undefined }): MarkState {
  if (step.approval || step.state === 'blocked') return 'alert'
  if (step.state === 'running') return step.doing ? toolState(step.doing.tool) : 'thinking'
  if (step.state === 'pending') return 'waiting'
  return 'idle'
}

let serial = 0
/** A mark settles with a short squash when its Bot stops working. */
function useSettled(state: MarkState): boolean {
  const previous = useRef(state)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const was = previous.current
    previous.current = state
    if (state !== 'idle') { setSettled(false); return undefined }
    if (was === 'idle' || was === 'alert' || was === 'waiting') return undefined
    setSettled(true)
    const timer = setTimeout(() => setSettled(false), 1800)
    return () => clearTimeout(timer)
  }, [state])
  return settled
}

export interface BotMarkProps {
  /** The Bot's id, from which its look and its moments come; the supervisor has its own look. */
  id: string
  name?: string
  size?: number
  state?: MarkState
  /** Blinks and fidgets at rest, and shows its badge. */
  live?: boolean
  look?: Look
  /** Shown faded: the Bot's step ended without its result. */
  faded?: boolean
}
/** A Bot's character with its state's motion, and a badge: "?" while it waits for the person, a green dot while it works. */
export function BotMark({ id, name, size = 28, state = 'idle', live = false, look, faded }: BotMarkProps) {
  const settled = useSettled(state)
  const mask = useRef('')
  if (mask.current === '') mask.current = `dt-bm-${serial += 1}`
  const { shape, color } = look ?? (id === 'superagent' ? SUPERVISOR_LOOK : lookOf(id))
  const shown: MarkState = settled ? 'done' : state
  const badge = live && state === 'alert' ? 'alert' : live && state !== 'idle' && state !== 'waiting' && state !== 'done' ? 'working' : undefined
  return <span className="dt-bm" data-shape={shape} data-state={shown} data-live={live || undefined} data-faded={faded || undefined}
    data-fidget={live ? FIDGETS[fnv1a(`${id}:fidget`) % FIDGETS.length] : undefined}
    role={name ? 'img' : undefined} aria-label={name} aria-hidden={name ? undefined : true}
    style={{ width: size, height: size, ['--dt-bm-size' as string]: `${size}px`,
      ...live ? { ['--dt-bm-delay' as string]: `${-(fnv1a(id) % 5000) / 1000}s`, ['--dt-bm-fidget-delay' as string]: `${-(fnv1a(`${id}:when`) % 9000) / 1000}s` } : {} }}>
    <svg viewBox="0 0 100 100" dangerouslySetInnerHTML={{ __html: characterMarkup(shape, color).replaceAll(MASK_ID, mask.current) }} />
    {badge === 'alert' && <span className="dt-bm-badge" data-kind="alert" aria-hidden="true">?</span>}
    {badge === 'working' && <span className="dt-bm-badge" data-kind="working" aria-hidden="true" />}
  </span>
}
