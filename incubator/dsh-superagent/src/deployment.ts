/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import { larkProfiles, type LarkProfiles } from './sources/feishu-profile.ts'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
// VsSaros patch (Windows): an absolute path is `/…` on POSIX and `C:\…`, `C:/…` or `\\server\…` on Windows.
const absolute = (description: string) => s.string().pattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
/**
 * VsSaros addition: `appId` picks the Feishu app by its lark-cli profile (lark-cli names a profile after its app by default).
 * Empty keeps upstream behaviour: the CLI's active profile.
 */
export const FeishuBotSchema = z.object({
  cli: z.string().trim().default(''),
  appId: z.string().trim().regex(/^(cli_[A-Za-z0-9]+)?$/, 'cli_…').default(''),
})
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape),
  // VsSaros addition: the p4 Source's server, accounts and workspaces, which the workers' p4 guard is written from.
  p4: ['cli', 'port', 'user', 'submitUser', 'submitClient'] }

export interface GithubAccount { cli: string; login: string; noreply: string }
/**
 * VsSaros patch (optional GitHub): `repository` and `github` are present only when the GitHub Source is configured; a
 * deployment that works from other Sources (TAPD, P4) has neither. Code that needs them reads them through `githubOf`.
 */
export interface Deployment extends Machine {
  repository?: string
  github?: GithubAccount
  feishu?: FeishuBot
}
/** VsSaros addition: `profile` is the lark-cli profile every call selects (`--profile`), present only when the Source names an app. */
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string; profile?: string }
/** The shell-free argv of the bot's lark-cli, selecting its profile when it has one; every Host-side call and the worker shim use it. */
export function larkArgv(bot: Pick<FeishuBot, 'cli' | 'profile'>, path = process.env.PATH ?? '', windows = WINDOWS): string[] {
  return [...cliArgv(bot.cli, path, windows), ...profileArgs(bot.profile)]
}
export const profileArgs = (profile: string | undefined): string[] => profile ? ['--profile', profile] : []
/** The deployment's GitHub repository and account, or an error naming what to configure when the GitHub Source is not set up. */
export function githubOf(deployment: Pick<Deployment, 'repository' | 'github'>): { repository: string; github: GithubAccount } {
  const { repository, github } = deployment
  if (!repository || !github) throw new Error('The GitHub Source is not set up: set its repository and account CLI, or leave it off')
  return { repository, github }
}
/** True when the operator configured the GitHub Source (any setup field set); an untouched GitHub Source is not set up and not checked. */
export function githubConfigured(config: unknown): boolean {
  const { repository, cli } = GithubAccountsSchema.parse(config ?? {})
  return repository !== '' || cli !== ''
}

const WINDOWS = process.platform === 'win32'
/** Extensions Windows runs a bare command name with, in its order (PATHEXT). */
function pathExtensions(): string[] {
  return (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.trim().toLowerCase()).filter(Boolean)
}
/**
 * Resolve a command name or absolute path to an executable file, ignoring the worker shim directory.
 * VsSaros patch (Windows): a name may use `\` as well as `/`. A bare name resolves through PATHEXT as cmd.exe does, so `gh`
 * finds `gh.exe` and never the extensionless `gh` script npm puts beside a `gh.cmd`; an absolute path is taken as given,
 * or with a PATHEXT extension added when no file has exactly that name.
 */
export function executable(name: string, path: string, exclude?: string, windows = WINDOWS): string {
  const separated = windows ? /[\\/]/.test(name) : name.includes('/')
  if (separated && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const extensions = windows ? pathExtensions() : []
  const named = windows && extensions.includes(extname(name).toLowerCase())
  const withExtensions = (base: string): string[] => extensions.map(ext => base + ext)
  const candidates = isAbsolute(name)
    ? (windows && !named ? [name, ...withExtensions(name)] : [name])
    : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
      .flatMap(base => (windows && !named ? withExtensions(base) : [base]))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

/**
 * VsSaros patch (Windows): the argv that runs a CLI without a shell. Node refuses to spawn a `.cmd`/`.bat`
 * directly (CVE-2024-27980) and `Commands` will not pass message text through cmd.exe, so an npm/pnpm launcher
 * is replaced by the `.js` script it launches, run by the Host's own node. A `.js` path, a real executable and
 * every POSIX command pass through unchanged. Used by both the Feishu Source and the TAPD MCP transport.
 */
export function cliArgv(cli: string, path = process.env.PATH ?? '', windows = WINDOWS): string[] {
  if (/\.[cm]?js$/i.test(cli)) return [process.execPath, cli]
  // A resolved absolute CLI (setup already verified it) must pass through untouched: re-running the PATH lookup
  // here would make Host-side calls depend on the file being executable at call time, and breaks stand-in CLIs.
  const found = isAbsolute(cli) ? cli : executable(cli, path, undefined, windows)
  if (!windows || !/\.(cmd|ps1|bat)$/i.test(found)) return [found]
  const launcher = found.replace(/\.(ps1|bat)$/i, '.cmd')
  const text = readFileSync(launcher, 'utf8')
  const script = /"%dp0%\\([^"]+\.[cm]?js)"/i.exec(text)?.[1]
  if (!script) throw new Error(`${cli} is a launcher dsh-superagent cannot read; set the CLI to its .js script`)
  return [process.execPath, join(dirname(launcher), script)]
}

/** Runs a startup check; `env` adds variables over the scrubbed worker environment. */
export type Probe = (argv: string[], env?: Record<string, string>) => Promise<string>
/**
 * Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary.
 * VsSaros patch (Windows): the variables go through the subprocess service's `env` instead of an `env NAME=value …` prefix,
 * which needs a POSIX `env` program.
 */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return (argv, env) => runAsWorker(subprocess, argv, cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]), { ...env, PATH: path })
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? '',
  profiles: LarkProfiles = larkProfiles()): Promise<FeishuBot | undefined> {
  const { cli: name, appId } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const call = (...args: string[]): Promise<string> => probe([cli, ...args], { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }).catch(fail)
  // VsSaros addition: with an app named, every check below runs under that app's profile, added first if it is missing.
  const profile = appId ? await larkProfileOf(appId, cli, call, path, profiles, fail) : undefined
  const run = (...args: string[]): Promise<string> => call(...profileArgs(profile), ...args)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (appId && status.appId !== appId) fail(new SetupError('feishuAppMismatch', { app: appId, profile: profile ?? '', actual: status.appId }))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name, ...profile ? { profile } : {} }
}
const ProfileList = z.array(z.looseObject({ name: z.string(), appId: z.string().optional() }))
/** The lark-cli profile of `appId`: an existing one (by app, then by name), else one added from the Bots' secret for it. */
async function larkProfileOf(appId: string, cli: string, call: (...args: string[]) => Promise<string>, path: string,
  profiles: LarkProfiles, fail: (error: unknown) => never): Promise<string> {
  const text = await call('profile', 'list')
  const listed = parsed(ProfileList, text.slice(Math.max(0, text.indexOf('[')))) ?? []
  const found = listed.find(profile => profile.appId === appId) ?? listed.find(profile => profile.name === appId)
  if (found) return found.name
  const secret = profiles.secret(appId)
  if (!secret) return fail(new SetupError('feishuAppMissing', { app: appId }))
  try { await profiles.create(cliArgv(cli, path), appId, secret) }
  catch (error) { fail(new SetupError('feishuProfileFailed', { app: appId, output: reason(error) })) }
  return appId
}
