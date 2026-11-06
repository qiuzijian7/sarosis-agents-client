/**
 * VsSaros addition (2026-11-06, P3 · co-install): what other Bot plugins share this Host, and what they do to every Session.
 *
 * DS Bot (`ds-bot`, the plugin VsSaros' Bots and SuperAgent's team steps adapt) may be installed in the same Host. Its tools,
 * prompt section, approval answerer, compaction take-over and group relay act only on its own Sessions, so they do not meet
 * SuperAgent's (checked against ds-bot 0.2.7). Three of its hooks act on every Session, SuperAgent's too:
 *
 * - `secrets`: a value the person saved in DS Bot is replaced in every tool result and every model request; a request it
 *   rewrote is sent again as a new model call (SuperAgent's token meter counts that call once: `stepUsageStream`).
 * - `images`: when a Session's model cannot read images, DS Bot reads them with its OCR model and sends the request again
 *   with the text, so a step's images then go to that model.
 * - `skills`: its skills `goal-grill`, `office` and `office-tools` are offered to every Session.
 *
 * Found through the cordis loader's entries (an entry named `ds-bot` that is not disabled). Nothing is changed: the panel
 * says so, and the log says so once.
 */
export const DS_BOT_ENTRY = 'ds-bot'
export type CoexistEffect = 'secrets' | 'images' | 'skills'
export interface Coexistence {
  /** DS Bot runs in this Host, and what it does to SuperAgent's Sessions. */
  dsBot?: { effects: CoexistEffect[] }
}
export const DS_BOT_EFFECTS: readonly CoexistEffect[] = ['secrets', 'images', 'skills']

interface LoaderLike { entries?(): Iterable<{ options?: { name?: unknown; disabled?: unknown }; disabled?: unknown }> }

/**
 * Reads the Host's loader for other Bot plugins. A Host without a loader (tests, an embedded runtime) has none.
 * @param loader - the cordis `loader` service, or what `ctx.get('loader')` gave.
 */
export function coexistenceOf(loader: unknown): Coexistence {
  const entries = (loader as LoaderLike | undefined)?.entries
  if (typeof entries !== 'function') return {}
  try {
    for (const entry of entries.call(loader)) {
      const disabled = entry.disabled === true || entry.options?.disabled === true
      if (entry.options?.name === DS_BOT_ENTRY && !disabled) return { dsBot: { effects: [...DS_BOT_EFFECTS] } }
    }
  } catch { /* a loader that cannot be read says nothing */ }
  return {}
}
