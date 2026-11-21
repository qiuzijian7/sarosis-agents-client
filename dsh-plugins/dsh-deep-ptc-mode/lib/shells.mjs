// Filesystem probe for shell executables. Callers supply file checks; this module never spawns.
import { lstatSync, readlinkSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

export const AUTO_SHELL = '';

const BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'];
const ZSH_CANDIDATES = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'];

function pathKey(filePath, platform) {
  if (platform === 'win32') return String(filePath).replace(/[\\/]+/gu, '\\').toLowerCase();
  return String(filePath).replace(/\/+/gu, '/');
}

function rootKey(root, platform) {
  return pathKey(String(root).replace(/[\\/]+$/gu, ''), platform);
}

function winJoin(root, tail) {
  return `${String(root).replace(/[\\/]+$/gu, '')}\\${tail}`;
}

function located(where, name) {
  try {
    const found = where(name);
    if (!Array.isArray(found)) return [];
    return found.filter(item => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

/**
 * Whether an executable is present, and the file it finally runs.
 *
 * A Microsoft Store install exposes its command as an app execution alias under
 * %LOCALAPPDATA%\Microsoft\WindowsApps. `stat` follows the alias into the protected
 * C:\Program Files\WindowsApps directory and fails with EACCES, while `lstat` reads the alias
 * itself and `readlink` names its target. Only that case counts as present: a path whose own
 * entry cannot be read either is reported absent.
 * @param filePath - candidate executable.
 * @param fs - injectable `statSync`, `lstatSync` and `readlinkSync`.
 * @returns `{ target }` for a present executable, otherwise undefined.
 */
export function probeExecutable(filePath, fs = { statSync, lstatSync, readlinkSync }) {
  if (typeof filePath !== 'string' || filePath === '') return undefined;
  try {
    return fs.statSync(filePath).isFile() ? { target: filePath } : undefined;
  } catch (error) {
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM') return undefined;
  }
  try {
    if (!fs.lstatSync(filePath).isSymbolicLink()) return undefined;
    const target = fs.readlinkSync(filePath);
    return { target: typeof target === 'string' && target !== '' ? target : filePath, alias: true };
  } catch {
    return undefined;
  }
}

const presentProbe = exists => filePath => (exists(filePath) ? { target: filePath } : undefined);

function addShell(shells, seen, platform, probe, filePath, label, family) {
  if (typeof filePath !== 'string' || filePath.length === 0) return;
  const key = pathKey(filePath, platform);
  if (seen.has(key)) return;
  const found = probe(filePath);
  if (found === undefined) return;
  // Two aliases of one Store install (the WindowsApps entry and its package folder) share a target.
  const target = pathKey(found.target ?? filePath, platform);
  seen.add(key);
  if (target !== key) {
    if (seen.has(target)) return;
    seen.add(target);
  }
  shells.push({ id: `path:${filePath}`, label: found.alias === true && family === 'powershell' ? STORE_PWSH : label, path: filePath, family });
}

/** Display label of a PowerShell installed from the Microsoft Store; the client localizes it. */
export const STORE_PWSH = 'PowerShell 7 (Microsoft Store)';

function bashLabel(filePath, platform) {
  return platform === 'darwin' && filePath === '/bin/bash' ? 'bash (system)' : 'bash';
}

function zshLabel(filePath) {
  return filePath === '/bin/zsh' ? 'zsh (system)' : 'zsh';
}

function envPath(env, key, fallback) {
  const value = env?.[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

export function discoverShells({ platform, env = {}, exists, probe = presentProbe(exists), where }) {
  const shells = [];
  const seen = new Set();
  const add = (filePath, label, family) => addShell(shells, seen, platform, probe, filePath, label, family);

  if (platform === 'win32') {
    const systemRoot = envPath(env, 'SystemRoot', 'C:\\Windows');
    const programFiles = envPath(env, 'ProgramFiles', 'C:\\Program Files');
    add(winJoin(systemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'Windows PowerShell 5.1', 'powershell');
    const roots = [programFiles];
    const programW6432 = env?.ProgramW6432;
    if (typeof programW6432 === 'string' && programW6432 !== '' && rootKey(programW6432, platform) !== rootKey(programFiles, platform)) {
      roots.push(programW6432);
    }
    for (const root of roots) {
      add(winJoin(root, 'PowerShell\\7\\pwsh.exe'), 'PowerShell 7', 'powershell');
      add(winJoin(root, 'PowerShell\\7-preview\\pwsh.exe'), 'PowerShell 7 Preview', 'powershell');
    }
    const localAppData = env?.LOCALAPPDATA;
    if (typeof localAppData === 'string' && localAppData !== '') {
      add(winJoin(localAppData, 'Microsoft\\WindowsApps\\pwsh.exe'), 'PowerShell (pwsh)', 'powershell');
    }
    for (const name of ['pwsh.exe', 'pwsh']) {
      for (const filePath of located(where, name)) add(filePath, 'PowerShell (pwsh)', 'powershell');
    }
    return shells;
  }

  if (platform === 'darwin' || platform === 'linux') {
    for (const filePath of BASH_CANDIDATES) add(filePath, bashLabel(filePath, platform), 'bash');
    for (const filePath of located(where, 'bash')) add(filePath, bashLabel(filePath, platform), 'bash');
    for (const filePath of ZSH_CANDIDATES) add(filePath, zshLabel(filePath), 'zsh');
    for (const filePath of located(where, 'zsh')) add(filePath, zshLabel(filePath), 'zsh');
  }
  return shells;
}

export function resolveShellExecutable(value, { family, discovered, exists }) {
  if (value === undefined || value === '' || value === 'auto') return AUTO_SHELL;
  if (!Array.isArray(discovered)) return '';
  for (const item of discovered) {
    if (item?.family !== family || (item.id !== value && item.path !== value)) continue;
    if (typeof item.path !== 'string' || exists(item.path) === false) return '';
    return item.path;
  }
  return '';
}

export function resolveWindowsBash(value, isFile) {
  if (typeof value !== 'string') return '';
  const path = value.trim();
  const { root, base } = win32.parse(path);
  // A single leading slash still depends on the caller's current drive.
  if (!win32.isAbsolute(path) || root.length < 2 || base.toLowerCase() !== 'bash.exe' || /[\u0000-\u001f]/u.test(path)) return '';
  return isFile(path) ? path : '';
}

function fileNameIs(filePath, name) {
  const normalized = String(filePath).replace(/[\\/]+/gu, '/');
  const slash = normalized.lastIndexOf('/');
  const base = slash === -1 ? normalized : normalized.slice(slash + 1);
  return base.toLowerCase() === name;
}

export function shellNote({ family, executable }) {
  if (typeof executable !== 'string' || executable === '') return '';
  if (family === 'powershell' && fileNameIs(executable, 'powershell.exe')) {
    return `Windows PowerShell 5.1 at ${executable} uses Windows PowerShell syntax, not PowerShell 7.`;
  }
  if (family === 'powershell' && fileNameIs(executable, 'pwsh.exe')) {
    return `PowerShell 7+ at ${executable} uses pwsh syntax.`;
  }
  if (family === 'bash') return `The bash tool uses ${executable} with bash -c.`;
  if (family === 'zsh') return `The zsh tool uses ${executable} with zsh -lc.`;
  return '';
}
