// Locate and parse the official PTC agent preset the installed dsh ships.
//
// Deep PTC derives its own preset from this declaration instead of freezing a
// copy: rows the official preset gains, renames or reconfigures are inherited,
// and the plugin only replaces the parts it actually owns (persona, execution
// environment, reachability guard, job/question wrappers).
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { CREATIVE_PRESET_ID, selectCreativePreset } from './creative.mjs';

export const OFFICIAL_PACKAGE = '@deepseek-ai/dsh-web-app';
const PACKAGE = OFFICIAL_PACKAGE;
const PRESET_PATH = 'presets/ptc.patch.yml';
/** Preset identity the plugin composes from. */
export const OFFICIAL_PRESET_ID = 'ptc';
/** Module specifier of the shipped declaration, resolvable through the host's runtime resolution. */
export const OFFICIAL_PRESET_SPECIFIER = `${PACKAGE}/${PRESET_PATH}`;
/** Diagnostics-only override, e.g. a snapshot path or a file URL. */
export const PRESET_PATH_ENV = 'DSH_DEEP_PTC_PRESET';

// The declaration is YAML, so the plugin needs js-yaml. In the desktop host
// the parser belongs to the installed runtime: load it through the runtime's
// module graph so a linked installation keeps working without its own
// node_modules. Peer-declaring the package (see package.json) is what lets the
// host route this bare specifier to the installation; the remaining strategies
// also cover a plain repository run and non-flat installs.
let yamlModule;
let yamlFailure;
function loadYaml() {
  if (yamlModule !== undefined) return yamlModule;
  try {
    yamlModule = createRequire(import.meta.url)('js-yaml');
    return yamlModule;
  } catch (error) {
    yamlFailure = error;
  }
  let packageFile;
  try {
    packageFile = fileURLToPath(import.meta.resolve(`${PACKAGE}/package.json`));
  } catch (error) {
    throw yamlFailure ?? error;
  }
  try {
    yamlModule = createRequire(packageFile)('js-yaml');
    return yamlModule;
  } catch {
    // The parser may be hoisted beside the runtime package instead.
  }
  let directory = dirname(packageFile);
  while (true) {
    const candidate = join(directory, 'node_modules', 'js-yaml', 'package.json');
    if (existsSync(candidate)) {
      yamlModule = createRequire(join(directory, 'node_modules', 'package.json'))('js-yaml');
      return yamlModule;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw yamlFailure;
}

/** YAML dialect of the Loader: `!!js` scalars stay expression nodes for the host to evaluate. */
export function presetSchema() {
  const yaml = loadYaml();
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: data => typeof data === 'string',
    construct: data => ({ __jsExpr: data }),
  });
  return yaml.JSON_SCHEMA.extend(JsExpr);
}

/**
 * Read the `ptc` agent-preset declaration out of a PTC patch document.
 *
 * The document is a list of patch layers; the declaration lives in an `insert`
 * list. Future revisions may move it, so every layer is inspected, but only a
 * declaration explicitly identified as `ptc` is accepted: composing Deep PTC
 * from an unrelated preset would be worse than reporting the declaration
 * missing.
 * @param text - YAML source of the official PTC preset patch.
 * @returns Parsed preset configuration (`{ id, order, plugins, ... }`).
 */
export function parseOfficialPreset(text) {
  const document = loadYaml().load(text, { schema: presetSchema() });
  const layers = Array.isArray(document) ? document : [];
  const inserted = [];
  const collect = rows => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) if (row && typeof row === 'object') inserted.push(row);
  };
  collect(layers);
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    collect(layer.insert);
  }
  const declarations = inserted
    .map(row => row.config)
    .filter(config => config && Array.isArray(config.plugins));
  const preset = declarations.find(config => config.id === OFFICIAL_PRESET_ID);
  if (!preset) {
    const found = declarations.map(config => JSON.stringify(config.id ?? null)).join(', ');
    throw new Error(`${OFFICIAL_PRESET_SPECIFIER} declares no agent preset with id "${OFFICIAL_PRESET_ID}"${found ? ` (found ${found})` : ''}`);
  }
  return preset;
}

/** Base deployment declaration that names the shell executors the Harness ships. */
export const BASE_DECLARATION_SPECIFIER = '@deepseek-ai/dsh-base/cordis.patch.yml';
const EXECUTOR_ROW_IDS = { bash: 'bash-sandbox', pwsh: 'pwsh-sandbox' };

/**
 * Read the official bash and PowerShell executor rows out of the base deployment declaration.
 * @param text - YAML source of `@deepseek-ai/dsh-base/cordis.patch.yml`.
 * @returns `{ bash?, pwsh? }`, each `{ name, config? }` as the declaration states it.
 */
export function parseOfficialExecutors(text) {
  const document = loadYaml().load(text, { schema: presetSchema() });
  const found = {};
  const visit = rows => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const [kind, id] of Object.entries(EXECUTOR_ROW_IDS)) {
        if (row.id !== id || typeof row.name !== 'string' || found[kind] !== undefined) continue;
        const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config : undefined;
        found[kind] = { name: row.name, ...config === undefined ? {} : { config } };
      }
      visit(row.insert);
      if (Array.isArray(row.config)) visit(row.config);
    }
  };
  visit(Array.isArray(document) ? document : []);
  return found;
}

function tryResolve(specifier) {
  try {
    return import.meta.resolve(specifier);
  } catch {
    return undefined;
  }
}

function packageFileUrl() {
  const direct = tryResolve(OFFICIAL_PRESET_SPECIFIER);
  if (direct !== undefined) return direct;
  for (const specifier of [`${PACKAGE}/package.json`, PACKAGE]) {
    const url = tryResolve(specifier);
    if (url === undefined) continue;
    try {
      const file = fileURLToPath(url);
      if (file.endsWith('package.json')) return pathToFileURL(join(dirname(file), PRESET_PATH)).href;
      // A package-root export may point at any file; the declaration sits beside the package.
      let dir = dirname(file);
      while (dir !== dirname(dir)) {
        if (dir.endsWith(PACKAGE) || dir.endsWith(PACKAGE.replace('/', '-'))) break;
        dir = dirname(dir);
      }
      return pathToFileURL(join(dir, PRESET_PATH)).href;
    } catch {
      // Try the next strategy.
    }
  }
  return undefined;
}

/**
 * Resolve the installed declaration to a file URL.
 * @returns `file:` URL, or `undefined` when the runtime exposes none.
 */
export function officialPresetUrl() {
  const override = process.env[PRESET_PATH_ENV]?.trim();
  if (override) {
    if (override.startsWith('file:')) return override;
    return pathToFileURL(isAbsolute(override) ? override : resolve(override)).href;
  }
  return packageFileUrl();
}

/**
 * Load the official PTC preset from the installed runtime.
 * @param options - `presetPath` reads one explicit file (path or file URL) instead of the runtime declaration.
 * @returns The parsed preset and where it came from.
 */
export function loadOfficialPreset({ presetPath } = {}) {
  const url = presetPath === undefined
    ? officialPresetUrl()
    : presetPath instanceof URL ? presetPath.href
    : pathToFileURL(isAbsolute(presetPath) ? presetPath : resolve(presetPath)).href;
  if (url === undefined) {
    throw new Error(`cannot resolve ${OFFICIAL_PRESET_SPECIFIER}; set ${PRESET_PATH_ENV} to its path`);
  }
  const text = readFileSync(fileURLToPath(url), 'utf8');
  return { preset: parseOfficialPreset(text), source: url };
}

function pluginRows(value) {
  return Array.isArray(value) && value.length > 0
    && value.every(row => row && typeof row === 'object' && typeof row.name === 'string');
}

/** A creative-mode composition list, or the creative preset inside a patch document. */
export function parseCreativeDocument(text) {
  const document = loadYaml().load(text, { schema: presetSchema() });
  if (pluginRows(document)) return document;
  const layers = Array.isArray(document) ? document : [];
  const inserted = [];
  const collect = rows => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) if (row && typeof row === 'object') inserted.push(row);
  };
  collect(layers);
  for (const layer of layers) collect(layer?.insert);
  const presets = inserted.map(row => row.config).filter(config => config && pluginRows(config.plugins));
  const preset = presets.find(config => config.id === CREATIVE_PRESET_ID || config.name === '创造模式');
  if (!preset) throw new Error('installed creative preset has no composition');
  return preset.plugins;
}

function compositionRoot(path) {
  if (typeof path !== 'string' || path === '') return '';
  try {
    return dirname(path.startsWith('file:') ? fileURLToPath(path) : path);
  } catch {
    return '';
  }
}

/**
 * File URL of the shipped creative preset.
 * The directory id is the same kind of key as `ptc`. The composition filename is whatever
 * that directory actually contains, so an official rename of the file still resolves.
 */
export function creativePresetUrl() {
  const shipped = tryResolve(`${PACKAGE}/presets/cordis.patch.yml`);
  if (shipped && existsSync(fileURLToPath(shipped))) return shipped;
  const pkg = tryResolve('@deepseek-ai/dsh-agent-presets/package.json');
  if (pkg === undefined) return undefined;
  const dir = join(dirname(fileURLToPath(pkg)), 'presets', CREATIVE_PRESET_ID);
  if (!existsSync(dir)) return undefined;
  let names = [];
  try { names = readdirSync(dir).filter(name => name.endsWith('.yml') || name.endsWith('.yaml')); } catch { return undefined; }
  const named = names.find(name => name.startsWith('agent.')) ?? names[0];
  return named === undefined ? undefined : pathToFileURL(join(dir, named)).href;
}

/**
 * Read the creative preset the running host publishes.
 * Module names come from that document. An unreadable preset throws so the caller can keep PTC only.
 */
export async function loadCreativePreset(registry) {
  let roster = [];
  if (typeof registry?.list === 'function') {
    try { roster = await registry.list(); } catch { roster = []; }
  }
  const selected = selectCreativePreset(roster);
  if (!process.env[PRESET_PATH_ENV]?.trim() && selected && typeof registry?.readDocument === 'function') {
    try {
      const document = await registry.readDocument(selected.id);
      return { plugins: parseCreativeDocument(document.content), root: compositionRoot(selected.path),
        source: `agentPresets.readDocument(${selected.id})` };
    } catch { /* initializing registries can still provide an installed declaration */ }
  }
  if (typeof selected?.path === 'string' && selected.path !== '' && existsSync(selected.path.startsWith('file:') ? fileURLToPath(selected.path) : selected.path)) {
    const file = selected.path.startsWith('file:') ? fileURLToPath(selected.path) : selected.path;
    return { plugins: parseCreativeDocument(readFileSync(file, 'utf8')), root: dirname(file), source: file };
  }
  const url = creativePresetUrl();
  if (url === undefined) throw new Error('creative preset is not installed');
  return {
    plugins: parseCreativeDocument(readFileSync(fileURLToPath(url), 'utf8')),
    root: dirname(fileURLToPath(url)),
    source: url,
  };
}

/** Prefer the running host's public preset registry, including its live composition. */
export async function loadCurrentPreset(registry) {
  if (!process.env[PRESET_PATH_ENV]?.trim() && typeof registry?.readDocument === 'function') {
    try {
      const document = await registry.readDocument(OFFICIAL_PRESET_ID);
      const plugins = loadYaml().load(document.content, { schema: presetSchema() });
      if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('empty official composition');
      return {
        preset: { id: OFFICIAL_PRESET_ID, name: document.name, description: document.description, plugins },
        source: 'agentPresets.readDocument(ptc)',
      };
    } catch {
      // Older or initializing registries fall back to installed declaration discovery.
    }
  }
  return loadOfficialPreset();
}
