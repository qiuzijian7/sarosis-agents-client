/** VsSaros patch: the state-directory lock survives a Host killed and restarted within `stale`. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireStateLock, type StateLockOptions } from '../src/app/state-lock.ts'

let directory: string
let stateDir: string
const releases: (() => void)[] = []
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'state-lock-'))
  stateDir = join(directory, 'state')
  mkdirSync(stateDir)
})
afterEach(() => {
  for (const release of releases.reverse()) { try { release() } catch { /* already released */ } }
  releases.length = 0
  rmSync(directory, { recursive: true, force: true })
})
const take = (options: StateLockOptions = {}): (() => void) => {
  const release = acquireStateLock(stateDir, () => {}, options)
  releases.push(release)
  return release
}
const lockDir = () => `${stateDir}.lock`
const ownerFile = () => `${stateDir}.lock.owner`
const noSleep = (): never => { throw new Error('should not have to wait') }

describe('state directory lock', () => {
  it('takes the lock when none exists, and records who owns it', () => {
    const release = take()
    expect(existsSync(lockDir())).toBe(true)
    expect(JSON.parse(readFileSync(ownerFile(), 'utf8')).pid).toBe(process.pid)
    release()
    expect(existsSync(lockDir())).toBe(false)
  })

  it('reclaims a lock whose owner process is gone without waiting for stale', () => {
    // A Host killed and restarted nine seconds later: a fresh lock directory, a dead owner.
    mkdirSync(lockDir())
    writeFileSync(ownerFile(), JSON.stringify({ pid: 999_999_999 }))
    const release = take({ staleMs: 600_000, maxWaitMs: 0, sleep: noSleep })
    expect(existsSync(lockDir())).toBe(true)
    release()
  })

  it('refuses a second Runtime in the same process, as upstream requires', () => {
    take()
    // The owner pid is still alive, so it must be refused at once rather than waited out or stolen.
    expect(() => take({ maxWaitMs: 0, sleep: noSleep })).toThrow(/already being held/)
    expect(existsSync(lockDir())).toBe(true)
  })

  it('does not delete a fresh lock with no owner record', () => {
    mkdirSync(lockDir())
    expect(() => take({ staleMs: 600_000, maxWaitMs: 0, sleep: () => {} })).toThrow(/already being held/)
    expect(existsSync(lockDir())).toBe(true)
    rmSync(lockDir(), { recursive: true, force: true })
  })

  it('reclaims a lock that is simply older than stale', () => {
    mkdirSync(lockDir())
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockDir(), old, old)
    const release = take({ staleMs: 10_000, maxWaitMs: 0, sleep: noSleep })
    release()
  })
})
