/** Source status view (health, filtered Triggers, dropped replies) and Source settings cards. */
import { useEffect, useState } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type SourceStatusRow, type SourceView } from './api.ts'
import { DisclosureRow, Dot, Icon, InfoTip, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { sourceMark } from './marks.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { useFeishuCliCheck } from './cli-check.tsx'
import { TapdCredentials } from './tapd-credentials.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { ConfigHistory, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { actorName, healthText, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
import { CheckSetupButton, Hint, LabelValue, LoadState, SetupMessage, StatusHead, When } from './widgets.tsx'

/**
 * VsSaros addition: a Source kind's settings card. `title` overrides its heading, for a kind the panel shows somewhere
 * other than the Sources page (P4, which is a way to manage projects rather than a place work arrives from).
 */
export function SourceCard({ source, title }: { source: SourceView; title?: string }) {
  const { t, call } = usePanel()
  const { running } = usePanelData()
  const { reload } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const value = draft.value
  const { problem, value: saved } = source
  const changed = (key: string) => String(value.config[key] ?? '') !== String(saved.config[key] ?? '')
  // Saving a modified setup-sensitive field restarts dsh-superagent, interrupting running Assignments.
  const restarts = draft.dirty && source.restarts.some(changed)
  const description = localized(t, source.description)
  // VsSaros addition: the Feishu card's local CLI checks share one state between the input's action slot and the field's detail slot.
  const cli = useFeishuCliCheck(command => {
    if (!String(value.config.cli ?? '')) draft.edit({ ...value, config: { ...value.config, cli: command } })
  })
  // Hide derived facts for unsaved field edits until the new value is saved.
  const field = (spec: FieldSpec) => {
    const cliField = source.id === 'feishu' && spec.key === 'cli'
    return <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={saved.config[spec.key]}
      labels={source.labels} refreshLabels={refreshLabels}
      fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
      onChange={next => draft.edit({ ...value, config: { ...value.config, [spec.key]: next } })}
      action={cliField ? cli.actions : undefined} detail={cliField ? cli.details : undefined} />
  }
  const advanced = source.fields.filter(spec => spec.advanced)
  return <form id={`dt-source-${source.id}`} className="dt-card" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-card-head">
        <div className="dt-row-main">
          <div className="dt-row-title">
            <span className="dt-card-title">{title ?? localized(t, source.title)}</span>{description && <InfoTip text={description} />}
            {!source.installed && <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
          </div>
        </div>
        {source.installed && <Switch checked={value.enabled} onChange={enabled => draft.edit({ ...value, enabled })}
          label={t('sourceEnable', { name: localized(t, source.title) })} />}
      </div>
      {problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={problem} lead /></p><CheckSetupButton />
      </div>}
      {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
      {source.installed && source.fields.filter(spec => !spec.advanced).map(field)}
      {/* VsSaros addition: the Open API credentials live in the Host's credentials file, not in this card's settings. */}
      {source.installed && source.id === 'tapd' && String(value.config.transport ?? 'openapi') === 'openapi' && <TapdCredentials />}
      {source.installed && advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advancedOpen}
        onToggle={() => setAdvancedOpen(!advancedOpen)}>
        <div className="dt-disclosure-body">{advanced.map(field)}</div>
      </DisclosureRow>}
    </Fields>
    <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined}
      onDiscard={draft.discard} />
  </form>
}

export function SourceSettings({ focus }: { focus?: string }) {
  const { sources } = useSettings().settings
  useEffect(() => { if (focus) document.getElementById(`dt-source-${focus}`)?.scrollIntoView?.({ block: 'start' }) }, [focus])
  return <div className="dt-form">
    {/* VsSaros addition: P4 is not a Source here; its settings live in the Execution group (see `ExecutionSettings`). */}
    {sources.filter(source => source.id !== 'p4').map(source => <SourceCard key={source.id} source={source} />)}
    <ConfigHistory blocks={['source:']} except={['source:p4']} />
  </div>
}

function DroppedReplies({ items }: { items: DroppedReply[] }) {
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  // Link to the message's Ticket, or fall back to its Thread for messages queued before receipts recorded `ticketId`.
  const target = (item: DroppedReply): { route: Route; name: string } | undefined => item.ticket
    ? { route: { page: 'execution', id: item.ticket.id }, name: item.ticket.title }
    : item.thread ? { route: { page: 'trigger', id: item.thread }, name: t('term.thread') } : undefined
  return <DisclosureRow icon={<Icon name="dismiss" />} title={<>{t('sourceDroppedTitle')} <span
    className="dt-count">{items.length}</span></>} open={open}
    onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('sourceDroppedHint')}</Hint>
      <ul className="dt-list">{items.map(item => {
        const link = target(item)
        return <li key={item.id} className="dt-row"><Dot state="idle" /><div className="dt-row-main">
          <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
          <div className="dt-row-meta">
            <Tag tone="neutral">{reasonLabel(t, item.dropped.reason)}</Tag><When at={item.dropped.at} />
            {link && <button type="button" className="dt-textlink" onClick={() => navigate(link.route)}>{link.name}</button>}
          </div>
        </div></li>
      })}</ul>
    </div>
  </DisclosureRow>
}
/**
 * VsSaros fix (2026-11-06): replies whose send's result is not known. SuperAgent never sends them again by itself; a person
 * checks the conversation and redelivers one when it did not arrive.
 */
function UncertainReplies({ items }: { items: SourceStatusRow['uncertain'] }) {
  const { t, call, navigate } = usePanel()
  const [open, setOpen] = useState(true)
  const [done, setDone] = useState<string[]>([])
  // The Sources poll brings the list again; until then a redelivered one is hidden here.
  const redeliver = useAction(async (id: string) => { await call('POST replies/:id/redeliver', { id }); setDone(ids => [...ids, id]) })
  items = items.filter(item => !done.includes(item.id))
  if (!items.length) return null
  return <DisclosureRow icon={<Icon name="alert" />} title={<>{t('sourceUncertainTitle')} <span
    className="dt-count">{items.length}</span></>} open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body" data-testid="uncertain-replies">
      <Hint>{t('sourceUncertainHint')}</Hint>
      <ul className="dt-list">{items.map(item => <li key={item.id} className="dt-row"><Dot state="warning" /><div className="dt-row-main">
        <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
        <div className="dt-row-meta">
          <span className="dt-mono dt-clamp">{item.unknown.reason}</span>{item.unknown.at && <When at={item.unknown.at} />}
          {item.ticket && <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'execution', id: item.ticket!.id })}>{item.ticket.title}</button>}
          <button type="button" className="dt-textlink" disabled={redeliver.busy} onClick={() => { void redeliver.run(item.id) }}>{t('sourceRedeliver')}</button>
        </div>
      </div></li>)}</ul>
    </div>
  </DisclosureRow>
}
function SourceRow({ source }: { source: SourceStatusRow }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const [filteredOpen, setFilteredOpen] = useState(false)
  const { problem, dropped, uncertain } = source
  const { dot, label: state } = sourceMark(t, source.state)
  const { received, filtered, lastAt } = source.stats
  // Omit healthy parts and suppress per-part notes when a setup problem already explains why the Source is stopped.
  const notes = source.enabled && !problem && !setup?.problem ? source.health.filter(item => item.state === 'error'
    || item.state === 'paused') : []
  return <li className="dt-row">
    <Dot state={dot} label={state} />
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-row-name">{localized(t, source.title)}</span><span className="dt-status-text"
        data-state={dot}>{state}</span></div>
      <div className="dt-row-meta">
        {received > 0 && <LabelValue label={t('sourceReceivedLabel')}
          value={received} />}{filtered > 0 && <LabelValue label={t('sourceFilteredLabel')} value={filtered} />}
        {lastAt && <LabelValue label={t('sourceLatestLabel')} value={when(lastAt, t('lang'))} />}
      </div>
      {problem && <p className="dt-error">
        <SetupMessage problem={problem} lead /> <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute('source', { source: source.id }))}>
          {t('sourceOpenSettings')}
        </button>
      </p>}
      {notes.map(item => <p key={item.name} className={item.state === 'error' ? 'dt-error dt-clamp' : 'dt-hint dt-clamp'}>
        {valueLabel(t, 'health', item.name)}{t('labelSeparator')}<span className={item.code ? undefined : 'dt-mono'}>{healthText(t,
          item)}</span>
      </p>)}
      {source.filtered.length > 0 && <DisclosureRow icon={<Icon name="filter" />} title={t('sourceFilteredTitle')} open={filteredOpen}
        onToggle={() => setFilteredOpen(!filteredOpen)}>
        <div className="dt-disclosure-body">
          <ul className="dt-list">{source.filtered.map(item => <li key={item.id} className="dt-row"><Dot state="idle" /><div
            className="dt-row-main">
            <div className="dt-row-title">{actorName(t, item.actor)}{t('labelSeparator')}{readableMarkers(t, item.preview)
              || t('empty')}</div>
            <div className="dt-row-meta"><Tag tone="neutral">{reasonLabel(t, item.reason)}</Tag><When at={item.at} /></div>
          </div></li>)}</ul>
        </div>
      </DisclosureRow>}
      {uncertain.length > 0 && <UncertainReplies items={uncertain} />}
      {dropped.length > 0 && <DroppedReplies items={dropped} />}
    </div>
  </li>
}

export function SourceStatus() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error } = usePoll(() => call('GET sources'), [])
  // Global deployment setup problems halt all Sources and show at the top; Source-specific setup problems show on that Source's row.
  const elsewhere = setup?.problem?.place === 'deployment' ? setup.problem : undefined
  return <div className="dt-form">
    <StatusHead hint={t('sourceStatusIntro')} settings="source" />
    {elsewhere && <p className="dt-error">
      <SetupMessage problem={elsewhere} lead /> <button type="button" className="dt-textlink"
        onClick={() => navigate(setupPage(elsewhere.place))}>{t('setupFixLink')}</button>
    </p>}
    <LoadState error={error} loading={!data} />
    {/* VsSaros addition: P4 stays off this page; its state shows on the Execution page and in its settings. */}
    {data && <ul className="dt-list">{data.filter(source => source.id !== 'p4').map(source =>
      <SourceRow key={source.id} source={source} />)}</ul>}
  </div>
}
