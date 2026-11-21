// Name the tools each composed plugin declares. The host records no owner for a registration, so this
// reads the installed source of the loader's rows and the preset's official rows. Reading follows every
// Harness and plugin update without running a module, and a name that cannot be read only stays an
// unattributed external tool.
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveHost } from './host.mjs';

export const OFFICIAL_SCOPE = '@deepseek-ai/';
const OWN_PACKAGE = 'dsh-deep-ptc-mode';
const REFRESH_MS = 1000;
const DECLARED = /(?:defineTool|tools\.register)\(\{\s*name:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))/gu;
// `tools.register(helper("name", …))` and the `const helper = (name, …) => defineTool({ name: name` it calls.
const FACTORY_CALL = /tools\.register\(\s*([A-Za-z_$][\w$]*)\(\s*["']([^"']+)["']/gu;
const IDENTIFIER = String.raw`([A-Za-z_$][\w$]*)`;
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const factoryDefinition = helper => new RegExp(
  String.raw`(?:const|let|var)\s+${escapeRegExp(helper)}\s*=\s*\(\s*${IDENTIFIER}[^)]*\)\s*=>\s*defineTool\(\{\s*name:\s*${IDENTIFIER}`, 'u');

function identifierValue(source, identifier) {
  const id = escapeRegExp(identifier);
  // `const NAME = "x"`, or a configurable name with its default: `toolName: z.string().default("x")`.
  return new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*=\\s*["']([^"']+)["']`, 'u').exec(source)?.[1]
    ?? new RegExp(`\\b${id}\\b[^\\n;]*?(?:\\.default\\(|\\?\\?\\s*)["']([^"']+)["']`, 'u').exec(source)?.[1];
}

export function toolNamesInSource(source) {
  const names = new Set();
  for (const match of source.matchAll(DECLARED)) {
    const name = match[1] ?? match[2] ?? identifierValue(source, match[3]);
    if (name !== undefined) names.add(name);
  }
  // A local factory may pass its first argument directly to defineTool's name.
  for (const [, helper, name] of source.matchAll(FACTORY_CALL)) {
    const [, parameter, nameArgument] = factoryDefinition(helper).exec(source) ?? [];
    if (parameter !== undefined && parameter === nameArgument) names.add(name);
  }
  return names;
}

const sourceCache = new Map();
function installedSource(moduleName, base) {
  let file;
  if (base !== undefined) {
    try {
      file = createRequire(base).resolve(moduleName);
    } catch {
      // Not installed beside this tree; the runtime's own graph may still hold it.
    }
  }
  if (file === undefined) {
    const url = resolveHost(moduleName);
    if (url !== undefined) file = fileURLToPath(url);
  }
  if (file === undefined) throw new Error(`cannot resolve ${moduleName}`);
  const stat = statSync(file);
  const stamp = `${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  let row = sourceCache.get(file);
  if (row?.stamp !== stamp) {
    row = { stamp, text: readFileSync(file, 'utf8') };
    sourceCache.set(file, row);
  }
  return row;
}

/**
 * Attribute tool names to the modules that declare them.
 * @param getLoader - current root loader, whose rows hold the profile's tools.
 * @param modules - the preset's official rows, `{ name, toolName? }`, which the root loader does not list.
 * @param readSource - source reader, replaced in tests.
 * @param base - resolution base for `modules`.
 */
export function toolDirectory(getLoader, { modules = [], readSource = installedSource, base, refreshMs = REFRESH_MS } = {}) {
  const scanned = new Map();
  const namesIn = (moduleName, rowBase) => {
    const key = `${moduleName}\0${rowBase ?? ''}`;
    try {
      // A reader returns `{ stamp, text }`, or plain text that is its own stamp.
      const read = readSource(moduleName, rowBase);
      const { stamp, text } = typeof read === 'string' ? { stamp: read, text: read } : read;
      let cached = scanned.get(key);
      if (cached === undefined || cached.stamp !== stamp) {
        cached = { stamp, names: toolNamesInSource(text) };
        scanned.set(key, cached);
      }
      return cached.names;
    } catch {
      scanned.delete(key);
      return new Set();
    }
  };
  let view;
  let viewedAt = -Infinity;
  const refresh = () => {
    if (view !== undefined && Date.now() - viewedAt < refreshMs) return view;
    const official = new Set();
    const providers = new Map();
    const add = (name, moduleName, isOfficial) => {
      if (isOfficial) official.add(name);
      if (isOfficial || !providers.has(name)) providers.set(name, moduleName);
    };
    let entries = [];
    try {
      entries = [...getLoader()?.entries?.() ?? []];
    } catch {
      // Attribution is optional; without rows every tool simply stays unattributed.
    }
    for (const entry of entries) {
      const moduleName = entry.options?.name;
      if (entry.disabled || typeof moduleName !== 'string' || moduleName.startsWith('cordis:') || moduleName.startsWith(OWN_PACKAGE)) continue;
      const isOfficial = moduleName.startsWith(OFFICIAL_SCOPE);
      for (const name of namesIn(moduleName, entry.parent?.tree?.ctx?.baseUrl)) add(name, moduleName, isOfficial);
      // Tools named by their row's configuration, such as the subagent tools.
      if (typeof entry.options.config?.toolName === 'string') add(entry.options.config.toolName, moduleName, isOfficial);
    }
    for (const { name: moduleName, toolName } of modules) {
      for (const name of namesIn(moduleName, base)) add(name, moduleName, true);
      if (typeof toolName === 'string') add(toolName, moduleName, true);
    }
    view = { official, providers };
    viewedAt = Date.now();
    return view;
  };
  return {
    isOfficial: name => refresh().official.has(name),
    providerOf: name => refresh().providers.get(name),
    isExternal: name => {
      const { official, providers } = refresh();
      const provider = providers.get(name);
      return !!provider && !official.has(name) && !provider.startsWith(OFFICIAL_SCOPE);
    },
    namesOf: moduleName => namesIn(moduleName, base),
  };
}
