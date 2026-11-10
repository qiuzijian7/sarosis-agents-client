/** VsSaros addition: local lark-cli diagnostics and confirmed maintenance. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Probe } from '../src/deployment.ts'
import { CliCheck } from '../src/app/cli-check.ts'

/**
 * ★ 2026-11-10（门禁红灯修复）：原本用 `vi.mock('../src/deployment.ts')` 替换 `executable`。
 *   实测本环境 Vitest 4.1.8 的 mock registry 不生效（hoisted / doMock / 简单 factory 全部
 *   `mock.calls === 0`），于是 6 个用例拿到 `found:false`。改为**真实临时可执行文件**，
 *   让 `executable()` 真的在磁盘上找到它：deterministic，且不依赖框架 mock 机制。
 *   范式与 tests/feishu-profile.spec.ts 一致。
 */
const windows = process.platform === 'win32'
let dir: string
let resolved: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-cli-check-'))
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  resolved = join(dir, windows ? 'lark-cli.cmd' : 'lark-cli')
  writeFileSync(resolved, windows ? '@echo off\r\n' : '#!/bin/sh\n')
  if (!windows) chmodSync(resolved, 0o755)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const answers: Record<string, string> = {
  '--version': 'lark-cli version 1.0.98',
  'auth status': '{"appId":"cli_abc","brand":"feishu","identities":{"bot":{"status":"ready"}}}',
  'config strict-mode': 'strict-mode: bot (source: profile "cli_abc")',
  'api GET /open-apis/bot/v3/info --as bot --format ndjson': '{"bot":{"open_id":"ou_bot","app_name":"Review Bot"}}',
  'update --check --json': '{"action":"already_up_to_date","current_version":"1.0.98","latest_version":"1.0.98","ok":true,"message":"up to date"}',
}
/** A probe whose answer is keyed by the argv after the resolved executable. */
const probe = (overrides: Record<string, string | Error> = {}) => vi.fn(async (argv: string[]) => {
  const key = argv.slice(1).join(' ')
  const answer = { ...answers, ...overrides }[key]
  if (answer instanceof Error) throw answer
  if (answer === undefined) throw new Error(`unexpected argv ${key}`)
  return answer
})
const cli = (run: Probe) => new CliCheck(run, dir, join(dir, 'state'))

describe('local lark-cli check', () => {
  it('reports the executable, version, bot identity, strict mode and bot name', async () => {
    const result = await cli(probe()).check()
    expect(result).toMatchObject({ found: true, command: 'lark-cli', resolved,
      version: '1.0.98', appId: 'cli_abc', botReady: true, strictMode: 'bot', botName: 'Review Bot' })
    expect(result.error).toBeUndefined()
    expect(result.update).toBeUndefined()
  })

  it('also reports the update status when asked', async () => {
    const result = await cli(probe()).check(true)
    expect(result.update).toMatchObject({ action: 'already_up_to_date', currentVersion: '1.0.98', latestVersion: '1.0.98', ok: true })
  })

  it('keeps partial results and records a failing probe instead of failing the whole check', async () => {
    const result = await cli(probe({ 'config strict-mode': new Error('auth expired') })).check()
    expect(result).toMatchObject({ found: true, version: '1.0.98', botReady: true, botName: 'Review Bot' })
    expect(result.strictMode).toBeUndefined()
    expect(result.error).toContain('auth expired')
  })

  it('reports an executable that cannot be found', async () => {
    // 空 PATH 目录 ⇒ 真实 executable() 抛「not an executable file on PATH」。
    const result = await new CliCheck(probe(), join(dir, 'empty'), join(dir, 'state')).check()
    expect(result.found).toBe(false)
    expect(result.error).toContain('not an executable file on PATH')
  })
})

describe('confirmed lark-cli maintenance', () => {
  it('refuses a write action without confirmation', async () => {
    await expect(cli(probe()).apply('strict-bot', false)).rejects.toThrow(/Confirmation required/)
  })

  it('sets strict mode to bot only after confirmation', async () => {
    const run = probe({ 'config strict-mode bot': 'Strict mode set to bot (profile)' })
    const result = await cli(run).apply('strict-bot', true)
    expect(result).toEqual({ ok: true, output: 'Strict mode set to bot (profile)' })
    expect(run).toHaveBeenCalledWith([resolved, 'config', 'strict-mode', 'bot'],
      expect.objectContaining({ LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1' }))
  })

  it('runs the CLI updater only after confirmation', async () => {
    const run = probe({ update: 'updated to 1.0.99' })
    const result = await cli(run).apply('update', true)
    expect(result).toMatchObject({ ok: true, output: 'updated to 1.0.99' })
    expect(run).toHaveBeenCalledWith([resolved, 'update'], expect.anything())
  })
})
