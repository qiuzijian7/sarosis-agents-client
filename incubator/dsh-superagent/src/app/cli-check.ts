/**
 * VsSaros addition: local diagnostics and maintenance for the Feishu Source's `lark-cli`.
 *
 * Reads go through the same `Probe` that setup uses, so PATH and the excluded worker shim directory
 * are identical to the ones `resolveFeishuBot` sees. Write actions are separate and require an
 * explicit `confirm` produced by the panel's confirmation dialog.
 */
import { executable, type Probe } from '../deployment.ts'
import { workerBin } from '../infra/environment.ts'

/** Read-only view of the local `lark-cli`; a missing command or a failed probe is reported, never thrown. */
export interface CliCheckResult {
  found: boolean
  /** The value the panel should put in the `cli` field when the command is found. */
  command: string
  resolved?: string
  version?: string
  appId?: string
  botReady?: boolean
  botName?: string
  strictMode?: string
  update?: CliUpdateResult
  /** One line per failed probe; a partial result is still useful. */
  error?: string
}
/** Result of `lark-cli update --check --json`. */
export interface CliUpdateResult {
  currentVersion?: string
  latestVersion?: string
  action?: string
  ok?: boolean
  message?: string
}
export interface CliApplyResult { ok: boolean; output: string }

export type CliApplyAction = 'strict-bot' | 'update'

const COMMAND = 'lark-cli'
const ENV = { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
/** CLI output may carry a banner before the JSON object. */
const json = (text: string): unknown => {
  try { return JSON.parse(text.slice(text.indexOf('{'))) as unknown } catch { return undefined }
}
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

/** Probes the bot CLI for local checks and runs its two confirmed maintenance actions. */
export class CliCheck {
  constructor(private readonly probe: Probe, private readonly path: string, private readonly stateDir: string) {}

  /** Locate the CLI, then read its version, bot identity, strict mode, bot name and (optionally) update status. */
  async check(withUpdate = false): Promise<CliCheckResult> {
    let resolved: string
    try { resolved = executable(COMMAND, this.path, workerBin(this.stateDir)) }
    catch (error) { return { found: false, command: COMMAND, error: String(error) } }
    const run = (...argv: string[]): Promise<string> => this.probe([resolved, ...argv], ENV)
    const result: CliCheckResult = { found: true, command: COMMAND, resolved }
    const record = (error: unknown) => { result.error = [result.error, String(error)].filter(Boolean).join('; ') }
    const attempt = async (read: () => Promise<void>) => { try { await read() } catch (error) { record(error) } }
    await attempt(async () => {
      const version = /(\d+\.\d+\.\d+)/.exec(await run('--version'))?.[1]
      if (version) result.version = version
    })
    await attempt(async () => {
      const status = json(await run('auth', 'status')) as { appId?: string; identities?: { bot?: { status?: string } } } | undefined
      result.appId = string(status?.appId)
      result.botReady = status?.identities?.bot?.status === 'ready'
    })
    await attempt(async () => {
      result.strictMode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1] ?? 'unknown'
    })
    await attempt(async () => {
      const text = await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')
      const info = json(text.split('\n')[0] ?? '') as { bot?: { app_name?: string } } | undefined
      result.botName = string(info?.bot?.app_name)
    })
    if (withUpdate) await attempt(async () => {
      const update = json(await run('update', '--check', '--json')) as Record<string, unknown> | undefined
      result.update = {
        currentVersion: string(update?.current_version), latestVersion: string(update?.latest_version),
        action: string(update?.action), ok: update?.ok === true, message: string(update?.message),
      }
    })
    return result
  }

  /** Confirmed write: restrict the CLI to the bot identity, or let the CLI update itself. */
  async apply(action: CliApplyAction, confirm: boolean): Promise<CliApplyResult> {
    if (!confirm) throw new Error('Confirmation required before changing the local lark-cli')
    const resolved = executable(COMMAND, this.path, workerBin(this.stateDir))
    const argv = action === 'strict-bot' ? ['config', 'strict-mode', 'bot'] : ['update']
    const output = await this.probe([resolved, ...argv], ENV)
    return { ok: true, output: output.trim().slice(0, 4000) }
  }
}
