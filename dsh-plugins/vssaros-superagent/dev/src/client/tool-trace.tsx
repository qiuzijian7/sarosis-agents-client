/** On-demand metadata diagnostics; never displays tool arguments, output or HMAC keys. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { Button, Input } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { Hint, Section } from './widgets.tsx'

export function ToolTracePanel() {
  const { t, call } = usePanel()
  const [ticketId, setTicketId] = useState('')
  const [data, setData] = useState<ApiResponse<'GET tools/trace'>>()
  const query = useAction(async (beforeId?: number) => {
    setData(await call('GET tools/trace', { query: { ...(ticketId.trim() ? { ticketId: ticketId.trim() } : {}),
      ...(beforeId ? { beforeId } : {}), limit: 50 } }))
  })
  return <Section title={t('toolTraceTitle')} hint={t('toolTraceHint')}>
    <Field label={t('toolTraceTicket')}><Input value={ticketId} onChange={event => { setTicketId(event.target.value); setData(undefined) }} /></Field>
    <Button variant="outline" disabled={query.busy} onClick={() => { void query.run() }}>{t('toolTraceRefresh')}</Button>
    {data && <>
      <Hint>{t(data.enabled ? 'toolTraceOn' : 'toolTraceOff')}</Hint>
      <Hint>{t('toolTraceSummary', data.summary)}</Hint>
      <ul className="dt-rows">{data.items.map(item => <li key={item.id} className="dt-rows-item">
        <strong>{item.name} · {item.role}</strong>
        <Hint>{item.at} · {item.session}{item.step ? ` / ${item.step}` : ''}</Hint>
        <Hint>{item.callId}{item.parentCallId ? ` ← ${item.parentCallId}` : ''}</Hint>
        <Hint>{t('toolTraceMetrics', { duration: item.durationMs ?? '—', input: item.inputBytes ?? '—', output: item.outputBytes ?? '—',
          state: t(item.cancelled ? 'toolTraceCancelled' : item.isError ? 'toolTraceError' : 'toolTraceSuccess') })}</Hint>
      </li>)}</ul>
      {data.nextCursor !== null && <Button variant="outline" disabled={query.busy} onClick={() => { void query.run(data.nextCursor!) }}>
        {t('toolTraceOlder')}
      </Button>}
    </>}
  </Section>
}
