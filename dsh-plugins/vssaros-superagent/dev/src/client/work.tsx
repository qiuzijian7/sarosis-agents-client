/**
 * VsSaros addition (superagent runtime UI, plan C): the supervisor's teams at work. The side panel shows what waits for the
 * person (a step's request to reach beyond its directory: allow once, allow and remember, or refuse) and each team's
 * members, what they do now and for how long, with a stop button each; a small flow chart opens the Workbench tab, which
 * shows a team's steps as a dependency graph (after TeamFlow's: status bar, glow and pulse on what runs, one card per step
 * with its attempts), a board by state, or a list, and a step's details beside them.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { StepApprovalView } from '../app/step-approvals.ts'
import type { StepsView } from '../app/steps.ts'
import { Button, Icon, SegmentedTabs, type TagTone } from './controls.tsx'
import { useLive } from './feed.ts'
import { GroupRuns } from './group-runs.tsx'
import { BotMark, stepMarkState } from './mark.tsx'
import { useAction, usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { ConfirmButton, Hint } from './widgets.tsx'

type Step = StepsView['steps'][number]
type StepState = Step['state']
export const STEP_TONE: Record<StepState, TagTone> = { pending: 'neutral', running: 'info', ready: 'success', blocked: 'warning', failed: 'danger',
  skipped: 'neutral', stopped: 'neutral' }
const FINISHED: readonly StepState[] = ['ready', 'failed', 'skipped', 'stopped']

// ── Shared data: one subscription for the side panel, its auto-open and the Workbench tab ───────────────────────────

export interface Work {
  teams: StepsView[]; approvals: StepApprovalView[]
  proposals: ApiResponse<'GET team/proposals'>['waiting'] | undefined
  loaded: boolean; reload(): Promise<void>
}
const WorkContext = createContext<Work | undefined>(undefined)
export function useWork(): Work {
  const value = useContext(WorkContext)
  if (!value) throw new Error('dsh-superagent team work used outside its provider')
  return value
}
const settled = async () => {}
/** Reads the team work again after an action, where a provider holds it; elsewhere the change stream brings it. */
const useReload = () => useContext(WorkContext)?.reload ?? settled
/**
 * Keeps the teams at work current: read again as the change stream reports steps (their Bots' work and requests) or tickets
 * (proposals) changed; polled every 2 seconds while a step runs and the stream is down, else every 5.
 */
export function WorkProvider({ children }: { children: ReactNode }) {
  const { call } = usePanel()
  const [busy, setBusy] = useState(false)
  const steps = useLive(() => call('GET team/steps'), [busy], ['steps', 'tickets'], busy ? 2000 : 5000)
  const proposals = useLive(() => call('GET team/proposals'), [], ['tickets'], 5000)
  const running = !!steps.data?.tickets.some(team => team.steps.some(step => step.state === 'running'))
  useEffect(() => { setBusy(running) }, [running])
  const value = useMemo<Work>(() => ({ teams: steps.data?.tickets ?? [], approvals: steps.data?.approvals ?? [],
    proposals: proposals.data?.waiting, loaded: !!steps.data && !!proposals.data,
    reload: async () => { await Promise.all([steps.reload(), proposals.reload()]) } }), [steps.data, proposals.data, steps.reload, proposals.reload])
  return <WorkContext.Provider value={value}>{children}</WorkContext.Provider>
}

// ── Small pieces ──────────────────────────────────────────────────────────────────────────────────────────────────

const PHRASES: [RegExp, string][] = [[/^(read|grep|glob|find|search|ls|list)/i, 'work.doing.look'], [/^(write|edit|patch|apply)/i, 'work.doing.write'],
  [/^(pwsh|shell|bash|exec|run|powershell|cmd)/i, 'work.doing.shell'], [/^web/i, 'work.doing.web'], [/^subagent/i, 'work.doing.subagent'],
  [/^todo/i, 'work.doing.plan'], [/^orchestrator_step_report$/, 'work.doing.report']]
/** What a Bot does, as a short phrase: its own description, else the kind of tool and what it acts on. */
export function doingText(t: ReturnType<typeof usePanel>['t'], doing: Step['doing']): string {
  if (!doing) return t('work.doing.think')
  if (doing.note) return doing.note
  const key = PHRASES.find(([pattern]) => pattern.test(doing.tool))?.[1]
  const phrase = key ? t(key as 'work.doing.look') : t('work.doing.tool', { tool: doing.tool })
  return doing.target ? `${phrase} · ${doing.target}` : phrase
}
/** Seconds since `since`, as DeepSeek-Bot's member rows count them: 12s, 3m 4s, 1h 2m. */
export function elapsedLabel(since: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000))
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`
}
export function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0)
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(timer) }, [])
  return <span className="dt-elapsed">{elapsedLabel(since)}</span>
}
const ENDED_UNFINISHED: readonly StepState[] = ['failed', 'skipped', 'stopped']

/**
 * The teams waiting for the person to agree, each with its members, steps and the agree and refuse buttons; shown in the
 * Overview and, in a VsSaros workbench, above the desk's conversation (2026-11-05: the person must see a proposal to agree).
 */
export function StaffingList({ teams }: { teams: NonNullable<Work['proposals']> }) {
  const { t, call } = usePanel()
  const reload = useReload()
  const agree = useAction((input: { id: string; version: number }) => call('POST tickets/:id/team/approve', { id: input.id, body: { version: input.version } }),
    { reload })
  const refuse = useAction((id: string) => call('POST tickets/:id/team/reject', { id, body: {} }), { reload })
  return <ul className="dt-list dt-cards" data-testid="team-staffing">{teams.map(({ ticket, proposal }) => <li key={ticket.id} className="dt-row dt-link">
    <div className="dt-row-main">
      <div className="dt-row-title">{ticket.title} {proposal
        ? <span className="dt-tag" data-tone="warning">v{proposal.version}</span>
        : <span className="dt-tag" data-tone="neutral">{t('team.staffingProposing')}</span>}</div>
      {proposal && <div className="dt-row-meta">
        <span>{proposal.roles.map(role => `${role.bot?.name ?? role.draft?.name ?? role.key}${role.draft ? t('team.staffingNew') : ''}`).join('、')}</span>
        <span>{proposal.steps.map(step => step.title).join(' → ')}</span>
        {(proposal.risk.newBots > 0 || proposal.risk.writeSteps > 0 || proposal.risk.highRiskTools.length > 0) &&
          <span className="dt-tag" data-tone="warning">{t('team.risky')}</span>}
      </div>}
    </div>
    {proposal && <div className="dt-row-actions">
      <Button variant="primary" size="sm" disabled={agree.busy} onClick={() => { void agree.run({ id: ticket.id, version: proposal.version }) }}>{t('team.staffingAgree')}</Button>
      <ConfirmButton variant="outline" label={t('team.staffingRefuse')} title={t('team.staffingRefuseTitle')}
        message={t('team.staffingRefuseConfirm', { title: ticket.title })} onConfirm={async () => { await refuse.run(ticket.id) }} />
    </div>}
  </li>)}</ul>
}

/** A step's request to reach beyond its directory, waiting for the person. */
export function ApprovalCard({ approval }: { approval: StepApprovalView }) {
  const { t, call } = usePanel()
  const reload = useReload()
  const answer = useAction((choice: 'allow' | 'remember' | 'reject') => call('POST steps/approvals/:id/answer', { id: approval.id, body: { choice } }), { reload })
  return <div className="dt-approval" data-testid="step-approval">
    <div className="dt-approval-head"><BotMark id={approval.bot.id} size={22} state="alert" />
      <b>{t('work.approvalTitle', { bot: approval.bot.name, step: approval.step })}</b>
      <span className="dt-approval-ticket">{approval.ticketTitle}</span></div>
    {approval.detail.code && <code className="dt-approval-code">{approval.detail.code}</code>}
    <span className="dt-approval-why">{approval.detail.text ?? approval.reason}</span>
    {approval.feishu && <span className="dt-approval-why">{t('work.approvalFeishu', { code: approval.code })}</span>}
    {approval.restored && <span className="dt-approval-why">{t('work.approvalRestored')}</span>}
    {approval.expiresAt && <span className="dt-approval-why">{t('work.approvalExpires',
      { time: new Date(approval.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</span>}
    <div className="dt-row-actions">
      <Button variant="outline" size="sm" disabled={answer.busy} onClick={() => { void answer.run('reject') }}>{t('work.reject')}</Button>
      <Button variant="primary" size="sm" disabled={answer.busy} onClick={() => { void answer.run('allow') }}>{t('work.allow')}</Button>
      <Button variant="outline" size="sm" disabled={answer.busy} onClick={() => { void answer.run('remember') }}>{t('work.remember')}</Button>
    </div>
  </div>
}

/** One line per step of a team: its Bot, what it does now and for how long, and a stop button while it is unfinished. */
export function StepMembers({ team }: { team: StepsView }) {
  const { t, call } = usePanel()
  const reload = useReload()
  const stop = useAction((key: string) => call('POST tickets/:id/steps/:key/stop', { id: team.ticket.id, key }), { reload })
  // VsSaros fix (2026-11-06): a step blocked on its sandbox runs without one only when a person says so here.
  const unsandboxed = useAction((key: string) => call('POST tickets/:id/steps/:key/unsandboxed', { id: team.ticket.id, key }), { reload })
  return <ul className="dt-members">{team.steps.map(step => {
    const running = step.state === 'running'
    const line = step.approval ? <span className="dt-member-alert">{t('work.waitsForYou')}</span>
      : step.needs ? <span className="dt-member-alert">{t(step.needs === 'sandbox' ? 'work.needsSandbox' : 'work.needsPermission')}</span>
      : running ? <span className="dt-shimmer">{doingText(t, step.doing)}</span>
        : <span>{t(`team.step.${step.state}`)}{step.state === 'ready' && step.report ? ` · ${step.report}` : ''}</span>
    return <li key={step.key} className="dt-member">
      <BotMark id={step.botId} name={step.bot} size={30} state={stepMarkState(step)} live faded={ENDED_UNFINISHED.includes(step.state)} />
      <div className="dt-member-main">
        <div className="dt-member-name">{step.bot} <span className="dt-member-step">{step.key} {step.title}</span>
          {step.access === 'write' && <span className="dt-tag" data-tone="outline">{t('work.writes')}</span>}
          {step.unsandboxed && <span className="dt-tag" data-tone="warning" title={t('work.unsandboxedHint')}>{t('work.unsandboxed')}</span>}</div>
        <div className="dt-member-line">{line}{running && step.since && <> · <Elapsed since={step.since} /></>}</div>
      </div>
      {step.needs && <Button variant="outline" size="sm" disabled={unsandboxed.busy} title={t('work.unsandboxedHint')}
        onClick={() => { void unsandboxed.run(step.key) }}>{t('work.allowUnsandboxed')}</Button>}
      {!FINISHED.includes(step.state) && <Button variant="outline" size="sm" disabled={stop.busy} aria-label={t('work.stopStep', { step: step.key })}
        onClick={() => { void stop.run(step.key) }}>{t('work.stop')}</Button>}
    </li>
  })}</ul>
}

// ── The dependency graph ──────────────────────────────────────────────────────────────────────────────────────────

/** Each step's column (the longest chain of steps before it) and row within its column. */
export function layoutSteps(steps: readonly Pick<Step, 'key' | 'after'>[]): Map<string, { col: number; row: number }> {
  const col = new Map<string, number>()
  const colOf = (key: string, depth = 0): number => {
    if (col.has(key)) return col.get(key)!
    const step = steps.find(item => item.key === key)
    const value = !step || depth > steps.length || !step.after.length ? 0 : 1 + Math.max(...step.after.map(before => colOf(before, depth + 1)))
    col.set(key, value)
    return value
  }
  const rows = new Map<number, number>(), place = new Map<string, { col: number; row: number }>()
  for (const step of steps) {
    const c = colOf(step.key), r = rows.get(c) ?? 0
    rows.set(c, r + 1)
    place.set(step.key, { col: c, row: r })
  }
  return place
}
const tone = (step: Step): StepState | 'alert' => step.approval ? 'alert' : step.state

/** A team's flow at a glance; clicking it opens the Workbench tab, where there is one. */
export function MiniFlow({ team, onOpen }: { team: StepsView; onOpen?: (() => void) | undefined }) {
  const { t } = usePanel()
  const place = layoutSteps(team.steps)
  const W = 52, H = 22, GX = 30, GY = 10
  const x = (key: string) => 6 + place.get(key)!.col * (W + GX), y = (key: string) => 6 + place.get(key)!.row * (H + GY)
  const width = Math.max(...team.steps.map(step => x(step.key))) + W + 6, height = Math.max(...team.steps.map(step => y(step.key))) + H + 6
  const Frame = onOpen ? 'button' : 'div'
  return <Frame {...onOpen ? { type: 'button' as const, onClick: onOpen, 'aria-label': t('work.openFlow', { title: team.ticket.title }) } : { role: 'img', 'aria-label': team.ticket.title }}
    className="dt-mini-flow">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {team.steps.flatMap(step => step.after.filter(before => place.has(before)).map(before => {
        const x1 = x(before) + W, y1 = y(before) + H / 2, x2 = x(step.key), y2 = y(step.key) + H / 2, mid = (x1 + x2) / 2
        return <path key={`${before}-${step.key}`} className="dt-flow-line" data-state={tone(step)} d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`} />
      }))}
      {team.steps.map(step => <g key={step.key} className="dt-mini-node" data-state={tone(step)}>
        <rect x={x(step.key)} y={y(step.key)} width={W} height={H} rx={6} />
        <text x={x(step.key) + W / 2} y={y(step.key) + 15} textAnchor="middle">{step.key}{step.attempts > 1 ? ' ↻' : ''}</text>
      </g>)}
    </svg>
  </Frame>
}

const NODE_W = 236, NODE_H = 86, GAP_X = 104, GAP_Y = 28, PAD = 28
function FlowView({ team, selected, onSelect }: { team: StepsView; selected?: string; onSelect: (key: string) => void }) {
  const { t } = usePanel()
  const place = layoutSteps(team.steps)
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const drag = useRef<{ x: number; y: number; from: typeof view } | undefined>(undefined)
  const left = (key: string) => PAD + place.get(key)!.col * (NODE_W + GAP_X), top = (key: string) => PAD + place.get(key)!.row * (NODE_H + GAP_Y)
  const width = Math.max(...team.steps.map(step => left(step.key))) + NODE_W + PAD
  const height = Math.max(...team.steps.map(step => top(step.key))) + NODE_H + PAD
  const zoomTo = (factor: number) => setView(current => ({ ...current, zoom: Math.min(1.65, Math.max(0.5, current.zoom * factor)) }))
  const wheel = (event: WheelEvent<HTMLDivElement>) => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoomTo(event.deltaY < 0 ? 1.12 : 0.89) } }
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('.dt-flow-node, .dt-flow-zoom')) return
    drag.current = { x: event.clientX, y: event.clientY, from: view }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (start) setView({ ...start.from, x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y })
  }
  return <div className="dt-graph" role="group" aria-label={t('work.view.flow')} onWheel={wheel} onPointerDown={down} onPointerMove={move}
    onPointerUp={() => { drag.current = undefined }}>
    <div className="dt-flow-zoom">
      <button type="button" aria-label={t('work.zoomOut')} onClick={() => zoomTo(0.86)}>−</button>
      <span>{Math.round(view.zoom * 100)}%</span>
      <button type="button" aria-label={t('work.zoomIn')} onClick={() => zoomTo(1.16)}>+</button>
      <button type="button" aria-label={t('work.fit')} onClick={() => setView({ x: 0, y: 0, zoom: 1 })}>⤢</button>
    </div>
    <div className="dt-flow-canvas" style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
      <svg className="dt-flow-lines" width={width} height={height} aria-hidden="true">
        {team.steps.flatMap(step => step.after.filter(before => place.has(before)).map(before => {
          const x1 = left(before) + NODE_W, y1 = top(before) + NODE_H / 2, x2 = left(step.key), y2 = top(step.key) + NODE_H / 2, mid = (x1 + x2) / 2
          const d = `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`
          return <g key={`${before}-${step.key}`} data-state={tone(step)} className="dt-flow-edge">
            <path className="dt-flow-glow" d={d} /><path className="dt-flow-line" d={d} />
            {step.state === 'running' && <path className="dt-flow-moving" d={d} />}
          </g>
        }))}
      </svg>
      {team.steps.map(step => <button key={step.key} type="button" className="dt-flow-node" data-state={tone(step)} aria-pressed={selected === step.key}
        style={{ left: left(step.key), top: top(step.key), width: NODE_W, height: NODE_H }} onClick={() => onSelect(step.key)}>
        <span className="dt-flow-node-title"><span className="dt-flow-key">{step.key}</span>{step.title}</span>
        <span className="dt-flow-node-who"><BotMark id={step.botId} size={22} state={stepMarkState(step)} faded={ENDED_UNFINISHED.includes(step.state)} />{step.bot}
          <span className="dt-tag" data-tone={step.approval ? 'warning' : STEP_TONE[step.state]}>{step.approval ? t('work.waitsForYou') : t(`team.step.${step.state}`)}</span></span>
        <span className="dt-flow-node-meta">{step.access === 'write' ? t('work.writes') : t('work.reads')}{step.turns ? ` · ${t('work.turns', { turns: String(step.turns) })}` : ''}</span>
        {step.attempts > 1 && <span className="dt-flow-retry">↻{step.attempts}</span>}
        {step.state === 'running' && <span className="dt-flow-bar"><i /></span>}
      </button>)}
    </div>
  </div>
}

const COLUMNS: { key: string; states: readonly StepState[] }[] = [{ key: 'pending', states: ['pending'] }, { key: 'running', states: ['running'] },
  { key: 'blocked', states: ['blocked'] }, { key: 'ready', states: ['ready'] }, { key: 'ended', states: ['failed', 'skipped', 'stopped'] }]
function BoardView({ team, onSelect }: { team: StepsView; onSelect: (key: string) => void }) {
  const { t } = usePanel()
  return <div className="dt-board">{COLUMNS.map(column => {
    // A running step waiting for the person sits with the steps that wait for a person.
    const items = team.steps.filter(step => column.key === 'blocked' ? step.state === 'blocked' || !!step.approval
      : column.key === 'running' ? step.state === 'running' && !step.approval : column.states.includes(step.state))
    return <section key={column.key} className="dt-board-col" aria-label={t(`work.col.${column.key}` as 'work.col.pending')}>
      <h3>{t(`work.col.${column.key}` as 'work.col.pending')}<span>{items.length}</span></h3>
      {items.map(step => <button key={step.key} type="button" className="dt-board-card" data-state={tone(step)} onClick={() => onSelect(step.key)}>
        <span className="dt-flow-key">{step.key}{step.attempts > 1 ? ` ↻${step.attempts}` : ''}</span>
        <b>{step.title}</b>
        <span className="dt-board-who"><BotMark id={step.botId} size={16} faded={ENDED_UNFINISHED.includes(step.state)} />{step.bot} · {step.access === 'write' ? t('work.writes') : t('work.reads')}</span>
      </button>)}
    </section>
  })}</div>
}
function ListView({ team, onSelect }: { team: StepsView; onSelect: (key: string) => void }) {
  const { t } = usePanel()
  return <table className="dt-step-table">
    <thead><tr><th>{t('work.col.step')}</th><th>{t('work.col.bot')}</th><th>{t('work.col.after')}</th><th>{t('work.col.access')}</th>
      <th>{t('work.col.state')}</th><th>{t('work.col.turns')}</th></tr></thead>
    <tbody>{team.steps.map(step => <tr key={step.key} tabIndex={0} onClick={() => onSelect(step.key)} onKeyDown={event => { if (event.key === 'Enter') onSelect(step.key) }}>
      <td>{step.key} {step.title}{step.attempts > 1 ? ` ↻${step.attempts}` : ''}</td><td>{step.bot}</td><td>{step.after.join('、') || '—'}</td>
      <td>{step.access === 'write' ? t('work.writes') : t('work.reads')}</td>
      <td><span className="dt-tag" data-tone={step.approval ? 'warning' : STEP_TONE[step.state]}>{step.approval ? t('work.waitsForYou') : t(`team.step.${step.state}`)}</span></td>
      <td>{step.turns || '—'}</td></tr>)}</tbody>
  </table>
}

function StepDetail({ team, step, onClose }: { team: StepsView; step: Step; onClose: () => void }) {
  const { t, call, openSession, notify } = usePanel()
  const { approvals } = useWork()
  const reload = useReload()
  const stop = useAction(() => call('POST tickets/:id/steps/:key/stop', { id: team.ticket.id, key: step.key }), { reload })
  const approval = approvals.find(item => item.id === step.approval)
  return <aside className="dt-step-detail" aria-label={t('work.detail', { step: step.key })}>
    <div className="dt-step-detail-head"><b>{step.key} {step.title}</b>
      <span className="dt-tag" data-tone={STEP_TONE[step.state]}>{t(`team.step.${step.state}`)}</span>
      <Button variant="ghost" size="sm" icon={<Icon name="close" />} aria-label={t('close')} onClick={onClose} /></div>
    <dl className="dt-step-facts">
      <dt>{t('work.col.bot')}</dt><dd>{step.bot}</dd>
      <dt>{t('work.col.after')}</dt><dd>{step.after.join('、') || '—'}</dd>
      <dt>{t('work.col.access')}</dt><dd>{step.access === 'write' ? t('work.writes') : t('work.reads')}{step.unsandboxed ? ` · ${t('work.unsandboxed')}` : ''}</dd>
      <dt>{t('work.col.turns')}</dt><dd>{step.turns}</dd>
      {step.state === 'running' && <><dt>{t('work.now')}</dt><dd>{doingText(t, step.doing)}{step.since && <> · <Elapsed since={step.since} /></>}</dd></>}
    </dl>
    {approval && <ApprovalCard approval={approval} />}
    {(step.failures?.length ?? 0) > 0 && <div className="dt-step-attempts">
      <b>{t('work.attempts')}</b>
      {step.failures!.map((failure, index) => <span key={index}><span className="dt-tag" data-tone="danger">{t('work.attempt', { n: String(index + 1) })}</span> {failure}</span>)}
      {step.attempts > step.failures!.length && <span><span className="dt-tag" data-tone={STEP_TONE[step.state]}>{t('work.attempt', { n: String(step.attempts) })}</span> {t(`team.step.${step.state}`)}</span>}
    </div>}
    {step.report && <p className="dt-step-report">{step.report}</p>}
    <div className="dt-row-actions">
      <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />}
        onClick={() => { openSession(`step-${team.ticket.id}-${step.key}`).catch(failure => notify(errorText(failure))) }}>{t('work.openSession')}</Button>
      {!FINISHED.includes(step.state) && <Button variant="outline" size="sm" disabled={stop.busy} onClick={() => { void stop.run() }}>{t('work.stop')}</Button>}
    </div>
  </aside>
}

type View = 'flow' | 'board' | 'list'
const VIEW_KEY = 'dsh-superagent/work-view'
/** The team's steps as a flow, a board or a list (2026-11-09: hosted inside the Execution tab).
 *  `embedded` = 执行页内嵌：那一页已有 <GroupRuns compact />，这里不再重复轮询群进度。 */
export function WorkPage({ ticketId, embedded = false }: { ticketId?: string; embedded?: boolean }) {
  const { t } = usePanel()
  const { teams, approvals, loaded } = useWork()
  const [chosen, setChosen] = useState(ticketId)
  const [view, setViewState] = useState<View>(() => (['flow', 'board', 'list'] as const).find(item => item === sessionStorage.getItem(VIEW_KEY)) ?? 'flow')
  const setView = (next: View) => { setViewState(next); try { sessionStorage.setItem(VIEW_KEY, next) } catch { /* a convenience */ } }
  const [selected, setSelected] = useState<string>()
  const team = teams.find(item => item.ticket.id === chosen) ?? teams[0]
  const groupRuns = embedded ? null : <GroupRuns />
  if (!loaded) return <>{groupRuns}<Hint>{t('loading')}</Hint></>
  if (!team) return <div className="dt-work">{groupRuns}<Hint>{t('work.empty')}</Hint></div>
  const step = team.steps.find(item => item.key === selected)
  const waiting = approvals.filter(item => item.ticketId === team.ticket.id)
  const done = team.steps.filter(item => item.state === 'ready').length
  return <div className="dt-work">
    {groupRuns}
    {teams.length > 1 && <div className="dt-work-teams" role="group" aria-label={t('work.teams')}>{teams.map(item =>
      <button key={item.ticket.id} type="button" className="dt-work-team" aria-pressed={item.ticket.id === team.ticket.id}
        onClick={() => { setChosen(item.ticket.id); setSelected(undefined) }}>{item.ticket.title}</button>)}</div>}
    <div className="dt-work-bar">
      <span className="dt-work-dot" data-live={team.steps.some(item => item.state === 'running') || undefined} />
      <b>{team.ticket.title}</b><span className="dt-hint">{t('team.stepsDone', { done: String(done), total: String(team.steps.length) })}</span>
      <SegmentedTabs className="dt-work-views" label={t('work.views')} value={view} onChange={next => setView(next)}
        items={(['flow', 'board', 'list'] as const).map(value => ({ value, label: t(`work.view.${value}`), id: `dt-work-${value}`, panelId: 'dt-work-view' }))} />
    </div>
    {waiting.map(item => <ApprovalCard key={item.id} approval={item} />)}
    <div className="dt-work-body" id="dt-work-view">
      {view === 'flow' ? <FlowView team={team} selected={selected} onSelect={setSelected} />
        : view === 'board' ? <BoardView team={team} onSelect={setSelected} /> : <ListView team={team} onSelect={setSelected} />}
      {step && <StepDetail team={team} step={step} onClose={() => setSelected(undefined)} />}
    </div>
  </div>
}
