// Question cards: Deep PTC's replacement for the host's blocking question box.
//
// The model posts a question card and carries on (or ends its turn); the user answers on the card,
// and the answer reaches the model as an ordinary message. Answered and unanswered question cards
// stay in the conversation, so the user can always read back what was asked and what they chose.
//
// Free-text answers only ever travel to the model as message text: no command, schedule or other
// host action can read them, so they need no shell-safe grammar.

import { objects, text } from './card-blocks.mjs';

export const QUESTION_KIND = 'question';
export const QUESTION_TYPES = ['single', 'multi', 'text'];
export const MAX_QUESTIONS = 5;
export const MAX_ANSWER = 1000;
const MAX_TITLE = 120;
const MAX_SUBTITLE = 200;
const MAX_PROMPT = 300;
const MAX_OPTIONS = 8;
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9_]{0,23}$/u;
const OPTION_VALUE = /^[A-Za-z0-9_.:@/+=-]{1,60}$/u;

function readOptions(value, path, issues) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_OPTIONS) {
    issues.push(`${path}.options: use 2-${MAX_OPTIONS} options`);
    return [];
  }
  const options = [];
  value.forEach((entry, index) => {
    const at = `${path}.options.${index}`;
    const label = text(objects(entry) ? entry.label : entry, 80);
    const raw = objects(entry) ? entry.value : undefined;
    const optionValue = raw === undefined ? `o${index + 1}` : text(raw, 60);
    if (label === '') { issues.push(`${at}: label required`); return; }
    if (!OPTION_VALUE.test(optionValue)) { issues.push(`${at}.value: use letters, digits or _ . : @ / + = -`); return; }
    const hint = text(objects(entry) ? entry.hint : undefined, 120);
    options.push({ value: optionValue, label, ...hint ? { hint } : {} });
  });
  if (new Set(options.map(option => option.value)).size !== options.length) issues.push(`${path}.options: values must be unique`);
  return options;
}

function readQuestion(value, index, issues) {
  const path = `questions.${index}`;
  if (!objects(value)) { issues.push(`${path}: expected an object`); return undefined; }
  const id = value.id === undefined ? `q${index + 1}` : text(value.id, 24);
  if (!QUESTION_ID.test(id)) issues.push(`${path}.id: use a letter then letters, digits or _`);
  const prompt = text(value.prompt, MAX_PROMPT);
  if (prompt === '') issues.push(`${path}.prompt: required`);
  const type = value.type === undefined ? (value.options === undefined ? 'text' : 'single') : value.type;
  if (!QUESTION_TYPES.includes(type)) { issues.push(`${path}.type: use single, multi or text`); return undefined; }
  const question = { id, prompt, type };
  if (type === 'text') {
    if (value.options !== undefined) issues.push(`${path}.options: a text question has no options`);
    const placeholder = text(value.placeholder, 80);
    if (placeholder) question.placeholder = placeholder;
  } else {
    question.options = readOptions(value.options, path, issues);
    // The recommended answer is preselected; the user still confirms it.
    const wanted = value.recommended === undefined ? [] : Array.isArray(value.recommended) ? value.recommended : [value.recommended];
    const picked = wanted.map(item => text(item, 60)).filter(item => question.options.some(option => option.value === item));
    if (wanted.length !== picked.length) issues.push(`${path}.recommended: use option values`);
    else if (type === 'single' && picked.length > 1) issues.push(`${path}.recommended: a single choice has one recommendation`);
    else if (picked.length > 0) question.recommended = type === 'single' ? picked[0] : picked;
  }
  if (value.optional === true) question.optional = true;
  return question;
}

/** Normalise a question card body, or list what the model must fix. Reading it twice changes nothing. */
export function readQuestionInput(value) {
  if (!objects(value)) return { issues: ['expected an object'] };
  const issues = [];
  const card = { kind: QUESTION_KIND, title: text(value.title, MAX_TITLE) };
  if (card.title === '') issues.push('title: required (the decision being asked, e.g. 选择部署方案)');
  const subtitle = text(value.subtitle, MAX_SUBTITLE);
  if (subtitle) card.subtitle = subtitle;
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > MAX_QUESTIONS) {
    issues.push(`questions: ask 1-${MAX_QUESTIONS} questions`);
  } else {
    card.questions = value.questions.map((entry, index) => readQuestion(entry, index, issues)).filter(Boolean);
    if (new Set(card.questions.map(question => question.id)).size !== card.questions.length) issues.push('questions: ids must be unique');
  }
  return issues.length > 0 ? { issues } : { card };
}

/**
 * Check the user's answers against the card. Required questions need an answer; choices must be
 * one of the card's options; free text is trimmed and bounded.
 * @returns `{ answers }` (question id → string or string list) or `{ error }`.
 */
export function readAnswers(card, raw) {
  const given = objects(raw) ? raw : {};
  const answers = {};
  for (const question of card.questions ?? []) {
    const value = given[question.id];
    if (question.type === 'text') {
      const answer = typeof value === 'string' ? value.trim().slice(0, MAX_ANSWER) : '';
      if (answer !== '') answers[question.id] = answer;
    } else {
      const picked = (Array.isArray(value) ? value : value === undefined || value === '' ? [] : [value]).filter(item => typeof item === 'string');
      if (picked.some(item => !question.options.some(option => option.value === item))) return { error: `${question.prompt}: not one of the options` };
      if (question.type === 'single' && picked.length > 1) return { error: `${question.prompt}: choose one` };
      if (picked.length > 0) answers[question.id] = question.type === 'single' ? picked[0] : [...new Set(picked)];
    }
    if (answers[question.id] === undefined && question.optional !== true) return { error: `${question.prompt}: needs an answer` };
  }
  return { answers };
}

/** Stored answers re-read for the projection: only known questions, only string values. */
export function storedAnswers(card, value) {
  if (!objects(value)) return undefined;
  const answers = {};
  for (const question of card.questions ?? []) {
    const answer = value[question.id];
    if (typeof answer === 'string') answers[question.id] = answer.slice(0, MAX_ANSWER);
    else if (Array.isArray(answer)) answers[question.id] = answer.filter(item => typeof item === 'string');
  }
  return answers;
}

/** The message an answer sends to the model: every question with the user's answer, in order. */
export function answerMessage(card, answers, labels = { skipped: '（未回答）' }) {
  const lines = (card.questions ?? []).map((question, index) => {
    const answer = answers[question.id];
    const shown = answer === undefined ? labels.skipped
      : question.type === 'text' ? answer
        : (Array.isArray(answer) ? answer : [answer]).map(value => question.options.find(option => option.value === value)?.label ?? value).join('、');
    return `${index + 1}. ${question.prompt}\n   → ${shown}`;
  });
  return `【回答 · ${card.title}】\n${lines.join('\n')}`;
}
