/** Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '../infra/host.ts'
import type { RoleModel } from '../policy.ts'

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  await ctx.llm.resolveModelInfo(value.provider, value.model)
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** Repair only a removed durable route, using the operator's configured role model; never overwrite a valid manual selection or the global default. */
export async function recoverRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  let pending: ModelSelection | undefined
  let used: ModelSelection | undefined
  const routeEvents = () => agent.session.snapshotEvents().filter(event => event.type === 'model/selection' || event.type === 'request/header')
  const events = routeEvents()
  for (const event of events) {
    if (event.type === 'model/selection') pending = { provider: event.data.provider, model: event.data.model,
      ...(event.data.reasoningEffort ? { reasoningEffort: ReasoningEffortId(event.data.reasoningEffort) } : {}) }
    if (event.type === 'request/header') {
      const config = event.data.header.config
      used = { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) }
      if (pending?.provider === used.provider && pending.model === used.model && pending.reasoningEffort === used.reasoningEffort) pending = undefined
    }
  }
  const current = pending ?? used
  if (!current) { if (model) await resolveRoleModel(ctx, model); return }
  try { await ctx.llm.resolveModelInfo(current.provider, current.model); return }
  catch (error) {
    const code = (error as { code?: string }).code
    if (!['UNKNOWN_MODEL', 'UNKNOWN_PROVIDER'].includes(code ?? '') && !/no configured model|unknown provider/i.test(String(error))) throw error
    if (!model) throw new Error(`会话模型已失效：${current.provider}/${current.model}，请在设置中配置可用的主管或执行模型`)
    const selected = await resolveRoleModel(ctx, model)
    if (routeEvents().length !== events.length) return
    if (selected.provider === current.provider && selected.model === current.model) throw error
    agent.session.append('model/selection', selected)
    await ctx.sessionPersistence.flush()
    ctx.logger.warn('dsh-superagent: recovered unavailable session model %s/%s -> configured %s/%s for the next request; historical compaction routing advances only after a real request', current.provider, current.model, selected.provider, selected.model)
  }
}

/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  const selected = await resolveRoleModel(ctx, model)
  // Avoid selectModel because it mutates the global DSH default; inject the selection for the initial request only.
  agent.session.append('model/selection', selected)
  let initial = true
  let assembled: ModelSelection | undefined
  agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = initial ? selected : undefined
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
      }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  await ctx.sessionPersistence.flush()
}

/**
 * ★ 2026-11-13：把模型/凭据类失败翻成可执行的中文报告，而不是把裸 `LlmError` 写进工单。
 * 真机曾出现 `LlmError: No API key for provider: vssaros-ollama`：执行器未配置模型、
 * 继承的 DSH 默认 route 又是 keyless，报错发生在真实请求时，事前校验拦不住。
 * 只匹配明确的「模型/凭据缺失」形态，其它错误（工具 schema、网络、prepare 命令）原样保留。
 */
export function modelReportText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
  if (code === 'MODEL_SWITCH_COMPACTION_FAILED' || /MODEL_SWITCH_COMPACTION_FAILED/i.test(text)) return `模型切换因历史上下文压缩失败而受阻（${text}）。保留原会话与任务，请确认可用的压缩模型或使用支持迁移的运行时；未修改全局模型，也未伪造历史请求。`
  if (/No API key for provider|MISSING_CREDENTIAL|INVALID_CREDENTIAL|unknown provider|No usable model|model not configured|UNKNOWN_MODEL|no configured model/i.test(text)) {
    return `模型未配置或已不可用：当前会话无法使用其模型（${text}）。请检查主管模型配置，或在「设置 → 执行」修正执行模型及服务商凭据。`
  }
  return text
}
