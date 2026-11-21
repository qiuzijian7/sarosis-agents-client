// Deep PTC owns a session-scoped preset identity compatibility layer.
//
// Third-party callers share two layers. Prefer the real deep-ptc ID. If the caller's
// preset gate requires a base preset, return its compatibility ID, normally ptc.
// composedPreset() returns once and cannot observe the caller's check, so choose the
// layer from the caller's package or configured support before returning the ID.
//
// Host internals that must keep the exact identity (subagent child headers, scheduled
// session creation, the registry itself) are recognised from the immediate frames. Every
// other official package is a plugin of the product and sees the base id (see callerRole).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'deep-ptc-preset-compat';
export const inject = ['agentPresets'];

const PATCH_MARK = Symbol.for('dsh-deep-ptc-mode.preset-compat.patch');
// Host packages that must see the exact identity, matched as a path segment under the official scope
// so a third-party package that merely has a similar name is still treated as a plugin.
const HOST_CALLERS = /[\\/]@deepseek-ai[\\/](?:dsh-subagent|dsh-tool-schedule|dsh-agent-preset-registry)[^\\/]*[\\/]/u;
const OFFICIAL_SCOPE = '@deepseek-ai/';
const SELF = 'preset-compat.mjs';
const CODE_EXTENSIONS = ['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts'];
// Build output is scanned: a plugin published as dist/ only has its gate nowhere else.
const SKIP_DIRS = new Set(['node_modules', 'docs', 'test', 'tests', '__tests__', 'examples', 'coverage']);
const MAX_FILES = 800;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
// A cached caller is trusted this long before its package manifest is looked at again.
const FRESH_MS = 5000;

// Both caches are stamped with the package manifest's modification time, so a plugin updated in place
// is probed again, and both are dropped when the layer is disposed.
const packageCache = new Map();
const callerCache = new Map();
const logged = new Set();

function manifestStamp(root) {
  try { return statSync(join(root, 'package.json')).mtimeMs; } catch { return -1; }
}

// Diagnostics go to the host logger of the plugin that installed the layer.
let sink = () => {};
function log(line) {
  try { sink(line); } catch { /* diagnostics only */ }
}

function fileOf(value) {
  try {
    const file = value.startsWith('file:') ? fileURLToPath(value) : value;
    // fileURLToPath yields /C:/... under a POSIX runtime and C:\... on Windows.
    return /^\/[A-Za-z]:[\\/]/u.test(file) ? file.slice(1) : file;
  } catch { return ''; }
}

function isCodeFile(name) {
  return CODE_EXTENSIONS.some(extension => name.endsWith(extension));
}

function isNumber(text) {
  return text.length > 0 && Number.isFinite(Number(text)) && /^[0-9]+$/u.test(text);
}

/** First stack frame outside this module, as an absolute file path. */
export function callerFile(stack) {
  for (const raw of String(stack ?? '').split('\n').slice(1)) {
    if (raw.includes(SELF)) continue;
    // Cordis service proxies insert one infrastructure frame (Object.apply in the
    // host's cordis package) between this wrapper and the real caller. Skip it so
    // the caller's own package, not the proxy, decides the layer.
    if (raw.includes('@deepseek-ai/cordis/')) continue;
    let text = raw.trim();
    if (text.startsWith('at ')) text = text.slice(3).trim();
    if (text.startsWith('async ')) text = text.slice(6).trim();
    const open = text.lastIndexOf('(');
    if (open !== -1 && text.endsWith(')')) text = text.slice(open + 1, -1);
    const parts = text.split(':');
    if (parts.length < 3) continue;
    const col = parts.pop();
    const line = parts.pop();
    if (!isNumber(line) || !isNumber(col)) continue;
    const file = fileOf(parts.join(':'));
    if (file) return file;
  }
  return '';
}

/** Nearest ancestor package.json carrying a name. */
export function packageOf(file) {
  let dir = dirname(file);
  const { root } = parse(dir);
  for (let depth = 0; depth < 12 && dir && dir !== root; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest && typeof manifest.name === 'string') return { root: dir, name: manifest.name };
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const CREATIVE_PRESET_ID = 'cordis';
const BASE_PRESET_IDS = ['ptc', 'standard', 'minimal', CREATIVE_PRESET_ID];
const KNOWN_PRESET_IDS = ['deep-ptc', CREATIVE_PRESET_ID, 'ptc', 'standard', 'minimal'];
const QUOTES = ["'", '"', '`'];
const COMMENT_OR_STRING = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
const PROPERTY_CHAIN = String.raw`(?:${NAME}\s*(?:\?\.|\.)\s*)*`;
const PRESET_CALL = String.raw`${PROPERTY_CHAIN}composedPreset\s*(?:\?\.\s*)?\([^()]*\)`;
const PRESET_ASSIGNMENT = new RegExp(String.raw`\b(?:const|let|var)\s+(${NAME})\s*=\s*${PRESET_CALL}`, 'gu');
const PRESET_NAME = String.raw`[\w$]*preset(?:id|name)?`;

// Keep code and exact preset literals. Other strings stay as empty literals so they cannot form a gate.
function presetSource(source, ids) {
  return source.replace(COMMENT_OR_STRING, token => {
    if (token[0] === '/') return ' ';
    return ids.has(token.slice(1, -1)) ? token : '""';
  });
}

function quotes(text, id) {
  return QUOTES.some(quote => text.includes(quote + id + quote));
}

const BASE_ID = `(?:${QUOTES.flatMap(quote => BASE_PRESET_IDS.map(id => quote + id + quote)).join('|')})`;
const LIST_ITEM = String.raw`(?:${NAME}|"[^"]*"|'[^']*'|\x60[^\x60]*\x60)`;
const BUILTIN_LIST = String.raw`\[\s*(?:${LIST_ITEM}\s*,\s*)*${BASE_ID}\s*(?:,\s*${LIST_ITEM}\s*)*,?\s*\]`;

function presetGate(aliases = []) {
  const names = [PRESET_NAME, ...aliases.map(name => name.replaceAll('$', '\\$'))].join('|');
  const namedValue = String.raw`${PROPERTY_CHAIN}(?:${names})(?![\w$]|\s*(?:[.\[(]|\?\.))`;
  const reference = String.raw`(?<![\w$])(?:${PRESET_CALL}|${namedValue})`;
  return new RegExp([
    String.raw`${reference}\s*[!=]==?\s*${BASE_ID}`,
    String.raw`${BASE_ID}\s*[!=]==?\s*${reference}`,
    String.raw`\bswitch\s*\(\s*${reference}\s*\)\s*\{[^{}]*\bcase\s+${BASE_ID}`,
    String.raw`${BUILTIN_LIST}\s*\)?\s*\.\s*(?:includes|has)\(\s*${reference}`,
    String.raw`\b${PROPERTY_CHAIN}[\w$]*preset(?:s|ids|names)?\s*\.\s*(?:includes|has)\(\s*${BASE_ID}`,
  ].join('|'), 'iu');
}
const DIRECT_GATE = presetGate();

function presetRestricted(text) {
  if (!/preset/iu.test(text)) return false;
  // The dsh-ops mode table is a known preset allowlist.
  if (/\bMODE_PRESET\s*(?:=|[.\[])/u.test(text) || DIRECT_GATE.test(text)) return true;
  const aliases = [...new Set(Array.from(text.matchAll(PRESET_ASSIGNMENT), match => match[1]))].slice(0, 32);
  return aliases.length > 0 && presetGate(aliases).test(text);
}

/** Quoted preset ids this code mentions; the base id a restricted plugin accepts. */
function acceptedPresetIds(text) {
  return KNOWN_PRESET_IDS.filter(id => quotes(text, id));
}

/**
 * Probe one plugin package for the two identity layers. Bounded, and cached until the package's
 * manifest changes.
 * @param root - package root.
 * @param nativeId - the native preset id, normally deep-ptc.
 * @param first - a file to read before walking the package, normally the one that asked: it is the
 *   likeliest place for the gate and must not be lost to the scan limits in a large package.
 * @returns declares: the package knows the native id; restricted: the package gates on preset ids.
 */
export function packageProbe(root, nativeId, first) {
  const key = root + '|' + nativeId;
  const stamp = manifestStamp(root);
  const cached = packageCache.get(key);
  if (cached?.stamp === stamp) return cached.result;
  let files = 0;
  let bytes = 0;
  const result = { declares: false, restricted: false, accepts: [] };
  const accepts = new Set();
  const presetIds = new Set([...KNOWN_PRESET_IDS, nativeId]);
  const seen = new Set();
  const done = () => result.declares || files >= MAX_FILES || bytes >= MAX_TOTAL_BYTES;
  const read = file => {
    if (seen.has(file)) return;
    seen.add(file);
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size <= 0 || size > MAX_FILE_BYTES) return;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return; }
    text = presetSource(text, presetIds);
    if (quotes(text, nativeId)) result.declares = true;
    if (presetRestricted(text)) result.restricted = true;
    for (const id of acceptedPresetIds(text)) accepts.add(id);
    files += 1;
    bytes += size;
  };
  const visit = directory => {
    if (done()) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (done()) return;
      if (entry.name.startsWith('.')) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(full);
      } else if (entry.isFile() && isCodeFile(entry.name)) {
        read(full);
      }
    }
  };
  if (typeof first === 'string' && isCodeFile(first)) read(first);
  visit(root);
  result.accepts = [...accepts];
  packageCache.set(key, { stamp, result });
  return result;
}

/**
 * Resolve the identity one external consumer should see.
 * @param exact - the live composed preset id.
 * @param options - enabled, nativeIds, fallback, creativeFallback and support overrides.
 * @param info - host flag, package name and declaration probe result.
 * @returns the id to report.
 */
export function decidePresetId(exact, options = {}, info = {}) {
  const nativeIds = Array.isArray(options.nativeIds) && options.nativeIds.length > 0
    ? options.nativeIds : ['deep-ptc'];
  if (typeof exact !== 'string' || !nativeIds.includes(exact)) return exact;
  if (options.enabled === false) return exact;
  if (info.host === true) return exact;
  const support = options.support && typeof options.support === 'object' && !Array.isArray(options.support)
    ? options.support : {};
  const override = info.packageName === undefined ? undefined : support[info.packageName];
  if (override === 'native') return exact;
  const fallback = options.fallback || 'ptc';
  if (override === 'base') return fallback;
  // An official plugin knows only the official preset ids, so it always sees the base id.
  if (info.official === true) return fallback;
  // Layer 1: a plugin that does not limit preset names, or that declares the native
  // id itself, keeps deep-ptc.
  if (info.declares === true) return exact;
  if (info.restricted !== true) return exact;
  // Layer 2: a plugin that limits preset names gets a base id. ptc is the normal
  // base; a creative-mode row mounted by the plugin lab may accept only cordis,
  // so use the id its own code actually mentions.
  const accepts = Array.isArray(info.accepts) ? info.accepts : [];
  if (accepts.includes(fallback)) return fallback;
  if (accepts.includes(CREATIVE_PRESET_ID)) return CREATIVE_PRESET_ID;
  return fallback;
}

/**
 * Who is asking, by role rather than by reading its code:
 * - host internals that pass the identity on (subagent children, schedules, the registry) and the
 *   application's own bundled code keep the exact id, so a child or scheduled run stays Deep PTC;
 * - every other official package is a plugin of the product that knows only the official preset
 *   ids, so in a Deep PTC session it sees the base id (computer use, for one, compares its
 *   configured `ptc` with composedPreset);
 * - third-party plugins are probed for their own declaration and gate.
 */
export function callerRole(file, pkg) {
  if (HOST_CALLERS.test(file)) return 'host';
  if (pkg === undefined) return 'host';
  const inPackageTree = /[\\/]node_modules[\\/]/u.test(pkg.root);
  if (file.includes('app.asar') && !inPackageTree) return 'host';
  return pkg.name.startsWith(OFFICIAL_SCOPE) ? 'official' : 'plugin';
}

/** Inspect one call: host frame, or the calling plugin package and its declaration. */
export function inspectCaller(stack, nativeId) {
  const file = callerFile(stack);
  if (!file) return { host: true };
  // Host internals are recognised from the frame path before any file is read.
  if (HOST_CALLERS.test(file)) return { host: true };
  const now = Date.now();
  const cached = callerCache.get(file);
  if (cached?.nativeId === nativeId) {
    if (now - cached.checked < FRESH_MS) return cached.info;
    if (manifestStamp(cached.info.packageRoot) === cached.stamp) {
      cached.checked = now;
      return cached.info;
    }
  }
  const pkg = packageOf(file);
  const role = callerRole(file, pkg);
  if (role === 'host') return { host: true };
  // Official plugins are not probed: their role decides, whatever form their gate takes.
  const info = role === 'official'
    ? { host: false, official: true, packageName: pkg.name, packageRoot: pkg.root }
    : { host: false, packageName: pkg.name, packageRoot: pkg.root, ...packageProbe(pkg.root, nativeId, file) };
  callerCache.set(file, { info, nativeId, stamp: manifestStamp(pkg.root), checked: now });
  return info;
}

function logDecision(info, id) {
  if (!info || typeof info.packageName !== 'string') return;
  const key = info.packageName + '|' + id;
  if (logged.has(key)) return;
  logged.add(key);
  const reason = info.official ? 'official plugin' : info.declares ? 'declares native' : info.restricted ? 'preset restricted' : 'unrestricted';
  log(`decision ${info.packageName} -> ${id} (${reason})`);
}

/**
 * Install the identity layer on the live registry. Idempotent: a second mount
 * (plugin startup plus an explicit compatibility row) keeps the first owner and
 * becomes a no-op.
 * @param ctx - plugin context carrying agentPresets.
 * @param options - options object or a getter returning one.
 * @returns owner handle; dispose() restores the unpatched method.
 */
export function installPresetCompat(ctx, options) {
  const debug = typeof ctx?.logger?.debug === 'function'
    ? line => ctx.logger.debug('Deep PTC preset identity: %s', line)
    : () => {};
  const registry = ctx?.agentPresets;
  const current = registry?.composedPreset;
  // The layer wraps one host method: composedPreset(agentCtx) -> preset id. A host whose method takes
  // a different shape is left untouched rather than wrapped on a guess.
  if (typeof current !== 'function' || current.length > 1) {
    try { debug(typeof current !== 'function' ? 'skip: agentPresets.composedPreset unavailable'
      : `skip: agentPresets.composedPreset takes ${current.length} arguments`); } catch { /* diagnostics only */ }
    return { active: false, owner: false, dispose() {} };
  }
  if (current[PATCH_MARK] === true) return { active: true, owner: false, dispose() {} };
  // Diagnostics follow the owner of the patch, not whichever mount came last.
  sink = debug;
  const hadOwn = Object.hasOwn(registry, 'composedPreset');
  const original = current;
  const patched = function composedPreset(agentCtx) {
    const exact = original.call(registry, agentCtx);
    const now = typeof options === 'function' ? options() : options;
    if (!now || now.enabled === false) return exact;
    const nativeIds = Array.isArray(now.nativeIds) && now.nativeIds.length > 0 ? now.nativeIds : ['deep-ptc'];
    if (typeof exact !== 'string' || !nativeIds.includes(exact)) return exact;
    let info;
    try {
      info = inspectCaller(new Error().stack ?? '', exact);
    } catch (error) {
      log('inspect-error ' + error?.message);
      return exact;
    }
    const id = decidePresetId(exact, now, info);
    logDecision(info, id);
    return id;
  };
  Object.defineProperty(patched, PATCH_MARK, { value: true });
  Object.defineProperty(registry, 'composedPreset', { value: patched, configurable: true, writable: true });
  log('installed');
  return {
    active: true,
    owner: true,
    dispose() {
      if (registry.composedPreset !== patched) return;
      if (hadOwn) Object.defineProperty(registry, 'composedPreset', { value: original, configurable: true, writable: true });
      else delete registry.composedPreset;
      log('disposed');
      // Nothing learned about callers outlives the layer: the next owner probes afresh.
      packageCache.clear();
      callerCache.clear();
      logged.clear();
      sink = () => {};
    },
  };
}

// Compatibility row entry: mount the same layer explicitly (idempotent).
export function apply(ctx, config) {
  const compat = installPresetCompat(ctx, {
    enabled: true,
    nativeIds: ['deep-ptc'],
    fallback: config?.fallback ?? 'ptc',
    support: config?.support && typeof config.support === 'object' ? config.support : {},
  });
  ctx.effect(() => () => compat.dispose(), 'Deep PTC: preset identity compatibility');
}
