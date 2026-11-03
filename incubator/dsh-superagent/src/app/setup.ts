/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, executable, githubConfigured, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine, type Probe } from '../deployment.ts'
import { CliCheck } from './cli-check.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment, type P4Guard } from '../infra/environment.ts'
import { P4ConfigSchema } from '../sources/p4-change.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  /** VsSaros addition: local `lark-cli` diagnostics and confirmed maintenance, using the same probe as setup. */
  readonly cli: CliCheck
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
    const probe: Probe = (argv, env) => this.probe()(argv, env)
    this.cli = new CliCheck(probe, this.path, host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    // VsSaros patch (optional GitHub): clearing the GitHub Source's fields leaves it unconfigured, which is not an error.
    if (block === 'source:github' && !githubConfigured(settings.sources.github?.config)) return
    // VsSaros addition: the p4 Source has no account check before saving; the restart writes its guard and its poll reports a bad login.
    if (block === 'source:p4') return
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : resolveDeployment(machine, settings.sources.github?.config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked, undefined, this.p4Guard)
  }
  /** VsSaros addition: the guard the workers' `p4` runs through, from the p4 Source as setup last read it. */
  private p4Guard?: P4Guard
  private guardOf(settings: Settings): P4Guard | undefined {
    const source = settings.sources.p4
    const config = source?.enabled === false ? undefined : P4ConfigSchema.safeParse(source?.config ?? {}).data
    if (!config || !config.port || !config.user) return undefined
    const program = executable(config.cli || 'p4', this.path, workerBin(this.host.machine.stateDir))
    return { program: [program], port: config.port, user: config.user, deniedClients: config.submitClient ? [config.submitClient] : [] }
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    // VsSaros patch (optional GitHub): the GitHub account is checked only when the GitHub Source is on and configured; a
    // deployment that works from TAPD and P4 starts with no GitHub account at all.
    const githubConfig = settings.sources.github
    const withGithub = githubConfig?.enabled !== false && githubConfigured(githubConfig?.config)
    const deployment: Deployment = withGithub ? await resolveDeployment(machine, githubConfig?.config, probe) : { ...machine }
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    try { this.p4Guard = this.guardOf(settings) } catch (error) { machineProblem(new Error(`The p4 Source's p4 command: ${String(error)}`)) }
    await writeEnvironment(resolved, settings.executor.blockedCommands, undefined, this.p4Guard).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
