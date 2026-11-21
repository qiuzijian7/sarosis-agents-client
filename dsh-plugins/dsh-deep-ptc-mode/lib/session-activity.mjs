// What a conversation produced and where it connected, folded from the session log.
//
// Output files follow the official deliverables rule (lib/client.js of @deepseek-ai/dsh-client-ui-deliverables):
// a successful first-party `write`, `edit` or `str_replace_editor` mutation produces its file, using the
// absolute target the result records when there is one, and `deliverables/presented` delivers files.
// Deep PTC also counts the same mutations dispatched from run_code (`tool/ptc-dispatch-start` and
// `tool/ptc-dispatch`), because a PTC conversation writes most files that way.
//
// SSH connections are the destinations of ssh/scp/sftp invocations in shell commands, root or dispatched,
// with the outcome of their tool call. Nothing here reads files or runs commands.

export const ACTIVITY_KEY = 'deepPtcActivity';
const MAX_OUTPUTS = 40;
const MAX_HOSTS = 20;
const MAX_PENDING = 64;

export function blankActivity() {
  return { v: 1, turn: 0, pending: [], outputs: [], ssh: [] };
}

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

function parseArgs(raw) {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string') return undefined;
  try { const value = JSON.parse(raw); return isRecord(value) ? value : undefined; } catch { return undefined; }
}

/** The file a first-party mutation call writes, or undefined. */
export function mutationPath(name, args) {
  if (!isRecord(args)) return undefined;
  switch (name) {
    case 'write': return typeof args.content === 'string' ? text(args.file_path) : undefined;
    case 'edit': return typeof args.old_string === 'string' && args.old_string !== '' && typeof args.new_string === 'string'
      && args.old_string !== args.new_string ? text(args.file_path) : undefined;
    case 'str_replace_editor': return ['create', 'str_replace', 'insert'].includes(args.command) ? text(args.path) : undefined;
    default: return undefined;
  }
}

const SSH_VALUE_OPTIONS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));
const SSH_PROGRAM = /^(?:.*[\\/])?(ssh|scp|sftp)(?:\.exe)?$/iu;

function words(command) {
  const out = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/gu;
  for (const match of command.matchAll(pattern)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

const hostOf = destination => {
  let value = destination.replace(/^(?:ssh|sftp):\/\//iu, '');
  value = value.replace(/^[^@/]*@/u, '');
  value = value.replace(/^\[([^\]]+)\].*$/u, '$1');
  value = value.split(/[:/]/u)[0];
  return /^[A-Za-z0-9._-]+$/u.test(value) ? value : undefined;
};

/**
 * Destinations of ssh, scp and sftp invocations in one shell command.
 * @param command - shell source.
 * @returns host names or aliases, in order, without duplicates.
 */
export function sshDestinations(command) {
  if (typeof command !== 'string' || !/\b(?:ssh|scp|sftp)\b/iu.test(command)) return [];
  const found = [];
  const tokens = words(command);
  for (let index = 0; index < tokens.length; index++) {
    const program = SSH_PROGRAM.exec(tokens[index])?.[1]?.toLowerCase();
    if (!program) continue;
    for (let at = index + 1; at < tokens.length; at++) {
      const token = tokens[at];
      if (/^[;&|)]|^\|\|$|^&&$/u.test(token)) break;
      if (token.startsWith('-') && token.length > 1) {
        // A value option takes the next word unless its value is attached (-p22).
        if (token.length === 2 && SSH_VALUE_OPTIONS.has(token[1])) at++;
        continue;
      }
      if (program === 'scp') {
        if (!/^[^/\\]*:/u.test(token) || /^[A-Za-z]:[\\/]/u.test(token)) continue;
      }
      const host = hostOf(token);
      if (host && !found.includes(host)) found.push(host);
      if (program !== 'scp') break;
    }
  }
  return found;
}

function commandOf(args) {
  return isRecord(args) ? text(args.command) ?? text(args.script) : undefined;
}

function remember(state, id, entry) {
  if (!id) return state;
  const pending = [...state.pending.filter(item => item.id !== id), { id, ...entry }].slice(-MAX_PENDING);
  return { ...state, pending };
}

function settle(state, id, ok, meta, seq) {
  const entry = state.pending.find(item => item.id === id);
  if (!entry) return state;
  let next = { ...state, pending: state.pending.filter(item => item.id !== id) };
  if (entry.path && ok) {
    const recorded = isRecord(meta) && typeof meta.path === 'string' && meta.path !== '' ? meta.path : entry.path;
    next = addOutput(next, { path: recorded, kind: 'produced', turn: state.turn, seq });
  }
  if (entry.hosts?.length) {
    let ssh = next.ssh;
    for (const host of entry.hosts) {
      const count = (ssh.find(row => row.host === host)?.count ?? 0) + 1;
      ssh = [{ host, turn: state.turn, seq, ok, count }, ...ssh.filter(row => row.host !== host)];
    }
    next = { ...next, ssh: ssh.slice(0, MAX_HOSTS) };
  }
  return next;
}

function addOutput(state, row) {
  const outputs = [row, ...state.outputs.filter(item => item.path !== row.path)].slice(0, MAX_OUTPUTS);
  return { ...state, outputs };
}

function track(state, id, name, rawArgs) {
  const args = parseArgs(rawArgs);
  const path = mutationPath(name, args);
  const hosts = sshDestinations(commandOf(args));
  return path || hosts.length ? remember(state, id, { ...(path ? { path } : {}), ...(hosts.length ? { hosts } : {}) }) : state;
}

/** Fold one session event into the activity state. */
export function foldActivity(state, event) {
  const data = event?.data;
  switch (event?.type) {
    case 'turn/start':
      return Number.isSafeInteger(data?.turn) ? { ...state, turn: data.turn } : state;
    case 'tool/call':
      return track(state, String(data?.callId ?? ''), data?.name, data?.arguments);
    case 'tool/ptc-dispatch-start':
      return track(state, `ptc:${data?.subCallId ?? ''}`, data?.name, data?.arguments);
    case 'tool/result': {
      const message = data?.message;
      const id = String(message?.source?.callId ?? data?.callId ?? '');
      return settle(state, id, message?.isError !== true && data?.isError !== true, data?.meta, event.seq);
    }
    case 'tool/ptc-dispatch': {
      const id = `ptc:${data?.subCallId ?? ''}`;
      const failed = data?.isError === true || data?.message?.isError === true || data?.error !== undefined;
      return settle(state, id, !failed, data?.meta, event.seq);
    }
    case 'deliverables/presented': {
      let next = state;
      for (const file of Array.isArray(data?.files) ? data.files : []) {
        const path = text(file?.path);
        if (path) next = addOutput(next, { path, kind: 'presented', turn: state.turn, seq: event.seq });
      }
      return next;
    }
    default:
      return state;
  }
}

export function parseActivity(value) {
  if (!isRecord(value) || value.v !== 1) throw new Error('invalid Deep PTC activity state');
  const list = item => (Array.isArray(item) ? item.filter(isRecord) : []);
  return { v: 1, turn: Number.isSafeInteger(value.turn) ? value.turn : 0, pending: list(value.pending).slice(-MAX_PENDING),
    outputs: list(value.outputs).filter(row => typeof row.path === 'string').slice(0, MAX_OUTPUTS),
    ssh: list(value.ssh).filter(row => typeof row.host === 'string').slice(0, MAX_HOSTS) };
}

/** What the client reads: no pending calls. */
export function activityView(state) {
  return { v: 1, outputs: state.outputs, ssh: state.ssh };
}

export function parseActivityView(value) {
  if (!isRecord(value) || value.v !== 1) throw new Error('invalid Deep PTC activity view');
  const list = item => (Array.isArray(item) ? item.filter(isRecord) : []);
  return { v: 1, outputs: list(value.outputs).filter(row => typeof row.path === 'string'), ssh: list(value.ssh).filter(row => typeof row.host === 'string') };
}

/** Root-level registration, like the tool state, so idle conversations show their activity too. */
export function applyActivity(ctx) {
  return ctx.plugin({ name: 'deep-ptc-activity', inject: ['sessionProjections'], apply: async child => {
    const projection = await child.sessionProjections.register({ key: ACTIVITY_KEY, stateVersion: 1,
      stateSchema: { parse: parseActivity }, init: blankActivity, apply: foldActivity,
      wire: { viewSchema: { parse: parseActivityView }, view: activityView, summary: false } });
    child.effect(() => () => projection.dispose());
  } }).await().catch(error => ctx.logger.warn('Deep PTC: output and SSH activity is off (%s)', error.message));
}
