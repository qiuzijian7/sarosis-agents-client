/** Component health registry displayed in the overview and source status panels. */
import type { DatabaseSync } from 'node:sqlite'
import type { Health } from '../sources/host.ts'

export interface HealthEntry {
  get(): Health | undefined
  set(health: Health): void
  /** Unregisters the entry from the board (such as when a Source kind unregisters); subsequent `set` calls become no-ops. */
  release(): void
}

/**
 * Central registry of component health entries, enforcing single-writer ownership per entry name.
 * Claimed by Runtime, Effects, Sessions, DshExecutor, Settings, and SourceRegistry, and read by management HTTP routes.
 *
 * VsSaros fix (2026-11-06): once `persist` gives it the database, every entry is written to `health_entry`, so an error a
 * component reported before a restart is still shown after it (`restored: true`) until the component reports again, instead
 * of the panel showing a clean board that hides what went wrong.
 */
export class HealthBoard {
  private readonly entries: Record<string, Health> = {}
  private readonly claimed = new Set<string>()
  private db?: DatabaseSync
  private saved = new Map<string, Health>()
  claim(name: string, initial?: Health): HealthEntry {
    if (this.claimed.has(name)) throw new Error(`The health entry ${name} is reported by another part`)
    this.claimed.add(name)
    const before = this.saved.get(name)
    if (before?.state === 'error' && (!initial || initial.state === 'starting')) this.entries[name] = { ...before, restored: true }
    else if (initial) this.write(name, initial)
    let held = true
    return {
      get: () => this.entries[name],
      set: health => { if (held) this.write(name, health) },
      release: () => {
        if (!held) return
        held = false
        this.claimed.delete(name)
        delete this.entries[name]
        this.db?.prepare('DELETE FROM health_entry WHERE name=?').run(name)
      },
    }
  }
  /**
   * Writes entries to `db` from now on and reads what was written before a restart. An entry claimed already that has not
   * reported past starting shows its last error.
   */
  persist(db: DatabaseSync): void {
    db.exec('CREATE TABLE IF NOT EXISTS health_entry (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.db = db
    this.saved = new Map(db.prepare('SELECT name, value FROM health_entry').all().flatMap(row => {
      try { return [[String(row.name), JSON.parse(String(row.value)) as Health] as const] } catch { return [] }
    }))
    for (const name of this.claimed) {
      const before = this.saved.get(name), now = this.entries[name]
      if (before?.state === 'error' && (!now || now.state === 'starting')) this.entries[name] = { ...before, restored: true }
      else if (now) this.write(name, now)
    }
  }
  get all(): Readonly<Record<string, Health>> { return this.entries }
  private write(name: string, health: Health): void {
    this.entries[name] = health
    const { restored: _old, ...value } = health
    this.db?.prepare('INSERT INTO health_entry VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  }
}
