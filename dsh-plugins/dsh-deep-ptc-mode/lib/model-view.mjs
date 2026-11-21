// The model's view of a card.
//
// A card has two faces. The user's face is the rendered card. The model's face is this module:
// what a card contributes to the model's context, written for precise reading rather than looks.
//   - every element is addressable: card id, question id, option value, item id;
//   - a value travels with the words the user saw: `plan = vps «VPS 自建»`;
//   - presentation (icons, tones, sizes, layout) never reaches the model;
//   - each block says in one line what the model should do with it.
// Scaffolding is English; content stays in the user's language.
//
// Answers and button replies reach the model as one structured message with a short notice summary
// for the chat, delivered by the server, so the chat bubble does not repeat what the card shows.

import { randomUUID } from 'node:crypto';
import { importHost } from './host.mjs';

export const CARD_SOURCE = 'deep-ptc-card';
export const PROJECT_SOURCE = 'deep-ptc-project';
const MAX_SUMMARY = 120;

// ---- Command result codes ---------------------------------------------------------------------
// Host commands answer with `{ kind, text }`. A text the client acts on starts with a stable code,
// `[dpt:<code>] <human text>`, so the client never depends on the wording of the human text.
export const CODE = /^\[dpt:([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)\] ?/u;
export const coded = (code, text = '') => `[dpt:${code}] ${text}`.trimEnd();
export const codeOf = text => CODE.exec(typeof text === 'string' ? text : '')?.[1];
export const NO_SESSION = coded('no-session', 'No active conversation. / 当前没有活动对话。');
export const WRONG_MODE = coded('wrong-mode', 'This command is available in Deep PTC sessions only. / 该功能仅在深度 PTC 会话中可用。');

/** Quote user-facing text so its edges are unambiguous. */
export const quote = value => `«${String(value ?? '').replace(/\s+/gu, ' ').trim()}»`;

const summaryOf = text => text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;

function choice(options, value) {
  const label = options?.find(option => option.value === value)?.label;
  return label === undefined || label === value ? value : `${value} ${quote(label)}`;
}

function picked(options, value) {
  const list = Array.isArray(value) ? value : [value];
  const values = list.join(', ');
  const labels = list.map(item => options?.find(option => option.value === item)?.label ?? item).map(quote).join(', ');
  return Array.isArray(value) ? `[${values}] ${labels}` : choice(options, value);
}

/**
 * The model's view of a question card's answers.
 * @returns `{ text, summary }`: the message text and the one-line chat summary.
 */
export function answerView(card, answers) {
  const lines = [`[Card answer: ${card.id} ${quote(card.title)}]`];
  for (const question of card.questions ?? []) {
    const answer = answers?.[question.id];
    const shown = answer === undefined || answer === '' || (Array.isArray(answer) && answer.length === 0) ? '(skipped)'
      : question.type === 'text' ? quote(answer) : picked(question.options, answer);
    lines.push(`${question.id} = ${shown}    # ${question.prompt}`);
  }
  lines.push('These answers settle the card. Continue the work that waited on them; do not ask them again.');
  return { text: lines.join('\n'), summary: summaryOf(`回答 · ${card.title}`) };
}

/**
 * The model's view of a pressed button that replies to the model.
 * A string template is the model's own wording: it is filled and passed through under the header.
 */
export function replyView(card, action, values = {}) {
  const head = `[Card button: ${card.id} rev ${card.rev} ${quote(card.title)} → ${action.id} ${quote(action.label ?? action.id)}]`;
  const lines = [head];
  if (typeof action.reply === 'string') {
    lines.push(action.reply.replace(/\{([A-Za-z][A-Za-z0-9_]{0,23})\}/gu, (whole, name) => {
      const value = values[name];
      return value === undefined || value === '' ? whole : Array.isArray(value) ? value.join(', ') : String(value);
    }));
  }
  for (const block of card.blocks ?? []) {
    if ((block?.type !== 'choice' && block?.type !== 'field') || values[block.name] === undefined || values[block.name] === '') continue;
    const value = values[block.name];
    const label = block.label ? `    # ${block.label}` : '';
    lines.push(`${block.name} = ${block.type === 'choice' ? picked(block.options, value) : quote(value)}${label}`);
  }
  return { text: lines.join('\n'), summary: summaryOf(`${card.title} · ${action.label ?? action.id}`) };
}

// ---- Project cards ----------------------------------------------------------------------------
// The user's edits in the Project cards view. The cards themselves are in the Project cards
// snapshot, so a notice names what changed by id and says what to do; it never repeats the cards.

const cardRef = card => `${card.kind === 'setting' ? 'setting card' : `${card.kind} card`} ${card.id} ${quote(card.title)}`;
const changes = text => text && text !== '=' ? `: ${text}` : '';

/**
 * The model's view of one edit the user made to the project cards.
 * @param event - `{ op, card, rev, change, proposal, item, question, fromRev }`.
 */
export function projectView(event) {
  const { op, card } = event;
  const lines = [];
  let summary;
  switch (op) {
    case 'create':
      lines.push(`[Project cards: the user created ${cardRef(card)}, rev ${card.rev}${changes(event.change)}]`, 'Follow it from now on; the text is in the Project cards snapshot.');
      summary = `新建特点卡片 · ${card.title}`;
      break;
    case 'submit':
      lines.push(`[Project cards: the user edited ${cardRef(card)} → rev ${card.rev}${changes(event.change)}]`, 'The new version replaces the old one; follow the Project cards snapshot.');
      summary = `修改特点卡片 · ${card.title}`;
      break;
    case 'delete':
      lines.push(`[Project cards: the user deleted ${cardRef(card)}]`, 'Its rules no longer apply.');
      summary = `删除特点卡片 · ${card.title}`;
      break;
    case 'rollback':
      lines.push(`[Project cards: the user rolled ${cardRef(card)} back to the content of rev ${event.fromRev}, now rev ${card.rev}${changes(event.change)}]`, 'Follow the Project cards snapshot.');
      summary = `回滚特点卡片 · ${card.title}`;
      break;
    case 'approve':
      lines.push(`[Project cards: the user approved proposal ${event.proposal} → ${cardRef(card)}, rev ${card.rev}${changes(event.change)}]`, 'It is in effect now; follow the Project cards snapshot.');
      summary = `批准提案 ${event.proposal} · ${card.title}`;
      break;
    case 'reject':
      lines.push(`[Project cards: the user rejected proposal ${event.proposal} for ${quote(event.title)}]`, 'It is not adopted; the card stays as in the Project cards snapshot. Do not re-propose it unchanged.');
      summary = `拒绝提案 ${event.proposal} · ${event.title}`;
      break;
    case 'question':
      lines.push(`[Project cards: the user questions ${event.item.id} in ${cardRef(card)}]`, `Record: ${quote(event.item.text)}`, `Question: ${quote(event.question)}`,
        'Check the record against the code or facts. Correct it with project_cards write if it is wrong, and tell the user what you found.');
      summary = `质疑 ${event.item.id} · ${card.title}`;
      break;
    default:
      throw new Error(`unknown project notice ${op}`);
  }
  return { text: lines.join('\n'), summary: summaryOf(summary) };
}

/** The user's requests from the Project cards view: guided setup, and polishing in chat. */
export function projectRequestView(kind, instruction = '') {
  if (kind === 'polish') return { text: `[Project cards: the user asks you to polish a draft]\n${instruction}`, summary: '请模型润色特点卡片' };
  const first = kind === 'guide-first';
  return {
    text: [first ? '[Project cards: the user asks you to guide setting up the project cards]' : '[Project cards: the user asks you to help refine the project cards]',
      first ? 'Read the current state with project_cards read and the workspace AGENTS.md / README. Then follow the active asking instructions to ask a few key questions together (stack, conventions, constraints, workflow).'
        : 'Check with project_cards read what is missing, vague or outdated. Follow the active asking instructions to ask what to add.',
      'Propose cards with project_cards propose; the user approves them in the Project cards view. Keep working on anything else the user asked meanwhile.'].join('\n'),
    summary: first ? '请模型引导建立特点卡片' : '请模型帮忙完善特点卡片',
  };
}

let createMessage;
async function messageFactory() {
  createMessage ??= importHost('@deepseek-ai/dsh-llm').then(module => module.createUserMessage)
    .catch(() => undefined);
  return createMessage;
}

/**
 * Deliver a model-view message to the agent: it enters the nearest step, or opens a turn when the
 * agent is idle. The chat shows it as a one-line notice.
 * @returns whether the message was handed to the agent; on false the caller falls back.
 */
export async function deliver(agent, { text, summary }, source = CARD_SOURCE) {
  if (typeof agent?.steer !== 'function') return false;
  const content = [{ type: 'text', text }];
  const origin = { kind: source, form: 'notice', summary };
  const create = await messageFactory();
  const message = typeof create === 'function' ? create({ content, source: origin })
    : { id: randomUUID(), role: 'user', content, source: origin };
  agent.steer(message);
  return true;
}
