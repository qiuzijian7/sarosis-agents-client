// Runtime for conversation cards and question cards.
//
// Cards are plugin state: a session projection folds the card records (lib/card-state.mjs), a host
// command applies a button, an answer or a close, and two tools let the model post cards:
//   ui_card   display and interactive cards (profile-wide, gated by the settings switch);
//   ask_user  question cards, the replacement for the host's blocking question box (a Deep PTC
//             preset row, lib/question-tool.mjs, so other modes keep their own question tool).
//
//   card-blocks.mjs  block vocabulary and readers     cards.mjs          card bodies and buttons
//   card-questions   question bodies and answers      card-state.mjs     records, versions, archives
//   card-runner.mjs  button command via the shell     card-skill.mjs     skill text

import { gated } from './gate.mjs';
import { isDeepPtcSession } from './session-preset.mjs';
import { importHost } from './host.mjs';
import { blockSchema, fillPlaceholders, ICONS, readValues, TONES } from './card-blocks.mjs';
import { runCardCommand } from './card-runner.mjs';
import { CARD_EXAMPLES_REGISTRATION, CARD_SKILL_REGISTRATION } from './card-skill.mjs';
import { CARD_COMMAND, CARD_SIZES, CARD_TOOL, CARDS_KEY, MAX_ID, readCardInput, ANSWERED, FAILED, OPEN, STOPPED, STOPPING } from './cards.mjs';
import { MAX_QUESTIONS, QUESTION_KIND, QUESTION_TYPES, readAnswers, readQuestionInput } from './card-questions.mjs';
import { CARDS_EVENT, STATE_VERSION, archivedReason, blankCards, cardsDigest, foldCardsState, latestOf, parseCardsState, records } from './card-state.mjs';
import { NO_SESSION, answerView, coded, deliver, replyView } from './model-view.mjs';

// Keep the 2.1.0 wire texts: cached clients compare them literally.
// Success texts that tell the client the server already delivered the model's message, so the
// client sends no text reply of its own. Older servers answer with the other texts.
export const DELIVERED = {
  answer: 'Answer sent to the model. / 已把回答发给模型。',
  choice: 'Choice sent to the model. / 已把选择发给模型。',
  action: 'Card action completed and reported to the model. / 卡片操作已完成并告知模型。',
};

export const name = 'deep-ptc-cards';
function receipt(request, kind) {
  return request.codedReceipt ? coded('delivered:' + kind, DELIVERED[kind]) : DELIVERED[kind];
}

export const QUESTION_TOOL = 'ask_user';
// Optional layer: a missing service disables the cards rather than the preset.
export const inject = [];
const REQUIRED = ['commands', 'sessionProjections', 'tools'];
const MAX_REASON = 300;

const GUIDANCE = 'Proactively use ui_card during the conversation, and write progress messages as well as the final answer in the user’s language. Show measured results with a display card; each block uses the type field, e.g. {type:"bars",items:[{label:"v1",value:48}]}. To ask the user anything — a choice among alternatives, a confirmation, missing information — call ask_user: it posts a question card and returns at once. Then wait: say what you are waiting for and end your turn; the answers arrive as the user’s next message. Never ask the same question again in plain text. Every card shows to the user at once. An interactive card (ask_user, or a ui_card with a reply button) asks for a decision: after posting it, end your turn and wait for the answer. A display card does not wait: post it and keep working. Cards stay in the conversation: re-show a card with the same id to post its new state; only the newest version in the current turn takes clicks. Lay cards out like a dashboard, not a list: post related compact cards together (a status and its control, results and coverage, two options) so they share a row; keep one idea per card; reserve full-width cards for tables, long charts and dense content. Leave size unset to let the layout pair cards; set half or third only for an intended row. For setup opened in the Project cards panel, ask and receive answers directly in that panel. There is no limit on cards or questions: post as many as the work needs, one idea per card. When you show a result the user may act on (which fix to apply, what to keep, what to run next), give the card buttons instead of asking in prose.';

/**
 * @param options - `{ enabled, watch }`: the setting getter and change subscription.
 */
export function apply(ctx, options = {}) {
  // Each layer starts once its own services exist; the caller never holds the boot for them.
  const cards = ctx.plugin({ name: 'deep-ptc-cards-layer', inject: REQUIRED, apply: child => install(child, sessionRecords, options) }).await()
    .catch(error => ctx.logger.warn('Deep PTC: conversation cards are off (%s)', error.message));
  // The skill is guidance only: without a skill service the cards still work.
  const skill = ctx.plugin({ name: 'deep-ptc-cards-skill', inject: ['skills'], apply: child => {
    for (const registration of [CARD_SKILL_REGISTRATION, CARD_EXAMPLES_REGISTRATION]) {
      gated(child, options.enabled, options.watch, () => child.skills.register(registration), registration.name);
    }
  } }).await()
    .catch(error => ctx.logger.warn('Deep PTC: the card skill is off (%s)', error.message));
  const guidance = ctx.plugin({ name: 'deep-ptc-conversation-card-guidance', inject: ['systemPrompt'], apply: child =>
    gated(child, options.enabled, options.watch, () => child.systemPrompt.section({
      name: 'deep-ptc:conversation-cards', order: 10197,
      text: ({ agent }) => isDeepPtcSession(ctx, agent?.session) ? GUIDANCE : '',
    }), 'Deep PTC: conversation card guidance') }).await()
    .catch(error => ctx.logger.warn('Deep PTC: conversation card guidance unavailable (%s)', error.message));
  return Promise.all([cards, skill, guidance]);
}

/** The session module's plugin-record writer; injectable so the card path runs in tests. */
export async function sessionRecords() {
  const { appendPluginRecord } = await importHost('@deepseek-ai/dsh-session');
  if (typeof appendPluginRecord !== 'function') throw new Error('the installed session module has no appendPluginRecord');
  return appendPluginRecord;
}

/** The runtime the question tool's preset row uses; set once the profile-level layer is installed. */
export const cardsRuntime = { store: undefined, enabled: () => true };

const cardId = (args, fallback) => typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim().slice(0, MAX_ID) : fallback;

// Post one version and return what the model needs to follow up. The fold runs as the record is
// appended, so the new state is read back rather than predicted.
async function post(store, session, id, body) {
  const before = store.read(session);
  await store.append(session, records.show(before, id, body));
  const state = store.read(session);
  const version = latestOf(state, id);
  if (version === undefined || version.rev <= before.seq) throw new Error('The card could not be stored');
  return { state, version };
}

// The ui_card tool definition. Its description is short on purpose: the layouts live in the skill.
function cardToolDefinition(store) {
  return {
    name: CARD_TOOL,
    // Deep PTC's own tool: its full schema stays in the run_code SDK instead of the compact catalog.
    resident: true,
    description: 'Post or update a card in the conversation: a header, up to 6 blocks (display: stats, rows, progress, bars, line, donut, steps, table, tags, text, callout; interactive: choice, field), a note and up to 4 buttons that run on the host and/or send the user\'s choice back to you. Cards stay in the chat history; showing the same id again posts its new state. Load the deep-ptc-cards skill for rules and sample layouts. To ask the user a question use ask_user instead.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['show', 'remove'], description: 'show posts a card (a new version for an existing id); remove closes one by id.' },
      id: { type: 'string', description: 'Stable id; reuse it to post the same card\'s new state.' },
      title: { type: 'string', description: 'Card title.' },
      subtitle: { type: 'string', description: 'One line under the title.' },
      icon: { type: 'string', enum: ICONS },
      size: { type: 'string', enum: CARD_SIZES, description: 'Width in the card grid: full (default), half or third. Pair related compact cards side by side.' },
      tone: { type: 'string', enum: TONES, description: 'Overall state of the card.' },
      blocks: { type: 'array', items: blockSchema(), description: 'Card body, top to bottom.' },
      lines: { type: 'array', description: 'Shorthand for a leading rows block.', items: { type: 'object', additionalProperties: false,
        properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] } },
      note: { type: 'string', description: 'Footnote, up to 400 characters.' },
      actions: { type: 'array', description: 'Up to 4 buttons. Each needs run, reply or both.', items: {
        type: 'object', additionalProperties: false, required: ['label'], properties: {
          id: { type: 'string', description: 'Stable button id.' },
          label: { type: 'string', description: 'Verb label, e.g. 推迟 10 分钟.' },
          style: { type: 'string', enum: ['primary', 'default', 'danger'] },
          run: { type: 'object', additionalProperties: false, description: 'Runs on the host when pressed.', properties: {
            command: { type: 'string', description: 'Run through the conversation’s active Harness shell tool and permissions. The foreground wait is at most 30 s. {name} is replaced by that choice/field value.' },
            schedules: { type: 'array', items: { type: 'string' }, description: 'Scheduled task ids to delete.' },
          } },
          reply: { oneOf: [{ type: 'boolean' }, { type: 'string' }], description: 'Send the choice back to you as the user\'s message: true for a default summary, or a template with {name} placeholders.' },
          keep: { type: 'boolean', description: 'Keep the card usable after the button within this turn.' },
        } } },
      stop: { type: 'object', additionalProperties: false, description: 'Legacy single button; prefer actions.',
        properties: { label: { type: 'string' }, command: { type: 'string' }, schedules: { type: 'array', items: { type: 'string' } } } },
    } },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const session = exec.agent?.session;
      if (!session) throw new Error('No active conversation');
      if (args.action === 'remove') {
        const state = store.read(session);
        const version = latestOf(state, typeof args.id === 'string' ? args.id : '');
        if (version === undefined) throw new Error('Unknown card id');
        await store.append(session, records.dismiss(version));
        return { removed: version.id, cards: cardsDigest(store.read(session)) };
      }
      const parsed = readCardInput(args);
      if (parsed.issues !== undefined) throw new Error(parsed.issues.join('; '));
      const { state, version } = await post(store, session, cardId(args, `card-${store.read(session).seq + 1}`), parsed.card);
      // An interactive card asks for the user's decision: wait for it. A display card does not.
      const asks = (version.actions ?? []).some(action => action.reply);
      return { id: version.id, rev: version.rev, turn: version.turn, phase: version.phase, shown: 'the user sees this card now',
        next: asks ? 'This card asks the user to decide: say in one line what you are waiting for and end your turn; the choice arrives as the user\'s next message. Do not build on an assumed choice.'
          : 'A display card: continue your work.',
        cards: cardsDigest(state) };
    },
  };
}

/** The ask_user tool, bound to the shared runtime at call time (lib/question-tool.mjs registers it). */
export function questionToolDefinition(runtime = cardsRuntime) {
  return {
    name: QUESTION_TOOL,
    resident: true,
    description: `Ask the user: post a question card in the chat and return at once (it never waits). Up to ${MAX_QUESTIONS} questions; each is a single choice, a multiple choice or a short text answer, with an optional recommended option. Then end your turn to wait; the user's answers arrive as their next message. The card stays in the chat history with the answers.`,
    parameters: { type: 'object', additionalProperties: false, required: ['title', 'questions'], properties: {
      id: { type: 'string', description: 'Optional stable id.' },
      title: { type: 'string', description: 'The decision being asked, e.g. 选择部署方案.' },
      subtitle: { type: 'string', description: 'One line of context: why you ask, what depends on it.' },
      questions: { type: 'array', description: `1-${MAX_QUESTIONS} questions.`, items: { type: 'object', additionalProperties: false, required: ['prompt'], properties: {
        id: { type: 'string', description: 'Short id, e.g. plan.' },
        prompt: { type: 'string', description: 'The question.' },
        type: { type: 'string', enum: QUESTION_TYPES, description: 'single (default with options), multi, or text (default without options).' },
        options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label'], properties: {
          value: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string', description: 'Why or when to pick it.' } } } },
        recommended: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Option value to preselect; a list for multi.' },
        placeholder: { type: 'string', description: 'text questions: example answer.' },
        optional: { type: 'boolean', description: 'The user may leave it blank.' },
      } } },
    } },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const store = runtime.store;
      if (store === undefined) throw new Error('Question cards are not ready yet; try again in a moment');
      if (!runtime.enabled()) throw new Error('Conversation cards are turned off in settings');
      const session = exec.agent?.session;
      if (!session) throw new Error('No active conversation');
      const parsed = readQuestionInput(args);
      if (parsed.issues !== undefined) throw new Error(parsed.issues.join('; '));
      const { version } = await post(store, session, cardId(args, `question-${store.read(session).seq + 1}`), parsed.card);
      return { id: version.id, rev: version.rev, status: 'posted, waiting for the user',
        next: 'The user sees the card now. Wait for the answers: say in one line what you are waiting for and end your turn; the answers arrive as the user\'s next message. Do not build on an assumed answer, and do not ask again in plain text.' };
    },
  };
}

export async function install(ctx, records_ = sessionRecords, options = {}) {
  const appendPluginRecord = await records_();
  const schema = { parse: parseCardsState };
  const projection = await ctx.sessionProjections.register({ key: CARDS_KEY, stateVersion: STATE_VERSION,
    stateSchema: schema, init: blankCards, apply: foldCardsState,
    wire: { viewSchema: schema, view: state => state, summary: false } });
  ctx.effect(() => () => projection.dispose());
  const store = {
    read: session => projection.stateOf(session) ?? blankCards(),
    append: (session, record) => appendPluginRecord(session, CARDS_EVENT, record),
  };
  const enabled = () => options.enabled?.() !== false;
  cardsRuntime.store = store;
  cardsRuntime.enabled = enabled;
  ctx.effect(() => () => { if (cardsRuntime.store === store) cardsRuntime.store = undefined; });

  ctx.commands.register({ name: CARD_COMMAND, recordInput: false,
    description: '处理对话卡片上的一个操作 / Apply one action to a conversation card',
    handler: request => act(ctx, request, store, enabled) });

  // The settings switch removes the tool, so the model never sees a card tool it may not use.
  gated(ctx, enabled, options.watch, () => ctx.tools.register(cardToolDefinition(store)), 'Deep PTC: card tool');
}

const ARCHIVED = {
  unknown: 'Unknown card. / 未知的卡片。',
  superseded: 'This card has a newer version. / 这张卡片已有新版本。',
  dismissed: 'This card was closed. / 这张卡片已关闭。',
  'earlier-turn': 'This card belongs to an earlier turn and is archived. / 这张卡片属于之前的对话，已存档。',
  settled: 'This card was already handled. / 这张卡片已处理。',
};

/** Apply one card action, answer or close; the card shows its result while the work finishes. */
function act(ctx, { agent, commandId, rawInput, signal }, store, enabled) {
  if (!enabled()) return { kind: 'error', text: 'Conversation cards are turned off. / 对话卡片已关闭。' };
  const session = agent?.session;
  if (!session) return { kind: 'error', text: NO_SESSION };
  const request = parseCommand(rawInput);
  if (request === undefined) return { kind: 'error', text: 'Invalid card action. / 无效的卡片操作。' };
  const state = store.read(session);
  const version = state.versions.find(row => row.id === request.id && row.rev === request.rev);
  const archived = archivedReason(state, version);
  if (archived !== undefined) {
    if (archived === 'settled' && version.phase === STOPPING) return { kind: 'error', text: 'The action is still running. / 卡片操作仍在进行。' };
    return { kind: 'error', text: ARCHIVED[archived] };
  }
  if (request.action === 'dismiss') {
    store.append(session, records.dismiss(version));
    return { kind: 'success', text: 'Card closed. / 卡片已关闭。' };
  }
  if (request.action === 'answer') {
    if (version.kind !== QUESTION_KIND) return { kind: 'error', text: 'Not a question card. / 这不是提问卡片。' };
    const checked = readAnswers(version, request.answers);
    if (checked.error !== undefined) return { kind: 'error', text: checked.error };
    store.append(session, records.phase(version, ANSWERED, { answers: checked.answers, at: Date.now() }));
    return deliverOr(ctx, agent, answerView(version, checked.answers), receipt(request, 'answer'), 'Answer recorded. / 已记录回答。');
  }
  const action = (version.actions ?? []).find(row => row.id === request.key);
  if (action === undefined) return { kind: 'error', text: 'Unknown card button. / 未知的卡片按钮。' };
  const checked = readValues(version, request.values);
  if (checked.error !== undefined) return { kind: 'error', text: checked.error };
  const command = action.run?.command === undefined ? undefined : fillPlaceholders(action.run.command, checked.values);
  if (command?.missing !== undefined) return { kind: 'error', text: 'Missing: ' + command.missing.join(', ') + ' / 请先填写：' + command.missing.join('、') };
  const values = Object.keys(checked.values).length > 0 ? { values: checked.values } : {};
  const settled = { action: action.id, ...action.label ? { label: action.label } : {}, ...values, at: Date.now() };
  // A reply-only button records the choice; the client sends it to the model.
  if (action.run === undefined) {
    store.append(session, records.phase(version, action.keep ? OPEN : STOPPED, settled));
    if (!action.reply) return { kind: 'success', text: 'Choice recorded. / 已记录选择。' };
    return deliverOr(ctx, agent, replyView(version, action, checked.values), receipt(request, 'choice'), 'Choice recorded. / 已记录选择。');
  }
  store.append(session, records.phase(version, STOPPING, settled));
  return runAction(ctx, { agent, commandId, signal, codedReceipt: request.codedReceipt }, version, action, command?.text, settled, store);
}

/** Hand the model's view to the agent; when that is impossible, the client sends its text reply. */
async function deliverOr(ctx, agent, view, delivered, fallback) {
  try {
    if (await deliver(agent, view)) return { kind: 'success', text: delivered };
  } catch (error) {
    ctx.logger.warn('Deep PTC: card message not delivered (%s)', error.message);
  }
  return { kind: 'success', text: fallback };
}

function parseCommand(rawInput) {
  let request;
  try { request = JSON.parse(String(rawInput ?? '')); } catch { return undefined; }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return undefined;
  const id = typeof request.id === 'string' ? request.id : '';
  if (id === '' || id.length > MAX_ID) return undefined;
  // 2.0.0 clients sent `revision`; the card's version number is the same counter.
  const rev = Number.isSafeInteger(request.rev) ? request.rev : Number.isSafeInteger(request.revision) ? request.revision : undefined;
  if (rev === undefined) return undefined;
  if (request.action === 'dismiss') return { id, rev, action: 'dismiss' };
  if (request.action === 'answer') return { id, rev, codedReceipt: request.codedReceipt === true, action: 'answer', answers: request.answers };
  if (request.action !== 'act' || typeof request.key !== 'string' || request.key === '') return undefined;
  return { id, rev, codedReceipt: request.codedReceipt === true, action: 'act', key: request.key.slice(0, 24), values: request.values };
}

/** Run the command under host policy before applying any accompanying schedule changes. */
async function runAction(ctx, invocation, version, action, command, settled, store) {
  const session = invocation.agent.session;
  const result = { ...settled, schedules: [] };
  const errors = [];
  if (command !== undefined) {
    try {
      Object.assign(result, await runCardCommand(ctx, { ...invocation, command, description: action.label ?? version.title }));
    } catch (error) {
      result.command = 'failed';
      errors.push('command: ' + reason(error));
      ctx.logger.warn('Deep PTC: card command failed (%s)', error.message);
    }
  }
  const schedule = action.run.schedules === undefined ? undefined : ctx.get('schedule');
  for (const id of errors.length === 0 ? action.run.schedules ?? [] : []) {
    if (invocation.signal?.aborted) { errors.push('Action cancelled / 操作已取消'); break; }
    if (schedule === undefined) {
      errors.push('schedule service unavailable');
      break;
    }
    try {
      await schedule.edit({ id, action: 'delete' }, session.id);
      result.schedules.push(id);
    } catch (error) {
      errors.push('schedule ' + id + ': ' + reason(error));
      ctx.logger.warn('Deep PTC: could not delete schedule %s (%s)', id, error.message);
    }
  }
  if (errors.length > 0) result.errors = errors;
  const phase = action.keep ? OPEN : errors.length > 0 ? FAILED : STOPPED;
  // Only settle the version this action started on; a newer version owns the card now.
  const current = store.read(session).versions.find(row => row.id === version.id && row.rev === version.rev);
  if (current?.phase === STOPPING) await store.append(session, records.phase(version, phase, result));
  if (action.reply) {
    const view = replyView(version, action, settled.values ?? {});
    const outcome = errors.length > 0 ? `failed: ${errors.join(' · ')}` : result.jobId ? `running as background job ${result.jobId}` : 'done';
    view.text += `\noutcome = ${outcome}`;
    let sent = false;
    try { sent = await deliver(invocation.agent, view); } catch (error) { ctx.logger.warn('Deep PTC: card reply not delivered (%s)', error.message); }
    if (sent && errors.length === 0) return { kind: 'success', text: receipt(invocation, 'action') };
  }
  return errors.length > 0 ? { kind: 'error', text: errors.join(' · ') }
    : { kind: 'success', text: result.jobId ? `Background job / 后台任务: ${result.jobId}` : 'Card action completed. / 卡片操作已完成。' };
}

function reason(error) {
  return String(error?.message ?? error).trim().slice(0, MAX_REASON);
}
