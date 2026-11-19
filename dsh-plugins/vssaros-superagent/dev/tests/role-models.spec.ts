import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel, modelReportText, recoverRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  const info = vi.fn(async (provider: string, model: string) => ({ provider, id: model, name: model }))
  ctx.reflect.provide('llm', { resolveCallConfig: resolve, resolveModelInfo: info })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  const host: ModelSelectionRef = { get current() { return session.requestHeader()?.config ?? { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') } }, assembled: undefined }
  installModelSelection(ctx, host)
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const record = (selection: ModelSelection) => { const event = session.append('request/header', { header: { config: selection }, reason: 'initial' }); ctx.emit('session/event', session, event) }
  return { ctx, agent, host, resolve, info, flush, request, record }
}
it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  const { ctx, agent, request, record, flush } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  const selected = await request()
  expect(selected).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(flush).toHaveBeenCalledOnce()
  record(selected)
  // A retry of the same assembled step keeps the same model even after the header is persisted.
  expect(await request()).toEqual(selected)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(selected)
})
it('lets a later explicit selection win without changing the in-flight assembled step', async () => {
  const { ctx, agent, host, request } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  Object.defineProperty(host, 'current', { value: manual, configurable: true })
  const event = agent.session.append('model/selection', manual); ctx.emit('session/event', agent.session, event)
  expect(await request()).toEqual({ provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(manual)
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
})
it('reports a model/credential failure as an actionable Chinese error, leaving other failures intact', () => {
  for (const raw of ['LlmError: No API key for provider: vssaros-ollama', 'MISSING_CREDENTIAL', 'unknown provider nowhere']) {
    expect(modelReportText(new Error(raw))).toContain('模型未配置')
    expect(modelReportText(new Error(raw))).toContain('设置 → 执行')
  }
  const compaction = Object.assign(new Error('Unable to summarize old model'), { code: 'MODEL_SWITCH_COMPACTION_FAILED' })
  expect(modelReportText(compaction)).toContain('历史上下文压缩失败')
  expect(modelReportText(compaction)).toContain('未修改全局模型')
  expect(modelReportText(new Error('Invalid tool schema'))).toBe('Invalid tool schema')
  expect(modelReportText('The prepare command failed: fatal: no such clone')).toBe('The prepare command failed: fatal: no such clone')
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, request } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})

it('repairs the removed hy3-ioa route with the configured hy4std without altering the global model', async () => {
  const { ctx, agent, info, record, flush } = await fixture()
  record({ provider: 'vssaros-codebuddy', model: 'hy3-ioa' })
  info.mockImplementation(async (provider, id) => {
    if (id === 'hy3-ioa') throw Object.assign(new Error('no configured model hy3-ioa'), { code: 'UNKNOWN_MODEL' })
    return { provider, id, name: id }
  })
  await recoverRoleModel(ctx, agent, { provider: 'vssaros-codebuddy', model: 'hy4std' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data).toEqual({ provider: 'vssaros-codebuddy', model: 'hy4std' })
  expect(flush).toHaveBeenCalledOnce()
  await recoverRoleModel(ctx, agent, { provider: 'vssaros-codebuddy', model: 'hy4std' })
  expect(flush).toHaveBeenCalledOnce()
})
it('does not replace a valid per-session model with the role model', async () => {
  const { ctx, agent, record, flush, resolve } = await fixture()
  record({ provider: 'manual', model: 'valid' })
  await recoverRoleModel(ctx, agent, { provider: 'worker', model: 'different' })
  expect(resolve).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
})
it('does not substitute models on network errors and fails clearly when no valid configured replacement exists', async () => {
  const { ctx, agent, record, info, flush } = await fixture()
  record({ provider: 'provider', model: 'old' })
  info.mockRejectedValueOnce(new Error('network timeout'))
  await expect(recoverRoleModel(ctx, agent, { provider: 'provider', model: 'new' })).rejects.toThrow('network timeout')
  info.mockRejectedValue(Object.assign(new Error('no configured model'), { code: 'UNKNOWN_MODEL' }))
  await expect(recoverRoleModel(ctx, agent, null)).rejects.toThrow('会话模型已失效')
  await expect(recoverRoleModel(ctx, agent, { provider: 'provider', model: 'missing' })).rejects.toThrow('no configured model')
  expect(flush).not.toHaveBeenCalled()
})
it('preserves a new user model selection made during recovery lookup', async () => {
  const { ctx, agent, record, info, flush } = await fixture()
  record({ provider: 'provider', model: 'old' })
  info.mockImplementation(async (provider, id) => {
    if (id === 'old') throw Object.assign(new Error('no configured model'), { code: 'UNKNOWN_MODEL' })
    if (id === 'configured') agent.session.append('model/selection', { provider: 'manual', model: 'new-choice' })
    return { provider, id, name: id }
  })
  await recoverRoleModel(ctx, agent, { provider: 'provider', model: 'configured' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data)
    .toEqual({ provider: 'manual', model: 'new-choice' })
  expect(flush).not.toHaveBeenCalled()
})
