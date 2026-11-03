/**
 * VsSaros addition: TAPD identity resolution, following `saroasis-platform/scripts/studio.mjs`.
 *
 * TAPD writes owners as Chinese names with trailing semicolons ("邱子鉴;蒋小川;"), while people
 * configure WeCom aliases instead. A query value must have the semicolons stripped, and an alias
 * must be resolved to the Chinese name before it is compared with an owner or sent as a filter.
 */
export interface TapdMember { alias: string; name: string }

/** TAPD owner cells end in semicolons; a query carrying them finds fewer items (saroasis-platform: 459 -> 386). */
export const cleanOwner = (value: string): string => value.trim().replace(/[;；]+$/, '').trim()

/** Alias (or WeCom account) -> TAPD Chinese name; a Chinese name passes through unchanged. */
export const resolveTapdName = (input: string, members: readonly TapdMember[] = []): string => {
  const name = cleanOwner(input)
  if (!name) return ''
  const lower = name.toLowerCase()
  const hit = members.find(member => cleanOwner(member.alias).toLowerCase() === lower
    || cleanOwner(member.name).toLowerCase() === lower)
  return hit ? cleanOwner(hit.name) : name
}

const TTL = 12 * 3600_000
const cache = new Map<string, { at: number; members: TapdMember[] }>()
/** Members already fetched from the platform, or undefined while the cache is cold or expired. */
export const platformMembers = (base: string): readonly TapdMember[] | undefined => {
  const hit = cache.get(base)
  return hit && Date.now() - hit.at < TTL ? hit.members : undefined
}
/**
 * Fetches `/api/tapd/members` from saroasis-platform and caches its `wecomAlias -> user` mapping
 * for 12 hours, the way studio.mjs does. The member endpoint is a platform service, not TAPD's
 * Open API, so it carries neither workspace_id nor authentication headers.
 */
export async function refreshPlatformMembers(base: string, fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal): Promise<TapdMember[]> {
  const url = `${base.replace(/\/+$/, '')}/api/tapd/members`
  const response = await fetchImpl(url, { signal })
  if (!response.ok) throw new Error(`TAPD member API answered HTTP ${response.status}`)
  const body = await response.json() as { groups?: { members?: { user?: string; wecomAlias?: string }[] }[] }
  const byName = new Map<string, TapdMember>()
  for (const group of body.groups ?? []) for (const member of group.members ?? []) {
    const name = cleanOwner(member.user ?? '')
    if (!name) continue
    byName.set(name, { alias: member.wecomAlias?.trim() ?? '', name })
  }
  const members = [...byName.values()]
  cache.set(base, { at: Date.now(), members })
  return members
}
/** Static mappings plus whatever the platform cache holds. */
export const allMembers = (config: { members: readonly TapdMember[]; memberApi: string }): TapdMember[] =>
  [...config.members, ...(platformMembers(config.memberApi) ?? [])]
/** Test helper: forget fetched member tables. */
export const resetPlatformMembers = (): void => { cache.clear() }
