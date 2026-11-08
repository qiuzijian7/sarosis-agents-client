import { describe, expect, it, vi } from 'vitest'
import {
	GROUP_REFERENCE_KIND, addressedGroupMessage, fastGroupPlan, groupByNameMention, groupReferenceOf,
	groupFlowNotice, groupMadeNotice, handleDeskGroupCommand, handleDeskMessage, isGroupCreationRequest, mayBeGroupCommand, type GroupFastPathHost,
} from '../src/app/groupFastPath.ts'
import { wakesDesk } from '../src/app/desk-outbox.ts'
import type { ReceiveResult, Trigger } from '../src/core/index.ts'
import type { GroupView } from '../src/app/team.ts'

const ROSTER = [
  { id: 'superagent', name: 'SuperAgent', delegatable: false },
  { id: 'coder', name: 'Coder', delegatable: true },
  { id: 'designer', name: 'Designer', delegatable: true },
  { id: 'code-reviewer', name: 'Code Reviewer', delegatable: true },
  { id: 'writer', name: 'Writer', delegatable: false },
]
const group = (overrides: Partial<GroupView> = {}): GroupView => ({
  id: 'room-1', sessionId: 'room-1', name: '番茄钟 H5 开发团队',
  members: [{ id: 'coder', name: 'Coder' }, { id: 'designer', name: 'Designer' }, { id: 'code-reviewer', name: 'Code Reviewer' }],
  admin: 'coder', mode: 'admin', notice: '制作一个番茄钟 H5 应用', pinned: false, hidden: false, createdBy: 'superagent',
  ...overrides,
})
const trigger = (id = 'superagent:desk:m-fast') => ({ id } as Trigger)

function host(overrides: Partial<GroupFastPathHost> = {}) {
  const h = {
    receive: vi.fn((): ReceiveResult => 'stored'),
    settle: vi.fn(),
    requestPass: vi.fn(),
    bots: vi.fn(async () => ROSTER),
    createGroup: vi.fn(async () => group()),
    warn: vi.fn(),
    fallback: vi.fn(),
    ...overrides,
  }
  return h as GroupFastPathHost & typeof h
}

describe('P0 synchronous group creation', () => {
  it('recognises a group request but not a command to an existing group', () => {
    expect(isGroupCreationRequest('创建开发团队，制作一个番茄钟 H5应用')).toBe(true)
    expect(isGroupCreationRequest('建个群，拉 Coder 和 Designer')).toBe(true)
    expect(isGroupCreationRequest('@番茄钟 H5 开发团队 开始制作')).toBe(false)
    expect(isGroupCreationRequest('同意组队方案 v1')).toBe(false)
  })
  it('picks suitable Bots, keeps SuperAgent out, and derives a name/notice from the request', () => {
    const plan = fastGroupPlan('创建开发团队，制作一个番茄钟 H5应用', ROSTER)
    expect(plan).toMatchObject({ members: ['coder', 'designer', 'code-reviewer'], mode: 'admin' })
    expect(plan?.name).toContain('番茄钟')
    expect(plan?.notice).toContain('制作')
    expect(fastGroupPlan('创建开发团队', [{ id: 'coder', name: 'Coder' }])).toBeUndefined()
  })
  // VsSaros addition (2026-11-06): design → develop → review → browser test, bugs back to the developer, re-test.
  it('adds the tester to a group asked to build something, and chains the members in the notice', () => {
    const roster = [...ROSTER, { id: 'tester', name: 'Tester', delegatable: true }]
    const plan = fastGroupPlan('建群开发一个h5的番茄钟应用', roster)!
    expect(plan.members).toEqual(['coder', 'designer', 'code-reviewer', 'tester'])
    expect(plan.notice).toMatch(/^开发一个h5的番茄钟应用/)
    expect(plan.notice).toContain('管理员 Coder 先 @Designer 出设计方案')
    // 2026-11-06 (P1): the admin sets these steps as the group goal's stages first.
    expect(plan.notice).toContain('管理员 Coder 先用 group_goal 把下面几步设成群目标的阶段')
    expect(plan.notice).toContain('@Code Reviewer 评审；评审有问题 @Coder 修改，评审通过后 @Tester')
    expect(plan.notice).toContain('Tester 在后台起本地预览服务，用浏览器打开逐项点测；有问题 @Coder')
    expect(plan.notice).toContain('Coder 修完后 @Tester 复测；最多复测 3 轮')
    expect(plan.notice.length).toBeLessThanOrEqual(2000)
    // A group for talking, not building: no tester, no flow.
    const chat = fastGroupPlan('建个群，讨论下周排期', roster)!
    expect(chat.members).not.toContain('tester')
    expect(chat.notice).not.toContain('协作流程')
    // Without a designer or reviewer the flow skips them.
    expect(groupFlowNotice({ coder: 'Coder', tester: 'Tester' })).toContain('Coder 开发完成后 @Tester。')
  })
  it('makes the group at desk intake, records ignore, drives a pass, and tells the requester', async () => {
    const h = host()
    const result = await handleDeskMessage(h, trigger(), '创建开发团队，制作一个番茄钟 H5应用')
    expect(result).toBe('group')
    expect(h.bots).toHaveBeenCalledOnce()
    expect(h.receive).toHaveBeenCalledOnce()
    expect(h.createGroup).toHaveBeenCalledWith(expect.objectContaining({ originTriggerId: 'superagent:desk:m-fast', members: ['coder', 'designer', 'code-reviewer'] }))
    expect(h.settle).toHaveBeenCalledOnce()
    expect(h.settle).toHaveBeenCalledWith('superagent:desk:m-fast', {
      reason: expect.stringMatching(/Synchronous group chat created/),
      route: { roomId: 'room-1', roomName: '番茄钟 H5 开发团队', kind: 'created' },
      notice: { id: 'group-created:room-1', text: expect.stringMatching(/^已建群「番茄钟 H5 开发团队」/) },
    })
    expect(h.requestPass).toHaveBeenCalledOnce()
    expect(h.fallback).not.toHaveBeenCalled()
  })
  // VsSaros addition (2026-11-06): two groups named 番茄钟 H5 开发团队 side by side.
  it('says the existing same-name group was edited, under a notice of its own, when the Bots plugin reused it', async () => {
    const h = host({ createGroup: vi.fn(async () => group({ reused: true, added: ['Code Reviewer'], removed: ['Writer'] })) as never })
    expect(await handleDeskMessage(h, trigger('superagent:desk:m-again'), '创建开发团队，制作一个番茄钟 H5应用')).toBe('group')
    expect(h.settle).toHaveBeenCalledWith('superagent:desk:m-again', {
      reason: expect.stringMatching(/Synchronous group chat updated/),
      route: { roomId: 'room-1', roomName: '番茄钟 H5 开发团队', kind: 'updated' },
      notice: { id: 'group-updated:room-1:superagent:desk:m-again',
        text: expect.stringMatching(/^已有同名群「番茄钟 H5 开发团队」，没有另建，已加入 Code Reviewer，移出 Writer。现在的成员：Coder、Designer、Code Reviewer，管理员 Coder。/) },
    })
    expect(groupMadeNotice(group({ reused: true, added: [], removed: [] }), 't').text).toMatch(/成员没有变化/)
    expect(groupMadeNotice(group(), 't').id).toBe('group-created:room-1')
    expect(wakesDesk({ id: 'group-updated:room-1:t', kind: 'notice', text: '', channel: { source: 'superagent', thread: 'x' } } as never)).toBe(true)
  })
  it('leaves every other message on the normal intake path', async () => {
    const h = host()
    expect(await handleDeskMessage(h, trigger(), '@番茄钟 H5 开发团队 开始制作')).toBe('fallback')
    expect(h.fallback).toHaveBeenCalledOnce()
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.createGroup).not.toHaveBeenCalled()
  })
  it('passes the same originTriggerId when the desk hands a duplicate over, so the Bots plugin reuses the room', async () => {
    const h = host({ receive: vi.fn(() => 'duplicate') as never })
    expect(await handleDeskMessage(h, trigger('superagent:desk:m-dup'), '建个群，拉 Coder 和 Designer')).toBe('group')
    expect(h.createGroup).toHaveBeenCalledWith(expect.objectContaining({ originTriggerId: 'superagent:desk:m-dup' }))
  })
  it('falls back to the model path when the Bots plugin cannot create a group', async () => {
    const h = host({ createGroup: vi.fn(async () => { throw new Error('Bots not ready') }) as never })
    expect(await handleDeskMessage(h, trigger(), '创建开发团队，制作一个番茄钟 H5应用')).toBe('failed')
    expect(h.fallback).toHaveBeenCalledOnce()
    expect(h.settle).not.toHaveBeenCalled()
  })
  it('recognises a DSH session-reference to an existing group and a plain @group mention', () => {
    const rooms = [group()]
    const event = { type: 'user/message', data: { source: { kind: GROUP_REFERENCE_KIND, references: [
      { sessionId: 'room-1', label: '番茄钟 H5 开发团队' }] } } }
    const ref = groupReferenceOf(event, rooms)
    expect(ref?.room.id).toBe('room-1')
    expect(addressedGroupMessage('@番茄钟 H5 开发团队 开始制作', ref!)).toBe(true)
    expect(addressedGroupMessage('这是背景资料，见 @番茄钟 H5 开发团队', ref!)).toBe(false)
    expect(groupByNameMention('@番茄钟 H5 开发团队 开始制作', rooms)?.room.id).toBe('room-1')
    expect(groupByNameMention('普通需求，不要建群', rooms)).toBeUndefined()
  })
  it('records ignore and the route at intake for @existing group, so the main Session does not evaluate it', async () => {
    const h = {
      receive: vi.fn((): ReceiveResult => 'stored'),
      settle: vi.fn(),
      requestPass: vi.fn(),
      listGroups: vi.fn(async () => [group()]),
      warn: vi.fn(),
    }
    const event = { type: 'user/message', data: { source: { kind: GROUP_REFERENCE_KIND, references: [
      { sessionId: 'room-1', label: '番茄钟 H5 开发团队' }] } } }
    const result = await handleDeskGroupCommand(h, trigger('superagent:desk:m-ref'), '@番茄钟 H5 开发团队 开始制作', event, { sourceMessageId: 'm-ref' })
    expect(result).toBe('group-command')
    expect(h.receive).toHaveBeenCalledOnce()
    expect(h.settle).toHaveBeenCalledWith('superagent:desk:m-ref', {
      reason: expect.stringMatching(/^Routed to existing group: /),
      route: { roomId: 'room-1', roomName: '番茄钟 H5 开发团队', kind: 'routed', sourceMessageId: 'm-ref' },
      // 2026-11-07: the group runs a ticket for it, titled without the @group it starts with
      ticket: { title: '开始制作', scope: '@番茄钟 H5 开发团队 开始制作' },
    })
    expect(h.requestPass).toHaveBeenCalledOnce()
    expect(h.warn).not.toHaveBeenCalled()
  })
  it('marks a late reference in the reason and still settles it', async () => {
    const h = { receive: vi.fn((): ReceiveResult => 'duplicate'), settle: vi.fn(), requestPass: vi.fn(), listGroups: vi.fn(async () => [group()]), warn: vi.fn() }
    const event = { type: 'user/message', data: { source: { kind: GROUP_REFERENCE_KIND, references: [{ sessionId: 'room-1', label: '番茄钟 H5 开发团队' }] } } }
    expect(await handleDeskGroupCommand(h, trigger('superagent:desk:m-late'), '@番茄钟 H5 开发团队 开始', event, { sourceMessageId: 'm-late', late: true }))
      .toBe('group-command')
    expect(h.settle).toHaveBeenCalledWith('superagent:desk:m-late', expect.objectContaining({ reason: expect.stringMatching(/late reference/) }))
    // A late reference opens no ticket: the message may already be in the main Session's batch.
    expect(h.settle.mock.calls[0]![1]).not.toHaveProperty('ticket')
  })
  it('only messages that start with @ may be group commands, so the others never wait for a reference', () => {
    expect([mayBeGroupCommand('@番茄钟 开始'), mayBeGroupCommand('  @x'), mayBeGroupCommand('创建开发团队'), mayBeGroupCommand('')]).toEqual([true, true, false, false])
  })
  it('leaves an unrelated session reference on the normal intake path', async () => {
    const h = {
      receive: vi.fn((): ReceiveResult => 'stored'),
      settle: vi.fn(), requestPass: vi.fn(), listGroups: vi.fn(async () => [group()]), warn: vi.fn(),
    }
    const event = { type: 'user/message', data: { source: { kind: GROUP_REFERENCE_KIND, references: [
      { sessionId: 'other', label: '别的会话' }] } } }
    expect(await handleDeskGroupCommand(h, trigger(), '@别的会话 请看一下', event)).toBe('fallback')
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.settle).not.toHaveBeenCalled()
  })
})
