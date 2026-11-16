/**
 * ★ 2026-11-11：普通会话 @SuperAgent → 主管接收任务 的新契约。
 *   覆盖三处：候选注册、Trigger 形态、来源 scope 放行。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerSuperagentMention } from '../src/client/mention.ts'
import { makeSuperagentKind, sessionTrigger, SuperagentConfigSchema, SUPERAGENT_MENTION, SUPERAGENT_SOURCE } from '../src/sources/superagent.ts'

describe('@SuperAgent in a normal session', () => {
  it('registers an @ candidate that inserts the shared mention marker', async () => {
    const registered: Record<string, unknown>[] = []
    const effect = (run: () => unknown) => { run(); return () => {} }
    const triggers = { registerSource: (spec: Record<string, unknown>) => { registered.push(spec); return () => {} } }
    const ctx = { inject: (_names: string[], run: (child: unknown) => void) => run(child), get: (name: string) => name === 'inputTriggers' ? triggers : undefined, effect }
    const child = { ...ctx }
    registerSuperagentMention(ctx as never)
    const spec = registered[0] as { trigger?: string; order?: number; header?: () => unknown[]; candidates?: (s: unknown, r: { query: string }) => Promise<unknown[]>; onPick?: (p: unknown) => { insert?: { ref?: string } }; codec?: { serialize: () => Promise<string> } }
    expect(spec?.trigger).toBe('@')
    expect(spec?.order).toBeGreaterThan(0)
    expect(spec?.header?.()).toEqual([expect.objectContaining({ current: true })])
    expect(await spec?.candidates?.(null, { query: 'super' })).toEqual([expect.objectContaining({ name: 'superagent', icon: 'file' })])
    expect(await spec?.candidates?.(null, { query: '@super' })).toHaveLength(1)
    expect(await spec?.candidates?.(null, { query: 'zzz' })).toEqual([])
    expect(spec?.onPick?.({ candidate: { label: 'SuperAgent · 主管' } })?.insert?.ref).toBe(SUPERAGENT_MENTION)
    expect(await spec?.codec?.serialize()).toBe(SUPERAGENT_MENTION)
    expect(child).toBeTruthy()
  })

  it('sessionTrigger points the reply back to the originating normal session', () => {
    const trigger = sessionTrigger({ session: 'session-7', messageId: 'msg-1', text: '@SuperAgent 帮我改个文案', at: '2026-11-11T00:00:00.000Z' })
    expect(trigger).toMatchObject({ id: `${SUPERAGENT_SOURCE}:session:msg-1`, source: SUPERAGENT_SOURCE,
      human: true, addressed: 'mention', meta: { from: 'session', session: 'session-7' } })
    expect(trigger.channel).toMatchObject({ source: SUPERAGENT_SOURCE, address: { kind: 'session', session: 'session-7' } })
  })

  it('the superagent Source listens to @SuperAgent messages and can be switched off', () => {
    const kind = makeSuperagentKind(async () => 'sent')
    const config = SuperagentConfigSchema.parse({})
    expect(kind.scope?.({ meta: { from: 'session', session: 'session-7' } }, config)).toMatchObject({ listened: true, row: 'session' })
    expect(kind.scope?.({ meta: { from: 'session' } }, { ...config, sessions: false })).toMatchObject({ listened: false, reason: 'superagent_sessions_off' })
    expect(kind.scope?.({ meta: { from: 'unknown' } }, config)).toMatchObject({ listened: false })
  })
  it('wires the mention into runtime and the client entry', () => {
    const runtime = readFileSync(join(__dirname, '../src/app/runtime.ts'), 'utf8')
    const entry = readFileSync(join(__dirname, '../src/client/index.tsx'), 'utf8')
    expect(runtime).toContain('SUPERAGENT_MENTION')
    expect(runtime).toMatch(/^\s*this\.passes\.receive\(sessionTrigger\(\{ session: session\.id/m)
    expect(entry).toContain('registerSuperagentMention(ctx)') // 实现与接线仍在，只是被开关挡住
  // ★ 2026-11-11（用户）：当前只停客户端注册；改回 true 恢复前请同步更新这条契约。
  expect(entry).toMatch(/REGISTER_SUPERAGENT_MENTION = false/)
  })
})
