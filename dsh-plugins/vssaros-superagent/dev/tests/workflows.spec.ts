// VsSaros addition (superagent v2, P5): team workflows from tickets' agreed teams, their reuse, and the TeamFlow adapter.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { TeamWorkflow } from '../src/app/retrospective.ts'
import { exportToTeamflow, importFromTeamflow, phaseOf, teamflowFile, teamflowProjectKey, toTeamflowTeam } from '../src/app/teamflow.ts'
import { stepSessionId } from '../src/app/steps.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'

let h: Host | undefined
const homes: string[] = []
afterEach(async () => {
  await h?.stop(); h = undefined
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'sa-teamflow-')); homes.push(dir); return dir }
const workflow = (over: Partial<TeamWorkflow> = {}): TeamWorkflow => ({ id: 'wf-1', name: '新手引导上线', version: 1, fromPlanId: '', source: 'ticket',
  goal: '新手引导上线', state: 'saved', params: [{ key: 'goal', label: '目标' }], gates: [], budget: { tokens: 300_000, turns: 90, parallel: 3 },
  triggers: ['manual'], runs: 1, ok: 100, at: '2026-11-05T00:00:00.000Z',
  roles: [{ key: 'design', need: '交互稿', bot: { id: 'designer', name: '设计 bot' } }, { key: 'test', need: '测试', bot: { id: 'tester', name: '测试 bot' } }],
  steps: [
    { key: 'T1', title: '交互稿', spec: '出 5 屏', after: [], role: 'design', bot: '设计 bot', access: 'read', phase: 'design' },
    { key: 'T2', title: '回归测试', spec: '跑回归', after: ['T1'], role: 'test', bot: '测试 bot', access: 'write' },
  ], ...over })

it('computes TeamFlow\'s project key and maps steps onto its seven stages', () => {
  // Same algorithm as dsh-plugin-teamflow store.ts slugPath: basename tag and sha1 of the slash-normalized path.
  expect(teamflowProjectKey('C:\\work\\tetris')).toMatch(/^ws-tetris-[0-9a-f]{8}$/)
  expect(teamflowProjectKey('C:\\work\\tetris')).toBe(teamflowProjectKey('C:/work/tetris'))
  expect(teamflowProjectKey('/a/新项目')).toMatch(/^ws-ws-[0-9a-f]{8}$/)
  expect(phaseOf({ title: '回归测试' })).toBe('qa')
  expect(phaseOf({ title: '写发版说明' })).toBeUndefined()
  expect(phaseOf({ title: '随便', phase: 'dev' })).toBe('dev')
  expect(toTeamflowTeam(workflow())).toMatchObject({ runnable: true, lossy: [],
    team: { id: 'sa-wf-1', needDesign: true, stages: [{ key: 'design', label: '交互稿', role: '设计 bot', optional: true }, { key: 'qa', label: '回归测试', role: '测试 bot' }] } })
  const lossy = toTeamflowTeam(workflow({ steps: [...workflow().steps,
    { key: 'T3', title: '补充测试', spec: 'x', after: [], role: 'test', bot: '测试 bot' },
    { key: 'T4', title: '发版说明', spec: 'x', after: [], role: 'test', bot: '测试 bot' }] }))
  expect(lossy.runnable).toBe(false)
  expect(lossy.lossy).toEqual(['T3 补充测试：与 T2 同属「qa」阶段，TeamFlow 每个阶段只有一个', 'T4 发版说明：TeamFlow 没有对应阶段'])
})

it('exports into teams.json replacing only its own team, keeps TeamFlow\'s and the person\'s, and never overwrites an unreadable file', () => {
  const dshHome = home(), cwd = 'C:\\work\\demo'
  const file = teamflowFile({ cwd, dshHome })
  // A workspace with no teams.json gets TeamFlow's built-in team beside ours.
  expect(exportToTeamflow(workflow(), { cwd, dshHome })).toMatchObject({ teamId: 'sa-wf-1', projectKey: teamflowProjectKey(cwd), runnable: true, file })
  expect(JSON.parse(readFileSync(file, 'utf8')).teams.map((team: { id: string }) => team.id)).toEqual(['dev', 'sa-wf-1'])
  const mine = { id: 'mine', name: '我的团队', icon: '🧪', description: 'x', stages: [{ key: 'dev', label: '开发', role: '我' }] }
  const before = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ version: 1, teams: [mine, ...before.teams] }), 'utf8')
  exportToTeamflow(workflow({ name: '改名后', version: 2 }), { cwd, dshHome })
  const after = JSON.parse(readFileSync(file, 'utf8')).teams as { id: string; name: string }[]
  expect(after.map(team => team.id)).toEqual(['mine', 'dev', 'sa-wf-1'])
  expect(after.find(team => team.id === 'sa-wf-1')!.name).toBe('改名后')
  expect(after[0]).toEqual(mine)
  expect(existsSync(`${file}.bak`)).toBe(true)
  writeFileSync(file, '{ broken', 'utf8')
  expect(() => exportToTeamflow(workflow(), { cwd, dshHome })).toThrow(/读不出来/)
  expect(readFileSync(file, 'utf8')).toBe('{ broken')
  expect(() => exportToTeamflow(workflow({ steps: [{ key: 'X', title: '发版说明', spec: 'x', after: [], bot: 'b' }] }), { cwd: 'C:\\work\\other', dshHome }))
    .toThrow(/没有一个步骤/)
})

it('imports TeamFlow\'s teams as workflow seeds whose roles still need Bots, leaving out the teams it exported', () => {
  const dshHome = home(), cwd = '/work/demo'
  const builtin = importFromTeamflow({ cwd, dshHome })
  expect(builtin.seeds).toHaveLength(1)
  expect(builtin.seeds[0]).toMatchObject({ name: '软件开发', source: 'teamflow', state: 'draft', steps: expect.arrayContaining([
    expect.objectContaining({ key: 'S1', title: 'PRD 产品需求', phase: 'prd', after: [] }), expect.objectContaining({ key: 'S2', after: ['S1'] })]) })
  expect(builtin.seeds[0]!.roles!.every(role => !role.bot)).toBe(true)
  exportToTeamflow(workflow(), { cwd, dshHome })
  expect(importFromTeamflow({ cwd, dshHome }).seeds.map(seed => seed.name)).toEqual(['软件开发'])
})

let clock = 0
const TEAM = { roles: [{ key: 'design', need: '交互稿', bot: 'designer' }, { key: 'test', need: '回归测试', bot: 'tester' }],
  steps: [{ key: 'T1', role: 'design', title: '交互稿', spec: '出 5 屏', phase: 'design' }, { key: 'T2', role: 'test', title: '回归测试', spec: '跑回归', after: ['T1'] }] }

/** Accepts a ticket, proposes `team`, and has a person agree to it; returns the ticket and its lead Session. */
async function agreedTicket(root: string, text: string, team: Record<string, unknown>) {
  const { ticket, sessionId } = await h!.acceptedTicket(feishu(root, text, { message_id: `om_${root}` }))
  const proposed = await h!.runTool(h!.runtime.masterId, 'orchestrator_team_propose', { ticket_id: ticket.id, ...team }) as Record<string, unknown>
  await new Promise(resolve => setTimeout(resolve, 5))
  const yes = feishu(`${root}9`, '同意', { mentions: [], message_id: `om_${root}9`, root_id: `om_${root}`, create_time: String(Date.now() + 1000 + (clock += 1000)) })
  h!.runtime.receive(yes); await h!.runtime.idle()
  await h!.runTool(h!.runtime.masterId, 'orchestrator_team_confirm', { ticket_id: ticket.id, trigger_id: yes.id, version: proposed.version })
  await h!.runtime.idle()
  return { ticketId: ticket.id, lead: sessionId, proposed }
}
async function finish(ticketId: string, lead: string, keys: string[]) {
  for (const key of keys) {
    await waitUntil(() => h!.runtime.steps.tables.get(ticketId, key)?.state === 'running')
    await h!.runTool(stepSessionId(ticketId, key), 'orchestrator_step_report', { state: 'ready', summary: `${key} 完成` })
  }
  await h!.runTool(lead, 'orchestrator_report', { state: 'ready', summary: '都好了' })
  await h!.runtime.idle()
}

it('leaves a draft workflow when a ticket\'s agreed team succeeds; once saved, it prefills a matching ticket\'s proposal and is credited when that ends', async () => {
  h = await startRuntime(undefined, { staffing: true })
  const first = await agreedTicket('1', '@bot 首页新手引导要上线，出交互稿并回归测试', TEAM)
  await finish(first.ticketId, first.lead, ['T1', 'T2'])
  expect(h.runtime.store.tickets.get(first.ticketId)?.ended?.outcome).toBe('completed')
  const drafts = h.runtime.retro.tables.workflows('draft')
  expect(drafts).toHaveLength(1)
  expect(drafts[0]).toMatchObject({ source: 'ticket', fromTicketId: first.ticketId, runs: 1, ok: 100, goal: '@bot 首页新手引导要上线，出交互稿并回归测试',
    roles: [{ key: 'design', bot: { id: 'designer' } }, { key: 'test', bot: { id: 'tester' } }],
    steps: [{ key: 'T1', role: 'design', phase: 'design', access: 'read' }, { key: 'T2', role: 'test', after: ['T1'] }] })
  // A draft is not offered; saved, it is.
  const second = await h.acceptedTicket(feishu('2', '@bot 设置页新手引导要上线，出交互稿并回归测试', { message_id: 'om_2' }))
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_team_bots', { ticket_id: second.ticket.id })).not.toHaveProperty('workflows')
  h.runtime.retro.saveWorkflow(drafts[0]!.id)
  const offered = await h.runTool(h.runtime.masterId, 'orchestrator_team_bots', { ticket_id: second.ticket.id }) as { workflows: { id: string; score: number }[] }
  expect(offered.workflows[0]).toMatchObject({ id: drafts[0]!.id })
  expect(offered.workflows[0]!.score).toBeGreaterThanOrEqual(70)
  // Prefilled, it still waits for a person, and says where it came from.
  const proposed = await h.runTool(h.runtime.masterId, 'orchestrator_team_propose', { ticket_id: second.ticket.id, workflow_id: drafts[0]!.id })
  expect(proposed).toMatchObject({ state: 'proposed', workflow: drafts[0]!.id, roles: [{ bot: 'designer' }, { bot: 'tester' }] })
  expect(h.runtime.store.receipts.get(`team-proposal:${second.ticket.id}:v1`)?.text).toContain(`按已保存的团队工作流「${drafts[0]!.name}」v1 预填`)
  const yes = feishu('29', '同意', { mentions: [], message_id: 'om_29', root_id: 'om_2', create_time: String(Date.now() + 5000) })
  h.runtime.receive(yes); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_team_confirm', { ticket_id: second.ticket.id, trigger_id: yes.id, version: 1 })
  await h.runtime.idle()
  await finish(second.ticket.id, second.sessionId, ['T1', 'T2'])
  expect(h.runtime.retro.tables.workflows()).toHaveLength(1)
  expect(h.runtime.retro.tables.workflow(drafts[0]!.id)).toMatchObject({ runs: 2, ok: 100, creditedTickets: [second.ticket.id] })
})

it('refuses to prefill from a draft, or a workflow whose roles have no Bot, and leaves no workflow for a dropped ticket', async () => {
  h = await startRuntime(undefined, { staffing: true })
  const dshHome = home()
  const [seed] = h.runtime.retro.importTeamflow({ cwd: '/work/demo', dshHome })
  expect(h.runtime.retro.importTeamflow({ cwd: '/work/demo', dshHome })).toEqual([])
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 做个需求', { message_id: 'om_1' }))
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_team_propose', { ticket_id: ticket.id, workflow_id: seed!.id }))
    .toMatchObject({ refused: expect.stringContaining('draft') })
  h.runtime.retro.saveWorkflow(seed!.id)
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_team_propose', { ticket_id: ticket.id, workflow_id: seed!.id }))
    .toMatchObject({ refused: expect.stringContaining('have no Bot yet') })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_team_propose', { ticket_id: ticket.id }))
    .toMatchObject({ refused: expect.stringContaining('Give roles and steps') })
  h.runtime.engine.stopTicket(ticket.id, '不做了')
  expect(h.runtime.retro.tables.workflows().filter(item => item.source === 'ticket')).toEqual([])
  // The panel's export writes a TeamFlow team (into this test's DSH_HOME, never the real one) and records it on the workflow.
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const exported = await h.api('POST', `team/workflows/${seed!.id}/teamflow`, { cwd: '/work/demo' })
    expect(exported.status).toBe(200)
  } finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous }
  expect(h.runtime.retro.tables.workflow(seed!.id)!.exports).toHaveLength(1)
  expect(existsSync(teamflowFile({ cwd: '/work/demo', dshHome }))).toBe(true)
})
