// Local metadata search only: no model calls, filesystem probing or skill-body reads.
export const DIRECTORY_TOOL = 'deep_ptc_tools';
export const RESET_COMMAND = 'deep-ptc-reset-tools';
export const STATE_EVENT = 'plugin:dsh-deep-ptc-mode/tool-state';
export const STATE_KEY = 'deepPtcTools';

const indexed = new WeakMap();

export function summary(definition) {
  let row = indexed.get(definition);
  if (!row) {
    const name = String(definition.name);
    const description = String(definition.description ?? '').slice(0, 240);
    row = { name, description, text: `${name} ${description}`.toLowerCase() };
    indexed.set(definition, row);
  }
  return row;
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function searchCatalog(definitions, query = '', offset = 0, limit = 6) {
  const terms = String(query).slice(0, 512).toLowerCase().trim().split(/[\s,，]+/u).filter(Boolean).slice(0, 12);
  // A term in the name outweighs any number of terms in the description.
  const scoreOf = row => terms.reduce(
    (sum, word) => sum + (row.name.toLowerCase().includes(word) ? 8 : row.text.includes(word) ? 1 : 0), 0);
  const ranked = definitions
    .map(definition => {
      const row = summary(definition);
      return { row, score: scoreOf(row) };
    })
    .filter(entry => terms.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || byName(a.row.name, b.row.name));
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const count = Math.max(1, Math.min(8, Number.isSafeInteger(limit) ? limit : 6));
  return {
    total: ranked.length,
    results: ranked.slice(start, start + count).map(({ row }) => ({ name: row.name, description: row.description })),
    nextOffset: start + count < ranked.length ? start + count : null,
  };
}

export function toolSchema(def) {
  return { name: def.name, description: def.description ?? '', parameters: def.parameters, output: def.output?.schema ?? {} };
}

export function blankState() {
  return { v: 1, epoch: 0, blocked: [], report: null };
}

function validBlocked(row) {
  return !!row && typeof row.name === 'string' && row.name.length <= 256
    && typeof row.provider === 'string' && typeof row.kind === 'string';
}

export function parseState(value) {
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || !Array.isArray(value.blocked))
    throw new Error('Invalid Deep PTC tool state');
  if (!value.blocked.every(validBlocked)) throw new Error('Invalid blocked tool');
  return {
    v: 1,
    epoch: value.epoch,
    blocked: value.blocked.map(({ name, provider, kind }) => ({ name, provider, kind })),
    report: value.report ?? null,
  };
}

export function foldToolState(state, event) {
  if (event.type === STATE_EVENT && event.ignorable === true) {
    try {
      return parseState(event.data);
    } catch {
      return state;
    }
  }
  if (event.type === 'turn/end' && state.blocked.length)
    return { ...state, report: { turn: event.data.turn, tools: state.blocked } };
  return state;
}
