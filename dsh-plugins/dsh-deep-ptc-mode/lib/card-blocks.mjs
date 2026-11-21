// Card blocks: the built-in layout vocabulary of a conversation card.
//
// A card is a header (title, subtitle, icon, tone) plus up to MAX_BLOCKS blocks. Each block type is
// declared once here: its reader normalises model input and also re-validates stored state, so the
// tool, the projection and the client agree on one shape. Readers are idempotent: reading a card
// they produced returns the same card, which is what lets state parsing reuse them.

export const MAX_BLOCKS = 6;
export const TONES = ['info', 'success', 'warn', 'danger'];
export const ITEM_TONES = ['neutral', 'success', 'warn', 'danger'];
export const ICONS = ['info', 'chart', 'clock', 'check', 'alert', 'task', 'server', 'spark', 'list', 'flow'];
export const STEP_STATES = ['done', 'active', 'todo', 'failed'];
export const TRENDS = ['up', 'down', 'flat'];

const LABEL = 40;
const VALUE = 300;
const SHORT = 80;
const TEXT = 600;
const UNIT = 12;

export const objects = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max)
  : typeof value === 'number' && Number.isFinite(value) ? String(value).slice(0, max) : '';

function number(value) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pick(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}

/** Copy only the defined optional fields, so a normalised value is pure JSON. */
function defined(entries) {
  const out = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined && value !== '') out[key] = value;
  return out;
}

// One list of items, bounded, each read by `item`; a bad item is an issue, not a silent drop.
function list(value, path, max, issues, item, min = 1) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    issues.push(`${path}: use ${min === max ? max : `${min}-${max}`} items`);
    return [];
  }
  const rows = [];
  value.forEach((entry, index) => {
    const row = item(entry, `${path}.${index}`);
    if (typeof row === 'string') issues.push(row);
    else rows.push(row);
  });
  return rows;
}

const labelled = (needsValue, extra = () => ({})) => (entry, path) => {
  if (!objects(entry)) return `${path}: expected an object`;
  const label = text(entry.label, LABEL);
  if (label === '') return `${path}: label required`;
  const more = extra(entry, path);
  if (typeof more === 'string') return more;
  const value = text(entry.value, VALUE);
  if (needsValue && value === '') return `${path}: value required`;
  return defined({ label, value, ...more });
};

const measured = (entry, path) => {
  if (!objects(entry)) return `${path}: expected an object`;
  const label = text(entry.label, LABEL);
  const value = number(entry.value);
  if (label === '') return `${path}: label required`;
  if (value === undefined || value < 0) return `${path}: value must be a number of zero or more`;
  return defined({ label, value, tone: pick(entry.tone, ITEM_TONES) });
};

// ---- Interactive inputs ----------------------------------------------------------------------
// An input's value can fill a `{name}` placeholder in an action's command. Only values from a closed
// grammar get there: times, dates, numbers and option values the card itself declared. Free text never
// reaches a shell.
export const FIELD_KINDS = ['time', 'date', 'number'];
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,23}$/u;
// Option values may land in a command, so they are shell-inert: no spaces, quotes or metacharacters.
const OPTION_VALUE = /^[A-Za-z0-9_.:@/+=][A-Za-z0-9_.:@/+=-]{0,59}$/u;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
export const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,23})\}/gu;

function inputName(value, path, issues) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!INPUT_NAME.test(name)) issues.push(`${path}.name: use a letter then letters, digits or _ (up to 24)`);
  return name;
}

/** A field value in canonical form, or undefined when it is not valid for that field. */
export function fieldValue(field, raw) {
  const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (field.kind === 'time') return TIME.test(value) ? value : undefined;
  if (field.kind === 'date') return DATE.test(value) ? value : undefined;
  if (field.kind === 'number') {
    const parsed = number(value);
    if (parsed === undefined || (field.min !== undefined && parsed < field.min) || (field.max !== undefined && parsed > field.max)) return undefined;
    return String(parsed);
  }
  return undefined;
}

/** The interactive inputs of a card, by name. */
export function cardInputs(card) {
  const inputs = new Map();
  for (const block of card.blocks ?? []) if (BLOCKS[block.type]?.interactive && block.name) inputs.set(block.name, block);
  return inputs;
}

/**
 * Check submitted values against a card's inputs. Unknown names are dropped; a bad value is an error.
 * @returns `{ values }` (name → canonical string) or `{ error }`.
 */
export function readValues(card, raw) {
  const values = {};
  const given = objects(raw) ? raw : {};
  for (const [name, input] of cardInputs(card)) {
    const value = given[name] ?? input.value;
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    if (input.type === 'field') {
      const canonical = fieldValue(input, value);
      if (canonical === undefined) return { error: `${input.label ?? name}: invalid value` };
      values[name] = canonical;
    } else {
      const picked = Array.isArray(value) ? value : [value];
      if ((!input.multiple && picked.length > 1) || picked.some(item => !input.options.some(option => option.value === item))) {
        return { error: `${input.label ?? name}: not one of the options` };
      }
      // Space-separated, so a multiple choice fills a command's argument list (npm i {deps}).
      values[name] = picked.join(' ');
    }
  }
  return { values };
}

/** Fill `{name}` placeholders; `{ missing }` lists names without a value. */
export function fillPlaceholders(template, values) {
  const missing = [];
  const filled = template.replace(PLACEHOLDER, (whole, name) => {
    if (!Object.hasOwn(values, name)) { missing.push(name); return whole; }
    return values[name];
  });
  return missing.length > 0 ? { missing } : { text: filled };
}

/**
 * Block readers by type. Each takes the raw block and the issue list and returns the normalised
 * block. `fields` lists the properties the type reads, for the tool schema and the skill text.
 */
export const BLOCKS = {
  // Key figures in a row of tiles: a headline number with an optional change and hint.
  stats: {
    fields: 'items[{label, value, delta?, trend?: up|down|flat, tone?, hint?}] 1-4',
    read: (block, path, issues) => ({ items: list(block.items, path + '.items', 4, issues, labelled(true, entry => defined({
      delta: text(entry.delta, 24), trend: pick(entry.trend, TRENDS), tone: pick(entry.tone, ITEM_TONES), hint: text(entry.hint, SHORT),
    }))) }),
  },
  // Labelled rows, the classic key/value card body.
  rows: {
    fields: 'items[{label, value}] 1-12',
    read: (block, path, issues) => ({ items: list(block.items, path + '.items', 12, issues, labelled(false)) }),
  },
  // Progress meters: value out of max (default 100).
  progress: {
    fields: 'items[{label, value, max?, tone?}] 1-6',
    read: (block, path, issues) => ({ items: list(block.items, path + '.items', 6, issues, (entry, at) => {
      const row = measured(entry, at);
      if (typeof row === 'string') return row;
      const max = entry.max === undefined ? undefined : number(entry.max);
      if (entry.max !== undefined && (max === undefined || max <= 0)) return `${at}: max must be a positive number`;
      return defined({ ...row, max });
    }) }),
  },
  // Horizontal bar chart: one series, magnitude by category.
  bars: {
    fields: 'items[{label, value, tone?}] 1-8, unit?, title?',
    read: (block, path, issues) => defined({ title: text(block.title, SHORT), unit: text(block.unit, UNIT),
      items: list(block.items, path + '.items', 8, issues, measured) }),
  },
  // Line chart: one series over ordered points, with optional point labels (e.g. dates).
  line: {
    fields: 'points[number] 2-48, labels?[string] (same length), unit?, title?',
    read: (block, path, issues) => {
      const points = Array.isArray(block.points) ? block.points.map(number) : [];
      if (points.length < 2 || points.length > 48 || points.some(point => point === undefined)) {
        issues.push(`${path}.points: use 2-48 numbers`);
      }
      let labels;
      if (block.labels !== undefined) {
        if (!Array.isArray(block.labels) || block.labels.length !== points.length) issues.push(`${path}.labels: one label per point`);
        else labels = block.labels.map(label => text(label, 24));
      }
      return defined({ title: text(block.title, SHORT), unit: text(block.unit, UNIT),
        points: points.filter(point => point !== undefined), labels });
    },
  },
  // Share of a whole: a donut with up to five parts and the total in the middle.
  donut: {
    fields: 'items[{label, value}] 2-5, unit?, title?',
    read: (block, path, issues) => {
      const items = list(block.items, path + '.items', 5, issues, (entry, at) => {
        const row = measured(entry, at);
        return typeof row === 'string' ? row : { label: row.label, value: row.value };
      }, 2);
      if (items.length > 0 && items.every(item => item.value === 0)) issues.push(`${path}.items: at least one value must be above zero`);
      return defined({ title: text(block.title, SHORT), unit: text(block.unit, UNIT), items });
    },
  },
  // A checklist or timeline: each step is done, active, todo or failed.
  steps: {
    fields: 'items[{label, state: done|active|todo|failed, value?}] 1-8',
    read: (block, path, issues) => ({ items: list(block.items, path + '.items', 8, issues, labelled(false, (entry, at) => {
      const state = pick(entry.state, STEP_STATES);
      return state === undefined ? `${at}: state must be done, active, todo or failed` : { state };
    })) }),
  },
  // A small table: up to five columns and eight rows of short text.
  table: {
    fields: 'columns[string] 1-5, rows[[string]] 1-8 (each row as long as columns)',
    read: (block, path, issues) => {
      const columns = Array.isArray(block.columns) && block.columns.length >= 1 && block.columns.length <= 5
        ? block.columns.map(column => text(column, LABEL)) : undefined;
      if (columns === undefined || columns.some(column => column === '')) {
        issues.push(`${path}.columns: use 1-5 non-empty headings`);
        return { columns: [], rows: [] };
      }
      const rows = list(block.rows, path + '.rows', 8, issues, (row, at) => Array.isArray(row) && row.length === columns.length
        ? row.map(cell => text(cell, SHORT)) : `${at}: each row needs ${columns.length} cells`);
      return { columns, rows };
    },
  },
  // Short tags or badges, optionally toned.
  tags: {
    fields: 'items[{label, tone?}] 1-10',
    read: (block, path, issues) => ({ items: list(block.items, path + '.items', 10, issues, (entry, at) => {
      const label = text(objects(entry) ? entry.label : entry, LABEL);
      return label === '' ? `${at}: label required` : defined({ label, tone: objects(entry) ? pick(entry.tone, ITEM_TONES) : undefined });
    }) }),
  },
  // A paragraph of plain text.
  text: {
    fields: 'text (up to 600 characters)',
    read: (block, path, issues) => {
      const body = text(block.text, TEXT);
      if (body === '') issues.push(`${path}.text: required`);
      return { text: body };
    },
  },
  // Interactive: pick one (or several) of a few options, e.g. a deployment plan.
  choice: {
    interactive: true,
    fields: 'name, label?, options[{value, label, hint?}] 2-6, multiple?, value? (preselected value or values)',
    read: (block, path, issues) => {
      const name = inputName(block.name, path, issues);
      const options = list(block.options, path + '.options', 6, issues, (entry, at) => {
        if (!objects(entry)) return `${at}: expected an object`;
        const value = text(entry.value, 60);
        const label = text(entry.label, LABEL);
        if (!OPTION_VALUE.test(value)) return `${at}.value: use 1-60 letters, digits or _ . : @ / + = - (not starting with -)`;
        if (label === '') return `${at}: label required`;
        return defined({ value, label, hint: text(entry.hint, SHORT) });
      }, 2);
      if (new Set(options.map(option => option.value)).size !== options.length) issues.push(`${path}.options: values must be unique`);
      const multiple = block.multiple === true ? true : undefined;
      const wanted = block.value === undefined ? [] : Array.isArray(block.value) ? block.value : [block.value];
      const chosen = wanted.map(value => text(value, 60)).filter(value => options.some(option => option.value === value));
      const value = chosen.length === 0 ? undefined : multiple ? chosen : chosen[0];
      return defined({ name, label: text(block.label, LABEL), options, multiple, value });
    },
  },
  // Interactive: one time, date or number the user can adjust, e.g. an alarm time.
  field: {
    interactive: true,
    fields: 'name, label, kind: time|date|number, value?, min?, max?, step?, unit?',
    read: (block, path, issues) => {
      const name = inputName(block.name, path, issues);
      const label = text(block.label, LABEL);
      if (label === '') issues.push(`${path}.label: required`);
      const kind = pick(block.kind, FIELD_KINDS);
      if (kind === undefined) issues.push(`${path}.kind: use ${FIELD_KINDS.join(', ')}`);
      const bounds = kind === 'number' ? defined({ min: number(block.min), max: number(block.max), step: number(block.step) }) : {};
      const value = block.value === undefined ? undefined : fieldValue({ kind, ...bounds }, block.value);
      if (block.value !== undefined && value === undefined) issues.push(`${path}.value: not a valid ${kind ?? 'value'}`);
      return defined({ name, label, kind, ...bounds, unit: kind === 'number' ? text(block.unit, UNIT) : undefined, value });
    },
  },
  // A highlighted message: the one thing the reader must notice.
  callout: {
    fields: 'text, tone?',
    read: (block, path, issues) => {
      const body = text(block.text, TEXT);
      if (body === '') issues.push(`${path}.text: required`);
      return defined({ text: body, tone: pick(block.tone, TONES) });
    },
  },
};

export const BLOCK_TYPES = Object.keys(BLOCKS);

/** Read a card's blocks; legacy top-level `lines` become a leading rows block. */
export function readBlocks(card, issues) {
  // [path, block] pairs, so every issue names the field the model wrote.
  const raw = [];
  if (Array.isArray(card.lines) && card.lines.length > 0) raw.push(['lines', { type: 'rows', items: card.lines }]);
  else if (card.lines !== undefined && !Array.isArray(card.lines)) issues.push('lines: expected a list');
  if (Array.isArray(card.blocks)) card.blocks.forEach((block, index) => raw.push([`blocks.${index}`, block]));
  else if (card.blocks !== undefined) issues.push('blocks: expected a list');
  if (raw.length > MAX_BLOCKS) {
    issues.push(`blocks: use at most ${MAX_BLOCKS} blocks`);
    return [];
  }
  const blocks = [];
  for (const [path, block] of raw) {
    const spec = objects(block) && typeof block.type === 'string' ? BLOCKS[block.type] : undefined;
    if (spec === undefined) issues.push(`${path}.type: use one of ${BLOCK_TYPES.join(', ')}`);
    else blocks.push({ type: block.type, ...spec.read(block, path === 'lines' ? 'lines' : path, issues) });
  }
  const names = blocks.filter(block => BLOCKS[block.type].interactive).map(block => block.name);
  if (new Set(names).size !== names.length) issues.push('blocks: every choice and field needs its own name');
  return blocks;
}

/** The tool parameter schema for one block: every field any block type reads, all optional. */
export function blockSchema() {
  const item = { type: 'object', additionalProperties: false, properties: {
    label: { type: 'string' }, value: { oneOf: [{ type: 'string' }, { type: 'number' }] }, max: { type: 'number' },
    delta: { type: 'string' }, trend: { type: 'string', enum: TRENDS }, hint: { type: 'string' },
    state: { type: 'string', enum: STEP_STATES }, tone: { type: 'string', enum: ITEM_TONES },
  } };
  const option = { type: 'object', additionalProperties: false, required: ['value', 'label'], properties: {
    value: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' } } };
  return { type: 'object', additionalProperties: false, required: ['type'], properties: {
    type: { type: 'string', enum: BLOCK_TYPES, description: BLOCK_TYPES.map(type => `${type}: ${BLOCKS[type].fields}`).join('; ') },
    title: { type: 'string', description: 'Chart caption (bars, line, donut).' },
    unit: { type: 'string', description: 'Unit suffix for chart values, e.g. %, ms, GB.' },
    items: { type: 'array', items: item },
    points: { type: 'array', items: { type: 'number' } },
    labels: { type: 'array', items: { type: 'string' } },
    columns: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    text: { type: 'string' },
    tone: { type: 'string', enum: TONES },
    name: { type: 'string', description: 'choice/field: input name, referenced as {name} in action commands and replies.' },
    label: { type: 'string', description: 'choice/field: visible label.' },
    options: { type: 'array', items: option, description: 'choice: 2-6 options.' },
    multiple: { type: 'boolean', description: 'choice: allow several options.' },
    kind: { type: 'string', enum: FIELD_KINDS, description: 'field: input kind.' },
    value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'array', items: { type: 'string' } }], description: 'choice/field: initial value; a list for a multiple choice.' },
    min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' },
  } };
}
