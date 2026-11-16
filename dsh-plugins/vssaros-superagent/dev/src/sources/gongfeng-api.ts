/** Independent Gongfeng API v3 transport. MR IID is resolved to its internal ID before detail/note operations. */
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const GONGFENG_SOURCE = 'gongfeng'
const positive = z.number().int().positive().safe()
const account = z.object({ id: positive, username: z.string().min(1), bot: z.boolean().optional() })
export const GongfengConfigSchema = z.object({
  api: z.string().trim().url().refine(value => {
    const url = new URL(value)
    return url.origin === 'https://git.woa.com' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/api/v3'
  }, 'The supported Gongfeng endpoint is https://git.woa.com/api/v3').default('https://git.woa.com/api/v3'),
  project: z.string().trim().regex(/^\d*$/).default(''),
  agent: z.string().trim().regex(/^[\w.-]*$/).default(''),
  bots: z.array(z.object({ id: z.string().trim().regex(/^[\w.-]+$/) }).strict()).max(100).default([]),
  observeMrs: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  pollSeconds: z.number().int().min(60).max(3600).default(120),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type GongfengConfig = z.infer<typeof GongfengConfigSchema>
export const GongfengMrSchema = z.looseObject({
  id: positive, iid: positive, project_id: positive, source_project_id: positive.nullish(), target_project_id: positive.nullish(),
  title: z.string(), description: z.string().nullish(), source_branch: z.string().min(1), target_branch: z.string().min(1),
  state: z.enum(['opened', 'reopened', 'closed', 'merged']), author: account,
  created_at: z.string().datetime({ offset: true }), updated_at: z.string().datetime({ offset: true }),
  merged_at: z.string().datetime({ offset: true }).nullish(), closed_at: z.string().datetime({ offset: true }).nullish(),
  web_url: z.string().optional(),
})
export type GongfengMr = z.infer<typeof GongfengMrSchema>
export const GongfengNoteSchema = z.looseObject({ id: positive, body: z.string(), author: account,
  created_at: z.string().datetime({ offset: true }), updated_at: z.string().datetime({ offset: true }).optional(), system: z.boolean().default(false) })
export type GongfengNote = z.infer<typeof GongfengNoteSchema>
export interface GongfengPage<T> { items: T[]; next: number | null }
export interface GongfengApi {
  verify(agent: string, signal?: AbortSignal): Promise<{ project: string; path: string; username: string; canPush: boolean }>
  mrs(page: number, signal?: AbortSignal): Promise<GongfengPage<GongfengMr>>
  mr(iid: number, signal?: AbortSignal): Promise<GongfengMr>
  notes(id: number, page: number, signal?: AbortSignal): Promise<GongfengPage<GongfengNote>>
  note(id: number, body: string, signal?: AbortSignal): Promise<void>
  create(input: { title: string; description: string; source_branch: string; target_branch: string }, signal?: AbortSignal): Promise<GongfengMr>
}
/** Redacted API/identity errors, without returning credential material or server response bodies. */
export class GongfengError extends Error {
  constructor(message: string) { super(`Gongfeng: ${message}`); this.name = 'GongfengError' }
}
/** Only Host environment or its private local credential file; never a token in Source settings/tool responses. */
export function gongfengToken(env: Record<string, string | undefined> = process.env): string | undefined {
  const direct = env.DSH_SUPERAGENT_GONGFENG_TOKEN?.trim() || env.WOA_GITLAB_TOKEN?.trim()
  if (direct) return direct
  const file = env.DSH_SUPERAGENT_GONGFENG_ENV_FILE?.trim() || join(env.DSH_HOME || join(homedir(), '.dsh'), 'gongfeng.env')
  try {
    const text = readFileSync(file, 'utf8')
    const match = /^\s*DSH_SUPERAGENT_GONGFENG_TOKEN\s*=\s*([^\r\n]+)\s*$/m.exec(text)
    return match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') || undefined
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw new GongfengError('Cannot read the local credential file')
  }
}
export const gongfengPage = (config: GongfengConfig, mr: Pick<GongfengMr, 'iid'>, path: string): string =>
  `${new URL(config.api).origin}/${path}/merge_requests/${mr.iid}`
/** Requests have deadlines, refuse credential-bearing redirects, and never retry writes. */
export class GongfengOpenApi implements GongfengApi {
  private token: string | undefined
  constructor(private readonly config: GongfengConfig, private readonly options: {
    token?: () => string | undefined; fetch?: typeof fetch; timeoutMs?: number
  } = {}) {}
  private async request(method: 'GET' | 'POST', path: string, fields: Record<string, string>, signal?: AbortSignal): Promise<{ value: unknown; next: string | null }> {
    signal?.throwIfAborted()
    const token = this.token ??= (this.options.token ?? gongfengToken)()
    if (!token || /[\r\n]/.test(token)) throw new GongfengError('Set DSH_SUPERAGENT_GONGFENG_TOKEN in the Host environment or gongfeng.env')
    const query = new URLSearchParams(fields).toString()
    const url = `${this.config.api}/${path}${method === 'GET' && query ? `?${query}` : ''}`
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15000)
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(url, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'PRIVATE-TOKEN': token, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method === 'POST' ? { body: query } : {}) })
    } catch { signal?.throwIfAborted(); throw new GongfengError('Request failed, timed out or attempted a redirect; no write retry performed') }
    if (!response.ok) throw new GongfengError(`HTTP ${response.status}; check account, project and access (response body omitted)`)
    const reader = response.body?.getReader()
    if (!reader) throw new GongfengError('Empty response body')
    const chunks: Uint8Array[] = []; let bytes = 0
    try {
      for (;;) {
        signal?.throwIfAborted(); timeout.throwIfAborted()
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 2_000_000) { await reader.cancel(); throw new GongfengError('Response exceeds the read limit') }
        chunks.push(part.value)
      }
    } catch { signal?.throwIfAborted(); throw new GongfengError('Response read failed or exceeded its deadline/size; inspect write outcomes before retrying') }
    finally { reader.releaseLock() }
    const text = Buffer.concat(chunks).toString('utf8')
    try { return { value: JSON.parse(text), next: response.headers.get('x-next-page') } }
    catch { throw new GongfengError('Unexpected response envelope') }
  }
  private async list<T>(path: string, schema: z.ZodType<T>, page: number, fields: Record<string, string> = {}, signal?: AbortSignal): Promise<GongfengPage<T>> {
    if (!Number.isInteger(page) || page < 1 || page > 10) throw new GongfengError('Page must be 1–10')
    const result = await this.request('GET', path, { ...fields, page: String(page), per_page: '50' }, signal)
    const parsed = z.array(schema).safeParse(result.value)
    if (!parsed.success) throw new GongfengError('Unexpected list schema')
    const more = result.next === null ? parsed.data.length === 50 : result.next !== ''
    if (result.next && result.next !== String(page + 1)) throw new GongfengError('Unexpected next-page cursor')
    if (more && page === 10) throw new GongfengError('Pagination limit reached; narrow the project before advancing its cursor')
    return { items: parsed.data, next: more ? page + 1 : null }
  }
  async verify(agent: string, signal?: AbortSignal) {
    const user = account.safeParse((await this.request('GET', 'user', {}, signal)).value)
    const project = z.looseObject({ id: positive, path_with_namespace: z.string().min(1),
      permissions: z.object({ project_access: z.object({ access_level: z.number() }).nullish(), group_access: z.object({ access_level: z.number() }).nullish() }).nullish() })
      .safeParse((await this.request('GET', `projects/${this.config.project}`, {}, signal)).value)
    if (!user.success || !project.success || String(project.data.id) !== this.config.project) throw new GongfengError('Unexpected account/project schema')
    if (agent && user.data.username !== agent) throw new GongfengError('The token account differs from the configured execution account')
    const level = Math.max(project.data.permissions?.project_access?.access_level ?? 0, project.data.permissions?.group_access?.access_level ?? 0)
    return { project: String(project.data.id), path: project.data.path_with_namespace, username: user.data.username, canPush: level >= 30 }
  }
  mrs(page: number, signal?: AbortSignal) {
    return this.list(`projects/${this.config.project}/merge_requests`, GongfengMrSchema, page, { order_by: 'updated_at', sort: 'desc' }, signal)
  }
  async mr(iid: number, signal?: AbortSignal): Promise<GongfengMr> {
    if (!Number.isSafeInteger(iid) || iid <= 0) throw new GongfengError('Invalid MR IID')
    const result = await this.request('GET', `projects/${this.config.project}/merge_requests`, { iid: String(iid), page: '1', per_page: '50' }, signal)
    const matches = z.array(GongfengMrSchema).safeParse(result.value)
    if (!matches.success) throw new GongfengError('Unexpected MR lookup schema')
    const found = matches.data.filter(mr => mr.iid === iid && String(mr.project_id) === this.config.project)
    if (found.length !== 1) throw new GongfengError('MR not found or ambiguous')
    const detail = GongfengMrSchema.safeParse((await this.request('GET', `projects/${this.config.project}/merge_requests/${found[0]!.id}`, {}, signal)).value)
    if (!detail.success || detail.data.id !== found[0]!.id || detail.data.iid !== iid || String(detail.data.project_id) !== this.config.project) throw new GongfengError('MR identity mismatch')
    return detail.data
  }
  notes(id: number, page: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new GongfengError('Invalid internal MR ID')
    return this.list(`projects/${this.config.project}/merge_requests/${id}/notes`, GongfengNoteSchema, page, { order_by: 'created_at', sort: 'asc' }, signal)
  }
  async note(id: number, body: string, signal?: AbortSignal) {
    if (!Number.isSafeInteger(id) || id <= 0 || !body.trim()) throw new GongfengError('Invalid note target/body')
    await this.request('POST', `projects/${this.config.project}/merge_requests/${id}/notes`, { body }, signal)
  }
  async create(input: { title: string; description: string; source_branch: string; target_branch: string }, signal?: AbortSignal): Promise<GongfengMr> {
    const parsed = GongfengMrSchema.safeParse((await this.request('POST', `projects/${this.config.project}/merge_requests`, input, signal)).value)
    if (!parsed.success || String(parsed.data.project_id) !== this.config.project || String(parsed.data.source_project_id) !== this.config.project
      || parsed.data.source_branch !== input.source_branch || parsed.data.target_branch !== input.target_branch
      || parsed.data.author.username !== this.config.agent || !['opened', 'reopened'].includes(parsed.data.state)) {
      throw new GongfengError('MR creation response could not be verified; inspect the project before retrying')
    }
    return parsed.data
  }
}
