/**
 * ★ 2026-11-24：端到端流程用例（两组用户旅程）。
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-e2e-flow-check.mjs
 *
 * 组 A｜商城下载安装插件 → 通知重启 → 重启后生效
 *   TC-A1 假服务端商品 → detail / download → installBundle → 落盘 + 侧车 + 台账
 *   TC-A2 安装回执：changeReceipt / application / restartReason / nextStep / restartNotice
 *   TC-A3 通知：restart-required 恰好弹 1 次且带 nextStep；applied 静默；dep 异常不阻塞
 *   TC-A4 重启后：readInstalled + reconcileInstalled + installedVersionOf 读到新版本、无 ghost
 *
 * 组 B｜本地上传 → 其他客户端下载安装 → 上传新版本 → 其他客户端更新
 *   TC-B1 客户端 A 上传 skill 1.0.0（preparePublishBundle + publishVersion）
 *   TC-B2 客户端 B（独立 dataRoot）下载并安装 1.0.0
 *   TC-B3 A 上传 skill 1.1.0，服务端 latest_version 按 semver 重算
 *   TC-B4 B 侧升级检查看到 1.1.0；A/B 磁盘互不污染
 *   TC-B5 B 执行 upgrade：备份旧版、侧车/台账推进到 1.1.0、正文是新版
 *   TC-B6 B 重启后对账读到 1.1.0，无幽灵条目
 *   TC-B7 A 上传另一种资源（agent）1.0.0，B 也能装（覆盖「插件或技能」）
 *   TC-B8 同版本重复上传不产生新 latest（幂等）
 *
 * ⚠ 边界：纯 mock、零网络、零 Host。
 *   · `installPackage` / `notifyRestart` 是注入 dep，工具层与落盘层分开驱动；
 *   · 「重启」用「重新读台账 + 启动对账纯函数」模拟，不重启进程、不重建 ctx；
 *   · 真 `plugin` 走 `dsh plugin add` 改 profile bundles，本脚本覆盖不到 ⇒ 见回复中的真机用例。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { marketToolDefinitions } from '../lib/agentTools.js';
import { preparePublishBundle, publishVersion } from '../lib/publisher.js';
import { installBundle, installedVersionOf, unpackBundle } from '../lib/installers.js';
import { readInstalled, upsertInstalled } from '../lib/installedLedger.js';
import { reconcileInstalled } from '../lib/installedReconcile.js';

let passed = 0, failed = 0;
const failures = [];
async function check(id, name, fn) {
  try { await fn(); passed++; console.log(`  OK  ${id} ${name}`); }
  catch (e) { failed++; failures.push(`${id}: ${e?.message ?? e}`); console.error(`  NG  ${id} ${name}: ${e?.message ?? e}`); }
}
const sha256 = b => createHash('sha256').update(b).digest('hex');
const semverGt = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) { return (pa[i] || 0) > (pb[i] || 0); } }
  return false;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-e2e-flow-'));
const rootOf = n => { const r = path.join(tmp, n); fs.mkdirSync(r, { recursive: true }); return r; };
const rootA = rootOf('client-A-author');
const rootB = path.join(tmp, 'client-B-consumer');
const rootA2 = rootOf('client-A2-author');

/** 状态化假商城：多版本 blob + semver latest + upgrade/check + 下载。 */
function makeMarketServer() {
  const packages = new Map();
  const blobs = new Map();
  const calls = [];
  const json = (body, status = 200) => ({ status, body });
  function market() {
    return {
      // publishVersion 用 request + upload
      request: async (method, urlPath, body) => {
        calls.push({ method, urlPath, body });
        if (method === 'POST' && /^\/packages$/.test(urlPath)) {
          if (packages.has(body.slug)) {
            // ★ 真实 marketClient.request 对非 2xx 是**抛错**；publisher.ensurePackage
            //   靠 catch 里的「已被占用 / HTTP 409」判定 created=false（publisher.js:394-400）
            throw new Error(`HTTP 409: slug "${body.slug}" 已被占用`);
          }
          packages.set(body.slug, {
            slug: body.slug, kind: body.kind, name: body.name || body.slug,
            versions: [], latest_version: '',
          });
          return json({ id: body.slug }, 201);
        }
        return json({ ok: true });
      },
      upload: async (urlPath, buffer) => {
        calls.push({ method: 'UPLOAD', urlPath, bytes: buffer.length, sha256: sha256(buffer) });
        const slug = decodeURIComponent(urlPath.split('/')[2]);
        // 真服务端从包内 manifest.json 解析版本；假服务端同样解包，避免把版本号「偷传」进来
        const { files } = await unpackBundle(buffer);
        const mf = files.find(f => f.path === 'manifest.json');
        const manifest = JSON.parse(mf.data.toString('utf8'));
        const version = manifest.version;
        blobs.set(`${slug}@${version}`, Buffer.from(buffer));
        const pkg = packages.get(slug);
        if (!pkg.versions.some(v => v.version === version)) {
          pkg.versions.push({ version, sha256: sha256(buffer), asset_size: buffer.length, manifest });
        }
        // ★ 与服务端 recomputeLatest 同口径：semver 最大者才是 latest，不是「最后上传」
        pkg.latest_version = pkg.versions.map(v => v.version).reduce((m, v) => semverGt(v, m) ? v : m, '0.0.0');
        for (const v of pkg.versions) { v.is_latest = v.version === pkg.latest_version; }
        return undefined; // 与 publish-check 一致：upload 无返回 ⇒ publishVersion 回落本地 version
      },
      // B 侧下载 / 详情 / 升级检查
      download: async (urlPath) => {
        calls.push({ method: 'DOWNLOAD', urlPath });
        const m = urlPath.match(/\/packages\/([^/]+)\/versions\/([^/]+)\/download$/);
        const slug = decodeURIComponent(m[1]), version = decodeURIComponent(m[2]);
        const buf = blobs.get(`${slug}@${version}`);
        if (!buf) { throw new Error(`假服务端没有 ${slug}@${version}`); }
        return buf;
      },
      detail: async (slug) => {
        const p = packages.get(slug);
        if (!p) { throw new Error('404'); }
        return { ...p, versions: p.versions.map(v => ({ ...v })) };
      },
      // ⚠ 与真实 marketClient.checkUpgrades 同口径：它把服务端的 {updates}
      //   **解包成数组**返回（marketClient.js:473）；假 client 不能返回对象，否则用例会假绿。
      checkUpgrades: async (items) => items.map(i => {
        const p = packages.get(i.storeId);
        return p && semverGt(p.latest_version, i.version)
          ? { ...i, latest: p.latest_version, downloadUrl: `/packages/${i.storeId}/versions/${p.latest_version}/download` }
          : null;
      }).filter(Boolean),
    };
  }
  return { packages, blobs, calls, market };
}

/** 造一份本地资源目录（preparePublishBundle 的入参）。 */
function makeLocalResource(root, kind, id, version, body) {
  const dir = path.join(root, kind === 'skill' ? 'skills' : 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  if (kind === 'skill') {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: E2E 用例\n---\n\n${body}\n`);
  } else {
    // agent 的入口是 `.agent.md`（点开头），见 localResources.js:33 / installers.js:800
    fs.writeFileSync(path.join(dir, '.agent.md'), `---\nname: ${id}\n---\n\n${body}\n`);
  }
  return dir;
}

/** A 侧：本地打包 + 上传（publishVersion 会调用 market.request / market.upload）。 */
async function publishAs(server, root, kind, slug, version, body, changelog) {
  makeLocalResource(root, kind, slug, version, body);
  const bundle = await preparePublishBundle({ dataRoot: root, kind, localId: slug, version });
  const r = await publishVersion({
    market: server.market(), dataRoot: root, kind, localId: slug, version, changelog,
    meta: { name: slug, description: 'E2E 用例' },
  });
  return { bundle, r };
}

/** B 侧：详情 → 下载 → 解包校验 → 落盘 → 写台账（等价 index.js 的 runLocalWrite）。 */
async function installAs(server, root, kind, slug, version, { upgrade = false } = {}) {
  const detail = await server.market().detail(slug);
  const row = detail.versions.find(v => v.version === version);
  assert.ok(row, `服务端缺 ${slug}@${version}`);
  const gz = await server.market().download(`/packages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download`);
  assert.equal(sha256(gz), row.sha256, '下载包 sha256 必须与商城登记一致');
  const res = await installBundle({ dataRoot: root, kind, storeId: slug, version, gzBuffer: gz, upgrade });
  await upsertInstalled(root, { kind, storeId: slug, version, source: 'installed' });
  return { gz, res, row };
}

/** 「重启后」= 重新读台账 + 跑一次启动对账纯函数 + 读磁盘侧车版本。 */
async function simulateRestart(root, kind, slug) {
  const entries = await readInstalled(root);
  const report = await reconcileInstalled({ dataRoot: root, entries });
  const diskVersion = await installedVersionOf({ dataRoot: root, kind, storeId: slug });
  return { entries, report, diskVersion };
}

/** 工具层 dep 注入（与 run-restart-notify-check.mjs 同形状）。 */
function installTool(installResult, notifyCalls, withNotify = true) {
  const deps = {
    inspectGithubRepo: async () => ({}),
    publishDistribution: async () => ({}),
    installPackage: async () => installResult,
    market: () => ({ list: async () => ({ items: [], total: 0 }), detail: async () => ({}) }),
  };
  if (withNotify) { deps.notifyRestart = async p => { notifyCalls.push(p); return true; }; }
  return marketToolDefinitions(deps).find(d => d.name === 'market_install');
}

console.log('================================================');
console.log('  商城安装 / 重启生效 / 跨客户端版本流转 — E2E 用例');
console.log('================================================');

// ═══════════ 组 A：下载安装 → 通知重启 → 重启后生效 ═══════════
console.log('\n── 组 A ──');
const serverA = makeMarketServer();
await publishAs(serverA, rootA, 'skill', 'e2e-plugin', '1.0.0', 'A 组初版正文', '首个版本');

let aInstall;
await check('TC-A1', '商城下载安装：落盘 / 侧车 / 台账三处一致', async () => {
  aInstall = await installAs(serverA, rootB, 'skill', 'e2e-plugin', '1.0.0');
  const side = JSON.parse(fs.readFileSync(path.join(aInstall.res.targetDir, '.market.json'), 'utf8'));
  assert.equal(side.storeId, 'e2e-plugin');
  assert.equal(side.installedVersion, '1.0.0');
  assert.match(fs.readFileSync(path.join(aInstall.res.targetDir, 'SKILL.md'), 'utf8'), /A 组初版正文/);
  const ledger = await readInstalled(rootB);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].version, '1.0.0');
  assert.ok(serverA.calls.some(c => c.method === 'DOWNLOAD'));
});

const receipt = {
  ok: true, kind: 'plugin', version: '1.0.0',
  changeReceipt: {
    application: 'restart-required', restartRequired: true, restartReason: 'no-hmr', stage: 'install', changed: true,
    nextStep: '请在 IDE 插件页点「重启 Host」（命令 dshHarness.restartHost），不要只 Reload Window；请自行重启，我不会替你重启。',
  },
};
await check('TC-A2', '安装回执：application / reason / nextStep / restartNotice', async () => {
  const tool = installTool(receipt, []);
  const r = await tool.execute({ slug: 'e2e-plugin' });
  assert.equal(r.ok, true);
  assert.equal(r.application, 'restart-required');
  assert.equal(r.restartReason, 'no-hmr');
  assert.match(r.nextStep, /dshHarness\.restartHost/);
  assert.match(r.nextStep, /不要只 Reload Window/);
  assert.equal(r.restartNotice?.kind, 'warn');
  assert.equal(r.restartNotice?.restartRequired, true);
});
await check('TC-A3', '通知：需重启恰好 1 次且带 nextStep；applied 静默；dep 异常不阻塞', async () => {
  const calls = [];
  await installTool(receipt, calls).execute({ slug: 'e2e-plugin' });
  await Promise.resolve();
  assert.equal(calls.length, 1, 'restart-required 必须只弹一次');
  assert.equal(calls[0].kind, 'warn');
  assert.equal(calls[0].application, 'restart-required');
  assert.match(calls[0].nextStep, /重启 Host/);

  const silent = [];
  await installTool({ ok: true, kind: 'skill', version: '1.0.0', application: 'applied' }, silent).execute({ slug: 'e2e-plugin' });
  await Promise.resolve();
  assert.equal(silent.length, 0, '对齐上游：成功即时生效不弹 toast');

  const noDep = await installTool(receipt, [], false).execute({ slug: 'e2e-plugin' });
  assert.equal(noDep.ok, true, 'dep 缺失不得阻塞安装回执');
  const throwing = await installTool(receipt, [], false).execute({ slug: 'e2e-plugin' }).catch(() => null);
  assert.ok(throwing, '通知通道异常不应让安装失败');
});
await check('TC-A4', '重启后生效：台账 / 磁盘侧车 / 启动对账都读到 1.0.0，无幽灵条目', async () => {
  const r = await simulateRestart(rootB, 'skill', 'e2e-plugin');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].version, '1.0.0');
  assert.equal(r.diskVersion, '1.0.0', '磁盘侧车是重启后的真源');
  assert.equal(r.report.installed, 1);
  assert.equal(r.report.ghostCount, 0);
});

// ═══════════ 组 B：A 上传 → B 装 → A 新版本 → B 更新 ═══════════
console.log('\n── 组 B ──');
const serverB = makeMarketServer();
const slug = 'e2e-skill';
await check('TC-B1', '客户端 A 本地上传技能 1.0.0（建包 + 上传 + 服务端登记）', async () => {
  const { r } = await publishAs(serverB, rootA2, 'skill', slug, '1.0.0', 'B 组 v1 正文', '首个版本');
  assert.equal(r.created, true);
  assert.equal(r.version, '1.0.0');
  assert.ok(r.bytes > 0);
  const pkg = serverB.packages.get(slug);
  assert.equal(pkg.latest_version, '1.0.0');
  assert.equal(pkg.versions.length, 1);
  assert.ok(serverB.blobs.has(`${slug}@1.0.0`));
});
await check('TC-B2', '客户端 B（独立 dataRoot）下载安装 1.0.0，sha256 校验通过', async () => {
  const { res } = await installAs(serverB, rootB, 'skill', slug, '1.0.0');
  assert.match(fs.readFileSync(path.join(res.targetDir, 'SKILL.md'), 'utf8'), /B 组 v1 正文/);
  const ledger = await readInstalled(rootB);
  assert.ok(ledger.some(e => e.storeId === slug && e.version === '1.0.0'));
});
await check('TC-B3', 'A 上传新版本 1.1.0，服务端 latest 按 semver 重算', async () => {
  const { r } = await publishAs(serverB, rootA2, 'skill', slug, '1.1.0', 'B 组 v2 正文', '修复若干问题');
  assert.equal(r.version, '1.1.0');
  assert.equal(r.created, false, '第 2 次上传走 409 容忍 + 继续上传');
  const pkg = serverB.packages.get(slug);
  assert.equal(pkg.latest_version, '1.1.0');
  assert.equal(pkg.versions.length, 2);
  assert.equal(pkg.versions.find(v => v.version === '1.1.0').is_latest, true);
  assert.equal(pkg.versions.find(v => v.version === '1.0.0').is_latest, false);
  assert.ok(serverB.blobs.has(`${slug}@1.1.0`));
});
await check('TC-B4', 'B 侧升级检查看到 1.1.0；A/B 两台机器磁盘互不污染', async () => {
  const updates = await serverB.market().checkUpgrades([{ kind: 'skill', storeId: slug, version: '1.0.0' }]);
  assert.ok(Array.isArray(updates), 'checkUpgrades 应返回数组（与真实 client 同口径）');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].latest, '1.1.0');
  assert.match(updates[0].downloadUrl, /1\.1\.0\/download$/);
  // A 是作者根：只有源目录，没有 B 的台账与安装落地物
  assert.equal(fs.existsSync(path.join(rootA2, 'installed-packages.json')), false);
  assert.equal(fs.existsSync(path.join(rootA2, 'skills', slug, '.market.json')), false);
  // B 是消费根：有台账与落地物，没有作者的源文件痕迹
  assert.equal(fs.existsSync(path.join(rootB, 'installed-packages.json')), true);
  assert.equal(fs.existsSync(path.join(rootB, 'skills', slug, 'SKILL.md')), true);
});
await check('TC-B5', 'B 执行更新：备份旧版、正文/侧车/台账推进到 1.1.0', async () => {
  const { res } = await installAs(serverB, rootB, 'skill', slug, '1.1.0', { upgrade: true });
  const md = fs.readFileSync(path.join(res.targetDir, 'SKILL.md'), 'utf8');
  assert.match(md, /B 组 v2 正文/);
  assert.doesNotMatch(md, /B 组 v1 正文/);
  const side = JSON.parse(fs.readFileSync(path.join(res.targetDir, '.market.json'), 'utf8'));
  assert.equal(side.installedVersion, '1.1.0');
  assert.ok(res.backup && fs.existsSync(res.backup), '升级前必须备份');
  assert.match(fs.readFileSync(path.join(res.backup, 'SKILL.md'), 'utf8'), /B 组 v1 正文/);
  const ledger = await readInstalled(rootB);
  const row = ledger.find(e => e.storeId === slug);
  assert.equal(row.version, '1.1.0');
  assert.equal(ledger.filter(e => e.storeId === slug).length, 1, '升级不得产生重复台账条目');
});
await check('TC-B6', 'B 重启后对账读到 1.1.0，台账与磁盘一致、无幽灵条目', async () => {
  const r = await simulateRestart(rootB, 'skill', slug);
  assert.equal(r.diskVersion, '1.1.0');
  assert.equal(r.entries.find(e => e.storeId === slug).version, '1.1.0');
  assert.equal(r.report.ghostCount, 0);
  assert.ok(r.report.installed >= 2, 'A 组与 B 组两个资源都应在磁盘上');
});
await check('TC-B7', '另一种资源（agent）也能 A 上传 → B 下载安装', async () => {
  const agentSlug = 'e2e-agent';
  await publishAs(serverB, rootA2, 'agent', agentSlug, '1.0.0', 'Agent 正文', '首个版本');
  const { res } = await installAs(serverB, rootB, 'agent', agentSlug, '1.0.0');
  assert.ok(fs.existsSync(path.join(res.targetDir, '.agent.md')));
  const ledger = await readInstalled(rootB);
  assert.ok(ledger.some(e => e.storeId === agentSlug && e.kind === 'agent'));
});
await check('TC-B8', '同版本重复上传不新增版本行、latest 不变（幂等）', async () => {
  const before = serverB.packages.get(slug).versions.length;
  await publishAs(serverB, rootA2, 'skill', slug, '1.1.0', 'B 组 v2 正文', '重复上传');
  const pkg = serverB.packages.get(slug);
  assert.equal(pkg.versions.length, before);
  assert.equal(pkg.latest_version, '1.1.0');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
