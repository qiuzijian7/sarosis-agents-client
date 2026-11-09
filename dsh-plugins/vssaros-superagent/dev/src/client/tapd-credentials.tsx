/**
 * VsSaros addition: the TAPD setup checklist and Open API credentials on the TAPD Source card.
 *
 * The checklist is data-driven: the Host reports the credential source, saved watch count, resolved identity
 * and the live health code instead of the panel guessing from static hints. The secret itself is written by the
 * Host into its credentials file (`<DSH_HOME>/tapd.env`, or DSH_SUPERAGENT_TAPD_ENV_FILE), never into the
 * settings store; the panel only ever gets a masked account name. The product also ships a TAPD API account.
 */
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { TapdCredentialKind, TapdCredentialStatus, TapdSetupStatus } from '../sources/tapd-auth.ts'
import type { TapdTestResult, TapdWatch } from '../sources/tapd-api.ts'
import { Button, DisclosureRow, Icon, Input, SegmentedControl, Tag } from './controls.tsx'
import type { DshSuperagentKey } from './locales.ts'
import { useAction, usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { ConfirmButton, Hint, KeyValues } from './widgets.tsx'

const KINDS: TapdCredentialKind[] = ['client', 'user', 'token']
/** Enter in these inputs must not submit the Source card's form, which would save the Source draft instead. */
const keepEnter = (event: KeyboardEvent) => { if (event.key === 'Enter') event.preventDefault() }
/** Health codes the panel has a localized sentence for; anything else is shown verbatim. */
const HEALTH_MESSAGES = ['sourceOff', 'tapdUnset', 'tapdWebhookUnset'] as const

export interface TapdCredentialsProps {
  /** The card's draft config; the checklist itself reads the saved config and live health from the Host. */
  config: { watches: number; agent: string; workspace: string }
  /** Adds starter watches to the Source draft; the person still has to save the card. */
  onAddWatch: (watches: TapdWatch[]) => void
}

/** Two starter watches for the saved project: an empty workspace inherits the card's project ID. */
function recommendedWatches(agent: string): TapdWatch[] {
  const owner = agent.trim()
  return (['bug', 'story'] as const).map(type => ({ name: type === 'bug' ? 'bugs' : 'stories', workspace: '',
    type, item: '', status: '', owner, iteration: '', mode: owner ? 'assigned' : 'all' }))
}

export function TapdCredentials({ config, onAddWatch }: TapdCredentialsProps) {
  const { t, call, notify } = usePanel()
  const [status, setStatus] = useState<TapdCredentialStatus>()
  const [setup, setSetup] = useState<TapdSetupStatus>()
  const [test, setTest] = useState<TapdTestResult>()
  const [testing, setTesting] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  // The product ships an API account: selecting a kind and typing a secret is an override, not the normal path.
  const [customOpen, setCustomOpen] = useState(false)
  const [kind, setKind] = useState<TapdCredentialKind>('client')
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const refresh = async () => {
    const [credential, next] = await Promise.all([call('GET sources/tapd/credentials'), call('GET sources/tapd/setup')])
    setStatus(credential); setSetup(next)
    return credential
  }
  useEffect(() => {
    void refresh().then(credential => { if (credential.kind) setKind(credential.kind) }).catch(() => {})
  }, [])
  // "Blank keeps it" only applies to a pair the panel actually saved; the shipped account is never reused as a secret.
  const same = status?.kind === kind && !!status.saved
  const save = useAction(async () => {
    setStatus(await call('POST sources/tapd/credentials', { body: { kind, id: id.trim(), secret: secret.trim() } }))
    setSetup(await call('GET sources/tapd/setup'))
    setId(''); setSecret('')
    notify(t('tapdCred.saved'))
  })
  const clear = async () => {
    setStatus(await call('POST sources/tapd/credentials', { body: { clear: true } }))
    setSetup(await call('GET sources/tapd/setup'))
    notify(t('tapdCred.cleared'))
  }
  const switchBundled = async (bundled: 'on' | 'off') => {
    setStatus(await call('POST sources/tapd/credentials', { body: { bundled } }))
    setSetup(await call('GET sources/tapd/setup'))
    notify(t('tapdCred.bundledSwitched'))
  }
  const runTest = async () => {
    setTesting(true)
    try { setTest(await call('POST sources/tapd/test', { body: {} })) } finally { setTesting(false) }
  }
  const idLabel = kind === 'client' ? t('tapdCred.clientId') : t('tapdCred.user')
  const secretLabel = kind === 'client' ? t('tapdCred.clientSecret') : kind === 'user' ? t('tapdCred.password') : t('tapdCred.token')
  // A blank field keeps the saved value of the same kind, so a new kind needs both, and a token needs no account.
  const ready = (kind === 'token' || !!id.trim() || (same && !!status?.account)) && (!!secret.trim() || same)
    && (!!id.trim() || !!secret.trim())
  const sourceTag: ReactNode = !status ? t('empty')
    : status.source === 'environment' ? <Tag tone="success">{t('tapdCred.fromEnv')}</Tag>
      : status.source === 'file' ? <Tag tone="success">{t('tapdCred.fromFile')}</Tag>
        : status.source === 'bundled' ? <Tag tone="success">{t('tapdCred.fromBundled')}</Tag>
          : <Tag tone="danger">{t('tapdCred.none')}</Tag>
  const watchTag: ReactNode = !setup ? t('empty') : setup.watches > 0
    ? <Tag tone="success">{t('tapdCheck.watchesSome', { count: String(setup.watches) })}</Tag>
    : <Tag tone="danger">{t('tapdCheck.watchesNone')}</Tag>
  const identityTag: ReactNode = !setup ? t('empty') : !setup.agent
    ? <Tag tone="warning">{t('tapdCheck.identityEmpty')}</Tag>
    : setup.agentMapped ? <Tag tone="success">{t('tapdCheck.identityMapped', { name: setup.agentResolved })}</Tag>
      : <Tag tone="warning">{t('tapdCheck.identityUnmapped', { name: setup.agent })}</Tag>
  const healthLabel = (code: string | null | undefined): string => !code ? t('tapdCheck.healthUnknown')
    : HEALTH_MESSAGES.includes(code as typeof HEALTH_MESSAGES[number]) ? t(`healthCode.${code}` as DshSuperagentKey) : code
  const draft = config.watches
  return <div className="dt-field" data-tapd-credentials="">
    <span className="dt-field-head"><label>{t('tapdCheck.title')}</label></span>
    <KeyValues rows={[
      [t('tapdCheck.credentials'), sourceTag],
      [t('tapdCheck.watches'), <>{watchTag}{setup && draft !== setup.watches
        ? <span className="dt-mono"> · {t('tapdCheck.draftSaved', { count: String(draft) })}</span> : null}</>],
      [t('tapdCheck.identity'), identityTag],
      [t('tapdCheck.health'), <span className="dt-mono">{healthLabel(setup?.healthCode)}</span>],
      [t('tapdCheck.connectivity'), !test ? <Tag tone="neutral">{t('tapdCheck.notTested')}</Tag>
        : test.ok ? <Tag tone="success">{t('tapdCheck.testOk', { method: test.method ?? '' })}</Tag>
          : <Tag tone="danger">{t('tapdCheck.testFail', { error: test.error ?? '' })}</Tag>],
    ]} />
    <div className="dt-row-buttons">
      {setup && setup.watches === 0 && <Button variant="outline" size="sm" onClick={() => {
        onAddWatch(recommendedWatches(setup.agent)); notify(t('tapdCheck.watchesAdded'))
      }}>{t('tapdCheck.watchesAdd')}</Button>}
      <Button variant="outline" size="sm" disabled={testing} onClick={() => { void runTest() }}>
        {testing ? t('tapdCheck.testing') : t('tapdCheck.test')}</Button>
    </div>

    <span className="dt-field-head"><label>{t('tapdCred.title')}</label></span>
    <KeyValues rows={[
      [t('tapdCred.status'), sourceTag],
      ...status?.method ? [[t('tapdCred.method'), <span className="dt-mono">{status.source === 'bundled'
        ? `${t('tapdCred.methodBundled')}${status.account ? ` · ${status.account}` : ''}` : status.method}</span>]] as [string, ReactNode][] : [],
      ...status?.account ? [[t('tapdCred.account'), <span className="dt-mono">{status.account}</span>]] as [string, ReactNode][] : [],
      [t('tapdCred.writeTo'), <span className="dt-mono">{status?.file ?? t('empty')}</span>],
    ]} />
    {status?.overridden && <Hint>{t('tapdCred.overridden')}</Hint>}
    {status?.source === 'bundled' && <Hint>{t('tapdCred.bundledHint')}</Hint>}
    {status?.bundled && !status.saved && <Hint>{t('tapdCred.overrideHint')}</Hint>}
    <DisclosureRow icon={<Icon name="settings" />} title={t('tapdCred.custom')} open={customOpen}
      onToggle={() => setCustomOpen(!customOpen)}>
      <Hint>{t('tapdCred.customHint')}</Hint>
      <SegmentedControl className="dt-segmented dt-field-segmented" label={t('tapdCred.kind')} value={kind} onChange={setKind}
        options={KINDS.map(value => ({ value, label: t(`tapdCred.kind.${value}`) }))} />
      {kind !== 'token' && <Field label={idLabel}>
        <Input value={id} autoComplete="off" spellCheck={false} onKeyDown={keepEnter} onChange={event => setId(event.target.value)}
          placeholder={same && status?.account ? t('tapdCred.keep', { value: status.account }) : ''} />
      </Field>}
      <Field label={secretLabel}>
        <Input type="password" value={secret} autoComplete="new-password" onKeyDown={keepEnter} onChange={event => setSecret(event.target.value)}
          placeholder={same ? t('tapdCred.keepSecret') : ''} />
      </Field>
      <Hint>{t('tapdCred.hint')}</Hint>
      <DisclosureRow icon={<Icon name="settings" />} title={t('tapdCred.details')} open={detailsOpen}
        onToggle={() => setDetailsOpen(!detailsOpen)}>
        <Hint>{t('tapdCred.detailsHint')}</Hint>
      </DisclosureRow>
      <div className="dt-row-buttons">
        <Button variant="outline" size="sm" disabled={save.busy || !ready} onClick={() => { void save.run() }}>
          {save.busy ? t('tapdCred.saving') : t('tapdCred.save')}</Button>
      </div>
    </DisclosureRow>
    <div className="dt-row-buttons">
      {status?.saved && <ConfirmButton label={t('tapdCred.clear')} title={t('tapdCred.clearTitle')}
        message={t('tapdCred.clearConfirm', { file: status.file })} onConfirm={clear} />}
      {status?.bundled && <ConfirmButton label={t('tapdCred.bundledOff')} title={t('tapdCred.bundledOffTitle')}
        message={t('tapdCred.bundledOffConfirm')} onConfirm={() => switchBundled('off')} />}
      {status && !status.bundled && <Button variant="outline" size="sm" onClick={() => { void switchBundled('on') }}>
        {t('tapdCred.bundledOn')}</Button>}
    </div>
  </div>
}
