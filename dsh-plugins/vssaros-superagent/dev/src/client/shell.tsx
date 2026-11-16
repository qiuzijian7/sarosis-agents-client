/**
 * ★ 2026-11-12（用户选定方案 C）：分栏工作区外壳。
 * 左侧竖导轨放 6 个页签；主区是「内容 + 常驻上下文」两列 —— 上下文列在主区内，不是可弹出的概况侧栏。
 */
import type { ReactNode } from 'react'
import { usePoll } from './api.ts'
import { Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Hint } from './widgets.tsx'

/** The vertical rail of the workbench: the brand, the tabs a caller renders, and a one-line hint. */
export function Rail({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return <nav className="dt-rail" aria-label={title}>
    <div className="dt-rail-brand"><Icon name="session" size={17} /><span>{title}</span></div>
    {children}
    <p className="dt-rail-hint">{hint}</p>
  </nav>
}

/** The always-on column beside the page: how much waits for a person, the Executor, and today's flow. */
export function ContextColumn() {
  const { t, call } = usePanel()
  const { data } = usePoll(() => call('GET overview'), [], 15_000)
  return <aside className="dt-context" aria-label={t('contextTitle')}>
    <h2 className="dt-context-title">{t('contextTitle')}</h2>
    {!data ? <Hint>{t('loading')}</Hint> : <>
      <div className="dt-context-stats">
        <span><b>{data.person.length}</b>{t('pendingTickets')}</span>
        <span><b>{`${data.executor.running} / ${data.executor.maxWorkers}`}</b>{t('executingLabel')}</span>
        <span><b>{data.executor.queued}</b>{t('queuedLabel')}</span>
        <span><b>{data.flow.received}</b>{t('flowReceivedLabel')}</span>
      </div>
      {data.problems.length > 0 && <p className="dt-context-problem">
        <Icon name="alert" size={14} /><span>{t('problems')} · {data.problems.length}</span>
      </p>}
    </>}
  </aside>
}
