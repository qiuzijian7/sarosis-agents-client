/** Bounded AND/OR query union; exclusion rules and owner checks run before any candidate enters the pool. */
import type { TapdApi, TapdChoice, TapdConfig, TapdItem } from './tapd-api.ts'
import { cleanOwner, resolveTapdName } from './tapd-members.ts'
import { matchesLocal } from './tapd-filters.ts'
import { compileSchemeBranches, PoolItemSchema, type TapdFilterScheme } from './tapd-filter-schemes.ts'

export async function previewScheme(api: TapdApi & { releases?: (workspace: string) => Promise<TapdChoice[]> },
  config: TapdConfig, scheme: TapdFilterScheme, cap: number, now = new Date()) {
  const ownerRow = scheme.conditions.find(row => row.enabled && row.locked && /^(处理人|修复人)$/.test(row.field))
  const login = Array.isArray(ownerRow?.value) ? ownerRow.value[0] ?? '' : ''
  if (!login.trim()) throw new Error('当前用户条件未锁定，请重新同步身份')
  const owner = resolveTapdName(login, config.members)
  const conditions = scheme.conditions.map(row => row.locked && /^(处理人|修复人)$/.test(row.field) ? { ...row, value: [owner] } : row)
  let releaseIds: Record<string, string> = {}
  if (conditions.some(row => row.enabled && row.field === '发布计划' && Array.isArray(row.value) && row.value.some(value => !/^\d+$/.test(value)))) {
    const choices = await api.releases?.(config.workspace) ?? []
    releaseIds = Object.fromEntries(choices.map(choice => [choice.label, choice.value]))
    for (const row of conditions.filter(row => row.enabled && row.field === '发布计划')) {
      if (!Array.isArray(row.value)) continue
      for (const name of row.value) {
        if (/^\d+$/.test(name) || Object.hasOwn(releaseIds, name)) continue
        const matches = choices.filter(choice => choice.label.trim().toLowerCase() === name.trim().toLowerCase())
        const ids = [...new Set(matches.map(choice => choice.value))]
        if (ids.length > 1) throw new Error(`发布计划名称匹配到多个 ID：${name}，请填写准确 ID`)
        if (ids[0]) releaseIds[name] = ids[0]
      }
    }
  }
  let maps = {}
  if (scheme.kind === 'bug' && api.filterMaps) maps = await api.filterMaps(config.workspace)
  const branches = compileSchemeBranches({ ...scheme, conditions }, { ...maps, releaseIds })
  const byId = new Map<string, TapdItem>()
  for (const branch of branches) {
    const records = await api.items(scheme.kind, config.workspace, branch.query)
    if (records.length >= 2000) throw new Error('筛选超过 2000 条，请收窄条件后重试；没有截断入池')
    for (const item of records) if (item.workspace === config.workspace && item.type === scheme.kind && matchesLocal(item, branch.local) &&
      item.owners.some(name => cleanOwner(name).toLowerCase() === owner.toLowerCase())) byId.set(item.id, item)
  }
  const matched = [...byId.values()]
  const recent = matched.filter(item => Date.parse(item.modified) >= now.getTime() - 2 * 86400_000).length
  const items = matched.slice(0, cap).map(item => PoolItemSchema.parse({ id: item.id, kind: scheme.kind,
    title: item.title, priority: item.priority ?? '', status: item.status, scheme: scheme.name,
    hit: scheme.conditions.filter(row => row.enabled).map(row => row.field).join(' · ') }))
  return { total: matched.length, recent, items }
}
