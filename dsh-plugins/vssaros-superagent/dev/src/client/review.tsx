/**
 * VsSaros addition: the review of a ticket's shelved changelist, the only way to submit to P4. A person opens every file's
 * difference, confirms, and approves the fingerprint of what they read; or sends the CL back with a comment, or discards it.
 */
import { useId, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { ApiError, usePoll } from './api.ts'
import { Button, DisclosureRow, Icon, Modal, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { when } from './text.ts'
import { ConfirmButton, Hint, KeyValues, Section } from './widgets.tsx'

type ReviewView = Extract<ApiResponse<'GET tickets/:id/review'>, { review: object }>
type Review = ReviewView['review']
type FileDiff = ReviewView['diffs'][number]

function DiffLines({ diff }: { diff: FileDiff }) {
  const { t } = usePanel()
  if (!diff.lines.length) return <Hint>{t('review.binary')}</Hint>
  const tone = (line: string) => line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'
  return <>
    <pre className="dt-diff">{diff.lines.map((line, index) => <span key={index} className={`dt-diff-${tone(line)}`}>{line || ' '}{'\n'}</span>)}</pre>
    {diff.truncated && <Hint>{t('review.truncated')}</Hint>}
  </>
}

/** A finished review's one line, or the error of a failed submit on a waiting one. */
function Outcome({ review }: { review: Review }) {
  const { t } = usePanel()
  const by = review.by ?? ''
  switch (review.state) {
    case 'handed': return <Hint>{t('review.state.handed', { by })}</Hint>
    case 'submitted': return <Hint>{t('review.state.submitted', { by, submitted: String(review.submittedAs ?? '') })}</Hint>
    case 'rejected': return <Hint>{t('review.state.rejected', { by, comment: review.comment ?? '' })}</Hint>
    case 'discarded': return <Hint>{t('review.state.discarded', { by })}</Hint>
    case 'submitting': return <Hint>{t('review.state.submitting')}</Hint>
    default: return null
  }
}

/** The review section of a ticket's page; renders nothing for a ticket without a changelist review. */
export function ReviewSection({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const { t, call } = usePanel()
  const { data, reload } = usePoll(() => call('GET tickets/:id/review', { id }), [id], 10_000)
  if (!data || data.review === null) return null
  const { review } = data
  const title = t('review.section', { change: String(review.change) })
  if (review.state !== 'waiting') return <Section title={title} icon="review"><Outcome review={review} /></Section>
  // A new shelf (a new fingerprint) is a new review: the files opened for the last one count for nothing.
  return <WaitingReview key={review.fingerprint} id={id} view={data} title={title} after={async () => { await reload(); await onChanged() }} />
}

function WaitingReview({ id, view, title, after }: { id: string; view: ReviewView; title: string; after: () => Promise<void> }) {
  const { t, call } = usePanel()
  const { review, diffs, submit } = view
  const [seen, setSeen] = useState<Record<string, true>>({})
  const [open, setOpen] = useState<string>()
  const [ack, setAck] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const [changed, setChanged] = useState<string[]>([])
  const ackId = useId()
  const approve = useAction(async () => {
    try { await call('POST tickets/:id/review/approve', { id, body: { fingerprint: review.fingerprint } }) }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) setChanged(failure.details.changed ?? [])
      setConfirming(false)
      throw failure
    }
    setConfirming(false)
  }, { reload: after })
  const reject = useAction(async () => {
    await call('POST tickets/:id/review/reject', { id, body: { comment: comment.trim() } })
    setRejecting(false); setComment('')
  }, { reload: after })
  const all = diffs.length > 0 && diffs.every(diff => seen[diff.depotFile])
  const toggle = (file: string) => { setOpen(open === file ? undefined : file); setSeen(current => ({ ...current, [file]: true })) }
  return <Section title={title} icon="review" badge={<Tag tone="info">{t('review.seen', { seen: String(Object.keys(seen).length), total: String(diffs.length) })}</Tag>}>
    {review.error && <p className="dt-banner dt-danger"><span className="dt-banner-label">{t('review.lastError', { error: review.error })}</span></p>}
    {changed.length > 0 && <div className="dt-banner dt-danger"><span className="dt-banner-label">{t('review.changed')}</span>
      <ul className="dt-plain-list dt-mono">{changed.map(file => <li key={file}>{file}</li>)}</ul></div>}
    <KeyValues rows={[[t('review.description'), <pre className="dt-review-desc">{review.description.trim()}</pre>],
      [t('review.workspace'), <span className="dt-mono">{review.client}</span>],
      [t('review.fingerprint'), <span className="dt-mono">{review.fingerprint}</span>]]} />
    <Hint>{t('review.filesHint')}</Hint>
    <div className="dt-review-files">{diffs.map(diff => <DisclosureRow key={diff.depotFile} open={open === diff.depotFile}
      onToggle={() => toggle(diff.depotFile)}
      icon={<Icon name={seen[diff.depotFile] ? 'decision' : 'hash'} />}
      title={<span className="dt-mono">{diff.depotFile}#{diff.rev} <span className="dt-hint">({diff.type})</span></span>}>
      <div className="dt-disclosure-body"><DiffLines diff={diff} /></div>
    </DisclosureRow>)}</div>
    <div className="dt-review-ack">
      <input id={ackId} type="checkbox" checked={ack} disabled={!all} onChange={event => setAck(event.target.checked)} />
      <label htmlFor={ackId}>{t('review.ack')}</label>
    </div>
    <div className="dt-row-buttons">
      <Button variant="primary" size="sm" disabled={!all || !ack || approve.busy} onClick={() => setConfirming(true)}>{t('review.approve')}</Button>
      <Button variant="outline" size="sm" onClick={() => setRejecting(true)}>{t('review.reject')}</Button>
      <ConfirmButton variant="outline" label={t('review.discard')} title={t('review.discardTitle', { change: String(review.change) })}
        message={t('review.discardConfirm')} onConfirm={async () => { await call('POST tickets/:id/review/discard', { id }); await after() }} />
    </div>
    <Modal open={confirming} onClose={() => setConfirming(false)} closeLabel={t('close')}
      title={t('review.approveTitle', { change: String(review.change) })}
      description={submit.mode === 'pipeline' ? t('review.approvePipeline', { tags: submit.tags }) : t('review.approveHost')}
      footer={<>
        <Button variant="ghost" onClick={() => setConfirming(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={approve.busy} onClick={() => { void approve.run() }}>{t('confirm')}</Button>
      </>} />
    <Modal open={rejecting} onClose={() => setRejecting(false)} closeLabel={t('close')}
      title={t('review.rejectTitle', { change: String(review.change) })} description={t('review.rejectHint')}
      footer={<>
        <Button variant="ghost" onClick={() => setRejecting(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={!comment.trim() || reject.busy} onClick={() => { void reject.run() }}>{t('review.reject')}</Button>
      </>}>
      <textarea className="dt-textarea" rows={4} value={comment} placeholder={t('review.rejectPlaceholder')} aria-label={t('review.rejectTitle', { change: String(review.change) })}
        onChange={event => setComment(event.target.value)} />
    </Modal>
  </Section>
}

/** The reviews waiting for a person, for the Overview; renders nothing when none waits. */
export function PendingReviews() {
  const { t, call, navigate } = usePanel()
  const { data } = usePoll(() => call('GET reviews'), [], 10_000)
  if (!data?.waiting.length) return null
  return <Section title={t('review.pending')} count={data.waiting.length}>
    <ul className="dt-list dt-cards">{data.waiting.map(review => <li key={review.ticketId} className="dt-row dt-link">
      <div className="dt-row-main">
        <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'execution', id: review.ticketId })}>
          {review.description.split('\n')[0]?.trim() || `CL ${review.change}`}
        </button></div>
        <div className="dt-row-meta"><span>{t('review.waitingLine', { change: String(review.change), files: String(review.files.length),
          time: when(review.requestedAt, t('lang')) })}</span></div>
      </div>
      <div className="dt-row-actions"><Button variant="outline" size="sm" icon={<Icon name="review" size={14} />}
        onClick={() => navigate({ page: 'execution', id: review.ticketId })}>{t('review.open')}</Button></div>
    </li>)}</ul>
  </Section>
}
