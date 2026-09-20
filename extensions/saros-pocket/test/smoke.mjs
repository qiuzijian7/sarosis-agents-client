// Pocket App 通信层冒烟测试：不接入 VsSaros，用最小 vscode 替身跑通
//   App 静态服务 + RPC 通道 + SSE 事件流 + VsSaros 桥接（含安全边界断言）
// 运行：npm test（或 node test/smoke.mjs）

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAppServer } from '../lib/app.mjs';
import { createPocketRpc } from '../lib/rpc.mjs';
import { createEventBus } from '../lib/events.mjs';
import { createVsSarosBridge } from '../lib/bridge.mjs';
import { createPocketService } from '../lib/service.mjs';

const here = dirname(dirname(fileURLToPath(import.meta.url))); // 仓库根目录

class FakeCts {
  token = 'tok';
  cancel() { }
  dispose() { }
}

const vscode = {
  version: '1.99.0',
  env: { appName: 'VsSaros', uiKind: 1, language: 'zh-cn', remoteName: null, shell: 'pwsh' },
  workspace: {
    name: 'smoke',
    workspaceFolders: [{ name: 'smoke', uri: { fsPath: here } }],
    onDidSaveTextDocument: () => ({ dispose() { } }),
    onDidChangeWorkspaceFolders: () => ({ dispose() { } }),
    openTextDocument: async (uri) => ({ languageId: 'markdown', uri }),
  },
  window: {
    activeTextEditor: null,
    terminals: [],
    state: { focused: true },
    onDidChangeActiveTextEditor: () => ({ dispose() { } }),
    onDidChangeWindowState: () => ({ dispose() { } }),
    showTextDocument: async () => ({ }),
    showInformationMessage: async () => undefined,
  },
  commands: { executeCommand: async (id, ...args) => ({ mock: id, args }) },
  Uri: { file: (p) => ({ fsPath: p }) },
  CancellationTokenSource: FakeCts,
  LanguageModelChatMessage: {
    User: (t) => ({ role: 'user', content: t }),
    Assistant: (t) => ({ role: 'assistant', content: t }),
  },
  lm: {
    selectChatModels: async () => [{
      id: 'mock/model-1',
      name: 'Mock Model',
      vendor: 'mock',
      family: 'mock',
      sendRequest: async () => ({ stream: (async function* () { yield '你好，'; yield '这里是 VsSaros。'; })() }),
    }],
  },
};

const events = createEventBus();
const bridge = createVsSarosBridge({
  vscode,
  context: { extension: { packageJSON: { version: '0.1.0' } } },
  events,
  statusProvider: async () => ({
    proxyRunning: true, proxyPort: 3081, upstreamPort: 8000,
    lanUrl: 'http://192.168.1.9:3081', tunnelUrl: null, tunnelState: { phase: 'idle' },
  }),
  getConfig: () => ({}),
});
const rpc = createPocketRpc({ endpoints: bridge.endpoints, events });
const app = createAppServer({
  appDir: join(here, 'app'),
  boot: { rpcPrefix: '/saros-pocket/rpc/', eventsPath: '/saros-pocket/events', version: '0.1.0' },
});

const routes = [app, rpc];
const server = createServer((req, res) => {
  const pathname = String(req.url ?? '/').split(/[?#]/, 1)[0];
  const route = routes.find((r) => pathname.startsWith(r.prefix));
  if (!route) { res.writeHead(404); res.end('not found'); return; }
  Promise.resolve(route.handle(req, res)).catch((err) => { res.writeHead(500); res.end(String(err)); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
const call = async (endpoint, payload) => {
  const res = await fetch(`${base}/saros-pocket/rpc/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload }),
  });
  return { status: res.status, body: await res.json() };
};

const html = await (await fetch(`${base}/pocket/`)).text();
check('GET /pocket/ 返回 App（含启动参数）', html.includes('Saros Pocket') && html.includes('window.__POCKET__'));
check('GET /pocket/app.js', (await fetch(`${base}/pocket/app.js`)).status === 200);
check('目录穿越被拒', (await fetch(`${base}/pocket/../extension.js`)).status === 404);

// ── App 入口地址/二维码：手机扫码直进 App（而不是 VsSaros web 首页）──────────
// lanIpOverride 固定 ⇒ 不必依赖真实网卡探测，断言可复现。
const fakeState = {
  lanEnabled: () => true,
  lanAuthEnabled: () => true,
  getLanToken: () => '12345678',
  getAccessToken: () => '87654321',
  lanIpOverride: () => '192.168.1.9',
  isLanOverrideHost: () => false,
  tokenForHost: () => '12345678',
};
const silentLog = { appendLine() { } };
const svc = createPocketService({ upstreamPort: 8000, port: 0, state: fakeState, appPrefix: '/pocket/', log: silentLog });
await svc.startProxy();
const st = await svc.status();
check('status 给出 App 局域网地址', st.lanUrl === `http://192.168.1.9:${st.proxyPort}` && st.lanAppUrl === `${st.lanUrl}/pocket/`);
check('status 给出 App 局域网二维码', typeof st.lanAppQr === 'string' && st.lanAppQr.startsWith('data:image/png'));
check('公网未开时不给 App 公网地址', st.tunnelAppUrl === null && st.tunnelAppQr === null);
await svc.dispose();
const noPrefix = await createPocketService({ upstreamPort: 8000, port: 0, state: fakeState, log: silentLog }).status();
check('未配 appPrefix 时不伪造 App 地址', noPrefix.lanAppUrl === null && noPrefix.lanAppQr === null);

// 收件箱 UI 结构断言：页签/视图/筛选器/列表容器必须齐备，否则 app.js 会静默降级
check('四个页签存在', ['inbox', 'chat', 'changes', 'status'].every((v) =>
  html.includes(`data-view="${v}"`)));
check('收件箱视图与容器齐备', ['view-inbox', 'sessionChips', 'sessionList', 'reloadSessions']
  .every((id) => html.includes(`id="${id}"`)));
check('收件箱筛选器含状态芯片', ['all', 'running', 'waiting', 'done', 'failed']
  .every((s) => html.includes(`data-status="${s}"`)));
check('变更视图存在', html.includes('id="view-changes"') && html.includes('id="changes"'));
// 「文件」降级为收件箱内的次级入口：保留视图与页签，但不在底部可见导航里
check('文件页签保留但隐藏', html.includes('data-view="files"') && html.includes('tab-hidden'));

const appJs = await (await fetch(`${base}/pocket/app.js`)).text();
check('app.js 订阅会话事件', appJs.includes('session.start') && appJs.includes('session.update'));
// 变更页接线：必须走 files.diff，且支持按文件展开（含 path 参数）
check('app.js 驱动变更页', appJs.includes("rpc('files.diff'"));
check('变更页支持展开单文件 diff', appJs.includes('toggleDiff') && appJs.includes('{ path: path }'));
check('变更页可一键在编辑器打开', appJs.includes('openChangeInEditor')
  && appJs.includes("rpc('editor.open'"));
check('变更页样式已就位', (await (await fetch(`${base}/pocket/app.css`)).text()).includes('.change-badge'));

const info = await call('vsaros.info', {});
check('vsaros.info', info.body.ok && info.body.value.appName === 'VsSaros');
const models = await call('chat.models', {});
check('chat.models', models.body.ok && models.body.value.length === 1);
const chat = await call('chat.send', { runId: 'r1', text: '你好' });
check('chat.send 流式聚合', chat.body.ok && chat.body.value.text === '你好，这里是 VsSaros。');
const list = await call('files.list', { path: '.' });
check('files.list', list.body.ok && list.body.value.entries.some((e) => e.name === 'app'));
const escape = await call('files.list', { path: '../../..' });
check('越界路径被拒', escape.body.ok === false);
const read = await call('files.read', { path: 'app/app.css' });
check('files.read', read.body.ok && String(read.body.value.content).includes('--acc'));
const write = await call('files.write', { path: 'x.txt', content: 'hi' });
check('files.write 默认关闭', write.body.ok === false);
const terminal = await call('terminal.send', { text: 'ls' });
check('terminal.send 默认关闭', terminal.body.ok === false);
const cmd = await call('commands.run', { command: 'some.dangerous.command' });
check('命令白名单生效', cmd.body.ok === false);
const cmd2 = await call('commands.run', { command: 'workbench.action.files.save' });
check('白名单命令可执行', cmd2.body.ok);
const agent = await call('agent.send', { text: '帮我重构' });
check('agent.send 下发给 VsSaros', agent.body.ok && agent.body.value.result.completed === true);
check('未知 endpoint 返回 404', (await call('nope.nope', {})).status === 404);
const status = await call('pocket.status', {});
check('pocket.status 合并状态', status.body.ok && status.body.value.pocket.proxyPort === 3081 && status.body.value.features.chat === true);

const sse = await new Promise((resolve, reject) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); reject(new Error('sse timeout')); }, 5000);
  fetch(`${base}/saros-pocket/events`, { signal: ctrl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    setTimeout(() => events.emit('notify', { text: 'hello' }), 200);
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('event: notify')) break;
    }
    clearTimeout(timer);
    ctrl.abort();
    resolve(buf);
  }).catch(reject);
});
check('SSE 推送事件', sse.includes('event: hello') && sse.includes('event: notify'));

console.log(results.join('\n'));
const failed = results.some((r) => r.startsWith('FAIL'));
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
bridge.dispose();
server.close();
process.exit(failed ? 1 : 0);
