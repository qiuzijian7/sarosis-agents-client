/**
 * VsSaros addition (2026-11-11): inline "add a new Feishu app" form on the Feishu Source card.
 *
 * Same closed loop as the Bots' Channel binding dropdown: the secret goes straight to
 * POST /x/agents/api/bindings (`action: 'feishu-app'`), which writes it to
 * `<dataRoot>/agent-im-accounts.json` (0600) and returns a masked app list. It never enters the
 * Source draft, the settings store, a URL or a log — only this component's state until the POST resolves.
 */
import { useState, type KeyboardEvent } from 'react'
import type { Localized } from '../sources/kind.ts'
import { Button, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { errorText, localized } from './text.ts'

const L = {
  title: { zh: '添加飞书应用', en: 'Add a Feishu app' },
  appId: { zh: '新应用 App ID', en: 'New app ID' },
  secret: { zh: 'App Secret（只写不读）', en: 'App secret (write only)' },
  name: { zh: '名称（可选）', en: 'Name (optional)' },
  save: { zh: '保存应用并选用', en: 'Save app and select' },
  saving: { zh: '保存中…', en: 'Saving…' },
  cancel: { zh: '取消', en: 'Cancel' },
  invalid: { zh: '请填合法 App ID（cli_…）与 App Secret', en: 'Enter a valid app ID (cli_…) and app secret' },
  secretHint: { zh: '密钥只提交给本机 Host 保存，不写入 SuperAgent 设置、不回显。', en: 'The secret is sent only to the local Host; it is never stored in SuperAgent settings or shown back.' },
} satisfies Record<string, Localized>

/** Enter in these inputs must not submit the Source card's form, which would save the Source draft instead. */
const keepEnter = (event: KeyboardEvent) => { if (event.key === 'Enter') event.preventDefault() }

export function FeishuAppForm({ onSaved, onCancel }: { onSaved: (appId: string) => void; onCancel: () => void }) {
  const { t } = usePanel()
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    const id = appId.trim(), value = secret.trim()
    if (!/^cli_[A-Za-z0-9]{4,64}$/.test(id) || !value) { setError(localized(t, L.invalid)); return }
    setBusy(true); setError('')
    try {
      const response = await fetch('/x/agents/api/bindings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ actor: { kind: 'human' }, action: 'feishu-app', appId: id, appSecret: value, name: name.trim() }),
      })
      const data = await response.json().catch(() => undefined) as { error?: string } | undefined
      if (!response.ok || data?.error) throw new Error(data?.error || `HTTP ${response.status}`)
      setSecret('')
      onSaved(id)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <div className="dt-field" data-feishu-app-form="">
    <span className="dt-field-head">{localized(t, L.title)}</span>
    <Field label={localized(t, L.appId)}>
      <Input value={appId} placeholder="cli_…" spellCheck={false} data-feishu-app-id="" onKeyDown={keepEnter}
        onChange={event => setAppId(event.target.value)} />
    </Field>
    <Field label={localized(t, L.secret)} hint={localized(t, L.secretHint)}>
      <Input type="password" value={secret} autoComplete="off" data-feishu-app-secret="" onKeyDown={keepEnter}
        onChange={event => setSecret(event.target.value)} />
    </Field>
    <Field label={localized(t, L.name)}>
      <Input value={name} data-feishu-app-name="" onKeyDown={keepEnter} onChange={event => setName(event.target.value)} />
    </Field>
    <div className="dt-row-buttons">
      <Button variant="primary" disabled={busy} data-feishu-app-save="" onClick={() => void save()}>
        {localized(t, busy ? L.saving : L.save)}
      </Button>
      <Button disabled={busy} data-feishu-app-cancel="" onClick={onCancel}>{localized(t, L.cancel)}</Button>
      {error && <p className="dt-error" role="alert">{error}</p>}
    </div>
  </div>
}
