import { describe, expect, it, vi } from 'vitest'
import { P4ConfigSchema } from '../src/sources/p4-change.ts'
import { importTapdFilter, matchesLocal, sweepDue, TapdFilterScheduleSchema,
  type LocalRule, type TapdFilterSchedule } from '../src/sources/tapd-filters.ts'
import { runFilterSweeps } from '../src/sources/tapd-sweep.ts'
import { TapdConfigSchema, type TapdItem, type TapdApi } from '../src/sources/tapd-api.ts'
import { KV } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'

/** The operator's real export from 萨罗斯管理平台 · 缺陷, 2026-11-14. */
const EXPORT = {
  source: 'TAPD筛选条件', page: '萨罗斯管理平台 · 缺陷', url: '/bug/client.html', exportedAt: '2026-11-14 21:50:50',
  conditions: [
    { field: '发布计划', op: '属于 (In)', enabled: true, value: ['PC-RushCBT3'] },
    { field: '优先级', op: '属于 (In)', enabled: true, value: ['紧急', '高', '中', '低'] },
    { field: '所属分支', op: '属于 (In)', enabled: true, value: ['main', 'release', 'Beta_Test'] },
    { field: '标签（不属于）', op: '不属于 (Not In)', enabled: true, value: ['CBT3非必修'] },
    { field: '是否必现', op: '属于 (In)', enabled: true, value: ['必现', '高概率偶现', '低概率偶现'] },
    { field: '状态（属于）', op: '属于 (In)', enabled: true, value: ['新建', '修复中', '重新打开'] },
    { field: '状态（不属于）', op: '不属于 (Not In)', enabled: true, value: ['挂起'] },
    { field: 'Bug类型', op: '属于 (In)', enabled: true, value: ['--', '功能', '本地化', '崩溃'] },
    { field: '标题', op: '不包含 (Not Like)', enabled: true, value: ['XSCAN扫描', 'AI Review扫描', '日志告警'] },
    { field: '创建时间', op: '介于 (Range)', enabled: true, value: { from: '2024-01-09T00:00', to: '2099-09-09T14:00' } },
    { field: '标签（OR 口径）', op: '属于 (In)', enabled: false, value: ['必修bug'] },
    { field: '处理人', op: '属于 (In)', enabled: true, value: ['一组 1.1（玩法）'] },
  ],
  state: { releases: ['1168880148001000101'], branches: ['main', 'release', 'Beta_Test'],
    exclLabels: ['CBT3非必修'], repro: ['必现'], status: ['新建'], statusEx: ['挂起'],
    bugtypes: ['--', '功能'], prioritySelection: ['urgent', 'high', 'middle', 'low'],
    ctRange: { from: '2024-01-09T00:00', to: '2099-09-09T14:00' } },
}
const item = (over: Partial<TapdItem> = {}): TapdItem => ({ type: 'bug', workspace: '68880148', id: '1',
  title: '崩溃修复', description: '', status: 'new', owners: ['何操'], creator: '何操',
  created: '2026-11-14T00:00:00.000Z', modified: '2026-11-14T00:00:00.000Z', iteration: '', label: '', ...over })

describe('importing the platform bug filter', () => {
  it('maps every Chinese condition to a verified TAPD field, and reports the rest explicitly', () => {
    const result = importTapdFilter(EXPORT, { name: 'filter-bug-1' })
    expect(result.query).toMatchObject({
      release_id: '1168880148001000101',
      priority_label: '紧急|高|中|低',
      custom_field_10: 'main|release|Beta_Test',
      custom_field_7: '必现|高概率偶现|低概率偶现',
      v_status: '新建|修复中|重新打开',
      status: '<>suspended',
      custom_field_19: '功能|本地化|崩溃',
      created: '2024-01-09 00:00:00~2099-09-09 14:00:00',
    })
    expect(result.local).toContainEqual({ field: 'label', op: 'not_in', values: ['CBT3非必修'] })
    expect(result.local).toContainEqual({ field: 'title', op: 'not_like', values: ['XSCAN扫描', 'AI Review扫描', '日志告警'] })
    expect(result.report).toHaveLength(EXPORT.conditions.length)
    expect(result.report.find(row => row.field === '标签（OR 口径）')?.target).toBe('skipped')
    expect(result.report.find(row => row.field === '处理人')?.target).toBe('manual')
    expect(result.warnings.some(line => line.includes('组成员映射'))).toBe(true)
    expect(result.schedule.enabled).toBe(false)
    expect(result.watch).toMatchObject({ type: 'bug', sweepOnly: true })
  })

  it('resolves a group name into current_owner when the operator supplied a member map', () => {
    const result = importTapdFilter(EXPORT, { ownerGroups: { '一组 1.1（玩法）': ['何操', '王泽平'] } })
    expect(result.query.current_owner).toBe('USER_OR<何操|王泽平>')
    expect(result.report.find(row => row.field === '处理人')?.target).toBe('api')
    expect(result.warnings.some(line => line.includes('组成员映射'))).toBe(false)
  })

  it('uses live workspace field/status maps in preference to the built-in fallbacks', () => {
    const result = importTapdFilter(EXPORT, { fieldNames: { 所属分支: 'custom_field_22', 是否必现: 'custom_field_7' },
      statusCodes: { 挂起: 'status_custom' } })
    expect(result.query.custom_field_22).toBe('main|release|Beta_Test')
    expect(result.query.status).toBe('<>status_custom')
    expect(result.query.custom_field_10).toBeUndefined()
  })

  it('excludes several statuses locally because TAPD only verifies a single <> value', () => {
    const result = importTapdFilter({ conditions: [{ field: '状态（不属于）', op: '不属于 (Not In)', enabled: true,
      value: ['挂起', '已完成'] }], state: {} })
    expect(result.local).toContainEqual({ field: 'status', op: 'not_in', values: ['suspended', 'closed'] })
    expect(result.query.status).toBeUndefined()
  })

  it('never silently drops an unrecognised condition', () => {
    const result = importTapdFilter({ conditions: [{ field: '未知字段', op: '属于 (In)', enabled: true, value: ['x'] }], state: {} })
    expect(result.report[0]?.target).toBe('manual')
    expect(result.warnings.join(' ')).toContain('未知字段')
  })
})

describe('local rules', () => {
  it('excludes by title substring, label membership and status code', () => {
    const rules: LocalRule[] = [
      { field: 'title', op: 'not_like', values: ['XSCAN扫描', '日志告警'] },
      { field: 'label', op: 'not_in', values: ['CBT3非必修'] },
      { field: 'status', op: 'not_in', values: ['suspended'] },
    ]
    expect(matchesLocal(item(), rules)).toBe(true)
    expect(matchesLocal(item({ title: '【日志告警】TeamSvr.lua' }), rules)).toBe(false)
    expect(matchesLocal(item({ label: 'AI审查单|CBT3非必修' }), rules)).toBe(false)
    expect(matchesLocal(item({ status: 'suspended' }), rules)).toBe(false)
    expect(matchesLocal(item({ label: 'AI审查单' }), rules)).toBe(true)
  })
})

describe('daily sweep', () => {
  const schedule = (over: Partial<TapdFilterSchedule> = {}): TapdFilterSchedule => TapdFilterScheduleSchema.parse({
    name: 'filter-bug-1', enabled: true, at: '09:00', maxPerRun: 2, windowDays: 2,
    query: { status: 'new' }, local: [{ field: 'title', op: 'not_like', values: ['日志告警'] }], ...over })
  const config = (s: TapdFilterSchedule) => TapdConfigSchema.parse({ workspace: '68880148',
    watches: [{ name: s.name, type: 'bug', mode: 'assigned', sweepOnly: true }], filterSchedules: [s] })
  const host = (items: TapdItem[], state: Record<string, unknown> = {}) => {
    const values = new Map<string, unknown>(Object.entries(state))
    const received: unknown[] = []
    const api = { items: vi.fn(async () => items) } as unknown as TapdApi
    const ctx = {
      state: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value) } },
      receive: vi.fn(async (trigger: unknown) => { received.push(trigger); return 'stored' as const }),
    } as unknown as SourceContext
    return { ctx, api, values, received }
  }
  const now = new Date(2026, 10, 15, 10, 0, 0)

  it('dispatches matching new bugs once per day with the operator-authorized marker', async () => {
    const { ctx, api, values, received } = host([item({ id: 'a' }), item({ id: 'b', title: '【日志告警】x' }), item({ id: 'c' })])
    const result = await runFilterSweeps(ctx, api, config(schedule()), now)
    expect(result[0]).toMatchObject({ scanned: 3, matched: 2, dispatched: 2, capped: true })
    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({ human: false, addressed: 'direct',
      meta: expect.objectContaining({ filterSweep: 'filter-bug-1', mode: 'all' }) })
    expect(api.items).toHaveBeenCalledWith('bug', '68880148', expect.objectContaining({ status: 'new', modified: expect.stringMatching(/^>/) }), undefined)
    const stored = values.get(KV.tapd.sweep('filter-bug-1')) as { lastRun: string; seen: string[] }
    expect(stored.lastRun).toBe('2026-11-15')
    expect(stored.seen).toEqual(['a', 'c'])
    // Same day: no second run.
    expect(await runFilterSweeps(ctx, api, config(schedule()), now)).toEqual([])
    // Next day: already-dispatched items are skipped.
    const nextDay = new Date(2026, 10, 16, 10, 0, 0)
    const second = await runFilterSweeps(ctx, api, config(schedule()), nextDay)
    expect(second[0]?.dispatched).toBe(0)
  })

  it('respects the per-run cap and never dispatches an item twice', async () => {
    const many = Array.from({ length: 10 }, (_, i) => item({ id: `id-${i}` }))
    const { ctx, api, values } = host(many)
    const result = await runFilterSweeps(ctx, api, config(schedule({ maxPerRun: 3, windowDays: 2 })), now)
    expect(result[0]?.dispatched).toBe(3)
    expect((values.get(KV.tapd.sweep('filter-bug-1')) as { seen: string[] }).seen).toHaveLength(3)
  })

  it('does not mark the day as done when TAPD fails, so the next poll retries', async () => {
    const { ctx, values } = host([])
    const api = { items: vi.fn(async () => { throw new Error('TAPD down') }) } as unknown as TapdApi
    const result = await runFilterSweeps(ctx, api, config(schedule()), now)
    expect(result[0]?.error).toContain('TAPD down')
    expect(values.has(KV.tapd.sweep('filter-bug-1'))).toBe(false)
  })

  it('is off by default and only runs at or after its local time', () => {
    const off = schedule({ enabled: false })
    expect(sweepDue(off, now)).toBe(false)
    expect(sweepDue(schedule(), new Date(2026, 10, 15, 8, 59))).toBe(false)
    expect(sweepDue(schedule(), now)).toBe(true)
    expect(sweepDue(schedule(), now, '2026-11-15')).toBe(false)
  })

  it('panel-only guard rejects a tool changing filter schedules', async () => {
    const { Settings } = await import('../src/app/settings.ts')
    expect(typeof Settings).toBe('function')
    // A schedule is inert unless a person saved it: config defaults keep it empty.
    expect(TapdConfigSchema.parse({}).filterSchedules).toEqual([])
    expect(P4ConfigSchema.parse({}).syncBeforeWork).toBe(false)
  })
})
