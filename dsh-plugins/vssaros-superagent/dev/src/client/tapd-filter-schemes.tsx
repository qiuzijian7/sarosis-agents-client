/** TAPD scheme A: scoped source cards, condition editor and result pool inside the Source draft. */
import { useEffect, useRef, useState } from 'react'
import { Button, Icon, Input, SegmentedControl, Switch, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import type { TapdIdentityView } from '../sources/tapd-identity.ts'
import { conditionRange, filterDateTime, FILTER_SCHEME_SOURCES, mergeIntoPool, normaliseOp, STORY_DUE_DEFAULT, TapdFilterPoolSchema, ticketUrl,
  type FilterCondition, type PoolState, type TapdFilterPool, type TapdFilterScheme } from '../sources/tapd-filter-schemes.ts'

export interface TapdFilterSchemesProps {
  schemes: TapdFilterScheme[]
  pool?: Partial<TapdFilterPool>
  site: string
  workspace: string
  onChange: (next: { schemes: TapdFilterScheme[]; pool: TapdFilterPool }) => void
}
const TONES: Record<PoolState, 'quiet' | 'info' | 'warning' | 'success' | 'danger'> = {
  pending: 'quiet', queued: 'info', processing: 'warning', done: 'success', failed: 'danger' }
const DEFAULT_POOL = TapdFilterPoolSchema.parse({})
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function TapdFilterSchemes({ schemes, pool, site, workspace, onChange }: TapdFilterSchemesProps) {
  const { t, call, notify } = usePanel()
  const en = t('lang') === 'en'
  const say = (zh: string, english: string) => en ? english : zh
  const current = { ...DEFAULT_POOL, ...pool }
  const [tab, setTab] = useState<'story' | 'bug'>('bug')
  const [filter, setFilter] = useState<'all' | 'story' | 'bug' | 'enabled'>('all')
  const [search, setSearch] = useState('')
  const [identity, setIdentity] = useState<TapdIdentityView>({ signedIn: false, loginName: '', staffId: '', workspace,
    status: 'unavailable', tapdName: '', source: 'none', cached: false, message: '正在解析当前身份…' })
  const [identityLoading, setIdentityLoading] = useState(true)
  const [confirmName, setConfirmName] = useState('')
  const [identityError, setIdentityError] = useState('')
  const identitySequence = useRef(0)
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [runtimeItems, setRuntimeItems] = useState<TapdFilterPool['items']>([])
  const snapshot = useRef(schemes)
  const latest = useRef({ schemes, current })
  latest.current = { schemes, current }
  const scheme = schemes.find(row => row.kind === tab)
  const items = current.items.map(item => {
    const state = runtimeItems.find(row => row.id === item.id && row.kind === item.kind)
    return state ? { ...item, state: state.state, runId: state.runId, lastRunAt: state.lastRunAt, attempts: state.attempts,
      detail: state.detail, phase: state.phase, ticketId: state.ticketId, retryable: state.retryable } : item
  })
  const edit = (next: TapdFilterPool) => onChange({ schemes, pool: next })
  const statuses: Record<PoolState, string> = { pending: say('待处理', 'Pending'), queued: say('已接收', 'Received'),
    processing: say('修复中', 'Working'), done: say('已交付', 'Delivered'), failed: say('失败·待重试', 'Failed') }
  const timeValid = TIME.test(current.at)
  const eligible = items.filter(item => item.enabled && (item.state === 'pending' || item.state === 'failed' && item.retryable !== false))
  const shown = items.filter(item => (filter === 'all' || (filter === 'enabled' ? item.enabled : item.kind === filter)) &&
    `${item.id} ${item.title}`.toLowerCase().includes(search.toLowerCase()))
  const busyError = (failure: unknown) => { const message = failure instanceof Error ? failure.message : String(failure); setError(message); throw failure }

  useEffect(() => {
    const sequence = ++identitySequence.current
    setIdentityLoading(true); setConfirmName(''); setIdentityError('')
    void call('GET sources/tapd/identity').then(data => {
      if (sequence === identitySequence.current) setIdentity(data)
    }).catch(() => {
      if (sequence === identitySequence.current) setIdentity({ signedIn: false, loginName: '', staffId: '', workspace,
        status: 'unavailable', tapdName: '', source: 'none', cached: false, message: '身份服务不可用，请重试' })
    }).finally(() => { if (sequence === identitySequence.current) setIdentityLoading(false) })
    return () => { identitySequence.current++ }
  }, [call, workspace])
  const refreshIdentity = useAction(async () => {
    const sequence = ++identitySequence.current
    setIdentityLoading(true); setIdentityError(''); setConfirmName('')
    try {
      const data = await call('GET sources/tapd/identity', { query: { fresh: 'true' } })
      if (sequence === identitySequence.current) setIdentity(data)
    } catch {
      if (sequence === identitySequence.current) {
        setIdentity(previous => ({ ...previous, signedIn: false, status: 'unavailable', tapdName: '', source: 'none', cached: false,
          message: say('身份读取失败，请重试', 'Identity read failed; retry') }))
        setIdentityError(say('重新读取身份失败，请检查服务后重试', 'Identity refresh failed; please retry'))
      }
    }
    finally { if (sequence === identitySequence.current) setIdentityLoading(false) }
  })
  const confirmIdentity = useAction(async () => {
    setIdentityError('')
    try {
      const data = await call('POST sources/tapd/identity/confirm', { body: {
        loginName: identity.loginName, workspace, name: confirmName.trim() } })
      setIdentity(data); setConfirmName('')
      notify(say('身份已确认并记住，请同步方案以刷新候选池', 'Identity confirmed; sync to refresh the pool'))
    } catch (failure) { setIdentityError(failure instanceof Error ? failure.message : String(failure)) }
  })
  useEffect(() => {
    let stopped = false
    const read = async () => {
      try {
        const data = await call('GET sources/tapd/filter-schemes/pool')
        if (!stopped) setRuntimeItems(data.items)
      } catch { /* The panel can still edit a draft while the Host restarts. */ }
    }
    void read()
    const timer = setInterval(() => { void read() }, 5000)
    return () => { stopped = true; clearInterval(timer) }
  }, [call])

  const sync = useAction(async (scope: 'all' | 'story' | 'bug' = 'all') => {
    setError('')
    try {
      const response = await call('POST sources/tapd/filter-schemes/sync', { body: {
        scope, loginName: identity.signedIn ? identity.loginName : undefined,
        schemes: latest.current.schemes, pool: latest.current.current } })
      const next = latest.current.schemes.filter(row => !response.schemes.some(fresh => fresh.kind === row.kind)).concat(response.schemes)
      snapshot.current = next
      if (response.ownerIdentity) { identitySequence.current++; setIdentity(response.ownerIdentity); setIdentityLoading(false) }
      const before = latest.current.current.items.length
      const merged = mergeIntoPool(latest.current.current, response.pool.items)
      onChange({ schemes: next, pool: { ...merged, owner: response.pool.owner } })
      setPreview((response.results ?? []).map(result => result.error
        ? say(`${result.kind === 'story' ? '需求' : '缺陷'}入池失败：${result.error}`, `${result.kind} import failed: ${result.error}`)
        : say(`${result.kind === 'story' ? '需求' : '缺陷'}命中 ${result.total} 条`, `${result.kind}: ${result.total} matches`)).join(' · '))
      if (response.warnings?.length) setError(response.warnings.join('；'))
      notify(response.warnings?.length || response.schemes.some(row => row.source !== 'live')
        ? say(`同步完成，新增 ${merged.items.length - before} 条；部分来源需处理，请查看提示`, `Sync finished; ${merged.items.length - before} added. Check warnings.`)
        : say(`同步并自动入池完成，新增 ${merged.items.length - before} 条（默认停用）`, `Sync and import complete; ${merged.items.length - before} added, disabled by default`))
    } catch (failure) { busyError(failure) }
  })
  const add = useAction(async () => {
    if (!scheme) return
    setError('')
    try {
      const result = await call('POST sources/tapd/filter-schemes/preview', { body: { kind: tab, scheme,
        maxPerRun: current.maxPerRun } })
      const before = latest.current.current.items.length
      const next = mergeIntoPool(latest.current.current, result.items)
      edit(next)
      setPreview(say(`命中 ${result.total} 条 · 近期 ${result.recent} 条`, `${result.total} matches · ${result.recent} recent`))
      notify(say(`新增 ${next.items.length - before} 条，默认停用`, `${next.items.length - before} added, disabled by default`))
    } catch (failure) { busyError(failure) }
  })
  const run = useAction(async () => {
    setError('')
    try {
      const result = await call('POST sources/tapd/filter-schemes/run', { body: { pool: { ...current, items } } })
      setRuntimeItems(result.pool.items)
      edit(result.pool)
      notify(say(`已真实接收 ${result.dispatched} 条修复任务，不代表修复完成`, `${result.dispatched} repair tasks received, not completed`))
      if (result.error) setError(result.error)
    } catch (failure) { busyError(failure) }
  })
  const updateCondition = (index: number, change: Partial<FilterCondition>) => {
    if (!scheme || scheme.conditions[index]?.locked) return
    onChange({ pool: current, schemes: schemes.map(row => row.kind === tab ? { ...row,
      conditions: row.conditions.map((condition, i) => i === index ? { ...condition, ...change } : condition) } : row) })
  }
  const batch = (enabled: boolean) => {
    const ids = new Set(shown.map(item => `${item.kind}:${item.id}`))
    edit({ ...current, items: current.items.map(item => ids.has(`${item.kind}:${item.id}`) ? { ...item, enabled } : item) })
  }

  return <div className="dt-tapd" data-tapd-schemes>
    <section className="dt-tapd-section">
      <header className="dt-tapd-head">
        <div className="dt-tapd-heading"><Icon name="refresh" /><h3>{say('过滤方案自动抓取', 'Filter scheme sync')}</h3><Tag tone="info">{say('需求 + 缺陷', 'Story + Bug')}</Tag></div>
        <Button variant="outline" size="sm" disabled={sync.busy} onClick={() => { void sync.run('all') }} icon={<Icon name="refresh" />}>{sync.busy ? say('同步并入池中…', 'Syncing and importing…') : say('立即同步全部', 'Sync all')}</Button>
      </header>
      <div className="dt-tapd-sources">{FILTER_SCHEME_SOURCES.map(source => {
        const saved = schemes.find(row => row.kind === source.kind)
        return <article className="dt-tapd-source" key={source.kind}>
          <div className="dt-tapd-source-title"><strong>{source.kind === 'story' ? say('需求 / Story', 'Story') : say('缺陷 / Bug', 'Bug')}</strong>
            <Tag tone={saved?.source === 'live' ? 'success' : 'quiet'}>{saved?.source === 'live' ? say('已同步', 'Synced') : say('待同步 / 保留快照', 'Awaiting sync')}</Tag></div>
          <a className="dt-tapd-source-url" href={source.url} target="_blank" rel="noopener noreferrer">{source.url}<Icon name="external" size={12} /></a>
          <div className="dt-tapd-source-meta"><span>{say('条件', 'Conditions')} <b>{saved?.conditions.length ?? 0}</b></span>
            <span>{say('上次抓取', 'Captured')} <b>{saved?.capturedAt ? new Date(saved.capturedAt).toLocaleString(en ? 'en' : 'zh-CN', { hour12: false }) : '—'}</b></span></div>
          <div className="dt-tapd-source-foot"><code>{saved?.hash ? saved.hash.slice(0, 12) : '—'}</code><Button size="sm" variant="outline" disabled={sync.busy}
            onClick={() => { void sync.run(source.kind) }}>{say('立即同步', 'Sync')}</Button></div>
        </article>
      })}</div>
      <div className="dt-tapd-identity" data-tapd-identity aria-busy={identityLoading}>
        <Icon name="user" /><span>{say('当前用户', 'Current user')}</span><Tag tone="info">TOF</Tag>
        <strong>{identity.loginName || '—'}</strong><span>→</span><strong>{identity.tapdName || say('待解析', 'Unresolved')}</strong>
        <Tag tone={identity.status === 'resolved' ? 'success' : 'warning'}>{identityLoading ? say('解析中', 'Resolving')
          : identity.source === 'manual' ? say('手动映射', 'Manual override') : identity.source === 'automatic' ? say('自动匹配', 'Auto matched')
          : identity.source === 'confirmed' ? say('已确认 · 自动复用', 'Confirmed · reused') : say('待确认', 'Confirmation needed')}</Tag>
        <span className="dt-tapd-muted" role="status">{identity.message}</span>
        <Button size="sm" variant="outline" disabled={identityLoading || confirmIdentity.busy || sync.busy} onClick={() => { void refreshIdentity.run() }}>
          {say('重新读取身份', 'Refresh identity')}</Button>
        {!identityLoading && identity.signedIn && (identity.status === 'unmatched' || identity.status === 'ambiguous') &&
          <div className="dt-tapd-identity-confirm"><label>{say('TAPD 用户名', 'TAPD user name')}
            <Input aria-label={say('TAPD 用户名', 'TAPD user name')} value={confirmName} placeholder={say('填写 TAPD 中的准确姓名，仅需确认一次', 'Exact TAPD user name; confirm once')}
              onChange={event => setConfirmName(event.target.value)} /></label>
            <Button size="sm" variant="primary" disabled={!confirmName.trim() || confirmIdentity.busy || sync.busy} onClick={() => { void confirmIdentity.run() }}>
              {confirmIdentity.busy ? say('验证中…', 'Verifying…') : say('确认并记住', 'Confirm and remember')}</Button>
            <small>{say('只匹配当前项目成员；不启用或派发单据。已有手动映射优先。', 'Workspace members only; no task dispatch. Manual overrides take priority.')}</small></div>}
        {identityError && <p className="dt-tapd-identity-error" role="alert">{identityError}</p>}
      </div>
    </section>

    <section className="dt-tapd-section">
      <header className="dt-tapd-head"><div className="dt-tapd-heading"><Icon name="filter" /><h3>{say('TAPD 过滤方案', 'TAPD filter schemes')}</h3>
        {scheme && <Tag tone={scheme.source === 'live' ? 'success' : 'quiet'}>{scheme.name}</Tag>}</div>
        <Button size="sm" variant="ghost" onClick={() => setCollapsed(!collapsed)}>{collapsed ? say('展开', 'Expand') : say('收起', 'Collapse')}</Button></header>
      <div className="dt-tapd-scheme-tabs"><SegmentedControl label={say('选择过滤方案', 'Choose scheme')} value={tab} onChange={setTab}
        options={[{ value: 'story', label: say('需求方案', 'Story scheme') }, { value: 'bug', label: say('缺陷方案', 'Bug scheme') }]} /></div>
      {!collapsed && <><div className="dt-tapd-logic"><span className="dt-tapd-logic-badge">AND</span><span>{say('各行全部满足；标记 OR 的行至少满足一项。当前用户条件不可停用。', 'All rows match; OR rows match any branch. Owner is locked.')}</span></div>
        <div className="dt-tapd-scroll"><table className="dt-tapd-conditions"><thead><tr><th>{say('字段', 'Field')}</th><th>{say('运算符', 'Operator')}</th><th>{say('值', 'Values')}</th><th>{say('生效', 'Active')}</th></tr></thead><tbody>
          {scheme?.conditions.map((condition, index) => <tr key={`${scheme.kind}:${index}`} data-off={!condition.enabled || undefined} data-locked={condition.locked || undefined}>
            <td>{condition.group && <span className="dt-tapd-or">OR</span>}{condition.field}</td>
            <td><span className={`dt-tapd-op dt-tapd-op-${normaliseOp(condition.op)}`}>{condition.op}</span></td>
            <td>{condition.locked ? <><span className="dt-tapd-value dt-tapd-owner">{Array.isArray(condition.value) ? condition.value.join('、') || current.owner || '—' : '—'}</span><small>{say('自动·当前用户', 'Auto · current user')}</small></>
              : normaliseOp(condition.op) === 'range' || !Array.isArray(condition.value) ? <>
                <div className="dt-tapd-range"><Input type="datetime-local" step={1} aria-label={`${condition.field} from`} value={conditionRange(condition.value).from}
                  onChange={event => updateCondition(index, { value: { ...conditionRange(condition.value), from: filterDateTime(event.target.value) } })} /><span>~</span>
                  <Input type="datetime-local" step={1} aria-label={`${condition.field} to`} value={conditionRange(condition.value).to}
                    onChange={event => updateCondition(index, { value: { ...conditionRange(condition.value), to: filterDateTime(event.target.value) } })} /></div>
                <small className="dt-tapd-range-summary">{conditionRange(condition.value).from.replace('T', ' ') || say('未设置开始时间', 'Start not set')}
                  {' ~ '}{conditionRange(condition.value).to.replace('T', ' ') || say('未设置结束时间', 'End not set')}</small>
                {condition.field === '预计完成时间' && !conditionRange(condition.value).from && !conditionRange(condition.value).to &&
                  <Button size="sm" variant="ghost" onClick={() => updateCondition(index, { value: { ...STORY_DUE_DEFAULT } })}>{say('使用平台默认范围', 'Use platform default range')}</Button>}
              </> : <Input aria-label={say(`${condition.field}的值`, `${condition.field} values`)} key={JSON.stringify(condition.value)}
                defaultValue={condition.value.join('、')} placeholder={say('输入值，以、分隔', 'Comma-separated values')} onBlur={event => updateCondition(index, { value: event.target.value.split(/[、,，;；]/).map(value => value.trim()).filter(Boolean) })} />}</td>
            <td><div className="dt-tapd-enable"><Switch checked={condition.enabled} disabled={condition.locked} label={say(`${condition.field}生效`, `${condition.field} active`)}
              onChange={enabled => updateCondition(index, { enabled })} /><span>{condition.enabled ? say('生效', 'On') : say('忽略', 'Off')}</span></div></td>
          </tr>)}{!scheme && <tr><td colSpan={4} className="dt-tapd-empty">{say('尚未同步方案，请先同步平台网页', 'Sync the platform pages first')}</td></tr>}
        </tbody></table></div>
        <div className="dt-tapd-editor-foot"><Button size="sm" variant="outline" disabled={!snapshot.current.length} onClick={() => onChange({ pool: current, schemes: snapshot.current })}>
          {say('恢复同步快照', 'Restore snapshot')}</Button><span>{say('条件修改写入本卡草稿，底部保存后生效', 'Save this card to persist condition edits')}</span></div></>}
    </section>

    <section className="dt-tapd-section dt-tapd-pool">
      <header className="dt-tapd-head"><div className="dt-tapd-heading"><Icon name="inbox" /><h3>{say('筛选结果池', 'Filter result pool')}</h3><Tag tone="info">{items.length}</Tag></div>
        <div className="dt-tapd-enable"><Switch checked={current.autoProcess} label={say('自动处理', 'Auto processing')} onChange={autoProcess => edit({ ...current, autoProcess })} />
          <span>{say('自动处理', 'Auto processing')} · {current.autoProcess ? say('开', 'On') : say('关', 'Off')}</span></div></header>
      <div className="dt-tapd-kpis">{[
        [say('池中单子', 'Pool items'), items.length], [say('已启用', 'Enabled'), items.filter(item => item.enabled).length],
        [say('今日已交付', 'Delivered today'), items.filter(item => item.state === 'done' && item.lastRunAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length],
        [say('今日计划 / 上限', 'Plan / cap'), `${Math.min(eligible.length, current.maxPerRun)} / ${current.maxPerRun}`]
      ].map(([label, value], index) => <div className="dt-tapd-kpi" data-tone={index} key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="dt-tapd-toolbar"><label className="dt-tapd-time">{say('每日（凌晨）', 'Daily')}<Input type="time" aria-label={say('每日执行时间', 'Daily run time')} value={current.at} onChange={event => edit({ ...current, at: event.target.value })} /></label>
        <label className="dt-tapd-cap">{say('单次上限', 'Cap')}<Input type="number" aria-label={say('单次上限', 'Run cap')} min={1} max={200} value={current.maxPerRun} onChange={event => edit({ ...current, maxPerRun: Math.min(200, Math.max(1, Number(event.target.value) || 20)) })} /></label>
        <div className="dt-tapd-filters"><SegmentedControl label={say('结果池筛选', 'Pool filters')} value={filter} onChange={setFilter} options={[
          { value: 'all', label: say('全部', 'All') }, { value: 'story', label: say('需求', 'Story') }, { value: 'bug', label: say('缺陷', 'Bug') }, { value: 'enabled', label: say('仅启用', 'Enabled') }]} /></div></div>
      <div className="dt-tapd-actions"><Button size="sm" variant="outline" disabled={identityLoading || identity.status !== 'resolved' || identity.workspace !== workspace || sync.busy || add.busy || !scheme || !timeValid} icon={<Icon name="plus" />} onClick={() => { void add.run() }}>{say('试算并加入', 'Preview and add')}</Button>
        <Button size="sm" variant="primary" disabled={identityLoading || identity.status !== 'resolved' || identity.workspace !== workspace || sync.busy || run.busy || !eligible.length || !timeValid} icon={<Icon name="play" />} onClick={() => { void run.run() }}>{run.busy ? say('派发中…', 'Dispatching…') : say('开始执行', 'Start run')}</Button>
        <Button size="sm" variant="ghost" disabled={!shown.length} onClick={() => batch(true)}>{say('全部启用', 'Enable all')}</Button><Button size="sm" variant="ghost" disabled={!shown.length} onClick={() => batch(false)}>{say('全部停用', 'Disable all')}</Button>
        <Input className="dt-tapd-search" icon={<Icon name="search" size={14} />} aria-label={say('搜索单子', 'Search items')} placeholder={say('搜索标题或单号', 'Search title or ID')} value={search} onChange={event => setSearch(event.target.value)} /></div>
      {(!timeValid || error) && <p className="dt-tapd-error" role="alert">{!timeValid ? say('请选择有效执行时间（HH:MM）', 'Choose a valid HH:MM time') : error}</p>}
      <div className="dt-tapd-scroll"><table className="dt-tapd-pool-table"><thead><tr><th>{say('单号', 'ID')}</th><th>{say('类型', 'Type')}</th><th>{say('标题', 'Title')}</th><th>{say('优先级', 'Priority')}</th><th>{say('单据状态', 'Status')}</th><th>{say('来源方案', 'Scheme')}</th><th>{say('启用', 'Enabled')}</th><th>{say('处理状态', 'Repair state')}</th><th /></tr></thead><tbody>
        {shown.map(item => <tr key={`${item.kind}:${item.id}`} data-off={!item.enabled || undefined}><td><code title={item.id}>{item.id.slice(-8)}</code></td><td><Tag tone={item.kind === 'bug' ? 'warning' : 'info'}>{item.kind === 'bug' ? say('缺陷', 'Bug') : say('需求', 'Story')}</Tag></td>
          <td className="dt-tapd-title-cell"><a href={ticketUrl(site, workspace, item)} target="_blank" rel="noopener noreferrer" title={item.title}>{item.title || item.id}<Icon name="external" size={12} /></a><small>{item.hit || '—'}</small></td><td>{item.priority || '—'}</td><td>{item.status || '—'}</td><td><code>{item.scheme || '—'}</code></td>
          <td><div className="dt-tapd-enable"><Switch checked={item.enabled} label={`${say('启用', 'Enable')} ${item.title || item.id}`} onChange={enabled => edit({ ...current, items: current.items.map(row => row.id === item.id && row.kind === item.kind ? { ...row, enabled } : row) })} /></div></td>
          <td><Tag tone={item.phase === 'person' ? 'warning' : TONES[item.state]}>{item.phase === 'delivery' ? say('等待主管', 'Awaiting supervisor')
            : item.phase === 'evaluation' && item.state === 'queued' ? say('评估中', 'Evaluating')
            : item.phase === 'person' ? say('等待人工处理', 'Needs attention') : statuses[item.state]}</Tag>
            {item.detail && <small title={item.detail}>{item.detail}</small>}</td><td><Button size="sm" variant="ghost" aria-label={`${say('移出池子', 'Remove')} ${item.title || item.id}`} icon={<Icon name="trash" size={14} />} onClick={() => edit({ ...current, items: current.items.filter(row => row.id !== item.id || row.kind !== item.kind) })} /></td></tr>)}
        {!shown.length && <tr><td colSpan={9}><div className="dt-tapd-empty"><Icon name="inbox" size={28} /><strong>{items.length ? say('没有匹配的单子', 'No matches') : say('池中暂无单子', 'The pool is empty')}</strong><span>{say('同步方案后自动将符合条件的单子入池；新单默认停用，由你确认后启用。', 'Sync automatically imports matching items. New items need your approval.')}</span></div></td></tr>}
      </tbody></table></div>
      <footer className="dt-tapd-pool-foot"><span>{say(`显示 ${shown.length} / ${items.length} 条`, `${shown.length} / ${items.length} shown`)}{preview && ` · ${preview}`}</span><span>{current.autoProcess ? say(`保存后每日 ${current.at} 自动处理`, `Daily at ${current.at} after saving`) : say('自动处理关闭，仅手动执行', 'Automatic processing off')}</span></footer>
    </section>
    <p className="dt-tapd-note">{say('启用的待处理单子参与派发；P4 池任务交付 pending CL 后结束并继续下一条，不等待编译、回归或审阅，不自动提交。未执行的验证保持未验证，不自动修改 TAPD 状态。', 'Enabled items are dispatched. P4 pool tasks end on pending CL delivery, then continue the queue without waiting for builds, regression or review. No automatic submit; unperformed checks remain unverified. TAPD status is unchanged.')}</p>
  </div>
}
