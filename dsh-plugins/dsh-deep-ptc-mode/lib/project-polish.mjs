// Polishing a project card draft: a suggestion the user reviews, never a change the model makes.
//
// The editor asks for a polish and returns at once. A short-lived subagent (default) or the current
// conversation rewrites the draft and hands it back with project_cards suggest; the editor then shows
// each entry side by side and the user takes or keeps it. Nothing reaches PROJECT-CARDS.md until the
// user submits the draft themselves, and nothing here waits on the model.

import { randomUUID } from 'node:crypto';
import { MAX_ITEM, MAX_ITEMS } from './project-cards.mjs';

export const POLISH_BY = ['subagent', 'chat'];
const DRAFT_ID = /^d-[a-z0-9]{6,24}$/u;
const MAX_NOTE = 160;

export const validDraftId = id => typeof id === 'string' && DRAFT_ID.test(id);

/** The instruction a polisher works from; the same text for a subagent and for the conversation. */
export function polishInstruction({ draftId, title, category, items, removed = [] }) {
  const lines = items.map(item => `- ${item.id ?? 'new'}: ${item.text}`).join('\n');
  return [
    `Polish this project card draft for the user. Draft id: ${draftId}. Card title: ${title}. Category: ${category ?? 'other'}.`,
    'Keep each entry\'s meaning. Make each one precise, actionable and self-contained, in the user\'s language. Do not add requirements the user did not write, and do not merge or split entries unless two say the same thing.',
    `When done, call project_cards once with action "suggest", draft "${draftId}" and items: every entry in order, keeping each existing id (R…) and leaving new entries without an id. Add a short note to an entry only when you changed its meaning or merged it. Then stop: do not propose, write or edit the card yourself.`,
    'Draft:', lines, removed.length > 0 ? `The user deleted: ${removed.join(', ')} (leave them out).` : '',
  ].filter(Boolean).join('\n');
}

/** Read a suggestion's entries: ids must come from the draft, text bounded, notes short. */
export function readSuggestion(base, items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) return { error: `items: send 1-${MAX_ITEMS} entries` };
  const known = new Set(base.map(item => item.id).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const entry of items) {
    const text = typeof entry?.text === 'string' ? entry.text.replace(/\s+/gu, ' ').trim().slice(0, MAX_ITEM) : '';
    if (text === '') return { error: 'items: every entry needs text' };
    const id = typeof entry?.id === 'string' && known.has(entry.id) && !seen.has(entry.id) ? entry.id : undefined;
    if (id) seen.add(id);
    const note = typeof entry?.note === 'string' ? entry.note.trim().slice(0, MAX_NOTE) : '';
    out.push({ ...id ? { id } : {}, text, ...note ? { note } : {} });
  }
  return { items: out };
}

/**
 * @param ctx - the plugin context (for the subagent service).
 * @param store - the project store; suggestions live in its sidecar.
 * @param publish - refreshes every open view of the session's project.
 */
export function projectPolisher(ctx, store, publish) {
  return {
    /** Start a polish and return at once; the suggestion arrives later. */
    async start({ session, agent, path, request, signal }) {
      const by = POLISH_BY.includes(request.by) ? request.by : 'subagent';
      const base = (Array.isArray(request.items) ? request.items : []).slice(0, MAX_ITEMS)
        .map(item => ({ ...typeof item?.id === 'string' ? { id: item.id } : {}, text: String(item?.text ?? '').slice(0, MAX_ITEM) }))
        .filter(item => item.text.trim() !== '');
      if (!validDraftId(request.draftId)) throw new Error('Invalid draft. / 无效的草稿。');
      if (base.length === 0) throw new Error('The draft is empty. / 草稿是空的。');
      const draft = { draftId: request.draftId, title: String(request.title ?? '').slice(0, 60), category: request.category,
        items: base, removed: Array.isArray(request.removed) ? request.removed.filter(id => typeof id === 'string').slice(0, MAX_ITEMS) : [] };
      store.setSuggestion(path, { id: draft.draftId, card: typeof request.card === 'string' ? request.card : undefined, by, state: 'working', base, owner: session.id });
      await publish(session);
      if (by === 'chat') return { instruction: polishInstruction(draft) };
      const host = ctx.get('subagents');
      const fail = async message => {
        if (store.suggestions(path).find(row => row.id === draft.draftId)?.state !== 'working') return;
        store.setSuggestion(path, { ...store.suggestions(path).find(row => row.id === draft.draftId), state: 'failed', error: message });
        await publish(session);
      };
      if (!host) { await fail('Subagent service unavailable. / 子代理服务不可用。'); return {}; }
      const childId = randomUUID();
      try {
        const activation = await host.startActivation({ childId, provider: 'spawn', label: 'Polish project card', delivery: 'caller', signal,
          request: { parent: agent, agentPreset: 'deep-ptc', maxDepth: host.resolveMaxDepth(), prompt: [{ type: 'text', text: polishInstruction(draft) }] } });
        // A subagent that ends without a suggestion leaves a clear failure instead of a spinner.
        activation.result.then(() => fail('The polisher finished without a suggestion. / 润色没有给出结果。'),
          error => fail(String(error?.message ?? error).slice(0, 300)));
      } catch (error) {
        await fail(String(error?.message ?? error).slice(0, 300));
      }
      return {};
    },

    /** The polisher's result, from project_cards suggest. */
    async suggest({ session, path, draftId, items }) {
      const row = store.suggestions(path).find(item => item.id === draftId);
      if (!row) throw new Error(`No open polish for draft ${draftId}`);
      const read = readSuggestion(row.base, items);
      if (read.error) throw new Error(read.error);
      store.setSuggestion(path, { ...row, state: 'ready', items: read.items, error: undefined });
      await publish(session);
      return { draft: draftId, status: 'shown to the user for review; stop here, the user decides', entries: read.items.length };
    },

    async dismiss({ session, path, draftId }) {
      store.clearSuggestion(path, draftId);
      await publish(session);
    },
  };
}
