import { describe, expect, it, vi } from 'vitest'
import { itemOf, TapdConfigSchema, type TapdApi } from '../src/sources/tapd-api.ts'
import { applyOwnerOverride, FilterConditionSchema, mergeIntoPool, PoolItemSchema, TapdFilterPoolSchema, TapdFilterSchemeSchema } from '../src/sources/tapd-filter-schemes.ts'
import { previewScheme } from '../src/sources/tapd-scheme-preview.ts'

const config = TapdConfigSchema.parse({ members: [{ alias: 'qiuzijian', name: '邱子鉴' }] })
const condition = (field: string, value: string[], group?: string, op = '属于 (In)') => FilterConditionSchema.parse({ field, value, group, op })
const scheme = TapdFilterSchemeSchema.parse({ name: 'filter-bug-1', kind: 'bug', url: 'https://example.test',
  conditions: applyOwnerOverride([condition('优先级', ['高'], 'or1'), condition('标签（OR 口径）', ['必修bug'], 'or1'),
    condition('标题', ['忽略'], undefined, '不包含 (Not Like)')], 'qiuzijian') })
const item = (id: string, title = '待修复', owner = '邱子鉴') => itemOf('bug', { id, title, workspace_id: config.workspace,
  current_owner: owner, priority_label: '高', modified: '2026-11-17 01:00:00' })

describe('preview semantics', () => {
  it('unions OR branches, deduplicates, applies exclusion and owner checks before taking the cap', async () => {
    const api = { items: vi.fn(async (_kind: string, _workspace: string, query: Record<string, string>) =>
      query.priority_label ? [item('x', '忽略这条'), item('1'), item('2', '其他人', '其他人')] : [item('1'), item('3')]) } as unknown as TapdApi
    const result = await previewScheme(api, config, scheme, 1)
    expect(result.total).toBe(2); expect(result.items.map(row => row.id)).toEqual(['1'])
    expect(result.items[0]!.enabled).toBe(false); expect(result.items[0]!.priority).toBe('高')
    const queries = vi.mocked(api.items).mock.calls.map(call => call[2])
    expect(queries).toHaveLength(2)
    expect(queries.every(query => !(query.label && query.priority_label))).toBe(true)
    expect(queries.every(query => query.current_owner === 'USER_OR<邱子鉴>')).toBe(true)
  })
  it('rejects missing identity and empty active fields rather than querying an entire workspace', async () => {
    const api = { items: vi.fn(async () => []) } as unknown as TapdApi
    await expect(previewScheme(api, config, { ...scheme, conditions: [] }, 20)).rejects.toThrow('当前用户')
    await expect(previewScheme(api, config, { ...scheme, conditions: [...scheme.conditions, condition('所属分支', [])] }, 20)).rejects.toThrow('没有取值')
    expect(api.items).not.toHaveBeenCalled()
  })
  it('maps release names into IDs and normalises story date ranges', async () => {
    const api = { releases: vi.fn(async () => [{ label: '版本A', value: '123' }]), items: vi.fn(async () => []) }
    const story = TapdFilterSchemeSchema.parse({ ...scheme, kind: 'story', conditions: applyOwnerOverride([
      condition('发布计划', ['版本A']), FilterConditionSchema.parse({ field: '预计完成时间', op: 'range', value: { from: '2026-11-01T00:00', to: '2026-11-30T23:59' } })], 'qiuzijian') })
    await previewScheme(api as unknown as TapdApi & { releases: typeof api.releases }, config, story, 20)
    expect(api.items).toHaveBeenCalledWith('story', config.workspace, expect.objectContaining({ release_id: '123',
      owner: 'USER_OR<邱子鉴>', due: '2026-11-01 00:00:00~2026-11-30 23:59:00' }))
  })
  it('matches the real PC-RushCBT3 spelling to a unique release label case-insensitively', async () => {
    const api = { releases: vi.fn(async () => [{ label: 'PC-rushCBT3', value: '123' }]), items: vi.fn(async () => []) }
    const story = TapdFilterSchemeSchema.parse({ ...scheme, kind: 'story', conditions: applyOwnerOverride([condition('发布计划', ['PC-RushCBT3'])], 'qiuzijian') })
    await previewScheme(api as unknown as TapdApi & { releases: typeof api.releases }, config, story, 20)
    expect(api.items).toHaveBeenCalledWith('story', config.workspace, { release_id: '123', owner: 'USER_OR<邱子鉴>' })
  })
  it('prefers an exact release name and rejects ambiguous case-insensitive names', async () => {
    const api = { releases: vi.fn(async () => [{ label: 'PC-RushCBT3', value: '123' }, { label: 'PC-rushCBT3', value: '456' }]), items: vi.fn(async () => []) }
    const exact = TapdFilterSchemeSchema.parse({ ...scheme, kind: 'story', conditions: applyOwnerOverride([condition('发布计划', ['PC-RushCBT3'])], 'qiuzijian') })
    await previewScheme(api as unknown as TapdApi & { releases: typeof api.releases }, config, exact, 20)
    expect(api.items).toHaveBeenCalledWith('story', config.workspace, { release_id: '123', owner: 'USER_OR<邱子鉴>' })
    api.items.mockClear()
    const ambiguous = { ...exact, conditions: applyOwnerOverride([condition('发布计划', ['pc-RUSHcbt3'])], 'qiuzijian') }
    await expect(previewScheme(api as unknown as TapdApi & { releases: typeof api.releases }, config, ambiguous, 20)).rejects.toThrow('多个 ID')
    expect(api.items).not.toHaveBeenCalled()
  })
  it('preserves seconds when sending due bounds and rejects reversed or invalid ranges', async () => {
    const api = { items: vi.fn(async () => []) } as unknown as TapdApi
    const due = FilterConditionSchema.parse({ field: '预计完成时间', op: 'range', value: ['2024-01-09 00:00:00', '2026-09-30T23:59:59'] })
    const story = TapdFilterSchemeSchema.parse({ ...scheme, kind: 'story', conditions: applyOwnerOverride([due], 'qiuzijian') })
    await previewScheme(api, config, story, 20)
    expect(api.items).toHaveBeenCalledWith('story', config.workspace, expect.objectContaining({ due: '2024-01-09 00:00:00~2026-09-30 23:59:59' }))
    await expect(previewScheme(api, config, { ...story, conditions: [story.conditions[1]!, { ...due, value: { from: '2026-09-30T23:59:59', to: '2024-01-09T00:00:00' } }] }, 20))
      .rejects.toThrow('开始时间不能晚于结束时间')
    await expect(previewScheme(api, config, { ...story, conditions: [story.conditions[1]!, { ...due, value: { from: 'invalid', to: '' } }] }, 20))
      .rejects.toThrow('时间格式无效')
  })
  it('merges without mutating the old pool or losing enable/state and separates same-ID story/bug', () => {
    const original = TapdFilterPoolSchema.parse({ items: [PoolItemSchema.parse({ id: '1', kind: 'bug', title: 'old', enabled: true, state: 'queued' })] })
    const next = mergeIntoPool(original, [PoolItemSchema.parse({ id: '1', kind: 'bug', title: 'new' }), PoolItemSchema.parse({ id: '1', kind: 'story' })])
    expect(next.items).toHaveLength(2); expect(original.items[0]!.title).toBe('old')
    expect(next.items[0]).toMatchObject({ title: 'new', enabled: true, state: 'queued' })
  })
})
