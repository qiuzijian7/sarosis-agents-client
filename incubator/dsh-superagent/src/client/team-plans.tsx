/** VsSaros addition: the Overview's team plans, Bot drafts waiting for a person, and the skills/workflows plans leave behind. */
import { useState } from 'react'
import { usePoll } from './api.ts'
import { Button, Input } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { ConfirmButton, Hint, Section } from './widgets.tsx'

/** Renders nothing when no plan, no draft and no retrospective output exists. */
export function TeamPlans() {
  const { t, call } = usePanel()
  const plans = usePoll(() => call('GET team/plans'), [], 5000)
  const drafts = usePoll(() => call('GET team/approvals'), [], 10_000)
  const retro = usePoll(() => call('GET team/retrospective'), [], 10_000)
  const bots = usePoll(() => call('GET team/bots'), [], 30_000)
  const [open, setOpen] = useState(false)
  const [goal, setGoal] = useState('')
  const [lines, setLines] = useState('')
  const create = useAction((input: { goal: string; steps: { key: string; title: string; spec: string; bot: string; after: string[] }[] }) =>
    call('POST team/plans', { body: input }), { reload: plans.reload })
  /** One line per step: `title | bot | spec`; steps default to running in parallel. */
  const submit = async () => {
    const steps = lines.split('\n').map(line => line.trim()).filter(Boolean).map((line, i) => {
      const [title, bot, ...rest] = line.split('|').map(part => part.trim())
      return { key: `T${i + 1}`, title: title || `T${i + 1}`, bot: bot || bots.data?.bots[0]?.id || '',
        spec: rest.join(' | ') || title || '', after: [] }
    })
    if (!goal.trim() || !steps.length || steps.some(step => !step.bot)) return
    await create.run({ goal: goal.trim(), steps })
    setOpen(false); setGoal(''); setLines('')
  }
  const stop = useAction((id: string) => call('POST team/plans/:id/stop', { id }), { reload: plans.reload })
  const approveBot = useAction((id: string) => call('POST team/approvals/:id/approve', { id }), { reload: drafts.reload })
  const rejectBot = useAction((id: string) => call('POST team/approvals/:id/reject', { id }), { reload: drafts.reload })
  const approveSkill = useAction((id: string) => call('POST team/skills/:id/approve', { id }), { reload: retro.reload })
  const rejectSkill = useAction((id: string) => call('POST team/skills/:id/reject', { id }), { reload: retro.reload })
  const saveWorkflow = useAction((id: string) => call('POST team/workflows/:id/save', { id }), { reload: retro.reload })
  const runWorkflow = useAction((id: string) => call('POST team/workflows/:id/run', { id }), { reload: plans.reload })
  const waiting = drafts.data?.waiting ?? []
  const skills = retro.data?.skills ?? []
  const pendingSkills = skills.filter(skill => skill.state === 'draft')
  const workflows = retro.data?.workflows ?? []
  const availableBots = bots.data?.available ? bots.data.bots : []
  return <>
    {availableBots.length > 0 && <div className="dt-form dt-block" data-testid="team-new">
      <h2 className="dt-block-title">{t('team.new')} <span className="dt-hint">{t('team.botsReady', { count: String(availableBots.length) })}</span></h2>
      {!open ? <div className="dt-row-actions"><Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t('team.newOpen')}</Button></div>
        : <>
          <label className="dt-field"><span>{t('team.newGoal')}</span>
            <Input value={goal} onChange={event => setGoal(event.target.value)} placeholder={t('team.newGoalHint')} /></label>
          <label className="dt-field"><span>{t('team.newSteps')}</span>
            <textarea className="dt-textarea" rows={4} value={lines} onChange={event => setLines(event.target.value)}
              placeholder={availableBots[0]!.name} /></label>
          <p className="dt-hint">{t('team.newHint')}</p>
          <div className="dt-row-actions">
            <Button variant="primary" size="sm" disabled={create.busy || !goal.trim() || !lines.trim()} onClick={() => { void submit() }}>{t('team.submit')}</Button>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>{t('team.cancel')}</Button>
          </div>
        </>}
    </div>}
    {pendingSkills.length > 0 && <Section title={t('team.skillPending')} count={pendingSkills.length}>
      <ul className="dt-list dt-cards">{pendingSkills.map(skill => <li key={skill.id} className="dt-row dt-link">
        <div className="dt-row-main">
          <div className="dt-row-title">{skill.title} <span className="dt-tag" data-tone="warning">{t('team.risky')}</span></div>
          <div className="dt-row-meta"><span>{skill.scope}</span><span>{skill.evidence}</span><span>{skill.body.slice(0, 100)}</span></div>
        </div>
        <div className="dt-row-actions">
          <Button variant="primary" size="sm" disabled={approveSkill.busy} onClick={() => { void approveSkill.run(skill.id) }}>{t('team.skillApprove')}</Button>
          <Button variant="outline" size="sm" disabled={rejectSkill.busy} onClick={() => { void rejectSkill.run(skill.id) }}>{t('team.skillReject')}</Button>
        </div>
      </li>)}</ul>
    </Section>}
    {skills.some(skill => skill.state === 'active') && <Hint>{t('team.skills', { count: String(skills.filter(skill => skill.state === 'active').length) })}</Hint>}
    {workflows.length > 0 && <Section title={t('team.workflows')} count={workflows.length}>
      <ul className="dt-list dt-cards">{workflows.map(workflow => <li key={workflow.id} className="dt-row dt-link">
        <div className="dt-row-main">
          <div className="dt-row-title">{workflow.name}
            {workflow.state === 'draft' ? <span className="dt-tag" data-tone="warning">{t('team.wfDraft')}</span>
              : <span className="dt-tag" data-tone="success">v{workflow.version}</span>}</div>
          <div className="dt-row-meta"><span>{t('team.wfRuns', { runs: String(workflow.runs), ok: String(workflow.ok) })}</span>
            <span>{workflow.steps.length} {t('team.wfSteps')}</span><span>{workflow.triggers.join(' · ')}</span></div>
        </div>
        <div className="dt-row-actions">
          {workflow.state === 'draft'
            ? <Button variant="primary" size="sm" disabled={saveWorkflow.busy} onClick={() => { void saveWorkflow.run(workflow.id) }}>{t('team.wfSave')}</Button>
            : <Button variant="outline" size="sm" disabled={runWorkflow.busy} onClick={() => { void runWorkflow.run(workflow.id) }}>{t('team.wfRun')}</Button>}
        </div>
      </li>)}</ul>
    </Section>}
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
    {!plans.data?.plans.length ? null : <Section title={t('team.pending')} count={plans.data.plans.length}>
      {!plans.data.available && <Hint>{t('team.botsUnavailable')}</Hint>}
      <ul className="dt-list dt-cards">{plans.data.plans.slice(0, 3).map(plan => <li key={plan.id} className="dt-row dt-link">
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
        {plan.status === 'running' && <div className="dt-row-actions"><ConfirmButton variant="outline" icon="stop"
          label={t('team.stop')} title={t('team.stopTitle')} message={t('team.stopConfirm', { goal: plan.goal })}
          onConfirm={async () => { await stop.run(plan.id) }} /></div>}
      </li>)}</ul>
    </Section>}
  </>
}
