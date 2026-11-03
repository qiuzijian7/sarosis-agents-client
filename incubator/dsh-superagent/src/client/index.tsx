/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
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
import { PluginConfig, usePageForm } from './deployment.tsx'
import { en, zh } from './locales.ts'
import type { T } from './text.ts'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
const ENTRY = 'dsh-superagent'

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
function Mounted({ ctx, t }: { ctx: ClientContext; t: T }) {
  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
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
  return <App t={t} openSession={openSession} deploymentForm={form} />
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
/**
 * VsSaros addition: in VsSaros the panel is a whole-page workbench (business only, no conversation), opened from the
 * pinned SuperAgent card of the Bots tab into the middle column. Its identity is `local:dsh-superagent` while it incubates;
 * packaged as a built-in it becomes `vssaros:superagent` (see package.json `vssaros.stage`).
 */
export const WORKBENCH = { title: 'SuperAgent', description: '把 TAPD 单子交给智能体处理：评估、执行，并在你审核同意后提交 P4。',
  package: 'dsh-superagent', icon: '🤖', customFrame: true, floatingActions: false } as const
interface Workbenches { register(descriptor: typeof WORKBENCH, panel: (props: Record<string, unknown>) => ReactNode): () => void }
/** Registers the panel, sidebar icon, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
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
    const host = (child as unknown as { desktopWorkbenches: Workbenches }).desktopWorkbenches
    withdraw?.()
    withdraw = undefined
    child.effect(() => host.register(WORKBENCH, () => <div data-vssaros-surface="workbench" className="dt-workbench">
      <Mounted ctx={ctx} t={t} />
    </div>), 'dsh-superagent: workbench')
  })
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
