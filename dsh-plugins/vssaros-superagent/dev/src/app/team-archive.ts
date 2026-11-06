/**
 * VsSaros change (2026-11-06, P1 · one track): the first team track — plans the main Session gave to Bots on its own
 * (`team_plan`, `team_task`, `team_member`, `team_exchange`) and the skills a finished plan wrote by template
 * (`team_skill`) — is retired. Team work runs only as a ticket's agreed team (`staffing.ts`, `steps.ts`), and skills are
 * written only through `team_distill` → the VsSaros memory system (`distill.ts`).
 *
 * What the old track left is kept, read-only: on open, each plan (with its steps, Bots and exchanges, as the panel showed
 * it) and each skill record is copied into `team_archive`, then the five tables are dropped, in one transaction. A plan
 * that still ran is archived as `cancelled`: nothing advances it any more. Nothing writes the archive after that.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Store } from './store.ts'

/** The tables of the retired track, dropped once archived. */
export const RETIRED_TEAM_TABLES = ['team_plan', 'team_task', 'team_member', 'team_exchange', 'team_skill'] as const

export type ArchivedStepState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'
export interface ArchivedStep {
  id: string; planId: string; title: string; spec: string; bot: string; after: string[]; state: ArchivedStepState
  hop: number; att?: number; assignmentId?: string; sessionId?: string; botId?: string; botName?: string
  report?: string; error?: string; startedAt?: string; endedAt?: string
}
export interface ArchivedExchange { seq: number; planId: string; stepId?: string; hop: number; from: string; to: string; kind: string; text: string; at: string }
/** An old team plan as the panel showed it; `archivedRunning` when it still ran when it was archived. */
export interface PlanView {
  id: string; goal: string; ticketId?: string; cwd?: string; status: 'running' | 'done' | 'failed' | 'cancelled'; createdAt: string; endedAt?: string
  steps: ArchivedStep[]; bots: string[]; exchanges: ArchivedExchange[]; running: number
  archivedRunning?: true
}
/** A skill the old track wrote from a plan's reports by template. */
export interface SkillRecord {
  id: string; name: string; title: string; description: string; scope: string; origin: string; evidence: string
  risk: 'low' | 'medium'; state: 'draft' | 'active' | 'rejected'; version: number; body: string; planId: string; file: string; at: string
}

const exists = (db: DatabaseSync, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
const rows = (db: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  db.prepare(sql).all(...args).map(row => ({ ...row, value: JSON.parse(String(row.value)) as unknown }))

/** The read-only archive of the retired team track. */
export class TeamArchive {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>) {
    store.db.exec('CREATE TABLE IF NOT EXISTS team_archive (kind TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, id))')
    this.migrate()
  }
  /** Copies what the retired tables hold into the archive and drops them; a database without them is left as it is. */
  private migrate(): void {
    const db = this.store.db
    if (!RETIRED_TEAM_TABLES.some(table => exists(db, table))) return
    this.store.atomic(() => {
      const put = db.prepare('INSERT OR IGNORE INTO team_archive VALUES (?,?,?,?)')
      if (exists(db, 'team_plan')) {
        for (const { value } of rows(db, 'SELECT value FROM team_plan ORDER BY rowid')) {
          const plan = value as Omit<PlanView, 'steps' | 'bots' | 'exchanges' | 'running'>
          const steps = exists(db, 'team_task') ? rows(db, 'SELECT value FROM team_task WHERE plan=? ORDER BY rowid', plan.id).map(row => row.value as ArchivedStep) : []
          const bots = exists(db, 'team_member') ? db.prepare('SELECT bot FROM team_member WHERE plan=? ORDER BY at').all(plan.id).map(row => String(row.bot)) : []
          const exchanges = exists(db, 'team_exchange')
            ? db.prepare('SELECT seq, value FROM team_exchange WHERE plan=? ORDER BY seq').all(plan.id)
              .map(row => ({ ...JSON.parse(String(row.value)) as Omit<ArchivedExchange, 'seq'>, seq: Number(row.seq) })) : []
          const ran = plan.status === 'running'
          const at = new Date().toISOString()
          const view: PlanView = { ...plan, ...ran ? { status: 'cancelled' as const, endedAt: plan.endedAt ?? at, archivedRunning: true as const } : {},
            steps: ran ? steps.map(step => step.state === 'running' || step.state === 'pending'
              ? { ...step, state: step.state === 'running' ? 'cancelled' as const : 'skipped' as const, error: step.error ?? 'archived: the old team track was retired' } : step) : steps,
            bots, exchanges: exchanges.slice(-200), running: 0 }
          put.run('plan', plan.id, plan.createdAt ?? at, JSON.stringify(view))
        }
      }
      if (exists(db, 'team_skill')) {
        for (const { value } of rows(db, 'SELECT value FROM team_skill ORDER BY at')) {
          const skill = value as SkillRecord
          put.run('skill', skill.id, skill.at, JSON.stringify(skill))
        }
      }
      for (const table of RETIRED_TEAM_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
    })
  }
  /** Archived plans, newest first. */
  plans(limit = 20): PlanView[] {
    return this.store.db.prepare("SELECT value FROM team_archive WHERE kind='plan' ORDER BY at DESC LIMIT ?").all(limit)
      .map(row => JSON.parse(String(row.value)) as PlanView)
  }
  /** Archived skill records, oldest first. */
  skills(): SkillRecord[] {
    return this.store.db.prepare("SELECT value FROM team_archive WHERE kind='skill' ORDER BY at").all()
      .map(row => JSON.parse(String(row.value)) as SkillRecord)
  }
}
