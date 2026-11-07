/**
 * VsSaros addition (2026-11-07, P0 · co-install semantics): a DS Bot made the way ds-bot 0.2.7 acts on every Session, for
 * `tests/dsb-coexist.spec.ts`. Each part follows its source (G:/…/ds-bot/src/host):
 * - `secrets.js:505`: an `llm/stream` listener that, when a request holds a saved value, sends the rewritten request again
 *   through the whole waterfall (`ctx.llm.stream`) at once, instead of calling `next()`;
 * - `images.js:179`: an `llm/stream` listener that, when a request holds images its model cannot read, reads each with its OCR
 *   model on the side (a call of its own, the same `sessionId`) and sends the request again with the text; a read that fails
 *   becomes "it could not be read right now" (`images.js:141`);
 * - its approval answerer acts on its own Bots' Sessions only and hands every other request on;
 * - `office-skills.js:77` / `goal-skills.js:47`: a provider in DSH's global skill registry, so its skills join every Session's
 *   skill catalog (`dsh-tool-skill`), whose descriptions DSH clips at `DSH_CATALOG_DESCRIPTION_MAX`.
 */
export interface FakeMessage { role: string; content: { type: string; text?: string; name?: string }[] }
export interface FakeStreamOptions { sessionId?: string; provider?: string; model?: string; purpose?: string; messages: FakeMessage[] }
type Model = (options: FakeStreamOptions) => AsyncIterable<Record<string, unknown>>
interface WaterfallHost {
  waterfall(name: string, options: unknown, next: () => unknown): unknown
  on(name: string, listener: (...args: never[]) => unknown): () => void
}

/** ds-bot 0.2.7's global skills, as their SKILL.md frontmatter describes them (quoted from DS Bot, Apache-2.0, for this test only). */
export const DS_BOT_SKILLS = [
  { name: 'goal-grill', description: 'Align with the user before writing a group goal — find the facts yourself, ask only the open decisions in one numbered round with a recommended answer each, then write the goal with checks and stages.' },
  { name: 'office', description: 'Create, edit, inspect, or convert Office documents, spreadsheets, presentations, and PDFs. Load to choose the relevant workflow.' },
  { name: 'office-tools', description: 'Inspect, check, and edit .docx/.pptx/.xlsx packages in place — block-level reading, comments, tracked changes, slide inventory and layout checks, slide reorder/duplicate/cleanup, workbook errors, package checks, contact sheets. Works offline; nothing to install.' },
] as const
/** `dsh-tool-skill`'s `DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH`: a catalog line's description is clipped there. */
export const DSH_CATALOG_DESCRIPTION_MAX = 500
/** One skill's line in DSH's skill catalog message, near enough to measure what it adds. */
export const catalogLine = (skill: { name: string; description: string }) => `- ${skill.name}: ${skill.description.slice(0, DSH_CATALOG_DESCRIPTION_MAX)}`

export const user = (text: string): FakeMessage => ({ role: 'user', content: [{ type: 'text', text }] })
export const withImage = (text: string, name = 'shot.png'): FakeMessage => ({ role: 'user', content: [{ type: 'text', text }, { type: 'image', name }] })

/** A model that answers every call with one usage chunk (a new object each call), and remembers the calls it got. */
export function fakeModel(usage: Record<string, number> = { inputTokens: 100, outputTokens: 10 }) {
  const calls: FakeStreamOptions[] = []
  const model: Model = options => (async function* () {
    calls.push(options)
    yield { type: 'text-delta', text: options.model === 'ocr-vl' ? '图里是一个番茄钟' : 'ok' }
    yield { type: 'usage', usage: { ...usage } }
  })()
  return { calls, model }
}

/**
 * Installs the fake DS Bot on a Host's root context, after SuperAgent (as a plugin loaded later is).
 * @param options.secrets - values saved in DS Bot, replaced by `[secret:N]`.
 * @param options.ocr - its OCR route; the Sessions' own models cannot read images.
 * @param options.own - its own Bots' Session ids, whose approvals it answers.
 */
export function installFakeDsBot(ctx: unknown, model: Model, options: { secrets?: string[]; ocr?: { provider: string; model: string }; own?: string[] } = {}) {
  const host = ctx as WaterfallHost
  const secrets = options.secrets ?? []
  const ocr = options.ocr ?? { provider: 'ocr', model: 'ocr-vl' }
  const own = new Set(options.own ?? [])
  /** `ctx.llm.stream`: the whole waterfall, then the model. */
  const stream = (request: FakeStreamOptions) => host.waterfall('llm/stream', request, () => model(request)) as AsyncIterable<Record<string, unknown>>
  const answered: string[] = [], ocrFailures: string[] = []
  const redact = (messages: FakeMessage[]) => {
    let changed = false
    const fresh = messages.map(message => ({ ...message, content: message.content.map(block => {
      if (block.type !== 'text' || !block.text) return block
      const text = secrets.reduce((rest, value, index) => rest.split(value).join(`[secret:${index + 1}]`), block.text)
      if (text !== block.text) changed = true
      return { ...block, text }
    }) }))
    return changed ? fresh : messages
  }
  const hasImages = (messages: FakeMessage[]) => messages.some(message => message.content.some(block => block.type === 'image'))
  const read = async (request: FakeStreamOptions, name: string) => {
    let text = ''
    try {
      for await (const chunk of stream({ sessionId: request.sessionId, provider: ocr.provider, model: ocr.model, messages: [user(`Read the image ${name}.`)] })) {
        if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
      }
      return `[Image "${name}". You cannot see images, so ${ocr.model} read it for you:] ${text} [End of image "${name}"]`
    } catch (error) {
      ocrFailures.push(String((error as Error).message))
      return `[Image "${name}": you cannot see images and it could not be read right now. Ask the user what it shows if it matters.]`
    }
  }
  const disposers = [
    host.on('llm/stream', ((request: FakeStreamOptions, next: () => unknown) => {
      if (!secrets.length) return next()
      const fresh = redact(request.messages)
      if (fresh === request.messages) return next()
      return stream({ ...request, messages: fresh })
    }) as never),
    host.on('llm/stream', ((request: FakeStreamOptions, next: () => AsyncIterable<unknown>) => (async function* () {
      if (!request.sessionId || request.model === ocr.model || !hasImages(request.messages)) { yield* next(); return }
      const messages: FakeMessage[] = []
      for (const message of request.messages) {
        const content: FakeMessage['content'] = []
        for (const block of message.content) content.push(block.type === 'image' ? { type: 'text', text: await read(request, block.name ?? 'image') } : block)
        messages.push({ ...message, content })
      }
      yield* stream({ ...request, messages })
    })()) as never),
    host.on('approval/request', ((request: { agent?: { id?: string } }, next: () => unknown) => {
      if (!own.has(String(request.agent?.id))) return next()
      answered.push(String(request.agent?.id))
      return 'approved'
    }) as never),
  ]
  return { stream, answered, ocrFailures, dispose: () => { for (const dispose of disposers) dispose() } }
}

/** Reads a stream to its end. */
export async function drain(value: unknown): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for await (const chunk of value as AsyncIterable<Record<string, unknown>>) out.push(chunk)
  return out
}
