// Saros Agents Pocket — 本机状态与访问令牌持久化
//
// 合并 dsh-pocket 的 settings.mjs（开关/隧道配置）与 index.js（8 位访问 PIN）逻辑，
// 统一存到扩展的 globalStorage 目录（不再依赖 $DSH_HOME）。
//
// 安全默认：局域网与公网访问都要密码（8 位英文字母或数字）。

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomInt } from 'node:crypto';
import { isValidIpv4 } from './ip.mjs';
import { classifyHost } from './proxy.mjs';

const PIN_RE = /^[a-zA-Z0-9]{8}$/;

/** 必须用 CSPRNG；非加密随机数可预测，等于把 10^8 搜索空间进一步压缩。 */
function newPin() {
  return String(randomInt(10_000_000, 100_000_000));
}

/**
 * 创建一个绑定到 storageDir 的状态仓库。
 * @param {string} storageDir 扩展 globalStorage 目录（绝对路径）
 */
export function createStateStore(storageDir) {
  const base = join(storageDir, 'saros-pocket');
  const stateRel = join('saros-pocket', 'state.json');
  const statePath = () => join(storageDir, stateRel);

  function readState() {
    try {
      const raw = JSON.parse(readFileSync(statePath(), 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch { /* 无文件/损坏 → 默认 */ }
    return {};
  }
  function writeState(s) {
    try {
      mkdirSync(dirname(statePath()), { recursive: true });
      writeFileSync(statePath(), JSON.stringify(s, null, 2), { mode: 0o600 });
    } catch { /* 忽略 */ }
    return s;
  }

  // ---------- 访问密码文件 ----------
  function tokenRelPath(rel) {
    return join(base, rel);
  }
  function readPinFile(rel) {
    try {
      const existing = readFileSync(tokenRelPath(rel), 'utf8').trim();
      if (PIN_RE.test(existing)) return existing;
    } catch { /* 无文件 */ }
    return null;
  }
  function writePinFile(rel, fresh) {
    try {
      mkdirSync(dirname(tokenRelPath(rel)), { recursive: true });
      writeFileSync(tokenRelPath(rel), fresh, { mode: 0o600 });
    } catch { /* 忽略 */ }
    return fresh;
  }

  // ---------- 局域网访问开关（默认开启） ----------
  const lanEnabled = () => readState().lanEnabled !== false;
  const setLanEnabled = (on) => { const s = readState(); s.lanEnabled = !!on; writeState(s); return s.lanEnabled; };

  // ---------- 局域网访问密码开关（默认开启） ----------
  const lanAuthEnabled = () => readState().lanAuthEnabled !== false;
  const setLanAuthEnabled = (on) => { const s = readState(); s.lanAuthEnabled = !!on; writeState(s); return s.lanAuthEnabled; };

  // ---------- 局域网地址手动覆盖 ----------
  const lanIpOverride = () => readState().lanIpOverride ?? '';
  const setLanIpOverride = (value) => {
    const ip = String(value ?? '').trim();
    if (ip && !isValidIpv4(ip)) throw new Error('局域网地址必须是 IPv4 地址 | LAN address must be an IPv4 address');
    const s = readState();
    if (ip) s.lanIpOverride = ip; else delete s.lanIpOverride;
    writeState(s);
    return ip;
  };

  // ---------- 自定义 PIN 标记 ----------
  const PIN_CUSTOM_KEYS = { public: 'publicPinCustom', lan: 'lanPinCustom' };
  const pinCustom = (which) => { const key = PIN_CUSTOM_KEYS[which]; return key ? readState()[key] === true : false; };
  const setPinCustom = (which, on) => { const key = PIN_CUSTOM_KEYS[which]; if (!key) return false; const s = readState(); s[key] = !!on; writeState(s); return !!on; };

  // ---------- 访问密码（公网 / 局域网各自 8 位） ----------
  const getAccessToken = () => readPinFile('token') ?? writePinFile('token', newPin());
  function rotateAccessToken() {
    if (pinCustom('public')) return getAccessToken();
    return writePinFile('token', newPin());
  }
  const getLanToken = () => readPinFile('token-lan') ?? writePinFile('token-lan', newPin());
  function refreshLanToken() { setPinCustom('lan', false); return writePinFile('token-lan', newPin()); }

  function hostNameOnly(host) {
    let name = String(host ?? '').trim().toLowerCase();
    if (name.startsWith('[')) { const end = name.indexOf(']'); if (end >= 0) name = name.slice(1, end); }
    else name = name.replace(/:\d+$/, '');
    return name;
  }
  function isLanOverrideHost(host) {
    const override = lanIpOverride().trim().toLowerCase();
    return override.length > 0 && hostNameOnly(host) === override;
  }
  function tokenForHost(host) {
    if (isLanOverrideHost(host)) return getLanToken();
    return classifyHost(host) === 'public' ? getAccessToken() : getLanToken();
  }
  function setCustomPin(which, value) {
    const v = String(value ?? '').trim();
    if (!PIN_RE.test(v)) throw new Error('密码必须是 8 位英文字母或数字 | PIN must be exactly 8 characters (letters and digits only)');
    if (which === 'public') { writePinFile('token', v); setPinCustom('public', true); return v; }
    if (which === 'lan') { writePinFile('token-lan', v); setPinCustom('lan', true); return v; }
    throw new Error('未知密码类型 | unknown PIN kind');
  }
  function resetPocketState() {
    try { rmSync(statePath(), { force: true }); } catch { /* 忽略 */ }
    try { rmSync(tokenRelPath('token'), { force: true }); } catch { /* 忽略 */ }
    try { rmSync(tokenRelPath('token-lan'), { force: true }); } catch { /* 忽略 */ }
    return { accessToken: getAccessToken(), lanToken: getLanToken() };
  }

  // ---------- 命名隧道配置 ----------
  const tunnelMode = () => readState().tunnelMode === 'named' ? 'named' : 'quick';
  const setTunnelMode = (mode) => {
    if (mode !== 'quick' && mode !== 'named') throw new Error('隧道模式必须是 quick 或 named');
    const s = readState(); if (mode === 'quick') delete s.tunnelMode; else s.tunnelMode = mode; writeState(s); return mode;
  };
  const tunnelToken = () => { const v = readState().tunnelToken; return typeof v === 'string' ? v : ''; };
  const setTunnelToken = (value) => {
    const v = String(value ?? '').trim();
    if (v) { if (v.length < 20 || !/^[A-Za-z0-9+/_=-]+$/.test(v)) throw new Error('Tunnel Token 格式不对 | invalid tunnel token'); }
    const s = readState(); if (v) s.tunnelToken = v; else delete s.tunnelToken; writeState(s); return v;
  };
  const tunnelHostname = () => { const v = readState().tunnelHostname; return typeof v === 'string' ? v : ''; };
  const setTunnelHostname = (value) => {
    let v = String(value ?? '').trim().toLowerCase();
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
    if (v) {
      const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
      const IS_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
      if (IS_IPV4.test(v) || !v.includes('.') || !HOSTNAME_RE.test(v)) throw new Error('固定域名格式不对（如 pocket.example.com） | invalid tunnel hostname');
    }
    const s = readState(); if (v) s.tunnelHostname = v; else delete s.tunnelHostname; writeState(s); return v;
  };

  // ---------- 代理端口 ----------
  const proxyPort = () => { const v = Number(readState().proxyPort); return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : 0; };
  const setProxyPort = (value) => { const n = Number(value); const s = readState(); if (Number.isInteger(n) && n >= 1 && n <= 65535) s.proxyPort = n; else delete s.proxyPort; writeState(s); return proxyPort(); };

  // ---------- cloudflared 自定义路径 ----------
  const cloudflaredPath = () => readState().cloudflaredPath ?? '';
  const setCloudflaredPath = (value) => { const v = String(value ?? '').trim(); const s = readState(); if (v) s.cloudflaredPath = v; else delete s.cloudflaredPath; writeState(s); return v; };

  return {
    base,
    lanEnabled, setLanEnabled,
    lanAuthEnabled, setLanAuthEnabled,
    lanIpOverride, setLanIpOverride,
    pinCustom, setPinCustom,
    getAccessToken, rotateAccessToken,
    getLanToken, refreshLanToken,
    tokenForHost, setCustomPin, isLanOverrideHost, resetPocketState,
    tunnelMode, setTunnelMode,
    tunnelToken, setTunnelToken,
    tunnelHostname, setTunnelHostname,
    proxyPort, setProxyPort,
    cloudflaredPath, setCloudflaredPath,
  };
}
