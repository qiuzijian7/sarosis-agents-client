#!/usr/bin/env node
// @vssaros/dsh-marketplace — **半自动真机用例**：跨客户端版本流转（TC-B9 / TC-B10 的服务端侧）
//
// 对应上一轮 `run-marketplace-e2e-flow-check.mjs` 里无法用 mock 证明的部分：
//   真 HTTP 登录 / 建包 / 上传 / 列表 / 详情 / 下载 / sha256 / semver latest / upgrade/check /
//   审核放行，以及「两个独立 dataRoot + 两套 JWT」的客户端隔离。
//
// ⚠ **本脚本不进自动回归**（需要本地服务端）。它**不碰线上**：
//   · MARKET_BASE 必须是 localhost / 127.0.0.1 / ::1，其它一律拒绝（防误连生产写数据）；
//   · 所有测试商品用带时间戳的 slug，跑完尽力删除；
//   · 两个客户端的数据根是临时目录，跑完清理。
//
// 用法（在服务端仓）：
//   1. 起隔离实例（**别用线上**）：
//        PORT=3043 DATA_DIR=./.e2e-cross MARKETPLACE_REVIEW_REQUIRED=0 node dist/server.js
//   2. 跑本脚本：
//        MARKET_BASE=http://127.0.0.1:3043 \
//        node dsh-plugins/vssaros-marketplace/test/verify-cross-client-server.mjs
//      可选：ADMIN_PASS=<admin 密码>（审核流开启时用于放行）；
//            MARKET_REVIEW_REQUIRED=1 时强制验证审核分支。
//
// 仍未覆盖（必须真 IDE/Host，脚本里只给提示）：
//   TC-A5/A6 的 IDE 通知条真弹出、`dshHarness.restartHost` 真重启、profile bundles 重读、
//   Host + IDE renderer 双进程争同一把 <file>.lock。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMarketClient, MARKET_JWT_REF } from '../lib/marketClient.js';
import { publishVersion, deletePackage, deleteVersion } from '../lib/publisher.js';
import { installBundle } from '../lib/installers.js';
import { readInstalled, upsertInstalled } from '../lib/installedLedger.js';
import { reconcileInstalled } from '../lib/installedReconcile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.MARKET_BASE ?? '').replace(/\/+$/, '');
const sha256 = b => createHash('sha256').update(b).digest('hex');

// ── 硬性护栏：绝不允许连生产 ──────────────────────────────────
if (!BASE) { console.error('需要 MARKET_BASE（见文件头用法）'); process.exit(2); }
let host;
try { host = new URL(BASE).hostname; } catch { console.error('MARKET_BASE 不是合法 URL'); process.exit(2); }
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`拒绝连接非本机服务端 ${BASE}（防止误写生产数据）；请用隔离的本地实例`);
  process.exit(2);
}

let passed = 0, failed = 0, skipped = 0;
const failures = [];
async function check(id, name, fn) {
  try { await fn(); passed++; console.log(`  OK   ${id} ${name}`); }
  catch (e) { failed++; failures.push(`${id}: ${e?.message ?? e}`); console.error(`  FAIL ${id} ${name}: ${e?.message ?? e}`); }
}
const skip = (id, name, why) => { skipped++; console.log(`  SKIP ${id} ${name} — ${why}`); };

const stamp = Date.now().toString().slice(-8);
const slug = `cross-skill-${stamp}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cross-server-'));
const rootA = path.join(tmp, 'client-A');
const rootB = path.join(tmp, 'client-B');
for (const r of [rootA, rootB]) { fs.mkdirSync(r, { recursive: true }); }
const names = { a: `crossa${stamp}`, b: `crossb${stamp}` };
const pw = 'crosspass123';
const createdVersions = [];

async function register(username) {
  const r = await fetch(`${BASE}/api/v1/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@example.com`, password: pw }),
  });
  const text = await r.text();
  assert.ok(r.ok, `注册 ${username} 失败：HTTP ${r.status} ${text.slice(0, 160)}`);
}
async function clientOf(username) {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: pw }),
  });
  const text = await r.text();
  assert.ok(r.ok, `登录 ${username} 失败：HTTP ${r.status} ${text.slice(0, 160)}`);
  const token = JSON.parse(text).token;
  assert.ok(typeof token === 'string' && token.length > 20, 'JWT 不合法');
  return createMarketClient({
    credentials: {
      resolve: async ref => (ref === MARKET_JWT_REF ? { value: token } : undefined),
      set: async () => { }, unset: async () => { },
    },
    config: { marketEndpoint: BASE, dataRoot: username.startsWith(names.a) ? rootA : rootB },
    log: () => { },
  });
}
function makeLocal(root, version, body) {
  const dir = path.join(root, 'skills', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: 跨客户端真机用例\n---\n\n${body}\n`);
}
async function uploadAs(market, root, version, body, changelog) {
  makeLocal(root, version, body);
  const r = await publishVersion({
    market, dataRoot: root, kind: 'skill', localId: slug, version, changelog,
    meta: { name: slug, description: '跨客户端真机用例' },
  });
  createdVersions.push(version);
  return r;
}
async function downloadAs(market, version) {
  const detail = await market.detail(slug);
  const row = detail.versions.find(v => v.version === version);
  assert.ok(row, `服务端缺 ${slug}@${version}`);
  const gz = await market.download(`/packages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download`);
  assert.equal(sha256(gz), String(row.sha256).toLowerCase(), '下载包 sha256 必须与服务端登记一致');
  return { detail, row, gz };
}

console.log('================================================');
console.log(`  跨客户端版本流转（真机半自动）— ${BASE}`);
console.log('================================================');

let clientA, clientB;
await check('TC-S1', '两个独立用户注册并各自换到 JWT（客户端 A / B 不同身份）', async () => {
  await register(names.a);
  await register(names.b);
  clientA = await clientOf(names.a);
  clientB = await clientOf(names.b);
  assert.ok(clientA && clientB);
});

await check('TC-S2', '客户端 A 本地上传 skill 1.0.0（真 HTTP：建包 + raw tar.gz）', async () => {
  const r = await uploadAs(clientA, rootA, '1.0.0', '真机 v1 正文', '首个版本');
  assert.equal(r.ok, true);
  assert.equal(r.version, '1.0.0');
  assert.ok(r.bytes > 0);
});

// 审核流：本地默认免审；若检测到 pending_review 且给了 admin 口令，则验证放行分支
const reviewMode = process.env.MARKET_REVIEW_REQUIRED === '1';
if (reviewMode) {
  await check('TC-S10', '审核流：普通用户发布进 pending_review，B 不可见，admin 放行后可见', async () => {
    // 作者自己看得到待审核状态
    const asAuthor = await clientA.detail(slug);
    assert.equal(asAuthor.status, 'pending_review', '应处于待审核');
    // ⚠ 服务端 routes.ts:259-262 对非作者的 pending 商品直接返回 404（不是回 status）
    let hidden = false;
    try { await clientB.detail(slug); }
    catch (e) { hidden = /404|不存在|HTTP\s*4\d\d/.test(String(e?.message ?? e)); }
    assert.ok(hidden, '待审核商品对非作者必须不可见');
    const adminPass = process.env.ADMIN_PASS;
    assert.ok(adminPass, '审核分支需要 ADMIN_PASS');
    const lr = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminPass }),
    });
    assert.ok(lr.ok, 'admin 登录失败');
    const adminToken = JSON.parse(await lr.text()).token;
    const ar = await fetch(`${BASE}/api/v1/admin/packages/${encodeURIComponent(slug)}/status`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });
    assert.ok(ar.ok, `放行失败：HTTP ${ar.status}`);
    const after = await clientB.detail(slug);
    assert.equal(after.status, 'active');
  });
} else {
  skip('TC-S10', '审核流', '本地实例以 MARKETPLACE_REVIEW_REQUIRED=0 启动；设 MARKET_REVIEW_REQUIRED=1 + ADMIN_PASS 可验证');
}

await check('TC-S3', '客户端 B 能列到 / 查到商品，下载包 sha256 与服务端登记一致', async () => {
  const { detail, row } = await downloadAs(clientB, '1.0.0');
  assert.equal(detail.slug, slug);
  assert.equal(row.version, '1.0.0');
});

await check('TC-S4', '客户端 B（独立 dataRoot）安装 1.0.0：正文 / 侧车 / 台账一致，A 不受影响', async () => {
  const { gz } = await downloadAs(clientB, '1.0.0');
  const res = await installBundle({ dataRoot: rootB, kind: 'skill', storeId: slug, version: '1.0.0', gzBuffer: gz });
  assert.match(fs.readFileSync(path.join(res.targetDir, 'SKILL.md'), 'utf8'), /真机 v1 正文/);
  const side = JSON.parse(fs.readFileSync(path.join(res.targetDir, '.market.json'), 'utf8'));
  assert.equal(side.installedVersion, '1.0.0');
  await upsertInstalled(rootB, { kind: 'skill', storeId: slug, version: '1.0.0', source: 'installed' });
  assert.equal((await readInstalled(rootB)).length, 1);
  assert.equal(fs.existsSync(path.join(rootA, 'installed-packages.json')), false, 'A 不该有 B 的台账');
});

await check('TC-S5', 'A 上传新版本 1.1.0，服务端 latest_version 按 semver 重算', async () => {
  const r = await uploadAs(clientA, rootA, '1.1.0', '真机 v2 正文', '修复若干问题');
  assert.equal(r.created, false, '第二次上传走 409 容忍');
  const detail = await clientB.detail(slug);
  assert.equal(detail.latest_version ?? detail.latestVersion, '1.1.0');
  const v = detail.versions;
  assert.ok(v.some(x => x.version === '1.1.0'), '新版本行必须存在');
  assert.ok(v.some(x => x.version === '1.0.0'), '旧版本仍可下载');
});

await check('TC-S6', 'B 的 upgrade/check 返回 1.1.0 与新版本下载地址', async () => {
  // ⚠ marketClient.checkUpgrades 已经把服务端的 {updates} **解包成数组**返回（marketClient.js:473）
  const res = await clientB.checkUpgrades([{ kind: 'skill', storeId: slug, version: '1.0.0' }]);
  assert.ok(Array.isArray(res), 'checkUpgrades 应返回数组');
  const hit = res.find(u => u.storeId === slug);
  assert.ok(hit, '应看到可升级项');
  assert.equal(String(hit.latest).trim(), '1.1.0');
  assert.match(String(hit.downloadUrl ?? ''), /1\.1\.0/);
});

await check('TC-S7', 'B 执行更新：备份旧版、侧车/台账推进到 1.1.0；重启对账无幽灵条目', async () => {
  const { gz } = await downloadAs(clientB, '1.1.0');
  const res = await installBundle({ dataRoot: rootB, kind: 'skill', storeId: slug, version: '1.1.0', gzBuffer: gz, upgrade: true });
  assert.match(fs.readFileSync(path.join(res.targetDir, 'SKILL.md'), 'utf8'), /真机 v2 正文/);
  assert.ok(res.backup && fs.existsSync(res.backup), '升级前必须备份');
  assert.match(fs.readFileSync(path.join(res.backup, 'SKILL.md'), 'utf8'), /真机 v1 正文/);
  await upsertInstalled(rootB, { kind: 'skill', storeId: slug, version: '1.1.0', source: 'installed' });
  const ledger = await readInstalled(rootB);
  assert.equal(ledger.length, 1, '升级不得产生重复台账条目');
  assert.equal(ledger[0].version, '1.1.0');
  const report = await reconcileInstalled({ dataRoot: rootB, entries: ledger });
  assert.equal(report.ghostCount, 0);
  assert.equal(report.installed, 1);
});

// ── 清理：尽力删除测试版本与商品，绝不留下脏数据 ───────────────
let cleaned = 0;
for (const v of [...new Set(createdVersions)]) {
  try { await deleteVersion({ market: clientA, slug, version: v }); cleaned++; } catch { /* 尽力 */ }
}
try { await deletePackage({ market: clientA, slug }); cleaned++; } catch { /* 尽力 */ }
console.log(`\n  清理：删除 ${cleaned} 项测试版本/商品（尽力而为）`);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n  仍未覆盖（必须真 IDE/Host）：IDE 通知条真弹出、dshHarness.restartHost 真重启、');
console.log('  profile bundles / pnpm-lock 重读、Host + IDE 双进程台账锁。');
console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
console.log(`  跳过: ${skipped}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
