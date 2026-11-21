// Load host modules by the names the official declarations use. Nothing here names an official tool:
// callers pass the module name read from the installed Harness, so a rename or replacement upstream
// is followed instead of breaking a hard-coded import.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { OFFICIAL_PACKAGE } from './upstream.mjs';
import { adaptContext, registering } from './adapt.mjs';
import { markOfficialTool } from './tool-policy.mjs';

function anchor() {
  try {
    return import.meta.resolve(`${OFFICIAL_PACKAGE}/package.json`);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a host module the way the installed runtime would.
 * A linked installation only routes peer-declared names to the runtime, so a name the official
 * declaration introduces later is resolved from the runtime's own package graph instead.
 * @returns a URL, or undefined when the runtime does not provide the module.
 */
export function resolveHost(specifier) {
  try {
    return import.meta.resolve(specifier);
  } catch {
    // Not routed for this plugin; ask the runtime's graph.
  }
  const from = anchor();
  if (from === undefined) return undefined;
  try {
    return pathToFileURL(createRequire(from).resolve(specifier)).href;
  } catch {
    return undefined;
  }
}

export async function importHost(specifier) {
  const url = resolveHost(specifier);
  if (url === undefined) throw new Error(`the installed Harness provides no module ${JSON.stringify(specifier)}`);
  return import(url);
}

// The Cordis plugin a module exports: the namespace itself, or its default export.
export function pluginOf(namespace) {
  if (typeof namespace?.apply === 'function') return namespace;
  return namespace?.default ?? namespace;
}

async function started(ctx, plugin, options) {
  const fiber = ctx.plugin(plugin, options);
  try { await fiber.await(); return fiber; } catch (error) { await fiber.dispose(); throw error; }
}

/**
 * Start the official plugin `upstream` with its own inject list and Config, giving its apply an
 * adapted context and Deep PTC's `overrides` on top of its official options. If that fails, or the plugin
 * has another shape, it runs as the official row would: an official tool keeps working without the
 * Deep PTC behaviour, and only a failure of the official plugin itself reaches the preset.
 */
export async function applyOfficial(ctx, upstream, options, adapt, overrides) {
  const plugin = pluginOf(await importHost(upstream));
  const tagged = child => adapt(adaptContext(child, {
    tools: tools => registering(tools, definition => markOfficialTool(definition, upstream)),
  }));
  const merged = overrides === undefined ? options : { ...options, ...overrides };
  let adapted;
  if (typeof plugin === 'function') {
    adapted = /^\s*class\b/u.test(Function.prototype.toString.call(plugin))
      ? class TaggedOfficial extends plugin { constructor(child, ...args) { super(tagged(child), ...args); } }
      : { ...plugin, name: plugin.name || upstream, apply: (child, config) => plugin(tagged(child), config) };
  } else if (typeof plugin?.apply === 'function') {
    adapted = { ...plugin, name: plugin.name ?? upstream, apply: (child, config) => plugin.apply(tagged(child), config) };
  }
  if (adapted === undefined) {
    ctx.logger.warn('Deep PTC: %s has an unknown plugin shape; running it without Deep PTC behaviour', upstream);
    return started(ctx, plugin, options);
  }
  try {
    return await started(ctx, adapted, merged);
  } catch (error) {
    ctx.logger.warn('Deep PTC: %s failed with Deep PTC behaviour (%s); running it as declared', upstream, error?.message);
    return started(ctx, plugin, options);
  }
}
