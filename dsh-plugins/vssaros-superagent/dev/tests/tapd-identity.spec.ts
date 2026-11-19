import { describe, expect, it, vi } from 'vitest'
import { TapdConfigSchema } from '../src/sources/tapd-api.ts'
import { cachedTapdName, identityKey, matchTapdIdentity, resolveTapdIdentity, scheduledTapdName, type IdentityState, type TapdDirectoryMember, type TapdUserIdentity } from '../src/sources/tapd-identity.ts'

const user: TapdUserIdentity = { signedIn: true, loginName: 'alice', userId: 'u1', staffId: '123', hasCredential: true }
const now = new Date('2026-11-18T08:00:00Z')
function fixture(rows: TapdDirectoryMember[] = []) {
  const values = new Map<string, unknown>()
  const state: IdentityState = { get: key => values.get(key) as never, set: (key, value) => { values.set(key, value) } }
  const api = { directoryMembers: vi.fn(async () => rows) }
  const config = TapdConfigSchema.parse({})
  return { values, state, api, config }
}

describe('safe automatic TAPD identity', () => {
  it('matches exact account, staff ID or complete verified email, never a guessed email prefix', () => {
    expect(matchTapdIdentity(user, [{ user: 'Alice', name: 'Alice' }])).toMatchObject({ status: 'resolved', matchedBy: 'account', tapdName: 'Alice' })
    expect(matchTapdIdentity(user, [{ user: '甲', name: '甲', staffId: '123' }])).toMatchObject({ status: 'resolved', matchedBy: 'staffId', tapdName: '甲' })
    expect(matchTapdIdentity({ ...user, email: 'alice@example.test' }, [{ user: '甲', name: '甲', email: 'Alice@example.test' }])).toMatchObject({ status: 'resolved', matchedBy: 'email' })
    expect(matchTapdIdentity(user, [{ user: '甲', name: '甲', email: 'alice@example.test' }])).toEqual({ status: 'unmatched' })
    expect(matchTapdIdentity(user, [{ user: '甲', name: 'alice' }])).toEqual({ status: 'unmatched' })
  })
  it('rejects conflicting authoritative keys and duplicate accounts', () => {
    expect(matchTapdIdentity({ ...user, email: 'alice@example.test' }, [
      { user: '甲', name: '甲', staffId: '123' }, { user: '乙', name: '乙', email: 'alice@example.test' }])).toEqual({ status: 'ambiguous' })
    expect(matchTapdIdentity(user, [{ user: '甲', name: '甲', loginName: 'alice' }, { user: '乙', name: '乙', loginName: 'alice' }])).toEqual({ status: 'ambiguous' })
  })
  it('automatically remembers a unique match, returns no contacts and reuses it across reloads', async () => {
    const h = fixture([{ user: '甲;', name: '甲', staffId: '123', email: 'secret@example.test' }])
    const first = await resolveTapdIdentity(h.config, h.api, h.state, user, { now })
    expect(first).toMatchObject({ status: 'resolved', source: 'automatic', tapdName: '甲', cached: false })
    const second = await resolveTapdIdentity(h.config, h.api, h.state, user, { now })
    expect(second.cached).toBe(true); expect(h.api.directoryMembers).toHaveBeenCalledOnce()
    expect(JSON.stringify(first)).not.toContain('secret@example.test')
    expect(JSON.stringify([...h.values.values()])).not.toContain('secret@example.test')
    expect(cachedTapdName(h.config, h.state, 'alice', now)).toBe('甲')
  })
  it('isolates caches by user, API, workspace and immutable enterprise identity', async () => {
    const h = fixture([{ user: '甲', name: '甲', staffId: '123' }])
    await resolveTapdIdentity(h.config, h.api, h.state, user, { now })
    h.api.directoryMembers.mockResolvedValue([])
    expect((await resolveTapdIdentity(h.config, h.api, h.state, { ...user, staffId: '456' }, { now })).status).toBe('unmatched')
    expect((await resolveTapdIdentity(h.config, h.api, h.state, { ...user, loginName: 'bob', staffId: '456' }, { now })).status).toBe('unmatched')
    expect((await resolveTapdIdentity({ ...h.config, workspace: '100' }, h.api, h.state, user, { now })).status).toBe('unmatched')
    expect(identityKey({ ...h.config, api: 'https://other.test' }, 'alice')).not.toBe(identityKey(h.config, 'alice'))
  })
  it('explicit configured mappings win and conflicting manual mappings fail closed', async () => {
    const h = fixture([{ user: 'auto', name: 'auto', staffId: '123' }])
    h.config.members = [{ alias: 'Alice', name: '手动甲' }]
    expect(await resolveTapdIdentity(h.config, h.api, h.state, user, { now })).toMatchObject({ source: 'manual', tapdName: '手动甲' })
    expect(h.api.directoryMembers).not.toHaveBeenCalled()
    h.config.members.push({ alias: 'alice', name: '手动乙' })
    expect((await resolveTapdIdentity(h.config, h.api, h.state, user, { now })).status).toBe('ambiguous')
  })
  it('refuses signed-out, expired, stale and credential-less identities without reading the directory', async () => {
    const h = fixture([{ user: 'alice', name: 'Alice' }])
    for (const identity of [{ ...user, signedIn: false }, { ...user, stale: true }, { ...user, expired: true }, { ...user, hasCredential: false }])
      expect((await resolveTapdIdentity(h.config, h.api, h.state, identity, { now })).status).toBe('unavailable')
    expect(h.api.directoryMembers).not.toHaveBeenCalled(); expect(h.values.size).toBe(0)
  })
  it('asks once for an unmatched name and remembers the unique directory-validated confirmation', async () => {
    const h = fixture([{ user: 'TAPD甲;', name: '甲' }])
    expect((await resolveTapdIdentity(h.config, h.api, h.state, user, { now })).status).toBe('unmatched')
    expect(await resolveTapdIdentity(h.config, h.api, h.state, user, { confirmName: '甲', now })).toMatchObject({ source: 'confirmed', tapdName: 'TAPD甲' })
    expect((await resolveTapdIdentity(h.config, h.api, h.state, user, { now })).cached).toBe(true)
    expect(cachedTapdName(h.config, h.state, 'alice', now)).toBe('TAPD甲')
  })
  it('rejects nonexistent and same-display-name confirmations without storing arbitrary names', async () => {
    const h = fixture([{ user: 'a1', name: '重名' }, { user: 'a2', name: '重名' }])
    expect((await resolveTapdIdentity(h.config, h.api, h.state, user, { confirmName: '不存在', now })).status).toBe('unmatched')
    expect((await resolveTapdIdentity(h.config, h.api, h.state, user, { confirmName: '重名', now })).status).toBe('ambiguous')
    expect(h.values.size).toBe(0)
    expect((await resolveTapdIdentity(h.config, h.api, h.state, user, { confirmName: 'a1', now })).tapdName).toBe('a1')
  })
  it('revalidates expired or forced-refresh cache, does not silently reuse revoked members on failure', async () => {
    const h = fixture([{ user: '甲', name: '甲', staffId: '123' }])
    await resolveTapdIdentity(h.config, h.api, h.state, user, { now })
    h.api.directoryMembers.mockResolvedValue([])
    expect((await resolveTapdIdentity(h.config, h.api, h.state, user, { fresh: true, now })).status).toBe('unmatched')
    expect(cachedTapdName(h.config, h.state, 'alice', now)).toBe('')
    const tomorrow = new Date(now.getTime() + 86400_001)
    expect(cachedTapdName(h.config, h.state, 'alice', tomorrow)).toBe('')
    expect((await resolveTapdIdentity(h.config, h.api, h.state, user, { now: tomorrow })).status).toBe('unmatched')
  })
  it('renews a natural expiry for the same confirmed owner without asking the user again', async () => {
    const h = fixture([{ user: '甲', name: '甲' }])
    await resolveTapdIdentity(h.config, h.api, h.state, user, { confirmName: '甲', now })
    const later = new Date(now.getTime() + 31 * 86400_000)
    expect(await scheduledTapdName(h.config, h.api, h.state, 'alice', later)).toBe('甲')
    expect(cachedTapdName(h.config, h.state, 'alice', later)).toBe('甲')
    h.api.directoryMembers.mockResolvedValue([])
    expect(await scheduledTapdName(h.config, h.api, h.state, 'alice', new Date(later.getTime() + 31 * 86400_000))).toBe('')
  })
  it('does not acquire a different owner or renew invalidated mappings in an unattended run', async () => {
    const h = fixture([{ user: '甲', name: '甲', staffId: '123' }])
    await resolveTapdIdentity(h.config, h.api, h.state, user, { now })
    h.api.directoryMembers.mockResolvedValue([{ user: '乙', name: '乙', staffId: '123' }])
    expect(await scheduledTapdName(h.config, h.api, h.state, 'alice', new Date(now.getTime() + 86400_001))).toBe('')
    h.api.directoryMembers.mockClear()
    expect(await scheduledTapdName(h.config, h.api, h.state, 'alice', new Date(now.getTime() + 2 * 86400_000))).toBe('')
    expect(h.api.directoryMembers).not.toHaveBeenCalled()
  })
  it('reports unavailable directory and treats truncation as unsafe', async () => {
    const h = fixture(Array.from({ length: 2000 }, (_, i) => ({ user: `u${i}`, name: `u${i}` })))
    expect((await resolveTapdIdentity(h.config, h.api, h.state, user, { now })).status).toBe('unavailable')
    h.api.directoryMembers.mockRejectedValue(new Error('403'))
    expect((await resolveTapdIdentity(h.config, h.api, h.state, user, { now })).message).toContain('读取失败')
    expect(h.values.size).toBe(0)
  })
})
