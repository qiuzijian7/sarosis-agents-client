/** Current TOF identity -> a unique TAPD owner. Only exact authoritative keys or a person's confirmation qualify. */
import type { Key } from '../kv.ts'
import { KV } from '../kv.ts'
import type { TapdApi, TapdConfig } from './tapd-api.ts'
import { cleanOwner, resolveTapdName } from './tapd-members.ts'

export interface TapdUserIdentity {
  signedIn: boolean; loginName: string; userId?: string; staffId?: string; email?: string
  stale?: boolean; expired?: boolean; hasCredential?: boolean
}
export interface TapdDirectoryMember { user: string; name: string; email?: string; staffId?: string; loginName?: string }
export interface TapdIdentityRecord {
  loginName: string; userId: string; staffId: string; tapdName: string
  source: 'automatic' | 'confirmed'; matchedBy: 'account' | 'staffId' | 'email' | 'confirmation'
  at: string; expiresAt: string; invalidated?: boolean
}
export interface TapdIdentityView {
  signedIn: boolean; loginName: string; staffId: string; workspace: string
  status: 'resolved' | 'unmatched' | 'ambiguous' | 'unavailable'
  tapdName: string; source: 'manual' | 'automatic' | 'confirmed' | 'none'
  matchedBy?: TapdIdentityRecord['matchedBy']; cached: boolean; message: string
}
export interface IdentityState {
  get<T>(key: Key<T>): T | undefined
  set<T>(key: Key<T>, value: T): void
}
const normalized = (value?: string) => cleanOwner(value ?? '').toLowerCase()
const scope = (config: Pick<TapdConfig, 'workspace' | 'api'>, loginName: string) =>
  JSON.stringify([config.api.replace(/\/$/, ''), config.workspace, normalized(loginName)])
export const identityKey = (config: Pick<TapdConfig, 'workspace' | 'api'>, loginName: string) => KV.tapd.identity(scope(config, loginName))
const validIdentity = (identity: TapdUserIdentity) => identity.signedIn === true && typeof identity.loginName === 'string' && !!identity.loginName.trim()
  && !identity.stale && !identity.expired && identity.hasCredential !== false
const samePerson = (record: TapdIdentityRecord, identity: TapdUserIdentity) => normalized(record.loginName) === normalized(identity.loginName)
  && record.userId === (identity.userId ?? '') && record.staffId === (identity.staffId ?? '')
const uniqueMembers = (rows: readonly TapdDirectoryMember[]) => [...new Map(rows.filter(row => cleanOwner(row.user))
  .map(row => [normalized(row.user), row])).values()]

export function matchTapdIdentity(identity: Pick<TapdUserIdentity, 'loginName' | 'staffId' | 'email'>, members: readonly TapdDirectoryMember[]) {
  const rows = members.filter(row => cleanOwner(row.user))
  const criteria: { by: 'staffId' | 'email' | 'account'; matches: TapdDirectoryMember[] }[] = [
    { by: 'staffId', matches: identity.staffId ? rows.filter(row => row.staffId === identity.staffId) : [] },
    { by: 'email', matches: identity.email ? rows.filter(row => normalized(row.email) === normalized(identity.email)) : [] },
    { by: 'account', matches: rows.filter(row => [row.user, row.loginName].some(value => normalized(value) === normalized(identity.loginName))) },
  ]
  const matched = criteria.filter(criterion => criterion.matches.length)
  const owners = uniqueMembers(matched.flatMap(criterion => criterion.matches))
  if (!owners.length) return { status: 'unmatched' as const }
  if (owners.length !== 1) return { status: 'ambiguous' as const }
  return { status: 'resolved' as const, tapdName: cleanOwner(owners[0]!.user), matchedBy: matched[0]!.by }
}

/** Only valid, scoped cached owner names are used by a person's saved daily schedule. Static overrides always win. */
export function cachedTapdName(config: TapdConfig, state: Pick<IdentityState, 'get'>, loginName: string, now = new Date()): string {
  const explicit = [...new Set(config.members.filter(row => normalized(row.alias) === normalized(loginName)).map(row => cleanOwner(row.name)))]
  if (explicit.length) return explicit.length === 1 ? explicit[0]! : ''
  const manual = resolveTapdName(loginName, config.members)
  if (normalized(manual) !== normalized(loginName)) return manual
  const record = state.get(identityKey(config, loginName))
  return record && !record.invalidated && Date.parse(record.expiresAt) > now.getTime() ? record.tapdName : ''
}

/** Saved schedules may renew only the same previously verified owner, never acquire a new mapping unattended. */
export async function scheduledTapdName(config: TapdConfig, api: Pick<TapdApi, 'directoryMembers'>, state: IdentityState,
  loginName: string, now = new Date()): Promise<string> {
  const cached = cachedTapdName(config, state, loginName, now)
  if (cached) return cached
  if (config.members.some(row => normalized(row.alias) === normalized(loginName))) return ''
  const key = identityKey(config, loginName), record = state.get(key)
  if (!record || record.invalidated || !api.directoryMembers) return ''
  let rows: TapdDirectoryMember[]
  try { rows = await api.directoryMembers(config.workspace) } catch { return '' }
  if (rows.length >= 2000) return ''
  const matched = record.source === 'confirmed'
    ? uniqueMembers(rows.filter(row => normalized(row.user) === normalized(record.tapdName))).length === 1
    : (() => {
      const result = matchTapdIdentity({ loginName: record.loginName, staffId: record.staffId }, rows)
      return result.status === 'resolved' && normalized(result.tapdName) === normalized(record.tapdName)
    })()
  if (!matched) { state.set(key, { ...record, invalidated: true, expiresAt: now.toISOString() }); return '' }
  state.set(key, { ...record, at: now.toISOString(), expiresAt: new Date(now.getTime() + (record.source === 'confirmed' ? 30 : 1) * 86400_000).toISOString() })
  return record.tapdName
}

export async function resolveTapdIdentity(config: TapdConfig, api: Pick<TapdApi, 'directoryMembers'>,
  state: IdentityState, identity: TapdUserIdentity, options: { fresh?: boolean; confirmName?: string; now?: Date } = {}): Promise<TapdIdentityView> {
  const now = options.now ?? new Date()
  const base: TapdIdentityView = { signedIn: validIdentity(identity), loginName: identity.loginName || '', staffId: identity.staffId ?? '',
    workspace: config.workspace, status: 'unavailable', tapdName: '', source: 'none', cached: false,
    message: '企业身份不可用或已过期，请重新登录后重试' }
  if (!validIdentity(identity)) return base
  const key = identityKey(config, identity.loginName)
  const saved = state.get(key)
  const invalidate = () => { if (saved) state.set(key, { ...saved, invalidated: true, expiresAt: now.toISOString() }) }
  const manual = config.members.filter(row => normalized(row.alias) === normalized(identity.loginName))
  const manualNames = [...new Set(manual.map(row => cleanOwner(row.name)))]
  if (manualNames.length) {
    if (options.confirmName !== undefined && (manualNames.length !== 1 || normalized(options.confirmName) !== normalized(manualNames[0])))
      return { ...base, status: 'ambiguous', message: '已存在手动映射，请先在高级设置修正；一次确认不会覆盖它' }
    return manualNames.length === 1 ? { ...base, status: 'resolved', tapdName: manualNames[0]!, source: 'manual', message: '使用已配置的手动映射' }
      : { ...base, status: 'ambiguous', message: '当前账号存在冲突的手动映射，请修正 members' }
  }
  if (!options.fresh && options.confirmName === undefined && saved && !saved.invalidated && samePerson(saved, identity) && Date.parse(saved.expiresAt) > now.getTime())
    return { ...base, status: 'resolved', tapdName: saved.tapdName, source: saved.source, matchedBy: saved.matchedBy, cached: true, message: '已复用此用户在当前项目的映射' }
  if (!api.directoryMembers) { invalidate(); return { ...base, message: 'TAPD 成员目录能力不可用，请重试或配置手动映射' } }
  let rows: TapdDirectoryMember[]
  try { rows = await api.directoryMembers(config.workspace) }
  catch { invalidate(); return { ...base, message: 'TAPD 成员目录读取失败，请检查接入状态后重试；未放宽处理人条件' } }
  if (rows.length >= 2000) { invalidate(); return { ...base, message: '成员目录达到读取上限，无法可靠判断唯一性；请配置手动映射' } }
  const confirmation = options.confirmName ?? (saved && samePerson(saved, identity) && saved.source === 'confirmed' ? saved.tapdName : undefined)
  const result = confirmation !== undefined ? (() => {
    const matches = uniqueMembers(rows.filter(row => normalized(row.user) === normalized(confirmation) || normalized(row.name) === normalized(confirmation)))
    return matches.length === 1 ? { status: 'resolved' as const, tapdName: cleanOwner(matches[0]!.user), matchedBy: 'confirmation' as const }
      : { status: matches.length ? 'ambiguous' as const : 'unmatched' as const }
  })() : matchTapdIdentity(identity, rows)
  if (result.status !== 'resolved') {
    invalidate()
    return { ...base, status: result.status,
      message: result.status === 'ambiguous' ? '匹配到多个 TAPD 用户，不能自动选取；请确认准确的 TAPD 用户名'
        : confirmation !== undefined ? '该名称不在当前项目成员目录中，请填写准确的 TAPD 用户名'
          : '账号/工号/完整邮箱未能唯一匹配，请确认一次 TAPD 用户名；系统不会猜中文姓名' }
  }
  const source = result.matchedBy === 'confirmation' ? 'confirmed' as const : 'automatic' as const
  const record: TapdIdentityRecord = { loginName: identity.loginName, userId: identity.userId ?? '', staffId: identity.staffId ?? '',
    tapdName: result.tapdName, source, matchedBy: result.matchedBy, at: now.toISOString(),
    expiresAt: new Date(now.getTime() + (source === 'confirmed' ? 30 : 1) * 86400_000).toISOString() }
  state.set(key, record)
  return { ...base, status: 'resolved', tapdName: result.tapdName, source, matchedBy: result.matchedBy,
    message: source === 'confirmed' ? '已确认，后续在当前项目自动复用' : '已通过 TAPD 成员目录精确匹配' }
}
