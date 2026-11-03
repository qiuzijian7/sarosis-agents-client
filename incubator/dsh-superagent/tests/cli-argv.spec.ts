/**
 * VsSaros addition: a Windows npm/pnpm `.cmd` launcher cannot be spawned by Node without a shell, so both the
 * long-lived Feishu event consumer and the TAPD MCP transport resolve it to `node <script>`. Real temporary
 * launchers are used so the exact text the parser reads is the text a package manager writes.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliArgv } from '../src/deployment.ts'
import { nodeCli, TapdError } from '../src/sources/tapd-api.ts'

const dirs: string[] = []
const tree = (): string => { const dir = mkdtempSync(join(tmpdir(), 'sa-cli-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** Writes an npm-style launcher plus the script it points at; both need the executable bit on POSIX. */
function launcher(dir: string, body: string): string {
  const cmd = join(dir, 'tool.cmd')
  writeFileSync(join(dir, 'tool.js'), '// entry\n')
  writeFileSync(cmd, body)
  chmodSync(cmd, 0o755)
  return cmd
}

describe('a CLI resolved to shell-free argv', () => {
  it('runs a .js script with the Host node and passes real executables through', () => {
    expect(cliArgv('/some/where/tool.js', '', true)).toEqual([process.execPath, '/some/where/tool.js'])
    const dir = tree(), exe = join(dir, 'tool.exe')
    writeFileSync(exe, ''); chmodSync(exe, 0o755)
    expect(cliArgv(exe, '', true)).toEqual([exe])
  })
  it('replaces a Windows npm launcher by the script it launches', () => {
    const dir = tree()
    const cmd = launcher(dir, '@echo off\nIF EXIST "%dp0%\\node.exe" (\n  "%_prog%"  "%dp0%\\tool.js" %*\n)\n')
    expect(cliArgv(cmd, '', true)).toEqual([process.execPath, join(dir, 'tool.js')])
  })
  it('passes an already-resolved absolute CLI through without touching the filesystem', () => {
    expect(cliArgv('/bin/false', '', false)).toEqual(['/bin/false'])
    const missing = join(tmpdir(), 'sa-cli-not-on-disk.exe')
    expect(cliArgv(missing, '', true)).toEqual([missing])
  })
  it('keeps POSIX behaviour and refuses a launcher it cannot read', () => {
    const dir = tree()
    const cmd = launcher(dir, '@echo off\n"%dp0%\\tool.js" %*\n')
    expect(cliArgv(cmd, '', false)).toEqual([cmd])
    const odd = launcher(dir, '@echo off\necho nothing to parse\n')
    expect(() => cliArgv(odd, '', true)).toThrow(/cannot read/)
  })
  it('keeps the TAPD MCP transport on the same resolver, with its own error type', () => {
    const dir = tree()
    const cmd = launcher(dir, '@echo off\n"%dp0%\\tool.js" %*\n')
    expect(nodeCli(cmd, '', true)).toEqual([process.execPath, join(dir, 'tool.js')])
    const odd = launcher(dir, '@echo off\necho nothing to parse\n')
    expect(() => nodeCli(odd, '', true)).toThrow(TapdError)
  })
  it('guards the two Host-side callers against spawning the launcher directly', () => {
    const loops = readFileSync(new URL('../src/sources/feishu-loops.ts', import.meta.url), 'utf8')
    const commands = readFileSync(new URL('../src/infra/commands.ts', import.meta.url), 'utf8')
    expect(loops).toContain('const [program, ...prefix] = cliArgv(bot(ctx).cli)')
    expect(loops).toContain('spawn(program!, [...prefix, ')
    expect(loops).not.toContain('spawn(bot(ctx).cli')
    expect(commands).toContain('const [program, ...prefix] = cliArgv(bot.cli)')
    expect(commands).toContain('this.run(program!, [...prefix, ...args,')
    expect(commands).not.toContain('this.run(bot.cli,')
  })
})
