/**
 * VsSaros addition (plan C): key-node cards in the supervisor desk's own (DSH) conversation. The desk hands each of the
 * person's messages to the supervisor with its one tool; in DSH's chat that tool call is drawn as this card, which then
 * follows the message live (the change stream): evaluating, declined, or taken as a ticket; the team proposal to agree to
 * or refuse; the team at work with each Bot's mark and current work, its requests to approve, and a stop per step; and how
 * the ticket ended. A message that reached a ticket another message started only says which ticket it went to.
 *
 * After DS Bot's handoff card (ds-bot/src/client/handoff-card.js, Copyright 2026 Fei2411 and the DS Bot contributors,
 * Apache License 2.0; see NOTICE): a tool call in the chat drawn as a card that follows its state live.
 */
import type { ReactNode } from 'react'
import type { DeskFlow, DeskFlowGroup } from '../app/desk-flow.ts'
import { Button } from './controls.tsx'
import { useLive } from './feed.ts'
import { groupRoundStatus, groupRunElapsed, groupRunForFlow, groupRunLatestEvent, groupRunReplies, groupRunStatusKey, useGroupRuns } from './group-runs.tsx'
import { BotMark, type MarkState } from './mark.tsx'
import { ticketMark } from './marks.ts'
import { useAction, usePanel } from './provider.tsx'
import { errorText, reasonLabel, valueLabel } from './text.ts'
import { ConfirmButton } from './widgets.tsx'
import { ApprovalCard, MiniFlow, StepMembers } from './work.tsx'

/** The trigger a settled `superagent_submit` call handed over, read from its JSON result. */
export function triggerOfResult(content: readonly { type?: string; text?: string }[] | undefined): string | undefined {
  for (const block of content ?? []) {
    if (block.type !== 'text' || !block.text) continue
    try {
      const value = JSON.parse(block.text) as { trigger?: unknown }
      if (typeof value.trigger === 'string' && value.trigger) return value.trigger
    } catch { /* not this block */ }
  }
  return undefined
}

/** The supervisor's mark for where a message stands. */
function supervisorState(flow: DeskFlow): MarkState {
  if (flow.state === 'evaluating' || flow.state === 'unknown') return 'thinking'
  if (flow.state !== 'ticket' || !flow.ticket || flow.ticket.ended) return 'idle'
  if (flow.approvals.length || flow.proposal?.state === 'proposed') return 'alert'
  if (flow.team?.steps.some(step => step.state === 'running')) return 'waiting'
  return flow.ticket.stage.stage === 'working' ? 'working' : 'idle'
}

type NodeState = 'done' | 'active' | 'wait' | 'fail'
function Node({ state, title, children }: { state: NodeState; title: ReactNode; children?: ReactNode }) {
  return <li className="dt-fc-node" data-state={state}>
    <span className="dt-fc-dot" aria-hidden="true" />
    <div className="dt-fc-node-main"><div className="dt-fc-node-title">{title}</div>{children}</div>
  </li>
}

/**
 * VsSaros addition (2026-11-06): a message a group chat took. The desk records it as `ignore` on purpose (the supervisor
 * stays out of a group's work), so this card says where it went and follows the group's run live, instead of "not taken".
 */
function GroupFlow({ group }: { group: DeskFlowGroup }) {
  const { t, openSession, notify } = usePanel()
  const run = groupRunForFlow(useGroupRuns(), group)
  const status = run ? groupRoundStatus(run) : undefined
  const replies = run ? groupRunReplies(run).length : 0
  const latest = run ? groupRunLatestEvent(run) : undefined
  return <div className="dt-fc" data-testid="flow-card" data-state="group" data-group-room={group.roomId} data-group-run-status={status ?? ''}>
    <div className="dt-fc-head">
      <BotMark id="superagent" name={t('chat.supervisor')} size={26} state="idle" />
      <div className="dt-fc-head-main">
        <b>{t(group.kind === 'created' ? 'flow.groupCreated' : group.kind === 'updated' ? 'flow.groupUpdated' : 'flow.groupRouted', { name: group.roomName })}</b>
        {run && <span className="dt-tag" data-tone={status === 'failed' || status === 'cut' ? 'warning' : status === 'done' ? 'success' : 'info'}>
          {t(groupRunStatusKey(run))}</span>}
      </div>
    </div>
    <p className="dt-fc-note">
      {run ? `${t('groupRuns.replies', { n: String(replies) })} · ${t('groupRuns.elapsed', { n: String(groupRunElapsed(run)) })}`
        + (latest?.text ? ` · ${String(latest.text).slice(0, 80)}` : '')
        : t('flow.groupNote')}
    </p>
    <div className="dt-row-actions">
      <Button variant="outline" size="sm" data-act="open-flow-group"
        onClick={() => { openSession(group.roomId).catch(failure => notify(errorText(failure))) }}>{t('groupRuns.open')}</Button>
    </div>
  </div>
}

/**
 * One message's card, kept current by the change stream. VsSaros addition (2026-11-06): `receipt` draws only how its ticket
 * ended (title, outcome, the team's steps, the summary), for the desk's turn that tells the person a ticket ended.
 */
export function FlowCard({ triggerId, receipt = false }: { triggerId: string; receipt?: boolean }) {
  const { t, call, openSession, notify } = usePanel()
  const { data, error, reload } = useLive(() => call('GET desk/flow/:id', { id: triggerId }), [triggerId], ['tickets', 'steps'], 4000)
  const agree = useAction((input: { id: string; version: number }) => call('POST tickets/:id/team/approve', { id: input.id, body: { version: input.version } }), { reload })
  const refuse = useAction((id: string) => call('POST tickets/:id/team/reject', { id, body: {} }), { reload })
  if (!data) return <div className="dt-fc dt-fc-line" data-testid="flow-card">
    <BotMark id="superagent" size={18} state="thinking" />{error ? error.message : t('flow.handed')}</div>
  if (data.state === 'group' && data.group) return <GroupFlow group={data.group} />
  const head = (text: ReactNode, tag?: ReactNode) => <div className="dt-fc-head">
    <BotMark id="superagent" name={t('chat.supervisor')} size={26} state={supervisorState(data)} />
    <div className="dt-fc-head-main"><b>{text}</b>{tag}</div>
  </div>
  const alsoGroup = data.group && <p className="dt-fc-note" data-testid="flow-card-group">
    {t('flow.alsoGroup', { name: data.group.roomName })}{' '}
    <button type="button" className="dt-textlink" data-act="open-flow-group"
      onClick={() => { openSession(data.group!.roomId).catch(failure => notify(errorText(failure))) }}>{t('groupRuns.open')}</button></p>
  if (data.state === 'unknown' || data.state === 'evaluating') return <div className="dt-fc" data-testid="flow-card">
    {head(<span className="dt-shimmer">{t(data.unavailable ? 'flow.evalRetry' : 'flow.evaluating')}</span>)}</div>
  if (data.state === 'filtered' || data.state === 'declined') return <div className="dt-fc" data-testid="flow-card" data-state="declined">
    {head(t(data.state === 'filtered' ? 'flow.filtered' : 'flow.declined'))}
    {data.reasons?.length ? <p className="dt-fc-note">{reasonLabel(t, data.reasons)}</p> : null}</div>
  const ticket = data.ticket!
  const mark = ticketMark(t, { ...ticket.stage, ended: ticket.ended } as never)
  const stage = <span className="dt-tag" data-tone={mark.tone}>{mark.label}</span>
  if (receipt && ticket.ended && !data.followup) {
    const ended = ticket.ended, note = ticket.report?.summary || ended.reason
    return <div className="dt-fc" data-testid="flow-card" data-receipt="ended" data-outcome={ended.outcome}>
      {head(t('flow.receipt', { title: ticket.title }), stage)}
      {data.team && <MiniFlow team={data.team} />}
      {note && <p className="dt-fc-note">{note}</p>}
    </div>
  }
  if (data.followup) return <div className="dt-fc dt-fc-line" data-testid="flow-card">
    <BotMark id="superagent" size={18} />{t('flow.followup', { title: ticket.title })}{stage}{alsoGroup}</div>

  const proposal = data.proposal, team = data.team
  const waitingProposal = proposal?.state === 'proposed'
  const proposalState: NodeState = !proposal ? 'wait' : proposal.state === 'approved' ? 'done' : proposal.state === 'rejected' ? 'fail' : 'active'
  const done = team ? team.steps.filter(step => step.state === 'ready').length : 0
  const teamState: NodeState = !team ? 'wait' : ticket.ended ? (done === team.steps.length ? 'done' : 'fail')
    : team.steps.every(step => ['ready', 'failed', 'skipped', 'stopped'].includes(step.state)) ? 'done' : 'active'
  const ended = ticket.ended
  return <div className="dt-fc" data-testid="flow-card">
    {head(ticket.title, stage)}
    {alsoGroup}
    <ol className="dt-fc-nodes">
      <Node state="done" title={t('flow.taken')} />
      <Node state={proposalState} title={proposal ? t('flow.proposal', { version: String(proposal.version) }) : t('flow.proposing')}>
        {proposal && <div className="dt-fc-proposal">
          <div className="dt-fc-roles">{proposal.roles.map(role => <span key={role.key} className="dt-fc-role">
            <BotMark id={role.bot?.id ?? role.draft?.id ?? role.key} size={18} />
            {role.bot?.name ?? role.draft?.name ?? role.key}{role.draft ? <em>{t('team.staffingNew')}</em> : null}</span>)}</div>
          <div className="dt-fc-note">{proposal.steps.map(step => step.title).join(' → ')}</div>
          {(proposal.risk.newBots > 0 || proposal.risk.writeSteps > 0 || proposal.risk.highRiskTools.length > 0) &&
            <div className="dt-fc-note"><span className="dt-tag" data-tone="warning">{t('team.risky')}</span>
              {' '}{t('flow.risk', { bots: String(proposal.risk.newBots), writes: String(proposal.risk.writeSteps) })}</div>}
          {waitingProposal && <div className="dt-row-actions">
            <Button variant="primary" size="sm" disabled={agree.busy} onClick={() => { void agree.run({ id: ticket.id, version: proposal.version }) }}>{t('team.staffingAgree')}</Button>
            <ConfirmButton variant="outline" label={t('team.staffingRefuse')} title={t('team.staffingRefuseTitle')}
              message={t('team.staffingRefuseConfirm', { title: ticket.title })} onConfirm={async () => { await refuse.run(ticket.id) }} />
          </div>}
        </div>}
      </Node>
      {(team || proposal?.state === 'approved') && <Node state={teamState}
        title={team ? t('flow.team', { done: String(done), total: String(team.steps.length) }) : t('flow.teamStarting')}>
        {team && <MiniFlow team={team} />}
        {data.approvals.map(item => <ApprovalCard key={item.id} approval={item} />)}
        {team && !ended && <StepMembers team={team} />}
      </Node>}
      {ended
        ? <Node state={ended.outcome === 'completed' || ended.outcome === 'merged' ? 'done' : 'fail'}
          title={t('flow.ended', { outcome: valueLabel(t, 'outcome', ended.outcome) })}>
          {(ticket.report?.summary || ended.reason) && <p className="dt-fc-note">{ticket.report?.summary || ended.reason}</p>}
        </Node>
        : ticket.report && ticket.stage.stage === 'person' && <Node state="active" title={t('flow.report')}>
          <p className="dt-fc-note">{ticket.report.summary}</p>
        </Node>}
    </ol>
  </div>
}
