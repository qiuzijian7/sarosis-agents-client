/**
 * VsSaros addition: the Feishu Source names its app, and lark-cli runs under that app's profile (`--profile`).
 * An in-memory lark-cli stands in for the probe so the cases run on Windows as well as POSIX; the CLI file itself is a
 * real temporary file because setup resolves it on PATH, and `runLark` is exercised with a real child process.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cliArgv, Config, FeishuBotSchema, larkArgv, machineOf, resolveFeishuBot, SETUP_FIELDS, type Probe } from '../src/deployment.ts'
import { shimFile } from '../src/infra/environment.ts'
import { runLark, type LarkProfiles } from '../src/sources/feishu-profile.ts'
import { BUNDLED_FEISHU_APP, botsAppSecret } from '../src/sources/feishu-share.ts'
import { feishuKind } from '../src/sources/feishu.ts'

const windows = process.platform === 'win32'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-lark-profile-'))
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  const file = join(dir, windows ? 'lark-cli.cmd' : 'lark-cli')
  writeFileSync(file, windows ? '@"%dp0%\\node_modules\\@larksuite\\cli\\scripts\\run.js" %*\r\n' : '#!/bin/sh\n')
  if (!windows) chmodSync(file, 0o755)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const machine = () => machineOf(Config({ stateDir: join(dir, 'state') }))
const setupError = (code: string, values: Record<string, unknown> = {}) =>
  expect.objectContaining({ place: 'feishu', code, values: expect.objectContaining(values) })

/** A lark-cli with named profiles; `active` is the one used without `--profile`. */
function lark(profiles: { name: string; appId: string; mode?: string }[], active = profiles[0]?.name ?? '') {
  const calls: string[][] = []
  const probe: Probe = async argv => {
    let args = argv.slice(1)
    calls.push(args)
    let name = active
    if (args[0] === '--profile') { name = args[1]!; args = args.slice(2) }
    const command = args.join(' ')
    if (command === 'profile list') return JSON.stringify(profiles.map(({ name, appId }) => ({ name, appId })))
    const profile = profiles.find(candidate => candidate.name === name)
    if (!profile) throw new Error(`profile "${name}" not found`)
    if (command === 'auth status') return JSON.stringify({ appId: profile.appId, brand: 'feishu', identities: { bot: { status: 'ready' } } })
    if (command === 'config strict-mode') return `strict-mode: ${profile.mode ?? 'bot'} (source: profile "${name}")`
    if (command === 'api GET /open-apis/bot/v3/info --as bot --format ndjson')
      return JSON.stringify({ code: 0, bot: { open_id: `ou_${profile.appId.replace(/_/g, '')}`, app_name: `${profile.appId} bot` } })
    throw new Error(`unexpected: ${command}`)
  }
  return { calls, probe, profiles }
}
const keeping = (secrets: Record<string, string>, onCreate?: (appId: string) => void) => {
  const created: { argv: string[]; appId: string; secret: string }[] = []
  const profiles: LarkProfiles = {
    secret: appId => secrets[appId],
    create: vi.fn(async (argv, appId, secret) => { created.push({ argv, appId, secret }); onCreate?.(appId) }),
  }
  return { created, profiles }
}

describe('the Feishu app of the Source', () => {
  it('is a setup field, so changing it rereads the bot and restarts', () => {
    expect(SETUP_FIELDS.feishu).toEqual(['cli', 'appId'])
    expect(FeishuBotSchema.parse({ cli: 'lark-cli' }).appId).toBe('')
    expect(() => FeishuBotSchema.parse({ cli: 'lark-cli', appId: 'not-an-app' })).toThrow()
  })
  it('ships the CLI command and app ID as Source defaults, without changing the deployment contract', () => {
    expect(feishuKind.schema.parse({})).toMatchObject({ cli: 'lark-cli', appId: BUNDLED_FEISHU_APP.appId })
    expect(feishuKind.fields.some(spec => spec.key === 'cli')).toBe(false)
    expect(feishuKind.fields.some(spec => spec.key === 'appId')).toBe(true)
    expect(FeishuBotSchema.parse({})).toMatchObject({ cli: '', appId: '' })
  })
  it('leaves the active profile in use when no app is named', async () => {
    const cli = lark([{ name: 'cli_main', appId: 'cli_main' }])
    const bot = await resolveFeishuBot(machine(), { cli: 'lark-cli' }, cli.probe, dir, keeping({}).profiles)
    expect(bot).toMatchObject({ appId: 'cli_main', botId: 'ou_climain' })
    expect(bot).not.toHaveProperty('profile')
    expect(cli.calls.some(args => args.includes('--profile') || args[0] === 'profile')).toBe(false)
  })
  it('runs every check under the app\'s existing profile, found by app before name', async () => {
    const cli = lark([{ name: 'cli_main', appId: 'cli_main' }, { name: 'design', appId: 'cli_design' }])
    const { profiles } = keeping({})
    const bot = await resolveFeishuBot(machine(), { cli: 'lark-cli', appId: 'cli_design' }, cli.probe, dir, profiles)
    expect(bot).toMatchObject({ appId: 'cli_design', profile: 'design', botId: 'ou_clidesign', name: 'cli_design bot' })
    expect(cli.calls.filter(args => args[0] !== 'profile').every(args => args[0] === '--profile' && args[1] === 'design')).toBe(true)
    expect(profiles.create).not.toHaveBeenCalled()
  })
  it('adds a bot-only profile from the secret the Bots keep, when the app has none', async () => {
    const cli = lark([{ name: 'cli_main', appId: 'cli_main' }])
    const { created, profiles } = keeping({ cli_new: 's3cret' }, appId => { cli.profiles.push({ name: appId, appId }) })
    const bot = await resolveFeishuBot(machine(), { cli: 'lark-cli', appId: 'cli_new' }, cli.probe, dir, profiles)
    expect(bot).toMatchObject({ appId: 'cli_new', profile: 'cli_new' })
    expect(created).toEqual([{ argv: cliArgv(join(dir, windows ? 'lark-cli.cmd' : 'lark-cli'), dir), appId: 'cli_new', secret: 's3cret' }])
    // The secret never reaches a probe argument.
    expect(cli.calls.flat()).not.toContain('s3cret')
  })
  it('names what to do when the app has no profile and the Bots do not know it', async () => {
    const cli = lark([{ name: 'cli_main', appId: 'cli_main' }])
    const { profiles } = keeping({})
    await expect(resolveFeishuBot(machine(), { cli: 'lark-cli', appId: 'cli_unknown' }, cli.probe, dir, profiles))
      .rejects.toEqual(setupError('feishuAppMissing', { app: 'cli_unknown' }))
    expect(profiles.create).not.toHaveBeenCalled()
  })
  it('reports a profile lark-cli could not add, a profile of another app, and a profile allowing user identities', async () => {
    const failing: LarkProfiles = { secret: () => 's3cret', create: async () => { throw new Error('lark-cli profile add exited with 1: bad secret') } }
    await expect(resolveFeishuBot(machine(), { cli: 'lark-cli', appId: 'cli_new' }, lark([{ name: 'cli_main', appId: 'cli_main' }]).probe, dir, failing))
      .rejects.toEqual(setupError('feishuProfileFailed', { app: 'cli_new', output: expect.not.stringContaining('s3cret') }))
    const odd = lark([{ name: 'cli_main', appId: 'cli_main' }])
    // A profile listed under the app's name whose credentials belong to another app.
    odd.profiles.push({ name: 'cli_x', appId: 'cli_x' })
    const probe: Probe = async argv => argv.slice(1).join(' ') === 'profile list' ? JSON.stringify([{ name: 'cli_x' }]) : odd.probe(argv)
    odd.profiles[1]!.appId = 'cli_other'
    await expect(resolveFeishuBot(machine(), { cli: 'lark-cli', appId: 'cli_x' }, probe, dir, keeping({}).profiles))
      .rejects.toEqual(setupError('feishuAppMismatch', { app: 'cli_x', profile: 'cli_x', actual: 'cli_other' }))
    const loose = lark([{ name: 'cli_main', appId: 'cli_main' }, { name: 'cli_loose', appId: 'cli_loose', mode: 'off' }])
    await expect(resolveFeishuBot(machine(), { cli: 'lark-cli', appId: 'cli_loose' }, loose.probe, dir, keeping({}).profiles))
      .rejects.toEqual(setupError('feishuUserIdentity', { mode: 'off' }))
  })
})

describe('calling lark-cli under the profile', () => {
  it('appends the profile to the shell-free argv the Host uses', () => {
    const cli = join(dir, windows ? 'lark-cli.cmd' : 'lark-cli')
    expect(larkArgv({ cli, profile: 'cli_a' }, dir)).toEqual([...cliArgv(cli, dir), '--profile', 'cli_a'])
    expect(larkArgv({ cli }, dir)).toEqual(cliArgv(cli, dir))
  })
  it('pins the workers\' lark-cli shim to the profile', () => {
    expect(shimFile('lark-cli', '/state/worker-bin', { run: '/usr/bin/lark-cli', with: ['--profile', 'cli_a'] }, false).text)
      .toContain(`exec '/usr/bin/lark-cli' '--profile' 'cli_a' "$@"`)
    expect(shimFile('lark-cli', 'C:\\state\\worker-bin', { run: 'C:\\npm\\lark-cli.cmd', with: ['--profile', 'cli_a'] }, true).text)
      .toContain('call "C:\\npm\\lark-cli.cmd" "--profile" "cli_a" %*')
    const environment = readFileSync(new URL('../src/infra/environment.ts', import.meta.url), 'utf8')
    expect(environment).toContain("with: feishu.profile ? ['--profile', feishu.profile] : []")
  })
  it('hands the secret to lark-cli on stdin only, and keeps it out of a failure', async () => {
    const script = join(dir, 'echo.mjs')
    writeFileSync(script, `let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  if (process.argv.includes('--fail')) { console.error('refused'); process.exit(3) }
  console.log(JSON.stringify({ args: process.argv.slice(2), input }))
})
`)
    const out = JSON.parse(await runLark([process.execPath, script], ['profile', 'add', '--name', 'cli_a', '--app-secret-stdin'], 's3cret\n'))
    expect(out).toEqual({ args: ['profile', 'add', '--name', 'cli_a', '--app-secret-stdin'], input: 's3cret\n' })
    const failure = runLark([process.execPath, script], ['profile', 'add', '--fail'], 's3cret\n')
    await expect(failure).rejects.toThrow('lark-cli profile add exited with 3: refused')
    await expect(failure.catch((error: Error) => error.message)).resolves.not.toContain('s3cret')
  })
})

describe('the secret the Bots keep', () => {
  it('is read from their data root: the default app, then the extra apps', () => {
    const root = join(dir, 'data')
    mkdirSync(root)
    writeFileSync(join(root, 'agent-im-accounts.json'), JSON.stringify({ version: 1, accounts: {
      feishu: { appId: 'cli_main', appSecret: 'main' }, feishuApps: { cli_extra: { appSecret: 'extra' }, cli_empty: { appSecret: ' ' } } } }))
    const env = { VSSAROS_DATA_ROOT: root }
    expect(['cli_main', 'cli_extra', 'cli_empty', 'cli_none', ''].map(app => botsAppSecret(app, env, dir)))
      .toEqual(['main', 'extra', undefined, undefined, undefined])
    mkdirSync(join(dir, '.vssaros'))
    writeFileSync(join(dir, '.vssaros', 'agent-im-accounts.json'), JSON.stringify({ accounts: { feishu: { appId: 'cli_rel', appSecret: 'rel' } } }))
    expect(botsAppSecret('cli_rel', {}, dir)).toBe('rel')
  })
  it('falls back to the app shipped with the product, and a configured secret still wins', () => {
    const root = join(dir, 'empty-data')
    mkdirSync(root, { recursive: true })
    const env = { VSSAROS_DATA_ROOT: root }
    expect(botsAppSecret(BUNDLED_FEISHU_APP.appId, env, dir)).toBe(BUNDLED_FEISHU_APP.appSecret)
    expect(botsAppSecret('cli_other', env, dir)).toBeUndefined()
    writeFileSync(join(root, 'agent-im-accounts.json'), JSON.stringify({ version: 1,
      accounts: { feishu: { appId: BUNDLED_FEISHU_APP.appId, appSecret: 'mine' } } }))
    expect(botsAppSecret(BUNDLED_FEISHU_APP.appId, env, dir)).toBe('mine')
  })
})

