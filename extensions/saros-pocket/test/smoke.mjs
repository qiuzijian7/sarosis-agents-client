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
import { createPocketProxy } from '../lib/proxy.mjs';

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

// ── 品牌资源（与 VsSaros 同款 logo）：App 内的 svg 必须可被代理静态托管 ──────────
check('App 头部引用品牌 logo', html.includes('saros-logo.svg') && html.includes('apple-touch-icon.png'));
const logoRes = await fetch(`${base}/pocket/saros-logo.svg`);
check('GET /pocket/saros-logo.svg', logoRes.status === 200
  && (logoRes.headers.get('content-type') ?? '').includes('svg')
  && (await logoRes.text()).includes('<svg'));
const touchRes = await fetch(`${base}/pocket/apple-touch-icon.png`);
check('GET /pocket/apple-touch-icon.png', touchRes.status === 200
  && (touchRes.headers.get('content-type') ?? '').includes('image/png'));
check('品牌资源之外仍拒绝（白名单未放宽）', (await fetch(`${base}/pocket/extension.js`)).status === 404);

// ── 上游不可达（桌面版下 / 入口必然 502）：浏览器导航给可读页面，非导航保持单行文本 ──
// 真实代理 + 一个必然没人监听的端口，验证的正是用户撞到的那条路径。
const deadUpstream = await createPocketProxy({
  port: 0, upstream: { host: '127.0.0.1', port: 65001 }, appPrefix: '/pocket/', log: null,
});
const html502 = await fetch(`http://127.0.0.1:${deadUpstream.port}/`, { headers: { accept: 'text/html' } });
const html502Body = await html502.text();
check('上游不可达：浏览器导航拿到可读页面（非裸 ECONNREFUSED）',
  html502.status === 502 && html502Body.includes('同屏 web') && html502Body.includes('/pocket/'));
const text502 = await fetch(`http://127.0.0.1:${deadUpstream.port}/api/x`);
check('上游不可达：非 HTML 客户端仍是单行文本（便于自动化）',
  text502.status === 502 && (await text502.text()).includes('无法连接上游 VsSaros'));
await deadUpstream.close();

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
// 根路径二维码（同屏 web 入口）已废弃：桌面版扫了必然打不开，不该再有消费方 / 数据源
check('status 不再产出根路径二维码（lanQr 已废弃）', st.lanQr === undefined);
check('status 保留根路径地址（同屏 web 入口的状态与链接要用）', st.lanUrl === `http://192.168.1.9:${st.proxyPort}`);
check('公网未开时不给 App 公网地址', st.tunnelAppUrl === null && st.tunnelAppQr === null);
await svc.dispose();
const noPrefix = await createPocketService({ upstreamPort: 8000, port: 0, state: fakeState, log: silentLog }).status();
check('未配 appPrefix 时不伪造 App 地址', noPrefix.lanAppUrl === null && noPrefix.lanAppQr === null);

// 收件箱 UI 结构断言：页签/视图/筛选器/列表容器必须齐备，否则 app.js 会静默降级
check('四个页签存在', ['inbox', 'chat', 'changes', 'status'].every((v) =>
  html.includes(`data-view="${v}"`)));
// 改名：收件箱 → 会话列表（只看**用户可见文案**：注释里保留旧名是刻意的历史说明）
// 内部 data-view="inbox" 保持不变 ⇒ 深链 #inbox 与既有脚本仍可用
const visibleHtml = html.replace(/<!--[\s\S]*?-->/g, '');
check('会话列表文案已就位，用户可见处不再出现「收件箱」',
  visibleHtml.includes('会话列表') && !visibleHtml.includes('收件箱'),
  `侧轨/底部页签都应显示「会话列表」`);
check('会话列表有「已归档」芯片（默认隐藏，按 archivedCount 显示）',
  /data-status="archived"[^>]*>已归档/.test(html) && /class="chip hidden"[^>]*data-status="archived"/.test(html));
check('会话列表有会话桥诊断位（列表空时能说清成因）', html.includes('id="sessionDiag"'));
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

// 全量同步：请求要带上更高上限与归档开关，否则会话多的仓库会被静默截断
check('会话列表按「全量 + 归档开关」取数',
  appJs.includes("state.sessionFilter === 'archived'") && appJs.includes('{ archived: true, limit: 200 }')
  && appJs.includes('limit: 200'));
check('归档视图：无归档会话时自动退回「全部」，不留空入口',
  appJs.includes('function renderArchivedChip') && appJs.includes("state.sessionFilter = 'all'"));
check('会话卡片显示归档标记，且不再给已归档会话「结束」按钮',
  appJs.includes("(s.archived ? '已归档 · ' : '')") && /s\.archived \? '' : '<button class="ghost small session-archive"/.test(appJs));
check('会话卡片带状态徽标与来源类型（真实会话混排时能分辨）',
  appJs.includes('statusLabel(s.status)') && appJs.includes("'（' + s.sessionType + '）'"));

// 聊天框头部（与 VsSaros 聊天框同构）：模式 + Agent + 工作区 + Worktree + 模型
check('当前会话页有聊天头（Agent / 工作区 / Worktree / 模式 / 模型）',
  ['chatContextBar', 'chatAgent', 'chatWorkspace', 'chatWorktree', 'chatModes', 'chatCtxHint']
    .every((id) => html.includes(`id="${id}"`)) && html.includes('id="modelSelect"'));
const appCssText = await (await fetch(`${base}/pocket/app.css`)).text();
check('聊天头样式就位（两行两列 + 模式芯片）',
  appCssText.includes('.chat-modes') && appCssText.includes('.chat-mode.active') && appCssText.includes('.chat-ctx-field'));
check('聊天上下文：读 + 改选写回 + 随消息下发',
  appJs.includes("rpc('chat.context', {})") && appJs.includes("rpc('chat.context.set'")
  && appJs.includes('context: chatContextPayload()'));
check('聊天上下文降级（老版本 VsSaros）：给提示 + 原因，而不是空下拉',
  appJs.includes('ctx.degraded === true') && appJs.includes('没读到 VsSaros 的工作区/Agent 列表')
  && appJs.includes("(c.error || '会话桥不可用')"), '降级提示必须带上原因，否则排查无从下手');
check('聊天模式：只信 VsSaros 给的 id，标签按 id 映射（未知 id 兜底显示 id）',
  appJs.includes('function mergeChatModeLabels') && appJs.includes('known && known.label')
  && appJs.includes('label: (m && m.label) || (known && known.label) || id'));
check('模式三档与桌面端一致，且默认 craft',
  appJs.includes("id: 'craft'") && appJs.includes("id: 'ask'") && appJs.includes("id: 'plan'")
  && /chatMode: 'craft'/.test(appJs));
check('变更页支持展开单文件 diff', appJs.includes('toggleDiff') && appJs.includes('{ path: path }'));
check('变更页可一键在编辑器打开', appJs.includes('openChangeInEditor')
  && appJs.includes("rpc('editor.open'"));
check('变更页样式已就位', (await (await fetch(`${base}/pocket/app.css`)).text()).includes('.change-badge'));

// ── 屏幕画面「铺满」（用户报：全屏后画面只占中间一小块）──────────────────────
// 根因：`object-fit` 只在「盒子尺寸 ≠ 图片自身尺寸」时才生效。旧样式只写 max-width/max-height +
// object-fit:contain ⇒ 盒子 = 帧的像素尺寸（帧宽 = 观看端宽度 × 质量系数），桌面浏览器下正好半宽。
const appCss = await (await fetch(`${base}/pocket/app.css`)).text();
check('全屏样式给了画面尺寸兜底（不能只靠 object-fit）',
  /\.screen-wrap\.pseudo-fullscreen img[\s\S]{0,240}width:\s*100%/.test(appCss)
  && /\.screen-wrap:fullscreen img[\s\S]{0,120}width:\s*100%/.test(appCss));
check('app.js 按可用区域算画面尺寸（fitScreenImage）',
  appJs.includes('function fitScreenImage')
  && appJs.includes('img.style.width = w + \'px\'')
  && appJs.includes('Math.min(availW / nw, availH / nh)'), '要按 contain 计算，保持比例');
check('画面尺寸在首帧 / 窗口变化 / 全屏切换时都会重算',
  appJs.includes("addEventListener('load', fitScreenImage)")
  && appJs.includes("addEventListener('resize', fitScreenImage)")
  && /function onFullscreenChange\(\)[\s\S]{0,200}fitScreenImage/.test(appJs));
check('点击坐标按「画面实际占的内容区」算（letterbox 下才不点偏）',
  /function screenPoint\(ev\)[\s\S]{0,700}naturalWidth/.test(appJs)
  && /left = r\.left \+ \(r\.width - w\) \/ 2/.test(appJs));
check('清晰度下拉说明的是传输分辨率/流量，不再暗示显示大小',
  /<select id="screenScale"[^>]*>/.test(html) && html.includes('省流量') && html.includes('原尺寸（最清晰'),
  '画面恒定铺满 ⇒ 这一档只决定清晰度与带宽');

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
