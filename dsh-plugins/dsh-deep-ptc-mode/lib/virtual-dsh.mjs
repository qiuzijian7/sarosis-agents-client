// Virtual DSH control: the side panel's button and the model's virtual_dsh tool share this runtime.
//
// The panel starts, stops and opens a virtual DSH (lib/preview.mjs). The tool also installs and
// removes extra plugins, reads and writes its configuration, restarts it and reads its log. Every
// change happens inside the virtual DSH's own temporary home; the user's real DSH is never touched.
// One state file is shared with a virtual DSH the model started through the shell.
//
// The user's click is the consent for a panel start. The launcher is a child of the host, stopped
// when the host stops; anything a hard stop leaves behind is swept on the next start or load.
import { fork, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gated } from './gate.mjs';
import { NO_SESSION, WRONG_MODE, coded } from './model-view.mjs';
import { PROFILE, alive, cliCommand, dshHome, killTree, sweep, virtualEnv } from './preview.mjs';
import { isDeepPtcSession } from './session-preset.mjs';
import { importHost } from './host.mjs';
import { cancel as cancelTurn, chat, connect, sessions as listSessions, transcript } from './virtual-client.mjs';

export const VIRTUAL_COMMAND = 'deep-ptc-virtual-dsh';
export const VIRTUAL_TOOL = 'virtual_dsh';
export const VIRTUAL_KEY = 'deepPtcVirtual';
export const VIRTUAL_EVENT = 'plugin:dsh-deep-ptc-mode/virtual';
const PREVIEW = fileURLToPath(new URL('./preview.mjs', import.meta.url));
const LIVE = ['preparing', 'installing', 'adding package', 'starting', 'running', 'restarting'];
export const stateFile = (home = dshHome()) => join(home, 'storages', 'deep-ptc-virtual-dsh.json');

function readState(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

const addedFile = root => join(root, 'added.json');
const readAdded = root => { try { return JSON.parse(readFileSync(addedFile(root), 'utf8')); } catch { return []; } };

/** What the panel and the tool see: the state file, corrected when its process is gone. */
export function readStatus(file = stateFile()) {
  const state = readState(file);
  if (state === undefined) return { state: 'stopped' };
  const live = LIVE.includes(state.state);
  if (live && !alive(state.pid)) return { state: state.error ? 'failed' : 'stopped', error: state.error ?? null };
  const root = live && state.root && existsSync(state.root) ? state.root : null;
  return { state: state.state ?? 'stopped', url: live ? state.url ?? null : null, error: state.error ?? null,
    package: state.package ?? null, root, added: root ? readAdded(root) : [] };
}

/** The runtime the preset row's tool uses; set once the profile-level layer is installed. */
export const virtualRuntime = { api: undefined };

/**
 * @param options - `{ enabled, watch, spawn, stateFile, run }`: the deep creative mode setting, its
 *   subscription, and test seams for starting the launcher and running the DSH CLI.
 */
export function apply(ctx, options = {}) {
  return ctx.plugin({ name: 'deep-ptc-virtual-dsh', inject: ['commands', 'sessionProjections'], apply: async child => {
    // Leftovers from a run the host could not stop cleanly.
    try { sweep(); } catch (error) { child.logger?.warn?.('Deep PTC: virtual DSH sweep failed (%s)', error.message); }
    const records = options.records ?? (await importHost('@deepseek-ai/dsh-session')).appendPluginRecord;
    const parse = value => { if (value === null || typeof value !== 'object' || value.v !== 1) throw new Error('Invalid virtual DSH state'); return value; };
    const projection = await child.sessionProjections.register({ key: VIRTUAL_KEY, stateVersion: 1, stateSchema: { parse },
      init: () => ({ v: 1, status: { state: 'unknown' }, hash: '' }),
      apply: (state, event) => event.type === VIRTUAL_EVENT && event.data?.v === 1 ? event.data : state,
      wire: { viewSchema: { parse }, view: state => state, summary: false } });
    child.effect(() => () => projection.dispose());
    const api = createApi(options);
    api.watch(session => projection.stateOf(session)?.hash, (session, status, hash) => records(session, VIRTUAL_EVENT, { v: 1, status, hash }));
    virtualRuntime.api = api;
    child.effect(() => () => { api.close(); api.stop(); if (virtualRuntime.api === api) virtualRuntime.api = undefined; });
    gated(child, options.enabled, options.watch, () => child.commands.register({ name: VIRTUAL_COMMAND, recordInput: false,
      description: '虚拟 DSH 环境 / Virtual DSH',
      handler: ({ agent, rawInput }) => command(child, api, agent, rawInput) }), 'Deep PTC: virtual DSH');
  } }).await().catch(error => ctx.logger.warn('Deep PTC: the virtual DSH controls are off (%s)', error.message));
}

/** Run the DSH CLI against the virtual home without blocking the host. */
function runCli(args, root, timeoutMs = 300_000) {
  const cli = cliCommand(undefined);
  const quote = value => /[\s"&|<>^]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
  const all = [...cli.args, ...args];
  return new Promise(done => {
    const childProcess = spawn(cli.shell ? quote(cli.command) : cli.command, cli.shell ? all.map(quote) : all,
      { cwd: join(root, 'workspace'), env: virtualEnv(root), shell: cli.shell, windowsHide: true });
    let output = '';
    const keep = chunk => { output = (output + chunk.toString()).slice(-20_000); };
    childProcess.stdout.on('data', keep);
    childProcess.stderr.on('data', keep);
    const timer = setTimeout(() => killTree(childProcess.pid), timeoutMs);
    childProcess.on('error', error => { clearTimeout(timer); done({ status: 1, output: String(error.message) }); });
    childProcess.on('exit', status => { clearTimeout(timer); done({ status: status ?? 1, output }); });
  });
}

export function createApi(options = {}) {
  const file = options.stateFile ?? stateFile();
  const start = options.spawn ?? ((script, argv, opts) => fork(script, argv, opts));
  const cliRun = options.run ?? runCli;
  // `options.process`: a launcher already running (tests).
  const runtime = { process: options.process };

  function launch(extra) {
    let cli;
    try { cli = cliCommand(undefined); } catch (error) { throw new Error(String(error.message)); }
    const args = ['--state', file, '--cli', cli.args[0] ?? cli.command, ...extra];
    // The host may be Electron running as Node: the child needs the same mode to run a script.
    runtime.process = start(PREVIEW, args, { cwd: dirname(PREVIEW), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    const current = runtime.process;
    current.on?.('exit', () => { if (runtime.process === current) runtime.process = undefined; });
  }

  async function waitFor(states, timeoutMs = 240_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const status = readStatus(file);
      if (states.includes(status.state) || ['failed', 'stopped'].includes(status.state)) return status;
      if (Date.now() > until) return { ...status, error: status.error ?? 'timed out waiting for the virtual DSH' };
      await new Promise(done => setTimeout(done, 1500));
    }
  }

  // Sessions whose side panel shows the virtual DSH: each gets the status as it changes, pushed through
  // a session projection, whoever started the virtual DSH (the button, the tool or the shell).
  const watchers = new Set();
  let timer;
  let pushed;
  let shown;
  const tick = () => {
    const status = readStatus(file);
    const hash = JSON.stringify(status);
    for (const session of watchers) {
      if (shown?.(session) === hash) continue;
      Promise.resolve(pushed?.(session, status, hash)).catch(() => watchers.delete(session));
    }
  };
  let client;
  const virtualClient = async () => {
    const status = readStatus(file);
    if (status.state !== 'running' || !status.url) throw new Error(`The virtual DSH is ${status.state}. Start it and wait for running first.`);
    if (client?.url !== status.url) client = { url: status.url, connection: await connect(status.url) };
    return client.connection;
  };

  const api = {
    /** Push status changes to `push(session, status, hash)` for subscribed sessions. */
    watch(current, push) { shown = current; pushed = push; },
    subscribe(session) {
      if (!session || watchers.has(session)) return;
      if (watchers.size >= 32) watchers.delete(watchers.values().next().value);
      watchers.add(session);
      timer ??= setInterval(tick, 2000);
      timer.unref?.();
      tick();
    },
    close() { if (timer) clearInterval(timer); timer = undefined; watchers.clear(); },
    status: () => readStatus(file),

    /** Talk to the virtual DSH as a user would: a message in a (new) session, then the turn's events. */
    async chat(args) { return chat(await virtualClient(), { ...args, cwd: args.cwd ?? (readStatus(file).root ? join(readStatus(file).root, 'workspace') : undefined) }); },
    async transcript(sessionId, limit) { if (!sessionId) throw new Error('session: a session id from chat or sessions'); return transcript(await virtualClient(), sessionId, limit); },
    async sessions() { return { sessions: await listSessions(await virtualClient()) }; },
    async cancel(sessionId) { if (!sessionId) throw new Error('session: the session to cancel'); return cancelTurn(await virtualClient(), sessionId); },

    /** Start a fresh virtual DSH, unless one is already running. */
    start({ package: pkg, credentials = true } = {}) {
      const current = readStatus(file);
      if (!['stopped', 'failed'].includes(current.state)) return current;
      launch([...pkg ? ['--package', resolve(pkg)] : [], ...credentials === false ? ['--no-credentials'] : []]);
      return { state: 'preparing' };
    },

    /** Stop it; `keep` leaves the environment for a restart. */
    stop({ keep = false } = {}) {
      const current = runtime.process;
      runtime.process = undefined;
      if (current?.connected) { try { current.send({ type: 'stop', keep }); return { state: keep ? 'restarting' : 'stopping' }; } catch { /* hard stop */ } }
      const state = readState(file);
      if (!state) return { state: 'stopped' };
      if (state.childPid) killTree(state.childPid);
      if (state.pid) killTree(state.pid);
      // A hard stop skips the launcher's cleanup: forget the credentials now, sweep the rest.
      if (!keep && state.root) {
        for (const entry of ['.credentials.yaml', 'llm-deepseek']) { try { rmSync(join(state.root, '.dsh', entry), { recursive: true, force: true }); } catch { /* swept later */ } }
        setTimeout(() => { try { sweep(); } catch { /* next start */ } }, 2000).unref?.();
      }
      return { state: keep ? 'restarting' : 'stopping' };
    },

    /** Restart the running virtual DSH with its current environment and port. */
    async restart() {
      const state = readState(file);
      const status = readStatus(file);
      if (!status.root) throw new Error('No virtual DSH is running. Start one first.');
      if (runtime.process?.connected) runtime.process.send({ type: 'restart' });
      else {
        // Started elsewhere (the shell): replace its launcher, keeping the directory and the port.
        if (state.childPid) killTree(state.childPid);
        if (state.pid) killTree(state.pid);
        await new Promise(done => setTimeout(done, 1500));
        launch(['--reuse', status.root, ...state.port ? ['--port', String(state.port)] : []]);
      }
      await new Promise(done => setTimeout(done, 1000));
      return waitFor(['running']);
    },

    /** Install an extra plugin (a .tgz, a directory or an npm spec) and restart. */
    async addPlugin(spec) {
      const status = readStatus(file);
      if (!status.root) throw new Error('No virtual DSH is running. Start one first.');
      if (typeof spec !== 'string' || spec.trim() === '') throw new Error('spec: a .tgz path, a plugin directory or an npm package name');
      const local = isAbsolute(spec) || /^\.{1,2}[\\/]/u.test(spec) ? resolve(spec) : undefined;
      if (local && !existsSync(local)) throw new Error(`${local} does not exist`);
      const target = local ?? spec.trim();
      const result = await cliRun(['plugin', '--profile', PROFILE, 'add', target], status.root);
      if (result.status !== 0) throw new Error(`Installing ${target} failed:\n${result.output.slice(-1500)}`);
      const name = installedName(status.root, target);
      writeFileSync(addedFile(status.root), JSON.stringify([...readAdded(status.root).filter(row => row.name !== name), { name, spec: target }], null, 1));
      return { ...await api.restart(), installed: name };
    },

    /** Remove a plugin from the virtual DSH and restart. */
    async removePlugin(name) {
      const status = readStatus(file);
      if (!status.root) throw new Error('No virtual DSH is running. Start one first.');
      if (typeof name !== 'string' || !/^(@[\w.-]+\/)?[\w.-]+$/u.test(name)) throw new Error('name: the installed package name');
      const result = await cliRun(['plugin', '--profile', PROFILE, 'remove', name], status.root);
      if (result.status !== 0) throw new Error(`Removing ${name} failed:\n${result.output.slice(-1500)}`);
      writeFileSync(addedFile(status.root), JSON.stringify(readAdded(status.root).filter(row => row.name !== name), null, 1));
      return { ...await api.restart(), removed: name };
    },

    /** The plugins the virtual DSH's profile depends on, and which of them were added here. */
    plugins() {
      const status = readStatus(file);
      if (!status.root) throw new Error('No virtual DSH is running. Start one first.');
      const pkg = JSON.parse(readFileSync(join(status.root, '.dsh', 'profiles', PROFILE, 'package.json'), 'utf8'));
      const added = new Set(readAdded(status.root).map(row => row.name));
      return { bundles: pkg.dsh?.profile?.bundles ?? [],
        plugins: Object.entries(pkg.dependencies ?? {}).map(([name, version]) => ({ name, version, added: added.has(name) })) };
    },

    /** The virtual DSH's configuration: the profile's cordis.patch.yml and the home's. */
    readConfig() {
      const status = readStatus(file);
      if (!status.root) throw new Error('No virtual DSH is running. Start one first.');
      const read = path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
      return { profile: read(configPath(status.root, 'profile')), home: read(configPath(status.root, 'home')) };
    },

    /** Replace one configuration file after checking it parses as YAML, then restart. */
    async writeConfig(which, content) {
      const status = readStatus(file);
      if (!status.root) throw new Error('No virtual DSH is running. Start one first.');
      if (which !== 'profile' && which !== 'home') throw new Error('file: profile or home');
      if (typeof content !== 'string') throw new Error('content: the whole YAML file');
      try { yaml().load(content); } catch (error) { throw new Error(`Not valid YAML: ${error.message}`); }
      writeFileSync(configPath(status.root, which), content);
      return { ...await api.restart(), written: which };
    },

    /** The end of the virtual DSH's log. */
    logs(lines = 80) {
      const status = readStatus(file);
      if (!status.root) throw new Error('No virtual DSH is running. Start one first.');
      let text = '';
      try { text = readFileSync(join(status.root, 'dsh.log'), 'utf8'); } catch { /* nothing yet */ }
      const count = Number.isSafeInteger(lines) ? Math.min(Math.max(lines, 1), 400) : 80;
      return { log: text.split(/\r?\n/u).slice(-count).join('\n') };
    },
  };
  return api;
}

const configPath = (root, which) => which === 'profile' ? join(root, '.dsh', 'profiles', PROFILE, 'cordis.patch.yml') : join(root, '.dsh', 'cordis.patch.yml');

let yamlModule;
const yaml = () => (yamlModule ??= createRequire(import.meta.url)('js-yaml'));

/** The package name an add installed: read from the archive name, the directory or the spec. */
function installedName(root, target) {
  try {
    if (existsSync(join(target, 'package.json'))) return JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name;
  } catch { /* fall through */ }
  const deps = (() => { try { return JSON.parse(readFileSync(join(root, '.dsh', 'profiles', PROFILE, 'package.json'), 'utf8')).dependencies ?? {}; } catch { return {}; } })();
  for (const [name, value] of Object.entries(deps)) if (String(value).includes(basename(target))) return name;
  return target.replace(/@[^@/]+$/u, '');
}

const answer = status => ({ kind: 'success', text: coded('virtual', JSON.stringify(status)) });

/** The panel's command: status, start and stop. */
export function command(ctx, api, agent, rawInput) {
  if (!agent?.session) return { kind: 'error', text: NO_SESSION };
  if (!isDeepPtcSession(ctx, agent.session)) return { kind: 'error', text: WRONG_MODE };
  let request;
  try { request = JSON.parse(String(rawInput ?? '')); } catch { return { kind: 'error', text: 'Invalid request. / 无效的请求。' }; }
  api.subscribe?.(agent.session);
  try {
    if (request?.op === 'status') return answer(api.status());
    if (request?.op === 'stop') return answer(api.stop());
    if (request?.op === 'start') return answer(api.start({ credentials: request.credentials !== false }));
  } catch (error) { return { kind: 'error', text: String(error?.message ?? error) }; }
  return { kind: 'error', text: 'Invalid request. / 无效的请求。' };
}

// Approval: the first action that changes or drives the virtual DSH in a conversation asks the user
// once; the grant covers every later start, change and test in that conversation.
const NEEDS_GRANT = new Set(['start', 'restart', 'add_plugin', 'remove_plugin', 'write_config', 'chat', 'cancel']);
const GRANT_REASON = 'Deep PTC asks to use a virtual DSH for testing in this conversation: start and restart it as often as needed, install or remove plugins and edit its configuration inside its temporary home, and send it test messages. One approval covers the whole conversation. The virtual DSH copies your sign-in and runs with your permission settings, so its test sessions can act on this computer. You can stop it any time in the side panel.';

async function ensureGrant(runtime, exec, approval) {
  const sessionId = exec.agent?.session?.id;
  runtime.grants ??= new Set();
  if (sessionId && runtime.grants.has(sessionId)) return;
  const service = approval?.();
  if (typeof service?.request !== 'function') throw new Error('No approval is available here. Ask the user to start the virtual DSH from the side panel (Deep creative mode).');
  const outcome = await service.request({ agent: exec.agent, toolName: VIRTUAL_TOOL, ...exec.callId ? { callId: exec.callId } : {}, reason: GRANT_REASON, ...exec.signal ? { signal: exec.signal } : {} });
  if (outcome !== 'allowed-once') throw new Error(outcome === 'rejected' ? 'The user declined testing in a virtual DSH for this conversation.' : `Approval ${outcome}.`);
  if (sessionId) runtime.grants.add(sessionId);
}

/** The virtual_dsh tool, bound to the shared runtime at call time. */
export function virtualToolDefinition(runtime = virtualRuntime, { approval } = {}) {
  return {
    name: VIRTUAL_TOOL,
    resident: true,
    description: 'Control and test in the virtual DSH: a fresh DSH with the same host version, plugins, skills and settings as the user\'s, without their sessions or memory. start (optionally with a built .tgz as package), status, stop, restart; add_plugin installs an extra plugin (.tgz path, plugin directory or npm name) and restarts; remove_plugin; list_plugins; read_config and write_config replace the profile\'s or the home\'s cordis.patch.yml (whole YAML file) and restart; logs returns its output. chat sends a message to a session there (a new one unless session is given) and returns that turn: replies, tool calls, results and errors; transcript, sessions and cancel inspect and stop its conversations. The first change or test asks the user once for the whole conversation. The user watches it in the side panel and the right sidebar.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['status', 'start', 'stop', 'restart', 'add_plugin', 'remove_plugin', 'list_plugins', 'read_config', 'write_config', 'logs', 'chat', 'transcript', 'sessions', 'cancel'] },
      package: { type: 'string', description: 'start: absolute path to a built .tgz to test.' },
      credentials: { type: 'boolean', description: 'start: false to start it signed out (default: copy the user\'s sign-in).' },
      spec: { type: 'string', description: 'add_plugin: absolute .tgz path, plugin directory or npm package spec.' },
      name: { type: 'string', description: 'remove_plugin: the installed package name.' },
      file: { type: 'string', enum: ['profile', 'home'], description: 'write_config: which cordis.patch.yml to replace.' },
      content: { type: 'string', description: 'write_config: the complete YAML file.' },
      lines: { type: 'integer', description: 'logs and transcript: how many lines, up to 400.' },
      message: { type: 'string', description: 'chat: what to send, as a user would type it.' },
      session: { type: 'string', description: 'chat, transcript, cancel: a session id in the virtual DSH; chat starts a new session without it.' },
      preset: { type: 'string', description: 'chat: agent preset for a new session, e.g. deep-ptc (default: the virtual DSH\'s default).' },
      wait_seconds: { type: 'integer', description: 'chat: how long to wait for the turn to finish, up to 600 (default 120; 0 returns at once).' },
    } },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const api = runtime.api;
      if (api === undefined) throw new Error('The virtual DSH is not ready yet; try again in a moment');
      if (!exec.agent?.session) throw new Error('No active conversation');
      // The side panel of this conversation follows the virtual DSH from now on.
      api.subscribe?.(exec.agent.session);
      if (NEEDS_GRANT.has(args.action)) await ensureGrant(runtime, exec, approval);
      switch (args.action) {
        case 'status': return api.status();
        case 'start': return api.start({ package: args.package, credentials: args.credentials });
        case 'stop': return api.stop();
        case 'restart': return api.restart();
        case 'add_plugin': return api.addPlugin(args.spec);
        case 'remove_plugin': return api.removePlugin(args.name);
        case 'list_plugins': return api.plugins();
        case 'read_config': return api.readConfig();
        case 'write_config': return api.writeConfig(args.file, args.content);
        case 'logs': return api.logs(args.lines);
        case 'chat': return api.chat({ message: args.message, session: args.session, preset: args.preset, waitSeconds: args.wait_seconds });
        case 'transcript': return api.transcript(args.session, args.lines);
        case 'sessions': return api.sessions();
        case 'cancel': return api.cancel(args.session);
        default: throw new Error('Unknown action');
      }
    },
  };
}
