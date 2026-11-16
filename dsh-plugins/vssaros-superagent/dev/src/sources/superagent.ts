/**
 * VsSaros addition: the `superagent` Source kind. Work reaches the supervisor here from two places in this Host:
 * - the supervisor desk, a DSH Session where a person talks to SuperAgent (`desk:<session>` Threads); its messages are a
 *   person's, addressed to the agent, and the person at this machine is on the Source's list by default;
 * - another VsSaros Bot asking the supervisor for help with `agent_message` (`bot:<session>` Threads); such a message is a
 *   bot's, so it is admitted at most as an inferred candidate, and only from a Bot on the Source's `bots` list.
 * Replies go back into the Session the message came from: into the desk without waking it, and to a Bot as a steering
 * message, as `agent_message` does. The kind is built by the Runtime, which owns both Sessions (see `src/app/desk.ts`).
 */
import { z } from 'zod'
import { isAbsolute, win32 } from 'node:path'
import { threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import type { SourceKind } from './kind.ts'

export const SUPERAGENT_SOURCE = 'superagent'
export { SUPERAGENT_MENTION } from '../superagent-identity.ts'
/** The actor of a desk message: the person at this machine, who is on the Source's list until a person removes them. */
export const DESK_PERSON = { id: 'local', name: '本机用户' } as const
/** The most relays a help request may have passed through, as in VsSaros Bots (`MAX_HOPS`). */
export const SUPERAGENT_HOPS_MAX = 6

export const SuperagentConfigSchema = z.object({
  desk: z.boolean().default(true),
  bots: z.boolean().default(true),
  /** 普通会话里 @SuperAgent 的消息是否交给主管。 */
  sessions: z.boolean().default(true),
  /** ★ 2026-11-11：普通会话 @SuperAgent 任务的默认工作目录（空 = 用执行设置的全局根）。 */
  workspace: z.string().trim().max(500).refine(path => path === '' || isAbsolute(path) || win32.isAbsolute(path),
    'An absolute execution root, or empty to use the global Execution directory').default(''),
}).strict()
export type SuperagentConfig = z.infer<typeof SuperagentConfigSchema>

/** Where a reply goes: `desk` is injected into the desk without waking it; `bot` steers the asking Bot's Session. */
export type SuperagentAddress = { kind: 'desk' | 'bot' | 'session'; session: string }
/** Delivers a reply into a DSH Session once per message ID; `'gone'` when the Session no longer exists. */
export type SuperagentDeliver = (address: SuperagentAddress, message: OutboundMessage) => Promise<'sent' | 'gone'>

const Sender = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()

/** Builds the kind; `deliver` writes a reply into the Session the conversation lives in. */
export function makeSuperagentKind(deliver: SuperagentDeliver): SourceKind<SuperagentConfig> {
  return {
    kind: SUPERAGENT_SOURCE,
    title: { zh: 'SuperAgent 主管', en: 'SuperAgent supervisor' },
    description: { zh: '在 DSH 里直接对主管说的话（主管对话），以及其它 VsSaros bot 用 agent_message 向主管求助。回复写回原来的会话。', en: 'What a person says to the supervisor in DSH (the supervisor desk), and other VsSaros Bots asking the supervisor for help with agent_message. Replies go back into the Session they came from.' },
    schema: SuperagentConfigSchema,
    fields: [
      { key: 'desk', type: 'switch', label: { zh: '接收主管对话', en: 'Receive the supervisor desk' },
        hint: { zh: '在主管对话里发的每条消息交给主管评估；名单里的人发的是明确的请求。', en: 'Each message sent in the supervisor desk goes to the supervisor; a listed person\'s is an explicit request.' } },
      { key: 'workspace', type: 'text', label: { zh: '普通会话任务的执行根', en: 'Execution root for normal-session tasks' },
        hint: { zh: '填绝对路径；每个工单在此创建自己的子目录，并非直接使用现有工程。留空则继承「执行」设置的全局根；源码需由准备命令提供。', en: 'Absolute root for per-ticket subdirectories, not an existing project checkout. Empty inherits the global Execution root; the prepare command must provide source code.' } },
      { key: 'sessions', type: 'switch', label: { zh: '接收普通会话的 @SuperAgent', en: 'Receive @SuperAgent in normal sessions' },
        hint: { zh: '在普通会话里 @SuperAgent 发的消息交给主管评估；回复回到原会话。', en: 'Messages mentioning @SuperAgent in a normal session go to the supervisor; replies return to that session.' } },
      { key: 'bots', type: 'switch', label: { zh: '接收 bot 求助', en: 'Receive Bots asking for help' },
        hint: { zh: '名单里的 bot 用 agent_message 发给 SuperAgent 的消息成为推断的候选；其它 bot 的不接收。', en: 'What a listed Bot sends SuperAgent with agent_message becomes an inferred candidate; other Bots\' messages are not admitted.' } },
    ],
    health: [SUPERAGENT_SOURCE],
    scope: ({ meta }, config) => {
      if (meta.from === 'desk') return config.desk ? { listened: true, observed: false, row: 'desk' } : { listened: false, reason: 'superagent_desk_off' }
      if (meta.from === 'bot') return config.bots ? { listened: true, observed: false, row: 'bots' } : { listened: false, reason: 'superagent_bots_off' }
      if (meta.from === 'session') return config.sessions ? { listened: true, observed: false, row: 'session' } : { listened: false, reason: 'superagent_sessions_off' }
      return { listened: false, reason: 'superagent_unknown' }
    },
    channel: {
      send: async (_host, message) => {
        const address = addressOf(message.channel.address)
        return address ? deliver(address, message) : 'gone'
      },
      link: address => ({ url: '', label: address.kind === 'session'
        ? { zh: `普通会话 ${address.session ?? ''}`.trim(), en: `Session ${address.session ?? ''}`.trim() }
        : address.kind === 'bot'
        ? { zh: `bot 会话 ${address.session ?? ''}`.trim(), en: `Bot Session ${address.session ?? ''}`.trim() }
        : { zh: '主管对话', en: 'Supervisor desk' } }),
    },
    // `desk` or `bot <session>` names those Threads.
    find: query => {
      const text = query.trim()
      if (/^(desk|主管对话)$/i.test(text)) return { threads: [], terms: ['desk:'] }
      const session = /^bot\s+(\S+)$/i.exec(text)?.[1]
      return { threads: session ? [`${SUPERAGENT_SOURCE}:bot:${session}`] : [], terms: [] }
    },
    policy: {
      schema: z.object({
        allowed: z.array(Sender).default([{ ...DESK_PERSON }]),
        bots: z.array(Sender).optional(),
      }).strict(),
      fields: [
        { key: 'allowed', type: 'rows', label: { zh: '能在主管对话里发起工作的人', en: 'People who may originate work in the supervisor desk' },
          hint: { zh: 'local 是这台机器上的用户，默认在名单里；移除后主管对话的消息不再是明确的请求。', en: 'local is the person at this machine, listed by default; without it, desk messages are no longer explicit requests.' },
          columns: [{ key: 'id', type: 'text', label: { zh: '标识', en: 'ID' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
        { key: 'bots', type: 'rows', label: { zh: '求助可以成为候选的 bot', en: 'Bots whose requests may become candidates' },
          hint: { zh: '填 VsSaros bot 的 id。名单里的 bot 的求助只是推断的候选，不能发起明确的请求，也不能同意组队方案。', en: 'VsSaros Bot IDs. A listed Bot\'s request is only an inferred candidate: it never makes an explicit request or agrees to a team proposal.' },
          columns: [{ key: 'id', type: 'text', label: { zh: 'bot id', en: 'Bot ID' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      ],
      explicit: { zh: '名单里的人在主管对话里发的消息。', en: 'A listed person\'s message in the supervisor desk.' },
      unnamed: { person: { zh: '主管对话里的人', en: 'A person in the desk' }, bot: { zh: '求助的 bot', en: 'A Bot asking for help' } },
      rows: stored => {
        const config = SuperagentConfigSchema.partial().parse(stored)
        return [
          { id: 'desk', label: { zh: '主管对话', en: 'Supervisor desk' }, note: config.desk === false ? { zh: '不接收', en: 'Not received' } : { zh: '接收', en: 'Received' },
            cells: { listedUnaddressed: false, unlistedAddressed: config.desk !== false, unlistedUnaddressed: false } },
          // A Bot's request is decided by the `bots` list; the table only shows it is received.
          { id: 'bots', label: { zh: 'bot 求助', en: 'Bots asking for help' }, note: config.bots === false ? { zh: '不接收', en: 'Not received' } : { zh: '仅名单', en: 'Listed only' },
            cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } },
        ]
      },
    },
  }
}

function addressOf(address: Record<string, string>): SuperagentAddress | undefined {
  const session = address.session?.trim()
  return session && (address.kind === 'desk' || address.kind === 'bot' || address.kind === 'session') ? { kind: address.kind, session } : undefined
}
const thread = (kind: 'desk' | 'bot' | 'session', session: string) => ({ source: SUPERAGENT_SOURCE, id: `${kind}:${session}` })
const clip = (text: string) => text.trim().slice(0, 20_000)

/** A person's message in the desk; `messageId` is the DSH message ID, so handing the same message over twice is one Trigger. */
export function deskTrigger(input: { session: string; messageId: string; text: string; at: string }): Trigger {
  const ref = thread('desk', input.session)
  return { id: `${SUPERAGENT_SOURCE}:desk:${input.messageId}`, source: SUPERAGENT_SOURCE, threads: [ref],
    actor: { source: SUPERAGENT_SOURCE, id: DESK_PERSON.id }, human: true, addressed: 'direct', at: input.at, text: clip(input.text),
    channel: { source: SUPERAGENT_SOURCE, thread: threadKey(ref), address: { kind: 'desk', session: input.session } },
    meta: { from: 'desk', session: input.session } }
}

/**
 * ★ 2026-11-11：普通会话里 @SuperAgent 点名主管。与 deskTrigger 的区别只在
 *   channel.address.kind='session' ⇒ 回复经 deliverReply 回到原会话而不是 desk outbox。
 *   actor 仍是本机用户（在 superagent 来源的 allowed 名单里）⇒ gate 判 explicit。
 */
export function sessionTrigger(input: { session: string; messageId: string; text: string; at: string; workspace?: string }): Trigger {
  const ref = thread('session', input.session)
  return { id: `${SUPERAGENT_SOURCE}:session:${input.messageId}`, source: SUPERAGENT_SOURCE, threads: [ref],
    actor: { source: SUPERAGENT_SOURCE, id: DESK_PERSON.id }, human: true, addressed: 'mention', at: input.at, text: clip(input.text),
    channel: { source: SUPERAGENT_SOURCE, thread: threadKey(ref), address: { kind: 'session', session: input.session } },
    meta: { from: 'session', session: input.session, ...input.workspace ? { workspace: input.workspace } : {} } }
}

/**
 * A Bot's request for help; the actor is the Bot's ID (its Session's when the Bots could not tell), which the gate admits
 * only from the Source's `bots` list.
 */
export function botTrigger(input: { id: string; session: string; bot?: string | null; name?: string | null; text: string; hop: number; at: string; blocker?: boolean }): Trigger {
  const ref = thread('bot', input.session)
  return { id: `${SUPERAGENT_SOURCE}:bot:${input.id}`, source: SUPERAGENT_SOURCE, threads: [ref],
    actor: { source: SUPERAGENT_SOURCE, id: input.bot?.trim() || `session:${input.session}` }, human: false, addressed: 'direct',
    at: input.at, text: clip(input.text),
    channel: { source: SUPERAGENT_SOURCE, thread: threadKey(ref), address: { kind: 'bot', session: input.session } },
    meta: { from: 'bot', session: input.session, hop: input.hop, ...input.blocker ? { blocker: true } : {},
      ...input.bot ? { bot: input.bot } : {}, ...input.name ? { name: input.name } : {} } }
}
