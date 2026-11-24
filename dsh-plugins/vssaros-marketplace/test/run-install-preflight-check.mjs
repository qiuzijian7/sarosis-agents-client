/**
 * ★ 2026-11-24 P1：安装前兼容性预检 / 失败分类 / 原子落盘 行为守卫。
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-install-preflight-check.mjs
 *
 * 纯函数 + 真临时目录（零网络、零 Host），不触碰用户数据根。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightCompatibility, classifyInstallError, INSTALL_FAILURE_CODES } from '../lib/installPreflight.js';
import { installBundle, writeFilesAtomic } from '../lib/installers.js';

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  OK  ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e?.message ?? e}`); console.error(`  NG  ${name}: ${e?.message ?? e}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  OK  ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e?.message ?? e}`); console.error(`  NG  ${name}: ${e?.message ?? e}`); }
}
const pkg = (obj) => [{ path: 'SKILL.md', data: Buffer.from('# demo') },
  { path: 'package.json', data: Buffer.from(JSON.stringify(obj)) }];

console.log('================================================');
console.log('  安装预检 / 失败分类 / 原子落盘 — 行为守卫');
console.log('================================================');

// ── A. preflightCompatibility（保守口径：unknown 一律放行）────
check('无文件 ⇒ unknown（不阻断）', () => {
  assert.equal(preflightCompatibility({ files: [], runtimeVersion: '0.2.2-rc.5' }).status, 'unknown');
});
check('包里没有 package.json ⇒ unknown（不阻断）', () => {
  const r = preflightCompatibility({ files: [{ path: 'SKILL.md', data: Buffer.from('x') }], runtimeVersion: '0.2.2-rc.5' });
  assert.equal(r.status, 'unknown');
});
check('有 package.json 但无引擎/peer 声明 ⇒ unknown（不阻断）', () => {
  assert.equal(preflightCompatibility({ files: pkg({ name: 'x' }), runtimeVersion: '0.2.2-rc.5' }).status, 'unknown');
});
check('读不到宿主版本 ⇒ unknown（不阻断）', () => {
  const r = preflightCompatibility({ files: pkg({ engines: { dsh: '>=9.0.0' } }), runtimeVersion: '' });
  assert.equal(r.status, 'unknown');
});
check('看不懂的 range ⇒ unknown（不阻断）', () => {
  const r = preflightCompatibility({ files: pkg({ engines: { dsh: 'not-a-range' } }), runtimeVersion: '0.2.2-rc.5' });
  assert.equal(r.status, 'unknown');
});
check('engines.dsh 满足 ⇒ ok', () => {
  const r = preflightCompatibility({ files: pkg({ engines: { dsh: '>=0.1.0 <0.3.0' } }), runtimeVersion: '0.2.2-rc.5' });
  assert.equal(r.status, 'ok');
});
check('engines.dsh 明确不满足 ⇒ incompatible + 分类码', () => {
  const r = preflightCompatibility({ files: pkg({ engines: { dsh: '>=9.0.0' } }), runtimeVersion: '0.2.2-rc.5' });
  assert.equal(r.status, 'incompatible');
  assert.equal(r.code, 'E_INCOMPATIBLE_DSH');
  assert.match(r.message, /当前宿主 dsh/);
});
check('engines.dsh 优先，忽略 dsh peer', () => {
  const r = preflightCompatibility({
    files: pkg({ engines: { dsh: '>=0.1.0' }, peerDependencies: { '@deepseek-ai/dsh': '>=9.0.0' } }),
    runtimeVersion: '0.2.2-rc.5',
  });
  assert.equal(r.status, 'ok');
});
check('无 engines 时检查 @deepseek-ai/dsh* peer', () => {
  const r = preflightCompatibility({
    files: pkg({ peerDependencies: { '@deepseek-ai/dsh-app-boot': '>=9.0.0' } }),
    runtimeVersion: '0.2.2-rc.5',
  });
  assert.equal(r.status, 'incompatible');
});
check('workspace:/file:/link: peer 视为当前 runtime，跳过', () => {
  const r = preflightCompatibility({
    files: pkg({ peerDependencies: { '@deepseek-ai/dsh': 'workspace:^' } }),
    runtimeVersion: '0.2.2-rc.5',
  });
  assert.equal(r.status, 'unknown');
});
check('包内 package.json 是坏 JSON ⇒ unknown（不因坏文件拒装）', () => {
  const r = preflightCompatibility({
    files: [{ path: 'package.json', data: Buffer.from('{broken') }], runtimeVersion: '0.2.2-rc.5',
  });
  assert.equal(r.status, 'unknown');
});

// ── B. classifyInstallError ──────────────────────────────────
check('分类码表覆盖上游 8 类 + 本项目扩展', () => {
  for (const c of ['E_INCOMPATIBLE_DSH', 'E_INTEGRITY', 'E_NOT_FOUND', 'E_NO_MATCHING_VERSION',
    'E_DISK_FULL', 'E_PERMISSION', 'E_NETWORK', 'E_BUILD_BLOCKED', 'E_PNPM_MISSING', 'E_UNKNOWN']) {
    assert.ok(INSTALL_FAILURE_CODES[c], `缺少 ${c}`);
  }
});
check('sha256 / 穿越 ⇒ E_INTEGRITY', () => {
  assert.equal(classifyInstallError(new Error('包的 sha256 对不上')).code, 'E_INTEGRITY');
  assert.equal(classifyInstallError(new Error('检测到路径穿越')).code, 'E_INTEGRITY');
});
check('ETARGET ⇒ E_NO_MATCHING_VERSION（不被 404 抢走）', () => {
  assert.equal(classifyInstallError(new Error('ERR_PNPM_NO_MATCHING_VERSION ETARGET')).code, 'E_NO_MATCHING_VERSION');
});
check('404 / ENOSPC / EACCES / timeout / allowBuilds 各自归类', () => {
  assert.equal(classifyInstallError(new Error('ERR_PNPM_FETCH_404')).code, 'E_NOT_FOUND');
  assert.equal(classifyInstallError(new Error('ENOSPC: no space')).code, 'E_DISK_FULL');
  assert.equal(classifyInstallError(new Error('EACCES permission denied')).code, 'E_PERMISSION');
  assert.equal(classifyInstallError(new Error('request timeout')).code, 'E_NETWORK');
  assert.equal(classifyInstallError(new Error('ERR_PNPM_IGNORED_BUILDS / allowBuilds')).code, 'E_BUILD_BLOCKED');
});
check('显式 E_ code 直通且保留原文', () => {
  const e = new Error('安装前兼容性检查未通过'); e.code = 'E_INCOMPATIBLE_DSH';
  const r = classifyInstallError(e);
  assert.equal(r.code, 'E_INCOMPATIBLE_DSH');
  assert.equal(r.message, '安装前兼容性检查未通过');
});
check('未知错误 ⇒ E_UNKNOWN', () => {
  assert.equal(classifyInstallError(new Error('某个没见过的错')).code, 'E_UNKNOWN');
});

// ── C. 真实落盘：无声明包不误拒 + 原子落盘 ────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-preflight-'));
const stagingLeft = (dir) => fs.readdirSync(dir).filter(n => n.startsWith('.staging-'));

await checkAsync('无声明包能正常安装（门禁不误拒）且无 staging 残留', async () => {
  const root = path.join(tmp, 'ok-root');
  await installBundle({
    dataRoot: root, kind: 'skill', storeId: 'plain-skill', version: '1.0.0',
    files: [{ path: 'SKILL.md', data: Buffer.from('# plain skill\n') }],
  });
  const dest = path.join(root, 'skills', 'plain-skill');
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), '# plain skill\n');
  assert.equal(stagingLeft(path.join(root, 'skills')).length, 0);
});

await checkAsync('writeFilesAtomic 中途失败 ⇒ 不留半成品 / 不清 staging', async () => {
  const root = path.join(tmp, 'atomic-root');
  fs.mkdirSync(root, { recursive: true });
  const targetDir = path.join(root, 'broken');
  await assert.rejects(() => writeFilesAtomic(targetDir, [
    { path: 'ok.txt', data: Buffer.from('ok') },
    { path: 'bad.txt', data: undefined },   // writeFile 会抛 ⇒ 模拟中途失败
  ]));
  assert.equal(fs.existsSync(targetDir), false, '目标目录不应出现');
  assert.equal(stagingLeft(root).length, 0, 'staging 必须被清理');
});

await checkAsync('upgrade 失败 ⇒ 旧目录原封不动（先删后写的老问题已消除）', async () => {
  const root = path.join(tmp, 'upgrade-root');
  const targetDir = path.join(root, 'existing');
  await writeFilesAtomic(targetDir, [{ path: 'old.txt', data: Buffer.from('OLD') }]);
  await assert.rejects(() => writeFilesAtomic(targetDir, [
    { path: 'new.txt', data: Buffer.from('NEW') },
    { path: 'bad.txt', data: undefined },
  ], { overwrite: true }));
  assert.equal(fs.readFileSync(path.join(targetDir, 'old.txt'), 'utf8'), 'OLD', '旧版必须保留');
  assert.equal(stagingLeft(root).length, 0);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
