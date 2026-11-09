/**
 * VsSaros addition: TAPD Open API credentials, aligned with SaroasisStudioSystem's `.env` contract.
 *
 * That platform (lib/tapd.js, .env.example) accepts three credential pairs in priority order and loads them
 * from a local `.env`. The Host here reads the same variable names, so an existing `.env` can be pointed at
 * with DSH_SUPERAGENT_TAPD_ENV_FILE instead of exporting secrets into the IDE process. Only whitelisted
 * TAPD keys are taken from the file, it never overrides an existing environment value, and it is read lazily
 * (not at module load) so a late-loaded credential is still picked up. The Executor never sees these values.
 * VsSaros also ships an API account (BUNDLED_TAPD_CREDENTIALS) as the lowest-priority source, so a fresh install
 * reads TAPD without setup; a file, the settings panel, or the Host environment still wins.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type TapdEnv = Record<string, string | undefined>
export interface TapdCredential { header: string; method: string }

/** The only keys a credentials file may contribute; nothing else in an `.env` reaches the Host. */
const KEYS = [
  'DSH_SUPERAGENT_TAPD_BEARER', 'DSH_SUPERAGENT_TAPD_USER', 'DSH_SUPERAGENT_TAPD_PASSWORD',
  'DSH_SUPERAGENT_TAPD_TIMEOUT_MS',
  'TAPD_CLIENT_ID', 'TAPD_CLIENT_SECRET', 'TAPD_API_USER', 'TAPD_API_PWD', 'TAPD_API_TOKEN',
  'TAPD_HTTP_TIMEOUT_MS', 'TAPD_WORKSPACE_ID', 'DSH_SUPERAGENT_TAPD_BUNDLED',
] as const
/** The key the panel writes to disable the shipped account; it is not a credential and is never replaced by a save. */
const BUNDLED_KEY = 'DSH_SUPERAGENT_TAPD_BUNDLED'
const LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i

/**
 * VsSaros addition: the TAPD Open API account shipped with the product, so an installed VsSaros can read TAPD
 * without any per-machine setup. It is the *lowest*-priority source: a credentials file, the settings panel, or
 * Host environment variables all override it. Set `DSH_SUPERAGENT_TAPD_BUNDLED=off` to turn it off entirely.
 * The secret is only ever read by the Host (it is compiled into `lib/`, which is in the package's `files`).
 */
export const BUNDLED_TAPD_CREDENTIALS: TapdEnv = {
  TAPD_CLIENT_ID: 'tapd-app-889817',
  TAPD_CLIENT_SECRET: '6E9C1B81-5443-6CFC-0D84-27C8DAEDB6FB',
}

/** The shipped account, unless the Host environment or the credentials file disables it (no IDE restart needed for the file). */
export function bundledTapdEnv(base: TapdEnv = process.env): TapdEnv {
  const fromFile = readTapdEnvFile(tapdEnvFile(base), base)[BUNDLED_KEY]
  const flag = (base[BUNDLED_KEY] || fromFile || '').trim().toLowerCase()
  return flag === 'off' ? {} : BUNDLED_TAPD_CREDENTIALS
}

/** Explicit override, else `<DSH_HOME>/tapd.env`, else `~/.dsh/tapd.env`. */
export function tapdEnvFile(env: TapdEnv = process.env): string {
  const explicit = env.DSH_SUPERAGENT_TAPD_ENV_FILE?.trim()
  if (explicit) return explicit
  return join(env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'tapd.env')
}

let cached: { file: string; mtimeMs: number; values: TapdEnv } | undefined
/** Test hook: forget the cached credentials file. */
export function resetTapdEnvCache(): void { cached = undefined }

/** Parses `KEY=VALUE` lines with quotes and `#` comments, keeping only whitelisted keys. */
export function parseTapdEnv(text: string): TapdEnv {
  const values: TapdEnv = {}
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line)
    if (!match) continue
    const key = match[1]!.toUpperCase()
    if (!(KEYS as readonly string[]).includes(key)) continue
    let value = match[2] ?? ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1)
    values[key] = value
  }
  return values
}

/** Parses `KEY=VALUE` with quotes and `#` comments; skips unknown keys and existing environment values. */
export function readTapdEnvFile(file: string, base: TapdEnv = process.env): TapdEnv {
  let mtimeMs = 0
  try { mtimeMs = statSync(file).mtimeMs } catch { return {} }
  if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached.values
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return {} }
  const values = Object.fromEntries(Object.entries(parseTapdEnv(text)).filter(([key]) => base[key] === undefined))
  cached = { file, mtimeMs, values }
  return values
}

/** The shipped account, then the local credentials file, then the Host environment (each overrides the last). */
export function tapdEnvironment(base: TapdEnv = process.env): TapdEnv {
  const file = tapdEnvFile(base)
  return { ...bundledTapdEnv(base), ...readTapdEnvFile(file, base), ...base }
}

const basic = (user: string, password: string, method: string): TapdCredential =>
  ({ header: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, method })

/**
 * Five accepted sources, highest priority first: the two native SuperAgent variables (an explicit choice for
 * this Host), then the three used by SaroasisStudioSystem (client_id/secret is the recommended enterprise
 * API account: full permissions, no token exchange and no IP allowlist).
 */
export function tapdCredential(env: TapdEnv): TapdCredential | undefined {
  if (env.DSH_SUPERAGENT_TAPD_BEARER) return { header: `Bearer ${env.DSH_SUPERAGENT_TAPD_BEARER}`, method: 'Bearer DSH_SUPERAGENT_TAPD_BEARER' }
  if (env.DSH_SUPERAGENT_TAPD_USER && env.DSH_SUPERAGENT_TAPD_PASSWORD)
    return basic(env.DSH_SUPERAGENT_TAPD_USER, env.DSH_SUPERAGENT_TAPD_PASSWORD, 'Basic DSH_SUPERAGENT_TAPD_USER/PASSWORD')
  if (env.TAPD_CLIENT_ID && env.TAPD_CLIENT_SECRET)
    return basic(env.TAPD_CLIENT_ID, env.TAPD_CLIENT_SECRET, 'Basic TAPD_CLIENT_ID/SECRET (API account)')
  if (env.TAPD_API_USER && env.TAPD_API_PWD)
    return basic(env.TAPD_API_USER, env.TAPD_API_PWD, 'Basic TAPD_API_USER/PWD')
  if (env.TAPD_API_TOKEN) return { header: `Bearer ${env.TAPD_API_TOKEN}`, method: 'Bearer TAPD_API_TOKEN' }
  return undefined
}

/** Request timeout, with a 3s floor (a hung TAPD socket otherwise wedges every later poll). */
export function tapdTimeoutMs(env: TapdEnv): number {
  const raw = env.DSH_SUPERAGENT_TAPD_TIMEOUT_MS ?? env.TAPD_HTTP_TIMEOUT_MS
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  return Math.max(3000, Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000)
}

/** What to show when nothing is configured (only possible with the shipped account turned off). */
export function tapdCredentialsHint(env: TapdEnv = process.env): string {
  return 'No TAPD Open API credentials in the Host (the shipped account is off). Set one of: DSH_SUPERAGENT_TAPD_BEARER; '
    + 'DSH_SUPERAGENT_TAPD_USER + DSH_SUPERAGENT_TAPD_PASSWORD; TAPD_CLIENT_ID + TAPD_CLIENT_SECRET (recommended); '
    + 'TAPD_API_USER + TAPD_API_PWD; TAPD_API_TOKEN. Or put them as KEY=VALUE in ' + tapdEnvFile(env)
    + ' (or point DSH_SUPERAGENT_TAPD_ENV_FILE at an existing .env). Remove DSH_SUPERAGENT_TAPD_BUNDLED=off to use the '
    + 'account shipped with VsSaros. Credentials stay in the Host; Executors cannot read them.'
}

/*
 * VsSaros addition: the TAPD credentials the settings panel edits. They are written to the Host's credentials file
 * (never to the settings store, which the panel reads back), and the panel only ever sees a masked account name.
 */
export type TapdCredentialKind = 'client' | 'user' | 'token'
/** The file keys of each kind the panel offers: an account name (none for a token) and its secret. */
export const TAPD_CREDENTIAL_KEYS: Record<TapdCredentialKind, { id?: string; secret: string }> = {
  client: { id: 'TAPD_CLIENT_ID', secret: 'TAPD_CLIENT_SECRET' },
  user: { id: 'TAPD_API_USER', secret: 'TAPD_API_PWD' },
  token: { secret: 'TAPD_API_TOKEN' },
}
/** Every credential key; saving replaces all of them so a stale, higher-priority one cannot win over the new one. */
const CREDENTIAL_KEYS = ['DSH_SUPERAGENT_TAPD_BEARER', 'DSH_SUPERAGENT_TAPD_USER', 'DSH_SUPERAGENT_TAPD_PASSWORD',
  'TAPD_CLIENT_ID', 'TAPD_CLIENT_SECRET', 'TAPD_API_USER', 'TAPD_API_PWD', 'TAPD_API_TOKEN']

export interface TapdCredentialStatus {
  /** Whether the Host has a credential at all, from either place. */
  configured: boolean
  /** Which credential the Host uses, e.g. `Basic TAPD_CLIENT_ID/SECRET (API account)`. */
  method?: string
  /** Where the credential in use comes from (all sources are merged key by key, then picked by priority). */
  source: 'environment' | 'file' | 'bundled' | 'none'
  /** The credentials file the panel writes. */
  file: string
  /** The kind of the credential in use (including the shipped account), and its account name masked. */
  kind?: TapdCredentialKind
  account?: string
  /** Whether the credentials file holds a complete pair the panel saved. `kind` alone does not mean "blank keeps it". */
  saved: boolean
  /** Whether the product's shipped account is enabled; the panel can turn it off without restarting the IDE. */
  bundled: boolean
  /** The file holds a credential, but a higher-priority one in the Host environment is used instead. */
  overridden: boolean
}

/** Everything the panel's TAPD setup checklist needs, in one read-only response. */
export interface TapdSetupStatus {
  credential: TapdCredentialStatus
  watches: number
  workspace: string
  agent: string
  /** The identity name after the member mapping is applied (TAPD compares owners as Chinese names). */
  agentResolved: string
  /** Whether `agent` was an alias that the mapping resolved. */
  agentMapped: boolean
  /** The Source's live health code, e.g. `tapdUnset` when no watch is set; null while it has not reported. */
  healthCode: string | null
}
/** A credential the panel cannot save as given (missing, unknown kind, or a value that would break the file); answered with 400. */
export class TapdCredentialError extends Error {}

const mask = (value: string): string => value.length <= 6 ? '•'.repeat(value.length) : `${value.slice(0, 3)}…${value.slice(-2)}`
function fileValues(file: string): TapdEnv {
  try { return parseTapdEnv(readFileSync(file, 'utf8')) } catch { return {} }
}
function fileKind(values: TapdEnv): TapdCredentialKind | undefined {
  return (Object.keys(TAPD_CREDENTIAL_KEYS) as TapdCredentialKind[]).find(kind => {
    const keys = TAPD_CREDENTIAL_KEYS[kind]
    return !!values[keys.secret] && (!keys.id || !!values[keys.id])
  })
}

/** The credential status the panel shows; it never carries a secret. */
export function tapdCredentialStatus(base: TapdEnv = process.env): TapdCredentialStatus {
  const file = tapdEnvFile(base)
  const values = fileValues(file)
  const bundled = bundledTapdEnv(base)
  const fromEnv = tapdCredential(base)
  const fromFile = tapdCredential({ ...bundled, ...values })
  // The Host merges all three key by key (the environment wins a key both set) and then picks by priority, so the
  // credential in use may come from any of them; say which, rather than assuming the environment always wins.
  const effective = tapdCredential({ ...bundled, ...values, ...base })
  const fromEnvInUse = !!effective && !!fromEnv && effective.header === fromEnv.header
  const fromFileInUse = !!effective && !fromEnvInUse && !!tapdCredential(values) && effective.header === fromFile?.header
  const source = !effective ? 'none' : fromEnvInUse ? 'environment' : fromFileInUse ? 'file' : 'bundled'
  const saved = !!tapdCredential(values)
  // The shipped account is a client pair: name it in the status so the panel can show a masked account and the
  // right credential kind without pretending a file was saved (`same` must stay false until the panel saves one).
  const kind: TapdCredentialKind | undefined = fileKind(values) ?? (source === 'bundled' ? 'client' : undefined)
  const id = kind && TAPD_CREDENTIAL_KEYS[kind].id
  const account = source === 'bundled' && BUNDLED_TAPD_CREDENTIALS.TAPD_CLIENT_ID
    ? mask(BUNDLED_TAPD_CREDENTIALS.TAPD_CLIENT_ID)
    : id && values[id] ? mask(values[id]!) : undefined
  return {
    configured: !!effective, ...effective ? { method: effective.method } : {},
    source, file, saved, bundled: Object.keys(bundled).length > 0,
    ...kind ? { kind } : {}, ...account ? { account } : {},
    overridden: fromEnvInUse && !!tapdCredential(values),
  }
}

const SAFE = /^[^\r\n"'\0]{1,512}$/
/**
 * Writes one credential to the Host's credentials file, replacing every credential key there and keeping the other lines
 * (timeouts, workspace, comments). An empty `id` or `secret` keeps the file's current value of the same kind, so the
 * secret need not be typed again to change the account name; `clear` removes the credential keys only.
 */
export async function saveTapdCredential(input: { kind?: TapdCredentialKind; id?: string; secret?: string; clear?: boolean;
  bundled?: 'on' | 'off' }, base: TapdEnv = process.env): Promise<TapdCredentialStatus> {
  const file = tapdEnvFile(base)
  let text = ''
  try { text = await readFile(file, 'utf8') } catch { /* A missing file starts empty. */ }
  const current = parseTapdEnv(text)
  const kept = text.split(/\r?\n/).filter(line => {
    const key = LINE.exec(line)?.[1]?.toUpperCase()
    return !key || (!CREDENTIAL_KEYS.includes(key) && key !== BUNDLED_KEY)
  })
  while (kept.length && kept.at(-1) === '') kept.pop()
  const lines = [...kept]
  // A request that only flips the shipped-account switch must not demand a credential kind.
  const onlySwitch = input.bundled !== undefined && !input.kind && !input.id && !input.secret && !input.clear
  if (!input.clear && !onlySwitch) {
    const kind = input.kind
    if (!kind || !(kind in TAPD_CREDENTIAL_KEYS)) throw new TapdCredentialError('Choose a TAPD credential kind')
    const keys = TAPD_CREDENTIAL_KEYS[kind]
    const same = fileKind(current) === kind
    const id = input.id?.trim() || (same && keys.id ? current[keys.id] ?? '' : '')
    const secret = input.secret?.trim() || (same ? current[keys.secret] ?? '' : '')
    if (keys.id && !id) throw new TapdCredentialError('Enter the TAPD account name')
    if (!secret) throw new TapdCredentialError('Enter the TAPD secret')
    for (const value of keys.id ? [id, secret] : [secret]) {
      if (!SAFE.test(value)) throw new TapdCredentialError('A TAPD credential may not contain quotes or line breaks and is at most 512 characters')
    }
    if (!kept.some(line => line.includes('dsh-superagent'))) lines.unshift('# TAPD Open API credentials for dsh-superagent (written by its settings panel).')
    if (keys.id) lines.push(`${keys.id}=${id}`)
    lines.push(`${keys.secret}=${secret}`)
  }
  // Preserve the switch across ordinary saves, or apply the panel's request; an "on" is the absence of the line.
  const bundledFlag = input.bundled ?? (String(current[BUNDLED_KEY] ?? '').trim().toLowerCase() === 'off' ? 'off' : 'on')
  if (bundledFlag === 'off') lines.push(`${BUNDLED_KEY}=off`)
  await mkdir(dirname(file), { recursive: true })
  // Random suffix: two quick saves in the same millisecond must not share a temporary name.
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, lines.length ? `${lines.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 })
  // On Windows a rename over an existing file can briefly fail EPERM/EBUSY (scanner or another reader).
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, file); break } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 2 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
  await chmod(file, 0o600).catch(() => { /* Windows has no POSIX modes. */ })
  resetTapdEnvCache()
  return tapdCredentialStatus(base)
}
