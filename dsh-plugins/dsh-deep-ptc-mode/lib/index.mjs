import z from '@deepseek-ai/schemastery';
import snapshot from './preset.json' with { type: 'json' };
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CREATIVE_PRESET_ID } from './creative.mjs';
import { extensible } from './mapped-shell.mjs';
import { normalizePreferences } from './tool-policy.mjs';
import { normalizeToolOverrides, overrideRows } from './tool-overrides.mjs';
import { availableEnvironments, BASE_SNAPSHOT, DEFAULT_FOREGROUND_SECONDS, deriveDeepPtc, normalizeDisabledShellTools, normalizeDistribution, resolveEnvironment } from './model.mjs';
import { discoverShells, probeExecutable, resolveShellExecutable, resolveWindowsBash, shellNote } from './shells.mjs';
import { BASE_DECLARATION_SPECIFIER, creativePresetUrl, loadCreativePreset, loadCurrentPreset, officialPresetUrl, parseOfficialExecutors } from './upstream.mjs';
import { importHost, pluginOf, resolveHost } from './host.mjs';
import { presetLifecycle } from './lifecycle.mjs';
import { installPresetCompat } from './preset-compat.mjs';
import { checkBeforeResolve } from './freshness.mjs';
import { classifyDiagnosis, touchesExecution } from './preset-health.mjs';
import { applyActivity } from './session-activity.mjs';
import { findSshClient, readSshHosts, sshGuidance } from './ssh.mjs';
import { apply as applyCards } from './cards-context.mjs';
import { apply as applyBrief } from './brief-context.mjs';
import { apply as applyVirtualDsh } from './virtual-dsh.mjs';
import { apply as applyProject } from './project-context.mjs';
import { installProgressReminder } from './progress.mjs';
import { apply as applySkillContext } from './skill-context.mjs';
import { applyRoot as applyToolStateRoot } from './tool-state.mjs';

function whereExecutable(name) {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = spawnSync(command, [name], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    if (result.status !== 0 || typeof result.stdout !== 'string') return [];
    return result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const executableExists = path => probeExecutable(path) !== undefined;

const discoveredShells = discoverShells({
  platform: process.platform,
  env: process.env,
  probe: probeExecutable,
  where: whereExecutable,
});

const sshClient = findSshClient({ exists: executableExists });

function shellFamily(environment) {
  return environment === 'powershell' || environment === 'bash' || environment === 'zsh' ? environment : '';
}

export const name = 'deep-ptc-settings';
export const inject = ['agentPresets'];
export const Config = z.object({
  environment: z.union(availableEnvironments(process.platform)).default('auto').volatile(),
  wslDistribution: z.string().pattern(/^(?!\s*-)[^\u0000-\u001f\u007f]*$/u).default('').volatile(),
  shellExecutable: z.string().default('').volatile(),
  // Changes publish a new preset generation; active conversations keep their lease.
  pluginLab: z.boolean().default(false).volatile(),
  shellChoices: z.array(z.object({
    id: z.string(), label: z.string(), path: z.string(), family: z.string(),
  })).default(discoveredShells).volatile(),
  // Read-only facts for the client panel: the OpenSSH client and the configured host aliases.
  sshClient: z.string().default(sshClient).volatile(),
  sshHosts: z.array(z.object({
    alias: z.string(), hostName: z.string().default(''), user: z.string().default(''), port: z.string().default(''),
  })).default(readSshHosts().map(host => ({ hostName: '', user: '', port: '', ...host }))).volatile(),
  foregroundSeconds: z.number().step(1).min(5).max(600).default(DEFAULT_FOREGROUND_SECONDS).volatile(),
  toolCompatibility: z.boolean().default(true).volatile(),
  toolPreferences: z.any().default([]).volatile(),
  compactToolCatalog: z.boolean().default(true).volatile(),
  hostPlatform: z.const(process.platform).default(process.platform).volatile(),
  // Session-scoped preset identity compatibility (native id first, base fallback).
  presetCompat: z.boolean().default(true).volatile(),
  presetFallback: z.string().default('ptc').volatile(),
  presetSupport: z.any().default({}).volatile(),
  // Shell tool kinds (bash, pwsh, zsh) whose Deep PTC tool row is published disabled, so another
  // plugin's tool can be the only entry for that shell (#23). Empty keeps every shell tool.
  disabledShellTools: z.array(z.string()).default([]).volatile(),
  toolOverrides: overrideRows.volatile(),
  // Conversation cards (ui_card) and project cards (PROJECT-CARDS.md). Both on by default.
  conversationCards: z.boolean().default(true).volatile(),
  projectCards: z.boolean().default(true).volatile(),
  // Task brief: the conversation's goals, constraints and acceptance criteria. On by default.
  taskBrief: z.boolean().default(true).volatile(),
});

// Tool preferences are advice for the model, so a malformed list must not cost the preset.
function preferencesOf(ctx, config) {
  try {
    return normalizePreferences(config.toolPreferences.get());
  } catch (error) {
    ctx.logger.warn('Deep PTC: ignoring toolPreferences (%s)', error.message);
    return [];
  }
}

function settingsOf(ctx, config) {
  return {
    environment: config.environment.get(),
    wslDistribution: normalizeDistribution(config.wslDistribution.get()),
    shellExecutable: config.shellExecutable.get(),
    pluginLab: config.pluginLab?.get() === true,
    foregroundSeconds: config.foregroundSeconds.get(),
    toolCompatibility: config.toolCompatibility.get(),
    toolPreferences: preferencesOf(ctx, config),
    compactToolCatalog: config.compactToolCatalog.get(),
    disabledShellTools: normalizeDisabledShellTools(config.disabledShellTools.get()),
    toolOverrides: normalizeToolOverrides(config.toolOverrides?.get()),
    projectCards: config.projectCards.get() !== false,
    conversationCards: config.conversationCards.get() !== false,
    taskBrief: config.taskBrief.get() !== false,
  };
}

// The shell the selected environment runs: environment, WSL distribution and executable. The
// preset's shell rows and the card buttons both use it, so a choice holds everywhere it applies.
function shellSelection(ctx, settings, warn = true) {
  const environment = resolveEnvironment(settings.environment);
  const family = shellFamily(environment);
  if (!family) return { environment, distribution: settings.wslDistribution, executable: '' };
  const requested = typeof settings.shellExecutable === 'string' ? settings.shellExecutable : '';
  const windowsBash = process.platform === 'win32' && environment === 'bash';
  const resolved = windowsBash ? resolveWindowsBash(requested, executableExists)
    : resolveShellExecutable(requested, { family, discovered: discoveredShells, exists: executableExists });
  if (warn && windowsBash && !resolved) {
    ctx.logger.warn('Deep PTC: Windows Bash requires an available absolute path to bash.exe; retaining the official shell rows');
  } else if (warn && requested && requested !== 'auto' && !resolved) {
    ctx.logger.warn('Deep PTC: selected shell %s is not available; using the automatic executable', requested);
  }
  return { environment, distribution: settings.wslDistribution, executable: resolved,
    note: shellNote({ family, executable: resolved }) };
}

// The shell executors the installed Harness declares in its base deployment, by kind.
function officialExecutors(ctx) {
  try {
    const url = resolveHost(BASE_DECLARATION_SPECIFIER);
    if (url === undefined) throw new Error(`cannot resolve ${BASE_DECLARATION_SPECIFIER}`);
    const executors = parseOfficialExecutors(readFileSync(fileURLToPath(url), 'utf8'));
    for (const kind of ['bash', 'pwsh']) if (executors[kind] === undefined)
      ctx.logger.warn('Deep PTC: %s declares no %s executor; using the bundled snapshot entry', url, kind);
    return { ...BASE_SNAPSHOT, ...executors };
  } catch (error) {
    ctx.logger.warn('Deep PTC: official executors unavailable (%s); using the bundled snapshot', error.message);
    return BASE_SNAPSHOT;
  }
}

// WSL and Zsh extend the official bash executor class. Probe it before choosing that path so an
// incompatible Harness falls back to the official shell rows instead of a preset that cannot mount.
async function canExtend(ctx, executor) {
  try {
    const Base = pluginOf(await importHost(executor.name));
    if (extensible(Base)) return true;
    ctx.logger.warn('Deep PTC: %s no longer exposes the executor API WSL/Zsh extend', executor.name);
  } catch (error) {
    ctx.logger.warn('Deep PTC: cannot load %s (%s)', executor.name, error.message);
  }
  return false;
}

// Derive Deep PTC from the PTC preset the installed Harness declares, so an
// official change is inherited instead of leaving a stale frozen row behind.
// The bundled snapshot is only a fallback when the installed declaration
// cannot be read or cannot be composed.
async function buildPreset(ctx, config, health) {
  const safeMode = health.safeMode;
  const settings = { ...settingsOf(ctx, config), safeMode, safeModeReason: health.reason,
    safeKeepsExecution: health.keepsExecution === true };
  const executors = officialExecutors(ctx);
  const selected = shellSelection(ctx, settings);
  const environment = selected.environment;
  settings.shellExecutable = selected.executable;
  if (selected.note) settings.shellNote = selected.note;
  if (environment === 'wsl' || environment === 'zsh' || (environment === 'bash' && settings.shellExecutable)) {
    settings.mappedExecutor = await canExtend(ctx, executors.bash);
  }
  settings.pluginLab = settings.pluginLab && !safeMode;
  if (settings.pluginLab) {
    try {
      const creative = await loadCreativePreset(ctx.agentPresets);
      settings.creativePlugins = creative.plugins;
      settings.creativeRoot = creative.root;
      ctx.logger.info('Deep PTC: plugin lab reading %s', creative.source);
    } catch (error) {
      settings.pluginLab = false;
      ctx.logger.warn('Deep PTC: creative preset unavailable (%s); continuing with the PTC tools', error.message);
    }
  }
  settings.executors = executors;
  settings.sshGuidance = sshGuidance({ environment, client: sshClient, hosts: readSshHosts() });
  let upstream = snapshot;
  let source = 'bundled snapshot';
  try {
    const official = await loadCurrentPreset(ctx.agentPresets);
    upstream = official.preset;
    source = official.source;
  } catch (error) {
    ctx.logger.warn('Deep PTC: official PTC preset unavailable (%s); deriving from the bundled snapshot', error.message);
  }
  try {
    const { preset, report } = deriveDeepPtc(upstream, settings);
    ctx.logger.info(
      'Deep PTC preset derived from %s: %d official rows; persona %s; environment %s; shell rows [%s]; wrapped [%s]; skipped [%s]',
      source, report.upstreamRows, report.persona, report.environment,
      report.replacedShellRows.join('; ') || '-', report.wrapped.join(', ') || '-', report.skipped.join('; ') || '-',
    );
    return preset;
  } catch (error) {
    if (upstream === snapshot) throw error;
    ctx.logger.warn('Deep PTC: deriving from %s failed (%s); deriving from the bundled snapshot', source, error.message);
    return deriveDeepPtc(snapshot, settings).preset;
  }
}

// Nothing in apply() waits for another service, so this plugin never holds the Host boot (#18). Each
// part starts when its own services are ready, and only what needs it waits for it.
export function apply(ctx, config) {
  ctx.inject(['systemPrompt'], child => installProgressReminder(child, { questionCards: () => config.conversationCards.get() }));
  // Safe mode holds until our settings or the upstream declarations change, or DSH restarts.
  const health = { safeMode: false, reason: '', keepsExecution: false };
  // These layers start as soon as the host provides commands and session projections. A projection
  // registered after histories load still folds the whole log on first read, so starting late loses
  // nothing; a layer whose services fail logs and turns off only its own card.
  // The skill card is a profile-level session projection, not an agent-preset row:
  // that keeps it available in existing Deep PTC sessions after an upgrade. Its
  // command and pre-step paths are gated to deep-ptc sessions below.
  void applySkillContext(ctx);
  // The tool state and its reset command follow the same rule, so the side card works in idle sessions too.
  void applyToolStateRoot(ctx);
  // Conversation cards: a profile-level projection, command and tool, like the skill card, so a
  // card works in any session and survives turns.
  // Settings switches take effect at once: listeners re-check them on every settings change.
  const settingListeners = new Set();
  const watch = listener => { settingListeners.add(listener); return () => settingListeners.delete(listener); };
  ctx.on('loader/volatile-update', () => { for (const listener of settingListeners) listener(); });
  const conversationCards = () => config.conversationCards.get();
  const projectCards = () => config.projectCards.get();
  void applyProject(ctx, { enabled: projectCards, watch });
  void applyCards(ctx, { enabled: conversationCards, watch });
  void applyBrief(ctx, { enabled: () => config.taskBrief.get(), watch });
  // Output files and SSH connections per conversation, for the side panel.
  void applyActivity(ctx);
  // Deep creative mode's Virtual DSH button: a copy of this DSH's environment, run on request.
  void applyVirtualDsh(ctx, { enabled: () => config.pluginLab?.get() === true, watch });
  const lifecycle = presetLifecycle(
    definition => ctx.agentPresets.register(definition),
    () => buildPreset(ctx, config, health),
    error => ctx.logger.error('Deep PTC environment update failed: %s', error.message),
  );
  ctx.effect(() => () => lifecycle.dispose());
  // Session-scoped preset identity: report the native deep-ptc id first; an external
  // consumer that does not declare support for it gets the base preset id instead.
  const compat = installPresetCompat(ctx, () => {
    if (config.presetCompat.get() === false) return { enabled: false };
    let support = {};
    try {
      const raw = config.presetSupport.get();
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) support = raw;
    } catch { /* keep the empty override list */ }
    return { enabled: true, nativeIds: ['deep-ptc'], fallback: config.presetFallback.get() || 'ptc', support };
  });
  ctx.effect(() => () => compat.dispose(), 'Deep PTC: session-scoped preset identity');
  // A preset the host refuses to mount would leave its sessions unusable, so fall back to the official
  // composition with the persona. Only rows that failed count: a row still waiting for a service can
  // come up by itself, and its absence costs that row's feature, not the preset. Not awaited: reading
  // the diagnosis waits for the host tree.
  const verify = async () => {
    const row = (await ctx.agentPresets.compositionInventory?.())?.find(candidate => candidate.id === 'deep-ptc');
    const { failed, pending } = classifyDiagnosis(row?.broken);
    if (pending.length > 0) ctx.logger.info('Deep PTC: rows waiting for host services, kept in the preset: %s', pending.join('; '));
    if (health.safeMode || failed.length === 0) return;
    const reason = failed.join('; ');
    ctx.logger.warn('Deep PTC: preset cannot mount (%s); using safe mode until settings or upstream presets change', reason);
    health.safeMode = true;
    health.reason = reason;
    // Safe mode keeps the selected shell unless the execution rows are what failed: falling back to
    // the official shell would quietly switch WSL users to PowerShell.
    health.keepsExecution = !failed.some(touchesExecution);
    await lifecycle.refresh();
  };
  const refreshed = () => lifecycle.refresh().then(() => { void verify().catch(() => {}); });
  // Read the installed declarations, not fixture versions. Refresh only when our settings or
  // upstream declaration bytes change. Existing sessions keep their leased preset generation.
  // The check runs when settings change and once before each Deep PTC conversation starts; no timer.
  const signature = async () => {
    const read = url => {
      try { return readFileSync(fileURLToPath(url), 'utf8'); } catch { return ''; }
    };
    const document = async id => {
      try { return JSON.stringify(await ctx.agentPresets.readDocument?.(id)); } catch { return ''; }
    };
    const settings = settingsOf(ctx, config);
    return [JSON.stringify(settings), await document('ptc'), settings.pluginLab ? await document(CREATIVE_PRESET_ID) : '',
      read(officialPresetUrl()), read(resolveHost(BASE_DECLARATION_SPECIFIER)), settings.pluginLab ? read(creativePresetUrl()) : ''].join('\0');
  };
  let previous;
  // The first publication runs in the background. A Deep PTC conversation waits for it through the
  // resolve check below, so a slow preset registry delays that conversation, never the Host boot.
  const published = (async () => {
    try { previous = await signature(); } catch (error) {
      ctx.logger.warn('Deep PTC: could not read the upstream presets at start (%s)', error.message);
    }
    // A failed publication is reported by the lifecycle and retried on the next change.
    await refreshed().catch(() => {});
  })();
  let detecting;
  let active = true;
  // Concurrent callers share one check, so several conversations opening together read once.
  const detect = () => detecting ??= (async () => {
    try {
      await published;
      const current = await signature();
      if (!active || current === previous) return;
      previous = current;
      health.safeMode = false;
      health.reason = '';
      health.keepsExecution = false;
      await refreshed().catch(() => {});
    } catch (error) {
      ctx.logger.warn('Deep PTC: upstream detection failed (%s); retaining the active preset', error.message);
    } finally {
      detecting = undefined;
    }
  })();
  ctx.on('loader/volatile-update', () => { void detect(); });
  const restoreResolve = checkBeforeResolve(ctx.agentPresets, detect);
  ctx.effect(() => () => { active = false; restoreResolve(); });
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
}
