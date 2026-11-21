// Rows the official creative-mode preset adds beyond the preset Deep PTC is
// derived from. Module names are copied from that declaration. A renamed
// official package is followed because this file never names one.
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

/** Shipped preset id, the same kind of lookup key as `ptc`. Not a module name. */
export const CREATIVE_PRESET_ID = 'cordis';

function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Pick the creative preset from a live roster.
 * The published name wins, then the shipped id, then a description that says so.
 * @param {Array<{ id?: string, name?: string, description?: string }>} roster
 */
export function selectCreativePreset(roster) {
  const rows = Array.isArray(roster) ? roster.filter(row => row && typeof row === 'object') : [];
  return rows.find(row => row.name === '创造模式')
    ?? rows.find(row => row.id === CREATIVE_PRESET_ID)
    ?? rows.find(row => text(row.description).includes('创造'));
}

function isPersona(row) {
  return row?.id === 'persona' || (typeof row?.name === 'string' && row.name.includes('dsh-persona'));
}

function walk(rows, visit) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    visit(row);
    if (row.group === true && Array.isArray(row.config)) walk(row.config, visit);
  }
}

function pinDir(entry, root) {
  if (!entry || typeof entry !== 'object' || typeof entry.__jsExpr !== 'string') return entry;
  if (!entry.__jsExpr.includes('baseUrl') || !entry.__jsExpr.includes('skills')) return entry;
  if (entry.__jsExpr.includes('@deepseek-ai/dsh-agent-preset/package.json')) {
    try {
      const anchor = import.meta.resolve('@deepseek-ai/dsh-web-app/package.json');
      return join(dirname(createRequire(anchor).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills');
    } catch { return entry; } // The host can still evaluate the original package-relative expression.
  }
  return root ? join(root, 'skills') : entry;
}

function pinDirs(dirs, root) {
  return Array.isArray(dirs) ? dirs.map(entry => pinDir(entry, root)) : dirs;
}

function sameDir(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withPinnedSkillDirs(row, root) {
  const copy = structuredClone(row);
  const dirs = copy?.config?.customSkillDirs;
  if (Array.isArray(dirs)) copy.config = { ...copy.config, customSkillDirs: pinDirs(dirs, root) };
  return copy;
}

/**
 * Collect creative-only rows and merge shared skill directories into the existing provider.
 * @param {object[]} creativePlugins
 * @param {object[]} baselinePlugins Writable copy of the PTC rows for this derivation.
 * @param {{ root?: string }} [options] directory of the creative preset, used to pin skill paths
 */
export function creativeAdditions(creativePlugins, baselinePlugins, options = {}) {
  const root = typeof options.root === 'string' ? options.root : '';
  const baselineById = new Map();
  walk(baselinePlugins, row => { if (typeof row.id === 'string') baselineById.set(row.id, row); });
  const additions = [];
  const seen = new Set();

  const push = row => {
    if (!row || seen.has(row.id)) return;
    seen.add(row.id);
    additions.push(row);
  };

  const consider = row => {
    if (!row || typeof row !== 'object' || isPersona(row)) return;
    const baseline = baselineById.get(row.id);
    if (row.group === true) {
      if (baseline) {
        if (Array.isArray(row.config)) for (const child of row.config) consider(child);
        return;
      }
      push(withPinnedSkillDirs(row, root));
      return;
    }
    if (baseline) {
      const creativeDirs = row.config?.customSkillDirs;
      if (baseline.group === true || !Array.isArray(creativeDirs) || !creativeDirs.length) return;
      const current = baseline.config?.customSkillDirs ?? [];
      if (!Array.isArray(current)) return;
      const merged = [...current];
      for (const dir of pinDirs(structuredClone(creativeDirs), root)) {
        if (!merged.some(existing => sameDir(existing, dir))) merged.push(dir);
      }
      if (merged.length > current.length) baseline.config = { ...baseline.config, customSkillDirs: merged };
      return;
    }
    push(withPinnedSkillDirs(row, root));
  };

  if (Array.isArray(creativePlugins)) {
    for (const row of creativePlugins) consider(row);
  }
  return additions;
}
