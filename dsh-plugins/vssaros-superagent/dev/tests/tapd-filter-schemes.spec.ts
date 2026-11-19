import { describe, expect, it } from 'vitest'
import { applyOwnerOverride, applyRunResult, compileScheme, fallbackConditions, FilterConditionSchema,
  conditionRange, filterDateTime, localDay, mergeIntoPool, normaliseOp, parseDomConditions, parseScrapedConditions, planPoolRun, poolDue, PoolItemSchema,
  schemeHash, startPoolRun, TapdFilterPoolSchema, TapdFilterSchemeSchema, ticketUrl, togglePoolItem,
  type PoolItem } from '../src/sources/tapd-filter-schemes.ts'

const item = (over: Partial<PoolItem> = {}): PoolItem => PoolItemSchema.parse({ id: '1001', kind: 'bug',
  title: 'a bug', scheme: 'filter-bug-1', ...over })
const at = (hour: number, minute = 0) => new Date(2026, 10, 17, hour, minute)

describe('filter scheme + pool defaults', () => {
  it('keeps the platform story due range including seconds', () => {
    expect(fallbackConditions('story').find(row => row.field === '预计完成时间')?.value)
      .toEqual({ from: '2024-01-09T00:00:00', to: '2026-09-30T23:59:59' })
  })
  it('normalises local date formats without timezone shifts or second truncation', () => {
    expect(filterDateTime('2026-09-30 23:59:59')).toBe('2026-09-30T23:59:59')
    expect(filterDateTime('2026-09-30T23:59')).toBe('2026-09-30T23:59')
    expect(filterDateTime('2026-09-30')).toBe('2026-09-30T00:00')
    expect(filterDateTime('2026-02-30 12:00:00')).toBe('')
    expect(conditionRange(['2024-01-09 00:00:00', '2026-09-30 23:59:59']))
      .toEqual({ from: '2024-01-09T00:00:00', to: '2026-09-30T23:59:59' })
    expect(conditionRange({ from: '', to: '' })).toEqual({ from: '', to: '' })
    expect(parseDomConditions([{ field: '预计完成时间', op: 'range', values: [], range: [] }])[0]?.value)
      .toEqual({ from: '', to: '' })
  })
  it('defaults to the small-hours run, auto processing off and a bounded cap', () => {
    const pool = TapdFilterPoolSchema.parse({})
    expect(pool.at).toBe('02:00')
    expect(pool.autoProcess).toBe(false)
    expect(pool.maxPerRun).toBe(20)
    expect(pool.items).toEqual([])
  })
  it('parses a scheme with a stable hash', () => {
    const conditions = fallbackConditions('story')
    const scheme = TapdFilterSchemeSchema.parse({ name: 'filter-story-1', kind: 'story', url: 'https://example/page',
      conditions, hash: schemeHash(conditions) })
    expect(scheme.hash).toBe(schemeHash(conditions))
    expect(scheme.source).toBe('fallback')
  })
})

describe('scraping and owner override', () => {
  it('normalises rendered DOM rows, including switches and ranges', () => {
    const rows = [
      { field: '发布计划', op: 'in', values: ['PC-RushCBT3'], range: [], enabled: true },
      { field: '创建时间', op: 'range', values: [], range: ['2026-07-08T00:00', ''], enabled: false, group: 'or1' },
    ]
    const found = parseDomConditions(rows)
    expect(found[0]!.op).toBe('属于 (In)')
    expect(found[1]!.value).toEqual({ from: '2026-07-08T00:00', to: '' })
    expect(found[1]!.enabled).toBe(false)
    expect(found[1]!.group).toBe('or1')
    expect(parseDomConditions({ bad: true })).toEqual([])
  })
  it('reads condition declarations from a platform page', () => {
    const text = "FilterCard.render(body, { rows: [ { field:'发布计划', op:'in', value:{} }, { field:'优先级', op:'in' } ] })"
    const found = parseScrapedConditions(text, 'bug')
    expect(found.map(row => row.field)).toEqual(['发布计划', '优先级'])
    expect(found[1]!.group).toBe('or1')
  })
  it('prefers a structured export hook when the page provides one', () => {
    const text = "window.__VSSAROS_TAPD_FILTERS__ = " + JSON.stringify({ conditions: [
      { field: '状态', op: '属于 (In)', enabled: true, value: ['新建'] }] }) + ";"
    expect(parseScrapedConditions(text, 'story')[0]!.value).toEqual(['新建'])
  })
  it('replaces every owner with the current TOF account and locks the row', () => {
    const conditions = fallbackConditions('bug')
    const overridden = applyOwnerOverride(conditions, 'qiuzijian')
    const owners = overridden.filter(row => row.field === '处理人' || row.field === '修复人')
    expect(owners).toHaveLength(1)
    expect(owners[0]!.value).toEqual(['qiuzijian'])
    expect(owners[0]!.locked).toBe(true)
  })
  it('adds an owner row when the scraped scheme has none', () => {
    const conditions = [FilterConditionSchema.parse({ field: '状态', op: '属于 (In)', value: ['新建'] })]
    expect(applyOwnerOverride(conditions, 'qiuzijian').some(row => row.field === '处理人')).toBe(true)
  })
  it('normalises the platform display operators', () => {
    expect(normaliseOp('不属于 (Not In)')).toBe('not_in')
    expect(normaliseOp('不包含 (Not Like)')).toBe('not_like')
    expect(normaliseOp('介于 (Range)')).toBe('range')
    expect(normaliseOp('属于 (In)')).toBe('in')
  })
})

describe('compilation and links', () => {
  it('uses owner/due for stories and current_owner for bugs', () => {
    const story = compileScheme(TapdFilterSchemeSchema.parse({ name: 's', kind: 'story', url: 'x',
      conditions: applyOwnerOverride(fallbackConditions('story'), 'qiuzijian') }), { releaseIds: { 'PC-RushCBT3': '123' } })
    expect(story.query.owner).toBe('USER_OR<qiuzijian>')
    const bug = compileScheme(TapdFilterSchemeSchema.parse({ name: 'b', kind: 'bug', url: 'x',
      conditions: applyOwnerOverride(fallbackConditions('bug'), 'qiuzijian') }), { releaseIds: { 'PC-RushCBT3': '123' } })
    expect(bug.query.current_owner).toBe('USER_OR<qiuzijian>')
    expect(bug.query.priority_label).toBe('紧急|高|中|低')
    expect(bug.query.label).toBeUndefined()
    expect(bug.local.some(rule => rule.field === 'title' && rule.op === 'not_like')).toBe(true)
  })
  it('builds the same ticket URLs as itemPage', () => {
    expect(ticketUrl('https://www.tapd.cn', '68880148', { kind: 'bug', id: '123' }))
      .toBe('https://www.tapd.cn/68880148/bugtrace/bugs/view/123')
    expect(ticketUrl('https://www.tapd.cn/', '68880148', { kind: 'story', id: '456' }))
      .toBe('https://www.tapd.cn/68880148/prong/stories/view/456')
  })
})

describe('pool state machine', () => {
  it('merges candidates without duplicates and keeps a person\'s edits', () => {
    let pool = TapdFilterPoolSchema.parse({ items: [item({ enabled: true, state: 'done' })] })
    pool = mergeIntoPool(pool, [item({ title: 'updated' }), item({ id: '1002', kind: 'story' })])
    expect(pool.items).toHaveLength(2)
    expect(pool.items[0]!.enabled).toBe(true)
    expect(pool.items[0]!.state).toBe('done')
    expect(pool.items[0]!.title).toBe('updated')
    expect(pool.items[1]!.enabled).toBe(false)
    expect(pool.items[1]!.state).toBe('pending')
  })
  it('lets a person enable or disable an item', () => {
    const pool = togglePoolItem(TapdFilterPoolSchema.parse({ items: [item()] }), '1001', true)
    expect(pool.items[0]!.enabled).toBe(true)
  })
  it('is due once per local day at or after 02:00 while auto processing is on', () => {
    const pool = TapdFilterPoolSchema.parse({ autoProcess: true })
    expect(poolDue(pool, at(1, 59))).toBe(false)
    expect(poolDue(pool, at(2, 0))).toBe(true)
    expect(poolDue({ ...pool, lastRun: localDay(at(9)) }, at(9))).toBe(false)
    expect(poolDue(TapdFilterPoolSchema.parse({}), at(9))).toBe(false)
  })
  it('plans only enabled items, caps the batch and keeps a stable runId', () => {
    const pool = TapdFilterPoolSchema.parse({ maxPerRun: 2, items: [
      item({ id: '1', enabled: true }), item({ id: '2', enabled: false }),
      item({ id: '3', enabled: true, state: 'failed' }), item({ id: '4', enabled: true }) ] })
    const run = planPoolRun(pool, at(2))
    expect(run.items.map(row => row.id)).toEqual(['1', '3'])
    expect(run.capped).toBe(true)
    expect(run.runId).toBe(planPoolRun(pool, at(2)).runId)
  })
  it('moves a planned run through queued -> done and counts it once', () => {
    const pool = TapdFilterPoolSchema.parse({ items: [item({ id: '1', enabled: true }), item({ id: '2' })] })
    const run = planPoolRun(pool, at(2))
    const started = startPoolRun(pool, run)
    expect(started.items[0]!.state).toBe('queued')
    expect(started.items[1]!.state).toBe('pending')
    expect(startPoolRun(started, run)).toBe(started)
    const finished = applyRunResult(started, run.runId, true, '2026-11-17T02:00:00Z')
    expect(finished.items[0]!.state).toBe('done')
    expect(finished.processedToday).toBe(1)
    expect(applyRunResult(finished, run.runId, true, 'later').processedToday).toBe(1)
    const failed = applyRunResult(startPoolRun(pool, run), run.runId, false, 'later')
    expect(failed.items[0]!.state).toBe('failed')
    expect(failed.processedToday).toBe(0)
  })
})
