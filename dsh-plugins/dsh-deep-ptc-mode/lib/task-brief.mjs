// Task brief: the conversation's goals, constraints and acceptance criteria, filed by the model
// from the user's messages and checked by the user.
//
// Users write the way people talk: requests, limits and background mixed in one message and spread
// over several. The model files them into one brief with stable ids. Each item that restates the
// user carries a verbatim quote, checked against the message, so a misreading shows next to the
// words it came from. Implicit needs the model infers are marked as such.
//
// Coverage keeps the brief honest: every clause of a filed message is either quoted by an item or
// marked as carrying no task content, and whatever is left is shown as unfiled text. Once the
// user confirms, a message can be condensed: its node in the model's history is replaced by a stub
// naming the items and repeating the unfiled text verbatim. The original stays in the session log
// and in the chat, and the model can read it back at any time.
//
// This module is pure. lib/brief-context.mjs wires it to the host.

export const SECTIONS = ['goal', 'constraint', 'acceptance', 'context', 'question'];
export const PREFIX = { goal: 'G', constraint: 'C', acceptance: 'A', context: 'K', question: 'O' };
const SECTION_OF = Object.fromEntries(Object.entries(PREFIX).map(([section, prefix]) => [prefix, section]));
export const SECTION_TITLES = {
  goal: 'Goals', constraint: 'Constraints', acceptance: 'Acceptance — check each before your final answer; mark finished ones done',
  context: 'Context', question: 'Open questions — settle with the user (ask_user)',
};
export const STATUSES = ['open', 'done', 'dropped'];
export const MAX_ITEMS = 40;
export const MAX_TEXT = 300;
export const MAX_QUOTE = 240;
export const MAX_MESSAGES = 16;
export const MAX_MESSAGE = 6000;
const MAX_SKIPS = 24;
const MAX_PROMPT = 7000;
const MIN_QUOTE = 2;
const ITEM_ID = /^[GCAKO][1-9]\d{0,2}$/u;
export const REF = /^m\d{1,9}$/u;

const flat = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
const clip = (value, max) => flat(value).slice(0, max);
export const quoted = value => `«${flat(value)}»`;

export function blankBrief() {
  return { v: 1, rev: 0, turn: 0, updatedTurn: -1, next: { G: 1, C: 1, A: 1, K: 1, O: 1 }, items: [], messages: [] };
}

// ---- Messages and coverage --------------------------------------------------------------------

/** The plain text of a user message's content blocks. */
export function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').slice(0, MAX_MESSAGE);
}

/** The message as the brief sees it: whitespace collapsed, so quotes match across line breaks. */
const normal = text => flat(text);

// Clauses: split at sentence ends, line breaks and the commas people chain requests with.
const CLAUSE_END = /[。！？!?；;\n，,、：:]|\.(?=\s|$)/u;
// Characters that carry meaning; punctuation and spaces do not count toward coverage.
const MEANINGFUL = /[\p{L}\p{N}]/u;

/** Clause ranges of a normalized text: `{ start, end, size }`, size counting meaningful characters. */
export function clauses(text) {
  const out = [];
  let start = 0;
  const push = end => {
    const slice = text.slice(start, end);
    const size = [...slice].filter(char => MEANINGFUL.test(char)).length;
    if (size > 0) out.push({ start, end, size });
  };
  for (let index = 0; index < text.length; index++) {
    if (CLAUSE_END.test(text[index])) { push(index + 1); start = index + 1; }
  }
  if (start < text.length) push(text.length);
  return out;
}

/** Where a quote occurs in a normalized message text, or -1. */
export function locate(text, quote) {
  const needle = normal(quote);
  return needle.length < MIN_QUOTE ? -1 : text.indexOf(needle);
}

/**
 * Which clauses of a message the brief accounts for. A clause counts when at least half of its
 * meaningful characters fall inside a quote of an item or a skip, so a quote may trim a clause's
 * edges without leaving it "unfiled".
 * @returns `{ total, covered, unfiled }`: clause counts and the unfiled text, merged and verbatim.
 */
export function coverage(message, items) {
  const text = normal(message.text);
  const marked = new Uint8Array(text.length);
  const spans = [...items.filter(item => item.from === message.ref && item.quote && item.status !== 'dropped').map(item => item.quote), ...message.skipped ?? []];
  for (const span of spans) {
    const needle = normal(span);
    if (needle.length < MIN_QUOTE) continue;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) marked.fill(1, at, at + needle.length);
  }
  const all = clauses(text);
  const open = all.filter(clause => {
    let hit = 0;
    for (let index = clause.start; index < clause.end; index++) if (marked[index] && MEANINGFUL.test(text[index])) hit++;
    return hit * 2 < clause.size;
  });
  // Adjacent unfiled clauses read as one fragment.
  const unfiled = [];
  let last;
  for (const clause of open) {
    if (last !== undefined && last.end === clause.start) last.end = clause.end;
    else { last = { start: clause.start, end: clause.end }; unfiled.push(last); }
  }
  return { total: all.length, covered: all.length - open.length,
    unfiled: unfiled.map(range => text.slice(range.start, range.end).replace(/^[\s，,、：:；;]+|[\s，,、：:；;]+$/gu, '')).filter(Boolean) };
}

// ---- Updates ----------------------------------------------------------------------------------

/** Find the message a quote comes from: the named one, else the newest message containing it. */
function sourceOf(brief, quote, from) {
  const pool = typeof from === 'string' && REF.test(from) ? brief.messages.filter(message => message.ref === from) : [...brief.messages].reverse();
  return pool.find(message => locate(normal(message.text), quote) >= 0);
}

const changeText = changes => [...changes.added.map(id => `+${id}`), ...changes.changed.map(id => `~${id}`), ...changes.done.map(id => `✓${id}`),
  ...changes.removed.map(id => `−${id}`)].join(' ');

/**
 * Apply the model's update. Items it does not mention stay. Invalid entries are reported and left
 * out; the rest applies, so one bad quote does not cost the whole update.
 * @param args - `{ items?, remove?, done?, skip? }` from the task_brief tool.
 * @returns `{ brief, changes, rejected, text }`.
 */
export function applyUpdate(brief, args, turn) {
  const rejected = [];
  const next = { ...brief.next };
  let items = brief.items.map(item => ({ ...item }));
  const changes = { added: [], changed: [], removed: [], done: [] };
  const byId = id => items.find(item => item.id === id);
  for (const [index, raw] of (Array.isArray(args.items) ? args.items : []).entries()) {
    const at = `items.${index}`;
    const text = clip(raw?.text, MAX_TEXT);
    if (text === '') { rejected.push(`${at}: text required`); continue; }
    const current = typeof raw?.id === 'string' ? byId(raw.id) : undefined;
    if (raw?.id !== undefined && current === undefined) { rejected.push(`${at}: unknown id ${raw.id}; omit id for a new item`); continue; }
    if (current?.basis === 'confirmed' && current.text !== text) { rejected.push(`${at}: ${current.id} was confirmed by the user; change it only when the user asks, or add a new item`); continue; }
    const section = current?.section ?? (SECTIONS.includes(raw?.section) ? raw.section : undefined);
    if (section === undefined) { rejected.push(`${at}: section must be one of ${SECTIONS.join(', ')}`); continue; }
    let basis = 'inferred';
    let quote;
    let from;
    if (raw?.inferred !== true) {
      const wanted = clip(raw?.quote, MAX_QUOTE);
      if (wanted.length < MIN_QUOTE) { rejected.push(`${at}: quote the user's words verbatim, or set inferred:true for an implicit need`); continue; }
      const source = sourceOf(brief, wanted, raw?.from);
      if (source === undefined) { rejected.push(`${at}: quote ${quoted(wanted)} is not in ${raw?.from ?? 'the recent user messages'}; copy the words exactly`); continue; }
      basis = current?.basis === 'confirmed' ? 'confirmed' : 'user';
      quote = wanted;
      from = source.ref;
    }
    const item = { id: current?.id, section, text, basis, ...quote ? { quote, from } : {}, status: current?.status ?? 'open', turn };
    if (current === undefined) {
      if (items.length >= MAX_ITEMS) { rejected.push(`${at}: the brief holds at most ${MAX_ITEMS} items; remove or merge some`); continue; }
      const prefix = PREFIX[section];
      item.id = `${prefix}${next[prefix]}`;
      next[prefix] += 1;
      items.push(item);
      changes.added.push(item.id);
    } else if (JSON.stringify({ ...current, turn }) !== JSON.stringify(item)) {
      items = items.map(row => row.id === current.id ? item : row);
      changes.changed.push(item.id);
    }
  }
  for (const id of Array.isArray(args.done) ? args.done : []) {
    const item = byId(id);
    if (item === undefined) { rejected.push(`done: unknown id ${id}`); continue; }
    if (item.status !== 'done') { items = items.map(row => row.id === id ? { ...row, status: 'done', turn } : row); changes.done.push(id); }
  }
  for (const id of Array.isArray(args.remove) ? args.remove : []) {
    const item = byId(id);
    if (item === undefined) { rejected.push(`remove: unknown id ${id}`); continue; }
    if (item.basis === 'confirmed') { rejected.push(`remove: ${id} was confirmed by the user; ask before dropping it`); continue; }
    items = items.filter(row => row.id !== id);
    changes.removed.push(id);
  }
  let messages = brief.messages;
  for (const [index, raw] of (Array.isArray(args.skip) ? args.skip : []).entries()) {
    const wanted = clip(typeof raw === 'string' ? raw : raw?.quote, MAX_QUOTE);
    const source = wanted.length >= MIN_QUOTE ? sourceOf({ messages }, wanted, raw?.from) : undefined;
    if (source === undefined) { rejected.push(`skip.${index}: ${quoted(wanted)} is not in the recent user messages`); continue; }
    messages = messages.map(message => message.ref === source.ref
      ? { ...message, skipped: [...(message.skipped ?? []).filter(span => span !== wanted), wanted].slice(-MAX_SKIPS) } : message);
  }
  const changed = Object.values(changes).some(list => list.length > 0) || messages !== brief.messages;
  const result = changed ? { ...brief, rev: brief.rev + 1, updatedTurn: turn, next, items, messages } : brief;
  return { brief: result, changes, rejected, text: changeText(changes) };
}

/** The coverage report the tool returns: only messages with something left to file. */
export function openCoverage(brief) {
  return brief.messages.filter(message => message.filed || brief.items.some(item => item.from === message.ref) || message.skipped?.length)
    .map(message => ({ ref: message.ref, ...coverage(message, brief.items) }))
    .filter(row => row.unfiled.length > 0)
    .map(row => ({ ref: row.ref, covered: `${row.covered}/${row.total}`, unfiled: row.unfiled }));
}

// ---- The user's edits -------------------------------------------------------------------------

/**
 * Apply one edit from the brief card: confirm, edit, remove, add, reopen. The user's edits are
 * confirmed items; the model may mark them done but not reword or drop them.
 * @returns `{ brief }` or `{ error }`.
 */
export function applyUserEdit(brief, request, turn) {
  const item = typeof request.id === 'string' ? brief.items.find(row => row.id === request.id) : undefined;
  const bump = items => ({ brief: { ...brief, rev: brief.rev + 1, updatedTurn: turn, items } });
  switch (request.op) {
    case 'confirm': {
      const ids = Array.isArray(request.ids) ? new Set(request.ids) : undefined;
      return bump(brief.items.map(row => (ids === undefined || ids.has(row.id)) && row.status !== 'dropped' ? { ...row, basis: 'confirmed' } : row));
    }
    case 'edit': {
      if (item === undefined) return { error: 'Unknown item. / 未知的条目。' };
      const text = clip(request.text, MAX_TEXT);
      if (text === '') return { error: 'Text is empty. / 内容为空。' };
      return bump(brief.items.map(row => row === item ? { ...row, text, basis: 'confirmed', turn } : row));
    }
    case 'remove':
      if (item === undefined) return { error: 'Unknown item. / 未知的条目。' };
      return bump(brief.items.filter(row => row !== item));
    case 'status':
      if (item === undefined || !STATUSES.includes(request.status)) return { error: 'Unknown item. / 未知的条目。' };
      return bump(brief.items.map(row => row === item ? { ...row, status: request.status, turn } : row));
    case 'add': {
      const section = SECTIONS.includes(request.section) ? request.section : undefined;
      const text = clip(request.text, MAX_TEXT);
      if (section === undefined || text === '') return { error: 'Choose a section and write the item. / 请选择分区并填写内容。' };
      if (brief.items.length >= MAX_ITEMS) return { error: `At most ${MAX_ITEMS} items. / 最多 ${MAX_ITEMS} 条。` };
      const prefix = PREFIX[section];
      const added = { id: `${prefix}${brief.next[prefix]}`, section, text, basis: 'confirmed', status: 'open', turn };
      return { brief: { ...brief, rev: brief.rev + 1, updatedTurn: turn, next: { ...brief.next, [prefix]: brief.next[prefix] + 1 }, items: [...brief.items, added] } };
    }
    default:
      return { error: 'Invalid request. / 无效的请求。' };
  }
}

// ---- The model's view -------------------------------------------------------------------------

export const BRIEF_GUIDANCE = [
  '# Task brief',
  'Keep this conversation\'s task brief with task_brief. It is your working memory of what the user wants: it is re-read on every request and survives compaction, it is the checklist you verify before your final answer, and the user sees it as a card and corrects a misunderstanding before it costs work.',
  'File a user message when it carries a goal, a constraint, an acceptance criterion, a preference, background you will rely on, or several requests at once, or when it is long or scattered. File it in one task_brief update before your first tool call on that message. Skip small talk and a clear one-line task.',
  '- One fact per item, self-contained, in the user\'s language, and each fact once. Sections: goal, constraint, acceptance, context, question.',
  '- When you resolve an ambiguity yourself, keep the user\'s words as a user item and file only the assumption as an inferred item (e.g. C3 [user] 预算不超过 1500; C4 [inferred] 1500 按两人合计). Say the assumption in your answer.',
  '- An item that restates the user carries quote: a span of their message copied exactly. An implicit need the user did not say carries inferred:true and no quote; add the ones the task really implies, such as keeping existing behavior working.',
  '- Answers the user gave on a question card or a card button are their words too: quote the chosen option or typed text.',
  '- Mark spans with no task content (greetings, filler, thanks) with skip. The result lists any unfiled text: file it or skip it, so every clause is accounted for.',
  '- When the user changes their mind, edit or remove the item. Items the user confirmed change only at the user\'s request.',
  '- Put an unresolved point in a question item and ask about it with ask_user.',
  '- Before your final answer, check each open acceptance item and mark the finished ones done.',
].join('\n');

function itemLine(item) {
  const basis = item.basis === 'inferred' ? 'inferred' : item.basis === 'confirmed' ? 'confirmed' : `user ${item.from ?? ''}`.trim();
  return `- ${item.id} [${basis}] ${item.text}${item.basis !== 'inferred' && item.quote && item.quote !== item.text ? ` ${quoted(item.quote)}` : ''}`;
}

/**
 * The current brief as the model reads it: items by section; finished and dropped items shrink to
 * their ids; unfiled text and condensed messages are named. Empty when there is nothing to show.
 *
 * It travels as a runtime-context snapshot, not in the system prompt: a changed system prompt is
 * re-sent whole (about 18k tokens, uncached, kept in history), while a changed snapshot appends
 * only itself. The host re-sends the snapshot after compaction removes it.
 */
export function stateText(brief) {
  if (brief.items.length === 0 && !brief.messages.some(message => message.condensed)) return '';
  const lines = [`# Task brief (rev ${brief.rev}) — this conversation's current brief; it replaces earlier task brief snapshots`,
    'user and confirmed items are binding; check inferred items with the user before relying on them. The user\'s own words outrank this brief: if they disagree, fix the brief.'];
  for (const section of SECTIONS) {
    const open = brief.items.filter(item => item.section === section && item.status === 'open');
    if (open.length === 0) continue;
    lines.push(SECTION_TITLES[section], ...open.map(itemLine));
  }
  const done = brief.items.filter(item => item.status === 'done').map(item => item.id);
  if (done.length) lines.push(`Done: ${done.join(' ')}`);
  const dropped = brief.items.filter(item => item.status === 'dropped').map(item => item.id);
  if (dropped.length) lines.push(`Dropped by the user: ${dropped.join(' ')}`);
  const unfiled = openCoverage(brief);
  if (unfiled.length) lines.push(`Unfiled text — file it or skip it: ${unfiled.map(row => `${row.ref} ${row.unfiled.map(quoted).join(' ')}`).join('; ')}`);
  const condensed = brief.messages.filter(message => message.condensed).map(message => message.ref);
  if (condensed.length) lines.push(`Condensed into this brief: ${condensed.join(' ')}. Read an original with task_brief action=source when exact wording matters.`);
  let text = lines.join('\n');
  if (text.length > MAX_PROMPT) text = `${text.slice(0, MAX_PROMPT - 80)}\n… brief truncated here; read the rest with task_brief action=read.`;
  return text;
}

/** Guidance and the current brief together, as one reader sees both. */
export function promptText(brief) {
  const state = stateText(brief);
  return state ? `${BRIEF_GUIDANCE}\n\n${state}` : BRIEF_GUIDANCE;
}

/** The stub that replaces a condensed message in the model's history. */
export function stubText(brief, message) {
  const ids = brief.items.filter(item => item.from === message.ref).map(item => item.id);
  const lines = [`[User message ${message.ref} (turn ${message.turn}) is filed in the task brief${ids.length ? `: ${ids.join(' ')}` : ''}. The full text stays in the log and the chat; read it with task_brief action=source ref=${message.ref} when exact wording matters.]`];
  const { unfiled } = coverage(message, brief.items);
  if (unfiled.length) lines.push('Unfiled text from this message, verbatim:', ...unfiled.map(quoted));
  return lines.join('\n');
}

/** Whether a message has task content worth filing: long, several clauses, or a rule word. */
export function substantive(text) {
  const plain = normal(text);
  if (plain.length >= 60) return true;
  if (clauses(plain).length >= 3) return true;
  return /必须|不要|不能|别|只能|只要|务必|一定|禁止|保留|不用|要求|\bmust\b|\bdon'?t\b|\bnever\b|\bonly\b|\bkeep\b/iu.test(plain);
}

/** Item id → section, for readers that only have the id. */
export const sectionOfId = id => ITEM_ID.test(id) ? SECTION_OF[id[0]] : undefined;
