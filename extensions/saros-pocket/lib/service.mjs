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
import { lanIPv4, listLanCandidates, listLanInterfaces, probeHttp, probeUpstreamPort } from './host.mjs';

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
 * @param {string} [opts.brandHtml] 登录页品牌 HTML（扩展读 app/saros-logo.svg 转 data URI 传入）
 * @param {string} [opts.appPrefix] Pocket App 的路径前缀（如 `/pocket/`；缺省按 `/pocket/` 处理，
 *   因为「局域网自检」必须打 App 入口 —— 根路径是桌面版必然打不开的同屏 web 入口）。
 *   有值时 status() 额外给出 `lanAppUrl` / `tunnelAppUrl` 与对应二维码 ——
 *   手机扫码直接进 App，而不是先进 VsSaros web 首页再手动改地址。
 * @param {object} [opts.log] 日志（VS Code OutputChannel 形状：info/warn/error）
 * @param {object} [opts.deps] 依赖替换（仅供测试）：{ createProxy, startQuickTunnel, startNamedTunnel, probeUpstream, probeHttp }
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
  brandHtml = '',
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
      lanCandidateCache = { at: now, ips: await listLanCandidates(), ifaces: listLanInterfaces() };
    }
    return lanCandidateCache.ips;
  };
  /** 候选网卡明细（ip / 网卡名 / 是否疑似虚拟网卡）——手机连不上时用来换地址。 */
  const getLanInterfaces = async () => {
    await getLanCandidates();
    return lanCandidateCache.ifaces;
  };

  /**
   * 「本机 → 当前局域网地址」的可达性自检结果。
   * ok=null 表示还没测过。手机连不上时的第一步排查：这个地址是不是本机网卡的地址。
   * ⚠ 本机访问自己的局域网 IP 走 loopback 捷径、不经防火墙入站规则 ⇒ ok=true **不能**证明手机能连。
   */
  const lanCheckState = { ip: null, url: null, ok: null, status: null, detail: '', checkedAt: null };

  let proxy = null;
  let tunnel = null;
  let tunnelAbort = null;
  let tunnelPromise = null;
  const tunnelState = { phase: 'idle', detail: '', startedAt: null, download: null };
  /**
   * 上游（VsSaros server，即「同屏 web」入口的上游）可用性。
   * ok=null 表示还没探测过。启动时探一次，之后由「上游报错」与面板的重新探测更新。
   */
  const upstreamState = { ok: null, checkedAt: null, error: '' };
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
    /**
     * 探测上游 VsSaros server 是否在监听。
     *
     * 面板用它回答「同屏 web 到底能不能用」——桌面版 vssaros.exe 不监听 HTTP 端口，
     * 这条入口本来就不可用（App 不受影响），提前说明比让用户撞 502 强。
     * @returns {Promise<{ok:boolean|null, checkedAt:number|null, error:string}>}
     */
    /**
     * 自检「本机 → 当前局域网地址」这一跳。
     *
     * 手机报「网站无响应」（超时而非拒绝）时的第一步排查：这个地址到底是不是本机网卡的地址？
     * ok=false ⇒ 多半是自动挑中了 VPN / 虚拟网卡的地址（手机路由不到）⇒ 面板让用户换候选地址。
     * ok=true 只说明代理确实绑在该地址上，**不**代表手机能连（本机到自己的 IP 走 loopback，不经防火墙）。
     * @returns {Promise<{ip:string|null, url:string|null, ok:boolean|null, status:number|null, detail:string, checkedAt:number}>}
     */
    async checkLanReachability() {
      const ip = await getLan();
      const port = proxy?.port ?? null;
      // ★ 自检必须打**用户真正会访问的入口**（App）。缺省前缀时不能退化成根路径：
      //   根路径 = 同屏 web 入口，桌面版 VsSaros 不监听 HTTP 端口 ⇒ 必然"连不上"，
      //   用它自检会得出误导结论（让人以为网卡选错了）。
      const url = ip && port ? `http://${ip}:${port}${appPrefix || '/pocket/'}` : null;
      if (!url) {
        Object.assign(lanCheckState, {
          ip, url: null, ok: null, status: null,
          detail: '代理未启动或没检测到局域网地址', checkedAt: Date.now(),
        });
        return { ...lanCheckState };
      }
      const probe = deps.probeHttp ?? probeHttp;
      const r = await probe(url);
      Object.assign(lanCheckState, {
        ip, url,
        ok: r.ok === true,
        status: r.status ?? null,
        detail: r.ok
          ? `本机可连（HTTP ${r.status}）—— 说明代理就绑在这个地址上`
          : `本机连不上：${r.error ?? '未知错误'} —— 这个地址很可能不是本机当前网卡的地址（VPN / 虚拟网卡）`,
        checkedAt: Date.now(),
      });
      return { ...lanCheckState };
    },

    async probeUpstream() {
      const probe = deps.probeUpstream ?? probeUpstreamPort;
      try {
        upstreamState.ok = await probe(upstreamPort);
      } catch {
        upstreamState.ok = false;
      }
      upstreamState.checkedAt = Date.now();
      if (upstreamState.ok) upstreamState.error = '';
      else if (!upstreamState.error) upstreamState.error = `connect ECONNREFUSED 127.0.0.1:${upstreamPort}`;
      return { ...upstreamState };
    },

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
            brandHtml,
            appPrefix,
            // 上游不可达（HTTP / WebSocket 两条路径）→ 记下来，面板据实显示
            onUpstreamError: (err) => {
              upstreamState.ok = false;
              upstreamState.checkedAt = Date.now();
              upstreamState.error = String(err?.message ?? err ?? '');
            },
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
      // 不阻塞启动：探测失败要等超时（约 600ms），面板里显示「检测中…」即可
      void this.probeUpstream().catch(() => { /* 探测失败不影响代理 */ });
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
        // 离开下载阶段就别再留旧进度，否则面板会一直显示"已下 X MB"
        if (phase !== 'downloading') tunnelState.download = null;
      };
      // 下载进度（真实字节数，不是假动画）：透给面板/手机端显示百分比
      const onProgress = ({ received, total }) => {
        tunnelState.download = { received, total, percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null };
        if (tunnelState.phase === 'downloading') {
          tunnelState.detail = total > 0
            ? `下载 cloudflared ${formatBytes(received)} / ${formatBytes(total)}`
            : `下载 cloudflared ${formatBytes(received)}`;
        }
      };
      const p = (async () => {
        await null;
        try {
          const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
          if (cfg?.mode === 'named') {
            if (!cfg.token || !cfg.hostname) throw new Error('命名隧道未配置完整：需要 Tunnel Token 和固定域名');
            const result = await startNamed({ token: cfg.token, home: storageDir, signal: controller.signal, onPhase, onProgress });
            tunnel = { url: `https://${cfg.hostname}`, kill: result.kill, onExit: result.onExit };
          } else {
            const result = await startTunnel({ port: proxy.port, home: storageDir, signal: controller.signal, onPhase, onProgress });
            tunnel = typeof result === 'string' ? { url: result, kill: () => {} } : result;
          }
          tunnelState.phase = 'ready';
          // 先取 url：onExit 回调里会把 tunnel 置空（URL 失效则断流），
          // 最后 `return tunnel.url` 会踩到 null。
          const readyUrl = tunnel.url;
          tunnel.onExit?.((code) => {
            if (controller.signal.aborted) return;
            tunnelState.phase = 'error';
            tunnelState.detail = `隧道进程退出（code=${code}）`;
            // ★ 进程已死 ⇒ URL 立刻失效。留着它会让面板继续展示这个地址、
            // 用户扫码得到一个 Cloudflare 边缘的 502（回源没了），极难自查。
            // status 的 tunnelUrl 取的是 `tunnel?.url`，所以置空 tunnel 即可断流。
            tunnel = null;
          });
          void persistAutoTunnel();
          try { onTunnelReady?.(cfg?.mode === 'named' ? 'named' : 'quick'); } catch { /* 忽略 */ }
          return readyUrl;
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
        // ★ 刻意**不**再产出 `lanQr`（代理根路径 = 同屏 web 入口的二维码）：
        //   桌面版 VsSaros 不监听 HTTP 端口 ⇒ 那个码扫进去必然是「同屏 web 暂不可用」页，
        //   面板的「局域网访问」卡早就改用它下面的 `lanAppQr`（= `/pocket/`）。留着只会被人再接回去。
        lanAppUrl,
        lanAppQr: await qrCached(lanAppUrl),
        lanCandidates,
        // 候选地址明细（ip / 网卡名 / 是否虚拟）+ 已配的覆盖值：面板让用户一键换地址
        lanInterfaces: await getLanInterfaces(),
        lanIpOverride,
        // 「本机 → 局域网地址」自检结果（ok=null 表示还没测过；由面板的「检测本机」触发）
        lanCheck: { ...lanCheckState },
        tunnelRunning: tunnel !== null,
        tunnelUrl: tunnel?.url ?? null,
        // ★ 与 `lanQr` 同因：根路径 = 同屏 web 入口，桌面版 VsSaros 不监听 HTTP 端口
        //   ⇒ 扫这个码进去必然是代理返回的 502（proxy.mjs 上游不可达分支）。
        //   公网二维码因此改用 App 入口（/pocket/）；根路径地址仍在 `tunnelUrl`
        //   里以文本/链接形式给出，上游真可用时照样能进同屏 web，不丢入口。
        tunnelQr: await qrCached(tunnelAppUrl ?? tunnel?.url ?? null),
        tunnelAppUrl,
        tunnelAppQr: await qrCached(tunnelAppUrl),
        tunnelState: { ...tunnelState },
        tunnelConfig: (() => {
          const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
          return { mode: cfg?.mode === 'named' ? 'named' : 'quick', hostname: typeof cfg?.hostname === 'string' ? cfg.hostname : '', tokenSet: Boolean(cfg?.token) };
        })(),
        upstreamPort,
        // 上游（同屏 web 入口）可用性：null = 还没探测过
        upstreamOk: upstreamState.ok,
        upstreamError: upstreamState.error,
        upstreamCheckedAt: upstreamState.checkedAt,
      };
    },

    /**
     * 只停代理（不动隧道状态）。
     *
     * 为什么单独给一个：**代理是真监听 0.0.0.0 的 HTTP server**，忘了关就会
     * ① 占住端口（后续测试/启动撞 EADDRINUSE）② 事件循环里留着 handle ⇒ 进程**不退出**。
     * 测试里每个用例结束都该调它（见 test/service.test.mjs 的 withService）；
     * 扩展的 `deactivate` 也该走它，避免"关了 VsSaros 代理还活着"。
     * @returns {Promise<boolean>} 是否真的关掉了一个在跑的代理
     */
    async stopProxy() {
      if (!proxy) return false;
      const p = proxy;
      proxy = null;
      try { await p.close(); } catch { /* 忽略：关不掉也不能让调用方炸 */ }
      return true;
    },

    async dispose() {
      this.stopTunnel({ keepAutoMarker: true });
      await this.stopProxy();
    },
  };
}
