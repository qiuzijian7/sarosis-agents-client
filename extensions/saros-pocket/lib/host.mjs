// Saros Agents Pocket — 发现 VsSaros server/web 的上游端口与连接令牌
//
// 上游 = VsSaros 以 server/web 模式启动后的 HTTP+WS 端点（默认 127.0.0.1:8000）。
// 连接令牌 = server 写入 <user-data-dir>/token 的文件内容（web 客户端用 ?tkn= 携带）。

import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Socket } from 'node:net';

const DEFAULT_PORTS = [8000, 8080, 3000, 8888, 9000, 5000];

/** TCP 探测：127.0.0.1:port 是否可连（超时 600ms）。 */
function probePort(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = new Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
    try { sock.connect(port, '127.0.0.1'); } catch { finish(false); }
  });
}

/**
 * 决定上游端口。
 * 优先用配置端口；若连不上则探测常见默认端口；都失败回退配置端口（让代理给出明确报错）。
 * @param {number} preferred 配置的首选端口（默认 8000）
 * @returns {Promise<number>}
 */
export async function discoverUpstreamPort(preferred = 8000) {
  if (preferred && await probePort(preferred)) return preferred;
  for (const p of DEFAULT_PORTS) {
    if (p === preferred) continue;
    if (await probePort(p)) return p;
  }
  return preferred;
}

/**
 * 读取 VsSaros 连接令牌。
 * 优先级：配置显式令牌 > 自动探测 <userDataDir>/token 文件。
 * @param {{ configured?: string, userDataDir?: string }} opts
 * @returns {Promise<string>} 令牌（空字符串表示无需令牌 / 未找到）
 */
export async function discoverConnectionToken({ configured = '', userDataDir = '' } = {}) {
  if (configured && /^[0-9A-Za-z_-]+$/.test(configured.trim())) return configured.trim();

  const candidates = [];
  if (userDataDir) candidates.push(userDataDir);
  const home = homedir();
  candidates.push(
    join(home, '.vssaros'),
    join(home, '.vssaros-dev'),
    join(home, '.vssaros-server'),
    join(home, '.vscode-server'),
  );

  for (const dir of candidates) {
    try {
      const tok = readFileSync(join(dir, 'token'), 'utf8').replace(/\r?\n$/, '').trim();
      if (/^[0-9A-Za-z_-]+$/.test(tok)) return tok;
    } catch { /* 无此文件 */ }
  }
  return '';
}

// ---------- 局域网 IP 选择（移植自 dsh-pocket service.mjs，按 VsSaros 品牌微调） ----------
const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/;
const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i;
const VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i;

export function selectLanIPv4(interfaces) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name)) score += 20;
      else if (VPN_IFACE_RE.test(name)) score -= 50;
      candidates.push({ ip, score, order: candidates.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}

export async function lanIPv4() {
  return selectLanIPv4(networkInterfaces());
}

export async function listLanCandidates() {
  const ips = [];
  for (const [, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (!ips.includes(ip)) ips.push(ip);
    }
  }
  return ips;
}
