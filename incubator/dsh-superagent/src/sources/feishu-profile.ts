/**
 * VsSaros addition: a lark-cli profile per Feishu app, so the Feishu Source can be pointed at an app by its ID.
 *
 * lark-cli keeps several apps as named profiles and every command selects one with `--profile` (lark-cli names a profile
 * after its app by default). When the Source names an app that has no profile yet, setup adds one from the secret the
 * VsSaros Bots already keep for that app, so the secret is entered once, in the Bots channel settings. The secret goes to
 * lark-cli through stdin only (never an argument, a log line or a setting), and the new profile is restricted to the bot
 * identity at once: Executors call this CLI too, and a profile that also allowed a user identity would let them act as
 * that user. Profiles that already exist are never changed; setup only checks them.
 */
import { spawn } from 'node:child_process'
import { botsAppSecret } from './feishu-share.ts'

export interface LarkProfiles {
  /** The app's secret where the VsSaros Bots keep it, if they know the app. */
  secret(appId: string): string | undefined
  /** Adds a bot-only profile named after the app; `argv` is the shell-free argv of lark-cli. */
  create(argv: string[], appId: string, secret: string): Promise<void>
}

const ENV = { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }

/** Runs lark-cli with `input` on stdin; a failure names the command and lark-cli's message, never the input. */
export function runLark(argv: string[], args: string[], input = '', timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const [program, ...prefix] = argv
    const child = spawn(program!, [...prefix, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...ENV } })
    let out = '', err = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { err += String(chunk) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`lark-cli ${args.filter(arg => !arg.startsWith('--')).slice(0, 2).join(' ')} exited with ${code}: ${(err || out).trim().slice(0, 400)}`))
    })
    child.stdin.end(input)
  })
}

export const larkProfiles = (): LarkProfiles => ({
  secret: appId => botsAppSecret(appId),
  async create(argv, appId, secret) {
    await runLark(argv, ['profile', 'add', '--name', appId, '--app-id', appId, '--app-secret-stdin', '--brand', 'feishu'], `${secret}\n`)
    await runLark(argv, ['--profile', appId, 'config', 'strict-mode', 'bot'])
  },
})
