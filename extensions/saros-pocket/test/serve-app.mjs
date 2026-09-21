// Pocket App 本地调试服务器（不进 test/run.mjs —— 它是长驻服务，不是断言测试）
//
// 为什么需要它：改 app/*.css / app.js 后，唯一可靠的验证是「用真实浏览器打开」。
// 但真实链路要求 VsSaros 以 server/web 模式跑在 127.0.0.1:8000（要 GUI + 令牌），
// 前端同学/本机没起 VsSaros 时根本打不开 App。
//
// 这里复用真实组件（createPocketProxy + createAppServer + createPocketRpc），
// 只把「上游」和「bridge endpoints」换成 mock —— 于是：
//   · 静态资源、PIN 鉴权、路由分发、SSE 都是真代码，不是仿制品；
//   · 打开 http://127.0.0.1:<port>/pocket/ 就是与线上一致的真实 App。
//
// 用法：node test/serve-app.mjs [--port 3081] [--pin 12345678] [--no-pin] [--no-screen] [--allow-input]
//   --no-screen  不接屏幕采集（屏幕页会显示「不可用」，用于纯前端调试）
//   --allow-input 让 desktop.input 记账（**不会真的操作你的电脑**，只打印）
// 另开一个终端跑 `node test/emit-events.mjs` 可往 SSE 里灌事件，验证实时推送。

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPocketProxy } from '../lib/proxy.mjs';
import { createAppServer } from '../lib/app.mjs';
import { createPocketRpc } from '../lib/rpc.mjs';
import { createEventBus } from '../lib/events.mjs';
import { createScreenSource, backendFor } from '../lib/screen.mjs';
import { createDesktopInput } from '../lib/desktop-input.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'app');

/** 登录页品牌 logo：与 extension.js 用同一份 app/saros-logo.svg（转 data URI 注入）。 */
function brandLogoHtml() {
  try {
    const svg = readFileSync(join(appDir, 'saros-logo.svg'));
    return `<img src="data:image/svg+xml;base64,${svg.toString('base64')}" alt="VsSaros">`;
  } catch {
    return '';
  }
}

// ---------- 命令行参数 ----------
const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const wantPort = Number(flag('port', 3081));
const pinFlag = flag('pin', null);
const noPin = argv.includes('--no-pin');

// ---------- mock 上游（替代 127.0.0.1:8000 的 VsSaros）----------
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-mock-upstream': 'yes' });
    res.end('<html><body>mock upstream (no real VsSaros)</body></html>');
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;

// ---------- mock 数据（字段名严格对齐 lib/bridge.mjs 的真实返回）----------
const now = Date.now();
const MOCK_SESSIONS = [
  { id: 's-1', title: '重构 rpc 层', status: 'running', kind: 'agent', real: true, startedAt: now - 3 * 60_000, updatedAt: now - 20_000, preview: '正在改 lib/rpc.mjs 的错误分支…' },
  { id: 's-2', title: '为什么手机打不开', status: 'waiting', kind: 'agent', real: true, startedAt: now - 25 * 60_000, updatedAt: now - 4 * 60_000, preview: '等待你授权执行 git diff' },
  { id: 's-3', title: '闲聊', status: 'done', kind: 'chat', real: false, startedAt: now - 90 * 60_000, updatedAt: now - 88 * 60_000, preview: '好的，已记录。' },
  { id: 's-4', title: '跑测试', status: 'failed', kind: 'agent', real: true, startedAt: now - 50 * 60_000, updatedAt: now - 49 * 60_000, preview: undefined, error: '命令超时' },
];
const MOCK_CHANGES = {
  source: 'git-api',
  repoRoot: 'G:\\SarosWorkspace\\Saros-agents-pocket',
  files: [
    { path: 'app/app.css', insertions: 132, deletions: 4, status: 'modified' },
    { path: 'app/index.html', insertions: 21, deletions: 0, status: 'modified' },
    { path: 'test/serve-app.mjs', insertions: 240, deletions: 0, status: 'added' },
    { path: 'lib/old-thing.mjs', insertions: 0, deletions: 58, status: 'deleted' },
  ],
};
const MOCK_DIFF_TEXT = `diff --git a/app/app.css b/app/app.css
--- a/app/app.css
+++ b/app/app.css
@@ -310,6 +314,30 @@
+  /* 宽屏下「一整列拉到底」很浪费：把会话/变更列表改成自适应多列网格。 */
+  .sessions, .changes {
+    display: grid; align-content: start;
+    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
+  }
-  /* 已删除的旧规则 */
`;
const MOCK_FILES = {
  root: 'G:\\SarosWorkspace\\Saros-agents-pocket',
  entries: [
    { name: 'app', dir: true, size: null, mtime: now },
    { name: 'lib', dir: true, size: null, mtime: now },
    { name: 'test', dir: true, size: null, mtime: now },
    { name: 'extension.js', dir: false, size: 11552, mtime: now },
    { name: 'package.json', dir: false, size: 5544, mtime: now },
    { name: 'README.md', dir: false, size: 10214, mtime: now },
  ],
  truncated: false,
};

const events = createEventBus();

// ---------- 屏幕采集（真实源；--no-screen 关闭）----------
const allowInput = argv.includes('--allow-input');
const useScreen = !argv.includes('--no-screen') && backendFor() !== null;
const screen = useScreen
  ? createScreenSource({ getConfig: () => ({ fps: 6, quality: 60, scale: 0.5 }), enabled: () => true, log: console })
  : null;
const desktopInput = createDesktopInput({ allowed: () => allowInput, getRect: () => screen?.rect?.() ?? null });

const MOCK_DESKTOP = {
  supported: false,
  platform: process.platform,
  backend: null,
  running: false,
  clients: 0,
  frames: 0,
  lastFrameAt: null,
  lastFrameBytes: null,
  rect: { x: 0, y: 0, width: 1280, height: 800 },
  config: { fps: 4, quality: 55, scale: 0.5, mode: 'window', processName: 'vssaros', monitor: -1 },
  lastError: useScreen ? null : '本调试服务器未接采集源（去掉 --no-screen 或检查平台支持）',
};

function desktopStatus() {
  const base = screen ? screen.status() : MOCK_DESKTOP;
  return {
    ...base,
    inputAllowed: allowInput,
    inputSupported: desktopInput.supported === true,
    streamUrl: '/saros-pocket/screen.mjpeg',
    snapshotUrl: '/saros-pocket/screen.jpg',
  };
}

/** mock bridge：每个 endpoint 的返回形状与 lib/bridge.mjs 一致。 */
const endpoints = {
  'pocket.status': async () => ({
    pocket: { upstreamPort, proxyPort: null, proxyRunning: true, lanUrl: 'http://127.0.0.1:3081', tunnelUrl: null, tunnelState: { phase: 'idle' } },
    vsaros: { appName: 'VsSaros(mock)', version: '0.0.0-mock', workspaceFolders: [{ path: MOCK_FILES.root }], activeEditor: 'app/app.css' },
    features: { chat: true, chatModels: 3, fileWrite: false, terminal: false },
  }),
  'vsaros.info': async () => ({ appName: 'VsSaros(mock)', version: '0.0.0-mock' }),
  'chat.models': async () => [
    { id: 'mock/fast', name: 'Mock Fast', vendor: 'mock', family: 'mock' },
    { id: 'mock/smart', name: 'Mock Smart', vendor: 'mock', family: 'mock' },
  ],
  'chat.send': async ({ text }) => {
    events.emit('chat.delta', { text: `（mock 回复）你说了：${text}` });
    return { text: `（mock 回复）你说了：${text}` };
  },
  'chat.cancel': async () => ({ cancelled: true }),
  'agent.send': async ({ text }) => {
    events.emit('agent.sent', { text });
    return { command: 'workbench.action.chat.open', mode: 'agent', sessionId: 's-1', result: { ok: true } };
  },
  'sessions.list': async ({ status }) => ({
    sessions: status ? MOCK_SESSIONS.filter((s) => s.status === status) : MOCK_SESSIONS,
  }),
  'sessions.get': async ({ id }) => MOCK_SESSIONS.find((s) => s.id === id) ?? null,
  'sessions.send': async ({ id, text }) => {
    events.emit('session.updated', { id, text });
    return { ok: true, id };
  },
  'sessions.archive': async ({ id }) => ({ ok: true, id, archived: true }),
  'sessions.cancel': async ({ id }) => ({ sessionId: id, cancelled: true, status: 'cancelled' }),
  'files.list': async () => MOCK_FILES,
  'files.read': async ({ path }) => ({ path, content: `这是 mock 文件内容：${path}\n\n${MOCK_DIFF_TEXT}` }),
  'files.diff': async ({ path }) => (path ? { source: 'git-api', repoRoot: MOCK_CHANGES.repoRoot, path, diff: MOCK_DIFF_TEXT } : MOCK_CHANGES),
  'files.write': async () => { throw new Error('mock 不允许写文件（真实端受 allowFileWrite 控制）'); },
  'commands.list': async () => ({ commands: ['workbench.action.files.save'] }),
  'commands.run': async () => { throw new Error('mock 不允许执行命令'); },
  'editor.open': async ({ path }) => { events.emit('editor.opened', { path }); return { ok: true, path }; },
  'notify': async ({ message }) => { events.emit('notify', { message }); return { ok: true }; },
  'terminal.send': async () => { throw new Error('mock 不允许操作终端'); },
  'events.recent': async () => events.recent(),
  // 桌面画面：接了真实采集源就报真实状态，否则给一份形状一致的 mock
  'desktop.status': async () => desktopStatus(),
  'desktop.config': async (payload) => {
    if (screen) {
      screen.reconfigure(payload || {});
      return desktopStatus();
    }
    Object.assign(MOCK_DESKTOP.config, payload || {});
    return desktopStatus();
  },
  'desktop.input': async (payload) => {
    // ★ mock 永远不真的操作你的电脑：只记账，且默认直接拒绝
    if (!allowInput) throw new Error('mock 未开启输入（加 --allow-input 也只是记账，不会真操作）');
    console.log('[mock] desktop.input =', JSON.stringify(payload));
    return { ok: true, type: payload?.type ?? null, mock: true };
  },
};

// ---------- 组装：真实代理 + 真实 App 服务 + 真实 RPC ----------
const rpc = createPocketRpc({ endpoints, events, screen, log: console });
const app = createAppServer({ appDir, boot: {}, log: console });

const auth = noPin
  ? null
  : {
    // 空 = 不需要 PIN；给了值就强制校验（与真实行为一致：公网强制、局域网可关）
    getToken: () => (pinFlag ? pinFlag : ''),
    isProtected: () => Boolean(pinFlag),
    sessionKey: 'mock-session-key',
  };

const proxy = await createPocketProxy({
  port: wantPort,
  host: '127.0.0.1',
  upstream: { host: '127.0.0.1', port: upstreamPort },
  auth,
  lanAccessEnabled: () => true,
  log: (m) => console.log(m),
  routes: [app, rpc],
  injectHtml: '<script data-saros-pocket-polyfill="1"></script>',
  // 品牌 logo 与扩展里一致（extension.js 用同一份文件转 data URI 注入登录页）：
  // 调试服务器要对得上线上行为，否则「登录页有没有 logo」这条永远测不到。
  brandHtml: brandLogoHtml(),
});

console.log('');
console.log('  Pocket App 调试服务器已启动（mock 上游 + mock bridge）');
console.log('');
console.log(`  电脑浏览器  →  http://127.0.0.1:${proxy.port}/pocket/`);
console.log(`  手机同局域网 →  http://<你的局域网IP>:${proxy.port}/pocket/`);
console.log('');
console.log(`  PIN 鉴权：${pinFlag ? `开启（PIN=${pinFlag}）` : '关闭（--pin xxxxxxxx 可开启）'}`);
console.log(`  屏幕画面：${screen ? `真实采集（${screen.status().backend}，屏幕页可直接看）` : '未接采集源（--no-screen 或平台不支持）'}`);
console.log(`  远程键鼠：${allowInput ? '记账模式（不会真操作）' : '关闭（--allow-input 也只记账）'}`);
console.log(`  实时事件：另开终端 node test/emit-events.mjs${pinFlag ? ` --pin ${pinFlag}` : ''}`);
console.log('');
console.log('  Ctrl+C 退出');
console.log('');

async function shutdown() {
  try { await proxy.close(); } catch { /* 忽略 */ }
  upstream.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
