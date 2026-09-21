// 往调试服务器的 SSE 事件流里灌事件，验证 App 的实时推送渲染。
//
// 配合 test/serve-app.mjs 使用：它起的服务里挂了 mock bridge，
// 其中 chat.send / agent.send / sessions.send / editor.open / notify
// 都会 emit 事件。本脚本直接调这些 endpoint，事件就会流到已连接的手机上。
//
// 用法：node test/emit-events.mjs [--port 3099] [--pin 39275184] [--loop]
//   --pin   调试服务器开了 PIN 鉴权时必给（脚本会先登录拿 cookie）；
//           serve-app 用 --no-pin 起的话可以省略
//   --loop  每 3 秒发一条，方便观察持续推送（Ctrl+C 退出）

const argv = process.argv.slice(2);
const port = Number((() => {
  const i = argv.indexOf('--port');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 3099;
})());
const pin = (() => {
  const i = argv.indexOf('--pin');
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : '';
})();
const loop = argv.includes('--loop');

const BASE = `http://127.0.0.1:${port}`;

/** 带 PIN 时先登录拿会话 cookie —— 否则 RPC 会被代理拦成 401（鉴权在路由之前）。 */
let cookie = '';
async function login() {
  if (!pin) return;
  const res = await fetch(`${BASE}/pocket-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: pin }),
    redirect: 'manual',
  });
  const jar = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  cookie = jar.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) {
    console.error(`登录失败（HTTP ${res.status}）：PIN 不对？`);
    process.exit(1);
  }
  console.log('已登录（拿到会话 cookie），可以开始灌事件');
}

async function rpc(endpoint, payload) {
  const res = await fetch(`${BASE}/saros-pocket/rpc/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ payload: payload || {} }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return body;
}

const CASES = [
  ['chat.send', { text: '这是一条测试消息' }],
  ['agent.send', { text: '帮我看下 test 目录' }],
  ['sessions.send', { id: 's-1', text: '继续' }],
  ['editor.open', { path: 'app/app.css' }],
  ['notify', { message: '来自 emit-events 的通知' }],
];

let n = 0;
async function emitOnce() {
  const [endpoint, payload] = CASES[n % CASES.length];
  n += 1;
  try {
    await rpc(endpoint, payload);
    console.log(`已触发 ${endpoint} → 检查手机上的事件流`);
  } catch (err) {
    console.error(`触发 ${endpoint} 失败：${err.message}`);
    if (err.message.includes('401')) {
      console.error('  服务开着 PIN 鉴权 ⇒ 请加 --pin <8 位密码> 再跑一次。');
    }
    console.error(`  调试服务器起了吗？先跑：node test/serve-app.mjs --port ${port}`);
    process.exit(1);
  }
}

await login();

if (loop) {
  console.log(`每 3 秒往 ${BASE} 灌一条事件，Ctrl+C 退出`);
  await emitOnce();
  setInterval(emitOnce, 3000);
} else {
  for (const [endpoint] of CASES) await emitOnce();
  console.log('已把全部 5 类事件各触发一次。');
}
