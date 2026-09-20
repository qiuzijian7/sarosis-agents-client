// Saros Agents Pocket 服务：在 VsSaros 扩展进程内跑改头代理 + 公网隧道
//
// - 代理：监听 0.0.0.0:<port>（默认 3081），把入站 Host/Origin 改写成
//   127.0.0.1:<upstreamPort>（VsSaros server 实际端口），HTTP + WebSocket 全透传，
//   并注入 VsSaros 连接令牌（?tkn= / vscode-tkn cookie）。手机看到的界面与电脑一致、实时。
// - 隧道：cloudflared 快速/命名隧道（可选），公网 https URL。

import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createPocketProxy, classifyHost } from './proxy.mjs';
import { startQuickTunnel, startNamedTunnel } from './tunnel.mjs';
import { lanIPv4, listLanCandidates } from './host.mjs';

const require = createRequire(import.meta.url);

/** URL → 二维码 data URL（全本地，不依赖第三方）。 */
export async function qrDataUrl(text, { width = 220, margin = 1 } = {}) {
  const QRCode = require('qrcode');
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin, width, type: 'image/png' });
}

/**
 * 创建 Pocket 服务。
 * @param {object} opts
 * @param {number} opts.upstreamPort  VsSaros server 实际端口（默认 8000）
 * @param {number} [opts.port]        代理端口（默认 3081）
 * @param {string} opts.storageDir    扩展 globalStorage 目录
 * @param {ReturnType<import('./state.mjs').createStateStore>} opts.state 状态仓库
 * @param {() => string} [opts.launchToken] VsSaros 连接令牌（?tkn=）
 * @param {object} [opts.getTunnelConfig] () => { mode, token, hostname }
 * @param {(mode:'quick'|'named') => string} [opts.onTunnelReady]
 * @param {Array<{prefix:string, handle:(req,res)=>Promise<boolean>}>} [opts.routes]
 *   代理本地路由（Pocket App 静态资源 + RPC 通道），由代理在鉴权之后接管
 * @param {string} [opts.appPrefix] Pocket App 的路径前缀（如 `/pocket/`）。
 *   有值时 status() 额外给出 `lanAppUrl` / `tunnelAppUrl` 与对应二维码 ——
 *   手机扫码直接进 App，而不是先进 VsSaros web 首页再手动改地址。
 * @param {object} [opts.log] 日志（VS Code OutputChannel 形状：info/warn/error）
 * @param {object} [opts.deps] 依赖替换（仅供测试）：{ createProxy, startQuickTunnel, startNamedTunnel }
 */
export function createPocketService({
  upstreamPort,
  port = 3081,
  storageDir,
  state,
  launchToken = () => '',
  getTunnelConfig,
  onTunnelReady,
  routes = [],
  appPrefix = '',
  log = console,
  deps = {},
} = {}) {
  // ── 日志适配 ────────────────────────────────────────────────────────────
  // ★ 必须同时吃两种形状：VS Code 的 **OutputChannel**（只有 appendLine/append，
  //   没有 info/warn/log）与 **console**（有 info/warn/log，没有 appendLine）。
  //   历史 bug：`(log.info ?? log.log).call(log, ...)` —— 扩展传的正是 OutputChannel，
  //   两个属性都不存在 ⇒ `undefined.call` ⇒ TypeError:
  //   "Cannot read properties of undefined (reading 'call')"，
  //   触发点 activate → restoreTunnelIfNeeded（每次激活必经）⇒ 变成 unhandled rejection。
  //   日志本身失败**绝不允许影响主流程**，故最外层再包 try/catch。
  const formatArgs = (args) => {
    const [head, ...rest] = args;
    if (typeof head !== 'string' || rest.length === 0) {
      return args.map((a) => String(a)).join(' ');
    }
    let i = 0;
    const replaced = head.replace(/%[sdifjoO]/g, () => (i < rest.length ? String(rest[i++]) : ''));
    return i < rest.length ? `${replaced} ${rest.slice(i).map((a) => String(a)).join(' ')}` : replaced;
  };
  const logAt = (level, args) => {
    const msg = formatArgs(args);
    try {
      if (typeof log?.appendLine === 'function') { log.appendLine(msg); return; }  // OutputChannel
      const fn = typeof log?.[level] === 'function'
        ? log[level]
        : (typeof log?.log === 'function' ? log.log : console.log);
      fn.call(log ?? console, msg);
    } catch { /* 日志失败不影响主流程 */ }
  };
  const logInfo = (...args) => logAt('info', args);
  const logWarn = (...args) => logAt('warn', args);
  // proxy.mjs 以 log?.(msg) 调用式使用；OutputChannel 不可调用，这里包一层。
  const logFn = (msg) => logAt('info', [msg]);
  // 依赖注入点：默认用真实实现；deps 仅供测试替换（端口重试等分支需要造 EADDRINUSE）。
  const createProxy = deps.createProxy ?? createPocketProxy;
  const startTunnel = deps.startQuickTunnel ?? startQuickTunnel;
  const startNamed = deps.startNamedTunnel ?? startNamedTunnel;

  const getLan = async () => {
    const override = String(state.lanIpOverride()).trim();
    if (override) return override;
    return lanIPv4();
  };
  let lanCandidateCache = null;
  const getLanCandidates = async () => {
    const now = Date.now();
    if (!lanCandidateCache || now - lanCandidateCache.at > 15000) {
      lanCandidateCache = { at: now, ips: await listLanCandidates() };
    }
    return lanCandidateCache.ips;
  };

  let proxy = null;
  let tunnel = null;
  let tunnelAbort = null;
  let tunnelPromise = null;
  const tunnelState = { phase: 'idle', detail: '', startedAt: null };
  const qrCache = new Map();
  const encodeQr = qrDataUrl;
  async function qrCached(text) {
    if (!text) return null;
    if (!qrCache.has(text)) {
      if (qrCache.size >= 8) { const oldest = qrCache.keys().next().value; qrCache.delete(oldest); }
      qrCache.set(text, encodeQr(text).catch(() => null));
    }
    return qrCache.get(text);
  }

  const autoStatePath = storageDir ? join(storageDir, 'saros-pocket', 'tunnel-auto.json') : null;
  let autoStateQueue = Promise.resolve();
  function persistAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try { await mkdir(dirname(autoStatePath), { recursive: true }); await writeFile(autoStatePath, JSON.stringify({ at: Date.now() }), 'utf8'); } catch { /* 忽略 */ }
    });
    return autoStateQueue;
  }
  function clearAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => { try { await rm(autoStatePath, { force: true }); } catch { /* 忽略 */ } });
    return autoStateQueue;
  }

  // 上游 Host 保护判定：loopback/局域网按开关（默认开），公网永远要密码（fail closed）
  function isProtectedHost(host) {
    if (state.isLanOverrideHost(host)) return state.lanAuthEnabled();
    return classifyHost(host) === 'public' ? true : state.lanAuthEnabled();
  }

  return {
    upstreamPort,
    async startProxy() {
      if (proxy) return proxy;
      let lastErr = null;
      for (let p = port; p < port + 10; p++) {
        try {
          proxy = await createProxy({
            port: p,
            host: '0.0.0.0',
            upstream: { host: '127.0.0.1', port: upstreamPort },
            log: logFn,
            launchToken,
            launchTokenQueryName: 'tkn',
            launchAuthCookieName: 'vscode-tkn',
            lanAccessEnabled: () => state.lanEnabled(),
            routes,
            auth: {
              sessionKey: require('node:crypto').randomBytes(16).toString('hex'),
              getToken: (host) => state.tokenForHost(host),
              isProtected: isProtectedHost,
            },
          });
          if (p !== port) logInfo(`Saros Pocket: 端口 ${port} 被占用，代理改用 ${p}`);
          break;
        } catch (err) {
          if (err?.code !== 'EADDRINUSE') throw err;
          lastErr = err;
        }
      }
      if (!proxy) throw lastErr ?? new Error('代理启动失败 | proxy start failed');
      return proxy;
    },

    async startTunnel() {
      await this.startProxy();
      if (tunnel) return tunnel.url;
      if (tunnelPromise) return tunnelPromise;
      const controller = new AbortController();
      tunnelAbort = controller;
      tunnelState.startedAt = Date.now();
      const onPhase = (phase) => {
        tunnelState.phase = phase;
        if (phase === 'downloading') tunnelState.detail = '首次下载 cloudflared（约 20MB）';
        else if (phase === 'starting') tunnelState.detail = '启动隧道进程…';
        else if (phase === 'registering') tunnelState.detail = '连接 Cloudflare 边缘（通常 5-30 秒）';
        else if (phase === 'ready') tunnelState.detail = '隧道就绪';
      };
      const p = (async () => {
        await null;
        try {
          const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
          if (cfg?.mode === 'named') {
            if (!cfg.token || !cfg.hostname) throw new Error('命名隧道未配置完整：需要 Tunnel Token 和固定域名');
            const result = await startNamed({ token: cfg.token, home: storageDir, signal: controller.signal, onPhase });
            tunnel = { url: `https://${cfg.hostname}`, kill: result.kill, onExit: result.onExit };
          } else {
            const result = await startTunnel({ port: proxy.port, home: storageDir, signal: controller.signal, onPhase });
            tunnel = typeof result === 'string' ? { url: result, kill: () => {} } : result;
          }
          tunnelState.phase = 'ready';
          tunnel.onExit?.((code) => {
            if (controller.signal.aborted) return;
            tunnelState.phase = 'error';
            tunnelState.detail = `隧道进程退出（code=${code}）`;
          });
          void persistAutoTunnel();
          try { onTunnelReady?.(cfg?.mode === 'named' ? 'named' : 'quick'); } catch { /* 忽略 */ }
          return tunnel.url;
        } catch (err) {
          if (!controller.signal.aborted) { tunnelState.phase = 'error'; tunnelState.detail = err?.message ?? String(err); }
          tunnelState.startedAt = null;
          throw err;
        } finally {
          if (tunnelPromise === p) tunnelPromise = null;
        }
      })();
      tunnelPromise = p;
      return p;
    },

    stopTunnel({ keepAutoMarker = false } = {}) {
      tunnelAbort?.abort();
      tunnelAbort = null;
      tunnelPromise = null;
      if (tunnel) tunnel.kill();
      tunnel = null;
      tunnelState.phase = 'idle';
      tunnelState.detail = '';
      tunnelState.startedAt = null;
      if (!keepAutoMarker) void clearAutoTunnel();
    },

    async restoreTunnelIfNeeded() {
      logInfo('Saros Pocket: 自动恢复检查');
      if (!autoStatePath || tunnel || tunnelPromise) return;
      let has = false;
      try { const raw = await readFile(autoStatePath, 'utf8'); has = /"at"\s*:/.test(raw); } catch { return; }
      if (!has) return;
      logInfo('Saros Pocket: 发现上次开启标记，尝试自动恢复隧道');
      try { await this.startTunnel(); logInfo('Saros Pocket: 已自动恢复公网隧道'); }
      catch (err) { logWarn('Saros Pocket: 隧道自动恢复失败：%s', err?.message ?? err); }
    },

    async status() {
      const lan = await getLan();
      const proxyPort = proxy?.port ?? null;
      const lanUrl = lan && proxyPort ? `http://${lan}:${proxyPort}` : null;
      // ★ App 入口与 VsSaros web 入口同源、同密码（同一个代理），只差一个路径前缀；
      //   单独给出 app URL + 二维码，手机才能扫码**直接进 App**（否则先进 web 首页，还得手动改地址）。
      const lanAppUrl = lanUrl && appPrefix ? `${lanUrl}${appPrefix}` : null;
      const tunnelAppUrl = tunnel?.url && appPrefix ? `${tunnel.url}${appPrefix}` : null;
      const lanIpOverride = state.lanIpOverride();
      const lanCandidates = [...new Set(await getLanCandidates())];
      if (lanIpOverride && !lanCandidates.includes(lanIpOverride)) lanCandidates.push(lanIpOverride);
      return {
        proxyRunning: proxy !== null,
        proxyPort,
        lanEnabled: state.lanEnabled(),
        lanAuthEnabled: state.lanAuthEnabled(),
        lanToken: state.getLanToken(),
        publicPin: state.getAccessToken(),
        lanUrl,
        lanQr: await qrCached(lanUrl),
        lanAppUrl,
        lanAppQr: await qrCached(lanAppUrl),
        lanCandidates,
        lanIpOverride,
        tunnelRunning: tunnel !== null,
        tunnelUrl: tunnel?.url ?? null,
        tunnelQr: await qrCached(tunnel?.url ?? null),
        tunnelAppUrl,
        tunnelAppQr: await qrCached(tunnelAppUrl),
        tunnelState: { ...tunnelState },
        tunnelConfig: (() => {
          const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
          return { mode: cfg?.mode === 'named' ? 'named' : 'quick', hostname: typeof cfg?.hostname === 'string' ? cfg.hostname : '', tokenSet: Boolean(cfg?.token) };
        })(),
        upstreamPort,
      };
    },

    async dispose() {
      this.stopTunnel({ keepAutoMarker: true });
      if (proxy) { const p = proxy; proxy = null; try { await p.close(); } catch { /* 忽略 */ } }
    },
  };
}
