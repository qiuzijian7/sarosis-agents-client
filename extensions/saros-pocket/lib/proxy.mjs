// Saros Agents Pocket — 核心：Host/Origin 改写反向代理
//
// 为什么需要它：VsSaros 的 server/web 模式（server-main 默认监听 127.0.0.1:8000）
// 把完整工作台通过 HTTP + WebSocket 提供出来，但其浏览器信任栅栏只认 loopback
// 权威，且 web 客户端必须携带连接令牌（?tkn=<token>，cookie vscode-tkn）。
// 本代理把入站请求的 Host/Origin 统一改写成 loopback 权威（127.0.0.1:8000），
// 并在需要时注入连接令牌，于是：
//   - 局域网：手机直接访问 http://<电脑IP>:<代理端口>
//   - 公网：cloudflared 隧道指到本代理，任意域名都能进
// 都不需要改 VsSaros 的任何配置（0.0.0.0 绑定由本代理自行完成）。
//
// 同步保证：普通请求与 WebSocket upgrade 都原样透传，手机看到的界面与电脑完全一致、实时。
//
// 本文件从 dsh-pocket/lib/proxy.mjs 移植，按 VsSaros 的连接令牌机制（tkn / vscode-tkn）
// 参数化，并去除 dsh 桌面端专属逻辑。

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createGzip, createBrotliCompress, constants as zlibConstants } from 'node:zlib';
import { createHash, timingSafeEqual } from 'node:crypto';

const DEFAULT_UPSTREAM = { host: '127.0.0.1', port: 8000 };

/**
 * 非安全上下文（http://<LAN-IP>:端口）里浏览器缺两个 API，由代理注入 polyfill
 * （只在缺少时生效，不覆盖原生实现）：
 *   1. crypto.randomUUID——VsSaros 连接层 mint RPC id 用，缺失直接抛错；
 *   2. AbortSignal.any——部分 Android 厂商浏览器/WebView（Chrome < 116）无原生实现，
 *      VsSaros 连接层发送消息会调 AbortSignal.any([...])，缺失则消息发不出。
 * 带 data-saros-pocket-polyfill 标记：注入判重用它，而不是搜索 "crypto.randomUUID" 字样。
 */
export const RANDOM_UUID_POLYFILL = `<script data-saros-pocket-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();
!function(){try{if(self.AbortSignal&&!self.AbortSignal.any){self.AbortSignal.any=function(signals){var controller=new AbortController();var list=Array.from(signals||[]);var done=false;var handlers=list.map(function(s){return function(){abort(s);};});function cleanup(){for(var i=0;i<list.length;i++){try{list[i].removeEventListener('abort',handlers[i]);}catch(e){}}}function abort(s){if(done)return;done=true;cleanup();try{controller.abort(s.reason);}catch(e){controller.abort();}}for(var j=0;j<list.length;j++){var sig=list[j];if(sig.aborted){abort(sig);break;}sig.addEventListener('abort',handlers[j],{once:true});}return controller.signal;};}}catch(e){}}();</script>`;

const INJECT_MARK = 'data-saros-pocket-polyfill="1"';

/**
 * 默认注入到经代理的 HTML 文档里：crypto.randomUUID / AbortSignal.any polyfill
 * （非安全上下文必需）。
 */
export const DEFAULT_INJECT = RANDOM_UUID_POLYFILL;

// ---------- 可选访问令牌认证 ----------
// 只对受保护 Host（公网隧道 + 局域网按开关）强制。
// 登录成功后种 HttpOnly 持久 cookie（Max-Age 30 天）→ SPA 内部 API/WS 自动携带。
// 会话保持：cookie 值 = sha256(PIN:sessionKey)——sessionKey 是进程级随机密钥，
// VsSaros 重启/更新 → sessionKey 变化 → 手机需重新输入。
const TOKEN_COOKIE = 'saros_pocket_token';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 天（秒）

/** cookie 校验值：有 sessionKey 时派生，无则退化为 PIN 本身（向后兼容）。 */
function cookieFor(token, sessionKey) {
  if (!sessionKey) return token;
  return createHash('sha256').update(`${token}:${sessionKey}`).digest('hex');
}

// ---------- 登录速率限制 ----------
// 8 位密码（10^8 组合）本身可接受，真正风险是「无限制重试」让穷举可行。
// 三层防护（内存态，随进程生命周期，与 sessionKey 一致）：
//   1) 单 IP 滑动窗口：60 秒内失败 ≥5 次 → 锁 60 秒（429）
//   2) 全局滑动窗口：1 分钟全局失败 > 50 次 → 全局锁 30 秒
//   3) 成功登录清空该 IP 计数
// IP 识别：优先 cf-connecting-ip（Cloudflare 在隧道入口设置的真实客户端 IP，可信）；
// 无则回退 socket remoteAddress。不信任客户端 x-forwarded-for（可伪造）。
export const DEFAULT_RATE_LIMIT = {
  windowMs: 60_000,
  maxFailures: 5,
  lockMs: 60_000,
  globalMaxFailures: 50,
  globalLockMs: 30_000,
};
function createRateLimiter(cfg = {}) {
  const c = { ...DEFAULT_RATE_LIMIT, ...cfg };
  const failCounts = new Map();
  const ipLocks = new Map();
  const global = { count: 0, windowStart: 0, lockedUntil: 0 };
  return {
    status(ip) {
      const now = Date.now();
      if (global.lockedUntil > now) return { locked: true, retryAfter: Math.ceil((global.lockedUntil - now) / 1000) };
      const until = ipLocks.get(ip) ?? 0;
      if (until > now) return { locked: true, retryAfter: Math.ceil((until - now) / 1000) };
      return { locked: false, retryAfter: 0 };
    },
    record(ip) {
      const now = Date.now();
      let rec = failCounts.get(ip);
      if (!rec || now - rec.windowStart > c.windowMs) rec = { count: 0, windowStart: now };
      rec.count++;
      failCounts.set(ip, rec);
      if (now - global.windowStart > c.windowMs) { global.count = 0; global.windowStart = now; }
      global.count++;
      if (rec.count >= c.maxFailures) ipLocks.set(ip, now + c.lockMs);
      if (global.count >= c.globalMaxFailures) global.lockedUntil = now + c.globalLockMs;
      if (failCounts.size > 2000) {
        for (const [k, v] of failCounts) {
          if (now - v.windowStart > c.windowMs) failCounts.delete(k);
        }
      }
    },
    clear(ip) {
      failCounts.delete(ip);
      ipLocks.delete(ip);
    },
  };
}

/** 客户端真实 IP（限速与握手计数的身份键）。 */
export function clientIp(req) {
  const addr = String(req.socket?.remoteAddress ?? '');
  if (classifySource(addr) === 'loopback') {
    const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
    if (cf) return cf;
  }
  return addr || 'unknown';
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** HTML 属性值转义（登录页要把原路径回填到 hidden input）。 */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 登录后要跳回的原路径 —— **只接受站内路径**，防开放重定向。
 *
 * 为什么需要：登录页是「任意路径未鉴权」时都会出现的，早期实现把成功跳转写死成 `/`，
 * 于是手机从 `/pocket/` 扫码进来、输完密码会被弹回 VsSaros web（桌面版没有上游 ⇒ 直接 502），
 * 用户得再手打一次 `/pocket/`。这里把原路径带回去（只保留 pathname，丢掉 query 以免把
 * 用户拼在 URL 上的东西（如错误的 ?token=）一起回显）。
 *
 * @param {string} rawUrl 原始 req.url
 * @returns {string} 安全可跳的路径；空串表示「没有可信目标」（调用方退回默认行为）
 */
export function safeNextPath(rawUrl) {
  const raw = String(rawUrl ?? '').trim();
  // ★ 必须先看**原始**字符串再解析：WHATWG URL 会把 `\` 规范成 `/`（`/\evil.com` 被当成 `//evil.com`，
  //   主机直接变成 evil.com），空串/相对路径也会被解析成 `/` —— 只信 `new URL().pathname` 会把它们放进来。
  if (!raw.startsWith('/')) return '';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return ''; // 协议相对 URL / 反斜杠绕过
  if (raw.length > 512) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '';
  let pathname;
  try {
    pathname = new URL(raw, 'http://x.invalid').pathname; // 顺带丢掉 ?query#hash
  } catch {
    return '';
  }
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return '';
  return pathname;
}

/**
 * 上游 VsSaros server 不可达时的页面（502，仅对浏览器导航请求）。
 *
 * 为什么需要：代理的**同屏 web 入口**（`/`）需要上游 HTTP 端口，而桌面版 VsSaros
 * （vssaros.exe，Electron）**不监听** HTTP 端口 ⇒ 这个入口天然打不开；但 **Pocket App
 * （`/pocket/`）走扩展本地路由，完全不经过上游**，照样可用。
 * 早期这里只吐一行 `connect ECONNREFUSED`，用户看不出「哪条入口坏了、该怎么办」，
 * 所以改成把两条出路直接写在页面上（App 入口 / 启动 server 模式 / 改端口 / 重试）。
 *
 * @param {object} o
 * @param {string} o.host 上游主机（通常 127.0.0.1）
 * @param {number} o.port 上游端口（通常 8000）
 * @param {string} [o.err] 原始错误消息（诊断用，小字展示）
 * @param {string} [o.appPrefix] Pocket App 路径前缀（如 `/pocket/`），用于给「打开 App」链接
 * @param {string} [o.triedPath] 用户原本请求的路径（重试链接用）
 */
export function upstreamDownPageHtml({ host, port, err = '', appPrefix = '', triedPath = '/' } = {}) {
  const retry = triedPath.startsWith('/') && !triedPath.startsWith('//') ? triedPath : '/';
  const appLink = appPrefix ? `<p class="act"><a class="btn" href="${escapeAttr(appPrefix)}">打开 Pocket App →</a></p>` : '';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saros Pocket · 同屏 web 暂不可用</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:20px 0}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px 22px;max-width:420px;width:calc(100% - 40px)}
h1{font-size:16px;margin:0 0 6px;color:#111827}
p{font-size:13px;line-height:1.6;color:#4b5563;margin:0 0 12px}
ol{font-size:13px;line-height:1.7;color:#374151;margin:0 0 12px;padding-left:20px}
code{background:#f3f4f6;border-radius:4px;padding:1px 5px;font-size:12px;color:#111827}
a{color:#4f6ef7}
.btn{display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;border-radius:8px;padding:9px 14px;font-size:14px}
.act{margin:0 0 14px}
.raw{font-size:11px;color:#9ca3af;word-break:break-all;margin:0}
</style></head><body><div class="card">
<h1>VsSaros 同屏 web 暂不可用</h1>
<p>代理连不上上游 <code>${escapeAttr(host)}:${escapeAttr(String(port))}</code>。你打开的是<strong>同屏 web 入口</strong>，
它需要 VsSaros 以 <strong>server/web 模式</strong>运行；桌面版 <code>vssaros.exe</code> 不监听 HTTP 端口，所以这个入口打不开。</p>
<p><strong>Pocket App 不受影响</strong> —— 对话 / 收件箱 / 变更 / 状态 / 屏幕都走扩展本地通道，不需要上游。</p>
${appLink}
<ol>
<li>只想用手机：用上面的 App 入口（或面板里「Pocket App · 手机连接」的二维码）。</li>
<li>要用同屏 web：以 server 模式启动 —— <code>vssaros --server --port ${escapeAttr(String(port))}</code></li>
<li>端口不是 ${escapeAttr(String(port))}：改设置 <code>sarosPocket.upstreamPort</code>（面板或插件设置页）。</li>
<li>已经启动了 server：<a href="${escapeAttr(retry)}">重试一次</a>。</li>
</ol>
<p class="raw">${escapeAttr(err)}</p>
</div></body></html>`;
}

/**
 * 登录页：按访问来源显示提示（局域网 / 公网）。
 * @param {string} [brandHtml] 品牌 logo 的 HTML（由扩展读 app/saros-logo.svg 转 data URI 传入）；
 *   空则退回文字标题 —— 代理本身拿不到扩展路径，所以品牌由外面注入。
 * @param {string} [next] 登录成功后跳回的站内路径（已过 safeNextPath）
 */
export function renderLoginPage(error, isPublic, retryAfter = 0, brandHtml = '', next = '') {
  const where = isPublic ? '此公网地址' : '此局域网地址';
  const whereEn = isPublic ? 'This public address' : 'This LAN address';
  const errMsg = error === 'locked'
    ? `尝试次数过多，请 ${retryAfter} 秒后再试 | Too many attempts — try again in ${retryAfter}s`
    : error ? '密码错误，请重试 | Wrong PIN, try again' : '';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saros Pocket · 访问验证</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:320px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 4px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:18px;letter-spacing:6px;text-align:center;border:1px solid #d1d5db;border-radius:8px;outline:none;margin-bottom:12px}
input:focus{border-color:#4f6ef7}
button{width:100%;padding:10px;font-size:15px;background:#4f6ef7;color:#fff;border:none;border-radius:8px;cursor:pointer}
.err{color:#dc2626;font-size:12px;margin-bottom:10px;min-height:16px}
/* 品牌条：wordmark 是白字+橙，只在深色底上可读，因此给它一条深色底 */
.brand{background:#0f1115;border-radius:10px;padding:11px 12px;display:flex;align-items:center;justify-content:center;margin-bottom:14px}
.brand img{height:22px;width:auto;display:block}
</style></head><body><div class="card">
${brandHtml ? `<div class="brand">${brandHtml}</div>` : ''}
<h1>Saros Pocket</h1>
<p>${where}受访问密码保护，请输入 8 位密码（英文字母或数字） | ${whereEn} is password-protected — enter the 8-character PIN (letters/digits)</p>
<div class="err">${errMsg}</div>
<form method="post" action="/pocket-login">
<input name="token" type="password" maxlength="8" autocomplete="one-time-code" autofocus required>
${next ? `<input type="hidden" name="next" value="${escapeAttr(next)}">` : ''}
<button type="submit">进入 | Enter</button>
</form>
</div></body></html>`;
}

/**
 * 是否是 IPv4 loopback（127.0.0.0/8）。
 * 必须整段匹配点分四组：只做 /^127\./ 前缀匹配会把
 * 「127.0.0.1.evil.com」这类伪装域名误判成本机。
 * @param {string} name 已小写、已去端口的主机名
 * @returns {boolean}
 */
function isLoopbackV4(name) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

/**
 * Host 信任边界分类（fail closed）。
 *   - loopback：localhost / 127.x / ::1 / 0.0.0.0
 *   - lan：RFC1918 私网 IPv4、CGNAT 100.64/10、IPv6 ULA/link-local、.local、无点单标签名
 *   - public：其余一切 Host（trycloudflare 或任何陌生域名）→ 强制公网密码
 * @returns {'loopback'|'lan'|'public'}
 */
export function classifyHost(host) {
  let name = String(host ?? '').trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end >= 0) name = name.slice(1, end);
  } else {
    name = name.replace(/:\d+$/, '');
  }
  // 注意：127 段必须整段匹配成点分四组（127.0.0.1）。早期写成 /^127\./ 前缀匹配，
  // 会让「127.0.0.1.evil.com」这类攻击者可控的 Host 被判成 loopback 而绕过公网鉴权。
  if (name === 'localhost' || name === '0.0.0.0' || name === '::1' || isLoopbackV4(name)) return 'loopback';
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(name)) return 'lan';
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(name) && name.includes(':')) return 'lan';
  if (name === '' || name.includes(':')) return 'loopback';
  if (name.endsWith('.local') || !name.includes('.')) return 'lan';
  return 'public';
}

function isProtectedHost(host, isProtected) {
  return isProtected ? isProtected(host) : classifyHost(host) === 'public';
}

const HOST_CLASS_RANK = { loopback: 0, lan: 1, public: 2 };

/** 按 TCP 源地址给出来源类别（兜底方向为 public）。 */
export function classifySource(addr) {
  let a = String(addr ?? '').trim().toLowerCase();
  if (!a) return null;
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || isLoopbackV4(a)) return 'loopback';
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(a)) return 'lan';
  if (/^169\.254\./.test(a)) return 'lan';
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(a)) return 'lan';
  return 'public';
}

/**
 * 用于策略判定的 Host（issue #90 思想沿用）：用不可伪造的 TCP 源地址给 Host 声明设下限。
 * 只收紧、绝不放松：经隧道进来的公网请求源地址正是 127.0.0.1，若按源地址覆盖会把
 * 公网访问降级成本机免密。故仅当声明保护级别低于来源真实级别时才用源地址。
 */
export function policyHost(req, host) {
  const actual = classifySource(req?.socket?.remoteAddress);
  if (!actual) return host;
  const claimed = classifyHost(host);
  if (HOST_CLASS_RANK[actual] <= HOST_CLASS_RANK[claimed]) return host;
  let addr = String(req.socket.remoteAddress);
  if (addr.toLowerCase().startsWith('::ffff:')) addr = addr.slice(7);
  return addr;
}

function isLoopbackHost(host) {
  let name = String(host ?? '').trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end >= 0) name = name.slice(1, end);
  } else {
    name = name.replace(/:\d+$/, '');
  }
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0';
}

function lanDisabledPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saros Pocket · 局域网访问已关闭</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:360px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0;line-height:1.6}
</style></head><body><div class="card">
<h1>🔒 Saros Pocket</h1>
<p>局域网访问已关闭，扫码/链接均不可用。<br>请在 VsSaros 的 Saros Pocket 面板中重新开启后再试。<br><br>LAN access is disabled — the QR code and link are unavailable.</p>
</div></body></html>`;
}

function isHtmlRequest(req) {
  const accept = String(req.headers.accept ?? '');
  if (accept.includes('text/html')) return true;
  let pathname = String(req.url ?? '');
  try { pathname = new URL(pathname || '/', 'http://x.invalid').pathname; } catch { /* 用原值兜底 */ }
  return pathname === '/' || /\.html?$/i.test(pathname);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function hasQueryToken(req) {
  try {
    return new URL(req.url ?? '/', 'http://x').searchParams.get('token') != null;
  } catch {
    return false;
  }
}

function authCheck(req, tokens, sessionKey) {
  const list = (Array.isArray(tokens) ? tokens : tokens ? [tokens] : []).filter(Boolean);
  if (list.length === 0) return { ok: true, rawQueryToken: null };
  const cookies = parseCookies(req.headers.cookie);
  const cookieTok = cookies[TOKEN_COOKIE];
  if (cookieTok) {
    for (const token of list) {
      if (safeEqual(cookieTok, cookieFor(token, sessionKey))) return { ok: true, rawQueryToken: null };
    }
  }
  const qTok = new URL(req.url ?? '/', 'http://x').searchParams.get('token');
  if (qTok) {
    for (const token of list) {
      if (safeEqual(qTok, token)) return { ok: true, rawQueryToken: qTok };
    }
  }
  return { ok: false, rawQueryToken: null };
}

function maybeSeedAuthCookie(req, res, rawToken, sessionKey) {
  if (!rawToken || !sessionKey) return;
  const expected = cookieFor(rawToken, sessionKey);
  if (!expected) return;
  // ★ 只有「已有 cookie 且**值就是我们要的**」才跳过。
  //   早先这里是「存在同名 cookie 就跳过」，于是：VsSaros 重启 → sessionKey 变了 → 旧 cookie 失效，
  //   但用 ?token= 打开时它**不会被替换** ⇒ 页面里的子资源（app.css / app.js）带着失效 cookie 请求 → 401
  //   ⇒ 表现为「页面裸奔、JS 不执行、地址栏的 ?token= 也摘不掉」（用户报的现象）。
  if (parseCookies(req.headers.cookie)[TOKEN_COOKIE] === expected) return;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, headers) {
    const h = { ...(headers ?? {}) };
    const cookie = `${TOKEN_COOKIE}=${expected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
    const prev = h['set-cookie'];
    if (Array.isArray(prev)) h['set-cookie'] = [...prev, cookie];
    else if (typeof prev === 'string') h['set-cookie'] = [prev, cookie];
    else h['set-cookie'] = cookie;
    return origWriteHead(statusCode, h);
  };
}

/** 把浏览器可见的权威改写成 loopback 权威，并规范化 Referer / Sec-Fetch-Site。 */
function loopbackAuthority(headers, upstream) {
  const authority = `${upstream.host}:${upstream.port}`;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'sec-fetch-site') continue;
    out[lk] = v;
  }
  out.host = authority;
  out.origin = `http://${authority}`;
  const referer = headers.referer ?? headers.Referer;
  if (referer) {
    try {
      const ref = new URL(referer);
      ref.protocol = 'http:';
      ref.host = authority;
      out.referer = ref.toString();
    } catch {
      out.referer = `http://${authority}/`;
    }
  }
  out['sec-fetch-site'] = 'same-origin';
  return out;
}

// ---------- VsSaros 连接令牌（tkn / vscode-tkn）----------
// VsSaros server/web 的 web 客户端要求根路径带一次 ?tkn=<连接令牌> 换一个绑定
// authority 的 cookie（vscode-tkn），之后 /api 与 WebSocket 才放行；否则一律拒绝。
// 手机扫码进来的 URL 天然没有这个令牌，所以代理要在转发时补一次。
// 只在 GET / 且请求还没带对应 cookie 时注入；上游拿到令牌会 303 回干净根路径，
// 若每次都注入就会 303 循环。
function upstreamPathWithLaunchToken(reqUrl, method, cookieHeader, launchToken, queryName) {
  if (method !== 'GET') return reqUrl;
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://x.invalid'); } catch { return reqUrl; }
  if (u.pathname !== '/') return reqUrl;
  const force = u.searchParams.has('saros-pocket-auth');
  const cookieName = queryName === 'token' ? 'dsh-auth-' : '';
  if (cookieName && String(cookieHeader ?? '').includes(cookieName)) return reqUrl;
  if (!force && cookieHeader && parseCookies(cookieHeader)[launchToken ? 'vscode-tkn' : ''] != null) return reqUrl;
  if (!launchToken) return reqUrl;
  u.searchParams.set(queryName, launchToken);
  return `${u.pathname}${u.search}`;
}

// ---------- 会话握手重试计数（Safari 在 http://IP 源上丢 3xx cookie） ----------
export const DEFAULT_HANDSHAKE_LIMIT = 3;
export const HANDSHAKE_WINDOW_MS = 60_000;
export const HANDSHAKE_RETRY_PARAM = 'saros-pocket-retry';

export function stripQueryParam(reqUrl, name) {
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://x.invalid'); } catch { return reqUrl; }
  if (!u.searchParams.has(name)) return reqUrl;
  u.searchParams.delete(name);
  return `${u.pathname}${u.search}`;
}

export function createHandshakeTracker({ max = DEFAULT_HANDSHAKE_LIMIT, windowMs = HANDSHAKE_WINDOW_MS } = {}) {
  const hits = new Map();
  return {
    record(ip, now = Date.now()) {
      const rec = hits.get(ip);
      if (!rec || now - rec.start > windowMs) {
        hits.set(ip, { count: 1, start: now });
        return 1;
      }
      rec.count += 1;
      return rec.count;
    },
    clear(ip) { hits.delete(ip); },
    exhausted(ip) {
      const rec = hits.get(ip);
      return !!rec && rec.count >= max;
    },
    prune(now = Date.now()) {
      for (const [ip, rec] of hits) {
        if (now - rec.start > windowMs) hits.delete(ip);
      }
    },
  };
}

export function handshakePageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=/">
<title>Saros Pocket · 正在进入 | opening…</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
p{font-size:13px;color:#6b7280;margin:0}
</style></head><body><p>正在进入… | opening…</p></body></html>`;
}

export function handshakeBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saros Pocket · 无法完成登录握手</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px 22px;max-width:380px;width:calc(100% - 40px)}
h1{font-size:15px;margin:0 0 10px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 10px;line-height:1.7}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px}
a{color:#4f6ef7}
</style></head><body><div class="card">
<h1>🔁 无法完成登录握手</h1>
<p>浏览器没有保存 VsSaros 下发的会话 cookie，代理反复重试后仍未成功，因此停在这里而不是无限跳转。</p>
<p><strong>Safari（iOS/macOS）</strong> 在 <code>http://</code> 纯 IP 地址上不会保存这类 cookie，局域网入口因此进不去。</p>
<p>可以试试：<br>
① 换 Chromium 系浏览器（Chrome / Edge）打开局域网地址；<br>
② 改用<strong>公网入口</strong>（开启公网访问，拿到 <code>https://…trycloudflare.com</code> 地址）——HTTPS 域名上 Safari 正常。</p>
<p style="margin-top:14px"><a href="/?${HANDSHAKE_RETRY_PARAM}=1" style="display:inline-block;padding:8px 14px;background:#4f6ef7;color:#fff;border-radius:8px;text-decoration:none;font-size:13px">重试一次 | Retry</a></p>
<p style="color:#9ca3af;font-size:12px">Browser did not keep the session cookie, so the login handshake could not complete. Safari over plain <code>http://</code> + IP is the known case — try Chrome, or use the public HTTPS entry.</p>
</div></body></html>`;
}

// ---------- WebSocket 心跳注入（保活 + 静默断链检测） ----------
const WS_PING_FRAME = Buffer.from([0x89, 0x00]);

function attachWebSocketHeartbeat(socket, { intervalMs = 30_000, missLimit = 2 } = {}) {
  let misses = 0;
  let stopped = false;
  const onInbound = () => { misses = 0; };
  const timer = setInterval(() => {
    if (stopped) return;
    misses += 1;
    if (misses >= missLimit) {
      socket.destroy();
      return;
    }
    if (!socket.destroyed) {
      try { socket.write(WS_PING_FRAME); } catch { /* 忽略 */ }
    }
  }, intervalMs);
  timer.unref?.();
  socket.on('data', onInbound);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off('data', onInbound);
    socket.off('close', cleanup);
    socket.off('error', cleanup);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/**
 * 启动 Saros Pocket 代理。
 * @param {object} opts
 * @param {number} [opts.port] 监听端口（默认 3081）
 * @param {string} [opts.host] 监听地址（默认 0.0.0.0）
 * @param {{host:string,port:number}} [opts.upstream] 上游 VsSaros server（默认 127.0.0.1:8000）
 * @param {string} [opts.injectHtml] 注入 HTML 内容（默认 polyfill；传 '' 关闭）
 * @param {object} [opts.auth] 访问令牌认证：{ getToken, isProtected, sessionKey }
 * @param {object|false} [opts.rateLimit] 登录速率限制
 * @param {object|false} [opts.heartbeat] WebSocket 心跳
 * @param {() => boolean} [opts.lanAccessEnabled] 局域网访问是否开启
 * @param {() => string} [opts.launchToken] VsSaros 连接令牌（?tkn=）；空则不注入
 * @param {string} [opts.launchTokenQueryName] 连接令牌查询参数名（默认 'tkn'）
 * @param {string} [opts.launchAuthCookieName] 连接令牌 cookie 名（默认 'vscode-tkn'）
 * @param {number} [opts.handshakeLimit] 登录握手重试上限
 * @param {Array<{prefix:string, handle:(req,res)=>Promise<boolean>}>} [opts.routes]
 *   代理自行处理的本地路由（Pocket App 静态资源 + RPC 通道）。
 *   ★ 判定顺序即安全边界：这些路由排在「访问密码校验 + 局域网开关」之后、转发上游之前，
 *   所以能打开 App 的前提是先过了 PIN，不会绕过既有栅栏另开一条口子。
 * @param {string} [opts.brandHtml] 登录页顶部的品牌 HTML（扩展注入 VsSaros 同款 logo 的 data URI）；
 *   空字符串则登录页不显示品牌条（纯文字标题仍在）。
 * @param {string} [opts.appPrefix] Pocket App 路径前缀（如 `/pocket/`），用于上游不可达页面里
 *   给一个「打开 Pocket App」的出路链接；空则不展示该链接。
 * @param {(err: Error) => void} [opts.onUpstreamError] 上游不可达回调（含 HTTP 与 WebSocket 两条路径），
 *   服务层用它把「上游未启动」状态标出来供面板展示。
 */
export function createPocketProxy({
  port = 3081,
  host = '0.0.0.0',
  upstream = DEFAULT_UPSTREAM,
  log = null,
  injectHtml = DEFAULT_INJECT,
  auth = null,
  rateLimit = null,
  heartbeat = {},
  lanAccessEnabled = () => true,
  launchToken = () => '',
  launchTokenQueryName = 'tkn',
  launchAuthCookieName = 'vscode-tkn',
  handshakeLimit,
  routes = [],
  brandHtml = '',
  appPrefix = '',
  onUpstreamError = null,
} = {}) {
  /**
   * 登录页渲染（注入品牌 + 记住原路径）。四个调用点都走这里，避免每处都传一遍。
   * 名字沿用 loginPageHtml，调用点只需多传一个 req。
   */
  const loginPageHtml = (req, error, isPublic, retryAfter = 0) =>
    renderLoginPage(error, isPublic, retryAfter, brandHtml, safeNextPath(req?.url));

  const limiter = auth ? createRateLimiter(rateLimit ?? {}) : null;
  const handshake = createHandshakeTracker(
    typeof handshakeLimit === 'number' ? { max: handshakeLimit } : {},
  );
  const server = createServer((req, res) => {
    const host = policyHost(req, String(req.headers.host ?? ''));
    const isPublic = classifyHost(host) === 'public';
    if (!isPublic && !isLoopbackHost(host) && !lanAccessEnabled()) {
      if (isHtmlRequest(req)) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(lanDisabledPageHtml());
      } else {
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"error":"lan-disabled"}');
      }
      return;
    }
    if (auth) {
      const protectedHost = isProtectedHost(host, auth.isProtected);
      const token = protectedHost ? (auth.getToken?.(host) ?? null) : null;
      const altTokens = protectedHost && token && typeof auth.getAltTokens === 'function' ? (auth.getAltTokens(host) ?? []) : [];
      const sessionKey = auth.sessionKey ?? null;
      const acceptedTokens = token ? [token, ...altTokens] : [];
      if (protectedHost && token) {
        const ip = clientIp(req);
        if (req.method === 'POST' && req.url?.startsWith('/pocket-login')) {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
          if (rl.locked) {
            res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(rl.retryAfter) });
            res.end(loginPageHtml(req, 'locked', isPublic, rl.retryAfter));
            return;
          }
          let body = '';
          req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
          req.on('end', () => {
            const params = new URLSearchParams(body);
            const submitted = String(params.get('token') ?? '');
            // 回到用户原本要去的页面（例如手机扫码进 App 的 /pocket/）；
            // 根路径保留旧行为：带 saros-pocket-auth 标记，强制上游注入连接令牌（既有握手链路）。
            const wanted = safeNextPath(params.get('next'));
            const location = wanted && wanted !== '/' ? wanted : '/?saros-pocket-auth=1';
            const matched = acceptedTokens.find((candidate) => safeEqual(submitted, candidate));
            if (matched !== undefined) {
              limiter?.clear(ip);
              res.writeHead(302, {
                location,
                'set-cookie': `${TOKEN_COOKIE}=${cookieFor(matched, sessionKey)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
                'cache-control': 'no-store',
              });
              res.end();
            } else {
              limiter?.record(ip);
              log?.(`saros-pocket: login failed from ${ip}`);
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
              res.end(loginPageHtml(req, true, isPublic, 0));
            }
          });
          return;
        }
        const isGuess = hasQueryToken(req);
        if (isGuess) {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
          if (rl.locked) {
            if (isHtmlRequest(req)) {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
              res.end(loginPageHtml(req, 'locked', isPublic, rl.retryAfter));
            } else {
              res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(rl.retryAfter) });
              res.end('{"error":"too-many-attempts"}');
            }
            return;
          }
        }
        const authResult = authCheck(req, acceptedTokens, sessionKey);
        if (!authResult.ok) {
          if (isGuess) {
            limiter?.record(ip);
            log?.(`saros-pocket: bad ?token= from ${ip}`);
          }
          if (isHtmlRequest(req)) {
            const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(loginPageHtml(req, rl.locked ? 'locked' : false, isPublic, rl.retryAfter));
          } else {
            res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end('{"error":"unauthorized"}');
          }
          return;
        }
        if (authResult.rawQueryToken) {
          limiter?.clear(ip);
          maybeSeedAuthCookie(req, res, authResult.rawQueryToken, sessionKey);
        }
      }
    }
    // 本地路由（Pocket App + RPC）：已过完访问密码/局域网开关，这里才接管，
    // 不再转发给上游 VsSaros。
    if (routes.length > 0) {
      const pathname = String(req.url ?? '/').split(/[?#]/, 1)[0];
      const route = routes.find((r) => typeof r?.prefix === 'string' && pathname.startsWith(r.prefix));
      if (route && typeof route.handle === 'function') {
        Promise.resolve(route.handle(req, res)).catch((err) => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          try { res.end('{"error":"route-failure"}'); } catch { /* 已断开 */ }
          log?.(`saros-pocket: route ${route.prefix} failed | ${err?.message ?? err}`);
        });
        return;
      }
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const launchTok = (typeof launchToken === 'function' ? launchToken() : '') || '';
    const handshakeIp = clientIp(req);
    let cleanPath = req.url;
    if (cleanPath.includes(HANDSHAKE_RETRY_PARAM)) {
      handshake.clear(handshakeIp);
      cleanPath = stripQueryParam(cleanPath, HANDSHAKE_RETRY_PARAM);
    }
    const handshakeOver = launchTok !== '' && handshake.exhausted(handshakeIp);
    const upstreamPath = handshakeOver
      ? cleanPath
      : upstreamPathWithLaunchToken(cleanPath, req.method, req.headers.cookie, launchTok, launchTokenQueryName);
    const didInjectToken = upstreamPath !== cleanPath;
    if (didInjectToken) {
      handshake.record(handshakeIp);
      handshake.prune();
    }
    if (!didInjectToken && launchTok !== '' && String(req.headers.cookie ?? '').includes(launchAuthCookieName)) {
      handshake.clear(handshakeIp);
    }
    if (handshakeOver && isHtmlRequest(req)) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-saros-pocket-handshake': 'blocked' });
      res.end(handshakeBlockedPageHtml());
      return;
    }
    const proxyReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: upstreamPath, headers, agent: false },
      (proxyRes) => {
        log?.(`${req.method} ${req.url} -> ${proxyRes.statusCode}`);
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        if (didInjectToken && proxyRes.statusCode === 303 && isHtmlRequest(req)) {
          const out = { ...proxyRes.headers };
          delete out['content-length'];
          delete out['transfer-encoding'];
          delete out.location;
          const page = Buffer.from(handshakePageHtml(), 'utf8');
          out['content-type'] = 'text/html; charset=utf-8';
          out['content-length'] = String(page.length);
          out['cache-control'] = 'no-store';
          out['x-saros-pocket-handshake'] = 'transition';
          proxyRes.resume();
          res.writeHead(200, out);
          res.end(page);
          return;
        }
        if (injectHtml && contentType.includes('text/html') && !isCompressed(proxyRes.headers)) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            if (!html.includes(INJECT_MARK)) {
              html = html.replace(/<head[^>]*>/i, (m) => `${m}${injectHtml}`);
            }
            const out = Buffer.from(html, 'utf8');
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            outHeaders['content-length'] = String(out.length);
            outHeaders['cache-control'] = 'no-store';
            delete outHeaders['etag'];
            delete outHeaders['last-modified'];
            delete outHeaders['expires'];
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(out);
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
        const canGzip = /\bgzip\b/.test(acceptEncoding);
        const canBr = /\bbr\b/.test(acceptEncoding);
        const isEventStream = contentType.includes('text/event-stream');
        const knownLen = Number(proxyRes.headers['content-length'] || 0);
        const shouldCompress = (canGzip || canBr)
          && !isCompressed(proxyRes.headers)
          && !isEventStream
          && (contentType.includes('application/json') || contentType.startsWith('text/'))
          && (knownLen === 0 || knownLen >= 1024);
        if (shouldCompress) {
          const enc = canBr ? 'br' : 'gzip';
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders['content-length'];
          delete outHeaders['transfer-encoding'];
          outHeaders['content-encoding'] = enc;
          res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
          const z = enc === 'br'
            ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
            : createGzip();
          proxyRes.pipe(z).pipe(res);
          res.on('close', () => { proxyRes.destroy(); z.destroy(); });
          proxyRes.on('error', () => { z.destroy(); res.destroy(); });
          proxyRes.on('aborted', () => { z.destroy(); res.destroy(); });
          z.on('error', () => res.destroy());
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        res.on('close', () => proxyRes.destroy());
        proxyRes.on('error', () => res.destroy());
        proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
      },
    );
    proxyReq.on('error', (err) => {
      log?.(`saros-pocket: 上游不可达 ${upstream.host}:${upstream.port} | ${err.message}`);
      try { onUpstreamError?.(err); } catch { /* 回调不该影响响应 */ }
      // 浏览器导航：给一张能看懂、有出路的页面（桌面版下这个入口本来就打不开）；
      // 非导航（API / 脚本 / 探活）：保持单行文本，便于 grep 与自动化断言。
      if (isHtmlRequest(req)) {
        const page = Buffer.from(upstreamDownPageHtml({
          host: upstream.host,
          port: upstream.port,
          err: err.message,
          appPrefix,
          triedPath: String(req.url ?? '/'),
        }), 'utf8');
        if (!res.headersSent) {
          res.writeHead(502, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(page.length),
            'cache-control': 'no-store',
          });
        }
        res.end(page);
        return;
      }
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`saros-pocket: 无法连接上游 VsSaros（${upstream.host}:${upstream.port}）——请确认 VsSaros 已以 server/web 模式启动 | ${err.message}`);
    });
    req.pipe(proxyReq);
  });

  server.on('upgrade', (req, socket, head) => {
    const host = policyHost(req, String(req.headers.host ?? ''));
    const isPublic = classifyHost(host) === 'public';
    if (!isPublic && !isLoopbackHost(host) && !lanAccessEnabled()) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (auth) {
      const token = isProtectedHost(host, auth.isProtected) ? (auth.getToken?.(host) ?? null) : null;
      const altTokens = token && typeof auth.getAltTokens === 'function' ? (auth.getAltTokens(host) ?? []) : [];
      const acceptedTokens = token ? [token, ...altTokens] : [];
      const wsIp = clientIp(req);
      const wsGuess = hasQueryToken(req);
      if (token && wsGuess) {
        const rl = limiter?.status(wsIp) ?? { locked: false, retryAfter: 0 };
        if (rl.locked) {
          socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rl.retryAfter}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
          return;
        }
      }
      const wsAuth = authCheck(req, acceptedTokens, auth.sessionKey ?? null);
      if (token && !wsAuth.ok) {
        if (wsGuess) {
          limiter?.record(wsIp);
          log?.(`saros-pocket: bad ws ?token= from ${wsIp}`);
        }
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (token && wsAuth.ok && wsGuess) limiter?.clear(wsIp);
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest({
      host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers, agent: false,
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);
      socket.pipe(proxySocket, { end: false });
      proxySocket.pipe(socket, { end: false });
      if (heartbeat !== false) attachWebSocketHeartbeat(socket, heartbeat ?? {});
      const teardown = () => {
        try { proxySocket.resetAndDestroy?.() ?? proxySocket.destroy(); } catch { try { proxySocket.destroy(); } catch {} }
        try { socket.destroy(); } catch {}
      };
      proxySocket.on('error', () => { try { socket.destroy(); } catch {} });
      proxySocket.on('close', teardown);
      socket.on('close', teardown);
      socket.on('end', teardown);
      proxySocket.on('end', teardown);
    });
    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode === 101) return;
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        socket.end(raw.join('\r\n') + '\r\n\r\n');
        proxyRes.resume();
      } catch { socket.destroy(); }
    });
    proxyReq.on('error', (err) => {
      // WebSocket 没法回一张错误页，但至少要留痕：否则手机上「转圈不动」且无从排查
      log?.(`saros-pocket: 上游不可达（WebSocket）${upstream.host}:${upstream.port} | ${err?.message ?? err}`);
      try { onUpstreamError?.(err); } catch { /* 忽略 */ }
      socket.destroy();
    });
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on('error', () => socket.destroy());
  });

  const clientSockets = new Set();
  server.on('connection', (sock) => {
    clientSockets.add(sock);
    sock.on('close', () => clientSockets.delete(sock));
    sock.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise((r) => {
          for (const s of clientSockets) { try { s.destroy(); } catch { /* 忽略 */ } }
          server.close(() => r());
        }),
      });
    });
  });
}
