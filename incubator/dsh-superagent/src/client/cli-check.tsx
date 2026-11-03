/**
 * VsSaros addition: local `lark-cli` diagnostics on the Feishu Source card.
 *
 * `actions` sits to the right of the `cli` input and `details` below the field; both come from the
 * same state. Two read-only checks report the executable, version, bot identity, strict mode and
 * update status, and fill the `cli` field. The two maintenance actions change the machine's global
 * CLI, so each sits behind a `ConfirmButton` and sends `confirm: true` that the host route requires.
 */
import { useState, type ReactNode } from 'react'
import type { CliApplyAction, CliCheckResult } from '../app/cli-check.ts'
import { Button, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { ConfirmButton, Hint, KeyValues } from './widgets.tsx'

/** Returns the two fragments the `cli` field renders: buttons beside the input, results below it. */
export function useFeishuCliCheck(onDetect: (command: string) => void): { actions: ReactNode; details: ReactNode } {
  const { t, call, notify } = usePanel()
  const [result, setResult] = useState<CliCheckResult>()
  const inspect = useAction(async (update: boolean) => {
    const found = await call('POST sources/feishu/cli-check', { body: { update } })
    setResult(found)
    if (found.found) onDetect(found.command)
    else notify(t('cliCheck.notFound'))
  })
  const apply = async (action: CliApplyAction) => {
    await call('POST sources/feishu/cli-apply', { body: { action, confirm: true } })
    notify(t('cliCheck.applied'))
    await inspect.run(false)
  }
  const rows: [string, ReactNode][] | undefined = result && [
    [t('cliCheck.path'), result.found ? <span className="dt-mono">{result.resolved}</span> : <Tag tone="danger">{t('cliCheck.notFound')}</Tag>],
    [t('cliCheck.version'), result.version ?? t('empty')],
    [t('cliCheck.bot'), result.botReady ? <Tag tone="success">{result.appId ?? t('yes')}</Tag> : <Tag tone="danger">{t('no')}</Tag>],
    [t('cliCheck.strict'), result.strictMode === 'bot' ? <Tag tone="success">bot</Tag> : <Tag tone="warning">{result.strictMode ?? t('empty')}</Tag>],
    [t('cliCheck.botName'), result.botName ?? t('empty')],
    ...result.update ? [[t('cliCheck.latest'), `${result.update.currentVersion ?? t('empty')} → ${result.update.latestVersion ?? t('empty')} (${result.update.action ?? t('empty')})`]] as [string, ReactNode][] : [],
  ]
  const actions: ReactNode = <div className="dt-cli-actions">
    <Button variant="ghost" size="sm" disabled={inspect.busy} onClick={() => { void inspect.run(false) }}>{t('cliCheck.local')}</Button>
    <Button variant="ghost" size="sm" disabled={inspect.busy} onClick={() => { void inspect.run(true) }}>{t('cliCheck.update')}</Button>
  </div>
  const details: ReactNode = <>
    {rows && <KeyValues rows={rows} />}
    {result?.error && <Hint>{result.error}</Hint>}
    {result?.found && result.strictMode !== 'bot' && <div className="dt-row-buttons">
      <ConfirmButton variant="outline" label={t('cliCheck.applyStrict')} title={t('cliCheck.applyStrictTitle')}
        message={t('cliCheck.applyStrictConfirm')} onConfirm={() => apply('strict-bot')} />
    </div>}
    {result?.found && result.update && result.update.action !== 'already_up_to_date' && <div className="dt-row-buttons">
      <ConfirmButton variant="outline" label={t('cliCheck.runUpdate')} title={t('cliCheck.runUpdateTitle')}
        message={t('cliCheck.runUpdateConfirm')} onConfirm={() => apply('update')} />
    </div>}
  </>
  return { actions, details }
}
