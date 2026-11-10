/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { App } from './app.tsx'
import type { NativeConversation } from './chat.tsx'
import { disposeFeed } from './feed.ts'
import { FlowCard, triggerOfResult } from './flow-card.tsx'
import { BotMark } from './mark.tsx'
import { CardProvider } from './provider.tsx'
import { PluginConfig, usePageForm } from './deployment.tsx'
import { en, zh } from './locales.ts'
import type { T } from './text.ts'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
/** The plugin row's id in the bundle patch (kept from upstream, so saved settings carry over). */
const ENTRY = 'dsh-superagent'

/**
 * ★ 2026-11-10：跨 chunk 旁路统一「记住的群」。
 *   本插件的 @群 / 流程卡 / 群执行卡都会调 openSession(roomId)，但 chat-surface 的选中态
 *   只在侧栏群行点击时更新 ⇒ Host 仍按旧群放宽转投。这里在 openSession 入口认出群 id，
 *   走 client.workspaces.js 注册的桥（没装该 chunk 时静默跳过，不影响打开会话）。
 */
function noteSelectedRoom(id: string): void {
  try {
    const w = window as unknown as { __vssarosKnownRoomIds?: Set<string>; __vssarosSelectRoom?: (roomId: string) => void }
    if (w.__vssarosKnownRoomIds?.has(id) && typeof w.__vssarosSelectRoom === 'function') { w.__vssarosSelectRoom(id) }
  } catch { /* 选中态失败不影响打开会话 */ }
}

/** VsSaros change: the package as a VsSaros built-in. */
const PACKAGE = '@vssaros/dsh-superagent'

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

/** What the VsSaros workbench host gives a workbench that frames itself (`customFrame`): its service and the docked conversation. */
export interface WorkbenchProps {
  service?: { ensureSession(options: { sessionId: string }): Promise<string> }
  conversation?: ReactNode
  active?: boolean
}
/** The host's docked conversation, for the Chat tab; none outside a VsSaros workbench. */
export function nativeOf(workbench: WorkbenchProps | undefined): NativeConversation | undefined {
  const service = workbench?.service
  if (!service || workbench.conversation === undefined) return undefined
  return { node: workbench.conversation, active: workbench.active !== false,
    dock: async sessionId => { await service.ensureSession({ sessionId }) } }
}

/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
function Mounted({ ctx, t, workbench }: { ctx: ClientContext; t: T; workbench?: WorkbenchProps }) {
  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
    noteSelectedRoom(id)
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }, [ctx, t])
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  const service = workbench?.service, active = workbench?.active
  const native = useMemo(() => nativeOf(workbench), [service, active, workbench?.conversation !== undefined])
  return <App t={t} openSession={openSession} deploymentForm={form} native={native} />
}

/** The props DSH's tool UI gives a tool view, as far as the desk's card reads them. */
interface DeskToolProps { phase: string; block?: { content?: readonly { type?: string; text?: string }[] } }
/** The desk's ticket-end tool (`RECEIPT_TOOL` in app/desk.ts, which the client bundle does not import; a test keeps them equal). */
export const RECEIPT_TOOL_NAME = 'superagent_ticket_result'
/**
 * The desk's one tool in DSH's chat: while it runs, a line saying the message goes to the supervisor; once it settled, the
 * message's key-node card (`flow-card.tsx`), which follows it live. VsSaros addition (2026-11-06): with `receipt`, the
 * desk's `superagent_ticket_result` call (made by SuperAgent when a desk ticket ends) as the ticket's end card.
 */
function deskToolView(ctx: ClientContext, t: T, receipt = false) {
  const openSession = async (id: string) => {
    noteSelectedRoom(id)
    try { await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, new AbortController().signal) }
    catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }
  return function DeskToolView({ phase, block }: DeskToolProps) {
    const trigger = phase === 'result' ? triggerOfResult(block?.content) : undefined
    return <CardProvider t={t} openSession={openSession}>
      {trigger ? <FlowCard triggerId={trigger} receipt={receipt} />
        : <div className="dt-fc dt-fc-line" data-testid="flow-card"><BotMark id="superagent" size={18} state={phase === 'result' ? 'idle' : 'sending'} />
          {t(receipt ? 'flow.receiptLoading' : phase === 'result' ? 'flow.handed' : 'flow.handing')}</div>}
    </CardProvider>
  }
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
/**
 * VsSaros addition: in VsSaros the panel is a whole-page workbench, a built-in one whose identity is `vssaros:superagent`
 * (its package's `vssaros.workbench`; title, description and icon must match it word for word). It frames itself
 * (`customFrame`), so the host gives it DSH's own conversation to dock: the Chat tab shows the supervisor desk in it.
 */
export const WORKBENCH = { title: 'SuperAgent', description: 'SuperAgent 主管：接收飞书、GitHub、TAPD 和主管对话里的需求，评估后组建 bot 团队，经你同意再分工执行，并沉淀技能。',
  icon: 'codicon:robot', repository: 'vssaros:superagent', customFrame: true, floatingActions: false } as const
interface Workbenches { register(descriptor: typeof WORKBENCH, panel: (props: Record<string, unknown>) => ReactNode): () => void }
/** Registers the panel, sidebar icon, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  // VsSaros addition (2026-11-07): the change stream's module state ends with this plugin (`disposeFeed`).
  ctx.effect(() => () => { disposeFeed() }, 'dsh-superagent: change stream')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  // VsSaros addition: where a workbench host runs (VsSaros), SuperAgent is one of its workbenches, so the sidebar entry
  // below the home page is that workbench's own row rather than a second, panel entry of ours. The host registers later
  // than this plugin, so the sidebar entry is withdrawn once it appears instead of being skipped by a check that is
  // always false at this point.
  let withdraw: (() => void) | undefined
  ctx.slots.inject('sidebar.panellist', () => {
    const dispose = ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, HammerIcon)
    withdraw = dispose
    return dispose
  })
  ctx.inject(['desktopWorkbenches'], child => {
    const desktopWorkbenches = (child as unknown as { desktopWorkbenches: Workbenches }).desktopWorkbenches
    withdraw?.()
    withdraw = undefined
    // VsSaros addition (2026-11-06): `data-vssaros-group-tip="off"` asks chat-surface not to float its "sent to group" tip over
    // this workbench, which already shows group runs on the message cards and the Work and Execution tabs.
    child.effect(() => desktopWorkbenches.register(WORKBENCH, props => <div data-vssaros-surface="workbench" data-vssaros-group-tip="off" className="dt-workbench">
      <Mounted ctx={ctx} t={t} workbench={props as WorkbenchProps} />
    </div>), 'dsh-superagent: workbench')
  })
  // VsSaros addition (plan C): in DSH's chat of the desk, the desk's hand-over tool is drawn as the message's key-node card.
  // The slot belongs to DSH's tool UI, whose types this package does not carry; the tool exists in the desk Session only.
  const slots = ctx.slots as unknown as { inject(name: string, register: () => () => void): void; register(entry: object, view: unknown): () => void }
  slots.inject('tool.call.toolview', () => slots.register({ name: 'tool.call.toolview', key: 'superagent_submit' }, deskToolView(ctx, t)))
  // VsSaros addition (2026-11-06): a desk ticket's end, in the desk's turn SuperAgent makes for it (app/desk.ts RECEIPT_TOOL).
  slots.inject('tool.call.toolview', () => slots.register({ name: 'tool.call.toolview', key: RECEIPT_TOOL_NAME }, deskToolView(ctx, t, true)))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${PACKAGE}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
