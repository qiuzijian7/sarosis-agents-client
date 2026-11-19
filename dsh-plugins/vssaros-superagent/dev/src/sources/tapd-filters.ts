/**
 * Imports the filter export of the Saroasis platform's bug page (`/bug/client.html`) and compiles it into
 * TAPD Open API query fields plus a small set of local rules. Field names, enum values and query syntax were
 * verified with read-only /bugs/count and /bugs/custom_fields_settings probes against workspace 68880148.
 *
 * The export's `conditions` are display-oriented (Chinese field names and values); `state` carries the internal
 * IDs and English priority codes. Compilation never silently drops a condition: every one appears in `report`.
 */
import { z } from 'zod'
import type { TapdItem, TapdWatch } from './tapd-api.ts'

const Condition = z.object({
  field: z.string().trim().min(1), op: z.string().trim().min(1), enabled: z.boolean().default(true),
  value: z.union([z.array(z.string()), z.object({ from: z.string(), to: z.string() })]).default([]),
}).passthrough()
export const TapdFilterExportSchema = z.object({
  source: z.string().optional(), page: z.string().optional(), url: z.string().optional(),
  exportedAt: z.string().optional(), conditions: z.array(Condition).min(1),
  state: z.record(z.string(), z.unknown()).optional(),
}).passthrough()
export type TapdFilterExport = z.infer<typeof TapdFilterExportSchema>

/** A condition that TAPD's query syntax cannot express: applied to each fetched item by the Host. */
export const LocalRuleSchema = z.object({
  field: z.enum(['title', 'label', 'owner', 'status']), op: z.enum(['not_like', 'not_in', 'in']), values: z.array(z.string()),
}).strict()
export type LocalRule = z.infer<typeof LocalRuleSchema>
export const ReportSchema = z.object({
  field: z.string(), op: z.string(), enabled: z.boolean(), target: z.enum(['api', 'local', 'skipped', 'manual']),
  detail: z.string(),
}).strict()
export type FilterReport = z.infer<typeof ReportSchema>

/** One daily sweep. `query` is sent to /bugs; `local` filters the returned items before they are dispatched. */
export const TapdFilterScheduleSchema = z.object({
  name: z.string().trim().regex(/^[\w.-]{1,40}$/),
  enabled: z.boolean().default(false),
  /** Local HH:MM; the poll loop dispatches once per calendar day at or after this time. */
  /** Local HH:MM; default is the small-hours low-traffic window (avoids the 00:00 day rollover and service warm-up). */
  at: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('02:00'),
  /** Hard cap of dispatched items per run, so a broad filter cannot create thousands of tickets. */
  maxPerRun: z.number().int().min(1).max(200).default(20),
  /** Only items modified within this many days are considered; the export's created range may span decades. */
  windowDays: z.number().int().min(1).max(30).default(2),
  query: z.record(z.string(), z.string()).default({}),
  local: z.array(LocalRuleSchema).default([]),
  report: z.array(ReportSchema).default([]),
  page: z.string().default(''), exportedAt: z.string().default(''),
}).strict()
export type TapdFilterSchedule = z.infer<typeof TapdFilterScheduleSchema>

/** Fallbacks for an offline import; a live Host resolves both maps from the workspace's own configuration. */
export const FIELD_NAMES_FALLBACK: Record<string, string> = {
  所属分支: 'custom_field_10', 是否必现: 'custom_field_7', Bug类型: 'custom_field_19', BUG类型: 'custom_field_19',
}
export const STATUS_CODES_FALLBACK: Record<string, string> = {
  新建: 'new', 修复中: 'in_progress', 已修复: 'resolved', 分支验证完成: 'status_6', 验收完成: 'verified',
  主干待回归: 'rejected', 主干验收完成: 'status_9', 重新打开: 'reopened', 已完成: 'closed',
  无效关闭: 'status_1', 挂起: 'suspended', 分支待回归: 'status_8',
}
export interface CompileOptions {
  fieldNames?: Record<string, string>
  statusCodes?: Record<string, string>
  /** Group name -> TAPD person names; the export's owner condition is a group, not an account. */
  ownerGroups?: Record<string, string[]>
  at?: string
  maxPerRun?: number
  windowDays?: number
  name?: string
}
export interface CompiledFilter {
  query: Record<string, string>
  local: LocalRule[]
  report: FilterReport[]
  warnings: string[]
  schedule: TapdFilterSchedule
  watch: TapdWatch
}
const valuesOf = (condition: TapdFilterExport['conditions'][number]): string[] =>
  (Array.isArray(condition.value) ? condition.value : []).map(value => value.trim()).filter(Boolean)
const rangeOf = (condition: TapdFilterExport['conditions'][number]) =>
  !Array.isArray(condition.value) ? condition.value : undefined
/** TAPD time fields take `YYYY-MM-DD HH:mm:ss`, while the export writes `YYYY-MM-DDTHH:mm`. */
const tapdTime = (value: string): string => /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value)
  ? `${value.slice(0, 10)} ${value.slice(11, 16)}:00` : value
const opOf = (raw: string): 'in' | 'not_in' | 'not_like' | 'range' =>
  /不属于|not in/i.test(raw) ? 'not_in' : /不包含|not like/i.test(raw) ? 'not_like'
    : /介于|range/i.test(raw) ? 'range' : 'in'
/** Strips a parenthesised qualifier such as 状态（属于） or 标签（OR 口径）. */
const nameOf = (raw: string): string => raw.replace(/（[^）]*）|\([^)]*\)/g, '').trim()

/** Turns the display-oriented export into API fields, local rules and a per-condition report. */
export function importTapdFilter(input: unknown, options: CompileOptions = {}): CompiledFilter {
  const parsed = TapdFilterExportSchema.parse(input)
  const fieldNames = { ...FIELD_NAMES_FALLBACK, ...options.fieldNames }
  const statusCodes = { ...STATUS_CODES_FALLBACK, ...options.statusCodes }
  const ownerGroups = options.ownerGroups ?? {}
  const query: Record<string, string> = {}
  const local: LocalRule[] = []
  const report: FilterReport[] = []
  const warnings: string[] = []
  const releases = Array.isArray(parsed.state?.releases)
    ? (parsed.state.releases as unknown[]).map(String).filter(Boolean) : []
  const say = (condition: TapdFilterExport['conditions'][number], target: FilterReport['target'], detail: string) =>
    report.push({ field: condition.field, op: condition.op, enabled: condition.enabled, target, detail })

  for (const condition of parsed.conditions) {
    const op = opOf(condition.op), name = nameOf(condition.field), values = valuesOf(condition)
    if (!condition.enabled) { say(condition, 'skipped', '导出时已禁用，不参与筛选'); continue }
    if (op === 'range') {
      const range = rangeOf(condition)
      if (name === '创建时间' && range) {
        query.created = `${tapdTime(range.from)}~${tapdTime(range.to)}`
        say(condition, 'api', `created=${query.created}（TAPD 时间区间）`)
      } else say(condition, 'manual', '未知的时间区间字段，未生效')
      continue
    }
    if (!values.length) { say(condition, 'manual', '条件没有取值，未生效'); continue }
    switch (name) {
      case '发布计划': {
        // conditions holds the display name; state.releases holds the numeric release_id TAPD queries by.
        const ids = releases.length ? releases : values.filter(value => /^\d+$/.test(value))
        if (ids.length) { query.release_id = ids.join('|'); say(condition, 'api', `release_id=${query.release_id}（发布计划 ID）`) }
        else say(condition, 'manual', '只有发布计划名称，导出里没有对应 ID，未生效')
        break
      }
      case '优先级':
        query.priority_label = values.join('|')
        say(condition, 'api', `priority_label=${query.priority_label}（中文优先级，用 | 取枚举）`)
        break
      case '状态':
        if (op === 'not_in') {
          const codes = values.map(value => statusCodes[value] ?? value)
          if (codes.length > 1) {
            // TAPD's `<>` was verified for one value only; exclude several statuses locally instead.
            local.push({ field: 'status', op: 'not_in', values: codes })
            say(condition, 'local', `本地排除状态码 ${codes.join('、')}（中文名经 status_map 转义）`)
          } else {
            query.status = `<>${codes[0]}`
            say(condition, 'api', `status=<>${codes[0]}（状态中文名经 status_map 转义为状态码）`)
          }
        } else {
          query.v_status = values.join('|')
          say(condition, 'api', `v_status=${query.v_status}（TAPD 支持中文状态名）`)
        }
        break
      case '标签':
        if (op === 'not_in') {
          local.push({ field: 'label', op: 'not_in', values })
          say(condition, 'local', `本地排除标签 ${values.join('、')}；TAPD 的 label=<> 会连无标签单子一起排除，语义不等价`)
        } else if (/OR/.test(condition.op) || /OR/.test(condition.field)) {
          query.label = `CONTAINS_OR<${values.join('|')}>`
          say(condition, 'api', `label=${query.label}`)
        } else {
          query.label = values.join('|')
          say(condition, 'api', `label=${query.label}`)
        }
        break
      case '标题':
        if (op === 'not_like') {
          local.push({ field: 'title', op: 'not_like', values })
          say(condition, 'local', `本地排除标题含 ${values.join('、')} 的单子；TAPD 无 not-like，NOT_EQ 只排全等标题`)
        } else say(condition, 'manual', '不支持的标题操作符，未生效')
        break
      case '处理人': {
        const people = [...new Set(values.flatMap(value => ownerGroups[value] ?? (/\d+\s*\.\d+|组/.test(value) ? [] : [value])))]
        if (people.length) {
          query.current_owner = `USER_OR<${people.join('|')}>`
          say(condition, 'api', `current_owner=USER_OR<${people.join('|')}>${values.some(value => ownerGroups[value]) ? '（组名经成员映射展开）' : ''}`)
        } else {
          say(condition, 'manual', `「${values.join('、')}」是组名，TAPD 的 current_owner 存人名；请在「组成员映射」里补成员后重新导入，否则此条件不生效（不会缩小范围）`)
          warnings.push(`处理人条件「${values.join('、')}」未生效：缺少组成员映射。`)
        }
        break
      }
      default: {
        const field = fieldNames[name]
        if (!field) { say(condition, 'manual', `未识别的字段「${name}」，未生效`); break }
        const kept = values.filter(value => value !== '--')
        if (!kept.length) { say(condition, 'skipped', '取值只有空选项 --，无需筛选'); break }
        query[field] = kept.join('|')
        say(condition, 'api', `${field}=${query[field]}（自定义字段「${name}」）`)
      }
    }
  }
  for (const item of report.filter(entry => entry.target === 'manual'))
    warnings.push(`${item.field}：${item.detail}`)
  const name = options.name ?? 'filter-bug-1'
  const schedule = TapdFilterScheduleSchema.parse({ name, enabled: false, at: options.at ?? '02:00',
    maxPerRun: options.maxPerRun ?? 20, windowDays: options.windowDays ?? 2,
    query, local, report, page: parsed.page ?? '', exportedAt: parsed.exportedAt ?? '' })
  // The watch is a container for the sweep: it must not also poll every change, or a broad filter
  // would receive thousands of items outside the daily cap.
  const watch: TapdWatch = { name, workspace: '', type: 'bug', item: '', status: '', owner: '',
    iteration: '', mode: 'assigned', ...({ sweepOnly: true } as Partial<TapdWatch>) }
  return { query, local, report, warnings, schedule, watch }
}

/** Applies the local rules to one fetched item. `label` and `owner` come from the raw TAPD record. */
export function matchesLocal(item: TapdItem, rules: readonly LocalRule[]): boolean {
  const label = item.label ?? ''
  const labelValues = label.split(/[|;；,，]/).map(value => value.trim()).filter(Boolean)
  return rules.every(rule => {
    if (!rule.values.length) return true
    const values = rule.values.map(value => value.toLowerCase())
    if (rule.field === 'title') return rule.op === 'not_like'
      ? values.every(value => !item.title.toLowerCase().includes(value)) : values.some(value => item.title.toLowerCase().includes(value))
    if (rule.field === 'label') return rule.op === 'not_in'
      ? values.every(value => !labelValues.some(label => label.toLowerCase() === value) && !label.toLowerCase().includes(value))
      : values.some(value => labelValues.some(label => label.toLowerCase() === value))
    if (rule.field === 'status') return rule.op === 'not_in'
      ? values.every(value => item.status.toLowerCase() !== value) : values.some(value => item.status.toLowerCase() === value)
    const owners = item.owners.map(owner => owner.toLowerCase())
    return rule.op === 'in' ? values.some(value => owners.some(owner => owner.includes(value)))
      : values.every(value => !owners.some(owner => owner.includes(value)))
  })
}

/** Persisted per sweep: the last local day it ran, and bounded IDs of items already dispatched. */
export interface TapdSweepState {
  lastRun: string
  seen: string[]
  /** Last run's numbers, shown in the panel so a broad filter is visible. */
  scanned: number
  matched: number
  dispatched: number
  at: string
}
/** Keep the dedupe list bounded; a daily cap of 200 needs far less than this history. */
export const SEEN_LIMIT = 2000

/** A schedule is due when it is enabled, its local HH:MM has passed, and it has not run today. */
export function sweepDue(schedule: TapdFilterSchedule, now: Date, lastRun?: string): boolean {
  if (!schedule.enabled) return false
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (lastRun === day) return false
  const minute = now.getHours() * 60 + now.getMinutes()
  const [hour = 0, minutePart = 0] = schedule.at.split(':').map(Number)
  return minute >= hour * 60 + minutePart
}
export const localDay = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
