// VsSaros addition: reusable team workflows, and (2026-11-06, P1 · one track) the retired team plans and template skills
// kept read-only in team_archive. Real temporary SQLite.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coverage, Retrospective, words, WORKFLOW_MATCH_THRESHOLD } from '../src/app/retrospective.ts'
import { RETIRED_TEAM_TABLES, TeamArchive } from '../src/app/team-archive.ts'
import { Store } from '../src/app/store.ts'

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-retro-'))
  store = new Store(join(dir, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

const tables = () => store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name))
/** The five tables as a version before 2026-11-06 left them: one plan done, one still running, two skill records. */
function seedRetiredTrack() {
  store.db.exec(`
    CREATE TABLE team_plan (id TEXT PRIMARY KEY, status TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE team_task (id TEXT PRIMARY KEY, plan TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE team_member (plan TEXT NOT NULL, bot TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (plan, bot));
    CREATE TABLE team_exchange (seq INTEGER PRIMARY KEY AUTOINCREMENT, plan TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE team_skill (id TEXT PRIMARY KEY, state TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL);`)
  const plan = (id: string, status: string, at: string) => store.db.prepare('INSERT INTO team_plan VALUES (?,?,?)')
    .run(id, status, JSON.stringify({ id, goal: `目标 ${id}`, status, createdAt: at }))
  const step = (planId: string, id: string, state: string, extra: Record<string, unknown> = {}) => store.db.prepare('INSERT INTO team_task VALUES (?,?,?)')
    .run(`${planId}/${id}`, planId, JSON.stringify({ id, planId, title: id, spec: id, bot: 'designer', after: [], state, hop: 1, ...extra }))
  plan('plan-a', 'done', '2026-11-01T00:00:00.000Z'); step('plan-a', 'T1', 'done', { report: '交互稿 5 屏' })
  plan('plan-b', 'running', '2026-11-02T00:00:00.000Z'); step('plan-b', 'T1', 'running'); step('plan-b', 'T2', 'pending')
  store.db.prepare('INSERT INTO team_member VALUES (?,?,?)').run('plan-a', '设计 bot', '2026-11-01T00:00:01.000Z')
  store.db.prepare('INSERT INTO team_exchange (plan, value) VALUES (?,?)').run('plan-a', JSON.stringify({ planId: 'plan-a', hop: 0, from: 'SuperAgent', to: 'SuperAgent', kind: 'system', text: 'Plan: 目标 plan-a', at: '2026-11-01T00:00:00.000Z' }))
  for (const [id, state] of [['sk-1', 'active'], ['sk-2', 'draft']] as const) {
    store.db.prepare('INSERT INTO team_skill VALUES (?,?,?,?)').run(id, state, JSON.stringify({ id, name: `team-${id}`, title: id, description: id, scope: 'supervisor',
      origin: 'plan-a', evidence: '', risk: 'low', state, version: 1, body: '# x', planId: 'plan-a', file: '', at: `2026-11-01T00:00:0${id.at(-1)}.000Z` }), `2026-11-01T00:00:0${id.at(-1)}.000Z`)
  }
}

describe('words and coverage', () => {
  it('compares latin words and Chinese bigrams', () => {
    expect(words('Playwright 引导流程')).toContain('playwright')
    expect(words('引导流程')).toContain('导流')
    expect(coverage('新手引导上线', '首页新手引导上线')).toBeGreaterThan(WORKFLOW_MATCH_THRESHOLD)
    expect(coverage('缺陷分诊', '首页新手引导上线')).toBeLessThan(WORKFLOW_MATCH_THRESHOLD)
  })
})

describe('the retired team track', () => {
  it('is copied into team_archive once and its five tables dropped; a plan that still ran is archived as cancelled', () => {
    seedRetiredTrack()
    const archive = new TeamArchive(store)
    expect(tables().filter(name => (RETIRED_TEAM_TABLES as readonly string[]).includes(name))).toEqual([])
    const plans = archive.plans()
    expect(plans.map(plan => [plan.id, plan.status])).toEqual([['plan-b', 'cancelled'], ['plan-a', 'done']])
    expect(plans[0]).toMatchObject({ archivedRunning: true, running: 0, steps: [{ id: 'T1', state: 'cancelled' }, { id: 'T2', state: 'skipped' }] })
    expect(plans[1]).toMatchObject({ bots: ['设计 bot'], steps: [{ id: 'T1', state: 'done', report: '交互稿 5 屏' }], exchanges: [{ seq: 1, text: 'Plan: 目标 plan-a' }] })
    expect(plans[1]).not.toHaveProperty('archivedRunning')
    expect(archive.skills().map(skill => [skill.id, skill.state])).toEqual([['sk-1', 'active'], ['sk-2', 'draft']])
    // Opening again (the next start) changes nothing and recreates no retired table.
    const again = new TeamArchive(store)
    expect(again.plans()).toEqual(plans)
    expect(tables().filter(name => (RETIRED_TEAM_TABLES as readonly string[]).includes(name))).toEqual([])
  })
  it('leaves a database that never had it with an empty archive', () => {
    const archive = new TeamArchive(store)
    expect([archive.plans(), archive.skills()]).toEqual([[], []])
  })
  it('keeps one path that writes skills: no module of src writes a SKILL.md (team_distill → memory system only)', () => {
    const src = join(import.meta.dirname, '..', 'src')
    const files = readdirSync(src, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map(entry => join(entry.parentPath, entry.name))
    const writers = files.filter(file => { const text = readFileSync(file, 'utf8'); return text.includes('SKILL.md') && /\b(writeFile|writeFileSync|rename|mkdir)\s*\(/.test(text) })
    expect(writers).toEqual([])
    const distill = readFileSync(join(src, 'app', 'distill.ts'), 'utf8')
    expect(distill).toMatch(/bus\.rememberStep\(record\.evidence\)/)
  })
})

describe('workflows', () => {
  it('a workflow an old plan saved still prefills a proposal: its Bots become roles', () => {
    const retro = new Retrospective({ store, warn: () => {} })
    retro.tables.saveWorkflow({ id: 'wf-1', name: '首页新手引导上线', version: 1, fromPlanId: 'plan-a', goal: '首页新手引导上线', state: 'draft',
      params: [{ key: 'goal', label: '目标' }], steps: [{ key: 'T1', title: '交互方案', spec: '出稿', bot: '设计 bot', after: [] },
        { key: 'T2', title: '回归测试', spec: '测', bot: '测试 bot', after: ['T1'] }], gates: [], budget: { tokens: 1, turns: 1, parallel: 1 },
      triggers: ['manual'], runs: 0, ok: 100, at: '2026-11-01T00:00:00.000Z' })
    expect(retro.match('首页新手引导上线')).toHaveLength(0) // drafts are never matched
    expect(() => retro.prefill('wf-1')).toThrow(/draft/)
    retro.saveWorkflow('wf-1')
    expect(retro.match('首页新手引导上线')[0]?.score).toBeGreaterThanOrEqual(WORKFLOW_MATCH_THRESHOLD * 100)
    const prefilled = retro.prefill('wf-1')
    expect(prefilled.roles).toEqual([{ key: 'r1', need: '设计 bot', bot: '设计 bot' }, { key: 'r2', need: '测试 bot', bot: '测试 bot' }])
    expect(prefilled.steps.map(step => [step.key, step.role, step.access])).toEqual([['T1', 'r1', 'read'], ['T2', 'r2', 'read']])
    expect(() => retro.prefill('missing')).toThrow(/No workflow/)
  })
})
