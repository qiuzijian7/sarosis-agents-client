import { DIRECTORY_TOOL, blankState, toolSchema, searchCatalog } from './tool-catalog.mjs';
import { staysResident } from './resident.mjs';

const officialDefinitions = new WeakMap();
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 256 && !/[\u0000-\u001f]/u.test(name);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function markOfficialTool(definition, provider = 'official PTC') {
  officialDefinitions.set(definition, provider);
  return definition;
}
export function isOfficialTool(definition) { return officialDefinitions.has(definition); }
export function officialToolSource(definition) { return officialDefinitions.get(definition); }

export const compatibilityPolicy = `## Efficient tool cooperation
- Search available external capabilities by function using deep_ptc_tools. Load only matching definitions; then use their actual schemas. If none fit, use an admitted official PTC tool. Provider discovery/loaders remain authoritative for provider-specific SDKs.
- When an external capability fails, read the error: correct wrong input, and retry a temporary failure at most twice. A capability that is unavailable or keeps failing is quarantined for this conversation. Unless the user asks you to investigate it, do not retry, probe, diagnose or repair a quarantined capability; promptly use a working equivalent or the official fallback and focus on finishing the task. Only the user's Reload all tool states button resets quarantine.
- At task completion, briefly list the failed tool names and their declared plugins (or unknown source) and say there may be a compatibility problem. Do not claim a root cause. Mention completed work first.
- Preserve authorization, cancellation, the selected shell and managed jobs. Empty results and running/background jobs are not failures. Before replacing a partially completed write or command, read only the task state needed to avoid duplicate effects; this is task recovery, not plugin diagnosis.
- Search skills through deep_ptc_tools(action=skills), then use the official loader named by loadWith and follow its full instructions. Reuse already-loaded instructions in the current context; discovery summaries are not skill instructions.
- Never bypass hidden tools, policy denials, cancelled work or an unavailable whole executor. Deep PTC's existing foreground/steering wrappers continue to govern official execution.`;

// Error text is only consulted when a failure carries no code. Plain throws are the common case for
// plugins, so these patterns separate a broken provider from wrong input and passing trouble.

// A number only counts as an HTTP status next to the word that says so; a bare "404" may be a line
// number, a port or a count.
const httpStatus = codes => String.raw`\b(?:status(?: ?code)?|https?(?:/[\d.]+)?)\W{0,3}(?:${codes})\b`;
const pattern = (...alternatives) => new RegExp(alternatives.join('|'), 'iu');

// The provider's own code cannot be loaded: nothing a retry or other arguments would change.
const MISSING_MODULE_TEXT = /cannot find (?:module|package)|err_module_not_found/iu;
const MISSING_MODULE_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
// A programming error inside the tool. One code path may hit it while the rest of the tool works, and
// particular arguments may be what triggers it, so it is a strike rather than proof of a broken provider.
const DEFECT_TEXT = /is not a (?:function|constructor)|not implemented|cannot read propert(?:y|ies) of (?:undefined|null)/iu;
const DENIED_TEXT = pattern('permission denied|eacces|eperm|forbidden|unauthori[sz]ed', httpStatus('40[13]'));
// A command the tool ran is not installed. Not wrong input, and not proof that the tool itself is broken
// (an external shell tool may simply run a missing command), so it counts as a strike.
const MISSING_COMMAND_TEXT = /command not found|not recognized as an internal or external command|is not recognized as the name of a cmdlet/iu;
const INPUT_TEXT = pattern('enoent|no such file|not found|does not exist|invalid|missing required|bad request', httpStatus('40[04]'));
// An optimistic-lock rejection means the caller must reread the document, not replace the editor.
// Match explicit stale-revision signals; a generic dependency/version conflict may be a real defect.
const EDIT_CONFLICT_CODES = new Set(['REVISION_CONFLICT', 'STALE_REVISION', 'ETAG_MISMATCH', 'PRECONDITION_FAILED']);
const EDIT_CONFLICT_TEXT = /\brevision conflict(?=\s*[:：]|$)|\bstale revision\b|\betag mismatch\b|(?:画布|文件|文档)已被其他编辑器修改/iu;
const TEMPORARY_TEXT = pattern(
  'timed? ?out|timeout|etimedout|econnreset|econnrefused|eai_again|enotfound|socket hang up|network|fetch failed',
  'rate.?limit|too many requests|temporar|try again|overloaded',
  httpStatus('429|50[234]'),
);
/** Consecutive unexplained or temporary failures before a capability is quarantined. */
export const QUARANTINE_STRIKES = 3;
const IMMEDIATE = new Set(['unavailable', 'partial']);

export function classifyToolOutcome(exec, result) {
  if (exec.signal?.aborted) return { kind: 'cancelled', effect: 'unknown' };
  const value = object(result?.value) ? result.value : undefined;
  if (value?.cancelled === true || ['cancelled', 'aborted'].includes(value?.status)) return { kind: 'cancelled', effect: 'unknown' };
  if (value?.sandbox?.denied === true) return { kind: 'denied', effect: 'unknown' };
  // A call that returned is the tool working; its status field describes the tool's own subject (a
  // failed build, an unavailable service). Only an explicit failure object reports on the tool itself.
  const failure = object(value?.failure) ? value.failure : undefined;
  if (!result?.isError && !failure) {
    return value?.kind === 'foreground' && typeof value.exitCode === 'number' && value.exitCode !== 0
      ? { kind: 'command', effect: 'unknown' } : undefined;
  }
  // The host reports a thrown HarnessError's code under error.info.
  const rawCode = result?.error?.info?.code ?? result?.error?.code ?? failure?.code;
  const code = typeof rawCode === 'string' && /^[A-Z0-9_:-]{1,96}$/u.test(rawCode) ? rawCode : '';
  const effect = ['none', 'unknown', 'partial', 'completed'].includes(failure?.effectState)
    ? failure.effectState : 'unknown';
  const status = typeof value?.status === 'string' ? value.status.toLowerCase() : '';
  if (/ABORT|CANCEL/u.test(code) || status === 'cancelled') return { kind: 'cancelled', effect };
  if (/DENIED|FORBIDDEN|POLICY|APPROVAL|PERMISSION|EACCES|EPERM|READ_ONLY/u.test(code))
    return { kind: 'denied', effect };
  const message = String(result?.error?.message ?? failure?.message ?? '');
  if (MISSING_MODULE_CODES.has(code)) return { kind: 'unavailable', effect };
  // The tool could not start its own program: the provider is incompletely installed.
  if ((code === 'ENOENT' || code === '') && /\bspawn(?:sync)?\b[^\n]*\bENOENT\b/iu.test(message)) return { kind: 'unavailable', effect };
  if (MISSING_COMMAND_TEXT.test(message)) return { kind: 'failure', effect };
  if (/ARGUMENT|INVALID_ARGS|VALIDATION|ENOENT|NOT_FOUND/u.test(code) && code !== 'UNKNOWN_TOOL')
    return { kind: 'input', effect };
  if (status === 'partial') return { kind: 'partial', effect };
  if (/UNKNOWN_TOOL|UNAVAILABLE|WORKER_MISSING|RUNTIME_MISSING/u.test(code) || status === 'unavailable')
    return { kind: 'unavailable', effect };
  if (effect !== 'partial' && EDIT_CONFLICT_CODES.has(code)) return { kind: 'input', effect };
  if (code) return { kind: /TIMEOUT|RATE|BUSY|OVERLOAD/u.test(code) ? 'temporary' : 'failure', effect };
  if (MISSING_MODULE_TEXT.test(message)) return { kind: 'unavailable', effect };
  // Before the looser patterns: a TypeError naming a property called "invalid" is not wrong input.
  if (DEFECT_TEXT.test(message)) return { kind: 'failure', effect };
  if (DENIED_TEXT.test(message)) return { kind: 'denied', effect };
  if (TEMPORARY_TEXT.test(message)) return { kind: 'temporary', effect };
  if (INPUT_TEXT.test(message) || (effect !== 'partial' && EDIT_CONFLICT_TEXT.test(message))) return { kind: 'input', effect };
  return { kind: 'failure', effect };
}

export function normalizePreferences(preferences = []) {
  if (!Array.isArray(preferences) || preferences.length > 32) throw new Error('toolPreferences must be an array with at most 32 entries');
  const seen = new Set();
  return preferences.map(row => {
    if (!object(row) || !validName(row.preferred) || row.preferred === 'run_code'
      || !Array.isArray(row.fallback) || row.fallback.length === 0 || row.fallback.length > 12
      || row.fallback.some(name => !validName(name) || name === 'run_code' || name === row.preferred)
      || seen.has(row.preferred)) throw new Error('Each tool preference needs a unique preferred tool and 1–12 distinct fallback names (not run_code)');
    if (new Set(row.fallback).size !== row.fallback.length) throw new Error('Duplicate fallback names in toolPreferences');
    seen.add(row.preferred);
    return { preferred: row.preferred, fallback: [...row.fallback] };
  });
}

export function createCompatibilityState(tools, preferences = [], storage = {}, directory = {}) {
  const routes = normalizePreferences(preferences);
  let sessions = new WeakMap();
  let calls = new WeakMap();
  const sessionOf = agent => object(agent?.session) ? agent.session : agent;
  function entry(agent) {
    if (storage.read && !object(agent?.session)) return undefined;
    const session = sessionOf(agent);
    if (!object(session)) return undefined;
    const stored = storage.read?.(session);
    let row = sessions.get(session);
    if (!row) {
      row = { state: stored ?? blankState(), selected: new Set(), strikes: new Map() };
      sessions.set(session, row);
    } else if (stored && stored !== row.state) {
      // Another writer (a reset from the interface, a restored session) moved the state on.
      if (stored.epoch !== row.state.epoch) {
        row.selected.clear();
        row.strikes.clear();
      }
      row.state = stored;
    }
    return row;
  }
  function save(agent, row, state) {
    storage.write?.(sessionOf(agent), state); // Persist first: an unsuccessful reset never clears quarantine.
    row.state = state;
  }
  function definitions(agent, toolSet) { return tools.definitions(agent, toolSet).filter(def => validName(def.name)); }
  // Unknown ownership is deliberately fail-open. Source scraping can miss dynamic official
  // registrations; only a positively attributed external provider may be quarantined or hidden.
  const foreign = provider => typeof provider === 'string' && !provider.startsWith('@deepseek-ai/');
  const declaredProvider = def => typeof def?.deepPtc?.provider === 'string' ? def.deepPtc.provider : undefined;
  // Most official tools are known by the name their module declares; the feature wrappers also mark theirs.
  const official = def => !!def && (isOfficialTool(def)
    || (!foreign(declaredProvider(def)) && directory.isOfficial?.(def.name) === true));
  const external = def => !!def && !official(def) && (declaredProvider(def) !== undefined
    || directory.isExternal?.(def.name) === true
    || foreign(directory.providerOf?.(def.name)));
  const resident = def => staysResident(def, directory.providerOf?.(def?.name) ?? '');
  const protectedName = (agent, name) => {
    const def = tools.get(name, agent);
    if (def && resident(def)) return true;
    return def ? !external(def) : directory.isOfficial?.(name) === true;
  };
  // The stored state without rows that have since become protected. Returns the stored object itself
  // when nothing was dropped, so callers can tell by identity whether there is anything to persist.
  const usableState = agent => {
    const state = entry(agent)?.state ?? blankState();
    const usable = rows => rows.filter(row => !protectedName(agent, row.name));
    const blockedRows = usable(state.blocked);
    const reported = state.report ? usable(state.report.tools) : [];
    if (blockedRows.length === state.blocked.length && reported.length === (state.report?.tools.length ?? 0)) return state;
    return { ...state, blocked: blockedRows, report: state.report ? { ...state.report, tools: reported } : null };
  };
  const blocked = (agent, name) => !protectedName(agent, name)
    && entry(agent)?.state.blocked.some(row => row.name === name) === true;
  const providerOf = def => officialDefinitions.get(def)
    ?? declaredProvider(def)?.slice(0, 160)
    ?? directory.providerOf?.(def?.name)
    ?? 'unknown plugin';
  const remember = (row, name) => {
    row.selected.delete(name);
    row.selected.add(name);
    if (row.selected.size > 12) row.selected.delete(row.selected.values().next().value);
  };
  const api = {
    dispatched(exec) {
      const row = entry(exec.agent);
      if (!row || calls.has(exec)) return;
      const cleaned = usableState(exec.agent);
      if (cleaned !== row.state) save(exec.agent, row, cleaned);
      const definition = tools.get(exec.name, exec.agent, exec.toolSet);
      calls.set(exec, { epoch: row.state.epoch, definition, official: !external(definition), provider: providerOf(definition) });
    },
    guard(exec) { return blocked(exec.agent, exec.name) ? `Deep PTC: ${JSON.stringify(exec.name)} is quarantined in this conversation. Do not retry or diagnose it. Continue with another admitted equivalent or official tool. Only the user can reload all tool states.` : undefined; },
    observe(exec, result) {
      const call = calls.get(exec);
      // No definition means the name never belonged to a plugin, so there is nothing to quarantine.
      if (!call?.definition || call.official || resident(call.definition) || exec.name === DIRECTORY_TOOL || exec.name === 'run_code') return;
      const row = entry(exec.agent);
      if (!row || call.epoch !== row.state.epoch || blocked(exec.agent, exec.name)) return;
      const outcome = classifyToolOutcome(exec, result);
      if (!outcome) { row.strikes.delete(exec.name); return; }
      // Authorization and cancelled actions must never be converted to provider failover, and wrong
      // input says nothing about the tool.
      if (['denied', 'cancelled', 'command', 'input'].includes(outcome.kind)) return;
      if (!IMMEDIATE.has(outcome.kind)) {
        const strikes = (row.strikes.get(exec.name) ?? 0) + 1;
        row.strikes.set(exec.name, strikes);
        if (strikes < QUARANTINE_STRIKES) return;
      }
      const failure = { name: exec.name, provider: call.provider, kind: outcome.kind };
      save(exec.agent, row, { ...row.state, blocked: [...row.state.blocked, failure] });
      row.strikes.delete(exec.name);
      row.selected.delete(exec.name);
    },
    reset(agent) {
      const row = entry(agent);
      if (!row) throw new Error('No conversation is active');
      const count = row.state.blocked.length;
      save(agent, row, { ...blankState(), epoch: row.state.epoch + 1 });
      row.selected.clear();
      row.strikes.clear();
      return count;
    },
    status(agent) { return usableState(agent); },
    sdkDefinitions(agent, toolSet, compact = true) {
      const row = entry(agent);
      const excluded = new Set(usableState(agent).blocked.map(item => item.name));
      return definitions(agent, toolSet).filter(def => !excluded.has(def.name)
        && (!compact || !external(def) || def.name === DIRECTORY_TOOL || row?.selected.has(def.name) || resident(def)));
    },
    search(agent, args, toolSet) {
      const excluded = new Set(usableState(agent).blocked.map(item => item.name));
      const visible = definitions(agent, toolSet).filter(def => def.name !== DIRECTORY_TOOL && !excluded.has(def.name));
      const externalTools = visible.filter(external);
      const result = searchCatalog(externalTools, args.query, args.offset, args.limit);
      if (result.total) return { layer: 'external', ...result };
      const baseline = searchCatalog(visible.filter(official), args.query, args.offset, args.limit);
      if (baseline.total) return { layer: 'official', ...baseline };
      const unattributed = visible.filter(def => !external(def) && !official(def));
      return { layer: 'unattributed', ...searchCatalog(unattributed, args.query, args.offset, args.limit) };
    },
    load(agent, names, toolSet) {
      if (!Array.isArray(names) || names.length < 1 || names.length > 6 || names.some(name => !validName(name))) throw new Error('Load 1–6 exact tool names');
      const live = new Map(definitions(agent, toolSet).map(def => [def.name, def]));
      const row = entry(agent);
      if (!row) throw new Error('No conversation is active');
      let budget = 16000;
      const loaded = [], unavailable = [], deferred = [];
      for (const name of new Set(names)) {
        const def = live.get(name);
        if (!def || blocked(agent, name) || name === DIRECTORY_TOOL) { unavailable.push(name); continue; }
        const schema = toolSchema(def);
        const size = Buffer.byteLength(JSON.stringify(schema), 'utf8');
        remember(row, name);
        if (size > budget) { deferred.push(name); continue; }
        budget -= size;
        loaded.push(schema);
      }
      return { loaded, unavailable, deferred, nextStep: true, note: 'Deferred names are selected and will appear in full in the next host SDK. Unavailable names are hidden or quarantined. No tool was executed. Use an equivalent or load fewer definitions.' };
    },
    text({ scope: agent, toolSet } = {}) {
      if (!object(agent)) return '';
      const row = entry(agent);
      if (!row) return '';
      const state = usableState(agent);
      const lines = [];
      if (state.blocked.length) {
        lines.push('Quarantined for this conversation; no retries or diagnosis. Finish the task using working equivalents. At completion briefly report these tool/plugin names and a possible compatibility problem:');
        lines.push(JSON.stringify(state.blocked.slice(0, 8).map(({ name, provider }) => ({ name, provider }))));
        if (state.blocked.length > 8) lines.push(`${state.blocked.length} tools total; the user interface retains the full list.`);
        lines.push('Check only necessary task state before replacing a possibly partial mutation. Reset is a user action.');
      }
      const available = routes.length ? new Set(definitions(agent, toolSet).map(def => def.name)) : new Set();
      for (const route of routes) {
        if (available.has(route.preferred) && !blocked(agent, route.preferred)) lines.push(`Prefer ${JSON.stringify(route.preferred)} when applicable; visible equivalents: ${JSON.stringify(route.fallback.filter(name => available.has(name) && !blocked(agent, name)))}. Read live schemas.`);
      }
      return lines.join('\n');
    },
    dispose() { sessions = new WeakMap(); calls = new WeakMap(); },
  };
  return api;
}

// A failure in this layer must leave tool calls and prompts as the host would have them.
export function failOpen(ctx, label, fn, fallback) {
  let warned = false;
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      if (!warned) {
        warned = true;
        ctx.logger?.warn?.('Deep PTC: %s failed (%s); continuing without it', label, error?.message);
      }
      return fallback;
    }
  };
}

export function installToolCompatibility(ctx, { enabled = true, preferences = [], storage, directory } = {}) {
  if (!enabled) return;
  const state = createCompatibilityState(ctx.tools, preferences, storage, directory);
  const guard = failOpen(ctx, 'tool quarantine check', exec => state.guard(exec));
  const dispatched = failOpen(ctx, 'tool call tracking', exec => state.dispatched(exec));
  ctx.systemPrompt.section({ name: 'deep-ptc:tool-compatibility', order: 10194, text: compatibilityPolicy });
  ctx.systemPrompt.context({ name: 'deep-ptc:tool-recovery', order: 122, text: failOpen(ctx, 'tool recovery context', context => state.text(context), '') });
  ctx.tools.guard(guard);
  ctx.on('tools/execute', (exec, next) => {
    const reason = guard(exec);
    if (reason) return Promise.resolve({ isError: true, error: { message: reason }, content: [{ type: 'text', text: reason }] });
    dispatched(exec);
    return next();
  });
  ctx.on('tools/result', failOpen(ctx, 'tool result tracking', (exec, result) => state.observe(exec, result)));
  ctx.effect(() => () => state.dispose());
  return state;
}
