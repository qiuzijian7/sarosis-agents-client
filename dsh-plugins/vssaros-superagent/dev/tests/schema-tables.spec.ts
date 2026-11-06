// VsSaros addition (2026-11-06, P1 · one track): the tables the orchestrator database holds after a start, so a table added
// or left behind is a decision someone writes down here (and in docs/007), not a side effect. The five tables of the retired
// team track are archived into team_archive and dropped.
import { afterEach, expect, it } from 'vitest'
import { RETIRED_TEAM_TABLES } from '../src/app/team-archive.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

const TABLES = [
  // Domain (store.ts)
  'decision', 'disposition', 'effect', 'kv', 'outbox', 'thread', 'ticket', 'trigger', 'trigger_thread',
  // The supervisor desk
  'desk_log', 'desk_outbox', 'desk_schedule', 'group_route',
  // A ticket's team, its steps and what they leave
  'team_proposal', 'team_step', 'team_distill', 'team_workflow', 'team_bot', 'team_approval', 'team_archive',
  // Step approvals (2026-11-06: waiting requests and one-shot grants survive a restart)
  'step_approval_rule', 'step_approval_pending', 'step_approval_grant',
  // Restart-safe health and Eval reads (2026-11-06)
  'health_entry', 'eval_reads',
  // The usage ledger of SuperAgent's Sessions (2026-11-06, P2), its rows kept 30 days
  'usage_call',
]

it('holds exactly the listed tables after a start, none of the retired team track', async () => {
  h = await startRuntime(store => {
    store.db.exec('CREATE TABLE team_plan (id TEXT PRIMARY KEY, status TEXT NOT NULL, value TEXT NOT NULL)')
    store.db.prepare('INSERT INTO team_plan VALUES (?,?,?)').run('plan-x', 'running', JSON.stringify({ id: 'plan-x', goal: 'g', status: 'running', createdAt: '2026-11-01T00:00:00.000Z' }))
  })
  const tables = h.runtime.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name)).sort()
  expect(tables).toEqual([...TABLES].sort())
  expect(tables.length).toBe(26)
  expect(tables.filter(name => (RETIRED_TEAM_TABLES as readonly string[]).includes(name))).toEqual([])
  expect(h.runtime.archive.plans()).toMatchObject([{ id: 'plan-x', status: 'cancelled', archivedRunning: true }])
  expect((await h.api('GET', 'team/plans')).body).toMatchObject({ archived: true, plans: [{ id: 'plan-x' }] })
  expect((await h.api('POST', 'team/plans')).status).toBe(404)
})
