// Runtime for the task brief (lib/task-brief.mjs).
//
// - A session projection folds the human user messages and the brief records, so the card, the
//   tool and the prompt read one state, rebuilt from the log after a restart.
// - A protected system prompt section shows the guidance and the current brief on every request.
// - A context reminder nudges the model when a substantive message is left unfiled.
// - The `task_brief` tool (a Deep PTC preset row, lib/brief-tool.mjs) files and reads.
// - The `deep-ptc-brief` command applies the user's edits from the card, and condenses or restores
//   messages. Condensing replaces the message's node in the model's history at the next pre-step;
//   the original event stays in the log, so the chat and task_brief source still show it.

import { randomUUID } from 'node:crypto';
import { gated } from './gate.mjs';
import { importHost } from './host.mjs';
import { isDeepPtcSession } from './session-preset.mjs';
import { projectToolDefinition } from './project-context.mjs';
import { CARD_SOURCE, NO_SESSION, WRONG_MODE } from './model-view.mjs';
import { MAX_MESSAGES, MAX_MESSAGE, REF, SECTIONS, applyUpdate, applyUserEdit, blankBrief, BRIEF_GUIDANCE, coverage, messageText, openCoverage,
  stateText, stubText, substantive } from './task-brief.mjs';

export const BRIEF_KEY = 'deepPtcBrief';
export const BRIEF_EVENT = 'plugin:dsh-deep-ptc-mode/brief';
export const BRIEF_COMMAND = 'deep-ptc-brief';
export const BRIEF_TOOL = 'task_brief';
export const BRIEF_SOURCE = 'deep-ptc-brief';
const SECTION_NAME = 'deep-ptc:task-brief';
const SECTION_ORDER = 10198;
const REMINDER_ORDER = 124;
const BRIEF_CONTEXT_ORDER = 125;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const appended = event => event?.type === 'user/message' && (event.surfaceOp === undefined || event.surfaceOp === 'append');
const humanMessage = event => appended(event) && event.data?.source?.kind === 'user';
// Card answers and button choices are the user's words too: the brief can quote them.
const cardAnswer = event => appended(event) && event.data?.source?.kind === CARD_SOURCE;

/** A card answer as quotable text: `prompt：value` per answer, without the model-view scaffolding. */
export function cardAnswerText(text) {
  const lines = [];
  for (const line of text.split('\n')) {
    const match = /^[A-Za-z][\w]* = (.*?)(?:\s{2,}# (.*))?$/u.exec(line);
    if (!match) continue;
    const words = [...match[1].matchAll(/«([^»]*)»/gu)].map(found => found[1]);
    const value = words.length ? words.join('、') : match[1].replace(/^\[|\]$/gu, '');
    lines.push(match[2] ? `${match[2]}：${value}` : value);
  }
  return lines.join('\n');
}

// ---- State ------------------------------------------------------------------------------------

// Keep the newest messages, but never drop one the brief still points at.
function trimMessages(messages, items) {
  if (messages.length <= MAX_MESSAGES) return messages;
  const used = new Set(items.map(item => item.from));
  const out = [];
  let budget = messages.length - MAX_MESSAGES;
  for (const message of messages) {
    if (budget > 0 && !used.has(message.ref) && !message.condensed) { budget--; continue; }
    out.push(message);
  }
  return out;
}

const MARKS = ['skipped', 'condensed', 'pending', 'stubSeq'];
function marksOf(message) {
  return Object.fromEntries(MARKS.filter(key => message[key] !== undefined).map(key => [key, message[key]]));
}

/** A record carries the brief and each message's marks; message text is folded from the log. */
export function briefRecord(brief) {
  return { v: 1, rev: brief.rev, updatedTurn: brief.updatedTurn, next: brief.next, items: brief.items,
    marks: Object.fromEntries(brief.messages.filter(message => Object.keys(marksOf(message)).length).map(message => [message.ref, marksOf(message)])) };
}

export function foldBrief(state, event) {
  if (event?.type === 'turn/start') {
    const turn = event.data?.turn;
    return Number.isSafeInteger(turn) && turn > state.turn ? { ...state, turn } : state;
  }
  if ((humanMessage(event) || cardAnswer(event)) && Number.isSafeInteger(event.seq)) {
    const ref = `m${event.seq}`;
    if (state.messages.some(message => message.ref === ref)) return state;
    const card = cardAnswer(event);
    const text = card ? cardAnswerText(messageText(event.data)) : messageText(event.data);
    if (text.trim() === '') return state;
    return { ...state, messages: trimMessages([...state.messages, { ref, seq: event.seq, turn: state.turn, text, ...card ? { card: true } : {} }], state.items) };
  }
  if (event?.type !== BRIEF_EVENT || !isRecord(event.data) || event.data.v !== 1) return state;
  const record = event.data;
  if (!Array.isArray(record.items) || !isRecord(record.next) || !Number.isSafeInteger(record.rev)) return state;
  const marks = isRecord(record.marks) ? record.marks : {};
  const messages = state.messages.map(message => {
    const { skipped: _s, condensed: _c, pending: _p, stubSeq: _q, ...rest } = message;
    const mark = isRecord(marks[message.ref]) ? marks[message.ref] : {};
    return { ...rest, ...Array.isArray(mark.skipped) ? { skipped: mark.skipped.filter(span => typeof span === 'string') } : {},
      ...mark.condensed === true ? { condensed: true } : {}, ...mark.pending === 'condense' || mark.pending === 'restore' ? { pending: mark.pending } : {},
      ...Number.isSafeInteger(mark.stubSeq) ? { stubSeq: mark.stubSeq } : {} };
  });
  const items = record.items.filter(item => isRecord(item) && typeof item.id === 'string' && SECTIONS.includes(item.section) && typeof item.text === 'string');
  return { ...state, rev: record.rev, updatedTurn: Number.isSafeInteger(record.updatedTurn) ? record.updatedTurn : state.turn, next: record.next, items, messages };
}

export function parseBrief(value) {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.items) || !Array.isArray(value.messages)) throw new Error('Invalid Deep PTC task brief');
  return value;
}

/** What the card reads: the brief, and each filed message with its coverage. */
export function briefView(state) {
  const filed = state.messages.filter(message => message.condensed || message.pending || message.skipped?.length || state.items.some(item => item.from === message.ref));
  return { v: 1, rev: state.rev, turn: state.turn, updatedTurn: state.updatedTurn, items: state.items,
    messages: filed.map(message => ({ ref: message.ref, turn: message.turn, preview: message.text.slice(0, 160),
      ...coverage(message, state.items), ...message.condensed ? { condensed: true } : {}, ...message.pending ? { pending: message.pending } : {} })) };
}

export function parseBriefView(value) {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.items) || !Array.isArray(value.messages)) throw new Error('Invalid Deep PTC task brief view');
  return value;
}

// ---- Runtime ----------------------------------------------------------------------------------

/** The runtime the preset row's tool uses; set once the profile-level layer is installed. */
export const briefRuntime = { api: undefined };

let messageFactory;
async function createMessage(content, summary) {
  messageFactory ??= importHost('@deepseek-ai/dsh-llm').then(module => module.createUserMessage).catch(() => undefined);
  const create = await messageFactory;
  const source = { kind: BRIEF_SOURCE, form: 'notice', summary };
  return typeof create === 'function' ? create({ content, source }) : { id: randomUUID(), role: 'user', content, source };
}

export async function sessionRecords() {
  const { appendPluginRecord } = await importHost('@deepseek-ai/dsh-session');
  if (typeof appendPluginRecord !== 'function') throw new Error('the installed session module has no appendPluginRecord');
  return appendPluginRecord;
}

/**
 * @param options - `{ enabled, watch }`: the setting getter and its change subscription.
 */
export function apply(ctx, options = {}) {
  const enabled = () => { try { return options.enabled?.() !== false; } catch { return true; } };
  const runtime = ctx.plugin({ name: 'deep-ptc-brief-layer', inject: ['commands', 'sessionProjections'],
    apply: child => install(child, sessionRecords, { ...options, enabled }) }).await()
    .catch(error => ctx.logger.warn('Deep PTC: the task brief is off (%s)', error.message));
  const prompt = ctx.plugin({ name: 'deep-ptc-brief-prompt', inject: ['systemPrompt'], apply: child => {
    gated(child, enabled, options.watch, () => {
      const section = child.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER,
        text: ({ agent }) => sectionText(ctx, agent) });
      // The brief itself changes as the model files it, so it rides in the runtime-context snapshot:
      // a change appends the small snapshot instead of re-sending the whole system prompt.
      const brief = child.systemPrompt.context({ name: 'deep-ptc:task-brief-state', order: BRIEF_CONTEXT_ORDER, required: true,
        text: ({ agent }) => briefContextText(ctx, agent) });
      const reminder = child.systemPrompt.context({ name: 'deep-ptc:task-brief-reminder', order: REMINDER_ORDER,
        text: ({ agent }) => reminderText(ctx, agent) });
      return () => { section?.(); brief?.(); reminder?.(); };
    }, 'Deep PTC: task brief prompt');
  } }).await().catch(error => ctx.logger.warn('Deep PTC: the task brief is not in the prompt (%s)', error.message));
  return Promise.all([runtime, prompt]);
}

function stateOf(agent) {
  const api = briefRuntime.api;
  return api === undefined || agent?.session === undefined ? undefined : api.read(agent.session);
}

/** The fixed guidance: the same text on every request, so the system prompt stays cached. */
export function sectionText(ctx, agent) {
  return isDeepPtcSession(ctx, agent?.session) ? BRIEF_GUIDANCE : '';
}

/** The current brief, for the runtime-context snapshot. */
export function briefContextText(ctx, agent) {
  try {
    if (!isDeepPtcSession(ctx, agent?.session)) return '';
    const state = stateOf(agent);
    return state === undefined ? '' : stateText(state);
  } catch (error) {
    ctx.logger?.warn?.('Deep PTC: task brief unreadable (%s)', error.message);
    return '';
  }
}

// Steps since the latest human message, per live session, for the reminder.
const pace = new WeakMap();
export function reminderText(ctx, agent) {
  try {
    const row = pace.get(agent?.session);
    if (row === undefined || row.steps < 1 || row.shown >= 2 || !isDeepPtcSession(ctx, agent.session)) return '';
    const state = stateOf(agent);
    const message = state?.messages.find(item => item.ref === row.ref);
    if (message === undefined || !substantive(message.text)) return '';
    if (message.skipped?.length || state.items.some(item => item.from === message.ref)) return '';
    row.shown += 1;
    return `The user's latest message ${message.ref} is not in the task brief. Before your next tool call, file its goals, constraints and acceptance criteria with one task_brief update (quote their words; mark implicit needs inferred). If it truly holds no task content, skip its text instead.`;
  } catch { return ''; }
}

export async function install(ctx, records = sessionRecords, options = {}) {
  const appendPluginRecord = await records();
  const projection = await ctx.sessionProjections.register({ key: BRIEF_KEY, stateVersion: 1, stateSchema: { parse: parseBrief },
    init: blankBrief, apply: foldBrief, wire: { viewSchema: { parse: parseBriefView }, view: briefView, summary: false } });
  ctx.effect(() => () => projection.dispose());
  const enabled = () => { try { return options.enabled?.() !== false; } catch { return true; } };
  const read = session => projection.stateOf(session) ?? blankBrief();
  const save = (session, brief) => appendPluginRecord(session, BRIEF_EVENT, briefRecord(brief));
  const api = { ctx, read, save, enabled };
  briefRuntime.api = api;
  ctx.effect(() => () => { if (briefRuntime.api === api) briefRuntime.api = undefined; });

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (humanMessage(event) && Number.isSafeInteger(event.seq)) pace.set(session, { ref: `m${event.seq}`, steps: 0, shown: 0 });
    else if (event?.type === 'assistant/message') { const row = pace.get(session); if (row) row.steps += 1; }
  }));
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    try { if (enabled() && isDeepPtcSession(ctx, payload?.agent?.session)) await settleCondensing(ctx, api, payload.agent.session); }
    catch (error) { ctx.logger.warn('Deep PTC: condensing failed (%s)', error.message); }
    return typeof next === 'function' ? next() : undefined;
  }));
  ctx.commands.register({ name: BRIEF_COMMAND, recordInput: false,
    description: '编辑本次任务卡 / Edit the task brief',
    handler: ({ agent, rawInput }) => command(api, agent, rawInput) });
}

/**
 * Apply pending condense and restore marks to the model's history: replace the message's node
 * with its stub, or the stub with the original content. Runs before a model request.
 */
export async function settleCondensing(ctx, api, session) {
  let state = api.read(session);
  if (!state.messages.some(message => message.pending)) return;
  const visible = new Set(Array.isArray(session.surface?.nodes) ? session.surface.nodes : []);
  const messages = [];
  for (const message of state.messages) {
    if (!message.pending) { messages.push(message); continue; }
    const { pending, ...rest } = message;
    try {
      if (pending === 'condense' && !message.condensed && visible.has(message.seq)) {
        const stub = await createMessage([{ type: 'text', text: stubText(state, message) }], `任务卡替身 · ${message.ref}`);
        const event = session.append('user/message', stub, { surfaceOp: { op: 'replace', startSeq: message.seq, endSeq: message.seq }, sourceEventSeqs: [message.seq] });
        messages.push({ ...rest, condensed: true, stubSeq: event.seq });
        continue;
      }
      if (pending === 'restore' && message.condensed && Number.isSafeInteger(message.stubSeq) && visible.has(message.stubSeq)) {
        const original = session.eventAt(message.seq);
        const restored = await createMessage(original.data.content, `原话已恢复 · ${message.ref}`);
        session.append('user/message', restored, { surfaceOp: { op: 'replace', startSeq: message.stubSeq, endSeq: message.stubSeq }, sourceEventSeqs: [message.stubSeq, message.seq] });
        const { condensed: _c, stubSeq: _s, ...plain } = rest;
        messages.push(plain);
        continue;
      }
    } catch (error) {
      ctx.logger.warn('Deep PTC: could not %s %s (%s)', pending, message.ref, error.message);
    }
    // Nothing to do (compacted away, already in place) or it failed: drop the mark.
    messages.push(rest);
  }
  state = { ...state, messages };
  await api.save(session, state);
}

const ok = text => ({ kind: 'success', text });
const fail = text => ({ kind: 'error', text });

/** One edit from the brief card. */
export async function command(api, agent, rawInput) {
  const session = agent?.session;
  if (!session) return fail(NO_SESSION);
  if (!api.enabled()) return fail('The task brief is turned off in settings. / 任务卡已在设置中关闭。');
  if (!isDeepPtcSession(api.ctx, session)) return fail(WRONG_MODE);
  let request;
  try { request = JSON.parse(String(rawInput ?? '')); } catch { return fail('Invalid request. / 无效的请求。'); }
  if (!isRecord(request)) return fail('Invalid request. / 无效的请求。');
  const state = api.read(session);
  if (Number.isSafeInteger(request.rev) && request.rev !== state.rev) return fail('The brief changed; check the latest version. / 任务卡已更新，请查看最新内容。');
  if (request.op === 'condense' || request.op === 'restore') {
    const wanted = request.ref === 'all' ? state.messages.filter(message => request.op === 'condense'
      ? !message.condensed && state.items.some(item => item.from === message.ref) : message.condensed)
      : state.messages.filter(message => message.ref === request.ref);
    if (wanted.length === 0) return fail(request.op === 'condense' ? 'No filed message to condense. / 没有可精简的消息。' : 'Nothing to restore. / 没有可恢复的消息。');
    const refs = new Set(wanted.map(message => message.ref));
    // Condensing is the user's check that the brief is right: their items become confirmed.
    const items = request.op === 'condense' ? state.items.map(item => refs.has(item.from) && item.basis === 'user' ? { ...item, basis: 'confirmed' } : item) : state.items;
    const messages = state.messages.map(message => refs.has(message.ref) ? { ...message, pending: request.op } : message);
    await api.save(session, { ...state, rev: state.rev + 1, updatedTurn: state.turn, items, messages });
    return ok(request.op === 'condense' ? 'condense' : 'restore');
  }
  if (request.op === 'promote') {
    const item = state.items.find(row => row.id === request.id);
    if (item === undefined) return fail('Unknown item. / 未知的条目。');
    try {
      await projectToolDefinition().execute({ action: 'write', card: 'requirements', mode: 'append', items: [{ text: item.text }] }, { agent });
    } catch (error) { return fail(String(error?.message ?? error)); }
    return ok('promoted');
  }
  const result = applyUserEdit(state, request, state.turn);
  if (result.error) return fail(result.error);
  await api.save(session, result.brief);
  return ok(`v${result.brief.rev}`);
}

// ---- The tool ---------------------------------------------------------------------------------

/** The task_brief tool, bound to the shared runtime at call time. */
export function briefToolDefinition(runtime = briefRuntime) {
  const item = { type: 'object', additionalProperties: false, required: ['text'], properties: {
    id: { type: 'string', description: 'Existing item id (G1, C2, …) to reword; omit for a new item.' },
    section: { type: 'string', enum: SECTIONS, description: 'New items: goal, constraint, acceptance, context or question.' },
    text: { type: 'string', description: 'One self-contained fact in the user\'s language, up to 300 characters.' },
    quote: { type: 'string', description: 'The user\'s words this item restates, copied exactly from their message.' },
    from: { type: 'string', description: 'Message ref (m…) the quote is from; default: the newest message containing it.' },
    inferred: { type: 'boolean', description: 'true for an implicit need the user did not state; no quote.' },
  } };
  return {
    name: BRIEF_TOOL,
    resident: true,
    description: 'File the user\'s goals, constraints, acceptance criteria, context and open questions into this conversation\'s task brief, the checklist you work and verify against. update adds or rewords items (quote the user verbatim, or mark inferred), marks items done, removes items and skips text with no task content; it returns any unfiled text. read returns the brief with coverage; source returns a user message\'s original text, including condensed ones.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['update', 'read', 'source'] },
      items: { type: 'array', items: item, description: 'Up to 40 items in the whole brief.' },
      done: { type: 'array', items: { type: 'string' }, description: 'Ids of items now finished and verified.' },
      remove: { type: 'array', items: { type: 'string' }, description: 'Ids of items no longer wanted.' },
      skip: { type: 'array', description: 'Spans of user text with no task content (greetings, filler).', items: { type: 'object', additionalProperties: false,
        required: ['quote'], properties: { quote: { type: 'string' }, from: { type: 'string' } } } },
      ref: { type: 'string', description: 'source: the message ref (m…).' },
    } },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const api = runtime.api;
      if (api === undefined) throw new Error('The task brief is not ready yet; try again in a moment');
      if (!api.enabled()) throw new Error('The task brief is turned off in settings');
      const session = exec.agent?.session;
      if (!session) throw new Error('No active conversation');
      const state = api.read(session);
      if (args.action === 'read') {
        return { rev: state.rev, items: state.items, unfiled: openCoverage(state),
          messages: state.messages.map(message => ({ ref: message.ref, turn: message.turn, ...message.condensed ? { condensed: true } : {} })) };
      }
      if (args.action === 'source') {
        if (typeof args.ref !== 'string' || !REF.test(args.ref)) throw new Error('source needs ref, e.g. m42');
        const message = state.messages.find(row => row.ref === args.ref);
        let text = message?.text;
        try { text = messageText(session.eventAt(Number(args.ref.slice(1)))?.data).slice(0, MAX_MESSAGE) || text; } catch { /* the folded copy */ }
        if (!text) throw new Error(`Unknown message ${args.ref}`);
        return { ref: args.ref, text };
      }
      if (args.action !== 'update') throw new Error('action must be update, read or source');
      const result = applyUpdate(state, args, state.turn);
      if (result.brief !== state) await api.save(session, result.brief);
      const unfiled = openCoverage(result.brief);
      return { rev: result.brief.rev, changes: result.text || 'none',
        ...result.rejected.length ? { rejected: result.rejected } : {},
        ...unfiled.length ? { unfiled, next: 'File the unfiled text as items, or skip it if it holds no task content.' } : { coverage: 'every filed message is fully accounted for' } };
    },
  };
}
