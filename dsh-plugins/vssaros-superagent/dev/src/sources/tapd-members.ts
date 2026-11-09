/**
 * VsSaros addition: TAPD identity resolution.
 *
 * TAPD writes owners as Chinese names with trailing semicolons ("邱子鉴;蒋小川;"), while people
 * configure WeCom aliases instead. A query value must have the semicolons stripped, and an alias
 * must be resolved to the Chinese name before it is compared with an owner or sent as a filter.
 * The retired intranet platform's `/api/tapd/members` endpoint is gone (0.1.81): only the static
 * `members` mapping in the Source's settings is used, so this module has no network dependency.
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
