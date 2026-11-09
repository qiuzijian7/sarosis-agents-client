/**
 * VsSaros addition: the Overview's team work — requests and teams waiting for a person, team steps, skill drafts from the
 * memory system, Bot drafts — and, read-only, the retired team plans (2026-11-06).
 * ★ 2026-11-09: the reusable-workflows / TeamFlow section was removed from this panel (user request); the Host-side
 *   workflow data and adapter remain, so team staffing can still reuse saved workflows.
 */
import { usePoll } from './api.ts'
import type { StepsView } from '../app/steps.ts'
import { Button } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, Section } from './widgets.tsx'
import { ApprovalCard, MiniFlow, StaffingList, StepMembers, useWork } from './work.tsx'

/**
 * VsSaros addition (2026-11-06): what a team used of its budget. Its token and turn caps are hard gates; at either one, no
 * new step starts until a person raises it here (by half again).
 */
function TeamBudget({ ticketId, budget }: { ticketId: string; budget: NonNullable<StepsView['budget']> }) {
  const { t, call } = usePanel()
  const reached = budget.stopped || budget.turns >= budget.turnsCap
  const raise = useAction(() => call('POST tickets/:id/steps/budget', { id: ticketId, body: {
    tokens: Math.max(budget.tokensCap, budget.tokens) + Math.ceil(Math.max(budget.tokensCap, 10_000) / 2),
    turns: Math.max(budget.turnsCap, budget.turns) + Math.ceil(Math.max(budget.turnsCap, 2) / 2) } }))
  return <div className="dt-row-meta" data-testid="team-budget">
    <span>{t('team.budgetLine', { tokens: String(budget.tokens), tokensCap: String(budget.tokensCap), turns: String(budget.turns), turnsCap: String(budget.turnsCap) })}</span>
    {reached && <span className="dt-tag" data-tone="warning">{t('team.budgetReached')}</span>}
    {reached && <Button variant="outline" size="sm" disabled={raise.busy} onClick={() => { void raise.run() }}>{t('team.budgetRaise')}</Button>}
  </div>
}

/** Renders nothing when no plan, no draft and no retrospective output exists. */
export function TeamPlans() {
  const { t, call, navigate } = usePanel()
  const plans = usePoll(() => call('GET team/plans'), [], 5000)
  const drafts = usePoll(() => call('GET team/approvals'), [], 10_000)
  const retro = usePoll(() => call('GET team/retrospective'), [], 10_000)
  const approveBot = useAction((id: string) => call('POST team/approvals/:id/approve', { id }), { reload: drafts.reload })
  const rejectBot = useAction((id: string) => call('POST team/approvals/:id/reject', { id }), { reload: drafts.reload })
  const waiting = drafts.data?.waiting ?? []
  const archivedSkills = retro.data?.skills ?? []
  const work = useWork()
  const teams = work.proposals ?? []
  const teamTickets = work.teams
  const distills = usePoll(() => call('GET team/distills'), [], 15_000)
  const approveDraft = useAction((id: string) => call('POST team/distills/:id/approve', { id }), { reload: distills.reload })
  const rejectDraft = useAction((id: string) => call('POST team/distills/:id/reject', { id }), { reload: distills.reload })
  const drafts2 = (distills.data?.distills ?? []).filter(item => item.result?.skill?.state === 'draft' && item.result.skill.created)
  return <>
    {/* Ordered by who acts: a step's request for the person and a team waiting for them first, then the work in progress,
        then skills to review. */}
    {work.approvals.length > 0 && <Section title={t('work.needsYou')} count={work.approvals.length}>
      <div className="dt-approvals" data-testid="step-approvals">{work.approvals.map(item => <ApprovalCard key={item.id} approval={item} />)}</div>
    </Section>}
    {teams.length > 0 && <Section title={t('team.staffing')} count={teams.length}>
      <StaffingList teams={teams} />
    </Section>}
    {teamTickets.length > 0 && <Section title={t('team.steps')} count={teamTickets.length}>
      <ul className="dt-list dt-cards" data-testid="team-steps">{teamTickets.map(team => <li key={team.ticket.id} className="dt-row dt-team-run">
        <div className="dt-row-main">
          <div className="dt-row-title">{team.ticket.title} <span className="dt-tag" data-tone="neutral">
            {t('team.stepsDone', { done: String(team.steps.filter(step => step.state === 'ready').length), total: String(team.steps.length) })}</span></div>
          {team.budget && <TeamBudget ticketId={team.ticket.id} budget={team.budget} />}
          {/* ★ 2026-11-09：三视图已并入「执行」页签，深链直接指 execution（work 只是兼容别名）。 */}
          <MiniFlow team={team} onOpen={() => navigate({ page: 'execution', query: { ticket: team.ticket.id } })} />
          <StepMembers team={team} />
        </div>
      </li>)}</ul>
    </Section>}
    {drafts2.length > 0 && <Section title={t('team.distillPending')} count={drafts2.length}>
      <ul className="dt-list dt-cards" data-testid="team-distills">{drafts2.map(item => <li key={item.id} className="dt-row dt-link">
        <div className="dt-row-main">
          <div className="dt-row-title">{item.stepTitle} <span className="dt-tag" data-tone="neutral">{item.botName}</span>
            {/* VsSaros change (2026-11-06): its version, risk, and whether a model distilled it. */}
            {item.result!.skill!.version && <span className="dt-tag" data-tone="outline">v{item.result!.skill!.version}{item.result!.skill!.updates === 'active' ? ` · ${t('team.distillNewVersion')}` : ''}</span>}
            {item.result!.skill!.risk && <span className="dt-tag" data-tone={item.result!.skill!.risk === 'low' ? 'neutral' : 'warning'}
              title={item.result!.skill!.riskReasons?.join('；')}>{t(`team.distillRisk.${item.result!.skill!.risk}`)}</span>}
            {item.result!.skill!.distilled === false && <span className="dt-tag" data-tone="warning" title={item.result!.skill!.distillError}>{t('team.distillTemplate')}</span>}</div>
          <div className="dt-row-meta"><span>{item.result!.skill!.name}</span><span>{item.reasons.join(' · ')}</span>
            <span>{item.evidence.report.slice(0, 100)}</span></div>
        </div>
        <div className="dt-row-actions">
          <Button variant="primary" size="sm" disabled={approveDraft.busy} onClick={() => { void approveDraft.run(item.id) }}>{t('team.skillApprove')}</Button>
          <Button variant="outline" size="sm" disabled={rejectDraft.busy} onClick={() => { void rejectDraft.run(item.id) }}>{t('team.skillReject')}</Button>
        </div>
      </li>)}</ul>
    </Section>}
    {archivedSkills.length > 0 && <Hint>{t('team.skillsArchived', { count: String(archivedSkills.length) })}</Hint>}
    {/* ★ 2026-11-09（用户要求）：「团队工作流」UI 区块已移除。
        Host 侧的 team/retrospective.workflows、team/workflows/:id/*、team/teamflow/* 路由与适配器
        全部保留（组队匹配 / 沉淀仍依赖它们），只是不再在侧栏展示、不再提供手工保存/运行/导入导出。 */}
    {waiting.length > 0 && <Section title={t('team.approval')} count={waiting.length}>
      <ul className="dt-list dt-cards">{waiting.map(draft => <li key={draft.id} className="dt-row dt-link">
        <div className="dt-row-main">
          <div className="dt-row-title">{draft.draft.name} <span className="dt-tag" data-tone="warning">{draft.draft.id}</span></div>
          <div className="dt-row-meta"><span>{t('team.approvalLine', { risk: draft.risk.join(', ') })}</span>
            <span>{draft.draft.description}</span></div>
        </div>
        <div className="dt-row-actions">
          <Button variant="primary" size="sm" disabled={approveBot.busy} onClick={() => { void approveBot.run(draft.id) }}>{t('team.approve')}</Button>
          <Button variant="outline" size="sm" disabled={rejectBot.busy} onClick={() => { void rejectBot.run(draft.id) }}>{t('team.reject')}</Button>
        </div>
      </li>)}</ul>
    </Section>}
    {drafts.data && drafts.data.created.length > 0 && <Hint>{t('team.created', { count: String(drafts.data.created.length),
      global: String(drafts.data.global), perPlan: String(drafts.data.perPlan) })}</Hint>}
    {!plans.data?.plans.length ? null : <Section title={t('team.archivedPlans')} count={plans.data.plans.length}>
      <Hint>{t('team.archivedPlansHint')}</Hint>
      <ul className="dt-list dt-cards" data-testid="team-archived-plans">{plans.data.plans.slice(0, 3).map(plan => <li key={plan.id} className="dt-row dt-link">
        <div className="dt-row-main">
          <div className="dt-row-title">{plan.goal} <span className="dt-tag" data-tone="neutral">{t(`team.state.${plan.status}`)}</span></div>
          <div className="dt-row-meta"><span>{t('team.running', { running: String(plan.running) })}</span><span>{plan.bots.join(' · ')}</span></div>
          <ul className="dt-list">{plan.steps.map(step => <li key={step.id} className="dt-row">
            <div className="dt-row-main">
              <div className="dt-row-title">{t('team.step', { step: step.id, title: step.title, bot: step.botName ?? step.bot })}</div>
              <div className="dt-row-meta"><span>{t(`team.state.${step.state}`)}</span>
                {step.after.length > 0 && <span>{t('team.after', { after: step.after.join(', ') })}</span>}
                {step.report && <span>{step.report.length > 120 ? `${step.report.slice(0, 120)}…` : step.report}</span>}
                {step.error && <span>{step.error}</span>}
              </div>
            </div>
          </li>)}</ul>
        </div>
      </li>)}</ul>
    </Section>}
  </>
}
