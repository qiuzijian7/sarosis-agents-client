/**
 * ★ 2026-11-11（用户）：普通会话里像 @文件 一样弹出 SuperAgent 候选项。
 *
 * 官方 @ 输入流水线允许第三方注册 source（trigger: '@'），范式见
 * dsh-plugins/vssaros-kb-refs/lib/client.js:217-238。这里注册一条固定候选：
 * 选中后插入 `@SuperAgent`，提交期 codec.serialize 原样保留这个标记，
 * Host 的 session/event(user/message) 里由 runtime.ts 认出并交给主管。
 *
 * ⚠ 用 ctx.inject 动态等待 inputTriggers，不写进静态 inject 数组：
 *    缺该服务的组合里静态 inject 会让插件永久 pending（历史教训 ✓）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { SUPERAGENT_MENTION } from '../superagent-identity.ts'
/** ★ 官方把 source 的 name 当分组标题渲染（kb-refs 用「知识库」），必须是给用户看的名字。 */
const SOURCE_NAME = 'SuperAgent'

type Pick = { candidate?: { label?: string; value?: string }; action?: string }

export function registerSuperagentMention(ctx: Context): void {
  // 用 Reflect 读可选服务，避免双重类型断言（check-superagent-ratchet 的强转基线只减不增）。
  const inject = Reflect.get(ctx, 'inject') as ((names: string[], run: (child: Context) => void) => void) | undefined
  // 测试桩 / 无输入流水线服务的组合里静默跳过，不能让整个 client apply 挂掉。
  if (typeof inject !== 'function') return
  inject.call(ctx, ['inputTriggers'], (child: Context) => {
    const get = Reflect.get(child, 'get') as ((name: string) => unknown) | undefined
    const triggers = get?.call(child, 'inputTriggers') as { registerSource?(spec: unknown): () => void } | undefined
    const register = triggers?.registerSource?.bind(triggers)
    if (typeof register !== 'function') return
    child.effect(() => register({
      trigger: '@',
      name: SOURCE_NAME,
      // 与 kb-refs 同形：async candidates、合法 icon('file')、正数 order、显式 header。
      order: 20,
      header: () => [{ label: SOURCE_NAME, current: true }],
      candidates: async (_session: unknown, req: { query?: string }) => {
        // 契约里 query 是「@ 与光标之间的文本」；容忍某些 Host 把 '@' 一起带进来。
        const query = String(req?.query ?? '').trim().toLowerCase().replace(/^@/, '')
        const matches = !query || 'superagent'.includes(query) || '主管'.includes(query)
        return matches ? [{ name: 'superagent', label: 'SuperAgent · 主管',
          description: '把这条消息交给 SuperAgent 评估并执行', icon: 'file', value: SUPERAGENT_MENTION }] : []
      },
      onPick: (pick: Pick) => {
        const value = pick?.candidate?.value ?? SUPERAGENT_MENTION
        if (pick?.action === 'drill') return { text: value, continue: true }
        return { insert: { source: SOURCE_NAME, ref: value,
          label: pick?.candidate?.label ?? 'SuperAgent', appearance: 'file', clipboardText: value } }
      },
      codec: { clipboardText: () => SUPERAGENT_MENTION, serialize: async () => SUPERAGENT_MENTION },
    }), 'dsh-superagent: @SuperAgent mention')
  })
}
