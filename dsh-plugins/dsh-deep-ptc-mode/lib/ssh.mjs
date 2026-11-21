// SSH to external hosts through the session's own shell.
//
// Deep PTC adds no separate SSH transport: the selected shell runs the local OpenSSH client. This module
// finds that client, reads the host aliases the user configured in ~/.ssh/config (names and endpoints
// only; keys and other options are never read), and tells the model how to use them without hanging on a
// password or host-key prompt. The official remote-workspace providers (@deepseek-ai/dsh-ssh and its
// fs/subprocess/sandbox rows) are a different, POSIX-only arrangement and are left to the host.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

const MAX_HOSTS = 24;

/**
 * Concrete host aliases of an OpenSSH client configuration.
 * @param text - ~/.ssh/config contents.
 * @returns `{ alias, hostName?, user?, port? }` for each alias without wildcards, in file order.
 */
export function parseSshConfig(text) {
  if (typeof text !== 'string') return [];
  const hosts = [];
  let current = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/(^|\s)#.*$/u, '').trim();
    if (!line) continue;
    const match = /^(\S+)\s*(?:=\s*|\s)(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^"(.*)"$/u, '$1');
    if (key === 'host') {
      current = [];
      for (const alias of value.split(/\s+/u)) {
        if (!alias || /[*?!]/u.test(alias) || hosts.some(host => host.alias === alias)) continue;
        const host = { alias };
        hosts.push(host);
        current.push(host);
      }
    } else if (key === 'match') {
      current = [];
    } else if (current.length) {
      // OpenSSH keeps the first value of each option.
      const field = key === 'hostname' ? 'hostName' : key === 'user' ? 'user' : key === 'port' ? 'port' : undefined;
      if (field) for (const host of current) host[field] ??= value;
    }
  }
  return hosts.slice(0, MAX_HOSTS);
}

/** The OpenSSH client the native shell runs, or '' when none is installed where it usually is. */
export function findSshClient({ platform = process.platform, env = process.env, exists }) {
  const candidates = platform === 'win32'
    ? [win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')]
    : ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh', '/bin/ssh'];
  return candidates.find(path => exists(path)) ?? '';
}

/** Host aliases from the user's ~/.ssh/config; an unreadable file has none. */
export function readSshHosts(read = path => readFileSync(path, 'utf8'), home = homedir()) {
  try { return parseSshConfig(read(join(home, '.ssh', 'config'))); } catch { return []; }
}

const endpoint = host => {
  const target = host.hostName && host.hostName !== host.alias ? host.hostName : '';
  const at = host.user ? `${host.user}@` : '';
  const port = host.port && host.port !== '22' ? `:${host.port}` : '';
  return target || at || port ? ` (${at}${target || host.alias}${port})` : '';
};

/**
 * Model guidance for SSH in the selected environment.
 * @param options - `{ environment, client, hosts }`; `client` is the native client path or ''.
 * @returns the guidance text.
 */
export function sshGuidance({ environment, client, hosts }) {
  const lines = ['SSH to external hosts: use the OpenSSH client from the execution environment\'s shell.'];
  if (environment === 'wsl') {
    lines.push('In WSL, ssh, scp and sftp run inside the distribution with its own ~/.ssh and authentication agent. Windows host aliases below are reference metadata; confirm the matching host, user, port and key paths in WSL before reusing them.');
  } else if (client) {
    lines.push(`The local client is ${client}; scp and sftp are installed beside it.`);
  } else {
    lines.push('No OpenSSH client was found where the system installs it; check `ssh -V` before relying on it, and tell the user if it is missing.');
  }
  if (hosts.length) {
    lines.push(`Configured host aliases (~/.ssh/config): ${hosts.map(host => `${host.alias}${endpoint(host)}`).join(', ')}. Prefer an alias over a raw address so the user's keys, user and port apply.`);
  }
  lines.push(
    'Every SSH call must be non-interactive: `ssh -o BatchMode=yes -o ConnectTimeout=10 <host> \'<command>\'`, `scp -B -o ConnectTimeout=10 <src> <dst>`, `sftp -b <batchfile> <host>`. Never open an interactive remote shell, and never wait for a password, passphrase or host-key confirmation.',
    'If authentication or host-key verification fails, stop and tell the user which host failed and why; do not retry with other credentials, disable host-key checking or edit their SSH configuration.',
    'Each remote command is self-contained (cd, environment and quoting included). Remote work longer than the foreground limit runs as a background job; check it with job_output.',
    'Run long-lived forwarding as a managed job, with explicit loopback binding, ExitOnForwardFailure=yes and keepalives. Verify readiness before use.',
    'For DSH Go, confirm the remote OS: managed dsh web requires POSIX; attach-only can use an existing Windows service. Use its actual loopback port and protect its token. Configure a phone-reachable host and authentication in DSH Go, which manages its own tunnel.',
  );
  return lines.join('\n');
}
