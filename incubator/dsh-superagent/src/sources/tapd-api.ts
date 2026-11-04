/**
 * VsSaros addition: reading and commenting on TAPD stories, bugs and tasks. Two ways in, behind one `TapdApi`:
 * - `openapi`: TAPD's Open API (`https://api.tapd.cn` by default) with the account in DSH_SUPERAGENT_TAPD_USER and
 *   DSH_SUPERAGENT_TAPD_PASSWORD (or a bearer token in DSH_SUPERAGENT_TAPD_BEARER), read by the Host only;
 * - `mcp`: the `tapd` MCP server through `mcporter-internal`, signed in as the operator.
 * Both return TAPD's records as plain objects of strings, whichever envelope they came in.
 */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import { cliArgv } from '../deployment.ts'
import { tapdCredential, tapdCredentialsHint, tapdEnvironment, tapdTimeoutMs, type TapdEnv } from './tapd-auth.ts'

export const TAPD_SOURCE = 'tapd'
export const TAPD_TYPES = ['story', 'bug', 'task'] as const
export type TapdType = typeof TAPD_TYPES[number]
const COLLECTION: Record<TapdType, { path: string; record: string; entry: string; page: string }> = {
  story: { path: 'stories', record: 'Story', entry: 'stories', page: 'prong/stories/view' },
  bug: { path: 'bugs', record: 'Bug', entry: 'bug', page: 'bugtrace/bugs/view' },
  task: { path: 'tasks', record: 'Task', entry: 'tasks', page: 'prong/tasks/view' },
}
export const TapdConfigSchema = z.object({
  transport: z.enum(['openapi', 'mcp']).default('openapi'),
  api: z.string().trim().regex(/^https:\/\/[^\s/]+(\/[^\s]*)?$/).default('https://api.tapd.cn'),
  site: z.string().trim().regex(/^https:\/\/[^\s/]+$/).default('https://www.tapd.cn'),
  cli: z.string().trim().default('mcporter-internal'),
  server: z.string().trim().regex(/^[\w.-]+$/).default('tapd'),
  /** TAPD `workspace_id`; every watch without its own inherits this. GR is the default (saroasis-platform). */
  workspace: z.string().trim().regex(/^\d+$/).default('68880148'),
  /** Optional saroasis-platform base URL whose `/api/tapd/members` maps WeCom aliases to TAPD names. */
  memberApi: z.string().trim().default(''),
  /** WeCom alias -> TAPD Chinese name, used when the platform member API is not configured. */
  members: z.array(z.object({ alias: z.string().trim().min(1), name: z.string().trim().min(1) }).strict()).default([]),
  /** Optional TAPD identity: a person's Chinese name or a robot account's name, as TAPD writes `owner`/`current_owner`
   * and as people @ in comments. It is not a query parameter; it only recognises what addresses SuperAgent and signs
   * replies. Empty: no identity matching, and replies are signed `dsh-superagent`. */
  agent: z.string().trim().default(''),
  watches: z.array(z.object({
    name: z.string().trim().regex(/^[\w.-]{1,40}$/),
    /** Empty: inherit the Source-level `workspace`. */
    workspace: z.string().trim().regex(/^\d*$/).default(''),
    type: z.enum(TAPD_TYPES),
    /** One item's ID: the watch follows that item alone. Empty: a list, by the filters below. */
    item: z.string().trim().regex(/^\d*$/).default(''),
    status: z.string().trim().default(''),
    owner: z.string().trim().default(''),
    iteration: z.string().trim().regex(/^\d*$/).default(''),
    /** `assigned`: only what is assigned to `agent`, or @s it; `all`: every change, which the Policy's admission table decides. */
    mode: z.enum(['assigned', 'all']).default('assigned'),
  }).strict()).default([]),
  /** Optional TAPD Webhook ingress: a fast lane on top of polling, off by default. TAPD POSTs to
   * `/orchestrator/webhook/tapd`; the event carries IDs only, so the item is reread before it is received. */
  webhook: z.boolean().default(false),
  /** The shared secret TAPD sends as the `secret` field (or `x-tapd-secret` header / `secret` query); required while on. */
  webhookSecret: z.string().trim().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(120),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type TapdConfig = z.infer<typeof TapdConfigSchema>
export type TapdWatch = TapdConfig['watches'][number]
/** A watch (project/type/filters) and the account credentials are enough; the identity name is optional. */
export const tapdConfigured = (config: TapdConfig): boolean => config.watches.length > 0
/** A watch's own workspace ID, or the Source-level default (GR project) when the watch leaves it empty. */
export const watchWorkspace = (config: Pick<TapdConfig, 'workspace'>, watch: TapdWatch): string => watch.workspace || config.workspace

/** A TAPD record with its fields as strings, as TAPD returns them. */
export type TapdRecord = Record<string, string>
export interface TapdItem { type: TapdType; workspace: string; id: string; title: string; description: string; status: string
  owners: string[]; creator: string; created: string; modified: string; iteration: string }
export interface TapdComment { id: string; author: string; text: string; created: string; modified: string }

/** TAPD writes times as `YYYY-MM-DD HH:mm:ss` in China time; this is the same instant in ISO form. */
export const tapdInstant = (time: string): string => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(time) ? new Date(`${time.replace(' ', 'T')}+08:00`).toISOString() : time
/** An instant as TAPD writes times, in China time. */
export const tapdTime = (iso: string): string => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
/** Plain text of a TAPD rich-text field (HTML), with paragraphs and line breaks kept. */
export function plainText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
const names = (value: string | undefined): string[] => (value ?? '').split(/[;,；]/).map(name => name.trim()).filter(Boolean)
export function itemOf(type: TapdType, record: TapdRecord): TapdItem {
  return { type, workspace: record.workspace_id ?? '', id: record.id ?? '', title: record.name ?? record.title ?? '',
    description: plainText(record.description ?? ''), status: record.status ?? '',
    owners: names(type === 'bug' ? record.current_owner : record.owner), creator: record.creator ?? record.reporter ?? '',
    created: tapdInstant(record.created ?? ''), modified: tapdInstant(record.modified ?? record.created ?? ''), iteration: record.iteration_id ?? '' }
}
export const commentOf = (record: TapdRecord): TapdComment => ({ id: record.id ?? '', author: record.author ?? '', text: plainText(record.description ?? ''),
  created: tapdInstant(record.created ?? ''), modified: tapdInstant(record.modified ?? record.created ?? '') })
export const itemPage = (site: string, item: Pick<TapdItem, 'type' | 'workspace' | 'id'>): string => `${site}/${item.workspace}/${COLLECTION[item.type].page}/${item.id}`
/** Parses the page of a story, bug or task on any TAPD site. */
export function itemAddress(url: string): Pick<TapdItem, 'type' | 'workspace' | 'id'> | undefined {
  const match = /^https?:\/\/[^/]*tapd[^/]*\/(?:tapd_fe\/)?(\d+)\/(prong\/stories|bugtrace\/bugs|prong\/tasks)\/view\/(\d+)/i.exec(url.trim())
  if (!match) return undefined
  const type = match[2]!.endsWith('stories') ? 'story' : match[2]!.endsWith('bugs') ? 'bug' : 'task'
  return { type, workspace: match[1]!, id: match[3]! }
}

/** TAPD failed to answer; `gone` when the item no longer exists, which a reply should not retry. */
export class TapdError extends Error { constructor(message: string, readonly gone = false) { super(message) } }
/**
 * Strips the envelopes TAPD data comes in: an MCP tool result (`content[].text` or `structuredContent`), TAPD's own
 * `{ status, data, info }`, and the one-key `{ Story: {...} }` wrapper of each record.
 */
export function records(value: unknown): TapdRecord[] {
  let current = value
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current === 'string') {
      const text = current
      try { current = JSON.parse(text) } catch { throw new TapdError(text.slice(0, 500)) }
      continue
    }
    if (Array.isArray(current)) break
    if (!current || typeof current !== 'object') return []
    const object = current as Record<string, unknown>
    // saroasis-platform: an unknown API path answers HTTP 200 with status 1 and this string as data.
    // Detect it before the status check, which such a response would pass.
    if (typeof object.data === 'string' && /Hello world from TAPD API/i.test(object.data))
      throw new TapdError('TAPD answered "Hello world from TAPD API": the API path does not exist')
    if (object.isError === true) throw new TapdError(JSON.stringify(object.content ?? object).slice(0, 500))
    if (Array.isArray(object.content) && object.structuredContent === undefined) {
      current = (object.content as { type?: string; text?: string }[]).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      continue
    }
    if (object.structuredContent !== undefined) { current = object.structuredContent; continue }
    if ('status' in object && 'data' in object) {
      if (Number(object.status) !== 1) throw new TapdError(String(object.info ?? `TAPD status ${String(object.status)}`))
      current = object.data
      continue
    }
    if ('data' in object && Object.keys(object).length <= 3) { current = object.data; continue }
    current = [object]
    break
  }
  if (!Array.isArray(current)) return []
  return current.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const keys = Object.keys(entry)
    const inner = keys.length === 1 && /^[A-Z]/.test(keys[0]!) ? (entry as Record<string, unknown>)[keys[0]!] : entry
    if (!inner || typeof inner !== 'object') return []
    return [Object.fromEntries(Object.entries(inner).map(([name, field]) => [name, field == null ? '' : String(field)]))]
  })
}

/** The read and comment operations the TAPD Source needs; `transport` picks how they reach TAPD. */
export interface TapdApi {
  /** Items of `type` in `workspace` matching `filter` (TAPD query fields, such as `modified: '>2026-11-03 10:00:00'`), oldest change first. */
  items(type: TapdType, workspace: string, filter: Record<string, string>, signal?: AbortSignal): Promise<TapdItem[]>
  comments(type: TapdType, workspace: string, id: string, since?: string, signal?: AbortSignal): Promise<TapdComment[]>
  comment(type: TapdType, workspace: string, id: string, author: string, html: string, signal?: AbortSignal): Promise<void>
}
const PAGE = 200
const MAX_PAGES = 10
/** Fetches every page of a list (TAPD pages hold at most 200). */
async function paged(read: (page: number) => Promise<TapdRecord[]>): Promise<TapdRecord[]> {
  const all: TapdRecord[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const got = await read(page)
    all.push(...got)
    if (got.length < PAGE) break
  }
  return all
}
/** saroasis-platform: TAPD ignores `offset` and always returns page 1; paging must use `page`. */
const listArgs = (filter: Record<string, string>, page: number) => {
  if (filter.offset !== undefined) throw new TapdError('TAPD ignores offset; pagination uses page')
  return { ...filter, limit: String(PAGE), page: String(page), order: 'modified asc' }
}
const commentFilter = (type: TapdType, workspace: string, id: string, since?: string) =>
  ({ workspace_id: workspace, entry_type: COLLECTION[type].entry, entry_id: id, ...since ? { modified: `>${tapdTime(since)}` } : {} })

export interface OpenApiOptions { api: string; environment?: TapdEnv; fetch?: typeof fetch; timeoutMs?: number }
/** TAPD's Open API, signed in with the account the Host's environment or credentials file names. */
export class TapdOpenApi implements TapdApi {
  private readonly fetch: typeof fetch
  constructor(private readonly options: OpenApiOptions) { this.fetch = options.fetch ?? globalThis.fetch }
  /** An explicit environment (tests) is used as-is; a real Host also reads the local credentials file. */
  private get env(): TapdEnv { return this.options.environment ?? tapdEnvironment() }
  private authorization(): string {
    const credential = tapdCredential(this.env)
    if (!credential) throw new TapdError(tapdCredentialsHint(this.env))
    return credential.header
  }
  private async request(method: 'GET' | 'POST', path: string, fields: Record<string, string>, signal?: AbortSignal): Promise<TapdRecord[]> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? tapdTimeoutMs(this.env))
    const query = new URLSearchParams(fields).toString()
    const url = `${this.options.api.replace(/\/$/, '')}/${path}${method === 'GET' ? `?${query}` : ''}`
    const response = await this.fetch(url, { method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { authorization: this.authorization(), accept: 'application/json',
        ...method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {} },
      ...method === 'POST' ? { body: query } : {} })
    const text = await response.text()
    if (response.status === 401 || response.status === 403) throw new TapdError(`TAPD refused the account (HTTP ${response.status})`)
    if (!response.ok) throw new TapdError(`TAPD answered HTTP ${response.status}: ${text.slice(0, 300)}`, response.status === 404)
    return records(text)
  }
  async items(type: TapdType, workspace: string, filter: Record<string, string>, signal?: AbortSignal): Promise<TapdItem[]> {
    const got = await paged(page => this.request('GET', COLLECTION[type].path, listArgs({ workspace_id: workspace, ...filter }, page), signal))
    return got.map(record => itemOf(type, { workspace_id: workspace, ...record }))
  }
  async comments(type: TapdType, workspace: string, id: string, since?: string, signal?: AbortSignal): Promise<TapdComment[]> {
    return (await paged(page => this.request('GET', 'comments', listArgs(commentFilter(type, workspace, id, since), page), signal))).map(commentOf)
  }
  async comment(type: TapdType, workspace: string, id: string, author: string, html: string, signal?: AbortSignal): Promise<void> {
    await this.request('POST', 'comments', { workspace_id: workspace, entry_type: COLLECTION[type].entry, entry_id: id, author, description: html }, signal)
  }
}

/**
 * The argv prefix that runs `cli` without a shell: a `.js` script runs under the Host's node, and on Windows an npm
 * `.cmd`/`.ps1` launcher (which `Commands` does not run) is replaced by the script it launches.
 */
export function nodeCli(cli: string, path: string, windows = process.platform === 'win32'): string[] {
  try { return cliArgv(cli, path, windows) }
  catch (error) { throw new TapdError(error instanceof Error ? error.message : String(error)) }
}
/** The TAPD MCP server through `mcporter-internal call <server>.proxy_execute_tool`. */
export class TapdMcp implements TapdApi {
  constructor(private readonly commands: Commands, private readonly argv: string[], private readonly server: string) {}
  private async call(tool: string, args: Record<string, string>, signal?: AbortSignal): Promise<TapdRecord[]> {
    const [program, ...prefix] = this.argv
    const payload = JSON.stringify({ tool_name: tool, tool_args: JSON.stringify(args) })
    const output = await this.commands.withSignal(signal).run(program!, [...prefix, 'call', `${this.server}.proxy_execute_tool`, '--args', payload, '--output', 'json'])
    return records(output)
  }
  async items(type: TapdType, workspace: string, filter: Record<string, string>, signal?: AbortSignal): Promise<TapdItem[]> {
    const got = await paged(page => this.call(`${COLLECTION[type].path}_get`, listArgs({ workspace_id: workspace, ...filter }, page), signal))
    return got.map(record => itemOf(type, { workspace_id: workspace, ...record }))
  }
  async comments(type: TapdType, workspace: string, id: string, since?: string, signal?: AbortSignal): Promise<TapdComment[]> {
    return (await paged(page => this.call('comments_get', listArgs(commentFilter(type, workspace, id, since), page), signal))).map(commentOf)
  }
  async comment(type: TapdType, workspace: string, id: string, author: string, html: string, signal?: AbortSignal): Promise<void> {
    await this.call('comments_create', { workspace_id: workspace, entry_type: COLLECTION[type].entry, entry_id: id, author, description: html }, signal)
  }
}
/** The `TapdApi` of a configuration. */
export function tapdApi(config: TapdConfig, commands: Commands, path = process.env.PATH ?? ''): TapdApi {
  return config.transport === 'mcp' ? new TapdMcp(commands, nodeCli(config.cli, path), config.server) : new TapdOpenApi({ api: config.api })
}
