/**
 * VsSaros addition: TAPD Open API credentials aligned with SaroasisStudioSystem's `.env` contract.
 * Real temporary credentials files are used so quoting, comments and the key whitelist are exercised as written.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTapdEnvFile, resetTapdEnvCache, tapdCredential, tapdCredentialsHint, tapdEnvironment, tapdEnvFile, tapdTimeoutMs,
  type TapdEnv } from '../src/sources/tapd-auth.ts'
import { TapdOpenApi } from '../src/sources/tapd-api.ts'

const dirs: string[] = []
const tree = (): string => { const dir = mkdtempSync(join(tmpdir(), 'sa-tapd-env-')); dirs.push(dir); return dir }
afterEach(() => { resetTapdEnvCache(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const all: TapdEnv = {
  DSH_SUPERAGENT_TAPD_BEARER: 'native-bearer',
  DSH_SUPERAGENT_TAPD_USER: 'u', DSH_SUPERAGENT_TAPD_PASSWORD: 'p',
  TAPD_CLIENT_ID: 'cid', TAPD_CLIENT_SECRET: 'secret',
  TAPD_API_USER: 'au', TAPD_API_PWD: 'ap', TAPD_API_TOKEN: 'tok',
}
const without = (env: TapdEnv, ...keys: string[]): TapdEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key)))
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

describe('the five credential sources', () => {
  it('prefers the native SuperAgent variables, then SaroasisStudioSystem\'s three', () => {
    expect(tapdCredential(all)?.header).toBe('Bearer native-bearer')
    const second = without(all, 'DSH_SUPERAGENT_TAPD_BEARER')
    expect(tapdCredential(second)?.header).toBe(basic('u', 'p'))
    const third = without(second, 'DSH_SUPERAGENT_TAPD_USER', 'DSH_SUPERAGENT_TAPD_PASSWORD')
    expect(tapdCredential(third)?.header).toBe(basic('cid', 'secret'))
    expect(tapdCredential(third)?.method).toContain('API account')
    const fourth = without(third, 'TAPD_CLIENT_ID', 'TAPD_CLIENT_SECRET')
    expect(tapdCredential(fourth)?.header).toBe(basic('au', 'ap'))
    const fifth = without(fourth, 'TAPD_API_USER', 'TAPD_API_PWD')
    expect(tapdCredential(fifth)?.header).toBe('Bearer tok')
    expect(tapdCredential(without(fifth, 'TAPD_API_TOKEN'))).toBeUndefined()
  })
  it('needs both halves of a Basic pair', () => {
    expect(tapdCredential({ TAPD_CLIENT_ID: 'cid' })).toBeUndefined()
    expect(tapdCredential({ DSH_SUPERAGENT_TAPD_USER: 'u', TAPD_API_TOKEN: 'tok' })?.header).toBe('Bearer tok')
  })
  it('names every accepted variable and the credentials file when nothing is set', () => {
    const hint = tapdCredentialsHint({ DSH_HOME: '/tmp/profile' })
    for (const name of ['DSH_SUPERAGENT_TAPD_USER', 'TAPD_CLIENT_ID', 'TAPD_API_USER', 'TAPD_API_PWD', 'TAPD_API_TOKEN',
      'DSH_SUPERAGENT_TAPD_ENV_FILE']) expect(hint).toContain(name)
    expect(hint).toContain('tapd.env')
  })
})

describe('the local credentials file', () => {
  it('reads KEY=VALUE with quotes and comments, but only whitelisted TAPD keys', () => {
    const file = join(tree(), 'tapd.env')
    writeFileSync(file, [
      '# copied from SaroasisStudioSystem/.env.example',
      'TAPD_CLIENT_ID="cid"',
      "TAPD_CLIENT_SECRET='secret'",
      'TAPD_API_TOKEN=tok',
      'PORT=8765',
      'FEISHU_APP_SECRET=do-not-leak',
      'DSH_HOME=/must/not/be/overridden',
      'DSH_SUPERAGENT_TAPD_ENV_FILE=/must/not/recurse',
    ].join('\n'))
    expect(readTapdEnvFile(file, {})).toEqual({
      TAPD_CLIENT_ID: 'cid', TAPD_CLIENT_SECRET: 'secret', TAPD_API_TOKEN: 'tok',
    })
  })
  it('never overrides an existing environment value', () => {
    const file = join(tree(), 'tapd.env')
    writeFileSync(file, 'TAPD_CLIENT_ID=from-file\nTAPD_CLIENT_SECRET=secret\n')
    expect(readTapdEnvFile(file, { TAPD_CLIENT_ID: 'from-process' })).toEqual({ TAPD_CLIENT_SECRET: 'secret' })
  })
  it('merges the file into a Host environment and resolves the default path', () => {
    const file = join(tree(), 'tapd.env')
    writeFileSync(file, 'TAPD_CLIENT_ID=cid\nTAPD_CLIENT_SECRET=secret\n')
    const base = { DSH_SUPERAGENT_TAPD_ENV_FILE: file, DSH_HOME: '/tmp/profile', TAPD_API_TOKEN: 'env-token' }
    expect(tapdEnvFile(base)).toBe(file)
    const merged = tapdEnvironment(base)
    expect(merged.TAPD_CLIENT_ID).toBe('cid')
    expect(tapdCredential(merged)?.header).toBe(basic('cid', 'secret'))
    expect(tapdEnvFile({ DSH_HOME: '/tmp/profile' })).toBe(join('/tmp/profile', 'tapd.env'))
  })
  it('is missing silently when the file does not exist', () => {
    expect(readTapdEnvFile(join(tree(), 'absent.env'), {})).toEqual({})
  })
})

describe('the Open API transport', () => {
  it('signs with a SaroasisStudioSystem API account and asks for JSON', async () => {
    const calls: { headers: Record<string, string> }[] = []
    const fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string> })
      return new Response(JSON.stringify({ status: 1, data: [], info: 'success' }))
    }) as unknown as typeof globalThis.fetch
    const api = new TapdOpenApi({ api: 'https://api.tapd.cn', fetch,
      environment: { TAPD_CLIENT_ID: 'cid', TAPD_CLIENT_SECRET: 'secret' } })
    await api.items('bug', '68880148', {})
    expect(calls[0]!.headers.authorization).toBe(basic('cid', 'secret'))
    expect(calls[0]!.headers.accept).toBe('application/json')
  })
  it('uses a configurable timeout with a 3s floor', () => {
    expect(tapdTimeoutMs({})).toBe(30_000)
    expect(tapdTimeoutMs({ TAPD_HTTP_TIMEOUT_MS: '20000' })).toBe(20_000)
    expect(tapdTimeoutMs({ DSH_SUPERAGENT_TAPD_TIMEOUT_MS: '1000' })).toBe(3000)
    expect(tapdTimeoutMs({ TAPD_HTTP_TIMEOUT_MS: 'not-a-number' })).toBe(30_000)
  })
})
