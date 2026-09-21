// Saros Agents Pocket — 发现 VsSaros server/web 的上游端口与连接令牌
//
// 上游 = VsSaros 以 server/web 模式启动后的 HTTP+WS 端点（默认 127.0.0.1:8000）。
// 连接令牌 = server 写入 <user-data-dir>/token 的文件内容（web 客户端用 ?tkn= 携带）。

import { networkInterfaces } from 'node:os';
import { get as httpGet } from 'node:http';
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
 * 探测 127.0.0.1:<port> 是否可连 —— 面板用它回答「同屏 web 的上游起没起」。
 * 桌面版 VsSaros 不监听 HTTP 端口，此时为 false（属预期，不是故障）。
 * @returns {Promise<boolean>}
 */
export async function probeUpstreamPort(port, timeoutMs = 600) {
  if (!port) return false;
  return probePort(Number(port), timeoutMs);
}

/**
 * 拼「本机浏览器可直接打开」的 Pocket 入口地址。
 *
 * `token` 非空时带上 `?token=<访问密码>`：代理的 `authCheck()` 认这个查询参数并立刻种下
 * HttpOnly cookie（`maybeSeedAuthCookie`）⇒ **免手动输密码**；App 载入后会把该参数从地址栏摘掉
 * （`app/app.js` 的 replaceState），所以它不会留在历史/截图里。
 *
 * ⚠ 只用于 `openExternal`（本机浏览器）。**别**用它拼要分享给别人的地址（如「复制 App 地址」）——
 * 那种地址必须干净，不能带密码。
 *
 * @param {number|string} [port] 代理端口
 * @param {string} [prefix] App 路径前缀（如 `/pocket/`）
 * @param {string} [token] 访问密码（局域网 PIN）；空则返回干净地址
 * @param {string} [host] 主机（默认 127.0.0.1 —— loopback 只在本机可用，密码不会外泄到网络）
 */
export function appEntryUrl(port, prefix = '/pocket/', token = '', host = '127.0.0.1') {
  const base = `http://${host}:${port ?? '3081'}${prefix}`;
  const t = String(token ?? '').trim();
  return t ? `${base}?token=${encodeURIComponent(t)}` : base;
}

/**
 * HTTP 可达性探测（本机 → 某个 URL）。
 *
 * **任何 HTTP 响应都算"可达"**：局域网入口要密码，会 302 到登录页 ——
 * 那也证明「这一跳通了，服务在那个地址上确实听着」。
 *
 * ⚠ 语义边界：本机访问**自己的局域网 IP** 走的是 loopback 捷径，**不经过**操作系统防火墙的
 * 入站规则。所以 ok=true 只说明「代理绑在了这个地址上」，**不能**证明手机能连上；
 * 但 ok=false 非常有价值：说明这个地址根本不是本机网卡的地址（VPN / 虚拟网卡选错的典型症状）。
 *
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export function probeHttp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch { /* 忽略 */ }
      resolve(r);
    };
    try {
      req = httpGet(url, { timeout: timeoutMs, headers: { 'user-agent': 'saros-pocket/selfcheck' } }, (res) => {
        res.resume(); // 丢掉 body，只要响应头
        done({ ok: true, status: res.statusCode });
      });
      req.on('timeout', () => done({ ok: false, error: `timeout ${timeoutMs}ms` }));
      req.on('error', (err) => done({ ok: false, error: err?.code ?? String(err?.message ?? err) }));
    } catch (err) {
      done({ ok: false, error: String(err?.message ?? err) });
    }
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

/** 单个网卡地址的「像不像能连手机的那个」评分（越高越像）。 */
export function scoreLanInterface(name, ip) {
  let score = 0;
  if (PRIVATE_IPV4_RE.test(ip)) score += 100;
  if (PHYSICAL_IFACE_RE.test(name)) score += 20;
  else if (VPN_IFACE_RE.test(name)) score -= 50;
  return score;
}

export function selectLanIPv4(interfaces) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      candidates.push({ ip, score: scoreLanInterface(name, ip), order: candidates.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}

/**
 * 枚举所有可用的局域网 IPv4，带上**网卡名**与「疑似虚拟/VPN 网卡」标记。
 *
 * 为什么需要：桌面机常有 VPN（公司内网）/ 虚拟网卡（WSL、Hyper-V、Docker、ZeroTier…）。
 * 自动挑选只能靠命名启发式，一旦挑中 VPN 的地址（如 `10.x.x.x`），手机**根本路由不到** ——
 * 现象就是浏览器「网站无响应」（超时，而不是拒绝连接）。面板据此让用户**一眼看到并一键换成**
 * 真正的无线网卡地址（走 `sarosPocket.lanIpOverride`）。
 */
export function listLanInterfaces(interfaces = networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (out.some((c) => c.ip === ip)) continue;
      out.push({
        ip,
        iface: String(name),
        // 命名像虚拟/VPN 且不像物理网卡 ⇒ 标记出来（面板会标注「VPN/虚拟网卡」）
        virtual: VPN_IFACE_RE.test(name) && !PHYSICAL_IFACE_RE.test(name),
        score: scoreLanInterface(name, ip),
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.ip.localeCompare(b.ip));
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
