// Conversation card state: an append-only record log folded into card versions.
//
// Each save appends one small record (a new version, a phase change, a close) instead of rewriting
// every card. The fold also follows `turn/start`, so every version knows the turn it was posted in:
// the chat draws each version at the end of its own turn, and history reads back exactly as it was.
//
// Rules the fold and the view agree on:
//   - showing a card again (same id) adds a new version; earlier versions stay where they were;
//   - only the newest version of a card, posted in the current turn and still open, takes actions;
//   - everything else is an archive: read-only, showing what was shown and what was chosen.
//
// Records from 1.9.7–2.0.0 carried the whole card list ({ v: 1, cards }); they still fold.

import { objects } from './card-blocks.mjs';
import { QUESTION_KIND, readQuestionInput, storedAnswers } from './card-questions.mjs';
import { readCardInput, readResult, PHASES, OPEN, DISMISSED, MAX_ID } from './cards.mjs';

export const CARDS_EVENT = 'plugin:dsh-deep-ptc-mode/cards';
export const STATE_VERSION = 2;
// Cards themselves are unlimited: only superseded versions are trimmed, the newest version of every
// card stays. The cap bounds the history of old versions, not how many cards a conversation has.
export const MAX_VERSIONS = 2000;

export function blankCards() {
  return { v: STATE_VERSION, seq: 0, turn: 0, versions: [] };
}

/** A card or question body, re-read with the input rules (so stored and new bodies agree). */
export function readBody(value) {
  return objects(value) && value.kind === QUESTION_KIND ? readQuestionInput(value) : readCardInput(value);
}

// ---- Records ----------------------------------------------------------------------------------
// The tool and command build records; only the fold interprets them.
export const records = {
  show: (state, id, body) => ({ v: STATE_VERSION, op: 'show', id, rev: state.seq + 1, turn: state.turn, body }),
  phase: (version, phase, result) => ({ v: STATE_VERSION, op: 'phase', id: version.id, rev: version.rev, phase, ...result ? { result } : {} }),
  dismiss: version => ({ v: STATE_VERSION, op: 'dismiss', id: version.id, rev: version.rev }),
};

const validId = id => typeof id === 'string' && id !== '' && id.length <= MAX_ID;

function trim(versions) {
  if (versions.length <= MAX_VERSIONS) return versions;
  const newest = new Map(versions.map(version => [version.id, version.rev]));
  const drop = new Set();
  for (const version of versions) {
    if (versions.length - drop.size <= MAX_VERSIONS) break;
    if (newest.get(version.id) !== version.rev) drop.add(version);
  }
  return versions.filter(version => !drop.has(version));
}

function withResult(version, value) {
  const result = version.kind === QUESTION_KIND
    ? (() => { const answers = storedAnswers(version, value?.answers); return answers ? { answers, ...typeof value?.at === 'number' ? { at: value.at } : {} } : undefined; })()
    : readResult(value);
  const { result: _old, ...rest } = version;
  return result === undefined ? rest : { ...rest, result };
}

function show(state, record) {
  if (!validId(record.id) || !Number.isSafeInteger(record.rev) || record.rev <= state.seq) return state;
  const { card, issues } = readBody(record.body);
  if (issues !== undefined) return state;
  const turn = Number.isSafeInteger(record.turn) && record.turn >= 0 ? record.turn : state.turn;
  const version = { id: record.id, rev: record.rev, turn, ...card, phase: OPEN };
  return { ...state, seq: record.rev, versions: trim([...state.versions, version]) };
}

function patch(state, record, change) {
  const index = state.versions.findIndex(version => version.id === record.id && version.rev === record.rev);
  if (index < 0) return state;
  const versions = state.versions.slice();
  versions[index] = change(versions[index]);
  return { ...state, versions };
}

// A 1.9.7–2.0.0 snapshot: every listed card is current; a card missing from it was closed.
function legacy(state, snapshot) {
  if (!Array.isArray(snapshot.cards)) return state;
  let { seq, versions } = state;
  const listed = new Set();
  for (const row of snapshot.cards) {
    if (!objects(row) || !validId(row.id)) continue;
    const { card, issues } = readCardInput(row);
    if (issues !== undefined) continue;
    listed.add(row.id);
    const phase = PHASES.includes(row.phase) ? row.phase : OPEN;
    const known = versions.findLast(version => version.id === row.id && version.legacyRevision === (row.revision ?? 0));
    if (known) {
      versions = versions.map(version => version === known ? withResult({ ...known, phase }, row.result) : version);
      continue;
    }
    seq += 1;
    versions = [...versions, withResult({ id: row.id, rev: seq, turn: state.turn, ...card, phase, legacyRevision: row.revision ?? 0 }, row.result)];
  }
  versions = versions.map(version => version.legacyRevision !== undefined && !listed.has(version.id) && version.phase !== DISMISSED
    && versions.findLast(other => other.id === version.id) === version ? { ...version, phase: DISMISSED } : version);
  return { ...state, seq, versions: trim(versions) };
}

/** Fold one session event: turn starts move the current turn, card records change versions. */
export function foldCardsState(state, event) {
  if (event.type === 'turn/start') {
    const turn = event.data?.turn;
    return Number.isSafeInteger(turn) && turn > state.turn ? { ...state, turn } : state;
  }
  // The chat draws a turn's tail only once the turn ends, so the client docks the cards of a running
  // turn above the composer until then.
  if (event.type === 'turn/end') {
    const turn = event.data?.turn;
    return Number.isSafeInteger(turn) && turn >= state.turn ? { ...state, ended: turn } : state;
  }
  if (event.type !== CARDS_EVENT || !objects(event.data)) return state;
  const record = event.data;
  try {
    if (record.v === 1) return legacy(state, record);
    if (record.v !== STATE_VERSION) return state;
    if (record.op === 'show') return show(state, record);
    if (record.op === 'phase' && PHASES.includes(record.phase)) return patch(state, record, version => withResult({ ...version, phase: record.phase }, record.result));
    if (record.op === 'dismiss') return patch(state, record, version => ({ ...version, phase: DISMISSED }));
  } catch { /* a malformed record changes nothing */ }
  return state;
}

/** Validate a projected state (the host persists and replays it). */
export function parseCardsState(value) {
  if (!objects(value) || value.v !== STATE_VERSION || !Number.isSafeInteger(value.seq) || !Number.isSafeInteger(value.turn)
    || !Array.isArray(value.versions)) throw new Error('Invalid Deep PTC card state');
  return value;
}

// ---- Views ------------------------------------------------------------------------------------

/** The newest version of every card, by id. */
export function latestVersions(state) {
  const latest = new Map();
  for (const version of state.versions) {
    const known = latest.get(version.id);
    if (!known || version.rev > known.rev) latest.set(version.id, version);
  }
  return latest;
}

export const latestOf = (state, id) => latestVersions(state).get(id);

/**
 * Why a version cannot take an action now, or undefined when it can. Only the newest version of a
 * card, posted in the current turn and still open, is interactive.
 */
export function archivedReason(state, version) {
  if (version === undefined) return 'unknown';
  if (latestOf(state, version.id)?.rev !== version.rev) return 'superseded';
  if (version.phase === DISMISSED) return 'dismissed';
  if (version.turn !== state.turn) return 'earlier-turn';
  if (version.phase !== OPEN) return 'settled';
  return undefined;
}

/**
 * What the tools return: the model's view of the live cards. Presentation (size, tone, icon) stays
 * out; every field is always present, so run_code results stay lossless JSON.
 */
export function cardsDigest(state) {
  return [...latestVersions(state).values()].filter(version => version.phase !== DISMISSED).map(version => ({
    id: version.id, rev: version.rev, turn: version.turn, kind: version.kind ?? 'card', title: version.title, phase: version.phase,
    interactive: archivedReason(state, version) === undefined,
  }));
}
