// lib/service.mjs 的单元测试：代理端口占用重试、令牌按 Host 选取、二维码缓存。
//
// 真实代理要绑 0.0.0.0、真实隧道要 cloudflared，都不适合测试。
// 这里通过 deps 注入假代理：既能造出 EADDRINUSE 验证重试，又完全不碰网络。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPocketService, qrDataUrl } from '../lib/service.mjs';
import { createStateStore } from '../lib/state.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function withService(extra, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'saros-pocket-svc-'));
  const state = createStateStore(dir);
  const service = createPocketService({
    upstreamPort: 8000,
    port: 3081,
    storageDir: dir,
    state,
    log: { info() { }, warn() { }, error() { }, appendLine() { } },
    ...extra,
  });
  return Promise.resolve(fn(service, state)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

/** 造一个「前 busyCount 次抛 EADDRINUSE，之后成功」的假代理。 */
function flakyProxy(busyCount, attempts) {
  return async ({ port }) => {
    attempts.push(port);
    if (attempts.length <= busyCount) {
      const err = new Error('EADDRINUSE');
      err.code = 'EADDRINUSE';
      throw err;
    }
    return { port, close: async () => { } };
  };
}

// ---------- 端口重试 ----------

test('端口重试：首选端口可用时不重试', async () => {
  const attempts = [];
  await withService({ deps: { createProxy: flakyProxy(0, attempts) } }, async (service) => {
    const proxy = await service.startProxy();
    assert.equal(proxy.port, 3081);
    assert.deepEqual(attempts, [3081], '首端口可用时只应尝试一次');
  });
});

test('端口重试：被占用时顺延到下一个端口', async () => {
  const attempts = [];
  await withService({ deps: { createProxy: flakyProxy(2, attempts) } }, async (service) => {
    const proxy = await service.startProxy();
    assert.equal(proxy.port, 3083);
    assert.deepEqual(attempts, [3081, 3082, 3083]);
  });
});

test('端口重试：上限 10 次，超出后抛出最后一次错误', async () => {
  const attempts = [];
  await withService({ deps: { createProxy: flakyProxy(999, attempts) } }, async (service) => {
    await assert.rejects(() => service.startProxy(), /EADDRINUSE/);
    assert.equal(attempts.length, 10, '最多尝试 10 个端口');
    assert.deepEqual(attempts[0], 3081);
    assert.deepEqual(attempts.at(-1), 3090);
  });
});

test('端口重试：非 EADDRINUSE 错误直接抛出不重试', async () => {
  const attempts = [];
  const boom = async ({ port }) => {
    attempts.push(port);
    throw new Error('权限不足');
  };
  await withService({ deps: { createProxy: boom } }, async (service) => {
    await assert.rejects(() => service.startProxy(), /权限不足/);
    assert.equal(attempts.length, 1, '非端口占用错误不应重试');
  });
});

test('startProxy 幂等：重复调用返回同一实例', async () => {
  const attempts = [];
  await withService({ deps: { createProxy: flakyProxy(0, attempts) } }, async (service) => {
    const a = await service.startProxy();
    const b = await service.startProxy();
    assert.equal(a, b, '不应重复创建代理');
    assert.equal(attempts.length, 1);
  });
});

// ---------- 日志适配（历史 bug：只吃 console 形状 ⇒ 遇 OutputChannel 崩） ----------
//
// 背景：扩展传进来的是 VS Code **OutputChannel**（只有 appendLine），而 service 里曾写
// `(log.info ?? log.log).call(log, ...)` ⇒ 两个属性都不存在 ⇒ `undefined.call` ⇒
// TypeError: Cannot read properties of undefined (reading 'call')。
// 触发点是 activate 必经的 restoreTunnelIfNeeded ⇒ 扩展激活时抛 unhandled rejection。
// 之所以长期没被测试抓住：原来的 withService 给的是「两种形状都有」的 logger ✗。

test('日志：logger 只有 appendLine（OutputChannel 形状）时不抛 —— 历史 bug 回归', async () => {
  const lines = [];
  const dir = mkdtempSync(join(tmpdir(), 'saros-pocket-log-'));
  try {
    const state = createStateStore(dir);
    const service = createPocketService({
      upstreamPort: 8000,
      port: 3081,
      storageDir: dir,
      state,
      log: { appendLine: (m) => lines.push(String(m)) },   // ★ 没有 info / warn / log
      deps: { createProxy: flakyProxy(0, []) },
    });
    await service.restoreTunnelIfNeeded();   // 激活路径上必经的一步
    assert.ok(
      lines.some((l) => l.includes('自动恢复检查')),
      `应写入日志，实际：${JSON.stringify(lines)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('日志：logger 只有 console 形状（无 appendLine）时也能打，且 %s 会被替换', async () => {
  const infos = [];
  const warns = [];
  const dir = mkdtempSync(join(tmpdir(), 'saros-pocket-log2-'));
  try {
    const state = createStateStore(dir);
    // 造「上次开过隧道」的标记 ⇒ restoreTunnelIfNeeded 走到 startTunnel ⇒ 失败 ⇒ logWarn('%s')
    mkdirSync(join(dir, 'saros-pocket'), { recursive: true });
    writeFileSync(join(dir, 'saros-pocket', 'tunnel-auto.json'), JSON.stringify({ at: Date.now() }));
    const service = createPocketService({
      upstreamPort: 8000,
      port: 3081,
      storageDir: dir,
      state,
      log: { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)) },
      deps: {
        createProxy: flakyProxy(0, []),
        startQuickTunnel: async () => { throw new Error('cloudflared 不见了'); },
      },
    });
    await service.restoreTunnelIfNeeded();
    assert.ok(infos.some((l) => l.includes('自动恢复检查')), 'info 通道应收到日志');
    const warn = warns.join('\n');
    assert.ok(warn.includes('隧道自动恢复失败'), `应打 warn，实际：${warn}`);
    assert.ok(warn.includes('cloudflared 不见了'), `%s 应被替换成错误文本，实际：${warn}`);
    assert.ok(!warn.includes('%s'), '%s 不应原样残留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('日志：logger 空对象（没有任何方法）也不影响主流程', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saros-pocket-log3-'));
  try {
    const state = createStateStore(dir);
    const service = createPocketService({
      upstreamPort: 8000,
      port: 3081,
      storageDir: dir,
      state,
      log: {},                                 // 既无 appendLine 也无 info/warn/log ⇒ 走 console 兜底
      deps: { createProxy: flakyProxy(0, []) },
    });
    await service.restoreTunnelIfNeeded();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 令牌按 Host 选取（安全默认）----------

test('代理创建时传入的 auth 配置符合安全默认', async () => {
  let capturedAuth = null;
  const spy = async (opts) => {
    capturedAuth = opts.auth;
    return { port: opts.port, close: async () => { } };
  };
  await withService({ deps: { createProxy: spy } }, async (service) => {
    await service.startProxy();
    assert.ok(capturedAuth, '应传入 auth 配置');
    assert.equal(capturedAuth.isProtected('abc.trycloudflare.com'), true, '公网必须强制鉴权');
    assert.ok(capturedAuth.sessionKey, '应有 sessionKey（进程级随机）');
  });
});

test('登录页品牌：brandHtml 透传到代理（「与 VsSaros 同款 logo」的注入链路）', async () => {
  let captured = null;
  const spy = async (opts) => {
    captured = opts;
    return { port: opts.port, close: async () => { } };
  };
  const brand = '<img src="data:image/svg+xml;base64,AAA" alt="VsSaros">';
  await withService({ brandHtml: brand, deps: { createProxy: spy } }, async (service) => {
    await service.startProxy();
    assert.ok(captured, '应调用 createProxy');
    assert.equal(captured.brandHtml, brand, '品牌 HTML 必须传到代理，否则登录页没有 logo');
  });
});

test('登录页品牌：未配置时传空串（登录页退回纯文字标题）', async () => {
  let captured = null;
  const spy = async (opts) => {
    captured = opts;
    return { port: opts.port, close: async () => { } };
  };
  await withService({ deps: { createProxy: spy } }, async (service) => {
    await service.startProxy();
    assert.equal(captured.brandHtml, '', '缺省应为空串（不是 undefined，便于代理侧判断）');
  });
});

test('局域网自检：本机连不上时判为选错网卡，并透出到 status.lanCheck', async () => {
  await withService({ deps: { probeHttp: async () => ({ ok: false, error: 'ECONNREFUSED' }) } }, async (service, state) => {
    state.setLanIpOverride('10.97.5.32');
    await service.startProxy();
    const before = (await service.status()).lanCheck;
    assert.equal(before.ok, null, '没测过就是 null ⇒ 面板显示「未检测」，不谎报');
    const c = await service.checkLanReachability();
    assert.equal(c.ok, false);
    assert.equal(c.ip, '10.97.5.32', '要测的是当前生效的地址（含手动覆盖）');
    assert.ok(c.url.endsWith('/pocket/'), `自检打的是 App 入口：${c.url}`);
    assert.match(c.detail, /VPN|虚拟网卡/, '要提示最可能的原因，用户才知道怎么办');
    assert.equal((await service.status()).lanCheck.ok, false, 'status 要带上自检结果（面板据此渲染）');
  });
});

test('局域网自检：本机可连时如实说明「只证明代理绑在该地址上」', async () => {
  await withService({ deps: { probeHttp: async () => ({ ok: true, status: 302 }) } }, async (service) => {
    await service.startProxy();
    const c = await service.checkLanReachability();
    assert.equal(c.ok, true);
    assert.equal(c.status, 302, '302（要密码的登录跳转）也算可达');
    assert.match(c.detail, /代理就绑在这个地址上/, '不能让人误以为「手机一定能连」');
  });
});

test('局域网自检：代理未启动 / 没有地址时给明确说明而不是假结论', async () => {
  await withService({ deps: { probeHttp: async () => { throw new Error('不该被调用'); } } }, async (service) => {
    const c = await service.checkLanReachability();
    assert.equal(c.ok, null);
    assert.match(c.detail, /代理未启动|没检测到局域网地址/);
  });
});

test('status 透出候选网卡明细（ip / 网卡名 / 是否虚拟）供面板换地址', async () => {
  await withService({}, async (service) => {
    const st = await service.status();
    assert.ok(Array.isArray(st.lanInterfaces), 'status 要带 lanInterfaces');
    assert.ok(st.lanInterfaces.every((i) => typeof i.ip === 'string' && typeof i.iface === 'string'), '每项要有 ip 与网卡名');
    assert.ok(st.lanInterfaces.every((i) => typeof i.virtual === 'boolean'), '每项要标出是否虚拟网卡');
    assert.equal(typeof st.lanIpOverride, 'string', '要带上当前覆盖值（面板据此显示「用自动检测」）');
  });
});

test('上游探测：probeUpstream 记录可用性并透出到 status（面板据此提示同屏 web）', async () => {
  let calls = 0;
  await withService({ deps: { probeUpstream: async () => { calls += 1; return false; } } }, async (service) => {
    const before = await service.status();
    assert.equal(before.upstreamOk, null, '未探测前为 null ⇒ 面板显示「检测中…」，而不是谎报不可用');
    const probe = await service.probeUpstream();
    assert.equal(probe.ok, false);
    assert.match(probe.error, /ECONNREFUSED/, '应给出可读原因');
    assert.ok(probe.checkedAt > 0);
    const after = await service.status();
    assert.equal(after.upstreamOk, false);
    assert.equal(calls, 1);
  });
});

test('上游探测：可用时清空错误信息', async () => {
  await withService({ deps: { probeUpstream: async () => true } }, async (service) => {
    await service.probeUpstream();
    const st = await service.status();
    assert.equal(st.upstreamOk, true);
    assert.equal(st.upstreamError, '');
  });
});

test('上游探测：探测本身抛异常时按「不可达」处理，不炸调用方', async () => {
  await withService({ deps: { probeUpstream: async () => { throw new Error('boom'); } } }, async (service) => {
    const probe = await service.probeUpstream();
    assert.equal(probe.ok, false);
  });
});

test('sessionKey 每次启动都是新的（重启后旧 cookie 失效）', async () => {
  const keys = [];
  const spy = async (opts) => { keys.push(opts.auth.sessionKey); return { port: opts.port, close: async () => { } }; };
  const dir = mkdtempSync(join(tmpdir(), 'saros-pocket-key-'));
  try {
    const state = createStateStore(dir);
    for (let i = 0; i < 2; i += 1) {
      const svc = createPocketService({
        upstreamPort: 8000, port: 3081, storageDir: dir, state,
        deps: { createProxy: spy },
        log: { info() { }, warn() { }, error() { }, appendLine() { } },
      });
      await svc.startProxy();
    }
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1], 'sessionKey 应每次随机生成');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 二维码 ----------

test('二维码：生成 data URL（PNG）', async () => {
  const url = await qrDataUrl('http://192.168.1.20:3081');
  assert.ok(url.startsWith('data:image/png;base64,'), `应为 PNG data URL，实际前缀：${url.slice(0, 30)}`);
});

test('二维码：不同文本生成不同图像', async () => {
  const a = await qrDataUrl('http://192.168.1.20:3081');
  const b = await qrDataUrl('http://192.168.1.21:3081');
  assert.notEqual(a, b);
});

test('二维码：宽度参数生效（生成的图像确实不同）', async () => {
  const small = await qrDataUrl('http://192.168.1.20:3081', { width: 120 });
  const large = await qrDataUrl('http://192.168.1.20:3081', { width: 320 });
  assert.notEqual(small, large, '不同宽度应产出不同图像');
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
