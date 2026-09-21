// lib/proxy.mjs 的端到端测试：起真实代理 + mock 上游，验证改头转发 / PIN 鉴权 / 限速 / 令牌注入。
//
// 为什么需要 mock 上游：真实 VsSaros 起不来（要 GUI + 令牌），而这些行为恰恰是
// 「上游只看 Host/Origin 认不认」的核心。用一个记录请求头的 mock 上游，
// 就能断言「手机侧的 Host 是否已被改写成 127.0.0.1:8000」。

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPocketProxy } from '../lib/proxy.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/** 起一个 mock 上游，记录收到的请求头，返回固定内容。 */
async function startUpstream() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        url: req.url,
        method: req.method,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-upstream': 'yes' });
      res.end('<html><body>upstream</body></html>');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, port, seen, close: () => new Promise((r) => server.close(r)) };
}

/**
 * 起一个 Pocket 代理，返回基址与关闭函数。
 * 注意：createPocketProxy 是异步的 —— 它内部自己 listen 并在就绪后 resolve
 * { server, port, close }，调用方不能再手动 listen。
 */
async function startProxy(upstreamPort, opts = {}) {
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstreamPort },
    auth: opts.auth ?? null,
    rateLimit: opts.rateLimit ?? null,
    launchToken: opts.launchToken ?? (() => ''),
    lanAccessEnabled: opts.lanAccessEnabled ?? (() => true),
    log: () => { },
    injectHtml: '<script data-saros-pocket-polyfill="1"></script>',
  });
  return {
    base: `http://127.0.0.1:${proxy.port}`,
    close: () => proxy.close(),
  };
}

/** 带自定义 Host 头发请求。 */
function requestWithHost(base, host, path = '/', extraHeaders = {}) {
  return fetch(`${base}${path}`, { headers: { host, ...extraHeaders }, redirect: 'manual' });
}

// ---------- 改头转发（核心）----------

test('改头转发：上游收到的 Host 被改写成 loopback 权威', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port);
  try {
    await requestWithHost(proxy.base, '192.168.1.50:3081', '/');
    const req = upstream.seen.at(-1);
    assert.equal(req.headers.host, '127.0.0.1:' + upstream.port, 'Host 必须改写成上游 loopback 权威');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('改头转发：Origin 与 Referer 一并改写，Sec-Fetch-Site 归一为 same-origin', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port);
  try {
    await requestWithHost(proxy.base, '192.168.1.50:3081', '/', {
      origin: 'http://192.168.1.50:3081',
      referer: 'http://192.168.1.50:3081/foo',
      'sec-fetch-site': 'cross-site',
    });
    const req = upstream.seen.at(-1);
    assert.equal(req.headers.origin, `http://127.0.0.1:${upstream.port}`, 'Origin 必须改写');
    assert.ok(String(req.headers.referer ?? '').startsWith(`http://127.0.0.1:${upstream.port}`), 'Referer 必须改写');
    // 上游是 loopback 权威，只有 same-origin 才会被信任栅栏放行
    assert.equal(req.headers['sec-fetch-site'], 'same-origin', 'Sec-Fetch-Site 应归一为 same-origin');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('改头转发：未知域名（公网 Host）同样改写', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port);
  try {
    await requestWithHost(proxy.base, 'abc.trycloudflare.com', '/');
    assert.equal(upstream.seen.at(-1).headers.host, '127.0.0.1:' + upstream.port);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('改头转发：请求体原样透传', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port);
  try {
    await fetch(`${proxy.base}/api`, {
      method: 'POST',
      headers: { host: '192.168.1.50:3081', 'content-type': 'application/json' },
      body: '{"hello":"world"}',
    });
    assert.equal(upstream.seen.at(-1).body, '{"hello":"world"}');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------- 令牌注入 ----------

test('令牌注入：根路径首次访问自动带 ?tkn=', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, { launchToken: () => 'SECRET-TOKEN' });
  try {
    await requestWithHost(proxy.base, '192.168.1.50:3081', '/');
    const req = upstream.seen.at(-1);
    assert.ok(req.url.includes('tkn=SECRET-TOKEN'), `上游应收到 tkn，实际：${req.url}`);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('令牌注入：已有 vscode-tkn cookie 时不重复注入（防 303 循环）', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, { launchToken: () => 'SECRET-TOKEN' });
  try {
    await requestWithHost(proxy.base, '192.168.1.50:3081', '/', {
      cookie: 'vscode-tkn=already-have-it',
    });
    const req = upstream.seen.at(-1);
    assert.ok(!req.url.includes('tkn='), `已有 cookie 时不应再注入，实际：${req.url}`);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('令牌注入：launchToken 为空时不注入', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, { launchToken: () => '' });
  try {
    await requestWithHost(proxy.base, '192.168.1.50:3081', '/');
    assert.ok(!upstream.seen.at(-1).url.includes('tkn='));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('令牌注入：令牌不出现在返回给客户端的 HTML 里（防泄漏）', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, { launchToken: () => 'SECRET-TOKEN' });
  try {
    const res = await requestWithHost(proxy.base, '192.168.1.50:3081', '/');
    const text = await res.text();
    assert.ok(!text.includes('SECRET-TOKEN'), '令牌绝不能回显到客户端页面');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------- PIN 鉴权 ----------

/** 起一个带 PIN 的代理。isProtected：公网与局域网都要密码。 */
async function startProtectedProxy(upstreamPort, pin, opts = {}) {
  return startProxy(upstreamPort, {
    auth: {
      getToken: () => pin,
      isProtected: () => true,
      sessionKey: opts.sessionKey ?? 'test-session-key',
    },
    rateLimit: opts.rateLimit ?? null,
  });
}

test('PIN 鉴权：无凭证时返回登录页而不是上游内容', async () => {
  const upstream = await startUpstream();
  const proxy = await startProtectedProxy(upstream.port, '12345678');
  try {
    const res = await requestWithHost(proxy.base, '192.168.1.50:3081', '/');
    const text = await res.text();
    assert.ok(text.includes('Saros Pocket'), '应返回登录页');
    assert.ok(!text.includes('upstream'), '不得回显上游内容');
    assert.equal(upstream.seen.length, 0, '鉴权未通过时不得打到上游');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('PIN 鉴权：?token= 正确时放行', async () => {
  const upstream = await startUpstream();
  const proxy = await startProtectedProxy(upstream.port, '12345678');
  try {
    const res = await requestWithHost(proxy.base, '192.168.1.50:3081', '/?token=12345678');
    const text = await res.text();
    assert.ok(text.includes('upstream'), '正确 PIN 应放行到上游');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('PIN 鉴权：?token= 错误时拦下', async () => {
  const upstream = await startUpstream();
  const proxy = await startProtectedProxy(upstream.port, '12345678');
  try {
    const res = await requestWithHost(proxy.base, '192.168.1.50:3081', '/?token=wrongpin');
    const text = await res.text();
    assert.ok(!text.includes('upstream'), '错误 PIN 不得放行');
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('PIN 鉴权：登录后种下 HttpOnly cookie', async () => {
  const upstream = await startUpstream();
  const proxy = await startProtectedProxy(upstream.port, '12345678');
  try {
    const res = await fetch(`${proxy.base}/pocket-login`, {
      method: 'POST',
      headers: { host: '192.168.1.50:3081', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=12345678',
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.ok(setCookie.includes('HttpOnly'), `cookie 必须 HttpOnly：${setCookie}`);
    assert.ok(setCookie.includes('SameSite=Lax'), `cookie 应带 SameSite：${setCookie}`);
    assert.equal(res.status, 302, '登录成功应 302 跳回');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('PIN 鉴权：cookie 值不是 PIN 明文（带 sessionKey 时做派生）', async () => {
  const upstream = await startUpstream();
  const proxy = await startProtectedProxy(upstream.port, '12345678', { sessionKey: 'k1' });
  try {
    const res = await fetch(`${proxy.base}/pocket-login`, {
      method: 'POST',
      headers: { host: '192.168.1.50:3081', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=12345678',
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.ok(!setCookie.includes('12345678'), `cookie 不得含 PIN 明文：${setCookie}`);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('PIN 鉴权：sessionKey 变化后旧 cookie 失效', async () => {
  const upstream = await startUpstream();
  const proxyA = await startProtectedProxy(upstream.port, '12345678', { sessionKey: 'key-A' });
  let cookie;
  try {
    const res = await fetch(`${proxyA.base}/pocket-login`, {
      method: 'POST',
      headers: { host: '192.168.1.50:3081', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=12345678',
      redirect: 'manual',
    });
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  } finally {
    await proxyA.close();
  }

  // 换一个 sessionKey 重启（模拟 VsSaros 重启）
  const proxyB = await startProtectedProxy(upstream.port, '12345678', { sessionKey: 'key-B' });
  try {
    const res = await requestWithHost(proxyB.base, '192.168.1.50:3081', '/', { cookie });
    const text = await res.text();
    assert.ok(!text.includes('upstream'), 'sessionKey 变化后旧 cookie 必须失效');
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxyB.close();
    await upstream.close();
  }
});

test('PIN 鉴权：带着失效旧 cookie 用 ?token= 打开时，必须**重发** cookie（否则子资源 401 ⇒ 页面裸奔）', async () => {
  const upstream = await startUpstream();
  const login = (base) => fetch(`${base}/pocket-login`, {
    method: 'POST',
    headers: { host: '192.168.1.50:3081', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=12345678',
    redirect: 'manual',
  });

  // 上一轮 VsSaros（sessionKey=key-OLD）留下的 cookie：浏览器里会存 30 天
  const oldProxy = await startProtectedProxy(upstream.port, '12345678', { sessionKey: 'key-OLD' });
  let stale;
  try {
    stale = ((await login(oldProxy.base)).headers.get('set-cookie') ?? '').split(';')[0];
  } finally {
    await oldProxy.close();
  }
  assert.ok(stale, '前置：要拿到一个旧 cookie');

  // VsSaros 重启（sessionKey=key-NEW）——旧 cookie 失效
  const proxy = await startProtectedProxy(upstream.port, '12345678', { sessionKey: 'key-NEW' });
  try {
    // ① 页面本体靠 ?token= 通过，并且**必须重发 cookie**：旧实现"存在同名 cookie 就跳过"
    //    ⇒ 这个响应不带新 cookie ⇒ 后续 app.css / app.js 带着失效 cookie → 401
    const page = await requestWithHost(proxy.base, '192.168.1.50:3081', '/?token=12345678', { cookie: stale });
    const setCookie = page.headers.get('set-cookie') ?? '';
    assert.ok(setCookie.includes('saros_pocket_token='), `失效旧 cookie 存在时必须重发：${setCookie}`);
    const fresh = setCookie.split(';')[0];
    assert.notEqual(fresh, stale, '重发的不能还是旧值');

    // ② 用失效 cookie 取子资源 → 401（与用户看到的现象一致：样式/脚本都拿不到）
    //    ① 那次是**通过鉴权**的正常转发，所以这里只断言「被拦的这一跳没打到上游」
    const seenAfterPage = upstream.seen.length;
    const cssStale = await requestWithHost(proxy.base, '192.168.1.50:3081', '/pocket/app.css', { cookie: stale });
    assert.equal(cssStale.status, 401, '失效 cookie 必须被拦');
    assert.equal(upstream.seen.length, seenAfterPage, '未通过鉴权不得打到上游');

    // ③ 用新下发的 cookie 取同一子资源 → 通
    const cssFresh = await requestWithHost(proxy.base, '192.168.1.50:3081', '/pocket/app.css', { cookie: fresh });
    assert.notEqual(cssFresh.status, 401, '新 cookie 必须能取到子资源');

    // ④ cookie 已经正确时不再重复下发（避免每个请求都刷 set-cookie）
    const again = await requestWithHost(proxy.base, '192.168.1.50:3081', '/?token=12345678', { cookie: fresh });
    assert.equal(again.headers.get('set-cookie'), null, 'cookie 已正确时不应再刷');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------- 限速 ----------

test('限速：连续失败达到阈值后锁定', async () => {
  const upstream = await startUpstream();
  const proxy = await startProtectedProxy(upstream.port, '12345678', {
    rateLimit: { windowMs: 60_000, maxFailures: 3, lockMs: 60_000, globalMaxFailures: 999, globalLockMs: 1000 },
  });
  try {
    for (let i = 0; i < 3; i += 1) {
      await requestWithHost(proxy.base, '192.168.1.50:3081', '/?token=bad');
    }
    // 第 4 次即使 PIN 正确也应被锁
    const res = await requestWithHost(proxy.base, '192.168.1.50:3081', '/?token=12345678');
    const text = await res.text();
    assert.ok(!text.includes('upstream'), '锁定期间正确 PIN 也不得放行');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('限速：登录成功后清空该 IP 计数', async () => {
  const upstream = await startUpstream();
  const proxy = await startProtectedProxy(upstream.port, '12345678', {
    rateLimit: { windowMs: 60_000, maxFailures: 3, lockMs: 60_000, globalMaxFailures: 999, globalLockMs: 1000 },
  });
  try {
    await requestWithHost(proxy.base, '192.168.1.50:3081', '/?token=bad');
    await requestWithHost(proxy.base, '192.168.1.50:3081', '/?token=bad');
    // 登录成功 → 计数清零
    await fetch(`${proxy.base}/pocket-login`, {
      method: 'POST',
      headers: { host: '192.168.1.50:3081', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=12345678',
      redirect: 'manual',
    });
    // 再失败两次仍未达阈值，应仍能看到登录页而非锁定页
    const res = await requestWithHost(proxy.base, '192.168.1.50:3081', '/?token=bad');
    const text = await res.text();
    assert.ok(!text.includes('尝试次数过多'), '登录成功应重置计数');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------- 局域网开关 ----------

test('局域网关闭：loopback 仍可用（不被开关误伤）', async () => {
  // 注：lan Host 被拒的判定依赖 TCP 源地址（policyHost 会用真实源收紧声明），
  // 而本测试用真实 socket 连 127.0.0.1，源恒为 loopback，无法伪造 lan 源。
  // 该分支由 proxy-host.test.mjs 的 policyHost / classifyHost 单测覆盖。
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, { lanAccessEnabled: () => false });
  try {
    const localRes = await requestWithHost(proxy.base, '127.0.0.1:3081', '/');
    assert.equal(localRes.status, 200, 'loopback 应始终可用');
    assert.equal(upstream.seen.length, 1, 'loopback 请求应正常转发到上游');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------- 执行 ----------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('');
if (failed > 0) {
  console.log(`RESULT: ${failed} / ${tests.length} FAILED`);
  process.exitCode = 1;
} else {
  console.log(`RESULT: ALL PASS (${tests.length}/${tests.length})`);
}
