// Virtual DSH: a fresh DSH with the same host version, plugins, skills and settings as the user's
// real one, and none of their sessions, workspace memory or plugin data.
//
//   node preview.mjs [--package <built.tgz>] [--profile <source profile>] [--cli <dsh.cmd | bin.js>]
//                    [--no-credentials] [--keep] [--state <file>]
//
// It copies the source profile (package.json, lockfile, pnpm workspace, cordis files) into a temporary
// DSH home, copies the local plugins it links, installs the same dependency tree from the shared pnpm
// store, optionally adds the candidate package, and serves the result as a DSH Web app on a loopback
// port. The user's credentials are copied at run time from their own DSH home (never shipped), and
// deleted first when the virtual DSH stops. Stale virtual homes from earlier runs are removed on start.
//
// Run it through the session's shell as a managed job, or from the side panel (lib/virtual-dsh.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PREFIX = 'deep-ptc-preview-';
export const PROFILE = 'virtual';
const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml', '.npmrc'];
// Environment only: plugins, skills, presets and settings. Never sessions, storages, memory files.
const HOME_ENTRIES = ['cordis.patch.yml', 'skills', '.agent-presets', 'settings.yaml'];
const CREDENTIALS = ['.credentials.yaml', 'llm-deepseek'];
const SKIP_COPY = new Set(['node_modules', '.git']);

export const dshHome = (env = process.env) => typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
const slash = path => path.split(sep).join('/');
const absoluteRef = raw => isAbsolute(raw) || /^[A-Za-z]:\//u.test(raw);

/** The profile the virtual DSH copies: the one named, else desktop, else web. */
export function sourceProfile(home, wanted) {
  for (const name of [wanted, 'desktop', 'web'].filter(Boolean)) if (existsSync(join(home, 'profiles', name, 'package.json'))) return name;
  throw new Error(`No DSH profile to copy in ${join(home, 'profiles')}`);
}

/**
 * How to run the DSH CLI that matches the running host. The desktop app ships one
 * (resources/runtime/cli/bin/dsh.cmd); a bin.js runs under this Node.
 * @returns `{ command, args, shell }` for spawn.
 */
export function cliCommand(explicit, { execPath = process.execPath, env = process.env, platform = process.platform } = {}) {
  const name = platform === 'win32' ? 'dsh.cmd' : 'dsh';
  const candidates = [explicit, env.DSH_DESKTOP_CLI,
    // The desktop host runs inside the app's own executable: its CLI sits next to the runtime.
    join(dirname(execPath), 'resources', 'runtime', 'cli', 'bin', name),
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, name))];
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue;
    if (/\.m?js$/u.test(file)) return { command: execPath, args: [file], shell: false };
    return { command: file, args: [], shell: platform === 'win32' && /\.(cmd|bat)$/iu.test(file) };
  }
  throw new Error('DSH CLI not found. Pass --cli with the desktop app\'s resources/runtime/cli/bin/dsh.cmd or an installed @deepseek-ai/dsh/lib/bin.js.');
}

const quote = value => /[\s"&|<>^]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;

function run(cli, args, options) {
  const all = [...cli.args, ...args];
  const result = spawnSync(cli.shell ? quote(cli.command) : cli.command, cli.shell ? all.map(quote) : all,
    { ...options, shell: cli.shell, windowsHide: true, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, error: result.error };
}

function copyTree(from, to) {
  cpSync(from, to, { recursive: true, filter: source => !SKIP_COPY.has(basename(source)) });
}

/**
 * Copy the profile with its linked local plugins, and point every local `link:` / `file:` reference
 * in package.json and the lockfile at the new location, so pnpm installs the same tree.
 * @returns the local plugins copied.
 */
export function mirrorProfile(sourceHome, profile, targetHome, target = PROFILE) {
  const from = join(sourceHome, 'profiles', profile);
  const to = join(targetHome, 'profiles', target);
  mkdirSync(to, { recursive: true });
  for (const file of PROFILE_FILES) if (existsSync(join(from, file))) cpSync(join(from, file), join(to, file));
  const pkgPath = join(to, 'package.json');
  const lockPath = join(to, 'pnpm-lock.yaml');
  let pkg = readFileSync(pkgPath, 'utf8');
  let lock = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '';
  const refs = new Set();
  for (const match of `${pkg}\n${lock}`.matchAll(/\b(link|file):([^'"\s,}]+)/gu)) refs.add(`${match[1]}:${match[2].replace(/:$/u, '')}`);
  const copied = [];
  const moved = new Map();
  // Longest first, so a path is never rewritten inside a longer one that contains it.
  for (const ref of [...refs].sort((a, b) => b.length - a.length)) {
    const kind = ref.slice(0, 4);
    const raw = ref.slice(5);
    const absolute = absoluteRef(raw) ? resolve(raw) : resolve(from, raw);
    let next = moved.get(absolute);
    if (next === undefined) {
      next = absolute;
      const inHome = relative(join(sourceHome, 'local-plugins'), absolute);
      if (inHome && !inHome.startsWith('..') && !isAbsolute(inHome) && existsSync(absolute)) {
        next = join(targetHome, 'local-plugins', inHome);
        if (!existsSync(next)) { copyTree(absolute, next); copied.push(slash(inHome)); }
      }
      moved.set(absolute, next);
    }
    const replacement = absoluteRef(raw) ? slash(next) : slash(relative(to, next));
    const pattern = new RegExp(`\\b${kind}:${raw.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=['"\\s,}:]|$)`, 'gmu');
    pkg = pkg.replace(pattern, `${kind}:${replacement}`);
    lock = lock.replace(pattern, `${kind}:${replacement}`);
  }
  writeFileSync(pkgPath, pkg);
  if (lock) writeFileSync(lockPath, lock);
  return copied;
}

/** Copy the environment around the profile: skills, presets, settings; credentials when asked. */
export function mirrorHome(sourceHome, targetHome, { credentials = true } = {}) {
  const copied = [];
  for (const entry of [...HOME_ENTRIES, ...credentials ? CREDENTIALS : []]) {
    const from = join(sourceHome, entry);
    if (!existsSync(from)) continue;
    copyTree(from, join(targetHome, entry));
    copied.push(entry);
  }
  return copied;
}

export const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

export function killTree(pid) {
  if (!alive(pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } } }
}

/**
 * Remove virtual homes left by earlier runs whose process is gone; stop their DSH if it survived.
 * A directory without state is left alone for ten minutes (it may be starting).
 * @returns the removed directories.
 */
export function sweep(base = tmpdir(), { now = Date.now() } = {}) {
  const removed = [];
  let entries = [];
  try { entries = readdirSync(base).filter(name => name.startsWith(PREFIX)); } catch { return removed; }
  for (const name of entries) {
    const dir = join(base, name);
    let state;
    try { state = JSON.parse(readFileSync(join(dir, 'preview.json'), 'utf8')); } catch { /* unreadable or missing */ }
    if (state && alive(state.pid)) continue;
    if (!state) {
      try { if (now - statSync(dir).mtimeMs < 10 * 60_000) continue; } catch { continue; }
    }
    if (state?.childPid) killTree(state.childPid);
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); removed.push(dir); } catch { /* in use; next sweep */ }
  }
  return removed;
}

export function parseArgs(argv) {
  const options = { credentials: true, keep: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => { const next = argv[++index]; if (next === undefined) throw new Error(`${arg} needs a value`); return next; };
    if (arg === '--package') options.package = value();
    else if (arg === '--profile') options.profile = value();
    else if (arg === '--cli') options.cli = value();
    else if (arg === '--state') options.state = value();
    else if (arg === '--reuse') options.reuse = value();
    else if (arg === '--port') { options.port = Number(value()); if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port needs a port number'); }
    else if (arg === '--no-credentials') options.credentials = false;
    else if (arg === '--keep') options.keep = true;
    // The 2.2.0 form: <built.tgz> [path/to/bin.js]
    else if (arg.endsWith('.tgz') && options.package === undefined) options.package = arg;
    else if (options.package !== undefined && options.cli === undefined && /bin\.js$|dsh(\.cmd)?$/iu.test(arg)) options.cli = arg;
    else throw new Error(`Unknown argument ${arg}. Usage: node preview.mjs [--package <built.tgz>] [--profile <name>] [--cli <path>] [--no-credentials] [--keep] [--state <file>] [--reuse <dir>] [--port <n>]`);
  }
  return options;
}

export async function launch(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sourceHome = dshHome();
  const stateFile = options.state ?? join(sourceHome, 'storages', 'deep-ptc-virtual-dsh.json');
  const status = {};
  let removedRoot = false;
  const publish = change => {
    Object.assign(status, change, { updatedAt: new Date().toISOString() });
    for (const file of [stateFile, status.root && !removedRoot && join(status.root, 'preview.json')].filter(Boolean)) {
      try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(status, null, 1)); } catch { /* best effort */ }
    }
  };
  // One virtual DSH at a time: a new start replaces the running one.
  try {
    const previous = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (alive(previous.pid) && previous.pid !== process.pid) { killTree(previous.childPid); killTree(previous.pid); }
  } catch { /* none running */ }
  let root;
  if (options.reuse) {
    // A restart keeps the installed environment: claim the directory before the sweep sees it.
    root = resolve(options.reuse);
    if (!existsSync(join(root, '.dsh', 'profiles', PROFILE, 'package.json'))) throw new Error(`${root} is not a virtual DSH directory`);
    let earlier = {};
    try { earlier = JSON.parse(readFileSync(join(root, 'preview.json'), 'utf8')); } catch { /* fresh state */ }
    publish({ ...earlier, state: 'starting', pid: process.pid, childPid: null, root, url: null, error: null });
  }
  const removed = sweep();
  if (removed.length) console.log(`Removed ${removed.length} stale virtual DSH director${removed.length === 1 ? 'y' : 'ies'}.`);
  if (!root) {
    root = mkdtempSync(join(tmpdir(), PREFIX));
    publish({ state: 'preparing', pid: process.pid, childPid: null, root, url: null, error: null, package: options.package ? resolve(options.package) : null, added: [] });
  }
  const home = join(root, '.dsh');
  const log = join(root, 'dsh.log');
  let child;
  let failed = false;
  let finished = false;
  let restarting = false;
  let keep = options.keep;
  const forget = () => { for (const entry of CREDENTIALS) { try { rmSync(join(home, entry), { recursive: true, force: true }); } catch { /* sweep */ } } };
  const finish = code => {
    if (finished) return;
    finished = true;
    if (child?.pid) killTree(child.pid);
    // Kept for a restart: the environment stays as it is, credentials included.
    if (!keep) forget();
    // A failed run keeps its directory (minus credentials) for diagnosis until the next start sweeps it.
    if (!keep && !failed) {
      // The stopped DSH may still hold files for a moment: retry, and leave the rest to the next sweep.
      try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); removedRoot = true; } catch { /* next start sweeps it */ }
    }
    publish({ state: failed ? 'failed' : keep ? 'restarting' : 'stopped', url: null });
    process.exit(code);
  };
  const fail = error => { failed = true; const text = String(error?.message ?? error); console.error(text); publish({ error: text.slice(0, 2000) }); finish(1); };
  let cli;
  let env;
  let cwd;
  const boot = () => {
    publish({ state: 'starting', url: null });
    const port = String(options.port ?? status.port ?? 0);
    const all = [...cli.args, '--profile', PROFILE, '--host', '127.0.0.1', '--port', port, '--no-open'];
    child = spawn(cli.shell ? quote(cli.command) : cli.command, cli.shell ? all.map(quote) : all,
      { cwd, env, shell: cli.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    publish({ childPid: child.pid });
    const current = child;
    let ready = false;
    const watch = chunk => {
      const text = chunk.toString();
      process.stdout.write(text);
      try { appendFileSync(log, text); } catch { /* the console still has it */ }
      const url = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)[^\s"'<>]*/u.exec(text);
      // Later boots reuse the first port, so an open sidebar tab keeps working after a restart.
      if (url && !ready) { ready = true; publish({ state: 'running', url: url[0], port: Number(url[1]) }); console.log(`Virtual DSH is ready: ${url[0]}`); }
    };
    current.stdout.on('data', watch);
    current.stderr.on('data', watch);
    current.on('exit', code => {
      if (child === current) child = undefined;
      if (restarting || child !== undefined) return;
      if (code) { failed = true; publish({ error: `DSH exited with code ${code}` }); }
      finish(code ?? 0);
    });
  };
  const restart = async () => {
    if (finished || !cli || restarting) return;
    restarting = true;
    publish({ state: 'restarting', url: null });
    const old = child;
    if (old?.pid) {
      const exited = new Promise(done => old.once('exit', done));
      killTree(old.pid);
      await Promise.race([exited, new Promise(done => setTimeout(done, 10_000))]);
    }
    restarting = false;
    boot();
  };
  process.on('SIGINT', () => finish(0));
  process.on('SIGTERM', () => finish(0));
  process.on('message', message => {
    if (message?.type === 'stop') { keep = keep || message.keep === true; finish(0); }
    else if (message?.type === 'restart') void restart();
  });
  // Started by the host (the side panel): when the host goes away, stop and clean up with it.
  process.on('disconnect', () => finish(0));
  try {
    cli = cliCommand(options.cli);
    mkdirSync(join(root, 'tmp'), { recursive: true });
    // The real environment, with DSH pointed at the virtual home: proxies, PATH, git and SSH stay the user's.
    env = virtualEnv(root);
    cwd = join(root, 'workspace');
    mkdirSync(cwd, { recursive: true });
    if (!options.reuse) {
      const profile = sourceProfile(sourceHome, options.profile);
      const plugins = mirrorProfile(sourceHome, profile, home);
      const environment = mirrorHome(sourceHome, home, { credentials: options.credentials });
      console.log(`Virtual DSH: profile "${profile}", ${plugins.length} local plugin(s), ${environment.join(', ') || 'no extra files'} → ${root}`);
      publish({ state: 'installing' });
      let install = run(cli, ['plugin', '--profile', PROFILE, 'install', '--prefer-offline', '--frozen-lockfile'], { cwd, env, timeout: 600_000 });
      if (install.status !== 0) {
        console.log('The frozen install failed; resolving again from the same package.json.');
        install = run(cli, ['plugin', '--profile', PROFILE, 'install', '--prefer-offline'], { cwd, env, timeout: 600_000 });
      }
      if (install.status !== 0) throw new Error(`Installing the copied plugins failed:\n${install.output.slice(-1500)}`);
      if (options.package) {
        publish({ state: 'adding package' });
        const added = run(cli, ['plugin', '--profile', PROFILE, 'add', resolve(options.package)], { cwd, env, timeout: 300_000 });
        if (added.status !== 0) throw new Error(`Adding ${options.package} failed:\n${added.output.slice(-1500)}`);
      }
    }
    boot();
  } catch (error) { fail(error); }
}

/** The environment for running the DSH CLI against a virtual home (plugin add and remove). */
export function virtualEnv(root, base = process.env) {
  const env = { ...base, DSH_HOME: join(root, '.dsh'), DSH_TELEMETRY_DISABLED: '1', TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp') };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// Electron's embedded Node may lack import.meta.main; compare the entry script instead.
const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (import.meta.main ?? (entry !== '' && new URL(import.meta.url).pathname.toLowerCase().endsWith(slash(entry).toLowerCase().replace(/^[a-z]:/u, '')))) await launch();
