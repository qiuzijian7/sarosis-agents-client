/**
 * VsSaros patch: synchronous ownership of the state directory.
 *
 * `proper-lockfile`'s sync API forbids `retries` (`toSyncOptions` throws ESYNC) and only
 * reclaims a lock once its mtime is older than `stale`. A Host that is killed and started again
 * within that window therefore fails with `Lock file is already being held` and never recovers,
 * even though the process that held the lock is gone. This helper recognises such orphaned locks
 * before acquiring, while still refusing a second Runtime in the same process (upstream contract).
 */
import { readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { lockSync } from 'proper-lockfile'

/** A lock is stale after this long without an mtime refresh; `proper-lockfile`'s own default. */
const STALE_MS = 10_000
/** Refresh the lock's mtime this often so a busy event loop cannot make a live lock look dead. */
const UPDATE_MS = 2_000
/** Never block startup longer than this waiting for a lock whose owner cannot be identified. */
const MAX_WAIT_MS = STALE_MS + 2_000

export interface StateLockOptions {
  staleMs?: number
  maxWaitMs?: number
  /** Overridable so tests need not really sleep. */
  sleep?: (ms: number) => void
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.round(ms)))
}

/** Whether a process with this pid still exists; EPERM means it does, we just may not signal it. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The pid recorded by the process that last owned the lock, if the record is readable. */
const ownerOf = (file: string): number | undefined => {
  try {
    const pid = Number(JSON.parse(readFileSync(file, 'utf8')).pid)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch { return undefined }
}

const mtimeOf = (file: string): number | undefined => {
  try { return statSync(file).mtimeMs } catch { return undefined }
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/**
 * Acquire the state-directory lock synchronously, reclaiming a lock only when its recorded owner
 * process is gone (a killed Host) or its mtime is past `staleMs`. A live owner is refused at once,
 * so a second Runtime in this process cannot open the same database. Throws the original
 * `ELOCKED` error when an unidentifiable live lock outlasts `maxWaitMs`.
 */
export function acquireStateLock(stateDir: string, onCompromised: (error: Error) => void,
  options: StateLockOptions = {}): () => void {
  const staleMs = options.staleMs ?? STALE_MS
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS
  const sleep = options.sleep ?? sleepSync
  // `proper-lockfile` resolves the target with realpath before building `${file}.lock`; match it.
  const canonical = realpathSync(stateDir)
  const lockDir = `${canonical}.lock`
  const ownerFile = `${canonical}.lock.owner`
  // Read before acquiring: a lock directory found on entry carries this owner's pid.
  let previousOwner = ownerOf(ownerFile)

  const reclaim = (): boolean => {
    const mtime = mtimeOf(lockDir)
    if (mtime === undefined) return true // The lock disappeared between attempts.
    if (previousOwner !== undefined && !alive(previousOwner)) {
      // The process that held the lock is gone: its lock is an orphan.
      previousOwner = undefined
      rmSync(lockDir, { recursive: true, force: true })
      return true
    }
    if (Date.now() - mtime >= staleMs) {
      // Old enough that even proper-lockfile would remove it on its next acquire.
      rmSync(lockDir, { recursive: true, force: true })
      return true
    }
    return false
  }

  let waited = 0
  for (;;) {
    let release: () => void
    try {
      release = lockSync(stateDir, { stale: staleMs, update: UPDATE_MS, onCompromised })
    } catch (error) {
      if (codeOf(error) !== 'ELOCKED') throw error
      if (reclaim()) continue
      // A live owner keeps the lock: refuse at once, as upstream requires for a second Runtime.
      if (previousOwner !== undefined && alive(previousOwner)) throw error
      const mtime = mtimeOf(lockDir) ?? Date.now()
      const slice = Math.min(Math.max(staleMs - (Date.now() - mtime) + 50, 50), 500)
      if (waited + slice > maxWaitMs) throw error
      sleep(slice)
      waited += slice
      continue
    }
    // Best effort: lets the next process recognise a dead owner without waiting for `staleMs`.
    try { writeFileSync(ownerFile, JSON.stringify({ pid: process.pid })) } catch { /* Read-only parent: fall back to mtime. */ }
    return release
  }
}
