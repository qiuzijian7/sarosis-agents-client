import { expect, it, vi } from 'vitest'
import { Sessions } from '../src/app/sessions.ts'

function fixture(existing: boolean) {
  const members: string[] = []
  const workspace = { id: '/actual/project', sessionIds: members, attachSession: vi.fn(async (id: string) => { members.push(id) }) }
  const agent = { id: 'step-ticket-build', session: { id: 'step-ticket-build', header: { cwd: '/actual/project' } } }
  let present = existing
  const ctx = {
    workspaceRegistry: { create: vi.fn(async (_cwd: string) => workspace) },
    sessionController: {
      resolveAgent: vi.fn(async () => present ? { agent } : { error: { code: 'session/not-found' } }),
      create: vi.fn(async () => { present = true }), rename: vi.fn(async () => {}),
    },
    permissionPresets: { set: vi.fn() },
  }
  const sessions = Object.create(Sessions.prototype) as Sessions
  Object.assign(sessions, {
    ctx, host: { store: { settings: () => ({}) }, masterId: 'router', deskId: 'desk' },
    decorate: vi.fn(async () => {}), bindings: new Map(),
  })
  return { sessions, ctx, workspace, agent, members }
}

it('registers a newly created execution session in its real workspace before execution', async () => {
  const { sessions, ctx, workspace, agent, members } = fixture(false)
  await expect(sessions.ensure(agent.id, '/requested/project', 'Build', 'step', 'build-bot', 'workspace-write')).resolves.toBe(agent)
  expect(ctx.sessionController.create).toHaveBeenCalledWith({ sessionId: agent.id, workspaceId: workspace.id, agentPreset: 'build-bot' })
  expect(ctx.workspaceRegistry.create.mock.calls.map(call => call[0])).toEqual(['/requested/project', '/actual/project'])
  expect(members).toEqual([agent.id])
  expect(ctx.permissionPresets.set).toHaveBeenCalledWith(agent.session, 'workspace-write')
})

it('repairs existing session membership using the immutable session cwd without recreating it', async () => {
  const { sessions, ctx, agent, workspace } = fixture(true)
  await sessions.ensure(agent.id, '/another/project', 'Build', 'step')
  await sessions.ensure(agent.id, '/another/project', 'Build', 'step')
  expect(ctx.sessionController.create).not.toHaveBeenCalled()
  expect(ctx.workspaceRegistry.create).toHaveBeenCalledWith('/actual/project')
  expect(workspace.attachSession).toHaveBeenCalledExactlyOnceWith(agent.id)
})

it('exposes desk, workers and team steps but not the internal router or inherited subagents', () => {
  const { sessions } = fixture(true)
  const agent = (id: string) => ({ id, session: { id } })
  Object.assign(sessions, { bindings: new Map([
    [agent('router'), { disposers: [] }], [agent('desk'), { disposers: [] }],
    [agent('worker-task'), { disposers: [] }], [agent('step-task-build'), { disposers: [] }],
    [agent('child'), { disposers: [], subagent: true }],
  ]) })
  expect(sessions.workbenchSessions()).toEqual(['desk', 'worker-task', 'step-task-build'])
})
