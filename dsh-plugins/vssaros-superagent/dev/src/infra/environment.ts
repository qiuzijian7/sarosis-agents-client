/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  // VsSaros patch (Windows): a `.cmd` shim has CRLF lines and carries the marker as a `@rem` comment.
  const head = (await readFile(file, 'utf8')).split('\n', 2).map(line => line.replace(/\r$/, '').replace(/^@rem /, ''))
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/** Characters a `.cmd` shim cannot carry safely in its shim directory path (they act inside `%PATH:…=…%` and `set "…"`). */
const CMD_UNSAFE = /[%!"^=&|<>]/
/** Escapes text for `echo` in a `.cmd` file. */
const cmdEcho = (text: string): string => text.replace(/[\^&|<>()%!]/g, char => (char === '%' ? '%%' : `^${char}`))

/**
 * The text of one worker shim. POSIX shims are `/bin/sh` scripts named after the command; on Windows (VsSaros patch) a
 * shim is `<name>.cmd`, which cmd.exe and PowerShell both find through PATHEXT ahead of the real program because the shim
 * directory comes first on PATH. A `.cmd` shim removes its own directory from PATH with `%PATH:<dir>;=%`, so a wrapper that
 * calls the command by name reaches the real program, not the shim again.
 */
export type ShimAction = { run: string; with?: readonly string[] } | { fail: string }
export function shimFile(name: string, dir: string, action: ShimAction, windows = process.platform === 'win32'): { file: string; text: string } {
  // VsSaros addition: `with` are arguments the program always gets first, such as the script `node` runs.
  const leading = 'run' in action ? action.with ?? [] : []
  if (!windows) {
    const withoutShims = [
      `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
      'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
      'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
    ].join('\n')
    const body = 'run' in action ? `${withoutShims}\nexec ${[action.run, ...leading].map(shellQuote).join(' ')} "$@"` : `echo ${shellQuote(action.fail)} >&2\nexit 1`
    return { file: name, text: `#!/bin/sh\n${MARKER}\n${body}\n` }
  }
  if (CMD_UNSAFE.test(dir)) throw new SetupError('environmentFailed', { output: `The state directory ${dir} has a character a Windows command shim cannot carry (one of % ! " ^ = & | < >); choose another stateDir.` })
  const lines = ['@echo off', `@rem ${MARKER}`, 'setlocal']
  if ('run' in action) {
    const unsafe = [action.run, ...leading].find(part => /["%]/.test(part))
    if (unsafe !== undefined) throw new SetupError('environmentFailed', { output: `The program path ${unsafe} has a character a Windows command shim cannot carry.` })
    const call = /\.(cmd|bat)$/i.test(action.run) ? 'call ' : ''
    lines.push(`set "PATH=%PATH:${dir};=%"`, `${call}${[action.run, ...leading].map(part => `"${part}"`).join(' ')} %*`, 'exit /b %ERRORLEVEL%')
  } else {
    // The redirection goes first: `echo text 1>&2` would print the space before it too.
    lines.push(`>&2 echo ${cmdEcho(action.fail)}`, 'exit /b 1')
  }
  return { file: `${name}.cmd`, text: `${lines.join('\r\n')}\r\n` }
}

/**
 * VsSaros addition: what the workers' `p4` may do. `program` is the argv prefix of the real p4 (`[p4.exe]`); every command
 * runs with `-p port -u user`, and a workspace in `deniedClients` (the submit workspace) is never used.
 */
export interface P4Guard { program: string[]; port: string; user: string; deniedClients: string[] }
export const p4GuardFile = (stateDir: string): string => join(stateDir, 'p4-guard.mjs')
/**
 * Commands a worker may run with p4: reading, opening and shelving files in its own workspace. Left out on purpose: submit,
 * populate, obliterate, protect, admin, set, tickets, logout, triggers and every other spec or admin command.
 */
export const P4_ALLOWED: readonly string[] = ['add', 'annotate', 'change', 'changelist', 'changes', 'changelists', 'client', 'clients', 'delete',
  'describe', 'diff', 'diff2', 'dirs', 'edit', 'filelog', 'files', 'fstat', 'grep', 'have', 'help', 'info', 'integrated', 'login', 'move',
  'opened', 'print', 'reconcile', 'reopen', 'resolve', 'resolved', 'revert', 'shelve', 'status', 'sync', 'unshelve', 'where', 'workspace', 'workspaces']
/**
 * The guard script `p4` runs through: a plain ES module run by the Host's node, so it needs nothing installed. It refuses a
 * command off `P4_ALLOWED`, a forbidden option (another account, server, password or host, an argument file `-x`, a denied
 * workspace, or `-f`/`-d` on workspace and changelist specs), then runs the real p4 with the guard's server and account.
 */
export function p4GuardScript(guard: P4Guard): string {
  return `/*
${MARKER}
*/
// The p4 guard of dsh-superagent's workers. It is a guardrail on the default path, not a security boundary: the execution
// account's server permissions are what keep a worker from submitting.
import { spawnSync } from 'node:child_process'
const guard = ${JSON.stringify(guard)}
const allowed = new Set(${JSON.stringify(P4_ALLOWED)})
const refuse = message => { process.stderr.write(\`p4 (dsh-superagent): \${message}\\n\`); process.exit(1) }
const valued = new Set(['b', 'c', 'C', 'd', 'H', 'L', 'M', 'p', 'P', 'Q', 'r', 'u', 'v', 'x', 'z'])
const args = process.argv.slice(2)
const globals = {}
let index = 0
while (index < args.length && args[index].startsWith('-') && args[index].length > 1) {
  const flag = args[index][1]
  if (valued.has(flag)) {
    const value = args[index].length > 2 ? args[index].slice(2) : args[++index]
    if (value === undefined) refuse(\`-\${flag} needs a value\`)
    globals[flag] = value
  }
  index++
}
if ('x' in globals) refuse('argument files (-x) are not allowed')
if ('P' in globals || 'H' in globals) refuse('-P and -H are not allowed')
if ('u' in globals && globals.u !== guard.user) refuse(\`workers act only as \${guard.user}\`)
if ('p' in globals && globals.p !== guard.port) refuse(\`workers use only \${guard.port}\`)
if ('c' in globals && guard.deniedClients.includes(globals.c)) refuse(\`the workspace \${globals.c} is not a worker's\`)
const command = args[index]
const rest = args.slice(index + 1)
if (command === undefined) refuse('name a command')
if (command === 'submit') refuse('workers never submit: shelve the changelist and report it ready, and a person reviews and approves the submit')
if (!allowed.has(command)) refuse(\`\${command} is not allowed for workers\`)
// An option given alone (-f) or in a group of letters (-df); a refusal by mistake is safer than a bypass.
const has = (...options) => rest.some(arg => options.includes(arg) || (/^-[a-zA-Z]{2,}$/.test(arg) && options.some(option => arg.includes(option[1]))))
if (['client', 'workspace'].includes(command) && has('-d', '-f')) refuse(\`\${command} -d and -f are not allowed for workers\`)
if (['change', 'changelist'].includes(command) && has('-f', '-u', '-U', '-t')) refuse(\`\${command} -f, -u, -U and -t are not allowed for workers\`)
if (command === 'login' && (rest.length !== 1 || rest[0] !== '-s')) refuse('login only as login -s')
const [program, ...prefix] = guard.program
const result = spawnSync(program, [...prefix, '-p', guard.port, '-u', guard.user, ...args], { stdio: 'inherit', windowsHide: true })
if (result.error) refuse(String(result.error))
process.exit(result.status ?? 1)
`
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 * VsSaros patch (optional GitHub): without a GitHub account `gh` fails with a message, and git gets no GitHub credential helper.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[], windows = process.platform === 'win32',
  p4?: P4Guard): Promise<void> {
  const { stateDir, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, action: ShimAction): Promise<void> => {
    const { file, text } = shimFile(name, dir, action, windows)
    const temporary = join(dir, `.${file}.${process.pid}.tmp`)
    await writeFile(temporary, text, { mode: 0o755 })
    await rename(temporary, join(dir, file))
    kept.add(file)
  }
  await shim('gh', github ? { run: github.cli } : { fail: 'gh is unavailable: this installation has no GitHub account.' })
  // VsSaros addition: with the Source naming an app, the workers' lark-cli is pinned to that app's bot-only profile.
  await shim('lark-cli', feishu ? { run: feishu.cli, with: feishu.profile ? ['--profile', feishu.profile] : [] } : { fail: 'lark-cli is unavailable: this installation has no Feishu bot.' })
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, { fail: github ? `${name} is blocked in this installation; use gh, which acts as ${github.login}.` : `${name} is blocked in this installation.` })
  }
  // VsSaros addition: with the p4 Source set up, the workers' p4 runs through its guard, unless p4 is blocked outright.
  if (p4 && !blockedCommands.includes('p4')) {
    await own(p4GuardFile(stateDir), p4GuardScript(p4))
    await shim('p4', { run: process.execPath, with: [p4GuardFile(stateDir)] })
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    ...github ? [
      '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
      '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    ] : [],
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/**
 * The file a `git config --show-origin` origin names. VsSaros patch (Windows): Git for Windows quotes a path that has a
 * backslash (`file:"C:\\Users\\…"`) even with `-z`, so the origin is unquoted before it is compared.
 */
export function originFile(origin: string): string {
  const quoted = /^file:"((?:[^"\\]|\\.)*)"$/.exec(origin)
  return quoted ? `file:${quoted[1]!.replace(/\\(.)/g, '$1')}` : origin
}

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper; without a GitHub account there is none to verify. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  if (!github) return
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  if (helpers[0] !== undefined) helpers[0] = originFile(helpers[0])
  if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')) throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
