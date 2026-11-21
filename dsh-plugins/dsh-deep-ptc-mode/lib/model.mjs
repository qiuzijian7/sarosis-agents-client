// Compose the Deep PTC agent preset from the official PTC preset that the
// installed Harness ships, replacing only the rows this plugin owns.
//
// The official declaration is the source of truth: rows it adds, renames or
// reconfigures are inherited as-is. Deep PTC then swaps in its persona, its
// selectable execution environment, its reachability guard, and wrappers for
// the official job and question tools. A change on the official side therefore
// never leaves a stale module name behind.
import snapshot from './preset.json' with { type: 'json' };
import baseSnapshot from './base-snapshot.json' with { type: 'json' };
import { creativeAdditions } from './creative.mjs';
import { normalizePreferences } from './tool-policy.mjs';
import { normalizeToolOverrides } from './tool-overrides.mjs';

export const ENVIRONMENTS = ['auto', 'wsl', 'powershell', 'zsh', 'bash'];

export function availableEnvironments(platform) {
  return platform === 'win32' ? ['auto', 'wsl', 'powershell', 'bash'] : ['auto', 'zsh', 'bash'];
}

export function resolveEnvironment(environment = 'auto', platform = process.platform) {
  if (!availableEnvironments(platform).includes(environment)) {
    throw new Error(`Execution environment ${JSON.stringify(environment)} is unavailable on ${platform}`);
  }
  return environment === 'auto'
    ? (platform === 'win32' ? 'powershell' : platform === 'darwin' ? 'zsh' : 'bash')
    : environment;
}

export function normalizeDistribution(value = '') {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('WSL distribution must be a name without control characters');
  }
  const distribution = value.trim();
  if (distribution.startsWith('-')) throw new Error('WSL distribution must not start with a dash');
  return distribution;
}

export function shellArgv(environment, spec, distribution = '', platform = process.platform, executable = '') {
  if (environment === 'wsl') {
    if (platform !== 'win32') throw new Error('WSL requires a Windows host');
    const distro = normalizeDistribution(distribution);
    return ['wsl.exe', ...(distro ? ['--distribution', distro] : []),
      '--cd', spec.workdir, '--exec', 'bash', '-lc', spec.command];
  }
  const binary = typeof executable === 'string' ? executable : '';
  if (environment === 'zsh') return [binary || (platform === 'darwin' ? '/bin/zsh' : 'zsh'), '-lc', spec.command];
  if (environment === 'bash' && binary) return [binary, '-c', spec.command];
  throw new Error(`No mapped executor for ${environment}`);
}

export function assertExecutionPolicy(environment, policy, platform = process.platform) {
  if (environment === 'wsl' && policy?.mode !== 'danger-full-access') {
    throw new Error('WSL execution is not supported under a confined Windows sandbox. Select PowerShell for confined work, or use the host\'s existing approval flow for this exact command. No command was executed.');
  }
  if (environment === 'bash' && platform === 'win32' && policy?.mode !== 'danger-full-access') {
    throw new Error('Native Bash is unavailable under a confined Windows sandbox. Select PowerShell for confined work. No command was executed.');
  }
}

const HIDDEN_TOOL_NOTE = 'The built-in shell tool for this environment is disabled by configuration. Use an available replacement for this shell and follow its live tool contract.';

export function environmentText(environment, distribution = '', note = '', platform = process.platform, hidden = false) {
  const descriptions = {
    wsl: `Execution environment: WSL Bash${distribution ? ` (${distribution})` : ' (Windows default distribution)'}. The bash tool runs POSIX source via wsl.exe and bash -lc. File tools and the tool workdir use Windows host paths; Linux paths belong inside command source. WSL is available only in danger-full-access; a confined call fails without execution. Never silently fall back to PowerShell or another distribution. Do the work with Linux tools inside WSL by default; call powershell.exe or cmd.exe through interop only for steps that genuinely need Windows (GUI, registry, Windows-only programs), and say so when you do.`,
    powershell: 'Execution environment: native Windows PowerShell. Use the pwsh tool and PowerShell syntax, native Windows paths and $env:NAME. This selection takes precedence over older workspace guidance that assumed WSL. The configured sandbox and approval policy still apply.',
    zsh: 'Execution environment: native Zsh. Use the zsh tool with Zsh/POSIX command source. On macOS the executor is /bin/zsh -lc; elsewhere zsh must be installed. File tools and workdir use native host paths. The configured sandbox and approval policy still apply.',
    bash: platform === 'win32'
      ? 'Execution environment: native Windows Bash. Use the bash tool with Bash/POSIX command source and Windows host paths for the tool workdir. Confined calls fail without execution. Select PowerShell for confined work.'
      : 'Execution environment: native Bash. Use the bash tool with Bash/POSIX command source and native host paths. The configured sandbox and approval policy still apply.',
  };
  if (!descriptions[environment]) throw new Error(`Unknown environment ${environment}`);
  return [descriptions[environment], typeof note === 'string' ? note : '', hidden ? HIDDEN_TOOL_NOTE : ''].filter(Boolean).join('\n');
}

export const DEFAULT_FOREGROUND_SECONDS = 30;
export const QUESTION_SECONDS = 120;

export function normalizeForegroundSeconds(value = DEFAULT_FOREGROUND_SECONDS) {
  if (!Number.isInteger(value) || value < 5 || value > 600) throw new Error('Foreground wait must be a whole number of seconds from 5 to 600');
  return value;
}

/**
 * Lookup hints for the official rows Deep PTC replaces with its execution group. Hints only find
 * rows; the modules Deep PTC loads are always the ones the official rows (or the base declaration)
 * name, so a renamed or replaced official module is followed rather than hard-coded.
 */
export const SHELL_TOOLS = {
  bash: { ids: ['tool-bash'], names: ['@deepseek-ai/dsh-tool-bash'] },
  pwsh: { ids: ['tool-pwsh'], names: ['@deepseek-ai/dsh-tool-pwsh'] },
};
const SHELL_EXECUTOR_NAMES = [
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-pwsh-local',
  '@deepseek-ai/dsh-pwsh-sandbox',
];
export const SHELL_ROWS = {
  ids: [...SHELL_TOOLS.bash.ids, ...SHELL_TOOLS.pwsh.ids],
  names: [...SHELL_TOOLS.bash.names, ...SHELL_TOOLS.pwsh.names, ...SHELL_EXECUTOR_NAMES],
};

/** Lookup hints for the official rows Deep PTC keeps but wraps, keyed by row id. */
export const WRAPPED_ROWS = {
  'tool-jobs': '@deepseek-ai/dsh-tool-jobs',
  'tool-ask-user': '@deepseek-ai/dsh-tool-ask-user',
};

/** Fallback executor declaration, used only when the installed base declaration cannot be read. */
export const BASE_SNAPSHOT = baseSnapshot;

const PERSONA_ROW = { ids: ['persona'], names: ['@deepseek-ai/dsh-persona'] };
const WRAP_TARGETS = [
  {
    key: 'tool-jobs',
    replacement: 'dsh-deep-ptc-mode/jobs-tool',
    options: milliseconds => ({ waitTimeoutMs: milliseconds, maxWaitTimeoutMs: milliseconds }),
  },
  {
    key: 'tool-ask-user',
    replacement: 'dsh-deep-ptc-mode/ask-user',
    options: () => ({ mode: 'timed', timeout: QUESTION_SECONDS }),
  },
];

/**
 * Identity Deep PTC publishes, independent of the official preset.
 *
 * The host shows a third-party preset's name and description as published, in every language,
 * so both are language-neutral: the brand name and a status line. The client localizes them
 * where it owns the presentation (see `presetStatus` in lib/client.js, which reads this format).
 */
export const PRESET_META = {
  id: 'deep-ptc',
  name: 'Deep PTC',
  order: typeof snapshot.order === 'number' ? snapshot.order : 5,
};

/** Separator between the brand and the status in the published description. */
export const STATUS_SEPARATOR = ' · ';
const ENVIRONMENT_LABELS = { wsl: 'WSL', powershell: 'PowerShell', zsh: 'Zsh', bash: 'Bash' };
const SAFE_MODE_LABEL = '安全模式 Safe mode';
const OFFICIAL_LABEL = '官方 Shell Official shell';
const REASON_LIMIT = 400;

/**
 * The published description: `Deep PTC · <status>`.
 * @param status - `{ kind: 'environment', environment, distribution? }`, `{ kind: 'official' }`
 *   or `{ kind: 'safe', reason? }`.
 * @returns the description text.
 */
export function presetDescription(status) {
  let text;
  if (status.kind === 'safe') {
    const reason = typeof status.reason === 'string' ? status.reason.replace(/\s+/gu, ' ').trim() : '';
    text = reason ? `${SAFE_MODE_LABEL}: ${reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT - 1)}…` : reason}` : SAFE_MODE_LABEL;
  } else if (status.kind === 'official') {
    text = OFFICIAL_LABEL;
  } else {
    const label = ENVIRONMENT_LABELS[status.environment] ?? status.environment;
    text = status.environment === 'wsl' && status.distribution ? `${label} (${status.distribution})` : label;
  }
  return `${PRESET_META.name}${STATUS_SEPARATOR}${text}`;
}

/** Persona text owned by this plugin, read from the bundled snapshot. */
export function personaFrom(template = snapshot) {
  const rows = Array.isArray(template?.plugins) ? template.plugins : [];
  const row = findRow(rows, PERSONA_ROW);
  const config = row?.config;
  if (!config || typeof config.prefix !== 'string' || typeof config.suffix !== 'string') {
    throw new Error('bundled snapshot carries no Deep PTC persona');
  }
  return { prefix: config.prefix, suffix: config.suffix };
}

/** Visit every row depth-first, including rows nested in group configurations. */
export function walkRows(rows, visit) {
  if (!Array.isArray(rows)) return;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || typeof row !== 'object') continue;
    visit(row, rows, index);
    if (row.group === true && Array.isArray(row.config)) walkRows(row.config, visit);
  }
}

/** Whether a row is one of the official shell/executor rows Deep PTC replaces. */
export function isShellRow(row) {
  return row.group !== true && (SHELL_ROWS.names.includes(row.name) || SHELL_ROWS.ids.includes(row.id));
}

// The desktop already mounts this host service. Copying it into the session would start a second one.
function isHostRunner(row) {
  return row?.id === 'dynamicCordisRunner'
    || (typeof row?.name === 'string' && row.name.includes('cordis-host-runner'));
}

function chosenExecutable(environment, value) {
  if (environment !== 'powershell' && environment !== 'bash' && environment !== 'zsh') return '';
  return typeof value === 'string' ? value.trim() : '';
}

function findRow(rows, { ids = [], names = [] }) {
  let found;
  walkRows(rows, row => {
    if (found !== undefined) return;
    if (names.includes(row.name) || ids.includes(row.id)) found = row;
  });
  return found;
}

function rowIds(plugins, into = new Set()) {
  walkRows(plugins, row => {
    if (typeof row.id === 'string') into.add(row.id);
  });
  return into;
}

function uniqueRowId(plugins, preferred) {
  const taken = rowIds(plugins);
  if (!taken.has(preferred)) return preferred;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${preferred}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function applyToolOverrides(plugins, overrides) {
  if (overrides.length === 0) return;
  const rowIds = new Set(overrides.map(entry => entry.row).filter(Boolean));
  walkRows(plugins, row => {
    if (row.group !== true && rowIds.has(row.id)) row.disabled = true;
  });
  plugins.push({ id: uniqueRowId(plugins, 'tool-overrides'), name: 'dsh-deep-ptc-mode/tool-overrides', config: { overrides } });
}

/**
 * Compose the Deep PTC preset from an official PTC declaration.
 * @param upstream - Official preset configuration (`{ id, order, plugins }`).
 * @param options - `environment`, `wslDistribution`, `foregroundSeconds`.
 * @param platform - Host platform whose environment choices apply.
 * @returns The Deep PTC preset plus a report of what was replaced, wrapped or skipped.
 */
export function deriveDeepPtc(upstream, options = {}, platform = process.platform) {
  if (!upstream || !Array.isArray(upstream.plugins) || upstream.plugins.length === 0) {
    throw new Error('official PTC preset carries no plugin rows');
  }
  for (const row of upstream.plugins) {
    if (!row || typeof row !== 'object' || typeof row.name !== 'string') {
      throw new Error('official PTC preset has a malformed plugin row');
    }
  }

  const environment = resolveEnvironment(options.environment, platform);
  const distribution = normalizeDistribution(options.wslDistribution);
  const foregroundSeconds = normalizeForegroundSeconds(options.foregroundSeconds);
  const foregroundMs = foregroundSeconds * 1000;
  const toolPreferences = normalizePreferences(options.toolPreferences);
  const plugins = structuredClone(upstream.plugins);
  const report = {
    upstreamId: typeof upstream.id === 'string' ? upstream.id : null,
    upstreamRows: plugins.length,
    persona: 'missing',
    replacedShellRows: [],
    wrapped: [],
    skipped: [],
  };

  // Persona: keep the row and any official fields, replace only the text.
  const personaText = personaFrom();
  const persona = findRow(plugins, PERSONA_ROW);
  if (persona === undefined) {
    plugins.unshift({ id: uniqueRowId(plugins, 'persona'), name: '@deepseek-ai/dsh-persona', config: { ...personaText } });
    report.persona = 'inserted';
  } else {
    persona.config = { ...(persona.config ?? {}), ...personaText };
    report.persona = 'replaced';
  }

  // Safe mode is the official composition plus the persona, for a host where the rest cannot mount.
  // When the failure lies outside the execution group, safe mode still keeps the selected shell
  // (below), so a broken unrelated row never quietly switches WSL users to the official shell.
  const safe = options.safeMode === true;
  const legacyOverrides = normalizeDisabledShellTools(options.disabledShellTools).map(tool => ({ tool, row: `tool-${tool}` }));
  const overrides = normalizeToolOverrides([...legacyOverrides, ...normalizeToolOverrides(options.toolOverrides)]);
  const disabledShells = normalizeDisabledShellTools(overrides.map(entry => entry.tool));
  if (safe && options.safeKeepsExecution !== true) {
    applyToolOverrides(plugins, overrides);
    report.environment = 'official';
    report.skipped.push('safe mode: official composition with the Deep PTC persona');
    return { preset: { ...upstream, id: PRESET_META.id, name: PRESET_META.name, order: PRESET_META.order,
      description: presetDescription({ kind: 'safe', reason: options.safeModeReason }), plugins }, report };
  }

  // Execution environment: replace the official shell rows (wherever the official preset nests them)
  // with the selectable execution group in the same place. The group runs the official shell tool
  // and executor the installed Harness names; when they cannot be mapped, the official rows stay.
  const kind = environment === 'powershell' ? 'pwsh' : 'bash';
  const executors = { ...BASE_SNAPSHOT, ...(options.executors ?? {}) };
  const tool = findRow(plugins, SHELL_TOOLS[kind]);
  const official = executors[kind];
  const shellPath = chosenExecutable(environment, options.shellExecutable);
  const mapped = environment === 'wsl' || environment === 'zsh' || (environment === 'bash' && shellPath !== '');
  const unusable = environment === 'bash' && platform === 'win32' && shellPath === '' ? 'Windows native Bash needs an available bash.exe'
    : tool === undefined ? `the official PTC preset has no ${kind} tool row`
    : typeof official?.name !== 'string' ? `the installed Harness declares no ${kind} executor`
    : mapped && options.mappedExecutor === false ? `the official bash executor cannot be extended for ${environment}`
    : undefined;
  report.environment = unusable === undefined ? environment : 'official';
  let anchorSiblings = plugins;
  let anchorIndex;
  const rows = [];
  if (unusable !== undefined) {
    report.skipped.push(`execution environment ${environment} (${unusable}; official shell rows kept)`);
    // The kept official tool rows honour disabledShellTools too.
    walkRows(plugins, row => {
      if (row.group === true) return;
      for (const shellKind of disabledShells) if (SHELL_TOOLS[shellKind]?.ids.includes(row.id) || SHELL_TOOLS[shellKind]?.names.includes(row.name)) row.disabled = true;
    });
    const topLevelPersona = plugins.findIndex(row => row && row.group !== true
      && (PERSONA_ROW.names.includes(row.name) || PERSONA_ROW.ids.includes(row.id)));
    anchorIndex = topLevelPersona + 1;
  } else {
    const removed = [];
    walkRows(plugins, (row, siblings, index) => {
      if (isShellRow(row)) removed.push({ row, siblings, index });
    });
    report.replacedShellRows = removed.map(({ row }) => `${row.id ?? '?'} (${row.name})`);
    anchorSiblings = removed[0].siblings;
    const bySiblings = new Map();
    for (const { siblings, index } of removed) {
      if (!bySiblings.has(siblings)) bySiblings.set(siblings, []);
      bySiblings.get(siblings).push(index);
    }
    anchorIndex = Math.min(...bySiblings.get(anchorSiblings));
    for (const [siblings, indexes] of bySiblings) {
      for (const index of [...indexes].sort((left, right) => right - left)) siblings.splice(index, 1);
    }
    // With background jobs available, the executor timeout only decides when a foreground command
    // moves to the background; the official tools run such commands with onExpiry: none.
    const executorOptions = { ...(official.config ?? {}), timeoutMs: foregroundMs, maxTimeoutMs: foregroundMs };
    if (environment === 'powershell' && shellPath) executorOptions.pwshPath = shellPath;
    const executor = mapped
      ? { id: 'executor', name: 'dsh-deep-ptc-mode/executor',
        config: { environment, wslDistribution: distribution, base: official.name, options: executorOptions,
          ...shellPath ? { shellExecutable: shellPath } : {} } }
      : { id: 'executor', name: official.name, config: executorOptions };
    // The tool row stays disabled when the official row was, or when settings hide this shell (#23).
    const toolKind = environment === 'zsh' ? 'zsh' : kind;
    const terminalId = environment === 'zsh' ? 'tool-zsh' : tool.id ?? `tool-${kind}`;
    const hidden = tool.disabled === true || disabledShells.includes(toolKind)
      || overrides.some(entry => entry.row === terminalId);
    if (hidden) report.disabledShellTool = toolKind;
    const terminal = {
      id: terminalId,
      name: 'dsh-deep-ptc-mode/terminal',
      ...hidden ? { disabled: true } : {},
      config: {
        upstream: tool.name,
        ...tool.config === undefined ? {} : { options: tool.config },
        ...environment === 'zsh' ? { dialect: 'zsh' } : {},
      },
    };
    rows.push({
      id: uniqueRowId(plugins, 'execution'), name: 'cordis:group', group: true, isolate: { shell: true, deepPtcCardShell: true },
      config: [executor, terminal, { id: 'execution-instructions', name: 'dsh-deep-ptc-mode/environment',
        config: { environment, wslDistribution: distribution,
          ...hidden ? { shellToolHidden: true } : {},
          ...typeof options.shellNote === 'string' && options.shellNote !== '' ? { shellNote: options.shellNote } : {},
          ...typeof options.sshGuidance === 'string' && options.sshGuidance !== '' ? { ssh: options.sshGuidance } : {} } }],
    });
  }
  if (!safe) rows.push({
    id: uniqueRowId([...plugins, ...rows], 'reachability'),
    name: 'dsh-deep-ptc-mode/guard', config: { foregroundSeconds, ...options.conversationCards !== false ? { questionCards: true } : {} },
  });
  anchorSiblings.splice(anchorIndex, 0, ...rows);
  if (safe) {
    applyToolOverrides(plugins, overrides);
    report.skipped.push('safe mode: official composition with the Deep PTC persona and the selected execution environment');
    return { preset: { ...upstream, id: PRESET_META.id, name: PRESET_META.name, order: PRESET_META.order,
      description: presetDescription({ kind: 'safe', reason: options.safeModeReason }), plugins }, report };
  }

  // Wrapped tools: the wrapper loads the module the official row names, with the official options
  // plus the Deep PTC wait behaviour.
  for (const target of WRAP_TARGETS) {
    const row = findRow(plugins, { ids: [target.key], names: [WRAPPED_ROWS[target.key]] });
    if (row === undefined) {
      report.skipped.push(`${target.key} (no official row)`);
      continue;
    }
    const upstreamName = row.name;
    row.name = target.replacement;
    row.config = { upstream: upstreamName, ...row.config === undefined ? {} : { options: row.config }, overrides: target.options(foregroundMs) };
    report.wrapped.push(`${target.key} (${upstreamName})`);
  }

  // Official rows stay exactly as declared. Tool discovery learns their tools from these module names.
  const officialModules = [];
  walkRows(upstream.plugins, row => {
    if (row.group === true || typeof row.name !== 'string' || row.disabled === true) return;
    officialModules.push({ name: row.name, ...typeof row.config?.toolName === 'string' ? { toolName: row.config.toolName } : {} });
  });
  plugins.push({
    id: uniqueRowId(plugins, 'tool-compatibility'), name: 'dsh-deep-ptc-mode/tool-compatibility',
    config: { enabled: options.toolCompatibility !== false, preferences: toolPreferences,
      compact: options.compactToolCatalog !== false, officialModules,
      sdkProvider: findRow(upstream.plugins, {ids:['tool-executor-ptc'],names:['@deepseek-ai/dsh-tool-executor-ptc']})?.name ?? '@deepseek-ai/dsh-tool-executor-ptc',
      skillProvider: findRow(upstream.plugins, {ids:['tool-skill'],names:['@deepseek-ai/dsh-tool-skill']})?.name ?? '@deepseek-ai/dsh-tool-skill' },
  });

  // Question cards replace the host's blocking question box while conversation cards are on: the
  // official ask row stays in the preset, disabled, so turning cards off brings it straight back.
  if (options.conversationCards !== false) {
    const ask = findRow(plugins, { ids: ['tool-ask-user'], names: ['dsh-deep-ptc-mode/ask-user', WRAPPED_ROWS['tool-ask-user']] });
    if (ask !== undefined) ask.disabled = true;
    plugins.push({ id: uniqueRowId(plugins, 'question-cards'), name: 'dsh-deep-ptc-mode/question-tool' });
    report.questions = ask === undefined ? 'question cards (no official ask row)' : 'question cards replace ask_user_question';
  }

  // Project cards: the model's tool lives in this preset only; other modes read the cards read-only.
  if (options.projectCards !== false) {
    plugins.push({ id: uniqueRowId(plugins, 'project-cards'), name: 'dsh-deep-ptc-mode/project-tool' });
  }

  // Task brief: the model files the user's goals and constraints; only Deep PTC sees the tool.
  if (options.taskBrief !== false) {
    plugins.push({ id: uniqueRowId(plugins, 'task-brief'), name: 'dsh-deep-ptc-mode/brief-tool' });
  }

  plugins.push({ id: uniqueRowId(plugins, 'deep-ptc-skills'), name: 'dsh-deep-ptc-mode/bundled-skills' });

  if (options.pluginLab === true) {
    const additions = creativeAdditions(options.creativePlugins, plugins, {
      root: typeof options.creativeRoot === 'string' ? options.creativeRoot : '',
    }).filter(row => !isHostRunner(row) && !isShellRow(row));
    plugins.push(...additions);
    plugins.push({ id: uniqueRowId(plugins, 'plugin-lab'), name: 'dsh-deep-ptc-mode/lab' });
    plugins.push({ id: uniqueRowId(plugins, 'virtual-dsh'), name: 'dsh-deep-ptc-mode/virtual-dsh-tool' });
    report.pluginLab = additions.map(row => `${row.id} (${row.name})`);
  }
  applyToolOverrides(plugins, overrides);

  const description = environment === 'bash' && platform === 'win32' && unusable !== undefined
    ? presetDescription({ kind: 'official' })
    : presetDescription({ kind: 'environment', environment, distribution });
  return {
    preset: {
      ...upstream,
      id: PRESET_META.id,
      name: PRESET_META.name,
      order: PRESET_META.order,
      description,
      plugins,
    },
    report,
  };
}

const SHELL_TOOL_KINDS = ['bash', 'pwsh', 'zsh'];
/** Shell tool kinds to publish disabled; `powershell` is accepted for `pwsh`, unknown kinds dropped. */
export function normalizeDisabledShellTools(value) {
  if (!Array.isArray(value)) return [];
  const kinds = value.map(item => typeof item === 'string' ? item.trim().toLowerCase() : '')
    .map(item => item === 'powershell' ? 'pwsh' : item);
  return SHELL_TOOL_KINDS.filter(kind => kinds.includes(kind));
}

/** Backwards-compatible helper: the derived preset without the report. */
export function configuredPreset(template, options, platform = process.platform) {
  return deriveDeepPtc(template, options, platform).preset;
}
