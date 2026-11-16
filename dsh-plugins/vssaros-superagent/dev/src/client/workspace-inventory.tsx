/** Manual workspace inventory and cleanup preview; no polling and no mutation action. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { Button } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, Section } from './widgets.tsx'

export function WorkspaceInventoryPanel() {
  const { t, call } = usePanel()
  const [data, setData] = useState<ApiResponse<'GET executor/workspaces'>>()
  const query = useAction(async (offset: number = 0) => {
    const next = await call('GET executor/workspaces', { query: { offset, limit: 10 } })
    setData(current => offset && current ? { ...next, items: [...current.items, ...next.items] } : next)
  })
  return <Section title={t('workspaceInventoryTitle')} hint={t('workspaceInventoryHint')}>
    <Button variant="outline" disabled={query.busy} aria-busy={query.busy} onClick={() => { void query.run(0) }}>
      {t('workspaceInventoryCheck')}
    </Button>
    {data && <>
      <Hint>{t('workspaceInventoryChecked', { at: data.checkedAt, days: data.retentionDays, count: data.total })}</Hint>
      {!data.items.length && <Hint>{t('workspaceInventoryEmpty')}</Hint>}
      <ul className="dt-rows">{data.items.map(item => <li key={item.ticketId} className="dt-rows-item">
        <strong>{item.title}</strong>
        <span className="dt-mono">{item.directory}</span>
        <Hint>{item.checkedAt}</Hint>
        <Hint>{t('workspaceInventoryState', { state: t(`workspacePreparation.${item.preparation}`),
          exists: t(item.exists === null ? 'workspaceUnknown' : item.exists ? 'workspaceExists' : 'workspaceMissing'),
          bytes: item.bytes === null ? t('workspaceUnknown') : `${item.bytes.toLocaleString()} B` })}</Hint>
        <Hint>{item.blockers.length ? item.blockers.map(reason => t(`workspaceBlocker.${reason}`)).join(t('listSeparator'))
          : t('workspaceManualReview')}</Hint>
      </li>)}</ul>
      {data.nextOffset !== null && <Button variant="outline" disabled={query.busy} onClick={() => { void query.run(data.nextOffset!) }}>
        {t('workspaceInventoryMore')}
      </Button>}
    </>}
  </Section>
}
