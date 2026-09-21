// lib/state.mjs 与 lib/host.mjs 的单元测试。
//
// state.mjs 管的是「谁能进来」：PIN 生成、持久化、按 Host 选令牌、隧道配置。
// host.mjs 管的是「上游在哪、本机 IP 是哪个」：端口探测、令牌读取、局域网 IP 选择。
// 两者都是纯逻辑 + 文件 IO，用临时目录即可完整测试，不需要起服务器。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../lib/state.mjs';
import { appEntryUrl, listLanInterfaces, probeHttp, selectLanIPv4, discoverConnectionToken } from '../lib/host.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/** 每个用例一个干净目录，避免相互污染。 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'saros-pocket-test-'));
  try {
    return fn(createStateStore(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 带「设置后端」的仓库（模拟 extension.js 注入的 vscode 配置适配器）。
 * 用于验证：开关类以设置为唯一真源，凭据仍只落 globalStorage。
 */
function withSettingsStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'saros-pocket-settings-'));
  const settings = {
    values: { lanEnabled: true, lanAuthEnabled: true, lanIpOverride: '', tunnelMode: 'quick', tunnelHostname: '' },
    writes: [],
    get(name) { return this.values[name]; },
    update(name, value) { this.writes.push([name, value]); this.values[name] = value; },
  };
  try {
    return fn(createStateStore(dir, { settings }), dir, settings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- PIN ----------

test('PIN：首次取用自动生成 8 位数字', () => {
  withStore((store) => {
    const pin = store.getAccessToken();
    assert.match(pin, /^\d{8}$/, `PIN 应为 8 位数字，实际：${pin}`);
  });
});

test('PIN：同一 store 多次取用结果稳定（已持久化而非每次重生成）', () => {
  withStore((store) => {
    assert.equal(store.getAccessToken(), store.getAccessToken());
  });
});

test('PIN：公网与局域网使用各自独立的令牌', () => {
  withStore((store) => {
    // 连续生成两个不同的 PIN 概率极高，用多次取值确认二者独立存在
    const publicPin = store.getAccessToken();
    const lanPin = store.getLanToken();
    assert.match(publicPin, /^\d{8}$/);
    assert.match(lanPin, /^\d{8}$/);
    assert.notEqual(publicPin, lanPin, '公网与局域网 PIN 应相互独立');
  });
});

test('PIN：rotate 后公网令牌变化', () => {
  withStore((store) => {
    const before = store.getAccessToken();
    const after = store.rotateAccessToken();
    assert.notEqual(before, after, 'rotate 必须换发新 PIN');
    assert.equal(store.getAccessToken(), after, 'rotate 后应持久化新 PIN');
  });
});

test('PIN：自定义 PIN 必须 8 位字母数字，否则拒绝', () => {
  withStore((store) => {
    assert.throws(() => store.setCustomPin('public', '123'), /8 位/);
    assert.throws(() => store.setCustomPin('public', '123456789'), /8 位/);
    assert.throws(() => store.setCustomPin('public', 'abcd-efg'), /8 位/);
    assert.equal(store.setCustomPin('public', 'abcd1234'), 'abcd1234');
  });
});

test('PIN：未知类型拒绝', () => {
  withStore((store) => {
    assert.throws(() => store.setCustomPin('weird', 'abcd1234'), /未知密码类型/);
  });
});

// ---------- 按 Host 选令牌 ----------

test('tokenForHost：公网 Host 用公网令牌，lan Host 用局域网令牌', () => {
  withStore((store) => {
    assert.equal(store.tokenForHost('abc.trycloudflare.com'), store.getAccessToken());
    assert.equal(store.tokenForHost('192.168.1.20'), store.getLanToken());
  });
});

test('tokenForHost：loopback 用局域网令牌', () => {
  withStore((store) => {
    assert.equal(store.tokenForHost('localhost'), store.getLanToken());
  });
});

test('tokenForHost：局域网地址覆盖生效', () => {
  withStore((store) => {
    store.setLanIpOverride('192.168.50.7');
    assert.equal(store.tokenForHost('192.168.50.7'), store.getLanToken());
    assert.equal(store.isLanOverrideHost('192.168.50.7:3081'), true, '应忽略端口');
  });
});

// ---------- 开关与配置 ----------

test('开关：局域网访问默认开启，可关闭并持久化', () => {
  withStore((store) => {
    assert.equal(store.lanEnabled(), true, '默认应开启');
    assert.equal(store.setLanEnabled(false), false);
    assert.equal(store.lanEnabled(), false);
  });
});

test('开关：局域网密码默认开启（安全默认值不得改变）', () => {
  withStore((store) => {
    assert.equal(store.lanAuthEnabled(), true, '局域网密码默认必须开启');
  });
});

test('配置：局域网 IP 覆盖必须是合法 IPv4', () => {
  withStore((store) => {
    assert.throws(() => store.setLanIpOverride('not-an-ip'), /IPv4/);
    assert.equal(store.setLanIpOverride('10.0.0.9'), '10.0.0.9');
    assert.equal(store.setLanIpOverride(''), '', '空值应清除覆盖');
    assert.equal(store.lanIpOverride(), '');
  });
});

test('配置：隧道模式只能是 quick / named', () => {
  withStore((store) => {
    assert.equal(store.tunnelMode(), 'quick', '默认快速隧道');
    assert.equal(store.setTunnelMode('named'), 'named');
    assert.equal(store.tunnelMode(), 'named');
    assert.throws(() => store.setTunnelMode('weird'), /quick 或 named/);
  });
});

test('配置：固定域名格式校验（拒绝 IP 与无点名）', () => {
  withStore((store) => {
    assert.throws(() => store.setTunnelHostname('192.168.1.1'), /固定域名格式不对/);
    assert.throws(() => store.setTunnelHostname('localhost'), /固定域名格式不对/);
    assert.equal(store.setTunnelHostname('https://pocket.example.com/path'), 'pocket.example.com');
  });
});

test('配置：代理端口范围校验', () => {
  withStore((store) => {
    assert.equal(store.setProxyPort(3081), 3081);
    assert.equal(store.setProxyPort(99999), 0, '越界端口应被拒绝并回退 0');
    assert.equal(store.setProxyPort(0), 0);
  });
});

test('重置：清空状态与令牌后重新生成', () => {
  withStore((store) => {
    const before = store.getAccessToken();
    store.setLanEnabled(false);
    store.resetPocketState();

    assert.equal(store.lanEnabled(), true, '重置后开关回到默认');
    assert.notEqual(store.getAccessToken(), before, '重置后应换发新 PIN');
  });
});

test('持久化：状态写入磁盘且文件权限为 0o600', () => {
  withStore((store, dir) => {
    store.setLanEnabled(false);
    // 重新打开同一目录，应读到持久化的值
    const reopened = createStateStore(dir);
    assert.equal(reopened.lanEnabled(), false, '状态应跨实例持久化');
  });
});

test('健壮性：状态文件损坏时回退默认值而不崩溃', () => {
  withStore((store, dir) => {
    mkdirSync(join(dir, 'saros-pocket'), { recursive: true });
    writeFileSync(join(dir, 'saros-pocket', 'state.json'), '{ 这不是 JSON');
    assert.equal(store.lanEnabled(), true, '损坏文件应回退默认');
  });
});

// ---------- host.mjs：局域网 IP 选择 ----------

function iface(address, extra = {}) {
  return [{ family: 'IPv4', internal: false, address, ...extra }];
}

test('selectLanIPv4：优先私网地址', () => {
  const ip = selectLanIPv4({
    vpn: iface('25.0.0.1'),
    wifi: iface('192.168.1.20'),
  });
  assert.equal(ip, '192.168.1.20');
});

test('selectLanIPv4：排除回环与 link-local', () => {
  const ip = selectLanIPv4({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    apipa: iface('169.254.1.1'),
    eth: iface('10.0.0.5'),
  });
  assert.equal(ip, '10.0.0.5');
});

test('selectLanIPv4：排除 IPv6', () => {
  const ip = selectLanIPv4({
    eth: [
      { family: 'IPv6', internal: false, address: 'fe80::1' },
      { family: 'IPv4', internal: false, address: '192.168.1.9' },
    ],
  });
  assert.equal(ip, '192.168.1.9');
});

test('selectLanIPv4：VPN / 虚拟网卡降权（真实物理网卡优先）', () => {
  const ip = selectLanIPv4({
    'Tailscale': iface('100.100.1.1'),
    'Wi-Fi': iface('192.168.1.20'),
  });
  assert.equal(ip, '192.168.1.20', '物理网卡应胜过 VPN');
});

test('selectLanIPv4：同分时先出现的胜出', () => {
  const ip = selectLanIPv4({
    a: iface('10.0.0.1'),
    b: iface('10.0.0.2'),
  });
  assert.equal(ip, '10.0.0.1');
});

test('selectLanIPv4：无候选时返回 null', () => {
  assert.equal(selectLanIPv4({}), null);
  assert.equal(selectLanIPv4(null), null);
  assert.equal(selectLanIPv4({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }), null);
});

// ---------- host.mjs：候选网卡明细（手机连不上时用来换地址） ----------

test('listLanInterfaces：给出 ip / 网卡名 / 是否疑似虚拟网卡，并按评分排序', () => {
  const list = listLanInterfaces({
    'vEthernet (WSL)': iface('172.24.176.1'),
    'WLAN': iface('192.168.1.9'),
    'Tailscale': iface('100.100.1.1'),
  });
  assert.deepEqual(list.map((i) => i.ip), ['192.168.1.9', '100.100.1.1', '172.24.176.1'],
    '物理无线网卡排最前（评分高），虚拟/VPN 在后');
  assert.equal(list.find((i) => i.ip === '172.24.176.1').virtual, true, 'WSL 网卡标成虚拟');
  assert.equal(list.find((i) => i.ip === '192.168.1.9').virtual, false, '物理网卡不是虚拟');
  assert.equal(list.find((i) => i.ip === '192.168.1.9').iface, 'WLAN', '要带上网卡名，用户才知道选哪个');
});

test('listLanInterfaces：排除回环 / link-local / IPv6，同 IP 只保留一条', () => {
  const list = listLanInterfaces({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    apipa: iface('169.254.1.1'),
    eth: [{ family: 'IPv6', internal: false, address: 'fe80::1' }, { family: 'IPv4', internal: false, address: '10.0.0.5' }],
    ethDup: iface('10.0.0.5'),
  });
  assert.deepEqual(list.map((i) => i.ip), ['10.0.0.5']);
});

test('appEntryUrl：无密码给干净地址；带密码附 ?token= 并做 URL 编码', () => {
  assert.equal(appEntryUrl(3081, '/pocket/'), 'http://127.0.0.1:3081/pocket/');
  assert.equal(appEntryUrl(3081), 'http://127.0.0.1:3081/pocket/', '缺省参数也要能拼出干净地址');
  assert.equal(appEntryUrl(3081, '/pocket/', '12345678'), 'http://127.0.0.1:3081/pocket/?token=12345678');
  assert.equal(appEntryUrl(3081, '/pocket/', 'a b&c'), 'http://127.0.0.1:3081/pocket/?token=a%20b%26c',
    '密码必须编码（& 之类的字符不能被当成新的查询参数）');
  assert.equal(appEntryUrl(3081, '/pocket/', '   '), 'http://127.0.0.1:3081/pocket/', '空白密码按"没有密码"处理');
  assert.ok(appEntryUrl(3000, '/pocket/', 'x', '192.168.1.2').startsWith('http://192.168.1.2:3000/pocket/?token=x'),
    '换主机名也要能用（给「用局域网地址打开」留口子）');
});

test('probeHttp：连不上时给出错误码（不抛异常），可达时带回 HTTP 状态', async () => {
  const dead = await probeHttp('http://127.0.0.1:1/', 400);
  assert.equal(dead.ok, false, '没人监听的端口必须判为不可达');
  assert.ok(/ECONNREFUSED|timeout|EACCES|EPERM|ECONNRESET/i.test(String(dead.error)), `错误码要可读：${dead.error}`);

  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => { res.writeHead(302, { location: '/login' }); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await probeHttp(`http://127.0.0.1:${server.address().port}/pocket/`);
    assert.equal(r.ok, true, '任何 HTTP 响应（含 302 登录跳转）都算可达');
    assert.equal(r.status, 302);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------- host.mjs：连接令牌 ----------

test('discoverConnectionToken：配置优先且做字符白名单校验', async () => {
  const tok = await discoverConnectionToken({ configured: 'my-token_123' });
  assert.equal(tok, 'my-token_123');
});

test('discoverConnectionToken：配置含非法字符时忽略并走文件探测', async () => {
  const tok = await discoverConnectionToken({ configured: 'bad token!' });
  assert.equal(typeof tok, 'string');
});

test('discoverConnectionToken：userDataDir 令牌文件被读取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saros-pocket-tok-'));
  try {
    writeFileSync(join(dir, 'token'), 'file-token-456\n');
    const tok = await discoverConnectionToken({ userDataDir: dir });
    assert.equal(tok, 'file-token-456', '应读取并去除换行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverConnectionToken：找不到时返回空串（不抛异常）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saros-pocket-empty-'));
  try {
    const tok = await discoverConnectionToken({ userDataDir: dir });
    assert.equal(tok, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 开关类走「设置后端」（面板与插件设置页同源） ----------

test('开关类：读写都走设置（不落 state.json）', () => {
  withSettingsStore((store, dir, settings) => {
    assert.equal(store.lanEnabled(), true, '默认应为 true');
    store.setLanEnabled(false);
    assert.equal(store.lanEnabled(), false, '关掉后应立刻反映');
    assert.equal(settings.values.lanEnabled, false, '应写进设置');
    assert.ok(settings.writes.some(([k, v]) => k === 'lanEnabled' && v === false), '写设置的名字应为短名 lanEnabled');

    store.setLanAuthEnabled(false);
    assert.equal(store.lanAuthEnabled(), false);

    store.setTunnelMode('named');
    assert.equal(store.tunnelMode(), 'named');
    store.setTunnelHostname('pocket.example.com');
    assert.equal(store.tunnelHostname(), 'pocket.example.com');
    store.setLanIpOverride('192.168.1.9');
    assert.equal(store.lanIpOverride(), '192.168.1.9');

    // 没被写进 state.json（设置接管后文件里不该再出现开关）
    const raw = existsSync(join(dir, 'saros-pocket', 'state.json')) ? readFileSync(join(dir, 'saros-pocket', 'state.json'), 'utf8') : '';
    assert.ok(!/"lanEnabled"/.test(raw), 'state.json 里不应再有开关字段');
  });
});

test('开关类：设置后端下校验依然生效（非法值直接抛）', () => {
  withSettingsStore((store, _dir, settings) => {
    assert.throws(() => store.setLanIpOverride('not-an-ip'), /IPv4/);
    assert.throws(() => store.setTunnelMode('weird'), /quick 或 named/);
    assert.throws(() => store.setTunnelHostname('bad host'), /格式不对/);
    assert.deepEqual(settings.writes, [], '校验失败不应写入设置');
  });
});

test('凭据不进设置：PIN / 隧道 Token 仍只落 globalStorage', () => {
  withSettingsStore((store, _dir, settings) => {
    const pin = store.getLanToken();
    assert.match(pin, /^\d{8}$/);
    store.setCustomPin('lan', 'abcdefgh');
    assert.equal(store.getLanToken(), 'abcdefgh');
    store.setTunnelToken('A'.repeat(24));

    const touched = settings.writes.map(([k]) => k);
    for (const key of ['token', 'token-lan', 'tunnelToken', 'publicPin', 'lanPin']) {
      assert.ok(!touched.includes(key), `凭据 ${key} 不该写进设置`);
    }
  });
});

test('恢复出厂：设置里的开关也一并回落默认值', () => {
  withSettingsStore((store, _dir, settings) => {
    store.setLanEnabled(false);
    store.setTunnelMode('named');
    store.setTunnelHostname('pocket.example.com');
    store.resetPocketState();
    assert.equal(store.lanEnabled(), true);
    assert.equal(store.tunnelMode(), 'quick');
    assert.equal(store.tunnelHostname(), '');
    assert.ok(settings.writes.length >= 5, '应把 5 个开关都写回默认值');
  });
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
