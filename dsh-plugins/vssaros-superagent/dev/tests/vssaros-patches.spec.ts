/**
 * VsSaros patch set: Windows support and the optional GitHub Source. Pure checks run everywhere; the shim cases run real
 * `.cmd` shims through cmd.exe and Windows PowerShell (the worker shell on Windows) and so run on Windows only.
 */
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, githubConfigured, githubOf, machineOf } from '../src/deployment.ts'
import { originFile, shimFile, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
const windows = process.platform === 'win32'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vssaros-patches-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('state directory', () => {
  it('takes an absolute path in POSIX or Windows form, and nothing relative', () => {
    for (const stateDir of ['/srv/state', 'C:\\Users\\me\\state', 'd:/state', '\\\\server\\share\\state']) {
      expect(machineOf(Config({ stateDir })).stateDir).toBe(stateDir)
    }
    for (const stateDir of ['relative/dir', '~/dir', 'C:state', '.\\state']) expect(() => Config({ stateDir })).toThrow()
  })
})

describe('executable on Windows', () => {
  const file = (name: string): string => { const path = join(dir, name); writeFileSync(path, ''); chmodSync(path, 0o755); return path }
  it('finds a bare name through PATHEXT and never picks a file without one of its extensions from PATH', () => {
    file('tool'); const exe = file('tool.exe')
    expect(executable('tool', dir, undefined, true)).toBe(exe)
    expect(executable('tool.EXE', dir, undefined, true)).toBe(join(dir, 'tool.EXE'))
    file('only'); expect(() => executable('only', dir, undefined, true)).toThrow('only is not an executable file on PATH')
  })
  it('takes an absolute path as given, or with a PATHEXT extension when no file has exactly that name', () => {
    const plain = file('agent-gh'); const exe = file('lark.exe')
    expect(executable(plain, '', undefined, true)).toBe(plain)
    expect(executable(join(dir, 'lark'), '', undefined, true)).toBe(exe)
    expect(() => executable(join(dir, 'absent'), '', undefined, true)).toThrow('is not an executable file')
  })
  it('skips the shim directory and refuses a relative path with either separator', () => {
    const shims = join(dir, 'shims'); mkdirSync(shims); writeFileSync(join(shims, 'gh.cmd'), ''); const real = file('gh.exe')
    expect(executable('gh', [shims, dir].join(delimiter), shims, true)).toBe(real)
    expect(() => executable('bin\\gh', dir, undefined, true)).toThrow('must be a command name or an absolute path')
    expect(() => executable('bin/gh', dir, undefined, true)).toThrow('must be a command name or an absolute path')
  })
})

describe('optional GitHub', () => {
  it('counts the GitHub Source as configured once any of its setup fields is set', () => {
    expect(githubConfigured(undefined)).toBe(false)
    expect(githubConfigured({ repository: '', cli: '  ' })).toBe(false)
    expect(githubConfigured({ repository: 'acme/widgets' })).toBe(true)
    expect(githubConfigured({ cli: 'gh' })).toBe(true)
  })
  it('names what to set when code needs the GitHub account of a deployment that has none', () => {
    const { repository: _repository, github: _github, ...rest } = testDeployment()
    expect(() => githubOf({})).toThrow('The GitHub Source is not set up')
    expect(() => new Commands(() => rest, {}, new AbortController().signal).repository).toThrow('The GitHub Source is not set up')
    expect(githubOf(testDeployment()).repository).toBe(testDeployment().repository)
  })
  it('writes a gh that fails and no GitHub credential helper without a GitHub account', async () => {
    const { repository: _repository, github: _github, ...rest } = testDeployment({ stateDir: dir, feishu: undefined })
    await writeEnvironment(rest, ['personal-gh'])
    const name = (command: string) => (windows ? `${command}.cmd` : command)
    expect(readdirSync(workerBin(dir)).sort()).toEqual([name('gh'), name('lark-cli'), name('personal-gh')].sort())
    expect(readFileSync(join(workerBin(dir), name('gh')), 'utf8')).toContain('gh is unavailable: this installation has no GitHub account.')
    expect(readFileSync(join(workerBin(dir), name('personal-gh')), 'utf8')).toContain('personal-gh is blocked in this installation.')
    expect(readFileSync(workerGitConfig(dir), 'utf8')).not.toContain('credential "https://github.com"')
  })
})

describe('git origin', () => {
  it('unquotes the origin path Git for Windows quotes, and leaves an unquoted one alone', () => {
    expect(originFile('file:"C:\\\\Users\\\\me\\\\state\\\\worker-gitconfig"')).toBe('file:C:\\Users\\me\\state\\worker-gitconfig')
    expect(originFile('file:/srv/state/worker-gitconfig')).toBe('file:/srv/state/worker-gitconfig')
  })
})

describe('shim text', () => {
  it('writes a POSIX shim as an sh script and a Windows shim as a .cmd that leaves its own directory off PATH', () => {
    expect(shimFile('gh', '/srv/bin', { run: '/usr/bin/gh' }, false)).toMatchObject({ file: 'gh', text: expect.stringMatching(/^#!\/bin\/sh\n/) })
    const { file, text } = shimFile('gh', 'C:\\state\\worker-bin', { run: 'C:\\Program Files\\GitHub CLI\\gh.exe' }, true)
    expect(file).toBe('gh.cmd')
    expect(text.split('\r\n')).toEqual(['@echo off', '@rem # Written by dsh-superagent on every start; edits are lost.', 'setlocal',
      'set "PATH=%PATH:C:\\state\\worker-bin;=%"', '"C:\\Program Files\\GitHub CLI\\gh.exe" %*', 'exit /b %ERRORLEVEL%', ''])
    expect(shimFile('tool', 'C:\\state\\worker-bin', { run: 'C:\\tools\\wrapper.cmd' }, true).text).toContain('call "C:\\tools\\wrapper.cmd" %*')
    expect(shimFile('x', 'C:\\state\\worker-bin', { fail: 'x is blocked (100%) & off' }, true).text).toContain('>&2 echo x is blocked ^(100%%^) ^& off\r\n')
  })
  it('refuses a shim directory or program a .cmd shim cannot carry', () => {
    expect(() => shimFile('gh', 'C:\\50%\\bin', { run: 'C:\\gh.exe' }, true)).toThrow('cannot carry')
    expect(() => shimFile('gh', 'C:\\a=b\\bin', { run: 'C:\\gh.exe' }, true)).toThrow('cannot carry')
    expect(() => shimFile('gh', 'C:\\state\\bin', { run: 'C:\\100%\\gh.exe' }, true)).toThrow('cannot carry')
  })
})

describe.runIf(windows)('Windows worker shims', () => {
  /** An environment with exactly one PATH entry (Windows names it `Path`; a second spelling would shadow it). */
  const withPath = (path: string): NodeJS.ProcessEnv => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'))
    return { ...env, Path: path }
  }
  /** A program the gh shim runs: node with a script that prints its arguments and PATH. */
  function deploy(blocked: string[] = []) {
    const script = join(dir, 'echo.js')
    writeFileSync(script, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), path: process.env.PATH }))')
    const base = testDeployment()
    return { script, write: () => writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github!, cli: process.execPath }, feishu: undefined }), blocked) }
  }
  const rest = (): string => (process.env.PATH ?? '').split(delimiter).filter(Boolean).join(delimiter)
  it('runs the real program from cmd.exe with the arguments as given, and with the shim directory gone from PATH', async () => {
    const { script, write } = deploy(); await write()
    const bin = workerBin(dir)
    // cmd.exe parses its own command line: pass it verbatim, or Node's escaping of the quotes would reach the shim.
    const { stdout } = await exec('cmd.exe', ['/d', '/c', `gh "${script}" api "repos/acme widgets"`], { env: withPath([bin, rest()].join(delimiter)), windowsVerbatimArguments: true })
    const printed = JSON.parse(stdout) as { args: string[]; path: string }
    expect(printed.args).toEqual(['api', 'repos/acme widgets'])
    expect(printed.path.split(delimiter).map(entry => entry.toLowerCase())).not.toContain(bin.toLowerCase())
  })
  it('is what Windows PowerShell finds for `gh` ahead of any other on PATH', async () => {
    const { script, write } = deploy(); await write()
    const bin = workerBin(dir)
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `gh '${script}' issue view 7`], { env: withPath([bin, rest()].join(delimiter)) })
    expect((JSON.parse(stdout) as { args: string[] }).args).toEqual(['issue', 'view', '7'])
  })
  it('makes lark-cli and each blocked command fail with a message on stderr and exit status 1', async () => {
    const { write } = deploy(['personal-gh']); await write()
    const bin = workerBin(dir)
    const env = withPath([bin, rest()].join(delimiter))
    await expect(exec('cmd.exe', ['/d', '/c', 'lark-cli im +chat-list'], { env })).rejects.toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\r\n' })
    await expect(exec('cmd.exe', ['/d', '/c', 'personal-gh'], { env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('personal-gh is blocked in this installation; use gh, which acts as agent-bot.') })
  })
  it('replaces only the shims it wrote, and refuses a file it did not write in the shim directory', async () => {
    const { write } = deploy(['old-cli']); await write()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github!, cli: process.execPath }, feishu: undefined }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh.cmd', 'lark-cli.cmd'])
    writeFileSync(join(workerBin(dir), 'notes.cmd'), '@echo off\r\necho mine\r\n')
    await expect(write()).rejects.toThrow('notes.cmd was not written by dsh-superagent')
  })
})
