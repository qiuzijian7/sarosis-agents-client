/**
 * VsSaros addition: the TAPD credentials the settings panel edits. They are written to the Host's credentials file,
 * never to the settings store, and the panel only gets a masked account name. Real temporary files are used so the
 * file the Open API then reads is exactly what was written.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resetTapdEnvCache, saveTapdCredential, TapdCredentialError, tapdCredential, tapdCredentialStatus, tapdEnvironment,
  type TapdEnv } from '../src/sources/tapd-auth.ts'

const dirs: string[] = []
/** The existing cases turn the shipped account off, so they still cover a Host with no credential of its own. */
const home = (bundled = false): TapdEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-tapd-cred-')); dirs.push(dir)
  return { DSH_HOME: dir, ...(bundled ? {} : { DSH_SUPERAGENT_TAPD_BUNDLED: 'off' }) }
}
const fileOf = (env: TapdEnv) => join(env.DSH_HOME!, 'tapd.env')
afterEach(() => { resetTapdEnvCache(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the credential status the panel shows', () => {
  it('says nothing is set and where the file would be', () => {
    const env = home()
    expect(tapdCredentialStatus(env)).toEqual({ configured: false, source: 'none', file: fileOf(env),
      saved: false, bundled: false, overridden: false })
  })
  it('names the kind and a masked account, never a secret', async () => {
    const env = home()
    const status = await saveTapdCredential({ kind: 'client', id: 'enterprise-account', secret: 'S3CRET-value' }, env)
    expect(status).toEqual({ configured: true, method: 'Basic TAPD_CLIENT_ID/SECRET (API account)', source: 'file', file: fileOf(env),
      kind: 'client', account: 'ent…nt', saved: true, bundled: false, overridden: false })
    expect(JSON.stringify(status)).not.toContain('S3CRET')
    expect(JSON.stringify(status)).not.toContain('enterprise-account')
  })
  it('names the credential actually in use: the two places merge key by key, then the priority picks', async () => {
    // A higher-priority credential in the file wins over a lower one in the environment...
    const lower = { ...home(), TAPD_API_TOKEN: 'from-env' }
    await saveTapdCredential({ kind: 'client', id: 'acct', secret: 's' }, lower)
    expect(tapdCredentialStatus(lower)).toMatchObject({ source: 'file', method: 'Basic TAPD_CLIENT_ID/SECRET (API account)', overridden: false })
    expect(tapdCredential(tapdEnvironment(lower))?.method).toBe('Basic TAPD_CLIENT_ID/SECRET (API account)')
    // ...and a higher one in the environment overrides whatever the panel saved.
    const higher = { ...home(), DSH_SUPERAGENT_TAPD_BEARER: 'from-env' }
    await saveTapdCredential({ kind: 'client', id: 'acct', secret: 's' }, higher)
    expect(tapdCredentialStatus(higher)).toMatchObject({ source: 'environment', method: 'Bearer DSH_SUPERAGENT_TAPD_BEARER', overridden: true, kind: 'client' })
    expect(tapdCredential(tapdEnvironment(higher))?.header).toBe('Bearer from-env')
  })
})

describe('the shipped TAPD account', () => {
  it('works out of the box, is overridden by a saved credential, and comes back after clearing', async () => {
    const env = home(true)
    const status = tapdCredentialStatus(env)
    expect(status).toEqual({ configured: true, method: 'Basic TAPD_CLIENT_ID/SECRET (API account)', source: 'bundled',
      file: fileOf(env), kind: 'client', account: 'tap…17', saved: false, bundled: true, overridden: false })
    expect(JSON.stringify(status)).not.toContain('6E9C1B81')
    expect(tapdCredential(tapdEnvironment(env))?.header)
      .toBe(`Basic ${Buffer.from('tapd-app-889817:6E9C1B81-5443-6CFC-0D84-27C8DAEDB6FB').toString('base64')}`)
    expect((await saveTapdCredential({ kind: 'client', id: 'mine', secret: 'sec' }, env)).source).toBe('file')
    expect(tapdCredential(tapdEnvironment(env))?.header).toBe(`Basic ${Buffer.from('mine:sec').toString('base64')}`)
    expect((await saveTapdCredential({ clear: true }, env)).source).toBe('bundled')
  })
  it('is off when the Host disables it', () => {
    const env = home()
    expect(tapdCredentialStatus(env).source).toBe('none')
    expect(tapdCredential(tapdEnvironment(env))).toBeUndefined()
  })
})

describe('the shipped-account switch', () => {
  it('can be turned off and on through the credentials file, without an IDE restart', async () => {
    const env = home(true)
    const off = await saveTapdCredential({ bundled: 'off' }, env)
    expect(off).toMatchObject({ bundled: false, source: 'none', saved: false })
    expect(readFileSync(fileOf(env), 'utf8')).toContain('DSH_SUPERAGENT_TAPD_BUNDLED=off')
    expect(tapdCredential(tapdEnvironment(env))).toBeUndefined()
    const on = await saveTapdCredential({ bundled: 'on' }, env)
    expect(on).toMatchObject({ bundled: true, source: 'bundled' })
    expect(readFileSync(fileOf(env), 'utf8')).not.toContain('DSH_SUPERAGENT_TAPD_BUNDLED=off')
  })
  it('does not demand a credential kind when only flipping the switch', async () => {
    const env = home(true)
    await expect(saveTapdCredential({ bundled: 'off' }, env)).resolves.toMatchObject({ bundled: false })
  })
  it('survives an ordinary credential save', async () => {
    const env = home(true)
    await saveTapdCredential({ bundled: 'off' }, env)
    await saveTapdCredential({ kind: 'client', id: 'mine', secret: 'sec' }, env)
    expect(readFileSync(fileOf(env), 'utf8')).toContain('DSH_SUPERAGENT_TAPD_BUNDLED=off')
    expect(tapdCredentialStatus(env)).toMatchObject({ source: 'file', bundled: false, saved: true })
  })
})

describe('saving from the panel', () => {
  it('writes the file the Open API reads at once', async () => {
    const env = home()
    await saveTapdCredential({ kind: 'client', id: 'acct', secret: 'sec' }, env)
    expect(tapdCredential(tapdEnvironment(env))?.header).toBe(`Basic ${Buffer.from('acct:sec').toString('base64')}`)
    expect(readFileSync(fileOf(env), 'utf8')).toContain('TAPD_CLIENT_ID=acct\nTAPD_CLIENT_SECRET=sec\n')
  })
  it('replaces every credential key, so a stale higher-priority one cannot win, and keeps the other lines', async () => {
    const env = home()
    writeFileSync(fileOf(env), ['# mine', 'DSH_SUPERAGENT_TAPD_BEARER=stale', 'TAPD_API_USER=old', 'TAPD_API_PWD=old',
      'TAPD_HTTP_TIMEOUT_MS=9000', 'OTHER=keep'].join('\n'))
    await saveTapdCredential({ kind: 'token', secret: 'tok' }, env)
    const text = readFileSync(fileOf(env), 'utf8')
    expect(text).not.toMatch(/BEARER|TAPD_API_USER|TAPD_API_PWD/)
    expect(text).toContain('# mine'); expect(text).toContain('TAPD_HTTP_TIMEOUT_MS=9000'); expect(text).toContain('OTHER=keep')
    expect(tapdCredential(tapdEnvironment(env))?.method).toBe('Bearer TAPD_API_TOKEN')
  })
  it('keeps the saved secret when only the account changes, and asks for both when the kind changes', async () => {
    const env = home()
    await saveTapdCredential({ kind: 'user', id: 'alice', secret: 'pw' }, env)
    await saveTapdCredential({ kind: 'user', id: 'bob' }, env)
    expect(tapdCredential(tapdEnvironment(env))?.header).toBe(`Basic ${Buffer.from('bob:pw').toString('base64')}`)
    await saveTapdCredential({ kind: 'user', secret: 'pw2' }, env)
    expect(tapdCredential(tapdEnvironment(env))?.header).toBe(`Basic ${Buffer.from('bob:pw2').toString('base64')}`)
    await expect(saveTapdCredential({ kind: 'client', id: 'acct' }, env)).rejects.toThrow(TapdCredentialError)
    await expect(saveTapdCredential({ kind: 'client', secret: 's' }, env)).rejects.toThrow('account name')
  })
  it('refuses values that would break the file, and an unknown kind', async () => {
    const env = home()
    await expect(saveTapdCredential({ kind: 'token', secret: 'a\nTAPD_API_TOKEN=evil' }, env)).rejects.toThrow('line breaks')
    await expect(saveTapdCredential({ kind: 'client', id: 'a"b', secret: 's' }, env)).rejects.toThrow('quotes')
    await expect(saveTapdCredential({ kind: 'nope' as never, secret: 's' }, env)).rejects.toThrow('kind')
    await expect(saveTapdCredential({ secret: 's' }, env)).rejects.toThrow('kind')
  })
  it('clears only the credential keys', async () => {
    const env = home()
    writeFileSync(fileOf(env), 'TAPD_WORKSPACE_ID=68880148\nTAPD_CLIENT_ID=a\nTAPD_CLIENT_SECRET=b\n')
    const status = await saveTapdCredential({ clear: true }, env)
    expect(status).toMatchObject({ configured: false, source: 'none' })
    expect(status).not.toHaveProperty('kind')
    expect(readFileSync(fileOf(env), 'utf8')).toBe('TAPD_WORKSPACE_ID=68880148\n')
  })
})

describe('the panel wiring', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('shows the credentials on the TAPD card for the Open API only, and never posts them into the settings', () => {
    const card = source('../src/client/source.tsx')
    expect(card).toContain("source.installed && source.id === 'tapd' &&")
    expect(card).not.toContain('config.transport')
    expect(card).toContain('<TapdCredentials config={{')
    expect(card).toContain('onAddWatch={watches => draft.edit(')
    const panel = source('../src/client/tapd-credentials.tsx')
    expect(panel).toContain("call('POST sources/tapd/credentials'")
    expect(panel).not.toContain('draft.edit')
    // Enter in a credential input must not submit the Source card's form.
    expect(panel).toContain("if (event.key === 'Enter') event.preventDefault()")
  })
  it('ships the account in lib/ (listed in files) and shows its source in the panel', () => {
    const auth = source('../src/sources/tapd-auth.ts')
    expect(auth).toContain('export const BUNDLED_TAPD_CREDENTIALS')
    expect(auth).toContain("TAPD_CLIENT_ID: 'tapd-app-889817'")
    expect(JSON.parse(source('../../package.json')).files).toContain('lib')
    expect(source('../src/client/tapd-credentials.tsx')).toContain("status.source === 'bundled'")
    // The "credential in use" row must name the shipped account, not just the variable pair.
    expect(source('../src/client/tapd-credentials.tsx')).toContain("t('tapdCred.methodBundled')")
    expect(source('../src/client/locales.ts')).toContain("'tapdCred.methodBundled'")
  })
  it('wires the checklist, the connectivity probe and the shipped-account switch', () => {
    const panel = source('../src/client/tapd-credentials.tsx')
    expect(panel).toContain("call('GET sources/tapd/setup')")
    expect(panel).toContain("call('POST sources/tapd/test'")
    expect(panel).toContain('healthLabel(setup?.healthCode)')
    expect(panel).toContain('body: { bundled }')
    expect(panel).toContain("status?.kind === kind && !!status.saved")
    // A built-in account is the normal path: the kind tabs and secret inputs stay behind a closed disclosure.
    expect(panel).toContain('const [customOpen, setCustomOpen] = useState(false)')
    expect(panel).toContain("title={t('tapdCred.custom')}")
    const http = source('../src/app/http.ts')
    expect(http).toContain("'GET sources/tapd/setup': (): TapdSetupStatus =>")
    expect(http).toContain("'POST sources/tapd/test': async ({ body }): Promise<TapdTestResult> =>")
  })
  it('routes both calls and answers a bad value with 400', () => {
    const http = source('../src/app/http.ts')
    expect(http).toContain("'GET sources/tapd/credentials': () => tapdCredentialStatus()")
    expect(http).toContain("'POST sources/tapd/credentials': async ({ body }) => saveTapdCredential(")
    expect(http).toContain('if (error instanceof TapdCredentialError) return [400, { error: error.message }]')
  })
})
