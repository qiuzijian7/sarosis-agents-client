// Project cards: the project's standing rules and records, kept in the workspace like AGENTS.md.
//
// One Markdown file (PROJECT-CARDS.md) holds every card. It is readable as plain documentation by
// any tool, and Deep PTC parses it back. Three kinds of card:
//   setting       written by the user (the model may only propose changes, which the user approves)
//   features      what has been implemented, written by the model; the user can question entries
//   requirements  what the user has asked for, written by the model so it can check new requests
// Every item has a stable id (R…, F…, Q…) so rules can be cited and conflicts named.
//
// This module is pure: parsing, serialising, edits and the prompt text. lib/project-store.mjs does
// the file I/O and lib/project-context.mjs wires it to the host.

export const PROJECT_FILE = 'PROJECT-CARDS.md';
export const KINDS = ['setting', 'features', 'requirements'];
export const MODEL_KINDS = ['features', 'requirements'];
export const PREFIX = { setting: 'R', features: 'F', requirements: 'Q' };
// Setting cards are grouped by topic in the view and in the prompt.
export const CATEGORIES = ['stack', 'conventions', 'constraints', 'workflow', 'product', 'other'];
export const CATEGORY_TITLES = { stack: 'Stack and environment', conventions: 'Code conventions', constraints: 'Constraints', workflow: 'Workflow', product: 'Product', other: 'Other' };
export const REQUIREMENT_STATES = ['active', 'done', 'superseded'];
export const DEFAULT_TITLES = { features: 'Implemented features / 已实现功能', requirements: 'User requirements / 用户要求' };

export const MAX_CARDS = 1000;
export const MAX_ITEMS = 60;
export const MAX_ITEM = 500;
export const MAX_TITLE = 60;
export const MAX_PROMPT = 16_000;
const CARD_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const ITEM_ID = /^[RFQ][1-9]\d{0,3}$/u;

const HEADER = /^<!-- deep-ptc:project-cards v1(?: next=([^ ]*))? -->$/u;
const CARD_HEAD = /^## (.+)$/u;
const CARD_META = /^<!-- card ((?:[a-z]+=\S+ ?)+)-->$/u;
const ITEM = /^- \*\*([RFQ]\d+)\*\* (?:\[(active|done|superseded(?: by [RFQ]\d+)?)\] )?(.*)$/u;

const line = (value, max) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '';

export function blankDoc() {
  return { next: { R: 1, F: 1, Q: 1 }, cards: [] };
}

/**
 * Parse the project file. Unknown lines are ignored and reported, so a hand edit never loses the
 * rest of the file.
 * @returns `{ doc, warnings }`.
 */
export function parseDoc(source, { trackLayout = false } = {}) {
  const doc = blankDoc();
  const warnings = [];
  let card;
  const layout = { header: undefined, cards: new Map() };
  const lines = String(source ?? '').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index].trim().replace(/^\uFEFF/u, '');
    if (text === '') continue;
    const header = HEADER.exec(text);
    if (header) {
      layout.header ??= index;
      for (const part of (header[1] ?? '').split(',')) {
        const match = /^([RFQ])(\d+)$/u.exec(part);
        if (match) doc.next[match[1]] = Math.max(doc.next[match[1]], Number(match[2]));
      }
      continue;
    }
    const head = CARD_HEAD.exec(text);
    if (head) {
      const meta = CARD_META.exec((lines[index + 1] ?? '').trim());
      if (!meta) { card = undefined; warnings.push(`line ${index + 1}: heading without card metadata`); continue; }
      index++;
      const attrs = Object.fromEntries(meta[1].trim().split(' ').map(pair => pair.split('=')));
      const kind = KINDS.includes(attrs.kind) ? attrs.kind : 'setting';
      if (!CARD_ID.test(attrs.id ?? '') || doc.cards.some(row => row.id === attrs.id)) {
        card = undefined; warnings.push(`line ${index}: card id missing or repeated`); continue;
      }
      card = { id: attrs.id, kind, title: line(head[1], MAX_TITLE), rev: Math.max(1, Number.parseInt(attrs.rev, 10) || 1),
        updated: attrs.updated ?? '', items: [] };
      if (kind === 'setting') card.category = CATEGORIES.includes(attrs.category) ? attrs.category : 'other';
      doc.cards.push(card);
      layout.cards.set(card.id, { heading: index - 1, meta: index, items: [] });
      continue;
    }
    const item = ITEM.exec(text);
    if (item && card) {
      if (card.items.some(row => row.id === item[1]) || item[1][0] !== PREFIX[card.kind]) {
        warnings.push(`line ${index + 1}: item ${item[1]} does not belong here`); continue;
      }
      const entry = { id: item[1], text: line(card.kind === 'requirements' ? item[3] : text.slice(item[1].length + 7), MAX_ITEM) };
      if (card.kind === 'requirements') {
        const [state, , by] = (item[2] ?? 'active').split(' ');
        entry.status = state;
        if (by) entry.by = by;
      }
      card.items.push(entry);
      layout.cards.get(card.id).items.push(index);
      continue;
    }
    if (text.startsWith('#') || text.startsWith('>') || text.startsWith('<!--')) continue;
    warnings.push(`line ${index + 1}: not a card item`);
  }
  // `next` never goes below an id in use, so a deleted id is never reused.
  for (const card of doc.cards) for (const item of card.items) {
    const number = Number(item.id.slice(1)) + 1;
    if (number > doc.next[item.id[0]]) doc.next[item.id[0]] = number;
  }
  return { doc, warnings, ...trackLayout ? { layout } : {} };
}

function itemLine(card, item) {
  const status = card.kind !== 'requirements' || item.status === 'active' || item.status === undefined ? ''
    : `[${item.status}${item.status === 'superseded' && item.by ? ` by ${item.by}` : ''}] `;
  return `- **${item.id}** ${status}${item.text}`;
}

/** Setting cards by category order, then the model's records; stable within a group. */
export function ordered(cards) {
  const rank = card => card.kind === 'setting' ? CATEGORIES.indexOf(card.category ?? 'other') : CATEGORIES.length + MODEL_KINDS.indexOf(card.kind);
  return cards.map((card, index) => ({ card, index })).sort((a, b) => rank(a.card) - rank(b.card) || a.index - b.index).map(row => row.card);
}

const headerLine = doc => `<!-- deep-ptc:project-cards v1 next=R${doc.next.R},F${doc.next.F},Q${doc.next.Q} -->`;

function cardMeta(card) {
  const category = card.kind === 'setting' ? ` category=${card.category ?? 'other'}` : '';
  return `<!-- card id=${card.id} kind=${card.kind}${category} rev=${card.rev} updated=${card.updated || '-'} -->`;
}

const cardLines = card => [`## ${card.title}`, cardMeta(card), '', ...card.items.map(item => itemLine(card, item)), ''];

/** Serialize a fresh document, or edit the managed lines of an existing Markdown file. */
export function serializeDoc(doc, previous) {
  if (previous !== undefined) return updateSource(doc, previous);
  const out = [headerLine(doc), '# Project cards', '',
    '> Maintained by Deep PTC in DeepSeek Harness: edit in a Deep PTC conversation, view 特点卡片 / Project cards.',
    '> User-approved settings guide this project. Features and requirements are records that can be checked and corrected.', ''];
  for (const card of ordered(doc.cards)) out.push(...cardLines(card));
  return out.join('\n');
}

function updateSource(doc, { source, doc: old, layout }) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/u);
  const edits = new Map();
  for (const card of old.cards) {
    const replacement = doc.cards.find(row => row.id === card.id);
    if (replacement === card) continue;
    const { heading, meta, items } = layout.cards.get(card.id);
    if (replacement === undefined) {
      for (const index of [heading, meta, ...items]) edits.set(index, []);
      continue;
    }
    edits.set(heading, [`## ${replacement.title}`]);
    edits.set(meta, [cardMeta(replacement)]);
    const nextItems = replacement.items.map(item => itemLine(replacement, item));
    items.forEach((index, at) => edits.set(index, nextItems.slice(at, at + 1)));
    const anchor = items.at(-1) ?? meta;
    if (nextItems.length > items.length) edits.get(anchor).push(...nextItems.slice(items.length));
  }
  const newCards = ordered(doc.cards.filter(card => !layout.cards.has(card.id)));
  const hasBom = source.startsWith('\uFEFF');
  if (layout.header !== undefined) edits.set(layout.header, [headerLine(doc)]);
  const output = lines.flatMap((text, index) => edits.get(index) ?? [text]);
  if (hasBom && output[0]?.startsWith('\uFEFF')) output[0] = output[0].slice(1);
  if (layout.header === undefined) output.unshift(headerLine(doc));
  if (newCards.length > 0) {
    if (output.at(-1) !== '') output.push('');
    for (const card of newCards) output.push('', ...cardLines(card));
  }
  return (hasBom ? '\uFEFF' : '') + output.join(eol);
}

function slug(title, doc) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 24);
  if (CARD_ID.test(base)) {
    let id = base;
    for (let n = 2; doc.cards.some(row => row.id === id); n++) id = `${base}-${n}`;
    return id;
  }
  for (let n = 1; ; n++) if (!doc.cards.some(row => row.id === `c${n}`)) return `c${n}`;
}

/**
 * Normalise submitted items for one card, keeping known ids and numbering new ones.
 * @returns `{ items, next }` or `{ error }`.
 */
function readItems(kind, raw, existing, next) {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) return { error: `items: use at most ${MAX_ITEMS}` };
  const prefix = PREFIX[kind];
  const counter = { ...next };
  const items = [];
  const seen = new Set();
  for (const [index, entry] of raw.entries()) {
    const text = line(typeof entry === 'string' ? entry : entry?.text, MAX_ITEM);
    if (text === '') continue;
    let id = typeof entry?.id === 'string' && ITEM_ID.test(entry.id) && entry.id[0] === prefix ? entry.id : undefined;
    // An id the card never had is numbered fresh, so the model cannot claim or reuse another id.
    if (id !== undefined && !existing.has(id)) id = undefined;
    if (id === undefined || seen.has(id)) { id = `${prefix}${counter[prefix]}`; counter[prefix] += 1; }
    seen.add(id);
    const item = { id, text };
    if (kind === 'requirements') {
      item.status = REQUIREMENT_STATES.includes(entry?.status) ? entry.status : 'active';
      if (item.status === 'superseded' && typeof entry?.by === 'string' && /^Q\d+$/u.test(entry.by)) item.by = entry.by;
    }
    items.push(item);
    if (index >= MAX_ITEMS) break;
  }
  return { items, next: counter };
}

/** Added, removed and changed item ids between two versions of a card. */
export function diffItems(before = [], after = []) {
  const old = new Map(before.map(item => [item.id, item]));
  const now = new Map(after.map(item => [item.id, item]));
  return {
    added: after.filter(item => !old.has(item.id)).map(item => item.id),
    removed: before.filter(item => !now.has(item.id)).map(item => item.id),
    changed: after.filter(item => old.has(item.id) && JSON.stringify(old.get(item.id)) !== JSON.stringify(item)).map(item => item.id),
  };
}

/**
 * Write one card: create it (no id) or replace its title and items. `baseRev` must match the
 * card's revision, so two editors never overwrite each other silently.
 * @param change - `{ id?, kind?, title?, items, baseRev? }`.
 * @returns `{ doc, card, previous, diff }` or `{ error, conflict? }`.
 */
export function writeCard(doc, change, now = new Date().toISOString()) {
  const current = change.id === undefined ? undefined : doc.cards.find(row => row.id === change.id);
  if (change.id !== undefined && current === undefined) return { error: `unknown card ${change.id}` };
  const kind = current?.kind ?? (KINDS.includes(change.kind) ? change.kind : 'setting');
  if (current === undefined && doc.cards.length >= MAX_CARDS) return { error: `use at most ${MAX_CARDS} cards` };
  if (current !== undefined && change.baseRev !== undefined && change.baseRev !== current.rev) {
    return { error: `card ${current.id} changed to revision ${current.rev}`, conflict: true };
  }
  const title = line(change.title, MAX_TITLE) || current?.title || DEFAULT_TITLES[kind] || '';
  if (title === '') return { error: 'title: required' };
  const read = readItems(kind, change.items, new Set((current?.items ?? []).map(item => item.id)), doc.next);
  if (read.error) return { error: read.error };
  const card = { id: current?.id ?? (MODEL_KINDS.includes(kind) && !doc.cards.some(row => row.id === kind) ? kind : slug(title, doc)),
    kind, title, rev: (current?.rev ?? 0) + 1, updated: now, items: read.items };
  if (kind === 'setting') card.category = CATEGORIES.includes(change.category) ? change.category : current?.category ?? 'other';
  const cards = current === undefined ? [...doc.cards, card] : doc.cards.map(row => row === current ? card : row);
  return { doc: { next: read.next, cards }, card, previous: current, diff: diffItems(current?.items, card.items) };
}

/** Remove a card. Model-owned cards are part of the record and are not removed this way. */
export function removeCard(doc, id, baseRev) {
  const card = doc.cards.find(row => row.id === id);
  if (card === undefined) return { error: `unknown card ${id}` };
  if (MODEL_KINDS.includes(card.kind)) return { error: 'the model maintains this card' };
  if (baseRev !== undefined && baseRev !== card.rev) return { error: `card ${id} changed to revision ${card.rev}`, conflict: true };
  return { doc: { ...doc, cards: doc.cards.filter(row => row !== card) }, card };
}

/** A short, human-readable change line: "+R7 ~R2 −R5". */
export function diffText(diff) {
  return [...diff.added.map(id => `+${id}`), ...diff.changed.map(id => `~${id}`), ...diff.removed.map(id => `−${id}`)].join(' ');
}

/**
 * The project cards as the model reads them: the rules (a system prompt section) and the cards (a
 * runtime-context snapshot). The rules change only with the setup state, so the system prompt stays
 * cached; the cards change whenever a card is written, and a changed snapshot appends only itself
 * instead of re-sending the whole system prompt.
 * @param doc - the parsed document, or undefined when the workspace has none.
 * @param options - `{ deep, path, setupStatus }`: Deep PTC or not, the file path, the setup state.
 */
export function promptText(doc, options = {}) {
  return [promptRules(doc, options), promptCards(doc, options)].filter(Boolean).join('\n');
}

/** The cards themselves, for the runtime-context snapshot. Empty when the workspace has none. */
export function promptCards(doc, { deep = false, path = PROJECT_FILE, setupStatus } = {}) {
  // The snapshot can identify the file by name even for unusually long absolute paths.
  if (path.length > 1000) path = PROJECT_FILE;
  const setup = setupNote(doc, { deep, setupStatus });
  if (doc === undefined || doc.cards.length === 0) return setup ? `# Project cards (${path}) — setup state\n${setup}` : '';
  // Each card is one self-contained module. Over the size limit whole cards are left out (settings
  // come first, so the user's rules outlast the records), never half a card.
  let text = `# Project cards (${path}) — current version; it replaces earlier project card snapshots${setup ? `\n${setup}` : ''}`;
  const omitted = [];
  let group;
  for (const card of ordered(doc.cards)) {
    const heading = card.kind === 'setting' ? `Settings: ${CATEGORY_TITLES[card.category ?? 'other']}` : 'Records kept by Deep PTC';
    const module = [...heading !== group ? [`## ${heading}`] : [], `### ${card.title} (${card.id}, ${card.kind}, rev ${card.rev})`,
      ...card.items.map(item => itemLine(card, item))].join('\n');
    if (omitted.length > 0 || text.length + module.length + 1 > MAX_PROMPT - 600) { omitted.push(card); continue; }
    text += `\n${module}`;
    group = heading;
  }
  if (omitted.length > 0) {
    const rest = deep ? 'project_cards read' : PROJECT_FILE;
    const names = omitted.slice(0, 30).map(card => `${card.title} (${card.id})`);
    const footer = () => {
      const more = omitted.length - names.length;
      return `\n… ${omitted.length} more card(s) not shown here: ${names.join(', ')}${more ? ` and ${more} more` : ''}. Read them with ${rest} before working in their area.`;
    };
    while (names.length && text.length + footer().length > MAX_PROMPT) names.pop();
    text += footer();
  }
  return text;
}

/** Where project setup stands, as a line for the snapshot; empty once setting cards exist. */
export function setupNote(doc, { deep = false, setupStatus } = {}) {
  if (!deep || doc?.cards.some(card => card.kind === 'setting')) return '';
  const statusNotes = {
    deferred: 'The user deferred setup for this project. Resume only when the user asks.',
    pending: 'This project already has pending setting proposals. Refer to the existing drafts via project_cards read; avoid duplicate setup questions.',
    guiding: 'Setup is already underway in this project. Continue the existing discussion when relevant; read pending proposals before drafting.',
  };
  return statusNotes[setupStatus] ?? 'This project has no setting cards. Start setup yourself in your first visible reply, even on a small task. Before inspecting files, ask one concrete project question alongside your first progress sentence, or offer a grounded setting for confirmation. In chat use a nonblocking ui_card reply when available. In the setup panel ask in panel text. Save the open question with project_cards setup (status guiding, summary containing the question) or propose a grounded draft. If the user explicitly defers, record status deferred. Continue independent work while awaiting their answer.';
}

/**
 * The rules for using the cards, for the system prompt section. In Deep PTC they are the same text
 * whatever the cards hold or the setup state is, so no card write ever changes the system prompt.
 * Other modes get the read-only note only where a project file has cards.
 */
export function promptRules(doc, { deep = false } = {}) {
  if (!deep && !(doc?.cards.length > 0)) return '';
  const head = ['# Project cards',
    'The workspace’s project cards (PROJECT-CARDS.md) arrive as a Project cards snapshot in this conversation, with the current setup state. Only the newest snapshot applies; earlier snapshots and quoted versions are historical. User-approved settings take precedence among project documents. Follow the current user request and applicable host rules.',
    'Setting cards (R…) hold the user’s rules. F and Q are feature and requirement records to verify and correct. Before changing an area, check the nearby implemented features (F), identify behavior the change must preserve, and retest affected behavior. Change existing behavior only as the user’s task requires. Ask before acting when a meaningful conflict remains, citing the relevant ID.',
    deep ? 'Change setting cards only with project_cards propose. Users can approve proposals where setup started: directly in chat for this conversation or in the Project cards panel for its dedicated assistant. After you implement something or the user states a lasting requirement, update the features and requirements cards with project_cards write.'
      : 'These cards are edited in a Deep PTC conversation; here they are read-only.'];
  if (deep) head.push('When implemented features (F) exist: before changing a feature, cite the relevant F IDs and identify the existing behavior and check to preserve. After verification, use one results card when ui_card is available: show the new feature result, the affected F checks with observed outcomes, and any untested behavior with its reason. Use plain text if cards are off. Never label an unrun check as passed.');
  return head.join('\n');
}

/**
 * Turn a proposal into the card's complete item list. The model sends only what changes: reworded
 * items carry their id, new items carry none, and deletions are named in `remove`. Items it does not
 * mention stay as they are, so leaving something out never deletes it.
 * @param current - the card being changed, or undefined for a new card.
 * @returns `{ items }` or `{ error }`.
 */
export function mergeProposal(current, items = [], remove = []) {
  if (!Array.isArray(items) || !Array.isArray(remove)) return { error: 'items and remove must be lists' };
  if (current === undefined) {
    return remove.length > 0 ? { error: 'remove applies to an existing card only' } : { items };
  }
  const known = new Set(current.items.map(item => item.id));
  const unknown = remove.filter(id => !known.has(id));
  if (unknown.length > 0) return { error: `remove: ${unknown.join(', ')} not in card ${current.id}` };
  const given = new Map(items.filter(item => typeof item?.id === 'string' && known.has(item.id)).map(item => [item.id, item]));
  const clash = [...given.keys()].filter(id => remove.includes(id));
  if (clash.length > 0) return { error: `${clash.join(', ')} both changed and removed` };
  const kept = current.items.filter(item => !remove.includes(item.id))
    .map(item => given.has(item.id) ? { ...given.get(item.id), id: item.id } : { id: item.id, text: item.text });
  const fresh = items.filter(item => !(typeof item?.id === 'string' && known.has(item.id)));
  return { items: [...kept, ...fresh] };
}
