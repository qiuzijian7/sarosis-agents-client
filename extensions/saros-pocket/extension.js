// Saros Agents Pocket — VsSaros 原生扩展入口
//
// 激活时：发现 VsSaros server 端口与连接令牌 → 启动改头反向代理（0.0.0.0:3081）→
// 按需开启公网隧道 → 提供访问面板（二维码 + 密码 + 开关）。手机扫码即远程同步访问。
//
// 同时托管 Pocket App（/pocket/）：一个手机优先的轻量客户端，通过
//   POST /saros-pocket/rpc/<endpoint>  +  GET /saros-pocket/events（SSE）
// 与 VsSaros 通信（聊天/文件/命令/状态）。通道挂在代理的本地路由上，
// 因此天然复用代理的访问密码与局域网开关，不另开认证口子。

import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStateStore } from './lib/state.mjs';
import { createPocketService } from './lib/service.mjs';
import { appEntryUrl, discoverUpstreamPort, discoverConnectionToken } from './lib/host.mjs';
import { createEventBus } from './lib/events.mjs';
import { createPocketRpc, RPC_PREFIX } from './lib/rpc.mjs';
import { createAppServer, APP_PREFIX } from './lib/app.mjs';
import { createVsSarosBridge } from './lib/bridge.mjs';
import { createScreenSource } from './lib/screen.mjs';
import { createDesktopInput } from './lib/desktop-input.mjs';

const PANEL_CSP = "default-src 'none'; img-src data: https:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self'; connect-src 'self'";

let service = null;
let out = null;
let panel = null;
let bridge = null;
let screen = null;

function cfg() { return vscode.workspace.getConfiguration('sarosPocket'); }

/**
 * 状态仓库的「开关类」后端：把 lanEnabled / lanAuthEnabled / lanIpOverride /
 * tunnelMode / tunnelHostname 五个开关落到 **VsSaros 设置**（`sarosPocket.*`）。
 *
 * 为什么：这五项以前只存在于扩展 globalStorage，于是**插件设置页看不到、也改不了**
 * （用户反馈「面板里有的选项，插件设置里没有」）。落到设置后，访问面板与插件详情页
 * 读写同一份值 —— 面板开关 = 设置开关。
 *
 * ⚠ 密码（PIN）与隧道 Token 不走这里：它们只落 globalStorage（0600），不进 settings.json。
 */
function createSettingsBackend() {
  return {
    get: (name) => cfg().get(name),
    update: (name, value) => {
      try {
        return Promise.resolve(cfg().update(name, value, vscode.ConfigurationTarget.Global))
          .catch((err) => { out?.appendLine(`Saros Pocket: 写入设置 ${name} 失败：${err?.message ?? err}`); });
      } catch (err) {
        out?.appendLine(`Saros Pocket: 写入设置 ${name} 抛错：${err?.message ?? err}`);
        return Promise.resolve();
      }
    },
  };
}

/** 桥接层读取的配置快照（每次调用实时读，用户改设置立即生效）。 */
function configSnapshot() {
  const c = cfg();
  return {
    chatModel: String(c.get('chatModel') ?? ''),
    chatSystemPrompt: String(c.get('chatSystemPrompt') ?? ''),
    agentCommand: String(c.get('agentCommand') ?? 'workbench.action.chat.open'),
    agentMode: String(c.get('agentMode') ?? 'agent'),
    allowedCommands: c.get('allowedCommands'),
    allowFileWrite: c.get('allowFileWrite') === true,
    allowTerminal: c.get('allowTerminal') === true,
    fileRoot: String(c.get('fileRoot') ?? ''),
    maxFileBytes: Number(c.get('maxFileBytes') ?? 262144),
    desktopEnabled: c.get('desktopEnabled') !== false,
    allowDesktopInput: c.get('allowDesktopInput') === true,
    desktopFps: Number(c.get('desktopFps') ?? 4),
    desktopQuality: Number(c.get('desktopQuality') ?? 55),
    desktopScale: Number(c.get('desktopScale') ?? 0.5),
    desktopMode: String(c.get('desktopMode') ?? 'window'),
    desktopProcessName: String(c.get('desktopProcessName') ?? 'vssaros'),
    desktopMonitor: Number(c.get('desktopMonitor') ?? -1),
  };
}

/**
 * App / RPC 的可访问地址（本机 loopback 形式，**不含密码**）。
 * 用于日志、复制地址（要给别人的那种）；要直接打开浏览器请用 appBrowserUrl()。
 */
function appUrl(proxyPort) {
  return appEntryUrl(proxyPort, APP_PREFIX);
}

/**
 * 「一键在浏览器打开」用的地址：带 `?token=<局域网访问密码>`，代理据此种 cookie ⇒
 * 免手动输密码（App 载入后会把参数从地址栏摘掉）。用 loopback ⇒ 密码只在本机流转。
 */
function appBrowserUrl(proxyPort) {
  return appEntryUrl(proxyPort, APP_PREFIX, state?.getLanToken?.() ?? '');
}

/**
 * 品牌 logo 文件（与 VsSaros 同款）：`app/saros-logo.svg`。
 *
 * 为什么放在 `app/` 而不是 `media/`：App 由代理静态托管（`/pocket/saros-logo.svg`），
 * 文件必须在 appDir 内；面板与登录页复用同一份，避免多处拷贝导致漂移。
 */
function brandLogoPath(context) {
  return join(context.extensionPath, 'app', 'saros-logo.svg');
}

/** 品牌 logo 的 data URI（登录页、插件详情页里的内嵌面板都要用；webview 里没法引用扩展文件）。 */
function brandLogoDataUri(context) {
  try {
    const svg = readFileSync(brandLogoPath(context));
    return `data:image/svg+xml;base64,${svg.toString('base64')}`;
  } catch (err) {
    out?.appendLine(`Saros Pocket: 品牌 logo 读取失败（将退回纯文字标题）：${err?.message ?? err}`);
    return '';
  }
}

/** 登录页是代理直接吐的 HTML，拿不到扩展路径 ⇒ 把 logo 转成 data URI 注入。 */
function brandLogoDataHtml(context) {
  const uri = brandLogoDataUri(context);
  return uri ? `<img src="${uri}" alt="VsSaros">` : '';
}

/** 面板要展示的状态载荷（独立面板与内嵌面板共用一份）。 */
async function panelStatus() {
  if (!service) return null;
  const s = await service.status();
  return { ...s, appUrl: appUrl(s.proxyPort) };
}

async function buildStatusAndPost() {
  if (!panel || !service) return;
  panel.webview.postMessage({ command: 'status', status: await panelStatus() });
}

/**
 * 处理面板消息 —— **唯一实现**。
 *
 * 两个消费方：
 *   1. 独立面板（`vscode.window.createWebviewPanel`，见 `showPanel`）；
 *   2. **插件详情页里的内嵌面板**（VsSaros → Plugins → Installed → saros-pocket → 快速访问）：
 *      那个 webview 由渲染层创建，消息经命令 `sarosPocket.panel` 转进来。
 * 之所以抽出来：内嵌面板必须是同一套逻辑（改密码 / 开关隧道都只有一个真源），
 * 否则两处行为迟早漂移。
 *
 * @param {{command?: string, value?: any, which?: string, mode?: string, hostname?: string, token?: string}} msg
 * @returns {Promise<{status: object|null, info: string, error: string}>} 由调用方负责回投给界面
 */
async function handlePanelCommand(msg = {}) {
  const result = { status: null, info: '', error: '' };
  const refresh = async () => { result.status = await panelStatus(); };
  try {
    switch (msg.command) {
      case 'getStatus': await refresh(); break;
      case 'probeUpstream': {
        const up = await service.probeUpstream();
        out?.appendLine(`Saros Pocket: 上游探测（手动）${up.ok ? '可用' : '不可达'} 127.0.0.1:${service.upstreamPort}`);
        await refresh();
        break;
      }
      // 手机报「网站无响应」时的第一步排查：这个地址是不是本机网卡的地址
      case 'checkLan': {
        const c = await service.checkLanReachability();
        out?.appendLine(`Saros Pocket: 局域网自检 ${c.url ?? '(无地址)'} → ${c.detail}`);
        result.info = c.ok ? '本机可连该地址' : '本机连不上该地址（可能选错了网卡）';
        await refresh();
        break;
      }
      case 'openApp': await vscode.commands.executeCommand('sarosPocket.openApp'); break;
      case 'openScreen': await vscode.commands.executeCommand('sarosPocket.openScreen'); break;
      case 'toggleLan': {
        const on = state.setLanEnabled(msg.value);
        result.info = `局域网访问已${on ? '开启' : '关闭'}`;
        await refresh();
        break;
      }
      case 'toggleLanAuth': { state.setLanAuthEnabled(msg.value); await refresh(); break; }
      case 'startTunnel': {
        await service.startTunnel();
        result.info = '公网隧道已开启';
        await refresh();
        break;
      }
      case 'stopTunnel': { service.stopTunnel(); await refresh(); break; }
      case 'refreshLanToken': { state.refreshLanToken(); result.info = '局域网密码已刷新'; await refresh(); break; }
      case 'setTunnelConfig': {
        state.setTunnelMode(msg.mode === 'named' ? 'named' : 'quick');
        if (msg.hostname) state.setTunnelHostname(msg.hostname);
        if (msg.token && msg.token !== '********') state.setTunnelToken(msg.token);
        result.info = '隧道配置已保存';
        await refresh();
        break;
      }
      case 'setLanIpOverride': {
        const v = state.setLanIpOverride(msg.value ?? '');
        result.info = v ? `局域网地址已设为 ${v}` : '局域网地址覆盖已清除';
        await refresh();
        break;
      }
      case 'setCustomPin': {
        const v = String(msg.value ?? '').trim();
        if (!/^[a-zA-Z0-9]{8}$/.test(v)) { result.error = '密码必须是 8 位英文字母或数字'; break; }
        state.setCustomPin(msg.which, v);
        result.info = `${msg.which === 'public' ? '公网' : '局域网'}密码已设置`;
        await refresh();
        break;
      }
      case 'reset': {
        state.resetPocketState(); service.stopTunnel();
        result.info = '已恢复出厂设置';
        await refresh();
        break;
      }
      default: break;
    }
  } catch (err) {
    result.error = err?.message ?? String(err);
  }
  if (result.info) { vscode.window.showInformationMessage(`Saros Pocket · ${result.info}`); }
  else if (result.error) { vscode.window.showWarningMessage(`Saros Pocket · ${result.error}`); }
  return result;
}

/**
 * 面板 HTML（供**渲染层创建的 webview 元素**用）。
 *
 * 与 `showPanel` 的同名处理保持一致：注入 CSP、把 `{{LOGO_URI}}` 换成 data URI
 * （内嵌时拿不到 `asWebviewUri`，而 CSP 已允许 `data:`）。
 */
function buildPanelHtml(context) {
  const htmlPath = join(context.extensionPath, 'panel', 'index.html');
  let html = readFileSync(htmlPath, 'utf8');
  html = html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">`);
  return html.replace('{{LOGO_URI}}', brandLogoDataUri(context));
}

function showPanel(context) {
  if (panel) { panel.reveal(vscode.ViewColumn.Active); return; }
  panel = vscode.window.createWebviewPanel(
    'sarosPocket',
    'Saros Pocket · 访问面板',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  const htmlPath = join(context.extensionPath, 'panel', 'index.html');
  let html = readFileSync(htmlPath, 'utf8');
  html = html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">`);
  // 品牌 logo：webview 里用 asWebviewUri 引用本地文件（CSP 已允许 https:，webview 资源 URI 走 https）
  const logoUri = panel.webview.asWebviewUri(vscode.Uri.file(brandLogoPath(context))).toString();
  html = html.replace('{{LOGO_URI}}', logoUri);
  panel.webview.html = html;
  // 消息处理只有一份实现（handlePanelCommand）；这里只负责把结果回投给 webview
  panel.webview.onDidReceiveMessage(async (msg) => {
    const r = await handlePanelCommand(msg);
    const wv = panel?.webview;
    if (!wv) return;
    if (r.status) { wv.postMessage({ command: 'status', status: r.status }); }
    if (r.error) { wv.postMessage({ command: 'error', text: r.error }); }
  });
  panel.onDidDispose(() => { panel = null; });
  buildStatusAndPost();
}

let state = null;

async function activate(context) {
  out = vscode.window.createOutputChannel('Saros Pocket');
  const storageDir = context.globalStorageUri.fsPath;
  state = createStateStore(storageDir, { settings: createSettingsBackend() });

  const config = cfg();
  const upstreamPort = await discoverUpstreamPort(Number(config.upstreamPort) || 8000);
  const launchTok = await discoverConnectionToken({
    configured: String(config.connectionToken ?? ''),
    userDataDir: String(config.userDataDir ?? ''),
  });

  const port = state.proxyPort() || Number(config.proxyPort) || 3081;
  out.appendLine(`Saros Pocket: 上游 VsSaros server = 127.0.0.1:${upstreamPort}`);
  out.appendLine(`Saros Pocket: 连接令牌 = ${launchTok ? '已获取' : '未获取（免令牌模式）'}`);

  // ---------- Pocket App 通信层 ----------
  // 事件总线 → VsSaros 桥接 → RPC 通道；再加一个 App 静态服务，三者都作为
  // 代理的本地路由挂在鉴权之后。
  const events = createEventBus();
  // 屏幕采集：懒启动（有人订阅才抓屏），desktopEnabled=false 时拒绝启动
  screen = createScreenSource({
    getConfig: () => {
      const s = configSnapshot();
      return {
        fps: s.desktopFps, quality: s.desktopQuality, scale: s.desktopScale,
        mode: s.desktopMode, processName: s.desktopProcessName, monitor: s.desktopMonitor,
      };
    },
    enabled: () => configSnapshot().desktopEnabled !== false,
    log: out,
  });
  const desktopInput = createDesktopInput({
    allowed: () => configSnapshot().allowDesktopInput === true,
    getRect: () => screen?.rect?.() ?? null,
  });
  bridge = createVsSarosBridge({
    vscode,
    context,
    events,
    statusProvider: () => (service ? service.status() : Promise.resolve(null)),
    getConfig: configSnapshot,
    screen,
    desktopInput,
    log: out,
  });
  const rpc = createPocketRpc({ endpoints: bridge.endpoints, events, screen, log: out });
  const app = createAppServer({
    appDir: join(context.extensionPath, 'app'),
    boot: {
      rpcPrefix: `${RPC_PREFIX}rpc/`,
      eventsPath: `${RPC_PREFIX}events`,
      version: context.extension?.packageJSON?.version ?? null,
    },
    log: out,
  });

  service = createPocketService({
    upstreamPort,
    port,
    storageDir,
    state,
    routes: [app, rpc],
    appPrefix: APP_PREFIX,
    brandHtml: brandLogoDataHtml(context),
    launchToken: () => launchTok,
    getTunnelConfig: () => ({ mode: state.tunnelMode(), token: state.tunnelToken(), hostname: state.tunnelHostname() }),
    onTunnelReady: (mode) => { vscode.window.showInformationMessage(`Saros Pocket · 公网隧道（${mode === 'named' ? '命名' : '快速'}）已就绪`); void buildStatusAndPost(); },
    log: out,
  });

  try {
    await service.startProxy();
    const p = (await service.status()).proxyPort ?? port;
    out.appendLine(`Saros Pocket: 代理已启动，监听 0.0.0.0:${p}`);
    out.appendLine(`Saros Pocket: Pocket App = ${appUrl(p)} （RPC ${RPC_PREFIX}rpc/，事件流 ${RPC_PREFIX}events）`);
    // 远端键鼠**默认开启** ⇒ 必须在日志里留一行，否则用户不知道自己的电脑可被手机操控。
    // 判定表达式与 status 里的 desktopInputAllowed 保持**字面一致**（真源是清单里的 default）
    out.appendLine(cfg().allowDesktopInput === true
      ? 'Saros Pocket: 远端键鼠 = 允许（清单默认开启；可在设置 sarosPocket.allowDesktopInput 关闭）'
      : 'Saros Pocket: 远端键鼠 = 已关闭（sarosPocket.allowDesktopInput=false）');
  } catch (err) {
    vscode.window.showErrorMessage(`Saros Pocket · 代理启动失败：${err?.message ?? err}`);
    out.appendLine(`Saros Pocket: 代理启动失败：${err?.stack ?? err}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('sarosPocket.openPanel', () => showPanel(context)),
    vscode.commands.registerCommand('sarosPocket.openApp', async () => {
      try {
        await service.startProxy();
        const p = (await service.status()).proxyPort;
        // 带 ?token=<局域网访问密码> ⇒ 浏览器里免手动输密码（代理据此种 cookie；App 会把参数摘掉）
        await vscode.env.openExternal(vscode.Uri.parse(appBrowserUrl(p)));
      } catch (err) {
        vscode.window.showErrorMessage(`Saros Pocket · 打开 App 失败：${err?.message ?? err}`);
      }
    }),
    vscode.commands.registerCommand('sarosPocket.copyAppUrl', async () => {
      try {
        await service.startProxy();
        const p = (await service.status()).proxyPort;
        await vscode.env.clipboard.writeText(appUrl(p));
        vscode.window.showInformationMessage(`Saros Pocket · App 地址已复制：${appUrl(p)}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Saros Pocket · 复制失败：${err?.message ?? err}`);
      }
    }),
    vscode.commands.registerCommand('sarosPocket.openScreen', async () => {
      try {
        await service.startProxy();
        const p = (await service.status()).proxyPort;
        await vscode.env.openExternal(vscode.Uri.parse(`${appUrl(p)}#screen`));
      } catch (err) {
        vscode.window.showErrorMessage(`Saros Pocket · 打开屏幕失败：${err?.message ?? err}`);
      }
    }),
    vscode.commands.registerCommand('sarosPocket.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'sarosPocket')),
    // 插件详情页的「状态条」用：一次问清「手机能不能连 / 公网开没开 / 远程键鼠生效没」。
    // ⚠ 只回状态，**不回密码/Token**；任何探测失败都如实置 null（前端会隐藏对应胶囊，不显示假状态）。
    vscode.commands.registerCommand('sarosPocket.status', async () => {
      let s = null;
      try { s = service ? await service.status() : null; } catch (err) { out?.appendLine(`Saros Pocket: status 探测失败：${err?.message ?? err}`); }
      const c = configSnapshot();
      return {
        lanEnabled: state.lanEnabled(),
        lanAuthEnabled: state.lanAuthEnabled(),
        lanUrl: s?.lanUrl ?? null,
        proxyRunning: s?.proxyRunning === true,
        proxyPort: s?.proxyPort ?? null,
        tunnelRunning: s?.tunnelRunning === true,
        tunnelUrl: s?.tunnelUrl ?? null,
        upstreamOk: typeof s?.upstreamOk === 'boolean' ? s.upstreamOk : null,
        upstreamPort: s?.upstreamPort ?? null,
        desktopEnabled: c.desktopEnabled !== false,
        desktopSupported: screen?.status?.().supported === true,
        desktopInputSupported: desktopInput?.supported === true,
        desktopInputAllowed: c.allowDesktopInput === true,
      };
    }),
    // 插件详情页「快速访问」页签里的**内嵌访问面板**：
    //   1) panelHtml —— 把面板 HTML（含 CSP 与 logo data URI）交给渲染层去创建 webview；
    //   2) panel     —— 内嵌面板的消息回传，与独立面板共用 handlePanelCommand（单一实现）。
    vscode.commands.registerCommand('sarosPocket.panelHtml', () => buildPanelHtml(context)),
    vscode.commands.registerCommand('sarosPocket.panel', (msg) => handlePanelCommand(msg ?? {})),
    vscode.commands.registerCommand('sarosPocket.toggleLan', () => { const on = state.setLanEnabled(!state.lanEnabled()); vscode.window.showInformationMessage(`Saros Pocket · 局域网访问已${on ? '开启' : '关闭'}`); void buildStatusAndPost(); }),
    vscode.commands.registerCommand('sarosPocket.startTunnel', async () => { try { await service.startTunnel(); vscode.window.showInformationMessage('Saros Pocket · 公网隧道已开启'); } catch (e) { vscode.window.showErrorMessage(`Saros Pocket · 隧道启动失败：${e?.message ?? e}`); } void buildStatusAndPost(); }),
    vscode.commands.registerCommand('sarosPocket.stopTunnel', () => { service.stopTunnel(); vscode.window.showInformationMessage('Saros Pocket · 公网隧道已关闭'); void buildStatusAndPost(); }),
    vscode.commands.registerCommand('sarosPocket.reset', async () => { const ok = await vscode.window.showWarningMessage('恢复出厂设置将清空所有开关与密码，确定？', { modal: true }, '确定'); if (ok === '确定') { state.resetPocketState(); service.stopTunnel(); vscode.window.showInformationMessage('Saros Pocket · 已恢复出厂设置'); void buildStatusAndPost(); } }),

    // ---------- 隧道模式 / Token：模式是设置项，Token 是凭据（只进扩展目录） ----------
    vscode.commands.registerCommand('sarosPocket.useQuickTunnel', () => {
      state.setTunnelMode('quick');
      vscode.window.showInformationMessage('Saros Pocket · 隧道模式 = 快速（随机域名）');
      void buildStatusAndPost();
    }),
    vscode.commands.registerCommand('sarosPocket.useNamedTunnel', () => {
      state.setTunnelMode('named');
      const host = state.tunnelHostname();
      vscode.window.showInformationMessage(host
        ? `Saros Pocket · 隧道模式 = 命名（${host}）`
        : 'Saros Pocket · 已切到命名隧道，还需要填「固定域名」和「隧道 Token」才能开启');
      void buildStatusAndPost();
    }),
    vscode.commands.registerCommand('sarosPocket.setTunnelToken', async () => {
      const v = await vscode.window.showInputBox({
        title: 'Saros Pocket · 设置隧道 Token',
        prompt: 'Cloudflare Tunnel Token（只存扩展目录，不写进设置文件）',
        password: true,
        validateInput: (s) => (String(s).trim().length >= 20 ? null : 'Token 太短（至少 20 个字符）'),
      });
      if (!v) return;
      try {
        state.setTunnelToken(v.trim());
        vscode.window.showInformationMessage('Saros Pocket · 隧道 Token 已保存');
        void buildStatusAndPost();
      } catch (err) {
        vscode.window.showErrorMessage(`Saros Pocket · 设置失败：${err?.message ?? err}`);
      }
    }),

    // ---------- 密码类：不进 settings（会被同步/被读到），用命令 + 输入框 ----------
    vscode.commands.registerCommand('sarosPocket.refreshLanPin', () => {
      const v = state.refreshLanToken();
      vscode.window.showInformationMessage(`Saros Pocket · 局域网密码已刷新：${v}`);
      void buildStatusAndPost();
    }),
    vscode.commands.registerCommand('sarosPocket.setLanPin', async () => {
      const v = await vscode.window.showInputBox({
        title: 'Saros Pocket · 设置局域网密码',
        prompt: '8 位英文字母或数字（手机首次访问要输这个）',
        value: state.getLanToken(),
        validateInput: (s) => (/^[a-zA-Z0-9]{8}$/.test(String(s).trim()) ? null : '必须是 8 位英文字母或数字'),
      });
      if (!v) return;
      try {
        state.setCustomPin('lan', v.trim());
        vscode.window.showInformationMessage('Saros Pocket · 局域网密码已更新');
        void buildStatusAndPost();
      } catch (err) {
        vscode.window.showErrorMessage(`Saros Pocket · 设置失败：${err?.message ?? err}`);
      }
    }),
    vscode.commands.registerCommand('sarosPocket.setPublicPin', async () => {
      const v = await vscode.window.showInputBox({
        title: 'Saros Pocket · 设置公网密码',
        prompt: '8 位英文字母或数字（公网入口强制校验）',
        value: state.getAccessToken(),
        validateInput: (s) => (/^[a-zA-Z0-9]{8}$/.test(String(s).trim()) ? null : '必须是 8 位英文字母或数字'),
      });
      if (!v) return;
      try {
        state.setCustomPin('public', v.trim());
        vscode.window.showInformationMessage('Saros Pocket · 公网密码已更新');
        void buildStatusAndPost();
      } catch (err) {
        vscode.window.showErrorMessage(`Saros Pocket · 设置失败：${err?.message ?? err}`);
      }
    }),
  );

  // 上游可用性：桌面版 vssaros.exe 不监听 HTTP 端口 ⇒ 「同屏 web」入口本就不可用
  // （App 走扩展本地路由，不受影响）。这里探一次并写日志，面板据此提前说明，避免用户撞 502。
  void service.probeUpstream().then((up) => {
    out?.appendLine(up.ok
      ? `Saros Pocket: 上游可用（同屏 web 入口 http://127.0.0.1:${service.upstreamPort}）`
      : `Saros Pocket: 上游不可达 127.0.0.1:${service.upstreamPort} —— 同屏 web 入口不可用（桌面模式属预期）；Pocket App 不受影响`);
  }).catch(() => { /* 探测失败不影响任何功能 */ });

  // 设置页 / 插件详情页改了 `sarosPocket.*` → 面板立即同步；隧道参数变了就重建隧道
  // （这几个开关的真源在设置里，改设置必须让运行中的服务跟上，否则「改了没用」）。
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('sarosPocket')) return;
    void buildStatusAndPost();
    if (e.affectsConfiguration('sarosPocket.tunnelMode') || e.affectsConfiguration('sarosPocket.tunnelHostname')) {
      Promise.resolve(service.status()).then((s) => {
        if (!s.tunnelRunning) return;
        out?.appendLine('Saros Pocket: 隧道参数已变更，重建隧道');
        service.stopTunnel();
        return service.startTunnel();
      }).catch((err) => out?.appendLine(`Saros Pocket: 隧道重建失败：${err?.message ?? err}`));
    }
  }));

  if (config.launchPublicOnStart) {
    service.startTunnel().then(() => vscode.window.showInformationMessage('Saros Pocket · 公网隧道已自动开启')).catch((e) => vscode.window.showErrorMessage(`Saros Pocket · 自动隧道失败：${e?.message ?? e}`));
  } else {
    // ★ 必须挂 catch：之前这里裸调用，restoreTunnelIfNeeded 一抛就变成
    // 「rejected promise not handled within 1 second」的 unhandled rejection
    // （根因是日志助手遇到 OutputChannel 崩，已在 lib/service.mjs 修掉；
    //  但激活路径上的 async 调用一律不许裸奔）。
    service.restoreTunnelIfNeeded().catch((err) => {
      out?.appendLine(`Saros Pocket: 隧道自动恢复检查失败：${err?.message ?? err}`);
    });
  }

  vscode.window.showInformationMessage('Saros Pocket 已激活：手机扫码即可远程访问 VsSaros（命令面板搜 "Saros Pocket"）');
  return { showPanel: () => showPanel(context) };
}

async function deactivate() {
  if (screen) { try { screen.dispose(); } catch { /* 忽略 */ } screen = null; }
  if (service) { await service.dispose(); service = null; }
  if (bridge) { try { bridge.dispose(); } catch { /* 忽略 */ } bridge = null; }
}

export { activate, deactivate };
