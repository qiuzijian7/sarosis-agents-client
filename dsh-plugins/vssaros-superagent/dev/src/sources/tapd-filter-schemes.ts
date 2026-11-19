/**
 * VsSaros addition (2026-11-17): TAPD filter schemes scraped from the Saroasis platform pages, and the
 * "filter result pool" they feed. This module is pure: schemas, scraping/normalisation, the pool state
 * machine and the daily run planner. No Host, HTTP or React dependency, so both the Host routes and
 * the settings panel share exactly one contract.
 *
 * Two schemes (story + bug) are scraped from the platform's own condition cards. Matching items enter
 * the pool disabled; a person enables the ones SuperAgent may fix. With `autoProcess` on, a daily run
 * at `at` (default 02:00, the small-hours low-traffic window) plans at most `maxPerRun` of them.
 * Every planned run carries a `runId` so a retry cannot dispatch the same item twice.
 */
import { z } from 'zod'
import { importTapdFilter, type CompileOptions, type LocalRule } from './tapd-filters.ts'
import { TAPD_FILTER_READ_EXPRESSION } from '../../../../vssaros-browser/lib/core/tapdFilters.js'

/** Durable per-pool run state, kept in the Source's KV rather than in the editable settings draft. */
export interface PoolIntakeStatus {
  state: PoolState; phase: 'delivery' | 'evaluation' | 'working' | 'person' | 'rejected' | 'ended'
  detail: string; retryable: boolean; ticketId?: string; at?: string
}
export interface PoolRunState {
  lastRun: string; runIds: string[]; dispatched: number; at: string
  records?: Record<string, { state: PoolState; runId: string; triggerId: string; lastRunAt: string; attempts: number; item?: PoolItem; intake?: PoolIntakeStatus; dispatching?: boolean; authorization?: import('./tapd-pool-authorization.ts').PoolAuthorization }>
}
export function reconcilePoolState(state: PoolRunState, inspect: (id: string) => PoolIntakeStatus | undefined, now = new Date()): PoolRunState {
  return { ...state, records: Object.fromEntries(Object.entries(state.records ?? {}).map(([key, record]) => {
    if (record.dispatching && now.getTime() - Date.parse(record.lastRunAt) < 120_000) return [key, record]
    const intake = inspect(record.triggerId)
    return [key, intake ? { ...record, dispatching: false, state: intake.state, intake, lastRunAt: intake.at ?? record.lastRunAt }
      : record.dispatching ? { ...record, dispatching: false, state: 'failed' as const } : record]
  })) }
}
export const poolItemKey = (workspace: string, owner: string, item: Pick<PoolItem, 'kind' | 'id'>) =>
  `${workspace}:${owner}:${item.kind}:${item.id}`
export function poolWithRuntime(pool: TapdFilterPool, workspace: string, state?: PoolRunState): TapdFilterPool {
  return { ...pool, items: pool.items.map(item => {
    const record = state?.records?.[poolItemKey(workspace, pool.owner, item)]
    return record ? { ...item, state: record.state, runId: record.runId, lastRunAt: record.lastRunAt, attempts: record.attempts,
      detail: record.intake?.detail, phase: record.intake?.phase, ticketId: record.intake?.ticketId, retryable: record.intake?.retryable } : item
  }) }
}

export const FILTER_SCHEME_SOURCES = [
  { kind: 'story', name: 'filter-story-1', url: 'http://saroasisstudiosystem.saroasis.woa.com:9999/story/main.html',
    script: '' },
  { kind: 'bug', name: 'filter-bug-1', url: 'http://saroasisstudiosystem.saroasis.woa.com:9999/bug.html',
    script: 'http://saroasisstudiosystem.saroasis.woa.com:9999/assets/bugview.js' },
] as const
export type FilterSchemeKind = typeof FILTER_SCHEME_SOURCES[number]['kind']

export const STORY_DUE_DEFAULT = { from: '2024-01-09T00:00:00', to: '2026-09-30T23:59:59' } as const

/** TAPD range bounds are wall-clock times, not instants: never shift them through a timezone. */
export function filterDateTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(value.trim())
  if (!match) return ''
  const date = match[1]!, time = match[2] ?? '00:00', seconds = match[3]
  const stamp = `${date}T${time}:${seconds ?? '00'}`
  const parsed = new Date(`${stamp}Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== stamp) return ''
  return `${date}T${time}${seconds === undefined ? '' : `:${seconds}`}`
}

export function conditionRange(value: string[] | { from: string; to: string }): { from: string; to: string } {
  const range = Array.isArray(value) ? { from: value[0] ?? '', to: value[1] ?? '' } : value
  return { from: filterDateTime(range.from), to: filterDateTime(range.to) }
}

export const FilterConditionSchema = z.object({
  field: z.string().trim().min(1),
  op: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  value: z.union([z.array(z.string()), z.object({ from: z.string(), to: z.string() }).strict()]).default([]),
  /** Non-empty marks a row inside an OR subgroup; rows outside are joined with a fixed AND. */
  group: z.string().trim().optional(),
  /** The owner row is system-owned: the current user replaces whatever the platform page showed. */
  locked: z.boolean().default(false),
}).strict()
export type FilterCondition = z.infer<typeof FilterConditionSchema>

export const TapdFilterSchemeSchema = z.object({
  name: z.string().trim().regex(/^[\w.-]{1,40}$/),
  kind: z.enum(['story', 'bug']),
  url: z.string().trim(),
  capturedAt: z.string().default(''),
  hash: z.string().default(''),
  /** `live` = conditions parsed from the page; `fallback` = built-in baseline because the page was unreachable. */
  source: z.enum(['live', 'fallback']).default('fallback'),
  conditions: z.array(FilterConditionSchema).default([]),
}).strict()
export type TapdFilterScheme = z.infer<typeof TapdFilterSchemeSchema>

export const POOL_STATES = ['pending', 'queued', 'processing', 'done', 'failed'] as const
export type PoolState = typeof POOL_STATES[number]
export const PoolItemSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(['story', 'bug']),
  title: z.string().default(''),
  priority: z.string().default(''),
  status: z.string().default(''),
  scheme: z.string().default(''),
  hit: z.string().default(''),
  /** A person must opt each item in; scraped candidates arrive disabled. */
  enabled: z.boolean().default(false),
  state: z.enum(POOL_STATES).default('pending'),
  detail: z.string().optional(), phase: z.enum(['delivery', 'evaluation', 'working', 'person', 'rejected', 'ended']).optional(),
  ticketId: z.string().optional(), retryable: z.boolean().optional(),
  runId: z.string().default(''),
  lastRunAt: z.string().default(''),
  attempts: z.number().int().min(0).default(0),
}).strict()
export type PoolItem = z.infer<typeof PoolItemSchema>

export const TapdFilterPoolSchema = z.object({
  name: z.string().trim().regex(/^[\w.-]{1,40}$/).default('filter-pool-1'),
  items: z.array(PoolItemSchema).default([]),
  /** Off until a person turns it on: the pool alone never dispatches anything. */
  autoProcess: z.boolean().default(false),
  /** Local HH:MM; the small-hours default avoids the 00:00 day rollover and service warm-up. */
  at: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('02:00'),
  maxPerRun: z.number().int().min(1).max(200).default(20),
  processedToday: z.number().int().min(0).default(0),
  lastRun: z.string().default(''),
  /** The current user (TOF login name) that replaces every owner condition. */
  owner: z.string().default(''),
}).strict()
export type TapdFilterPool = z.infer<typeof TapdFilterPoolSchema>

/** Stable, dependency-free fingerprint; identical conditions never rewrite a saved scheme. */
export function schemeHash(conditions: readonly FilterCondition[]): string {
  const text = JSON.stringify(conditions)
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Chinese display operators -> the internal operator names used by the condition compiler. */
export function normaliseOp(raw: string): 'in' | 'not_in' | 'not_like' | 'range' {
  if (/不属于|not in/i.test(raw)) return 'not_in'
  if (/不包含|not like/i.test(raw)) return 'not_like'
  if (/介于|range/i.test(raw)) return 'range'
  return 'in'
}

/**
 * The platform pages declare their condition rows as `{ field:'…', op:'…', … }` (story/main.html's
 * `storyFilterRows()` and bugview.js's `FilterCard.render`). Reading those declarations is the
 * no-browser way to scrape the live condition set; a page that exposes a structured export hook
 * (`window.__VSSAROS_TAPD_FILTERS__`) wins over the declaration parser.
 */
export function parseScrapedConditions(text: string, kind: FilterSchemeKind): FilterCondition[] {
  const hook = /__VSSAROS_TAPD_FILTERS__\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text)
  if (hook) {
    try {
      const parsed = JSON.parse(hook[1] ?? '{}') as { conditions?: unknown }
      const found = z.array(FilterConditionSchema).safeParse(parsed.conditions)
      if (found.success && found.data.length) return found.data
    } catch { /* fall through to the declaration parser */ }
  }
  const out: FilterCondition[] = []
  const seen = new Set<string>()
  const pattern = /\{\s*field\s*:\s*'([^']+)'\s*,\s*op\s*:\s*'([^']+)'/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const field = (match[1] ?? '').trim(), op = (match[2] ?? '').trim(), key = `${field}|${op}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(FilterConditionSchema.parse({ field, op, enabled: true, value: [] }))
  }
  // `bugview.js` puts the priority/label pair in an OR subgroup; keep the same shape when scraped.
  if (kind === 'bug') for (const condition of out) {
    if (condition.field === '优先级' || /OR/.test(condition.field)) condition.group = 'or1'
  }
  return out
}

/**
 * Executed inside a real browser tab (CDP `Runtime.evaluate`), this reads the *rendered* filter card:
 * field, operator, value chips / datetime range, the per-row switch and the OR subgroup. Static HTML
 * cannot carry any of these, because both platform pages build the card with JavaScript at runtime.
 */
export const CDP_DOM_EXPRESSION = `JSON.stringify(${TAPD_FILTER_READ_EXPRESSION})`

const DomRowSchema = z.object({ field: z.string().trim().min(1), op: z.string().trim().min(1),
  values: z.array(z.string()).default([]), range: z.array(z.string()).default([]),
  enabled: z.boolean().default(true), group: z.string().trim().optional() })
const OP_LABEL: Record<string, string> = { in: '属于 (In)', notin: '不属于 (Not In)', like: '包含 (Like)',
  notlike: '不包含 (Not Like)', range: '介于 (Range)', note: '固定' }

/** Normalises the rendered DOM rows into the same condition contract as the static scraper. */
export function parseDomConditions(raw: unknown): FilterCondition[] {
  const parsed = z.array(DomRowSchema).safeParse(raw)
  if (!parsed.success) return []
  return parsed.data.map(row => FilterConditionSchema.parse({
    field: row.field, op: OP_LABEL[row.op] ?? row.op, enabled: row.enabled,
    value: normaliseOp(OP_LABEL[row.op] ?? row.op) === 'range' ? conditionRange(row.range.length ? row.range : row.values) : row.values,
    ...row.group ? { group: row.group } : {},
  }))
}

/** Built-in baseline, used when the platform pages cannot be reached or declare no conditions. */
export function fallbackConditions(kind: FilterSchemeKind): FilterCondition[] {
  const rows = kind === 'story' ? [
    { field: '发布计划', op: '属于 (In)', value: ['PC-RushCBT3'] },
    { field: '处理人', op: '属于 (In)', value: [] },
    { field: '状态', op: '属于 (In)', value: ['新建', '开发中'] },
    { field: '标签', op: '不属于 (Not In)', value: ['CBT3移除', '延期合入'] },
    { field: '预计完成时间', op: '介于 (Range)', value: { ...STORY_DUE_DEFAULT } },
  ] : [
    { field: '发布计划', op: '属于 (In)', value: ['PC-RushCBT3'] },
    { field: '优先级', op: '属于 (In)', value: ['紧急', '高', '中', '低'], group: 'or1' },
    { field: '标签（OR 口径）', op: '属于 (In)', value: ['必修bug'], group: 'or1' },
    { field: '所属分支', op: '属于 (In)', value: ['release', 'Beta_Test'] },
    { field: '状态（属于）', op: '属于 (In)', value: ['新建', '修复中', '重新打开'] },
    { field: '状态（不属于）', op: '不属于 (Not In)', value: ['挂起'] },
    { field: '处理人', op: '属于 (In)', value: [] },
    { field: '标题', op: '不包含 (Not Like)', value: ['【Crash】', '【XScan】'] },
    { field: '创建时间', op: '介于 (Range)', value: { from: '', to: '' } },
  ]
  return rows.map(row => FilterConditionSchema.parse({ ...row, enabled: true }))
}

/**
 * Every owner condition becomes the current user's TOF account and is locked. If the page had no
 * owner row, one is added, so a scheme always narrows work to the person using this Host.
 */
export function applyOwnerOverride(conditions: FilterCondition[], owner: string): FilterCondition[] {
  const list = conditions.map(condition => condition.field === '处理人' || condition.field === '修复人'
    ? { ...condition, value: owner ? [owner] : [], enabled: true, locked: true } : condition)
  if (!owner || list.some(condition => condition.field === '处理人')) return list
  list.push(FilterConditionSchema.parse({ field: '处理人', op: '属于 (In)', value: [owner], enabled: true, locked: true }))
  return list
}

export interface SchemeBranch { query: Record<string, string>; local: LocalRule[] }
export interface SchemeCompileOptions extends CompileOptions { releaseIds?: Record<string, string> }

/** Compile OR groups as branch queries; their union must be filtered and deduplicated before intake. */
export function compileSchemeBranches(scheme: TapdFilterScheme, options: SchemeCompileOptions = {}): SchemeBranch[] {
  const active = scheme.conditions.filter(condition => condition.enabled)
  const owner = active.find(condition => /^(处理人|修复人)$/.test(condition.field) &&
    Array.isArray(condition.value) && condition.value.some(value => value.trim()))
  if (!owner) throw new Error('处理人条件缺失，拒绝宽口径查询')
  const groups = new Map<string, FilterCondition[]>()
  const common: FilterCondition[] = []
  for (const condition of active) {
    if (condition.group && condition !== owner) groups.set(condition.group, [...(groups.get(condition.group) ?? []), condition])
    else common.push(condition)
  }
  let branches = [common]
  for (const group of groups.values()) {
    branches = branches.flatMap(branch => group.map(condition => [...branch, condition]))
    if (branches.length > 16) throw new Error('OR 条件组合超过 16，请收窄方案')
  }
  return branches.map(conditions => {
    const query: Record<string, string> = {}, local: LocalRule[] = []
    for (const condition of conditions) {
      const field = condition.field.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
      const op = normaliseOp(condition.op)
      if (op === 'range' || !Array.isArray(condition.value)) {
        const range = Array.isArray(condition.value) ? { from: condition.value[0] ?? '', to: condition.value[1] ?? '' } : condition.value
        if (!range.from && !range.to) continue
        const format = (value: string) => {
          const normalized = filterDateTime(value)
          if (!normalized) throw new Error(`${field}时间格式无效：${value}`)
          return normalized.replace('T', ' ') + (normalized.length === 16 ? ':00' : '')
        }
        if (!['创建时间', '预计完成时间'].includes(field)) throw new Error(`不支持的时间字段：${field}`)
        const from = format(range.from || '1970-01-01T00:00'), to = format(range.to || '2099-12-31T23:59')
        if (from > to) throw new Error(`${field}开始时间不能晚于结束时间`)
        query[field === '创建时间' ? 'created' : 'due'] = `${from}~${to}`
        continue
      }
      let values = condition.value.filter(value => value.trim())
      if (!values.length) throw new Error(`${field}没有取值，请配置或停用此条件`)
      if (field === '发布计划') {
        values = values.map(value => /^\d+$/.test(value) ? value : options.releaseIds?.[value] ?? '')
        if (values.some(value => !value)) throw new Error('发布计划名称未映射到 ID，请同步字典或填写发布计划 ID')
      }
      if (field === '标题' && op === 'in') { query.title = `CONTAINS_OR<${values.join('|')}>`; continue }
      if (op === 'not_in' && !['标签', '状态'].includes(field)) throw new Error(`${field}暂不支持排除操作，未进行查询`)
      const result = importTapdFilter({ conditions: [{ ...condition, field: field === '修复人' ? '处理人' : condition.field, value: values }] }, options)
      if (result.warnings.length) throw new Error(result.warnings.join('；'))
      Object.assign(query, result.query)
      local.push(...result.local)
    }
    if (scheme.kind === 'story' && query.current_owner) { query.owner = query.current_owner; delete query.current_owner }
    return { query, local }
  })
}

export function compileScheme(scheme: TapdFilterScheme, options: SchemeCompileOptions = {}): SchemeBranch {
  return compileSchemeBranches(scheme, options)[0]!
}

/** Same URL shape as `itemPage(site, {type,workspace,id})`; the pool's title links point here. */
export function ticketUrl(site: string, workspace: string, item: Pick<PoolItem, 'kind' | 'id'>): string {
  const page = item.kind === 'bug' ? 'bugtrace/bugs/view' : 'prong/stories/view'
  return `${site.replace(/\/$/, '')}/${workspace}/${page}/${item.id}`
}

/** Scraped candidates are merged, never duplicated; existing enable/state/runId always survive. */
export function mergeIntoPool(pool: TapdFilterPool, candidates: readonly PoolItem[]): TapdFilterPool {
  const byId = new Map(pool.items.map(item => [`${item.kind}:${item.id}`, { ...item }]))
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.id}`, known = byId.get(key)
    byId.set(key, known ? { ...known, title: candidate.title, priority: candidate.priority, status: candidate.status,
      scheme: candidate.scheme, hit: candidate.hit } : PoolItemSchema.parse({ ...candidate, enabled: false, state: 'pending' }))
  }
  return { ...pool, items: [...byId.values()] }
}

export function togglePoolItem(pool: TapdFilterPool, id: string, enabled: boolean): TapdFilterPool {
  return { ...pool, items: pool.items.map(item => item.id === id ? { ...item, enabled } : item) }
}

export const localDay = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

/** A daily run is due once per local day, at or after `at`, only while auto processing is on. */
export function poolDue(pool: TapdFilterPool, now: Date): boolean {
  if (!pool.autoProcess || pool.lastRun === localDay(now)) return false
  const minute = now.getHours() * 60 + now.getMinutes()
  const [hour = 0, minutePart = 0] = pool.at.split(':').map(Number)
  return minute >= hour * 60 + minutePart
}

export interface PoolRun { runId: string; day: string; items: PoolItem[]; capped: boolean }
/** Plans enabled pending/failed items, bounded by `maxPerRun`; `runId` makes retries idempotent. */
export function planPoolRun(pool: TapdFilterPool, now = new Date()): PoolRun {
  const day = localDay(now)
  const eligible = pool.items.filter(item => item.enabled && (item.state === 'pending' || item.state === 'failed' && item.retryable !== false))
  const items = eligible.slice(0, pool.maxPerRun)
  return { runId: `${day}-${schemeHash(items.map(item => ({ field: item.id, op: '', enabled: true, value: [], locked: false })))}`,
    day, items, capped: eligible.length > items.length }
}

/** Marks a planned run as queued (called before dispatch) and records it as today's run. */
export function startPoolRun(pool: TapdFilterPool, run: PoolRun): TapdFilterPool {
  if (pool.lastRun === run.day) return pool
  const ids = new Set(run.items.map(item => item.id))
  return { ...pool, lastRun: run.day,
    items: pool.items.map(item => ids.has(item.id)
      ? { ...item, state: 'queued', runId: run.runId, attempts: item.attempts + 1 } : item) }
}

/** Applies a run's outcome; only items belonging to that `runId` move, so a late retry is harmless. */
export function applyRunResult(pool: TapdFilterPool, runId: string, ok: boolean, at: string): TapdFilterPool {
  let done = 0
  const items = pool.items.map(item => {
    // A repeated outcome for the same run must not count or move an item twice.
    if (item.runId !== runId || item.state === 'done') return item
    const state: PoolState = ok ? 'done' : 'failed'
    if (ok) done++
    return { ...item, state, lastRunAt: at }
  })
  return { ...pool, items, processedToday: pool.processedToday + done }
}
