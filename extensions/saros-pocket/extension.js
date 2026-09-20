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
import { discoverUpstreamPort, discoverConnectionToken } from './lib/host.mjs';
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

/** App / RPC 的可访问地址（本机 loopback 形式）。 */
function appUrl(proxyPort) {
  return `http://127.0.0.1:${proxyPort ?? '3081'}${APP_PREFIX}`;
}

async function buildStatusAndPost() {
  if (!panel || !service) return;
  const s = await service.status();
  panel.webview.postMessage({ command: 'status', status: { ...s, appUrl: appUrl(s.proxyPort) } });
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
  panel.webview.html = html;
  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      switch (msg.command) {
        case 'getStatus': await buildStatusAndPost(); break;
        case 'openApp': await vscode.commands.executeCommand('sarosPocket.openApp'); break;
        case 'openScreen': await vscode.commands.executeCommand('sarosPocket.openScreen'); break;
        case 'toggleLan': {
          const on = state.setLanEnabled(msg.value);
          vscode.window.showInformationMessage(`Saros Pocket · 局域网访问已${on ? '开启' : '关闭'}`);
          await buildStatusAndPost();
          break;
        }
        case 'toggleLanAuth': { state.setLanAuthEnabled(msg.value); await buildStatusAndPost(); break; }
        case 'startTunnel': {
          await service.startTunnel();
          vscode.window.showInformationMessage('Saros Pocket · 公网隧道已开启');
          await buildStatusAndPost();
          break;
        }
        case 'stopTunnel': { service.stopTunnel(); await buildStatusAndPost(); break; }
        case 'refreshLanToken': { state.refreshLanToken(); vscode.window.showInformationMessage('Saros Pocket · 局域网密码已刷新'); await buildStatusAndPost(); break; }
        case 'setTunnelConfig': {
          state.setTunnelMode(msg.mode === 'named' ? 'named' : 'quick');
          if (msg.hostname) state.setTunnelHostname(msg.hostname);
          if (msg.token && msg.token !== '********') state.setTunnelToken(msg.token);
          vscode.window.showInformationMessage('Saros Pocket · 隧道配置已保存');
          await buildStatusAndPost();
          break;
        }
        case 'setLanIpOverride': { const v = state.setLanIpOverride(msg.value ?? ''); vscode.window.showInformationMessage(v ? `Saros Pocket · 局域网地址已设为 ${v}` : 'Saros Pocket · 局域网地址覆盖已清除'); await buildStatusAndPost(); break; }
        case 'setCustomPin': {
          const v = String(msg.value ?? '').trim();
          if (!/^[a-zA-Z0-9]{8}$/.test(v)) { panel.webview.postMessage({ command: 'error', text: '密码必须是 8 位英文字母或数字' }); break; }
          state.setCustomPin(msg.which, v);
          vscode.window.showInformationMessage(`Saros Pocket · ${msg.which === 'public' ? '公网' : '局域网'}密码已设置`);
          await buildStatusAndPost();
          break;
        }
        case 'reset': {
          state.resetPocketState(); service.stopTunnel();
          vscode.window.showInformationMessage('Saros Pocket · 已恢复出厂设置');
          await buildStatusAndPost();
          break;
        }
        default: break;
      }
    } catch (err) {
      panel?.webview.postMessage({ command: 'error', text: err?.message ?? String(err) });
    }
  });
  panel.onDidDispose(() => { panel = null; });
  buildStatusAndPost();
}

let state = null;

async function activate(context) {
  out = vscode.window.createOutputChannel('Saros Pocket');
  const storageDir = context.globalStorageUri.fsPath;
  state = createStateStore(storageDir);

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
        await vscode.env.openExternal(vscode.Uri.parse(appUrl(p)));
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
    vscode.commands.registerCommand('sarosPocket.toggleLan', () => { const on = state.setLanEnabled(!state.lanEnabled()); vscode.window.showInformationMessage(`Saros Pocket · 局域网访问已${on ? '开启' : '关闭'}`); void buildStatusAndPost(); }),
    vscode.commands.registerCommand('sarosPocket.startTunnel', async () => { try { await service.startTunnel(); vscode.window.showInformationMessage('Saros Pocket · 公网隧道已开启'); } catch (e) { vscode.window.showErrorMessage(`Saros Pocket · 隧道启动失败：${e?.message ?? e}`); } void buildStatusAndPost(); }),
    vscode.commands.registerCommand('sarosPocket.stopTunnel', () => { service.stopTunnel(); vscode.window.showInformationMessage('Saros Pocket · 公网隧道已关闭'); void buildStatusAndPost(); }),
    vscode.commands.registerCommand('sarosPocket.reset', async () => { const ok = await vscode.window.showWarningMessage('恢复出厂设置将清空所有开关与密码，确定？', { modal: true }, '确定'); if (ok === '确定') { state.resetPocketState(); service.stopTunnel(); vscode.window.showInformationMessage('Saros Pocket · 已恢复出厂设置'); void buildStatusAndPost(); } }),
  );

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
