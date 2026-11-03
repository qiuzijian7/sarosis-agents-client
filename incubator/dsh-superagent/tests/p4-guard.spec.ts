/**
 * VsSaros addition: the workers' p4 guard, run for real with node against a stand-in p4 that prints the arguments it got,
 * and on Windows through the `p4.cmd` shim from cmd.exe and PowerShell.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { p4GuardFile, p4GuardScript, workerBin, writeEnvironment, type P4Guard } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
const windows = process.platform === 'win32'
let dir: string
let guard: P4Guard
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p4-guard-'))
  const fake = join(dir, 'fake-p4.mjs')
  // It reads stdin only for a form (`-i`), as p4 does, so a shell's open stdin does not keep it waiting.
  writeFileSync(fake, 'const args = process.argv.slice(2); const print = input => process.stdout.write(JSON.stringify({ args, input })); if (!args.includes("-i")) print(""); else { let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", d => { input += d }); process.stdin.on("end", () => print(input)) }')
  guard = { program: [process.execPath, fake], port: 'ssl:p4.example.com:1666', user: 'saros-bot', deniedClients: ['qiuzijian-submit'] }
  writeFileSync(join(dir, 'guard.mjs'), p4GuardScript(guard))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
/** Runs `p4 <args>` through the guard; resolves with what the stand-in p4 got, or rejects with the guard's refusal. */
async function p4(...args: string[]): Promise<{ args: string[]; input: string }> {
  const running = exec(process.execPath, [join(dir, 'guard.mjs'), ...args])
  running.child.stdin?.end(args.includes('-i') ? 'Change:\tnew\n' : '')
  return JSON.parse((await running).stdout) as { args: string[]; input: string }
}
const refused = (message: string | RegExp) => expect.objectContaining({ code: 1, stderr: expect.stringMatching(message) })

describe('the p4 guard', () => {
  it('runs an allowed command with the Source\'s server and execution account first, and passes its stdin', async () => {
    expect((await p4('-c', 'superagent-fix', 'edit', '//GR/main/Source/A.cpp')).args)
      .toEqual(['-p', 'ssl:p4.example.com:1666', '-u', 'saros-bot', '-c', 'superagent-fix', 'edit', '//GR/main/Source/A.cpp'])
    expect(await p4('-u', 'saros-bot', 'shelve', '-c', '501')).toMatchObject({ args: expect.arrayContaining(['shelve', '-c', '501']) })
    expect(await p4('change', '-i')).toMatchObject({ input: 'Change:\tnew\n' })
    expect((await p4('-Mj', '-ztag', 'describe', '-S', '501')).args).toContain('describe')
    expect((await p4('login', '-s')).args).toContain('login')
  })
  it('refuses submit, and every command off the list', async () => {
    await expect(p4('submit', '-c', '501')).rejects.toEqual(refused('workers never submit'))
    await expect(p4('-c', 'superagent-fix', 'submit')).rejects.toEqual(refused('workers never submit'))
    for (const command of ['populate', 'obliterate', 'protect', 'admin', 'set', 'tickets', 'logout', 'triggers', 'user', 'stream', 'copy', 'integrate']) {
      await expect(p4(command)).rejects.toEqual(refused(`${command} is not allowed`))
    }
  })
  it('refuses another account, server, password, host, an argument file and the submit workspace', async () => {
    await expect(p4('-u', 'qiuzijian', 'edit', 'x')).rejects.toEqual(refused('act only as saros-bot'))
    await expect(p4('-uqiuzijian', 'edit', 'x')).rejects.toEqual(refused('act only as saros-bot'))
    await expect(p4('-p', 'other:1666', 'info')).rejects.toEqual(refused('use only ssl:p4.example.com:1666'))
    await expect(p4('-P', 'ticket', 'info')).rejects.toEqual(refused('-P and -H'))
    await expect(p4('-H', 'host', 'info')).rejects.toEqual(refused('-P and -H'))
    await expect(p4('-x', 'args.txt')).rejects.toEqual(refused('argument files'))
    await expect(p4('-c', 'qiuzijian-submit', 'unshelve', '-s', '501')).rejects.toEqual(refused('not a worker\'s'))
  })
  it('refuses deleting or forcing a workspace or changelist spec, and logging in other than to check', async () => {
    await expect(p4('client', '-d', 'superagent-fix')).rejects.toEqual(refused('client -d and -f'))
    await expect(p4('workspace', '-df', 'other')).rejects.toEqual(refused('workspace -d and -f'))
    await expect(p4('change', '-f', '-i')).rejects.toEqual(refused('change -f'))
    await expect(p4('change', '-u', '501')).rejects.toEqual(refused('change -f'))
    await expect(p4('login', '-a')).rejects.toEqual(refused('login only as login -s'))
    expect((await p4('client', '-t', 'superagent-template', '-o', 'superagent-fix')).args).toContain('-t')
    expect((await p4('change', '-d', '501')).args).toContain('-d')
  })
})

describe('the p4 shim', () => {
  it('is written with the guard when the p4 Source is set up, and left out when p4 is blocked', async () => {
    const shim = windows ? 'p4.cmd' : 'p4'
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), [], undefined, guard)
    expect(readdirSync(workerBin(dir))).toContain(shim)
    expect(readFileSync(join(workerBin(dir), shim), 'utf8')).toContain(p4GuardFile(dir))
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['p4'], undefined, guard)
    expect(readFileSync(join(workerBin(dir), shim), 'utf8')).toContain('p4 is blocked')
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), [])
    expect(readdirSync(workerBin(dir))).not.toContain(shim)
  })
  it.runIf(windows)('is what cmd.exe and PowerShell run for `p4`, and refuses submit there too', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), [], undefined, guard)
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH')),
      Path: [workerBin(dir), process.env.PATH ?? ''].join(delimiter) }
    const viaCmd = await exec('cmd.exe', ['/d', '/c', 'p4 -c superagent-fix opened'], { env })
    expect(JSON.parse(viaCmd.stdout)).toMatchObject({ args: ['-p', 'ssl:p4.example.com:1666', '-u', 'saros-bot', '-c', 'superagent-fix', 'opened'] })
    const viaPwsh = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'p4 info'], { env })
    expect(JSON.parse(viaPwsh.stdout)).toMatchObject({ args: expect.arrayContaining(['info']) })
    await expect(exec('cmd.exe', ['/d', '/c', 'p4 submit -c 501'], { env })).rejects.toEqual(refused('workers never submit'))
  })
})
