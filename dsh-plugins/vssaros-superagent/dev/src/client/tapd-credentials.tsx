/**
 * VsSaros addition: TAPD Open API credentials on the TAPD Source card.
 *
 * The secret is written by the Host into its credentials file (`<DSH_HOME>/tapd.env`, or the file
 * DSH_SUPERAGENT_TAPD_ENV_FILE names) — never into the settings store, which the panel reads back — and the panel
 * only ever gets a masked account name. The file is read on demand, so a saved credential works at once.
 */
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { TapdCredentialKind, TapdCredentialStatus } from '../sources/tapd-auth.ts'
import { Button, Input, SegmentedControl, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { ConfirmButton, Hint, KeyValues } from './widgets.tsx'

const KINDS: TapdCredentialKind[] = ['client', 'user', 'token']
/** Enter in these inputs must not submit the Source card's form, which would save the Source draft instead. */
const keepEnter = (event: KeyboardEvent) => { if (event.key === 'Enter') event.preventDefault() }

export function TapdCredentials() {
  const { t, call, notify } = usePanel()
  const [status, setStatus] = useState<TapdCredentialStatus>()
  const [kind, setKind] = useState<TapdCredentialKind>('client')
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const load = async () => {
    const next = await call('GET sources/tapd/credentials')
    setStatus(next)
    if (next.kind) setKind(next.kind)
  }
  useEffect(() => { void load().catch(() => {}) }, [])
  const same = status?.kind === kind
  const save = useAction(async () => {
    setStatus(await call('POST sources/tapd/credentials', { body: { kind, id: id.trim(), secret: secret.trim() } }))
    setId(''); setSecret('')
    notify(t('tapdCred.saved'))
  })
  const clear = async () => {
    setStatus(await call('POST sources/tapd/credentials', { body: { clear: true } }))
    notify(t('tapdCred.cleared'))
  }
  const idLabel = kind === 'client' ? t('tapdCred.clientId') : t('tapdCred.user')
  const secretLabel = kind === 'client' ? t('tapdCred.clientSecret') : kind === 'user' ? t('tapdCred.password') : t('tapdCred.token')
  // A blank field keeps the saved value of the same kind, so a new kind needs both, and a token needs no account.
  const ready = (kind === 'token' || !!id.trim() || (same && !!status?.account)) && (!!secret.trim() || same)
    && (!!id.trim() || !!secret.trim())
  const sourceTag: ReactNode = !status ? t('empty')
    : status.source === 'environment' ? <Tag tone="success">{t('tapdCred.fromEnv')}</Tag>
      : status.source === 'file' ? <Tag tone="success">{t('tapdCred.fromFile')}</Tag>
        : <Tag tone="danger">{t('tapdCred.none')}</Tag>
  return <div className="dt-field" data-tapd-credentials="">
    <span className="dt-field-head"><label>{t('tapdCred.title')}</label></span>
    <KeyValues rows={[
      [t('tapdCred.status'), sourceTag],
      ...status?.method ? [[t('tapdCred.method'), <span className="dt-mono">{status.method}</span>]] as [string, ReactNode][] : [],
      ...status?.account ? [[t('tapdCred.account'), <span className="dt-mono">{status.account}</span>]] as [string, ReactNode][] : [],
      [t('tapdCred.file'), <span className="dt-mono">{status?.file ?? t('empty')}</span>],
    ]} />
    {status?.overridden && <Hint>{t('tapdCred.overridden')}</Hint>}
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
    <div className="dt-row-buttons">
      <Button variant="outline" size="sm" disabled={save.busy || !ready} onClick={() => { void save.run() }}>
        {save.busy ? t('tapdCred.saving') : t('tapdCred.save')}</Button>
      {status?.kind && <ConfirmButton label={t('tapdCred.clear')} title={t('tapdCred.clearTitle')}
        message={t('tapdCred.clearConfirm', { file: status.file })} onConfirm={clear} />}
    </div>
  </div>
}
