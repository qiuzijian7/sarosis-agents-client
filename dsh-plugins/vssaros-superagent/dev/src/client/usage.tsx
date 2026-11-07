/**
 * VsSaros addition (2026-11-06, P2): on the execution page, what SuperAgent's Sessions used (the usage ledger, with the
 * context steward's last work), and the approval rules a person gave team Bots, with the templates to give more at once.
 */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, DisclosureRow, Icon } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint } from './widgets.tsx'

type Usage = ApiResponse<'GET usage'>
const ROLES = ['master', 'desk', 'worker', 'step'] as const
const tokens = (value: number) => value >= 10_000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : String(value)

export function UsagePanel() {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const { data } = usePoll(() => call('GET usage'), [])
  const usage: Usage | undefined = data
  return <DisclosureRow icon={<Icon name="clock" />} title={<>{t('usageTitle')} {usage && <span className="dt-count">{tokens(usage.day.total.total)}</span>}</>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body" data-testid="usage-panel">
      <Hint>{t('usageHint')}</Hint>
      {usage && <>
        <div className="dt-row-meta">
          <span>{t('usageDay', { total: tokens(usage.day.total.total), calls: String(usage.day.total.calls) })}</span>
          <span>{t('usageWeek', { total: tokens(usage.week.total) })}</span>
          <span>{t('usageCache', { read: tokens(usage.day.total.cacheRead) })}</span>
        </div>
        <ul className="dt-list">{ROLES.map(role => <li key={role} className="dt-row"><div className="dt-row-main">
          <div className="dt-row-meta"><span>{t(`usageRole.${role}`)}</span><span>{tokens(usage.day.byRole[role]?.total ?? 0)}</span>
            <span>{t('usageCalls', { calls: String(usage.day.byRole[role]?.calls ?? 0) })}</span></div>
        </div></li>)}</ul>
        {usage.day.byModel.length > 0 && <div className="dt-row-meta">{usage.day.byModel.slice(0, 5).map(item =>
          <span key={`${item.provider}/${item.model}`} className="dt-mono">{item.model || item.provider}: {tokens(item.total)}</span>)}</div>}
        {usage.day.byBot.length > 0 && <div className="dt-row-meta">{usage.day.byBot.slice(0, 5).map(item =>
          <span key={item.bot}>{item.bot}: {tokens(item.total)}</span>)}</div>}
        {usage.steward.length > 0 && <div className="dt-row-meta" data-testid="steward">{usage.steward.map(item =>
          <span key={item.session}>{t(`usageRole.${item.role}`)}{t('listSeparator')}
            {t(`steward.${item.outcome}`, { context: tokens(item.context ?? 0), line: tokens(item.line ?? 0) })}</span>)}</div>}
        {/* VsSaros addition (2026-11-07): calls another plugin made inside SuperAgent's Sessions (DS Bot's rewrites and OCR). */}
        {usage.day.relays.resent + usage.day.relays.side > 0 && <div className="dt-hint" data-testid="usage-relays">
          <p>{t(usage.coexist.dsBot ? 'usageRelaysDsBot' : 'usageRelaysOther', { resent: String(usage.day.relays.resent), side: String(usage.day.relays.side) })}
            {!usage.sideCalls && <> {t('sideCallsOff')}</>}</p>
          <ul className="dt-list">{usage.day.relays.sessions.slice(0, 5).map(item => <li key={item.session} className="dt-row-meta">
            <span>{t(`usageRole.${item.role}`)}{item.step ? ` · ${item.step}` : ''}</span>
            <span>{t('usageRelaySession', { resent: String(item.resent), side: String(item.side) })}</span></li>)}</ul>
        </div>}
      </>}
    </div>
  </DisclosureRow>
}

export function ApprovalRulesPanel() {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [bot, setBot] = useState('')
  const { data, reload } = usePoll(() => call('GET steps/rules'), [])
  const { data: bots } = usePoll(() => call('GET team/bots'), [])
  const apply = useAction((template: string) => {
    const card = bots?.bots.find(item => item.id === bot)
    return card ? call('POST steps/rules/templates/:id/apply', { id: template, body: { botId: card.id, botName: card.name } }) : Promise.resolve()
  }, { reload })
  const forget = useAction((id: string) => call('POST steps/rules/:id/delete', { id }), { reload })
  return <DisclosureRow icon={<Icon name="shield" />} title={<>{t('rulesTitle')} {data && <span className="dt-count">{data.rules.length}</span>}</>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body" data-testid="approval-rules">
      <Hint>{t('rulesTemplateHint')}</Hint>
      <div className="dt-row-meta">
        <select aria-label={t('rulesBot')} value={bot} onChange={event => { setBot(event.target.value) }}>
          <option value="">{t('rulesBot')}</option>
          {bots?.bots.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}
        </select>
        {data?.templates.map(template => <Button key={template.id} variant="outline" size="sm" disabled={!bot || apply.busy}
          title={template.heads.join(', ')} onClick={() => { void apply.run(template.id) }}>
          {t(`rulesTemplate.${template.id}`)}{template.risk !== 'low' ? ` · ${t('rulesRiskMedium')}` : ''}</Button>)}
      </div>
      {data && (data.rules.length ? <ul className="dt-list">{data.rules.map(rule => <li key={rule.id} className="dt-row"><div className="dt-row-main">
        <div className="dt-row-meta"><span>{rule.bot.name}</span><span className="dt-mono">{rule.tool}: {rule.head}</span>
          {rule.template && <span>{t(`rulesTemplate.${rule.template}`)}</span>}
          <button type="button" className="dt-textlink" disabled={forget.busy} onClick={() => { void forget.run(rule.id) }}>{t('rulesForget')}</button></div>
      </div></li>)}</ul> : <Hint>{t('rulesNone')}</Hint>)}
    </div>
  </DisclosureRow>
}
