// lib/proxy.mjs 的纯函数层测试：Host 信任分类 / 源地址分类 / 策略兜底 / 握手 / 工具函数。
//
// 为什么先测这些：proxy.mjs 有 798 行却零测试，而「改头」是整个扩展的立身之本 ——
// 分类错一次，要么本机免密被局域网蹭到，要么局域网访问被误判成公网强制要密码。
// 这些函数不依赖 HTTP 服务器，可以纯逻辑快测，是补测试性价比最高的一层。

import assert from 'node:assert/strict';
import {
  classifyHost,
  classifySource,
  policyHost,
  clientIp,
  createHandshakeTracker,
  stripQueryParam,
  handshakePageHtml,
  handshakeBlockedPageHtml,
  renderLoginPage,
  safeNextPath,
  upstreamDownPageHtml,
  DEFAULT_HANDSHAKE_LIMIT,
  HANDSHAKE_WINDOW_MS,
} from '../lib/proxy.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------- classifyHost：loopback ----------

test('classifyHost: loopback 家族全部识别', () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.0.1:3081', '::1', '0.0.0.0', '127.5.5.5']) {
    assert.equal(classifyHost(host), 'loopback', `误判：${host}`);
  }
});

test('classifyHost: 带端口的 IPv6 方括号形式', () => {
  assert.equal(classifyHost('[::1]:3081'), 'loopback');
});

test('classifyHost: 大小写与空白不敏感', () => {
  assert.equal(classifyHost('  LOCALHOST:3081  '), 'loopback');
});

// ---------- classifyHost：lan ----------

test('classifyHost: RFC1918 私网识别为 lan', () => {
  for (const host of ['192.168.1.20', '10.0.0.5:3081', '172.16.0.1', '172.31.255.254']) {
    assert.equal(classifyHost(host), 'lan', `误判：${host}`);
  }
});

test('classifyHost: 172.32 / 172.15 不属于私网（边界必须精确）', () => {
  assert.equal(classifyHost('172.32.0.1'), 'public', '172.32 越界，必须判公网');
  assert.equal(classifyHost('172.15.0.1'), 'public', '172.15 越界，必须判公网');
});

test('classifyHost: CGNAT 100.64/10 识别为 lan', () => {
  assert.equal(classifyHost('100.64.0.1'), 'lan');
  assert.equal(classifyHost('100.127.255.255'), 'lan');
  assert.equal(classifyHost('100.128.0.1'), 'public', '100.128 已超出 CGNAT 段');
});

test('classifyHost: IPv6 ULA 与 link-local 识别为 lan', () => {
  assert.equal(classifyHost('fe80::1'), 'lan');
  assert.equal(classifyHost('fd00::abcd'), 'lan');
  assert.equal(classifyHost('fc00::1'), 'lan');
});

test('classifyHost: .local 与无点单标签名识别为 lan', () => {
  assert.equal(classifyHost('my-macbook.local'), 'lan');
  assert.equal(classifyHost('DESKTOP-ABC'), 'lan');
});

// ---------- classifyHost：public（fail closed）----------

test('classifyHost: 隧道域名与陌生域名为 public', () => {
  for (const host of ['abc-def.trycloudflare.com', 'example.com', 'pocket.example.org:3081']) {
    assert.equal(classifyHost(host), 'public', `误判：${host}`);
  }
});

test('classifyHost: 异常输入 fail closed 不崩溃', () => {
  // 空值与 null 走 loopback（保守：至少不会把未知判成外网而放行）
  assert.equal(classifyHost(''), 'loopback');
  assert.equal(classifyHost(null), 'loopback');
  assert.equal(classifyHost(undefined), 'loopback');
});

test('classifyHost: 伪造的 localhost 变体必须判公网', () => {
  // 攻击者可能用 localhost.evil.com / 127.0.0.1.evil.com 之类绕过
  assert.equal(classifyHost('localhost.evil.com'), 'public');
  assert.equal(classifyHost('127.0.0.1.evil.com'), 'public');
});

// ---------- classifySource ----------

test('classifySource: 源地址分类正确', () => {
  assert.equal(classifySource('127.0.0.1'), 'loopback');
  assert.equal(classifySource('::1'), 'loopback');
  assert.equal(classifySource('192.168.1.9'), 'lan');
  assert.equal(classifySource('10.1.1.1'), 'lan');
  assert.equal(classifySource('169.254.1.1'), 'lan', 'link-local 视为 lan');
  assert.equal(classifySource('8.8.8.8'), 'public');
});

test('classifySource: ::ffff: 前缀被剥离', () => {
  assert.equal(classifySource('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifySource('::ffff:192.168.1.9'), 'lan');
});

test('classifySource: 空地址返回 null（不参与策略判定）', () => {
  assert.equal(classifySource(''), null);
  assert.equal(classifySource(null), null);
});

// ---------- policyHost：只收紧不放松 ----------

function fakeReq(remoteAddress) {
  return { socket: { remoteAddress } };
}

test('policyHost: 无源地址时原样返回声明的 Host', () => {
  assert.equal(policyHost(fakeReq(undefined), 'example.com'), 'example.com');
  assert.equal(policyHost(fakeReq(''), 'example.com'), 'example.com');
});

test('policyHost: 隧道场景 —— 源是 loopback 但声明公网域名时保留公网判定', () => {
  // 这是最关键的一条：cloudflared 把公网请求从 127.0.0.1 转进来，
  // 若用源地址覆盖 Host，公网访问会被降级成本机免密。
  assert.equal(policyHost(fakeReq('127.0.0.1'), 'abc.trycloudflare.com'), 'abc.trycloudflare.com');
});

test('policyHost: 源比声明更严格时收紧为源地址（去 ::ffff: 前缀）', () => {
  // 声明 loopback、源却是公网 → 收紧为源的公网地址
  assert.equal(policyHost(fakeReq('8.8.8.8'), 'localhost'), '8.8.8.8');
  assert.equal(policyHost(fakeReq('::ffff:8.8.8.8'), 'localhost'), '8.8.8.8');
});

test('policyHost: 源为 lan、声明 loopback 时收紧为 lan 地址', () => {
  assert.equal(policyHost(fakeReq('192.168.1.9'), 'localhost'), '192.168.1.9');
});

test('policyHost: 源与声明同级时保留声明', () => {
  assert.equal(policyHost(fakeReq('192.168.1.9'), '10.0.0.5'), '10.0.0.5');
});

// ---------- clientIp ----------

test('clientIp: 回退 socket.remoteAddress', () => {
  assert.equal(clientIp(fakeReq('192.168.1.9')), '192.168.1.9');
});

test('clientIp: loopback 源时信任 cf-connecting-ip（隧道真实客户端 IP）', () => {
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'cf-connecting-ip': '203.0.113.7' },
  };
  assert.equal(clientIp(req), '203.0.113.7');
});

test('clientIp: 非 loopback 源时忽略 cf-connecting-ip（防伪造）', () => {
  const req = {
    socket: { remoteAddress: '8.8.8.8' },
    headers: { 'cf-connecting-ip': '1.2.3.4' },
  };
  assert.equal(clientIp(req), '8.8.8.8', '外部连接不得用头字段伪装身份');
});

test('clientIp: 无地址时返回 unknown', () => {
  assert.equal(clientIp(fakeReq('')), 'unknown');
});

// ---------- handshake tracker ----------

test('handshake: 默认常量符合设计', () => {
  assert.equal(DEFAULT_HANDSHAKE_LIMIT, 3);
  assert.equal(HANDSHAKE_WINDOW_MS, 60_000);
});

test('handshake: record 递增计数，达到 max 后 exhausted', () => {
  const tracker = createHandshakeTracker();
  assert.equal(tracker.record('1.2.3.4'), 1);
  assert.equal(tracker.record('1.2.3.4'), 2);
  assert.equal(tracker.record('1.2.3.4'), 3);
  assert.equal(tracker.exhausted('1.2.3.4'), true, '达到 3 次应判定耗尽');
});

test('handshake: 未达上限时 exhausted 为 false', () => {
  const tracker = createHandshakeTracker();
  tracker.record('1.2.3.4');
  assert.equal(tracker.exhausted('1.2.3.4'), false);
});

test('handshake: 不同 IP 独立计数', () => {
  const tracker = createHandshakeTracker();
  tracker.record('1.1.1.1');
  tracker.record('1.1.1.1');
  tracker.record('1.1.1.1');
  assert.equal(tracker.exhausted('1.1.1.1'), true);
  assert.equal(tracker.exhausted('2.2.2.2'), false, '另一个 IP 应独立计数');
});

test('handshake: 窗口过后重新计数', () => {
  let now = 1_000_000;
  const tracker = createHandshakeTracker({ windowMs: 1000 });
  tracker.record('1.1.1.1', now);
  tracker.record('1.1.1.1', now);
  tracker.record('1.1.1.1', now);
  assert.equal(tracker.exhausted('1.1.1.1'), true);

  now += 1001; // 越过窗口
  assert.equal(tracker.record('1.1.1.1', now), 1, '窗口过期后应重置为 1');
  assert.equal(tracker.exhausted('1.1.1.1'), false);
});

test('handshake: clear 清空该 IP 计数', () => {
  const tracker = createHandshakeTracker();
  tracker.record('1.1.1.1');
  tracker.record('1.1.1.1');
  tracker.record('1.1.1.1');
  tracker.clear('1.1.1.1');
  assert.equal(tracker.exhausted('1.1.1.1'), false);
});

test('handshake: prune 清理过期记录', () => {
  const now = 1_000_000;
  const tracker = createHandshakeTracker({ windowMs: 1000 });
  tracker.record('1.1.1.1', now);
  tracker.record('1.1.1.1', now);
  tracker.record('1.1.1.1', now);

  tracker.prune(now + 1001);
  assert.equal(tracker.exhausted('1.1.1.1'), false, '过期记录应被清理');
});

// ---------- stripQueryParam ----------

test('stripQueryParam: 移除指定参数并保留其余', () => {
  assert.equal(stripQueryParam('/?a=1&foo=2&b=3', 'foo'), '/?a=1&b=3');
});

test('stripQueryParam: 参数不存在时原样返回', () => {
  assert.equal(stripQueryParam('/?a=1', 'nope'), '/?a=1');
});

test('stripQueryParam: 非法 URL 不抛异常', () => {
  assert.doesNotThrow(() => stripQueryParam('::::', 'foo'));
});

// ---------- 握手页面 ----------

test('握手页面包含必要提示且不泄漏任何令牌', () => {
  const html = handshakePageHtml();
  assert.ok(html.includes('Saros Pocket'));
  assert.ok(!/tkn=/i.test(html), '页面不得内联连接令牌');
});

test('握手拦截页包含必要提示', () => {
  const html = handshakeBlockedPageHtml();
  assert.ok(html.includes('Saros Pocket'));
  assert.ok(!/tkn=/i.test(html), '页面不得内联连接令牌');
});

// ---------- 登录页品牌（与 VsSaros 同款 logo） ----------

test('登录页：注入品牌时渲染深色品牌条，且标题文字保留', () => {
  const brand = '<img id="brandlogo" src="data:image/svg+xml;base64,AAA" alt="VsSaros">';
  const html = renderLoginPage(false, false, 0, brand);
  assert.ok(html.includes('id="brandlogo"'), '应包含注入的品牌 logo');
  assert.ok(html.includes('class="brand"'), '品牌条是深色底（wordmark 白字靠它才可读）');
  assert.ok(html.includes('Saros Pocket'), '标题文字必须保留（邮件/测试/可访问性依赖）');
  assert.ok(html.includes('#0f1115'), '品牌条背景应为深色');
});

test('登录页：未注入品牌时不出现空品牌条（退回纯文字，行为与改造前一致）', () => {
  const html = renderLoginPage(false, false, 0);
  assert.ok(html.includes('Saros Pocket'));
  assert.ok(!html.includes('class="brand"'), '未提供 brandHtml 时不应渲染品牌条');
});

test('登录页品牌 HTML 不做转义处理以外的事（传入内容原样注入，来源必须是可信的本地资源）', () => {
  // 品牌来自扩展自带的 app/saros-logo.svg（转 data URI），不接受任何用户输入；
  // 这里只钉住「注入点唯一」，避免以后有人在别处再拼一段可被用户影响的内容。
  const html = renderLoginPage(true, true, 0, '<img id="only">');
  assert.equal((html.match(/id="only"/g) ?? []).length, 1, '品牌注入点应唯一');
});

// ---------- 登录后回跳目标（safeNextPath：修复「扫码进 App 被弹去 web」） ----------

test('safeNextPath: 站内路径保留，query / fragment 丢掉', () => {
  assert.equal(safeNextPath('/pocket/'), '/pocket/');
  assert.equal(safeNextPath('/pocket/?a=1'), '/pocket/');
  assert.equal(safeNextPath('/pocket/#screen'), '/pocket/');
  assert.equal(safeNextPath('/pocket/index.html'), '/pocket/index.html');
});

test('safeNextPath: 拒绝跨站 / 畸形输入（防开放重定向）', () => {
  const bad = [
    '//evil.com/x',            // 协议相对
    '/\\evil.com',             // 反斜杠绕过
    'http://evil.com',         // 绝对 URL
    'javascript:alert(1)',     // 伪协议
    'pocket/',                 // 不是站内绝对路径
    '',
    `/${'y'.repeat(600)}`,     // 过长
  ];
  for (const b of bad) assert.equal(safeNextPath(b), '', `应拒绝：${b}`);
});

test('safeNextPath: 非法 URL 不抛异常', () => {
  assert.doesNotThrow(() => safeNextPath('::::'));
});

test('登录页：带上原路径时注入 hidden next，且属性值已转义', () => {
  const html = renderLoginPage(false, false, 0, '', '/pocket/');
  assert.ok(html.includes('name="next" value="/pocket/"'), '应回填回跳目标');
  assert.ok(!renderLoginPage(false, false, 0, '').includes('name="next"'), '没有目标时不应出现 next 字段');
  const evil = renderLoginPage(false, false, 0, '', '/x" onfocus="alert(1)');
  assert.ok(!evil.includes('onfocus="alert(1)"'), '属性值必须转义，不能注入事件处理器');
});

// ---------- 上游不可达页面（桌面版下 / 入口必然 502，必须给出路） ----------

test('上游不可达页：说清「同屏 web 坏了但 App 没事」并给三条出路', () => {
  const html = upstreamDownPageHtml({
    host: '127.0.0.1', port: 8000, err: 'connect ECONNREFUSED 127.0.0.1:8000',
    appPrefix: '/pocket/', triedPath: '/',
  });
  assert.ok(html.includes('同屏 web'), '标题要点明是哪条入口');
  assert.ok(html.includes('127.0.0.1:8000'), '要显示实际尝试的上游地址');
  assert.ok(html.includes('Pocket App 不受影响'), '必须说明 App 可用，否则用户以为全挂了');
  assert.ok(html.includes('href="/pocket/"'), '要给 App 入口链接');
  assert.ok(html.includes('vssaros --server --port 8000'), '要给出启动 server 模式的命令');
  assert.ok(html.includes('sarosPocket.upstreamPort'), '要说明端口可在设置里改');
  assert.ok(html.includes('ECONNREFUSED'), '原始错误要留给排查');
});

test('上游不可达页：重试链接只接受站内路径，App 前缀缺失时不伪造链接', () => {
  const evil = upstreamDownPageHtml({ port: 8000, triedPath: '//evil.com/x' });
  assert.ok(!evil.includes('//evil.com'), '协议相对路径不得进重试链接');
  assert.ok(evil.includes('href="/"'), '退回根路径');
  const noApp = upstreamDownPageHtml({ port: 8000, appPrefix: '', triedPath: '/pocket/' });
  assert.ok(!noApp.includes('打开 Pocket App'), '没有 appPrefix 就不该出现 App 链接');
  assert.ok(noApp.includes('href="/pocket/"'), '但重试链接仍应回到用户请求的路径');
});

test('上游不可达页：注入内容被转义（端口/错误来自网络，不能直接拼 HTML）', () => {
  const html = upstreamDownPageHtml({ host: '"><script>x</script>', port: 8000, err: '<img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<script>x</script>'), 'host 必须转义');
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), '错误消息必须转义');
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
