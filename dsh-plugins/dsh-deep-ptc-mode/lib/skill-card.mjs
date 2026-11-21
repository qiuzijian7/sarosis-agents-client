// Pure state and view logic for the skill context card.
//
// The card shows only skills whose instructions are still loaded in the model-visible
// context. A user can release a skill before the next turn; the runtime then replaces
// that skill's tool result with a short marker. The durable session log is untouched.

export const SKILL_CARD_KEY = 'deepPtcSkills';
export const SKILL_STATE_EVENT = 'plugin:dsh-deep-ptc-mode/skill-state';
export const SKILL_COMMAND = 'deep-ptc-skill-state';
export const SKILL_DISABLED_MARK = '[deep-ptc-skill-disabled]';

const MAX_SKILLS = 64;
const MAX_SEQUENCES = 32;
const MAX_NAME = 128;
const MAX_DESCRIPTION = 500;
const SKILL_NAME = /<skill_content\s+name="([A-Za-z0-9._-]+)"/u;
const CATALOG_BLOCK = /<available_skills>([\s\S]*?)<\/available_skills>/u;
const CATALOG_LINE = /^\s*-\s+`([^`]+)`:\s*(.*)$/u;

const objects = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, max = MAX_DESCRIPTION) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Text blocks from a stored tool result or user message. */
function messageText(data) {
  const content = Array.isArray(data?.content) ? data.content : data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block?.type === 'text' ? text(block.text, Number.MAX_SAFE_INTEGER) : '').join('\n');
}

/** Skill name carried by the official <skill_content> result. */
export function skillNameOfResult(value) {
  return SKILL_NAME.exec(String(value ?? ''))?.[1] ?? '';
}

/** Name-to-description pairs from the persisted skill catalog. */
export function catalogDescriptions(value) {
  const block = CATALOG_BLOCK.exec(String(value ?? ''))?.[1];
  if (!block) return {};
  const descriptions = {};
  for (const line of block.split('\n')) {
    const match = CATALOG_LINE.exec(line);
    if (!match) continue;
    const name = text(match[1], MAX_NAME);
    if (name) descriptions[name] = text(match[2]);
  }
  return descriptions;
}

export function blankSkillState(header) {
  // Start from the header; a later blank-session selection is folded before skill events.
  // The root projection passes an empty header when no header is available.
  const active = header === undefined ? true : header.agentPreset === 'deep-ptc';
  return { v: 1, active, turn: 0, phase: 'idle', skills: [], committed: null, descriptions: {} };
}

function sequences(value) {
  if (!Array.isArray(value) || value.length > MAX_SEQUENCES) throw new Error('Invalid skill result list');
  const seen = new Set();
  for (const seq of value) {
    if (!Number.isSafeInteger(seq) || seq <= 0 || seen.has(seq)) throw new Error('Invalid skill result sequence');
    seen.add(seq);
  }
  return [...seen];
}

/** Validate and normalize one durable skill-card state. */
export function parseSkillState(value) {
  if (!objects(value) || value.v !== 1 || !Number.isSafeInteger(value.turn) || value.turn < 0
    || (value.phase !== 'idle' && value.phase !== 'running') || !Array.isArray(value.skills)
    || value.skills.length > MAX_SKILLS) throw new Error('Invalid Deep PTC skill state');
  const skills = value.skills.map(row => {
    if (!objects(row) || typeof row.name !== 'string' || row.name.length === 0 || row.name.length > MAX_NAME
      || typeof row.description !== 'string' || row.description.length > MAX_DESCRIPTION
      || typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.loadedTurn) || row.loadedTurn < 0) {
      throw new Error('Invalid Deep PTC skill row');
    }
    const source = row.source === 'ptc' ? 'ptc' : 'tool';
    return { name: row.name, description: text(row.description), enabled: row.enabled,
      loadedTurn: row.loadedTurn, source, callId: text(row.callId, 128), seqs: sequences(row.seqs) };
  });
  const names = new Set(skills.map(row => row.name));
  if (names.size !== skills.length) throw new Error('Duplicate Deep PTC skill name');
  const committed = value.committed === null ? null : objects(value.committed) ? Object.fromEntries(
    Object.entries(value.committed).filter(([name, enabled]) => names.has(name) && typeof enabled === 'boolean')) : null;
  const descriptions = objects(value.descriptions) ? Object.fromEntries(
    Object.entries(value.descriptions).filter(([name, description]) => typeof name === 'string' && name.length <= MAX_NAME && typeof description === 'string')
      .map(([name, description]) => [name, text(description)])) : {};
  return { v: 1, active: value.active !== false, turn: value.turn, phase: value.phase, skills, committed, descriptions };
}

function withDescription(state, name) {
  return state.descriptions[name] ?? state.skills.find(row => row.name === name)?.description ?? '';
}

/** Fold one session event into the card state. */
export function foldSkillState(state, event) {
  if (event.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
    const active = event.data.agentPreset === 'deep-ptc';
    return active === state.active ? state : blankSkillState({ agentPreset: event.data.agentPreset });
  }
  if (state.active === false) return state;
  if (event.type === SKILL_STATE_EVENT) {
    try { return parseSkillState(event.data); } catch { return state; }
  }
  if (event.type === 'turn/start') {
    const turn = event.data?.turn;
    if (!Number.isSafeInteger(turn) || turn < 0) return state;
    return { ...state, turn, phase: 'running',
      committed: Object.fromEntries(state.skills.map(row => [row.name, row.enabled])) };
  }
  if (event.type === 'turn/end') {
    const turn = event.data?.turn;
    if (!Number.isSafeInteger(turn) || turn < 0) return state;
    return { ...state, turn, phase: 'idle', committed: null };
  }
  if (event.type === 'user/message') {
    const found = catalogDescriptions(messageText(event.data));
    if (Object.keys(found).length === 0) return state;
    const descriptions = { ...state.descriptions, ...found };
    return { ...state, descriptions,
      skills: state.skills.map(row => found[row.name] === undefined ? row : { ...row, description: found[row.name] }) };
  }
  if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return state;
  if (event.type === 'tool/ptc-dispatch' && event.data?.name !== 'skill') return state;
  const body = messageText(event.data);
  if (!body) return state;
  const trimmed = body.trimStart();
  const seq = event.seq;
  if (event.type === 'tool/result') {
    if (!Number.isSafeInteger(seq) || seq <= 0) return state;
    if (trimmed.startsWith(SKILL_DISABLED_MARK)) {
      const callId = typeof event.data?.callId === 'string' ? event.data.callId : '';
      const removed = new Set();
      for (const row of state.skills) if (callId !== '' && row.callId === callId) for (const value of row.seqs) removed.add(value);
      return removeResults(state, removed);
    }
    // Only the skill tool's own result starts with the wrapper. A read of docs that
    // merely quotes the template must not become a card row.
    if (!trimmed.startsWith('<skill_content')) return state;
  }
  const name = skillNameOfResult(trimmed);
  if (!name) return state;
  const source = event.type === 'tool/result' ? 'tool' : 'ptc';
  const existing = state.skills.find(row => row.name === name);
  if (existing !== undefined) {
    return { ...state, skills: state.skills.map(row => row.name !== name ? row : {
      ...row, description: withDescription(state, name), enabled: true, loadedTurn: state.turn, source,
      callId: typeof event.data?.callId === 'string' ? event.data.callId : row.callId,
      seqs: source === 'tool' ? [...new Set([...row.seqs, seq])].slice(-MAX_SEQUENCES) : row.seqs,
    }) };
  }
  return { ...state, skills: [...state.skills, {
    name, description: withDescription(state, name), enabled: true, loadedTurn: state.turn, source,
    callId: typeof event.data?.callId === 'string' ? event.data.callId : '',
    seqs: source === 'tool' ? [seq] : [],
  }] };
}

/** Remove successful (or compacted) result sequences from the active set. */
export function removeResults(state, removed) {
  if (!(removed instanceof Set) || removed.size === 0) return state;
  const skills = state.skills.map(row => ({ ...row, seqs: row.seqs.filter(seq => !removed.has(seq)) }))
    .filter(row => row.seqs.length > 0);
  return { ...state, skills };
}

/** Rows the next pre-step must release before the model request. */
export function skillsToUnload(state) {
  if (state.committed === null) return [];
  return state.skills.filter(row => state.committed[row.name] === false);
}

/** Parse the JSON payload sent by the card command. */
export function parseSkillCommand(rawInput) {
  let request;
  try { request = JSON.parse(String(rawInput ?? '')); } catch { return undefined; }
  if (!objects(request)) return undefined;
  if (request.action === 'all' && typeof request.enabled === 'boolean') return { action: 'all', enabled: request.enabled };
  if (request.action === 'set' && typeof request.name === 'string' && request.name.length > 0
    && request.name.length <= MAX_NAME && typeof request.enabled === 'boolean') {
    return { action: 'set', name: request.name, enabled: request.enabled };
  }
  return undefined;
}

/** Apply a card command without side effects. */
export function applySkillCommand(state, rawInput) {
  const request = parseSkillCommand(rawInput);
  if (request === undefined) return undefined;
  if (request.action === 'all') return { ...state, skills: state.skills.map(row => ({ ...row, enabled: request.enabled })) };
  return { ...state, skills: state.skills.map(row => row.name === request.name ? { ...row, enabled: request.enabled } : row) };
}

/** The client receives only what the card needs. */
export function skillCardView(state) {
  return { v: 1, turn: state.turn, phase: state.phase,
    skills: state.skills.map(row => ({ name: row.name, description: row.description,
      enabled: row.enabled, loadedTurn: row.loadedTurn })) };
}

/** Validate the client wire view. */
export function parseSkillCardView(value) {
  if (!objects(value) || value.v !== 1 || !Number.isSafeInteger(value.turn) || value.turn < 0
    || (value.phase !== 'idle' && value.phase !== 'running') || !Array.isArray(value.skills)
    || value.skills.length > MAX_SKILLS) throw new Error('Invalid Deep PTC skill card view');
  return { v: 1, turn: value.turn, phase: value.phase, skills: value.skills.map(row => ({
    name: text(row?.name, MAX_NAME), description: text(row?.description), enabled: row?.enabled === true,
    loadedTurn: Number.isSafeInteger(row?.loadedTurn) ? row.loadedTurn : 0,
  })) };
}

/** Replacement data preserves every tool-result field except its rendered content. */
export function replacementData(event, name) {
  const data = structuredClone(event.data);
  data.message = { ...data.message, content: [{ type: 'text',
    text: `${SKILL_DISABLED_MARK} Skill "${name}" was disabled by the user for this task. Load it again if needed.` }] };
  return data;
}
